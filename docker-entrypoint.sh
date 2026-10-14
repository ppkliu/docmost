#!/usr/bin/env bash
set -e

mkdir -p /app/data/storage

if [ "$(id -u)" = "0" ]; then
  chown -R node:node /app/data/storage || true
  # Drop privileges with setpriv so the app replaces this process and receives
  # SIGTERM directly. `su` stays as the parent, and on SIGTERM it kills its
  # child after 2 seconds no matter what stop_grace_period says, which cuts the
  # collaboration server off before unsaved edits are written to the database.
  if setpriv --reuid=node --regid=node --init-groups true 2>/dev/null; then
    export HOME=/home/node USER=node LOGNAME=node
    exec setpriv --reuid=node --regid=node --init-groups "$@"
  fi
  exec su node -s /bin/bash -c 'exec "$0" "$@"' -- "$@"
fi

exec "$@"
