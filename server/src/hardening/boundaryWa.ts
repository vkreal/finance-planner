/* ---------------- Washington excise boundary pins ----------------
   Part 2 of the hardening block (boundary-case fixture pack).
   The Washington capital-gains excise (RCW 82.87) as priced
   by waCapitalGainsTax (taxEngine.ts) and wired into a priced
   year by priceYear: the statute's $290,000 standard deduction
   prices the first dollar above it at 7%, the $1,000,000
   surtax threshold prices the dollar above it at a combined
   9.9%, and the charitable deduction starts only above
   $290,000 of donations and caps at $116,000. The surtax
   threshold is the only statute-fixed amount that deflates:
   in a year priced under an older law row it is the nominal
   $1,000,000 times that year's deflationFactor; the standard
   deduction and charitable amounts stay nominal. A negative
   gain owes $0 and carries nothing forward.

   Every pin is hand-derived from the statute and the law row
   (TAX_LAW_2026: standard deduction $290,000, rate 7%,
   additional 2.9% over $1,000,000, charitable threshold
   $290,000, cap $116,000) and was probe-verified against the
   engine before this module was written. A pin that fails
   against the engine is a finding, never a reason to loosen
   the pin. */

import { lawForYear } from "../taxLaw";
import type { YearLaw } from "../taxLaw";
import { deflationFactor, priceYear, waCapitalGainsTax } from "../taxEngine";
import type { PriceYearInput } from "../taxEngine";
import type {
  HardeningCheckModule,
  HardeningCheckResult,
  HardeningTeethResult,
} from "./types";

const LAW_2026 = lawForYear(2026);

// One pure-pricer pin: the inputs to waCapitalGainsTax and
// the result fields the statute determines.
type WaPin = {
  id: string;
  ltcg: number;
  donations: number;
  // Deflation factor the caller passes; omitted = 1 (a year
  // pricing under its own law row).
  defl?: number;
  waGains: number;
  charitableDeduction: number;
  taxableGains: number;
  tax: number;
};

const WA_PINS: WaPin[] = [
  // Standard-deduction boundary.
  { id: "wa-std-at", ltcg: 290000, donations: 0, waGains: 290000, charitableDeduction: 0, taxableGains: 0, tax: 0 },
  { id: "wa-std-plus1c", ltcg: 290001, donations: 0, waGains: 290001, charitableDeduction: 0, taxableGains: 1, tax: 0.07 },
  // Surtax-threshold boundary (taxable $1,000,000).
  { id: "wa-surtax-at", ltcg: 1290000, donations: 0, waGains: 1290000, charitableDeduction: 0, taxableGains: 1000000, tax: 70000 },
  { id: "wa-surtax-plus1c", ltcg: 1290001, donations: 0, waGains: 1290001, charitableDeduction: 0, taxableGains: 1000001, tax: 70000.1 },
  // Charitable deduction: threshold, first dollar, cap, mid.
  { id: "wa-char-at", ltcg: 500000, donations: 290000, waGains: 500000, charitableDeduction: 0, taxableGains: 210000, tax: 14700 },
  { id: "wa-char-plus1c", ltcg: 500000, donations: 290001, waGains: 500000, charitableDeduction: 1, taxableGains: 209999, tax: 14699.93 },
  { id: "wa-char-cap", ltcg: 500000, donations: 406000, waGains: 500000, charitableDeduction: 116000, taxableGains: 94000, tax: 6580 },
  { id: "wa-char-mid", ltcg: 500000, donations: 300000, waGains: 500000, charitableDeduction: 10000, taxableGains: 200000, tax: 0.07 * 200000 },
  // A negative gain owes $0 (no carryforward out of the pricer).
  { id: "wa-negative", ltcg: -5000, donations: 0, waGains: 0, charitableDeduction: 0, taxableGains: 0, tax: 0 },
  // Deflated surtax threshold, pinned through the factor the
  // function itself takes: at a factor of 1/2 the threshold is
  // $500,000, so the step sits at taxable $500,000.
  { id: "wa-defl-half-at", ltcg: 790000, donations: 0, defl: 0.5, waGains: 790000, charitableDeduction: 0, taxableGains: 500000, tax: 35000 },
  { id: "wa-defl-half-plus1c", ltcg: 790001, donations: 0, defl: 0.5, waGains: 790001, charitableDeduction: 0, taxableGains: 500001, tax: 35000.1 },
  // Deflated threshold under the real 2028 factor
  // (1 / 1.025^2): taxable $963,000 sits above the deflated
  // threshold ($951,814.40) and below the nominal $1,000,000,
  // so the tax is 7% to the deflated threshold and 9.9% past
  // it — $67,734.38, not the undeflated $67,410.00.
  {
    id: "wa-defl-2028",
    ltcg: 1253000,
    donations: 0,
    defl: deflationFactor(2028, 2026, 2.5),
    waGains: 1253000,
    charitableDeduction: 0,
    taxableGains: 963000,
    tax: 67734.38,
  },
];

