#!/usr/bin/env bash
#
# update-from-upstream.sh — the yt-dlp update checker / pipeline for videodl.
#
# "If there is no update, do nothing. If there is one: download + verify it, update the
#  source, rebuild every binary, publish them, rebuild the container on the new engine,
#  publish the image — and only put it into production if the smoke gate is green."
#
# Three things in this project derive from yt-dlp and are updated by this script:
#   A. the yt-dlp Python package  — the fallback engine inside the CONTAINER (pin in
#      videodl-container/requirements.in, hash-locked requirements.txt)
#   B. the challenge solver       — src/vendor/yt.solver.core.js from yt-dlp/ejs
#      (pinned in src/vendor/ejs.lock.json; compiled into every CLI binary)
#   C. the InnerTube client table — src/extractors/youtube.js (judgement call: only a
#      diff report is produced; a human edits, see UPDATE-FROM-YTDLP.md)
#
# Propagation rule: an upstream change is done only when the CONTAINER that embeds the
# result is built, tested, released, deployed and verified — the container is the
# engine's only production home. CLI first, container second, one component per run.
#
#   sudo -i
#   bash /storage/Samba/Temp/git/containers/videodl-script/update-from-upstream.sh check
#   bash …/update-from-upstream.sh run [--dry-run] [--no-deploy] [--component=ytdlp|ejs]
#   bash …/update-from-upstream.sh status
#
# Exit codes: 0 = nothing to do / promoted;  3 = human action required (client table
# diff, or a red gate — nothing deployed);  1 = error.
#
# Gate: tests/smoke.py against the CANDIDATE image (ghcr.io/hemues/videodl:candidate,
# never :latest) and again against the DEPLOYED container. A red candidate leaves the
# previous release in production and reverts the working trees. A red deploy rolls the
# container back to the previous versioned image tag.

set -euo pipefail

CLI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER_DIR="${CONTAINER_DIR:-$(cd "$CLI_DIR/../videodl-container" && pwd)}"
STATE_DIR="${STATE_DIR:-/var/lib/videodl-upstream}"
REPORT_DIR="$STATE_DIR/reports"
IMAGE="ghcr.io/hemues/videodl"
DEPLOY_USER="videodl"
DEPLOY_UID="$(id -u "$DEPLOY_USER" 2>/dev/null || echo 10019)"
UPDATER="/etc/scripts/podman-videodl-updater-inside-pod"
YTDLP_KEY_URL="https://raw.githubusercontent.com/yt-dlp/yt-dlp/master/public.key"
EJS_REPO="yt-dlp/ejs"

c()    { printf '\n\033[36m=== %s ===\033[0m\n' "$1"; }
ok()   { printf '\033[32m  ✓ %s\033[0m\n' "$1"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$1"; }
die()  { printf '\033[31mERROR: %s\033[0m\n' "$1" >&2; exit 1; }

CMD="${1:-}"; shift || true
DRY_RUN=false; NO_DEPLOY=false; COMPONENT="auto"
for a in "$@"; do
  case "$a" in
    --dry-run)      DRY_RUN=true ;;
    --no-deploy)    NO_DEPLOY=true ;;
    --component=*)  COMPONENT="${a#--component=}" ;;
    *) die "unknown option: $a" ;;
  esac
done

mkdir -p "$REPORT_DIR"
TS="$(date +%Y-%m-%d_%H%M)"
REPORT="$REPORT_DIR/UPDATE-REPORT-$TS.md"
report() { printf '%s\n' "$*" | tee -a "$REPORT" >/dev/null; printf '%s\n' "$*"; }

# ─────────────────────────────── discovery ───────────────────────────────────

