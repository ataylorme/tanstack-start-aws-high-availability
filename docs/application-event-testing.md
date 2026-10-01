# PR #4 application-event integration lab

> **rc.1:** See [the current upgrade/feature guide](rc1-lab.md) for unified routing,
> ordered delivery and staged migration. Architecture and validation below describe
> the prior integration where explicitly noted.

Branch: `test/tanstack-workflow-aws`. The application-event integration was merged
into this branch. This lab is separate from workflow replay events and workflow wakeups.
Application events already use demand-driven stream delivery; publishing one does not
implicitly start a workflow. See [workflow wakeups](workflow-wakeups.md) for the separate
regional stream → dispatcher → one-time Scheduler/SQS → sweeper path.

## Published package and reproducibility

This branch pins **`@ataylorme/tanstack-workflow-aws@0.2.0-rc.1`** from GitHub
Packages, not a local tarball or moving branch. `package-lock.json` fixes the registry
artifact and SHA-512 integrity. `src/events/package-provenance.json` records the
upstream PR #4 source commit, registry URL, and package checksums. Both the app image
and native consumer resolve the same installed release.

`npm ci` verifies downloaded package integrity. Live verification scripts check
that the manifest, lockfile, installed version, and provenance agree before AWS calls.
Docker uses the existing GitHub Packages BuildKit secret; it no longer copies a
vendored package. Follow the workflow runbook's package authentication instructions.

The exact rc.1 tarball checksum is recorded in package provenance. Historical rc.0
evidence does not qualify this release. The upstream MIT license remains in the installed package and
`third-party/tanstack-workflow-aws-LICENSE`.

**Registry caveat:** GitHub Packages may install optional bridge peers. This app
explicitly selects SQS, SNS and Scheduler SDKs for its deployed transport; the lockfile
records all registry-resolved dependencies.

## Architecture and boundaries

- Existing origin guard and constant-time test-token auth protect
  `POST /api/application-events`; method, test ID, fixed event type, message length,
  and input fields are bounded. Use `{ "id": "test-unique-id", "message": "hello" }`.
- `202` means durable publication, **not delivery**. Reuse the same ID and payload
  after response loss; the committed envelope and timestamp are returned. Changed
  content returns `409`; uncertain persistence returns `503` and requests same-ID retry.
- Both regional apps publish to the isolated MRSC table (Ohio witness).
  `NEW_AND_OLD_IMAGES` streams expose immutable records and committed ordered heads.
- One private unified reader per replica routes workflow/cleanup/outbox obligations
  and application events independently. Application FIFO queues relay to SNS FIFO.
  The retained east standard observation queue subscribes to the east topic. The old
  dedicated event reader is disabled. No worker has a public Lambda URL.
- Bounded batches, partial batch responses, bounded retries, an encrypted private
  S3 failure archive (30-day expiration), retained logs, and delivery/backlog/runtime/
  archive alarms make failures inspectable. Alarms have no notification subscription.
- Unordered delivery remains at least once. The observation queue is only a test
  receiver. Ordered subscribers use retained logs and shared cursors, not queue FIFO
  alone, to gate callbacks. Workflows use the committed publication helper for durable
  outbox intents; arbitrary business writes plus publication are not an atomic outbox.

## Test from the browser

Open your sandbox site and use **Application event lab** above the workflow lab:

1. Paste the existing sandbox test token into **Application event test token**.
   The browser keeps it in component memory only, never in URLs or browser storage.
2. Choose **Publish region**, optionally edit **Event message**, then **Publish event**.
   The generated ID, initial region, and payload are locked for safe retries, even
   if a response is lost. HTTP 202 proves storage only.
3. Click **Retry same ID in the other region**. A pass requires the original ID,
   message and timestamp to match the first confirmed publication.
4. Click **Test conflicting payload**. HTTP 409 is the expected success condition;
   the stored event is not changed.
5. Click **Check SQS delivery**. A pass requires the real queue message to match
   the published envelope. If not observed, wait a few seconds and check again.
6. **New event** clears the scenario and unlocks the inputs, without deleting data.
   Repeat starting in the other region. Reloading clears the token and local results.

Delivery checks are token-protected, queue-scoped receives from the dedicated east
queue, regardless of which app Region serves the request. Each check samples at most
ten messages, waits up to two seconds, and can hide received messages for five seconds.
It never deletes messages or reveals unrelated events, queue URLs, ARNs, or account IDs.
A pending sample is inconclusive: another observer/CLI runner may have consumed or
hidden the message. A later pending check does not erase a previous delivery pass.

Run `scripts/deploy-application-events.ts --execute` after the app stacks exist to
configure both apps with receive-only queue access. No credentials or queue identifiers
are embedded in frontend assets. Failure injection and archive replay remain CLI-only;
the browser does not change permissions, pause mappings, or replay malformed records.

## Deploy and validate

These commands create billable sandbox resources, including MRSC in three Regions.
Never use the main site's prefix. Use a fresh `event-lab-example` prefix (ten stacks:
existing nine-stack workflow lab plus one application-events stack).

