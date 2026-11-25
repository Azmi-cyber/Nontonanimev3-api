const crypto = require('crypto');
const { BASE, SECRET, CACHE_TTL } = require('../config');

const clean = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : s);

const abs = (u, base = BASE) => {
  if (!u || typeof u !== 'string') return null;
  try { return new URL(u, base).href; } catch { return null; }
};

// Next.js memakai /_next/image?url=... -> ambil URL aslinya
const unNextImage = (u) => {
  if (!u) return null;
  try {
    const x = new URL(u, BASE);
    if (x.pathname === '/_next/image' && x.searchParams.get('url')) return abs(x.searchParams.get('url'));
  } catch {}
  return abs(u);
};

// Hapus field kosong agar JSON rapi
const compact = (o) => {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue;
    out[k] = v;
  }
  return out;
};

const pick = (o, keys) => {
  if (!o || typeof o !== 'object') return null;
  for (const k of keys) {
    const v = o[k];
    if (v !== null && v !== undefined && v !== '' && typeof v !== 'object') return v;
  }
  return null;
};

const toNum = (v) => {
  if (v === null || v === undefined) return null;
  const m = String(v).match(/\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
};

const walk = (node, fn, path = [], depth = 0) => {
  if (depth > 14 || node === null || typeof node !== 'object') return;
  fn(node, path);
  const entries = Array.isArray(node) ? node.map((v, i) => [i, v]) : Object.entries(node);
  for (const [k, v] of entries) walk(v, fn, [...path, k], depth + 1);
};

// ---- URL proxy bertanda tangan (anti open-proxy) ----
const b64 = (b) => Buffer.from(b).toString('base64url');
const mac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url').slice(0, 32);

const signToken = (url, referer, img) => {
  const body = b64(JSON.stringify({ u: url, r: referer || BASE + '/', ...(img ? { i: 1 } : {}) }));
  return `${body}.${mac(body)}`;
};
const verifyToken = (t) => {
  if (!t || !t.includes('.')) return null;
  const [body, sig] = t.split('.');
  const exp = mac(body);
  if (sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
};

const origin = (req) => `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers['x-forwarded-host'] || req.get('host')}`;
const proxyUrl = (req, url, referer, img = false) => (url ? `${origin(req)}/proxy?t=${signToken(url, referer, img)}` : null);
// khusus gambar (poster/thumbnail): proxy punya fallback berlapis + placeholder
const imgUrl = (req, url) => proxyUrl(req, url, null, true);

// ---- cache memori sederhana ----
const store = new Map();
const cache = {
  get(k) { const e = store.get(k); if (!e) return null; if (e.exp < Date.now()) { store.delete(k); return null; } return e.v; },
  set(k, v, ttl = CACHE_TTL) { if (store.size > 200) store.delete(store.keys().next().value); store.set(k, { v, exp: Date.now() + ttl }); },
};

module.exports = { clean, abs, unNextImage, compact, pick, toNum, walk, signToken, verifyToken, proxyUrl, imgUrl, origin, cache };
