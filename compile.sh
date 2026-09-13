#!/usr/bin/env bash
#
# Compile videodl standalone binaries for every target and publish a GitHub release.
#
# Targets (build.mjs): linux-x64, linux-arm64, win-x64 (plain + ffmpeg-embedded each),
# win-x86 (plain only — no 32-bit ffmpeg/cycletls exist upstream).
#
# Reproducibility & integrity (see REVIEW-2026-09-13.md §4.2):
#   * `npm ci` against the committed package-lock.json — identical dependency tree
#     on every build.
#   * Node.js and ffmpeg inputs are pinned + sha256-verified via build-pins.json
#     (the host's own Node is NOT used for the binaries; it must merely be the same
#     version so the SEA blob format matches).
#   * The vendored challenge solver must hash to src/vendor/ejs.lock.json.
#   * Every release ships a SHA256SUMS file the container build verifies against.
#
# Usage:
#   bash compile.sh                          # all targets, both variants, publish release
#   bash compile.sh --targets=host           # only the host target (dev)
#   bash compile.sh --targets=linux-x64,win-x64
#   bash compile.sh --no-release             # build only (no version bump, no upload)
#   bash compile.sh --bundle-only            # CJS bundle only (no binary)
#   bash compile.sh --clean                  # Clean dist/ (incl. cached inputs) then build
#   bash compile.sh --no-ffmpeg              # Plain binaries only (no ffmpeg variant)
#   bash compile.sh --version=2.1.0          # Explicit version instead of auto-increment
#
# Run as root on 11.1.0.2 (gh auth). Extractor scripts on the Samba share are
# exec-bit-stripped — always invoke as `bash compile.sh`.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
DIST_DIR="$PROJECT_ROOT/dist"

step()  { printf '\n\033[36m=== %s ===\033[0m\n' "$1"; }
ok()    { printf '\033[32m  ✓ %s\033[0m\n' "$1"; }
error() { printf '\033[31m  ERROR: %s\033[0m\n' "$1" >&2; exit 1; }

# --- Parse arguments ---------------------------------------------------------

BUNDLE_ONLY=false
CLEAN=false
NO_FFMPEG=false
NO_RELEASE=false
TARGETS="all"
FORCE_VERSION=""

for arg in "$@"; do
    case "$arg" in
        --bundle-only) BUNDLE_ONLY=true ;;
        --clean)       CLEAN=true ;;
        --no-ffmpeg)   NO_FFMPEG=true ;;
        --no-release)  NO_RELEASE=true ;;
        --targets=*)   TARGETS="${arg#--targets=}" ;;
        --version=*)   FORCE_VERSION="${arg#--version=}" ;;
        *)             echo "Unknown option: $arg"; exit 1 ;;
    esac
done

# --- Pre-flight checks -------------------------------------------------------

step 'Pre-flight checks'

command -v node >/dev/null || error 'node not found'
command -v npm  >/dev/null || error 'npm not found'
command -v tar  >/dev/null || error 'tar not found'
command -v xz   >/dev/null || error 'xz not found (needed for .tar.xz inputs)'
command -v sha256sum >/dev/null || error 'sha256sum not found'
if [[ "$TARGETS" == "all" || "$TARGETS" == *win* ]]; then
    command -v unzip >/dev/null || error 'unzip not found (needed for Windows targets)'
fi
if [ "$NO_RELEASE" = false ]; then
    command -v gh >/dev/null || error 'GitHub CLI (gh) not found — or pass --no-release'
fi

PINNED_NODE="$(node -p "require('$PROJECT_ROOT/build-pins.json').node.version")"
HOST_NODE="$(node --version | tr -d 'v\r')"
echo "  host node:   v$HOST_NODE"
echo "  pinned node: v$PINNED_NODE  (build-pins.json)"
if [ "$HOST_NODE" != "$PINNED_NODE" ]; then
    error "host Node v$HOST_NODE != pinned v$PINNED_NODE — the SEA blob format must match the target binaries. Install the pinned version or bump build-pins.json deliberately."
fi

# --- Vendored solver provenance ----------------------------------------------

step 'Verifying vendored challenge solver (ejs.lock.json)'
LOCK_SHA="$(node -p "require('$PROJECT_ROOT/src/vendor/ejs.lock.json').sha256")"
LOCK_TAG="$(node -p "require('$PROJECT_ROOT/src/vendor/ejs.lock.json').tag")"
ACTUAL_SHA="$(tr -d '\r' < "$PROJECT_ROOT/src/vendor/yt.solver.core.js" | sha256sum | cut -d' ' -f1)"
if [ "$LOCK_SHA" != "$ACTUAL_SHA" ]; then
    error "src/vendor/yt.solver.core.js does not match ejs.lock.json (tag $LOCK_TAG): expected $LOCK_SHA, got $ACTUAL_SHA. Update the lock deliberately (update-from-upstream.sh) or restore the file."
fi
ok "yt.solver.core.js == yt-dlp/ejs $LOCK_TAG"

# --- Clean ------------------------------------------------------------------

if [ "$CLEAN" = true ]; then
    step 'Cleaning dist/'
    rm -rf "$DIST_DIR"
fi
mkdir -p "$DIST_DIR"

# --- Version management -----------------------------------------------------

step 'Version management'
cd "$PROJECT_ROOT"

