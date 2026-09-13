/**
 * Sandboxed challenge solving (parent side).
 *
 * The EJS solver (`src/vendor/yt.solver.core.js`, from yt-dlp/ejs) executes the
 * challenge functions of YouTube's *player JavaScript* — remote code fetched at
 * runtime. Running that in-process gives it the CLI's full privileges: `fs`,
 * `child_process`, the network, and in the container `/config` with every user's
 * secrets. yt-dlp runs the same solver in a permission-less deno for this reason.
 *
 * We do the equivalent with Node's permission model: the solver runs in a **child
 * process of this very binary** started with `--permission`, which denies `fs`,
 * `child_process`, `worker_threads`, inspector, WASI and native addons to the whole
 * child. The parent sends the player JS, the requests and the solver source over
 * stdin (so the child never touches the filesystem) and reads one JSON result from
 * stdout. Verified live: the SEA binary honours `NODE_OPTIONS=--permission`.
 *
 *   SEA binary : `<self> __solve`            with NODE_OPTIONS=--permission
 *   from source: `node --permission src/cli.js __solve`
 *
 * There is a deliberate escape hatch for debugging only — `VIDEODL_SOLVER_UNSANDBOXED=1`
 * runs in-process and logs a loud warning. It is never used automatically: a sandbox
 * that fails is reported as an error, not silently downgraded.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { getSolverCode } from './solver-loader.js';

export const SOLVE_SUBCOMMAND = '__solve';
const SOLVER_TIMEOUT_MS = 90_000;
const STDERR_KEEP = 8192;

async function runningAsSea() {
  try {
    const sea = await import('node:sea');
    return typeof sea.isSea === 'function' && sea.isSea();
  } catch {
    return false;
  }
}

function unsandboxedRequested() {
  return /^(1|true|yes)$/i.test(process.env.VIDEODL_SOLVER_UNSANDBOXED || '');
}

/** In-process execution — debugging escape hatch only. */
export async function runSolverInProcess(solverCode, playerJS, requests) {
  const meriyah = await import('meriyah');
  const astring = await import('astring');
  const factory = new Function('meriyah', 'astring', solverCode + '\nreturn jsc;');
  const solver = factory(meriyah, astring);
  try {
    return solver({ type: 'player', player: playerJS, requests });
  } catch (err) {
    return { type: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Solve sig / n challenges for a player. Resolves to the solver's result object
 * (`{type:'result', responses:[…]}` or `{type:'error', error}`); rejects when the
 * sandboxed child could not be started, timed out, or produced no result.
 */
export async function solveChallenges(playerJS, requests, { log = () => {} } = {}) {
  const solverCode = getSolverCode();

  if (unsandboxedRequested()) {
    log('⚠ VIDEODL_SOLVER_UNSANDBOXED is set — running the challenge solver IN-PROCESS. ' +
        'YouTube player code now has this process\'s full privileges. Debugging only.');
    return runSolverInProcess(solverCode, playerJS, requests);
  }

  const sea = await runningAsSea();
  const exe = process.execPath;
  const env = { ...process.env, NODE_NO_WARNINGS: '1' };
  let args;
  if (sea) {
    // A SEA does not take Node flags on its command line; NODE_OPTIONS is honoured.
    // Everything the child runs is inside the binary, so no fs read grant is needed.
    args = [SOLVE_SUBCOMMAND];
    env.NODE_OPTIONS = [process.env.NODE_OPTIONS, '--permission'].filter(Boolean).join(' ');
  } else {
    // From source the child must load src/*.js and node_modules from disk, so grant
    // read-only access to the project directory — nothing else. Writes, child
    // processes and workers stay denied, which is what the sandbox is for.
    // path.resolve, deliberately NOT realpath: Node matches the grant against the
    // drive-letter form of the entry path, case-sensitively (probed on a mapped drive:
    // `Z:\…` passes, `z:\…` and every UNC / realpath form are denied). Deriving the
    // grant from argv[1] with the same resolver keeps the casing identical.
    const projectRoot = path.resolve(path.dirname(process.argv[1]), '..');
    args = ['--permission', `--allow-fs-read=${projectRoot}`, process.argv[1], SOLVE_SUBCOMMAND];
  }

  log(`Solving challenges in a sandboxed child (${sea ? 'SEA' : 'node'} --permission)…`);

  const payload = JSON.stringify({ player: playerJS, requests, solverCode });

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(exe, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      reject(new Error(`Could not start sandboxed solver: ${err.message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`Challenge solver timed out after ${SOLVER_TIMEOUT_MS / 1000}s`));
    }, SOLVER_TIMEOUT_MS);

    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => {
      stderr += d.toString();
      if (stderr.length > STDERR_KEEP) stderr = stderr.slice(-STDERR_KEEP);
    });

    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Could not start sandboxed solver: ${err.message}`));
    });

    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch {}
      if (!parsed || typeof parsed !== 'object') {
        const tail = stderr.trim().split('\n').filter(Boolean).slice(-3).join(' | ');
        reject(new Error(
          `Sandboxed solver exited with code ${code} and no result` + (tail ? `: ${tail}` : '')
        ));
        return;
      }
      resolve(parsed);
    });

    child.stdin.on('error', () => { /* child died early — reported via close */ });
    child.stdin.end(payload);
  });
}
