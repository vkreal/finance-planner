// Tax-return actuals on the Roth plan record — the household's
// most recent Form 1040 lines 2b / 3a / 3b, saved WITH the plan
// record under their own taxReturn* keys, following the
// execution / mcCheck / gift plan-record-only pattern exactly,
// PLUS the calendar year of that return (build v147).
//
// The three amounts feed the Playground's income dials: they
// are the source of the "Start from my numbers" prefill for
// its Interest / Qualified dividends / Ordinary dividends
// dials (see taxReturnPrefillDollars below) and of the
// "as filed" preset, which loads them into the return year
// itself. Plan pricing never reads the return amounts as
// amounts: they are deliberately NOT part of rothInputFields,
// so they never enter a scenario AS amounts and no compute
// action accepts them, and the bare planInputsFromSaved
// conversion never reads them. But every compute action
// reaches pricing through resolveArgsBalances, which reads
// the stored record and threads the two DERIVED percentages
// below onto the payload before that conversion is called —
// so a plan CAN price differently with the fields set than
// with them blank, through those percentages alone. The tax
// suite's tax-return-pricing-identity fixture pins that
// action path (contract v139, re-audit MUST M-1): the
// amounts never enter as amounts, and only the two derived
// percentages reach pricing.
//
// Their pricing-adjacent roles are exactly two, both
// through DERIVED percentages — the amounts themselves
// never enter pricing AS amounts (no year is credited the
// return's dollars).
//
// (1) The blank-yield fallback (contract v136, audit MUST
// M-1): a BLANK yield field on the plan means "no yield
// entered", not "no yield income" — pricing it as $0
// understates AGI/MAGI by the household's whole dividend and
// interest income and can flip an ACA cliff decision. So
// where a plan's inputs are assembled for pricing (the
// actions layer's resolveArgsBalances on the server, the
// plan-input constructions in the client), a blank yield
// field is filled with the IMPLIED yield the stored actuals
// describe — that line's actual ÷ the plan's resolved
// taxable pool (see impliedYieldPctsFromTaxReturn below) —
// and the engine then prices that yield through the ordinary
// yield mechanism, exactly as if it had been typed into the
// yield field. Only for a field left blank — an entered
// yield, including an explicit 0%, always prices exactly as
// entered. With no stored actual for a line, a blank yield
// for that line prices $0, as before.
//
// (2) The qualified-dividend share (contract v138, audit
// SHOULD S-1): the plan engine used to price 100% of its
// dividend yield income as QUALIFIED dividends, but a real
// household's distributions are only partly qualified (on a
// stored return, line 3a — the qualified part — is only a
// share of the line 3b total), so pricing it all on the
// preferential stack understated federal tax. Where a plan's inputs are
// assembled for pricing, the QUALIFIED SHARE the stored
// actuals imply — line 3a ÷ line 3b (see
// qualifiedDividendSharePctFromTaxReturn below) — is
// threaded alongside the implied yields, and the engine
// splits each year's dividend income by it: that share
// prices as qualified dividends on the gains stack, the
// rest as non-qualified dividends on the ordinary stack.
// With no stored actuals implying a share, the engine
// prices 100% qualified exactly as before. There is no
// user-facing qualified-share input: the return-derived
// share is the default, per the settlement.
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
//
// Negative actuals (contract v146, re-audit round 3
// NICE-1): a Form 1040 income line cannot be negative, so a
// negative stored amount is not a figure at all — it is a
// mistyped or sign-flipped entry. The ONE parse below
// REJECTS it: the line reads as not entered (null), exactly
// like a line never typed, so it can never surface as a
// negative prefill dollar, and every consumer downstream
// (the prefill mapping, the implied-yield fallback, the
// qualified share) resolves that line by the same rules an
// unentered line follows — a priced year's estimate where
// the plan prices the year, blank where the return itself
// is the source. The rejection is never silent:
// rejectedNegativeTaxReturnActuals reports each rejected
// line and its stored value, and getRothPlanner's
// taxReturn block carries that report to the user (see
// TAX_RETURN_SEMANTICS in apiContractCore.ts).

/* ---------------- Saved tax-return shape ----------------
   The three Form 1040 actuals as stored in the saved plan
   record, plus the calendar year of the return they are from
   (build v147). This is the ONE parse of that stored shape:
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
  // from (build v147) — the most recent filed return.
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
  // An amount is a finite, NON-NEGATIVE number, else null:
  // a negative amount is rejected here (re-audit round 3
  // NICE-1) and reads as "not entered", never as a negative
  // figure — see the header note. $0 is a real entered
  // figure and parses as $0, exactly as before.
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
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

/* ---------------- Rejected negative actuals ----------------
   The report parseRothTaxReturn's rejection produces
   (contract v146, re-audit round 3 NICE-1): one entry per
   amount line whose STORED value is a finite negative
   number — the lines the parse read as not entered because
   a Form 1040 income line cannot be negative. Each entry
   names the line and carries the stored (negative) cents,
   so the user can see exactly which figure was set aside
   and what it said. An empty list means no line was
   rejected — the ordinary case, including a blank or
   absent record. This reads the same raw shape the parse
   reads and applies the same finiteness test, so the two
   can never disagree about which lines were rejected:
   a line is reported here exactly when the parse nulled
   a negative stored value for it. getRothPlanner's
   taxReturn block carries this report (computed in
   readRothBlob in server/src/actions.ts); nothing prices
   from it and nothing writes it back. */
export type TaxReturnActualLine =
  | "interest"
  | "qualifiedDividends"
  | "ordinaryDividends";

