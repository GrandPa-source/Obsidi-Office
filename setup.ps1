# OnlyObsidian Test - PowerShell setup script
#
# Copies the OnlyOffice + x2t asset trees from your existing
# obsidian-docx-viewer plugin into the onlyobsidian-test plugin.
#
# Run from inside the .obsidian/plugins/onlyobsidian-test/ directory:
#
#   .\setup.ps1
#
# Or specify the source plugin path:
#
#   .\setup.ps1 -SourcePath "C:\path\to\obsidian-docx-viewer"

param(
    [string]$SourcePath = ""
)

$ErrorActionPreference = "Stop"

$ScriptDir = $PSScriptRoot
$TargetAssets = Join-Path $ScriptDir "assets"
$TargetOO  = Join-Path $TargetAssets "onlyoffice"
$TargetX2T = Join-Path $TargetAssets "x2t"

function Log([string]$msg) { Write-Host "[setup] $msg" }
function Err([string]$msg) { Write-Host "[setup] ERROR: $msg" -ForegroundColor Red }

function Test-Source([string]$root) {
    if (-not (Test-Path $root -PathType Container)) { return $false }
    if (-not (Test-Path (Join-Path $root "assets\onlyoffice") -PathType Container)) { return $false }
    if (-not (Test-Path (Join-Path $root "assets\x2t") -PathType Container)) { return $false }
    if (-not (Test-Path (Join-Path $root "assets\x2t\x2t.js") -PathType Leaf)) { return $false }
    if (-not (Test-Path (Join-Path $root "assets\x2t\x2t.wasm") -PathType Leaf)) { return $false }
    return $true
}

function Find-Source {
    if ($SourcePath) {
        $resolved = Resolve-Path $SourcePath -ErrorAction SilentlyContinue
        if ($resolved -and (Test-Source $resolved.Path)) { return $resolved.Path }
        Err "Path provided does not contain assets/onlyoffice and assets/x2t: $SourcePath"
        exit 1
    }
    # Sibling
    $sibling = Join-Path (Split-Path $ScriptDir -Parent) "obsidian-docx-viewer"
    if (Test-Source $sibling) { return $sibling }
    # Walk up
    $dir = $ScriptDir
    for ($i = 0; $i -lt 6; $i++) {
        $candidate = Join-Path $dir ".obsidian\plugins\obsidian-docx-viewer"
        if (Test-Source $candidate) { return $candidate }
        $parent = Split-Path $dir -Parent
        if ($parent -eq $dir) { break }
        $dir = $parent
    }
    return $null
}

Log "OnlyObsidian Test setup"
Log "script dir: $ScriptDir"

if (-not (Test-Path (Join-Path $ScriptDir "manifest.json") -PathType Leaf)) {
    Err "manifest.json not found. Run setup.ps1 from inside the onlyobsidian-test plugin directory."
    exit 1
}

$src = Find-Source
if (-not $src) {
    Err "Could not find obsidian-docx-viewer plugin with assets."
    Err "Tried argument, sibling directory, and ascending walk."
    Err ""
    Err "Re-run with the source path:"
    Err "  .\setup.ps1 -SourcePath 'C:\full\path\to\obsidian-docx-viewer'"
    exit 1
}
Log "source: $src"

if (-not (Test-Path $TargetAssets)) { New-Item -ItemType Directory -Path $TargetAssets | Out-Null }

# OnlyOffice tree
if (Test-Path $TargetOO) {
    Log "target assets\onlyoffice\ already exists — skipping (delete it first to re-copy)"
} else {
    Log "copying assets\onlyoffice\ ... (this is the slow part, ~80-400 MB)"
    $t0 = Get-Date
    Copy-Item -Recurse -Path (Join-Path $src "assets\onlyoffice") -Destination $TargetOO
    $elapsed = ((Get-Date) - $t0).TotalSeconds
    $size = (Get-ChildItem -Recurse $TargetOO | Measure-Object -Property Length -Sum).Sum / 1MB
    Log ("  copied {0:N1} MB in {1:N1}s" -f $size, $elapsed)
}

# x2t tree
if (Test-Path $TargetX2T) {
    Log "target assets\x2t\ already exists — skipping"
} else {
    Log "copying assets\x2t\ ..."
    $t0 = Get-Date
    Copy-Item -Recurse -Path (Join-Path $src "assets\x2t") -Destination $TargetX2T
    $elapsed = ((Get-Date) - $t0).TotalSeconds
    Log ("  done in {0:N1}s" -f $elapsed)
}

# Verify shim + mock-socket
$shim = Join-Path $TargetAssets "docx-viewer\transport-shim.js"
$mock = Join-Path $TargetAssets "docx-viewer\mock-socket.js"
if (-not (Test-Path $shim) -or -not (Test-Path $mock)) {
    Err "transport-shim.js or mock-socket.js missing from assets\docx-viewer\."
    Err "These should have shipped with this plugin. Re-extract the zip."
    exit 1
}

Log ""
Log "done. Now reload Obsidian (Ctrl+R) and enable 'OnlyObsidian Test' in"
Log "Settings -> Community plugins."
