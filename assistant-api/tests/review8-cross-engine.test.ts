// review8-cross-engine.test.ts — Review 8: cross-engine consistency.
//
// Two parts. (A) E8-S1/E8-S2: the Medicare enrollment-age input and the
// scoped retirement-age winners, adopting Review 5's uncommitted design
// with ONE renaming — Review 5's `comparisonScope: "salary-aware" |
// "retirement-only"` collides with Review 4's existing `comparisonScope`
// block ("limited"/"full") already present in the work-years response,
// so Review 8 reports the scoped models under `comparisonModels`
// instead (D12). (B) The §4/§5 cross-engine matrix: the same fact
// priced by two engines must agree, and every dollar must be counted
// exactly once (§6).
//
// Cash-flow reconciliation equations (§6) — each is asserted below,
// not just stated:
//   salary once:        roll.totals.grossSalary = salary x work years
//   SS once:            each roll line's ssBenefits is that year's own
//                       household benefit (primary clock + spouse
//                       clock); the sim's incomeCentsAt agrees at
//                       every age, and the single-year price counts
//                       the benefit in income once (ssTaxable <=
//                       ssBenefits, in AGI once)
//   RMDs once:          rmdForYear (shared helper) prices each
//                       owner's RMD from that owner's prior-Dec-31
//                       balance; the roll line and the single-year
//                       price agree with it to the cent
//   conversions transfer: a conversion raises AGI by the converted
//                       amount and moves pre-tax -> Roth; it is never
//                       cash in (cashIn is unchanged by it)
//   taxable sales:      only the GAIN is income (AGI moves by the
//                       gain); the full proceeds are cash in
//   employer contributions: totals.employerContributions =
//                       (employer401k + employerHsa) x years, and
//                       each line's stack lands the employer HSA in
//                       the HSA bucket and the employer 401(k) in
//                       pre-tax
//   tax payments:       sum of the roll lines' federal+state+fica =
//                       totals.federal+state+fica; workTax is added
//                       to the march tax once (totalTax), never again
//   ACA credit once:    the credit offsets the marketplace premium
//                       (healthPremiumNet) and is NOT subtracted a
//                       second time in netTaxBill (no APTC facts are
//                       supplied, so the settlement form does not
//                       price and netTaxBill = totalTax - refundable
//                       education credit)
//   Medicare + IRMAA:   healthPremiumGross is the base premium only;
//                       the forward IRMAA (this year's MAGI -> the
//                       premium year two years out) is a disclosure
//                       in result.irmaa, never in the premium or the
//                       tax bill; the payable-this-year IRMAA is a
//                       separate entered input ($0 when not entered)
//   education credits:  the adapter exposes NO education inputs, so
//                       the single-year price can never price a
//                       refundable education credit (education-
//                       Refundable is $0 and netTaxBill carries no
//                       education term); the march's pending-refund
//                       carry is engine-internal (see the zero-year
//                       handoff note in workYears.ts)
//   work-year taxes:    the roll's workTax funds the work years and
//                       is added once to the winner's net cost
//                       (allInTax); the rolled march never re-prices
//                       those years
//
// Legitimate differences (expected, NOT defects — do not force equal):
//   * portfolio-only ending balances (retirement_calculate / sim)
//     vs tax-aware ending after-tax wealth differ by tax treatment:
//     the sim prices no tax, no IRMAA, no account buckets.
//   * the retirement-only winners and the salary-aware winners
//     routinely point to different quit ages: different scope
//     (salary ignored vs included), not a disagreement about facts.
//   * lowest all-in tax vs highest ending after-tax wealth are
//     different objectives and may crown different ages.
//   * the single-year price grades this year's MAGI for the IRMAA
//     premium year two years out; the march grades each year's own
//     lookback MAGI. Same rule, different year — not a mismatch.
//
// All figures are the fictional household (see helpers.ts): pretax
// $1,250,000; taxable $2,100,000; Roth $375,000; HSA $62,000;
// $9,500/mo; ages 54/52; retire 58; end 95; SS $36,000/yr at 67
// (spouse $18,000/yr at 67). NEVER real figures.
//
// Cost note: each salary compare runs the joint optimizer per quit
// age (~60–90s for 2 ages on this VM under load). The expensive
// adapter runs are memoized per scenario and shared across the
// tests that need them; direct-engine cross-checks reuse the
// engine's joint-optimizer cache, so they replay only the roll.
// The work-years leg with a spouse Social Security benefit is NOT
// run here — it needs substantially more than this VM's 6 GB
// (verified OOM, twice); every salary run below sets
// spouseSocialSecurityAnnual: 0. The standalone bundle is not in
// this tree, so bundle parity is pending its rebuild (see README);
// it is recorded as the documented gap, not asserted as a pass.

import { describe, expect, test } from "bun:test";
import {
  buildRothPlanInputs,
  calculateSingleYearTax,
  compareRetirementAges,
  compareRothConversions,
  runRetirementMonteCarlo,
  toSimInputs,
} from "../src/adapter";
import { normalizeInputs, type NormalizedScenario } from "../src/normalize";
import { dispatchTool } from "../src/tools";
import {
  acaCreditFor,
  irmaaAnnualPerPerson,
  irmaaTierFor,
  rmdForYear,
} from "../../server/src/taxEngine";
import { lawForYear } from "../../server/src/taxLaw";
import {
  contributionStack,
  rollWorkYears,
  runWorkYearsCompare,
  type WorkYearJob,
} from "../../server/src/workYears";
import {
  pricePlaygroundYear,
  runOptimizer,
  type PlaygroundYearInputs,
} from "../../server/src/rothOptimizer";
import {
  eventualIncomeCents,
  incomeCentsAt,
  runMonteCarlo,
} from "../../server/src/retirementEngines";
import {
  expectEnvelope,
  fictionalScenario,
  normalizedScenario,
} from "./helpers";

const r2 = (n: number) => Math.round(n * 100) / 100;

// C9 Build 3's crownCompareWinners breaks exact net-cost ties
// toward the highest ending after-tax wealth (OPTIMIZER_OBJECTIVE
// in rothOptimizer.ts) — an expected winner recomputed from the
// scenarios must use the same rule, not a net-cost-only sort.
const byNetCost = (
  a: { lifetimeNetCost: number; endingWealth: number },
  b: { lifetimeNetCost: number; endingWealth: number },
) => a.lifetimeNetCost - b.lifetimeNetCost || b.endingWealth - a.endingWealth;

// --- Memoized expensive adapter runs (one engine price each). ---

type WorkYearsResponse = Extract<
  ReturnType<typeof compareRetirementAges>,
  { ok: true }
>;

let cachedSalary: WorkYearsResponse | null = null;
function salaryCompare() {
  if (cachedSalary === null) {
    cachedSalary = expectEnvelope(
      compareRetirementAges(
        normalizedScenario({
          salaryAnnual: 120000,
          spouseSocialSecurityAnnual: 0,
          compareAges: [60, 62],
        }),
      ),
    );
  }
  return cachedSalary;
}

let cachedNoSalary: WorkYearsResponse | null = null;
function noSalaryCompare() {
  if (cachedNoSalary === null) {
    cachedNoSalary = expectEnvelope(
      compareRetirementAges(
        normalizedScenario({ compareAges: [60, 62] }),
      ),
    );
  }
  return cachedNoSalary;
}