if [ -n "$FORCE_VERSION" ]; then
    NEW_VERSION="$FORCE_VERSION"
    echo "  Explicit version: $NEW_VERSION"
elif [ "$NO_RELEASE" = true ]; then
    NEW_VERSION="$(node -p "require('./package.json').version")"
    echo "  --no-release: keeping package.json version $NEW_VERSION"
else
    # Query latest release from both repos to find the highest version
    CLI_TAG=$(gh release view --repo Hemues/videodl-script --json tagName -q '.tagName' 2>/dev/null || echo "v0.0.0")
    CONTAINER_TAG=$(gh release view --repo Hemues/videodl-container --json tagName -q '.tagName' 2>/dev/null || echo "v0.0.0")
    CLI_VER="${CLI_TAG#v}"
    CONTAINER_VER="${CONTAINER_TAG#v}"
    echo "  videodl-script  latest: $CLI_VER"
    echo "  videodl-container latest: $CONTAINER_VER"
    HIGHEST=$(printf '%s\n%s\n' "$CLI_VER" "$CONTAINER_VER" | sort -V | tail -1)
    echo "  Highest version: $HIGHEST"
    IFS='.' read -r MAJOR MINOR PATCH <<< "$HIGHEST"
    PATCH=$((PATCH + 1))
    NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"
fi

if [ "$NO_RELEASE" = false ]; then
    node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
pkg.version = '${NEW_VERSION}';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
fi
echo "  Version: $NEW_VERSION"

# --- Install dependencies (reproducible) -------------------------------------

step 'Installing dependencies (npm ci — exact lockfile tree)'
[ -f package-lock.json ] || error 'package-lock.json missing — it must be committed for reproducible builds'
npm ci --no-audit --no-fund

# --- Build -------------------------------------------------------------------

BUILD_FLAGS="--targets=$TARGETS --package"
[ "$NO_FFMPEG" = true ] && BUILD_FLAGS="$BUILD_FLAGS --no-ffmpeg"

if [ "$BUNDLE_ONLY" = true ]; then
    step 'Building CJS bundle only'
    node build.mjs --bundle-only
    exit 0
fi

step "Building binaries ($TARGETS)"
node build.mjs $BUILD_FLAGS

# --- Collect release artifacts -------------------------------------------------

step 'Build complete'

RELEASE_FILES=()
for f in videodl-linux videodl-ffmpeg-linux videodl-linux-arm64 videodl-ffmpeg-linux-arm64 \
         videodl.exe videodl-ffmpeg.exe videodl-x86.exe; do
    [ -f "$DIST_DIR/$f" ] && RELEASE_FILES+=("$DIST_DIR/$f")
done
# CycleTLS Go helpers, renamed so the asset names say what they are
declare -A CYCLETLS_MAP=( ["index"]="cycletls-index-linux" ["index-arm64"]="cycletls-index-linux-arm64" ["index.exe"]="cycletls-index-windows.exe" )
for src in "${!CYCLETLS_MAP[@]}"; do
    if [ -f "$DIST_DIR/$src" ]; then
        cp "$DIST_DIR/$src" "$DIST_DIR/${CYCLETLS_MAP[$src]}"
        RELEASE_FILES+=("$DIST_DIR/${CYCLETLS_MAP[$src]}")
    fi
done

[ ${#RELEASE_FILES[@]} -gt 0 ] || error 'no release artifacts produced'

# Integrity manifest for the consumers (container build.sh verifies against it)
( cd "$DIST_DIR" && sha256sum $(for f in "${RELEASE_FILES[@]}"; do basename "$f"; done) > SHA256SUMS )
RELEASE_FILES+=("$DIST_DIR/SHA256SUMS")

for f in "${RELEASE_FILES[@]}"; do
    size_bytes="$(stat -c%s "$f")"
    if [ "$size_bytes" -gt 1048576 ]; then
        size="$(awk "BEGIN { printf \"%.1f MB\", $size_bytes / 1048576 }")"
    else
        size="$(awk "BEGIN { printf \"%.0f KB\", $size_bytes / 1024 }")"
    fi
    printf '  %-35s %s\n' "$(basename "$f")" "$size"
done
echo ''
echo "  Version: $NEW_VERSION"
echo "  Node:    v$PINNED_NODE (pinned)   ffmpeg: $(node -p "require('./build-pins.json').ffmpeg.tag")   solver: ejs $LOCK_TAG"
echo ''

# --- Create GitHub release ----------------------------------------------------

if [ "$NO_RELEASE" = true ]; then
    echo "  --no-release: artifacts left in dist/, nothing published."
    exit 0
fi

step 'Creating GitHub release'
NOTES="Release ${NEW_VERSION}

Targets: linux-x64, linux-arm64, win-x64 (plain + ffmpeg-embedded), win-x86 (plain).
Inputs: Node.js v${PINNED_NODE}, ffmpeg $(node -p "require('./build-pins.json').ffmpeg.tag") (BtbN), challenge solver yt-dlp/ejs ${LOCK_TAG}.
SHA256SUMS lists every asset."
gh release create "v${NEW_VERSION}" "${RELEASE_FILES[@]}" \
    --repo Hemues/videodl-script \
    --title "Videodl cli (Build ${NEW_VERSION})" \
    --notes "$NOTES"
ok "Release v${NEW_VERSION} created"
echo ''
