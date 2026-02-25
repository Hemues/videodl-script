# Project Structure

```
videodl-cli/
├── src/
│   ├── cli.js                     # CLI entry point (commander.js, 14 commands)
│   ├── index.js                   # Programmatic API exports
│   ├── downloader.js              # HTTP/HLS/DASH download engine
│   ├── converter.js               # ffmpeg conversion wrapper
│   ├── cookies.js                 # Netscape cookie parser + header builder
│   ├── cookie-generator.js        # Browser-based login automation (Puppeteer)
│   ├── cf-solver.js               # Cloudflare WAF bypass (cycletls)
│   ├── captcha-solver.js          # reCAPTCHA v2 solver (wit.ai / 2captcha)
│   ├── solver-loader.js           # YouTube signature solver loader
│   ├── ffmpeg-helper.js           # Auto-download ffmpeg if missing
│   ├── help.js                    # Full CLI help text (yt-dlp style)
│   ├── extractors/                # Site-specific video extractors
│   │   ├── index.js               # Extractor registry (21 sites + direct)
│   │   ├── base.js                # BaseExtractor — canHandle, extract, selectFormat
│   │   ├── youtube.js             # YouTube (metadata + limited download)
│   │   ├── xhamster.js            # xHamster
│   │   ├── pornhub.js             # PornHub
│   │   ├── xvideos.js             # XVideos
│   │   ├── xnxx.js                # XNXX
│   │   ├── youporn.js             # YouPorn (HLS)
│   │   ├── redtube.js             # RedTube
│   │   ├── tube8.js               # Tube8
│   │   ├── kvs.js                 # KVS engine (generic)
│   │   ├── facebook.js            # Facebook / fb.watch
│   │   ├── vimeo.js               # Vimeo
│   │   ├── indavideo.js           # Indavideo.hu
│   │   ├── videa.js               # Videa.hu / videakid.hu
│   │   ├── motherless.js          # Motherless
│   │   ├── inporn.js              # InPorn
│   │   ├── tnaflux.js             # TnaFlix / EmpFlix
│   │   ├── tubesafari.js          # TubeSafari (xHamster embeds)
│   │   ├── pornone.js             # PornOne
│   │   ├── pornzog.js             # PornZog (HClips embeds)
│   │   ├── uncensoredhentai.js    # UncensoredHentai
│   │   ├── brazzers.js            # Brazzers (cookie-authenticated)
│   │   └── direct.js              # Direct URL fallback
│   ├── cookie-extractors/         # Site-specific login automation
│   │   ├── index.js               # Cookie extractor registry
│   │   └── brazzers/              # Brazzers/Aylo login handler
│   │       ├── index.js
│   │       └── aylo.js
│   └── vendor/
│       └── yt.solver.core.js      # YouTube cipher/signature solver
├── cookies/
│   └── cookies.txt.example        # Example cookie file format
├── logins/
│   └── logins.txt.example         # Example login credentials format
├── build.mjs                      # Build script (esbuild bundle + SEA)
├── sea-config.json                # Node.js SEA configuration
├── compile.ps1                    # Windows build wrapper
├── compile.sh                     # Linux build wrapper
├── setup-windows.ps1              # Windows setup (Node.js, ffmpeg, npm)
├── setup.sh                       # Linux/macOS setup
├── package.json                   # npm package manifest
├── examples.js                    # Programmatic API examples
├── test-extractor.js              # Generic extractor test tool
├── LICENSE                        # GPL-2.0
└── .gitignore                     # Git ignore rules
```

## Module Overview

### Download Pipeline

```
URL → getExtractor(url)
    → extractor.extract(url)        → { title, formats[] }
    → selectFormat(formats, quality) → { url, quality, type }
    → download type?
        ├── direct HTTP  → downloader.download()
        ├── HLS/M3U8     → downloader.downloadHLS()     (ffmpeg)
        └── DASH         → downloader.downloadAndMerge() (video + audio + subs → ffmpeg mux)
```

### Extractor System

Each extractor extends `BaseExtractor` and implements:
- `static canHandle(url)` — URL pattern matching
- `async extract(url, options)` — returns `{ title, formats, subtitles? }`
- `selectFormat(formats, quality)` — picks the best matching format

The registry in `extractors/index.js` tries each extractor in order; `DirectExtractor` is the last resort.

### Cookie System

```
logins/logins.txt → cookie-generator.js (Puppeteer) → cookies/cookies.txt
                                                          ↓
cookies/cookies.txt → cookies.js (parser) → Cookie header for HTTP requests
                                          → Cookie string for ffmpeg
```

### Build Pipeline

```
src/**/*.js → esbuild (bundle) → dist/videodl.cjs → Node.js SEA → dist/videodl.exe
                                                                  → dist/videodl-linux
```
