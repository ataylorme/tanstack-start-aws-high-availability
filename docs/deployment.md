# Deploying to AWS

**This creates billable, publicly reachable resources in your selected AWS account.**
Use a sandbox account first. The repository does not deploy from CI or assume credentials.

Prerequisites:

- AWS CLI v2, configured credentials (`AWS_PROFILE` is respected), Docker with buildx,
  `zip`, Node 24+, and `npm ci`.
- Permissions for CloudFormation, IAM (including PassRole and the CloudFront/Lambda@Edge
  service-linked roles on first use), ECR, S3, Lambda, CloudFront, CloudWatch and Logs.
- Sufficient regional Lambda concurrency and edge quotas; no VPC is required.
- Commercial AWS partition; regions are intentionally fixed to the requested pair.

For browser-based temporary credentials, use a recent AWS CLI v2 and
`aws login --profile your-sandbox-profile`; a long-lived IAM access key is not required.
Confirm the resulting identity before deployment. Avoid root credentials.

## First deployment

Complete the [local setup and checks](getting-started.md) first. Run commands from the
repository root. Keep the profile and prefix unchanged throughout deployment, verification,
drills, and cleanup. Stack names are reused: choose a unique prefix for each environment.

```sh
export AWS_PROFILE=your-sandbox-profile
export STACK_PREFIX=tanstack-ha    # optional; lowercase, <=40 characters
# Read-only preflight; confirm the account returned is your intended sandbox.
aws sts get-caller-identity
node --version
aws --version
docker info
docker buildx version
zip -v

node scripts/deploy.ts            # offline plan; makes no AWS calls
node scripts/deploy.ts --execute  # explicitly create/update AWS resources
```

The offline plan describes the sequence; it is **not** an AWS CloudFormation change set
or a credential/permission validation. `--execute` performs the deployment. No resources
are created by following the local development guide alone.

### Stack inventory

| Stack | Region | Main resources |
| --- | --- | --- |
| `<prefix>-bootstrap` | `us-east-1` | ECR repository and private S3 edge-artifact bucket |
| `<prefix>-bootstrap` | `us-west-2` | ECR repository |
| `<prefix>-app` | `us-east-1` | Container Lambda, URL, logs, alarms |
| `<prefix>-app` | `us-west-2` | Container Lambda, URL, logs, alarms |
| `<prefix>-global` | `us-east-1` | Lambda@Edge function/version, viewer CloudFront Function, global distribution, alarm |

The script:

1. Runs local validation and smoke checks, then identifies the AWS account.
2. Saves a 256-bit origin secret under `.deploy/<account>-<prefix>/origin-secret` with
   owner-only permissions. **Back it up securely**; updates refuse to silently replace
   a missing key when the stacks already exist.
3. Creates `<prefix>-bootstrap` in each region: immutable-tag ECR; east also has an
   encrypted, versioned, private S3 bucket for edge artifacts.
4. Builds **once** for `linux/amd64`, without multi-architecture/provenance manifests,
   pushes the same image to both registries, and uses regional **digest-pinned** URIs.
5. Deploys `<prefix>-app` in both regions. Function URLs are passed as parameters,
   avoiding cross-region CloudFormation exports.
6. Compiles CommonJS edge code, bundles the two non-secret origin domains in JSON,
   uploads a content-addressed ZIP, strips types from the viewer CloudFront Function,
   and deploys `<prefix>-global` **in us-east-1**.
7. Publishes a numbered Lambda@Edge version using the ZIP hash and waits for CloudFront
   propagation. It runs the live regional verification script and prints the site URL.

## Updates and recovery

Repeated execution updates the stacks with a new release. A deployment is **not atomic**
across regions: old browser bundles/server-function IDs may overlap a new release. Deploy
backward-compatible changes; a production release process should retain old assets and
coordinate application-version compatibility. A partial deployment can leave different
releases active; inspect stack events and rerun after fixing the problem. The script resets
`SimulateFailure=false` in both regions on an application deployment.

Before updating, keep a record of the prior regional `ImageUri` and `ReleaseId` parameters,
plus the global `EdgeCodeKey` and `EdgeCodeSha256`, without exporting the secret. For a
rollback, use CloudFormation to restore matching prior parameters in each affected stack,
preserving the existing `OriginSecret`. Retained ECR images and edge artifacts support
this, but **there is no automatic cross-region rollback command** in the repository.
Checking out old source and rerunning deployment rebuilds it; that is not a bit-for-bit
artifact rollback.

If a deployment is interrupted, inspect all five stack statuses before rerunning. Wait for
in-progress operations to finish. A stack in a failed rollback/create state can require
CloudFormation recovery rather than another `deploy`; do not delete stacks or generate a
new secret merely to bypass that condition. AWS CLI waiters can time out while the AWS
operation continues.

### Origin security: deliberate example tradeoff

Function URLs use `AuthType: NONE`. CloudFront injects the same secret into both origins;
the application's server entry checks it using constant-time comparison before handling
dynamic requests. It fails closed on Lambda if the secret is missing. A viewer cannot
set the effective secret through CloudFront. Authorization, cookies, query strings and
application headers are forwarded; viewer Host is replaced for the Function URL origin.

