# Container-only development and local CI

Status: proposed implementation

Tracking: `SupraShellScripts/violentmonkey-workbench-private#6`

## Policy

All project tooling runs inside disposable containers. The host is only a bootstrap and orchestration surface.

Allowed host prerequisites:

- Git;
- a supported Docker-compatible runtime;
- `nektos/act` as the local GitHub Actions orchestrator, either installed or provided as a portable pinned binary;
- PowerShell or a POSIX shell.

The host must not install project Node.js, pnpm, npm dependencies, linters, test runners, bundlers, browser binaries, browser drivers, SBOM tools, scanners, formal model checkers, signing clients, or publication tools.

The machine-readable policy is `tools/tooling-policy.json`.

## Supported container runtimes

The launchers discover and record one runtime before doing work:

- Docker Desktop;
- Docker Engine in the current Linux or WSL2 environment;
- Docker Engine in a selected WSL2 distribution;
- Podman;
- a remote Docker-compatible endpoint selected through a Docker context, `DOCKER_HOST`, SSH, or TLS.

Selection order is:

1. explicit environment selection;
2. the already-selected healthy Docker endpoint;
3. exactly one healthy WSL2 Docker Engine;
4. a healthy Podman endpoint;
5. otherwise fail with diagnostics.

The runtime cannot change during one operation. The selected descriptor is written to:

```text
.work/runtime/runtime.json
```

Explicit controls:

```text
VM_CONTAINER_RUNTIME=auto|docker|wsl-docker|podman
VM_DOCKER_CONTEXT=<docker-context>
VM_DOCKER_HOST=<docker-compatible-endpoint>
VM_WSL_DISTRO=<wsl-distribution>
```

`act` officially targets the Docker Engine API. Podman support is therefore treated as experimental and requires a Docker-compatible Podman socket identified through `VM_DOCKER_HOST`.

## Human, automation, and agent interfaces

### Human

Windows:

```powershell
.\tools\runtime-detect.ps1
.\tools\container.ps1 ci
.\tools\ci.ps1
```

Linux or WSL:

```sh
./tools/runtime-detect.sh
./tools/container.sh ci
./tools/ci.sh
```

The commands print readable failures and also produce structured JSON.

### Automation

Stable commands:

```text
ci
policy
lint
test
build
build-mv2
build-mv3
pnpm <args>
```

Stable outputs:

```text
artifacts/container/<command>/run-result.json
artifacts/container/<command>/run-events.jsonl
artifacts/container/<command>/build-metadata.json
artifacts/container/<command>/checksums.sha256
artifacts/container/<command>/dist/
artifacts/container/<command>/dist-mv3/
```

Exit status is authoritative. JSON files provide machine-readable detail.

### Agents

Agent callers must:

- invoke noninteractive commands;
- inspect `run-result.json`;
- use content hashes and source commit identity;
- never infer success from log text;
- avoid changing runtime selection after `.work/runtime/runtime.json` is created;
- preserve output evidence when opening a pull request;
- never supply secrets to ordinary build or test operations.

## Toolchain image

The project toolchain is defined by:

```text
containers/toolchain/Dockerfile
containers/toolchain/entrypoint.sh
containers/images.lock.json
```

The base image is pinned by a multi-platform digest. The exact pnpm version is pinned to the version declared by `package.json`.

The dependency layer is built from:

- `package.json`;
- `pnpm-lock.yaml`;
- `pnpm-workspace.yaml`.

At runtime, the container verifies those inputs against the image. If they differ, the command fails and requires an image rebuild.

The source tree is copied into an ephemeral `/work` directory. The checkout receives no host `node_modules`, and the toolchain writes generated outputs only to `/output`.

The container is:

- removed after execution;
- disconnected from the network during routine lint, test, and build execution;
- run with all Linux capabilities dropped;
- run with `no-new-privileges`;
- supplied no secrets;
- unable to persist state except through explicitly copied outputs.

## Local GitHub Actions through `act`

The heavy workflow is `.github/workflows/ci.yml`.

