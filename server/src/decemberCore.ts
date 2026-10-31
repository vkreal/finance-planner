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
   rides the engine's existing pre-tax-money-out (conversion)
   dial. This module only ASSEMBLES the year's income from the
   December pieces (actuals + a range case + stray amounts) into
   Playground dials, and reads the engine's own outputs back.

   Persistence: the console's inputs are one JSON blob in
   settings under DECEMBER_STATE_KEY, encrypted at rest with
   the app's field encryption (contract v90, stored-data
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
/* The UNSIGNED variant (contract v66, boundary audit F5): the
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
  // Gain harvest (contract v113, round-17 fix F3): whether
  // the plan's gain-harvest strategy is on for this year,
  // and the taxable-pool facts the harvest sizes itself
  // from — the pool available to sell (the COMBINED taxable
  // pool, Taxable plus Cash, the pool the plan march draws
  // on) and its BLENDED basis % (basis dollars ÷ pool; the
  // march's tier walking moves only its basis step-up
  // bookkeeping between years, never the size, so one
  // blended % carries the sizing). harvestOn defaults OFF:
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
  // Education credits (contract v103, round-14 fix F3):
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
  // total (contract v112, round-17 fix F4): Schedule K-1
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
  // January-paid stray's total (contract v104, round-14
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
  // return-of-capital amount (contract v112, round-17
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
    carryInCapitalLossSt: null,
    carryInCapitalLossLt: null,
    carryInCapitalLossStWa: null,
    carryInCapitalLossLtWa: null,
    harvestOn: false,
    harvestPoolAmount: null,
    harvestPoolBasisPct: null,
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
/* Result-honesty (contract v67, F09): whether a PRESENT stored
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
  // the loss entering the plan's FIRST year, so it
  // answers the December console ONLY for that year —
  // planFirstYear is that year (the record's execution
  // year), and load resolution applies the carry-in facts
  // only when the console's taxYear equals it. Absent /
  // null per field = the record does not answer that
  // field.
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
  // first year.
  harvestPoolAmount?: number | null;
  harvestPoolBasisPct?: number | null;
};

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
   The second argument also accepts the round-4 bare
   beneficiary value (boolean / null) for compatibility. */
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
  // Education students (v103): a console with NO education
  // input yet (educationStudents null — every blob written
  // before this field existed, and a fresh console) resolves
  // the record's entered students for the December tax year
  // as an overlay, exactly like the beneficiary fact above:
  // displayed and priced, never saved as the console's own
  // until the user edits the education controls here. A
  // console value that IS entered (any list, even empty)
  // always governs and is never overwritten.
  if (out.educationStudents == null && facts.educationStudents != null) {
    out = {
      ...out,
      educationStudents: facts.educationStudents,
    };
  }
  // Entering capital-loss carryforward (v111): the Tax
  // Plan record's carry-in is the balance entering the
  // plan's FIRST year, so it resolves into the console
  // ONLY when the console's tax year IS that year
  // (planFirstYear — the record's execution year); in any
  // other year the record's balance says nothing about
  // this year's entering loss and no overlay applies.
  // Per field: a null console value (no input yet)
  // resolves from the record fact; any entered console
  // value — including an explicit $0 — always wins and is
  // never overwritten. Like every resolution here this is
  // an overlay for display and pricing only: a save
  // persists the STORED values for fields the user has
  // not edited in this console (decemberStateForSave's
  // carryIn flag).
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
  // (decemberStateForSave's harvest flag).
  {
    const harvestPatch: Partial<DecemberState> = {};
    if (out.harvestPoolAmount == null && facts.harvestPoolAmount != null) {
      harvestPatch.harvestPoolAmount = facts.harvestPoolAmount;
    }
    if (out.harvestPoolBasisPct == null && facts.harvestPoolBasisPct != null) {
      harvestPatch.harvestPoolBasisPct = facts.harvestPoolBasisPct;
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

/* The provenance a save must preserve for fields the
   user has not edited in the console: the STORED blob's
   own values (as parsed, before any load resolution). */
export type DecemberStoredProvenance = {
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
};

export function decemberStoredProvenanceOf(
  state: DecemberState,
): DecemberStoredProvenance {
  return {
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
   console. Once the user edits that control, the display
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
    carryIn?: boolean;
    harvest?: boolean;
  },
): DecemberState {
  return {
    ...display,
    educationStudents: edited.education
      ? display.educationStudents
      : stored.educationStudents,
    carryInCapitalLossSt: edited.carryIn
      ? display.carryInCapitalLossSt
      : stored.carryInCapitalLossSt,
    carryInCapitalLossLt: edited.carryIn
      ? display.carryInCapitalLossLt
      : stored.carryInCapitalLossLt,
    carryInCapitalLossStWa: edited.carryIn
      ? display.carryInCapitalLossStWa
      : stored.carryInCapitalLossStWa,
    carryInCapitalLossLtWa: edited.carryIn
      ? display.carryInCapitalLossLtWa
      : stored.carryInCapitalLossLtWa,
    harvestPoolAmount: edited.harvest
      ? display.harvestPoolAmount
      : stored.harvestPoolAmount,
    harvestPoolBasisPct: edited.harvest
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
    conversion: Math.max(0, draw),
    stockSold: totalGain > 0 ? totalGain : 0,
    stockBasis: totalGain < 0 ? -totalGain : 0,
    qualifiedDividends: r2(
      state.ytdQualifiedDividends +
        state.remQualifiedDividends[kind] +
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
    // Gain harvest (v113): the console's pool facts ride
    // the pricer's own harvest dials ONLY while the
    // harvest toggle is on, so the pricer sizes the
    // harvest inside every pricing of the year — the zero-
    // draw pricings, the headline pricing, and every trial
    // pricing inside the cliff solver — and the solved
    // December draw is sized WITH the harvest included
    // (the draw shrinks by the harvested gain when the
    // cliff target binds). Toggle off passes the dials
    // absent, so the year prices bit-identically to
    // before. Toggle on with a fact still null passes that
    // dial absent too — the pricer then sizes no harvest,
    // and computeDecemberProjection carries the
    // gain-harvest-unpriced qualification on every case
    // instead of letting the $0 read as a priced answer.
    harvestPoolAmount: state.harvestOn
      ? (state.harvestPoolAmount ?? undefined)
      : undefined,
    harvestPoolBasisPct: state.harvestOn
      ? (state.harvestPoolBasisPct ?? undefined)
      : undefined,
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
  // carry-out. All $0 when no carry-in was entered.
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
  // Projected-tax-bill readouts (contract v50): the same
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
): DecemberProjectionResult {
  if (state.agePrimary == null || state.agePrimary <= 0) {
    return {
      ...UNPRICED,
      reason:
        "Enter the primary filer's age for the tax year — the year cannot be priced without it.",
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
  const enteredTotalBalance =
    state.pretaxBalancePrimary != null || state.pretaxBalanceSpouse != null
      ? r2((state.pretaxBalancePrimary ?? 0) + (state.pretaxBalanceSpouse ?? 0))
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
    // ACA reconciliation (round-7 fix B, contract v54):
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
    // The projected tax bill's net (contract v50, round-7
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
    };
  });

  const likelyCase = cases[1]!;
  const zeroDrawOverCliff = likelyCase.overCliffEvenAtZero;

  let headlineText: string;
  if (cliff == null) {
    headlineText = !likelyZero.aca.applies
      ? "No ACA cliff applies this year — everyone in the household is on Medicare, so there is no premium credit to protect and no cliff-sized draw to compute."
      : state.taxYear < 2026
        ? "No ACA cliff this year — the draw is not cliff-constrained."
        : "No ACA cliff to aim at — enter the ACA household size for the year to size the December draw.";
  } else if (zeroDrawOverCliff) {
    headlineText = `No December draw is safe this year: income already posted puts MAGI at ${fmt(likelyCase.nonDrawAcaMagi)}, over the ${fmt(cliff)} cliff before any draw — no draw can fix that year. The credit is lost in the likely case and the advance credit taken (${fmt(state.aptcTaken)}) is repaid.`;
  } else if (zeroBalanceBinds) {
    headlineText =
      "Take no December draw: the pre-tax balance is $0, so there is nothing to draw.";
  } else if (headlineDraw != null && headlineDraw <= 0) {
    headlineText = `Take no December draw: income already posted leaves no room under the cliff minus your ${fmt(state.bufferDollars)} buffer.`;
  } else {
    headlineText = `Maximum safe December draw: ${fmt(headlineDraw ?? 0)} — it lands MAGI at ${fmt(likelyCase.magiAtHeadline)}, ${fmt(Math.abs(likelyCase.distanceAtHeadline ?? 0))} under the ${fmt(cliff)} cliff in the likely case, keeping the credit.`;
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
    // Projected tax bill (contract v50): the round-3/4
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
    // verbatim (contract v54): the credit WAS priced, so
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
    // Contract v54: the reconciliation distinguishes a
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

  /* ---- Contract v103 fixtures: education credits (round-14 F3) ----
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

  /* ---- Contract v104 fixtures: January-paid capital-gain
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
    // Load resolution (v111): the record's carry-in is the
    // balance entering the plan's FIRST year, so it
    // resolves only when the console's tax year IS that
    // year; per field, null resolves and any entered value
    // (including $0) wins. Save derivation: an unedited
    // carry-in saves its STORED value, never the resolved
    // overlay.
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
    const otherYear = resolveDecemberStateAtLoad(
      { ...defaultDecemberState(2026), taxYear: 2027 },
      facts,
    );
    if (
      otherYear.carryInCapitalLossSt !== null ||
      otherYear.carryInCapitalLossLt !== null ||
      otherYear.carryInCapitalLossStWa !== null ||
      otherYear.carryInCapitalLossLtWa !== null
    ) {
      fail("no resolution should apply outside the plan's first year");
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
      carryIn: true,
    });
    exact(fail, "an edited save persists the console value", savedEdited.carryInCapitalLossLt, 10000);
    if (!decemberState.safeParse(resolved).success) {
      fail("the writer schema should accept resolved carry-in values");
    }
  });

  /* ---- Contract v112 fixtures: character splits on the
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

  /* ---- Contract v113 fixtures: the gain harvest
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
      harvest: true,
    });
    exact(fail, "an edited save persists the console pool", savedEdited.harvestPoolAmount, 40000);
    exact(fail, "an edited save persists the console basis", savedEdited.harvestPoolBasisPct, 75);
    if (!decemberState.safeParse(resolved).success) {
      fail("the writer schema should accept resolved harvest facts");
    }
  });

  return {
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    results,
  };
}
