#!/usr/bin/env bash
# Pins a released petal-hawdb in Petal: sets HELPER_VERSION and each build's SHA-256 in
# graph/hawdbHelper.ts from the release's SHA256SUMS.
#
#   hawdb-helper/pin.sh 0.1.0                  # reads the release's SHA256SUMS
#   hawdb-helper/pin.sh 0.1.0 path/SHA256SUMS  # or a copy of it
set -euo pipefail

version="${1:?usage: hawdb-helper/pin.sh <version> [SHA256SUMS]}"
root="$(cd "$(dirname "$0")/.." && pwd)"
file="$root/graph/hawdbHelper.ts"
url="https://github.com/JetSquirrel/petal/releases/download/hawdb-helper-v${version}/SHA256SUMS"

if [ -n "${2:-}" ]; then
  sums="$(cat "$2")"
else
  sums="$(curl -fsSL "$url")" || { echo "couldn't read $url" >&2; exit 1; }
fi

sed -i.bak "s/^export const HELPER_VERSION = \".*\";/export const HELPER_VERSION = \"${version}\";/" "$file"
pinned=0
while read -r sum name; do
  [ -n "$sum" ] || continue
  target="${name#petal-hawdb-}"
  target="${target%.gz}"
  if ! grep -q "target: \"${target}\"" "$file"; then
    echo "no build for ${target} in $file" >&2
    exit 1
  fi
  sed -i.bak "s/target: \"${target}\", sha256: \"[0-9a-f]*\"/target: \"${target}\", sha256: \"${sum}\"/" "$file"
  pinned=$((pinned + 1))
done <<< "$sums"
rm -f "$file.bak"

echo "pinned petal-hawdb ${version}: ${pinned} builds"
grep -n "HELPER_VERSION = \|sha256: " "$file"
