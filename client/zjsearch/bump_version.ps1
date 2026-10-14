# Bump the fork version. Source of truth: client/zjsearch/package.json;
# searx/version_frozen.py's version fields are synced in the same step, so
# the runtime version and the Docker build's +sha stamp always move
# together (the build swaps the +0000 placeholder for the git sha).
#
#   powershell -ExecutionPolicy Bypass -File bump_version.ps1 [-Bump <X>]
#   # -Bump: major|minor|patch|X.Y.Z, default patch
#
# Shell twin: bump_version.sh - keep the two in sync.

param(
    [string]$Bump = "patch"
)

$ErrorActionPreference = "Stop"

# absolute paths: .NET IO resolves against the process working directory,
# which Set-Location does not move
$pkg = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "package.json"))
$frozen = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\searx\version_frozen.py"))

$current = ""
foreach ($line in Get-Content $pkg) {
    if ($line -match '"version": "([^"]+)"') { $current = $Matches[1]; break }
}
if (-not $current) { Write-Error "no version field found in $pkg"; exit 1 }

switch ($Bump) {
    "major" { $next = "$([int]$current.Split('.')[0] + 1).0.0" }
    "minor" { $next = "$($current.Split('.')[0]).$([int]$current.Split('.')[1] + 1).0" }
    "patch" { $next = "$($current.Split('.')[0]).$($current.Split('.')[1]).$([int]$current.Split('.')[2] + 1)" }
    default {
        $next = $Bump
        if ($next -notmatch '^\d+\.\d+\.\d+$') {
            Write-Error "not a version: $next (expected major|minor|patch|X.Y.Z)"
            exit 1
        }
    }
}

if ($next -eq $current) { Write-Host "version is already $current - nothing to do"; exit 0 }

# byte-exact .NET IO: PowerShell's own redirection re-encodes (UTF-16/BOM),
# and a BOM would break node/biome on the json and python on the module
$utf8NoBom = [Text.UTF8Encoding]::new($false)

$content = [IO.File]::ReadAllText($pkg)
$content = $content.Replace("`"version`": `"$current`"", "`"version`": `"$next`"")
if (-not $content.Contains("`"version`": `"$next`""))) { Write-Error "package.json update did not land"; exit 1 }
[IO.File]::WriteAllText($pkg, $content, $utf8NoBom)

$vf = [IO.File]::ReadAllText($frozen)
$vf = [regex]::Replace($vf, '(?m)^VERSION_STRING = [^\r\n]*', "VERSION_STRING = `"$next+0000`"")
$vf = [regex]::Replace($vf, '(?m)^VERSION_TAG = [^\r\n]*', "VERSION_TAG = `"$next`"")
$vf = [regex]::Replace($vf, '(?m)^DOCKER_TAG = [^\r\n]*', "DOCKER_TAG = `"$next`"")
if (-not ($vf -match [regex]::Escape("VERSION_STRING = `"$next+0000`""))) { Write-Error "version_frozen.py update did not land"; exit 1 }
[IO.File]::WriteAllText($frozen, $vf, $utf8NoBom)

Write-Host "bumped: $current -> $next"
Write-Host "  $pkg"
Write-Host "  $frozen (VERSION_STRING=$next+0000 -- Docker stamps the sha at build)"
