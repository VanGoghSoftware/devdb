#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <pg-install-root>" >&2
  exit 2
fi

readonly pg_install_root=$1

fail() {
  echo "promised extension tripwire: $*" >&2
  exit 1
}

require_file() {
  local path=$1
  [[ -f "$path" ]] || fail "missing $path"
}

require_glob() {
  local pattern=$1
  compgen -G "$pattern" >/dev/null || fail "no files match $pattern"
}

control_version() {
  local control=$1
  sed -nE "s/^[[:space:]]*default_version[[:space:]]*=[[:space:]]*'([^']+)'.*/\1/p" "$control" | head -n 1
}

require_version() {
  local control=$1
  local want=$2
  local got
  got=$(control_version "$control")
  [[ "$got" == "$want" ]] || fail "$control default_version is ${got:-missing}, want $want"
}

seen_14=false
seen_15=false
seen_16=false
seen_17=false
for install in "$pg_install_root"/v[0-9]*; do
  [[ -d "$install" ]] || continue
  major=${install##*/v}
  case "$major" in
    14|15|16|17) ;;
    *) fail "unsupported PostgreSQL install ${install##*/}" ;;
  esac
  case "$major" in
    14) seen_14=true ;;
    15) seen_15=true ;;
    16) seen_16=true ;;
    17) seen_17=true ;;
  esac

  pg_config="$install/bin/pg_config"
  [[ -x "$pg_config" ]] || fail "missing executable $pg_config"
  share="$($pg_config --sharedir)/extension"
  pkglib="$($pg_config --pkglibdir)"

  require_file "$share/pg_cron.control"
  require_glob "$share/pg_cron--*.sql"
  require_file "$pkglib/pg_cron.so"
  require_version "$share/pg_cron.control" "1.6"

  require_file "$share/vector.control"
  require_glob "$share/vector--*.sql"
  require_file "$pkglib/vector.so"
  require_version "$share/vector.control" "0.8.0"

  postgis_version=3.3.3
  if [[ "$major" == 17 ]]; then
    postgis_version=3.5.0
  fi
  require_file "$share/postgis.control"
  require_glob "$share/postgis--*.sql"
  require_file "$pkglib/postgis-3.so"
  require_version "$share/postgis.control" "$postgis_version"

  shopt -s nullglob
  libraries=("$pkglib/pg_cron.so" "$pkglib/vector.so" "$pkglib"/postgis*.so)
  shopt -u nullglob
  for library in "${libraries[@]}"; do
    if ! dependencies="$(ldd "$library" 2>&1)"; then
      fail "ldd failed for $library: $dependencies"
    fi
    if grep -Fq 'not found' <<<"$dependencies"; then
      fail "unresolved dependency for $library: $dependencies"
    fi
  done

  echo "promised extension tripwire: PostgreSQL $major has pg_cron 1.6, vector 0.8.0, and postgis $postgis_version"
done

[[ "$seen_14" == true ]] || fail "missing PostgreSQL v14 under $pg_install_root"
[[ "$seen_15" == true ]] || fail "missing PostgreSQL v15 under $pg_install_root"
[[ "$seen_16" == true ]] || fail "missing PostgreSQL v16 under $pg_install_root"
[[ "$seen_17" == true ]] || fail "missing PostgreSQL v17 under $pg_install_root"
