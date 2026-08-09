# Draf Bab 4 - Pengujian Delay, Throughput, dan Usability

## Catatan Pengujian

Pengujian teknis dilakukan pada 1 Agustus 2026 terhadap perangkat AirWatch yang berada dalam kondisi aktif. Sebanyak enam pesan MQTT berurutan diamati secara langsung pada backend. Hasil kalibrasi menunjukkan bahwa RTC sensor lebih cepat 9 detik dibandingkan jam server. Oleh karena itu, timestamp sensor dikurangi 9 detik sebelum perhitungan delay dilakukan. `T_cloud` dicatat setelah data berhasil disimpan pada lokasi `current` dan `history` di Firebase. Adapun waktu website merupakan waktu ketika data pertama kali terdeteksi melalui mekanisme polling endpoint yang digunakan website dengan interval 5 detik. Dengan demikian, waktu tersebut menggambarkan latensi pengamatan melalui mekanisme polling, bukan waktu render browser secara presisi. Ukuran data dihitung berdasarkan panjang payload MQTT dalam byte sebelum payload diuraikan oleh backend.

## Hasil Pengujian Delay

Delay merupakan selisih waktu antara data dikirim dan data diterima pada titik pengukuran tertentu. Secara teoritis, delay perangkat ke cloud dan delay total dihitung menggunakan:

`D_cloud = T_cloud - T_sensor` (4.1)

`D_total = T_website - T_sensor` (4.2)

Rata-rata delay dihitung menggunakan:

`D_bar = (sum(D_i)) / n` (4.3)

### Tabel 4.11 Hasil Pengujian Delay

| No. | Waktu sensor | Waktu backend/cloud | Waktu website | Delay cloud | Delay total |
|---:|---:|---:|---:|---:|---:|
| 1 | 19:54:41.000 | 19:54:41.820 | 19:54:45.648 | 820 ms | 4.648 ms |
| 2 | 19:55:42.000 | 19:55:43.326 | 19:55:45.652 | 1.326 ms | 3.652 ms |
| 3 | 19:56:44.000 | 19:56:44.890 | 19:56:45.654 | 890 ms | 1.654 ms |
| 4 | 19:57:45.000 | 19:57:46.466 | 19:57:50.654 | 1.466 ms | 5.654 ms |
| 5 | 19:58:47.000 | 19:58:47.883 | 19:58:50.658 | 883 ms | 3.658 ms |
| 6 | 19:59:48.000 | 19:59:49.351 | 19:59:50.660 | 1.351 ms | 2.660 ms |
| **Rata-rata** |  |  |  | **1.122,7 ms** | **3.654,3 ms** |

Berdasarkan Tabel 4.11, rata-rata delay pengiriman data dari perangkat hingga data diterima dan disimpan pada Firebase adalah 1.122,7 ms. Rata-rata delay total hingga data terdeteksi melalui mekanisme polling website mencapai 3.654,3 ms. Delay cloud terendah tercatat sebesar 820 ms dan tertinggi sebesar 1.466 ms. Pada pengukuran delay total, nilai terendah sebesar 1.654 ms dan nilai tertinggi sebesar 5.654 ms. Variasi delay total terutama dipengaruhi oleh proses polling yang dilakukan setiap 5 detik. Berdasarkan kriteria operasional yang ditetapkan, yaitu delay total tidak melebihi 10 detik, seluruh sampel memenuhi kebutuhan sistem. Data kualitas udara dapat diterima oleh Firebase dan tersedia untuk website dalam waktu yang memadai dibandingkan interval pengiriman sensor yang berkisar 61,507 detik.

## Hasil Pengujian Throughput

Throughput data aplikasi digunakan untuk mengukur jumlah data yang berhasil diterima dalam satuan waktu:

`Throughput = Total data diterima / Durasi pengamatan` (4.4)

Dalam bit per detik:

`Throughput (bps) = (Total byte x 8) / Durasi pengamatan` (4.5)

Setiap pesan memiliki pasangan timestamp lengkap sehingga keenam pesan dapat digunakan sebagai enam sampel delay pada Tabel 4.11. Untuk pengujian throughput, perhitungan membutuhkan selang waktu di antara dua pesan. Oleh karena itu, enam pesan MQTT berurutan membentuk lima interval pengujian, yaitu interval pesan 1-2, 2-3, 3-4, 4-5, dan 5-6. Setiap interval memuat satu pesan baru.

### Tabel 4.12 Hasil Pengujian Throughput

