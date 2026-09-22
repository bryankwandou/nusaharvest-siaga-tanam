# NusaHarvest V2: Riset Ide (Audit, Model, Kompetitor, Konsep, Risiko)

Tanggal: 14 September 2026. Status: fase riset. Belum ada kode produksi V2.
Semua angka di bawah punya sumber atau berasal dari script yang bisa dijalankan ulang di `research/data/`.

---

## 0. Kesimpulan satu paragraf

V1 tidak gagal karena koperasi saja. V1 gagal karena tidak ada satu pun uang nyata yang pernah bergerak: tiga program devnet tidak pernah di-initialize, TVL $0, trigger cuaca 40 mm/30 hari menyala di 23 dari 25 tahun (artinya tidak berguna sebagai trigger), dan produk "asuransi + yield pool" itu secara hukum adalah usaha perasuransian tanpa izin OJK, pola yang sama dengan Kitabisa Saling Jaga yang dihentikan SWI tahun 2021. V2 yang realistis bukan "asuransi on-chain untuk petani". V2 yang realistis adalah **alat komitmen dana darurat berbasis trigger iklim**: sponsor (CSR, LAZ/zakat, NGO, pemda, offtaker) mengunci dana sebelum musim tanam, daftar penerima dikunci sebelum bencana, trigger dihitung dari data publik yang bisa diulang siapa pun, dan petani menerima rupiah ke e-wallet lewat nomor HP tanpa wallet crypto, tanpa aplikasi, tanpa koperasi. Solana hanya dipakai di tiga titik yang memang tidak bisa digantikan spreadsheet: dana terkunci sebelum musim, daftar penerima tidak bisa ditambah setelah bencana, dan hasil trigger terbukti dari data yang di-hash.

---

## 1. Audit kritis V1

### 1.1 Teknis
| Temuan | Bukti | Dampak |
|---|---|---|
| Tiga program Anchor ter-deploy di devnet tetapi state PDA tidak pernah di-initialize | pool `HfXQ...wxWgc`, insurance `4Dca...MuBp`, vault `2NZv...3ytM` kosong | Tidak ada satu polis, deposit, atau klaim on-chain. Klaim "on-chain" di landing page tidak terbukti |
| Discriminator instruksi di-hardcode di frontend | `src/utils/solana.ts` `[11,237,241,...]` | Rapuh; satu rename instruksi merusak semua transaksi tanpa error yang jelas |
| 144+ pemakaian `Math.random`, `setTimeout`, "demo", "simulate", data mock | `src/contexts/SimulationContext.tsx`, `dashboard/page.tsx` (`handleSimulateDrought`, ID `DEMO-...`) | Juri membaca ini sebagai demo palsu. Satu klik "simulate drought" membatalkan kredibilitas seluruh produk |
| Backend jatuh ke mode fallback | `/metrics` mengembalikan `{"source":"fallback"}`, `purchase-mvp` HTTP 500 | Endpoint inti mati di produksi |
| Trigger klaim hanya bisa dipanggil admin | `trigger_claim` admin-only di `nusa_harvest_insurance` | "Parametrik otomatis" sebenarnya manual dan terpusat |
| Indeks kekeringan pakai rata-rata tetap 150 mm untuk "Jawa" | `weatherService.ts` baris 67 | Tidak ada klimatologi per lokasi; NTT dan Jawa dinilai dengan angka yang sama |
| Rolling 30 hari dijumlah dari snapshot 3 jam OpenWeatherMap yang disimpan sekali sehari | `cronJobs.ts` + `storeWeatherReading` | Curah hujan 30 hari yang dihitung salah secara metode (1 sampel 3 jam per hari, bukan total harian) |
| Admin auth disimpan di `localStorage` dengan TTL 30 menit | `admin/page.tsx` baris 186-222 | Otorisasi sisi klien, bukan server |

### 1.2 Backtest trigger V1 pada data nyata
Script: `research/data/backtest-triggers.mjs` dan `backtest-calibrated.mjs`. Data: Open-Meteo Historical API (reanalisis ERA5/ERA5-Land), 1991-2025.

