# NusaHarvest V2: Build Plan dan Megaprompt

Prasyarat membaca: `01-RISET-V2.md` (kenapa) dan `02-FLOW-DAN-SKEMA-FINAL.md` (apa). Dokumen ini adalah bagaimana.

---

## A. Keputusan yang dikunci sebelum menulis kode

| Keputusan | Pilihan | Alasan |
|---|---|---|
| Repo | Repo GitHub publik baru `nusaharvest`, bukan branch dari V1 | V1 penuh data mock; aturan hackathon menilai pekerjaan selama periode lomba dan mewajibkan pengungkapan pekerjaan sebelumnya |
| Program | Satu program Pinocchio, 6 instruksi, `no_std`, tanpa allocator | Binary kecil = deploy <= 0,1 SOL |
| Batas binary | 13.500 byte, dicek di CI, build gagal jika lewat | Lihat anggaran biaya di dokumen 02 bagian 5 |
| Web + API | Next.js App Router + TypeScript strict di satu project Vercel | Satu deploy, satu domain untuk landing, konsol, halaman bukti, webhook |
| Database | Postgres terkelola (Neon atau Supabase) | Merkle node, snapshot iklim, PII terenkripsi |
| Job terjadwal | GitHub Actions `schedule` memanggil endpoint cron bertanda tangan | Cron Vercel Hobby dibatasi sekali sehari; roster lock butuh lebih sering |
| Klien Solana | `@solana/kit` + encoder TypeScript manual yang diuji byte-per-byte terhadap Rust | Pinocchio tidak menghasilkan IDL Anchor |
| WhatsApp | Meta WhatsApp Cloud API | Kanal yang sudah dipakai petani |
| Rupiah | Payment gateway berizin BI saat sudah ada badan hukum. Selama hackathon: disbursement manual dari akun sponsor/tim, tanda terima di-hash, diberi label "manual disbursement" | Jujur terhadap kondisi legal saat ini |
| Bahasa UI | Inggris default, Indonesia penuh; semua string lewat file pesan | Syarat penilaian multibahasa dan bahasa Inggris |
| Mint mainnet | USDC untuk mode ESCROW. Stablecoin rupiah hanya setelah alamat mint diverifikasi dari sumber resmi penerbit | Jangan menebak alamat mint |

---

## B. Rencana kerja 4 minggu

Konfirmasi dulu hackathon target hari ini. Halaman colosseum.com menampilkan Crypto World's Fair 14 Sep - 12 Okt 2026; memori proyek menyebut Colosseum Fall 28 Sep - 2 Nov 2026. Jadwal di bawah memakai minggu relatif.

### Minggu 1: program dan bukti biaya
1. Scaffold workspace: `program/` (Rust), `web/` (Next.js), `scripts/` (data iklim, merkle, deploy), `docs/`.
2. Tulis program sesuai tabel instruksi dokumen 02 bagian 3.2.
3. Uji unit dan integrasi dengan Mollusk atau LiteSVM: setiap instruksi, setiap cabang error, setiap batas waktu, overflow, owner/mint palsu, PDA palsu, penanda tangan hilang, dispute ganda, release ganda.
4. Gate ukuran binary di CI.
5. Deploy devnet dengan `--max-len` tepat. Catat biaya aktual devnet sebagai bukti rumus.
6. Encoder TypeScript + uji kesetaraan byte dengan fixture yang dihasilkan Rust.

Keluaran minggu 1: program devnet, laporan ukuran binary, laporan biaya, 100% instruksi teruji.

### Minggu 2: data iklim, merkle, WhatsApp
1. `scripts/climate`: ambil data harian per sel grid dari dua sumber, klimatologi 1991-2020, persentil 10/20 per jendela, JSON kanonik + sha256. Port dari `research/data/backtest-calibrated.mjs`.
2. Endpoint `/api/campaigns/quote` yang mengembalikan ambang + backtest 25 tahun.
3. Merkle roster dan receipt sesuai rumus dokumen 02 bagian 2.4, dengan vektor uji tetap.
4. Bot WhatsApp: alur dokumen 02 bagian 2.3 lengkap, termasuk semua cabang gagal.
5. Enkripsi PII, HMAC lookup, rate limit publik.

Keluaran minggu 2: 10 petani nyata terdaftar lewat nomor uji (dengan izin mereka), roster lock di devnet.