**This is application-level protection, not IAM origin isolation.** Anyone who learns a
Function URL can still invoke Lambda and incur cost. `/readyz` exposes only readiness and
Nitro-served static assets are public. They intentionally bypass the dynamic request guard.
Principals who can read Lambda configuration or CloudFront origin configuration can read
the secret despite CloudFormation `NoEcho`; restrict those control-plane permissions.
For a hardened deployment evaluate IAM/OAC or a signing design, including POST payload
signatures and dynamic-origin compatibility, rather than assuming this example uses OAC.
Rotate the secret with a coordinated overlap strategy; changing one stack alone breaks
requests until all origins and CloudFront agree. Never commit `.deploy` or paste the key
into command lines, logs, tickets or screenshots.

## Verify active/active and failover

Get the URL from the deploy output or `<prefix>-global` stack's `SiteUrl` output.
Retrieve it without copying a placeholder:

```sh
export STACK_PREFIX="${STACK_PREFIX:-tanstack-ha}"
export SITE_URL="$(aws cloudformation describe-stacks \
  --region us-east-1 --stack-name "${STACK_PREFIX}-global" \
  --query "Stacks[0].Outputs[?OutputKey=='SiteUrl'].OutputValue | [0]" --output text)"
```
A public **demo-only** `X-HA-Region` header selects the preferred region; unknown values
fall back to the link/cookie preference or IP affinity. It can never select an arbitrary origin.
The page’s region links use `?region=us-east-1` or `?region=us-west-2`; the successful
page response sets a session preference cookie for subsequent server-function requests.

```sh
node scripts/verify-deployment.ts "$SITE_URL"
curl -i -H 'X-HA-Region: us-east-1' "$SITE_URL/healthz"
curl -i -H 'X-HA-Region: us-west-2' "$SITE_URL/healthz"
```

The verification script checks SSR plus GET/HEAD/OPTIONS/POST/PUT/PATCH/DELETE on the
side-effect-free health endpoint. With a failed-region argument, it checks read failover
and confirms write methods return 503 from that region rather than being replayed.
Inspect `X-Served-By-Region` and the JSON `region`; both should match the preference.
Open the site in a browser and exercise both server-function buttons. A direct origin `/`
or `/healthz` request without the secret should return **403** (not `/readyz` or assets).

For a controlled drill in a disposable environment, set one region's CloudFormation
`SimulateFailure` parameter. It returns 503 on dynamic requests without changing readiness
or destroying resources. These commands update AWS only with `--execute`:

```sh
node scripts/set-failure.ts us-east-1 true --execute
node scripts/verify-deployment.ts "$SITE_URL" us-east-1
# BOTH preferences should now return us-west-2.
# While east is still failed, this POST must return 503 (no write replay):
curl -i -X POST -H 'X-HA-Region: us-east-1' "$SITE_URL/healthz"
node scripts/set-failure.ts us-east-1 false --execute
node scripts/verify-deployment.ts "$SITE_URL"

node scripts/set-failure.ts us-west-2 true --execute
node scripts/verify-deployment.ts "$SITE_URL" us-west-2
# BOTH preferences should now return us-east-1.
node scripts/set-failure.ts us-west-2 false --execute
node scripts/verify-deployment.ts "$SITE_URL"
```

**Restore the failed region even if a verification command fails.** Wait for each stack
update and any in-flight old execution environments to drain. A real regional failure also
involves networking, DNS, quotas and cold starts; the drill tests HTTP-level failover only.
The POST check above uses a health endpoint with no side effects; it demonstrates
CloudFront's method-specific behavior, not a durable application write.

## Operations and teardown

- Regional application logs use CloudWatch Logs with 14-day retention. Edge logs are
  created in invocation regions, not only us-east-1; configure their retention for production.
- Templates create regional Lambda Errors/Throttles alarms and a global CloudFront 5xx
  alarm. **No notification actions are wired.** Connect SNS/paging before relying on alarms.
  Lambda Errors does not count every application HTTP 5xx; CloudFront's metric sees only
  viewer-visible errors after failover. Add per-origin HTTP monitoring for real operations.
- SSR, health and server functions have caching disabled; errors have zero cache TTL.
  Static assets share that behavior for clarity (not optimal cost/performance). There are
  no cached success responses to disguise regional failures in the drill.
- Expect one CloudFront Function invocation and one Lambda@Edge invocation per uncached
  successful request, an extra origin invocation on failover, application Lambda usage,
  data transfer, image storage,
  logs, alarms, and S3 charges. Budget before public load testing.
- Teardown is intentionally manual/destructive: delete the **global stack first**, wait
  for CloudFront disassociation/edge replication cleanup, then delete regional app stacks
  and bootstrap stacks in both regions. Use the same profile and prefix as deployment.
