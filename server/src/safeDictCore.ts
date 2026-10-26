/* ---------------- Safe dictionaries for attacker-derived keys ----------------
   Security round-2, finding 1: a plain `{}` used as a dictionary
   for keys that come from restored / imported JSON is not a safe
   dictionary. Assigning `dict["__proto__"] = value` invokes the
   __proto__ setter and mutates the object's PROTOTYPE instead of
   creating an entry — the entry is invisible to Object.keys and
   to serialization, yet a later bare lookup `dict["__proto__"]`
   returns the planted value through the prototype chain, so a
   crafted settings blob could plant an invisible "remembered"
   mapping the importer then trusted.

   The treatment, applied by every parser that turns restored
   JSON into a key → value dictionary (nwImportCore's label
   mappings, importParseCore's OFX account mappings, uiFoldCore's
   fold map):
     1. Dictionaries are null-prototype objects (Object.create(null)),
        so no key — dangerous or not — can reach a prototype.
     2. The dangerous keys ("__proto__", "constructor",
        "prototype") are REJECTED at parse time: they are never
        stored, so they can never be matched later.
     3. A remembered hit is accepted only on an OWN property
        (hasOwnProperty), never through the prototype chain, so a
        dictionary handed in from outside these parsers cannot
        smuggle a mapping in through its prototype either. */

/* Keys that must never be stored in an attacker-derived
   dictionary: "__proto__" mutates a plain object's prototype on
   assignment; "constructor" / "prototype" shadow the inherited
   machinery a bare lookup would otherwise fall through to. */
export const DANGEROUS_DICT_KEYS: readonly string[] = [
  "__proto__",
  "constructor",
  "prototype",
];

export function isDangerousDictKey(key: string): boolean {
  return DANGEROUS_DICT_KEYS.includes(key);
}

/* A fresh dictionary with no prototype: assigning any key —
   including "__proto__" — creates an ordinary own entry, and a
   lookup for an absent key returns undefined, never an inherited
   value. JSON.stringify, Object.keys and Object.entries treat it
   exactly like a plain object. */
export function safeDict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/* The own-property test for remembered-mapping lookups: a hit
   counts only when the dictionary itself carries the key. */
export function hasOwnDictKey(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}
