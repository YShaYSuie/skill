# codex-hook-launcher.ps1 -- stable entry point for the Codex host hook.
#
# IMPORTANT: this file must stay pure ASCII.
#   Windows PowerShell 5.1 reads .ps1 files without a BOM as ANSI, so any
#   non-ASCII character (e.g. Chinese comments) corrupts parsing and the
#   launcher dies with "Unexpected token '}'". Keep it ASCII-only.
#
# Why this layer exists:
#   A Codex config.toml hook can only hold one command line. Hard-coding a node
#   path breaks on runtime upgrades; an inline PowerShell command breaks on
#   quote parsing. So the hook always calls this launcher, which resolves node
#   and then starts hook-bridge.js.
#
# Real incident (verified 2026-09-26):
#   This launcher used to accept only three node sources: WTT_NODE_BIN, the
#   managed Codex runtime path, and PATH. On this machine ALL THREE were absent
#   (empty ~/.cache/codex-runtimes, no node on PATH, no WTT_NODE_BIN), so every
#   run fell through to a silent "exit 0". The Codex hook fired but recorded
#   nothing -- the root cause of "the first record of every day is lost and I
#   have to debug it by hand every day".
#
# Current behaviour:
#   1. Resolve node.exe from an ordered candidate list, then cache the path.
#   2. If nothing is found, leave evidence in <log_dir>/pending/launcher-trace.jsonl
#      instead of failing silently.
#   3. Stay absolutely quiet for the host: no stdout, never block, always exit 0.

param(
  [Parameter(Position = 0)]
  [string]$HostName = "codex"
)

# A hook must never block the host because of an error: swallow everything.
$ErrorActionPreference = "SilentlyContinue"

# `-File script.ps1 --host codex` may bind `--host` to the positional parameter.
# Normalise: keep only a known host name, otherwise fall back to "codex".
if ($HostName -notin @("codex", "workbuddy")) {
  if ($args.Count -gt 0 -and $args[0] -in @("codex", "workbuddy")) {
    $HostName = $args[0]
  } else {
    $HostName = "codex"
  }
}

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$bridge = Join-Path $root "hook-bridge.js"

$userProfile = $env:USERPROFILE
if (-not $userProfile) {
  $userProfile = [Environment]::GetFolderPath("UserProfile")
}

function Get-LogDir {
  if ($env:WORK_TIME_TRACKING_DIR) { return $env:WORK_TIME_TRACKING_DIR }
  foreach ($p in @(
      (Join-Path $userProfile ".workbuddy\work-time-tracking.json"),
      (Join-Path $userProfile ".codex\work-time-tracking.json")
    )) {
    if (Test-Path -LiteralPath $p) {
      try {
        $json = Get-Content -LiteralPath $p -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($json.log_directory) { return $json.log_directory }
      } catch { }
    }
  }
  return $null
}

# Only trace point for a failure. Best effort: fall back to %TEMP% when the
# log directory is not writable (the Codex sandbox may deny it).
function Write-LauncherTrace([string]$reason) {
  $entry = [ordered]@{
    at       = (Get-Date).ToString("yyyy-MM-ddTHH:mm:sszzz")
    event    = "launcher-no-node"
    host     = $HostName
    reason   = $reason
    wtt_node = $(if ($env:WTT_NODE_BIN) { $env:WTT_NODE_BIN } else { $null })
    tried    = @($script:nodeCandidates)
    fix      = "Set WTT_NODE_BIN to node.exe, or put node.exe on PATH"
  }
  $line = ($entry | ConvertTo-Json -Compress -Depth 4)
  foreach ($dir in @((Get-LogDir), $env:TEMP)) {
    if (-not $dir) { continue }
    try {
      $pending = Join-Path $dir "pending"
      if (-not (Test-Path -LiteralPath $pending)) {
        New-Item -ItemType Directory -Path $pending -Force | Out-Null
      }
      Add-Content -LiteralPath (Join-Path $pending "launcher-trace.jsonl") -Value $line -Encoding UTF8
      return
    } catch { }
  }
}

# ---- candidate list (order matters) ----------------------------------------
$script:nodeCandidates = New-Object System.Collections.ArrayList
function Add-Candidate([string]$p) {
  if ($p -and -not $script:nodeCandidates.Contains($p)) {
    [void]$script:nodeCandidates.Add($p)
  }
}

# 1. explicit override
Add-Candidate $env:WTT_NODE_BIN

# 2. last successfully resolved path (cached in the user profile, survives
#    skill upgrades)
$cacheFile = Join-Path $userProfile ".work-time-tracking\node-path.txt"
if (Test-Path -LiteralPath $cacheFile) {
  Add-Candidate ((Get-Content -LiteralPath $cacheFile -Raw -Encoding UTF8).Trim())
}

# 3. managed Codex runtime (version dirs are not stable, so glob instead of
#    hard-coding one path)
foreach ($f in Get-ChildItem -Path (Join-Path $userProfile ".cache\codex-runtimes") -Recurse -Filter "node.exe" -ErrorAction SilentlyContinue) {
  Add-Candidate $f.FullName
}

# 4. node shipped with the Codex app
if ($env:LOCALAPPDATA) {
  foreach ($f in Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA "OpenAI\Codex\runtimes") -Recurse -Filter "node.exe" -ErrorAction SilentlyContinue) {
    Add-Candidate $f.FullName
  }
}

# 5. node bundled with WorkBuddy (newest version first)
$wbVersions = Join-Path $userProfile ".workbuddy\binaries\node\versions"
if (Test-Path -LiteralPath $wbVersions) {
  foreach ($d in Get-ChildItem -LiteralPath $wbVersions -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending) {
    Add-Candidate (Join-Path $d.FullName "node.exe")
  }
}

# 6. PATH
$onPath = Get-Command node.exe -ErrorAction SilentlyContinue
if ($onPath) { Add-Candidate $onPath.Source }

# 7. common install locations
foreach ($p in @(
    (Join-Path $env:ProgramFiles "nodejs\node.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe"),
    (Join-Path $env:APPDATA "npm\node.exe"),
    "%ProgramFiles%\nodejs\node.exe"
  )) {
  Add-Candidate $p
}

$node = $null
foreach ($c in $script:nodeCandidates) {
  if ($c -and (Test-Path -LiteralPath $c -PathType Leaf)) { $node = $c; break }
}

if (-not $node) {
  # Silent failure caused the incident: leave evidence, but stay quiet to the host.
  Write-LauncherTrace "no node.exe found in any candidate location"
  exit 0
}

# Cache the working path: next run hits it immediately, and troubleshooting can
# tell at a glance which node was used.
try {
  $cacheDir = Split-Path -Parent $cacheFile
  if (-not (Test-Path -LiteralPath $cacheDir)) {
    New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
  }
  Set-Content -LiteralPath $cacheFile -Value $node -Encoding UTF8
} catch { }

if (-not (Test-Path -LiteralPath $bridge)) { exit 0 }

& $node $bridge "--host" $HostName
exit 0
