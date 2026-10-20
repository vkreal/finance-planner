// Storage seam for the packaged build.
//
// Everything the packaged app persists lives behind this tiny
// key/value interface. The browser entry wires it to
// window.localStorage; the verification harness wires it to an
// in-memory map so the exact same adapter code runs headlessly.
//
// All packaged keys share the "fpkg:v1:" prefix:
//   fpkg:v1:meta        JSON {appliedMigrations, seeded, createdMs}
//   fpkg:v1:db:<n>      base64 chunks of the SQLite database image
//   fpkg:v1:dbcount     number of db chunks
//   fpkg:v1:enckey      base64 of the 32-byte at-rest encryption key
//   fpkg:v1:backups     JSON [{name, modifiedMs, envelopeJson}]
//   fpkg:v1:rsapub      RSA-4096 backup wrapping public key (JWK JSON)
//   fpkg:v1:rsapriv     RSA-4096 backup wrapping private key (JWK JSON)

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export const KEY_PREFIX = "fpkg:v1:";
export const META_KEY = `${KEY_PREFIX}meta`;
export const DB_COUNT_KEY = `${KEY_PREFIX}dbcount`;
export const DB_CHUNK_KEY = (i: number) => `${KEY_PREFIX}db:${i}`;
export const ENC_KEY_KEY = `${KEY_PREFIX}enckey`;
export const BACKUPS_KEY = `${KEY_PREFIX}backups`;
export const RSA_PUB_KEY = `${KEY_PREFIX}rsapub`;
export const RSA_PRIV_KEY = `${KEY_PREFIX}rsapriv`;

/** Browser wiring: the real localStorage. */
export function localStorageStore(): KeyValueStore {
  const ls = window.localStorage;
  return {
    get: (key) => ls.getItem(key),
    set: (key, value) => ls.setItem(key, value),
    remove: (key) => ls.removeItem(key),
  };
}

/** Harness wiring: a plain in-memory map with localStorage semantics. */
export function memoryStore(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    get: (key) => (map.has(key) ? (map.get(key) as string) : null),
    set: (key, value) => {
      map.set(key, value);
    },
    remove: (key) => {
      map.delete(key);
    },
  };
}
