/**
 * Brazzers Cookie Extractor
 *
 * Automates browser-based login for Brazzers and other Aylo (formerly
 * MindGeek) network sites: RealityKings, Mofos, Babes, Twistys,
 * Digital Playground, FakeHub, Sean Cody, Men.com, TransAngels,
 * WhyNotBi, etc.
 *
 * Re-exports the Aylo login handler as the Brazzers cookie extractor.
 */

export { AyloLoginHandler as BrazzersCookieExtractor } from './aylo.js';

/** URL pattern that this cookie extractor handles. */
export const URL_PATTERN = /brazzers\.com|realitykings\.com|mofos\.com|babes\.com|twistys\.com|digitalplayground\.com|fakehub\.com|seancody\.com|men\.com|transangels\.com|whynotbi\.com/i;

/** The primary auth cookie name to check for expiry. */
export const AUTH_COOKIE_NAME = 'access_token_ma';

/** Domains whose cookies are relevant for this extractor. */
export const RELEVANT_DOMAINS = ['brazzers.com', 'project1service.com', 'project1content.com'];
