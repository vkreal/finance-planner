/* ---------------- Seeded household generator ----------------
   Part 1 of the hardening block (Oct 16 hardening options).
   The differential's household source: a SEEDED,
   deterministic generator of randomized single-year
   households, so a differential failure reproduces exactly
   from its seed. Precedent: the Monte Carlo golden shocks
   use seed 12345; this generator uses the same seed and a
   local mulberry32 stream (written here, not imported from
   any engine — the stream is harness machinery, not tax
   math, and the module stays self-contained).

   Distributions: 70% uniform over broad dollar ranges
   (incomes, gains, yields, deductions, students), 30%
   boundary-biased: the household prices with no Social
   Security and no tax-exempt interest, the other income
   components are zeroed on boundary households so the
   targeted landing is reachable (otherwise they would
   push the priced aggregate past the anchor), and one
   income component is adjusted so a priced aggregate lands
   within ±$500 of a randomly chosen law boundary for
   that year and filing status — the priced MAGI for a
   MAGI boundary (a §86 threshold, the NIIT threshold,
   an IRMAA tier floor, the 400% FPL cliff, the SALT,
   senior-deduction, AMT, or §25A phase-out start, or a
   near-zero MAGI), the priced taxable income for a
   taxable boundary (a bracket top, the LTCG 0% top or
   20% floor, the SALT cap), offset by the year's
   standard deduction — the differential reports how
   many priced households land within $100 of each
   boundary, so the coverage is visible in the check's
   own output instead of assumed.

   Years 2025–2028: the 2025 and 2026 published rows plus
   the 2027/2028 carry-forward years, so the deflation and
   carry-forward rules are exercised. All money inputs are
   rounded to the cent. No figure here is any household's
   real figure: every value is drawn from the ranges below. */

import type { FilingStatus } from "../taxLaw";
import { fplFor, lawForYear, saltScheduleForYear, SENIOR_DEDUCTION, SS_THRESHOLDS } from "../taxLaw";
import type { IndependentYearInput } from "./secondImplementation";

export const HARDENING_SEED = 12345;

export type GeneratedHousehold = {
  input: IndependentYearInput;
  householdSize: number;
  benchmarkAnnual: number;
};

// mulberry32: a small deterministic PRNG. The stream is
// seeded once per generation run and consumed in a fixed
// order, so generateHouseholds(count, seed) returns the
// identical households on every run.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;

function uniform(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

function roundCent(n: number): number {
  return Math.round(n * 100) / 100;
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] ?? items[0]!;
}

function weightedStatus(rng: Rng): FilingStatus {
  const r = rng();
  if (r < 0.5) return "mfj";
  if (r < 0.8) return "single";
  return "hoh";
}

function drawAge(rng: Rng, low: number, high: number): number {
  // 12% of draws land exactly on a milestone age (65, 66,
  // 67, 73, 75) — the ages where the 65+ add-on, the senior
  // deduction, and the RMD clocks change.
  if (rng() < 0.12) return pick(rng, [65, 66, 67, 73, 75]);
  return low + Math.floor(uniform(rng, 0, high - low + 1));
}

function drawMoney(rng: Rng, max: number, zeroPct: number): number {
  if (rng() < zeroPct) return 0;
  return roundCent(uniform(rng, 0, max));
}

