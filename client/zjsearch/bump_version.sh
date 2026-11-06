#!/usr/bin/env bash
# Bump the fork version. Source of truth: client/zjsearch/package.json;
# searx/version_frozen.py's version fields are synced in the same step, so
# the runtime version and the Docker build's +sha stamp always move
# together (the build swaps the +0000 placeholder for the git sha).
#
#   ./bump_version.sh [major|minor|patch|X.Y.Z]   # default: patch
#
# PowerShell twin: bump_version.ps1 - keep the two in sync.

set -euo pipefail

cd "$(dirname "$0")"

pkg=package.json
frozen=../../searx/version_frozen.py

current=$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$pkg" | head -1)
if [ -z "$current" ]; then
  echo "error: no \"version\" field found in $pkg" >&2
  exit 1
fi

bump=${1:-patch}
case "$bump" in
  major|minor|patch)
    IFS=. read -r a b c <<EOF
$current
EOF
    case "$bump" in
      major) next="$((a + 1)).0.0" ;;
      minor) next="$a.$((b + 1)).0" ;;
      patch) next="$a.$b.$((c + 1))" ;;
    esac
    ;;
  *)
    next=$bump
    if ! printf '%s' "$next" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
      echo "error: not a version: $next (expected major|minor|patch|X.Y.Z)" >&2
      exit 1
    fi
    ;;
esac

if [ "$next" = "$current" ]; then
  echo "version is already $current - nothing to do"
  exit 0
fi

# no sed -i: BSD and GNU disagree on the backup argument; temp+mv is portable
sed "s|\"version\": \"$current\"|\"version\": \"$next\"|" "$pkg" > "$pkg.tmp"
mv "$pkg.tmp" "$pkg"
grep -q "\"version\": \"$next\"" "$pkg" || {
  echo "error: package.json update did not land" >&2
  exit 1
}

sed \
  -e "s|^VERSION_STRING = .*|VERSION_STRING = \"$next+0000\"|" \
  -e "s|^VERSION_TAG = .*|VERSION_TAG = \"$next\"|" \
  -e "s|^DOCKER_TAG = .*|DOCKER_TAG = \"$next\"|" \
  "$frozen" > "$frozen.tmp"
mv "$frozen.tmp" "$frozen"
grep -q "^VERSION_STRING = \"$next+0000\"$" "$frozen" || {
  echo "error: version_frozen.py update did not land" >&2
  exit 1
}

echo "bumped: $current -> $next"
echo "  $pkg"
echo "  $frozen (VERSION_STRING=$next+0000 -- Docker stamps the sha at build)"
