# Agent Notes

## Documentation Discipline
- Treat documentation as part of the change, not a follow-up. When behavior, commands, deployment flow, debugging steps, requirements, or lessons learned change, update the nearest `README.md` and this `AGENTS.md` in the same change.
- Keep `README.md` focused on user/operator-facing setup, usage, troubleshooting, and release/deployment steps.
- Keep `AGENTS.md` focused on future-agent context: architecture traps, verified commands, gotchas, environment details, and lessons learned.
- If a repo also has `LESSONS-LEARNED.md`, record durable postmortems there too and cross-reference from `README.md`/`AGENTS.md`.
- Before finishing, check that docs reflect what was actually tested, committed, released, or deliberately skipped.
- Operator manual: `docs/HOWTO-USE.md` (every option, examples with synthetic URLs, troubleshooting). When a flag, default or error text changes, change it there in the same commit.
- Phase history: `STORYLINE.md`. Add a line to its last phase when a release or a contract changes the direction.
- Line endings of the Markdown files: `README.md`, `LESSONS-LEARNED.md` and `CHANGELOG.md` are CRLF at HEAD; `AGENTS.md`, `STORYLINE.md`, `docs/HOWTO-USE.md` and the code are LF. Before a commit, compare `git show HEAD:<file> | tr -cd '\r' | wc -c` with `tr -cd '\r' < <file> | wc -c` and keep the HEAD style (LESSONS #20). Count with `tr`, never with `grep -c $'\r'`.

## What This Directory Is
This is the standalone `videodl` Node.js CLI project. It implements native extractors for many video sites, HLS/DASH handling, subtitles, cookies, optional captcha/transcription helpers, and standalone binary builds for Linux/Windows.

## Start Here
- Read `README.md` for the overview, the version, the architecture and the support table. Read `docs/HOWTO-USE.md` for every command and option.
- Read `LESSONS-LEARNED.md` before touching extractors, HTTP/TLS behavior, subtitles, defaults, or packaging. Entries #20 to #30 were added on 2026-10-31 and cover the CRLF slip, the silent subtitle default, the symlink, the mode flips and the Skool and playlist fixes.
- Read `STORYLINE.md` for the phases and the decisions behind the current state.
- Check `package.json` scripts before assuming the build command; this project uses npm tooling and bundles external runtime helpers such as ffmpeg/cycletls where needed.
- To update from yt-dlp and ship it end-to-end (rebuild CLI → publish → embed in videodl-container → gate → deploy → verify), follow `UPDATE-FROM-YTDLP.md` and run `bash update-from-upstream.sh {check|run|status}` on the build host (host-specific values live in the private `/etc/videodl-upstream.env`, never in this repo).

## Environment
- Repository: public, on the code host (`Hemues/videodl-script`). Tags run from `v2.0.x`; the newest is `v2.0.139` (2026-10-03). HEAD on 2026-10-31: `4ade70b` (the 2026-10-31 fleet audit commit, committed and pushed; the commit before it is `7ff739d`).
- Node: the build host uses `/usr/bin/node` v22.22.2 (verified 2026-10-31). `package.json` says `node >= 18`. SEA builds need the official Node binary pinned in `build-pins.json` (LESSONS #11).
- Two local clones of this repository exist on the owner's build network share. One is the working clone. The other is a mirror that must be fast-forwarded after every push and never edited. This note gives no paths on purpose (public repository; LESSONS #22). Keep the mirror at HEAD after each push.
- Linux truth for status: `git -c core.fileMode=false status --short` on the build host. The Windows view through the share shows mode flips and line-ending warnings that are not content (LESSONS #24).
- The build host is a Linux machine with a small home volume. Keep caches on the large volume, not in the home directory.
- Uploads (git push, GitHub release, container image) run as root on the build host with the GitHub CLI. The build user has no GitHub credential. Never push from the Windows side of the share (stale index). (Fleet rule, see the container repository.)
- The release binaries and the container image are not built from the Windows side.

## Verified commands
- `node src/cli.js --version` → `2.0.139` (verified 2026-10-31 on the build host).
- `node src/cli.js extractors --json` → 49 entries; 47 native extractors plus `ytdlp` and `direct` (verified 2026-10-31).
- `node src/cli.js download --help` → the full option list (verified 2026-10-31). Its subtitle section contradicts the code on the default; see LESSONS #21.
- `git -c core.fileMode=false status --short` on the build host → `?? tests/__pycache__/` and nothing else on 2026-10-31. The tracked symlink `.compile.unix.sh` is in HEAD (LESSONS #23).
- `git log --date=short --reverse --format='%ad %h %s'` → 91 commits, 2026-02-25 to 2026-10-31 (verified 2026-10-31; 90 commits up to `7ff739d` before the audit commit).
- `git tag --sort=creatordate --format='%(creatordate:short) %(refname:short)' | tail -4` → `v2.0.134`, `v2.0.136`, `v2.0.137`, `v2.0.139` (verified 2026-10-31).
- `python3 tests/smoke.py --source` → runs the cases through `node src/cli.js`; needs network (not verified in the 2026-10-31 pass).
- `bash compile.sh --bundle-only` → CJS bundle only (not verified in the 2026-10-31 pass).
- `bash update-from-upstream.sh status` → on the build host only, needs the private env file (not verified in the 2026-10-31 pass).

## File ownership and boundaries
| Path | Owner / rule |
| --- | --- |
| `src/extractors/youtube.js` InnerTube table | Synced by hand from yt-dlp; the pipeline only reports a diff (human decision) |
| `src/vendor/yt.solver.core.js`, `src/vendor/ejs.lock.json` | Vendored from yt-dlp/ejs; hash pinned; replaced by the pipeline only |
| `build-pins.json` | Pins (Node, ffmpeg with sha256). Change deliberately with the new hash |
| `package-lock.json` | Committed; `compile.sh` uses `npm ci`. Do not delete |
| `contrib/po-token-provider.mjs` | Reference only (PO-token minter, deferred; LESSONS #14). Not in the binary |
| `contrib/systemd/*` | Templates for the maintainer updater. The real env file is private |
| `REVIEW-2026-09-13.md` | Historical review. Its findings are fixed in 2.0.139 (see CHANGELOG Security) |
| `cookies/cookies.txt`, `logins/logins.txt`, `downloads/`, `dist/` | Ignored by git. Cookies and logins are secrets |
| `examples.js`, `test-extractor.js`, `debug-title.js` | Developer helpers; not part of the release |
| `.compile.unix.sh` | Accidental symlink to `/tmp`; tracked in HEAD; remove only with the owner's agreement (LESSONS #23) |

## Security posture & update pipeline (2026-09-13, CLI 2.0.137; kept at 2.0.139)
  `REVIEW-2026-09-13.md` = the code + security review of both repos. Its High/Medium
  findings are **fixed** in 2.0.137 (`CHANGELOG.md` → Security, `LESSONS-LEARNED.md #18`).
  2.0.136 exists on GitHub but is superseded (its embedded ffmpeg master snapshot
  truncates byte-range HLS) — never embed it.
  Keep these invariants when editing:
  - `downloader.js`: ffmpeg `-protocol_whitelist` must never contain `file`; local
    playlists go in as `data:` URIs (`hlsPlaylistToDataUri`).
  - `cli.js`: any user-supplied output name goes through `resolveOutputFilename()`
    (template expansion + confinement to `-d`).
  - URLs that will be fetched go through `assertPublicUrl()` (`url-guard.js`); `got`
    calls that follow redirects should spread `privateGuardHooks()`.
  - The YouTube solver only runs via `solver-sandbox.js` (child + `--permission`).
  - New `canHandle()` = `hostMatches(url, [...])`, never a substring regex.
  - Builds are pinned: `build-pins.json` (Node, ffmpeg + sha256), `src/vendor/ejs.lock.json`
  (solver), committed `package-lock.json` + `npm ci`. Bump pins deliberately, with the
  new hash. The host Node must equal the pinned version (SEA blob format).
- `bash compile.sh` builds **all targets** (linux-x64, linux-arm64, win-x64 ×2 variants,
  win-x86 plain) and uploads `SHA256SUMS`; the container `build.sh` verifies against it,
  pushes `:latest` **and** `:vX.Y.Z`, and has `--no-release` / `--promote=<ref>` for
  the candidate → promote flow.
- `tests/smoke.py` is the acceptance gate (`--source|--binary|--image|--deployed`).
  Run it from source before committing extractor/downloader changes; the pipeline runs
  it on the candidate image and again on the deployed container.
- `update-from-upstream.sh {check|run|status}` is the yt-dlp update checker/pipeline;
  `UPDATE-FROM-YTDLP.md` is its runbook. A weekly systemd timer on the build host runs it.
- **This repository is public.** Never commit hostnames, addresses, share paths, user
  names/uids, updater script paths or other home-lab specifics — they belong in
  `/etc/videodl-upstream.env` on the host or in the private container repo's docs.

## Extractor gotchas
- **PornHub (2.0.139):** HLS masters come from `ev-h` (works) or `hv-h.phncdn.com`
  (Cloudflare, `410 Gone` to non-browsers), chosen per page load; `get_media` returns
  `[]` without the watch page's cookies. Keep the shared `CookieJar` in
  `pornhub.js`; the mp4 list is the dependable path. `LESSONS-LEARNED.md #19`.
- An endpoint that answers 200 with an empty list usually means missing session state
  (cookies from the page fetch), not a site redesign. Check that before rewriting parsers.
- **Skool (2.0.101 to 2.0.112):** lesson data is in `__NEXT_DATA__`; Mux playback needs
  the `Referer` and `Origin` of skool.com; the title comes from the course tree breadcrumb.
  `LESSONS-LEARNED.md #27`.
- **Playlist results** have `_type: 'playlist'` and no `formats`. Check the type before
  reading fields (`LESSONS-LEARNED.md #28`).
- **YouTube auto-translate** (`&tlang=`) answers 429 to anonymous requests. Keep the pacing
  and the cookie forwarding (`LESSONS-LEARNED.md #29`).
- **HentaiHaven** must be fetched with `curl`, not Node or cycletls (Cloudflare managed
  challenge, `LESSONS-LEARNED.md #15`).
- **Obfuscated HLS segment names** (`.html`, `.txt`) need `-allowed_extensions ALL`; and
  `-extension_picky 0` only when the ffmpeg build knows it (`LESSONS-LEARNED.md #15`).
- **DRM:** detect and refuse, never circumvent. Plain HLS AES-128 is not DRM
  (`LESSONS-LEARNED.md #16`).
- **Mux and CDNs with referrer rules:** test with curl without and with the header first.

## Subtitle policy (read before touching `src/cli.js`)
- `DEFAULT_SUB_LANGS` is an empty list since commit `dbcea2e` (2026-04-25). The help text and the README disagree with the code. The owner must decide (LESSONS #21). Do not change the default silently.
- The fallback chain per language: official track, then automatic track, then YouTube auto-translate, then skip (`resolveSubtitleDownloads`).
- Subtitle downloads are paced (400 ms, backoff, `Retry-After`). Keep the pacing when you add a path.
- Every subtitle track is kept by the disposition step: use `-map 0` in any ffmpeg remux (LESSONS #13).

## Work Safely
- Do not commit cookies, tokens, captcha keys, account credentials, or captured request headers.
- Treat extractor fixes as site-specific protocol work. Prefer small adapters and fixtures over broad rewrites.
- Keep yt-dlp fallback behavior separate from native extractor logic unless the README says otherwise.
- Cloudflare and TLS fingerprinting fixes are fragile; document the target site, failure mode, and headers/cookies required without storing private values.
- Commit with explicit paths. Do not use `git add -A` or `git commit -a` (a sync commit once staged a symlink and 87 mode flips; LESSONS #23, #24).
- Do not change a default, a flag or an error text without a CHANGELOG line and a test or a HOWTO line (LESSONS #21).

## Validation
- Run the existing npm build/test/lint commands from `package.json` when available.
- For extractor changes, validate with a harmless public URL plus one authenticated/manual case if the user provides credentials directly.
- Confirm packaged binaries still include required helper binaries and can find ffmpeg/cycletls at runtime.
- Run `python3 tests/smoke.py --source --filter <site>` for the site you touched. Run `--binary` on the built binary before a release (LESSONS #26).
- Read a passing run's warnings, not only its pass count.

## Traps (read before changing anything)
- **Windows checkout and modes** (2026-03-20 to 2026-07-21): every file of a Windows copy looks executable. `git config core.fileMode false` on the Windows checkout; read `git -c core.fileMode=false status --short` (LESSONS #24).
- **Line endings** (2026-10-14): a file written with LF replaces CRLF as a whole-file diff; count CRs before a commit (LESSONS #20).
- **Silent default change** (2026-04-25, `dbcea2e`): a commit whose subject is about file names changed the subtitle default. Look at `git diff --ignore-cr-at-eol` for every "fix:" commit that touches `src/cli.js` (LESSONS #21).
- **Dangling symlink** `.compile.unix.sh` (2026-07-21): not a file on any other checkout (LESSONS #23).
- **Superseded release 2.0.136** (2026-09-13): its ffmpeg master snapshot truncated HLS downloads silently. Never embed it (LESSONS #18 item 8).
- **Fedora base image has no `which`** (2026-09-13): the container silently used the embedded ffmpeg. Look up tools in-process (LESSONS #18 item 8c).
- **Windows stdout encoding** (2026-09-13): `subprocess.run(text=True)` decodes as cp1252. Use `encoding='utf-8', errors='replace'` (LESSONS #18 item 4).
- **Substring `canHandle()`** (2026-09-13): match hostnames with `hostMatches()`. Some older extractors still use substrings; migrate them when touched (LESSONS #18 item 5).
- **Mapped network drives and the permission model** (2026-09-13): the solver child is granted read access to the drive-letter path from `argv[1]` with `path.resolve`, never `realpath` (LESSONS #18 item 3).
- **SEA binaries** need the official Node binary (`VIDEODL_SEA_NODE`) and must be rebuilt after a version bump (LESSONS #11).
- **`grep -c` with zero matches** exits 1 and breaks a `&&` chain. Use `grep -c ... || true` in scripts.

## What never to do
- Never publish host names, addresses, share paths, user names, uids or updater paths in this repository.
- Never rewrite the history of this public repository without the owner's decision.
- Never force-push or rewrite a published tag. Tags `v2.0.136` (superseded) and `v2.0.137` exist; do not move them.
- Never embed the 2.0.136 build or the ffmpeg master snapshot.
- Never add a DRM bypass, a CDM, keys or decryption (LESSONS #16).
- Never edit the installed updater copy on the build host directly; edit the repo copy and reinstall it through the maintainer's process.
- Never push from the Windows side of the share.

## Open items (2026-10-31)
- Subtitle default: decide and make code, help, README and HOWTO agree (LESSONS #21).
- Remove or keep the symlink `.compile.unix.sh` in its own commit (LESSONS #23).
- Decide whether non-script files should be mode 100644 again (LESSONS #24).
- Old commits still hold the home-lab text removed on 2026-09-13; history rewrite is an owner option (LESSONS #22).
- CHANGELOG 2.0.10 header date (2026-07-17) and the order of the 2.0.10 and 2.0.30 entries; the 2.0.139 entry still says no tag exists (LESSONS #30).
- The PO-token minter stays deferred (LESSONS #14).
