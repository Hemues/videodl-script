/**
 * Build script for videodl standalone binaries — multi-target, pinned, verified.
 *
 * Strategy:
 *   1. esbuild bundles all ESM source + dependencies into one CJS file.
 *   2. Node.js Single Executable Applications (SEA) turn it into a self-contained
 *      binary — one per TARGET — by injecting a SEA blob into a copy of the official
 *      Node.js binary for that target (downloaded from nodejs.org and verified
 *      against the sha256 pinned in build-pins.json).
 *   3. The "-ffmpeg" variant additionally embeds a static ffmpeg (BtbN build, pinned
 *      release tag + sha256 in build-pins.json) as a SEA asset.
 *
 * Targets (`--targets=…`, comma separated, or `all` / `host`):
 *   linux-x64    → videodl-linux,        videodl-ffmpeg-linux,        + cycletls `index`
 *   linux-arm64  → videodl-linux-arm64,  videodl-ffmpeg-linux-arm64,  + cycletls `index-arm64`
 *   win-x64      → videodl.exe,          videodl-ffmpeg.exe,          + cycletls `index.exe`
 *   win-x86      → videodl-x86.exe       (plain only: no 32-bit ffmpeg or cycletls exist upstream)
 *
 * Cross-building works from any host because postject edits ELF and PE alike; the
 * only host requirement is that the *running* Node.js version equals the pinned one
 * (the SEA blob format is version-specific). V8 code cache is platform-specific, so
 * `useCodeCache` is enabled only for the host's own target.
 *
 * Usage:
 *   node build.mjs                          # host target, plain variant
 *   node build.mjs --package                # host target, both variants
 *   node build.mjs --targets=all --package  # every target, both variants (release build)
 *   node build.mjs --bundle-only            # esbuild bundle only
 *   node build.mjs --no-ffmpeg              # skip the ffmpeg-embedded variant
 */

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir    = path.join(__dirname, 'dist');
const bundlePath = path.join(distDir, 'videodl.cjs');
const pins       = JSON.parse(fs.readFileSync(path.join(__dirname, 'build-pins.json'), 'utf-8'));

// Read version from package.json
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
const VERSION = pkg.version;

// Generate build timestamp in YYYYMMDDHHMMSS format
const now = new Date();
const BUILD_TIMESTAMP = [
  now.getFullYear(),
  String(now.getMonth() + 1).padStart(2, '0'),
  String(now.getDate()).padStart(2, '0'),
  String(now.getHours()).padStart(2, '0'),
  String(now.getMinutes()).padStart(2, '0'),
  String(now.getSeconds()).padStart(2, '0'),
].join('');

// ─── Targets ─────────────────────────────────────────────────────────────────

const TARGETS = {
  'linux-x64': {
    nodeArchive: v => `node-v${v}-linux-x64.tar.xz`,
    nodeInner:   v => `node-v${v}-linux-x64/bin/node`,
    nodeExe: 'node', outPlain: 'videodl-linux', outFfmpeg: 'videodl-ffmpeg-linux',
    cycletls: 'index', ffmpegExe: 'ffmpeg',
  },
  'linux-arm64': {
    nodeArchive: v => `node-v${v}-linux-arm64.tar.xz`,
    nodeInner:   v => `node-v${v}-linux-arm64/bin/node`,
    nodeExe: 'node', outPlain: 'videodl-linux-arm64', outFfmpeg: 'videodl-ffmpeg-linux-arm64',
    cycletls: 'index-arm64', ffmpegExe: 'ffmpeg',
  },
  'win-x64': {
    nodeArchive: v => `node-v${v}-win-x64.zip`,
    nodeInner:   v => `node-v${v}-win-x64/node.exe`,
    nodeExe: 'node.exe', outPlain: 'videodl.exe', outFfmpeg: 'videodl-ffmpeg.exe',
    cycletls: 'index.exe', ffmpegExe: 'ffmpeg.exe',
  },
  'win-x86': {
    nodeArchive: v => `node-v${v}-win-x86.zip`,
    nodeInner:   v => `node-v${v}-win-x86/node.exe`,
    nodeExe: 'node.exe', outPlain: 'videodl-x86.exe', outFfmpeg: null,
    cycletls: null, ffmpegExe: 'ffmpeg.exe',
  },
};

function hostTarget() {
  const p = process.platform === 'win32' ? 'win' : process.platform;
  const a = process.arch === 'ia32' ? 'x86' : process.arch;
  return `${p}-${a}`;
}

