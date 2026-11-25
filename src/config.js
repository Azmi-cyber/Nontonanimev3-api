try { require('dotenv').config(); } catch (_) {}

const parseProxy = (raw) => {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return {
      raw,
      protocol: u.protocol.replace(':', ''),
      host: u.hostname,
      port: u.port,
      username: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || ''),
    };
  } catch { return null; }
};

const list = [process.env.PROXY_URL, ...(process.env.PROXY_LIST || '').split(',')]
  .map((s) => (s || '').trim()).filter(Boolean);

const rx = (v, d) => { try { return new RegExp(v || d, 'i'); } catch { return new RegExp(d, 'i'); } };

module.exports = {
  // Host video asli. Link stream yang cocok dengan pola ini SELALU diprioritaskan (dan jika ada, hanya ini yang dikembalikan)
  STREAM_HOST_RE: rx(process.env.STREAM_HOST_RE, 'storage\\.animein'),
  // Pola iklan yang dibuang dari hasil stream
  AD_RE: rx(process.env.AD_RE, '(^|[./_-])(ads?|adserver|adservice|adsystem|doubleclick|googlesyndication|googleadservices|popads|popcash|propeller|exoclick|juicyads|adsterra|vast|vpaid|preroll|banner|sponsor|promo)([./_-]|$)'),
  // Opsional: override manual bila auto-deteksi gagal. Placeholder: {id} {page} {animeId} {epId} {index}
  EPISODES_API_TEMPLATE: process.env.EPISODES_API_TEMPLATE || '',
  SERVER_API_TEMPLATE: process.env.SERVER_API_TEMPLATE || '',
  EPISODE_URL_TEMPLATE: process.env.EPISODE_URL_TEMPLATE || '',
  BASE: (process.env.BASE_URL || 'https://animeinweb.com').replace(/\/$/, ''),
  UA: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  SECRET: process.env.PROXY_SECRET || 'change-me',
  API_KEY: process.env.API_KEY || '',
  DEBUG: process.env.DEBUG_ENDPOINT === '1',
  CACHE_TTL: Number(process.env.CACHE_TTL_SECONDS || 300) * 1000,
  CHROME_PATH: process.env.CHROME_PATH || '',
  proxies: list,
  browserProxy: parseProxy(process.env.PROXY_URL || list[0]),
  randomProxy: () => (list.length ? list[Math.floor(Math.random() * list.length)] : null),
};