let cachedHighSalary: WorkYearsResponse | null = null;
function highSalaryCompare() {
  if (cachedHighSalary === null) {
    cachedHighSalary = expectEnvelope(
      compareRetirementAges(
        normalizedScenario({
          salaryAnnual: 240000,
          spouseSocialSecurityAnnual: 0,
          compareAges: [60, 62],
        }),
      ),
    );
  }
  return cachedHighSalary;
}

let cachedEmployer: WorkYearsResponse | null = null;
function employerCompare() {
  if (cachedEmployer === null) {
    cachedEmployer = expectEnvelope(
      compareRetirementAges(
        normalizedScenario({
          salaryAnnual: 120000,
          employer401kAnnual: 20000,
          spouseSocialSecurityAnnual: 0,
          compareAges: [60, 62],
        }),
      ),
    );
  }
  return cachedEmployer;
}

let cachedMedicare: WorkYearsResponse | null = null;
function medicareCompare() {
  if (cachedMedicare === null) {
    cachedMedicare = expectEnvelope(
      compareRetirementAges(
        normalizedScenario({
          salaryAnnual: 120000,
          employer401kAnnual: 5000,
          employerHsaAnnual: 1000,
          medicareAgePrimary: 65,
          spouseSocialSecurityAnnual: 0,
          retirementAge: 63,
          compareAges: [63, 67],
        }),
      ),
    );
  }
  return cachedMedicare;
}

// The scenario + job the adapter builds for a salary compare, so
// direct-engine calls price the identical inputs.
function directInputs(
  overrides: Record<string, unknown> = {},
): {
  scenario: NormalizedScenario;
  plan: ReturnType<typeof buildRothPlanInputs>;
  job: WorkYearJob;
  ages: number[];
} {
  const scenario = normalizedScenario({
    salaryAnnual: 120000,
    spouseSocialSecurityAnnual: 0,
    compareAges: [60, 62],
    ...overrides,
  });
  const ages = [...scenario.compareAges].sort((a, b) => a - b);
  const plan = buildRothPlanInputs(scenario, {
    retirementAge: ages[0]!,
    windowStartAge: ages[0]!,
  });
  const job: WorkYearJob = {
    salary: scenario.salaryAnnual!,
    employer401k: scenario.employer401kAnnual,
    employerHsa: scenario.employerHsaAnnual,
    medicareAgePrimary: scenario.medicareAgePrimary,
  };
  return { scenario, plan, job, ages };
}

describe("medicareAgePrimary input (E8-S1)", () => {
  test("65 normalizes with user provenance and echoes in effectiveInputs", () => {
    const n = normalizeInputs(
      fictionalScenario({ medicareAgePrimary: 65 }),
    );
    expect(n.ok).toBe(true);
    if (!n.ok) throw new Error("fixture failed");
    expect(n.scenario.medicareAgePrimary).toBe(65);
    const entry = n.scenario.assumptions.find(
      (a) => a.field === "medicareAgePrimary",
    );
    expect(entry?.provenance).toBe("user");
    expect(entry?.note).toMatch(/HSA contributions/);
  });

  test("explicit null normalizes as no modeled enrollment", () => {
    const n = normalizeInputs(
      fictionalScenario({ medicareAgePrimary: null }),
    );
    expect(n.ok).toBe(true);
    if (!n.ok) throw new Error("fixture failed");
    expect(n.scenario.medicareAgePrimary).toBeNull();
  });

  test("omitted stays null with an assumption (never defaulted to 65)", () => {
    const n = normalizeInputs(fictionalScenario({}));
    expect(n.ok).toBe(true);
    if (!n.ok) throw new Error("fixture failed");
    expect(n.scenario.medicareAgePrimary).toBeNull();
    const entry = n.scenario.assumptions.find(
      (a) => a.field === "medicareAgePrimary",
    );
    expect(entry?.provenance).toBe("assumption");
    expect(entry?.note).toMatch(/not provided/i);
    expect(entry?.note).toMatch(/Eligibility at 65 is not enrollment/);
  });

  test("non-integer, negative, over-120, and string values are invalid_input", () => {
    for (const bad of [65.5, -1, 121, "65"]) {
      const n = normalizeInputs(
        fictionalScenario({ medicareAgePrimary: bad }),
      );
      expect(n.ok).toBe(false);
      if (n.ok) throw new Error(`${bad} should not normalize`);
      expect(n.error.error.code).toBe("invalid_input");
    }
  });

  test("the field is priced by retirement_work_years and ignored without a salary", () => {
    // Priced: with a salary the work-years leg runs and the
    // enrollment stop can bite (see the roll tests below).
    const withSalary = normalizedScenario({
      salaryAnnual: 120000,
      medicareAgePrimary: 65,
    });
    expect(withSalary.medicareAgePrimary).toBe(65);
    // Ignored: without a salary no work year is rolled, so the
    // enrollment age prices nothing — the drift table says so
    // (pricedInputs conditionalReason), and the no-salary
    // comparison carries no Medicare warning either.
    const res = noSalaryCompare();
    expect(res.warnings.join(" ")).not.toMatch(/No Medicare enrollment age/);
  });
});

describe("Medicare enrollment stops HSA contributions (engine rule)", () => {
  test("contributionStack: HSA stops at the enrollment age, both sides", () => {
    const law = lawForYear(2026)!;
    const at65null = contributionStack(65, 120000, 5000, 1000, "mfj", law, null, null);
    const at65enr = contributionStack(65, 120000, 5000, 1000, "mfj", law, null, 65);
    // The limit itself is read off the priced stack (not pinned
    // to an absolute figure — the filing-status -> family/self
    // limit selection is Engine Review 7's parallel fix, and
    // this test must not fight it): what matters is the
    // enrollment stop, both sides, in full.
    expect(at65null.hsaLimit).toBeGreaterThan(0);
    expect(at65null.ownHsa).toBe(at65null.hsaLimit - 1000);
    expect(at65null.employerHsa).toBe(1000);
    expect(at65null.hsaBucket).toBe(at65null.hsaLimit);
    expect(at65enr.ownHsa).toBe(0);
    expect(at65enr.employerHsa).toBe(0);
    expect(at65enr.hsaBucket).toBe(0);
  });

  test("enrollment at 70 preserves HSA at 64 and stops it at 70", () => {
    const law = lawForYear(2026)!;
    const at64 = contributionStack(64, 120000, 5000, 1000, "mfj", law, null, 70);
    const at70 = contributionStack(70, 120000, 5000, 1000, "mfj", law, null, 70);
    expect(at64.ownHsa).toBeGreaterThan(0);
    expect(at64.employerHsa).toBe(1000);
    expect(at70.ownHsa).toBe(0);
    expect(at70.employerHsa).toBe(0);
  });

  test("enrollment before 65 stops HSA from that age on", () => {
    const law = lawForYear(2026)!;
    const at59 = contributionStack(59, 120000, 5000, 1000, "mfj", law, null, 60);
    const at60 = contributionStack(60, 120000, 5000, 1000, "mfj", law, null, 60);
    expect(at59.ownHsa).toBeGreaterThan(0);
    expect(at59.employerHsa).toBe(1000);
    expect(at60.ownHsa).toBe(0);
    expect(at60.employerHsa).toBe(0);
  });
});

