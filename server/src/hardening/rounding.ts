/* ---------------- Rounding sweep ----------------
   Part 1 of the hardening block (Oct 16: the rounding
   sweep folds into the cross-check harness build). The
   harness's quantization checks: the settlement's money
   figures must stay cent-quantized, because the search
   machinery around them assumes it.

   (a) Cent-quantization across the differential set: every
   money field of every priced year — both the engine's and
   the independent implementation's — is an exact multiple
   of $0.01. A fractional cent anywhere is a finding: it
   means an output escaped the cent-rounding discipline
   the fixtures pin.
   (b) The M-1 tolerance pin: the fill searcher's +0.005
   safety rests on MAGI staying cent-quantized — a settled
   ACA MAGI must never sit a fraction of a cent over the
   cliff. A conversion sweep in $1 steps across the cliff
   crossing asserts every swept MAGI is cent-quantized and
   that (MAGI ≤ cliff + 0.005) is exactly (MAGI ≤ cliff)
   on every step, with the settled year landing at or under
   the cliff and the next step over it.

   The differential's exact-cent agreement across thousands
   of households is the sweep's third leg in effect: the
   oracle and the engine share the round-half-up cent
   rule, so a rounding-mode difference between them would
   surface there as systematic 1-cent mismatches. */

import { acaCreditFor, priceYear } from "../taxEngine";
import type { PriceYearInput } from "../taxEngine";
import { fplFor } from "../taxLaw";
import { acaCreditIndependent } from "./independentAcaCredit";
import { generateHouseholds, HARDENING_SEED } from "./generator";
import type { GeneratedHousehold } from "./generator";
import { priceYearIndependent } from "./secondImplementation";
import type {
  HardeningCheckModule,
  HardeningCheckResult,
  HardeningTeethResult,
} from "./types";

export const ROUNDING_FAST_HOUSEHOLDS = 200;
export const ROUNDING_FULL_HOUSEHOLDS = 2000;

function isCentQuantized(v: number): boolean {
  return Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
}

// Every money field the quantization leg checks, on both
// pricers' results (plus the bracket layers' money fields
// and the credit leg's money fields).
const MONEY_FIELDS = [
  "provisionalIncome",
  "ssTaxable",
  "agi",
  "magi",
  "acaMagi",
  "baseStandardDeduction",
  "age65AddonTotal",
  "ordinaryTaxableIncome",
  "gainsInTaxableIncome",
  "standardDeduction",
  "seniorDeduction",
  "itemizedDeduction",
  "itemizedSaltAllowed",
  "itemizedSaltCap",
  "itemizedCharitableAllowed",
  "section68Reduction",
  "nonItemizerCharitableDeduction",
  "deductions",
  "taxableIncome",
  "taxableIncomeBeforeLossAllowance",
  "ordinaryTax",
  "ltcgTax",
  "niit",
  "federalTax",
  "stateTax",
  "waGains",
  "waStandardDeduction",
  "waCharitableDeduction",
  "waTaxableGains",
  "educationAotc",
  "educationLlc",
  "educationNonrefundable",
  "educationRefundable",
  "amti",
  "amtExemption",
  "amtTentativeTax",
  "amtOwed",
  "gainsAt0",
  "gainsAt15",
  "gainsAt20",
] as const;

function toEngineInput(h: GeneratedHousehold): PriceYearInput {
  const i = h.input;
  return {
    calendarYear: i.calendarYear,
    filingStatus: i.filingStatus,
    agePrimary: i.agePrimary,
    ageSpouse: i.ageSpouse,
    otherOrdinary: i.otherOrdinary,
    rmd: i.rmd,
    conversion: i.conversion,
    extraPreTaxDraw: i.extraPreTaxDraw,
    ssBenefits: i.ssBenefits,
    taxExemptInterest: i.taxExemptInterest,
    ltcg: i.ltcg,
    interestIncome: i.interestIncome,
    ordinaryDividends: i.ordinaryDividends,
    qualifiedDividends: i.qualifiedDividends,
    capitalLossAllowance: i.capitalLossAllowance,
    inflationPct: i.inflationPct,
    stateRatePct: i.stateRatePct,
    residenceState: i.residenceState,
    itemizedMortgageInterest: i.itemizedMortgageInterest,
    itemizedSaltPaid: i.itemizedSaltPaid,
    itemizedCharitable: i.itemizedCharitable,
    itemizedOther: i.itemizedOther,
    waGainsBase: i.waGainsBase,
    educationStudents: i.educationStudents,
  };
}

