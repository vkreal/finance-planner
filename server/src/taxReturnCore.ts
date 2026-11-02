// Tax-return actuals on the Roth plan record — the household's
// most recent Form 1040 lines 2b / 3a / 3b, saved WITH the plan
// record under their own taxReturn* keys, following the
// execution / mcCheck / gift plan-record-only pattern exactly,
// PLUS the calendar year of that return (contract v147).
//
// The three amounts exist for ONE purpose: they are the source
// of the Playground's "Start from my numbers" prefill for its
// Interest / Qualified dividends / Ordinary dividends dials
// (see taxReturnPrefillDollars below) and of the "as filed"
// preset, which loads them into the return year itself. Plan
// pricing NEVER reads them: they are deliberately NOT part of
// rothInputFields, so they never enter a scenario, never reach
// planInputsFromSaved, and never affect the Plan / Optimize /
// Compare / Work years / funding runs — those keep modelling
// interest and dividends from the plan's yield fields
// (taxableInterestYieldPct / taxableDividendYieldPct), exactly
// as before this build. The tax suite's
// tax-return-pricing-identity fixture pins that isolation: the
// saved plan prices bit-identically with the fields set or
// blank.
//
// The year is a fact ABOUT the amounts — which return they
// came from — so it is stored WITH them, never derived from
// today's date: deriving it would drift every year while the
// amounts stay put, and a return for the current year cannot
// have been filed yet. Null means the record was written
// before the year field existed (year not recorded); the
// amounts are still the most recent return's, and the
// Playground says so without naming a year until one is
// entered in the Tax Plan view.
//
// All money here is integer CENTS, like the record's other
// money fields; the prefill converts to dollars at the dial
// boundary, like every other prefill source.

/* ---------------- Saved tax-return shape ----------------
   The three Form 1040 actuals as stored in the saved plan
   record, plus the calendar year of the return they are from
   (contract v147). This is the ONE parse of that stored shape:
   saveRothInputs writes it, getRothPlanner returns it (its own
   taxReturn block — server/src/actions.ts imports this parse),
   and the accuracy fixtures pin its round-trip. Every field is
   nullable and null is preserved exactly: null means "not
   entered" — the household has not typed that line — and is
   never coerced to $0 on read, on hydration, or on save; null
   on the year means the return year was not recorded. */
export type RothTaxReturnStored = {
  // Form 1040 line 2b — taxable interest.
  taxReturnInterestCents: number | null;
  // Form 1040 line 3a — qualified dividends.
  taxReturnQualifiedDividendsCents: number | null;
  // Form 1040 line 3b — ordinary dividends, the TOTAL (which
  // includes the line 3a qualified part).
  taxReturnOrdinaryDividendsCents: number | null;
  // The calendar year of the return the three amounts are
  // from (contract v147) — the most recent filed return.
  taxReturnYear: number | null;
};

export const BLANK_ROTH_TAX_RETURN: RothTaxReturnStored = {
  taxReturnInterestCents: null,
  taxReturnQualifiedDividendsCents: null,
  taxReturnOrdinaryDividendsCents: null,
  taxReturnYear: null,
};

export function parseRothTaxReturn(raw: unknown): RothTaxReturnStored {
  if (raw == null || typeof raw !== "object") return { ...BLANK_ROTH_TAX_RETURN };
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  // The year is lenient like the amounts: a finite integer
  // calendar year in a sane range, else null — a record
  // written before this field existed simply has no year key.
  const year = (v: unknown): number | null =>
    typeof v === "number" && Number.isInteger(v) && v >= 2000 && v <= 2100 ? v : null;
  return {
    taxReturnInterestCents: num(r.taxReturnInterestCents),
    taxReturnQualifiedDividendsCents: num(r.taxReturnQualifiedDividendsCents),
    taxReturnOrdinaryDividendsCents: num(r.taxReturnOrdinaryDividendsCents),
    taxReturnYear: year(r.taxReturnYear),
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
