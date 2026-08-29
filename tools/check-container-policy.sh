#!/bin/sh
set -eu

fail() {
  echo "container tooling policy violation: $*" >&2
  exit 1
}

test -f tools/tooling-policy.json || fail "tools/tooling-policy.json is missing"
jq -e '.policy == "container-only-development-tooling"' tools/tooling-policy.json >/dev/null

HOST_BROWSER_ANNOTATION='host-bound-browser-qualification'
HOST_BROWSER_WORKFLOW='.github/workflows/workbench-browser-smoke.yml'

if grep -R -n -E \
  'actions/setup-node|pnpm/action-setup|(^|[[:space:]])(npm|pnpm|npx)[[:space:]]+(install|ci|run|exec)' \
  .github/workflows \
  --include='*.yml' --include='*.yaml' 2>/dev/null |
  grep -v -E 'tools/container\.(sh|ps1)|container-only|policy example|host-bound-browser-qualification'; then
  fail "workflow installs or runs project tooling outside the declared toolchain container"
fi

annotated_lines="$(
  grep -R -n -F "$HOST_BROWSER_ANNOTATION" .github/workflows \
    --include='*.yml' --include='*.yaml' 2>/dev/null || true
)"
if [ -n "$annotated_lines" ]; then
  if printf '%s\n' "$annotated_lines" |
    grep -v -E "^${HOST_BROWSER_WORKFLOW}:" >/dev/null; then
    fail "host-bound browser qualification annotation is allowed only in $HOST_BROWSER_WORKFLOW"
  fi
  if printf '%s\n' "$annotated_lines" |
    grep -v -E 'npm install .*playwright@.*host-bound-browser-qualification' >/dev/null; then
    fail "host-bound browser qualification may install only pinned Playwright in the allowed workflow"
  fi
  grep -q 'PLAYWRIGHT_BROWSERS_PATH.*RUNNER_TEMP' "$HOST_BROWSER_WORKFLOW" ||
    fail "host-bound browser qualification must keep browser binaries under RUNNER_TEMP"
  grep -q 'RUNNER_TEMP.*workbench-playwright' "$HOST_BROWSER_WORKFLOW" ||
    fail "host-bound browser qualification must keep Playwright modules under RUNNER_TEMP"
fi

grep -q '^FROM .*@sha256:' containers/toolchain/Dockerfile ||
  fail "toolchain base image must be pinned by digest"

test ! -d node_modules || [ -L node_modules ] ||
  fail "host-supplied node_modules is prohibited"

echo '{"schemaVersion":1,"status":"success","check":"container-tooling-policy"}'
