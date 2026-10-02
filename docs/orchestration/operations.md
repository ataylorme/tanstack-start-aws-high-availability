# Operational lifecycle, maintenance, and growth

[Architecture](architecture.md) · [Cookbook](development.md) · [Versioning](versioning.md) · [Runbook](../orchestration-poc.md)

This is an operating model and maturation checklist. Items marked **required for production** are recommendations, not claims that the POC already implements them.

The contributor guide includes a [long-term risk register](../../CONTRIBUTING.md#design-for-years-of-operation) and a [proposed 24-hour approval expiry policy](../../CONTRIBUTING.md#proposed-default-approvals-expire-after-24-hours). These are design requirements to implement, not current POC guarantees.

## Own the lifecycle, not only the handler

| Phase | Owner's responsibility | Evidence to retain privately |
| --- | --- | --- |
| Design | Define success, approval scope, failure/compensation policy | Contract and threat-model review |
| Develop | Test pure logic, engine behavior, adapter boundaries | Targeted tests and fixtures |
| Release | Verify old/new compatibility and IAM diffs | Source revision, image digest, change set, compatibility matrix |
| Operate | Monitor business waits and transport health separately | Run/operation/event correlation and alerts |
| Recover | Diagnose ambiguous effects before retrying | Before/after observations and authorized repair decisions |
| Evolve | Retain handlers/readers for historical data | Migration checkpoint and rollback envelope |
| Retire | Stop new admissions, drain waits/effects, archive, then remove | Inventory proving no supported references remain |

A platform team owns runtime, persistence, delivery, security, and upgrade procedures. Domain teams own task semantics and integration reconciliation. Each subscriber needs its own accountable owner. One image does not imply that every developer needs permission to repair production state.

## Release: one artifact, multiple roles

The POC builds one digest-pinned image and applies it to six Lambda roles. That removes separate dependency graphs and packaging drift, while IAM still separates public admission, orchestration, and execution.

**Updates across functions are not atomic.** During deployment, old and new roles can coexist; an in-flight invocation can finish on old code. The shared image is a release unit, not a distributed transaction. New API requests, executor commands, events, and stored records must remain compatible across the overlap window.

Before deploying:

1. Run the contributor validation commands, including persistent-store tests.
2. Review changes to persisted contracts and identify supported historical versions.
3. Confirm target identity, IAM, and stack ownership; retain private backups/evidence as appropriate.
4. Review the change set for unintended replacement/deletion. The POC script rejects these on updates.
5. Decide how to stop new admissions if rollout must be paused; the POC has no dedicated maintenance-mode product control.
6. Verify the old image can read any records the new release may write before declaring image rollback safe.

After deploying, verify all six roles use the intended digest, authentication boundaries hold, a new task works, a paused old task resumes, and a completion event reaches its independent consumer. Check queue age and DLQs, not just HTTP health. Health endpoints do not prove that the full workflow is making progress.

For commands and secret handling, use the [runbook](../orchestration-poc.md). Public docs should not become a deployment inventory.

## Diagnose "why is this task stuck?"

Start with task ID, business state, reason, last durable event, and expected next actor. Then follow the corresponding delivery path. Do not begin by randomly retrying Lambdas.

| Observation | Inspect next | Safe interpretation/action |
| --- | --- | --- |
| `queued`, no plan | Stream/router errors, wakeup queue age, worker mapping, leases | Work was admitted; verify a wakeup can reach a worker |
| `planning` for too long | Worker logs, provider read timeout, lease status | A read or worker may have failed; determine whether recovery is scheduled |
| `awaiting_approval` | Exact plan, pending approval, accepted inbox | Human wait may be healthy; an accepted decision can still await processing |
| `scheduled` | Approved time, persisted timer, Scheduler delivery, queue age | Check UTC and late approval; timer delivery is not a precision SLA |
| `executing` | Executor invocation, receipt, target lock, provider state | Do not repeat the effect until the previous outcome is understood |
| `blocked` | Structured reason, approved plan, operation state | Business/safety intervention is needed; blind retry may be inappropriate |
| `failed` | Durable error, attempts, transport versus business failure | Workflow failure alone does not establish whether an external effect occurred |
| `succeeded`, subscriber missing | Publication intent, event store, relay queue, SNS/subscriber DLQ | Repair delivery; do not create another deployment to regenerate an event |

Current `TaskView.release` comes from the serving process's `RELEASE_ID`; it is not a per-step record of which historical image executed each event. For production, record execution version/image provenance in dedicated audit fields rather than inferring it from today's API response.

## Recovery policy by failure class

### Transient dependency failure

Retry with bounded exponential/fixed backoff as appropriate, but calculate the whole budget: SDK retry attempts × request timeout, workflow attempts, queue visibility, Lambda timeout, and lease ownership. Avoid retries at every layer multiplying into a request storm. The POC uses different SDK budgets for executor invocation and effect calls; changing one requires reviewing the others.

### Accepted input, lost response

Retry the same request/decision identity. Do not create a second task because the client timed out. Inspect the durable inbox/history if acceptance and processing disagree. The application deliberately avoids a second independent approval-row write that could diverge from workflow acceptance.

### External effect, uncertain receipt

Read the operation record, lock, approved plan, actual target state, and provider audit evidence. The POC may reconcile an `applying` operation if the target matches its known before/after values. An uncertain blocked operation deliberately keeps the target lock.

**Never delete that lock merely because it is old.** A production repair action needs authorization, evidence, an expected record revision/conditional write, an audit event, and tests. The POC does not ship an automatic repair endpoint or blanket unlock command.

### Consumer outage or poison message

Restore the consumer, verify its permissions and payload/version compatibility, and redrive only inspected messages. Preserve stable business/event identities. For FIFO consumers, respect ordering when reporting a partial batch failure; skipping a failed predecessor can violate business ordering assumptions.

A mapping's `Disabled` control-plane state is not proof that every poller/in-flight invocation has stopped. The live POC verifier uses a settling interval before its outage assertions. Production maintenance should account for all invocation budgets and verify quiescence; do not treat that POC interval as a universal AWS guarantee.

### Outage beyond delivery retention

Streams and queues have finite retention. DLQ records may not contain the full original business payload. A durable run remaining in the database does not by itself prove that a wakeup still exists.

**Required for production:** a bounded, observable reconciliation process that finds stranded runnable tasks and undrained effects, repairs missing delivery intent through supported APIs, and avoids re-executing completed business operations. Define its coverage, cost, scan/index strategy, and maximum recovery time. The current POC is demand-driven and has no unattended full reconciliation/DLQ-redrive service.

### Database restore / regional disaster

Restore to isolated storage first. Inventory restored run states, receipts, approvals, effects, and externally completed operations before enabling workers. Restoring an older database can make a completed real-world operation appear pending. Receipt retention and provider idempotency horizons must cover the restoration window, or human reconciliation is required.

Test restoring **both** workflow and operation state consistently. A single-region POC is not an HA or disaster-recovery guarantee. Define and exercise RPO/RTO before claiming one.

## Monitoring and alerts as the project grows

The POC has Lambda/queue/DLQ alarms and retained logs but no configured alert destination. Required production additions include:

- Actionable paging/ticket routing, ownership, severity, and runbook links.
- Admission-to-plan latency, approval-to-execution latency, scheduled lateness, execution duration, and completion-event delivery lag.
- Separate intentional human wait from stuck runnable work.
- Counts/age of uncertain locks, blocked operations, exhausted retries, undrained effects, and DLQ messages.
- Correlation across task ID, operation ID, event ID, workflow version, deployment revision, and provider job ID.
- Structured logs with redaction; durable audit trails for approvals and repairs.
- Avoid task IDs as unbounded metric dimensions; use them in logs/traces.

Define service objectives around user outcomes, not only Lambda error rates. A silent missing wakeup can produce no function error while still violating the service objective.

## Security before production access

Replace shared demo tokens with SSO and server-verified identities. Enforce target/account/environment-specific authorization, requester/approver separation where required, approval expiry/revalidation policy, least-privilege execution roles, and audited break-glass procedures.

Also address rate limits, abuse protection, input size limits, secrets management/rotation, webhook signatures/replay protection, tenant isolation, artifact/log access controls, and data classification. Never derive an execution role or AWS target directly from untrusted input without authorization.

The existing two-role demo is useful for exercising gates, not a production access-control model. A public URL with a bearer token is still an internet-exposed application.

## Growth: change the limiting boundary, not everything

| Pressure | Next design step | Avoid |
| --- | --- | --- |
| More task types | Explicit task registry, versioned contracts, module ownership | A generic plugin system before concrete requirements |
| More independent targets | Per-target serialization/fencing and fair scheduling | Simply increasing the current executor concurrency |
| Long builds/deployments | Dedicated runners; durable start/wait/reconcile adapters | Keeping a Lambda invocation alive for a build |
| Many tenants/accounts | Authorized target inventory, scoped roles, quotas, tenant-aware keys | Global keys or caller-selected role ARNs |
| Large histories/artifacts | Bounded runs, artifact references, designed continuation | Raising every limit indefinitely or logging entire builds as steps |
| More list/search traffic | Paginated read model/index with rebuild strategy | Treating the current bounded task list as an enterprise search API |
| Independent team release cadence | Versioned interfaces; selectively split service/artifact ownership | Splitting every function into a repository |
| Stronger availability needs | Explicit cross-region consistency, fencing, failover and restore design | Assuming the separate HA lab makes this POC multi-region |

The configured history budget is 256 events / 1 MiB per run. Treat this as an application limit to design around, not an invitation to expand a deployment into thousands of tiny steps. Store immutable large artifacts elsewhere and keep their integrity/authorization references in the plan.

## Maintenance cadence

- **Every release:** compatibility tests, least-privilege review, rollback envelope, private evidence, documentation changes.
- **Regular operations review:** aged waits/locks, queue lag/DLQs, alarms, costs, quotas, credential hygiene, and retained storage.
- **Dependency upgrades:** review adapter release notes/source changes, compare persisted key/item layouts, run old-history fixtures and real-store recovery tests, then stage a rolling deployment. A lockfile update alone is insufficient.
- **Periodic drills:** process interruption at effect/receipt boundaries, queue outage, lost callback, failed migration, restore, and operator handoff.
- **Retirement:** stop admissions, resolve or deliberately preserve pending approvals, drain outboxes/subscribers, archive under policy, and remove handlers only after the supported replay/restore horizon has passed.

The adapter is pinned to an experimental release. Allocate ownership for upstream tracking, bug fixes, compatibility testing, and a replacement/migration strategy. This is part of the cost comparison with a managed orchestrator.

## Production-readiness gates

1. **Internal pilot:** a small authorized user group, bounded targets, one real integration, visible ownership, tested manual recovery.
2. **Production operations:** enterprise auth/audit, safe ambiguous-outcome handling, automated reconciliation, reliable paging, backup/restore drills, versioned migrations, load/soak testing.
3. **Broader platform:** tenant fairness and isolation, integration contract tests, pagination/read models, per-target concurrency, retention governance, independent subscriber lifecycle, documented upgrade/deprecation policy.

Passing unit tests or successfully provisioning stacks does not waive these gates. Conversely, not needing all enterprise capabilities on day one is a reason to stage investment—not to abandon a cohesive application prematurely.