function checkQuantization(households: number): {
  violations: string[];
  fieldsChecked: number;
  maxDeviation: number;
} {
  const generated = generateHouseholds(households, HARDENING_SEED);
  const violations: string[] = [];
  let fieldsChecked = 0;
  let maxDeviation = 0;
  const note = (label: string, field: string, v: number, idx: number) => {
    const dev = Math.abs(v * 100 - Math.round(v * 100));
    maxDeviation = Math.max(maxDeviation, dev);
    if (!isCentQuantized(v)) {
      violations.push(
        `${label} household ${idx} ${field}: ${v} is not cent-quantized (off by ${dev.toFixed(9)} of a cent)`,
      );
    }
  };
  for (let idx = 0; idx < generated.length; idx++) {
    const h = generated[idx]!;
    const engine = priceYear(toEngineInput(h));
    const mine = priceYearIndependent(h.input);
    for (const field of MONEY_FIELDS) {
      fieldsChecked += 2;
      note("engine", field, engine[field] as number, idx);
      note("independent", field, mine[field] as number, idx);
    }
    for (let l = 0; l < engine.bracketLayers.length; l++) {
      const e = engine.bracketLayers[l]!;
      fieldsChecked += 3;
      note("engine", `bracketLayers[${l}].from`, e.from, idx);
      note("engine", `bracketLayers[${l}].amount`, e.amount, idx);
      note("engine", `bracketLayers[${l}].tax`, e.tax, idx);
    }
    for (let l = 0; l < mine.bracketLayers.length; l++) {
      const m = mine.bracketLayers[l]!;
      fieldsChecked += 3;
      note("independent", `bracketLayers[${l}].from`, m.from, idx);
      note("independent", `bracketLayers[${l}].amount`, m.amount, idx);
      note("independent", `bracketLayers[${l}].tax`, m.tax, idx);
    }
    const engineCredit = acaCreditFor({
      magi: engine.acaMagi,
      householdSize: h.householdSize,
      coverageYear: h.input.calendarYear,
      benchmarkAnnual: h.benchmarkAnnual,
    });
    const mineCredit = acaCreditIndependent({
      magi: engine.acaMagi,
      householdSize: h.householdSize,
      coverageYear: h.input.calendarYear,
      benchmarkAnnual: h.benchmarkAnnual,
    });
    for (const [label, c] of [
      ["engine", engineCredit],
      ["independent", mineCredit],
    ] as const) {
      fieldsChecked += 3;
      note(label, "aca.credit", c.credit, idx);
      note(label, "aca.pctFpl", c.pctFpl, idx);
      note(label, "aca.applicablePct", c.applicablePct, idx);
    }
  }
  return { violations: violations.slice(0, 25), fieldsChecked, maxDeviation };
}

// (b) The M-1 pin: sweep the conversion in $1 steps
// across the cliff crossing for a household of 5 in 2026
// (base income below the cliff, no Social Security, so
// MAGI steps $1 per $1 of conversion). Every swept MAGI
// must be cent-quantized, and the +0.005 tolerance must
// never change the settled side of the cliff.
function checkCliffQuantization(): {
  violations: string[];
  settledConversion: number;
  settledMagi: number;
  cliff: number;
} {
  const violations: string[] = [];
  const householdSize = 5;
  const coverageYear = 2026;
  const cliff = 4 * fplFor(householdSize, coverageYear - 1);
  const base: PriceYearInput = {
    calendarYear: coverageYear,
    filingStatus: "mfj",
    agePrimary: 60,
    ageSpouse: 58,
    otherOrdinary: 140000,
    rmd: 0,
    conversion: 0,
    extraPreTaxDraw: 0,
    ssBenefits: 0,
    taxExemptInterest: 0,
    ltcg: 0,
    inflationPct: 2.5,
    stateRatePct: 0,
    residenceState: "other",
  };
  let settledConversion = -1;
  let settledMagi = 0;
  for (let conversion = 0; conversion <= 12000; conversion++) {
    const priced = priceYear({ ...base, conversion });
    const magi = priced.magi;
    if (!isCentQuantized(magi)) {
      violations.push(
        `cliff sweep conversion ${conversion}: MAGI ${magi} is not cent-quantized`,
      );
    }
    const under = magi <= cliff;
    const underWithTolerance = magi <= cliff + 0.005;
    if (under !== underWithTolerance) {
      violations.push(
        `cliff sweep conversion ${conversion}: MAGI ${magi} sits within 0.005 of the cliff ${cliff} — the tolerance would admit an over-cliff settlement`,
      );
    }
    if (under) {
      settledConversion = conversion;
      settledMagi = magi;
    }
  }
  if (settledConversion < 0) {
    violations.push("cliff sweep: no conversion landed at or under the cliff");
  } else {
    const next = priceYear({ ...base, conversion: settledConversion + 1 });
    if (next.magi <= cliff) {
      violations.push(
        `cliff sweep: settled conversion ${settledConversion} is not the largest under-cliff step (next MAGI ${next.magi} still under ${cliff})`,
      );
    }
    if (settledMagi > cliff) {
      violations.push(
        `cliff sweep: settled MAGI ${settledMagi} is over the cliff ${cliff}`,
      );
    }
  }
  return {
    violations: violations.slice(0, 25),
    settledConversion,
    settledMagi,
    cliff,
  };
}

