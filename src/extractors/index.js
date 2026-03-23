/**
 * Extractor Registry
 * Manages all site-specific extractors
 */

import { DirectExtractor } from './direct.js';
import { YouTubeExtractor } from './youtube.js';
import { XHamsterExtractor } from './xhamster.js';
import { PornHubExtractor } from './pornhub.js';
import { XVideosExtractor } from './xvideos.js';
import { XNXXExtractor } from './xnxx.js';
import { YouPornExtractor } from './youporn.js';
import { RedTubeExtractor } from './redtube.js';
import { Tube8Extractor } from './tube8.js';
import { KVSExtractor } from './kvs.js';
import { IndavideoExtractor } from './indavideo.js';
import { VideaExtractor } from './videa.js';
import { VimeoExtractor } from './vimeo.js';
import { FacebookExtractor } from './facebook.js';
import { MotherlessExtractor } from './motherless.js';
import { UncensoredHentaiExtractor } from './uncensoredhentai.js';
import { InPornExtractor } from './inporn.js';
import { TnaFluxExtractor } from './tnaflux.js';
import { TubeSafariExtractor } from './tubesafari.js';
import { PornOneExtractor } from './pornone.js';
import { PornZogExtractor } from './pornzog.js';
import { BrazzersExtractor } from './brazzers.js';
import { DailymotionExtractor } from './dailymotion.js';
import { StreamableExtractor } from './streamable.js';
import { RedditExtractor } from './reddit.js';
import { RumbleExtractor } from './rumble.js';
import { BitchuteExtractor } from './bitchute.js';
import { TwitchExtractor } from './twitch.js';
import { TwitterExtractor } from './twitter.js';
import { TikTokExtractor } from './tiktok.js';
import { InstagramExtractor } from './instagram.js';
import { OdyseeExtractor } from './odysee.js';
import { ImgurExtractor } from './imgur.js';
import { NineGagExtractor } from './9gag.js';
import { EpornerExtractor } from './eporner.js';
import { SpankBangExtractor } from './spankbang.js';
import { NoodleMagazineExtractor } from './noodlemagazine.js';
import { AShemaleTubeExtractor } from './ashemaletube.js';
import { EromeExtractor } from './erome.js';
import { YtdlpExtractor } from './ytdlp.js';

// Registry of all extractors
const EXTRACTORS = [
  YouTubeExtractor,
  XHamsterExtractor,
  PornHubExtractor,
  XVideosExtractor,
  XNXXExtractor,
  YouPornExtractor,
  RedTubeExtractor,
  Tube8Extractor,
  KVSExtractor,
  IndavideoExtractor,
  VideaExtractor,
  VimeoExtractor,
  FacebookExtractor,
  MotherlessExtractor,
  UncensoredHentaiExtractor,
  InPornExtractor,
  TnaFluxExtractor,
  TubeSafariExtractor,
  PornOneExtractor,
  PornZogExtractor,
  BrazzersExtractor,
  DailymotionExtractor,
  StreamableExtractor,
  RedditExtractor,
  RumbleExtractor,
  BitchuteExtractor,
  TwitchExtractor,
  TwitterExtractor,
  TikTokExtractor,
  InstagramExtractor,
  OdyseeExtractor,
  ImgurExtractor,
  NineGagExtractor,
  EpornerExtractor,
  SpankBangExtractor,
  NoodleMagazineExtractor,
  AShemaleTubeExtractor,
  EromeExtractor,
  YtdlpExtractor,  // yt-dlp fallback for 1000+ additional sites
  DirectExtractor  // Always try direct URL last
];

/**
 * Get appropriate extractor for URL
 * @param {string} url - URL to extract from
 * @returns {BaseExtractor} Extractor instance
 */
export function getExtractor(url) {
  for (const ExtractorClass of EXTRACTORS) {
    if (ExtractorClass.canHandle(url)) {
      return new ExtractorClass();
    }
  }
  
  throw new Error('No extractor found for URL. The URL may not be supported.');
}

/**
 * Extract video info from URL
 * @param {string} url - URL to extract from
 * @param {Object} options - Extraction options
 * @returns {Promise<Object>} Video info
 */
export async function extractVideoInfo(url, options = {}) {
  const extractor = getExtractor(url);
  const info = await extractor.extract(url, options);
  if (info.title) info.title = info.title.replace(/'/g, '');
  if (info.entries) {
    for (const entry of info.entries) {
      if (entry.title) entry.title = entry.title.replace(/'/g, '');
    }
  }
  return info;
}

/**
 * List all supported sites
 * @returns {Array<string>} List of supported site names
 */
export function listSupportedSites() {
  return EXTRACTORS
    .filter(E => E !== DirectExtractor)
    .map(E => new E().name);
}

/**
 * List all extractors with detailed information
 * @returns {Array<Object>} List of extractor info objects
 */
export function listExtractors() {
  // Hand-curated URL descriptions for cleaner display
  const URL_DESCRIPTIONS = {
    'YouTube':           'youtube.com, youtu.be',
    'XHamster':          'xhamster.com',
    'PornHub':           'pornhub.com',
    'XVideos':           'xvideos.com',
    'XNXX':              'xnxx.com',
    'YouPorn':           'youporn.com',
    'RedTube':           'redtube.com',
    'Tube8':             'tube8.com',
    'KVS':               'KVS-powered sites (blowjobs.pro, ...)',
    'Indavideo':         'indavideo.hu',
    'Videa':             'videa.hu, videakid.hu',
    'Vimeo':             'vimeo.com',
    'Facebook':          'facebook.com, fb.watch',
    'Motherless':        'motherless.com',
    'UncensoredHentai':  'uncensoredhentai.xxx',
    'InPorn':            'inporn.com',
    'TnaFlux':           'tnaflix.com, empflix.com',
    'TubeSafari':        'tubesafari.com (XHamster embeds)',
    'PornOne':           'pornone.com',
    'PornZog':           'pornzog.com (HClips embeds)',
    'Brazzers':          'brazzers.com, site-ma.brazzers.com (needs cookies)',
    'Dailymotion':       'dailymotion.com, dai.ly',
    'Streamable':        'streamable.com',
    'Reddit':            'reddit.com, v.redd.it',
    'Rumble':            'rumble.com',
    'Bitchute':          'bitchute.com',
    'Twitch':            'twitch.tv clips & VODs, clips.twitch.tv',
    'Twitter':           'twitter.com, x.com',
    'TikTok':            'tiktok.com, vm.tiktok.com',
    'Instagram':         'instagram.com (posts, reels, IGTV)',
    'Odysee':            'odysee.com (LBRY)',
    'Imgur':             'imgur.com (video/gifv)',
    '9GAG':              '9gag.com (video posts)',
    'Eporner':           'eporner.com',
    'SpankBang':         'spankbang.com',
    'NoodleMagazine':    'noodlemagazine.com',
    'AShemaleTube':      'ashemaletube.com',
    'yt-dlp':            'yt-dlp fallback (1000+ sites — requires yt-dlp installed)',
    'Direct':            'Direct video URLs (.mp4, .mkv, .webm, .m3u8, ...)',
  };

  return EXTRACTORS.map(E => {
    const instance = new E();
    return {
      name: instance.name,
      className: E.name,
      isDirect: E === DirectExtractor,
      pattern: URL_DESCRIPTIONS[instance.name] || '(unknown)',
    };
  });
}

export { DirectExtractor, YtdlpExtractor, XHamsterExtractor, YouPornExtractor, RedTubeExtractor, Tube8Extractor, KVSExtractor, BrazzersExtractor };
