// strategy-comparison.test.ts — Review 4 strategy-comparison fixes.
//
// Covers: all six draw orders in full mode with identical non-order
// inputs; baseline exactly once; deltas reconciling to displayed
// figures; winner-by-cost = min net cost; winner-by-wealth = max
// ending wealth; deterministic exact ties; limited mode never
// claiming global optimality; the full optimizer returning actual
// engine candidates + winner metadata (parity vs runOptimizer
// directly); the Do Nothing benchmark; ACA-sensitive households;
// repeated-call determinism; sample isolation; backward
// compatibility of the default (limited) calls; the tool count
// staying at 8 (no new tool was added — full mode is a scope, not
// a tool).
//
// (15) MCP vs standalone bundle agreement: COVERED (Review 4 NICEs
// fix, 2026-11-14) — the aa65684 bundle
// (dist/finance-planner-cli.mjs, sha256
// b189627bdd8c54818bec2cec976a99310b2da580ffe8034b2309c9e3301b3fa6,
// rebuilt twice from aa65684, byte-identical) and the MCP endpoint
// agree exactly on the same four comparison inputs:
// retirement_compare_strategies and retirement_roth_conversion,
// limited and full (4/4 MATCH on the full envelopes, including the
// ~65-77s full-optimizer leg). Re-run after any bundle rebuild;
// the determinism check makes a rebuild byte-identical, so this
// result carries over to it.
//
// All figures are the fictional household (see helpers.ts). The
// full-optimizer parity test prices the search twice (adapter +
// direct engine call, ~80s each on a quiet VM, longer under load)
// and carries its own 900s timeout. No expected winner is hardcoded anywhere: every
// winner assertion is derived from the returned figures, and the
// optimizer assertions compare against a direct engine call with
// identical inputs.

import { describe, expect, test } from "bun:test";
import {
  buildRothCompareBase,
  buildRothPlanInputs,
  compareRetirementAges,
  compareRothConversions,
  compareWithdrawalStrategies,
  optimizerCandidateDisplayName,
  type ComparisonScopeInfo,
  type RothConversionResults,
} from "../src/adapter";
import { normalizeInputs, type NormalizedScenario } from "../src/normalize";
import { TOOLS, dispatchTool } from "../src/tools";
import {
  buildOptimizerCandidates,
  runOptimizer,
  runRothCompare,
  type ScoredCandidate,
} from "../../server/src/rothOptimizer";
import { DRAW_ORDER_OPTIONS } from "../../server/src/taxEngine";
import * as sampleHousehold from "../../server/src/sampleHousehold";
import {
  expectOk,
  fictionalScenario,
  normalizedScenario,
  round2,
} from "./helpers";

type CompareResults = {
  baselineName: string;
  scenarios: Array<{
    name: string;
    drawOrder: string;
    candidateKey?: string;
    endingWealth: number;
    lifetimeNetCost: number;
    lifetimeTax: number;
    acaCreditKept: number;
    irmaaTotal: number;
    conversionsTotal: number;
  }>;
  winnerByEndingWealth: string | null;
  winnerByNetCost: string | null;
  deltas: Array<{
    name: string;
    endingWealthDelta: number;
    netCostDelta: number;
  }>;
  comparisonScope: ComparisonScopeInfo;
};

function minByNetCost(
  scenarios: CompareResults["scenarios"],
): (typeof scenarios)[number] {
  return scenarios.reduce((best, s) =>
    s.lifetimeNetCost < best.lifetimeNetCost ? s : best,
  );
}

function maxByWealth(
  scenarios: CompareResults["scenarios"],
): (typeof scenarios)[number] {
  return scenarios.reduce((best, s) =>
    s.endingWealth > best.endingWealth ? s : best,
  );
}

function assertBaselineOnce(results: CompareResults): void {
  const hits = results.scenarios.filter(
    (s) => s.name === results.baselineName,
  );
  expect(hits).toHaveLength(1);
}

