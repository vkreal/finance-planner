/* ---------------- Money-conservation invariants ----------------
   Part 1 of the hardening block (Oct 16: "why not do all?" /
   "Do all of them but make it last"). The harness's
   trajectory checks: invariants the engine's own
   multi-year marches must satisfy, priced on the fictional
   sample household (server/src/sampleHousehold.ts) — never
   on any real household's figures. These are NOT a second
   implementation: each invariant is a conservation law the
   priced figures must obey, checked against the engine's
   own outputs.

   (a) Funding footing (the twelve-source identity): for
   every year of the sample plan's funding ledger, the
   twelve funding sources plus the spend shortfall plus the
   unpaid tax foot the year's total need EXACTLY, in integer
   cents. The pattern generalizes the footing the committed
   fixtures pin on individual cases (maxDiffCents 0) across
   whole marches. A shortfall is spending the balances
   could not meet, not a flow; unpaid tax is the part of
   the tax bill the balances could not pay — both are
   carried as themselves, never reconciled into a source.
   (b) Terminal-wealth identity: a march's reported ending
   after-tax wealth equals its ending balances with the
   pre-tax balance split at the preserve floor — the
   preserved portion at the preserve exit rate, the excess
   at the heir rate — plus Roth, taxable, and HSA. The
   recomputation runs from the march's own cent-rounded
   ending fields, so the assertion allows $0.03 (the
   rounding of the five inputs); a real error would be in
   the dollars.
   (c) Basis bounds: the taxable account's basis dollars
   never go below $0; on a march with no negative-return
   year they never exceed the year's taxable balance; and
   cumulatively they never grow beyond the starting basis
   plus the reinvested yields, the harvest step-ups, and
   the surplus-cash sweep — the settlement's sweep of
   leftover cash income (the RMD, Social Security, other
   ordinary income, and tax-exempt interest beyond the
   year's spending need and the tax that cash pays) into
   Taxable at 100% basis, because that cash is after-tax
   money (a market decline shrinks the balance while the
   basis dollars stand — the underwater-draw path, where
   draws then price losses — so on a declining path the
   balance bound does not apply and the cumulative inflow
   bound is the law there). The sweep is reconstructed
   from the year's own exposed fields: the cash-in lines
   (rmd, ssBenefits, otherOrdinary, taxExemptInterest),
   the funding need (spending + healthPremium), and the
   funding attribution's applied income (whose excess
   over the need is the tax the surplus cash paid).
   (d) Loss-ledger conservation (seeded, direct): the
   capital-loss carryforward ledger conserves across a
   year — the carry-out is the year's total loss (the
   entering carryforward, less what the gains absorbed,
   plus the year's own loss) less the part of the §1211(b)
   allowance the year's taxable income actually absorbed;
   the gains absorption, the net result, and the allowance
   match the Capital Loss Carryover Worksheet's order
   recomputed from the inputs; and no Washington-attributed
   amount exceeds its entering pool.
   (e) Non-negativity: no year prices a negative tax,
   IRMAA, conversion, spending, or end balance.

   A violation lists the year and the figures. The engine
   is the side under test; this module never adjusts a
   priced figure to make an invariant hold. */

