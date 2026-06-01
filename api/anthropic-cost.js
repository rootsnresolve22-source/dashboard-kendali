// api/anthropic-cost.js — "Petugas Penarik Biaya Anthropic" (Fase 3B)
// Menarik biaya (cost) pemakaian Anthropic via Admin API, lalu menyimpan ringkasannya
// ke tabel anthropic_cost di Supabase. Dipanggil penjadwal (cron) atau manual (?token=).
//
// Catatan penting:
// - Cost API Anthropic melaporkan angka dalam SEN (cents) -> dibagi 100 = USD.
// - Cost API membandingkan per-TANGGAL & menolak tanggal akhir = tanggal mulai / masa depan.
//   Maka kita memakai HARI-HARI YANG SUDAH SELESAI: 30 hari lalu -> awal hari ini (UTC).

var TIMEOUT_MS = 3500;
var DB_TIMEOUT_MS = 1000;

function fetchTimeout(url, opts, ms) {
  var ctl = new AbortController();
  var t = setTimeout(function () { ctl.abort(); }, ms);
  var o = Object.assign({}, opts || {}, { signal: ctl.signal });
  return fetch(url, o).finally(function () { clearTimeout(t); });
}

// Ringkas respons cost_report: total 30 hari, bulan-berjalan (MTD), jumlah bucket
function summarize(data, monthStartMs) {
  var totalCents = 0, mtdCents = 0, buckets = 0;
  (data || []).forEach(function (b) {
    buckets++;
    var bMs = (b && b.starting_at) ? Date.parse(b.starting_at) : NaN;
    var bCents = 0;
    var results = (b && b.results) ? b.results : [];
    results.forEach(function (it) {
      var amt = (it && it.amount != null) ? it.amount
              : (it && it.cost != null) ? it.cost
              : null;
      if (amt != null) { var n = Number(amt); if (!isNaN(n)) bCents += n; }
    });
    totalCents += bCents;
    if (!isNaN(bMs) && bMs >= monthStartMs) mtdCents += bCents;
  });
  return { totalCents: totalCents, mtdCents: mtdCents, buckets: buckets };
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

  // --- Rentang: 30 hari lalu -> AWAL HARI INI (UTC), hari-hari yang sudah selesai ---
  var now = new Date();
  var startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  var startRange = new Date(startOfToday.getTime() - 30 * 86400000);
  var monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  var startIso = startRange.toISOString();
  var endIso = startOfToday.toISOString();

  // --- Tarik cost_report ---
  var total30 = null, mtd = null, dailyAvg = null, monthlyProj = null, buckets = 0, sample = null;
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
    var withData = (body.data || []).filter(function (b) { return b && b.results && b.results.length; });
    sample = (withData.length ? withData : (body.data || [])).slice(0, 2);
    var s = summarize(body.data, monthStart.getTime());
    buckets = s.buckets;
    total30 = Math.round(s.totalCents) / 100;
    mtd = Math.round(s.mtdCents) / 100;
    dailyAvg = Math.round(s.totalCents / 30) / 100;
    monthlyProj = Math.round(dailyAvg * 30 * 100) / 100;
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
      body: JSON.stringify([{ id: 1, month_start: monthStart.toISOString().slice(0, 10), total_usd: mtd, last30_usd: total30, daily_avg_usd: dailyAvg, monthly_proj_usd: monthlyProj, fetched_at: new Date().toISOString() }])
    }, DB_TIMEOUT_MS);
    saved = ins.ok;
    if (!ins.ok) saveErr = "insert http " + ins.status + ": " + (await ins.text());
  } catch (e) { saveErr = (e && e.message) ? e.message : String(e); }

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");
  res.status(200).json({
    ok: true,
    range: { start: startIso.slice(0, 10), end: endIso.slice(0, 10) },
    month_to_date_usd: mtd,
    last30_usd: total30,
    daily_avg_usd: dailyAvg,
    monthly_projection_usd: monthlyProj,
    buckets: buckets,
    saved: saved,
    saveErr: saveErr,
    raw_sample: sample
  });
};
