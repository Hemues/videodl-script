/**
 * DRM detection for HLS / DASH manifests.
 *
 * videodl does NOT circumvent DRM and never will. This module only *detects*
 * DRM-encrypted streams so the CLI can stop with a clear, honest message
 * ("this title is Widevine-protected — can't download") instead of a cryptic
 * ffmpeg/decrypt failure. Detection ≠ circumvention: nothing here obtains keys
 * or decrypts anything.
 *
 * IMPORTANT — do not flag ordinary HLS AES-128. A plain `#EXT-X-KEY:
 * METHOD=AES-128` with `KEYFORMAT="identity"` (or no KEYFORMAT), key delivered
 * over HTTP(S), is standard, downloadable HLS encryption that videodl handles
 * via ffmpeg. Only SAMPLE-AES / a DRM key system / CENC counts as DRM here.
 */

// Well-known DRM system UUIDs (EME / DASH ContentProtection schemeIdUri / PSSH).
const DRM_SYSTEM_IDS = [
  { re: /edef8ba9-?79d6-?4ace-?a3c8-?27dcd51d21ed/i, name: 'Widevine' },
  { re: /9a04f079-?9840-?4286-?ab92-?e65be0885f95/i, name: 'PlayReady' },
  { re: /94ce86fb-?07ff-?4f43-?adb8-?93d2fa968ca2/i, name: 'FairPlay' },
  { re: /f239e769-?efa3-?4850-?9c16-?a903c6932efb/i, name: 'Adobe PrimeTime' },
  { re: /3d5e6d35-?9b9a-?41e8-?b843-?dd3c6e72c42c/i, name: 'ChinaDRM' },
];

// Scheme / key-system identifiers that appear as strings in manifests.
const DRM_IDENTIFIERS = [
  { re: /com\.widevine\.alpha|com\.widevine\b/i, name: 'Widevine' },
  { re: /com\.microsoft\.playready|<mspr:pro|\bplayready\b/i, name: 'PlayReady' },
  { re: /com\.apple\.streamingkeydelivery|\bfairplay\b|skd:\/\//i, name: 'FairPlay' },
];

/**
 * Scan a manifest body for DRM markers.
 * @param {string} text  manifest body (HLS `.m3u8` or DASH `.mpd`)
 * @returns {string[]|null}  detected DRM system names, or null if none / clear
 */
export function detectDrm(text) {
  if (!text || typeof text !== 'string') return null;
  const found = new Set();

  // ── System UUIDs + scheme identifiers (mostly DASH, some HLS) ──────────────
  for (const { re, name } of [...DRM_SYSTEM_IDS, ...DRM_IDENTIFIERS]) {
    if (re.test(text)) found.add(name);
  }

  // ── DASH generic CENC (encrypted even when the system is not named) ────────
  const isDash = /<mpd[\s>]/i.test(text) || /urn:mpeg:dash/i.test(text);
  if (isDash && (
      /<cenc:pssh/i.test(text) ||
      /schemeiduri\s*=\s*"urn:mpeg:dash:mp4protection:2011"/i.test(text) ||
      /<contentprotection\b/i.test(text))) {
    if (found.size === 0) found.add('CENC (Common Encryption)');
  }

  // ── HLS keys — separate real DRM from ordinary AES-128 ─────────────────────
  const keyLines = text.match(/#EXT-X-(?:SESSION-)?KEY:[^\r\n]*/gi) || [];
  for (const line of keyLines) {
    const method = (line.match(/METHOD=([A-Z0-9-]+)/i) || [])[1] || '';
    const keyformat = (line.match(/KEYFORMAT="([^"]*)"/i) || [])[1] || '';

    // Standard HLS AES-128 (identity / no keyformat) is NOT DRM — skip it.
    if (/^AES-128$/i.test(method) && (!keyformat || /^identity$/i.test(keyformat))) continue;
    if (/^NONE$/i.test(method)) continue;

    if (/streamingkeydelivery/i.test(keyformat)) found.add('FairPlay');
    else if (/edef8ba9/i.test(keyformat)) found.add('Widevine');
    else if (/9a04f079|playready/i.test(keyformat)) found.add('PlayReady');
    else if (/^SAMPLE-AES/i.test(method) || (keyformat && !/^identity$/i.test(keyformat))) {
      found.add('SAMPLE-AES DRM');
    }
  }

  return found.size ? [...found] : null;
}

/** Thrown when a download target is DRM-protected. */
export class DrmProtectedError extends Error {
  constructor(systems) {
    const list = (Array.isArray(systems) ? systems : [systems]).join(', ');
    super(`DRM-protected content (${list}). videodl does not download DRM-encrypted `
      + `streams — the video segments are encrypted and require a licensed CDM to `
      + `decrypt. Use the service's own offline-download feature instead.`);
    this.name = 'DrmProtectedError';
    this.drmSystems = Array.isArray(systems) ? systems : [systems];
    this.isDrm = true;
  }
}

export default detectDrm;
