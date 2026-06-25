// Backend Endoskop — jembatan REST API <-> MQTT + simpan metadata ke Supabase
// Frontend memanggil REST API ini; backend meneruskannya ke Pi lewat MQTT,
// dan mencatat metadata media ke tabel Supabase.

const http = require("http");
const path = require("path");

const express = require("express");
const cors = require("cors");
const mqtt = require("mqtt");
const { createClient } = require("@supabase/supabase-js");

// ====== KONFIGURASI ======
require("dotenv").config();

const PORT = process.env.PORT || 3000;
const PI_STREAM_URL = process.env.PI_STREAM_URL || "http://localhost:5000/stream";

const MQTT_HOST = process.env.MQTT_HOST;
const MQTT_PORT = parseInt(process.env.MQTT_PORT) || 8883;
const MQTT_USERNAME = process.env.MQTT_USERNAME;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "endoskop-media";

const ALLOWED_COMMANDS = ["rekam", "stop", "foto"];


// ==========================

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ---- State sederhana di memori ----
const devices = {}; // { "endoskop-01": { status, lastSeen } }
const events = [];
const MAX_EVENTS = 50;

// Deduplikasi insert DB — MQTT QoS 1 bisa kirim event lebih dari sekali
const insertedPaths = new Set();

// ---- Koneksi MQTT ----
const mqttClient = mqtt.connect(`mqtts://${MQTT_HOST}:${MQTT_PORT}`, {
  username: MQTT_USERNAME,
  password: MQTT_PASSWORD,
});

mqttClient.on("connect", () => {
  console.log("Backend terhubung ke broker MQTT");
  mqttClient.subscribe("endoskop/+/status");
  mqttClient.subscribe("endoskop/+/event");
});

mqttClient.on("message", (topic, payload) => {
  const parts = topic.split("/"); // ["endoskop", "<id>", "status"|"event"]
  const deviceId = parts[1];
  const kind = parts[2];

  let data;
  try {
    data = JSON.parse(payload.toString());
  } catch {
    console.log("Pesan MQTT bukan JSON:", payload.toString());
    return;
  }

  if (kind === "status") {
    devices[deviceId] = { ...data, lastSeen: new Date().toISOString() };
    console.log(`[status] ${deviceId}:`, data);
  } else if (kind === "event") {
    // Abaikan event duplikat (MQTT QoS 1) — pakai file path sebagai kunci unik
    // storage_path hanya ada di recording_stopped & snapshot_taken, file ada di semua event
    const dupKey = data.storage_path || data.file;
    const isDup = dupKey && events.some(e => e.event === data.event && (e.storage_path || e.file) === dupKey);
    if (!isDup) {
      const record = { deviceId, ...data, receivedAt: new Date().toISOString() };
      events.unshift(record);
      if (events.length > MAX_EVENTS) events.pop();
    }
    console.log(`[event] ${deviceId}:`, data);

    // Simpan metadata ke database kalau ada file barunya
    if (data.event === "recording_stopped" || data.event === "snapshot_taken") {
      if (data.storage_path) {
        // Abaikan duplikat — MQTT QoS 1 bisa kirim event yang sama lebih dari sekali
        if (insertedPaths.has(data.storage_path)) {
          console.log("Duplikat event diabaikan:", data.storage_path);
        } else {
          insertedPaths.add(data.storage_path);
          // Hapus dari Set setelah 5 menit agar memori tidak terus bertambah
          setTimeout(() => insertedPaths.delete(data.storage_path), 5 * 60 * 1000);

          supabase
            .from("recordings")
            .insert({
              device_id: deviceId,
              type: data.event === "snapshot_taken" ? "foto" : "video",
              storage_path: data.storage_path,
              duration_sec: data.duration_sec ?? null,
            })
            .then(({ error }) => {
              if (error) console.error("Gagal simpan ke DB:", error.message);
              else console.log("Metadata tersimpan ke Supabase:", data.storage_path);
            });
        }
      } else {
        console.warn("Event tanpa storage_path (upload mungkin gagal), DB dilewati.");
      }
    }
  }
});

mqttClient.on("error", (err) => {
  console.error("MQTT error:", err.message);
});

// ---- REST API (Express) ----
const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.json({ ok: true, service: "endoskop-backend" });
});

// Lihat semua device + status terakhirnya
app.get("/devices", (req, res) => {
  res.json(devices);
});

// Lihat status satu device
app.get("/devices/:id", (req, res) => {
  const dev = devices[req.params.id];
  if (!dev) return res.status(404).json({ error: "device tidak ditemukan" });
  res.json(dev);
});

// Lihat riwayat event terbaru (dari memori)
app.get("/events", (req, res) => {
  res.json(events);
});