```sh
export AWS_PROFILE=your-sandbox-profile
export EXPECTED_AWS_ACCOUNT_ID=YOUR_SANDBOX_ACCOUNT_ID
export STACK_PREFIX=event-lab-example
export ENABLE_WORKFLOW_TESTS=true
export ECR_UPLOAD_MODE=api
export NODE_AUTH_TOKEN="$(gh auth token)"
npm ci
npm run check
npm run smoke
node scripts/deploy.ts                    # offline plan
node scripts/deploy.ts --execute
node scripts/deploy-application-events.ts # offline plan
node scripts/deploy-application-events.ts --execute

export ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
export WORKFLOW_TEST_TOKEN_FILE="$PWD/.deploy/$ACCOUNT_ID-$STACK_PREFIX/workflow-test-token"
export SITE_URL="$(aws cloudformation describe-stacks --region us-east-1 \
  --stack-name "$STACK_PREFIX-global" \
  --query "Stacks[0].Outputs[?OutputKey=='SiteUrl'].OutputValue | [0]" --output text)"
export EVENT_TEST_QUEUE_URL="$(aws cloudformation describe-stacks --region us-east-1 \
  --stack-name "$STACK_PREFIX-application-events" \
  --query "Stacks[0].Outputs[?OutputKey=='QueueUrl'].OutputValue | [0]" --output text)"
node scripts/verify-application-events.ts             # offline plan
node scripts/verify-application-events.ts "$SITE_URL" --execute
```

The bounded runner checks auth, validation, routing to each Region, sequential and
concurrent cross-region stable-ID retries, conflict rejection, and full-envelope
arrival of three unique application events through the real stream mapping. It
requires the dedicated SQS queue, deletes only its own matched messages, and records
private evidence in `.deploy/event-results/` with package provenance (checked against
the authenticated response headers), matching regional release IDs, application
commit, dirty-tree flag, timestamps and event IDs. Other queue messages may briefly
be hidden by receive visibility; never target a business queue. Existing test items
remain for diagnosis. It does not claim exact-once delivery from observing three IDs.

For additional direct-package MRSC strong-read checks (not HTTP coverage), use the
runner shipped in the pinned artifact:

```sh
export EVENT_TEST_TABLE="$STACK_PREFIX-workflow"
node node_modules/@ataylorme/tanstack-workflow-aws/scripts/test-events-live.mjs --execute
```

## Malformed record / corrected replay drill

```sh
node scripts/verify-application-event-recovery.ts           # offline plan
node scripts/verify-application-event-recovery.ts --execute
```

Execution requires the isolated `STACK_PREFIX`, `AWS_PROFILE`, and a 12-digit
`EXPECTED_AWS_ACCOUNT_ID`; the caller identity is checked before any AWS mutation.
The rc.1 runner validates the active unified router in `${STACK_PREFIX}-sweeper`,
including the `NEW_AND_OLD_IMAGES` stream, batch size 10, bounded retries and S3
failure destination. The disabled legacy bridge is never invoked.

It inserts one malformed **schemaVersion 1** application-event record in east
(replication also exercises the west router), observes a separate good event, and
polls the east S3 archive for up to five minutes. It then invokes the private unified
router with a corrected copy preserving the archived event ID. The test asserts an
empty partial-failure response and the full corrected envelope arriving through the
application FIFO queue → SNS FIFO topic → retained standard observation queue.
Only this drill's matching observation messages are deleted. The original malformed
table item and archive remain unchanged, so later replay of the original still fails.
Evidence is private under `.deploy/event-results/`.

This proves corrected-malformed-record replay, **not** destination-outage recovery,
same-shard ordering/progress, alarm transitions, or business-effect idempotency.

## Remaining acceptance gates

A happy-path pass is not full production or PR qualification. Follow the pinned
package's `docs/event-testing.md` for these separately recorded drills:

1. Denied destination permission: observe partial failure logs/alarm, retries and a
   full failed batch in S3, then restore permission and replay that exact batch.
2. Malformed event record: the automated drill covers archive and corrected replay;
   same-shard ordering/progress remains a separate gate.
3. Duplicate consumer invocation: demonstrate application-owned idempotency before
   adding any business effect (standard SQS alone does not provide it).
4. Controlled reader Region handoff: disable old mapping before enabling the new one;
   retained facts may replay. This is not an AWS Region outage test.
5. Remaining-time and archive-permission failures: verify retries and alarm behavior.

Same-ID publication is **not replay**: it creates no second INSERT. Replay the saved
S3 payload after fixing the fault; inspect both invocation error and batch failures.
Keep publisher, stream delivery, HTTP end-to-end, and failure/replay results distinct.
The run status is recorded in [application-event-validation.md](application-event-validation.md).

## Cleanup

No script deletes stacks, purges queues, or deletes table items. Disable the event
mapping, regional workflow stream/queue mappings, and remaining one-time workflow
schedules before an explicitly authorized teardown. Delete the
application-events stack before the table, then follow the workflow lab teardown.
The retained table, failure archive, logs, ECR and artifacts continue to incur charges
until separately cleaned up. Preserve evidence and failed payloads first.
