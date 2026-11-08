import { z } from "@hatch/space-sdk";
import {
  pricePlaygroundYear,
  solvePlaygroundAcaCliffFill,
  type PlaygroundYearInputs,
} from "./rothOptimizer";
import type { EducationStudent, FilingStatus } from "./taxEngine";
import {
  decideRothBlobWrite,
  parseRothBlobRevision,
} from "./rothRevisionCore";
import { SAMPLE_PRETAX_CENTS } from "./sampleHousehold";

/* ---------------- December projection console ----------------
   A December year-end projection for a household managing MAGI
   against the ACA premium-credit cliff. In December the year's
   income is nearly final: the user enters year-to-date ACTUALS
   (already posted), the December stragglers as low / likely /
   high ranges, and a strays checklist, and the console answers
   ONE headline question — the maximum safe pre-tax draw for
   December, sized to land ACA MAGI at the cliff minus a safety
   buffer (default $5,000).

   NO TAX MATH IS FORKED HERE. Every figure is priced through
   the shipped single-year engine — pricePlaygroundYear, the
   exact function the Playground view and the runPlaygroundYear
   action price with — and the headline draw is solved by the
   shipped solvePlaygroundAcaCliffFill against that engine. A
   pre-tax distribution for spending is taxed identically to a
   conversion dollar-for-dollar in a single year, so the draw
   rides the engine's spending-draw dial (the M-2 split in
   pricePlaygroundYear: the two dials price as one pre-tax
   money-out sum, but only the draw counts as spendable cash —
   a conversion never does). This module only ASSEMBLES the year's income from the
   December pieces (actuals + a range case + stray amounts) into
   Playground dials, and reads the engine's own outputs back.

   Persistence: the console's inputs are one JSON blob in
   settings under DECEMBER_STATE_KEY, encrypted at rest with
   the app's field encryption (build v90, stored-data
   finding F2) — the handlers encrypt the serialized blob on
   save and decrypt on read, dual-reading a legacy plaintext
   record stored before encryption. The blob rides the
   ordinary backup export / restore settings array with no
   extra cases: export decrypts it and restore re-encrypts it
   under the destination key (both keys are on restoreCore's
   encrypted-at-rest list). Nothing in this module reads or
   writes any other view's state, and a fresh (default)
   console prices nothing and changes no existing figure. */

export const DECEMBER_STATE_KEY = "december_projection_v1";

export type DecemberCaseKind = "low" | "likely" | "high";
export const DECEMBER_CASE_KINDS: DecemberCaseKind[] = ["low", "likely", "high"];

/* One stray-checklist item: "na" (does not apply / not present),
   "confirmed" (checked, no amount — e.g. the administrator's
   cutoff date), or "amount" (present, carrying a dollar amount
   that flows into the projection). Amount is dollars; it is
   read only when the status is "amount". */
export const decemberStray = z.object({
  status: z.enum(["na", "confirmed", "amount"]),
  amount: z.number().finite(),
});
export type DecemberStray = z.infer<typeof decemberStray>;

const strayDefault = (): DecemberStray => ({ status: "na", amount: 0 });

/* A low / likely / high range for one remaining-income line. */
export const decemberRange = z.object({
  low: z.number().finite(),
  likely: z.number().finite(),
  high: z.number().finite(),
});
export type DecemberRange = z.infer<typeof decemberRange>;
/* The UNSIGNED variant (build v66, boundary audit F5): the
   remaining interest / dividend / capital-distribution lines
   are income still to come, never signed flows — a negative
   in any of them lowered the projected AGI (and a negative
   capital distribution split into fake stock-sale figures).
   Each point carries the same min(0) the unsigned YTD fields
   in the state schema below already carry, so a crafted save
   refuses. remOtherOrdinary keeps the signed decemberRange —
   it mirrors the signed ytdOtherOrdinary by design. */
export const decemberUnsignedRange = z.object({
  low: z.number().finite().min(0),
  likely: z.number().finite().min(0),
  high: z.number().finite().min(0),
});
const rangeDefault = (): DecemberRange => ({ low: 0, likely: 0, high: 0 });

/* The console's saved inputs — all money in DOLLARS (the
   single-year engine's units), ages in whole years. Every field
   is required in the strict writer schema; the reader below is
   lenient field by field, so a blob written before a field
   existed (or a partial blob) reads at that field's default. */
export const decemberState = z.object({
  taxYear: z.number().int().min(2000).max(2100),
  filingStatus: z.enum(["mfj", "single", "hoh"]),
  agePrimary: z.number().int().min(0).max(120).nullable(),
  ageSpouse: z.number().int().min(0).max(120).nullable(),
  onMedicarePrimary: z.boolean(),
  onMedicareSpouse: z.boolean(),
  // Year-to-date ACTUAL income, already posted.
  ytdOtherOrdinary: z.number().finite(),
  ytdInterest: z.number().finite().min(0),
  ytdOrdinaryDividends: z.number().finite().min(0),
  ytdQualifiedDividends: z.number().finite().min(0),
  ytdTaxExemptInterest: z.number().finite().min(0),
  // Realized capital result so far — SIGNED (negative = a net
  // realized loss), like the engine's own stock gain.
  ytdCapitalGain: z.number().finite(),
  // Cost basis of the sales behind the year's gains
  // (build v127, round-19 finding 4): the basis
  // returned on the sales whose gains feed the total above
  // (year-to-date sales, planned sales, January-paid and
  // K-1 gains that came from sales). A sale's proceeds are
  // its gain PLUS its basis, and the shared engine's
  // cash-in counts the proceeds — so without this field
  // cash-in counted only the gain and silently dropped the
  // basis. NULLABLE, and null and $0 are different facts:
  // null = no input yet (the basis is unknown — the old
  // gain-only mapping stands, and the field's hint says
  // cash left counts only the gains until it is entered);
  // $0 = explicitly no basis (a zero-basis sale). A blob
  // written before this field existed parses a missing key
  // as null and prices exactly as before this build. One of
  // the year-to-date group (internal review round 6,
  // SHOULD-2): a typed figure saves as displayed with the
  // group's edited flag, and an unedited group saves
  // stamp-aware, like a carry-in.
  saleBasis: z.number().finite().min(0).nullable(),
  // Capital-loss carryforward ENTERING this year (contract
  // v111, round-17 fix F1+F2): the banked short-term and
  // long-term losses from prior years still unused as this
  // year begins, in dollars, stated as positive amounts,
  // plus the Washington-attributable portion of each (a
  // portion of that character's total). NULLABLE, and null
  // and $0 are different facts: null = no input yet (the
  // console has not answered — at load, a null field can
  // resolve from the Tax Plan record's entering carryforward
  // when the December year IS the plan's first year, exactly
  // the education overlay's discipline); $0 = explicitly
  // none. A blob written before these fields existed parses
  // a missing key as null and prices exactly as before this
  // build until an amount is entered. When any amount is
  // positive, decemberCaseInputs passes the four through to
  // pricePlaygroundYear, which runs the shared plan loss
  // ledger (applyLossLedger) over the year — no loss math
  // lives here.
  carryInCapitalLossSt: z.number().finite().min(0).nullable(),
  carryInCapitalLossLt: z.number().finite().min(0).nullable(),
  carryInCapitalLossStWa: z.number().finite().min(0).nullable(),
  carryInCapitalLossLtWa: z.number().finite().min(0).nullable(),
  // Gain harvest (build v113, round-17 fix F3): whether
  // the plan's gain-harvest strategy is on for this year,
  // and the taxable-pool facts the harvest sizes itself
  // from — the pool available to sell (the COMBINED taxable
  // pool, Taxable plus Cash, the pool the plan march draws
  // on) and its BLENDED basis % (basis dollars ÷ pool; the
  // march's tier walking moves only its basis step-up
  // bookkeeping between years, never the size, so one
  // blended % carries the sizing). The pool fact is the
  // STARTING pool — the pool as it stood at the start of
  // this year, before the year's own taxable sales:
  // the shared pricer nets the year's sales out of it to
  // size the harvest from what remains (round-17 defect 1;
  // SHOULD-3 moved the netting from decemberCaseInputs
  // into pricePlaygroundYear, so the starting pool passes
  // straight through). S-8 (engines review round 2): the
  // Tax Plan record's pool fact is a CURRENT pool (the pool
  // as it stands when read — after the year's sales have
  // already shrunk it), so load
  // resolution CONVERTS the record fact to the starting
  // pool, adding the year's year-to-date sale and taxable
  // cash back, before it fills a null console fact (see
  // resolveDecemberStateAtLoad); the console field asks
  // for the starting pool in the same words. harvestOn defaults OFF:
  // a blob written before these fields existed parses them
  // off / null and prices exactly as before this build.
  // The two facts are NULLABLE: null = no input yet (at
  // load, a null fact resolves from the Tax Plan record's
  // taxable facts — its taxable balance and its basis % or
  // tier blend — under the same overlay discipline as the
  // carry-in: entered values always win, record facts fill
  // nulls, and an unedited save persists the stored value).
  // Harvest ON with either fact still null after resolution
  // cannot be priced: the projection then prices NO harvest
  // and carries the gain-harvest-unpriced qualification on
  // every case (and a warning), never a silent $0.
  harvestOn: z.boolean(),
  harvestPoolAmount: z.number().finite().min(0).nullable(),
  harvestPoolBasisPct: z.number().finite().min(0).max(100).nullable(),
  // Taxable cash for the year (build v125): cash taken
  // from taxable at 100% basis for the year — the
  // operating model's "tax from taxable (100%-basis cash
  // first)". It adds $0 to MAGI (a 100%-basis sale realizes
  // no gain), so it uses no MAGI room and the cliff
  // solver's answer — the maximum safe pre-tax draw — is
  // INVARIANT to it: the draw is sized by MAGI room, and
  // this amount is a cash quantity, not a MAGI quantity.
  // The harvest precedent is the same rule in the other
  // direction: the harvest (a gain) shrinks the draw by the
  // harvested gain because it ADDS MAGI; a $0-MAGI item
  // moves the draw by $0. So the amount is additional cash
  // ON TOP of the draw, not part of it — it raises cash-in
  // and cash-left dollar for dollar (see
  // computeDecemberProjection) while the pre-tax draw,
  // MAGI, credit, tax, and settlement are unchanged. A
  // blob written before this field existed parses a missing
  // key as null and prices exactly as before this build.
  // NULLABLE: null = no input yet, $0 = explicitly none.
  // One of the year-to-date group (internal review round 6,
  // SHOULD-2): a typed figure saves as displayed with the
  // group's edited flag, and an unedited group saves
  // stamp-aware, like a carry-in.
  taxableFunded: z.number().finite().min(0).nullable(),
  ytdSsPrimary: z.number().finite().min(0),
  ytdSsSpouse: z.number().finite().min(0),
  // Remaining expected income (December stragglers), per line.
  // The four unsigned lines use decemberUnsignedRange (v66,
  // F5); remOtherOrdinary stays signed by design.
  remCapDist: decemberUnsignedRange,
  remInterest: decemberUnsignedRange,
  remOrdinaryDividends: decemberUnsignedRange,
  remQualifiedDividends: decemberUnsignedRange,
  remOtherOrdinary: decemberRange,
  // ACA block.
  acaHouseholdSize: z.number().int().min(1).max(20).nullable(),
  acaBenchmarkAnnual: z.number().finite().min(0).nullable(),
  // The premium of the plan the household is actually
  // enrolled in (annual). Null = blank = NO enrollment-
  // premium cap (the pre-fix behaviour); when entered, each
  // case's final allowable credit is capped at this premium
  // (Form 8962's lesser-of) before any coverage-month
  // reduction.
  acaEnrollmentPremiumAnnual: z.number().finite().min(0).nullable(),
  aptcTaken: z.number().finite().min(0),
  bufferDollars: z.number().finite().min(0),
  // Pricing context (the same dials the Playground carries).
  // pretaxBalance is the LEGACY combined balance: when a
  // blob carries no split its ownership is unanswered and
  // load resolution allocates THIS total across the
  // owners by the Tax Plan record split's proportions
  // when both owners are known, or by the single known
  // owner's amount capped at this total when exactly one
  // is known (combined→primary as the last-resort
  // fallback when the record has no usable split — see
  // parseDecemberState / resolveDecemberStateAtLoad);
  // writers keep it as the split's sum when a split is
  // explicit, so old and new blobs both read.
  pretaxBalance: z.number().finite().min(0).nullable(),
  // Per-owner prior-Dec-31 pre-tax balances (December fix):
  // each owner's RMD is computed on their own clock from
  // their own balance. Null = not entered for that owner.
  pretaxBalancePrimary: z.number().finite().min(0).nullable(),
  pretaxBalanceSpouse: z.number().finite().min(0).nullable(),
  // Round-5 provenance: true only when the split above was
  // actually entered (in this console, or carried in a blob
  // whose split keys hold amounts). A blob carrying ONLY
  // the legacy combined pretaxBalance parses with this
  // false — ownership UNANSWERED — so load resolution can
  // allocate the combined total by the Tax Plan record
  // split's proportions (or by a single known owner amount
  // capped at the total when exactly one is known),
  // falling back to the combined→primary assignment only
  // when the record has no usable split. Derived on read
  // by parseDecemberState; never a user-entered fact.
  pretaxSplitExplicit: z.boolean(),
  // The part of this year's RMD already received (and
  // already inside the year-to-date income above): netted
  // from the computed RMD, floored at $0, so a paid RMD is
  // never counted twice.
  rmdAlreadyReceived: z.number().finite().min(0),
  spouseSoleBeneficiary: z.boolean(),
  // The SECOND beneficiary fact (round-3 fix; tri-state
  // since the round-4 fix): the primary is the sole
  // beneficiary of the SPOUSE's pre-tax accounts. A
  // separate fact from spouseSoleBeneficiary above (the
  // spouse is the PRIMARY's sole beneficiary — it selects
  // only the PRIMARY's RMD table). This fact alone
  // selects the SPOUSE's RMD table. TRI-STATE, matching
  // the Tax Plan record's semantics: true / false are
  // explicit answers; null = UNANSWERED. Only explicit
  // true selects the Joint table — null and false both
  // price her RMD on the Uniform Lifetime Table (not
  // established, the conservative direction). Blobs
  // written before this field existed parse a missing
  // key as null, never as false, so an unanswered
  // console value can be resolved at load from the Tax
  // Plan record (see resolveDecemberStateAtLoad and
  // parseDecemberState).
  primarySoleBeneficiaryOfSpouse: z.boolean().nullable(),
  stateRatePct: z.number().finite().min(0).max(100),
  residenceState: z.enum(["WA", "other"]),
  itemizedMortgageInterest: z.number().finite().min(0),
  itemizedSaltPaid: z.number().finite().min(0),
  itemizedCharitable: z.number().finite().min(0),
  itemizedOther: z.number().finite().min(0),
  // Education credits (build v103, round-14 fix F3):
  // the December tax year's per-student qualified
  // education expenses, in the SAME shape the Playground
  // prices — each entry is one student's qualified
  // expenses in dollars plus the household's own
  // aotcEligible mark (entered, never inferred from 529
  // balances, the college-years span, or any other saved
  // field). The shared priceYear education step
  // (educationCreditsFor in taxEngine) is the only credit
  // math; this field only carries the entered students
  // into it. Null = no education input yet (a blob written
  // before this field existed parses a missing key as
  // null): no students are priced, the credits are $0,
  // and the year prices exactly as before this build —
  // with the settlement carrying the visible
  // excludes-education-credits qualification instead of
  // presenting itself as final. An empty list is an
  // entered answer (the household entered, then cleared,
  // its students) and likewise prices $0 of credits.
  educationStudents: z
    .array(
      z.object({
        expenses: z.number().finite().min(0),
        aotcEligible: z.boolean(),
      }),
    )
    .max(12)
    .nullable(),
  // Strays checklist (household-neutral wording in the view).
  strayCapDist: decemberStray,
  strayK1: decemberStray,
  // The long-term-capital-gain PORTION of the K-1 stray's
  // total (build v112, round-17 fix F4): Schedule K-1
  // box 9a reports the part of a partnership / S-corp /
  // trust allocation that is a net long-term capital gain,
  // and that part keeps its long-term character on the
  // partner's return — it is taxed at the capital-gains
  // rates, not as ordinary income. Like the January-paid
  // splits (v104) it is a portion of the total, never an
  // amount on top of it: the assembly clamps it to the
  // K-1 total (a signed total — the portion applies only
  // to a positive K-1 amount; a deductible K-1 loss has
  // no gain portion), rides it on the long-term-gains
  // stack, and removes it from ordinary income, so no
  // dollar is counted twice. A blob written before this
  // field existed parses a missing key as $0 — the whole
  // K-1 amount then rides ordinary income exactly as
  // before this build.
  strayK1CapGainAmount: z.number().finite().min(0),
  strayTaxExempt: decemberStray,
  strayDependent: decemberStray,
  straySeverance: decemberStray,
  strayLossHarvest: decemberStray,
  strayCutoff: decemberStray,
  // Settled adversarial-review additions (2026-10-26): every
  // field below is read leniently like the original seven, so
  // a blob saved before they existed reads them at the inert
  // default and rides the same backup / restore settings blob.
  strayJanPaid: decemberStray,
  // The qualified-dividends PORTION of the January-paid
  // stray's total (mirrors the year-to-date dividend pair:
  // a portion of the total, never an amount on top of it;
  // the assembly clamps it to the stray's total).
  strayJanPaidQualifiedAmount: z.number().finite().min(0),
  // The capital-gain-distribution PORTION of the
  // January-paid stray's total (build v104, round-14
  // fix F5): a distribution the fund designates as a
  // capital gain dividend is treated as a long-term
  // capital gain (§852(b)(3)), not as an ordinary
  // dividend, even when §852(b)(7) deems it received on
  // December 31 because it was declared in October–
  // December and paid in January. Like the qualified
  // portion above it is a portion of the total, never an
  // amount on top of it: the assembly clamps it to the
  // total, rides it on the gains stack (the same
  // totalGain → stockSold/stockBasis → ltcg path the
  // capital-distribution ranges and stray use), and
  // removes it from ordinary dividends, so the qualified
  // split applies to the ordinary remainder only. A blob
  // written before this field existed parses a missing
  // key as $0 — the whole January-paid total then rides
  // ordinary dividends exactly as before this build.
  strayJanPaidCapGainAmount: z.number().finite().min(0),
  strayDivInt: decemberStray,
  strayPlannedSales: decemberStray,
  // Return of capital, split by tax character (December
  // fix): strayROC is the CAPITAL part (income over basis —
  // a capital gain, the pre-fix routing, so a legacy blob's
  // amount keeps its meaning), and strayROCOrdinary is the
  // part reclassified as an ordinary dividend, which rides
  // the ordinary-dividends total instead of the gains stack.
  strayROC: decemberStray,
  strayROCOrdinary: decemberStray,
  // The qualified-dividends PORTION of the reclassified
  // return-of-capital amount (build v112, round-17
  // fix F5): a dividend reclassified out of return of
  // capital can itself be a qualified dividend (Form
  // 1099-DIV box 1b, a subset of the box 1a ordinary
  // total), and that part is taxed at the preferential
  // qualified-dividend rates, not as ordinary income.
  // Like the January-paid qualified companion (v104) it
  // is a portion of the ordinary total, never an amount
  // on top of it: the assembly clamps it to the
  // strayROCOrdinary total and adds it to the qualified-
  // dividends total, while the whole ordinary amount
  // stays in ordinary dividends (qualified is a subset),
  // so no dollar is counted twice. A blob written before
  // this field existed parses a missing key as $0 — the
  // whole reclassified amount then prices as a
  // non-qualified ordinary dividend exactly as before
  // this build.
  strayROCQualifiedAmount: z.number().finite().min(0),
  strayAgiReducers: decemberStray,
  strayCoverage: decemberStray,
  strayTradeDate: decemberStray,
  // Round-5 provenance flags (never entered; format-3
  // blobs carry them as stored, pre-format-3 blobs derive
  // them on read — see parseDecemberState): true when a
  // legacy amount predates its tax-character split —
  // strayROC holds an amount and its ordinary split is
  // absent or still at its default, or strayJanPaid
  // holds an amount and its qualified portion is absent
  // or still $0. The flags change NO pricing (the entered
  // split values govern exactly as before); they drive a
  // view note and a projection warning so the user
  // confirms the split. A flag clears ONLY when the user
  // edits the matching character control (round-6) — an
  // unrelated save no longer clears it.
  legacyRocSplitUnconfirmed: z.boolean(),
  legacyJanPaidSplitUnconfirmed: z.boolean(),
  // Round-6 provenance flag (never entered; format-3
  // blobs carry it as stored, pre-marker blobs derive it
  // on read — see parseDecemberState): raised when the
  // stored primarySoleBeneficiaryOfSpouse: false came
  // from a blob WITHOUT the state-format marker — such a
  // false is ambiguous (v47's machine-written default vs
  // a deliberate v48 No), so the answer STANDS as answered
  // false (a stored console answer always outranks the
  // Tax Plan record overlay) and the flag asks the user
  // to confirm it. The flag clears only when the user
  // changes the beneficiary control.
  legacyBeneficiaryAnswerUnconfirmed: z.boolean(),
});
export type DecemberState = z.infer<typeof decemberState>;

export function defaultDecemberState(currentYear: number): DecemberState {
  return {
    taxYear: currentYear,
    filingStatus: "mfj",
    agePrimary: null,
    ageSpouse: null,
    onMedicarePrimary: false,
    onMedicareSpouse: false,
    ytdOtherOrdinary: 0,
    ytdInterest: 0,
    ytdOrdinaryDividends: 0,
    ytdQualifiedDividends: 0,
    ytdTaxExemptInterest: 0,
    ytdCapitalGain: 0,
    saleBasis: null,
    carryInCapitalLossSt: null,
    carryInCapitalLossLt: null,
    carryInCapitalLossStWa: null,
    carryInCapitalLossLtWa: null,
    harvestOn: false,
    harvestPoolAmount: null,
    harvestPoolBasisPct: null,
    taxableFunded: null,
    ytdSsPrimary: 0,
    ytdSsSpouse: 0,
    remCapDist: rangeDefault(),
    remInterest: rangeDefault(),
    remOrdinaryDividends: rangeDefault(),
    remQualifiedDividends: rangeDefault(),
    remOtherOrdinary: rangeDefault(),
    acaHouseholdSize: null,
    acaBenchmarkAnnual: null,
    acaEnrollmentPremiumAnnual: null,
    aptcTaken: 0,
    bufferDollars: 5000,
    pretaxBalance: null,
    pretaxBalancePrimary: null,
    pretaxBalanceSpouse: null,
    pretaxSplitExplicit: false,
    rmdAlreadyReceived: 0,
    spouseSoleBeneficiary: true,
    primarySoleBeneficiaryOfSpouse: null,
    stateRatePct: 0,
    residenceState: "other",
    itemizedMortgageInterest: 0,
    itemizedSaltPaid: 0,
    itemizedCharitable: 0,
    itemizedOther: 0,
    educationStudents: null,
    strayCapDist: strayDefault(),
    strayK1: strayDefault(),
    strayK1CapGainAmount: 0,
    strayTaxExempt: strayDefault(),
    strayDependent: strayDefault(),
    straySeverance: strayDefault(),
    strayLossHarvest: strayDefault(),
    strayCutoff: strayDefault(),
    strayJanPaid: strayDefault(),
    strayJanPaidQualifiedAmount: 0,
    strayJanPaidCapGainAmount: 0,
    strayDivInt: strayDefault(),
    strayPlannedSales: strayDefault(),
    strayROC: strayDefault(),
    strayROCOrdinary: strayDefault(),
    strayROCQualifiedAmount: 0,
    strayAgiReducers: strayDefault(),
    strayCoverage: strayDefault(),
    strayTradeDate: strayDefault(),
    legacyRocSplitUnconfirmed: false,
    legacyJanPaidSplitUnconfirmed: false,
    legacyBeneficiaryAnswerUnconfirmed: false,
  };
}

/* Lenient read, field by field, in the Roth UI-state reader's
   style: any field of the wrong type or out of range falls back
   to its default, so a partial or malformed blob can never
   break the console — it just opens closer to blank. */
/* Result-honesty (build v67, F09): whether a PRESENT stored
   December blob cannot be parsed as a state document at all —
   malformed JSON, or JSON that is not a plain object. The lenient
   field-by-field parse above silently defaults in exactly these
   cases, so without this flag a damaged record was
   indistinguishable from a fresh one even though hasStored
   reported true. An absent blob (undefined) is NOT unparseable,
   and a parseable object with individual bad fields is NOT
   unparseable either (those fields still default leniently, as
   before). The get action surfaces this as storedUnreadable and
   the save action refuses to build on an unparseable read. */
export function isDecemberStateUnparseable(
  raw: string | undefined,
): boolean {
  if (raw === undefined) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return true;
  }
  return parsed == null || typeof parsed !== "object" || Array.isArray(parsed);
}

export function parseDecemberState(
  raw: string | undefined,
  currentYear: number,
): DecemberState {
  const out = defaultDecemberState(currentYear);
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  const p = parsed as Record<string, unknown>;
  // State-format marker: serializeDecemberState writes
  // `decemberStateFormat` beside the state fields. A blob
  // WITHOUT it is pre-marker (legacy) format. The numeric
  // value drives the provenance derivations below: format
  // 3 blobs carry the provenance flags as stored
  // (authoritative); older blobs derive them.
  const stateFormat =
    typeof p.decemberStateFormat === "number" &&
    Number.isFinite(p.decemberStateFormat)
      ? p.decemberStateFormat
      : null;
  const hasStateFormatMarker = stateFormat != null;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const nonNeg = (key: string, set: (n: number) => void) => {
    const n = num(p[key]);
    if (n != null && n >= 0) set(n);
  };
  const signed = (key: string, set: (n: number) => void) => {
    const n = num(p[key]);
    if (n != null) set(n);
  };
  const ageOrNull = (key: string, set: (n: number | null) => void) => {
    if (p[key] === null) return; // the default is already null
    const n = num(p[key]);
    if (n != null && Number.isInteger(n) && n >= 0 && n <= 120) set(n);
  };
  const range = (key: string, set: (r: DecemberRange) => void) => {
    const v = p[key];
    if (v == null || typeof v !== "object" || Array.isArray(v)) return;
    const r = v as Record<string, unknown>;
    const low = num(r.low);
    const likely = num(r.likely);
    const high = num(r.high);
    if (low != null && likely != null && high != null) set({ low, likely, high });
  };
  const stray = (key: string, set: (s: DecemberStray) => void) => {
    const v = p[key];
    if (v == null || typeof v !== "object" || Array.isArray(v)) return;
    const s = v as Record<string, unknown>;
    if (s.status !== "na" && s.status !== "confirmed" && s.status !== "amount") return;
    const amount = num(s.amount);
    set({ status: s.status, amount: amount ?? 0 });
  };
  const ty = num(p.taxYear);
  if (ty != null && Number.isInteger(ty) && ty >= 2000 && ty <= 2100) out.taxYear = ty;
  if (p.filingStatus === "mfj" || p.filingStatus === "single" || p.filingStatus === "hoh") {
    out.filingStatus = p.filingStatus;
  }
  ageOrNull("agePrimary", (n) => (out.agePrimary = n));
  ageOrNull("ageSpouse", (n) => (out.ageSpouse = n));
  if (typeof p.onMedicarePrimary === "boolean") out.onMedicarePrimary = p.onMedicarePrimary;
  if (typeof p.onMedicareSpouse === "boolean") out.onMedicareSpouse = p.onMedicareSpouse;
  signed("ytdOtherOrdinary", (n) => (out.ytdOtherOrdinary = n));
  nonNeg("ytdInterest", (n) => (out.ytdInterest = n));
  nonNeg("ytdOrdinaryDividends", (n) => (out.ytdOrdinaryDividends = n));
  nonNeg("ytdQualifiedDividends", (n) => (out.ytdQualifiedDividends = n));
  nonNeg("ytdTaxExemptInterest", (n) => (out.ytdTaxExemptInterest = n));
  signed("ytdCapitalGain", (n) => (out.ytdCapitalGain = n));
  nonNeg("ytdSsPrimary", (n) => (out.ytdSsPrimary = n));
  nonNeg("ytdSsSpouse", (n) => (out.ytdSsSpouse = n));
  range("remCapDist", (r) => (out.remCapDist = r));
  range("remInterest", (r) => (out.remInterest = r));
  range("remOrdinaryDividends", (r) => (out.remOrdinaryDividends = r));
  range("remQualifiedDividends", (r) => (out.remQualifiedDividends = r));
  range("remOtherOrdinary", (r) => (out.remOtherOrdinary = r));
  if (p.acaHouseholdSize === null) {
    out.acaHouseholdSize = null;
  } else {
    const n = num(p.acaHouseholdSize);
    if (n != null && Number.isInteger(n) && n >= 1 && n <= 20) out.acaHouseholdSize = n;
  }
  if (p.acaBenchmarkAnnual === null) {
    out.acaBenchmarkAnnual = null;
  } else {
    nonNeg("acaBenchmarkAnnual", (n) => (out.acaBenchmarkAnnual = n));
  }
  if (p.acaEnrollmentPremiumAnnual === null) {
    out.acaEnrollmentPremiumAnnual = null;
  } else {
    nonNeg(
      "acaEnrollmentPremiumAnnual",
      (n) => (out.acaEnrollmentPremiumAnnual = n),
    );
  }
  nonNeg("aptcTaken", (n) => (out.aptcTaken = n));
  nonNeg("bufferDollars", (n) => (out.bufferDollars = n));
  // Pre-tax balances, split by owner (December fix), with
  // round-5 ownership provenance. A blob whose split keys
  // hold an amount for either owner carries an EXPLICIT
  // split: it reads as written and governs over any Tax
  // Plan record split, and the combined field re-derives
  // as the split's sum. A blob carrying ONLY the legacy
  // combined pretaxBalance has ownership UNANSWERED
  // (pretaxSplitExplicit false, split fields null, the
  // combined amount preserved): the parser does NOT assign
  // it to the primary, because the correct owner may be
  // known to the Tax Plan record — load resolution
  // (resolveDecemberStateAtLoad) supplies the record's
  // split when it has one, and only when neither blob nor
  // record has a split falls back to the historical
  // combined→primary assignment. An un-resolved legacy
  // state still prices the combined amount on the primary
  // dial through decemberCaseInputs (its pre-split
  // behaviour), so parsing alone never moves a figure.
  const nullableNonNeg = (
    key: string,
  ): { seen: boolean; value: number | null } => {
    if (!(key in p)) return { seen: false, value: null };
    if (p[key] === null) return { seen: true, value: null };
    const n = num(p[key]);
    return n != null && n >= 0
      ? { seen: true, value: n }
      : { seen: false, value: null };
  };
  const splitPrimary = nullableNonNeg("pretaxBalancePrimary");
  const splitSpouse = nullableNonNeg("pretaxBalanceSpouse");
  const legacyPretax = nullableNonNeg("pretaxBalance");
  const splitHasAmount = splitPrimary.value != null || splitSpouse.value != null;
  if (splitHasAmount) {
    out.pretaxSplitExplicit = true;
    out.pretaxBalancePrimary = splitPrimary.value;
    out.pretaxBalanceSpouse = splitSpouse.value;
    out.pretaxBalance = r2(
      (splitPrimary.value ?? 0) + (splitSpouse.value ?? 0),
    );
  } else if (legacyPretax.value != null) {
    out.pretaxSplitExplicit = false;
    out.pretaxBalancePrimary = null;
    out.pretaxBalanceSpouse = null;
    out.pretaxBalance = legacyPretax.value;
  } else {
    out.pretaxSplitExplicit = false;
    out.pretaxBalancePrimary = splitPrimary.value;
    out.pretaxBalanceSpouse = splitSpouse.value;
    out.pretaxBalance = legacyPretax.value;
  }
  // Entering capital-loss carryforward (v111): nullable
  // like the balances — a missing key (every blob written
  // before these fields existed) and an explicit null both
  // read as NO INPUT YET (null, the default above), an
  // entered amount (including an explicit $0) reads as
  // written, so a pre-v111 blob prices exactly as it did.
  const ciSt = nullableNonNeg("carryInCapitalLossSt");
  if (ciSt.seen) out.carryInCapitalLossSt = ciSt.value;
  const ciLt = nullableNonNeg("carryInCapitalLossLt");
  if (ciLt.seen) out.carryInCapitalLossLt = ciLt.value;
  const ciStWa = nullableNonNeg("carryInCapitalLossStWa");
  if (ciStWa.seen) out.carryInCapitalLossStWa = ciStWa.value;
  const ciLtWa = nullableNonNeg("carryInCapitalLossLtWa");
  if (ciLtWa.seen) out.carryInCapitalLossLtWa = ciLtWa.value;
  const sb = nullableNonNeg("saleBasis");
  if (sb.seen) out.saleBasis = sb.value;
  // Gain harvest (v113): the toggle reads as a plain
  // boolean (absent = off, the default above); the two
  // facts are nullable like the carry-in — a missing key
  // (every blob written before these fields existed) and
  // an explicit null both read as NO INPUT YET, an entered
  // amount (including an explicit $0 pool or a 100% basis)
  // reads as written, so a pre-v113 blob prices exactly as
  // it did. The basis % additionally refuses a value above
  // 100 (out of range reads as no input, leniently).
  if (typeof p.harvestOn === "boolean") out.harvestOn = p.harvestOn;
  const hvPool = nullableNonNeg("harvestPoolAmount");
  if (hvPool.seen) out.harvestPoolAmount = hvPool.value;
  const hvBasis = nullableNonNeg("harvestPoolBasisPct");
  if (hvBasis.seen && (hvBasis.value == null || hvBasis.value <= 100)) {
    out.harvestPoolBasisPct = hvBasis.value;
  }
  // Taxable cash for the year (build v125): nullable
  // like the harvest facts — a missing key (every blob
  // written before this field existed) and an explicit null
  // both read as NO INPUT YET, an entered amount (including
  // an explicit $0) reads as written, so a pre-v125 blob
  // prices exactly as it did.
  const txFunded = nullableNonNeg("taxableFunded");
  if (txFunded.seen) out.taxableFunded = txFunded.value;
  nonNeg("rmdAlreadyReceived", (n) => (out.rmdAlreadyReceived = n));
  if (typeof p.spouseSoleBeneficiary === "boolean") {
    out.spouseSoleBeneficiary = p.spouseSoleBeneficiary;
  }
  // The second beneficiary fact (round-4 tri-state,
  // round-6 marker rule): an explicit boolean parses AS
  // WRITTEN regardless of the marker — true stays true,
  // false becomes ANSWERED false. An explicit null and a
  // MISSING key both read as null — UNANSWERED, never as
  // false. A pre-round-3 blob has no answer to this
  // question, and converting that absence into an
  // explicit false would block the load-time Tax Plan
  // prefill that can supply a known answer
  // (resolveDecemberStateAtLoad). No reciprocity is ever
  // inferred from the sibling fact's value.
  // PRE-MARKER FALSE (round-6 fix 1): a blob without the
  // format marker may carry a false that v47 wrote on
  // the user's behalf — at 410a63f the parser and default
  // state materialised the missing key as false and any
  // in-window autosave persisted it — but it may equally
  // be a deliberate v48 No, and the two cannot be told
  // apart. The round-6 rule: the stored false STANDS as
  // an answered false (a stored console answer always
  // outranks the Tax Plan record overlay, so the resolver
  // never sees it as unanswered), and the ambiguity is
  // carried by legacyBeneficiaryAnswerUnconfirmed below,
  // which asks the user to confirm the answer.
  if (typeof p.primarySoleBeneficiaryOfSpouse === "boolean") {
    out.primarySoleBeneficiaryOfSpouse = p.primarySoleBeneficiaryOfSpouse;
  } else if (p.primarySoleBeneficiaryOfSpouse === null) {
    out.primarySoleBeneficiaryOfSpouse = null;
  }
  // Beneficiary-answer provenance flag (round-6):
  // (a) format >= 3: the flag is authoritative from the
  // blob — it reads as stored, and only ever rides an
  // answered false; (b) no marker (pre-marker blob): any
  // answered false is ambiguous, so the flag follows the
  // parsed value; (c) marker present below 3 (format 2):
  // a stored false there was already a genuine answer
  // under the round-5 rule — no flag.
  if (stateFormat != null && stateFormat >= 3) {
    out.legacyBeneficiaryAnswerUnconfirmed =
      p.legacyBeneficiaryAnswerUnconfirmed === true &&
      out.primarySoleBeneficiaryOfSpouse === false;
  } else if (!hasStateFormatMarker) {
    out.legacyBeneficiaryAnswerUnconfirmed =
      out.primarySoleBeneficiaryOfSpouse === false;
  } else {
    out.legacyBeneficiaryAnswerUnconfirmed = false;
  }
  const sr = num(p.stateRatePct);
  if (sr != null && sr >= 0 && sr <= 100) out.stateRatePct = sr;
  if (p.residenceState === "WA" || p.residenceState === "other") {
    out.residenceState = p.residenceState;
  }
  nonNeg("itemizedMortgageInterest", (n) => (out.itemizedMortgageInterest = n));
  nonNeg("itemizedSaltPaid", (n) => (out.itemizedSaltPaid = n));
  nonNeg("itemizedCharitable", (n) => (out.itemizedCharitable = n));
  nonNeg("itemizedOther", (n) => (out.itemizedOther = n));
  // Education students (v103): a missing key or an explicit
  // null reads as NO INPUT YET (null — the default above);
  // an array reads as entered, entry by entry, keeping only
  // well-formed entries (finite non-negative expenses and a
  // boolean mark), capped at the schema's 12 — so a blob
  // written before this field existed prices exactly as it
  // did, and a stored list round-trips intact.
  if (Array.isArray(p.educationStudents)) {
    const rows: EducationStudent[] = [];
    for (const rawRow of p.educationStudents as unknown[]) {
      if (rawRow == null || typeof rawRow !== "object" || Array.isArray(rawRow)) continue;
      const row = rawRow as Record<string, unknown>;
      const expenses = num(row.expenses);
      if (expenses == null || expenses < 0 || typeof row.aotcEligible !== "boolean") continue;
      rows.push({ expenses, aotcEligible: row.aotcEligible });
      if (rows.length >= 12) break;
    }
    out.educationStudents = rows;
  }
  stray("strayCapDist", (s) => (out.strayCapDist = s));
  stray("strayK1", (s) => (out.strayK1 = s));
  // K-1 capital-gain portion (v112): a missing key (every
  // blob written before this field existed) reads as the
  // inert $0 default above, so the K-1 total prices
  // exactly as it did before this build.
  nonNeg(
    "strayK1CapGainAmount",
    (n) => (out.strayK1CapGainAmount = n),
  );
  stray("strayTaxExempt", (s) => (out.strayTaxExempt = s));
  stray("strayDependent", (s) => (out.strayDependent = s));
  stray("straySeverance", (s) => (out.straySeverance = s));
  stray("strayLossHarvest", (s) => (out.strayLossHarvest = s));
  stray("strayCutoff", (s) => (out.strayCutoff = s));
  stray("strayJanPaid", (s) => (out.strayJanPaid = s));
  nonNeg(
    "strayJanPaidQualifiedAmount",
    (n) => (out.strayJanPaidQualifiedAmount = n),
  );
  // Capital-gain portion (v104): a missing key (every blob
  // written before this field existed) reads as the inert
  // $0 default above, so the January-paid total prices
  // exactly as it did before this build.
  nonNeg(
    "strayJanPaidCapGainAmount",
    (n) => (out.strayJanPaidCapGainAmount = n),
  );
  stray("strayDivInt", (s) => (out.strayDivInt = s));
  stray("strayPlannedSales", (s) => (out.strayPlannedSales = s));
  stray("strayROC", (s) => (out.strayROC = s));
  stray("strayROCOrdinary", (s) => (out.strayROCOrdinary = s));
  // ROC qualified portion (v112): a missing key reads as
  // the inert $0 default above, so the reclassified
  // amount prices exactly as it did before this build.
  nonNeg(
    "strayROCQualifiedAmount",
    (n) => (out.strayROCQualifiedAmount = n),
  );
  stray("strayAgiReducers", (s) => (out.strayAgiReducers = s));
  stray("strayCoverage", (s) => (out.strayCoverage = s));
  stray("strayTradeDate", (s) => (out.strayTradeDate = s));
  // Character-provenance flags (round-5, round-6 rule):
  // (a) format >= 3 blobs carry the flags AS STORED —
  // they are authoritative, because a format-3 save only
  // ever clears a flag when its own control was edited
  // (decemberStateForSave). (b) Pre-format-3 blobs DERIVE
  // them: a legacy amount whose split key is absent
  // predates the split, and a split still AT ITS DEFAULT
  // in an old blob is indistinguishable from a default an
  // old serializer wrote without the user ever confirming
  // the character (the v48 round-trip wrote both split
  // keys at their defaults) — either way the amount's tax
  // character was never stated under the split's terms.
  // A NON-default split value in an old blob counts as
  // deliberate entry — no flag. Accepted false positive:
  // a genuine "$0 of it is ordinary" entry
  // ({ status: "amount", amount: 0 }) still raises the
  // ROC flag until the control is re-touched, because a
  // default-valued split (amount $0 — the default split
  // is { status: "na", amount: 0 }) cannot be
  // distinguished from a serializer-written default.
  if (stateFormat != null && stateFormat >= 3) {
    out.legacyRocSplitUnconfirmed =
      p.legacyRocSplitUnconfirmed === true;
    out.legacyJanPaidSplitUnconfirmed =
      p.legacyJanPaidSplitUnconfirmed === true;
  } else {
    out.legacyRocSplitUnconfirmed =
      strayAmount(out.strayROC) > 0 &&
      (!("strayROCOrdinary" in p) ||
        out.strayROCOrdinary.amount === 0);
    out.legacyJanPaidSplitUnconfirmed =
      strayAmount(out.strayJanPaid) > 0 &&
      (!("strayJanPaidQualifiedAmount" in p) ||
        out.strayJanPaidQualifiedAmount === 0);
  }
  return out;
}

/* The Tax Plan record facts load resolution may draw
   on, in December units (dollars). Every field optional:
   absent / null = the record does not answer. */
export type DecemberRecordFacts = {
  primarySoleBeneficiaryOfSpouse?: boolean | null;
  pretaxBalancePrimary?: number | null;
  pretaxBalanceSpouse?: number | null;
  // The Tax Plan record's entered education students FOR
  // the December tax year, already converted to December
  // units (dollars, the Playground shape — the record's
  // own per-year cents entries filtered to this year).
  // Absent / null = the record does not answer.
  educationStudents?: EducationStudent[] | null;
  // The Tax Plan record's entering capital-loss
  // carryforward (v111), in dollars: the record's
  // capitalLossCarryIn* Cents converted. That balance is
  // the loss entering the plan's FIRST year, so it answers
  // the December console for that year ONLY. The plan
  // march consumes the balance year by year — each year's
  // gains absorb it and the used part of each year's
  // $3,000 allowance spends it — so for any later December
  // year the entering balance is the march's remainder
  // after the intervening years, strictly less than the
  // first-year balance whenever those years had gains or
  // taxable income; the record does not carry that
  // remainder, so it does not answer a later year (the
  // console's own entered values govern there). Build
  // v127 (round-19 finding 3) widened this gate to every
  // later year, re-applying the FULL first-year balance
  // to each of them — double-counting what the march had
  // already consumed, in the non-conservative direction
  // (engines review round 2, finding M-3, settled STAND);
  // this build restores the first-year-only gate. It does
  // NOT answer a year BEFORE the plan's first year either
  // (the loss had not entered the plan yet). planFirstYear
  // is that first year (the record's execution year).
  // Absent / null per field = the record does not answer
  // that field.
  carryInCapitalLossSt?: number | null;
  carryInCapitalLossLt?: number | null;
  carryInCapitalLossStWa?: number | null;
  carryInCapitalLossLtWa?: number | null;
  planFirstYear?: number | null;
  // The Tax Plan record's taxable-pool facts (v113), in
  // dollars / percent: the record's taxable pool (its
  // entered taxable balance, or the snapshot-followed
  // Taxable + Cash pool less any exclude-from-plan amount —
  // the pool resolvePlanBalances assembles for the march)
  // and its basis: the record's entered basis %, or the
  // blended % of its basis tiers (Σ share × basis ÷ Σ
  // share) when it carries tiers. A record whose basis is
  // BLANK (no % and no tiers — the march's harvest is inert
  // there too) does not answer the basis fact. Absent /
  // null per field = the record does not answer. Unlike
  // the carry-in these are balance facts, not entering-year
  // balances, so resolution is NOT gated on the plan's
  // first year. S-8 (engines review round 2): these facts
  // state the pool AS IT STANDS when the record is read —
  // a CURRENT pool, already shrunk by any of the December
  // year's sales that have happened — while the console's
  // own harvestPoolAmount is a STARTING pool (the pool at
  // the start of the year, before the year's sales, which
  // the shared pricer then nets the year's sales out of).
  // Load resolution converts the record facts to the
  // starting pool before supplying them (see
  // resolveDecemberStateAtLoad); these fields themselves
  // keep the record's current-pool meaning.
  harvestPoolAmount?: number | null;
  harvestPoolBasisPct?: number | null;
};

/* The snapshot-followed primary (build v127, round-19
   finding 1): when the Tax Plan record's primary pre-tax
   balance follows the Net Worth snapshot (a null
   pretaxCents) and the spouse's amount is explicit, the
   primary is the snapshot's pre-tax total MINUS the
   spouse's amount — exactly the resolution
   resolvePlanBalances applies in the plan march (a null
   pretaxCents resolves to max(0, snapshot − spouse)). The
   full snapshot is the HOUSEHOLD's pre-tax total, not the
   primary's alone: reading it as the primary's
   double-counts the spouse's share — once inside the
   primary's full-snapshot amount and once as the spouse's
   own amount — inflating the pool by the spouse's share
   and overstating the gross RMD. Floored at $0; a null
   snapshot answers null, and no spouse amount leaves the
   snapshot whole. The December console uses this in both
   places it reads the record's primary (recordFactsOf and
   the first-open preseed), so the console, the record
   facts, and the march can never disagree about the
   primary's amount. Pure, so the fixtures pin it. */
export function snapshotFollowPrimaryCents(
  snapPretaxCents: number | null | undefined,
  spouseCents: number | null | undefined,
): number | null {
  if (snapPretaxCents == null) return null;
  return Math.max(0, snapPretaxCents - (spouseCents ?? 0));
}

/* A sale's proceeds and the basis it used, from its net
   gain and its entered basis (S-8): with an entered basis
   the full proceeds ride with the basis beside them;
   without one the gain alone rides as proceeds (and a
   loss rides the basis side), so proceeds − basisDollars
   is the net gain in every branch. ONE derivation, shared
   by decemberCaseInputs (which passes the year's whole
   capital result to the pricer, which nets it out of the
   harvest's starting pool) and by load resolution (which
   adds the year's year-to-date sale back into the
   record's current pool to supply that starting pool) —
   the two must never derive the sale differently, or the
   conversion would not invert the netting. */
export function decemberSaleAmounts(
  gain: number,
  basis: number | null,
): { proceeds: number; basisDollars: number } {
  if (basis != null && gain + basis > 0) {
    return { proceeds: r2(gain + basis), basisDollars: basis };
  }
  return {
    proceeds: gain > 0 ? gain : 0,
    basisDollars: gain < 0 ? -gain : 0,
  };
}

/* Round-4 fix, round-5 extension — load-time resolution,
   the exact function the December view's hydration runs.
   It resolves TWO unanswered provenances, as an OVERLAY
   for display and pricing only:

   · The tri-state second beneficiary fact: an explicit
     console answer (true or false) is NEVER overwritten;
     only an unanswered (null) console value is resolved
     from the record's value for the same fact — the
     record's explicit true/false supplies the effective
     value, and a record null leaves it unanswered
     (pricing Uniform, not established).

   · Legacy pre-tax balance ownership (round-5 fix 2,
     round-6 allocation, round-7 partial split): when the
     blob carries no explicit split
     (pretaxSplitExplicit false) but does carry the legacy
     combined balance, ownership is unanswered: when the
     record supplies BOTH owner amounts with a positive
     sum, the SAVED combined total is allocated across the
     owners by the record split's proportions — resolution
     never changes the total itself; when the record
     supplies EXACTLY ONE owner amount, that owner
     receives min(known, saved total) and the other owner
     receives the remainder (saved total − that), so the
     total is still preserved exactly; when the record
     supplies NEITHER amount (or a both-known sum of $0),
     the historical combined→primary assignment is the
     last-resort fallback. A blob WITH an explicit split
     always governs.

   · Education students (v103): a console with no
     education input yet (educationStudents null) resolves
     the record's entered students for the December tax
     year; any entered console list governs.

   Pure: it returns the effective state for this open
   and writes nothing. Round-5 fix 1b: the resolution is
   an overlay, never an input to a save — the client
   derives every save through decemberStateForSave,
   which restores the STORED (unresolved) values for any
   field the user has not themselves edited in the
   console, so an inherited answer can never acquire the
   precedence of an explicit console answer merely
   because an unrelated field was edited and autosaved.
   The carry-in and harvest flags are PER FIELD (round-17
   defect 3): each of the four carry-in fields and each of
   the two harvest facts carries its own edited flag, so
   editing one field saves only that field — the old
   grouped flags promoted untouched siblings into
   explicit console answers.
   The second argument also accepts the round-4 bare
   beneficiary value (boolean / null) for compatibility. */
/* The YEAR-DEPENDENT overlays (round-17 defect 2): the
   education students and the entering capital-loss
   carryforward — the two resolutions whose answer depends
   on the console's tax year (the students are the
   record's entered students FOR that year; the carry-in
   resolves only when the year IS the plan's first year —
   the record's balance is that year's entering loss,
   while a later year's entering loss is the march's
   remainder, which the record does not carry). Both are
   overlays for display and pricing
   only: a null console value resolves from the record
   fact, and any entered console value — including an
   explicit $0 — always wins and is never overwritten.
   Shared by load resolution (resolveDecemberStateAtLoad
   below) and by year-change re-resolution
   (reresolveDecemberStateForYear), so the two can never
   disagree about what a year resolves to. */
function resolveYearDependentOverlays(
  state: DecemberState,
  facts: DecemberRecordFacts,
): DecemberState {
  let out = state;
  // Education students (v103): a console with NO education
  // input yet (educationStudents null — every blob written
  // before this field existed, and a fresh console) resolves
  // the record's entered students for the December tax year
  // as an overlay: displayed and priced, never saved as the
  // console's own until the user edits the education
  // controls here. A console value that IS entered (any
  // list, even empty) always governs and is never
  // overwritten.
  if (out.educationStudents == null && facts.educationStudents != null) {
    out = {
      ...out,
      educationStudents: facts.educationStudents,
    };
  }
  // Entering capital-loss carryforward (v111; gate
  // restored to the plan's first year only by the M-3
  // fix, engines review round 2): the Tax Plan record's
  // carry-in is the balance entering the plan's FIRST
  // year, so it resolves into the console only when the
  // console's tax year IS that year. The plan march
  // consumes the balance year by year (gains absorb it;
  // the used part of each year's $3,000 allowance spends
  // it), so a later December year's true entering balance
  // is the march's remainder — the record does not carry
  // that figure, and resolving the full first-year
  // balance there (the build v127 widening, round-19
  // finding 3) priced losses the march had already spent,
  // understating MAGI and overstating the safe draw in
  // the non-conservative direction. For a later year the
  // fields stay unanswered unless the user enters the
  // remaining balance in the console. It does NOT resolve
  // for a year before the plan's first year either (the
  // loss had not entered the plan yet). Per field: a null
  // console value (no input yet) resolves from the record
  // fact; any entered console value — including an
  // explicit $0 — always wins and is never overwritten.
  // Like every resolution here this is an overlay for
  // display and pricing only: a save persists the STORED
  // values for fields the user has not edited in this
  // console (decemberStateForSave's carryIn flags).
  if (facts.planFirstYear != null && out.taxYear === facts.planFirstYear) {
    const carryPatch: Partial<DecemberState> = {};
    if (out.carryInCapitalLossSt == null && facts.carryInCapitalLossSt != null) {
      carryPatch.carryInCapitalLossSt = facts.carryInCapitalLossSt;
    }
    if (out.carryInCapitalLossLt == null && facts.carryInCapitalLossLt != null) {
      carryPatch.carryInCapitalLossLt = facts.carryInCapitalLossLt;
    }
    if (
      out.carryInCapitalLossStWa == null &&
      facts.carryInCapitalLossStWa != null
    ) {
      carryPatch.carryInCapitalLossStWa = facts.carryInCapitalLossStWa;
    }
    if (
      out.carryInCapitalLossLtWa == null &&
      facts.carryInCapitalLossLtWa != null
    ) {
      carryPatch.carryInCapitalLossLtWa = facts.carryInCapitalLossLtWa;
    }
    if (Object.keys(carryPatch).length > 0) {
      out = { ...out, ...carryPatch };
    }
  }
  // Pre-tax balances (internal review round 3, SHOULD-1): the Tax
  // Plan record's balances are the plan's STARTING balances, so
  // they resolve into the console only when the console's tax year
  // IS the plan's first year — the same first-year gate as the
  // carry-in above. A later December year's prior-Dec-31 balance
  // is the march's ending balance after the intervening years,
  // which the record does not carry; resolving the starting
  // balance there priced the RMD on a balance from years earlier
  // (in the settlement's worked example a 2043 console priced
  // its RMD on the starting balance, understating it by more
  // than half). For a later year the fields stay unanswered
  // unless the user enters the true prior-year-end balance in
  // the console. It does NOT resolve for a year before the
  // plan's first year either (the balances had not entered the
  // plan yet). Per field: a null console value (no input yet)
  // resolves from the record fact; any entered console value —
  // including an explicit $0 — always wins and is never
  // overwritten. Like every resolution here this is an overlay
  // for display and pricing only: a save persists the STORED
  // values for fields the user has not edited in this console
  // (decemberStateForSave's balances flag). The split
  // allocation below still governs whenever the console holds a
  // saved combined total: it runs after this overlay and
  // overwrites the split from that total, so a stored console's
  // own figure is never displaced by the record's proportions.
  if (facts.planFirstYear != null && out.taxYear === facts.planFirstYear) {
    const balancePatch: Partial<DecemberState> = {};
    if (
      out.pretaxBalancePrimary == null &&
      facts.pretaxBalancePrimary != null
    ) {
      balancePatch.pretaxBalancePrimary = facts.pretaxBalancePrimary;
    }
    if (
      out.pretaxBalanceSpouse == null &&
      facts.pretaxBalanceSpouse != null
    ) {
      balancePatch.pretaxBalanceSpouse = facts.pretaxBalanceSpouse;
    }
    if (Object.keys(balancePatch).length > 0) {
      out = { ...out, ...balancePatch };
    }
  }
  return out;
}

/* The harvest starting-pool derivation (S-8), shared by
   load resolution (resolveDecemberStateAtLoad below) and
   year-change re-resolution (reresolveDecemberStateForYear),
   so the two can never disagree about what a year resolves
   to: the record's CURRENT pool plus the year's year-to-date
   sale (proceeds and basis, derived by decemberSaleAmounts
   exactly as decemberCaseInputs derives them) plus the
   year's 100%-basis taxable cash — the same outflows the
   shared pricer will net back out — with the basis %
   converted on the same dollars (the record's basis dollars,
   plus the basis the year's sale used, plus the taxable cash,
   over the starting pool). The derivation reads the YTD
   figures off the state it is given, so it answers for the
   year those figures belong to: load passes the loaded
   year's figures, and a year change passes the new year's
   (reset or restored) figures. `deriveHarvestBasisPct` takes
   the pool to convert against — the display pool when the
   console owns one (a console-entered pool beside a record
   basis converts the % against that entered pool), the
   derived starting pool otherwise — and returns the record
   basis unchanged when there is no current pool to convert
   from. Both return null when the record does not answer
   the fact they derive. */
function deriveHarvestStartingPool(
  state: DecemberState,
  facts: DecemberRecordFacts,
): number | null {
  const sale = decemberSaleAmounts(state.ytdCapitalGain, state.saleBasis);
  const fundedBack = Math.max(0, state.taxableFunded ?? 0);
  const currentPool = facts.harvestPoolAmount ?? null;
  return currentPool != null
    ? r2(currentPool + sale.proceeds + fundedBack)
    : null;
}

function deriveHarvestBasisPct(
  state: DecemberState,
  facts: DecemberRecordFacts,
  startPool: number | null,
): number | null {
  if (facts.harvestPoolBasisPct == null) return null;
  const currentPool = facts.harvestPoolAmount ?? null;
  if (currentPool != null && startPool != null && startPool > 0) {
    const sale = decemberSaleAmounts(state.ytdCapitalGain, state.saleBasis);
    const fundedBack = Math.max(0, state.taxableFunded ?? 0);
    const startBasis = r2(
      (facts.harvestPoolBasisPct / 100) * currentPool +
        sale.basisDollars +
        fundedBack,
    );
    return Math.min(100, Math.max(0, r2((startBasis / startPool) * 100)));
  }
  return facts.harvestPoolBasisPct;
}

/* The harvest starting-pool RE-derivation, shared by the
   year-change re-resolution (reresolveDecemberStateForYear
   below) and the console's in-session year-to-date edits
   (internal review round 7, SHOULD-1): when the displayed
   pool is overlay-derived — no stored pool, and the user
   has not edited the pool fact in this console — and it is
   currently shown, the pool (and basis %) re-derive from
   the state's year-to-date figures through the shared
   derivation above, so the displayed starting pool always
   contains the year's typed sale and taxable cash, exactly
   as a fresh load would derive it. A stored non-null pool
   is the console's own answer and stays; a pool the user
   edited in this console stays too (per fact, like the
   save's harvest flags); and a pool that is blank stays
   blank — a deliberately cleared fact is never revived by
   a re-derivation. The basis % follows the same per-fact
   rule, converting against the re-derived (or kept) pool.
   Pure: the caller passes the state whose year-to-date
   figures the derivation should read (the merged flip
   state on a year change; the just-edited form state on
   an in-session sale edit). */
export function rederiveHarvestPool(
  state: DecemberState,
  stored: DecemberStoredProvenance,
  edited: { harvestPoolAmount: boolean; harvestPoolBasisPct: boolean },
  facts: DecemberRecordFacts,
): DecemberState {
  let out = state;
  if (
    stored.harvestPoolAmount == null &&
    !edited.harvestPoolAmount &&
    out.harvestPoolAmount != null
  ) {
    const startingPool = deriveHarvestStartingPool(out, facts);
    if (startingPool != null) {
      out = { ...out, harvestPoolAmount: startingPool };
    }
  }
  if (
    stored.harvestPoolBasisPct == null &&
    !edited.harvestPoolBasisPct &&
    out.harvestPoolBasisPct != null &&
    facts.harvestPoolBasisPct != null
  ) {
    const startPool =
      out.harvestPoolAmount ?? deriveHarvestStartingPool(out, facts);
    const derivedBasis = deriveHarvestBasisPct(out, facts, startPool);
    if (derivedBasis != null) {
      out = { ...out, harvestPoolBasisPct: derivedBasis };
    }
  }
  return out;
}

export function resolveDecemberStateAtLoad(
  state: DecemberState,
  record: boolean | null | undefined | DecemberRecordFacts,
): DecemberState {
  const facts: DecemberRecordFacts =
    record != null && typeof record === "object"
      ? record
      : { primarySoleBeneficiaryOfSpouse: record ?? null };
  let out = state;
  if (
    out.primarySoleBeneficiaryOfSpouse == null &&
    facts.primarySoleBeneficiaryOfSpouse != null
  ) {
    out = {
      ...out,
      primarySoleBeneficiaryOfSpouse: facts.primarySoleBeneficiaryOfSpouse,
    };
  }
  // The year-dependent overlays (education students and
  // the entering carry-in) resolve through the shared
  // helper, so load and year-change re-resolution agree.
  out = resolveYearDependentOverlays(out, facts);
  // Gain-harvest pool facts (v113): the record's taxable
  // pool and blended basis resolve into null console facts
  // in ANY year (balance facts, not entering-year balances
  // like the carry-in above — no first-year gate). Per
  // field: a null console value (no input yet) resolves
  // from the record fact; any entered console value —
  // including an explicit $0 pool — always wins and is
  // never overwritten. The harvest toggle itself is the
  // console's own answer and never resolves. Like every
  // resolution here this is an overlay for display and
  // pricing only: a save persists the STORED values for
  // fields the user has not edited in this console
  // (decemberStateForSave's per-field harvest flags).
  // S-8 (engines review round 2): the record fact is a
  // CURRENT pool (see DecemberRecordFacts), but the
  // console fact it fills is a STARTING pool — the shared
  // pricer nets the year's taxable sales OUT of the
  // console fact to size the harvest from the remaining
  // pool, so filling it with the current pool nets the
  // year's sales out a SECOND time and understates the
  // harvestable gain (in the settlement's worked example
  // the double netting left a $0 remaining pool: harvest
  // $0 instead of $4,140, MAGI understated by the same
  // $4,140, and the solved draw overstated by it). The
  // resolution therefore supplies the STARTING pool: the
  // record's current pool plus the year's year-to-date
  // sale (proceeds and basis, derived by
  // decemberSaleAmounts exactly as decemberCaseInputs
  // derives them) plus the year's 100%-basis taxable cash
  // — the same outflows the shared pricer will net back
  // out — and converts the basis % on the same dollars
  // (the record's basis dollars, plus the basis the
  // year's sale used, plus the taxable cash, over the
  // starting pool), so the remaining pool the harvest
  // sizes from is the record's own current pool at its own
  // basis, to the cent. The add-back uses the YEAR-TO-DATE
  // sale only: the still-to-come distributions and
  // checklist amounts the pricer also nets have not left
  // the pool yet, so they are not in the record's current
  // pool to add back — a resolved starting pool behaves
  // exactly like a user-entered one. When the record
  // answers the basis but not the pool, its % cannot be
  // converted (the basis dollars are unknown) and resolves
  // as entered; a console-entered pool beside a record
  // basis converts the % against that entered pool. The
  // derivation itself lives in deriveHarvestStartingPool /
  // deriveHarvestBasisPct above, shared with the year-change
  // re-resolution so a flip answers exactly as a fresh load
  // would.
  {
    const startingPool = deriveHarvestStartingPool(out, facts);
    const harvestPatch: Partial<DecemberState> = {};
    if (out.harvestPoolAmount == null && startingPool != null) {
      harvestPatch.harvestPoolAmount = startingPool;
    }
    if (out.harvestPoolBasisPct == null && facts.harvestPoolBasisPct != null) {
      const startPool = out.harvestPoolAmount ?? startingPool;
      const derivedBasis = deriveHarvestBasisPct(out, facts, startPool);
      if (derivedBasis != null) {
        harvestPatch.harvestPoolBasisPct = derivedBasis;
      }
    }
    if (Object.keys(harvestPatch).length > 0) {
      out = { ...out, ...harvestPatch };
    }
  }
  if (!out.pretaxSplitExplicit && out.pretaxBalance != null) {
    const recPrimary = facts.pretaxBalancePrimary ?? null;
    const recSpouse = facts.pretaxBalanceSpouse ?? null;
    const recSum =
      recPrimary != null && recSpouse != null
        ? r2(recPrimary + recSpouse)
        : null;
    const savedTotal = out.pretaxBalance;
    if (recSum != null && recSum > 0) {
      // Round-6 fix 2: allocate the SAVED combined total
      // across the owners by the record split's
      // proportions — the saved total is the console's
      // own prior-year-end figure and resolution never
      // changes it. Each raw share is rounded to cents;
      // the residual (itself rounded to cents) goes to
      // the LARGER rounded share (tie → the primary's),
      // so the shares sum EXACTLY to the saved total.
      const sharePrimary = r2((savedTotal * recPrimary!) / recSum);
      const shareSpouse = r2((savedTotal * recSpouse!) / recSum);
      const residual = r2(savedTotal - sharePrimary - shareSpouse);
      const primaryGetsResidual = sharePrimary >= shareSpouse;
      out = {
        ...out,
        pretaxBalancePrimary: primaryGetsResidual
          ? r2(sharePrimary + residual)
          : sharePrimary,
        pretaxBalanceSpouse: primaryGetsResidual
          ? shareSpouse
          : r2(shareSpouse + residual),
        pretaxBalance: savedTotal,
      };
    } else if (
      (recPrimary != null) !== (recSpouse != null)
    ) {
      // Round-7 fix A: exactly one owner amount is known.
      // The known owner receives min(known, saved total)
      // and the other owner receives the remainder, so
      // the known ownership is honoured and the saved
      // total is preserved exactly (both as numbers).
      if (recPrimary != null) {
        const primaryShare = r2(Math.min(recPrimary, savedTotal));
        out = {
          ...out,
          pretaxBalancePrimary: primaryShare,
          pretaxBalanceSpouse: r2(savedTotal - primaryShare),
          pretaxBalance: savedTotal,
        };
      } else {
        const spouseShare = r2(Math.min(recSpouse!, savedTotal));
        out = {
          ...out,
          pretaxBalancePrimary: r2(savedTotal - spouseShare),
          pretaxBalanceSpouse: spouseShare,
          pretaxBalance: savedTotal,
        };
      }
    } else {
      // No usable record split (neither amount known, or
      // the record sum is $0 and proportions are
      // undefined): the last-resort fallback — the
      // combined balance on the primary, spouse
      // not-entered.
      out = {
        ...out,
        pretaxBalancePrimary: out.pretaxBalance,
        pretaxBalanceSpouse: null,
      };
    }
  }
  return out;
}

/* Year-change re-resolution (round-17 defect 2): when
   the console's tax year changes, the year-dependent
   overlays must follow the NEW year — a carry-in resolved
   for the old year must not keep pricing a year the gate
   no longer covers, and the education students must be
   the new year's. `display` is the form's state with the
   new tax year already set; `stored` is the blob's own
   provenance (before any load resolution); `edited` says
   per field whether the user has edited it in this
   console; `facts` are the record facts FOR THE NEW YEAR
   (recordFactsOf with the new tax year). For each
   year-dependent field the user has NOT edited, the
   display value resets to its stored value and the
   shared year-dependent resolution re-applies — so an
   overlay that no longer applies clears, one that still
   applies re-resolves to the same value, and the new
   year's students replace the old year's. A field the
   user HAS edited is never touched, so an explicit
   console answer survives a year change exactly as it
   survives a reload. The beneficiary fact is the one
   year-independent overlay that is not touched here at
   all: it does not depend on the year, and re-running
   the full load resolution would wrongly revive a fact
   the user deliberately cleared. The year-to-date
   figures ARE year-dependent (internal review round 6,
   SHOULD-2): they are the displayed year's facts, so an
   unedited group resets to the new year's answer — blank,
   since no record source carries them — and the harvest
   starting pool (and basis %) re-derives from the reset
   figures when overlay-derived, exactly as a fresh load
   would; a user-entered or previously saved non-null pool
   stays, consistent with the load resolution's "a non-null
   pool always wins" rule. The
   balance split is the one exception, in one direction
   only (internal review round 3, SHOULD-1): the record's
   starting balance answers only the plan's first year,
   so an unedited balance that IS the record's starting
   balance clears when the year moves past the first year
   — while a balance that differs from the record's facts
   is the console's own answer and is never touched. Pure,
   so the fixtures pin it. */
export function reresolveDecemberStateForYear(
  display: DecemberState,
  stored: DecemberStoredProvenance,
  edited: {
    carryInSt: boolean;
    carryInLt: boolean;
    carryInStWa: boolean;
    carryInLtWa: boolean;
    education: boolean;
    balances: boolean;
    // Year-to-date group (internal review round 6,
    // SHOULD-2): whether the user has edited any of the
    // six year-to-date figures in this console since
    // hydration. Optional for older callers, which never
    // edited them — absent reads as unedited.
    ytd?: boolean;
    // Harvest facts (round-17 defect 3, per field):
    // whether the user has edited the pool amount or the
    // basis % in this console. Optional for older callers;
    // absent reads as unedited.
    harvestPoolAmount?: boolean;
    harvestPoolBasisPct?: boolean;
  },
  facts: DecemberRecordFacts,
): DecemberState {
  // A stored carry-in or student belongs to the year it was
  // saved for — the provenance stamp (internal review round
  // 4, SHOULD-1). The reset restores a stored value only
  // into that same year; into any other year it clears the
  // field instead, so a balance saved in an earlier session
  // cannot price a later year (the M-3 defect through
  // stored provenance: the edited flags are session state,
  // reset on reload, so a carry-in saved in an earlier
  // session returned as unedited and was restored into a
  // later year, bypassing the first-year-only gate). The
  // stamp is precise where clearing would not be: a
  // carry-in can legitimately be unchanged into the next
  // year if the intervening year consumed nothing, and
  // switching back to the stamped year restores the stored
  // value exactly. An edited field is never touched — an
  // explicit answer for the new year survives, by design.
  // The balances below do not use the stamp: they carry
  // their own equality-against-record-facts clear.
  const storedForYear = stored.taxYear === display.taxYear;
  const reset: Partial<DecemberState> = {};
  if (!edited.carryInSt) {
    reset.carryInCapitalLossSt = storedForYear
      ? stored.carryInCapitalLossSt
      : null;
  }
  if (!edited.carryInLt) {
    reset.carryInCapitalLossLt = storedForYear
      ? stored.carryInCapitalLossLt
      : null;
  }
  if (!edited.carryInStWa) {
    reset.carryInCapitalLossStWa = storedForYear
      ? stored.carryInCapitalLossStWa
      : null;
  }
  if (!edited.carryInLtWa) {
    reset.carryInCapitalLossLtWa = storedForYear
      ? stored.carryInCapitalLossLtWa
      : null;
  }
  if (!edited.education) {
    reset.educationStudents = storedForYear
      ? stored.educationStudents
      : null;
  }
  if (!edited.ytd) {
    // Year-to-date figures (internal review round 6,
    // SHOULD-2): the six figures are the displayed year's
    // facts, so an unedited group follows the stamp exactly
    // like a carry-in — restored from stored provenance
    // when the stamp IS the display year, blanked when it
    // is not. Blank is the new year's answer: no record
    // source carries year-to-date figures, so the new year
    // starts unanswered until the user types them (the
    // numbers blank to $0, the two nullable figures to
    // null). The other year-to-date lines — other ordinary
    // income, tax-exempt interest, Social Security — are
    // not in this group and keep persisting across a flip,
    // as before. The handler resets the group's edited flag
    // on the flip (round-6 SHOULD-1's shape), so a group
    // typed for the old year never survives into the new
    // one; the flush before that reset saves the typed
    // figures under the old year's stamp first.
    reset.ytdInterest = storedForYear ? stored.ytdInterest : 0;
    reset.ytdOrdinaryDividends = storedForYear
      ? stored.ytdOrdinaryDividends
      : 0;
    reset.ytdQualifiedDividends = storedForYear
      ? stored.ytdQualifiedDividends
      : 0;
    reset.ytdCapitalGain = storedForYear ? stored.ytdCapitalGain : 0;
    reset.saleBasis = storedForYear ? stored.saleBasis : null;
    reset.taxableFunded = storedForYear ? stored.taxableFunded : null;
  }
  if (!edited.balances) {
    // A saved split restores like every other unedited field.
    // No saved split (null) leaves the display exactly as it
    // is: the display split is then either blank or
    // load-derived from the console's own saved combined total,
    // and neither is the record's answer to touch.
    if (
      stored.pretaxBalancePrimary != null ||
      stored.pretaxBalanceSpouse != null
    ) {
      reset.pretaxBalancePrimary = stored.pretaxBalancePrimary;
      reset.pretaxBalanceSpouse = stored.pretaxBalanceSpouse;
    }
  }
  const merged = { ...display, ...reset };
  if (
    !edited.balances &&
    facts.planFirstYear != null &&
    merged.taxYear !== facts.planFirstYear
  ) {
    // The record's pre-tax balances are the plan's STARTING
    // balances: they answer the console only for the plan's
    // first year. A balance that IS the record's starting
    // balance is the first-open preseed, not the console's own
    // answer — carrying it into a later year prices the RMD on
    // a balance from years earlier (internal review round 3,
    // SHOULD-1). Clear it so the new year prices no RMD on the
    // stale figure; the fields read blank (not entered) and the
    // user enters the true prior-Dec-31 balance. A balance that
    // differs from the record's facts is the console's own answer
    // and is never touched — including a balance the user
    // entered for the old year. (The one collision: a stored
    // balance the user entered in an earlier session that
    // happens to equal the record's starting balance to the
    // cent also clears — it is stale for the new year
    // regardless, and the user re-enters the true figure.)
    if (
      merged.pretaxBalancePrimary != null &&
      merged.pretaxBalancePrimary === facts.pretaxBalancePrimary
    ) {
      merged.pretaxBalancePrimary = null;
    }
    if (
      merged.pretaxBalanceSpouse != null &&
      merged.pretaxBalanceSpouse === facts.pretaxBalanceSpouse
    ) {
      merged.pretaxBalanceSpouse = null;
    }
  }
  // The harvest starting pool re-derives for the new year
  // (internal review round 6, SHOULD-2): the load
  // resolution derives it from the record's current pool
  // plus the year's year-to-date sale and taxable cash, so
  // a pool derived for the old year is stale for the new
  // one — the old year's sale left the pool before the new
  // year began. The re-derivation runs on the merged
  // state, so it reads the reset (or restored) year-to-date
  // figures above, through the shared rederiveHarvestPool
  // helper the load resolution's derivation feeds — a flip
  // answers exactly as a fresh load would, and the same
  // helper re-derives the pool on an in-session
  // year-to-date edit (internal review round 7, SHOULD-1).
  const pooled = rederiveHarvestPool(merged, stored, {
    harvestPoolAmount: edited.harvestPoolAmount ?? false,
    harvestPoolBasisPct: edited.harvestPoolBasisPct ?? false,
  }, facts);
  return resolveYearDependentOverlays(pooled, facts);
}

/* The provenance a save must preserve for fields the
   user has not edited in the console: the STORED blob's
   own values (as parsed, before any load resolution). */
export type DecemberStoredProvenance = {
  // The tax year of the saved blob these stored values were
  // saved for (internal review round 4, SHOULD-1): a stored
  // carry-in or student belongs to its year — restoring it
  // into another year prices that year's entering balance
  // with a stale figure. The stamp is the blob's own tax
  // year, carried by decemberStoredProvenanceOf, so no blob
  // format change is needed and it is correct by
  // construction at every derivation point (load, save
  // success, CAS reload, first-open preseed). It gates the
  // year-change restore (reresolveDecemberStateForYear)
  // and, since internal review round 5 (SHOULD-1), the
  // save itself: decemberStateForSave persists a stored
  // carry-in or student only when the stamp equals the
  // display year, and null otherwise. Load resolution
  // never changes the year, so the stamp always matches
  // there.
  taxYear: number;
  primarySoleBeneficiaryOfSpouse: boolean | null;
  pretaxBalancePrimary: number | null;
  pretaxBalanceSpouse: number | null;
  pretaxBalance: number | null;
  pretaxSplitExplicit: boolean;
  legacyBeneficiaryAnswerUnconfirmed: boolean;
  legacyRocSplitUnconfirmed: boolean;
  legacyJanPaidSplitUnconfirmed: boolean;
  // Education students (v103): the stored blob's own
  // entered students (null = no input yet), preserved
  // through saves the same way the beneficiary fact is —
  // a record-resolved overlay never becomes the console's
  // saved answer unless the user edits the education
  // controls here.
  educationStudents: EducationStudent[] | null;
  // Entering capital-loss carryforward (v111): the stored
  // blob's own four values (null per field = no input
  // yet), preserved through saves the same way — a
  // record-resolved overlay (the plan's first year only)
  // never becomes the console's saved answer unless the
  // user edits the carry-in controls here.
  carryInCapitalLossSt: number | null;
  carryInCapitalLossLt: number | null;
  carryInCapitalLossStWa: number | null;
  carryInCapitalLossLtWa: number | null;
  // Gain-harvest pool facts (v113): the stored blob's own
  // two values (null per field = no input yet), preserved
  // through saves the same way — a record-resolved overlay
  // never becomes the console's saved answer unless the
  // user edits the harvest pool controls here. The harvest
  // toggle is NOT provenance: it is a plain console answer
  // and always saves as displayed.
  harvestPoolAmount: number | null;
  harvestPoolBasisPct: number | null;
  // Year-to-date figures (internal review round 6,
  // SHOULD-2): the stored blob's own six figures (the
  // numbers blank to $0, the two nullable figures to null
  // when unanswered), preserved through saves the same way
  // the carry-ins are — stamp-aware (decemberStateForSave
  // below), so a flip-back before any save at the new year
  // restores the old year's figures from here, and an edit
  // at the new year never carries the old year's figures
  // into the new year's stamp. The other year-to-date
  // lines (other ordinary income, tax-exempt interest,
  // Social Security) are not provenance: they are plain
  // console answers and always save as displayed.
  ytdInterest: number;
  ytdOrdinaryDividends: number;
  ytdQualifiedDividends: number;
  ytdCapitalGain: number;
  saleBasis: number | null;
  taxableFunded: number | null;
};

export function decemberStoredProvenanceOf(
  state: DecemberState,
): DecemberStoredProvenance {
  return {
    taxYear: state.taxYear,
    primarySoleBeneficiaryOfSpouse: state.primarySoleBeneficiaryOfSpouse,
    pretaxBalancePrimary: state.pretaxBalancePrimary,
    pretaxBalanceSpouse: state.pretaxBalanceSpouse,
    pretaxBalance: state.pretaxBalance,
    pretaxSplitExplicit: state.pretaxSplitExplicit,
    legacyBeneficiaryAnswerUnconfirmed:
      state.legacyBeneficiaryAnswerUnconfirmed,
    legacyRocSplitUnconfirmed: state.legacyRocSplitUnconfirmed,
    legacyJanPaidSplitUnconfirmed: state.legacyJanPaidSplitUnconfirmed,
    educationStudents: state.educationStudents,
    carryInCapitalLossSt: state.carryInCapitalLossSt,
    carryInCapitalLossLt: state.carryInCapitalLossLt,
    carryInCapitalLossStWa: state.carryInCapitalLossStWa,
    carryInCapitalLossLtWa: state.carryInCapitalLossLtWa,
    harvestPoolAmount: state.harvestPoolAmount,
    harvestPoolBasisPct: state.harvestPoolBasisPct,
    ytdInterest: state.ytdInterest,
    ytdOrdinaryDividends: state.ytdOrdinaryDividends,
    ytdQualifiedDividends: state.ytdQualifiedDividends,
    ytdCapitalGain: state.ytdCapitalGain,
    saleBasis: state.saleBasis,
    taxableFunded: state.taxableFunded,
  };
}

/* Round-5 fix 1b / fix 2, round-6 flag lifecycle — the
   save-state derivation the December view's autosave
   actually runs. `display` is the form state the user
   sees (load resolution applied); `stored` is the
   provenance of the blob it was read from. For each
   provenance field the user has NOT edited in the
   console, the save writes the STORED value — so a
   record-resolved beneficiary fact stays unanswered
   (null) in the blob no matter what else was edited, and
   a record-supplied balance split stays un-owned by the
   console. The one qualification (internal review round
   5, SHOULD-1): an unedited carry-in or education
   student writes its stored value only when the stored
   stamp year IS the display year, and null otherwise —
   see the stamp-aware note at those branches below. Once
   the user edits that control, the display
   value is theirs and governs from then on (an edited
   balance split is explicit). The provenance FLAGS
   follow the same discipline (round-6): each flag
   clears ONLY when its own control was edited
   (beneficiary → the beneficiary-answer flag; the ROC
   character control → the ROC flag; the January-paid
   qualified-amount control → the January-paid flag) and
   otherwise carries the STORED value through every save,
   serializer round-trip, and reload. */
export function decemberStateForSave(
  display: DecemberState,
  stored: DecemberStoredProvenance,
  edited: {
    beneficiary: boolean;
    balances: boolean;
    rocCharacter?: boolean;
    janPaidCharacter?: boolean;
    education?: boolean;
    // Per-field carry-in flags (round-17 defect 3): each
    // of the four carry-in fields saves its display value
    // only when THAT field was edited; an unedited sibling
    // keeps its stored value even when another carry-in
    // field was edited.
    carryInSt?: boolean;
    carryInLt?: boolean;
    carryInStWa?: boolean;
    carryInLtWa?: boolean;
    // Per-field harvest flags (round-17 defect 3): the
    // pool amount and the basis % save independently.
    harvestPoolAmount?: boolean;
    harvestPoolBasisPct?: boolean;
    // Year-to-date group flag (internal review round 6,
    // SHOULD-2): whether the user has edited any of the
    // six year-to-date figures in this console since
    // hydration. One flag for the group: the figures are
    // one year's facts together, so editing any of them
    // saves the group as displayed; an unedited group
    // saves stamp-aware, like a carry-in.
    ytd?: boolean;
  },
): DecemberState {
  // The carry-ins and the education students are
  // STAMP-AWARE (internal review round 5, SHOULD-1): an
  // unedited one persists its STORED value only when the
  // stored blob was saved for the very year on display.
  // On a stamp mismatch it persists NULL — never the
  // display value: on a mismatch the display value is
  // either null already (cleared by the year-change
  // re-resolution) or an overlay re-fill the save must
  // not own (the new year's record students, or the
  // record's first-year carry-ins when switching INTO the
  // first year), and persisting it would make the console
  // own a record value and break the first-year
  // discipline (the blob's null is the console not owning
  // the first-year value; the overlay refills it on
  // reload). Before this, the save persisted the stored
  // value with no year check at all, and the year-change
  // handler compensated by patching the stored provenance
  // itself to nulls — which destroyed a non-first year's
  // saved carry-ins and typed students permanently on a
  // switch away and back, because no refill path exists
  // for a non-first year. The stamp-aware save closes
  // both directions at the root: no stale-year value is
  // saved under the wrong year, and nothing is destroyed
  // on switch-back. The year-to-date figures follow the
  // same stamp-aware rule (internal review round 6,
  // SHOULD-2): an unedited group persists its STORED values
  // only into its stamped year, and blank ($0 for the
  // numbers, null for the two nullable figures) otherwise —
  // never the display value, which on a mismatch is either
  // blank already (cleared by the year-change re-resolution)
  // or the old year's figures the flip must not re-stamp.
  // The harvest pool is deliberately NOT year-gated here:
  // a stored non-null pool is the console's own answer and
  // persists as stored in any year, and an overlay-derived
  // pool is re-derived at the year change, not at the save
  // — and neither are the balances below.
  const storedForDisplayYear = stored.taxYear === display.taxYear;
  return {
    ...display,
    ytdInterest: edited.ytd
      ? display.ytdInterest
      : storedForDisplayYear
        ? stored.ytdInterest
        : 0,
    ytdOrdinaryDividends: edited.ytd
      ? display.ytdOrdinaryDividends
      : storedForDisplayYear
        ? stored.ytdOrdinaryDividends
        : 0,
    ytdQualifiedDividends: edited.ytd
      ? display.ytdQualifiedDividends
      : storedForDisplayYear
        ? stored.ytdQualifiedDividends
        : 0,
    ytdCapitalGain: edited.ytd
      ? display.ytdCapitalGain
      : storedForDisplayYear
        ? stored.ytdCapitalGain
        : 0,
    saleBasis: edited.ytd
      ? display.saleBasis
      : storedForDisplayYear
        ? stored.saleBasis
        : null,
    taxableFunded: edited.ytd
      ? display.taxableFunded
      : storedForDisplayYear
        ? stored.taxableFunded
        : null,
    educationStudents: edited.education
      ? display.educationStudents
      : storedForDisplayYear
        ? stored.educationStudents
        : null,
    carryInCapitalLossSt: edited.carryInSt
      ? display.carryInCapitalLossSt
      : storedForDisplayYear
        ? stored.carryInCapitalLossSt
        : null,
    carryInCapitalLossLt: edited.carryInLt
      ? display.carryInCapitalLossLt
      : storedForDisplayYear
        ? stored.carryInCapitalLossLt
        : null,
    carryInCapitalLossStWa: edited.carryInStWa
      ? display.carryInCapitalLossStWa
      : storedForDisplayYear
        ? stored.carryInCapitalLossStWa
        : null,
    carryInCapitalLossLtWa: edited.carryInLtWa
      ? display.carryInCapitalLossLtWa
      : storedForDisplayYear
        ? stored.carryInCapitalLossLtWa
        : null,
    harvestPoolAmount: edited.harvestPoolAmount
      ? display.harvestPoolAmount
      : stored.harvestPoolAmount,
    harvestPoolBasisPct: edited.harvestPoolBasisPct
      ? display.harvestPoolBasisPct
      : stored.harvestPoolBasisPct,
    primarySoleBeneficiaryOfSpouse: edited.beneficiary
      ? display.primarySoleBeneficiaryOfSpouse
      : stored.primarySoleBeneficiaryOfSpouse,
    pretaxBalancePrimary: edited.balances
      ? display.pretaxBalancePrimary
      : stored.pretaxBalancePrimary,
    pretaxBalanceSpouse: edited.balances
      ? display.pretaxBalanceSpouse
      : stored.pretaxBalanceSpouse,
    pretaxBalance: edited.balances
      ? display.pretaxBalance
      : stored.pretaxBalance,
    pretaxSplitExplicit: edited.balances
      ? true
      : stored.pretaxSplitExplicit,
    legacyBeneficiaryAnswerUnconfirmed: edited.beneficiary
      ? false
      : stored.legacyBeneficiaryAnswerUnconfirmed,
    legacyRocSplitUnconfirmed: edited.rocCharacter
      ? false
      : stored.legacyRocSplitUnconfirmed,
    legacyJanPaidSplitUnconfirmed: edited.janPaidCharacter
      ? false
      : stored.legacyJanPaidSplitUnconfirmed,
  };
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

const strayAmount = (s: DecemberStray): number =>
  s.status === "amount" ? Math.max(0, s.amount) : 0;

/* The K-1 stray is the ONE signed stray (December fix): a
   currently deductible K-1 loss is negative income and
   reduces other ordinary income dollar-for-dollar. Every
   other stray keeps the non-negative strayAmount above —
   the loss-harvest and AGI-reducer strays are SUBTRACTED
   dials (positive by design), and the capital-distribution,
   planned-sales, return-of-capital, January-paid, dividend/
   interest, tax-exempt, severance, and dependent strays are
   non-negative amounts by their nature. */
const straySignedAmount = (s: DecemberStray): number =>
  s.status === "amount" ? s.amount : 0;

/* Which benchmark tier a first-open prefill should seed,
   mirroring the long-horizon engine's selection (taxEngine's
   march): the tier keys on WHO is on the marketplace, never
   on household size alone. Both spouses on ACA → the family
   tier at household size 3+, the couple tier below that.
   Exactly one spouse on ACA → the single tier at ANY
   household size (a spouse-only year in a household of 5 is
   not a family marketplace year). Nobody on ACA → no tier
   (nothing to seed). Pure, so the fixtures pin the exact
   function the view's prefill runs. */
export type DecemberBenchmarkTier = "single" | "couple" | "family";
export function decemberBenchmarkTier(args: {
  filingStatus: DecemberState["filingStatus"];
  householdSize: number | null;
  onMedicarePrimary: boolean;
  onMedicareSpouse: boolean;
}): DecemberBenchmarkTier | null {
  if (args.householdSize == null) return null;
  const primaryOnAca = !args.onMedicarePrimary;
  const spouseOnAca =
    args.filingStatus === "mfj" && !args.onMedicareSpouse;
  if (primaryOnAca && spouseOnAca) {
    return args.householdSize >= 3 ? "family" : "couple";
  }
  if (primaryOnAca || spouseOnAca) return "single";
  return null;
}

/* ---------------- Save revision / CAS ----------------
   The December blob carries a write revision as a top-level
   `revision` key beside the state fields — the Roth
   records' pattern (rothRevisionCore): a blob written
   before revisions existed reads as revision 0, writers
   pass the revision their copy was read at (baseRevision),
   and a write whose base no longer matches is refused with
   the current state instead of overwriting it. The revision
   never enters the DecemberState the parser returns (the
   parser reads its fixed field set and ignores the key),
   and the blob rides backup / restore as one settings value
   exactly as before. These are the exact functions the
   get / save actions run, so the fixtures pin the contract
   the handlers enforce. */
export function parseDecemberRevision(raw: string | undefined): number {
  return parseRothBlobRevision(raw);
}

export function decideDecemberWrite(
  storedRevision: number,
  baseRevision: number,
): { allowed: true; nextRevision: number } | { allowed: false; storedRevision: number } {
  return decideRothBlobWrite(storedRevision, baseRevision);
}

/* The state-format marker written by every save (see
   parseDecemberState). Value 3 = this build (round-6):
   the stored provenance flags are authoritative in the
   blob, and a pre-marker beneficiary false stands as an
   answered false carrying its confirm flag. Value 2 =
   the first marked format (round-5). A blob with no
   marker is the unmarked legacy format. Like `revision`,
   the marker rides beside the state fields and never
   enters the DecemberState the parser returns. */
export const DECEMBER_STATE_FORMAT = 3;

export function serializeDecemberState(
  state: DecemberState,
  revision: number,
): string {
  return JSON.stringify({
    ...state,
    decemberStateFormat: DECEMBER_STATE_FORMAT,
    revision,
  });
}

/* ---------------- Form conversion: nullable money fields ----------------
   The December form carries typed strings; the saved state
   carries numbers. Most money fields are plain numbers —
   blank reads as $0 and the two are the same fact, so the
   form renders $0 as blank like every other view. FOUR
   fields are NULLABLE, and for them null and $0 are
   different facts with different pricing:

   · pretaxBalancePrimary / pretaxBalanceSpouse — null =
     not entered (no RMD priced for that owner, no
     available-balance cap on the draw); $0 = a known empty
     balance (that owner's RMD is $0 and the balance caps
     the draw at what the balances actually hold).
   · acaBenchmarkAnnual — null = no benchmark entered (the
     credit is not priced); $0 prices a $0 credit.
   · acaEnrollmentPremiumAnnual — null = NO enrollment-
     premium cap; $0 caps every case's final credit at $0.

   Rendering any of these four through the generic
   $0-shows-blank converter silently turned a known $0 into
   "not entered" on the next form load (round-2 defect 1:
   a household with an explicitly entered $0 balance got a
   fictitious draw, because the solver imposes no balance
   cap on a null balance). These two converters are the
   pair the view's form boundary runs for exactly those
   four fields — a null renders blank, a $0 renders "0",
   and the parse reads blank back as null and "0" back as
   $0 — so an entered zero round-trips as zero. The
   fixtures pin this exact pair. */
export function decemberNullableMoneyFormValue(n: number | null): string {
  if (n == null) return "";
  // The same grouped-thousands rendering the money inputs
  // use everywhere (fmtMoneyInput in the client): cents
  // shown only when the amount has them. $0 renders "0" —
  // visibly distinct from the blank that means not entered.
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function decemberNullableMoneyFromFormValue(s: string): number | null {
  const cleaned = s.replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/* Assemble ONE case's single-year engine dials at a given
   pre-tax draw. The year's income is: year-to-date actuals +
   this case's remaining-income ranges + the stray amounts
   (which apply in every case — they are amounts the household
   has identified, on top of the ranges). The capital result
   (actuals + expected distributions + the capital-gain stray,
   plus forecast gains on planned sales and the CAPITAL part
   of return of capital — income over basis — less any
   harvested loss) rides the engine's stock-sale dials:
   a net gain is sold $gain with $0 basis; a net loss is sold
   $0 with basis $loss, so the engine prices the loss (and its
   §1211(b) allowance) exactly as it prices a Playground sale.
   Return of capital reclassified as an ordinary dividend
   rides the dividends total instead (its actual character).
   The settled-review additions flow the same way: a fund
   distribution declared in October–December and paid in
   January is deemed received December 31 (§852(b)(7)), so
   its ordinary part rides the dividends total, with its
   qualified portion riding the qualified-dividends subset
   like the year-to-date pair — and (v104, F5) the part the
   fund designates as a capital gain distribution rides
   the capital result above instead, as a long-term gain
   (§852(b)(3)), removed from the dividends total so it is
   never counted twice and Washington's excise (which
   prices the long-term gain and never a dividend) sees
   it; money-market dividends from a cash sleeve and
   savings-bond interest ride interest; and the AGI reducers
   that actually work (deductible HSA contributions, pre-tax
   deferrals not already reflected in the wages above)
   subtract from other ordinary income — an assembly of the
   engine's existing dials, never new tax math. The K-1
   stray is signed (a deductible loss reduces ordinary
   income), and (v112, F4) the part of a positive K-1
   amount reported as a long-term capital gain (Schedule
   K-1 box 9a) rides the capital result above instead of
   ordinary income, removed from it so it is never counted
   twice; (v112, F5) the qualified part of a reclassified
   return-of-capital dividend rides the qualified-dividends
   subset like the January-paid qualified companion, while
   the whole reclassified amount stays in ordinary
   dividends. A filing dependent's income does NOT join the
   parents' income at all: it rides the engine's ACA-only
   dependentMagiForAca channel, into the §36B household
   MAGI and nowhere else. The pre-tax balances go in split
   by owner, with the already-received RMD amount, so each
   owner's RMD prices on their own clock and a paid RMD is
   netted, never double-counted. The coverage-month stray
   carries NO income: it reduces the case's final allowable
   credit instead (see computeDecemberProjection), because
   eligibility is monthly. The entered education students
   (v103) ride the engine's education dial unchanged, so
   the shared §25A step prices them — the nonrefundable
   portion inside the federal tax, the refundable AOTC
   portion reported on the result and credited in the
   settlement (see computeDecemberProjection). */
export function decemberCaseInputs(
  state: DecemberState,
  kind: DecemberCaseKind,
  draw: number,
): PlaygroundYearInputs {
  const joint = state.filingStatus === "mfj";
  const janPaid = strayAmount(state.strayJanPaid);
  // The capital-gain-distribution portion of the
  // January-paid total (v104, F5): a portion of that
  // total, clamped to it, never an amount on top of it.
  // It rides the gains stack below (its §852(b)(3)
  // character — a long-term capital gain), and it is
  // REMOVED from the ordinary-dividends total, so no
  // dollar is counted twice.
  const janPaidCapGain =
    janPaid > 0
      ? Math.min(janPaid, Math.max(0, state.strayJanPaidCapGainAmount))
      : 0;
  const janPaidOrdinary = r2(janPaid - janPaidCapGain);
  // The K-1 stray's character split (v112, F4): the K-1
  // amount is the one SIGNED stray. Its box 9a long-term
  // capital gain portion is a portion of a POSITIVE K-1
  // total, clamped to that total, never an amount on top
  // of it: it rides the gains stack below (its long-term
  // character) and is REMOVED from ordinary income, so
  // no dollar is counted twice. A deductible K-1 loss
  // (a negative total) has no gain portion — the portion
  // reads $0 and the loss reduces ordinary income whole,
  // exactly as before this build.
  const k1Total = straySignedAmount(state.strayK1);
  const k1CapGain =
    k1Total > 0
      ? Math.min(k1Total, Math.max(0, state.strayK1CapGainAmount))
      : 0;
  const k1Ordinary = r2(k1Total - k1CapGain);
  // The qualified portion of the reclassified return-of-
  // capital amount (v112, F5): a portion of the
  // strayROCOrdinary total, clamped to it, never an
  // amount on top of it. The whole reclassified amount
  // stays in ordinary dividends below (qualified is a
  // subset of ordinary, the year-to-date pair's shape);
  // this portion additionally rides the qualified-
  // dividends total, priced in the gains stack.
  const rocOrdinary = strayAmount(state.strayROCOrdinary);
  const rocQualified =
    rocOrdinary > 0
      ? Math.min(rocOrdinary, Math.max(0, state.strayROCQualifiedAmount))
      : 0;
  const totalGain = r2(
    state.ytdCapitalGain +
      state.remCapDist[kind] +
      strayAmount(state.strayCapDist) +
      strayAmount(state.strayPlannedSales) +
      strayAmount(state.strayROC) +
      janPaidCapGain +
      k1CapGain -
      strayAmount(state.strayLossHarvest),
  );
  const otherOrdinary = r2(
    state.ytdOtherOrdinary +
      state.remOtherOrdinary[kind] +
      k1Ordinary +
      strayAmount(state.straySeverance) -
      strayAmount(state.strayAgiReducers),
  );
  // The qualified portion of the January-paid total: a
  // portion of the ORDINARY REMAINDER only (v104 — the
  // capital-gain portion above is a gain, never a
  // dividend, qualified or otherwise), validated ≤ that
  // remainder here, the same clamp the year-to-date
  // pair's split applies, never an amount on top of it.
  const janPaidQualified =
    janPaidOrdinary > 0
      ? Math.min(
          janPaidOrdinary,
          Math.max(0, state.strayJanPaidQualifiedAmount),
        )
      : 0;
  const hasSplitBalance =
    state.pretaxBalancePrimary != null || state.pretaxBalanceSpouse != null;
  // The year's taxable sale (proceeds and basis — the same
  // mapping the return below used to inline): with an
  // entered basis the full proceeds ride with the basis
  // beside them; without one the gain alone rides (and a
  // loss rides the basis dial), so the tax still nets it.
  // The shared sale derivation (decemberSaleAmounts —
  // the same one load resolution's starting-pool
  // conversion inverts, S-8).
  const { proceeds: saleProceeds, basisDollars: saleBasisDollars } =
    decemberSaleAmounts(totalGain, state.saleBasis);
  // The harvest's starting pool (round-17 defect 1, as
  // re-homed by SHOULD-3): the console's pool fact is the
  // STARTING pool — the pool at the start of the year,
  // before the year's sales — and the SHARED pricer
  // (pricePlaygroundYear) nets this year's typed sale
  // (and its retired basis) out of it to size the harvest
  // from the remaining pool, exactly as the plan march
  // caps its harvest by the post-settlement balance less
  // its basis dollars. December therefore passes the
  // starting facts straight through: pre-netting them here
  // AND netting in the pricer would net the year's sales
  // twice and understate the harvest. The 100%-basis
  // taxable cash needs no netting either way — it cancels
  // in the available gain (it leaves both the pool and its
  // basis by the same dollars), and the pricer never sells
  // taxable holdings for cash, so there is no 100%-basis
  // cash sale to net there. A $0 pool / 100% basis still
  // prices as a fact, never as unpriced.
  const harvestStarting = ((): {
    pool: number | undefined;
    basisPct: number | undefined;
  } => {
    if (!state.harvestOn) return { pool: undefined, basisPct: undefined };
    const pool = state.harvestPoolAmount;
    const basisPct = state.harvestPoolBasisPct;
    if (pool == null || basisPct == null) {
      return { pool: undefined, basisPct: undefined };
    }
    return { pool: Math.max(0, pool), basisPct: Math.max(0, basisPct) };
  })();
  // The dividend pairs' qualified parts (audit S-8, settled):
  // qualified dividends are a SUBSET of their ordinary total,
  // so each pair's qualified part is clamped to that pair's
  // own total — the year-to-date pair and this case's
  // still-to-come pair separately — never an amount on top
  // of it. This is the same clamp the function's other
  // portion fields already apply (janPaidQualified and
  // rocQualified above are clamped to their own totals), and
  // the shared pricer (pricePlaygroundYear) clamps the summed
  // pair again, so an entered excess prices on neither stack
  // and the year's dividends are counted once, at most their
  // entered totals. Before this clamp an excess priced whole
  // as qualified income — understating the headline draw and
  // the federal tax, and in the still-to-come pair's case
  // silently breaching the ACA cliff the draw was solved
  // against. computeDecemberProjection warns on any pair
  // this clamp trims, so the impossible pair is flagged
  // instead of silently priced.
  const ytdQualified = Math.min(
    Math.max(0, state.ytdOrdinaryDividends),
    Math.max(0, state.ytdQualifiedDividends),
  );
  const remQualified = Math.min(
    Math.max(0, state.remOrdinaryDividends[kind]),
    Math.max(0, state.remQualifiedDividends[kind]),
  );
  return {
    taxYear: state.taxYear,
    filingStatus: state.filingStatus as FilingStatus,
    agePrimary: state.agePrimary ?? 0,
    ageSpouse: joint ? state.ageSpouse : null,
    onMedicarePrimary: state.onMedicarePrimary,
    onMedicareSpouse: joint ? state.onMedicareSpouse : false,
    interest: r2(
      state.ytdInterest + state.remInterest[kind] + strayAmount(state.strayDivInt),
    ),
    ordinaryDividends: r2(
      state.ytdOrdinaryDividends +
        state.remOrdinaryDividends[kind] +
        janPaidOrdinary +
        rocOrdinary,
    ),
    otherOrdinary,
    taxExemptInterest: r2(state.ytdTaxExemptInterest + strayAmount(state.strayTaxExempt)),
    ssPrimary: state.ytdSsPrimary,
    ssSpouse: joint ? state.ytdSsSpouse : 0,
    // The draw rides the spending-draw dial, NOT the
    // conversion dial (M-2 split): the December draw is
    // money taken out TO SPEND, so it is spendable cash and
    // the pricer's cashIn counts it; a Roth conversion is
    // not spendable cash and no longer counts there. The
    // priced tax / MAGI / credit are unchanged — the pricer
    // prices conversion + spendingDraw as one money-out sum,
    // and the cliff solver varies the total from a $0 base
    // either way — so every December figure prices exactly
    // as it did when the draw rode the conversion dial.
    conversion: 0,
    spendingDraw: Math.max(0, draw),
    // Sale proceeds (build v127, round-19 finding 4):
    // the console collects gains only, so the shared
    // engine's cash-in counted only the gain as cash in
    // hand and silently dropped the basis returned on
    // every sale. A sale's proceeds are its gain plus its
    // basis, so with an entered basis the engine gets the
    // full proceeds (stockSold) with the basis beside it
    // (stockBasis) — it nets the same gain (proceeds −
    // basis) for tax, and cash-in counts the proceeds. A
    // loss sale still brings its proceeds in (proceeds =
    // basis − |loss|). Without an entered basis (null) the
    // old mapping stands — a gain alone, and a loss riding
    // the basis dial so the tax still nets it — and the
    // same fallback applies when an entered basis is
    // smaller than the loss (inconsistent input: a real
    // sale's proceeds cannot go negative), so the loss
    // never vanishes from the tax.
    stockSold: saleProceeds,
    stockBasis: saleBasisDollars,
    qualifiedDividends: r2(
      ytdQualified +
        remQualified +
        janPaidQualified +
        rocQualified,
    ),
    // Split by owner when a split was entered (the primary's
    // balance on the primary dial, the spouse's on the
    // spouse dial); the legacy combined balance alone keeps
    // the pre-split single-balance pricing.
    pretaxBalance: hasSplitBalance
      ? state.pretaxBalancePrimary
      : state.pretaxBalance,
    pretaxBalanceSpouse: hasSplitBalance
      ? state.pretaxBalanceSpouse
      : undefined,
    rmdAlreadyReceived: state.rmdAlreadyReceived,
    dependentMagiForAca: strayAmount(state.strayDependent),
    spouseSoleBeneficiary: state.spouseSoleBeneficiary,
    primarySoleBeneficiaryOfSpouse: state.primarySoleBeneficiaryOfSpouse,
    acaHouseholdSize: state.acaHouseholdSize,
    acaBenchmarkAnnual: state.acaBenchmarkAnnual,
    stateRatePct: state.stateRatePct,
    residenceState: state.residenceState,
    itemizedMortgageInterest: state.itemizedMortgageInterest,
    itemizedSaltPaid: state.itemizedSaltPaid,
    itemizedCharitable: state.itemizedCharitable,
    itemizedOther: state.itemizedOther,
    // Education students (v103): the console's entered
    // students for this tax year ride the engine's own
    // education dial, so the shared priceYear §25A step
    // prices them exactly as it prices a Playground year —
    // no credit math lives here. Null (no input yet) and
    // an empty list both price $0 of credits.
    educationStudents: state.educationStudents ?? null,
    // Entering capital-loss carryforward (v111): the
    // console's entered carry-in rides the pricer's own
    // carry-in dials, so the shared applyLossLedger nets
    // it against the year's gains, prices the §1211(b)
    // allowance, splits the federal and Washington gain
    // bases, and reconciles the carry-out — no loss math
    // lives here. Null (no input yet) passes as undefined
    // (absent), which prices exactly as before this build.
    capitalLossCarryInSt: state.carryInCapitalLossSt ?? undefined,
    capitalLossCarryInLt: state.carryInCapitalLossLt ?? undefined,
    capitalLossCarryInStWa: state.carryInCapitalLossStWa ?? undefined,
    capitalLossCarryInLtWa: state.carryInCapitalLossLtWa ?? undefined,
    // Gain harvest (v113, remaining pool round-17 defect
    // 1, netting re-homed by SHOULD-3): the console's pool
    // facts ride the pricer's own harvest dials ONLY while
    // the harvest toggle is on, so the pricer sizes the
    // harvest inside every pricing of the year — the
    // zero-draw pricings, the headline pricing, and every
    // trial pricing inside the cliff solver — and the
    // solved December draw is sized WITH the harvest
    // included (the draw shrinks by the harvested gain
    // when the cliff target binds). The dials carry the
    // STARTING pool and basis — the shared pricer nets
    // this year's taxable sales (and their retired basis)
    // out of them to size the harvest from the remaining
    // pool, exactly as the plan march caps its harvest by
    // the post-settlement balance. Toggle off passes the
    // dials absent, so the year prices bit-identically to
    // before. Toggle on with a fact still null passes that
    // dial absent too — the pricer then sizes no harvest,
    // and computeDecemberProjection carries the
    // gain-harvest-unpriced qualification on every case
    // instead of letting the $0 read as a priced answer.
    harvestPoolAmount: harvestStarting.pool,
    harvestPoolBasisPct: harvestStarting.basisPct,
    // ACA reconciliation facts (build v193, re-audit
    // round 3 SHOULD-4): the console's settlement facts
    // ride the pricer's own reconciliation dials, so the
    // shared pricer prices the filing settlement inside
    // every pricing of the year — its netTaxBill is the
    // settlement and its cashLeftAfterTax is the
    // settlement-based cash left — instead of the console
    // pricing a second, divergent bill at its assembly.
    // The settlement the console reports is still derived
    // at the assembly below (unchanged); the two
    // derivations are the same arithmetic on the same
    // priced readouts, and the fixtures pin them equal on
    // every case shape, so the console's cash left and
    // the engine's can no longer disagree for a year.
    aptcTaken: state.aptcTaken,
    acaEnrollmentPremiumAnnual: state.acaEnrollmentPremiumAnnual,
    acaCoverageReduction: strayAmount(state.strayCoverage),
  };
}

export type DecemberCaseResult = {
  kind: DecemberCaseKind;
  // ACA MAGI at a $0 draw — the year's non-draw income alone.
  nonDrawAcaMagi: number;
  // This case's own maximum safe draw at cliff − buffer
  // (null when the year has no hard ACA cliff to aim at).
  maxDraw: number | null;
  // The case priced AT the headline (likely-case) draw.
  magiAtHeadline: number;
  // cliff − magiAtHeadline: positive = under the cliff by that
  // much, negative = over it. Null when there is no cliff.
  distanceAtHeadline: number | null;
  overCliffAtHeadline: boolean;
  // True when even a $0 draw is over the cliff — non-draw
  // income alone ends the year above 400% FPL (eligibility is
  // lost above 400%; exactly 400% remains eligible).
  overCliffEvenAtZero: boolean;
  // The final allowable ACA credit at the headline draw: the
  // engine-priced credit less any coverage-month reduction
  // entered on the strays checklist (null when no benchmark
  // premium was entered and the case is not over the cliff —
  // over the cliff the allowable credit is $0 by law).
  creditAtHeadline: number | null;
  // Excess-APTC repayment at the headline draw. For tax
  // years 2026 and later there are NO repayment caps
  // (P.L. 119-21 §71305), so ANY advance credit taken above
  // the final allowable credit is repaid in full — even
  // when MAGI lands UNDER the cliff. max(0, APTC taken −
  // final credit); the over-the-cliff case is the same
  // formula at a $0 final credit, i.e. the whole APTC
  // taken. For years before 2026 the capped-repayment rules
  // are NOT modeled: the repayment is $0 when APTC taken is
  // at or below the final credit, and null (unmodeled) when
  // APTC taken exceeds it. The reconciliation runs on the
  // EFFECTIVE final credit (see computeDecemberProjection):
  // the priced credit when there is one, a known $0 when
  // nobody in the household can be on the marketplace (the
  // engine's ACA branch does not apply), and null only when
  // the credit is genuinely unpriced (a marketplace-eligible
  // household with no benchmark entered).
  excessAptcRepayment: number | null;
  // The other side of the same reconciliation: when the APTC
  // taken is BELOW the final allowable credit, this further
  // credit is still due at filing. max(0, effective final
  // credit − APTC taken) in ALL years whenever the effective
  // credit is known; null only when the credit is genuinely
  // unpriced.
  creditStillDue: number | null;
  // The headline repayment figure: excessAptcRepayment when
  // it is priced, else $0. Kept as the always-a-number field
  // the case cards lead with.
  repaymentExposure: number;
  federalTaxAtHeadline: number;
  totalTaxAtHeadline: number;
  // Education credits at the headline draw (v103), read
  // straight off the engine result for the priced year —
  // the shared priceYear §25A step's own figures, no new
  // pricing here. educationAotc / educationLlc are the
  // tentative credits after the §25A(d) phase-out under
  // the winning allocation (educationChoice names it);
  // educationNonrefundable is the portion already applied
  // inside federalTaxAtHeadline (it reduced the income
  // tax, never below $0); educationRefundable is the
  // refundable AOTC portion — reported by the engine
  // separately and NEVER netted into federalTax or
  // totalTax — which the settlement below credits beside
  // the ACA premium credit, exactly as the plan's score
  // identity does. All $0 / "none" when no student with
  // expenses is entered.
  educationAotcAtHeadline: number;
  educationLlcAtHeadline: number;
  educationChoiceAtHeadline: "aotc" | "llc" | "none";
  educationNonrefundableAtHeadline: number;
  educationRefundableAtHeadline: number;
  // True when at least one entered student carries
  // qualified expenses for the year (the credits above
  // were priced from entered expenses — whether or not
  // the phase-out or the liability left them at $0).
  hasEducationExpenses: boolean;
  // Capital-loss carry-out at the headline draw (v111):
  // the entering carryforward (plus any of the year's own
  // net loss) still unused after this case's headline
  // pricing — the part that carries into next year, by
  // character, read straight off the priced year's own
  // reconciled ledger result (pricePlaygroundYear's
  // lossCarryOut*), no new loss math here. The Wa fields
  // are the Washington-attributable portions of the same
  // carry-out. All $0 when no carry-in was entered and
  // the year's own result is not a net loss (R1: a newly
  // realized loss carries its own reconciled carry-out
  // even with no carry-in entered).
  lossCarryOutStAtHeadline: number;
  lossCarryOutLtAtHeadline: number;
  lossCarryOutStWaAtHeadline: number;
  lossCarryOutLtWaAtHeadline: number;
  // Gain harvest (v113): the long-term gain the year's
  // harvest realized into the 0% band, read straight off
  // the priced year (pricePlaygroundYear's harvestedGain)
  // at the headline draw and at a $0 draw — already inside
  // that case's MAGI, credit, and taxes above; these
  // fields only name it. $0 when the harvest toggle is
  // off, when no gain fit the band, or when the harvest
  // could not be priced at all (gainHarvestUnpriced).
  harvestedGainAtHeadline: number;
  harvestedGainAtZeroDraw: number;
  // The harvest qualification (v113): true when the
  // harvest toggle is ON but a pool / basis fact is
  // missing (no console entry and no Tax Plan record
  // fact), so no harvest is priced and the settlement
  // EXCLUDES gain harvesting. The console renders this
  // beside every settlement figure in that state, like
  // excludesEducationCredits — a settlement is never
  // presented as final while the harvest is unpriced.
  gainHarvestUnpriced: boolean;
  // The settlement qualification (v103): true when NO
  // education expenses are entered, so no education
  // credit is priced and the settlement EXCLUDES
  // education credits. The console renders this beside
  // every settlement figure in that state — a settlement
  // is never presented as final while the credit is
  // unpriced.
  excludesEducationCredits: boolean;
  // Projected-tax-bill readouts (build v50): the same
  // priced year at the headline draw, read straight off the
  // engine result — no new pricing. totalIncomeAtHeadline
  // is the year's adjusted gross income (AGI) (the amount
  // the return strikes before deductions; the December
  // assembly nets its above-the-line reducers into income
  // itself, so AGI is the figure this readout carries),
  // taxableIncomeAtHeadline its taxable income, and
  // stateTaxAtHeadline the state component inside
  // totalTaxAtHeadline ($0 at a 0% flat rate; the
  // Washington excise when residence prices it).
  totalIncomeAtHeadline: number;
  taxableIncomeAtHeadline: number;
  stateTaxAtHeadline: number;
  // The filing settlement at the headline draw, in core so
  // no client ever does this arithmetic: total tax, less
  // the part of the final credit not already advanced
  // (creditStillDue), plus any excess advance credit to
  // repay (excessAptcRepayment), less the refundable
  // education credit (educationRefundableAtHeadline —
  // credited beside the ACA premium credit, the plan
  // score identity's treatment; the nonrefundable
  // education portion is already inside the tax) —
  // equivalently totalTax − effective final credit +
  // APTC taken − refundable education credit whenever the
  // effective credit is known and the repayment is modeled.
  // Null only when the repayment is unmodeled (a pre-2026
  // year whose APTC exceeds its effective final credit) or
  // the credit is genuinely unpriced — no single settlement
  // figure is then shown, and netSettleNote says which.
  // A no-marketplace year (nobody marketplace-eligible)
  // reconciles against a known $0 credit, so its net is a
  // number even though creditAtHeadline itself stays null.
  // Negative = a net refund at filing. The figure is BEFORE
  // withholding and estimated payments, which the console
  // does not track.
  netSettleAtHeadline: number | null;
  // Why no single settlement figure is shown: null whenever
  // netSettleAtHeadline is a number; otherwise the reason —
  // the credit is genuinely unpriced, or a pre-2026 excess
  // repayment is unmodeled. The console renders it verbatim.
  netSettleNote: string | null;
  // Cash left after tax at the headline draw (contract
  // v114): the priced year's cash in (pricePlaygroundYear's
  // cashIn — every dollar of cash the case's entered income
  // brings in, the draw included) plus the taxable cash
  // for the year (build v125 — 100%-basis cash, $0
  // MAGI, added at the assembly, never inside the priced
  // year) minus this case's net tax bill, the settlement
  // itself (netSettleAtHeadline), so the figure is null
  // exactly when no settlement is shown and netSettleNote
  // names why. Before any spending: what the year leaves
  // in hand once its tax is settled. Build v193 (re-audit
  // round 3 SHOULD-4): the figure is DERIVED as the
  // priced year's own cashLeftAfterTax plus the taxable
  // cash — the shared pricer prices this settlement as
  // its net tax bill when the console's reconciliation
  // facts ride its dials (decemberCaseInputs), so the
  // engine's cash left for the year and the console's
  // are the same figure, not two derivations of it.
  cashLeftAtHeadline: number | null;
  // Cash in at the headline draw (build v116): the
  // priced year's cash in (pricePlaygroundYear's cashIn on
  // the same pricing) plus the taxable cash for the year
  // (build v125) — the cash-in figure the cash-left
  // tooltip names as priced. Null exactly when the
  // settlement is null, like cashLeftAtHeadline.
  cashInAtHeadline: number | null;
  // Annual spending and the "enough for the year" comparison
  // at the headline draw (build v126): the annual
  // spending in dollars — the caller's resolved annual
  // spending (the Tax Plan record's, falling back to the
  // Retirement calculator's default) — echoed, and
  // cashLeftAtHeadline minus that spending: positive =
  // enough for the year, negative = short. A pure readout
  // of the same pricing (the spending never enters the draw,
  // MAGI, credit, tax, or settlement); null exactly when no
  // spending was given or no settlement is shown.
  annualSpendingAtHeadline: number | null;
  cashLeftVsSpendingAtHeadline: number | null;
};

export type DecemberProjectionResult = {
  priced: boolean;
  reason: string | null;
  cliff: number | null;
  // cliff − buffer: the MAGI line the headline draw aims at.
  targetMagi: number | null;
  headlineDraw: number | null;
  headlineText: string;
  zeroDrawOverCliff: boolean;
  cases: DecemberCaseResult[];
  warnings: string[];
};

const UNPRICED: DecemberProjectionResult = {
  priced: false,
  reason: null,
  cliff: null,
  targetMagi: null,
  headlineDraw: null,
  headlineText: "",
  zeroDrawOverCliff: false,
  cases: [],
  warnings: [],
};

/* Price the December projection. Pure: same inputs, same
   result, no state read or written. */
export function computeDecemberProjection(
  state: DecemberState,
  // Annual spending in CENTS (build v126): the caller's
  // resolved annual spending — the Tax Plan record's
  // annualSpendingCents, falling back to the Retirement
  // calculator's default. Optional, never console state and
  // never saved; absent / null = no comparison is shown and
  // every other figure prices exactly as before.
  annualSpendingCents?: number | null,
): DecemberProjectionResult {
  if (state.agePrimary == null || state.agePrimary <= 0) {
    return {
      ...UNPRICED,
      reason:
        "Enter the primary filer's age for the tax year — the year cannot be priced without it.",
      headlineText: "Enter an age to price the year.",
    };
  }
  // M-4 (engines review round 2, MUST, settled STAND): on a
  // joint return the spouse's age is a pricing fact of the
  // same standing as the primary's. The shared pricer can
  // price the spouse's RMD only when her age is known (its
  // spouse-RMD branch requires ageSpouse != null); with the
  // age blank it silently priced her RMD as $0, understating
  // MAGI by the whole RMD and claiming credit the household
  // is not owed. The settlement's worked example, pinned by
  // dec-spouse-age-blank-blocks-pricing below: spouse 75
  // with $246,000 (her RMD $246,000 / 24.6 = $10,000) and
  // $70,000 of posted ordinary income, entered with her age
  // blank, priced a $9,600 headline draw and a $12,071.84
  // credit — where the true MAGI at that draw is $89,600,
  // over the $84,600 cliff, and the credit is $0. Mirror
  // the primary-age guard above: a blank spouse age on a
  // joint return blocks pricing the same way. Single and
  // head-of-household returns carry no spouse age (the form
  // stores null for them) and price exactly as before.
  if (
    state.filingStatus === "mfj" &&
    (state.ageSpouse == null || state.ageSpouse <= 0)
  ) {
    return {
      ...UNPRICED,
      reason:
        "Enter the spouse's age for the tax year — the year cannot be priced without it.",
      headlineText: "Enter an age to price the year.",
    };
  }
  const warnings: string[] = [];
  const rangeLines: [string, DecemberRange][] = [
    ["Capital-gain distributions", state.remCapDist],
    ["Interest still to come", state.remInterest],
    ["Ordinary dividends still to come", state.remOrdinaryDividends],
    ["Qualified dividends still to come", state.remQualifiedDividends],
    ["Other income still to come", state.remOtherOrdinary],
  ];
  for (const [label, r] of rangeLines) {
    if (!(r.low <= r.likely && r.likely <= r.high)) {
      warnings.push(
        `${label}: the low / likely / high amounts are out of order — the cases below price them exactly as entered.`,
      );
    }
  }
  // Dividend-pair clamp (audit S-8, settled): qualified
  // dividends are part of their ordinary total, so a
  // qualified figure above its total is a pair that cannot
  // occur — decemberCaseInputs clamps each pair's qualified
  // part to that pair's total (and the shared pricer clamps
  // the summed pair), so the excess is not counted. The
  // console names it here, matching the Playground's note
  // on its own dials, instead of letting the excess drop
  // out silently.
  if (state.ytdQualifiedDividends > state.ytdOrdinaryDividends) {
    warnings.push(
      `Qualified dividends already in (${fmt(state.ytdQualifiedDividends)}) can't exceed the total ordinary dividends already in (${fmt(state.ytdOrdinaryDividends)}) — the qualified figure is part of that total, so the excess isn't counted: the qualified part prices as ${fmt(state.ytdOrdinaryDividends)} and the non-qualified part as $0.`,
    );
  }
  // Audit N-5: one warning per impossible still-to-come
  // case, naming WHICH case it is (low / likely / high),
  // the two fields, and their entered values — the earlier
  // single warning said only that some case was impossible,
  // leaving the user to hunt for which one.
  for (const k of DECEMBER_CASE_KINDS) {
    const qualified = state.remQualifiedDividends[k];
    const total = state.remOrdinaryDividends[k];
    if (qualified > total) {
      warnings.push(
        `Qualified dividends still to come in the ${k} case (${fmt(qualified)}) can't exceed the total ordinary dividends still to come in the ${k} case (${fmt(total)}) — the qualified figure is part of that total, so the excess isn't counted: the ${k} case's qualified part prices as ${fmt(total)} and its non-qualified part as $0.`,
      );
    }
  }
  // Stray-portion clamps (re-audit NICE-TO-HAVE N-6): the
  // four stray character portions in decemberCaseInputs —
  // the January-paid capital-gain portion and qualified
  // portion, the K-1 box 9a gain portion, and the
  // reclassified return-of-capital qualified portion — are
  // each a portion of their stray's total (the January-paid
  // qualified portion of that total's ORDINARY REMAINDER,
  // the total less its clamped capital-gain portion), and
  // the assembly clamps each one to that limit, exactly as
  // the S-8 dividend pairs are clamped. Unlike the pairs,
  // these trims were silent: no warning named them. Each
  // trim now warns here, in the S-8 warning's spirit —
  // naming the portion, its entered figure, the limit it
  // was trimmed to fit, the amount trimmed, and the figure
  // it prices as — computed with the assembly's own clamp
  // arithmetic, in its own order, so a warning fires
  // exactly when (and by exactly how much) a trim occurs
  // and nowhere else. Pricing and the clamps are unchanged.
  {
    const janPaid = strayAmount(state.strayJanPaid);
    const janCapEntered = Math.max(0, state.strayJanPaidCapGainAmount);
    const janCapClamped =
      janPaid > 0 ? Math.min(janPaid, janCapEntered) : 0;
    if (janCapEntered > janCapClamped) {
      warnings.push(
        `January-paid distributions: the capital-gain portion (${fmt(janCapEntered)}) can't exceed the January-paid total (${fmt(janPaid)}) — the portion is part of that total, so ${fmt(r2(janCapEntered - janCapClamped))} is trimmed and isn't counted: the capital-gain portion prices as ${fmt(janCapClamped)}.`,
      );
    }
    const janOrdinaryRemainder = r2(janPaid - janCapClamped);
    const janQualEntered = Math.max(0, state.strayJanPaidQualifiedAmount);
    const janQualClamped =
      janOrdinaryRemainder > 0
        ? Math.min(janOrdinaryRemainder, janQualEntered)
        : 0;
    if (janQualEntered > janQualClamped) {
      warnings.push(
        `January-paid distributions: the qualified-dividends portion (${fmt(janQualEntered)}) can't exceed the January-paid ordinary remainder (${fmt(janOrdinaryRemainder)}) — the total (${fmt(janPaid)}) less its capital-gain portion (${fmt(janCapClamped)}), and the qualified figure is part of that remainder, so ${fmt(r2(janQualEntered - janQualClamped))} is trimmed and isn't counted: the qualified portion prices as ${fmt(janQualClamped)}.`,
      );
    }
    const k1Total = straySignedAmount(state.strayK1);
    const k1Entered = Math.max(0, state.strayK1CapGainAmount);
    const k1Clamped = k1Total > 0 ? Math.min(k1Total, k1Entered) : 0;
    if (k1Entered > k1Clamped) {
      warnings.push(
        k1Total > 0
          ? `K-1 income: the long-term capital gain portion (box 9a) (${fmt(k1Entered)}) can't exceed the K-1 total (${fmt(k1Total)}) — the portion is part of that total, so ${fmt(r2(k1Entered - k1Clamped))} is trimmed and isn't counted: the capital-gain portion prices as ${fmt(k1Clamped)} and the rest of the K-1 amount prices as ordinary income.`
          : `K-1 income: the long-term capital gain portion (box 9a) (${fmt(k1Entered)}) can't apply when the K-1 total (${fmt(k1Total)}) is not positive — a K-1 amount that is not a gain has no gain portion, so the whole ${fmt(r2(k1Entered - k1Clamped))} is trimmed and isn't counted: the capital-gain portion prices as $0 and the K-1 amount prices as ordinary income.`,
      );
    }
    const rocOrdinary = strayAmount(state.strayROCOrdinary);
    const rocEntered = Math.max(0, state.strayROCQualifiedAmount);
    const rocClamped =
      rocOrdinary > 0 ? Math.min(rocOrdinary, rocEntered) : 0;
    if (rocEntered > rocClamped) {
      warnings.push(
        `Return of capital: the qualified-dividends portion of the reclassified amount (${fmt(rocEntered)}) can't exceed the reclassified ordinary-dividend total (${fmt(rocOrdinary)}) — the qualified figure is part of that total, so ${fmt(r2(rocEntered - rocClamped))} is trimmed and isn't counted: the qualified portion prices as ${fmt(rocClamped)}.`,
      );
    }
  }
  // Round-5 character provenance: the amounts below price
  // exactly as split on the checklist — the flags change
  // no figure — but a legacy amount saved before its
  // split existed has an UNCONFIRMED tax character, and
  // the character is worth real tax (the round-5 cases:
  // $2,465 on the ROC split, $2,400 on the January-paid
  // qualified portion), so the projection names it until
  // the user edits the matching character control — an
  // unrelated save no longer clears the warning (round-6).
  if (state.legacyRocSplitUnconfirmed) {
    warnings.push(
      "Return of capital: the amount on the checklist was saved before the capital-gain / ordinary-dividend split existed, so its tax character is unconfirmed — it prices exactly as split below; check whether any of it was reclassified as an ordinary dividend and enter that part under the ordinary-dividend return-of-capital item.",
    );
  }
  if (state.legacyJanPaidSplitUnconfirmed) {
    warnings.push(
      "January-paid distributions: the amount on the checklist was saved before the qualified-dividend portion existed, so its tax character is unconfirmed — it prices with the qualified portion exactly as entered below; check what part of it is qualified dividends.",
    );
  }
  // Zero-draw pricings first: they carry the cliff and each
  // case's non-draw MAGI.
  const zeroInputs = DECEMBER_CASE_KINDS.map((k) => decemberCaseInputs(state, k, 0));
  const zeroResults = zeroInputs.map((inp) => pricePlaygroundYear(inp));
  const likelyZero = zeroResults[1]!;
  // The cliff this console aims at: the engine reports a
  // 400%-of-FPL figure for every ACA year, but before 2026
  // that figure is NOT a cliff — the enhanced-credit years
  // price no cutoff (overCliff can never trigger and the
  // solver returns null) — so a pre-2026 year is a no-cliff
  // year here: no target, no headline draw, and the per-case
  // cliff fields read null exactly as they do when nobody
  // is on the marketplace.
  const cliff = state.taxYear >= 2026 ? likelyZero.aca.cliff : null;
  const targetMagi = cliff == null ? null : r2(cliff - state.bufferDollars);
  // Audit N-3 (settled), wording corrected by audit N-7: a
  // buffer at or above the cliff makes the target zero or
  // negative. With $0 of income, MAGI is $0, which EQUALS
  // that target when the buffer is exactly the cliff (target
  // $0) and is above it only when the buffer is above the
  // cliff (target below $0) — $0 of income does not exceed
  // the target in the exact-equality case. Either way no
  // positive draw fits at or under the target, so the $0
  // draw that follows is caused by the buffer alone, not by
  // the year's income. Name that here so the headline below
  // and the warnings list do not attribute the $0 draw to
  // income that leaves no room.
  const bufferExceedsCliff = cliff != null && state.bufferDollars >= cliff;
  if (bufferExceedsCliff) {
    warnings.push(
      `Your buffer (${fmt(state.bufferDollars)}) is as large as the cliff (${fmt(cliff)}) itself, so the target MAGI (cliff − buffer = ${fmt(targetMagi ?? 0)}) is zero or below — with $0 of income, MAGI is $0, which equals that target when it is $0 and is above it when it is below $0, so no room is left for a draw. The buffer alone makes the target unreachable, so the $0 draw is because the buffer is at or above the cliff, not because of your income. Lower the buffer below the cliff to leave room for a draw.`,
    );
  }

  // The headline: the likely case's maximum safe draw at
  // cliff − buffer, solved against the engine.
  const headlineDraw =
    cliff == null
      ? null
      : solvePlaygroundAcaCliffFill(zeroInputs[1]!, state.bufferDollars);
  const drawForPricing = headlineDraw ?? 0;

  // Round-2 nit: a $0 headline can bind for two different
  // reasons — the year's income already uses the room under
  // the target, or the entered pre-tax balance is $0 and
  // there is simply nothing to draw. The headline must name
  // the real one. The balance binds SOLELY when a balance
  // was entered, the entered total is exactly $0, and the
  // same solve with NO balance entered (no cap) finds a
  // positive draw — i.e. income room exists and only the
  // empty balance holds the draw at $0.
  // S-12: the entered total reads the filer's balance alone
  // on a non-joint filing — a spouse balance left on the dial
  // by a switch to single is stale (the solver's cap already
  // excludes it via countedSpousePretax in rothOptimizer.ts),
  // and counting it here would suppress the empty-balance
  // naming below for a filer whose own entered balance is $0.
  const enteredTotalBalance =
    state.pretaxBalancePrimary != null || state.pretaxBalanceSpouse != null
      ? r2(
          (state.pretaxBalancePrimary ?? 0) +
            (state.filingStatus === "mfj"
              ? (state.pretaxBalanceSpouse ?? 0)
              : 0),
        )
      : state.pretaxBalance;
  const uncappedDraw =
    cliff != null && headlineDraw === 0 && enteredTotalBalance === 0
      ? solvePlaygroundAcaCliffFill(
          {
            ...zeroInputs[1]!,
            pretaxBalance: null,
            pretaxBalanceSpouse: undefined,
          },
          state.bufferDollars,
        )
      : null;
  const zeroBalanceBinds = uncappedDraw != null && uncappedDraw > 0;

  const coverageReduction = strayAmount(state.strayCoverage);
  // Education coverage (v103): expenses are entered when at
  // least one entered student carries a positive amount —
  // a null list (no input yet), an empty list, and a list of
  // $0 rows all price $0 of credits, and the first of those
  // (and any $0-only entry) leaves the settlement carrying
  // the excludes-education-credits qualification below.
  const hasEducationExpenses = (state.educationStudents ?? []).some(
    (s) => s.expenses > 0,
  );
  // Gain-harvest pricing state (v113): the harvest is
  // priced whenever the toggle is on AND both pool facts
  // are present (entered in the console, or resolved at
  // load from the Tax Plan record — computeDecemberProjection
  // reads the state it is given, so a resolved state prices
  // the harvest and an unresolved one does not). Toggle on
  // with a fact missing prices NO harvest and carries the
  // qualification on every case below, plus the warning at
  // the end — the settlement excludes gain harvesting
  // rather than silently pricing it as $0.
  const gainHarvestUnpriced =
    state.harvestOn &&
    (state.harvestPoolAmount == null || state.harvestPoolBasisPct == null);
  // Taxable cash for the year (build v125): cash taken
  // from taxable at 100% basis — $0 MAGI, so it never
  // enters the priced year above (the solver, the cases'
  // MAGI, credit, and taxes are all priced without it) and
  // is added to cash-in / cash-left at the assembly below,
  // dollar for dollar, in every case. The headline draw is
  // unchanged: the solver sizes the pre-tax draw by MAGI
  // room, and this amount uses none.
  const taxableFunded = Math.max(0, state.taxableFunded ?? 0);
  // "Enough for the year" (build v126): the annual
  // spending in dollars, or null when none was given. A
  // comparison-only figure — it never enters the draw, MAGI,
  // credit, tax, or settlement below.
  const annualSpending =
    annualSpendingCents != null && annualSpendingCents > 0
      ? annualSpendingCents / 100
      : null;
  const cases: DecemberCaseResult[] = DECEMBER_CASE_KINDS.map((kind, i) => {
    const zero = zeroResults[i]!;
    const atHeadline = pricePlaygroundYear(
      decemberCaseInputs(state, kind, drawForPricing),
    );
    const overAtHeadline = cliff != null && atHeadline.aca.overCliff;
    // The final allowable credit: the engine's benchmark-
    // based credit, capped FIRST at the enrollment premium
    // when one was entered (Form 8962's lesser-of: the
    // credit never exceeds the premium of the plan actually
    // enrolled in), then less any coverage-month reduction
    // (a member ineligible in a month shrinks that month's
    // credit whatever the annual MAGI says). Over the cliff
    // the allowable credit is $0 by law, benchmark entered
    // or not.
    const benchmarkCredit = atHeadline.aca.credit;
    const cappedCredit =
      benchmarkCredit == null
        ? null
        : state.acaEnrollmentPremiumAnnual == null
          ? benchmarkCredit
          : Math.min(benchmarkCredit, state.acaEnrollmentPremiumAnnual);
    const finalCredit: number | null = overAtHeadline
      ? 0
      : cappedCredit == null
        ? null
        : r2(Math.max(0, cappedCredit - coverageReduction));
    // ACA reconciliation (round-7 fix B, build v54):
    // creditStillDue prices in ALL years whenever the
    // credit is known. The repayment: for 2026 and later
    // there are no repayment caps (P.L. 119-21 §71305) —
    // every excess APTC dollar is repaid, under the cliff
    // as well as over it. Before 2026 the capped-repayment
    // rules are not modeled: $0 when APTC taken is at or
    // below the final credit, null (unmodeled) when it
    // exceeds it.
    //
    // The reconciliation runs on the EFFECTIVE final
    // credit, which distinguishes two cases the priced
    // credit (finalCredit, surfaced as creditAtHeadline)
    // leaves null alike: when nobody in the household can
    // be on the marketplace — the same test
    // decemberBenchmarkTier applies — the allowable credit
    // is $0 BY CONSTRUCTION (known-zero), so the
    // reconciliation prices against $0; when someone IS
    // marketplace-eligible but no benchmark was entered,
    // the credit is genuinely unpriced and the
    // reconciliation stays null. creditAtHeadline itself
    // is unchanged: it remains the engine's priced credit.
    const primaryOnAca = !state.onMedicarePrimary;
    const spouseOnAca =
      state.filingStatus === "mfj" && !state.onMedicareSpouse;
    const acaInPlay = primaryOnAca || spouseOnAca;
    const effectiveFinalCredit: number | null =
      finalCredit != null ? finalCredit : acaInPlay ? null : 0;
    const creditStillDue: number | null =
      effectiveFinalCredit != null
        ? r2(Math.max(0, effectiveFinalCredit - state.aptcTaken))
        : null;
    const excessAptcRepayment: number | null =
      effectiveFinalCredit == null
        ? null
        : state.taxYear >= 2026
          ? r2(Math.max(0, state.aptcTaken - effectiveFinalCredit))
          : state.aptcTaken <= effectiveFinalCredit
            ? 0
            : null;
    // The projected tax bill's net (build v50, round-7
    // fix B; v103 for the education term): the filing
    // settlement for this case at the headline draw — see
    // the field's note on DecemberCaseResult. The refundable
    // education credit is credited beside the ACA premium
    // credit (the plan score identity's treatment): it
    // reduces the settlement dollar for dollar and is never
    // netted into the floored federal tax itself. Null
    // whenever the repayment is null, so no single figure is
    // shown for a case whose repayment is unmodeled or whose
    // credit is unpriced; netSettleNote then names which of
    // the two it is (the unpriced reason wins whenever the
    // credit itself is unpriced, in any year).
    const netSettleAtHeadline: number | null =
      excessAptcRepayment == null
        ? null
        : r2(
            atHeadline.totalTax -
              (creditStillDue ?? 0) +
              excessAptcRepayment -
              atHeadline.educationRefundable,
          );
    const netSettleNote: string | null =
      netSettleAtHeadline != null
        ? null
        : effectiveFinalCredit == null
          ? "No benchmark premium is entered, so the ACA credit can't be priced and no single settlement figure is shown."
          : "For years before 2026 the advance-credit repayment isn't modeled, so no single settlement figure is shown.";
    // Cash left after tax (build v114/v125) — computed
    // once here and reused by the "enough for the year"
    // comparison below, so the two figures can never drift
    // apart. Build v193 (re-audit round 3 SHOULD-4): the
    // figure is read off the priced year itself —
    // atHeadline.cashLeftAfterTax, plus the taxable cash
    // the assembly adds (build v125) — because the shared
    // pricer now prices THIS settlement as its net tax
    // bill whenever the console's reconciliation facts
    // ride its dials (decemberCaseInputs), so the
    // engine's cash left and the console's are one figure
    // by construction. The settlement above is unchanged
    // (the same derivation, still computed here for the
    // case's own settlement fields); it equals the
    // pricer's net tax bill on every case whose settlement
    // prices, and the fixtures pin that equality — so
    // this readout is value-identical to the previous
    // cashIn + taxableFunded − settlement derivation on
    // every case, while a future drift in either
    // derivation fails the suite instead of showing the
    // user two cash-left figures for one year. Null
    // exactly when no settlement is shown, as before.
    const cashLeftAtHeadline: number | null =
      netSettleAtHeadline == null
        ? null
        : r2(atHeadline.cashLeftAfterTax + taxableFunded);
    return {
      kind,
      nonDrawAcaMagi: zero.acaMagi,
      maxDraw:
        cliff == null
          ? null
          : solvePlaygroundAcaCliffFill(zeroInputs[i]!, state.bufferDollars),
      magiAtHeadline: atHeadline.acaMagi,
      distanceAtHeadline:
        cliff == null ? null : r2(cliff - atHeadline.acaMagi),
      overCliffAtHeadline: overAtHeadline,
      overCliffEvenAtZero: cliff != null && zero.aca.overCliff,
      creditAtHeadline: finalCredit,
      excessAptcRepayment,
      creditStillDue,
      repaymentExposure: excessAptcRepayment ?? 0,
      federalTaxAtHeadline: atHeadline.federalTax,
      totalTaxAtHeadline: atHeadline.totalTax,
      educationAotcAtHeadline: atHeadline.educationAotc,
      educationLlcAtHeadline: atHeadline.educationLlc,
      educationChoiceAtHeadline: atHeadline.educationChoice,
      educationNonrefundableAtHeadline: atHeadline.educationNonrefundable,
      educationRefundableAtHeadline: atHeadline.educationRefundable,
      lossCarryOutStAtHeadline: atHeadline.lossCarryOutSt,
      lossCarryOutLtAtHeadline: atHeadline.lossCarryOutLt,
      lossCarryOutStWaAtHeadline: atHeadline.lossCarryOutStWa,
      lossCarryOutLtWaAtHeadline: atHeadline.lossCarryOutLtWa,
      harvestedGainAtHeadline: atHeadline.harvestedGain,
      harvestedGainAtZeroDraw: zero.harvestedGain,
      gainHarvestUnpriced,
      hasEducationExpenses,
      excludesEducationCredits: !hasEducationExpenses,
      totalIncomeAtHeadline: atHeadline.agi,
      taxableIncomeAtHeadline: atHeadline.taxableIncome,
      stateTaxAtHeadline: atHeadline.stateTax,
      netSettleAtHeadline,
      netSettleNote,
      cashLeftAtHeadline,
      cashInAtHeadline:
        netSettleAtHeadline == null
          ? null
          : r2(atHeadline.cashIn + taxableFunded),
      // "Enough for the year" (build v126): the annual
      // spending echoed, and cash left minus that spending.
      // Null exactly when no spending was given or no
      // settlement is shown.
      annualSpendingAtHeadline:
        netSettleAtHeadline == null ? null : annualSpending,
      cashLeftVsSpendingAtHeadline:
        cashLeftAtHeadline == null || annualSpending == null
          ? null
          : r2(cashLeftAtHeadline - annualSpending),
    };
  });

  const likelyCase = cases[1]!;
  const zeroDrawOverCliff = likelyCase.overCliffEvenAtZero;

  // Build v194 (re-audit round 3 SHOULD-5): the $0-draw
  // MAGI the headline below reasons from INCLUDES any
  // priced gain harvest — the harvest is sized inside
  // every pricing, the zero-draw pricings included — so
  // when the harvest is what puts MAGI over the cliff (or
  // uses up the room under cliff − buffer), blaming
  // "income already posted" misattributes the cause:
  // posted income without the harvest can sit under the
  // cliff with room to spare. The counterfactual is
  // priced, not derived: the likely case is re-priced at
  // a $0 draw with the harvest toggle off (the same dials
  // decemberCaseInputs builds, the harvest dials absent),
  // because the harvest's MAGI lift is NOT its gross
  // harvested gain — an entering loss carryforward absorbs
  // harvested gains first, so only a re-pricing nets that
  // out (the absorbed-harvest fixture below pins a $10,000
  // gross harvest that moves MAGI not at all).
  // harvestBreachMagi is that harvest-free MAGI, set only
  // when the harvest alone tips the likely case over the
  // cliff (over with it, not over without it);
  // harvestNoRoomMagi is it when the harvest alone uses
  // up the room under the target (the harvest-free solve
  // finds a positive draw the priced solve cannot). Both
  // stay null whenever the harvest is off, unpriced,
  // harvests $0 at a $0 draw, or is not the tipping cause
  // — posted income over the cliff (or over the target)
  // on its own keeps the original income wording, exactly
  // as before. No priced figure moves: the re-pricings
  // feed only these two headline wordings.
  const harvestPricedAtZero =
    state.harvestOn &&
    !gainHarvestUnpriced &&
    likelyCase.harvestedGainAtZeroDraw > 0 &&
    cliff != null;
  const likelyZeroNoHarvest = harvestPricedAtZero
    ? pricePlaygroundYear(
        decemberCaseInputs({ ...state, harvestOn: false }, "likely", 0),
      )
    : null;
  const harvestBreachMagi: number | null =
    likelyZeroNoHarvest != null &&
    zeroDrawOverCliff &&
    !likelyZeroNoHarvest.aca.overCliff
      ? likelyZeroNoHarvest.acaMagi
      : null;
  const harvestNoRoomMagi: number | null = ((): number | null => {
    if (likelyZeroNoHarvest == null || zeroDrawOverCliff) return null;
    if (headlineDraw == null || headlineDraw > 0) return null;
    if (bufferExceedsCliff || zeroBalanceBinds) return null;
    const drawWithoutHarvest = solvePlaygroundAcaCliffFill(
      decemberCaseInputs({ ...state, harvestOn: false }, "likely", 0),
      state.bufferDollars,
    );
    return drawWithoutHarvest != null && drawWithoutHarvest > 0
      ? likelyZeroNoHarvest.acaMagi
      : null;
  })();

  let headlineText: string;
  if (cliff == null) {
    headlineText = !likelyZero.aca.applies
      ? "No ACA cliff applies this year — everyone in the household is on Medicare, so there is no premium credit to protect and no cliff-sized draw to compute."
      : state.taxYear < 2026
        ? "No ACA cliff this year — the draw is not cliff-constrained."
        : "No ACA cliff to aim at — enter the ACA household size for the year to size the December draw.";
  } else if (zeroDrawOverCliff && harvestBreachMagi != null) {
    headlineText = `No December draw is safe this year: the gain harvest puts MAGI at ${fmt(likelyCase.nonDrawAcaMagi)}, over the ${fmt(cliff)} cliff before any draw — without the harvest, MAGI would be ${fmt(harvestBreachMagi)}, under the cliff, so the harvest itself is what breaches the cliff, not income already posted, and no draw can fix that year while the harvest stands. The credit is lost in the likely case and the advance credit taken (${fmt(state.aptcTaken)}) is repaid.`;
  } else if (zeroDrawOverCliff) {
    headlineText = `No December draw is safe this year: income already posted puts MAGI at ${fmt(likelyCase.nonDrawAcaMagi)}, over the ${fmt(cliff)} cliff before any draw — no draw can fix that year. The credit is lost in the likely case and the advance credit taken (${fmt(state.aptcTaken)}) is repaid.`;
  } else if (bufferExceedsCliff) {
    headlineText = `Take no December draw: your ${fmt(state.bufferDollars)} buffer is as large as the ${fmt(cliff)} cliff, so the target MAGI (cliff − buffer = ${fmt(targetMagi ?? 0)}) is zero or below — with $0 of income, MAGI is $0, which equals that target when it is $0 and is above it when it is below $0, so no room is left for a draw. The $0 draw is because the buffer alone makes the target unreachable, not because of your income.`;
  } else if (zeroBalanceBinds) {
    headlineText =
      "Take no December draw: the pre-tax balance is $0, so there is nothing to draw.";
  } else if (
    headlineDraw != null &&
    headlineDraw <= 0 &&
    harvestNoRoomMagi != null
  ) {
    headlineText = `Take no December draw: the gain harvest leaves no room under the cliff minus your ${fmt(state.bufferDollars)} buffer — without the harvest, MAGI at a $0 draw would be ${fmt(harvestNoRoomMagi)}, under the ${fmt(targetMagi ?? 0)} target, but with the harvest it is ${fmt(likelyCase.nonDrawAcaMagi)}, so the harvest uses up the room, not income already posted.`;
  } else if (headlineDraw != null && headlineDraw <= 0) {
    headlineText = `Take no December draw: income already posted leaves no room under the cliff minus your ${fmt(state.bufferDollars)} buffer.`;
  } else {
    // Audit N-4: the "keeping the credit" wording fires only
    // when a positive credit is actually priced. A priced
    // credit of $0 (e.g. an entered $0 benchmark, a $0
    // enrollment-premium cap, or a coverage-month reduction
    // that consumes the whole credit) is under the cliff but
    // keeps nothing — the headline says the priced credit is
    // $0, parallel to the unpriced case's "credit not priced"
    // (the S-9 wording the console uses per case).
    headlineText =
      likelyCase.creditAtHeadline == null
        ? `Maximum safe December draw: ${fmt(headlineDraw ?? 0)} — it lands MAGI at ${fmt(likelyCase.magiAtHeadline)}, ${fmt(Math.abs(likelyCase.distanceAtHeadline ?? 0))} under the ${fmt(cliff)} cliff in the likely case — credit not priced.`
        : likelyCase.creditAtHeadline === 0
          ? `Maximum safe December draw: ${fmt(headlineDraw ?? 0)} — it lands MAGI at ${fmt(likelyCase.magiAtHeadline)}, ${fmt(Math.abs(likelyCase.distanceAtHeadline ?? 0))} under the ${fmt(cliff)} cliff in the likely case — the priced credit is $0.`
          : `Maximum safe December draw: ${fmt(headlineDraw ?? 0)} — it lands MAGI at ${fmt(likelyCase.magiAtHeadline)}, ${fmt(Math.abs(likelyCase.distanceAtHeadline ?? 0))} under the ${fmt(cliff)} cliff in the likely case, keeping the credit.`;
  }

  if (state.aptcTaken <= 0 && cliff != null) {
    warnings.push(
      "No advance premium credit (APTC) taken was entered — with none taken there is nothing to repay, but a year ending above the cliff still loses the credit itself, and a year under it repays any advance credit taken above the final credit in full (no repayment caps after 2025).",
    );
  }
  if (state.strayCutoff.status === "na" || state.strayTradeDate.status === "na") {
    warnings.push(
      "The year-end execution clocks are not both confirmed — brokerage sales count by trade date, while a plan distribution counts in the year it is paid (actually or constructively received), not the year it is requested; get the administrator's payment date and December cutoff in writing.",
    );
  }
  if (!hasEducationExpenses) {
    warnings.push(
      "No education expenses are entered, so this settlement excludes education credits — the American Opportunity Credit (up to $2,500 per student) and the Lifetime Learning Credit (up to $2,000 per return) are not priced. If anyone in the household paid qualified education expenses this year, enter them in the Education credits section so the settlement includes them.",
    );
  }
  if (gainHarvestUnpriced) {
    warnings.push(
      "Gain harvesting is switched on, but the taxable pool or its basis is not entered — here or in the Tax Plan record — so this settlement excludes gain harvesting: no harvest is priced, and a year the plan harvests in will settle differently (the harvested gain counts as income and shrinks the ACA credit). Enter the pool and its basis in the Gain harvest section so the settlement includes the harvest.",
    );
  }
  return {
    priced: true,
    reason: null,
    cliff,
    targetMagi,
    headlineDraw,
    headlineText,
    zeroDrawOverCliff,
    cases,
    warnings,
  };
}

function fmt(dollars: number): string {
  const neg = dollars < 0;
  const abs = Math.abs(Math.round(dollars));
  return `${neg ? "−" : ""}$${abs.toLocaleString("en-US")}`;
}

/* ---------------- Accuracy fixtures ----------------
   Pinned cases for the December surface, in the shared fixture
   shape the accuracy self-check returns. Every expected figure
   is derived from the engine's own published law data (the
   2026-coverage cliff for a household of 2 is 400% of the 2025
   guideline $21,150 = $84,600) and the assembly rules above —
   never from a second implementation of the tax math. */
export function runDecemberFixtures(): {
  total: number;
  passed: number;
  results: { id: string; kind: string; pass: boolean; failures: string[] }[];
} {
  const results: { id: string; kind: string; pass: boolean; failures: string[] }[] = [];
  const run = (
    id: string,
    fn: (fail: (msg: string) => void) => void,
  ) => {
    const failures: string[] = [];
    try {
      fn((m) => failures.push(m));
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e));
    }
    results.push({ id, kind: "december", pass: failures.length === 0, failures });
  };
  // Assertion discipline (December-fix fixture hygiene):
  // `exact` is the default — every solver-independent figure
  // must match to the cent. `near` (±$0.02) is reserved for
  // figures that come OUT of the cliff solver's cent-by-cent
  // search (the headline draw, each case's own max draw, and
  // the MAGI / credit / repayment figures priced AT that
  // solved draw): the solver lands on a one-cent grid, so an
  // at-headline figure can sit a cent off the hand-derived
  // landing without the landing being wrong.
  const exact = (fail: (m: string) => void, label: string, got: number | null, want: number) => {
    if (got !== want) {
      fail(`${label}: got ${got}, want ${want}`);
    }
  };
  const near = (fail: (m: string) => void, label: string, got: number | null, want: number) => {
    if (got == null || Math.abs(got - want) > 0.02) {
      fail(`${label}: got ${got}, want ${want}`);
    }
  };
  const base = (): DecemberState => ({
    ...defaultDecemberState(2026),
    agePrimary: 60,
    ageSpouse: 58,
    acaHouseholdSize: 2,
    acaBenchmarkAnnual: 20000,
    aptcTaken: 12000,
  });

  run("dec-headline-cliff-minus-buffer", (fail) => {
    const s = base();
    s.ytdOtherOrdinary = 50000;
    const r = computeDecemberProjection(s);
    if (!r.priced) return fail("not priced");
    exact(fail, "cliff", r.cliff, 84600);
    exact(fail, "target", r.targetMagi, 79600);
    near(fail, "headline", r.headlineDraw, 29600);
    const likely = r.cases[1]!;
    near(fail, "likely magi at headline", likely.magiAtHeadline, 79600);
    if (likely.overCliffAtHeadline) fail("likely case should keep the credit");
    if (likely.repaymentExposure !== 0) fail("kept case should have $0 exposure");
    // The final credit at MAGI $79,600 is the $20,000
    // benchmark less 9.96% of MAGI ($7,928.16) = $12,071.84;
    // the $12,000 APTC taken sits below it, so the excess
    // repayment is $0 and $71.84 of credit is still due.
    near(fail, "final credit at headline", likely.creditAtHeadline, 12071.84);
    near(fail, "excess repayment at headline", likely.excessAptcRepayment, 0);
    near(fail, "credit still due at headline", likely.creditStillDue, 71.84);
  });

  run("dec-headline-zero-priced-credit", (fail) => {
    // Audit N-4: same landing as dec-headline-cliff-minus-buffer
    // (MAGI $79,600 at the headline draw, under the $84,600
    // cliff), but with a $0 enrollment premium entered the
    // priced final credit is $0 — the headline must not claim
    // the credit is being kept when there is none priced; it
    // says the priced credit is $0. The priced figures are
    // unchanged: final credit $0, and the whole $12,000 of
    // APTC taken is repaid (no repayment caps after 2025).
    const s = base();
    s.ytdOtherOrdinary = 50000;
    s.acaEnrollmentPremiumAnnual = 0;
    const r = computeDecemberProjection(s);
    if (!r.priced) return fail("not priced");
    near(fail, "headline", r.headlineDraw, 29600);
    const likely = r.cases[1]!;
    if (likely.overCliffAtHeadline) fail("likely case should be under the cliff");
    exact(fail, "final credit at headline", likely.creditAtHeadline, 0);
    near(fail, "excess repayment at headline", likely.excessAptcRepayment, 12000);
    if (r.headlineText.includes("keeping the credit")) {
      fail(`headline must not claim a kept credit at a $0 priced credit, got: ${r.headlineText}`);
    }
    if (!r.headlineText.includes("the priced credit is $0")) {
      fail(`headline should say the priced credit is $0, got: ${r.headlineText}`);
    }
    // The positive-credit landing keeps the original wording.
    const kept = base();
    kept.ytdOtherOrdinary = 50000;
    const rk = computeDecemberProjection(kept);
    if (!rk.headlineText.includes("keeping the credit")) {
      fail(`positive-credit headline should keep the kept wording, got: ${rk.headlineText}`);
    }
  });

  run("dec-repayment-under-cliff-excess-aptc", (fail) => {
    // Settled review (P.L. 119-21 §71305): after 2025 there
    // are no repayment caps, so an under-cliff year whose APTC
    // taken exceeds the final allowable credit repays the
    // difference in full. Same landing as the headline
    // fixture (final credit $12,071.84) with $15,000 taken.
    const s = base();
    s.ytdOtherOrdinary = 50000;
    s.aptcTaken = 15000;
    const r = computeDecemberProjection(s);
    const likely = r.cases[1]!;
    if (likely.overCliffAtHeadline) fail("case should be under the cliff");
    near(fail, "final credit", likely.creditAtHeadline, 12071.84);
    near(fail, "excess repayment", likely.excessAptcRepayment, 2928.16);
    near(fail, "repayment exposure", likely.repaymentExposure, 2928.16);
    near(fail, "credit still due", likely.creditStillDue, 0);
  });

  run("dec-repayment-under-cliff-aptc-below-credit", (fail) => {
    // The other side: APTC taken below the final credit —
    // $0 repayment, and the shortfall is still due at filing.
    const s = base();
    s.ytdOtherOrdinary = 50000;
    s.aptcTaken = 10000;
    const r = computeDecemberProjection(s);
    const likely = r.cases[1]!;
    if (likely.overCliffAtHeadline) fail("case should be under the cliff");
    near(fail, "excess repayment", likely.excessAptcRepayment, 0);
    near(fail, "repayment exposure", likely.repaymentExposure, 0);
    near(fail, "credit still due", likely.creditStillDue, 2071.84);
  });

  run("dec-zero-draw-over-cliff", (fail) => {
    const s = base();
    s.ytdOtherOrdinary = 100000;
    const r = computeDecemberProjection(s);
    if (r.headlineDraw !== 0) fail(`headline should be 0, got ${r.headlineDraw}`);
    if (!r.zeroDrawOverCliff) fail("zeroDrawOverCliff should be true");
    const likely = r.cases[1]!;
    if (!likely.overCliffEvenAtZero) fail("likely overCliffEvenAtZero should be true");
    exact(fail, "repayment", likely.repaymentExposure, 12000);
  });

  run("dec-harvest-cliff-blame-should5", (fail) => {
    // Re-audit round 3 SHOULD-5: a harvest that breaches
    // the cliff was blamed on "income already posted" —
    // the $0-draw MAGI includes the priced harvest (it is
    // sized inside every pricing), so the old headline
    // named posted income even when posted income alone
    // sat under the cliff and the harvested gain alone
    // tipped the year over. The headline now prices the
    // harvest-free counterfactual and names the harvest
    // when it alone tips the year. Breach case: posted
    // ordinary income $79,000 (under the $84,600 cliff),
    // a $40,000 pool at 75% basis — the full $10,000
    // unrealized gain harvests inside the 0% room
    // ($98,900 − $46,800 ordinary taxable = $52,100),
    // lifting MAGI to $89,000, over the cliff. Without
    // the harvest MAGI is $79,000, under the cliff, and
    // the settlement is untouched (credit $0 over the
    // cliff, the whole $12,000 APTC repaid).
    const breach = base();
    breach.ytdOtherOrdinary = 79000;
    breach.harvestOn = true;
    breach.harvestPoolAmount = 40000;
    breach.harvestPoolBasisPct = 75;
    const rb = computeDecemberProjection(breach);
    if (!rb.priced) return fail("breach case not priced");
    if (rb.headlineDraw !== 0) {
      fail(`breach headline should be 0, got ${rb.headlineDraw}`);
    }
    if (!rb.zeroDrawOverCliff) fail("breach zeroDrawOverCliff should be true");
    const lb = rb.cases[1]!;
    exact(fail, "breach non-draw MAGI", lb.nonDrawAcaMagi, 89000);
    exact(fail, "breach harvested gain at $0 draw", lb.harvestedGainAtZeroDraw, 10000);
    exact(fail, "breach credit", lb.creditAtHeadline, 0);
    exact(fail, "breach repayment", lb.repaymentExposure, 12000);
    if (!rb.headlineText.includes("the gain harvest puts MAGI at $89,000")) {
      fail(`breach headline should name the harvest and its MAGI, got: ${rb.headlineText}`);
    }
    if (!rb.headlineText.includes("without the harvest, MAGI would be $79,000")) {
      fail(`breach headline should name the harvest-free MAGI, got: ${rb.headlineText}`);
    }
    if (
      !rb.headlineText.includes(
        "the harvest itself is what breaches the cliff, not income already posted",
      )
    ) {
      fail(`breach headline should attribute the breach to the harvest, got: ${rb.headlineText}`);
    }
    if (rb.headlineText.includes("income already posted puts MAGI")) {
      fail("breach headline must not blame income already posted");
    }
    // Genuine-income control: posted income $100,000 is
    // over the cliff on its own; the same $10,000 harvest
    // rides on top (MAGI $110,000), but the harvest-free
    // MAGI ($100,000) is still over the cliff, so the
    // headline keeps the income wording — the harvest is
    // not the tipping cause.
    const genuine = base();
    genuine.ytdOtherOrdinary = 100000;
    genuine.harvestOn = true;
    genuine.harvestPoolAmount = 40000;
    genuine.harvestPoolBasisPct = 75;
    const rg = computeDecemberProjection(genuine);
    exact(fail, "genuine non-draw MAGI", rg.cases[1]!.nonDrawAcaMagi, 110000);
    if (!rg.headlineText.includes("income already posted puts MAGI at $110,000")) {
      fail(`genuine headline should keep the income wording, got: ${rg.headlineText}`);
    }
    // Absorbed-harvest control: posted $88,000 with a
    // $20,000 long-term carry-in — the carryforward
    // absorbs the whole $10,000 harvest, so MAGI is
    // $85,000 (posted less the $3,000 allowance) WITH or
    // WITHOUT the harvest: over the cliff either way, and
    // the headline keeps the income wording. This case is
    // why the counterfactual is re-priced, never derived
    // by subtracting the gross gain — $85,000 − $10,000 =
    // $75,000 would sit under the cliff and wrongly blame
    // the harvest.
    const absorbed = base();
    absorbed.ytdOtherOrdinary = 88000;
    absorbed.carryInCapitalLossLt = 20000;
    absorbed.harvestOn = true;
    absorbed.harvestPoolAmount = 40000;
    absorbed.harvestPoolBasisPct = 75;
    const ra = computeDecemberProjection(absorbed);
    const la = ra.cases[1]!;
    exact(fail, "absorbed harvested gain at $0 draw", la.harvestedGainAtZeroDraw, 10000);
    exact(fail, "absorbed non-draw MAGI", la.nonDrawAcaMagi, 85000);
    if (!ra.headlineText.includes("income already posted puts MAGI at $85,000")) {
      fail(`absorbed headline should keep the income wording, got: ${ra.headlineText}`);
    }
    // No-room case: the harvest does not breach the
    // cliff but uses up the room under cliff − buffer.
    // Posted $78,000, a $16,000 pool at 75% basis
    // harvests $4,000: MAGI $82,000 — under the $84,600
    // cliff, over the $79,600 target — so the draw is
    // $0; without the harvest the same year draws $1,600.
    // The headline names the harvest, not posted income.
    const noRoom = base();
    noRoom.ytdOtherOrdinary = 78000;
    noRoom.harvestOn = true;
    noRoom.harvestPoolAmount = 16000;
    noRoom.harvestPoolBasisPct = 75;
    const rn = computeDecemberProjection(noRoom);
    if (rn.zeroDrawOverCliff) {
      fail("no-room case should not be over the cliff at $0");
    }
    if (rn.headlineDraw !== 0) {
      fail(`no-room headline should be 0, got ${rn.headlineDraw}`);
    }
    exact(fail, "no-room non-draw MAGI", rn.cases[1]!.nonDrawAcaMagi, 82000);
    if (!rn.headlineText.includes("the gain harvest leaves no room")) {
      fail(`no-room headline should name the harvest, got: ${rn.headlineText}`);
    }
    if (
      !rn.headlineText.includes(
        "without the harvest, MAGI at a $0 draw would be $78,000",
      )
    ) {
      fail(`no-room headline should name the harvest-free MAGI, got: ${rn.headlineText}`);
    }
    if (rn.headlineText.includes("income already posted leaves no room")) {
      fail("no-room headline must not blame income already posted");
    }
    const rnOff = computeDecemberProjection({ ...noRoom, harvestOn: false });
    near(fail, "no-room harvest-free draw", rnOff.headlineDraw, 1600);
  });

  run("dec-ranges-move-the-draw", (fail) => {
    const s = base();
    s.ytdOtherOrdinary = 50000;
    s.remCapDist = { low: 0, likely: 5000, high: 10000 };
    const r = computeDecemberProjection(s);
    const [low, likely, high] = r.cases as [
      DecemberCaseResult,
      DecemberCaseResult,
      DecemberCaseResult,
    ];
    exact(fail, "low non-draw MAGI", low.nonDrawAcaMagi, 50000);
    exact(fail, "likely non-draw MAGI", likely.nonDrawAcaMagi, 55000);
    exact(fail, "high non-draw MAGI", high.nonDrawAcaMagi, 60000);
    near(fail, "low max draw", low.maxDraw, 29600);
    near(fail, "likely max draw", likely.maxDraw, 24600);
    near(fail, "high max draw", high.maxDraw, 19600);
    // At the headline (likely) draw, the high case lands over
    // the buffer line but still under the cliff.
    near(fail, "high magi at headline", high.magiAtHeadline, 84600 - 5000 + 5000);
    if (high.overCliffAtHeadline) fail("high case at headline should still be under the cliff");
  });

  run("dec-no-cliff-on-medicare", (fail) => {
    const s = base();
    s.onMedicarePrimary = true;
    s.onMedicareSpouse = true;
    s.ytdOtherOrdinary = 50000;
    const r = computeDecemberProjection(s);
    if (r.cliff !== null) fail("cliff should be null when everyone is on Medicare");
    if (r.headlineDraw !== null) fail("headline should be null with no cliff");
  });

  run("dec-strays-flow-into-magi", (fail) => {
    const plain = base();
    plain.ytdOtherOrdinary = 40000;
    const withStray = base();
    withStray.ytdOtherOrdinary = 40000;
    withStray.strayK1 = { status: "amount", amount: 10000 };
    withStray.strayTaxExempt = { status: "amount", amount: 2000 };
    const a = computeDecemberProjection(plain).cases[1]!;
    const b = computeDecemberProjection(withStray).cases[1]!;
    exact(fail, "MAGI lift from strays", b.nonDrawAcaMagi - a.nonDrawAcaMagi, 12000);
    const na = base();
    na.ytdOtherOrdinary = 40000;
    na.strayK1 = { status: "na", amount: 10000 };
    const c = computeDecemberProjection(na).cases[1]!;
    exact(fail, "N/A stray is inert", c.nonDrawAcaMagi - a.nonDrawAcaMagi, 0);
  });

  run("dec-settled-strays-flow-into-magi", (fail) => {
    // The settled-review additions flow into the projection
    // like the original strays: planned-sale gains +$5,000 and
    // return-of-capital income +$1,000 ride the capital
    // result, a January-paid fund dividend +$3,000 rides
    // dividends, cash-sleeve / savings-bond income +$2,000
    // rides interest, and AGI reducers −$4,000 subtract from
    // ordinary income — a net MAGI lift of $7,000.
    const plain = base();
    plain.ytdOtherOrdinary = 40000;
    const withStrays = base();
    withStrays.ytdOtherOrdinary = 40000;
    withStrays.strayPlannedSales = { status: "amount", amount: 5000 };
    withStrays.strayROC = { status: "amount", amount: 1000 };
    withStrays.strayJanPaid = { status: "amount", amount: 3000 };
    withStrays.strayDivInt = { status: "amount", amount: 2000 };
    withStrays.strayAgiReducers = { status: "amount", amount: 4000 };
    const a = computeDecemberProjection(plain).cases[1]!;
    const b = computeDecemberProjection(withStrays).cases[1]!;
    exact(fail, "MAGI lift from settled strays", b.nonDrawAcaMagi - a.nonDrawAcaMagi, 7000);
    // Coverage months: a $2,000 credit reduction for
    // ineligible months shrinks the final credit dollar for
    // dollar and raises the excess-APTC repayment by the
    // same $2,000, without moving MAGI at all.
    const withCoverage = base();
    withCoverage.ytdOtherOrdinary = 40000;
    withCoverage.strayCoverage = { status: "amount", amount: 2000 };
    const c = computeDecemberProjection(withCoverage).cases[1]!;
    exact(fail, "coverage leaves MAGI alone", c.nonDrawAcaMagi - a.nonDrawAcaMagi, 0);
    near(fail, "final credit after coverage", c.creditAtHeadline, 10071.84);
    near(fail, "excess after coverage", c.excessAptcRepayment, 1928.16);
    // The new fields ride the saved blob: a stored blob
    // carrying them parses back intact, and a blob written
    // before they existed reads them at the inert default.
    const stored = parseDecemberState(
      JSON.stringify({ strayJanPaid: { status: "amount", amount: 750 } }),
      2026,
    );
    if (stored.strayJanPaid.status !== "amount" || stored.strayJanPaid.amount !== 750) {
      fail("a stored January-paid stray should parse back intact");
    }
    const legacy = parseDecemberState(JSON.stringify({ taxYear: 2026 }), 2026);
    if (legacy.strayCoverage.status !== "na" || legacy.strayTradeDate.status !== "na") {
      fail("new strays should default to N/A on a legacy blob");
    }
  });

  run("dec-buffer-moves-headline-dollar-for-dollar", (fail) => {
    const a = base();
    a.ytdOtherOrdinary = 50000;
    a.bufferDollars = 0;
    const b = base();
    b.ytdOtherOrdinary = 50000;
    b.bufferDollars = 5000;
    const ra = computeDecemberProjection(a);
    const rb = computeDecemberProjection(b);
    near(
      fail,
      "buffer delta",
      (ra.headlineDraw ?? -1) - (rb.headlineDraw ?? -1),
      5000,
    );
  });

  run("dec-buffer-at-or-above-cliff-warns-n3", (fail) => {
    // Audit N-3 (settled): a buffer at or above the cliff
    // makes the target zero or negative, so the $0 draw is
    // caused by the buffer alone. Worked example from the
    // finding, scaled to this fixture's cliff ($84,600):
    // buffer $200,000 → target −$115,400, headline $0, with
    // a warning and a headline that name the buffer — not
    // income — as the reason. The $0 draw itself is
    // arithmetically correct and is kept.
    const s = base();
    s.ytdOtherOrdinary = 0;
    s.bufferDollars = 200000;
    const r = computeDecemberProjection(s);
    if (!r.priced) return fail("not priced");
    exact(fail, "cliff", r.cliff, 84600);
    exact(fail, "target with $200k buffer", r.targetMagi, -115400);
    exact(fail, "headline draw stays $0", r.headlineDraw, 0);
    if (
      !r.warnings.some((w) =>
        w.includes("buffer alone makes the target unreachable"),
      )
    ) {
      fail(
        `projection should warn that the buffer alone makes the target unreachable, got: ${JSON.stringify(r.warnings)}`,
      );
    }
    if (
      !r.warnings.some(
        (w) => w.includes("$200,000") && w.includes("$84,600"),
      )
    ) {
      fail("warning should name the buffer and the cliff");
    }
    if (!r.headlineText.includes("buffer alone makes the target unreachable")) {
      fail(
        `headline should name the buffer as the reason for $0, got: ${r.headlineText}`,
      );
    }
    if (r.headlineText.includes("income already posted leaves no room")) {
      fail("headline should not attribute the $0 draw to income when the buffer alone binds");
    }
    // Boundary: buffer exactly equal to the cliff also warns (target $0).
    const atCliff = base();
    atCliff.ytdOtherOrdinary = 0;
    atCliff.bufferDollars = 84600;
    const rAt = computeDecemberProjection(atCliff);
    exact(fail, "target at buffer == cliff", rAt.targetMagi, 0);
    exact(fail, "headline at buffer == cliff", rAt.headlineDraw, 0);
    if (
      !rAt.warnings.some((w) =>
        w.includes("buffer alone makes the target unreachable"),
      )
    ) {
      fail("buffer == cliff should also warn");
    }
    // Normal buffer: no such warning, and the ordinary
    // headline pricing is unchanged.
    const normal = base();
    normal.ytdOtherOrdinary = 50000;
    normal.bufferDollars = 5000;
    const rn = computeDecemberProjection(normal);
    exact(fail, "normal target", rn.targetMagi, 79600);
    near(fail, "normal headline", rn.headlineDraw, 29600);
    if (
      rn.warnings.some((w) =>
        w.includes("buffer alone makes the target unreachable"),
      )
    ) {
      fail("normal $5,000 buffer should not carry the buffer-exceeds-cliff warning");
    }
  });

  run("dec-default-state-is-inert", (fail) => {
    const d = defaultDecemberState(2026);
    const r = computeDecemberProjection(d);
    if (r.priced) fail("the untouched default state must not price a year");
    const parsed = parseDecemberState(undefined, 2026);
    if (parsed.bufferDollars !== 5000) fail("default buffer should be $5,000");
    if (parsed.taxYear !== 2026) fail("default tax year should be the current year");
    // The engine itself is untouched by this surface: a plain
    // Playground pricing of the same dials still prices.
    const pg = pricePlaygroundYear(decemberCaseInputs(base(), "likely", 0));
    exact(fail, "engine ACA MAGI passthrough", pg.acaMagi, 0);
  });

  run("dec-spouse-rmd-on-own-clock", (fail) => {
    // Fix A (finding 1 of the commit-5379b85 accuracy
    // review): the spouse's RMD prices on the SPOUSE's clock
    // from the SPOUSE's own balance. Primary 60 with $0,
    // spouse 75 with $246,000: her RMD is $246,000 / 24.6 =
    // $10,000, so the zero-draw MAGI is $70,000 + $10,000 =
    // $80,000 — already over the $79,600 target (cliff
    // $84,600 − buffer $5,000) — and the safe draw is $0.
    // FACT PATTERN (round-2 adjustment): the primary is NOT
    // the spouse's sole beneficiary here, so the Uniform
    // Lifetime Table genuinely applies to her RMD — with
    // the primary as her sole beneficiary, more than 10
    // years younger, the Joint Life table would apply
    // instead (pinned separately by
    // dec-spouse-rmd-joint-table). The expectation is
    // unchanged. (Round-3: that fact is now its own field,
    // primarySoleBeneficiaryOfSpouse, set false here
    // explicitly — it was already this fixture's stated
    // fact pattern.)
    const s = base();
    s.agePrimary = 60;
    s.ageSpouse = 75;
    s.spouseSoleBeneficiary = false;
    s.primarySoleBeneficiaryOfSpouse = false;
    s.onMedicareSpouse = true;
    s.ytdOtherOrdinary = 70000;
    s.pretaxBalancePrimary = 0;
    s.pretaxBalanceSpouse = 246000;
    s.aptcTaken = 12000;
    const pg = pricePlaygroundYear(decemberCaseInputs(s, "likely", 0));
    exact(fail, "spouse RMD priced", pg.rmdSpouse, 10000);
    exact(fail, "primary RMD", pg.rmdPrimary, 0);
    exact(fail, "gross RMD", pg.rmdGross, 10000);
    exact(fail, "spouse RMD divisor", pg.rmdDivisor, 24.6);
    if (pg.rmdTable !== "uniform") {
      fail(`spouse RMD table should be uniform, got ${pg.rmdTable}`);
    }
    const r = computeDecemberProjection(s);
    const likely = r.cases[1]!;
    exact(fail, "non-draw MAGI", likely.nonDrawAcaMagi, 80000);
    if (r.headlineDraw !== 0) fail(`headline should be $0, got ${r.headlineDraw}`);
  });

  run("dec-spouse-age-blank-blocks-pricing", (fail) => {
    // M-4 (engines review round 2, MUST, settled STAND):
    // the settlement's worked example. The SAME household
    // as dec-spouse-rmd-on-own-clock — primary 60 with $0,
    // spouse with $246,000, $70,000 of posted ordinary
    // income, HH2, benchmark $20,000, APTC taken $12,000 —
    // except the spouse's age is BLANK. Before the fix the
    // year priced anyway: the shared pricer's spouse-RMD
    // branch requires ageSpouse != null, so her RMD
    // silently priced as $0, the solver sized the headline
    // draw against the understated MAGI ($79,600 target −
    // $70,000 posted = a $9,600 headline draw), and the
    // likely case claimed the $79,600-MAGI credit ($20,000
    // benchmark − 9.96% × $79,600 = $12,071.84). With her
    // age entered (75, Uniform Lifetime Table — the primary
    // is not her sole beneficiary here, as in the sibling
    // fixture) her RMD is $246,000 / 24.6 = $10,000, so the
    // TRUE MAGI at that $9,600 draw is $70,000 + $10,000 +
    // $9,600 = $89,600 — over the $84,600 cliff — and the
    // true credit is $0. Corrected behavior, mirroring the
    // primary-age guard: a blank spouse age on a joint
    // return blocks pricing outright.
    const s = base();
    s.agePrimary = 60;
    s.ageSpouse = null;
    s.spouseSoleBeneficiary = false;
    s.primarySoleBeneficiaryOfSpouse = false;
    s.onMedicareSpouse = true;
    s.ytdOtherOrdinary = 70000;
    s.pretaxBalancePrimary = 0;
    s.pretaxBalanceSpouse = 246000;
    s.aptcTaken = 12000;
    const r = computeDecemberProjection(s);
    if (r.priced) {
      fail("a blank spouse age on a joint return must block pricing");
    }
    if (r.headlineDraw !== null) {
      fail(`blocked pricing must carry no headline draw, got ${r.headlineDraw}`);
    }
    if (r.cases.length !== 0) fail("blocked pricing must carry no cases");
    if (r.reason == null || !r.reason.includes("spouse's age")) {
      fail(`blocked reason should name the spouse's age, got: ${r.reason}`);
    }
    // The worked example's true figures, priced with her
    // age entered (75) at the $9,600 draw the blank-age
    // pricing recommended: her RMD is $10,000, MAGI is
    // $89,600, and the credit is $0.
    const truth = { ...s, ageSpouse: 75 };
    const pg = pricePlaygroundYear(decemberCaseInputs(truth, "likely", 9600));
    exact(fail, "true spouse RMD", pg.rmdSpouse, 10000);
    exact(fail, "true MAGI at the $9,600 draw", pg.acaMagi, 89600);
    exact(fail, "true credit at the $9,600 draw", pg.aca.credit, 0);
    // And the age-entered projection prices normally,
    // landing where dec-spouse-rmd-on-own-clock lands:
    // her RMD lifts non-draw MAGI to $80,000, already over
    // the $79,600 target, so the headline draw is $0.
    const rt = computeDecemberProjection(truth);
    if (!rt.priced) return fail("the age-entered year should price");
    if (rt.headlineDraw !== 0) {
      fail(`age-entered headline should be $0, got ${rt.headlineDraw}`);
    }
    exact(fail, "age-entered non-draw MAGI", rt.cases[1]!.nonDrawAcaMagi, 80000);
    // A single filer's blank spouse age is not a missing
    // fact — the form stores null for it — and must not
    // block pricing.
    const single = base();
    single.filingStatus = "single";
    single.ageSpouse = null;
    single.ytdOtherOrdinary = 70000;
    single.pretaxBalancePrimary = 0;
    single.pretaxBalanceSpouse = null;
    if (!computeDecemberProjection(single).priced) {
      fail("a single filer's blank spouse age must not block pricing");
    }
  });

  run("dec-spouse-rmd-joint-table", (fail) => {
    // Round-2 fix 2: the spouse's RMD selects its IRS
    // lifetime table the same way the primary's does. Same
    // household as dec-spouse-rmd-on-own-clock, except the
    // primary IS the spouse's sole beneficiary and is more
    // than 10 years younger (60 vs 75), so Pub. 590-B
    // Table II (Joint and Last Survivor) applies to HER
    // RMD: $246,000 / 28.3 = $8,692.58, not the Uniform
    // table's $246,000 / 24.6 = $10,000. Zero-draw MAGI is
    // $70,000 + $8,692.58 = $78,692.58; the room to the
    // $79,600 target is a $907.42 draw; and the credit at a
    // $0 draw is $20,000 − 9.96% × $78,692.58 = $12,162.22.
    // (Verified against the live engine before the fix,
    // which priced the Uniform figures: RMD $10,000, MAGI
    // $80,000, draw $0, credit $12,032.00.)
    // FACT ADJUSTMENT (round-3, flagged per the honesty
    // standard): this fixture's setup originally relied on
    // the round-2 build's SYMMETRIC read of
    // spouseSoleBeneficiary to establish that the primary
    // is the spouse's sole beneficiary. That fact is now
    // its own field, so the fixture sets
    // primarySoleBeneficiaryOfSpouse = true explicitly —
    // the fact pattern it always stated — and every
    // expectation below is unchanged.
    const s = base();
    s.agePrimary = 60;
    s.ageSpouse = 75;
    s.spouseSoleBeneficiary = true;
    s.primarySoleBeneficiaryOfSpouse = true;
    s.onMedicareSpouse = true;
    s.ytdOtherOrdinary = 70000;
    s.pretaxBalancePrimary = 0;
    s.pretaxBalanceSpouse = 246000;
    s.aptcTaken = 12000;
    const pg = pricePlaygroundYear(decemberCaseInputs(s, "likely", 0));
    exact(fail, "spouse RMD on the Joint table", pg.rmdSpouse, 8692.58);
    exact(fail, "primary RMD", pg.rmdPrimary, 0);
    exact(fail, "gross RMD", pg.rmdGross, 8692.58);
    exact(fail, "spouse RMD divisor", pg.rmdDivisor, 28.3);
    if (pg.rmdTable !== "joint") {
      fail(`spouse RMD table should be joint, got ${pg.rmdTable}`);
    }
    exact(fail, "zero-draw ACA MAGI", pg.acaMagi, 78692.58);
    exact(fail, "zero-draw credit", pg.aca.credit, 12162.22);
    const r = computeDecemberProjection(s);
    const likely = r.cases[1]!;
    exact(fail, "non-draw MAGI", likely.nonDrawAcaMagi, 78692.58);
    near(fail, "headline draw", r.headlineDraw, 907.42);
    near(fail, "likely max draw", likely.maxDraw, 907.42);
  });

  run("dec-spouse-rmd-beneficiary-direction", (fail) => {
    // Round-3 fix: the reviewer's failing case. The
    // existing flag is TRUE — the spouse IS the primary's
    // sole beneficiary (of the PRIMARY's accounts) — but
    // the spouse's own beneficiary is an adult child, so
    // the NEW fact (the primary is the sole beneficiary of
    // the SPOUSE's accounts) is FALSE, and her RMD must
    // price on the Uniform Lifetime Table. The round-2
    // build read the one flag symmetrically and priced
    // her RMD on the Joint table ($8,692.58), landing MAGI
    // at $83,692.58 with a phantom $11,664.22 credit and
    // only $335.78 of repayment. Correct: her RMD is
    // $246,000 / 24.6 = $10,000; non-draw MAGI is $75,000 +
    // $10,000 = $85,000 — over the $84,600 cliff even at a
    // $0 draw — so the final credit is $0 and the whole
    // $12,000 of APTC taken is repaid.
    const s = base();
    s.agePrimary = 60;
    s.ageSpouse = 75;
    s.onMedicareSpouse = true;
    s.spouseSoleBeneficiary = true;
    s.primarySoleBeneficiaryOfSpouse = false;
    s.pretaxBalancePrimary = 10000;
    s.pretaxBalanceSpouse = 246000;
    s.pretaxBalance = 256000;
    s.ytdOtherOrdinary = 75000;
    s.aptcTaken = 12000;
    const pg = pricePlaygroundYear(decemberCaseInputs(s, "likely", 0));
    exact(fail, "spouse RMD on the Uniform table", pg.rmdSpouse, 10000);
    exact(fail, "spouse RMD divisor", pg.rmdDivisor, 24.6);
    if (pg.rmdTable !== "uniform") {
      fail(`spouse RMD table should be uniform, got ${pg.rmdTable}`);
    }
    const r = computeDecemberProjection(s);
    const likely = r.cases[1]!;
    exact(fail, "non-draw MAGI", likely.nonDrawAcaMagi, 85000);
    if (!likely.overCliffEvenAtZero) {
      fail("the likely case should be over the cliff even at a $0 draw");
    }
    if (!r.zeroDrawOverCliff) fail("zeroDrawOverCliff should be true");
    if (r.headlineDraw !== 0) fail(`headline should be $0, got ${r.headlineDraw}`);
    exact(fail, "final credit", likely.creditAtHeadline, 0);
    exact(fail, "excess APTC repayment", likely.excessAptcRepayment, 12000);
    exact(fail, "repayment exposure", likely.repaymentExposure, 12000);
    // A legacy blob carrying ONLY the old flag (true)
    // parses the new fact as UNANSWERED (null, round-4
    // tri-state) — not as an explicit false, and
    // reciprocity is never inferred on read either. Null
    // prices Uniform exactly as false does (above); the
    // distinction exists so a known Tax Plan answer can
    // be resolved at load (the dec-load-prefill-*
    // fixtures below).
    const legacy = parseDecemberState(
      JSON.stringify({ taxYear: 2026, spouseSoleBeneficiary: true }),
      2026,
    );
    if (legacy.primarySoleBeneficiaryOfSpouse !== null) {
      fail("a legacy blob must read the new beneficiary fact as unanswered (null)");
    }
    if (legacy.spouseSoleBeneficiary !== true) {
      fail("the legacy blob's own flag should still parse as stored");
    }
  });

  run("dec-zero-balance-round-trips", (fail) => {
    // Round-2 fix 1: a known $0 pre-tax balance round-trips
    // as zero through the form, never as not-entered. The
    // reviewer's repro: a legacy blob with pretaxBalance 0
    // (ages 60/58, HH2, benchmark $20,000, posted ordinary
    // income $50,000, buffer $5,000) — the correct headline
    // draw is $0 (no balance, no cap-free room), where the
    // form's old $0-shows-blank conversion turned the
    // balance into null and the console recommended
    // $29,600. The converters pinned here are the exact
    // pair the view's form boundary runs for the nullable
    // money fields (decemberNullableMoneyFormValue /
    // decemberNullableMoneyFromFormValue in this module).
    const parsedLegacy = parseDecemberState(
      JSON.stringify({ taxYear: 2026, pretaxBalance: 0 }),
      2026,
    );
    // Round-5: the parser alone leaves a legacy combined
    // balance's ownership UNANSWERED; the load path
    // (no record split here) falls back to the primary.
    if (parsedLegacy.pretaxSplitExplicit || parsedLegacy.pretaxBalancePrimary !== null) {
      fail("a legacy $0 blob should parse with ownership unanswered");
    }
    const legacy = resolveDecemberStateAtLoad(parsedLegacy, null);
    if (legacy.pretaxBalancePrimary !== 0) {
      fail(`legacy $0 should migrate to a $0 primary balance, got ${legacy.pretaxBalancePrimary}`);
    }
    if (legacy.pretaxBalance !== 0) {
      fail("legacy combined $0 should keep its value");
    }
    // The form load/save cycle: $0 renders "0" (not blank)
    // and parses back to $0; blank renders and parses as
    // not-entered (null) — the two stay distinct.
    if (decemberNullableMoneyFormValue(legacy.pretaxBalancePrimary) !== "0") {
      fail("an entered $0 balance should render as \"0\", not blank");
    }
    if (decemberNullableMoneyFromFormValue("0") !== 0) {
      fail("\"0\" should parse back to a $0 balance");
    }
    if (decemberNullableMoneyFormValue(null) !== "") {
      fail("a not-entered balance should render blank");
    }
    if (decemberNullableMoneyFromFormValue("") !== null) {
      fail("blank should parse back to not-entered (null)");
    }
    if (decemberNullableMoneyFormValue(246000) !== "246,000") {
      fail("a positive balance should render grouped, as the money inputs do");
    }
    if (decemberNullableMoneyFromFormValue("246,000") !== 246000) {
      fail("a grouped balance should parse back to its value");
    }
    // The full repro, with the balance carried through the
    // round trip: the projection caps the draw at $0, and
    // the headline names the empty balance as the reason
    // (round-2 fix 3) — income room ($29,600 of it) exists.
    const s = base();
    s.pretaxBalancePrimary = decemberNullableMoneyFromFormValue(
      decemberNullableMoneyFormValue(legacy.pretaxBalancePrimary),
    );
    s.pretaxBalanceSpouse = legacy.pretaxBalanceSpouse;
    s.pretaxBalance = legacy.pretaxBalance;
    s.ytdOtherOrdinary = 50000;
    const r = computeDecemberProjection(s);
    if (r.headlineDraw !== 0) {
      fail(`headline should be $0 with a $0 balance, got ${r.headlineDraw}`);
    }
    if (
      r.headlineText !==
      "Take no December draw: the pre-tax balance is $0, so there is nothing to draw."
    ) {
      fail(`headline should name the $0 balance, got: ${r.headlineText}`);
    }
    // The contrast that proves the cap is what binds: the
    // same year with NO balance entered caps nothing and
    // recommends the full $29,600 of income room, with the
    // ordinary maximum-draw headline.
    const unentered = base();
    unentered.ytdOtherOrdinary = 50000;
    const ru = computeDecemberProjection(unentered);
    near(fail, "unentered-balance headline", ru.headlineDraw, 29600);
    // And a $0 balance with NO income room keeps the
    // income headline — the balance text fires only when
    // the empty balance is the sole binding reason.
    const noRoom = base();
    noRoom.pretaxBalancePrimary = 0;
    noRoom.pretaxBalanceSpouse = null;
    noRoom.pretaxBalance = 0;
    noRoom.ytdOtherOrdinary = 79600;
    const rn = computeDecemberProjection(noRoom);
    if (rn.headlineDraw !== 0) fail("no-room headline draw should be $0");
    if (!rn.headlineText.includes("leaves no room")) {
      fail(`no-room headline should name the income, got: ${rn.headlineText}`);
    }
  });

  run("dec-rmd-already-received-counted-once", (fail) => {
    // Fix A (finding 2): an RMD already received — and
    // already inside the year-to-date income — is counted
    // once. Primary 73, prior balance $265,000, RMD
    // $265,000 / 26.5 = $10,000, received and inside the
    // $79,600 of YTD ordinary income: MAGI is $79,600, the
    // final credit is $20,000 − 9.96% × $79,600 =
    // $12,071.84, and the repayment is $0.
    const s = base();
    s.agePrimary = 73;
    s.ageSpouse = 64;
    s.ytdOtherOrdinary = 79600;
    s.pretaxBalancePrimary = 265000;
    s.pretaxBalanceSpouse = null;
    s.rmdAlreadyReceived = 10000;
    const pg = pricePlaygroundYear(decemberCaseInputs(s, "likely", 0));
    exact(fail, "gross RMD", pg.rmdGross, 10000);
    exact(fail, "received RMD", pg.rmdAlreadyReceived, 10000);
    exact(fail, "net RMD priced", pg.rmd, 0);
    exact(fail, "MAGI counts the RMD once", pg.acaMagi, 79600);
    const r = computeDecemberProjection(s);
    const likely = r.cases[1]!;
    exact(fail, "console non-draw MAGI", likely.nonDrawAcaMagi, 79600);
    exact(fail, "final credit", likely.creditAtHeadline, 12071.84);
    exact(fail, "excess repayment", likely.excessAptcRepayment, 0);
    exact(fail, "repayment exposure", likely.repaymentExposure, 0);
  });

  run("dec-benchmark-tier-by-enrollment", (fail) => {
    // Fix B (finding 3): the prefill tier keys on who is on
    // the marketplace, mirroring the long-horizon selection.
    // Household of 3 with only the primary enrolled (spouse
    // on Medicare) is the SINGLE tier — never the family
    // tier its household size alone would suggest.
    const tier = (o: Partial<Parameters<typeof decemberBenchmarkTier>[0]>) =>
      decemberBenchmarkTier({
        filingStatus: "mfj",
        householdSize: 3,
        onMedicarePrimary: false,
        onMedicareSpouse: true,
        ...o,
      });
    if (tier({}) !== "single") fail("spouse-only-Medicare HH3 should seed single");
    if (tier({ onMedicareSpouse: false }) !== "family") {
      fail("both spouses on ACA at HH3 should seed family");
    }
    if (tier({ onMedicareSpouse: false, householdSize: 2 }) !== "couple") {
      fail("both spouses on ACA at HH2 should seed couple");
    }
    if (tier({ householdSize: 5 }) !== "single") {
      fail("one spouse on ACA at HH5 should still seed single");
    }
    if (tier({ onMedicarePrimary: true }) !== null) {
      fail("nobody on ACA should seed no tier");
    }
    if (tier({ householdSize: null }) !== null) {
      fail("no household size should seed no tier");
    }
    if (
      decemberBenchmarkTier({
        filingStatus: "single",
        householdSize: 1,
        onMedicarePrimary: false,
        onMedicareSpouse: false,
      }) !== "single"
    ) {
      fail("a single filer on ACA should seed single");
    }
  });

  run("dec-signed-k1-loss", (fail) => {
    // Fix C (finding 4): a deductible K-1 loss is signed —
    // −$10,000 at $50,000 of ordinary income puts the base
    // MAGI at $40,000 and the max draw at $79,600 − $40,000
    // = $39,600.
    const s = base();
    s.ytdOtherOrdinary = 50000;
    s.strayK1 = { status: "amount", amount: -10000 };
    const r = computeDecemberProjection(s);
    const likely = r.cases[1]!;
    exact(fail, "base MAGI", likely.nonDrawAcaMagi, 40000);
    near(fail, "max draw", likely.maxDraw, 39600);
    // A positive K-1 still adds, exactly as before.
    const pos = base();
    pos.ytdOtherOrdinary = 50000;
    pos.strayK1 = { status: "amount", amount: 10000 };
    exact(
      fail,
      "positive K-1 MAGI",
      computeDecemberProjection(pos).cases[1]!.nonDrawAcaMagi,
      60000,
    );
  });

  run("dec-enrollment-premium-cap", (fail) => {
    // Fix D (finding 5): with an enrollment premium entered,
    // the final credit is capped at it (Form 8962's
    // lesser-of) before any coverage-month reduction. MAGI
    // $79,600 (posted, $0 draw): benchmark credit
    // $12,071.84, enrollment premium $8,000, APTC $8,000 →
    // final credit $8,000, still due $0, repayment $0.
    const s = base();
    s.ytdOtherOrdinary = 79600;
    s.acaEnrollmentPremiumAnnual = 8000;
    s.aptcTaken = 8000;
    const r = computeDecemberProjection(s);
    if (r.headlineDraw !== 0) fail(`headline should be $0, got ${r.headlineDraw}`);
    const likely = r.cases[1]!;
    exact(fail, "capped final credit", likely.creditAtHeadline, 8000);
    exact(fail, "credit still due", likely.creditStillDue, 0);
    exact(fail, "excess repayment", likely.excessAptcRepayment, 0);
    // Blank = no cap: the same year prices the full
    // benchmark-based credit.
    const blank = base();
    blank.ytdOtherOrdinary = 79600;
    blank.aptcTaken = 8000;
    exact(
      fail,
      "uncapped final credit",
      computeDecemberProjection(blank).cases[1]!.creditAtHeadline,
      12071.84,
    );
  });

  run("dec-roc-ordinary-character", (fail) => {
    // Fix E (finding 6): return of capital reclassified as
    // an ordinary dividend is taxed as one. $30,000 of it on
    // $120,000 of wages (MFJ, both under 65, standard
    // deduction $32,200): taxable income rises $87,800 →
    // $117,800, and the increment is $13,000 × 12% + $17,000
    // × 22% = $5,300 — not the $2,835 the capital treatment
    // produced ($18,900 over the 0% room × 15%).
    const wages = base();
    wages.ytdOtherOrdinary = 120000;
    const roc = base();
    roc.ytdOtherOrdinary = 120000;
    roc.strayROCOrdinary = { status: "amount", amount: 30000 };
    const t0 = pricePlaygroundYear(decemberCaseInputs(wages, "likely", 0)).federalTax;
    const t1 = pricePlaygroundYear(decemberCaseInputs(roc, "likely", 0)).federalTax;
    exact(fail, "ordinary ROC tax increment", r2(t1 - t0), 5300);
    // The capital part keeps the capital treatment (a
    // review-baseline differential: the same $30,000 as
    // over-basis capital income costs $2,835 more).
    const cap = base();
    cap.ytdOtherOrdinary = 120000;
    cap.strayROC = { status: "amount", amount: 30000 };
    const t2 = pricePlaygroundYear(decemberCaseInputs(cap, "likely", 0)).federalTax;
    exact(fail, "capital ROC tax increment", r2(t2 - t0), 2835);
  });

  run("dec-jan-paid-qualified-portion", (fail) => {
    // Fix F (finding 7): a January-paid dividend keeps its
    // qualified character — $20,000 fully qualified on
    // $100,000 of wages (MFJ) adds $0 of federal tax
    // (taxable income $87,800 sits under the $98,900 0%-rate
    // top), where the nonqualified treatment added $2,400.
    const wages = base();
    wages.ytdOtherOrdinary = 100000;
    const t0 = pricePlaygroundYear(decemberCaseInputs(wages, "likely", 0)).federalTax;
    const qualified = base();
    qualified.ytdOtherOrdinary = 100000;
    qualified.strayJanPaid = { status: "amount", amount: 20000 };
    qualified.strayJanPaidQualifiedAmount = 20000;
    const t1 = pricePlaygroundYear(decemberCaseInputs(qualified, "likely", 0)).federalTax;
    exact(fail, "qualified Jan-paid tax increment", r2(t1 - t0), 0);
    const nonQualified = base();
    nonQualified.ytdOtherOrdinary = 100000;
    nonQualified.strayJanPaid = { status: "amount", amount: 20000 };
    const t2 = pricePlaygroundYear(decemberCaseInputs(nonQualified, "likely", 0)).federalTax;
    exact(fail, "nonqualified Jan-paid tax increment", r2(t2 - t0), 2400);
    // The portion is a portion: entering more than the total
    // clamps to the total, never an amount on top.
    const over = base();
    over.ytdOtherOrdinary = 100000;
    over.strayJanPaid = { status: "amount", amount: 20000 };
    over.strayJanPaidQualifiedAmount = 25000;
    const t3 = pricePlaygroundYear(decemberCaseInputs(over, "likely", 0)).federalTax;
    exact(fail, "over-entered portion clamps", r2(t3 - t0), 0);
  });

  run("dec-dependent-magi-aca-only", (fail) => {
    // Fix G (finding 8): a filing dependent's $20,000 rides
    // the ACA household MAGI only. The parents' own return
    // ($60,000 wages MFJ, standard deduction $32,200 →
    // taxable $27,800 → tax $24,800 × 10% + $3,000 × 12% =
    // $2,840) is untouched, while the ACA MAGI carries the
    // full $80,000.
    const s = base();
    s.ytdOtherOrdinary = 60000;
    s.strayDependent = { status: "amount", amount: 20000 };
    const pg = pricePlaygroundYear(decemberCaseInputs(s, "likely", 0));
    exact(fail, "parents' federal tax", pg.federalTax, 2840);
    exact(fail, "parents' AGI excludes the dependent", pg.agi, 60000);
    exact(fail, "parents' MAGI excludes the dependent", pg.magi, 60000);
    exact(fail, "ACA MAGI includes the dependent", pg.acaMagi, 80000);
    const r = computeDecemberProjection(s);
    exact(fail, "console non-draw ACA MAGI", r.cases[1]!.nonDrawAcaMagi, 80000);
  });

  run("dec-save-revision-cas", (fail) => {
    // Fix H (finding 9): the save contract the actions
    // enforce. NOTE: this fixture pins only the pure revision
    // DECISION logic — it never reaches the guarded UPDATE
    // the handler runs against the store, which is how the
    // 2026-10-26 wrong-handle bug (the save passed ctx instead
    // of the db handle to the guarded commit, so every
    // correct-revision save on an existing blob threw) shipped
    // green. The guarded-update path itself is covered
    // end-to-end by packaged/harness.ts section G, which
    // drives saveDecemberProjection through the real
    // dispatcher and store.
    // A blob written before revisions existed reads
    // as revision 0; a save from the read revision is
    // allowed and lands at revision + 1; a second save from
    // the SAME base is refused; a save from the new revision
    // succeeds.
    if (parseDecemberRevision(undefined) !== 0) {
      fail("no stored blob should read as revision 0");
    }
    if (parseDecemberRevision("{ not json") !== 0) {
      fail("an unparseable blob should read as revision 0");
    }
    if (parseDecemberRevision('{"revision":4}') !== 4) {
      fail("a stored revision should parse back");
    }
    const first = decideDecemberWrite(0, 0);
    if (!first.allowed || first.nextRevision !== 1) {
      fail("the first save from base 0 should be allowed at revision 1");
    }
    const stale = decideDecemberWrite(1, 0);
    if (stale.allowed) fail("a second save from base 0 should be refused");
    const current = decideDecemberWrite(1, 1);
    if (!current.allowed || current.nextRevision !== 2) {
      fail("a save from the current revision should be allowed");
    }
    // The serialized blob carries the revision AND round-
    // trips through the lenient state parser.
    const state = defaultDecemberState(2026);
    state.ytdOtherOrdinary = 43210;
    const blob = serializeDecemberState(state, 7);
    if (parseDecemberRevision(blob) !== 7) {
      fail("the serialized blob should carry its revision");
    }
    const back = parseDecemberState(blob, 2026);
    if (back.ytdOtherOrdinary !== 43210) {
      fail("the serialized blob should parse back through the state parser");
    }
  });

  run("dec-legacy-blob-split-migration", (fail) => {
    // Fix A's migration, round-5 restated: a pre-split
    // blob carries only the combined pretaxBalance. The
    // parser preserves the amount with ownership
    // UNANSWERED (no owner assignment — the record may
    // know the split); the LOAD path with no record split
    // applies the historical fallback — the combined
    // balance migrates into the primary's split balance,
    // the spouse's defaults to not-entered, and the
    // combined field keeps its value, so the blob prices
    // exactly as it did.
    const parsedLegacy = parseDecemberState(
      JSON.stringify({ taxYear: 2026, pretaxBalance: 300000 }),
      2026,
    );
    if (parsedLegacy.pretaxSplitExplicit) {
      fail("a legacy combined blob should parse with the split unanswered");
    }
    if (parsedLegacy.pretaxBalancePrimary !== null || parsedLegacy.pretaxBalanceSpouse !== null) {
      fail("the parser must not assign a legacy combined balance to an owner");
    }
    if (parsedLegacy.pretaxBalance !== 300000) {
      fail("legacy combined field should keep its value");
    }
    const legacy = resolveDecemberStateAtLoad(parsedLegacy, null);
    if (legacy.pretaxBalancePrimary !== 300000) {
      fail(`legacy combined should migrate to primary, got ${legacy.pretaxBalancePrimary}`);
    }
    if (legacy.pretaxBalanceSpouse !== null) {
      fail("legacy spouse split should default to null");
    }
    if (legacy.pretaxBalance !== 300000) {
      fail("legacy combined field should keep its value");
    }
    // A split blob reads the split as written, and the
    // combined field is re-derived as the split's sum.
    const split = parseDecemberState(
      JSON.stringify({
        taxYear: 2026,
        pretaxBalancePrimary: 100000,
        pretaxBalanceSpouse: 250000,
      }),
      2026,
    );
    if (split.pretaxBalancePrimary !== 100000 || split.pretaxBalanceSpouse !== 250000) {
      fail("a split blob should read its split as written");
    }
    if (!split.pretaxSplitExplicit) {
      fail("a split blob should read as an explicit split");
    }
    if (split.pretaxBalance !== 350000) {
      fail(`combined should re-derive as the split sum, got ${split.pretaxBalance}`);
    }
    // Every new field defaults inertly on a legacy blob.
    if (
      legacy.rmdAlreadyReceived !== 0 ||
      legacy.acaEnrollmentPremiumAnnual !== null ||
      legacy.strayJanPaidQualifiedAmount !== 0 ||
      legacy.strayROCOrdinary.status !== "na"
    ) {
      fail("new fields should default inertly on a legacy blob");
    }
  });

  run("dec-no-cliff-year-2025", (fail) => {
    // Fix I (finding 10): a pre-2026 year has no ACA cliff.
    // HH2, on ACA, MAGI $50,000: the headline is the
    // no-cliff state — no $0 maximum draw, no cliff figure,
    // and the per-case cliff fields read null the way the
    // Medicare no-ACA state reads.
    const s = base();
    s.taxYear = 2025;
    s.ytdOtherOrdinary = 50000;
    const r = computeDecemberProjection(s);
    if (!r.priced) return fail("the 2025 year should still price");
    if (r.cliff !== null) fail(`cliff should be null, got ${r.cliff}`);
    if (r.targetMagi !== null) fail("target MAGI should be null");
    if (r.headlineDraw !== null) fail("headline draw should be null, not $0");
    if (
      r.headlineText !==
      "No ACA cliff this year — the draw is not cliff-constrained."
    ) {
      fail(`headline should be the no-cliff state, got: ${r.headlineText}`);
    }
    const likely = r.cases[1]!;
    if (likely.maxDraw !== null) fail("per-case max draw should be null");
    if (likely.distanceAtHeadline !== null) {
      fail("per-case distance should be null");
    }
    if (likely.overCliffAtHeadline || likely.overCliffEvenAtZero) {
      fail("a no-cliff year can never be over the cliff");
    }
    exact(fail, "2025 MAGI still prices", likely.nonDrawAcaMagi, 50000);
  });

  /* ---- Round-4 fixtures: the load / prefill path ----
     The reviewer's reproduction household, carried in a
     PRE-V47 BLOB (every field the console then had, the
     second beneficiary fact's key absent): primary 60,
     spouse 75, her pre-tax $246,000, his $10,000, posted
     ordinary income $75,000, household 2, benchmark
     $20,000, APTC taken $12,000, buffer $5,000, the old
     flag true. Two pricings are possible for her RMD:
     Joint (fact true): $246,000 / 28.3 = $8,692.58 → MAGI
     $83,692.58, credit $20,000 − 9.96% × $83,692.58 =
     $11,664.22, repayment $12,000 − $11,664.22 = $335.78.
     Uniform (fact false or unanswered): $246,000 / 24.6 =
     $10,000 → MAGI $85,000, over the $84,600 cliff →
     credit $0, repayment the whole $12,000. Each fixture
     runs the FULL load path — parseDecemberState on the
     stored blob, then resolveDecemberStateAtLoad against
     a Tax Plan record value (the exact function the
     view's hydration runs) — never the pricer alone. */
  const legacyBlobJson = (extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      taxYear: 2026,
      agePrimary: 60,
      ageSpouse: 75,
      spouseSoleBeneficiary: true,
      pretaxBalancePrimary: 10000,
      pretaxBalanceSpouse: 246000,
      pretaxBalance: 256000,
      ytdOtherOrdinary: 75000,
      acaHouseholdSize: 2,
      acaBenchmarkAnnual: 20000,
      aptcTaken: 12000,
      bufferDollars: 5000,
      ...extra,
    });
  const loadAndPrice = (
    blob: string,
    record: boolean | null,
  ): {
    effective: DecemberState;
    rmd: number;
    table: string | null;
    result: DecemberProjectionResult;
    likely: DecemberCaseResult;
  } => {
    const effective = resolveDecemberStateAtLoad(
      parseDecemberState(blob, 2026),
      record,
    );
    const pg = pricePlaygroundYear(decemberCaseInputs(effective, "likely", 0));
    const result = computeDecemberProjection(effective);
    return {
      effective,
      rmd: pg.rmdSpouse,
      table: pg.rmdTable,
      result,
      likely: result.cases[1]!,
    };
  };
  const expectJoint = (
    fail: (m: string) => void,
    label: string,
    got: ReturnType<typeof loadAndPrice>,
  ) => {
    exact(fail, `${label} spouse RMD`, got.rmd, 8692.58);
    if (got.table !== "joint") {
      fail(`${label}: spouse RMD table should be joint, got ${got.table}`);
    }
    exact(fail, `${label} non-draw MAGI`, got.likely.nonDrawAcaMagi, 83692.58);
    exact(fail, `${label} final credit`, got.likely.creditAtHeadline, 11664.22);
    exact(
      fail,
      `${label} excess repayment`,
      got.likely.excessAptcRepayment,
      335.78,
    );
  };
  const expectUniform = (
    fail: (m: string) => void,
    label: string,
    got: ReturnType<typeof loadAndPrice>,
  ) => {
    exact(fail, `${label} spouse RMD`, got.rmd, 10000);
    if (got.table !== "uniform") {
      fail(`${label}: spouse RMD table should be uniform, got ${got.table}`);
    }
    exact(fail, `${label} non-draw MAGI`, got.likely.nonDrawAcaMagi, 85000);
    exact(fail, `${label} final credit`, got.likely.creditAtHeadline, 0);
    exact(
      fail,
      `${label} excess repayment`,
      got.likely.excessAptcRepayment,
      12000,
    );
  };

  run("dec-load-prefill-legacy-record-true", (fail) => {
    // (i) Legacy blob (key missing) + Tax Plan record
    // true → the record supplies the answer at load and
    // the year prices on the Joint table.
    const got = loadAndPrice(legacyBlobJson(), true);
    if (got.effective.primarySoleBeneficiaryOfSpouse !== true) {
      fail("the record's true should resolve the unanswered console value");
    }
    expectJoint(fail, "legacy+record-true", got);
  });

  run("dec-load-prefill-legacy-record-false", (fail) => {
    // (ii) Legacy blob + record false → the record's
    // explicit false supplies the answer; Uniform.
    const got = loadAndPrice(legacyBlobJson(), false);
    if (got.effective.primarySoleBeneficiaryOfSpouse !== false) {
      fail("the record's false should resolve the unanswered console value");
    }
    expectUniform(fail, "legacy+record-false", got);
  });

  run("dec-load-prefill-legacy-record-null", (fail) => {
    // (iii) Legacy blob + record null → still unanswered;
    // unanswered prices Uniform (not established).
    const got = loadAndPrice(legacyBlobJson(), null);
    if (got.effective.primarySoleBeneficiaryOfSpouse !== null) {
      fail("a null record must leave the console value unanswered");
    }
    expectUniform(fail, "legacy+record-null", got);
  });

  run("dec-load-prefill-console-false-wins", (fail) => {
    // (iv) Blob explicit false + record true → the
    // console's own answer wins; prefill never
    // overwrites an explicit console value. Round-5: a
    // GENUINE explicit false lives in a blob WITH the
    // state-format marker (a pre-marker false reads as
    // unanswered — pinned by
    // dec-pre-marker-beneficiary-false), so this blob
    // carries the marker, exactly as every save since
    // the marker build writes it.
    const got = loadAndPrice(
      legacyBlobJson({
        primarySoleBeneficiaryOfSpouse: false,
        decemberStateFormat: DECEMBER_STATE_FORMAT,
      }),
      true,
    );
    if (got.effective.primarySoleBeneficiaryOfSpouse !== false) {
      fail("an explicit console false must survive load resolution");
    }
    expectUniform(fail, "console-false+record-true", got);
  });

  run("dec-load-prefill-console-true-wins", (fail) => {
    // (v) Blob explicit true + record false → the
    // console's own answer wins, in the other direction.
    const got = loadAndPrice(
      legacyBlobJson({ primarySoleBeneficiaryOfSpouse: true }),
      false,
    );
    if (got.effective.primarySoleBeneficiaryOfSpouse !== true) {
      fail("an explicit console true must survive load resolution");
    }
    expectJoint(fail, "console-true+record-false", got);
  });

  run("dec-beneficiary-tristate-round-trip", (fail) => {
    // (vi) Tri-state round trip: unset / true / false
    // survive a save → load cycle DISTINCTLY, through
    // the exact serializer and parser the actions run.
    const roundTrip = (v: boolean | null): boolean | null => {
      const s = defaultDecemberState(2026);
      s.primarySoleBeneficiaryOfSpouse = v;
      return parseDecemberState(serializeDecemberState(s, 3), 2026)
        .primarySoleBeneficiaryOfSpouse;
    };
    if (roundTrip(null) !== null) fail("unset (null) should round-trip as null");
    if (roundTrip(true) !== true) fail("true should round-trip as true");
    if (roundTrip(false) !== false) fail("false should round-trip as false");
    // The writer schema itself carries the tri-state:
    // null, true, and false all validate as a state.
    for (const v of [null, true, false] as const) {
      const s = defaultDecemberState(2026);
      s.primarySoleBeneficiaryOfSpouse = v;
      if (!decemberState.safeParse(s).success) {
        fail(`the state schema should accept primarySoleBeneficiaryOfSpouse=${v}`);
      }
    }
    // And the raw-blob reads: explicit null reads
    // unanswered, a missing key reads unanswered, and
    // neither collapses into false.
    const explicitNull = parseDecemberState(
      JSON.stringify({ taxYear: 2026, primarySoleBeneficiaryOfSpouse: null }),
      2026,
    );
    if (explicitNull.primarySoleBeneficiaryOfSpouse !== null) {
      fail("an explicit null in the blob should read as unanswered");
    }
    const missing = parseDecemberState(
      JSON.stringify({ taxYear: 2026 }),
      2026,
    );
    if (missing.primarySoleBeneficiaryOfSpouse !== null) {
      fail("a missing key should read as unanswered, never false");
    }
    if (defaultDecemberState(2026).primarySoleBeneficiaryOfSpouse !== null) {
      fail("the default state should start unanswered");
    }
  });

  /* ---- Round-5 fixtures: provenance of stored values ---- */

  run("dec-pre-marker-beneficiary-false", (fail) => {
    // Round-6 fix 1: a pre-marker beneficiary false STANDS
    // as an answered false — v47's machine-written default
    // and a deliberate v48 No are indistinguishable in the
    // blob, and a stored console answer always outranks
    // the Tax Plan record overlay; the ambiguity is
    // carried by legacyBeneficiaryAnswerUnconfirmed,
    // which asks the user to confirm it. Through the real
    // parse path: (1) pre-marker false → ANSWERED false
    // and the flag raised; (2) pre-marker true → true, no
    // flag; (3) a format-2 blob with false → false, NO
    // flag (a stored false there was already a genuine
    // answer under the round-5 rule); (4) missing key and
    // explicit null → null (unanswered), no flag; (5) the
    // serializer writes decemberStateFormat ===
    // DECEMBER_STATE_FORMAT.
    const preMarkerFalse = parseDecemberState(
      JSON.stringify({ taxYear: 2026, primarySoleBeneficiaryOfSpouse: false }),
      2026,
    );
    if (preMarkerFalse.primarySoleBeneficiaryOfSpouse !== false) {
      fail("a pre-marker stored false should read as ANSWERED false");
    }
    if (!preMarkerFalse.legacyBeneficiaryAnswerUnconfirmed) {
      fail("a pre-marker stored false should raise the confirm flag");
    }
    const preMarkerTrue = parseDecemberState(
      JSON.stringify({ taxYear: 2026, primarySoleBeneficiaryOfSpouse: true }),
      2026,
    );
    if (preMarkerTrue.primarySoleBeneficiaryOfSpouse !== true) {
      fail("a pre-marker stored true should stay true");
    }
    if (preMarkerTrue.legacyBeneficiaryAnswerUnconfirmed) {
      fail("a pre-marker stored true should raise no flag");
    }
    const format2False = parseDecemberState(
      JSON.stringify({
        taxYear: 2026,
        primarySoleBeneficiaryOfSpouse: false,
        decemberStateFormat: 2,
      }),
      2026,
    );
    if (format2False.primarySoleBeneficiaryOfSpouse !== false) {
      fail("a format-2 stored false should read as a genuine false");
    }
    if (format2False.legacyBeneficiaryAnswerUnconfirmed) {
      fail("a format-2 stored false should raise no flag");
    }
    const markedFalse = parseDecemberState(
      JSON.stringify({
        taxYear: 2026,
        primarySoleBeneficiaryOfSpouse: false,
        decemberStateFormat: DECEMBER_STATE_FORMAT,
      }),
      2026,
    );
    if (markedFalse.primarySoleBeneficiaryOfSpouse !== false) {
      fail("a with-marker stored false should read as a genuine false");
    }
    const missingKey = parseDecemberState(
      JSON.stringify({ taxYear: 2026 }),
      2026,
    );
    if (missingKey.primarySoleBeneficiaryOfSpouse !== null) {
      fail("a missing beneficiary key should read as unanswered (null)");
    }
    if (missingKey.legacyBeneficiaryAnswerUnconfirmed) {
      fail("a missing beneficiary key should raise no flag");
    }
    const explicitNull = parseDecemberState(
      JSON.stringify({ taxYear: 2026, primarySoleBeneficiaryOfSpouse: null }),
      2026,
    );
    if (explicitNull.primarySoleBeneficiaryOfSpouse !== null) {
      fail("an explicit null should read as unanswered (null)");
    }
    if (explicitNull.legacyBeneficiaryAnswerUnconfirmed) {
      fail("an explicit null should raise no flag");
    }
    // The serializer writes the marker: a state saved
    // from this build on carries it, and its false then
    // round-trips as false (also pinned by the tri-state
    // round-trip fixture above).
    const blob = serializeDecemberState(defaultDecemberState(2026), 1);
    const raw = JSON.parse(blob) as Record<string, unknown>;
    if (raw.decemberStateFormat !== DECEMBER_STATE_FORMAT) {
      fail("the serializer should write the state-format marker");
    }
    // (6) END-TO-END, the round-6 genuine-No
    // reproduction: a pre-marker false + a record that
    // answers true — the effective value STAYS false (the
    // overlay must not move a stored answer) and the year
    // prices the Uniform column.
    const genuineNo = loadAndPrice(
      legacyBlobJson({ primarySoleBeneficiaryOfSpouse: false }),
      true,
    );
    if (genuineNo.effective.primarySoleBeneficiaryOfSpouse !== false) {
      fail("a pre-marker false must stand against the record overlay");
    }
    expectUniform(fail, "pre-marker-false+record-true", genuineNo);
  });

  run("dec-beneficiary-answer-flag-lifecycle", (fail) => {
    // Round-6 fix 1, flag lifecycle: the confirm flag
    // survives every save, serializer round-trip, and
    // reload until the beneficiary control itself is
    // edited — and a state whose value is true never
    // carries it.
    const parsed = parseDecemberState(
      JSON.stringify({ taxYear: 2026, primarySoleBeneficiaryOfSpouse: false }),
      2026,
    );
    if (parsed.primarySoleBeneficiaryOfSpouse !== false) {
      fail("the pre-marker false should parse as answered false");
    }
    if (!parsed.legacyBeneficiaryAnswerUnconfirmed) {
      fail("the pre-marker false should raise the flag");
    }
    const prov = decemberStoredProvenanceOf(parsed);
    if (!prov.legacyBeneficiaryAnswerUnconfirmed) {
      fail("the stored provenance should carry the flag");
    }
    // A save with no edits: flag still true, value still
    // false.
    const noEditSave = decemberStateForSave(parsed, prov, {
      beneficiary: false,
      balances: false,
    });
    if (!noEditSave.legacyBeneficiaryAnswerUnconfirmed) {
      fail("an unrelated save must not clear the beneficiary flag");
    }
    if (noEditSave.primarySoleBeneficiaryOfSpouse !== false) {
      fail("an unrelated save must keep the answered false");
    }
    // Serialize → parse (a format-3 round trip): value
    // false AND flag still true — the stored flag is
    // authoritative in a format-3 blob.
    const roundTripped = parseDecemberState(
      serializeDecemberState(noEditSave, 4),
      2026,
    );
    if (roundTripped.primarySoleBeneficiaryOfSpouse !== false) {
      fail("the format-3 round trip should keep the answered false");
    }
    if (!roundTripped.legacyBeneficiaryAnswerUnconfirmed) {
      fail("the format-3 round trip should preserve the flag");
    }
    // The matching edit clears it.
    const editedSave = decemberStateForSave(
      roundTripped,
      decemberStoredProvenanceOf(roundTripped),
      { beneficiary: true, balances: false },
    );
    if (editedSave.legacyBeneficiaryAnswerUnconfirmed) {
      fail("editing the beneficiary control should clear the flag");
    }
    const editedBack = parseDecemberState(
      serializeDecemberState(editedSave, 5),
      2026,
    );
    if (editedBack.legacyBeneficiaryAnswerUnconfirmed) {
      fail("the cleared flag should stay cleared after a round trip");
    }
    if (editedBack.primarySoleBeneficiaryOfSpouse !== false) {
      fail("the answered false should survive the clearing round trip");
    }
    // A state whose beneficiary value is true never
    // carries the flag — even a format-3 blob that stores
    // the flag beside a true value parses it away.
    const trueWithFlag = parseDecemberState(
      JSON.stringify({
        taxYear: 2026,
        primarySoleBeneficiaryOfSpouse: true,
        legacyBeneficiaryAnswerUnconfirmed: true,
        decemberStateFormat: DECEMBER_STATE_FORMAT,
      }),
      2026,
    );
    if (trueWithFlag.primarySoleBeneficiaryOfSpouse !== true) {
      fail("a stored true should stay true");
    }
    if (trueWithFlag.legacyBeneficiaryAnswerUnconfirmed) {
      fail("a true beneficiary value must never carry the flag");
    }
  });

  run("dec-resolution-never-enters-saved-state", (fail) => {
    // Fix 1b (Finding 2): load resolution is an overlay.
    // The sequence, run at the state/serialize layer the
    // client actually uses (parse → resolveDecemberStateAtLoad
    // for display → decemberStateForSave for the autosave
    // → serializeDecemberState → parse): the stored fact
    // is unanswered and the record says true, so the open
    // prices Joint; the user edits ONLY bufferDollars
    // ($5,000 → $4,900) and the autosave must still store
    // null for the beneficiary fact; the record then
    // flips to false, and reopening prices Uniform.
    const stored = parseDecemberState(legacyBlobJson(), 2026);
    if (stored.primarySoleBeneficiaryOfSpouse !== null) {
      fail("the stored blob should start unanswered");
    }
    const provenance = decemberStoredProvenanceOf(stored);
    const display = resolveDecemberStateAtLoad(stored, true);
    if (display.primarySoleBeneficiaryOfSpouse !== true) {
      fail("the record's true should supply the display value");
    }
    const displayPriced = {
      effective: display,
      rmd: pricePlaygroundYear(decemberCaseInputs(display, "likely", 0))
        .rmdSpouse,
      table: pricePlaygroundYear(decemberCaseInputs(display, "likely", 0))
        .rmdTable,
      result: computeDecemberProjection(display),
      likely: computeDecemberProjection(display).cases[1]!,
    };
    expectJoint(fail, "resolved-display", displayPriced);
    // The unrelated edit + autosave.
    const edited: DecemberState = { ...display, bufferDollars: 4900 };
    const toSave = decemberStateForSave(edited, provenance, {
      beneficiary: false,
      balances: false,
    });
    if (toSave.primarySoleBeneficiaryOfSpouse !== null) {
      fail("an unrelated edit must save the beneficiary fact as unanswered");
    }
    if (toSave.bufferDollars !== 4900) {
      fail("the buffer edit itself should be in the saved state");
    }
    const reopened = parseDecemberState(
      serializeDecemberState(toSave, 5),
      2026,
    );
    if (reopened.primarySoleBeneficiaryOfSpouse !== null) {
      fail("the reloaded blob should still read unanswered");
    }
    // The record flips to false → reopening prices
    // Uniform (the same household; the $4,900 buffer does
    // not change the credit arithmetic — both MAGI values
    // sit past the buffered target, and Uniform MAGI is
    // over the cliff itself).
    const flipped = loadAndPrice(serializeDecemberState(toSave, 5), false);
    if (flipped.effective.primarySoleBeneficiaryOfSpouse !== false) {
      fail("the flipped record false should resolve the unanswered value");
    }
    expectUniform(fail, "record-flipped-false", flipped);
    // The other direction of the same rule: when the user
    // DOES change the beneficiary control, the chosen
    // value is what saves.
    const answered = decemberStateForSave(
      { ...display, primarySoleBeneficiaryOfSpouse: false },
      provenance,
      { beneficiary: true, balances: false },
    );
    if (answered.primarySoleBeneficiaryOfSpouse !== false) {
      fail("a console-changed beneficiary value should be the saved value");
    }
    const answeredBack = parseDecemberState(
      serializeDecemberState(answered, 6),
      2026,
    );
    if (answeredBack.primarySoleBeneficiaryOfSpouse !== false) {
      fail("a console answer saved with the marker should read back as false");
    }
  });

  run("dec-legacy-balance-ownership-resolution", (fail) => {
    // Fix 2 (Finding 3): a legacy blob with ONLY the
    // combined balance has ownership unanswered. The
    // reviewer's household: primary 60, spouse 75 on
    // Medicare, combined $246,000, posted ordinary income
    // $75,000, HH2, benchmark $20,000, APTC $12,000,
    // buffer $5,000, no Joint-table designation.
    const legacyCombinedBlob = JSON.stringify({
      taxYear: 2026,
      agePrimary: 60,
      ageSpouse: 75,
      onMedicareSpouse: true,
      pretaxBalance: 246000,
      ytdOtherOrdinary: 75000,
      acaHouseholdSize: 2,
      acaBenchmarkAnnual: 20000,
      aptcTaken: 12000,
      bufferDollars: 5000,
    });
    const parsedLegacy = parseDecemberState(legacyCombinedBlob, 2026);
    if (parsedLegacy.pretaxSplitExplicit) {
      fail("the legacy blob should parse with ownership unanswered");
    }
    // (i) Record split {0 / 246,000} — the money is HERS:
    // her RMD is $246,000 / 24.6 = $10,000, MAGI $85,000
    // is over the $84,600 cliff at a $0 draw, the safe
    // draw is $0, and the whole $12,000 APTC is repaid.
    const hers = resolveDecemberStateAtLoad(parsedLegacy, {
      pretaxBalancePrimary: 0,
      pretaxBalanceSpouse: 246000,
    });
    if (hers.pretaxBalancePrimary !== 0 || hers.pretaxBalanceSpouse !== 246000) {
      fail("the record split should supply the balance ownership");
    }
    const hersPg = pricePlaygroundYear(decemberCaseInputs(hers, "likely", 0));
    exact(fail, "(i) spouse RMD", hersPg.rmdSpouse, 10000);
    exact(fail, "(i) primary RMD", hersPg.rmdPrimary, 0);
    const hersResult = computeDecemberProjection(hers);
    exact(fail, "(i) non-draw MAGI", hersResult.cases[1]!.nonDrawAcaMagi, 85000);
    if (hersResult.headlineDraw !== 0) {
      fail(`(i) headline draw should be $0, got ${hersResult.headlineDraw}`);
    }
    exact(
      fail,
      "(i) excess repayment",
      hersResult.cases[1]!.excessAptcRepayment,
      12000,
    );
    // (ii) Record split {246,000 / 0} — the money is HIS:
    // the split resolves to the primary, exactly the
    // assignment the old parser made unconditionally.
    const his = resolveDecemberStateAtLoad(parsedLegacy, {
      pretaxBalancePrimary: 246000,
      pretaxBalanceSpouse: 0,
    });
    if (his.pretaxBalancePrimary !== 246000 || his.pretaxBalanceSpouse !== 0) {
      fail("(ii) the record split should assign the balance to the primary");
    }
    // (iii) No record split → the last-resort fallback:
    // combined → primary, spouse not-entered (the round-1
    // legacy expectation, preserved on this path only).
    const fallback = resolveDecemberStateAtLoad(parsedLegacy, {});
    if (fallback.pretaxBalancePrimary !== 246000 || fallback.pretaxBalanceSpouse !== null) {
      fail("(iii) with no record split the combined balance should fall back to the primary");
    }
    // (iv) An explicit blob split governs over a
    // different record split.
    const explicitBlob = parseDecemberState(
      JSON.stringify({
        taxYear: 2026,
        pretaxBalancePrimary: 10000,
        pretaxBalanceSpouse: 246000,
      }),
      2026,
    );
    const blobWins = resolveDecemberStateAtLoad(explicitBlob, {
      pretaxBalancePrimary: 246000,
      pretaxBalanceSpouse: 0,
    });
    if (blobWins.pretaxBalancePrimary !== 10000 || blobWins.pretaxBalanceSpouse !== 246000) {
      fail("(iv) an explicit blob split must govern over the record split");
    }
    // (v) Round-6 fix 2, the disagreeing-totals
    // reproduction: the saved combined total is $246,000
    // but the record's split sums to $300,000 (all the
    // spouse's). Resolution ALLOCATES the saved total by
    // the record's proportions — spouse share $246,000,
    // primary share $0, combined still $246,000 — and
    // never substitutes the record's total. Her RMD is
    // $246,000 / 24.6 = $10,000; non-draw MAGI $73,000 +
    // $10,000 = $83,000; credit $20,000 − 9.96% × $83,000
    // = $11,733.20; repayment $12,000 − $11,733.20 =
    // $266.80; the headline draw is $0 (MAGI is already
    // past the $79,600 target at a $0 draw).
    const disagreeBlob = JSON.stringify({
      taxYear: 2026,
      agePrimary: 60,
      ageSpouse: 75,
      onMedicareSpouse: true,
      pretaxBalance: 246000,
      ytdOtherOrdinary: 73000,
      acaHouseholdSize: 2,
      acaBenchmarkAnnual: 20000,
      aptcTaken: 12000,
      bufferDollars: 5000,
    });
    const disagreeParsed = parseDecemberState(disagreeBlob, 2026);
    const allocated = resolveDecemberStateAtLoad(disagreeParsed, {
      pretaxBalancePrimary: 0,
      pretaxBalanceSpouse: 300000,
    });
    if (allocated.pretaxBalanceSpouse !== 246000 || allocated.pretaxBalancePrimary !== 0) {
      fail("(v) the saved total should be allocated by the record's proportions");
    }
    if (allocated.pretaxBalance !== 246000) {
      fail("(v) resolution must never change the saved combined total");
    }
    const allocatedPg = pricePlaygroundYear(
      decemberCaseInputs(allocated, "likely", 0),
    );
    exact(fail, "(v) spouse RMD", allocatedPg.rmdSpouse, 10000);
    const allocatedResult = computeDecemberProjection(allocated);
    exact(
      fail,
      "(v) likely non-draw MAGI",
      allocatedResult.cases[1]!.nonDrawAcaMagi,
      83000,
    );
    exact(
      fail,
      "(v) credit at headline",
      allocatedResult.cases[1]!.creditAtHeadline,
      11733.2,
    );
    exact(
      fail,
      "(v) excess repayment",
      allocatedResult.cases[1]!.excessAptcRepayment,
      266.8,
    );
    if (allocatedResult.headlineDraw !== 0) {
      fail(`(v) headline draw should be $0, got ${allocatedResult.headlineDraw}`);
    }
    // (vi) A record split of {0 / 0} has no usable
    // proportions (sum $0): the last-resort fallback —
    // combined → primary, spouse not-entered.
    const zeroRecord = resolveDecemberStateAtLoad(parsedLegacy, {
      pretaxBalancePrimary: 0,
      pretaxBalanceSpouse: 0,
    });
    if (zeroRecord.pretaxBalancePrimary !== 246000 || zeroRecord.pretaxBalanceSpouse !== null) {
      fail("(vi) a zero-sum record split should fall back to combined → primary");
    }
    if (zeroRecord.pretaxBalance !== 246000) {
      fail("(vi) the fallback must keep the saved combined total");
    }
    // (vii) Round-7 fix A, partial split — spouse known:
    // record {primary null, spouse $246,000} with the
    // saved total $246,000. The known spouse amount
    // already accounts for the whole total, so resolution
    // gives spouse $246,000 / primary $0 (both numbers,
    // total preserved). Her RMD is $246,000 / 24.6 =
    // $10,000, MAGI $85,000, credit $0, repayment $12,000,
    // headline draw $0 — the same pricing as the
    // both-known case (i).
    const partialSpouseFull = resolveDecemberStateAtLoad(parsedLegacy, {
      pretaxBalancePrimary: null,
      pretaxBalanceSpouse: 246000,
    });
    if (
      partialSpouseFull.pretaxBalancePrimary !== 0 ||
      partialSpouseFull.pretaxBalanceSpouse !== 246000 ||
      partialSpouseFull.pretaxBalance !== 246000
    ) {
      fail("(vii) a partial spouse-known split should resolve to spouse $246,000 / primary $0 with the total preserved");
    }
    const partialPg = pricePlaygroundYear(
      decemberCaseInputs(partialSpouseFull, "likely", 0),
    );
    exact(fail, "(vii) spouse RMD", partialPg.rmdSpouse, 10000);
    const partialResult = computeDecemberProjection(partialSpouseFull);
    exact(
      fail,
      "(vii) non-draw MAGI",
      partialResult.cases[1]!.nonDrawAcaMagi,
      85000,
    );
    exact(
      fail,
      "(vii) credit at headline",
      partialResult.cases[1]!.creditAtHeadline,
      0,
    );
    exact(
      fail,
      "(vii) excess repayment",
      partialResult.cases[1]!.excessAptcRepayment,
      12000,
    );
    if (partialResult.headlineDraw !== 0) {
      fail(`(vii) headline draw should be $0, got ${partialResult.headlineDraw}`);
    }
    // (viii) Partial, known below the total: record
    // {null, $200,000}, saved $246,000 → spouse $200,000 /
    // primary $46,000 (the remainder), total preserved.
    const partialBelow = resolveDecemberStateAtLoad(parsedLegacy, {
      pretaxBalancePrimary: null,
      pretaxBalanceSpouse: 200000,
    });
    if (
      partialBelow.pretaxBalanceSpouse !== 200000 ||
      partialBelow.pretaxBalancePrimary !== 46000 ||
      partialBelow.pretaxBalance !== 246000
    ) {
      fail("(viii) a partial split below the total should give the remainder to the other owner");
    }
    // (ix) Partial, known above the total: record
    // {null, $300,000}, saved $246,000 → the known owner
    // is capped at the total: spouse $246,000 / primary
    // $0, total preserved.
    const partialAbove = resolveDecemberStateAtLoad(parsedLegacy, {
      pretaxBalancePrimary: null,
      pretaxBalanceSpouse: 300000,
    });
    if (
      partialAbove.pretaxBalanceSpouse !== 246000 ||
      partialAbove.pretaxBalancePrimary !== 0 ||
      partialAbove.pretaxBalance !== 246000
    ) {
      fail("(ix) a partial split above the total should cap the known owner at the saved total");
    }
    // (x) Primary-known mirror: record {$246,000, null},
    // saved $246,000 → primary $246,000 / spouse $0.
    const partialPrimary = resolveDecemberStateAtLoad(parsedLegacy, {
      pretaxBalancePrimary: 246000,
      pretaxBalanceSpouse: null,
    });
    if (
      partialPrimary.pretaxBalancePrimary !== 246000 ||
      partialPrimary.pretaxBalanceSpouse !== 0 ||
      partialPrimary.pretaxBalance !== 246000
    ) {
      fail("(x) a primary-known partial split should resolve to primary $246,000 / spouse $0");
    }
    // And the save-side rule: an unrelated edit on a
    // legacy-ownership console saves the STORED
    // provenance (combined, unanswered) — never the
    // record-supplied split — while an edit to a balance
    // field makes the console's own values govern.
    const prov = decemberStoredProvenanceOf(parsedLegacy);
    const unrelatedSave = decemberStateForSave(
      { ...hers, bufferDollars: 4900 },
      prov,
      { beneficiary: false, balances: false },
    );
    if (
      unrelatedSave.pretaxBalance !== 246000 ||
      unrelatedSave.pretaxBalancePrimary !== null ||
      unrelatedSave.pretaxSplitExplicit
    ) {
      fail("an unrelated edit must not save the record-supplied split as the console's own");
    }
    const balanceSave = decemberStateForSave(hers, prov, {
      beneficiary: false,
      balances: true,
    });
    if (
      balanceSave.pretaxBalancePrimary !== 0 ||
      balanceSave.pretaxBalanceSpouse !== 246000 ||
      !balanceSave.pretaxSplitExplicit
    ) {
      fail("a balance edit should save the console's own split as explicit");
    }
  });

  run("dec-legacy-character-provenance-flags", (fail) => {
    // Fix 3 (Findings 4 + 5), round-6 lifecycle: a legacy
    // amount predating its tax-character split parses
    // with a provenance flag and prices with a warning
    // naming the unconfirmed character; the flag changes
    // NO figure (the entered split values govern — here
    // the split defaults, exactly the pre-fix pricing).
    // Round-6: pre-format-3 blobs DERIVE the flags (split
    // key absent OR still at its default — an old
    // serializer wrote the keys at their defaults without
    // the character ever being confirmed); format-3
    // blobs carry the flags as stored (authoritative);
    // and a flag clears ONLY when the user edits the
    // matching character control — an unrelated save no
    // longer clears it.
    const priced = {
      taxYear: 2026,
      agePrimary: 60,
      ageSpouse: 58,
      acaHouseholdSize: 2,
      acaBenchmarkAnnual: 20000,
    };
    const rocLegacy = parseDecemberState(
      JSON.stringify({
        ...priced,
        strayROC: { status: "amount", amount: 30000 },
      }),
      2026,
    );
    if (!rocLegacy.legacyRocSplitUnconfirmed) {
      fail("a legacy ROC amount without the split key should set the ROC flag");
    }
    if (rocLegacy.legacyJanPaidSplitUnconfirmed) {
      fail("the ROC-only blob should not set the January-paid flag");
    }
    const rocResult = computeDecemberProjection(rocLegacy);
    if (
      !rocResult.warnings.some(
        (w) => w.includes("Return of capital") && w.includes("unconfirmed"),
      )
    ) {
      fail("the projection should warn that the ROC character is unconfirmed");
    }
    const janLegacy = parseDecemberState(
      JSON.stringify({
        ...priced,
        strayJanPaid: { status: "amount", amount: 20000 },
      }),
      2026,
    );
    if (!janLegacy.legacyJanPaidSplitUnconfirmed) {
      fail("a legacy January-paid amount without the qualified key should set the flag");
    }
    if (janLegacy.legacyRocSplitUnconfirmed) {
      fail("the January-paid-only blob should not set the ROC flag");
    }
    const janResult = computeDecemberProjection(janLegacy);
    if (
      !janResult.warnings.some(
        (w) => w.includes("January-paid") && w.includes("unconfirmed"),
      )
    ) {
      fail("the projection should warn that the January-paid character is unconfirmed");
    }
    // The v48-round-trip manifestation: the split keys
    // are PRESENT at their defaults but there is NO
    // format marker — a v48 autosave wrote the keys
    // without the character ever being confirmed — so
    // both flags still raise.
    const v48RoundTrip = parseDecemberState(
      JSON.stringify({
        ...priced,
        strayROC: { status: "amount", amount: 30000 },
        strayROCOrdinary: { status: "na", amount: 0 },
        strayJanPaid: { status: "amount", amount: 20000 },
        strayJanPaidQualifiedAmount: 0,
      }),
      2026,
    );
    if (!v48RoundTrip.legacyRocSplitUnconfirmed || !v48RoundTrip.legacyJanPaidSplitUnconfirmed) {
      fail("a pre-marker blob with default-valued splits should set both flags");
    }
    // A format-2 blob with default splits derives the
    // same way: both flags.
    const format2Defaults = parseDecemberState(
      JSON.stringify({
        ...priced,
        decemberStateFormat: 2,
        strayROC: { status: "amount", amount: 30000 },
        strayROCOrdinary: { status: "na", amount: 0 },
        strayJanPaid: { status: "amount", amount: 20000 },
        strayJanPaidQualifiedAmount: 0,
      }),
      2026,
    );
    if (!format2Defaults.legacyRocSplitUnconfirmed || !format2Defaults.legacyJanPaidSplitUnconfirmed) {
      fail("a format-2 blob with default splits should set both flags");
    }
    // A format-3 blob (written through the serializer)
    // with stored flags FALSE and default splits raises
    // NEITHER — the stored values are authoritative.
    const bothLegacy = parseDecemberState(
      JSON.stringify({
        ...priced,
        strayROC: { status: "amount", amount: 30000 },
        strayJanPaid: { status: "amount", amount: 20000 },
      }),
      2026,
    );
    if (!bothLegacy.legacyRocSplitUnconfirmed || !bothLegacy.legacyJanPaidSplitUnconfirmed) {
      fail("the combined legacy blob should set both flags");
    }
    const storedFalse: DecemberState = {
      ...bothLegacy,
      legacyRocSplitUnconfirmed: false,
      legacyJanPaidSplitUnconfirmed: false,
    };
    const format3False = parseDecemberState(
      serializeDecemberState(storedFalse, 2),
      2026,
    );
    if (format3False.legacyRocSplitUnconfirmed || format3False.legacyJanPaidSplitUnconfirmed) {
      fail("a format-3 blob with stored flags false should raise neither flag");
    }
    const format3FalseResult = computeDecemberProjection(format3False);
    if (format3FalseResult.warnings.some((w) => w.includes("unconfirmed"))) {
      fail("a format-3 state with stored flags false should price with no unconfirmed warning");
    }
    // A format-3 blob with stored flags TRUE keeps them.
    const format3True = parseDecemberState(
      serializeDecemberState(bothLegacy, 2),
      2026,
    );
    if (!format3True.legacyRocSplitUnconfirmed || !format3True.legacyJanPaidSplitUnconfirmed) {
      fail("a format-3 blob with stored flags true should keep both flags");
    }
    // An old blob with a NON-default split — a deliberate
    // entry under the split's own terms — raises no flag.
    const nonDefault = parseDecemberState(
      JSON.stringify({
        ...priced,
        strayROC: { status: "amount", amount: 30000 },
        strayROCOrdinary: { status: "amount", amount: 5000 },
        strayJanPaid: { status: "amount", amount: 20000 },
        strayJanPaidQualifiedAmount: 5000,
      }),
      2026,
    );
    if (nonDefault.legacyRocSplitUnconfirmed || nonDefault.legacyJanPaidSplitUnconfirmed) {
      fail("an old blob with non-default splits should set no flags");
    }
    // Accepted false positive, pinned deliberately: a
    // pre-format-3 blob whose strayROCOrdinary is
    // { status: "amount", amount: 0 } — a genuine "$0 of
    // it is ordinary" entry — still raises the ROC flag
    // until the control is re-touched, because a
    // default-valued split cannot be distinguished from
    // a serializer-written default.
    const falsePositive = parseDecemberState(
      JSON.stringify({
        ...priced,
        strayROC: { status: "amount", amount: 30000 },
        strayROCOrdinary: { status: "amount", amount: 0 },
      }),
      2026,
    );
    if (!falsePositive.legacyRocSplitUnconfirmed) {
      fail("the accepted false positive: a $0 ordinary split in an old blob should still raise the ROC flag");
    }
    // The flags change no pricing: the legacy ROC state
    // and the same state with the split entered at its
    // defaults price identically.
    const rocExplicitTwin = parseDecemberState(
      JSON.stringify({
        ...priced,
        strayROC: { status: "amount", amount: 30000 },
        strayROCOrdinary: { status: "na", amount: 0 },
      }),
      2026,
    );
    exact(
      fail,
      "legacy ROC pricing equals explicit-default pricing",
      computeDecemberProjection(rocLegacy).cases[1]!.federalTaxAtHeadline,
      computeDecemberProjection(rocExplicitTwin).cases[1]!.federalTaxAtHeadline,
    );
    // The flags SURVIVE an unrelated-field save
    // derivation (round-6 — this replaces the round-5
    // "a save round trip clears both flags" assertion):
    // decemberStateForSave with every edit flag false,
    // then serialize → parse → still raised.
    const prov = decemberStoredProvenanceOf(bothLegacy);
    const unrelatedSave = decemberStateForSave(
      { ...bothLegacy, bufferDollars: 4900 },
      prov,
      { beneficiary: false, balances: false },
    );
    if (!unrelatedSave.legacyRocSplitUnconfirmed || !unrelatedSave.legacyJanPaidSplitUnconfirmed) {
      fail("an unrelated save derivation must keep both character flags");
    }
    const survived = parseDecemberState(
      serializeDecemberState(unrelatedSave, 3),
      2026,
    );
    if (!survived.legacyRocSplitUnconfirmed || !survived.legacyJanPaidSplitUnconfirmed) {
      fail("both character flags should survive a save → load round trip");
    }
    // Each flag clears after its MATCHING edit
    // derivation — and only that one.
    const rocEdited = decemberStateForSave(bothLegacy, prov, {
      beneficiary: false,
      balances: false,
      rocCharacter: true,
    });
    if (rocEdited.legacyRocSplitUnconfirmed) {
      fail("a ROC character edit should clear the ROC flag");
    }
    if (!rocEdited.legacyJanPaidSplitUnconfirmed) {
      fail("a ROC character edit must not clear the January-paid flag");
    }
    const janEdited = decemberStateForSave(bothLegacy, prov, {
      beneficiary: false,
      balances: false,
      janPaidCharacter: true,
    });
    if (janEdited.legacyJanPaidSplitUnconfirmed) {
      fail("a January-paid character edit should clear the January-paid flag");
    }
    if (!janEdited.legacyRocSplitUnconfirmed) {
      fail("a January-paid character edit must not clear the ROC flag");
    }
    // Pricing is unchanged throughout — the round-5
    // differentials, pinned as priced-with-default-split
    // increments over the same household without the
    // stray, through the single-year engine directly.
    const fedAt = (s: DecemberState): number =>
      pricePlaygroundYear(decemberCaseInputs(s, "likely", 0)).federalTax;
    const rocHousehold = (): DecemberState => ({
      ...defaultDecemberState(2026),
      agePrimary: 60,
      ageSpouse: 58,
      ytdOtherOrdinary: 120000,
    });
    const rocNone = fedAt(rocHousehold());
    const rocDefault = fedAt({
      ...rocHousehold(),
      strayROC: { status: "amount", amount: 30000 },
    });
    exact(fail, "ROC $30,000 at the default split adds", r2(rocDefault - rocNone), 2835);
    const rocOrdinary = fedAt({
      ...rocHousehold(),
      strayROCOrdinary: { status: "amount", amount: 30000 },
    });
    exact(fail, "ROC ordinary $30,000 adds", r2(rocOrdinary - rocNone), 5300);
    const janHousehold = (): DecemberState => ({
      ...defaultDecemberState(2026),
      agePrimary: 60,
      ageSpouse: 58,
      ytdOtherOrdinary: 100000,
    });
    const janNone = fedAt(janHousehold());
    const janUnqualified = fedAt({
      ...janHousehold(),
      strayJanPaid: { status: "amount", amount: 20000 },
      strayJanPaidQualifiedAmount: 0,
    });
    exact(fail, "January-paid $20,000 unqualified adds", r2(janUnqualified - janNone), 2400);
    const janQualified = fedAt({
      ...janHousehold(),
      strayJanPaid: { status: "amount", amount: 20000 },
      strayJanPaidQualifiedAmount: 20000,
    });
    exact(fail, "January-paid $20,000 fully qualified adds", r2(janQualified - janNone), 0);
  });

  run("dec-tax-bill-headline-case", (fail) => {
    // Projected tax bill (build v50): the round-3/4
    // standing reproduction — primary 60, spouse 75 (on
    // Medicare), balances $10,000 / $246,000, posted
    // ordinary income $75,000, household of 2, benchmark
    // $20,000, APTC taken $12,000, buffer $5,000, and the
    // primary IS the spouse's sole beneficiary (true), so
    // her RMD prices on the Joint table: $246,000 / 28.3 =
    // $8,692.58. Non-draw MAGI is $75,000 + $8,692.58 =
    // $83,692.58 — already past the $79,600 target (cliff
    // $84,600 − buffer), so the headline draw is $0 and
    // every bill figure below is priced at that $0 draw
    // (solver-independent, hence exact): AGI $83,692.58
    // less $39,850 of deductions ($32,200 standard +
    // $1,650 age-65+ add-on for the spouse + the $6,000
    // §151(d)(5)(C) senior deduction) = taxable income $43,842.58,
    // federal tax $2,480 + 12% × $19,042.58 = $4,765.11.
    // Final credit $20,000 − 9.96% × $83,692.58 =
    // $11,664.22; the $12,000 taken exceeds it, so
    // creditStillDue is $0, the repayment is $335.78, and
    // the net to settle is $4,765.11 − $0 + $335.78 =
    // $5,100.89.
    const s = base();
    s.agePrimary = 60;
    s.ageSpouse = 75;
    s.onMedicareSpouse = true;
    s.spouseSoleBeneficiary = true;
    s.primarySoleBeneficiaryOfSpouse = true;
    s.pretaxBalancePrimary = 10000;
    s.pretaxBalanceSpouse = 246000;
    s.pretaxBalance = 256000;
    s.ytdOtherOrdinary = 75000;
    const r = computeDecemberProjection(s);
    if (r.headlineDraw !== 0) fail(`headline should be $0, got ${r.headlineDraw}`);
    const likely = r.cases[1]!;
    exact(fail, "total income at headline", likely.totalIncomeAtHeadline, 83692.58);
    exact(fail, "MAGI at headline", likely.magiAtHeadline, 83692.58);
    exact(fail, "taxable income at headline", likely.taxableIncomeAtHeadline, 43842.58);
    exact(fail, "federal tax at headline", likely.federalTaxAtHeadline, 4765.11);
    exact(fail, "state tax at headline", likely.stateTaxAtHeadline, 0);
    exact(fail, "total tax at headline", likely.totalTaxAtHeadline, 4765.11);
    exact(fail, "final credit at headline", likely.creditAtHeadline, 11664.22);
    exact(fail, "credit still due at headline", likely.creditStillDue, 0);
    exact(fail, "excess repayment at headline", likely.excessAptcRepayment, 335.78);
    exact(fail, "net settle at headline", likely.netSettleAtHeadline, 5100.89);
    // All ranges are $0, so the low and high cases carry
    // the same bill and the same net.
    for (const c of [r.cases[0]!, r.cases[2]!]) {
      exact(fail, `${c.kind} net settle`, c.netSettleAtHeadline, 5100.89);
      exact(fail, `${c.kind} total income`, c.totalIncomeAtHeadline, 83692.58);
    }
    // A state rate prices the state line off the same
    // taxable income: 5% × $43,842.58 = $2,192.13, total
    // tax $6,957.24, net $6,957.24 + $335.78 = $7,293.02.
    const withState = { ...s, stateRatePct: 5 };
    const ws = computeDecemberProjection(withState).cases[1]!;
    exact(fail, "state tax at 5%", ws.stateTaxAtHeadline, 2192.13);
    exact(fail, "federal tax unchanged at 5% state", ws.federalTaxAtHeadline, 4765.11);
    exact(fail, "total tax at 5% state", ws.totalTaxAtHeadline, 6957.24);
    exact(fail, "net settle at 5% state", ws.netSettleAtHeadline, 7293.02);
  });

  run("dec-tax-bill-no-aptc", (fail) => {
    // The same household with NO advance credit taken:
    // the full final credit is still due at filing, so
    // the net to settle is the total tax less the whole
    // credit — $4,765.11 − $11,664.22 = −$6,899.11 (a net
    // refund at filing, before withholding).
    const s = base();
    s.agePrimary = 60;
    s.ageSpouse = 75;
    s.onMedicareSpouse = true;
    s.spouseSoleBeneficiary = true;
    s.primarySoleBeneficiaryOfSpouse = true;
    s.pretaxBalancePrimary = 10000;
    s.pretaxBalanceSpouse = 246000;
    s.pretaxBalance = 256000;
    s.ytdOtherOrdinary = 75000;
    s.aptcTaken = 0;
    const likely = computeDecemberProjection(s).cases[1]!;
    exact(fail, "final credit", likely.creditAtHeadline, 11664.22);
    exact(fail, "credit still due is the full credit", likely.creditStillDue, 11664.22);
    exact(fail, "excess repayment", likely.excessAptcRepayment, 0);
    exact(fail, "total tax", likely.totalTaxAtHeadline, 4765.11);
    exact(fail, "net settle = total tax − full credit", likely.netSettleAtHeadline, -6899.11);
  });

  run("dec-tax-bill-2025-reconciliation", (fail) => {
    // Round-7 fix B: a pre-2026 year still reconciles the
    // credit it priced. Base case: 2025, MFJ ages 60/58,
    // both on the marketplace, ordinary income $100,000,
    // HH2, benchmark $20,000, no state tax. The 2025
    // schedule prices the credit at 8.5% above 400% FPL
    // with no cliff: expected contribution $8,500, final
    // credit $20,000 − $8,500 = $11,500. Federal tax on
    // $100,000 with the $31,500 standard deduction is
    // $7,743 (taxable $68,500: $2,385 + 12% × $44,650).
    const base2025 = (): DecemberState => {
      const s = base();
      s.taxYear = 2025;
      s.agePrimary = 60;
      s.ageSpouse = 58;
      s.onMedicarePrimary = false;
      s.onMedicareSpouse = false;
      s.ytdOtherOrdinary = 100000;
      s.aptcTaken = 0;
      return s;
    };
    // (i) No APTC taken: the whole credit is still due,
    // the repayment is $0 (APTC ≤ final credit), and the
    // net is $7,743 − $11,500 = −$3,757.
    const noAptc = computeDecemberProjection(base2025()).cases[1]!;
    exact(fail, "(i) final credit", noAptc.creditAtHeadline, 11500);
    exact(fail, "(i) credit still due", noAptc.creditStillDue, 11500);
    exact(fail, "(i) excess repayment", noAptc.excessAptcRepayment, 0);
    exact(fail, "(i) federal tax", noAptc.federalTaxAtHeadline, 7743);
    exact(fail, "(i) net settle", noAptc.netSettleAtHeadline, -3757);
    if (noAptc.netSettleNote !== null) {
      fail(`(i) net settle note should be null, got ${JSON.stringify(noAptc.netSettleNote)}`);
    }
    // (ii) Partial APTC $5,000: $6,500 still due,
    // repayment $0, net $7,743 − $6,500 = $1,243.
    const partialState = base2025();
    partialState.aptcTaken = 5000;
    const partial = computeDecemberProjection(partialState).cases[1]!;
    exact(fail, "(ii) credit still due", partial.creditStillDue, 6500);
    exact(fail, "(ii) excess repayment", partial.excessAptcRepayment, 0);
    exact(fail, "(ii) net settle", partial.netSettleAtHeadline, 1243);
    if (partial.netSettleNote !== null) {
      fail(`(ii) net settle note should be null, got ${JSON.stringify(partial.netSettleNote)}`);
    }
    // (iii) Excess APTC $15,000 above the $11,500 final
    // credit: pre-2026 repayment caps are not modeled, so
    // the repayment is null and the net is null; the
    // credit still due is $0.
    const excessState = base2025();
    excessState.aptcTaken = 15000;
    const excess = computeDecemberProjection(excessState).cases[1]!;
    exact(fail, "(iii) credit still due", excess.creditStillDue, 0);
    if (excess.excessAptcRepayment !== null) {
      fail(`(iii) excess repayment should be null (unmodeled), got ${excess.excessAptcRepayment}`);
    }
    if (excess.netSettleAtHeadline !== null) {
      fail(`(iii) net settle should be null, got ${excess.netSettleAtHeadline}`);
    }
    // The null net carries the pre-2026 reason note
    // verbatim (build v54): the credit WAS priced, so
    // the unmodeled-repayment reason is the one that names
    // the case.
    if (
      excess.netSettleNote !==
      "For years before 2026 the advance-credit repayment isn't modeled, so no single settlement figure is shown."
    ) {
      fail(`(iii) net settle note should be the pre-2026 sentence, got ${JSON.stringify(excess.netSettleNote)}`);
    }
  });

  run("dec-tax-bill-known-zero-credit", (fail) => {
    // Build v54: the reconciliation distinguishes a
    // KNOWN-ZERO credit (nobody can be on the marketplace,
    // so the allowable credit is $0 by construction) from
    // a genuinely UNPRICED credit (a marketplace-eligible
    // household with no benchmark entered). creditAtHeadline
    // stays null in both; only the reconciliation differs.
    const medicare2026 = (): DecemberState => {
      const s = base();
      s.agePrimary = 70;
      s.ageSpouse = 68;
      s.onMedicarePrimary = true;
      s.onMedicareSpouse = true;
      s.ytdOtherOrdinary = 100000;
      s.acaBenchmarkAnnual = null;
      s.aptcTaken = 0;
      s.stateRatePct = 0;
      return s;
    };
    // (i) Both on Medicare, no benchmark, no APTC: the
    // credit is known-zero, so the settlement is the
    // total tax itself. Federal tax: $100,000 less
    // $47,500 of deductions ($32,200 standard + 2 × $1,650
    // age-65+ add-ons + 2 × $6,000 senior deduction) =
    // taxable $52,500 → $2,480 + 12% × $27,700 = $5,804.
    const knownZero = computeDecemberProjection(medicare2026()).cases[1]!;
    exact(fail, "(i) federal tax", knownZero.federalTaxAtHeadline, 5804);
    exact(fail, "(i) taxable income", knownZero.taxableIncomeAtHeadline, 52500);
    if (knownZero.creditAtHeadline !== null) {
      fail(`(i) credit at headline should stay null (unpriced display), got ${knownZero.creditAtHeadline}`);
    }
    exact(fail, "(i) credit still due", knownZero.creditStillDue, 0);
    exact(fail, "(i) excess repayment", knownZero.excessAptcRepayment, 0);
    exact(fail, "(i) net settle", knownZero.netSettleAtHeadline, 5804);
    if (knownZero.netSettleNote !== null) {
      fail(`(i) net settle note should be null, got ${JSON.stringify(knownZero.netSettleNote)}`);
    }
    // (ii) Same base with $2,000 of APTC taken: 2026 has
    // no repayment caps, so the whole advance is repaid
    // against the known-zero credit — net $5,804 + $2,000.
    const withAptcState = medicare2026();
    withAptcState.aptcTaken = 2000;
    const withAptc = computeDecemberProjection(withAptcState).cases[1]!;
    exact(fail, "(ii) credit still due", withAptc.creditStillDue, 0);
    exact(fail, "(ii) excess repayment", withAptc.excessAptcRepayment, 2000);
    exact(fail, "(ii) net settle", withAptc.netSettleAtHeadline, 7804);
    if (withAptc.netSettleNote !== null) {
      fail(`(ii) net settle note should be null, got ${JSON.stringify(withAptc.netSettleNote)}`);
    }
    // (iii) Spouse NOT on Medicare (marketplace-eligible)
    // with no benchmark entered: the credit is genuinely
    // unpriced — every reconciliation figure stays null
    // and the note is the unpriced-credit sentence. Income
    // is $50,000 here so MAGI sits UNDER the cliff (at
    // $100,000 the household would be over it and the
    // credit would be a priced $0 by law, not unpriced).
    const unpricedState = medicare2026();
    unpricedState.onMedicareSpouse = false;
    unpricedState.ytdOtherOrdinary = 50000;
    const unpriced = computeDecemberProjection(unpricedState).cases[1]!;
    if (unpriced.creditAtHeadline !== null) {
      fail(`(iii) credit at headline should be null, got ${unpriced.creditAtHeadline}`);
    }
    if (unpriced.creditStillDue !== null) {
      fail(`(iii) credit still due should be null, got ${unpriced.creditStillDue}`);
    }
    if (unpriced.excessAptcRepayment !== null) {
      fail(`(iii) excess repayment should be null, got ${unpriced.excessAptcRepayment}`);
    }
    if (unpriced.netSettleAtHeadline !== null) {
      fail(`(iii) net settle should be null, got ${unpriced.netSettleAtHeadline}`);
    }
    if (
      unpriced.netSettleNote !==
      "No benchmark premium is entered, so the ACA credit can't be priced and no single settlement figure is shown."
    ) {
      fail(`(iii) net settle note should be the unpriced-credit sentence, got ${JSON.stringify(unpriced.netSettleNote)}`);
    }
    // (v) Pre-2026 known-zero: 2025, ages 69/67, both on
    // Medicare, no benchmark, no APTC. The known-zero
    // credit reconciles ($0 due, $0 repayment — APTC $0 is
    // at or below the $0 effective credit), so the net is
    // the total tax, $5,919 (engine-priced).
    const medicare2025State = medicare2026();
    medicare2025State.taxYear = 2025;
    medicare2025State.agePrimary = 69;
    medicare2025State.ageSpouse = 67;
    const knownZero2025 = computeDecemberProjection(medicare2025State).cases[1]!;
    exact(fail, "(v) total tax", knownZero2025.totalTaxAtHeadline, 5919);
    exact(fail, "(v) credit still due", knownZero2025.creditStillDue, 0);
    exact(fail, "(v) excess repayment", knownZero2025.excessAptcRepayment, 0);
    exact(fail, "(v) net settle", knownZero2025.netSettleAtHeadline, 5919);
    if (knownZero2025.netSettleNote !== null) {
      fail(`(v) net settle note should be null, got ${JSON.stringify(knownZero2025.netSettleNote)}`);
    }
  });

  /* ---- Build v103 fixtures: education credits (round-14 F3) ----
     The settlement's acceptance examples, re-derived in the
     settled audit from the law row (taxLaw.ts: aotc 100% of
     the first $2,000 + 25% of the next $2,000 per eligible
     student, refundable 40%; llc 20% of up to $10,000 per
     return; MFJ phase-out $160,000–$180,000). The household
     shape for (a)–(c): 2026 MFJ, ages 60/58, both on
     Medicare (no ACA cliff, so the headline draw is null
     and every case prices at a $0 draw — solver-independent,
     hence exact), $60,000 of ordinary income, no state tax.
     Tax before credits: taxable income $60,000 − $32,200
     standard deduction = $27,800 → 10% × $24,800 + 12% ×
     $3,000 = $2,840.00. */
  const eduBase = (): DecemberState => ({
    ...defaultDecemberState(2026),
    agePrimary: 60,
    ageSpouse: 58,
    onMedicarePrimary: true,
    onMedicareSpouse: true,
    ytdOtherOrdinary: 60000,
  });

  run("dec-education-aotc-acceptance", (fail) => {
    // (a) AOTC on $4,000 of qualified expenses for one
    // eligible student: 100% × $2,000 + 25% × $2,000 =
    // $2,500.00; refundable 40% = $1,000.00; nonrefundable
    // applied min($1,500, $2,840) = $1,500.00 → federal tax
    // $1,340.00. The settlement credits the refundable
    // portion beside the ACA credit (here a known $0), so
    // it lands at $1,340 − $1,000 = $340.00 — exactly
    // $2,500.00 better than the no-student settlement.
    const s = eduBase();
    s.educationStudents = [{ expenses: 4000, aotcEligible: true }];
    const pg = pricePlaygroundYear(decemberCaseInputs(s, "likely", 0));
    exact(fail, "engine AOTC", pg.educationAotc, 2500);
    exact(fail, "engine LLC", pg.educationLlc, 0);
    if (pg.educationChoice !== "aotc") {
      fail(`engine choice should be aotc, got ${pg.educationChoice}`);
    }
    exact(fail, "engine nonrefundable applied", pg.educationNonrefundable, 1500);
    exact(fail, "engine refundable", pg.educationRefundable, 1000);
    exact(fail, "engine federal tax", pg.federalTax, 1340);
    // The refundable portion is never netted into the tax:
    // totalTax is the floored federal tax itself.
    exact(fail, "engine total tax excludes the refundable part", pg.totalTax, 1340);
    const r = computeDecemberProjection(s);
    const likely = r.cases[1]!;
    exact(fail, "federal tax at headline", likely.federalTaxAtHeadline, 1340);
    exact(fail, "AOTC at headline", likely.educationAotcAtHeadline, 2500);
    exact(fail, "nonrefundable at headline", likely.educationNonrefundableAtHeadline, 1500);
    exact(fail, "refundable at headline", likely.educationRefundableAtHeadline, 1000);
    if (!likely.hasEducationExpenses) fail("entered expenses should mark hasEducationExpenses");
    if (likely.excludesEducationCredits) fail("entered expenses should clear the qualification");
    exact(fail, "net settle at headline", likely.netSettleAtHeadline, 340);
    const noStudent = computeDecemberProjection(eduBase()).cases[1]!;
    exact(fail, "no-student net settle", noStudent.netSettleAtHeadline, 2840);
    exact(
      fail,
      "settlement improvement from the credit",
      r2((noStudent.netSettleAtHeadline ?? 0) - (likely.netSettleAtHeadline ?? 0)),
      2500,
    );
    if (r.warnings.some((w) => w.includes("excludes education credits"))) {
      fail("a priced-credit year should carry no excludes-credits warning");
    }
    // The entered students ride the saved blob intact.
    const back = parseDecemberState(serializeDecemberState(s, 2), 2026);
    if (
      back.educationStudents == null ||
      back.educationStudents.length !== 1 ||
      back.educationStudents[0]!.expenses !== 4000 ||
      back.educationStudents[0]!.aotcEligible !== true
    ) {
      fail("the entered students should round-trip through the saved blob");
    }
  });

  run("dec-education-llc-variant", (fail) => {
    // (b) The LLC variant: one student NOT marked
    // AOTC-eligible with $10,000 of eligible expenses →
    // 20% × $10,000 = $2,000.00 nonrefundable → federal
    // tax $2,840 − $2,000 = $840.00, no refundable part,
    // so the settlement is the tax itself.
    const s = eduBase();
    s.educationStudents = [{ expenses: 10000, aotcEligible: false }];
    const pg = pricePlaygroundYear(decemberCaseInputs(s, "likely", 0));
    exact(fail, "engine LLC", pg.educationLlc, 2000);
    exact(fail, "engine AOTC", pg.educationAotc, 0);
    if (pg.educationChoice !== "llc") {
      fail(`engine choice should be llc, got ${pg.educationChoice}`);
    }
    exact(fail, "engine nonrefundable applied", pg.educationNonrefundable, 2000);
    exact(fail, "engine refundable", pg.educationRefundable, 0);
    exact(fail, "engine federal tax", pg.federalTax, 840);
    const likely = computeDecemberProjection(s).cases[1]!;
    exact(fail, "federal tax at headline", likely.federalTaxAtHeadline, 840);
    exact(fail, "LLC at headline", likely.educationLlcAtHeadline, 2000);
    exact(fail, "refundable at headline", likely.educationRefundableAtHeadline, 0);
    exact(fail, "net settle at headline", likely.netSettleAtHeadline, 840);
    if (likely.excludesEducationCredits) fail("entered expenses should clear the qualification");
  });

  run("dec-education-none-entered-qualification", (fail) => {
    // (c) No students entered: the settlement is
    // BIT-IDENTICAL to the pre-v103 figures for this
    // household (federal tax $2,840.00, settlement
    // $2,840.00 — the figures the AOTC fixture above
    // differences against) AND every case carries the
    // excludes-education-credits qualification, with the
    // projection warning naming it.
    const r = computeDecemberProjection(eduBase());
    const likely = r.cases[1]!;
    exact(fail, "federal tax unchanged", likely.federalTaxAtHeadline, 2840);
    exact(fail, "total tax unchanged", likely.totalTaxAtHeadline, 2840);
    exact(fail, "net settle unchanged", likely.netSettleAtHeadline, 2840);
    exact(fail, "AOTC $0", likely.educationAotcAtHeadline, 0);
    exact(fail, "refundable $0", likely.educationRefundableAtHeadline, 0);
    for (const c of r.cases) {
      if (c.hasEducationExpenses) fail(`${c.kind}: no expenses should be marked entered`);
      if (!c.excludesEducationCredits) {
        fail(`${c.kind}: the settlement should carry the excludes-education-credits qualification`);
      }
    }
    if (!r.warnings.some((w) => w.includes("excludes education credits"))) {
      fail("the projection should warn that the settlement excludes education credits");
    }
    // An entered-but-empty list prices identically and
    // still carries the qualification (no expenses are
    // entered either way).
    const empty = eduBase();
    empty.educationStudents = [];
    const emptyLikely = computeDecemberProjection(empty).cases[1]!;
    exact(fail, "empty list federal tax", emptyLikely.federalTaxAtHeadline, 2840);
    exact(fail, "empty list net settle", emptyLikely.netSettleAtHeadline, 2840);
    if (!emptyLikely.excludesEducationCredits) {
      fail("an empty list should still carry the qualification");
    }
    // Back-compat: a blob written before the field existed
    // parses it as no input yet (null) and prices $0 of
    // credits; the default state is likewise null.
    const legacy = parseDecemberState(JSON.stringify({ taxYear: 2026 }), 2026);
    if (legacy.educationStudents !== null) {
      fail("a legacy blob should parse educationStudents as null (no input yet)");
    }
    if (defaultDecemberState(2026).educationStudents !== null) {
      fail("the default state should start with no education input");
    }
    if (!decemberState.safeParse(eduBase()).success) {
      fail("the writer schema should accept a state with no education input (null)");
    }
    const withStudents = eduBase();
    withStudents.educationStudents = [{ expenses: 4000, aotcEligible: true }];
    if (!decemberState.safeParse(withStudents).success) {
      fail("the writer schema should accept entered students");
    }
  });

  run("dec-education-phaseout-shared", (fail) => {
    // (d) Phase-out: the same household at $170,000 of
    // ordinary income — AGI inside the MFJ §25A(d) range
    // ($160,000–$180,000), halfway through it, so half the
    // credit phases out. Tax before credits: taxable
    // $170,000 − $32,200 = $137,800 → $2,480 + $9,120 +
    // 22% × $37,000 = $19,740.00. The $4,000-expense AOTC
    // prices $2,500 × ½ = $1,250.00 through the shared
    // step: refundable $500.00, nonrefundable $750.00 →
    // federal tax $18,990.00, settlement $18,490.00 — the
    // settlement improvement over the no-student case is
    // exactly the phased $1,250.00, proving December
    // prices the shared phase-out, not a full credit.
    const s = eduBase();
    s.ytdOtherOrdinary = 170000;
    s.educationStudents = [{ expenses: 4000, aotcEligible: true }];
    const pg = pricePlaygroundYear(decemberCaseInputs(s, "likely", 0));
    exact(fail, "phased AOTC", pg.educationAotc, 1250);
    exact(fail, "phased refundable", pg.educationRefundable, 500);
    exact(fail, "phased nonrefundable", pg.educationNonrefundable, 750);
    exact(fail, "federal tax after the phased credit", pg.federalTax, 18990);
    const likely = computeDecemberProjection(s).cases[1]!;
    exact(fail, "federal tax at headline", likely.federalTaxAtHeadline, 18990);
    exact(fail, "refundable at headline", likely.educationRefundableAtHeadline, 500);
    exact(fail, "net settle at headline", likely.netSettleAtHeadline, 18490);
    const noStudent = eduBase();
    noStudent.ytdOtherOrdinary = 170000;
    const noStudentLikely = computeDecemberProjection(noStudent).cases[1]!;
    exact(fail, "no-student federal tax", noStudentLikely.federalTaxAtHeadline, 19740);
    exact(fail, "no-student net settle", noStudentLikely.netSettleAtHeadline, 19740);
    exact(
      fail,
      "settlement improvement is the phased credit",
      r2((noStudentLikely.netSettleAtHeadline ?? 0) - (likely.netSettleAtHeadline ?? 0)),
      1250,
    );
    // At the top of the range the credit is gone entirely:
    // $180,000 of AGI phases it out in full.
    const top = eduBase();
    top.ytdOtherOrdinary = 180000;
    top.educationStudents = [{ expenses: 4000, aotcEligible: true }];
    const topPg = pricePlaygroundYear(decemberCaseInputs(top, "likely", 0));
    exact(fail, "fully phased AOTC", topPg.educationAotc, 0);
    exact(fail, "fully phased refundable", topPg.educationRefundable, 0);
  });

  run("dec-education-preseed-resolution", (fail) => {
    // (e) Preseed / provenance (v103): the load path the
    // view's hydration runs. A console with no education
    // input yet resolves the Tax Plan record's entered
    // students for the December year (supplied here as
    // record facts in December units — the exact shape
    // resolveDecemberStateAtLoad consumes); an entered
    // console list is never overwritten; and the
    // resolution is an overlay — an unrelated save
    // derivation keeps the STORED null, while an education
    // edit makes the console's own list govern.
    const stored = parseDecemberState(
      JSON.stringify({ taxYear: 2026, agePrimary: 60 }),
      2026,
    );
    if (stored.educationStudents !== null) {
      fail("the stored blob should start with no education input");
    }
    const recordStudents = [{ expenses: 4000, aotcEligible: true }];
    const resolved = resolveDecemberStateAtLoad(stored, {
      educationStudents: recordStudents,
    });
    if (
      resolved.educationStudents == null ||
      resolved.educationStudents.length !== 1 ||
      resolved.educationStudents[0]!.expenses !== 4000
    ) {
      fail("the record's students should resolve into a console with no input yet");
    }
    // The resolved overlay prices the credit.
    const pricedResolved: DecemberState = {
      ...resolved,
      ageSpouse: 58,
      onMedicarePrimary: true,
      onMedicareSpouse: true,
      ytdOtherOrdinary: 60000,
    };
    exact(
      fail,
      "resolved students price the AOTC settlement",
      computeDecemberProjection(pricedResolved).cases[1]!.netSettleAtHeadline,
      340,
    );
    // An entered console list governs over the record.
    const entered = parseDecemberState(
      JSON.stringify({
        taxYear: 2026,
        educationStudents: [{ expenses: 10000, aotcEligible: false }],
      }),
      2026,
    );
    const enteredResolved = resolveDecemberStateAtLoad(entered, {
      educationStudents: recordStudents,
    });
    if (
      enteredResolved.educationStudents == null ||
      enteredResolved.educationStudents.length !== 1 ||
      enteredResolved.educationStudents[0]!.expenses !== 10000 ||
      enteredResolved.educationStudents[0]!.aotcEligible !== false
    ) {
      fail("an entered console list must never be overwritten by the record");
    }
    // Overlay discipline on save: unrelated edit → the
    // stored null is what saves; education edit → the
    // display list saves.
    const prov = decemberStoredProvenanceOf(stored);
    const unrelatedSave = decemberStateForSave(resolved, prov, {
      beneficiary: false,
      balances: false,
    });
    if (unrelatedSave.educationStudents !== null) {
      fail("an unrelated save must keep the stored no-input value, not the resolved overlay");
    }
    const educationSave = decemberStateForSave(resolved, prov, {
      beneficiary: false,
      balances: false,
      education: true,
    });
    if (
      educationSave.educationStudents == null ||
      educationSave.educationStudents.length !== 1
    ) {
      fail("an education edit should save the console's own list");
    }
  });

  /* ---- Build v104 fixtures: January-paid capital-gain
     distributions (round-14 F5) ----
     Legal premise: §852(b)(7) deems a distribution declared
     in October–December and paid in January received on
     December 31 of the declaration year (the year December
     already gets right), and §852(b)(3) treats a capital
     gain dividend so designated as a long-term capital
     gain (the character December got wrong before v104:
     the whole January-paid total rode ordinary dividends,
     so Washington — whose excise prices long-term gains
     and never dividends — never saw it at all). */

  run("dec-jan-paid-capgain-wa-acceptance", (fail) => {
    // (a) The settlement's acceptance example, through the
    // December path: 2026 WA, $1,278,000 of already-
    // recognized long-term gains plus a $100,000 capital-
    // gain distribution declared Dec 2026 and paid Jan
    // 2027. After the fix the WA gain base is $1,378,000:
    // $1,378,000 − $278,000 standard deduction = $1,100,000
    // of taxable Washington gains → 7% × $1,000,000 + 9.9%
    // × $100,000 = $79,900.00. The before-fix figure named
    // here as the corrected error is $70,000.00 (base
    // $1,278,000 − $278,000 = $1,000,000 → 7% flat): the
    // $0-portion leg below prices exactly that, so the
    // understatement corrected is $9,900.00.
    const waBase = (): DecemberState => ({
      ...defaultDecemberState(2026),
      agePrimary: 60,
      ageSpouse: 58,
      onMedicarePrimary: true,
      onMedicareSpouse: true,
      residenceState: "WA",
      ytdCapitalGain: 1278000,
      strayJanPaid: { status: "amount", amount: 100000 },
    });
    const fixed = waBase();
    fixed.strayJanPaidCapGainAmount = 100000;
    const fixedInputs = decemberCaseInputs(fixed, "likely", 0);
    exact(fail, "capital-gain portion rides stock sold", fixedInputs.stockSold, 1378000);
    exact(fail, "capital-gain portion leaves ordinary dividends", fixedInputs.ordinaryDividends, 0);
    const fixedPg = pricePlaygroundYear(fixedInputs);
    exact(fail, "WA gains after fix", fixedPg.waGains, 1378000);
    exact(fail, "WA taxable gains after fix", fixedPg.waTaxableGains, 1100000);
    exact(fail, "WA excise after fix", fixedPg.stateTax, 79900);
    const before = waBase();
    const beforePg = pricePlaygroundYear(decemberCaseInputs(before, "likely", 0));
    exact(fail, "WA gains before fix ($0 portion)", beforePg.waGains, 1278000);
    exact(fail, "WA taxable gains before fix ($0 portion)", beforePg.waTaxableGains, 1000000);
    exact(fail, "WA excise before fix (the corrected error)", beforePg.stateTax, 70000);
    exact(
      fail,
      "understatement corrected",
      r2(fixedPg.stateTax - beforePg.stateTax),
      9900,
    );
  });

  run("dec-jan-paid-capgain-federal-character", (fail) => {
    // (b) The federal character difference, quantified
    // from the shared pricer on the ROC fixture's clean
    // shape: $120,000 of wages (MFJ, standard deduction
    // $32,200 → ordinary taxable income $87,800, federal
    // tax $2,480 + 12% × $63,000 = $10,040.00) plus a
    // $30,000 January-paid distribution.
    // · Priced as an ordinary dividend (the pre-fix
    //   treatment, $0 capital-gain portion): taxable income
    //   rises to $117,800 — an increment of $13,000 × 12% +
    //   $17,000 × 22% = $5,300.00 → federal tax $15,340.00.
    // · Priced as a capital-gain distribution (the whole
    //   $30,000 on the gains staircase): $11,100 of it fits
    //   the 0% space up to the $98,900 top and $18,900 is
    //   taxed at 15% — an increment of $2,835.00 → federal
    //   tax $12,875.00.
    // The federal character difference on this shape is
    // therefore $5,300.00 − $2,835.00 = $2,465.00.
    const wages = base();
    wages.ytdOtherOrdinary = 120000;
    const t0 = pricePlaygroundYear(decemberCaseInputs(wages, "likely", 0)).federalTax;
    exact(fail, "wages-only federal tax", t0, 10040);
    const ordinary = base();
    ordinary.ytdOtherOrdinary = 120000;
    ordinary.strayJanPaid = { status: "amount", amount: 30000 };
    const tOrd = pricePlaygroundYear(decemberCaseInputs(ordinary, "likely", 0)).federalTax;
    exact(fail, "ordinary-treatment federal tax", tOrd, 15340);
    exact(fail, "ordinary-treatment increment", r2(tOrd - t0), 5300);
    const capGain = base();
    capGain.ytdOtherOrdinary = 120000;
    capGain.strayJanPaid = { status: "amount", amount: 30000 };
    capGain.strayJanPaidCapGainAmount = 30000;
    const tCap = pricePlaygroundYear(decemberCaseInputs(capGain, "likely", 0)).federalTax;
    exact(fail, "capital-gain-treatment federal tax", tCap, 12875);
    exact(fail, "capital-gain-treatment increment", r2(tCap - t0), 2835);
    exact(fail, "federal character difference", r2(tOrd - tCap), 2465);
  });

  run("dec-jan-paid-capgain-zero-identity", (fail) => {
    // (c) The $0-portion identity case: a January-paid
    // amount with a $0 (or absent) capital-gain portion
    // prices BIT-IDENTICALLY to before v104 — the figures
    // pinned here are the pre-fix figures from the standing
    // qualified-portion fixture's shape ($100,000 of wages
    // MFJ plus a $20,000 January-paid total: $2,400.00 of
    // added federal tax when none of it is qualified, $0
    // when all of the ordinary remainder is qualified).
    const wages = base();
    wages.ytdOtherOrdinary = 100000;
    const t0 = pricePlaygroundYear(decemberCaseInputs(wages, "likely", 0)).federalTax;
    const zero = base();
    zero.ytdOtherOrdinary = 100000;
    zero.strayJanPaid = { status: "amount", amount: 20000 };
    zero.strayJanPaidCapGainAmount = 0;
    const zeroInputs = decemberCaseInputs(zero, "likely", 0);
    exact(fail, "$0 portion: whole total in ordinary dividends", zeroInputs.ordinaryDividends, 20000);
    exact(fail, "$0 portion: no gain on the stock dials", zeroInputs.stockSold, 0);
    const tZero = pricePlaygroundYear(zeroInputs).federalTax;
    exact(fail, "$0 portion tax increment (pre-fix figure)", r2(tZero - t0), 2400);
    // Back-compat: a blob written before the field existed
    // parses the portion as $0, the default state carries
    // $0, the writer schema accepts the state, and an
    // entered portion round-trips through the saved blob.
    const legacy = parseDecemberState(
      JSON.stringify({
        taxYear: 2026,
        strayJanPaid: { status: "amount", amount: 20000 },
      }),
      2026,
    );
    if (legacy.strayJanPaidCapGainAmount !== 0) {
      fail("a legacy blob should parse the capital-gain portion as $0");
    }
    const withWages: DecemberState = { ...legacy, ytdOtherOrdinary: 100000 };
    exact(
      fail,
      "legacy blob tax increment (pre-fix figure)",
      r2(pricePlaygroundYear(decemberCaseInputs(withWages, "likely", 0)).federalTax - t0),
      2400,
    );
    if (defaultDecemberState(2026).strayJanPaidCapGainAmount !== 0) {
      fail("the default state should carry a $0 capital-gain portion");
    }
    if (!decemberState.safeParse(zero).success) {
      fail("the writer schema should accept a $0 capital-gain portion");
    }
    const entered = base();
    entered.strayJanPaid = { status: "amount", amount: 20000 };
    entered.strayJanPaidCapGainAmount = 7500;
    const back = parseDecemberState(serializeDecemberState(entered, 2), 2026);
    if (back.strayJanPaidCapGainAmount !== 7500) {
      fail("an entered capital-gain portion should round-trip through the saved blob");
    }
  });

  run("dec-jan-paid-capgain-combined-no-double-count", (fail) => {
    // (d) Combined splits on ONE January-paid amount: a
    // $60,000 total with a $20,000 capital-gain portion and
    // $15,000 of qualified dividends inside the remaining
    // $40,000 of ordinary dividends. No double-count: the
    // dials decompose the total exactly — the non-qualified
    // ordinary part ($40,000 − $15,000 = $25,000) + the
    // qualified part ($15,000) + the capital-gain part
    // ($20,000) = the $60,000 entered, and the income the
    // pricer counts is the ordinary total ($40,000, which
    // already includes its qualified subset) + the gain
    // ($20,000) = $60,000, counted once.
    const s = base();
    s.ytdOtherOrdinary = 100000;
    s.strayJanPaid = { status: "amount", amount: 60000 };
    s.strayJanPaidCapGainAmount = 20000;
    s.strayJanPaidQualifiedAmount = 15000;
    const inputs = decemberCaseInputs(s, "likely", 0);
    exact(fail, "ordinary dial is the remainder only", inputs.ordinaryDividends, 40000);
    exact(fail, "qualified dial is its portion of the remainder", inputs.qualifiedDividends, 15000);
    exact(fail, "gain dial carries the capital-gain portion", inputs.stockSold - inputs.stockBasis, 20000);
    exact(
      fail,
      "portions decompose the entered total",
      r2(inputs.ordinaryDividends - inputs.qualifiedDividends) +
        inputs.qualifiedDividends +
        (inputs.stockSold - inputs.stockBasis),
      60000,
    );
    exact(
      fail,
      "counted income is the entered total, once",
      r2(inputs.ordinaryDividends + (inputs.stockSold - inputs.stockBasis)),
      60000,
    );
    // Priced end to end (hand-derived): AGI $100,000 +
    // $60,000 = $160,000; taxable $127,800; ordinary
    // taxable $127,800 − ($20,000 gain + $15,000 qualified)
    // = $92,800 → ordinary tax $2,480 + 12% × $68,000 =
    // $10,640.00; the $35,000 preferential stack sits on
    // $92,800 — $6,100 fits the 0% space to the $98,900
    // top, $28,900 at 15% = $4,335.00 → federal tax
    // $14,975.00.
    const pg = pricePlaygroundYear(inputs);
    exact(fail, "combined federal tax", pg.federalTax, 14975);
    exact(fail, "combined AGI counts the total once", pg.agi, 160000);
    // Clamps: a capital-gain portion entered above the
    // total clamps to the total (ordinary remainder $0),
    // and a qualified portion entered above the ordinary
    // remainder clamps to that remainder, never to the
    // whole total.
    const overCap = base();
    overCap.strayJanPaid = { status: "amount", amount: 20000 };
    overCap.strayJanPaidCapGainAmount = 25000;
    overCap.strayJanPaidQualifiedAmount = 20000;
    const overCapInputs = decemberCaseInputs(overCap, "likely", 0);
    exact(fail, "over-entered capital-gain portion clamps to the total", overCapInputs.stockSold, 20000);
    exact(fail, "fully-capital total leaves no ordinary dividends", overCapInputs.ordinaryDividends, 0);
    exact(fail, "qualified clamps to the $0 ordinary remainder", overCapInputs.qualifiedDividends, 0);
    const overQual = base();
    overQual.strayJanPaid = { status: "amount", amount: 20000 };
    overQual.strayJanPaidCapGainAmount = 15000;
    overQual.strayJanPaidQualifiedAmount = 20000;
    const overQualInputs = decemberCaseInputs(overQual, "likely", 0);
    exact(fail, "partial-capital ordinary remainder", overQualInputs.ordinaryDividends, 5000);
    exact(fail, "qualified clamps to the ordinary remainder", overQualInputs.qualifiedDividends, 5000);
    exact(fail, "partial-capital gain dial", overQualInputs.stockSold, 15000);
  });

  run("dec-dividend-pair-clamp-s8", (fail) => {
    // Audit S-8 worked examples, after the clamp (contract
    // v137; hand-derived): qualified dividends are a subset
    // of their ordinary total, so each December pair clamps
    // its qualified part to its own total.
    // Example 1a's pair: year-to-date qualified $20,000
    // entered against a $16,000 ordinary total. Before the
    // clamp the engine priced $20,000 qualified + $0
    // non-qualified — the $4,000 excess counted as qualified
    // income, understating the headline draw by $4,000.
    // Now the pair prices at most the total: qualified
    // $16,000, non-qualified $0, AGI $16,000 (dividends are
    // the only income in this state).
    const s = base();
    s.ytdOrdinaryDividends = 16000;
    s.ytdQualifiedDividends = 20000;
    const inputs = decemberCaseInputs(s, "likely", 0);
    exact(fail, "1a: ordinary total stands", inputs.ordinaryDividends, 16000);
    exact(fail, "1a: qualified clamps to the total", inputs.qualifiedDividends, 16000);
    const pg = pricePlaygroundYear(inputs);
    exact(fail, "1a: priced qualified", pg.qualifiedDividends, 16000);
    exact(fail, "1a: priced non-qualified", pg.nonQualifiedDividends, 0);
    exact(fail, "1a: AGI is the total counted once", pg.agi, 16000);
    // The projection names the impossible pair instead of
    // pricing it silently.
    const r = computeDecemberProjection(s);
    if (!r.priced) return fail("1a: not priced");
    if (!r.warnings.some((w) => w.includes("Qualified dividends already in"))) {
      fail("1a: projection should warn on the year-to-date pair");
    }
    // Example 1c's still-to-come pair: remaining ordinary
    // $0 with remaining qualified $30,000 (year-to-date
    // $40,000 / $5,000 is a possible pair and stands). The
    // remaining qualified clamps to its own pair's total —
    // $0 — so the year's qualified is the year-to-date
    // $5,000 and the year's dividends price at their
    // $40,000 total, counted once, instead of the excess
    // riding the gains stack.
    const s2 = base();
    s2.ytdOrdinaryDividends = 40000;
    s2.ytdQualifiedDividends = 5000;
    s2.remQualifiedDividends = { low: 30000, likely: 30000, high: 30000 };
    const inputs2 = decemberCaseInputs(s2, "likely", 0);
    exact(fail, "1c: ordinary total stands", inputs2.ordinaryDividends, 40000);
    exact(fail, "1c: qualified is the YTD part only", inputs2.qualifiedDividends, 5000);
    const pg2 = pricePlaygroundYear(inputs2);
    exact(fail, "1c: priced non-qualified", pg2.nonQualifiedDividends, 35000);
    exact(fail, "1c: AGI is the total counted once", pg2.agi, 40000);
    const r2p = computeDecemberProjection(s2);
    if (!r2p.warnings.some((w) => w.includes("Qualified dividends still to come"))) {
      fail("1c: projection should warn on the still-to-come pair");
    }
    // Audit N-5: each still-to-come warning names WHICH
    // case is impossible, with that case's two figures —
    // in s2 all three cases carry the impossible pair
    // (qualified $30,000 against a $0 total), so all three
    // cases are named, one warning each.
    for (const k of DECEMBER_CASE_KINDS) {
      if (
        !r2p.warnings.some(
          (w) =>
            w.includes(`Qualified dividends still to come in the ${k} case ($30,000)`) &&
            w.includes(`total ordinary dividends still to come in the ${k} case ($0)`),
        )
      ) {
        fail(`1c: projection should name the ${k} case's impossible still-to-come pair`);
      }
    }
    // A pair impossible in only ONE case names only that
    // case: here the likely case alone (qualified $8,000
    // against its $5,000 total); the low ($4,000 / $5,000)
    // and high ($15,000 / $20,000) pairs are possible.
    const s4 = base();
    s4.ytdOrdinaryDividends = 40000;
    s4.ytdQualifiedDividends = 5000;
    s4.remOrdinaryDividends = { low: 5000, likely: 5000, high: 20000 };
    s4.remQualifiedDividends = { low: 4000, likely: 8000, high: 15000 };
    const r4 = computeDecemberProjection(s4);
    const stillWarnings = r4.warnings.filter((w) =>
      w.includes("Qualified dividends still to come in the"),
    );
    if (stillWarnings.length !== 1) {
      fail(`1c: exactly one still-to-come case should be named, got ${stillWarnings.length}`);
    }
    if (
      !stillWarnings.some(
        (w) =>
          w.includes("in the likely case ($8,000)") &&
          w.includes("in the likely case ($5,000)"),
      )
    ) {
      fail("1c: the named case should be the likely case with its two figures");
    }
    // A possible pair is untouched by the clamp: qualified
    // below the total prices exactly as entered.
    const s3 = base();
    s3.ytdOrdinaryDividends = 16000;
    s3.ytdQualifiedDividends = 12000;
    const inputs3 = decemberCaseInputs(s3, "likely", 0);
    exact(fail, "possible pair: qualified stands", inputs3.qualifiedDividends, 12000);
    const pg3 = pricePlaygroundYear(inputs3);
    exact(fail, "possible pair: non-qualified remainder", pg3.nonQualifiedDividends, 4000);
    exact(fail, "possible pair: AGI counted once", pg3.agi, 16000);
  });

  run("dec-carryforward-f1-acceptance", (fail) => {
    // Round-17 F1 acceptance (settled, figures re-derived
    // there): 2026 MFJ, ages 60/58, $60,000 of ordinary
    // income, a $10,000 entering LONG-TERM carryforward, no
    // new gains, $20,000 benchmark, $12,000 APTC, $5,000
    // buffer. The ledger claims the $3,000 allowance, so
    // the safe draw rises by exactly $3,000 and $7,000
    // carries out.
    const s = base();
    s.ytdOtherOrdinary = 60000;
    s.carryInCapitalLossLt = 10000;
    const r = computeDecemberProjection(s);
    if (!r.priced) return fail("not priced");
    near(fail, "ledger-aware headline draw", r.headlineDraw, 22600);
    const likely = r.cases[1]!;
    near(fail, "likely magi at headline", likely.magiAtHeadline, 79600);
    exact(fail, "carry-out long-term at headline", likely.lossCarryOutLtAtHeadline, 7000);
    exact(fail, "carry-out short-term at headline", likely.lossCarryOutStAtHeadline, 0);
    exact(fail, "carry-out WA at headline", r2(likely.lossCarryOutStWaAtHeadline + likely.lossCarryOutLtWaAtHeadline), 0);
    // At the COMMON $19,600 draw (the pre-fix headline):
    // federal tax $4,832.00 (was $5,192.00) and settlement
    // $4,461.36 (was $5,120.16) — the settlement derived
    // from the priced credit exactly as the case assembly
    // reconciles it (total tax − credit still due).
    const atCommon = pricePlaygroundYear(decemberCaseInputs(s, "likely", 19600));
    exact(fail, "federal tax at the common draw", atCommon.federalTax, 4832);
    exact(fail, "credit at the common draw", atCommon.aca.credit, 12370.64);
    exact(
      fail,
      "settlement at the common draw",
      r2(atCommon.totalTax - Math.max(0, (atCommon.aca.credit ?? 0) - s.aptcTaken)),
      4461.36,
    );
    exact(fail, "carry-out preserved at the common draw", atCommon.lossCarryOutLt, 7000);
    exact(fail, "allowance priced at the common draw", atCommon.capitalLossAllowance, 3000);
    // The pre-fix control: the same year with NO carry-in
    // entered prices the old figures — headline $19,600,
    // federal tax $5,192.00 at that draw, settlement
    // $5,120.16.
    const control = base();
    control.ytdOtherOrdinary = 60000;
    const rc = computeDecemberProjection(control);
    near(fail, "control headline draw (pre-fix)", rc.headlineDraw, 19600);
    const controlAt = pricePlaygroundYear(decemberCaseInputs(control, "likely", 19600));
    exact(fail, "control federal tax (pre-fix)", controlAt.federalTax, 5192);
    exact(
      fail,
      "control settlement (pre-fix)",
      r2(controlAt.totalTax - Math.max(0, (controlAt.aca.credit ?? 0) - control.aptcTaken)),
      5120.16,
    );
    exact(fail, "control carry-out", controlAt.lossCarryOutLt, 0);
  });

  run("dec-carryforward-zero-identity", (fail) => {
    // Back-compat: a December state with NO carry-in
    // (nulls) and one with an explicit $0 carry-in price
    // BIT-IDENTICALLY — same dials out of the assembly,
    // same priced figures, $0 carry-outs — and a blob
    // written before the fields existed parses them null.
    const sNull = base();
    sNull.ytdOtherOrdinary = 50000;
    const sZero = base();
    sZero.ytdOtherOrdinary = 50000;
    sZero.carryInCapitalLossSt = 0;
    sZero.carryInCapitalLossLt = 0;
    sZero.carryInCapitalLossStWa = 0;
    sZero.carryInCapitalLossLtWa = 0;
    const pNull = pricePlaygroundYear(decemberCaseInputs(sNull, "likely", 5000));
    const pZero = pricePlaygroundYear(decemberCaseInputs(sZero, "likely", 5000));
    exact(fail, "federal tax identical", pZero.federalTax, pNull.federalTax);
    exact(fail, "total tax identical", pZero.totalTax, pNull.totalTax);
    exact(fail, "AGI identical", pZero.agi, pNull.agi);
    exact(fail, "state tax identical", pZero.stateTax, pNull.stateTax);
    exact(fail, "allowance identical", pZero.capitalLossAllowance, pNull.capitalLossAllowance);
    for (const [label, v] of [
      ["null-state carry-out ST", pNull.lossCarryOutSt],
      ["null-state carry-out LT", pNull.lossCarryOutLt],
      ["zero-state carry-out ST", pZero.lossCarryOutSt],
      ["zero-state carry-out LT", pZero.lossCarryOutLt],
      ["zero-state carry-out ST WA", pZero.lossCarryOutStWa],
      ["zero-state carry-out LT WA", pZero.lossCarryOutLtWa],
    ] as [string, number][]) {
      exact(fail, label, v, 0);
    }
    const rNull = computeDecemberProjection(sNull);
    const rZero = computeDecemberProjection(sZero);
    if (rZero.headlineDraw !== rNull.headlineDraw) {
      fail(`headline identical: got ${rZero.headlineDraw}, want ${rNull.headlineDraw}`);
    }
    if (
      rZero.cases[1]!.netSettleAtHeadline !==
      rNull.cases[1]!.netSettleAtHeadline
    ) {
      fail("settlement should be identical between null and $0 carry-in");
    }
    // Parse / defaults / round-trip.
    const legacy = parseDecemberState(
      JSON.stringify({ taxYear: 2026 }),
      2026,
    );
    if (
      legacy.carryInCapitalLossSt !== null ||
      legacy.carryInCapitalLossLt !== null ||
      legacy.carryInCapitalLossStWa !== null ||
      legacy.carryInCapitalLossLtWa !== null
    ) {
      fail("a legacy blob should parse every carry-in field as null");
    }
    const dflt = defaultDecemberState(2026);
    if (dflt.carryInCapitalLossLt !== null) {
      fail("the default state should carry a null carry-in");
    }
    if (!decemberState.safeParse(sZero).success) {
      fail("the writer schema should accept an explicit $0 carry-in");
    }
    const entered = base();
    entered.carryInCapitalLossSt = 100;
    entered.carryInCapitalLossLt = 200;
    entered.carryInCapitalLossStWa = 30;
    entered.carryInCapitalLossLtWa = 40;
    const back = parseDecemberState(serializeDecemberState(entered, 2), 2026);
    if (
      back.carryInCapitalLossSt !== 100 ||
      back.carryInCapitalLossLt !== 200 ||
      back.carryInCapitalLossStWa !== 30 ||
      back.carryInCapitalLossLtWa !== 40
    ) {
      fail("entered carry-in values should round-trip through the saved blob");
    }
  });

  run("dec-carryforward-f2-nonwa-acceptance", (fail) => {
    // Round-17 F2 acceptance (settled): 2026 MFJ, $110,000
    // ordinary income, a $500,000 realized long-term gain,
    // and a $100,000 entering long-term carryforward that
    // is NOT Washington-attributable. Federal nets to
    // $400,000 either way; Washington's base stays at the
    // gross $500,000 — excise $15,540.00, settlement
    // $91,095.00 (the console's old single-net-gain entry
    // priced the excise at $8,540.00, $7,000.00 low).
    const s = base();
    s.ytdOtherOrdinary = 110000;
    s.ytdCapitalGain = 500000;
    s.carryInCapitalLossLt = 100000;
    s.residenceState = "WA";
    s.aptcTaken = 0;
    const r = computeDecemberProjection(s);
    if (!r.priced) return fail("not priced");
    if (r.headlineDraw !== 0) fail(`headline should be 0 (over the cliff at $0), got ${r.headlineDraw}`);
    const likely = r.cases[1]!;
    exact(fail, "federal tax", likely.federalTaxAtHeadline, 75555);
    exact(fail, "Washington excise (gross base)", likely.stateTaxAtHeadline, 15540);
    exact(fail, "total tax", likely.totalTaxAtHeadline, 91095);
    exact(fail, "settlement", likely.netSettleAtHeadline, 91095);
    exact(fail, "carry-out (fully absorbed)", likely.lossCarryOutLtAtHeadline, 0);
    // The old entry the planned-sales hint instructed —
    // the gain entered NET ($400,000) with no carry-in —
    // prices the same federal tax but the understated
    // $8,540.00 excise: the corrected error, pinned.
    const oldWay = base();
    oldWay.ytdOtherOrdinary = 110000;
    oldWay.ytdCapitalGain = 400000;
    oldWay.residenceState = "WA";
    oldWay.aptcTaken = 0;
    const oldLikely = computeDecemberProjection(oldWay).cases[1]!;
    exact(fail, "old-entry federal tax (unchanged)", oldLikely.federalTaxAtHeadline, 75555);
    exact(fail, "old-entry Washington excise (the corrected error)", oldLikely.stateTaxAtHeadline, 8540);
  });

  run("dec-carryforward-wa-attributable-base-down", (fail) => {
    // The v101 plan behavior through the December path:
    // the SAME $100,000 entering carryforward, but stated
    // fully Washington-attributable — now the Washington
    // base prices DOWN to the federal net $400,000 and the
    // excise is $8,540.00, while the federal tax is
    // unchanged (attribution moves only the WA base).
    const s = base();
    s.ytdOtherOrdinary = 110000;
    s.ytdCapitalGain = 500000;
    s.carryInCapitalLossLt = 100000;
    s.carryInCapitalLossLtWa = 100000;
    s.residenceState = "WA";
    s.aptcTaken = 0;
    const pg = pricePlaygroundYear(decemberCaseInputs(s, "likely", 0));
    exact(fail, "Washington gains base priced down", pg.waGains, 400000);
    exact(fail, "federal tax unchanged by attribution", pg.federalTax, 75555);
    const likely = computeDecemberProjection(s).cases[1]!;
    exact(fail, "Washington excise (attributable base)", likely.stateTaxAtHeadline, 8540);
    exact(fail, "total tax", likely.totalTaxAtHeadline, 84095);
    exact(fail, "settlement", likely.netSettleAtHeadline, 84095);
  });

  run("dec-carryforward-zero-taxable-utilization", (fail) => {
    // Worksheet utilization: a year with NO taxable income
    // for the allowance to offset CLAIMS the $3,000
    // allowance (it prices in AGI) but USES none of it —
    // the whole $10,000 entering carryforward carries out.
    // Both spouses on Medicare, so there is no cliff and
    // the cases price at a $0 draw.
    const s = base();
    s.agePrimary = 67;
    s.ageSpouse = 66;
    s.onMedicarePrimary = true;
    s.onMedicareSpouse = true;
    s.carryInCapitalLossLt = 10000;
    const pg = pricePlaygroundYear(decemberCaseInputs(s, "likely", 0));
    exact(fail, "allowance claimed", pg.capitalLossAllowance, 3000);
    exact(fail, "full carry-out (allowance unused)", pg.lossCarryOutLt, 10000);
    exact(fail, "no short-term carry-out", pg.lossCarryOutSt, 0);
    const r = computeDecemberProjection(s);
    if (r.headlineDraw !== null) fail("no cliff should apply on Medicare");
    exact(
      fail,
      "case carry-out at headline",
      r.cases[1]!.lossCarryOutLtAtHeadline,
      10000,
    );
  });

  run("dec-carryforward-resolution-and-save-rules", (fail) => {
    // Load resolution (v111; gate restored to the plan's
    // first year only by the M-3 fix, engines review
    // round 2): the record's carry-in is the balance
    // entering the plan's FIRST year, so it resolves only
    // when the console's tax year IS that year. The plan
    // march consumes the balance year by year, so a later
    // year's entering balance is the march's remainder —
    // the record does not carry it, and the widened gate
    // (build v127, round-19 finding 3) that resolved the
    // full first-year balance into every later year
    // double-counted what the march had already spent.
    // It does NOT resolve for a year before the plan's
    // first year either. Per field, null resolves and any
    // entered value (including $0) wins. Save derivation:
    // an unedited carry-in saves its STORED value, never
    // the resolved overlay.
    const facts: DecemberRecordFacts = {
      planFirstYear: 2026,
      carryInCapitalLossSt: 1000,
      carryInCapitalLossLt: 10000,
      carryInCapitalLossStWa: 250,
      carryInCapitalLossLtWa: 2000,
    };
    const fresh = defaultDecemberState(2026);
    const resolved = resolveDecemberStateAtLoad(fresh, facts);
    exact(fail, "resolved ST", resolved.carryInCapitalLossSt, 1000);
    exact(fail, "resolved LT", resolved.carryInCapitalLossLt, 10000);
    exact(fail, "resolved ST WA", resolved.carryInCapitalLossStWa, 250);
    exact(fail, "resolved LT WA", resolved.carryInCapitalLossLtWa, 2000);
    // A later year does NOT resolve: the first-year
    // balance is not that year's entering loss (the march
    // has been consuming it in between), so the fields
    // stay unanswered for the console's own entry.
    const laterYear = resolveDecemberStateAtLoad(
      { ...defaultDecemberState(2026), taxYear: 2027 },
      facts,
    );
    if (
      laterYear.carryInCapitalLossSt !== null ||
      laterYear.carryInCapitalLossLt !== null ||
      laterYear.carryInCapitalLossStWa !== null ||
      laterYear.carryInCapitalLossLtWa !== null
    ) {
      fail("no resolution should apply after the plan's first year");
    }
    const earlierYear = resolveDecemberStateAtLoad(
      { ...defaultDecemberState(2026), taxYear: 2025 },
      facts,
    );
    if (
      earlierYear.carryInCapitalLossSt !== null ||
      earlierYear.carryInCapitalLossLt !== null ||
      earlierYear.carryInCapitalLossStWa !== null ||
      earlierYear.carryInCapitalLossLtWa !== null
    ) {
      fail("no resolution should apply before the plan's first year");
    }
    const entered = resolveDecemberStateAtLoad(
      {
        ...defaultDecemberState(2026),
        carryInCapitalLossSt: 500,
        carryInCapitalLossLt: 0,
      },
      facts,
    );
    exact(fail, "entered ST wins", entered.carryInCapitalLossSt, 500);
    exact(fail, "entered $0 LT wins", entered.carryInCapitalLossLt, 0);
    exact(fail, "unanswered ST WA still resolves", entered.carryInCapitalLossStWa, 250);
    const silent = resolveDecemberStateAtLoad(fresh, { planFirstYear: 2026 });
    if (silent.carryInCapitalLossLt !== null) {
      fail("a record that does not answer should leave the field null");
    }
    const stored = decemberStoredProvenanceOf(fresh);
    const savedOverlay = decemberStateForSave(resolved, stored, {
      beneficiary: false,
      balances: false,
    });
    if (savedOverlay.carryInCapitalLossLt !== null) {
      fail("an unedited save should persist the stored (null) carry-in, not the overlay");
    }
    const savedEdited = decemberStateForSave(resolved, stored, {
      beneficiary: false,
      balances: false,
      carryInLt: true,
    });
    exact(fail, "an edited save persists the console value", savedEdited.carryInCapitalLossLt, 10000);
    // Per-field saves (round-17 defect 3): editing one
    // carry-in field saves only that field — the untouched
    // siblings keep their stored values.
    const savedStOnly = decemberStateForSave(resolved, stored, {
      beneficiary: false,
      balances: false,
      carryInSt: true,
    });
    exact(fail, "editing ST saves the console ST", savedStOnly.carryInCapitalLossSt, 1000);
    if (
      savedStOnly.carryInCapitalLossLt !== null ||
      savedStOnly.carryInCapitalLossStWa !== null ||
      savedStOnly.carryInCapitalLossLtWa !== null
    ) {
      fail("editing ST alone must not save the untouched LT / WA siblings");
    }
    const savedWaOnly = decemberStateForSave(resolved, stored, {
      beneficiary: false,
      balances: false,
      carryInLtWa: true,
    });
    exact(fail, "editing LT WA saves the console LT WA", savedWaOnly.carryInCapitalLossLtWa, 2000);
    if (
      savedWaOnly.carryInCapitalLossSt !== null ||
      savedWaOnly.carryInCapitalLossLt !== null ||
      savedWaOnly.carryInCapitalLossStWa !== null
    ) {
      fail("editing LT WA alone must not save the untouched ST / LT / ST WA siblings");
    }
    if (!decemberState.safeParse(resolved).success) {
      fail("the writer schema should accept resolved carry-in values");
    }
  });

  run("dec-carry-in-later-year-march-remainder", (fail) => {
    // Engines review round 2, finding M-3 (MUST, settled
    // STAND) — the worked example, on the review's
    // synthetic figures. A Tax Plan record whose first
    // year is 2026 carries a $30,000 long-term loss in.
    // The plan march consumes it year by year: 2026
    // realizes $10,000 of long-term gains on ample
    // ordinary income (the gains absorb $10,000, the used
    // $3,000 allowance spends $3,000 more — carry-out
    // $17,000), and 2027 repeats it (carry-out $4,000).
    // The true balance entering December 2028 is
    // therefore $4,000. The widened gate (build v127)
    // resolved the full $30,000 into the 2028 console:
    // on December 2028's facts ($65,000 other ordinary,
    // $20,000 long-term gains, household 2, benchmark
    // $20,000, APTC taken $12,000) that understated MAGI
    // by exactly $19,000, overstated the headline safe
    // draw by the same $19,000 ($19,560 against the true
    // $560 — a breach-the-cliff-sized error in the
    // non-conservative direction), and reported a $7,000
    // carry-out into 2029 against a true $0.
    const facts: DecemberRecordFacts = {
      planFirstYear: 2026,
      carryInCapitalLossLt: 30000,
    };
    // The corrected gate: the record does not answer
    // 2028 at all — the fields stay unanswered.
    const resolved2028 = resolveDecemberStateAtLoad(
      { ...base(), taxYear: 2028 },
      facts,
    );
    if (resolved2028.carryInCapitalLossLt !== null) {
      fail("the record's first-year carry-in must not resolve into December 2028");
    }
    // The march's own legs, threaded through the shared
    // single-year pricer the console prices with: each
    // year's carry-out is the next year's entering
    // balance.
    const leg2026 = { ...base(), taxYear: 2026 };
    leg2026.ytdOtherOrdinary = 50000;
    leg2026.ytdCapitalGain = 10000;
    leg2026.carryInCapitalLossLt = 30000;
    const pg2026 = pricePlaygroundYear(decemberCaseInputs(leg2026, "likely", 0));
    exact(fail, "march 2026 carry-out", pg2026.lossCarryOutLt, 17000);
    const leg2027 = { ...base(), taxYear: 2027 };
    leg2027.ytdOtherOrdinary = 50000;
    leg2027.ytdCapitalGain = 10000;
    leg2027.carryInCapitalLossLt = pg2026.lossCarryOutLt;
    const pg2027 = pricePlaygroundYear(decemberCaseInputs(leg2027, "likely", 0));
    exact(fail, "march 2027 carry-out (2028's true entering balance)", pg2027.lossCarryOutLt, 4000);
    // December 2028 priced on the march's remainder:
    // the corrected MAGI, headline draw, and carry-out.
    const dec2028 = { ...base(), taxYear: 2028 };
    dec2028.ytdOtherOrdinary = 65000;
    dec2028.ytdCapitalGain = 20000;
    dec2028.carryInCapitalLossLt = pg2027.lossCarryOutLt;
    const corrected = computeDecemberProjection(dec2028);
    if (!corrected.priced) return fail("corrected 2028 not priced");
    const correctedLikely = corrected.cases[1]!;
    exact(fail, "corrected non-draw MAGI", correctedLikely.nonDrawAcaMagi, 81000);
    near(fail, "corrected headline draw", corrected.headlineDraw, 560);
    exact(fail, "corrected carry-out", correctedLikely.lossCarryOutLtAtHeadline, 0);
    near(fail, "corrected federal tax at headline", correctedLikely.federalTaxAtHeadline, 3507.2);
    // The same December priced on the full first-year
    // balance the widened gate used to resolve: every
    // error M-3 names, at its settled size.
    const inflated = computeDecemberProjection({
      ...dec2028,
      carryInCapitalLossLt: 30000,
    });
    if (!inflated.priced) return fail("inflated 2028 not priced");
    const inflatedLikely = inflated.cases[1]!;
    exact(fail, "full-balance non-draw MAGI", inflatedLikely.nonDrawAcaMagi, 62000);
    near(fail, "full-balance headline draw", inflated.headlineDraw, 19560);
    exact(fail, "full-balance carry-out", inflatedLikely.lossCarryOutLtAtHeadline, 7000);
    exact(
      fail,
      "MAGI understated by exactly the consumed balance",
      correctedLikely.nonDrawAcaMagi - inflatedLikely.nonDrawAcaMagi,
      19000,
    );
    near(
      fail,
      "headline draw overstated by the same $19,000",
      (inflated.headlineDraw ?? 0) - (corrected.headlineDraw ?? 0),
      19000,
    );
  });

  run("dec-reresolve-year-change", (fail) => {
    // Round-17 defect 2: changing the tax year
    // re-resolves the year-dependent overlays for the NEW
    // year. The settlement's worked example: a $10,000 LT
    // loss entering the plan's first year (2026) still
    // priced after switching to 2027 (MAGI $62,000 instead
    // of $65,000) because the year change never
    // re-resolved. Under the restored first-year-only
    // gate (M-3 fix, engines review round 2) the carry-in
    // resolves only for the plan's first year itself, so
    // switching to ANY other year — before it or after it
    // — clears the overlay: a later year's entering loss
    // is the march's remainder, not the first-year
    // balance. The education students are the new year's,
    // never the old year's.
    const facts2026: DecemberRecordFacts = {
      planFirstYear: 2026,
      carryInCapitalLossSt: 1000,
      carryInCapitalLossLt: 10000,
      carryInCapitalLossStWa: 250,
      carryInCapitalLossLtWa: 2000,
      educationStudents: [{ expenses: 4000, aotcEligible: true }],
    };
    const fresh = defaultDecemberState(2026);
    const stored = decemberStoredProvenanceOf(fresh);
    const none: {
      carryInSt: boolean;
      carryInLt: boolean;
      carryInStWa: boolean;
      carryInLtWa: boolean;
      education: boolean;
      balances: boolean;
    } = {
      carryInSt: false,
      carryInLt: false,
      carryInStWa: false,
      carryInLtWa: false,
      education: false,
      balances: false,
    };
    const display2026 = resolveDecemberStateAtLoad(fresh, facts2026);
    exact(fail, "2026 resolves the LT carry-in", display2026.carryInCapitalLossLt, 10000);
    // Switch to 2025 (before the plan's first year): the
    // carry-in overlay clears and the 2026 students go
    // with it.
    const facts2025: DecemberRecordFacts = {
      planFirstYear: 2026,
      carryInCapitalLossSt: 1000,
      carryInCapitalLossLt: 10000,
      carryInCapitalLossStWa: 250,
      carryInCapitalLossLtWa: 2000,
      educationStudents: [],
    };
    const back = reresolveDecemberStateForYear(
      { ...display2026, taxYear: 2025 },
      stored,
      none,
      facts2025,
    );
    if (
      back.carryInCapitalLossSt !== null ||
      back.carryInCapitalLossLt !== null ||
      back.carryInCapitalLossStWa !== null ||
      back.carryInCapitalLossLtWa !== null
    ) {
      fail("switching before the plan's first year must clear the carry-in overlay");
    }
    if ((back.educationStudents ?? []).length !== 0) {
      fail("switching years must drop the old year's education students");
    }
    // Switch to 2027 (after the plan's first year): the
    // carry-in overlay clears — 2027's entering loss is
    // the march's remainder after 2026, not the $10,000
    // that entered 2026 — and the 2027 students replace
    // the 2026 ones.
    const facts2027: DecemberRecordFacts = {
      planFirstYear: 2026,
      carryInCapitalLossSt: 1000,
      carryInCapitalLossLt: 10000,
      carryInCapitalLossStWa: 250,
      carryInCapitalLossLtWa: 2000,
      educationStudents: [{ expenses: 8000, aotcEligible: false }],
    };
    const forward = reresolveDecemberStateForYear(
      { ...display2026, taxYear: 2027 },
      stored,
      none,
      facts2027,
    );
    if (
      forward.carryInCapitalLossSt !== null ||
      forward.carryInCapitalLossLt !== null ||
      forward.carryInCapitalLossStWa !== null ||
      forward.carryInCapitalLossLtWa !== null
    ) {
      fail("switching past the plan's first year must clear the carry-in overlay");
    }
    if (
      forward.educationStudents == null ||
      forward.educationStudents.length !== 1 ||
      forward.educationStudents[0]!.expenses !== 8000
    ) {
      fail("switching years must resolve the new year's education students");
    }
    // A field the user edited is never touched by the
    // year change: an explicit $500 LT answer survives a
    // switch to 2025, while its unedited siblings clear.
    const editedLt = reresolveDecemberStateForYear(
      { ...display2026, taxYear: 2025, carryInCapitalLossLt: 500 },
      stored,
      { ...none, carryInLt: true },
      facts2025,
    );
    exact(fail, "an edited LT carry-in survives the year change", editedLt.carryInCapitalLossLt, 500);
    if (
      editedLt.carryInCapitalLossSt !== null ||
      editedLt.carryInCapitalLossStWa !== null ||
      editedLt.carryInCapitalLossLtWa !== null
    ) {
      fail("unedited carry-in siblings must still clear around an edited field");
    }
    const editedEdu = reresolveDecemberStateForYear(
      {
        ...display2026,
        taxYear: 2027,
        educationStudents: [{ expenses: 9000, aotcEligible: true }],
      },
      stored,
      { ...none, education: true },
      facts2027,
    );
    if (
      editedEdu.educationStudents == null ||
      editedEdu.educationStudents.length !== 1 ||
      editedEdu.educationStudents[0]!.expenses !== 9000
    ) {
      fail("edited education students survive the year change");
    }
    // Year-independent overlays are not touched: a
    // deliberately cleared harvest pool is not revived by
    // a year change (the re-resolution covers only the
    // year-dependent fields).
    const cleared = reresolveDecemberStateForYear(
      {
        ...display2026,
        taxYear: 2027,
        harvestPoolAmount: null,
        harvestPoolBasisPct: null,
      },
      stored,
      none,
      { ...facts2027, harvestPoolAmount: 40000, harvestPoolBasisPct: 75 },
    );
    if (
      cleared.harvestPoolAmount !== null ||
      cleared.harvestPoolBasisPct !== null
    ) {
      fail("a year change must not revive a deliberately cleared harvest fact");
    }
  });

  run("dec-record-balances-first-year-only", (fail) => {
    // (Internal review round 3, SHOULD-1 — settled STAND):
    // the December console's first-open preseed copied the Tax
    // Plan record's pre-tax balances — the plan's STARTING
    // balances — into the console's prior-Dec-31 balance fields
    // for whatever tax year the console was set to, and the
    // year-change re-resolution never touched them, so a future
    // RMD-age year priced its RMD on a balance from years
    // earlier. THE WORKED EXAMPLE (settlement, engine-run on
    // the shared fictional sample household): primary born
    // 1968, the pre-tax starting balance all the primary's;
    // choose tax year 2043 in a fresh console. Preseeded
    // prior-Dec-31 balance: the starting balance → console
    // RMD = starting balance / 24.6 (Uniform divisor at 75).
    // True Dec-31-2042 balance per the march (Do Nothing):
    // the march's 2042 pretaxEnd → true 2043 RMD = that
    // balance / 24.6. The console understated the RMD by the
    // difference — more than half the true RMD — so the
    // cliff-sized headline draw could overshoot by that much
    // and forfeit the year's credit while the console reported
    // the year safely under it. THE FIX: the record's balances
    // answer the console only for the plan's first year (the
    // record's execution year) — the same first-year gate as
    // the carry-in. The load overlay resolves them for the
    // first year and for no other; the year-change
    // re-resolution clears an unedited balance that IS the
    // record's starting balance when the year moves past the
    // first year, and the overlay re-fills it when the year
    // moves back. THE NUMBERS (sample household; the starting
    // balance is the sample constant, never a literal): stale
    // RMD 60,975.61, true RMD 139,757.21 on the march's
    // Dec-31-2042 balance 3,438,027.48 — understatement
    // 78,781.60. The fixture pins the console's behavior
    // (the stale RMD, the post-fix blank pricing no RMD) and
    // the gate; the march figures are the reference magnitude
    // the fix protects, re-verified by the gate probe.
    const P = SAMPLE_PRETAX_CENTS / 100;
    const facts: DecemberRecordFacts = {
      planFirstYear: 2026,
      pretaxBalancePrimary: P,
      pretaxBalanceSpouse: null,
    };
    const none = {
      carryInSt: false,
      carryInLt: false,
      carryInStWa: false,
      carryInLtWa: false,
      education: false,
      balances: false,
    };
    // LOAD: the first year resolves the record's balances; any
    // other year does not.
    const load2026 = resolveDecemberStateAtLoad(
      { ...defaultDecemberState(2026), pretaxBalancePrimary: null, pretaxBalanceSpouse: null },
      facts,
    );
    exact(fail, "2026 resolves the primary balance", load2026.pretaxBalancePrimary, P);
    if (load2026.pretaxBalanceSpouse !== null) {
      fail("2026 must leave the spouse balance unanswered (the record carries none)");
    }
    const load2043 = resolveDecemberStateAtLoad(
      { ...defaultDecemberState(2026), taxYear: 2043, pretaxBalancePrimary: null, pretaxBalanceSpouse: null },
      facts,
    );
    if (load2043.pretaxBalancePrimary !== null || load2043.pretaxBalanceSpouse !== null) {
      fail("a later year must not resolve the record's starting balances");
    }
    const load2025 = resolveDecemberStateAtLoad(
      { ...defaultDecemberState(2026), taxYear: 2025, pretaxBalancePrimary: null, pretaxBalanceSpouse: null },
      facts,
    );
    if (load2025.pretaxBalancePrimary !== null) {
      fail("a year before the plan's first year must not resolve the balances");
    }
    // An entered value always wins — including an explicit $0.
    const enteredZero = resolveDecemberStateAtLoad(
      { ...defaultDecemberState(2026), pretaxBalancePrimary: 0 },
      facts,
    );
    exact(fail, "entered $0 wins over the record balance", enteredZero.pretaxBalancePrimary, 0);
    const enteredHalf = resolveDecemberStateAtLoad(
      { ...defaultDecemberState(2026), pretaxBalancePrimary: P / 2 },
      facts,
    );
    exact(fail, "entered balance wins", enteredHalf.pretaxBalancePrimary, P / 2);
    // YEAR CHANGE: a preseeded 2026 console switching to 2043
    // clears the record's starting balances; switching back to
    // 2026 re-fills them through the overlay.
    const display2026 = {
      ...defaultDecemberState(2026),
      pretaxBalancePrimary: P,
      pretaxBalanceSpouse: null,
    };
    const storedPreseeded = decemberStoredProvenanceOf(display2026);
    const to2043 = reresolveDecemberStateForYear(
      { ...display2026, taxYear: 2043 },
      storedPreseeded,
      none,
      facts,
    );
    if (to2043.pretaxBalancePrimary !== null || to2043.pretaxBalanceSpouse !== null) {
      fail("switching past the plan's first year must clear the preseeded starting balances");
    }
    const back2026 = reresolveDecemberStateForYear(
      { ...to2043, taxYear: 2026 },
      decemberStoredProvenanceOf({ ...defaultDecemberState(2026), taxYear: 2043 }),
      none,
      facts,
    );
    exact(fail, "switching back to the first year re-fills the balances", back2026.pretaxBalancePrimary, P);
    // A balance the user EDITED survives the year change
    // untouched.
    const edited = reresolveDecemberStateForYear(
      { ...display2026, taxYear: 2043, pretaxBalancePrimary: P / 2 },
      storedPreseeded,
      { ...none, balances: true },
      facts,
    );
    exact(fail, "an edited balance survives the year change", edited.pretaxBalancePrimary, P / 2);
    // A stored balance that DIFFERS from the record's facts is
    // the console's own answer and survives too.
    const ownStored = decemberStoredProvenanceOf({
      ...defaultDecemberState(2026),
      pretaxBalancePrimary: P / 2,
    });
    const own = reresolveDecemberStateForYear(
      { ...display2026, taxYear: 2043, pretaxBalancePrimary: P / 2 },
      ownStored,
      none,
      facts,
    );
    exact(fail, "the console's own stored balance survives", own.pretaxBalancePrimary, P / 2);
    // RMD PRICING (primary 75 in 2043, Uniform divisor 24.6,
    // spouse sole beneficiary so the primary's own clock
    // applies): on the stale preseeded balance the console
    // priced RMD = starting balance / 24.6; post-fix the blank
    // balance prices no RMD — the field reads unanswered and
    // the user enters the true prior-year-end balance.
    const staleState = {
      ...defaultDecemberState(2026),
      taxYear: 2043,
      agePrimary: 75,
      ageSpouse: 73,
      onMedicarePrimary: true,
      onMedicareSpouse: true,
      spouseSoleBeneficiary: true,
      pretaxBalancePrimary: P,
      pretaxBalanceSpouse: null,
    };
    const stalePg = pricePlaygroundYear(decemberCaseInputs(staleState, "likely", 0));
    exact(fail, "stale RMD on the starting balance", stalePg.rmdPrimary, 60975.61);
    exact(fail, "stale RMD divisor at 75", stalePg.rmdDivisor, 24.6);
    const blankPg = pricePlaygroundYear(
      decemberCaseInputs({ ...staleState, pretaxBalancePrimary: null }, "likely", 0),
    );
    exact(fail, "blank balance prices no RMD", blankPg.rmdPrimary, 0);
  });

  run("dec-stored-carryin-year-gated", (fail) => {
    // (Internal review round 4, SHOULD-1 — settled STAND):
    // round-3 SHOULD-1 gated the December console's RECORD
    // balances to the plan's first year, but the same
    // stale-year defect survived for carry-ins through the
    // STORED-provenance path: reresolveDecemberStateForYear
    // reset every unedited carry-in to its STORED value with
    // no year gate, and the edited flags are session state
    // (reset on reload), so a carry-in saved in an earlier
    // session returned as unedited and was restored into a
    // later year, bypassing the first-year-only gate. THE
    // WORKED EXAMPLE (settlement, engine-run): stored LT
    // carry-in $10,000 saved for 2026. 2026 consumption leg:
    // carry-in $10,000 + $10,000 LT gain → ltcgNet $0,
    // allowance $0, carry-out $0, MAGI $100,000 (the balance
    // is fully consumed). 2027 pricing leg (MFJ, ages 59/57,
    // other ordinary $100,000, $8,000 LT gain): stale MAGI
    // $98,000, ltcgNet −$2,000, allowance $2,000, federal
    // tax $7,400; true MAGI $108,000, ltcgNet $8,000,
    // federal tax $7,640 — MAGI understated by $10,000, the
    // full stale balance ($8,000 gain sheltered + $2,000
    // allowance), and the cliff-sized draw overshoots in the
    // non-conservative direction. Education leg, same
    // mechanism: a stored 2026 student ($4,000,
    // AOTC-eligible) survived into 2027 instead of the 2027
    // student ($8,000, not AOTC-eligible). THE FIX: the
    // stored provenance carries the tax year of the blob it
    // was saved for (the stamp — the blob's own tax year,
    // so no format change), and the year-change reset
    // restores a stored carry-in or student only into that
    // same year; into any other year it clears the field.
    // The fixture pins the console's behavior through its
    // own paths (reresolve + December pricing), and the
    // pricing legs pin the worked example to the cent.
    const none = {
      carryInSt: false,
      carryInLt: false,
      carryInStWa: false,
      carryInLtWa: false,
      education: false,
      balances: false,
    };
    const facts2026: DecemberRecordFacts = {
      planFirstYear: 2026,
      carryInCapitalLossSt: 1000,
      carryInCapitalLossLt: 10000,
      carryInCapitalLossStWa: 250,
      carryInCapitalLossLtWa: 2000,
      educationStudents: [{ expenses: 4000, aotcEligible: true }],
    };
    const facts2027: DecemberRecordFacts = {
      planFirstYear: 2026,
      carryInCapitalLossSt: 1000,
      carryInCapitalLossLt: 10000,
      carryInCapitalLossStWa: 250,
      carryInCapitalLossLtWa: 2000,
      educationStudents: [{ expenses: 8000, aotcEligible: false }],
    };
    // Stored provenance as saved for 2026: all four
    // carry-ins non-null, stamped 2026.
    const stored2026 = decemberStoredProvenanceOf({
      ...defaultDecemberState(2026),
      carryInCapitalLossSt: 1000,
      carryInCapitalLossLt: 10000,
      carryInCapitalLossStWa: 250,
      carryInCapitalLossLtWa: 2000,
    });
    exact(fail, "stored provenance stamps the saved year", stored2026.taxYear, 2026);
    const display2026 = {
      ...defaultDecemberState(2026),
      carryInCapitalLossSt: 1000,
      carryInCapitalLossLt: 10000,
      carryInCapitalLossStWa: 250,
      carryInCapitalLossLtWa: 2000,
      educationStudents: [{ expenses: 4000, aotcEligible: true }],
    };
    // YEAR CHANGE 2026 -> 2027: the stamped stored values
    // do NOT restore — every carry-in clears.
    const to2027 = reresolveDecemberStateForYear(
      { ...display2026, taxYear: 2027 },
      stored2026,
      none,
      facts2027,
    );
    if (
      to2027.carryInCapitalLossSt !== null ||
      to2027.carryInCapitalLossLt !== null ||
      to2027.carryInCapitalLossStWa !== null ||
      to2027.carryInCapitalLossLtWa !== null
    ) {
      fail("a stored carry-in must not restore into a later year");
    }
    // The 2027 students resolve instead of the stored 2026
    // ones.
    if (
      to2027.educationStudents == null ||
      to2027.educationStudents.length !== 1 ||
      to2027.educationStudents[0]!.expenses !== 8000 ||
      to2027.educationStudents[0]!.aotcEligible !== false
    ) {
      fail("switching years must resolve the new year's education students, not restore the stored ones");
    }
    // Null-stored control still clears.
    const storedNull = decemberStoredProvenanceOf(defaultDecemberState(2026));
    const to2027null = reresolveDecemberStateForYear(
      { ...display2026, taxYear: 2027, carryInCapitalLossLt: null },
      storedNull,
      none,
      facts2027,
    );
    if (to2027null.carryInCapitalLossLt !== null) {
      fail("a null stored carry-in must stay cleared");
    }
    // Same-session EDITED carry-in survives the year change
    // even with a mismatched stamp — an explicit answer for
    // the new year, pinned by fixture and by design.
    const editedLt = reresolveDecemberStateForYear(
      { ...display2026, taxYear: 2027, carryInCapitalLossLt: 500 },
      stored2026,
      { ...none, carryInLt: true },
      facts2027,
    );
    exact(fail, "an edited LT carry-in survives the year change", editedLt.carryInCapitalLossLt, 500);
    if (
      editedLt.carryInCapitalLossSt !== null ||
      editedLt.carryInCapitalLossStWa !== null ||
      editedLt.carryInCapitalLossLtWa !== null
    ) {
      fail("unedited carry-in siblings must still clear around an edited field");
    }
    // ROUND-TRIP at the function level: switching back to
    // the stamped year restores the stored value exactly —
    // the stamp is precise where blind clearing would not
    // be. (The live console patches the provenance to null
    // on the clear, so its round-trip re-fills through the
    // record overlay instead; this leg pins the function's
    // own contract.)
    const back2026 = reresolveDecemberStateForYear(
      { ...to2027, taxYear: 2026 },
      stored2026,
      none,
      facts2026,
    );
    exact(fail, "switching back to the stamped year restores the carry-in", back2026.carryInCapitalLossLt, 10000);
    // PRICING: the 2026 consumption leg fully consumes the
    // balance; the 2027 leg prices the true MAGI once the
    // stale carry-in no longer restores.
    const s26 = defaultDecemberState(2026);
    s26.ytdOtherOrdinary = 100000;
    s26.ytdCapitalGain = 10000;
    s26.carryInCapitalLossLt = 10000;
    const pg26 = pricePlaygroundYear(decemberCaseInputs(s26, "likely", 0));
    exact(fail, "2026 ltcgNet fully sheltered", pg26.ltcgNet, 0);
    exact(fail, "2026 allowance fully consumed", pg26.capitalLossAllowance, 0);
    exact(fail, "2026 carry-out fully consumed", pg26.lossCarryOutLt, 0);
    exact(fail, "2026 MAGI", pg26.acaMagi, 100000);
    const price2027 = (carryIn: number | null) => {
      const s = defaultDecemberState(2027);
      s.agePrimary = 59;
      s.ageSpouse = 57;
      s.ytdOtherOrdinary = 100000;
      s.ytdCapitalGain = 8000;
      s.carryInCapitalLossLt = carryIn;
      const pg = pricePlaygroundYear(decemberCaseInputs(s, "likely", 0));
      const proj = computeDecemberProjection(s);
      return { pg, nonDrawMagi: proj.cases[1]!.nonDrawAcaMagi };
    };
    const stale = price2027(10000);
    exact(fail, "stale 2027 ltcgNet", stale.pg.ltcgNet, -2000);
    exact(fail, "stale 2027 allowance", stale.pg.capitalLossAllowance, 2000);
    exact(fail, "stale 2027 MAGI", stale.pg.acaMagi, 98000);
    exact(fail, "stale 2027 federal tax", stale.pg.federalTax, 7400);
    exact(fail, "stale 2027 non-draw MAGI", stale.nonDrawMagi, 98000);
    const fixed = price2027(to2027.carryInCapitalLossLt);
    exact(fail, "fixed 2027 ltcgNet", fixed.pg.ltcgNet, 8000);
    exact(fail, "fixed 2027 allowance", fixed.pg.capitalLossAllowance, 0);
    exact(fail, "fixed 2027 MAGI", fixed.pg.acaMagi, 108000);
    exact(fail, "fixed 2027 federal tax", fixed.pg.federalTax, 7640);
    exact(fail, "fixed 2027 non-draw MAGI", fixed.nonDrawMagi, 108000);
  });

  run("dec-stored-carryin-switchback-save", (fail) => {
    // (Internal review round 5, SHOULD-1 — settled STAND):
    // the round-4 year gate held at the function level but
    // NOT in the live console for non-first years. The
    // year-change handler patched the stored provenance
    // itself to nulls whenever the stamp year differed
    // from the new year, and decemberStateForSave persisted
    // the STORED value for every unedited field with no
    // year check at all — so the patch was what made the
    // save correct, at the price of destroying the stored
    // values: a carry-in (or typed students) saved for a
    // non-first year was permanently lost on a switch away
    // and back, because the record overlay refills only
    // the plan's first year. THE FIX: the save is
    // stamp-aware (an unedited carry-in or student
    // persists its stored value only when the stamp IS
    // the display year, and null otherwise — never the
    // display value, which on a mismatch is either the
    // cleared null or an overlay re-fill the save must
    // not own), the destructive patch is removed, and a
    // pure year change no longer dirties the form, so no
    // autosave fires on the switch itself. This fixture
    // pins the switch-back round trip THROUGH THE SAVE at
    // the engine level — the gap the round-4 fixture
    // (which pinned only the pure reresolve) left open.
    // THE WORKED EXAMPLE (settlement, engine-run): saved
    // 2027 LT carry-in $10,000, stamp 2027; pricing of
    // 2027 (MFJ, ages 59/57, other ordinary $100,000,
    // $8,000 LT gain): with the carry-in MAGI $98,000,
    // ltcgNet −$2,000, federal tax $7,400; without it MAGI
    // $108,000, ltcgNet $8,000, federal tax $7,640.
    // Education leg: saved 2027 typed students $5,000
    // (AOTC-eligible) + $3,000; the record holds no 2027
    // students.
    const none = {
      carryInSt: false,
      carryInLt: false,
      carryInStWa: false,
      carryInLtWa: false,
      education: false,
      balances: false,
    };
    const noEdit = { beneficiary: false, balances: false };
    const typedStudents = [
      { expenses: 5000, aotcEligible: true },
      { expenses: 3000, aotcEligible: false },
    ];
    const stored2027 = decemberStoredProvenanceOf({
      ...defaultDecemberState(2027),
      carryInCapitalLossLt: 10000,
      educationStudents: typedStudents,
    });
    exact(fail, "stored provenance stamps 2027", stored2027.taxYear, 2027);
    // The record holds NO students for 2027 or 2028 (an
    // empty answer), and its carry-in answers the plan's
    // first year only, so nothing refills a non-first year.
    const facts2027: DecemberRecordFacts = {
      planFirstYear: 2026,
      carryInCapitalLossLt: 10000,
      educationStudents: [],
    };
    const facts2028: DecemberRecordFacts = {
      planFirstYear: 2026,
      carryInCapitalLossLt: 10000,
      educationStudents: [],
    };
    const facts2028Students: DecemberRecordFacts = {
      planFirstYear: 2026,
      carryInCapitalLossLt: 10000,
      educationStudents: [{ expenses: 8000, aotcEligible: false }],
    };
    const facts2026: DecemberRecordFacts = {
      planFirstYear: 2026,
      carryInCapitalLossLt: 10000,
      educationStudents: [{ expenses: 4000, aotcEligible: true }],
    };
    // LOAD 2027: the saved carry-in and the typed students
    // are what the console shows.
    const load2027 = resolveDecemberStateAtLoad(
      {
        ...defaultDecemberState(2027),
        carryInCapitalLossLt: 10000,
        educationStudents: typedStudents,
      },
      facts2027,
    );
    exact(fail, "load 2027 shows the saved carry-in", load2027.carryInCapitalLossLt, 10000);
    const ls = load2027.educationStudents;
    if (
      ls == null ||
      ls.length !== 2 ||
      ls[0]!.expenses !== 5000 ||
      ls[0]!.aotcEligible !== true ||
      ls[1]!.expenses !== 3000 ||
      ls[1]!.aotcEligible !== false
    ) {
      fail("load 2027 must show the two typed students");
    }
    // SWITCH TO 2028 (re-resolution only — the provenance
    // is NOT patched; the patch is removed): the display
    // clears, and the students resolve to the empty list
    // the record answers for 2028 — an empty list, not
    // null.
    const to2028 = reresolveDecemberStateForYear(
      { ...load2027, taxYear: 2028 },
      stored2027,
      none,
      facts2028,
    );
    if (to2028.carryInCapitalLossLt !== null) fail("switching to 2028 must clear the carry-in");
    if (to2028.educationStudents == null || to2028.educationStudents.length !== 0) {
      fail("switching to 2028 must resolve the students to the record's empty answer, not null");
    }
    // SWITCH BACK TO 2027: the stored values restore
    // exactly, because the provenance survived the switch
    // away.
    const back2027 = reresolveDecemberStateForYear(
      { ...to2028, taxYear: 2027 },
      stored2027,
      none,
      facts2027,
    );
    exact(fail, "switching back restores the carry-in", back2027.carryInCapitalLossLt, 10000);
    const bs = back2027.educationStudents;
    if (
      bs == null ||
      bs.length !== 2 ||
      bs[0]!.expenses !== 5000 ||
      bs[0]!.aotcEligible !== true ||
      bs[1]!.expenses !== 3000 ||
      bs[1]!.aotcEligible !== false
    ) {
      fail("switching back must restore the two typed students");
    }
    // THE RE-SAVE of the round-tripped display against the
    // 2027 stamp holds both values, and the re-saved blob's
    // own provenance still stamps 2027 and holds them.
    const resaved = decemberStateForSave(back2027, stored2027, noEdit);
    exact(fail, "the re-save holds the carry-in", resaved.carryInCapitalLossLt, 10000);
    const rs = resaved.educationStudents;
    if (
      rs == null ||
      rs.length !== 2 ||
      rs[0]!.expenses !== 5000 ||
      rs[0]!.aotcEligible !== true ||
      rs[1]!.expenses !== 3000 ||
      rs[1]!.aotcEligible !== false
    ) {
      fail("the re-save must hold the two typed students");
    }
    const resavedProv = decemberStoredProvenanceOf(resaved);
    exact(fail, "the re-saved blob stamps 2027", resavedProv.taxYear, 2027);
    exact(fail, "the re-saved blob holds the carry-in", resavedProv.carryInCapitalLossLt, 10000);
    // STAMP-AWARE SAVE ON MISMATCH: a 2028 display saved
    // against the 2027 stamp persists NULL for the carry-in
    // and the students — the stored 2027 values must not be
    // written under 2028 (the direction the removed patch
    // used to guard, now closed at the save).
    const saveMismatch = decemberStateForSave(
      { ...defaultDecemberState(2028), carryInCapitalLossLt: null, educationStudents: null },
      stored2027,
      noEdit,
    );
    if (saveMismatch.carryInCapitalLossLt !== null) fail("a mismatched save must persist no carry-in");
    if (saveMismatch.educationStudents !== null) {
      fail("a mismatched save must persist null students, not the stored ones");
    }
    // The overlay case of the same rule: switching into
    // 2028 with record students fills the display with the
    // 2028 record student as an overlay — the save against
    // the 2027 stamp persists null, never the overlay.
    const display2028Overlay = reresolveDecemberStateForYear(
      { ...load2027, taxYear: 2028 },
      stored2027,
      none,
      facts2028Students,
    );
    const os = display2028Overlay.educationStudents;
    if (
      os == null ||
      os.length !== 1 ||
      os[0]!.expenses !== 8000 ||
      os[0]!.aotcEligible !== false
    ) {
      fail("the 2028 display must carry the 2028 record student as an overlay");
    }
    if (display2028Overlay.carryInCapitalLossLt !== null) fail("the overlay display must clear the carry-in");
    const saveOverlay = decemberStateForSave(display2028Overlay, stored2027, noEdit);
    if (saveOverlay.carryInCapitalLossLt !== null) fail("the overlay save must persist no carry-in");
    if (saveOverlay.educationStudents !== null) {
      fail("the save must persist null, never the overlay students");
    }
    // FIRST-YEAR DISCIPLINE PRESERVED: a 2026 display
    // carrying the record overlay (carry-in and student)
    // over a null stored blob still saves null for both —
    // the record owns the first-year values and the overlay
    // refills them on reload.
    const storedFirstNull = decemberStoredProvenanceOf(defaultDecemberState(2026));
    const load2026 = resolveDecemberStateAtLoad(defaultDecemberState(2026), facts2026);
    exact(fail, "the first year resolves the record carry-in", load2026.carryInCapitalLossLt, 10000);
    const fs = load2026.educationStudents;
    if (
      fs == null ||
      fs.length !== 1 ||
      fs[0]!.expenses !== 4000 ||
      fs[0]!.aotcEligible !== true
    ) {
      fail("the first year must resolve the record student as an overlay");
    }
    const saveFirst = decemberStateForSave(load2026, storedFirstNull, noEdit);
    if (saveFirst.carryInCapitalLossLt !== null) fail("the first-year save must persist null carry-in");
    if (saveFirst.educationStudents !== null) {
      fail("the first-year save must persist null students — the record owns them");
    }
    // PRICING: the round-tripped 2027 display prices the
    // settlement's with-carry-in figures; the lost-carry-in
    // control prices the without figures.
    const price2027 = (carryIn: number | null) => {
      const s = defaultDecemberState(2027);
      s.agePrimary = 59;
      s.ageSpouse = 57;
      s.ytdOtherOrdinary = 100000;
      s.ytdCapitalGain = 8000;
      s.carryInCapitalLossLt = carryIn;
      return pricePlaygroundYear(decemberCaseInputs(s, "likely", 0));
    };
    const restored = price2027(back2027.carryInCapitalLossLt);
    exact(fail, "round-tripped 2027 MAGI", restored.acaMagi, 98000);
    exact(fail, "round-tripped 2027 ltcgNet", restored.ltcgNet, -2000);
    exact(fail, "round-tripped 2027 federal tax", restored.federalTax, 7400);
    const lost = price2027(null);
    exact(fail, "lost-carry-in 2027 MAGI", lost.acaMagi, 108000);
    exact(fail, "lost-carry-in 2027 ltcgNet", lost.ltcgNet, 8000);
    exact(fail, "lost-carry-in 2027 federal tax", lost.federalTax, 7640);
  });

  run("dec-stored-carryin-switchback-typed", (fail) => {
    // (Internal review round 6, SHOULD-1 — settled STAND):
    // the round-5 fix closed the year-change path for LOADED
    // (unedited) values, but NOT for values the user TYPED in
    // the session. The edited flags are session-level useState
    // booleans, reset only on load / CAS-conflict reload — not
    // on save success and not on year change — so a typed
    // carry-in (or typed students) kept its display value
    // across a flip, priced the new year wrong, and one edit
    // there re-stamped it under the new year, where it was
    // lost to its true year forever after a reload. THE FIX
    // (the settlement's close): on a year change, first flush
    // any save queued by a real edit at the old year — the
    // queued payload was built from the old year's form with
    // the old flags, so it saves the typed values under the
    // old year's stamp — then reset the four carry-in flags
    // and the education flag to false (balances and harvest
    // flags untouched), so the new year starts unedited and
    // the round-5 machinery (reresolve + stamp-aware save)
    // governs it. This fixture pins the TYPED round trip
    // through the console's own paths (save + reresolve +
    // save + load) — the gap the round-5 fixture (which pins
    // only the unedited path) left open. The flag reset
    // itself is client code; this fixture models it by
    // passing all-false flags to the re-resolution on the
    // flip, exactly as the handler now does.
    // ON THE "EDIT AT 2028" LEG, read carefully: the leg
    // asserts on the PAYLOAD the edit builds (no re-stamp —
    // it carries null, never the $10,000) and does NOT adopt
    // that payload as the new stored provenance before the
    // flip-back. A landed save at 2028 re-stamps the blob to
    // 2028 with nulls — the round-5 NULL rule, pinned by the
    // existing fixture's mismatch legs — so no round trip,
    // typed or loaded, can restore after a landed save at
    // the new year. The guarantee, exactly as for the loaded
    // path, is the round trip with no intervening save at
    // the new year; the edit-at-2028 leg pins the no-re-stamp
    // property instead. THE WORKED EXAMPLE (the settlement's,
    // engine-run): a TYPED 2027 long-term carry-in of
    // $10,000 — pricing of 2028 (MFJ, ages 60/58, other
    // ordinary $100,000, an $8,000 long-term gain): with the
    // stale carry-in MAGI $98,000, net long-term gain
    // −$2,000, federal tax $7,400; without it MAGI $108,000,
    // net long-term gain $8,000, federal tax $7,640. The
    // students leg: typed 2027 students of $5,000
    // (AOTC-eligible) plus $3,000, the record holding none —
    // 2028 with the stale students taxes $5,540 vs $7,640
    // without them. The draw leg is built on the shared
    // fictional sample household (never the household's
    // figures): 2028, ages 60/58 (sample birth years
    // 1968/1970), household of 4, family benchmark $36,000,
    // buffer $5,000, pre-tax $1,500,000, sample year-to-date
    // actuals, other ordinary (an interior draw needs
    // the non-draw income below the cliff-minus-buffer
    // target), an $8,000 long-term gain, spending $180,000 a
    // year — the stale carry-in sizes the draw $10,000 too
    // large and the true year at that draw lands over the
    // cliff and forfeits the whole credit.
    const none = {
      carryInSt: false,
      carryInLt: false,
      carryInStWa: false,
      carryInLtWa: false,
      education: false,
      balances: false,
    };
    const noEdit = { beneficiary: false, balances: false };
    const typedStudents = [
      { expenses: 5000, aotcEligible: true },
      { expenses: 3000, aotcEligible: false },
    ];
    const facts2027: DecemberRecordFacts = {
      planFirstYear: 2026,
      carryInCapitalLossLt: 10000,
      educationStudents: [],
    };
    const facts2028: DecemberRecordFacts = {
      planFirstYear: 2026,
      carryInCapitalLossLt: 10000,
      educationStudents: [],
    };
    // TYPE at 2027 (carry-in + students) and AUTOSAVE: the
    // edited branches take the display values, so the blob
    // stamps 2027 and holds both.
    const storedNull2027 = decemberStoredProvenanceOf(defaultDecemberState(2027));
    const display2027Typed = {
      ...defaultDecemberState(2027),
      carryInCapitalLossLt: 10000,
      educationStudents: typedStudents,
    };
    const saved2027 = decemberStateForSave(display2027Typed, storedNull2027, {
      ...noEdit,
      carryInLt: true,
      education: true,
    });
    exact(fail, "the typed 2027 save stamps 2027", decemberStoredProvenanceOf(saved2027).taxYear, 2027);
    exact(fail, "the typed 2027 save holds the carry-in", saved2027.carryInCapitalLossLt, 10000);
    const ss = saved2027.educationStudents;
    if (
      ss == null ||
      ss.length !== 2 ||
      ss[0]!.expenses !== 5000 ||
      ss[0]!.aotcEligible !== true ||
      ss[1]!.expenses !== 3000 ||
      ss[1]!.aotcEligible !== false
    ) {
      fail("the typed 2027 save must hold the two typed students");
    }
    const stored2027 = decemberStoredProvenanceOf(saved2027);
    exact(fail, "stored provenance stamps 2027", stored2027.taxYear, 2027);
    exact(fail, "stored provenance holds the typed carry-in", stored2027.carryInCapitalLossLt, 10000);
    // LOAD 2027 shows the typed values.
    const load2027 = resolveDecemberStateAtLoad({ ...saved2027 }, facts2027);
    exact(fail, "load 2027 shows the typed carry-in", load2027.carryInCapitalLossLt, 10000);
    const ls = load2027.educationStudents;
    if (
      ls == null ||
      ls.length !== 2 ||
      ls[0]!.expenses !== 5000 ||
      ls[0]!.aotcEligible !== true ||
      ls[1]!.expenses !== 3000 ||
      ls[1]!.aotcEligible !== false
    ) {
      fail("load 2027 must show the two typed students");
    }
    // FLIP TO 2028 with the flags reset (the handler's new
    // behavior, modeled by all-false flags): the display
    // clears — the typed values no longer survive the flip.
    const to2028 = reresolveDecemberStateForYear(
      { ...load2027, taxYear: 2028 },
      stored2027,
      none,
      facts2028,
    );
    if (to2028.carryInCapitalLossLt !== null) fail("the typed carry-in must clear on the flip to 2028");
    if (to2028.educationStudents == null || to2028.educationStudents.length !== 0) {
      fail("the typed students must clear on the flip to 2028");
    }
    // EDIT AT 2028: the payload the edit builds carries no
    // re-stamp — it stamps 2028 with nulls for both fields.
    // (The payload is asserted, not adopted: see the header
    // comment for why a landed 2028 save ends the round trip.)
    const edited2028 = { ...to2028, ytdInterest: 900 };
    const payload2028 = decemberStateForSave(edited2028, stored2027, noEdit);
    exact(fail, "the 2028 edit's payload stamps 2028", payload2028.taxYear, 2028);
    if (payload2028.carryInCapitalLossLt !== null) fail("the 2028 edit must not re-stamp the 2027 carry-in to 2028");
    if (payload2028.educationStudents !== null) fail("the 2028 edit must not re-stamp the 2027 students to 2028");
    // PRICING: the cleared 2028 display prices the TRUE
    // figures; the stale values price the defect's figures.
    const price2028 = (carryIn: number | null, students: { expenses: number; aotcEligible: boolean }[] | null) => {
      const s = defaultDecemberState(2028);
      s.agePrimary = 60;
      s.ageSpouse = 58;
      s.ytdOtherOrdinary = 100000;
      s.ytdCapitalGain = 8000;
      s.carryInCapitalLossLt = carryIn;
      s.educationStudents = students;
      return pricePlaygroundYear(decemberCaseInputs(s, "likely", 0));
    };
    const cleared2028 = price2028(to2028.carryInCapitalLossLt, to2028.educationStudents);
    exact(fail, "cleared 2028 MAGI", cleared2028.acaMagi, 108000);
    exact(fail, "cleared 2028 ltcgNet", cleared2028.ltcgNet, 8000);
    exact(fail, "cleared 2028 federal tax", cleared2028.federalTax, 7640);
    const staleCarry2028 = price2028(10000, null);
    exact(fail, "stale-carry-in 2028 MAGI", staleCarry2028.acaMagi, 98000);
    exact(fail, "stale-carry-in 2028 ltcgNet", staleCarry2028.ltcgNet, -2000);
    exact(fail, "stale-carry-in 2028 federal tax", staleCarry2028.federalTax, 7400);
    const staleStudents2028 = price2028(null, typedStudents);
    exact(fail, "stale-students 2028 MAGI", staleStudents2028.acaMagi, 108000);
    exact(fail, "stale-students 2028 federal tax", staleStudents2028.federalTax, 5540);
    // FLIP BACK TO 2027 (no save landed at 2028): the stored
    // values restore exactly, because the provenance
    // survived the switch away.
    const back2027 = reresolveDecemberStateForYear(
      { ...to2028, taxYear: 2027 },
      stored2027,
      none,
      facts2027,
    );
    exact(fail, "flipping back restores the typed carry-in", back2027.carryInCapitalLossLt, 10000);
    const bs = back2027.educationStudents;
    if (
      bs == null ||
      bs.length !== 2 ||
      bs[0]!.expenses !== 5000 ||
      bs[0]!.aotcEligible !== true ||
      bs[1]!.expenses !== 3000 ||
      bs[1]!.aotcEligible !== false
    ) {
      fail("flipping back must restore the two typed students");
    }
    // THE RE-SAVE of the round-tripped display against the
    // 2027 stamp holds both values, and the re-saved blob's
    // own provenance still stamps 2027 and holds them.
    const resaved = decemberStateForSave(back2027, stored2027, noEdit);
    exact(fail, "the re-save holds the typed carry-in", resaved.carryInCapitalLossLt, 10000);
    const rs = resaved.educationStudents;
    if (
      rs == null ||
      rs.length !== 2 ||
      rs[0]!.expenses !== 5000 ||
      rs[0]!.aotcEligible !== true ||
      rs[1]!.expenses !== 3000 ||
      rs[1]!.aotcEligible !== false
    ) {
      fail("the re-save must hold the two typed students");
    }
    const resavedProv = decemberStoredProvenanceOf(resaved);
    exact(fail, "the re-saved blob stamps 2027", resavedProv.taxYear, 2027);
    exact(fail, "the re-saved blob holds the typed carry-in", resavedProv.carryInCapitalLossLt, 10000);
    // RELOAD from the re-saved blob holds both values.
    const reloaded = resolveDecemberStateAtLoad({ ...resaved }, facts2027);
    exact(fail, "reload holds the typed carry-in", reloaded.carryInCapitalLossLt, 10000);
    const rl = reloaded.educationStudents;
    if (
      rl == null ||
      rl.length !== 2 ||
      rl[0]!.expenses !== 5000 ||
      rl[0]!.aotcEligible !== true ||
      rl[1]!.expenses !== 3000 ||
      rl[1]!.aotcEligible !== false
    ) {
      fail("reload must hold the two typed students");
    }
    // ORDERING (the flush must send the queued payload as
    // built): the queued payload at type time was built with
    // the OLD flags (edited=true) and holds the typed value
    // under 2027 — while the SAME display saved after the
    // flag reset, against a stored provenance that does not
    // yet hold the value, persists null and the typed edit
    // is lost. That is why the handler flushes the queued
    // payload BEFORE resetting the flags.
    const queuedPayload = decemberStateForSave(display2027Typed, storedNull2027, {
      ...noEdit,
      carryInLt: true,
    });
    exact(fail, "the queued payload holds the typed carry-in", queuedPayload.carryInCapitalLossLt, 10000);
    exact(fail, "the queued payload stamps 2027", queuedPayload.taxYear, 2027);
    const afterResetPayload = decemberStateForSave(display2027Typed, storedNull2027, noEdit);
    if (afterResetPayload.carryInCapitalLossLt !== null) {
      fail("a save built after the flag reset, against a stored provenance without the value, must persist null — the typed edit is lost unless the queued payload was flushed first");
    }
    // DRAW / CLIFF (sample household — see the header
    // comment): the stale carry-in sizes the 2028 draw
    // $10,000 too large, and the true year at that draw
    // lands over the cliff and forfeits the whole credit.
    const base2028Draw = (carryIn: number | null) => {
      const s = defaultDecemberState(2028);
      s.agePrimary = 60;
      s.ageSpouse = 58;
      s.acaHouseholdSize = 4;
      s.acaBenchmarkAnnual = 36000;
      s.bufferDollars = 5000;
      s.pretaxBalance = 1500000;
      s.pretaxBalancePrimary = 1500000;
      s.pretaxBalanceSpouse = 0;
      s.pretaxSplitExplicit = true;
      s.ytdInterest = 1500;
      s.ytdOrdinaryDividends = 20000;
      s.ytdQualifiedDividends = 15000;
      s.ytdOtherOrdinary = 60000 + 20000;
      s.ytdCapitalGain = 8000;
      s.carryInCapitalLossLt = carryIn;
      s.spouseSoleBeneficiary = true;
      return s;
    };
    const projStaleDraw = computeDecemberProjection(base2028Draw(10000), 18000000);
    const projFixedDraw = computeDecemberProjection(base2028Draw(null), 18000000);
    exact(fail, "the stale draw overshoots", projStaleDraw.headlineDraw, 27500);
    exact(fail, "the fixed draw", projFixedDraw.headlineDraw, 17500);
    const trueAtWrongDraw = pricePlaygroundYear(
      decemberCaseInputs(base2028Draw(null), "likely", projStaleDraw.headlineDraw ?? 0),
    );
    exact(fail, "true 2028 at the wrong draw MAGI", trueAtWrongDraw.acaMagi, 137000);
    exact(fail, "true 2028 at the wrong draw tax", trueAtWrongDraw.federalTax, 10205);
    if (trueAtWrongDraw.aca.overCliff !== true) fail("the wrong draw must push true 2028 over the cliff");
    exact(fail, "the wrong draw forfeits the benchmark credit", trueAtWrongDraw.aca.credit, 0);
    const trueAtRightDraw = pricePlaygroundYear(
      decemberCaseInputs(base2028Draw(null), "likely", projFixedDraw.headlineDraw ?? 0),
    );
    exact(fail, "true 2028 at the right draw MAGI", trueAtRightDraw.acaMagi, 127000);
    exact(fail, "true 2028 at the right draw tax", trueAtRightDraw.federalTax, 8120);
    if (trueAtRightDraw.aca.overCliff !== false) fail("the right draw must keep true 2028 under the cliff");
    exact(fail, "the right draw keeps the benchmark credit", trueAtRightDraw.aca.credit, 23350.8);
  });

  run("dec-harvest-pool-switchback-ytd", (fail) => {
    // (Internal review round 6, SHOULD-2 — settled STAND):
    // the load resolution derives the harvest STARTING pool
    // from the record's current pool plus the year's
    // year-to-date sale and taxable cash (the settled S-8
    // derivation — year-specific add-backs), but the
    // year-change re-resolution never touched the pool at
    // all, documenting it as year-independent. A fresh load
    // at the new year and a flip into it from the old year
    // therefore showed DIFFERENT starting pools for the same
    // year and the same record, and the flipped year priced
    // its harvest from the old year's pool. THE FIX (the
    // settlement's close, with the year-to-date entanglement
    // decided): the year-to-date figures ARE year-stamped
    // facts — the S-8 derivation's "year-to-date sale only"
    // and the pricer's netting of "the year's taxable sales"
    // both assume the form's figures belong to the displayed
    // year. So on a year change, as one mechanism: the
    // year-to-date figure group (interest, ordinary
    // dividends, qualified dividends, capital gain, sale
    // basis, taxable funded cash) resets to the new year's
    // answer — blank, since no record source carries them,
    // until the user types them — and the harvest starting
    // pool (and basis %) re-derives from the reset figures
    // when overlay-derived (stored pool null), exactly as a
    // fresh load would. A user-entered or previously saved
    // non-null pool stays, consistent with the load
    // resolution's "a non-null pool always wins" rule, and a
    // deliberately cleared pool is never revived. The save
    // preserves the year-to-date figures stamp-aware (the
    // carry-in pattern, one edited flag for the group), so a
    // flip-back before any save at the new year restores the
    // old year's figures from stored provenance. This
    // fixture pins the round trip through the console's own
    // paths (save + re-resolution + save + load) — the flag
    // reset itself is client code; this fixture models it
    // by passing all-false flags to the re-resolution on the
    // flip, exactly as the handler now does. ON THE "EDIT
    // AT 2028" LEG, read carefully: the leg asserts on the
    // PAYLOAD the edit builds (no re-stamp — it carries
    // blank figures, never the old year's) and does NOT
    // adopt that payload as the new stored provenance
    // before the flip-back. A landed save at 2028 re-stamps
    // the blob to 2028 with blank figures — the round-5 NULL
    // rule, pinned by the existing fixture's mismatch legs
    // — so no round trip, typed or loaded, can restore
    // after a landed save at the new year. The guarantee,
    // exactly as for the loaded path, is the round trip
    // with no intervening save at the new year; the edit
    // leg pins the no-re-stamp property instead. THE WORKED
    // EXAMPLE (the settlement's, engine-run): a record
    // current pool of $50,000 at 60% basis, with a 2027
    // year-to-date sale of $20,000 proceeds ($10,000 gain,
    // $10,000 basis). The 2027 load derives a $70,000
    // starting pool at 57.14%; a fresh 2028 load (2028 sale
    // $0) derives $50,000 at 60%. With the harvest on and
    // the 0% band non-binding, the flipped 2028 harvested
    // $30,002 against the fresh $20,000 — MAGI overstated
    // by the same amount, the draw sized too small by it.
    const none = {
      carryInSt: false,
      carryInLt: false,
      carryInStWa: false,
      carryInLtWa: false,
      education: false,
      balances: false,
    };
    const noEdit = { beneficiary: false, balances: false };
    const facts: DecemberRecordFacts = {
      planFirstYear: 2026,
      harvestPoolAmount: 50000,
      harvestPoolBasisPct: 60,
    };
    // TYPE the 2027 year-to-date figures and AUTOSAVE: the
    // edited branch takes the display group, so the blob
    // stamps 2027 and holds the figures.
    const storedNull2027 = decemberStoredProvenanceOf(
      defaultDecemberState(2027),
    );
    const display2027Typed = {
      ...defaultDecemberState(2027),
      ytdInterest: 1500,
      ytdOrdinaryDividends: 20000,
      ytdQualifiedDividends: 15000,
      ytdCapitalGain: 10000,
      saleBasis: 10000,
      taxableFunded: 0,
    };
    const saved2027 = decemberStateForSave(display2027Typed, storedNull2027, {
      ...noEdit,
      ytd: true,
    });
    exact(fail, "the typed 2027 save stamps 2027", decemberStoredProvenanceOf(saved2027).taxYear, 2027);
    exact(fail, "the typed 2027 save holds the interest", saved2027.ytdInterest, 1500);
    exact(fail, "the typed 2027 save holds the ordinary dividends", saved2027.ytdOrdinaryDividends, 20000);
    exact(fail, "the typed 2027 save holds the qualified dividends", saved2027.ytdQualifiedDividends, 15000);
    exact(fail, "the typed 2027 save holds the capital gain", saved2027.ytdCapitalGain, 10000);
    exact(fail, "the typed 2027 save holds the sale basis", saved2027.saleBasis, 10000);
    exact(fail, "the typed 2027 save holds the taxable cash", saved2027.taxableFunded, 0);
    const stored2027 = decemberStoredProvenanceOf(saved2027);
    exact(fail, "stored provenance holds the capital gain", stored2027.ytdCapitalGain, 10000);
    exact(fail, "stored provenance holds the sale basis", stored2027.saleBasis, 10000);
    // LOAD 2027 derives the starting pool from the 2027
    // sale: current pool plus proceeds plus funded cash,
    // with the basis % converted on the same dollars.
    const load2027 = resolveDecemberStateAtLoad({ ...saved2027 }, facts);
    exact(fail, "2027 load derives the starting pool", load2027.harvestPoolAmount, 70000);
    exact(fail, "2027 load converts the basis %", load2027.harvestPoolBasisPct, 57.14);
    // FLIP TO 2028 with the flags reset (the handler's new
    // behavior, modeled by all-false flags): the
    // year-to-date figures blank and the pool re-derives
    // from the blanked figures.
    const to2028 = reresolveDecemberStateForYear(
      { ...load2027, taxYear: 2028 },
      stored2027,
      none,
      facts,
    );
    exact(fail, "the flip blanks the interest", to2028.ytdInterest, 0);
    exact(fail, "the flip blanks the ordinary dividends", to2028.ytdOrdinaryDividends, 0);
    exact(fail, "the flip blanks the qualified dividends", to2028.ytdQualifiedDividends, 0);
    exact(fail, "the flip blanks the capital gain", to2028.ytdCapitalGain, 0);
    if (to2028.saleBasis !== null) fail("the flip must blank the sale basis");
    if (to2028.taxableFunded !== null) fail("the flip must blank the taxable cash");
    exact(fail, "the flipped pool re-derives", to2028.harvestPoolAmount, 50000);
    exact(fail, "the flipped basis % re-derives", to2028.harvestPoolBasisPct, 60);
    // FRESH 2028 LOAD agrees exactly: the flip answers as
    // a fresh load would.
    const fresh2028 = resolveDecemberStateAtLoad(
      defaultDecemberState(2028),
      facts,
    );
    exact(fail, "fresh 2028 load pool", fresh2028.harvestPoolAmount, 50000);
    exact(fail, "fresh 2028 load basis %", fresh2028.harvestPoolBasisPct, 60);
    if (to2028.harvestPoolAmount !== fresh2028.harvestPoolAmount) {
      fail("the flipped pool must equal the fresh load's pool");
    }
    if (to2028.harvestPoolBasisPct !== fresh2028.harvestPoolBasisPct) {
      fail("the flipped basis % must equal the fresh load's basis %");
    }
    // PRICING: the harvest on, low ordinary income so the
    // 0% band does not bind and the harvest is pool-limited.
    const price2028 = (s: DecemberState) => {
      const st = {
        ...s,
        agePrimary: 60,
        ageSpouse: 58,
        harvestOn: true,
        ytdOtherOrdinary: 0,
        ytdCapitalGain: 0,
        saleBasis: 0,
      };
      return pricePlaygroundYear(decemberCaseInputs(st, "likely", 0));
    };
    const flippedPrice = price2028(to2028);
    const freshPrice = price2028(fresh2028);
    exact(fail, "flipped 2028 harvested gain", flippedPrice.harvestedGain, 20000);
    exact(fail, "flipped 2028 MAGI", flippedPrice.acaMagi, 20000);
    exact(fail, "fresh 2028 harvested gain", freshPrice.harvestedGain, 20000);
    exact(fail, "fresh 2028 MAGI", freshPrice.acaMagi, 20000);
    // The STALE pool prices the defect's figures
    // (hand-built stale state: the old year's pool with the
    // new year's blanked figures).
    const stale2028 = {
      ...to2028,
      harvestPoolAmount: 70000,
      harvestPoolBasisPct: 57.14,
    };
    const stalePrice = price2028(stale2028);
    exact(fail, "stale-pool 2028 harvested gain", stalePrice.harvestedGain, 30002);
    exact(fail, "stale-pool 2028 MAGI", stalePrice.acaMagi, 30002);
    // EDIT AT 2028 (an unrelated field): the payload the
    // edit builds carries no re-stamp — it stamps 2028
    // with blank year-to-date figures, never the 2027
    // figures. (The payload is asserted, not adopted: see
    // the header comment for why a landed 2028 save ends
    // the round trip.)
    const edited2028 = { ...to2028, ytdOtherOrdinary: 900 };
    const payload2028 = decemberStateForSave(edited2028, stored2027, noEdit);
    exact(fail, "the 2028 edit's payload stamps 2028", payload2028.taxYear, 2028);
    exact(fail, "the 2028 edit must not re-stamp the 2027 interest", payload2028.ytdInterest, 0);
    exact(fail, "the 2028 edit must not re-stamp the 2027 gain", payload2028.ytdCapitalGain, 0);
    if (payload2028.saleBasis !== null) fail("the 2028 edit must not re-stamp the 2027 sale basis to 2028");
    if (payload2028.taxableFunded !== null) fail("the 2028 edit must not re-stamp the 2027 taxable cash to 2028");
    exact(fail, "the unrelated 2028 edit itself lands", payload2028.ytdOtherOrdinary, 900);
    // FLIP BACK TO 2027 (no save landed at 2028): the
    // stored figures restore exactly, and the pool
    // re-derives from them.
    const back2027 = reresolveDecemberStateForYear(
      { ...to2028, taxYear: 2027 },
      stored2027,
      none,
      facts,
    );
    exact(fail, "flipping back restores the interest", back2027.ytdInterest, 1500);
    exact(fail, "flipping back restores the ordinary dividends", back2027.ytdOrdinaryDividends, 20000);
    exact(fail, "flipping back restores the qualified dividends", back2027.ytdQualifiedDividends, 15000);
    exact(fail, "flipping back restores the capital gain", back2027.ytdCapitalGain, 10000);
    exact(fail, "flipping back restores the sale basis", back2027.saleBasis, 10000);
    exact(fail, "flipping back restores the taxable cash", back2027.taxableFunded, 0);
    exact(fail, "flipping back restores the pool", back2027.harvestPoolAmount, 70000);
    exact(fail, "flipping back restores the basis %", back2027.harvestPoolBasisPct, 57.14);
    // THE RE-SAVE of the round-tripped display against the
    // 2027 stamp holds the figures, and the re-saved blob's
    // own provenance still stamps 2027 and holds them.
    const resaved = decemberStateForSave(back2027, stored2027, noEdit);
    exact(fail, "the re-save holds the interest", resaved.ytdInterest, 1500);
    exact(fail, "the re-save holds the capital gain", resaved.ytdCapitalGain, 10000);
    exact(fail, "the re-save holds the sale basis", resaved.saleBasis, 10000);
    exact(fail, "the re-save holds the taxable cash", resaved.taxableFunded, 0);
    const resavedProv = decemberStoredProvenanceOf(resaved);
    exact(fail, "the re-saved blob stamps 2027", resavedProv.taxYear, 2027);
    exact(fail, "the re-saved blob holds the interest", resavedProv.ytdInterest, 1500);
    exact(fail, "the re-saved blob holds the capital gain", resavedProv.ytdCapitalGain, 10000);
    // RELOAD from the re-saved blob holds the figures and
    // derives the pool.
    const reloaded = resolveDecemberStateAtLoad({ ...resaved }, facts);
    exact(fail, "reload holds the capital gain", reloaded.ytdCapitalGain, 10000);
    exact(fail, "reload holds the sale basis", reloaded.saleBasis, 10000);
    exact(fail, "reload derives the starting pool", reloaded.harvestPoolAmount, 70000);
    exact(fail, "reload converts the basis %", reloaded.harvestPoolBasisPct, 57.14);
    // ORDERING (the flush must send the queued payload as
    // built): the queued payload at type time was built with
    // the OLD flag (edited=true) and holds the typed figures
    // under 2027 — while the SAME display saved after the
    // flag reset, against a stored provenance that does not
    // yet hold the figures, persists blank and the typed
    // figures are lost. That is why the handler flushes the
    // queued payload BEFORE resetting the flags.
    const queuedPayload = decemberStateForSave(display2027Typed, storedNull2027, {
      ...noEdit,
      ytd: true,
    });
    exact(fail, "the queued payload holds the typed gain", queuedPayload.ytdCapitalGain, 10000);
    exact(fail, "the queued payload holds the typed sale basis", queuedPayload.saleBasis, 10000);
    exact(fail, "the queued payload stamps 2027", queuedPayload.taxYear, 2027);
    const afterResetPayload = decemberStateForSave(display2027Typed, storedNull2027, noEdit);
    if (
      afterResetPayload.ytdCapitalGain !== 0 ||
      afterResetPayload.saleBasis !== null ||
      afterResetPayload.ytdInterest !== 0
    ) {
      fail("a save built after the flag reset, against a stored provenance without the figures, must persist blank — the typed figures are lost unless the queued payload was flushed first");
    }
    // GUARDS: a user-entered or previously saved non-null
    // pool stays across the flip, and a deliberately cleared
    // pool is never revived.
    const storedPool = decemberStoredProvenanceOf({
      ...defaultDecemberState(2027),
      harvestPoolAmount: 45000,
      harvestPoolBasisPct: 80,
    });
    const keptPool = reresolveDecemberStateForYear(
      {
        ...load2027,
        taxYear: 2028,
        harvestPoolAmount: 45000,
        harvestPoolBasisPct: 80,
      },
      storedPool,
      none,
      facts,
    );
    exact(fail, "a saved pool stays across the flip", keptPool.harvestPoolAmount, 45000);
    exact(fail, "a saved basis % stays across the flip", keptPool.harvestPoolBasisPct, 80);
    const cleared = reresolveDecemberStateForYear(
      {
        ...load2027,
        taxYear: 2028,
        harvestPoolAmount: null,
        harvestPoolBasisPct: null,
      },
      stored2027,
      none,
      facts,
    );
    if (
      cleared.harvestPoolAmount !== null ||
      cleared.harvestPoolBasisPct !== null
    ) {
      fail("a year change must not revive a deliberately cleared harvest fact");
    }
    // GUARD: a pool the user edited in this console stays,
    // even with a null stored pool.
    const typedPool = reresolveDecemberStateForYear(
      {
        ...load2027,
        taxYear: 2028,
        harvestPoolAmount: 65000,
        harvestPoolBasisPct: 70,
      },
      stored2027,
      { ...none, harvestPoolAmount: true, harvestPoolBasisPct: true },
      facts,
    );
    exact(fail, "an edited pool stays across the flip", typedPool.harvestPoolAmount, 65000);
    exact(fail, "an edited basis % stays across the flip", typedPool.harvestPoolBasisPct, 70);
  });

  run("dec-ytd-typed-sale", (fail) => {
    // (Internal review round 7, SHOULD-1 — settled STAND):
    // the console's pool fact is the STARTING pool, and the
    // shared pricer nets the year's typed sale out of it, so
    // the starting pool must already contain the sale's
    // proceeds — that is what the load derivation adds back.
    // But before this fix the pool re-derived ONLY at load
    // and at a year change: a sale typed after load left the
    // displayed pool at the load-derived value (derived with
    // the sale at $0), and the pricer netted the sale out of
    // a pool that never contained it — the available gain
    // understated by the sale's gain, exactly the S-8
    // double-netting shape, but in-session. On a household
    // year where the 0% band has room at the headline draw,
    // the console sized the draw too big by the same amount
    // and the true pricing at that draw crossed the ACA
    // cliff, forfeiting the whole year's credit. THE FIX:
    // the flip's pool re-derivation is extracted into the
    // shared pure helper rederiveHarvestPool (same gates,
    // same arithmetic), and the console's year-to-date sale,
    // sale-basis, and taxable-cash edit handlers run it over
    // the just-edited form state, writing the re-derived
    // pool and basis % back into the form — an overlay
    // re-derivation, not a user edit of the pool, so the
    // harvest edited flags stay unset and a save still
    // persists the stored pool for unedited harvest facts.
    // This fixture pins the helper's legs: a sale typed
    // in-session re-derives the pool and prices exactly as
    // the load-with-sale state does; the stale control (the
    // same typed state WITHOUT the helper) prices the
    // defect's figures; and the guards hold — an edited
    // pool stays, a stored pool stays, a cleared pool stays
    // cleared. THE WORKED EXAMPLE (the settlement's,
    // engine-run): a record current pool of $50,000 at 60%
    // basis, with a 2027 year-to-date sale of $20,000
    // proceeds ($10,000 gain, $10,000 basis).
    const facts: DecemberRecordFacts = {
      planFirstYear: 2026,
      harvestPoolAmount: 50000,
      harvestPoolBasisPct: 60,
    };
    const storedNull2027 = decemberStoredProvenanceOf(
      defaultDecemberState(2027),
    );
    const uneditedHarvest = {
      harvestPoolAmount: false,
      harvestPoolBasisPct: false,
    };
    const baseState = (
      householdSize: number,
      benchmark: number,
    ): DecemberState => ({
      ...defaultDecemberState(2027),
      agePrimary: 60,
      ageSpouse: 58,
      acaHouseholdSize: householdSize,
      acaBenchmarkAnnual: benchmark,
      bufferDollars: 5000,
      pretaxBalance: 1500000,
      pretaxBalancePrimary: 1500000,
      pretaxBalanceSpouse: 0,
      pretaxSplitExplicit: true,
      spouseSoleBeneficiary: true,
      ytdInterest: 1500,
      ytdOrdinaryDividends: 20000,
      ytdQualifiedDividends: 15000,
      ytdOtherOrdinary: 0,
      harvestOn: true,
    });
    const zeroDraw = (s: DecemberState) =>
      pricePlaygroundYear(decemberCaseInputs(s, "likely", 0));
    const headlineOf = (s: DecemberState) => {
      const p = computeDecemberProjection(s, 18000000);
      return { draw: p.headlineDraw, likely: p.cases[1]! };
    };
    // ---- Leg 1: type a sale in-session (household of 5).
    // LOAD with a $0 sale derives the record's pool as-is.
    const loaded5 = resolveDecemberStateAtLoad(baseState(5, 36000), facts);
    exact(fail, "HH5 load pool", loaded5.harvestPoolAmount, 50000);
    exact(fail, "HH5 load basis %", loaded5.harvestPoolBasisPct, 60);
    // TYPE the sale in-session: the state the console held
    // before the fix — the sale's figures with the stale,
    // load-derived pool.
    const typed5: DecemberState = {
      ...loaded5,
      ytdCapitalGain: 10000,
      saleBasis: 10000,
    };
    const stale5 = zeroDraw(typed5);
    exact(fail, "stale HH5 $0-draw harvested gain", stale5.harvestedGain, 10000);
    exact(fail, "stale HH5 $0-draw MAGI", stale5.acaMagi, 41500);
    // THE FIX: the sale edit re-derives the pool through the
    // shared helper — the starting pool now contains the
    // sale's proceeds, with the basis % converted on the
    // same dollars.
    const rederived5 = rederiveHarvestPool(
      typed5,
      storedNull2027,
      uneditedHarvest,
      facts,
    );
    exact(fail, "typed-sale pool re-derives", rederived5.harvestPoolAmount, 70000);
    exact(fail, "typed-sale basis % re-derives", rederived5.harvestPoolBasisPct, 57.14);
    // A LOAD that already carries the sale derives the same
    // pool — the in-session edit now answers as a load does.
    const loadWithSale5 = resolveDecemberStateAtLoad(
      { ...baseState(5, 36000), ytdCapitalGain: 10000, saleBasis: 10000 },
      facts,
    );
    exact(fail, "load-with-sale pool", loadWithSale5.harvestPoolAmount, 70000);
    exact(fail, "load-with-sale basis %", loadWithSale5.harvestPoolBasisPct, 57.14);
    if (rederived5.harvestPoolAmount !== loadWithSale5.harvestPoolAmount) {
      fail("the typed-sale pool must equal the load-with-sale pool");
    }
    if (rederived5.harvestPoolBasisPct !== loadWithSale5.harvestPoolBasisPct) {
      fail("the typed-sale basis % must equal the load-with-sale basis %");
    }
    // $0-DRAW PRICING of the re-derived state equals the
    // load-with-sale state's, to the figure.
    const zeroRederived5 = zeroDraw(rederived5);
    const zeroLoadSale5 = zeroDraw(loadWithSale5);
    exact(fail, "re-derived $0-draw harvested gain", zeroRederived5.harvestedGain, 20002);
    exact(fail, "re-derived $0-draw MAGI", zeroRederived5.acaMagi, 51502);
    exact(fail, "load-with-sale $0-draw harvested gain", zeroLoadSale5.harvestedGain, 20002);
    exact(fail, "load-with-sale $0-draw MAGI", zeroLoadSale5.acaMagi, 51502);
    // HEADLINE: at this household's draw the 0% band binds
    // (harvest $0), so the headline figures agree too.
    const headRederived5 = headlineOf(rederived5);
    const headLoadSale5 = headlineOf(loadWithSale5);
    exact(fail, "re-derived headline draw", headRederived5.draw, 118220);
    exact(fail, "re-derived MAGI at headline", headRederived5.likely.magiAtHeadline, 149720);
    exact(fail, "re-derived credit at headline", headRederived5.likely.creditAtHeadline, 20698.62);
    exact(fail, "re-derived harvest at headline", headRederived5.likely.harvestedGainAtHeadline, 0);
    exact(fail, "load-with-sale headline draw", headLoadSale5.draw, 118220);
    exact(fail, "load-with-sale MAGI at headline", headLoadSale5.likely.magiAtHeadline, 149720);
    exact(fail, "load-with-sale credit at headline", headLoadSale5.likely.creditAtHeadline, 20698.62);
    exact(fail, "load-with-sale harvest at headline", headLoadSale5.likely.harvestedGainAtHeadline, 0);
    // ---- Leg 2: the draw/cliff leg (household of 2). The
    // band has room at the headline here, so the stale pool
    // oversizes the draw by the sale's gain and the true
    // pricing at that draw forfeits the year's credit.
    const loaded2 = resolveDecemberStateAtLoad(baseState(2, 25000), facts);
    const typed2: DecemberState = {
      ...loaded2,
      ytdCapitalGain: 10000,
      saleBasis: 10000,
    };
    const rederived2 = rederiveHarvestPool(
      typed2,
      storedNull2027,
      uneditedHarvest,
      facts,
    );
    exact(fail, "HH2 typed-sale pool re-derives", rederived2.harvestPoolAmount, 70000);
    exact(fail, "HH2 typed-sale basis % re-derives", rederived2.harvestPoolBasisPct, 57.14);
    const headTyped2 = headlineOf(rederived2);
    exact(fail, "HH2 typed headline draw", headTyped2.draw, 30058);
    exact(fail, "HH2 typed MAGI at headline", headTyped2.likely.magiAtHeadline, 81560);
    exact(fail, "HH2 typed credit at headline", headTyped2.likely.creditAtHeadline, 16664.57);
    exact(fail, "HH2 typed harvest at headline", headTyped2.likely.harvestedGainAtHeadline, 20002);
    // TRUE PRICING at the typed draw keeps the credit.
    const trueAtTyped2 = pricePlaygroundYear(
      decemberCaseInputs(rederived2, "likely", headTyped2.draw ?? 0),
    );
    exact(fail, "true MAGI at the typed draw", trueAtTyped2.acaMagi, 81560);
    if (trueAtTyped2.aca.overCliff) fail("true pricing at the typed draw must keep the credit");
    exact(fail, "true credit at the typed draw", trueAtTyped2.aca.credit, 16664.57);
    // STALE CONTROL: the same typed state without the
    // helper sizes the draw too big by exactly the
    // understatement, and true pricing at that draw crosses
    // the cliff — the whole year's credit gone.
    const headStale2 = headlineOf(typed2);
    exact(fail, "HH2 stale headline draw", headStale2.draw, 40060);
    exact(fail, "HH2 stale draw overshoot", (headStale2.draw ?? 0) - (headTyped2.draw ?? 0), 10002);
    const trueAtStale2 = pricePlaygroundYear(
      decemberCaseInputs(rederived2, "likely", headStale2.draw ?? 0),
    );
    exact(fail, "true MAGI at the stale draw", trueAtStale2.acaMagi, 91562);
    if (!trueAtStale2.aca.overCliff) fail("true pricing at the stale draw must cross the cliff");
    exact(fail, "true credit at the stale draw", trueAtStale2.aca.credit, 0);
    // ---- Leg 3: a LOSS sale typed in-session (household
    // of 2). Proceeds are gain plus basis, so the loss
    // sale's smaller proceeds still add back into the
    // starting pool, and the basis % converts against them.
    const loadedLoss = resolveDecemberStateAtLoad(baseState(2, 25000), facts);
    const typedLoss: DecemberState = {
      ...loadedLoss,
      ytdCapitalGain: -5000,
      saleBasis: 20000,
    };
    const rederivedLoss = rederiveHarvestPool(
      typedLoss,
      storedNull2027,
      uneditedHarvest,
      facts,
    );
    exact(fail, "loss-sale pool re-derives", rederivedLoss.harvestPoolAmount, 65000);
    exact(fail, "loss-sale basis % re-derives", rederivedLoss.harvestPoolBasisPct, 76.92);
    const zeroLoss = zeroDraw(rederivedLoss);
    exact(fail, "loss re-derived $0-draw harvested gain", zeroLoss.harvestedGain, 20002);
    exact(fail, "loss re-derived $0-draw MAGI", zeroLoss.acaMagi, 36502);
    const zeroLossStale = zeroDraw(typedLoss);
    exact(fail, "loss stale $0-draw harvested gain", zeroLossStale.harvestedGain, 25000);
    exact(fail, "loss stale $0-draw MAGI", zeroLossStale.acaMagi, 41500);
    // ---- Leg 4: taxable funded cash rides along in the
    // same re-derivation (household of 5): the shared
    // derivation takes the whole state, so typing the cash
    // beside the sale re-derives the pool with both
    // add-backs — the cash at 100% basis, so the basis %
    // converts back to the record's own.
    const typedFunded: DecemberState = {
      ...loaded5,
      ytdCapitalGain: 10000,
      saleBasis: 10000,
      taxableFunded: 5000,
    };
    const rederivedFunded = rederiveHarvestPool(
      typedFunded,
      storedNull2027,
      uneditedHarvest,
      facts,
    );
    exact(fail, "funded pool re-derives", rederivedFunded.harvestPoolAmount, 75000);
    exact(fail, "funded basis % re-derives", rederivedFunded.harvestPoolBasisPct, 60);
    const zeroFunded = zeroDraw(rederivedFunded);
    exact(fail, "funded $0-draw harvested gain", zeroFunded.harvestedGain, 20000);
    exact(fail, "funded $0-draw MAGI", zeroFunded.acaMagi, 51500);
    // ---- Leg 5: the guards. A pool the user edited in
    // this console is theirs — a sale edit never re-derives
    // over it.
    const editedGuard = rederiveHarvestPool(
      typed5,
      storedNull2027,
      { harvestPoolAmount: true, harvestPoolBasisPct: true },
      facts,
    );
    exact(fail, "an edited pool stays on a sale edit", editedGuard.harvestPoolAmount, 50000);
    exact(fail, "an edited basis % stays on a sale edit", editedGuard.harvestPoolBasisPct, 60);
    // A stored non-null pool is the console's own saved
    // answer — it stays too.
    const storedPoolProv = decemberStoredProvenanceOf({
      ...defaultDecemberState(2027),
      harvestPoolAmount: 45000,
      harvestPoolBasisPct: 80,
    });
    const storedGuard = rederiveHarvestPool(
      { ...typed5, harvestPoolAmount: 45000, harvestPoolBasisPct: 80 },
      storedPoolProv,
      uneditedHarvest,
      facts,
    );
    exact(fail, "a stored pool stays on a sale edit", storedGuard.harvestPoolAmount, 45000);
    exact(fail, "a stored basis % stays on a sale edit", storedGuard.harvestPoolBasisPct, 80);
    // A deliberately cleared pool is never revived by a
    // sale edit.
    const clearedGuard = rederiveHarvestPool(
      {
        ...typed5,
        harvestPoolAmount: null,
        harvestPoolBasisPct: null,
      },
      storedNull2027,
      uneditedHarvest,
      facts,
    );
    if (
      clearedGuard.harvestPoolAmount !== null ||
      clearedGuard.harvestPoolBasisPct !== null
    ) {
      fail("a sale edit must not revive a deliberately cleared harvest fact");
    }
  });

  /* ---- Build v112 fixtures: character splits on the
     two strays (round-17 F4 + F5) ----
     F4: Schedule K-1 box 9a net long-term capital gain
     retains long-term character on the partner's return —
     before v112 the whole signed K-1 amount rode other
     ordinary income, so a box 9a gain priced at ordinary
     rates. F5: a return-of-capital amount reclassified
     as a dividend can itself be a qualified dividend
     (Form 1099-DIV box 1b, a subset of box 1a) — before
     v112 the reclassified amount rode only the ordinary-
     dividends total, with no qualified companion (the
     January-paid stray has had one since its split), so
     its qualified part priced at ordinary rates. Both
     fixes follow the v104 field shape: a top-level
     non-negative portion field, clamped in the assembly,
     $0 / absent pricing bit-identically to before. */

  run("dec-k1-capgain-acceptance", (fail) => {
    // The settlement's F4 example: 2026 MFJ, $110,000 of
    // ordinary income plus a $10,000 K-1 amount that is
    // entirely a box 9a long-term capital gain.
    // · Before the fix (no portion entered): AGI
    //   $120,000, taxable $87,800, federal tax 10% ×
    //   $24,800 + 12% × $63,000 = $10,040.00.
    // · After: the $10,000 rides the gains stack —
    //   ordinary taxable $77,800 → $8,840.00, and the
    //   gain sits inside the 0% band (total taxable
    //   $87,800 < $98,900) → $0 gains tax → $8,840.00.
    // The overstatement corrected is $1,200.00.
    const before = base();
    before.ytdOtherOrdinary = 110000;
    before.strayK1 = { status: "amount", amount: 10000 };
    const beforeInputs = decemberCaseInputs(before, "likely", 0);
    exact(fail, "before: whole K-1 in ordinary income", beforeInputs.otherOrdinary, 120000);
    exact(fail, "before: no gain on the stock dials", beforeInputs.stockSold, 0);
    exact(
      fail,
      "before federal tax (the corrected error)",
      pricePlaygroundYear(beforeInputs).federalTax,
      10040,
    );
    const fixed = base();
    fixed.ytdOtherOrdinary = 110000;
    fixed.strayK1 = { status: "amount", amount: 10000 };
    fixed.strayK1CapGainAmount = 10000;
    const fixedInputs = decemberCaseInputs(fixed, "likely", 0);
    exact(fail, "gain portion leaves ordinary income", fixedInputs.otherOrdinary, 110000);
    exact(fail, "gain portion rides the stock dials", fixedInputs.stockSold, 10000);
    exact(fail, "gain portion basis", fixedInputs.stockBasis, 0);
    const fixedPg = pricePlaygroundYear(fixedInputs);
    exact(fail, "federal tax after fix", fixedPg.federalTax, 8840);
    exact(fail, "AGI counts the K-1 once", fixedPg.agi, 120000);
    exact(
      fail,
      "overstatement corrected",
      r2(pricePlaygroundYear(beforeInputs).federalTax - fixedPg.federalTax),
      1200,
    );
    // A PARTIAL portion splits: $4,000 of a $10,000 K-1
    // amount as box 9a gain leaves $6,000 ordinary.
    const partial = base();
    partial.ytdOtherOrdinary = 110000;
    partial.strayK1 = { status: "amount", amount: 10000 };
    partial.strayK1CapGainAmount = 4000;
    const partialInputs = decemberCaseInputs(partial, "likely", 0);
    exact(fail, "partial: ordinary keeps the rest", partialInputs.otherOrdinary, 116000);
    exact(fail, "partial: gain dial carries the portion", partialInputs.stockSold, 4000);
  });

  run("dec-roc-qualified-acceptance", (fail) => {
    // The settlement's F5 example: 2026 MFJ, $110,000 of
    // ordinary income plus a $10,000 return-of-capital
    // amount reclassified as an ordinary dividend that is
    // entirely qualified.
    // · Before the fix (no qualified portion): the
    //   $10,000 prices as a non-qualified ordinary
    //   dividend → federal tax $10,040.00 (same stack as
    //   the F4 control).
    // · After: the $10,000 is a qualified dividend —
    //   ordinary taxable $77,800 → $8,840.00, the
    //   qualified amount sits inside the 0% band → $0
    //   preferential tax → $8,840.00.
    // The overstatement corrected is $1,200.00.
    const before = base();
    before.ytdOtherOrdinary = 110000;
    before.strayROCOrdinary = { status: "amount", amount: 10000 };
    const beforeInputs = decemberCaseInputs(before, "likely", 0);
    exact(fail, "before: reclassified amount in ordinary dividends", beforeInputs.ordinaryDividends, 10000);
    exact(fail, "before: nothing qualified", beforeInputs.qualifiedDividends, 0);
    exact(
      fail,
      "before federal tax (the corrected error)",
      pricePlaygroundYear(beforeInputs).federalTax,
      10040,
    );
    const fixed = base();
    fixed.ytdOtherOrdinary = 110000;
    fixed.strayROCOrdinary = { status: "amount", amount: 10000 };
    fixed.strayROCQualifiedAmount = 10000;
    const fixedInputs = decemberCaseInputs(fixed, "likely", 0);
    exact(fail, "whole amount stays in ordinary dividends", fixedInputs.ordinaryDividends, 10000);
    exact(fail, "qualified portion rides the qualified total", fixedInputs.qualifiedDividends, 10000);
    const fixedPg = pricePlaygroundYear(fixedInputs);
    exact(fail, "federal tax after fix", fixedPg.federalTax, 8840);
    exact(fail, "AGI counts the dividend once", fixedPg.agi, 120000);
    exact(
      fail,
      "overstatement corrected",
      r2(pricePlaygroundYear(beforeInputs).federalTax - fixedPg.federalTax),
      1200,
    );
  });

  run("dec-k1-capgain-zero-identity", (fail) => {
    // The $0-portion identity: a K-1 amount with a $0 (or
    // absent) capital-gain portion prices BIT-IDENTICALLY
    // to before v112 — the figures pinned here are the
    // pre-fix figures (the F4 control stack: $110,000 of
    // ordinary income plus a $10,000 K-1 amount →
    // $10,040.00).
    const zero = base();
    zero.ytdOtherOrdinary = 110000;
    zero.strayK1 = { status: "amount", amount: 10000 };
    zero.strayK1CapGainAmount = 0;
    const zeroInputs = decemberCaseInputs(zero, "likely", 0);
    exact(fail, "$0 portion: whole K-1 in ordinary income", zeroInputs.otherOrdinary, 120000);
    exact(fail, "$0 portion: no gain on the stock dials", zeroInputs.stockSold, 0);
    exact(
      fail,
      "$0 portion federal tax (pre-fix figure)",
      pricePlaygroundYear(zeroInputs).federalTax,
      10040,
    );
    // Back-compat: a blob written before the field existed
    // parses the portion as $0, the default state carries
    // $0, the writer schema accepts the state, and an
    // entered portion round-trips through the saved blob.
    const legacy = parseDecemberState(
      JSON.stringify({
        taxYear: 2026,
        strayK1: { status: "amount", amount: 10000 },
      }),
      2026,
    );
    if (legacy.strayK1CapGainAmount !== 0) {
      fail("a legacy blob should parse the K-1 capital-gain portion as $0");
    }
    const legacyWithIncome: DecemberState = {
      ...legacy,
      ytdOtherOrdinary: 110000,
    };
    exact(
      fail,
      "legacy blob federal tax (pre-fix figure)",
      pricePlaygroundYear(decemberCaseInputs(legacyWithIncome, "likely", 0)).federalTax,
      10040,
    );
    if (defaultDecemberState(2026).strayK1CapGainAmount !== 0) {
      fail("the default state should carry a $0 K-1 capital-gain portion");
    }
    if (!decemberState.safeParse(zero).success) {
      fail("the writer schema should accept a $0 K-1 capital-gain portion");
    }
    const entered = base();
    entered.strayK1 = { status: "amount", amount: 10000 };
    entered.strayK1CapGainAmount = 3500;
    const back = parseDecemberState(serializeDecemberState(entered, 2), 2026);
    if (back.strayK1CapGainAmount !== 3500) {
      fail("an entered K-1 capital-gain portion should round-trip through the saved blob");
    }
  });

  run("dec-roc-qualified-zero-identity", (fail) => {
    // The $0-portion identity for F5: a reclassified ROC
    // amount with a $0 (or absent) qualified portion
    // prices BIT-IDENTICALLY to before v112 — the figures
    // pinned here are the pre-fix figures (the F5 control
    // stack: $110,000 of ordinary income plus a $10,000
    // reclassified dividend → $10,040.00).
    const zero = base();
    zero.ytdOtherOrdinary = 110000;
    zero.strayROCOrdinary = { status: "amount", amount: 10000 };
    zero.strayROCQualifiedAmount = 0;
    const zeroInputs = decemberCaseInputs(zero, "likely", 0);
    exact(fail, "$0 portion: amount in ordinary dividends", zeroInputs.ordinaryDividends, 10000);
    exact(fail, "$0 portion: nothing qualified", zeroInputs.qualifiedDividends, 0);
    exact(
      fail,
      "$0 portion federal tax (pre-fix figure)",
      pricePlaygroundYear(zeroInputs).federalTax,
      10040,
    );
    const legacy = parseDecemberState(
      JSON.stringify({
        taxYear: 2026,
        strayROCOrdinary: { status: "amount", amount: 10000 },
      }),
      2026,
    );
    if (legacy.strayROCQualifiedAmount !== 0) {
      fail("a legacy blob should parse the ROC qualified portion as $0");
    }
    const legacyWithIncome: DecemberState = {
      ...legacy,
      ytdOtherOrdinary: 110000,
    };
    exact(
      fail,
      "legacy blob federal tax (pre-fix figure)",
      pricePlaygroundYear(decemberCaseInputs(legacyWithIncome, "likely", 0)).federalTax,
      10040,
    );
    if (defaultDecemberState(2026).strayROCQualifiedAmount !== 0) {
      fail("the default state should carry a $0 ROC qualified portion");
    }
    if (!decemberState.safeParse(zero).success) {
      fail("the writer schema should accept a $0 ROC qualified portion");
    }
    const entered = base();
    entered.strayROCOrdinary = { status: "amount", amount: 10000 };
    entered.strayROCQualifiedAmount = 2500;
    const back = parseDecemberState(serializeDecemberState(entered, 2), 2026);
    if (back.strayROCQualifiedAmount !== 2500) {
      fail("an entered ROC qualified portion should round-trip through the saved blob");
    }
  });

  run("dec-stray-character-combined-no-double-count", (fail) => {
    // Both splits together on one year: $110,000 of
    // ordinary income, a $10,000 K-1 amount entirely box
    // 9a gain, and a $10,000 reclassified ROC dividend
    // entirely qualified. No double-count at the dial
    // level: the K-1 total leaves ordinary income exactly
    // once (it is on the gain dial instead), the ROC
    // total is in ordinary dividends once with its
    // qualified subset marked, and the priced AGI counts
    // each total once — $110,000 + $10,000 + $10,000 =
    // $130,000. End to end: taxable $97,800; ordinary
    // taxable $97,800 − ($10,000 gain + $10,000 qualified)
    // = $77,800 → $8,840.00; the $20,000 preferential
    // stack fits the 0% room ($98,900 − $77,800 =
    // $21,100) → $0 → federal tax $8,840.00.
    const s = base();
    s.ytdOtherOrdinary = 110000;
    s.strayK1 = { status: "amount", amount: 10000 };
    s.strayK1CapGainAmount = 10000;
    s.strayROCOrdinary = { status: "amount", amount: 10000 };
    s.strayROCQualifiedAmount = 10000;
    const inputs = decemberCaseInputs(s, "likely", 0);
    exact(fail, "ordinary income excludes the K-1 gain portion", inputs.otherOrdinary, 110000);
    exact(fail, "gain dial carries the K-1 portion", inputs.stockSold, 10000);
    exact(fail, "ordinary dividends carry the ROC total once", inputs.ordinaryDividends, 10000);
    exact(fail, "qualified total carries the ROC portion", inputs.qualifiedDividends, 10000);
    const pg = pricePlaygroundYear(inputs);
    exact(fail, "combined AGI counts each total once", pg.agi, 130000);
    exact(fail, "combined federal tax", pg.federalTax, 8840);
  });

  run("dec-stray-character-clamps", (fail) => {
    // Clamps: a portion entered above its stray's total
    // clamps to the total, never an amount on top of it.
    const overK1 = base();
    overK1.ytdOtherOrdinary = 110000;
    overK1.strayK1 = { status: "amount", amount: 10000 };
    overK1.strayK1CapGainAmount = 25000;
    const overK1Inputs = decemberCaseInputs(overK1, "likely", 0);
    exact(fail, "over-entered K-1 portion clamps to the total", overK1Inputs.stockSold, 10000);
    exact(fail, "fully-gain K-1 leaves no K-1 ordinary", overK1Inputs.otherOrdinary, 110000);
    exact(
      fail,
      "clamped K-1 federal tax",
      pricePlaygroundYear(overK1Inputs).federalTax,
      8840,
    );
    const overRoc = base();
    overRoc.ytdOtherOrdinary = 110000;
    overRoc.strayROCOrdinary = { status: "amount", amount: 10000 };
    overRoc.strayROCQualifiedAmount = 25000;
    const overRocInputs = decemberCaseInputs(overRoc, "likely", 0);
    exact(fail, "over-entered ROC portion clamps to the total", overRocInputs.qualifiedDividends, 10000);
    exact(fail, "ROC total still counted once", overRocInputs.ordinaryDividends, 10000);
    exact(
      fail,
      "clamped ROC federal tax",
      pricePlaygroundYear(overRocInputs).federalTax,
      8840,
    );
    // A deductible K-1 LOSS has no gain portion: with a
    // negative K-1 total the portion field is inert and
    // the loss reduces ordinary income whole, exactly as
    // before this build.
    const loss = base();
    loss.ytdOtherOrdinary = 110000;
    loss.strayK1 = { status: "amount", amount: -10000 };
    loss.strayK1CapGainAmount = 5000;
    const lossInputs = decemberCaseInputs(loss, "likely", 0);
    exact(fail, "K-1 loss reduces ordinary income whole", lossInputs.otherOrdinary, 100000);
    exact(fail, "K-1 loss puts nothing on the gain dials", lossInputs.stockSold, 0);
  });

  run("dec-stray-portion-clamp-warnings-n6", (fail) => {
    // Re-audit NICE-TO-HAVE N-6: each stray-portion trim
    // above now WARNS, naming the portion, its entered
    // figure, the limit it was trimmed to fit, the amount
    // trimmed, and the figure it prices as — the S-8
    // dividend-pair warning's spirit. Pricing is the
    // pre-fix clamped pricing throughout (the clamp checks
    // in dec-stray-character-clamps and
    // dec-jan-paid-capgain-combined-no-double-count stand).
    const trimWarnings = (s: DecemberState) =>
      computeDecemberProjection(s).warnings.filter((w) =>
        w.includes("is trimmed"),
      );
    // K-1 portion over its total: entered $25,000 against
    // a $10,000 total — $15,000 trimmed, prices as $10,000.
    const overK1 = base();
    overK1.strayK1 = { status: "amount", amount: 10000 };
    overK1.strayK1CapGainAmount = 25000;
    const k1Warnings = trimWarnings(overK1);
    if (k1Warnings.length !== 1) {
      fail(`K-1 trim: exactly one trim warning expected, got ${k1Warnings.length}`);
    }
    if (
      !k1Warnings.some(
        (w) =>
          w.includes("K-1 income: the long-term capital gain portion (box 9a) ($25,000)") &&
          w.includes("K-1 total ($10,000)") &&
          w.includes("$15,000 is trimmed") &&
          w.includes("prices as $10,000"),
      )
    ) {
      fail(`K-1 trim: warning should name the portion, its figures, and the trim, got: ${JSON.stringify(k1Warnings)}`);
    }
    // ROC qualified portion over its total: entered
    // $25,000 against a $10,000 reclassified total.
    const overRoc = base();
    overRoc.strayROCOrdinary = { status: "amount", amount: 10000 };
    overRoc.strayROCQualifiedAmount = 25000;
    const rocWarnings = trimWarnings(overRoc);
    if (rocWarnings.length !== 1) {
      fail(`ROC trim: exactly one trim warning expected, got ${rocWarnings.length}`);
    }
    if (
      !rocWarnings.some(
        (w) =>
          w.includes("qualified-dividends portion of the reclassified amount ($25,000)") &&
          w.includes("reclassified ordinary-dividend total ($10,000)") &&
          w.includes("$15,000 is trimmed") &&
          w.includes("prices as $10,000"),
      )
    ) {
      fail(`ROC trim: warning should name the portion, its figures, and the trim, got: ${JSON.stringify(rocWarnings)}`);
    }
    // January-paid capital-gain portion over its total
    // (the overCap shape): entered $25,000 against a
    // $20,000 total trims $5,000; the clamped portion then
    // leaves a $0 ordinary remainder, so the $20,000
    // qualified portion entered beside it trims whole —
    // two warnings, each with its own limit and trim.
    const overCap = base();
    overCap.strayJanPaid = { status: "amount", amount: 20000 };
    overCap.strayJanPaidCapGainAmount = 25000;
    overCap.strayJanPaidQualifiedAmount = 20000;
    const capWarnings = trimWarnings(overCap);
    if (capWarnings.length !== 2) {
      fail(`January-paid over-cap: exactly two trim warnings expected, got ${capWarnings.length}`);
    }
    if (
      !capWarnings.some(
        (w) =>
          w.includes("the capital-gain portion ($25,000)") &&
          w.includes("January-paid total ($20,000)") &&
          w.includes("$5,000 is trimmed") &&
          w.includes("prices as $20,000"),
      )
    ) {
      fail(`January-paid over-cap: capital-gain warning should name its figures and trim, got: ${JSON.stringify(capWarnings)}`);
    }
    if (
      !capWarnings.some(
        (w) =>
          w.includes("the qualified-dividends portion ($20,000)") &&
          w.includes("ordinary remainder ($0)") &&
          w.includes("$20,000 is trimmed") &&
          w.includes("prices as $0"),
      )
    ) {
      fail(`January-paid over-cap: qualified warning should name the $0 remainder and its whole trim, got: ${JSON.stringify(capWarnings)}`);
    }
    // January-paid qualified portion over the ordinary
    // REMAINDER only (the overQual shape): total $20,000
    // less a valid $15,000 capital-gain portion leaves a
    // $5,000 remainder; the $20,000 qualified entry trims
    // $15,000 to it, and the valid capital-gain portion
    // warns nowhere.
    const overQual = base();
    overQual.strayJanPaid = { status: "amount", amount: 20000 };
    overQual.strayJanPaidCapGainAmount = 15000;
    overQual.strayJanPaidQualifiedAmount = 20000;
    const qualWarnings = trimWarnings(overQual);
    if (qualWarnings.length !== 1) {
      fail(`January-paid over-qualified: exactly one trim warning expected, got ${qualWarnings.length}`);
    }
    if (
      !qualWarnings.some(
        (w) =>
          w.includes("the qualified-dividends portion ($20,000)") &&
          w.includes("ordinary remainder ($5,000)") &&
          w.includes("$15,000 is trimmed") &&
          w.includes("prices as $5,000"),
      )
    ) {
      fail(`January-paid over-qualified: warning should name the remainder, its figures, and the trim, got: ${JSON.stringify(qualWarnings)}`);
    }
    // A K-1 LOSS has no gain portion: the $5,000 portion
    // entered beside a −$10,000 total trims whole.
    const loss = base();
    loss.strayK1 = { status: "amount", amount: -10000 };
    loss.strayK1CapGainAmount = 5000;
    const lossWarnings = trimWarnings(loss);
    if (lossWarnings.length !== 1) {
      fail(`K-1 loss: exactly one trim warning expected, got ${lossWarnings.length}`);
    }
    if (
      !lossWarnings.some(
        (w) =>
          w.includes("the long-term capital gain portion (box 9a) ($5,000)") &&
          w.includes("is not positive") &&
          w.includes("the whole $5,000 is trimmed") &&
          w.includes("prices as $0"),
      )
    ) {
      fail(`K-1 loss: warning should name the inert portion and its whole trim, got: ${JSON.stringify(lossWarnings)}`);
    }
    // No trim, no warning: every portion at or below its
    // limit — including portions exactly AT their limit —
    // prices as entered and warns nowhere.
    const clean = base();
    clean.strayK1 = { status: "amount", amount: 10000 };
    clean.strayK1CapGainAmount = 10000;
    clean.strayROCOrdinary = { status: "amount", amount: 10000 };
    clean.strayROCQualifiedAmount = 4000;
    clean.strayJanPaid = { status: "amount", amount: 20000 };
    clean.strayJanPaidCapGainAmount = 5000;
    clean.strayJanPaidQualifiedAmount = 15000;
    const cleanWarnings = trimWarnings(clean);
    if (cleanWarnings.length !== 0) {
      fail(`no-trim control: no trim warning expected, got: ${JSON.stringify(cleanWarnings)}`);
    }
  });

  /* ---- Build v113 fixtures: the gain harvest
     (round-17 F3) ----
     The plan march harvests after settlement when its
     gainsHarvest toggle is on (taxEngine's harvestOn gate);
     the console now carries the same model: a toggle plus
     the pool / blended-basis facts, sized inside
     pricePlaygroundYear by the march's own rule — the
     largest gain, capped by the pool's unrealized gain,
     that stays inside the 0% band. */

  run("dec-harvest-f3-acceptance", (fail) => {
    // The settlement's worked example: 2026 MFJ, ages
    // 60/58, $65,000 ordinary income, a $40,000 taxable
    // pool at 75% basis (unrealized gain $10,000), $20,000
    // benchmark, $10,000 APTC. The 0% room is $98,900 −
    // $32,800 ordinary taxable = $66,100, so the full
    // $10,000 harvests: MAGI rises $65,000 → $75,000, the
    // credit falls by 9.96% × $10,000 = $996, the federal
    // tax is unchanged (the gain sits in the 0% band), and
    // the settlement at a $0 draw moves from an $86 refund
    // to $910 payable.
    const on = base();
    on.ytdOtherOrdinary = 65000;
    on.aptcTaken = 10000;
    on.harvestOn = true;
    on.harvestPoolAmount = 40000;
    on.harvestPoolBasisPct = 75;
    const pgOn = pricePlaygroundYear(decemberCaseInputs(on, "likely", 0));
    exact(fail, "harvested gain", pgOn.harvestedGain, 10000);
    exact(fail, "ACA MAGI with harvest", pgOn.acaMagi, 75000);
    exact(fail, "credit with harvest", pgOn.aca.credit, 12530);
    exact(fail, "federal tax unchanged by harvest", pgOn.federalTax, 3440);
    exact(
      fail,
      "settlement at $0 draw with harvest",
      r2(pgOn.federalTax - (pgOn.aca.credit ?? 0) + on.aptcTaken),
      910,
    );
    const off = base();
    off.ytdOtherOrdinary = 65000;
    off.aptcTaken = 10000;
    const pgOff = pricePlaygroundYear(decemberCaseInputs(off, "likely", 0));
    exact(fail, "no harvested gain when off", pgOff.harvestedGain, 0);
    exact(fail, "ACA MAGI without harvest", pgOff.acaMagi, 65000);
    exact(fail, "credit without harvest", pgOff.aca.credit, 13526);
    exact(fail, "federal tax without harvest", pgOff.federalTax, 3440);
    exact(
      fail,
      "settlement at $0 draw without harvest",
      r2(pgOff.federalTax - (pgOff.aca.credit ?? 0) + off.aptcTaken),
      -86,
    );
    // Headline consistency: the solved draw is sized WITH
    // the harvest included — with the cliff target binding
    // it shrinks by the harvested gain ($14,600 off →
    // $4,600 on), and each case names its harvested gain.
    const projOn = computeDecemberProjection(on);
    const projOff = computeDecemberProjection(off);
    near(fail, "headline draw without harvest", projOff.headlineDraw, 14600);
    near(fail, "headline draw with harvest", projOn.headlineDraw, 4600);
    const likelyOn = projOn.cases[1]!;
    exact(fail, "case harvested gain at $0 draw", likelyOn.harvestedGainAtZeroDraw, 10000);
    exact(fail, "case harvested gain at headline", likelyOn.harvestedGainAtHeadline, 10000);
    near(fail, "MAGI at headline with harvest", likelyOn.magiAtHeadline, 79600);
    if (likelyOn.gainHarvestUnpriced) {
      fail("a fully-facted harvest must not carry the unpriced qualification");
    }
  });

  run("dec-harvest-remaining-pool-acceptance", (fail) => {
    // Round-17 defect 1: the harvest sizes from the
    // REMAINING pool, not the starting pool. The
    // settlement's worked example: 2026 MFJ, ages 60/58,
    // $65,000 ordinary income, a $40,000 taxable pool at
    // 75% basis ($10,000 unrealized), $5,860 of the year's
    // own gains already realized from a sale with $17,580
    // of basis (proceeds $23,440). The sales already
    // realized $5,860 of the pool's gain, so only $4,140
    // is left to harvest — the starting pool would wrongly
    // harvest the full $10,000 (MAGI $80,860, credit
    // $11,946.34, $583.66 of credit lost). The 0% room is
    // $98,900 − $32,800 ordinary taxable = $66,100, so the
    // remaining $4,140 fits whole: MAGI $75,000, credit
    // $12,530, federal tax $3,440 (the gain sits in the 0%
    // band, exactly as the no-sales F3 case).
    const entered = base();
    entered.ytdOtherOrdinary = 65000;
    entered.ytdCapitalGain = 5860;
    entered.saleBasis = 17580;
    entered.aptcTaken = 10000;
    entered.harvestOn = true;
    entered.harvestPoolAmount = 40000;
    entered.harvestPoolBasisPct = 75;
    const pgEntered = pricePlaygroundYear(
      decemberCaseInputs(entered, "likely", 0),
    );
    exact(fail, "harvested gain from the remaining pool", pgEntered.harvestedGain, 4140);
    exact(fail, "ACA MAGI with the remaining-pool harvest", pgEntered.acaMagi, 75000);
    exact(fail, "credit with the remaining-pool harvest", pgEntered.aca.credit, 12530);
    exact(fail, "federal tax with the remaining-pool harvest", pgEntered.federalTax, 3440);
    // The same sale WITHOUT an entered basis: the gain
    // alone rides (proceeds $5,860, basis $0), so the
    // remaining pool is $34,140 at $30,000 basis — the
    // remaining unrealized gain is still exactly $4,140.
    const gainOnly = base();
    gainOnly.ytdOtherOrdinary = 65000;
    gainOnly.ytdCapitalGain = 5860;
    gainOnly.aptcTaken = 10000;
    gainOnly.harvestOn = true;
    gainOnly.harvestPoolAmount = 40000;
    gainOnly.harvestPoolBasisPct = 75;
    const pgGainOnly = pricePlaygroundYear(
      decemberCaseInputs(gainOnly, "likely", 0),
    );
    exact(fail, "harvested gain without an entered sale basis", pgGainOnly.harvestedGain, 4140);
    exact(fail, "ACA MAGI without an entered sale basis", pgGainOnly.acaMagi, 75000);
    exact(fail, "credit without an entered sale basis", pgGainOnly.aca.credit, 12530);
    // A depleted pool prices a $0 harvest (a fact, never
    // unpriced): the year's sale took the whole $40,000
    // pool (proceeds $40,000 = $10,000 gain + $30,000
    // basis), so nothing is left to harvest from.
    const depleted = base();
    depleted.ytdOtherOrdinary = 65000;
    depleted.ytdCapitalGain = 10000;
    depleted.saleBasis = 30000;
    depleted.aptcTaken = 10000;
    depleted.harvestOn = true;
    depleted.harvestPoolAmount = 40000;
    depleted.harvestPoolBasisPct = 75;
    const pgDepleted = pricePlaygroundYear(
      decemberCaseInputs(depleted, "likely", 0),
    );
    exact(fail, "depleted pool harvests $0", pgDepleted.harvestedGain, 0);
    exact(fail, "ACA MAGI with a depleted pool", pgDepleted.acaMagi, 75000);
    exact(fail, "credit with a depleted pool", pgDepleted.aca.credit, 12530);
    exact(fail, "federal tax with a depleted pool", pgDepleted.federalTax, 3440);
    if (computeDecemberProjection(depleted).cases[1]!.gainHarvestUnpriced) {
      fail("a fully-facted depleted pool must not carry the unpriced qualification");
    }
    // 100%-basis taxable cash does not shrink the
    // harvestable gain: $10,000 of taxable funding sells
    // pool and basis equally, so the remaining unrealized
    // gain is still $4,140.
    const funded = base();
    funded.ytdOtherOrdinary = 65000;
    funded.ytdCapitalGain = 5860;
    funded.saleBasis = 17580;
    funded.taxableFunded = 10000;
    funded.aptcTaken = 10000;
    funded.harvestOn = true;
    funded.harvestPoolAmount = 40000;
    funded.harvestPoolBasisPct = 75;
    const pgFunded = pricePlaygroundYear(
      decemberCaseInputs(funded, "likely", 0),
    );
    exact(fail, "harvested gain with 100%-basis taxable funding", pgFunded.harvestedGain, 4140);
    exact(fail, "ACA MAGI with 100%-basis taxable funding", pgFunded.acaMagi, 75000);
  });

  run("dec-harvest-off-identity", (fail) => {
    // Harvest OFF (the default) prices bit-identically to
    // before this build — including when the pool facts
    // are entered but the toggle is off (the facts are
    // dormant: decemberCaseInputs passes the dials absent).
    const plain = base();
    plain.ytdOtherOrdinary = 65000;
    const dormant = base();
    dormant.ytdOtherOrdinary = 65000;
    dormant.harvestOn = false;
    dormant.harvestPoolAmount = 40000;
    dormant.harvestPoolBasisPct = 75;
    const a = computeDecemberProjection(plain);
    const b = computeDecemberProjection(dormant);
    if (b.headlineDraw !== a.headlineDraw) {
      fail(`headline draw identical: got ${b.headlineDraw}, want ${a.headlineDraw}`);
    }
    for (let i = 0; i < 3; i++) {
      exact(fail, `case ${i} MAGI identical`, b.cases[i]!.magiAtHeadline, a.cases[i]!.magiAtHeadline);
      exact(fail, `case ${i} federal tax identical`, b.cases[i]!.federalTaxAtHeadline, a.cases[i]!.federalTaxAtHeadline);
      if (b.cases[i]!.netSettleAtHeadline !== a.cases[i]!.netSettleAtHeadline) {
        fail(`case ${i} settlement identical: got ${b.cases[i]!.netSettleAtHeadline}, want ${a.cases[i]!.netSettleAtHeadline}`);
      }
      exact(fail, `case ${i} harvested gain`, b.cases[i]!.harvestedGainAtHeadline, 0);
    }
    // A legacy blob (written before the harvest fields
    // existed) parses them at their inert defaults, and
    // the writer schema accepts both shapes.
    const legacy = JSON.parse(
      serializeDecemberState(defaultDecemberState(2026), 0),
    ) as Record<string, unknown>;
    delete legacy.harvestOn;
    delete legacy.harvestPoolAmount;
    delete legacy.harvestPoolBasisPct;
    const parsed = parseDecemberState(JSON.stringify(legacy), 2026);
    if (parsed.harvestOn !== false) fail("legacy blob should parse harvest off");
    if (parsed.harvestPoolAmount !== null) fail("legacy blob should parse the pool as no input");
    if (parsed.harvestPoolBasisPct !== null) fail("legacy blob should parse the basis as no input");
    if (!decemberState.safeParse(defaultDecemberState(2026)).success) {
      fail("the writer schema should accept the default state");
    }
    if (!decemberState.safeParse(dormant).success) {
      fail("the writer schema should accept entered harvest facts");
    }
    // An out-of-range basis % in a blob reads leniently as
    // no input, never as a priced fact.
    const badBasis = parseDecemberState(
      JSON.stringify({ harvestPoolBasisPct: 140 }),
      2026,
    );
    if (badBasis.harvestPoolBasisPct !== null) {
      fail("a basis % above 100 should parse as no input");
    }
  });

  run("dec-harvest-no-facts-qualification", (fail) => {
    // Harvest ON with no pool / basis facts anywhere: no
    // harvest is priced (the figures are the harvest-off
    // figures, bit-identically), and every case carries
    // the gain-harvest-unpriced qualification with a
    // warning naming it — never a silent $0.
    const on = base();
    on.ytdOtherOrdinary = 65000;
    on.harvestOn = true;
    const proj = computeDecemberProjection(on);
    const offProj = computeDecemberProjection({ ...on, harvestOn: false });
    if (proj.headlineDraw !== offProj.headlineDraw) {
      fail(`headline identical to off: got ${proj.headlineDraw}, want ${offProj.headlineDraw}`);
    }
    for (let i = 0; i < 3; i++) {
      if (!proj.cases[i]!.gainHarvestUnpriced) {
        fail(`case ${i} should carry the unpriced qualification`);
      }
      exact(fail, `case ${i} harvested gain`, proj.cases[i]!.harvestedGainAtZeroDraw, 0);
      exact(fail, `case ${i} MAGI identical to off`, proj.cases[i]!.magiAtHeadline, offProj.cases[i]!.magiAtHeadline);
      if (proj.cases[i]!.netSettleAtHeadline !== offProj.cases[i]!.netSettleAtHeadline) {
        fail(`case ${i} settlement identical to off: got ${proj.cases[i]!.netSettleAtHeadline}, want ${offProj.cases[i]!.netSettleAtHeadline}`);
      }
    }
    if (!proj.warnings.some((w) => w.includes("excludes gain harvesting"))) {
      fail("the projection warnings should name the excluded harvest");
    }
    // One missing fact is enough: pool entered, basis not.
    const partial = computeDecemberProjection({
      ...on,
      harvestPoolAmount: 40000,
    });
    if (!partial.cases[1]!.gainHarvestUnpriced) {
      fail("a missing basis fact should still carry the qualification");
    }
    // An entered $0 pool IS a fact: the harvest prices
    // (at $0) and no qualification is carried.
    const zeroPool = computeDecemberProjection({
      ...on,
      harvestPoolAmount: 0,
      harvestPoolBasisPct: 75,
    });
    if (zeroPool.cases[1]!.gainHarvestUnpriced) {
      fail("an entered $0 pool should price, not qualify");
    }
    exact(fail, "$0 pool harvests $0", zeroPool.cases[1]!.harvestedGainAtZeroDraw, 0);
    if (zeroPool.warnings.some((w) => w.includes("excludes gain harvesting"))) {
      fail("an entered $0 pool should not warn about an excluded harvest");
    }
    // A 100% basis is likewise a priced fact ($0 gain).
    const fullBasis = computeDecemberProjection({
      ...on,
      harvestPoolAmount: 40000,
      harvestPoolBasisPct: 100,
    });
    if (fullBasis.cases[1]!.gainHarvestUnpriced) {
      fail("an entered 100% basis should price, not qualify");
    }
    exact(fail, "100% basis harvests $0", fullBasis.cases[1]!.harvestedGainAtZeroDraw, 0);
  });

  run("dec-harvest-room-binding", (fail) => {
    // When the pool's unrealized gain exceeds the 0%
    // band, the ROOM caps the harvest, not the pool: a
    // $500,000 pool at 0% basis over $65,000 of ordinary
    // income harvests exactly the $66,100 of room
    // ($98,900 0% top − $32,800 ordinary taxable income),
    // leaves no 0% room, and still pays no gains tax.
    const s = base();
    s.ytdOtherOrdinary = 65000;
    s.harvestOn = true;
    s.harvestPoolAmount = 500000;
    s.harvestPoolBasisPct = 0;
    const pg = pricePlaygroundYear(decemberCaseInputs(s, "likely", 0));
    exact(fail, "harvest capped by the 0% room", pg.harvestedGain, 66100);
    exact(fail, "no 0% room left", pg.gainsZeroRoomLeft, 0);
    exact(fail, "nothing priced at 15%", pg.gainsAt15, 0);
    exact(fail, "federal tax is the ordinary tax alone", pg.federalTax, 3440);
    exact(fail, "MAGI carries the full harvest", pg.acaMagi, 131100);
    // The same room binds from the gains side: with
    // $60,000 of the year's own gains already in the band,
    // only the remaining $6,100 of room harvests.
    const own = base();
    own.ytdOtherOrdinary = 65000;
    own.ytdCapitalGain = 60000;
    own.harvestOn = true;
    own.harvestPoolAmount = 500000;
    own.harvestPoolBasisPct = 0;
    const pgOwn = pricePlaygroundYear(decemberCaseInputs(own, "likely", 0));
    exact(fail, "harvest takes only the room the year's own gains leave", pgOwn.harvestedGain, 6100);
  });

  run("dec-harvest-carryforward-interaction", (fail) => {
    // The entering carryforward absorbs harvested gains
    // first (the march's ledgerFields nets the total
    // including the harvest): a $20,000 long-term
    // carry-in absorbs the full $10,000 harvest, so the
    // priced year shows no gain at all — MAGI moves only
    // by the $3,000 allowance — and the carry-out is the
    // entering balance less the absorbed harvest and the
    // used allowance.
    const s = base();
    s.ytdOtherOrdinary = 65000;
    s.carryInCapitalLossLt = 20000;
    s.harvestOn = true;
    s.harvestPoolAmount = 40000;
    s.harvestPoolBasisPct = 75;
    const pg = pricePlaygroundYear(decemberCaseInputs(s, "likely", 0));
    exact(fail, "harvest still realized gross", pg.harvestedGain, 10000);
    exact(fail, "priced net gain after absorption", pg.ltcgNet, -10000);
    exact(fail, "MAGI moves by the allowance alone", pg.acaMagi, 62000);
    exact(fail, "federal tax on the absorbed year", pg.federalTax, 3080);
    exact(fail, "carry-out after absorption and used allowance", pg.lossCarryOutLt, 7000);
    // Control: the same carry-in with NO harvest — the
    // year's own result is $0, so only the allowance is
    // consumed and $17,000 carries out.
    const control = base();
    control.ytdOtherOrdinary = 65000;
    control.carryInCapitalLossLt = 20000;
    const pgControl = pricePlaygroundYear(decemberCaseInputs(control, "likely", 0));
    exact(fail, "control MAGI", pgControl.acaMagi, 62000);
    exact(fail, "control carry-out", pgControl.lossCarryOutLt, 17000);
    // And the same harvest with NO carry-in prices the
    // full gain into MAGI (the F3 acceptance shape).
    const noCarry = base();
    noCarry.ytdOtherOrdinary = 65000;
    noCarry.harvestOn = true;
    noCarry.harvestPoolAmount = 40000;
    noCarry.harvestPoolBasisPct = 75;
    const pgNoCarry = pricePlaygroundYear(decemberCaseInputs(noCarry, "likely", 0));
    exact(fail, "unabsorbed harvest reaches MAGI whole", pgNoCarry.acaMagi, 75000);
  });

  run("dec-harvest-resolution-and-save-rules", (fail) => {
    // Load resolution (v113): the record's pool facts are
    // balance facts, so they resolve into null console
    // fields in ANY year (no first-year gate, unlike the
    // carry-in); per field, null resolves and any entered
    // value (including a $0 pool) wins. Save derivation:
    // an unedited harvest saves its STORED values, never
    // the resolved overlay.
    const facts: DecemberRecordFacts = {
      harvestPoolAmount: 40000,
      harvestPoolBasisPct: 75,
    };
    const fresh = defaultDecemberState(2026);
    const resolved = resolveDecemberStateAtLoad(fresh, facts);
    exact(fail, "resolved pool", resolved.harvestPoolAmount, 40000);
    exact(fail, "resolved basis", resolved.harvestPoolBasisPct, 75);
    const otherYear = resolveDecemberStateAtLoad(
      { ...defaultDecemberState(2026), taxYear: 2027 },
      facts,
    );
    exact(fail, "pool resolves in any year", otherYear.harvestPoolAmount, 40000);
    exact(fail, "basis resolves in any year", otherYear.harvestPoolBasisPct, 75);
    const entered = resolveDecemberStateAtLoad(
      { ...defaultDecemberState(2026), harvestPoolAmount: 0 },
      facts,
    );
    exact(fail, "entered $0 pool wins", entered.harvestPoolAmount, 0);
    exact(fail, "unanswered basis still resolves", entered.harvestPoolBasisPct, 75);
    const silent = resolveDecemberStateAtLoad(fresh, {});
    if (silent.harvestPoolAmount !== null || silent.harvestPoolBasisPct !== null) {
      fail("a record that does not answer should leave the facts null");
    }
    // The toggle never resolves from the record.
    if (resolved.harvestOn !== false) {
      fail("load resolution must never switch the harvest toggle on");
    }
    const stored = decemberStoredProvenanceOf(fresh);
    const savedOverlay = decemberStateForSave(resolved, stored, {
      beneficiary: false,
      balances: false,
    });
    if (savedOverlay.harvestPoolAmount !== null || savedOverlay.harvestPoolBasisPct !== null) {
      fail("an unedited save should persist the stored (null) harvest facts, not the overlay");
    }
    const savedEdited = decemberStateForSave(resolved, stored, {
      beneficiary: false,
      balances: false,
      harvestPoolAmount: true,
      harvestPoolBasisPct: true,
    });
    exact(fail, "an edited save persists the console pool", savedEdited.harvestPoolAmount, 40000);
    exact(fail, "an edited save persists the console basis", savedEdited.harvestPoolBasisPct, 75);
    // Per-field saves (round-17 defect 3): editing one
    // harvest fact saves only that fact — the untouched
    // sibling keeps its stored value.
    const savedPoolOnly = decemberStateForSave(resolved, stored, {
      beneficiary: false,
      balances: false,
      harvestPoolAmount: true,
    });
    exact(fail, "editing the pool saves the console pool", savedPoolOnly.harvestPoolAmount, 40000);
    if (savedPoolOnly.harvestPoolBasisPct !== null) {
      fail("editing the pool alone must not save the untouched basis %");
    }
    const savedBasisOnly = decemberStateForSave(resolved, stored, {
      beneficiary: false,
      balances: false,
      harvestPoolBasisPct: true,
    });
    exact(fail, "editing the basis saves the console basis", savedBasisOnly.harvestPoolBasisPct, 75);
    if (savedBasisOnly.harvestPoolAmount !== null) {
      fail("editing the basis % alone must not save the untouched pool");
    }
    // S-8 (engines review round 2): the record fact is a
    // CURRENT pool, so resolution converts it to the
    // STARTING pool the console fact means, adding back
    // the year's year-to-date sale and its 100%-basis
    // taxable cash (the outflows the shared pricer nets
    // back out). The settlement's worked example: the
    // year's sale realized a $5,860 gain on $17,580 of
    // basis (proceeds $23,440), leaving a $16,560 current
    // pool at 75% basis ($12,420 of basis) — which resolves
    // to the $40,000 starting pool at 75% ($12,420 +
    // $17,580 = $30,000 of basis over $16,560 + $23,440 =
    // $40,000 of pool).
    const currentFacts: DecemberRecordFacts = {
      harvestPoolAmount: 16560,
      harvestPoolBasisPct: 75,
    };
    const soldYear = {
      ...defaultDecemberState(2026),
      ytdCapitalGain: 5860,
      saleBasis: 17580,
    };
    const converted = resolveDecemberStateAtLoad(soldYear, currentFacts);
    exact(fail, "current pool converts to the starting pool", converted.harvestPoolAmount, 40000);
    exact(fail, "basis % converts on the same dollars", converted.harvestPoolBasisPct, 75);
    // 100%-basis taxable cash converts too: $10,000 of it
    // left the pool at full basis, so the starting pool is
    // $50,000 with $40,000 of basis (80%).
    const convertedFunded = resolveDecemberStateAtLoad(
      { ...soldYear, taxableFunded: 10000 },
      currentFacts,
    );
    exact(fail, "taxable cash adds back to the pool", convertedFunded.harvestPoolAmount, 50000);
    exact(fail, "taxable cash adds back to the basis", convertedFunded.harvestPoolBasisPct, 80);
    // A gain-only year-to-date sale (no basis entered)
    // adds back its gain alone — proceeds $5,860, basis
    // $0 — so the starting pool is $22,420 and its basis
    // stays the record's $12,420 over that larger pool.
    const convertedGainOnly = resolveDecemberStateAtLoad(
      { ...defaultDecemberState(2026), ytdCapitalGain: 5860 },
      currentFacts,
    );
    exact(fail, "gain-only sale adds back its proceeds", convertedGainOnly.harvestPoolAmount, 22420);
    exact(fail, "gain-only basis %", convertedGainOnly.harvestPoolBasisPct, 55.4);
    // A record that answers the basis but not the pool
    // cannot be converted (its basis dollars are unknown):
    // the % resolves as entered and no pool is invented.
    const basisOnly = resolveDecemberStateAtLoad(soldYear, {
      harvestPoolBasisPct: 75,
    });
    if (basisOnly.harvestPoolAmount !== null) {
      fail("a basis-only record must not invent a pool");
    }
    exact(fail, "an unconvertible basis % resolves as entered", basisOnly.harvestPoolBasisPct, 75);
    if (!decemberState.safeParse(resolved).success) {
      fail("the writer schema should accept resolved harvest facts");
    }
  });

  run("dec-taxable-funded-acceptance", (fail) => {
    // Build v125: cash taken from taxable at 100% basis
    // is $0 MAGI, so it uses no MAGI room and the cliff
    // solver's answer — the maximum safe pre-tax draw — is
    // invariant to it. The draw is sized by MAGI room; the
    // taxable amount is a cash quantity, not a MAGI one
    // (the harvest precedent is the same rule the other
    // way: a gain shrinks the draw by the gain because it
    // ADDS MAGI; a $0-MAGI item moves it by $0). The
    // amount is additional cash ON TOP of the draw: the
    // pre-tax draw, MAGI, credit, tax, and settlement are
    // unchanged, and cash-in / cash-left rise dollar for
    // dollar. Baseline is the headline fixture's state
    // (other ordinary $50,000): headline $29,600, MAGI
    // $79,600, credit $12,071.84, federal tax $5,192, net
    // settle $5,120.16, cash in $79,600, cash left
    // $74,479.84. With $10,000 of taxable cash the cash
    // figures rise by exactly $10,000 and nothing else
    // moves — in every case.
    const s = base();
    s.ytdOtherOrdinary = 50000;
    s.taxableFunded = 10000;
    const r = computeDecemberProjection(s);
    if (!r.priced) return fail("not priced");
    near(fail, "headline draw unchanged", r.headlineDraw, 29600);
    for (const c of r.cases) {
      near(fail, "magi unchanged", c.magiAtHeadline, 79600);
      near(fail, "credit unchanged", c.creditAtHeadline, 12071.84);
      near(fail, "federal tax unchanged", c.federalTaxAtHeadline, 5192);
      near(fail, "net settle unchanged", c.netSettleAtHeadline, 5120.16);
      near(fail, "cash in +$10,000", c.cashInAtHeadline, 89600);
      near(fail, "cash left +$10,000", c.cashLeftAtHeadline, 84479.84);
    }
  });

  run("dec-taxable-funded-zero-identity", (fail) => {
    // The $0-vs-nonzero boundary: an explicit $0 and no
    // input at all price bit-identically — every figure,
    // in every case, equal to the baseline run.
    const plain = base();
    plain.ytdOtherOrdinary = 50000;
    const zero = base();
    zero.ytdOtherOrdinary = 50000;
    zero.taxableFunded = 0;
    const a = computeDecemberProjection(plain);
    const b = computeDecemberProjection(zero);
    if (a.headlineDraw !== b.headlineDraw) fail("headline differs at $0");
    for (let i = 0; i < 3; i++) {
      const ca = a.cases[i]!;
      const cb = b.cases[i]!;
      if (ca.magiAtHeadline !== cb.magiAtHeadline) fail(`case ${i} magi differs at $0`);
      if (ca.creditAtHeadline !== cb.creditAtHeadline) fail(`case ${i} credit differs at $0`);
      if (ca.federalTaxAtHeadline !== cb.federalTaxAtHeadline) fail(`case ${i} tax differs at $0`);
      if (ca.netSettleAtHeadline !== cb.netSettleAtHeadline) fail(`case ${i} settle differs at $0`);
      if (ca.cashInAtHeadline !== cb.cashInAtHeadline) fail(`case ${i} cash in differs at $0`);
      if (ca.cashLeftAtHeadline !== cb.cashLeftAtHeadline) fail(`case ${i} cash left differs at $0`);
    }
    exact(fail, "cash in at $0", b.cases[1]!.cashInAtHeadline, 79600);
    exact(fail, "cash left at $0", b.cases[1]!.cashLeftAtHeadline, 74479.84);
  });

  run("dec-taxable-funded-null-settlement", (fail) => {
    // The null contract: when no settlement is shown (here
    // the credit is genuinely unpriced — no benchmark
    // entered, marketplace-eligible household), cash-in and
    // cash-left stay null even with taxable cash entered —
    // the amount never invents a settlement. The draw is
    // still sized (the cliff applies), so it is unchanged.
    const s = base();
    s.ytdOtherOrdinary = 50000;
    s.acaBenchmarkAnnual = null;
    s.taxableFunded = 10000;
    const r = computeDecemberProjection(s, 18000000);
    if (!r.priced) return fail("not priced");
    near(fail, "headline draw unchanged", r.headlineDraw, 29600);
    for (const c of r.cases) {
      if (c.netSettleAtHeadline !== null) fail("settlement should be null without a benchmark");
      if (c.cashInAtHeadline !== null) fail("cash in should be null without a settlement");
      if (c.cashLeftAtHeadline !== null) fail("cash left should be null without a settlement");
      // N-5: the spending echo follows the same null
      // contract (build v126) — with spending given but
      // no settlement shown, annualSpendingAtHeadline is
      // null too, exactly like cashLeftVsSpendingAtHeadline.
      if (c.annualSpendingAtHeadline !== null) fail("spending echo should be null without a settlement");
      if (c.cashLeftVsSpendingAtHeadline !== null) fail("comparison should be null without a settlement");
    }
  });

  run("dec-cash-left-vs-spending-surplus", (fail) => {
    // "Enough for the year" (build v126), surplus: the
    // baseline likely case leaves $74,479.84 cash left after
    // tax (pinned by the headline fixture); against $60,000
    // of annual spending the year is enough by $14,479.84.
    // The spending is comparison-only: the draw, MAGI,
    // credit, tax, settlement, and cash left are unchanged
    // in every case, and each case's comparison is its own
    // cash left minus the spending.
    const s = base();
    s.ytdOtherOrdinary = 50000;
    const r = computeDecemberProjection(s, 6000000);
    if (!r.priced) return fail("not priced");
    near(fail, "headline draw unchanged", r.headlineDraw, 29600);
    for (const c of r.cases) {
      if (c.cashLeftAtHeadline == null) return fail("cash left should be priced");
      exact(fail, "spending echoed", c.annualSpendingAtHeadline, 60000);
      near(fail, "case comparison", c.cashLeftVsSpendingAtHeadline, c.cashLeftAtHeadline - 60000);
    }
    const likely = r.cases[1]!;
    exact(fail, "likely cash left unchanged", likely.cashLeftAtHeadline, 74479.84);
    exact(fail, "likely surplus", likely.cashLeftVsSpendingAtHeadline, 14479.84);
  });

  run("dec-cash-left-vs-spending-shortfall", (fail) => {
    // "Enough for the year" (build v126), shortfall: the
    // same baseline against $80,000 of annual spending is
    // short by $5,520.16 (74,479.84 − 80,000), a negative
    // comparison. Nothing else moves.
    const s = base();
    s.ytdOtherOrdinary = 50000;
    const r = computeDecemberProjection(s, 8000000);
    if (!r.priced) return fail("not priced");
    const likely = r.cases[1]!;
    exact(fail, "likely cash left unchanged", likely.cashLeftAtHeadline, 74479.84);
    exact(fail, "likely shortfall", likely.cashLeftVsSpendingAtHeadline, -5520.16);
    for (const c of r.cases) {
      if (c.cashLeftAtHeadline == null) return fail("cash left should be priced");
      near(fail, "case comparison", c.cashLeftVsSpendingAtHeadline, c.cashLeftAtHeadline - 80000);
    }
  });

  run("dec-cash-left-vs-spending-absent", (fail) => {
    // The null contract: with no spending given, both new
    // fields are null in every case and every other figure
    // prices exactly as the baseline — the comparison adds
    // nothing and changes nothing.
    const s = base();
    s.ytdOtherOrdinary = 50000;
    const r = computeDecemberProjection(s);
    if (!r.priced) return fail("not priced");
    near(fail, "headline draw unchanged", r.headlineDraw, 29600);
    for (const c of r.cases) {
      if (c.annualSpendingAtHeadline !== null) fail("spending should be null when none was given");
      if (c.cashLeftVsSpendingAtHeadline !== null) fail("comparison should be null when none was given");
    }
    exact(fail, "likely cash left unchanged", r.cases[1]!.cashLeftAtHeadline, 74479.84);
  });

  run("dec-cash-left-agrees-with-engine", (fail) => {
    // Build v193 (re-audit round 3 SHOULD-4): the console's
    // cash left and the shared single-year engine's cash
    // left for the same year are ONE figure. The console's
    // reconciliation facts ride decemberCaseInputs to the
    // pricer's own dials, so the pricer's netTaxBill on a
    // December pricing IS the case's settlement and its
    // cashLeftAfterTax is the console's cash left (less
    // the taxable cash the assembly adds). Before this
    // build the pricer never netted the reconciliation:
    // on the headline shape below its bill was the $5,192
    // total tax and its cash left $74,408, while the
    // console netted $71.84 of credit still due and
    // reported $74,479.84 — two cash-left figures for one
    // year, differing by exactly the credit still due.
    // The shapes: the headline fixture's state (APTC
    // $12,000 under the $12,071.84 final credit), APTC $0
    // (the whole credit still due), APTC $15,000 (an
    // excess repayment of $2,928.16), a $0 enrollment
    // premium (the priced credit $0, the whole $12,000 of
    // APTC repaid), a $2,000 coverage-month reduction
    // (final credit $10,071.84, excess $1,928.16), an
    // over-the-cliff year (final credit $0, the whole
    // APTC repaid), and the headline shape with $10,000
    // of taxable cash. On every shape and every case: the
    // engine's cash in is the console's cash in less the
    // taxable cash, the engine's net tax bill IS the
    // console's settlement to the cent, and the engine's
    // cash left plus the taxable cash IS the console's
    // cash left to the cent.
    const shapes: { label: string; make: () => DecemberState }[] = [
      {
        label: "headline",
        make: () => {
          const s = base();
          s.ytdOtherOrdinary = 50000;
          return s;
        },
      },
      {
        label: "aptc-zero",
        make: () => {
          const s = base();
          s.ytdOtherOrdinary = 50000;
          s.aptcTaken = 0;
          return s;
        },
      },
      {
        label: "aptc-excess",
        make: () => {
          const s = base();
          s.ytdOtherOrdinary = 50000;
          s.aptcTaken = 15000;
          return s;
        },
      },
      {
        label: "enrollment-zero",
        make: () => {
          const s = base();
          s.ytdOtherOrdinary = 50000;
          s.acaEnrollmentPremiumAnnual = 0;
          return s;
        },
      },
      {
        label: "coverage-reduction",
        make: () => {
          const s = base();
          s.ytdOtherOrdinary = 40000;
          s.strayCoverage = { status: "amount", amount: 2000 };
          return s;
        },
      },
      {
        label: "over-cliff",
        make: () => {
          const s = base();
          s.ytdOtherOrdinary = 100000;
          return s;
        },
      },
      {
        label: "taxable-funded",
        make: () => {
          const s = base();
          s.ytdOtherOrdinary = 50000;
          s.taxableFunded = 10000;
          return s;
        },
      },
    ];
    for (const { label, make } of shapes) {
      const s = make();
      const r = computeDecemberProjection(s);
      if (!r.priced) return fail(`${label}: not priced`);
      const draw = r.headlineDraw ?? 0;
      const funded = Math.max(0, s.taxableFunded ?? 0);
      for (const c of r.cases) {
        const settle = c.netSettleAtHeadline;
        const cashInH = c.cashInAtHeadline;
        const cashLeftH = c.cashLeftAtHeadline;
        if (settle == null || cashInH == null || cashLeftH == null) {
          return fail(`${label}/${c.kind}: settlement should price`);
        }
        const pg = pricePlaygroundYear(decemberCaseInputs(s, c.kind, draw));
        exact(fail, `${label}/${c.kind} engine cash in`, pg.cashIn + funded, cashInH);
        exact(fail, `${label}/${c.kind} engine bill = settlement`, pg.netTaxBill, settle);
        exact(fail, `${label}/${c.kind} engine cash left`, pg.cashLeftAfterTax + funded, cashLeftH);
      }
    }
    // The headline shape's lines, pinned outright: cash in
    // $79,600, settlement $5,120.16 (= $5,192 total tax −
    // $71.84 credit still due), cash left $74,479.84 — on
    // BOTH surfaces.
    const s = base();
    s.ytdOtherOrdinary = 50000;
    const r = computeDecemberProjection(s);
    if (!r.priced) return fail("headline shape not priced");
    const pg = pricePlaygroundYear(
      decemberCaseInputs(s, "likely", r.headlineDraw ?? 0),
    );
    exact(fail, "engine cash in (headline shape)", pg.cashIn, 79600);
    exact(fail, "engine net tax bill (headline shape)", pg.netTaxBill, 5120.16);
    exact(fail, "engine cash left (headline shape)", pg.cashLeftAfterTax, 74479.84);
    exact(fail, "console cash left (headline shape)", r.cases[1]!.cashLeftAtHeadline, 74479.84);
    // The sole-mover control: the same pricing WITHOUT the
    // reconciliation dials prices the pre-v193 bill — the
    // $5,192 total tax, the credit treated as fully
    // advanced — and a cash left of $74,408, lower by
    // exactly the $71.84 of credit still due. The dials
    // are what move the engine; nothing else does.
    const bare = decemberCaseInputs(s, "likely", r.headlineDraw ?? 0);
    delete bare.aptcTaken;
    delete bare.acaEnrollmentPremiumAnnual;
    delete bare.acaCoverageReduction;
    const pgBare = pricePlaygroundYear(bare);
    exact(fail, "no-dial net tax bill", pgBare.netTaxBill, 5192);
    exact(fail, "no-dial cash left", pgBare.cashLeftAfterTax, 74408);
    // The null contract: with no benchmark entered the
    // settlement does not price, the console shows no cash
    // left, and the engine's bill falls back to the
    // un-reconciled form (the $5,192 total tax) rather
    // than inventing a settlement.
    const nb = base();
    nb.ytdOtherOrdinary = 50000;
    nb.acaBenchmarkAnnual = null;
    const rn = computeDecemberProjection(nb);
    if (!rn.priced) return fail("no-benchmark shape not priced");
    const cn = rn.cases[1]!;
    if (cn.netSettleAtHeadline !== null) fail("no-benchmark settlement should be null");
    if (cn.cashLeftAtHeadline !== null) fail("no-benchmark cash left should be null");
    const pgN = pricePlaygroundYear(
      decemberCaseInputs(nb, "likely", rn.headlineDraw ?? 0),
    );
    exact(fail, "no-benchmark engine fallback bill", pgN.netTaxBill, 5192);
  });

  run("dec-taxable-funded-save-round-trip", (fail) => {
    // Persistence: the field survives a serialize/parse
    // round trip; a blob written before it existed parses
    // it as null; the writer schema accepts it; and it is
    // one of the year-to-date group (internal review round
    // 6, SHOULD-2) — a typed figure saves as displayed
    // with the group's edited flag (the live console sets
    // it on any year-to-date edit), while an unedited
    // group saves stamp-aware, like a carry-in.
    const s = { ...defaultDecemberState(2026), taxableFunded: 10000 };
    const blob = serializeDecemberState(s, 1);
    const back = parseDecemberState(blob, 2026);
    exact(fail, "round-tripped amount", back.taxableFunded, 10000);
    const legacy = parseDecemberState(JSON.stringify({ taxYear: 2026 }), 2026);
    if (legacy.taxableFunded !== null) fail("a blob without the key should parse null");
    if (!decemberState.safeParse(s).success) {
      fail("the writer schema should accept the new field");
    }
    const fresh = defaultDecemberState(2026);
    const stored = decemberStoredProvenanceOf(fresh);
    const saved = decemberStateForSave(
      { ...fresh, taxableFunded: 10000 },
      stored,
      { beneficiary: false, balances: false, ytd: true },
    );
    exact(fail, "save passes it through", saved.taxableFunded, 10000);
  });

  /* ---- Build v127 fixtures: round-19 December figures
     (findings 1–4) ---- */

  run("dec-finding1-snapshot-follow-primary", (fail) => {
    // Round-19 finding 1 (MUST): when the Tax Plan
    // record's primary pre-tax balance follows the Net
    // Worth snapshot and the spouse's amount is explicit,
    // the primary is the snapshot's total MINUS the
    // spouse's amount — the full snapshot is the
    // household's total, not the primary's alone. The
    // helper is the single source the console's
    // recordFactsOf and first-open preseed both use, so
    // the unit pins the exact code the client runs.
    exact(fail, "snapshot minus spouse", snapshotFollowPrimaryCents(100000000, 20000000), 80000000);
    exact(fail, "no spouse leaves the snapshot whole", snapshotFollowPrimaryCents(100000000, null), 100000000);
    if (snapshotFollowPrimaryCents(null, 20000000) !== null) fail("no snapshot should answer null");
    exact(fail, "spouse above the snapshot floors at $0", snapshotFollowPrimaryCents(15000000, 20000000), 0);
    // And the load allocation, given the corrected 4:1
    // record facts, splits the saved combined total 4:1 —
    // not the 5:1 the old full-snapshot facts produced.
    const facts: DecemberRecordFacts = {
      pretaxBalancePrimary: 800000,
      pretaxBalanceSpouse: 200000,
    };
    const stored = { ...defaultDecemberState(2028), taxYear: 2028, pretaxBalance: 1000000 };
    const resolved = resolveDecemberStateAtLoad(stored, facts);
    exact(fail, "allocated primary", resolved.pretaxBalancePrimary, 800000);
    exact(fail, "allocated spouse", resolved.pretaxBalanceSpouse, 200000);
    exact(fail, "shares sum to the saved total", (resolved.pretaxBalancePrimary ?? 0) + (resolved.pretaxBalanceSpouse ?? 0), 1000000);
  });

  run("dec-finding2-rmd-already-received-cash-in", (fail) => {
    // Round-19 finding 2 (SHOULD): cash-in counted the
    // received RMD twice — once inside other ordinary
    // income (where the console's own hint says it
    // belongs) and once as its own term — overstating
    // cash left by exactly the received amount. The
    // settled example: tax year 2028, primary 75, spouse
    // 64, MFJ, primary on Medicare, household 2,
    // benchmark $12,000, YTD other ordinary $10,000 (of
    // which $4,000 is RMD already received), $4,000
    // received, primary pre-tax balance $1,000,000.
    // True cash in is $10,000 + the $35,525.69 net RMD +
    // the $36,034.31 headline draw = $81,560; true cash
    // left $80,927.42. MAGI, the headline draw, and the
    // tax were already correct and must not move.
    const s = {
      ...defaultDecemberState(2028),
      taxYear: 2028,
      agePrimary: 75,
      ageSpouse: 64,
      onMedicarePrimary: true,
      acaHouseholdSize: 2,
      acaBenchmarkAnnual: 12000,
      aptcTaken: 0,
    };
    s.ytdOtherOrdinary = 10000;
    s.rmdAlreadyReceived = 4000;
    s.pretaxBalancePrimary = 1000000;
    const r = computeDecemberProjection(s);
    if (!r.priced) return fail("not priced");
    near(fail, "headline draw unchanged", r.headlineDraw, 36034.31);
    const likely = r.cases[1]!;
    near(fail, "magi unchanged", likely.magiAtHeadline, 81560);
    near(fail, "cash in counts the RMD once", likely.cashInAtHeadline, 81560);
    near(fail, "cash left no longer overstated", likely.cashLeftAtHeadline, 80927.42);
  });

  run("dec-finding3-carry-in-prior-year", (fail) => {
    // Round-19 finding 3 (SHOULD), as narrowed by engines
    // review round 2 finding M-3 (settled STAND): the
    // record's carry-in is the balance entering the plan's
    // FIRST year. Build v127 answered finding 3 by
    // resolving that full balance into every later
    // December year; M-3 settled that the widening
    // over-applies it — the march consumes the balance
    // year by year, so a later year's entering loss is
    // the march's remainder, never the first-year balance
    // — and the gate is restored to the first year only.
    // The settled example: a record last saved in 2025
    // carrying a $3,000 short-term loss carry-in, December
    // 2026 — the record does NOT resolve into the 2026
    // console (2026 is not the plan's first year), while
    // the same $3,000 ENTERED in the console prices the
    // year's federal tax at $16,390 against $16,840
    // without it (2026, MFJ, $150,000 other ordinary,
    // $10,000 long-term gain) — the pricing half of
    // finding 3's example, unchanged.
    const facts: DecemberRecordFacts = {
      planFirstYear: 2025,
      carryInCapitalLossSt: 3000,
    };
    const fresh = { ...defaultDecemberState(2026), taxYear: 2026 };
    const resolved = resolveDecemberStateAtLoad(fresh, facts);
    if (resolved.carryInCapitalLossSt !== null) {
      fail("a prior-year record's first-year carry-in must not resolve into a later December year");
    }
    const firstYear = resolveDecemberStateAtLoad(
      { ...defaultDecemberState(2026), taxYear: 2025 },
      facts,
    );
    exact(fail, "the plan's first year still resolves", firstYear.carryInCapitalLossSt, 3000);
    const noCarry = {
      ...defaultDecemberState(2026),
      agePrimary: 60,
      ageSpouse: 58,
      acaHouseholdSize: 2,
      acaBenchmarkAnnual: 20000,
      aptcTaken: 0,
    };
    noCarry.ytdOtherOrdinary = 150000;
    noCarry.ytdCapitalGain = 10000;
    const withCarry = { ...noCarry, carryInCapitalLossSt: 3000 };
    const pgNo = pricePlaygroundYear(decemberCaseInputs(noCarry, "likely", 0));
    const pgWith = pricePlaygroundYear(decemberCaseInputs(withCarry, "likely", 0));
    exact(fail, "federal tax without the carry-in", pgNo.federalTax, 16840);
    exact(fail, "federal tax with the carry-in", pgWith.federalTax, 16390);
  });

  run("dec-finding4-sale-proceeds-cash-in", (fail) => {
    // Round-19 finding 4 (SHOULD): cash-in counted only
    // the gain on stock sales and silently dropped the
    // basis returned on every sale. The settled example:
    // a $50,000 sale with a $40,000 basis, realizing a
    // $10,000 gain, entered as YTD capital gain — with
    // the $40,000 basis entered, cash-in is the full
    // $119,600 of proceeds and cash left $119,679.84.
    // The pricing (MAGI, tax, settlement) is unaffected:
    // the same state without a basis prices identical
    // MAGI and tax, and cash-in / cash-left lower by
    // exactly the $40,000 basis.
    const s = {
      ...defaultDecemberState(2026),
      agePrimary: 57,
      ageSpouse: 46,
      acaHouseholdSize: 2,
      acaBenchmarkAnnual: 12000,
      aptcTaken: 0,
    };
    s.ytdCapitalGain = 10000;
    const noBasis = computeDecemberProjection(s);
    const withBasis = computeDecemberProjection({ ...s, saleBasis: 40000 });
    if (!noBasis.priced || !withBasis.priced) return fail("not priced");
    const likelyNo = noBasis.cases[1]!;
    const likelyWith = withBasis.cases[1]!;
    near(fail, "headline draw unchanged", withBasis.headlineDraw, 69600);
    near(fail, "cash in counts the proceeds", likelyWith.cashInAtHeadline, 119600);
    near(fail, "cash left counts the proceeds", likelyWith.cashLeftAtHeadline, 119679.84);
    if (likelyWith.magiAtHeadline !== likelyNo.magiAtHeadline) fail("magi must not move with the basis");
    if (likelyWith.federalTaxAtHeadline !== likelyNo.federalTaxAtHeadline) fail("federal tax must not move with the basis");
    if (likelyWith.netSettleAtHeadline !== likelyNo.netSettleAtHeadline) fail("settlement must not move with the basis");
    near(fail, "cash in without a basis is the gain alone", likelyNo.cashInAtHeadline, 79600);
    near(fail, "cash left without a basis is short the basis", likelyNo.cashLeftAtHeadline, 79679.84);
    // A loss sale still brings its proceeds in: a
    // −$10,000 loss on a $60,000 basis is $50,000 of
    // cash in hand, and the loss still nets for tax.
    const loss = { ...s, ytdCapitalGain: -10000, saleBasis: 60000 };
    const pgLoss = pricePlaygroundYear(decemberCaseInputs(loss, "likely", 0));
    exact(fail, "loss sale cash in counts the proceeds", pgLoss.cashIn, 50000);
    exact(fail, "loss still nets for tax", pgLoss.ltcgNet, -10000);
  });

  run("dec-finding4-sale-basis-save-round-trip", (fail) => {
    // Persistence: the basis field survives a
    // serialize/parse round trip; a blob written before
    // it existed parses it as null; the writer schema
    // accepts it; and it is one of the year-to-date group
    // (internal review round 6, SHOULD-2) — a typed figure
    // saves as displayed with the group's edited flag (the
    // live console sets it on any year-to-date edit), while
    // an unedited group saves stamp-aware, like a carry-in.
    const s = { ...defaultDecemberState(2026), saleBasis: 40000 };
    const blob = serializeDecemberState(s, 1);
    const back = parseDecemberState(blob, 2026);
    exact(fail, "round-tripped basis", back.saleBasis, 40000);
    const legacy = parseDecemberState(JSON.stringify({ taxYear: 2026 }), 2026);
    if (legacy.saleBasis !== null) fail("a blob without the key should parse null");
    if (!decemberState.safeParse(s).success) {
      fail("the writer schema should accept the new field");
    }
    const fresh = defaultDecemberState(2026);
    const stored = decemberStoredProvenanceOf(fresh);
    const saved = decemberStateForSave(
      { ...fresh, saleBasis: 40000 },
      stored,
      { beneficiary: false, balances: false, ytd: true },
    );
    exact(fail, "save passes it through", saved.saleBasis, 40000);
  });

  return {
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    results,
  };
}
