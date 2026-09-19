# Export the zjsearch theme changes (client sources + server data templates)
# as a single patch to apply on another machine. PowerShell twin of
# make-patch.sh - keep the two in sync.
#
#   powershell -ExecutionPolicy Bypass -File make-patch.ps1 [-Base <ref>] [-Out <file>]
#   # on the target machine:
#   git apply --check zjsearch-theme.patch && git apply zjsearch-theme.patch
#   cd client/zjsearch ; npm install ; npm run build
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

param(
    [string]$Base = "",
    [string]$Out = "zjsearch-theme.patch"
)

$ErrorActionPreference = "Stop"

if (-not $Base) {
    # a stale remote-tracking ref would sweep upstream-only changes into the
    # patch (e.g. engine fixes made upstream after the last fetch) - refresh
    # it best-effort; offline runs keep whatever ref they already have
    & git fetch --quiet origin "+refs/heads/master:refs/remotes/origin/master"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "WARNING: could not refresh origin/master - the local ref may be stale"
        Write-Host "WARNING: and the patch may include unrelated upstream changes"
    }
    # prefer the remote-tracking ref (refreshed above) over a possibly stale
    # local master branch - same order as make-patch.sh
    foreach ($ref in @("origin/master", "master")) {
        & git rev-parse -q --verify "$ref" *> $null
        if ($LASTEXITCODE -eq 0) { $Base = $ref; break }
    }
    if (-not $Base) {
        Write-Host "no master/origin/master locally - fetching origin/master ..."
        # explicit refspec so the remote-tracking ref exists even in
        # single-branch clones (fetching a bare branch name only fills FETCH_HEAD)
        & git fetch --quiet origin "+refs/heads/master:refs/remotes/origin/master"
        if ($LASTEXITCODE -ne 0) {
            Write-Host "error: could not fetch origin/master - check the network, or pass -Base <ref>"
            exit 1
        }
        $Base = "origin/master"
    }
}

Set-Location (Join-Path $PSScriptRoot "..\..")

# byte-exact redirect through cmd: PowerShell's own ">" re-encodes git output
# (UTF-16 / BOM), which git apply would reject
cmd /c "git diff --text $Base -- client/zjsearch searx `"(exclude)searx/static`" > `"$Out`""

$content = Get-Content $Out -Raw
$files = ([regex]::Matches($content, "(?m)^diff --git")).Count
if ($files -eq 0) {
    Write-Error "no changes between $Base and the working tree - nothing to patch"
    exit 1
}
Write-Host "wrote $Out : $files files, $Base..worktree"
Select-String -Path $Out -Pattern "^diff --git" | ForEach-Object {
    Write-Host ("  " + ($_.Line -replace "^diff --git a/", "" -replace " b/.*$", ""))
}
