# Agent Notes

## Documentation Discipline
- Treat documentation as part of the change, not a follow-up. When behavior, commands, deployment flow, debugging steps, requirements, or lessons learned change, update the nearest `README.md` and this `AGENTS.md` in the same change.
- Keep `README.md` focused on user/operator-facing setup, usage, troubleshooting, and release/deployment steps.
- Keep `AGENTS.md` focused on future-agent context: architecture traps, verified commands, gotchas, environment details, and lessons learned.
- If a repo also has `LESSONS-LEARNED.md`, record durable postmortems there too and cross-reference from `README.md`/`AGENTS.md`.
- Before finishing, check that docs reflect what was actually tested, committed, released, or deliberately skipped.

## What This Directory Is
This is the standalone `videodl` Node.js CLI project. It implements native extractors for many video sites, HLS/DASH handling, subtitles, cookies, optional captcha/transcription helpers, and standalone binary builds for Linux/Windows.

## Start Here
- Read `README.md` for supported sites, CLI flags, packaging, and release workflow.
- Read `LESSONS-LEARNED.md` before touching extractors, HTTP/TLS behavior, or packaging.
- Check `package.json` scripts before assuming the build command; this project uses npm tooling and bundles external runtime helpers such as ffmpeg/cycletls where needed.
- To update from yt-dlp and ship it end-to-end (rebuild CLI → publish → embed in videodl-container → gate → deploy → verify), follow `UPDATE-FROM-YTDLP.md` and run `bash update-from-upstream.sh {check|run|status}` on the build host (host-specific values live in the private `/etc/videodl-upstream.env`, never in this repo).

## Security posture & update pipeline (2026-09-13, CLI 2.0.137)
- `REVIEW-2026-09-13.md` = the code + security review of both repos. Its High/Medium
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

## Work Safely
- Do not commit cookies, tokens, captcha keys, account credentials, or captured request headers.
- Treat extractor fixes as site-specific protocol work. Prefer small adapters and fixtures over broad rewrites.
- Keep yt-dlp fallback behavior separate from native extractor logic unless the README says otherwise.
- Cloudflare and TLS fingerprinting fixes are fragile; document the target site, failure mode, and headers/cookies required without storing private values.

## Validation
- Run the existing npm build/test/lint commands from `package.json` when available.
- For extractor changes, validate with a harmless public URL plus one authenticated/manual case if the user provides credentials directly.
- Confirm packaged binaries still include required helper binaries and can find ffmpeg/cycletls at runtime.
