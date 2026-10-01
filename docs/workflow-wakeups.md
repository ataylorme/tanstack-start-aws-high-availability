# Demand-driven workflow wakeups

> **rc.1:** See [the current upgrade/feature guide](rc1-lab.md) for unified routing,
> ordered delivery and staged migration. Architecture and validation below describe
> the prior integration where explicitly noted.

Workflow state changes drive regional DynamoDB Stream dispatchers. Due work enters SQS immediately; future work uses automatically deleted, one-time EventBridge Scheduler schedules targeting SQS. Deadlines within 15 seconds use delayed SQS delivery to avoid creating a schedule whose deadline passes during the API call. The existing runtime retains conditional leases and fencing. Regional duplicate wakeups are intentional. Indefinite signal/approval waits do not poll; a committed state transition resumes processing.

Timer precision remains minute-level. Removing idle sweeps does not remove all infrastructure charges.

## Deploy and cut over

Use an authenticated AWS profile and an explicitly selected isolated `STACK_PREFIX`. Never place account numbers, deployed ARNs, endpoints, credentials, or stack identifiers in tracked files. Save deployment manifests and verification reports only under ignored `.deploy/`.

1. Inventory both regional stacks, current rules, streams, and artifacts. Save a rollback manifest without secrets.
2. Run `npm run check`; review deployment change sets. Reject table replacement or unrelated changes.
3. Deploy dispatchers, one-time scheduling, SQS workers, failure handling, and alarms while legacy polling remains enabled.
4. Run the deployment reconciliation command to seed pending workflow state after stream consumers become active. Reconciliation must scan authoritative base-table state, not depend solely on the eventually consistent due index.
5. Disable legacy rules through CloudFormation, then run existing live workflow tests and the recovery checks below. Do not manually sweep to make tests pass.
6. Run idle verification after test work and stale schedules drain. Remove legacy rules and permissions through CloudFormation only after both regions pass.

Set `AWS_PROFILE`, `STACK_PREFIX`, and `EXPECTED_AWS_ACCOUNT_ID` in your private shell environment. The deployment and reconciliation scripts are offline plans unless passed `--execute`:

```sh
node scripts/deploy-workflow-wakeups.ts --execute --legacy=enabled
node scripts/reconcile-workflow-wakeups.ts --execute
node scripts/deploy-workflow-wakeups.ts --execute --legacy=disabled
# Run all validation below, including the idle window, before final removal.
node scripts/deploy-workflow-wakeups.ts --execute --legacy=removed
```

The targeted deployment preserves app images and credentials. Normal full deployments retain an existing stack's legacy mode rather than silently cutting it over. Both dispatchers use the version-pinned workflow package's due-field storage contract; rerun contract/recovery tests when upgrading that package. Workers use default SQS scaling without a maximum-concurrency cap, allowing Lambda’s low-traffic polling optimization. Empty-queue polling does not stop entirely. Bursts can cause redundant shared due-work reads; workflow leases coordinate execution. Re-run abandoned-claim and regional recovery checks after changing scaling. The explicit empty CloudFormation `ScalingConfig` clears previously deployed caps.

## Validation

All commands inherit `AWS_PROFILE`. Supply an HTTPS site URL and token-file path through your local environment rather than committing them.

```sh
node scripts/verify-workflows.ts "$SITE_URL" --execute
node scripts/verify-workflow-recovery.ts "$SITE_URL" --execute
node scripts/verify-workflow-wakeup-recovery.ts --execute
node scripts/verify-workflow-wakeups.ts --idle
```

Recovery verification requires `STACK_PREFIX` and `WORKFLOW_TEST_TOKEN_FILE`. It disables one regional worker's SQS mapping, waits for in-flight work to settle, then proves the other region completes both consecutive sleeps. It restores and waits for the mapping in `finally`, and repeats in the reverse direction. If the process is forcibly terminated, restore the affected mapping using the stack's `WakeupMappingId` output and verify its state is `Enabled`.

Abandoned-claim verification requires `AWS_PROFILE`, `EXPECTED_AWS_ACCOUNT_ID`, and an isolated `STACK_PREFIX`. It creates 12 runs using the public workflow store, claims 45-second execution leases, and abandons them without executing their handlers. It observes one-time schedules in both regions, rejects completion before lease expiry, and verifies all runs recover with exactly two timer resolutions within 240 seconds after the final initial lease expires. Unique fixture IDs are saved before writes; no manual sweeps or fixture deletion occur. Exported CLI credentials remain only in process memory.

Idle verification is read-only. It waits up to 15 minutes for schedules and queues to drain, rejects enabled recurring rules and nonempty processing DLQs, observes a full 15-minute window, then allows three minutes for CloudWatch publication. Do not submit new work during observation. Missing invocation datapoints mean no reported invocations; corroborate deployment/function health through the live tests first.

Also run application-event validation unchanged. Keep final artifact hashes, stack status, alarm state, queue/failure evidence, recovery results, and idle metrics in ignored deployment evidence.

## Recovery and rollback

On a failed cutover, deploy the compatible wakeup template with `--legacy=enabled`; this re-enables or recreates the legacy rules without deleting queues. Use the saved template/artifact manifest if a code rollback is also necessary, but do not restore a pre-wakeup template that would delete the new queues. If necessary disable the new processing mappings, preserving queued messages and durable workflow state. Never delete the table or queues as a recovery shortcut.

Monitor stream iterator age, dispatcher errors, Scheduler delivery failures, queue age, and DLQs. Investigate failures before redriving. Reconcile authoritative pending state after a prolonged outage: DynamoDB Stream records expire after 24 hours, so removing periodic sweeps makes this an explicit operator responsibility. The reconciliation command must be safe to repeat and preserve deterministic wakeup deduplication. Redrive archived stream failures or queue DLQs only after their underlying cause is fixed.
