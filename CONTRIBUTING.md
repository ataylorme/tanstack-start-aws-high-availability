# Contributing

This repository contains the original TanStack Start HA lab and a **separate DevOps orchestration POC**. Changes to one must not silently reconfigure or deploy the other. This guide focuses on the POC; consult the [repository getting-started guide](docs/getting-started.md) for the original lab.

## Read in this order

1. [Architecture and mental model](docs/orchestration/architecture.md): events, durable workflows, execution boundaries, and why this design exists.
2. [Development cookbook](docs/orchestration/development.md): trace the existing task, write tests, add tasks and subscribers.
3. [Operations and growth](docs/orchestration/operations.md): deployment, diagnosis, recovery, security, ownership, and maturity gates.
4. [Versioning and migrations](docs/orchestration/versioning.md): historical runs, replay compatibility, schema changes, and rollback.
5. [POC runbook](docs/orchestration-poc.md): commands and current limitations.

**Goal:** reduce cognitive complexity while simplifying testing and deployment—not hide distributed-systems failure modes. Prefer one understandable business workflow with explicit boundaries over chains of incidental event handlers. Prefer one tested artifact over independently packaged functions that must be coordinated manually.

## Development setup

Use the Node version supported by `package.json` (CI uses Node 24), npm, and Docker Compose. Installing the pinned AWS workflow adapter requires access to GitHub Packages. Supply `NODE_AUTH_TOKEN` through your approved secret mechanism; do not paste it into source files, issues, shell history, or screenshots.

```sh
npm ci
npm run dev:poc
```

The harness starts DynamoDB Local, initializes isolated local tables, runs Vite, and drives workflows in a local worker. Open `http://127.0.0.1:3000`. Local demo tokens are documented in the [runbook](docs/orchestration-poc.md); they do not work in AWS. Run only one local worker per table pair. Restart the harness after changing workflow code.

Stop the harness with Ctrl-C. Storage persists independently:

```sh
docker compose -f compose.orchestration.yaml stop
# `down` also preserves the named volume; do not add --volumes unintentionally.
```

## Change workflow

