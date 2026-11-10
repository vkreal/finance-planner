/* ---------------- ACA boundary pins ----------------
   Part 2 of the hardening block (boundary-case fixture
   pack). ACA §36B credit pins: the cliff, the 100% FPL
   floor, the discontinuous 133% band edge, and every
   other band edge — each priced by the engine
   (acaCreditFor) and by the independent second
   implementation (acaCreditIndependent), diffed to the
   cent, AND checked against a hand-derived expected
   credit computed from the published band tables and
   the literal guideline table below (never from engine
   source, and never from production fplFor — round-10
   F3). A pin that fails is a FINDING, never a reason to
   loosen the pin.

   Construction (all MAGIs in dollars; with no Social
   Security, no tax-exempt interest, and no gains, MAGI
   is the other-ordinary figure the pin passes in):
   - fpl = the literal guideline table below
     (GUIDELINE_LITERALS, transcribed from the published
     HHS poverty guidelines); the cliff is 4 x fpl and
     applies 2026 on; 2025 prices under the enhanced
     schedule with NO cliff (a flat 8.5% applicable
     percentage above 400% FPL).
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
     2.15%). Band edges are classified in integer cents
     everywhere (round-10 F1): the float pctFpl computes
     132.99999999999997 at an exact 133% edge for HH1/HH3
     and would price the lower band, so the engine, the
     independent implementation, and the derivation below
     all compare magiCents x 100 against upToPctFpl x
     fplCents. The +1c pin above the edge still covers the
     true discontinuity, and the literal pins below pin the
     exact edge independently of any derived value.

   Residual (known, round-10 F3): the engine-vs-independent
   leg still shares production fplFor — both pricers read
   the same law table — so that leg alone cannot catch a
   wrong guideline in the law table. The literal pins are
   the leg that catches it: their MAGIs and expectations
   are fixed dollars, independent of any derived value. */

import { acaCreditFor } from "../taxEngine";
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

/* Source-derived literal poverty guidelines (round-10
   F3): the HHS poverty guidelines 2024–2026, transcribed
   as base + per-additional-person (the published form;
   FPL for a household = base + perAdditional x (size -
   1)). The 2026 row is Federal Register, Jan. 15, 2026;
   FR Doc. 2026-00755. These literals — never production
   fplFor — locate every pin MAGI (magiForKind) and every
   hand-derived expectation (deriveExpected): a wrong
   guideline in the production law table must move
   neither. Guideline years beyond the table fall back to
   the newest row, mirroring fplFor's convention. */
type GuidelineRow = { base: number; perAdditional: number };
const GUIDELINE_LITERALS: Record<number, GuidelineRow> = {
  2024: { base: 15060, perAdditional: 5380 },
  2025: { base: 15650, perAdditional: 5500 },
  2026: { base: 15960, perAdditional: 5680 },
};

/* FPL for a household from the literal table above
   (guidelineYear = coverageYear - 1). The `guidelines`
   parameter exists only so the teeth check can prove a
   corrupted guideline fails the check; production runs
   always use the literals above. */
function fplLiteral(
  householdSize: number,
  guidelineYear: number,
  guidelines: Record<number, GuidelineRow> = GUIDELINE_LITERALS,
): number {
  const years = Object.keys(guidelines).map(Number);
  const newest =
    guidelines[Math.max(...years)] ?? { base: 15960, perAdditional: 5680 };
  const g = guidelines[guidelineYear] ?? newest;
  const size = Math.max(1, Math.round(householdSize));
  return g.base + g.perAdditional * (size - 1);
}

/* Hand-derived expectation for one MAGI: the raw
   interpolated applicable percentage (band classified in
   integer cents, fraction interpolated from pctFpl,
   lower-inclusive bands, last band taking its top edge),
   the cent-rounded credit, and the cliff flag. Returns
   null only for a year with no table. */