### Minggu 3: web, mainnet, kampanye nyata
1. Landing page, konsol sponsor, halaman bukti publik, halaman cek pendaftaran. Semua data dari RPC dan API nyata.
2. Deploy program ke mainnet (langkah di bagian D).
3. Buat satu kampanye mainnet nyata (mode ESCROW, dana kecil milik tim atau sponsor, diungkapkan terang) untuk jendela Okt-Des 2026 di satu kabupaten tadah hujan.
4. LockRoster mainnet sebelum freeze_ts dengan petani nyata.
5. Replay historis musim Okt-Des 2023 di devnet dengan label "Historical replay", sampai Release dan PostReceipts.

### Minggu 4: pengerasan dan materi submit
1. Audit mandiri: checklist keamanan bagian E, fuzz data instruksi, uji ulang semua cabang.
2. Lighthouse, aksesibilitas, reduced motion, mobile 360 px.
3. Video demo 3 menit: masalah, petani mendaftar di WhatsApp, kampanye mainnet di explorer, replay settle dan reproduksi hash di browser, biaya deploy nyata.
4. README bahasa Inggris, pengungkapan pekerjaan V1, dokumen hukum ringkas, pitch deck.
5. Pemindaian copy: tanpa emoji, tanpa kata terlarang produk, tanpa kata-kata khas AI.

---

## C. Struktur repo target

```
nusaharvest/
  program/
    Cargo.toml
    src/lib.rs            entrypoint + dispatch tag
    src/state.rs          layout Campaign 368 byte, akses offset
    src/ix/create.rs
    src/ix/lock_roster.rs
    src/ix/settle.rs
    src/ix/dispute.rs
    src/ix/release.rs
    src/ix/post_receipts.rs
    src/error.rs
    tests/                Mollusk/LiteSVM
  web/
    app/[locale]/(marketing)/page.tsx
    app/[locale]/sponsor/...
    app/[locale]/c/[campaign]/page.tsx     halaman bukti
    app/[locale]/check/page.tsx            cek pendaftaran
    app/api/...                            route di dokumen 02 bagian 4.2
    lib/chain/encode.ts                    encoder instruksi + decoder akun
    lib/merkle.ts
    lib/climate.ts
    lib/crypto.ts                          AES-GCM, HMAC
    lib/wa.ts
    messages/en.json, messages/id.json
    db/schema.sql
  scripts/
    climate/fetch.mjs, climatology.mjs, canonical.mjs
    deploy/size-gate.sh, deploy-mainnet.sh
    fixtures/                              vektor uji Rust <-> TS
  .github/workflows/ci.yml, cron.yml
  docs/ARCHITECTURE.md, SECURITY.md, COSTS.md, PRIOR_WORK.md, LEGAL.md
```

---

## D. Deploy mainnet hemat (0,1 SOL)

Bagian ini dijalankan manusia, bukan agen. Mengisi saldo wallet dan menandatangani deploy mainnet adalah keputusan pemilik.

```bash
cargo build-sbf --manifest-path program/Cargo.toml
```

```bash
bash scripts/deploy/size-gate.sh target/deploy/nusaharvest.so 13500
```

```bash
solana rent 13545
```

```bash
solana program deploy target/deploy/nusaharvest.so --program-id program-keypair.json --max-len 13500 --url mainnet-beta --keypair deployer.json --with-compute-unit-price 50
```

```bash
solana program show <PROGRAM_ID> --url mainnet-beta
```

Aturan:
- `--max-len` diisi ukuran binary aktual (dibulatkan ke atas sedikit), bukan dibiarkan default.
- Pakai RPC yang stabil agar transaksi write buffer tidak banyak gagal.
- Kalau terputus: lanjutkan dengan `--buffer`, atau `solana program close <BUFFER>` untuk menarik rent. Jangan deploy ulang dari nol dengan buffer lama masih terbuka.
- Upgrade authority dipindah ke keypair dingin terpisah setelah deploy. `--final` hanya setelah audit, karena program final tidak bisa diperbaiki.
- Catat saldo sebelum dan sesudah di `docs/COSTS.md` sebagai bukti.

---

## E. Checklist keamanan program

1. Setiap akun yang ditulis dicek owner = program atau token program sesuai peran.
2. PDA campaign dan vault diturunkan ulang dan dibandingkan, bump disimpan saat create.
3. Tag akun dicek sebelum membaca layout.
4. Semua perkalian jumlah memakai `checked_mul` dan `checked_add`.
5. `sponsor_token` dan `disburser_token`: mint = campaign.mint, owner = campaign.sponsor / campaign.disburser.
6. Release idempoten: status berubah sebelum atau dalam instruksi yang sama dengan transfer; release kedua gagal `WrongStatus`.
7. Waktu dari sysvar Clock, bukan dari data instruksi.
8. Tidak ada instruksi yang bisa mengubah operator, auditor, disburser, ambang, atau jumlah setelah create.
9. Operator key di server hanya bisa LockRoster, Settle, PostReceipts; tidak bisa memindahkan dana ke alamat bebas. Disburser sebaiknya milik sponsor atau mitra, bukan kunci server yang sama.
10. Panjang data instruksi dicek persis per tag.

