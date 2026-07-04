#!/usr/bin/env bash
# Manual smoke: pull the real latest compute-node build for one major from Docker Hub through a
# LIVE devdb at localhost:4400 and watch it through the gate. Usage: scripts/pg-pull-smoke.sh 17
set -euo pipefail
MAJOR="${1:?usage: pg-pull-smoke.sh <major>}"
BASE="${DEVDB_BASE:-http://localhost:4400}"
echo "→ checking for updates (egress to Docker Hub)…"
curl -fsS -X POST "$BASE/api/pg-builds/check" -H 'content-type: application/json' -d "{\"majors\":[$MAJOR]}" | tee /dev/stderr
echo "→ pulling latest v$MAJOR…"
BUILD_ID=$(curl -fsS -X POST "$BASE/api/pg-builds/pull" -H 'content-type: application/json' -d "{\"major\":$MAJOR}" | sed -n 's/.*"buildId":"\([^"]*\)".*/\1/p')
echo "build: $BUILD_ID — polling (Ctrl-C safe; state survives)"
while true; do
  STATUS=$(curl -fsS "$BASE/api/pg-builds" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d).find(b=>b.id==='$BUILD_ID');console.log(r?r.status+' '+(r.version??'')+' '+(r.error??''):'gone')})")
  echo "  $STATUS"
  case "$STATUS" in ready*|failed*|gone*) break;; esac
  sleep 5
done