- **Retained resources still cost money:** ECR repositories/images, S3 bucket/versions,
  regional log groups, and edge function/versions/role are retained. Record physical IDs
  before deleting stacks. After AWS has removed edge replicas (can take hours), manually
  remove the retained edge versions/function/role, regional edge logs and stored artifacts
  you no longer need. Empty all S3 object versions/delete markers before deleting its bucket.
  Retention avoids failed stack deletion while replicated edge versions still exist.

## Troubleshooting AWS

Read stack events before changing configuration. This command is diagnostic only:

```sh
aws cloudformation describe-stack-events --region us-east-1 \
  --stack-name "${STACK_PREFIX}-app" \
  --query 'StackEvents[0:15].[Timestamp,LogicalResourceId,ResourceStatus,ResourceStatusReason]' \
  --output table
```

Use the failing stack and its region; west-region errors are not in the east stack.

| Symptom | Investigation / recovery |
| --- | --- |
| Credential or access-denied error | Check the selected profile/account and failing API in stack events; use your account's approved deployment role |
| Missing saved origin secret | Restore `.deploy/<account>-<prefix>/origin-secret` from secure backup, keep permissions `0600`; do not silently generate a new one |
| Docker push fails through a Docker Desktop proxy | Check Docker daemon networking separately from host AWS CLI connectivity. Retry the same image; do not rebuild independently per region. The initial deployment used host ECR multipart upload to preserve the exact OCI manifest after proxy failures. |
| Image URI/manifest error | Confirm the digest belongs to ECR in the same region as Lambda, built for `linux/amd64` with provenance disabled |
| Site returns 403 | Check both Function URL permissions and that CloudFront and both Lambdas use the same secret; do not log or paste it |
| Site returns 503 with `FunctionExecutionError` | Use CloudFront TestFunction to inspect the viewer function error; JS 2.0 supports only a subset of modern JavaScript (for example, no optional chaining) |
| Site returns 502 | Inspect Lambda@Edge logs and associations; confirm domains, configured slot headers, numbered version, and permitted request headers |
| Site returns 503/504 | Check regional logs, failure-drill state, concurrency/throttles, cold starts and timeout settings |
| CloudFront update is still deploying | Wait for propagation; do not start another concurrent deployment |
| One region shows a different release | A regional update may have failed partway; inspect both app stacks before retrying |
| Verification fails after successful stack creation | Keep the resources for diagnosis; deployment success is not proof of end-to-end application health |

### Cleanup checklist

The following is **destructive** and stops the deployed site. Only use it when this
example environment is no longer needed. First record physical resource IDs and retain
any logs/artifacts you need; the commands do not remove retained resources listed above.

```sh
aws cloudformation list-stack-resources --region us-east-1 --stack-name "${STACK_PREFIX}-global"
# Also record the regional app/bootstrap resources in each region before deleting them.

aws cloudformation delete-stack --region us-east-1 --stack-name "${STACK_PREFIX}-global"
aws cloudformation wait stack-delete-complete --region us-east-1 --stack-name "${STACK_PREFIX}-global"

for region in us-east-1 us-west-2; do
  aws cloudformation delete-stack --region "$region" --stack-name "${STACK_PREFIX}-app"
  aws cloudformation wait stack-delete-complete --region "$region" --stack-name "${STACK_PREFIX}-app"
  aws cloudformation delete-stack --region "$region" --stack-name "${STACK_PREFIX}-bootstrap"
  aws cloudformation wait stack-delete-complete --region "$region" --stack-name "${STACK_PREFIX}-bootstrap"
done
```

Then follow the retained-resource cleanup described under [operations](#operations-and-teardown).
Do not assume a deleted CloudFormation stack means all charges have stopped.

## Validation status

The implementation has passed local production builds, strict TypeScript checks, Vitest,
CloudFormation lint, browser GET/POST server-function checks, and a `linux/amd64` container
build with healthy/failure/missing-secret HTTP checks on a read-only filesystem.
On **2026-09-26**, a live CloudFormation deployment in `us-east-1` and `us-west-2`
passed the following checks:

- Both Lambdas ran the same digest-pinned container image.
- CloudFront served SSR and GET/POST server functions from either preferred region.
- Independently failing each region returned GET/HEAD/OPTIONS from the other region.
- POST/PUT/PATCH/DELETE returned 503 from the failed preferred region, with no replay.
- Direct dynamic origin requests without the shared secret returned 403; readiness stayed healthy.
- Spoofed forwarding/origin headers were ignored; cross-site server-function POST was rejected.
- Both regions were restored to `SimulateFailure=false`; all five stacks were complete.
- 49 Vitest tests, strict typing, production build/smoke, and CloudFormation lint passed.

The initial image push required a host-side ECR upload workaround for Docker Desktop
proxy failures; the repository deploy script still uses standard `docker push`.
Live server functions were checked over HTTP. The browser connection was unavailable
for the final AWS UI pass, so live browser interaction was **not** revalidated.
These are HTTP-level simulated failures, not a test of an actual AWS regional outage.
Run the live verification and both-direction drill in your own sandbox before relying on it.

[Back to README](../README.md) · [Local development](getting-started.md)
