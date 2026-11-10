/* ---------------- ACA boundary pins ----------------
   Part 2 of the hardening block (boundary-case fixture
   pack). ACA §36B credit pins: the cliff, the 100% FPL
   floor, the discontinuous 133% band edge, and every
   other band edge — each priced by the engine
   (acaCreditFor) and by the independent second
   implementation (acaCreditIndependent), diffed to the
   cent, AND checked against a hand-derived expected
   credit computed from the published band tables below
   (never from engine source). A pin that fails is a
   FINDING, never a reason to loosen the pin.

   Construction (all MAGIs in dollars; with no Social
   Security, no tax-exempt interest, and no gains, MAGI
   is the other-ordinary figure the pin passes in):
   - fpl = fplFor(householdSize, coverageYear - 1); the
     cliff is 4 x fpl and applies 2026 on; 2025 prices
     under the enhanced schedule with NO cliff (a flat
     8.5% applicable percentage above 400% FPL).
   - Bands are LOWER-INCLUSIVE; the last band takes its
     top edge, so exactly 400% FPL still pays a credit
     and 1c above it pays $0 (2026+).
   - Credit = r2(max(0, benchmark - applicablePct% x
     MAGI)), where the applicable percentage is the RAW
     interpolated value (the engine rounds it only for
     display); the hand derivation below interpolates
     from the same raw percentage.
   - Benchmarks are the fictional sample household's
     (server/src/sampleHousehold.ts): single $17,500,
     couple $25,000, family (3+) $36,000.
   - The 133% edge is the ONE discontinuous edge: at
     exactly 133% FPL the second band's initial
     percentage prices (3.14% in 2026, 3.23% in 2027);
     1c below, the first band's final prices (2.10% /
     2.15%). Note the float wrinkle, verified against
     the engine: for 2025 HH1/HH3 and 2027/2028 HH1/HH3
     the cent-rounded 1.33 x FPL MAGI computes to a
     pctFpl a hair BELOW 133 (132.99999999999997), so
     the first band prices there too — the pin derives
     its expectation from the ACTUAL float pctFpl, and
     the +1c pin above the edge covers the true
     discontinuity for those combos. */

import { acaCreditFor } from "../taxEngine";
import { fplFor } from "../taxLaw";
import { acaCreditIndependent } from "./independentAcaCredit";
import {
  SAMPLE_ACA_BENCHMARK_COUPLE_CENTS,
  SAMPLE_ACA_BENCHMARK_FAMILY_CENTS,
  SAMPLE_ACA_BENCHMARK_SINGLE_CENTS,
} from "../sampleHousehold";
import type {
  HardeningCheckModule,
  HardeningCheckResult,
  HardeningTeethResult,
} from "./types";

function roundCent(n: number): number {
  return Math.round(n * 100) / 100;
}

/* The published applicable-percentage tables the pins
   are hand-derived from (Rev. Proc. 2024-35 for 2025,
   Rev. Proc. 2025-25 §3.01 for 2026, Rev. Proc. 2026-26
   for 2027). 2028 prices on the 2026 row (the newest
   complete law row), never on the 2027 percentages.
   Each entry: the band's top edge in % of FPL and its
   initial/final percentages. */
