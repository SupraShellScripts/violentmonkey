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
  *)
    echo "usage: run-mcp-reuse-in-container.sh census|test" >&2
    exit 64
    ;;
esac
