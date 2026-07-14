#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <pg-install-root>" >&2
  exit 2
fi

readonly pg_install_root=$1
readonly jobs=${EXTENSION_JOBS:-2}

require_env() {
  local name=$1
  if [[ -z ${!name:-} ]]; then
    echo "promised extension build: required environment variable $name is empty" >&2
    exit 2
  fi
}

for name in \
  PG_CRON_VERSION PG_CRON_SHA256 \
  SFCGAL_VERSION SFCGAL_SHA256 \
  POSTGIS_14_16_VERSION POSTGIS_14_16_SHA256 \
  POSTGIS_17_VERSION POSTGIS_17_SHA256; do
  require_env "$name"
done

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

download() {
  local url=$1
  local sha256=$2
  local output=$3

  curl --fail --location --retry 5 --retry-all-errors --output "$output" "$url"
  printf '%s  %s\n' "$sha256" "$output" | sha256sum --check
}

# oracle: neon compute/compute-node.Dockerfile (pg_cron-src, postgis-src)
# downloads these upstream source archives and verifies their pinned checksums.
download \
  "https://github.com/citusdata/pg_cron/archive/refs/tags/v${PG_CRON_VERSION}.tar.gz" \
  "$PG_CRON_SHA256" \
  "$work_dir/pg_cron.tar.gz"
download \
  "https://gitlab.com/sfcgal/SFCGAL/-/archive/v${SFCGAL_VERSION}/SFCGAL-v${SFCGAL_VERSION}.tar.gz" \
  "$SFCGAL_SHA256" \
  "$work_dir/sfcgal.tar.gz"
download \
  "https://download.osgeo.org/postgis/source/postgis-${POSTGIS_14_16_VERSION}.tar.gz" \
  "$POSTGIS_14_16_SHA256" \
  "$work_dir/postgis-${POSTGIS_14_16_VERSION}.tar.gz"
download \
  "https://download.osgeo.org/postgis/source/postgis-${POSTGIS_17_VERSION}.tar.gz" \
  "$POSTGIS_17_SHA256" \
  "$work_dir/postgis-${POSTGIS_17_VERSION}.tar.gz"

# oracle: neon compute/compute-node.Dockerfile (postgis-build) builds the pinned
# SFCGAL release once on Bookworm before compiling PostGIS with SFCGAL enabled.
mkdir "$work_dir/sfcgal"
tar -xzf "$work_dir/sfcgal.tar.gz" --strip-components=1 -C "$work_dir/sfcgal"
cmake -S "$work_dir/sfcgal" -B "$work_dir/sfcgal/build" \
  -GNinja -DCMAKE_BUILD_TYPE=Release
cmake --build "$work_dir/sfcgal/build" --parallel "$jobs"
cmake --install "$work_dir/sfcgal/build"
ldconfig

declare -A seen=()
for install in "$pg_install_root"/v[0-9]*; do
  [[ -d "$install" ]] || continue
  major=${install##*/v}
  case "$major" in
    14|15|16|17) ;;
    *)
      echo "promised extension build: unsupported PostgreSQL install ${install##*/}" >&2
      exit 1
      ;;
  esac
  seen[$major]=1

  pg_config="$install/bin/pg_config"
  if [[ ! -x "$pg_config" ]]; then
    echo "promised extension build: missing executable $pg_config" >&2
    exit 1
  fi

  cron_src="$work_dir/pg_cron-v$major"
  mkdir "$cron_src"
  tar -xzf "$work_dir/pg_cron.tar.gz" --strip-components=1 -C "$cron_src"
  # oracle: neon compute/compute-node.Dockerfile (pg_cron-build) builds with
  # PGXS and marks the control file trusted for the non-superuser compute role.
  make -C "$cron_src" -j"$jobs" PG_CONFIG="$pg_config"
  # oracle: neon scripts/ninstall.sh delegates to GNU install. The bundled
  # PGXS records its build-only absolute path, so use the runtime-equivalent
  # installer directly.
  make -C "$cron_src" PG_CONFIG="$pg_config" INSTALL=/usr/bin/install install
  cron_control="$($pg_config --sharedir)/extension/pg_cron.control"
  grep -qxF 'trusted = true' "$cron_control" || printf '%s\n' 'trusted = true' >>"$cron_control"

  case "$major" in
    14|15|16) postgis_version=$POSTGIS_14_16_VERSION ;;
    17) postgis_version=$POSTGIS_17_VERSION ;;
  esac
  postgis_src="$work_dir/postgis-v$major"
  mkdir "$postgis_src"
  tar -xzf "$work_dir/postgis-${postgis_version}.tar.gz" --strip-components=1 -C "$postgis_src"
  # oracle: neon compute/compute-node.Dockerfile (postgis-build) configures
  # PostGIS against the selected PostgreSQL and pinned SFCGAL installation.
  (
    cd "$postgis_src"
    ./autogen.sh
    ./configure --with-pgconfig="$pg_config" --with-sfcgal=/usr/local/bin/sfcgal-config
    make -j"$jobs"
    # oracle: neon scripts/ninstall.sh delegates to GNU install. Override the
    # build-only installer path inherited through the PGXS makefiles.
    make INSTALL=/usr/bin/install install
  )
  postgis_control="$($pg_config --sharedir)/extension/postgis.control"
  grep -qxF 'trusted = true' "$postgis_control" || printf '%s\n' 'trusted = true' >>"$postgis_control"

  echo "promised extension build: installed pg_cron ${PG_CRON_VERSION} and postgis ${postgis_version} for PostgreSQL ${major}"
done

for major in 14 15 16 17; do
  if [[ -z ${seen[$major]:-} ]]; then
    echo "promised extension build: missing PostgreSQL v${major} under $pg_install_root" >&2
    exit 1
  fi
done
