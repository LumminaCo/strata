#!/bin/sh
set -eu

if [ -d /opt/strata-pg-trust ]; then
    install -m 644 /opt/strata-pg/ca.pem /opt/strata-pg-trust/ca.pem
fi
exec docker-entrypoint.sh "$@"
