// Backend Endoskop — jembatan REST API <-> MQTT + simpan metadata ke Supabase
// Frontend memanggil REST API ini; backend meneruskannya ke Pi lewat MQTT,
// dan mencatat metadata media ke tabel Supabase.
// Payload MQTT dienkripsi dengan AES-128-GCM (kerahasiaan + integritas).

const http = require("http");
const path = require("path");

const express = require("express");
const cors = require("cors");
const mqtt = require("mqtt");
const { createClient } = require("@supabase/supabase-js");

// ====== KONFIGURASI ======
require("dotenv").config();
const aesUtils = require("./aesUtils");

// Inisialisasi AES key dari env var — HARUS identik dengan key di devices_NISS (Pi)
try {
  aesUtils.loadKey();
} catch (e) {
  console.error(e.message);
  console.error("Backend tidak bisa mengenkripsi/mendekripsi MQTT tanpa key.");
  console.error("Set NISS_AES_KEY di .env (hex string 32 karakter dari Pi).");
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
const PI_STREAM_URL = process.env.PI_STREAM_URL || "http://localhost:5000/stream";
const PHARYNGITIS_URL = process.env.PHARYNGITIS_URL || "http://localhost:8000";
const CS_RECONSTRUCT_URL = process.env.CS_RECONSTRUCT_URL || "http://localhost:6000";

const MQTT_URL = process.env.MQTT_URL;
const MQTT_USERNAME = process.env.MQTT_USERNAME;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "endoskop-media";

const ALLOWED_COMMANDS = ["rekam", "stop", "foto", "set_cs_mr"];


// ==========================

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ---- State sederhana di memori ----
const devices = {}; // { "endoskop-01": { status, lastSeen } }
const events = [];
const MAX_EVENTS = 50;

// Deduplikasi insert DB — MQTT QoS 1 bisa kirim event lebih dari sekali
const insertedPaths = new Set();

// ---- Koneksi MQTT ----
const mqttOptions = {};
if (MQTT_USERNAME) mqttOptions.username = MQTT_USERNAME;
if (MQTT_PASSWORD) mqttOptions.password = MQTT_PASSWORD;
const mqttClient = mqtt.connect(MQTT_URL, mqttOptions);

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
    // Dekripsi payload MQTT (AES-128-GCM) dari device
    data = aesUtils.decryptJson(payload.toString());
  } catch (decErr) {
    // Fallback: Last Will "offline" dikirim broker sebagai plaintext
    // karena MQTT Last Will di-set sekali saat connect (tidak bisa pakai nonce unik)
    if (kind === "status") {
      try {
        data = JSON.parse(payload.toString());
        console.log(`[AES] Fallback plaintext untuk status/${deviceId}:`, data);
      } catch {
        console.log("[SECURITY] Dekripsi gagal dan bukan plaintext valid:", decErr.message);
        return;
      }
    } else {
      // Event/data non-status yang gagal didekripsi = DITOLAK
      console.error(`[SECURITY] Dekripsi/autentikasi gagal (${kind}/${deviceId}):`, decErr.message);
      return;
    }
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
              // Metadata CS -- cuma terisi kalau foto diambil lewat toggle "Foto via CS"
              // (lihat cs_info di mqtt_server.py:_do_snapshot), supaya panel "Info
              // Kompresi" bisa tahu MR ASLI yang dipakai saat capture, bukan menebak.
              cs_mr_percent: data.cs?.mrPercent ?? null,
              cs_payload_bytes: data.cs?.csPayloadBytes ?? null,
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
// File .enc (terenkripsi AES-128-GCM) didekripsi secara transparan sebelum dikirim.
// File lama (tanpa .enc) tetap di-proxy langsung (backward-compatible).
app.get("/recordings/:id/stream", async (req, res) => {
  const { spawn } = require("child_process");

  // 1. Ambil storage_path dari DB
  const { data: rec, error: e1 } = await supabase
    .from("recordings")
    .select("storage_path, type")
    .eq("id", req.params.id)
    .single();
  if (e1 || !rec) return res.status(404).json({ error: "rekaman tidak ditemukan" });

  const isEncrypted = rec.storage_path.endsWith(".enc");

  // 2. Buat signed URL sementara
  const { data: signed, error: e2 } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .createSignedUrl(rec.storage_path, 300);
  if (e2) return res.status(500).json({ error: e2.message });

  // ── File terenkripsi (.enc): download seluruh buffer → dekripsi → serve ──
  if (isEncrypted) {
    try {
      const upstream = await fetch(signed.signedUrl);
      if (!upstream.ok) return res.status(502).json({ error: "Gagal download dari storage" });
      const encBuffer = Buffer.from(await upstream.arrayBuffer());

      // Dekripsi AES-128-GCM → file asli (plaintext)
      const plainBuffer = aesUtils.decryptFile(encBuffer);
      console.log(`[AES] Dekripsi file: ${rec.storage_path} (${encBuffer.length} → ${plainBuffer.length} bytes)`);

      // Tentukan ekstensi asli (hilangkan .enc dari path, misal foto.jpg.enc → jpg)
      const origPath = rec.storage_path.replace(/\.enc$/, "");
      const ext = origPath.split(".").pop().toLowerCase();
      const mimeMap = {
        mp4: "video/mp4", webm: "video/webm", ogg: "video/ogg",
        jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
        avi: "video/x-msvideo", mkv: "video/x-matroska",
      };

      // Foto/format browser-native: langsung kirim buffer
      const browserNative = ["jpg", "jpeg", "png", "webm", "ogg"];
      if (browserNative.includes(ext)) {
        const mimeType = mimeMap[ext] || "application/octet-stream";
        res.set("Content-Type", mimeType);
        res.set("Content-Length", plainBuffer.length);
        return res.send(plainBuffer);
      }

      // Video: transcode via ffmpeg (stdin pipe karena data sudah di memory)
      console.log(`[stream] Transcode ${ext} → mp4 (dari .enc) untuk recording ${req.params.id}`);
      res.set("Content-Type", "video/mp4");
      res.set("Transfer-Encoding", "chunked");

      const ff = spawn("ffmpeg", [
        "-loglevel", "error",
        "-i", "pipe:0",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-an",
        "-movflags", "frag_keyframe+empty_moov+faststart",
        "-f", "mp4", "pipe:1",
      ]);
      ff.stdin.write(plainBuffer);
      ff.stdin.end();
      ff.stdout.pipe(res);
      ff.stderr.on("data", (d) => console.error("[ffmpeg]", d.toString()));
      ff.on("error", (err) => {
        console.error("[ffmpeg] Error spawn:", err);
        if (!res.headersSent) res.status(500).json({ error: "Gagal transcode: " + err.message });
      });
      ff.on("close", () => { if (!res.writableEnded) res.end(); });
      return;
    } catch (decErr) {
      console.error(`[AES] Gagal dekripsi file ${rec.storage_path}:`, decErr.message);
      return res.status(500).json({ error: "Gagal dekripsi file terenkripsi" });
    }
  }

  // ── File TIDAK terenkripsi (backward-compatible, file lama) ──
  const ext = rec.storage_path.split(".").pop().toLowerCase();

  // Browser hanya support H.264/AAC di MP4 — rekaman kita pakai mp4v (MPEG-4 Part 2)
  // yang tidak dikenal browser, jadi semua video perlu transcode ke H.264 via ffmpeg.
  // Foto (jpg/png/webm) tetap di-proxy langsung.
  const browserNative = ["jpg", "jpeg", "png", "webm", "ogg"];
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
    res.set("Content-Type", mimeType);
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

  // 3b. Format tidak didukung browser (AVI, MKV, MOV…) → transcode via ffmpeg
  console.log(`[stream] Transcode ${ext} → mp4 untuk recording ${req.params.id}`);

  res.set("Content-Type", "video/mp4");
  res.set("Transfer-Encoding", "chunked");

  const ff = spawn("ffmpeg", [
    "-loglevel", "error",
    "-i", signed.signedUrl,
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "28",
    "-an",
    "-movflags", "frag_keyframe+empty_moov+faststart",
    "-f", "mp4",
    "pipe:1",
  ]);

  ff.stdout.pipe(res);
  ff.stderr.on("data", (d) => console.error("[ffmpeg]", d.toString()));
  ff.on("error", (err) => {
    console.error("[ffmpeg] Error spawn:", err);
    if (!res.headersSent) res.status(500).json({ error: "Gagal transcode: " + err.message });
  });
  ff.on("close", () => { if (!res.writableEnded) res.end(); });
});

// ── Thumbnail galeri (foto → proxy image, video → ffmpeg extract frame) ──────
// File .enc didekripsi secara transparan (backward-compatible dengan file lama).
app.get("/recordings/:id/thumbnail", async (req, res) => {
  const { spawn } = require("child_process");

  const { data: rec, error: e1 } = await supabase
    .from("recordings")
    .select("storage_path, type")
    .eq("id", req.params.id)
    .single();
  if (e1 || !rec) return res.status(404).end();

  const isEncrypted = rec.storage_path.endsWith(".enc");

  const { data: signed, error: e2 } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .createSignedUrl(rec.storage_path, 300);
  if (e2 || !signed) return res.status(500).end();

  res.set("Cache-Control", "public, max-age=3600");

  // ── File terenkripsi (.enc): download → dekripsi → serve thumbnail ──
  if (isEncrypted) {
    try {
      const upstream = await fetch(signed.signedUrl);
      if (!upstream.ok) return res.status(502).end();
      const encBuffer = Buffer.from(await upstream.arrayBuffer());
      const plainBuffer = aesUtils.decryptFile(encBuffer);

      if (rec.type === "foto") {
        // Foto: kirim langsung setelah dekripsi
        res.set("Content-Type", "image/jpeg");
        res.set("Content-Length", plainBuffer.length);
        return res.send(plainBuffer);
      }

      // Video: extract 1 frame via ffmpeg dari stdin pipe
      res.set("Content-Type", "image/jpeg");
      const ff = spawn("ffmpeg", [
        "-loglevel", "error",
        "-ss", "00:00:01",
        "-i", "pipe:0",
        "-vframes", "1",
        "-vf", "scale=320:-1",
        "-f", "image2", "-vcodec", "mjpeg",
        "pipe:1",
      ]);
      ff.stdin.write(plainBuffer);
      ff.stdin.end();
      ff.stdout.pipe(res);
      ff.stderr.on("data", d => console.error("[thumb]", d.toString().trim()));
      ff.on("error", () => { if (!res.headersSent) res.status(500).end(); });
      ff.on("close", () => { if (!res.writableEnded) res.end(); });
      return;
    } catch (decErr) {
      console.error(`[AES] Gagal dekripsi thumbnail ${rec.storage_path}:`, decErr.message);
      return res.status(500).end();
    }
  }

  // ── File TIDAK terenkripsi (backward-compatible) ──
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

  // Video: extract 1 frame di detik ke-1 pakai ffmpeg (langsung dari signed URL)
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

// ── Snapshot tunggal dari Pi (dipakai frontend untuk polling) ────────────────
app.get("/stream/snapshot", (req, res) => {
  const piUrl = new URL(PI_STREAM_URL);
  const piReq = http.request({
    hostname: piUrl.hostname, port: piUrl.port || 80, path: "/snapshot", method: "GET",
  }, (piRes) => {
    if (piRes.statusCode === 503) return res.status(503).end();
    res.set("Content-Type", "image/jpeg");
    res.set("Cache-Control", "no-cache, no-store");
    piRes.pipe(res);
  });
  piReq.on("error", () => res.status(503).end());
  piReq.end();
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

// ── Info resolusi & FPS asli kamera Pi (bukan angka statis) ──────────────────
app.get("/stream/info", (req, res) => {
  const piUrl = new URL(PI_STREAM_URL);
  const piReq = http.request({
    hostname: piUrl.hostname, port: piUrl.port || 80, path: "/info", method: "GET",
  }, (piRes) => {
    let data = "";
    piRes.on("data", (chunk) => (data += chunk));
    piRes.on("end", () => res.status(piRes.statusCode).set("Content-Type", "application/json").send(data));
  });
  piReq.on("error", () => res.status(503).json({ error: "Info Pi tidak tersedia" }));
  piReq.end();
});

// ── Compressive Sensing (payload belum direkonstruksi, dikirim Pi→server) ────
// Frontend toggle "Mode: Normal / Compressive Sensing" memakai endpoint ini
// sebagai pengganti /stream/snapshot. Payload biner CS diambil dari Pi
// (/snapshot_cs, belum direkonstruksi), diteruskan ke service cs-reconstruct
// (OMP+DCT), hasilnya (JPEG) diteruskan ke client.
let lastCsStats = null; // { bytesIn, bytesOut, reconstructMs, jpegBytes, ts }

app.get("/stream/snapshot/cs", (req, res) => {
  const piUrl = new URL(PI_STREAM_URL);
  const piReq = http.request({
    hostname: piUrl.hostname, port: piUrl.port || 80, path: "/snapshot_cs", method: "GET",
  }, (piRes) => {
    if (piRes.statusCode === 503) return res.status(503).end();
    const chunks = [];
    piRes.on("data", (c) => chunks.push(c));
    piRes.on("end", () => {
      const csPayloadEnc = Buffer.concat(chunks);
      let csPayload;
      try {
        // Payload CS dienkripsi AES-128-GCM di Pi (format biner mentah,
        // bukan JSON/base64) -- didekripsi di sini sebelum diteruskan ke
        // cs-reconstruct (jaringan internal Docker, sudah dipercaya).
        csPayload = aesUtils.decryptRaw(csPayloadEnc);
      } catch (e) {
        return res.status(502).json({ error: "Dekripsi payload CS gagal", detail: e.message });
      }
      const reconUrl = new URL(`${CS_RECONSTRUCT_URL}/reconstruct`);
      const reconReq = http.request({
        hostname: reconUrl.hostname,
        port: reconUrl.port || 80,
        path: reconUrl.pathname,
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "Content-Length": csPayload.length },
      }, (reconRes) => {
        if (reconRes.statusCode !== 200) {
          return res.status(502).json({ error: "Rekonstruksi CS gagal" });
        }
        const jpegChunks = [];
        reconRes.on("data", (c) => jpegChunks.push(c));
        reconRes.on("end", () => {
          const jpeg = Buffer.concat(jpegChunks);
          lastCsStats = {
            bytesIn: csPayloadEnc.length, // ukuran nyata yang lewat jaringan (terenkripsi, +28 byte nonce/tag)
            bytesOut: Number(reconRes.headers["x-cs-bytes-out"] || jpeg.length),
            reconstructMs: Number(reconRes.headers["x-cs-reconstruct-ms"] || 0),
            ts: Date.now(),
          };
          res.set("Content-Type", "image/jpeg");
          res.set("Cache-Control", "no-cache, no-store");
          res.send(jpeg);
        });
      });
      reconReq.on("error", () => res.status(503).json({ error: "Service cs-reconstruct tidak tersedia" }));
      reconReq.end(csPayload);
    });
  });
  piReq.on("error", () => res.status(503).json({ error: "Snapshot CS Pi tidak tersedia" }));
  piReq.end();
});

// ── Statistik pembanding ukuran payload CS vs JPEG (data empiris skripsi) ────
app.get("/stream/cs-stats", (req, res) => {
  res.json({ last: lastCsStats });
});

// ── Analisis faringitis on-demand (tombol "Analisis" per foto/snapshot) ──────
// Frontend kirim body = bytes JPEG mentah (bukan JSON), diteruskan sebagai
// multipart/form-data ke service pharyngitis-ws (FastAPI, endpoint /predict).
app.post("/analyze", express.raw({ type: "image/*", limit: "10mb" }), (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: "Body harus berupa gambar (image/jpeg)" });
  }

  const boundary = `----niss${Date.now()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="snapshot.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const multipartBody = Buffer.concat([head, req.body, tail]);

  const url = new URL(`${PHARYNGITIS_URL}/predict`);
  const analyzeReq = http.request({
    hostname: url.hostname,
    port: url.port || 80,
    path: url.pathname,
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": multipartBody.length,
    },
  }, (modelRes) => {
    let data = "";
    modelRes.on("data", (chunk) => (data += chunk));
    modelRes.on("end", () => {
      res.status(modelRes.statusCode).set("Content-Type", "application/json").send(data);
    });
  });
  analyzeReq.on("error", () => res.status(503).json({ error: "Service analisis tidak tersedia" }));
  analyzeReq.end(multipartBody);
});

// ── Info kompresi CS (toggle "Info Kompresi" pada modal galeri) ──────────────
// Frontend kirim body = bytes gambar mentah (foto atau thumbnail video),
// diteruskan ke service cs-reconstruct yang mensimulasikan encode+decode CS
// di atas gambar itu lalu membalas metrik (PSNR, SSIM, ukuran payload).
app.post("/cs-quality", express.raw({ type: "image/*", limit: "10mb" }), (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: "Body harus berupa gambar (image/jpeg)" });
  }

  const url = new URL(`${CS_RECONSTRUCT_URL}/cs-quality`);
  if (req.query.mr) url.searchParams.set("mr", req.query.mr);
  const csReq = http.request({
    hostname: url.hostname,
    port: url.port || 80,
    path: url.pathname + url.search,
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "Content-Length": req.body.length },
  }, (csRes) => {
    let data = "";
    csRes.on("data", (chunk) => (data += chunk));
    csRes.on("end", () => {
      res.status(csRes.statusCode).set("Content-Type", "application/json").send(data);
    });
  });
  csReq.on("error", () => res.status(503).json({ error: "Service cs-reconstruct tidak tersedia" }));
  csReq.end(req.body);
});

// Kirim perintah ke device (rekam / stop / foto)
app.post("/devices/:id/command", (req, res) => {
  const { id } = req.params;
  const { cmd, mr } = req.body;

  if (!ALLOWED_COMMANDS.includes(cmd)) {
    return res.status(400).json({
      error: "perintah tidak valid",
      allowed: ALLOWED_COMMANDS,
    });
  }

  const usesMr = cmd === "set_cs_mr" || (cmd === "foto" && mr !== undefined);
  if (usesMr) {
    const mrNum = Number(mr);
    if (!Number.isInteger(mrNum) || mrNum < 10 || mrNum > 100) {
      return res.status(400).json({ error: "mr harus bilangan bulat 10-100" });
    }
  }

  const topic = `endoskop/${id}/command`;
  // Enkripsi command sebelum publish — device akan mendekripsinya
  const commandData = usesMr ? { cmd, mr: Number(mr) } : { cmd };
  const encPayload = aesUtils.encryptJson(commandData);
  mqttClient.publish(topic, encPayload, { qos: 1 });
  console.log(`Mengirim perintah '${cmd}' ke ${id} (encrypted)`);

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