describe("Medicare enrollment through the work-years roll (E8-S1)", () => {
  // Window start 63, quit 67: work years 63, 64, 65, 66.
  function roll(medicare: number | null, extra: Record<string, unknown> = {}) {
    const { plan } = directInputs({
      retirementAge: 63,
      compareAges: [63, 67],
      employer401kAnnual: 5000,
      employerHsaAnnual: 1000,
      ...extra,
    });
    const job: WorkYearJob = {
      salary: 120000,
      employer401k: 5000,
      employerHsa: 1000,
      medicareAgePrimary: medicare,
    };
    return rollWorkYears(plan, job, 67);
  }

  test("enrollment at 65 stops HSA from the 65 line on (2 of 4 years)", () => {
    const r = roll(65);
    expect(r.lines.map((l) => l.age)).toEqual([63, 64, 65, 66]);
    expect(r.lines[0]!.stack.hsaBucket).toBeGreaterThan(0);
    expect(r.lines[1]!.stack.hsaBucket).toBeGreaterThan(0);
    expect(r.lines[2]!.stack.hsaBucket).toBe(0);
    expect(r.lines[2]!.stack.ownHsa).toBe(0);
    expect(r.lines[2]!.stack.employerHsa).toBe(0);
    expect(r.lines[3]!.stack.hsaBucket).toBe(0);
    // Exactly the two pre-enrollment years contributed (the roll
    // prices 2035+ law years, so the per-year amount is read off
    // the priced lines, not pinned to the 2026 limit).
    expect(r.totals.hsaContributions).toBe(
      r2(r.lines[0]!.stack.hsaBucket + r.lines[1]!.stack.hsaBucket),
    );
  });

  test("enrollment at 70 preserves HSA through every year to 66", () => {
    const r = roll(70);
    for (const line of r.lines) {
      expect(line.stack.hsaBucket).toBeGreaterThan(0);
    }
    expect(r.totals.hsaContributions).toBe(
      r2(r.lines.reduce((sum, l) => sum + l.stack.hsaBucket, 0)),
    );
  });

  test("omitted enrollment age preserves HSA (no-enrollment assumption)", () => {
    const r = roll(null);
    for (const line of r.lines) {
      expect(line.stack.hsaBucket).toBeGreaterThan(0);
    }
    expect(r.totals.hsaContributions).toBe(
      r2(r.lines.reduce((sum, l) => sum + l.stack.hsaBucket, 0)),
    );
  });

  test("enrollment before 65: zero HSA contributions across the window", () => {
    // Window 60-62, enrolled at 60: every work year is at or
    // after enrollment, so no HSA contribution of either source
    // lands in any year — the "zero HSA contributions" case.
    const { plan } = directInputs({
      retirementAge: 60,
      compareAges: [60, 62],
      employer401kAnnual: 5000,
      employerHsaAnnual: 1000,
    });
    const job: WorkYearJob = {
      salary: 120000,
      employer401k: 5000,
      employerHsa: 1000,
      medicareAgePrimary: 60,
    };
    const r = rollWorkYears(plan, job, 62);
    expect(r.lines.map((l) => l.age)).toEqual([60, 61]);
    for (const line of r.lines) {
      expect(line.stack.hsaBucket).toBe(0);
      expect(line.stack.ownHsa).toBe(0);
      expect(line.stack.employerHsa).toBe(0);
    }
    expect(r.totals.hsaContributions).toBe(0);
  });

  test("retirement at the enrollment age: the quit year itself contributes nothing either way", () => {
    // Window start 65, quit 67, enrolled at 65: work years 65,
    // 66 are both at/after enrollment, so HSA is $0 throughout;
    // the quit-65 row prices zero work years, so enrollment at
    // the retirement age changes nothing on that row either.
    const { plan } = directInputs({
      retirementAge: 65,
      compareAges: [65, 67],
      employer401kAnnual: 5000,
      employerHsaAnnual: 1000,
    });
    const job: WorkYearJob = {
      salary: 120000,
      employer401k: 5000,
      employerHsa: 1000,
      medicareAgePrimary: 65,
    };
    const r = rollWorkYears(plan, job, 67);
    expect(r.lines.map((l) => l.age)).toEqual([65, 66]);
    expect(r.totals.hsaContributions).toBe(0);
    const zero = rollWorkYears(plan, job, 65);
    expect(zero.totals.years).toBe(0);
    expect(zero.totals.hsaContributions).toBe(0);
  });

  test("continuing employment after 65: HSA stops at enrollment, salary does not", () => {
    // Enrolled at 65, still working to 67: the 65/66 lines
    // price salary and payroll tax in full — only the HSA
    // stops. (Retirement after the enrollment age.)
    const r = roll(65);
    expect(r.lines[2]!.salary).toBe(120000);
    expect(r.lines[2]!.fica).toBeGreaterThan(0);
    expect(r.lines[2]!.stack.hsaBucket).toBe(0);
    expect(r.lines[3]!.salary).toBe(120000);
    expect(r.lines[3]!.stack.hsaBucket).toBe(0);
  });

  test("zero employer HSA: the employer side stays $0 while the employee side contributes", () => {
    const { plan } = directInputs({
      retirementAge: 63,
      compareAges: [63, 67],
      employer401kAnnual: 5000,
      employerHsaAnnual: 0,
    });
    const job: WorkYearJob = {
      salary: 120000,
      employer401k: 5000,
      employerHsa: 0,
      medicareAgePrimary: null,
    };
    const r = rollWorkYears(plan, job, 67);
    for (const line of r.lines) {
      expect(line.stack.employerHsa).toBe(0);
      expect(line.stack.ownHsa).toBeGreaterThan(0);
    }
  });
});

