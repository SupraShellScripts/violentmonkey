# Container-only development and CI

Status: proposed implementation under `SupraShellScripts/violentmonkey-workbench-private#6` and synchronization issue #24.

## Policy

Project tooling runs inside disposable containers. The host or CI runner is a bootstrap/orchestration surface, not a place to install project Node.js, pnpm, dependencies, linters, test runners, bundlers, browser binaries, signing clients, or publication tooling.

Allowed host/runner prerequisites are limited to:

- Git;
- a supported Docker-compatible runtime;
- `nektos/act` when local/self-hosted workflow parity is being exercised;
- PowerShell or a POSIX shell.

The machine-readable policy is `tools/tooling-policy.json`.

## Executor routing

Deterministic work is automation-first.

1. For this public repository, portable pull-request and branch validation runs on disposable GitHub-hosted Actions runners by default.
2. A trusted self-hosted runner may be used for a host/runtime-specific gate when its capabilities and event policy are explicitly suitable.
3. Local agents may use the same repository-owned launchers when Actions cannot represent the required environment.
4. Human shell execution is a fallback, not the normal CI backend. A person should be required only for genuine judgment/physical interaction or an explicitly documented temporary exception.

Untrusted public/fork pull-request code must not be routed automatically to a persistent privileged self-hosted runner without a separately reviewed isolation design.

GitHub-hosted CI and local/self-hosted `act` are complementary evidence. Hosted CI proves the portable repository workflow on GitHub's runner environment. `act` is used only when parity with the declared local Docker-compatible orchestration path is itself a material requirement; that distinction does not make the human the executor.

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

The runtime cannot change during one operation. The selected descriptor is written to `.work/runtime/runtime.json`.

Explicit controls:

```text
VM_CONTAINER_RUNTIME=auto|docker|wsl-docker|podman
VM_DOCKER_CONTEXT=<docker-context>
VM_DOCKER_HOST=<docker-compatible-endpoint>
VM_WSL_DISTRO=<wsl-distribution>
```

`act` targets the Docker Engine API. Podman parity is therefore experimental and requires a Docker-compatible Podman socket identified through `VM_DOCKER_HOST`.

## Stable interfaces

### GitHub-hosted automation

`.github/workflows/ci.yml` is the portable public CI entry point. It runs with read-only repository permissions and invokes the same stateless container launcher used elsewhere:

```sh
sh ./tools/container.sh ci
```

The workflow performs a clean/no-cache toolchain rebuild for qualification and uploads bounded build/validation evidence.

### Local/self-hosted automation

Windows:

```powershell
.\tools\runtime-detect.ps1
.\tools\container.ps1 ci
.\tools\ci.ps1
```

POSIX:

```sh
sh ./tools/runtime-detect.sh
sh ./tools/container.sh ci
sh ./tools/ci.sh
```

`tools/container.*` runs an individual task through the disposable toolchain. `tools/ci.*` runs the checked-in Actions workflow through `nektos/act` when that parity gate is required.

These are automation interfaces even when launched locally; they must remain non-interactive and machine-readable. Human copy/paste is not a qualification requirement.

### Stable commands

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

### Stable outputs

```text
artifacts/container/<command>/run-result.json
artifacts/container/<command>/run-events.jsonl
artifacts/container/<command>/build-metadata.json
artifacts/container/<command>/checksums.sha256
artifacts/container/<command>/dist/
artifacts/container/<command>/dist-mv3/
```

Exit status is authoritative. JSON files provide machine-readable detail.

Agent/automation callers must inspect `run-result.json`, bind evidence to the exact source commit, use content hashes, avoid changing runtime selection after discovery, preserve bounded evidence when appropriate, and never infer success only from log prose.

## Source identity and evidence

The host launcher resolves the exact checkout commit before creating the toolchain container and injects that 40-character SHA as `SOURCE_COMMIT`.

The container fails closed if exact source identity is unavailable. `run-result.json` and `build-metadata.json` therefore bind the result to the source revision rather than relying on copied `.git` metadata inside the isolated workspace.

For a pull-request event, GitHub may also create a synthetic merge ref. When exact branch-head provenance is required, use/record the branch-push run whose checkout and uploaded artifact name bind directly to the PR head SHA. Merge-result runs remain useful compatibility evidence but are not silently substituted for exact-head evidence.

## Toolchain image

The project toolchain is defined by:

```text
containers/toolchain/Dockerfile
containers/toolchain/entrypoint.sh
containers/images.lock.json
```

