#!/usr/bin/env python3
"""
videodl smoke / acceptance gate.

Runs tests/smoke-urls.json against ONE artefact, always through its public CLI entry
point (never a copy of the code), and exits non-zero if any non-optional case fails.

    python3 tests/smoke.py --source                          # node src/cli.js (dev)
    python3 tests/smoke.py --binary dist/videodl-ffmpeg-linux
    python3 tests/smoke.py --image ghcr.io/hemues/videodl:candidate      # podman run
    python3 tests/smoke.py --deployed videodl [--as-user videodl --uid 10019]  # podman exec
    python3 tests/smoke.py ... --filter indaplay             # only cases whose name contains
    python3 tests/smoke.py ... --json report.json            # machine-readable result

Case types:
  extract     (default) `extract <url>` → status ok, expected extractor, ≥ minFormats;
              with "probe": also `download -f worst` and verify the file is real media
  expectError run the command and require a non-zero exit whose output contains the text
  sandbox     feed a probe payload to `__solve` under NODE_OPTIONS=--permission and
              require ERR_ACCESS_DENIED (proves the solver sandbox is active)

Only the standard library is used so it runs on the build host as-is.
"""

import argparse
import fnmatch
import json
import os
import shlex
import subprocess
import sys
import tempfile
import time
from pathlib import Path

# abspath, NOT resolve(): on a mapped network drive Path.resolve() rewrites Z:\… to its
# UNC form, and Node's permission model only accepts the drive-letter form (same case)
# as an --allow-fs-read grant for the source-mode sandbox child.
HERE = Path(os.path.abspath(__file__)).parent
DEFAULT_CASES = HERE / 'smoke-urls.json'
CLI_IN_IMAGE = '/videodl-cli/videodl-ffmpeg'
YTDLP_IN_IMAGE = '/opt/venv/bin/yt-dlp'

SANDBOX_PAYLOAD = {
    'player': '',
    'requests': [],
    # A "solver" that tries to read a file the way real player code could — via the
    # process global (no `require` in scope). Under --permission this must throw.
    'solverCode': (
        "var jsc = function(input){"
        "  try { process.getBuiltinModule('fs').readFileSync('/etc/passwd');"
        "        return {type:'result', responses:[{type:'result', data:{sandbox:'FS_READABLE'}}]}; }"
        "  catch (e) { return {type:'result', responses:[{type:'result', data:{sandbox: e && e.code ? e.code : String(e)}}]}; }"
        "};"
    ),
}


