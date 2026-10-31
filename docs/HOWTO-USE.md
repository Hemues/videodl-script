# Using videodl-cli

Kind: command line script (Node.js ES module, also packaged as standalone binaries).
Current version: 2.0.139 (`package.json`, the top entry of `CHANGELOG.md`, and the output of `node src/cli.js --version`).
Verified on: 2026-10-31 on the Linux build host with Node v22.22.2 (`node src/cli.js --version` printed `2.0.139`; `node src/cli.js extractors --json` listed 49 entries). Network downloads were not run in that pass, so every download example below is "(not verified in this pass)".

This document is the operator manual. The README gives the overview, the AGENTS file gives the rules for changing the code, and the LESSONS-LEARNED file gives the reasons behind the behaviour described here.

Synthetic URLs are used in the examples. `example.com` is a reserved test domain. Real site URLs appear only in the README support table.

## 1. Requirements

| Need | Check | Expected |
| --- | --- | --- |
| Node.js 18 or newer (22 is what the build uses) | `node --version` | `v18.x` or higher; the build host has `v22.22.2` (verified 2026-10-31) |
| ffmpeg (optional; downloaded on first use if missing) | `ffmpeg -version` | a version line, or nothing (then videodl downloads a static build to `~/.videodl-cli/ffmpeg/`) |
| npm (only for a source checkout) | `npm --version` | any recent version |
| yt-dlp (optional, for the fallback to more than 1000 sites) | `yt-dlp --version` | a version line; without it the fallback silently skips |
| curl (used by the HentaiHaven extractor) | `curl --version` | a version line |
| Python 3 (only for the test gate `tests/smoke.py`) | `python3 --version` | `3.x` |
| Network access to the target sites | `curl -sI https://example.com` | an HTTP status line |