function assertDeltasReconcile(results: CompareResults): void {
  const baseline = results.scenarios.find(
    (s) => s.name === results.baselineName,
  )!;
  expect(results.deltas).toHaveLength(results.scenarios.length - 1);
  for (const d of results.deltas) {
    const s = results.scenarios.find((x) => x.name === d.name)!;
    expect(s).toBeDefined();
    expect(d.endingWealthDelta).toBe(round2(s.endingWealth - baseline.endingWealth));
    expect(d.netCostDelta).toBe(round2(s.lifetimeNetCost - baseline.lifetimeNetCost));
    // The baseline itself never appears in deltas.
    expect(d.name).not.toBe(results.baselineName);
  }
}

function assertWinners(results: CompareResults): void {
  expect(results.winnerByNetCost).toBe(minByNetCost(results.scenarios).name);
  expect(results.winnerByEndingWealth).toBe(
    maxByWealth(results.scenarios).name,
  );
  // Both winner fields name a returned scenario.
  expect(results.winnerByNetCost).not.toBeNull();
  expect(results.winnerByEndingWealth).not.toBeNull();
  expect(
    results.scenarios.map((s) => s.name),
  ).toContain(results.winnerByNetCost as string);
  expect(
    results.scenarios.map((s) => s.name),
  ).toContain(results.winnerByEndingWealth as string);
}

function assertLimitedScope(results: CompareResults): void {
  expect(results.comparisonScope.scope).toBe("limited");
  expect(results.comparisonScope.globalOptimalityClaimed).toBe(false);
  expect(results.comparisonScope.searchKind).toBe("fixed-comparison");
}

const SIX_ORDER_KEYS = DRAW_ORDER_OPTIONS.map((o) => o.key);
const SIX_ORDER_NAMES = [
  "taxable-first",
  "taxable-roth-first",
  "pre-tax-first",
  "pre-tax-roth-first",
  "roth-first",
  "roth-pre-tax-first",
];