| Lokasi | Trigger V1 (<40 mm/30 hari) menyala | Trigger terkalibrasi (hujan 1 Okt-31 Des < persentil 20 baseline 1991-2020) menyala |
|---|---|---|
| Klaten | 23 dari 25 tahun, rata-rata 92 hari/tahun | 5 tahun: 2006, 2009, 2018, 2019, 2023 |
| Grobogan | 23 dari 25 | 6 tahun: 2002, 2004, 2006, 2009, 2019, 2023 |
| Kupang | 25 dari 25, rata-rata 184 hari/tahun | 4 tahun: 2004, 2015, 2019, 2023 |
| Demak | 23 dari 25 | 6 tahun: 2002, 2004, 2006, 2009, 2019, 2023 |

Pembacaan jujur:
- Trigger V1 menyala setiap musim kemarau biasa. Kalau ada uang di pool, pool itu habis di tahun pertama. Ini bukan bug kecil; ini membuat model bisnis V1 mustahil.
- Semua 21 kejadian trigger terkalibrasi jatuh di tahun El Niño atau IOD positif (El Niño 2002-03, 2004-05, 2006-07, 2009-10, 2014-15, 2018-19, 2023-24; IOD positif ekstrem 2019). Itu sinyal bahwa trigger menangkap kejadian iklim yang nyata, bukan noise.
- Kelemahan yang belum ditutup: (a) El Niño sangat kuat 2015 tidak memicu trigger di tiga lokasi Jawa, jadi ada kemungkinan false negative; (b) curah hujan rendah belum dibuktikan sama dengan kerugian panen. Validasi wajib berikutnya: bandingkan tahun trigger dengan data produksi padi per kabupaten dari BPS.
- Banjir Demak Februari 2024: hujan 3 hari maksimum hanya di persentil 99,1 dan penyebab langsungnya tanggul Sungai Wulan jebol (8 Feb 2024), bukan hujan lokal. Trigger banjir berbasis hujan titik tidak akan adil. Banjir harus memakai status darurat resmi atau debit sungai, bukan curah hujan.

### 1.3 Produk dan user flow
- Petani harus punya wallet Solana, memahami USDC, dan melewati "Digital Onboarding" dengan pesan "WALLET DIPERLUKAN". Mayoritas petani gurem tidak akan sampai ke langkah kedua.
- Dua produk dicampur di satu aplikasi: yield pool untuk investor global dan asuransi untuk petani. Keduanya punya pengguna, regulasi, dan risiko yang berbeda. Hasilnya dua produk setengah jadi.
- Koperasi dipakai sebagai peminjam dan penyalur. TaniFund memakai pola perantara serupa dan berakhir dengan TKB90 buruk dan izin dicabut OJK. Goldfinch (a16z) kehilangan sekitar $18 juta dari pinjaman ke perantara di pasar berkembang (Tugende, Stratos, Lend East) dan token turun 99,8%.

### 1.4 Trust dan adopsi
- Keluhan petani terhadap asuransi parametrik di Indonesia sudah terdokumentasi: "curah hujan di angka 9 boleh klaim, di bawah 9 padinya busuk tidak bisa klaim" (Jawa Pos, 25 Mar 2025). V1 tidak punya jawaban untuk basis risk.
- AUTP Jasindo 2024 hanya melindungi 305 ribu ha dari target 1 juta ha, premi sekitar Rp55 miliar, padahal potensi Rp1,8 triliun per tahun. Pasar ini tidak kekurangan produk; pasar ini kekurangan kepercayaan dan distribusi.

### 1.5 Regulasi (masalah yang paling fatal)
- Menjual perlindungan dengan imbalan iuran = usaha perasuransian (UU 40/2014). Kitabisa Saling Jaga dihentikan SWI Mei 2021 karena alasan ini dan baru jalan lagi setelah Kitabisa mengakuisisi perusahaan asuransi (Amanah Githa, 2024).
- Yield pool publik untuk investor ritel = penghimpunan dana tanpa izin.
- Stablecoin bukan alat pembayaran sah menurut BI. IDRX lolos sandbox OJK, tetapi itu tidak menjadikannya alat bayar ke petani.
- Menggalang donasi publik butuh izin PUB (Permensos 8/2021 jo. 8/2024), kecuali zakat melalui lembaga resmi.

---

## 2. Model seamless tanpa koperasi yang realistis di Indonesia

