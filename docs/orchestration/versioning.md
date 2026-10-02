# Workflow evolution, historical tasks, and schema migrations

[Architecture](architecture.md) · [Cookbook](development.md) · [Operations](operations.md) · [Contributing](../../CONTRIBUTING.md)

A deploy replaces code. It does not replace the meaning of approvals, receipts, and events already persisted. A task can outlive many application releases. Treat compatibility as a feature of the platform, not an emergency discovered during rollout.

This document is a migration **design and review procedure**. The POC does not ship a general migration runner, online history rewriter, cancellation API, or automatic workflow-version upgrader.

## There are several different versions

| Version | What it identifies | Where the current POC stands |
| --- | --- | --- |
| Artifact/release | The deployed code image | One digest across six roles, with a non-atomic rollout window |
| Workflow definition | The replay/control-flow implementation for a run | Workflow ID `capacity-change-v1`, explicit version `v1` |
| Business data schema | Meaning/shape of input, plan, receipt, projection | Mostly implicit v1 shapes; plan includes `workflowVersion` |
| Event contract | What subscribers may interpret | Event type `devops.task.succeeded.v1`, envelope version `1` |
| Adapter storage format | Keys, item layouts, indexes, inbox/lease/effect records | Pinned experimental adapter version |

Do not use one version string as a substitute for all five. A UI-only release may change none of the contracts. An adapter upgrade may change persistence behavior without changing business input. A subscriber schema change may need coexistence even after all old workflows finish.

## Decide what kind of change you are making

| Change | Likely treatment | Required evidence |
| --- | --- | --- |
| CSS, wording, additive UI projection | Keep workflow version if persisted behavior is untouched | UI/regression tests; old records still render |
| New optional business field | Tolerant readers/default policy, then compatible writers | Historical fixture tests, including omitted field |
| Different plan meaning, target selection, hash algorithm, approval policy | New explicit schema/definition contract | Old approval remains bound to old plan; new policy reviewed |
| Rename/reorder durable steps or add a wait/branch | Usually a new workflow version | Paused histories resume with their original definition |
| Rename persisted field or change units/type | Versioned reader/upcast or staged migration | Old/new readers and rollback compatibility matrix |
| New external event meaning | New event contract/version with transition period | Consumer contract/replay tests |
| Adapter key/index/lease change | Adapter-specific migration and staged rollout | Real-store mixed-version, recovery, and restore tests |

"It compiles" does not prove any of these safe. A bug fix can still change replay semantics. Conversely, do not version every cosmetic edit: describe the compatibility reasoning in the PR.

## Keep historical workflow implementations executable

The runtime supports registering older loaders. The existing [real-store compatibility test](../../tests/orchestration-local.test.ts) exercises this shape:

```ts
// Registration excerpt; store, v1Loader and v2 are defined by the application.
const runtime = defineWorkflowRuntime({
  store,
  workflows: {
    [WORKFLOW_ID]: {
      version: 'v2',
      load: async () => v2,
      previousVersions: { v1: v1Loader },
    },
  },
  defaultLeaseMs: 60_000,
})
```

The [executable documentation test](../../tests/orchestration-docs.test.ts) also verifies that the incompatible v2 handler is not used for a persisted v1 task.

A complete upgrade needs more than this registration:

- Preserve the original v1 implementation and behavior of every helper it calls. A v1 loader that imports a silently changed shared planner is not truly frozen.
- Keep parsers, projection readers, approval interpretation, executor routing, and event handling compatible with v1 plans/receipts.
- Update admission deliberately. `api.ts` currently writes `workflowVersion: 'v1'`; changing the registry default alone does **not** admit v2 runs.
- Review all v1-specific assumptions in `types.ts`, `parsePlan`, `approvedPlan`, and the executor. They intentionally reject unsupported versions today.
- Keep the same logical workflow ID if using `previousVersions`. Although the existing ID itself ends in `-v1`, changing that ID creates a separate registry identity rather than upgrading its registered version.
- Ensure old workers cannot accidentally claim new unsupported runs during rollout. Use a compatible bridge release, controlled admission, or explicitly version-routed workers if required by the adapter. Do not assume old binaries understand a future version.

