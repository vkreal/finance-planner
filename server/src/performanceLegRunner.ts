// Engine Review C7 (§8) — fresh-process benchmark leg runner.
//
// Usage: bun server/src/performanceLegRunner.ts <leg>
//   leg: fixedAge | joint | compare | mc | solver | workYears
//
// Runs ONE benchmark leg in this fresh process and prints exactly
// one JSON object to stdout: the leg name and the measured runs
// (CPU ms + heap delta + the small pins the harness asserts).
// Anything else goes to stderr, and a failure exits non-zero —
// stdout stays parseable JSON.
//
// WHY a fresh process (SHOULD-2): the harness used to measure in
// the test process, where process.cpuUsage() is process-wide, so
// garbage-collection / JIT CPU from OTHER legs' retained results
// landed inside a leg's window — idle windows with zero leg work
// read tens to hundreds of milliseconds of CPU, and two full-file
// runs failed untouched budgets with ~13 s readings on legs whose
// own CPU is ~50 ms–1.5 s. In this process no other leg's retained
// graph exists, so no cross-leg collection can land in the window.
// The test spawns this runner twice per leg and asserts the
// MINIMUM CPU over the two attempts (see
// performanceRegression.test.ts).

import {
  runJointOptimizer,
  runOptimizer,
  runRothCompare,
} from "./rothOptimizer";
import { samplePlanInputs } from "./sampleHousehold";
import { runMonteCarlo, solveMaxSpending } from "./retirementEngines";
import { runWorkYearsCompare } from "./workYears";
import {
  ceil,
  jointDigest,
  jointSmall,
  measure,
  optimizerDigest,
  sampleCompareBase,
  sampleRetirement,
  small5y,
} from "./performanceShapes";

export type LegName =
  | "fixedAge"
  | "joint"
  | "compare"
  | "mc"
  | "solver"
  | "workYears";

const LEG_NAMES: LegName[] = [
  "fixedAge",
  "joint",
  "compare",
  "mc",
  "solver",
  "workYears",
];

export interface FixedAgeRun {
  kind: "run";
  cpuMs: number;
  heapDeltaMb: number;
  candidatesTested: number;
  winnerNetCost: number | null;
  digest: string;
}

export interface JointRun {
  kind: "cold" | "hit";
  cpuMs: number;
  heapDeltaMb: number;
  combosTested: number | undefined;
  candidatesTested: number;
  winnerNetCost: number | null;
  digest: string;
}

export interface CompareScenario {
  name: string;
  netCostCents: number;
  totalTaxCents: number;
  years: number;
}

export interface CompareRun {
  kind: "run";
  cpuMs: number;
  heapDeltaMb: number;
  ok: boolean;
  scenarios: CompareScenario[];
}

export interface McRun {
  kind: "run";
  cpuMs: number;
  heapDeltaMb: number;
  successRate: number | null;
  neverOutSuccessRate: number | null;
  p50: number | null;
  resultJson: string;
}

export interface SolverRun {
  kind: "run";
  cpuMs: number;
  heapDeltaMb: number;
  solutionStatus: string | null;
  maxSpendingCents: number | null;
  successRate: number | null;
  resultJson: string;
}

export interface WorkYearsRow {
  quitAge: number;
  workYears: number;
  allInTax: number;
  endingAfterTax: number;
  totalTax: number;
}

export interface WorkYearsRun {
  kind: "run";
  cpuMs: number;
  heapDeltaMb: number;
  rows: WorkYearsRow[];
}

export type LegOutput =
  | { leg: "fixedAge"; runs: [FixedAgeRun] }
  | { leg: "joint"; runs: [JointRun, JointRun] }
  | { leg: "compare"; runs: [CompareRun] }
  | { leg: "mc"; runs: [McRun] }
  | { leg: "solver"; runs: [SolverRun] }
  | { leg: "workYears"; runs: [WorkYearsRun] };

function fixedAge(): LegOutput {
  const r = measure(() => runOptimizer(small5y(), { searchOrders: false }));
  return {
    leg: "fixedAge",
    runs: [
      {
        kind: "run",
        cpuMs: r.cpuMs,
        heapDeltaMb: r.heapDeltaMb,
        candidatesTested: r.out.candidatesTested,
        winnerNetCost: r.out.selectedWinner?.cost.netCost ?? null,
        digest: optimizerDigest(r.out),
      },
    ],
  };
}

