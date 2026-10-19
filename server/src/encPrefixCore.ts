// Reserved enc-prefix guard core — the single source for the
// encryption marker prefix, the reserved-prefix predicate, the
// rejection message, and the text-store decision, shared by the
// text writers (server/src/actions.ts) and the extended accuracy
// fixtures (server/src/extendedFixtures.ts), so the fixture suite
// exercises the exact decision the handlers execute.
//
// Safety contract (cluster E):
//   1. Ciphertext at rest is marked with ENC_PREFIX. A user-typed
//      text value that merely STARTS with those characters is not
//      ciphertext: storing it verbatim (the old encryptStr
//      idempotency shortcut) poisons the row — the next load tries
//      to decrypt it, throws, and the whole data load breaks.
//   2. A prefixed value may be stored as-is ONLY when it verifies
//      as genuine ciphertext under the app's key (an internal path
//      re-storing a value it just read). Anything else carrying the
//      prefix is REFUSED with RESERVED_ENC_PREFIX_MESSAGE before
//      any write, so a rejected value can never reach the database.
//   3. The predicate is exact: case-sensitive, position 0 only, no
//      trimming. "ENC:V1:x", " enc:v1:x" (leading space), and
//      "enc:v1" (no colon) are ordinary text and encrypt normally.
//   The reader is unchanged: decryptStr stays lenient for
//   non-prefixed values and throws for undecryptable prefixed
//   ones — this core guards the writers only.

// The marker every ciphertext value at rest starts with.
export const ENC_PREFIX = "enc:v1:";

// The exact refusal every writer returns (or throws) when a
// user-typed value carries the reserved prefix but is not genuine
// ciphertext.
export const RESERVED_ENC_PREFIX_MESSAGE =
  "Text can't start with “enc:v1:” — that start is reserved for encrypted data. Please change the first characters and try again.";

// True iff the value is a string starting with the reserved
// prefix. Case-sensitive, position-0 only, no trimming.
export function hasReservedEncPrefix(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(ENC_PREFIX);
}

export type TextStorePlan =
  | { action: "encrypt" }
  | { action: "passthrough" }
  | { action: "reject"; reason: string };

// The store decision every text writer follows:
//   no reserved prefix                       → encrypt
//   reserved prefix AND verifiable ciphertext → passthrough
//     (genuine ciphertext an internal path is re-storing)
//   reserved prefix AND not verifiable        → reject
// `verifyCiphertext` is the caller's proof: in actions.ts it is a
// real AES decrypt attempt under the request key; in the fixtures
// it recognises model ciphertext (see modelCiphertext below).
export function planTextStore(
  value: string,
  verifyCiphertext: (v: string) => boolean,
): TextStorePlan {
  if (!hasReservedEncPrefix(value)) return { action: "encrypt" };
  if (verifyCiphertext(value)) return { action: "passthrough" };
  return { action: "reject", reason: RESERVED_ENC_PREFIX_MESSAGE };
}

/* ------------------- Plain-state model helpers -------------------
   The fixtures' side of the shared decision, mirroring the real
   encrypt/decrypt pair so the suite exercises the exact decision
   the handler executes. The handler differs only in transport:
   its verifier is a real AES decrypt attempt, and its encrypt
   branch produces real AES-GCM ciphertext under the same prefix. */

const MODEL_MARKER = `${ENC_PREFIX}model:`;

// A model ciphertext value for `plain`: recognisably prefixed,
// trivially reversible, and verifiable by the fixture verifier
// (a startsWith check on the model marker).
export function modelCiphertext(plain: string): string {
  return MODEL_MARKER + plain;
}

// The lenient model reader: a model-ciphertext value reads back
// as its plain text; an unprefixed value reads as itself, exactly
// as decryptStr treats legacy plaintext.
export function modelPlaintext(stored: string): string {
  if (stored.startsWith(MODEL_MARKER)) return stored.slice(MODEL_MARKER.length);
  return stored;
}

export type AttemptStoreTextFieldResult =
  | { ok: true; stored: string }
  | { ok: false; reason: string; stored: string };

// One field's store flow over a plain stored value: reject leaves
// `stored` byte-identical to `priorStored`, encrypt stores the
// model ciphertext, passthrough stores the value unchanged.
export function attemptStoreTextField(
  priorStored: string,
  value: string,
  verifyCiphertext: (v: string) => boolean,
): AttemptStoreTextFieldResult {
  const plan = planTextStore(value, verifyCiphertext);
  if (plan.action === "reject") {
    return { ok: false, reason: plan.reason, stored: priorStored };
  }
  if (plan.action === "passthrough") {
    return { ok: true, stored: value };
  }
  return { ok: true, stored: modelCiphertext(value) };
}

// The batch store flow that used to live here (the CSV import
// model) moved to server/src/importCore.ts (API follow-on 3,
// finding F12): planImportBatch plans every row of an import call
// through planTextStore above, and executeImportPlanAtomically is
// its plain-state executor.
