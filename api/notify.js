// api/notify.js — "Petugas Notifikasi" (Fase 4a)
// Kirim WhatsApp via Fonnte saat:
//   (1) status layanan BERUBAH (mati/lambat -> kirim; pulih -> kirim "normal"),
//   (2) tanggal kritis <= ambang (kirim sekali per hari).
// Anti-spam: simpan keadaan terakhir di tabel notif_state; kirim hanya saat berubah.
// Dipanggil penjadwal (cron) atau manual (?token=). Mode tes: ?token=...&test=1
//
// Catatan Fonnte: POST https://api.fonnte.com/send, header "Authorization: <token device>"
// (TANPA Bearer), body form: target + message.

var TIMEOUT_MS = 4000;
var DB_TIMEOUT_MS = 1000;
var DUE_THRESHOLD_DAYS = 7;   // kirim pengingat tanggal bila tersisa <= 7 hari (sekali/hari)
var RUNOUT_THRESHOLD_DAYS = 7; // alarm saldo Anthropic bila diperkirakan habis <= 7 hari (sekali/hari)

var SVC_NAMES = {
  vercel: "Vercel (hosting)", supabase: "Supabase (database)", anthropic: "Anthropic (Claude)",
  groq: "Groq", gemini: "Google Gemini", assemblyai: "AssemblyAI (suara)",
  fonnte: "Fonnte (WhatsApp)", maptiler: "MapTiler (peta)"
};
function svcName(k) { return SVC_NAMES[k] || k; }

function fetchTimeout(url, opts, ms) {
  var ctl = new AbortController();
  var t = setTimeout(function () { ctl.abort(); }, ms);
  var o = Object.assign({}, opts || {}, { signal: ctl.signal });
  return fetch(url, o).finally(function () { clearTimeout(t); });
}

function startOfDayUTC(d) { return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }
function daysUntilDate(due, now) {
  var p = String(due).split("-");
  var target = Date.UTC(+p[0], (+p[1]) - 1, +p[2]);
  return Math.round((target - startOfDayUTC(now)) / 86400000);
}
function fmtDateID(due) {
  var p = String(due).split("-");
  var bln = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
  return (+p[2]) + " " + bln[(+p[1]) - 1] + " " + p[0];
}

async function sbGet(SUPA_URL, SECRET, path) {
  var r = await fetchTimeout(SUPA_URL + "/rest/v1/" + path, {
    headers: { "apikey": SECRET, "Authorization": "Bearer " + SECRET }
  }, DB_TIMEOUT_MS);
  if (!r.ok) throw new Error("GET " + path + " -> " + r.status);
  return r.json();
}

async function sbUpsert(SUPA_URL, SECRET, table, rows) {
  return fetchTimeout(SUPA_URL + "/rest/v1/" + table + "?on_conflict=alert_key", {
    method: "POST",
    headers: {
      "apikey": SECRET, "Authorization": "Bearer " + SECRET,
      "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify(rows)
  }, DB_TIMEOUT_MS);
}

async function sendWA(token, target, message) {
  return fetchTimeout("https://api.fonnte.com/send", {
    method: "POST",
    headers: { "Authorization": token, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ target: target, message: message }).toString()
  }, TIMEOUT_MS);
}

async function sendEmail(key, from, to, subject, text) {
  return fetchTimeout("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ from: from, to: [to], subject: subject, text: text })
  }, TIMEOUT_MS);
}

