# Updating videodl from yt-dlp — checker, pipeline, runbook

`update-from-upstream.sh` is the automated, **test-gated** update path. It answers one
question — *has yt-dlp (or its challenge solver) released something newer than what we
ship?* — and if so it downloads and verifies it, updates the source, rebuilds every
binary, publishes them, rebuilds the container on the new engine, publishes the image,
and puts it into production **only when the smoke gate is green**. If nothing changed,
it does nothing.

```
sudo -i
bash <checkout>/update-from-upstream.sh check
bash <checkout>/update-from-upstream.sh run       # the real thing
bash <checkout>/update-from-upstream.sh run --dry-run
bash <checkout>/update-from-upstream.sh status
```

**Configuration.** Everything host-specific — checkout directories, the deploy user, the
host's updater script, image name, state directory — is read from
`/etc/videodl-upstream.env` (template: `contrib/systemd/videodl-upstream.env.example`;
override the location with `VIDEODL_UPSTREAM_CONFIG`). Plain environment variables take
precedence over the file. This repository is public: those values must never be
committed here.

Exit codes: `0` nothing to do / promoted · `3` human action required (client-table
diff, or a red gate — nothing was deployed) · `1` error.

Reports: `/var/lib/videodl-upstream/reports/UPDATE-REPORT-<date>.md` plus the smoke
JSONs next to it.

A weekly timer (`contrib/systemd/videodl-upstream-update.{service,timer}`, Sunday
04:00 local) runs `run`. Install / disable:

```bash
install -m 600 contrib/systemd/videodl-upstream.env.example /etc/videodl-upstream.env && $EDITOR /etc/videodl-upstream.env
install -m 644 contrib/systemd/videodl-upstream-update.service contrib/systemd/videodl-upstream-update.timer /etc/systemd/system/ && systemctl daemon-reload
systemctl enable --now videodl-upstream-update.timer
systemctl list-timers videodl-upstream-update.timer
systemctl disable --now videodl-upstream-update.timer        # stop the automation
journalctl -u videodl-upstream-update.service -n 200           # last run's log
```

---

## What "from yt-dlp" means here — three components, three mechanisms

| | Component | Lives in | Update = | Automated? |
|---|-----------|----------|----------|------------|
| **A** | **yt-dlp Python package** — the fallback engine for 1000+ sites | **videodl-container** venv; pin in `requirements.in`, hash-locked `requirements.txt` | bump the pin, regenerate hashes, rebuild the image | yes |
| **B** | **Challenge solver** `yt.solver.core.js` (from `yt-dlp/ejs`) | `videodl-script/src/vendor/`, compiled into every CLI binary; pinned in `ejs.lock.json` | replace the file, update the lock, recompile all targets, then rebuild the container | yes |
| **C** | **InnerTube client table** | `videodl-script/src/extractors/youtube.js` | reconcile with yt-dlp's `_base.py` — judgement call (ANDROID_VR ≤ 1.65 pin, client order; `LESSONS-LEARNED.md #14`) | **no** — `check` prints a machine diff, a human edits |

Porting yt-dlp's Python extractors to ours automatically is not realistic and not
needed: A already covers those sites. `yt-dlp -U` inside the running container is not
an option either (pip-installed yt-dlp has no `-U`, it would be unverified, and the
updater deletes the image on every deploy).

## Propagation rule: every change ends in a **container** release

The container is the engine's only production home: it embeds the CLI binary at build
time and is the only place yt-dlp exists. So B and C are not "done" when the CLI is
released — the container must re-embed it. One component per run, CLI first:

```
A  requirements.in pin ─────────────────────────────► container candidate → gate → promote → deploy → verify
B  vendor solver → compile.sh (all CLI targets, release) ► container candidate → gate → promote → deploy → verify
C  check only → report (exit 3) → human edits youtube.js → commit → `run --component=ejs` style manual: bash compile.sh && cd ../videodl-container && bash build.sh
```

## What each stage does

**check** — pins vs upstream: yt-dlp (PyPI `info.version`; the GitHub tag keeps leading
zeros `2026.08.19`, PyPI normalises to `2026.8.19`), ejs latest release tag, and a
machine diff of `INNERTUBE_CLIENTS` name→`clientVersion` against ours.

