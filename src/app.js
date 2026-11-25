const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const cfg = require('./config');
const { fetchPage, fetchJsonInPage } = require('./browser');
const { parseHome, parseSearch, parseDetail, buildEpisodes } = require('./parsers');
const { collectEpisodes, learnEpisodeTemplate, episodeUrl, learnServerApi, serverApiUrl, extractEpisodeList } = require('./episodes');
const { findServers, chooseStreams } = require('./streams');
const { handleProxy } = require('./proxyStream');
const docs = require('./docs');
const { proxyUrl, imgUrl, origin, compact, cache } = require('./utils/helpers');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.set('json spaces', 2); // JSON rapi (pretty print)
app.use(rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false }));

const ok = (res, data, meta) => res.json({ success: true, data, ...(meta ? { meta } : {}) });
const fail = (res, code, msg) => res.status(code).json({ success: false, error: msg });
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); fail(res, 502, e.message || 'Scraping gagal'); });

// API key (opsional)
const guard = (req, res, next) => {
  if (!cfg.API_KEY) return next();
  const k = req.get('x-api-key') || req.query.apikey;
  return k === cfg.API_KEY ? next() : fail(res, 401, 'API key tidak valid');
};

const cached = async (key, fn) => {
  const hit = cache.get(key);
  if (hit) return hit;
  const v = await fn();
  cache.set(key, v);
  return v;
};

const onlyTarget = (u) => { try { return new URL(u).origin === new URL(cfg.BASE).origin; } catch { return false; } };

app.get('/', (req, res) => res.type('html').send(docs(origin(req))));
app.get('/health', (_, res) => ok(res, { status: 'ok', proxy: !!cfg.browserProxy, time: new Date().toISOString() }));
app.get('/proxy', (req, res) => handleProxy(req, res, origin(req)));

// ---------- /home (scrape beranda animeinweb) ----------
app.get('/home', guard, wrap(async (req, res) => {
  const { sections, source } = await cached('h:' + cfg.BASE, async () => parseHome(await fetchPage(cfg.BASE + '/')));
  const out = sections.map((s) => ({ ...s, items: s.items.map((i) => ({ ...i, poster: imgUrl(req, i.poster) })) }));
  ok(res, { total: out.length, sections: out }, { source });
}));

// ---------- /search ----------
app.get('/search', guard, wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return fail(res, 400, 'Parameter q wajib diisi');
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const url = `${cfg.BASE}/search?q=${encodeURIComponent(q)}${page > 1 ? `&page=${page}` : ''}`;

  const { items, source } = await cached('s:' + url, async () => parseSearch(await fetchPage(url)));
  const results = items.map((i) => ({ ...i, poster: imgUrl(req, i.poster) }));
  ok(res, { query: q, page, total: results.length, results }, { source });
}));

// ---------- detail + SEMUA episode (halaman 1..terakhir) ----------
async function loadDetail(id) {
  const key = 'd:' + id;
  const hit = cache.get(key);
  if (hit) return hit;
  const detail = await loadDetailFresh(id);
  if (detail.episodes.length) cache.set(key, detail);   // hasil kosong tidak di-cache
  return detail;
}
async function loadDetailFresh(id) {
  return (async () => {
    const page = await fetchPage(`${cfg.BASE}/anime/${id}`);
    const detail = parseDetail(page, id);
    detail.warnings = [];

    let src = detail.episodeSource;
    if (!src && cfg.EPISODES_API_TEMPLATE) {
      const url = cfg.EPISODES_API_TEMPLATE.replace(/\{id\}|\{animeId\}/g, id).replace(/\{page\}/g, 1);
      const [data] = await fetchJsonInPage([url]);
      const list = data && extractEpisodeList(data);
      if (list) src = { url, data, list };
    }
    if (src) {
      try {
        const r = await collectEpisodes(src, fetchJsonInPage, id);
        detail.episodes = buildEpisodes(r.items, id);
        detail.pages = r.pagesFetched;
        detail.warnings.push(...r.warnings);
        detail.source = 'json+pagination';
      } catch (e) { detail.warnings.push('Pagination episode gagal: ' + e.message); }
    } else if (!detail.episodes.length) {
      detail.warnings.push('Daftar episode tidak ditemukan di XHR/DOM; cek /debug atau isi EPISODES_API_TEMPLATE');
    }
    if (!detail.episodes.length) {
      detail.diagnostics = {
        pageTitle: page.title, finalUrl: page.finalUrl, htmlLength: page.html.length,
        blockedByCloudflare: !!page.blocked,
        xhrSeen: page.requests.slice(0, 25),
        jsonCaptured: page.json.slice(0, 15).map((j) => ({ url: j.url, keys: j.data && typeof j.data === 'object' ? Object.keys(j.data).slice(0, 8) : typeof j.data })),
        hint: page.blocked ? 'Halaman diblok Cloudflare: ganti/aktifkan PROXY_URL residential' : 'Kirim isi diagnostics ini; atau isi EPISODES_API_TEMPLATE dengan URL XHR episode dari xhrSeen',
      };
    }
    learnEpisodeTemplate(detail.hrefs, detail.episodes, id);
    detail.meta.totalEpisodes = detail.episodes.length || detail.meta.totalEpisodes;
    delete detail.hrefs; delete detail.episodeSource;
    return detail;
  })();
}

