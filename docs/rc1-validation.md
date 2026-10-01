# rc.1 validation — 2026-10-01

Validated the published `@ataylorme/tanstack-workflow-aws@0.2.0-rc.1` artifact on
this branch and updated the existing isolated AWS lab using the `ataylorme` profile.
Account IDs, URLs, tokens, resource ARNs, image digests and raw evidence remain in
ignored `.deploy/` files. This is a reference lab, not production qualification.

## Passed

- Production app, edge and all four native worker bundles; strict TypeScript;
  182 tests across 18 suites; healthy/failure production smoke; CloudFormation lint.
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

## Boundaries

Ordered logs, subscriber cursors and synthetic lab receipts remain retained.
The cleanup fixture tests direct cleanup semantics, not seven/thirty days of elapsed
retention. Interval tick execution is live-tested; every cron/DST/missed-tick/overlap
combination is not independently load-tested. Existing alarms have no paging actions.
The blocked subscriber uses a proven no-effect synthetic failure, not an uncertain
external provider. No real region outage, arbitrary external exactly-once effect,
production load/latency claim, or long-duration idle guarantee is asserted.

See [feature matrix and deployment procedure](rc1-lab.md). Older validation documents
record rc.0 results and must not be substituted for this release's evidence.
