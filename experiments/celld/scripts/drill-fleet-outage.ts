import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runReversibleFault } from '../operations/reversible-fault.ts'

if (!process.argv.includes('--execute')) {
  console.log('Plan only: gracefully stop BOTH owned east celld services with independent six-minute restart timers, verify CloudFront fails rather than selecting standby, then restore two-AZ health and acknowledged counter/workflow state. This is a fleet-process outage, NOT a full AWS-region outage or regional promotion. Explicit --execute required; no resource/data deletion.')
  process.exit(0)
}
const profile = process.env.AWS_PROFILE
if (!profile) throw new Error('Explicit AWS_PROFILE required')
const prefix = process.env.CELLD_STACK_PREFIX ?? 'tanstack-celld-test'
if (!/^tanstack-celld-[a-z0-9-]{1,24}$/.test(prefix)) throw new Error('Expected isolated prefix')
const work = resolve('.deploy/celld', prefix)
const identity = JSON.parse(readFileSync(resolve(work, 'identity.json'), 'utf8'))
const deployment = JSON.parse(readFileSync(resolve(work, 'deployment.json'), 'utf8'))
const ledger = JSON.parse(readFileSync(resolve(work, 'acknowledgement-ledger.json'), 'utf8'))
if (ledger.scope !== 'isolated-counter-and-workflow-lab' || !/^test-[A-Za-z0-9_-]{1,64}$/.test(ledger.id) || ledger.commands.length !== 3) throw new Error('Need acknowledged lab recovery oracle')
const base = new URL(deployment.SiteUrl)
if (base.protocol !== 'https:' || !/^[a-z0-9-]+\.cloudfront\.net$/.test(base.hostname)) throw new Error('Unexpected viewer origin')
function aws(region: string, service: string, args: string[]) {
  return JSON.parse(execFileSync('aws', ['--profile', profile!, '--region', region, '--endpoint-url', `https://${service === 'elbv2' ? 'elasticloadbalancing' : service}.${region}.amazonaws.com`, service, ...args, '--output', 'json'], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AWS_PAGER: '', AWS_MAX_ATTEMPTS: '1', AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true' },
  }) || '{}')
}
const caller = aws('us-east-1', 'sts', ['get-caller-identity'])
if (caller.Account !== identity.Account || /:root$/.test(caller.Arn)) throw new Error('Wrong deployed account')
const original = JSON.parse(readFileSync(resolve(work, 'us-east-1-regional-stack.json'), 'utf8'))
const stack = aws('us-east-1', 'cloudformation', ['describe-stacks', '--stack-name', original.StackId]).Stacks[0]
if (stack.StackId !== original.StackId || !['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(stack.StackStatus)) throw new Error('Source stack changed/busy')
const outputs = Object.fromEntries(stack.Outputs.map((value: any) => [value.OutputKey, value.OutputValue]))
function ownedFleet(preflight = false) {
  const group = aws('us-east-1', 'autoscaling', ['describe-auto-scaling-groups', '--auto-scaling-group-names', outputs.AutoScalingGroupName]).AutoScalingGroups[0]
  if (group.HealthCheckType !== 'EC2' || group.DesiredCapacity !== 2) throw new Error('Need isolated two-node EC2-health ASG; do not risk replacement storms')
  if (preflight && (group.Instances.length !== 2 || group.Instances.some((value: any) => value.LifecycleState !== 'InService'))) throw new Error('Fleet has extra/transitional instances')
  if (preflight) {
    const refreshes = aws('us-east-1', 'autoscaling', ['describe-instance-refreshes', '--auto-scaling-group-name', outputs.AutoScalingGroupName]).InstanceRefreshes
    if (refreshes.some((value: any) => ['Pending', 'InProgress', 'Cancelling', 'RollbackInProgress'].includes(value.Status))) throw new Error('Active instance refresh; no service stops')
  }
  const targets = aws('us-east-1', 'elbv2', ['describe-target-health', '--target-group-arn', outputs.TargetGroupArn]).TargetHealthDescriptions
  const healthy = new Set(targets.filter((value: any) => value.TargetHealth.State === 'healthy').map((value: any) => value.Target.Id))
  return group.Instances.filter((value: any) => value.LifecycleState === 'InService' && healthy.has(value.InstanceId))
}
const instances = ownedFleet(true)
if (instances.length !== 2 || new Set(instances.map((value: any) => value.AvailabilityZone)).size !== 2) throw new Error('Need exactly two healthy owned AZ-separated nodes')
const runId = randomUUID(), unit = `celld-fault-${runId}`
const evidence = resolve(work, 'fleet-outage', runId); mkdirSync(evidence, { recursive: true, mode: 0o700 })
const record: any = { runId, startedAt: new Date().toISOString(), scope: 'both-owned-east-celld-processes-stopped', regionOutageProven: false, regionalPromotionProven: false, instances, phases: [] }
const save = () => writeFileSync(resolve(evidence, 'result.json'), JSON.stringify(record), { mode: 0o600 })
save()
function send(instanceId: string, phase: string, commands: string[]) {
  const file = resolve(evidence, `${phase}-${instanceId}-parameters.json`)
  writeFileSync(file, JSON.stringify({ commands }), { mode: 0o600 })
  record.phases.push({ instanceId, phase, state: 'SUBMISSION_UNKNOWN', submittedAt: new Date().toISOString() }); save()
  const result = aws('us-east-1', 'ssm', ['send-command', '--document-name', 'AWS-RunShellScript', '--instance-ids', instanceId, '--parameters', `file://${file}`, '--timeout-seconds', '180', '--comment', `celld-fleet-fault-${runId}-${phase}`])
  const commandId = result.Command.CommandId
  record.phases.push({ instanceId, phase, commandId, submittedAt: new Date().toISOString() }); save()
  return { instanceId, commandId, phase }
}
async function wait(command: { instanceId: string; commandId: string; phase: string }) {
  const deadline = Date.now() + 210_000
  while (Date.now() < deadline) {
    let result: any
    try { result = aws('us-east-1', 'ssm', ['get-command-invocation', '--command-id', command.commandId, '--instance-id', command.instanceId]) }
    catch { await new Promise(resolve => setTimeout(resolve, 1000)); continue }
    if (['Success', 'Failed', 'Cancelled', 'TimedOut'].includes(result.Status)) {
      writeFileSync(resolve(evidence, `${command.phase}-${command.instanceId}-result.json`), JSON.stringify(result), { mode: 0o600 })
      if (result.Status !== 'Success') throw new Error(`Owned service ${command.phase} failed; private evidence saved`)
      return result
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error('SSM observation exceeded bound; scheduled recovery remains armed, command outcome is not assumed terminal')
}
async function viewer(path: string, method = 'GET') {
  const response = await fetch(new URL(path, base), { method, signal: AbortSignal.timeout(15_000) })
  const body = await response.text()
  return { path, method, status: response.status, body, observedAt: new Date().toISOString() }
}
const before = await viewer('/')
if (before.status !== 200 || !before.body.includes('TanStack Start server function executed')) throw new Error('Baseline viewer SSR unavailable; no fault injected')
const recovery = await runReversibleFault({
  async inject() {
    const results = await Promise.allSettled(instances.map((instance: any) => Promise.resolve().then(() => send(instance.InstanceId, 'stop', [
      'set -eu', 'systemctl is-active --quiet celld',
      `systemd-run --unit=${unit} --on-active=6m /bin/systemctl start celld`,
      `systemctl is-active --quiet ${unit}.timer`, 'systemctl stop celld',
      'test "$(systemctl show celld --property=ActiveState --value)" = inactive',
      'test "$(systemctl show celld --property=Result --value)" = success',
      'systemctl show celld --property=ActiveState --property=Result --property=ExecMainStatus',
    ])).then(wait)))
    if (results.some(result => result.status === 'rejected')) throw new Error('Source stop not confirmed for both nodes; restoration required')
    record.stoppedObservedAt = new Date().toISOString(); save()
  },
  async observe() {
    record.viewerDuringOutage = []
    for (let index = 0; index < 3; index++) {
      const result = await viewer('/')
      record.viewerDuringOutage.push(result); save()
      if (![502, 503, 504].includes(result.status)) throw new Error('Viewer did not fail closed during simultaneous source-process outage')
    }
    const stateful = await viewer(`/api/objects/Counter/${ledger.id}`, 'POST')
    record.statefulDuringOutage = stateful; save()
    if (stateful.status !== 503 || stateful.body !== 'Ownership unavailable; mutations are not replayed') throw new Error('Directory refusal not maintained')
    console.log('PASS: both source services stopped cleanly; viewer SSR fails and stateful ingress remains directory-refused. No standby selection or promotion.')
  },
  restorations: [0, 1].map(index => async () => {
    await wait(send(instances[index].InstanceId, 'restore', ['set -eu', 'systemctl start celld', 'systemctl is-active --quiet celld']))
    // Leave fallback timer armed. An unknown/delayed stop can still arrive;
    // an idempotent start six minutes later is safer than cancelling recovery.
  }) as [() => Promise<void>, () => Promise<void>],
  async verifyRecovery() {
    const deadline = Date.now() + 15 * 60_000
    while (Date.now() < deadline) {
      const current = ownedFleet()
      if (current.length === 2 && current.every((value: any) => instances.some((prior: any) => prior.InstanceId === value.InstanceId)) && new Set(current.map((value: any) => value.AvailabilityZone)).size === 2) {
        record.servicesRestoredAt = new Date().toISOString(); record.fallbackTimersRemainArmed = true; save(); return
      }
      await new Promise(resolve => setTimeout(resolve, 5000))
    }
    throw new Error('Two-AZ health not restored; fallback timers remain armed')
  },
})
record.faultError = recovery.faultError ? String(recovery.faultError) : undefined
record.restorationErrors = recovery.restorationErrors.map(String)
record.recoveryError = recovery.recoveryError ? String(recovery.recoveryError) : undefined
save()
if (recovery.faultError || recovery.restorationErrors.length || recovery.recoveryError) throw new Error('Drill incomplete; both restorations and recovery verification were attempted, fallback timers left armed. Inspect private evidence.')
const secret = readFileSync(resolve(work, 'origin-secret'), 'utf8').trim(), token = readFileSync(resolve(work, 'lab-token'), 'utf8').trim()
if (![secret, token].every(value => /^[a-f0-9]{64}$/.test(value))) throw new Error('Local lab credentials missing')
const python = `import json, urllib.request
base = 'http://127.0.0.1:8080'
headers = {'x-celld-origin-secret': ${JSON.stringify(secret)}, 'x-forwarded-host': ${JSON.stringify(base.hostname)}, 'authorization': 'Bearer ' + ${JSON.stringify(token)}}
id = ${JSON.stringify(ledger.id)}
def call(path, command=None):
    data = json.dumps(command).encode() if command else None
    request = urllib.request.Request(base+path, data=data, headers=headers)
    with urllib.request.urlopen(request, timeout=30) as response: return json.load(response)
path = '/api/objects/Counter/'+id
assert call(path) == {'sequence': 3, 'value': 5}
replay = call(path, {'operationId': ${JSON.stringify(ledger.commands[0].operationId)}, 'delta': 3})
assert replay['duplicate'] is True and replay['sequence'] == 1 and replay['value'] == 3
assert call(path) == {'sequence': 3, 'value': 5}
assert call('/api/workflows/Validation/'+id)['status'] in ('complete','completed')
print('Acknowledged counter, dedup and completed workflow recovered without new commands')`
await wait(send(instances[0].InstanceId, 'verify-state', ['set -eu', "python3 - <<'VERIFY_FLEET_RECOVERY'\n" + python + '\nVERIFY_FLEET_RECOVERY']))
const after = await viewer('/')
if (after.status !== 200 || !after.body.includes('TanStack Start server function executed')) throw new Error('Public SSR did not recover')
record.completedAt = new Date().toISOString(); record.recoveredViewer = after; record.acknowledgedStateRecovered = true; record.sameInstancesHealthyAcrossTwoAZs = true; save()
console.log('PASS: same two owned AZ-separated instances healthy again; public SSR, acknowledged SQLite/dedup and completed workflow recovered. Fleet-process drill only, not regional DR/RPO/RTO or native MRSC fencing.')
