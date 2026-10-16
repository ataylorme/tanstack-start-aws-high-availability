# TanStack Start on celld (regional recovery blocked)

This independent experiment hosts **TanStack Start itself** on celld and uses
celld's Cloudflare-compatible Workflows bindings. It does not replace the root
Lambda Web Adapter application. Runtime pin: **celld v0.6.2**.

Under the no-fork constraint, the current result is **no-go for automatic
writable regional failover**; isolated runtime compatibility and node-loss
validation have passed. See the [bounded assessment](ASSESSMENT.md) for the
supported-extension review, comparison and unproven requirements. The full goal
is blocked on supported native authorization/recovery facilities, not complete;
see [the current blocker and resume conditions](ASSESSMENT.md#current-completion-blocker).

See [REPORT.md](REPORT.md) for the consolidated findings, evidence limits,
benchmark/cost summaries and verified teardown disposition. The experiment
infrastructure has been removed; only AWS-enforced, no-additional-cost deleted-table
SYSTEM backups remain until their recorded expiry. Reprovision before AWS probes.

## Initial local compatibility probe

From the repository root, with its existing dependencies installed:

```sh
node experiments/celld/scripts/install.ts
node experiments/celld/scripts/configure-local.ts
npx vite build --config experiments/celld/vite.config.ts experiments/celld
# With verified celld v0.6.2 and esbuild on PATH:
PATH="$PWD/node_modules/.bin:$PATH" .omx/local/celld-bin/celld dev experiments/celld --no-watch --port 9877
# In another terminal:
node experiments/celld/scripts/verify-runtime.ts http://127.0.0.1:9877
node experiments/celld/scripts/verify-stateful.ts http://127.0.0.1:9877
node experiments/celld/scripts/verify-workflow-retry.ts http://127.0.0.1:9877
node experiments/celld/scripts/verify-restart.ts seed
# Stop and restart the same celld process, without --clean, then:
node experiments/celld/scripts/verify-restart.ts recover
```

The probe must prove actual SSR, asset loading, hydration, and GET/POST server
functions in celld, not just a Vite development server. Running the commands alone
is not proof of durability, safe promotion, or AWS availability; the evidence and
its boundaries are recorded below.

### Isolated unfinished-Workflow abrupt-crash drill

```sh
npm run build:celld
node experiments/celld/scripts/verify-workflow-crash.ts # Offline plan
node experiments/celld/scripts/verify-workflow-crash.ts --execute
```

This **local-only** drill copies the built application into a new ignored project,
creates a fresh owner-only token and owns its celld supervisor/native child on
loopback port 9878. It checks the official pinned release archive and decompressed
binary digest before execution. An occupied port fails; it never stops another
dev process. Existing lab state and the AWS recovery ledger are untouched.

The drill starts one native Workflow, observes unfinished `waiting` status and
its first acknowledged Counter effect, then authenticates an open WebSocket.
Immediately before SIGKILL it rechecks exact native child ownership. Restart is
forbidden until the supervisor is terminal **and** the killed native PID is absent.
Using the same isolated disk/store, it checks retained unfinished status, durable
operation-ID deduplication, fresh ticket/token socket authentication and snapshot
resynchronization. Approval must complete the original Workflow with exactly two
Counter effects; repeated status reads must not create effects. The actual drill
has passed. Owned restarted processes are stopped; evidence, logs and isolated
storage remain ignored for inspection.

`waiting` can represent native sleep or event wait; this does not identify an
exact journal phase. It is not a crash during retry, automatic browser reconnect,
remote peer/disk loss, generic Workflow import, regional failover/failback or an
external-effects exactly-once guarantee. It supplements, rather than replaces,
the graceful process-restart and terminated-EC2-node tests.


## Full acceptance/evidence checklist

- [x] Pinned Workers build serves Start SSR, hydration, assets and server functions.
- [x] Cookies, redirects, streaming, runtime APIs and bindings verified.
- [ ] SQLite Durable Object with transactionally stored operation IDs, sequences,
      mutation commands and WebSocket updates.
- [ ] Cloudflare-compatible workflow steps, retries, events, sleeps and restart recovery.
- [ ] Independent plain CloudFormation and deploy/verify/cleanup tooling: CloudFront,
      origin-request Lambda@Edge, ALBs, multi-AZ celld nodes, private operator/peer
      ingress, IAM, logs and alarms. Document EC2/EKS decision and disk recovery.
- [ ] MRSC us-east-1/us-west-2 replicas and us-east-2 witness, verified support,
      read-only edge role, designated ownership writers only.
- [ ] Canonical object keys, versioned fixed shards and directory entries;
      endpoint failover, bounded routing cache and fail-closed lookup behavior.
- [ ] Ownership policy covers HTTP, sockets, internal calls and background work.
- [ ] Conditional promotion, durable controller progress and crash recovery.
- [ ] Runtime fencing demonstrated for pauses, partitions, outstanding work,
      expired leases and a still-running former primary. Otherwise document the
      required runtime changes and keep automatic writable promotion disabled.
- [ ] Encrypted/versioned S3, CRR permissions/monitoring and complete recovery-point
      validation including LTX history, snapshots, manifests and deployment data.
- [ ] A-primary/B-standby recovery; epoch-isolated promoted histories and explicit
      failback/reseeding. No symmetric ownership with one-way replication alone.
- [ ] Measure both peer-to-S3 upload and CRR gaps; document missing acknowledged
      writes, lost deduplication history and external-side-effect reconciliation.
- [ ] Socket reauthentication, reconnect/backoff/jitter and sequence catch-up.
- [ ] Local Chrome E2E, deployed CloudFront E2E, process restart/node loss,
      regional outage, asymmetric partition and control-plane failure drills.
- [ ] Concurrent promotion, quorum loss, incomplete logs, replication backlog,
      duplicate commands and recovery tests.
- [ ] Failover/failback evidence: measured data loss, RPO/RTO, hydration time,
      socket recovery and old-primary isolation.
- [ ] Cached/uncached and normal/failure latency percentiles and operating costs.
- [ ] Architecture diagrams, prerequisites, limitations, cleanup and evidence-based
      go/no-go comparison with the baseline and Workflow reference experiment.

Raw deployment evidence and secrets stay in ignored local directories. Publish only
sanitized results; unchecked items are incomplete, not implicitly waived.

## Current evidence and remaining gates

Local runtime checks prove SSR, JS assets, GET/POST server functions, SQLite
commands, concurrent duplicate-operation deduplication, operation conflicts,
authenticated WebSocket snapshots, and workflow steps/sleep/event/internal calls.
A controlled process restart preserved the counter, deduplication records and a
waiting workflow; its committed first step was not repeated. Chrome verified
hydration, server POST, counter mutation/deduplication, socket snapshots and a
completed approval workflow. These are local single-node results, not AWS or
regional-disaster evidence.

The opt-in `retryFirstStep: true` start command exercises a native callback
retry after an acknowledged idempotent Counter effect. Attempt 1 throws; native
attempt 2 reuses its operation ID and returns `duplicate: true`. The local probe
checks the exact attempt and output, final two-command state and repeated status
reads. Approval is submitted early, but submission timing alone does not prove
that it arrived before the native event wait. This is not exactly-once external
effects, cancellation, restart-during-retry or regional recovery. The ordinary
Workflow path retains its existing four steps and output shape.

After publishing the updated runtime and allowing nodes to adopt the deployment:

```sh
AWS_PROFILE=<sandbox-profile> node experiments/celld/scripts/verify-aws.ts --execute --workflow-retry
```

The deployed run passed on both eastern nodes via authenticated private SSM
probes, including exact attempt-2 deduplication and final three-command state.
Two-node access does not mean both nodes independently executed the Workflow.
An independent before/after digest check confirmed the current recovery ledger
was unchanged. This is backend evidence, not an ACTIVE stateful CloudFront route.
The retry option refuses combination with `--node-loss`, writes only unique
run-scoped evidence and does not replace the current node-loss recovery ledger. The local
retry probe accepts only loopback URLs to avoid leaking its token to a remote
endpoint. The mode is additive application code using public Workflow APIs, not
a runtime patch or regional authorization hook.

Compound checklist items remain unchecked until their complete scope is verified;
partial evidence is recorded below. Automated HTTP tests do not substitute for
browser checks.

### Selected topology

AWS currently does not support MRSC in `us-west-1`. The directory template
requires an explicit western replica selection of `us-west-2` (no default).
Deployment refuses absent explicit `DIRECTORY_WEST_REGION` and `CELLD_WEST_REGION`.
The user has now selected us-west-2/us-east-1/us-east-2, superseding the original
issue topology: fleets and replicas use east/west2, witness uses east2. Existing
east-primary ownership remains stable until a proven transition; no MREC fallback.
See [AWS regional announcement](https://aws.amazon.com/about-aws/whats-new/2026/09/dynamodb-mrsc-additional-regions/).

### Current AWS tooling status

`node experiments/celld/scripts/deploy.ts` prints an offline plan. Execution
requires explicit topology approval, an isolated prefix, AWS_PROFILE and the
pinned local celld binary. All account-specific artifacts/secrets stay under
ignored `.deploy/celld/`. Both regional fleets, the MRSC directory and CloudFront
ingress are deployed. Public HTTPS probes pass SSR/assets/server functions,
cookies/redirects/bindings and incremental streaming. Missing and inert FENCING
directory entries reject GET/POST without selecting another owner or accepting
spoofed hints. This is safe refusal, not successful writable regional recovery.

The initial deployment tool does **not** initialize active ownership or enable
promotion. API routing fails closed without a valid directory item. Controller,
complete recovery and regional AWS drills remain implementation work; do not
mistake this infrastructure scaffold for the completed experiment.

### Fencing and transport limitations

celld v0.6.2 fences native node ownership using a shared bucket's conditional
ownership record and activation-epoch prefixes. Separate regional buckets are
separate native ownership domains. MRSC route hints or headers do not fence
already-running SQLite writes, workflows, alarms or external effects. The
`REGION_MODE` interlock prevents activating the standby lab, but is explicitly
**not** a distributed lease or storage fence. Automatic writable promotion stays
disabled. Current runtime does not yet enforce directory lease loss for background
work; the safe integration and its adversarial evidence remain outstanding.

Regional nodes use EC2 rather than EKS to avoid an unrelated cluster control plane
in this small experiment. Private-IP peer/operator listeners accept traffic only
from the fleet security group; worker ingress accepts only the ALB. Nodes have
public outbound addresses to avoid NAT gateways, but no public inbound node
access or SSH rule. ALB ingress requires both the CloudFront managed prefix list
and an origin secret. Viewer HTTPS is enforced; the initial CloudFront-to-ALB leg
is HTTP, **not end-to-end TLS**. Production suitability is not claimed.


### Eastern AWS validation

The independent eastern fleet has now been provisioned and verified: two healthy
celld nodes across two AZs, Start SSR/assets and POST server functions on both,
runtime bindings and secure-cookie response semantics, duplicate counter commands
across nodes, and a workflow started on one node and approved/completed on the other.
Detailed account/instance/command evidence remains under ignored `.deploy/celld/`.
These probes used authorized SSM backend access, **not** public CloudFront E2E.
The western disabled standby is also healthy across two AZs. MRSC and global
ingress stacks are deployed with us-east-1 primary, us-west-2 standby/replica,
and us-east-2 witness. A conditional inert FENCING initialization was confirmed
by strongly consistent reads at both replica endpoints. No ACTIVE ownership was
created. The full issue and regional recovery/fencing scope remain incomplete.

Socket authentication now uses a short-lived path-bound signed ticket before
allocating an actor/socket, then frame reauthentication with a five-second deadline
and a per-object connection cap. Tokens are not sent in URLs. Protocol tickets are
short-lived credentials and must not be logged/published. No ticket authorizes
regional ownership. The pause drill waits for an explicit handler-entered barrier
and uses fresh-run logs; it does not infer in-flight work from an arbitrary sleep.

The offline deployment plan supports `--east-only --execute` for the independent
prerequisite. Full deployment requires explicit topology settings matching the selected regions. Every
selected CloudFormation template is validated before resource creation, and every
fleet must become healthy across two AZs before downstream work. Use
`AWS_PROFILE=<sandbox-profile> node experiments/celld/scripts/verify-aws.ts --execute`
for the eastern backend probes after deployment.

The optional `--node-loss` protocol binds a resident counter to the source
instance's private address through the native owner/node-lease records before
submitting one isolated ASG termination without reducing desired capacity. It
then requires an explicit EC2 **terminated** observation before submitting any
surviving-node recovery probes. Termination submission, draining, missing API
results and timeouts are not that barrier. Uncertain submissions are never
replayed; the tool still observes automatic two-AZ replacement in its final path.
Native owner/epoch records, SSM submission phases and the barrier are saved in
unique private run directories. Success records identify this as protocol 2.

Earlier node-loss evidence did not establish that terminal-state ordering: a
survivor request could have forwarded to the still-shutting-down old owner.
Those original artifacts are retained with a private scope correction; they
must not prove post-death mutation execution. The corrected protocol has now
passed on AWS: the exact terminated-state barrier preceded the survivor SSM
submission, counter deduplication and Workflow completion passed afterward,
native ownership advanced to a different node/greater epoch, and the ASG restored
healthy two-AZ capacity. This remains
graceful instance termination, not abrupt power loss, full regional failure,
native regional fencing or measured RPO/RTO.

### Metadata operator (no writable promotion)

`scripts/ownership.ts inspect|initialize-fencing|begin-fencing --shard=N`
requires an explicit AWS profile and an ignored deployment manifest. Writes are
plan-only unless `--execute` is supplied; they also require `--transition=ID`.
Only one shard is touched. Initialization cannot overwrite an existing item;
revocation CAS-matches the observed epoch, regions, version, shard count and lease.
Expired ACTIVE metadata may be revoked, but cannot be renewed by the pure renewal
builder. Ambiguous submissions are reconciled by a fresh strong read, never by
blind write retries. Matching metadata does **not** prove a runtime fence; cached
routing, in-flight work, workflows and existing sockets may continue.

`scripts/verify-replication.ts` is also plan-first. With `--execute`, it measures
one inert source S3 write reaching the quarantine archive with identical bytes.
It does not establish celld acknowledgement RPO, pre-rule object backfill, a
complete recovery point or a valid epoch-aware import. Probe versions are retained
for local evidence; no serving state is modified or automatically restored.

Additional bounded probes:

- `scripts/verify-ingress.ts --execute`: deployed HTTPS/SSR and invalid,
  missing/FENCING ownership refusal; does not enable or verify ACTIVE routing.
- `scripts/verify-sockets.ts http://127.0.0.1:9877`: signed-ticket authentication
  deadlines, malformed/read-only/oversized frames, connection cap and recovery.
  Socket deadlines use durable alarms. Pinned celld requires application close
  codes (4001/4009/4013), not reserved 1008/1009/1013.
- `scripts/inventory-recovery.ts --execute`: read-only non-atomic source/archive
  version inventory; no import, serving state changes or copied lease authority.
- `scripts/benchmark.ts [--aws]`: small warm sequential SSR samples, not equal
  workloads or production sizing. See [cost and measurement boundaries](COSTS.md).

The privacy gate checks prospective public files for literal account/access-key/
instance IDs, issued CloudFront/ALB hosts and lab/origin secrets. It supplements,
not replaces, review of other identifiers and resource-specific information.

### Dedicated metadata operator role

```sh
node experiments/celld/scripts/deploy-writer.ts # Offline plan
# Replace placeholders. Creates an isolated IAM-role stack, not a native fence:
AWS_PROFILE=<sandbox-profile> node experiments/celld/scripts/deploy-writer.ts --shard=<selected-shard> --execute
AWS_PROFILE=<sandbox-profile> node experiments/celld/scripts/verify-writer.ts --execute
```

The writer deployer binds the account and both recorded MRSC replica IDs, trusts
only the current exact non-root IAM principal and records a new immutable stack
identity. Principal/account/role values remain private; the trust parameter is
NoEcho. Existing trust or shard changes require explicit migration review rather
than silent reassignment. This optional companion stack does not modify fleet or
edge roles. The selected role permits table discovery at two exact replica ARNs
and item Get/Put/Update for **one explicitly selected canonical shard**. Missing
leading-key context and enclosing transaction contexts cannot match its Allow;
there are no Scan/Delete/Batch/PartiQL or IAM-management grants.

Run the verifier before mutation flows. It checks the live trust and inline/
attached policies, exercises allowed/denied IAM simulations and actually assumes
a 900-second role session for strong reads at both replicas. Out-of-scope keys
must return AccessDenied, not merely absent data or a timeout. The deployed role
passed these checks. A single inert FENCING initialization also passed through
the role and was read back from the other replica; no ACTIVE item was created.
IAM simulations alone do not establish every SCP/resource-policy interaction.

`ownership.ts` inspection/planning remains read-only through the explicit caller
profile. Mutation `--execute` flows now **require** the recorded writer stack and
matching shard. Before assuming the role, they verify its live exact trust,
role name/duration, absence of unexpected boundary/attached policies, complete
inline-policy inventory and full one-shard permission document. Missing or
truncated IAM results and unexpected policy fields fail closed before role
assumption or a write. They then exchange the broad profile for temporary role
credentials, verify the assumed identity, and perform table checks, mutation and
reconciliation using that role. These role credentials are held only in process
memory/child environments, not saved to evidence or a CLI role-profile cache.
There is no fallback to the broad profile on role or IAM-read failure. The
mandatory policy checks are point-in-time observations, not atomic protection
against concurrent administrator changes, same-ARN role replacement or grants
from table resource policies. Rerun the broader live verifier before use and
review administrator changes; its simulations/actual denied reads supplement
but do not turn this preflight into a native fence.

**Limits:** IAM restricts keys and actions, not arbitrary status values or the
presence of a CAS expression. The CLI permits only inert initialization/revocation;
raw use of the role can still replace/update its permitted item differently.
Neither this role, its FENCING status, nor the directory operator establishes a
celld execution/storage barrier. Do not grant it to celld/edge or enable writable
promotion. Infrastructure provisioning retains its documented table-scoped
CloudFormation-role exception; account administrators are not made powerless by
this role. [DynamoDB conditions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/specifying-conditions.html),
[transaction contexts](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html).

### Quarantine archives and offline recovery probes

`archive-recovery.ts --execute` backfills a bounded version-pinned object set into
`backfill/<snapshot-uuid>/` in the **separate quarantine archive**, not the standby
serving bucket. Every copied object and the frozen manifest are byte-verified.
Interrupted attempts may use `--resume=<snapshot-uuid>`: fresh reads reconcile
ambiguous writes and conditional creates prevent overwriting existing objects.
Completed archives are verified, not blindly replayed. The source listing remains
non-atomic; this is not a complete native recovery point or promotion permission.

With Rust/Cargo, Git and SQLite CLI installed:

```sh
rustup toolchain install 1.94.1 --profile minimal --no-self-update
node experiments/celld/scripts/build-ltx-verifier.ts
node experiments/celld/scripts/verify-bootstrap.ts
node experiments/celld/scripts/verify-ltx.ts <snapshot-uuid>
# With a prior positive verification of that snapshot:
node experiments/celld/scripts/verify-cross-epoch.ts <snapshot-uuid> <positive-verification-uuid>
# Validate the completed approval lab in a fresh positive reconstruction:
node experiments/celld/scripts/verify-workflow-journal.ts <snapshot-uuid> <positive-verification-uuid>
# For an intentionally older archive missing the newer lab ledger:
node experiments/celld/scripts/verify-ltx.ts <older-snapshot-uuid> --expect-missing-acknowledgements
```

The decoder uses the approved celld source/library and upstream dependency lock;
no application framework dependency is added. It validates full LTX bytes,
reconstructs SQLite images **offline** from snapshots and bundled recovery logs
through the pinned epoch-chain restore library, and compares the lab counter
against the external acknowledgement ledger created by `verify-aws.ts`. It does
not import native ownership/epochs or start a destination actor.

The build also compiles the pinned native decision core using Rust 1.94.1,
without changing the default toolchain. `verify-bootstrap.ts` checks attested
binary/source/lock hashes and executes five deterministic offline assertions:
absent ownership proposes epoch 1/fresh restore; a released epoch 7 advances to
8/non-fresh restore with exact-version CAS; rejected CAS emits no immediate restore;
epoch exhaustion rejects acquisition; independent absence observations each
propose epoch 1. The slice explicitly disables node leases and performs no real
CAS, actor execution or AWS calls. It proves bootstrap decision behavior, **not**
simultaneous commits, regional fencing or supported import. It does not write a
synthetic owner record to a serving bucket. Raw evidence remains ignored.

The cross-epoch probe re-extracts three laboratory LTX payloads from committed,
SHA/size-checked original bundles and places copies into **synthetic offline**
epoch layouts. The actual pinned planner reports its chosen spans. Three layouts
restore the exact historical acknowledgement ledger (continued epochs, skipped
incomplete intermediate epoch, clipped older-epoch tail); two incomplete chains
reject with `transaction not available`; a missing newest epoch restores but
fails acknowledgement comparison. The ledger belongs to the selected historical
verification, not the latest application state. These fixtures do not establish
deployed multi-epoch history, retirement/folded-log provenance, unsent peer tails,
regional hydration, writable import or fencing. No serving history is modified.

`verify-workflow-journal.ts` checks an unchanged, SHA-256-bound reconstructed
SQLite image against its positive verification and external lab ledger. For the
completed approval laboratory it decodes tested V8 wire-15 values, verifies all
four completed journal steps and the consumed approval event, compares the two
step outputs and final output to exact acknowledged counter commands, and checks
that the retention alarm and native wake row agree with metadata expiry. The
pinned native library derives the exact wake publication key, whose archived
version must be present and byte-verified in the committed manifest. The deployed
post-node-loss archive passed this additional read-only check. This is not
general V8 host-object compatibility, Workflow replay/resume, import, evidence
that the captured wake is latest, or a complete regional recovery point. No
Workflow is activated and no metadata or secret parameters are exported.

`verify-archive-chain.ts <snapshot-uuid> [--omit-ltx|--corrupt-ltx]` runs a read-only
native GC inventory fixture. Its successful exit is **not** restore validation:
missing chains and payload corruption can be silently ignored by that CLI. See
[the concrete native integration gates](NATIVE-GAPS.md) before interpreting any
archive as safe regional recovery evidence.

### Latest bounded validation

Chrome computer-control checks passed on the deployed HTTPS application for
hydration, POST server functions, cookies, redirects and runtime bindings.
Counter requests with unavailable ownership returned 503 and retained the operation
ID; socket connection attempts exhausted their bounded authentication/reconnect
budget. These are **fail-closed browser checks**, not an ACTIVE stateful route.

Local Chrome checks using signed socket tickets passed mutation deduplication,
approval-event Workflow completion and disconnect/reconnect with a full sequence-3
snapshot. The Workflow's two durable steps produced values 2 and 3 after the
initial counter mutation; repeating the original operation ID did not increment it.
Screenshots and deployment-specific observations remain in ignored local evidence.

`scripts/drill-fleet-outage.ts` is plan-only by default. Its authorized `--execute`
run stopped both owned eastern celld services after arming independent six-minute
restart timers. Public SSR failed without selecting standby; stateful ingress
continued refusing unavailable ownership. Both original nodes recovered across
two AZs, with acknowledged counter/deduplication history and the completed
Workflow verified. This is a **graceful two-process outage**, not a whole-region
outage, partition, stale-primary fence, promotion, or measured regional RPO/RTO.

After the corrected terminated-instance-barrier drill, a fresh version-pinned
quarantine archive was committed and byte-verified. Offline reconstruction
validated 19 full LTX payloads, rejected 19 corrupted copies and restored 12
SQLite images with integrity checks. The recovered counter's three operation
records exactly matched the external acknowledgement ledger. Its real newer
epoch held a self-contained snapshot; native TXIDs need not equal application
sequence numbers. This does not demonstrate a deployed multi-epoch continuation,
complete fleet checkpoint, unsent peer-log coverage, regional import or RPO/RTO.
Synthetic missing-chain fixtures are separately reported, not silently counted
when a real redundant/newer snapshot makes them inapplicable.

Archive inventory keeps service pagination enabled and filters JSON output to
current version IDs and latest delete markers, rather than returning every
historical lease version to the parent process. The listing is still non-atomic;
it does not bound all AWS CLI internal memory. Interrupted conditional copies
require fresh read reconciliation before resumption; a closed upload response
is UNKNOWN, never assumed success or automatically replayed.

### One acknowledged command through source and native CRR

```sh
node experiments/celld/scripts/measure-replication.ts # Plan only; no AWS calls
AWS_PROFILE=<sandbox-profile> node experiments/celld/scripts/measure-replication.ts --execute
```

This bounded probe submits **one new isolated Counter mutation** through an owned
eastern node after verifying the profile, immutable stack identities, healthy
two-AZ fleet and distinct quarantine destination. Setup confirms an empty new
counter and captures its native identity/owner/process-generation log scope.
The mutation's successful response becomes an independent run-local oracle; the
current node-loss recovery ledger is not replaced and its digest is rechecked.
There is no blind retry after an ambiguous SSM submission or mutation outcome.

The observer pins candidate native LTX/bundle versions, checks full payloads with
the attested native helper, and reconstructs an offline image containing exactly
the acknowledged command and operation-ID row. It then downloads those **same
native CRR versions** from quarantine, requires destination `REPLICA` and matching
whole-body SHA-256/length, independently reconstructs the image and exact row, and
requires source-version `COMPLETED`. It performs no manual copy/backfill or actor
activation. Successful execution proved the marker through both paths; it did
not merely observe an object name, timestamp or metadata hash.

The controller brackets remote acknowledgement between submission and observed
SSM completion, then records native validation completion on the **same local
monotonic clock**. Reported presence bounds include SSM/polling/network/download/
checksum/restore/query overhead. They are conservative single-command
observations, not exact peer-upload or CRR latency, missing-write lower bounds,
a maximum RPO, a complete/folded-log-authoritative checkpoint, or safe import.
Nominal source/archive sampling budgets are three/five minutes, with 100
candidate objects, 32 MiB per object and 64 MiB total source downloads; blocking
API/decode calls can extend elapsed wall time. Timeout, changed owner/generation,
missing chains or budget exhaustion mean **not proved**, not data loss.

Frozen reconstructed images are inspected using URI-escaped `mode=ro&immutable=1`
SQLite connections, with digest preservation and exact-row checks. This handles
a persisted WAL-mode header without creating sidecars. It must never be applied
to a live main file or used to omit its committed WAL. An empty native restore
plan is not a usable image. Initial instrumentation failures remain in private
evidence; their acknowledged mutations were not replayed and retrospective image
checks are not counted as completed timing runs. [SQLite immutable parameters](https://www.sqlite.org/uri.html#uriimmutable),
[read-only WAL databases](https://www.sqlite.org/wal.html#readonly),
[S3 replication version preservation](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication.html#replication-scenario).

### Read-only observability validation

```sh
node experiments/celld/scripts/verify-observability.ts # Offline plan, no AWS calls
AWS_PROFILE=<sandbox-profile> node experiments/celld/scripts/verify-observability.ts --execute
```

The probe verifies the caller account and both immutable regional stack IDs,
selects the current healthy two-AZ fleet in each region, and reads actual recent
log events and per-instance CPU series for all four nodes. It compares eight
stack-owned alarms with the expected metric, exact dimensions, statistic,
period, threshold, evaluation and missing-data settings, then reads the matching
metric series. Actual log events, not eventually consistent stream timestamps,
provide freshness evidence. Reads use explicit service endpoints/timeouts; log
queries have a fixed time window and bounded backward pagination. Missing data
and exhausted pagination are gaps, never zero or healthy telemetry.

The deployed read-only run passed required freshness/configuration checks. The
archive-backlog alarm was **ALARM**, retained as an explicit warning despite
healthy fleets; S3 failure/backlog samples are observational and do not establish
a complete recovery point, continuous delivery or an RPO. There are no configured
notification actions. This probe injects no logs, fires no alarms and does not
prove notification delivery or regional recovery. Raw events and resource
identities remain in ignored evidence, not public documentation.

### Cleanup and continuing costs

```sh
node experiments/celld/scripts/cleanup.ts # Offline explanation; no AWS calls
AWS_PROFILE=<sandbox-profile> node experiments/celld/scripts/cleanup.ts --plan
```

The live read-only plan was validated against six identity-bound stack records, including the writer role.
After publication, the user authorized full teardown. All six stacks and their
separately retained active resources have now been removed and verified; see
[the final disposition and SYSTEM-backup exception](REPORT.md#resource-disposition-and-publication).
The commands below describe the tooling for a future deployment, not resources
that are still running.
Destructive execution requires separate explicit user authorization, plus
`--execute --confirm-delete=<experiment-prefix> --ack-retained-costs`.
It removes owned ingress/compute/stack records in dependency order, **not** all
resources: versioned buckets, MRSC storage, retained edge function versions/role,
logs and earlier retained replacement artifacts can persist and incur charges.
The private inventory is not an exhaustive account-wide orphan inventory.
Retained named resources can also prevent recreating stacks with the same prefix.
No S3 version purge, table-protection change or edge-replica deletion is automated.
