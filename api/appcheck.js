// api/appcheck.js — "Indra Aplikasi" (Fase 5)
// Membaca Supabase rempangops (READ-ONLY): kapan record terakhir masuk di tiap tabel
// "denyut nadi", hitung jam sejak aktivitas terakhir, lalu tentukan STATUS per tabel
// memakai ambang (alarm_hours) khusus per tabel. Simpan ke app_health (dashboard).
// Token-protected. Self-diagnosing.
//
// Status: ok (normal) | warn (mendekati ambang) | alarm (lewat ambang) | no_data (belum ada
// data / menunggu data pertama) | error (gagal baca).

var REQ_TIMEOUT_MS = 2500;
var DB_TIMEOUT_MS = 1500;
var D = 24; // hari dalam jam

// tabel -> label ramah, kolom waktu kandidat (urut: paling mungkin dulu), ambang alarm (jam)
var TABLES = [
  { key: "activity_log",              label: "Log Aktivitas",                cols: ["created_at"],                                alarm: 2 * D },
  { key: "warga",                     label: "Data Warga",                   cols: ["created_at", "tanggal", "updated_at"],       alarm: 2 * D },
  { key: "komsos_history",            label: "Komsos — Riwayat",             cols: ["created_at", "tanggal"],                     alarm: 2 * D },
  { key: "komsos_perubahan_dukungan", label: "Komsos — Perubahan Dukungan",  cols: ["created_at", "tanggal"],                     alarm: 2 * D },
  { key: "komsos_perubahan_luas",     label: "Komsos — Perubahan Luas",      cols: ["created_at", "tanggal"],                     alarm: 2 * D },
  { key: "gps_tracking",              label: "Pelacakan GPS",                cols: ["updated_at", "created_at", "recorded_at"],   alarm: 3 * D },
  { key: "laporan_harian",            label: "Laporan Harian",               cols: ["created_at", "tanggal"],                     alarm: 3 * D },
  { key: "tasks",                     label: "Tugas",                        cols: ["created_at", "updated_at"],                  alarm: 7 * D },
  { key: "status_history",            label: "Status Tugas/Survei",          cols: ["created_at"],                                alarm: 7 * D },
  { key: "temuan_ilegal",             label: "Temuan Ilegal",                cols: ["created_at", "tanggal"],                     alarm: 30 * D },
  { key: "pemetaan_uploads",          label: "Unggahan Pemetaan",            cols: ["created_at"],                                alarm: 30 * D },
  { key: "approvals",                 label: "Persetujuan",                  cols: ["submitted_at", "reviewed_at", "created_at"], alarm: 30 * D },
  { key: "kegiatan",                  label: "Kegiatan",                     cols: ["created_at", "tanggal", "updated_at"],       alarm: 30 * D },
  { key: "kegiatan_review_state",     label: "Review Kegiatan",              cols: ["created_at", "reviewed_at"],                 alarm: 30 * D },
  { key: "land_polygons",             label: "Poligon Lahan",                cols: ["created_at"],                                alarm: 60 * D },
  { key: "personel",                  label: "Personel",                     cols: ["created_at", "updated_at", "join_date"],     alarm: 60 * D }
];

function fetchTimeout(url, opts, ms) {
  var ctl = new AbortController();
  var t = setTimeout(function () { ctl.abort(); }, ms);
  var o = Object.assign({}, opts || {}, { signal: ctl.signal });
  return fetch(url, o).finally(function () { clearTimeout(t); });
}

function computeState(probe, alarmHours) {
  if (!probe.ok) return "error";
  if (probe.rows === 0 || probe.latest == null || probe.hours_since == null) return "no_data";
  if (alarmHours == null) return "ok";
  if (probe.hours_since > alarmHours) return "alarm";
  if (probe.hours_since > alarmHours * 0.75) return "warn";
  return "ok";
}

async function probeTable(REMP_URL, REMP_KEY, t, now) {
  var headers = { "apikey": REMP_KEY, "Authorization": "Bearer " + REMP_KEY };
  var lastErr = null;
  for (var i = 0; i < t.cols.length; i++) {
    var col = t.cols[i];
    try {
      var url = REMP_URL + "/rest/v1/" + t.key + "?select=" + col + "&order=" + col + ".desc&limit=1";
      var r = await fetchTimeout(url, { headers: headers }, REQ_TIMEOUT_MS);
      if (r.status === 400) { lastErr = "kolom '" + col + "' tidak ada"; continue; }
      if (!r.ok) { lastErr = "http " + r.status; continue; }
      var arr = await r.json();
      if (!Array.isArray(arr)) { lastErr = "respons bukan array"; continue; }
      if (arr.length === 0) return { ok: true, timecol: col, latest: null, hours_since: null, rows: 0 };
      var val = arr[0][col];
      var ms = val ? Date.parse(val) : NaN;
      var hours = isNaN(ms) ? null : Math.round((now - ms) / 3600000 * 10) / 10;
      return { ok: true, timecol: col, latest: val || null, hours_since: hours, rows: 1 };
    } catch (e) {
      lastErr = (e && e.name === "AbortError") ? "timeout" : ((e && e.message) || String(e));
    }
  }
  return { ok: false, timecol: null, latest: null, hours_since: null, rows: 0, error: lastErr || "gagal" };
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

  var results = await Promise.all(TABLES.map(function (t) {
    return probeTable(REMP_URL, REMP_KEY, t, now).then(function (p) {
      p.key = t.key; p.label = t.label; p.alarm_hours = t.alarm;
      p.state = computeState(p, t.alarm);
      return p;
    });
  }));

  // Simpan ke app_health
  var saved = false, saveErr = null;
  try {
    var rows = results.map(function (r, i) {
      return {
        table_key: r.key, label: r.label, ok: !!r.ok, state: r.state, timecol: r.timecol,
        latest_at: r.latest, hours_since: r.hours_since, alarm_hours: r.alarm_hours,
        note: r.error || null, sort_order: i, updated_at: nowIso
      };
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

  // Ringkasan per status
  var by = { ok: 0, warn: 0, alarm: 0, no_data: 0, error: 0 };
  results.forEach(function (r) { by[r.state] = (by[r.state] || 0) + 1; });
  var alarms = results.filter(function (r) { return r.state === "alarm"; }).map(function (r) { return r.label; });

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    ok: true, checked_at: nowIso, tables_total: TABLES.length,
    summary: by, alarms: alarms, saved: saved, saveErr: saveErr,
    results: results.map(function (r) { return { key: r.key, state: r.state, hours_since: r.hours_since, alarm_hours: r.alarm_hours, timecol: r.timecol, note: r.error || null }; })
  });
};
