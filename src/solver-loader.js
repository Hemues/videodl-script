/**
 * Inline solver code provider
 * 
 * In dev mode (ESM), this reads from the file system.
 * In bundled mode (CJS / SEA binary), esbuild will have inlined
 * the readFileSync at build time since the path is a static string
 * computable at build time.
 *
 * NOTE: We use a different strategy — the build script patches the bundle
 * post-esbuild to embed the solver code as a string constant.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let _cachedSolverCode = null;

/**
 * Returns the raw source text of yt.solver.core.js.
 * Works in both ESM (development) and CJS (packaged binary) modes.
 */
export function getSolverCode() {
  if (_cachedSolverCode) return _cachedSolverCode;

  // Check if the build injected it as a global
  if (typeof __EMBEDDED_YT_SOLVER__ !== 'undefined') {
    _cachedSolverCode = __EMBEDDED_YT_SOLVER__;
    return _cachedSolverCode;
  }

  // Dev mode — read from filesystem
  const candidates = [];

  // ESM path resolution
  try {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.join(thisDir, 'vendor', 'yt.solver.core.js'));
  } catch {}

  // CJS fallback paths
  if (typeof __dirname !== 'undefined') {
    candidates.push(path.join(__dirname, 'vendor', 'yt.solver.core.js'));
  }
  candidates.push(path.join(process.cwd(), 'src', 'vendor', 'yt.solver.core.js'));

  for (const p of candidates) {
    try {
      _cachedSolverCode = fs.readFileSync(p, 'utf-8');
      return _cachedSolverCode;
    } catch {}
  }

  throw new Error('YouTube challenge solver (yt.solver.core.js) not found');
}
