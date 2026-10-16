# Cost and benchmark boundaries

This is not a production-sizing recommendation or a complete bill estimate.
Raw account-specific quotes and measurements belong in ignored `.deploy/celld/`.
Refresh rates for the selected regions before budgeting; exclude neither idle
resources nor retained storage. Discounts/free credits are not assumed.

## Read-only current inventory and quote snapshot

```sh
node experiments/celld/scripts/cost-inventory.ts # Offline plan; no calls
AWS_PROFILE=<sandbox-profile> node experiments/celld/scripts/cost-inventory.ts --execute
```

The executable probe binds the caller account and both immutable recorded regional
stack IDs before reading ASG instances, attached encrypted gp3 volumes and each
stack's ALB. It obtains current AWS Price List On-Demand USD quotes, preserves the
SKU/effective date/raw responses, and rejects ambiguous, future-effective or
tiered dimensions rather than guessing. All resource-specific evidence is private.
The actual deployed read-only inventory/quote run has passed.

Its subtotal covers current running instance-hours, one ALB-hour per region,
observed **primary node** public IPv4 addresses, **currently associated ALB**
public Elastic IPv4 allocations, and provisioned gp3 GiB-months.
The 730-hour illustration is explicit, not an actual bill or calendar-month
allocation. Secondary node interfaces/addresses and unattributable/unassociated
service-managed allocations are not counted. LCUs, CPU surplus, extra gp3
performance, DynamoDB/replication, S3/CRR/transfer,
CloudFront/edge, logs/metrics and retained/replacement artifacts remain separately
**unpriced**, not zero. This is a reproducible partial idle-cost floor, not the
complete operating-cost requirement or a recommendation for production sizing.

### ALB public IPv4 attribution

The probe obtains each ALB from its immutable stack's resources, then validates
its active internet-facing IPv4 configuration and exact VPC/subnets. It queries
requester-managed ENIs by **exact ALB description and VPC**, validates returned
identities and configured subnet coverage, and extracts all public associations.
Overlapping primary/private-address association records are deduplicated by
allocation identity; private delegated IPv4 prefixes are never counted as public
allocations. It then queries `DescribeAddresses` using only the nonempty set of
those ALB ENI IDs and requires a matching allocation, public IP, association,
interface, owner and `ServiceManaged: alb`. It does not count every ALB in the
account, infer counts from DNS/two AZs, or assume missing data means zero.

