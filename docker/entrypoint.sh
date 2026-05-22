#!/bin/sh
# Container entrypoint. Runs as root, fixes ownership of DATA_DIR (which
# is usually a docker named volume — those are created root:root on the
# host side regardless of what the image baked in), then drops to the
# unprivileged shep user via su-exec and execs the server.
#
# Why: the previous USER=shep directive caused "mkdir /data/plugins:
# permission denied" the first time a plugin tried to create a binary
# cache under a fresh shepherd_data volume.

set -e

DATA_DIR=${DATA_DIR:-/data}
mkdir -p "$DATA_DIR"
chown -R shep:shep "$DATA_DIR"

exec su-exec shep:shep "$@"
