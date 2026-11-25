// Memilih URL video yang BENAR (bukan iklan). Prioritas: host video asli (STREAM_HOST_RE, default storage.animein).
const cfg = require('./config');
const { walk, pick, abs, toNum } = require('./utils/helpers');

const MEDIA_RE = /\.(m3u8|mp4|mpd|webm|mkv)(\?|#|$)/i;
const SERVER_KEY = /^(servers?|server_?list|sources?)$/i;
const MEDIA_IN_TEXT = /https?:\\?\/\\?\/[^"'\s\\<>]+?\.(?:m3u8|mp4|mpd|webm)(?:\?[^"'\s\\<>]*)?/gi;
const findMediaInText = (s) => [...new Set((String(s).match(MEDIA_IN_TEXT) || []).map((u) => u.replace(/\\\//g, '/')))];

const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
const isPreferred = (u) => cfg.STREAM_HOST_RE.test(u);
// Iklan SELALU dibuang, termasuk yang ada di host asli (mis. storage.animein.net/ads/...)
const isAd = (u) => {
  try { const x = new URL(u); return cfg.AD_RE.test(x.hostname + x.pathname) || /(^|\/)(ads?|iklan|advert\w*|preroll|promo|sponsor)(\/|[._-]|$)/i.test(x.pathname); } catch { return false; }
};
// file di host asli yang bukan video (poster, subtitle, js, css...)
const NOT_VIDEO = /\.(jpe?g|png|webp|gif|avif|svg|ico|vtt|srt|ass|css|js|json|woff2?|ttf|html?)(\?|#|$)/i;
const HOST_URL_RE = new RegExp('https?:(?:\\\\?/){2}(?:[^"\'\\s\\\\<>]|\\\\/)*?(?:' + cfg.STREAM_HOST_RE.source + ')(?:[^"\'\\s\\\\<>]|\\\\/)*', 'gi');
// semua URL di host video asli (apa pun ekstensinya) dari teks
const findHostUrls = (s) => [...new Set((String(s).match(HOST_URL_RE) || []).map((u) => u.replace(/\\\//g, '/')))].filter((u) => !NOT_VIDEO.test(u));
const typeOf = (u) => (/\.m3u8/i.test(u) ? 'hls' : /\.mpd/i.test(u) ? 'dash' : 'mp4');
const rank = (u) => (/\.mp4/i.test(u) ? 0 : /\.m3u8/i.test(u) ? 1 : 2);

// Ambil data.server[] {id, link, quality, type, key_file_size} dari semua respons JSON
function findServers(jsonList) {
  const servers = []; let apiUrl = null;
  for (const j of jsonList || []) {
    let found = false;
    walk(j.data, (node, path) => {
      if (!Array.isArray(node) || !node.length || !SERVER_KEY.test(String(path[path.length - 1] ?? ''))) return;
      for (const x of node) {
        if (!x || typeof x !== 'object') continue;
        const link = abs(pick(x, ['link', 'url', 'src', 'file', 'source']));
        if (!link) continue;
        servers.push({
          id: pick(x, ['id']) === null ? undefined : String(pick(x, ['id'])),
          link, quality: pick(x, ['quality', 'label', 'resolution']) ?? undefined,
          format: pick(x, ['type']) ?? undefined, size: pick(x, ['key_file_size', 'size']) ?? undefined,
        });
        found = true;
      }
    });
    if (found && !apiUrl) apiUrl = j.url;
  }
  return { servers, apiUrl };
}

/**
 * Gabungkan semua kandidat lalu saring.
 * @param page  { media[], json[], html, iframes[] } (boleh sebagian)
 * @param servers hasil findServers().servers
 */
function chooseStreams({ servers = [], media = [], hostHits = [], json = [], html = '', iframes = [] }) {
  const cand = new Map(); // url -> meta
  const put = (url, meta = {}) => { if (url && !cand.has(url)) cand.set(url, meta); };

  servers.forEach((s) => put(s.link, s));
  media.filter((u) => MEDIA_RE.test(u)).forEach((u) => put(u));
  hostHits.filter((u) => !NOT_VIDEO.test(u)).forEach((u) => put(u));
  json.forEach((j) => { const t = JSON.stringify(j.data); findMediaInText(t).forEach((u) => put(u)); findHostUrls(t).forEach((u) => put(u)); });
  findMediaInText(html).forEach((u) => put(u));
  findHostUrls(html).forEach((u) => put(u));

  const all = [...cand.entries()].map(([url, m]) => ({ url, ...m }));
  const isMedia = (c) => MEDIA_RE.test(c.url);
  const clean = all.filter((c) => !isAd(c.url));
  const adsRemoved = all.length - clean.length;

  // 1) Host video asli ada -> pakai HANYA itu
  let pool = clean.filter((c) => isPreferred(c.url));
  let strategy = 'preferred-host';
  // 2) Tidak ada -> semua media non-iklan
  if (!pool.length) { pool = clean.filter(isMedia); strategy = 'non-ad-media'; }

  const qn = (c) => toNum(c.quality) || 0;
  const streams = pool
    .sort((a, b) => qn(b) - qn(a) || rank(a.url) - rank(b.url))
    .map((c) => ({
      type: isMedia(c) ? typeOf(c.url) : 'file', url: c.url, host: hostOf(c.url),
      quality: c.quality, server: c.id, size: c.size,
    }));

  const embeds = [...new Set([
    ...clean.filter((c) => !isMedia(c) && !isPreferred(c.url)).map((c) => c.url),
    ...iframes.filter((u) => !/^about:|recaptcha|turnstile|challenge/i.test(u) && !isAd(u)),
  ])];

  return { streams, embeds, debug: { strategy, adsRemoved, candidates: all.length } };
}

module.exports = { MEDIA_RE, NOT_VIDEO, findServers, chooseStreams, findMediaInText, isAd, isPreferred };
