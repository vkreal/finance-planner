/* ---------------- Randomized differential ----------------
   Part 1 of the hardening block (Oct 16: "why not do all?"
   / "Do all of them but make it last"). The harness's core
   check: thousands of seeded randomized households
   (generator.ts) priced BOTH by the engine's single-year
   pricer (priceYear) and by the independent second
   implementation (priceYearIndependent, written from the
   law tables — never from engine source), and diffed field
   by field to the cent across tax, MAGI, credit, gains
   zones, and IRMAA tiers.

   Diffed per household (41 year fields + 6 credit fields,
   exact equality on the cent-rounded outputs — a 1-cent
   difference is a mismatch to report, never to absorb):
   provisionalIncome, ssTaxable, agi, magi, acaMagi,
   baseStandardDeduction, age65AddonTotal, count65,
   ordinaryTaxableIncome, gainsInTaxableIncome,
   standardDeduction, seniorDeduction, itemizedDeduction,
   itemizedSaltAllowed, itemizedSaltCap,
   itemizedCharitableAllowed, section68Reduction,
   nonItemizerCharitableDeduction, deductionTaken,
   deductions, taxableIncome,
   taxableIncomeBeforeLossAllowance, ordinaryTax, ltcgTax,
   niit, federalTax, stateTax, waGains,
   waStandardDeduction, waCharitableDeduction,
   waTaxableGains, educationAotc, educationLlc,
   educationChoice, educationNonrefundable,
   educationRefundable, amti, amtExemption,
   amtTentativeTax, amtOwed, marginalBracketPct,
   irmaaTier, gainsAt0, gainsAt15, gainsAt20 — plus the
   bracket layers (count, then each layer's rate, span,
   amount, and tax) — plus the §36B credit leg (credit,
   pctFpl, applicablePct, fpl, cliff, overCliff), priced by
   both credit functions on the SAME MAGI (the engine's
   priced ACA MAGI), so the credit leg tests the §36B math
   alone while the year leg tests the MAGI itself.

   Coverage: the check reports how many priced households
   land within $100 of each law boundary (IRMAA tier
   floors, the 400% FPL cliff, bracket tops, the LTCG zero
   top), the IRMAA tier histogram, and the counts of AMT
   years, education-credit years, itemized years,
   Washington years, over-cliff years, and loss years — so
   a clean run also shows the regimes it actually covered.

   Any mismatch is a FINDING: the result lists the first
   25 with both values, the year, and the filing status.
   The engine is the side under test; this module never
   adjusts either side to make them agree. */

import { acaCreditFor, priceYear } from "../taxEngine";
import type { PriceYearInput } from "../taxEngine";
import { fplFor, lawForYear } from "../taxLaw";
import { acaCreditIndependent } from "./independentAcaCredit";
import {
  priceYearIndependent,
} from "./secondImplementation";
import type {
  IndependentYearInput,
  IndependentYearResult,
} from "./secondImplementation";
import { generateHouseholds, HARDENING_SEED } from "./generator";
import type { GeneratedHousehold } from "./generator";
import type {
  HardeningCheckModule,
  HardeningCheckResult,
  HardeningTeethResult,
} from "./types";

export const DIFFERENTIAL_FAST_HOUSEHOLDS = 50;
export const DIFFERENTIAL_FULL_HOUSEHOLDS = 2000;

const YEAR_FIELDS: (keyof IndependentYearResult)[] = [
  "provisionalIncome",
  "ssTaxable",
  "agi",
  "magi",
  "acaMagi",
  "baseStandardDeduction",
  "age65AddonTotal",
  "count65",
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
  "deductionTaken",
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
  "educationChoice",
  "educationNonrefundable",
  "educationRefundable",
  "amti",
  "amtExemption",
  "amtTentativeTax",
  "amtOwed",
  "marginalBracketPct",
  "irmaaTier",
  "gainsAt0",
  "gainsAt15",
  "gainsAt20",
];

type Mismatch = {
  household: number;
  field: string;
  engine: unknown;
  independent: unknown;
  year: number;
  filingStatus: string;
};