// ---------- stream satu episode: server API -> halaman nonton; buang iklan, utamakan storage.animein ----------
async function resolveEpisode({ epId, pageUrl, animeId }) {
  return cached('e:' + (epId || pageUrl), async () => {
    let servers = []; let pg = null;
    const target = pageUrl || (epId ? episodeUrl({ id: epId }, animeId) : null);

    const api = epId && serverApiUrl(epId);
    if (api) {
      const [d] = await fetchJsonInPage([api]);
      if (d) servers = findServers([{ url: api, data: d }]).servers;
    }
    if (!servers.length) {
      if (!target) throw new Error('URL halaman nonton episode belum diketahui. Buka /nonton?id=<anime> dulu, atau isi EPISODE_URL_TEMPLATE / SERVER_API_TEMPLATE');
      pg = await fetchPage(target);
      let f = findServers(pg.json);
      servers = f.servers; learnServerApi(f.apiUrl, epId);
      if (!servers.length && !chooseStreams({ media: pg.media, hostHits: pg.hostHits, json: pg.json, html: pg.html }).streams.length) {
        pg = await fetchPage(target, { tryPlay: true });
        f = findServers(pg.json); servers = f.servers; learnServerApi(f.apiUrl, epId);
      }
    }
    const r = chooseStreams({ servers, media: pg?.media, hostHits: pg?.hostHits, json: pg?.json, html: pg?.html, iframes: pg?.iframes });
    return { ...r, referer: target || cfg.BASE + '/' };
  });
}

const wrapStreams = (req, r) => r.streams.map((s) => compact({ ...s, url: proxyUrl(req, s.url, r.referer) }));
const apiKeyQ = () => (cfg.API_KEY ? '&apikey=' + encodeURIComponent(cfg.API_KEY) : '');

