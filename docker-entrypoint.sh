#!/bin/sh
set -eu

mkdir -p /data

if [ "$(id -u)" = "0" ]; then
  chown -R node:node /data
  exec gosu node "$@"
fi

exec "$@"
