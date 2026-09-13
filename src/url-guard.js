/**
 * URL guard — refuse to fetch private / internal network addresses (SSRF defence).
 *
 * videodl is driven by URLs that come from users, and in the VideoDL container from
 * *any authenticated web-UI user*. Without this guard such a user can make the
 * container fetch `http://127.0.0.1:…`, `http://10.x…`, `http://169.254.169.254/…`
 * etc., save the response as a "video" and download it — an internal-network read
 * primitive. The guard:
 *
 *   - accepts only http(s) URLs,
 *   - rejects `localhost`, `*.localhost`, `*.local`, `*.internal`,
 *   - rejects IP literals in loopback / RFC1918 / link-local / CGNAT / multicast /
 *     reserved / documentation ranges (v4 and v6, including v4-mapped v6),
 *   - resolves hostnames and rejects if ANY returned address is private,
 *   - re-checks every redirect target via a `got` `beforeRedirect` hook.
 *
 * The policy is process-wide (`setPrivateUrlPolicy`) so the downloader and the
 * extractors do not have to thread a flag through every call. Standalone CLI users who
 * legitimately download from a NAS on their LAN pass `--allow-private-urls`; the
 * container operator sets `VIDEODL_ALLOW_PRIVATE_URLS=1` on the pod if ever needed.
 *
 * Known limit: the check resolves the name once and the HTTP client resolves it again
 * (DNS rebinding TOCTOU). ffmpeg fetches HLS segments itself and cannot be hooked; the
 * playlist URL is checked before ffmpeg starts, nested segment hosts are not.
 */

import dns from 'node:dns/promises';
import net from 'node:net';

export class PrivateUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PrivateUrlError';
    this.isPrivateUrl = true;
  }
}

let _allowPrivate = /^(1|true|yes)$/i.test(process.env.VIDEODL_ALLOW_PRIVATE_URLS || '');

/** Process-wide switch. `true` disables the guard (explicit user opt-in). */
export function setPrivateUrlPolicy(allowPrivate) {
  _allowPrivate = !!allowPrivate;
}

export function privateUrlsAllowed() {
  return _allowPrivate;
}

// [base, prefixLength]
const PRIVATE_V4 = [
  ['0.0.0.0', 8],        // "this" network
  ['10.0.0.0', 8],       // RFC1918
  ['100.64.0.0', 10],    // CGNAT (RFC6598)
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local (incl. cloud metadata 169.254.169.254)
  ['172.16.0.0', 12],    // RFC1918
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // TEST-NET-1
  ['192.168.0.0', 16],   // RFC1918
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // TEST-NET-2
  ['203.0.113.0', 24],   // TEST-NET-3
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved + broadcast
];

function v4ToInt(ip) {
  return ip.split('.').reduce((acc, octet) => ((acc << 8) + Number(octet)) >>> 0, 0) >>> 0;
}

function inV4Range(ip, [base, bits]) {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((v4ToInt(ip) & mask) >>> 0) === ((v4ToInt(base) & mask) >>> 0);
}

/**
 * True when `ip` (a v4 or v6 literal) is not a public unicast address.
 * Non-IP input returns `true` (caller must resolve first).
 */
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    return PRIVATE_V4.some(range => inV4Range(ip, range));
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();

    // IPv4-mapped (::ffff:a.b.c.d) or its hex form (::ffff:7f00:1)
    const mappedDotted = lower.match(/^(?:0*:)*ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mappedDotted) return isPrivateAddress(mappedDotted[1]);
    const mappedHex = lower.match(/^(?:0*:)*ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16);
      const lo = parseInt(mappedHex[2], 16);
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }

    if (lower === '::' || lower === '::1') return true;     // unspecified / loopback
    if (/^fe[89ab]/.test(lower)) return true;               // link-local fe80::/10
    if (/^f[cd]/.test(lower)) return true;                  // unique local fc00::/7
    if (/^ff/.test(lower)) return true;                     // multicast
    if (lower.startsWith('64:ff9b:')) return true;          // NAT64 well-known prefix
    if (lower.startsWith('2001:db8:')) return true;         // documentation
    return false;
  }
  return true;
}

function hostIsBlockedName(host) {
  const h = host.toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal');
}

/**
 * Throw `PrivateUrlError` unless `url` is an http(s) URL whose host is public.
 * Honours the process-wide policy unless `allowPrivate` is given explicitly.
 */
export async function assertPublicUrl(url, { allowPrivate = undefined, label = 'URL' } = {}) {
  if (allowPrivate === true || (allowPrivate === undefined && _allowPrivate)) return;

  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new PrivateUrlError(`${label} is not a valid URL: ${url}`);
  }

  if (!/^https?:$/i.test(parsed.protocol)) {
    throw new PrivateUrlError(`${label} uses scheme "${parsed.protocol}" — only http and https are allowed`);
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new PrivateUrlError(`${label} has no host: ${url}`);

  if (hostIsBlockedName(host)) {
    throw new PrivateUrlError(`${label} points at a local name (${host}); refusing. Use --allow-private-urls to override.`);
  }

  if (net.isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new PrivateUrlError(`${label} points at a private/internal address (${host}); refusing. Use --allow-private-urls to override.`);
    }
    return;
  }

  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    const e = new Error(`Could not resolve host "${host}": ${err.code || err.message}`);
    e.code = err.code;
    throw e;
  }
  const offender = addresses.find(a => isPrivateAddress(a.address));
  if (offender) {
    throw new PrivateUrlError(
      `${label} resolves to a private/internal address (${host} → ${offender.address}); refusing. ` +
      'Use --allow-private-urls to override.'
    );
  }
}

/**
 * `got` hooks that re-check every redirect target. Spread into request options:
 *   got(url, { ...opts, hooks: privateGuardHooks() })
 */
export function privateGuardHooks(allowPrivate = undefined) {
  return {
    beforeRedirect: [
      async (options) => {
        const target = options.url instanceof URL ? options.url.toString() : String(options.url);
        await assertPublicUrl(target, { allowPrivate, label: 'Redirect target' });
      },
    ],
  };
}
