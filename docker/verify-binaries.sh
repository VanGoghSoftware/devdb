#!/usr/bin/env bash
set -euo pipefail
BIN=/usr/local/share/neon/bin
PG=/usr/local/share/neon/pg_install
# Expected shipped majors — keep in sync with docker/BINARIES.md
EXPECTED_PG_VERSIONS=(14 15 16 17)

for b in pageserver safekeeper storage_broker storage_controller compute_ctl; do
  test -x "$BIN/$b" || { echo "MISSING $b"; exit 1; }
  if ldd "$BIN/$b" 2>/dev/null | grep -q "not found"; then
    echo "BROKEN LINKAGE for $b:"; ldd "$BIN/$b" | grep "not found"; exit 1
  fi
done
"$BIN/pageserver" --version

echo "--- pg_install inventory ---"
ls "$PG"
for v in "${EXPECTED_PG_VERSIONS[@]}"; do
  pgbin="$PG/v$v/bin/postgres"
  test -x "$pgbin" || { echo "MISSING pg_install v$v"; exit 1; }
  echo "v$v: $("$pgbin" --version)"
done
for d in "$PG"/*/; do
  name=$(basename "$d")
  case "$name" in v14|v15|v16|v17) ;; *) echo "extra pg_install dir: $name (informational)";; esac
done
test -x "$PG/vanilla_v17/bin/initdb" && echo "vanilla_v17: OK (storcon DB host)" || echo "WARNING: vanilla_v17 missing — see Task 6 fallback"
node --version
echo "ALL BINARIES OK"
