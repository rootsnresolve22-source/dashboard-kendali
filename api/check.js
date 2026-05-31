// api/check.js — "Petugas Pengecek" (Fase 1)
// Mengecek tiap layanan (merespons? seberapa cepat?), lalu menyimpan hasil ke Supabase.
// Dipanggil oleh penjadwal (cron) tiap 10 menit, atau manual lewat ?token=...
//
// Klasifikasi:
//   'up'       = merespons normal (hijau)
//   'degraded' = merespons tapi lambat / gangguan ringan (kuning)
//   'down'     = tidak merespons / error berat (merah)

// === Daftar yang dicek ===
// type 'ping'       = ketuk pintu server (respons apa pun = hidup; 5xx/timeout = bermasalah)
// type 'statuspage' = baca halaman status resmi (Statuspage.io)
var SERVICES = [
  { key: "vercel",     type: "ping",       url: "https://rempangops.com" },
  // PENTING: pastikan URL Supabase rempangops.com di bawah ini BENAR (lihat catatan ke Dimas):
  { key: "supabase",   type: "ping",       url: "https://fjtsvturtwxvgpvydajk.supabase.co/rest/v1/" },
  { key: "anthropic",  type: "statuspage", url: "https://status.anthropic.com/api/v2/status.json" },
  { key: "groq",       type: "ping",       url: "https://api.groq.com/" },
  { key: "gemini",     type: "ping",       url: "https://generativelanguage.googleapis.com/" },
  { key: "assemblyai", type: "ping",       url: "https://api.assemblyai.com/" },
  { key: "fonnte",     type: "ping",       url: "https://api.fonnte.com/" },
  { key: "maptiler",   type: "ping",       url: "https://api.maptiler.com/" }
];

var TIMEOUT_MS = 8000; // batas tunggu
var SLOW_MS = 3000;    // di atas ini dianggap 'degraded'

function fetchTimeout(url, opts, ms) {
  var ctl = new AbortController();
  var t = setTimeout(function () { ctl.abort(); }, ms);
  var o = Object.assign({}, opts || {}, { signal: ctl.signal });
  return fetch(url, o).finally(function () { clearTimeout(t); });
}

async function checkPing(svc) {
  var start = Date.now();
  try {
    var res = await fetchTimeout(svc.url, { method: "GET" }, TIMEOUT_MS);
    var latency = Date.now() - start;
    var code = res.status;
    var status;
    if (code >= 500) status = "down";          // server error
    else if (latency > SLOW_MS) status = "degraded";
    else status = "up";                          // 2xx/3xx/4xx = server hidup
    return { status: status, latency_ms: latency, http_code: code, detail: null };
  } catch (e) {
    var lat = Date.now() - start;
    var msg = (e && e.name === "AbortError") ? "timeout" : (e && e.message ? e.message : "error");
    return { status: "down", latency_ms: lat, http_code: null, detail: msg };
  }
}

async function checkStatuspage(svc) {
  var start = Date.now();
  try {
    var res = await fetchTimeout(svc.url, {}, TIMEOUT_MS);
    var latency = Date.now() - start;
    if (!res.ok) {
      return { status: (res.status >= 500 ? "down" : "up"), latency_ms: latency, http_code: res.status, detail: "statuspage http " + res.status };
    }
    var data = await res.json();
    var ind = (data && data.status && data.status.indicator) ? data.status.indicator : "unknown";
    var desc = (data && data.status && data.status.description) ? data.status.description : "";
    var status;
    if (ind === "none") status = "up";
    else if (ind === "minor") status = "degraded";
    else if (ind === "major" || ind === "critical") status = "down";
    else status = "up";
    return { status: status, latency_ms: latency, http_code: res.status, detail: desc || ind };
  } catch (e) {
    var lat = Date.now() - start;
    var msg = (e && e.name === "AbortError") ? "timeout" : (e && e.message ? e.message : "error");
    return { status: "down", latency_ms: lat, http_code: null, detail: msg };
  }
}

module.exports = async function (req, res) {
  // --- Proteksi token ---
  var token = "";
  try {
    var u = new URL(req.url, "http://x");
    token = u.searchParams.get("token") || "";
  } catch (e) {}
  if (!token && req.query && req.query.token) token = req.query.token;

  var expected = process.env.CHECK_TOKEN || "";
  if (!expected || token !== expected) {
    res.setHeader("Content-Type", "application/json");
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  var SUPA_URL = process.env.SUPABASE_URL;
  var SECRET = process.env.SUPABASE_SECRET_KEY;
  if (!SUPA_URL || !SECRET) {
    res.status(500).json({ ok: false, error: "missing SUPABASE_URL or SUPABASE_SECRET_KEY" });
    return;
  }

  // --- Jalankan semua cek paralel ---
  var nowIso = new Date().toISOString();
  var results = await Promise.all(SERVICES.map(async function (svc) {
    var r = (svc.type === "statuspage") ? await checkStatuspage(svc) : await checkPing(svc);
    return {
      service_key: svc.key,
      status: r.status,
      latency_ms: r.latency_ms,
      http_code: r.http_code,
      detail: r.detail,
      checked_at: nowIso
    };
  }));

  // --- Simpan ke Supabase (sekali kirim, banyak baris) ---
  var saved = false, saveErr = null;
  try {
    var ins = await fetchTimeout(SUPA_URL + "/rest/v1/status_history", {
      method: "POST",
      headers: {
        "apikey": SECRET,
        "Authorization": "Bearer " + SECRET,
        "Content-Type": "application/json",
        "Prefer": "return=minimal"
      },
      body: JSON.stringify(results)
    }, TIMEOUT_MS);
    saved = ins.ok;
    if (!ins.ok) { saveErr = "insert http " + ins.status + ": " + (await ins.text()); }
  } catch (e) {
    saveErr = (e && e.message) ? e.message : String(e);
  }

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");
  res.status(200).json({ ok: true, saved: saved, saveErr: saveErr, count: results.length, checked_at: nowIso, results: results });
};
