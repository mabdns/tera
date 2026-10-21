# 📜 VerifAkta KUA SIMKAH
> **Aplikasi Web Proofreading & Validasi Silang Buku Akta Nikah (Model N) terhadap Spreadsheet Entry KUA / Kementerian Agama RI**

Aplikasi web modern yang dirancang khusus untuk memverifikasi, mencocokkan silang (*cross-match*), mendeteksi *typo*, dan memvalidasi aturan hukum atas data Buku Kutipan Akta Nikah fisik dengan hasil entri data pada spreadsheet Excel (`.xlsx`, `.xls`, `.csv`).

---

## ✨ Fitur Utama

### 1. Dual-Pane Side-by-Side Proofreader
* **Panel Kiri (Penampil Dokumen Fisik)**:
  * Render visual autentik Buku Kutipan Akta Nikah resmi Model N Kementerian Agama RI lengkap dengan ornamen border hijau Kemenag, cap stempel tinta merah KUA, tanda tangan penghulu, dan nomor seri perforasi.
  * Mendukung **unggah foto/scan asli** per halaman akta.
  * Dilengkapi toolbar interaktif: Zoom in/out, rotasi 90°, mode kontras tinggi (untuk tulisan pensil/tinta pudar), invert mode, dan drag/pan canvas.
  * Pemindai teks terintegrasi (**Client-side OCR** berbasis Tesseract.js).
* **Panel Kanan (Formulir Entry & Evaluator Koreksi)**:
  * Penjajaran data per baris: Nilai di Buku Fisik vs Nilai Hasil Ketik Spreadsheet.
  * **Pendeteksi Typo & Fuzzy Matching**: Menghitung skor kemiripan teks (0 - 100%) dan memberikan visualisasi karakter diff (`diff-del` berwarna merah dicoret, `diff-ins` berwarna hijau digarisbawahi).
  * Tombol **"Samakan"** (1-klik perbaikan per kolom) dan tombol **"Samakan Semua ke Buku"** dengan animasi confetti perayaan.
  * Input langsung yang dapat diedit langsung (*inline editing*).

### 2. Mesin Validasi Otomatis Regulasi Pernikahan & Administrasi Kependudukan
* **Validasi Format NIK 16 Digit**: Memastikan jumlah digit dan hanya angka.
* **Validasi Rumus NIK Dukcapil vs Tanggal Lahir & Gender**:
  * Menguji formula Dukcapil: Pada mempelai wanita, kode tanggal pada NIK harus ditambah 40 (contoh: lahir tanggal 15 $\rightarrow$ kode NIK 55). Sistem otomatis mendeteksi jika terjadi pelanggaran rumus!
* **Pemeriksaan Batas Usia Minimal Nikah (UU No. 16 Tahun 2019)**:
  * Menghitung umur mempelai pria & wanita saat tanggal akad nikah. Jika di bawah 19 tahun, otomatis memunculkan peringatan dispensasi nikah dari Pengadilan Agama.
* **Validasi Konsistensi Wali Nasab**:
  * Jika wali adalah "Ayah Kandung / Nasab", sistem membandingkan kesesuaian nama wali dengan nama ayah kandung (binti) pada mempelai wanita.
* **Validasi Status Pernikahan & Mas Kawin**:
  * Memastikan kesesuaian status pria (Jejaka/Duda) vs wanita (Perawan/Janda) serta kelengkapan status mahar (Tunai/Hutang).

### 3. Manajemen Berkas & Impor / Ekspor
* **Contoh Data KUA Bawaan**: 6 kasus akta nikah nyata dengan berbagai variasi kesalahan (typo nama, digit NIK kurang, rumus +40 wanita keliru, peringatan usia di bawah 19 tahun, typo wali, dan data valid 100%).
* **Unggah Spreadsheet Excel**: Drag-and-drop file `.xlsx`, `.xls`, atau `.csv` dengan pencocokan nama kolom otomatis (*smart column header detection*).
* **Ekspor Excel Terkoreksi**: Mengunduh kembali file `.xlsx` berisi seluruh data yang sudah diperbaiki, lengkap dengan kolom status verifikasi, catatan koreksi, dan tanggal perbaikan.
* **Berita Acara Rekapitulasi Koreksi**: Menghasilkan dokumen resmi Kemenag RI siap cetak (*Print / Save PDF*) ber-KOP resmi KUA Kecamatan dengan tabel rincian kesalahan sebelum dan sesudah koreksi, serta kolom tanda tangan Kepala KUA dan Petugas Verifikator.

---

## 🚀 Cara Menjalankan Aplikasi Secara Lokal

### Prasyarat:
* Node.js versi 18+ sudah terpasang di komputer.

### Menjalankan Server Pengembangan:
```bash
# 1. Masuk ke folder proyek
cd c:\CekAkta

# 2. Jalankan server lokal
npm run dev
```
Buka browser dan akses: **`http://localhost:5173/`**

### Membuat Bundle Produksi:
```bash
npm run build
```

---

## ⌨️ Shortcut Keyboard Cepat
* `[←]` (Panah Kiri): Beralih ke Akta Sebelumnya
* `[→]` (Panah Kanan): Beralih ke Akta Berikutnya
* `[Esc]`: Menutup jendela modal (Unggah / Berita Acara)
* `Scroll Mouse`: Zoom in / Zoom out pada penampil dokumen akta

---

## 🏛️ Format Kolom Excel yang Didukung Otomatis
Sistem otomatis mengenali berbagai sinonim nama kolom:
* Nomor Akta Nikah (`No Akta`, `Nomor Akta`, `No Register`)
* Nomor Porporasi (`No Porporasi`, `No Seri`, `Seri Perforasi`)
* Tanggal Akad (`Tgl Akad`, `Tanggal Akad`, `Tanggal Nikah`)
* Data Suami (`Nama Suami`, `Bin`, `NIK Suami`, `TTL Suami`, `Status Suami`)
* Data Istri (`Nama Istri`, `Binti`, `NIK Istri`, `TTL Istri`, `Status Istri`)
* Data Wali & Mahar (`Nama Wali`, `Hubungan Wali`, `Mas Kawin`, `Status Mahar`)
