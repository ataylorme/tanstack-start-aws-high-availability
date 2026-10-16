# Native integration gates (not implemented)

Automatic writable regional promotion remains disabled. These are concrete
requirements for completing the experiment, not an activation recipe. The
[supported-extension review](ASSESSMENT.md#supported-extension-review) found no
suitable hook in the pinned runtime; a fork is outside the allowed scope.

## Regional execution/storage authorization

The MRSC item is a routing hint to the current Worker; it does not replace native
S3 node ownership. Independent buckets can independently authorize the same cell.
A complete integration needs a pinned native authorization provider shared by HTTP,
WebSocket messages, internal/RPC calls, workflows, alarms and background tasks.

Required boundaries:

1. Bind the trusted native cell identity to the exact versioned canonical routing
   key/shard. Native `idFromName` hashes are not reversibly equivalent to the
   application's raw canonical path. Reserved Workflow cells and cross-object
   calls need explicit stable bindings; viewer epoch/shard headers cannot register
   authority. Reject ambiguous bindings and mixed routing versions.
2. Acquire/renew only through expected-state MRSC conditional writes. Read from
   explicit replica endpoints. Record lease/epoch and a bounded clock-uncertainty
   assumption. A failed or late renewal cannot extend authority by local optimism.
3. Enforce revocation below request admission: transaction/output gates, cell
   activation, durable segment submission and background dispatch must consume
   the same authority. Distinguish temporary local staging from an authoritative
   committed mutation; a successful preflight lookup alone proves neither.
4. Stop/cancel outstanding execution before a replacement becomes writable.
   Process pauses, native SQLite calls, buffered frames, pending subrequests and
   external effects must be included. Establish the barrier under actual failure,
   not only by setting directory status or changing an ALB route.
5. Durable progress may move `ACTIVE → FENCING → RECOVERING → ACTIVE` only after
   barrier and recovery evidence. Controller restarts resume the recorded
   transition; they cannot infer success from a timeout, expired routing cache,
   copied owner record or healthy replacement process. No activation endpoint is
   exposed by the current metadata operator.
6. Quorum loss and uncertain clocks fail closed. Old-primary rejoining requires
   isolation and reseeding; credentials, native epochs and replication namespaces
   must not let delayed old work become the promoted authoritative history.

An ordinary Worker wrapper cannot prove these native properties. A supported
native authorization extension and adversarial execution/storage tests would be
necessary before claiming them. The experiment must not fork celld; internal Rust
traits that require rebuilding a modified runtime do not meet that constraint. The local pause drill validates only the pinned native node lease
within one bucket; it is not an MRSC regional fence.

## Recovery validation and import

The archive tool pins individual source versions, validates copied bytes, and
commits a frozen manifest after all selected objects verify. This does not make a
live multi-object listing atomic or include follower-disk logs not uploaded yet.
Source owner/node/waker/fleet records are forensic evidence, not destination
permission. Alarm discovery entries and recovery log metadata remain part of the
recovery inventory.

`celld cell gc --dry-run` is **not a restore validator**. Pinned v0.6.2 can turn
restore-plan errors into no report. Synthetic read-only fixtures demonstrated
successful CLI exit with missing LTX history and corrupted LTX bytes. No archive
or serving object was changed by those probes.

The supplementary offline verifier uses the pinned runtime's decoder library and
upstream dependency lock. It checks full LTX payloads (including decompression,
page/index/trailer/checksum), rejects deliberately corrupted payloads, reconstructs
snapshot SQLite images into new local files, and checks SQLite integrity. A
laboratory acknowledgement ledger permits exact operation-ID/sequence/value
comparison instead of treating a plausible final value as recovery evidence.
The verifier also decodes bundled L0 recovery logs, validates their per-cell
epoch/TXID metadata and full payloads, stages an isolated filesystem replica, and
uses the pinned library's epoch-chain planner/restore implementation. In the
deployed lab dataset, looking only under `cells/.../ltx/` missed newly acknowledged
history that was present in bundles. Six offline cell images passed SQLite
integrity checks after both sources were included. Missing-base/middle fixtures
were rejected; a continuous missing-newest-tail fixture restored successfully but
failed external acknowledgement comparison. None of these probes starts actors
or authorizes importing source ownership.
A stale archive can pass checksum/integrity checks while missing newer acknowledged
commands; the negative probe detects this explicitly.

The executable `verify-bootstrap.ts` probe now exercises the unmodified pinned
`celld-logic` decision core, rather than duplicating its epoch math. An absent
owner produces `CasGuard::Absent`, epoch 1, and `RestoreSpec.fresh=true` after an
applied CAS observation. A genuinely released epoch-7 record produces a
version-matched epoch-8 claim and non-fresh restore. CAS rejection emits no immediate restore
or runtime-start effect; exhausted epochs do not wrap. Independent cores given
independent absence observations both propose epoch 1. These are deterministic
offline slices with node leases explicitly disabled, not actual storage CAS,
production execution, two-region commit evidence, or a native import API.

This makes the import boundary concrete: removing source ownership is not enough
to establish a destination epoch floor, and merely copying its node identity is
not authorization. A supported importer must validate the complete history and
establish a new destination-owned bootstrap floor through an explicit native
operation, while the destination remains unwritable. The existing release path
explains how native epochs advance; it does not authorize fabricating a released
record or bypassing regional fencing. No such serving record is written here.

`verify-cross-epoch.ts` exercises native epoch-chain selection over synthetic
copies of checksum-verified archived payloads. It checks the selected spans as
well as SQLite integrity and exact historical operation records. Continuations,
skipping an incomplete intermediate epoch and clipping an old epoch's late tail
restore correctly; missing base/link reject explicitly, while a missing newest
epoch requires the external ledger to detect loss. This is not a deployed
cross-epoch disaster drill. The file-based `EpochChain` library does not read
`retired.json` or folded node-log state: those records influence native bundle
coverage, repair and garbage collection separately. Therefore its success cannot
validate retirement provenance or complete fleet recovery, and this probe does
not authorize fabricating or copying retirement/ownership records.

The read-only completed-approval laboratory probe additionally checks the native
Workflow metadata, four completed journal steps, consumed approval, exact counter
outputs, retention alarm and captured native wake publication. It requires a
digest-bound reconstructed database and byte-verified archived wake version.
Only the tested V8 wire-15 laboratory values are covered; this does not implement
generic runtime-value decoding, replay, activation or import. Consistent archived
rows do not prove a latest or globally atomic checkpoint.

Still required:

- Select and validate complete cross-epoch restore chains, retirement provenance,
  manifests, deployment assets, wake entries and folded node/log recovery state.
- Reconcile follower-disk tails and external acknowledgements before deciding the
  recoverable high-water mark. Report missing acknowledged operations and dedup
  records; do not silently invent them or claim exactly-once external effects.
- Provide a native epoch-bootstrap/import operation. Missing `own.json` starts a
  new native epoch at 1; blindly copying historical LTX while dropping ownership
  metadata is not a supported import. A new writer must be strictly newer than
  validated imported history, without inheriting source authorization.
- Hydrate on the replacement with writes disabled, verify application state and
  workflow replay/alarms, then publish ACTIVE only after all barriers hold.
- Measure complete recovery/RPO/RTO and socket resynchronization. One successful
  S3 probe or offline SQLite image does not establish those measurements.

## Source anchors

- [Native node/output guarantees](https://github.com/denoland/celld/blob/v0.6.2/docs/guarantees.md)
- [Native restore/GC error handling](https://github.com/denoland/celld/blob/v0.6.2/crates/celld/ltx_repl.rs)
- [GC reporting](https://github.com/denoland/celld/blob/v0.6.2/crates/celld/cell_cli.rs)
- [Full LTX decoder and SQLite snapshot image](https://github.com/denoland/celld/blob/v0.6.2/crates/ltx/src/ltx.rs)
- [Native recovery/restore planner](https://github.com/denoland/celld/blob/v0.6.2/crates/ltx/src/replica.rs)