A safe staged sequence is: deploy code that understands both versions while continuing to admit v1; verify all relevant roles; enable v2 admission; retain v1 loaders/readers for old work. Removing v1 support is a separate, later release.

## Compatibility means more than active tasks

Inventory at least:

- Queued/running/paused tasks and their persisted workflow versions.
- Pending approvals, including old immutable plans and decision inboxes.
- Timers, retries, leases, and scheduled wakeups.
- Applying/blocked/succeeded operation receipts and target locks.
- Undrained workflow publication intents and application events awaiting transport.
- Queue/DLQ messages, external callbacks, and subscriber replay windows.
- Terminal tasks still needed by UI, support, audit, or idempotency.
- Backups/archives that operators are authorized to restore or replay.

Do not derive this inventory from the current dashboard's bounded list of 100 runs. Use a paginated administrative inventory with explicit consistency/reconciliation considerations. The POC does not yet supply that product capability.

Historical tasks do not all need to remain executable forever. Separate **execution support**, **read/audit support**, and **restore/replay support**, and publish a retention/deprecation policy for each.

## Evolve business schemas with tolerant readers

Prefer explicit discriminants for new stored schemas. For already-existing unversioned records, identify the legacy shape narrowly; do not classify every unknown object as v1.

Example policy for a **new, illustrative metadata record**, not an instruction to rewrite existing approved plans:

```ts
type RequestMetadata =
  | { schemaVersion: 1; requestedBy: string }
  | { schemaVersion: 2; requester: { id: string; kind: 'user' } }

type CurrentMetadata = Extract<RequestMetadata, { schemaVersion: 2 }>

function upcastMetadata(value: RequestMetadata): CurrentMetadata {
  if (value.schemaVersion === 2) return value
  return {
    schemaVersion: 2,
    requester: { id: value.requestedBy, kind: 'user' },
  }
}
```

A real persisted-data reader must first validate `unknown` data, reject unsupported versions, and distinguish malformed data from absent optional fields. This example assumes validation has already occurred. Upcasting creates a current **read model**; it need not mutate the source record.

Do not invent authorization facts while upcasting. For example, assigning a new policy-approved status, tenant, or privileged identity as a default could change the meaning of a historical decision. Keep provenance and expose "unknown legacy value" where that is the honest answer.

### Special rule: approved plans and hashes

The current approval authorizes a hash of a specific serialized plan. Renaming a plan field, adding a hash-covered field, changing number/date normalization, or changing serialization can invalidate that hash.

- Validate an old plan using its original schema and hashing rules.
- Keep the approved bytes/meaning immutable; derive display models separately.
- Never recompute the old hash with new rules and silently attach the old approval.
- If execution semantics must change, create a new plan and obtain new approval through a designed transition. Link old/new tasks for audit.
- The current POC has no general cancel/replan transition API. Implement and test one before using it as an operational migration tactic.

## Expand → migrate → contract

For an owned, mutable application schema, a typical rollout is:

1. **Inventory and backup:** estimate volume, identify all readers/writers, classify active versus terminal data, and rehearse restore.
2. **Expand readers:** release readers accepting both old and new representations. Keep writers compatible with rollback targets.
3. **Expand storage/indexes:** add required structures through explicit deployment/admin work. Do not run migrations on every HTTP request or worker invocation.
4. **Switch writers:** only after readers and execution roles are ready, write the new representation/version.
5. **Backfill deliberately:** run bounded, resumable batches with throttling, checkpoints, and conditional writes. Store migration identity and progress privately.
6. **Verify:** compare counts and invariants; inspect rejected/malformed records; exercise old approvals and new admissions; validate undrained effects.
7. **Observe:** retain compatibility for the maximum supported task, queue, audit, and restore/replay horizon.
8. **Contract:** stop old writes, remove obsolete indexes/fields/readers only after measured inventory permits it. Treat destructive changes as separately reviewed operations.