**verify** — for A: yt-dlp's `SHA2-256SUMS` + `.sig` are fetched from the GitHub
release and verified with the project's GPG key (`public.key` in the yt-dlp repo); the
`requirements.txt` hashes come independently from PyPI, and `pip install
--require-hashes` enforces them at image build. For B: the asset is pinned by tag and its
sha256 recorded in `ejs.lock.json` (upstream publishes no checksum file).

**stage** — the one pin changes; `build.sh --tag <cli> --image=ghcr.io/hemues/videodl:candidate --no-push --no-release`
builds the candidate image (version already bumped and baked in).

**gate** — `tests/smoke.py --image …:candidate --expect-ytdlp <ver>`: fixed public
cases through the binary inside the image — extraction + expected extractor + minimum
formats, a smallest-format download with a media-header check, SSRF and `-o`
traversal negatives, and the solver-sandbox probe. Red → working trees reverted,
candidate image removed, report written, exit 3. Production untouched.

**promote** — `build.sh --promote=…:candidate --tag <cli> --no-increment`: retags the
*tested* image as `:latest` **and** `:vX.Y.Z`, pushes both, creates the GitHub release
(notes name the embedded CLI tag and the yt-dlp version). Commits + pushes the pin
change.

**deploy + verify** — pre-pull, rootless updater as `videodl`, then `tests/smoke.py
--deployed videodl` (through `podman exec`) including `yt-dlp --version` and the CLI
version. Red → **rollback** to the previous versioned tag (`:v<prev>` re-tagged as
`:latest`, pushed, redeployed).

## Reproducibility prerequisites (why "no harm" is achievable now)

A rebuild "for yt-dlp" used to also change Node, ffmpeg and every npm dependency. Since
2.0.136 all inputs are pinned and verified, so a rebuild reproduces the previous binary
except for the one deliberate change:

- `package-lock.json` committed, `compile.sh` uses `npm ci`
- `build-pins.json`: Node.js version + per-target sha256; BtbN ffmpeg tag + per-asset
  sha256 (`build.mjs` verifies before use)
- `src/vendor/ejs.lock.json`: solver tag + sha256 (`compile.sh` verifies)
- container: `requirements.txt` with `--hash` lines, `pip install --require-hashes`;
  Node in the builder stage pinned with `NODE_SHA256`
- every CLI release ships `SHA256SUMS`; `build.sh` verifies the assets it embeds

Bump a pin deliberately: edit the pin, put the new sha256 next to it, build, gate.

## Manual runbook for component C (client table)

1. `bash update-from-upstream.sh check` — read the `changed_versions` / `only_upstream`
   / `only_ours` diff.
2. Edit `src/extractors/youtube.js`: refresh `clientVersion`s; keep **`ANDROID_VR`
   first and pinned ≤ 1.65.x** (> 1.65 is SABR-only); no-token clients first, gvs-PO-token
   clients (`IOS`, `WEB`, `MWEB`) last; drop clients yt-dlp removed; keep
   `PO_TOKEN_REQUIRED_CLIENTS` accurate.
3. `python3 tests/smoke.py --source --filter youtube` must pass.
4. Commit (only your files — the repo has a CRLF-churn trap; see `AGENTS.md`), then
   `bash compile.sh` and `cd ../videodl-container && bash build.sh`, deploy with the
   rootless updater, and `python3 tests/smoke.py --deployed videodl --as-user <deploy-user> --uid <uid>`.

## Roles on the build host

| Task | Identity |
|------|----------|
| check / run / compile / build / gh / ghcr push | **root** (`sudo -i`) |
| the rootless container itself | the deploy user named in `/etc/videodl-upstream.env` (`DEPLOY_USER`) — the script `sudo`s to it for deploy and `--deployed` verification |

## Gotchas baked in

- The build host's Node must equal `build-pins.json` (`22.22.2`): the SEA blob format is
  version-specific. Bumping Node = bump the pin + host together.
- Scripts checked out on a network share may lose their exec bit: always `bash script.sh`.
- `run` refuses to start on a dirty or out-of-date `main` (only build-script version
  churn is tolerated) so it never commits someone else's half-done work.
- No 32-bit Windows ffmpeg or CycleTLS helper exists upstream: `win-x86` ships the plain
  binary only.
- Vimeo is marked `optional` in the smoke list because it changes often; add a case
  as `optional: true` first, promote it to gating once it has been stable for a while.
