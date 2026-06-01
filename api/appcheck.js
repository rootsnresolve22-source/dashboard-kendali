// api/appcheck.js — "Indra Aplikasi" (Fase 5)
// Membaca Supabase rempangops (READ-ONLY) untuk tahu kapan record terakhir masuk
// di tiap tabel "denyut nadi", lalu hitung "jam sejak aktivitas terakhir".
// Hasil disimpan ke tabel app_health (dashboard). Token-protected. Self-diagnosing.
//
// Catatan: kolom waktu tiap tabel diverifikasi dari skema/kode rempangops; bila ada yang
// meleset, petugas mencoba kolom cadangan & melaporkannya di output (untuk kalibrasi).

var REQ_TIMEOUT_MS = 2500;
var DB_TIMEOUT_MS = 1500;

// tabel -> kolom waktu kandidat (urut: paling mungkin dulu)
var TABLES = [
  { key: "laporan_harian",            cols: ["created_at", "tanggal"] },
  { key: "komsos_history",            cols: ["created_at", "tanggal"] },
  { key: "status_history",            cols: ["created_at"] },
  { key: "tasks",                     cols: ["created_at", "updated_at"] },
  { key: "gps_tracking",              cols: ["updated_at", "created_at", "recorded_at"] },
  { key: "activity_log",              cols: ["created_at"] },
  { key: "land_polygons",             cols: ["created_at"] },
  { key: "pemetaan_uploads",          cols: ["created_at"] },
  { key: "temuan_ilegal",             cols: ["created_at", "tanggal"] },
  { key: "komsos_perubahan_dukungan", cols: ["created_at", "tanggal"] },
  { key: "komsos_perubahan_luas",     cols: ["created_at", "tanggal"] },
  { key: "warga",                     cols: ["created_at", "tanggal", "updated_at"] },
  { key: "approvals",                 cols: ["submitted_at", "reviewed_at", "created_at"] },
  { key: "personel",                  cols: ["created_at", "updated_at", "join_date"] },
  { key: "kegiatan",                  cols: ["created_at", "tanggal", "updated_at"] },
  { key: "kegiatan_review_state",     cols: ["created_at", "reviewed_at"] }
];

function fetchTimeout(url, opts, ms) {
  var ctl = new AbortController();
  var t = setTimeout(function () { ctl.abort(); }, ms);
  var o = Object.assign({}, opts || {}, { signal: ctl.signal });
  return fetch(url, o).finally(function () { clearTimeout(t); });
}

// Coba baca record terbaru tabel: kembalikan {ok, timecol, latest, hours_since, rows, error}
async function probeTable(REMP_URL, REMP_KEY, t, now) {
  var headers = { "apikey": REMP_KEY, "Authorization": "Bearer " + REMP_KEY };
  var lastErr = null;
  for (var i = 0; i < t.cols.length; i++) {
    var col = t.cols[i];
    try {
      var url = REMP_URL + "/rest/v1/" + t.key + "?select=" + col + "&order=" + col + ".desc&limit=1";
      var r = await fetchTimeout(url, { headers: headers }, REQ_TIMEOUT_MS);
      if (r.status === 400) { lastErr = "kolom '" + col + "' tidak ada"; continue; } // coba kolom lain
      if (!r.ok) { lastErr = "http " + r.status; continue; }
      var arr = await r.json();
      if (!Array.isArray(arr)) { lastErr = "respons bukan array"; continue; }
      if (arr.length === 0) return { ok: true, timecol: col, latest: null, hours_since: null, rows: 0 }; // tabel kosong
      var val = arr[0][col];
      var ms = val ? Date.parse(val) : NaN;
      var hours = isNaN(ms) ? null : Math.round((now - ms) / 3600000 * 10) / 10;
      return { ok: true, timecol: col, latest: val || null, hours_since: hours, rows: 1 };
    } catch (e) {
      lastErr = (e && e.name === "AbortError") ? "timeout" : ((e && e.message) || String(e));
    }
  }
  return { ok: false, timecol: null, latest: null, hours_since: null, error: lastErr || "gagal" };
}

module.exports = async function (req, res) {
  var token = "";
  try { var u = new URL(req.url, "http://x"); token = u.searchParams.get("token") || ""; } catch (e) {}
  if (!token && req.query && req.query.token) token = req.query.token;
  var expected = process.env.CHECK_TOKEN || "";
  res.setHeader("Content-Type", "application/json");
  if (!expected || token !== expected) { res.status(401).json({ ok: false, error: "unauthorized" }); return; }

  var REMP_URL = process.env.REMPANG_SUPABASE_URL;
  var REMP_KEY = process.env.REMPANG_SUPABASE_KEY;
  var SUPA_URL = process.env.SUPABASE_URL;
  var SECRET = process.env.SUPABASE_SECRET_KEY;
  if (!REMP_URL || !REMP_KEY) { res.status(500).json({ ok: false, error: "missing REMPANG_SUPABASE_URL or REMPANG_SUPABASE_KEY" }); return; }
  if (!SUPA_URL || !SECRET) { res.status(500).json({ ok: false, error: "missing SUPABASE_URL or SUPABASE_SECRET_KEY" }); return; }

  var now = Date.now(), nowIso = new Date(now).toISOString();

  // Periksa semua tabel paralel
  var results = await Promise.all(TABLES.map(function (t) {
    return probeTable(REMP_URL, REMP_KEY, t, now).then(function (r) { r.key = t.key; return r; });
  }));

  // Simpan ringkasan ke app_health (1 upsert batch)
  var saved = false, saveErr = null;
  try {
    var rows = results.map(function (r) {
      return { table_key: r.key, ok: !!r.ok, timecol: r.timecol, latest_at: r.latest, hours_since: r.hours_since, note: r.error || null, updated_at: nowIso };
    });
    var ins = await fetchTimeout(SUPA_URL + "/rest/v1/app_health?on_conflict=table_key", {
      method: "POST",
      headers: {
        "apikey": SECRET, "Authorization": "Bearer " + SECRET,
        "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify(rows)
    }, DB_TIMEOUT_MS);
    saved = ins.ok;
    if (!ins.ok) saveErr = "http " + ins.status + ": " + (await ins.text());
  } catch (e) { saveErr = (e && e.message) || String(e); }

  // Ringkasan diagnostik
  var okCount = results.filter(function (r) { return r.ok; }).length;
  var failed = results.filter(function (r) { return !r.ok; }).map(function (r) { return { key: r.key, error: r.error }; });

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    ok: true, checked_at: nowIso, tables_total: TABLES.length, tables_ok: okCount,
    saved: saved, saveErr: saveErr,
    failed: failed,
    results: results
  });
};
