/**
 * Rate-limit handling shared by every download path (LESSONS-LEARNED #32, #33).
 *
 * Media hosts that limit requests per minute answer HTTP 429 (or 503) with a
 * `Retry-After` header. videodl waits that long and tries again instead of
 * failing the download, on every site:
 *
 *   - Node downloads (direct files, video + audio pairs): `withRateLimitRetry()`
 *     around the whole request, `retryAfterSeconds()` for the wait.
 *   - HLS downloads run by ffmpeg: ffmpeg SKIPS a segment that answers 429 and
 *     still exits 0 (a silently truncated video, measured with ffmpeg 8.1), and
 *     its own retry options do not reach segment requests. When ffmpeg reports a
 *     429/503 the download is restarted through `startHlsRelay()`: a loopback
 *     HTTP server that fetches every playlist, key and segment itself, waits out
 *     the rate limit and hands ffmpeg only complete answers. A request the relay
 *     finally gives up on is recorded, and the download fails instead of being
 *     truncated.
 */
import http from 'node:http';
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

/**
 * Start a loopback relay for one HLS download.
 *
 * @param {object} o
 * @param {object} [o.headers]              request headers for every upstream request (User-Agent, Referer ...)
 * @param {(url:string)=>string} [o.cookieHeaderFor]  Cookie header for an upstream URL ('' for none)
 * @param {boolean} [o.rejectUnauthorized]
 * @param {number} [o.maxRetries]           waits per request before giving up (default 10)
 * @param {function} [o.log]
 * @returns {Promise<{local:(url:string)=>string, input:(url:string)=>Promise<string>,
 *   failures:string[], stats:{rateLimited:number, requests:number}, close:()=>Promise<void>}>}
 */
export async function startHlsRelay({ headers = {}, cookieHeaderFor = null, rejectUnauthorized = true,
                                      maxRetries = 10, log = console.log } = {}) {
  const token = crypto.randomBytes(12).toString('hex');
  const table = [];
  const index = new Map();
  const failures = [];
  const stats = { rateLimited: 0, requests: 0 };
  const checkedHosts = new Map();
  let port = 0;

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

    let netErrors = 0;
    for (let attempt = 0; ; attempt++) {
      let stream;
      try {
        stream = got.stream(upstream, {
          headers: h,
          https: { rejectUnauthorized },
          hooks: privateGuardHooks(),
          throwHttpErrors: false,
          decompress: false,
          timeout: { lookup: 10000, connect: 10000, secureConnect: 10000, response: 30000 },
        });
        const resp = await new Promise((ok, bad) => { stream.once('response', ok); stream.once('error', bad); });
        const status = resp.statusCode;
        if (isRateLimitStatus(status) && attempt < maxRetries) {
          stream.destroy();
          stats.rateLimited++;
          const waitS = retryAfterSeconds(resp.headers, attempt);
          log(`[HLS relay] HTTP ${status} (rate limit) — waiting ${waitS}s (attempt ${attempt + 1}/${maxRetries})`);
          await sleep(waitS * 1000 + 500);
          continue;
        }
        if (status >= 400) {
          stream.destroy();
          if (status !== 416) failures.push(`${upstream}: HTTP ${status}`);
          res.writeHead(status); res.end(); return;
        }
        const ctype = resp.headers['content-type'] || '';
        if (isPlaylist(upstream, ctype)) {
          const chunks = [];
          for await (const c of stream) chunks.push(c);
          const body = Buffer.from(rewritePlaylist(Buffer.concat(chunks).toString('utf8'), resp.url || upstream), 'utf8');
          res.writeHead(status, { 'Content-Type': ctype || 'application/vnd.apple.mpegurl', 'Content-Length': body.length });
          res.end(body);
          return;
        }
        const out = { 'Content-Type': ctype || 'application/octet-stream' };
        for (const k of ['content-length', 'content-range', 'accept-ranges', 'content-encoding']) {
          if (resp.headers[k]) out[k] = resp.headers[k];
        }
        res.writeHead(status, out);
        stream.on('error', () => res.destroy());
        res.on('close', () => stream.destroy());
        stream.pipe(res);
        return;
      } catch (e) {
        if (stream) stream.destroy();
        if (++netErrors <= 3) {
          log(`[HLS relay] ${e.code || e.message} — retrying in ${5 * netErrors}s`);
          await sleep(5000 * netErrors);
          attempt--;   // a network error does not use up a rate-limit wait
          continue;
        }
        failures.push(`${upstream}: ${e.message}`);
        if (!res.headersSent) { res.writeHead(502); res.end(); } else res.destroy();
        return;
      }
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

  const close = () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); });
  return { local, input, failures, stats, close };
}
