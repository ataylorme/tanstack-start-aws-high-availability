# Workflow AWS historical validation evidence

> Historical AWS evidence: both deployments and their artifacts were subsequently torn down.
> The branch now installs the published GitHub Packages prerelease `@ataylorme/tanstack-workflow-aws@0.2.0-rc.0`.
> The AWS results below concern the earlier Git-pinned dependency and legacy recurring
> sweeps, not the current published-package or demand-driven wakeup deployment.
> For the current architecture, migration and validation, use [workflow wakeups](workflow-wakeups.md).

Validated on **2026-09-26** against upstream
[`f026a1080b9d7d2e0d25b2735a9c0ce0945c4e2c`](https://github.com/ataylorme/tanstack-workflow-aws/tree/f026a1080b9d7d2e0d25b2735a9c0ce0945c4e2c).

## Deployment

- Branch: `test/tanstack-workflow-aws`.
- Former lab URL and AWS account ID are omitted from public evidence.
- All nine CloudFormation stacks reached `CREATE_COMPLETE`; CloudFront deployed.
- DynamoDB MRSC: `ACTIVE`, `STRONG`, replicas in Northern Virginia/Oregon and an active Ohio witness.
- Deployed release labels, image/code digests, and resource identifiers are omitted from public evidence.
- Both native Node.js 22 sweepers used recurring rules in this historical deployment.

```mermaid
flowchart LR
  Test[HTTP acceptance runner] --> CF[Isolated CloudFront distribution]
  CF --> East[Virginia application]
  CF --> West[Oregon application]
  East <--> DB[(MRSC workflow table)]
  West <--> DB
  ES[Virginia scheduled sweeper] <--> DB
  WS[Oregon scheduled sweeper] <--> DB
  DB --- Witness[Ohio witness]
```

## Verification

- `npm run check`: production application/edge/sweeper builds, strict TypeScript checks, **77 Vitest tests passed**.
- `npm run smoke`: healthy and simulated-failure production-server checks passed.
- `cfn-lint infra/*.yaml`: passed.
- Upstream's own local suite: **61 tests passed, zero skipped**, using Docker DynamoDB Local; upstream typecheck, build and package checks passed. Local DynamoDB is not evidence of MRSC behavior.
- GitHub Actions [run 36275044331](https://github.com/ataylorme/tanstack-start-aws-high-availability/actions/runs/36275044331): passed.
- Live HTTP routing: both region preferences, SSR, health and all seven supported HTTP methods passed. Workflow lab markup is present.
- Live workflow API: missing authentication rejected with HTTP 401; responses verified `no-store` and the requested serving region.
- Both cross-region runs: opposite-region immediate read, signal delivery, approval, intentional retry succeeding on attempt 2, duplicate signal suppression, two scheduled durable sleeps, contiguous event indices and identical final regional reads passed.
- Concurrent starts/signals from both regions: one signal resolution, approval rejection and preserved payload passed.

| Scenario | Committed events |
| --- | --- |
| Virginia start, Oregon signal | 14 |
| Oregon start, Virginia signal | 14 |
| Concurrent duplicates and rejection | 8 |

Machine-readable workflow results are in [workflow-validation.json](workflow-validation.json). Site URLs in the linked evidence reports use a reserved `.invalid` placeholder rather than a deployment hostname.

## Historical scheduled-worker recovery

Both directions passed without manually invoking a sweeper:

| Disabled schedule | Worker completing both sleeps |
| --- | --- |
| Virginia | Oregon |
| Oregon | Virginia |

Both schedules were restored to `ENABLED` by the recovery runner. See [workflow-recovery.json](workflow-recovery.json). The workflow acceptance suite overlapped the first recovery scenario, so its timer work also completed through Oregon while Virginia scheduling was paused. This demonstrates worker-schedule unavailability, not an actual regional outage.

## Findings reported upstream

1. [Issue #2: development dependency advisory](https://github.com/ataylorme/tanstack-workflow-aws/issues/2): upstream Vitest 3.2.7 is affected by GHSA-82fw-gwwq-j7x9. Two moderate development audit entries; production dependency audit reported zero. No exploitation was attempted.
2. [Issue #3: document an explicit MRSC CloudFormation service role](https://github.com/ataylorme/tanstack-workflow-aws/issues/3): the first deployment using caller temporary credentials failed replica provisioning with `UnrecognizedClientException`, although direct authenticated calls worked. An explicit, table-scoped CloudFormation role resolved deployment. This is a deployment/documentation finding, not proof of a workflow-runtime defect or universal incompatibility with `aws login`.

A transient ECR upload connection failure was recovered with smaller upload parts and idempotent image publishing. Initial CloudFront DNS lookup failure disappeared after distribution deployment completed. Neither was attributed to the library.

## Scope and limitations

No upstream runtime defect was observed in these bounded scenarios. This is not production certification, load testing, a real AWS regional outage, or a quorum-loss experiment. Browser interactions were not automated; HTTP/API behavior and rendered markup were checked. Test runs intentionally contain no sensitive application data.

The existing main deployment remained healthy; its resources were not updated. The isolated lab and main deployment were later torn down at the owner's request. The API token remains in the owner-only local file `.deploy/<account-id>-<stack-prefix>/workflow-test-token`, not in this repository. See [workflow-testing.md](workflow-testing.md) for use, repeatable validation and teardown.
