/* ---------------- IRMAA boundary pins ----------------
   Part 2 of the hardening block (boundary-case fixture
   pack). IRMAA tier pins: every tier edge of the 2025
   and 2026 law rows, in all three filing statuses, plus
   the top-tier floor semantics, the deflated 2028 top,
   and priceYear's own irmaaTier at exact MAGIs. A pin
   that fails is a FINDING, never a reason to loosen the
   pin.

   Tier edges (upToSingle / upToMfj, from the law rows):
   2026: [109000/218000], [137000/274000], [171000/342000],
   [205000/410000], [499999/749999], [inf/inf].
   2025: [106000/212000], [133000/266000], [167000/334000],
   [200000/400000], [499999/749999], [inf/inf].
   Tiers 0-3: MAGI at the top prices that tier, 1c above
   prices the next tier. HOH uses the single thresholds.

   CORRECTED top-tier semantics (probe-verified against
   the engine): the stored top (499,999 / 749,999) is the
   whole dollar BELOW the statutory floor ($500,000 /
   $750,000). Tier 4 runs up to but EXCLUDING the floor:
   $499,999.50 single prices tier 4, exactly $500,000
   prices tier 5 — a +1c step from the stored top does
   NOT cross the tier. The same floor holds for the 2025
   row. In deflated years the boundary stays the deflated
   stored top from irmaaTierUpTo (the classifier and the
   tier cap share that one line).

   Deflated 2028 (2026 row, 2.5% inflation): the joint
   top deflates to $749,999 / 1.025^2 = $713,859.8453...
   and the single top to $499,999 / 1.025^2 =
   $475,906.2462... Pins at the deflated top price tier
   4; 1c above prices tier 5. The single cent-straddle
   ($475,906.24 -> 4, $475,906.25 -> 5) is pinned as
   probed — if it ever fails, that is a finding. */

import {
  irmaaTierFor,
  irmaaTierUpTo,
  priceYear,
} from "../taxEngine";
import type { PriceYearInput } from "../taxEngine";
import { TAX_LAW_2025, TAX_LAW_2026 } from "../taxLaw";
import type { FilingStatus, YearLaw } from "../taxLaw";
import { SAMPLE_INFLATION_PCT } from "../sampleHousehold";
import type {
  HardeningCheckModule,
  HardeningCheckResult,
  HardeningTeethResult,
} from "./types";

const INFLATION_PCT = SAMPLE_INFLATION_PCT;

function roundCent(n: number): number {
  return Math.round(n * 100) / 100;
}

type IrmaaPin = {
  id: string;
  magi: number;
  filingStatus: FilingStatus;
  law: YearLaw;
  calendarYear: number;
  expectedTier: number;
};

type PriceYearPin = {
  id: string;
  magi: number;
  expectedTier: number;
};

function tierTop(
  tierIndex: number,
  filingStatus: FilingStatus,
  law: YearLaw,
): number {
  const tier = law.irmaaTiers[tierIndex];
  if (!tier) return Infinity;
  return filingStatus === "mfj" ? tier.upToMfj : tier.upToSingle;
}

function pinId(
  lawYear: number,
  filingStatus: FilingStatus,
  label: string,
): string {
  return `irmaa-${lawYear}-${filingStatus}-${label}`;
}

/* Every tier edge (tiers 0-4) for the given statuses:
   at the top, 1c above, 1c below. Tier 4's +1c pin stays
   in tier 4 (the floor semantics, not the stored top). */
function tierEdgePins(
  law: YearLaw,
  statuses: FilingStatus[],
): IrmaaPin[] {
  const pins: IrmaaPin[] = [];
  for (let i = 0; i <= 4; i++) {
    for (const fs of statuses) {
      const top = tierTop(i, fs, law);
      pins.push({
        id: pinId(law.year, fs, `tier${i}-top-at`),
        magi: top,
        filingStatus: fs,
        law,
        calendarYear: law.year,
        expectedTier: i,
      });
      pins.push({
        id: pinId(law.year, fs, `tier${i}-top-plus-1c`),
        magi: roundCent(top + 0.01),
        filingStatus: fs,
        law,
        calendarYear: law.year,
        expectedTier: i === 4 ? 4 : i + 1,
      });
      pins.push({
        id: pinId(law.year, fs, `tier${i}-top-minus-1c`),
        magi: roundCent(top - 0.01),
        filingStatus: fs,
        law,
        calendarYear: law.year,
        expectedTier: i,
      });
    }
  }
  return pins;
}