Operating systems used so far: Linux (the build host, Fedora based), Windows 10 and 11 (the owner's workstation), and a Fedora based container image (see the container repository).

### 1.1 Installing ffmpeg by hand (optional)

```powershell
# Windows, Chocolatey
choco install ffmpeg
# Windows, or any OS: download from https://ffmpeg.org/download.html and put ffmpeg on the PATH
```

```bash
sudo apt install ffmpeg        # Ubuntu / Debian
sudo dnf install ffmpeg        # Fedora (RPM Fusion build; see LESSONS #18 item 8c for the container case)
sudo pacman -S ffmpeg          # Arch
brew install ffmpeg            # macOS
```

Or skip this step: videodl downloads a static ffmpeg build to `~/.videodl-cli/ffmpeg/` on first use. (The download step was not verified in this pass.)

## 2. Get it

The repository is public (AGENTS.md says so), and the release binaries are published as release assets of the same repository (the README says so; the release assets were not checked in this pass).

Two ways to get the code:

```bash
# Option A: clone (needs access to the repository on the code host)
git clone https://github.com/Hemues/videodl-script.git videodl-cli
cd videodl-cli
git log --oneline -1          # the newest commit, for example 4ade70b (2026-10-31)
```

```bash
# Option B: release binary (no Node.js needed); see section 3.3
# Download the asset for your platform and SHA256SUMS from the release page,
# then verify the checksum:
sha256sum -c --ignore-missing SHA256SUMS
```

On the owner's Windows workstation the repository is also present as a local clone on a network share. Use the clone that your team names as the working clone (see LESSONS-LEARNED entry #22 for the two-clone rule).

Verify a checkout before you trust it:

```bash
git -c core.fileMode=false status --short     # expect no output on a clean checkout (an untracked tests/__pycache__/ after a test run is not a change)
git ls-files -s compile.sh                     # mode 100755 is the HEAD state for most files (a few are 100644, see README "Known gaps" and LESSONS #24)
```

## 3. Install

### 3.1 From source, Linux or macOS

```bash
cd videodl-cli
chmod +x setup.sh
./setup.sh            # checks Node.js and ffmpeg, runs npm install, offers npm link
npm install           # if you skipped setup.sh
npm link              # optional: makes `videodl` available on the PATH
videodl --version     # expect 2.0.139
```

`setup.sh` is not verified in this pass. `npm install` uses the committed `package-lock.json`. Do not delete the lock file: the build depends on the exact dependency tree (`compile.sh` uses `npm ci`).

### 3.2 From source, Windows 10 or 11 (PowerShell)

```powershell
cd videodl-cli
.\setup-windows.ps1   # checks Node.js and ffmpeg, runs npm install
npm install
npm link              # optional
videodl --version
```

If PowerShell refuses to run the script, use `powershell -ExecutionPolicy Bypass -File .\setup-windows.ps1` for one run. (Not verified in this pass.)

Note: on Windows a file on a network share has no reliable executable bit. Call scripts as `bash <script>` from Git Bash, and call the CLI as `node src/cli.js ...` when `npm link` is not used.

### 3.3 Standalone binary

Pre-built binaries need no Node.js. Release assets (as the README lists them; the release page is the authority):

| Asset | Description |
|-------|-------------|
| `videodl-linux` / `videodl-ffmpeg-linux` | Linux x64: plain (downloads ffmpeg on first use) / ffmpeg embedded |
| `videodl-linux-arm64` / `videodl-ffmpeg-linux-arm64` | Linux arm64: plain / ffmpeg embedded |
| `videodl.exe` / `videodl-ffmpeg.exe` | Windows x64: plain / ffmpeg embedded |
| `videodl-x86.exe` | Windows 32-bit: plain only (no 32-bit ffmpeg or CycleTLS helper exists upstream) |
| `cycletls-index-linux` / `cycletls-index-linux-arm64` / `cycletls-index-windows.exe` | CycleTLS helper. Place it next to the binary as `index` / `index-arm64` / `index.exe` |
| `SHA256SUMS` | sha256 of every asset above. Verify: `sha256sum -c --ignore-missing SHA256SUMS` |

The two variants are: the plain binary, which downloads ffmpeg on first use, and the "ffmpeg" binary, which embeds ffmpeg.

For the Linux x64 plain binary, copy `videodl-linux` to a directory on the PATH, make it executable (`chmod 0755`), and keep the CycleTLS helper `index` (Linux) next to it, because some extractors need it. The Windows binary `videodl.exe` needs `index.exe` in the same folder.

Output sizes of a build, from the old README (not re-measured on 2026-10-31):

| File | Description | Size |
|------|-------------|------|
| `dist/videodl.exe` | Windows x64 standalone | about 92 MB |
| `dist/videodl-linux` | Linux x64 standalone | about 117 MB |
| `dist/videodl.cjs` | Portable CJS bundle (needs Node.js) | about 5.5 MB |
| `dist/index` (Linux) / `dist/index.exe` (Windows) | CycleTLS Go sidecar binary | about 8 MB |

The build uses esbuild for bundling and Node.js SEA (Single Executable Application) for the binary. BUILD.md has the internals.

### 3.4 Build the binaries yourself (maintainer)

```bash
bash compile.sh                # all targets; needs the pinned Node and ffmpeg (build-pins.json)
bash compile.sh --bundle-only  # CJS bundle only, needs Node.js on the target
bash compile.sh --clean        # clean dist/ first
bash compile.sh --no-ffmpeg    # binaries without the embedded ffmpeg
bash compile.sh --targets=all  # every target (default for a release)
```

Windows maintainers use `.\compile.ps1` (with `-Linux`, `-BundleOnly`, `-Clean`). `compile.sh` checks the sha256 of every downloaded archive against `build-pins.json` and of the solver against `src/vendor/ejs.lock.json`. A mismatch stops the build. Read BUILD.md for the internals. (Not verified in this pass.)

## 4. Configure

There is no configuration file. Every setting is a command line option or an environment variable.

### 4.1 Environment variables

| Name | Default | Read in | Meaning | Change when |
| --- | --- | --- | --- | --- |
| `VIDEODL_ALLOW_PRIVATE_URLS` | unset (private addresses refused) | `src/cli.js`, `src/url-guard.js` | `1` allows loopback, LAN and link-local URLs | you download from a NAS or a LAN server. Same as `--allow-private-urls` |
| `VIDEODL_SOLVER_UNSANDBOXED` | unset (solver sandboxed) | `src/solver-sandbox.js` | `1` runs the YouTube challenge solver without the permission sandbox; prints a loud warning | debugging the solver only. Never set it on a shared host |
| `VIDEODL_CAPTCHA_PROVIDER` | `wit` | `src/captcha-solver.js`, `src/cookie-generator.js` | `wit` (free) or `2captcha` (paid) | you use the paid solver |
| `VIDEODL_CAPTCHA_API_KEY` | unset | `src/captcha-solver.js`, `src/cookie-generator.js` | API key for the chosen solver. Secret | you need CAPTCHA solving. Keep it out of git and out of shell history |
| `CAPTCHA_PROVIDER` | unset | `src/captcha-solver.js`, `src/cookie-generator.js`, `src/cli.js` | short form read as a fallback | the same as above (the `VIDEODL_` names are preferred) |
| `CAPTCHA_API_KEY` | unset | the same files as `CAPTCHA_PROVIDER` | short form of the key. Secret | the same as above |
| `NODE_OPTIONS` | not set by the user | `src/solver-sandbox.js` (the parent passes it to the solver child) | carries `--permission` to the solver child | never set it by hand |
| `LOCALAPPDATA`, `PROGRAMFILES` | system | `src/cli.js`, `src/cookie-extractors/brazzers/aylo.js` | Windows locations that are searched for the browser used by cookie generation | a browser is not found on Windows |
| `PATH` | system | `src/cli.js`, `src/ffmpeg-helper.js` | where ffmpeg and the helpers are searched; ffmpeg is looked up in-process (no `which`) | a tool is not found. Put it on the PATH |

The ffmpeg cache directory is `~/.videodl-cli/ffmpeg/` (the help text says so; the download is not verified in this pass).

### 4.2 Files the tool reads

| Path | Default | Meaning | Secret? |
| --- | --- | --- | --- |
| `cookies/cookies.txt` | `cookies/cookies.txt` relative to the working directory | Netscape cookie file (same format as yt-dlp and curl) | yes, never commit |
| `logins/logins.txt` | `logins/logins.txt` | lines `loginPageUrl::username::password` for `generate-cookies` | yes, never commit |
| `cookies/cookies.txt.example`, `logins/logins.txt.example` | tracked examples | templates only | no |
| `downloads/` | `./downloads` | default output directory (`-d` changes it) | no |
| `~/.videodl-cli/ffmpeg/` | created on first use | downloaded static ffmpeg | no |

The `.gitignore` excludes the real cookie and login files and the `downloads/` folder. Keep it that way.

### 4.3 Download options (`videodl download`)

These are the options of the `download` command, as printed by `node src/cli.js download --help` on 2026-10-31.

| Option | Default | Meaning |
| --- | --- | --- |
| `-o, --output <filename>` | auto (`<title>-<domain>.<ext>`) | explicit file name; must stay inside `-d`; expands `%(title)s`, `%(ext)s`, `%(id)s`, `%(extractor)s`, `%(quality)s` |
| `-d, --directory <path>` | `./downloads` | output directory |
| `-f, --format <quality>` | `best` (the help also lists `none`, which means the same) | `best`, `worst`, `720p`, `1080p` and so on |
| `-H, --header <header>` | none | extra HTTP header, repeatable. CR and LF are stripped |
| `--list-formats` | off | list formats and stop |
| `--no-base-url` | off (domain is added) | do not add the domain to the file name |
| `--no-ssl-verify` | off (TLS verified) | disable certificate verification for this run only |
| `--proxy <url>` | none | HTTP or SOCKS proxy, for example `socks5://127.0.0.1:9050` |
| `--cookies <file>` | `cookies/cookies.txt` | Netscape cookie file |
| `--generate-cookies` | off | refresh expired cookies from the logins file first |
| `--logins <file>` | `logins/logins.txt` | login file for cookie generation |
| `--force-cookies` | off | regenerate cookies even if they look valid |
| `--no-headless` | headless | show the browser during cookie generation (manual CAPTCHA) |
| `--allow-private-urls` | off | allow LAN and loopback URLs |
| `--captcha-provider <id>` | `wit` | `wit` or `2captcha` |
| `--captcha-key <key>` | env | key for the solver (prefer the environment variable; the command line stays in shell history) |
| `--no-subtitles` / `--no-subtitle` | subtitles on | do not download or embed subtitles |
| `--sub-lang <langs>` | see section 5.3 | comma-separated codes, or `all` |
| `--sub-translate <lang>` | none | auto-translate to one language (one output track) |
| `--no-sub-translate-missing` | fill on with `all` | with `--sub-lang all`, skip the auto-translate fill |
| `--audio-lang <lang>` | auto-detect | a language code, or `all` for every audio track |

### 4.4 Other commands and their options

| Command | Options (in addition to the global ones) |
| --- | --- |
| `convert <input> <output>` | `-vc/--video-codec`, `-ac/--audio-codec`, `-vb/--video-bitrate`, `-ab/--audio-bitrate`, `-s/--resolution`, `-r/--fps`, `-f/--format` (mp4, mkv, webm, avi ...), `-q/--quality` (1 to 31, lower is better), `--no-overwrite` |
| `dl-convert <url> <output>` | `-d`, `-q/--quality` (default `best`), `-H`, `--no-base-url`, the conversion options above, `--keep-original`, `--cookies`, `--allow-private-urls` |
| `list-formats <url>` | `--cookies`, `--allow-private-urls` |
| `extract <url>` | `--cookies`, `--allow-private-urls`. Prints JSON, no download |
| `download-json <url>` | the download options; prints JSON progress lines for a backend (see section 5.7) |
| `generate-cookies` | `--logins`, `--cookies`, `--force`, `--no-headless`, `--verbose` |
| `browser-login <url>` | `--cookies`, `--timeout <seconds>` (default 300), `--verbose`, `--wait` (keep the browser open until you close it) |
| `probe <file>` | `-j/--json` |
| `extractors` | `-j/--json` (the list of extractors with their URL patterns) |
| `sites` | none (the list of supported sites) |
| `info` | none (ffmpeg installation and path) |
| `formats` | none (supported output formats) |
| `codecs` | none (supported codecs) |

The bare form `videodl <url>` is the same as `videodl download <url>`. The `--help` output of each command is the authoritative list for your version.

## 5. Use

### 5.1 Download one video

```bash
# Best available quality into ./downloads (the default directory)
videodl download "https://example.com/video/123"

# 720p into a chosen folder
videodl download -f 720p -d ~/Videos "https://example.com/video/123"

# A custom file name (must stay inside the output folder)
videodl download -d ~/Videos -o my-clip.mp4 "https://example.com/video/123"

# Without the domain in the file name
videodl download --no-base-url "https://example.com/video/123"
```

Expected: a progress bar, then a line with the saved path. The file name is `<sanitised title>-<domain>.<ext>` unless `-o` or `--no-base-url` is used. (Not verified in this pass: the exact file name for example.com.)

A warning appears when the quality you asked for is not available. In JSON mode (`download-json`) it is a line with `"status": "warning"` and the text `Requested 1080p but best available is 360p (<n> format(s) found)`. The download continues with the best available format. (The exact text in the normal CLI output was not checked in this pass.)

### 5.2 List formats first

```bash
videodl download --list-formats "https://example.com/video/123"
```

On YouTube with Premium cookies the Premium formats are marked with a star in the list.

### 5.3 Subtitles

The subtitle code has been changed several times. The current facts are these.

- The code constant `DEFAULT_SUB_LANGS` in `src/cli.js` is an empty list. With no `--sub-lang` option, no subtitle is downloaded. This is the state since commit `dbcea2e` (2026-04-25). See LESSONS-LEARNED entry #21.
- The help text printed by `node src/cli.js download --help` says `en,hu (DEFAULT)` in one place and `Default: none` in another. The code is the authority: no default. Read the help output of your version before you rely on it.
- The README section about subtitles still says English and Hungarian are downloaded by default. That sentence is outdated since 2026-04-25.

Subtitle options:

```bash
# English only, with the fallback chain described below
videodl download --sub-lang en "https://www.youtube.com/watch?v=VIDEO_ID"

# English and Hungarian
videodl download --sub-lang en,hu "https://www.youtube.com/watch?v=VIDEO_ID"

# Every native track, and fill every language YouTube can translate
videodl download --sub-lang all "https://www.youtube.com/watch?v=VIDEO_ID"

# Every native track and no auto-translate fill
videodl download --sub-lang all --no-sub-translate-missing "https://www.youtube.com/watch?v=VIDEO_ID"

# One translated track only, Hungarian
videodl download --sub-translate hu "https://www.youtube.com/watch?v=VIDEO_ID"

# No subtitles at all
videodl download --no-subtitles "https://www.youtube.com/watch?v=VIDEO_ID"
```

The chain for each requested language:

1. An official or manually authored track in that language. The match is case-insensitive, and a display name such as "Magyar" counts as `hu`. Aliases such as `en-US`, `en-GB`, `eng` count as English, and `hu-HU`, `hun` count as Hungarian.
2. An automatically generated (ASR) track in that language.
3. YouTube's auto-translate, when the language is in the video's translation list. The translate endpoint answers HTTP 429 to anonymous requests; a cookies file with `--cookies` makes it work (LESSONS #29).
4. Skip, and say so.

Subtitle downloads are paced: 400 ms between files, exponential backoff with up to six attempts, and `Retry-After` is honoured. The subtitles are embedded into the output container (`.mkv` when several subtitle tracks are merged, `.mp4` otherwise). Every subtitle track is kept, because the disposition step uses `-map 0` (LESSONS #13).

### 5.4 Cookies and logins

```bash
# Use an exported Netscape cookie file
videodl download --cookies cookies/cookies.txt "https://members.example.com/video/123"

# Refresh expired cookies from the logins file, then download
videodl download --generate-cookies "https://members.example.com/video/123"

# Regenerate cookies even when they look valid (the server rejected the session)
videodl download --force-cookies "https://members.example.com/video/123"

# Show the browser while cookies are generated (manual CAPTCHA)
videodl download --generate-cookies --no-headless "https://members.example.com/video/123"

# Generate or refresh cookies without a download
videodl generate-cookies
videodl generate-cookies --force

# Log in by hand in a browser window; the cookies are captured and saved
videodl browser-login "https://members.example.com/login" --timeout 300
```

The login file format is one line per site:

```
https://members.example.com/login::USERNAME::PASSWORD
```

Export cookies from your browser with a Netscape-format extension (for example "Get cookies.txt LOCALLY"). Do not commit the cookie file, the login file or the exported text.

YouTube login cannot be automated, because of Google's bot protection. Re-export the YouTube cookies by hand when the session expires. The tool logs `YouTube session expired - Premium formats unavailable` and continues with the standard formats.

### 5.5 YouTube Premium formats

With a cookie file that holds a logged-in YouTube Premium session, the Premium formats are preferred and the requested resolution is upgraded. For example, `-f 720p` gives 1080p Premium if YouTube offers it, and 720p standard otherwise.

```bash
videodl download --list-formats --cookies cookies/cookies.txt "https://www.youtube.com/watch?v=VIDEO_ID"
videodl download --cookies cookies/cookies.txt "https://www.youtube.com/watch?v=VIDEO_ID"
```

The feature needs no extra flag. Premium formats exist only for some videos.

The upgrade rule, from the README (kept here as the reference):

| Requested | Available Premium | Result |
|-----------|------------------|--------|
| 720p | 1080p Premium, 720p Premium | 1080p Premium (best Premium) |
| 720p | 720p Premium only | 720p Premium |
| 1080p | 1080p Premium | 1080p Premium |
| 720p | none (session expired) | 720p standard, with a warning |

When the cookie file's session is expired (`LOGGED_IN=false`) and `--generate-cookies` is set with a login entry, a cookie refresh is attempted and extraction runs again. Otherwise the warning is printed and the download continues with standard formats. The `__Secure-1PSID` expiry is also checked before extraction starts.

### 5.6 Playlists and channels

```bash
# Whole playlist into ./downloads/<Playlist name>/
videodl download "https://www.youtube.com/playlist?list=PLxxxxxxxx"

# A playlist linked from a video URL
videodl download "https://www.youtube.com/watch?v=VIDEO_ID&list=PLxxxxxxxx"

# A channel
videodl download "https://www.youtube.com/@ChannelName"
```

The playlist or channel title becomes a sub-folder. Each entry is downloaded by re-running the CLI for it, so one failed entry does not stop the others. (Not verified in this pass for a new playlist.)

### 5.7 Machine-readable output (for a backend)

```bash
# JSON extraction, no download
videodl extract "https://example.com/video/123"

# JSON progress lines during a download
videodl download-json "https://example.com/video/123"
```

A DRM-protected stream is reported as `{"drm": true, "drmSystems": [...]}` and refused. The tool never circumvents DRM (LESSONS #16).

### 5.8 Convert a video

```bash
videodl convert input.mkv output.mp4
videodl convert input.mp4 output.mp4 -vc libx265 -ac aac -s 1280x720 -vb 2M -ab 128k
videodl convert input.mp4 output.mp4 -r 30
videodl convert input.mp4 output.mp4 -q 5 --no-overwrite
```

`-q` is the ffmpeg quality factor (1 to 31, lower is better). `--no-overwrite` stops with an error when the output exists.

### 5.9 Download and convert in one step

```bash
videodl dl-convert "https://example.com/video.mp4" output.mp4 -vc libx265
videodl dl-convert "https://example.com/video.mp4" output.mp4 --keep-original
```

### 5.10 Information commands

```bash
videodl sites            # supported sites (help text)
videodl extractors       # extractors and their URL patterns
videodl extractors --json
videodl probe video.mp4  # media file metadata
videodl probe video.mp4 -j
videodl info             # ffmpeg version and path
videodl formats          # output formats
videodl codecs           # codecs
```

`node src/cli.js extractors --json` returned 49 entries on 2026-10-31. Forty-seven of them are site extractors. The other two are the yt-dlp fallback and the direct-URL extractor.

### 5.11 Programmatic use

```javascript
import { VideoDownloader } from './src/downloader.js';
import { VideoConverter } from './src/converter.js';
import { extractVideoInfo } from './src/extractors/index.js';

const info = await extractVideoInfo('https://example.com/video/123');
console.log(info.title, info.formats);

const downloader = new VideoDownloader();
downloader.on('progress', ({ percent }) => console.log(`${percent}%`));
await downloader.download({
  url: 'https://example.com/video.mp4',
  filename: 'output.mp4',
  directory: './downloads'
});

const converter = new VideoConverter();
await converter.convert('input.mp4', 'output.mkv', { videoCodec: 'libx264', audioCodec: 'aac' });
```

(Not verified in this pass. `examples.js` in the repository has more patterns.)

### 5.12 Per-site throttles and limits

These limits were measured. Respect them; they are not bugs to hide.

| Site or service | Limit | Source |
| --- | --- | --- |
| YouTube auto-translate (`&tlang=`) | HTTP 429 for anonymous requests; works with cookies | CHANGELOG 2.0.62-2.0.63, LESSONS #29 |
| YouTube subtitle files | 400 ms pacing, six attempts with backoff | CHANGELOG 2.0.62 |
| PornHub mp4 list | 240p, 480p, 720p at `rate=500k`; 1080p at `rate=50000k`; the cap is per connection (about 0.65 MB/s on one connection, 4.9 MB/s with eight parallel ranges); the chunked downloader is sequential | LESSONS #19 (measured 2026-10-03) |
| PornHub HLS CDN | the CDN is chosen per page load; `410 Gone` never clears on retry; a new page load can draw the other CDN | LESSONS #19 |
| Cloudflare managed challenge (HentaiHaven) | only curl passes the TLS check; Node and cycletls do not | LESSONS #15 |
| Mux (Skool) | signed playback needs `Referer` and `Origin` | CHANGELOG 2.0.106 |

### 5.13 Standalone binary and the CycleTLS helper

Some extractors (SpankBang, 9GAG, Dailymotion, Bitchute, and the Cloudflare bypass) need the CycleTLS helper binary `index` (Linux) or `index.exe` (Windows) in the same folder as `videodl`. If it is missing you see `Executable not found`. Keep the helper next to the binary when you copy it.

## 6. Update

The CLI has no self-update. A user gets a new version in one of three ways.

1. From source: `git pull` in the clone, then `npm install` (the lock file is committed), then `npm link` again if you use it.
2. From a binary: download the new release asset and `SHA256SUMS`, verify the checksum, replace the old file, and copy the matching CycleTLS helper.
3. Through the container: the container repository rebuilds the image with the new CLI (see its own documentation).

Upstream yt-dlp is tracked by a maintainer pipeline (`update-from-upstream.sh`, weekly timer, `contrib/systemd/`). It refuses to ship a candidate whose smoke gate is red. A human decides about the InnerTube client table (the pipeline reports a diff only). See `UPDATE-FROM-YTDLP.md`.

## 7. Uninstall

```bash
npm unlink -g videodl-cli            # if you used npm link
rm -rf ~/.videodl-cli                # the downloaded ffmpeg cache (Linux or macOS)
```

On Windows delete the folder of the clone and `%USERPROFILE%\.videodl-cli` if it exists. The downloads in `./downloads` are yours and are not removed.

## 8. Troubleshooting

### `ffmpeg not found. Please install ffmpeg and ensure it's in your PATH`

This is the text of `src/converter.js`. videodl downloads a static ffmpeg to `~/.videodl-cli/ffmpeg/` on first use. If that fails, install ffmpeg with your package manager (`sudo dnf install ffmpeg`, `sudo apt install ffmpeg`, `brew install ffmpeg`, or `choco install ffmpeg`). The system ffmpeg on the PATH is preferred (LESSONS #18 item 8c).

### `Executable not found` for SpankBang, 9GAG, Dailymotion or Bitchute

The message is the one quoted in the CHANGELOG 2.0.10 entry (the text is not found verbatim in `src/` on 2026-10-31). The CycleTLS helper is missing next to the binary. Copy `index` (Linux) or `index.exe` (Windows) into the same folder. The shipping fix is commit `c61c405` (2026-03-20).

### `Found 0 formats` on PornHub, or `HTTP 410 Gone` for every quality

Two causes, both fixed in 2.0.139. Update to 2.0.139. If it still happens, load the page again (a new page load can draw the other CDN) and check that the cookie file is passed with `--cookies` (LESSONS #19).

### `HTTP 429 Too Many Requests` on subtitles

Pass a cookies file with `--cookies`. Reduce `--sub-lang` to the languages you need. The tool already paces requests and backs off.

### `HTTP 403 Forbidden` on YouTube media URLs

The InnerTube client table is out of date, or the video needs a PO token (age-restricted or token-gated). See `YOUTUBE-LIMITATIONS.md` and LESSONS #14. Do not work around it by changing the client version by hand; use the sync process.

### `YouTube session expired - Premium formats unavailable`

The YouTube cookies expired. Export them again from the browser that is logged in (the automatic login does not work for YouTube).

### `points at a private/internal address (<host>); refusing. Use --allow-private-urls to override.`

The URL resolves to a loopback, LAN, link-local or reserved address. The text comes from `src/url-guard.js`. A host name that is local (`localhost`, `*.local`, `*.internal`) gets the sibling text `points at a local name`. This is the SSRF guard. For a NAS on your own LAN, add `--allow-private-urls` or set `VIDEODL_ALLOW_PRIVATE_URLS=1`. Do not use this for untrusted input (REVIEW-2026-09-13.md).

### `Output filename "<name>" would escape the download directory <dir>`

The `-o` value contained `..` or resolved outside `-d`. The other refusals of the same function are `Output filename (-o) is empty` and `must be relative to the download directory` (an absolute path). Use a plain file name with `-o` and the folder with `-d`. The template fields `%(title)s`, `%(ext)s`, `%(id)s`, `%(extractor)s` and `%(quality)s` are expanded before the check (`src/cli.js`, `resolveOutputFilename`).

### `DRM-protected: <systems>`

The stream is protected by Widevine, PlayReady or FairPlay. videodl does not and will not decrypt it. No cookie or login makes it downloadable.

### `Cannot read properties of undefined (reading 'some')`

Fixed in 2.0.68 (playlist URLs). Update. If it recurs, the extractor returned a playlist object without a `formats` array (LESSONS #28).

### SSL certificate errors

`--no-ssl-verify` disables verification for one run. Do not put it in a script. The fallback to yt-dlp no longer disables verification by itself (2.0.139).

### A downloaded file contains only the first 4 seconds

This happened with the ffmpeg master snapshot in release 2.0.136 (superseded). Use the pinned release branch build of ffmpeg from `build-pins.json`, and run `tests/smoke.py --binary <binary>` (LESSONS #18 item 8).

### The subtitles you expected are missing

Check the default: with no `--sub-lang`, no subtitle is downloaded (section 5.3). Pass `--sub-lang en,hu` explicitly.

## 9. Test gate

```bash
python3 tests/smoke.py --source                      # from the checkout (npm test runs this)
python3 tests/smoke.py --binary dist/videodl-ffmpeg-linux
python3 tests/smoke.py --image ghcr.io/hemues/videodl:candidate   # podman run
python3 tests/smoke.py --deployed videodl            # podman exec into the running container
python3 tests/smoke.py --source --filter pornhub     # only the cases whose name contains the text
python3 tests/smoke.py --source --json report.json   # write a JSON report
```

The gate runs public cases through the public CLI entry point and includes negative tests for the SSRF guard, the `-o` traversal and the solver sandbox. It needs network access. It was not run in the 2026-10-31 documentation pass (not verified in this pass).