function runRoundingInner(households: number): HardeningCheckResult {
  const quant = checkQuantization(households);
  const cliffCheck = checkCliffQuantization();
  const violations = [...quant.violations, ...cliffCheck.violations];
  const detail =
    `Cent-quantization over ${households} households (seed ${HARDENING_SEED}): ` +
    `${quant.fieldsChecked} money fields checked on both pricers, max deviation ${quant.maxDeviation.toExponential(2)} of a cent, ` +
    `${quant.violations.length} violations. ` +
    `Cliff pin: settled conversion ${cliffCheck.settledConversion} lands MAGI ${cliffCheck.settledMagi} at or under the cliff ${cliffCheck.cliff}, ` +
    `next $1 step over it, tolerance never changes the settled side; ${cliffCheck.violations.length} violations.`;
  return {
    id: "rounding-sweep",
    name: "Rounding sweep: cent-quantization and the cliff tolerance pin",
    pass: violations.length === 0,
    detail,
    failures: violations.slice(0, 25),
    counts: {
      households,
      fieldsChecked: quant.fieldsChecked,
      quantizationViolations: quant.violations.length,
      cliffViolations: cliffCheck.violations.length,
      violations: violations.length,
    },
  };
}

function runRoundingFast(): HardeningCheckResult {
  return runRoundingInner(ROUNDING_FAST_HOUSEHOLDS);
}

function runRoundingFull(): HardeningCheckResult {
  return runRoundingInner(ROUNDING_FULL_HOUSEHOLDS);
}

// Teeth: a MAGI corrupted by half a cent must fail the
// quantization predicate — the clean run must pass first.
function runRoundingTeeth(): HardeningTeethResult {
  const clean = runRoundingInner(ROUNDING_FAST_HOUSEHOLDS);
  if (!clean.pass) {
    return {
      corruptedCaseId: "rounding-sweep:clean-run-failed",
      failedCount: clean.counts.violations ?? 0,
      pass: false,
    };
  }
  const priced = priceYear({
    calendarYear: 2026,
    filingStatus: "mfj",
    agePrimary: 60,
    ageSpouse: 58,
    otherOrdinary: 140000,
    rmd: 0,
    conversion: 0,
    extraPreTaxDraw: 0,
    ssBenefits: 0,
    taxExemptInterest: 0,
    ltcg: 0,
    inflationPct: 2.5,
    stateRatePct: 0,
    residenceState: "other",
  });
  const corrupted = priced.magi + 0.005;
  const pass = !isCentQuantized(corrupted) && isCentQuantized(priced.magi);
  return {
    corruptedCaseId: "rounding-sweep:magi+0.005c",
    failedCount: pass ? 1 : 0,
    pass,
  };
}

export const roundingCheck: HardeningCheckModule = {
  id: "rounding-sweep",
  name: "Rounding sweep: cent-quantization and the cliff tolerance pin",
  runFast: runRoundingFast,
  runFull: runRoundingFull,
  runTeeth: runRoundingTeeth,
};
