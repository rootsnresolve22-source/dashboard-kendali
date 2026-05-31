// api/config.js
// Mengembalikan konfigurasi publik Supabase ke halaman web.
// CATATAN KEAMANAN:
// - Hanya mengembalikan URL + kunci "publishable/anon" yang MEMANG aman dilihat publik.
// - Kunci RAHASIA (secret / service key) TIDAK PERNAH dikirim ke sini.
// - Nilai diambil dari Environment Variables Vercel (terenkripsi), bukan ditulis di kode.

module.exports = function (req, res) {
  var url = process.env.SUPABASE_URL || "";
  var anonKey = process.env.SUPABASE_ANON_KEY || "";

  // hindari cache supaya selalu ambil nilai terbaru dari pengaturan
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");

  res.status(200).json({
    url: url,
    anonKey: anonKey,
    ok: Boolean(url && anonKey)
  });
};
