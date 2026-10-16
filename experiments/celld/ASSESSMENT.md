# Bounded go/no-go assessment

Reviewed 2026-10-15 against pinned **celld v0.6.2**. This is an experiment result,
not a production availability guarantee or completion of every issue #2 criterion.
The user permits supported native extensions but **does not permit a celld fork**.

## Decision

- **GO for continued isolated runtime evaluation:** TanStack Start itself runs on
  celld, with native Cloudflare-compatible Durable Objects and Workflows. Local
  Chrome and deployed compatibility probes passed the bounded cases below.
- **NO-GO for automatic writable regional failover:** the inspected shipped
  runtime has neither a supported regional commit-authorization hook nor a
  supported generic DO/Workflow recovery/epoch importer. Independent regional
  buckets remain independent native ownership domains. Do not enable ACTIVE
  routing or promotion to work around this boundary.
- **Not a production recommendation:** full failure/cost/performance requirements
  remain unproven. At the pre-publication validation snapshot, resources were running and billable.
  See [REPORT resource disposition](REPORT.md#resource-disposition-and-publication)
  for the subsequent publication and verified active-infrastructure teardown,
  including the AWS-enforced SYSTEM-backup retention exception.

## Current completion blocker

The full implementation is **not complete**. Fresh official upstream checks on
2026-10-15 found the [latest release remains v0.6.2](https://github.com/denoland/celld/releases/tag/v0.6.2)
and [`main` remains the pinned commit](https://github.com/denoland/celld/commit/90b43017241f81189453d326d05948f388b34652).
The relevant native authorization/import surfaces have not changed. In
particular, [store-injection constructors remain test-only](https://github.com/denoland/celld/blob/90b43017241f81189453d326d05948f388b34652/crates/celld/bucket.rs#L565-L605)
and the [cell CLI has no generic lineage/epoch importer](https://github.com/denoland/celld/blob/90b43017241f81189453d326d05948f388b34652/crates/celld/cell_cli.rs#L193-L203).

Supported native facilities for both authorization and recovery bootstrap are
needed to resume the critical regional path. Their existence alone would not
prove completion: integrate them, validate complete recoverable history and run
the outstanding adversarial regional/controller/failback tests before enabling
writes. The user has ruled out a fork; do not replace this missing integration
with a custom runtime, fabricated native records, application replay or an edge
preflight and call the original objective achieved.

The acceptance audit below remains authoritative. Full operating cost and
regional latency/RPO/RTO are also incomplete; an idle-cost floor, single-marker
replication observation or local crash test does not waive those requirements.
The executable isolated experiment and no-go assessment are useful deliverables,
not a redefinition of the full goal. No promotion or destructive teardown is
performed as part of declaring this blocker. At that snapshot, deployed resources
were billable; subsequent authorized cleanup is tracked in REPORT.md.

## Supported extension review

| Surface | What it permits | Why it does not close the gate |
|---|---|---|
| [DO JavaScript APIs](https://github.com/denoland/celld/blob/v0.6.2/docs/services/durable-objects.md), [Workflows](https://github.com/denoland/celld/blob/v0.6.2/docs/services/workflows.md) | Application transactions, handlers, steps and alarms | No documented native before-commit regional authority hook or native epoch import |
| [Dynamic Worker globalOutbound and tails](https://github.com/denoland/celld/blob/v0.6.2/docs/services/dynamic-workers.md) | Egress mediation and post-response observation | Not SQLite commit, alarm, Workflow persistence or universal continuation gates |
| [Bucket store injection](https://github.com/denoland/celld/blob/v0.6.2/crates/celld/bucket.rs#L540-L607) | Internal test substitutions | Constructors are hidden and compiled under `celld_internal_tests`, not a production plugin contract |
| [Rust host traits](https://github.com/denoland/celld/blob/v0.6.2/crates/ltx/src/host.rs) | Source-level library facilities | A public Rust symbol is not registration into the shipped runtime; custom embedding is not assumed supported |
| [Operator API](https://github.com/denoland/celld/blob/v0.6.2/docs/security.md) | Activation, eviction, DO requests, shutdown | Not provider registration or a lineage-preserving import operation |

These are findings for the inspected version, not a claim about all future celld
versions. The decision can be revisited if upstream exposes supported facilities
and the required adversarial tests pass. No fork, patched runtime, fabricated
owner record, source-node identity reuse or application-only substitute is used.

## Evidence and explicit gaps

| Requirement area | Actual evidence | Remaining gap |
|---|---|---|
| Fullstack runtime | Start SSR/assets/hydration, server functions, cookies, redirects, bindings and incremental stream; local and deployed Chrome checks | Not exhaustive Workers compatibility, cancellation/backpressure or production load qualification |
| Stateful application | Native SQLite commands/deduplication, signed-ticket sockets, native Workflow steps/sleep/approval and restart persistence; deliberate failed callback retried on native attempt 2 with deduplicated DO effect locally and across eastern nodes | Full retry/event/side-effect matrix and publicly ACTIVE stateful routing not qualified |
| AWS isolation | Independent plain CFN fleets, two AZs each, ALBs, CloudFront, private peer/operator ingress, MRSC directory | Origin transport remains HTTP; application interlock is not native regional authorization |
| Node loss | Exact resident-owner EC2 terminated barrier before survivor probes; same commands/Workflow survive; ASG replacement healthy | Not a whole-region outage, still-running old-primary barrier or writable regional failover |
| Recovery bytes | Post-drill archive: 19 full LTX payloads, 19 corruption rejections, 12 SQLite images; exact three-command acknowledged ledger | Non-atomic listing, unsent peer tails and complete retirement/folded-log coverage unproven |
| Workflow journal | Completed approval metadata, exactly four steps, consumed event, acknowledged outputs, retention alarm and byte/body-verified native wake publication agree | No pending Workflow replay, import, activation, latest wake liveness or complete checkpoint proof |
| Epoch selection | Real newer-epoch snapshot selected; six separate synthetic native chain fixtures | Synthetic continuation does not prove deployed multi-span recovery or safe destination bootstrap |
| Outage behavior | Graceful two-service outage/restart; public missing/FENCING routes refuse; no standby selection | Actual regional partition, concurrent promotion, quorum-loss lifecycle and failback not performed |
| Benchmarks/costs | Warm SSR and directory measurements; partial observed inventory/quote subtotal | No ACTIVE end-to-end regional mutation comparison, full RPO/RTO, total bill or production sizing |

See [the implementation/evidence checklist](README.md#full-acceptanceevidence-checklist),
[native requirements](NATIVE-GAPS.md), [architecture](ARCHITECTURE.md) and
[measurement exclusions](COSTS.md). Raw resource identities, tokens and deployment
artifacts stay in ignored local storage; this report contains only sanitized results.

## Comparison with the existing experiments

| Dimension | Lambda Web Adapter baseline | TanStack Workflow reference branch | This celld experiment |
|---|---|---|---|
| Start host | Container Lambda/Node | Same Lambda-based host | celld Worker runtime itself |
| Workflow implementation | None required by baseline | Published TanStack Workflow AWS package, MRSC state and native wake workers | celld's Cloudflare-compatible WorkflowEntrypoint API; no TanStack Workflow dependency |
| State ownership | Stateless HTTP routing does not authorize actor histories | Package-specific MRSC workflow ownership; reference evidence has its own version limits | Native S3 ownership within a fleet; MRSC routing cannot replace it |
| Regional recovery conclusion | HTTP failover is not stateful DR | Its reported workflow/scheduler tests are not proof for celld | Node-loss/byte reconstruction pass; writable regional DR no-go under current supported surfaces |
| Operations | Lambda/container/edge stack | Additional table, dispatch/scheduling and sweep workers | Long-lived EC2 fleets, peer disks, buckets/CRR, directory and recovery inventory |

The [reference branch](https://github.com/ataylorme/tanstack-start-aws-high-availability/tree/test/tanstack-workflow-aws)
and its [workflow runbook](https://github.com/ataylorme/tanstack-start-aws-high-availability/blob/test/tanstack-workflow-aws/docs/workflow-testing.md)
are structural references, not transitive evidence for this runtime. Historical
reference reports explicitly separate earlier engines and wakeup architectures;
no performance, cost or safety superiority is inferred across these experiments.

## Reopening the regional gate

Upstream would need supported native authorization across transaction/output,
activation, internal calls and background work, plus a validated destination-owned
epoch bootstrap/import that preserves DO/Workflow history and alarm discovery.
Then test delayed old work, pauses/partitions, uncertain renewals, incomplete
recovery, controller restarts, concurrent promotion and isolated failback before
publishing writable ownership. Detailed acceptance boundaries are in NATIVE-GAPS.
Until then, keep promotion disabled rather than replacing native state with
application replay or calling an ingress lookup a storage fence.

## Acceptance-criterion audit

This maps the issue's fourteen acceptance bullets in order. **Partial** and
**blocked** are not completion; unit/synthetic tests do not prove live regional
behavior. The region selection follows the user's east/west2/east2 override.

| # | Criterion | Current result and authoritative evidence surface |
|---|---|---|
| 1 | Repeatable CFN deployment serves Start through CloudFront | Deployed independent templates/tooling and actual ingress/Start server-function probes pass; `deploy.ts`, `verify-aws.ts`, `verify-ingress.ts`. No claim of production availability |
| 2 | Object retains state across restart and regional node loss | Local graceful restart, isolated exact-native-SIGKILL unfinished-Workflow/dedup/socket reauthentication and exact terminated-instance barrier/survivor checks pass; `verify-restart.ts`, `verify-workflow-crash.ts`, `verify-aws.ts --node-loss`. This means node loss within a region, not loss of the region |
| 3 | One ownership policy across HTTP, sockets, internal/background work | **Blocked:** native runtime does not consume the regional directory; application and edge interlocks are not a commit fence |
| 4 | Canonical/shard/cache/epoch/endpoint/unavailable routing tests | Protocol, directory and edge tests cover listed cases; deployed missing/FENCING rejection passes. ACTIVE route/native epoch enforcement is not proved |
| 5 | MRSC replicas/witness and designated least-privilege writers | MRSC and read-only edge role deployed/verified; fleet has no directory permission. Dedicated one-shard writer role now deployed; mutation CLI requires a live exact-policy/trust preflight before its temporary session, with broader simulation/read checks and inert initialization verified. This is not a full controller or a status-value IAM restriction; infrastructure provisioning keeps its documented table-scoped exception |
| 6 | Concurrent promotion/controller restart | **Blocked:** no safe activation/controller is exposed; metadata-only conditional revocation does not prove a single authorized runtime owner |
| 7 | Runtime fencing across pauses, expiry, sockets and background work | **Blocked:** local native node-lease pause result is not a regional fence; no supported commit-authorization extension found |
| 8 | No unsafe coordination fallback | Implemented missing/invalid/unavailable directory refusal and no MREC/health-driven promotion. **Partial:** all native execution paths under real quorum loss remain unproved |
| 9 | Full failure-drill matrix | **Partial:** node loss, local pause and graceful two-service outage pass. Real regional outage/asymmetric partition/still-running former-primary/native control-plane recovery remain unproved |
| 10 | Backlog/incomplete chains/missing acknowledgements/duplicates/effects | **Partial:** verified archive, native decoder/restore, corruption/missing-chain fixtures, exact lab ledger and deliberate failed-callback retry/dedup pass. No complete peer-tail/CRR coverage or external business effects qualification |
| 11 | No simultaneous regional commits, or documented blocker | **No-go branch documented:** native exclusivity cannot be proved across independent buckets; automatic writable failover remains disabled. No ACTIVE stateful public route is published |
| 12 | Failover/failback RPO/RTO/socket/old-primary evidence | **Blocked:** no supported import/bootstrap plus fencing. Local reconstruction time and socket reconnect do not substitute for this drill |
| 13 | Complete benchmark/cost/recovery measures | **Partial:** preliminary SSR/directory percentiles, partial recurring inventory, current regional tiered rates and explicit workload scenarios exist. Single-marker source/CRR presence bounds are now observed; complete acknowledged-tail exposure, regional recovery time, ACTIVE cache comparison and full operating cost remain unproved |
| 14 | Architecture/runbooks/limitations/cleanup/comparison/no-go | Implemented in README, ARCHITECTURE, NATIVE-GAPS, COSTS and this assessment. Unmet requirements remain explicit rather than waived |

The read-only `verify-observability.ts` adds actual four-node log delivery, CPU
series and alarm configuration/sample evidence. The observed archive-backlog
alarm was active; this is an operational warning, not proof of missing
acknowledged operations or of a bounded RPO. No notification target is configured
and no alarm transition/notification delivery test has been performed.
