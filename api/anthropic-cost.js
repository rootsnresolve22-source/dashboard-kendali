// api/anthropic-cost.js — "Petugas Penarik Biaya Anthropic" (Fase 3B)
// Menarik biaya (cost) pemakaian Anthropic via Admin API, lalu menyimpan ringkasannya
// ke tabel anthropic_cost di Supabase. Dipanggil penjadwal (cron) atau manual (?token=).
//
// Catatan penting (TERVERIFIKASI dari data asli, BUKAN dari dokumen):
// - Field "amount" pada cost_report bernilai DOLLAR (USD), mis. "12.539" = $12,539.
//   (Dokumen Anthropic menyebut "cents", tetapi data nyata = dollar. Jangan dibagi 100.)
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

function round2(x) { return Math.round(x * 100) / 100; }

// Ringkas respons cost_report (amount dalam USD): total 30 hari, bulan-berjalan (MTD), bucket
function summarize(data, monthStartMs, sinceMs) {
  var totalUsd = 0, mtdUsd = 0, sinceUsd = 0, buckets = 0;
  (data || []).forEach(function (b) {
    buckets++;
    var bMs = (b && b.starting_at) ? Date.parse(b.starting_at) : NaN;
    var bUsd = 0;
    var results = (b && b.results) ? b.results : [];
    results.forEach(function (it) {
      var amt = (it && it.amount != null) ? it.amount
              : (it && it.cost != null) ? it.cost
              : null;
      if (amt != null) { var n = Number(amt); if (!isNaN(n)) bUsd += n; }
    });
    totalUsd += bUsd;
    if (!isNaN(bMs) && bMs >= monthStartMs) mtdUsd += bUsd;
    if (sinceMs != null && !isNaN(bMs) && bMs >= sinceMs) sinceUsd += bUsd;
  });
  return { totalUsd: totalUsd, mtdUsd: mtdUsd, sinceUsd: sinceUsd, buckets: buckets };
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

  // --- Baca saldo manual (bila ada) untuk hitung sisa ---
  var balanceAmount = null, balanceAsOf = null, balanceAsOfMs = null;
  try {
    var br = await fetchTimeout(SUPA_URL + "/rest/v1/anthropic_balance?id=eq.1&select=balance_amount,balance_as_of", {
      headers: { "apikey": SECRET, "Authorization": "Bearer " + SECRET }
    }, DB_TIMEOUT_MS);
    if (br.ok) {
      var barr = await br.json();
      if (Array.isArray(barr) && barr.length && barr[0].balance_amount != null) {
        balanceAmount = Number(barr[0].balance_amount);
        balanceAsOf = barr[0].balance_as_of || null;
        if (balanceAsOf) balanceAsOfMs = Date.parse(balanceAsOf);
      }
    }
  } catch (e) { /* saldo opsional; abaikan bila gagal */ }

  // --- Rentang: 30 hari lalu (atau sejak tgl saldo bila lebih awal) -> AWAL HARI INI (UTC) ---
  // Anthropic cost_report: bucket harian & limit MAKS 31 -> rentang maksimum 31 hari per panggilan.
  var now = new Date();
  var startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  var start30 = new Date(startOfToday.getTime() - 30 * 86400000);
  var minStart = new Date(startOfToday.getTime() - 31 * 86400000);
  var startRange = start30;
  if (balanceAsOfMs != null && !isNaN(balanceAsOfMs) && balanceAsOfMs < startRange.getTime()) {
    startRange = new Date(balanceAsOfMs);
  }
  var balanceStale = false;
  if (startRange.getTime() < minStart.getTime()) { startRange = minStart; balanceStale = true; }
  var monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  var startIso = startRange.toISOString();
  var endIso = startOfToday.toISOString();
  var limit = 31;

  // --- Tarik cost_report ---
  var total30 = null, mtd = null, dailyAvg = null, monthlyProj = null, buckets = 0, sample = null;
  var remaining = null, runoutDays = null, costSince = null, dailySeries = null;
  try {
    var url = "https://api.anthropic.com/v1/organizations/cost_report"
      + "?starting_at=" + encodeURIComponent(startIso)
      + "&ending_at=" + encodeURIComponent(endIso)
      + "&limit=" + limit;
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
    var s = summarize(body.data, monthStart.getTime(), balanceAsOfMs);
    buckets = s.buckets;
    // 30 hari: jumlah cost pada jendela 30-hari tetap (bukan rentang yang mungkin diperlebar)
    var s30 = summarize(body.data, monthStart.getTime(), start30.getTime());
    total30 = round2(s30.sinceUsd);
    mtd = round2(s.mtdUsd);
    dailyAvg = round2(total30 / 30);
    monthlyProj = round2(dailyAvg * 30);
    // sisa saldo & ramalan habis
    if (balanceAmount != null) {
      costSince = round2(s.sinceUsd);
      remaining = round2(balanceAmount - costSince);
      if (dailyAvg > 0) runoutDays = Math.max(0, Math.round((remaining / dailyAvg) * 10) / 10);
    }
    // deret harian 30 hari (untuk chart): {d:'MM-DD', v:usd}
    var byDay = {};
    (body.data || []).forEach(function (b) {
      var ms = b && b.starting_at ? Date.parse(b.starting_at) : NaN;
      if (isNaN(ms) || ms < start30.getTime()) return;
      var usd = 0; (b.results || []).forEach(function (it) { var a = it && it.amount != null ? it.amount : (it && it.cost != null ? it.cost : null); if (a != null) { var n = Number(a); if (!isNaN(n)) usd += n; } });
      byDay[new Date(ms).toISOString().slice(5, 10)] = round2(usd);
    });
    dailySeries = [];
    for (var di = 30; di >= 1; di--) { var dd = new Date(startOfToday.getTime() - di * 86400000).toISOString().slice(5, 10); dailySeries.push({ d: dd, v: byDay[dd] != null ? byDay[dd] : 0 }); }
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
      body: JSON.stringify([{ id: 1, month_start: monthStart.toISOString().slice(0, 10), total_usd: mtd, last30_usd: total30, daily_avg_usd: dailyAvg, monthly_proj_usd: monthlyProj, remaining_usd: remaining, runout_days: runoutDays, cost_since_balance: costSince, daily_series: dailySeries, fetched_at: new Date().toISOString() }])
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
    balance_amount: balanceAmount,
    balance_as_of: balanceAsOf,
    cost_since_balance: costSince,
    remaining_usd: remaining,
    runout_days: runoutDays,
    daily_series: dailySeries,
    balance_stale: balanceStale,
    buckets: buckets,
    saved: saved,
    saveErr: saveErr,
    raw_sample: sample
  });
};
