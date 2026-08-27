#!/bin/sh
set -eu

COMMAND="${1:-ci}"
if [ "$#" -gt 0 ]; then
  shift
fi

INPUT_DIR="${VM_INPUT_DIR:-/input}"
WORK_DIR="${VM_WORK_DIR:-/work}"
OUTPUT_DIR="${VM_OUTPUT_DIR:-/output}"
EVENTS_FILE="$OUTPUT_DIR/run-events.jsonl"
RESULT_FILE="$OUTPUT_DIR/run-result.json"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STATUS="failure"
EXIT_CODE=1
FINALIZED=0

mkdir -p "$INPUT_DIR" "$WORK_DIR" "$OUTPUT_DIR"
rm -rf "$WORK_DIR"/* "$WORK_DIR"/.[!.]* "$WORK_DIR"/..?* 2>/dev/null || true
rm -rf "$OUTPUT_DIR"/* "$OUTPUT_DIR"/.[!.]* "$OUTPUT_DIR"/..?* 2>/dev/null || true

emit_event() {
  event_type="$1"
  event_status="$2"
  message="$3"
  jq -cn \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg type "$event_type" \
    --arg status "$event_status" \
    --arg message "$message" \
    '{schemaVersion:1,timestamp:$timestamp,type:$type,status:$status,message:$message}' \
    >> "$EVENTS_FILE"
}

finish() {
  EXIT_CODE=$?
  if [ "$FINALIZED" -eq 1 ]; then
    return
  fi
  FINALIZED=1
  trap - EXIT HUP INT TERM

  if [ "$EXIT_CODE" -eq 0 ]; then
    STATUS="success"
  else
    STATUS="failure"
  fi
  completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  jq -n \
    --arg status "$STATUS" \
    --argjson exitCode "$EXIT_CODE" \
    --arg command "$COMMAND" \
    --arg startedAt "$STARTED_AT" \
    --arg completedAt "$completed_at" \
    --arg sourceCommit "${SOURCE_COMMIT:-unknown}" \
    --arg nodeVersion "$(node --version)" \
    --arg pnpmVersion "$(pnpm --version)" \
    --arg runtimeKind "${VM_RUNTIME_KIND:-unknown}" \
    --arg runtimeEndpoint "${VM_RUNTIME_ENDPOINT:-unknown}" \
    '{
      schemaVersion: 1,
      status: $status,
      exitCode: $exitCode,
      command: $command,
      startedAt: $startedAt,
      completedAt: $completedAt,
      sourceCommit: $sourceCommit,
      toolchain: {node: $nodeVersion, pnpm: $pnpmVersion},
      runtime: {kind: $runtimeKind, endpoint: $runtimeEndpoint}
    }' > "$RESULT_FILE"
  emit_event "toolchain.completed" "$STATUS" "command=$COMMAND exitCode=$EXIT_CODE"
  cat "$RESULT_FILE"
  exit "$EXIT_CODE"
}

trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [ ! -f "$INPUT_DIR/package.json" ]; then
  emit_event "toolchain.validation" "failure" "package.json is missing from input"
  echo "package.json is missing from $INPUT_DIR" >&2
  exit 2
fi

emit_event "workspace.copy.started" "running" "copying source into ephemeral workspace"
rsync -rlt \
  --omit-dir-times \
  --exclude='/node_modules' \
  --exclude='/dist' \
  --exclude='/dist-mv3' \
  --exclude='/artifacts' \
  --exclude='/.work' \
  --exclude='/.env' \
  --exclude='/.env.*' \
  --exclude='/.secrets' \
  "$INPUT_DIR/" "$WORK_DIR/"
emit_event "workspace.copy.completed" "success" "source copied without local secret files"

cd "$WORK_DIR"

if ! sha256sum -c /opt/violentmonkey/dependency-inputs.sha256 >/dev/null 2>&1; then
  emit_event "toolchain.lock" "failure" "dependency inputs do not match the image"
  echo "The toolchain image does not match package.json, pnpm-lock.yaml, and pnpm-workspace.yaml." >&2
  echo "Rebuild the local toolchain image before running this command." >&2
  exit 3
fi

# Validate the copied source before adding image-owned dependencies.
sh ./tools/check-container-policy.sh

rm -rf node_modules
ln -s /opt/violentmonkey/node_modules node_modules

SOURCE_COMMIT="$(git rev-parse HEAD 2>/dev/null || printf unknown)"
emit_event "toolchain.started" "running" "command=$COMMAND sourceCommit=$SOURCE_COMMIT"

check_policy() {
  :
}

run_ci() {
  check_policy
  npm run ci
  npm run build
  npm run build:mv3
}

case "$COMMAND" in
  ci)
    run_ci
    ;;
  policy)
    check_policy
    ;;
  lint)
    check_policy
    npm run lint
    ;;
  test)
    npm run test
    ;;
  build)
    check_policy
    npm run build
    npm run build:mv3
    ;;
  build-mv2)
    check_policy
    npm run build
    ;;
  build-mv3)
    check_policy
    npm run build:mv3
    ;;
  pnpm)
    pnpm "$@"
    ;;
  exec)
    if [ "$#" -eq 0 ]; then
      echo "exec requires a command" >&2
      exit 64
    fi
    "$@"
    ;;
  *)
    echo "Unknown toolchain command: $COMMAND" >&2
    exit 64
    ;;
esac

for directory in dist dist-mv3; do
  if [ -d "$directory" ]; then
    cp -a "$directory" "$OUTPUT_DIR/$directory"
  fi
done

{
  find dist dist-mv3 -type f -print0 2>/dev/null || true
} | sort -z | xargs -0 -r sha256sum > "$OUTPUT_DIR/checksums.sha256"

jq -n \
  --arg sourceCommit "$SOURCE_COMMIT" \
  --arg command "$COMMAND" \
  --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg nodeVersion "$(node --version)" \
  --arg pnpmVersion "$(pnpm --version)" \
  --arg runtimeKind "${VM_RUNTIME_KIND:-unknown}" \
  --arg runtimeEndpoint "${VM_RUNTIME_ENDPOINT:-unknown}" \
  '{
    schemaVersion: 1,
    sourceCommit: $sourceCommit,
    command: $command,
    generatedAt: $generatedAt,
    toolchain: {node: $nodeVersion, pnpm: $pnpmVersion},
    runtime: {kind: $runtimeKind, endpoint: $runtimeEndpoint},
    outputs: ["dist", "dist-mv3", "checksums.sha256"]
  }' > "$OUTPUT_DIR/build-metadata.json"

emit_event "artifacts.exported" "success" "outputs written to /output"