| Pengujian | Durasi | Jumlah pesan | Total data | Throughput |
|---|---:|---:|---:|---:|
| Pengujian 1 | 61,509 detik | 1 | 148 byte | 19,249 bps |
| Pengujian 2 | 61,566 detik | 1 | 148 byte | 19,231 bps |
| Pengujian 3 | 61,571 detik | 1 | 147 byte | 19,100 bps |
| Pengujian 4 | 61,413 detik | 1 | 147 byte | 19,149 bps |
| Pengujian 5 | 61,474 detik | 1 | 147 byte | 19,130 bps |
| **Rata-rata** | **61,507 detik** | **1** | **147,4 byte** | **19,172 bps** |

Berdasarkan lima interval pengujian, rata-rata throughput data aplikasi yang diperoleh sebesar 19,172 bps. Sistem mentransmisikan payload MQTT dengan ukuran rata-rata 147,4 byte pada interval rata-rata 61,507 detik. Seluruh enam pesan yang diamati berhasil diterima backend, disimpan pada Firebase, dan terdeteksi melalui endpoint yang digunakan website. Nilai throughput tersebut tidak menggambarkan kapasitas maksimum jaringan, melainkan laju data aplikasi karena perangkat hanya mengirimkan satu payload berukuran kecil setiap kurang lebih satu menit. Perbedaan throughput antarpengujian dipengaruhi oleh variasi ukuran payload dan interval pengiriman data.

## Hasil Pengujian Usability

Pengujian usability harus melibatkan responden nyata. Skor pada bagian ini tidak boleh diisi berdasarkan pengujian server karena usability mengukur persepsi pengguna. Gunakan kuesioner skala Likert 1-5 yang telah disusun pada Tabel 4.13 dan Tabel 4.14.

Jawaban dapat dimasukkan ke `docs/template-usability.csv`, kemudian direkap otomatis dengan perintah `node scripts/calculate-usability.js docs/template-usability.csv`.

Pemetaan sepuluh pernyataan ke indikator rekapitulasi dapat ditetapkan sebagai berikut:

| Indikator | Nomor pernyataan | Skor maksimum untuk N responden |
|---|---|---:|
| Kemudahan akses | 1 dan 2 | `10 x N` |
| Kemudahan navigasi | 3 | `5 x N` |
| Kejelasan informasi | 4, 5, dan 6 | `15 x N` |
| Kemudahan penggunaan fitur | 7, 8, dan 9 | `15 x N` |
| Manfaat sistem | 10 | `5 x N` |
| **Total** | **1-10** | **50 x N** |

Persentase setiap indikator dihitung menggunakan:

`Persentase = (Skor yang diperoleh / Skor maksimum) x 100%` (4.6)

Interval interpretasi yang dapat ditetapkan sebelum kuesioner disebarkan adalah 0-20% sangat kurang, lebih dari 20-40% kurang, lebih dari 40-60% cukup, lebih dari 60-80% baik, dan lebih dari 80-100% sangat baik.

### Tabel 4.15 Rekapitulasi Hasil Usability

| No. | Indikator | Skor diperoleh | Skor maksimum | Persentase |
|---:|---|---:|---:|---:|
| 1 | Kemudahan akses | `[hasil butir 1-2]` | `10 x N` | `[isi]%` |
| 2 | Kemudahan navigasi | `[hasil butir 3]` | `5 x N` | `[isi]%` |
| 3 | Kejelasan informasi | `[hasil butir 4-6]` | `15 x N` | `[isi]%` |
| 4 | Kemudahan penggunaan fitur | `[hasil butir 7-9]` | `15 x N` | `[isi]%` |
| 5 | Manfaat sistem | `[hasil butir 10]` | `5 x N` | `[isi]%` |
| **Total** |  | **`[jumlah seluruh skor]`** | **`50 x N`** | **`[isi]%`** |

Narasi setelah data responden tersedia:

> Pengujian usability melibatkan [jumlah] responden yang terdiri atas [karakteristik responden]. Berdasarkan hasil perhitungan, sistem memperoleh persentase sebesar [isi]%. Nilai tertinggi terdapat pada indikator [isi], sedangkan nilai terendah terdapat pada indikator [isi]. Berdasarkan interval penilaian yang telah ditetapkan, website AirWatch berada pada kategori [isi].

## Tindakan Sebelum Sidang

1. Pengukuran teknis dapat diulang menggunakan `node scripts/measure-qos.js <nama-file-hasil.json>` untuk menambah jumlah sampel.
2. Sebarkan kuesioner kepada responden, masukkan skor mentah, lalu hitung Tabel 4.15.