// One priced-year pin: the WA fields priceYear exposes plus
// the state-tax component the excise becomes.
type WaPricePin = {
  id: string;
  input: PriceYearInput;
  waGains: number;
  waTaxableGains: number;
  stateTax: number;
};

function waBaseInput(
  year: number,
  over: Partial<PriceYearInput> = {},
): PriceYearInput {
  return {
    calendarYear: year,
    filingStatus: "mfj",
    agePrimary: 60,
    ageSpouse: 58,
    otherOrdinary: 0,
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
    inflationPct: 2.5,
    stateRatePct: 0,
    residenceState: "other",
    ...over,
  };
}

const WA_PRICE_PINS: WaPricePin[] = [
  {
    id: "wa-py-std-plus1c",
    input: waBaseInput(2026, { residenceState: "WA", ltcg: 290001 }),
    waGains: 290001,
    waTaxableGains: 1,
    stateTax: 0.07,
  },
  {
    // waGainsBase overrides the year's gains entirely: the
    // WA-allocated base is $200,000, below the deduction.
    id: "wa-py-base-override",
    input: waBaseInput(2026, {
      residenceState: "WA",
      ltcg: 278001,
      waGainsBase: 200000,
    }),
    waGains: 200000,
    waTaxableGains: 0,
    stateTax: 0,
  },
  {
    // A non-Washington year prices no excise at all.
    id: "wa-py-nonwa",
    input: waBaseInput(2026, { residenceState: "other", ltcg: 278001 }),
    waGains: 0,
    waTaxableGains: 0,
    stateTax: 0,
  },
  {
    // The deflated surtax threshold inside a priced year:
    // 2028 carries the 2026 row forward at 2.5% inflation,
    // so taxable $963,000 prices 7% to $951,814.40 and 9.9%
    // past it.
    id: "wa-py-2028-deflated",
    input: waBaseInput(2028, { residenceState: "WA", ltcg: 1253000 }),
    waGains: 1253000,
    waTaxableGains: 963000,
    stateTax: 67734.38,
  },
];

// The statute recomputed from its own description, as the
// full run's second implementation: the standard deduction
// and charitable amounts are nominal; only the surtax
// threshold scales by the deflation factor.
function expectedWa(
  ltcg: number,
  donations: number,
  law: YearLaw,
  defl: number,
): { waGains: number; charitableDeduction: number; taxableGains: number; tax: number } {
  const waGains = Math.max(0, ltcg);
  const charitableDeduction = Math.min(
    law.waCharitableCap,
    Math.max(0, Math.max(0, donations) - law.waCharitableThreshold),
  );
  const taxableGains = Math.max(
    0,
    waGains - law.waStandardDeduction - charitableDeduction,
  );
  const threshold = law.waAdditionalThreshold * defl;
  const atBase = Math.min(taxableGains, threshold);
  const tax =
    (law.waRatePct / 100) * atBase +
    ((law.waRatePct + law.waAdditionalRatePct) / 100) *
      (taxableGains - atBase);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    waGains: r2(waGains),
    charitableDeduction: r2(charitableDeduction),
    taxableGains: r2(taxableGains),
    tax: r2(tax),
  };
}

