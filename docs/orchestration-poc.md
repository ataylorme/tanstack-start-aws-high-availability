# DevOps orchestration POC runbook

## What this demonstrates

A cohesive TypeScript/TanStack Start control plane owns **request → plan → approval → scheduled or immediate execution → verification → completion event**. The real operation changes the reserved concurrency of a dedicated sandbox Lambda to an integer from **1–5**. This is capacity configuration, not instance-count scaling or provisioned concurrency.

The branch `codex/devops-orchestration-poc` originates from `test/tanstack-workflow-aws`, base commit `57f463157fa7e22dee10cb3009fc1abea5056b76`. Workflow dependency `@ataylorme/tanstack-workflow-aws` remains pinned at `0.2.0-rc.1`.

This POC is **single-region**, deployed in `us-east-1`. Its ordinary regional DynamoDB table has no replicas. Single-region suitability is an architectural inference being exercised by this implementation and tests—not a claim of upstream certification, MRSC behavior, multi-region recovery, HA, or production readiness. The original HA lab remains separate and unchanged by POC deployment.

Not implemented: real Slack/GitHub/Jira adapters, SSO, arbitrary AWS targets, build execution, DNS changes, packaged CLI, recurring schedules, automatic approval expiry, post-approval cancellation, automatic rollback, or automatic release of uncertain-operation locks.

## Architecture and boundaries

One immutable container image runs six independently permissioned Lambda roles:

| `APP_ROLE` | Responsibility | Exposure/authority |
| --- | --- | --- |
| `http` | Dashboard and task APIs | Only Function URL; workflow-store access, no Lambda mutations or operation-table access |
| `router` | Workflow stream → queue or one-time schedule; application event routing | Private stream consumer |
| `worker` | Resume durable workflows and drain committed effects | Private SQS consumer; reads target concurrency and invokes executor |
| `executor` | Revalidate approval, apply/verify capacity, persist operation receipt | Private invocation; can change only sandbox concurrency; reserved concurrency 1 |
| `relay` | Application queue → SNS | Private FIFO SQS consumer |
| `sandbox` | Harmless function whose concurrency is changed | Private; no resource-changing permissions |

All roles use `APP_MODE=orchestration`. Startup configuration—not caller headers—selects the role. Background invocations pass through Lambda Web Adapter at `/internal/events`; the HTTP role rejects that route. Only the dashboard shell, assets, and minimal health checks are public. Task reads and mutations require bearer credentials. Lab API routes are disabled in POC mode.

Resources use the fixed prefix `devops-orchestration-poc`: two independent CloudFormation stacks, ECR repository, workflow and operation tables, SQS queues/DLQs, Scheduler group, SNS FIFO topic, observation FIFO queue, IAM roles, logs, and alarms. There are no HA-stack imports. Cloud workers are demand-driven; the local harness polls only for development.

### Durable state and execution guarantees

- The workflow store owns run history, immutable plans, and the atomic accepted approval inbox. HTTP handlers admit work; they do not execute it inline. There is no separate approval-record write to reconcile.
- Creation requires an idempotency key. Same key and equivalent normalized request return the original task; changed input conflicts. This is not an unlimited retention guarantee: configured workflow terminal retention is seven days and tombstone retention thirty days.
- The plan hash binds task, target, observed and requested capacity, execution time, and workflow version. Decision endpoints require its hash and pending approval ID; actors come from credentials.
- Approval and requested time must both be satisfied. A supplied time must initially be within the next 24 hours. **Late approval executes as soon as workers can resume it. There is no automatic approval expiry or second-level timing guarantee.**
- Executor reloads the approved plan before changing AWS. Fresh infrastructure drift blocks the task; create and approve a new task rather than changing the old plan.
- Executor stores an operation receipt and target lock transactionally before the AWS effect. The lock has no TTL. Repeated completed execution returns the receipt; an interrupted execution reconciles observed before/after capacity before retrying.
- `devops.task.succeeded.v1` is a committed workflow outbox effect. Transport failure does not repeat the AWS effect. Delivery remains duplicate-tolerant—not globally exactly-once. Events contain stable task/operation/event identifiers, schema version, target, before/after, and completion time; no approval credentials.
- SNS routes to a separate observation queue. Subscriber delivery is not required to mark the task succeeded. Production consumers should retain their own event-ID deduplication records.

Task views expose `queued`, `planning`, `awaiting_approval`, `scheduled`, `executing`, `succeeded`, `rejected`, `blocked`, and `failed`, with a current reason and workflow timeline. These describe business progress; consult transport metrics separately for publication or wakeup failures.

## Local development and tests

Requirements: supported Node version from `package.json`, Docker with Compose, and registry access for `npm ci` (private package token through `NODE_AUTH_TOKEN`). Never commit tokens or put them in Docker build arguments.