function toEngineInput(h: GeneratedHousehold): PriceYearInput {
  const i: IndependentYearInput = h.input;
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

export type DifferentialCorrupt = {
  householdIndex: number;
  field: keyof IndependentYearResult;
  cents: number;
};

export function runDifferential(args: {
  households: number;
  seed?: number;
  corrupt?: DifferentialCorrupt;
}): HardeningCheckResult & {
  mismatches: Mismatch[];
  coverage: Record<string, number>;
} {
  const seed = args.seed ?? HARDENING_SEED;
  const generated = generateHouseholds(args.households, seed);
  const mismatches: Mismatch[] = [];
  const coverage: Record<string, number> = {
    households: generated.length,
    irmaaTier0: 0,
    irmaaTier1: 0,
    irmaaTier2: 0,
    irmaaTier3: 0,
    irmaaTier4: 0,
    irmaaTier5: 0,
    amtOwedPositive: 0,
    educationCreditPriced: 0,
    itemizedTaken: 0,
    washingtonYears: 0,
    overCliff: 0,
    below100Fpl: 0,
    lossYears: 0,
    niitPositive: 0,
    gainsAt20Positive: 0,
    magiWithin100OfIrmaaFloor: 0,
    acaMagiWithin100OfCliff: 0,
    taxableWithin100OfBracketTop: 0,
    taxableWithin100OfLtcgZeroTop: 0,
  };
  let fieldsCompared = 0;

  for (let idx = 0; idx < generated.length; idx++) {
    const h = generated[idx]!;
    const engine = priceYear(toEngineInput(h));
    let mine = priceYearIndependent(h.input);
    if (args.corrupt && args.corrupt.householdIndex === idx) {
      const field = args.corrupt.field;
      const prior = mine[field];
      mine = {
        ...mine,
        [field]:
          typeof prior === "number"
            ? Math.round((prior + args.corrupt.cents / 100) * 100) / 100
            : prior,
      };
    }
    const push = (field: string, a: unknown, b: unknown) => {
      if (a !== b) {
        mismatches.push({
          household: idx,
          field,
          engine: a,
          independent: b,
          year: h.input.calendarYear,
          filingStatus: h.input.filingStatus,
        });
      }
    };

    for (const field of YEAR_FIELDS) {
      fieldsCompared++;
      push(field, engine[field], mine[field]);
    }
    // Bracket layers: same count, then each layer's rate,
    // span, amount, and tax.
    fieldsCompared++;
    if (engine.bracketLayers.length !== mine.bracketLayers.length) {
      mismatches.push({
        household: idx,
        field: "bracketLayers.length",
        engine: engine.bracketLayers.length,
        independent: mine.bracketLayers.length,
        year: h.input.calendarYear,
        filingStatus: h.input.filingStatus,
      });
    } else {
      for (let l = 0; l < engine.bracketLayers.length; l++) {
        const e = engine.bracketLayers[l]!;
        const m = mine.bracketLayers[l]!;
        fieldsCompared += 5;
        push(`bracketLayers[${l}].ratePct`, e.ratePct, m.ratePct);
        push(`bracketLayers[${l}].from`, e.from, m.from);
        push(`bracketLayers[${l}].to`, e.to, m.to);
        push(`bracketLayers[${l}].amount`, e.amount, m.amount);
        push(`bracketLayers[${l}].tax`, e.tax, m.tax);
      }
    }

    // §36B credit leg: both credit functions price the SAME
    // MAGI (the engine's priced ACA MAGI), so this leg
    // tests the credit math alone.
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
    fieldsCompared += 6;
    push("aca.credit", engineCredit.credit, mineCredit.credit);
    push("aca.pctFpl", engineCredit.pctFpl, mineCredit.pctFpl);
    push(
      "aca.applicablePct",
      engineCredit.applicablePct,
      mineCredit.applicablePct,
    );
    push("aca.fpl", engineCredit.fpl, mineCredit.fpl);
    push("aca.cliff", engineCredit.cliff, mineCredit.cliff);
    push("aca.overCliff", engineCredit.overCliff, mineCredit.overCliff);

    // Coverage tallies (from the engine's priced figures).
    const tierKey = `irmaaTier${engine.irmaaTier}` as keyof typeof coverage;
    coverage[tierKey] = (coverage[tierKey] ?? 0) + 1;
    if (engine.amtOwed > 0) coverage.amtOwedPositive!++;
    if (engine.educationChoice !== "none") coverage.educationCreditPriced!++;
    if (engine.deductionTaken === "itemized") coverage.itemizedTaken!++;
    if (h.input.residenceState === "WA") coverage.washingtonYears!++;
    if (engineCredit.overCliff) coverage.overCliff!++;
    if (engineCredit.pctFpl < 100) coverage.below100Fpl!++;
    if (h.input.ltcg < 0) coverage.lossYears!++;
    if (engine.niit > 0) coverage.niitPositive!++;
    if (engine.gainsAt20 > 0) coverage.gainsAt20Positive!++;
    const law = lawForYear(h.input.calendarYear);
    for (const tier of law.irmaaTiers) {
      const upTo =
        h.input.filingStatus === "mfj" ? tier.upToMfj : tier.upToSingle;
      if (
        Number.isFinite(upTo) &&
        Math.abs(engine.magi - upTo) <= 100
      ) {
        coverage.magiWithin100OfIrmaaFloor!++;
        break;
      }
    }
    const cliff = 4 * fplFor(h.householdSize, h.input.calendarYear - 1);
    if (Math.abs(engine.acaMagi - cliff) <= 100) {
      coverage.acaMagiWithin100OfCliff!++;
    }
    for (const top of law.brackets[h.input.filingStatus]) {
      if (
        Number.isFinite(top) &&
        Math.abs(engine.taxableIncome - top) <= 100
      ) {
        coverage.taxableWithin100OfBracketTop!++;
        break;
      }
    }
    if (
      Math.abs(engine.taxableIncome - law.ltcgZeroTop[h.input.filingStatus]) <=
      100
    ) {
      coverage.taxableWithin100OfLtcgZeroTop!++;
    }
  }

  const failureLines = mismatches
    .slice(0, 25)
    .map(
      (m) =>
        `household ${m.household} (${m.year} ${m.filingStatus}) ${m.field}: engine ${String(m.engine)}, independent ${String(m.independent)}`,
    );
  const detail =
    `${generated.length} households (seed ${seed}): ` +
    `${mismatches.length} mismatches across ${fieldsCompared} field comparisons. ` +
    `Coverage — IRMAA tiers ${coverage.irmaaTier0}/${coverage.irmaaTier1}/${coverage.irmaaTier2}/${coverage.irmaaTier3}/${coverage.irmaaTier4}/${coverage.irmaaTier5}; ` +
    `AMT>0 ${coverage.amtOwedPositive}, education ${coverage.educationCreditPriced}, itemized ${coverage.itemizedTaken}, WA ${coverage.washingtonYears}, over-cliff ${coverage.overCliff}, below-100%-FPL ${coverage.below100Fpl}, loss years ${coverage.lossYears}, NIIT>0 ${coverage.niitPositive}, gains-at-20% ${coverage.gainsAt20Positive}; ` +
    `within $100 of a boundary — IRMAA floor ${coverage.magiWithin100OfIrmaaFloor}, cliff ${coverage.acaMagiWithin100OfCliff}, bracket top ${coverage.taxableWithin100OfBracketTop}, LTCG zero top ${coverage.taxableWithin100OfLtcgZeroTop}.`;
  return {
    id: "differential-single-year",
    name: "Randomized differential: engine vs independent single-year pricer",
    pass: mismatches.length === 0,
    detail,
    failures: failureLines,
    counts: {
      households: generated.length,
      fieldsCompared,
      mismatches: mismatches.length,
      ...coverage,
    },
    mismatches,
    coverage,
  };
}

function runDifferentialFast(): HardeningCheckResult {
  const r = runDifferential({ households: DIFFERENTIAL_FAST_HOUSEHOLDS });
  const { mismatches: _m, coverage: _c, ...result } = r;
  return result;
}

function runDifferentialFull(): HardeningCheckResult {
  const r = runDifferential({ households: DIFFERENTIAL_FULL_HOUSEHOLDS });
  const { mismatches: _m, coverage: _c, ...result } = r;
  return result;
}

// Teeth: corrupt one pin by 1 cent (household 0's
// federalTax) and prove exactly that check fails — the
// clean run must pass first, and the corrupted run must
// report exactly one mismatch, naming federalTax on
// household 0.
function runDifferentialTeeth(): HardeningTeethResult {
  const clean = runDifferential({
    households: DIFFERENTIAL_FAST_HOUSEHOLDS,
  });
  if (!clean.pass) {
    return {
      corruptedCaseId: "differential-single-year:clean-run-failed",
      failedCount: clean.mismatches.length,
      pass: false,
    };
  }
  const corrupted = runDifferential({
    households: DIFFERENTIAL_FAST_HOUSEHOLDS,
    corrupt: { householdIndex: 0, field: "federalTax", cents: 1 },
  });
  const bad = corrupted.mismatches;
  const pass =
    bad.length === 1 &&
    bad[0]?.household === 0 &&
    bad[0]?.field === "federalTax";
  return {
    corruptedCaseId: "differential-single-year:household-0-federalTax+1c",
    failedCount: bad.length,
    pass,
  };
}

export const differentialCheck: HardeningCheckModule = {
  id: "differential-single-year",
  name: "Randomized differential: engine vs independent single-year pricer",
  runFast: runDifferentialFast,
  runFull: runDifferentialFull,
  runTeeth: runDifferentialTeeth,
};
