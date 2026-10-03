#!/bin/sh
# Container entrypoint. Fly volumes mount root-owned, so when started as root:
# make DATA_DIR writable for pwuser (the Playwright image's non-root user),
# then drop privileges. Chromium and the scans never run as root.
set -e
DATA="${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA"
  # Fix ownership only when it's wrong (first boot on a fresh volume), not on
  # every start — a full volume makes chown -R slow.
  if [ "$(stat -c %U "$DATA")" != "pwuser" ]; then
    chown -R pwuser:pwuser "$DATA"
  fi
  exec setpriv --reuid=pwuser --regid=pwuser --init-groups "$@"
fi
exec "$@"
