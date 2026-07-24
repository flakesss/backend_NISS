# NISS Endoscopy — Backend Server

REST API backend untuk sistem endoskopi NISS. Berjalan di Raspberry Pi, menjembatani antara frontend (Vercel), kamera USB, broker MQTT (HiveMQ), dan penyimpanan file (Supabase Storage).

## Arsitektur Sistem

```
Browser / Vercel Frontend
        │  HTTPS
        ▼
  app.satsetin.com
  (Cloudflare Tunnel)
        │
        ▼
  Docker Compose
  ├── backend (Node.js :3000)   ← repo ini
  ├── mosquitto (MQTT :1883)
  └── cloudflared (tunnel agent)
        │
        ▼
  Flask Stream (:5000) + mqtt_server.py
  (jalan native di host)
        │
        ▼
  Supabase (Storage & DB)
```

## Prasyarat

### Perangkat Keras
- Raspberry Pi 4 (direkomendasikan) atau PC Linux
- Kamera USB (endoskop / webcam)

### Perangkat Lunak
```bash
# Docker & Docker Compose (untuk backend + mosquitto + cloudflared)
docker --version
docker compose version

# Node.js 18+ (opsional, untuk development lokal)
node --version

# Python 3.9+ (untuk mqtt_server.py di host)
python3 --version

# ffmpeg (untuk transcode video — sudah di-install otomatis di Dockerfile)
# Jika jalan tanpa Docker: sudo apt install ffmpeg

# PM2 (untuk menjalankan kamera & tunnel di host)
npm install -g pm2

# Dependensi Python
pip3 install opencv-python-headless paho-mqtt flask requests
```

## Instalasi

### 1. Clone & Struktur Direktori

Pastikan struktur folder seperti berikut:

```
project_biomedis/
├── website/
│   ├── backend/        ← repo ini
│   │   ├── server.js
│   │   ├── ecosystem.config.js
│   │   ├── .env
│   │   └── frontend/dist/   ← hasil build frontend
│   └── frontend/
└── mqtt_test/
    └── mqtt_server.py
```

### 2. Install Dependensi Node.js

```bash
cd website/backend
npm install
```

### 3. Konfigurasi Environment

Salin dan isi file `.env`:

```bash
cp .env.example .env
```

Isi `backend/.env` dengan konfigurasi berikut agar semua layanan/endpoint dapat berjalan:

```env
# Port server backend (default: 3000)
PORT=3000

# URL Flask stream di Raspberry Pi (ubah ke IP Pi lokal atau URL tunnel jika Pi di jaringan berbeda)
PI_STREAM_URL=http://host.docker.internal:5000/stream

# URL Microservice Analisis Faringitis & Compressive Sensing (untuk Docker: pakai nama service)
PHARYNGITIS_URL=http://localhost:8000
CS_RECONSTRUCT_URL=http://localhost:6000

# Konfigurasi MQTT Broker (jika tanpa Docker Compose / broker eksternal)
MQTT_URL=mqtt://localhost:1883
MQTT_USERNAME=your_mqtt_username
MQTT_PASSWORD=your_mqtt_password

# Konfigurasi Supabase Storage & Database
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_KEY=<service_role_key>
SUPABASE_BUCKET=endoskop-media

# Enkripsi AES-128-GCM (WAJIB)
NISS_AES_KEY=<hex key 32 karakter dari Pi>
```

| Variabel | Default | Keterangan |
|---|---|---|
| `PORT` | `3000` | Port HTTP server Express |
| `PI_STREAM_URL` | `http://localhost:5000/stream` | Endpoint stream MJPEG dari Raspberry Pi (`http://host.docker.internal:5000/stream` di Docker lokal atau `https://pi-stream.satsetin.com/stream` via tunnel) |
| `PHARYNGITIS_URL` | `http://localhost:8000` | Endpoint service deteksi faringitis (`http://pharyngitis-ws:8000` di Docker) |
| `CS_RECONSTRUCT_URL` | `http://localhost:6000` | Endpoint service rekonstruksi Compressive Sensing (`http://cs-reconstruct:6000` di Docker) |
| `MQTT_URL` | - | URL broker MQTT. > **Catatan:** Jika dijalankan melalui Docker Compose, variabel ini otomatis di-override ke `mqtt://mosquitto:1883`. |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | - | Kredensial login ke broker MQTT (kosongkan jika broker lokal *allow anonymous*) |
| `SUPABASE_URL` | - | URL project Supabase |
| `SUPABASE_SERVICE_KEY` | - | Kunci API `service_role` dari Supabase (bukan `anon` key agar bisa upload & kelola database) |
| `SUPABASE_BUCKET` | `endoskop-media` | Nama bucket storage di Supabase |
| `NISS_AES_KEY` | - | **WAJIB.** Key AES-128 hex (32 char). Harus identik dengan key di Pi. Dapatkan dari output startup Pi atau `python3 -c "print(open('aes_key.bin','rb').read().hex())"` |

