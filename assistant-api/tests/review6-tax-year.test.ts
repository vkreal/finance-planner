// review6-tax-year.test.ts — Review 6 fixes R6-S1 (taxable share
// sales) and R6-S2 (RMDs from prior-Dec-31 balances) in the
// single-year tax price.
//
// Every priced case is checked against a DIRECT pricePlaygroundYear
// call built by hand from the same scenario fields the adapter
// reads (the independence rule from parity.test.ts: if the adapter
// mis-mapped a field, the two pricings disagree — to the cent).
// Spot figures are pinned from the engine's own output on the
// fictional household (see helpers.ts); they are checks that the
// parity still reads as a check, never a second source of truth.
// One test is the deliberate exception (NICE-5, at the end): a
// hand-built expected-values test whose literals are derived by
// hand from the published law table, with no direct-engine call
// — so the suite does not depend solely on the mapping restatement.
//
// Fictional household throughout (never real figures): pretax
// $1,250,000; taxable $2,100,000; Roth $375,000; HSA $62,000;
// spending $9,500/mo; ages 54/52; retire 58; end age 95; SS
// $36,000/yr at 67 (spouse $18,000/yr at 67). RMD cases override
// the ages (with retirementAge kept at currentAge, per the
// normalize guard) — never the household's real ages.

import { describe, expect, test } from "bun:test";
import {
  pricePlaygroundYear,
  type PlaygroundYearInputs,
  type PlaygroundYearResult,
} from "../../server/src/rothOptimizer";
import { calculateSingleYearTax } from "../src/adapter";
import { normalizeInputs, type NormalizedScenario } from "../src/normalize";
import { dispatchTool } from "../src/tools";
import {
  expectEnvelope,
  expectOk,
  fictionalScenario,
  normalizedScenario,
  round2,
  roundDeep,
} from "./helpers";
import * as sampleHousehold from "../../server/src/sampleHousehold";

// ---------------------------------------------------------------------------
// Direct-engine construction, by hand from the scenario (independent
// of the adapter's own mapping — this is the parity oracle).
// ---------------------------------------------------------------------------

/** Mirror of the adapter's benchmark selection (already pinned by the
 *  existing parity test; the new-field mapping below is what this
 *  file proves). */
function benchmarkAnnual(s: NormalizedScenario): number | null {
  return s.filingStatus === "single"
    ? s.acaBenchmarkSingle
    : s.householdSize >= 3
      ? (s.acaBenchmarkFamily ?? s.acaBenchmarkCouple)
      : s.acaBenchmarkCouple;
}

function directInputs(s: NormalizedScenario): PlaygroundYearInputs {
  const joint = s.filingStatus === "mfj";
  const agePrimary = s.currentAge + (s.taxYear - s.startYear);
  const ageSpouse =
    joint && s.birthYearSpouse != null
      ? s.taxYear - s.birthYearSpouse
      : null;
  // The adapter's mapping, restated independently: a basis entered
  // with no sale never reaches the engine (it would invent a loss:
  // stockGain = sold − basis), and a sale with no basis prices at
  // $0 basis.
  const stockSold = s.singleYear.stockSold ?? 0;
  const stockBasis = stockSold > 0 ? (s.singleYear.stockBasis ?? 0) : 0;
  const ssPrimary =
    s.ssPrimaryStartAge != null && agePrimary >= s.ssPrimaryStartAge
      ? s.ssPrimaryAnnual
      : 0;
  const ssSpouse =
    joint &&
    s.ssSpouseStartAge != null &&
    ageSpouse != null &&
    ageSpouse >= s.ssSpouseStartAge
      ? s.ssSpouseAnnual
      : 0;
  return {
    taxYear: s.taxYear,
    filingStatus: s.filingStatus,
    agePrimary,
    ageSpouse,
    onMedicarePrimary: agePrimary >= 65,
    onMedicareSpouse: ageSpouse != null && ageSpouse >= 65,
    interest: s.singleYear.interest,
    ordinaryDividends: s.singleYear.ordinaryDividends,
    otherOrdinary: s.otherOrdinaryAnnual,
    taxExemptInterest: s.taxExemptInterestAnnual,
    ssPrimary,
    ssSpouse,
    conversion: s.singleYear.conversion,
    spendingDraw: s.singleYear.spendingDraw,
    cashDraw: s.singleYear.cashDraw,
    rothDraw: s.singleYear.rothDraw,
    inflationPct: s.inflationPct,
    stockSold,
    stockBasis,
    qualifiedDividends: s.singleYear.qualifiedDividends,
    pretaxBalance: s.singleYear.pretaxPriorYearEnd,
    pretaxBalanceSpouse: s.singleYear.pretaxSpousePriorYearEnd,
    rmdAlreadyReceived: s.singleYear.rmdAlreadyReceived ?? 0,
    primarySoleBeneficiaryOfSpouse:
      s.singleYear.primarySoleBeneficiaryOfSpouse,
    spouseSoleBeneficiary: joint,
    acaHouseholdSize: s.householdSize,
    acaBenchmarkAnnual: benchmarkAnnual(s),
    stateRatePct: s.stateRatePct,
    residenceState: s.residenceState,
    annualSpending: s.annualSpendingCents / 100,
  };
}

/** Adapter result for a scenario, with direct-engine parity asserted
 *  to the cent. Returns the adapter's priced result. */
function pricedWithParity(
  overrides: Record<string, unknown> = {},
): PlaygroundYearResult {
  const s = normalizedScenario(overrides);
  const res = expectOk(calculateSingleYearTax(s));
  expect(res).toEqual(roundDeep(pricePlaygroundYear(directInputs(s))));
  return res;
}

/** Adapter envelope (for warning / assumption assertions). */
function envelopeWithParity(overrides: Record<string, unknown> = {}) {
  const s = normalizedScenario(overrides);
  const env = expectEnvelope(calculateSingleYearTax(s));
  expect(env.results).toEqual(roundDeep(pricePlaygroundYear(directInputs(s))));
  return env;
}

function warningsFor(overrides: Record<string, unknown> = {}): string {
  return envelopeWithParity(overrides).warnings.join(" ");
}

// RMD cases price at an older age: keep retirementAge at currentAge
// (normalize rejects retirementAge < currentAge) and endAge 95.
const AT_73 = { currentAge: 73, spouseAge: 71, retirementAge: 73 };
const AT_75 = { currentAge: 75, spouseAge: 73, retirementAge: 75 };

// ---------------------------------------------------------------------------
// §2 — Stock sales (R6-S1)
// ---------------------------------------------------------------------------