1. Start from the intended branch; preserve unrelated local changes. Use a focused feature branch for collaborative work.
2. Describe the business behavior, authorization boundary, and failure outcomes before editing.
3. Locate the owning module using the [code map](docs/orchestration/architecture.md#code-map).
4. Add regression tests at the narrowest useful layer. Add persistent-store tests when correctness depends on atomic writes, leases, inboxes, or restart.
5. For changes to persisted input, plans, step IDs, history, or event contracts, write a compatibility plan **before** changing the schema.
6. Implement the smallest coherent change. Avoid a generic plugin framework until multiple real use cases demonstrate the need.
7. Run validation below. Explain any omitted live checks rather than treating mocks as AWS evidence.
8. Update the cookbook/runbook and include a release/rollback note in the PR.

## Required validation

```sh
# Core POC .test.ts suites, including the executable documentation examples.
npm run test:poc
# The current test:poc glob does not include .tsx files.
npx vitest run tests/orchestration-form.test.tsx

# Start persistent local storage, then run all build/typecheck/test gates.
node scripts/orchestration-local.ts --init-only
DYNAMODB_LOCAL_ENDPOINT=http://127.0.0.1:8000 npm run check
npm run smoke
git diff --check
```

`npm test` without `DYNAMODB_LOCAL_ENDPOINT` explicitly skips the real-DynamoDB suites. An all-green mock-only run is not a persistent recovery test. CI separately starts DynamoDB Local and executes those suites. CloudFormation changes must also pass the pinned `cfn-lint` command from the runbook. There is no separate ESLint command; do not report one as executed.

Browser changes require interaction checks, not just server-rendered snapshots: connect, inspect errors, toggle timing, clear/reset dates, verify timezone behavior, and exercise failed requests. Use a disposable local task before changing live sandbox state. Record browser/version and what was actually tested.

Live deployment is **opt-in**. Follow the POC runbook using an explicitly selected profile, expected account, and region. Do not run the HA deployment scripts for POC changes. A docs-only change does not require redeploying AWS.

## TypeScript and module conventions

- Preserve strict compiler settings. Treat network, queue, database, and JSON inputs as `unknown` until validated.
- Use discriminated unions for business outcomes. A `blocked` result is not interchangeable with a transient exception.
- Keep AWS SDK v3 calls in adapters/executors. Inject narrow ports into workflows and domain logic.
- Keep stable identifiers for persisted steps and external operations. Names can become compatibility contracts.
- Use explicit request/response types and runtime validation; `as SomeType` is not input validation.
- Use Vitest, `aws-sdk-client-mock`, and `nock`; do not introduce another test stack without a concrete need.
- Default tests must not access AWS. Disable unexpected network access in HTTP mock tests.
- Use bounded timeouts and retries; reason about their combined budget, not each setting in isolation.
- Never grant a public handler execution permissions just to make an integration easier.

## Design for years of operation

The goal is to reduce cognitive complexity over the lifetime of the project, not just make the first implementation convenient. The main risk is gradually building a workflow platform while budgeting only for a DevOps application. Revisit these risks as scope, teams, integrations, and stored history grow.

| Long-term risk | What contributors should do to mitigate it | What remains unresolved by that mitigation |
| --- | --- | --- |
| Historical workflow/version accumulation | Bound approval waits; define execution, audit, and replay support windows; retain old handlers and historical fixtures until inventory permits retirement | Expiring approvals does not retire running tasks, queued effects, terminal-history readers, or restorable backups |
| Owning runtime and adapter correctness | Assign maintainers, pin dependencies, test adapter contracts and upgrades, track upstream, periodically compare ownership cost with managed alternatives | The team still owns recovery and compatibility; a shared image does not transfer that responsibility |
| Ambiguous external effects | Require integration-specific idempotency, provider status queries, receipts, reconciliation, and compensation rules | Some outcomes require manual intervention; generic retries cannot prove an effect did not happen |
| Stale approval or changed authorization | Introduce the proposed 24-hour policy below, bind approval to an immutable plan, and revalidate execution eligibility | Target drift, revoked access, artifact vulnerability, or policy changes can invalidate an otherwise timely approval |
| Dangerous repair tooling | Make retry, cancellation, replay, and lock repair authorized, conditional, audited product actions with regression tests | An operator can still need business judgment; a force/unlock button is not a recovery protocol |
| Shared-image release bottlenecks | Preserve module boundaries and compatible rolling upgrades; split specialized executors when ownership, compute, or release cadence justifies it | One image still rolls out non-atomically across roles and can couple unrelated changes |
| Concurrency and fairness failures | Design per-target serialization/fencing, quotas, backpressure, and tenant-aware identities before increasing concurrency | Workflow leases do not prevent unrelated external writers from changing a target |
| Uncoordinated event consumers | Publish intentional versioned contracts, assign owners, keep contract fixtures, and define deprecation/replay windows | Producers cannot assume all consumers upgrade together or have processed an event |
| Retention versus restore/idempotency conflicts | Align history, receipt, deduplication, queue, and backup policies; rehearse restore against external state | Restoring a database does not roll back real-world effects; expired identity records can reopen duplicate-execution risk |
| Green tests with declining production confidence | Combine fast tests with real-store, historical-data, provider-contract, load, and fault-injection tests | Test counts and mocks are not evidence for untested provider behavior or failure combinations |
| Knowledge concentrated in original authors | Maintain diagnostic reasons, runnable examples, ownership, runbooks, and operator handoff exercises | Documentation requires maintenance and must be tested against actual incidents and new contributors |

See [operations and growth](docs/orchestration/operations.md) for recovery and maturity gates and [versioning/migrations](docs/orchestration/versioning.md) for historical-data compatibility.

### Proposed default: approvals expire after 24 hours

**This is a proposed production policy, not current POC behavior.** The POC currently allows late approval and has no automatic approval expiry. Its existing “schedule within the next 24 hours” validation is a different constraint. This documentation change does not implement either approval or execution expiry.

A concrete policy to implement and review:

1. **Start the clock when the immutable plan becomes ready for approval**, not when the user first submitted the task. Persist `approvalRequestedAt` and `approvalExpiresAt = approvalRequestedAt + 24 hours` using trusted server time. Retries, page refreshes, duplicate submissions, and deployments must not restart the clock.
2. **Bind the deadline to the proposal.** Include it in the new versioned plan/hash contract or an equivalently immutable, explicitly bound approval policy record. Show the exact deadline and timezone in the UI. Do not retrofit hash-covered fields into previously approved plans.
3. **Enforce expiry server-side.** A new decision at or after the deadline is rejected. The API and durable processing path must agree; a disabled button or client countdown is not enforcement. Record the accepted decision time so processing delays do not misrepresent when a decision was made.
4. **Resolve races atomically.** A pending approval can transition to an accepted decision or expiry, not both. Define conditional-write/state-transition semantics and test a decision racing the expiry worker. An identical retry of a decision accepted before expiry should return its recorded outcome, not create a second decision or contradict the original acceptance.
5. **Make expiry durable and visible.** Persist an explicit expired outcome/reason, retain audit evidence, and remove the actionable approval prompt. Use a durable wakeup plus reconciliation for missed wakeups; do not rely on a browser timer. DynamoDB TTL deletion is not an execution-time business deadline and must not delete the evidence needed for audit/recovery.
6. **Require a fresh plan after expiry.** Re-read the target and current policy, create a linked replacement task with a new request identity, and obtain new approval. Do not silently extend the old deadline or transfer its approval. A future replan/cancel feature must define these transitions; it does not exist in the POC today.

**Approval expiry and execution eligibility are separate.** A decision accepted within 24 hours could remain queued for much longer. Define a separate immutable latest-start deadline (`executeBefore`, for example) or an explicit reapproval requirement for delayed execution. Validate that the requested schedule fits that window, and check eligibility immediately before beginning a new external effect. Check current target state and relevant authorization/policy as well; a timely approval is not a guarantee they remain valid.

Once an external operation has begun, expiry is not permission to abandon its receipt, delete its lock, or pretend it never happened. Reconciliation and audit must continue after the deadline. Decide explicitly whether any further mutating retry or compensation needs new authorization; recovering an ambiguous operation is different from starting a fresh one.

**Migration and tests required before shipping:**

- Add a versioned persisted deadline and expired outcome without making historical plans unreadable or invalidating their original hashes.
- Choose an explicit treatment for old pending approvals: preserve a documented legacy policy, or retire/replan them through an authorized transition. Do not invent a deadline silently at read time.
- Test just before, exactly at, and after expiry; concurrent decision/expiry; response loss and duplicate decisions; restart/deployment; delayed workers; clock assumptions; missing timer delivery; and scheduled work whose execution window expires.
- Test recovery of an already-started effect after expiry without opening a new unauthorized effect.
- Update API responses, projections, UI, metrics, audit records, and runbooks together. An `expired` state is a proposed addition, not an existing member of the current task-status union.

A 24-hour approval window reduces indefinite human waits and bounds one source of historical execution support. It does **not** justify retaining workflow versions for only 24 hours: operations, retries, delivery, audit, and restore/replay can all outlive that window.

### Periodic architecture review

At release retrospectives and regular maintenance reviews, ask:

- Can a new TypeScript contributor add a task without understanding every transport component?
- Can an operator explain and safely recover a stuck task without its original author?
- How many historical versions remain, why, and what measured condition permits retirement?
- How much engineering time goes to business capabilities versus runtime maintenance?
- Are integrations, subscribers, and recovery procedures owned and tested?
- Does one artifact still simplify delivery, or is independent execution ownership now worth a split?

If runtime maintenance repeatedly dominates, reconsider the execution engine without assuming the TypeScript control plane, domain modules, approval model, or event contracts must all be discarded. Preserve these boundaries so decisions remain reversible where practical.

## Pull request checklist

- [ ] Business behavior and non-goals are clear.
- [ ] Authentication/authorization and server-derived actor identity are preserved.
- [ ] Duplicate requests, conflicting requests, stale plans, retries, and ambiguous outcomes are covered.
- [ ] A workflow/event/schema version decision is documented, including "unchanged" when appropriate.
- [ ] Approval expiry, execution eligibility, retention, and historical-version support are considered; proposed safeguards are not described as already implemented.
- [ ] Old persisted tasks remain readable/resumable, or there is an explicit safe transition plan.
- [ ] Tests cover intended behavior and failure boundaries; evidence distinguishes local from live.
- [ ] IAM and resource changes remain isolated from the HA lab.
- [ ] Metrics, diagnostic messages, and recovery instructions explain new failure states.
- [ ] No credentials, live URLs, account IDs, raw operational evidence, or private task data are published.
- [ ] Release and rollback are compatible with the data both old and new code may have written.

## Security and public documentation

Keep private configuration and evidence under ignored `.deploy/` or an approved secret store. Public examples should use placeholders. Tokens must not enter query strings, browser storage, logs, fixtures, or screenshots. Review staged files before pushing.

If a credential is exposed, revoke/rotate it through the appropriate controlled procedure; deleting the newest file revision is insufficient. Removing already-published identifiers from Git history is a separate coordinated rewrite that affects collaborators. Do not force-push or rewrite shared history as part of ordinary feature work. Report sensitive issues privately through an established maintainer/security channel, not a public issue containing the secret.
