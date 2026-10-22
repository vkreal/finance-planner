// Tax-return actuals on the Roth plan record — the household's
// most recent Form 1040 lines 2b / 3a / 3b, saved WITH the plan
// record under their own taxReturn* keys, following the
// execution / mcCheck / gift plan-record-only pattern exactly.
//
// The three amounts exist for ONE purpose: they are the source
// of the Playground's "Start from my numbers" prefill for its
// Interest / Qualified dividends / Ordinary dividends dials
// (see taxReturnPrefillDollars below). Plan pricing NEVER reads
// them: they are deliberately NOT part of rothInputFields, so
// they never enter a scenario, never reach planInputsFromSaved,
// and never affect the Plan / Optimize / Compare / Work years /
// funding runs — those keep modelling interest and dividends
// from the plan's yield fields (taxableInterestYieldPct /
// taxableDividendYieldPct), exactly as before this build. The
// tax suite's tax-return-pricing-identity fixture pins that
// isolation: the saved plan prices bit-identically with the
// fields set or blank.
//
// All money here is integer CENTS, like the record's other
// money fields; the prefill converts to dollars at the dial
// boundary, like every other prefill source.

/* ---------------- Saved tax-return shape ----------------
   The three Form 1040 actuals as stored in the saved plan
   record. This is the ONE parse of that stored shape:
   saveRothInputs writes it, getRothPlanner returns it (its own
   taxReturn block — server/src/actions.ts imports this parse),
   and the accuracy fixtures pin its round-trip. Every field is
   nullable and null is preserved exactly: null means "not
   entered" — the household has not typed that line — and is
   never coerced to $0 on read, on hydration, or on save. */
export type RothTaxReturnStored = {
  // Form 1040 line 2b — taxable interest.
  taxReturnInterestCents: number | null;
  // Form 1040 line 3a — qualified dividends.
  taxReturnQualifiedDividendsCents: number | null;
  // Form 1040 line 3b — ordinary dividends, the TOTAL (which
  // includes the line 3a qualified part).
  taxReturnOrdinaryDividendsCents: number | null;
};

export const BLANK_ROTH_TAX_RETURN: RothTaxReturnStored = {
  taxReturnInterestCents: null,
  taxReturnQualifiedDividendsCents: null,
  taxReturnOrdinaryDividendsCents: null,
};

export function parseRothTaxReturn(raw: unknown): RothTaxReturnStored {
  if (raw == null || typeof raw !== "object") return { ...BLANK_ROTH_TAX_RETURN };
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    taxReturnInterestCents: num(r.taxReturnInterestCents),
    taxReturnQualifiedDividendsCents: num(r.taxReturnQualifiedDividendsCents),
    taxReturnOrdinaryDividendsCents: num(r.taxReturnOrdinaryDividendsCents),
  };
}

/* ---------------- The Playground prefill mapping ----------------
   The ONE mapping from the saved tax-return actuals to the
   Playground's three income dials, in DOLLARS (the dials'
   units): interest ← line 2b (taxable interest), qualified
   dividends ← line 3a, ordinary dividends ← line 3b written as
   the TOTAL — the Playground's Ordinary dividends dial is the
   3b total by its own contract (see the playgroundYearSemantics
   convention describeApi publishes: the qualified part is a
   subset of that total, counted once), so the total is what
   the prefill writes, never the non-qualified remainder. A
   line the household has not entered (null) maps to null,
   which the prefill renders as a blank dial. The Playground's
   "Start from my numbers" calls this exact function, and the
   tax suite's tax-return-prefill-mapping fixture pins it, so
   the mapping the user gets is the mapping the fixtures prove. */
export function taxReturnPrefillDollars(stored: RothTaxReturnStored): {
  interest: number | null;
  qualifiedDividends: number | null;
  ordinaryDividends: number | null;
} {
  return {
    interest:
      stored.taxReturnInterestCents == null
        ? null
        : stored.taxReturnInterestCents / 100,
    qualifiedDividends:
      stored.taxReturnQualifiedDividendsCents == null
        ? null
        : stored.taxReturnQualifiedDividendsCents / 100,
    ordinaryDividends:
      stored.taxReturnOrdinaryDividendsCents == null
        ? null
        : stored.taxReturnOrdinaryDividendsCents / 100,
  };
}
