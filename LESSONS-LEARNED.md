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
16. [DRM detection — refuse cleanly, never circumvent; don't flag plain AES-128](#16--drm-detection--refuse-cleanly-never-circumvent-dont-flag-plain-aes-128)
17. [IndaPlay/IndaEvents — find the *host*, and never trust a 200 or a page's first video](#17--indaplayindaevents--find-the-host-and-never-trust-a-200-or-a-pages-first-video)
18. [Security hardening 2026-09-13: the fixes and what they taught](#18--security-hardening-2026-09-13-the-fixes-and-what-they-taught)
19. [PornHub — two HLS CDNs per page load, and `get_media` needs the session cookies](#19--pornhub--two-hls-cdns-per-page-load-and-get_media-needs-the-session-cookies)
20. CRLF lost in the 2026-10-13/14 documentation audit commit, restored by the next commit (added 2026-10-31)
21. Subtitle default changed to "none" inside a commit about MAX_PATH; the docs still say English + Hungarian (added 2026-10-31)
22. Home-lab details in a public repository; removed from the tree, still in history (added 2026-10-31)
23. Accidental symlink `.compile.unix.sh` committed by a sync commit (added 2026-10-31)
24. Executable bits flipped on every file by Windows checkouts (added 2026-10-31)
25. Commit subjects "some minor fixes" hide what was fixed (added 2026-10-31)
26. Binaries shipped without the CycleTLS helper, "Executable not found" (added 2026-10-31)
27. Skool: data in embedded JSON, Mux referrer rule, cookies by URL (added 2026-10-31)
28. Playlist result crashed the default download path (added 2026-10-31)
29. YouTube auto-translate answers 429 to anonymous requests (added 2026-10-31)
30. Documentation drift: stale tags, file names, counts and CHANGELOG dates (added 2026-10-31)

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

**Key insight:** The `gh` CLI must be authenticated (`gh auth login`). On the build host,
root holds the token (`~/.config/gh/hosts.yml`). Run via `sudo bash -c '...'`.

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

## #16 — DRM detection — refuse cleanly, never circumvent; don't flag plain AES-128

✅ Verified 2026-08-03 (unit + real Widevine/PlayReady test vectors + clear streams).

videodl **detects** DRM and stops with a clear message; it does **not** and will
not circumvent it (no CDM, no keys, no decryption). `src/drm-detect.js`
(`detectDrm()` + `DrmProtectedError`) scans an HLS/DASH manifest for:
- **DASH**: `<ContentProtection>` system UUIDs (Widevine `edef8ba9-…`, PlayReady
  `9a04f079-…`, FairPlay `94ce86fb-…`), `<cenc:pssh>`, and the generic
  `urn:mpeg:dash:mp4protection:2011` CENC marker.
- **HLS**: `#EXT-X-KEY` / `#EXT-X-SESSION-KEY` with a DRM `KEYFORMAT`
  (`com.apple.streamingkeydelivery` = FairPlay, the Widevine/PlayReady UUIDs) or
  `METHOD=SAMPLE-AES` with a non-`identity` keyformat.

**The trap: do not flag ordinary HLS AES-128.** `METHOD=AES-128` with
`KEYFORMAT="identity"` (or none) and an HTTP(S) key URI is *standard, downloadable*
HLS encryption that videodl handles via ffmpeg — flagging it would break working
downloads. Only `SAMPLE-AES` / a DRM key system / CENC counts. (Unit-tested both
ways: plain AES-128 and identity keyformat must return `clear`.)

Wired into `downloader.download()` as a pre-flight (`_precheckManifestDrm`) that
fetches the manifest (and, for an HLS master, the first variant) before download.
It is **resilient**: a manifest fetch that fails (auth/geoblock/network) does NOT
block — the normal path still surfaces the real error, so a transient fetch
failure never masquerades as "DRM". CLI prints `🔒 DRM-protected: <systems>`;
`download-json` emits `{drm:true, drmSystems:[…]}` for the container web UI.

**Context:** commercial services (HBO Max/Max, Netflix, Disney+) use
Widevine/PlayReady/FairPlay — no cookie/login makes them downloadable; the
segments are ciphertext and circumventing the CDM is illegal (DMCA §1201 / EU
Copyright Directive Art. 6). This feature exists to *report* that honestly, not
to defeat it. (yt-dlp already errors "This video is DRM protected" on the
fallback path; this adds the same clarity to the native download path.)

---

## #17 — IndaPlay/IndaEvents — find the *host*, and never trust a 200 or a page's first video

✅ Verified 2026-09-06 (8 live URL shapes + an end-to-end download, byte-exact).

**Fingerprint the host before writing anything.** The ask was "download videos
from the IndaEvents app". indaevents.hu hosts no video at all — event pages at
`/e/<event>` embed `indaplay.hu`, and IndaPlay turned out to be a **PeerTube
instance** (`cms.indaplay.hu`) behind a Next.js portal. That single discovery
replaced all player reverse-engineering with a documented public API
(`/api/v1/videos/<uuid>`, `/api/v1/video-channels/<name>/videos`,
`/api/v1/search/videos`) giving per-resolution progressive fMP4 **and** HLS, plus
title/duration/uploader/thumbnail. Same recipe as JustSwallows→Vtbe (#9 pattern):
identify the CMS first, then write the smallest adapter.

Four traps, each of which would have shipped a silently-wrong extractor:

1. **A 200 is not a success.** `indaplay.hu/<channel>/<slug>` answers **HTTP 200**
   but renders the Next.js `notfound` route segment — a soft 404 with no payload.
   The real watch route is `/hu/video/<channel>/<slug>`. Route shapes were only
   discoverable from rendered `<a href>`s, not from the URL guesses that "worked".
2. **A page carries many videos; the wanted one is not first.** A watch page holds
   31 video objects and the home page 514. Taking the first `contentPlaylistUrl`
   returns *someone else's video* — the target was 4th in document order. The slug
   is matched exactly, and slug↔uuid resolution has three fallbacks (page payload
   → channel listing → instance search) because…
3. **…`/embed/<channel>/<id>` returns HTTP 500 for videos that are perfectly
   fine.** The AI Summit 2025 aftermovie 500s on embed while its PeerTube record
   and streams are intact, so an embed failure must never be fatal. Portal slugs
   are the video name accent-folded and hyphenated (`"AI Summit 2025 Aftermovie"`
   → `ai-summit-2025-aftermovie`), verified against live pairs, which makes the
   listing/search fallbacks reliable.
4. **The API emits `http://cms.indaplay.hu:443/…`** — an http scheme glued to the
   https port (reverse-proxy misconfiguration). Every URL out of the API and the
   page payload goes through `_normalizeCmsUrl()` or the downloader would attempt
   http-on-443.

**Method note:** an early "no video markers on this page" reading was wrong — the
portal served **gzip** regardless of `Accept-Encoding` and grep was scanning
compressed bytes (`curl --compressed` fixed it; the tell was the 405 KB download
vs the 4.7 MB original size). Decompress before concluding a page is empty.

No DRM anywhere: zero `EXT-X-KEY`, and the instance sets `downloadEnabled: true`.

---

## #18 — Security hardening 2026-09-13: the fixes and what they taught

✅ Shipped as CLI 2.0.137 / container 2.0.138 (see `REVIEW-2026-09-13.md` for the findings).
CLI 2.0.136 was published but **superseded the same day** — see item 8.

1. **ffmpeg's `-protocol_whitelist` is per *input* and applies to every nested open.**
   `file` had been added so a locally written variant playlist could be an input; that
   also let a *remote* playlist reference `file:///…` segments. The way out was not a
   conditional whitelist but removing the local file entirely: the playlist is passed
   as a `data:` URI (`hlsPlaylistToDataUri`), every reference absolutised first. Bonus:
   no `.vdl_variant_*.m3u8` temp files in the user's download folder. Per-input scoping
   also means the chapters-file input (a separate `-i`) still works without `file`.
2. **A template nobody expands is a bug hiding as a feature.** The container sent
   `-o '<prefix>.%(title)s.%(ext)s'`; the CLI used `-o` verbatim. Every custom-named
   download was literally named `prefix.%(title)s.%(ext)s` for months, and `../` in
   the prefix escaped the directory. Now `resolveOutputFilename` expands the template
   and refuses anything that resolves outside `-d`. Test the *public entry point* with
   the *exact* arguments another component sends (`instrument the tool, not a copy`).
3. **Node's permission model works inside a SEA — via `NODE_OPTIONS`.** A SEA ignores
   Node flags on its argv, but `NODE_OPTIONS=--permission` is honoured (verified:
   `extractors` prints, `probe` gets `ERR_ACCESS_DENIED`). That made the solver
   sandbox a child of the *same binary* (`__solve`), no extra runtime. Two traps:
   (a) from **source**, module loading itself is subject to the fs permission — the
   child needs `--allow-fs-read=<project>`; (b) the grant is matched against the
   **drive-letter form of the entry path, case-sensitively** — probed on a mapped
   network drive: `Z:\…` passes, `z:\…` fails, and every UNC / `realpath` form
   (`\\server\share\…`, `\\?\UNC\…`) is denied even though the *denial message* prints
   the UNC path. Derive the grant from `argv[1]` with `path.resolve` (never realpath),
   and in Python use `os.path.abspath`, not `Path.resolve()` (which silently rewrites a
   mapped drive to UNC). The SEA needs no grant at all.
4. **`subprocess.run(text=True)` on Windows decodes with cp1252** — the CLI's UTF-8
   arrows/emoji raised inside the reader thread and left `stdout=None`, which then
   surfaced as an unrelated `TypeError` in the harness. Always `encoding='utf-8',
   errors='replace'` for tool output.
5. **Substring `canHandle()` regexes route the wrong extractor.** Match the hostname
   (`hostMatches()` in `base.js`). ~20 extractors still use the old pattern — migrate
   as they are touched.
6. **Reproducibility is a security control, not a nicety.** With the lockfile ignored,
   Node = "whatever the host has", ffmpeg = BtbN `latest`, and `pip install yt-dlp`
   unpinned, a "rebuild for yt-dlp" changed four other things silently. Pins + hashes
   (`build-pins.json`, `ejs.lock.json`, `requirements.txt --hash`) make the automated
   update pipeline's one-pin-per-run promise real.
7. **The gate must run the artefact that ships.** `tests/smoke.py --image <candidate>`
   runs the binary *inside the image*, `--deployed` runs it inside the live container.
   A green run from source proves the code; only a green run of the image proves the
   release.
8. **The gate earned its keep on its first day — and exposed its own blind spot.** The
   2.0.136 candidate image passed every case… with a 0.3 MB "media header ok" probe
   file. The BtbN **master** ffmpeg snapshot pinned that morning (`N-126523`, 2026-09-12)
   reads all byte-range fMP4 segments ("HLS reusing connection … offset …") but writes
   only the first 4 s and **exits 0** — silent truncation. The same command with the
   image's RPM Fusion ffmpeg 8.1.2 wrote the full 20 MB. Three lessons: (a) pin the
   **release branch** (`n8.1.x`) of a fast-moving upstream, not `master`; (b) a
   "valid header, non-trivial size" check is not a completeness check — the probe now
   pins `minProbeBytes` per case; (c) the host-binary run passed only because the CLI
   silently used the *host's* system ffmpeg: `ffmpeg-helper.js` probed PATH with
   `which`, which fedora-minimal does not ship, so inside the container the system
   ffmpeg was invisible and the embedded one was used. Same binary, different
   environment, different result — test in the environment that ships (7.).

## #19 — PornHub — two HLS CDNs per page load, and `get_media` needs the session cookies

✅ Fixed in CLI 2.0.139 (2026-10-03).

**Symptom.** `[PornHub] Failed to parse HLS playlist: … 410 (Gone): GET https://hv-h.phncdn.com/hls/…/master.m3u8?h=…&e=…&f=1`
for every quality, then `Found 0 formats`. The failure was intermittent: about two page
loads in three failed, the third worked.

**What was going on — two independent problems that only hurt together.**
1. The watch page's `flashvars.mediaDefinitions` HLS URLs come from **one of two CDNs,
   picked per page load**: `ev-h.phncdn.com/…?validfrom=…&validto=…&hash=…` (works with any
   client) or `hv-h.phncdn.com/…?h=…&e=…&f=1` (Cloudflare, answers `410 Gone` with a
   1-byte body to Node/`got`, with or without browser headers, `Referer`, `Origin` or
   the `__cf_bm` cookie). All qualities of one page load share the CDN. **Retrying the
   same URL never recovers**; only a new page load can draw the other CDN.
2. The `format: "mp4"` definition points at `/video/get_media?s=…`, which returns the
   progressive mp4 list (`ev.phncdn.com/videos/…?validfrom=…&rate=…&ip=…&hash=…`).
   **Without the cookies the watch page sets (`ss`, `__s`, `__l`, …) it answers 200
   with `[]`**, so the fallback produced nothing and logged nothing. yt-dlp never hit
   this because its session cookie jar is implicit.

**Fix.** One `tough-cookie` `CookieJar` per extraction, shared by the page, HLS and
`get_media` requests. The mp4 path now always yields 240p–1080p (verified: 1080p 535 MB,
H.264 + AAC, full duration). HLS stays first in the list, so it still wins at equal height
whenever its CDN answers.

**Notes for next time.**
- The mp4 URLs carry a per-quality throttle: **240p/480p/720p `rate=500k`, 1080p
  `rate=50000k`** (same on every probe). The cap is **per connection**: 0.65 MB/s on one
  connection, 4.9 MB/s with 8 parallel ranges. So `best` (the container's default) is
  fast, but an explicit 720p on a page that drew `hv-h` takes about as long as the video
  plays (16-min video, 432 MB, ~14 min). The downloader's chunked mode is sequential,
  so it does not help here. If this matters, add opt-in parallel ranges to
  `_downloadStream` rather than turning them on for every site (YouTube).
- The mp4 URLs also carry the client IP (`ip=`) and need `Referer` (404 without it). The
  extractor's format headers already send it.
- Rewriting `hv-h` → `ev-h` in the URL returned 200 for the master playlist in one probe.
  That is not documented behaviour, so it is not used.
- Debug recipe: fetch the page, print `mediaDefinitions`, then request each URL with
  `throwHttpErrors: false`. A page-level `[]` from an endpoint that "works" means
  missing session state, not a site change.

---

## Entries #20 to #30 (added 2026-10-31)

Numbering continues in ascending order, as in the rest of this file, so that existing references such as "LESSONS #19" stay valid. The newest entries are the last ones in the file. The index of all entries is the table of contents above.

## #20 — CRLF lost in the 2026-10-13/14 documentation audit, restored by the next commit

**Status:** ✅ Verified in git history on 2026-10-31.

- **Version / commit:** 2.0.139; audit commit `28946a3` (author date 2026-10-14 00:13 +0200), restore commit `7ff739d` (2026-10-14 00:13:57 +0200).
- **Symptom:** the audit commit shows 1,295 inserted and 1,291 deleted lines, although its purpose was a few lines of text:

  ```
  CHANGELOG.md | 1242 ++++++++++++++++++++++++++---------------------------
  README.md    | 1344 +++++++++++++++++++++++++++++-----------------------------
  ```

- **Root cause:** the README and CHANGELOG were CRLF before the audit commit. The audit edit was written with LF line endings (the text of `7ff739d` says so). Nothing counted the carriage returns before the commit, so the whole file changed.
- **Fix:** `7ff739d` restored CRLF in both files (1,295 lines in each direction, content unchanged). On 2026-10-31 the HEAD copy of README.md has 673 CR bytes, one per line.
- **Rule:** before a commit of an edited Markdown file, compare `git show HEAD:<file> | tr -cd '\r' | wc -c` with `tr -cd '\r' < <file> | wc -c`. Count carriage returns with `tr`, not with `grep -c $'\r'`, because in Git Bash that counts every line that contains the letter r.
- **Detection gap:** nothing automatic. The audit text reported the Linux worktree as clean, but nobody compared line endings.

## #21 — Subtitle default changed to "none" inside a commit about MAX_PATH

**Status:** ⏳ Open. Owner decision needed (see "Known gaps" in README.md).

- **Version / commit:** the English + Hungarian default was set by `66d335c` (2026-04-23, CHANGELOG 2.0.58 and 2.0.63). It was removed by `dbcea2e` (2026-04-25), subject "fix: use .mkv instead of .webm for VP9/AV1+Opus, truncate filenames to prevent Windows MAX_PATH overflow". The commit has an empty body and no CHANGELOG line.
- **Symptom:** the code constant in `src/cli.js` reads `const DEFAULT_SUB_LANGS = [];`, with a comment that an empty list disables subtitles. The `--sub-lang` option text says `Default: none`. The subtitle section of the help text printed by `node src/cli.js download --help` says `en,hu — English + Hungarian (DEFAULT)`. The README section "Download with Subtitles" says English and Hungarian are downloaded by default. Two sources say yes and two say no.
- **Root cause:** `dbcea2e` changed the constant from `['en', 'hu']` to `[]` and rewrote the comment. The same commit changed the line endings of `src/cli.js` and `src/extractors/base.js` as whole files (about 4,350 changed lines for `src/cli.js`). Ignoring carriage returns, the default change is small, and it was hidden in the whole-file diff. No test pins the default, and the docs were not updated.
- **Fix:** none yet. The owner must decide whether the default is none or English and Hungarian. Then the constant, the help text (`src/help.js` and the option strings), the README and HOWTO section 5.3 must say the same thing.
- **Rule:** a default is a product decision. It gets its own commit whose subject or body states the old and the new value, a CHANGELOG line, and a test that pins it. Review a file whose line endings changed with `git diff --ignore-cr-at-eol`.
- **Detection gap:** no unit test pins `DEFAULT_SUB_LANGS`. Nothing compares the help text with the constant.

## #22 — Home-lab details in a public repository (removed from the tree, still in history)

**Status:** ✅ Fixed in the tree by `f9d8706` (2026-09-13). ⏳ Open in history (owner option).

- **Version / commit:** 2.0.137 to 2.0.139; `f9d8706` "Remove home-lab topology from this public repository".
- **Symptom:** before 2026-09-13 the docs and the scripts named the build host address, network share paths, a deploy user and uid, LAN service ports, and the path of the host updater. The repository is public (AGENTS.md, CHANGELOG 2.0.139).
- **Root cause:** documents written for the owner's home lab were committed to a public repository, because the build and deploy notes lived next to the code.
- **Fix:** `f9d8706` removed the text from docs, comments and scripts. `update-from-upstream.sh` and its systemd unit read every host value from `/etc/videodl-upstream.env` (template `contrib/systemd/videodl-upstream.env.example`). `.gitignore` excludes that file and `local/` and `LOCAL-*.md` notes. `git grep` over the tracked files found no topology markers.
- **Rule:** never write host names, addresses, share paths, user names, uids or updater paths into this repository. They belong in the private environment file or in the private container repository. Run a `git grep` for them before every push. The notes about the second local clone (README "Known gaps") name no paths for the same reason.
- **Two clones (documented 2026-10-31):** two local clones of this repository exist on the owner's build network share. One is the working clone; the other is a mirror. After every push the mirror is fast-forwarded to the pushed HEAD, and the mirror is never edited. No paths are written here or in the README, because the repository is public.
- **Detection gap:** nothing automatic. The old text is still in the history of commits before `f9d8706`. A history rewrite is an owner option and was not done.

## #23 — Accidental symlink `.compile.unix.sh` committed by a sync commit

**Status:** ⏳ Open. The symlink is still tracked at HEAD (`7ff739d`).

- **Version / commit:** the path `.compile.unix.sh` appears in `326bb7b` (2026-04-23, "remove accidental .compile.unix.sh symlink"), `3f3966a` (2026-04-27), `4b94b18` (2026-04-28) and `41e066b` (2026-07-21, "Sync working changes"). The last change left the symlink in HEAD.
- **Symptom:** on the Linux build host, `git ls-files -s .compile.unix.sh` prints mode `120000`, and `ls -la` shows `.compile.unix.sh -> /tmp/compile.unix.sh`. The file does not exist on any other checkout, so the link is dangling there. On Windows the same path shows as deleted (` D` in `git status`), because a symlink cannot be followed there.
- **Root cause:** a developer's throwaway wrapper symlink in the working directory was staged by a broad add in a sync commit (`41e066b` has 89 changed files, 87 of them mode-only changes).
- **Fix:** none yet. Remove the path in its own commit, for example `git rm --cached .compile.unix.sh` and a commit subject that says why. Do this only with the owner's agreement, because the file is part of the tree the owner uses.
- **Rule:** a sync commit names its paths. `git add -A` is not used for sync commits. Before a commit, check `git ls-files -s | grep '^120000'` and read every symlink.
- **Detection gap:** nothing fails. On Linux the link works until `/tmp/compile.unix.sh` is looked for.

## #24 — Executable bits flipped on every file by Windows checkouts

**Status:** ⏳ Partly open. History cannot be changed; the working rule is below.

- **Version / commit:** mode-only changes from 100644 to 100755 on 77 to 89 files each in `dd8447e` (2026-03-20), `3d8bb90` (2026-03-20), `7b3a169` (2026-03-20), `9a209ba` (2026-03-20), `4c66a0b` (2026-03-20), `ed5ac11` (2026-03-20), `bb718e8` (2026-04-23), `3f3966a` (2026-04-27) and `41e066b` (2026-07-21).
- **Symptom:** `git show --stat dd8447e` reports 77 changed files and 0 changed lines. `git diff --ignore-cr-at-eol --shortstat` on the same commit reports 77 files and 0 insertions and 0 deletions. On a Windows checkout `git diff --stat HEAD` reported 110 files changed and 0 lines. At HEAD every tracked file, including `README.md`, `AGENTS.md` and `src/cli.js`, has mode `100755`.
- **Root cause:** the files were checked out or copied through a Windows share that presents every file as executable. With `core.fileMode` true, git recorded the mode of the copy.
- **Fix:** none for the history. On a Windows checkout run `git config core.fileMode false`. The Linux read used in the 2026-10-31 pass is `git -c core.fileMode=false status --short`. Owner decision: whether non-script files should be 100644 again (a commit that changes only modes is then needed).
- **Rule:** read status with `core.fileMode` false. A mode-only diff is not a change. Do not commit a commit whose only change is a mode.
- **Detection gap:** nothing automatic. `git show --stat` shows the count of files, not that they are mode-only; use `--summary` to see `mode change`.

## #25 — Commit subjects "some minor fixes" hide what was fixed

**Status:** ✅ Recorded. Rule in force from 2026-03-21.

- **Version / commit:** 18 commits on 2026-03-20, among them `9a209ba`, `02c4ac2`, `25c4309`, `dbea660`, `bcbdece`, `63c6453`, `3f36ca8`, `03e0ac7` and `759a501`, have the subject "some minor fixes" or "some minor yt fixes" and one or two changed lines each.
- **Symptom:** `git log` cannot say which site or which symptom each commit fixed. The later postmortems (for example #14 and #19) had to be rebuilt from the diff.
- **Root cause:** extractors were debugged against live sites one commit at a time, and the commit subject was a placeholder.
- **Fix:** none for the history. The CHANGELOG 2.0.10 entry describes the same fixes in prose.
- **Rule:** a commit subject names the site or the component and the symptom in one line, for example `fix(skool): build title from section breadcrumb`. The commit body holds the verification (what was run, on which URL, with which result).
- **Detection gap:** none. The subject rule is a convention, not a hook.

## #26 — Binaries shipped without the CycleTLS helper ("Executable not found")

**Status:** ✅ Fixed by `c61c405` (2026-03-20).

- **Version / commit:** the 2.0.1 line; fix `c61c405` "fix: ship CycleTLS Go helper binary alongside SEA binary".
- **Symptom:** a compiled binary or the container failed with `Executable not found` for SpankBang, 9GAG, Dailymotion (HLS) and Bitchute, and for the Cloudflare bypass. The text is quoted in the CHANGELOG 2.0.10 entry.
- **Root cause:** `build.mjs` did not copy the Go helper into `dist/`, and `compile.sh` did not include it as a release asset. The source run worked, because the helper was found next to the source.
- **Fix:** `build.mjs` copies the helper to `dist/`; `compile.sh` includes it as a release asset; `src/cycletls-helper.js` resolves the sidecar for SEA and container runs. The README "Releases" table lists the helper files for every platform.
- **Rule:** a binary that needs a helper ships with the helper, and the release checklist lists the helper files. Test the binary (`python3 tests/smoke.py --binary <path>`), not only the source.
- **Detection gap:** a source-only check cannot see a missing sidecar. The smoke gate's `--binary` mode is the check that sees it.

## #27 — Skool: data in embedded JSON, a referrer rule on Mux, cookies by domain

**Status:** ✅ Fixed in 2.0.101 to 2.0.112 (commits `a6ae043` to `63730b5`, 2026-05-09 and 2026-05-10).

- **Version / commit:** 2.0.101 (first classroom extractor) to 2.0.112 (community posts; the number 2.0.111 had been used for the code of 2.0.110, so the release went out as 2.0.112).
- **Symptom:** lessons returned no video, then `HTTP 403` from the Mux playback URL, then the placeholder title `EOS Club` (a page fetched without the session), then wrong titles for lessons inside sections.
- **Root cause:** the lesson data sits in the `__NEXT_DATA__` JSON of the server-rendered page, not in the visible HTML. Mux playback is restricted by referrer (`playback_restriction_id`), so the request needs `Referer` and `Origin` of the Skool site. The browser extension read cookies with `{domain: hostname}`, so cookies of the parent domain (`.skool.com`) were not sent.
- **Fix:** parse `pageProps` from `__NEXT_DATA__`; attach `Referer`, `Origin` and a browser User-Agent to the Mux format; build the title from the breadcrumb of the course tree (sections joined with ` - `, slashes replaced); read cookies with `chrome.cookies.getAll({url})`.
- **Rule:** read the embedded JSON of a server-rendered page before parsing its HTML. Check the CDN's referrer rule with curl, once without and once with the header, before writing the extractor.
- **Detection gap:** each release was verified on one live page. The smoke set needs one classroom lesson and one community post. (Not verified whether `tests/smoke-urls.json` holds them.)

## #28 — A playlist result crashed the default download path

**Status:** ✅ Fixed in 2.0.68 (2026-04-23).

- **Symptom:** `Cannot read properties of undefined (reading 'some')` when a YouTube playlist or channel URL was given to `download`.
- **Root cause:** the code read `videoInfo.formats` for every result. A playlist result has `_type: 'playlist'` and a list of entries, and no `formats` array.
- **Fix:** detect `_type === 'playlist'` and download each entry by re-running the CLI for it; the playlist title becomes the sub-folder name; the Premium check reads `(videoInfo.formats || [])`.
- **Rule:** check the result type before reading its fields. Any extractor result can be a playlist.
- **Detection gap:** not recorded when the playlist case was added to the smoke set (not verified).

## #29 — YouTube auto-translate answers 429 to anonymous requests

**Status:** ✅ Mitigated in 2.0.62 and 2.0.63 (2026-04-23). Still a site limit.

- **Version / commit:** `a8d5118` (2026-04-23, 2.0.62: pacing and backoff) and `d43a770` (2026-04-23, 2.0.63: cookies and headers forwarded).
- **Symptom:** `HTTP 429 Too Many Requests` on the `&tlang=` auto-translate URL; the translated subtitle track was silently missing.
- **Root cause:** YouTube limits the translate endpoint for anonymous clients.
- **Fix:** subtitle downloads are paced (400 ms between files), retried with exponential backoff (up to six attempts, `Retry-After` honoured). Cookies from `--cookies` and browser-like headers are forwarded; with cookies the translate URL succeeds. HOWTO section 5.12 lists the limit.
- **Rule:** a per-site throttle is handled by pacing and by the logged-in session. Never by parallel requests. Write the limit into the HOWTO.
- **Detection gap:** no test simulates a 429. The retry path is only exercised by live runs.

## #30 — Documentation drift: stale tags, file names, counts and CHANGELOG dates

**Status:** ✅ README and HOWTO corrected on 2026-10-31. ⏳ CHANGELOG headers left for the owner.

- **Symptom:** README said "45 site extractors" in the feature list and "47" in the introduction; the registry has 47 native extractors (49 entries with yt-dlp and direct). README said "last git tag v2.0.99"; the tags `v2.0.134`, `v2.0.136`, `v2.0.137` and `v2.0.139` exist. README and the troubleshooting section named `update-from-ytdlp.sh`; the file is `update-from-upstream.sh` (renamed in the 2.0.139 security work). CHANGELOG 2.0.139 said "No `v2.0.139` git tag exists"; the tag was created on 2026-10-03. The CHANGELOG 2.0.10 header is dated 2026-07-17, while its commits are from March 2026, and it sits in the file next to the 2.0.30 entry dated 2026-03-21.
- **Root cause:** the facts were copied from one place into several documents, and the changes of a day did not update the README on the same day. The 2026-10-13/14 audit read only the top of each file.
- **Fix:** README and HOWTO were rewritten on 2026-10-31 with the checked values, and every outdated statement is marked with its date. The CHANGELOG was not edited in that pass.
- **Rule:** a version change updates, in the same commit, the README version line, the tag note and every file name that changed. Read the tags with `git tag --sort=creatordate`. Date a CHANGELOG heading with the date of its commits.
- **Detection gap:** nothing automatic. A small check could `grep` the docs for `update-from-ytdlp` and `v2.0.99`.

---

**Last update:** 2026-10-31
