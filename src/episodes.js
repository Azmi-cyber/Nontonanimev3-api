// Mengumpulkan SEMUA episode (halaman 1..terakhir) dan mempelajari pola URL halaman nonton.
const cfg = require('./config');
const { walk, pick } = require('./utils/helpers');

const EP_KEY = /^(episodes?|eps|episode_?list)$/i;
const PAGE_PARAM = /^(page|p|pagenum|page_num|pageno|page_number|halaman|pg)$/i;
const LAST_PAGE_KEY = /^(last_?page|total_?pages?|page_?count|max_?page|pages|totalpage|lastpage)$/i;
const TOTAL_KEY = /^(total|total_?items?|total_?episodes?|count|total_?results?)$/i;

const hasId = (x) => x && typeof x === 'object' && !Array.isArray(x) && pick(x, ['id', 'episode_id', 'episodeId']) !== null;

// Cari array episode (mis. data.episode[]) di dalam satu payload JSON
const NUMLIKE = ['index', 'number', 'episode', 'eps', 'ep', 'episode_number', 'episodeNumber', 'no'];
const BAD = /recommend|related|similar|popular|trending|latest|schedule|jadwal|rekomendasi/i;
function extractEpisodeList(data) {
  let best = null; let loose = null;
  walk(data, (node, path) => {
    if (!Array.isArray(node) || !node.length) return;
    const key = String(path[path.length - 1] ?? '');
    const ok = node.filter(hasId);
    if (ok.length < node.length * 0.8) return;
    if (EP_KEY.test(key)) { if (!best || ok.length > best.length) best = ok; return; }
    // pencarian longgar: nama key lain, tapi tiap item punya id + nomor + judul dan bukan daftar rekomendasi
    if (BAD.test(path.join('/'))) return;
    const numbered = ok.filter((x) => pick(x, NUMLIKE) !== null && pick(x, ['title', 'name', 'judul']) !== null && pick(x, ['poster', 'image', 'cover']) === null);
    if (numbered.length >= ok.length * 0.8 && (!loose || ok.length > loose.length)) loose = ok;
  });
  return best || loose;
}

// Cari respons XHR yang membawa daftar episode
function findEpisodeSource(jsonList) {
  let best = null;
  for (const j of jsonList || []) {
    const list = extractEpisodeList(j.data);
    if (list && (!best || list.length > best.list.length)) best = { url: j.url, data: j.data, list };
  }
  return best;
}

function pageInfo(src) {
  let param = null; let current = 1; let pathPage = false;
  try {
    const u = new URL(src.url);
    for (const k of u.searchParams.keys()) if (PAGE_PARAM.test(k)) param = k;
    if (param) current = Number(u.searchParams.get(param)) || 1;
    else if (/\/\d+\/?$/.test(u.pathname)) pathPage = true;
  } catch {}
  let lastPage = null; let total = null;
  walk(src.data, (node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const [k, v] of Object.entries(node)) {
      if (v === null || typeof v === 'object') continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) continue;
      if (LAST_PAGE_KEY.test(k)) lastPage = Math.max(lastPage || 0, n);
      else if (TOTAL_KEY.test(k)) total = Math.max(total || 0, n);
    }
  });
  return { param, current, pathPage, lastPage, total };
}

function pageUrlBuilder(src, info, animeId) {
  if (cfg.EPISODES_API_TEMPLATE) {
    return (page) => cfg.EPISODES_API_TEMPLATE.replace(/\{id\}|\{animeId\}/g, animeId).replace(/\{page\}/g, page);
  }
  return (page) => {
    const u = new URL(src.url);
    if (info.param) u.searchParams.set(info.param, page);
    else if (info.pathPage) u.pathname = u.pathname.replace(/\/\d+(\/?)$/, `/${page}$1`);
    else u.searchParams.set('page', page); // tebakan terakhir (di-probe)
    return u.href;
  };
}

const idKey = (e) => String(pick(e, ['id', 'episode_id', 'episodeId']));

/**
 * @param src      hasil findEpisodeSource (halaman yang sudah terambil browser)
 * @param fetchMany async (urls[]) => array JSON|null  (dijalankan di dalam browser agar lolos Cloudflare)
 * @returns { items, pagesFetched, lastPage, warnings[] }
 */
