// premiums.test.ts — Review 3 R3-S1: health insurance premiums in the
// tax-aware tools.
//
// Before this fix the adapter hardcoded all three engine premium fields
// to null, so a caller who supplied premium amounts got the exact same
// figures as a caller who supplied none. The engine's v208 term was
// already pricing them; only the adapter was dropping them.
//
// Expected figures below were derived by hand from the engine's own
// tier rules and verified against a direct engine run before the fix
// (see the per-year schedule note after each case). The fictional
// household (helpers.ts): ages 54/52, retire 58, end 95, $9,500/mo,
// benchmarks couple $26,000 / single $16,000 — the benchmarks are
// passed explicitly here because the helper leaves them null
// (credit $0) and the credit cases need them.
//
// Hand schedule for the fictional household (retire 58, end 95):
//   2030–2036  both on the marketplace      household $20,000 x 7
//   2037–2038  spouse only on the marketplace
//              single $12,000 + primary's Medicare $3,600 = $15,600 x 2
//   2039–2067  both on Medicare            $3,600 x 2 = $7,200 x 29
// Lifetime gross = 140,000 + 31,200 + 208,800 = $380,000.
// The yearly NET identity is net = gross − min(credit, marketplace
// gross) + Medicare base, so lifetime net = gross − lifetime credit
// kept: 380,000 − 157,595.15 = $222,404.85.
// Re-pinned after Review 2 (the adapter's return default moved from
// the 6.75% blend to the flat 5%): the old pins reproduce exactly
// with expectedRealReturnPct 6.75 forced, so no premium behavior
// changed — only the march's growth rate.
// When a tier is null and the term is active, the engine falls back
// to the year's benchmark (the march's standing proxy): the
// household tier falls back to the couple benchmark, the single tier
// to the single benchmark, and a null Medicare amount has no
// fallback (Medicare $0).

import { describe, expect, test } from "bun:test";
import {
  calculateRetirement,
  calculateSingleYearTax,
  centsToDollars,
  compareRetirementAges,
  compareRothConversions,
} from "../src/adapter";
import { normalizeInputs } from "../src/normalize";
import { dispatchTool } from "../src/tools";
import {
  FICTIONAL,
  expectEnvelope,
  expectOk,
  fictionalScenario,
  normalizedScenario,
  round2,
  roundDeep,
} from "./helpers";
import {
  runRothCompare,
  type RothCompareBaseSaved,
  type RothCompareOverrides,
} from "../../server/src/rothOptimizer";

const BENCHMARKS = { acaBenchmarkCouple: 26000, acaBenchmarkSingle: 16000 };
const FULL_PREMIUMS = {
  healthPremiumAcaHouseholdAnnual: 20000,
  healthPremiumAcaSingleAnnual: 12000,
  healthPremiumMedicarePerPersonAnnual: 3600,
};
const NOT_MODELED =
  "Health insurance premiums are not included; only the ACA premium credit and IRMAA surcharge are priced.";
const INCLUDED_WARNING =
  "Monthly spending already includes health premiums, so the supplied premium amounts are recorded but not charged again — the engine funds spending verbatim. Gross/net premium breakdowns are not priced in this mode.";

type CompareResultsShape = {
  baselineName: string;
  scenarios: Array<{
    name: string;
    lifetimeNetCost: number;
    lifetimeTax: number;
    acaCreditKept: number;
    irmaaTotal: number;
    lifetimeHealthPremiumGross: number;
    lifetimeHealthPremiumNet: number;
    endingWealth: number;
  }>;
  yearly: Array<{
    year: number;
    healthPremiumGross: number;
    healthPremiumNet: number;
    acaCredit: number;
    irmaa: number;
  }>;
};

/** The compare's baseline scenario (its name is the strategy id,
 *  e.g. "do-nothing"). */
function baselineOf(results: CompareResultsShape) {
  const b = results.scenarios.find((s) => s.name === results.baselineName);
  if (!b) throw new Error("baseline scenario missing");
  return b;
}

function yearRow(results: CompareResultsShape, year: number) {
  const row = results.yearly.find((y) => y.year === year);
  if (!row) throw new Error(`yearly row ${year} missing`);
  return row;
}

