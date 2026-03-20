/**
 * Brazzers Extractor
 * Extracts video URLs from brazzers.com / site-ma.brazzers.com
 *
 * Brazzers is part of the Aylo (formerly MindGeek) network and uses
 * a React SPA with a REST API at site-api.project1service.com.
 *
 * Requires cookies for authentication (premium content).
 * Export cookies from your browser using a "cookies.txt" extension.
 *
 * Supported URL patterns:
 *   - https://site-ma.brazzers.com/scene/{id}/{slug}
 *   - https://www.brazzers.com/video/{slug}/{id}
 *   - https://www.brazzers.com/video/{id}/{slug}
 *
 * API flow:
 *   1. Parse page HTML for window.__JUAN.config (API URLs and cookie names)
 *   2. Extract instance_token from cookies or page Set-Cookie response
 *   3. GET /v2/releases/{sceneId} on the site-api with Instance + Bearer headers
 *      - If 404 (www.brazzers.com uses content IDs, not release IDs),
 *        search by slug via GET /v2/releases?search={slug}&type=scene
 *   4. The result.videos.full.files object contains the actual video files:
 *      - type "hls"  → M3U8 master playlist for adaptive streaming
 *      - type "http" → direct MP4 download links
 *   5. Fall back to result.videos.mediabook (trailer) if full is unavailable
 */

import { BaseExtractor } from './base.js';
import got from 'got';
import { buildCookieHeader } from '../cookies.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 Edg/133.0.0.0';

// Default Aylo data-API – overridden by __JUAN.config.dataApiUrl when present
const DEFAULT_DATA_API = 'https://site-api.project1service.com';

// Default Aylo auth-API – overridden by __JUAN.config.authApiUrl when present
const DEFAULT_AUTH_API = 'https://auth-service.project1service.com';

// Retry constants
const PAGE_FETCH_MAX_RETRIES = 3;
const PAGE_FETCH_RETRY_DELAY_MS = 2500;
const API_MAX_RETRIES = 3;
const API_RETRY_DELAY_MS = 2000;

// Minimum file size (in bytes) for a full scene - anything below this is
// almost certainly a trailer/preview.  Full scenes are typically 500 MB+.
const MIN_FULL_SCENE_SIZE = 50 * 1024 * 1024; // 50 MB