### 2.1 Siapa membayar, siapa menerima, siapa memegang izin
| Peran | Siapa | Kenapa aman secara regulasi |
|---|---|---|
| Pemberi dana | Sponsor berbadan hukum: CSR perusahaan, LAZ/BAZNAS (ZIS nasional 2025 Rp44,7 triliun), NGO, pemda, offtaker (penggilingan, pabrik pakan) | Dana milik sponsor sendiri, bukan penghimpunan publik oleh NusaHarvest. Petani tidak membayar iuran, jadi ini bantuan bersyarat, bukan asuransi |
| Penerima | Petani yang terdaftar sebelum tanggal kunci | Tidak ada premi, tidak ada kontrak asuransi |
| Penyalur rupiah | Payment gateway berizin BI (contoh: Xendit, biaya disbursement tetap Rp2.500/transaksi ke bank dan e-wallet) | Uang sampai sebagai rupiah di DANA/GoPay/OVO/ShopeePay/bank. Tidak ada stablecoin di sisi petani |
| NusaHarvest | Penyedia software: trigger engine, bukti on-chain, WhatsApp onboarding | Tidak memegang dana publik, tidak menjanjikan imbal hasil |

Ini adalah pola yang sudah terbukti di luar chain: GiveDirectly memakai prakiraan Google Flood Hub untuk mengirim uang tunai sebelum banjir (Nigeria 2024: 4.463 orang, banyak dipakai untuk melindungi aset dan membeli benih; Bangladesh 2025). WFP Building Blocks memproses US$555 juta dan menghemat US$3,5 juta biaya bank. UNHCR memakai Stellar untuk US$4,6 juta ke sekitar 2.500 rumah tangga di Ukraina. Indonesia sendiri punya Pooling Fund Bencana (Perpres 75/2021, Rp7,3 triliun dari APBN) yang membutuhkan cara penyaluran yang bisa diaudit.

### 2.2 Kenapa chain dibutuhkan (bagian ini yang akan diuji juri)
Tanpa Solana, produk ini adalah GiveDirectly dengan spreadsheet. Chain hanya layak kalau menyelesaikan tiga masalah kepercayaan yang nyata:
1. **Sponsor tidak bisa mundur setelah bencana.** Dana dikunci di vault program sebelum musim. Kalau trigger menyala, dana keluar sesuai aturan; kalau tidak menyala, dana kembali ke sponsor atau dipindah ke musim berikutnya.
2. **Tidak ada penerima siluman.** Merkle root daftar penerima dikunci sebelum tanggal freeze. Kasus bansos beras PKH yang disidik KPK (kerugian negara Rp200 miliar, 27 saksi dipanggil 7 Sep 2026) menunjukkan titik rawannya adalah daftar dan penyaluran, bukan niat baik sponsor.
3. **Trigger bisa diulang siapa saja.** Program menyimpan hash data sumber, versi aturan, nilai indeks, dan ambang. Siapa pun bisa menjalankan ulang script publik dan mendapat angka yang sama.

Yang tidak disimpan di chain: nomor HP, NIK, nama, koordinat persis. UU PDP 27/2022 membuat data pribadi di ledger permanen menjadi risiko hukum. On-chain hanya menyimpan hash bergaram (salted hash) per penerima.

### 2.3 Flow petani tanpa edukasi berat
1. Petani mengirim "DAFTAR" ke nomor WhatsApp NusaHarvest (atau dibantu penyuluh/ketua kelompok tani lewat link yang sama).
2. Bot meminta tiga hal: bagikan lokasi sawah (fitur share location WhatsApp), nama pemilik e-wallet, nomor e-wallet.
3. Sistem memvalidasi nama pemilik rekening/e-wallet lewat API penyalur (account name validation). Tidak ada upload KTP di MVP. e-KYC Dukcapil (sekitar Rp4.000 per verifikasi melalui agregator) hanya dipakai untuk sponsor yang mewajibkannya.
4. Petani menerima pesan konfirmasi: "Kamu terdaftar di Program Siaga Tanam [nama sponsor], musim Okt-Des 2026. Kalau hujan di wilayahmu jauh di bawah normal, kamu menerima Rp300.000 otomatis. Tidak ada biaya."
5. Kalau trigger menyala, uang masuk ke e-wallet dan petani menerima pesan dengan link bukti. Petani tidak pernah melihat kata "wallet", "token", "Solana", atau "blockchain".

