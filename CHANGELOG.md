# Changelog

All notable changes to videodl-cli will be documented in this file.

## [2.0.10] - 2026-07-17

### Fixed
- **Title truncation on apostrophes**: Titles containing apostrophes (e.g. "I'm so Tired...")
  were truncated at the `'` character. Root cause: `og:title` regex used `[^"']+` which stops
  at either quote type. Fixed the regex in all extractors to `[^"]+` (match only the enclosing
  double quote). Also added centralized apostrophe stripping in `extractVideoInfo()`.
- **xHamster title extraction**: Switched primary title source to `window.initials.videoModel.title`
  (from JSON) instead of `<title>` tag / `og:title` meta (which fail or truncate on this site).
- **HLS download progress reporting**: Changed ffmpeg loglevel from `warning` to
  `info` so the `Duration:` line is captured for time-based progress. Removed the
  `duration > 0` guard that suppressed all progress events when duration was unknown.
  Downloads now always emit progress (with `percent: 0` if duration is unavailable).
  Capped stderr buffer at 4 KB to prevent unbounded memory growth on long HLS streams.
- **Duration extraction**: Added `duration` to the return value of xHamster, XVideos,
  XNXX, PornHub, RedTube, YouPorn, Tube8, SpankBang, Eporner, and Brazzers extractors.
  Previously these returned `undefined`, causing HLS downloads to show 0% progress
  throughout the entire download (appearing stuck).
- **Dailymotion quality labels**: Use quality labels (e.g. "480p") instead of actual
  pixel heights (e.g. "352p") since Dailymotion labels differ from stream resolution.
- **CycleTLS Go sidecar binary**: The Go helper binary (`index` on Linux, `index.exe` on Windows)
  is now shipped alongside the SEA binary. Previously, CycleTLS-dependent extractors
  (SpankBang, 9GAG, Dailymotion HLS, Bitchute, Cloudflare bypass) failed with
  "Executable not found" when running as a compiled binary or in a container.
  - `build.mjs` copies the Go binary to `dist/` during build
  - `compile.sh` includes the Go binary as a release asset
  - New `src/cycletls-helper.js` centralizes CycleTLS initialization with sidecar resolution
- **Dailymotion quality limited to 360p**: HLS master playlist parsing failed silently
  (due to missing CycleTLS sidecar), leaving only progressive formats (max 360p).
  Higher qualities (480p, 720p, 1080p) are only available via HLS variants.
  Added `console.error` warnings when HLS parsing fails so the issue is visible.
- **Quality selection warnings**: When the download engine selects a lower quality than
  requested (e.g. user asks for 1080p but only 360p is available), a warning is now
  emitted in both CLI and JSON output modes.
- **Error logging consistency**: Changed `console.log` to `console.error` for parse
  errors in SpankBang (`stream_data`) and 9GAG (`_config`, JSON-LD) extractors.
  Errors now go to stderr as expected.

### Added
- 14 new site extractors (35 total): SpankBang, 9GAG, Dailymotion, Bitchute,
  EroProfile, EPorner, 4tube, Fux, Fapster, NoodleMagazine, HClips, HDSex,
  HotMovs, Voyeurhit
- `src/cycletls-helper.js` — shared CycleTLS initialization with automatic
  sidecar binary detection for SEA/container deployments
- `src/cf-solver.js` — Cloudflare-protected download with TLS impersonation,
  resume support, and progress callbacks

## [1.0.0] - 2026-02-10

### Site Extractors (21 sites)
- YouTube (metadata + limited download — see [YOUTUBE-LIMITATIONS.md](YOUTUBE-LIMITATIONS.md))
- xHamster, PornHub, XVideos, XNXX, YouPorn, RedTube, Tube8
- Facebook, Vimeo, Indavideo, Videa
- Motherless, InPorn, TnaFlix, TubeSafari, PornOne, PornZog
- UncensoredHentai, Brazzers (cookie-authenticated)
- KVS (generic engine, covers many sites)
- Direct URL fallback (`.mp4`, `.mkv`, `.webm`, `.m3u8`)

### Download Engine
- HTTP/HTTPS direct download with progress tracking
- HLS (M3U8) streaming download via ffmpeg
- DASH merging — separate video + audio + subtitle streams into one file
- Quality/format selection (`best`, `worst`, `720p`, `1080p`, or auto)
- Smart filename generation with source domain (e.g., `title-xvideos.com.mp4`)
- `--no-base-url` option to omit domain from filenames
- Custom HTTP headers, proxy support, SSL toggle
- Auto-downloads ffmpeg if not in PATH

### Cookie & Authentication
- Netscape cookie file support (same format as yt-dlp / curl)
- Automated cookie generation via Puppeteer browser automation
- Cookie expiry detection with auto-refresh (`--generate-cookies`)
- Force regeneration (`--force-cookies`)
- Interactive browser login (`browser-login` command)
- Brazzers-specific login automation (Aylo platform)

### CAPTCHA Solving
- Free reCAPTCHA v2 solver via wit.ai speech-to-text
- Paid 2captcha support as alternative
- Headless or visible browser modes

### Subtitle Support
- Auto-download and embed subtitles when available
- Language selection (`--sub-lang`)
- Auto-translation (`--sub-translate`)

### Cloudflare Bypass
- TLS fingerprint impersonation via cycletls (Chrome JA3 hash)
- Transparent — no user configuration needed

### Video Conversion
- Full ffmpeg wrapper (convert, probe, formats, codecs)
- Combined download + convert (`dl-convert` command)
- Codec, bitrate, resolution, FPS, quality controls

### CLI
- 14 commands: download, convert, dl-convert, list-formats, sites, extractors, probe, info, formats, codecs, extract, download-json, generate-cookies, browser-login
- URL-as-first-arg shorthand (auto-prepends `download`)
- Colored output with chalk, progress bars
- JSON output modes for machine integration
- yt-dlp-style help text

### Build System
- esbuild bundling to single CJS file (~5.5 MB)
- Node.js SEA (Single Executable Application) binary compilation
- Windows (x64) and Linux (x64) standalone executables
- Cross-compilation support (build Linux binary on Windows)

### Programmatic API
- ES module exports: `VideoDownloader`, `VideoConverter`, `extractVideoInfo`, `listSupportedSites`, `listExtractors`, `getExtractor`
- EventEmitter-based progress tracking
