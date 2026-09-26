# Using the repository

Prerequisites: Node **24.12+** (Node 24 LTS recommended) and npm.

Start from a fresh clone. Commands in this guide run from the repository root.
If you do not use nvm, install the Node version in `.nvmrc` with your preferred tool.

```sh
git clone https://github.com/ataylorme/tanstack-start-aws-high-availability.git
cd tanstack-start-aws-high-availability
nvm install
nvm use
npm ci
npm run dev                  # http://localhost:3000
```

The page displays the serving region, release and server timestamp. **Refresh server data**
exercises a GET server function; **Test POST server function** exercises a POST.
Local requests show `local`; region metadata is read on the server, never built into JS.

```sh
npm run check                # production build, edge compilation, strict TS, Vitest
npm run smoke                # runs/cleans up production HTTP server; healthy + failure modes
npm run test:watch
npm run build
PORT=3000 npm start          # production Node server at http://localhost:3000
```

TypeScript enables `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noUnusedLocals` and `noUnusedParameters` for application, tooling, edge code and tests.
The generated route tree is framework-owned. Vitest runs in Node with a separate config
so unit tests do not start the Vite/Nitro application build plugins.

### Container

```sh
docker buildx build --platform linux/amd64 --provenance=false --sbom=false \
  --load -t tanstack-ha:local .
docker run --rm --name tanstack-ha-local --read-only --tmpfs /tmp \
  -p 127.0.0.1:8080:8080 tanstack-ha:local
# In a second terminal:
curl http://localhost:8080/healthz
# Stop the foreground container with Ctrl-C, or:
docker stop tanstack-ha-local
```

The multi-stage image contains the standalone Nitro Node output and Lambda Web Adapter
**1.1.0**. It runs as a non-root user on port 8080. The same command starts the HTTP server
inside and outside Lambda. No Lambda Runtime Interface Emulator is required for local HTTP
checks; those checks do not exercise the real Lambda invocation adapter.

## Configuration

| Variable | Purpose | Default / usage |
| --- | --- | --- |
| `PORT` | Production Node listener | Set explicitly for local production; Docker uses `8080` |
| `HOST` | Production bind address | Docker uses `0.0.0.0`; use `127.0.0.1` for host-only testing |
| `AWS_REGION` | Region shown by server-rendered metadata | `local` when absent; supplied by AWS on Lambda |
| `RELEASE_ID` | Release shown on the page | `development`; deployment supplies a Git SHA/timestamp label |
| `ORIGIN_SECRET` | Shared CloudFront-to-app credential | Unset for local development; required on Lambda |
| `SIMULATE_FAILURE` | Return 503 for authenticated dynamic requests | Only literal `true` enables failure |
| `SMOKE_PORT` | Port used by the local production smoke script | `3187` |

There is no automatic `.env` loading in the deployment scripts. Set deployment variables
in the shell; do not commit credentials. Do not set `AWS_LAMBDA_FUNCTION_NAME` for normal
local development: its presence enables the fail-closed Lambda configuration check.

## Making changes

- Add UI routes under `src/routes/`; Start regenerates `src/routeTree.gen.ts` during build
  or development. Commit the generated file when it changes; do not edit it by hand.
- Keep server-only data and credentials out of client components. The existing page uses
  typed `createServerFn` handlers for region metadata.
- Update routing in `edge/router.ts` and its Vitest tests together. The edge package is
  separately compiled as CommonJS; it has no runtime npm dependencies.
- Change infrastructure in `infra/` and lint all templates before deployment. An application
  change is not automatically deployed by pushing to GitHub.
- Preserve both-region compatibility when changing server-function IDs or asset output;
  see the [deployment guide](deployment.md#updates-and-recovery).

## Checks before a pull request

```sh
npm ci
npm run check
npm run smoke
python3 -m venv .venv
.venv/bin/pip install cfn-lint==1.57.0
.venv/bin/cfn-lint -t infra/*.yaml
git diff --check
```

`npm run check` builds the app and edge code, then runs strict compiler checks and Vitest.
`npm run smoke` requires an existing production build and cleans up its own HTTP server.
The GitHub Actions workflow repeats these checks and additionally builds/runs the container;
it has no AWS deployment credentials and does not provision infrastructure.

## Troubleshooting locally

| Symptom | Check |
| --- | --- |
| Type-stripping / engine error | Use Node 24.12+; run `node --version` and `npm ci` |
| Missing `.output/server/index.mjs` | Run `npm run build` before `npm start` or `npm run smoke` |
| Port already in use | Stop the conflicting service, or set `PORT` / `SMOKE_PORT` |
| Docker cannot connect | Start the Docker daemon; check `docker info` |
| 403 on local dynamic pages | Remove local `ORIGIN_SECRET`, or send the matching `X-Origin-Verify` header for deliberate guard testing |
| 503 on local dynamic pages | Unset `SIMULATE_FAILURE`; check for accidental Lambda environment variables |
| Build reports `use client` warnings | These are known upstream bundle warnings; check the exit code and run smoke tests |

Container HTTP tests verify the Node server and packaged extension, not Lambda's invocation
protocol or CloudFront failover. Those require the [AWS verification steps](deployment.md#verify-activeactive-and-failover).

[Back to README](../README.md) · [Deploy to AWS](deployment.md)
