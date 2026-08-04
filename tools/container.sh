#!/usr/bin/env sh
set -eu

REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
COMMAND="${1:-ci}"
if [ "$#" -gt 0 ]; then
  shift
fi

sh "$REPO_ROOT/tools/runtime-detect.sh" >/dev/null
# shellcheck disable=SC1091
. "$REPO_ROOT/.work/runtime/runtime.env"

OUTPUT_DIR="${VM_OUTPUT_DIR:-$REPO_ROOT/artifacts/container/$COMMAND}"
REBUILD="${VM_REBUILD_TOOLCHAIN:-0}"
NO_CACHE="${VM_NO_CACHE:-0}"

lock_hash="$(
  cd "$REPO_ROOT"
  cat package.json pnpm-lock.yaml pnpm-workspace.yaml | sha256sum | cut -c1-16
)"
IMAGE="${VM_TOOLCHAIN_IMAGE:-violentmonkey-toolchain:local-$lock_hash}"
CONTAINER="vm-toolchain-$(date +%s)-$$"

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

cleanup() {
  engine rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

if [ "$REBUILD" = 1 ] || ! engine image inspect "$IMAGE" >/dev/null 2>&1; then
  build_args=""
  if [ "$NO_CACHE" = 1 ]; then
    build_args="--no-cache --pull"
  fi
  # Intentionally allow word splitting for the fixed build_args values above.
  # shellcheck disable=SC2086
  engine build $build_args \
    --tag "$IMAGE" \
    --file "$REPO_ROOT/containers/toolchain/Dockerfile" \
    "$REPO_ROOT"
fi

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

engine create \
  --name "$CONTAINER" \
  --network none \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --env "VM_RUNTIME_KIND=$VM_SELECTED_KIND" \
  --env "VM_RUNTIME_ENDPOINT=$VM_SELECTED_ENDPOINT" \
  "$IMAGE" "$COMMAND" "$@" >/dev/null

engine cp "$REPO_ROOT/." "$CONTAINER:/input"

set +e
engine start --attach "$CONTAINER"
exit_code=$?
set -e

engine cp "$CONTAINER:/output/." "$OUTPUT_DIR" >/dev/null 2>&1 || true

if [ -f "$OUTPUT_DIR/run-result.json" ]; then
  cat "$OUTPUT_DIR/run-result.json"
else
  printf '{"schemaVersion":1,"status":"failure","exitCode":%s,"message":"container produced no run-result.json"}\n' "$exit_code"
fi

exit "$exit_code"
