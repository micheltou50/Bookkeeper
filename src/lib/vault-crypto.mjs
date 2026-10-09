// Vault crypto — everything the Vault page needs to keep its contents secret
// from the server. Pure Web Crypto (available in every modern browser and in
// Node 20+), no dependencies.
//
// Design (zero-knowledge):
//   • A random 256-bit DATA KEY encrypts every vault item with AES-256-GCM
//     (fresh 96-bit IV per write).
//   • The data key is never stored in the clear. It is WRAPPED (AES-GCM again)
//     under a KEY-ENCRYPTION KEY derived from the user's vault passphrase with
//     PBKDF2-SHA256 and a per-vault random salt.
//   • Supabase only ever sees: salt, iteration count, the wrapped data key and
//     item ciphertexts. Without the passphrase none of it can be read — not by
//     the server, not by anyone with the database, not by us.
//   • Changing the passphrase re-wraps the data key only; items stay as they are.
//   • A wrong passphrase fails the GCM auth tag on unwrap, so the wrapped key
//     doubles as the verifier — there is no separate hash to attack.
//
// Wire format for every blob is base64( iv(12) || ciphertext+tag ).

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const VAULT_KDF = "PBKDF2-SHA256";
// OWASP (2023) recommendation for PBKDF2-HMAC-SHA256. Stored per vault so it
// can be raised later without breaking older vaults.
export const VAULT_KDF_ITERATIONS = 600000;

const SALT_BYTES = 16;
const IV_BYTES = 12;

export function toB64(bytes) {
  let s = "";
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

export function fromB64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

// Passphrase → key-encryption key (AES-256-GCM, non-extractable).
async function deriveKek(passphrase, saltBytes, iterations) {
  const base = await subtle.importKey("raw", enc.encode(passphrase.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function aesEncrypt(key, bytes) {
  const iv = randomBytes(IV_BYTES);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return toB64(out);
}

async function aesDecrypt(key, blobB64) {
  const blob = fromB64(blobB64);
  if (blob.length <= IV_BYTES) throw new Error("Corrupt vault data");
  const iv = blob.slice(0, IV_BYTES);
  const ct = blob.slice(IV_BYTES);
  return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
}

async function importDataKey(rawBytes) {
  // Non-extractable: once imported the raw bytes cannot be read back out of
  // the CryptoKey, even by our own code.
  return subtle.importKey("raw", rawBytes, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/**
 * Create a brand-new vault from a passphrase.
 * Returns the row to persist plus the live (in-memory) data key.
 */
export async function createVault(passphrase) {
  if (!passphrase) throw new Error("A passphrase is required");
  const salt = randomBytes(SALT_BYTES);
  const iterations = VAULT_KDF_ITERATIONS;
  const kek = await deriveKek(passphrase, salt, iterations);
  const rawDataKey = randomBytes(32);
  const wrapped = await aesEncrypt(kek, rawDataKey);
  const dataKey = await importDataKey(rawDataKey);
  rawDataKey.fill(0);
  return {
    row: { kdf: VAULT_KDF, kdf_iterations: iterations, salt: toB64(salt), wrapped_key: wrapped },
    dataKey,
  };
}

/**
 * Unlock an existing vault row with a passphrase. Resolves to the data key, or
 * throws (GCM tag mismatch) when the passphrase is wrong.
 */
export async function unlockVault(passphrase, row) {
  if (!row || !row.salt || !row.wrapped_key) throw new Error("Vault is not set up");
  if (row.kdf && row.kdf !== VAULT_KDF) throw new Error(`Unsupported vault KDF: ${row.kdf}`);
  const kek = await deriveKek(passphrase, fromB64(row.salt), Number(row.kdf_iterations) || VAULT_KDF_ITERATIONS);
  let raw;
  try {
    raw = await aesDecrypt(kek, row.wrapped_key);
  } catch {
    throw new WrongPassphraseError();
  }
  const dataKey = await importDataKey(raw);
  raw.fill(0);
  return dataKey;
}

export class WrongPassphraseError extends Error {
  constructor() { super("Incorrect passphrase"); this.name = "WrongPassphraseError"; }
}

/**
 * Re-wrap the data key under a new passphrase. Verifies the old passphrase
 * first. Returns the replacement row fields (new salt + wrapped key).
 */
export async function changeVaultPassphrase(oldPassphrase, newPassphrase, row) {
  if (!newPassphrase) throw new Error("A new passphrase is required");
  const oldKek = await deriveKek(oldPassphrase, fromB64(row.salt), Number(row.kdf_iterations) || VAULT_KDF_ITERATIONS);
  let raw;
  try {
    raw = await aesDecrypt(oldKek, row.wrapped_key);
  } catch {
    throw new WrongPassphraseError();
  }
  const salt = randomBytes(SALT_BYTES);
  const iterations = VAULT_KDF_ITERATIONS;
  const newKek = await deriveKek(newPassphrase, salt, iterations);
  const wrapped = await aesEncrypt(newKek, raw);
  raw.fill(0);
  return { kdf: VAULT_KDF, kdf_iterations: iterations, salt: toB64(salt), wrapped_key: wrapped };
}

/** Encrypt any JSON-serialisable value with the data key. */
export async function encryptJson(dataKey, value) {
  return aesEncrypt(dataKey, enc.encode(JSON.stringify(value)));
}

/** Decrypt a blob produced by encryptJson. */
export async function decryptJson(dataKey, blobB64) {
  const bytes = await aesDecrypt(dataKey, blobB64);
  return JSON.parse(dec.decode(bytes));
}

/**
 * Rough passphrase strength: 0 (empty) … 4 (strong). Length does most of the
 * work; variety nudges it. Used only for the meter — nothing is enforced on
 * the server, because the server never sees the passphrase.
 */
export function passphraseStrength(p) {
  if (!p) return 0;
  let score = 0;
  if (p.length >= 8) score++;
  if (p.length >= 12) score++;
  if (p.length >= 16) score++;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
  if (classes >= 3) score++;
  return Math.min(4, score);
}

/** Generate a random password for a new login entry. */
export function generatePassword(length = 20) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*?-_";
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