pin_ytdlp()     { grep -oE '^yt-dlp==[0-9.]+' "$CONTAINER_DIR/requirements.in" | cut -d= -f3; }
latest_ytdlp()  { curl -fsSL --max-time 30 https://pypi.org/pypi/yt-dlp/json | python3 -c 'import sys,json;print(json.load(sys.stdin)["info"]["version"])'; }
pin_ejs()       { node -p "require('$CLI_DIR/src/vendor/ejs.lock.json').tag"; }
latest_ejs()    { gh release view --repo "$EJS_REPO" --json tagName -q .tagName; }
latest_cli_tag(){ gh release view --repo Hemues/videodl-script --json tagName -q .tagName; }

# yt-dlp's GitHub tag keeps leading zeros (2026.08.19); PyPI normalises them (2026.8.19).
pypi_to_tag() { python3 -c 'import sys;print(".".join(p.zfill(2) if i else p for i,p in enumerate(sys.argv[1].split("."))))' "$1"; }

client_table_diff() {
  # Machine diff of yt-dlp's INNERTUBE_CLIENTS (name → clientVersion) vs ours.
  local tmp; tmp="$(mktemp -d)"
  curl -fsSL --max-time 30 -o "$tmp/_base.py" https://raw.githubusercontent.com/yt-dlp/yt-dlp/master/yt_dlp/extractor/youtube/_base.py
  python3 - "$tmp/_base.py" "$CLI_DIR/src/extractors/youtube.js" <<'PY'
import re, sys, json
base = open(sys.argv[1], encoding='utf-8').read()
ours = open(sys.argv[2], encoding='utf-8').read()
# Compare on the InnerTube `clientName` (what YouTube sees), not on our internal labels:
# our 'TV' is clientName TVHTML5, our 'WEB_EMBEDDED' is WEB_EMBEDDED_PLAYER. Digits allowed.
up = {}
for m in re.finditer(r"'clientName':\s*'([A-Z0-9_]+)'.*?'clientVersion':\s*'([^']+)'", base, re.S):
    up.setdefault(m.group(1), m.group(2))
mine = {}
for m in re.finditer(r"clientName:\s*'([A-Z0-9_]+)'.*?clientVersion:\s*'([^']+)'", ours, re.S):
    mine.setdefault(m.group(1), m.group(2))
changed = {k: {'ours': mine[k], 'upstream': v} for k, v in up.items() if k in mine and mine[k] != v}
dropped_upstream = sorted(set(mine) - set(up))          # we still use a client yt-dlp removed → act
not_used_by_us = sorted(set(up) - set(mine))            # informational: yt-dlp knows more clients
print(json.dumps({'changed_versions': changed, 'ours_but_dropped_upstream': dropped_upstream,
                  'upstream_only_informational': not_used_by_us}, indent=2))
# Only version drift or a dropped client is actionable.
sys.exit(0 if not changed and not dropped_upstream else 10)
PY
  local rc=$?
  rm -rf "$tmp"
  return $rc
}

do_check() {
  c "yt-dlp (container engine, component A)"
  local pin latest; pin="$(pin_ytdlp)"; latest="$(latest_ytdlp)"
  echo "  pinned: $pin    upstream (PyPI): $latest"
  [ "$pin" = "$latest" ] && ok "up to date" || warn "UPDATE AVAILABLE: yt-dlp $pin → $latest"
  YTDLP_PIN="$pin"; YTDLP_LATEST="$latest"

  c "challenge solver yt-dlp/ejs (compiled into the CLI, component B)"
  local epin elatest; epin="$(pin_ejs)"; elatest="$(latest_ejs)"
  echo "  pinned: $epin    upstream: $elatest"
  [ "$epin" = "$elatest" ] && ok "up to date" || warn "UPDATE AVAILABLE: ejs $epin → $elatest"
  EJS_PIN="$epin"; EJS_LATEST="$elatest"

  c "InnerTube client table (component C — human decision)"
  if client_table_diff; then ok "client table matches upstream"; CLIENTS_DIFFER=false
  else warn "client table differs from upstream — see diff above; edit src/extractors/youtube.js per UPDATE-FROM-YTDLP.md"; CLIENTS_DIFFER=true; fi
}

# ─────────────────────────────── guards ──────────────────────────────────────

require_clean_repo() {
  local dir="$1"; shift
  local allowed="$*"   # files allowed to be dirty (build-script version churn)
  git -C "$dir" fetch -q origin
  local branch; branch="$(git -C "$dir" rev-parse --abbrev-ref HEAD)"
  [ "$branch" = "main" ] || die "$dir is on branch $branch, expected main"
  local behind; behind="$(git -C "$dir" rev-list --count HEAD..origin/main)"
  [ "$behind" = "0" ] || die "$dir is $behind commit(s) behind origin/main — pull first"
  local dirty; dirty="$(git -C "$dir" status --porcelain | awk '{print $2}')"
  for f in $dirty; do
    case " $allowed " in *" $f "*) ;; *) die "$dir has uncommitted changes ($f) — commit or stash them first";; esac
  done
}

