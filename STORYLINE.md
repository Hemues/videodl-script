# Storyline: videodl-script (videodl-cli)

This document tells the development story of the `videodl-cli` repository in
phases, in time order. It is verbose on purpose. It explains what was built,
what went wrong, what was learned, and which decisions were taken and by whom.
Every date comes from git (author date, short form, local +0200 time) or from
the document that states it. Where a date is not known, the text says so.

Companion documents:

- `README.md` - what the tool is, how to install it, the current version.
- `AGENTS.md` - traps and rules for anyone who changes the code.
- `LESSONS-LEARNED.md` - numbered postmortems (symptom, root cause, fix, rule).
- `CHANGELOG.md` - what changed in each version.
- `docs/HOWTO-USE.md` - every command and option, with examples.
- `REVIEW-2026-09-13.md` - the code and security review of 2026-09-13.

Facts about the repository, checked on 2026-10-31 (CET):

- 91 commits on the `main` branch, first commit 2026-02-25, last commit
  2026-10-31 (`4ade70b`, the audit commit; 90 commits before it, the last of them `7ff739d` of 2026-10-14).
- 116 tracked files at HEAD (114 before the audit commit, plus `STORYLINE.md` and `docs/HOWTO-USE.md`).
- `package.json` version 2.0.139, `CHANGELOG.md` top entry 2.0.139 (2026-10-03).
- 77 git tags. The newest tags are `v2.0.134` (2026-09-06), `v2.0.136` and
  `v2.0.137` (2026-09-13) and `v2.0.139` (2026-10-03).
- The CLI reports `2.0.139` and lists 49 registry entries (47 native site
  extractors plus the yt-dlp fallback and the direct-URL extractor). Verified
  on 2026-10-31 on the build host with `node src/cli.js --version` and
  `node src/cli.js extractors --json` (Node v22.22.2).

## Summary

`videodl-cli` is a Node.js command line tool that downloads and converts online
video. It started on 2026-02-25 as an import of an existing package (the first
commit has 63 files and about 16,000 lines). Within two months it had a YouTube
extractor with Premium format selection, an embedded ffmpeg, and a compile step
that produces standalone binaries. In March 2026 the site list grew from about
21 to 35 extractors, and the CycleTLS helper became part of every binary. In
April 2026 subtitle handling, chapters and more sites were added, and the
project started keeping a LESSONS-LEARNED file. From May to July 2026 the work
was mostly site maintenance (Skool, YouTube client table, HentaiHaven, IndaPlay,
JustSwallows). On 2026-09-13 a code and security review produced a hardening
release (2.0.137) with a reproducible build, a smoke gate and an upstream update
pipeline. On 2026-10-03 PornHub was fixed (2.0.139). On 2026-10-13/14 a
documentation audit ran, and it converted two Markdown files to LF line endings
by mistake; a follow-up commit restored CRLF.

The project is the engine behind a separate container repository (a web UI and
a pod deployment, not in this repository). The container is documented in its
own repository. This repository does not build the container image.

## Timeline at a glance

| Phase | Dates (git author date) | Versions | One-line outcome |
| --- | --- | --- | --- |
| 1. Import and first working CLI | 2026-02-25 - 2026-03-19 | before 2.0.0 | Import, embedded ffmpeg, YouTube Premium formats, compile and upload scripts |
| 2. Site expansion and CycleTLS | 2026-03-20 - 2026-03-29 | 2.0.1 - 2.0.10 | 35 extractors, CycleTLS sidecar shipped with binaries, about 18 small fix commits on 2026-03-20 |
| 3. Lessons file and release process | 2026-04-06 - 2026-04-17 | 2.0.52 | LESSONS-LEARNED.md created, release artefacts moved to GitHub Releases |
| 4. Subtitle policy and new sites | 2026-04-23 - 2026-04-28 | 2.0.56 - 2.0.96 | Subtitle fallback chain, auto-translate, chapters, UncensoredHentai, StreamIMDb; a silent default change |
| 5. Skool series and Eporner | 2026-05-03 - 2026-05-10 | 2.0.97 - 2.0.112 | Eporner rewritten; nine Skool commits in one week |
| 6. Maintenance and yt-dlp sync | 2026-06-15 - 2026-07-21 | 2.0.121 - 2.0.139 (cumulative) | YouTube 403 fix, update tooling, HentaiHaven, KVS, JustSwallows, Vtbe; a sync commit with a symlink |
| 7. DRM detection and IndaPlay | 2026-08-03 - 2026-09-06 | cumulative | DRM pre-check (detect, never circumvent), IndaPlay and IndaEvents |
| 8. Security review and hardening | 2026-09-13 | 2.0.136 (superseded), 2.0.137 | Review document, SSRF guard, ffmpeg whitelist, sandboxed solver, pinned builds, smoke gate |
| 9. PornHub fix | 2026-10-03 | 2.0.139 | Shared cookie jar for PornHub HLS and mp4 lists |
| 10. Documentation audit and CRLF slip | 2026-10-13/14 | 2.0.139 | Audit commit with whole-file LF rewrite, then CRLF restored |
| 11. Verbose documentation pass | 2026-10-31 | 2.0.139 | This storyline, README, AGENTS, LESSONS-LEARNED, HOWTO-USE |