### 2.4 Mengurangi basis risk (masalah yang membunuh WorldCover)
- Trigger dihitung per sel grid 0,1° (sekitar 11 km), bukan per provinsi.
- Jendela trigger mengikuti fase rawan (awal tanam Okt-Des untuk padi tadah hujan), bukan kalender tetap 30 hari.
- Ambang berbasis persentil klimatologi lokal 30 tahun, bukan mm absolut.
- Dua tingkat pembayaran: 50% di persentil 20, 100% di persentil 10. Ini mengurangi efek "tepat di bawah ambang tidak dapat apa-apa".
- Setiap pesan ke petani menjelaskan bahwa ini bantuan berbasis data wilayah, bukan ganti rugi per sawah. Harapan diatur sejak awal.
- Sasaran awal: sawah tadah hujan dan lahan kering jagung. Sawah irigasi teknis (bagian besar dari 7,38 juta ha lahan baku sawah 2024) tidak cocok untuk trigger hujan.

---

## 3. Kompetitor dan pelajaran

Kerumunan pasar untuk ceruk persis (trigger iklim + dana sponsor + bukti on-chain + payout rupiah ke petani tanpa perantara): **sparse**. DefiLlama per 14 Sep 2026 mencatat 31 protokol kategori Insurance, hanya satu di Solana (Amulet V1, TVL $0), dan tidak ada yang menyentuh pertanian. Katalog solana-new tidak terpasang di mesin ini, jadi pencarian katalog tidak dilakukan. Pencarian 6.000+ proyek hackathon Colosseum belum dilakukan karena token Colosseum Copilot belum ada. "Sparse" di sini berarti belum ditemukan, bukan dijamin kosong.

### 3.1 Kompetitor langsung dan substitusi
| Nama | Status | Pendekatan | Pelajaran untuk V2 | Ancaman |
|---|---|---|---|---|
| Jasindo AUTP (Indonesia) | Hidup | Asuransi indemnitas bersubsidi, 305 ribu ha 2024 | Distribusi lewat dinas dan kelompok tani; klaim lambat; petani tidak percaya | Tinggi sebagai substitusi, rendah sebagai pesaing langsung karena bukan parametrik penuh |
| Askrindo + Tugu parametrik (IFG) | Pilot, runner-up Inclusive Insurance Challenge Fund Okt 2025 | Asuransi berbasis indeks | BUMN sudah bergerak di parametrik; V2 jangan jadi perusahaan asuransi, jadilah infrastruktur bukti dan penyaluran yang bisa dipakai mereka | Sedang |
| Igloo Insure | Hidup | Weather index insurance embedded | Butuh mitra asuransi berizin | Sedang |
| Pula (Kenya) | Hidup, skala jutaan petani | B2B2C, asuransi dibundel dengan input dan kredit | Petani jarang membeli asuransi sendiri; distribusi datang dari yang sudah punya relasi uang | Rendah (bukan Indonesia) |
| OKO (Mali, Pantai Gading) | Hidup | Langsung ke petani via mobile money | Direct-to-farmer lewat HP bisa jalan kalau payout cepat dan bahasa lokal | Rendah |
| WorldCover (Ghana) | Mati | Parametrik satelit langsung ke petani | Basis risk: petani berhenti membayar saat data satelit bertentangan dengan kondisi sawah | Pelajaran utama |
| Lemonade Crypto Climate Coalition (Kenya, Avalanche, Etherisc, Chainlink) | Tidak ada kabar setelah musim 2022-23 | Parametrik on-chain, sekitar 7.000 petani | Blockchain tidak menyelesaikan distribusi dan keberlanjutan pendanaan | Pelajaran |
| Etherisc | Hidup, kecil | Protokol asuransi terdesentralisasi | Infrastruktur tanpa demand lokal tidak tumbuh | Rendah |
| Arbol | Hidup, GWP $250 juta 2023, Series B $60 juta | Parametrik B2B, dClimate + Chainlink | Uang besar ada di B2B dan reasuransi, bukan ritel petani | Rendah di ceruk ini |
| Neptune Mutual | TVL $0 | Parametrik DeFi | Asuransi DeFi tanpa aset nyata mati | Tidak ada |
| OnRe (Solana) | Hidup, TVL sekitar $299 juta | Reasuransi terkolateral berizin Bermuda | Sisi modal di Solana sudah ada; kelak bisa menjadi pembeli risiko, bukan pesaing | Rendah, potensi mitra |
| GiveDirectly + Google Flood Hub | Hidup | Uang tunai antisipatif sebelum banjir | Substitusi terdekat. Tidak on-chain. V2 menang hanya kalau bukti publik berguna bagi sponsor Indonesia | Tinggi sebagai substitusi |
| WFP Building Blocks / UNHCR Stellar Aid Assist | Hidup | Penyaluran bantuan berbasis blockchain | Blockchain di bantuan berhasil saat dipakai untuk rekonsiliasi dan biaya, bukan untuk pengguna akhir | Sedang (bisa masuk Indonesia) |
| TaniFund (Indonesia) | Mati, izin dicabut OJK | P2P lending ke petani via perantara | Kredit ke petani lewat perantara menghasilkan gagal bayar tinggi | Pelajaran |
| Goldfinch | Platform kredit ditutup | Kredit tanpa jaminan on-chain ke pasar berkembang | Yield pool untuk investor adalah jebakan; jangan ulangi | Pelajaran |
| LandX (Ethereum) | TVL sekitar $1,6 juta | Pembiayaan berbasis bagi hasil panen | Presale panen butuh penegakan kontrak offline | Rendah |
| Kitabisa Saling Jaga | Dihentikan 2021, hidup lagi setelah akuisisi asuransi | Patungan perlindungan | Iuran + janji bantuan = asuransi di mata OJK | Pelajaran regulasi |
| Tengkulak dan sistem ijon | Dominan | Uang cepat saat butuh, dibayar dengan harga panen murah | Pesaing sebenarnya adalah kecepatan. Kalau uang V2 datang setelah 3 bulan, tengkulak menang | Tinggi |
| Bansos PKH/BPNT dan Pooling Fund Bencana | Hidup | Bantuan pemerintah | Skala jauh lebih besar, tetapi lambat dan rawan kebocoran | Substitusi |