It has only a manual `workflow_dispatch` trigger. The normal command is:

```powershell
.\tools\ci.ps1
```

or:

```sh
./tools/ci.sh
```

The launcher:

1. detects and locks the container runtime;
2. verifies the pinned `act` version;
3. builds the local `act` runner image when absent;
4. invokes the checked-in workflow;
5. runs the project toolchain as a nested disposable container;
6. leaves structured outputs under `artifacts/container/ci`.

The same workflow remains runnable manually on GitHub-hosted Ubuntu as a compatibility fallback, but it is not triggered for every push or pull request.

## Hosted-minute policy

Heavy build, test, browser, packaging, SBOM, and release-candidate jobs are local-first.

GitHub-hosted jobs should be limited to small checks such as:

- workflow and metadata schema validation;
- prohibited secret or binary detection;
- immutable image-reference verification;
- local evidence-record validation;
- repository policy checks.

A future public reusable tooling repository will own shared images and `act` runner conventions:

```text
SupraShellScripts/stateless-dev-tooling
```

The separate repository is recommended for reuse, transparency, GHCR package ownership, image testing, SBOMs, and provenance. Project-specific dependency locks and release logic remain in this repository.

## GHCR lifecycle

Development images are built locally first and are not immediately published.

An image may be pushed to GHCR only after:

- a no-cache local build succeeds;
- its own tests pass;
- a consuming workflow passes through `act`;
- the SBOM and vulnerability results are reviewed;
- supported architectures are declared;
- the source commit and Dockerfile are recorded;
- no credentials or private source are present.

Routine consumers pin the immutable digest:

```text
ghcr.io/suprashellscripts/violentmonkey-toolchain@sha256:<digest>
```

Semantic-version and source-SHA tags are discovery aliases, not authority.

Until the first stable image is promoted, `containers/images.lock.json` records `local-bootstrap`.

## Browser testing

Browser acceptance testing defaults to headless, stateless containers.

Separate images will pin:

- Playwright and its browser binaries;
- Selenium and browser/driver combinations;
- Firefox `web-ext`;
- required fonts and OS libraries.

Each run uses:

- an ephemeral browser profile;
- no personal cookies or browser data;
- no host-installed browser;
- no persistent profile unless it is an explicit upgrade-test fixture;
- a bounded output directory for traces, screenshots, console records, and results.

Headed execution is an explicit manual diagnostic exception, not a release gate.

## All other development tools

The same rule applies to every additional tool introduced later, including:

- ESLint, Prettier, TypeScript, Vue tooling, Jest, Gulp, and Webpack;
- formal model checkers such as TLA+/TLC, Apalache, Alloy, or SPIN;
- Semgrep and other static analyzers;
- license and dependency scanners;
- SBOM generators;
- vulnerability scanners;
- documentation generators;
- archive and reproducibility utilities;
- signing and store-publication clients.

Each tool must be:

- declared in a reviewed image definition;
- version-pinned;
- invoked through the container interface;
- absent from host prerequisites;
- capable of structured output;
- isolated from secrets unless the operation explicitly requires them.

## Release safety

The inherited upstream store-publishing workflows are disabled or replaced by manual, non-publishing guards.

They do not publish to:

- AMO;
- Chrome Web Store;
- Microsoft Edge Add-ons;
- GitHub Releases;
- Transifex.

Signing, translation synchronization, and publication require separate future least-privilege containers, unique fork identities, reviewed credentials, and an explicit operator action.

## Validation

Static validation can be performed without the container runtime, but it is not sufficient for merge approval.

Required local gate on a machine with a supported runtime:

```powershell
$env:VM_NO_CACHE = '1'
$env:VM_REBUILD_TOOLCHAIN = '1'
.\tools\ci.ps1
```

or:

```sh
VM_NO_CACHE=1 VM_REBUILD_TOOLCHAIN=1 ./tools/ci.sh
```

The gate must produce successful `run-result.json`, both `dist/` variants, checksums, and build metadata.
