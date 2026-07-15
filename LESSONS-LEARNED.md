# VideoDL Script — Lessons Learned

Reference for developing and maintaining the VideoDL CLI video downloader
(Node.js, 35+ native extractors, yt-dlp fallback).

Entries marked ✅ are verified in production. Entries marked ⏳ are pending verification.

---

## Table of Contents

1. [Site Extractors Break Frequently](#1--site-extractors-break-frequently)
2. [CycleTLS for Cloudflare Bypass](#2--cycletls-for-cloudflare-bypass)
3. [HLS Stream Stitching Edge Cases](#3--hls-stream-stitching-edge-cases)
4. [Standalone Binary Compilation with pkg](#4--standalone-binary-compilation-with-pkg)
5. [YouTube Premium Bitrate Upgrade](#5--youtube-premium-bitrate-upgrade)
6. [Cookie Extraction via Puppeteer](#6--cookie-extraction-via-puppeteer)
7. [xHamster HLS Download Stuck — No Progress Events](#7--xhamster-hls-download-stuck--no-progress-events)
8. [Dailymotion Quality Label Mismatch](#8--dailymotion-quality-label-mismatch)
9. [AShemaleTube embed format change](#9--ashemaletube-embed-format-change)
10. [Release artifacts belong in GitHub Releases, not git](#10--release-artifacts-belong-in-github-releases-not-git)
11. [SEA binaries must be built with official Node.js binary](#11--sea-binaries-must-be-built-with-official-nodejs-binary)
12. [Chapter Embedding via ffmetadata](#12--chapter-embedding-via-ffmetadata)
13. [ffmpeg -map 0 Required When Remuxing Multi-Stream Files](#13--ffmpeg--map-0-required-when-remuxing-multi-stream-files)
14. [YouTube 403 — Client Table & gvs PO Tokens (Phase 2 deferred)](#14--youtube-403--client-table--gvs-po-tokens-phase-2-deferred)
15. [HentaiHaven — Cloudflare managed challenge (curl only) & obfuscated HLS segments](#15--hentaihaven--cloudflare-managed-challenge-curl-only--obfuscated-hls-segments)

---

## General Design Lessons

### Native extractors always outperform generic fallbacks
Site-specific extractors can exploit API endpoints, bypass rate limits, and
access premium quality. The yt-dlp fallback handles 1000+ sites but with
fewer optimizations.

### Cookie-based auth is fragile — sessions expire unpredictably
Browser cookie extraction via Puppeteer works but cookies expire, get rotated,
or require re-authentication. Always handle cookie failure gracefully with a
clear error message.

### Each site's API is a moving target
Video sites change their APIs, add new DRM, rotate CDN URLs, and modify embed
structures without notice. Plan for extractors to need regular updates.

---

## #1 — Site Extractors Break Frequently

**Status:** ✅ VERIFIED (multiple commits: "add new site", "some minor fixes")

**Symptom:**
Previously working downloads fail with "no formats found" or HTTP 403 errors.

**Root Cause:**
Video sites update their API endpoints, change authentication flows, or modify
page structure without warning.

**Fix:**
Monitor failure patterns and update extractors promptly. The commit history
shows regular "add new site" and "some minor fixes" commits addressing these
breakages.

---

## #2 — CycleTLS for Cloudflare Bypass

**Status:** ✅ VERIFIED

**Symptom:**
Downloads from Cloudflare-protected sites fail with 403 or challenge pages.

**Root Cause:**
Standard Node.js `fetch()` / `axios` sends TLS fingerprints that Cloudflare
detects as bot traffic. The TLS ClientHello doesn't match any known browser.

**Fix:**
CycleTLS is a Go sidecar binary that emulates real browser TLS fingerprints
(Chrome, Firefox, Safari). It handles the TLS handshake while Node.js handles
the HTTP logic.

**Key Lesson:** Modern anti-bot systems fingerprint the TLS handshake, not just
User-Agent headers. A native Go TLS implementation is needed to impersonate browsers.

---

## #3 — HLS Stream Stitching Edge Cases

**Status:** ✅ VERIFIED

**Symptom:**
Downloaded video has gaps, audio desync, or missing segments.

**Root Cause:**
HLS streams use `.m3u8` playlists with variable segment durations. Some sites
use discontinuity markers, key rotation, or byterange requests that naive
downloaders don't handle.

**Fix:**
Dedicated HLS downloader handles:
- `#EXT-X-DISCONTINUITY` markers (reset timestamp)
- `#EXT-X-KEY` rotation (per-segment decryption)
- `#EXT-X-BYTERANGE` (partial file downloads)
- ffmpeg remuxing to fix timestamp issues

---

## #4 — Standalone Binary Compilation with pkg

**Status:** ✅ VERIFIED

**Symptom:**
Compiled binary crashes on target systems or is excessively large.

**Root Cause:**
`pkg` bundles the Node.js runtime + all `node_modules`. Native modules
(e.g., `sharp`, `@parcel/watcher`) need platform-specific binaries that
pkg doesn't always bundle correctly.

**Fix:**
Use `--targets node18-linux-x64` (or appropriate target). Ensure native
dependencies are pre-built for the target platform. The CycleTLS Go binary
is distributed separately, not bundled inside the pkg binary.

---

## #5 — YouTube Premium Bitrate Upgrade

**Status:** ✅ VERIFIED

**Symptom:**
YouTube downloads are capped at 128kbps audio despite Premium account.

**Root Cause:**
YouTube serves higher bitrate audio (256kbps AAC) only to authenticated
Premium users via specific API parameters. The generic yt-dlp fallback
may not request these.

**Fix:**
Native YouTube extractor detects Premium auth via cookies and requests
the higher bitrate format IDs.

---

## #6 — Cookie Extraction via Puppeteer

**Status:** ✅ VERIFIED

**Symptom:**
Auth-required downloads fail even after the user logs in via browser.

**Root Cause:**
The CLI needs the browser's session cookies but can't access them directly
(they're encrypted in the browser's cookie store).

**Fix:**
Puppeteer launches a headless browser, navigates to the target site's login
page, and extracts cookies after authentication. These cookies are saved and
reused for subsequent downloads.

---

## #7 — xHamster HLS Download Stuck — No Progress Events

**Status:** ✅ VERIFIED (commit 916a316)

**Symptom:**
xHamster downloads start but show 0% progress forever, then eventually timeout.

**Root Cause:**
The xHamster extractor wasn't emitting download progress events for HLS streams.
The download was actually proceeding but the UI showed no progress, making it
appear stuck.

**Fix:**
Added progress event emission in the HLS download handler for the xHamster
extractor.

---

## #8 — Dailymotion Quality Label Mismatch

**Status:** ✅ VERIFIED (commit b4e75d5)

**Symptom:**
Selecting "1080p" quality downloads a different resolution than expected.

**Root Cause:**
Dailymotion's API returns quality labels (e.g., "1080") that don't match actual
pixel heights. The extractor was using pixel height for matching instead of the
label string.

**Fix:**
Use Dailymotion's quality labels directly instead of trying to infer resolution
from pixel dimensions.

---

## #9 — AShemaleTube embed format change

**Status:** ✅ VERIFIED

**Symptom:**
AShemaleTube downloads reported no formats found, even though the page title and
embed iframe were still present.

**Root Cause:**
The site switched from the legacy `var sources = [...]` embed format to a
single `playerConfig.sources.hlsAuto` HLS master playlist URL. The URL path
contains a `/multi=WxH:key,.../` descriptor and the `_TPL_.mp4` token is
literal, not a substitution placeholder.

**Fix:**
Updated the AShemaleTube extractor to:
- parse `playerConfig.sources.hlsAuto` from the embed page,
- decode the JSON-escaped URL string,
- enumerate quality renditions from the `/multi=.../` segment,
- expose explicit HLS format entries for each available resolution,
- preserve the legacy `var sources = [...]` fallback for older embeds.

**Verification:**
Tested successfully with `https://www.ashemaletube.com/videos/1163113/best-friends/`.

**Last update:** 2026-04-17

## #10 — Release artifacts belong in GitHub Releases, not git

**Status:** ✅ Verified

**Problem:** Committing compiled binaries (90–320 MB each) to the git repository causes push failures
(GitHub rejects files > 100 MB) and bloats the repo history. Git LFS is an option but adds
complexity, especially on network-share repos with "dubious ownership" issues.

**Solution:** Use `gh release create` from a machine where the GitHub CLI is authenticated.
Binaries are uploaded as GitHub Release assets, completely outside the git tree.

**Release process:**
1. Bump version in `package.json`.
2. Update `CHANGELOG.md` header from `[Unreleased]` to the new version.
3. Commit and push version bump.
4. Build Linux binaries on server: `VIDEODL_SEA_NODE=dist/node-official node build.mjs --linux --package`.
5. Build Windows binaries locally: `npm run build`.
6. Create release: `gh release create v<VERSION> --title v<VERSION> --notes-file <notes> dist/videodl.exe dist/videodl-linux dist/videodl-ffmpeg.exe dist/videodl-ffmpeg-linux dist/videodl.cjs dist/index.exe dist/index dist/cycletls-index-linux`.
7. **Verify** uploaded binary: download from release and check `--version` output matches.

**Key insight:** The `gh` CLI must be authenticated (`gh auth login`). On the NAS (11.1.0.2:60001),
root has a valid token at `/root/.config/gh/hosts.yml`. Run via `sudo bash -c '...'`.

**Last update:** 2026-04-17

## #11 — SEA binaries must be built with official Node.js binary

**Status:** ✅ Verified

**Problem:** Distro-packaged Node.js binaries (e.g. Fedora/RHEL `node-22`, 28 KB wrapper)
lack the `NODE_SEA_FUSE` sentinel required for Single Executable Application (SEA) injection.
Running `npm run build:linux` with the distro node fails with:
```
Error: Could not find the sentinel NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 in the binary
```

**Solution:** Download the official Node.js binary from https://nodejs.org and use it
via the `VIDEODL_SEA_NODE` environment variable:
```bash
# The official binary is stored at dist/node-official (~123 MB)
VIDEODL_SEA_NODE=dist/node-official node build.mjs --linux --package
```

**Critical:** Always verify the built binary version matches expectations after upload:
```bash
curl -fSL -o /tmp/test https://github.com/Hemues/videodl-script/releases/download/v<VER>/videodl-ffmpeg-linux
chmod +x /tmp/test && /tmp/test --version
```
The version stamp is baked in at build time from `package.json`. If you bump the version
AFTER building, the binary will report the old version — rebuild after the bump.

**Last update:** 2026-04-17

---

## #12 — Chapter Embedding via ffmetadata

**Status:** ✅ Verified (v2.0.87)

**Problem:** YouTube videos with chapter markers (timestamps in the description) lost
those chapters when downloaded — the output file had no chapter metadata, so media
players couldn't show a chapter list or allow jumping between sections.

**Solution:** Chapters are extracted from two sources:

1. **Native YouTube extractor** (`youtube.js`): Parses timestamps from the video
   description using regex (`/^\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s+(.+?)\s*$/`).
   YouTube requires ≥3 timestamps with the first at `0:00`. Also tries parsing
   `engagementPanels` from `ytInitialData` for structured chapter data.
2. **yt-dlp fallback extractor** (`ytdlp.js`): Passes through the `chapters` array
   from yt-dlp's `--dump-json` output (format: `[{start_time, end_time, title}, ...]`).

Chapters are written to an **ffmetadata file** (`[CHAPTER]` sections with
`TIMEBASE=1/1000`, `START`, `END`, `title`) and passed to ffmpeg as an additional
`-i` input with `-map_chapters N`. This works for both DASH merges
(`_ffmpegMerge()`) and HLS downloads (`downloadHLS()`).

**Key detail:** The chapters metadata file must be a separate ffmpeg input — it
cannot be passed inline. The `-map_chapters` index refers to the input number
of the ffmetadata file (after video, audio, and subtitle inputs).

**Cleanup:** The temporary `.f_chapters.txt` file is deleted after merge in the
`finally` block (DASH) or `cleanupVariantTemp()` callback (HLS).

**Last update:** 2026-04-25

---

## #13 — ffmpeg -map 0 Required When Remuxing Multi-Stream Files

**Status:** ✅ Verified (v2.0.86 container)

**Problem:** After downloading a video with multiple subtitle tracks (e.g., EN + HU),
the subtitle disposition post-processing step (`ffmpeg -i file -c copy -disposition:s 0`)
silently dropped all but the first subtitle track. Only English survived; Hungarian
was lost.

**Root Cause:** ffmpeg's **default stream selection** keeps only ONE stream per type
(1 video, 1 audio, 1 subtitle) unless explicitly told otherwise. Running
`ffmpeg -i input -c copy -disposition:s 0 -y output` selects the "best" subtitle
track and discards the rest.

**Fix:** Add `-map 0` to copy ALL streams from input 0:
```bash
ffmpeg -i input.mkv -map 0 -c copy -disposition:s 0 -y output.mkv
```

**Proof:**
```
# With -map 0 (FIXED):   index=2 lang=en, index=3 lang=hu, both default=0
# Without -map 0 (BUG):  index=2 lang=en only, hu MISSING
```

**Lesson:** Any ffmpeg remux/post-process that touches a file with multiple streams
of the same type MUST use `-map 0` (or explicit `-map 0:v -map 0:a -map 0:s`) to
preserve them all. This applies to disposition changes, metadata edits, and any
`-c copy` pass-through operation.

---

## #14 — YouTube 403 — Client Table & gvs PO Tokens (Phase 2 deferred)

**Status:** ✅ Phase 1 verified in production · ⏳ Phase 2 deferred

**Symptom:** YouTube downloads intermittently failed with `HTTP 403 Forbidden` on
`*.googlevideo.com/videoplayback` media URLs, even though extraction succeeded.

**Root cause (verified against yt-dlp master, mid-2026):**
- The `IOS` client now marks its media URLs as **requiring a `gvs` PO token**
  (`GvsPoTokenPolicy(required=True)`); without one the CDN 403s. It was near the
  front of our client rotation.
- `ANDROID_VR` was pinned to `1.71.26`, but client versions **`> 1.65` return
  SABR-only** responses (`serverAbrStreamingUrl`, no plain `url`) which we can't
  download — so it produced no usable formats and was skipped.
- Dead clients `TV_EMBEDDED` and `MEDIA_CONNECT` (removed upstream) were still tried.

**Phase 1 fix (shipped, v2.0.121):** Realigned `INNERTUBE_CLIENTS` with yt-dlp —
`ANDROID_VR` pinned to **`1.65.10`** as the **primary** client (no PO token, no
player-JS, direct DASH/HTTPS up to 2160p), then the other no-token clients
(`TV`, `WEB_EMBEDDED`), then authenticated `WEB_CREATOR`; the gvs-token-required
clients (`IOS`, `WEB`, `MWEB`) demoted to last resort. Dead clients removed;
versions refreshed to 2026-01. Verified: previously-failing videos extract
first-try with the full quality ladder and pass the CDN probe.

**Phase 2 (gvs PO-token minting) — investigated, then DEFERRED.** For
age-restricted / token-gated videos the no-token clients don't suffice; the fix
is a `gvs` PO token bound to `visitorData`. A working in-process minter
(`contrib/po-token-provider.mjs`, BotGuard via **bgutils-js + jsdom**) was proven
**under real Node.js** — it mints an ~848-char token that clears the IOS 403 and
yields 2160p. **But it cannot ship in the CLI binary:** jsdom does not survive the
esbuild → Node **SEA** bundle (its sync-XHR worker uses `require.resolve`; even
after patching that line, minting still fails in the bundle), and a minimal DOM
shim is rejected by BotGuard (`PMD:Undefined` — it fingerprints real-DOM props).

**Path forward (when needed):** run the minter as an **external sidecar
PO-token provider** under real Node (the architecture yt-dlp itself uses via
`bgutil-ytdlp-pot-provider`) and have `videodl-cli` request a token over HTTP —
not bundled into the SEA. Reference implementation kept at
`contrib/po-token-provider.mjs` (needs `bgutils-js` + `jsdom`).

**Key Lesson:** Keep the YouTube client table in sync with yt-dlp's
`INNERTUBE_CLIENTS` (versions + gvs-PO-token policy) — that alone fixes most
403s. Do **not** try to bundle jsdom into a Node SEA; PO-token minting belongs in
a separate real-Node process.

---

## #15 — HentaiHaven — Cloudflare managed challenge (curl only) & obfuscated HLS segments

✅ Verified 2026-07-16 (full 720p episode downloaded to a valid MP4).

**Site flow (`hentaihaven.xxx`, WordPress "player-logic" plugin by zarat.dev):**
1. Watch page → `<iframe src=".../wp-content/plugins/player-logic/player.php?data=…">`.
2. `player.php` → `<meta name="x-secure-token" content="sha512-<blob>">`.
   Decode exactly as `player.js` does: strip `sha512-`, then **3×** `( ROT13 → base64-decode )`,
   then `JSON.parse`. Yields `{ en, iv, uri, image, host, subtitle_config, … }`.
3. POST `<uri>api.php` with `action=zarat_get_data_player_ajax&a=<en>&b=<iv>` →
   `{ status:true, data:{ sources:[{ src:"<master.m3u8>", type, label }] } }`.
4. `sources[].src` is an HLS master → parse variants for per-quality formats.

**Cloudflare fingerprints the TLS client, not the IP.** The same host that
served the watch page fine to system `curl` (200) answered **Node** `fetch`/got
with a `403 "Just a moment…"` managed challenge, and **cycletls**' utls could not
even complete the handshake (`status 495`, "tls: protocol version not supported").
Three TLS stacks, three outcomes. Lesson: on a CF *managed challenge* zone,
JA3-only impersonation (cycletls) may fail at the TLS layer entirely — verify per
site; don't assume cycletls is the universal bypass (contrast lesson #2). The
extractor therefore fetches through a **`curl` subprocess** (curl is in the
container image, on Windows 10+, macOS, and Linux). Puppeteer was not an option:
the runtime container ships no Chrome/Chromium.

**Obfuscated HLS segment extensions break ffmpeg 7.1+.** Variant playlists name
their TS/fMP4 fragments `.html`/`.txt` (`index.txt`, `b_000.html`, `haN.html`,
init `i.mp4`). ffmpeg 7.1+ added `extension_picky` (default on) which rejects
segments whose detected container doesn't match the URL extension
(`… extension … mismatches allowed extensions in url …ha1.html` → mux aborts).
Fix in the shared HLS path (`downloader.js`): always pass `-allowed_extensions ALL`
(universally supported) and, only when the ffmpeg build advertises it,
`-extension_picky 0` (probed once via `-h full`, cached — older builds are
unaffected and would otherwise abort on the unknown option).

**Segment CDN is per-title and can be down.** The master/variant host
(`master-lengs.org`) and the segment host differ, and the segment host varies by
title (`hentaiihaven.com`, `anpustream.com`, `eng-cariz.top`, …). Some are
Cloudflare-fronted and can return **523 (origin unreachable)** for a title while
others serve `200` — a site/CDN condition, not an extractor bug. When only the
segments 523 but extraction succeeds, it's the CDN, not the code.

**Key Lesson:** Match the fetch client to what the target's CF zone actually
accepts (here: `curl`), and keep ffmpeg's HLS demuxer permissive about segment
file extensions.

---

**Last update:** 2026-07-16
