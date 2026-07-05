#!/usr/bin/env bash
#
# update-from-ytdlp.sh — repeatable "sync videodl-cli's YouTube handling from
# yt-dlp, rebuild the binary, publish it to GitHub, embed it in the
# videodl-container, deploy, and verify" pipeline.
#
# See UPDATE-FROM-YTDLP.md for the full process and exactly what to edit.
#
# Roles on Blathy-server (11.1.0.2) — do NOT mix them:
#   * build / publish / podman build / gh  -> ROOT      (run this script as root: `sudo -i`)
#   * deploy (rootless container)           -> `videodl` user (this script sudo's to it)
#
# Usage:
#   sudo -i
#   cd /storage/Samba/Temp/git/scripts/videodl-script
#   ./update-from-ytdlp.sh check                    # show yt-dlp's client table vs ours (read-only)
#   ./update-from-ytdlp.sh ship                     # smoke-test -> publish CLI -> rebuild+deploy container -> verify
#   ./update-from-ytdlp.sh ship --skip-deploy       # build + publish only (no prod cutover)
#   ./update-from-ytdlp.sh ship --test-url=https://youtu.be/XXXXXXXXXXX
#
# NOTE: this does NOT git-commit your youtube.js edits — commit the source
# yourself first (scoped + EOL-normalized; see the runbook), because the repo
# has a CRLF-churn trap. `ship` runs compile.sh (publishes a videodl-script
# release) and the container build.sh (pushes ghcr:latest + a container release).
#
set -euo pipefail

CLI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER_DIR="/storage/Samba/Temp/git/containers/videodl-container"
TEST_URL="https://www.youtube.com/watch?v=oUCi8HH0wZA"
DEPLOY_USER="videodl"
UPDATER="/etc/scripts/podman-videodl-updater-inside-pod"
IMAGE="ghcr.io/hemues/videodl:latest"
YTDLP_BASE="https://raw.githubusercontent.com/yt-dlp/yt-dlp/master/yt_dlp/extractor/youtube/_base.py"
YTDLP_VIDEO="https://raw.githubusercontent.com/yt-dlp/yt-dlp/master/yt_dlp/extractor/youtube/_video.py"

c()   { printf '\n\033[36m=== %s ===\033[0m\n' "$1"; }
ok()  { printf '\033[32m  ✓ %s\033[0m\n' "$1"; }
die() { printf '\033[31mERROR: %s\033[0m\n' "$1" >&2; exit 1; }

cmd="${1:-}"; shift || true
SKIP_DEPLOY=false
for a in "$@"; do
  case "$a" in
    --skip-deploy) SKIP_DEPLOY=true ;;
    --test-url=*)  TEST_URL="${a#--test-url=}" ;;
    *) die "unknown option: $a" ;;
  esac
done

check_clients() {
  c "yt-dlp current YouTube client table (master)"
  curl -fsSL "$YTDLP_BASE"  -o /tmp/ytdlp_base.py  || die "failed to fetch _base.py"
  curl -fsSL "$YTDLP_VIDEO" -o /tmp/ytdlp_video.py || echo "  (warning: _video.py fetch failed)"
  echo "-- clientName / clientVersion / gvs-PO-token policy --"
  grep -nE "'clientName'|'clientVersion'|GvsPoTokenPolicy|PoTokenPolicy|REQUIRE_AUTH" /tmp/ytdlp_base.py | sed -n '1,140p' || true
  echo
  echo "-- yt-dlp default player_clients (_video.py) --"
  grep -nE "_DEFAULT_.*CLIENTS|_DEFAULT_JSLESS" /tmp/ytdlp_video.py 2>/dev/null || echo "  (unavailable)"
  echo
  c "our videodl-cli clients (src/extractors/youtube.js)"
  grep -nE "name: '|clientVersion:|PO_TOKEN_REQUIRED_CLIENTS" "$CLI_DIR/src/extractors/youtube.js" || true
  echo
  echo "Reconcile the two, then edit src/extractors/youtube.js. Rules of thumb:"
  echo "  * Keep ANDROID_VR pinned <= 1.65.x and FIRST (>1.65 = SABR-only, unusable)."
  echo "  * No-gvs-token clients first (ANDROID_VR, TV, WEB_EMBEDDED); token-required"
  echo "    (IOS, WEB, MWEB, WEB_CREATOR) LAST; drop clients yt-dlp removed."
  echo "  * Refresh clientVersion strings; update PO_TOKEN_REQUIRED_CLIENTS if policy changed."
  echo "  * PO-token minting is deferred (see LESSONS-LEARNED.md #14 + contrib/po-token-provider.mjs)."
  echo
  echo "Then: ./update-from-ytdlp.sh ship"
}

smoke() {
  c "Smoke-test edited CLI from source: $TEST_URL"
  cd "$CLI_DIR"
  [ -d node_modules ] || npm install
  local out; out="$(node src/cli.js extract "$TEST_URL" 2>&1 || true)"
  echo "$out" | grep -iE "Trying|probe|Extracted .* via|403|no streaming|minting" | tail -15 || true
  echo "$out" | grep -q '"status":"ok"'                         || die "extraction did not return status ok — fix youtube.js before publishing"
  echo "$out" | grep -qiE "URL probe OK|Extracted [0-9]+ format" || die "no probe-OK client — still 403ing? fix youtube.js"
  ok "source extraction OK (no 403)"
}

ship() {
  command -v gh     >/dev/null || die "gh not found — run this as root (sudo -i)"
  command -v podman >/dev/null || die "podman not found — run this as root (sudo -i)"
  [ -d "$CONTAINER_DIR" ] || die "container dir not found: $CONTAINER_DIR"

  smoke

  c "Publish videodl-cli (compile.sh → videodl-ffmpeg-linux GitHub release)"
  ( cd "$CLI_DIR" && ./compile.sh )

  c "Rebuild container (build.sh → embeds new CLI → pushes $IMAGE + release)"
  ( cd "$CONTAINER_DIR" && ./build.sh )

  if $SKIP_DEPLOY; then
    c "Skipping deploy (--skip-deploy). Image is on ghcr; deploy later with:"
    echo "  sudo -iu $DEPLOY_USER $UPDATER"
    return
  fi

  c "Deploy (rootless updater as '$DEPLOY_USER')"
  sudo -iu "$DEPLOY_USER" podman pull -q "$IMAGE"          # pre-pull: no pull-after-stop downtime
  sudo -iu "$DEPLOY_USER" "$UPDATER"
  sleep 6
  local ver; ver="$(sudo -iu "$DEPLOY_USER" podman exec videodl printenv VIDEODL_VERSION 2>&1 || echo '?')"
  ok "deployed container version: $ver"

  c "Verify DEPLOYED binary against $TEST_URL (extract = client rotation + CDN probe, no full download)"
  local vout; vout="$(sudo -iu "$DEPLOY_USER" podman exec videodl /videodl-cli/videodl-ffmpeg extract "$TEST_URL" 2>&1 || true)"
  echo "$vout" | grep -iE "Trying|probe|Extracted .* via|403" | tail -10 || true
  echo "$vout" | grep -q '"status":"ok"' && ok "DEPLOYED extraction OK — update complete." || die "deployed verify failed (403 or extraction error)"
}

case "$cmd" in
  check) check_clients ;;
  ship)  ship ;;
  *) echo "usage: $0 {check|ship} [--skip-deploy] [--test-url=URL]"; exit 1 ;;
esac
