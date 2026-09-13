#!/bin/sh
# The house farm is saved in /data. A volume mounted there is often owned by
# root (Coolify's was), and the server runs as the unprivileged "node" user,
# so every save was refused and the farm was lost on each redeploy. Starting
# as root just long enough to hand /data to node fixes that whatever the
# volume's ownership, and the server itself still never runs as root.
set -e

DATA_DIR="$(dirname "${ANTFARM_DATA:-/data/house.json}")"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
  exec su-exec node "$@"
fi

exec "$@"