### 4. Konfigurasi Cloudflare Tunnel (Opsional / Production)

Jika menjalankan dengan Docker Compose untuk akses publik (`app.satsetin.com`), buat file `.env` di **root repo** (sejajar `docker-compose.yml`):

```env
CLOUDFLARE_TOKEN=<token dari Cloudflare Zero Trust dashboard>
```

Token didapat dari: **Cloudflare Dashboard → Zero Trust → Networks → Tunnels → klik tunnel → Configure**

### 5. Build Frontend

```bash
cd website/frontend
npm install
VITE_API_URL=https://app.satsetin.com npm run build
```

Output `dist/` otomatis di-mount ke backend container via volume di `docker-compose.yml`.

---

## Menjalankan Server

### Dengan Docker Compose (direkomendasikan)

Dari root repo (folder yang berisi `docker-compose.yml`):

```bash
docker compose up -d       # jalankan semua service
docker compose ps          # cek status
docker logs niss-backend   # log backend
docker logs niss-cloudflared  # cek koneksi tunnel
```

### Kamera & PM2 (di host / Pi)

```bash
# Jalankan kamera script
cd <root-repo>
pm2 start ecosystem.config.js --only niss-camera
pm2 save
pm2 startup
```

### Manual (tanpa Docker)

```bash
# Terminal 1 — Backend API
cd backend
node server.js

# Terminal 2 — Kamera & MQTT
python3 mqtt_server.py
```

---

## Perintah PM2 Penting

```bash
pm2 list                        # lihat status semua proses
pm2 logs niss-backend           # log backend real-time
pm2 logs niss-camera            # log kamera real-time
pm2 restart niss-backend        # restart backend
pm2 restart niss-camera         # restart kamera
pm2 restart all                 # restart semua
pm2 stop all                    # hentikan semua
pm2 delete all                  # hapus dari PM2
```

---

## API Endpoints

| Method | Endpoint | Keterangan |
|--------|----------|------------|
| `GET` | `/` | Health check |
| `GET` | `/devices` | Status semua device |
| `GET` | `/devices/:id` | Status satu device |
| `POST` | `/devices/:id/command` | Kirim perintah (`rekam` / `stop` / `foto`) |
| `GET` | `/events` | Riwayat event terbaru (in-memory) |
| `GET` | `/recordings` | Daftar rekaman dari Supabase DB |
| `GET` | `/recordings/:id/url` | Signed URL download (1 jam) |
| `GET` | `/recordings/:id/stream` | Stream video (H.264 via ffmpeg) |
| `GET` | `/recordings/:id/thumbnail` | Thumbnail JPEG untuk galeri |
| `GET` | `/stream/snapshot` | Snapshot JPEG tunggal dari kamera |
| `GET` | `/stream/live` | MJPEG live stream proxy |
| `GET` | `/stream/info` | Resolusi & FPS aktual kamera Pi (JSON, bukan angka statis) |
| `GET` | `/stream/snapshot/cs` | Snapshot Compressive Sensing — payload CS didekripsi dari Pi lalu direkonstruksi (OMP+DCT) via service `cs-reconstruct`, dibalas sebagai JPEG |
| `GET` | `/stream/cs-stats` | Statistik ukuran byte payload CS vs hasil rekonstruksi (data empiris) |
| `POST` | `/analyze` | Analisis faringitis on-demand (DenseNet121), body = bytes JPEG |

---

## Supabase Setup

### Tabel `recordings`

```sql
create table recordings (
  id          bigint generated always as identity primary key,
  device_id   text not null,
  type        text not null check (type in ('video', 'foto')),
  storage_path text,
  duration_sec numeric,
  cs_mr_percent    integer,  -- MR asli dipakai saat capture (cuma terisi kalau via "Foto via CS")
  cs_payload_bytes bigint,   -- ukuran payload CS asli (byte) saat capture
  cs_psnr          numeric,  -- PSNR ASLI (dihitung di Pi vs frame sebelum kompresi)
  cs_ssim          numeric,  -- SSIM ASLI (dihitung di Pi vs frame sebelum kompresi)
  created_at  timestamptz default now()
);
```

