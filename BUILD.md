# Building videodl Standalone Binaries

videodl can be compiled into a single **standalone executable** — just like
`youtube-dl` or `yt-dlp` — that requires no Node.js installation to run.

## Quick Build (current platform)

```bash
npm run build
```

This produces:
- **Windows**: `dist/videodl.exe`
- **Linux**: `dist/videodl-linux`
- **macOS**: `dist/videodl-macos`

## Build Steps Explained

The build uses two stages:

1. **esbuild** bundles all ESM source code + npm dependencies into a single
   CommonJS file (`dist/videodl.cjs`, ~1.7 MB).
2. **Node.js SEA** (Single Executable Applications) injects that bundle into a
   copy of the Node.js binary, producing a self-contained executable.

## Build Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Build for the current OS |
| `npm run build:linux` | Bundle only + Linux binary (on Linux) |
| `npm run build:windows` | Bundle only + Windows binary (on Windows) |
| `node build.mjs --bundle-only` | CJS bundle only (no binary) |
| `node build.mjs --linux-inject` | Cross-compile Linux binary from Windows |

## Cross-Compiling Linux Binary from Windows

1. Download the **Linux** Node.js binary matching your Node.js version:
   ```
   https://nodejs.org/dist/v24.13.0/node-v24.13.0-linux-x64.tar.xz
   ```
2. Extract the `node` ELF binary and place it at `dist/node-linux`
3. Run:
   ```bash
   node build.mjs --linux-inject
   ```

### Automated with PowerShell

```powershell
$ver = (node --version).TrimStart('v')
$url = "https://nodejs.org/dist/v$ver/node-v$ver-linux-x64.tar.xz"
Invoke-WebRequest -Uri $url -OutFile dist/node-linux.tar.xz
tar -xf dist/node-linux.tar.xz --strip-components=2 "node-v$ver-linux-x64/bin/node"
Rename-Item node -NewName dist/node-linux
node build.mjs --linux-inject
```

## Running the Bundle Without Compilation

If you already have Node.js 18+ installed, you can run the CJS bundle directly:

```bash
node dist/videodl.cjs --help
node dist/videodl.cjs download "https://example.com/video"
```

This is useful for platforms where binary compilation isn't needed.

## Output Sizes

| File | Description | Size |
|------|-------------|------|
| `dist/videodl.cjs` | Portable CJS bundle (needs Node.js) | ~1.7 MB |
| `dist/videodl.exe` | Windows x64 standalone | ~88 MB |
| `dist/videodl-linux` | Linux x64 standalone | ~117 MB |

The standalone binaries are larger because they embed the entire Node.js runtime.

## Prerequisites

- **Node.js 20+** (for SEA support; v24 recommended)
- **npm** dependencies installed (`npm install`)
- **esbuild** (installed automatically as devDependency)

## Usage After Build

```bash
# Windows
.\dist\videodl.exe --help
.\dist\videodl.exe download "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
.\dist\videodl.exe sites

# Linux
./dist/videodl-linux --help
./dist/videodl-linux download "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
./dist/videodl-linux sites

# You can also copy/rename the binary for convenience:
# Linux:  sudo cp dist/videodl-linux /usr/local/bin/videodl
# Windows: copy dist\videodl.exe C:\tools\videodl.exe  (add to PATH)
```
