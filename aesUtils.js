/**
 * AES-128-GCM encryption/decryption untuk NISS — Backend Node.js.
 * Interoperabel dengan aes_utils.py (Python/pycryptodome) di devices_NISS.
 *
 * Spesifikasi:
 *   - AES-128-GCM, Nonce 12 byte (NIST SP 800-38D), Auth Tag 16 byte
 *   - Key dari env var NISS_AES_KEY (hex, 32 chars)
 *   - Payload format: { nonce_b64, ciphertext_b64, tag_b64 }
 */

const crypto = require("crypto");

const ALGORITHM = "aes-128-gcm";
const KEY_LENGTH = 16;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

let _cachedKey = null;

function loadKey(envVar = "NISS_AES_KEY") {
  if (_cachedKey) return _cachedKey;
  const hexKey = (process.env[envVar] || "").trim();
  if (!hexKey) {
    throw new Error(
      `[AES] Environment variable ${envVar} belum di-set. ` +
      `Salin hex key dari device (Pi) ke .env backend: ${envVar}=<32 hex chars>`
    );
  }
  if (!/^[0-9a-fA-F]+$/.test(hexKey)) {
    throw new Error(`[AES] ${envVar} bukan hex string valid.`);
  }
  const key = Buffer.from(hexKey, "hex");
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `[AES] ${envVar} harus ${KEY_LENGTH} byte (${KEY_LENGTH * 2} hex chars), ` +
      `diterima ${key.length} byte.`
    );
  }
  _cachedKey = key;
  console.log(`[AES] Key dimuat dari environment variable $${envVar}`);
  return _cachedKey;
}

/**
 * Enkripsi data dengan AES-128-GCM.
 * @param {string|Buffer} plaintext
 * @param {Buffer} [key]
 * @returns {{ nonce_b64: string, ciphertext_b64: string, tag_b64: string }}
 */
function encryptPacket(plaintext, key) {
  if (!key) key = loadKey();
  if (typeof plaintext === "string") plaintext = Buffer.from(plaintext, "utf8");
  const nonce = crypto.randomBytes(NONCE_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    nonce_b64: nonce.toString("base64"),
    ciphertext_b64: encrypted.toString("base64"),
    tag_b64: tag.toString("base64"),
  };
}

/**
 * Dekripsi paket AES-128-GCM.
 * @param {Object} packet - { nonce_b64, ciphertext_b64, tag_b64 }
 * @param {Buffer} [key]
 * @returns {Buffer} plaintext
 * @throws {Error} Jika auth tag gagal / data rusak
 */
function decryptPacket(packet, key) {
  if (!key) key = loadKey();
  const nonce = Buffer.from(packet.nonce_b64, "base64");
  const ciphertext = Buffer.from(packet.ciphertext_b64, "base64");
  const tag = Buffer.from(packet.tag_b64, "base64");
  if (nonce.length !== NONCE_LENGTH) {
    throw new Error(`Nonce harus ${NONCE_LENGTH} byte, diterima ${nonce.length}`);
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, nonce);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (e) {
    throw new Error(
      `Dekripsi AES-128-GCM gagal — data dirusak/tag tidak cocok/key salah. ` +
      `Detail: ${e.message}`
    );
  }
}

/** Serialisasi object → JSON → encrypt → return JSON string. */
function encryptJson(data, key) {
  const plaintext = JSON.stringify(data);
  const packet = encryptPacket(plaintext, key);
  return JSON.stringify(packet);
}

/** Dekripsi JSON payload string → object asli. */
function decryptJson(payloadStr, key) {
  const packet = JSON.parse(payloadStr);
  const plaintext = decryptPacket(packet, key);
  return JSON.parse(plaintext.toString("utf8"));
}

/**
 * Dekripsi file terenkripsi (.enc) dari Supabase Storage.
 * File .enc berisi JSON {nonce_b64, ciphertext_b64, tag_b64}.
 * @param {Buffer} encryptedBuffer - Buffer berisi JSON paket terenkripsi
 * @param {Buffer} [key]
 * @returns {Buffer} File asli (plaintext bytes — gambar/video)
 * @throws {Error} Jika dekripsi gagal / data rusak / key salah
 */
function decryptFile(encryptedBuffer, key) {
  const packet = JSON.parse(encryptedBuffer.toString("utf8"));
  return decryptPacket(packet, key);
}

module.exports = {
  loadKey, encryptPacket, decryptPacket, encryptJson, decryptJson,
  decryptFile,
  KEY_LENGTH, NONCE_LENGTH, TAG_LENGTH,
};
