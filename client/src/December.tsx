import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ApiResponse } from "./api";
import { usePersistedFold } from "./foldState";
import { FoldChevron } from "./FoldChevron";
import {
  fmtDollars,
  fmtMoneyInput,
  hintCls,
  InfoNote,
  inputCls,
  labelCls,
  moneyField,
  numField,
  pctField,
  sectionCls,
  type FilingStatus,
} from "./rothShared";
import { acaHouseholdSizeForYear } from "@space/server/taxEngine";
import {
  computeDecemberProjection,
  decemberBenchmarkTier,
  decemberNullableMoneyFormValue,
  decemberNullableMoneyFromFormValue,
  decemberStateForSave,
  decemberStoredProvenanceOf,
  defaultDecemberState,
  reresolveDecemberStateForYear,
  resolveDecemberStateAtLoad,
  snapshotFollowPrimaryCents,
  type DecemberCaseKind,
  type DecemberRecordFacts,
  type DecemberState,
  type DecemberStoredProvenance,
  type DecemberStray,
} from "@space/server/decemberCore";

/* Exact-cents dollar statement (build v192, re-audit
   round 3 SHOULD-3), used ONLY inside the projected tax
   bill: the priced figures the bill lists carry cents
   that the whole-dollar fmtDollars drops, so whole-dollar
   rows could not foot to the settlement — the stated
   federal tax row dropped the priced tax's sub-dollar
   cents, and the listed rows missed the settlement by
   exactly those cents. Stating every figure in the bill
   to the cent makes the listed rows sum to the settlement
   shown, line by line. Same shape as the Playground's
   fmtDollarsExact; every other surface keeps the
   whole-dollar fmtDollars. */
