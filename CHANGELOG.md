# Changelog

All notable changes to videodl-cli will be documented in this file.

## [2.0.87] - 2026-04-25

### Added
- **Chapter embedding** — YouTube chapter markers (timestamps in the video
  description) are now automatically extracted and embedded into the output
  file as proper chapter metadata. Works with both the native YouTube
  extractor (parses timestamps from description + `engagementPanels` page
  data) and the yt-dlp fallback extractor (passes through yt-dlp's
  `chapters` JSON field). Chapters are written as an ffmetadata file and
  merged via ffmpeg's `-map_chapters` flag during both DASH and HLS merges.
  Videos without chapter timestamps are unaffected.

### Changed
- **Subtitle disposition defaults to non-display** — when the backend
  requests subtitles with `subtitle_language=none`, EN+HU subtitles are
  still downloaded and embedded but their ffmpeg disposition flag is set to
  `default=0` so they don't auto-play in media players. Users can still
  manually enable them.

### Fixed
- **All subtitle tracks preserved during disposition fix** — the ffmpeg
  post-processing step that sets `disposition:s 0` now uses `-map 0` to
  copy all streams, fixing a bug where only the first subtitle track
  survived (e.g., Hungarian was silently dropped, leaving only English).

## [2.0.68] - 2026-04-23

### Fixed
- **Playlist URLs no longer crash with `Cannot read properties of undefined (reading 'some')`.**
  When the user passes a YouTube playlist / channel URL (e.g.
  `youtube.com/watch?v=...&list=...`) to the default `download`
  command, the CLI now detects `_type === 'playlist'` and
  iterates each entry, re-invoking itself for every video. A
  sanitized playlist title is used as the output subdirectory.
  Previously the command assumed `videoInfo.formats` was always
  defined and crashed on playlist objects.
- Guarded the Premium-format detection path with
  `(videoInfo.formats || []).some(...)` so future extractors that
  return entry-style results without a `formats` array no longer
  throw.

## [2.0.66] - 2026-04-23

### Changed
- **Default `-f, --format` is now `best`** (was `default`, which preferred
  720p and only fell back to best). When no `-f` flag is provided, the
  CLI now downloads the highest-quality video the site offers. Pass
  `-f 720p` (or similar) to opt into a specific resolution.

## [2.0.63] - 2026-04-23

### Changed
- **Default subtitle fallback now includes auto-translate** as step 3 in
  the chain, matching what YouTube's web UI offers via
  *Feliratok → Automatikus fordítás*. Per-language order:
  1. Official / manually authored track.
  2. Auto-generated (ASR) track.
  3. YouTube auto-translate (only if the language appears in the video's
     `translationLanguages` list).
  4. Skip.
  So for a video with an English official caption and Hungarian only in
  the auto-translate list, both `en` and `hu` are now downloaded and
  embedded by default.

### Fixed
- **Subtitle downloads now forward cookies + browser-like headers**
  (User-Agent, Referer, Origin, `Accept-Language: en-US,en;q=0.9,hu;q=0.8`).
  YouTube's `&tlang=` auto-translate endpoint previously returned
  `HTTP 429 Too Many Requests` for unauthenticated requests, silently
  dropping the translated track. With forwarded cookies (from
  `--cookies`) the translate URL succeeds; even without cookies the
  added headers plus request pacing sharply reduce 429s.
- Missing `cookies` parameter plumbed through to `_downloadSubtitle`
  and `_embedSubtitlesHLS`.

## [2.0.62] - 2026-04-23

### Changed
- **Strict per-language fallback (then reverted in 2.0.63):**
  official / manual → auto-generated (ASR) → skip. Auto-translation
  was temporarily off the default path because YouTube's `&tlang=`
  endpoint returned `HTTP 429` for anonymous requests; see 2.0.63 for
  the proper cookie-based fix.
- Display-name-based matching: a caption track whose `name` contains
  "Magyar" (or "Hungarian") now counts as `hu`, and any name containing
  "English" counts as `en`. This supplements the existing ISO-code and
  alias matching (`hu`, `hu-HU`, `hun` → `hu`; `en`, `en-US`, `eng`, … → `en`).

### Fixed
- Subtitle downloads now pace requests (400 ms between files) and use an
  exponential-backoff retry with up to 6 attempts, honouring `Retry-After`
  when the server sends one. This avoids sporadic `HTTP 429` errors on
  videos with many subtitle tracks.

## [2.0.59] - 2026-04-23

## [2.0.58] - 2026-04-23

### Changed
- **Default subtitle languages: English + Hungarian.** The CLI no longer
  downloads every detected subtitle by default.
- `--sub-lang` now accepts a comma-separated list: `--sub-lang en,hu,de`.
- `--sub-lang all` still downloads every detected track and, unless
  `--no-sub-translate-missing` is passed, fills every translation
  language that is not already present.
- Language matching is alias-aware: `en-US`, `en-GB`, `eng` all count as
  English; `hu-HU`, `hun` count as Hungarian.

## [2.0.57] - 2026-04-23

(version bump only — no CLI release; v2.0.57 tag belongs to videodl-container)

## [2.0.56] - 2026-04-23

### Changed
- **Subtitles: manual + auto-generated downloaded by default.** The default
  subtitle behaviour now matches running yt-dlp with both `--write-subs` AND
  `--write-auto-subs --sub-langs "all"` in a single command. Every detected
  subtitle track — manual and auto-generated — is fetched and embedded into
  the output container (`.mkv` / `.mp4`) using the source's native language
  code (e.g. `eng`, `hun`).
- **Per-language preference: manual wins over auto-generated.** When a
  language is available both as a manually authored track and as an
  auto-generated (ASR) one, only the manual track is downloaded. Languages
  that exist only as auto-generated tracks (common for Hungarian etc.) are
  still included.
- **Override flag: `--no-subtitles`.** Disables all subtitle downloads and
  embedding. `--no-subtitle` is kept as an alias for backward compatibility.
- `src/extractors/youtube.js` — `_getCaptionsFromApi` now de-duplicates
  caption tracks with manual preference instead of silently letting the
  last track in the YouTube API response overwrite earlier ones.
- `src/extractors/ytdlp.js` — `_parseSubtitles` now also consumes
  `automatic_captions` from the yt-dlp JSON output so auto-generated
  tracks are included for every site that goes through the yt-dlp fallback.
- `src/cli.js` — five duplicated subtitle-resolution blocks are now
  delegated to a single `resolveSubtitleDownloads()` helper.

## [2.0.52] - 2026-04-17

### Fixed
- AShemaleTube extractor now supports the new `playerConfig.sources.hlsAuto` embed format.
  - Parses the HLS master playlist URL from `playerConfig`.
  - Preserves the legacy `var sources = [...]` fallback for older embed pages.
  - Adds renditions from the `/multi=WxH:key,.../` segment as explicit HLS quality entries.

## [2.0.30] - 2026-03-21

### Added
- **yt-dlp fallback extractor** — when no native extractor matches a URL, videodl-cli now
  automatically delegates to `yt-dlp` (if installed) for metadata extraction and format selection
  - Adds support for **1000+ additional sites** that yt-dlp covers
  - Native extractors always take priority (faster, no external dependency)
  - yt-dlp metadata (formats, subtitles, thumbnails) normalized to videodl-cli's internal format
  - Supports cookies pass-through and HTTP headers from yt-dlp format info
  - Graceful degradation: if yt-dlp is not on PATH, the extractor silently skips
  - Registered just before DirectExtractor in the extractor chain
- Updated EXTRACTORS.md with full 36-extractor list plus yt-dlp fallback documentation

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