// ---------- /nonton ----------
app.get('/nonton', guard, wrap(async (req, res) => {
  const id = String(req.query.id || '').trim();
  if (!/^[\w-]+$/.test(id)) return fail(res, 400, 'Parameter id tidak valid');

  const detail = await loadDetail(id);
  if (!detail.meta.title && !detail.episodes.length) return res.status(404).json({ success: false, error: 'Anime tidak ditemukan / halaman gagal dimuat (kemungkinan terblokir)', diagnostics: detail.diagnostics });

  const doResolve = req.query.resolve === '1' || req.query.resolve === 'true';
  const limit = Math.min(10, Math.max(1, parseInt(req.query.limit, 10) || 3));
  const wantEp = req.query.ep ? Number(req.query.ep) : null;
  const targets = new Set();
  if (doResolve) {
    const pool = wantEp !== null ? detail.episodes.filter((e) => e.number === wantEp) : detail.episodes.slice(0, limit);
    pool.forEach((e) => targets.add(e));
  }

  const episodes = [];
  for (const e of detail.episodes) {
    const { _direct, _animeId, ...rest } = e;
    const item = { ...rest };
    delete item.thumbnail;
    const watchUrl = e.pageUrl || episodeUrl(e, id);
    if (watchUrl) { item.watchUrl = watchUrl; item.pageUrl = watchUrl; }
    if (e.id || watchUrl) {
      item.resolveUrl = `${origin(req)}/episode?${e.id ? 'id=' + encodeURIComponent(e.id) + '&anime=' + id : 'url=' + encodeURIComponent(watchUrl)}${watchUrl && e.id ? '&url=' + encodeURIComponent(watchUrl) : ''}${apiKeyQ()}`;
    }

    if (targets.has(e)) {
      try {
        const r = await resolveEpisode({ epId: e.id, pageUrl: watchUrl, animeId: id });
        item.streams = wrapStreams(req, r);
        if (r.embeds.length) item.embeds = r.embeds;
      } catch (err) { item.streamError = err.message; }
    } else if (_direct && _direct.length) {
      const r = chooseStreams({ media: _direct });
      if (r.streams.length) item.streams = wrapStreams(req, { ...r, referer: cfg.BASE + '/' });
    }
    episodes.push(compact(item));
  }

  const anime = compact({ ...detail.meta, poster: imgUrl(req, detail.meta.poster) });
  const first = episodes[0]; const latest = episodes[episodes.length - 1];
  // cek episode bolong (1..terbaru harus utuh)
  const nums = new Set(episodes.map((e) => e.number).filter((n) => Number.isInteger(n)));
  const maxN = Math.max(0, ...nums);
  const missing = []; for (let n = 1; n <= maxN && missing.length < 100; n++) if (!nums.has(n)) missing.push(n);
  if (missing.length) detail.warnings.push(`Nomor episode yang tidak ada di sumber: ${missing.join(', ')}`);
  ok(res, {
    anime, totalEpisodes: episodes.length,
    firstEpisode: first && first.number, latestEpisode: latest && latest.number,
    episodes,
  }, { source: detail.source, pagesFetched: detail.pages, ...(detail.warnings.length ? { warnings: detail.warnings } : {}), ...(detail.diagnostics ? { diagnostics: detail.diagnostics } : {}) });
}));

// ---------- /episode?id=<episodeId>&anime=<animeId>[&url=<halaman nonton>]  |  /episode?url=... ----------
app.get('/episode', guard, wrap(async (req, res) => {
  const u = String(req.query.url || '');
  const epId = req.query.id ? String(req.query.id) : null;
  if (epId && !/^[\w-]+$/.test(epId)) return fail(res, 400, 'Parameter id tidak valid');
  if (!epId && !u) return fail(res, 400, 'Isi id (episode) atau url');
  if (u && !onlyTarget(u)) return fail(res, 400, 'url harus berasal dari ' + cfg.BASE);
  const r = await resolveEpisode({ epId, pageUrl: u || null, animeId: String(req.query.anime || '') });
  ok(res, { pageUrl: r.referer, streams: wrapStreams(req, r), embeds: r.embeds }, r.debug);
}));

// ---------- /debug (matikan di produksi) ----------
app.get('/debug', guard, wrap(async (req, res) => {
  if (!cfg.DEBUG) return fail(res, 404, 'Not found');
  const u = String(req.query.url || cfg.BASE);
  if (!onlyTarget(u)) return fail(res, 400, 'url harus berasal dari ' + cfg.BASE);
  const pg = await fetchPage(u, { tryPlay: req.query.play === '1' });
  ok(res, {
    finalUrl: pg.finalUrl,
    htmlLength: pg.html.length,
    title: (pg.html.match(/<title>([^<]*)/i) || [])[1],
    json: pg.json.map((j) => ({ url: j.url, preview: JSON.stringify(j.data).slice(0, 400) })),
    media: pg.media, hostHits: pg.hostHits, xhr: pg.requests, iframes: pg.iframes,
    servers: findServers(pg.json).servers,
    streamsChosen: chooseStreams({ media: pg.media, hostHits: pg.hostHits, json: pg.json, html: pg.html, iframes: pg.iframes }),
    sampleLinks: (pg.hrefs || []).filter((h) => /anime|episode|watch|nonton/i.test(h)).slice(0, 40),
  });
}));

app.use((_, res) => fail(res, 404, 'Endpoint tidak ditemukan. Lihat /home'));

module.exports = app;