// ─── CLI flags ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const bundleOnly    = args.includes('--bundle-only');
const packageBuilds = args.includes('--package');
const noFFmpeg      = args.includes('--no-ffmpeg');
const linuxInject   = args.includes('--linux-inject');   // legacy alias for adding linux-x64

let targetSpec = 'host';
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--targets=')) targetSpec = args[i].slice('--targets='.length);
  else if (args[i] === '--targets' && args[i + 1]) targetSpec = args[++i];
}
let targets;
if (targetSpec === 'all') targets = Object.keys(TARGETS);
else if (targetSpec === 'host') targets = [hostTarget()];
else targets = targetSpec.split(',').map(s => s.trim()).filter(Boolean);
if (linuxInject && !targets.includes('linux-x64')) targets.push('linux-x64');
for (const t of targets) {
  if (!TARGETS[t]) {
    console.error(`Unknown target "${t}". Known: ${Object.keys(TARGETS).join(', ')}`);
    process.exit(1);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sha256File(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function verifySha256(file, expected, label) {
  const actual = sha256File(file);
  if (actual !== expected.toLowerCase()) {
    try { fs.unlinkSync(file); } catch {}
    throw new Error(`${label}: sha256 mismatch\n    expected ${expected}\n    actual   ${actual}\n  The pinned input changed upstream or the download is corrupt — refusing to build.`);
  }
  console.log(`  ✓ sha256 verified: ${path.basename(file)}`);
}

async function download(url, dest) {
  const got = (await import('got')).default;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const { pipeline } = await import('node:stream/promises');
  await pipeline(got.stream(url, { headers: { 'User-Agent': 'videodl-build' } }), fs.createWriteStream(dest));
}

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(' ')} failed (exit ${r.status})`);
}

/** Extract one member of a .tar.xz or .zip archive into `destFile`. */
function extractMember(archive, member, destFile) {
  const tmp = path.join(distDir, `_extract_${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    if (archive.endsWith('.tar.xz')) {
      run('tar', ['-xJf', archive, '-C', tmp, member]);
    } else if (archive.endsWith('.zip')) {
      if (process.platform === 'win32') {
        run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
          `Expand-Archive -Path '${archive}' -DestinationPath '${tmp}' -Force`]);
      } else {
        run('unzip', ['-o', '-q', archive, member, '-d', tmp]);
      }
    } else {
      throw new Error(`Unknown archive type: ${archive}`);
    }
    const found = path.join(tmp, member);
    if (!fs.existsSync(found)) throw new Error(`${member} not found inside ${path.basename(archive)}`);
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    fs.copyFileSync(found, destFile);
    if (process.platform !== 'win32') fs.chmodSync(destFile, 0o755);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Extract a whole archive into a fresh temp dir and return the dir. */
function extractAll(archive) {
  const tmp = path.join(distDir, `_extract_${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  if (archive.endsWith('.tar.xz')) {
    run('tar', ['-xJf', archive, '-C', tmp, '--strip-components=1']);
  } else if (process.platform === 'win32') {
    run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `Expand-Archive -Path '${archive}' -DestinationPath '${tmp}' -Force`]);
  } else {
    run('unzip', ['-o', '-q', archive, '-d', tmp]);
  }
  return tmp;
}

function findFileRecursive(dir, filename) {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      const found = findFileRecursive(full, filename);
      if (found) return found;
    } else if (entry === filename) {
      return full;
    }
  }
  return null;
}

// ─── Step 1: esbuild bundle ─────────────────────────────────────────────────

async function bundle() {
  console.log(`\n=== Bundling videodl v${VERSION} with esbuild ===\n`);

  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  // Read the YT solver code so we can embed it as a string define
  const solverPath = path.join(__dirname, 'src', 'vendor', 'yt.solver.core.js');
  let solverDefine = {};
  if (fs.existsSync(solverPath)) {
    const solverCode = fs.readFileSync(solverPath, 'utf-8');
    solverDefine['__EMBEDDED_YT_SOLVER__'] = JSON.stringify(solverCode);
    console.log(`  Embedded yt.solver.core.js (${(solverCode.length / 1024).toFixed(0)} KB)\n`);
  }

  await build({
    entryPoints: [path.join(__dirname, 'src', 'cli.js')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: bundlePath,
    mainFields: ['module', 'main'],
    external: [],
    banner: {
      js: [
        `var __BUILD_VERSION__ = "${VERSION}";`,
        `var __BUILD_TIMESTAMP__ = "${BUILD_TIMESTAMP}";`,
        '// Bundled by esbuild for videodl standalone binary',
      ].join('\n'),
    },
    define: {
      ...solverDefine,
    },
    minify: false,
    sourcemap: false,
    logLevel: 'info',
  });

  // Post-process: fix the lazy-cache pattern from clone-deep/utils.js
  // The lazy-cache package reassigns `require` to a proxy, which esbuild can't
  // statically resolve.  In a Node.js SEA binary the proxy's calls to the
  // original `require('kind-of')` etc. fail with ERR_UNKNOWN_BUILTIN_MODULE.
  // Replace the entire utils block with inlined implementations.
  patchLazyCache(bundlePath);

  const sizeKB = (fs.statSync(bundlePath).size / 1024).toFixed(0);
  console.log(`\n  Bundle: ${bundlePath}  (${sizeKB} KB)\n`);
}

/**
 * Patch the clone-deep/utils.js lazy-cache pattern in the bundled CJS.
 * Replaces the lazy-cache proxy module with direct inline implementations
 * of the three utilities it provides: typeOf, isObject, clone.
 */
function patchLazyCache(filePath) {
  let code = fs.readFileSync(filePath, 'utf-8');

  const lazyCachePattern = /var utils = require_lazy_cache\(\)\(require\);\s*var fn = require;\s*require = utils;\s*require\("is-plain-object",\s*"isObject"\);\s*require\("shallow-clone",\s*"clone"\);\s*require\("kind-of",\s*"typeOf"\);\s*require_for_own\(\);\s*require = fn;\s*module2\.exports = utils;/;

  if (!lazyCachePattern.test(code)) {
    console.log('  [patch] lazy-cache pattern not found — skipping (may already be patched)');
    return;
  }

  const replacement = `var utils = {};
    utils.typeOf = require_kind_of();
    utils.forOwn = require_for_own();
    utils.isObject = function isPlainObject(o) {
      if (Object.prototype.toString.call(o) !== '[object Object]') return false;
      var ctor = o.constructor;
      if (typeof ctor !== 'function') return false;
      var proto = ctor.prototype;
      if (Object.prototype.toString.call(proto) !== '[object Object]') return false;
      if (!proto.hasOwnProperty('isPrototypeOf')) return false;
      return true;
    };
    utils.clone = function shallowClone(val) {
      var type = utils.typeOf(val);
      if (type === 'object') return Object.assign({}, val);
      if (type === 'array') return val.slice();
      if (type === 'regexp') { var flags = ''; if (val.flags !== void 0) flags = val.flags; else flags = (val.global?'g':'')+(val.ignoreCase?'i':'')+(val.multiline?'m':''); return new RegExp(val.source, flags); }
      if (type === 'date') return new Date(+val);
      return val;
    };
    module2.exports = utils;`;

  code = code.replace(lazyCachePattern, replacement);
  fs.writeFileSync(filePath, code, 'utf-8');
  console.log('  [patch] Replaced lazy-cache pattern with inlined implementations');
}

/** Copy the CycleTLS Go helper for a target next to its SEA binary. */
function copyCycleTLSBinary(target) {
  const fileName = TARGETS[target].cycletls;
  if (!fileName) {
    console.log(`  [cycletls] no Go helper exists for ${target} — TLS-impersonation extractors will be unavailable on it`);
    return null;
  }
  const src = path.join(__dirname, 'node_modules', 'cycletls', 'dist', fileName);
  const dst = path.join(distDir, fileName);
  if (!fs.existsSync(src)) {
    console.log(`  [cycletls] Go binary not found at ${src} — skipping`);
    return null;
  }
  fs.copyFileSync(src, dst);
  if (process.platform !== 'win32') fs.chmodSync(dst, 0o755);
  const sizeMB = (fs.statSync(dst).size / 1024 / 1024).toFixed(1);
  console.log(`  [cycletls] Copied Go helper: ${fileName} (${sizeMB} MB)`);
  return dst;
}

// ─── Step 2: pinned Node.js binary per target ────────────────────────────────

async function ensureNodeBinary(target) {
  const t = TARGETS[target];
  const ver = pins.node.version;
  const expected = pins.node.sha256[target];
  if (!expected) throw new Error(`build-pins.json has no node sha256 for ${target}`);

  const dir = path.join(distDir, 'node', target);
  const nodeBin = path.join(dir, t.nodeExe);
  const stamp = path.join(dir, `.from-v${ver}`);

  // Legacy override for the host target (compile.sh used to pre-download Node here).
  if (target === hostTarget() && process.env.VIDEODL_SEA_NODE && fs.existsSync(process.env.VIDEODL_SEA_NODE)) {
    console.log(`  Using VIDEODL_SEA_NODE for ${target}: ${process.env.VIDEODL_SEA_NODE}`);
    return process.env.VIDEODL_SEA_NODE;
  }

  if (fs.existsSync(nodeBin) && fs.existsSync(stamp)) {
    console.log(`  Node ${ver} for ${target}: cached`);
    return nodeBin;
  }

  const archiveName = t.nodeArchive(ver);
  const archive = path.join(dir, archiveName);
  const url = `https://nodejs.org/dist/v${ver}/${archiveName}`;
  console.log(`  Downloading ${archiveName} …`);
  await download(url, archive);
  verifySha256(archive, expected, `Node.js ${archiveName}`);
  extractMember(archive, t.nodeInner(ver), nodeBin);
  fs.unlinkSync(archive);
  fs.writeFileSync(stamp, `${archiveName} ${expected}\n`);
  console.log(`  ✓ Node ${ver} ready for ${target}`);
  return nodeBin;
}

// ─── Step 3: pinned ffmpeg per target ────────────────────────────────────────

async function ensureFFmpeg(target) {
  const t = TARGETS[target];
  const asset = pins.ffmpeg.assets[target];
  if (!asset) {
    console.log(`  ⚠ No pinned ffmpeg build for ${target} — skipping the ffmpeg-embedded variant`);
    return null;
  }
  const dir = path.join(distDir, '_ffmpeg', target);
  const exe = path.join(dir, t.ffmpegExe);
  const stamp = path.join(dir, '.sha256');
  if (fs.existsSync(exe) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf-8').trim() === asset.sha256) {
    console.log(`  ffmpeg for ${target}: cached (${asset.name})`);
    return exe;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const archive = path.join(dir, asset.name);
  const url = `https://github.com/${pins.ffmpeg.repo}/releases/download/${pins.ffmpeg.tag}/${asset.name}`;
  console.log(`  Downloading ${asset.name} (${pins.ffmpeg.tag}) …`);
  await download(url, archive);
  verifySha256(archive, asset.sha256, `ffmpeg ${asset.name}`);

  const tmp = extractAll(archive);
  try {
    const found = findFileRecursive(tmp, t.ffmpegExe);
    if (!found) throw new Error(`${t.ffmpegExe} not found in ${asset.name}`);
    fs.copyFileSync(found, exe);
    if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.unlinkSync(archive);
  }
  fs.writeFileSync(stamp, asset.sha256 + '\n');
  const sizeMB = (fs.statSync(exe).size / 1024 / 1024).toFixed(1);
  console.log(`  ✓ ffmpeg ready for ${target} (${sizeMB} MB)`);
  return exe;
}

// ─── Step 4: SEA blob + injection ────────────────────────────────────────────

function generateBlob(target, ffmpegBinaryPath) {
  const variant = ffmpegBinaryPath ? 'ffmpeg' : 'plain';
  const configPath = path.join(distDir, `sea-${target}-${variant}.json`);
  const blobPath = path.join(distDir, `videodl-${target}-${variant}.blob`);
  const config = {
    main: 'dist/videodl.cjs',
    output: path.relative(__dirname, blobPath).split(path.sep).join('/'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    // V8 code cache is tied to the exact V8 build that generated it. Even for the host's
    // own target the blob is generated by the host's (distro) Node and injected into the
    // official nodejs.org binary, so the cache is rejected at start-up ("Code cache data
    // rejected" warning, observed with 2.0.136). Off everywhere: deterministic blobs, no
    // warning, a few ms slower start.
    useCodeCache: false,
  };
  if (ffmpegBinaryPath) config.assets = { 'ffmpeg.bin': ffmpegBinaryPath };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  console.log(`=== Generating SEA blob (${target}, ${variant}${config.useCodeCache ? ', code cache' : ''}) ===\n`);
  const r = spawnSync(process.execPath, ['--experimental-sea-config', configPath], { stdio: 'inherit', cwd: __dirname });
  if (r.status !== 0) throw new Error(`SEA blob generation failed for ${target}/${variant} (exit ${r.status})`);
  const sizeKB = (fs.statSync(blobPath).size / 1024).toFixed(0);
  console.log(`\n  Blob: ${blobPath}  (${sizeKB} KB)\n`);
  try { fs.unlinkSync(configPath); } catch {}
  return blobPath;
}

function injectBinary(nodeSrc, outputName, blobFile) {
  const outputPath = path.join(distDir, outputName);
  console.log(`=== Creating ${outputName} ===\n`);
  console.log(`  Copying ${nodeSrc} -> ${outputPath}`);
  fs.copyFileSync(nodeSrc, outputPath);

  const isExe = outputName.endsWith('.exe');
  if (process.platform === 'win32' && isExe) {
    try {
      const st = spawnSync('signtool', ['remove', '/s', outputPath], { stdio: 'pipe' });
      if (st.status === 0) console.log('  Removed existing code signature');
    } catch { /* signtool not available — unsigned node.exe works */ }
  }

  console.log('  Injecting SEA blob with postject ...');
  const postjectArgs = [
    outputPath, 'NODE_SEA_BLOB', blobFile,
    '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ];
  if (!isExe) postjectArgs.push('--overwrite');

  const postjectCli = path.join(__dirname, 'node_modules', 'postject', 'dist', 'cli.js');
  const result = spawnSync(process.execPath, [postjectCli, ...postjectArgs], { stdio: 'inherit', cwd: __dirname });
  if (result.status !== 0) {
    throw new Error(`postject failed for ${outputName} (exit ${result.status})`);
  }
  if (!isExe) fs.chmodSync(outputPath, 0o755);

  const sizeMB = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
  console.log(`\n  Output: ${outputPath}  (${sizeMB} MB)\n`);
  return outputPath;
}

async function buildTarget(target) {
  const t = TARGETS[target];
  console.log(`\n${'─'.repeat(70)}\n  TARGET ${target}\n${'─'.repeat(70)}\n`);

  const nodeBin = await ensureNodeBinary(target);
  copyCycleTLSBinary(target);

  const plainBlob = generateBlob(target, null);
  injectBinary(nodeBin, t.outPlain, plainBlob);
  try { fs.unlinkSync(plainBlob); } catch {}

  if (packageBuilds && !noFFmpeg) {
    if (!t.outFfmpeg) {
      console.log(`  (no ffmpeg-embedded variant for ${target})\n`);
      return;
    }
    const ffmpegBin = await ensureFFmpeg(target);
    if (ffmpegBin) {
      const ffBlob = generateBlob(target, ffmpegBin);
      injectBinary(nodeBin, t.outFfmpeg, ffBlob);
      try { fs.unlinkSync(ffBlob); } catch {}
    }
  }
}

function printSummary() {
  console.log('='.repeat(60));
  console.log('  Build complete!  Output files in dist/');
  console.log('='.repeat(60) + '\n');
  for (const f of fs.readdirSync(distDir)) {
    const full = path.join(distDir, f);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) continue;
    if (f.endsWith('.cjs') || f.endsWith('.blob') || f.endsWith('.json') || f === 'node-official' || f === 'node-linux') continue;
    console.log(`  ${f.padEnd(35)} ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
  }
  console.log('');
}

// ─── Main ────────────────────────────────────────────────────────────────────

(async () => {
  try {
    await bundle();

    if (bundleOnly) {
      console.log('=== Bundle-only mode — skipping binary compilation ===\n');
      printSummary();
      return;
    }

    // The SEA blob format is tied to the Node.js version that generates it; the
    // target binaries are the pinned version, so the host must run the same one.
    const hostVer = process.version.replace(/^v/, '');
    if (hostVer !== pins.node.version && !process.env.VIDEODL_SKIP_NODE_VERSION_CHECK) {
      throw new Error(
        `Host Node.js is v${hostVer} but build-pins.json pins v${pins.node.version}. ` +
        'Install the pinned version on the build host (or bump the pin deliberately). ' +
        'Set VIDEODL_SKIP_NODE_VERSION_CHECK=1 to override at your own risk.'
      );
    }

    console.log(`  Targets: ${targets.join(', ')}   (host: ${hostTarget()})`);
    for (const target of targets) {
      await buildTarget(target);
    }
    printSummary();
  } catch (err) {
    console.error('\n  Build failed:', err.message);
    process.exit(1);
  }
})();
