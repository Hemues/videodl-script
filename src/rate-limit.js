/**
 * Rate limits and transient faults, shared by every download path
 * (LESSONS-LEARNED #32, #33, #34).
 *
 *   - Node downloads (direct files, video + audio pairs): `withRateLimitRetry()`
 *     repeats the request after a 429/503, waiting the host's `Retry-After`.
 *   - HLS downloads run by ffmpeg go through `startHlsRelay()`: a loopback HTTP
 *     server that fetches every playlist, key and segment itself. ffmpeg on its
 *     own is not safe for these (measured with ffmpeg 8.1, see #33/#34):
 *       * a segment that fails to open is retried `seg_max_retry` times at once
 *         (default 0) and then SKIPPED, exit code 0;
 *       * a transfer cut in the middle of a segment ends that segment early and
 *         ffmpeg moves on (2 s of 20 s silently missing, duration still "full");
 *       * the `reconnect*` options never reach segment requests (hls.c passes
 *         only headers / user_agent / cookies / http_proxy / referer / rw_timeout).
 *     The relay waits out 429/503 (`Retry-After`), retries other errors with a
 *     backoff, RESUMES a cut transfer from the exact byte with a Range request,
 *     and hands ffmpeg only complete answers. What it finally gives up on is
 *     recorded, and the download fails instead of being shorter (or, with
 *     VIDEODL_HLS_SKIP_UNAVAILABLE=1, finishes with a warning, like yt-dlp).
 */
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import got from 'got';
import { assertPublicUrl, privateGuardHooks } from './url-guard.js';

/** Statuses treated as "slow down": 429 Too Many Requests, 503 Service Unavailable. */
export function isRateLimitStatus(status) {
  return status === 429 || status === 503;
}

/** HTTP status of an error from got (or of an Error carrying `response`), else 0. */
export function errorStatus(err) {
  const s = err?.response?.statusCode ?? err?.statusCode;
  if (typeof s === 'number') return s;
  const m = /\bHTTP (\d{3})\b/.exec(String(err?.message || ''));
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Seconds to wait before the next attempt: `Retry-After` (seconds or an HTTP
 * date) when the host sent one, else an exponential backoff (5, 10, 20 ... s).
 * Clamped to 1..cap seconds.
 */
export function retryAfterSeconds(headers, attempt, cap = 120) {
  const hdr = String(headers?.['retry-after'] ?? '').trim();
  let s;
  if (/^\d+$/.test(hdr)) s = parseInt(hdr, 10);
  else if (hdr && !isNaN(Date.parse(hdr))) s = Math.ceil((Date.parse(hdr) - Date.now()) / 1000);
  else s = 5 * 2 ** attempt;
  return Math.min(Math.max(s, 1), cap);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Run `fn` again after a 429/503, up to `maxRetries` times, waiting the host's
 * Retry-After each time. `fn` must start from scratch on every call (the Node
 * download paths truncate their file). An error marked `rateLimitExhausted`
 * (an inner retry loop already gave up) is not retried again.
 */
export async function withRateLimitRetry(fn, { label = 'download', maxRetries = 6, log = console.log } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = errorStatus(err);
      if (!isRateLimitStatus(status) || err?.rateLimitExhausted) throw err;
      if (attempt >= maxRetries) {
        err.rateLimitExhausted = true;
        throw err;
      }
      const waitS = retryAfterSeconds(err?.response?.headers, attempt);
      log(`[${label}] HTTP ${status} (rate limit) — waiting ${waitS}s, then retrying (attempt ${attempt + 1}/${maxRetries})`);
      await sleep(waitS * 1000 + 500);
    }
  }
}

/** ffmpeg stderr text that means a host refused a request with 429/503. */
export const FFMPEG_RATE_LIMIT_RE = /HTTP error (?:429|503)\b|Server returned (?:429|503)\b/;

/** True when the relay is on (default). VIDEODL_HLS_RELAY=0 turns it off. */
export function hlsRelayEnabled(env = process.env) {
  return !/^(0|false|no|off)$/i.test(String(env.VIDEODL_HLS_RELAY ?? '').trim());
}

