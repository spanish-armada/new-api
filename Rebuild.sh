#!/usr/bin/env bash
#
# Rebuild the new-api image from this working tree and replace the running
# container, verifying that the new binary actually carries the current web
# console. A failed build stops here instead of restarting the old image.
#
# Usage:
#   ./Rebuild.sh              build (with cache) and replace the container
#   ./Rebuild.sh --no-cache   full rebuild, ignores Docker layer cache
#   sudo ./Rebuild.sh         when the current user cannot reach the daemon
#
# Overridable environment variables:
#   IMAGE                 image tag to build and run (default calciumion/new-api:latest)
#   COMPOSE_SERVICE       compose service to recreate     (default new-api)
#   HEALTH_PORT           port the container publishes    (default 3000)
#   GOPROXY_ARG           Go module proxy for the build   (default https://goproxy.cn,direct)
#   GOSUMDB_ARG           checksum database for the build (default sum.golang.google.cn;
#                         sum.golang.org is unreachable from some networks)
#   BUN_REGISTRY          npm registry mirror for the frontend build, empty keeps
#                         the default registry (e.g. https://registry.npmmirror.com)
#   FRONTEND_MARKER       string proving the embedded web console is current
#                         (default "Copy sign-in link")

set -euo pipefail

readonly ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
readonly IMAGE=${IMAGE:-calciumion/new-api:latest}
readonly COMPOSE_SERVICE=${COMPOSE_SERVICE:-new-api}
readonly HEALTH_PORT=${HEALTH_PORT:-3000}
readonly GOPROXY_ARG=${GOPROXY_ARG:-https://goproxy.cn,direct}
readonly GOSUMDB_ARG=${GOSUMDB_ARG:-sum.golang.google.cn}
readonly FRONTEND_MARKER=${FRONTEND_MARKER:-Copy sign-in link}
readonly BUN_REGISTRY=${BUN_REGISTRY:-}
readonly HEALTH_URL="http://127.0.0.1:${HEALTH_PORT}/api/status"
readonly HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-120}

NO_CACHE=0
for arg in "$@"; do
  case "$arg" in
    --no-cache) NO_CACHE=1 ;;
    -h | --help)
      # Everything from the second line up to the first non-comment line.
      awk 'NR > 1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"
      exit 0
      ;;
    *)
      printf 'ERROR: unknown argument: %s\n' "$arg" >&2
      exit 2
      ;;
  esac
done

log() { printf '\n== %s ==\n' "$*"; }
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

cd "$ROOT_DIR"

# --- prerequisites -----------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH"

DOCKER=docker
if ! docker info >/dev/null 2>&1; then
  if sudo -n docker info >/dev/null 2>&1; then
    DOCKER="sudo docker"
    log "using sudo docker (current user cannot reach the daemon)"
  else
    die "cannot reach the Docker daemon; run this script with sudo"
  fi
fi

$DOCKER compose version >/dev/null 2>&1 || die "the docker compose plugin is unavailable"

[[ -f Dockerfile ]] || die "Dockerfile not found in $ROOT_DIR"
[[ -d web ]] || die "web/ not found in $ROOT_DIR"

# --- remember the image being replaced --------------------------------------
ROLLBACK_TAG="${IMAGE}-rollback-$(date +%Y%m%d-%H%M%S)"
PREVIOUS_ID=$($DOCKER image inspect "$IMAGE" --format '{{.Id}}' 2>/dev/null || true)
if [[ -n "$PREVIOUS_ID" ]]; then
  $DOCKER tag "$IMAGE" "$ROLLBACK_TAG"
  log "previous image kept as $ROLLBACK_TAG ($PREVIOUS_ID)"
else
  log "no existing $IMAGE; nothing to roll back to"
fi

# --- build -------------------------------------------------------------------
BUILD_ARGS=(--pull --build-arg "GOPROXY=${GOPROXY_ARG}" --build-arg "GOSUMDB=${GOSUMDB_ARG}" -t "$IMAGE")
if [[ -n "$BUN_REGISTRY" ]]; then
  BUILD_ARGS+=(--build-arg "BUN_CONFIG_REGISTRY=${BUN_REGISTRY}")