export function generateHouseholds(
  count: number,
  seed: number = HARDENING_SEED,
): GeneratedHousehold[] {
  const rng = mulberry32(seed);
  const out: GeneratedHousehold[] = [];
  for (let i = 0; i < count; i++) {
    const calendarYear = pick(rng, [2025, 2026, 2026, 2027, 2028]);
    const filingStatus = weightedStatus(rng);
    const agePrimary = drawAge(rng, 55, 90);
    const ageSpouse =
      filingStatus === "mfj" && rng() < 0.6 ? drawAge(rng, 50, 90) : null;
    const inflationPct = pick(rng, [0, 1, 2, 2.5, 3]);
    const residenceState: "WA" | "other" = rng() < 0.25 ? "WA" : "other";
    const stateRatePct = roundCent(uniform(rng, 0, 6));

    let otherOrdinary = drawMoney(rng, 400000, 0.15);
    let rmd = drawMoney(rng, 75000, 0.3);
    let conversion = drawMoney(rng, 250000, 0.3);
    let extraPreTaxDraw = drawMoney(rng, 150000, 0.4);
    let ssBenefits = drawMoney(rng, 60000, 0.25);
    let taxExemptInterest = drawMoney(rng, 40000, 0.5);
    let ltcg =
      rng() < 0.15
        ? -roundCent(uniform(rng, 0, 30000))
        : roundCent(uniform(rng, 0, 250000));
    let interestIncome = drawMoney(rng, 30000, 0.4);
    let ordinaryDividends = drawMoney(rng, 40000, 0.3);
    let qualifiedDividends = drawMoney(rng, 40000, 0.3);
    // The §1211(b) allowance prices only on a net-loss
    // year; a non-loss year carries none.
    let capitalLossAllowance =
      ltcg < 0 ? Math.round(uniform(rng, 0, 3000)) : 0;

    const householdSize = pick(rng, [1, 2, 2, 3, 4, 4, 5, 5, 6]);
    const benchmarkAnnual = Math.round(uniform(rng, 12000, 40000));

    // Boundary bias: adjust otherOrdinary so the year's
    // AGI-before-Social-Security lands near a law boundary
    // for this year and filing status. The Social Security
    // feedback shifts the priced MAGI from the targeted
    // figure, so the landing is near — not exactly on — the
    // boundary; the differential's coverage report counts
    // the priced landings within $100 of each boundary.
    if (rng() < 0.3) {
      // Boundary households price with no Social Security
      // and no tax-exempt interest, so the targeted
      // AGI-before-Social-Security IS the priced MAGI —
      // the §86 feedback cannot shift the landing.
      ssBenefits = 0;
      taxExemptInterest = 0;
      rmd = 0;
      conversion = 0;
      extraPreTaxDraw = 0;
      ltcg = 0;
      interestIncome = 0;
      ordinaryDividends = 0;
      qualifiedDividends = 0;
      capitalLossAllowance = 0;
      const law = lawForYear(calendarYear);
      // MAGI anchors land the priced MAGI on the line;
      // taxable-income anchors land taxable income on the
      // line, so they are offset by the year's standard
      // deduction (base + age-65+ add-ons for the drawn
      // ages) before targeting the AGI sum.
      const magiAnchors: number[] = [
        law.niitThreshold[filingStatus],
        SS_THRESHOLDS[filingStatus].first,
        SS_THRESHOLDS[filingStatus].second,
        4 * fplFor(householdSize, calendarYear - 1),
        saltScheduleForYear(calendarYear).phaseOutStart,
        SENIOR_DEDUCTION.phaseOutStart[filingStatus],
        law.amtPhaseOutStart[filingStatus],
        law.eduPhaseOutStart[filingStatus],
      ];
      for (const tier of law.irmaaTiers) {
        const upTo =
          filingStatus === "mfj" ? tier.upToMfj : tier.upToSingle;
        if (Number.isFinite(upTo)) magiAnchors.push(upTo);
      }
      const taxableAnchors: number[] = [];
      for (const top of law.brackets[filingStatus]) {
        if (Number.isFinite(top)) taxableAnchors.push(top);
      }
      taxableAnchors.push(
        law.ltcgZeroTop[filingStatus],
        law.ltcg20Floor[filingStatus],
        saltScheduleForYear(calendarYear).cap,
      );
      const count65 =
        (agePrimary >= 65 ? 1 : 0) +
        (filingStatus === "mfj" && ageSpouse != null && ageSpouse >= 65 ? 1 : 0);
      const stdDed =
        law.standardDeduction[filingStatus] +
        law.age65Addon[filingStatus] * count65;
      let anchor: number;
      if (rng() < 0.1) {
        // Near-zero MAGI: lands some households below
        // 100% FPL, where no credit pays.
        anchor = uniform(rng, 0, 15000);
      } else if (rng() < 0.5) {
        anchor =
          magiAnchors[Math.floor(rng() * magiAnchors.length)] ?? 0;
      } else {
        anchor =
          (taxableAnchors[Math.floor(rng() * taxableAnchors.length)] ?? 0) +
          stdDed;
      }
      const baseExclOther =
        rmd +
        conversion +
        extraPreTaxDraw +
        Math.max(0, ltcg) +
        qualifiedDividends +
        interestIncome +
        ordinaryDividends -
        capitalLossAllowance;
      const jitter = rng() < 0.05 ? 0 : uniform(rng, -500, 500);
      otherOrdinary = Math.max(
        0,
        roundCent(anchor - baseExclOther + jitter),
      );
    }

    // Itemized deductions (45% of households): the
    // components stay separate because the SALT component
    // is capped on its own. SALT spikes at the familiar
    // cap figures; charitable runs wide enough to cross
    // the 60%-of-AGI ceiling on high-charitable years.
    let itemizedMortgageInterest: number | undefined;
    let itemizedSaltPaid: number | undefined;
    let itemizedCharitable: number | undefined;
    let itemizedOther: number | undefined;
    if (rng() < 0.45) {
      itemizedMortgageInterest = drawMoney(rng, 60000, 0.2);
      itemizedSaltPaid =
        rng() < 0.2
          ? pick(rng, [10000, 40400])
          : drawMoney(rng, 60000, 0.1);
      itemizedCharitable = drawMoney(rng, 100000, 0.2);
      itemizedOther = drawMoney(rng, 30000, 0.3);
    }

    // Washington ledger-adjusted excise base (10% of
    // Washington households with a positive gain): the
    // base the caller supplies instead of the priced ltcg.
    let waGainsBase: number | undefined;
    if (residenceState === "WA" && ltcg > 0 && rng() < 0.1) {
      waGainsBase = roundCent(ltcg * uniform(rng, 0.5, 1));
    }

    // Education students (25% of households): one or two
    // students, expenses up to the AOTC/LLC ranges, AOTC
    // eligibility marked per student.
    let educationStudents: { expenses: number; aotcEligible: boolean }[] | undefined;
    if (rng() < 0.25) {
      const n = rng() < 0.6 ? 1 : 2;
      educationStudents = [];
      for (let s = 0; s < n; s++) {
        educationStudents.push({
          expenses: Math.round(uniform(rng, 500, 15000)),
          aotcEligible: rng() < 0.5,
        });
      }
    }

    out.push({
      input: {
        calendarYear,
        filingStatus,
        agePrimary,
        ageSpouse,
        otherOrdinary,
        rmd,
        conversion,
        extraPreTaxDraw,
        ssBenefits,
        taxExemptInterest,
        ltcg,
        interestIncome,
        ordinaryDividends,
        qualifiedDividends,
        capitalLossAllowance,
        inflationPct,
        stateRatePct,
        residenceState,
        itemizedMortgageInterest,
        itemizedSaltPaid,
        itemizedCharitable,
        itemizedOther,
        waGainsBase,
        educationStudents,
      },
      householdSize,
      benchmarkAnnual,
    });
  }
  return out;
}
