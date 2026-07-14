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
# vanilla_v17 = the storage_controller catalog DB (storcon_db) host. It MUST be
# TRUE upstream PostgreSQL, NOT the neon fork: the fork emits Neon-custom WAL
# (rmgr id 134) that FATALs storcon_db's crash recovery after an unclean stop
# when the neon extension isn't loaded during redo (Phase-1 Task-3 finding).
# Tripwire — the neon fork's `postgres --version` carries a 40-hex commit hash in
# parens ("postgres (PostgreSQL) 17.5 (fa1788475e...)"); true upstream prints a
# bare "postgres (PostgreSQL) 17.5". If the hash suffix appears here, someone
# reintroduced the fork-as-vanilla rmgr-134 durability regression — fail the fast
# gate NOW (today only the full integration suite would catch it).
# vanilla_v17 is a HARD requirement, not optional (final-review Minor 4): if it is
# absent, EmbeddedPostgres.resolveVanillaPgDir silently falls back to the neon-forked
# v17 — reintroducing the exact rmgr-134 crash-recovery regression through a side door.
# So a missing vanilla_v17/{postgres,initdb} FAILS the gate; the "Task 6 fallback"
# softness is obsolete now that true-upstream-vanilla is the settled design.
vanilla_pg="$PG/vanilla_v17/bin/postgres"
test -x "$vanilla_pg" || { echo "FAIL: vanilla_v17/bin/postgres missing — storcon would fall back to the neon fork (rmgr-134 regression)"; exit 1; }
test -x "$PG/vanilla_v17/bin/initdb" || { echo "FAIL: vanilla_v17/bin/initdb missing — storcon_db catalog host incomplete"; exit 1; }
vanilla_ver="$("$vanilla_pg" --version)"
if printf '%s' "$vanilla_ver" | grep -Eq '\([0-9a-f]{40}\)'; then
  echo "FAIL: vanilla_v17 is a neon-forked build, not true upstream — rmgr-134 crash-recovery regression"
  echo "  vanilla_v17 postgres --version = $vanilla_ver"
  echo "  (expected a bare 'postgres (PostgreSQL) NN.N', with NO 40-hex commit hash in parens)"
  exit 1
fi
echo "vanilla_v17: true-upstream OK, storcon DB host ($vanilla_ver)"
/usr/local/bin/verify-promised-extensions "$PG"
node --version
echo "ALL BINARIES OK"