```sh
npm ci
node scripts/orchestration-local.ts
```

Open `http://127.0.0.1:3000`. The harness starts persistent DynamoDB Local on loopback port 8000, initializes isolated tables, starts Vite, and runs a background workflow/effect driver. Local demo credentials (not valid in AWS):

- Requester: `local-requester-development-only-00000001`
- Approver: `local-approver-development-only-000000002`

Enter the desired role's token in the dashboard. Browser tokens live only in memory; reload clears them. The CLI creates no AWS resources and uses dummy credentials against the guarded local endpoint. `--init-only` starts storage without the app; `--worker-only` runs against already-started local storage without Vite.

Stop/restart the harness to demonstrate a pending approval or scheduled task surviving a process restart. Docker data persists. Use **one local worker per table pair** because production serialization is provided by Lambda reserved concurrency. The local adapter runs the same receipt/lock executor with a simulated capacity value; it does not test AWS IAM, Lambda invocation timing, SNS, Scheduler, or real stream transport. Restart the harness after workflow-code changes.

```sh
npm run check
npm run smoke
npx vitest run tests/orchestration-*.test.ts
python3 -m venv .venv
.venv/bin/pip install cfn-lint==1.57.0
.venv/bin/cfn-lint infra/orchestration-bootstrap.yaml infra/orchestration-poc.yaml
```

Run the persistent-store suites explicitly (ordinary `npm test` skips them when this variable is absent):

```sh
node scripts/orchestration-local.ts --init-only
DYNAMODB_LOCAL_ENDPOINT=http://127.0.0.1:8000 npm run check
```

CI starts DynamoDB Local and runs these suites without AWS credentials. Unit tests use Vitest, `aws-sdk-client-mock` for AWS command contracts, and `nock` for HTTP boundaries. Local recovery tests supplement mocks; neither replaces live AWS validation.

To stop storage without deleting its volume:

```sh
docker compose -f compose.orchestration.yaml down
```

Do not add `--volumes` unless intentionally discarding all local workflow history.

## Isolated AWS deployment

The sole allowed deployment identity is profile `ataylorme`, account `963564733329`, region `us-east-1`. Reserved sandbox concurrency consumes account capacity. The deployer checks available unreserved concurrency and requires at least 106 before proceeding.

```sh
# Offline inspection; makes no AWS calls.
node scripts/deploy-orchestration.ts

export AWS_PROFILE=ataylorme
export EXPECTED_AWS_ACCOUNT_ID=963564733329
export AWS_REGION=us-east-1
node scripts/deploy-orchestration.ts --execute
```

Execution verifies STS identity, runs `npm run check` and `npm run smoke`, checks stack ownership, creates/reviews change sets, rejects removals and replacements on updates, and deploys the ECR bootstrap before the application stack. The Docker build uses BuildKit secret injection and `buildx --provenance=false --sbom=false --load` for a Lambda-compatible amd64 image. `NODE_AUTH_TOKEN` or `gh auth token` supplies private package access. The same ECR digest must be observed on all six Lambda roles after deployment.

`.deploy/devops-orchestration-poc/` is ignored by Git, mode 0700, with evidence/credentials files mode 0600. The deployer prints the URL and credentials-file path, **not token values**. Losing the credentials file while the stack exists causes deployment to stop rather than silently rotate credentials. Retain it in an approved secret store for a longer-lived deployment; this POC does not provide managed rotation.

`RequesterToken` and `ApproverToken` are NoEcho CloudFormation parameters and Lambda environment values. AWS principals with sufficient infrastructure access can obtain them; this is demo authorization, not enterprise identity/security isolation. There is no WAF, per-person identity, or fine-grained tenant authorization. Treat the public URL as an internet-exposed demo and monitor usage/cost.

### Curl exercise without exposing bearer tokens in history or process arguments

Use `jq`, do not enable shell tracing, and do not use `curl -v`/`--trace`. Header config is piped directly to curl instead of putting tokens in arguments:

```sh
set +x
umask 077
EVIDENCE=.deploy/devops-orchestration-poc
URL=$(jq -r '.[] | select(.OutputKey=="Url") | .OutputValue' "$EVIDENCE/devops-orchestration-poc-outputs.json")
URL=${URL%/}
requester() { jq -r '"header = \"Authorization: Bearer \(.requester)\""' "$EVIDENCE/credentials.json" | curl --fail-with-body --silent --show-error --config - "$@"; }
approver() { jq -r '"header = \"Authorization: Bearer \(.approver)\""' "$EVIDENCE/credentials.json" | curl --fail-with-body --silent --show-error --config - "$@"; }

# Choose a fresh non-secret key for each intended new task.
KEY="demo-$(date +%s)"
requester -H 'Content-Type: application/json' -H "Idempotency-Key: $KEY" \
  --data '{"desiredConcurrency":2}' "$URL/api/tasks" > "$EVIDENCE/task.json"
TASK=$(jq -r .id "$EVIDENCE/task.json")
requester "$URL/api/tasks/$TASK" > "$EVIDENCE/task.json"
jq '{id,status,reason,plan,approvalId}' "$EVIDENCE/task.json"
```