Do not scan-and-overwrite a live item based on a stale read. Condition writes on an expected revision or the exact old schema/state, and skip/reconcile conflicts. Repeating a migration batch should be safe; resuming after failure should not depend on process memory.

**Adapter-owned records are different.** The workflow store owns history, pending inboxes, leases, timers, effects, and key/index conventions. Use the pinned adapter's supported upgrade path. Do not improvise a business backfill that rewrites engine records or changes run versions in place. The current direct pending-approval reader in `services.server.ts` is an explicit coupling to that adapter layout and must be revalidated on upgrades.

Upstream describes persistence as an explicit [store contract](https://github.com/TanStack/workflow/blob/main/docs/guide/persistence.md), but its SQL adapter migration instructions are not a migration procedure for this DynamoDB adapter.

## Rollback is a compatibility question

Before releasing, fill in a matrix like this with actual supported/not-supported results:

| Reader/executor | Old stored data | New stored data | Old pending workflow | New pending workflow |
| --- | --- | --- | --- | --- |
| Previous release | Baseline | Must test | Baseline | Usually unsupported unless prepared |
| Bridge release | Must test | Must test | Must test | Supported only if registered |
| New release | Must test | Must test | Retained implementation | New implementation |

If the new release writes data the previous release cannot understand, "deploy the old image" is not a safe rollback. Options include disabling new admissions while keeping a compatible worker release, rolling forward with a fix, or a specifically designed data downgrade. Choose before release, not during an incident.

A database restore does not undo external effects. It may also restore obsolete timers, approvals, locks, and publication intents. Reconcile restored records against the external world before resuming execution.

## Event schema evolution

Producer and consumer releases are independent. For a change:

- Preserve existing field meaning and identity; additive fields still need tests against strict consumers.
- Use a new event version/type for incompatible meaning, not just a renamed JSON property under v1.
- Inventory subscribers and replay sources; consumers must validate and explicitly support versions.
- Use an overlap period or an explicit translation bridge. Do not silently drop unsupported events.
- If dual-publishing old/new contracts, define whether they represent one business fact and how consumers avoid performing the effect twice. Distinct envelope IDs alone do not solve that problem.
- Retain schema fixtures and contract tests for the supported replay horizon.

The POC observation queue is a delivery demonstration, not a schema registry or compatibility enforcement service.

## Retention and retirement

The configured store limits include seven-day terminal retention and thirty-day tombstone retention. These settings are not an enterprise audit policy or proof that cleanup has run. Review adapter cleanup behavior, operation receipts, application events, queue retention, backups, and subscriber deduplication together.

A deduplication record must outlive the supported retry/replay window for the effect it protects. Expiring a receipt while old commands can still arrive can reopen duplicate execution risk. Do not give uncertain target locks a cleanup TTL.

Before removing an old workflow implementation, prove there are no supported nonterminal runs or pending deliveries needing it, and that archival/restore procedures will not resume it without restoring compatible code. Terminal history may still need old parsers after execution support ends.

## Migration acceptance checklist

- [ ] Fixtures from every supported historical schema/state load successfully.
- [ ] A paused old task resumes after upgrade without replanning or changing its approval hash.
- [ ] New tasks select the intended new version; unsupported versions fail visibly and safely.
- [ ] Old/new roles can coexist during rollout, or the controlled transition prevents incompatible claims.
- [ ] Accepted-but-unprocessed decisions and undrained effects survive upgrade.
- [ ] Applying operations reconcile without repeating an unsafe external effect.
- [ ] Backfill interruption, duplicate batch execution, concurrent writers, and malformed records are tested.
- [ ] The rollback matrix is exercised against data written by the new version.
- [ ] Backup restore and delayed queue/callback delivery are considered.
- [ ] Removal of old support is governed by measured inventory and retention policy.

Keep the migration plan, execution checkpoints, and per-record evidence private. Publish the schema contract and sanitized procedure, not real account/target/task inventories.