/* The statutory floor pins: fractional MAGIs between the
   stored top and the floor stay in tier 4; exactly the
   floor prices tier 5. */
function floorPins(law: YearLaw): IrmaaPin[] {
  const y = law.year;
  return [
    {
      id: pinId(y, "single", "frac-499999-50"),
      magi: 499999.5,
      filingStatus: "single" as FilingStatus,
      law,
      calendarYear: y,
      expectedTier: 4,
    },
    {
      id: pinId(y, "single", "frac-499999-99"),
      magi: 499999.99,
      filingStatus: "single" as FilingStatus,
      law,
      calendarYear: y,
      expectedTier: 4,
    },
    {
      id: pinId(y, "single", "floor-500000"),
      magi: 500000,
      filingStatus: "single" as FilingStatus,
      law,
      calendarYear: y,
      expectedTier: 5,
    },
    {
      id: pinId(y, "mfj", "frac-749999-50"),
      magi: 749999.5,
      filingStatus: "mfj" as FilingStatus,
      law,
      calendarYear: y,
      expectedTier: 4,
    },
    {
      id: pinId(y, "mfj", "floor-750000"),
      magi: 750000,
      filingStatus: "mfj" as FilingStatus,
      law,
      calendarYear: y,
      expectedTier: 5,
    },
    {
      id: pinId(y, "hoh", "frac-499999-50"),
      magi: 499999.5,
      filingStatus: "hoh" as FilingStatus,
      law,
      calendarYear: y,
      expectedTier: 4,
    },
    {
      id: pinId(y, "hoh", "floor-500000"),
      magi: 500000,
      filingStatus: "hoh" as FilingStatus,
      law,
      calendarYear: y,
      expectedTier: 5,
    },
  ];
}

/* Fractional MAGIs just over an ordinary tier top cross
   the tier (2026 row). */
function fractionalPins(): IrmaaPin[] {
  return [
    {
      id: "irmaa-2026-single-frac-109000-50",
      magi: 109000.5,
      filingStatus: "single" as FilingStatus,
      law: TAX_LAW_2026,
      calendarYear: 2026,
      expectedTier: 1,
    },
    {
      id: "irmaa-2026-single-frac-205000-50",
      magi: 205000.5,
      filingStatus: "single" as FilingStatus,
      law: TAX_LAW_2026,
      calendarYear: 2026,
      expectedTier: 4,
    },
  ];
}

/* Deflated 2028 (2026 row, 2.5% inflation): the tier-4
   top deflates from irmaaTierUpTo; pins at the deflated
   top price tier 4, 1c above prices tier 5, plus the
   fixture-pinned joint cents (713859.84 -> 4, 713859.85
   -> 5, 713860.35 -> 5) and the single cent-straddle
   (475906.24 -> 4, 475906.25 -> 5). */