Repeat the final GET until `status` is `awaiting_approval`, then:

```sh
jq '{approvalId, planHash: .plan.hash, approved: true}' "$EVIDENCE/task.json" > "$EVIDENCE/decision.json"
approver -H 'Content-Type: application/json' --data-binary "@$EVIDENCE/decision.json" "$URL/api/tasks/$TASK/decision"
requester "$URL/api/tasks/$TASK"
aws lambda get-function-concurrency --function-name devops-orchestration-poc-sandbox
```

Use `approved: false` to exercise rejection, with no mutation. Reusing the same creation key/body returns the same task; a conflicting body returns HTTP 409. Repeating an identical accepted decision is idempotent; conflicting decisions return 409. The requester cannot approve and the approver cannot create tasks.

For a one-time schedule, submit `{"desiredConcurrency":3,"executeAt":"<future ISO-8601 time with timezone>"}` using a new key and approve its exact plan. Verify no execution before that time, then eventual execution. To demonstrate drift, change sandbox capacity through an authorized operator between planning and approval; expect the approved stale plan to block rather than overwrite the unexpected value. Restore the sandbox deliberately afterward, not by altering its plan record.

### Observe independent events

```sh
QUEUE=$(jq -r '.[] | select(.OutputKey=="ObservationQueue") | .OutputValue' "$EVIDENCE/devops-orchestration-poc-outputs.json")
aws sqs receive-message --queue-url "$QUEUE" --wait-time-seconds 10 --max-number-of-messages 10 \
  --visibility-timeout 30 > "$EVIDENCE/observed-events.json"
jq '.Messages[]? | .Body | fromjson' "$EVIDENCE/observed-events.json"
```

Match the successful task/event IDs, not just any queue message. Receiving temporarily hides messages; this command does not acknowledge/delete them. Only delete receipt handles you have inspected and intentionally consumed. Save sanitized acceptance evidence, never bearer credentials.

## Recovery, diagnostics, and safe operations

Logs use `/aws/lambda/devops-orchestration-poc-<role>` with 14-day retention. CloudWatch alarms cover Lambda errors, queue age, and DLQ backlog; no alert destination is configured. Operators must review alarms themselves. Query task status first, then the worker/executor logs and relevant queue/stream metrics. Correlate by task/operation/event ID.

For controlled recovery exercises, disable the isolated worker or relay event-source mapping, admit/approve or finish a task, then re-enable the mapping. Record original mapping states before changing them and always restore them. Do not delete a queue or purge messages to simulate an outage. Verify eventual progress/event delivery without creating another business request, and verify the sandbox effect was not repeated. Invocation shutdown after an external effect is primarily covered by fault-injection tests; a real crash exercise needs explicit, bounded test instrumentation.

DynamoDB stream records expire; the stream failure queue contains failure metadata, not an unlimited copy of all source history. Investigate promptly. Queue retention is fourteen days. This POC has no automatic transport DLQ redrive or unattended full reconciliation runbook; prolonged outages beyond retention are outside its guarantees.

An uncertain execution deliberately holds `TARGET#<sandbox>/LOCK` in the operation table. **Do not automatically delete this lock or force a new task through it.** A qualified operator must first inspect the approved immutable plan, `OP#<task>/RECEIPT`, actual Lambda capacity, and AWS audit evidence. Determine whether the external effect happened, whether another writer intervened, and whether the recorded before/after values still explain the target. Retrying an applying operation can reconcile it; a blocked uncertain receipt needs an explicit, audited repair decision. This POC exposes no blanket unlock endpoint or safe automatic repair tool.

### Workflow evolution

Current runs use workflow ID `capacity-change-v1`, version `v1`. Image replacement must retain the implementation for outstanding versions; do not relabel old plans/history as new versions. Before adding `v2`, register both implementations, exercise a paused `v1` run across the image update, then approve/resume it. The current POC does not yet ship a distinct production `v2`; the real-DynamoDB compatibility test covers version routing, while the separately recorded live image-update test covers resuming the unchanged v1 definition across a deployment.

## Cleanup and remaining costs

```sh
# Offline plan.
node scripts/cleanup-orchestration.ts
# AWS read-only inventory with the same three identity environment variables.
node scripts/cleanup-orchestration.ts --inventory
# Destructive, isolated stack deletion—only when intentionally finished:
node scripts/cleanup-orchestration.ts --execute --confirm=devops-orchestration-poc
```

