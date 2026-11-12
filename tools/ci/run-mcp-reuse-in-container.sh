#!/bin/sh
# Public-only: no host package installs, persisted browser profile, or credentials.
set -eu
IMAGE="node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1"
case "$1" in
  census)
    : "$FORK_SOURCE_SHA"
    : "$UPSTREAM_EXTENSION_SHA"
    : "$MCP_SOURCE_SHA"
    docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges \
      --read-only --tmpfs /tmp:rw,nosuid,nodev --pids-limit 64 --memory 512m --cpus 1 \
      --user "$(id -u):$(id -g)" \
      -e "FORK_SOURCE_SHA=$FORK_SOURCE_SHA" \
      -e "UPSTREAM_EXTENSION_SHA=$UPSTREAM_EXTENSION_SHA" \
      -e "MCP_SOURCE_SHA=$MCP_SOURCE_SHA" \
      -v "$PWD:/input:ro" -w /input "$IMAGE" \
      node fork/tools/qualify-upstream-mcp-reuse.mjs fork upstream-extension upstream-mcp
    ;;
  test)
    # Only public dependency acquisition inside disposable container, no exposed ports.
    docker run --rm --network bridge --cap-drop ALL --security-opt no-new-privileges \
      --pids-limit 256 --memory 3g --cpus 2 \
      --user "$(id -u):$(id -g)" \
      -e CI=1 -e HOME=/tmp -e npm_config_cache=/tmp/npm-cache \
      -e PNPM_HOME=/tmp/pnpm-home -e PNPM_STORE_DIR=/tmp/pnpm-store \
      -v "$PWD/upstream-mcp:/work:rw" -w /work "$IMAGE" sh -ec '
        npm install --prefix /tmp/pnpm-cli --no-audit --no-fund --ignore-scripts pnpm@12.10.1
        export PATH="/tmp/pnpm-cli/node_modules/.bin:$PATH"
        pnpm install --frozen-lockfile
        pnpm build
        pnpm typecheck
        pnpm test
      '
    ;;
  extension-browser)
    # Separate dependency/build permissions from browser system dependencies.
    # Build as the checkout owner so pnpm can create its virtual store; no
    # privileged writes to host mounts. The browser sees source read-only.
    : "$UPSTREAM_EXTENSION_SHA"
    docker run --rm --network bridge --cap-drop ALL --security-opt no-new-privileges \
      --pids-limit 256 --memory 3g --cpus 2 \
      --user "$(id -u):$(id -g)" \
      -e CI=1 -e HOME=/tmp -e npm_config_cache=/tmp/npm-cache \
      -e PNPM_HOME=/tmp/pnpm-home -e PNPM_STORE_DIR=/tmp/pnpm-store \
      -v "$PWD/upstream-extension:/work:rw" -w /work "$IMAGE" sh -ec '
        npm install --prefix /tmp/pnpm-cli --no-audit --no-fund --ignore-scripts pnpm@12.13.0
        export PATH="/tmp/pnpm-cli/node_modules/.bin:$PATH"
        pnpm install --frozen-lockfile --ignore-scripts
        pnpm build:mv3
        test -f dist-mv3/manifest.json
      '
    # The independent Playwright/Chromium installation is container-local.
    # Only the already-built public artifact and harness are mounted read-only.
    docker run --rm --network bridge --security-opt no-new-privileges \
      --shm-size 1g --pids-limit 512 --memory 5g --cpus 3 \
      -e CI=1 -e HOME=/tmp -e npm_config_cache=/tmp/npm-cache \
      -e UPSTREAM_EXTENSION_SHA="$UPSTREAM_EXTENSION_SHA" \
      -v "$PWD/upstream-extension:/upstream:ro" -v "$PWD/fork:/fork:ro" \
      -w /upstream "$IMAGE" sh -ec '
        npm install --prefix /tmp/pw --no-audit --no-fund --ignore-scripts playwright@1.62.1
        node /tmp/pw/node_modules/playwright/cli.js install --with-deps chromium
        node /fork/tools/ci/smoke-upstream-mcp-ui.cjs /upstream/dist-mv3
      ' | tee upstream-extension/upstream-mcp-browser-run.log
    # Last stdout line is the generated JSON receipt. No output mount write.
    tail -n 1 upstream-extension/upstream-mcp-browser-run.log > upstream-extension/upstream-mcp-browser-smoke.json
    jq -e '.status == "PASS" and .promotionAuthorized == false and .completeMcpHeadToHead == false' \
      upstream-extension/upstream-mcp-browser-smoke.json >/dev/null
    rm upstream-extension/upstream-mcp-browser-run.log
    ;;
  *)
    echo "usage: run-mcp-reuse-in-container.sh census|test|extension-browser" >&2
    exit 64
    ;;
esac