type AcaBandPin = { upToPctFpl: number; initialPct: number; finalPct: number };
const BAND_TABLES: Record<number, AcaBandPin[]> = {
  2025: [
    { upToPctFpl: 133, initialPct: 0, finalPct: 0 },
    { upToPctFpl: 150, initialPct: 0, finalPct: 0 },
    { upToPctFpl: 200, initialPct: 0, finalPct: 2.0 },
    { upToPctFpl: 250, initialPct: 2.0, finalPct: 4.0 },
    { upToPctFpl: 300, initialPct: 4.0, finalPct: 6.0 },
    { upToPctFpl: 400, initialPct: 6.0, finalPct: 8.5 },
  ],
  2026: [
    { upToPctFpl: 133, initialPct: 2.1, finalPct: 2.1 },
    { upToPctFpl: 150, initialPct: 3.14, finalPct: 4.19 },
    { upToPctFpl: 200, initialPct: 4.19, finalPct: 6.6 },
    { upToPctFpl: 250, initialPct: 6.6, finalPct: 8.44 },
    { upToPctFpl: 300, initialPct: 8.44, finalPct: 9.96 },
    { upToPctFpl: 400, initialPct: 9.96, finalPct: 9.96 },
  ],
  2027: [
    { upToPctFpl: 133, initialPct: 2.15, finalPct: 2.15 },
    { upToPctFpl: 150, initialPct: 3.23, finalPct: 4.3 },
    { upToPctFpl: 200, initialPct: 4.3, finalPct: 6.78 },
    { upToPctFpl: 250, initialPct: 6.78, finalPct: 8.66 },
    { upToPctFpl: 300, initialPct: 8.66, finalPct: 10.22 },
    { upToPctFpl: 400, initialPct: 10.22, finalPct: 10.22 },
  ],
};

const BAND_LOWS = [0, 133, 150, 200, 250, 300];

/* Hand-derived expectation for one MAGI: the raw
   interpolated applicable percentage (from the actual
   float pctFpl, lower-inclusive bands, last band taking
   its top edge), the cent-rounded credit, and the cliff
   flag. Returns null only for a year with no table. */
function deriveExpected(
  magi: number,
  householdSize: number,
  coverageYear: number,
  benchmark: number,
): {
  credit: number;
  applicablePct: number;
  overCliff: boolean;
} | null {
  const bands = BAND_TABLES[coverageYear] ?? BAND_TABLES[2026];
  if (!bands) return null;
  const fpl = fplFor(householdSize, coverageYear - 1);
  const cliff = 4 * fpl;
  const pctFpl = fpl > 0 ? (magi / fpl) * 100 : 0;
  const hasCliff = coverageYear >= 2026;
  const overCliff = hasCliff && magi > cliff;
  if (overCliff || pctFpl < 100) {
    return { credit: 0, applicablePct: 0, overCliff };
  }
  let rawPct = bands[bands.length - 1]?.finalPct ?? 9.96;
  for (let i = 0; i < bands.length; i++) {
    const band = bands[i];
    if (!band) continue;
    if (pctFpl < band.upToPctFpl || i === bands.length - 1) {
      const lo = BAND_LOWS[i] ?? 0;
      const span = band.upToPctFpl - lo;
      const frac =
        span > 0 ? Math.min(1, Math.max(0, (pctFpl - lo) / span)) : 0;
      rawPct = band.initialPct + (band.finalPct - band.initialPct) * frac;
      break;
    }
  }
  return {
    credit: roundCent(Math.max(0, benchmark - (rawPct / 100) * magi)),
    applicablePct: roundCent(rawPct),
    overCliff: false,
  };
}

function benchmarkFor(householdSize: number): number {
  if (householdSize <= 1)
    return SAMPLE_ACA_BENCHMARK_SINGLE_CENTS / 100;
  if (householdSize === 2)
    return SAMPLE_ACA_BENCHMARK_COUPLE_CENTS / 100;
  return SAMPLE_ACA_BENCHMARK_FAMILY_CENTS / 100;
}

type AcaPin = {
  id: string;
  magi: number;
  householdSize: number;
  coverageYear: number;
  benchmark: number;
  expectedCredit: number;
  expectedApplicablePct: number;
  expectedOverCliff: boolean;
};

type PinKind =
  | "cliff-at"
  | "cliff-plus-1c"
  | "fpl-at"
  | "fpl-below-1c"
  | "edge133-at"
  | "edge133-plus-1c"
  | "edge133-below-1c"
  | "band150-at"
  | "band150-below-1c"
  | "band200-at"
  | "band200-below-1c"
  | "band250-at"
  | "band250-below-1c"
  | "band300-at"
  | "band300-below-1c";

