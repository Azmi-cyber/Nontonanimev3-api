const cfg = require('./config');
const { NOT_VIDEO } = require('./streams');

let browserPromise = null;
let active = 0;
const queue = [];
const MAX_PAGES = 2;

const acquire = () => new Promise((res) => { if (active < MAX_PAGES) { active++; res(); } else queue.push(res); });
const release = () => { const n = queue.shift(); if (n) n(); else active--; };

async function launch() {
  const pptr = require('puppeteer-core');

  let executablePath = cfg.CHROME_PATH;
  let args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--lang=id-ID'];
  let headless = 'new';

  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    const chromium = require('@sparticuz/chromium');
    executablePath = await chromium.executablePath();
    args = [...chromium.args, '--lang=id-ID'];
    headless = chromium.headless;
  } else if (!executablePath) {
    try { executablePath = require('puppeteer').executablePath(); }
    catch { throw new Error('Chrome tidak ditemukan. Install "puppeteer" atau set CHROME_PATH.'); }
  }

  const p = cfg.browserProxy;
  if (p) args.push(`--proxy-server=${p.protocol}://${p.host}:${p.port}`);

  return pptr.launch({ executablePath, args, headless, defaultViewport: { width: 1366, height: 768 } });
}

async function getBrowser() {
  if (browserPromise) {
    try { const b = await browserPromise; if (b.connected ?? b.isConnected()) return b; } catch {}
    browserPromise = null;
  }
  browserPromise = launch();
  return browserPromise;
}


// Patch anti-deteksi manual (pengganti puppeteer-extra-plugin-stealth, aman untuk bundler serverless)
const STEALTH = () => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['id-ID', 'id', 'en-US', 'en'] });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  window.chrome = window.chrome || { runtime: {}, loadTimes() {}, csi() {}, app: {} };
  const q = window.navigator.permissions && window.navigator.permissions.query;
  if (q) window.navigator.permissions.query = (p) => (p && p.name === 'notifications' ? Promise.resolve({ state: Notification.permission }) : q.call(window.navigator.permissions, p));
  const patchGL = (proto) => {
    const g = proto.getParameter;
    proto.getParameter = function (p) {
      if (p === 37445) return 'Intel Inc.';
      if (p === 37446) return 'Intel Iris OpenGL Engine';
      return g.call(this, p);
    };
  };
  try { patchGL(WebGLRenderingContext.prototype); patchGL(WebGL2RenderingContext.prototype); } catch (_) {}
};

const MEDIA_RE = /\.(m3u8|mp4|mpd|webm)(\?|#|$)/i;
// Domain iklan/popup umum -> diblok di level browser supaya video iklan tidak pernah termuat
const AD_HOST_RE = /(doubleclick|googlesyndication|googleadservices|adservice|popads|popcash|propellerads|exoclick|juicyads|adsterra|histats|onclickads|clickadu|hilltopads|trafficjunky|adnxs|taboola|outbrain)/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Buka tab baru lengkap dengan proxy-auth, stealth, UA, dan anti-popup
async function openPage(browser, { blockImages = true, onRequest } = {}) {
  const page = await browser.newPage();
  const p = cfg.browserProxy;
  if (p && p.username) await page.authenticate({ username: p.username, password: p.password });
  await page.evaluateOnNewDocument(STEALTH);
  await page.setUserAgent(cfg.UA);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8' });
  page.on('popup', (pp) => pp.close().catch(() => {}));
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const t = req.resourceType(); const u = req.url();
    if (onRequest) onRequest(u, t);
    if (AD_HOST_RE.test(u)) return req.abort().catch(() => {});
    if (blockImages && (t === 'image' || t === 'font' || t === 'media')) return req.abort().catch(() => {});
    req.continue().catch(() => {});
  });
  return page;
}

async function passChallenge(page) {
  for (let i = 0; i < 25; i++) {
    const title = (await page.title().catch(() => '')) || '';
    const html = await page.content().catch(() => '');
    const blocked = /just a moment|attention required|checking your browser/i.test(title) || /cf-challenge|challenge-platform|cf-turnstile/i.test(html);
    if (!blocked) return;
    await sleep(1000);
  }
}

/**
 * Buka halaman dengan Chromium stealth + proxy, tembus challenge Cloudflare,
 * lalu kembalikan HTML, semua respons JSON (XHR/fetch), URL media & iframe.
 */
