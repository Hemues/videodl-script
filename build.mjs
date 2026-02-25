/**
 * Build script for videodl standalone binaries
 *
 * Strategy:
 *   1. esbuild bundles all ESM source + dependencies into a single CJS file
 *   2. Node.js Single Executable Applications (SEA) compiles it into a
 *      self-contained binary (no Node.js install required to run it).
 *
 * On Windows this produces videodl.exe automatically.
 * For Linux, run this same script on a Linux machine (or in WSL/Docker).
 *
 * Usage:
 *   node build.mjs                  # build for current OS
 *   node build.mjs --bundle-only    # esbuild bundle only (skip binary)
 *
 * Cross-compile trick (Linux binary from Windows):
 *   1. Download the Linux Node.js binary from https://nodejs.org
 *   2. Place it as dist/node-linux  (the raw ELF binary)
 *   3. node build.mjs --linux-inject
 */

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir    = path.join(__dirname, 'dist');
const bundlePath = path.join(distDir, 'videodl.cjs');
const blobPath   = path.join(distDir, 'videodl.blob');

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

// Parse CLI flags
const args = process.argv.slice(2);
const bundleOnly   = args.includes('--bundle-only');
const linuxInject  = args.includes('--linux-inject');

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
    loader: {
      // Embed .core.js vendor file as text so it can be eval'd at runtime
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

  // Pattern that matches the lazy-cache utils block:
  //   var utils = require_lazy_cache()(require);
  //   var fn = require;
  //   require = utils;
  //   require("is-plain-object", "isObject");
  //   require("shallow-clone", "clone");
  //   require("kind-of", "typeOf");
  //   require_for_own();
  //   require = fn;
  //   module2.exports = utils;
  const lazyCachePattern = /var utils = require_lazy_cache\(\)\(require\);\s*var fn = require;\s*require = utils;\s*require\("is-plain-object",\s*"isObject"\);\s*require\("shallow-clone",\s*"clone"\);\s*require\("kind-of",\s*"typeOf"\);\s*require_for_own\(\);\s*require = fn;\s*module2\.exports = utils;/;

  if (!lazyCachePattern.test(code)) {
    console.log('  [patch] lazy-cache pattern not found — skipping (may already be patched)');
    return;
  }

  // Replace with inlined implementations of the utilities:
  // - typeOf:  kind-of (already bundled by esbuild as require_kind_of)
  // - isObject: is-plain-object — checks if a value is a plain object
  // - clone:   shallow-clone — creates a shallow clone of a value
  // - forOwn:  for-own (already bundled by esbuild as require_for_own)
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

// ─── Step 2: Node.js SEA blob generation ─────────────────────────────────────

function generateBlob() {
  console.log('=== Generating SEA blob ===\n');

  const seaConfig = path.join(__dirname, 'sea-config.json');
  const seaResult = spawnSync(process.execPath, ['--experimental-sea-config', seaConfig], {
    stdio: 'inherit',
    cwd: __dirname,
  });

  if (seaResult.status !== 0) {
    throw new Error(`SEA blob generation failed (exit code ${seaResult.status}).`);
  }

  const sizeKB = (fs.statSync(blobPath).size / 1024).toFixed(0);
  console.log(`\n  Blob: ${blobPath}  (${sizeKB} KB)\n`);
}

// ─── Step 3: Inject blob into a copy of the Node.js binary ──────────────────

function injectBinary(nodeSrc, outputName) {
  const outputPath = path.join(distDir, outputName);

  console.log(`=== Creating ${outputName} ===\n`);

  // Copy the node binary
  console.log(`  Copying ${nodeSrc} -> ${outputPath}`);
  fs.copyFileSync(nodeSrc, outputPath);

  // Remove the signature on Windows (signtool) or macOS (codesign)
  if (process.platform === 'win32' && outputName.endsWith('.exe')) {
    try {
      // Try to remove Windows code signature so we can inject
      const signtoolResult = spawnSync('signtool', ['remove', '/s', outputPath], { stdio: 'pipe' });
      if (signtoolResult.status === 0) {
        console.log('  Removed existing code signature');
      }
    } catch {
      // signtool not available, that's fine — unsigned node.exe works
    }
  }

  // Inject the SEA blob using postject
  console.log('  Injecting SEA blob with postject ...');

  // Use the locally installed postject CLI directly via Node to avoid
  // npx.cmd / PowerShell execution-policy issues on Windows.
  const postjectBin = path.join(__dirname, 'node_modules', '.bin', 'postject');
  const postjectArgs = [
    outputPath, 'NODE_SEA_BLOB', blobPath,
    '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ];

  if (!(process.platform === 'win32' && outputName.endsWith('.exe'))) {
    postjectArgs.push('--overwrite');
  }

  // Run postject CLI via Node directly (avoids .cmd/shell issues on Windows)
  const postjectCli = path.join(__dirname, 'node_modules', 'postject', 'dist', 'cli.js');
  const result = spawnSync(process.execPath, [postjectCli, ...postjectArgs], {
    stdio: 'inherit',
    cwd: __dirname,
  });

  if (result.status !== 0) {
    throw new Error(
      `postject failed (exit code ${result.status}).` +
      (result.stderr ? ` stderr: ${result.stderr}` : '')
    );
  }

  const sizeMB = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
  console.log(`\n  Output: ${outputPath}  (${sizeMB} MB)\n`);
  return outputPath;
}

// ─── Step 4: Build for current platform ──────────────────────────────────────

function buildCurrentPlatform() {
  // Allow overriding the Node.js binary via VIDEODL_SEA_NODE env var.
  // This is used when the system node binary lacks the SEA sentinel
  // (common with distro-packaged Node.js on Linux).
  const nodePath = process.env.VIDEODL_SEA_NODE || process.execPath;
  if (process.env.VIDEODL_SEA_NODE) {
    console.log(`  Using custom Node.js binary for SEA: ${nodePath}`);
  }

  if (process.platform === 'win32') {
    return injectBinary(nodePath, 'videodl.exe');
  } else if (process.platform === 'linux') {
    const out = injectBinary(nodePath, 'videodl-linux');
    fs.chmodSync(out, 0o755);
    return out;
  } else if (process.platform === 'darwin') {
    const out = injectBinary(nodePath, 'videodl-macos');
    fs.chmodSync(out, 0o755);
    return out;
  }
}

// ─── Step 5: Cross-inject for Linux (optional) ──────────────────────────────

function buildLinuxCross() {
  const linuxNodePath = path.join(distDir, 'node-linux');
  if (!fs.existsSync(linuxNodePath)) {
    console.log('  To cross-compile for Linux, download the Linux Node.js binary:');
    console.log('    https://nodejs.org/dist/v24.13.0/node-v24.13.0-linux-x64.tar.xz');
    console.log('  Extract the "node" binary and place it at:');
    console.log(`    ${linuxNodePath}`);
    console.log('  Then re-run: node build.mjs --linux-inject\n');
    return null;
  }

  const out = injectBinary(linuxNodePath, 'videodl-linux');
  return out;
}

// ─── Main ────────────────────────────────────────────────────────────────────

(async () => {
  try {
    // Always bundle first
    await bundle();

    if (bundleOnly) {
      console.log('=== Bundle-only mode — skipping binary compilation ===\n');
      printSummary();
      return;
    }

    // Generate the SEA blob
    generateBlob();

    // Build for current platform
    const currentBinary = buildCurrentPlatform();

    // Optionally cross-compile for Linux if on Windows
    if (linuxInject) {
      buildLinuxCross();
    }

    printSummary();
  } catch (err) {
    console.error('\n  Build failed:', err.message);
    process.exit(1);
  }
})();

function printSummary() {
  console.log('='.repeat(60));
  console.log('  Build complete!  Output files in dist/');
  console.log('='.repeat(60) + '\n');

  const files = fs.readdirSync(distDir);
  for (const f of files) {
    const full = path.join(distDir, f);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) continue;
    const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
    const sizeKB = (stat.size / 1024).toFixed(0);
    const display = stat.size > 1024 * 1024 ? `${sizeMB} MB` : `${sizeKB} KB`;
    console.log(`  ${f.padEnd(30)} ${display}`);
  }

  console.log('\n  Usage:');
  if (process.platform === 'win32') {
    console.log('    .\\dist\\videodl.exe --help');
    console.log('    .\\dist\\videodl.exe download "https://example.com/video"');
  } else {
    console.log('    ./dist/videodl-linux --help');
    console.log('    ./dist/videodl-linux download "https://example.com/video"');
  }
  console.log('');

  if (process.platform === 'win32') {
    console.log('  To also build a Linux binary, see: BUILD.md');
  }
  console.log('');
}
