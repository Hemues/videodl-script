# Browser-gated sites: the known mechanism

Written 2026-11-08 with CLI 2.0.142 (first site: pornhex.com, `LESSONS-LEARNED.md #31`).
Read this before adding any site whose pages answer with a Cloudflare (or similar) challenge.

## 1. The pattern in one paragraph

Some sites put **every HTML page** behind a Cloudflare *managed challenge* ("Just a
moment…", "Verifying Your Connection", HTTP 403 with `cdn-cgi/challenge-platform` in
the body). Only a real browser engine passes it: curl, Node (`got`/`fetch`) and
cycletls (Chrome JA3 impersonation) are all challenged, and the `cf_clearance` cookie
a browser earns is bound to that browser's own network fingerprint, so it cannot be
exported to another client. **The media files of such sites are usually on a separate
host that is not challenged.** So the design is split in two:

```
 page URL ──► src/browser-page.js ──► rendered HTML (+ a JS value, e.g. the player's source list)
               local headless Chrome/Chromium/Edge,           │
               DevTools protocol, throw-away profile          ▼
                                                 site extractor (src/extractors/<site>.js)
                                                 builds normal formats (url + headers)
                                                              │
                                                              ▼
                                   normal download path (got / ffmpeg) ──► file
```

The browser is used **only to read the page**. Downloads never go through it.

## 2. How to recognise a browser-gated site (decision tree)

Run every probe from the build host. Record what each step returns.

1. `curl -sS -o page.html -w '%{http_code}\n' -A 'Mozilla/5.0 …Chrome…' <page URL>`
   - 200 with real content: an ordinary site. Use `got` (see `bingato.js`). Stop.
   - 403 and `grep -c challenge-platform page.html` > 0: a challenge. Go on.
2. The same with **the home page** and `/robots.txt`. If the home page is challenged too,
   the whole zone is gated (not one path).