function deflatedPins(): IrmaaPin[] {
  const topMfj = irmaaTierUpTo(4, "mfj", TAX_LAW_2026, 2028, INFLATION_PCT);
  const topSingle = irmaaTierUpTo(4, "single", TAX_LAW_2026, 2028, INFLATION_PCT);
  return [
    {
      id: "irmaa-2028-deflated-mfj-713859-84",
      magi: 713859.84,
      filingStatus: "mfj" as FilingStatus,
      law: TAX_LAW_2026,
      calendarYear: 2028,
      expectedTier: 4,
    },
    {
      id: "irmaa-2028-deflated-mfj-713859-85",
      magi: 713859.85,
      filingStatus: "mfj" as FilingStatus,
      law: TAX_LAW_2026,
      calendarYear: 2028,
      expectedTier: 5,
    },
    {
      id: "irmaa-2028-deflated-mfj-713860-35",
      magi: 713860.35,
      filingStatus: "mfj" as FilingStatus,
      law: TAX_LAW_2026,
      calendarYear: 2028,
      expectedTier: 5,
    },
    {
      id: "irmaa-2028-deflated-mfj-at-top",
      magi: topMfj,
      filingStatus: "mfj" as FilingStatus,
      law: TAX_LAW_2026,
      calendarYear: 2028,
      expectedTier: 4,
    },
    {
      id: "irmaa-2028-deflated-mfj-top-plus-1c",
      magi: roundCent(topMfj + 0.01),
      filingStatus: "mfj" as FilingStatus,
      law: TAX_LAW_2026,
      calendarYear: 2028,
      expectedTier: 5,
    },
    {
      id: "irmaa-2028-deflated-single-at-top",
      magi: topSingle,
      filingStatus: "single" as FilingStatus,
      law: TAX_LAW_2026,
      calendarYear: 2028,
      expectedTier: 4,
    },
    {
      id: "irmaa-2028-deflated-single-top-plus-1c",
      magi: roundCent(topSingle + 0.01),
      filingStatus: "single" as FilingStatus,
      law: TAX_LAW_2026,
      calendarYear: 2028,
      expectedTier: 5,
    },
    {
      id: "irmaa-2028-deflated-single-475906-24",
      magi: 475906.24,
      filingStatus: "single" as FilingStatus,
      law: TAX_LAW_2026,
      calendarYear: 2028,
      expectedTier: 4,
    },
    {
      id: "irmaa-2028-deflated-single-475906-25",
      magi: 475906.25,
      filingStatus: "single" as FilingStatus,
      law: TAX_LAW_2026,
      calendarYear: 2028,
      expectedTier: 5,
    },
  ];
}

function priceYearBase(otherOrdinary: number): PriceYearInput {
  return {
    calendarYear: 2026,
    filingStatus: "mfj",
    agePrimary: 60,
    ageSpouse: 58,
    otherOrdinary,
    rmd: 0,
    conversion: 0,
    extraPreTaxDraw: 0,
    ssBenefits: 0,
    taxExemptInterest: 0,
    ltcg: 0,
    interestIncome: 0,
    ordinaryDividends: 0,
    qualifiedDividends: 0,
    capitalLossAllowance: 0,
    inflationPct: INFLATION_PCT,
    stateRatePct: 0,
    residenceState: "other",
  };
}

/* priceYear's own irmaaTier at exact MAGIs (2026, mfj):
   with no Social Security, no tax-exempt interest, and
   no gains, MAGI is the other-ordinary figure. */
function priceYearPins(): PriceYearPin[] {
  return [
    { id: "irmaa-priceyear-2026-mfj-218000", magi: 218000, expectedTier: 0 },
    { id: "irmaa-priceyear-2026-mfj-218000-01", magi: 218000.01, expectedTier: 1 },
    { id: "irmaa-priceyear-2026-mfj-749999-50", magi: 749999.5, expectedTier: 4 },
    { id: "irmaa-priceyear-2026-mfj-750000", magi: 750000, expectedTier: 5 },
  ];
}

function buildFastPins(): { tierPins: IrmaaPin[]; yearPins: PriceYearPin[] } {
  const tierPins: IrmaaPin[] = [
    // All 2026 tier edges, single + joint.
    ...tierEdgePins(TAX_LAW_2026, ["single", "mfj"]),
    // HOH spot: tier 0 and tier 4 edges (HOH uses single).
    ...tierEdgePins(TAX_LAW_2026, ["hoh"]).filter((p) =>
      p.id.includes("tier0-") || p.id.includes("tier4-"),
    ),
    ...floorPins(TAX_LAW_2026),
    ...fractionalPins(),
    ...deflatedPins(),
  ];
  return { tierPins, yearPins: priceYearPins() };
}

function buildFullPins(): { tierPins: IrmaaPin[]; yearPins: PriceYearPin[] } {
  const tierPins: IrmaaPin[] = [
    // Every tier edge, all three filing statuses, both rows.
    ...tierEdgePins(TAX_LAW_2026, ["single", "mfj", "hoh"]),
    ...tierEdgePins(TAX_LAW_2025, ["single", "mfj", "hoh"]),
    ...floorPins(TAX_LAW_2026),
    ...floorPins(TAX_LAW_2025),
    ...fractionalPins(),
    ...deflatedPins(),
  ];
  return { tierPins, yearPins: priceYearPins() };
}

