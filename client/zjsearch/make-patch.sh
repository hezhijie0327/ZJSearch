#!/usr/bin/env bash
# Export the zjsearch theme changes (client sources + server data templates)
# as a single patch to apply on another machine:
#
#   ./make-patch.sh [base-ref] [out-file]
#   # on the target machine:
#   git apply --check zjsearch-theme.patch && git apply zjsearch-theme.patch
#   cd client/zjsearch && npm install && npm run build
#
# Default base: master (falls back to origin/master; if neither exists,
# origin/master is fetched from origin first), so the patch carries the whole
# theme delta relative to master. The diff runs against the working tree, so
# uncommitted edits are included (untracked files are not). Included paths:
# client/zjsearch, searx/templates/zjsearch and every searx/ python change
# (searx/static is excluded) - the templates alone are not enough: the
# special-query answers (stats/hash/self-info/time-zone/random) carry their
# structured *data* payloads from the python side, and new templates running
# against old python only produce jinja2 Undefined warnings plus raw-text
# answers.

set -euo pipefail

base=${1:-}
if [ -z "$base" ]; then
  # a stale remote-tracking ref would sweep upstream-only changes into the
  # patch (e.g. engine fixes made upstream after the last fetch); refresh it
  # best-effort - offline runs keep whatever ref they already have
  if ! git fetch --quiet origin +refs/heads/master:refs/remotes/origin/master 2>/dev/null; then
    echo "WARNING: could not refresh origin/master - the local ref may be stale" >&2
    echo "WARNING: and the patch may include unrelated upstream changes" >&2
  fi
  for ref in origin/master master; do
    if git rev-parse -q --verify "$ref" >/dev/null 2>&1; then
      base=$ref
      break
    fi
  done
  if [ -z "$base" ]; then
    echo "no master/origin/master locally - fetching origin/master ..." >&2
    # explicit refspec so the remote-tracking ref exists even in
    # single-branch clones (fetching a bare branch name only fills FETCH_HEAD)
    if ! git fetch --quiet origin +refs/heads/master:refs/remotes/origin/master; then
      echo "error: could not fetch origin/master - check the network, or pass an explicit base: $0 <base-ref> [out-file]" >&2
      exit 1
    fi
    base=origin/master
  fi
fi
out=${2:-zjsearch-theme.patch}

cd "$(dirname "$0")/../.."

git diff --text "$base" -- client/zjsearch searx ':(exclude)searx/static' > "$out"

files=$(grep -c '^diff --git' "$out" || true)
if [ "$files" = "0" ]; then
  echo "no changes between $base and the working tree - nothing to patch" >&2
  exit 1
fi
echo "wrote $out: $files files, $base..worktree"
grep '^diff --git' "$out" | sed 's/^diff --git a\///; s/ b\/.*//; s/^/  /'
