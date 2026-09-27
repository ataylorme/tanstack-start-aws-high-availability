# Application-event validation status

Candidate: upstream PR #4, commit `5f2e2b9416049b8173c8d29b8b153dec9a5026ad`.
See `vendor/application-events-candidate.json` for the exact tarball checksum.

- Local application build, edge/sweeper/consumer bundles, typecheck, 129 tests: passed.
- Production-server healthy/failure smoke: passed.
- CloudFormation lint (`cfn-lint 1.57.0`, all templates): passed.
- Upstream installed-tarball export/type/optional-peer isolation checks: passed.
- AWS CloudFormation template validation (event consumer and MRSC table): passed.
- Live MRSC/stream preflight: passed in east and west (2026-09-27).
- Live direct-package publication, concurrent duplicate reconciliation, conflict
  rejection, and strongly consistent reads in both Regions: passed.
- Live direct-package stream-to-SQS delivery: passed (three full envelopes).
- Both regional application Lambdas are Active with the same image digest/release.
- Live CloudFront routing and HTTP method smoke in both Regions: passed.
- Live HTTP event authentication/input rejection, regional publishing, opposite-Region
  retries retaining the original envelope, changed-content conflicts, and concurrent
  duplicate reconciliation: passed.
- Live application HTTP-to-DynamoDB Stream-to-SQS delivery: passed (three complete
  envelopes). Candidate SHA/checksum response headers and matching regional release
  IDs were checked.
- Live malformed-record full-payload S3 archive, separate good-event delivery, and
  corrected archived-record replay through private Lambda to SQS: passed.
  Archive reports `RetryAttemptsExhausted` after six invocations; delivery-failure
  alarm history confirms an `OK` to `ALARM` transition.
- Destination-outage replay, same-shard progress, other alarm transitions, timeout/archive
  permission failures, idempotent business effects, and Region handoff: not verified.

This is an experimental integration branch, not production qualification.

## Evidence and scope

Executed on 2026-09-27 using isolated sandbox resources. The main site was not
modified. All ten sandbox stacks completed creation. Matching application image
digests were independently checked on both active regional Lambdas; deployment
identifiers and exact image digests remain in private local evidence only.

Do not publish AWS account IDs, resource names/IDs, ARNs, endpoints, deployed image
digests, credentials, or raw deployment output in this repository or PR descriptions.
Public validation summaries contain outcomes only; upstream source commits and
package checksums identify the public candidate, not the AWS deployment.

Private detailed evidence is intentionally not committed:

- `.event-test-results/`: direct package MRSC and stream delivery report.
- `.deploy/event-results/`: HTTP report, archived malformed-record/replay report,
  regional image provenance, and delivery-alarm history.

The application was built from this branch's uncommitted integration working tree;
reports mark that fact rather than claiming the base commit contains these changes.
Intermittent ECR upload connection failures were recovered by resuming the same saved
image, without changing its digest or rotating deployment secrets. These were
transport failures, not application-event test failures.

Sandbox resources remain deployed and billable. No destructive cleanup was performed.
Use the runbook for repeat validation and explicit teardown. Passing these integration
checks is not blanket approval of PR #4 or proof of production outbox/idempotency semantics.

## Browser application-event lab

- Local headless-browser interaction checks: passed (publish, cross-region retry,
  conflict rejection, pending/observed queue samples, preserved delivery evidence,
  retry after response loss, new-event reset, token clearing on reload, mobile layout).
- The panel reports storage and queue observation separately; queue checks are
  receive-only, bounded, token-protected, and never delete messages.
- Regional queue-observer configuration and updated UI deployment: passed in both Regions.
- Live headless-browser flow against AWS: passed starting in each Region, including
  publication, retry in the other Region, changed-payload conflict rejection, and
  matching full envelopes observed through the real SQS queue. Reload clears the
  token; no browser runtime errors were observed.
- Detailed browser results and screenshots remain private under `.deploy/ui-check/`.
  Public summaries omit deployment-specific URLs, ARNs, IDs, and credentials.