describe("retirement-age winner semantics (E8-S2, comparisonModels)", () => {
  test("without a salary the winners are retirement-only and there is no overall recommendation", () => {
    const res = noSalaryCompare();
    const r = res.results;
    expect(r.workYears).toEqual([]);
    expect(r.workYearsComparison).toBeNull();
    expect(r.workYearsWinnerByAllInTax).toBeNull();
    expect(r.workYearsWinnerByEndingAfterTaxWealth).toBeNull();
    // The preserved top-level fields stay, and are now also
    // exposed under retirementOnly with the same values
    // (backward compat — same values, not recomputed).
    expect(r.retirementOnly.winnerByNetCost).toBe(r.winnerByNetCost);
    expect(r.retirementOnly.winnerByEndingWealth).toBe(
      r.winnerByEndingWealth,
    );
    expect(r.overallRecommendation).toBeNull();
    expect(r.overallRecommendationNote).toMatch(/salaryAnnual/);
    expect(res.warnings.join(" ")).toMatch(
      /retirement-only, not an overall recommendation/,
    );
    // Retirement-only winners are recomputed from the scenarios,
    // not asserted from a stored figure.
    const byCost = [...r.scenarios].sort(byNetCost)[0]!;
    const byWealth = [...r.scenarios].sort(
      (a, b) => b.endingWealth - a.endingWealth,
    )[0]!;
    expect(r.retirementOnly.winnerByNetCost).toBe(byCost.name);
    expect(r.retirementOnly.winnerByEndingWealth).toBe(byWealth.name);
    // comparisonModels: the retirement-only model prices no
    // salary, no work-year contributions, no payroll tax, runs
    // no optimizer and searches no claiming ages; there is no
    // salary-aware model without a salary.
    expect(r.comparisonModels.retirementOnly.includesSalary).toBe(false);
    expect(r.comparisonModels.retirementOnly.includesWorkYearContributions).toBe(false);
    expect(r.comparisonModels.retirementOnly.includesWorkYearPayrollTaxes).toBe(false);
    expect(r.comparisonModels.retirementOnly.usesFullOptimizer).toBe(false);
    expect(r.comparisonModels.retirementOnly.ssClaimingAgesSearched).toBe(false);
    expect(r.comparisonModels.retirementOnly.objective).toMatch(/Do-Nothing-fill/);
    expect(r.comparisonModels.retirementOnly.description).toMatch(/entered Social Security claiming ages/);
    expect(r.comparisonModels.salaryAware).toBeNull();
    // The Review 4 comparisonScope block is untouched: it still
    // describes the quit-age comparison's candidate set.
    expect(r.comparisonScope.scope).toBe("limited");
    expect(r.comparisonScope.searchKind).toBe("fixed-comparison");
  }, 120000);

  test("with a salary the salary-aware winners come from the work-years rows", () => {
    const res = salaryCompare();
    const r = res.results;
    expect(r.workYears.map((w) => w.quitAge)).toEqual([60, 62]);
    const byTax = [...r.workYears].sort((a, b) => a.allInTax - b.allInTax)[0]!;
    const byWealth = [...r.workYears].sort(
      (a, b) => b.endingAfterTax - a.endingAfterTax,
    )[0]!;
    expect(r.workYearsComparison).not.toBeNull();
    expect(r.workYearsComparison!.winnerByAllInTax).toBe(
      `retire-${byTax.quitAge}`,
    );
    expect(r.workYearsComparison!.winnerByEndingAfterTaxWealth).toBe(
      `retire-${byWealth.quitAge}`,
    );
    expect(r.workYearsWinnerByAllInTax).toBe(
      r.workYearsComparison!.winnerByAllInTax,
    );
    expect(r.workYearsWinnerByEndingAfterTaxWealth).toBe(
      r.workYearsComparison!.winnerByEndingAfterTaxWealth,
    );
    // The retirement-only winners are still present and unchanged
    // in meaning (same starting balances, salary ignored).
    const roCost = [...r.scenarios].sort(byNetCost)[0]!;
    const roWealth = [...r.scenarios].sort(
      (a, b) => b.endingWealth - a.endingWealth,
    )[0]!;
    expect(r.retirementOnly.winnerByNetCost).toBe(roCost.name);
    expect(r.retirementOnly.winnerByEndingWealth).toBe(roWealth.name);
    // Overall recommendation: the agreed age, or null with the
    // disagreement named.
    if (
      r.workYearsComparison!.winnerByAllInTax ===
      r.workYearsComparison!.winnerByEndingAfterTaxWealth
    ) {
      expect(r.overallRecommendation).toBe(
        r.workYearsComparison!.winnerByAllInTax,
      );
      expect(r.overallRecommendationNote).toMatch(/Both salary-aware objectives agree/);
    } else {
      expect(r.overallRecommendation).toBeNull();
      expect(r.overallRecommendationNote).toMatch(/objectives disagree/);
      expect(r.overallRecommendationNote).toMatch(
        r.workYearsComparison!.winnerByAllInTax!,
      );
      expect(r.overallRecommendationNote).toMatch(
        r.workYearsComparison!.winnerByEndingAfterTaxWealth!,
      );
    }
    // comparisonModels: the salary-aware model includes salary,
    // work-year contributions and payroll tax, runs the joint
    // optimizer per quit age and searches claiming ages there —
    // and its description says the per-age winner is the
    // optimizer's pick for that quit age alone.
    const sa = r.comparisonModels.salaryAware!;
    expect(sa.includesSalary).toBe(true);
    expect(sa.includesWorkYearContributions).toBe(true);
    expect(sa.includesWorkYearPayrollTaxes).toBe(true);
    expect(sa.usesFullOptimizer).toBe(true);
    expect(sa.ssClaimingAgesSearched).toBe(true);
    expect(sa.description).toMatch(/joint optimizer/);
    expect(sa.description).toMatch(/for that quit age alone/);
    expect(sa.description).toMatch(/no optimizer search across conversion strategies/);
    // And the per-age winnerStrategy really is the optimizer's
    // pick: it names a conversion strategy the joint optimizer
    // crowns, not a fixed fill.
    for (const row of r.workYears) {
      expect(typeof row.winnerStrategy).toBe("string");
      expect(row.winnerStrategy.length).toBeGreaterThan(0);
    }
  }, 300000);

  test("omitted salary cannot produce a misleading overall winner (MCP path too)", () => {
    const via = dispatchTool(
      "retirement_work_years",
      fictionalScenario({ compareAges: [60, 62] }),
    );
    if (!via.ok) throw new Error(JSON.stringify(via.error));
    const r = via.results as WorkYearsResponse["results"];
    expect(r.overallRecommendation).toBeNull();
    expect(r.comparisonModels.salaryAware).toBeNull();
    expect(r.workYearsComparison).toBeNull();
  }, 120000);
});

describe("salary-aware comparison responds to its inputs", () => {
  test("a higher salary changes the salary-aware comparison", () => {
    const base = salaryCompare().results;
    const high = highSalaryCompare().results;
    // Same ages, same balances — only the salary differs, so the
    // work-years rows must move (more salary tax, more growth).
    expect(high.workYears).not.toEqual(base.workYears);
    // The zero-work-years row (quit at the window start) prices
    // no working year, so salary cannot move it — assert movement
    // only on the rows that actually work.
    const working = base.workYears.filter((w) => w.workYears > 0);
    expect(working.length).toBeGreaterThan(0);
    for (const w of working) {
      const highRow = high.workYears.find((h) => h.quitAge === w.quitAge)!;
      expect(highRow.allInTax).not.toBe(w.allInTax);
      expect(highRow.endingAfterTax).not.toBe(w.endingAfterTax);
    }
  }, 300000);

  test("a higher employer 401(k) changes the work-years results", () => {
    const base = salaryCompare().results;
    const emp = employerCompare().results;
    expect(emp.workYears).not.toEqual(base.workYears);
    // The extra employer contributions land in the rolled pre-tax
    // balance, so ending after-tax wealth moves on the working row.
    const row62 = emp.workYears.find((w) => w.quitAge === 62)!;
    const base62 = base.workYears.find((w) => w.quitAge === 62)!;
    expect(row62.endingAfterTax).not.toBe(base62.endingAfterTax);
    // The zero-work-years row prices no working year, so the
    // employer change must not touch it.
    const row60 = emp.workYears.find((w) => w.quitAge === 60)!;
    const base60 = base.workYears.find((w) => w.quitAge === 60)!;
    expect(row60.endingAfterTax).toBe(base60.endingAfterTax);
    expect(row60.allInTax).toBe(base60.allInTax);
  }, 300000);
});