describe("R6-S1 stock sales: direct-engine parity", () => {
  test("no sale (omitted): no gain, no proceeds, no-sale warning", async () => {
    const res = pricedWithParity({
      interestAnnual: 1000,
      ordinaryDividendsAnnual: 5000,
      qualifiedDividendsAnnual: 3000,
      conversionAnnual: 20000,
      spendingDrawAnnual: 114000,
    });
    expect(res.stockGain).toBe(0);
    expect(res.saleAfterTax).toBeNull();
    expect(res.ltcgNet).toBe(0);
    expect(warningsFor({})).toContain("No taxable share sale was entered");
  });

  test("explicit zero sale: same figures as omitted, distinct warning", async () => {
    const omitted = pricedWithParity({});
    const zero = pricedWithParity({ stockSoldAnnual: 0, stockBasisAnnual: 0 });
    expect(zero).toEqual(omitted);
    const w = warningsFor({ stockSoldAnnual: 0, stockBasisAnnual: 0 });
    expect(w).toContain("explicit $0 share sale");
    expect(w).not.toContain("No taxable share sale was entered");
    const wOmitted = warningsFor({});
    expect(wOmitted).not.toContain("explicit $0 share sale");
  });

  test("positive gain: gain on the stack, proceeds in cash, sale-after-tax line", async () => {
    const res = pricedWithParity({
      stockSoldAnnual: 50000,
      stockBasisAnnual: 30000,
    });
    expect(res.stockGain).toBe(20000);
    expect(res.ltcgNet).toBe(20000);
    expect(res.ltcgPriced).toBe(20000);
    expect(res.saleAfterTax?.proceeds).toBe(50000);
    expect(res.cashIn).toBeGreaterThanOrEqual(50000);
    const noSale = pricedWithParity({});
    // Proceeds are cash; only the gain is income.
    expect(res.cashIn - noSale.cashIn).toBe(50000);
    expect(res.agi - noSale.agi).toBe(20000);
  });

  test("sale at a loss: basis above proceeds prices a net capital loss, qualified dividends untouched", async () => {
    // Engine rule (pricePlaygroundYear, rothOptimizer.ts): the loss
    // nets against NOTHING but the §1211(b) allowance — qualified
    // dividends stay whole on the preferential stack.
    const res = pricedWithParity({
      stockSoldAnnual: 20000,
      stockBasisAnnual: 30000,
      ordinaryDividendsAnnual: 5000,
      qualifiedDividendsAnnual: 3000,
      // Enough ordinary income that the $3,000 §1211(b) allowance
      // actually offsets taxable income (with no taxable income
      // the whole loss carries out instead — the ledger reconciles
      // the carry-out against taxable income before the allowance).
      spendingDrawAnnual: 50000,
    });
    expect(res.stockGain).toBe(-10000);
    expect(res.capitalLoss).toBe(10000);
    expect(res.capitalLossAllowance).toBe(3000);
    expect(res.lossCarryOutLt).toBe(7000);
    expect(res.lossCarryOutSt).toBe(0);
    expect(res.qualifiedDividends).toBe(3000);
    expect(res.ltcgNet).toBe(-10000);
    expect(warningsFor({
      stockSoldAnnual: 20000,
      stockBasisAnnual: 30000,
    })).toContain("realizes a loss of $10,000");
  });

  test("all basis (sold == basis): no gain, proceeds still cash", async () => {
    const res = pricedWithParity({
      stockSoldAnnual: 40000,
      stockBasisAnnual: 40000,
    });
    expect(res.stockGain).toBe(0);
    expect(res.ltcgNet).toBe(0);
    expect(res.saleAfterTax?.proceeds).toBe(40000);
    const noSale = pricedWithParity({});
    expect(res.cashIn - noSale.cashIn).toBe(40000);
    expect(res.agi).toBe(noSale.agi);
  });

  test("zero basis: omitted basis prices the whole proceeds as gain; explicit $0 prices the same", async () => {
    const omittedBasis = pricedWithParity({
      stockSoldAnnual: 40000,
    });
    expect(omittedBasis.stockGain).toBe(40000);
    expect(omittedBasis.ltcgNet).toBe(40000);
    expect(warningsFor({ stockSoldAnnual: 40000 })).toContain(
      "No cost basis was entered",
    );
    const explicitZero = pricedWithParity({
      stockSoldAnnual: 40000,
      stockBasisAnnual: 0,
    });
    expect(explicitZero).toEqual(omittedBasis);
    expect(warningsFor({
      stockSoldAnnual: 40000,
      stockBasisAnnual: 0,
    })).not.toContain("No cost basis was entered");
  });

  test("large gain crossing a federal capital-gains threshold: gains reach the 20% band", async () => {
    const res = pricedWithParity({
      spendingDrawAnnual: 400000,
      stockSoldAnnual: 500000,
      stockBasisAnnual: 100000,
    });
    expect(res.stockGain).toBe(400000);
    expect(res.gainsAt15).toBeGreaterThan(0);
    expect(res.gainsAt20).toBeGreaterThan(0);
    expect(res.ltcgTax).toBeGreaterThan(0);
    const smaller = pricedWithParity({
      spendingDrawAnnual: 400000,
      stockSoldAnnual: 100000,
      stockBasisAnnual: 50000,
    });
    expect(res.federalTax).toBeGreaterThan(smaller.federalTax);
  });

  test("gain affecting ACA MAGI: the gain flips the household over the cliff", async () => {
    const base = {
      acaBenchmarkCouple: 12000,
      spendingDrawAnnual: 60000,
    };
    const under = pricedWithParity(base);
    expect(under.aca.overCliff).toBe(false);
    expect(under.aca.credit).toBeGreaterThan(0);
    const over = pricedWithParity({
      ...base,
      stockSoldAnnual: 50000,
      stockBasisAnnual: 20000,
    });
    expect(over.aca.overCliff).toBe(true);
    expect(over.aca.credit).toBe(0);
    expect(over.gainsFlags.acaFlag?.kind).toBe("flipped-over");
    expect(over.acaMagi - under.acaMagi).toBe(30000);
  });

  test("gain affecting NIIT: MAGI crosses $250,000 and NIIT appears", async () => {
    const under = pricedWithParity({ spendingDrawAnnual: 200000 });
    expect(under.niit).toBe(0);
    const over = pricedWithParity({
      spendingDrawAnnual: 200000,
      stockSoldAnnual: 150000,
      stockBasisAnnual: 50000,
    });
    expect(over.magi).toBeGreaterThan(250000);
    expect(over.niit).toBeGreaterThan(0);
  });

  test("Washington capital-gains excise: a large gain prices WA tax; a small gain prices none", async () => {
    const big = pricedWithParity({
      state: "WA",
      stockSoldAnnual: 500000,
      stockBasisAnnual: 100000,
    });
    expect(big.waGains).toBe(400000);
    expect(big.waTaxableGains).toBeGreaterThan(0);
    expect(big.stateTax).toBeGreaterThan(0);
    expect(big.stateTax).toBe(0.07 * big.waTaxableGains);
    const small = pricedWithParity({
      state: "WA",
      stockSoldAnnual: 50000,
      stockBasisAnnual: 30000,
    });
    expect(small.waTaxableGains).toBe(0);
    expect(small.stateTax).toBe(0);
  });

  test("qualified dividends + realized gains in the same year: dividends counted once", async () => {
    const res = pricedWithParity({
      ordinaryDividendsAnnual: 10000,
      qualifiedDividendsAnnual: 6000,
      stockSoldAnnual: 50000,
      stockBasisAnnual: 30000,
    });
    expect(res.nonQualifiedDividends).toBe(4000);
    expect(res.qualifiedDividends).toBe(6000);
    expect(res.ltcgNet).toBe(20000);
    // Preferential stack = net gain + qualified dividends, counted once.
    expect(res.ltcgPriced).toBe(26000);
  });

  test("basis with no sale is inert: no phantom loss", async () => {
    const res = pricedWithParity({ stockBasisAnnual: 30000 });
    expect(res.stockGain).toBe(0);
    expect(res.capitalLoss).toBe(0);
    expect(res.lossCarryOutLt).toBe(0);
    expect(warningsFor({ stockBasisAnnual: 30000 })).toContain(
      "Cost basis was entered with no sale",
    );
  });

  test("a sale above the typed taxable balance warns but still prices", async () => {
    const res = pricedWithParity({
      stockSoldAnnual: 3000000,
      stockBasisAnnual: 1000000,
    });
    expect(res.stockGain).toBe(2000000);
    expect(warningsFor({
      stockSoldAnnual: 3000000,
      stockBasisAnnual: 1000000,
    })).toContain("exceeds the typed taxable balance");
  });

  test("taxableBasisPct never prices a sale on its own", async () => {
    const res = pricedWithParity({ taxableBasisPct: 50 });
    expect(res.stockGain).toBe(0);
    expect(res.saleAfterTax).toBeNull();
  });

  test("negative sale / basis / balance / received amounts are invalid_input", async () => {
    for (const bad of [
      { stockSoldAnnual: -1 },
      { stockBasisAnnual: -1 },
      { pretaxPriorYearEndAnnual: -5 },
      { pretaxSpousePriorYearEndAnnual: -5 },
      { rmdAlreadyReceivedAnnual: -1 },
    ]) {
      const n = normalizeInputs(fictionalScenario(bad));
      expect(n.ok).toBe(false);
      if (n.ok) throw new Error("negative input should not normalize");
      expect(n.error.error.code).toBe("invalid_input");
    }
    const nBool = normalizeInputs(
      fictionalScenario({
        primarySoleBeneficiaryOfSpouse: "yes" as unknown as boolean,
      }),
    );
    expect(nBool.ok).toBe(false);
    if (nBool.ok) throw new Error("non-boolean should not normalize");
    expect(nBool.error.error.code).toBe("invalid_input");
  });

  test("a basis above the proceeds is accepted (loss), never a validation error", async () => {
    const n = normalizeInputs(
      fictionalScenario({ stockSoldAnnual: 20000, stockBasisAnnual: 30000 }),
    );
    expect(n.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §3 — RMDs (R6-S2)
// ---------------------------------------------------------------------------

describe("R6-S2 RMDs: direct-engine parity", () => {
  test("younger than RMD age: balance entered, RMD $0, rmdPriced true", async () => {
    // Born 1956 → RMD age 73; age 70 is below it.
    const res = pricedWithParity({
      currentAge: 70,
      spouseAge: 68,
      retirementAge: 70,
      pretaxPriorYearEndAnnual: 500000,
    });
    expect(res.rmdPriced).toBe(true);
    expect(res.rmd).toBe(0);
    expect(res.rmdGross).toBe(0);
    expect(warningsFor({
      currentAge: 70,
      spouseAge: 68,
      retirementAge: 70,
      pretaxPriorYearEndAnnual: 500000,
    })).toContain("below RMD age 73");
  });

  test("at first RMD age: uniform divisor 26.5 at 73", async () => {
    // Born 1953 → RMD age 73. Spouse 71 (2 years younger) → Uniform.
    const res = pricedWithParity({
      ...AT_73,
      pretaxPriorYearEndAnnual: 500000,
    });
    expect(res.rmdPrimary).toBe(18867.92);
    expect(res.rmd).toBe(18867.92);
    expect(res.rmdDivisor).toBe(26.5);
    expect(res.rmdTable).toBe("uniform");
    expect(res.rmdPriced).toBe(true);
  });

  test("primary more than 10 years older than the spouse: Joint table", async () => {
    const res = pricedWithParity({
      ...AT_73,
      spouseAge: 60,
      pretaxPriorYearEndAnnual: 500000,
    });
    expect(res.rmdTable).toBe("joint");
    // Joint divisor is larger than Uniform 26.5, so the RMD is smaller.
    expect(res.rmdPrimary).toBeGreaterThan(0);
    expect(res.rmdPrimary).toBeLessThan(18867.92);
  });

  test("older than RMD age: uniform divisor 24.6 at 75", async () => {
    const res = pricedWithParity({
      ...AT_75,
      pretaxPriorYearEndAnnual: 600000,
    });
    expect(res.rmdPrimary).toBe(24390.24);
    expect(res.rmdDivisor).toBe(24.6);
    expect(res.rmdTable).toBe("uniform");
  });

  test("explicit zero prior-year balance: RMD $0, rmdPriced true, distinct warning", async () => {
    const res = pricedWithParity({
      ...AT_75,
      pretaxPriorYearEndAnnual: 0,
    });
    expect(res.rmdPriced).toBe(true);
    expect(res.rmd).toBe(0);
    const w = warningsFor({ ...AT_75, pretaxPriorYearEndAnnual: 0 });
    expect(w).toContain("explicit $0 prior-Dec-31");
    expect(w).not.toContain("No prior-year pre-tax balance is carried");
  });

  test("missing prior-year balance: no RMD, rmdPriced false", async () => {
    const res = pricedWithParity({ ...AT_75 });
    expect(res.rmdPriced).toBe(false);
    expect(res.rmd).toBe(0);
    expect(res.rmdGross).toBe(0);
    expect(warningsFor({ ...AT_75 })).toContain(
      "No prior-year pre-tax balance is carried in the single-year inputs, so no RMD is priced in this year.",
    );
  });

  test("married, different spouse ages: each RMD on its own balance and clock", async () => {
    const res = pricedWithParity({
      ...AT_75,
      pretaxPriorYearEndAnnual: 600000,
      pretaxSpousePriorYearEndAnnual: 400000,
    });
    expect(res.rmdPrimary).toBe(24390.24);
    // Spouse 73 → Uniform divisor 26.5.
    expect(res.rmdSpouse).toBe(15094.34);
    expect(res.rmdGross).toBe(39484.58);
    expect(res.rmd).toBe(39484.58);
    expect(res.rmdTable).toBe("uniform");
  });

  test("spouse more than 10 years younger: primary Joint, spouse RMD $0 below RMD age", async () => {
    const res = pricedWithParity({
      ...AT_75,
      spouseAge: 60,
      pretaxPriorYearEndAnnual: 600000,
      pretaxSpousePriorYearEndAnnual: 200000,
    });
    expect(res.rmdTable).toBe("joint");
    expect(res.rmdSpouse).toBe(0);
    expect(res.rmdPrimary).toBeGreaterThan(0);
    expect(res.rmdPrimary).toBeLessThan(24390.24);
  });

  test("spouse balance alone: primary RMD $0, spouse RMD on the spouse's clock", async () => {
    const res = pricedWithParity({
      ...AT_75,
      pretaxSpousePriorYearEndAnnual: 400000,
    });
    expect(res.rmdPrimary).toBe(0);
    expect(res.rmdSpouse).toBe(15094.34);
    expect(res.rmd).toBe(15094.34);
    expect(res.rmdTable).toBe("uniform");
  });

  test("spouse Joint table needs primarySoleBeneficiaryOfSpouse — the spouse-beneficiary fact is NOT reciprocal", async () => {
    // Spouse 75, primary 60: the spouse's RMD is the only RMD, so
    // rmdTable is the spouse's table.
    const base = {
      currentAge: 60,
      spouseAge: 75,
      retirementAge: 60,
      pretaxSpousePriorYearEndAnnual: 400000,
    };
    const uniform = pricedWithParity(base);
    expect(uniform.rmdSpouse).toBe(16260.16); // 400000 / 24.6
    expect(uniform.rmdTable).toBe("uniform");
    const joint = pricedWithParity({
      ...base,
      primarySoleBeneficiaryOfSpouse: true,
    });
    expect(joint.rmdTable).toBe("joint");
    expect(joint.rmdSpouse).toBeGreaterThan(0);
    expect(joint.rmdSpouse).toBeLessThan(16260.16);
    // And the reverse fact does not imply it: mfj already models
    // the spouse as the primary's sole beneficiary, yet the
    // spouse's RMD above still priced Uniform.
    expect(warningsFor(base)).toContain(
      "Whether the primary is the spouse's sole beneficiary was not established",
    );
  });

  test("primarySoleBeneficiaryOfSpouse assumption entry appears only when the fact is given (NICE-3)", async () => {
    const base = {
      currentAge: 60,
      spouseAge: 75,
      retirementAge: 60,
      pretaxSpousePriorYearEndAnnual: 400000,
    };
    // Explicit false: a known fact, so the Uniform table applies
    // as a known fact — never "not established" — and the
    // assumption entry carries it with user provenance.
    const wFalse = warningsFor({
      ...base,
      primarySoleBeneficiaryOfSpouse: false,
    });
    expect(wFalse).toContain(
      "The primary is not the spouse's sole beneficiary",
    );
    expect(wFalse).not.toContain("not established");
    const envFalse = envelopeWithParity({
      ...base,
      primarySoleBeneficiaryOfSpouse: false,
    });
    const extraFalse = envFalse.assumptions.filter(
      (a) => a.field === "primarySoleBeneficiaryOfSpouse",
    );
    expect(extraFalse).toHaveLength(1);
    expect(extraFalse[0]?.value).toBe(false);
    expect(extraFalse[0]?.provenance).toBe("user");
    expect(extraFalse[0]?.note).toContain(
      "The primary is not the spouse's sole beneficiary",
    );
    expect(extraFalse[0]?.note).not.toContain("not established");
    // Explicit true: the same shape, the sole-beneficiary note.
    const envTrue = envelopeWithParity({
      ...base,
      primarySoleBeneficiaryOfSpouse: true,
    });
    const extraTrue = envTrue.assumptions.filter(
      (a) => a.field === "primarySoleBeneficiaryOfSpouse",
    );
    expect(extraTrue).toHaveLength(1);
    expect(extraTrue[0]?.value).toBe(true);
    expect(extraTrue[0]?.provenance).toBe("user");
    expect(extraTrue[0]?.note).toContain(
      "The primary is the spouse's sole beneficiary",
    );
    expect(extraTrue[0]?.note).not.toContain("not established");
    expect(envTrue.warnings.join(" ")).toContain(
      "The primary is the spouse's sole beneficiary",
    );
    // Absent (null): the WARNING still says "not established" —
    // the caller is told why the spouse's RMD prices Uniform —
    // but there is NO assumption entry at all: nothing was
    // assumed, so nothing is recorded as an assumption. (The
    // pre-NICE-3 "not established" assumption entry is gone by
    // design, not a regression.)
    const envAbsent = envelopeWithParity(base);
    expect(envAbsent.warnings.join(" ")).toContain(
      "Whether the primary is the spouse's sole beneficiary was not established",
    );
    const extraAbsent = envAbsent.assumptions.filter(
      (a) => a.field === "primarySoleBeneficiaryOfSpouse",
    );
    expect(extraAbsent).toHaveLength(0);
  });

  test("RMD + Roth conversion: both priced as ordinary income, overlap warning fires", async () => {
    const res = pricedWithParity({
      ...AT_75,
      pretaxPriorYearEndAnnual: 600000,
      conversionAnnual: 50000,
    });
    expect(res.rmd).toBe(24390.24);
    const noRmd = pricedWithParity({ ...AT_75, conversionAnnual: 50000 });
    // The AGI delta is the RMD PLUS the extra Social Security the
    // RMD pulls into tax (the 85% band): the RMD raises provisional
    // income, so more of the $54,000 of benefits is taxable.
    expect(round2(res.agi - noRmd.agi)).toBe(
      round2(24390.24 + (res.ssTaxable - noRmd.ssTaxable)),
    );
    expect(res.ssTaxable).toBeGreaterThan(noRmd.ssTaxable);
    expect(warningsFor({
      ...AT_75,
      pretaxPriorYearEndAnnual: 600000,
      conversionAnnual: 50000,
    })).toContain("priced as income in addition to the typed conversion");
  });

  test("RMD + spending withdrawal: the draw prices beside the RMD, and rmdAlreadyReceived nets it out", async () => {
    const res = pricedWithParity({
      ...AT_75,
      pretaxPriorYearEndAnnual: 600000,
      spendingDrawAnnual: 75000,
    });
    expect(res.rmd).toBe(24390.24);
    expect(warningsFor({
      ...AT_75,
      pretaxPriorYearEndAnnual: 600000,
      spendingDrawAnnual: 75000,
    })).toContain("priced as income in addition to the typed spending draw");
    // The draw already includes the RMD: say so, and it is not counted twice.
    const netted = pricedWithParity({
      ...AT_75,
      pretaxPriorYearEndAnnual: 600000,
      spendingDrawAnnual: 75000,
      rmdAlreadyReceivedAnnual: 24390.24,
    });
    expect(netted.rmdGross).toBe(24390.24);
    expect(netted.rmdAlreadyReceived).toBe(24390.24);
    expect(netted.rmd).toBe(0);
    // Both years sit in the 85% Social Security band, so the AGI
    // delta here is exactly the netted RMD (modulo float dust).
    expect(round2(netted.agi)).toBe(round2(res.agi - 24390.24));
  });

  test("RMD fully netted by rmdAlreadyReceived: no overlap warning, already-received note present", async () => {
    const netted = pricedWithParity({
      ...AT_75,
      pretaxPriorYearEndAnnual: 600000,
      spendingDrawAnnual: 75000,
      rmdAlreadyReceivedAnnual: 24390.24,
    });
    expect(netted.rmdGross).toBe(24390.24);
    expect(netted.rmdAlreadyReceived).toBe(24390.24);
    expect(netted.rmd).toBe(0);
    // The net RMD added beside the draw is $0, so there is no
    // overlap to warn about — and the warning must not contradict
    // the already-received note by advising an action already
    // taken in full.
    const w = warningsFor({
      ...AT_75,
      pretaxPriorYearEndAnnual: 600000,
      spendingDrawAnnual: 75000,
      rmdAlreadyReceivedAnnual: 24390.24,
    });
    expect(w).not.toContain(
      "priced as income in addition to the typed spending draw",
    );
    expect(w).toContain(
      "already received and already counted in the entered income",
    );
    expect(w).toContain("not counted twice");
  });

  test("RMD partially netted: overlap warning quotes the net RMD, not the gross", async () => {
    const res = pricedWithParity({
      ...AT_75,
      pretaxPriorYearEndAnnual: 600000,
      spendingDrawAnnual: 75000,
      rmdAlreadyReceivedAnnual: 10000,
    });
    expect(res.rmdGross).toBe(24390.24);
    expect(res.rmdAlreadyReceived).toBe(10000);
    expect(res.rmd).toBe(14390.24);
    const w = warningsFor({
      ...AT_75,
      pretaxPriorYearEndAnnual: 600000,
      spendingDrawAnnual: 75000,
      rmdAlreadyReceivedAnnual: 10000,
    });
    expect(w).toContain(
      "The RMD ($14,390.24) is priced as income in addition to the typed spending draw",
    );
    expect(w).not.toContain("The RMD ($24,390.24)");
  });

  test("rmdAlreadyReceived above the computed RMD clamps to the gross RMD", async () => {
    const res = pricedWithParity({
      ...AT_75,
      pretaxPriorYearEndAnnual: 600000,
      rmdAlreadyReceivedAnnual: 999999,
    });
    expect(res.rmdGross).toBe(24390.24);
    expect(res.rmdAlreadyReceived).toBe(24390.24);
    expect(res.rmd).toBe(0);
    expect(warningsFor({
      ...AT_75,
      pretaxPriorYearEndAnnual: 600000,
      rmdAlreadyReceivedAnnual: 999999,
    })).toContain("exceeds the computed RMD");
  });

  test("rmdAlreadyReceived with no balance entered has no effect", async () => {
    const res = pricedWithParity({
      ...AT_75,
      rmdAlreadyReceivedAnnual: 5000,
    });
    expect(res.rmd).toBe(0);
    expect(res.rmdAlreadyReceived).toBe(0);
    expect(warningsFor({
      ...AT_75,
      rmdAlreadyReceivedAnnual: 5000,
    })).toContain("no computed RMD to net it against");
  });

  test("RMD year with taxable Social Security: SS pays, most of it taxable", async () => {
    const res = pricedWithParity({
      ...AT_75,
      pretaxPriorYearEndAnnual: 600000,
    });
    expect(res.ssBenefits).toBe(54000);
    expect(res.ssTaxable).toBeGreaterThan(0);
    expect(res.ssPctTaxed).toBeGreaterThan(0);
    expect(res.rmd).toBe(24390.24);
  });

  test("RMD effects on ACA: the RMD flips a younger-spouse household over the cliff", async () => {
    // Primary 75 is on Medicare; spouse 60 is not, so ACA applies.
    const base = {
      currentAge: 75,
      spouseAge: 60,
      retirementAge: 75,
      acaBenchmarkCouple: 12000,
      spendingDrawAnnual: 40000,
    };
    const without = pricedWithParity(base);
    expect(without.aca.overCliff).toBe(false);
    expect(without.aca.credit).toBeGreaterThan(0);
    const withRmd = pricedWithParity({
      ...base,
      pretaxPriorYearEndAnnual: 500000,
    });
    expect(withRmd.rmd).toBe(17667.84); // 500000 / Joint divisor 28.3: the spouse is 15 years younger, so the primary's RMD prices on the Joint table
    expect(withRmd.aca.overCliff).toBe(true);
    expect(withRmd.aca.credit).toBe(0);
  });

  test("RMD effects on IRMAA: the RMD lifts the premium-year tier", async () => {
    const base = {
      ...AT_75,
      spendingDrawAnnual: 165000,
    };
    const without = pricedWithParity(base);
    const withRmd = pricedWithParity({
      ...base,
      pretaxPriorYearEndAnnual: 600000,
    });
    expect(withRmd.rmd).toBe(24390.24);
    expect(withRmd.irmaa.tier).toBeGreaterThan(without.irmaa.tier);
    expect(withRmd.irmaa.premiumYear).toBe(2028);
  });

  test("spouse balance on a non-joint return is ignored", async () => {
    const s = normalizedScenario({
      filingStatus: "single",
      currentAge: 75,
      retirementAge: 75,
      pretaxPriorYearEndAnnual: 600000,
      pretaxSpousePriorYearEndAnnual: 400000,
    });
    const res = expectOk(calculateSingleYearTax(s));
    expect(res).toEqual(roundDeep(pricePlaygroundYear(directInputs(s))));
    expect(res.rmdPrimary).toBe(24390.24);
    expect(res.rmdSpouse).toBe(0);
    expect(res.rmd).toBe(24390.24);
    const env = expectEnvelope(calculateSingleYearTax(s));
    expect(env.warnings.join(" ")).toContain(
      "non-joint return — the engine ignores it",
    );
  });
});

// ---------------------------------------------------------------------------
// §3b — 2025 law year (NICE-2): the new fields price under 2025 law.
// ---------------------------------------------------------------------------

describe("R6 2025 law year (NICE-2)", () => {
  /** Adapter envelope for taxYear 2025 (expectEnvelope pins
   *  taxLawYear 2026, so the 2025 call asserts ok:true directly
   *  instead — the same pattern as parity.test.ts). Parity
   *  against a direct pricePlaygroundYear call on the same
   *  2025 inputs is asserted to the cent. */
  function envelope2025(overrides: Record<string, unknown> = {}) {
    const s = normalizedScenario({ taxYear: 2025, ...overrides });
    const env = calculateSingleYearTax(s);
    if (!env.ok) throw new Error(JSON.stringify(env.error));
    expect(env.source).toBe("finance-planner-engine");
    expect(env.taxLawYear).toBe(2025);
    expect(env.results).toEqual(roundDeep(pricePlaygroundYear(directInputs(s))));
    return env;
  }

  test("2025 stock sale: parity on the 2025 law table, envelope reports taxLawYear 2025", async () => {
    const env = envelope2025({
      stockSoldAnnual: 50000,
      stockBasisAnnual: 30000,
      spendingDrawAnnual: 114000,
    });
    const res = env.results;
    expect(res.stockGain).toBe(20000);
    expect(res.ltcgNet).toBe(20000);
    expect(res.saleAfterTax?.proceeds).toBe(50000);
    expect(res.agi).toBe(134000);
    // The same inputs price differently under 2026 law (different
    // standard deduction and brackets), so the 2025 figures are the
    // 2025 table's, not a relabeled 2026 price.
    const y26 = pricedWithParity({
      stockSoldAnnual: 50000,
      stockBasisAnnual: 30000,
      spendingDrawAnnual: 114000,
    });
    expect(res.federalTax).not.toBe(y26.federalTax);
  });

  test("2025 RMD: parity on the 2025 law table, divisor-derived figures", async () => {
    // In tax year 2025 the priced ages are one less than
    // currentAge (agePrimary = currentAge + (taxYear − startYear),
    // startYear 2026), so age 75 in 2025 needs currentAge 76.
    const env = envelope2025({
      currentAge: 76,
      spouseAge: 74,
      retirementAge: 76,
      pretaxPriorYearEndAnnual: 600000,
      pretaxSpousePriorYearEndAnnual: 400000,
    });
    const res = env.results;
    // Divisors are the engine's Uniform table at the priced ages
    // (75 → 24.6, 73 → 26.5); the law year moves the tax, not the
    // RMD.
    expect(res.rmdPrimary).toBe(24390.24);
    expect(res.rmdSpouse).toBe(15094.34);
    expect(res.rmdGross).toBe(39484.58);
    expect(res.rmdDivisor).toBe(24.6);
    expect(res.rmdTable).toBe("uniform");
    expect(res.rmd).toBe(39484.58);
  });
});

// ---------------------------------------------------------------------------
// §3c — $100M bound (NICE-4): schema.ts DOLLAR_MAX pins per field.
// ---------------------------------------------------------------------------

describe("R6 $100M bound (NICE-4)", () => {
  const DOLLAR_FIELDS = [
    "stockSoldAnnual",
    "stockBasisAnnual",
    "pretaxPriorYearEndAnnual",
    "pretaxSpousePriorYearEndAnnual",
    "rmdAlreadyReceivedAnnual",
  ] as const;

  test("each new dollar field accepts $100,000,000 and rejects $100,000,001 naming the field", async () => {
    for (const field of DOLLAR_FIELDS) {
      const over = normalizeInputs(
        fictionalScenario({ [field]: 100_000_001 }),
      );
      expect(over.ok).toBe(false);
      if (over.ok) throw new Error(`${field} over the cap should not normalize`);
      expect(over.error.error.code).toBe("invalid_input");
      expect(over.error.error.message).toContain(field);
      // $100,000,000 itself is the cap and is accepted.
      expect(
        normalizeInputs(fictionalScenario({ [field]: 100_000_000 })).ok,
      ).toBe(true);
    }
  });

  test("the cap holds at the MCP dispatch layer (stockSoldAnnual)", async () => {
    const over = await dispatchTool(
      "retirement_tax_year",
      fictionalScenario({
        stockSoldAnnual: 100_000_001,
        stockBasisAnnual: 0,
      }),
    );
    expect(over.ok).toBe(false);
    if (over.ok) throw new Error("over-cap sale should not dispatch");
    expect(over.error.code).toBe("invalid_input");
    expect(over.error.message).toContain("stockSoldAnnual");
    const at = await dispatchTool(
      "retirement_tax_year",
      fictionalScenario({
        stockSoldAnnual: 100_000_000,
        stockBasisAnnual: 0,
      }),
    );
    expect(at.ok).toBe(true);
    if (!at.ok) throw new Error(JSON.stringify(at.error));
    expect((at.results as PlaygroundYearResult).stockGain).toBe(100_000_000);
  });

  test("primarySoleBeneficiaryOfSpouse is boolean, not dollar-capped", async () => {
    // true/false normalize; a dollar figure — even exactly at the
    // $100M cap — is not a boolean and is rejected.
    expect(
      normalizeInputs(
        fictionalScenario({ primarySoleBeneficiaryOfSpouse: true }),
      ).ok,
    ).toBe(true);
    expect(
      normalizeInputs(
        fictionalScenario({ primarySoleBeneficiaryOfSpouse: false }),
      ).ok,
    ).toBe(true);
    const n = normalizeInputs(
      fictionalScenario({ primarySoleBeneficiaryOfSpouse: 100_000_000 }),
    );
    expect(n.ok).toBe(false);
    if (n.ok) throw new Error("a number is not a boolean");
    expect(n.error.error.code).toBe("invalid_input");
  });
});

// ---------------------------------------------------------------------------
// §3d — Hand-built expected values (NICE-5): the parity oracle is not
// the suite's only check — this test asserts literals derived BY HAND.
// ---------------------------------------------------------------------------

describe("R6 hand-built expected values (NICE-5 oracle independence)", () => {
  test("spending draw only: exact figures derived by hand from the 2026 law table", async () => {
    // HAND DERIVATION — no pricePlaygroundYear, no directInputs
    // anywhere in this test. The expected values below are
    // literals computed here, step by step, from the published
    // 2026 law table (server/src/taxLaw.ts, TAX_LAW_2026) and
    // the engine's documented stacking — a reviewer can check
    // them without running code. Cross-check on the method:
    // the same bracket math reproduces the pinned
    // backward-compat case (AGI $140,000, $3,000 qualified
    // dividends → federalTax $12,930) exactly.
    //
    // Case: MFJ, ages 54/52 in 2026, only a $114,000 pre-tax
    // spending draw. No interest, dividends, conversion, sale,
    // RMD, or Social Security (SS starts at 67); no ACA
    // benchmark, no state.
    //
    // 1. AGI: the draw is ordinary income and the only income,
    //    so AGI = $114,000. MAGI = AGI (no tax-exempt interest).
    // 2. Deductions: MFJ standard deduction $32,200 (2026); no
    //    age-65 add-on (both under 65); nothing itemized.
    // 3. Taxable income: 114,000 − 32,200 = $81,800, all
    //    ordinary — no preferential income, so ltcgTax $0 and
    //    no gains in any band.
    // 4. Ordinary tax, 2026 MFJ brackets (10% to $24,800, then
    //    12% to $100,800): 10% × 24,800 = $2,480, plus
    //    12% × (81,800 − 24,800 = 57,000) = $6,840, for
    //    ordinaryTax = $9,320.
    // 5. NIIT $0 (MAGI $114,000 < $250,000 MFJ threshold);
    //    stateTax $0 (no state). federalTax = $9,320,
    //    totalTax = $9,320, netTaxBill = $9,320 (no refundable
    //    education credit).
    // 6. Cash: cashIn = $114,000 (the draw, the only cash in);
    //    cashLeftAfterTax = 114,000 − 9,320 = $104,680; annual
    //    spending is $9,500 × 12 = $114,000, so
    //    cashLeftVsSpending = 104,680 − 114,000 = −$9,320.
    // 7. Zeros: SS benefits $0 and taxable $0; no sale, so
    //    stockGain $0 and saleAfterTax null; no balance entered,
    //    so rmd $0, rmdGross $0, rmdPriced false.
    const res = expectOk(
      calculateSingleYearTax(
        normalizedScenario({ spendingDrawAnnual: 114000 }),
      ),
    );
    expect(res.agi).toBe(114000);
    expect(res.magi).toBe(114000);
    expect(res.deductions).toBe(32200);
    expect(res.taxableIncome).toBe(81800);
    expect(res.ordinaryTaxableIncome).toBe(81800);
    expect(res.gainsInTaxableIncome).toBe(0);
    expect(res.ordinaryTax).toBe(9320);
    expect(res.ltcgTax).toBe(0);
    expect(res.gainsAt0).toBe(0);
    expect(res.gainsAt15).toBe(0);
    expect(res.gainsAt20).toBe(0);
    expect(res.niit).toBe(0);
    expect(res.federalTax).toBe(9320);
    expect(res.stateTax).toBe(0);
    expect(res.totalTax).toBe(9320);
    expect(res.netTaxBill).toBe(9320);
    expect(res.cashIn).toBe(114000);
    expect(res.cashLeftAfterTax).toBe(104680);
    expect(res.cashLeftVsSpending).toBe(-9320);
    expect(res.ssBenefits).toBe(0);
    expect(res.ssTaxable).toBe(0);
    expect(res.stockGain).toBe(0);
    expect(res.saleAfterTax).toBeNull();
    expect(res.rmd).toBe(0);
    expect(res.rmdGross).toBe(0);
    expect(res.rmdPriced).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility, warnings, determinism, isolation
// ---------------------------------------------------------------------------

describe("R6 backward compatibility and contract", () => {
  test("calls without the new fields price bit-identically to the old mapping", async () => {
    const s = normalizedScenario({
      taxYear: 2026,
      interestAnnual: 1000,
      ordinaryDividendsAnnual: 5000,
      qualifiedDividendsAnnual: 3000,
      conversionAnnual: 20000,
      spendingDrawAnnual: 114000,
      cashDrawAnnual: 0,
      rothDrawAnnual: 0,
    });
    const res = expectOk(calculateSingleYearTax(s));
    // The pre-R6 direct mapping: stockSold/stockBasis 0, pretaxBalance null.
    const direct: PlaygroundYearInputs = {
      taxYear: 2026,
      filingStatus: "mfj",
      agePrimary: s.currentAge + (s.taxYear - s.startYear),
      ageSpouse: s.birthYearSpouse === null ? null : s.taxYear - s.birthYearSpouse,
      onMedicarePrimary: false,
      onMedicareSpouse: false,
      interest: s.singleYear.interest,
      ordinaryDividends: s.singleYear.ordinaryDividends,
      otherOrdinary: s.otherOrdinaryAnnual,
      taxExemptInterest: s.taxExemptInterestAnnual,
      ssPrimary: 0,
      ssSpouse: 0,
      conversion: s.singleYear.conversion,
      spendingDraw: s.singleYear.spendingDraw,
      cashDraw: s.singleYear.cashDraw,
      rothDraw: s.singleYear.rothDraw,
      inflationPct: s.inflationPct,
      stockSold: 0,
      stockBasis: 0,
      qualifiedDividends: s.singleYear.qualifiedDividends,
      pretaxBalance: null,
      spouseSoleBeneficiary: true,
      acaHouseholdSize: s.householdSize,
      acaBenchmarkAnnual: null,
      stateRatePct: s.stateRatePct,
      residenceState: s.residenceState,
      annualSpending: s.annualSpendingCents / 100,
    };
    expect(res).toEqual(roundDeep(pricePlaygroundYear(direct)));
    expect(res.federalTax).toBe(12930);
    expect(res.totalTax).toBe(12930);
    expect(res.agi).toBe(140000);
  });

  test("omitted vs explicit zero: warnings distinguish; the sale figures do not move, the RMD flag does", async () => {
    const omitted = pricedWithParity({});
    const explicitSale = pricedWithParity({
      stockSoldAnnual: 0,
      stockBasisAnnual: 0,
    });
    expect(explicitSale).toEqual(omitted);
    const wOmitted = warningsFor({});
    const wExplicit = warningsFor({
      stockSoldAnnual: 0,
      stockBasisAnnual: 0,
      pretaxPriorYearEndAnnual: 0,
      pretaxSpousePriorYearEndAnnual: 0,
      rmdAlreadyReceivedAnnual: 0,
    });
    expect(wOmitted).toContain("No taxable share sale was entered");
    expect(wExplicit).toContain("explicit $0 share sale");
    expect(wOmitted).toContain("No prior-year pre-tax balance is carried");
    expect(wExplicit).toContain("explicit $0 prior-Dec-31");
    // The one figure that DOES move: an explicit $0 balance was
    // entered, so rmdPriced is true; omitted, it is false. The
    // RMD itself is $0 either way.
    const omittedRmd = pricedWithParity({ ...AT_75 });
    const explicitRmd = pricedWithParity({
      ...AT_75,
      pretaxPriorYearEndAnnual: 0,
    });
    expect(omittedRmd.rmd).toBe(0);
    expect(explicitRmd.rmd).toBe(0);
    expect(omittedRmd.rmdPriced).toBe(false);
    expect(explicitRmd.rmdPriced).toBe(true);
  });

  test("new fields carry user provenance when given, assumption provenance when omitted", async () => {
    const s = normalizedScenario({
      stockSoldAnnual: 20000,
      stockBasisAnnual: 12000,
      pretaxPriorYearEndAnnual: 500000,
      primarySoleBeneficiaryOfSpouse: false,
    });
    const byField = new Map(s.assumptions.map((a) => [a.field, a]));
    expect(byField.get("singleYear.stockSold")?.provenance).toBe("user");
    expect(byField.get("singleYear.pretaxPriorYearEnd")?.provenance).toBe(
      "user",
    );
    expect(
      byField.get("singleYear.primarySoleBeneficiaryOfSpouse")?.provenance,
    ).toBe("user");
    expect(byField.get("singleYear.rmdAlreadyReceived")?.provenance).toBe(
      "assumption",
    );
    expect(byField.get("singleYear.rmdAlreadyReceived")?.value).toBeNull();
    const env = expectEnvelope(calculateSingleYearTax(s));
    // The adapter's own extra assumption (field name without the
    // "singleYear." prefix — the normalize entry carries that prefix).
    const extra = env.assumptions.filter(
      (a) => a.field === "primarySoleBeneficiaryOfSpouse",
    );
    expect(extra).toHaveLength(1);
    expect(extra[0]?.value).toBe(false);
    expect(extra[0]?.provenance).toBe("user");
  });

  test("a sale + RMD call is deterministic across repeated calls", async () => {
    const overrides = {
      ...AT_75,
      pretaxPriorYearEndAnnual: 600000,
      stockSoldAnnual: 50000,
      stockBasisAnnual: 30000,
      spendingDrawAnnual: 75000,
    };
    const first = calculateSingleYearTax(normalizedScenario(overrides));
    const second = calculateSingleYearTax(normalizedScenario(overrides));
    expect(second).toEqual(first);
  });

  test("the new fields price through the MCP dispatch path", async () => {
    const res = await dispatchTool(
      "retirement_tax_year",
      fictionalScenario({
        ...AT_75,
        pretaxPriorYearEndAnnual: 600000,
        stockSoldAnnual: 50000,
        stockBasisAnnual: 30000,
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    const results = res.results as ReturnType<typeof pricePlaygroundYear>;
    expect(results.rmd).toBe(24390.24);
    expect(results.stockGain).toBe(20000);
  });

  test("isolation: a sale + RMD prices identically with extreme balances and after the sample household is mutated", async () => {
    const overrides = {
      ...AT_75,
      pretaxPriorYearEndAnnual: 600000,
      stockSoldAnnual: 50000,
      stockBasisAnnual: 30000,
    };
    const base = calculateSingleYearTax(normalizedScenario(overrides));
    // Extremes price sanely and independently of every sample value.
    const zero = calculateSingleYearTax(
      normalizedScenario({
        ...overrides,
        pretax: 0,
        taxable: 0,
        roth: 0,
        hsa: 0,
        monthlySpending: 100,
      }),
    );
    expect(zero.ok).toBe(true);
    const huge = calculateSingleYearTax(
      normalizedScenario({
        ...overrides,
        pretax: 99000000,
        taxable: 99000000,
        roth: 0,
        hsa: 0,
      }),
    );
    expect(huge.ok).toBe(true);
    // Mutating the sample household must not move the adapter.
    const before = JSON.stringify(base);
    const sample = sampleHousehold.SAMPLE_HOUSEHOLD as unknown as Record<
      string,
      unknown
    >;
    const saved = { ...sample };
    try {
      for (const k of Object.keys(sample)) {
        if (typeof sample[k] === "number") sample[k] = 999999999;
      }
      const after = calculateSingleYearTax(normalizedScenario(overrides));
      expect(JSON.stringify(after)).toBe(before);
    } finally {
      for (const [k, v] of Object.entries(saved)) sample[k] = v;
    }
  });
});

// ---------------------------------------------------------------------------
// §NICE-7 — Below-100% FPL warning: "would be $0" when the credit is null
// (Engine Review 6 NICEs fix)
// ---------------------------------------------------------------------------

describe("NICE-7 below-100% warning: would-be vs is $0", () => {
  // The fictional household prices a $0 single-year income here
  // (no single-year income fields entered), so the year's ACA MAGI
  // is $0 — under 100% of the 2026-coverage poverty line for a
  // household of 2 ($21,150) — and the credit is $0 under the
  // standard §36B income test.
  test("no benchmark entered: credit is null, warning says 'would be $0'", async () => {
    const res = pricedWithParity({});
    expect(res.aca.below100Fpl).toBe(true);
    expect(res.aca.credit).toBeNull();
    const w = warningsFor({});
    expect(w).toContain("ACA credit would be $0");
    expect(w).not.toContain("ACA credit is $0");
  });

  test("benchmark entered: credit is priced $0, warning says 'is $0'", async () => {
    const res = pricedWithParity({ acaBenchmarkCouple: 20000 });
    expect(res.aca.below100Fpl).toBe(true);
    expect(res.aca.credit).toBe(0);
    const w = warningsFor({ acaBenchmarkCouple: 20000 });
    expect(w).toContain("ACA credit is $0");
    expect(w).not.toContain("ACA credit would be $0");
  });
});