---

## F. Megaprompt

Salin seluruh blok di bawah ke agen build. Tulis dalam bahasa Inggris karena kode, UI default, dan materi submit berbahasa Inggris.

````text
You are building NusaHarvest V2 from an empty repository. Read these three files first and treat them as the specification:
research/01-RISET-V2.md, research/02-FLOW-DAN-SKEMA-FINAL.md, research/03-BUILD-PLAN-DAN-MEGAPROMPT.md.
If the specification and your instinct disagree, follow the specification and write the disagreement into docs/OPEN_QUESTIONS.md.

PRODUCT IN ONE SENTENCE
NusaHarvest lets a sponsor lock climate relief money before the planting season; enrolled smallholder farmers receive rupiah in their e-wallet automatically when public rainfall data shows the season failed, and anyone can verify the funds, the recipient list, the trigger, and the receipts on Solana.

HARD CONSTRAINTS
1. Farmers never sign transactions, never hold tokens, never see the words wallet, token, blockchain, Solana, insurance, policy, premium, claim, yield, or investment. Farmer interaction is WhatsApp only.
2. No personal data on chain. Only salted hashes and merkle roots.
3. Zero mock, simulated, random, or placeholder data in production code paths. CI must fail if Math.random, faker, "mock", "dummy", "lorem", "simulate", or "demo data" appears under web/app or web/lib outside test folders. A historical replay is allowed only on devnet, only with a visible "Historical replay" label, and only using real archived climate data.
4. One on-chain program written with the pinocchio crate. No Anchor, no Borsh, no std, no heap allocator. Pin exact crate versions, then read docs.rs for those exact versions before writing any code; do not rely on remembered API names.
5. Release binary target/deploy/nusaharvest.so must be at most 13,500 bytes. Add scripts/deploy/size-gate.sh and run it in CI; the build fails above the limit. Report the size in every PR description.
6. Cargo release profile: opt-level "z", lto "fat", codegen-units 1, panic "abort", strip true, overflow-checks true. Compare the size against opt-level "s" and keep the smaller one; record both numbers in docs/COSTS.md.
7. No string logging in the release build. Errors are numeric custom codes 1..12 exactly as specified.
8. UI default language English with complete Indonesian translation. Every user-visible string comes from messages/en.json and messages/id.json. A CI check fails on missing keys.
9. No emoji anywhere in UI, docs, commit messages, or submission text.
10. Do not deploy to mainnet, fund wallets, or send WhatsApp messages to real numbers yourself. Prepare scripts and stop for the human.

ON-CHAIN PROGRAM
Implement exactly the account layout in 02 section 3.1 (Campaign, 368 bytes, little-endian, explicit offsets, reserved bytes zero) and the six instructions in 02 section 3.2 with the listed signers, account order, data layout, and rules:
0 CreateCampaign, 1 LockRoster, 2 Settle, 3 Dispute, 4 Release, 5 PostReceipts.
Constants: DISPUTE_SECS = 172800, OPERATOR_TIMEOUT_SECS = 2592000, RULE_VERSION = 1.
Create the campaign PDA with seeds ["camp", sponsor, campaign_id_le8] and the vault token account PDA with seeds ["vault", campaign] through CPI to the system program and token program, signing with PDA seeds.
Release moves the payout to the disburser token account, the remainder to the sponsor token account, closes the vault, and returns vault rent to the sponsor, in one instruction. PLEDGE campaigns move no tokens.
Read time only from the Clock sysvar. Use checked arithmetic everywhere. Validate owner, mint, PDA, tag, status, signer, and exact instruction data length on every path.
Tests (Mollusk or LiteSVM): happy path for FULL, HALF, NONE, operator timeout refund, dispute then co-signed resettle, PLEDGE mode; and at least one failing test per error code, plus fake mint, fake owner, fake PDA, double release, release during dispute window, lock roster after freeze, settle before window end, underfunded lock roster.
Generate byte fixtures from Rust tests into scripts/fixtures and assert the TypeScript encoder produces identical bytes.

