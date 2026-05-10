# TikTok Shop Scanner - Cetak Resi & Manajemen Stok

Aplikasi web untuk cetak resi TikTok Shop dengan fitur manajemen stok dan scan barcode keluar barang.

## Fitur

### Admin
- **Dashboard** - Lihat ringkasan total produk, stok, dan scan harian
- **Manajemen Produk** - Tambah, edit, hapus produk (SKU, barcode, harga, stok, berat)
- **Laporan Harian** - Laporan detail scan harian + status stok produk
- **Cetak Resi** - Input data pengiriman dan cetak resi TikTok Shop

### Packing
- **Scan Barang Keluar** - Scan barcode/SKU untuk mengeluarkan barang dari stok
- **Cetak Resi** - Cetak resi pengiriman TikTok Shop

### Sistem
- Login dengan 2 role: Admin & Packing
- Stok otomatis berkurang saat scan keluar barang
- Riwayat scan tercatat lengkap (siapa, kapan, berapa)
- Cetak resi format thermal printer (100mm x 150mm)
- Sound notification saat scan berhasil/gagal
- Responsive design (mobile-friendly)

## Cara Menjalankan

```bash
# Clone repository
git clone <repo-url>
cd scaner

# Jalankan server (tanpa dependency external)
node server.js

# Buka di browser
# http://localhost:3000
```

## Default Login

| Role | Username | Password |
|------|----------|----------|
| Admin | admin | admin123 |
| Packing | packing | packing123 |

## Tech Stack

- **Backend**: Node.js (native HTTP module, tanpa Express)
- **Database**: JSON file-based (folder `data/`)
- **Frontend**: HTML, CSS, vanilla JavaScript
- **Auth**: Session-based (cookie)

## Struktur Folder

```
scaner/
├── server.js          # Main server (routing, API, auth)
├── package.json
├── .gitignore
├── data/              # Database JSON files (auto-generated)
├── public/
│   └── css/
│       └── style.css  # Global stylesheet
└── views/
    ├── login.html
    ├── admin_dashboard.html
    ├── admin_products.html
    ├── admin_reports.html
    ├── packing_scan.html
    └── cetak_resi.html
```

## API Endpoints

| Method | Endpoint | Deskripsi |
|--------|----------|-----------|
| POST | /api/login | Login |
| GET | /api/products | List semua produk |
| POST | /api/products | Tambah produk (admin) |
| PUT | /api/products/:id | Edit produk (admin) |
| DELETE | /api/products/:id | Hapus produk (admin) |
| POST | /api/scan | Scan keluar barang |
| GET | /api/scan-history | Riwayat scan |
| GET | /api/orders | List resi/order |
| POST | /api/orders | Tambah resi |
| DELETE | /api/orders/:id | Hapus resi |
| GET | /api/reports/daily | Laporan harian |
| GET | /api/reports/stock | Laporan stok |

## Alur Kerja

1. **Admin** tambah produk dengan SKU/barcode dan stok awal
2. **Packing** scan barcode saat barang dikemas untuk dikirim
3. Stok otomatis berkurang setiap kali scan berhasil
4. **Packing/Admin** input data pengiriman dan cetak resi
5. **Admin** cek laporan harian untuk monitoring

## License

ISC