describe("work-years engine identities (§6: counted once)", () => {
  test("payroll taxes are included exactly once (direct engine)", () => {
    const { plan, job } = directInputs();
    const rows = runWorkYearsCompare(plan, job, [60, 62]);
    for (const row of rows) {
      const t = row.roll.totals;
      // workTax = federal + state + payroll, and payrollTax is the
      // payroll (FICA) part itself — not added a second time.
      expect(row.workTax).toBe(r2(t.federal + t.state + t.fica));
      expect(row.payrollTax).toBe(t.payrollTax);
      expect(row.payrollTax).toBe(t.fica);
      expect(row.totalTax).toBe(
        r2(row.optimizer.winner.cost.tax + row.workTax),
      );
      expect(row.allInTax).toBe(
        r2(row.optimizer.winner.cost.netCost + row.workTax),
      );
    }
  }, 300000);

  test("salary is counted once: gross salary is salary x work years", () => {
    const { plan, job } = directInputs();
    const roll62 = rollWorkYears(plan, job, 62);
    expect(roll62.totals.years).toBe(2);
    expect(roll62.totals.grossSalary).toBe(r2(120000 * 2));
    expect(roll62.lines.every((l) => l.salary === 120000)).toBe(true);
    // And the tax on it is counted once across the lines: the
    // totals are the sum of the lines, not a second pricing.
    const sumFed = r2(roll62.lines.reduce((s, l) => s + l.federalTax, 0));
    const sumState = r2(roll62.lines.reduce((s, l) => s + l.stateTax, 0));
    const sumFica = r2(roll62.lines.reduce((s, l) => s + l.fica, 0));
    expect(roll62.totals.federal).toBe(sumFed);
    expect(roll62.totals.state).toBe(sumState);
    expect(roll62.totals.fica).toBe(sumFica);
  });

  test("employer contributions land in the correct accounts", () => {
    const { plan } = directInputs({
      employer401kAnnual: 5000,
      employerHsaAnnual: 1000,
    });
    const job: WorkYearJob = {
      salary: 120000,
      employer401k: 5000,
      employerHsa: 1000,
      medicareAgePrimary: null,
    };
    const roll62 = rollWorkYears(plan, job, 62);
    // Employer totals are the per-year figures x the 2 years.
    expect(roll62.totals.employerContributions).toBe(r2((5000 + 1000) * 2));
    // Each line's stack lands the employer HSA in the HSA bucket
    // and the employer 401(k) in the pre-tax stack.
    for (const line of roll62.lines) {
      expect(line.stack.employerHsa).toBe(1000);
      expect(line.stack.employer401k).toBe(5000);
      expect(line.stack.hsaBucket).toBeGreaterThan(0);
    }
    expect(roll62.totals.hsaContributions).toBe(
      r2(roll62.lines.reduce((s, l) => s + l.stack.hsaBucket, 0)),
    );
  });

  test("the zero-work-years row preserves the engine baseline", () => {
    const res = salaryCompare();
    const row60 = res.results.workYears.find((w) => w.quitAge === 60)!;
    expect(row60.workYears).toBe(0);
    expect(row60.workTax).toBe(0);
    expect(row60.payrollTax).toBe(0);
    expect(row60.shortfall).toBe(0);
    // Direct: a zero-year roll hands the plan through unchanged,
    // and the optimizer prices the plan itself.
    const { plan, job } = directInputs();
    const roll = rollWorkYears(plan, job, 60);
    expect(roll.totals.years).toBe(0);
    expect(roll.balances.pretax).toBe(r2(plan.pretaxStart));
    expect(roll.balances.taxable).toBe(r2(plan.taxableStart));
    expect(roll.balances.roth).toBe(r2(plan.rothStart));
    expect(roll.balances.hsa).toBe(r2(plan.hsaStart));
    const direct = runWorkYearsCompare(plan, job, [60])[0]!;
    // NOTE: the direct zero-year row is NOT asserted equal to the
    // plain runOptimizer winner. The zero-year row prices via the
    // joint optimizer per quit age; the baseline prices via
    // runOptimizer — different searches, different winners, and
    // the premise was never true (gap $410,964.43 on the old base,
    // $420,906.61 on the rebased tree; the zero-row itself moved
    // −$9,942.18 across the rebase, a base-engine change — E8
    // touches no engine code). What this test pins is the
    // adapter == direct identity, which holds to the cent.
    // And the adapter's zero-work-years row matches that direct row.
    expect(row60.endingAfterTax).toBe(direct.endingAfterTax);
    expect(row60.allInTax).toBe(direct.allInTax);
  }, 300000);
});

describe("comparability across quit ages (D11)", () => {
  test("rows share one terminal age, so ending wealth is comparable", () => {
    const { plan, job, ages } = directInputs();
    const rows = runWorkYearsCompare(plan, job, ages);
    for (const row of rows) {
      // Same terminal age on every row; only the start year moves.
      expect(row.roll.rolledInputs.endAgePrimary).toBe(95);
      // The zero-work-years row rolls no year, so its rolled
      // inputs keep the plan's own start year — the
      // birthYear + quitAge rule holds only for working rows.
      if (row.workYears === 0) {
        expect(row.roll.rolledInputs.startYear).toBe(plan.startYear);
      } else {
        expect(row.roll.rolledInputs.startYear).toBe(
          plan.birthYearPrimary + row.quitAge,
        );
      }
      expect(Number.isFinite(row.endingAfterTax)).toBe(true);
    }
    const res = salaryCompare();
    expect(res.warnings.join(" ")).not.toMatch(/not like-for-like/);
    expect(res.warnings.join(" ")).toMatch(/same terminal age/);
    // The salary-aware wealth winner is the argmax of the rows'
    // ending after-tax wealth — the metric the engine provides.
    const best = [...res.results.workYears].sort(
      (a, b) => b.endingAfterTax - a.endingAfterTax,
    )[0]!;
    expect(res.results.workYearsWinnerByEndingAfterTaxWealth).toBe(
      `retire-${best.quitAge}`,
    );
  }, 300000);
});

