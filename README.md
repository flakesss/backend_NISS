# NISS Endoscopy — Backend Server

REST API backend untuk sistem endoskopi NISS. Berjalan di Raspberry Pi, menjembatani antara frontend (Vercel), kamera USB, broker MQTT (HiveMQ), dan penyimpanan file (Supabase Storage).

## Arsitektur Sistem

```
Browser / Vercel Frontend
        │  HTTPS
        ▼
  ngrok tunnel  ──►  Backend (Node.js :3000)
                            │
               ┌────────────┼────────────┐
               ▼            ▼            ▼
        MQTT Broker    Flask Stream   Supabase
        (HiveMQ)       (:5000)        Storage & DB
               │
               ▼
        mqtt_server.py
        (kamera + rekam)
```

## Prasyarat

### Perangkat Keras
- Raspberry Pi 4 (direkomendasikan) atau perangkat Linux lainnya
- Kamera USB (endoskop / webcam)

### Perangkat Lunak
```bash
# Node.js 18+
node --version

# Python 3.9+
python3 --version

# ffmpeg (untuk transcode video AVI → MP4)
sudo apt install ffmpeg

# ngrok (untuk tunnel HTTPS publik)
# Download dari https://ngrok.com/download lalu:
sudo mv ngrok /usr/local/bin/

# PM2 (process manager)
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

Isi `.env`:

```env
PORT=3000
PI_STREAM_URL=http://127.0.0.1:5000/stream

# HiveMQ Cloud
MQTT_HOST=<your>.s1.eu.hivemq.cloud
MQTT_PORT=8883
MQTT_USERNAME=<username>
MQTT_PASSWORD=<password>

# Supabase
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_KEY=<service_role_key>
SUPABASE_BUCKET=endoskop-media
```

### 4. Konfigurasi ngrok

Login ngrok dan set static domain:

```bash
ngrok config add-authtoken <your_token>
```

Edit `ecosystem.config.js` — ganti URL ngrok di bagian `niss-stream-tunnel`:

```js
args: "http --url=<your-static-domain>.ngrok-free.app 3000"
```

### 5. Build Frontend

```bash
cd website/frontend
npm install
VITE_API_URL=https://<your-static-domain>.ngrok-free.app npm run build
cp -r dist ../backend/frontend/dist
```

Atau jika frontend di-deploy ke Vercel, cukup set environment variable `VITE_API_URL` di Vercel dashboard.

---

## Menjalankan Server

### Semua sekaligus (direkomendasikan)

```bash
cd website/backend
pm2 start ecosystem.config.js
pm2 save   # simpan agar auto-start setelah reboot
pm2 startup  # ikuti instruksi yang ditampilkan
```

### Manual per proses

```bash
# Terminal 1 — Backend API
cd website/backend
node server.js

# Terminal 2 — Kamera & MQTT
python3 mqtt_test/mqtt_server.py

# Terminal 3 — Tunnel ngrok
ngrok http --url=<your-domain>.ngrok-free.app 3000
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
| ngrok ERR_NGROK_6024 | Frontend harus mengirim header `ngrok-skip-browser-warning: 1` di setiap request |
| PM2 tidak load perubahan file | `pm2 restart <name>` — PM2 cache modul, perlu restart manual |
