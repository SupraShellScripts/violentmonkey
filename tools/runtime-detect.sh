#!/usr/bin/env sh
set -eu

REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
STATE_DIR="$REPO_ROOT/.work/runtime"
ENV_FILE="$STATE_DIR/runtime.env"
JSON_FILE="$STATE_DIR/runtime.json"
mkdir -p "$STATE_DIR"

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\r//g; :a;N;$!ba;s/\n/\\n/g'
}

docker_probe() {
  if ! command -v docker >/dev/null 2>&1; then
    return 1
  fi
  if [ -n "${VM_DOCKER_CONTEXT:-}" ]; then
    docker --context "$VM_DOCKER_CONTEXT" version --format '{{.Server.Version}}|{{.Server.Os}}|{{.Server.Arch}}' 2>/dev/null
  elif [ -n "${VM_DOCKER_HOST:-}" ]; then
    DOCKER_HOST="$VM_DOCKER_HOST" docker version --format '{{.Server.Version}}|{{.Server.Os}}|{{.Server.Arch}}' 2>/dev/null
  else
    docker version --format '{{.Server.Version}}|{{.Server.Os}}|{{.Server.Arch}}' 2>/dev/null
  fi
}

docker_context() {
  if [ -n "${VM_DOCKER_CONTEXT:-}" ]; then
    printf '%s' "$VM_DOCKER_CONTEXT"
  else
    docker context show 2>/dev/null || printf default
  fi
}

docker_endpoint() {
  if [ -n "${VM_DOCKER_HOST:-}" ]; then
    printf '%s' "$VM_DOCKER_HOST"
    return
  fi
  context="$(docker_context)"
  docker context inspect "$context" --format '{{.Endpoints.docker.Host}}' 2>/dev/null || printf unknown
}

podman_probe() {
  command -v podman >/dev/null 2>&1 || return 1
  podman version --format '{{.Server.Version}}|{{.Server.Os}}|{{.Server.Arch}}' 2>/dev/null
}

write_result() {
  kind="$1"
  cli="$2"
  context="$3"
  endpoint="$4"
  version="$5"
  os="$6"
  arch="$7"
  remote="$8"
  act_compat="$9"

  {
    printf 'VM_SELECTED_KIND=%s\n' "$kind"
    printf 'VM_SELECTED_CLI=%s\n' "$cli"
    printf 'VM_SELECTED_CONTEXT=%s\n' "$context"
    printf 'VM_SELECTED_ENDPOINT=%s\n' "$endpoint"
    printf 'VM_SELECTED_VERSION=%s\n' "$version"
    printf 'VM_SELECTED_OS=%s\n' "$os"
    printf 'VM_SELECTED_ARCH=%s\n' "$arch"
    printf 'VM_SELECTED_REMOTE=%s\n' "$remote"
    printf 'VM_ACT_COMPATIBILITY=%s\n' "$act_compat"
  } > "$ENV_FILE"

  cat > "$JSON_FILE" <<EOF
{
  "schemaVersion": 1,
  "kind": "$(json_escape "$kind")",
  "cli": "$(json_escape "$cli")",
  "context": "$(json_escape "$context")",
  "endpoint": "$(json_escape "$endpoint")",
  "serverVersion": "$(json_escape "$version")",
  "serverOs": "$(json_escape "$os")",
  "serverArch": "$(json_escape "$arch")",
  "remote": $remote,
  "actCompatibility": "$(json_escape "$act_compat")",
  "selectedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
  cat "$JSON_FILE"
}

requested="${VM_CONTAINER_RUNTIME:-auto}"

case "$requested" in
  docker|auto)
    if probe="$(docker_probe)"; then
      version="$(printf '%s' "$probe" | cut -d'|' -f1)"
      os="$(printf '%s' "$probe" | cut -d'|' -f2)"
      arch="$(printf '%s' "$probe" | cut -d'|' -f3)"
      context="$(docker_context)"
      endpoint="$(docker_endpoint)"
      kind="DockerEngine"
      remote=false
      case "$context:$endpoint:${WSL_DISTRO_NAME:-}" in
        desktop-linux:*|*:npipe://*|*:unix://*/dockerDesktopLinuxEngine*)
          kind="DockerDesktop"
          ;;
        *:ssh://*|*:tcp://*|*:http://*|*:https://*)
          kind="RemoteDocker"
          remote=true
          ;;
        *:*:*)
          if [ -n "${WSL_DISTRO_NAME:-}" ]; then
            kind="WslEngine"
          fi
          ;;
      esac
      write_result "$kind" docker "$context" "$endpoint" "$version" "$os" "$arch" "$remote" supported
      exit 0
    fi
    if [ "$requested" = docker ]; then
      echo "Requested Docker runtime is not healthy." >&2
      exit 10
    fi
    ;;
  podman)
    ;;
  *)
    echo "Unsupported VM_CONTAINER_RUNTIME=$requested for POSIX launcher." >&2
    echo "Use tools/runtime-detect.ps1 for Windows WSL2 engine discovery." >&2
    exit 11
    ;;
esac

if probe="$(podman_probe)"; then
  version="$(printf '%s' "$probe" | cut -d'|' -f1)"
  os="$(printf '%s' "$probe" | cut -d'|' -f2)"
  arch="$(printf '%s' "$probe" | cut -d'|' -f3)"
  endpoint="${DOCKER_HOST:-podman-local}"
  write_result Podman podman "" "$endpoint" "$version" "$os" "$arch" false experimental
  exit 0
fi

echo "No healthy Docker-compatible runtime was found." >&2
echo "Set VM_CONTAINER_RUNTIME, VM_DOCKER_CONTEXT, or VM_DOCKER_HOST explicitly." >&2
exit 12