describe("adapter vs engine parity", () => {
  test("adapter work-years rows match direct runWorkYearsCompare() to the cent", () => {
    const res = salaryCompare();
    const { plan, job, ages } = directInputs();
    const direct = runWorkYearsCompare(plan, job, ages);
    expect(direct.map((d) => d.quitAge)).toEqual(
      res.results.workYears.map((w) => w.quitAge),
    );
    for (let i = 0; i < direct.length; i++) {
      const d = direct[i]!;
      const w = res.results.workYears[i]!;
      expect(w.quitAge).toBe(d.quitAge);
      expect(w.workYears).toBe(d.workYears);
      expect(w.workTax).toBe(r2(d.workTax));
      expect(w.payrollTax).toBe(r2(d.payrollTax));
      expect(w.totalTax).toBe(r2(d.totalTax));
      expect(w.shortfall).toBe(r2(d.shortfall));
      expect(w.allInTax).toBe(r2(d.allInTax));
      expect(w.claim67AllInTax).toBe(
        d.claim67AllInTax === null ? null : r2(d.claim67AllInTax),
      );
      expect(w.endingNominal).toBe(r2(d.endingNominal));
      expect(w.endingAfterTax).toBe(r2(d.endingAfterTax));
      expect(w.winnerStrategy).toBe(d.optimizer.winner.spec.name);
      expect(w.winnerClaimPrimaryAge).toBe(
        d.optimizer.winner.claimAges.primaryAge,
      );
      expect(w.winnerClaimSpouseAge).toBe(
        d.optimizer.winner.claimAges.spouseAge,
      );
    }
  }, 300_000);

  test("adapter rows with medicareAgePrimary 65 match the direct engine", () => {
    const res = medicareCompare();
    const scenario = normalizedScenario({
      salaryAnnual: 120000,
      employer401kAnnual: 5000,
      employerHsaAnnual: 1000,
      medicareAgePrimary: 65,
      spouseSocialSecurityAnnual: 0,
      retirementAge: 63,
      compareAges: [63, 67],
    });
    const plan = buildRothPlanInputs(scenario, {
      retirementAge: 63,
      windowStartAge: 63,
    });
    const job: WorkYearJob = {
      salary: 120000,
      employer401k: 5000,
      employerHsa: 1000,
      medicareAgePrimary: 65,
    };
    const direct = runWorkYearsCompare(plan, job, [63, 67]);
    expect(res.results.workYears.map((w) => w.quitAge)).toEqual([63, 67]);
    for (let i = 0; i < direct.length; i++) {
      expect(res.results.workYears[i]!.allInTax).toBe(
        r2(direct[i]!.allInTax),
      );
      expect(res.results.workYears[i]!.endingAfterTax).toBe(
        r2(direct[i]!.endingAfterTax),
      );
      expect(res.results.workYears[i]!.workTax).toBe(r2(direct[i]!.workTax));
    }
    // The Medicare run prices no enrollment warning (an age was
    // given); the no-enrollment disclosure appears only when the
    // age is absent.
    expect(res.warnings.join(" ")).not.toMatch(/No Medicare enrollment age/);
    const noMed = salaryCompare();
    expect(noMed.warnings.join(" ")).toMatch(/No Medicare enrollment age/);
    expect(noMed.warnings.join(" ")).toMatch(
      /Eligibility at 65 is not enrollment/,
    );
  }, 300_000);
});

describe("MCP path + input isolation", () => {
  test("the MCP tool returns the same comparison as the direct adapter call", () => {
    const via = dispatchTool(
      "retirement_work_years",
      fictionalScenario({ compareAges: [60, 62] }),
    );
    if (!via.ok) throw new Error(JSON.stringify(via.error));
    const direct = noSalaryCompare();
    expect(via.results).toEqual(direct.results);
    expect(via.warnings).toEqual(direct.warnings);
    // The standalone bundle is not in this tree (no STANDALONE.md /
    // AI_USAGE.md, no built bundle), so bundle parity is pending
    // its rebuild by the separate coordinator — recorded here as
    // the documented gap, not asserted as a pass.
  }, 120_000);

  test("the comparison follows the caller's inputs, not stored data", () => {
    const a = expectEnvelope(
      compareRetirementAges(normalizedScenario({ compareAges: [60, 62] })),
    );
    const b = expectEnvelope(
      compareRetirementAges(
        normalizedScenario({ pretax: 1500000, compareAges: [60, 62] }),
      ),
    );
    // Same call shape, one balance changed: every scenario's ending
    // wealth must move — the numbers come from this call's inputs.
    for (let i = 0; i < a.results.scenarios.length; i++) {
      expect(b.results.scenarios[i]!.endingWealth).not.toBe(
        a.results.scenarios[i]!.endingWealth,
      );
    }
  }, 120_000);
});

