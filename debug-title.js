import got from 'got';

const resp = await got('https://xhamster.com/videos/im-so-tired-of-this-crazy-neighbour-xhBgzdy', {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-US,en;q=0.5',
  },
  followRedirect: true,
});
const html = resp.body;

// Method 1: <title> tag
const titleMatch = html.match(/<title>([^<]+)<\/title>/);
console.log('TITLE TAG MATCH:', titleMatch ? JSON.stringify(titleMatch[1]) : 'null');

// Method 2: og:title
const ogMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
console.log('OG:TITLE MATCH:', ogMatch ? JSON.stringify(ogMatch[1]) : 'null');

// Raw og:title line
const ogLine = html.match(/<meta[^>]*og:title[^>]*/i);
console.log('OG:TITLE RAW:', ogLine ? ogLine[0] : 'null');

// Check for window.initials title
const initialsMatch = html.match(/window\.initials\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
if (initialsMatch) {
  try {
    const initials = JSON.parse(initialsMatch[1]);
    console.log('INITIALS TITLE:', JSON.stringify(initials.videoModel?.title));
  } catch (e) {
    console.log('INITIALS PARSE ERROR:', e.message);
  }
}
