# Update videodl-cli from yt-dlp — Runbook

Repeatable process for when YouTube starts failing (403s, extraction breakage,
new client requirements) and we need to re-sync `videodl-cli`'s YouTube handling
with upstream **yt-dlp**, rebuild the binary, publish it, and roll it into the
`videodl-container` on Blathy-server (11.1.0.2).

The mechanical steps are automated by [`update-from-ytdlp.sh`](./update-from-ytdlp.sh).

---

## The pipeline at a glance

```
edit youtube.js  →  smoke-test (source)  →  compile.sh (publish CLI binary to GitHub)
       │                                            │
       └── commit + push source (you)               ▼
                                    container build.sh (embed CLI → ghcr:latest + release)
                                                     │
                                                     ▼
                                    deploy (rootless updater)  →  verify with a real video
```

`videodl-cli` (Hemues/videodl-script) compiles to a Node **SEA** binary
(`videodl-ffmpeg-linux`) published as a GitHub Release asset. The container
(Hemues/videodl-container) **embeds** that asset at build time (`gh release
download`), pushes `ghcr.io/hemues/videodl:latest`, and the rootless updater on
11.1.0.2 pulls + runs it.

## Roles — don't mix them (on 11.1.0.2)

| Task | Identity |
|------|----------|
| build / compile / `gh` / `podman build` / push | **root** (`sudo -i`) — gh & ghcr auth are root-only |
| deploy the rootless container | the **`videodl`** user (`sudo -iu videodl …`) |

Both repos live on the Samba share (`/storage/Samba/Temp/git`, == `Z:` on Windows)
and **share one version sequence** (build scripts take the highest release across
both repos + 1).

---

## Step 1 — See what changed in yt-dlp

```bash
sudo -i
cd /storage/Samba/Temp/git/scripts/videodl-script
./update-from-ytdlp.sh check
```

This fetches yt-dlp's `youtube/_base.py` + `_video.py` from master and prints its
current `INNERTUBE_CLIENTS` (client names, `clientVersion`s, gvs-PO-token
policies, default clients) next to ours for eyeballing.

## Step 2 — Edit `src/extractors/youtube.js`

Update the `INNERTUBE_CLIENTS` table + `PO_TOKEN_REQUIRED_CLIENTS` set to match.
Rules of thumb (see `LESSONS-LEARNED.md #14`):

- **`ANDROID_VR` stays FIRST and pinned `<= 1.65.x`** — versions `> 1.65` return
  **SABR-only** responses (`serverAbrStreamingUrl`, no plain `url`) we can't
  download. It needs no PO token and no player-JS → best default.
- Order: **no-token clients first** (`ANDROID_VR`, `TV`, `WEB_EMBEDDED`), then
  authenticated (`WEB_CREATOR`), then **gvs-PO-token-required last**
  (`IOS`, `WEB`, `MWEB`) — these 403 at the CDN without a minted token.
- **Refresh `clientVersion` strings** to yt-dlp's current values.
- **Remove clients yt-dlp dropped** (e.g. `TV_EMBEDDED`, `MEDIA_CONNECT`).
- Keep `PO_TOKEN_REQUIRED_CLIENTS` accurate if a client's gvs policy changes.

> Age-restricted / token-gated videos need a **gvs PO token** — minting is
> **deferred** (jsdom can't bundle into the SEA). The proven minter lives at
> `contrib/po-token-provider.mjs`; the intended home is an external sidecar
> provider. See `LESSONS-LEARNED.md #14`.

## Step 3 — Commit the source (manual — CRLF trap)

The repo has a Windows/Samba **CRLF-churn** trap: nearly every tracked file shows
as modified. Commit **only** your real changes, matching each file's HEAD line
endings so the diff stays minimal:

```bash
cd /storage/Samba/Temp/git/scripts/videodl-script
# youtube.js is LF in HEAD; most docs are CRLF. If you touched a CRLF doc:
#   sed -i 's/\r$//' FILE && sed -i 's/$/\r/' FILE   # normalize back to CRLF
git add src/extractors/youtube.js CHANGELOG.md
git diff --cached --stat        # sanity: only YOUR files, small diffs
git commit -m "youtube: sync InnerTube client table with yt-dlp"
git push origin HEAD
```

## Step 4 — Ship it (one command)

```bash
./update-from-ytdlp.sh ship
```

Which runs: source smoke-test (aborts if it still 403s) → `compile.sh` (build +
publish `videodl-ffmpeg-linux` release) → container `build.sh` (embed CLI, push
`ghcr:latest`, cut a container release) → pre-pull + rootless updater → verify
the **deployed** binary extracts the test video with no 403.

Options: `--skip-deploy` (build/publish only), `--test-url=<url>`.

## Gotchas / lessons baked in

- **Build with the official Node.js binary** (compile.sh already does): Fedora's
  packaged Node **SIGSEGVs** `ng build`/SEA (see container `LESSONS-LEARNED.md #15`
  and this repo's #11).
- **`gh` auth + `podman login ghcr.io` are root-only.** Deploy is rootless.
- **YouTube changes constantly.** Re-run `check` each time — don't assume last
  cycle's versions still work.
- The n-sig / signatureCipher solver (`vendor/yt.solver.core.js`) tracks
  YouTube's player JS; if extraction (not just download) breaks, that solver may
  need updating too, independent of the client table.
