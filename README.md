# videodl-cli

A command line video downloader and converter with 47 native site extractors, DASH and HLS support, cookie-based authentication, subtitle embedding, chapter embedding, a yt-dlp fallback for more than 1000 sites, and standalone binary builds for Linux and Windows. It is used by people who need to download video from sites they are allowed to use, and it is the engine behind the VideoDL container web UI.

It is NOT a DRM circumvention tool (it detects DRM and refuses it), NOT a site-login cracker (cookies come from the user's own session), and NOT a general media player or editor. Conversion is a thin wrapper around ffmpeg.

**Current version: 2.0.139** (`package.json`, the top entry of `CHANGELOG.md`, and the output of `node src/cli.js --version`, verified 2026-10-31 on the build host).

## Start here

1. This README: what the tool is, the current version, the architecture, where things are.
2. `docs/HOWTO-USE.md`: every command and option, install steps, examples with synthetic URLs, troubleshooting, the per-site limits. Read it before you run anything.
3. `AGENTS.md`: the invariants of the code (SSRF guard, ffmpeg whitelist, output confinement, solver sandbox), the extractor gotchas and the public-repository rule. Read it before you change any code.
4. `CHANGELOG.md`: the top entry, which is the newest change, and the Security section of 2.0.139.
5. `LESSONS-LEARNED.md`: the numbered postmortems (symptom, root cause, fix, rule). Entry #19 has the per-site throttles, entries #20 to #30 were added on 2026-10-31.
6. `STORYLINE.md`: the development story by phase, from the first commit on 2026-02-25 to the documentation pass of 2026-10-31.
7. `REVIEW-2026-09-13.md`: the code and security review that produced release 2.0.137 and the hardening of 2.0.139.

Install: `docs/HOWTO-USE.md` section 3 (from source on Linux, macOS or Windows, or the standalone binary). Upgrade: section 6 of the same file. The CLI has no self-update: an upgrade is a `git pull` and `npm install` in a checkout, or a new release binary whose sha256 is checked against `SHA256SUMS`. History: `STORYLINE.md` (the phases) and `CHANGELOG.md` (the versions). Never: commit cookies, logins, keys or tokens; push from a Windows share; edit the mirror clone of the two-clone rule (`AGENTS.md`); fetch a private-network URL unless `--allow-private-urls` is given on purpose.

## What it is

videodl-cli is a Node.js ES module with a `commander` command line front end (`src/cli.js`). It turns a page URL into a list of media formats through a site extractor, chooses a format, downloads it (direct HTTP, HLS through ffmpeg, DASH merge through ffmpeg, or through the CycleTLS helper for Cloudflare-protected CDNs), handles subtitles and chapters, and optionally converts the result.

Main features, each with the file that owns it:

- **47 native site extractors** (`src/extractors/*.js`, registry in `src/extractors/index.js`). The registry has 49 entries in total: the 47 site extractors, the yt-dlp fallback (`ytdlp.js`) and the direct-URL extractor (`direct.js`). The complete site list is in the table below.
- **Quality selection** (`-f best|worst|720p|1080p`, default `best`). A warning is printed when the requested height is not available.
- **Playlists and channels.** YouTube playlist and channel URLs are detected; each entry is downloaded into a sub-folder named after the playlist.
- **YouTube Premium formats.** With a Premium cookie file the Premium formats are preferred and the resolution is upgraded (README section "YouTube Premium Enhanced Bitrate" in the HOWTO, section 5.5).
- **DASH merge and HLS** through ffmpeg (`src/downloader.js`, `src/ffmpeg-helper.js`). ffmpeg is looked up on the PATH in-process; a static build is downloaded to `~/.videodl-cli/ffmpeg/` if none is found.
- **DRM detection** (`src/drm-detect.js`): Widevine, PlayReady, FairPlay, CENC and SAMPLE-AES streams stop with a clear message. Ordinary HLS AES-128 is not flagged.
- **Subtitles** (`resolveSubtitleDownloads` in `src/cli.js`): manual, automatic and auto-translated tracks, with per-language aliases and 429 pacing. The default is NO subtitles (see "Known gaps" below).
- **Chapters**: YouTube description timestamps and yt-dlp chapter lists are written as an ffmetadata file and merged with `-map_chapters`.
- **Cookies**: Netscape cookie files, browser-based login automation (Puppeteer), `browser-login` for a manual login, and expiry checks for YouTube.
- **CAPTCHA solving** for reCAPTCHA v2 through wit.ai (free) or 2captcha (paid).
- **Cloudflare bypass** through the CycleTLS Go helper (`src/cf-solver.js`, `src/cycletls-helper.js`) and, for one site, a curl subprocess.
- **Conversion**: `convert`, `dl-convert`, `probe`, `formats`, `codecs` (ffmpeg wrapper, `src/converter.js`).
- **Machine output**: `extract` and `download-json` print JSON for a backend (the container web UI).
- **Standalone binaries**: Node.js SEA builds with pinned Node and ffmpeg, plus a portable CJS bundle (`build.mjs`, `compile.sh`, `compile.ps1`).
- **Programmatic API**: `VideoDownloader`, `VideoConverter`, `extractVideoInfo` exported from `src/index.js`.
- **Smart file names**: `<title>-<domain>.<ext>` unless `-o` or `--no-base-url` is used.

## Security posture

The tool fetches whatever URL it is given and runs code that the sites send. The guards below are on by default. The smoke gate in `tests/smoke.py` has negative tests for the SSRF guard, the `-o` traversal and the solver sandbox. The reasons are in `REVIEW-2026-09-13.md` and `LESSONS-LEARNED.md` #18.

- **Private-network guard (SSRF)**, `src/url-guard.js`. Loopback, RFC 1918, link-local, CGNAT, multicast, reserved names (`localhost`, `*.local`, `*.internal`) and hosts that resolve to such addresses are refused. The check runs for the input URL, every media URL and every redirect. Only `http` and `https` are accepted. For a NAS on your LAN use `--allow-private-urls` or `VIDEODL_ALLOW_PRIVATE_URLS=1`.
- **Output confinement**, `resolveOutputFilename` in `src/cli.js`. `-o` may use `%(title)s`, `%(ext)s`, `%(id)s`, `%(extractor)s`, `%(quality)s` and sub-folders, but never `..` and never an absolute path.
- **Sandboxed YouTube challenge solver** (`src/solver-sandbox.js`, `src/solver-host.js`). The solver runs YouTube's player JavaScript in a child process of the same binary, under Node's permission model (no file system, no child processes, no workers). `VIDEODL_SOLVER_UNSANDBOXED=1` turns this off for debugging and prints a warning.
- **ffmpeg never gets `file:` in its protocol whitelist.** Playlists that must be passed in memory use `data:` URIs (`hlsPlaylistToDataUri`).
- **TLS is verified everywhere**, including the yt-dlp fallback. `--no-ssl-verify` disables it for one run.
- **Header values** have CR and LF removed before they reach ffmpeg.
- **Reproducible binaries**: Node.js (v22.22.2), ffmpeg (the BtbN release branch `n8.1.2`), the solver (`yt-dlp/ejs 0.8.0`) and every npm dependency are pinned with sha256 (`build-pins.json`, `src/vendor/ejs.lock.json`, `package-lock.json`). Each release ships `SHA256SUMS`.

## Supported sites

The table is the README copy of the support list. The 47 native extractors are listed; "yt-dlp fallback" and "direct URLs" are not native.

| Site | URL | Notes |
|------|-----|-------|
| YouTube | youtube.com, youtu.be | Full downloads up to 2160p (native client rotation + n/sig solving). Age-restricted or token-gated videos may answer 403; see [limitations](YOUTUBE-LIMITATIONS.md) |
| xHamster | xhamster.com | Full support |
| PornHub | pornhub.com | Full support. HLS CDN is chosen per page load; the mp4 list needs the page cookies (2.0.139). Per-quality throttle, see LESSONS #19 |
| XVideos | xvideos.com | Full support |
| XNXX | xnxx.com | Full support |
| YouPorn | youporn.com | HLS streaming |
| RedTube | redtube.com | Full support |
| Tube8 | tube8.com | Full support |
| Facebook | facebook.com, fb.watch | Full support |
| Vimeo | vimeo.com | Full support |
| Dailymotion | dailymotion.com, dai.ly | TLS fingerprint bypass (cycletls) |
| Twitch | twitch.tv, clips.twitch.tv | Clips and VODs |
| Reddit | reddit.com, v.redd.it | HLS adaptive streaming |
| Twitter/X | twitter.com, x.com | Via the fxtwitter API; some tweets may fail |
| TikTok | tiktok.com, vm.tiktok.com | May require cookies |
| Instagram | instagram.com | Requires cookies (posts, reels, IGTV) |
| Streamable | streamable.com | Full support |
| Rumble | rumble.com | Full support |
| Odysee | odysee.com | LBRY resolve API |
| 9GAG | 9gag.com | Video posts; TLS fingerprint bypass (cycletls) |
| SpankBang | spankbang.com | TLS fingerprint bypass (cycletls) |
| Eporner | eporner.com | XHR video API; several qualities including AV1 |
| Bitchute | bitchute.com | Limited; the SPA may need JavaScript rendering |
| Imgur | imgur.com | Video and gifv posts; limited SPA support |
| Indavideo | indavideo.hu | Full support |
| IndaEvents | indaevents.hu | Event pages (`/e/<event>`); resolves the IndaPlay or YouTube embed |
| IndaPlay | indaplay.hu, cms.indaplay.hu | PeerTube-backed; videos, embeds and whole channels as playlists |
| Videa | videa.hu, videakid.hu | Full support |
| Motherless | motherless.com | Full support |
| InPorn | inporn.com | Full support |
| TnaFlix | tnaflix.com, empflix.com | Full support |
| TubeSafari | tubesafari.com | xHamster embeds |
| PornOne | pornone.com | Full support |
| PornZog | pornzog.com | HClips embeds |
| UncensoredHentai | uncensoredhentai.xxx | Full support; JW Player caption tracks |
| HentaiHaven | hentaihaven.xxx | WordPress player-logic plugin, then HLS. Needs `curl` (the Cloudflare managed challenge blocks Node and cycletls TLS) |
| AShemaleTube | ashemaletube.com | HLS streaming, CycleTLS |
| Brazzers | brazzers.com | Requires cookies |
| KVS engine | blowjobs.pro, tgtsporn.com, hentaigem.com (the list `KVS_DOMAINS` in `src/extractors/kvs.js`) | Generic KVS engine (flashvars and license-code unscrambling) |
| Skool | skool.com | Classroom lessons (YouTube or Mux video) and community posts; needs a logged-in cookie for the real title |
| StreamIMDb | streamimdb.ru, vidapi.ru, vaplayer.ru (`/embed/` pages) | HLS variants; OpenSubtitles lookup by IMDb id |
| JustSwallows | justswallows.live | Embeds vtbe.to; the Vtbe host extractor does the work |
| Vtbe | vtbe.to | Host extractor, reusable by other tube sites |
| Erome | erome.com (album pages `/a/<id>`) | Native extractor |
| Bingato | bingato.com (item, search, category, model and tag pages) | Native extractor |
| Mat6tube | mat6tube.com (watch pages `/watch/<owner>_<video>`) | Native extractor |
| **yt-dlp** | **1000+ additional sites** | **Fallback; requires `yt-dlp` on the PATH** |
| Direct URLs | any `.mp4`, `.mkv`, `.webm`, `.m3u8` | Fallback extractor; rejects a `text/html` response |

> **yt-dlp fallback:** When no native extractor matches, the CLI delegates to yt-dlp if it is installed. Native extractors always come first. Without yt-dlp the fallback skips silently. In the container, yt-dlp is pre-installed.

## Current version and where it runs

| Item | Value | Recorded in |
|------|-------|-------------|
| CLI version | 2.0.139 (2026-10-03) | `package.json`, `CHANGELOG.md` top entry |
| Git tag | `v2.0.139` on 2026-10-03; 77 tags in total | `git tag` (the README used to say "last tag v2.0.99", outdated since 2026-10-03: tags v2.0.134, v2.0.136, v2.0.137 and v2.0.139 exist) |
| HEAD | `4ade70b` (2026-10-31 21:07 CET), the 2026-10-31 fleet audit commit, committed and pushed (the previous HEAD was `7ff739d`, 2026-10-14, the CRLF restore after `28946a3`) | `git log -1` |
| GitHub release assets | per release: `videodl-linux`, `videodl-ffmpeg-linux`, `videodl.exe`, `videodl-ffmpeg.exe`, `videodl-x86.exe`, the CycleTLS helpers, `SHA256SUMS`, `videodl.cjs` | the release page (not checked in the 2026-10-31 pass) |
| Container image | built by the sibling repository `videodl-container` (its `build.sh`), not by this repository | that repository's README |
| Node.js used to build | v22.22.2 (pinned in `build-pins.json`) | `build-pins.json` |
| Verified on 2026-10-31 | `node src/cli.js --version` = 2.0.139; `node src/cli.js extractors --json` = 49 entries; Linux `git status --short` = one untracked folder (`tests/__pycache__/`) and nothing else. The tracked symlink `.compile.unix.sh` is in HEAD and is not shown as a change | this pass, see `STORYLINE.md`, "Where it stands now" |

How to check the version on a machine:

```bash
videodl --version                 # or: node src/cli.js --version (from a checkout)
git -C <checkout> log --oneline -1
```

## Architecture

```
            user / backend (container web UI, scripts)
                         |
                  src/cli.js  (commander)
     download | dl-convert | convert | extract | download-json | generate-cookies | ...
          |                   |                         |
  src/extractors/index.js     |                 src/converter.js (ffmpeg wrapper)
  (47 native + ytdlp + direct) |
          |                   |
  extractVideoInfo() -> formats, subtitles, chapters, headers, cookies, DRM flag
          |
  src/downloader.js  (HTTP stream, HLS via ffmpeg, DASH merge via ffmpeg)
     |          |                |                      |
  url-guard.js  cf-solver.js   cycletls-helper.js     ffmpeg-helper.js
  (SSRF)        (curl / cycletls) (index helper binary) (PATH, or ~/.videodl-cli/ffmpeg)
          |
  solver-loader.js -> solver-sandbox.js (child, --permission) -> solver-host.js
                      (YouTube player JS, src/vendor/yt.solver.core.js)
  cookies.js, cookie-generator.js (Puppeteer), captcha-solver.js, drm-detect.js
```

Key points for a reader who changes the code:

- Every extractor is a class that extends `BaseExtractor` (`src/extractors/base.js`). `canHandle(url)` matches the hostname with `hostMatches()`, never a substring.
- The registry order matters: native extractors first, `YtdlpExtractor` second to last, `DirectExtractor` last.
- Output names go through `resolveOutputFilename()`; URLs that are fetched go through `assertPublicUrl()`.
- The binary is built with `build.mjs` (esbuild bundle, then Node SEA with postject). The CycleTLS helper is a separate Go executable that must sit next to the binary.
- Subtitle policy is in `resolveSubtitleDownloads()` and `parseRequestedLangs()` in `src/cli.js`. The default list is `DEFAULT_SUB_LANGS`, currently empty.
- There is no database and no server. State is the cookie file, the login file, the downloads folder and the ffmpeg cache.

## Commands (verified)

Run these from the checkout root, in a shell. On a Windows share, call scripts with `bash <script>`, because the executable bit can be lost when the file is copied through the share.

### Run the CLI from a checkout

```bash
node src/cli.js --version              # Verified 2026-10-31 on the build host (Node v22.22.2): 2.0.139
node src/cli.js extractors --json      # Verified 2026-10-31: 49 entries
node src/cli.js --help                 # Verified 2026-10-31: the full command list
node src/cli.js download --help        # Verified 2026-10-31: every download option
npm start -- download --list-formats "https://example.com/video"   # (not verified: needs network)
```

### Tests

```bash
npm test                               # runs: python3 tests/smoke.py --source (needs network) (not verified in the 2026-10-31 pass)
python3 tests/smoke.py --source --filter pornhub
python3 tests/smoke.py --binary dist/videodl-ffmpeg-linux
python3 tests/smoke.py --image ghcr.io/hemues/videodl:candidate     # podman run (container release gate)
python3 tests/smoke.py --deployed videodl                           # podman exec into the live container
```

### Build

```bash
npm run build                          # node build.mjs (host target)
bash compile.sh                        # Linux build; all targets; npm ci; checks build-pins.json
bash compile.sh --bundle-only          # CJS bundle only
bash compile.sh --no-ffmpeg            # binaries without the embedded ffmpeg
bash compile.sh --clean                # clean dist/ first
```

Windows: `.\compile.ps1` (add `-Linux` to cross-build the Linux binary, `-BundleOnly`, `-Clean`). Build outputs go to `dist/`, which is not tracked. (Not verified in the 2026-10-31 pass.)

### Upstream update pipeline (maintainer, build host only)

```bash
bash update-from-upstream.sh status
bash update-from-upstream.sh check
bash update-from-upstream.sh run --dry-run
```

The pipeline needs `/etc/videodl-upstream.env` (private, never in git; template `contrib/systemd/videodl-upstream.env.example`). Exit codes: 0 nothing to do or promoted, 3 human action required (client-table diff or a red gate, nothing deployed), 1 error. The weekly timer is `contrib/systemd/videodl-upstream-update.timer`. (Not verified in the 2026-10-31 pass.)

## Configuration reference

Every setting is a command line option or an environment variable. There is no config file. Full tables are in `docs/HOWTO-USE.md` section 4.

| Name | Default | Read in | Meaning | Change when |
| --- | --- | --- | --- | --- |
| `VIDEODL_ALLOW_PRIVATE_URLS` | unset | `src/cli.js`, `src/url-guard.js` | `1` allows private and LAN URLs | downloading from your own LAN server |
| `VIDEODL_SOLVER_UNSANDBOXED` | unset | `src/solver-sandbox.js` | `1` runs the solver without the sandbox (warning printed) | debugging the solver only |
| `VIDEODL_CAPTCHA_PROVIDER` | `wit` | `src/captcha-solver.js`, `src/cookie-generator.js` | `wit` or `2captcha` | paid solver |
| `VIDEODL_CAPTCHA_API_KEY` | unset | the same files | solver key (secret, never in git) | CAPTCHA solving needed |
| `CAPTCHA_PROVIDER`, `CAPTCHA_API_KEY` | unset | the same files and `src/cli.js` | short forms of the two above (secret for the key) | legacy setups |
| `NODE_OPTIONS` | set by the CLI for its child only | `src/solver-sandbox.js` | carries `--permission` to the solver child | never set by hand |
| `LOCALAPPDATA`, `PROGRAMFILES` | system | `src/cli.js`, `src/cookie-extractors/brazzers/aylo.js` | browser search on Windows | a browser is not found |
| `PATH` | system | `src/cli.js`, `src/ffmpeg-helper.js` | ffmpeg, yt-dlp and helper lookup | a tool is not found |
| `-d/--directory` | `./downloads` | `src/cli.js` | output folder | every run that needs another folder |
| `--cookies` | `cookies/cookies.txt` | `src/cli.js`, `src/cookies.js` | Netscape cookie file (secret) | a different session |
| `--logins` | `logins/logins.txt` | `src/cookie-generator.js` | login lines `url::user::pass` (secret) | cookie generation |
| `--sub-lang` | none (no subtitles) | `src/cli.js` | subtitle codes or `all` | you want subtitles |
| `--sub-translate` | none | `src/cli.js` | one auto-translated track | you want a translation |
| `--no-sub-translate-missing` | off | `src/cli.js` | skip the `all` translate fill | `--sub-lang all` is too slow |
| `--audio-lang` | auto-detect | `src/cli.js` | audio track language or `all` | a multi-language video |
| `-f/--format` | `best` | `src/cli.js` | quality | a fixed height |
| `--proxy` | none | `src/cli.js`, `src/downloader.js` | HTTP or SOCKS proxy | a network needs it |
| `--no-ssl-verify` | verified | `src/cli.js` | TLS verification off for one run | never in scripts |

The bundled `contrib/systemd/videodl-upstream.env.example` lists the updater variables (checkout directories, deploy user, updater path, image name, state directory). Those values are host-specific and are not kept in this public repository.

## Upstream components and versions

The pins that matter for the build are in `build-pins.json` (Node.js, the BtbN ffmpeg release branch and its archive sha256) and in `src/vendor/ejs.lock.json` (the solver, `yt-dlp/ejs 0.8.0`). The npm tree is pinned by `package-lock.json`, and `compile.sh` installs it with `npm ci`. The yt-dlp Python package is pinned in the container repository, not here. The InnerTube client table in `src/extractors/youtube.js` is synced by hand (the pipeline reports the diff). Changing a pin is a deliberate act with a new sha256; see `BUILD.md`.

## Troubleshooting

Each entry has the exact text where the code has it. The full list with fixes is in `docs/HOWTO-USE.md` section 8.

### `ffmpeg not found. Please install ffmpeg and ensure it's in your PATH`
Cause: no ffmpeg on the PATH and the download did not run. Fix: install ffmpeg, or let videodl download a static build to `~/.videodl-cli/ffmpeg/` (first use).

### `points at a private/internal address (<host>); refusing. Use --allow-private-urls to override.`
Cause: the SSRF guard. Fix: `--allow-private-urls` for your own LAN host only.

### `Output filename "<name>" would escape the download directory <dir>`
Cause: `-o` contained `..` or resolved outside `-d`. Fix: plain file name in `-o`, folder in `-d`.

### `Found 0 formats` on PornHub, or `HTTP 410 Gone` for every quality
Cause: the CDN choice per page load and the missing session cookies (LESSONS #19). Fix: update to 2.0.139, load the page again, pass `--cookies`.

### `HTTP 429 Too Many Requests` on subtitles
Cause: the YouTube auto-translate endpoint throttles anonymous requests (LESSONS #29). Fix: `--cookies`, fewer languages.

### `HTTP 403 Forbidden` on a YouTube media URL
Cause: the InnerTube client table is out of date, or the video needs a PO token (LESSONS #14). Fix: the sync process, not a hand edit.

### `YouTube session expired - Premium formats unavailable`
Cause: the YouTube cookies expired. Fix: export the cookies again from a logged-in browser.

### `DRM-protected: <systems>`
Cause: the stream is DRM-protected. videodl does not decrypt it and will not. No fix exists on this side.

### `Executable not found` for SpankBang, 9GAG, Dailymotion or Bitchute
Cause: the CycleTLS helper (`index` or `index.exe`) is not next to the binary (quoted in the CHANGELOG 2.0.10 entry). Fix: copy the helper into the same folder.

### The downloaded video is only 4 seconds long
Cause: the ffmpeg master snapshot of release 2.0.136 (superseded on 2026-09-13). Fix: use the pinned release-branch ffmpeg; run the smoke gate on the binary (LESSONS #18 item 8).

### No subtitles were downloaded
Cause: the default is no subtitles (see "Known gaps"). Fix: `--sub-lang en,hu`.

## Release and deploy

The short version of the release flow, with the owner rules:

1. Bump `package.json`, the CHANGELOG heading and the `compile.sh` version (the commit `8078227` is an example of a version-only release commit).
2. Build and test: `bash compile.sh` (all targets), then `python3 tests/smoke.py --binary <binary>` on each binary you ship.
3. Create the GitHub release with the binaries and `SHA256SUMS`, using `gh` on the build host. Verify the uploaded asset by downloading it and running `--version`, because the version is baked in at build time (LESSONS #10, #11).
4. The container image is built by the sibling repository, which runs `tests/smoke.py --image` on the candidate and `--deployed` on the running container. Read that repository's README for the image steps.
5. The upstream pipeline (`update-from-upstream.sh`) builds, gates and, only when the gate is green, publishes a yt-dlp or solver update. It never edits the InnerTube client table; that stays a human decision.

Owner rules that apply here: uploads (git push, release creation) are made on the build host as root, which holds the GitHub CLI token. Never push from the Windows side of a network share (stale index). Nothing is deployed to production without the owner's word.

## Documentation map

| File | Purpose |
| --- | --- |
| `README.md` | This file: what the tool is, the current version, architecture, commands, configuration |
| `docs/HOWTO-USE.md` | Operator manual: install, every option, examples, troubleshooting, per-site limits |
| `AGENTS.md` | Rules and traps for anyone (human or agent) changing this repository |
| `CHANGELOG.md` | What changed in each version, newest first |
| `LESSONS-LEARNED.md` | Numbered postmortems: symptom, root cause, fix, rule |
| `STORYLINE.md` | The development story by phase, with commits and decisions |
| `REVIEW-2026-09-13.md` | Code and security review of 2026-09-13 |
| `UPDATE-FROM-YTDLP.md` | Runbook for the yt-dlp and solver update pipeline |
| `YOUTUBE-LIMITATIONS.md` | What YouTube downloads can and cannot do |
| `EXTRACTORS.md` | How extractors are built and how to add a site |
| `BUILD.md` | Build system internals (esbuild, SEA, pins) |
| `INSTALL.md`, `QUICKSTART.md`, `LINUX-GUIDE.md`, `STRUCTURE.md` | Older guides. They were kept as they are and were not re-checked against the code in the 2026-10-31 pass. Where they disagree with `docs/HOWTO-USE.md`, the HOWTO and the code win |
| `ADD-BASE-URL-FEATURE.md` | Details of `--no-base-url` |
| `LESSONS-LEARNED-GUIDE.md` | How the lessons file is written |

## Known gaps and open decisions (2026-10-31)

- **Subtitle default.** The code default is no subtitles (`DEFAULT_SUB_LANGS = []`, since commit `dbcea2e`, 2026-04-25). The help text partly says English and Hungarian is the default, and the old README did too. The owner must decide which is right; then the code, the help and the README are made to agree. LESSONS #21.
- **A tracked symlink.** `.compile.unix.sh` is a symlink (mode 120000) to `/tmp/compile.unix.sh`, committed by `41e066b` (2026-07-21). It should be removed in its own commit. LESSONS #23.
- **Executable bits.** Mode-only commits in 2026-03, 2026-04 and 2026-07 flipped the modes of most tracked files to 100755. Corrected 2026-10-31: "every tracked file is 100755" was already wrong at `7ff739d` (three files were 100644); at `4ade70b` 110 tracked files are 100755 and 5 are 100644 (`package-lock.json`, `src/drm-detect.js`, `src/extractors/hentaihaven.js`, `STORYLINE.md`, `docs/HOWTO-USE.md`, the last two created by the audit). A Windows checkout needs `git config core.fileMode false` to show the truth. LESSONS #24.
- **Old commits still contain the home-lab text** that commit `f9d8706` removed from the current tree. A history rewrite is an owner option, not an agent action. LESSONS #22.
- **CHANGELOG dates.** The 2.0.10 heading says 2026-07-17 and 2.0.30 says 2026-03-21, while the git dates are in March. LESSONS #30.
- **Outdated statements kept for the record.** "By default, English + Hungarian subtitles are downloaded" (outdated since 2026-04-25, commit `dbcea2e`: the default is none, pending the owner decision above). "45 site extractors" in the feature list (outdated since 2026-10-31: the registry has 47 native extractors). "last git tag v2.0.99" (outdated since 2026-10-03: see the version table). "update-from-ytdlp.sh" (outdated since 2026-09-13, commit `2b16a56`: the file is `update-from-upstream.sh`).
- **PO-token minting** for age-restricted videos is deferred. The reference code is in `contrib/po-token-provider.mjs`. LESSONS #14.
- **Two clones on the owner's network.** A second local clone of this repository exists on the build network. One clone is the working clone; the other is a mirror that must be pulled after every push and never edited. This note names no paths on purpose (public repository). LESSONS #22.

## License

[GPL-2.0](LICENSE)

## Credits

- [yt-dlp](https://github.com/yt-dlp/yt-dlp): CLI design inspiration, and the source of the fallback and the solver.
- [Video DownloadHelper](https://github.com/aclap-dev/vdhcoapp): architecture inspiration.
- [ffmpeg](https://ffmpeg.org/): media processing engine. The pinned build is from BtbN.
- [esbuild](https://esbuild.github.io/): JavaScript bundler.
- CycleTLS (Go helper binary): TLS fingerprint impersonation for the Cloudflare-protected and TLS-fingerprint-checked sites.
