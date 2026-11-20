// Engine Review 1 — adapter adequacy + pre-retirement-income tests.
//
// The fictional household from helpers.ts throughout (never real
// figures): pretax $1,250,000; taxable $2,100,000; Roth $375,000;
// HSA $62,000; spending $9,500/mo; basis 72%; Social Security
// $36,000/yr at 67 (spouse $18,000/yr at 67); ages 54/52; retire
// 58; end age 95. Each test overrides only the fields its note
// varies.
//
// Run per-file: bun test assistant-api/tests/review1-adequacy.test.ts

import { describe, test, expect } from "bun:test";
import {
  calculateRetirement,
  runRetirementMonteCarlo,
} from "../src/adapter";
import { normalizeInputs, publicEffectiveInputs } from "../src/normalize";
import { dispatchTool, TOOLS } from "../src/tools";
import {
  expectOk,
  fictionalScenario,
  normalizedScenario,
} from "./helpers";

describe("E1-S1 spending adequacy (adapter)", () => {
  test("monte carlo percent + floor: funding 100%, adequacy 26.8%", async () => {
    // The fictional household on the percent strategy (5% of the
    // start-of-year balance) with a $150,000/yr floor, default
    // seed/runs: every simulation funds, but only 26.8% keep every
    // retired year's gross spending at or above $150,000/yr.
    // The floor echoes back in dollars. The rate is exact (268/1000),
    // not rounded to two decimals — rounding would collapse the
    // near-100% band to 1.0 (Engine Review 1, pass 2 SHOULD-1).
    const r = expectOk(
      await runRetirementMonteCarlo(
        normalizedScenario({
          strategy: "percent",
          minimumAnnualSpending: 150000,
        }),
      ),
    );
    expect(r.successRate).toBe(1);
    expect(r.spendingAdequacyRate).toBeCloseTo(0.268, 12);
    expect(r.minimumAnnualSpending).toBe(150000);
  });

  test("monte carlo near-100% adequacy is not rounded up to 1.0", async () => {
    // Floors $14,100–$19,000/yr on the same percent plan: the engine
    // measures 99.9% down to 99.5% adequacy while funding stays 100%.
    // The adapter must report the exact rate (0.999 … 0.995), never
    // 1 — the distinction the feature exists to preserve lives
    // exactly in this band (Engine Review 1, pass 2 SHOULD-1).
    // ($14,100 stands in for the reviewer's lower endpoint, whose
    // literal is scrub-reserved; $14,100 prices identically.)
    const expected = [0.999, 0.998, 0.997, 0.997, 0.996, 0.995];
    // for...of, not forEach: the body awaits the Monte Carlo leg,
    // and a forEach callback cannot be awaited by the test.
    for (const [i, floor] of [
      14100, 15000, 16000, 17000, 18000, 19000,
    ].entries()) {
      const r = expectOk(
        await runRetirementMonteCarlo(
          normalizedScenario({
            strategy: "percent",
            minimumAnnualSpending: floor,
          }),
        ),
      );
      expect(r.successRate).toBe(1);
      expect(r.spendingAdequacyRate).toBeCloseTo(expected[i]!, 12);
      expect(r.spendingAdequacyRate).toBeLessThan(1);
    }
  });

  test("monte carlo without a floor: adequacy null, other figures unchanged", async () => {
    // Parity: the floor adds the rate and nothing else — the
    // success rate and the p50 ending are bit-identical with the
    // floored run above (same seed, same stream).
    const floored = expectOk(
      await runRetirementMonteCarlo(
        normalizedScenario({
          strategy: "percent",
          minimumAnnualSpending: 150000,
        }),
      ),
    );
    const plain = expectOk(
      await runRetirementMonteCarlo(normalizedScenario({ strategy: "percent" })),
    );
    expect(plain.spendingAdequacyRate).toBeNull();
    expect(plain.minimumAnnualSpending).toBeNull();
    expect(plain.successRate).toBe(floored.successRate);
    expect(plain.endingP10).toBe(floored.endingP10);
    expect(plain.endingP50).toBe(floored.endingP50);
    expect(plain.endingP90).toBe(floored.endingP90);
  });

  test("monte carlo floor $0 is no floor", async () => {
    const r = expectOk(
      await runRetirementMonteCarlo(
        normalizedScenario({
          strategy: "percent",
          minimumAnnualSpending: 0,
        }),
      ),
    );
    expect(r.spendingAdequacyRate).toBeNull();
    expect(r.minimumAnnualSpending).toBeNull();
  });

  test("calculate percent + floor: historical adequacy beside the funding rate", async () => {
    // Same household, percent strategy, $150,000/yr floor: the
    // historical cross-check funds every start year (rate 1) while
    // adequacy is 33/57 ≈ 0.5789 — the two rates diverge on the same
    // plan. The rate is exact, not rounded to two decimals (Engine
    // Review 1, pass 2 SHOULD-1).
    const r = expectOk(
      calculateRetirement(
        normalizedScenario({
          strategy: "percent",
          minimumAnnualSpending: 150000,
        }),
      ),
    );
    expect(r.historicalNeverOutRate).toBe(1);
    expect(r.historicalSpendingAdequacyRate).toBeCloseTo(33 / 57, 12);
    expect(r.minimumAnnualSpending).toBe(150000);
  });

  test("calculate constant + floor at spending: adequacy 100% with the caveat warning", async () => {
    // Constant spending ($114k/yr) with the floor at the
    // spending itself: gross never varies, so adequacy reads 1 —
    // and the response warns, in its own words, that this rate
    // cannot see unfunded withdrawals. Funding and ending are
    // identical to the no-floor run: the floor changes no priced
    // figure.
    const floored = calculateRetirement(
      normalizedScenario({ minimumAnnualSpending: 114000 }),
    );
    const plain = expectOk(
      calculateRetirement(normalizedScenario({})),
    );
    const r = expectOk(floored);
    expect(r.historicalSpendingAdequacyRate).toBe(1);
    expect(r.historicalNeverOutRate).toBe(1);
    expect(r.neverRunsOut).toBe(plain.neverRunsOut);
    expect(r.endingBalance).toBe(plain.endingBalance);
    expect(floored.ok && floored.warnings.join(" ")).toContain(
      "constant spending never varies",
    );
    const plainWarnings = calculateRetirement(normalizedScenario({}));
    expect(
      plainWarnings.ok && plainWarnings.warnings.join(" "),
    ).not.toContain("constant spending never varies");
  });

  test("calculate constant + floor above spending: adequacy 0% with no caveat warning", async () => {
    // Constant spending ($114k/yr) with the floor above it
    // ($150k/yr): gross never varies, so adequacy reads 0 — and
    // the caveat warning must NOT fire, because its premise ("with
    // the floor at or below yearly spending, adequacy reads 100%")
    // does not hold here (E1 NICE, pass 1 NICE-2 / pass 2 NICE-1).
    const floored = calculateRetirement(
      normalizedScenario({ minimumAnnualSpending: 150000 }),
    );
    const r = expectOk(floored);
    expect(r.historicalSpendingAdequacyRate).toBe(0);
    expect(floored.ok && floored.warnings.join(" ")).not.toContain(
      "constant spending never varies",
    );
  });

  test("monte carlo constant + floor above spending: adequacy 0% with no caveat warning", async () => {
    // Same gating on the Monte Carlo leg: floor above yearly
    // spending, adequacy 0, no caveat warning.
    const floored = await runRetirementMonteCarlo(
      normalizedScenario({ minimumAnnualSpending: 150000 }),
    );
    const r = expectOk(floored);
    expect(r.spendingAdequacyRate).toBe(0);
    expect(floored.ok && floored.warnings.join(" ")).not.toContain(
      "constant spending never varies",
    );
  });

  test("minimumAnnualSpending is normalized with provenance and echoed", async () => {
    const n = normalizeInputs(
      fictionalScenario({ minimumAnnualSpending: 150000 }),
    );
    expect(n.ok).toBe(true);
    if (!n.ok) throw new Error("unreachable");
    expect(n.scenario.minimumAnnualSpendingCents).toBe(15000000);
    expect(
      n.scenario.assumptions.find(
        (a) => a.field === "minimumAnnualSpending",
      )?.provenance,
    ).toBe("user");
    expect(publicEffectiveInputs(n.scenario).minimumAnnualSpending).toBe(
      150000,
    );
    const omitted = normalizeInputs(fictionalScenario({}));
    expect(omitted.ok).toBe(true);
    if (!omitted.ok) throw new Error("unreachable");
    expect(omitted.scenario.minimumAnnualSpendingCents).toBeNull();
    expect(
      omitted.scenario.assumptions.find(
        (a) => a.field === "minimumAnnualSpending",
      )?.provenance,
    ).toBe("assumption");
  });

  test("capability guide discloses funding vs adequacy", async () => {
    const caps = await dispatchTool("retirement_describe_capabilities", {});
    const guide = expectOk(caps) as unknown as {
      limitations: string[];
      tools: Array<{ name: string; optional: string[]; resultSummary: string }>;
    };
    expect(
      guide.limitations.some((l) =>
        l.includes("Funding success is not spending adequacy"),
      ),
    ).toBe(true);
    expect(
      guide.limitations.some((l) =>
        l.includes("a high funding-success rate is not proof"),
      ),
    ).toBe(true);
    const mc = guide.tools.find((t) => t.name === "retirement_monte_carlo");
    expect(mc?.optional).toContain("minimumAnnualSpending");
    const calc = guide.tools.find((t) => t.name === "retirement_calculate");
    expect(calc?.optional).toContain("minimumAnnualSpending");
    // Max-spending does NOT price the floor: it must not list it,
    // and its description + result summary must say so (Engine
    // Review 1, pass 2 MUST-1 / pass 3 SHOULD-1).
    const max = guide.tools.find(
      (t) => t.name === "retirement_max_spending",
    );
    expect(max?.optional).not.toContain("minimumAnnualSpending");
    const maxTool = TOOLS.find((t) => t.name === "retirement_max_spending");
    expect(maxTool?.description).toContain(
      "minimumAnnualSpending does not change this answer",
    );
    expect(max?.resultSummary).toContain(
      "minimumAnnualSpending does not change this answer",
    );
    const mcTool = TOOLS.find((t) => t.name === "retirement_monte_carlo");
    expect(mcTool?.description).toContain("minimumAnnualSpending");
  });
});

