#!/usr/bin/env bash
# Launches the local development postgres in docker.
#
#   ./start-psql-dev.sh          start (or reuse) the container and wait for it
#   ./start-psql-dev.sh stop     stop the container, keep the data
#   ./start-psql-dev.sh reset    delete the container *and* its data volume
#   ./start-psql-dev.sh psql     open an interactive shell against the database
#
# Matches the default DATABASE_URL in src/config.js:
#   postgres://mvlo:mvlo@127.0.0.1:5433/mvlo_ranked
set -euo pipefail

CONTAINER=mvlo-ranked-psql
VOLUME=mvlo-ranked-pgdata
IMAGE=postgres:16-alpine
PORT=${PGPORT_DEV:-5433}
DB=mvlo_ranked
USER=mvlo
PASSWORD=mvlo

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
  psql)
    exec docker exec -it "$CONTAINER" psql -U "$USER" -d "$DB"
    ;;
  start) ;;
  *) die "unknown command '${1}' (expected: start, stop, reset, psql)" ;;
esac

if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo missing)" = "true" ]; then
  echo "$CONTAINER is already running"
elif docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "starting existing container $CONTAINER..."
  docker start "$CONTAINER" >/dev/null
else
  echo "creating container $CONTAINER from $IMAGE..."
  docker run -d \
    --name "$CONTAINER" \
    -e POSTGRES_USER="$USER" \
    -e POSTGRES_PASSWORD="$PASSWORD" \
    -e POSTGRES_DB="$DB" \
    -p "127.0.0.1:${PORT}:5432" \
    -v "${VOLUME}:/var/lib/postgresql/data" \
    --restart unless-stopped \
    "$IMAGE" >/dev/null
fi

printf 'waiting for postgres to accept connections'
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -U "$USER" -d "$DB" >/dev/null 2>&1; then
    echo
    echo "postgres is ready on 127.0.0.1:${PORT}"
    echo "DATABASE_URL=postgres://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${DB}"
    exit 0
  fi
  printf '.'
  sleep 1
done

echo
die "postgres did not become ready in time - check 'docker logs $CONTAINER'"
