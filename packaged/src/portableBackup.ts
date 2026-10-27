// Portable encrypted backups for the packaged build (contract
// v60, F5).
//
// Before v60 the packaged build's .mstbak envelopes were wrapped
// under an RSA keypair generated per install, so one install's
// backup could not be decrypted by another install (or by the
// live app) — the documented "encrypted backup file is the move
// path" workflow did not exist for a packaged user. This module
// is that workflow's envelope: the backup PAYLOAD (the exact
// object exportbackup returns) encrypted under a key derived
// from a passphrase the USER chooses.
//
// Custody story: there is no server key, no install key, and
// nothing to lose but the passphrase itself. The user picks a
// passphrase when exporting; the file carries only a random
// salt, the KDF parameters, and AES-256-GCM ciphertext. Anyone
// holding the file AND the passphrase can decrypt it on any
// install (the packaged import flow below, or the same WebCrypto
// steps offline); nobody without the passphrase can — including
// this app on a different install, which is precisely the
// portability property the per-install RSA vault lacks. The
// in-store backup vault (localPrivileged.ts) is unchanged: it
// remains this install's local, key-managed backup list. A lost
// passphrase means a lost file; the export UI says so.
//
// Envelope: JSON, format "mst-backup-portable", v 1:
//   { format, v, kdf: "PBKDF2-SHA256", iterations, salt,
//     iv, tag, payloadSha256, data }
// Key: PBKDF2-SHA256, 210,000 iterations, 256-bit. Cipher:
// AES-256-GCM with a random 96-bit IV; the 128-bit tag is stored
// separately, mirroring the .mstbak envelope's shape. Decryption
// verifies the GCM tag (a wrong passphrase fails there) and the
// payload's SHA-256 digest after opening.

export const PORTABLE_BACKUP_FORMAT = "mst-backup-portable";
const PBKDF2_ITERATIONS = 210_000;

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const SLICE = 0x8000;
  for (let i = 0; i < bytes.length; i += SLICE) {
    bin += String.fromCharCode(...bytes.subarray(i, i + SLICE));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase) as BufferSource,
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export interface PortableBackupEnvelope {
  format: string;
  v: number;
  kdf: string;
  iterations: number;
  salt: string;
  iv: string;
  tag: string;
  payloadSha256: string;
  data: string;
}

/** Encrypt a backup payload JSON string under the passphrase.
    Returns the envelope JSON (the .mstbak file's contents). */
export async function encryptPortableBackup(
  payloadJson: string,
  passphrase: string,
): Promise<string> {
  if (!passphrase) throw new Error("A passphrase is required to encrypt a backup.");
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const plain = new TextEncoder().encode(payloadJson);
  const payloadSha256 = await sha256Hex(plain);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      plain as BufferSource,
    ),
  );
  const envelope: PortableBackupEnvelope = {
    format: PORTABLE_BACKUP_FORMAT,
    v: 1,
    kdf: "PBKDF2-SHA256",
    iterations: PBKDF2_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    tag: bytesToBase64(sealed.subarray(sealed.length - 16)),
    payloadSha256,
    data: bytesToBase64(sealed.subarray(0, sealed.length - 16)),
  };
  return JSON.stringify(envelope, null, 2);
}

/** Decrypt a portable backup envelope back to the payload JSON
    string. Throws on a malformed envelope, a wrong passphrase,
    or any tampering (the GCM tag and the SHA-256 digest both
    verify before anything is returned). */
export async function decryptPortableBackup(
  envelopeJson: string,
  passphrase: string,
): Promise<string> {
  let env: PortableBackupEnvelope;
  try {
    env = JSON.parse(envelopeJson) as PortableBackupEnvelope;
  } catch {
    throw new Error("That file is not a portable backup (it is not valid JSON).");
  }
  if (
    env == null ||
    env.format !== PORTABLE_BACKUP_FORMAT ||
    env.v !== 1 ||
    env.kdf !== "PBKDF2-SHA256" ||
    typeof env.iterations !== "number" ||
    typeof env.salt !== "string" ||
    typeof env.iv !== "string" ||
    typeof env.tag !== "string" ||
    typeof env.data !== "string" ||
    typeof env.payloadSha256 !== "string"
  ) {
    throw new Error("That file is not a portable backup for this app.");
  }
  const key = await deriveKey(passphrase, base64ToBytes(env.salt), env.iterations);
  const data = base64ToBytes(env.data);
  const tag = base64ToBytes(env.tag);
  const sealed = new Uint8Array(data.length + tag.length);
  sealed.set(data, 0);
  sealed.set(tag, data.length);
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: base64ToBytes(env.iv) as BufferSource },
        key,
        sealed as BufferSource,
      ),
    );
  } catch {
    throw new Error(
      "The backup could not be decrypted — the passphrase is wrong or the file was changed or damaged.",
    );
  }
  if ((await sha256Hex(plain)) !== env.payloadSha256) {
    throw new Error("The backup failed its integrity check after decryption.");
  }
  return new TextDecoder().decode(plain);
}