verify_ytdlp_release() {
  # Independent integrity check of the GitHub release: SHA2-256SUMS signed with the
  # yt-dlp release key. (PyPI hashes are pinned separately by the requirements generator.)
  local tag="$1" tmp; tmp="$(mktemp -d)"
  if ! command -v gpg >/dev/null; then warn "gpg not installed — skipping signature check (PyPI hash pinning still applies)"; rm -rf "$tmp"; return 0; fi
  gh release download "$tag" --repo yt-dlp/yt-dlp -p 'SHA2-256SUMS' -p 'SHA2-256SUMS.sig' -D "$tmp" >/dev/null 2>&1 || { warn "could not fetch SHA2-256SUMS for $tag"; rm -rf "$tmp"; return 1; }
  curl -fsSL --max-time 30 -o "$tmp/public.key" "$YTDLP_KEY_URL"
  gpg --homedir "$tmp/gnupg" --batch --quiet --import "$tmp/public.key" 2>/dev/null || { mkdir -p "$tmp/gnupg"; chmod 700 "$tmp/gnupg"; gpg --homedir "$tmp/gnupg" --batch --quiet --import "$tmp/public.key"; }
  if gpg --homedir "$tmp/gnupg" --batch --verify "$tmp/SHA2-256SUMS.sig" "$tmp/SHA2-256SUMS" 2>"$tmp/verify.log"; then
    ok "yt-dlp $tag: SHA2-256SUMS signature valid ($(grep -oE 'using [A-Z]+ key [0-9A-F]+' "$tmp/verify.log" | head -1))"
    rm -rf "$tmp"; return 0
  fi
  cat "$tmp/verify.log" >&2; rm -rf "$tmp"; return 1
}

# ─────────────────────────────── build & gate ────────────────────────────────

build_candidate_container() {
  local cli_tag="$1"
  c "Building CANDIDATE container (embeds CLI $cli_tag) — never :latest"
  ( cd "$CONTAINER_DIR" && bash build.sh --tag "$cli_tag" --image="$IMAGE:candidate" --no-push --no-release )
}

gate() {
  local ref="$1" expect_ytdlp="$2" label="$3"
  c "Smoke gate — $label ($ref)"
  local out="$REPORT_DIR/smoke-$TS-$label.json"
  if python3 "$CLI_DIR/tests/smoke.py" --image "$ref" --expect-ytdlp "$expect_ytdlp" --json "$out"; then
    ok "gate GREEN ($label)"; report "- smoke gate $label: GREEN (\`$(basename "$out")\`)"; return 0
  fi
  report "- smoke gate $label: **RED** (\`$(basename "$out")\`)"; return 1
}

previous_image_tag() { gh release view --repo Hemues/videodl-container --json tagName -q .tagName; }

promote_and_deploy() {
  local cli_tag="$1" expect_ytdlp="$2"
  c "Promote candidate → :latest + versioned tag + GitHub release"
  ( cd "$CONTAINER_DIR" && bash build.sh --promote="$IMAGE:candidate" --tag "$cli_tag" --no-increment )
  local new_ver; new_ver="$(grep -m1 '^version = ' "$CONTAINER_DIR/pyproject.toml" | sed 's/version = "\(.*\)"/\1/' | tr -d '\r')"
  report "- container released: v$new_ver (embeds CLI $cli_tag, yt-dlp $expect_ytdlp)"

  if $NO_DEPLOY; then warn "--no-deploy: image is on ghcr as :latest and :v$new_ver; deploy later with: sudo -iu $DEPLOY_USER $UPDATER"; return 0; fi

  c "Deploy (rootless updater as $DEPLOY_USER)"
  sudo -n -u "$DEPLOY_USER" env XDG_RUNTIME_DIR="/run/user/$DEPLOY_UID" podman pull -q "$IMAGE:latest"   # pre-pull: minimal downtime
  sudo -n -u "$DEPLOY_USER" env XDG_RUNTIME_DIR="/run/user/$DEPLOY_UID" "$UPDATER" >/dev/null
  sleep 8

  c "Verify DEPLOYED container"
  local out="$REPORT_DIR/smoke-$TS-deployed.json"
  if python3 "$CLI_DIR/tests/smoke.py" --deployed videodl --as-user "$DEPLOY_USER" --uid "$DEPLOY_UID" --expect-ytdlp "$expect_ytdlp" --json "$out"; then
    ok "deployed verification GREEN"; report "- deployed verification: GREEN — production runs v$new_ver"; return 0
  fi
  report "- deployed verification: **RED** — rolling back to $PREV_TAG"
  rollback "$PREV_TAG"; return 1
}

