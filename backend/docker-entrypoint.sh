#!/bin/sh
set -eu

role="${BACKEND_COMPONENT:-${COMPONENT:-api}}"

case "$role" in
  api)
    exec node src/api/server.js
    ;;
  indexer)
    exec node src/jobs/indexer.js watch
    ;;
  scheduler)
    exec node src/jobs/scheduler.js
    ;;
  factory)
    exec node src/modules/gameMaster/factory/index.js --chain
    ;;
  *)
    echo "unknown backend component: $role" >&2
    echo "expected one of: api, indexer, scheduler, factory" >&2
    exit 64
    ;;
esac