export class BrazzersExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'Brazzers';
  }

  /* ─── URL matching ─────────────────────────────────────────────── */

  static canHandle(url) {
    return /brazzers\.com/i.test(url);
  }

  /* ─── Helpers ──────────────────────────────────────────────────── */

  /** Small async delay helper. */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Detect ad / interstitial / overlay pages that hide the real content.
   * These pages typically lack __JUAN.config and contain ad-related markers.
   */
  _isAdPage(html) {
    // The real page always contains __JUAN.config (Aylo SPA bootstrap)
    const hasJuanConfig = /__JUAN\.config\s*=/.test(html);
    // Ad/interstitial indicators
    const adIndicators = [
      /class=["'][^"']*ad[-_]?overlay/i,
      /class=["'][^"']*interstitial/i,
      /data-ad[-_]?type/i,
      /trafficjunky\.net/i,
      /exoclick\.com/i,
      /juicyads\.com/i,
      /ad\.atdmt\.com/i,
      /popunder|pop-under|clickunder/i,
      /<div[^>]+id=["']ad[-_]?container["']/i,
    ];
    const matchedAd = adIndicators.some(re => re.test(html));
    // If the page has no JUAN config AND has ad markers, it's an ad page
    if (!hasJuanConfig && matchedAd) return true;
    // Very short page without JUAN config is likely an ad redirect
    if (!hasJuanConfig && html.length < 5000) return true;
    return false;
  }

  /** Extract numeric scene/release ID from the URL path. */
  _extractSceneId(url) {
    // Matches:
    //   /scene/12345/slug   (site-ma.brazzers.com)
    //   /video/12345/slug   (site-ma.brazzers.com)
    //   /video/slug/12345   (www.brazzers.com)
    const m = url.match(/\/(?:scene|video)\/(\d+)/) ||
              url.match(/\/(?:scene|video)\/[^/]+\/(\d+)/);
    return m ? m[1] : null;
  }

  /** Extract the slug portion from a video URL path. */
  _extractSlug(url) {
    // www.brazzers.com/video/{slug}/{id}
    const m1 = url.match(/\/video\/([a-z0-9-]+)\/\d+/i);
    if (m1) return m1[1];
    // site-ma.brazzers.com/scene/{id}/{slug}
    const m2 = url.match(/\/scene\/\d+\/([a-z0-9-]+)/i);
    if (m2) return m2[1];
    return null;
  }

  /** Check if URL is from the www/tour site (not site-ma member area). */
  _isWwwUrl(url) {
    return /^https?:\/\/(?:www\.)?brazzers\.com\/video\//i.test(url);
  }

  /** Decode common HTML / JSON-escaped entities. */
  _decodeEntities(text) {
    return text
      .replace(/\\u002F/g, '/')
      .replace(/\\u0027/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#x([0-9A-F]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
  }

  /** Find a cookie by name whose domain matches the given hostname. */
  _findCookie(cookies, name, hostname) {
    if (!cookies) return null;
    return cookies.find(c => {
      if (c.name !== name) return false;
      const domain = c.domain.replace(/^\./, '');
      // Check cookie expiry (0 = session cookie, always valid)
      if (c.expiry > 0 && c.expiry < Date.now() / 1000) return false;
      return (
        hostname.includes(domain) ||
        domain.includes(hostname.split('.').slice(-2).join('.'))
      );
    }) || null;
  }

  /* ─── JWT helpers ──────────────────────────────────────────────── */

  /**
   * Decode the payload of a JWT (access_token_ma) without verification.
   * @param {string} token - The raw JWT string
   * @returns {Object|null} Parsed payload, or null on failure
   */
  _decodeJwtPayload(token) {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      // Base64url → Base64 → Buffer → JSON
      const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = Buffer.from(b64, 'base64').toString('utf-8');
      return JSON.parse(payload);
    } catch {
      return null;
    }
  }

  /**
   * Check whether a JWT access token has expired.
   * @param {string} token - JWT string
   * @returns {boolean} true if expired or unparseable
   */
  _isTokenExpired(token) {
    if (!token) return true;
    const payload = this._decodeJwtPayload(token);
    if (!payload || !payload.exp) return false; // can't determine → assume valid
    const now = Math.floor(Date.now() / 1000);
    return payload.exp < now;
  }

  /**
   * Return human-readable expiry info for a JWT.
   * @param {string} token - JWT string
   * @returns {string} e.g. "expired 3 hours ago" or "valid for 2 hours"
   */
  _tokenExpiryInfo(token) {
    const payload = this._decodeJwtPayload(token);
    if (!payload?.exp) return 'unknown expiry';
    const now = Math.floor(Date.now() / 1000);
    const diff = payload.exp - now;
    const abs = Math.abs(diff);
    const h = Math.floor(abs / 3600);
    const m = Math.floor((abs % 3600) / 60);
    const timeStr = h > 0 ? `${h}h ${m}m` : `${m}m`;
    return diff < 0 ? `expired ${timeStr} ago` : `valid for ${timeStr}`;
  }

  /* ─── Token refresh ────────────────────────────────────────────── */

  /**
   * Attempt to refresh an expired access_token_ma using the Aylo
   * auth service endpoint:  POST {authApiUrl}/v1/authenticate/renew
   * Body: { refreshToken: <refresh_token_ma cookie value> }
   *
   * Returns a fresh access_token on success, or null.
   *
   * @param {string} authApiUrl - The auth service URL from __JUAN.config
   * @param {string} instanceToken - The instance_token value
   * @param {string} refreshToken - The refresh_token_ma cookie value
   * @param {string} url - Original page URL (for Origin/Referer)
   * @returns {string|null} New access token, or null if refresh failed
   */
  async _refreshAccessToken(authApiUrl, instanceToken, refreshToken, url) {
    if (!refreshToken) {
      console.log(`[${this.name}] No refresh_token_ma cookie available — cannot refresh.`);
      return null;
    }

    // Check if the refresh token itself is expired
    if (this._isTokenExpired(refreshToken)) {
      console.log(`[${this.name}] refresh_token_ma is also expired (${this._tokenExpiryInfo(refreshToken)}).`);
      console.log(`[${this.name}] Both tokens are stale — a fresh browser login + cookie export is required.`);
      return null;
    }

    const origin = new URL(url).origin;
    const headers = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: origin,
      Referer: url,
    };
    if (instanceToken) headers['Instance'] = instanceToken;

    const renewUrl = `${authApiUrl}/v1/authenticate/renew`;
    console.log(`[${this.name}] Calling ${renewUrl} ...`);

    try {
      const resp = await got.post(renewUrl, {
        headers,
        body: JSON.stringify({ refreshToken }),
        throwHttpErrors: false,
        timeout: { request: 15000 },
      });

      if (resp.statusCode === 200 || resp.statusCode === 201) {
        const data = JSON.parse(resp.body);
        const newToken = data.access_token;
        if (newToken && !this._isTokenExpired(newToken)) {
          console.log(
            `[${this.name}] Token refreshed successfully ` +
            `(expires_in: ${data.expires_in || '?'}s, ` +
            `refresh_expires_in: ${data.refresh_expires_in || '?'}s)`
          );
          return newToken;
        }
        console.log(`[${this.name}] Auth renew returned 200 but token is unusable.`);
      } else {
        // Parse error details
        try {
          const errData = JSON.parse(resp.body);
          const errArr = Array.isArray(errData) ? errData : [errData];
          const msg = errArr.map(e => `${e.code}: ${e.message}`).join('; ');
          console.log(`[${this.name}] Auth renew failed (HTTP ${resp.statusCode}): ${msg}`);
        } catch {
          console.log(`[${this.name}] Auth renew failed (HTTP ${resp.statusCode})`);
        }
      }
    } catch (e) {
      console.log(`[${this.name}] Auth renew request failed: ${e.message}`);
    }

    return null;
  }

  /* ─── HLS parsing ─────────────────────────────────────────────── */

  /** Parse an HLS master playlist and return per-quality format entries (with retries). */
  async _parseHlsMaster(masterUrl, headers) {
    const formats = [];
    for (let attempt = 1; attempt <= API_MAX_RETRIES; attempt++) {
      try {
        const resp = await got(masterUrl, {
          headers,
          timeout: { request: 15000 },
          followRedirect: true,
        });
        const lines = resp.body.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line.startsWith('#EXT-X-STREAM-INF')) continue;

          const bwMatch = line.match(/BANDWIDTH=(\d+)/);
          const resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/);
          let streamUrl = (lines[i + 1] || '').trim();
          if (!streamUrl || streamUrl.startsWith('#')) continue;

          if (!streamUrl.startsWith('http')) {
            streamUrl = masterUrl.substring(0, masterUrl.lastIndexOf('/') + 1) + streamUrl;
          }

          const width = resMatch ? parseInt(resMatch[1]) : 0;
          const height = resMatch ? parseInt(resMatch[2]) : 0;
          const bandwidth = bwMatch ? parseInt(bwMatch[1]) : 0;

          formats.push({
            quality: height ? `${height}p` : 'hls',
            url: streamUrl,
            width,
            height,
            bitrate: bandwidth,
            format_id: `hls-${height || 'auto'}p`,
            ext: 'm3u8',
            protocol: 'hls',
            headers,
            hasVideo: true,
            hasAudio: true,
          });
        }
        break; // success
      } catch (e) {
        console.log(`[Brazzers] HLS playlist attempt ${attempt}/${API_MAX_RETRIES} failed: ${e.message}`);
        if (attempt < API_MAX_RETRIES) await this._sleep(API_RETRY_DELAY_MS);
      }
    }
    return formats;
  }

  /* ─── Main extraction ─────────────────────────────────────────── */

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    const sceneId = this._extractSceneId(url);
    if (!sceneId) {
      throw new Error(`Could not extract scene ID from URL: ${url}`);
    }

    const hostname = new URL(url).hostname;
    const origin = new URL(url).origin;

    // ── Cookies ────────────────────────────────────────────────────
    const cookies = options.cookies || [];
    if (!cookies.length) {
      console.log(`[${this.name}] WARNING: No cookies provided — Brazzers requires authentication.`);
      console.log(`[${this.name}] Usage: videodl download --cookies cookies/cookies.txt "${url}"`);
    }

    let instanceToken = this._findCookie(cookies, 'instance_token', hostname)?.value || '';
    let accessToken = this._findCookie(cookies, 'access_token_ma', hostname)?.value || '';

    if (!instanceToken) console.log(`[${this.name}] WARNING: No instance_token cookie found.`);
    if (!accessToken) {
      console.log(`[${this.name}] WARNING: No access_token_ma cookie found — video sources will be limited.`);
    }

    // Early JWT expiry check — detect stale tokens before wasting time on API calls
    let tokenWasRefreshed = false;
    if (accessToken && this._isTokenExpired(accessToken)) {
      console.log(`[${this.name}] WARNING: access_token_ma JWT has expired (${this._tokenExpiryInfo(accessToken)}).`);
    }

    const isWww = this._isWwwUrl(url);
    const slug = this._extractSlug(url);

    // ── Step 1: Fetch Page & detect API URL from __JUAN config ─────
    //    Brazzers can serve interstitial ad pages or the player can
    //    fail to load, so we retry a few times with a small delay.
    console.log(`[${this.name}] Fetching page to detect API configuration...`);
    let dataApiUrl = DEFAULT_DATA_API;
    let authApiUrl = DEFAULT_AUTH_API;
    let pageTitle = null;

    for (let attempt = 1; attempt <= PAGE_FETCH_MAX_RETRIES; attempt++) {
      try {
        const cookieHeader = buildCookieHeader(cookies, url);
        const pageResp = await got(url, {
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'text/html,application/xhtml+xml',
            ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          },
          timeout: { request: 30000 },
          followRedirect: true,
          throwHttpErrors: false,
        });

        if (pageResp.statusCode === 200) {
          const html = pageResp.body;

          // Detect ad / interstitial pages and retry after a delay
          if (this._isAdPage(html)) {
            console.log(`[${this.name}] Ad/interstitial page detected (attempt ${attempt}/${PAGE_FETCH_MAX_RETRIES}), retrying...`);
            if (attempt < PAGE_FETCH_MAX_RETRIES) {
              await this._sleep(PAGE_FETCH_RETRY_DELAY_MS);
              continue;
            }
            console.log(`[${this.name}] WARNING: Could not bypass ad page after ${PAGE_FETCH_MAX_RETRIES} attempts, continuing with defaults.`);
            break;
          }

          // Parse __JUAN.config
          const cfgMatch = html.match(
            /__JUAN\.config\s*=\s*(\{[\s\S]*?\})\s*;?\s*(?:<\/script>|window\.)/
          );
          if (cfgMatch) {
            try {
              const cfg = JSON.parse(cfgMatch[1]);
              if (cfg.dataApiUrl) {
                dataApiUrl = this._decodeEntities(cfg.dataApiUrl);
                console.log(`[${this.name}] Data API: ${dataApiUrl}`);
              }
              if (cfg.authApiUrl) {
                authApiUrl = this._decodeEntities(cfg.authApiUrl);
                console.log(`[${this.name}] Auth API: ${authApiUrl}`);
              }
            } catch { /* use default */ }
          }

          // Capture instance_token from Set-Cookie when user cookies
          // don't have one (common for www.brazzers.com URLs)
          if (!instanceToken) {
            const setCookies = pageResp.headers['set-cookie'] || [];
            for (const c of (Array.isArray(setCookies) ? setCookies : [setCookies])) {
              const m = c.match(/instance_token=([^;]+)/);
              if (m) {
                instanceToken = m[1];
                console.log(`[${this.name}] Obtained instance_token from page response`);
                break;
              }
            }
          }

          // Title from <meta og:title>
          const ogTitle = html.match(
            /<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i
          );
          if (ogTitle) {
            const t = this._decodeEntities(ogTitle[1]).trim();
            if (t && !t.toLowerCase().includes('cookie') && t.length > 3) {
              pageTitle = t;
            }
          }
          break; // success — got a valid page
        }

        // Non-200 status — retry
        console.log(`[${this.name}] Page returned HTTP ${pageResp.statusCode} (attempt ${attempt}/${PAGE_FETCH_MAX_RETRIES})`);
        if (attempt < PAGE_FETCH_MAX_RETRIES) await this._sleep(PAGE_FETCH_RETRY_DELAY_MS);
      } catch (e) {
        console.log(`[${this.name}] Page fetch attempt ${attempt}/${PAGE_FETCH_MAX_RETRIES} failed: ${e.message}`);
        if (attempt < PAGE_FETCH_MAX_RETRIES) await this._sleep(PAGE_FETCH_RETRY_DELAY_MS);
      }
    }

    // ── Step 2: Call the Aylo releases API ──────────────────────────
    console.log(`[${this.name}] Fetching release data for scene ${sceneId}...`);

    // Find refresh token cookie for potential Aylo auth renewal
    const refreshTokenCookie = this._findCookie(cookies, 'refresh_token_ma', hostname);
    let refreshToken = refreshTokenCookie?.value || '';
    // _findCookie now checks cookie expiry — also look without expiry filter
    if (!refreshToken) {
      const rtFallback = cookies.find(c => c.name === 'refresh_token_ma' &&
        (hostname.includes(c.domain.replace(/^\./, '')) ||
         c.domain.replace(/^\./, '').includes(hostname.split('.').slice(-2).join('.'))));
      if (rtFallback) refreshToken = rtFallback.value;
    }

    // If we already know the token is expired, try to refresh *before* the API call
    if (accessToken && this._isTokenExpired(accessToken)) {
      const newToken = await this._refreshAccessToken(authApiUrl, instanceToken, refreshToken, url);
      if (newToken) {
        accessToken = newToken;
        tokenWasRefreshed = true;
        console.log(`[${this.name}] Proactively refreshed expired token before API call.`);
      }
    }

    const apiHeaders = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      Origin: origin,
      Referer: url,
    };
    if (instanceToken) apiHeaders['Instance'] = instanceToken;
    if (accessToken) apiHeaders['Authorization'] = `Bearer ${accessToken}`;

    let release;
    let resolvedId = sceneId;

    // 2a. Try direct release lookup by sceneId (with retries)
    for (const apiVersion of ['/v2/releases/', '/v1/releases/']) {
      for (let attempt = 1; attempt <= API_MAX_RETRIES; attempt++) {
        try {
          const apiUrl = `${dataApiUrl}${apiVersion}${sceneId}`;
          const apiResp = await got(apiUrl, {
            headers: apiHeaders,
            timeout: { request: 15000 },
            throwHttpErrors: false,
          });

          if (apiResp.statusCode === 401) {
            throw new Error(
              'Authentication failed (HTTP 401). Your access_token_ma cookie has expired. ' +
              'Log in to Brazzers in your browser, re-export cookies.txt, and try again.'
            );
          }
          if (apiResp.statusCode === 429) {
            console.log(`[${this.name}] Rate-limited (HTTP 429) on ${apiVersion}${sceneId}, attempt ${attempt}/${API_MAX_RETRIES}`);
            if (attempt < API_MAX_RETRIES) {
              await this._sleep(API_RETRY_DELAY_MS * attempt); // increasing backoff
              continue;
            }
            break;
          }
          if (apiResp.statusCode >= 500) {
            console.log(`[${this.name}] Server error (HTTP ${apiResp.statusCode}) on ${apiVersion}${sceneId}, attempt ${attempt}/${API_MAX_RETRIES}`);
            if (attempt < API_MAX_RETRIES) {
              await this._sleep(API_RETRY_DELAY_MS * attempt);
              continue;
            }
            break;
          }
          if (apiResp.statusCode !== 200) break; // 404 etc — skip to next apiVersion

          const data = JSON.parse(apiResp.body);
          release = data.result || data;
          break;
        } catch (e) {
          if (e.message.includes('Authentication failed')) throw e;
          console.log(`[${this.name}] API ${apiVersion}${sceneId} attempt ${attempt}/${API_MAX_RETRIES} failed: ${e.message}`);
          if (attempt < API_MAX_RETRIES) await this._sleep(API_RETRY_DELAY_MS);
        }
      }
      if (release) break;
    }

    // 2b. Fallback: search by slug when direct lookup fails
    //     (www.brazzers.com uses content IDs which differ from API release IDs)
    if (!release && slug) {
      console.log(`[${this.name}] Direct ID lookup failed, searching by slug "${slug}"...`);
      for (let attempt = 1; attempt <= API_MAX_RETRIES; attempt++) {
        try {
          const searchUrl = `${dataApiUrl}/v2/releases?search=${encodeURIComponent(slug)}&limit=5&type=scene`;
          const searchResp = await got(searchUrl, {
            headers: apiHeaders,
            timeout: { request: 15000 },
            throwHttpErrors: false,
          });

          if (searchResp.statusCode === 429 || searchResp.statusCode >= 500) {
            console.log(`[${this.name}] Slug search HTTP ${searchResp.statusCode}, attempt ${attempt}/${API_MAX_RETRIES}`);
            if (attempt < API_MAX_RETRIES) {
              await this._sleep(API_RETRY_DELAY_MS * attempt);
              continue;
            }
            break;
          }

          if (searchResp.statusCode === 200) {
            const searchData = JSON.parse(searchResp.body);
            const results = searchData.result || searchData;

            if (Array.isArray(results) && results.length > 0) {
              // Prefer exact type=scene match
              const scene = results.find(r => r.type === 'scene') || results[0];
              release = scene;
              resolvedId = String(scene.id);
              console.log(`[${this.name}] Found via search: "${scene.title}" (release ID ${resolvedId})`);
            }
          }
          break; // got a valid response (even if 0 results)
        } catch (e) {
          console.log(`[${this.name}] Slug search attempt ${attempt}/${API_MAX_RETRIES} failed: ${e.message}`);
          if (attempt < API_MAX_RETRIES) await this._sleep(API_RETRY_DELAY_MS);
        }
      }
    }

    if (!release) {
      throw new Error(
        `Could not fetch scene data for ID ${sceneId}${slug ? ` (also searched "${slug}")` : ''}. ` +
        'Make sure the URL is correct and cookies are valid.'
      );
    }
    if (resolvedId !== sceneId) {
      console.log(`[${this.name}] Resolved release ID: ${resolvedId} (from slug search)`);
    }

    // ── Step 3: Extract title ──────────────────────────────────────
    const title =
      (release.title ? this._decodeEntities(release.title) : null) ||
      pageTitle ||
      `brazzers_scene_${sceneId}`;
    console.log(`[${this.name}] Title: ${title}`);

    // ── Step 4: Check auth quality & attempt token refresh ────────
    // Extract duration from release data (seconds)
    const duration = release.duration || release.totalDuration || 0;

    let hasFullVideo = !!(release.videos && release.videos.full);

    if (!hasFullVideo && accessToken) {
      console.log(`[${this.name}] WARNING: Token present but no full-scene videos returned.`);

      if (this._isTokenExpired(accessToken)) {
        // Token is expired — try to refresh and re-fetch
        console.log(`[${this.name}] Token ${this._tokenExpiryInfo(accessToken)}. Attempting refresh...`);

        const newToken = await this._refreshAccessToken(authApiUrl, instanceToken, refreshToken, url);

        if (newToken) {
          accessToken = newToken;
          tokenWasRefreshed = true;
          apiHeaders['Authorization'] = `Bearer ${accessToken}`;

          // Re-fetch the release data with the refreshed token
          console.log(`[${this.name}] Re-fetching release data with refreshed token...`);
          for (const apiVersion of ['/v2/releases/', '/v1/releases/']) {
            try {
              const apiUrl = `${dataApiUrl}${apiVersion}${resolvedId}`;
              const apiResp = await got(apiUrl, {
                headers: apiHeaders,
                timeout: { request: 15000 },
                throwHttpErrors: false,
              });
              if (apiResp.statusCode === 200) {
                const data = JSON.parse(apiResp.body);
                release = data.result || data;
                hasFullVideo = !!(release.videos && release.videos.full);
                if (hasFullVideo) {
                  console.log(`[${this.name}] Token refresh worked — full video now available!`);
                }
                break;
              }
            } catch { /* try next version */ }
          }
        }

        if (!hasFullVideo) {
          console.log(`[${this.name}] ERROR: Your session/token has expired and could not be refreshed.`);
          console.log(`[${this.name}] → Log in to Brazzers in your browser, re-export cookies.txt, and try again.`);
          throw new Error(
            'Authentication expired: only the trailer is available. ' +
            'Re-export your cookies.txt from a logged-in browser session and try again.'
          );
        }
      } else {
        // Token is still valid but API has no full video — account lacks subscription
        console.log(`[${this.name}] Token is still valid (${this._tokenExpiryInfo(accessToken)}) but API returned no full video.`);

        // Decode JWT to show subscription status
        try {
          const payload = this._decodeJwtPayload(accessToken);
          const roles = payload?.realm_access?.roles || [];
          console.log(`[${this.name}] JWT roles: ${roles.join(', ')}`);
          if (payload?.email) console.log(`[${this.name}] Account: ${payload.email}`);
        } catch { /* ignore */ }

        console.log(`[${this.name}] ERROR: This account does not have an active subscription.`);
        console.log(`[${this.name}] Only the trailer/preview will be available.`);
        console.log(`[${this.name}] → Use a subscribed account, or run: videodl browser-login "${url}"`);
        throw new Error(
          'No subscription: this account only has access to trailers. ' +
          'Log in with an account that has an active Brazzers subscription. ' +
          'Use "videodl browser-login <url>" to log in with a different account.'
        );
      }
    }

    // ── Step 5: Build format list ──────────────────────────────────
    const formats = [];
    const streamHeaders = {
      'User-Agent': USER_AGENT,
      Referer: url,
      Origin: origin,
    };
    const cookieHeader = buildCookieHeader(cookies, url);
    if (cookieHeader) streamHeaders['Cookie'] = cookieHeader;

    /**
     * Process one file entry from videos.<type>.files.
     * Each file has: { format, type, codec, fps, sizeBytes, urls: { view, download } }
     */
    const processFile = (file, videoType) => {
      if (!file || !file.urls) return;

      const viewUrl = file.urls.view || file.urls.download;
      if (!viewUrl) return;

      const label = file.format || file.label || '';
      const h = this.parseResolution(label);

      if (file.type === 'hls') {
        formats.push({
          quality: h ? `${h}p` : 'hls',
          url: viewUrl,
          height: h,
          width: h ? Math.round(h * 16 / 9) : 0,
          format_id: `${videoType}-hls-${label}`,
          ext: 'm3u8',
          protocol: 'hls',
          headers: streamHeaders,
          hasVideo: true,
          hasAudio: true,
        });
      } else {
        // type "http" or other direct download
        formats.push({
          quality: h ? `${h}p` : label || 'mp4',
          url: viewUrl,
          height: h,
          width: h ? Math.round(h * 16 / 9) : 0,
          filesize: file.sizeBytes || 0,
          format_id: `${videoType}-${file.codec || 'h264'}-${label}`,
          ext: 'mp4',
          protocol: 'https',
          headers: streamHeaders,
          hasVideo: true,
          hasAudio: true,
          codec: file.codec,
          fps: file.fps,
        });
      }
    };

    // Prefer "full" (the actual scene), fall back to "mediabook" (trailer)
    let usedType = null;
    for (const vType of ['full', 'mediabook']) {
      const videoGroup = release.videos?.[vType];
      if (!videoGroup?.files) continue;

      usedType = vType;
      const files = videoGroup.files;

      if (Array.isArray(files)) {
        files.forEach(f => processFile(f, vType));
      } else if (typeof files === 'object') {
        Object.values(files).forEach(f => processFile(f, vType));
      }

      if (formats.length > 0) break;
    }

    if (usedType === 'mediabook' && formats.length > 0) {
      // Check max file size — trailers are typically 2-10 MB, full scenes are 500 MB+
      const maxSize = Math.max(0, ...formats.map(f => f.filesize || 0));
      const sizeInfo = maxSize > 0 ? ` (largest file: ${(maxSize / 1024 / 1024).toFixed(1)} MB)` : '';
      console.log(
        `[${this.name}] ERROR: Only the trailer/preview is available${sizeInfo}. ` +
        'Full video requires valid member cookies.'
      );
      throw new Error(
        `Only the trailer is available${sizeInfo}. ` +
        'Your session has expired or you do not have access to this scene. ' +
        'Log in to Brazzers, re-export cookies.txt, and try again.'
      );
    }

    // ── Step 6: Expand HLS master playlists ────────────────────────
    const hlsMasters = formats.filter(f => f.protocol === 'hls');
    for (const master of hlsMasters) {
      try {
        const hlsFormats = await this._parseHlsMaster(master.url, streamHeaders);
        if (hlsFormats.length > 0) {
          const idx = formats.indexOf(master);
          formats.splice(idx, 1, ...hlsFormats);
        }
      } catch {
        /* keep the master entry as-is if parsing fails */
      }
    }

    console.log(`[${this.name}] Found ${formats.length} format(s)`);

    if (formats.length === 0) {
      throw new Error(
        'No video formats found. Your cookies have likely expired. ' +
        'Log in to Brazzers in your browser, export cookies.txt, and try again.'
      );
    }

    return {
      id: sceneId,
      title,
      duration,
      formats,
      url,
      extractor: this.name,
    };
  }
}

export default BrazzersExtractor;