### 3.2 Lima kandidat model yang dievaluasi
| Kandidat | Skor kelayakan (0-100) | Alasan |
|---|---|---|
| (1) Asuransi parametrik langsung ke petani via WhatsApp | 34 | Butuh izin asuransi atau mitra asuransi; petani harus membayar; basis risk merusak retensi |
| (2) Pool trigger desa didanai sponsor, payout rupiah ke nomor HP, bukti di Solana | **78** | Petani tidak membayar; sponsor berbadan hukum sudah punya dana dan butuh akuntabilitas; chain punya peran jelas |
| (3) Perlindungan bersyarat didanai diaspora untuk sawah keluarga | 52 | Remitansi besar, tetapi volume per pengirim kecil dan tetap menyerupai asuransi |
| (4) Escrow presale panen pengganti ijon | 41 | Masalah nyata, tetapi gagal bayar dan penegakan offline sama dengan TaniFund |
| (5) Paspor lahan dan panen | 29 | Tidak ada pembeli yang membayar; data tanpa uang tidak menarik petani |

Skor ini adalah penilaian, bukan pengukuran. Model (2) dipilih. Model (3) bisa menjadi fitur sponsor ritel setelah izin PUB atau kerja sama dengan LAZ berizin.

---

## 4. Konsep produk V2

**NusaHarvest: Siaga Tanam.** Dana darurat iklim yang terkunci sebelum musim dan cair sendiri ke petani saat data menunjukkan hujan gagal.

Perbedaan 180° dari V1:
| V1 | V2 |
|---|---|
| Investor global mencari yield | Sponsor lokal berbadan hukum mencari penyaluran yang bisa diaudit |
| Petani membeli polis dengan wallet | Petani tidak membayar, tidak punya wallet, mendaftar lewat WhatsApp |
| Koperasi sebagai peminjam dan penyalur | Tidak ada perantara uang; penyuluh hanya membantu mendaftar |
| USDC ke petani | Rupiah ke e-wallet atau bank |
| Trigger mm absolut, admin memicu klaim | Trigger persentil lokal, siapa pun bisa memanggil settle setelah jendela tutup |
| Tiga program Anchor, tidak pernah di-initialize | Satu program Pinocchio kecil, binary maksimum 13,5 KB agar deploy mainnet <= 0,1 SOL |
| Dashboard penuh angka simulasi | Halaman bukti publik per kampanye, tanpa data simulasi |

Pengguna dan nilai:
- **Sponsor**: membuat kampanye dalam 10 menit, mengunci dana, mendapat laporan bukti yang bisa dilampirkan ke laporan CSR/ZIS.
- **Petani**: satu percakapan WhatsApp, uang datang tanpa klaim.
- **Publik, auditor, media**: halaman bukti yang menunjukkan dana terkunci, jumlah penerima, hash data, hasil trigger, dan tanda terima penyaluran.