The cleanup command verifies account and stack ownership, removes the POC's one-time schedules, then deletes only its application and bootstrap stacks. **Tables, ECR images/repository, and log groups are retained.** They may continue incurring charges; DynamoDB PITR remains relevant. Review/export retained data and perform a separately authorized retention cleanup if desired. The command does not purge retained data or touch HA-lab resources. Retained fixed-name resources also prevent a simple fresh stack recreation until deliberately imported or removed.

## Acceptance evidence

**Passed on 2026-10-02**, live run `2026-10-02T17:08:40.168Z` through `2026-10-02T17:16:34.958Z`.

- Dashboard: <https://4dvoi3w3qvfd2vb6kkibxzyxty0qzhcl.lambda-url.us-east-1.on.aws/>
- Stacks: `devops-orchestration-poc-bootstrap` and `devops-orchestration-poc`, account `963564733329`, region `us-east-1`. Application stack verified `UPDATE_COMPLETE`; both worker and relay mappings restored to `Enabled`. HA-lab stacks were not modified.
- All six Lambda roles were verified against shared image digest `sha256:a7ed58fb4e0fd2f02e8359657220a39173cdd2cb2eccf4849dbf1b936cb36f49`. Source is the implementation on `codex/devops-orchestration-poc`, based on the commit above; this acceptance run preceded its implementation commit.
- **306 tests across 32 files passed**, including real DynamoDB Local persistence/recovery suites. Build, typecheck, smoke checks, CloudFormation lint, and whitespace checks passed.
- Live role boundaries, duplicate admission/approval, conflicting payload/decision rejection, immediate execution, rejection without mutation, and scheduled execution passed. Scheduled completion `2026-10-02T17:10:27.893Z` was after requested time `2026-10-02T17:10:26.483Z`.
- Worker outage: task `task-6672fcc7388a24f16d895f8936de328c9d2a733fa18e1679eb68d4e73ca89df9` stayed queued while paused and completed after restoration without a replacement request. The verifier waits 150 seconds after disabling a mapping; shorter waits proved unreliable due to residual processing.
- Independent delivery recovery: task `task-edda84ac5f7055582c1a9caba373555516ea864aefc2e4ede45534718e8780fa` succeeded while the relay was paused. After restoration, the observation queue received event `success-task-edda84ac5f7055582c1a9caba373555516ea864aefc2e4ede45534718e8780fa`. The sandbox was independently read back at reserved concurrency **5**.
- A paused unchanged `v1` workflow survived a live image replacement with its original plan hash, then completed. Distinct `v1`/`v2` version routing is covered locally, not claimed as a live migration test.
- Direct live adapter tests verified SQS partial-batch responses and whole-invocation failure propagation.

Private evidence (not committed): `.deploy/devops-orchestration-poc/acceptance.json` includes task, operation and event IDs, timelines, receipts and image URI; `rolling-before.json`, `rolling-after.json`, and `adapter-validation.json` record the separate compatibility/adapter checks. Earlier unsuccessful verifier attempts are retained as `acceptance-attempt-*.json`; they are not counted as passing runs. Credentials are in `credentials.json` in the same private directory and are not included in evidence.

**Remaining gaps:** interactive browser QA was unavailable (HTTP/SSR checks were performed); crash-mid-effect recovery is covered by fault-injection tests rather than a live process-kill drill. Shared demo tokens are not enterprise identity. This does not establish production readiness, multi-region resilience, or exactly-once external effects. The AWS POC is intentionally left deployed and incurs ongoing charges. Local DynamoDB was stopped with its persistent volume retained.

### Deployment transport and reuse

If Docker cannot upload through the local proxy, set `ECR_UPLOAD_MODE=api` on the same
account-guarded deploy command. This reuses the repository's digest-verified ECR API
uploader; it does not bypass IAM or change stack isolation. Infrastructure-only
updates can set `POC_IMAGE_URI` to an existing immutable digest **in the POC's own
ECR repository**. Omit it when application code changes.

Run automated, opt-in live acceptance with:

```sh
AWS_PROFILE=ataylorme EXPECTED_AWS_ACCOUNT_ID=963564733329 AWS_REGION=us-east-1 \
  npm run verify:poc -- --execute
```

This requires an owned, stable stack and initially enabled worker/relay mappings.
It briefly pauses and restores only those mappings (including a 150-second settling interval for residual processing), creates test tasks, changes the
sandbox capacity within 1–5, and consumes its dedicated observation queue. Evidence
is written to `.deploy/devops-orchestration-poc/acceptance.json` without credentials.
It leaves the sandbox at capacity 5 and does not tear down the deployment.
