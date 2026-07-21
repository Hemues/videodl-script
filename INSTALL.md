# Installation Guide for videodl-cli

## Prerequisites

### 1. Node.js (Required)

**Check if Node.js is installed:**
```bash
node --version
```

Should show >= v18.0.0

**Install Node.js if needed:**
- Download from [nodejs.org](https://nodejs.org/)
- Choose LTS version
- Install with default options

### 2. ffmpeg (Required)

ffmpeg is essential for video conversion. Install using one of these methods:

## Windows Installation

### Method 1: Using Chocolatey (Recommended)

1. **Install Chocolatey** (if not already installed):
   - Open PowerShell as Administrator
   - Run:
   ```powershell
   Set-ExecutionPolicy Bypass -Scope Process -Force; [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072; iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
   ```

2. **Install ffmpeg**:
   ```powershell
   choco install ffmpeg
   ```

3. **Verify installation**:
   ```powershell
   ffmpeg -version
   ```

### Method 2: Manual Installation

1. **Download ffmpeg**:
   - Visit [ffmpeg.org/download.html](https://ffmpeg.org/download.html)
   - Click "Windows" → "Windows builds from gyan.dev"
   - Download "ffmpeg-release-full.7z"

2. **Extract files**:
   - Extract to `C:\ffmpeg`
   - You should have `C:\ffmpeg\bin\ffmpeg.exe`

3. **Add to PATH**:
   - Open System Properties → Environment Variables
   - Under System Variables, select "Path" → Edit
   - Click "New" → Add `C:\ffmpeg\bin`
   - Click OK on all dialogs

4. **Verify** (restart terminal first):
   ```powershell
   ffmpeg -version
   ```

### Method 3: Using Scoop

```powershell
scoop install ffmpeg
```

## Linux Installation

### Ubuntu/Debian
```bash
sudo apt update
sudo apt install ffmpeg
```

### Fedora
```bash
sudo dnf install ffmpeg
```

### Arch Linux
```bash
sudo pacman -S ffmpeg
```

### Verify
```bash
ffmpeg -version
```

## macOS Installation

### Using Homebrew (Recommended)

1. **Install Homebrew** (if not installed):
   ```bash
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   ```

2. **Install ffmpeg**:
   ```bash
   brew install ffmpeg
   ```

3. **Verify**:
   ```bash
   ffmpeg -version
   ```

## Installing videodl-cli

Once Node.js and ffmpeg are installed:

### Option 1: Global Installation (Recommended)

```bash
# Clone or navigate to project directory
cd videodl-cli

# Install dependencies
npm install

# Link globally (makes 'videodl' command available everywhere)
npm link
```

Now you can use `videodl` from anywhere:
```bash
videodl --version
videodl info
```

### Option 2: Local Installation

```bash
# Clone or navigate to project directory
cd videodl-cli

# Install dependencies
npm install

# Run using node
node src/cli.js --help
```

Use with: `node src/cli.js <command>`

### Option 3: Using npx (if published to npm)

```bash
npx videodl-cli download <url>
```

## Verification

After installation, verify everything works:

```bash
# Check version
videodl --version

# Check ffmpeg integration
videodl info

# Should show:
# ℹ️  System Information:
# ──────────────────────────────────────────────────
# Program:  ffmpeg
# Version:  <version>
# Path:     <path-to-ffmpeg>
```

## Troubleshooting

### "ffmpeg not found"

**Windows:**
- Verify ffmpeg is in PATH: `where ffmpeg`
- Restart terminal after adding to PATH
- Try running `ffmpeg -version` directly

**Linux/Mac:**
- Verify installation: `which ffmpeg`
- Check permissions: `ls -l $(which ffmpeg)`
- Reinstall if necessary

### "npm: command not found"

- Node.js is not installed or not in PATH
- Restart terminal after Node.js installation
- Verify: `node --version` and `npm --version`

### Permission Errors (Linux/Mac)

```bash
# Don't use sudo with npm link
# Instead, configure npm to use a local directory:
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
source ~/.bashrc

# Now run npm link without sudo
npm link
```

### PowerShell Execution Policy (Windows)

If you see "running scripts is disabled":

```powershell
# Check current policy
Get-ExecutionPolicy

# Set to RemoteSigned (recommended)
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser

# Or run with bypass
powershell -ExecutionPolicy Bypass -Command "npm install"
```

## Quick Test

After installation, try these commands:

```bash
# 1. Check version
videodl --version

# 2. Check ffmpeg
videodl info

# 3. View help
videodl --help

# 4. List formats
videodl formats | head -20
```

If all commands work, you're ready to use videodl-cli!

## Next Steps

- Read [README.md](README.md) for full documentation
- Check [QUICKSTART.md](QUICKSTART.md) for common examples
- Run [examples.js](examples.js) for programmatic usage examples

## Updates

To update videodl-cli:

```bash
cd videodl-cli
git pull  # If using git
npm install  # Update dependencies
npm link  # Re-link if needed
```

## Uninstall

```bash
# Unlink global command
npm unlink -g videodl

# Or remove from specific location
cd videodl-cli
npm unlink
```