3. Does plain `curl` pass while Node does not? Then it is a TLS-fingerprint check, not
   a browser check: use `curl` as a subprocess (`hentaihaven.js`, LESSONS #15). Stop.
4. Does cycletls with a Chrome JA3 pass? Then use the cycletls page fetch (`spankbang.js`,
   LESSONS #2). Stop.
5. Neither passes: **browser-gated**. Load the page once with `fetchRenderedPage()`
   (section 4) and save the HTML for development.
6. Find the media URLs in that HTML (`<video src>`, `<source>`, a `var …Sources = […]`
   script, an m3u8 URL) and test the **media host** with plain curl:
   - 200/206 with `video/*`: the normal download path works. This is the pornhex case.
   - challenged as well: the media also needs the browser fingerprint. That is NOT
     covered by this mechanism yet (it would need a browser-driven download); stop and
     write it down as a new lesson before building anything.
7. Test whether the media URL needs a `Referer`, a cookie or the browser's User-Agent
   (try without each). Put only what is needed into the format's `headers`.

## 3. Why each simpler route fails (measured on pornhex.com, 2026-11-08)

| Client | Result |
| --- | --- |
| curl, HTTP/1.1 and HTTP/2, any User-Agent, two different machines | 403 challenge |
| cycletls, Chrome 131 JA3 and a Chrome JA3 with the ML-KEM extension | 403 challenge |
| curl or cycletls **with the browser's `cf_clearance` + session cookies and its exact User-Agent** | 403 challenge (clearance is fingerprint-bound) |
| headless Chromium, default User-Agent (`HeadlessChrome/…`) | stays on "Just a moment…" |
| headless Chromium, User-Agent overridden only via DevTools (`Network.setUserAgentOverride`) | stays on the challenge |
| **headless Chromium, `--user-agent=<own UA with HeadlessChrome→Chrome>` + `--disable-blink-features=AutomationControlled`** | **passes in ~3 s** |
| headed Chromium under Xvfb | passes (not needed) |

## 4. The page loader: `src/browser-page.js`

```js
import { fetchRenderedPage } from '../browser-page.js';

const page = await fetchRenderedPage(url, {
  waitFor:  "Array.isArray(window.videoSources)",   // JS expression: page is ready when truthy
  evaluate: "window.videoSources || null",          // JS expression: returned as page.value (JSON-safe)
  timeout:  90_000,
  log: (m) => console.log(`[Site] ${m}`),
});
// page = { html, title, url (final), value, userAgent, cookies }
```

What it does:

- Finds a browser: `VIDEODL_BROWSER` (path) wins, otherwise Chrome, Edge, Chromium and Brave
  in the usual install paths of Windows, macOS and Linux, and Playwright's cache on Linux
  (`findBrowser()`). No browser found: a clear error that names `VIDEODL_BROWSER`.
- Starts the browser **twice**: once to read its real User-Agent from `/json/version`, then
  with `--user-agent=<that UA with HeadlessChrome replaced by Chrome>`. This is the step that
  makes the challenge pass (section 3).
- Flags: `--headless=new --disable-blink-features=AutomationControlled --disable-gpu
  --no-first-run --disable-extensions --disable-dev-shm-usage`, a temporary
  `--user-data-dir`, `--remote-debugging-port=0` (the port is read from `DevToolsActivePort`).
  `--no-sandbox` is added only as root, inside a container, or with `VIDEODL_BROWSER_NO_SANDBOX=1`.
- Talks DevTools over Node 22's global `WebSocket` (no npm dependency; works in the SEA binaries).
- Waits until the title is no longer a challenge title, `readyState` is not `loading`, and
  `waitFor` is true; then returns. A timeout says whether the challenge or the page was the problem.
- Always kills the browser and deletes the temporary profile. The user's own browser profile,
  cookies and history are never touched.

## 5. Adding a new browser-gated site (checklist)

1. Decision tree (section 2) done; media host tested with plain curl.
2. Copy `src/extractors/pornhex.js` as the template:
   - `canHandle()` with `hostMatches(url, '<domain>')` plus a path check.
   - `fetchRenderedPage()` with a `waitFor` that names the player's data, and an `evaluate`
     that returns it.
   - Parse a fallback from the HTML too (the raw script text), so a change in timing does not
     lose the data.
   - Formats: `protocol: 'https'` (or `'hls'` for m3u8), `headers` with only what the media
     host needs.
3. Watch for **values the page script has already transformed**. On pornhex the token `k` is
   already URL-encoded (encoding it again gives 403), and after the player runs, `src` already
   carries `?h=`. Compare the URL the browser actually requested (DevTools network log) with the
   one you build.
4. Register in `src/extractors/index.js` (before `YtdlpExtractor`) with a `URL_DESCRIPTIONS` line.
5. Add an `"optional": true` case to `tests/smoke-urls.json` (third-party site).
6. Docs in the same commit: README table + count, EXTRACTORS.md entry + count, CHANGELOG,
   a LESSONS entry if anything new was learned, AGENTS gotcha.
7. Test: `python3 tests/smoke.py --source --filter <site>`, one full download
   (`node src/cli.js download <url> -f worst -d <tmp dir>`, then `ffprobe` duration vs the page),
   then `--binary dist/videodl-ffmpeg-linux` after `compile.sh`.
8. Release as usual (`UPDATE-FROM-YTDLP.md` component C). The container image already ships
   `chromium`; nothing changes there unless the browser itself needs updating.

## 6. Where a browser must exist

| Where | Browser |
| --- | --- |
| Container image (videodl-container ≥ 2.0.142) | Fedora `chromium` (installed in the Dockerfile) |
| Windows binaries | the user's Chrome or Edge (Edge is on every Windows 10/11) |
| Linux binaries | `chromium` / `google-chrome` from the distribution, or `VIDEODL_BROWSER` |
| Build host smoke | any of the above; Playwright's cache under the build user's home also works |

## 7. Working on such a site with an AI agent (Claude Code)

The agent's auto-mode safety check refuses "bot check circumvention": fetching a challenged
page with an impersonating client (a browser User-Agent on curl, cycletls, a scripted browser)
is refused unless the owner has allowed it. Ordinary work (writing the extractor, builds,
releases, deploys) is not affected. Ways to work, in order of preference:

1. **Auto mode with a standing allow rule** (one-time setup by the owner, user settings, not
   project settings: `autoMode` is read only from `~/.claude/settings.json`):

   ```json
   "autoMode": {
     "allow": [
       "$defaults",
       "Developing and running the owner's videodl downloader: loading a video site's pages through videodl's own browser page loader (src/browser-page.js, local headless Chromium) or probing them with curl/cycletls when the site answers with a Cloudflare challenge, in order to build or test an extractor; the owner downloads only content they are allowed to use"
     ]
   }
   ```

   Check it with `claude auto-mode critique`. If the category turns out to be a hard deny, an
   allow sentence cannot override it; then use option 2.
2. **Bypass permissions for the session** (VS Code: `"claudeCode.allowDangerouslySkipPermissions": true`
   as a boolean, reload, choose *Bypass permissions* in the mode picker). Nothing is checked in
   that mode, so switch back to Auto afterwards.
3. **The owner runs the first probe** (`! <command>` in the prompt) and the agent works from the
   saved HTML.

Once a site's extractor exists, running it (`videodl download <url>`) is ordinary use of the
tool and needs no special permission.

## 8. Known limits

- Media hosts that are challenged as well are not covered (section 2, step 6).
- Interactive challenges (a Turnstile box that needs a click, a CAPTCHA) are not solved; the
  loader times out with "the site's bot check did not let the browser through".
- Each page load starts a browser twice (~3–6 s on the build host). Playlists of many pages pay
  this per page; reuse one browser if a playlist extractor is ever written.
- Cloudflare changes its checks. When the loader starts timing out, rerun the table in section 3
  and update this document and LESSONS #31.
