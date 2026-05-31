# Dashboard Kendali — Tech Stack Monitor

Alat internal PT MEG untuk memantau layanan teknologi yang menjalankan **rempangops.com**
dari satu layar (status, pemakaian, biaya). Sistem ini **hanya memantau** — tidak mengubah
aplikasi rempangops.com.

> Dokumen rancangan lengkap: `RANCANGAN_Dashboard_Kendali` (disimpan terpisah oleh admin).

## Status pembangunan
- **Fase 0 — Fondasi (saat ini):** kerangka aplikasi, login, tampilan kosong. ✅
- Fase 1 — Status & kesehatan layanan (otomatis tiap 10 menit).
- Fase 2 — Akses berlapis & manajemen pengguna (Admin / Eksekutif).
- Fase 3 — Billing & forecast (jatuh tempo, perkiraan saldo).
- Fase 4 — Notifikasi (WhatsApp via Fonnte + fallback email).
- Fase 5 — Pemantau aplikasi (aktivitas & error pengguna).
- Fase 6 — Penghalusan.

## Teknologi
- **Frontend:** satu halaman HTML statis (`index.html`) — tanpa proses build.
  Pola sama dengan rempangops.com agar konsisten & mudah dipelihara.
- **Auth & data:** Supabase (proyek `dashboard-kendali`, terpisah dari rempangops.com).
- **Serverless:** folder `/api` (Node.js) di Vercel.
- **Hosting:** Vercel (proyek terpisah, alamat `kendali-dimas.vercel.app`).

## Environment Variables (diatur di Vercel — JANGAN ditulis di kode)
| Nama | Isi | Catatan |
|---|---|---|
| `SUPABASE_URL` | URL proyek Supabase `dashboard-kendali` | Aman (publik) |
| `SUPABASE_ANON_KEY` | Kunci **publishable/anon** Supabase | Aman dilihat publik (memang untuk frontend) |

Kunci **rahasia** (secret/service) layanan akan ditambahkan di fase berikutnya, dan **hanya**
dipakai di sisi serverless (`/api`) — tidak pernah dikirim ke halaman web.

## Struktur file
```
/
├── index.html        Halaman utama (login + dashboard)
├── api/
│   └── config.js     Mengirim URL + publishable key Supabase ke halaman (dari env var)
├── vercel.json       Header keamanan dasar
└── README.md         Dokumen ini
```

## Prinsip keamanan
1. Kunci tidak pernah ditulis di kode — hanya di Environment Variables Vercel (terenkripsi).
2. Hanya kunci publishable/anon yang menyentuh frontend. Kunci rahasia khusus serverless.
3. Akses terkunci (login Supabase Auth). Pendaftaran publik dimatikan.
4. Hak akses sekecil mungkin — pakai kunci read-only di mana memungkinkan.
5. deploy
