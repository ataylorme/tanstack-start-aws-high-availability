# Repository working instructions

## Execution lane

For issue #2, use ordinary direct implementation with an incremental implementation
plan, tests, and evidence-based review. The user has explicitly authorized implementation
and sandbox AWS deployment. Do not automatically enter consensus or Conductor mode.

The Ralplan documented-leader preflight applies only when requesting adapted Ralplan
authority; it is not a prerequisite for ordinary repository work. Do not fabricate
role routing, host receipts, session identities, or consensus approvals. If a workflow
is explicitly invoked, obey its actual gates. These instructions do not override
system/developer instructions or grant authority to mutate unrelated runtime state.

## Issue #2 scope

- Keep the Lambda Web Adapter baseline independently deployable and unchanged unless
  a shared change is necessary and regression-tested.
- Host TanStack Start itself on celld on AWS; an actor-only sidecar is insufficient.
- Use celld's Cloudflare-compatible Workflows API, not TanStack Workflow. The
  `test/tanstack-workflow-aws` branch is a reference for experiment structure and
  validation, not a runtime dependency to transplant.
- Preserve all issue #2 acceptance criteria, including the Durable Object example,
  regional ownership, recovery, failure drills, benchmarks, and go/no-go assessment.
- Current user region preferences supersede the original issue topology: use
  us-west-2 and us-east-1 for fleets/MRSC replicas, with witness us-east-2. Keep
  existing ownership stable until a proven transition; do not silently promote
  the preferred region. Use plain CloudFormation.
- Do not fork celld. Extend it only through supported native hooks/plugins;
  internal Rust traits requiring a custom binary are not a supported extension.
- Pin celld and inspect its actual execution/storage fencing semantics. Keep
  automatic writable regional promotion disabled unless runtime evidence proves
  stale owners cannot commit, including in-flight and background work.
- Validate locally, with Chrome end-to-end tests, and on AWS. Do not equate unit
  tests or a successful deployment with proof of regional recovery or fencing.

## Deployment privacy and safety

- Take the AWS profile and deployment-specific parameters from local configuration
  or the current user request; do not hard-code them in public files.
- Keep account IDs, deployed endpoints, ARNs, resource identifiers, credentials,
  tokens, and raw deployment evidence under ignored `.deploy/` or `.omx/local/`.
- Public documentation must use placeholders and sanitized evidence. Check the
  diff and tracked files for deployment-specific information before any commit.
- Use isolated experiment resources, not the baseline or unrelated infrastructure.
  Do not perform destructive teardown without explicit authorization.

## Verification and continuation

Keep a requirement-by-requirement implementation and evidence checklist. Run
targeted tests and applicable build/typecheck/test checks after edits. State
validation gaps explicitly; do not redefine completion around a smaller demo.
Preserve a local handoff for long-running deployment and recovery work.