rollback() {
  local tag="$1"
  c "ROLLBACK to $IMAGE:$tag"
  if ! podman pull -q "$IMAGE:$tag"; then die "rollback image $IMAGE:$tag not available on ghcr (versioned tags exist from 2.0.136 on) — manual intervention required"; fi
  podman tag "$IMAGE:$tag" "$IMAGE:latest" && podman push -q "$IMAGE:latest"
  sudo -n -u "$DEPLOY_USER" env XDG_RUNTIME_DIR="/run/user/$DEPLOY_UID" "$UPDATER" >/dev/null
  warn "production rolled back to $tag; the failed release stays on GitHub for inspection"
}

revert_trees() {
  git -C "$CONTAINER_DIR" checkout -q -- pyproject.toml ui/package.json requirements.in requirements.txt 2>/dev/null || true
  git -C "$CLI_DIR" checkout -q -- package.json src/vendor/yt.solver.core.js src/vendor/ejs.lock.json 2>/dev/null || true
  podman rmi -f "$IMAGE:candidate" >/dev/null 2>&1 || true
}

# ─────────────────────────────── components ──────────────────────────────────

update_ytdlp() {
  local new="$YTDLP_LATEST" tag; tag="$(pypi_to_tag "$YTDLP_LATEST")"
  report "## yt-dlp $YTDLP_PIN → $new"
  verify_ytdlp_release "$tag" || die "yt-dlp $tag release signature verification FAILED — not updating"
  $DRY_RUN && { echo "  (dry-run) would pin yt-dlp==$new, regenerate hashes, build candidate, gate, promote, deploy"; return 0; }

  sed -i -E "s/^yt-dlp==[0-9.]+/yt-dlp==$new/" "$CONTAINER_DIR/requirements.in"
  ( cd "$CONTAINER_DIR" && python3 tools/gen-requirements-hashes.py )
  ok "requirements.in/.txt pinned to yt-dlp==$new (hashes from PyPI)"

  local cli_tag; cli_tag="$(latest_cli_tag)"
  PREV_TAG="$(previous_image_tag)"
  build_candidate_container "$cli_tag"
  if ! gate "$IMAGE:candidate" "$new" candidate; then
    revert_trees; report "Result: **NOT promoted** — previous release stays in production."; exit 3
  fi
  ( cd "$CONTAINER_DIR" && git add requirements.in requirements.txt pyproject.toml ui/package.json && \
    git commit -q -m "yt-dlp $YTDLP_PIN → $new (upstream update, gate green)

Verified: yt-dlp $tag SHA2-256SUMS signature; PyPI hashes regenerated; candidate image passed tests/smoke.py.

Co-Authored-By: update-from-upstream.sh <noreply@localhost>" && git push -q origin main )
  promote_and_deploy "$cli_tag" "$new" || exit 3
}

update_ejs() {
  local new="$EJS_LATEST" tmp; tmp="$(mktemp -d)"
  report "## challenge solver ejs $EJS_PIN → $new"
  gh release download "$new" --repo "$EJS_REPO" -p 'yt.solver.core.js' -D "$tmp" >/dev/null
  local sha; sha="$(sha256sum "$tmp/yt.solver.core.js" | cut -d' ' -f1)"
  echo "  asset sha256: $sha"
  $DRY_RUN && { echo "  (dry-run) would vendor ejs $new, compile all CLI targets, build candidate, gate, promote, deploy"; rm -rf "$tmp"; return 0; }

  tr -d '\r' < "$tmp/yt.solver.core.js" > "$CLI_DIR/src/vendor/yt.solver.core.js"
  python3 - "$CLI_DIR/src/vendor/ejs.lock.json" "$new" "$sha" <<'PY'
import json, sys
p, tag, sha = sys.argv[1:]
d = json.load(open(p, encoding='utf-8')); d['tag'] = tag; d['sha256'] = sha
json.dump(d, open(p, 'w', encoding='utf-8'), indent=2); open(p, 'a').write('\n')
PY
  rm -rf "$tmp"

  c "Source smoke (YouTube must still extract with the new solver)"
  ( cd "$CLI_DIR" && python3 tests/smoke.py --source --filter youtube ) || { revert_trees; report "Result: **NOT adopted** — new solver breaks YouTube extraction from source."; exit 3; }

  c "Publish CLI release (all targets)"
  ( cd "$CLI_DIR" && bash compile.sh )
  local cli_tag; cli_tag="$(latest_cli_tag)"
  ( cd "$CLI_DIR" && git add src/vendor/yt.solver.core.js src/vendor/ejs.lock.json package.json && \
    git commit -q -m "solver: vendor yt-dlp/ejs $new (upstream update)

sha256 $sha recorded in src/vendor/ejs.lock.json; CLI $cli_tag published.

Co-Authored-By: update-from-upstream.sh <noreply@localhost>" && git push -q origin main )
  report "- CLI released: $cli_tag"

  PREV_TAG="$(previous_image_tag)"
  build_candidate_container "$cli_tag"
  if ! gate "$IMAGE:candidate" "$YTDLP_PIN" candidate; then
    git -C "$CONTAINER_DIR" checkout -q -- pyproject.toml ui/package.json; podman rmi -f "$IMAGE:candidate" >/dev/null 2>&1 || true
    report "Result: **NOT promoted** — CLI $cli_tag is published but the container gate was red; previous container stays in production."; exit 3
  fi
  ( cd "$CONTAINER_DIR" && git add pyproject.toml ui/package.json && git commit -q -m "Release: embed videodl-cli $cli_tag (ejs $new)" && git push -q origin main )
  promote_and_deploy "$cli_tag" "$YTDLP_PIN" || exit 3
}

# ─────────────────────────────── commands ────────────────────────────────────

case "$CMD" in
  check)
    do_check ;;
  status)
    do_check
    c "Last report"; ls -1t "$REPORT_DIR"/UPDATE-REPORT-*.md 2>/dev/null | head -1 | xargs -r cat ;;
  run)
    [ "$(id -u)" = "0" ] || die "run as root (gh, podman, ghcr auth are root-only): sudo -i"
    command -v gh >/dev/null && command -v podman >/dev/null && command -v python3 >/dev/null || die "gh, podman and python3 are required"
    report "# videodl upstream update — $TS"
    do_check
    if ! $DRY_RUN; then
      require_clean_repo "$CLI_DIR" package.json
      require_clean_repo "$CONTAINER_DIR" pyproject.toml ui/package.json
    fi
    did_something=false
    if [ "$COMPONENT" = "auto" ] || [ "$COMPONENT" = "ytdlp" ]; then
      if [ "$YTDLP_PIN" != "$YTDLP_LATEST" ]; then update_ytdlp; did_something=true; fi
    fi
    if ! $did_something && { [ "$COMPONENT" = "auto" ] || [ "$COMPONENT" = "ejs" ]; }; then
      if [ "$EJS_PIN" != "$EJS_LATEST" ]; then update_ejs; did_something=true; fi
    fi
    if ! $did_something; then
      if $CLIENTS_DIFFER; then report "Result: no package update; **InnerTube client table differs — human edit required** (see check output)."; exit 3; fi
      report "Result: everything up to date — nothing to do."; exit 0
    fi
    report "Result: promoted. See $REPORT"
    ;;
  *)
    echo "usage: $0 {check|run|status} [--dry-run] [--no-deploy] [--component=ytdlp|ejs]"; exit 1 ;;
esac
