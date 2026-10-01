# 0.2.0-rc.1 lab upgrade

This branch pins the published GitHub Packages release, not a local checkout.
`src/events/package-provenance.json` records its source commit and downloaded
artifact SHA-256; the lockfile verifies its SHA-512 integrity. The upstream reference is
[PR #4](https://github.com/ataylorme/tanstack-workflow-aws/pull/4).

## What the lab exercises

| Feature | Lab / verification |
| --- | --- |
| Stable unordered publication and cross-region retry/conflict | Existing application-event controls and `verify-application-events.ts` |
| Contiguous typed lifecycle, deterministic IDs, gaps/type/conflict rejection | Ordered event lab: requested → approved → started → completed |
| Retained-source catch-up and duplicate suppression | Deliver sequence 4, then stale sequence 1; inspect durable receipts and cursor |
| Shared subscriber ordering across regions | Both regional FIFO/SNS subscribers share one subscriber ID and MRSC cursor |
| Uncertain effects block successors | Synthetic failure at sequence 2; inspect blocked claim and withheld later receipts |
| Safe explicit resolution | Dedicated no-effect fixture only; recovery requires the exact recorded failure claim; no arbitrary operator API |
| Real asynchronous fanout | Transport receipts are separate from direct subscriber test receipts |
| Targeted processing and durable successors | Unified router and package worker, with no broad sweep on normal SQS messages |
| Committed workflow event outbox | `outbox-v1`; inspect committed event and actual delivery |
| Continue as new | `continuation-v1`; exactly one deterministic successor with fresh history |
| Bounded history | `history-limit-v1`; expected terminal limit failure, never truncated replay |
| Generation-aware recurring schedules | Fixed five-minute interval/Los Angeles cron; overlap and missed-tick controls; disable after testing |
| Retention and cleanup | Seven-day terminal/unordered retention and 30-day tombstones; ordered logs/cursors retained |

Tokens stay in component memory. The lab performs synthetic effects only, but creates
billable durable state. Ordered logs, cursors and lab receipts are deliberately retained;
this is not a production retention/archival policy. Delivery remains at least once.
A FIFO queue alone does not provide cross-region business ordering. Claims do not expire;
real uncertain effects require an operator to fence the original execution and reconcile
the destination before resolution. Do not automate claim stealing.

## Architecture

Each replica has one `NEW_AND_OLD_IMAGES` stream reader. It routes workflow, outbox,
and cleanup obligations to the standard wakeup queue / one-time Scheduler, and application
notifications to a FIFO queue. A relay publishes to a regional SNS FIFO topic. Regional
ordered subscribers consume FIFO queues and share durable MRSC cursors. The retained
standard east observation queue subscribes to the east topic for existing delivery checks.
The old application-event reader is disabled; its queue, archive and logs are retained.

Settled rc.0 metadata is preserved unchanged, not relabelled as version 1. Active or
unknown legacy obligations require investigation rather than being silently discarded.
Reconciliation scans version-1 RUN/TIMER/SCHEDULE/EVENT metadata, including outbox and
cleanup obligations. It does not scan ordered logs or subscriber cursors for delivery.

## Updating an existing lab

Use the existing isolated prefix, profile, secrets and table. Never use the main-site
prefix. Save rollback artifacts in ignored `.deploy`; do not publish account IDs or tokens.

1. Run `npm run check`, `npm run smoke`, and CloudFormation lint.
2. Run the application-event deployment's `--prepare --execute` phase to disable the
   old regional workflow mappings and the legacy east event reader; wait for Disabled.
3. Update the retained table stream to `NEW_AND_OLD_IMAGES` (this changes stream ARNs).
4. Deploy the same image to both apps and the same native worker bundle to both regions.
   Guarded changes permit stream-mapping replacement only after the old mapping is disabled.
5. Run `deploy-application-events.ts --execute` to attach the retained observation queue
   to the new east SNS topic and preserve the existing app receive-only configuration.
6. Reconcile version-1 obligations, run the live verifiers, and inspect queues, mappings,
   logs and alarms. Do not declare success from CloudFormation status alone.

All mutation scripts require explicit execution. Dedicated migration scripts additionally
require `AWS_PROFILE`, `EXPECTED_AWS_ACCOUNT_ID` and isolated `STACK_PREFIX`.
Live HTTP verifiers read `WORKFLOW_TEST_TOKEN_FILE`; never pass tokens on the command line.

```sh
node scripts/verify-application-event-recovery.ts     # offline corrected-record replay plan
node scripts/verify-application-event-recovery.ts --execute
node scripts/verify-ordered-events.ts                 # offline plan
node scripts/verify-ordered-events.ts "$SITE_URL" --execute
node scripts/verify-workflow-lifecycle.ts             # offline plan
node scripts/verify-workflow-lifecycle.ts "$SITE_URL" --execute
```

The older validation documents are historical rc.0 evidence, not proof that rc.1 passed.
Record current execution results separately. Full AWS-region outage, real external-effect
ambiguity, extended retention expiry, DST transitions and production load remain separate
acceptance work; the synthetic lab cannot establish those guarantees.
