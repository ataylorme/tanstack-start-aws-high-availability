# Development cookbook

[Architecture](architecture.md) · [Contributing](../../CONTRIBUTING.md) · [Operations](operations.md) · [Versioning](versioning.md)

Examples below distinguish **existing executable behavior** from **proposed extension patterns**. The POC only implements a sandbox capacity change. It does not already implement deployment workflows, a generic task registry, external webhook authentication, or production subscriber deduplication.

## 1. Start with the business contract

For a proposed task, answer these questions before choosing an event or queue:

- What constitutes success? What may remain pending after success?
- Who can request it, approve it, and repair it?
- Which exact target and proposed changes does approval authorize?
- What can change between planning and execution?
- Can the external effect be retried with the same operation ID?
- How can we determine whether an ambiguous request succeeded?
- What is the timeout, cancellation, and compensation policy?
- Which outcome events are useful to independent consumers?

For capacity changes, success means the approved target's capacity was observed at the requested value and an execution receipt was committed. SNS delivery is independent. A deployment may need additional health checks before its equivalent success event is valid.

## 2. Trace the existing workflow

Read [`workflow.ts`](../../src/orchestration/workflow.ts) first. Its important shape is:

```ts
// Excerpt from the existing handler; ctx and ports are provided there.
const input = parseInput(ctx.input)
const plan = await ctx.step('plan', async () => {
  const data = {
    taskId: ctx.runId,
    target: ports.target,
    before: await ports.readCapacity(),
    after: input.desiredConcurrency,
    executeAt: input.executeAt,
    workflowVersion: 'v1' as const,
  }
  return { ...data, hash: hash(data) }
}, { retry: { maxAttempts: 3, backoff: 'fixed', baseMs: 250 } })
```

The port returns a small serializable value. The plan captures the target and observation **once**. The hash binds the proposal the approver sees. Changing `hash()` or property ordering is not innocuous: this implementation hashes `JSON.stringify` of a constructed object, not arbitrary canonical JSON. Preserve old hash verification for old plans.

After `ctx.approve`, the handler checks the actor and exact plan hash, respects rejection, calls `ctx.sleepUntil`, then calls the executor through the `execute` step. Finally it validates the receipt and calls `publishWorkflowEvent`.

Do not simplify away the receipt checks. A successful HTTP/Lambda invocation is not proof that the correct task, target, plan, and values were executed.

## 3. A runnable workflow test without AWS

The complete [executable documentation test](../../tests/orchestration-docs.test.ts) uses the actual workflow and engine. This is the useful seam:

```ts
import { capacityWorkflow } from '../../src/orchestration/workflow'

// A fake port is ordinary TypeScript, not a fake state machine.
const workflow = capacityWorkflow({
  target: 'sandbox-test',
  readCapacity: async () => 1,
  execute: async taskId => {
    // In a test, return a receipt matching the plan recorded by the workflow.
    // In production, invoke the isolated executor; never fabricate a receipt.
    throw new Error(`Supply the test receipt for ${taskId}`)
  },
})
```

The import path above assumes a file under `docs/orchestration/`; the linked test has repository-correct imports and a complete receipt implementation. The test creates an in-memory store, runs until approval, replaces the runtime, approves the saved plan, advances timers through a sweep, and verifies the completion-event intent.

Important difference: `runtime.startRun` in a unit test is convenient for driving the engine. The **public API uses `store.createRun`**, leaving execution to the worker. Do not copy the test's direct runtime execution into the HTTP admission path.

Likewise, in-memory engine tests are not proof that production inbox acceptance is atomic. The real-DynamoDB Local tests exercise `store.deliverApproval`, competing decisions, restart, claims, and committed-effect draining.

## 4. Add or change a task deliberately

For a new task type such as a deployment:

1. **Contracts:** define versioned input, immutable plan, execution receipt, and terminal outcomes. Add strict runtime parsers for incoming and persisted data.
2. **Admission:** extend the API explicitly with a task-type discriminant or a separate route. The current API only accepts capacity requests and hardcodes its workflow ID/version; adding a workflow module alone does not expose a new task.
3. **Idempotency:** normalize inputs before hashing, scope request IDs by authenticated actor/tenant, and distinguish retries from new intent. Keep conflict responses deterministic.
4. **Plan:** capture the exact target, artifact/version, relevant observed state, policy version, and execution window. Large plans/logs belong in immutable external artifacts with integrity references, not unbounded history events.
5. **Approval:** bind the decision to that plan. Derive the actor server-side; never accept caller-supplied actor names as authorization.
6. **Execution adapter:** give it only task/operation identity, reload authorization, and implement the integration-specific receipt/reconciliation protocol.
7. **Registration:** register the workflow and retained historical versions. Update projection/parsers so old and new results remain readable.
8. **Transport/security:** add only the permissions, routes, queues, or callback authentication actually needed. Update infrastructure tests.
9. **Events:** publish a versioned fact only after required business verification. Document consumer obligations.
10. **Tests/operations:** cover faults, historical tasks, diagnostic reasons, and recovery. Add a runbook before adding production privileges.

Do not widen the current executor's `target` check to "any Lambda" and call that a generic execution platform. A general platform needs server-owned target inventory, account/tenant authorization, policy evaluation, and integration-specific safety contracts.

## 5. Commands and client retries

The existing browser client is reusable by other TypeScript clients:

```ts
// Assumes this runs in a client that already obtained an authorized token.
const client = createOrchestrationClient(token, serviceOrigin)
const key = crypto.randomUUID() // Generate once for this intended request.
const input = { desiredConcurrency: 3 }
const task = await client.create(input, key)
// If the response is lost, retry client.create(input, key), not a fresh key.
```

