// Backup authenticity MAC (round-5 security settlement item S1;
// The user chose option C, 2026-10-19; the MAC half, following the
// warning half that shipped with the hardening batch).
//
// Plaintext backup payloads (exportbackup's return value, and the
// plaintext inside every encrypted .mstbak) now carry a keyed
// authenticity MAC in their `authenticityMac` field: an
// HMAC-SHA-256 over a canonical serialization of the whole
// payload (every field except the MAC itself), computed at
// export and verified at restore, before any write:
//
//   * MAC present and verifying  -> the restore proceeds and its
//     result reports the backup as AUTHENTICATED.
//   * MAC present but NOT verifying -> the restore is REFUSED
//     with the authenticity error, zero writes: the payload's
//     contents were changed after export (edited, truncated, or
//     corrupted in transit/storage) instead of passing the
//     encryption key-check silently — the key check only ever
//     proved same-key compatibility, never content integrity.
//   * MAC absent (null) -> a backup written before this build.
//     It still restores — the user's own older backups are never
//     hard-refused — and the restore result labels it
//     UNAUTHENTICATED, the same framing the shipped warning used.
//
// WHAT THE MAC PROVES, AND WHAT IT DOES NOT (stated plainly, as
// the settlement requires): the MAC key SHIPS WITH THE APP — the
// same constant below is compiled into the live app and into
// the packaged build, which is exactly what lets a backup move
// between them and verify on either side. So the MAC is tamper
// and corruption DETECTION, not proof of origin: it catches any
// change made by someone (or something) that did not recompute
// the MAC with the app key — a hand-edited figure, a truncated
// or bit-rotted file, a payload assembled by other software.
// Anyone holding the app itself could in principle compute a
// valid MAC for altered contents, so it is not a signature and
// does not prove WHO made the file. The encrypted .mstbak
// files' guarantee is separate and unchanged (authenticated
// encryption: a modified file fails decryption).
//
// This module is pure, synchronous string/byte logic — no clock,
// no randomness, no platform crypto — so the live worker, the
// accuracy fixtures, and the packaged browser build all compute
// the identical MAC. SHA-256 and HMAC are implemented here
// (FIPS 180-4 / RFC 2104) because the shared restore path is
// synchronous (restoreCore's preflight and plan executor);
// the implementation is pinned against the published
// known-answer vectors by the extended fixtures.

