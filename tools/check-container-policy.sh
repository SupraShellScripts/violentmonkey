#!/bin/sh
set -eu

fail() {
  echo "container tooling policy violation: $*" >&2
  exit 1
}

test -f tools/tooling-policy.json || fail "tools/tooling-policy.json is missing"
jq -e '.policy == "container-only-development-tooling"' tools/tooling-policy.json >/dev/null

if grep -R -n -E \
  'actions/setup-node|pnpm/action-setup|(^|[[:space:]])(npm|pnpm|npx)[[:space:]]+(install|ci|run|exec)' \
  .github/workflows \
  --include='*.yml' --include='*.yaml' 2>/dev/null |
  grep -v -E 'tools/container\.(sh|ps1)|container-only|policy example'; then
  fail "workflow installs or runs project tooling outside the declared toolchain container"
fi

grep -q '^FROM .*@sha256:' containers/toolchain/Dockerfile ||
  fail "toolchain base image must be pinned by digest"

test ! -d node_modules || [ -L node_modules ] ||
  fail "host-supplied node_modules is prohibited"

echo '{"schemaVersion":1,"status":"success","check":"container-tooling-policy"}'
