# NontonAnime API (animeinweb.com scraper)

Express + headless Chromium (puppeteer-core + patch stealth manual) + proxy. Siap Vercel.

## Struktur
```
nonton-api/
├── api/index.js        # entry Vercel
├── src/
│   ├── app.js          # routes: / (docs) /home (scrape beranda) /search /nonton /episode /proxy /debug /health
│   ├── server.js       # entry lokal
│   ├── config.js       # env & proxy
│   ├── browser.js      # Chromium stealth, bypass Cloudflare, sniff XHR/JSON & media
│   ├── parsers.js      # cleaning: search, detail, episode (scoring), stream
│   ├── proxyStream.js  # proxy gambar/stream (+ rewrite HLS .m3u8, Range)
│   ├── docs.js         # halaman /home
│   └── utils/helpers.js
├── vercel.json
├── package.json
└── .env.example
```

## Jalankan lokal
```bash
npm install
cp .env.example .env     # isi PROXY_URL & PROXY_SECRET
DEBUG_ENDPOINT=1 npm run dev
# buka http://localhost:3000/home
```

## Ganti proxy
Cukup ubah env `PROXY_URL` (`http://user:pass@host:port` atau `socks5://host:port`).
`PROXY_LIST` (koma) dipakai untuk rotasi acak pada request gambar/stream.
Gunakan **residential proxy** — IP datacenter (termasuk IP Vercel) paling sering diblok Cloudflare.

## Deploy Vercel
```bash
npm i -g vercel && vercel --prod
```
Set env di dashboard: `PROXY_URL`, `PROXY_SECRET`, (opsional) `API_KEY`.
Catatan: Chromium butuh memori & waktu; `maxDuration` 60 dtk (sesuaikan plan).
Untuk streaming video berat, VPS/Railway/Render + Docker lebih stabil daripada Vercel.

## Menyesuaikan parser (PENTING)
Situs target adalah Next.js client-side, jadi struktur JSON internalnya perlu diverifikasi:
1. Set `DEBUG_ENDPOINT=1`, lalu buka `/debug?url=https://animeinweb.com/anime/1755`
2. Lihat daftar `json[].url` dan `preview` untuk menemukan endpoint data & nama field.
3. Jika perlu, tambah nama field di konstanta `TITLE_K / IMG_K / NUM_K` pada `src/parsers.js`.
4. Untuk halaman episode: `/debug?url=<halaman_episode>&play=1` menampilkan `media` & `iframes`.

## Perubahan v3.1
- **Semua episode**: daftar episode di API situs dipaginasi. Sekarang halaman 2..N diambil otomatis (di dalam browser, jadi lolos Cloudflare), digabung, dan diurutkan episode 1 -> terbaru. Tiap episode punya `watchUrl` (URL halaman nonton) + `resolveUrl`. Field `meta.pagesFetched`/`meta.warnings` membantu cek.
- **Stream tanpa iklan**: link dari data server dipilih per host. Yang cocok `STREAM_HOST_RE` (default `storage\.animein`) dipakai sendirian; pola iklan (`AD_RE`) dibuang; domain iklan umum diblok di browser; klik play otomatis hanya sebagai cadangan.
- **Poster**: deteksi gambar diperketat (id/angka tidak lagi terambil sebagai poster), poster detail punya fallback og:image/`<img>`, proxy gambar punya 4 percobaan + Chromium + placeholder (tidak pernah pecah).
- Jika auto-deteksi gagal, isi `EPISODES_API_TEMPLATE`, `SERVER_API_TEMPLATE`, `EPISODE_URL_TEMPLATE` (lihat `.env.example`). Gunakan `/debug?url=<halaman_episode>` (`DEBUG_ENDPOINT=1`) untuk melihat `servers`, `streamsChosen`, `sampleLinks`.

## Perubahan v3.2
- Link iklan di host asli (`storage.animein.net/ads/...`) kini dibuang; sniffing URL video dari semua request browser, JSON, dan HTML (tanpa perlu ekstensi `.mp4`).
- `thumbnail` episode dihapus dari respons.
- Deteksi episode diperluas: XHR (key apa pun), `__NEXT_DATA__`, scroll/tab Episode, fallback DOM teks. Nomor episode yang bolong dilaporkan di `meta.warnings`. Jika tetap kosong, respons memuat `diagnostics` (XHR yang terlihat, apakah diblok Cloudflare). Hasil kosong tidak di-cache.