Ekonomi contoh (asumsi, harus divalidasi dengan sponsor):
- Nilai bantuan Rp300.000 per petani per kejadian. Frekuensi trigger historis sekitar 4-6 kali per 25 tahun (16-24%).
- Biaya harapan per petani per tahun: sekitar Rp60.000 + Rp2.500 biaya disbursement + biaya WhatsApp. Bandingkan dengan premi AUTP Rp180.000/ha/musim.
- Pendapatan NusaHarvest: biaya platform per kampanye (misal 3-5% dari dana yang dikunci), tidak dari bunga atau yield.

---

## 5. Risiko terbesar dan cara membuktikan "bisa jalan"

| # | Risiko | Kenapa bisa membunuh produk | Mitigasi | Bukti yang harus ada sebelum submit |
|---|---|---|---|---|
| 1 | Tidak ada sponsor nyata | Tanpa dana, semua ini demo | Mulai dengan dana tim sendiri yang diungkapkan terang (misal 20 petani x Rp100.000) dan satu surat minat dari LAZ/CSR/NGO | Kampanye mainnet dengan dana nyata, tanda terima disbursement nyata, surat minat bertanda tangan |
| 2 | Basis risk | Petani kecewa, sponsor malu | Persentil lokal, dua tingkat, sasaran tadah hujan, pesan ekspektasi | Backtest 25 tahun di 4 lokasi (sudah), ditambah validasi terhadap produksi BPS per kabupaten (belum) |
| 3 | Dianggap asuransi tanpa izin | Dihentikan SWI seperti Saling Jaga | Tidak ada iuran petani, tidak ada janji ganti rugi, sponsor memberi bantuan bersyarat, konsultasi hukum tertulis | Memo hukum singkat dan copy yang tidak memakai kata "asuransi", "polis", "premi", "klaim" |
| 4 | Payment gateway butuh badan hukum (PT) | Tanpa PT tidak bisa disbursement otomatis | Fase hackathon: disbursement lewat akun bisnis sponsor atau mitra, tanda terima diunggah sebagai hash; fase pasca: PT | Tanda terima nyata, hash tanda terima di chain |
| 5 | Oracle tunggal | Satu kunci bisa memalsukan trigger | Data sumber publik dan di-hash; masa sanggah 48 jam; auditor yang ditunjuk sponsor bisa membekukan; script reproduksi publik | Satu kejadian settle yang direproduksi pihak lain |
| 6 | Data pribadi di ledger | UU PDP | Hanya salted hash di chain; data asli terenkripsi di database, dihapus setelah retensi | Skema data dan kebijakan retensi tertulis |
| 7 | Tidak ada kekeringan selama periode hackathon | Trigger tidak menyala saat demo | Tampilkan kampanye nyata yang sedang berjalan (belum menyala) plus replay settle terhadap data historis 2023 di jaringan terpisah dengan label yang jelas. Dilarang menampilkan simulasi sebagai kejadian nyata | Replay yang ditandai "historical replay" dan hasilnya cocok dengan backtest |
| 8 | Adopsi WhatsApp oleh petani lanjut usia | Pendaftaran macet | Mode dibantu: penyuluh atau anak petani mendaftarkan lewat link, petani hanya membalas "YA" | Uji dengan minimal 10 petani nyata, catat waktu daftar |
| 9 | Tanggal hackathon | Memori proyek menyebut Colosseum Fall 28 Sep - 2 Nov 2026; halaman colosseum.com hari ini menampilkan Crypto World's Fair 14 Sep - 12 Okt 2026, dinilai hanya dari pekerjaan selama periode lomba, dengan kewajiban pengungkapan pekerjaan sebelumnya | Salah target berarti salah deadline | Konfirmasi hackathon yang dituju hari ini; ungkapkan V1 sebagai pekerjaan sebelumnya |

