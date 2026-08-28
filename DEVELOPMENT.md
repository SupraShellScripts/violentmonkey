# Development

## Coordinator relationship

This repository owns the modified Violentmonkey extension and Developer Mode. It participates in the wider Workbench program coordinated from the sibling `SupraShellScripts/violentmonkey-workbench-private` repository, but it remains independently buildable and does not import private Workbench implementation code.

See [`docs/COORDINATOR_INTEGRATION.md`](docs/COORDINATOR_INTEGRATION.md) and [`coordination/consumer.json`](coordination/consumer.json).

## Container-only workflow

Do not install Node.js, pnpm, project dependencies, linters, test runners, bundlers, browsers, or release tooling on the host for this repository.

Use the stateless container launchers:

```powershell
.\tools\runtime-detect.ps1
.\tools\container.ps1 ci
.\tools\ci.ps1
```

```sh
sh ./tools/runtime-detect.sh
sh ./tools/container.sh ci
sh ./tools/ci.sh
```

`tools/ci.*` runs the checked-in GitHub Actions workflow locally through `nektos/act`. `tools/container.*` runs an individual project task directly in the same disposable toolchain.

See [`docs/CONTAINER_DEVELOPMENT.md`](docs/CONTAINER_DEVELOPMENT.md) for runtime selection, structured outputs, Podman and remote-engine behavior, GHCR promotion, and headless browser policy.

## Icons

All icons from [Iconify's MDI set](https://icon-sets.iconify.design/mdi/) can be used with [unplugin-icons](https://github.com/unplugin/unplugin-icons).

Icons follow the pattern: `~icons/mdi/{icon-name}` where `{icon-name}` matches the MDI icon name (e.g., `mdi/home`, `mdi/account-circle`).

```vue
<script setup>
import IconSync from '~icons/mdi/sync';
</script>

<template>
  <IconSync />
</template>
```