const ALL_KINDS: PinKind[] = [
  "cliff-at",
  "cliff-plus-1c",
  "fpl-at",
  "fpl-below-1c",
  "edge133-at",
  "edge133-plus-1c",
  "edge133-below-1c",
  "band150-at",
  "band150-below-1c",
  "band200-at",
  "band200-below-1c",
  "band250-at",
  "band250-below-1c",
  "band300-at",
  "band300-below-1c",
];

function magiForKind(
  kind: PinKind,
  householdSize: number,
  coverageYear: number,
): number {
  const fpl = fplFor(householdSize, coverageYear - 1);
  switch (kind) {
    case "cliff-at":
      return 4 * fpl;
    case "cliff-plus-1c":
      return 4 * fpl + 0.01;
    case "fpl-at":
      return fpl;
    case "fpl-below-1c":
      return roundCent(fpl - 0.01);
    case "edge133-at":
      return roundCent(1.33 * fpl);
    case "edge133-plus-1c":
      return roundCent(1.33 * fpl) + 0.01;
    case "edge133-below-1c":
      return roundCent(roundCent(1.33 * fpl) - 0.01);
    case "band150-at":
      return roundCent(1.5 * fpl);
    case "band150-below-1c":
      return roundCent(roundCent(1.5 * fpl) - 0.01);
    case "band200-at":
      return 2 * fpl;
    case "band200-below-1c":
      return roundCent(2 * fpl - 0.01);
    case "band250-at":
      return roundCent(2.5 * fpl);
    case "band250-below-1c":
      return roundCent(roundCent(2.5 * fpl) - 0.01);
    case "band300-at":
      return 3 * fpl;
    case "band300-below-1c":
      return roundCent(3 * fpl - 0.01);
  }
}

function pinsFor(
  householdSize: number,
  coverageYear: number,
  kinds: PinKind[],
): AcaPin[] {
  const benchmark = benchmarkFor(householdSize);
  const pins: AcaPin[] = [];
  for (const kind of kinds) {
    const magi = magiForKind(kind, householdSize, coverageYear);
    const expected = deriveExpected(magi, householdSize, coverageYear, benchmark);
    if (!expected) continue;
    pins.push({
      id: `aca-hh${householdSize}-y${coverageYear}-${kind}`,
      magi,
      householdSize,
      coverageYear,
      benchmark,
      expectedCredit: expected.credit,
      expectedApplicablePct: expected.applicablePct,
      expectedOverCliff: expected.overCliff,
    });
  }
  return pins;
}

function buildFastPins(): AcaPin[] {
  return [
    // The full edge set for the sample couple in 2026.
    ...pinsFor(2, 2026, ALL_KINDS),
    // Cliff pairs for the largest and smallest households.
    ...pinsFor(5, 2026, ["cliff-at", "cliff-plus-1c"]),
    ...pinsFor(1, 2026, ["cliff-at"]),
    // 2025: no cliff above 400% FPL.
    ...pinsFor(2, 2025, ["cliff-at", "cliff-plus-1c"]),
    // 2027: cliff pair plus the discontinuous 133% trio.
    ...pinsFor(2, 2027, [
      "cliff-at",
      "cliff-plus-1c",
      "edge133-at",
      "edge133-plus-1c",
      "edge133-below-1c",
    ]),
  ];
}

