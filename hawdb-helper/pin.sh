#!/usr/bin/env bash
# Pins a released petal-hawdb in Petal: sets HELPER_VERSION and each build's SHA-256 in
# graph/hawdbHelper.ts from the release's SHA256SUMS.
#
#   hawdb-helper/pin.sh 0.1.0                  # reads the release's SHA256SUMS
#   hawdb-helper/pin.sh 0.1.0 path/SHA256SUMS  # or a copy of it
set -euo pipefail

version="${1:?usage: hawdb-helper/pin.sh <version> [SHA256SUMS]}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "invalid HawDB helper version: ${version}" >&2
  exit 1
fi
root="$(cd "$(dirname "$0")/.." && pwd)"
file="$root/graph/hawdbHelper.ts"
url="https://github.com/JetSquirrel/petal/releases/download/hawdb-helper-v${version}/SHA256SUMS"
work="$(mktemp -d "$root/graph/.pin-hawdb.XXXXXX")"
trap 'rm -f "$work/SHA256SUMS" "$work/hawdbHelper.ts"; rmdir "$work"' EXIT

sums="${2:-$work/SHA256SUMS}"
if [ -z "${2:-}" ]; then
  curl -fsSL "$url" -o "$sums" || { echo "couldn't read $url" >&2; exit 1; }
fi

# Stage the complete update so a truncated or malformed manifest leaves the old pins usable.
cp -p "$file" "$work/hawdbHelper.ts"
awk -v version="$version" '
  function fail(message) {
    print message > "/dev/stderr"
    failed = 1
    exit 1
  }
  FILENAME == ARGV[1] {
    sub(/\r$/, "")
    if (!NF) next
    asset = $2
    sub(/^\*/, "", asset)
    if (NF != 2 || length($1) != 64 || $1 ~ /[^0-9a-f]/ || asset !~ /^petal-hawdb-[a-z0-9_-]+\.gz$/)
      fail("invalid SHA256SUMS entry: " $0)
    if (asset in sums) fail("duplicate asset: " asset)
    sums[asset] = $1
    next
  }
  /^export const HELPER_VERSION = / {
    versions++
    print "export const HELPER_VERSION = \"" version "\";"
    next
  }
  /target: "[a-z0-9_-]+", sha256: "[0-9a-f]*"/ {
    target = $0
    sub(/^.*target: "/, "", target)
    sub(/".*$/, "", target)
    asset = "petal-hawdb-" target ".gz"
    if (!(asset in sums)) fail("missing checksum for " asset)
    sub(/sha256: "[0-9a-f]*"/, "sha256: \"" sums[asset] "\"")
    delete sums[asset]
    pinned++
  }
  { print }
  END {
    if (failed) exit 1
    for (asset in sums) fail("unexpected asset: " asset)
    if (versions != 1 || !pinned) fail("could not find the helper version or builds to pin")
  }
' "$sums" "$file" > "$work/hawdbHelper.ts"
mv -f "$work/hawdbHelper.ts" "$file"

echo "pinned petal-hawdb ${version}"
grep -n "HELPER_VERSION = \|sha256: " "$file"
