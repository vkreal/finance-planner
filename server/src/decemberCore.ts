import { z } from "@hatch/space-sdk";
import {
  pricePlaygroundYear,
  solvePlaygroundAcaCliffFill,
  type PlaygroundYearInputs,
} from "./rothOptimizer";
import type { FilingStatus } from "./taxEngine";
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
   settings under DECEMBER_STATE_KEY, stored as form state in
   the same plaintext style as the Playground's remembered form
   (roth_ui_state_v1) — so the December session can be reopened
   and adjusted as finals post, and the blob rides the ordinary
   backup export / restore settings array with no extra cases.
   Nothing in this module reads or writes any other view's
   state, and a fresh (default) console prices nothing and
   changes no existing figure. */

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
  ytdSsPrimary: z.number().finite().min(0),
  ytdSsSpouse: z.number().finite().min(0),
  // Remaining expected income (December stragglers), per line.
  remCapDist: decemberRange,
  remInterest: decemberRange,
  remOrdinaryDividends: decemberRange,
  remQualifiedDividends: decemberRange,
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
  // pretaxBalance is the LEGACY combined balance: readers
  // migrate it losslessly into the primary's split balance
  // (below) when a blob carries no split, and writers keep
  // it as the split's sum, so old and new blobs both read.
  pretaxBalance: z.number().finite().min(0).nullable(),
  // Per-owner prior-Dec-31 pre-tax balances (December fix):
  // each owner's RMD is computed on their own clock from
  // their own balance. Null = not entered for that owner.
  pretaxBalancePrimary: z.number().finite().min(0).nullable(),
  pretaxBalanceSpouse: z.number().finite().min(0).nullable(),
  // The part of this year's RMD already received (and
  // already inside the year-to-date income above): netted
  // from the computed RMD, floored at $0, so a paid RMD is
  // never counted twice.
  rmdAlreadyReceived: z.number().finite().min(0),
  spouseSoleBeneficiary: z.boolean(),
  // The SECOND beneficiary fact (round-3 fix): the primary
  // is the sole beneficiary of the SPOUSE's pre-tax
  // accounts. A separate fact from spouseSoleBeneficiary
  // above (the spouse is the PRIMARY's sole beneficiary —
  // it selects only the PRIMARY's RMD table). This fact
  // alone selects the SPOUSE's RMD table. False = not
  // established → her RMD prices on the Uniform Lifetime
  // Table (the conservative direction). Blobs written
  // before this field existed parse it at this false
  // default (see parseDecemberState).
  primarySoleBeneficiaryOfSpouse: z.boolean(),
  stateRatePct: z.number().finite().min(0).max(100),
  residenceState: z.enum(["WA", "other"]),
  itemizedMortgageInterest: z.number().finite().min(0),
  itemizedSaltPaid: z.number().finite().min(0),
  itemizedCharitable: z.number().finite().min(0),
  itemizedOther: z.number().finite().min(0),
  // Strays checklist (household-neutral wording in the view).
  strayCapDist: decemberStray,
  strayK1: decemberStray,
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
  strayAgiReducers: decemberStray,
  strayCoverage: decemberStray,
  strayTradeDate: decemberStray,
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
    rmdAlreadyReceived: 0,
    spouseSoleBeneficiary: true,
    primarySoleBeneficiaryOfSpouse: false,
    stateRatePct: 0,
    residenceState: "other",
    itemizedMortgageInterest: 0,
    itemizedSaltPaid: 0,
    itemizedCharitable: 0,
    itemizedOther: 0,
    strayCapDist: strayDefault(),
    strayK1: strayDefault(),
    strayTaxExempt: strayDefault(),
    strayDependent: strayDefault(),
    straySeverance: strayDefault(),
    strayLossHarvest: strayDefault(),
    strayCutoff: strayDefault(),
    strayJanPaid: strayDefault(),
    strayJanPaidQualifiedAmount: 0,
    strayDivInt: strayDefault(),
    strayPlannedSales: strayDefault(),
    strayROC: strayDefault(),
    strayROCOrdinary: strayDefault(),
    strayAgiReducers: strayDefault(),
    strayCoverage: strayDefault(),
    strayTradeDate: strayDefault(),
  };
}