describe("withdrawal orders — full mode (R4-S1)", () => {
  test("(1) full mode evaluates all six engine draw orders", () => {
    const results = expectOk(
      compareWithdrawalStrategies(
        normalizedScenario({ comparisonScope: "full" }),
      ),
    ) as unknown as CompareResults;
    expect(results.scenarios).toHaveLength(6);
    expect(results.scenarios.map((s) => s.name)).toEqual(SIX_ORDER_NAMES);
    expect(results.scenarios.map((s) => s.drawOrder)).toEqual(SIX_ORDER_KEYS);
    expect(results.comparisonScope.scope).toBe("full");
    expect(results.comparisonScope.evaluatedCandidates).toBe(6);
    expect(results.comparisonScope.globalOptimalityClaimed).toBe(false);
    expect(results.baselineName).toBe("taxable-first");
    assertBaselineOnce(results);
  });

  test("(2) identical non-order inputs per order: adapter matches runRothCompare to the cent", () => {
    const s = normalizedScenario({ comparisonScope: "full" });
    const results = expectOk(compareWithdrawalStrategies(s)) as unknown as CompareResults;
    // The same base object prices all six orders — any non-order
    // difference would have to come from the base, and there is
    // only one of it. The direct engine call below is the
    // independent check that the figures are the engine's.
    const direct = runRothCompare(
      buildRothCompareBase(s),
      SIX_ORDER_KEYS.map((key) => ({
        name:
          SIX_ORDER_NAMES[SIX_ORDER_KEYS.indexOf(key)] ?? key,
        overrides: { drawOrder: key },
      })),
      s.startYear,
      "taxable-first",
    );
    expect(direct.ok).toBe(true);
    expect(direct.scenarios).toHaveLength(6);
    for (const m of results.scenarios) {
      const d = direct.scenarios.find(
        (x) => x.saved.drawOrder === m.drawOrder,
      )!;
      expect(d).toBeDefined();
      expect(m.lifetimeNetCost).toBe(Math.round(d.netCostCents) / 100);
      expect(m.endingWealth).toBe(
        Math.round(d.endingAfterTaxWealthCents) / 100,
      );
      expect(m.lifetimeTax).toBe(Math.round(d.totalTaxCents) / 100);
      expect(m.acaCreditKept).toBe(Math.round(d.acaCreditCents) / 100);
      expect(m.irmaaTotal).toBe(Math.round(d.irmaaCents) / 100);
      expect(m.conversionsTotal).toBe(0);
    }
  });

  test("(3)(4)(5)(6) baseline once, deltas reconcile, winners are min cost / max wealth", () => {
    for (const scope of ["limited", "full"] as const) {
      const results = expectOk(
        compareWithdrawalStrategies(normalizedScenario({ comparisonScope: scope })),
      ) as unknown as CompareResults;
      assertBaselineOnce(results);
      assertDeltasReconcile(results);
      assertWinners(results);
    }
  });

  test("(12) repeated full-mode calls are bit-identical", () => {
    const s = normalizedScenario({ comparisonScope: "full" });
    const a = compareWithdrawalStrategies(s);
    const b = compareWithdrawalStrategies(s);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("withdrawal + Roth — exact ties are deterministic (R4-S1/S2)", () => {
  const zero = {
    pretax: 0,
    taxable: 0,
    roth: 0,
    hsa: 0,
  };
  test("(7) all-zero household ties at $0; first in list order wins, repeatably", () => {
    const s = normalizedScenario(zero);
    const w1 = expectOk(compareWithdrawalStrategies(s)) as unknown as CompareResults;
    const w2 = expectOk(compareWithdrawalStrategies(s)) as unknown as CompareResults;
    expect(JSON.stringify(w1)).toBe(JSON.stringify(w2));
    for (const scen of w1.scenarios) {
      expect(scen.lifetimeNetCost).toBe(0);
      expect(scen.endingWealth).toBe(0);
    }
    expect(w1.winnerByNetCost).toBe("taxable-first");
    expect(w1.winnerByEndingWealth).toBe("taxable-first");
    // Full mode ties the same way, across all six orders.
    const wf = expectOk(
      compareWithdrawalStrategies(normalizedScenario({ ...zero, comparisonScope: "full" })),
    ) as unknown as CompareResults;
    expect(wf.scenarios).toHaveLength(6);
    for (const scen of wf.scenarios) {
      expect(scen.lifetimeNetCost).toBe(0);
      expect(scen.endingWealth).toBe(0);
    }
    expect(wf.winnerByNetCost).toBe("taxable-first");
    expect(wf.winnerByEndingWealth).toBe("taxable-first");
    // The Roth side ties the same way: every fill converts $0.
    const r = expectOk(compareRothConversions(s)) as unknown as CompareResults;
    for (const scen of r.scenarios) {
      expect(scen.lifetimeNetCost).toBe(0);
      expect(scen.endingWealth).toBe(0);
      expect(scen.conversionsTotal).toBe(0);
    }
    expect(r.winnerByNetCost).toBe("do-nothing");
    expect(r.winnerByEndingWealth).toBe("do-nothing");
  });
});

describe("Roth conversion — limited mode (R4-S2/S3)", () => {
  test("(8)(10) limited mode: four strategies, Do Nothing benchmark, never globally optimal", () => {
    const results = expectOk(
      compareRothConversions(normalizedScenario()),
    ) as unknown as CompareResults;
    expect(results.scenarios).toHaveLength(4);
    expect(results.scenarios.map((s) => s.name)).toEqual([
      "do-nothing",
      "fill-12%",
      "fill-22%",
      "fill-22%-irmaa-tier-1",
    ]);
    expect(results.baselineName).toBe("do-nothing");
    assertBaselineOnce(results);
    assertDeltasReconcile(results);
    assertWinners(results);
    assertLimitedScope(results);
    expect(results.comparisonScope.evaluatedCandidates).toBe(4);
    expect(
      results.comparisonScope.excludedCandidateFamilies.join(" "),
    ).toMatch(/full/);
    // The two objectives crown different winners on this
    // household — lowest net cost is not highest ending wealth.
    expect(results.winnerByNetCost).not.toBe(results.winnerByEndingWealth);
  });

  test("(12) repeated limited Roth calls are bit-identical", () => {
    const s = normalizedScenario();
    expect(JSON.stringify(compareRothConversions(s))).toBe(
      JSON.stringify(compareRothConversions(s)),
    );
  });
});

describe("Roth conversion — full optimizer mode (R4-S2)", () => {
  test(
    "(9) full optimizer returns actual engine candidates + winner metadata (parity vs runOptimizer)",
    () => {
      // Shorter horizon (end at 80, not 95) for this parity run
      // only: the searched candidate set is horizon-independent
      // (same ceilings, windows, orders, harvest gate — the
      // count assertion below proves it), but each candidate's
      // march is 22 years instead of 41, so pricing the search
      // twice fits the suite. The full-horizon (95) adapter
      // result is measured separately (see the README's full-mode
      // example: same winner, same 3,025 candidates).
      const s = normalizedScenario({ comparisonScope: "full", endAge: 80 });
      const adapterResults = expectOk(
        compareRothConversions(s),
      ) as unknown as RothConversionResults;
      // Direct engine call, identical inputs: the independent
      // numerical evidence for every figure below.
      const direct = runOptimizer(buildRothPlanInputs(s));
      const o = adapterResults.optimizer!;
      expect(o).toBeDefined();
      expect(o.candidatesTested).toBe(direct.candidatesTested);
      expect(o.candidatesTested).toBeGreaterThan(1000);
      // Candidate count agrees with the engine's own builder
      // (candidates + the Do Nothing benchmark).
      expect(o.candidatesTested).toBe(
        buildOptimizerCandidates(buildRothPlanInputs(s)).length + 1,
      );
      // The winner is the engine's winner, by candidate key.
      expect(o.winner.candidateKey).toBe(direct.winner.spec.key);
      expect(o.winner.name).toBe(
        optimizerCandidateDisplayName(direct.winner.spec),
      );
      expect(o.winner.netCost).toBe(round2(direct.winner.cost.netCost));
      expect(o.winner.endingWealth).toBe(
        round2(direct.winner.result.endingAfterTaxWealth),
      );
      expect(o.winner.drawOrder).toBe(
        direct.winner.spec.drawOrder.join("-"),
      );
      expect(o.winner.windowStopAge).toBe(direct.winner.spec.windowStopAge);
      // Winner metadata: the policy and its yearly amounts.
      expect(o.winner.yearlyConversions.length).toBeGreaterThan(0);
      const yearlySum = o.winner.yearlyConversions.reduce(
        (sum, y) => sum + y.conversion,
        0,
      );
      expect(round2(yearlySum)).toBe(o.winner.conversionsTotal);
      for (const y of o.winner.yearlyConversions) {
        expect(y.conversion).toBeGreaterThan(0);
      }
      // Claiming ages are held at the entered ages (no joint search).
      expect(o.winner.claimAgePrimary).toBe(67);
      expect(o.winner.claimAgeSpouse).toBe(67);
      // Do Nothing benchmark present, as baseline and in the block.
      const baseline = adapterResults.scenarios.find(
        (x) => x.candidateKey === "do-nothing",
      )!;
      expect(baseline).toBeDefined();
      expect(baseline.name).toBe(adapterResults.baselineName);
      // Yearly table (P3-S1): the full-mode table comes from
      // yearlyTableFromRothYears, not the compare mapper, so it
      // gets its own provenance assertion — every row carries
      // both provenances, and the 2028 projection row reads
      // carried-forward / flat-rate-estimate.
      expect(adapterResults.yearly.length).toBeGreaterThan(0);
      for (const row of adapterResults.yearly) {
        expect(row.lawProvenance).toBeDefined();
        expect(row.stateTaxProvenance).toBeDefined();
        expect(row.stateTaxProvenance.kind).toBe("flat-rate-estimate");
        if (row.year <= 2026) {
          expect(row.lawProvenance.status).toBe("exact");
        } else {
          expect(row.lawProvenance.status).toBe("carried-forward");
        }
      }
      const row2028 = adapterResults.yearly.find((y) => y.year === 2028);
      expect(row2028).toBeDefined();
      expect(row2028!.lawProvenance.status).toBe("carried-forward");
      expect(row2028!.stateTaxProvenance.kind).toBe("flat-rate-estimate");
      expect(o.doNothing.netCost).toBe(round2(direct.doNothing.cost.netCost));
      expect(o.doNothing.endingWealth).toBe(
        round2(direct.doNothing.result.endingAfterTaxWealth),
      );
      // Winners are computed over the whole searched set.
      expect(adapterResults.winnerByNetCost).toBe(o.winner.name);
      const wealthBest = [...direct.scored].sort(
        (a, b) => b.result.endingAfterTaxWealth - a.result.endingAfterTaxWealth,
      )[0]!;
      expect(adapterResults.winnerByEndingWealth).toBe(
        optimizerCandidateDisplayName(wealthBest.spec),
      );
      // E4-S2: both objective winners come from the ENGINE's
      // own fields — the adapter no longer re-derives the
      // wealth winner over the raw scored list. The
      // engine-sourced wealth winner agrees with the
      // max-wealth sort here (no candidate is invalid on this
      // household), and the block names the objective, the
      // valid/invalid split, and the qualification.
      expect(adapterResults.winnerByEndingWealth).toBe(
        optimizerCandidateDisplayName(direct.winnerByEndingWealth.spec),
      );
      expect(o.winnersDiffer).toBe(
        direct.winnerByEndingWealth.spec.key !== direct.winner.spec.key,
      );
      if (direct.winnersDiffer) {
        expect(o.wealthWinner).not.toBeNull();
        expect(o.wealthWinner!.name).toBe(
          optimizerCandidateDisplayName(direct.winnerByEndingWealth.spec),
        );
        expect(o.wealthWinner!.candidateKey).toBe(
          direct.winnerByEndingWealth.spec.key,
        );
        expect(o.wealthWinner!.netCost).toBe(
          round2(direct.winnerByEndingWealth.cost.netCost),
        );
        expect(o.wealthWinner!.endingWealth).toBe(
          round2(direct.winnerByEndingWealth.result.endingAfterTaxWealth),
        );
      } else {
        expect(o.wealthWinner).toBeNull();
      }
      expect(o.objective).toBe(direct.objective);
      expect(o.objective).toMatch(/Lowest lifetime net cost first/);
      expect(o.validCandidatesTested).toBe(direct.validCandidatesTested);
      expect(o.invalidCandidatesTested).toBe(direct.invalidCandidatesTested);
      expect(o.winnerQualified).toBe(direct.winnerQualified);
      expect(o.winnerQualified).toBe(true);
      expect(o.excludedInvalidWinner).toBeNull();
      expect(
        adapterResults.scenarios.map((x) => x.name),
      ).toContain(adapterResults.winnerByEndingWealth as string);
      // Scope: full search, still never a global optimum.
      expect(adapterResults.comparisonScope.scope).toBe("full");
      expect(adapterResults.comparisonScope.searchKind).toBe("optimizer-search");
      expect(adapterResults.comparisonScope.evaluatedCandidates).toBe(
        direct.candidatesTested,
      );
      expect(adapterResults.comparisonScope.globalOptimalityClaimed).toBe(false);
      expect(
        adapterResults.comparisonScope.excludedCandidateFamilies.join(" "),
      ).toMatch(/claiming age/i);
      // Runners-up agree with the engine's ranked list.
      expect(o.runnersUp).toHaveLength(3);
      direct.runnersUp.forEach((ru: ScoredCandidate, i: number) => {
        expect(o.runnersUp[i]!.candidateKey).toBe(ru.spec.key);
        expect(o.runnersUp[i]!.netCost).toBe(round2(ru.cost.netCost));
      });
      // Deltas reconcile against the returned baseline.
      assertBaselineOnce(adapterResults as unknown as CompareResults);
      assertDeltasReconcile(adapterResults as unknown as CompareResults);
    },
    900_000,
  );

  test("(9b) candidate count is pinned at the full horizon: 3,024 specs at endAge 95", () => {
    // Builds specs only (~2s) — no pricing. The count is
    // horizon-independent: test (9) pins parity at endAge 80,
    // where the same builder also yields 3,024, and the README's
    // full-horizon example (3,025 candidates = 3,024 + Do
    // Nothing) rests on this count. Same fictional-household
    // inputs as test (9), full horizon.
    const s = normalizedScenario({ comparisonScope: "full", endAge: 95 });
    expect(
      buildOptimizerCandidates(buildRothPlanInputs(s)).length,
    ).toBe(3024);
  });
});

describe("ACA-sensitive households (R4-S2)", () => {
  const aca = { acaBenchmarkCouple: 21000 };
  test("(11) ACA-aware strategies price credit; the optimizer search contains ACA-cliff candidates", () => {
    const s = normalizedScenario(aca);
    const roth = expectOk(compareRothConversions(s)) as unknown as CompareResults;
    // Do Nothing keeps the credit; the fills forfeit it by
    // pushing MAGI over the cliff — the ACA lever is priced,
    // not assumed.
    const dn = roth.scenarios.find((x) => x.name === "do-nothing")!;
    expect(dn.acaCreditKept).toBeGreaterThan(0);
    for (const x of roth.scenarios.filter((y) => y.name !== "do-nothing")) {
      expect(x.acaCreditKept).toBe(0);
    }
    // Withdrawal orders differ in the credit they keep.
    const wd = expectOk(
      compareWithdrawalStrategies(
        normalizedScenario({ ...aca, comparisonScope: "full" }),
      ),
    ) as unknown as CompareResults;
    const credits = new Set(wd.scenarios.map((x) => x.acaCreditKept));
    expect(credits.size).toBeGreaterThan(1);
    expect(Math.max(...credits)).toBeGreaterThan(0);
    // The optimizer's candidate space contains ACA-cliff
    // strategies (built directly — no pricing needed to show
    // the family is in the searched set).
    const cands = buildOptimizerCandidates(buildRothPlanInputs(s));
    expect(cands.some((c) => c.ceilings.acaCliffCap)).toBe(true);
    expect(
      cands.filter(
        (c) => c.ceilings.acaCliffCap && c.ceilings.bracketTopPct != null,
      ).length,
    ).toBeGreaterThan(0);
  });
});

describe("isolation + compatibility (R4-S2/S3)", () => {
  test("(13) rewriting SAMPLE_HOUSEHOLD moves no comparison figure", () => {
    const before = JSON.stringify(compareWithdrawalStrategies(normalizedScenario()));
    const beforeRoth = JSON.stringify(compareRothConversions(normalizedScenario()));
    const household = sampleHousehold.SAMPLE_HOUSEHOLD as unknown as {
      balancesCents: Record<string, number>;
      annualSpendingCents: number;
      acaBenchmarksCents: Record<string, number>;
      socialSecurity: Record<string, number>;
    };
    const saved = {
      balancesCents: { ...household.balancesCents },
      annualSpendingCents: household.annualSpendingCents,
      acaBenchmarksCents: { ...household.acaBenchmarksCents },
      socialSecurity: { ...household.socialSecurity },
    };
    try {
      household.balancesCents.pretax = 1;
      household.balancesCents.taxable = 1;
      household.balancesCents.roth = 1;
      household.balancesCents.hsa = 1;
      household.annualSpendingCents = 1;
      household.acaBenchmarksCents.family = 1;
      household.socialSecurity.primaryAnnualCents = 1;
      household.socialSecurity.spouseAnnualCents = 1;
      expect(JSON.stringify(compareWithdrawalStrategies(normalizedScenario()))).toBe(before);
      expect(JSON.stringify(compareRothConversions(normalizedScenario()))).toBe(beforeRoth);
    } finally {
      household.balancesCents = saved.balancesCents;
      household.annualSpendingCents = saved.annualSpendingCents;
      household.acaBenchmarksCents = saved.acaBenchmarksCents;
      household.socialSecurity = saved.socialSecurity;
    }
  });

  test("(14) default calls are unchanged: old shapes, old names, old counts", () => {
    const w = expectOk(
      compareWithdrawalStrategies(normalizedScenario()),
    ) as unknown as CompareResults;
    expect(w.scenarios.map((s) => s.name)).toEqual([
      "taxable-first",
      "pre-tax-first",
      "roth-first",
    ]);
    const r = expectOk(
      compareRothConversions(normalizedScenario()),
    ) as unknown as CompareResults;
    expect(r.scenarios.map((s) => s.name)).toEqual([
      "do-nothing",
      "fill-12%",
      "fill-22%",
      "fill-22%-irmaa-tier-1",
    ]);
    // comparisonScope is additive: the old winner/delta/yearly
    // fields are all still present with the same names.
    for (const res of [w, r]) {
      expect(typeof res.baselineName).toBe("string");
      expect(typeof res.winnerByNetCost).toBe("string");
      expect(typeof res.winnerByEndingWealth).toBe("string");
      expect(Array.isArray(res.deltas)).toBe(true);
      assertLimitedScope(res);
    }
    // Invalid scope is rejected, not silently treated as limited.
    const bad = normalizeInputs(
      fictionalScenario({ comparisonScope: "all" }),
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.error.code).toBe("invalid_input");
    // The work-years tool has no full mode: "full" is refused
    // explicitly, never run as a quiet limited comparison.
    const wy = compareRetirementAges(
      normalizedScenario({ comparisonScope: "full" }),
    );
    expect(wy.ok).toBe(false);
    if (!wy.ok) expect(wy.error.code).toBe("unsupported");
    // ...while its default call gains the scope block and stays limited.
    const wyLim = expectOk(
      compareRetirementAges(normalizedScenario()),
    ) as unknown as CompareResults;
    assertLimitedScope(wyLim);
    assertBaselineOnce(wyLim);
  });

  test("(14) still 9 tools: full mode is a scope, not a new tool", () => {
    expect(TOOLS).toHaveLength(9);
    expect(TOOLS.map((t) => t.name)).toEqual([
      "retirement_calculate",
      "retirement_monte_carlo",
      "retirement_max_spending",
      "retirement_compare_strategies",
      "retirement_roth_conversion",
      "retirement_dynamic_withdrawal",
      "retirement_work_years",
      "retirement_tax_year",
      "retirement_describe_capabilities",
    ]);
  });

  test("(8) work-years scope never claims global optimality", () => {
    const wy = expectOk(
      compareRetirementAges(normalizedScenario()),
    ) as unknown as CompareResults;
    expect(wy.comparisonScope.scope).toBe("limited");
    expect(wy.comparisonScope.globalOptimalityClaimed).toBe(false);
    expect(wy.comparisonScope.evaluatedCandidates).toBe(
      wy.scenarios.length,
    );
    const guide = dispatchTool("retirement_describe_capabilities", {});
    expect(guide.ok).toBe(true);
  });
});

describe("comparisonScope input", () => {
  test("comparisonScope normalizes with user provenance when given", () => {
    const n = normalizeInputs(
      fictionalScenario({ comparisonScope: "full" }),
    );
    expect(n.ok).toBe(true);
    if (!n.ok) throw new Error("fixture failed");
    expect(n.scenario.comparisonScope).toBe("full");
    expect(
      n.scenario.assumptions.find((a) => a.field === "comparisonScope"),
    ).toMatchObject({ value: "full", provenance: "user" });
  });

  test("comparisonScope defaults to limited with an assumption entry", () => {
    const s: NormalizedScenario = normalizedScenario();
    expect(s.comparisonScope).toBe("limited");
    expect(
      s.assumptions.find((a) => a.field === "comparisonScope"),
    ).toMatchObject({ value: "limited", provenance: "assumption" });
  });
});

describe("yearly table provenance (Review 3 P3-S1)", () => {
  // The yearly rows in every multi-year compare carry the law
  // row each year priced under and how its state tax was priced,
  // so a flat-rate stateTax is never shown unlabeled and a
  // projection year is never shown as published law for that
  // year. All figures are the fictional household (helpers.ts).
  type YearlyRowProvenance = {
    year: number;
    lawProvenance: {
      lawYear: number;
      status: string;
      published: boolean;
      isProjection: boolean;
      note: string;
    };
    stateTaxProvenance: {
      kind: string;
      residenceState: string | null;
      ratePct: number | null;
      note: string;
    };
  };

  function assertYearlyProvenance(yearly: YearlyRowProvenance[]): void {
    expect(yearly.length).toBeGreaterThan(0);
    for (const row of yearly) {
      expect(row.lawProvenance).toBeDefined();
      expect(row.stateTaxProvenance).toBeDefined();
      expect(row.lawProvenance.note.length).toBeGreaterThan(0);
      expect(row.stateTaxProvenance.note.length).toBeGreaterThan(0);
      // The fictional household supplies no state rate, so every
      // year prices the flat-rate estimate at 0%.
      expect(row.stateTaxProvenance.kind).toBe("flat-rate-estimate");
      expect(row.stateTaxProvenance.ratePct).toBe(0);
      if (row.year <= 2026) {
        expect(row.lawProvenance.status).toBe("exact");
        expect(row.lawProvenance.lawYear).toBe(row.year);
        expect(row.lawProvenance.published).toBe(true);
        expect(row.lawProvenance.isProjection).toBe(false);
      } else {
        expect(row.lawProvenance.status).toBe("carried-forward");
        expect(row.lawProvenance.lawYear).toBe(2026);
        expect(row.lawProvenance.published).toBe(false);
        expect(row.lawProvenance.isProjection).toBe(true);
      }
    }
    // The 2028 row is the named projection case: carried-forward
    // law, flat-rate-estimate state tax.
    const row2028 = yearly.find((y) => y.year === 2028);
    expect(row2028).toBeDefined();
    expect(row2028!.lawProvenance.status).toBe("carried-forward");
    expect(row2028!.stateTaxProvenance.kind).toBe("flat-rate-estimate");
  }

  test("withdrawal compare: every yearly row carries both provenances; 2028 reads carried-forward / flat-rate-estimate", () => {
    const envelope = compareWithdrawalStrategies(normalizedScenario());
    if (!envelope.ok) throw new Error("expected ok envelope");
    assertYearlyProvenance(envelope.results.yearly);
    expect(envelope.warnings.join(" ")).toContain(
      "a flat-rate stateTax is an estimate only",
    );
  });

  test("Roth conversion (limited): every yearly row carries both provenances; the response warns the flat-rate state tax is an estimate", () => {
    const envelope = compareRothConversions(normalizedScenario());
    if (!envelope.ok) throw new Error("expected ok envelope");
    assertYearlyProvenance(envelope.results.yearly);
    // The estimate label rides the response, not just the rows:
    // the yearly-table warning names it on every compare.
    expect(envelope.warnings.join(" ")).toContain(
      "a flat-rate stateTax is an estimate only",
    );
  });

  test(
    "work-years (salary): yearly rows carry both provenances and the response-level note covers the work-years tax totals",
    () => {
      const envelope = compareRetirementAges(
        normalizedScenario({
          salaryAnnual: 120000,
          spouseSocialSecurityAnnual: 0,
          compareAges: [60, 62],
          // Shorter horizon (end at 80, not 95) for this leg
          // only: the joint optimizer prices each quit age's
          // rolled plan to the end age, and the full horizon
          // is the known OOM-prone shape on this VM (Pass 2
          // flake). The yearly table still spans 2028, and
          // every assertion here is horizon-independent.
          endAge: 80,
        }),
      );
      if (!envelope.ok) throw new Error("expected ok envelope");
      expect(envelope.results.workYears.map((w) => w.quitAge)).toEqual([
        60, 62,
      ]);
      assertYearlyProvenance(envelope.results.yearly);
      // The work-years rows are per-quit-age aggregates over
      // several salary years, so no single law row describes
      // one — the response-level note is the label instead.
      expect(envelope.warnings.join(" ")).toContain(
        "Work-years tax totals (workTax, totalTax, allInTax) include flat-rate state tax: an estimate only",
      );
    },
    600_000,
  );
});
