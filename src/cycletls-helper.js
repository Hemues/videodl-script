/**
 * CycleTLS helper — ensures the Go helper binary is found when running
 * as a compiled SEA binary (where __dirname != node_modules).
 */

import path from 'node:path';
import fs from 'node:fs';

const CYCLETLS_BINARIES = {
  win32:  { x64: 'index.exe' },
  linux:  { arm: 'index-arm', arm64: 'index-arm64', x64: 'index' },
  darwin: { x64: 'index-mac', arm: 'index-mac-arm', arm64: 'index-mac-arm64' },
  freebsd:{ x64: 'index-freebsd' },
};

/**
 * Locate the CycleTLS Go helper binary next to the running executable.
 * In a Node.js SEA binary, __dirname points to the binary's directory —
 * NOT the original node_modules/cycletls/dist/ folder.  We look for the
 * sidecar binary there so CycleTLS can spawn it.
 * @returns {string|undefined}
 */
function findCycleTLSBinary() {
  const fileName = CYCLETLS_BINARIES[process.platform]?.[process.arch];
  if (!fileName) return undefined;

  const exeDir = path.dirname(process.execPath);
  const sidecar = path.join(exeDir, fileName);
  if (fs.existsSync(sidecar)) return sidecar;

  return undefined;
}

/**
 * Create and return a ready-to-use CycleTLS instance.
 * Automatically passes `executablePath` when a sidecar binary is found
 * (compiled / container mode).  Falls back to the default resolution
 * when running from source.
 */
export async function createCycleTLS() {
  const { default: initCycleTLS } = await import('cycletls');
  const executablePath = findCycleTLSBinary();
  const opts = executablePath ? { executablePath } : undefined;
  return initCycleTLS(opts);
}
