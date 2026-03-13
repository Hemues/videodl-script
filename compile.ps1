<#
.SYNOPSIS
    Compile videodl standalone binaries (Windows + optional Linux cross-compile).

.DESCRIPTION
    Builds videodl into standalone executables using esbuild + Node.js SEA.
    Produces two binary variants:
      videodl.exe / videodl-linux               - downloads ffmpeg on first use
      videodl-ffmpeg.exe / videodl-ffmpeg-linux  - ffmpeg embedded inside (fully standalone)

.PARAMETER Linux
    Also cross-compile a Linux binary. Downloads the Linux Node.js binary
    automatically if not already present in dist/node-linux.

.PARAMETER BundleOnly
    Only produce the CJS bundle (dist/videodl.cjs), skip binary compilation.

.PARAMETER Clean
    Remove all files in dist/ before building.

.PARAMETER NoFFmpeg
    Skip embedding ffmpeg (only produce the plain binary).

.EXAMPLE
    .\compile.ps1                  # Build both variants
    .\compile.ps1 -Linux           # Build both + cross-compile for Linux
    .\compile.ps1 -BundleOnly      # CJS bundle only (no binary)
    .\compile.ps1 -Clean           # Clean dist/ then build
    .\compile.ps1 -NoFFmpeg        # Plain binary only (no ffmpeg variant)
#>

[CmdletBinding()]
param(
    [switch]$Linux,
    [switch]$BundleOnly,
    [switch]$Clean,
    [switch]$NoFFmpeg
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProjectRoot = $PSScriptRoot
$DistDir = Join-Path $ProjectRoot 'dist'

# --- Helpers -----------------------------------------------------------------

function Write-Step {
    param([string]$Message)
    Write-Host "`n=== $Message ===" -ForegroundColor Cyan
}

function Test-CommandExists {
    param([string]$Command)
    $null -ne (Get-Command $Command -ErrorAction SilentlyContinue)
}

# --- Pre-flight checks -------------------------------------------------------

Write-Step 'Pre-flight checks'

# Ensure Node.js is available
if (-not (Test-CommandExists 'node')) {
    $nodePath = 'C:\Program Files\nodejs'
    if (Test-Path $nodePath) {
        $env:PATH = "$nodePath;$env:PATH"
        Write-Host "  Added $nodePath to PATH"
    } else {
        Write-Host '  ERROR: Node.js not found. Install from https://nodejs.org' -ForegroundColor Red
        exit 1
    }
}

$nodeVersion = node --version
Write-Host "  Node.js $nodeVersion"

if (-not (Test-CommandExists 'npm')) {
    Write-Host '  ERROR: npm not found.' -ForegroundColor Red
    exit 1
}

$npmVersion = npm --version
Write-Host "  npm    v$npmVersion"

# Check minimum Node.js version (need >= 18 for SEA)
$major = [int]($nodeVersion -replace '^v(\d+)\..*', '$1')
if ($major -lt 18) {
    Write-Host "  ERROR: Node.js 18+ required (found $nodeVersion)" -ForegroundColor Red
    exit 1
}

# --- Clean -------------------------------------------------------------------

if ($Clean -and (Test-Path $DistDir)) {
    Write-Step 'Cleaning dist/'
    Remove-Item -Path "$DistDir\*" -Recurse -Force
    Write-Host '  dist/ cleaned'
}

# --- Install dependencies ----------------------------------------------------

$nodeModules = Join-Path $ProjectRoot 'node_modules'
if (-not (Test-Path $nodeModules)) {
    Write-Step 'Installing dependencies (npm install)'
    Push-Location $ProjectRoot
    npm install
    Pop-Location
} else {
    Write-Host "`n  node_modules/ found -- skipping npm install"
}

# --- Build -------------------------------------------------------------------

Push-Location $ProjectRoot
try {
    # Build flags: always produce both variants unless -NoFFmpeg
    $buildFlags = @('--package')
    if ($NoFFmpeg) {
        $buildFlags += '--no-ffmpeg'
    }
    $extraArgs = $buildFlags -join ' '

    if ($BundleOnly) {
        Write-Step 'Building CJS bundle only'
        node build.mjs --bundle-only
    }
    elseif ($Linux) {
        # Build Windows binary first
        Write-Step 'Building Windows binary'
        node build.mjs $extraArgs

        # Download Linux Node.js binary if not present
        $linuxNode = Join-Path $DistDir 'node-linux'
        if (-not (Test-Path $linuxNode)) {
            Write-Step 'Downloading Linux Node.js binary for cross-compile'

            $ver = ($nodeVersion).TrimStart('v')
            $tarFile = Join-Path $DistDir 'node-linux.tar.xz'
            $url = "https://nodejs.org/dist/v$ver/node-v$ver-linux-x64.tar.xz"

            Write-Host "  Downloading: $url"
            Invoke-WebRequest -Uri $url -OutFile $tarFile -UseBasicParsing

            Write-Host '  Extracting node binary ...'
            tar -xf $tarFile -C $DistDir --strip-components=2 "node-v$ver-linux-x64/bin/node"

            $extractedNode = Join-Path $DistDir 'node'
            if (Test-Path $extractedNode) {
                Move-Item $extractedNode $linuxNode -Force
            }

            Write-Host "  Linux Node.js binary: $linuxNode"
        } else {
            Write-Host "`n  dist/node-linux already present -- reusing"
        }

        # Cross-compile Linux binary
        Write-Step 'Cross-compiling Linux binary'
        node build.mjs --linux-inject $extraArgs
    }
    else {
        Write-Step 'Building Windows binary'
        node build.mjs $extraArgs
    }
}
finally {
    Pop-Location
}

# --- Summary -----------------------------------------------------------------

Write-Step 'Build complete'

if (Test-Path $DistDir) {
    Get-ChildItem $DistDir -File | Where-Object {
        $_.Name -notmatch '\.(cjs|blob|json)$' -and $_.Name -ne 'node-official' -and $_.Name -ne 'node-linux'
    } | ForEach-Object {
        if ($_.Length -gt 1MB) {
            $size = '{0:N1} MB' -f ($_.Length / 1MB)
        } else {
            $size = '{0:N0} KB' -f ($_.Length / 1KB)
        }
        Write-Host ('  {0,-35} {1}' -f $_.Name, $size)
    }
}

Write-Host ''
