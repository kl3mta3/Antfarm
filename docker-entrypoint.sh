#!/bin/sh
# The house farm is saved in its own folder, /data/antfarm. The server runs as
# the unprivileged "node" user, and a folder mounted from the host is usually
# owned by root, so saves were refused. This starts as root only long enough to
# hand the farm's own folder to node, then runs the server as node.
#
# It only ever touches that one folder and the farm's own save files, and only
# when the folder holds nothing else. An earlier version changed ownership of
# everything under /data recursively; when /data was the host's own /data (a
# bind mount), that reached other software's files too.
set -e

DATA_FILE="${ANTFARM_DATA:-/data/antfarm/house.json}"
DATA_DIR="$(dirname "$DATA_FILE")"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"

  # A save from before the farm had its own folder moves into it.
  if [ "$DATA_DIR" != "/data" ] && [ -f /data/house.json ] && [ ! -e "$DATA_FILE" ]; then
    mv /data/house.json "$DATA_FILE"
  fi

  # The folder itself and the farm's own files, and nothing else. If anything
  # else lives in that folder, leave ownership alone and say so.
  others="$(find "$DATA_DIR" -mindepth 1 -maxdepth 1 ! -name 'house.json*' | head -n 1)"
  if [ -z "$others" ]; then
    chown node:node "$DATA_DIR"
    find "$DATA_DIR" -mindepth 1 -maxdepth 1 -name 'house.json*' -exec chown node:node {} \;
  else
    echo "antfarm: $DATA_DIR contains files that aren't the farm's; leaving its ownership alone." >&2
  fi

  exec su-exec node "$@"
fi

exec "$@"