describe("R3-S1 health premiums", () => {
  test("1. all premium fields omitted — existing outputs unchanged, warning present", async () => {
    const envelope = expectEnvelope(
      await dispatchTool(
        "retirement_roth_conversion",
        fictionalScenario(BENCHMARKS),
      ),
    );
    const results = envelope.results as unknown as CompareResultsShape;
    const baseline = baselineOf(results);
    // The direct-engine figure with the premium fields null
    // (benchmarks $26,000/$16,000): the adapter must not move it.
    // Re-derived when the fixture benchmarks
    // changed — the old couple benchmark is a real figure
    // (scrub); the $16,000.00 move is exactly the benchmark
    // movement (7 marketplace years x $2,000 + 2 single years x
    // $1,000) flowing into the ACA credit.
    expect(baseline.lifetimeNetCost).toBe(1189888.62);
    expect(baseline.lifetimeHealthPremiumGross).toBe(0);
    expect(baseline.lifetimeHealthPremiumNet).toBe(0);
    expect(envelope.warnings).toContain(NOT_MODELED);
    expect(envelope.effectiveInputs.healthPremiumAcaHouseholdAnnual).toBe(
      null,
    );
    expect(envelope.effectiveInputs.healthPremiumAcaSingleAnnual).toBe(
      null,
    );
    expect(
      envelope.effectiveInputs.healthPremiumMedicarePerPersonAnnual,
    ).toBe(null);
    expect(envelope.effectiveInputs.spendingIncludesHealthPremiums).toBe(
      null,
    );
  });

  test("2. all premium fields explicitly zero — no insurance expense, credit capped at $0", async () => {
    const results = expectOk(
      await compareRothConversions(
        normalizedScenario({
          ...BENCHMARKS,
          healthPremiumAcaHouseholdAnnual: 0,
          healthPremiumAcaSingleAnnual: 0,
          healthPremiumMedicarePerPersonAnnual: 0,
          spendingIncludesHealthPremiums: false,
        }),
      ),
    );
    const baseline = baselineOf(results);
    expect(baseline.lifetimeHealthPremiumGross).toBe(0);
    expect(baseline.lifetimeHealthPremiumNet).toBe(0);
    // An explicit $0 premium is an entered premium: it activates
    // the term, and the year's retained ACA credit is capped at
    // that $0 premium (the engine's R3-M2 rule) — so no credit is
    // kept against a $0 premium. No premium is charged, but the
    // credit the omitted case kept is no longer kept.
    expect(baseline.acaCreditKept).toBe(0);
    for (const row of results.yearly) {
      expect(row.healthPremiumGross).toBe(0);
      expect(row.healthPremiumNet).toBe(0);
    }
  });

  test("null-tier assumption notes state the benchmark fallback when the term is active (pass-1 SHOULD-1)", async () => {
    // Household-only premium, term active: the null single tier
    // falls back to the year's benchmark, so its note must say
    // so — "no premium modeled" would be false (the call prices
    // $16,000 in 2037–2038). The null Medicare tier has no
    // fallback, so its note still says no premium is modeled.
    const charged = normalizedScenario({
      ...BENCHMARKS,
      healthPremiumAcaHouseholdAnnual: 20000,
      spendingIncludesHealthPremiums: false,
    });
    const chargedNotes = new Map(
      charged.assumptions.map((a) => [a.field, a.note]),
    );
    expect(chargedNotes.get("healthPremiumAcaSingleAnnual")).toContain(
      "benchmark",
    );
    expect(chargedNotes.get("healthPremiumAcaSingleAnnual")).not.toContain(
      "no premium modeled",
    );
    expect(
      chargedNotes.get("healthPremiumMedicarePerPersonAnnual"),
    ).toContain("no benchmark fallback");
    // Term off (nothing supplied): the same null tiers really do
    // model no premium.
    const omitted = normalizedScenario(BENCHMARKS);
    const omittedNotes = new Map(
      omitted.assumptions.map((a) => [a.field, a.note]),
    );
    expect(omittedNotes.get("healthPremiumAcaSingleAnnual")).toContain(
      "no premium modeled",
    );
    expect(omittedNotes.get("healthPremiumAcaHouseholdAnnual")).toContain(
      "no premium modeled",
    );
  });

  test("3. ACA household premium only — correct years, single years fall back to the single benchmark", async () => {
    const results = expectOk(
      await compareRothConversions(
        normalizedScenario({
          ...BENCHMARKS,
          healthPremiumAcaHouseholdAnnual: 20000,
          spendingIncludesHealthPremiums: false,
        }),
      ),
    );
    const baseline = baselineOf(results);
    // 7 household years at $20,000 + 2 spouse-only years at the
    // single benchmark ($16,000, the march's standing proxy when
    // the single tier is null) + 29 Medicare years at $0 (a null
    // Medicare amount has no benchmark fallback).
    expect(baseline.lifetimeHealthPremiumGross).toBe(172000);
    expect(yearRow(results, 2030).healthPremiumGross).toBe(20000);
    expect(yearRow(results, 2037).healthPremiumGross).toBe(16000);
    expect(yearRow(results, 2039).healthPremiumGross).toBe(0);
  });

  test("4. ACA single premium only — household years fall back to the couple benchmark, transition at 65", async () => {
    const results = expectOk(
      await compareRothConversions(
        normalizedScenario({
          ...BENCHMARKS,
          healthPremiumAcaSingleAnnual: 12000,
          spendingIncludesHealthPremiums: false,
        }),
      ),
    );
    const baseline = baselineOf(results);
    // 7 both-on-marketplace years at the couple benchmark
    // ($26,000) + 2 spouse-only years at $12,000 + 29 Medicare
    // years at $0.
    expect(baseline.lifetimeHealthPremiumGross).toBe(206000);
    expect(yearRow(results, 2030).healthPremiumGross).toBe(26000);
    expect(yearRow(results, 2036).healthPremiumGross).toBe(26000);
    expect(yearRow(results, 2037).healthPremiumGross).toBe(12000);
    expect(yearRow(results, 2038).healthPremiumGross).toBe(12000);
    expect(yearRow(results, 2039).healthPremiumGross).toBe(0);
  });

  test("5. Medicare premium per person only, no benchmarks — priced when each spouse reaches 65", async () => {
    const results = expectOk(
      await compareRothConversions(
        normalizedScenario({
          healthPremiumMedicarePerPersonAnnual: 3600,
          spendingIncludesHealthPremiums: false,
        }),
      ),
    );
    const baseline = baselineOf(results);
    // No benchmarks, so the marketplace years have no fallback:
    // $0 while both are on the marketplace, $3,600 for the two
    // primary-only Medicare years, $7,200 once both are on
    // Medicare (29 years): 2 x 3,600 + 29 x 7,200 = $216,000.
    expect(baseline.lifetimeHealthPremiumGross).toBe(216000);
    expect(yearRow(results, 2030).healthPremiumGross).toBe(0);
    expect(yearRow(results, 2036).healthPremiumGross).toBe(0);
    expect(yearRow(results, 2037).healthPremiumGross).toBe(3600);
    expect(yearRow(results, 2038).healthPremiumGross).toBe(3600);
    expect(yearRow(results, 2039).healthPremiumGross).toBe(7200);
    expect(yearRow(results, 2067).healthPremiumGross).toBe(7200);
  });

  test("6. ACA credit — gross less eligible credit = net, per year and lifetime", async () => {
    const results = expectOk(
      await compareRothConversions(
        normalizedScenario({
          ...BENCHMARKS,
          ...FULL_PREMIUMS,
          spendingIncludesHealthPremiums: false,
        }),
      ),
    );
    const baseline = baselineOf(results);
    expect(baseline.lifetimeHealthPremiumGross).toBe(380000);
    expect(baseline.acaCreditKept).toBe(157595.15);
    // Lifetime identity: net = gross − credit kept.
    expect(baseline.lifetimeHealthPremiumNet).toBe(222404.85);
    expect(
      baseline.lifetimeHealthPremiumGross - baseline.acaCreditKept,
    ).toBeCloseTo(baseline.lifetimeHealthPremiumNet, 2);
    // Both-on-marketplace year: no Medicare base, so net = gross − credit.
    const y2030 = yearRow(results, 2030);
    expect(y2030.healthPremiumGross).toBe(20000);
    expect(y2030.healthPremiumNet).toBeCloseTo(
      20000 - Math.min(y2030.acaCredit, 20000),
      2,
    );
    // Mixed year (primary on Medicare, spouse on the marketplace):
    // net = Medicare base $3,600 + (single $12,000 − credit).
    const y2037 = yearRow(results, 2037);
    expect(y2037.healthPremiumGross).toBe(15600);
    expect(y2037.healthPremiumNet).toBeCloseTo(
      3600 + (12000 - Math.min(y2037.acaCredit, 12000)),
      2,
    );
    // Both-on-Medicare year: no credit, net = gross.
    const y2039 = yearRow(results, 2039);
    expect(y2039.healthPremiumGross).toBe(7200);
    expect(y2039.acaCredit).toBe(0);
    expect(y2039.healthPremiumNet).toBe(7200);
  });

  test("7. IRMAA — a separate surcharge, never folded into the Medicare base premium", async () => {
    const results = expectOk(
      await compareRothConversions(
        normalizedScenario({
          ...BENCHMARKS,
          ...FULL_PREMIUMS,
          spendingIncludesHealthPremiums: false,
        }),
      ),
    );
    const baseline = baselineOf(results);
    expect(baseline.irmaaTotal).toBeGreaterThan(0);
    // 2054 is the first IRMAA year under the current 5% return
    // default: the net premium is the $7,200 base alone and the
    // IRMAA sits in its own column. (On the old 6.75% blend the
    // first IRMAA year was 2049 at the same $2,296.80 — slower
    // growth keeps MAGI under the threshold longer.)
    const y2054 = yearRow(results, 2054);
    expect(y2054.irmaa).toBe(2296.8);
    expect(y2054.healthPremiumGross).toBe(7200);
    expect(y2054.healthPremiumNet).toBe(7200);
    // And the lifetime net is gross − credit, with no IRMAA inside it.
    expect(
      baseline.lifetimeHealthPremiumGross - baseline.acaCreditKept,
    ).toBeCloseTo(baseline.lifetimeHealthPremiumNet, 2);
  });

  test("8. mixed-age married household — the premium schedule follows each spouse's own 65", async () => {
    // Fictional ages 60/57 (not the user's): primary reaches 65
    // in 2031, spouse in 2034; retire 62 (2028), end 95 (2061).
    //   2028–2030 both on the marketplace: $20,000 x 3 = 60,000
    //   2031–2033 spouse only: $15,600 x 3 = 46,800
    //   2034–2061 both on Medicare: $7,200 x 28 = 201,600
    // Lifetime gross = $308,400.
    const results = expectOk(
      await compareRothConversions(
        normalizedScenario({
          ...BENCHMARKS,
          ...FULL_PREMIUMS,
          spendingIncludesHealthPremiums: false,
          currentAge: 60,
          spouseAge: 57,
          retirementAge: 62,
        }),
      ),
    );
    const baseline = baselineOf(results);
    expect(baseline.lifetimeHealthPremiumGross).toBe(308400);
    expect(yearRow(results, 2028).healthPremiumGross).toBe(20000);
    expect(yearRow(results, 2030).healthPremiumGross).toBe(20000);
    expect(yearRow(results, 2031).healthPremiumGross).toBe(15600);
    expect(yearRow(results, 2033).healthPremiumGross).toBe(15600);
    expect(yearRow(results, 2034).healthPremiumGross).toBe(7200);
    expect(yearRow(results, 2061).healthPremiumGross).toBe(7200);
  });

  test("9. monthly spending includes premiums — no double counting; results identical to omitting them", async () => {
    const included = expectEnvelope(
      await dispatchTool(
        "retirement_roth_conversion",
        fictionalScenario({
          ...BENCHMARKS,
          ...FULL_PREMIUMS,
          spendingIncludesHealthPremiums: true,
        }),
      ),
    );
    const omitted = expectEnvelope(
      await dispatchTool(
        "retirement_roth_conversion",
        fictionalScenario(BENCHMARKS),
      ),
    );
    const includedBaseline = baselineOf(
      included.results as unknown as CompareResultsShape,
    );
    const omittedBaseline = baselineOf(
      omitted.results as unknown as CompareResultsShape,
    );
    expect(includedBaseline.lifetimeNetCost).toBe(
      omittedBaseline.lifetimeNetCost,
    );
    expect(includedBaseline.lifetimeHealthPremiumGross).toBe(0);
    expect(includedBaseline.lifetimeHealthPremiumNet).toBe(0);
    expect(includedBaseline.acaCreditKept).toBe(
      omittedBaseline.acaCreditKept,
    );
    // The supplied amounts are echoed, never silently lost.
    expect(included.effectiveInputs.healthPremiumAcaHouseholdAnnual).toBe(
      20000,
    );
    expect(included.effectiveInputs.spendingIncludesHealthPremiums).toBe(
      true,
    );
    // Warned as included, not as not-modeled.
    expect(included.warnings).toContain(INCLUDED_WARNING);
    expect(included.warnings).not.toContain(NOT_MODELED);
  });

  test("10. monthly spending excludes premiums — the premium is funded on top, net cost rises", async () => {
    const results = expectOk(
      await compareRothConversions(
        normalizedScenario({
          ...BENCHMARKS,
          ...FULL_PREMIUMS,
          spendingIncludesHealthPremiums: false,
        }),
      ),
    );
    const baseline = baselineOf(results);
    expect(baseline.lifetimeHealthPremiumGross).toBe(380000);
    expect(baseline.lifetimeHealthPremiumNet).toBe(222404.85);
    expect(baseline.lifetimeNetCost).toBe(1581901.55);
    // The extra funding requirement vs the omitted case:
    // $392,012.93 — the $222,404.85 net premium plus the tax on
    // the extra draws that fund it.
    expect(baseline.lifetimeNetCost - 1189888.62).toBeCloseTo(
      392012.93,
      2,
    );
  });

  test("11. tax-aware engine direct call vs adapter call — identical results for identical inputs", async () => {
    // The engine base built by hand, mirroring the adapter's
    // buildRothCompareBase for the fictional household.
    const cents = (d: number) => Math.round(d * 100);
    const base: RothCompareBaseSaved = {
      birthYearPrimary: 2026 - 54,
      birthYearSpouse: 2026 - 52,
      filingStatus: "mfj",
      pretaxCents: cents(1250000),
      pretaxSpouseCents: 0,
      survivorEnabled: false,
      survivorWho: "primary",
      survivorDeathYear: null,
      rothCents: cents(375000),
      taxableCents: cents(2100000),
      taxableExcludeCents: null,
      hsaCents: cents(62000),
      taxableBasisPct: 72,
      taxableTiers: null,
      taxableDividendYieldPct: null,
      taxableInterestYieldPct: null,
      yieldFallbackDividendPct: null,
      yieldFallbackInterestPct: null,
      qualifiedDividendSharePct: null,
      spendFromCashPct: null,
      flexCutPct: null,
      flexFloorPct: null,
      spendFromCashSleeveCents: null,
      annualSpendingCents: cents(9500 * 12),
      retirementAge: 58,
      endAge: 95,
      expectedReturnPct: 5,
      stocksPct: 95,
      ssPrimaryAnnualCents: cents(36000),
      ssPrimaryStartAge: 67,
      ssPrimaryNoBenefit: false,
      ssSpouseAnnualCents: cents(18000),
      ssSpouseStartAge: 67,
      ssSpouseNoBenefit: false,
      otherOrdinaryCents: 0,
      taxExemptInterestCents: 0,
      convertedAlreadyCents: 0,
      windowStartAge: 58,
      windowStopAge: null,
      payTaxFrom: "taxable",
      protectMinTaxableCents: 0,
      preservePretaxCents: null,
      preserveExitRatePct: null,
      claimAgeFloor: null,
      drawOrder: "taxable-pretax-roth",
      drawOrderSwitchAge: null,
      drawOrderAfter: null,
      spouseSoleBeneficiary: true,
      primarySoleBeneficiaryOfSpouse: null,
      acaHouseholdSize: 2,
      acaHouseholdSchedule: null,
      acaBenchmarkCoupleCents: cents(26000),
      acaBenchmarkSingleCents: cents(16000),
      acaBenchmarkFamilyCents: null,
      acaSpouseEndAge: null,
      healthPremiumAcaHouseholdCents: cents(20000),
      healthPremiumAcaSingleCents: cents(12000),
      healthPremiumMedicarePerPersonCents: cents(3600),
      inflationPct: 0,
      stateRatePct: 0,
      residenceState: "other",
      capitalLossCarryInStCents: null,
      capitalLossCarryInLtCents: null,
      capitalLossCarryInStWaCents: null,
      capitalLossCarryInLtWaCents: null,
      itemizedMortgageInterestCents: null,
      itemizedSaltPaidCents: null,
      itemizedCharitableCents: null,
      itemizedOtherCents: null,
      educationStudents: null,
      heirRatePct: 22,
      fafsaReportableAssetsCents: null,
      collegeFallFromYear: null,
      collegeFallThroughYear: null,
      yearlySalaryCents: null,
      employer401kCents: 0,
      employerHsaCents: 0,
      ceilings: null,
      optimizerGuardrail: null,
      optimizerBunching: null,
      gainsHarvest: null,
    };
    const scenarios: { name: string; overrides: RothCompareOverrides }[] = [
      { name: "Do Nothing", overrides: {} },
    ];
    const engine = runRothCompare(base, scenarios, 2026, "Do Nothing");
    if (!engine.ok) throw new Error(engine.reason);
    const engineBaseline = engine.scenarios.find(
      (s) => s.name === "Do Nothing",
    )!;
    const adapter = expectOk(
      await compareRothConversions(
        normalizedScenario({
          ...BENCHMARKS,
          ...FULL_PREMIUMS,
          spendingIncludesHealthPremiums: false,
        }),
      ),
    );
    const adapterBaseline = baselineOf(adapter);
    expect(adapterBaseline.lifetimeNetCost).toBe(
      centsToDollars(engineBaseline.netCostCents),
    );
    expect(adapterBaseline.lifetimeTax).toBe(
      centsToDollars(engineBaseline.totalTaxCents),
    );
    expect(adapterBaseline.acaCreditKept).toBe(
      centsToDollars(engineBaseline.acaCreditCents),
    );
    expect(adapterBaseline.irmaaTotal).toBe(
      centsToDollars(engineBaseline.irmaaCents),
    );
    expect(adapterBaseline.lifetimeHealthPremiumGross).toBe(
      centsToDollars(engineBaseline.healthPremiumCents),
    );
    expect(adapterBaseline.lifetimeHealthPremiumNet).toBe(
      centsToDollars(engineBaseline.healthPremiumNetCents),
    );
    expect(adapterBaseline.endingWealth).toBe(
      centsToDollars(engineBaseline.endingAfterTaxWealthCents),
    );
    // Per-year gross/net agree for the sampled years.
    for (const year of [2030, 2037, 2039, 2049, 2067]) {
      const engineYear = engineBaseline.years.find((y) => y.year === year)!;
      const adapterYear = yearRow(adapter, year);
      expect(adapterYear.healthPremiumGross).toBe(
        centsToDollars(engineYear.healthPremiumGrossCents),
      );
      expect(adapterYear.healthPremiumNet).toBe(
        centsToDollars(engineYear.healthPremiumCents),
      );
    }
    // And the all-zero case agrees too (the R3-M2 credit cap is
    // engine behavior, not an adapter invention).
    const zeroBase = { ...base, healthPremiumAcaHouseholdCents: 0, healthPremiumAcaSingleCents: 0, healthPremiumMedicarePerPersonCents: 0 };
    const engineZero = runRothCompare(zeroBase, scenarios, 2026, "Do Nothing");
    if (!engineZero.ok) throw new Error(engineZero.reason);
    const engineZeroBaseline = engineZero.scenarios.find(
      (s) => s.name === "Do Nothing",
    )!;
    const adapterZero = expectOk(
      await compareRothConversions(
        normalizedScenario({
          ...BENCHMARKS,
          healthPremiumAcaHouseholdAnnual: 0,
          healthPremiumAcaSingleAnnual: 0,
          healthPremiumMedicarePerPersonAnnual: 0,
          spendingIncludesHealthPremiums: false,
        }),
      ),
    );
    expect(baselineOf(adapterZero).lifetimeNetCost).toBe(
      centsToDollars(engineZeroBaseline.netCostCents),
    );
    expect(baselineOf(adapterZero).acaCreditKept).toBe(
      centsToDollars(engineZeroBaseline.acaCreditCents),
    );
  });

  test("12. sample household mutation — no effect on calculation", async () => {
    const inputBefore = JSON.stringify(fictionalScenario());
    const fixtureBefore = JSON.stringify(FICTIONAL);
    const premiumCall = await dispatchTool(
      "retirement_roth_conversion",
      fictionalScenario({
        ...BENCHMARKS,
        ...FULL_PREMIUMS,
        spendingIncludesHealthPremiums: false,
      }),
    );
    expect(premiumCall.ok).toBe(true);
    // The shared fixture objects are untouched by the call.
    expect(JSON.stringify(fictionalScenario())).toBe(inputBefore);
    expect(JSON.stringify(FICTIONAL)).toBe(fixtureBefore);
    // And a later baseline call prices the same as before.
    const later = expectOk(
      await compareRothConversions(normalizedScenario(BENCHMARKS)),
    );
    expect(baselineOf(later).lifetimeNetCost).toBe(1189888.62);
    expect(baselineOf(later).lifetimeHealthPremiumGross).toBe(0);
  });

  test("13. A → B → A calls — no retained financial state", async () => {
    const a = normalizedScenario({
      ...BENCHMARKS,
      ...FULL_PREMIUMS,
      spendingIncludesHealthPremiums: false,
    });
    const b = normalizedScenario({
      ...BENCHMARKS,
      healthPremiumAcaHouseholdAnnual: 30000,
      healthPremiumAcaSingleAnnual: 18000,
      healthPremiumMedicarePerPersonAnnual: 4800,
      spendingIncludesHealthPremiums: false,
    });
    const first = expectOk(await compareRothConversions(a));
    const middle = expectOk(await compareRothConversions(b));
    const again = expectOk(await compareRothConversions(a));
    expect(baselineOf(middle).lifetimeHealthPremiumGross).not.toBe(
      baselineOf(first).lifetimeHealthPremiumGross,
    );
    expect(roundDeep(baselineOf(again))).toEqual(roundDeep(baselineOf(first)));
    expect(roundDeep(again.yearly)).toEqual(roundDeep(first.yearly));
  });

  test("premiums without a spending convention are rejected as missing_input", async () => {
    const result = await dispatchTool(
      "retirement_roth_conversion",
      fictionalScenario({ ...BENCHMARKS, ...FULL_PREMIUMS }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.error.code).toBe("missing_input");
    expect(result.error.missing).toContain("spendingIncludesHealthPremiums");
    expect(result.error.questions?.[0]?.question).toContain(
      "health insurance premiums",
    );
  });

  test("negative and non-finite premiums are invalid_input", async () => {
    for (const bad of [-1, Number.POSITIVE_INFINITY]) {
      const n = normalizeInputs(
        fictionalScenario({
          healthPremiumAcaHouseholdAnnual: bad,
          spendingIncludesHealthPremiums: false,
        }),
      );
      expect(n.ok).toBe(false);
      if (n.ok) throw new Error("expected a rejection");
      expect(n.error.error.code).toBe("invalid_input");
    }
  });

  test("portfolio-only tools warn when premiums were supplied to charge, and stay silent when they are inside spending", async () => {
    const charged = expectEnvelope(
      await dispatchTool(
        "retirement_calculate",
        fictionalScenario({
          ...FULL_PREMIUMS,
          spendingIncludesHealthPremiums: false,
        }),
      ),
    );
    expect(
      charged.warnings.some((w) =>
        w.includes("portfolio-only simulation prices none of them"),
      ),
    ).toBe(true);
    const included = expectEnvelope(
      await dispatchTool(
        "retirement_calculate",
        fictionalScenario({
          ...FULL_PREMIUMS,
          spendingIncludesHealthPremiums: true,
        }),
      ),
    );
    expect(
      included.warnings.some((w) =>
        w.includes("portfolio-only simulation prices none of them"),
      ),
    ).toBe(false);
  });

  test("work-years leg carries the premiums (compare ages 58 and 60)", async () => {
    const results = expectOk(
      await compareRetirementAges(
        normalizedScenario({
          ...BENCHMARKS,
          ...FULL_PREMIUMS,
          spendingIncludesHealthPremiums: false,
          compareAges: [58, 60],
        }),
      ),
    );
    const byAge = new Map(
      results.scenarios.map((s) => [s.retirementAge, s]),
    );
    // Retire 58: the hand schedule above — $380,000.
    expect(byAge.get(58)?.lifetimeHealthPremiumGross).toBe(380000);
    // Retire 60: both on the marketplace 2032–2036 ($20,000 x 5),
    // spouse only 2037–2038 ($15,600 x 2), both on Medicare
    // 2039–2067 ($7,200 x 29) = $340,000.
    expect(byAge.get(60)?.lifetimeHealthPremiumGross).toBe(340000);
  }, 300000);
});

describe("R3-S1 single-year tax tool", () => {
  test("both on the marketplace in the priced year — the household tier, net of the credit", async () => {
    const results = expectOk(
      calculateSingleYearTax(
        normalizedScenario({
          ...BENCHMARKS,
          ...FULL_PREMIUMS,
          spendingIncludesHealthPremiums: false,
        }),
      ),
    ) as unknown as {
      healthPremiumGross: number;
      healthPremiumNet: number;
      aca: { credit: number | null; applies: boolean };
      irmaa: { annualHousehold: number };
    };
    expect(results.healthPremiumGross).toBe(20000);
    expect(results.aca.applies).toBe(true);
    expect(results.healthPremiumNet).toBeCloseTo(
      20000 - Math.min(results.aca.credit ?? 0, 20000),
      2,
    );
  });

  test("one on Medicare in the priced year — the single tier plus that person's Medicare base", async () => {
    // Fictional ages 66/64 in 2026: primary on Medicare, spouse
    // on the marketplace. Gross = single $12,000 + Medicare $3,600.
    const results = expectOk(
      calculateSingleYearTax(
        normalizedScenario({
          ...BENCHMARKS,
          ...FULL_PREMIUMS,
          spendingIncludesHealthPremiums: false,
          currentAge: 66,
          spouseAge: 64,
          retirementAge: 66,
        }),
      ),
    ) as unknown as {
      healthPremiumGross: number;
      healthPremiumNet: number;
      aca: { credit: number | null; applies: boolean };
      irmaa: { annualHousehold: number };
    };
    expect(results.healthPremiumGross).toBe(15600);
    expect(results.aca.applies).toBe(true);
    expect(results.healthPremiumNet).toBeCloseTo(
      3600 + (12000 - Math.min(results.aca.credit ?? 0, 12000)),
      2,
    );
  });

  test("both on Medicare in the priced year — Medicare base only, no ACA credit, IRMAA separate", async () => {
    // Fictional ages 67/66 in 2026: both on Medicare.
    const results = expectOk(
      calculateSingleYearTax(
        normalizedScenario({
          ...BENCHMARKS,
          ...FULL_PREMIUMS,
          spendingIncludesHealthPremiums: false,
          currentAge: 67,
          spouseAge: 66,
          retirementAge: 67,
        }),
      ),
    ) as unknown as {
      healthPremiumGross: number;
      healthPremiumNet: number;
      aca: { credit: number | null; applies: boolean };
      irmaa: { annualHousehold: number };
    };
    expect(results.healthPremiumGross).toBe(7200);
    expect(results.aca.applies).toBe(false);
    expect(results.aca.credit).toBe(null);
    expect(results.healthPremiumNet).toBe(7200);
    // IRMAA is priced, but it is its own figure — never inside
    // the base premium.
    expect(results.irmaa.annualHousehold).toBeGreaterThanOrEqual(0);
    expect(results.healthPremiumNet).toBe(7200);
  });

  test("premiums omitted — the single-year tool warns and prices no premium", async () => {
    const envelope = expectEnvelope(
      await dispatchTool(
        "retirement_tax_year",
        fictionalScenario(BENCHMARKS),
      ),
    );
    const results = envelope.results as unknown as {
      healthPremiumGross: number;
      healthPremiumNet: number;
    };
    expect(results.healthPremiumGross).toBe(0);
    expect(results.healthPremiumNet).toBe(0);
    expect(envelope.warnings).toContain(NOT_MODELED);
  });
});
