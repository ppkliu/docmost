#!/usr/bin/env bash
set -e

mkdir -p /app/data/storage

if [ "$(id -u)" = "0" ]; then
  chown -R node:node /app/data/storage || true
  exec su node -s /bin/bash -c 'exec "$0" "$@"' -- "$@"
fi

exec "$@"