function buildFullPins(): AcaPin[] {
  const pins: AcaPin[] = [];
  for (let hh = 1; hh <= 5; hh++) {
    for (let year = 2025; year <= 2028; year++) {
      pins.push(...pinsFor(hh, year, ALL_KINDS));
    }
  }
  return pins;
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

function checkPins(pins: AcaPin[]): string[] {
  const failures: string[] = [];
  for (const pin of pins) {
    const args = {
      magi: pin.magi,
      householdSize: pin.householdSize,
      coverageYear: pin.coverageYear,
      benchmarkAnnual: pin.benchmark,
    };
    const engine = acaCreditFor(args);
    const independent = acaCreditIndependent(args);
    const at = `magi=${pin.magi} hh=${pin.householdSize} y=${pin.coverageYear} bench=${pin.benchmark}`;
    if (!close(engine.credit, independent.credit)) {
      failures.push(
        `${pin.id}: engine vs independent credit ${engine.credit} != ${independent.credit} (${at})`,
      );
    }
    if (!close(engine.applicablePct, independent.applicablePct)) {
      failures.push(
        `${pin.id}: engine vs independent applicablePct ${engine.applicablePct} != ${independent.applicablePct} (${at})`,
      );
    }
    if (engine.overCliff !== independent.overCliff) {
      failures.push(
        `${pin.id}: engine vs independent overCliff ${engine.overCliff} != ${independent.overCliff} (${at})`,
      );
    }
    if (!close(engine.credit, pin.expectedCredit)) {
      failures.push(
        `${pin.id}: engine credit ${engine.credit} != hand-derived ${pin.expectedCredit} (${at})`,
      );
    }
    if (!close(engine.applicablePct, pin.expectedApplicablePct)) {
      failures.push(
        `${pin.id}: engine applicablePct ${engine.applicablePct} != hand-derived ${pin.expectedApplicablePct} (${at})`,
      );
    }
    if (engine.overCliff !== pin.expectedOverCliff) {
      failures.push(
        `${pin.id}: engine overCliff ${engine.overCliff} != hand-derived ${pin.expectedOverCliff} (${at})`,
      );
    }
  }
  return failures;
}

function runInner(pins: AcaPin[], label: string): HardeningCheckResult {
  const failures = checkPins(pins);
  const detail =
    `ACA boundary pins (${label}): ${pins.length} pins priced by ` +
    `acaCreditFor and acaCreditIndependent and checked against ` +
    `hand-derived credits — household sizes 1-5, coverage years ` +
    `2025-2028, cliff / 100% FPL / 133% / band edges. ` +
    `${failures.length === 0 ? "All pins agree to the cent." : `${failures.length} mismatches.`}`;
  return {
    id: "boundary-aca",
    name: "ACA boundary pins: cliff, FPL and band edges",
    pass: failures.length === 0,
    detail,
    failures: failures.slice(0, 25),
    counts: {
      pins: pins.length,
      checks: pins.length * 3,
      failures: failures.length,
    },
  };
}

function runBoundaryAcaFast(): HardeningCheckResult {
  return runInner(buildFastPins(), "fast");
}

function runBoundaryAcaFull(): HardeningCheckResult {
  return runInner(buildFullPins(), "full");
}

// Teeth: corrupt the hand-derived cliff credit for the
// sample couple in 2026 by 1c; exactly that pin must
// fail (the engine-vs-independent leg still agrees, so
// the failure count proves the hand pin has teeth). The
// clean fast run must pass first.
function runBoundaryAcaTeeth(): HardeningTeethResult {
  const clean = runBoundaryAcaFast();
  const corruptedCaseId = "aca-hh2-y2026-cliff-at:expected-credit-1c";
  if (!clean.pass) {
    return {
      corruptedCaseId: "boundary-aca:clean-run-failed",
      failedCount: clean.counts.failures ?? 0,
      pass: false,
    };
  }
  const pins = buildFastPins();
  const target = pins.find((p) => p.id === "aca-hh2-y2026-cliff-at");
  if (!target) {
    return { corruptedCaseId, failedCount: 0, pass: false };
  }
  const corrupted: AcaPin = {
    ...target,
    expectedCredit: roundCent(target.expectedCredit - 0.01),
  };
  const failures = checkPins([corrupted]);
  return {
    corruptedCaseId,
    failedCount: failures.length,
    pass: failures.length === 1,
  };
}

export const boundaryAcaCheck: HardeningCheckModule = {
  id: "boundary-aca",
  name: "ACA boundary pins: cliff, FPL and band edges",
  runFast: runBoundaryAcaFast,
  runFull: runBoundaryAcaFull,
  runTeeth: runBoundaryAcaTeeth,
};