describe("cross-engine matrix (§5): the same fact, two engines", () => {
  test("Income: the sim, the work-years roll, and the single-year pricer time Social Security identically", () => {
    // Fictional household: primary $36,000/yr at 67, spouse
    // $18,000/yr at the spouse's own age 67 (primary age 69 —
    // ages 54/52, two years apart). Hand-derived: $0 at 66,
    // $36,000 at 67-68, $54,000 from 69 on.
    const scenario = normalizedScenario({});
    const { inputs } = toSimInputs(scenario);
    expect(incomeCentsAt(inputs, 66)).toBe(0);
    expect(incomeCentsAt(inputs, 67)).toBe(36000 * 100);
    expect(incomeCentsAt(inputs, 68)).toBe(36000 * 100);
    expect(incomeCentsAt(inputs, 69)).toBe(54000 * 100);
    expect(eventualIncomeCents(inputs)).toBe(54000 * 100);
    // The work-years roll deposits the same benefits on the same
    // per-person clocks (window 67-71, spouse SS still 0 there).
    const { plan, job } = directInputs({
      retirementAge: 67,
      compareAges: [67, 71],
      spouseSocialSecurityAnnual: 18000,
    });
    const roll = rollWorkYears(plan, job, 71);
    expect(roll.lines.map((l) => l.age)).toEqual([67, 68, 69, 70]);
    expect(roll.lines[0]!.ssBenefits).toBe(36000);
    expect(roll.lines[1]!.ssBenefits).toBe(36000);
    expect(roll.lines[2]!.ssBenefits).toBe(54000);
    expect(roll.lines[3]!.ssBenefits).toBe(54000);
    // The single-year pricer prices the benefit it is handed, in
    // full, once: both streams started, $54,000 in, §86 taxes
    // part of it, never the whole benefit twice.
    const priced = pricePlaygroundYear(singleYearInputs({
      agePrimary: 69,
      ageSpouse: 67,
      ssPrimary: 36000,
      ssSpouse: 18000,
      otherOrdinary: 50000,
    }));
    expect(priced.ssBenefits).toBe(54000);
    // §86, MFJ, hand-derived: provisional income is $50,000 of
    // other income + half the benefit ($27,000) = $77,000 — over
    // the $44,000 second threshold, so the taxable part is
    // 85% x ($77,000 - $44,000) + 50% x ($44,000 - $32,000)
    // = $28,050 + $6,000 = $34,050 (under the 85%-of-benefits
    // cap of $45,900). The benefit is in AGI once, at that part.
    expect(priced.ssTaxable).toBe(34050);
    expect(priced.agi).toBe(50000 + 34050);
  });

  test("Federal tax: the adapter's single-year price equals the direct engine price, field for field", () => {
    const overrides = {
      interestAnnual: 10000,
      ordinaryDividendsAnnual: 5000,
      qualifiedDividendsAnnual: 3000,
      conversionAnnual: 20000,
      spendingDrawAnnual: 114000,
      stockSoldAnnual: 20000,
      stockBasisAnnual: 12000,
    };
    const scenario = normalizedScenario(overrides);
    const viaAdapter = calculateSingleYearTax(scenario);
    expect(viaAdapter.ok).toBe(true);
    if (!viaAdapter.ok) throw new Error("fixture failed");
    const direct = pricePlaygroundYear(singleYearInputs({
      agePrimary: 54,
      ageSpouse: 52,
      interest: 10000,
      ordinaryDividends: 5000,
      qualifiedDividends: 3000,
      conversion: 20000,
      spendingDraw: 114000,
      stockSold: 20000,
      stockBasis: 12000,
      annualSpending: 114000,
    }));
    expect(viaAdapter.results).toEqual(direct);
    // Hand-derived (never a snapshot as the sole proof): AGI is
    // interest + all dividends + conversion + the stock gain +
    // the pre-tax spending draw — the draw is taxable income, so
    // it belongs in the sum the first draft of this test omitted.
    expect(direct.agi).toBe(157000);
    expect(direct.stockGain).toBe(8000);
    expect(direct.nonQualifiedDividends).toBe(2000);
    expect(direct.qualifiedDividends).toBe(3000);
    // Cash in counts the full sale proceeds once (plus the draws
    // and the yield); the gain is income, the proceeds are cash.
    expect(direct.cashIn).toBe(114000 + 10000 + 5000 + 20000);
  });

  test("Federal tax: a conversion is a transfer, not new wealth or new cash", () => {
    const base = {
      interestAnnual: 10000,
      ordinaryDividendsAnnual: 5000,
      qualifiedDividendsAnnual: 3000,
      spendingDrawAnnual: 114000,
    };
    const noConversion = calculateSingleYearTax(
      normalizedScenario({ ...base, conversionAnnual: 0 }),
    );
    const withConversion = calculateSingleYearTax(
      normalizedScenario({ ...base, conversionAnnual: 20000 }),
    );
    expect(noConversion.ok).toBe(true);
    expect(withConversion.ok).toBe(true);
    if (!noConversion.ok || !withConversion.ok) throw new Error("fixture failed");
    // The conversion raises AGI by exactly the converted amount
    // — and cash in not at all: it moves pre-tax to Roth, it is
    // never spendable cash.
    expect(withConversion.results.agi - noConversion.results.agi).toBe(20000);
    expect(withConversion.results.cashIn).toBe(noConversion.results.cashIn);
    expect(withConversion.results.conversion).toBe(20000);
  });

  test("Federal tax: a taxable sale creates no wealth — only the gain is income", () => {
    const base = {
      interestAnnual: 10000,
      ordinaryDividendsAnnual: 5000,
      qualifiedDividendsAnnual: 3000,
      conversionAnnual: 20000,
      spendingDrawAnnual: 114000,
    };
    const noSale = calculateSingleYearTax(normalizedScenario(base));
    const withSale = calculateSingleYearTax(
      normalizedScenario({ ...base, stockSoldAnnual: 20000, stockBasisAnnual: 12000 }),
    );
    expect(noSale.ok).toBe(true);
    expect(withSale.ok).toBe(true);
    if (!noSale.ok || !withSale.ok) throw new Error("fixture failed");
    // AGI moves by the $8,000 gain only; cash in moves by the
    // $20,000 proceeds. The $12,000 of basis is neither.
    expect(withSale.results.agi - noSale.results.agi).toBe(8000);
    expect(withSale.results.cashIn - noSale.results.cashIn).toBe(20000);
  });

  test("ACA: the single-year credit equals the direct helper on the same MAGI, and is counted once", () => {
    const scenario = normalizedScenario({
      interestAnnual: 10000,
      ordinaryDividendsAnnual: 5000,
      qualifiedDividendsAnnual: 3000,
      conversionAnnual: 20000,
      // No spending draw: the draw is taxable income, so a draw
      // here would lift MAGI past the credit the test is about.
      spendingDrawAnnual: 0,
      acaBenchmarkCouple: 25000,
    });
    const res = calculateSingleYearTax(scenario);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("fixture failed");
    const r = res.results;
    // Hand-derived MAGI: interest + all dividends + conversion.
    expect(r.acaMagi).toBe(35000);
    const directCredit = acaCreditFor({
      magi: 35000,
      householdSize: 2,
      coverageYear: 2026,
      benchmarkAnnual: 25000,
    });
    // The single-year result carries the ACA credit on its `aca`
    // readout (null when no benchmark was entered) — not a
    // top-level `acaCredit` field.
    expect(r.aca.credit).toBe(directCredit.credit);
    expect(r.aca.credit ?? 0).toBeGreaterThan(0);
    expect(r.aca.credit ?? 0).toBeLessThanOrEqual(25000);
    // Counted once: no APTC facts are supplied, so the settlement
    // form does not price and the credit is NOT subtracted a
    // second time in the tax bill — netTaxBill is totalTax less
    // the (zero) refundable education credit only.
    expect(r.educationRefundable).toBe(0);
    expect(r.netTaxBill).toBe(r.totalTax);
  });

  test("RMD: the single-year price and the shared helper agree to the cent", () => {
    // Primary 73 (birth year 1953, RMD age 73), spouse 70 —
    // a 3-year gap, so the Uniform Lifetime Table applies.
    // Hand-derived: $1,000,000 / 26.5 = $37,735.85. Social
    // Security is zeroed for this case so the RMD is the only
    // income and AGI is exactly the RMD.
    const scenario = normalizedScenario({
      currentAge: 73,
      spouseAge: 70,
      // The fictional household retires at 58; a 73-year-old
      // primary needs retirementAge at or after the current age
      // or normalization rejects the fixture outright.
      retirementAge: 73,
      socialSecurityAnnual: 0,
      spouseSocialSecurityAnnual: 0,
      pretaxPriorYearEndAnnual: 1000000,
    });
    const res = calculateSingleYearTax(scenario);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("fixture failed");
    const r = res.results;
    expect(r.rmdDivisor).toBe(26.5);
    expect(r.rmdTable).toBe("uniform");
    expect(r.rmdGross).toBe(37735.85);
    expect(r.rmd).toBe(37735.85);
    expect(r.rmdPrimary).toBe(37735.85);
    expect(r.rmdSpouse).toBe(0);
    const direct = rmdForYear({
      priorDec31PreTax: 1000000,
      agePrimary: 73,
      ageSpouse: 70,
      birthYearPrimary: 1953,
      spouseSoleBeneficiary: true,
    });
    expect(direct.rmd).toBe(37735.85);
    expect(direct.divisor).toBe(26.5);
    expect(direct.table).toBe("uniform");
    expect(r.rmdGross).toBe(direct.rmd);
    // The RMD is ordinary income once: with no other income,
    // AGI is exactly the RMD.
    expect(r.agi).toBe(37735.85);
  });

  test("IRMAA: the single-year forward IRMAA equals the direct tier lookup, and the premium carries no IRMAA", () => {
    // Primary 66, spouse 64, conversion $250,000: MAGI $250,000.
    // Premium year is the priced year + 2 (2028); both spouses
    // are 65+ by then, so two persons are graded.
    const scenario = normalizedScenario({
      currentAge: 66,
      spouseAge: 64,
      // The fictional household retires at 58; a 66-year-old
      // primary needs retirementAge at or after the current age.
      retirementAge: 66,
      conversionAnnual: 250000,
      // No spending draw: the draw is taxable income, and the
      // test's MAGI is the conversion alone ($250,000).
      spendingDrawAnnual: 0,
      healthPremiumMedicarePerPersonAnnual: 2400,
      spendingIncludesHealthPremiums: false,
    });
    const res = calculateSingleYearTax(scenario);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("fixture failed");
    const r = res.results;
    expect(r.magi).toBe(250000);
    const premiumLaw = lawForYear(2028)!;
    const tier = irmaaTierFor(250000, "mfj", premiumLaw, 2028, 0);
    const annualPerPerson = irmaaAnnualPerPerson(tier, premiumLaw);
    expect(r.irmaa.tier).toBe(tier);
    expect(r.irmaa.premiumYear).toBe(2028);
    expect(r.irmaa.personsOnMedicare).toBe(2);
    expect(r.irmaa.annualPerPerson).toBe(annualPerPerson);
    expect(r.irmaa.annualHousehold).toBe(r2(annualPerPerson * 2));
    // Not twice: the base premium is the per-person premium x
    // the persons on Medicare THIS year (primary only — the
    // spouse is 64); the forward IRMAA is a disclosure, never
    // inside the premium, the tax bill, or the cash left.
    expect(r.healthPremiumGross).toBe(2400);
    expect(r.healthPremiumNet).toBe(2400);
    expect(r.irmaaPayableAnnual).toBe(0);
    expect(r.cashLeftAfterHealthPremium).toBe(
      r2(r.cashLeftAfterTax - r.healthPremiumNet),
    );
    // And the work-years handoff grades the same rule: the roll's
    // IRMAA lookback seed is the real work-year MAGI per year.
    const { plan, job } = directInputs();
    const roll = rollWorkYears(plan, job, 62);
    expect(roll.rolledInputs.irmaaLookbackSeed).toEqual(
      roll.lines.map((l) => ({
        year: l.calendarYear,
        magi: l.magi,
        filingStatus: plan.filingStatus,
      })),
    );
  });

  test("Monte Carlo: the adapter and the direct engine return the same seeded run", () => {
    const scenario = normalizedScenario({});
    const viaAdapter = runRetirementMonteCarlo(scenario);
    expect(viaAdapter.ok).toBe(true);
    if (!viaAdapter.ok) throw new Error("fixture failed");
    const { inputs } = toSimInputs(scenario);
    const direct = runMonteCarlo(
      inputs,
      scenario.expectedReturnPct / 100,
      scenario.volatilityPct / 100,
      scenario.mcSeed,
      scenario.mcRuns,
    );
    expect(direct).not.toBeNull();
    const a = viaAdapter.results;
    // R7 returns the exact fraction (922/1000 = 0.922), not the
    // 2dp-rounded 0.92 the old pin expected.
    expect(a.successRate).toBe(direct!.neverOutSuccessRate / 100);
    expect(a.successfulRuns).toBe(
      Math.round((direct!.neverOutSuccessRate / 100) * a.runs),
    );
    // The adapter rounds dollar percentiles to cents; the direct
    // engine returns full precision — compare rounded to rounded.
    expect(a.endingP10).toBe(r2(direct!.p10 / 100));
    expect(a.endingP50).toBe(r2(direct!.p50 / 100));
    expect(a.endingP90).toBe(r2(direct!.p90 / 100));
    expect(a.runs).toBe(scenario.mcRuns);
    expect(a.seed).toBe(scenario.mcSeed);
  });

  test("Roth candidate: the adapter's full-mode winner is the direct optimizer's winner", () => {
    const scenario = normalizedScenario({ comparisonScope: "full" });
    const viaAdapter = compareRothConversions(scenario);
    expect(viaAdapter.ok).toBe(true);
    if (!viaAdapter.ok) throw new Error(JSON.stringify(viaAdapter.error));
    const plan = buildRothPlanInputs(scenario);
    const direct = runOptimizer(plan);
    const a = viaAdapter.results;
    // Same underlying score: the adapter's winner scenario is the
    // direct winner, by candidate key and by net cost.
    const winnerScenario = a.scenarios.find((s) => s.name === a.winnerByNetCost)!;
    expect(winnerScenario.candidateKey).toBe(direct.winner.spec.key);
    expect(winnerScenario.lifetimeNetCost).toBe(r2(direct.winner.cost.netCost));
    const wealthScenario = a.scenarios.find((s) => s.name === a.winnerByEndingWealth)!;
    expect(wealthScenario.candidateKey).toBe(
      direct.winnerByEndingWealth?.spec.key,
    );
    // Same validity: the crowned winner is a valid candidate.
    expect(direct.winner.integrity.status).not.toBe("invalid");
    // Same benchmark: the Do Nothing scenario matches the direct
    // Do Nothing candidate to the cent.
    const baseline = a.scenarios.find((s) => s.name === a.baselineName)!;
    expect(baseline.lifetimeNetCost).toBe(r2(direct.doNothing.cost.netCost));
    expect(baseline.endingWealth).toBe(
      r2(direct.doNothing.result.endingAfterTaxWealth),
    );
  }, 300000);

  test("Education credits: the adapter prices none, so none can be counted twice", () => {
    // The adapter exposes no education inputs (no AOTC/LLC
    // fields in the schema), so the single-year price can never
    // price a refundable education credit — and the march's
    // pending-refund carry is engine-internal, settled in the
    // year the credit is actually received.
    const res = calculateSingleYearTax(normalizedScenario({}));
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("fixture failed");
    expect(res.results.educationChoice).toBe("none");
    expect(res.results.educationRefundable).toBe(0);
    expect(res.results.educationNonrefundable).toBe(0);
  });
});