/* Lenient read, field by field, in the Roth UI-state reader's
   style: any field of the wrong type or out of range falls back
   to its default, so a partial or malformed blob can never
   break the console — it just opens closer to blank. */
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
  // Pre-tax balances, split by owner (December fix). A blob
  // carrying either split field reads the split as written;
  // a blob carrying ONLY the legacy combined pretaxBalance
  // migrates it losslessly into the primary's split balance
  // (the spouse's defaults to not-entered), so a pre-split
  // blob prices its RMD exactly as it did — on the primary's
  // clock, over the whole combined balance. When a split is
  // present, the legacy combined field is re-derived as the
  // split's sum, keeping the two views of the money in step.
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
  if (splitPrimary.seen) out.pretaxBalancePrimary = splitPrimary.value;
  if (splitSpouse.seen) out.pretaxBalanceSpouse = splitSpouse.value;
  const legacyPretax = nullableNonNeg("pretaxBalance");
  if (legacyPretax.seen) out.pretaxBalance = legacyPretax.value;
  if (!splitPrimary.seen && !splitSpouse.seen && legacyPretax.seen) {
    out.pretaxBalancePrimary = legacyPretax.value;
  }
  if (splitPrimary.seen || splitSpouse.seen) {
    out.pretaxBalance =
      out.pretaxBalancePrimary == null && out.pretaxBalanceSpouse == null
        ? null
        : r2((out.pretaxBalancePrimary ?? 0) + (out.pretaxBalanceSpouse ?? 0));
  }
  nonNeg("rmdAlreadyReceived", (n) => (out.rmdAlreadyReceived = n));
  if (typeof p.spouseSoleBeneficiary === "boolean") {
    out.spouseSoleBeneficiary = p.spouseSoleBeneficiary;
  }
  // The second beneficiary fact, read leniently like its
  // sibling: absent on a pre-round-3 blob keeps the false
  // default (not established → the spouse's RMD prices
  // Uniform) — no reciprocity is ever inferred from the
  // sibling fact's stored value.
  if (typeof p.primarySoleBeneficiaryOfSpouse === "boolean") {
    out.primarySoleBeneficiaryOfSpouse = p.primarySoleBeneficiaryOfSpouse;
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
  stray("strayCapDist", (s) => (out.strayCapDist = s));
  stray("strayK1", (s) => (out.strayK1 = s));
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
  stray("strayDivInt", (s) => (out.strayDivInt = s));
  stray("strayPlannedSales", (s) => (out.strayPlannedSales = s));
  stray("strayROC", (s) => (out.strayROC = s));
  stray("strayROCOrdinary", (s) => (out.strayROCOrdinary = s));
  stray("strayAgiReducers", (s) => (out.strayAgiReducers = s));
  stray("strayCoverage", (s) => (out.strayCoverage = s));
  stray("strayTradeDate", (s) => (out.strayTradeDate = s));
  return out;
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

export function serializeDecemberState(
  state: DecemberState,
  revision: number,
): string {
  return JSON.stringify({ ...state, revision });
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
   dividend declared in October–December and paid in January
   is deemed received December 31 (§852(b)(7)), so it rides
   the dividends total, with its qualified portion riding
   the qualified-dividends subset like the year-to-date
   pair; money-market dividends from a cash sleeve and
   savings-bond interest ride interest; and the AGI reducers
   that actually work (deductible HSA contributions, pre-tax
   deferrals not already reflected in the wages above)
   subtract from other ordinary income — an assembly of the
   engine's existing dials, never new tax math. The K-1
   stray is signed (a deductible loss reduces ordinary
   income). A filing dependent's income does NOT join the
   parents' income at all: it rides the engine's ACA-only
   dependentMagiForAca channel, into the §36B household
   MAGI and nowhere else. The pre-tax balances go in split
   by owner, with the already-received RMD amount, so each
   owner's RMD prices on their own clock and a paid RMD is
   netted, never double-counted. The coverage-month stray
   carries NO income: it reduces the case's final allowable
   credit instead (see computeDecemberProjection), because
   eligibility is monthly. */
export function decemberCaseInputs(
  state: DecemberState,
  kind: DecemberCaseKind,
  draw: number,
): PlaygroundYearInputs {
  const joint = state.filingStatus === "mfj";
  const totalGain = r2(
    state.ytdCapitalGain +
      state.remCapDist[kind] +
      strayAmount(state.strayCapDist) +
      strayAmount(state.strayPlannedSales) +
      strayAmount(state.strayROC) -
      strayAmount(state.strayLossHarvest),
  );
  const otherOrdinary = r2(
    state.ytdOtherOrdinary +
      state.remOtherOrdinary[kind] +
      straySignedAmount(state.strayK1) +
      strayAmount(state.straySeverance) -
      strayAmount(state.strayAgiReducers),
  );
  const janPaid = strayAmount(state.strayJanPaid);
  // The qualified portion of the January-paid total: a
  // portion of that total (validated ≤ the total here, the
  // same clamp the year-to-date pair's split applies), never
  // an amount on top of it.
  const janPaidQualified =
    janPaid > 0
      ? Math.min(janPaid, Math.max(0, state.strayJanPaidQualifiedAmount))
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
        janPaid +
        strayAmount(state.strayROCOrdinary),
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
        janPaidQualified,
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
    educationStudents: null,
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
  // Excess-APTC repayment at the headline draw, for tax years
  // after 2025: there are NO repayment caps (P.L. 119-21
  // §71305), so ANY advance credit taken above the final
  // allowable credit is repaid in full — even when MAGI lands
  // UNDER the cliff. max(0, APTC taken − final credit); the
  // over-the-cliff case is the same formula at a $0 final
  // credit, i.e. the whole APTC taken. Null when the final
  // credit is not priced (no benchmark entered, case under
  // the cliff) or the tax year is 2025 or earlier, whose
  // capped-repayment rules this console does not price.
  excessAptcRepayment: number | null;
  // The other side of the same reconciliation: when the APTC
  // taken is BELOW the final allowable credit, this further
  // credit is still due at filing. max(0, final credit − APTC
  // taken); null under the same conditions as
  // excessAptcRepayment.
  creditStillDue: number | null;
  // The headline repayment figure: excessAptcRepayment when
  // it is priced, else $0. Kept as the always-a-number field
  // the case cards lead with.
  repaymentExposure: number;
  federalTaxAtHeadline: number;
  totalTaxAtHeadline: number;
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
    // Post-2025 reconciliation (P.L. 119-21 §71305): no
    // repayment caps — every excess APTC dollar is repaid,
    // under the cliff as well as over it.
    const excessAptcRepayment: number | null =
      state.taxYear >= 2026 && finalCredit != null
        ? r2(Math.max(0, state.aptcTaken - finalCredit))
        : null;
    const creditStillDue: number | null =
      state.taxYear >= 2026 && finalCredit != null
        ? r2(Math.max(0, finalCredit - state.aptcTaken))
        : null;
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
    // parses the new fact at its not-established default —
    // reciprocity is never inferred on read either.
    const legacy = parseDecemberState(
      JSON.stringify({ taxYear: 2026, spouseSoleBeneficiary: true }),
      2026,
    );
    if (legacy.primarySoleBeneficiaryOfSpouse !== false) {
      fail("a legacy blob must read the new beneficiary fact as not established");
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
    const legacy = parseDecemberState(
      JSON.stringify({ taxYear: 2026, pretaxBalance: 0 }),
      2026,
    );
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
    // enforce. A blob written before revisions existed reads
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
    // Fix A's migration: a pre-split blob carries only the
    // combined pretaxBalance — it migrates losslessly into
    // the primary's split balance, the spouse's defaults to
    // not-entered, and the combined field keeps its value,
    // so the blob prices exactly as it did.
    const legacy = parseDecemberState(
      JSON.stringify({ taxYear: 2026, pretaxBalance: 300000 }),
      2026,
    );
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


  return {
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    results,
  };
}
