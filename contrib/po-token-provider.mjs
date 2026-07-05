/**
 * ⚠️ DORMANT / REFERENCE ONLY — not wired into the CLI. See LESSONS-LEARNED.md
 * "Phase 2 — gvs PO tokens". This module is PROVEN under real Node.js (mints an
 * ~848-char gvs token that clears the IOS/WEB CDN 403 → 2160p), but jsdom CANNOT
 * be bundled into the Node SEA binary the container ships (its sync-XHR worker
 * uses require.resolve; even patched it fails to mint), and a minimal DOM shim
 * fails BotGuard (`PMD:Undefined`). The intended future home is a SIDECAR
 * PO-token provider running under real Node (like yt-dlp's bgutil provider),
 * which videodl-cli would call over HTTP. Requires deps: bgutils-js + jsdom.
 *
 * YouTube gvs (GoogleVideo streaming) PO Token minting — BotGuard via
 * bgutils-js + jsdom, with NO browser required.
 *
 * Background: as of 2026, several InnerTube clients (IOS, WEB, MWEB, …) mark
 * their `*.googlevideo.com/videoplayback` media URLs as requiring a `gvs` PO
 * token. Without a valid token bound to the session's `visitorData`, the CDN
 * returns HTTP 403. yt-dlp offloads this to an external provider
 * (bgutil-ytdlp-pot-provider); we mint it in-process instead.
 *
 * The token is expensive to mint (fetches + runs Google's BotGuard VM), so it
 * is cached per `visitorData` for the session. Minting is best-effort: on any
 * failure we return null and the caller falls back to no-token clients.
 *
 * NOTE: this pulls in jsdom, which is only loaded lazily on first mint so the
 * common ANDROID_VR/TV path (no token needed) pays no startup cost.
 */

// YouTube's well-known BotGuard request key (public, stable).
const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';
const DEFAULT_TTL_MS = 3 * 60 * 60 * 1000; // 3h — gvs tokens are session-bound and reusable

const _cache = new Map(); // visitorData -> { token, ts }
let _domReady = false;

async function _ensureDom() {
  if (_domReady) return;
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://www.youtube.com/',
  });
  // BotGuard's VM pokes at window/document; a minimal jsdom document suffices.
  if (!globalThis.window) globalThis.window = dom.window;
  if (!globalThis.document) globalThis.document = dom.window.document;
  _domReady = true;
}

/**
 * Mint a gvs PO token bound to visitorData. Returns the token string, or null
 * on any failure (caller must treat null as "no token available").
 * @param {string} visitorData
 * @param {object} [opts]
 * @param {number} [opts.ttlMs]
 */
export async function mintGvsPoToken(visitorData, opts = {}) {
  if (!visitorData) return null;
  const ttlMs = opts.ttlMs || DEFAULT_TTL_MS;

  const cached = _cache.get(visitorData);
  if (cached && Date.now() - cached.ts < ttlMs) return cached.token;

  try {
    await _ensureDom();
    const { BG } = await import('bgutils-js');

    const bgConfig = {
      fetch: (url, options) => fetch(url, options),
      globalObj: globalThis,
      identifier: visitorData,
      requestKey: REQUEST_KEY,
    };

    const challenge = await BG.Challenge.create(bgConfig);
    if (!challenge) throw new Error('BotGuard challenge creation returned null');

    const interpreterJs =
      challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue ||
      challenge.interpreterJavascript;
    if (typeof interpreterJs === 'string' && interpreterJs.length) {
      // Evaluate the BotGuard interpreter — it installs globalThis[globalName].
      // eslint-disable-next-line no-new-func
      new Function(interpreterJs)();
    } else {
      throw new Error('BotGuard interpreter JavaScript missing');
    }

    const result = await BG.PoToken.generate({
      program: challenge.program,
      globalName: challenge.globalName,
      bgConfig,
    });

    const token = result?.poToken || null;
    if (token) _cache.set(visitorData, { token, ts: Date.now() });
    return token;
  } catch (e) {
    // Best-effort: never let PO-token failure break extraction.
    return null;
  }
}

export function _clearPoTokenCache() {
  _cache.clear();
}
