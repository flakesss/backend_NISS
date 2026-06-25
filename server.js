// Backend Endoskop — jembatan REST API <-> MQTT + simpan metadata ke Supabase
// Frontend memanggil REST API ini; backend meneruskannya ke Pi lewat MQTT,
// dan mencatat metadata media ke tabel Supabase.

const express = require("express");
const cors = require("cors");
const mqtt = require("mqtt");
const { createClient } = require("@supabase/supabase-js");

// ====== KONFIGURASI ======
require("dotenv").config();

const PORT = process.env.PORT || 3000;

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
    const record = { deviceId, ...data, receivedAt: new Date().toISOString() };
    events.unshift(record);
    if (events.length > MAX_EVENTS) events.pop();
    console.log(`[event] ${deviceId}:`, data);

    // Simpan metadata ke database kalau ada file barunya
    if (data.event === "recording_stopped" || data.event === "snapshot_taken") {
      if (data.storage_path) {
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

app.listen(PORT, () => {
  console.log(`Backend jalan di http://localhost:${PORT}`);
});