# videodl-cli

A powerful CLI video downloader and converter with **21 built-in site extractors**, DASH/HLS streaming support, cookie-based authentication, subtitle embedding, and standalone binary compilation. Inspired by [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [Video DownloadHelper](https://github.com/aclap-dev/vdhcoapp).

## Features

- **21 site extractors** — YouTube, PornHub, XVideos, xHamster, Facebook, Vimeo, and more
- **Quality selection** — choose `best`, `worst`, `720p`, `1080p`, or let it auto-select
- **YouTube Premium support** — automatically downloads enhanced bitrate (Premium) formats when a YouTube Premium cookie is provided
- **DASH merging** — automatically merges separate video + audio streams via ffmpeg
- **HLS streaming** — downloads M3U8 / HLS streams with ffmpeg
- **Subtitle support** — downloads, embeds, and auto-translates subtitles (YouTube)
- **Cookie authentication** — Netscape cookie files (same format as yt-dlp / curl)
- **Auto cookie generation** — browser-based login automation via Puppeteer
- **Cloudflare bypass** — TLS fingerprint impersonation for CF-protected CDNs
- **CAPTCHA solving** — free reCAPTCHA v2 solver (wit.ai) or paid (2captcha)
- **Format conversion** — full ffmpeg wrapper (codecs, bitrate, resolution, fps)
- **Auto-downloads ffmpeg** — fetches a static ffmpeg build if not in PATH
- **Standalone binaries** — compiles to single-file executables (Windows + Linux)
- **Programmatic API** — import as an ES module for integration into other projects
- **Smart filenames** — auto-adds source domain to filenames (e.g., `video-youtube.com.mp4`)

## Supported Sites

| Site | URL | Notes |
|------|-----|-------|
| YouTube | youtube.com, youtu.be | Metadata extraction works; downloads may be blocked (see [limitations](YOUTUBE-LIMITATIONS.md)) |
| xHamster | xhamster.com | Full support |
| PornHub | pornhub.com | Full support |
| XVideos | xvideos.com | Full support |
| XNXX | xnxx.com | Full support |
| YouPorn | youporn.com | HLS streaming |
| RedTube | redtube.com | Full support |
| Tube8 | tube8.com | Full support |
| Facebook | facebook.com, fb.watch | Full support |
| Vimeo | vimeo.com | Full support |
| Indavideo | indavideo.hu | Full support |
| Videa | videa.hu, videakid.hu | Full support |
| Motherless | motherless.com | Full support |
| InPorn | inporn.com | Full support |
| TnaFlix | tnaflix.com, empflix.com | Full support |
| TubeSafari | tubesafari.com | xHamster embeds |
| PornOne | pornone.com | Full support |
| PornZog | pornzog.com | HClips embeds |
| UncensoredHentai | uncensoredhentai.xxx | Full support |
| Brazzers | brazzers.com | Requires cookies |
| KVS | KVS-powered sites | Generic KVS engine extractor |
| Direct URLs | any `.mp4`, `.mkv`, `.webm`, `.m3u8` | Fallback extractor |

## Prerequisites

- **Node.js** >= 18.0.0
- **ffmpeg** (auto-downloaded if not found in PATH)

### Installing ffmpeg

<details>
<summary>Windows</summary>

```powershell
# Using Chocolatey
choco install ffmpeg

# Or download from https://ffmpeg.org/download.html
```
</details>

<details>
<summary>Linux</summary>

```bash
# Ubuntu/Debian
sudo apt install ffmpeg

# Fedora
sudo dnf install ffmpeg

# Arch
sudo pacman -S ffmpeg
```
</details>

<details>
<summary>macOS</summary>

```bash
brew install ffmpeg
```
</details>

Or skip manual installation — videodl will auto-download a static ffmpeg build to `~/.videodl-cli/ffmpeg/` on first use.

## Installation

### From Source

```bash
cd videodl-cli
npm install
npm link          # makes 'videodl' available globally (optional)
```

### Using Setup Scripts

```powershell
# Windows
.\setup-windows.ps1
```

```bash
# Linux / macOS
chmod +x setup.sh
./setup.sh
```

The setup scripts check for Node.js and ffmpeg, install dependencies, and optionally run `npm link`.

### Standalone Binary

Pre-built binaries require no Node.js — see [Building Standalone Binaries](#building-standalone-binaries).

## Usage

### Download a Video

```bash
# Auto-detect site, default quality (720p if available, otherwise best)
videodl download "https://www.xvideos.com/video12345/example"

# Specify quality
videodl download -f 1080p "https://www.pornhub.com/view_video.php?viewkey=abc"

# Best available quality
videodl download -f best "https://xhamster.com/videos/example-123"

# List available formats without downloading
videodl download --list-formats "https://www.xvideos.com/video12345/example"

# Custom output directory and filename
videodl download -d ~/Videos -o myvideo.mp4 "https://example.com/video.mp4"

# Skip adding domain to filename
videodl download --no-base-url "https://example.com/video.mp4"
```

### URL Shorthand

You can omit the `download` command — a bare URL is treated as a download:

```bash
videodl "https://www.xvideos.com/video12345/example"
```

### Download with Cookies

```bash
# Use a Netscape cookie file (same format as yt-dlp / curl)
videodl download --cookies cookies/cookies.txt "https://members.example.com/video/123"

# Auto-regenerate expired cookies from logins file
videodl download --generate-cookies "https://members.example.com/video/123"

# Force cookie regeneration (even if they appear valid)
videodl download --force-cookies "https://members.example.com/video/123"

# Show browser during cookie generation (for manual CAPTCHA)
videodl download --generate-cookies --no-headless "https://example.com/video"
```

### Download with Subtitles

```bash
# Default: subtitles included when available
videodl download "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

# Skip subtitles
videodl download --no-subtitle "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

# Specific language
videodl download --sub-lang hu "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

# Auto-translate to Hungarian
videodl download --sub-translate hu "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
```

### Convert a Video

```bash
# Basic format conversion
videodl convert input.mkv output.mp4

# With codecs, resolution, bitrate
videodl convert input.mp4 output.mp4 -vc libx265 -ac aac -s 1280x720 -vb 2M -ab 128k

# Change frame rate
videodl convert input.mp4 output.mp4 -r 30
```

### Download and Convert

```bash
# One step
videodl dl-convert "https://example.com/video.mp4" output.mp4 -vc libx265

# Keep original downloaded file
videodl dl-convert "https://example.com/video.mp4" output.mp4 --keep-original
```

### Cookie Management

```bash
# Generate cookies (only refreshes expired ones)
videodl generate-cookies

# Force regenerate all
videodl generate-cookies --force

# Interactive browser login — manually log in, cookies are captured
videodl browser-login "https://members.example.com/login"
```

### Information Commands

```bash
videodl sites                # List supported sites
videodl extractors           # List extractors with URL patterns
videodl extractors --json    # Machine-readable extractor list
videodl probe video.mp4      # Show media file metadata
videodl probe video.mp4 -j   # JSON output
videodl info                 # ffmpeg version and path
videodl formats              # Supported output formats
videodl codecs               # Supported codecs
```

### Machine-Readable Output (for Backend Integration)

```bash
# JSON extraction (no download)
videodl extract "https://www.xvideos.com/video12345/example"

# JSON progress during download
videodl download-json "https://www.xvideos.com/video12345/example"
```

## All CLI Options

```
Download Options:
  -o, --output <filename>      Output filename
  -d, --directory <path>       Output directory (default: ./downloads)
  -f, --format <quality>       Quality: best, worst, 720p, 1080p (default: 720p-or-best)
  -H, --header <header>        Custom HTTP header (repeatable)
      --list-formats           List formats without downloading
      --no-base-url            Omit domain from filename
      --no-ssl-verify          Disable SSL verification
      --proxy <url>            HTTP/SOCKS proxy

Cookie Options:
      --cookies <file>         Netscape cookie file (default: cookies/cookies.txt)
      --generate-cookies       Auto-refresh expired cookies
      --force-cookies          Force cookie regeneration
      --no-headless            Show browser during cookie generation
      --logins <file>          Login file (default: logins/logins.txt)

CAPTCHA Options:
      --captcha-provider <id>  "wit" (free) or "2captcha" (paid)
      --captcha-key <key>      API key (or set env CAPTCHA_API_KEY)

Subtitle Options:
      --no-subtitle            Skip subtitles
      --sub-lang <lang>        Language code (en, hu, de, or "all")
      --sub-translate <lang>   Auto-translate to language

Conversion Options:
  -vc, --video-codec <codec>   Video codec (libx264, libx265, vp9, ...)
  -ac, --audio-codec <codec>   Audio codec (aac, mp3, opus, ...)
  -vb, --video-bitrate <br>    Video bitrate (e.g., 2M, 5000k)
  -ab, --audio-bitrate <br>    Audio bitrate (e.g., 128k, 320k)
  -s,  --resolution <res>      Resolution (e.g., 1920x1080)
  -r,  --fps <fps>             Frame rate
  -q,  --quality <q>           Quality factor (1-31, lower = better)
      --no-overwrite           Don't overwrite existing files
      --keep-original          Keep original after dl-convert
```

## Building Standalone Binaries

videodl can be compiled into standalone executables that require no Node.js installation.

### Windows

```powershell
.\compile.ps1                    # Windows binary
.\compile.ps1 -Linux             # + cross-compile Linux binary
.\compile.ps1 -BundleOnly        # CJS bundle only (no binary)
.\compile.ps1 -Clean             # Clean dist/ first
.\compile.ps1 -Clean -Linux      # Clean + both platforms
```

### Linux

```bash
chmod +x compile.sh
./compile.sh                     # Linux binary
./compile.sh --bundle-only       # CJS bundle only
./compile.sh --clean             # Clean dist/ first
```

### Output

| File | Description | Size |
|------|-------------|------|
| `dist/videodl.exe` | Windows x64 standalone | ~92 MB |
| `dist/videodl-linux` | Linux x64 standalone | ~117 MB |
| `dist/videodl.cjs` | Portable CJS bundle (needs Node.js) | ~5.5 MB |

The build pipeline uses **esbuild** for bundling and **Node.js SEA** (Single Executable Application) for binary creation. See [BUILD.md](BUILD.md) for technical details.

## Cookie & Login Setup

Some sites (e.g., Brazzers) require authentication. videodl supports two approaches:

### 1. Manual Cookie File

Export cookies from your browser using a cookie-export extension (e.g., "Get cookies.txt LOCALLY"), then:

```bash
videodl download --cookies path/to/cookies.txt "https://example.com/video"
```

### 2. Automated Cookie Generation

1. Copy the example file:
   ```bash
   cp logins/logins.txt.example logins/logins.txt
   ```
2. Edit `logins/logins.txt` with your credentials:
   ```
   https://members.example.com/login::username::password
   ```
3. Generate cookies:
   ```bash
   videodl generate-cookies
   ```

Cookies are saved to `cookies/cookies.txt` and reused automatically. Use `--generate-cookies` with download commands to auto-refresh expired cookies.

> **Security:** Never commit `cookies/cookies.txt` or `logins/logins.txt` to git. They are excluded by `.gitignore`. Only the `.example` files are tracked.

## YouTube Premium Enhanced Bitrate

When a cookie file contains valid YouTube Premium session credentials, videodl automatically detects and prefers **enhanced bitrate** (Premium) formats. These formats provide significantly higher video bitrate at the same resolution — for example, a 1080p Premium stream may have 2–3× the bitrate of the standard 1080p stream, resulting in noticeably better visual quality.

**How it works:**

1. Provide a cookie file from a browser session where you are logged into a YouTube Premium account
2. videodl detects formats marked as "Premium" by YouTube's API (`qualityLabel` contains "Premium")
3. At the same resolution and codec, Premium formats are automatically preferred over standard ones

**Usage:**

```bash
# Download with YouTube Premium cookies — Premium formats are selected automatically
videodl download --cookies cookies/cookies.txt "https://www.youtube.com/watch?v=VIDEO_ID"

# List formats to see which ones are Premium (marked with ★)
videodl download --list-formats --cookies cookies/cookies.txt "https://www.youtube.com/watch?v=VIDEO_ID"
```

**Requirements:**

- A valid YouTube Premium subscription on the account
- Cookies exported from a browser session logged into that account
- Premium formats are not available for all videos — only those where YouTube serves enhanced bitrate variants

> **Note:** Without Premium cookies, standard formats are downloaded as usual. The feature is fully automatic — no additional CLI flags are needed.

## Programmatic API

```javascript
import { VideoDownloader } from './src/downloader.js';
import { VideoConverter } from './src/converter.js';
import { extractVideoInfo, listSupportedSites } from './src/extractors/index.js';

// Extract video info
const info = await extractVideoInfo('https://www.xvideos.com/video12345/example');
console.log(info.title, info.formats);

// Download with progress
const downloader = new VideoDownloader();
downloader.on('progress', ({ percent }) => console.log(`${percent}%`));
await downloader.download({
  url: 'https://example.com/video.mp4',
  filename: 'output.mp4',
  directory: './downloads'
});

// Convert
const converter = new VideoConverter();
await converter.convert('input.mp4', 'output.mkv', {
  videoCodec: 'libx264',
  audioCodec: 'aac'
});
```

See [examples.js](examples.js) for more usage patterns.

## Project Structure

```
videodl-cli/
├── src/
│   ├── cli.js                 # CLI entry point (commander.js)
│   ├── index.js               # Programmatic API exports
│   ├── downloader.js          # HTTP/HLS/DASH download engine
│   ├── converter.js           # ffmpeg conversion wrapper
│   ├── cookies.js             # Netscape cookie parser
│   ├── cookie-generator.js    # Browser-based login automation
│   ├── cf-solver.js           # Cloudflare WAF bypass (cycletls)
│   ├── captcha-solver.js      # reCAPTCHA v2 solver (wit.ai / 2captcha)
│   ├── solver-loader.js       # YouTube signature solver loader
│   ├── ffmpeg-helper.js       # Auto-download ffmpeg if missing
│   ├── help.js                # CLI help text
│   ├── extractors/
│   │   ├── index.js           # Extractor registry (21 sites)
│   │   ├── base.js            # BaseExtractor class
│   │   ├── youtube.js         # YouTube extractor
│   │   ├── xhamster.js        # xHamster extractor
│   │   ├── pornhub.js         # PornHub extractor
│   │   ├── xvideos.js         # XVideos extractor
│   │   ├── facebook.js        # Facebook extractor
│   │   ├── vimeo.js           # Vimeo extractor
│   │   └── ...                # 15 more site extractors
│   ├── cookie-extractors/
│   │   └── brazzers/          # Brazzers-specific login automation
│   └── vendor/
│       └── yt.solver.core.js  # YouTube cipher solver
├── cookies/
│   └── cookies.txt.example    # Example cookie file format
├── logins/
│   └── logins.txt.example     # Example login credentials format
├── build.mjs                  # Build script (esbuild + SEA)
├── sea-config.json            # Node.js SEA configuration
├── compile.ps1                # Windows build wrapper
├── compile.sh                 # Linux build wrapper
├── setup-windows.ps1          # Windows setup script
├── setup.sh                   # Linux/macOS setup script
├── package.json               # npm package manifest
├── examples.js                # Programmatic API examples
└── test-extractor.js          # Generic extractor test tool
```

## Documentation

| Document | Description |
|----------|-------------|
| [INSTALL.md](INSTALL.md) | Detailed installation guide |
| [QUICKSTART.md](QUICKSTART.md) | Quick reference card |
| [BUILD.md](BUILD.md) | Build system internals (esbuild + SEA) |
| [LINUX-GUIDE.md](LINUX-GUIDE.md) | Linux tips (systemd, cron, aliases) |
| [EXTRACTORS.md](EXTRACTORS.md) | Extractor architecture & how to add sites |
| [ADD-BASE-URL-FEATURE.md](ADD-BASE-URL-FEATURE.md) | `--no-base-url` feature details |
| [YOUTUBE-LIMITATIONS.md](YOUTUBE-LIMITATIONS.md) | YouTube download restrictions |
| [CHANGELOG.md](CHANGELOG.md) | Version history |

## Troubleshooting

### "ffmpeg not found"

videodl auto-downloads ffmpeg on first use. If that fails, install it manually (see [Prerequisites](#prerequisites)).

### SSL Certificate Errors

```bash
videodl download --no-ssl-verify "https://example.com/video.mp4"
```

### 403 Forbidden on YouTube

YouTube blocks most automated downloads. See [YOUTUBE-LIMITATIONS.md](YOUTUBE-LIMITATIONS.md). For reliable YouTube downloads, use [yt-dlp](https://github.com/yt-dlp/yt-dlp).

### Cookie Errors

```bash
# Regenerate cookies
videodl generate-cookies --force

# Or manually log in via browser
videodl browser-login "https://example.com/login"
```

### Cloudflare-Protected Sites

Handled automatically via TLS fingerprint impersonation (cycletls). No user action needed.

## License

[GPL-2.0](LICENSE)

## Credits

- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — CLI design inspiration
- [Video DownloadHelper](https://github.com/aclap-dev/vdhcoapp) — architecture inspiration
- [ffmpeg](https://ffmpeg.org/) — media processing engine
- [esbuild](https://esbuild.github.io/) — JavaScript bundler