function deriveExpected(
  magi: number,
  householdSize: number,
  coverageYear: number,
  benchmark: number,
  guidelines: Record<number, GuidelineRow> = GUIDELINE_LITERALS,
): {
  credit: number;
  applicablePct: number;
  overCliff: boolean;
} | null {
  const bands = BAND_TABLES[coverageYear] ?? BAND_TABLES[2026];
  if (!bands) return null;
  const fpl = fplLiteral(householdSize, coverageYear - 1, guidelines);
  const cliff = 4 * fpl;
  const pctFpl = fpl > 0 ? (magi / fpl) * 100 : 0;
  // Integer-cents band classification (round-10 F1): the
  // float pctFpl computes 132.99999999999997 at an exact
  // 133% edge for HH1/HH3. The float is kept only for the
  // interpolation fraction below.
  const magiCents = Math.round(magi * 100);
  const fplCents = Math.round(fpl * 100);
  const hasCliff = coverageYear >= 2026;
  const overCliff = hasCliff && magi > cliff;
  if (overCliff || magiCents < fplCents) {
    return { credit: 0, applicablePct: 0, overCliff };
  }
  let rawPct = bands[bands.length - 1]?.finalPct ?? 9.96;
  for (let i = 0; i < bands.length; i++) {
    const band = bands[i];
    if (!band) continue;
    if (magiCents * 100 < band.upToPctFpl * fplCents || i === bands.length - 1) {
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
  guidelines: Record<number, GuidelineRow> = GUIDELINE_LITERALS,
): number {
  const fpl = fplLiteral(householdSize, coverageYear - 1, guidelines);
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

/* Source-derived literal 133% pins (round-10 F1): the
   generated edge133-at pins above derive their
   expectations from deriveExpected, so all three legs
   could share one wrong comparison. These three pins
   carry literal expectations hand-computed from the
   published sources, so they pin the exact edge
   independently of any derived value:
   - HH3, coverage 2027: 2026 guideline $27,320
     (FPL_GUIDELINES 2026 row: $15,960 + 2 x $5,680);
     edge MAGI 1.33 x 27,320 = $36,335.60; 2027 band 2
     initial 3.23% (Rev. Proc. 2026-26); benchmark
     $36,000 -> credit 36,000 - 0.0323 x 36,335.60
     = $34,826.36.
   - HH1, coverage 2027: guideline $15,960; edge MAGI
     1.33 x 15,960 = $21,226.80; 3.23%; benchmark
     $17,500 -> credit 17,500 - 0.0323 x 21,226.80
     = $16,814.37.
   - HH1, coverage 2028: guideline $15,960 (the 2027
     row falls back to the newest 2026 row); edge MAGI
     $21,226.80; 2028 prices on the 2026 row, band 2
     initial 3.14% (Rev. Proc. 2025-25 §3.01);
     benchmark $17,500 -> credit 17,500 - 0.0314 x
     21,226.80 = $16,833.48. */
const LITERAL_EDGE_PINS: AcaPin[] = [
  {
    id: "aca-hh3-y2027-edge133-at-literal",
    magi: 36335.6,
    householdSize: 3,
    coverageYear: 2027,
    benchmark: 36000,
    expectedCredit: 34826.36,
    expectedApplicablePct: 3.23,
    expectedOverCliff: false,
  },
  {
    id: "aca-hh1-y2027-edge133-at-literal",
    magi: 21226.8,
    householdSize: 1,
    coverageYear: 2027,
    benchmark: 17500,
    expectedCredit: 16814.37,
    expectedApplicablePct: 3.23,
    expectedOverCliff: false,
  },
  {
    id: "aca-hh1-y2028-edge133-at-literal",
    magi: 21226.8,
    householdSize: 1,
    coverageYear: 2028,
    benchmark: 17500,
    expectedCredit: 16833.48,
    expectedApplicablePct: 3.14,
    expectedOverCliff: false,
  },
];

/* Source-derived literal cliff pins (round-10 F3): the
   generated cliff-at pins above derive their MAGI from
   magiForKind, so a wrong guideline in the table that
   locates them would move both the test income and the
   expectation together. These two pins carry literal
   dollars on both sides, so they pin the published 2026
   cliff independently of any derived value:
   - MAGI $84,600 is exactly the 2026 cliff for a
     household of 2 (4 x the 2025 guideline $21,150);
     at the cliff the credit still pays: benchmark
     $25,000 - 9.96% x $84,600 = $16,573.84 (2026 band
     300–400% final 9.96%, Rev. Proc. 2025-25 §3.01).
   - MAGI $84,601 is $1 above the cliff: the credit is
     $0 and overCliff is true. */
const LITERAL_CLIFF_PINS: AcaPin[] = [
  {
    id: "aca-hh2-y2026-cliff-at-literal",
    magi: 84600,
    householdSize: 2,
    coverageYear: 2026,
    benchmark: 25000,
    expectedCredit: 16573.84,
    expectedApplicablePct: 9.96,
    expectedOverCliff: false,
  },
  {
    id: "aca-hh2-y2026-cliff-plus-1-literal",
    magi: 84601,
    householdSize: 2,
    coverageYear: 2026,
    benchmark: 25000,
    expectedCredit: 0,
    expectedApplicablePct: 0,
    expectedOverCliff: true,
  },
];

function pinsFor(
  householdSize: number,
  coverageYear: number,
  kinds: PinKind[],
  guidelines: Record<number, GuidelineRow> = GUIDELINE_LITERALS,
): AcaPin[] {
  const benchmark = benchmarkFor(householdSize);
  const pins: AcaPin[] = [];
  for (const kind of kinds) {
    const magi = magiForKind(kind, householdSize, coverageYear, guidelines);
    const expected = deriveExpected(
      magi,
      householdSize,
      coverageYear,
      benchmark,
      guidelines,
    );
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

function buildFastPins(
  guidelines: Record<number, GuidelineRow> = GUIDELINE_LITERALS,
): AcaPin[] {
  return [
    // The full edge set for the sample couple in 2026.
    ...pinsFor(2, 2026, ALL_KINDS, guidelines),
    // Cliff pairs for the largest and smallest households.
    ...pinsFor(5, 2026, ["cliff-at", "cliff-plus-1c"], guidelines),
    ...pinsFor(1, 2026, ["cliff-at"], guidelines),
    // 2025: no cliff above 400% FPL.
    ...pinsFor(2, 2025, ["cliff-at", "cliff-plus-1c"], guidelines),
    // 2027: cliff pair plus the discontinuous 133% trio.
    ...pinsFor(
      2,
      2027,
      [
        "cliff-at",
        "cliff-plus-1c",
        "edge133-at",
        "edge133-plus-1c",
        "edge133-below-1c",
      ],
      guidelines,
    ),
    // Literal exact-edge pins (round-10 F1): the fast
    // check's 2027 edge-133 trio is HH2-only, and HH2's
    // float computes exactly — so the fast check passed
    // even with the engine-only fix and the residual
    // test-side float error. These literal pins make the
    // fast check catch it too.
    ...LITERAL_EDGE_PINS,
    // Literal cliff pins (round-10 F3): the generated
    // cliff pins above still derive their MAGIs from the
    // guideline table, so only these fixed dollars pin
    // the published cliff independently.
    ...LITERAL_CLIFF_PINS,
  ];
}

function buildFullPins(
  guidelines: Record<number, GuidelineRow> = GUIDELINE_LITERALS,
): AcaPin[] {
  const pins: AcaPin[] = [];
  for (let hh = 1; hh <= 5; hh++) {
    for (let year = 2025; year <= 2028; year++) {
      pins.push(...pinsFor(hh, year, ALL_KINDS, guidelines));
    }
  }
  pins.push(...LITERAL_EDGE_PINS);
  pins.push(...LITERAL_CLIFF_PINS);
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

// Teeth: two variants, both must fire. (1) Corrupt the
// hand-derived cliff credit for the sample couple in 2026
// by 1c; exactly that pin must fail (the
// engine-vs-independent leg still agrees, so the failure
// count proves the hand pin has teeth). (2, round-10 F3)
// Corrupt the guideline the pins derive from — the 2025
// base +$100, exactly the corruption the round-10
// verifier demonstrated ($15,650 -> $15,750, moving the
// 2026 couple cliff $84,600 -> $85,000) — rebuild the
// fast pins from the corrupted table and require the run
// to fail, with the generated cliff-at pin among the
// failures: the literal pins and the hand-derived leg
// must not move with a corrupted guideline. A clean fast
// run must pass first.
function runBoundaryAcaTeeth(): HardeningTeethResult {
  const clean = runBoundaryAcaFast();
  const corruptedCreditCaseId =
    "aca-hh2-y2026-cliff-at:expected-credit-1c";
  const corruptedGuidelineCaseId =
    "aca-2025-guideline-base-plus-100";
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
    return { corruptedCaseId: corruptedCreditCaseId, failedCount: 0, pass: false };
  }
  const corrupted: AcaPin = {
    ...target,
    expectedCredit: roundCent(target.expectedCredit - 0.01),
  };
  const creditFailures = checkPins([corrupted]);
  const corruptedGuidelines: Record<number, GuidelineRow> = {
    ...GUIDELINE_LITERALS,
    2025: {
      base: (GUIDELINE_LITERALS[2025]?.base ?? 15650) + 100,
      perAdditional: GUIDELINE_LITERALS[2025]?.perAdditional ?? 5500,
    },
  };
  const guidelineFailures = checkPins(buildFastPins(corruptedGuidelines));
  const guidelineCaught = guidelineFailures.some((f) =>
    f.startsWith("aca-hh2-y2026-cliff-at:"),
  );
  return {
    corruptedCaseId: `${corruptedCreditCaseId} | ${corruptedGuidelineCaseId}`,
    failedCount: creditFailures.length + guidelineFailures.length,
    pass: creditFailures.length === 1 && guidelineFailures.length > 0 && guidelineCaught,
  };
}

export const boundaryAcaCheck: HardeningCheckModule = {
  id: "boundary-aca",
  name: "ACA boundary pins: cliff, FPL and band edges",
  runFast: runBoundaryAcaFast,
  runFull: runBoundaryAcaFull,
  runTeeth: runBoundaryAcaTeeth,
};