// Lihat daftar rekaman dari database (permanen)
app.get("/recordings", async (req, res) => {
  const { data, error } = await supabase
    .from("recordings")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Dapatkan URL sementara untuk memutar/melihat satu file (signed URL, 1 jam)
app.get("/recordings/:id/url", async (req, res) => {
  const { data: rec, error: e1 } = await supabase
    .from("recordings")
    .select("storage_path")
    .eq("id", req.params.id)
    .single();
  if (e1 || !rec) return res.status(404).json({ error: "rekaman tidak ditemukan" });

  const { data, error } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .createSignedUrl(rec.storage_path, 3600);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ url: data.signedUrl });
});

// ── Stream video/foto langsung dari Supabase Storage melalui backend ──────────
// Untuk format yang tidak didukung browser (AVI, MKV, MOV),
// backend akan otomatis transcode ke MP4 via ffmpeg jika tersedia.
app.get("/recordings/:id/stream", async (req, res) => {
  const { spawn } = require("child_process");

  // 1. Ambil storage_path dari DB
  const { data: rec, error: e1 } = await supabase
    .from("recordings")
    .select("storage_path, type")
    .eq("id", req.params.id)
    .single();
  if (e1 || !rec) return res.status(404).json({ error: "rekaman tidak ditemukan" });

  // 2. Buat signed URL sementara
  const { data: signed, error: e2 } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .createSignedUrl(rec.storage_path, 300);
  if (e2) return res.status(500).json({ error: e2.message });

  const ext = rec.storage_path.split(".").pop().toLowerCase();

  // Format yang didukung browser secara native
  const browserNative = ["mp4", "webm", "ogg"];
  const needsTranscode = !browserNative.includes(ext);

  // 3a. Format didukung browser → proxy langsung dengan support Range
  if (!needsTranscode) {
    const mimeMap = { mp4: "video/mp4", webm: "video/webm", ogg: "video/ogg",
                      jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png" };
    const mimeType = mimeMap[ext] || "application/octet-stream";

    const rangeHeader = req.headers["range"];
    const fetchHeaders = { Accept: "*/*" };
    if (rangeHeader) fetchHeaders["Range"] = rangeHeader;

    let upstream;
    try {
      upstream = await fetch(signed.signedUrl, { headers: fetchHeaders });
    } catch (err) {
      return res.status(502).json({ error: "Gagal ambil dari storage: " + err.message });
    }

    const statusCode = rangeHeader && upstream.status === 206 ? 206 : upstream.status;
    res.status(statusCode);
    res.set("Content-Type", upstream.headers.get("content-type") || mimeType);
    res.set("Accept-Ranges", "bytes");
    const cl = upstream.headers.get("content-length");
    if (cl) res.set("Content-Length", cl);
    const cr = upstream.headers.get("content-range");
    if (cr) res.set("Content-Range", cr);

    const reader = upstream.body.getReader();
    const pump = () => reader.read().then(({ done, value }) => {
      if (done) { res.end(); return; }
      res.write(Buffer.from(value));
      pump();
    }).catch(() => res.end());
    pump();
    return;
  }

  // 3b. Format TIDAK didukung browser (AVI, MKV, MOV…) → transcode via ffmpeg
  console.log(`[stream] Transcode ${ext} → mp4 untuk recording ${req.params.id}`);

  res.set("Content-Type", "video/mp4");
  res.set("Transfer-Encoding", "chunked");
  // Tidak set Content-Length karena ukuran output tidak diketahui sebelumnya

  // ffmpeg baca dari stdin (pipe dari Supabase), encode ke stdout sebagai MP4
  const ffmpegPath = process.platform === "win32"
    ? require("path").join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links", "ffmpeg.exe")
    : "ffmpeg";
  const ff = spawn(ffmpegPath, [
    "-loglevel", "error",
    "-i", "pipe:0",           // baca dari stdin
    "-c:v", "libx264",        // encode video H.264
    "-preset", "ultrafast",   // paling cepat (tradeoff: ukuran lebih besar)
    "-crf", "28",             // kualitas (18=tinggi, 28=cukup baik, 35=rendah)
    "-c:a", "aac",            // encode audio AAC
    "-movflags", "frag_keyframe+empty_moov+faststart", // streaming-friendly MP4
    "-f", "mp4",              // output format
    "pipe:1",                 // tulis ke stdout
  ]);

  ff.stdout.pipe(res);
  ff.stderr.on("data", (d) => console.error("[ffmpeg]", d.toString()));
  ff.on("error", (err) => {
    console.error("[ffmpeg] Error spawn:", err);
    if (!res.headersSent) {
      res.removeHeader("Transfer-Encoding"); // Hapus header chunked agar express bisa hitung Content-Length untuk JSON
      res.status(500).json({
        error: `Gagal memproses video .${ext} - ` + err.message,
        tip: "Pastikan ffmpeg terinstal dengan benar",
      });
    }
    ff.kill();
  });
  ff.on("close", () => { if (!res.writableEnded) res.end(); });

  // Unduh file dari Supabase dan pipe ke stdin ffmpeg
  try {
    const upstream = await fetch(signed.signedUrl);
    if (!upstream.ok) {
      ff.kill();
      return;
    }
    const reader = upstream.body.getReader();
    const pipeToFfmpeg = () => reader.read().then(({ done, value }) => {
      if (done) { ff.stdin.end(); return; }
      ff.stdin.write(Buffer.from(value));
      pipeToFfmpeg();
    }).catch(() => ff.stdin.end());
    pipeToFfmpeg();
  } catch {
    ff.kill();
  }
});

// ── Thumbnail galeri (foto → proxy image, video → ffmpeg extract frame) ──────
app.get("/recordings/:id/thumbnail", async (req, res) => {
  const { spawn } = require("child_process");

  const { data: rec, error: e1 } = await supabase
    .from("recordings")
    .select("storage_path, type")
    .eq("id", req.params.id)
    .single();
  if (e1 || !rec) return res.status(404).end();

  const { data: signed, error: e2 } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .createSignedUrl(rec.storage_path, 300);
  if (e2 || !signed) return res.status(500).end();

  res.set("Cache-Control", "public, max-age=3600");

  if (rec.type === "foto") {
    // Foto: proxy gambar langsung dari Supabase
    res.set("Content-Type", "image/jpeg");
    let upstream;
    try { upstream = await fetch(signed.signedUrl); }
    catch { return res.status(502).end(); }
    const reader = upstream.body.getReader();
    const pump = () => reader.read().then(({ done, value }) => {
      if (done) { res.end(); return; }
      res.write(Buffer.from(value));
      pump();
    }).catch(() => res.end());
    pump();
    return;
  }

  // Video: extract 1 frame di detik ke-1 pakai ffmpeg
  res.set("Content-Type", "image/jpeg");
  const ff = spawn("ffmpeg", [
    "-loglevel", "error",
    "-ss", "00:00:01",
    "-i", signed.signedUrl,
    "-vframes", "1",
    "-vf", "scale=320:-1",
    "-f", "image2",
    "-vcodec", "mjpeg",
    "pipe:1",
  ]);
  ff.stdout.pipe(res);
  ff.stderr.on("data", d => console.error("[thumb]", d.toString().trim()));
  ff.on("error", () => { if (!res.headersSent) res.status(500).end(); });
  ff.on("close", () => { if (!res.writableEnded) res.end(); });
});

// ── Proxy live stream MJPEG dari Pi ──────────────────────────────────────────
// Frontend cukup pakai <img src="/api/stream/live"> tanpa perlu tahu IP Pi
app.get("/stream/live", (req, res) => {
  const url = new URL(PI_STREAM_URL);
  const piReq = http.request({
    hostname: url.hostname,
    port: url.port || 80,
    path: url.pathname,
    method: "GET",
    headers: { Connection: "keep-alive" },
  }, (piRes) => {
    res.set("Content-Type", piRes.headers["content-type"] || "multipart/x-mixed-replace; boundary=frame");
    res.set("Cache-Control", "no-cache, no-store");
    res.set("X-Accel-Buffering", "no");
    piRes.pipe(res);
  });

  piReq.on("error", () => {
    if (!res.headersSent) res.status(503).json({ error: "Stream Pi tidak tersedia" });
  });

  req.on("close", () => piReq.destroy());
  piReq.end();
});

// Kirim perintah ke device (rekam / stop / foto)
app.post("/devices/:id/command", (req, res) => {
  const { id } = req.params;
  const { cmd } = req.body;

  if (!ALLOWED_COMMANDS.includes(cmd)) {
    return res.status(400).json({
      error: "perintah tidak valid",
      allowed: ALLOWED_COMMANDS,
    });
  }

  const topic = `endoskop/${id}/command`;
  mqttClient.publish(topic, JSON.stringify({ cmd }), { qos: 1 });
  console.log(`Mengirim perintah '${cmd}' ke ${id}`);

  res.json({ ok: true, sentTo: id, cmd });
});

// ── Serve frontend React build ────────────────────────────────────────────────
const FRONTEND_DIST = path.join(__dirname, "../frontend/dist");
app.use(express.static(FRONTEND_DIST));
// SPA fallback — semua route yang tidak dikenal dikembalikan ke index.html
app.get("/{*path}", (req, res) => {
  res.sendFile(path.join(FRONTEND_DIST, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Backend jalan di http://localhost:${PORT}`);
});