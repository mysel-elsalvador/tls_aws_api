#!/usr/bin/env bash
# Starts a throwaway PostgreSQL on a unix socket, runs the tests against it
# (schema from ../aws/migrations), and removes it. Same idea as
# ../aws/scripts/test-pg.sh; PG_BIN overrides where the binaries are.
set -euo pipefail
cd "$(dirname "$0")/.."
PG_BIN=${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)}
dir=$(mktemp -d)
trap '"$PG_BIN/pg_ctl" -D "$dir/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$dir"' EXIT

"$PG_BIN/initdb" -D "$dir/data" -U hub --auth=trust >/dev/null
"$PG_BIN/pg_ctl" -D "$dir/data" -l "$dir/log" -o "-k $dir -c listen_addresses='' -p 55433" -w start >/dev/null
echo "postgres: $("$PG_BIN/postgres" --version)"

HUB_TEST_PG=1 PGHOST=$dir PGPORT=55433 PGUSER=hub PGDATABASE=postgres npx vitest run "$@"
