# YouTube Support & Limitations

## Status: ✅ Downloads work (up to 2160p / 4K)

The YouTube extractor performs full native extraction — it is **not** limited to
metadata or 360p. It:

- Fetches the watch page → player JS → `visitorData` / `signatureTimestamp`
- Rotates **InnerTube API clients** (see `src/extractors/youtube.js`
  `INNERTUBE_CLIENTS`), preferring clients whose media URLs need **no PO token**
- Solves the **`n` throttling** and **`signatureCipher`** challenges via the EJS
  solver (`vendor/yt.solver.core.js`, meriyah + astring)
- Probes each candidate CDN URL (small Range request) before committing, and
  downloads DASH video+audio (+subtitles) then muxes with ffmpeg

Primary client is **`ANDROID_VR` (pinned `1.65.10`)**: it returns direct
DASH/HTTPS URLs, needs **no PO token and no player-JS**, and yields the full
quality ladder up to **2160p**. `TV` and `WEB_EMBEDDED` are no-token fallbacks.

## Real limitations (2026)

### 1. Age-restricted / token-gated videos ⚠️
Some videos are only served by clients whose `*.googlevideo.com` media URLs
**require a `gvs` PO token** (`IOS`, `WEB`, `MWEB`, …). Without a token the CDN
returns **HTTP 403**. `videodl-cli` demotes those clients to last resort and
relies on `ANDROID_VR`/`TV`, which cover the vast majority of videos.

**gvs PO-token minting is currently DEFERRED.** A working minter (BotGuard via
`bgutils-js` + `jsdom`) is proven under real Node.js and kept at
`contrib/po-token-provider.mjs`, but jsdom **cannot be bundled into the Node SEA
binary** and a minimal DOM shim fails BotGuard. The planned path is an external
**sidecar PO-token provider** (yt-dlp's own architecture). Full write-up:
`LESSONS-LEARNED.md #14`.

Practical effect: **age-restricted and a few token-gated videos may still 403**;
everything else downloads normally.

### 2. SABR-only responses
Newer client versions (e.g. `ANDROID_VR > 1.65`, `web`/`web_safari`) increasingly
return **SABR-only** streams (`serverAbrStreamingUrl`, no plain `url`), which are
not downloadable here. This is why `ANDROID_VR` is **pinned `≤ 1.65`**. If you
bump a client version and downloads stop, suspect SABR.

### 3. IP binding & URL expiry (handled)
Media URLs embed the requesting IP (`ip=…`) and an `expire=…` timestamp. Requests
must egress from the same IP that extracted the page; URLs are single-use and
short-lived. `videodl-cli` handles this by downloading immediately after extract.

### 4. Subtitle rate-limiting
YouTube's `&tlang=` auto-translate endpoint is aggressively rate-limited (HTTP
429); the extractor retries with backoff.

## Keeping YouTube working

YouTube changes its clients/policies constantly. When downloads start failing
(403s, "no streaming data", SABR), **re-sync the client table with yt-dlp** —
see [`UPDATE-FROM-YTDLP.md`](UPDATE-FROM-YTDLP.md) (run `./update-from-ytdlp.sh
check`) and `LESSONS-LEARNED.md #14`. Extraction (not download) breakage may
instead point at the `n`/sig solver needing an update as YouTube's player JS
evolves.

## yt-dlp fallback

For sites `videodl-cli` has no native extractor for, the container delegates to a
pre-installed **yt-dlp** fallback. For YouTube specifically the native extractor
takes priority (it's faster and supports Premium bitrate upgrades).