AWS now exposes ALB-managed public Elastic IPv4 allocations through
[DescribeAddresses](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/application-load-balancers.html#ip-address-management).
The [address API schema](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_Address.html)
uses lowercase `alb`; use the supported
[network-interface-id filter](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeAddresses.html),
not an invented service-managed filter. Read-only
`ec2:DescribeNetworkInterfaces` and `ec2:DescribeAddresses` permissions are required.

The two inventories are **not atomic**; changes or incomplete evidence fail the
observation rather than contributing a zero charge. The timestamped result counts
only associated allocations visible in both responses. It is not historical
address-hours, account-wide public IP attribution or a promise that allocations
remain constant. IPv6/dualstack/internal configurations are currently rejected,
not priced as zero. Any full-month multiplication is an explicit steady-state
list-price scenario, not measured billing usage.

## Billable inventory

The regional templates create four `t4g.medium` instances total, two ALBs and
200 GiB of gp3 root storage at desired capacity. Their public outbound addresses
avoid NAT Gateway charges, but still incur public IPv4 charges. Public ALBs also
use chargeable IPv4 addresses; count actual allocated addresses rather than
assuming the minimum forever.

For a chosen operating duration `H` hours, compute a subtotal from:

- `2 × H × east instance hourly rate + 2 × H × west instance hourly rate`;
- any burstable-instance CPU surplus charges (unlimited-mode configuration and
  sustained utilization matter);
- two ALB hourly charges **plus LCUs**, including long-lived connections;
- gp3 provisioned storage and any extra IOPS/throughput;
- observed public IPv4 address-hours.

That subtotal excludes substantial workload-dependent charges: MRSC replicated
reads/replicated writes and table/PITR storage; S3 source/replica/version storage,
requests and inter-region transfer; CloudFront requests/egress; Lambda@Edge
invocation/duration; CloudWatch logs/alarms/metrics; retained volumes/artifacts;
and any explicit recovery/backfill jobs. Versioned recovery logs can grow even
when the application is mostly idle. A quarantine archive is additional storage,
not a free standby serving bucket. Check the actual billing dashboard after a
bounded experiment; do not infer a bill solely from template counts.

## Reproducible preliminary latency measurements

`node experiments/celld/scripts/benchmark.ts` starts and cleans up only its own
local baseline server, then measures existing local celld SSR. `--aws` reads the
ignored deployment manifest and measures HTTPS CloudFront SSR. Each is 50 warm,
sequential requests after five warmups; p50/p95/p99 and samples are saved locally.

The baseline and lab pages are different workloads/payloads. These results are
not an apples-to-apples runtime comparison, cold-start benchmark, capacity test,
or measurement of durable mutation/workflow latency. Cached/uncached MRSC routing,
quorum failure, stateful acknowledgement, peer-to-S3 lag, epoch-aware hydration,
RPO/RTO and socket recovery need separate evidence. The inert S3 replication
probe is not a substitute for any of these measurements. The native-command
`measure-replication.ts` probe now records conservative source/CRR presence bounds
for one acknowledged marker with exact native reconstruction; it still does not
measure a universal RPO, pure network latency or complete recovery exposure.

### Read-only directory latency probe

`AWS_PROFILE=<sandbox-profile> node experiments/celld/scripts/benchmark-directory.ts
--execute` uses the same reader and directory implementation as the edge bundle.
An already-installed SDK v3 is a local prerequisite (no dependency is installed);
the actual local SDK and Node versions are recorded with each private run.
The probe verifies both replica identities/STRONG consistency before measurement
and exports session credentials into process memory only.

Each scenario takes five warmups and 50 sequential samples. Actual strong reads
measure the existing inert FENCING shard from each explicit regional endpoint.
A separately labeled scenario injects immediate first-endpoint transport refusal,
reads the second real endpoint, and checks authoritative FENCING rejection. It
does not cause an AWS endpoint outage or measure real coordination-quorum loss.
The cached/uncached ACTIVE comparison is entirely synthetic in local memory:
no ACTIVE item is created and no regional write is authorized. These cache-only
timings exclude network latency and cannot stand in for a deployed ACTIVE route.
The measurements are client-local, not Lambda@Edge or end-to-end mutation latency.
They do not establish renewal cost, recovery time, regional RPO/RTO, or a safe
promotion. Results remain under ignored deployment evidence.

## Regional unit catalog and explicit workload scenarios

```sh
node experiments/celld/scripts/cost-rates.ts # Offline plan, no AWS calls
AWS_PROFILE=<sandbox-profile> node experiments/celld/scripts/cost-rates.ts --execute
# Optional explicit billing-unit scenario, not measured deployment traffic:
AWS_PROFILE=<sandbox-profile> node experiments/celld/scripts/cost-rates.ts --execute --usage=<usage-json>
```

The read-only tool verifies the caller account and both immutable regional stack
identities, then retrieves current AWS On-Demand price schedules. It covers 22
regional schedules: ALB LCUs; DynamoDB on-demand reads, replicated writes,
standard storage and PITR; S3 Standard storage and request tiers; CloudWatch
standard metric alarms and current-generation log ingestion/storage. Raw Price
List responses, SKU, effective date, units, descriptions and all price intervals
are preserved privately. Provisioned capacity, infrequent-access tables,
annotation requests, reserved/Outposts LCUs and legacy log pricing are not
silently substituted when a selector is missing or ambiguous.

Tiered prices remain tiered: intervals must cover zero to infinity without gaps
or overlaps. A scenario must provide both the added quantity and **existing
billing-scope usage**. Do not assign an account's free allowance or low-volume
tier to this lab independently of its other usage. A per-request rate from the
catalog is already per stated unit; do not divide it by a million again.
The tool rejects non-finite quantities, precision-lost usage and cost overflow.

It also inventories the current stack-owned alarms, verifies they are simple
single-metric standard alarms, and records a separate **full-month list-price
scenario**. That is not observed alarm lifetimes, actual monthly charges or a
notification test. Actual standard alarm charges are prorated by existence hours;
metric-math/anomaly/composite alarms cannot be priced by this simple resource
count. The catalog unit `Alarms` represents monthly alarm-metric pricing, not
individual evaluations. [CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/),
[alarm billing](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/cloudwatch_billing.html#cloudwatch_billing_alarms).

Example input (hypothetical one-hour workload, **not measured traffic**):

```json
{
  "format": 1,
  "label": "Hypothetical request-unit workload",
  "windowStart": "2026-01-01T00:00:00Z",
  "windowEnd": "2026-01-01T01:00:00Z",
  "rows": [
    { "region": "us-east-1", "category": "mrsc-replicated-write", "unit": "ReplicatedWriteRequestUnits", "quantity": 1000, "existingUsage": 0 },
    { "region": "us-west-2", "category": "mrsc-replicated-write", "unit": "ReplicatedWriteRequestUnits", "quantity": 1000, "existingUsage": 0 }
  ],
  "unpriced": ["Compute/ALB/IPv4", "Reads, storage, PITR and logging", "S3 requests/CRR/transfer, CloudFront and Lambda@Edge"]
}
```

Quantities are already **billable units**, not HTTP requests or raw byte counts.
For example, GB-months integrate storage volume over time; LCU-hours must account
for billing cadence/reservations; monthly alarm-metric fractions need actual
calendar-month proration. The window is descriptive, not an automatic conversion
of quantities into hours or months. S3 and CloudWatch Logs examples use binary
GB (bytes divided by 2³⁰); log ingestion is distinct from compressed archival
storage. A daily S3 `BucketSizeBytes` observation already includes noncurrent
versions and multipart data and is not current-month average storage usage.
[S3 metrics](https://docs.aws.amazon.com/AmazonS3/latest/userguide/metrics-dimensions.html),
[S3 pricing](https://aws.amazon.com/s3/pricing/),
[CloudWatch pricing examples](https://aws.amazon.com/cloudwatch/pricing/).

For the selected two-replica MRSC topology, a logical write's billable replicated
units belong in **both replica regions**, not the witness. Reads belong where
issued and must account for size/consistency/retries. The script does not infer
these multipliers from operation counts. Current dedicated AWS billing guidance
states that the witness adds no replicated-write/storage/replication-transfer
charge and global-table replication has no cross-region transfer fee. This does
**not** remove separate S3 CRR/transfer charges. Prefer this dedicated guidance
over conflicting older FAQ text. [Global-table billing](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/global-tables-billing.html),
[read/write metering](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/read-write-operations.html).

Catalog retrieval, the explicit synthetic workload and the current-alarm
inventory were exercised against AWS. Scenario sums include only supplied rows;
`unpriced` must remain explicit. There is still no measured complete operating
cost: traffic/request counts, shared tier allocation, exact resource lifetimes,
ALB reservations, historical public IPv4 address-hours and unattributed addresses,
custom metrics, CRR/transfer, CloudFront/edge and
retained artifacts need additional inventory and billing reconciliation. The
original recurring subtotal is still partial, not silently upgraded by these
rates or combined with an unlike-duration scenario. No free-tier, credit,
discount or actual bill is inferred.

## Official pricing references

- [EC2 On-Demand and burstable CPU](https://aws.amazon.com/ec2/pricing/on-demand/)
- [ALB hours and LCUs](https://aws.amazon.com/elasticloadbalancing/pricing/)
- [EBS](https://aws.amazon.com/ebs/pricing/)
- [VPC public IPv4](https://aws.amazon.com/vpc/pricing/)
- [DynamoDB](https://aws.amazon.com/dynamodb/pricing/)
- [S3](https://aws.amazon.com/s3/pricing/)
- [CloudFront](https://aws.amazon.com/cloudfront/pricing/)
- [Lambda@Edge](https://aws.amazon.com/lambda/edge/)
- [CloudWatch](https://aws.amazon.com/cloudwatch/pricing/)
- [AWS Pricing API](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/price-changes.html)
