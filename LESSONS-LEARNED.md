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