function fmtDollarsExact(dollars: number): string {
  const neg = dollars < 0;
  const s = `$${Math.abs(dollars).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
  return neg ? `−${s}` : s;
}

/* The December projection console — a year-end projection for
   a household managing MAGI against the ACA cliff. The form's
   inputs persist as one server blob (getDecemberProjection /
   saveDecemberProjection) so the December session reopens and
   adjusts as finals post; pricing runs through the shared
   single-year engine via decemberCore's
   computeDecemberProjection — the same code the server action
   and the accuracy fixtures run. On a first open (nothing
   stored yet) the year block is preseeded from the saved Tax
   Plan record where available; everything else starts blank.
   Saves carry the stored blob's revision (compare-and-swap):
   if the stored copy moved since this screen read it, the
   save is refused with the stored state instead of silently
   overwriting it, and this screen reloads that state. */

/* The form carries typed strings, like the Playground form;
   the saved state carries numbers. These two converters are
   the only boundary. A $0 amount shows blank, as on the other
   views' money dials — EXCEPT the four nullable money fields
   (the two per-owner pre-tax balances, the ACA benchmark,
   and the enrollment premium), where null (not entered) and
   $0 are different facts with different pricing: those four
   convert through decemberCore's nullable-money pair, which
   renders an entered $0 as "0" and reads blank back as null,
   so a known $0 round-trips as zero (round-2 fix 1). */
type RangeForm = { low: string; likely: string; high: string };
type StrayForm = { status: DecemberStray["status"]; amount: string };
type DecForm = {
  taxYear: string;
  filingStatus: FilingStatus;
  agePrimary: string;
  ageSpouse: string;
  onMedicarePrimary: boolean;
  onMedicareSpouse: boolean;
  ytdOtherOrdinary: string;
  ytdInterest: string;
  ytdOrdinaryDividends: string;
  ytdQualifiedDividends: string;
  ytdTaxExemptInterest: string;
  ytdCapitalGain: string;
  // Cost basis of the sales behind the year's gains
  // (build v127, round-19 finding 4): nullable money
  // like the carry-in fields — null (blank) and $0 are
  // distinct facts (no input yet vs explicitly no basis).
  saleBasis: string;
  // Capital losses carried into this year (build v111):
  // nullable money like the balances — null (blank) and $0
  // are distinct facts (no input yet vs explicitly none),
  // so these four convert through the nullable-money pair.
  carryInCapitalLossSt: string;
  carryInCapitalLossLt: string;
  carryInCapitalLossStWa: string;
  carryInCapitalLossLtWa: string;
  // Gain harvest (build v113): the toggle is a plain
  // boolean; the pool amount is nullable money like the
  // carry-in fields (blank vs $0 are distinct facts), and
  // the basis % is a plain string where blank = no input
  // yet (null in the state) and any entered number —
  // 100 included — is a fact.
  harvestOn: boolean;
  harvestPoolAmount: string;
  harvestPoolBasisPct: string;
  // Taxable cash for the year (build v125): nullable
  // money like the harvest pool amount (blank vs $0 are
  // distinct facts) — cash taken from taxable at 100%
  // basis, on top of the pre-tax draw, never part of it.
  taxableFunded: string;
  ytdSsPrimary: string;
  ytdSsSpouse: string;
  remCapDist: RangeForm;
  remInterest: RangeForm;
  remOrdinaryDividends: RangeForm;
  remQualifiedDividends: RangeForm;
  remOtherOrdinary: RangeForm;
  acaHouseholdSize: string;
  acaBenchmarkAnnual: string;
  acaEnrollmentPremiumAnnual: string;
  aptcTaken: string;
  bufferDollars: string;
  pretaxBalancePrimary: string;
  pretaxBalanceSpouse: string;
  rmdAlreadyReceived: string;
  spouseSoleBeneficiary: boolean;
  // Tri-state (round-4 fix): true / false are explicit
  // answers; null = not answered — the three states are
  // distinct in the saved state and in the form control.
  primarySoleBeneficiaryOfSpouse: boolean | null;
  stateRatePct: string;
  residenceState: "WA" | "other";
  itemizedMortgageInterest: string;
  itemizedSaltPaid: string;
  itemizedCharitable: string;
  itemizedOther: string;
  // Education students (build v103): the December tax
  // year's per-student qualified expenses as typed strings
  // plus the household's AOTC-eligible mark per student —
  // the same rows the Tax Plan record and the Playground
  // carry, in this console's own form units.
  educationStudents: { expenses: string; aotcEligible: boolean }[];
  strayCapDist: StrayForm;
  strayK1: StrayForm;
  // Long-term-capital-gain portion of the K-1 total
  // (build v112): a plain money string like the
  // January-paid portions beside it.
  strayK1CapGainAmount: string;
  strayTaxExempt: StrayForm;
  strayDependent: StrayForm;
  straySeverance: StrayForm;
  strayLossHarvest: StrayForm;
  strayCutoff: StrayForm;
  strayJanPaid: StrayForm;
  strayJanPaidQualifiedAmount: string;
  // Capital-gain-distribution portion of the January-paid
  // total (build v104): a plain money string like the
  // qualified portion beside it.
  strayJanPaidCapGainAmount: string;
  strayDivInt: StrayForm;
  strayPlannedSales: StrayForm;
  strayROC: StrayForm;
  strayROCOrdinary: StrayForm;
  // Qualified-dividends portion of the reclassified
  // return-of-capital amount (build v112): a plain
  // money string like the January-paid portions.
  strayROCQualifiedAmount: string;
  strayAgiReducers: StrayForm;
  strayCoverage: StrayForm;
  strayTradeDate: StrayForm;
  // Provenance, carried passively through the form:
  // whether the balance split is the console's own
  // explicit split, the two legacy character flags (they
  // drive the checklist notes), and the beneficiary-
  // answer confirm flag (round-6; it drives the note by
  // the beneficiary select). decemberStateForSave clears
  // a flag only when its own control was edited.
  pretaxSplitExplicit: boolean;
  legacyRocSplitUnconfirmed: boolean;
  legacyJanPaidSplitUnconfirmed: boolean;
  legacyBeneficiaryAnswerUnconfirmed: boolean;
};

/* The Tax Plan record facts load resolution draws on,
   in December dollars: the record's beneficiary answer
   and its per-owner pre-tax split. The primary's amount
   falls back to the snapshot-followed primary — the
   snapshot's pre-tax total MINUS an explicit spouse
   amount (snapshotFollowPrimaryCents, the same resolution
   the plan march applies) — never to the full snapshot,
   which would double-count the spouse's share (contract
   v127, round-19 finding 1). */
function recordFactsOf(
  data: ApiResponse<typeof api, "getRothPlanner"> | undefined,
  taxYear?: number,
): DecemberRecordFacts {
  const s = data?.saved;
  const primaryCents =
    s?.pretaxCents ??
    snapshotFollowPrimaryCents(
      data?.snapshot?.pretaxCents,
      s?.pretaxSpouseCents,
    );
  return {
    primarySoleBeneficiaryOfSpouse:
      s?.primarySoleBeneficiaryOfSpouse ?? null,
    pretaxBalancePrimary: primaryCents != null ? primaryCents / 100 : null,
    pretaxBalanceSpouse:
      s?.pretaxSpouseCents != null ? s.pretaxSpouseCents / 100 : null,
    // The record's entering capital-loss carryforward
    // (v111): the record's capitalLossCarryIn* Cents
    // converted to dollars, plus planFirstYear — the
    // record's execution year, the year that carry-in
    // enters. Load resolution applies the carry-in only
    // when the December year IS that year: the balance
    // enters the plan's first year, and the plan march
    // consumes it year by year, so a later December
    // year's entering balance is the march's remainder —
    // a figure the record does not carry (the build v127
    // widening to every later year re-applied the full
    // first-year balance and double-counted the consumed
    // part; engines review round 2, finding M-3). It
    // does not apply to a year before the plan's first
    // year either. Null per field when the record does
    // not answer.
    carryInCapitalLossSt:
      s?.capitalLossCarryInStCents != null
        ? s.capitalLossCarryInStCents / 100
        : null,
    carryInCapitalLossLt:
      s?.capitalLossCarryInLtCents != null
        ? s.capitalLossCarryInLtCents / 100
        : null,
    carryInCapitalLossStWa:
      s?.capitalLossCarryInStWaCents != null
        ? s.capitalLossCarryInStWaCents / 100
        : null,
    carryInCapitalLossLtWa:
      s?.capitalLossCarryInLtWaCents != null
        ? s.capitalLossCarryInLtWaCents / 100
        : null,
    planFirstYear: data?.execution?.executionYear ?? null,
    // The record's taxable-pool facts (v113): the pool the
    // plan march draws on — the record's entered taxable
    // balance when it carries one, otherwise the snapshot-
    // followed pool (Taxable + Cash buckets, less any
    // exclude-from-plan amount), exactly the pool
    // resolvePlanBalances assembles — and its basis: the
    // blended % of the record's basis tiers when it carries
    // tiers (Σ share × basis ÷ Σ share), otherwise its
    // entered basis %. A blank basis (no % and no tiers)
    // does not answer — the march's harvest is inert there
    // too. Null per field when the record does not answer.
    // S-8 (engines review round 2): these facts state the
    // pool AS IT STANDS when read — a CURRENT pool, already
    // shrunk by any of the year's sales that have happened.
    // The console's own harvestPoolAmount is a STARTING
    // pool (the start of the year, before the year's
    // sales), so load resolution converts these facts to
    // the starting pool before supplying them
    // (resolveDecemberStateAtLoad in decemberCore.ts);
    // these facts themselves keep the current-pool meaning.
    harvestPoolAmount:
      s?.taxableCents != null
        ? s.taxableCents / 100
        : data?.snapshot != null &&
            (data.snapshot.taxableCents != null ||
              data.snapshot.cashCents != null)
          ? Math.max(
              0,
              (data.snapshot.taxableCents ?? 0) +
                (data.snapshot.cashCents ?? 0) -
                Math.max(0, s?.taxableExcludeCents ?? 0),
            ) / 100
          : null,
    harvestPoolBasisPct: (() => {
      const tiers = s?.taxableTiers;
      if (tiers != null && tiers.length > 0) {
        const shareSum = tiers.reduce((a, t) => a + t.sharePct, 0);
        if (shareSum > 0) {
          return (
            tiers.reduce((a, t) => a + t.sharePct * t.basisPct, 0) / shareSum
          );
        }
      }
      return s?.taxableBasisPct ?? null;
    })(),
    // The record's entered education students for the
    // December tax year (v103): the record's per-year
    // cents entries filtered to that year and converted
    // to dollars — the December shape. Null when the
    // record carries no entries at all.
    educationStudents:
      s?.educationStudents != null
        ? s.educationStudents
            .filter((e) => taxYear == null || e.year === taxYear)
            .map((e) => ({
              expenses: e.expensesCents / 100,
              aotcEligible: e.aotcEligible === true,
            }))
        : null,
  };
}

const moneyStr = (n: number): string => (n === 0 ? "" : fmtMoneyInput(n));
const numStr = (n: number | null): string => (n == null ? "" : String(n));
const parseMoney = (s: string): number => {
  const cleaned = s.replace(/[$,\s]/g, "");
  if (cleaned === "") return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
};
const parseIntOrNull = (s: string): number | null => {
  const cleaned = s.replace(/\s/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n) : null;
};

function formFromState(s: DecemberState): DecForm {
  const rg = (r: DecemberState["remCapDist"]): RangeForm => ({
    low: moneyStr(r.low),
    likely: moneyStr(r.likely),
    high: moneyStr(r.high),
  });
  const st = (x: DecemberStray): StrayForm => ({
    status: x.status,
    amount: moneyStr(x.amount),
  });
  return {
    taxYear: String(s.taxYear),
    filingStatus: s.filingStatus,
    agePrimary: numStr(s.agePrimary),
    ageSpouse: numStr(s.ageSpouse),
    onMedicarePrimary: s.onMedicarePrimary,
    onMedicareSpouse: s.onMedicareSpouse,
    ytdOtherOrdinary: moneyStr(s.ytdOtherOrdinary),
    ytdInterest: moneyStr(s.ytdInterest),
    ytdOrdinaryDividends: moneyStr(s.ytdOrdinaryDividends),
    ytdQualifiedDividends: moneyStr(s.ytdQualifiedDividends),
    ytdTaxExemptInterest: moneyStr(s.ytdTaxExemptInterest),
    ytdCapitalGain: moneyStr(s.ytdCapitalGain),
    saleBasis: decemberNullableMoneyFormValue(s.saleBasis),
    // Carry-in losses render through the nullable-money
    // converter like the balances: null shows blank, an
    // entered $0 shows "0" — the distinction is a fact.
    carryInCapitalLossSt: decemberNullableMoneyFormValue(s.carryInCapitalLossSt),
    carryInCapitalLossLt: decemberNullableMoneyFormValue(s.carryInCapitalLossLt),
    carryInCapitalLossStWa: decemberNullableMoneyFormValue(s.carryInCapitalLossStWa),
    carryInCapitalLossLtWa: decemberNullableMoneyFormValue(s.carryInCapitalLossLtWa),
    harvestOn: s.harvestOn,
    harvestPoolAmount: decemberNullableMoneyFormValue(s.harvestPoolAmount),
    taxableFunded: decemberNullableMoneyFormValue(s.taxableFunded),
    harvestPoolBasisPct:
      s.harvestPoolBasisPct == null ? "" : String(s.harvestPoolBasisPct),
    ytdSsPrimary: moneyStr(s.ytdSsPrimary),
    ytdSsSpouse: moneyStr(s.ytdSsSpouse),
    remCapDist: rg(s.remCapDist),
    remInterest: rg(s.remInterest),
    remOrdinaryDividends: rg(s.remOrdinaryDividends),
    remQualifiedDividends: rg(s.remQualifiedDividends),
    remOtherOrdinary: rg(s.remOtherOrdinary),
    acaHouseholdSize: numStr(s.acaHouseholdSize),
    // The four nullable money fields render through the
    // nullable-money converter: null shows blank, an
    // entered $0 shows "0" — never the generic moneyStr,
    // whose $0-shows-blank would erase the distinction.
    acaBenchmarkAnnual: decemberNullableMoneyFormValue(s.acaBenchmarkAnnual),
    acaEnrollmentPremiumAnnual: decemberNullableMoneyFormValue(
      s.acaEnrollmentPremiumAnnual,
    ),
    aptcTaken: moneyStr(s.aptcTaken),
    bufferDollars: fmtMoneyInput(s.bufferDollars),
    pretaxBalancePrimary: decemberNullableMoneyFormValue(s.pretaxBalancePrimary),
    pretaxBalanceSpouse: decemberNullableMoneyFormValue(s.pretaxBalanceSpouse),
    rmdAlreadyReceived: moneyStr(s.rmdAlreadyReceived),
    spouseSoleBeneficiary: s.spouseSoleBeneficiary,
    primarySoleBeneficiaryOfSpouse: s.primarySoleBeneficiaryOfSpouse,
    stateRatePct: String(s.stateRatePct),
    residenceState: s.residenceState,
    itemizedMortgageInterest: moneyStr(s.itemizedMortgageInterest),
    itemizedSaltPaid: moneyStr(s.itemizedSaltPaid),
    itemizedCharitable: moneyStr(s.itemizedCharitable),
    itemizedOther: moneyStr(s.itemizedOther),
    educationStudents: (s.educationStudents ?? []).map((x) => ({
      expenses: moneyStr(x.expenses),
      aotcEligible: x.aotcEligible,
    })),
    strayCapDist: st(s.strayCapDist),
    strayK1: st(s.strayK1),
    strayK1CapGainAmount: moneyStr(s.strayK1CapGainAmount),
    strayTaxExempt: st(s.strayTaxExempt),
    strayDependent: st(s.strayDependent),
    straySeverance: st(s.straySeverance),
    strayLossHarvest: st(s.strayLossHarvest),
    strayCutoff: st(s.strayCutoff),
    strayJanPaid: st(s.strayJanPaid),
    strayJanPaidQualifiedAmount: moneyStr(s.strayJanPaidQualifiedAmount),
    strayJanPaidCapGainAmount: moneyStr(s.strayJanPaidCapGainAmount),
    strayDivInt: st(s.strayDivInt),
    strayPlannedSales: st(s.strayPlannedSales),
    strayROC: st(s.strayROC),
    strayROCOrdinary: st(s.strayROCOrdinary),
    strayROCQualifiedAmount: moneyStr(s.strayROCQualifiedAmount),
    strayAgiReducers: st(s.strayAgiReducers),
    strayCoverage: st(s.strayCoverage),
    strayTradeDate: st(s.strayTradeDate),
    pretaxSplitExplicit: s.pretaxSplitExplicit,
    legacyRocSplitUnconfirmed: s.legacyRocSplitUnconfirmed,
    legacyJanPaidSplitUnconfirmed: s.legacyJanPaidSplitUnconfirmed,
    legacyBeneficiaryAnswerUnconfirmed: s.legacyBeneficiaryAnswerUnconfirmed,
  };
}

function stateFromForm(f: DecForm): DecemberState {
  const clamp0 = (n: number) => Math.max(0, n);
  const rg = (r: RangeForm) => ({
    low: parseMoney(r.low),
    likely: parseMoney(r.likely),
    high: parseMoney(r.high),
  });
  // The unsigned remaining-income ranges (build v66,
  // boundary audit F5): the same clamp0 the unsigned YTD
  // fields below already get — interest, dividends, and
  // capital distributions still to come are never negative.
  // remOtherOrdinary keeps rg: it is signed by design.
  const rg0 = (r: RangeForm) => ({
    low: clamp0(parseMoney(r.low)),
    likely: clamp0(parseMoney(r.likely)),
    high: clamp0(parseMoney(r.high)),
  });
  const st = (x: StrayForm): DecemberStray => ({
    status: x.status,
    amount: clamp0(parseMoney(x.amount)),
  });
  // The K-1 stray is the one signed stray: a deductible K-1
  // loss is negative income, so its amount keeps its sign.
  const stSigned = (x: StrayForm): DecemberStray => ({
    status: x.status,
    amount: parseMoney(x.amount),
  });
  const size = parseIntOrNull(f.acaHouseholdSize);
  return {
    taxYear: parseIntOrNull(f.taxYear) ?? new Date().getFullYear(),
    filingStatus: f.filingStatus,
    agePrimary: parseIntOrNull(f.agePrimary),
    ageSpouse: f.filingStatus === "mfj" ? parseIntOrNull(f.ageSpouse) : null,
    onMedicarePrimary: f.onMedicarePrimary,
    onMedicareSpouse: f.filingStatus === "mfj" ? f.onMedicareSpouse : false,
    ytdOtherOrdinary: parseMoney(f.ytdOtherOrdinary),
    ytdInterest: clamp0(parseMoney(f.ytdInterest)),
    ytdOrdinaryDividends: clamp0(parseMoney(f.ytdOrdinaryDividends)),
    ytdQualifiedDividends: clamp0(parseMoney(f.ytdQualifiedDividends)),
    ytdTaxExemptInterest: clamp0(parseMoney(f.ytdTaxExemptInterest)),
    ytdCapitalGain: parseMoney(f.ytdCapitalGain),
    saleBasis: (() => {
      const n = decemberNullableMoneyFromFormValue(f.saleBasis);
      return n == null ? null : clamp0(n);
    })(),
    carryInCapitalLossSt: (() => {
      const n = decemberNullableMoneyFromFormValue(f.carryInCapitalLossSt);
      return n == null ? null : clamp0(n);
    })(),
    carryInCapitalLossLt: (() => {
      const n = decemberNullableMoneyFromFormValue(f.carryInCapitalLossLt);
      return n == null ? null : clamp0(n);
    })(),
    carryInCapitalLossStWa: (() => {
      const n = decemberNullableMoneyFromFormValue(f.carryInCapitalLossStWa);
      return n == null ? null : clamp0(n);
    })(),
    carryInCapitalLossLtWa: (() => {
      const n = decemberNullableMoneyFromFormValue(f.carryInCapitalLossLtWa);
      return n == null ? null : clamp0(n);
    })(),
    harvestOn: f.harvestOn,
    harvestPoolAmount: (() => {
      const n = decemberNullableMoneyFromFormValue(f.harvestPoolAmount);
      return n == null ? null : clamp0(n);
    })(),
    harvestPoolBasisPct:
      f.harvestPoolBasisPct.trim() === ""
        ? null
        : Math.min(100, clamp0(parseMoney(f.harvestPoolBasisPct))),
    taxableFunded: (() => {
      const n = decemberNullableMoneyFromFormValue(f.taxableFunded);
      return n == null ? null : clamp0(n);
    })(),
    ytdSsPrimary: clamp0(parseMoney(f.ytdSsPrimary)),
    ytdSsSpouse: f.filingStatus === "mfj" ? clamp0(parseMoney(f.ytdSsSpouse)) : 0,
    remCapDist: rg0(f.remCapDist),
    remInterest: rg0(f.remInterest),
    remOrdinaryDividends: rg0(f.remOrdinaryDividends),
    remQualifiedDividends: rg0(f.remQualifiedDividends),
    remOtherOrdinary: rg(f.remOtherOrdinary),
    acaHouseholdSize: size != null && size >= 1 && size <= 20 ? size : null,
    acaBenchmarkAnnual: (() => {
      const n = decemberNullableMoneyFromFormValue(f.acaBenchmarkAnnual);
      return n == null ? null : clamp0(n);
    })(),
    acaEnrollmentPremiumAnnual: (() => {
      const n = decemberNullableMoneyFromFormValue(f.acaEnrollmentPremiumAnnual);
      return n == null ? null : clamp0(n);
    })(),
    aptcTaken: clamp0(parseMoney(f.aptcTaken)),
    bufferDollars: clamp0(parseMoney(f.bufferDollars)),
    pretaxBalancePrimary: (() => {
      const n = decemberNullableMoneyFromFormValue(f.pretaxBalancePrimary);
      return n == null ? null : clamp0(n);
    })(),
    pretaxBalanceSpouse: (() => {
      const n = decemberNullableMoneyFromFormValue(f.pretaxBalanceSpouse);
      return n == null ? null : clamp0(n);
    })(),
    // The legacy combined field is derived as the split's
    // sum, so the saved blob's two views of the money agree.
    pretaxBalance: (() => {
      const prim = decemberNullableMoneyFromFormValue(f.pretaxBalancePrimary);
      const sp = decemberNullableMoneyFromFormValue(f.pretaxBalanceSpouse);
      if (prim == null && sp == null) return null;
      return clamp0(prim ?? 0) + clamp0(sp ?? 0);
    })(),
    rmdAlreadyReceived: clamp0(parseMoney(f.rmdAlreadyReceived)),
    spouseSoleBeneficiary: f.spouseSoleBeneficiary,
    primarySoleBeneficiaryOfSpouse: f.primarySoleBeneficiaryOfSpouse,
    stateRatePct: Math.min(100, clamp0(parseMoney(f.stateRatePct))),
    residenceState: f.residenceState,
    itemizedMortgageInterest: clamp0(parseMoney(f.itemizedMortgageInterest)),
    itemizedSaltPaid: clamp0(parseMoney(f.itemizedSaltPaid)),
    itemizedCharitable: clamp0(parseMoney(f.itemizedCharitable)),
    itemizedOther: clamp0(parseMoney(f.itemizedOther)),
    // Education students (v103): the form's rows ARE the
    // entered answer whenever the form was hydrated from
    // an entered list — stateFromForm always returns a
    // list (never null), and decemberStateForSave decides
    // whether this list or the stored value is what saves
    // (a record-resolved overlay saves the stored null
    // until the user edits these controls).
    educationStudents: f.educationStudents.map((x) => ({
      expenses: clamp0(parseMoney(x.expenses)),
      aotcEligible: x.aotcEligible,
    })),
    strayCapDist: st(f.strayCapDist),
    strayK1: stSigned(f.strayK1),
    strayK1CapGainAmount: clamp0(parseMoney(f.strayK1CapGainAmount)),
    strayTaxExempt: st(f.strayTaxExempt),
    strayDependent: st(f.strayDependent),
    straySeverance: st(f.straySeverance),
    strayLossHarvest: st(f.strayLossHarvest),
    strayCutoff: st(f.strayCutoff),
    strayJanPaid: st(f.strayJanPaid),
    strayJanPaidQualifiedAmount: clamp0(parseMoney(f.strayJanPaidQualifiedAmount)),
    strayJanPaidCapGainAmount: clamp0(parseMoney(f.strayJanPaidCapGainAmount)),
    strayDivInt: st(f.strayDivInt),
    strayPlannedSales: st(f.strayPlannedSales),
    strayROC: st(f.strayROC),
    strayROCOrdinary: st(f.strayROCOrdinary),
    strayROCQualifiedAmount: clamp0(parseMoney(f.strayROCQualifiedAmount)),
    strayAgiReducers: st(f.strayAgiReducers),
    strayCoverage: st(f.strayCoverage),
    strayTradeDate: st(f.strayTradeDate),
    pretaxSplitExplicit: f.pretaxSplitExplicit,
    legacyRocSplitUnconfirmed: f.legacyRocSplitUnconfirmed,
    legacyJanPaidSplitUnconfirmed: f.legacyJanPaidSplitUnconfirmed,
    legacyBeneficiaryAnswerUnconfirmed: f.legacyBeneficiaryAnswerUnconfirmed,
  };
}

const CASE_LABELS: Record<DecemberCaseKind, string> = {
  low: "Low",
  likely: "Likely",
  high: "High",
};

/* Build v207 (re-audit round 4 SHOULD R4-S7): how long the
   December console's deferred unmount flush (see
   deferredDecFlushRef below) waits for the in-flight save it
   queued behind to settle before firing anyway — the same
   bound, and the same name, as the other views'
   DEFERRED_FLUSH_GIVE_UP_MS (build v196). */
const DEFERRED_FLUSH_GIVE_UP_MS = 30000;

export function December() {
  const decQ = useQuery({
    queryKey: ["decemberprojection"],
    queryFn: () => api.getDecemberProjection({}),
  });
  const rothQ = useQuery({
    queryKey: ["rothplanner"],
    queryFn: () => api.getRothPlanner({}),
  });
  // Retirement calculator (build v126): only for the
  // "enough for the year" comparison's spending fallback —
  // the Tax Plan record's annual spending, falling back to
  // this default. Read-only; it never blocks the console
  // (the comparison row hides until it resolves).
  const retQ = useQuery({
    queryKey: ["retirementcalc"],
    queryFn: () => api.getRetirementCalc({}),
  });
  const queryClient = useQueryClient();
  const saveMut = useMutation({
    mutationFn: (state: DecemberState) =>
      api.saveDecemberProjection({ state, baseRevision: revisionRef.current }),
    onSuccess: (res, variables) => {
      if (res.ok) {
        revisionRef.current = res.revision;
        // The saved state is the new provenance baseline:
        // whatever it holds for the beneficiary fact and
        // the balance split is now the stored truth the
        // next save preserves.
        storedProvenanceRef.current = decemberStoredProvenanceOf(variables);
        queryClient.invalidateQueries({ queryKey: ["decemberprojection"] });
        return;
      }
      // Compare-and-swap conflict: the stored copy moved
      // since this screen read it (another tab or device
      // saved first). Reload the stored state into the form
      // instead of overwriting it, and say so plainly. An
      // unanswered second beneficiary fact in that state
      // resolves from the Tax Plan record exactly as at
      // first load (display only — nothing is written).
      // The reloaded form is NOT a user edit: clear the
      // dirty flag before replacing it, or the autosave
      // effect would immediately cycle "Saving…" over the
      // conflict note below and re-save the stored state
      // (build v63, December save-note fix — the note
      // must survive until the user's next real edit).
      dirtyRef.current = false;
      // Build v207 (re-audit round 4 SHOULD R4-S7): the
      // conflict is the deliberate drop for the save-path
      // machinery below too — the queued payload and any
      // flush deferred behind this save are this same stale
      // form's snapshots, so both are dropped here and
      // neither is ever retried or flushed over the stored
      // state just reloaded.
      pendingDecSaveRef.current = null;
      deferredDecFlushRef.current = null;
      if (deferredDecFlushGiveUpTimerRef.current != null) {
        window.clearTimeout(deferredDecFlushGiveUpTimerRef.current);
        deferredDecFlushGiveUpTimerRef.current = null;
      }
      revisionRef.current = res.revision;
      storedProvenanceRef.current = decemberStoredProvenanceOf(res.state);
      setBeneficiaryEdited(false);
      setBalancesEdited(false);
      setRocCharacterEdited(false);
      setJanPaidCharacterEdited(false);
      setEducationEdited(false);
      setCarryInStEdited(false);
      setCarryInLtEdited(false);
      setCarryInStWaEdited(false);
      setCarryInLtWaEdited(false);
      setHarvestPoolAmountEdited(false);
      setHarvestPoolBasisPctEdited(false);
      setForm(
        formFromState(
          resolveDecemberStateAtLoad(
            res.state,
            recordFactsOf(rothQ.data, res.state.taxYear),
          ),
        ),
      );
      setSaveNote(
        res.storedUnreadable
          ? "Your saved December entries can’t be read, so this edit wasn’t saved over them — the stored record is left exactly as it is."
          : "These entries were changed in another tab or on another device, so your last edit wasn’t saved over them — the saved entries are shown now.",
      );
    },
  });

  const [form, setForm] = useState<DecForm | null>(null);
  const hydratedRef = useRef(false);
  const dirtyRef = useRef(false);
  /* Build v207 (re-audit round 4 SHOULD R4-S7): the save-path
     machinery the other views' writers carry (MUST-3/4/5,
     SHOULD-6), which this console lacked entirely — before
     v207 its autosave was a bare debounce whose cleanup only
     cleared the timer, so an edit made within the 700 ms
     debounce and followed by "← Tax Plan" (which unmounts
     this console) was never sent, and a failed save never
     retried. The autosave effect below now stores every
     payload it builds in pendingDecSaveRef, so the payload
     survives its debounce timer; sends run through
     sendDecSave, whose per-call handlers own the queue
     (success drops the payload, error re-arms a 3 s retry of
     it on the shared decSaveTimerRef — the same timer the
     debounce arms, so a newer edit's effect run supersedes a
     pending retry exactly as a newer payload supersedes a
     queued one in the other writers); and the unmount flush
     effect at the end of the save path sends whatever is
     still queued as the console goes away. */
  const pendingDecSaveRef = useRef<DecemberState | null>(null);
  // The shared save timer: the autosave debounce and the
  // failed-save retry both arm it (see above).
  const decSaveTimerRef = useRef<number | null>(null);
  // The payload currently in flight, so the unmount flush
  // can tell "queued behind the in-flight save" (a newer
  // edit — flush it) from "the in-flight save itself"
  // (already being written — the queue stays populated until
  // a save succeeds, so the pending payload may BE it).
  const decSaveInFlightRef = useRef(false);
  const decSaveInFlightPayloadRef = useRef<DecemberState | null>(null);
  // A flush deferred behind the in-flight save (the S-3
  // pattern): the unmount cleanup, finding a payload queued
  // behind a save still in flight, stores its send here
  // instead of firing it concurrently under the same
  // not-yet-advanced CAS base — the server accepts exactly
  // one of two same-base saves and refuses the other, and a
  // refused flush is lost silently (its conflict path runs
  // on an unmounted view). The in-flight call's per-call
  // handlers consume the slot as that save settles — fire on
  // a landed save (the mutation reads the NEW base) or on
  // an error (base unchanged; the queued save supersedes
  // the failed one), drop on a conflict (the mutation-level
  // conflict path above has already dropped it there).
  const deferredDecFlushRef = useRef<(() => void) | null>(null);
  // The deferred slot's give-up timer (build v196's shape):
  // armed as the cleanup stores the deferred send; if the
  // in-flight save never settles (a hung request — neither
  // handler ever runs), the timer consumes the slot itself
  // and fires the deferred send anyway through the retrying
  // flush send, so the edit is sent, a failure of that send
  // re-arms the flush's own 3 s retry, and a CAS conflict
  // from sending while the wedged save is still in flight
  // resolves through the mutation's normal conflict path
  // instead of stranding the edit. A settle that lands
  // first consumes the slot through takeDeferredDecFlush,
  // which clears this timer. The timer lives in its own
  // ref, cleared by nothing after unmount, so it outlives
  // the view like the flush retry timer.
  const deferredDecFlushGiveUpTimerRef = useRef<number | null>(null);
  // The unmount flush's own retry timer (MUST-3's shape): a
  // flush whose request fails re-arms a 3 s retry of the
  // same payload on THIS timer — never the shared save
  // timer, which the unmount cleanup clears as it runs — so
  // the retries outlive the view until the flush lands.
  const decFlushRetryTimerRef = useRef<number | null>(null);
  // Round-5 provenance: the STORED blob's own beneficiary
  // fact and balance split (before load resolution), and
  // whether the user has edited those controls in this
  // console since hydration. Every autosave derives its
  // state through decemberStateForSave, which restores
  // the stored values for anything not edited here — so
  // a record-resolved (inherited) value is displayed and
  // priced, but never becomes the console's saved answer
  // just because another field was edited.
  const storedProvenanceRef = useRef<DecemberStoredProvenance>({
    // The stamp is the tax year of the saved blob the stored
    // values were saved for (internal review round 4,
    // SHOULD-1). The placeholder below is replaced at
    // hydration, before any year change can read it; the
    // current year is the honest placeholder for a fresh
    // console.
    taxYear: new Date().getFullYear(),
    primarySoleBeneficiaryOfSpouse: null,
    pretaxBalancePrimary: null,
    pretaxBalanceSpouse: null,
    pretaxBalance: null,
    pretaxSplitExplicit: false,
    legacyBeneficiaryAnswerUnconfirmed: false,
    legacyRocSplitUnconfirmed: false,
    legacyJanPaidSplitUnconfirmed: false,
    educationStudents: null,
    carryInCapitalLossSt: null,
    carryInCapitalLossLt: null,
    carryInCapitalLossStWa: null,
    carryInCapitalLossLtWa: null,
    harvestPoolAmount: null,
    harvestPoolBasisPct: null,
  });
  const [beneficiaryEdited, setBeneficiaryEdited] = useState(false);
  const [balancesEdited, setBalancesEdited] = useState(false);
  // Education provenance (v103): whether the user has
  // edited the education controls in this console since
  // hydration — until then a save preserves the stored
  // education value, so a Tax Plan record overlay (or the
  // first-open preseed's stored value) is what governs,
  // exactly like the beneficiary fact.
  const [educationEdited, setEducationEdited] = useState(false);
  // Carry-in provenance (v111, per field round-17 defect
  // 3): whether the user has edited EACH capital-loss
  // carry-in field in this console since hydration — until
  // then a save preserves the stored carry-in values, so a
  // Tax Plan record overlay for the plan's first year is
  // displayed and priced but never becomes the console's
  // saved answer. One flag per field: editing the long-
  // term field saves only that field, never the untouched
  // short-term one beside it.
  const [carryInStEdited, setCarryInStEdited] = useState(false);
  const [carryInLtEdited, setCarryInLtEdited] = useState(false);
  const [carryInStWaEdited, setCarryInStWaEdited] = useState(false);
  const [carryInLtWaEdited, setCarryInLtWaEdited] = useState(false);
  // Harvest provenance (v113, per field round-17 defect
  // 3): whether the user has edited EACH harvest fact in
  // this console since hydration — until then a save
  // preserves the stored pool facts, so a Tax Plan record
  // overlay is displayed and priced but never becomes the
  // console's saved answer. One flag per fact: editing the
  // pool amount saves only that fact, never the untouched
  // basis % beside it. The toggle itself is not
  // provenance: it always saves as displayed.
  const [harvestPoolAmountEdited, setHarvestPoolAmountEdited] =
    useState(false);
  const [harvestPoolBasisPctEdited, setHarvestPoolBasisPctEdited] =
    useState(false);
  // Round-6: whether the user has edited each tax-
  // character control in this console since hydration —
  // the matching legacy character flag clears only on
  // its own edit (decemberStateForSave).
  const [rocCharacterEdited, setRocCharacterEdited] = useState(false);
  const [janPaidCharacterEdited, setJanPaidCharacterEdited] = useState(false);
  // The revision of the stored blob this screen's form was
  // read at; every save passes it as the base revision.
  const revisionRef = useRef(0);
  const [saveNote, setSaveNote] = useState<string>("");
  const [resetArmed, setResetArmed] = useState(false);
  const [detailOpen, setDetailOpen] = usePersistedFold("december.detail", false);
  // The projected tax bill's income lines (total income →
  // MAGI → taxable income) sit behind the bill block's own
  // fold; the tax, credit, and net lines always show.
  const [billIncomeOpen, setBillIncomeOpen] = usePersistedFold(
    "december.billIncome",
    false,
  );

  /* Hydrate once from the stored blob. On a first-ever open
     (nothing stored) preseed the year block from the saved Tax
     Plan record where available, and save that preseed so the
     session reopens on it. On a stored open, an UNANSWERED
     (null) second beneficiary fact is resolved at load from
     the Tax Plan record (round-4 fix, resolveDecemberStateAtLoad
     in decemberCore): the record's explicit true/false supplies
     the effective value for display and pricing, an explicit
     console value is never overwritten, and the resolution is
     display-only — dirtyRef stays unset, so opening the
     console never rewrites the stored blob; it changes only
     when the user saves in the console. */
  useEffect(() => {
    if (hydratedRef.current) return;
    if (!decQ.data) return;
    // The preseed (first open) and the load-time resolution of
    // an unanswered beneficiary fact (any open) both read the
    // Tax Plan record — wait for that read to settle before
    // hydrating, so neither is skipped just for losing a race.
    // A stored console whose fact is explicitly answered needs
    // no record and hydrates immediately.
    const needsRecord =
      !decQ.data.hasStored ||
      decQ.data.state.primarySoleBeneficiaryOfSpouse == null ||
      decQ.data.state.educationStudents == null ||
      decQ.data.state.carryInCapitalLossSt == null ||
      decQ.data.state.carryInCapitalLossLt == null ||
      decQ.data.state.carryInCapitalLossStWa == null ||
      decQ.data.state.carryInCapitalLossLtWa == null ||
      decQ.data.state.harvestPoolAmount == null ||
      decQ.data.state.harvestPoolBasisPct == null ||
      (!decQ.data.state.pretaxSplitExplicit &&
        decQ.data.state.pretaxBalance != null);
    if (needsRecord && rothQ.isPending) return;
    hydratedRef.current = true;
    revisionRef.current = decQ.data.revision;
    // The stored blob's own provenance, captured BEFORE
    // resolution: saves preserve these values for any
    // field the user does not edit here (round-5).
    storedProvenanceRef.current = decemberStoredProvenanceOf(decQ.data.state);
    setBeneficiaryEdited(false);
    setBalancesEdited(false);
    setRocCharacterEdited(false);
    setJanPaidCharacterEdited(false);
    setEducationEdited(false);
    setCarryInStEdited(false);
    setCarryInLtEdited(false);
    setCarryInStWaEdited(false);
    setCarryInLtWaEdited(false);
    setHarvestPoolAmountEdited(false);
    setHarvestPoolBasisPctEdited(false);
    let initial = formFromState(
      decQ.data.hasStored
        ? resolveDecemberStateAtLoad(
            decQ.data.state,
            recordFactsOf(rothQ.data, decQ.data.state.taxYear),
          )
        : decQ.data.state,
    );
    if (!decQ.data.hasStored && rothQ.data) {
      const s = rothQ.data.saved;
      const snap = rothQ.data.snapshot;
      const year = decQ.data.state.taxYear;
      if (s) {
        const size =
          s.acaHouseholdSize != null
            ? acaHouseholdSizeForYear(s.acaHouseholdSize, s.acaHouseholdSchedule ?? null, year)
            : null;
        // The benchmark tier keys on WHO is on the
        // marketplace, never on household size alone —
        // the same selection the long-horizon engine makes
        // (decemberBenchmarkTier pins it): both spouses on
        // ACA take the family tier at household size 3+ and
        // the couple tier below; one spouse on ACA takes
        // the single tier at any household size.
        const tier = decemberBenchmarkTier({
          filingStatus: s.filingStatus ?? "mfj",
          householdSize: size,
          onMedicarePrimary:
            s.birthYearPrimary != null ? year - s.birthYearPrimary >= 65 : false,
          onMedicareSpouse:
            s.birthYearSpouse != null ? year - s.birthYearSpouse >= 65 : false,
        });
        const benchmarkCents =
          tier === "family"
            ? (s.acaBenchmarkFamilyCents ?? s.acaBenchmarkCoupleCents)
            : tier === "couple"
              ? s.acaBenchmarkCoupleCents
              : tier === "single"
                ? s.acaBenchmarkSingleCents
                : null;
        // Each owner's pre-tax balance seeds their own
        // field — the record's own fields, never summed —
        // so each owner's RMD prices on their own clock.
        // A null record primary follows the snapshot MINUS
        // an explicit spouse amount (build v127,
        // round-19 finding 1): the full snapshot is the
        // household's total, not the primary's alone.
        const primaryPretaxCents =
          s.pretaxCents ??
          snapshotFollowPrimaryCents(snap?.pretaxCents, s.pretaxSpouseCents);
        const spousePretaxCents = s.pretaxSpouseCents ?? null;
        initial = {
          ...initial,
          filingStatus: s.filingStatus ?? initial.filingStatus,
          agePrimary:
            s.birthYearPrimary != null ? String(year - s.birthYearPrimary) : initial.agePrimary,
          ageSpouse:
            s.birthYearSpouse != null ? String(year - s.birthYearSpouse) : initial.ageSpouse,
          onMedicarePrimary:
            s.birthYearPrimary != null ? year - s.birthYearPrimary >= 65 : initial.onMedicarePrimary,
          onMedicareSpouse:
            s.birthYearSpouse != null ? year - s.birthYearSpouse >= 65 : initial.onMedicareSpouse,
          acaHouseholdSize: size != null ? String(size) : initial.acaHouseholdSize,
          acaBenchmarkAnnual:
            benchmarkCents != null ? fmtMoneyInput(benchmarkCents / 100) : initial.acaBenchmarkAnnual,
          stateRatePct: s.stateRatePct != null ? String(s.stateRatePct) : initial.stateRatePct,
          residenceState: s.residenceState ?? initial.residenceState,
          spouseSoleBeneficiary: s.spouseSoleBeneficiary ?? initial.spouseSoleBeneficiary,
          // The second beneficiary fact preseeds from the
          // plan record when the record carries it; absent
          // there (null on any record written before it
          // existed) the form keeps its unset default —
          // not established, so the spouse's RMD prices on
          // the Uniform table.
          primarySoleBeneficiaryOfSpouse:
            s.primarySoleBeneficiaryOfSpouse ?? initial.primarySoleBeneficiaryOfSpouse,
          // Pre-tax balances (internal review round 3,
          // SHOULD-1): the record's balances are the plan's
          // STARTING balances, so they preseed ONLY when the
          // December year is the plan's first year (the
          // record's execution year) — the same gate as the
          // carry-in below. In any other year the fields keep
          // their blank (no input yet) default: the record
          // does not carry the prior-year-end balance for a
          // later year, and filling the starting balance there
          // prices the RMD on a balance from years earlier.
          ...(rothQ.data.execution?.executionYear === year
            ? {
                pretaxBalancePrimary:
                  primaryPretaxCents != null
                    ? fmtMoneyInput(primaryPretaxCents / 100)
                    : initial.pretaxBalancePrimary,
                pretaxBalanceSpouse:
                  spousePretaxCents != null
                    ? fmtMoneyInput(spousePretaxCents / 100)
                    : initial.pretaxBalanceSpouse,
              }
            : {}),
          itemizedMortgageInterest:
            s.itemizedMortgageInterestCents != null
              ? fmtMoneyInput(s.itemizedMortgageInterestCents / 100)
              : initial.itemizedMortgageInterest,
          itemizedSaltPaid:
            s.itemizedSaltPaidCents != null
              ? fmtMoneyInput(s.itemizedSaltPaidCents / 100)
              : initial.itemizedSaltPaid,
          itemizedCharitable:
            s.itemizedCharitableCents != null
              ? fmtMoneyInput(s.itemizedCharitableCents / 100)
              : initial.itemizedCharitable,
          itemizedOther:
            s.itemizedOtherCents != null
              ? fmtMoneyInput(s.itemizedOtherCents / 100)
              : initial.itemizedOther,
          // Education students (v103): the first-open
          // preseed carries the record's entered students
          // for the December tax year, so a household with
          // college expenses on its Tax Plan record opens
          // with them priced instead of silently dropped.
          // (A stored console's own list always wins —
          // this preseed runs only when nothing is stored.)
          educationStudents: (s.educationStudents ?? [])
            .filter((e) => e.year === year)
            .map((e) => ({
              expenses: fmtMoneyInput(e.expensesCents / 100),
              aotcEligible: e.aotcEligible === true,
            })),
          // Capital losses carried in (v111): the record's
          // carry-in is the balance entering the plan's
          // FIRST year, so it preseeds ONLY when the
          // December year is that year (the record's
          // execution year). In any other year the fields
          // keep their blank (no input yet) default.
          ...(rothQ.data.execution?.executionYear === year
            ? {
                carryInCapitalLossSt:
                  s.capitalLossCarryInStCents != null
                    ? decemberNullableMoneyFormValue(s.capitalLossCarryInStCents / 100)
                    : initial.carryInCapitalLossSt,
                carryInCapitalLossLt:
                  s.capitalLossCarryInLtCents != null
                    ? decemberNullableMoneyFormValue(s.capitalLossCarryInLtCents / 100)
                    : initial.carryInCapitalLossLt,
                carryInCapitalLossStWa:
                  s.capitalLossCarryInStWaCents != null
                    ? decemberNullableMoneyFormValue(s.capitalLossCarryInStWaCents / 100)
                    : initial.carryInCapitalLossStWa,
                carryInCapitalLossLtWa:
                  s.capitalLossCarryInLtWaCents != null
                    ? decemberNullableMoneyFormValue(s.capitalLossCarryInLtWaCents / 100)
                    : initial.carryInCapitalLossLtWa,
              }
            : {}),
          // Gain-harvest pool facts (v113): the record's
          // taxable pool and blended basis preseed the
          // harvest section's facts (the toggle itself stays
          // off — preseeding facts never switches a strategy
          // on). Balance facts, so no first-year gate.
          // S-8: a first-open console has no year-to-date
          // sale entered yet, so the record's current pool
          // preseeds as it stands and the field's
          // start-of-year label governs it from there; a
          // stored console's unentered facts instead resolve
          // through the load resolution, which converts the
          // record's current pool to the starting pool.
          harvestPoolAmount: (() => {
            const facts = recordFactsOf(rothQ.data, year);
            return facts.harvestPoolAmount != null
              ? decemberNullableMoneyFormValue(facts.harvestPoolAmount)
              : initial.harvestPoolAmount;
          })(),
          harvestPoolBasisPct: (() => {
            const facts = recordFactsOf(rothQ.data, year);
            return facts.harvestPoolBasisPct != null
              ? String(facts.harvestPoolBasisPct)
              : initial.harvestPoolBasisPct;
          })(),
        };
      }
    }
    if (!decQ.data.hasStored) {
      // First-open preseed provenance (round-5): the
      // preseeded BALANCES become the console's own stored
      // values (they are this console's initial entries),
      // but the beneficiary fact stays UNANSWERED in the
      // preseeded blob even when the record answers it —
      // load resolution supplies the record's answer for
      // display and pricing until the user answers here.
      const preseeded = stateFromForm(initial);
      storedProvenanceRef.current = {
        // The preseeded values are this console's initial
        // entries for its own tax year (internal review
        // round 4, SHOULD-1).
        taxYear: preseeded.taxYear,
        primarySoleBeneficiaryOfSpouse: null,
        pretaxBalancePrimary: preseeded.pretaxBalancePrimary,
        pretaxBalanceSpouse: preseeded.pretaxBalanceSpouse,
        pretaxBalance: preseeded.pretaxBalance,
        pretaxSplitExplicit:
          preseeded.pretaxBalancePrimary != null ||
          preseeded.pretaxBalanceSpouse != null,
        legacyBeneficiaryAnswerUnconfirmed: false,
        legacyRocSplitUnconfirmed: false,
        legacyJanPaidSplitUnconfirmed: false,
        // The preseeded education students become this
        // console's own stored values on the first save —
        // they are its initial entries, like the balances.
        educationStudents: preseeded.educationStudents,
        // The preseeded carry-in values likewise become
        // this console's own stored values (v111) — they
        // are its initial entries, seeded only when the
        // December year is the plan's first year.
        carryInCapitalLossSt: preseeded.carryInCapitalLossSt,
        carryInCapitalLossLt: preseeded.carryInCapitalLossLt,
        carryInCapitalLossStWa: preseeded.carryInCapitalLossStWa,
        carryInCapitalLossLtWa: preseeded.carryInCapitalLossLtWa,
        // The preseeded harvest pool facts likewise become
        // this console's own stored values (v113) — they are
        // its initial entries, like the balances.
        harvestPoolAmount: preseeded.harvestPoolAmount,
        harvestPoolBasisPct: preseeded.harvestPoolBasisPct,
      };
    }
    setForm(initial);
    if (!decQ.data.hasStored) {
      dirtyRef.current = true;
    }
    // Hydrate exactly once, from the first stored read (plus the
    // Tax Plan record on a first open, per the wait above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decQ.data, rothQ.data, rothQ.isPending]);

  const saveMutateRef = useRef(saveMut.mutate);
  saveMutateRef.current = saveMut.mutate;
  const clearDeferredDecFlushGiveUp = () => {
    if (deferredDecFlushGiveUpTimerRef.current != null) {
      window.clearTimeout(deferredDecFlushGiveUpTimerRef.current);
      deferredDecFlushGiveUpTimerRef.current = null;
    }
  };
  // Consume the deferred slot (and disarm its give-up
  // timer): the ONE way the slot is read, so a settle and
  // the give-up can never both fire the same send.
  const takeDeferredDecFlush = (): (() => void) | null => {
    clearDeferredDecFlushGiveUp();
    const deferred = deferredDecFlushRef.current;
    deferredDecFlushRef.current = null;
    return deferred;
  };
  const armDeferredDecFlushGiveUp = () => {
    clearDeferredDecFlushGiveUp();
    deferredDecFlushGiveUpTimerRef.current = window.setTimeout(() => {
      deferredDecFlushGiveUpTimerRef.current = null;
      const deferred = deferredDecFlushRef.current;
      deferredDecFlushRef.current = null;
      if (deferred) deferred();
    }, DEFERRED_FLUSH_GIVE_UP_MS);
  };
  /* Build v207 (re-audit round 4 SHOULD R4-S7): the ONE
     retrying send for the unmount flush, carrying the same
     retry the autosave send below carries (MUST-3's shape).
     Its per-call onError re-arms a 3 s retry of the SAME
     payload, chained per failure, on decFlushRetryTimerRef —
     a timer no cleanup clears — so a flush that fails at the
     moment of navigation is retried until it lands. Each
     attempt goes through this same send (the retry calls
     back through the ref, so it always reaches the current
     closure), and the mutation reads its CAS base live from
     revisionRef at each call, so a retry of a deferred flush
     rides the base the in-flight save adopted when it
     landed, exactly as its first send did. A conflict is NOT
     retried: it resolves through onSuccess with res.ok
     false, where the mutation-level handler has already
     applied the conflict path's deliberate drop, and
     re-sending the stale form would fight the newer record
     the refusal just re-showed. */
  const sendDecFlushWithRetry = (payload: DecemberState) => {
    decSaveInFlightRef.current = true;
    decSaveInFlightPayloadRef.current = payload;
    saveMutateRef.current(payload, {
      onError: () => {
        if (decFlushRetryTimerRef.current != null) {
          window.clearTimeout(decFlushRetryTimerRef.current);
        }
        decFlushRetryTimerRef.current = window.setTimeout(() => {
          sendDecFlushWithRetryRef.current(payload);
        }, 3000);
      },
      onSettled: () => {
        // Identity-guarded: a retry of this same payload may
        // already be in flight (it re-marks the slot), and an
        // older overlapping send settling must not clear the
        // marker a newer send set.
        if (decSaveInFlightPayloadRef.current === payload) {
          decSaveInFlightRef.current = false;
          decSaveInFlightPayloadRef.current = null;
        }
      },
    });
  };
  const sendDecFlushWithRetryRef = useRef(sendDecFlushWithRetry);
  sendDecFlushWithRetryRef.current = sendDecFlushWithRetry;
  /* Build v207: the autosave's send. The payload stays
     queued in pendingDecSaveRef until the save SUCCEEDS —
     it is not dropped at the call, so a failed save (offline,
     gateway 500) cannot vanish silently. The per-call
     handlers own the queue: success drops the payload,
     error re-arms a retry of it on the shared save timer. */
  const sendDecSave = (payload: DecemberState) => {
    decSaveInFlightRef.current = true;
    decSaveInFlightPayloadRef.current = payload;
    saveMutateRef.current(payload, {
      // Guarded on res.ok (build v63, December save-note
      // fix): a CAS conflict RESOLVES as data (ok: false), so
      // this per-call success callback fires for conflicts
      // too — and in @tanstack/query-core it runs AFTER the
      // mutation-level onSuccess above (Mutation.execute
      // awaits the options callback before dispatching the
      // success that notifies the mutate callbacks), so an
      // unguarded "Saved" here overwrote the conflict note
      // the mutation-level handler had just set, in the same
      // completion. Only a real save may say "Saved".
      onSuccess: (res) => {
        // The save landed: drop the queued payload — but
        // only if it is still this one. A newer edit queued
        // while this save was in flight is a different
        // payload and stays queued for its own fire. (A
        // conflict also resolves here, after the
        // mutation-level handler has already dropped the
        // queue and replaced the form, so this is a no-op
        // then — exactly the deliberate drop the conflict
        // path intends.)
        if (pendingDecSaveRef.current === payload) {
          pendingDecSaveRef.current = null;
        }
        if (res.ok) setSaveNote("Saved");
        // Consume a flush the unmount cleanup deferred
        // behind this save: fire it on a landed save (the
        // mutation-level handler has adopted the new
        // revision, so the deferred send reads the new base
        // and lands in order), drop it on a conflict (the
        // mutation-level handler has replaced the form with
        // the stored record; the deferred payload is that
        // same stale form's newest snapshot and must not
        // ride out under the adopted base).
        const deferred = takeDeferredDecFlush();
        if (res.ok && deferred) deferred();
      },
      onError: () => {
        setSaveNote("Could not save — your entries stay on this screen.");
        // Keep the payload queued and re-arm a retry on the
        // shared save timer, so it lands once the server is
        // reachable again. If a newer payload was queued
        // behind this one, that payload's own scheduling
        // drives it and no retry is armed for the superseded
        // payload — the identity check fails, exactly as in
        // the other writers.
        if (pendingDecSaveRef.current === payload) {
          if (decSaveTimerRef.current != null) {
            window.clearTimeout(decSaveTimerRef.current);
          }
          decSaveTimerRef.current = window.setTimeout(() => {
            sendDecSaveRef.current(payload);
          }, 3000);
        }
        // This save never landed, so the base is unchanged
        // and a flush deferred behind it at unmount fires
        // now — the queued payload supersedes the failed one
        // outright (no retry of this payload was armed above:
        // the queue no longer holds it; the cleanup moved it
        // to the deferred slot).
        const deferred = takeDeferredDecFlush();
        if (deferred) deferred();
      },
      onSettled: () => {
        // Identity-guarded, as in the flush send: an older
        // overlapping send settling must not clear the
        // in-flight marker a newer send set.
        if (decSaveInFlightPayloadRef.current === payload) {
          decSaveInFlightRef.current = false;
          decSaveInFlightPayloadRef.current = null;
        }
      },
    });
  };
  const sendDecSaveRef = useRef(sendDecSave);
  sendDecSaveRef.current = sendDecSave;

  /* Debounced autosave of every edit, so the December session
     can be left and reopened at any point. The saved state is
     derived through decemberStateForSave (round-5): fields
     the user has not edited in this console — the beneficiary
     fact, the balance split — save their STORED values, never
     a load-resolved (inherited) value, so an inherited answer
     keeps no precedence over a later record change.
     Build v207 (re-audit round 4 SHOULD R4-S7): the payload
     the effect builds is stored in pendingDecSaveRef BEFORE
     the debounce is armed, and the debounce fires through
     sendDecSave — before v207 the effect fired a bare mutate
     from a timer its own cleanup cleared, so leaving the
     console inside the debounce lost the edit outright and a
     failed save never retried. The cleanup still clears the
     shared save timer (a newer edit's run supersedes the
     pending debounce — and a pending retry of a superseded
     payload — exactly as in the other writers), but the
     payload itself now survives in the ref for the unmount
     flush below. */
  useEffect(() => {
    if (!form || !dirtyRef.current) return;
    setSaveNote("Saving…");
    const payload = decemberStateForSave(
      stateFromForm(form),
      storedProvenanceRef.current,
      {
        beneficiary: beneficiaryEdited,
        balances: balancesEdited,
        rocCharacter: rocCharacterEdited,
        janPaidCharacter: janPaidCharacterEdited,
        education: educationEdited,
        carryInSt: carryInStEdited,
        carryInLt: carryInLtEdited,
        carryInStWa: carryInStWaEdited,
        carryInLtWa: carryInLtWaEdited,
        harvestPoolAmount: harvestPoolAmountEdited,
        harvestPoolBasisPct: harvestPoolBasisPctEdited,
      },
    );
    pendingDecSaveRef.current = payload;
    decSaveTimerRef.current = window.setTimeout(() => {
      sendDecSaveRef.current(payload);
    }, 700);
    return () => {
      if (decSaveTimerRef.current != null) {
        window.clearTimeout(decSaveTimerRef.current);
        decSaveTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form]);

  /* Build v207 (re-audit round 4 SHOULD R4-S7): flush the
     queued save when the console unmounts — pressing
     "← Tax Plan" unmounts it (it renders inside the Tax Plan
     view only while open), so an edit made in the last
     fraction of a second is not lost. Before v207 there was
     no unmount flush anywhere in this file: the autosave
     cleanup cleared the debounce timer and the edit died
     with the component, and reopening rehydrated the old
     stored value. The flush fires through sendDecFlushWithRetry
     (the ONE retrying flush send above); if a save is still
     in flight at unmount, a payload queued behind it is
     DEFERRED behind it (the S-3 pattern) instead of fired
     concurrently under the same not-yet-advanced CAS base —
     the in-flight call's per-call handlers fire the deferred
     send the moment that save settles, and the slot's
     give-up timer fires it if that save never settles. The
     queue is nulled either way, exactly as in the other
     writers: the payload no longer depends on the queue for
     its survival, because the flush send (or the deferred
     slot) carries it in its closure. */
  useEffect(() => {
    return () => {
      if (decSaveTimerRef.current != null) {
        window.clearTimeout(decSaveTimerRef.current);
        decSaveTimerRef.current = null;
      }
      // The pending payload may BE the save currently in
      // flight (the queue clears on success, not at the
      // call) — that one is already being written, and its
      // own per-call onError re-arms its retry on the shared
      // timer if it fails, so only flush a payload queued
      // behind it.
      if (
        pendingDecSaveRef.current &&
        pendingDecSaveRef.current !== decSaveInFlightPayloadRef.current
      ) {
        const queued = pendingDecSaveRef.current;
        if (decSaveInFlightRef.current) {
          // Defer, don't fire concurrently. Storing the send
          // also ARMS its give-up timer (see
          // deferredDecFlushGiveUpTimerRef).
          deferredDecFlushRef.current = () =>
            sendDecFlushWithRetryRef.current(queued);
          armDeferredDecFlushGiveUp();
        } else {
          sendDecFlushWithRetryRef.current(queued);
        }
        pendingDecSaveRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const edit = (fn: (f: DecForm) => DecForm) => {
    dirtyRef.current = true;
    setResetArmed(false);
    setForm((f) => (f ? fn(f) : f));
  };
  const set = <K extends keyof DecForm>(key: K, value: DecForm[K]) =>
    edit((f) => ({ ...f, [key]: value }));

  const state = useMemo(() => (form ? stateFromForm(form) : null), [form]);
  /* Annual spending for the "enough for the year" comparison
     (build v126): the Tax Plan record's annual spending,
     falling back to the Retirement calculator's default —
     the same resolution the Playground uses. Null when
     neither answers, or when the resolved figure is $0 (no
     spending to compare against); the comparison row hides
     then. In cents, like the record; never console state,
     never saved. */
  const decAnnualSpendingCents = useMemo(() => {
    const resolved =
      rothQ.data?.saved?.annualSpendingCents ??
      retQ.data?.defaultSpendingAnnualCents ??
      null;
    return resolved != null && resolved > 0 ? resolved : null;
  }, [rothQ.data, retQ.data]);
  const result = useMemo(
    () => (state ? computeDecemberProjection(state, decAnnualSpendingCents) : null),
    [state, decAnnualSpendingCents],
  );

  /* Jump-and-highlight (build v69): the provenance-tap
     mechanism modelled on Spending's scrollToSection — scroll
     on a later frame, then flash an outline on the field for
     ~1.6s (applied to the element directly and restored
     afterwards). The console's fields are in always-rendered
     sections, so no fold needs opening. */
  const decFlashTimer = useRef<number | null>(null);
  const jumpToDecField = (fieldId: string) => {
    window.setTimeout(() => {
      const el = document.getElementById(fieldId);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      const prevOutline = el.style.outline;
      const prevOffset = el.style.outlineOffset;
      el.style.outline = "2px solid var(--accent)";
      el.style.outlineOffset = "2px";
      if (decFlashTimer.current != null) {
        window.clearTimeout(decFlashTimer.current);
      }
      decFlashTimer.current = window.setTimeout(() => {
        el.style.outline = prevOutline;
        el.style.outlineOffset = prevOffset;
      }, 1600);
    }, 60);
  };
  const decTapCls =
    "underline decoration-dotted underline-offset-4 hover:text-[var(--accent)]";

  if (decQ.error && !form) {
    return (
      <p className="py-10 text-center text-[var(--bad)]">
        Something went wrong loading the December console.
      </p>
    );
  }
  if (decQ.isPending || !form || !result || !state) {
    return <p className="py-10 text-center text-[var(--dim)]">Loading…</p>;
  }

  const joint = form.filingStatus === "mfj";
  /* Projected tax bill (build v50): the likely case's
     bill at the headline draw, from the core result's
     readouts — the view does no settlement arithmetic of
     its own. The state rows show only when a state tax is
     in play (a rate entered, or a priced state amount —
     the Washington excise at a 0% flat rate); at a plain
     0% state the federal line stands alone. Every figure
     in the bill is stated to the cent (fmtDollarsExact,
     build v192) so the listed rows foot to the settlement
     shown exactly. */
  const likelyCase = result.cases.find((c) => c.kind === "likely") ?? null;
  const billShowState =
    likelyCase != null &&
    (state.stateRatePct > 0 || likelyCase.stateTaxAtHeadline > 0);
  /* The bill's ACA credit row states the credit STILL DUE
     (build v204, re-audit round 4 R4-S1), not the final
     allowable credit: the settlement nets only the part of
     the final credit that was not already advanced —
     settlement = total tax − credit still due + excess
     advance credit to repay − refundable education credit
     (decemberCore) — so stating the full final credit made
     the listed rows miss the settlement by exactly
     final credit − credit still due whenever APTC taken
     was above $0, up to flipping the bill's sign. creditStillDue is a number whenever the
     final credit is priced (it is null only when the credit
     itself is unpriced, in which case this row is not shown
     either); the fallback to the final credit is defensive
     only. With no advance credit taken the two are equal,
     so the row — and the December reference case — reads
     exactly as before. The final allowable credit itself
     stays stated on the case cards below ("Final credit"). */
  const billCreditStillDue =
    likelyCase?.creditStillDue ?? likelyCase?.creditAtHeadline ?? null;
  const billRow = (
    label: ReactNode,
    value: ReactNode,
    opts?: { bold?: boolean; divide?: boolean; highlight?: boolean },
  ) => (
    <div
      className={`flex items-baseline justify-between gap-4 ${
        opts?.divide ? "mt-1 border-t border-[var(--border)] pt-1.5" : "py-0.5"
      }`}
    >
      <span className={opts?.bold ? "font-semibold" : undefined}>{label}</span>
      {/* Highlight (build v117): the v87 accent treatment —
          the figure itself renders bold in the accent colour,
          matching the tax figure elsewhere. The label keeps
          whatever the bold option gives it. */}
      <span
        className={`tnum ${
          opts?.highlight
            ? "font-bold text-[var(--accent)]"
            : opts?.bold
              ? "font-bold"
              : ""
        }`}
      >
        {value}
      </span>
    </div>
  );
  const rangeRow = (
    label: string,
    key: "remCapDist" | "remInterest" | "remOrdinaryDividends" | "remQualifiedDividends" | "remOtherOrdinary",
    hint?: string,
  ) => (
    <div className="mt-3">
      <span className="block text-sm font-medium text-[var(--text)]">{label}</span>
      {hint && <p className={hintCls}>{hint}</p>}
      <div className="mt-1 grid grid-cols-3 gap-2">
        {(["low", "likely", "high"] as const).map((k) =>
          moneyField(CASE_LABELS[k], form[key][k], (v) =>
            edit((f) => ({ ...f, [key]: { ...f[key], [k]: v } })),
          { idLabel: `December ${label} ${k}`, ariaLabel: `${label} — ${CASE_LABELS[k]}` },
          ),
        )}
      </div>
    </div>
  );

  const strayRow = (
    label: string,
    key:
      | "strayCapDist"
      | "strayK1"
      | "strayTaxExempt"
      | "strayDependent"
      | "straySeverance"
      | "strayLossHarvest"
      | "strayCutoff"
      | "strayJanPaid"
      | "strayDivInt"
      | "strayPlannedSales"
      | "strayROC"
      | "strayROCOrdinary"
      | "strayAgiReducers"
      | "strayCoverage"
      | "strayTradeDate",
    opts?: {
      amountLabel?: string;
      hint?: string;
      extra?: ReactNode;
      note?: string;
      // Round-6 character edit tracking: invoked from
      // BOTH the status select and the amount field, so
      // touching this row's character control counts as
      // confirming its tax character.
      onEdit?: () => void;
    },
  ) => {
    const item = form[key];
    const hasAmount = opts?.amountLabel != null;
    return (
      <div className="mt-3 rounded-[var(--radius)] border border-[var(--border)] px-3 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium text-[var(--text)]">{label}</span>
          <select
            aria-label={`${label} — status`}
            className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)]"
            value={item.status}
            onChange={(e) => {
              opts?.onEdit?.();
              edit((f) => ({
                ...f,
                [key]: { ...f[key], status: e.target.value as StrayForm["status"] },
              }));
            }}
          >
            <option value="na">Doesn’t apply</option>
            <option value="confirmed">Checked — none / confirmed</option>
            {hasAmount && <option value="amount">Amount applies</option>}
          </select>
        </div>
        {opts?.hint && <p className={hintCls}>{opts.hint}</p>}
        {opts?.note && (
          <p className="mt-1 text-sm text-[var(--warn)]" role="note">
            {opts.note}
          </p>
        )}
        {hasAmount && item.status === "amount" && (
          <div className="mt-2 max-w-xs">
            {moneyField(opts.amountLabel!, item.amount, (v) => {
              opts?.onEdit?.();
              edit((f) => ({ ...f, [key]: { ...f[key], amount: v } }));
            },
            { idLabel: `December stray ${label} amount` },
            )}
          </div>
        )}
        {item.status === "amount" && opts?.extra}
      </div>
    );
  };

  return (
    <div>
      <h2 className="mt-4 text-base font-semibold">December draw</h2>
      <p className="mt-1 max-w-3xl text-sm text-[var(--dim)]">
        A year-end projection for the December decision: enter what has already posted this
        year and what is still to come, and read the largest pre-tax draw that keeps the
        year under the ACA cliff, with a safety buffer. Priced by the same single-year tax
        engine as the Playground.
      </p>
      {decQ.data?.storedUnreadable && (
        <p
          role="alert"
          className="mt-2 max-w-3xl rounded-[var(--radius)] border border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-sm leading-relaxed"
        >
          <strong>Your saved December entries can&rsquo;t be read.</strong>{" "}
          A saved record exists, but it can&rsquo;t be opened — the entries
          below are the starting defaults, not your saved ones. Saving is
          paused while the record is unreadable, so nothing overwrites it.
        </p>
      )}
      {saveNote && (
        <p className="mt-1 text-xs text-[var(--dim)]" role="status">
          {saveNote} — entries are saved as you type and reopen where you left them.
        </p>
      )}

      {/* Headline — the one number the user acts on. */}
      <section className={sectionCls} aria-label="December headline">
        {!result.priced ? (
          <p className="text-base font-semibold">{result.reason}</p>
        ) : (
          <>
            {result.headlineDraw != null && !result.zeroDrawOverCliff && (
              <p className="tnum text-3xl font-bold text-[var(--accent)]">
                {fmtDollars(result.headlineDraw)}
              </p>
            )}
            <p className="mt-1 max-w-3xl text-base font-semibold">{result.headlineText}</p>
            {result.cliff != null && (
              <p className="mt-1 text-sm text-[var(--dim)]">
                Cliff{" "}
                <button
                  type="button"
                  aria-label="Go to the ACA household size field"
                  className={decTapCls}
                  onClick={() => jumpToDecField("roth-December-ACA-household-size")}
                >
                  {fmtDollars(result.cliff)}
                </button>{" "}
                · aim at {fmtDollars(result.targetMagi ?? 0)}{" "}
                (cliff −{" "}
                <button
                  type="button"
                  aria-label="Go to the Buffer below the cliff field"
                  className={decTapCls}
                  onClick={() => jumpToDecField("roth-December-cliff-buffer")}
                >
                  {fmtDollars(state.bufferDollars)}
                </button>{" "}
                buffer)
              </p>
            )}
            {likelyCase && (
              <div
                className="mt-3 max-w-xl rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-3"
                aria-label="Projected tax bill"
              >
                <p className="text-sm font-semibold">
                  Projected tax bill
                  <span className="font-normal text-[var(--dim)]">
                    {" "}— likely case
                    {result.headlineDraw != null ? ", at the headline draw" : ""}
                  </span>
                </p>
                <div className="mt-1 text-sm">
                  <button
                    type="button"
                    aria-expanded={billIncomeOpen}
                    onClick={() => setBillIncomeOpen(!billIncomeOpen)}
                    className="flex w-full items-center justify-between gap-3 py-0.5 text-left"
                  >
                    <span>Income details</span>
                    <FoldChevron open={billIncomeOpen} />
                  </button>
                  {billIncomeOpen && (
                    <>
                      {billRow("Adjusted gross income (AGI)", fmtDollarsExact(likelyCase.totalIncomeAtHeadline))}
                      {billRow(
                        "MAGI",
                        <button
                          type="button"
                          aria-label="Go to the year-to-date actuals"
                          className={decTapCls}
                          onClick={() => jumpToDecField("roth-December-YTD-other-ordinary")}
                        >
                          {fmtDollarsExact(likelyCase.magiAtHeadline)}
                        </button>,
                      )}
                      {billRow("Taxable income", fmtDollarsExact(likelyCase.taxableIncomeAtHeadline))}
                    </>
                  )}
                  {billRow(
                    "Federal tax",
                    <button
                      type="button"
                      aria-label="Go to the year-to-date actuals"
                      className={decTapCls}
                      onClick={() => jumpToDecField("roth-December-YTD-other-ordinary")}
                    >
                      {fmtDollarsExact(likelyCase.federalTaxAtHeadline)}
                    </button>,
                  )}
                  {billShowState &&
                    billRow(
                      "State tax",
                      <button
                        type="button"
                        aria-label="Go to the year-to-date actuals"
                        className={decTapCls}
                        onClick={() => jumpToDecField("roth-December-YTD-other-ordinary")}
                      >
                        {fmtDollarsExact(likelyCase.stateTaxAtHeadline)}
                      </button>,
                    )}
                  {billShowState &&
                    billRow(
                      "Total tax",
                      <button
                        type="button"
                        aria-label="Go to the year-to-date actuals"
                        className={decTapCls}
                        onClick={() => jumpToDecField("roth-December-YTD-other-ordinary")}
                      >
                        {fmtDollarsExact(likelyCase.totalTaxAtHeadline)}
                      </button>,
                    )}
                  {likelyCase.creditAtHeadline != null &&
                    billCreditStillDue != null &&
                    billRow(
                      state.aptcTaken > 0
                        ? "ACA premium credit still due"
                        : "ACA premium credit",
                      <button
                        type="button"
                        aria-label="Go to the Benchmark premium (annual) field"
                        className={decTapCls}
                        onClick={() => jumpToDecField("roth-December-ACA-benchmark")}
                      >
                        {billCreditStillDue > 0
                          ? `−${fmtDollarsExact(billCreditStillDue)}`
                          : fmtDollarsExact(billCreditStillDue)}
                      </button>,
                      { highlight: true },
                    )}
                  {likelyCase.educationRefundableAtHeadline > 0 &&
                    billRow(
                      "Refundable education credit (AOTC)",
                      `−${fmtDollarsExact(likelyCase.educationRefundableAtHeadline)}`,
                    )}
                  {likelyCase.harvestedGainAtHeadline > 0 &&
                    billRow(
                      "Gain harvested into the 0% band",
                      <button
                        type="button"
                        aria-label="Go to the Taxable pool at the start of the year field"
                        className={decTapCls}
                        onClick={() => jumpToDecField("roth-December-harvest-pool")}
                      >
                        {fmtDollarsExact(likelyCase.harvestedGainAtHeadline)}
                      </button>,
                    )}
                  {state.taxableFunded != null && state.taxableFunded > 0 &&
                    billRow(
                      "Taxable cash (100% basis)",
                      <button
                        type="button"
                        aria-label="Go to the Taxable cash for the year field"
                        className={decTapCls}
                        onClick={() => jumpToDecField("roth-December-taxable-cash")}
                      >
                        {fmtDollarsExact(state.taxableFunded)}
                      </button>,
                    )}
                  {likelyCase.excessAptcRepayment != null &&
                    likelyCase.excessAptcRepayment > 0 &&
                    billRow(
                      "Advance credit to repay",
                      <button
                        type="button"
                        aria-label="Go to the Advance credit (APTC) already taken field"
                        className={decTapCls}
                        onClick={() => jumpToDecField("roth-December-APTC-taken")}
                      >
                        {fmtDollarsExact(likelyCase.excessAptcRepayment)}
                      </button>,
                    )}
                  {likelyCase.netSettleAtHeadline == null ? (
                    <p className="mt-1 border-t border-[var(--border)] pt-1.5 text-sm">
                      {likelyCase.netSettleNote ??
                        "For years before 2026 the advance-credit repayment isn’t modeled, so no single settlement figure is shown."}
                    </p>
                  ) : (
                    billRow(
                      likelyCase.netSettleAtHeadline < 0
                        ? "Estimated refund at filing"
                        : "Estimated amount to settle at filing",
                      <button
                        type="button"
                        aria-label="Go to the year-to-date actuals"
                        className={decTapCls}
                        onClick={() => jumpToDecField("roth-December-YTD-other-ordinary")}
                      >
                        {fmtDollarsExact(likelyCase.netSettleAtHeadline)}
                      </button>,
                      { bold: true, divide: true },
                    )
                  )}
                  {/* Cash left after tax (build v114, fixed
                      text + ⓘ build v116): the priced
                      year's cash in minus the settlement above
                      — the engine/core-computed readout
                      (cashLeftAtHeadline), shown only when a
                      settlement is shown, before any spending.
                      The fixed subtext carries no figure; the
                      ⓘ (the 0% InfoNote pattern —
                      live-composed figures, align by the
                      label's position) names the cash in
                      (cashInAtHeadline) and the net tax bill
                      (netSettleAtHeadline) as priced, and
                      carries the filing sentence only when the
                      net bill is a refund. Same shape as the
                      Playground face, but the credit sentence
                      differs on purpose (re-audit round 3
                      SHOULD-2, build v191): this face's net tax
                      bill IS the filing settlement, which
                      includes the ACA reconciliation, so the
                      tooltip says the credit is priced in —
                      the Playground's net tax bill excludes the
                      credit (its spending holds the net
                      premium), so its face says the opposite,
                      accurately for its own figure. */}
                  {likelyCase.cashLeftAtHeadline != null &&
                    likelyCase.netSettleAtHeadline != null &&
                    likelyCase.cashInAtHeadline != null && (
                      <>
                        {billRow(
                          <>
                            Cash left after tax
                            <InfoNote
                              text={`Cash in ${fmtDollarsExact(likelyCase.cashInAtHeadline)} minus the net tax bill ${fmtDollarsExact(likelyCase.netSettleAtHeadline)} — the total tax less any refundable education credit, with the ACA premium credit priced in: the net tax bill includes the ACA reconciliation (the credit still due comes off the bill; any advance credit taken beyond the final credit is added back to repay). It's what's left to spend next year, before any spending.${likelyCase.netSettleAtHeadline < 0 ? " If the tax bill is a refund, that part arrives at filing in the spring, not in December." : ""}`}
                              ariaLabel="About the cash left after tax"
                            />
                          </>,
                          <button
                            type="button"
                            aria-label="Go to the year-to-date actuals"
                            className={decTapCls}
                            onClick={() => jumpToDecField("roth-December-YTD-other-ordinary")}
                          >
                            {fmtDollarsExact(likelyCase.cashLeftAtHeadline)}
                          </button>,
                          { bold: true, highlight: true },
                        )}
                        <p className="text-xs text-[var(--dim)]">
                          Cash in minus the net tax bill — what&rsquo;s
                          left to spend next year, before any spending.
                        </p>
                        {/* Left after a year's spending (contract
                            v126, "enough for the year"): cash left
                            after tax minus the annual spending —
                            the core-priced comparison (likelyCase.
                            cashLeftVsSpendingAtHeadline), positive
                            = enough for the year, negative = short.
                            The spending is the Tax Plan record's
                            annual spending (the Retirement
                            calculator's default when the record
                            has none); the row hides when no
                            spending resolves or no settlement is
                            shown. No provenance tap, for the same
                            reason as the Playground row: the
                            driving input lives in the Tax Plan
                            view, which has no cross-view jump from
                            here, and a tap to the year-to-date
                            actuals would mislead — so the ⓘ names
                            the spending and its source instead,
                            and carries the refund-timing sentence
                            whenever the net bill is a refund. */}
                        {likelyCase.cashLeftVsSpendingAtHeadline != null &&
                          likelyCase.annualSpendingAtHeadline != null && (
                            <>
                              {billRow(
                                <>
                                  Left after a year&rsquo;s spending
                                  <InfoNote
                                    text={`Cash left after tax ${fmtDollarsExact(likelyCase.cashLeftAtHeadline)} minus annual spending ${fmtDollarsExact(likelyCase.annualSpendingAtHeadline)} — the annual spending from the Tax Plan.${likelyCase.netSettleAtHeadline != null && likelyCase.netSettleAtHeadline < 0 ? " If the tax bill is a refund, that part arrives at filing in the spring, not in December." : ""}`}
                                    ariaLabel="About the amount left after a year's spending"
                                  />
                                </>,
                                <span
                                  className={`font-bold ${likelyCase.cashLeftVsSpendingAtHeadline < 0 ? "text-[var(--bad)]" : "text-[var(--accent)]"}`}
                                >
                                  {fmtDollarsExact(likelyCase.cashLeftVsSpendingAtHeadline)}
                                </span>,
                                { bold: true },
                              )}
                              <p className="text-xs text-[var(--dim)]">
                                {likelyCase.cashLeftVsSpendingAtHeadline > 0
                                  ? "Enough for the year."
                                  : likelyCase.cashLeftVsSpendingAtHeadline < 0
                                    ? "Short of a year's spending."
                                    : "Exactly enough for the year."}
                              </p>
                            </>
                          )}
                      </>
                    )}
                </div>
                {likelyCase.educationNonrefundableAtHeadline > 0 && (
                  <p className="mt-2 text-xs text-[var(--dim)]">
                    Education credits of{" "}
                    {fmtDollarsExact(likelyCase.educationNonrefundableAtHeadline)} are
                    already applied against the federal tax above
                    {likelyCase.educationChoiceAtHeadline === "aotc"
                      ? " (American Opportunity Credit)"
                      : likelyCase.educationChoiceAtHeadline === "llc"
                        ? " (Lifetime Learning Credit)"
                        : ""}
                    .
                  </p>
                )}
                {likelyCase.excludesEducationCredits && (
                  <p className="mt-2 text-sm text-[var(--warn)]" role="note">
                    This settlement excludes education credits — no education
                    expenses are entered below, so the American Opportunity
                    Credit and the Lifetime Learning Credit are not priced in
                    it. It is not a final settlement if anyone in the household
                    paid qualified education expenses this year.
                  </p>
                )}
                {likelyCase.gainHarvestUnpriced && (
                  <p className="mt-2 text-sm text-[var(--warn)]" role="note">
                    This settlement excludes gain harvesting — harvesting is
                    switched on in the Gain harvest section below, but no
                    taxable pool or basis is entered, so no harvest is priced
                    in it. It is not a final settlement if the plan harvests
                    gains this year.
                  </p>
                )}
                <p className="mt-2 text-xs text-[var(--dim)]">
                  This estimate is before any withholding or estimated payments,
                  which this console does not track.
                </p>
              </div>
            )}
            {result.cases.length > 0 && (
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                {result.cases.map((c) => (
                  <div
                    key={c.kind}
                    className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-3"
                  >
                    <p className="text-sm font-semibold">
                      {CASE_LABELS[c.kind]} case
                      {c.kind === "likely" ? " — the headline case" : ""}
                    </p>
                    <p className="tnum mt-1 text-sm">
                      MAGI at the headline draw: {fmtDollars(c.magiAtHeadline)}
                    </p>
                    {c.distanceAtHeadline != null && (
                      <p className="tnum text-sm">
                        {c.distanceAtHeadline >= 0
                          ? `${fmtDollars(c.distanceAtHeadline)} under the cliff`
                          : `${fmtDollars(-c.distanceAtHeadline)} over the cliff`}
                      </p>
                    )}
                    <p className="mt-1 text-sm">
                      {result.cliff == null
                        ? "No cliff priced"
                        : c.overCliffAtHeadline
                          ? "Credit lost — the final credit is $0"
                          : c.creditAtHeadline != null
                            ? `Final credit: ${fmtDollars(c.creditAtHeadline)}`
                            : "Credit not priced"}
                    </p>
                    {result.cliff != null && state.aptcTaken > 0 && (
                      <p className="tnum mt-1 text-sm">
                        {c.overCliffAtHeadline ? (
                          <>
                            Excess APTC repayment: repay the full{" "}
                            <button
                              type="button"
                              aria-label="Go to the Advance credit (APTC) already taken field"
                              className={decTapCls}
                              onClick={() => jumpToDecField("roth-December-APTC-taken")}
                            >
                              {fmtDollars(c.repaymentExposure)}
                            </button>{" "}
                            of advance credit taken
                          </>
                        ) : c.excessAptcRepayment != null ? (
                          <>
                            Excess APTC repayment:{" "}
                            <button
                              type="button"
                              aria-label="Go to the Advance credit (APTC) already taken field"
                              className={decTapCls}
                              onClick={() => jumpToDecField("roth-December-APTC-taken")}
                            >
                              {fmtDollars(c.excessAptcRepayment)}
                            </button>
                          </>
                        ) : (
                          "Excess APTC repayment: not priced — enter the benchmark premium"
                        )}
                      </p>
                    )}
                    {result.cliff != null &&
                      c.creditStillDue != null &&
                      c.creditStillDue > 0 && (
                        <p className="tnum mt-1 text-sm">
                          Additional credit still due: {fmtDollars(c.creditStillDue)}
                        </p>
                      )}
                    {c.netSettleAtHeadline == null ? (
                      <p className="mt-1 text-sm">
                        {c.netSettleNote ??
                          "For years before 2026 the advance-credit repayment isn’t modeled, so no single settlement figure is shown."}
                      </p>
                    ) : (
                      <p className="tnum mt-1 text-sm">
                        {c.netSettleAtHeadline < 0
                          ? "Estimated refund at filing"
                          : "Estimated amount to settle at filing"}
                        :{" "}
                        <span className="font-semibold">
                          {fmtDollars(c.netSettleAtHeadline)}
                        </span>
                      </p>
                    )}
                    {c.educationRefundableAtHeadline > 0 && (
                      <p className="tnum mt-1 text-sm">
                        Refundable education credit included: −
                        {fmtDollars(c.educationRefundableAtHeadline)}
                      </p>
                    )}
                    {c.lossCarryOutStAtHeadline + c.lossCarryOutLtAtHeadline > 0 && (
                      <p className="tnum mt-1 text-sm">
                        Loss carried into next year:{" "}
                        {fmtDollars(
                          c.lossCarryOutStAtHeadline + c.lossCarryOutLtAtHeadline,
                        )}{" "}
                        — long-term {fmtDollars(c.lossCarryOutLtAtHeadline)},
                        short-term {fmtDollars(c.lossCarryOutStAtHeadline)}
                      </p>
                    )}
                    {c.lossCarryOutStWaAtHeadline + c.lossCarryOutLtWaAtHeadline > 0 && (
                      <p className="tnum mt-1 text-sm">
                        Of that, the Washington-attributable part is{" "}
                        {fmtDollars(
                          c.lossCarryOutStWaAtHeadline + c.lossCarryOutLtWaAtHeadline,
                        )}
                        {c.lossCarryOutLtWaAtHeadline > 0 &&
                          ` — long-term ${fmtDollars(c.lossCarryOutLtWaAtHeadline)}`}
                        {c.lossCarryOutStWaAtHeadline > 0 &&
                          `${c.lossCarryOutLtWaAtHeadline > 0 ? ", " : " — "}short-term ${fmtDollars(c.lossCarryOutStWaAtHeadline)}`}
                      </p>
                    )}
                    {c.harvestedGainAtHeadline > 0 && (
                      <p className="tnum mt-1 text-sm">
                        Gain harvested into the 0% band:{" "}
                        {fmtDollars(c.harvestedGainAtHeadline)}
                      </p>
                    )}
                    {c.excludesEducationCredits && (
                      <p className="mt-1 text-sm text-[var(--warn)]" role="note">
                        Excludes education credits — no education expenses
                        entered.
                      </p>
                    )}
                    {c.gainHarvestUnpriced && (
                      <p className="mt-1 text-sm text-[var(--warn)]" role="note">
                        Excludes gain harvesting — switched on, but no
                        taxable pool / basis entered.
                      </p>
                    )}
                    {c.overCliffEvenAtZero && (
                      <p className="mt-1 text-sm font-medium text-[var(--bad)]">
                        Over the cliff even with a $0 draw.
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
            {result.warnings.map((w) => (
              <p key={w} className="mt-2 text-sm text-[var(--warn)]" role="note">
                {w}
              </p>
            ))}
          </>
        )}
      </section>

      {/* The year */}
      <section className={sectionCls} aria-label="The year">
        <h3 className="text-base font-semibold">The year</h3>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {numField("Tax year", form.taxYear, (v) => {
            // A year change re-resolves the year-dependent
            // overlays (round-17 defect 2): the carry-in and
            // the education students belong to a year, so an
            // overlay resolved for the old year must not keep
            // pricing the new one. Only the unedited fields
            // move — a field the user edited keeps its typed
            // value exactly — and every other field is left
            // untouched, so no other typed value is
            // reformatted or disturbed. When the Tax Plan
            // record has not loaded there is no overlay to
            // re-resolve — an overlay can only exist after a
            // hydration that had the record — so the year
            // changes alone and the fields keep their stored
            // values.
            edit((f) => {
              const next = { ...f, taxYear: v };
              if (rothQ.data == null) return next;
              const year = parseIntOrNull(v) ?? new Date().getFullYear();
              const reresolved = reresolveDecemberStateForYear(
                stateFromForm(next),
                storedProvenanceRef.current,
                {
                  carryInSt: carryInStEdited,
                  carryInLt: carryInLtEdited,
                  carryInStWa: carryInStWaEdited,
                  carryInLtWa: carryInLtWaEdited,
                  education: educationEdited,
                  balances: balancesEdited,
                },
                recordFactsOf(rothQ.data, year),
              );
              if (!carryInStEdited) {
                next.carryInCapitalLossSt =
                  decemberNullableMoneyFormValue(
                    reresolved.carryInCapitalLossSt,
                  );
              }
              if (!carryInLtEdited) {
                next.carryInCapitalLossLt =
                  decemberNullableMoneyFormValue(
                    reresolved.carryInCapitalLossLt,
                  );
              }
              if (!carryInStWaEdited) {
                next.carryInCapitalLossStWa =
                  decemberNullableMoneyFormValue(
                    reresolved.carryInCapitalLossStWa,
                  );
              }
              if (!carryInLtWaEdited) {
                next.carryInCapitalLossLtWa =
                  decemberNullableMoneyFormValue(
                    reresolved.carryInCapitalLossLtWa,
                  );
              }
              if (!educationEdited) {
                next.educationStudents = (
                  reresolved.educationStudents ?? []
                ).map((x) => ({
                  expenses: moneyStr(x.expenses),
                  aotcEligible: x.aotcEligible,
                }));
              }
              // The year gate can clear a stored carry-in or
              // student whose stamp year is not the new year
              // (internal review round 4, SHOULD-1): the
              // stored provenance must follow the cleared
              // display, or the next save would persist the
              // old year's values and the reload would revive
              // them. Only the cleared fields are patched —
              // an edited field keeps its typed value, and a
              // same-year restore needs no patch. The patch
              // is to null even when the overlay filled a
              // new-year value (education students for the
              // new year): an overlay re-fill is display-only
              // and the save must not own it, so the save
              // persists null and the reload overlays again.
              if (storedProvenanceRef.current.taxYear !== year) {
                const stored = storedProvenanceRef.current;
                storedProvenanceRef.current = {
                  ...stored,
                  ...(carryInStEdited
                    ? {}
                    : { carryInCapitalLossSt: null }),
                  ...(carryInLtEdited
                    ? {}
                    : { carryInCapitalLossLt: null }),
                  ...(carryInStWaEdited
                    ? {}
                    : { carryInCapitalLossStWa: null }),
                  ...(carryInLtWaEdited
                    ? {}
                    : { carryInCapitalLossLtWa: null }),
                  ...(educationEdited
                    ? {}
                    : { educationStudents: null }),
                };
              }
              if (!balancesEdited) {
                next.pretaxBalancePrimary =
                  decemberNullableMoneyFormValue(
                    reresolved.pretaxBalancePrimary,
                  );
                next.pretaxBalanceSpouse =
                  decemberNullableMoneyFormValue(
                    reresolved.pretaxBalanceSpouse,
                  );
                // The year gate can clear a record-preseeded
                // balance (internal review round 3, SHOULD-1):
                // the stored provenance must follow the cleared
                // display, or the next save would persist the
                // stale starting balance and the reload would
                // revive it. Only a cleared (null) or
                // unchanged-from-stored value is written back —
                // a load-derived split (which differs from
                // stored) and an overlay re-fill (which the
                // save must not own) stay the console's own
                // saved answer and are never promoted into
                // provenance here.
                const stored = storedProvenanceRef.current;
                if (
                  reresolved.pretaxBalancePrimary == null ||
                  reresolved.pretaxBalancePrimary ===
                    stored.pretaxBalancePrimary
                ) {
                  storedProvenanceRef.current = {
                    ...stored,
                    pretaxBalancePrimary: reresolved.pretaxBalancePrimary,
                  };
                }
                if (
                  reresolved.pretaxBalanceSpouse == null ||
                  reresolved.pretaxBalanceSpouse ===
                    stored.pretaxBalanceSpouse
                ) {
                  storedProvenanceRef.current = {
                    ...storedProvenanceRef.current,
                    pretaxBalanceSpouse: reresolved.pretaxBalanceSpouse,
                  };
                }
              }
              return next;
            });
          }, {
            idLabel: "December tax year",
          })}
          <div>
            <label className={labelCls} htmlFor="december-filing">
              Filing status
            </label>
            <select
              id="december-filing"
              aria-label="December filing status"
              className={`${inputCls}`}
              value={form.filingStatus}
              onChange={(e) => set("filingStatus", e.target.value as FilingStatus)}
            >
              <option value="mfj">Married filing jointly</option>
              <option value="single">Single</option>
              <option value="hoh">Head of household</option>
            </select>
          </div>
          {numField("Age — primary", form.agePrimary, (v) => set("agePrimary", v), {
            idLabel: "December age primary",
            hint: "Age in the tax year.",
          })}
          {joint &&
            numField("Age — spouse", form.ageSpouse, (v) => set("ageSpouse", v), {
              idLabel: "December age spouse",
            })}
          {moneyField("Pre-tax balance — primary (prior Dec 31)", form.pretaxBalancePrimary, (v) => {
            setBalancesEdited(true);
            edit((f) => ({ ...f, pretaxBalancePrimary: v, pretaxSplitExplicit: true }));
          },
          { idLabel: "December pretax balance primary", hint: "The primary filer's own pre-tax balance. Sizes their RMD on their own clock and caps the draw. Enter 0 for a known-empty balance — blank means not entered, and only an entered balance caps the draw." },
          )}
          {joint &&
            moneyField("Pre-tax balance — spouse (prior Dec 31)", form.pretaxBalanceSpouse, (v) => {
              setBalancesEdited(true);
              edit((f) => ({ ...f, pretaxBalanceSpouse: v, pretaxSplitExplicit: true }));
            },
            { idLabel: "December pretax balance spouse", hint: "The spouse's own pre-tax balance — their RMD is computed on their own age and divisor table, not the primary's. Enter 0 for a known-empty balance — blank means not entered." },
            )}
          {moneyField("RMD already received this year", form.rmdAlreadyReceived, (v) =>
            set("rmdAlreadyReceived", v),
          { idLabel: "December RMD already received", hint: "The part of this year's RMD already paid — and already inside the year-to-date income below. It is subtracted from the RMD the balances imply, so a paid RMD is never counted twice." },
          )}
        </div>
        {decQ.data?.state &&
          !decQ.data.state.pretaxSplitExplicit &&
          decQ.data.state.pretaxBalance != null &&
          !balancesEdited && (
            <p className="mt-2 max-w-3xl text-sm text-[var(--dim)]" role="note">
              Balance ownership: this console’s saved state holds only a combined pre-tax
              total, so the per-owner balances above come from your Tax Plan record.
              Editing either balance here makes them this console’s own from then on.
            </p>
          )}
        {decQ.data?.state &&
          !decQ.data.state.pretaxSplitExplicit &&
          decQ.data.state.pretaxBalance != null &&
          !balancesEdited &&
          (() => {
            // Round-6: when the record's per-owner total
            // disagrees with this console's saved total,
            // name BOTH totals — the console prices its
            // own saved total, allocated by the record's
            // proportions (decemberCore resolution).
            const facts = recordFactsOf(rothQ.data);
            const savedTotal = decQ.data?.state?.pretaxBalance ?? null;
            if (
              facts.pretaxBalancePrimary == null ||
              facts.pretaxBalanceSpouse == null ||
              savedTotal == null
            ) {
              return null;
            }
            const recordSum = facts.pretaxBalancePrimary + facts.pretaxBalanceSpouse;
            if (Math.abs(recordSum - savedTotal) <= 0.01) return null;
            return (
              <p className="mt-2 max-w-3xl text-sm text-[var(--dim)]" role="note">
                Balance totals differ: your Tax Plan record’s per-owner balances add
                to {fmtDollars(recordSum)}, while this console’s saved total is{" "}
                {fmtDollars(savedTotal)}. This console prices its own saved total,
                split between the owners in the record’s proportions.
              </p>
            );
          })()}
        {decQ.data?.state &&
          !decQ.data.state.pretaxSplitExplicit &&
          decQ.data.state.pretaxBalance != null &&
          !balancesEdited &&
          (() => {
            // Round-7 fix A: the partial-cap case — exactly
            // one record amount is known and it exceeds the
            // saved total, so resolution caps that owner at
            // the saved total. Name both figures, in the
            // same one-note voice as the totals note above.
            const facts = recordFactsOf(rothQ.data);
            const savedTotal = decQ.data?.state?.pretaxBalance ?? null;
            if (savedTotal == null) return null;
            const known =
              facts.pretaxBalancePrimary != null &&
              facts.pretaxBalanceSpouse == null
                ? facts.pretaxBalancePrimary
                : facts.pretaxBalanceSpouse != null &&
                    facts.pretaxBalancePrimary == null
                  ? facts.pretaxBalanceSpouse
                  : null;
            if (known == null || known <= savedTotal + 0.01) return null;
            return (
              <p className="mt-2 max-w-3xl text-sm text-[var(--dim)]" role="note">
                Balance totals differ: your Tax Plan record shows{" "}
                {fmtDollars(known)} for one owner, while this console’s saved
                total is {fmtDollars(savedTotal)}. This console prices its own
                saved total, with that owner’s share capped at the saved total.
              </p>
            );
          })()}
        {decQ.data?.state &&
          decQ.data.state.pretaxSplitExplicit &&
          decQ.data.state.pretaxBalancePrimary != null &&
          decQ.data.state.pretaxBalanceSpouse != null &&
          !balancesEdited &&
          (() => {
            // Build v127 (round-19 finding 1): the
            // explicit-split case the two notes above do
            // not cover — this console prices its OWN
            // per-owner split, not the record's, so when
            // the two splits' totals disagree, name both.
            // An explicit split is a deliberate override
            // and it governs; the note exists so the
            // disagreement is never silent (a split saved
            // before the snapshot-minus-spouse fix can
            // otherwise carry a double-counted primary
            // with no warning at all).
            const facts = recordFactsOf(rothQ.data);
            if (
              facts.pretaxBalancePrimary == null ||
              facts.pretaxBalanceSpouse == null
            ) {
              return null;
            }
            const recordSum =
              facts.pretaxBalancePrimary + facts.pretaxBalanceSpouse;
            const consoleSum =
              decQ.data!.state.pretaxBalancePrimary! +
              decQ.data!.state.pretaxBalanceSpouse!;
            if (Math.abs(recordSum - consoleSum) <= 0.01) return null;
            return (
              <p className="mt-2 max-w-3xl text-sm text-[var(--dim)]" role="note">
                Balance totals differ: this console’s per-owner balances add
                to {fmtDollars(consoleSum)}, while your Tax Plan record’s add
                to {fmtDollars(recordSum)}. This console prices its own
                explicit split.
              </p>
            );
          })()}
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={form.onMedicarePrimary}
              onChange={(e) => set("onMedicarePrimary", e.target.checked)}
            />
            Primary on Medicare
          </label>
          {joint && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={form.onMedicareSpouse}
                onChange={(e) => set("onMedicareSpouse", e.target.checked)}
              />
              Spouse on Medicare
            </label>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={form.spouseSoleBeneficiary}
              onChange={(e) => set("spouseSoleBeneficiary", e.target.checked)}
            />
            Spouse is sole beneficiary of the pre-tax accounts
          </label>
        </div>
        {joint && (
          <div className="mt-3 max-w-md">
            <label
              className={labelCls}
              htmlFor="december-primary-sole-beneficiary-of-spouse"
            >
              You are the sole beneficiary of your spouse’s pre-tax accounts
            </label>
            <select
              id="december-primary-sole-beneficiary-of-spouse"
              aria-label="You are the sole beneficiary of your spouse’s pre-tax accounts"
              className={inputCls}
              value={
                form.primarySoleBeneficiaryOfSpouse == null
                  ? "unanswered"
                  : form.primarySoleBeneficiaryOfSpouse
                    ? "yes"
                    : "no"
              }
              onChange={(e) => {
                setBeneficiaryEdited(true);
                // Answering here settles the carried-over
                // answer too: the confirm flag clears.
                edit((f) => ({
                  ...f,
                  primarySoleBeneficiaryOfSpouse:
                    e.target.value === "unanswered"
                      ? null
                      : e.target.value === "yes",
                  legacyBeneficiaryAnswerUnconfirmed: false,
                }));
              }}
            >
              <option value="unanswered">Not answered</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
            {form.legacyBeneficiaryAnswerUnconfirmed && (
              <p className="mt-1 text-sm text-[var(--warn)]" role="note">
                This answer was carried over from an older version of this
                console — please check that it is still right.
              </p>
            )}
            <p className={hintCls}>
              This fact alone picks your spouse’s RMD table. “Not answered”
              prices it on the Uniform table; when your Tax Plan record
              answers this, that answer shows here until you answer in this
              console — and it is not saved into this console unless you
              change it here, so a later change to the record still flows
              in.
            </p>
          </div>
        )}
      </section>

      {/* Year-to-date actuals */}
      <section className={sectionCls} aria-label="Year-to-date actuals">
        <h3 className="text-base font-semibold">Already in — year-to-date actuals</h3>
        <p className="mt-1 text-sm text-[var(--dim)]">
          Income already posted this year, by category. These are facts, not estimates —
          enter them from year-to-date statements.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {moneyField("Wages & other ordinary income", form.ytdOtherOrdinary, (v) =>
            set("ytdOtherOrdinary", v),
          { idLabel: "December YTD other ordinary", hint: "Includes any RMD already received — enter that amount in “RMD already received this year” above so it isn’t counted twice." },
          )}
          {moneyField("Interest", form.ytdInterest, (v) => set("ytdInterest", v), {
            idLabel: "December YTD interest",
          })}
          {moneyField("Ordinary dividends (total)", form.ytdOrdinaryDividends, (v) =>
            set("ytdOrdinaryDividends", v),
          { idLabel: "December YTD ordinary dividends", hint: "The total — it includes the qualified part below." },
          )}
          {moneyField("Qualified dividends", form.ytdQualifiedDividends, (v) =>
            set("ytdQualifiedDividends", v),
          { idLabel: "December YTD qualified dividends", hint: "Part of the total above — entered above that total, only the total prices." },
          )}
          {moneyField("Tax-exempt interest", form.ytdTaxExemptInterest, (v) =>
            set("ytdTaxExemptInterest", v),
          { idLabel: "December YTD tax-exempt interest", hint: "Tax-free, but it counts toward ACA MAGI." },
          )}
          {moneyField("Realized capital gain / loss so far", form.ytdCapitalGain, (v) =>
            set("ytdCapitalGain", v),
          { idLabel: "December YTD capital gain", hint: "Signed — enter a net loss as a negative amount." },
          )}
          {moneyField("Cost basis of the sales behind that gain", form.saleBasis, (v) =>
            set("saleBasis", v),
          {
            idLabel: "December sale basis",
            hint: "The basis returned on the sales behind the gains above — a sale's proceeds are its gain plus its basis, and cash left counts the proceeds. Leave blank when there were no sales, or when the basis is unknown (cash left counts only the gains until the basis is entered). Distributions have no basis.",
          },
          )}
          {moneyField("Social Security — primary", form.ytdSsPrimary, (v) =>
            set("ytdSsPrimary", v),
          { idLabel: "December YTD SS primary" },
          )}
          {joint &&
            moneyField("Social Security — spouse", form.ytdSsSpouse, (v) =>
              set("ytdSsSpouse", v),
            { idLabel: "December YTD SS spouse" },
            )}
        </div>
        {/* Dividend-pair note (audit S-8, contract v137) —
            display ONLY, matching the Playground's note on
            its dials: the qualified figure is part of the
            ordinary total, so a qualified figure above the
            total is a pair that cannot occur. The engine
            clamps the qualified part to the total — it prices
            as the total, the excess isn't counted, and the
            non-qualified part prices as $0 — and this note
            makes that visible here instead of letting the
            excess drop out silently. It reads the two fields
            exactly as the priced state clamps them
            (negatives to $0) and never alters pricing; the
            projection above also warns on the pair. */}
        {Math.max(0, parseMoney(form.ytdQualifiedDividends)) >
          Math.max(0, parseMoney(form.ytdOrdinaryDividends)) && (
          <p className="tnum mt-3 max-w-3xl text-sm text-[var(--warn)]" role="note">
            Qualified dividends ({fmtDollars(Math.max(0, parseMoney(form.ytdQualifiedDividends)))}) can&rsquo;t
            exceed the total ordinary dividends ({fmtDollars(Math.max(0, parseMoney(form.ytdOrdinaryDividends)))}) —
            the qualified figure is part of that total, so it prices as{" "}
            {fmtDollars(Math.max(0, parseMoney(form.ytdOrdinaryDividends)))}, the
            excess isn&rsquo;t counted, and the non-qualified part prices as $0.
          </p>
        )}
      </section>

      {/* Capital losses carried into this year (build v111) */}
      <section className={sectionCls} aria-label="Capital losses carried into this year">
        <h3 className="text-base font-semibold">Capital losses carried into this year</h3>
        <p className="mt-1 max-w-3xl text-sm text-[var(--dim)]">
          A capital-loss carryforward is a net capital loss from an earlier year that
          wasn&rsquo;t used up — the unused part carries forward into this year. Enter
          the short-term and long-term amounts still unused as this year begins. The
          console nets them against this year&rsquo;s gains, then applies up to $3,000
          of what is left against ordinary income for the year. Anything still unused
          carries into next year and is shown on the case cards above. Leave a field
          blank if it hasn&rsquo;t been entered yet; enter 0 when there is none.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {moneyField("Short-term loss carried in", form.carryInCapitalLossSt, (v) => {
            setCarryInStEdited(true);
            edit((f) => ({ ...f, carryInCapitalLossSt: v }));
          },
          { idLabel: "December carry-in short-term loss" },
          )}
          {moneyField("Long-term loss carried in", form.carryInCapitalLossLt, (v) => {
            setCarryInLtEdited(true);
            edit((f) => ({ ...f, carryInCapitalLossLt: v }));
          },
          { idLabel: "December carry-in long-term loss" },
          )}
          {moneyField("Of the short-term loss, the Washington part", form.carryInCapitalLossStWa, (v) => {
            setCarryInStWaEdited(true);
            edit((f) => ({ ...f, carryInCapitalLossStWa: v }));
          },
          { idLabel: "December carry-in short-term loss Washington part", hint: "Only the part of the loss that came from sales allocated to Washington — that part alone can reduce the Washington capital-gains tax base, and only when this year’s gains actually absorb it." },
          )}
          {moneyField("Of the long-term loss, the Washington part", form.carryInCapitalLossLtWa, (v) => {
            setCarryInLtWaEdited(true);
            edit((f) => ({ ...f, carryInCapitalLossLtWa: v }));
          },
          { idLabel: "December carry-in long-term loss Washington part", hint: "The Washington-allocated part of the long-term loss above." },
          )}
        </div>
      </section>

      {/* Gain harvest (build v113) */}
      <section className={sectionCls} aria-label="Gain harvest">
        <h3 className="text-base font-semibold">Gain harvest</h3>
        <p className="mt-1 max-w-3xl text-sm text-[var(--dim)]">
          Gain harvesting means selling taxable investments on purpose to realize
          long-term gains that land inside the 0% capital-gains band — the part of
          the gains stack taxed at 0% — and buying them back at the higher basis.
          Inside the band the harvest costs no extra federal tax, but every
          harvested dollar still counts as income: it raises MAGI, shrinks the ACA
          premium credit, and shrinks the safe December draw above by the same
          amount, because the draw is sized with the harvest included. When this
          is switched on, the console sizes the harvest the way the Tax Plan does:
          the largest gain that stays inside the 0% band, capped by the remaining
          pool&rsquo;s unrealized gain (the pool left after this year&rsquo;s sales,
          less its basis). The pool below is the pool as it stood at the start of
          the year, before this year&rsquo;s sales — the console nets the sales out
          itself — and when the pool comes from your Tax Plan record, the
          record&rsquo;s current pool is converted to that start-of-year pool by
          adding this year&rsquo;s sales back. An entering capital-loss
          carryforward above absorbs harvested gains first, exactly as it absorbs
          any other gain.
        </p>
        <div className="mt-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              aria-label="Harvest gains into the 0% bracket"
              checked={form.harvestOn}
              onChange={(e) => set("harvestOn", e.target.checked)}
            />
            Harvest gains into the 0% bracket this year
          </label>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {moneyField("Taxable pool at the start of the year", form.harvestPoolAmount, (v) => {
            setHarvestPoolAmountEdited(true);
            edit((f) => ({ ...f, harvestPoolAmount: v }));
          },
          { idLabel: "December harvest pool", hint: "The whole taxable pool the harvest can sell from — taxable investments plus cash, the pool the Tax Plan draws on — as it stood at the start of this year, BEFORE this year’s sales. The console subtracts this year’s sales itself to find what is left to harvest from, so enter the start-of-year pool, not today’s balance. Leave blank if it hasn’t been entered yet; enter 0 when there is no pool." },
          )}
          {pctField("Basis — % of the pool already taxed", form.harvestPoolBasisPct, (v) => {
            setHarvestPoolBasisPctEdited(true);
            edit((f) => ({ ...f, harvestPoolBasisPct: v }));
          },
          { idLabel: "December harvest basis percent", hint: "The share of the pool that is already-taxed basis. The rest is unrealized gain — the most the harvest can realize. Leave blank if it hasn’t been entered yet; 100% means no gain to harvest." },
          )}
        </div>
        {form.harvestOn &&
          (form.harvestPoolAmount.trim() === "" ||
            form.harvestPoolBasisPct.trim() === "") && (
            <p className="mt-3 max-w-3xl text-sm text-[var(--warn)]" role="note">
              Harvesting is switched on, but the pool or its basis is missing —
              here and in your Tax Plan record — so the settlement above excludes
              gain harvesting until both are entered.
            </p>
          )}
        {/* Harvest note (build v203, re-audit round 3 NICE-3): the
            trailing clause is DERIVED from the two figures the note
            itself states. The harvest at the headline draw can be
            SMALLER than at a $0 draw (the draw's ordinary income
            shrinks the 0% band's room), but it can also be EQUAL —
            when the pool's unrealized gain caps the harvest at both
            draws, or the headline draw is $0 — and the old clause
            claimed the draw takes room in every case, contradicting
            the note's own figures whenever they were equal. The
            clause now says what the figures show in each case. */}
        {likelyCase != null && likelyCase.harvestedGainAtZeroDraw > 0 && (
          <p className="tnum mt-3 max-w-3xl text-sm text-[var(--dim)]">
            Before any December draw, the harvest realizes{" "}
            {fmtDollars(likelyCase.harvestedGainAtZeroDraw)} in the likely case;
            at the headline draw it realizes{" "}
            {fmtDollars(likelyCase.harvestedGainAtHeadline)} —{" "}
            {likelyCase.harvestedGainAtHeadline <
            likelyCase.harvestedGainAtZeroDraw
              ? "the draw takes room the harvest would otherwise use."
              : likelyCase.harvestedGainAtHeadline >
                  likelyCase.harvestedGainAtZeroDraw
                ? "more than before any draw, so the headline draw leaves the harvest more room than a $0 draw does."
                : "the same amount as before any draw, so the headline draw takes no room from the harvest."}
          </p>
        )}
      </section>

      {/* Taxable cash for the year (build v125) */}
      <section className={sectionCls} aria-label="Taxable cash for the year">
        <h3 className="text-base font-semibold">Taxable cash for the year</h3>
        <p className="mt-1 max-w-3xl text-sm text-[var(--dim)]">
          Cash taken from taxable at 100% basis for the year — the money
          that pays the tax bill and the spending the pre-tax draw does not
          cover. A 100%-basis sale realizes no gain, so it adds nothing to
          MAGI: it does not change the maximum safe pre-tax draw above, the
          credit, or the tax. It is money in addition to the draw, not part
          of it — cash left after tax above rises by this amount, dollar for
          dollar.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {moneyField("Taxable cash for the year (100% basis)", form.taxableFunded, (v) =>
            set("taxableFunded", v),
          { idLabel: "December taxable cash", hint: "Cash from taxable at 100% basis — the part already taxed, so selling it realizes no gain and adds nothing to MAGI. Leave blank if none; enter 0 when explicitly none." },
          )}
        </div>
        {(() => {
          const n = decemberNullableMoneyFromFormValue(form.taxableFunded);
          return n != null && n > 0 ? (
            <p className="tnum mt-3 max-w-3xl text-sm text-[var(--dim)]">
              Cash left after tax above includes this {fmtDollars(n)} — the
              maximum safe pre-tax draw is unchanged.
            </p>
          ) : null;
        })()}
      </section>

      {/* Remaining ranges */}
      <section className={sectionCls} aria-label="Still to come">
        <h3 className="text-base font-semibold">Still to come — December stragglers</h3>
        <p className="mt-1 text-sm text-[var(--dim)]">
          Income not yet posted, as a low / likely / high range per line. The headline draw
          is sized on the likely case; the low and high cases show what the same draw does
          if the stragglers land light or heavy.
        </p>
        {rangeRow("Capital-gain distributions still to come", "remCapDist",
          "Fund distributions estimated in the fall, final when they post in December.")}
        {rangeRow("Interest still to come", "remInterest")}
        {rangeRow("Ordinary dividends still to come (total)", "remOrdinaryDividends")}
        {rangeRow("Qualified dividends still to come", "remQualifiedDividends")}
        {rangeRow("Other income still to come", "remOtherOrdinary")}
        {/* Dividend-pair note (audit S-8, contract v137;
            case naming audit N-5) — display ONLY, the
            still-to-come twin of the year-to-date note
            above: each case's qualified figure is part of
            that case's ordinary total, and the engine
            clamps it to that total per case, so an excess
            prices nowhere. One note per impossible case,
            naming WHICH case it is (low / likely / high)
            with that case's two figures — the earlier
            single note said only that some case was
            impossible; never alters pricing. */}
        {(() => {
          const impossible = (["low", "likely", "high"] as const).flatMap((k) => {
            const total = Math.max(0, parseMoney(form.remOrdinaryDividends[k]));
            const qualified = Math.max(0, parseMoney(form.remQualifiedDividends[k]));
            return qualified > total ? [{ k, total, qualified }] : [];
          });
          return impossible.map(({ k, total, qualified }) => (
            <p key={k} className="tnum mt-3 max-w-3xl text-sm text-[var(--warn)]" role="note">
              {k === "low" ? "Low" : k === "likely" ? "Likely" : "High"} case:
              qualified dividends still to come ({fmtDollars(qualified)}) can&rsquo;t
              exceed that case&rsquo;s total ordinary dividends still to come (
              {fmtDollars(total)}) — the qualified figure is part of that total, so
              it prices as {fmtDollars(total)}, the excess isn&rsquo;t counted, and
              that case&rsquo;s non-qualified part prices as $0.
            </p>
          ));
        })()}
      </section>

      {/* ACA block */}
      <section className={sectionCls} aria-label="ACA and the cliff">
        <h3 className="text-base font-semibold">ACA and the cliff</h3>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {numField("ACA household size", form.acaHouseholdSize, (v) =>
            set("acaHouseholdSize", v),
          { idLabel: "December ACA household size", hint: "The tax household for the year." },
          )}
          {moneyField("Benchmark premium (annual)", form.acaBenchmarkAnnual, (v) =>
            set("acaBenchmarkAnnual", v),
          { idLabel: "December ACA benchmark", hint: "Second-lowest-cost Silver plan for the household. Blank means the credit is not priced; an entered 0 prices a $0 credit." },
          )}
          {moneyField("Enrollment premium (annual, the plan actually enrolled in)", form.acaEnrollmentPremiumAnnual, (v) =>
            set("acaEnrollmentPremiumAnnual", v),
          { idLabel: "December ACA enrollment premium", hint: "Optional — leave blank for no cap. When entered, each case’s final credit is capped at this premium (the credit never exceeds the premium of the plan actually enrolled in), applied before any coverage-month reduction." },
          )}
          {moneyField("Advance credit (APTC) already taken", form.aptcTaken, (v) =>
            set("aptcTaken", v),
          { idLabel: "December APTC taken", hint: "Year-to-date. The repayment control is tracking cumulative advance credit taken — plus any scheduled remaining advances — against the projected final credit at the landing, which each case above shows. Any amount above the final credit is repaid in full at filing — no repayment caps after 2025. Over the cliff the final credit is $0, so the whole amount is repaid. Aligning the marketplace income estimate with the target is a starting input only and does not guarantee zero repayment — advances already paid under a different estimate are sunk." },
          )}
          {moneyField("Buffer below the cliff", form.bufferDollars, (v) =>
            set("bufferDollars", v),
          { idLabel: "December cliff buffer", hint: "The draw aims at cliff − buffer, so late surprises land in the buffer, not over the cliff." },
          )}
        </div>
        <p className="mt-3 max-w-3xl text-sm text-[var(--dim)]">
          The cliff rule: eligibility is lost only when MAGI ends <em>above</em> 400% of
          the poverty line for the household size — landing exactly at 400% remains
          eligible. The draw still aims at cliff − buffer, so the distinction changes
          nothing about the target, only about what counts as over.
        </p>
      </section>

      {/* Education credits (build v103) */}
      <section className={sectionCls} aria-label="Education credits">
        <h3 className="text-base font-semibold">Education credits</h3>
        <div className="mt-1 max-w-3xl space-y-1 text-sm text-[var(--dim)]">
          <p>
            <strong className="text-[var(--text)]">AOTC — the American Opportunity Credit:</strong>{" "}
            up to $2,500 per student. Of that, $1,500 lowers the tax bill, and
            $1,000 is refundable — it comes back at filing even if no tax is
            owed.
          </p>
          <p>
            <strong className="text-[var(--text)]">LLC — the Lifetime Learning Credit:</strong>{" "}
            up to $2,000 per tax return (not per student), for students who do
            not qualify for the AOTC.
          </p>
          <p>
            Both credits shrink once married-filing-jointly income passes
            $160,000, and they are gone at $180,000.
          </p>
          <p>
            Qualified expenses are the amounts from Form 1098-T — tuition and
            required fees the student actually paid this year. Enter one row
            per student, and check the AOTC box only for a student who
            qualifies for the American Opportunity Credit.
          </p>
        </div>
        {form.educationStudents.length === 0 && (
          <p className="mt-3 text-sm text-[var(--warn)]" role="note">
            No students entered — the settlement above excludes education
            credits.
          </p>
        )}
        {form.educationStudents.map((student, i) => (
          <div
            key={i}
            className="mt-3 rounded-[var(--radius)] border border-[var(--border)] px-3 py-3"
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {moneyField(
                `Student ${i + 1} — qualified expenses`,
                student.expenses,
                (v) => {
                  setEducationEdited(true);
                  edit((f) => ({
                    ...f,
                    educationStudents: f.educationStudents.map((x, j) =>
                      j === i ? { ...x, expenses: v } : x,
                    ),
                  }));
                },
                { idLabel: `December education student ${i + 1} expenses` },
              )}
              <div className="flex items-end justify-between gap-3 pb-1">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    aria-label={`Student ${i + 1} eligible for the American Opportunity Credit (AOTC)`}
                    checked={student.aotcEligible}
                    onChange={(e) => {
                      setEducationEdited(true);
                      edit((f) => ({
                        ...f,
                        educationStudents: f.educationStudents.map((x, j) =>
                          j === i ? { ...x, aotcEligible: e.target.checked } : x,
                        ),
                      }));
                    }}
                  />
                  Eligible for the AOTC
                </label>
                <button
                  type="button"
                  aria-label={`Remove student ${i + 1}`}
                  className="text-sm text-[var(--dim)] underline underline-offset-2 hover:text-[var(--bad)]"
                  onClick={() => {
                    setEducationEdited(true);
                    edit((f) => ({
                      ...f,
                      educationStudents: f.educationStudents.filter(
                        (_, j) => j !== i,
                      ),
                    }));
                  }}
                >
                  Remove
                </button>
              </div>
            </div>
          </div>
        ))}
        <button
          type="button"
          aria-label="Add a student"
          className="mt-3 rounded-[var(--radius)] border border-[var(--border)] px-4 py-2 text-sm font-medium hover:text-[var(--accent)]"
          onClick={() => {
            setEducationEdited(true);
            edit((f) => ({
              ...f,
              educationStudents: [
                ...f.educationStudents,
                { expenses: "", aotcEligible: true },
              ],
            }));
          }}
        >
          Add a student
        </button>
        {likelyCase != null && likelyCase.hasEducationExpenses && (
          <p className="tnum mt-3 max-w-3xl text-sm text-[var(--dim)]">
            Priced at the headline draw:{" "}
            {likelyCase.educationChoiceAtHeadline === "aotc"
              ? `American Opportunity Credit ${fmtDollars(likelyCase.educationAotcAtHeadline)}`
              : likelyCase.educationChoiceAtHeadline === "llc"
                ? `Lifetime Learning Credit ${fmtDollars(likelyCase.educationLlcAtHeadline)}`
                : "no credit after the phase-out"}
            {likelyCase.educationNonrefundableAtHeadline > 0 &&
              ` — ${fmtDollars(likelyCase.educationNonrefundableAtHeadline)} applied against the tax`}
            {likelyCase.educationRefundableAtHeadline > 0 &&
              `, plus ${fmtDollars(likelyCase.educationRefundableAtHeadline)} refundable at filing`}
            . Already reflected in the settlement above.
          </p>
        )}
        {form.educationStudents.length > 0 &&
          !form.educationStudents.some((x) => parseMoney(x.expenses) > 0) && (
            <p className="mt-3 text-sm text-[var(--warn)]" role="note">
              No expenses entered yet — the settlement above excludes
              education credits until a student&rsquo;s expenses are entered.
            </p>
          )}
      </section>

      {/* Strays checklist */}
      <section className={sectionCls} aria-label="Strays checklist">
        <h3 className="text-base font-semibold">Strays checklist</h3>
        <p className="mt-1 text-sm text-[var(--dim)]">
          The late and easily missed items. Mark each one “doesn’t apply”, checked, or enter
          its amount — an amount flows into every case, on top of the ranges above, so don’t
          enter the same income in both places.
        </p>
        {strayRow("Capital-gain distribution estimates received", "strayCapDist", {
          amountLabel: "Estimated distributions not in the ranges above",
          hint: "Estimates are not finals — the final amounts can move when they post. The buffer absorbs that gap; it does not bound it.",
        })}
        {strayRow("Fund distributions paid in January but taxed this year", "strayJanPaid", {
          amountLabel: "January-paid distributions deemed received December 31",
          note: form.legacyJanPaidSplitUnconfirmed
            ? "Saved before the qualified-dividend split existed — check it: this amount predates the “of which qualified” field, so confirm the qualified portion below before relying on it."
            : undefined,
          hint: "A dividend declared in October–December with a December record date and paid in January is deemed received on December 31 — check each fund’s declarations and distribution calendar, not just cash postings. An exempt-interest portion belongs under the tax-exempt item below, not here.",
          extra: (
            <div className="mt-2 max-w-xs">
              {moneyField("Of which qualified dividends", form.strayJanPaidQualifiedAmount, (v) => {
                // Round-6: this field IS the January-paid
                // character control — editing it confirms
                // the character and clears its flag.
                setJanPaidCharacterEdited(true);
                edit((f) => ({
                  ...f,
                  strayJanPaidQualifiedAmount: v,
                  legacyJanPaidSplitUnconfirmed: false,
                }));
              },
              { idLabel: "December stray January-paid qualified portion", hint: "The part of the total above that is qualified dividends — it keeps its qualified character. Leave at $0 if none of it is qualified." },
              )}
              {moneyField("Of which capital-gain distributions", form.strayJanPaidCapGainAmount, (v) => {
                // Build v104: this field is a plain
                // character split of the same total — it
                // does NOT touch the qualified-amount
                // provenance flag above, which only the
                // qualified field confirms.
                edit((f) => ({
                  ...f,
                  strayJanPaidCapGainAmount: v,
                }));
              },
              { idLabel: "December stray January-paid capital-gain portion", hint: "The part of the total above that the fund calls a capital-gain distribution. Leave at $0 if none of it is one." },
              )}
              <p className="mt-2 text-sm text-[var(--dim)]">
                A distribution declared in October–December and paid in
                January counts as received on December 31 of the earlier
                year. A capital-gain distribution is a long-term gain,
                not an ordinary dividend — enter that part above so it is
                taxed as a gain.
              </p>
              {/* Stray-portion clamp notes (re-audit N-6) —
                  display ONLY, mirroring the projection's
                  warnings: each portion above is part of its
                  total (the qualified portion part of the
                  ordinary remainder — the total less its
                  clamped capital-gain portion), and the
                  engine clamps it to that limit, so a trimmed
                  excess prices nowhere. Each note names the
                  portion, its entered figure, its limit, the
                  amount trimmed, and the figure it prices
                  as, computed with the assembly's own clamp
                  arithmetic; the projection above also warns
                  on each trim. */}
              {(() => {
                const total =
                  form.strayJanPaid.status === "amount"
                    ? Math.max(0, parseMoney(form.strayJanPaid.amount))
                    : 0;
                const capEntered = Math.max(
                  0,
                  parseMoney(form.strayJanPaidCapGainAmount),
                );
                const capClamped = total > 0 ? Math.min(total, capEntered) : 0;
                const remainder = total - capClamped;
                const qualEntered = Math.max(
                  0,
                  parseMoney(form.strayJanPaidQualifiedAmount),
                );
                const qualClamped =
                  remainder > 0 ? Math.min(remainder, qualEntered) : 0;
                return (
                  <>
                    {capEntered > capClamped && (
                      <p className="tnum mt-2 text-sm text-[var(--warn)]" role="note">
                        Capital-gain portion ({fmtDollars(capEntered)}) can&rsquo;t
                        exceed the January-paid total ({fmtDollars(total)}) — the
                        portion is part of that total, so{" "}
                        {fmtDollars(capEntered - capClamped)} is trimmed and
                        isn&rsquo;t counted: it prices as {fmtDollars(capClamped)}.
                      </p>
                    )}
                    {qualEntered > qualClamped && (
                      <p className="tnum mt-2 text-sm text-[var(--warn)]" role="note">
                        Qualified-dividends portion ({fmtDollars(qualEntered)}) can&rsquo;t
                        exceed the January-paid ordinary remainder (
                        {fmtDollars(remainder)}) — the total less its capital-gain
                        portion — so {fmtDollars(qualEntered - qualClamped)} is
                        trimmed and isn&rsquo;t counted: it prices as{" "}
                        {fmtDollars(qualClamped)}.
                      </p>
                    )}
                  </>
                );
              })()}
            </div>
          ),
        })}
        {strayRow("Dividends & interest actuals complete", "strayDivInt", {
          amountLabel: "Money-market dividends / savings-bond interest not entered above",
          hint: "Include money-market dividends from any cash sleeve, and savings-bond interest in the year a bond matures or is redeemed — both are easy to leave out of the actuals above.",
        })}
        {strayRow("Gains on sales planned to fund taxes or raise cash", "strayPlannedSales", {
          amountLabel: "Forecast gain on planned sales",
          hint: "Selling investments to pay the tax bill or raise spending cash realizes a gain too. Forecast it lot by lot (specific share lots) — the gain BEFORE any prior-year capital-loss carryforward: enter the carryforward in the “Capital losses carried into this year” section above and the console nets it for you.",
        })}
        {strayRow("Return of capital reclassified as an ordinary dividend", "strayROCOrdinary", {
          // Round-6: this row IS the ROC character
          // control — editing it (status or amount)
          // confirms the character and clears its flag.
          onEdit: () => {
            setRocCharacterEdited(true);
            edit((f) => ({ ...f, legacyRocSplitUnconfirmed: false }));
          },
          amountLabel: "Amount reclassified as an ordinary dividend",
          note: form.legacyRocSplitUnconfirmed
            ? "Saved before this split existed — check it: the return-of-capital amount below was entered before there were two items, so confirm how much of it belongs here as an ordinary dividend."
            : undefined,
          hint: "When a fund reclassifies return of capital as a dividend, that part is an ORDINARY dividend — it is taxed as ordinary income, not as a capital gain. Enter it here, not under the capital part below.",
          extra: (
            <div className="mt-2 max-w-xs">
              {moneyField("Of which qualified dividends", form.strayROCQualifiedAmount, (v) => {
                edit((f) => ({
                  ...f,
                  strayROCQualifiedAmount: v,
                }));
              },
              { idLabel: "December stray ROC qualified portion", hint: "The part of the amount above that the fund reports as qualified dividends. Leave at $0 if none of it is qualified." },
              )}
              <p className="mt-2 text-sm text-[var(--dim)]">
                A reclassified dividend can itself be a qualified dividend
                (the fund reports it as one on Form 1099-DIV). That part is
                taxed at the lower qualified-dividend rates, not as ordinary
                income — enter that part above so it keeps its qualified
                character.
              </p>
              {/* Stray-portion clamp note (re-audit N-6) —
                  display ONLY, mirroring the projection's
                  warning: the qualified portion above is part
                  of the reclassified total, and the engine
                  clamps it to that total, so a trimmed excess
                  prices nowhere. The note names the portion,
                  its entered figure, its total, the amount
                  trimmed, and the figure it prices as; the
                  projection above also warns on the trim. */}
              {(() => {
                const total =
                  form.strayROCOrdinary.status === "amount"
                    ? Math.max(0, parseMoney(form.strayROCOrdinary.amount))
                    : 0;
                const entered = Math.max(
                  0,
                  parseMoney(form.strayROCQualifiedAmount),
                );
                const clamped = total > 0 ? Math.min(total, entered) : 0;
                return entered > clamped ? (
                  <p className="tnum mt-2 text-sm text-[var(--warn)]" role="note">
                    Qualified-dividends portion ({fmtDollars(entered)}) can&rsquo;t
                    exceed the reclassified ordinary-dividend total (
                    {fmtDollars(total)}) — the qualified figure is part of that
                    total, so {fmtDollars(entered - clamped)} is trimmed and
                    isn&rsquo;t counted: it prices as {fmtDollars(clamped)}.
                  </p>
                ) : null;
              })()}
            </div>
          ),
        })}
        {strayRow("Return of capital over basis (capital gain)", "strayROC", {
          amountLabel: "Income over basis (capital gain)",
          note: form.legacyRocSplitUnconfirmed
            ? "Saved before the split existed — check it: this amount was entered before the capital / ordinary split, so confirm the part above that was reclassified as an ordinary dividend."
            : undefined,
          hint: "Return of capital normally just reduces basis — it becomes income only once it exceeds the shares’ basis, and that part is a capital gain. Enter only that over-basis part here; a pure basis reduction is “checked — none”.",
        })}
        {strayRow("K-1 income (partnership, S-corp, trust)", "strayK1", {
          amountLabel: "K-1 income expected for the year (a deductible loss as a negative amount)",
          hint: "Taxable K-1 allocations count whether or not cash was distributed. A currently deductible K-1 loss is entered as a negative amount and reduces income dollar for dollar.",
          extra: (
            <div className="mt-2 max-w-xs">
              {moneyField("Of which long-term capital gain (box 9a)", form.strayK1CapGainAmount, (v) => {
                edit((f) => ({
                  ...f,
                  strayK1CapGainAmount: v,
                }));
              },
              { idLabel: "December stray K-1 capital-gain portion", hint: "The part of the K-1 amount above reported on Schedule K-1 box 9a as a net long-term capital gain. Leave at $0 if none of it is one." },
              )}
              <p className="mt-2 text-sm text-[var(--dim)]">
                Schedule K-1 box 9a reports the long-term capital gain part
                of a K-1 amount. That part is taxed at the lower
                capital-gains rates; the rest is taxed as ordinary income.
                Enter the box 9a part above so it is taxed as a gain.
              </p>
              {/* Stray-portion clamp note (re-audit N-6) —
                  display ONLY, mirroring the projection's
                  warning: the box 9a portion above is part of
                  a POSITIVE K-1 total, and the engine clamps
                  it to that total (a K-1 loss has no gain
                  portion at all), so a trimmed excess prices
                  nowhere. The note names the portion, its
                  entered figure, its limit, the amount
                  trimmed, and the figure it prices as; the
                  projection above also warns on the trim. */}
              {(() => {
                const total =
                  form.strayK1.status === "amount"
                    ? parseMoney(form.strayK1.amount)
                    : 0;
                const entered = Math.max(
                  0,
                  parseMoney(form.strayK1CapGainAmount),
                );
                const clamped = total > 0 ? Math.min(total, entered) : 0;
                if (entered <= clamped) return null;
                return total > 0 ? (
                  <p className="tnum mt-2 text-sm text-[var(--warn)]" role="note">
                    Long-term capital gain portion (box 9a) ({fmtDollars(entered)})
                    can&rsquo;t exceed the K-1 total ({fmtDollars(total)}) — the
                    portion is part of that total, so{" "}
                    {fmtDollars(entered - clamped)} is trimmed and isn&rsquo;t
                    counted: it prices as {fmtDollars(clamped)}.
                  </p>
                ) : (
                  <p className="tnum mt-2 text-sm text-[var(--warn)]" role="note">
                    Long-term capital gain portion (box 9a) ({fmtDollars(entered)})
                    can&rsquo;t apply when the K-1 total ({fmtDollars(total)}) is
                    not positive — a K-1 amount that is not a gain has no gain
                    portion, so the whole {fmtDollars(entered - clamped)} is
                    trimmed and isn&rsquo;t counted: it prices as $0.
                  </p>
                );
              })()}
            </div>
          ),
        })}
        {strayRow("Tax-exempt interest beyond the actuals above", "strayTaxExempt", {
          amountLabel: "Additional tax-exempt interest",
          hint: "Federally tax-free, but added back for ACA MAGI.",
        })}
        {strayRow("A dependent in the household is required to file", "strayDependent", {
          amountLabel: "That dependent’s income",
          hint: "Count a dependent’s income toward household MAGI only when the dependent is required to file because their income meets the filing threshold — a return filed only to recover withholding does not count. Run the threshold test for each dependent. The amount counts toward the ACA household MAGI only — it is never added to the parents’ own taxable income.",
        })}
        {strayRow("Severance, bonus, or other one-off pay landing this year", "straySeverance", {
          amountLabel: "One-off pay still to land",
          hint: "Count actual pay events — severance, a bonus, an RSU settlement, an option exercise, deferred comp, a leave payout — from the payroll and equity-award schedules; vesting alone is not always a taxable event. Pay that already landed belongs in the year-to-date actuals, not here.",
        })}
        {strayRow("AGI reducers that actually work, used", "strayAgiReducers", {
          amountLabel: "Deductible HSA / IRA contributions & pre-tax deferrals not already reflected above",
          hint: "Below-the-line deductions never touch MAGI, but these do: deductible HSA contributions while eligible, pre-tax deferrals while working, and deductible traditional IRA contributions — including a spousal IRA for a nonworking spouse — where the household has earned compensation in the year and the deduction phase-outs allow it (IRA contributions for this year can be made until April 15 of next year). For HSA: eligibility is determined month by month, on the first of the month; the limit is net of employer contributions; disqualifying coverage (such as a general-purpose health FSA or a spouse’s non-HDHP plan) removes eligibility; and using the last-month rule carries a following-year testing period. An HSA contribution for this year can also still be made up to April 15 of next year — a post-December correction valve. A net capital loss also reduces AGI, up to $3,000 — that one rides the loss-harvesting item below. Enter only amounts not already reflected in the actuals above.",
        })}
        {strayRow("Coverage months reconciled", "strayCoverage", {
          amountLabel: "Credit reduction for ineligible months",
          hint: "The credit is monthly, not annual: a month in which a household member had an affordable employer offer, or was eligible for Medicare or CHIP, shrinks that month’s credit whatever the annual MAGI says. Reconcile each coverage month against the Form 1095-A; enter the total credit reduction for any ineligible months.",
        })}
        {strayRow("Loss harvesting done, wash sales checked", "strayLossHarvest", {
          amountLabel: "Harvested loss amount",
          hint: "A loss re-bought inside 30 days — in any account, including a spouse’s — is disallowed; check before counting it. Forward control: after any December loss sale, make no substantially identical purchases in any household account — including automatic dividend reinvestment and scheduled buys — until that sale’s 30-day post-sale window closes (the window runs into late January); a January purchase retroactively disallows a December loss. A wash sale triggered by an IRA repurchase disallows the loss permanently, not just for this year.",
        })}
        {strayRow("Brokerage clock: sales count by trade date", "strayTradeDate", {
          hint: "A sale executed on December 31 belongs to this tax year even though the proceeds settle in January. Use trade dates for every sale in the gains above — this clock is separate from the plan-distribution clock below.",
        })}
        {strayRow("Plan clock: the distribution counts when it is paid", "strayCutoff", {
          hint: "A plan distribution counts in the year it is paid — actually or constructively received — not the year it is requested and not when the cash finishes settling at the bank. Get the administrator’s payment date and December cutoff confirmed in writing; cutoffs land well before December 31. Also confirm the plan permits repeatable partial post-separation withdrawals — not only the payment date and cutoff.",
        })}
      </section>

      {/* Detail fold */}
      <section className={sectionCls} aria-label="Projection detail">
        <button
          type="button"
          aria-expanded={detailOpen}
          onClick={() => setDetailOpen(!detailOpen)}
          className="flex w-full items-start justify-between gap-3 text-left"
        >
          <span>
            <span className="block text-base font-semibold">Detail & pricing settings</span>
            <span className="mt-0.5 block text-sm text-[var(--dim)]">
              Per-case figures at the headline draw, state tax and itemized settings.
            </span>
          </span>
          <FoldChevron open={detailOpen} className="mt-0.5" />
        </button>
        {detailOpen && (
          <div className="mt-3">
            {result.priced && result.cases.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[34rem] text-sm">
                  <thead>
                    <tr className="text-left text-[var(--dim)]">
                      <th className="py-1 pr-3 font-medium">Case</th>
                      <th className="py-1 pr-3 font-medium">MAGI before any draw</th>
                      <th className="py-1 pr-3 font-medium">Own max draw</th>
                      <th className="py-1 pr-3 font-medium">Excess APTC repayment at headline</th>
                      <th className="py-1 pr-3 font-medium">Federal tax at headline</th>
                      <th className="py-1 font-medium">Total tax at headline</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.cases.map((c) => (
                      <tr key={c.kind} className="tnum border-t border-[var(--border)]">
                        <td className="py-1.5 pr-3 font-medium">{CASE_LABELS[c.kind]}</td>
                        <td className="py-1.5 pr-3">
                          <button
                            type="button"
                            aria-label="Go to the year-to-date actuals"
                            className={decTapCls}
                            onClick={() => jumpToDecField("roth-December-YTD-other-ordinary")}
                          >
                            {fmtDollars(c.nonDrawAcaMagi)}
                          </button>
                        </td>
                        <td className="py-1.5 pr-3">
                          {c.maxDraw == null ? "—" : fmtDollars(c.maxDraw)}
                        </td>
                        <td className="py-1.5 pr-3">
                          {c.excessAptcRepayment == null ? (
                            "—"
                          ) : (
                            <button
                              type="button"
                              aria-label="Go to the Advance credit (APTC) already taken field"
                              className={decTapCls}
                              onClick={() => jumpToDecField("roth-December-APTC-taken")}
                            >
                              {fmtDollars(c.excessAptcRepayment)}
                            </button>
                          )}
                        </td>
                        <td className="py-1.5 pr-3">
                          <button
                            type="button"
                            aria-label="Go to the year-to-date actuals"
                            className={decTapCls}
                            onClick={() => jumpToDecField("roth-December-YTD-other-ordinary")}
                          >
                            {fmtDollars(c.federalTaxAtHeadline)}
                          </button>
                        </td>
                        <td className="py-1.5">
                          <button
                            type="button"
                            aria-label="Go to the year-to-date actuals"
                            className={decTapCls}
                            onClick={() => jumpToDecField("roth-December-YTD-other-ordinary")}
                          >
                            {fmtDollars(c.totalTaxAtHeadline)}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {pctField("State tax rate", form.stateRatePct, (v) => set("stateRatePct", v), {
                idLabel: "December state rate",
              })}
              <div>
                <label className={labelCls} htmlFor="december-residence">
                  State of residence
                </label>
                <select
                  id="december-residence"
                  aria-label="December state of residence"
                  className={inputCls}
                  value={form.residenceState}
                  onChange={(e) =>
                    set("residenceState", e.target.value as "WA" | "other")
                  }
                >
                  <option value="other">Flat state rate</option>
                  <option value="WA">Washington (capital-gains excise)</option>
                </select>
              </div>
              {moneyField("Itemized — mortgage interest", form.itemizedMortgageInterest, (v) =>
                set("itemizedMortgageInterest", v),
              { idLabel: "December itemized mortgage" },
              )}
              {moneyField("Itemized — state & local taxes paid", form.itemizedSaltPaid, (v) =>
                set("itemizedSaltPaid", v),
              { idLabel: "December itemized SALT" },
              )}
              {moneyField("Itemized — charitable", form.itemizedCharitable, (v) =>
                set("itemizedCharitable", v),
              { idLabel: "December itemized charitable" },
              )}
              {moneyField("Itemized — other", form.itemizedOther, (v) =>
                set("itemizedOther", v),
              { idLabel: "December itemized other" },
              )}
            </div>
            <p className="mt-3 max-w-3xl text-sm text-[var(--dim)]">
              How it prices: the year is assembled from the actuals, one range case, and the
              stray amounts, then priced by the shared single-year engine — the pre-tax draw
              rides the same pre-tax-money-out pricing as a conversion, dollar for dollar.
              The headline draw is the largest draw whose ACA MAGI stays at or under the
              cliff minus the buffer. Eligibility is lost only when MAGI ends above 400% of
              the poverty line — exactly 400% remains eligible — and the draw aims at
              cliff − buffer either way. Itemized deductions never change MAGI — they sit
              below the line — so they move the tax, never the cliff room. Reconciliation
              after 2025 has no repayment caps: every case repays any advance credit taken
              above its final allowable credit in full — over the cliff the final credit is
              $0, so the whole year’s advance credit taken is repaid; under the cliff, only
              the excess over the final credit.
            </p>
          </div>
        )}
      </section>

      <div className="mt-4">
        {!resetArmed ? (
          <button
            type="button"
            className="text-sm text-[var(--dim)] underline underline-offset-2 hover:text-[var(--text)]"
            onClick={() => setResetArmed(true)}
          >
            Reset the December console
          </button>
        ) : (
          <span className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-[var(--dim)]">
              Clear every December entry back to blank?
            </span>
            <button
              type="button"
              className="rounded-[var(--radius)] bg-[var(--bad)] px-4 py-2 text-sm font-medium text-white"
              onClick={() => {
                const blank = defaultDecemberState(new Date().getFullYear());
                dirtyRef.current = true;
                // A reset is the user's own answer for every
                // field: the blank state saves verbatim, with
                // no stored provenance preserved.
                setBeneficiaryEdited(true);
                setBalancesEdited(true);
                setRocCharacterEdited(true);
                setJanPaidCharacterEdited(true);
                setEducationEdited(true);
                setCarryInStEdited(true);
                setCarryInLtEdited(true);
                setCarryInStWaEdited(true);
                setCarryInLtWaEdited(true);
                setHarvestPoolAmountEdited(true);
                setHarvestPoolBasisPctEdited(true);
                setForm(formFromState(blank));
                setResetArmed(false);
              }}
            >
              Yes, clear it
            </button>
            <button
              type="button"
              className="rounded-[var(--radius)] border border-[var(--border)] px-4 py-2 text-sm font-medium hover:text-[var(--accent)]"
              onClick={() => setResetArmed(false)}
            >
              Keep my entries
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
