#!/usr/bin/env bash
set -euo pipefail
BIN=/usr/local/share/neon/bin
PG=/usr/local/share/neon/pg_install
for b in pageserver safekeeper storage_broker storage_controller compute_ctl; do
  test -x "$BIN/$b" || { echo "MISSING $b"; exit 1; }
done
"$BIN/pageserver" --version
echo "--- pg_install inventory ---"
ls "$PG"
for v in $(ls "$PG"); do
  test -x "$PG/$v/bin/postgres" && echo "$v: $("$PG/$v/bin/postgres" --version)" || echo "$v: no postgres binary"
done
test -x "$PG/vanilla_v17/bin/initdb" && echo "vanilla_v17: OK (storcon DB host)" || echo "WARNING: vanilla_v17 missing — see Task 6 fallback"
node --version
echo "ALL BINARIES OK"