import { applyLossLedger, DEFAULT_DRAW_ORDER, simulateRothPlan } from "../taxEngine";
import type { RothPlanInputs } from "../taxEngine";
import { buildRothFunding } from "../rothOptimizer";
import type { RothFundingRow } from "../rothOptimizer";
import {
  samplePlanInputs,
  SAMPLE_START_YEAR,
  SAMPLE_BIRTH_YEAR_PRIMARY,
  SAMPLE_BIRTH_YEAR_SPOUSE,
  SAMPLE_FILING_STATUS,
  SAMPLE_HOUSEHOLD_SIZE,
  SAMPLE_PRETAX_CENTS,
  SAMPLE_TAXABLE_CENTS,
  SAMPLE_ROTH_CENTS,
  SAMPLE_HSA_CENTS,
  SAMPLE_TAXABLE_BASIS_PCT,
  SAMPLE_ANNUAL_SPENDING_CENTS,
  SAMPLE_ACA_BENCHMARK_FAMILY_CENTS,
  SAMPLE_ACA_BENCHMARK_COUPLE_CENTS,
  SAMPLE_ACA_BENCHMARK_SINGLE_CENTS,
  SAMPLE_SS_PRIMARY_CENTS,
  SAMPLE_SS_PRIMARY_START_AGE,
  SAMPLE_SS_SPOUSE_CENTS,
  SAMPLE_SS_SPOUSE_START_AGE,
  SAMPLE_PROTECT_MIN_TAXABLE_CENTS,
  SAMPLE_PRESERVE_PRETAX_CENTS,
  SAMPLE_HEIR_RATE_PCT,
  SAMPLE_EXPECTED_RETURN_PCT,
  SAMPLE_INFLATION_PCT,
  SAMPLE_DIVIDEND_YIELD_PCT,
  SAMPLE_INTEREST_YIELD_PCT,
  SAMPLE_QUALIFIED_SHARE_PCT,
  SAMPLE_RETIREMENT_AGE,
  SAMPLE_END_AGE,
  SAMPLE_WINDOW_START_AGE,
  SAMPLE_WINDOW_STOP_AGE,
} from "../sampleHousehold";
import type {
  HardeningCheckModule,
  HardeningCheckResult,
  HardeningTeethResult,
} from "./types";

