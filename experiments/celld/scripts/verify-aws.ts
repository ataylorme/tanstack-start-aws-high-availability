import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { instanceTerminationObserved, verifyNativeEpochAdvance } from '../recovery/epoch-transition.ts'

const nodeLoss = process.argv.includes('--node-loss')
const workflowRetry = process.argv.includes('--workflow-retry')
if (nodeLoss && workflowRetry) throw new Error('Run retry and destructive node-loss probes separately')
if (!process.argv.includes('--execute')) {
  console.log('Plan: verify the isolated eastern stack identity, two-AZ targets, then run Start/SQLite/Workflow cross-node probes via SSM. This is backend validation, not CloudFront E2E or regional recovery. Add --execute after deployment. Optional --workflow-retry validates native callback retries and writes only run-scoped evidence, preserving the current recovery ledger. Optional --node-loss terminates one observed object-owner instance in this isolated ASG and requires replacement/recovery.')
  process.exit(0)
}
if (!process.env.AWS_PROFILE) throw new Error('Explicit AWS_PROFILE required')
const prefix = process.env.CELLD_STACK_PREFIX ?? 'tanstack-celld-test'
if (!/^tanstack-celld-[a-z0-9-]{1,24}$/.test(prefix)) throw new Error('Isolated prefix required')
const region = 'us-east-1'
const work = resolve('.deploy/celld', prefix)
mkdirSync(work, { recursive: true, mode: 0o700 }); chmodSync(work, 0o700)
const runId = crypto.randomUUID()
const evidence = resolve(work, 'validation-runs', runId)
mkdirSync(evidence, { recursive: true, mode: 0o700 })
const aws = (args: string[]) => {
  const service = args[0]
  const endpointService = service === 'elbv2' ? 'elasticloadbalancing' : service === 's3api' ? 's3' : service
  return JSON.parse(execFileSync('aws', ['--profile', process.env.AWS_PROFILE!, '--region', region,
    '--endpoint-url', `https://${endpointService}.${region}.amazonaws.com`, ...args, '--output', 'json'], {
    encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, AWS_PAGER: '', AWS_MAX_ATTEMPTS: '1', AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true' },
    maxBuffer: 16 * 1024 * 1024,
  }).trim() || '{}')
}
const identity = aws(['sts', 'get-caller-identity'])
const prior = JSON.parse(readFileSync(resolve(work, 'identity.json'), 'utf8'))
if (identity.Account !== prior.Account || /:root$/.test(identity.Arn)) throw new Error('Unexpected profile identity; no commands sent')
const expectedStack = JSON.parse(readFileSync(resolve(work, 'us-east-1-regional-stack.json'), 'utf8'))
const stack = aws(['cloudformation', 'describe-stacks', '--stack-name', expectedStack.StackId]).Stacks[0]
if (stack.StackId !== expectedStack.StackId || stack.StackName !== `${prefix}-regional`) throw new Error('Stack differs from recorded deployment; no commands sent')
if (!['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(stack.StackStatus)) throw new Error('Regional stack is not ready')
const output = Object.fromEntries(stack.Outputs.map((entry: any) => [entry.OutputKey, entry.OutputValue]))
const group = aws(['autoscaling', 'describe-auto-scaling-groups', '--auto-scaling-group-names', output.AutoScalingGroupName]).AutoScalingGroups[0]
const targets = aws(['elbv2', 'describe-target-health', '--target-group-arn', output.TargetGroupArn]).TargetHealthDescriptions
const healthy = new Set(targets.filter((target: any) => target.TargetHealth.State === 'healthy').map((target: any) => target.Target.Id))
const instances = group.Instances.filter((instance: any) => healthy.has(instance.InstanceId) && instance.LifecycleState === 'InService')
if (instances.length < 2 || new Set(instances.map((instance: any) => instance.AvailabilityZone)).size < 2) throw new Error('Need two healthy owned instances across AZs')
const secret = readFileSync(resolve(work, 'origin-secret'), 'utf8').trim()
const token = readFileSync(resolve(work, 'lab-token'), 'utf8').trim()
if (![secret, token].every(value => /^[a-f0-9]{64}$/.test(value))) throw new Error('Restore valid local secrets')
const id = `test-aws-${crypto.randomUUID()}`
const op = crypto.randomUUID()
const commands: any[] = []
let faultSubmissionStarted = false
let terminationBarrierPassed = false
let nativeCell: string | undefined
let nativeOwnerBefore: unknown
function readNativeOwner(phase: string) {
  if (!nativeCell) throw new Error('Need observed native cell identity')
  const file=resolve(evidence,`native-owner-${phase}.json`)
  const metadata=aws(['s3api','get-object','--bucket',output.BucketName,'--key',`fleet/cells/${nativeCell}/own.json`,'--expected-bucket-owner',identity.Account,file])
  chmodSync(file,0o600)
  writeFileSync(resolve(evidence,`native-owner-${phase}-object.json`),JSON.stringify(metadata),{mode:0o600})
  return JSON.parse(readFileSync(file,'utf8'))
}
if (nodeLoss) {
  if (group.Instances.length!==2 || instances.length!==2 || group.DesiredCapacity!==2 || group.HealthCheckType!=='EC2') throw new Error('Need exact healthy two-node isolated ASG for loss drill')
  const refreshes=aws(['autoscaling','describe-instance-refreshes','--auto-scaling-group-name',output.AutoScalingGroupName]).InstanceRefreshes
  if (refreshes.some((value: any)=>['Pending','InProgress','Cancelling','RollbackInProgress'].includes(value.Status))) throw new Error('Busy ASG; no termination')
}
try {
for (const [index, instance] of instances.slice(0, 2).entries()) {
  const python = `import json, re, time, urllib.request, urllib.error
base = 'http://127.0.0.1:8080'
headers = {'x-celld-origin-secret': ${JSON.stringify(secret)}, 'x-forwarded-host': 'backend-validation.cloudfront.net', 'authorization': 'Bearer ' + ${JSON.stringify(token)}}
id = ${JSON.stringify(id)}
op = ${JSON.stringify(op)}
def call(path, payload=None, extra=None):
    h = dict(headers)
    if extra: h.update(extra)
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(base + path, data=data, headers=h, method='POST' if data else 'GET')
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status, r.headers, r.read().decode()
def read(path): return json.loads(call(path)[2])
status, h, html = call('/')
assert status == 200 and 'TanStack Start server function executed' in html
assets = re.findall(r'href="(/assets/[^" ]+\\.js)"', html)
assert len(assets) >= 2
route = ''
for asset in set(assets):
    code = call(asset)[2]
    if 'Test POST server function' in code: route = code
ids = set(re.findall(r'[a-f0-9]{64}', route))
assert len(ids) == 1
req = urllib.request.Request(base + '/_serverFn/' + next(iter(ids)), data=b'', headers={**headers, 'origin': 'https://backend-validation.cloudfront.net', 'x-tsr-serverFn': 'true'}, method='POST')
with urllib.request.urlopen(req, timeout=30) as r: assert r.status == 200 and 'POST server function executed' in r.read().decode()
assert all(read('/compat/apis')['bindings'].values())
status, h, value = call('/compat/cookie')
assert 'HttpOnly' in h['Set-Cookie'] and 'Secure' in h['Set-Cookie']
assert json.loads(call('/compat/cookie/inspect', extra={'cookie': 'celld-lab=probe'})[2])['present'] is True
counter = '/api/objects/Counter/' + id
workflow = '/api/workflows/Validation/' + id
${index === 1 && nodeLoss ? `end = time.time() + 90
while time.time() < end:
    try:
        snapshot = read(counter)
        assert snapshot == {'sequence': 2, 'value': 4}
        break
    except urllib.error.HTTPError as e:
        if e.code not in (502, 503, 504): raise
    except (TimeoutError, urllib.error.URLError): pass
    time.sleep(0.5)
else: raise AssertionError('Counter did not recover after owner loss')` : ''}
command = json.loads(call(counter, {'operationId': op, 'delta': 3})[2])
assert command['value'] == 3 and command['duplicate'] == ${index === 0 ? 'False' : 'True'}
${index === 0 ? `${workflowRetry ? "try:\n    call(workflow, {'action': 'start', 'retryFirstStep': 'true'})\n    raise AssertionError('Invalid retry option accepted')\nexcept urllib.error.HTTPError as error:\n    assert error.code == 400\n" : ''}assert call(workflow, {'action': 'start'${workflowRetry ? ", 'retryFirstStep': True" : ''}})[0] == 201
end = time.time() + 30
while time.time() < end:
    if read(counter)['value'] == 4: break
    time.sleep(0.2)
assert read(counter)['value'] == 4` : `assert call(workflow, {'action': 'approve', 'approved': True})[0] == 200
end = time.time() + 60
while time.time() < end:
    result = read(workflow)
    if result['status'] in ('complete', 'completed', 'errored'): break
    time.sleep(0.3)
assert result['status'] in ('complete', 'completed') and result['output']['approved'] is True
${workflowRetry ? "assert result['output']['started']['attempt'] == 2 and result['output']['started']['duplicate'] is True\nassert result['output']['started']['sequence'] == 2 and result['output']['started']['value'] == 4\nassert result['output']['started']['operationId'] == id + '-started'" : ''}
assert read(counter) == {'sequence': 3, 'value': 5}`}
${index === 0 && nodeLoss ? `object_id = json.loads(call(counter, extra={'x-lab-probe-object': 'identity'})[2])['nativeObjectId']
metadata = 'http://169.254.169.254/latest/'
request = urllib.request.Request(metadata + 'api/token', data=b'', headers={'X-aws-ec2-metadata-token-ttl-seconds': '60'}, method='PUT')
with urllib.request.urlopen(request, timeout=3) as r: metadata_token = r.read().decode()
request = urllib.request.Request(metadata + 'meta-data/local-ipv4', headers={'X-aws-ec2-metadata-token': metadata_token})
with urllib.request.urlopen(request, timeout=3) as r: private_ip = r.read().decode()
with urllib.request.urlopen('http://' + private_ip + ':8081/state', timeout=5) as r: native = json.load(r)
assert any(scope.endswith(':' + object_id) for scope in native['residents']), 'Must observe the counter resident on the instance before terminating it'` : ''}
${index === 0 && nodeLoss ? `print(json.dumps({'nativeObjectId': object_id, 'privateIp': private_ip}))` : ''}
print(json.dumps({'nodeProbe': ${index + 1}, 'startSSR': True, 'postServerFunction': True, 'assets': True, 'runtimeBindings': True, 'counter': True, 'workflowCrossNode': True}))
`
  const parameterFile = resolve(evidence, `ssm-node-${index + 1}-parameters.json`)
  writeFileSync(parameterFile, JSON.stringify({ commands: ['set -eu', "python3 - <<'CELLD_VERIFY'\n" + python + '\nCELLD_VERIFY'] }), { mode: 0o600 })
  if (nodeLoss && index === 1 && !terminationBarrierPassed) throw new Error('Survivor probes require the terminated-instance barrier')
  const submittedAt = new Date().toISOString()
  const response = aws(['ssm', 'send-command', '--document-name', 'AWS-RunShellScript', '--instance-ids', instance.InstanceId, '--parameters', `file://${parameterFile}`, '--timeout-seconds', '180'])
  const commandId = response.Command.CommandId
  commands.push({ commandId, instanceId: instance.InstanceId, submittedAt, requestedAt: response.Command.RequestedDateTime, phase: index === 0 ? 'seed-and-owner-proof' : 'survivor-probes' })
  writeFileSync(resolve(evidence, 'ssm-validation-commands.json'), JSON.stringify(commands), { mode: 0o600 })
  const deadline = Date.now() + 5 * 60_000
  let invocation: any
  while (Date.now() < deadline) {
    try { invocation = aws(['ssm', 'get-command-invocation', '--command-id', commandId, '--instance-id', instance.InstanceId]) } catch { await new Promise(resolve => setTimeout(resolve, 1000)); continue }
    if (['Success', 'Failed', 'Cancelled', 'TimedOut'].includes(invocation.Status)) break
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  writeFileSync(resolve(evidence, `ssm-node-${index + 1}-result.json`), JSON.stringify(invocation), { mode: 0o600 })
  if (invocation?.Status !== 'Success') throw new Error(`Node ${index + 1} probe failed; details retained in ignored local result file`)
  console.log(`PASS: node ${index + 1} Start SSR/assets/server function, bindings and cross-node stateful probe.`)
  if (index === 0 && nodeLoss) {
    // Exactly the owned, observed object-owner instance. Keep desired capacity
    // unchanged so ASG replaces it; do not delete any bucket or durable history.
    const observed=invocation.StandardOutputContent.trim().split('\n').map((line: string)=> {try{return JSON.parse(line)}catch{return null}}).find((value: any)=>value?.nativeObjectId)
    if (!observed || !/^[a-f0-9]{64}$/.test(observed.nativeObjectId)) throw new Error('Need exact native identity from resident-owner probe')
    nativeCell=`Counter:${observed.nativeObjectId}`
    nativeOwnerBefore=readNativeOwner('before')
    const owner=nativeOwnerBefore as {node?:unknown;epoch?:unknown}
    if (typeof owner.node!=='string' || !owner.node || !Number.isSafeInteger(owner.epoch) || (owner.epoch as number)<1) throw new Error('Invalid pre-loss native owner')
    const leaseFile=resolve(evidence,'pre-loss-node-lease.json')
    aws(['s3api','get-object','--bucket',output.BucketName,'--key',`fleet/nodes/${owner.node}.json`,'--expected-bucket-owner',identity.Account,leaseFile])
    chmodSync(leaseFile,0o600)
    const lease=JSON.parse(readFileSync(leaseFile,'utf8'))
    const address=new URL(lease.addr.includes('://')?lease.addr:`http://${lease.addr}`)
    if (!Number.isSafeInteger(lease.expires_ms) || lease.expires_ms<=Date.now() || lease.node!==owner.node || address.hostname!==observed.privateIp || address.port!=='8081') throw new Error('Native owner lease does not identify the observed instance; no termination')
    const freshGroup=aws(['autoscaling','describe-auto-scaling-groups','--auto-scaling-group-names',output.AutoScalingGroupName]).AutoScalingGroups[0]
    if (freshGroup.DesiredCapacity!==2 || freshGroup.Instances.length!==2 || !freshGroup.Instances.some((value:any)=>value.InstanceId===instance.InstanceId && value.LifecycleState==='InService')) throw new Error('ASG changed before fault; no termination')
    const freshTargets=aws(['elbv2','describe-target-health','--target-group-arn',output.TargetGroupArn]).TargetHealthDescriptions
    const freshHealthy=new Set(freshTargets.filter((value:any)=>value.TargetHealth.State==='healthy').map((value:any)=>value.Target.Id))
    if (freshGroup.HealthCheckType!=='EC2' || freshGroup.Instances.some((value:any)=>value.LifecycleState!=='InService' || !freshHealthy.has(value.InstanceId)) || new Set(freshGroup.Instances.map((value:any)=>value.AvailabilityZone)).size!==2) throw new Error('Two-AZ healthy fleet changed; no termination')
    const freshRefreshes=aws(['autoscaling','describe-instance-refreshes','--auto-scaling-group-name',output.AutoScalingGroupName]).InstanceRefreshes
    if (freshRefreshes.some((value:any)=>['Pending','InProgress','Cancelling','RollbackInProgress'].includes(value.Status))) throw new Error('ASG refresh started; no termination')
    writeFileSync(resolve(evidence,'node-loss-intent.json'),JSON.stringify({observedAt:new Date().toISOString(),instanceId:instance.InstanceId,nativeCell,state:'SUBMISSION_UNKNOWN'}),{mode:0o600})
    faultSubmissionStarted=true
    const activity = aws(['autoscaling', 'terminate-instance-in-auto-scaling-group', '--instance-id', instance.InstanceId, '--no-should-decrement-desired-capacity'])
    writeFileSync(resolve(evidence, 'node-loss-activity.json'), JSON.stringify({ observedAt: new Date().toISOString(), terminatedInstance: instance.InstanceId, activity }), { mode: 0o600 })
    const terminationDeadline=Date.now()+5*60_000
    let terminated=false
    while (Date.now()<terminationDeadline) {
      try {
        const observation=aws(['ec2','describe-instances','--instance-ids',instance.InstanceId])
        if (instanceTerminationObserved(observation,instance.InstanceId)) {
          writeFileSync(resolve(evidence,'termination-barrier.json'),JSON.stringify({observedAt:new Date().toISOString(),instanceId:instance.InstanceId,observation,scope:'EC2 terminated state observed BEFORE survivor probes; submission/draining are insufficient'}),{mode:0o600})
          terminationBarrierPassed=true
          terminated=true;break
        }
      } catch (error) {
        writeFileSync(resolve(evidence,'termination-observation-error.json'),JSON.stringify({observedAt:new Date().toISOString(),error:String(error)}),{mode:0o600})
      }
      await new Promise(resolve=>setTimeout(resolve,2000))
    }
    if (!terminated) throw new Error('Old owner termination not proven; do not begin survivor recovery probes')
    console.log('PASS: exact old-owner EC2 instance observed TERMINATED; only now beginning surviving-node counter/workflow recovery probes.')
  }
}
} catch (error) {
  writeFileSync(resolve(evidence,'validation-failure.json'),JSON.stringify({observedAt:new Date().toISOString(),error:String(error),faultSubmissionStarted}),{mode:0o600})
  throw error
} finally {
  // UNKNOWN submission is still a possible fault. Observe automatic recovery
  // even if transport/probe/epoch checks fail. Never resubmit termination.
  if (faultSubmissionStarted) {
  const deadline = Date.now() + 15 * 60_000
  let replaced = false
  while (Date.now() < deadline) {
    try {
    const current = aws(['autoscaling', 'describe-auto-scaling-groups', '--auto-scaling-group-names', output.AutoScalingGroupName]).AutoScalingGroups[0]
    const health = aws(['elbv2', 'describe-target-health', '--target-group-arn', output.TargetGroupArn]).TargetHealthDescriptions
    const ready = new Set(health.filter((target: any) => target.TargetHealth.State === 'healthy').map((target: any) => target.Target.Id))
    const live = current.Instances.filter((instance: any) => ready.has(instance.InstanceId) && instance.LifecycleState === 'InService')
    if (live.length >= 2 && new Set(live.map((instance: any) => instance.AvailabilityZone)).size >= 2 && !live.some((instance: any) => instance.InstanceId === instances[0].InstanceId)) {
      replaced = true
      writeFileSync(resolve(evidence, 'node-loss-replacement.json'), JSON.stringify({ observedAt: new Date().toISOString(), instances: live }), { mode: 0o600 })
      break
    }
    } catch (error) {writeFileSync(resolve(evidence,'replacement-observation-error.json'),JSON.stringify({observedAt:new Date().toISOString(),error:String(error)}),{mode:0o600})}
    await new Promise(resolve => setTimeout(resolve, 10_000))
  }
  if (!replaced) throw new Error('Healthy two-AZ replacement was not proven; inspect private fault and observation evidence')
  console.log('PASS: ASG restored healthy two-AZ capacity and the fault-target instance is absent. This recovery observation alone does not prove acknowledged-history retention.')
  }
}
if (nodeLoss) {
  const transition=verifyNativeEpochAdvance(nativeOwnerBefore,readNativeOwner('after'))
  writeFileSync(resolve(evidence,'native-epoch-transition.json'),JSON.stringify({observedAt:new Date().toISOString(),nativeCell,...transition}),{mode:0o600})
  console.log('PASS: same native cell moved to a different node with strictly greater native epoch. Single-bucket takeover, not regional fencing.')
}
// Independent retry runs must not replace the node-loss recovery oracle.
const validationWork = workflowRetry ? evidence : work
writeFileSync(resolve(validationWork, 'backend-validation.json'), JSON.stringify({ observedAt: new Date().toISOString(), runId, scope: 'east-fleet-backend-via-SSM', workflowRetryPassed: workflowRetry, healthyNodesAcrossAZs: true, probes: 2, nodeLossDrillPassed: nodeLoss, nodeLossProtocolVersion: nodeLoss ? 2 : null, oldOwnerTerminationBeforeSurvivorProbesProven: nodeLoss && terminationBarrierPassed, publicCloudFrontE2EProven: false, regionalFencingProven: false }), { mode: 0o600 })
// Explicit external lab oracle for subsequent offline replica verification.
writeFileSync(resolve(validationWork, 'acknowledgement-ledger.json'), JSON.stringify({ observedAt: new Date().toISOString(), runId, scope: 'isolated-counter-and-workflow-lab', id, commands: [
  { sequence: 1, operationId: op, delta: 3, value: 3 },
  { sequence: 2, operationId: `${id}-started`, delta: 1, value: 4 },
  { sequence: 3, operationId: `${id}-finished`, delta: 1, value: 5 },
], completedCrossNodeProbes: commands, nodeLossDrillPassed: nodeLoss, nodeLossProtocolVersion: nodeLoss ? 2 : null, oldOwnerTerminationBeforeSurvivorProbesProven: nodeLoss && terminationBarrierPassed }), { mode: 0o600 })
console.log('PASS: eastern celld fleet backend validation. This probe does not establish an ACTIVE CloudFront stateful route, browser behavior or regional recovery.')

if (!workflowRetry) for (const file of ['backend-validation.json', 'acknowledgement-ledger.json']) writeFileSync(resolve(evidence, file), readFileSync(resolve(work, file)), { mode: 0o600 })
if (workflowRetry) console.log('PASS: native Workflow attempt 2 deduplicated its acknowledged Counter effect. Run-scoped evidence only; current recovery ledger unchanged. No regional fencing/recovery proof.')