## Phase 1 - Import and first working CLI (2026-02-25 - 2026-03-19)

**Goal at the start.** A command line downloader that behaves like yt-dlp for
the video sites that the early commits target, with cookie support and format conversion. The first
commit imports a package of about 63 files and 16,266 lines. The commit subject
is "Add videodl-cli init package". The history does not show where the code came
from before that commit; the git history starts here.

**What was built.** The first two weeks added the basic download engine, the
HLS fix, and the first real extractor work:

- `94b8935` (2026-03-02) updated the YouTube extractor.
- `d2b2962` (2026-03-13) added the embedded ffmpeg feature, so a binary does
  not need ffmpeg on the PATH.
- `138d0e7` (2026-03-16) fixed an HLS playlist bug.
- `c479c34` (2026-03-17) fixed minor bugs.
- `342f3c2`, `42a5ee2` and `d68de42` (2026-03-18) fixed bugs and added download
  speed reporting. Three commits with the same subject: the work was saved
  three times while it was still moving.

The YouTube Premium feature came next on 2026-03-18, in five commits
(`4438e0c`, `420312d`, `0f71fb2` and two more). `420312d` changed nine files
with about 1,700 added lines. Premium support means: when the cookie file holds
a logged-in YouTube Premium session, the extractor prefers the "Premium" formats
and upgrades the requested resolution (for example 720p to 1080p Premium). The
rules are in the README section "YouTube Premium Enhanced Bitrate".

The compile and upload path was made easier on 2026-03-18 and 2026-03-19
(`bc3f2fd`, `441ad4c`). At that time the binaries were uploaded by hand. The
history does not say which step failed most often.