The server accepts or returns the same task. A timeout does not tell the caller whether admission committed. Reusing the key lets the server answer that question. A changed request under the same key returns a conflict rather than silently changing the existing plan.

Generate a fresh key only for a genuinely new operation. Persist it across client restarts if the product promises restart-safe retries; the current browser only keeps its submission key in memory. A CLI or webhook adapter needs its own durable request identity strategy.

## 6. External effects: the failure window that matters

Consider:

```text
send deployment request -> provider starts deployment -> connection drops
```

Retrying might start a second deployment. Recording "done" before sending might lose the deployment entirely. A local transaction cannot encompass an unrelated provider's API.

Prefer, in order where available:

1. Provider-supported idempotency keys tied to a stable operation ID.
2. Conditional/versioned writes with a known prior revision.
3. A provider job ID and queryable status, durably associated with the operation.
4. Reconciliation against a uniquely identifiable desired state.
5. An explicit blocked/manual-review state when the outcome cannot be safely inferred.

The existing executor transaction creates an `applying` operation and a target lock before the effect; completion commits a receipt and releases the lock. A retry first inspects existing state. It is a reference for one operation, not a universal exactly-once implementation.

A compensating action is a **new authorized business action**, not a database rollback. Rolling back a deployment may fail or be unsafe after other changes. Preserve the original receipt and record compensation separately.

## 7. Publish business events using the committed-effect path

Existing code uses this pattern after checking the executor receipt:

```ts
await publishWorkflowEvent(ctx, 'completion-event', {
  id: `success-${ctx.runId}`,
  type: 'devops.task.succeeded.v1',
  version: 1,
  timestamp: receipt.completedAt,
  correlationId: ctx.runId,
  data: receipt,
})
```

This records a publication intent inside durable workflow history. The worker drains the intent to the application-event store; the stream/router/queue/relay deliver it. Do not replace this with a direct `sns.send()` call after marking the run complete: a crash between those operations can lose the notification.

The current ID assumes **one success event per run**. For workflows emitting many similar events, define stable IDs including an occurrence or operation identity. Reusing one ID for unrelated facts can suppress legitimate events; random IDs on each retry can defeat deduplication.

Events should carry stable identifiers, a version, a business timestamp, correlation information, and enough facts for their contract. Do not publish secrets, entire internal history, or arbitrary raw provider responses.

## 8. Build an independent subscriber

**Proposed pattern, not implemented by the observation queue:**

```ts
interface CacheInvalidationPort {
  // Adapter must honor stable identity or reconcile provider state.
  invalidate(input: { operationId: string; deploymentId: string }): Promise<void>
}

async function handleDeploymentSucceeded(
  event: { id: string; deploymentId: string }, // Already runtime-validated.
  cache: CacheInvalidationPort,
): Promise<void> {
  await cache.invalidate({
    operationId: `cdn-invalidation:${event.id}`,
    deploymentId: event.deploymentId,
  })
}
```

This illustrates the contract boundary, not a completed deduplication store. The adapter must implement the comment's guarantee. Adding `if (!seen) { callProvider(); markSeen(); }` still has a crash window; marking seen first has a different loss window.

A real subscriber needs:

- Its own queue, IAM, DLQ, owner, retry budget, and alerting.
- Validation of event type/version/source and payload; TypeScript types do not validate queue bodies.
- A stable event identity and durable effect receipt or provider idempotency strategy.
- A poison-message policy and partial-batch failure handling consistent with FIFO ordering.
- A replay/redrive plan with retention long enough for the supported redelivery window.
- Contract tests against producers and historical event fixtures.

Use a separate queue per independent consumer. Multiple consumers of one queue compete for messages; that is work sharing, not broadcast. Do not let an external subscriber mutate workflow history directly. If it must report a required result, define an authenticated command/signal endpoint and correlate it with the pending operation.

## 9. Test at the right layer

| Layer | Tool/seam | Proves | Does not prove |
| --- | --- | --- | --- |
| Domain | Vitest + pure parsers | Validation, hashing, union behavior | Persistence or authorization in AWS |
| Workflow | Real engine + fake ports | Sequence, approval gates, replay, publication intent | Cloud delivery or atomic adapter behavior |
| AWS adapter/executor | `aws-sdk-client-mock` | SDK inputs, error/reconciliation branches | IAM, real transactions, provider semantics |
| HTTP integration | `nock` + client | Headers, stable keys, conflicts, response parsing | Live TLS/network or browser behavior |
| Persistent integration | DynamoDB Local | Conditional writes, inbox races, restart and recovery | IAM, streams/Scheduler/SNS transport |
| Infrastructure | Template assertions + `cfn-lint` | Role/resource boundaries and template validity | Actual deployment correctness |
| Live acceptance | Isolated AWS POC | Real wiring, identity, timers, adapter behavior | Every crash boundary or enterprise readiness |
| Browser | Live/local interaction | Input behavior, polling, roles, console errors | Durable consistency by itself |

Test the failure boundary immediately after the external effect and before receipt persistence. Also test response loss after approval acceptance, duplicate deliveries, concurrent conflicting decisions, stale plans, disabled consumers, poison messages, and historical-version resumption.

Mocks should fail on unexpected calls. Assert that rejection causes **no effect**, and that transport failure causes **no repeated business effect**, not merely that a promise resolves. Keep live tests opt-in and constrained to owned resources.