function checkWaPins(
  pins: WaPin[],
  overrides: Partial<Record<string, Partial<WaPin>>> = {},
): string[] {
  const failures: string[] = [];
  for (const pin of pins) {
    const want = { ...pin, ...(overrides[pin.id] ?? {}) };
    const got = waCapitalGainsTax({
      ltcg: pin.ltcg,
      charitableDonations: pin.donations,
      law: LAW_2026,
      ...(pin.defl !== undefined ? { deflationFactor: pin.defl } : {}),
    });
    for (const field of [
      "waGains",
      "charitableDeduction",
      "taxableGains",
      "tax",
    ] as const) {
      if (Math.abs(got[field] - want[field]) > 0.001) {
        failures.push(
          `${pin.id} ${field}: got ${got[field]}, expected ${want[field]}`,
        );
      }
    }
  }
  return failures;
}

function checkWaPricePins(
  pins: WaPricePin[],
  overrides: Partial<Record<string, Partial<WaPricePin>>> = {},
): string[] {
  const failures: string[] = [];
  for (const pin of pins) {
    const want = { ...pin, ...(overrides[pin.id] ?? {}) };
    const got = priceYear(pin.input);
    for (const field of ["waGains", "waTaxableGains", "stateTax"] as const) {
      if (Math.abs(got[field] - want[field]) > 0.001) {
        failures.push(
          `${pin.id} ${field}: got ${got[field]}, expected ${want[field]}`,
        );
      }
    }
  }
  return failures;
}

// Full enumeration: the boundary grid on the pure pricer
// (gains around both thresholds, donations around the
// charitable threshold and cap, deflation factors 1, 1/2,
// 0.95, and the real 2028 factor), each checked against the
// second implementation above, plus monotonicity of the tax
// in gains at a fixed deflation factor.
function runWaFullSweep(): { failures: string[]; checked: number } {
  const failures: string[] = [];
  let checked = 0;
  const gainsGrid = [
    0, 289999.99, 290000, 290000.01, 290001, 290100, 406000, 500000,
    1289999.99, 1290000, 1290000.01, 1290001, 1300000, 2000000,
  ];
  const donationsGrid = [
    0, 289999.99, 290000, 290000.01, 300000, 405999.99, 406000,
    406000.01, 500000,
  ];
  const deflGrid = [1, 0.5, 0.95, deflationFactor(2028, 2026, 2.5)];
  for (const defl of deflGrid) {
    for (const ltcg of gainsGrid) {
      for (const donations of donationsGrid) {
        const got = waCapitalGainsTax({
          ltcg,
          charitableDonations: donations,
          law: LAW_2026,
          deflationFactor: defl,
        });
        const want = expectedWa(ltcg, donations, LAW_2026, defl);
        checked++;
        for (const field of [
          "waGains",
          "charitableDeduction",
          "taxableGains",
          "tax",
        ] as const) {
          if (Math.abs(got[field] - want[field]) > 0.001) {
            failures.push(
              `sweep defl=${defl} ltcg=${ltcg} donations=${donations} ${field}: got ${got[field]}, expected ${want[field]}`,
            );
          }
        }
      }
    }
    // Monotonicity: the tax never falls as gains rise.
    let prevTax = -1;
    for (const ltcg of gainsGrid) {
      const got = waCapitalGainsTax({
        ltcg,
        charitableDonations: 0,
        law: LAW_2026,
        deflationFactor: defl,
      });
      checked++;
      if (got.tax < prevTax - 0.001) {
        failures.push(
          `sweep defl=${defl} ltcg=${ltcg}: tax ${got.tax} below prior ${prevTax}`,
        );
      }
      prevTax = got.tax;
    }
  }
  // Priced-year sweep: WA and non-WA across 2025, 2026, 2028.
  // The 278,000/278,001 points straddle the 2025 boundary; the
  // 290,000/290,001 points straddle the 2026 and 2028 boundary.
  for (const year of [2025, 2026, 2028]) {
    for (const ltcg of [0, 278000, 278001, 290000, 290001, 500000, 1253000]) {
      for (const residenceState of ["WA", "other"] as const) {
        const got = priceYear(
          waBaseInput(year, { residenceState, ltcg }),
        );
        checked++;
        if (residenceState === "other") {
          if (got.waGains !== 0 || got.waTaxableGains !== 0) {
            failures.push(
              `priceYear ${year} non-WA ltcg=${ltcg}: waGains ${got.waGains}, waTaxableGains ${got.waTaxableGains}, expected 0`,
            );
          }
        } else {
          const want = expectedWa(
            ltcg,
            0,
            lawForYear(year),
            deflationFactor(year, lawForYear(year).year, 2.5),
          );
          if (
            Math.abs(got.waTaxableGains - want.taxableGains) > 0.001 ||
            Math.abs(got.stateTax - want.tax) > 0.001
          ) {
            failures.push(
              `priceYear ${year} WA ltcg=${ltcg}: waTaxableGains ${got.waTaxableGains} (expected ${want.taxableGains}), stateTax ${got.stateTax} (expected ${want.tax})`,
            );
          }
        }
      }
    }
  }
  return { failures: failures.slice(0, 25), checked };
}