async function fetchPage(url, { timeout = 30000, tryPlay = false } = {}) {
  await acquire();
  let page;
  try {
    const browser = await getBrowser();
    const out = { url, finalUrl: url, html: '', json: [], media: [], hostHits: [], iframes: [], blocked: false, requests: [] };
    const pending = [];
    page = await openPage(browser, { onRequest: (u, t) => {
      if (MEDIA_RE.test(u)) out.media.push(u);
      if (cfg.STREAM_HOST_RE.test(u) && !NOT_VIDEO.test(u)) out.hostHits.push(u);
      if (t === 'xhr' || t === 'fetch') out.requests.push(u);
    } });
    page.on('response', (res) => {
      const job = (async () => {
        try {
          const ct = res.headers()['content-type'] || '';
          const t = res.request().resourceType();
          if (!(ct.includes('json') || ((t === 'xhr' || t === 'fetch') && /text\/plain/.test(ct)))) return;
          const txt = await res.text();
          out.json.push({ url: res.url(), data: JSON.parse(txt) });
        } catch {}
      })();
      pending.push(job);
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await passChallenge(page);
    await page.waitForNetworkIdle({ idleTime: 900, timeout: 12000 }).catch(() => {});

    if (!tryPlay) {
      // pancing konten lazy: scroll + buka tab/tombol "Episode" (BUKAN tombol play)
      await page.evaluate(async () => {
        for (let i = 0; i < 6; i++) { window.scrollBy(0, document.body.scrollHeight / 3); await new Promise((r) => setTimeout(r, 250)); }
        const tab = [...document.querySelectorAll('button,[role="tab"],a,li,div')].find((e) => e.children.length < 3 && /^(daftar\s+)?episode(s)?$/i.test((e.textContent || '').trim()));
        if (tab) { try { tab.click(); } catch (_) {} }
        window.scrollTo(0, 0);
      }).catch(() => {});
      await page.waitForNetworkIdle({ idleTime: 900, timeout: 8000 }).catch(() => {});
    }

    // Klik play HANYA bila diminta (klik sembarang bisa memicu iklan)
    if (tryPlay) {
      await page.evaluate(() => {
        const el = document.querySelector('video') || document.querySelector('button[aria-label*="play" i]');
        if (el) { try { el.click(); el.play && el.play(); } catch (_) {} }
      }).catch(() => {});
      await sleep(2500);
      await page.waitForNetworkIdle({ idleTime: 800, timeout: 6000 }).catch(() => {});
    }

    await Promise.allSettled(pending);
    // data JSON inline (Next.js __NEXT_DATA__ dll.)
    const inline = await page.$$eval('script#__NEXT_DATA__, script[type="application/json"]', (a) => a.map((x) => x.textContent)).catch(() => []);
    for (const t of inline) { try { out.json.push({ url: 'inline:script', data: JSON.parse(t) }); } catch {} }
    out.title = await page.title().catch(() => '');
    out.blocked = /just a moment|attention required|checking your browser/i.test(out.title);
    out.iframes = await page.$$eval('iframe[src]', (a) => a.map((x) => x.src)).catch(() => []);
    out.hrefs = await page.$$eval('a[href]', (a) => a.map((x) => x.href)).catch(() => []);
    out.finalUrl = page.url();
    out.html = await page.content();
    return out;
  } finally {
    if (page) await page.close().catch(() => {});
    release();
  }
}

/**
 * Jalankan fetch() JSON di dalam konteks halaman situs (cookie Cloudflare ikut terbawa).
 * Dipakai untuk mengambil halaman 2..N daftar episode & API server video.
 * @returns {Promise<Array<object|null>>} urutan sama dengan urls
 */
async function fetchJsonInPage(urls) {
  if (!urls.length) return [];
  await acquire();
  let page;
  try {
    const browser = await getBrowser();
    page = await openPage(browser);
    await page.goto(cfg.BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await passChallenge(page);
    const res = await page.evaluate(async (list) => Promise.all(list.map(async (u) => {
      try {
        const r = await fetch(u, { credentials: 'include', headers: { accept: 'application/json, text/plain, */*' } });
        const t = await r.text();
        return { status: r.status, body: t };
      } catch (e) { return { status: 0, body: '' }; }
    })), urls);
    return res.map((r) => { if (r.status >= 400 || !r.body) return null; try { return JSON.parse(r.body); } catch { return null; } });
  } finally {
    if (page) await page.close().catch(() => {});
    release();
  }
}

// Ambil file (gambar) lewat Chromium bila request biasa diblok Cloudflare/hotlink
async function fetchBinary(url, referer) {
  await acquire();
  let page;
  try {
    const browser = await getBrowser();
    page = await openPage(browser, { blockImages: false });
    if (referer) await page.setExtraHTTPHeaders({ 'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8', Referer: referer });
    const res = await page.goto(url, { waitUntil: 'load', timeout: 20000 });
    if (!res) throw new Error('tidak ada respons');
    const buf = await res.buffer();
    return { status: res.status(), type: res.headers()['content-type'] || '', buf };
  } finally {
    if (page) await page.close().catch(() => {});
    release();
  }
}

module.exports = { fetchPage, fetchJsonInPage, fetchBinary, MEDIA_RE };
