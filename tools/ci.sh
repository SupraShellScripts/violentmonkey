#!/usr/bin/env sh
set -eu

REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
JOB="${1:-ci}"
ACT_VERSION_REQUIRED="${VM_ACT_VERSION:-0.2.88}"
RUNNER_IMAGE="${VM_ACT_RUNNER_IMAGE:-violentmonkey-act-runner:local}"

"$REPO_ROOT/tools/runtime-detect.sh" >/dev/null
# shellcheck disable=SC1091
. "$REPO_ROOT/.work/runtime/runtime.env"

if ! command -v act >/dev/null 2>&1; then
  echo "nektos/act is required as the local GitHub Actions orchestrator." >&2
  echo "Install or provide a portable act $ACT_VERSION_REQUIRED binary, then rerun." >&2
  exit 20
fi

act_version="$(act --version 2>&1 || true)"
if [ "${VM_ACT_ALLOW_VERSION_DRIFT:-0}" != 1 ] &&
   ! printf '%s' "$act_version" | grep -q "$ACT_VERSION_REQUIRED"; then
  echo "Expected act $ACT_VERSION_REQUIRED, found: $act_version" >&2
  echo "Set VM_ACT_ALLOW_VERSION_DRIFT=1 only for an explicit compatibility test." >&2
  exit 21
fi

engine() {
  case "$VM_SELECTED_CLI" in
    docker)
      if [ -n "${VM_DOCKER_CONTEXT:-}" ]; then
        docker --context "$VM_DOCKER_CONTEXT" "$@"
      elif [ -n "${VM_DOCKER_HOST:-}" ]; then
        DOCKER_HOST="$VM_DOCKER_HOST" docker "$@"
      elif [ -n "$VM_SELECTED_CONTEXT" ] && [ "$VM_SELECTED_CONTEXT" != default ]; then
        docker --context "$VM_SELECTED_CONTEXT" "$@"
      else
        docker "$@"
      fi
      ;;
    podman)
      podman "$@"
      ;;
    *)
      echo "Unsupported selected CLI: $VM_SELECTED_CLI" >&2
      return 127
      ;;
  esac
}

if ! engine image inspect "$RUNNER_IMAGE" >/dev/null 2>&1; then
  engine build \
    --tag "$RUNNER_IMAGE" \
    --file "$REPO_ROOT/containers/act-runner/Dockerfile" \
    "$REPO_ROOT"
fi

case "$VM_SELECTED_KIND" in
  Podman)
    if [ -z "${VM_DOCKER_HOST:-}" ]; then
      echo "act support through Podman is experimental and requires a Docker-compatible Podman socket." >&2
      echo "Set VM_DOCKER_HOST to that socket before running local heavy CI." >&2
      exit 22
    fi
    ;;
  RemoteDocker)
    export DOCKER_HOST="$VM_SELECTED_ENDPOINT"
    ;;
esac

cd "$REPO_ROOT"
act workflow_dispatch \
  --workflows .github/workflows/ci.yml \
  --job "$JOB" \
  --platform "ubuntu-latest=$RUNNER_IMAGE" \
  --pull=false
