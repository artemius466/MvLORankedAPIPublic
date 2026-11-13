#!/usr/bin/env bash
# Launches the local development redis in docker.
#
#   ./start-redis-dev.sh          start (or reuse) the container and wait for it
#   ./start-redis-dev.sh stop     stop the container, keep the data
#   ./start-redis-dev.sh reset    delete the container *and* its data volume
#   ./start-redis-dev.sh cli      open an interactive redis-cli shell
#
# Matches the default REDIS_URL in src/config.js:
#   redis://127.0.0.1:6380
set -euo pipefail

CONTAINER=mvlo-ranked-redis
VOLUME=mvlo-ranked-redisdata
IMAGE=redis:8-alpine
PORT=${REDIS_PORT_DEV:-6380}

die() { echo "error: $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH"

# Rootless docker keeps its socket in the user runtime dir. If the CLI has no
# context pointing at it, the system socket is tried first and fails on
# permissions - fall back before giving up.
if ! docker info >/dev/null 2>&1 && [ -z "${DOCKER_HOST:-}" ]; then
  ROOTLESS_SOCK="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/docker.sock"
  if [ -S "$ROOTLESS_SOCK" ] && DOCKER_HOST="unix://${ROOTLESS_SOCK}" docker info >/dev/null 2>&1; then
    export DOCKER_HOST="unix://${ROOTLESS_SOCK}"
    echo "using rootless docker at ${ROOTLESS_SOCK}"
  fi
fi

if ! docker info >/dev/null 2>&1; then
  if sudo -n true 2>/dev/null || [ "$(id -u)" -eq 0 ]; then
    die "cannot talk to the docker daemon - is it running? try: sudo systemctl start docker"
  fi
  echo "cannot talk to the docker daemon as $(id -un)." >&2
  echo "either add yourself to the docker group once (then log out and back in):" >&2
  echo "    sudo usermod -aG docker $(id -un)" >&2
  echo "or re-run this script with sudo:" >&2
  echo "    sudo $0 ${*:-start}" >&2
  exit 1
fi

case "${1:-start}" in
  stop)
    docker stop "$CONTAINER" >/dev/null 2>&1 && echo "stopped $CONTAINER" || echo "$CONTAINER was not running"
    exit 0
    ;;
  reset)
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    docker volume rm "$VOLUME" >/dev/null 2>&1 || true
    echo "removed container $CONTAINER and volume $VOLUME"
    exit 0
    ;;
  cli)
    exec docker exec -it "$CONTAINER" redis-cli
    ;;
  start) ;;
  *) die "unknown command '${1}' (expected: start, stop, reset, cli)" ;;
esac

if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo missing)" = "true" ]; then
  echo "$CONTAINER is already running"
elif docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "starting existing container $CONTAINER..."
  docker start "$CONTAINER" >/dev/null
else
  echo "creating container $CONTAINER from $IMAGE..."
  # No auth: bound to 127.0.0.1 only, same trust model as start-psql-dev.sh's
  # fixed dev credentials - this is a local dev instance, not a shared one.
  # Default image persistence (periodic RDB snapshot + save-on-SIGTERM) is
  # enough to survive a `stop` + `start`; queue tickets/matches expire in
  # seconds to minutes anyway, so there is nothing here worth tuning further.
  docker run -d \
    --name "$CONTAINER" \
    -p "127.0.0.1:${PORT}:6379" \
    -v "${VOLUME}:/data" \
    --restart unless-stopped \
    "$IMAGE" >/dev/null
fi

printf 'waiting for redis to accept connections'
for _ in $(seq 1 60); do
  if [ "$(docker exec "$CONTAINER" redis-cli ping 2>/dev/null)" = "PONG" ]; then
    echo
    echo "redis is ready on 127.0.0.1:${PORT}"
    echo "REDIS_URL=redis://127.0.0.1:${PORT}"
    exit 0
  fi
  printf '.'
  sleep 1
done

echo
die "redis did not become ready in time - check 'docker logs $CONTAINER'"