Definisi "terbukti jalan" yang dipakai tim (bukan klaim, tapi daftar cek):
1. Program ter-deploy di mainnet, alamat dan hash build terverifikasi.
2. Minimal satu kampanye nyata dengan dana nyata terkunci.
3. Minimal 10 petani nyata terdaftar lewat WhatsApp, roster root terkunci di chain.
4. Satu settle nyata (menyala atau tidak menyala) yang bisa direproduksi oleh orang di luar tim dari script publik.
5. Minimal satu disbursement rupiah nyata dengan tanda terima yang hash-nya ada di chain.
6. Nol pemakaian data mock di build produksi (dicek otomatis di CI).

---

## 6. Sumber
- Backtest: `research/data/backtest-summary.json`, `backtest-calibrated.json`, `backtest-*.csv` (Open-Meteo Historical Weather API, ERA5/ERA5-Land)
- [Jawa Pos: Asuransi pertanian potensial Rp1,8 triliun](https://www.jawapos.com/bisnis/015807495/asuransi-pertanian-potensial-raup-rp-18-triliun-tapi-masih-terkendala-edukasi-petani)
- [Sindonews: Askrindo parametrik](https://ekbis.sindonews.com/read/1636037/34/agritech-masuk-sawah-inklusi-asuransi-pertanian-makin-merata-1761221404)
- [Detik: SWI hentikan Saling Jaga](https://finance.detik.com/fintech/d-5560588/ini-alasan-ojk-setop-program-saling-jaga-kitabisa-com), [CNBC: Kitabisa akuisisi Amanah Githa](https://www.cnbcindonesia.com/market/20240130160456-17-510213/kitabisa-akuisisi-asuransi-amanah-githa-program-salingjaga-jalan-lagi)
- [Permensos 8/2021 PUB](https://peraturan.bpk.go.id/Details/217212/permensos-no-8-tahun-2021)
- [GiveDirectly: flood forecast AI](https://www.givedirectly.org/flood-forecast-ai), [Rest of World: Flood Hub Bangladesh](https://restofworld.org/2025/google-flood-hub-cash-aid/)
- [WFP Building Blocks](https://www.wfp.org/building-blocks), [Stellar: UNHCR](https://stellar.org/case-studies/unhcr)
- [Kemenkeu: Pooling Fund Bencana](https://mediakeuangan.kemenkeu.go.id/article/show/pooling-fund-bencana-inovasi-strategis-dalam-pembiayaan-risiko-bencana-di-indonesia)
- [DL News: Goldfinch defaults](https://www.dlnews.com/articles/defi/goldfinch-borrower-lend-east-defaults-says-warbler-labs/), [Protos: Goldfinch 99,8%](https://protos.com/goldfinch-africa-lending-dream-ends-in-defaults-and-99-8-token-crash/)
- [Lemonade Crypto Climate Coalition 7.000 petani](https://www.businesswire.com/news/home/20230328005342/en/Nearly-7000-Kenyan-Farmers-Protected-by-the-Lemonade-Crypto-Climate-Coalition)
- [Arbol Series B](https://www.prnewswire.com/news-releases/arbol-raises-60-million-in-series-b-funding-to-scale-parametric-insurance-responding-to-increasing-climate-risk-302131746.html), [OnRe DefiLlama](https://defillama.com/protocol/onre)
- [Antara: KPK bansos beras](https://www.antaranews.com/berita/5729580/kpk-panggil-mantan-kadinsos-jawa-timur-dan-26-saksi-kasus-bansos-beras)
- [BAZNAS LPZN 2025](https://baznas.go.id/assets/images/szn/LPZN-Tahun-2025.pdf)
- [Xendit biaya disbursement](https://help.xendit.co/hc/en-us/articles/360027727432-Do-I-get-charged-for-a-bank-transfer-fee-for-Disbursement)
- [UU PDP 27/2022](https://peraturan.bpk.go.id/Details/229798/uu-no-27-tahun-2022)
- [ATR/BPN: Lahan baku sawah 2024](https://djpa.atrbpn.go.id/lahan-baku-sawah)
- [Detik: Tanggul Sungai Wulan jebol](https://www.detik.com/jateng/berita/d-7246791/tanggul-sungai-wulan-jebol-lagi-pantura-demak-lumpuh-warga-ngungsi)
- [GGWeather ONI](https://ggweather.com/enso/oni.htm), [MDPI: IOD 2019 dan Indonesia](https://www.mdpi.com/2071-1050/14/22/15155)
- [GSMaP/IMERG latensi](https://www.sciencedirect.com/science/article/pii/S0022169425008522)
- [Colosseum Crypto World's Fair](https://colosseum.com/worldsfair)
