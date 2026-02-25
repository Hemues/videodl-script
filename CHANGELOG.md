# Changelog

All notable changes to videodl-cli will be documented in this file.

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