module.exports = async function (req, res) {
  // --- Proteksi token ---
  var token = "", test = false;
  try { var u = new URL(req.url, "http://x"); token = u.searchParams.get("token") || ""; test = u.searchParams.get("test") === "1"; } catch (e) {}
  if (!token && req.query) { token = req.query.token || ""; if (req.query.test === "1") test = true; }
  var expected = process.env.CHECK_TOKEN || "";
  res.setHeader("Content-Type", "application/json");
  if (!expected || token !== expected) { res.status(401).json({ ok: false, error: "unauthorized" }); return; }

  var FONNTE = process.env.FONNTE_TOKEN;
  var TARGET = process.env.ALERT_WA_TARGET;
  var RESEND = process.env.RESEND_API_KEY;                       // opsional (cadangan email)
  var MAIL_TO = process.env.ALERT_EMAIL_TO;                      // opsional
  var MAIL_FROM = process.env.ALERT_EMAIL_FROM || "Dashboard Kendali <onboarding@resend.dev>";
  var emailOn = !!(RESEND && MAIL_TO);
  var SUPA_URL = process.env.SUPABASE_URL;
  var SECRET = process.env.SUPABASE_SECRET_KEY;
  if (!FONNTE || !TARGET) { res.status(500).json({ ok: false, error: "missing FONNTE_TOKEN or ALERT_WA_TARGET" }); return; }
  if (!SUPA_URL || !SECRET) { res.status(500).json({ ok: false, error: "missing SUPABASE_URL or SUPABASE_SECRET_KEY" }); return; }

  // --- Mode tes: kirim 1 pesan tes lalu selesai ---
  if (test) {
    var out = { ok: true, mode: "test", email_on: emailOn };
    try {
      var wr = await sendWA(FONNTE, TARGET, "🔔 Dashboard Kendali\n\nTes notifikasi berhasil. Sistem peringatan aktif. ✅");
      out.wa_http = wr.status; out.wa_resp = await wr.text();
    } catch (e) { out.ok = false; out.wa_error = (e && e.message) || String(e); }
    if (emailOn) {
      try {
        var er = await sendEmail(RESEND, MAIL_FROM, MAIL_TO, "[Dashboard Kendali] Tes notifikasi", "Tes notifikasi email berhasil. Sistem peringatan cadangan (email) aktif.");
        out.email_http = er.status; out.email_resp = await er.text();
      } catch (e) { out.email_error = (e && e.message) || String(e); }
    }
    res.status(200).json(out);
    return;
  }

  var now = new Date(), nowIso = now.toISOString();
  var messages = [], alertUpdates = [], baselineUpdates = [];

  try {
    // 1) status terbaru per layanan (ambil 2 batch terakhir, pilih terbaru per layanan)
    var rows = await sbGet(SUPA_URL, SECRET, "status_history?select=service_key,status,checked_at&order=checked_at.desc&limit=24");
    var latest = {};
    rows.forEach(function (r) { if (!latest[r.service_key]) latest[r.service_key] = r; });

    // 2) keadaan terakhir (anti-spam)
    var stateRows = await sbGet(SUPA_URL, SECRET, "notif_state?select=alert_key,last_state,last_notified_at");
    var stateMap = {};
    stateRows.forEach(function (s) { stateMap[s.alert_key] = s; });

    // 3) evaluasi status
    Object.keys(latest).forEach(function (key) {
      var cur = latest[key].status; // up / degraded / down
      var akey = "svc:" + key;
      var prev = stateMap[akey] ? stateMap[akey].last_state : null;
      if (cur === prev) return;
      if (prev === null) {
        // baseline pertama: hanya beri tahu bila TIDAK sehat; selalu simpan baseline
        if (cur !== "up") { messages.push("⚠️ " + svcName(key) + " " + (cur === "down" ? "BERMASALAH" : "LAMBAT") + "."); alertUpdates.push({ alert_key: akey, last_state: cur, last_notified_at: nowIso }); }
        else baselineUpdates.push({ alert_key: akey, last_state: cur, last_notified_at: nowIso });
      } else if (cur === "up") {
        messages.push("✅ " + svcName(key) + " sudah PULIH.");
        alertUpdates.push({ alert_key: akey, last_state: cur, last_notified_at: nowIso });
      } else {
        messages.push("⚠️ " + svcName(key) + " " + (cur === "down" ? "BERMASALAH" : "LAMBAT") + ".");
        alertUpdates.push({ alert_key: akey, last_state: cur, last_notified_at: nowIso });
      }
    });

    // 4) evaluasi tanggal kritis
    var costs = await sbGet(SUPA_URL, SECRET, "cost_items?select=service_key,label,kind,due_date&kind=eq.fixed_date");
    costs.forEach(function (it) {
      if (!it.due_date) return;
      var days = daysUntilDate(it.due_date, now);
      if (days < 0 || days > DUE_THRESHOLD_DAYS) return;
      var akey = "due:" + it.service_key;
      var st = stateMap[akey];
      var sentToday = st && st.last_notified_at && String(st.last_notified_at).slice(0, 10) === nowIso.slice(0, 10);
      if (sentToday) return;
      var sisa = days === 0 ? "HARI INI" : (days + " hari lagi");
      messages.push("⏰ " + it.label + " kedaluwarsa " + sisa + " (" + fmtDateID(it.due_date) + "). Segera tindak lanjuti.");
      alertUpdates.push({ alert_key: akey, last_state: String(days), last_notified_at: nowIso });
    });

    // 4b) evaluasi denyut nadi aplikasi (app_health) — alarm bila data berhenti mengalir
    var health = await sbGet(SUPA_URL, SECRET, "app_health?select=table_key,label,state,hours_since,alarm_hours");
    health.forEach(function (h) {
      var akey = "app:" + h.table_key;
      var prev = stateMap[akey] ? stateMap[akey].last_state : null;
      var cur = h.state; // ok / warn / alarm / no_data / error
      var isAlarm = (cur === "alarm");
      var wasAlarm = (prev === "alarm");
      if (isAlarm && !wasAlarm) {
        // baru jadi alarm -> beri tahu
        var lama = (h.hours_since != null) ? (h.hours_since >= 48 ? Math.round(h.hours_since / 24) + " hari" : Math.round(h.hours_since) + " jam") : "?";
        messages.push("📉 " + (h.label || h.table_key) + ": tidak ada data baru " + lama + " (melewati batas). Cek apakah tim masih input atau aplikasi bermasalah.");
        alertUpdates.push({ alert_key: akey, last_state: cur, last_notified_at: nowIso });
      } else if (!isAlarm && wasAlarm && (cur === "ok" || cur === "warn")) {
        // pulih dari alarm -> beri tahu sekali
        messages.push("✅ " + (h.label || h.table_key) + ": data mengalir lagi (normal).");
        alertUpdates.push({ alert_key: akey, last_state: cur, last_notified_at: nowIso });
      } else if (cur !== prev) {
        // transisi lain (mis. no_data->ok) cukup catat state, tanpa kirim pesan
        baselineUpdates.push({ alert_key: akey, last_state: cur, last_notified_at: nowIso });
      }
    });

    // 4c) evaluasi saldo Anthropic — alarm bila diperkirakan habis dalam <= ambang hari
    var ac = await sbGet(SUPA_URL, SECRET, "anthropic_cost?id=eq.1&select=remaining_usd,runout_days");
    if (Array.isArray(ac) && ac.length && ac[0].runout_days != null) {
      var runout = Number(ac[0].runout_days);
      var rem = ac[0].remaining_usd != null ? Number(ac[0].remaining_usd) : null;
      if (runout <= RUNOUT_THRESHOLD_DAYS) {
        var bkey = "anthropic:balance";
        var bst = stateMap[bkey];
        var bSentToday = bst && bst.last_notified_at && String(bst.last_notified_at).slice(0, 10) === nowIso.slice(0, 10);
        if (!bSentToday) {
          if (runout <= 0) {
            messages.push("💳 Saldo Anthropic kemungkinan SUDAH HABIS" + (rem != null ? " (~$" + rem.toFixed(2) + ")" : "") + ". AI di rempangops bisa berhenti — segera isi ulang.");
          } else {
            messages.push("💳 Saldo Anthropic menipis" + (rem != null ? " (~$" + rem.toFixed(2) + ")" : "") + ": diperkirakan habis ~" + Math.round(runout) + " hari lagi. Segera isi ulang agar AI rempangops tetap jalan.");
          }
          alertUpdates.push({ alert_key: bkey, last_state: "low", last_notified_at: nowIso });
        }
      }
    }
  } catch (e) {
    res.status(200).json({ ok: false, stage: "evaluate", error: (e && e.message) || String(e) });
    return;
  }

  // 5) simpan baseline (selalu) + kirim WA bila ada pesan + simpan alert bila terkirim
  var sent = false, waResp = null, saveErr = null;
  try { if (baselineUpdates.length) await sbUpsert(SUPA_URL, SECRET, "notif_state", baselineUpdates); }
  catch (e) { saveErr = "baseline: " + ((e && e.message) || String(e)); }

  var emailSent = false, emailResp = null;
  if (messages.length) {
    var msg = "🔔 Dashboard Kendali\n\n" + messages.join("\n") + "\n\nBuka: project-ci2bd.vercel.app";
    try {
      var wr2 = await sendWA(FONNTE, TARGET, msg);
      sent = wr2.ok; waResp = await wr2.text();
    } catch (e) { saveErr = (saveErr ? saveErr + "; " : "") + "wa: " + ((e && e.message) || String(e)); }
    if (emailOn) {
      try {
        var er2 = await sendEmail(RESEND, MAIL_FROM, MAIL_TO, "[Dashboard Kendali] Peringatan", messages.join("\n") + "\n\nBuka: https://project-ci2bd.vercel.app");
        emailSent = er2.ok; emailResp = await er2.text();
      } catch (e) { saveErr = (saveErr ? saveErr + "; " : "") + "email: " + ((e && e.message) || String(e)); }
    }
    // Simpan state bila MINIMAL satu jalur terkirim (jangan ulang peringatan yang sudah sampai)
    if ((sent || emailSent) && alertUpdates.length) {
      try { await sbUpsert(SUPA_URL, SECRET, "notif_state", alertUpdates); }
      catch (e) { saveErr = (saveErr ? saveErr + "; " : "") + "state: " + ((e && e.message) || String(e)); }
    }
  }

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ ok: true, changes: messages.length, sent: sent, email_sent: emailSent, email_on: emailOn, messages: messages, wa_resp: waResp, email_resp: emailResp, saveErr: saveErr });
};
