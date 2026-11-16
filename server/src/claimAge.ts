// Social Security claiming-age display (Engine Review C1,
// NICE-3: extracted verbatim from server/src/rothOptimizer.ts,
// which re-exports both).
//
// A LEAF module: it imports nothing, so no engine module can
// cycle through it. The claiming-age LABEL is display text
// only — the math never reads it — so it belongs with no
// pricer: the gift model, the actions, and the fixtures all
// read the label from here instead of through the optimizer,
// which is what lets the gift model price without importing
// the optimizer's values.
//
// All money is in DOLLARS (the tax engine's units).

// Which claiming ages a scored candidate was priced at, and the
// yearly benefits those ages imply. `searched*` marks the
// spouses whose claiming age the joint search actually varied
// (only a spouse with an entered benefit is searched); for a
// fixed-age run both flags are false and the ages are the
// entered ones. `locked*` (Round-7 Build 3, N-1) marks a person
// whose benefit had already started at plan start — their
// entered claim age is the ONLY candidate age for them, because
// a claim that is already being paid cannot be changed.
// Optional so every pre-existing literal keeps its meaning:
// absent = not locked.
export type ClaimAgeInfo = {
  primaryAge: number | null;
  spouseAge: number | null;
  primaryAnnual: number;
  spouseAnnual: number;
  searchedPrimary: boolean;
  searchedSpouse: boolean;
  lockedPrimary?: boolean;
  lockedSpouse?: boolean;
};

// "You claim at 70 · Spouse claims at 67" — only the searched
// spouses appear; empty when neither benefit was entered.
export function claimAgeLabel(c: ClaimAgeInfo): string {
  const parts: string[] = [];
  if (c.searchedPrimary && c.primaryAge != null) parts.push(`You claim at ${c.primaryAge}`);
  if (c.searchedSpouse && c.spouseAge != null) parts.push(`Spouse claims at ${c.spouseAge}`);
  return parts.join(" · ");
}
