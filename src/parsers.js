const cheerio = require('cheerio');
const { BASE, } = require('./config');
const { clean, abs, unNextImage, compact, pick, toNum, walk } = require('./utils/helpers');
const { findMediaInText } = require('./streams');
const { findEpisodeSource } = require('./episodes');

const TITLE_K = ['title', 'name', 'judul', 'nama', 'anime_title', 'animeName'];
const IMG_K = ['poster', 'image', 'cover', 'thumbnail', 'thumb', 'img', 'gambar', 'poster_url', 'image_url', 'cover_url', 'posterUrl'];
const SYN_K = ['synopsis', 'sinopsis', 'description', 'deskripsi', 'overview', 'sinopsis_anime'];
const NUM_K = ['episode', 'eps', 'ep', 'number', 'no', 'episode_number', 'episodeNumber', 'nomor', 'urutan', 'index'];
const BAD_PATH = /recommend|related|similar|popular|populer|rekomendasi|trending|latest|terbaru|schedule|jadwal/i;

const idOf = (o) => { const v = pick(o, ['id', 'anime_id', 'animeId', 'mal_id', 'slug']); return v === null ? null : String(v); };


// ---------- GAMBAR (poster) ----------
const IMG_KEY_RE = /(poster|image|img|cover|thumb|gambar|banner|photo|picture)/i;
const IMG_SUB = ['url', 'src', 'large', 'original', 'medium', 'default', 'path', 'large_image_url', 'image_url', 'small'];
const IMG_EXT = /\.(jpe?g|png|webp|gif|avif|svg|bmp)(\?|#|$)/i;
// string dianggap gambar hanya bila berupa URL penuh / path / punya ekstensi gambar (bukan id, angka, "null", dst)
const okImg = (s) => {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (!t || /^data:/i.test(t) || /^(null|undefined|none|false|true)$/i.test(t) || /^\d+$/.test(t)) return false;
  return /^(https?:)?\/\//i.test(t) || t.startsWith('/') || IMG_EXT.test(t) || /\/_next\/image/i.test(t);
};

function imgFrom(v, depth = 0) {
  if (!v || depth > 3) return null;
  if (typeof v === 'string') return okImg(v) ? v.trim() : null;
  if (Array.isArray(v)) { for (const x of v) { const r = imgFrom(x, depth + 1); if (r) return r; } return null; }
  if (typeof v === 'object') {
    for (const k of IMG_SUB) { const r = imgFrom(v[k], depth + 1); if (r) return r; }
    for (const x of Object.values(v)) { const r = imgFrom(x, depth + 1); if (r) return r; }
  }
  return null;
}

function findImage(o) {
  if (!o || typeof o !== 'object') return null;
  for (const k of IMG_K) { const r = imgFrom(o[k]); if (r) return r; }
  for (const [k, v] of Object.entries(o)) { if (IMG_KEY_RE.test(k)) { const r = imgFrom(v); if (r) return r; } }
  return null;
}

function domImage($, a) {
  const grab = (scope) => {
    const el = scope.find('img').first();
    let src = el.attr('src') || el.attr('data-src') || el.attr('data-lazy-src');
    const ss = el.attr('srcset') || el.attr('data-srcset') || scope.find('source').first().attr('srcset');
    if (!okImg(src) && ss) src = ss.split(',')[0].trim().split(/\s+/)[0];
    if (!okImg(src)) {
      const st = scope.find('[style*="background"]').first().attr('style') || scope.attr('style') || '';
      const m = st.match(/url\(["']?([^"')]+)/);
      if (m) src = m[1];
    }
    return okImg(src) ? src : null;
  };
  return grab($(a)) || grab($(a).closest('div,li,article,section').first());
}

// ---------- ANIME CARD ----------
const looksAnime = (o) => o && typeof o === 'object' && !Array.isArray(o) && idOf(o) && pick(o, TITLE_K);

function normalizeAnime(o) {
  const id = idOf(o);
  const genres = Array.isArray(o.genres || o.genre)
    ? (o.genres || o.genre).map((g) => (typeof g === 'string' ? g : pick(g, ['name', 'title', 'nama']))).filter(Boolean) : undefined;
  return compact({
    id,
    title: clean(pick(o, TITLE_K)),
    poster: unNextImage(findImage(o)),
    type: pick(o, ['type', 'tipe', 'format']),
    status: pick(o, ['status']),
    score: toNum(pick(o, ['score', 'rating', 'skor'])),
    year: toNum(pick(o, ['year', 'tahun', 'release_year'])),
    totalEpisodes: toNum(pick(o, ['total_episodes', 'totalEpisodes', 'episodes_count', 'episode_count', 'jumlah_episode'])),
    genres,
    url: /^\d+$/.test(id) ? `${BASE}/anime/${id}` : undefined,
  });
}

function findAnimeList(payloads) {
  let best = [];
  for (const { data } of payloads) {
    walk(data, (node, path) => {
      if (!Array.isArray(node) || !node.length) return;
      if (BAD_PATH.test(path.join('/'))) return;
      const ok = node.filter(looksAnime);
      if (ok.length >= Math.max(1, node.length * 0.8) && ok.length > best.length) best = ok;
    });
  }
  return best.map(normalizeAnime);
}

function domAnimeCards(html) {
  const $ = cheerio.load(html);
  const seen = new Map();
  $('a[href*="/anime/"]').each((_, a) => {
    const m = ($(a).attr('href') || '').match(/\/anime\/(\d+)/);
    if (!m) return;
    const img = $(a).find('img').first();
    const title = clean(img.attr('alt') || $(a).attr('title') || $(a).find('h1,h2,h3,h4,p,span').first().text() || $(a).text());
    const poster = unNextImage(domImage($, a));
    const prev = seen.get(m[1]);
    // satu anime bisa punya beberapa <a>; gabungkan supaya poster/judul tidak hilang
    seen.set(m[1], compact({
      id: m[1],
      title: (prev && prev.title) || title,
      poster: (prev && prev.poster) || poster,
      url: `${BASE}/anime/${m[1]}`,
    }));
  });
  return [...seen.values()].filter((x) => x.title);
}

// isi poster yang kosong dari DOM (JSON kadang tanpa gambar)
function fillPosters(items, html) {
  if (!items.some((i) => !i.poster)) return items;
  const map = new Map(domAnimeCards(html).map((c) => [c.id, c.poster]));
  return items.map((i) => (i.poster ? i : compact({ ...i, poster: map.get(i.id) })));
}

function parseSearch(page) {
  const fromJson = findAnimeList(page.json);
  const items = fromJson.length ? fillPosters(fromJson, page.html) : domAnimeCards(page.html);
  return { source: fromJson.length ? 'json' : 'dom', items };
}


// ---------- HOME ----------
const prettyName = (s) => String(s).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, (c) => c.toUpperCase()).trim();

function parseHome(page) {
  const sections = [];
  const seen = new Set();
  for (const { url, data } of page.json) {
    walk(data, (node, path) => {
      if (!Array.isArray(node) || !node.length) return;
      const ok = node.filter(looksAnime);
      if (!ok.length || ok.length < node.length * 0.8) return;
      const sig = ok.map(idOf).join(',');
      if (seen.has(sig)) return;
      seen.add(sig);
      const key = [...path].reverse().find((k) => typeof k === 'string' && !/^(data|result|results|items|list|props|pageProps)$/i.test(k));
      let name = key ? prettyName(key) : prettyName((new URL(url).pathname.split('/').filter(Boolean).pop()) || 'Anime');
      sections.push({ name, total: ok.length, items: fillPosters(ok.map(normalizeAnime), page.html) });
    });
  }
  if (sections.length) return { source: 'json', sections };
  const items = domAnimeCards(page.html);
  return { source: 'dom', sections: items.length ? [{ name: 'Anime', total: items.length, items }] : [] };
}

// ---------- DETAIL ----------
function findDetailObject(payloads, id) {
  let found = null;
  for (const { data } of payloads) {
    walk(data, (node) => {
      if (found || !looksAnime(node)) return;
      if (idOf(node) === String(id)) found = node;
    });
    if (found) break;
  }
  return found;
}

// ---------- EPISODE (dipilih dengan skor supaya tidak tertukar dgn rekomendasi) ----------
const epLike = (o) => o && typeof o === 'object' && !Array.isArray(o)
  && (pick(o, NUM_K) !== null || /\b(ep(isode)?|eps)\s*\.?\s*\d+/i.test(String(pick(o, TITLE_K) || '')));

function findEpisodeArray(payloads) {
  let best = null; let bestScore = 0;
  for (const { data } of payloads) {
    walk(data, (node, path) => {
      if (!Array.isArray(node) || !node.length) return;
      const p = path.join('/');
      if (BAD_PATH.test(p)) return;
      const ratio = node.filter(epLike).length / node.length;
      if (ratio < 0.8) return;
      // daftar kartu anime lain (punya id+poster+judul tanpa nomor episode) bukan episode
      if (node.every((x) => looksAnime(x) && pick(x, IMG_K) && pick(x, NUM_K) === null)) return;
      let score = ratio * 10 + Math.log(node.length + 1);
      if (/episode|eps|chapter/i.test(String(path[path.length - 1] || ''))) score += 6;
      if (/episode|eps/i.test(p)) score += 2;
      if (score > bestScore) { best = node; bestScore = score; }
    });
  }
  return best;
}


function normalizeEpisode(o, animeId) {
  const title = clean(pick(o, TITLE_K));
  const number = toNum(pick(o, NUM_K)) ?? toNum((title || '').match(/\d+(\.\d+)?/)?.[0]);
  const link = pick(o, ['url', 'link', 'href', 'path', 'slug_url', 'watch_url']);
  const epId = pick(o, ['id', 'episode_id', 'episodeId', 'slug']);
  const direct = findMediaInText(JSON.stringify(o));
  return compact({
    number,
    title,
    id: epId === null ? undefined : String(epId),
    date: pick(o, ['date', 'released_at', 'release_date', 'created_at', 'tanggal', 'updated_at']),
    pageUrl: link ? abs(link) : undefined,
    _direct: direct,
    _animeId: animeId,
  });
}

function domEpisodes(html, animeId) {
  const $ = cheerio.load(html);
  const seen = new Map();
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    if (!/(episode|eps|watch|nonton|play)/i.test(href)) return;
    if (/\/anime\/\d+\/?$/.test(href)) return;
    const u = abs(href);
    if (!u || seen.has(u)) return;
    const txt = clean($(a).text());
    const num = toNum((txt.match(/(?:ep(?:isode)?|eps)\s*\.?\s*(\d+(\.\d+)?)/i) || href.match(/(?:episode|eps|ep)[-_/=]?(\d+(\.\d+)?)/i) || [])[1]);
    if (num === null) return;
    seen.set(u, compact({ number: num, title: txt || `Episode ${num}`, pageUrl: u, _animeId: animeId }));
  });
  return [...seen.values()];
}

// rawList (item JSON episode) -> daftar episode rapi, unik, urut 1..terbaru
function buildEpisodes(rawList, animeId) {
  const uniq = new Map();
  for (const e of rawList.map((r) => normalizeEpisode(r, animeId))) uniq.set(e.id ?? e.number ?? e.pageUrl, e);
  return [...uniq.values()].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
}

// poster detail: JSON -> og:image -> <img> yang alt-nya mirip judul -> <img> pertama bergambar besar
function detailPoster($, base, title) {
  if (base.poster) return base.poster;
  const og = unNextImage($('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content'));
  if (og) return og;
  const t = (title || '').toLowerCase();
  let hit = null;
  $('img').each((_, el) => {
    if (hit) return;
    const alt = (el.attribs && el.attribs.alt || '').toLowerCase();
    const src = (el.attribs && (el.attribs.src || el.attribs['data-src'])) || '';
    if (t && alt && (alt.includes(t) || t.includes(alt)) && okImg(src)) hit = src;
  });
  return hit ? unNextImage(hit) : null;
}

// fallback terakhir: episode hanya berupa teks "Episode N" / "Eps N" / "EP N" di DOM (tanpa link)
function domTextEpisodes(html, animeId) {
  const $ = cheerio.load(html);
  const nums = new Map();
  $('a,button,li,span,div,p').each((_, el) => {
    if ($(el).children().length > 2) return;
    const t = clean($(el).text());
    if (!t || t.length > 40) return;
    const m = t.match(/^(?:episode|eps?|ep)\.?\s*(\d+(?:\.\d+)?)\b/i);
    if (m && !nums.has(Number(m[1]))) nums.set(Number(m[1]), compact({ number: Number(m[1]), title: `Episode ${m[1]}`, _animeId: animeId }));
  });
  return [...nums.values()];
}

function parseDetail(page, id) {
  const $ = cheerio.load(page.html);
  const obj = findDetailObject(page.json, id);
  const base = obj ? normalizeAnime(obj) : {};

  // 1) sumber utama: respons XHR yang berisi data.episode[] (hanya halaman pertama; sisanya di-paginate di app.js)
  const episodeSource = findEpisodeSource(page.json);
  let source = 'json';
  let episodes;
  if (episodeSource) episodes = buildEpisodes(episodeSource.list, id);
  else {
    const rawEps = findEpisodeArray(page.json);
    if (rawEps) episodes = buildEpisodes(rawEps, id);
    else {
      episodes = domEpisodes(page.html, id); source = 'dom';
      if (!episodes.length) { episodes = domTextEpisodes(page.html, id); source = 'dom-text'; }
    }
  }
  episodes.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));

  const title = base.title || clean($('meta[property="og:title"]').attr('content') || $('h1').first().text());
  const meta = compact({
    id: String(id),
    title,
    synopsis: clean(pick(obj, SYN_K) || $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content')),
    poster: detailPoster($, base, title),
    type: base.type, status: base.status, score: base.score, year: base.year, genres: base.genres,
    totalEpisodes: base.totalEpisodes || episodes.length || undefined,
    url: `${BASE}/anime/${id}`,
  });
  const hrefs = page.hrefs && page.hrefs.length ? page.hrefs : $('a[href]').map((_, a) => abs($(a).attr('href'))).get().filter(Boolean);
  return { meta, episodes, source, episodeSource, hrefs };
}

module.exports = { parseHome, parseSearch, parseDetail, buildEpisodes, findMediaInText };