class Runner:
    """Builds argv prefixes for the artefact under test."""

    def __init__(self, mode, ref, as_user=None, uid=None):
        self.mode, self.ref, self.as_user, self.uid = mode, ref, as_user, uid
        self.workdir = None  # directory the CLI may write probe downloads into

    def _sudo(self):
        if not self.as_user:
            return []
        env = [f'XDG_RUNTIME_DIR=/run/user/{self.uid}'] if self.uid else []
        return ['sudo', '-n', '-u', self.as_user, 'env', *env]

    def prefix(self, env=None, mounts=None, entrypoint=None):
        env = env or {}
        if self.mode == 'source':
            return ['node', str(HERE.parent / 'src' / 'cli.js')], env
        if self.mode == 'binary':
            return [self.ref], env
        if self.mode == 'image':
            cmd = ['podman', 'run', '--rm', '-i', '--entrypoint', entrypoint or CLI_IN_IMAGE]
            for k, v in env.items():
                cmd += ['-e', f'{k}={v}']
            for host, cont in (mounts or []):
                cmd += ['-v', f'{host}:{cont}:Z']
            cmd += [self.ref]
            return cmd, {}
        if self.mode == 'deployed':
            cmd = self._sudo() + ['podman', 'exec', '-i']
            for k, v in env.items():
                cmd += ['-e', f'{k}={v}']
            cmd += [self.ref, entrypoint or CLI_IN_IMAGE]
            return cmd, {}
        raise ValueError(self.mode)

    def run(self, cli_args, stdin=None, env=None, timeout=300, mounts=None, entrypoint=None):
        pre, host_env = self.prefix(env=env, mounts=mounts, entrypoint=entrypoint)
        full_env = {**os.environ, **host_env}
        try:
            # utf-8 + replace: the CLI prints UTF-8 (arrows, emoji); on Windows the default
            # cp1252 decoder raised inside subprocess and left stdout as None.
            p = subprocess.run(pre + cli_args, input=stdin, capture_output=True, text=True,
                               encoding='utf-8', errors='replace', timeout=timeout, env=full_env)
            return p.returncode, p.stdout or '', p.stderr or ''
        except subprocess.TimeoutExpired as exc:
            def _s(b):
                return b.decode('utf-8', 'replace') if isinstance(b, bytes) else (b or '')
            return 124, _s(exc.stdout), _s(exc.stderr) + f'\n[timeout after {timeout}s]'

    # --- probe-file helpers (the file lives where the CLI wrote it) ---

    def probe_dir(self):
        if self.mode in ('source', 'binary'):
            self.workdir = self.workdir or tempfile.mkdtemp(prefix='videodl-smoke-')
            return self.workdir, self.workdir              # (cli path, inspect path)
        if self.mode == 'image':
            self.workdir = self.workdir or tempfile.mkdtemp(prefix='videodl-smoke-')
            return '/out', self.workdir
        # deployed: inside the running container's download volume
        return f'/downloads/.smoke-{int(time.time())}', None

    def inspect_media(self, cli_dir, host_dir, min_bytes=50_000):
        """Return (ok, detail) for the newest file in the probe dir."""
        if host_dir is not None:
            files = [p for p in Path(host_dir).iterdir() if p.is_file()]
            if not files:
                return False, 'no file produced'
            f = max(files, key=lambda p: p.stat().st_mtime)
            return _media_check(f.read_bytes()[:16], f.stat().st_size, f.name, min_bytes)
        # deployed: inspect inside the container with its python3
        code = (
            "import os,sys,json;d=sys.argv[1];fs=[os.path.join(d,x) for x in os.listdir(d)] if os.path.isdir(d) else [];"
            "fs=[f for f in fs if os.path.isfile(f)];"
            "print(json.dumps({} if not fs else (lambda f:{'name':os.path.basename(f),'size':os.path.getsize(f),'head':open(f,'rb').read(16).hex()})(max(fs,key=os.path.getmtime))))"
        )
        rc, out, err = self.run(['-c', code, cli_dir], entrypoint='python3', timeout=60)
        try:
            info = json.loads(out.strip().splitlines()[-1])
        except Exception:
            return False, f'could not inspect probe file: {err.strip()[-200:]}'
        if not info:
            return False, 'no file produced'
        return _media_check(bytes.fromhex(info['head']), info['size'], info['name'], min_bytes)

    def cleanup_probe(self, cli_dir, host_dir):
        if host_dir is not None:
            import shutil
            shutil.rmtree(host_dir, ignore_errors=True)
            self.workdir = None
        else:
            self.run(['-c', f"import shutil;shutil.rmtree({cli_dir!r}, ignore_errors=True)"], entrypoint='python3', timeout=60)


def _media_check(head: bytes, size: int, name: str, min_bytes: int = 50_000):
    # A truncated-but-valid file is the dangerous case: ffmpeg once wrote a single
    # 4-second segment (0.3 MB) of a 19 MB video and exited 0. Cases pin the expected
    # size with "minProbeBytes" so silent truncation fails the gate.
    if size < min_bytes:
        return False, f'{name}: only {size} bytes (< minProbeBytes {min_bytes}) — truncated download?'
    if head.lstrip()[:1] in (b'<', b'{'):
        return False, f'{name}: starts like HTML/JSON, not media'
    magic_ok = (b'ftyp' in head) or head.startswith(b'\x1aE\xdf\xa3') or head.startswith(b'\x00\x00\x01\xba') or head.startswith(b'RIFF')
    return (True, f'{name}: {size/1048576:.1f} MB, media header ok') if magic_ok else (False, f'{name}: unknown header {head.hex()}')


def last_json_line(text: str):
    for line in reversed(text.strip().splitlines()):
        line = line.strip()
        if line.startswith('{'):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue
    return None


def extractor_matches(actual: str, expected: str) -> bool:
    return fnmatch.fnmatch(actual or '', expected)