function joint(): LegOutput {
  const cold = measure(() => runJointOptimizer(jointSmall()));
  const hit = measure(() => runJointOptimizer(jointSmall()));
  return {
    leg: "joint",
    runs: [
      {
        kind: "cold",
        cpuMs: cold.cpuMs,
        heapDeltaMb: cold.heapDeltaMb,
        combosTested: cold.out.jointSearch?.combosTested,
        candidatesTested: cold.out.candidatesTested,
        winnerNetCost: cold.out.selectedWinner?.cost.netCost ?? null,
        digest: jointDigest(cold.out),
      },
      {
        kind: "hit",
        cpuMs: hit.cpuMs,
        heapDeltaMb: hit.heapDeltaMb,
        combosTested: hit.out.jointSearch?.combosTested,
        candidatesTested: hit.out.candidatesTested,
        winnerNetCost: hit.out.selectedWinner?.cost.netCost ?? null,
        digest: jointDigest(hit.out),
      },
    ],
  };
}

function compare(): LegOutput {
  const run = () =>
    runRothCompare(
      sampleCompareBase() as never,
      [
        { name: "Do Nothing", overrides: {} },
        { name: "Fill 12%", overrides: { ceilings: ceil(12) } },
        { name: "Fill 22%", overrides: { ceilings: ceil(22) } },
      ] as never,
      2026,
      "Do Nothing",
    );
  const r = measure(run);
  const scenarios: CompareScenario[] = r.out.ok
    ? r.out.scenarios.map((s) => ({
        name: s.name,
        netCostCents: s.netCostCents,
        totalTaxCents: s.totalTaxCents,
        years: s.years.length,
      }))
    : [];
  return {
    leg: "compare",
    runs: [
      {
        kind: "run",
        cpuMs: r.cpuMs,
        heapDeltaMb: r.heapDeltaMb,
        ok: r.out.ok,
        scenarios,
      },
    ],
  };
}

function mc(): LegOutput {
  const built = sampleRetirement();
  const r = measure(() =>
    runMonteCarlo(built.inputs, built.expected, built.vol, 12345, 1000),
  );
  return {
    leg: "mc",
    runs: [
      {
        kind: "run",
        cpuMs: r.cpuMs,
        heapDeltaMb: r.heapDeltaMb,
        successRate: r.out?.successRate ?? null,
        neverOutSuccessRate: r.out?.neverOutSuccessRate ?? null,
        p50: r.out?.p50 ?? null,
        resultJson: JSON.stringify(r.out),
      },
    ],
  };
}

function solver(): LegOutput {
  const built = sampleRetirement();
  const r = measure(() =>
    solveMaxSpending(
      built.inputs,
      built.stocks,
      built.expected,
      built.vol,
      "montecarlo",
      85,
      12345,
    ),
  );
  return {
    leg: "solver",
    runs: [
      {
        kind: "run",
        cpuMs: r.cpuMs,
        heapDeltaMb: r.heapDeltaMb,
        solutionStatus: r.out?.solutionStatus ?? null,
        maxSpendingCents: r.out?.maxSpendingCents ?? null,
        successRate: r.out?.successRate ?? null,
        resultJson: JSON.stringify(r.out),
      },
    ],
  };
}

function workYears(): LegOutput {
  // Small shape: 4-year horizon (ages 62→66) with both SS benefits
  // already claiming (start ages 58/56), so the rolled joint search
  // is 1 combo. The unlocked-SS variant of this shape searches ~72
  // claiming-age combos and was still running after 10+ minutes in
  // probe B — that is the precedent test's shape
  // (workYearsReview7Hsa.test.ts §4, 900 s timeout), not a harness
  // shape.
  const plan = samplePlanInputs({
    endAgePrimary: 66,
    windowStartAge: 62,
    windowStopAge: 64,
    retirementAge: 62,
    ssPrimaryStartAge: 58,
    ssSpouseStartAge: 56,
  });
  const job = {
    salary: 100000,
    employer401k: 0,
    employerHsa: 0,
    hsaCoverage: "family" as const,
    hsaEligible: true,
    priorYearWages: 90000,
  };
  const r = measure(() => runWorkYearsCompare(plan, job, [63]));
  return {
    leg: "workYears",
    runs: [
      {
        kind: "run",
        cpuMs: r.cpuMs,
        heapDeltaMb: r.heapDeltaMb,
        rows: r.out.map((row) => ({
          quitAge: row.quitAge,
          workYears: row.workYears,
          allInTax: row.allInTax,
          endingAfterTax: row.endingAfterTax,
          totalTax: row.totalTax,
        })),
      },
    ],
  };
}

const LEGS: Record<LegName, () => LegOutput> = {
  fixedAge,
  joint,
  compare,
  mc,
  solver,
  workYears,
};

function main(): void {
  const leg = process.argv[2] as LegName | undefined;
  if (!leg || !LEG_NAMES.includes(leg)) {
    console.error(
      `usage: bun server/src/performanceLegRunner.ts <leg> (one of ${LEG_NAMES.join(", ")})`,
    );
    process.exit(1);
  }
  try {
    const out = LEGS[leg]();
    console.log(JSON.stringify(out));
  } catch (err) {
    console.error(`leg runner ${leg} failed:`, err);
    process.exit(1);
  }
}

main();
