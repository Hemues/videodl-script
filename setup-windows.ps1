# Windows Setup Script for videodl-cli
# Run this script in PowerShell as Administrator

Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "videodl-cli Setup Script for Windows" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host ""

# Check if running as Administrator
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "Warning: Not running as Administrator" -ForegroundColor Yellow
    Write-Host "Some installation steps may require Administrator privileges" -ForegroundColor Yellow
    Write-Host ""
}

# Check Node.js
Write-Host "[1/3] Checking Node.js..." -ForegroundColor Blue
try {
    $nodeVersion = node --version
    Write-Host "✓ Node.js found: $nodeVersion" -ForegroundColor Green
    
    # Check if version is >= 18
    $version = $nodeVersion -replace 'v', ''
    $major = [int]($version -split '\.')[0]
    
    if ($major -lt 18) {
        Write-Host "⚠ Warning: Node.js version 18+ is recommended" -ForegroundColor Yellow
        Write-Host "  Current version: $nodeVersion" -ForegroundColor Yellow
        Write-Host "  Download from: https://nodejs.org/" -ForegroundColor Yellow
    }
} catch {
    Write-Host "✗ Node.js not found!" -ForegroundColor Red
    Write-Host "  Please install Node.js from: https://nodejs.org/" -ForegroundColor Yellow
    Write-Host "  After installation, restart this script" -ForegroundColor Yellow
    exit 1
}
Write-Host ""

# Check ffmpeg
Write-Host "[2/3] Checking ffmpeg..." -ForegroundColor Blue
try {
    $ffmpegPath = Get-Command ffmpeg -ErrorAction Stop
    Write-Host "✓ ffmpeg found: $($ffmpegPath.Source)" -ForegroundColor Green
} catch {
    Write-Host "✗ ffmpeg not found!" -ForegroundColor Red
    Write-Host ""
    Write-Host "Choose an installation method:" -ForegroundColor Yellow
    Write-Host "  1. Install using Chocolatey (recommended)" -ForegroundColor White
    Write-Host "  2. Download manually from ffmpeg.org" -ForegroundColor White
    Write-Host "  3. Skip (install later)" -ForegroundColor White
    Write-Host ""
    
    $choice = Read-Host "Enter choice (1-3)"
    
    switch ($choice) {
        "1" {
            # Check if Chocolatey is installed
            try {
                choco --version | Out-Null
                Write-Host "Installing ffmpeg via Chocolatey..." -ForegroundColor Blue
                choco install ffmpeg -y
                Write-Host "✓ ffmpeg installed!" -ForegroundColor Green
            } catch {
                Write-Host "✗ Chocolatey not found" -ForegroundColor Red
                Write-Host "Install Chocolatey first: https://chocolatey.org/install" -ForegroundColor Yellow
            }
        }
        "2" {
            Write-Host "Manual installation steps:" -ForegroundColor Yellow
            Write-Host "  1. Download from: https://ffmpeg.org/download.html" -ForegroundColor White
            Write-Host "  2. Extract to C:\ffmpeg" -ForegroundColor White
            Write-Host "  3. Add C:\ffmpeg\bin to PATH" -ForegroundColor White
            Write-Host "  4. Restart PowerShell and run this script again" -ForegroundColor White
            exit 0
        }
        "3" {
            Write-Host "⚠ Skipping ffmpeg installation" -ForegroundColor Yellow
            Write-Host "  Note: videodl-cli requires ffmpeg to function" -ForegroundColor Yellow
        }
    }
}
Write-Host ""

# Install npm dependencies
Write-Host "[3/3] Installing dependencies..." -ForegroundColor Blue
try {
    npm install
    Write-Host "✓ Dependencies installed!" -ForegroundColor Green
} catch {
    Write-Host "✗ Failed to install dependencies" -ForegroundColor Red
    Write-Host "  Error: $_" -ForegroundColor Yellow
    exit 1
}
Write-Host ""

# Ask about global installation
Write-Host "Setup complete! " -ForegroundColor Green
Write-Host ""
Write-Host "Would you like to install videodl globally? (Y/n)" -ForegroundColor Yellow
Write-Host "  This allows you to run 'videodl' from anywhere" -ForegroundColor Gray
$global = Read-Host

if ($global -eq "" -or $global -eq "Y" -or $global -eq "y") {
    Write-Host "Installing globally..." -ForegroundColor Blue
    try {
        npm link
        Write-Host "✓ Global installation complete!" -ForegroundColor Green
        Write-Host ""
        Write-Host "You can now use 'videodl' from anywhere:" -ForegroundColor Cyan
        Write-Host "  videodl --version" -ForegroundColor White
        Write-Host "  videodl info" -ForegroundColor White
        Write-Host "  videodl download <url>" -ForegroundColor White
    } catch {
        Write-Host "⚠ Global installation failed (this is OK)" -ForegroundColor Yellow
        Write-Host "  You can still use: node src/cli.js <command>" -ForegroundColor Gray
    }
} else {
    Write-Host "Skipping global installation" -ForegroundColor Gray
    Write-Host "Use: node src/cli.js <command>" -ForegroundColor White
}

Write-Host ""
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Test: videodl info" -ForegroundColor White
Write-Host "  2. Read: README.md" -ForegroundColor White
Write-Host "  3. Examples: node examples.js" -ForegroundColor White
Write-Host "=====================================" -ForegroundColor Cyan
