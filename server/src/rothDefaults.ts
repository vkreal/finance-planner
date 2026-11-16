// Shared Roth defaults — a LEAF module (Engine Review C1).
//
// This module holds the constants more than one engine module
// falls back to, so no engine module has to import them from
// another engine module. It imports nothing from this repo:
// that is what breaks the giftModel <-> rothSeed <->
// rothOptimizer import cycle (C1 finding F-1) — rothOptimizer
// used to import DEFAULT_HEIR_RATE_PCT from rothSeed, rothSeed
// imports the blank gift shape from giftModel, and giftModel
// imports the joint optimizer from rothOptimizer. The cycle
// was load-safe (every use sits inside a function body, never
// in top-level evaluation), but a cycle through three engine
// modules is one accidental top-level read away from a TDZ
// failure, and it hid the real layering: a shared default
// belongs to no engine. rothSeed re-exports this constant, so
// every existing import site keeps working unchanged.

export const DEFAULT_HEIR_RATE_PCT = 22;
// The rate a BLANK heir rate resolves to in BOTH plan-input
// builders (R3-S1): the client's local builder
// (RothConversion.tsx) and the server's planInputsFromSaved
// (rothOptimizer.ts) each fall back to THIS one constant when
// the heir rate is blank / null, and the blank preserved-
// balance exit rate inherits the same resolution (a blank
// exit rate first falls back to the resolved heir rate). The
// two builders previously disagreed — the local one fell back
// to the seed (SEED_HEIR_RATE) while the server fell back to
// a hard-coded literal — so the same blank plan priced its
// terminal cost at two different rates depending on which
// side priced it. This default is deliberately distinct from
// SEED_HEIR_RATE: the seed is the EXPLICIT value a fresh /
// reset record starts with (never blank, so it never passes
// through this fallback), while this constant governs only
// the blank case.
