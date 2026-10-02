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

## Pull request checklist

- [ ] Business behavior and non-goals are clear.
- [ ] Authentication/authorization and server-derived actor identity are preserved.
- [ ] Duplicate requests, conflicting requests, stale plans, retries, and ambiguous outcomes are covered.
- [ ] A workflow/event/schema version decision is documented, including "unchanged" when appropriate.
- [ ] Old persisted tasks remain readable/resumable, or there is an explicit safe transition plan.
- [ ] Tests cover intended behavior and failure boundaries; evidence distinguishes local from live.
- [ ] IAM and resource changes remain isolated from the HA lab.
- [ ] Metrics, diagnostic messages, and recovery instructions explain new failure states.
- [ ] No credentials, live URLs, account IDs, raw operational evidence, or private task data are published.
- [ ] Release and rollback are compatible with the data both old and new code may have written.

## Security and public documentation

Keep private configuration and evidence under ignored `.deploy/` or an approved secret store. Public examples should use placeholders. Tokens must not enter query strings, browser storage, logs, fixtures, or screenshots. Review staged files before pushing.

If a credential is exposed, revoke/rotate it through the appropriate controlled procedure; deleting the newest file revision is insufficient. Removing already-published identifiers from Git history is a separate coordinated rewrite that affects collaborators. Do not force-push or rewrite shared history as part of ordinary feature work. Report sensitive issues privately through an established maintainer/security channel, not a public issue containing the secret.