fi
if [[ "$NO_CACHE" == "1" ]]; then
  BUILD_ARGS=(--no-cache "${BUILD_ARGS[@]}")
fi

# --progress belongs to buildx; the legacy builder rejects the flag outright.
if $DOCKER buildx version >/dev/null 2>&1; then
  BUILD_ARGS=(--progress "${BUILD_PROGRESS:-plain}" "${BUILD_ARGS[@]}")
  BUILDER="buildx"
else
  BUILDER="legacy"
fi
log "building $IMAGE (builder: $BUILDER)"
if [[ "$BUILDER" == "legacy" ]]; then
  log "buildx is absent, so stage progress lines are not available; output is still streamed"
fi
log "cache: $([[ "$NO_CACHE" == "1" ]] && echo "disabled (--no-cache, expect several minutes)" || echo enabled)"
log "live log: tail -f /tmp/new-api-build.log"
if [[ -z "$BUN_REGISTRY" ]]; then
  log "npm registry: default; BUN_REGISTRY=https://registry.npmmirror.com speeds up a slow network"
fi
set +e
# Stream every line: piping through tail would hide the whole build until it ends.
$DOCKER build "${BUILD_ARGS[@]}" . 2>&1 | tee /tmp/new-api-build.log
BUILD_STATUS=${PIPESTATUS[0]}
set -e
if [[ "$BUILD_STATUS" -eq 130 || "$BUILD_STATUS" -eq 143 ]]; then
  log "build interrupted; the running container was not touched"
  log "resume with a cached build: sudo ./Rebuild.sh"
  exit 130
fi
if [[ "$BUILD_STATUS" -ne 0 ]]; then
  die "docker build failed; the container was not touched (full log: /tmp/new-api-build.log)"
fi

# --- verify the binary carries the new web console ---------------------------
log "verifying the embedded web console (marker: $FRONTEND_MARKER)"
MARKER_COUNT=$($DOCKER run --rm --entrypoint sh "$IMAGE" -c \
  "grep -a -c \"${FRONTEND_MARKER}\" /new-api || true" | tr -dc '0-9')
MARKER_COUNT=${MARKER_COUNT:-0}
if [[ "${MARKER_COUNT:-0}" -lt 1 ]]; then
  cat <<EOF
ERROR: the built binary does not contain "${FRONTEND_MARKER}",
so the image was built without the current web console.

The running container was left untouched. Check these first:
  - the build really used this directory: the frontend stage runs
    "bun install --frozen-lockfile && bun run build" inside the image
  - the frontend stage did not fail silently; see /tmp/new-api-build.log
  - rebuild with --no-cache when the layer cache is suspect

When the marker legitimately changes, override it:
  FRONTEND_MARKER="some other string" ./Rebuild.sh
EOF
  exit 1
fi
log "marker matches: $MARKER_COUNT"

# --- replace the container ---------------------------------------------------
log "recreating $COMPOSE_SERVICE"
$DOCKER compose up -d --pull never --force-recreate "$COMPOSE_SERVICE"

# --- wait for health ---------------------------------------------------------
log "waiting for $HEALTH_URL (up to ${HEALTH_TIMEOUT}s)"
deadline=$((SECONDS + HEALTH_TIMEOUT))
healthy=0
while ((SECONDS < deadline)); do
  if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 3
done

if [[ "$healthy" != "1" ]]; then
  printf '\nERROR: %s did not answer within %ss.\n' "$HEALTH_URL" "$HEALTH_TIMEOUT" >&2
  $DOCKER compose logs --tail=40 "$COMPOSE_SERVICE" >&2 || true
  if [[ -n "$PREVIOUS_ID" ]]; then
    printf '\nRoll back with:\n  %s tag %s %s\n  %s compose up -d --pull never --force-recreate %s\n' \
      "$DOCKER" "$ROLLBACK_TAG" "$IMAGE" "$DOCKER" "$COMPOSE_SERVICE" >&2
  fi
  exit 1
fi

log "done"
$DOCKER image inspect "$IMAGE" --format 'image: {{.Id}} ({{.Created}})'
$DOCKER compose ps "$COMPOSE_SERVICE"
printf '\nweb console marker present in the image; serving on http://127.0.0.1:%s/\n' "$HEALTH_PORT"