/**
 * Start a loopback relay for one HLS download.
 *
 * @param {object} o
 * @param {object} [o.headers]              request headers for every upstream request (User-Agent, Referer ...)
 * @param {(url:string)=>string} [o.cookieHeaderFor]  Cookie header for an upstream URL ('' for none)
 * @param {boolean} [o.rejectUnauthorized]
 * @param {number} [o.maxRateLimitWaits]    429/503 waits per request (default 10)
 * @param {number} [o.maxErrorRetries]      retries per request for other errors (default 5; backoff 1, 2, 4, 8, 16 s)
 * @param {number} [o.maxResumes]           resumes of a cut transfer per request (default 8)
 * @param {function} [o.log]
 * @returns {Promise<{local:(url:string)=>string, input:(url:string)=>Promise<string>,
 *   failures:string[], stats:{requests:number, rateLimited:number, retried:number, resumed:number},
 *   close:()=>Promise<void>}>}
 */
export async function startHlsRelay({ headers = {}, cookieHeaderFor = null, rejectUnauthorized = true,
                                      maxRateLimitWaits = 10, maxErrorRetries = 5, maxResumes = 8,
                                      log = console.log } = {}) {
  const token = crypto.randomBytes(12).toString('hex');
  const table = [];
  const index = new Map();
  const failures = [];
  const stats = { requests: 0, rateLimited: 0, retried: 0, resumed: 0 };
  const checkedHosts = new Map();
  let port = 0;
  // Keep-alive pools: without them every segment paid a new TCP + TLS handshake
  // (a 635 s public stream took 23 s through the relay vs 5 s in plain ffmpeg).
  const agent = {
    http: new http.Agent({ keepAlive: true, maxSockets: 6 }),
    https: new https.Agent({ keepAlive: true, maxSockets: 6 }),
  };

  const local = (url) => {
    if (!/^https?:/i.test(url)) return url;
    let n = index.get(url);
    if (n === undefined) { n = table.length; table.push(url); index.set(url, n); }
    let ext = '';
    try { ext = (new URL(url).pathname.match(/\.[a-z0-9]{1,5}$/i) || [''])[0]; } catch {}
    return `http://127.0.0.1:${port}/${token}/${n}${ext}`;
  };

  const rewritePlaylist = (text, baseUrl) => String(text).split(/\r?\n/).map(line => {
    const t = line.trim();
    if (!t) return line;
    const abs = (ref) => {
      if (/^data:/i.test(ref)) return ref;
      try { return local(new URL(ref, baseUrl).toString()); } catch { return ref; }
    };
    if (t.startsWith('#')) return line.replace(/URI="([^"]*)"/g, (m, u) => `URI="${abs(u)}"`);
    return abs(t);
  }).join('\n');

  const guard = async (url) => {
    let host;
    try { host = new URL(url).host; } catch { return; }
    if (!checkedHosts.has(host)) checkedHosts.set(host, assertPublicUrl(url, { label: 'HLS URL' }));
    await checkedHosts.get(host);
  };

  const isPlaylist = (url, ctype) =>
    /mpegurl/i.test(ctype || '') || /\.m3u8?(\?|#|$)/i.test(url);

  const shortName = (u) => { try { const p = new URL(u).pathname; return p.slice(p.lastIndexOf('/') + 1) || p; } catch { return u; } };

  /**
   * Open `url` and return {stream, resp} for a 2xx answer, waiting out 429/503
   * and retrying other errors / network faults with a backoff.
   * Returns {status} (no stream) when it gives up on an HTTP status, throws on
   * a network error it gave up on.
   */
  const open = async (url, h) => {
    let waits = 0, errors = 0;
    for (;;) {
      let stream;
      try {
        stream = got.stream(url, {
          headers: h,
          agent,
          https: { rejectUnauthorized },
          hooks: privateGuardHooks(),
          throwHttpErrors: false,
          decompress: false,
          // `socket`: an idle transfer counts as cut after 60 s (then resumed)
          timeout: { lookup: 10000, connect: 10000, secureConnect: 10000, response: 30000, socket: 60000 },
        });
        const resp = await new Promise((ok, bad) => { stream.once('response', ok); stream.once('error', bad); });
        const status = resp.statusCode;
        if (status < 400) return { stream, resp };
        stream.destroy();
        if (isRateLimitStatus(status) && waits < maxRateLimitWaits) {
          const waitS = retryAfterSeconds(resp.headers, waits);
          waits++; stats.rateLimited++;
          log(`[HLS relay] HTTP ${status} (rate limit) on ${shortName(url)} — waiting ${waitS}s (${waits}/${maxRateLimitWaits})`);
          await sleep(waitS * 1000 + 500);
          continue;
        }
        if (status !== 416 && errors < maxErrorRetries) {
          const waitS = 2 ** errors;
          errors++; stats.retried++;
          log(`[HLS relay] HTTP ${status} on ${shortName(url)} — retrying in ${waitS}s (${errors}/${maxErrorRetries})`);
          await sleep(waitS * 1000);
          continue;
        }
        return { status };
      } catch (e) {
        if (stream) stream.destroy();
        if (errors < maxErrorRetries) {
          const waitS = 2 ** errors;
          errors++; stats.retried++;
          log(`[HLS relay] ${e.code || e.message} on ${shortName(url)} — retrying in ${waitS}s (${errors}/${maxErrorRetries})`);
          await sleep(waitS * 1000);
          continue;
        }
        throw e;
      }
    }
  };

  /** Copy `stream` into `res`, dropping the first `skip` bytes. Resolves {ended, n}. */
  const pump = (stream, res, skip) => new Promise((resolve) => {
    let n = 0, done = false;
    const finish = (ended) => { if (!done) { done = true; resolve({ ended, n }); } };
    stream.on('data', (c) => {
      if (skip > 0) {
        if (c.length <= skip) { skip -= c.length; return; }
        c = c.subarray(skip); skip = 0;
      }
      n += c.length;
      if (!res.write(c)) { stream.pause(); res.once('drain', () => stream.resume()); }
    });
    stream.once('end', () => finish(true));
    stream.once('error', () => finish(false));
    res.once('close', () => { stream.destroy(); finish(false); });
  });

  const server = http.createServer(async (req, res) => {
    const m = /^\/([0-9a-f]+)\/(\d+)(?:\.[A-Za-z0-9]{1,5})?$/.exec(req.url || '');
    const upstream = m && m[1] === token ? table[parseInt(m[2], 10)] : undefined;
    if (!upstream) { res.writeHead(404); res.end(); return; }
    stats.requests++;
    try {
      await guard(upstream);
    } catch (e) {
      failures.push(`${upstream}: ${e.message}`);
      res.writeHead(403); res.end(); return;
    }
    const h = { 'Accept-Encoding': 'identity', ...headers };
    const ck = cookieHeaderFor ? cookieHeaderFor(upstream) : '';
    if (ck) h.Cookie = ck;
    if (req.headers.range) h.Range = req.headers.range;

    const fail = (why, status = 502) => {
      failures.push(`${shortName(upstream)}: ${why}`);
      if (!res.headersSent) { res.writeHead(status); res.end(); } else res.destroy();
    };

    let first;
    try { first = await open(upstream, h); } catch (e) { fail(e.code || e.message); return; }
    if (!first.stream) {
      if (first.status === 416) { res.writeHead(416); res.end(); return; }
      fail(`HTTP ${first.status}`, first.status); return;
    }
    const { resp } = first;
    const ctype = resp.headers['content-type'] || '';

    // Playlists are small: read whole (re-fetch on a cut), rewrite, send.
    if (isPlaylist(upstream, ctype)) {
      let cur = first;
      for (let attempt = 0; ; attempt++) {
        const chunks = [];
        const ok = await new Promise((resolve) => {
          cur.stream.on('data', c => chunks.push(c));
          cur.stream.once('end', () => resolve(true));
          cur.stream.once('error', () => resolve(false));
        });
        if (ok) {
          const body = Buffer.from(rewritePlaylist(Buffer.concat(chunks).toString('utf8'), cur.resp.url || upstream), 'utf8');
          res.writeHead(cur.resp.statusCode, { 'Content-Type': ctype || 'application/vnd.apple.mpegurl', 'Content-Length': body.length });
          res.end(body);
          return;
        }
        if (attempt >= maxResumes) { fail('playlist transfer cut'); return; }
        stats.resumed++;
        try { cur = await open(upstream, h); } catch (e) { fail(e.code || e.message); return; }
        if (!cur.stream) { fail(`HTTP ${cur.status}`, cur.status); return; }
      }
    }

    // Media: stream through; resume a cut transfer from the exact byte.
    // Byte span of this answer: 206 -> Content-Range, 200 -> 0..Content-Length-1.
    let spanStart = 0, spanEnd = -1;
    const cr = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(resp.headers['content-range'] || '');
    if (resp.statusCode === 206 && cr) { spanStart = parseInt(cr[1], 10); spanEnd = parseInt(cr[2], 10); }
    else if (resp.headers['content-length']) spanEnd = parseInt(resp.headers['content-length'], 10) - 1;
    const expected = spanEnd >= spanStart ? spanEnd - spanStart + 1 : -1;

    const out = { 'Content-Type': ctype || 'application/octet-stream' };
    for (const k of ['content-length', 'content-range', 'accept-ranges', 'content-encoding']) {
      if (resp.headers[k]) out[k] = resp.headers[k];
    }
    res.writeHead(resp.statusCode, out);

    let written = 0;
    let cur = first.stream, skip = 0;
    for (let resumes = 0; ; resumes++) {
      const r = await pump(cur, res, skip);
      written += r.n;
      if (res.destroyed && !res.writableFinished && written < expected) return;   // ffmpeg went away
      if (expected < 0 ? r.ended : written >= expected) { res.end(); return; }
      // The transfer was cut (or ended short of Content-Length).
      if (expected < 0) { fail(`transfer cut after ${written} bytes (length unknown, cannot resume)`); return; }
      if (resumes >= maxResumes) { fail(`transfer cut after ${written} of ${expected} bytes, ${maxResumes} resumes failed`); return; }
      stats.resumed++;
      const from = spanStart + written;
      log(`[HLS relay] transfer of ${shortName(upstream)} cut after ${written} of ${expected} bytes — resuming at byte ${from}`);
      let next;
      try { next = await open(upstream, { ...h, Range: `bytes=${from}-${spanEnd}` }); } catch (e) { fail(e.code || e.message); return; }
      if (!next.stream) { fail(`HTTP ${next.status} on resume`); return; }
      const ncr = /bytes\s+(\d+)-/i.exec(next.resp.headers['content-range'] || '');
      if (next.resp.statusCode === 206 && ncr && parseInt(ncr[1], 10) === from) skip = 0;
      else if (next.resp.statusCode === 200) skip = from;          // the host ignored Range: drop what we already sent
      else { next.stream.destroy(); fail(`resume answered ${next.resp.statusCode} without a matching Content-Range`); return; }
      cur = next.stream;
    }
  });
  // ffmpeg may wait minutes on a rate-limited segment: no server-side timeouts.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 30000;
  await new Promise((ok, bad) => { server.once('error', bad); server.listen(0, '127.0.0.1', ok); });
  port = server.address().port;

  /** Map ffmpeg's top-level input (http(s) URL or data: playlist) to the relay. */
  const input = async (url) => {
    const m = /^data:[^,]*?(;base64)?,(.*)$/is.exec(url);
    if (!m) return local(url);
    const text = m[1] ? Buffer.from(m[2], 'base64').toString('utf8') : decodeURIComponent(m[2]);
    // The in-memory playlists videodl builds carry absolute URIs already.
    const body = Buffer.from(rewritePlaylist(text, 'http://invalid/'), 'utf8').toString('base64');
    return `data:application/vnd.apple.mpegurl;base64,${body}`;
  };

  const close = () => new Promise(r => {
    server.closeAllConnections?.();
    agent.http.destroy(); agent.https.destroy();
    server.close(() => r());
  });
  return { local, input, failures, stats, close };
}