function roundCent(n: number): number {
  return Math.round(n * 100) / 100;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DO_NOTHING = { id: "none", name: "Do Nothing", ceilings: null };
const FILL_12 = {
  id: "fill12",
  name: "Fill 12%",
  ceilings: {
    bracketTopPct: 12,
    irmaaTierCap: null,
    ltcgZeroCap: false,
    acaCliffCap: false,
    acaCliffCapFamilyOnly: false,
    magiCap: null,
    acaCliffBuffer: null,
  },
};

// The sample household's full plan, in the dollars the
// march prices in (the fictional sample household's own
// figures, read from its module — never typed here).
function sampleDollarPlan(overrides: Partial<RothPlanInputs> = {}): RothPlanInputs {
  return {
    startYear: SAMPLE_START_YEAR,
    birthYearPrimary: SAMPLE_BIRTH_YEAR_PRIMARY,
    birthYearSpouse: SAMPLE_BIRTH_YEAR_SPOUSE,
    filingStatus: SAMPLE_FILING_STATUS,
    endAgePrimary: SAMPLE_END_AGE,
    pretaxStart: SAMPLE_PRETAX_CENTS / 100,
    rothStart: SAMPLE_ROTH_CENTS / 100,
    taxableStart: SAMPLE_TAXABLE_CENTS / 100,
    hsaStart: SAMPLE_HSA_CENTS / 100,
    taxableBasisPct: SAMPLE_TAXABLE_BASIS_PCT,
    annualSpending: SAMPLE_ANNUAL_SPENDING_CENTS / 100,
    retirementAge: SAMPLE_RETIREMENT_AGE,
    expectedReturnPct: SAMPLE_EXPECTED_RETURN_PCT,
    ssPrimaryAnnual: SAMPLE_SS_PRIMARY_CENTS / 100,
    ssPrimaryStartAge: SAMPLE_SS_PRIMARY_START_AGE,
    ssSpouseAnnual: SAMPLE_SS_SPOUSE_CENTS / 100,
    ssSpouseStartAge: SAMPLE_SS_SPOUSE_START_AGE,
    otherOrdinaryAnnual: 0,
    taxExemptInterestAnnual: 0,
    convertedAlreadyThisYear: 0,
    windowStartAge: SAMPLE_WINDOW_START_AGE,
    windowStopAge: SAMPLE_WINDOW_STOP_AGE,
    payTaxFrom: "taxable",
    protectMinTaxable: SAMPLE_PROTECT_MIN_TAXABLE_CENTS / 100,
    drawOrder: [...DEFAULT_DRAW_ORDER],
    spouseSoleBeneficiary: true,
    acaHouseholdSize: SAMPLE_HOUSEHOLD_SIZE,
    acaHouseholdSchedule: null,
    acaBenchmarkCouple: SAMPLE_ACA_BENCHMARK_COUPLE_CENTS / 100,
    acaBenchmarkSingle: SAMPLE_ACA_BENCHMARK_SINGLE_CENTS / 100,
    acaBenchmarkFamily: SAMPLE_ACA_BENCHMARK_FAMILY_CENTS / 100,
    inflationPct: SAMPLE_INFLATION_PCT,
    stateRatePct: 0,
    heirRatePct: SAMPLE_HEIR_RATE_PCT,
    preservePretax: SAMPLE_PRESERVE_PRETAX_CENTS / 100,
    preserveExitRatePct: 10,
    taxableDividendYieldPct: SAMPLE_DIVIDEND_YIELD_PCT,
    taxableInterestYieldPct: SAMPLE_INTEREST_YIELD_PCT,
    taxableDividendQualifiedPct: SAMPLE_QUALIFIED_SHARE_PCT,
    ...overrides,
  };
}

// Normalize the funding ledger's return: rows, whether the
// call returns the rows directly or inside a rows field.
function fundingRows(funding: unknown): RothFundingRow[] {
  if (Array.isArray(funding)) return funding as RothFundingRow[];
  const rec = funding as { rows?: unknown };
  if (Array.isArray(rec.rows)) return rec.rows as RothFundingRow[];
  throw new Error("invariants: buildRothFunding returned an unexpected shape");
}

// (a) The twelve funding sources plus shortfall plus
// unpaid tax foot the total need, exactly, in integer
// cents. Returns the largest absolute residue in cents.
function checkFundingFooting(
  rows: RothFundingRow[],
): { maxDiffCents: number; violations: string[] } {
  const violations: string[] = [];
  let maxDiffCents = 0;
  for (const r of rows) {
    const sources =
      r.ssCents +
      r.rmdCents +
      r.otherIncomeCents +
      r.taxExemptCents +
      r.interestYieldCents +
      r.dividendYieldCents +
      r.pretaxDrawCents +
      r.taxableSoldForSpendingCents +
      r.taxableSoldForTaxCents +
      r.cashSpendCents +
      r.rothDrawCents +
      r.salarySurplusCents;
    const diff = Math.abs(
      sources + r.spendShortfallCents + r.unpaidTaxCents - r.totalNeedCents,
    );
    maxDiffCents = Math.max(maxDiffCents, diff);
    if (diff !== 0) {
      violations.push(
        `funding footing year ${r.year}: sources ${sources} + shortfall ${r.spendShortfallCents} + unpaid ${r.unpaidTaxCents} = ${sources + r.spendShortfallCents + r.unpaidTaxCents}, need ${r.totalNeedCents} (diff ${diff}c)`,
      );
    }
  }
  return { maxDiffCents, violations: violations.slice(0, 25) };
}

// (b) Terminal-wealth identity, recomputed from the
// march's own cent-rounded ending fields (tolerance $0.03
// for the rounding of the five inputs).
function checkTerminalIdentity(
  march: ReturnType<typeof simulateRothPlan>,
  label: string,
  preservePretax: number,
  preserveExitRatePct: number,
  heirRatePct: number,
): { violations: string[]; maxDiff: number } {
  const preserved = Math.min(
    march.endingPretax,
    Math.max(0, preservePretax),
  );
  const expected =
    preserved * (1 - preserveExitRatePct / 100) +
    (march.endingPretax - preserved) * (1 - heirRatePct / 100) +
    march.endingRoth +
    march.endingTaxable +
    march.endingHsa;
  const diff = Math.abs(expected - march.endingAfterTaxWealth);
  const violations: string[] = [];
  if (diff > 0.03) {
    violations.push(
      `terminal identity ${label}: recomputed ${roundCent(expected)}, reported ${march.endingAfterTaxWealth} (diff ${roundCent(diff)})`,
    );
  }
  return { violations, maxDiff: roundCent(diff) };
}

function checkMarchYears(
  march: ReturnType<typeof simulateRothPlan>,
  label: string,
  startingBasis: number,
  allowBasisOverBalance: boolean,
): string[] {
  const violations: string[] = [];
  let cumulativeInflow = 0;
  for (const y of march.years) {
    if (y.federalTax < 0)
      violations.push(`${label} year ${y.year}: federalTax ${y.federalTax} < 0`);
    if (y.stateTax < 0)
      violations.push(`${label} year ${y.year}: stateTax ${y.stateTax} < 0`);
    if (y.irmaaPaid < 0)
      violations.push(`${label} year ${y.year}: irmaa ${y.irmaaPaid} < 0`);
    if (y.conversion < 0)
      violations.push(`${label} year ${y.year}: conversion ${y.conversion} < 0`);
    if (y.funding.spending < 0)
      violations.push(`${label} year ${y.year}: spending ${y.funding.spending} < 0`);
    for (const [name, v] of [
      ["pretaxEnd", y.pretaxEnd],
      ["rothEnd", y.rothEnd],
      ["taxableEnd", y.taxableEnd],
      ["hsaEnd", y.hsaEnd],
    ] as const) {
      if (v < 0)
        violations.push(`${label} year ${y.year}: ${name} ${v} < 0`);
    }
    if (!y.detail) {
      violations.push(`${label} year ${y.year}: missing detail`);
      continue;
    }
    const basis = y.detail.taxableBasisDollars;
    // The surplus-cash sweep (see the (c) header): the
    // year's cash income beyond its spending need, less
    // the part of that surplus the year's tax bill took,
    // is saved into Taxable at 100% basis. Reconstructed
    // from the year's exposed fields — the settlement's
    // cashIn lines, the funding need, and the funding
    // attribution (applied income = min(cashIn, need) +
    // taxFromCash, so the applied excess over the need is
    // exactly the tax the surplus cash paid).
    const cashIn =
      y.rmd +
      y.ssBenefits +
      y.detail.otherOrdinary +
      y.detail.taxExemptInterest;
    const spendNeed = y.funding.spending + y.funding.healthPremium;
    const surplusCash = Math.max(0, cashIn - spendNeed);
    const incomeApplied =
      y.funding.ss +
      y.funding.rmd +
      y.funding.taxExempt +
      y.funding.otherIncome;
    const taxFromCash = incomeApplied - Math.min(cashIn, spendNeed);
    const surplusSwept = Math.max(0, surplusCash - taxFromCash);
    cumulativeInflow +=
      y.detail.dividendIncome +
      y.detail.interestIncome +
      y.detail.gainsHarvested +
      surplusSwept;
    if (basis < 0) {
      violations.push(`${label} year ${y.year}: basis ${basis} below $0`);
    }
    if (!allowBasisOverBalance && basis > y.taxableEnd + 0.01) {
      violations.push(
        `${label} year ${y.year}: basis ${basis} exceeds taxable balance ${y.taxableEnd}`,
      );
    }
    if (basis > startingBasis + cumulativeInflow + 0.05) {
      violations.push(
        `${label} year ${y.year}: basis ${basis} grew beyond starting basis + reinvested yield + harvest + surplus sweep (${roundCent(startingBasis + cumulativeInflow)})`,
      );
    }
  }
  return violations.slice(0, 25);
}

// (d) Loss-ledger conservation over seeded cases. The
// worksheet order is recomputed from the inputs: the
// long-term carryover nets against the year's own
// long-term result, the short-term carryover nets against
// a surviving long-term gain, and the §1211(b) allowance
// is the loss up to the $3,000 cap.
function checkLossLedger(
  count: number,
  seed: number,
): { violations: string[]; checked: number } {
  const rng = mulberry32(seed);
  const violations: string[] = [];
  for (let i = 0; i < count; i++) {
    const stIn = roundCent(rng() * 50000);
    const ltIn = roundCent(rng() * 50000);
    const waStIn = roundCent(rng() * stIn);
    const waLtIn = roundCent(rng() * ltIn);
    const own = roundCent(-40000 + rng() * 140000);
    const tiBefore = roundCent(rng() * 200000);
    const res = applyLossLedger(
      { st: stIn, lt: ltIn },
      own,
      "mfj",
      tiBefore,
      { st: waStIn, lt: waLtIn },
    );
    const ltNet = own - ltIn;
    let remainingStLoss = stIn;
    let remainingLtLoss = 0;
    let pricedGain = 0;
    if (ltNet >= 0) {
      pricedGain = Math.max(0, ltNet - remainingStLoss);
      remainingStLoss = Math.max(0, remainingStLoss - ltNet);
    } else {
      remainingLtLoss = -ltNet;
    }
    const totalLoss = remainingStLoss + remainingLtLoss;
    const expectedNet = totalLoss > 0 ? -totalLoss : pricedGain;
    const expectedAllowance =
      totalLoss > 0 ? Math.min(3000, totalLoss) : 0;
    // 1.1-cent tolerance: both sides round the same
    // cent-arithmetic, so a genuine error is in the
    // dollars, never a single cent.
    if (Math.abs(res.netResult - roundCent(expectedNet)) > 0.011) {
      violations.push(
        `loss ledger case ${i}: netResult ${res.netResult}, worksheet ${roundCent(expectedNet)}`,
      );
    }
    if (Math.abs(res.allowance - roundCent(expectedAllowance)) > 0.011) {
      violations.push(
        `loss ledger case ${i}: allowance ${res.allowance}, worksheet ${roundCent(expectedAllowance)}`,
      );
    }
    const carryInTotal = stIn + ltIn;
    const carryOutTotal = res.carryOut.st + res.carryOut.lt;
    // Conservation, with the year's own loss as an
    // inflow: carry-out = totalLoss − allowanceUsed,
    // where allowanceUsed is at most the allowance
    // capped at the year's taxable income before it.
    // (The pre-fix bound omitted the own-loss inflow and
    // failed every loss year — the engine was right, the
    // bound was wrong.)
    const allowanceUsable = Math.min(
      expectedAllowance,
      Math.max(0, tiBefore),
    );
    const lo = totalLoss - allowanceUsable - 0.01;
    const hi = totalLoss + 0.01;
    if (carryOutTotal < lo || carryOutTotal > hi) {
      violations.push(
        `loss ledger case ${i}: carry-out ${roundCent(carryOutTotal)} outside [${roundCent(lo)}, ${roundCent(hi)}] (total loss ${roundCent(totalLoss)}, usable allowance ${roundCent(allowanceUsable)})`,
      );
    }
    // The gains absorption is pinned exactly: the
    // carry-in plus the year's own loss, less the total
    // loss, is what the gains absorbed.
    const expectedAbsorbed =
      carryInTotal + Math.max(0, -own) - totalLoss;
    if (Math.abs(res.absorbedByGains - expectedAbsorbed) > 0.011) {
      violations.push(
        `loss ledger case ${i}: absorbed ${res.absorbedByGains}, worksheet ${roundCent(expectedAbsorbed)}`,
      );
    }
    if (res.carryOut.st < -0.005 || res.carryOut.lt < -0.005) {
      violations.push(`loss ledger case ${i}: negative carry-out`);
    }
    if (res.absorbedByGains < -0.005) {
      violations.push(`loss ledger case ${i}: negative absorption`);
    }
    const waInTotal = waStIn + waLtIn;
    const waCarryOutTotal = res.waCarryOut.st + res.waCarryOut.lt;
    if (waCarryOutTotal > waInTotal + 0.01) {
      violations.push(
        `loss ledger case ${i}: Washington carry-out ${roundCent(waCarryOutTotal)} exceeds entering ${roundCent(waInTotal)}`,
      );
    }
    if (res.waAbsorbedByGains > waInTotal + 0.01) {
      violations.push(
        `loss ledger case ${i}: Washington absorbed ${res.waAbsorbedByGains} exceeds entering ${roundCent(waInTotal)}`,
      );
    }
  }
  return { violations: violations.slice(0, 25), checked: count };
}

export const INVARIANTS_FAST_LEDGER_CASES = 200;
export const INVARIANTS_FULL_LEDGER_CASES = 2000;

function runInvariantsInner(args: {
  fundingStrategies: "do-nothing" | "both";
  ledgerCases: number;
}): HardeningCheckResult & {
  maxDiffCents: number;
  maxTerminalDiff: number;
} {
  const violations: string[] = [];
  const counts: Record<string, number> = {};
  let maxDiffCents = 0;
  let maxTerminalDiff = 0;
  const startingBasis =
    (SAMPLE_TAXABLE_BASIS_PCT / 100) * (SAMPLE_TAXABLE_CENTS / 100);

  // (a) Funding footing on the sample plan's ledger.
  const fundingDoNothing = fundingRows(
    buildRothFunding(samplePlanInputs(), DO_NOTHING),
  );
  const footingDn = checkFundingFooting(fundingDoNothing);
  maxDiffCents = Math.max(maxDiffCents, footingDn.maxDiffCents);
  violations.push(...footingDn.violations);
  counts.fundingRowsDoNothing = fundingDoNothing.length;
  let fundingFill12Length = 0;
  if (args.fundingStrategies === "both") {
    const fundingFill12 = fundingRows(
      buildRothFunding(samplePlanInputs(), FILL_12),
    );
    const footingF12 = checkFundingFooting(fundingFill12);
    maxDiffCents = Math.max(maxDiffCents, footingF12.maxDiffCents);
    violations.push(...footingF12.violations);
    fundingFill12Length = fundingFill12.length;
  }
  counts.fundingRowsFill12 = fundingFill12Length;

  // (b) + (c) + (e) on the marches.
  const plan = sampleDollarPlan();
  const marchDn = simulateRothPlan(plan, DO_NOTHING);
  const terminalDn = checkTerminalIdentity(
    marchDn,
    "Do Nothing",
    SAMPLE_PRESERVE_PRETAX_CENTS / 100,
    10,
    SAMPLE_HEIR_RATE_PCT,
  );
  maxTerminalDiff = Math.max(maxTerminalDiff, terminalDn.maxDiff);
  violations.push(...terminalDn.violations);
  violations.push(...checkMarchYears(marchDn, "Do Nothing", startingBasis, false));
  counts.marchYearsDoNothing = marchDn.years.length;

  const marchF12 = simulateRothPlan(plan, FILL_12);
  const terminalF12 = checkTerminalIdentity(
    marchF12,
    "Fill 12%",
    SAMPLE_PRESERVE_PRETAX_CENTS / 100,
    10,
    SAMPLE_HEIR_RATE_PCT,
  );
  maxTerminalDiff = Math.max(maxTerminalDiff, terminalF12.maxDiff);
  violations.push(...terminalF12.violations);
  violations.push(...checkMarchYears(marchF12, "Fill 12%", startingBasis, false));
  counts.marchYearsFill12 = marchF12.years.length;

  // Varied-return short march (a -60% first year): the
  // underwater-draw path, where draws realize losses and
  // the basis and ledger lines are exercised.
  const shortPlan = sampleDollarPlan({
    endAgePrimary: 60,
    retirementAge: 58,
    windowStartAge: 58,
    windowStopAge: 73,
    ssPrimaryAnnual: 0,
    ssPrimaryStartAge: null,
    ssSpouseAnnual: 0,
    ssSpouseStartAge: null,
  });
  const marchVaried = simulateRothPlan(shortPlan, DO_NOTHING, [-60, 0, 0]);
  const terminalVaried = checkTerminalIdentity(
    marchVaried,
    "varied-return",
    SAMPLE_PRESERVE_PRETAX_CENTS / 100,
    10,
    SAMPLE_HEIR_RATE_PCT,
  );
  maxTerminalDiff = Math.max(maxTerminalDiff, terminalVaried.maxDiff);
  violations.push(...terminalVaried.violations);
  violations.push(...checkMarchYears(marchVaried, "varied-return", startingBasis, true));
  counts.marchYearsVaried = marchVaried.years.length;

  // (d) Loss-ledger conservation, seeded.
  const ledger = checkLossLedger(args.ledgerCases, 12345);
  violations.push(...ledger.violations);
  counts.ledgerCases = ledger.checked;

  const detail =
    `Funding footing max residue ${maxDiffCents}c over ${counts.fundingRowsDoNothing} Do-Nothing rows` +
    (args.fundingStrategies === "both"
      ? ` + ${fundingFill12Length} Fill-12% rows`
      : ` (Fill-12% rows run in the full run only)`) +
    `; terminal-wealth identity max diff $${maxTerminalDiff.toFixed(2)} over 3 marches ` +
    `(${counts.marchYearsDoNothing} + ${counts.marchYearsFill12} + ${counts.marchYearsVaried} years); ` +
    `basis bounds + non-negativity over the same years; loss-ledger conservation over ${ledger.checked} seeded cases; ` +
    `${violations.length} violations.`;
  return {
    id: "invariants-trajectory",
    name: "Money-conservation invariants across trajectory years",
    pass: violations.length === 0,
    detail,
    failures: violations.slice(0, 25),
    counts: {
      ...counts,
      maxDiffCents,
      violations: violations.length,
    },
    maxDiffCents,
    maxTerminalDiff,
  };
}

function runInvariantsFast(): HardeningCheckResult {
  const r = runInvariantsInner({
    fundingStrategies: "do-nothing",
    ledgerCases: INVARIANTS_FAST_LEDGER_CASES,
  });
  const { maxDiffCents: _a, maxTerminalDiff: _b, ...result } = r;
  return result;
}

function runInvariantsFull(): HardeningCheckResult {
  const r = runInvariantsInner({
    fundingStrategies: "both",
    ledgerCases: INVARIANTS_FULL_LEDGER_CASES,
  });
  const { maxDiffCents: _a, maxTerminalDiff: _b, ...result } = r;
  return result;
}

// Teeth: corrupt one funding row's source by 1 cent and
// prove the footing check fails naming that year; corrupt
// the terminal identity by $1 (more than the $0.03
// recomputation tolerance) and prove it fails.
// The clean run must pass first.
function runInvariantsTeeth(): HardeningTeethResult {
  const clean = runInvariantsInner({
    fundingStrategies: "do-nothing",
    ledgerCases: INVARIANTS_FAST_LEDGER_CASES,
  });
  if (!clean.pass) {
    return {
      corruptedCaseId: "invariants-trajectory:clean-run-failed",
      failedCount: clean.counts.violations ?? 0,
      pass: false,
    };
  }
  const rows = fundingRows(buildRothFunding(samplePlanInputs(), DO_NOTHING));
  const first = rows[0];
  if (!first) {
    return { corruptedCaseId: "invariants-trajectory:no-rows", failedCount: 0, pass: false };
  }
  const corrupted = rows.map((r, i) =>
    i === 0 ? { ...r, ssCents: r.ssCents + 1 } : r,
  );
  const footing = checkFundingFooting(corrupted);
  const footingTeeth =
    footing.maxDiffCents === 1 &&
    footing.violations.length === 1 &&
    footing.violations[0]?.includes(`year ${first.year}`) === true;
  const march = simulateRothPlan(sampleDollarPlan(), DO_NOTHING);
  const terminal = checkTerminalIdentity(
    { ...march, endingAfterTaxWealth: march.endingAfterTaxWealth + 1 },
    "Do Nothing",
    SAMPLE_PRESERVE_PRETAX_CENTS / 100,
    10,
    SAMPLE_HEIR_RATE_PCT,
  );
  const terminalTeeth = terminal.violations.length === 1;
  return {
    corruptedCaseId: "invariants-trajectory:funding-row-0-ss+1c-and-terminal+100c",
    // Teeth convention (same as runTaxTeethCheck):
    // failedCount counts the corrupted assertions that
    // failed as they should — 2 when both teeth bite.
    failedCount: (footingTeeth ? 1 : 0) + (terminalTeeth ? 1 : 0),
    pass: footingTeeth && terminalTeeth,
  };
}

export const invariantsCheck: HardeningCheckModule = {
  id: "invariants-trajectory",
  name: "Money-conservation invariants across trajectory years",
  runFast: runInvariantsFast,
  runFull: runInvariantsFull,
  runTeeth: runInvariantsTeeth,
};
