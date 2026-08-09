# Panduan Lampiran Skripsi AirWatch

## Urutan Lampiran yang Disarankan

1. Lampiran A - Instrumen Kuesioner Usability
2. Lampiran B - Rekapitulasi Hasil Usability
3. Lampiran C - Data Mentah Pengujian Delay
4. Lampiran D - Data Mentah Pengujian Throughput
5. Lampiran E - Lembar Pengujian Black-Box dan Kontrol Akses
6. Lampiran F - Bukti Sinkronisasi Firebase, Dashboard, dan CSV
7. Lampiran G - Potongan Kode Program Inti
8. Lampiran H - Dokumentasi Implementasi Sistem

## Dokumen yang Sudah Tersedia

- Instrumen sepuluh pernyataan usability dan skala Likert.
- Rekap agregat usability: 20 responden, skor 974 dari 1.000, atau 97,4%.
- Data mentah enam pesan untuk pengujian delay.
- Data mentah enam pesan yang membentuk lima interval throughput.
- Hasil pengujian autentikasi, dashboard, administrator, dan kontrol akses pada Bab IV.
- Data pembanding Firebase, dashboard, dan CSV.
- Kode backend, API, autentikasi, polling website, dan pengukuran QoS.

## Dokumen yang Masih Harus Dilengkapi

1. Ekspor jawaban individual 20 responden dari Google Forms atau media kuesioner asli. Total agregat tidak cukup untuk merekonstruksi jawaban Q1-Q10 setiap responden secara sah.
2. Tangkapan layar atau PDF ringkasan Google Forms yang menunjukkan jumlah responden dan distribusi jawaban.
3. Tangkapan layar bukti skenario black-box, terutama login gagal, pembatasan halaman admin, pengunduhan CSV, edit data, dan hapus data.
4. Tangkapan layar Firebase dan dashboard pada timestamp yang sama untuk mendukung pengujian konsistensi data.
5. Foto perangkat, pemasangan alat, dan lokasi pengujian apabila memang tersedia dan memperoleh izin untuk dipublikasikan.
6. Lembar persetujuan, surat izin penelitian, atau dokumentasi administrasi lain apabila diwajibkan oleh pedoman kampus.

## Pemeriksaan Konsistensi Sebelum Digabungkan

- Kode aktual mengenal role `guest`, `user`, dan `admin`. Naskah pada Tabel 4.10 masih menyebut viewer, operator, dan super admin. Gunakan nama role yang benar-benar diterapkan dan diuji.
- Website aktif menggunakan lokasi PT Sembada Coal. Beberapa bagian Bab I dan Bab III masih menyebut PT Karya Cipta Nusantara. Tetapkan satu lokasi penelitian dan samakan seluruh naskah, gambar, serta lampiran.
- Jangan melampirkan `.env`, token Telegram, password MQTT, service account Firebase, cookie, atau kredensial akun pengujian.
- Daftar Lampiran pada bagian awal skripsi harus diperbarui setelah nomor halaman final diketahui.

## Catatan Penempatan

Dokumen `LAMPIRAN_SKRIPSI_AIRWATCH.docx` dibuat sebagai dokumen terpisah agar naskah asli tidak rusak. Setelah data yang belum tersedia dilengkapi, bagian tersebut dapat digabungkan setelah halaman `LAMPIRAN` pada naskah utama dan nomor halaman dapat diperbarui sesuai pedoman kampus.