export type RejectedNegativeTaxReturnActual = {
  line: TaxReturnActualLine;
  // The rejected stored value, in cents (negative).
  cents: number;
};

export function rejectedNegativeTaxReturnActuals(
  raw: unknown,
): RejectedNegativeTaxReturnActual[] {
  if (raw == null || typeof raw !== "object") return [];
  const r = raw as Record<string, unknown>;
  const out: RejectedNegativeTaxReturnActual[] = [];
  const check = (v: unknown, line: TaxReturnActualLine): void => {
    if (typeof v === "number" && Number.isFinite(v) && v < 0) {
      out.push({ line, cents: v });
    }
  };
  check(r.taxReturnInterestCents, "interest");
  check(r.taxReturnQualifiedDividendsCents, "qualifiedDividends");
  check(r.taxReturnOrdinaryDividendsCents, "ordinaryDividends");
  return out;
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
   which the prefill renders as a blank dial; a negative
   line (rejected at parse — see the header note) maps to
   null the same way, never to a negative dollar. The Playground's
   "Start from my numbers" calls this exact function, and the
   tax suite's tax-return-prefill-mapping fixture pins it, so
   the mapping the user gets is the mapping the fixtures prove. */
export function taxReturnPrefillDollars(stored: RothTaxReturnStored): {
  interest: number | null;
  qualifiedDividends: number | null;
  ordinaryDividends: number | null;
} {
  // A negative cents value maps to null here too, not just
  // at the parse (re-audit round 3 NICE-1): every stored
  // shape reaches this mapping through parseRothTaxReturn,
  // which already rejects negatives, but the mapping is the
  // last step before the dials, so it states the guarantee
  // itself — a negative prefill dollar can never be produced,
  // whatever shape it is handed.
  const dollars = (cents: number | null): number | null =>
    cents == null || cents < 0 ? null : cents / 100;
  return {
    interest: dollars(stored.taxReturnInterestCents),
    qualifiedDividends: dollars(stored.taxReturnQualifiedDividendsCents),
    ordinaryDividends: dollars(stored.taxReturnOrdinaryDividendsCents),
  };
}

/* ---------------- The blank-yield fallback ----------------
   The implied yields the stored actuals describe (contract
   v136, audit MUST M-1): each entered line's actual as a % of
   the taxable pool it was earned on — the plan's resolved
   opening taxable balance, the same base the plan's yield
   fields price on. The dividend yield comes from the line 3b
   TOTAL (ordinary dividends), never the 3a qualified part:
   the engine's dividend income is the whole distribution,
   split between the stacks by the qualified share below
   (contract v138, audit S-1). Each % is rounded to 4 decimal places — the
   precision of the audit's worked figures (the stored
   interest and ordinary-dividend actuals over the pool they
   were earned on imply small percentage yields of that order,
   pricing back to the filed dollars on that pool, within
   rounding). A line the household has not entered (null), a
   negative line, or a pool of $0 or less yields null for that
   side: no estimate exists, and a blank yield field for that
   line keeps pricing $0 exactly as before. The two sides are
   independent — one entered line estimates its own yield
   only. This is the ONE derivation: the actions layer and
   the client's plan-input constructions both call it, so
   every pricing path estimates a blank yield the same way. */
export function impliedYieldPctsFromTaxReturn(
  stored: RothTaxReturnStored,
  taxablePoolDollars: number,
): { dividendYieldPct: number | null; interestYieldPct: number | null } {
  const pool = taxablePoolDollars;
  if (!Number.isFinite(pool) || pool <= 0) {
    return { dividendYieldPct: null, interestYieldPct: null };
  }
  const implied = (cents: number | null): number | null => {
    if (cents == null || !Number.isFinite(cents) || cents < 0) return null;
    const pct = ((cents / 100) / pool) * 100;
    return Math.round(pct * 10000) / 10000;
  };
  return {
    dividendYieldPct: implied(stored.taxReturnOrdinaryDividendsCents),
    interestYieldPct: implied(stored.taxReturnInterestCents),
  };
}

/* ---------------- The qualified-dividend share ----------------
   The share of the household's dividend distributions that
   is QUALIFIED (contract v138, audit SHOULD S-1): line 3a ÷
   line 3b as a percentage, rounded to 4 decimal places —
   the precision of the implied yields above (this
   household's stored return: line 3a ÷ line 3b gives the
   share directly, and applying it to that return's own
   distribution prices exactly its line 3a as qualified). The plan engine splits each
   year's dividend yield income by this share — the share
   prices on the gains stack as qualified dividends, the
   remainder on the ordinary stack as non-qualified
   dividends — instead of pricing the whole distribution as
   qualified, as it did before this build. Either dividend
   line unentered (null), a $0 (or negative) line 3b total,
   or a negative line 3a yields null: no share is implied,
   and the engine keeps its prior behaviour of pricing 100%
   qualified. A line 3a above its line 3b total is an
   impossible pair (the same impossibility the S-8/S-11
   clamp addresses in the single-year pricer) and clamps to
   100%. This is the ONE derivation: the actions layer and
   the client's plan-input constructions both call it, so
   every pricing path splits the yield the same way. */
export function qualifiedDividendSharePctFromTaxReturn(
  stored: RothTaxReturnStored,
): number | null {
  const qualified = stored.taxReturnQualifiedDividendsCents;
  const total = stored.taxReturnOrdinaryDividendsCents;
  if (
    qualified == null ||
    total == null ||
    !Number.isFinite(qualified) ||
    !Number.isFinite(total) ||
    total <= 0 ||
    qualified < 0
  ) {
    return null;
  }
  const pct = Math.min(100, (qualified / total) * 100);
  return Math.round(pct * 10000) / 10000;
}