function checkPins(
  tierPins: IrmaaPin[],
  yearPins: PriceYearPin[],
): string[] {
  const failures: string[] = [];
  for (const pin of tierPins) {
    const actual = irmaaTierFor(
      pin.magi,
      pin.filingStatus,
      pin.law,
      pin.calendarYear,
      INFLATION_PCT,
    );
    if (actual !== pin.expectedTier) {
      failures.push(
        `${pin.id}: irmaaTierFor(${pin.magi}, ${pin.filingStatus}, law ${pin.law.year}, ${pin.calendarYear}) = ${actual}, expected tier ${pin.expectedTier}`,
      );
    }
  }
  for (const pin of yearPins) {
    const actual = priceYear(priceYearBase(pin.magi)).irmaaTier;
    if (actual !== pin.expectedTier) {
      failures.push(
        `${pin.id}: priceYear irmaaTier at MAGI ${pin.magi} = ${actual}, expected tier ${pin.expectedTier}`,
      );
    }
  }
  return failures;
}

function runInner(
  tierPins: IrmaaPin[],
  yearPins: PriceYearPin[],
  label: string,
): HardeningCheckResult {
  const failures = checkPins(tierPins, yearPins);
  const total = tierPins.length + yearPins.length;
  const detail =
    `IRMAA boundary pins (${label}): ${total} pins (${tierPins.length} ` +
    `irmaaTierFor tier-edge / floor / deflated pins, ${yearPins.length} ` +
    `priceYear irmaaTier pins) — 2025 + 2026 law rows, all filing ` +
    `statuses, deflated 2028 top. ` +
    `${failures.length === 0 ? "All pins price the expected tier." : `${failures.length} mismatches.`}`;
  return {
    id: "boundary-irmaa",
    name: "IRMAA boundary pins: tier edges, floor and deflated top",
    pass: failures.length === 0,
    detail,
    failures: failures.slice(0, 25),
    counts: {
      pins: total,
      tierPins: tierPins.length,
      priceYearPins: yearPins.length,
      failures: failures.length,
    },
  };
}

function runBoundaryIrmaaFast(): HardeningCheckResult {
  const { tierPins, yearPins } = buildFastPins();
  return runInner(tierPins, yearPins, "fast");
}

function runBoundaryIrmaaFull(): HardeningCheckResult {
  const { tierPins, yearPins } = buildFullPins();
  return runInner(tierPins, yearPins, "full");
}

// Teeth: corrupt the joint tier-0 top pin's MAGI by 1c
// (218,000 -> 218,000.01, still expecting tier 0);
// exactly that pin must fail. The clean fast run must
// pass first.
function runBoundaryIrmaaTeeth(): HardeningTeethResult {
  const clean = runBoundaryIrmaaFast();
  const corruptedCaseId = "irmaa-2026-mfj-tier0-top-at:magi-plus-1c";
  if (!clean.pass) {
    return {
      corruptedCaseId: "boundary-irmaa:clean-run-failed",
      failedCount: clean.counts.failures ?? 0,
      pass: false,
    };
  }
  const { tierPins } = buildFastPins();
  const target = tierPins.find(
    (p) => p.id === "irmaa-2026-mfj-tier0-top-at",
  );
  if (!target) {
    return { corruptedCaseId, failedCount: 0, pass: false };
  }
  const corrupted: IrmaaPin = { ...target, magi: roundCent(target.magi + 0.01) };
  const failures = checkPins([corrupted], []);
  return {
    corruptedCaseId,
    failedCount: failures.length,
    pass: failures.length === 1,
  };
}

export const boundaryIrmaaCheck: HardeningCheckModule = {
  id: "boundary-irmaa",
  name: "IRMAA boundary pins: tier edges, floor and deflated top",
  runFast: runBoundaryIrmaaFast,
  runFull: runBoundaryIrmaaFull,
  runTeeth: runBoundaryIrmaaTeeth,
};
