module.exports = (base) => `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NontonAnime API — Dokumentasi</title>
<style>
:root{--bg:#0f1115;--card:#171a21;--tx:#e8eaf0;--mut:#9aa3b2;--ac:#7c9cff;--bd:#262b36}
@media(prefers-color-scheme:light){:root{--bg:#f6f7fb;--card:#fff;--tx:#161a22;--mut:#5b6575;--ac:#3956d6;--bd:#e3e6ee}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.6 system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 18px 80px}h1{margin:0 0 4px}p.s{color:var(--mut);margin-top:0}
.card{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:18px 20px;margin:16px 0}
.m{display:inline-block;background:var(--ac);color:#fff;font-weight:700;font-size:12px;padding:2px 8px;border-radius:6px;margin-right:8px}
code,pre{font-family:ui-monospace,monospace;font-size:13px}pre{background:var(--bg);border:1px solid var(--bd);padding:12px;border-radius:8px;overflow:auto}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--bd);vertical-align:top}
a{color:var(--ac)}.mut{color:var(--mut)}
</style></head><body><main>
<h1>NontonAnime API</h1><p class="s">REST API scraper untuk animeinweb.com — Headless Chromium (stealth) + proxy.</p>

<div class="card"><span class="m">GET</span><code>/home</code>
<p>Scrape beranda animeinweb (daftar anime per section: terbaru, populer, dll). Contoh: <a href="${base}/home">${base}/home</a></p>
<pre>{ "success": true, "data": { "total": 3,
  "sections": [ { "name": "Terbaru", "total": 20, "items": [ { "id": "1755", "title": "...", "poster": "${base}/proxy?t=..." } ] } ] } }</pre></div>

<div class="card"><span class="m">GET</span><code>/search?q={query}</code>
<p>Cari anime. Contoh: <a href="${base}/search?q=conan">${base}/search?q=conan</a></p>
<table><tr><th>Param</th><th>Keterangan</th></tr>
<tr><td><code>q</code></td><td>Kata kunci (wajib)</td></tr>
<tr><td><code>page</code></td><td>Halaman hasil (opsional)</td></tr></table>
<pre>{ "success": true, "data": { "query": "conan", "total": 12,
  "results": [ { "id": "1755", "title": "...", "poster": "${base}/proxy?t=...", "type": "TV" } ] } }</pre></div>

<div class="card"><span class="m">GET</span><code>/nonton?id={anime_id}</code>
<p>Detail anime + daftar episode. Contoh: <a href="${base}/nonton?id=1755">${base}/nonton?id=1755</a></p>
<table><tr><th>Param</th><th>Keterangan</th></tr>
<tr><td><code>id</code></td><td>ID anime (wajib), dari <code>/anime/{id}</code>. Selalu mengembalikan <b>semua episode</b> (episode 1 sampai terbaru; semua halaman pagination digabung)</td></tr>
<tr><td><code>resolve</code></td><td><code>1</code> = ikut ambil link stream untuk episode terpilih (lebih lambat)</td></tr>
<tr><td><code>ep</code></td><td>Nomor episode yang di-resolve (default: <code>limit</code> episode pertama)</td></tr>
<tr><td><code>limit</code></td><td>Maks episode di-resolve (default 3, maks 10)</td></tr></table>
<pre>{ "success": true, "data": { "anime": { "id": "1755", "title": "...", "synopsis": "...", "poster": "(proxied)" },
  "totalEpisodes": 24,
  "episodes": [ { "number": 1, "title": "Episode 1",
     "watchUrl": "https://animeinweb.com/...", "resolveUrl": "${base}/episode?id=...&anime=1755",
     "streams": [ { "type": "hls", "url": "${base}/proxy?t=..." } ] } ] } }</pre></div>

<div class="card"><span class="m">GET</span><code>/episode?url={episode_page_url}</code>
<p>Ambil link video satu episode (gunakan <code>resolveUrl</code> dari <code>/nonton</code>). Link iklan dibuang; host video asli (<code>storage.animein…</code>) diutamakan. Param: <code>id</code> (id episode) + <code>anime</code>, atau <code>url</code> halaman nonton.</p></div>

<div class="card"><span class="m">GET</span><code>/proxy?t={token}</code>
<p>Proxy gambar &amp; stream (mendukung Range, playlist HLS ditulis ulang otomatis). Token dibuat otomatis oleh API dan ditandatangani (HMAC), jadi bukan open proxy.</p></div>

<div class="card"><span class="m">GET</span><code>/health</code> <span class="mut">— cek status</span></div>

<div class="card"><b>Auth (opsional)</b><p>Jika <code>API_KEY</code> di-set, kirim header <code>x-api-key</code> atau query <code>?apikey=</code>.</p>
<b>Error</b><pre>{ "success": false, "error": "pesan" }</pre></div>
</main></body></html>`;
