#!/bin/sh
# Prepares /data (a fresh volume belongs to root), then runs Phi as the unprivileged user.
set -eu
mkdir -p "$PROJECTS_DIR" "$HOME"
chown phi:phi "$PROJECTS_DIR" "$HOME"
exec setpriv --reuid=phi --regid=phi --init-groups "$@"