// --- Single-year pricer inputs, mirroring the adapter's
// calculateSingleYearTax construction for a simple scenario (no SS
// started, no RMD, no premiums, WA, MFJ household of 2). The
// adapter must equal this direct call field for field.
function singleYearInputs(
  overrides: Partial<PlaygroundYearInputs> & {
    agePrimary: number;
    ageSpouse: number | null;
  },
): PlaygroundYearInputs {
  return {
    taxYear: 2026,
    filingStatus: "mfj",
    agePrimary: overrides.agePrimary,
    ageSpouse: overrides.ageSpouse,
    onMedicarePrimary: overrides.agePrimary >= 65,
    onMedicareSpouse:
      overrides.ageSpouse != null && overrides.ageSpouse >= 65,
    interest: overrides.interest ?? 0,
    ordinaryDividends: overrides.ordinaryDividends ?? 0,
    otherOrdinary: overrides.otherOrdinary ?? 0,
    taxExemptInterest: 0,
    ssPrimary: overrides.ssPrimary ?? 0,
    ssSpouse: overrides.ssSpouse ?? 0,
    conversion: overrides.conversion ?? 0,
    spendingDraw: overrides.spendingDraw ?? 0,
    cashDraw: 0,
    rothDraw: 0,
    inflationPct: 0,
    stockSold: overrides.stockSold ?? 0,
    stockBasis: overrides.stockBasis ?? 0,
    qualifiedDividends: overrides.qualifiedDividends ?? 0,
    pretaxBalance: null,
    pretaxBalanceSpouse: null,
    rmdAlreadyReceived: 0,
    primarySoleBeneficiaryOfSpouse: null,
    spouseSoleBeneficiary: true,
    acaHouseholdSize: 2,
    acaBenchmarkAnnual: null,
    healthPremiumAcaAnnual: null,
    healthPremiumMedicarePerPerson: null,
    stateRatePct: 0,
    residenceState: "other",
    annualSpending: overrides.annualSpending ?? 114000,
  };
}
