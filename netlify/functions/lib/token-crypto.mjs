import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

function getKey() {
  const hex = process.env.TOKEN_ENCRYPTION_KEY;
  if (!hex) throw new Error("TOKEN_ENCRYPTION_KEY is not set");
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex chars)");
  return buf;
}

export function encryptToken(plaintext) {
  if (!plaintext) return null;
  const key = getKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64"),
  });
}

export function decryptToken(ciphertext) {
  if (!ciphertext) return null;
  const key = getKey();
  let parsed;
  try {
    parsed = JSON.parse(ciphertext);
  } catch {
    throw new Error("RECONNECT");
  }
  if (!parsed.iv || !parsed.tag || !parsed.data) {
    throw new Error("RECONNECT");
  }
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(parsed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(parsed.data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("RECONNECT");
  }
}
