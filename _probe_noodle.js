// Probe noodlemagazine.com /video/ listing page
import initCycleTLS from 'cycletls';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const JA3 = '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0';

async function main() {
  const cycleTLS = await initCycleTLS();
  
  const url = 'https://noodlemagazine.com/video/vicats?p=1';
  console.log(`Fetching: ${url}`);
  
  const resp = await cycleTLS(url, {
    body: '',
    ja3: JA3,
    userAgent: UA,
    headers: {
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  }, 'get');
  
  const html = await resp.text();
  console.log(`Status: ${resp.status}, Length: ${html.length}`);
  
  // Title
  const title = html.match(/<title>([^<]+)<\/title>/i)?.[1];
  console.log(`Title: ${title}`);
  
  // og:title
  const ogTitle = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i)?.[1];
  console.log(`og:title: ${ogTitle}`);
  
  // Find all video links (/watch/ URLs)
  const watchLinks = new Set();
  const linkRe = /href=["'](\/watch\/[^"']+)["']/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    watchLinks.add(m[1]);
  }
  console.log(`\nFound ${watchLinks.size} /watch/ links:`);
  for (const link of watchLinks) {
    console.log(`  https://noodlemagazine.com${link}`);
  }
  
  // Check for pagination
  const pageLinks = new Set();
  const pageRe = /href=["']([^"']*\?p=\d+)["']/gi;
  while ((m = pageRe.exec(html)) !== null) {
    pageLinks.add(m[1]);
  }
  console.log(`\nPagination links: ${[...pageLinks].join(', ')}`);
  
  // Check for video titles in the listing
  const thumbRe = /<a[^>]+href=["'](\/watch\/[^"']+)["'][^>]*>[\s\S]*?<(?:span|div)[^>]*class=["'][^"']*title[^"']*["'][^>]*>([^<]+)</gi;
  const videos = [];
  while ((m = thumbRe.exec(html)) !== null) {
    videos.push({ url: m[1], title: m[2].trim() });
  }
  if (videos.length > 0) {
    console.log(`\nVideos with titles:`);
    for (const v of videos) {
      console.log(`  ${v.title} → ${v.url}`);
    }
  }
  
  // Also try simpler title extraction from items
  const itemRe = /<a[^>]+href="(\/watch\/[^"]+)"[^>]*title="([^"]+)"/gi;
  const items2 = [];
  while ((m = itemRe.exec(html)) !== null) {
    items2.push({ url: m[1], title: m[2].trim() });
  }
  if (items2.length > 0) {
    console.log(`\nItems with title attr:`);
    for (const v of items2) {
      console.log(`  ${v.title} → ${v.url}`);
    }
  }
  
  // Look for any <a> with /watch/ that has nearby text
  const snippetRe = /<a[^>]*href="(\/watch\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets = [];
  while ((m = snippetRe.exec(html)) !== null) {
    const text = m[2].replace(/<[^>]+>/g, '').trim();
    if (text.length > 5 && text.length < 200) {
      snippets.push({ url: m[1], text });
    }
  }
  if (snippets.length > 0) {
    console.log(`\nLink snippets with text:`);
    for (const s of snippets) {
      console.log(`  "${s.text}" → ${s.url}`);
    }
  }
  
  cycleTLS.exit();
}

main().catch(e => { console.error(e); process.exit(1); });