/* ------------------------------ SHA-256 ------------------------------ */

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr32(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/** SHA-256 (FIPS 180-4) over the given bytes. */
export function sha256Bytes(data: Uint8Array): Uint8Array {
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const bitLen = data.length * 8;
  const paddedLen = Math.ceil((data.length + 9) / 64) * 64;
  const msg = new Uint8Array(paddedLen);
  msg.set(data);
  msg[data.length] = 0x80;
  const view = new DataView(msg.buffer);
  view.setUint32(paddedLen - 4, bitLen >>> 0);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000));
  const w = new Uint32Array(64);
  for (let block = 0; block < paddedLen; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 =
        rotr32(w[i - 15] ?? 0, 7) ^
        rotr32(w[i - 15] ?? 0, 18) ^
        ((w[i - 15] ?? 0) >>> 3);
      const s1 =
        rotr32(w[i - 2] ?? 0, 17) ^
        rotr32(w[i - 2] ?? 0, 19) ^
        ((w[i - 2] ?? 0) >>> 10);
      w[i] =
        ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }
    let a = H[0] ?? 0, b = H[1] ?? 0, c = H[2] ?? 0, d = H[3] ?? 0;
    let e = H[4] ?? 0, f = H[5] ?? 0, g = H[6] ?? 0, h = H[7] ?? 0;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 =
        (h + s1 + ch + (SHA256_K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const s0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = ((H[0] ?? 0) + a) >>> 0;
    H[1] = ((H[1] ?? 0) + b) >>> 0;
    H[2] = ((H[2] ?? 0) + c) >>> 0;
    H[3] = ((H[3] ?? 0) + d) >>> 0;
    H[4] = ((H[4] ?? 0) + e) >>> 0;
    H[5] = ((H[5] ?? 0) + f) >>> 0;
    H[6] = ((H[6] ?? 0) + g) >>> 0;
    H[7] = ((H[7] ?? 0) + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, H[i] ?? 0);
  return out;
}

/** HMAC-SHA-256 (RFC 2104) over the given bytes. */
export function hmacSha256Bytes(key: Uint8Array, data: Uint8Array): Uint8Array {
  const blockKey = new Uint8Array(64);
  blockKey.set(key.length > 64 ? sha256Bytes(key) : key);
  const inner = new Uint8Array(64 + data.length);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) {
    inner[i] = (blockKey[i] ?? 0) ^ 0x36;
    outer[i] = (blockKey[i] ?? 0) ^ 0x5c;
  }
  inner.set(data, 64);
  outer.set(sha256Bytes(inner), 64);
  return sha256Bytes(outer);
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function sha256Hex(text: string): string {
  return bytesToHex(sha256Bytes(utf8Bytes(text)));
}

export function hmacSha256Hex(keyText: string, text: string): string {
  return bytesToHex(hmacSha256Bytes(utf8Bytes(keyText), utf8Bytes(text)));
}

/* --------------------- The backup MAC itself --------------------- */

// The MAC key. It ships with the app ON PURPOSE (see the header:
// the same key in the live app and the packaged build is what
// lets backups verify on either side), and that is precisely
// why the MAC is framed — in the API contract and in the
// restore copy — as tamper/corruption detection, never as
// proof of origin.
export const BACKUP_MAC_KEY_TEXT =
  "finance-planner/backup-authenticity-mac/v1:6f3a9c51-28d4-4e07-b5a1-93c8d2e47f60";

/** The payload field that carries the MAC. */
export const BACKUP_MAC_FIELD = "authenticityMac";

/**
 * Canonical serialization of a backup payload for MAC purposes:
 * JSON with object keys sorted at every depth, arrays in order,
 * and the MAC field itself excluded at the top level. Two
 * payloads with identical contents serialize identically no
 * matter which build (or JSON round trip) produced the object,
 * so a MAC computed at export verifies at restore on either
 * side of the live/packaged boundary.
 */
export function canonicalBackupJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalBackupJson(v)).join(",")}]`;
  }
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return JSON.stringify(value);
    case "object": {
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys
        .map((k) => `${JSON.stringify(k)}:${canonicalBackupJson(obj[k])}`)
        .join(",")}}`;
    }
    default:
      return "null";
  }
}

function backupMacMessage(payload: unknown): string {
  if (payload != null && typeof payload === "object" && !Array.isArray(payload)) {
    const rest: Record<string, unknown> = {
      ...(payload as Record<string, unknown>),
    };
    delete rest[BACKUP_MAC_FIELD];
    return canonicalBackupJson(rest);
  }
  return canonicalBackupJson(payload);
}

/** The authenticity MAC for a backup payload (hex HMAC-SHA-256
 *  over the payload's canonical form, MAC field excluded). */
export function computeBackupMac(payload: unknown): string {
  return hmacSha256Hex(BACKUP_MAC_KEY_TEXT, backupMacMessage(payload));
}

// Length-checked, constant-work comparison of two MAC strings.
function backupMacEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a.charCodeAt(i) ?? 0) ^ (b.charCodeAt(i) ?? 0);
  }
  return diff === 0;
}

export type BackupAuthenticity = "verified" | "mismatch" | "absent";

/**
 * The three-state authenticity verdict for a payload:
 * "verified" — carries a MAC and it verifies over the payload's
 * contents; "mismatch" — carries a MAC that does NOT verify (the
 * contents changed after export, or the MAC itself was altered);
 * "absent" — carries no MAC (a pre-MAC backup, or one whose MAC
 * was stripped: the two are indistinguishable, which is exactly
 * why an absent MAC restores labelled UNAUTHENTICATED rather
 * than being refused or trusted).
 */
export function classifyBackupAuthenticity(payload: unknown): BackupAuthenticity {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
    return "absent";
  }
  const mac = (payload as Record<string, unknown>)[BACKUP_MAC_FIELD];
  if (typeof mac !== "string" || mac === "") return "absent";
  return backupMacEquals(mac, computeBackupMac(payload)) ? "verified" : "mismatch";
}