OFF-CHAIN
Next.js App Router, TypeScript strict, deployed on Vercel. Postgres schema exactly as 02 section 4.1. Routes exactly as 02 section 4.2.
Climate pipeline: port research/data/backtest-calibrated.mjs into scripts/climate and web/lib/climate.ts. Primary source Open-Meteo historical API; add a second independent source for the same grid cell. Compute 1991-2020 climatology percentiles for the campaign window, thr_full = 10th percentile, thr_half = 20th percentile, stored as millimetres times 10. Canonical JSON: sorted keys, UTF-8, no whitespace, includes source URLs, date range, daily series, script version, git commit. data_hash = sha256 of those bytes. If the two sources differ by more than 25 percent over the window, mark REVIEW and do not auto-settle.
Merkle: leaf and receipt formulas exactly as 02 section 2.4, sorted-pair sha256 nodes, fixed test vectors committed to the repo, verification runs in the browser against the root read directly from RPC.
WhatsApp bot: implement every branch in 02 section 2.3, including closed campaign, outside area, duplicate phone, duplicate payout account, duplicate location within 20 metres, name confirmation, and withdrawal. Templates as in 02 section 4.3, both languages.
PII: AES-256-GCM with a server key, HMAC-SHA256 lookup column, retention delete job 12 months after RECEIPTED.
Jobs: GitHub Actions schedule calling /api/cron/* with an HMAC header. Climate daily, roster every 6 hours plus one hour before freeze, settle after window end plus 7 days, payout batches of 100 with idempotency key = leaf.
Payout adapter interface with two implementations: gateway (for a licensed payment gateway, used when the business entity exists) and manual (an operator uploads a transfer receipt; the system stores sha256 of the gateway reference and marks it "manual disbursement" on the proof page). Never show manual receipts as automatic.

WEB EXPERIENCE
Pages: landing, sponsor console (create campaign with quote and 25-year backtest chart for the chosen grid cell, sign CreateCampaign with a connected wallet or create a PLEDGE campaign), public proof page per campaign, enrollment check page, cost page showing real deploy cost with the transaction signatures.
Proof page reads the Campaign account from RPC, shows status timeline, locked funds (or the label "Funds not locked on-chain" for PLEDGE), units, freeze and window dates, thresholds, observed value, a Reproduce button that downloads the canonical JSON and recomputes sha256 in the browser, and roster/receipt inclusion checks.
Design quality bar: distinctive, calm, credible for a sponsor and legible for a farmer family member on a 360 px phone. Motion is intentional: page and section entrances, number count-ups on real values, state timeline transitions, map and chart reveals, button and focus feedback. Target at least 160 distinct animated interactions across the site, every one respecting prefers-reduced-motion, none blocking input, Lighthouse performance and accessibility at least 90 on mobile, no layout shift from animation.
Copy: plain, specific, human. No hype adjectives, no emoji, no filler phrases. Explain the trigger as area rainfall assistance, not compensation for an individual field.

DEPLOYMENT PREPARATION
Write scripts/deploy/deploy-mainnet.sh that builds, runs the size gate, prints the expected rent using solana rent for the binary size plus 45, and prints the exact solana program deploy command with --max-len set to the binary size and a low compute unit price. The script must not run the deploy itself unless invoked with an explicit --execute flag by the human. Document buffer recovery with --buffer and solana program close.

DELIVERABLES AND DEFINITION OF DONE
- All tests pass in CI; binary size gate passes; i18n key check passes; mock-data scan passes.
- Devnet deploy with recorded cost; mainnet deploy script ready.
- docs/ARCHITECTURE.md, SECURITY.md (threat model: operator key compromise, oracle dispute, PII, replay, griefing), COSTS.md, PRIOR_WORK.md (disclose NusaHarvest V1), LEGAL.md (why this is sponsor-funded conditional assistance and not insurance, open legal questions).
- README in English with a 60-second explanation, architecture diagram, program ID, how to reproduce a settlement hash.
- Stop and report honestly what is not done. Do not describe unfinished work as finished.
````

---

## G. Yang belum terjawab dan harus diputuskan pemilik
1. Hackathon target yang pasti dan tanggal tutupnya.
2. Kabupaten pilot dan siapa 10 petani pertama (butuh persetujuan mereka).
3. Sumber dana kampanye mainnet pertama dan jumlahnya.
4. Badan hukum untuk payment gateway, atau mitra yang bersedia menjadi disburser.
5. Siapa auditor independen untuk kampanye pertama.
6. Validasi tahun trigger terhadap produksi padi BPS per kabupaten (belum dilakukan; wajib sebelum mengklaim trigger adil).
