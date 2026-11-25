const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const cfg = require('./config');
const { verifyToken, signToken } = require('./utils/helpers');
const { fetchBinary } = require('./browser');

const agentFor = (proxy) => {
  if (!proxy) return undefined;
  return /^socks/i.test(proxy) ? new SocksProxyAgent(proxy) : new HttpsProxyAgent(proxy);
};

const isM3u8 = (url, ct) => /mpegurl/i.test(ct || '') || /\.m3u8(\?|$)/i.test(url);
const IMG_EXT = /\.(jpe?g|png|webp|gif|avif|svg|bmp)(\?|#|$)/i;
const imgOk = (ct, url) => /^image\//i.test(ct || '') || (/octet-stream/i.test(ct || '') && IMG_EXT.test(url));

const PLACEHOLDER = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="420" viewBox="0 0 300 420"><rect width="300" height="420" fill="#1b1f2a"/><text x="150" y="215" fill="#6b7385" font-family="sans-serif" font-size="18" text-anchor="middle">No Poster</text></svg>`;

function rewriteM3u8(text, baseUrl, referer, selfBase) {
  const wrap = (u) => {
    try { return `${selfBase}/proxy?t=${signToken(new URL(u, baseUrl).href, referer)}`; } catch { return u; }
  };
  return text.split(/\r?\n/).map((line) => {
    if (!line.trim()) return line;
    if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${wrap(u)}"`);
    return wrap(line.trim());
  }).join('\n');
}

const get = (url, headers, agent) => axios.get(url, {
  responseType: 'stream', headers, httpAgent: agent, httpsAgent: agent, proxy: false,
  maxRedirects: 5, validateStatus: () => true, timeout: 25000,
});

// ---- Gambar: 3 lapis fallback lalu placeholder, supaya poster tidak pernah "pecah" ----
async function handleImage(req, res, data) {
  const send = (buf, type) => {
    res.set({ 'Access-Control-Allow-Origin': '*', 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' });
    return res.status(200).send(buf);
  };
  const base = { 'User-Agent': cfg.UA, Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8', 'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8' };
  let selfOrigin = ''; try { selfOrigin = new URL(data.u).origin + '/'; } catch {}

  // percobaan: [referer, pakai proxy?]  (tanpa header Origin — browser tidak mengirimnya untuk <img>)
  const attempts = [[data.r, true], [selfOrigin, true], [selfOrigin, false], [null, false]];
  for (const [ref, useProxy] of attempts) {
    try {
      const up = await get(data.u, { ...base, ...(ref ? { Referer: ref } : {}) }, useProxy ? agentFor(cfg.randomProxy()) : undefined);
      const ct = up.headers['content-type'] || '';
      if (up.status < 400 && imgOk(ct, data.u)) {
        const chunks = []; for await (const c of up.data) chunks.push(c);
        return send(Buffer.concat(chunks), /octet-stream/i.test(ct) ? 'image/jpeg' : ct);
      }
      up.data.destroy();
    } catch {}
  }
  // lapis terakhir: ambil lewat Chromium (lolos Cloudflare / hotlink)
  try {
    const r = await fetchBinary(data.u, data.r);
    if (r.status < 400 && imgOk(r.type, data.u) && r.buf.length) return send(r.buf, r.type || 'image/jpeg');
  } catch {}
  res.set({ 'Access-Control-Allow-Origin': '*', 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
  return res.status(200).send(PLACEHOLDER);
}

async function handleProxy(req, res, selfBase) {
  const data = verifyToken(req.query.t);
  if (!data) return res.status(403).json({ success: false, error: 'Token proxy tidak valid' });
  if (data.i) return handleImage(req, res, data);

  const headers = {
    'User-Agent': cfg.UA,
    Referer: data.r,
    Origin: new URL(data.r).origin,
    Accept: req.headers.accept || '*/*',
    'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
  };
  if (req.headers.range) headers.Range = req.headers.range;

  try {
    const up = await get(data.u, headers, agentFor(cfg.randomProxy()));
    const ct = up.headers['content-type'] || '';
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges');

    if (isM3u8(data.u, ct) && up.status < 400) {
      const chunks = [];
      for await (const c of up.data) chunks.push(c);
      const finalUrl = up.request?.res?.responseUrl || data.u;
      const body = rewriteM3u8(Buffer.concat(chunks).toString('utf8'), finalUrl, data.r, selfBase);
      res.status(200).set('Content-Type', 'application/vnd.apple.mpegurl').set('Cache-Control', 'no-store');
      return res.send(body);
    }

    res.status(up.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      if (up.headers[h]) res.set(h, up.headers[h]);
    }
    res.set('Cache-Control', 'public, max-age=300');
    up.data.on('error', () => res.destroy());
    req.on('close', () => up.data.destroy());
    up.data.pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ success: false, error: 'Gagal mengambil sumber: ' + e.message });
  }
}

module.exports = { handleProxy };
