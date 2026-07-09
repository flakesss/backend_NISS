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

Isi `backend/.env`:

```env
PORT=3000
PI_STREAM_URL=http://host.docker.internal:5000/stream

# Supabase
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_KEY=<service_role_key>
SUPABASE_BUCKET=endoskop-media
```

> `MQTT_URL` di-override oleh Docker Compose ke `mqtt://mosquitto:1883` — tidak perlu diisi di `.env`.

### 4. Konfigurasi Cloudflare Tunnel

Buat file `.env` di **root repo** (sejajar `docker-compose.yml`):

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
  created_at  timestamptz default now()
);
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