Kalau tabel `recordings` sudah ada sebelumnya (dibuat sebelum fitur "Foto via CS"),
jalankan migrasi ini:

```sql
alter table recordings
  add column if not exists cs_mr_percent integer,
  add column if not exists cs_payload_bytes bigint,
  add column if not exists cs_psnr numeric,
  add column if not exists cs_ssim numeric;
```

### Storage Bucket

Buat bucket `endoskop-media` di Supabase Storage dengan akses **private**.

---

## Konfigurasi Kamera (`mqtt_server.py`)

Edit bagian atas `mqtt_test/mqtt_server.py` untuk menyesuaikan dengan perangkat:

```python
CAMERA_INDEX = 0          # indeks kamera (0 = kamera pertama)
FRAME_WIDTH  = 1280       # resolusi — sesuaikan dengan kamera
FRAME_HEIGHT = 720
VIDEO_FPS    = 20
JPEG_QUALITY = 80
MEDIA_DIR    = "/path/to/media"   # folder penyimpanan lokal
```

Resolusi aktual kamera terdeteksi otomatis saat startup — cek log:
```bash
pm2 logs niss-camera | grep Resolusi
```

---

## Troubleshooting

| Masalah | Solusi |
|---------|--------|
| Video tidak bisa diputar di browser eksternal | Pastikan `VITE_API_URL` di-set di Vercel. Backend fetch video ke blob sebelum diputar. |
| Stream snapshot offline | Cek `pm2 logs niss-camera` — pastikan kamera terbuka dan Flask jalan di port 5000 |
| Upload ke Supabase gagal | Cek `SUPABASE_SERVICE_KEY` di `.env` — harus menggunakan **service_role** key, bukan anon key |
| ffmpeg error saat stream video | `sudo apt install ffmpeg` dan pastikan versi ≥ 4.x |
| Cloudflare tunnel tidak connect | Cek `docker logs niss-cloudflared` — pastikan `CLOUDFLARE_TOKEN` di `.env` root sudah benar |
| PM2 tidak load perubahan file | `pm2 restart <name>` — PM2 cache modul, perlu restart manual |
| `[SECURITY] Dekripsi/autentikasi gagal` | `NISS_AES_KEY` di `.env` backend tidak cocok dengan key di Pi. Salin ulang hex key dari Pi |
| `[AES] Environment variable NISS_AES_KEY belum di-set` | Tambahkan `NISS_AES_KEY=<hex>` ke `.env` backend |

## Enkripsi AES-128-GCM

Semua payload MQTT antara device (Pi) dan backend dienkripsi menggunakan **AES-128-GCM**:
- **Command** (backend → Pi): dienkripsi sebelum publish ke topic `command`
- **Event** (Pi → backend): didekripsi saat diterima dari topic `event`
- **Status** (Pi → backend): didekripsi saat diterima; fallback plaintext untuk Last Will

Frontend **tidak perlu perubahan** — menerima data plaintext dari backend via REST API seperti biasa.

### Setup Key

1. Jalankan `mqtt_server.py` di Pi (pertama kali akan generate key otomatis)
2. Salin hex key dari log Pi ke `.env` backend: `NISS_AES_KEY=<hex>`
3. Restart backend

> **Catatan Hardware:** Raspberry Pi 4 (BCM2711) tidak punya hardware AES accelerator — semua operasi AES software-only. Untuk data kecil (MQTT payload JSON), ini tidak menjadi bottleneck.

Payload **Compressive Sensing** (`/stream/snapshot/cs`) juga dienkripsi dengan
skema yang sama, tapi pakai format biner mentah (nonce+tag+ciphertext, bukan
JSON/base64) supaya tidak menambah overhead ~33% di atas payload yang sudah
diperkecil habis-habisan — overhead nyata cuma 28 byte/frame
(`aesUtils.encryptRaw`/`decryptRaw` di `aesUtils.js`).

## Update Pi Fisik

Backend di repo ini sudah siap menerima payload CS terenkripsi dan
`/stream/info`, tapi **Raspberry Pi fisik perlu diperbarui secara manual**
(git pull + install `pycryptodome` + sinkronisasi `NISS_AES_KEY` + restart)
sebelum fitur-fitur ini aktif end-to-end. Langkah lengkapnya ada di
[`PI_UPDATE.md`](https://github.com/flakesss/devices_NISS/blob/main/PI_UPDATE.md)
di repo `devices_NISS`.
