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
- To re-sync YouTube handling from yt-dlp and ship it end-to-end (rebuild CLI → publish → embed in videodl-container → deploy → verify), follow `UPDATE-FROM-YTDLP.md` and run `./update-from-ytdlp.sh {check|ship}` (as root on 11.1.0.2).

## Work Safely
- Do not commit cookies, tokens, captcha keys, account credentials, or captured request headers.
- Treat extractor fixes as site-specific protocol work. Prefer small adapters and fixtures over broad rewrites.
- Keep yt-dlp fallback behavior separate from native extractor logic unless the README says otherwise.
- Cloudflare and TLS fingerprinting fixes are fragile; document the target site, failure mode, and headers/cookies required without storing private values.

## Validation
- Run the existing npm build/test/lint commands from `package.json` when available.
- For extractor changes, validate with a harmless public URL plus one authenticated/manual case if the user provides credentials directly.
- Confirm packaged binaries still include required helper binaries and can find ffmpeg/cycletls at runtime.
