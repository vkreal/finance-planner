/* ---------------- Independent ACA premium credit ----------------
   Part 1 of the hardening block (Oct 16 hardening options).
   The independent second implementation of the §36B premium
   tax credit, written FROM THE LAW TABLES
   (server/src/taxLaw.ts) — deliberately NOT from engine
   source. It imports NOTHING from server/src/taxEngine.ts:
   not acaCreditFor — only the law tables themselves
   (fplFor, acaTableFor) and the ACA band type. The
   differential module (differential.ts) prices the same
   MAGI through this function and through the engine's
   credit function and diffs the result.

   What it prices (§36B, as published in the law tables):
   the credit for a coverage year from the household's ACA
   MAGI, household size, and benchmark (second-lowest-cost
   Silver) premium. Coverage-year credits use the PRIOR
   year's poverty guidelines. The applicable percentage is
   the band-interpolated share of household income the
   household is expected to pay, by income as a % of FPL,
   with LOWER-INCLUSIVE band edges (each band is "at least
   X% but less than Y%"): income exactly at a band's lower
   edge takes that band's INITIAL percentage. The 400% FPL
   cliff applies from 2026 on — above it the credit is $0;
   the credit still pays AT exactly 400%. The 2025 coverage
   year prices under the enhanced schedule (no cliff: above
   400% FPL the applicable percentage stays at its 8.5%
   cap). A credit never pays below 100% FPL. The 2027
   applicable-percentage table (a partial law row) prices
   coverage year 2027 exactly, and projected 2027; later
   years fall back to the 2026 row, never to the 2027
   percentages — acaTableFor (taxLaw.ts) owns that
   selection, and this module calls it. */

import type { AcaBand } from "../taxLaw";
import { acaTableFor, fplFor } from "../taxLaw";

export type IndependentAcaCreditInput = {
  // The household's ACA MAGI (§36B household income: AGI +
  // tax-exempt interest + the NON-taxable portion of Social
  // Security). The differential feeds BOTH credit pricers
  // the same MAGI, so this leg tests the §36B math alone;
  // the MAGI itself is tested by the single-year
  // differential leg.
  magi: number;
  householdSize: number;
  coverageYear: number;
  benchmarkAnnual: number;
  // Projected pricing (a year inside a multi-year
  // projection) vs a single named coverage year: the table
  // selection differs only for 2027 (see acaTableFor).
  projected?: boolean;
  // The coverage year whose applicable-percentage table
  // prices the credit, when it differs from coverageYear
  // (a caller may split the guideline lookback year from
  // the table year). Absent, it is coverageYear.
  tableYear?: number;
};

export type IndependentAcaCreditResult = {
  credit: number;
  pctFpl: number;
  applicablePct: number;
  fpl: number;
  cliff: number;
  overCliff: boolean;
};

function roundCent(n: number): number {
  return Math.round(n * 100) / 100;
}

export function acaCreditIndependent(
  args: IndependentAcaCreditInput,
): IndependentAcaCreditResult {
  // Coverage-year credits use the PRIOR year's poverty
  // guidelines.
  const fpl = fplFor(args.householdSize, args.coverageYear - 1);
  const cliff = 4 * fpl;
  const pctFpl = fpl > 0 ? (args.magi / fpl) * 100 : 0;
  // Band edges are classified in integer cents, never from
  // the float pctFpl: at an exact edge the float can compute
  // a hair below the edge (132.99999999999997 at 133% for
  // HH1/HH3) and the lower band would price instead of the
  // edge band's initial percentage (round-10 F1). The float
  // pctFpl below is kept only for the interpolation fraction
  // and the reported value.
  const magiCents = Math.round(args.magi * 100);
  const fplCents = Math.round(fpl * 100);
  // The 400% FPL cliff applies from 2026 on. 2025 coverage
  // priced under the enhanced schedule, which has NO cliff.
  const hasCliff = args.coverageYear >= 2026;
  const overCliff = hasCliff && args.magi > cliff;
  if (overCliff || magiCents < fplCents) {
    return {
      credit: 0,
      pctFpl: roundCent(pctFpl),
      applicablePct: 0,
      fpl,
      cliff,
      overCliff,
    };
  }
  const bands: AcaBand[] = acaTableFor(args.tableYear ?? args.coverageYear, {
    projected: args.projected ?? false,
  });
  const lows = [0, 133, 150, 200, 250, 300];
  let applicablePct = bands[bands.length - 1]?.finalPct ?? 9.96;
  for (let i = 0; i < bands.length; i++) {
    const band = bands[i];
    if (!band) continue;
    // LOWER-INCLUSIVE band edges: a band matches only BELOW
    // its top edge — magiCents * 100 < upToPctFpl * fplCents,
    // never <= — so income exactly at a lower edge takes
    // that band's INITIAL percentage. The last band also
    // takes its top edge (exactly 400% still pays a credit;
    // the cliff is the separate overCliff test above) and,
    // in 2025, everything above it.
    if (magiCents * 100 < band.upToPctFpl * fplCents || i === bands.length - 1) {
      const lo = lows[i] ?? 0;
      const span = band.upToPctFpl - lo;
      const frac =
        span > 0 ? Math.min(1, Math.max(0, (pctFpl - lo) / span)) : 0;
      applicablePct = band.initialPct + (band.finalPct - band.initialPct) * frac;
      break;
    }
  }
  const expected = (applicablePct / 100) * args.magi;
  return {
    credit: roundCent(Math.max(0, args.benchmarkAnnual - expected)),
    pctFpl: roundCent(pctFpl),
    applicablePct: roundCent(applicablePct),
    fpl,
    cliff,
    overCliff: false,
  };
}