async function collectEpisodes(src, fetchMany, animeId) {
  const info = pageInfo(src);
  const build = pageUrlBuilder(src, info, animeId);
  const byId = new Map();
  const warnings = [];
  const add = (list) => { let n = 0; for (const e of list || []) { const k = idKey(e); if (!byId.has(k)) { byId.set(k, e); n++; } } return n; };
  add(src.list);

  const perPage = src.list.length;
  let last = info.lastPage || (info.total && perPage ? Math.ceil(info.total / perPage) : null);
  const HARD = 80;
  let fetched = 1;

  const getPages = async (pages) => {
    const res = await fetchMany(pages.map(build));
    let added = 0; let empty = 0;
    res.forEach((data) => {
      const list = data ? extractEpisodeList(data) : null;
      if (!list || !list.length) { empty++; return; }
      fetched++; added += add(list);
    });
    return { added, empty };
  };

  // halaman sebelum halaman yang ditangkap (jika bukan halaman 1)
  if (info.current > 1) await getPages(Array.from({ length: info.current - 1 }, (_, i) => i + 1));

  if (last) {
    last = Math.min(last, HARD);
    const todo = [];
    for (let p = info.current + 1; p <= last; p++) todo.push(p);
    for (let i = 0; i < todo.length; i += 5) await getPages(todo.slice(i, i + 5));
  } else {
    // jumlah halaman tidak diketahui -> telusuri sampai kosong / tidak ada episode baru
    for (let p = info.current + 1; p <= HARD; p++) {
      const { added } = await getPages([p]);
      if (!added) break;
    }
  }

  const expected = info.total || null;
  if (expected && byId.size < expected) warnings.push(`Episode terkumpul ${byId.size} dari ${expected} (kemungkinan pagination belum terdeteksi benar)`);
  if (!info.param && !info.pathPage && !cfg.EPISODES_API_TEMPLATE && byId.size === perPage) {
    warnings.push('Parameter halaman tidak terdeteksi di URL episode; jika episode kurang, isi EPISODES_API_TEMPLATE');
  }
  return { items: [...byId.values()], pagesFetched: fetched, lastPage: last, warnings };
}

// ---------- Pola URL halaman nonton (dipelajari dari link di DOM) ----------
const learned = { episodeUrl: null, serverApi: null };
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function learnEpisodeTemplate(hrefs, eps, animeId) {
  const votes = new Map();
  const vote = (t) => votes.set(t, (votes.get(t) || 0) + 1);
  const sample = eps.filter((e) => e.id || e.number !== undefined).slice(0, 8);
  for (const e of sample) {
    const tryTok = (tok, name) => {
      if (tok === undefined || tok === null || tok === '') return;
      const re = new RegExp(`(^|[/=?&_-])${esc(tok)}($|[/?#&_-])`);
      for (const h of hrefs) {
        if (!re.test(h) || /\/anime\/\d+\/?$/.test(h)) continue;
        if (!/(episode|eps?|watch|nonton|play|stream)/i.test(h) && name === 'index') continue;
        let t = h.replace(re, (_, a, b) => `${a}{${name}}${b}`);
        if (animeId) t = t.replace(new RegExp(`(^|[/=?&_-])${esc(animeId)}($|[/?#&_-])`), (_, a, b) => `${a}{animeId}${b}`);
        vote(t);
        return;
      }
    };
    tryTok(e.id, 'epId');
    if (![...votes.keys()].length) tryTok(e.number, 'index');
  }
  let best = null; let bn = 0;
  for (const [t, n] of votes) if (n > bn) { best = t; bn = n; }
  if (best) learned.episodeUrl = best;
  return best;
}

function episodeUrl(ep, animeId) {
  const tpl = cfg.EPISODE_URL_TEMPLATE || learned.episodeUrl;
  if (!tpl) return null;
  if (/\{epId\}/.test(tpl) && !ep.id) return null;
  if (/\{index\}/.test(tpl) && ep.number === undefined) return null;
  return tpl.replace(/\{epId\}/g, ep.id ?? '').replace(/\{index\}/g, ep.number ?? '').replace(/\{animeId\}|\{id\}/g, animeId);
}

const learnServerApi = (url, epId) => {
  if (url && epId && String(url).includes(String(epId))) learned.serverApi = String(url).replace(String(epId), '{id}');
};
const serverApiUrl = (epId) => {
  const tpl = cfg.SERVER_API_TEMPLATE || learned.serverApi;
  return tpl ? tpl.replace(/\{id\}|\{epId\}/g, epId) : null;
};

module.exports = {
  extractEpisodeList, findEpisodeSource, collectEpisodes, pageInfo,
  learnEpisodeTemplate, episodeUrl, learnServerApi, serverApiUrl, learned,
};
