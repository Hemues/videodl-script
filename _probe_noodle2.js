// Check pagination and page 2 for noodlemagazine listing
import initCycleTLS from 'cycletls';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const JA3 = '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0';

async function main() {
  const cycleTLS = await initCycleTLS();

  // Check page 1 for pagination indicators
  const url1 = 'https://noodlemagazine.com/video/vicats?p=1';
  const resp1 = await cycleTLS(url1, {
    body: '', ja3: JA3, userAgent: UA,
    headers: { 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
  }, 'get');
  const html1 = await resp1.text();

  // Find pagination block
  const pagRe = /class=["'][^"']*paginat[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|nav|ul)>/gi;
  let m;
  while ((m = pagRe.exec(html1)) !== null) {
    console.log('Pagination block found:', m[0].substring(0, 300));
  }

  // More general: find all ?p= links
  const pLinks = new Set();
  const pRe = /href=["']([^"']*\?p=\d+)["']/gi;
  while ((m = pRe.exec(html1)) !== null) {
    pLinks.add(m[1]);
  }
  console.log(`\n?p= links: ${JSON.stringify([...pLinks])}`);

  // Also check for "next" or page number links
  const nextRe = /<a[^>]*class=["'][^"']*next[^"']*["'][^>]*href=["']([^"']*)["']/gi;
  while ((m = nextRe.exec(html1)) !== null) {
    console.log(`Next link: ${m[1]}`);
  }

  // Find links inside <div class="pagination ...">
  const pagDiv = html1.match(/<div[^>]*class="[^"]*pagination[^"]*"[^>]*>[\s\S]*?<\/div>/i);
  if (pagDiv) {
    console.log(`\nPagination div: ${pagDiv[0].substring(0, 500)}`);
  }
  
  // Check page 2
  const url2 = 'https://noodlemagazine.com/video/vicats?p=2';
  console.log(`\n\nFetching page 2: ${url2}`);
  const resp2 = await cycleTLS(url2, {
    body: '', ja3: JA3, userAgent: UA,
    headers: { 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
  }, 'get');
  const html2 = await resp2.text();
  console.log(`Page 2 status: ${resp2.status}, length: ${html2.length}`);

  const watchLinks2 = new Set();
  const linkRe2 = /href=["'](\/watch\/[^"']+)["']/gi;
  while ((m = linkRe2.exec(html2)) !== null) {
    watchLinks2.add(m[1]);
  }
  console.log(`Page 2 has ${watchLinks2.size} /watch/ links`);
  for (const link of watchLinks2) {
    console.log(`  https://noodlemagazine.com${link}`);
  }

  cycleTLS.exit();
}

main().catch(e => { console.error(e); process.exit(1); });
