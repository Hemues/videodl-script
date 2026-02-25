#!/usr/bin/env bash
#
# Compile videodl standalone binary for Linux.
# Output is placed in the dist/ directory.
#
# Usage:
#   ./compile.sh                # Build Linux binary
#   ./compile.sh --bundle-only  # CJS bundle only (no binary)
#   ./compile.sh --clean        # Clean dist/ then build

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
DIST_DIR="$PROJECT_ROOT/dist"

# --- Helpers -----------------------------------------------------------------

step() {
    printf '\n\033[36m=== %s ===\033[0m\n' "$1"
}

error() {
    printf '\033[31m  ERROR: %s\033[0m\n' "$1" >&2
    exit 1
}

# --- Parse arguments ---------------------------------------------------------

BUNDLE_ONLY=false
CLEAN=false

for arg in "$@"; do
    case "$arg" in
        --bundle-only) BUNDLE_ONLY=true ;;
        --clean)       CLEAN=true ;;
        *)             echo "Unknown option: $arg"; exit 1 ;;
    esac
done

# --- Pre-flight checks -------------------------------------------------------

step 'Pre-flight checks'

if ! command -v node &>/dev/null; then
    error 'Node.js not found. Install from https://nodejs.org'
fi

NODE_VERSION="$(node --version)"
echo "  Node.js $NODE_VERSION"

if ! command -v npm &>/dev/null; then
    error 'npm not found.'
fi

NPM_VERSION="$(npm --version)"
echo "  npm    v$NPM_VERSION"

# Check minimum Node.js version (need >= 18 for SEA)
MAJOR="${NODE_VERSION#v}"
MAJOR="${MAJOR%%.*}"
if [ "$MAJOR" -lt 18 ]; then
    error "Node.js 18+ required (found $NODE_VERSION)"
fi

# --- Check SEA sentinel in Node.js binary ------------------------------------
# Distribution-packaged Node.js (RHEL, Fedora, Debian, etc.) often strips the
# SEA sentinel fuse from the binary, making postject injection impossible.
# If the current node binary lacks the sentinel, download the official one.

NODE_BIN="$(command -v node)"
SEA_SENTINEL="NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"
OFFICIAL_NODE=""

if ! grep -q "$SEA_SENTINEL" "$NODE_BIN" 2>/dev/null; then
    echo ""
    echo "  ⚠ Current Node.js binary ($NODE_BIN) lacks the SEA sentinel."
    echo "    This is common with distro-packaged Node.js (rpm/deb)."
    echo "    Downloading official Node.js binary from nodejs.org..."

    VER="${NODE_VERSION#v}"
    ARCH="$(uname -m)"
    case "$ARCH" in
        x86_64)  ARCH="x64" ;;
        aarch64) ARCH="arm64" ;;
        armv7l)  ARCH="armv7l" ;;
    esac

    TARBALL="node-v${VER}-linux-${ARCH}.tar.xz"
    TARBALL_URL="https://nodejs.org/dist/v${VER}/${TARBALL}"
    OFFICIAL_NODE="$DIST_DIR/node-official"

    mkdir -p "$DIST_DIR"

    if [ ! -f "$OFFICIAL_NODE" ]; then
        echo "  URL: $TARBALL_URL"
        if command -v curl &>/dev/null; then
            curl -fSL "$TARBALL_URL" -o "$DIST_DIR/$TARBALL"
        elif command -v wget &>/dev/null; then
            wget -q "$TARBALL_URL" -O "$DIST_DIR/$TARBALL"
        else
            error "Neither curl nor wget found. Install one or download Node.js manually."
        fi

        echo "  Extracting node binary..."
        tar -xf "$DIST_DIR/$TARBALL" -C "$DIST_DIR" --strip-components=2 "node-v${VER}-linux-${ARCH}/bin/node"
        mv "$DIST_DIR/node" "$OFFICIAL_NODE"
        rm -f "$DIST_DIR/$TARBALL"

        if grep -q "$SEA_SENTINEL" "$OFFICIAL_NODE" 2>/dev/null; then
            echo "  ✓ Official Node.js binary has SEA support"
        else
            error "Downloaded Node.js binary also lacks SEA sentinel. SEA may not be supported in v${VER}."
        fi
    else
        echo "  Using cached $OFFICIAL_NODE"
    fi
fi

# --- Clean -------------------------------------------------------------------

if [ "$CLEAN" = true ] && [ -d "$DIST_DIR" ]; then
    step 'Cleaning dist/'
    rm -rf "${DIST_DIR:?}"/*
    echo '  dist/ cleaned'
fi

# --- Install dependencies ----------------------------------------------------

if [ ! -d "$PROJECT_ROOT/node_modules" ]; then
    step 'Installing dependencies (npm install)'
    cd "$PROJECT_ROOT"
    npm install
else
    echo ""
    echo "  node_modules/ found -- skipping npm install"

    # Detect if esbuild was installed for a different platform (e.g. copied from Windows)
    CURRENT_PLATFORM="$(node -e "console.log(process.platform + '-' + process.arch)")"
    ESBUILD_OK=true
    if [ -d "$PROJECT_ROOT/node_modules/@esbuild" ]; then
        HAS_CURRENT=$(ls -d "$PROJECT_ROOT/node_modules/@esbuild/"*"$CURRENT_PLATFORM"* 2>/dev/null || true)
        if [ -z "$HAS_CURRENT" ]; then
            ESBUILD_OK=false
        fi
    fi

    if [ "$ESBUILD_OK" = false ]; then
        echo "  ⚠ esbuild was installed for a different platform"
        echo "  Reinstalling esbuild for $CURRENT_PLATFORM..."
        cd "$PROJECT_ROOT"
        npm install esbuild --force
        echo "  ✓ esbuild reinstalled for $CURRENT_PLATFORM"
    fi
fi

# --- Build -------------------------------------------------------------------

cd "$PROJECT_ROOT"

if [ "$BUNDLE_ONLY" = true ]; then
    step 'Building CJS bundle only'
    node build.mjs --bundle-only
else
    step 'Building Linux binary'
    if [ -n "$OFFICIAL_NODE" ] && [ -f "$OFFICIAL_NODE" ]; then
        VIDEODL_SEA_NODE="$OFFICIAL_NODE" node build.mjs
    else
        node build.mjs
    fi
fi

# --- Summary -----------------------------------------------------------------

step 'Build complete'

if [ -d "$DIST_DIR" ]; then
    for f in "$DIST_DIR"/*; do
        [ -f "$f" ] || continue
        name="$(basename "$f")"
        size_bytes="$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f" 2>/dev/null)"
        if [ "$size_bytes" -gt 1048576 ]; then
            size="$(awk "BEGIN { printf \"%.1f MB\", $size_bytes / 1048576 }")"
        else
            size="$(awk "BEGIN { printf \"%.0f KB\", $size_bytes / 1024 }")"
        fi
        printf '  %-30s %s\n' "$name" "$size"
    done
fi

echo ''
