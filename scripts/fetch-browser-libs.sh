#!/usr/bin/env bash
# Local (rootless) Chromium dependency fetch: download arm64 .deb packages from
# the Debian pool and extract them under ./local-libs. No package manager state
# is touched; the headless shell finds them via LD_LIBRARY_PATH.
#
# Versions are pinned to Debian 12 (bookworm) builds because the container's
# glibc is 2.36; newer pool entries from trixie require GLIBC_2.38 and fail to
# load. Each entry is "pool component|package name|exact version".
set -euo pipefail

BASE="https://deb.debian.org/debian/pool/main"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="$ROOT/local-libs"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PKGS=(
  "n/nspr|libnspr4|4.35-1"
  "n/nss|libnss3|3.87.1-1+deb12u2"
  "a/atk1.0|libatk1.0-0|2.36.0-2"
  "d/dbus|libdbus-1-3|1.14.10-1~deb12u1"
  "libx/libxcomposite|libxcomposite1|0.4.6-1"
  "libx/libxdamage|libxdamage1|1.1.6-1"
  "libx/libxfixes|libxfixes3|6.0.0-2"
  "libx/libxrandr|libxrandr2|1.5.2-2+b1"
  "m/mesa|libgbm1|22.3.6-1+deb12u2"
  "libx/libxkbcommon|libxkbcommon0|1.5.0-1"
  "libx/libxi|libxi6|1.8-1+b1"
  "libd/libdrm|libdrm2|2.4.114-1+b1"
  "a/alsa-lib|libasound2|1.2.8-1+b1"
  "a/at-spi2-core|libatspi2.0-0|2.46.0-5"
  "w/wayland|libwayland-server0|1.21.0-1"
)

fetch() {
  local component="$1" pkg="$2" version="$3"
  local listing deb url
  listing="$BASE/$component/"
  deb="$(curl -fsSL "$listing" | grep -o "${pkg}_${version}_arm64.deb" | head -1)"
  if [ -z "$deb" ]; then
    echo "package not found: ${pkg}_${version}_arm64 under $listing" >&2
    exit 1
  fi
  url="$listing$deb"
  echo "fetch $deb"
  curl -fsSL "$url" -o "$WORK/$deb"
  dpkg-deb -x "$WORK/$deb" "$PREFIX"
}

rm -rf "$PREFIX"
for entry in "${PKGS[@]}"; do
  IFS='|' read -r component pkg version <<< "$entry"
  fetch "$component" "$pkg" "$version"
done

echo
echo "extracted under $PREFIX"
