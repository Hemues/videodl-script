# Building videodl Standalone Binaries

videodl ships as self-contained executables built with **esbuild + Node.js Single
Executable Applications (SEA)**. Since 2.0.136 the build is **multi-target, pinned and
integrity-checked**: every input (Node.js, ffmpeg, the challenge solver, every npm
dependency) is a fixed version with a recorded sha256, so two builds of the same commit
produce the same binaries and a rebuild for one deliberate change cannot silently pull
in another.

## Targets and outputs

| Target | Plain (ffmpeg downloaded on first use) | ffmpeg embedded | CycleTLS sidecar |
|--------|------------------------------------------|-----------------|------------------|
| `linux-x64`   | `videodl-linux`        | `videodl-ffmpeg-linux`        | `cycletls-index-linux` |
| `linux-arm64` | `videodl-linux-arm64`  | `videodl-ffmpeg-linux-arm64`  | `cycletls-index-linux-arm64` |
| `win-x64`     | `videodl.exe`          | `videodl-ffmpeg.exe`          | `cycletls-index-windows.exe` |
| `win-x86`     | `videodl-x86.exe`      | — (no 32-bit ffmpeg upstream) | — (no 32-bit helper upstream) |

Every release also carries `SHA256SUMS` over all assets; `videodl-container/build.sh`
verifies the assets it embeds against it. The CycleTLS Go helper must sit **next to**
the binary (same directory) for the TLS-impersonation extractors to work.

## Quick build

```bash
bash compile.sh                        # all targets, both variants, publish a GitHub release (build host, gh auth)
bash compile.sh --no-release           # same, but only into dist/ — no version bump, nothing uploaded
bash compile.sh --targets=host         # only this machine's target (fast dev loop)
bash compile.sh --targets=linux-x64,win-x64 --no-release
bash compile.sh --bundle-only          # dist/videodl.cjs only
bash compile.sh --clean                # wipe dist/ (incl. cached Node/ffmpeg inputs) first
node build.mjs --targets=all --package # the underlying builder, without version/release handling
```

On Windows, `compile.ps1` still builds the host target; for releases use the Linux
host — it cross-builds every target.

## Pinned inputs (`build-pins.json`, `src/vendor/ejs.lock.json`, `package-lock.json`)

- **Node.js** — one version for every target; `build.mjs` downloads
  `node-v<ver>-<target>.tar.xz|zip` from nodejs.org into `dist/node/<target>/`,
  verifies the sha256 from the pin, and extracts only the `node` binary. The **host
  must run the same Node version**: the SEA blob format is version-specific
  (`compile.sh` refuses otherwise; `VIDEODL_SKIP_NODE_VERSION_CHECK=1` overrides at
  your own risk).
- **ffmpeg** — BtbN dated `autobuild-…` tag + per-asset sha256 (master-branch `N-…`
  GPL builds). Cached in `dist/_ffmpeg/<target>/` with its hash.
- **Challenge solver** — `src/vendor/yt.solver.core.js` must hash to
  `ejs.lock.json` (`tag` + `sha256` of the yt-dlp/ejs release asset, LF line endings).
- **npm dependencies** — `package-lock.json` is committed; `compile.sh` runs `npm ci`.

Bumping a pin is a deliberate edit of the pin **and** its sha256 (from
`SHASUMS256.txt` / BtbN `checksums.sha256` / the ejs asset), followed by a build and
the smoke gate. `update-from-upstream.sh` does this for the solver automatically.

## How a target is built

1. `esbuild` bundles `src/cli.js` + dependencies into `dist/videodl.cjs` (CJS, target
   node18), embedding the solver source as a string constant and patching the
   `lazy-cache` proxy that breaks under SEA.
2. Per target: a SEA config is written (`useCodeCache` only for the host's own target
   — V8 code cache is platform-specific), the blob is generated with the host Node
   (`--experimental-sea-config`), and `postject` injects it into a copy of the target's
   pinned Node binary. The ffmpeg variant embeds `ffmpeg.bin` as a SEA asset.
3. `.exe` targets: postject runs without `--overwrite`; the nodejs.org signature is left
   as-is when building on Linux (`signtool` only exists on Windows) — the result runs
   like any unsigned executable.

## Testing a build

```bash
python3 tests/smoke.py --binary dist/videodl-ffmpeg-linux         # the gate, against a binary
python3 tests/smoke.py --source                                    # from this checkout
dist/videodl-ffmpeg-linux extractors                               # 48 extractors listed
echo '{"player":"","requests":[],"solverCode":"var jsc=function(){return {type:\"result\",responses:[]}}"}' \
  | NODE_OPTIONS=--permission dist/videodl-ffmpeg-linux __solve   # sandbox child answers JSON
```

Windows binaries built on Linux can be smoke-tested from a Windows machine that mounts
a network share (`python tests\smoke.py --binary <share>\dist\videodl-ffmpeg.exe`).

## Prerequisites (build host)

Node.js = the pinned version, npm, `tar`, `xz`, `unzip` (Windows targets), `sha256sum`,
`gh` (releases), ~2 GB free in `dist/` for cached inputs and outputs.

## Output sizes (approx.)

| | plain | ffmpeg-embedded |
|--|------|------------------|
| linux-x64 / arm64 | ~130 MB | ~270 MB |
| win-x64 | ~90 MB | ~200 MB |
| win-x86 | ~80 MB | — |

## Usage after build

```bash
# Linux
./dist/videodl-ffmpeg-linux download "https://…" -f 720p
sudo cp dist/videodl-ffmpeg-linux /usr/local/bin/videodl && sudo cp dist/index /usr/local/bin/index

# Windows
.\dist\videodl-ffmpeg.exe download "https://…" -f 720p    (keep index.exe next to it)
```
