// api/anthropic-cost.js — "Petugas Penarik Biaya Anthropic" (Fase 3B)
// Menarik total biaya (cost) pemakaian Anthropic bulan berjalan via Admin API,
// lalu menyimpannya ke tabel anthropic_cost di Supabase.
// Dipanggil penjadwal (cron) berkala, atau manual lewat ?token=...
//
// Catatan: Cost API Anthropic melaporkan angka dalam SEN (cents) → dibagi 100 = USD.

var TIMEOUT_MS = 3500;   // batas tunggu panggil Anthropic (jaga < batas cron 5000ms)
var DB_TIMEOUT_MS = 1000;

function fetchTimeout(url, opts, ms) {
  var ctl = new AbortController();
  var t = setTimeout(function () { ctl.abort(); }, ms);
  var o = Object.assign({}, opts || {}, { signal: ctl.signal });
  return fetch(url, o).finally(function () { clearTimeout(t); });
}

// Jumlahkan semua nilai biaya (sen) dari struktur respons cost_report
function sumCents(data) {
  var cents = 0, buckets = 0;
  (data || []).forEach(function (bucket) {
    buckets++;
    var results = bucket && bucket.results ? bucket.results : [];
    results.forEach(function (it) {
      var amt = (it && it.amount != null) ? it.amount
              : (it && it.cost != null) ? it.cost
              : null;
      if (amt != null) { var n = Number(amt); if (!isNaN(n)) cents += n; }
    });
  });
  return { cents: cents, buckets: buckets };
}

module.exports = async function (req, res) {
  // --- Proteksi token ---
  var token = "";
  try { var u = new URL(req.url, "http://x"); token = u.searchParams.get("token") || ""; } catch (e) {}
  if (!token && req.query && req.query.token) token = req.query.token;
  var expected = process.env.CHECK_TOKEN || "";
  if (!expected || token !== expected) {
    res.setHeader("Content-Type", "application/json");
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  var ADMIN = process.env.ANTHROPIC_ADMIN_KEY;
  var SUPA_URL = process.env.SUPABASE_URL;
  var SECRET = process.env.SUPABASE_SECRET_KEY;
  if (!ADMIN) { res.status(500).json({ ok: false, error: "missing ANTHROPIC_ADMIN_KEY" }); return; }
  if (!SUPA_URL || !SECRET) { res.status(500).json({ ok: false, error: "missing SUPABASE_URL or SUPABASE_SECRET_KEY" }); return; }

  // --- Periode bulan berjalan (UTC) ---
  var now = new Date();
  var monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  var ending = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)); // besok 00:00 UTC (inklusif hari ini)
  var startIso = monthStart.toISOString();
  var endIso = ending.toISOString();

  // --- Tarik cost_report Anthropic ---
  var totalUsd = null, buckets = 0, sample = null;
  try {
    var url = "https://api.anthropic.com/v1/organizations/cost_report"
      + "?starting_at=" + encodeURIComponent(startIso)
      + "&ending_at=" + encodeURIComponent(endIso)
      + "&limit=31";
    var r = await fetchTimeout(url, {
      headers: {
        "anthropic-version": "2023-06-01",
        "x-api-key": ADMIN,
        "User-Agent": "DashboardKendali/1.0 (rempangops.com)"
      }
    }, TIMEOUT_MS);
    var body = await r.json();
    if (!r.ok) { res.status(200).json({ ok: false, stage: "anthropic", http: r.status, body: body }); return; }
    sample = (body.data || []).slice(0, 2); // contoh untuk verifikasi struktur
    var s = sumCents(body.data);
    buckets = s.buckets;
    totalUsd = Math.round(s.cents) / 100;
  } catch (e) {
    var msg = (e && e.name === "AbortError") ? "timeout" : (e && e.message ? e.message : String(e));
    res.status(200).json({ ok: false, stage: "anthropic", error: msg });
    return;
  }

  // --- Simpan ke Supabase (upsert satu baris id=1) ---
  var saved = false, saveErr = null;
  try {
    var ins = await fetchTimeout(SUPA_URL + "/rest/v1/anthropic_cost?on_conflict=id", {
      method: "POST",
      headers: {
        "apikey": SECRET,
        "Authorization": "Bearer " + SECRET,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify([{ id: 1, month_start: startIso.slice(0, 10), total_usd: totalUsd, fetched_at: new Date().toISOString() }])
    }, DB_TIMEOUT_MS);
    saved = ins.ok;
    if (!ins.ok) saveErr = "insert http " + ins.status + ": " + (await ins.text());
  } catch (e) { saveErr = (e && e.message) ? e.message : String(e); }

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");
  res.status(200).json({
    ok: true,
    month_start: startIso.slice(0, 10),
    total_usd: totalUsd,
    buckets: buckets,
    saved: saved,
    saveErr: saveErr,
    raw_sample: sample
  });
};
