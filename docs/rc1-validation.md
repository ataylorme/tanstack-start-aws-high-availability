# rc.1 validation — 2026-10-01

Validated the published `@ataylorme/tanstack-workflow-aws@0.2.0-rc.1` artifact on
this branch and updated the existing isolated AWS lab using the `ataylorme` profile.
Account IDs, URLs, tokens, resource ARNs, image digests and raw evidence remain in
ignored `.deploy/` files. This is a reference lab, not production qualification.

## Passed

- Production app, edge and all four native worker bundles; strict TypeScript;
  207 tests across 21 suites; healthy/failure production smoke; CloudFormation lint.
- Both regional apps use one digest-pinned image and the recorded registry artifact.
  CloudFront routing/SSR and all health endpoint methods pass in both regions.
- Staged stream-view migration preserves the MRSC table and historical rc.0 data;
  old readers were disabled before replacement. No active legacy runs, queued
  wakeups, or pending legacy schedules were present at cutover.
- New unified routers, targeted workers, FIFO relays and ordered subscribers are
  deployed in both regions. The legacy east reader remains disabled. Its retained
  observation queue now subscribes to east SNS.
- Unordered authenticated HTTP publication from both regions, stable duplicate
  envelopes, changed-content rejection and three full envelopes through real transport.
- Ordered lifecycle publication, cross-region retries, gap/type/content rejection,
  retained-source catch-up from notification 4, stale notification suppression,
  synthetic blocked claim and safe cross-region retry resolution. Independent
  receipts prove real FIFO → SNS → subscriber delivery, not only direct invocation.
- Browser publishing, cross-region retry and retained-source catch-up; no JavaScript
  page errors. Desktop and narrow-screen controls inspected; no horizontal overflow.
- Existing workflows: cross-region signals/approvals, rejection, duplicate
  start/signal races and two sequential timer resumptions.
- Committed workflow outbox event observed in the real destination queue; one
  deterministic continue-as-new successor finishes with fresh history; configured
  history exhaustion reaches the expected terminal error.
- Recurring schedule duplicate registration, actual first scheduled run completion,
  self-advancing deadline without HTTP reseeding, changed generation/policies, and
  final disable. Both fixed interval and timezone cron configurations are exercised.
- Unique short-retention fixture: bounded direct cleanup, payload removal, compact
  tombstone and late run-ID reuse rejection. Normal retention settings are unchanged.
- Twelve abandoned execution leases recover through targeted regional wakeups;
  both one-time schedule groups observed; exactly two timer resolutions per run.

- Malformed version-1 event: good records continue delivering; the full failed INSERT
  is archived in S3; a corrected clone with the same ID replays through the unified
  router, FIFO relay, SNS and observation queue. Original item/archive are retained.
- Repeated worker deployment reports no template changes and verifies live mappings.
- Final state: matching regional app image/release, complete updated stacks, one
  enabled stream router and four enabled worker mappings per region, disabled legacy
  reader, empty failure queues, and all test workflows terminal (one intentional
  history-limit error).

## Additional validation

- Regional worker isolation: paused each regional wakeup mapping in turn. The
  healthy region completed both timer sleeps with exactly two committed resolutions;
  both original mappings were restored.
- Schedule semantics against live DynamoDB: missed-tick skip/run-once/catch-up,
  bounded catch-up, overlap skip/allow with active runs, stale-generation
  acknowledgement fencing and stale-definition rejection. Direct semantic cases
  use a synthetic clock and future-dated fixtures to avoid worker races.
- Background schedule execution: fixture-seeded overdue deadlines produce exactly
  0/1/2 completed runs for skip/run-once/bounded catch-up. Real deployed workers
  advance deadlines; all fixture schedules are disabled afterward.
- Exact configured item/history byte budgets, signal receipt count and duplicate
  handling, exact 240 KiB ordered envelope boundary, ordered-stream count limit,
  and stale-notification cursor preservation pass against the real table.
- Deployed workers remove short-retention fixture history and create a tombstone;
  retained run-ID reuse is rejected. Conditional acceleration of only that
  tombstone's expiry then proves worker-driven deletion. Ordered source and cursor
  records remain unchanged.

- Destination permission failure: narrowly denied east router `sqs:SendMessage`,
  proved AccessDenied, observed native retries exhaust into a full S3 archive,
  restored permission and replayed the unchanged record through east FIFO/SNS to
  the observation queue. CloudWatch dispatch-failure alarm transition was observed.
  Temporary IAM policy and original mapping state were restored. Initial attempt
  stopped safely because 90 seconds was insufficient for IAM propagation; the
  bounded five-minute probe passed. No package defect was identified.
- Review strengthened compact-tombstone payload assertions and interruption-safe
  regional restoration. The stronger cleanup check passed again live.

Reproduce with `scripts/verify-workflow-recovery.ts`,
`scripts/verify-schedule-policies.ts`, `scripts/verify-limits-cleanup.ts`, and
`scripts/verify-destination-recovery.ts`. The scripts default to offline plans;
execution requires `--execute`, explicit `AWS_PROFILE`, isolated `STACK_PREFIX`,
and `EXPECTED_AWS_ACCOUNT_ID`. The regional drill also takes the site URL and
`WORKFLOW_TEST_TOKEN_FILE`. Run outage drills sequentially. Private evidence and
restoration instructions are written beneath ignored `.deploy/` before mutations.

## Boundaries

Ordered logs, subscriber cursors and synthetic lab receipts remain retained.
Cleanup covers both direct semantics and deployed-worker dispatch, but uses short
fixture retention and accelerated tombstone expiry, not seven/thirty days elapsed.
Missed-tick background cases seed overdue deadlines rather than waiting through an
outage; overlap and generation fencing use synthetic time with real storage.
Signal-count checks exercise the store receipt budget, not a full engine lifecycle
at its default limit. Every cron/DST/policy combination is not independently
load-tested. Existing alarms have no paging actions.
The blocked subscriber uses a proven no-effect synthetic failure, not an uncertain
external provider. No real region outage, arbitrary external exactly-once effect,
production load/latency claim, or long-duration idle guarantee is asserted.

See [feature matrix and deployment procedure](rc1-lab.md). Older validation documents
record rc.0 results and must not be substituted for this release's evidence.