describe("E1-S2 pre-retirement income (adapter)", () => {
  test("income starting before retirement warns and prices like at-retirement", async () => {
    // Primary Social Security $36,000/yr starting at 55, three
    // years before retirement at 58: the response warns that the
    // benefit is not accumulated — and its ending balance and
    // never-runs-out verdict are IDENTICAL to the same benefit
    // starting at 58, pinning that the pre-retirement years add
    // nothing either way.
    const early = calculateRetirement(
      normalizedScenario({ socialSecurityStartAge: 55 }),
    );
    const atRetirement = expectOk(
      calculateRetirement(
        normalizedScenario({ socialSecurityStartAge: 58 }),
      ),
    );
    const r = expectOk(early);
    expect(r.endingBalance).toBe(atRetirement.endingBalance);
    expect(r.neverRunsOut).toBe(atRetirement.neverRunsOut);
    expect(early.ok && early.warnings.join(" ")).toContain(
      "not accumulated",
    );
    expect(early.ok && early.warnings.join(" ")).toContain(
      "retirement_work_years",
    );
  });

  test("income starting at retirement carries no warning", async () => {
    const r = calculateRetirement(
      normalizedScenario({ socialSecurityStartAge: 58 }),
    );
    expect(r.ok && r.warnings.join(" ")).not.toContain("not accumulated");
  });

  test("capability guide discloses the pre-retirement-income limit and the tax-free sim", async () => {
    const caps = await dispatchTool("retirement_describe_capabilities", {});
    const guide = expectOk(caps) as unknown as {
      limitations: string[];
    };
    expect(
      guide.limitations.some((l) =>
        l.includes("Pre-retirement income is not accumulated"),
      ),
    ).toBe(true);
    expect(
      guide.limitations.some((l) =>
        l.includes("tax-free and single-portfolio"),
      ),
    ).toBe(true);
  });
});
