# Regional-outage simulation

This is an isolated-lab chaos experiment, **not an actual AWS regional outage**.
It uses the existing app/worker deployment without rebuilding production code.

## Results — 2026-10-01

**Passed in both directions on the existing AWS lab using profile `ataylorme`.**

| Isolated region | Healthy region | Observed read failover | Result |
| --- | --- | --- | --- |
| us-east-1 | us-west-2 | GET 340 ms; HEAD 408 ms; OPTIONS 308 ms | Combined fault and failback passed |
| us-west-2 | us-east-1 | GET 281 ms; HEAD 1,854 ms; OPTIONS 347 ms | Combined fault and failback passed |

These are individual request durations with the origin already unavailable, not
outage-detection RTO or production latency guarantees.

Both runs observed injected DynamoDB `InternalServerError`, failed-region POST
429, successful same-ID retry, two committed timer resolutions, signal/approval
completion, a real future schedule tick, and all four ordered transport receipts.
Independent final inspection verified outage-write revisions in both replicas,
terminal workflow histories, disabled schedules without pending buckets, completed
subscriber cursors without outstanding claims, unchanged receipts after replay,
restored mappings/concurrency, and empty processing queues/DLQs. Temporary FIS
roles, alarms and templates were removed; experiments are stopped. No FIS-injected
table resource policies remain. No upstream package issue was identified.

An initial attempt exposed unsupported cross-region stop-alarm use: the FIS action
was cancelled before storage impairment. Service controls were restored and the
harness was corrected before both successful runs.

Local validation: **220 tests in 24 suites**, app/edge/worker builds, TypeScript,
healthy/failure smoke checks and CloudFormation lint passed. Private evidence is
in `.deploy/regional-outage/` and `.deploy/rc1/regional-outage-final-audit.json`.

## Fault model

Run one region at a time, then reverse:

1. Disable all four regional mappings: DynamoDB router, workflow wakeup worker,
   application-event FIFO relay, and ordered-event subscriber. Drain in-flight
   invocations for 65 seconds. Scheduler can still enqueue regional backlog.
2. Set the regional application's reserved concurrency to zero. Require an actual
   HTTP 429 from its Function URL. This tests an unavailable origin and CloudFront
   failover, **not TCP blackholing or origin timeout latency**.
3. Use AWS FIS `aws:dynamodb:global-table-pause-replication` against the exact
   regional MRSC replica. Leave the other replica and Ohio witness untouched.
   Require real strong-read server errors in the isolated region, not merely an
   experiment marked running. Fault duration is bounded to 15 minutes.
4. While all three faults coexist, require healthy-region writes and strong reads,
   read-method failover, explicit same-ID write retry, timer/signal/approval
   completion, real ordered SNS/SQS transport receipts, and an actual future
   schedule tick. Do not invoke the subscriber directly to manufacture receipts.
5. Stop FIS, restore original app concurrency and mappings, verify replicated
   acknowledged data and retained receipts, run a new workflow after failback,
   and check queue drainage and DLQs.

CloudFront intentionally retries only GET/HEAD/OPTIONS. A failed-region POST must
fail visibly; the caller retries the same operation ID against the healthy region.
This experiment does not change that safety contract.

## Guardrails and restoration

- Explicit isolated prefix, AWS profile, account ID, region, site and token file.
- MRSC topology and originally enabled mappings checked before disruption.
- Private atomic manifest records original configuration before mutations.
- An independent local watchdog validates its manifest and AWS account, acknowledges
  startup, and restores at a 25-minute deadline. Leader stops work before that
  deadline. The watchdog survives the initiating process, but not loss of the
  operator machine; FIS's native duration remains the storage-fault backstop.
- External healthy-region HTTP and real DynamoDB write/read probes publish a
  high-resolution heartbeat. FIS's stop alarm treats missing data as breaching.
  The alarm must reside in the **experiment region**: a cross-region alarm ARN was
  accepted at template creation but rejected when the first experiment started.
- IAM permissions are scoped to the lab table where supported. AWS requires
  wildcard resource authorization for `dynamodb:InjectError`; only the exact
  replica ARN is selected as an experiment target.
- Restoration is independent and retried. Ambiguous FIS starts must be reconciled
  and stopped before the manifest is marked fully restored or safeguards removed.
- Raw manifests, logs, AWS identifiers and restoration details remain in ignored
  `.deploy/regional-outage/`. Do not commit them or tokens.

## Commands

Plan only (no AWS calls):

```sh
node scripts/verify-regional-outage.ts
```

Run with `AWS_PROFILE`, `STACK_PREFIX`, `EXPECTED_AWS_ACCOUNT_ID`, `SITE_URL`, and
`WORKFLOW_TEST_TOKEN_FILE` set:

```sh
node scripts/verify-regional-outage.ts us-east-1 --execute
# Verify restoration and final lab health before reversing:
node scripts/verify-regional-outage.ts us-west-2 --execute
```

Emergency restoration, using the exact private manifest from the run:

```sh
node scripts/regional-outage-restore.ts --restore .deploy/regional-outage/<run>.json
```

The emergency helper restores service controls and stops known FIS experiments;
inspect the manifest for any remaining temporary FIS role/template/alarm cleanup.
Never delete the FIS role while its experiment is active.

## Claim boundaries

These faults model regional application/worker unavailability and regional MRSC
isolation. They do not reproduce loss of AWS control planes, regional DNS, the
operator machine, global CloudFront, the witness, or arbitrary correlated service
failures. Ordered receipts prove durable idempotent lab effects, not arbitrary
external exactly-once effects. Measurements describe this bounded test, not a
production RTO/RPO SLA or load qualification.

Official references: [MRSC resilience testing](https://aws.amazon.com/blogs/database/best-practices-for-amazon-dynamodb-global-tables-part-3-validating-regional-resilience-with-aws-fault-injection-service/),
[FIS DynamoDB action](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html#dynamodb-actions),
[FIS stop conditions](https://docs.aws.amazon.com/fis/latest/userguide/stop-conditions.html).
