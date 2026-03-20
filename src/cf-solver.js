/**
 * Cloudflare-Protected Download via TLS Fingerprint Impersonation
 * 
 * For CDNs behind Cloudflare's WAF bot detection (e.g. r2.1hanime.com),
 * Cloudflare verifies the TLS fingerprint (JA3/JA4) matches a known browser.
 * Node.js's OpenSSL TLS stack produces a different fingerprint than Chrome's
 * BoringSSL, causing all standard HTTP libraries (got, undici, etc.) to be
 * blocked with 403.
 * 
 * This module uses cycletls — a Go-based HTTP client with utls — to send
 * requests with Chrome's exact TLS fingerprint, bypassing the WAF check.
 * 
 * The download is streamed directly to disk via cycletls's streaming API,
 * with progress reporting and resume support.
 * 
 * Dependencies: cycletls (npm package — includes pre-compiled Go binary).
 */

import fs from 'node:fs';
import path from 'node:path';

// Chrome 131+ JA3 fingerprint
const CHROME_JA3 = '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0';
const CHROME_UA  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Download a file from a Cloudflare WAF-protected CDN.
 * Uses TLS fingerprint impersonation (Chrome JA3 via cycletls).
 * 
 * @param {Object} opts
 * @param {string} opts.url          - Direct download URL (with verify token)
 * @param {string} opts.filepath     - Destination file path
 * @param {Object} [opts.headers]    - Extra request headers (Referer, Origin, etc.)
 * @param {number} [opts.timeout]    - Timeout in ms (default: 600000 = 10 min)
 * @param {Function} [opts.onStatus] - Status callback: (message: string) => void
 * @param {Function} [opts.onProgress] - Progress callback: (downloaded: number, total: number) => void
 * @returns {Promise<{filepath: string, size: number}>}
 */
export async function cfProtectedDownload({ url, filepath, headers = {}, timeout = 600_000, onStatus, onProgress }) {
  // Dynamic import — only loaded when CF download is needed
  const { createCycleTLS } = await import('./cycletls-helper.js');

  const status = (msg) => onStatus?.(msg);
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let cycleTLS;
  try {
    status('Initializing TLS client...');
    cycleTLS = await createCycleTLS();

    // Build request headers
    const reqHeaders = {
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    // Apply caller-supplied headers (Referer, Origin, etc.)
    if (headers['Referer'] || headers['referer']) {
      reqHeaders['Referer'] = headers['Referer'] || headers['referer'];
    }
    if (headers['Origin'] || headers['origin']) {
      reqHeaders['Origin'] = headers['Origin'] || headers['origin'];
    }

    // ── Step 1: HEAD request to get total file size ──────────────────────
    status('Checking file size...');
    const headResp = await cycleTLS(url, {
      body: '',
      ja3: CHROME_JA3,
      userAgent: CHROME_UA,
      headers: { ...reqHeaders },
    }, 'head');

    if (headResp.status === 403) {
      throw new Error('CDN returned 403 Forbidden — the verify token may have expired. Try again.');
    }
    if (headResp.status >= 400) {
      throw new Error(`CDN returned HTTP ${headResp.status}`);
    }

    const totalSize = parseInt(
      headResp.headers?.['Content-Length']?.[0] ||
      headResp.headers?.['content-length']?.[0] || '0'
    );
    if (totalSize > 0) {
      status(`File size: ${(totalSize / 1024 / 1024).toFixed(1)} MB`);
    }

    // ── Step 2: Check for existing partial download (resume support) ─────
    let startByte = 0;
    const partialPath = filepath + '.part';
    if (fs.existsSync(partialPath)) {
      const existingSize = fs.statSync(partialPath).size;
      if (totalSize > 0 && existingSize > 0 && existingSize < totalSize) {
        startByte = existingSize;
        status(`Resuming from ${(startByte / 1024 / 1024).toFixed(1)} MB...`);
      }
    }

    // ── Step 3: Stream download ──────────────────────────────────────────
    const dlHeaders = { ...reqHeaders };
    if (startByte > 0) {
      dlHeaders['Range'] = `bytes=${startByte}-`;
    }

    const getResp = await cycleTLS(url, {
      body: '',
      ja3: CHROME_JA3,
      userAgent: CHROME_UA,
      headers: dlHeaders,
      responseType: 'stream',
      timeout: timeout,
    }, 'get');

    if (getResp.status === 403) {
      throw new Error('CDN returned 403 Forbidden — the verify token may have expired. Try again.');
    }
    if (getResp.status >= 400) {
      throw new Error(`CDN returned HTTP ${getResp.status} during download`);
    }

    const stream = getResp.data;
    if (!stream || typeof stream.pipe !== 'function') {
      throw new Error('TLS client did not return a readable stream');
    }

    // Write to .part file, then rename on completion
    const fileStream = fs.createWriteStream(partialPath, {
      flags: startByte > 0 ? 'a' : 'w'
    });

    let downloaded = startByte;
    const reportInterval = 200; // ms between progress reports
    let lastReport = Date.now();

    stream.on('data', (chunk) => {
      downloaded += chunk.length;
      const now = Date.now();
      if (now - lastReport >= reportInterval) {
        onProgress?.(downloaded, totalSize);
        lastReport = now;
      }
    });

    await new Promise((resolve, reject) => {
      stream.pipe(fileStream);
      fileStream.on('finish', resolve);
      fileStream.on('error', reject);
      stream.on('error', reject);

      // Timeout fallback
      if (timeout > 0) {
        const timer = setTimeout(() => {
          stream.destroy(new Error(`Download timed out after ${(timeout / 1000).toFixed(0)}s`));
        }, timeout);
        fileStream.on('finish', () => clearTimeout(timer));
      }
    });

    // Final progress report
    onProgress?.(downloaded, totalSize);

    // ── Step 4: Rename .part → final file ────────────────────────────────
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    fs.renameSync(partialPath, filepath);

    const finalSize = fs.statSync(filepath).size;
    status(`Download complete: ${(finalSize / 1024 / 1024).toFixed(1)} MB`);

    return { filepath, size: finalSize };

  } finally {
    // Always clean up the Go process
    try { cycleTLS?.exit(); } catch {}
  }
}