function runWaInner(full: boolean): HardeningCheckResult {
  const failures = [...checkWaPins(WA_PINS), ...checkWaPricePins(WA_PRICE_PINS)];
  const counts: Record<string, number> = {
    purePins: WA_PINS.length,
    priceYearPins: WA_PRICE_PINS.length,
  };
  let sweepChecked = 0;
  if (full) {
    const sweep = runWaFullSweep();
    failures.push(...sweep.failures);
    sweepChecked = sweep.checked;
  }
  counts.sweepChecked = sweepChecked;
  counts.failures = failures.length;
  const detail =
    `Washington excise boundary pins: ${WA_PINS.length} pure-pricer pins ` +
    `(standard deduction, surtax threshold, charitable threshold/cap/mid, ` +
    `negative gain, deflated surtax threshold at factor 1/2 and at the ` +
    `real 2028 factor) + ${WA_PRICE_PINS.length} priced-year pins ` +
    `(WA fields, waGainsBase override, non-WA zero, 2028 deflated ` +
    `threshold)` +
    (full
      ? ` + full sweep over ${sweepChecked} priced cases against a second implementation of the statute; `
      : `; full sweep runs in the full run only; `) +
    `${failures.length} failures.`;
  return {
    id: "boundary-wa-excise",
    name: "Washington capital-gains excise boundary pins",
    pass: failures.length === 0,
    detail,
    failures: failures.slice(0, 25),
    counts,
  };
}

function runWaTeeth(): HardeningTeethResult {
  const clean = runWaInner(false);
  if (!clean.pass) {
    return {
      corruptedCaseId: "boundary-wa-excise:clean-run-failed",
      failedCount: clean.counts.failures ?? 0,
      pass: false,
    };
  }
  // Corrupt one pin by 1 cent: the first dollar above the
  // standard deduction should price $0.07, not $0.08.
  const failures = checkWaPins(WA_PINS, {
    "wa-std-plus1c": { tax: 0.08 },
  });
  const teeth =
    failures.length === 1 && failures[0]?.startsWith("wa-std-plus1c tax") === true;
  return {
    corruptedCaseId: "boundary-wa-excise:wa-std-plus1c-tax+1c",
    failedCount: failures.length,
    pass: teeth,
  };
}

export const boundaryWaCheck: HardeningCheckModule = {
  id: "boundary-wa-excise",
  name: "Washington capital-gains excise boundary pins",
  runFast: () => runWaInner(false),
  runFull: () => runWaInner(true),
  runTeeth: runWaTeeth,
};