def run_case(runner: Runner, case: dict) -> dict:
    name = case['name']
    started = time.time()
    result = {'name': name, 'ok': False, 'optional': bool(case.get('optional')), 'detail': ''}

    try:
        ctype = case.get('type', 'extract')
        if 'expectError' in case:
            ctype = 'expectError'

        # The yt-dlp engine only exists inside the container image; from source or a
        # bare binary the case is skipped unless yt-dlp happens to be on PATH.
        if case.get('requires') == 'ytdlp' and runner.mode in ('source', 'binary'):
            import shutil
            if not shutil.which('yt-dlp'):
                result.update(ok=True, detail='skipped: yt-dlp not installed here (container-only engine)')
                return result

        if ctype == 'sandbox':
            # Mirror exactly what solver-sandbox.js does: a SEA gets bare --permission;
            # from source the child may read the project directory (its own modules).
            # (drive-letter path, same casing as the entry file we pass — see HERE)
            node_opts = '--permission' if runner.mode != 'source' else f'--permission --allow-fs-read={HERE.parent}'
            rc, out, err = runner.run(['__solve'], stdin=json.dumps(SANDBOX_PAYLOAD),
                                      env={'NODE_OPTIONS': node_opts}, timeout=120)
            data = last_json_line(out)
            got = None
            try:
                got = data['responses'][0]['data']['sandbox']
            except Exception:
                pass
            if got == 'ERR_ACCESS_DENIED':
                result.update(ok=True, detail='fs access denied inside solver child (ERR_ACCESS_DENIED)')
            else:
                result['detail'] = f'expected ERR_ACCESS_DENIED, got {got!r}; rc={rc}; stderr={err.strip()[-300:]}'

        elif ctype == 'expectError':
            cmd = case.get('command', 'extract')
            cli = [cmd, case['url'], *case.get('args', [])]
            if cmd == 'download':
                cli_dir, host_dir = runner.probe_dir()
                cli += ['-d', f'{cli_dir}/inner', '--no-base-url']
            rc, out, err = runner.run(cli, timeout=case.get('timeout', 180))
            if cmd == 'download':
                runner.cleanup_probe(cli_dir, host_dir)
            blob = (out + '\n' + err).lower()
            needle = case['expectError'].lower()
            if rc != 0 and needle in blob:
                result.update(ok=True, detail=f'refused as required (rc={rc}, matched "{case["expectError"]}")')
            else:
                result['detail'] = f'expected failure containing "{case["expectError"]}", rc={rc}; tail={blob.strip()[-300:]}'

        else:  # extract (+ optional probe)
            rc, out, err = runner.run(['extract', case['url']], timeout=case.get('timeout', 240))
            data = last_json_line(out)
            if not data or data.get('status') != 'ok':
                msg = (data or {}).get('msg') or err.strip()[-300:]
                result['detail'] = f'extract failed (rc={rc}): {msg}'
                return result
            n = len(data.get('formats') or [])
            ext = data.get('extractor', '')
            if not extractor_matches(ext, case.get('extractor', '*')):
                result['detail'] = f'routed to {ext!r}, expected {case.get("extractor")!r}'
                return result
            if n < case.get('minFormats', 1):
                result['detail'] = f'{n} format(s) < minFormats {case.get("minFormats", 1)}'
                return result
            detail = f'{ext}, {n} formats, title={data.get("title", "")[:50]!r}'
            if case.get('probe'):
                cli_dir, host_dir = runner.probe_dir()
                mounts = [(host_dir, cli_dir)] if runner.mode == 'image' else None
                rc2, out2, err2 = runner.run(['download', case['url'], '-f', 'worst', '-d', cli_dir, '--no-base-url'],
                                             timeout=case.get('timeout', 600), mounts=mounts)
                if rc2 != 0:
                    result['detail'] = detail + f' | probe download failed rc={rc2}: {err2.strip()[-300:]}'
                    runner.cleanup_probe(cli_dir, host_dir)
                    return result
                ok, mdetail = runner.inspect_media(cli_dir, host_dir, int(case.get('minProbeBytes', 50_000)))
                runner.cleanup_probe(cli_dir, host_dir)
                if not ok:
                    result['detail'] = detail + f' | probe: {mdetail}'
                    return result
                detail += f' | probe: {mdetail}'
            result.update(ok=True, detail=detail)
    except Exception as exc:  # a broken harness must show up as a failure, not a pass
        result['detail'] = f'harness error: {exc!r}'
    finally:
        result['seconds'] = round(time.time() - started, 1)
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--source', action='store_true', help='run node src/cli.js from this checkout')
    g.add_argument('--binary', help='path to a built videodl binary')
    g.add_argument('--image', help='container image ref (podman run)')
    g.add_argument('--deployed', help='running container name (podman exec)')
    ap.add_argument('--as-user', help='run podman as this user (deployed mode; needs sudo -n)')
    ap.add_argument('--uid', help='uid of --as-user (for XDG_RUNTIME_DIR)')
    ap.add_argument('--cases', default=str(DEFAULT_CASES))
    ap.add_argument('--filter', help='only run cases whose name contains this text')
    ap.add_argument('--skip', action='append', default=[], help='case name to skip (repeatable)')
    ap.add_argument('--json', help='write a JSON report here')
    ap.add_argument('--expect-ytdlp', help='(image/deployed) also assert yt-dlp --version equals this')
    a = ap.parse_args()

    if a.source:
        runner = Runner('source', None)
    elif a.binary:
        runner = Runner('binary', a.binary)
    elif a.image:
        runner = Runner('image', a.image)
    else:
        runner = Runner('deployed', a.deployed, a.as_user, a.uid)

    cases = json.loads(Path(a.cases).read_text(encoding='utf-8'))['cases']
    if a.filter:
        cases = [c for c in cases if a.filter in c['name']]
    cases = [c for c in cases if c['name'] not in a.skip]

    print(f'videodl smoke — mode={runner.mode} ref={runner.ref or "-"} cases={len(cases)}')
    results = []
    for c in cases:
        r = run_case(runner, c)
        results.append(r)
        flag = 'PASS' if r['ok'] else ('WARN' if r['optional'] else 'FAIL')
        print(f'  [{flag}] {r["name"]:<32} {r["seconds"]:>6}s  {r["detail"]}')

    versions = {}
    if runner.mode in ('image', 'deployed'):
        rc, out, _ = runner.run(['--version'], timeout=60)
        versions['cli'] = out.strip().splitlines()[0] if out.strip() else None
        rc, out, _ = runner.run(['--version'], timeout=60, entrypoint=YTDLP_IN_IMAGE)
        versions['ytdlp'] = out.strip().splitlines()[0] if out.strip() else None
        print(f'  versions: cli={versions["cli"]}  yt-dlp={versions["ytdlp"]}')

        # yt-dlp prints its GitHub tag form (2026.08.19); PyPI / requirements.in use the
        # normalised form (2026.8.19). Compare component-wise with leading zeros dropped.
        def _norm(v):
            return '.'.join(p.lstrip('0') or '0' for p in str(v or '').strip().split('.'))
        if a.expect_ytdlp and _norm(versions['ytdlp']) != _norm(a.expect_ytdlp):
            results.append({'name': 'ytdlp-version', 'ok': False, 'optional': False,
                            'detail': f'yt-dlp is {versions["ytdlp"]!r}, expected {a.expect_ytdlp!r}', 'seconds': 0})
            print(f'  [FAIL] ytdlp-version: {results[-1]["detail"]}')

    hard_failures = [r for r in results if not r['ok'] and not r['optional']]
    soft_failures = [r for r in results if not r['ok'] and r['optional']]
    summary = {'mode': runner.mode, 'ref': runner.ref, 'versions': versions, 'results': results,
               'passed': len([r for r in results if r['ok']]), 'failed': len(hard_failures),
               'optional_failed': len(soft_failures), 'ok': not hard_failures}
    if a.json:
        Path(a.json).write_text(json.dumps(summary, indent=2), encoding='utf-8')
    print(f'\n{"GREEN" if summary["ok"] else "RED"}: {summary["passed"]} passed, {summary["failed"]} failed'
          + (f', {summary["optional_failed"]} optional failed' if soft_failures else ''))
    return 0 if summary['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