**What went wrong.** Nothing in the history shows a rollback in this phase.
The commit subjects are short and generic ("fixing minor bugs and adding
download speed"). This made later archaeology harder, and the later phases
added a rule that a subject must name the site or the symptom (LESSONS-LEARNED
entry #25).

**What was learned and decided.** The native extractors come first and the
yt-dlp fallback comes after them (the CHANGELOG entry 2.0.30 records this rule,
dated 2026-03-21). The YouTube Premium upgrade rule is described in the README
and implemented in the YouTube extractor.

**How the phase ended.** The phase ended with the first big site batch in the
next phase. No version number was written in the package during this phase
except the initial one.

**Key commits**

| Date | Commit | What |
| --- | --- | --- |
| 2026-02-25 | `def19e0` | Add videodl-cli init package (63 files) |
| 2026-03-13 | `d2b2962` | added ffmpeg embedded feature |
| 2026-03-18 | `420312d` | added yt premium feature (9 files) |
| 2026-03-19 | `441ad4c` | make the compile and upload easier |

## Phase 2 - Site expansion and the CycleTLS sidecar (2026-03-20 - 2026-03-29)

**Goal at the start.** Add the many video sites named in the early commits, and make
the Cloudflare-protected sites work. The package was at 2.0.0 and the goal was
2.0.1 with fourteen new extractors.

**What was built.** The main commit is `6d2cfe0` (2026-03-20, "feat: add 14
new site extractors, bump to v2.0.1"). It changed 79 files: about 2,650 added
lines and 1,355 removed lines. The new extractors were SpankBang, 9GAG,
Dailymotion, Bitchute, EroProfile, EPorner, 4tube, Fux, Fapster,
NoodleMagazine, HClips, HDSex, HotMovs and Voyeurhit (the CHANGELOG 2.0.10
entry lists them). Twitter/X came through the fxtwitter API. The site count went
from 21 to 35.

Four Cloudflare-related facts came out of this phase and are still true:

- CycleTLS (a Go helper that imitates a browser TLS fingerprint) is needed for
  some sites. The helper is a separate binary. In `c61c405` (2026-03-20) the
  build started to ship it next to the compiled binary. Before that fix a
  compiled binary failed with "Executable not found" for SpankBang, 9GAG,
  Dailymotion and Bitchute.
- The Dailymotion quality list was limited to 360p because the HLS parse failed
  silently without the helper. The fix made the warning visible and used the
  Dailymotion quality labels (`ed5ac11`).
- xHamster downloads looked stuck at 0 percent because HLS downloads emitted no
  progress events when the duration was unknown. `633f4bc` (2026-03-20) fixed the
  xHamster case, and the 2.0.10 entry describes the general fix: the ffmpeg
  log level changed and progress is always emitted.
- Some extractors returned no duration, so HLS progress stayed at 0 percent
  (2.0.10 added the duration to ten extractors).

**What went wrong.** The day of 2026-03-20 holds about 18 commits, many of them
titled "some minor fixes" with a few lines each (`9a209ba`, `02c4ac2`,
`25c4309`, `dbea660`, `bcbdece`, `63c6453`, `3f36ca8`, `03e0ac7`, and
`759a501` "some minor yt fixes"). This was the period of debugging extractors
one by one on real sites. The history contains the trial and error, but the
subjects do not say what was fixed. That is the reason for the subject rule in
LESSONS-LEARNED entry #25.

The same day shows a second problem: mode changes. The commits `dd8447e`
(77 files), `3d8bb90` (78 files), `7b3a169` (78 files) and `9a209ba` (78 files)
have no content change at all. The only change is the executable bit, from
100644 to 100755, on every file. The Windows side of the Samba share made the
files look executable, and the commits recorded that. LESSONS-LEARNED entry #24
describes the rule that followed.

The commit `dd8447e` subject says "added new sitest" (a typo), another sign of
the fast pace of that day.

**What was learned and decided.** The CHANGELOG 2.0.10 entry records the
CycleTLS sidecar as part of every binary, and the warnings on stderr for
extractor failures. The sidecar shipping is the fix for a binary that could not
run its own extractors.

**How the phase ended.** `3cbf412` (2026-03-29) updated `package.json`. The
CHANGELOG entry for 2.0.10 is the summary of the phase. Note: that entry has the
header date 2026-07-17, but the commits behind it are dated March 2026. The
header date is wrong; the git dates are used in this storyline.

**Key commits**

| Date | Commit | What |
| --- | --- | --- |
| 2026-03-20 | `6d2cfe0` | feat: add 14 new site extractors, bump to v2.0.1 (79 files) |
| 2026-03-20 | `c61c405` | fix: ship CycleTLS Go helper binary alongside SEA binary |
| 2026-03-20 | `633f4bc` | fix: xHamster HLS download stuck, no progress events emitted |
| 2026-03-20 | `ed5ac11` | fix: use Dailymotion quality labels instead of pixel height |
| 2026-03-20 | `dd8447e` | added new sitest (mode change on 77 files) |
| 2026-03-23 | `0fb5e72` ... `f45a7df` | six "add new site" commits in one day |

## Phase 3 - Lessons file and release process (2026-04-06 - 2026-04-17)

**Goal at the start.** Write down the lessons from the broken sites and the
broken builds, so the next session does not repeat them. The commit `8789c7b`
(2026-04-06) added `LESSONS-LEARNED.md`
with 188 lines. The file is the source of the numbered entries that this
storyline refers to (#1 to #19 at the end of this phase, and #20 onward since
the documentation pass).

**What was built.** Over 2026-04-17 the release process was written down and
the first lessons were verified against real builds:

- `1952897` documented the AShemaleTube embed change (LESSONS #9). The site
  moved from an inline `var sources` list to a single HLS master playlist.
- `7953e64` bumped the version to 2.0.52.
- `d4007d3` added a "Releases" section to the README and the release process
  lesson (LESSONS #10).
- `9363031` added LESSONS #11: the SEA binary must be built with the official
  Node.js binary. A distribution build of Node has no `NODE_SEA_FUSE` sentinel,
  and the error text is: `Could not find the sentinel NODE_SEA_FUSE_...`.

**What went wrong.** Committing binaries of 90 to 320 MB into git caused push
failures, because GitHub rejects files above 100 MB. The decision was to move the
binaries to GitHub Release assets and keep them out of git (LESSONS #10). A
second wrong assumption was that the distro Node could build the binaries; the
fix was the official Node binary, stored outside the repository.

**What was learned and decided.** Binaries are release assets, not repository
files. A release is verified by downloading the uploaded asset and running its
`--version`, because the version stamp is baked in at build time (LESSONS #11).
The release is made from the build host, where the GitHub CLI token belongs to
root (LESSONS #10).

**How the phase ended.** The phase ended at version 2.0.52 with the process
written down. Later phases used the same process, and the security phase (8)
changed the process to a gated pipeline.

**Key commits**

| Date | Commit | What |
| --- | --- | --- |
| 2026-04-06 | `8789c7b` | Add LESSONS-LEARNED.md (188 lines) |
| 2026-04-17 | `1952897` | docs: document AShemaleTube extractor fix and lessons learned |
| 2026-04-17 | `7953e64` | chore: bump version to 2.0.52 for release |
| 2026-04-17 | `9363031` | docs: add lesson #11 (SEA build requires official Node.js binary) |

## Phase 4 - Subtitle policy, chapters and new sites (2026-04-23 - 2026-04-28)

This is the busiest phase of the subtitle code and the phase with the most
policy changes. It is also where a silent default change happened.

**Goal at the start.** Match yt-dlp for subtitles (manual and automatic tracks,
both downloaded), then narrow the default to English and Hungarian. The goal of
the phase was a clear subtitle chain.

**What was built, in order.**

1. `d267c53` (2026-04-23, CHANGELOG 2.0.56, 15 files, about 1,100 lines
   changed): every detected subtitle track, manual and automatic, is downloaded
   and embedded by default. Manual tracks win over automatic ones for the same
   language. `--no-subtitles` disables the feature and `--no-subtitle` is kept as
   an alias.
2. `c02ecc1` and `326bb7b` (2026-04-23): two commits that removed throwaway symlinks. `326bb7b` removed `.compile.unix.sh`.
   The symlink came back in later commits (phase 6), see LESSONS #23.
3. `66d335c` (2026-04-23, CHANGELOG 2.0.58 and 2.0.63): the default became
   English and Hungarian with a chain: manual track, then automatic track, then
   YouTube's auto-translate, then skip. `--sub-lang` takes a comma-separated list
   or `all`. Language aliases count: `en-US`, `eng` count as English; `hu-HU`,
   `hun` count as Hungarian; a track whose name says "Magyar" counts as Hungarian.
4. `a8d5118` (2026-04-23, CHANGELOG 2.0.62): strict official, then automatic,
   then skip; name aliases; 429 pacing (400 ms between files, exponential
   backoff, up to six attempts, `Retry-After` honoured). YouTube's `&tlang=`
   auto-translate answers HTTP 429 to anonymous requests (LESSONS #29).
5. `d43a770` (2026-04-23, CHANGELOG 2.0.63): the auto-translate step is back in
   the chain and cookies plus browser-like headers are forwarded to the subtitle
   downloads. With cookies the translate URL succeeds.
6. `bb718e8` (2026-04-23, CHANGELOG 2.0.66): the default format became `best`
   (it was `default`, which preferred 720p). The commit also changed 88 files by
   mode only (100644 to 100755), see LESSONS #24.
7. `bc5dc0d` (2026-04-25): documentation for chapter embedding and the subtitle
   disposition fix (CHANGELOG 2.0.87). Chapters from the YouTube description and
   from yt-dlp's chapter list are written as an ffmetadata file. The disposition
   fix uses `-map 0` so that two subtitle tracks survive (LESSONS #12, #13).
8. `dbcea2e` (2026-04-25): see the silent default change below.
9. `3f3966a` (2026-04-27, CHANGELOG 2.0.87, 2.0.91, 2.0.93): UncensoredHentai
   extractor fixes (a PHPSESSID cookie jar and a decoy challenge div), VLC
   playback fix, chapters and subtitles for Cloudflare and direct downloads. The
   commit has 89 files: 88 of them carry a mode change (100644 to 100755), and
   about 380 lines of real content changed.
10. `1523801` (2026-04-28): subtitles for UncensoredHentai (JW Player caption
    tracks).
11. `4b94b18` (2026-04-28, CHANGELOG 2.0.96): StreamIMDb extractor (streamdata
    API and HLS variants) and OpenSubtitles lookup by IMDb id; gzip subtitle
    decompression.

**The silent default change (`dbcea2e`, 2026-04-25).** The commit subject is
"fix: use .mkv instead of .webm for VP9/AV1+Opus, truncate filenames to prevent
Windows MAX_PATH overflow". Its body is empty. In the same commit the constant
`DEFAULT_SUB_LANGS` in `src/cli.js` changed from `['en', 'hu']` to `[]`, and the
comment above it changed to say that an empty list disables subtitles. The
commit diff for `src/cli.js` is about 4,350 lines because the whole file also
changed line endings. Ignoring carriage returns, the real change is small, but
the default flip is in it. No CHANGELOG line records the change.

The effect is that the code and the `--help` text say "Default: none" for
`--sub-lang`, while the README section "Download with Subtitles" and the
CHANGELOG entries 2.0.56 to 2.0.63 still say that English and Hungarian are
downloaded by default. The README statement is therefore outdated since
2026-04-25. This is an open owner question: either the README is corrected to
the code, or the default is restored. The storyline does not decide it. See
LESSONS-LEARNED entry #21 and the open items at the end of this document.

**What went wrong.**

- The default change above was made without a commit message, without a
  CHANGELOG line and without a test. The documentation of the default stayed.
- The whole-file line-ending rewrite hid the real change in a 4,350-line diff.
- The subtitle chain had three rewrites in one day (`d267c53`, `66d335c`,
  `a8d5118`). Each rewrite kept a different default. A reader of one commit could
  not know the policy of the next.
- The YouTube translate endpoint rate-limited anonymous requests. The 429 pacing
  is the workaround (LESSONS #29).

**What was learned and decided.** The 2.0.58 CHANGELOG entry set English and
Hungarian as the default. The later removal of that default is not recorded as a
decision in the repository (no commit message, no CHANGELOG line). The lesson is
procedural: a default is a product decision and it needs its own commit and
CHANGELOG line.

**How the phase ended.** The phase ended with the UncensoredHentai and
StreamIMDb extractors (2.0.96) and with chapter embedding documented (2.0.87).

**Key commits**

| Date | Commit | What |
| --- | --- | --- |
| 2026-04-23 | `d267c53` | feat(subs): download all detected + auto-generated subtitles by default |
| 2026-04-23 | `66d335c` | feat(subs): default to en+hu with manual/ASR/translate fallback chain |
| 2026-04-23 | `a8d5118` | fix: strict official then ASR then skip subtitle fallback, 429 pacing |
| 2026-04-23 | `d43a770` | feat: auto-translate fallback with cookie forwarding for subtitle downloads |
| 2026-04-23 | `bb718e8` | feat(cli): default --format is now best (v2.0.66) |
| 2026-04-25 | `dbcea2e` | fix: use .mkv instead of .webm ... (silent default change to no subtitles) |
| 2026-04-27 | `3f3966a` | fix: UncensoredHentai extractor + VLC playback fix + chapters + subtitles |
| 2026-04-28 | `4b94b18` | feat: add StreamIMDb extractor with OpenSubtitles integration |

## Phase 5 - Skool series and Eporner (2026-05-03 - 2026-05-10)

**Goal at the start.** Support the Skool community platform (course lessons,
then community posts), and fix Eporner, whose old download links needed a login
for 1080p.

**What was built.** `14209bc` (2026-05-03, CHANGELOG 2.0.97) replaced the
Eporner dload-link scraping with the XHR video API. The new path reads the player
hash, computes the encoded hash and asks the XHR endpoint for direct CDN MP4 URLs
for every quality from 240p to 1080p. The old path had saved a 29 KB login page
as the "video" for 1080p.

The Skool work took nine commits in one week, which is the most intense series of
the repository:

- `a6ae043` (2026-05-09, 2.0.101): classroom lessons delegate to the YouTube
  extractor for the attached video.
- `c7cd723`: handle all skool.com URLs and throw a clear error for other pages.
- `bbb594a` (2.0.104): parse the `__NEXT_DATA__` blob; Mux playback id and
  short-lived playback token build a signed HLS URL.
- `400836e` (2.0.106): attach `Referer`, `Origin` and a browser User-Agent. Mux
  restricts playback by referrer; without the header ffmpeg got HTTP 403.
- `1570d9b` (2.0.108): build the title from the section breadcrumb, not from the
  first top-level course entry.
- `2378208` (2.0.110): include the classroom name at the root of the breadcrumb.
- `63730b5` (2.0.111): support community post URLs. The CHANGELOG says the tag
  `v2.0.111` had already been published for the 2.0.110 code, so the release went
  out as 2.0.112 to avoid a tag collision.

The same week the browser extension was changed to read cookies with
`chrome.cookies.getAll({url})` instead of `{domain: hostname}`. Parent-domain
cookies such as a `.skool.com` cookie were not sent before.

**What went wrong.** Each Skool release fixed one symptom of the previous one:
no video, then a 403, then a wrong title, then a missing classroom name. The
pattern is the one in LESSONS #27: the first fix looked at the page, but the
data sat in an embedded JSON blob, and a page fetched without the session
returned the placeholder title. The releases followed each other over two days
(2026-05-09 and 2026-05-10).

**What was learned.** Read the embedded JSON of a server-rendered site before
scraping its HTML. Attach the referrer that the CDN checks. The Skool support
lives in the native extractor, not in the yt-dlp fallback.

**How the phase ended.** At 2.0.112 the Skool extractor handled classroom
lessons and community posts, and the Eporner rewrite was in place.

**Key commits**

| Date | Commit | What |
| --- | --- | --- |
| 2026-05-03 | `14209bc` | fix(eporner): rewrite extractor to use XHR video API |
| 2026-05-09 | `a6ae043` | feat(skool): add classroom extractor with YouTube handoff |
| 2026-05-09 | `bbb594a` | fix(skool): parse __NEXT_DATA__ for title and Mux HLS video |
| 2026-05-10 | `400836e` | fix(skool): attach Referer/Origin/UA headers to Mux format |
| 2026-05-10 | `63730b5` | feat(skool): support community post URLs (v2.0.111) |

## Phase 6 - Maintenance and the yt-dlp sync (2026-06-15 - 2026-07-21)

**Goal at the start.** Keep the extractors working. The YouTube client table
drifted from yt-dlp's, so YouTube downloads failed with HTTP 403. The phase also
added a repeatable way to refresh the YouTube client table and ship it.

**What was built.**

- `f918561` (2026-06-15): a `CLAUDE.md` file that imports the project context for
  the coding assistant.
- `29548f8` (2026-06-18, "sync: local working-tree changes and AGENTS.md"): a
  small commit that saved uncommitted working-tree changes.
- `cfb9033` and `ee1bb83` (2026-07-05, CHANGELOG 2.0.121): the InnerTube client
  table was realigned with yt-dlp. `ANDROID_VR` became the primary client,
  pinned to `1.65.10`. The clients that need a PO token (`IOS`, `WEB`, `MWEB`)
  became the last resort, and two dead clients were removed. LESSONS #14 has the
  details.
- `e728ef4` and `6a27af5` (2026-07-06): the repeatable "update from yt-dlp"
  process, with a runbook and a script. The script was later renamed
  `update-from-upstream.sh` and grew into a full pipeline (phase 8).
- `d9f547a` and `fb0a31b` (2026-07-16): HentaiHaven extractor (a WordPress
  player plugin, Cloudflare managed challenge answered only to curl; LESSONS #15)
  and hentaigem.com added to the KVS engine.
- `795a06f` (2026-07-19): the InnerTube client versions were synced again.
- `bd93477` (2026-07-21): JustSwallows and Vtbe extractors. JustSwallows is a
  WordPress site that embeds `vtbe.to`. Vtbe is a reusable host extractor for any
  site that embeds it.
- `41e066b` (2026-07-21, "Sync working changes"): a sync commit of 89 files. 87 of
  them were mode-only changes. The commit also committed an accidental symlink
  `.compile.unix.sh` that points to a file under `/tmp` on the build host (git
  mode 120000). The symlink is still tracked at HEAD (LESSONS #23).

**What went wrong.**

- The YouTube 403 was caused by a client that now needs a PO token and by a
  client version that returns SABR-only responses. The first fix was a guess;
  the second fix came from comparing the table with yt-dlp's `INNERTUBE_CLIENTS`.
- The PO-token minter (bgutils-js with jsdom) worked under real Node but could
  not survive the SEA bundle. The decision was to defer it and keep the reference
  file in `contrib/po-token-provider.mjs` (LESSONS #14, phase 6).
- The sync commit `41e066b` committed the symlink and the mode flips at once.
  The symlink points to `/tmp/compile.unix.sh`, a file that exists on no
  checkout, so it is a dangling link everywhere it is checked out. On Windows it
  shows as deleted (LESSONS #23).

**What was learned and decided.** The client table is kept in sync with
yt-dlp, and the change is a human decision, not an automatic one (the pipeline
reports the diff; it does not edit the table). LESSONS #14 records the decision
that the PO-token minter must be a separate process, not part of the binary.

**How the phase ended.** The version number moved to 2.0.139 as a cumulative
number. The CHANGELOG has no separate headings for the releases between 2.0.121
and 2.0.139; the 2.0.139 block carries those changes (see phase 7 and 8).

**Key commits**

| Date | Commit | What |
| --- | --- | --- |
| 2026-07-05 | `cfb9033` | youtube: realign InnerTube client table with yt-dlp (fix CDN 403) |
| 2026-07-06 | `e728ef4` | tooling: add repeatable "update from yt-dlp" process |
| 2026-07-16 | `d9f547a` | hentaihaven: add extractor for hentaihaven.xxx |
| 2026-07-21 | `bd93477` | Add JustSwallows + Vtbe extractors |
| 2026-07-21 | `41e066b` | Sync working changes (symlink and 87 mode flips) |

## Phase 7 - DRM detection and IndaPlay (2026-08-03 - 2026-09-06)

**Goal at the start.** Two new kinds of work: a clear message when a stream is
DRM-protected, and support for the Hungarian IndaEvents platform.

**What was built.**

- `30b838b` (2026-08-03): DRM detection. HLS and DASH manifests are scanned for
  Widevine, PlayReady, FairPlay, generic CENC and `SAMPLE-AES` before the download
  starts. A protected stream stops with a clear message. The feature only
  reports; it never decrypts. Ordinary HLS AES-128 is not flagged (LESSONS #16).
  The README and LESSONS #16 state that the tool must not circumvent DRM.
- `53edb2b` (2026-09-06): IndaPlay and IndaEvents extractors. IndaEvents event
  pages embed IndaPlay, and IndaPlay is a PeerTube instance behind a Next.js
  portal. The extractor uses the PeerTube API. Four traps were found and worked
  around (LESSONS #17): a soft 404 answered with HTTP 200, a page with many videos
  where the wanted one is not first, an embed endpoint that returns HTTP 500 for
  valid videos, and an API that returns `http://...:443` URLs.

**What went wrong.** The first IndaPlay reading was wrong. The portal served
gzip data regardless of the Accept-Encoding header, and a grep over compressed
bytes said "no video markers". The file size gave the clue: 405 KB against a
4.7 MB original. LESSONS #17 (method note) records it.

**What was learned and decided.** Fingerprint the host before writing an
adapter. Identify the CMS first, then write the smallest adapter that uses its
documented API.

**How the phase ended.** Both features were in the working tree until the
security phase, which released them as part of 2.0.139.

**Key commits**

| Date | Commit | What |
| --- | --- | --- |
| 2026-08-03 | `30b838b` | drm: detect DRM-protected HLS/DASH streams and refuse with a clear message |
| 2026-09-06 | `53edb2b` | Add IndaPlay + IndaEvents extractors (indaevents.hu -> indaplay.hu PeerTube) |

## Phase 8 - Security review and hardening (2026-09-13)

This phase is the largest change in the repository. It happened in one day.

**Goal at the start.** A code and security review of both
repositories (the CLI and the container around it), and updates from yt-dlp
that are tested before they ship.

**What was built.**

- `98d4075` added `REVIEW-2026-09-13.md`: prioritised findings, three High items
  (ffmpeg `file:` in the protocol whitelist for remote HLS; a `custom_name_prefix`
  path traversal and an unexpanded `%(title)s` template; in-process execution of
  YouTube's player JavaScript), Medium and Low items, and the design for a
  test-gated update pipeline.
- `2b16a56` (31 files, about 7,060 lines added): the hardening itself. The fixes
  are listed in CHANGELOG 2.0.139, section Security: `file:` removed from the
  ffmpeg whitelist, local playlists passed as `data:` URIs; `-o` output confined
  to the download directory and templates expanded; the YouTube solver run in a
  child process under Node's permission model; an SSRF guard for private and
  reserved addresses (with `--allow-private-urls` as the explicit opt-out); the
  yt-dlp fallback no longer disables TLS verification; CR and LF stripped from
  header values; `text/html` refused as a direct download.
- Reproducible builds: `package-lock.json` committed, `npm ci` in `compile.sh`,
  Node and ffmpeg pinned with sha256 in `build-pins.json`, the solver pinned in
  `src/vendor/ejs.lock.json`, and every release ships `SHA256SUMS`.
- `tests/smoke.py` and `tests/smoke-urls.json`: the acceptance gate. It runs the
  public CLI entry point of the artefact under test (source, binary, image or the
  deployed container).
- `update-from-upstream.sh` and its systemd timer (weekly): detects new yt-dlp
  and solver releases, rebuilds, tests the candidate image and promotes only a
  green one. Host-specific values are read from a private environment file, not
  from the repository.
- `3711b97` (release state for 2.0.136), `fa6b82f` (ffmpeg pinned to the 8.1
  release branch; system ffmpeg found without `which`; a size floor in the smoke
  probe) and `062680a` (release 2.0.137 version bump).
- `e96edca`: the build retries input downloads (four attempts with backoff),
  because a transient "socket hang up" on a 250 MB archive had broken a release.
- `f9d8706` (2026-09-13): the public repository lost its home-lab details. Host
  address, share paths, user names, the updater path and a password-file remark
  were removed from the docs and the scripts. Older commits still contain the
  text; a history rewrite was offered as an owner option and not done (LESSONS #22).

**What went wrong.**

- Release 2.0.136 passed every case of the gate, but it truncated byte-range HLS
  downloads silently. The cause was the BtbN master snapshot of ffmpeg, which
  reads the segments and writes only the first 4 seconds and exits 0. The release
  was superseded the same day by 2.0.137. The tag `v2.0.136` still exists. The
  rule is in AGENTS.md ("never embed 2.0.136") and LESSONS #18 item 8.
- The gate itself had a blind spot: a "valid header, non-trivial size" check
  accepted a 0.3 MB probe file. The fix pins a minimum byte count per case.
- The system ffmpeg was invisible in the container, because the base image does
  not ship `which`. The container silently used the embedded ffmpeg. Same binary,
  different environment, different result (LESSONS #18 item 8c).
- A Windows-side `subprocess` decoded UTF-8 output as cp1252 and raised inside a
  reader thread (LESSONS #18 item 4).

**What was learned and decided.** A release is judged by the artefact that
ships. A green run from source proves the code; only a green run of the image or
the binary proves the release (LESSONS #18 item 7). Pins are a security control,
not a convenience (item 6). The release branch of a fast upstream is pinned, not
its master (item 8a).

**How the phase ended.** 2.0.137 was tagged on 2026-09-13. The `v2.0.137` tag
and the CHANGELOG 2.0.139 Security section record the findings and their fixes.

**Key commits**

| Date | Commit | What |
| --- | --- | --- |
| 2026-09-13 | `98d4075` | docs: code + security review of both repos, and the test-gated yt-dlp update design |
| 2026-09-13 | `2b16a56` | Security hardening, reproducible multi-target builds, smoke gate, upstream update pipeline |
| 2026-09-13 | `3711b97` | Release 2.0.136 state (superseded the same day) |
| 2026-09-13 | `fa6b82f` | Pin ffmpeg to the 8.1 release branch, find system ffmpeg without `which` |
| 2026-09-13 | `062680a` | Release 2.0.137 (compile.sh version bump) |
| 2026-09-13 | `e96edca` | build.mjs: retry input downloads (4 attempts, backoff) |
| 2026-09-13 | `f9d8706` | Remove home-lab topology from this public repository |

## Phase 9 - PornHub fix (2026-10-03)

**Goal at the start.** PornHub downloads said "Found 0 formats" for about two
page loads out of three, with HLS `410 Gone` errors for every quality.

**What was built.** `1c5cbd5` (2026-10-03, CHANGELOG 2.0.139): one cookie jar per
extraction, shared by the watch page, the HLS requests and the `get_media`
request. The progressive mp4 list (240p to 1080p) is now always found. HLS still
comes first at equal height when its CDN answers. `5af68e3` (same day) documented
the per-quality throttle: 240p, 480p and 720p at `rate=500k`, 1080p at
`rate=50000k`, per connection. Measured: about 0.65 MB/s on one connection and
4.9 MB/s with eight parallel ranges. LESSONS #19 has the numbers and the rule that
the chunked downloader is sequential, so it does not help here.

`8078227` (same day) bumped the version to 2.0.139. The tag `v2.0.139` was created
the same day, and the CHANGELOG heading `[Unreleased]` was replaced by the version
during the audit of phase 10.

**What went wrong.** The root cause was two independent problems. The CDN is
picked per page load, and the mp4 fallback needs the session cookies. Each one
alone looked like a flaky site. The first commit to fix the problem was the
cookie change; the CDN choice cannot be controlled, so the extractor uses the
mp4 list as the dependable path.

**What was learned.** A page-level `[]` from an endpoint that "works" means
missing session state, not a site change (AGENTS.md, extractor gotchas). Retrying
the same URL never recovers from the per-page CDN choice; a new page load can
(LESSONS #19).

**Key commits**

| Date | Commit | What |
| --- | --- | --- |
| 2026-10-03 | `1c5cbd5` | pornhub: keep the watch-page cookies so get_media returns the mp4 list |
| 2026-10-03 | `8078227` | Release 2.0.139 (compile.sh version bump) |
| 2026-10-03 | `5af68e3` | docs: PornHub mp4 throttle is per quality and per connection (LESSONS #19) |

## Phase 10 - Documentation audit and the CRLF slip (2026-10-13/14)

**Goal at the start.** A documentation audit of every repository in the fleet,
so that a less capable model with no session memory can continue each project
from its repository alone. The audit wrote a "Start here" block, updated the
version line and the CHANGELOG heading, and corrected the build location (the
container image is built by the separate container repository, not here).

**What was built.** `28946a3` (author date 2026-10-14 00:13 +0200; the commit
text says "2026-10-13 audit"): the version line, the reading order, the
CHANGELOG heading, and the note that `build.sh` lives in the container
repository. The commit wrote README.md and CHANGELOG.md with LF line endings.
Both files had been CRLF at HEAD~1. The diff is 1,295 added and 1,291 removed
lines, most of them the line endings.

`7ff739d` (2026-10-14 00:13:57 +0200): restored CRLF in both files. The commit
message says "content unchanged". Its diff is 1,295 lines in each direction.

**What went wrong.** The audit edit went through a tool that writes LF on a
share that expects CRLF. The first commit did not check the line endings, and
the second commit repaired the damage. The audit commit also recorded the
Windows-side view of the worktree, where mode flips and CRLF look like changes,
which the audit text says was not the Linux truth. LESSONS #20 is the entry for
this slip.

**What was learned and decided.** Line endings are checked by counting carriage
returns on both sides before a commit. For this repository, at HEAD in
October 2026, README.md, LESSONS-LEARNED.md and CHANGELOG.md are CRLF, while
AGENTS.md and every code file are LF. The rule is written into AGENTS.md.

**How the phase ended.** HEAD is `7ff739d`. The worktree on the Linux side has one
untracked directory (`tests/__pycache__/`) and the symlink `.compile.unix.sh` is
still tracked. The Windows side shows the symlink as deleted (a symlink cannot
be followed there).

**Key commits**

| Date | Commit | What |
| --- | --- | --- |
| 2026-10-14 | `28946a3` | docs: 2026-10-13 audit - current version 2.0.139, Start here, CHANGELOG heading |
| 2026-10-14 | `7ff739d` | docs: restore the CRLF line endings the previous commit converted to LF |

## Phase 11 - Verbose documentation pass (2026-10-31)

**Goal at the start.** The owner asked for documentation that is verbose enough
for a local model to continue the project from the repository alone: a README
with every operating fact, a HOWTO with every option, a STORYLINE with the
phases, and a LESSONS-LEARNED that records every incident, including the ones
that were only in the git history.

**What was done.** This storyline was written from the git history (90 commits),
from the CHANGELOG, from the code (`src/cli.js`, `src/extractors/index.js`,
`tests/smoke.py`, `compile.sh`, `build.mjs`, `update-from-upstream.sh`) and from
the existing README, AGENTS and LESSONS-LEARNED. The README was rewritten with
every existing fact kept. `docs/HOWTO-USE.md` is new. AGENTS.md got its missing
sections. LESSONS-LEARNED.md got an index and entries #20 onward.

**What was checked on 2026-10-31.** `node src/cli.js --version` printed 2.0.139
and `node src/cli.js extractors --json` listed 49 entries, both on the build host
with Node v22.22.2. The Linux-side `git status` showed one untracked directory
and no other change. The smoke gate (`python3 tests/smoke.py --source`) needs the
network and was not run in this pass.

**What was not done.** The commits were not made in this pass. (Outdated since 2026-10-31 21:07 CET: the audit was committed as `4ade70b` and pushed to GitHub.) No file was pushed in this pass. No release was tagged. The history was not rewritten. The subtitle
default and the symlink were left for the owner.

## Where it stands now (2026-10-31, CET)

- Version 2.0.139 in `package.json`, the CHANGELOG top entry and the CLI output.
- HEAD `4ade70b` (2026-10-31 21:07 CET, pushed), tag `v2.0.139` on 2026-10-03, 77 tags in total.
- The container image around this CLI is built by the separate container
  repository. The image state is recorded there, not here.
- Open owner decisions and known gaps:
  1. Subtitle default: the code says none (since `dbcea2e`, 2026-04-25); the
     README says English and Hungarian. Decide which is right and make the other
     match (LESSONS #21).
  2. The symlink `.compile.unix.sh` (mode 120000 to `/tmp/compile.unix.sh`) is
     still tracked. Remove it in its own commit (LESSONS #23).
  3. Mode bits: 110 tracked files are 100755 and 5 are 100644 at HEAD (the earlier wording "every tracked file is 100755" was already wrong at `7ff739d`). Decide whether that is
     wanted; the Windows side needs `core.fileMode=false` to show the truth
     (LESSONS #24).
  4. Old commits still carry the home-lab text removed on 2026-09-13. A history
     rewrite is an owner option, not an agent action (LESSONS #22).
  5. The yt-dlp PO-token minter stays deferred (LESSONS #14).
  6. The CHANGELOG header dates for 2.0.10 (2026-07-17) and 2.0.30 (2026-03-21
     with 2.0.10 below it) are out of order and should be corrected by the owner
     (LESSONS #30).
- Next planned phase: none is written down. The next work is driven by site
  breakage reports. The rule for them is in AGENTS.md and LESSONS-LEARNED.md.
