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
    legacyRocSplitUnconfirmed: false,
    legacyJanPaidSplitUnconfirmed: false,
    legacyBeneficiaryAnswerUnconfirmed: false,
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
  },
): DecemberState {
  return {
    ...display,
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
  // APTC taken exceeds it. Null in every year when the final
  // credit is not priced (no benchmark entered, case under
  // the cliff).
  excessAptcRepayment: number | null;
  // The other side of the same reconciliation: when the APTC
  // taken is BELOW the final allowable credit, this further
  // credit is still due at filing. max(0, final credit − APTC
  // taken) in ALL years whenever the final credit is priced;
  // null only when the final credit is not priced.
  creditStillDue: number | null;
  // The headline repayment figure: excessAptcRepayment when
  // it is priced, else $0. Kept as the always-a-number field
  // the case cards lead with.
  repaymentExposure: number;
  federalTaxAtHeadline: number;
  totalTaxAtHeadline: number;
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
  // repay (excessAptcRepayment) — equivalently totalTax −
  // creditAtHeadline + APTC taken whenever the credit is
  // priced and the repayment is modeled. Null whenever
  // excessAptcRepayment is null (the credit is unpriced, or
  // a pre-2026 year whose APTC exceeds its final credit,
  // whose repayment is unmodeled) — no single settlement
  // figure is then shown. Negative = a net refund at filing.
  // The figure is BEFORE withholding and estimated payments,
  // which the console does not track.
  netSettleAtHeadline: number | null;
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
    // ACA reconciliation (round-7 fix B): creditStillDue
    // prices in ALL years whenever the final credit is
    // priced. The repayment: for 2026 and later there are
    // no repayment caps (P.L. 119-21 §71305) — every excess
    // APTC dollar is repaid, under the cliff as well as
    // over it. Before 2026 the capped-repayment rules are
    // not modeled: $0 when APTC taken is at or below the
    // final credit, null (unmodeled) when it exceeds it.
    const creditStillDue: number | null =
      finalCredit != null
        ? r2(Math.max(0, finalCredit - state.aptcTaken))
        : null;
    const excessAptcRepayment: number | null =
      finalCredit == null
        ? null
        : state.taxYear >= 2026
          ? r2(Math.max(0, state.aptcTaken - finalCredit))
          : state.aptcTaken <= finalCredit
            ? 0
            : null;
    // The projected tax bill's net (contract v50, round-7
    // fix B): the filing settlement for this case at the
    // headline draw — see the field's note on
    // DecemberCaseResult. Null whenever the repayment is
    // null, so no single figure is shown for a case whose
    // repayment is unmodeled or whose credit is unpriced.
    const netSettleAtHeadline: number | null =
      excessAptcRepayment == null
        ? null
        : r2(
            atHeadline.totalTax -
              (creditStillDue ?? 0) +
              excessAptcRepayment,
          );
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
      totalIncomeAtHeadline: atHeadline.agi,
      taxableIncomeAtHeadline: atHeadline.taxableIncome,
      stateTaxAtHeadline: atHeadline.stateTax,
      netSettleAtHeadline,
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
    // §224 senior deduction) = taxable income $43,842.58,
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
    // (ii) Partial APTC $5,000: $6,500 still due,
    // repayment $0, net $7,743 − $6,500 = $1,243.
    const partialState = base2025();
    partialState.aptcTaken = 5000;
    const partial = computeDecemberProjection(partialState).cases[1]!;
    exact(fail, "(ii) credit still due", partial.creditStillDue, 6500);
    exact(fail, "(ii) excess repayment", partial.excessAptcRepayment, 0);
    exact(fail, "(ii) net settle", partial.netSettleAtHeadline, 1243);
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
  });


  return {
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    results,
  };
}
