/**
 * videodl-cli
 * Main entry point for programmatic usage
 */

export { VideoDownloader } from './downloader.js';
export { VideoConverter } from './converter.js';
export { extractVideoInfo, getExtractor, listSupportedSites, listExtractors } from './extractors/index.js';

// Re-export for convenience
export default {
  VideoDownloader: () => import('./downloader.js').then(m => m.VideoDownloader),
  VideoConverter: () => import('./converter.js').then(m => m.VideoConverter)
};