The base image is pinned by digest. The pnpm version must match `package.json`'s package-manager contract. The dependency layer is built from:

- `package.json`;
- `pnpm-lock.yaml`;
- `pnpm-workspace.yaml`.

At runtime, the container verifies those exact dependency inputs against the image and fails if they differ.

The source tree is copied into an ephemeral work directory. Host `node_modules`, `.env`, `.env.*`, `.secrets`, previous build output, and runtime state are not accepted as project inputs. Image-owned dependencies are linked only after source/policy validation.

Routine execution is:

- removed after execution;
- disconnected from the network during lint/test/build execution;
- run with Linux capabilities dropped;
- run with `no-new-privileges`;
- supplied no publication secrets;
- allowed to persist only explicit bounded outputs.

## GitHub Actions and `act`

The heavy workflow is `.github/workflows/ci.yml`.

It is intentionally usable in two modes:

- GitHub-hosted Actions for public portable CI on pull requests, the active foundation branch, and explicit dispatch;
- `nektos/act` for local/self-hosted parity testing against the same checked-in workflow.

The `act` launcher:

1. detects and locks the container runtime;
2. verifies the pinned `act` version;
3. builds the local act-runner image when absent;
4. invokes the checked-in workflow;
5. runs the project toolchain as a nested disposable container;
6. leaves structured outputs under `artifacts/container/ci`.

Do not duplicate test/build logic in ad-hoc shell snippets merely to change executors.

## GitHub-hosted usage policy

Because this repository is public, hosted Actions are the default for portable deterministic PR validation. The workflow must remain read-only and must not expose publication credentials to untrusted event contexts.

Expensive or host-specific work may move to reviewed reusable images or a trusted self-hosted runner when that improves determinism/cost, but the fallback is automation—not a person operating a shell.

Reusable images and runner conventions should migrate deliberately to `SupraShellScripts/stateless-dev-tooling` after parity evidence. Project-specific dependency locks and release policy remain here.

## GHCR lifecycle

Development images are built and validated before promotion. An image may be promoted only after its build/tests, consumer parity, SBOM/vulnerability review, supported architectures, source commit/Dockerfile identity, and absence of private source/credentials are established.

Routine consumers pin immutable digests:

```text
ghcr.io/suprashellscripts/violentmonkey-toolchain@sha256:<digest>
```

Tags are discovery aliases, not authority. Until a reviewed stable image exists, `containers/images.lock.json` records the local-bootstrap state.

## Browser testing

Browser acceptance defaults to headless disposable environments with ephemeral profiles, no personal cookies/browser data, no host-installed browser dependency, and bounded traces/screenshots/results. A persistent profile is permitted only when it is the explicit fixture under test.

Headed execution is a diagnostic exception, not automatically a human release gate. Prefer an appropriate GitHub-hosted or trusted self-hosted runner whenever the browser test can be automated.

## Other development tools

The container-only rule applies to ESLint, Prettier, TypeScript/Vue tooling, Jest, Gulp/Webpack, formal model checkers, static/security/license scanners, SBOM generators, documentation tools, browser automation, archive/reproducibility utilities, signing clients, and publication clients.

Each introduced tool must be version-controlled/pinned, invoked through a reviewed interface, capable of bounded evidence, and isolated from secrets unless the operation explicitly requires them.

## Release safety

Inherited upstream publication paths are disabled or replaced by fail-closed/manual/read-only guards in this downstream development fork. In particular, ordinary CI must not publish to:

- AMO;
- Chrome Web Store;
- Microsoft Edge Add-ons;
- GitHub Releases;
- an auto-update branch/channel;
- Transifex.

The synchronized fork also disables the inherited MV2 CRX signing/release/updates workflow. Signing or publication requires a separate reviewed authority path with fork-owned identity/key custody, least-privilege permissions, and explicit authorization.

## Qualification

For a portable public exact head, the first qualification lane is the checked-in GitHub-hosted workflow. Record:

- exact source SHA;
- workflow run ID and event type;
- runner/runtime identity;
- Node and pnpm versions;
- policy/lint/test results;
- MV2/MV3 outputs;
- checksums/build metadata;
- uploaded artifact ID/digest.

If `act` parity is materially required, execute the same checked-in workflow on a compatible automation runner and record its runtime/act identity and output digests. Do not claim that parity until it has actually run, and do not require human shell operation merely to obtain it.
