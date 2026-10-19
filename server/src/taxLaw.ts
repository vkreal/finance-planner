// Versioned federal tax-law table for the Roth Conversion view —
// the single source of law figures for the shared tax engine
// (server/src/taxEngine.ts), imported by the client via the
// "@space/server/*" path and by the server accuracy fixtures, so
// the numbers the fixtures pin are the numbers the view runs.
//
// One row per law year. Updating the app for a new tax year is
// adding one year's row from that year's IRS Rev. Proc. / CMS
// release — no engine change. Every figure's source is cited in
// DATA-PLAN.md ("Roth Conversion view — tax-law table").
//
// MODELING CONVENTION (today's dollars, consistent with the rest
// of the app): the engine always prices with the NEWEST table row
// (2026) in today's dollars — inflation-indexed figures (brackets,
// standard deduction, LTCG thresholds, IRMAA tiers except the
// frozen top tier) therefore stay constant in real terms, exactly
// as the Retirement engines treat returns. NON-indexed figures
// (Social Security provisional-income thresholds, NIIT thresholds)
// are DEFLATED year by year at the plan's inflation input inside
// the engine; the top IRMAA tier's $500k single / $750k joint
// floor, fixed by statute through 2028 and indexed after that, is
// deflated only for the 2027–2028 steps. The 2025 row is kept
// so a year can be priced under 2025 law exactly (the fixtures do).

export type FilingStatus = "mfj" | "single" | "hoh";

export type IrmaaTier = {
  // Highest MAGI (inclusive) in this tier, per filing status.
  upToSingle: number;
  upToMfj: number;
  // TOTAL Part B monthly premium per person at this tier (the
  // surcharge is total − standard premium for the year).
  partBTotalMonthly: number;
  // Part D monthly surcharge per person at this tier.
  partDSurchargeMonthly: number;
};

export type YearLaw = {
  year: number;
  // Ordinary-income bracket TOPS (taxable income) by filing
  // status, aligned with `rates`. Last top is Infinity.
  rates: number[];
  brackets: Record<FilingStatus, number[]>;
  standardDeduction: Record<FilingStatus, number>;
  // Extra standard deduction per person aged 65+ (per spouse for
  // MFJ), by filing status of the return.
  age65Addon: Record<FilingStatus, number>;
  // Long-term capital gains: taxable-income ceiling for the 0%
  // rate, and the taxable-income floor above which the 20% rate
  // applies (15% between), by filing status.
  ltcgZeroTop: Record<FilingStatus, number>;
  ltcg20Floor: Record<FilingStatus, number>;
  // Net Investment Income Tax: MAGI threshold by filing status
  // (statutory, NOT inflation-indexed) and rate.
  niitThreshold: Record<FilingStatus, number>;
  niitRate: number;
  // Standard Part B premium per person per month (no surcharge).
  partBStandardMonthly: number;
  irmaaTiers: IrmaaTier[];
  // Qualified charitable distribution annual limit per person.
  qcdLimit: number;
  /* ---- Work-years limits (ALL IN CENTS) — the contribution /
     payroll figures the Work years tab's engine (server/src/
     workYears.ts) reads. Unlike the dollar figures above, these
     are stored in integer cents because the saved job inputs
     they combine with (salary, employer contributions) are
     cents end to end. Sources: IRS Notice 2024-80 (2025) and
     Notice 2025-67 / SSA wage-base release (2026) for the
     deferral / catch-up / §415(c) / wage-base figures; the HSA
     limits are from Rev. Proc. 2024-18 (2025) and Rev. Proc.
     2025-19 (2026). ---- */
  // §402(g) elective deferral limit (401(k)).
  elective401kLimit: number;
  // §414(v) age-50+ catch-up limit.
  catchUp50Limit: number;
  // §414(v) higher catch-up limit for ages 60–63 (SECURE 2.0).
  catchUp60to63Limit: number;
  // §415(c) overall defined-contribution limit (all sources).
  overall415cLimit: number;
  // HSA contribution limit, self-only coverage.
  hsaLimitSelf: number;
  // HSA contribution limit, family coverage.
  hsaLimitFamily: number;
  // HSA age-55+ catch-up (statutory, not indexed).
  hsaCatchUp55: number;
  // Social Security taxable wage base.
  ssWageBase: number;
  // Prior-year wage threshold above which catch-ups must be
  // Roth (IRC §414(v)(7), added by SECURE 2.0 §603; the engine
  // uses the entered salary as the wage proxy — disclosed on
  // the tab). The mandate itself applies only to tax years
  // after 2025 (IRS Notice 2023-62 transition period);
  // workYears.ts gates on the law row's year.
  rothCatchUpWageThreshold: number;
  /* ---- Gift / kiddie-tax figures (ALL IN CENTS) — read only by
     the gift what-if model (server/src/giftModel.ts). Sources:
     IRS Rev. Proc. 2024-40 (2025) and Rev. Proc. 2025-32 (2026);
     see DATA-PLAN.md. ---- */
  // Gift-tax annual exclusion per donor per recipient
  // (IRC §2503(b)): $19,000 in both 2025 and 2026.
  giftAnnualExclusionCents: number;
  // Kiddie-tax threshold (IRC §1(g)): a child's net unearned
  // income is unearned income above TWICE the amount in effect
  // under §63(c)(5)(A) ($1,350 in both 2025 and 2026), so the
  // threshold is $2,700 in both years.
  kiddieTaxThresholdCents: number;
};

/* -------- FICA payroll-tax rates (named constants) --------
   Employee share: Social Security 6.2% up to the year's wage
   base (in the law row above), Medicare 1.45% on all FICA
   wages, plus the 0.9% Additional Medicare Tax on wages over
   $250,000 (MFJ) / $200,000 (Single or HOH) — the statutory
   withholding thresholds, not indexed. */
export const FICA_RATES = {
  socialSecurityPct: 6.2,
  medicarePct: 1.45,
  additionalMedicarePct: 0.9,
  additionalMedicareThreshold: { mfj: 250000, single: 200000, hoh: 200000 } as Record<
    FilingStatus,
    number
  >,
};

export const TAX_RATES = [10, 12, 22, 24, 32, 35, 37];

export const TAX_LAW_2025: YearLaw = {
  year: 2025,
  rates: TAX_RATES,
  brackets: {
    mfj: [23850, 96950, 206700, 394600, 501050, 751600, Infinity],
    single: [11925, 48475, 103350, 197300, 250525, 626350, Infinity],
    hoh: [17000, 64850, 103350, 197300, 250500, 626350, Infinity],
  },
  // OBBBA amounts (Rev. Proc. 2024-40 as amended by OBBBA §70102).
  standardDeduction: { mfj: 31500, single: 15750, hoh: 23625 },
  age65Addon: { mfj: 1600, single: 2000, hoh: 2000 },
  ltcgZeroTop: { mfj: 96700, single: 48350, hoh: 64750 },
  ltcg20Floor: { mfj: 600050, single: 533400, hoh: 566700 },
  niitThreshold: { mfj: 250000, single: 200000, hoh: 200000 },
  niitRate: 3.8,
  partBStandardMonthly: 185.0,
  irmaaTiers: [
    { upToSingle: 106000, upToMfj: 212000, partBTotalMonthly: 185.0, partDSurchargeMonthly: 0 },
    { upToSingle: 133000, upToMfj: 266000, partBTotalMonthly: 259.0, partDSurchargeMonthly: 13.7 },
    { upToSingle: 167000, upToMfj: 334000, partBTotalMonthly: 370.0, partDSurchargeMonthly: 35.3 },
    { upToSingle: 200000, upToMfj: 400000, partBTotalMonthly: 480.9, partDSurchargeMonthly: 57.0 },
    { upToSingle: 499999, upToMfj: 749999, partBTotalMonthly: 591.9, partDSurchargeMonthly: 78.6 },
    { upToSingle: Infinity, upToMfj: Infinity, partBTotalMonthly: 628.9, partDSurchargeMonthly: 85.8 },
  ],
  qcdLimit: 108000,
  elective401kLimit: 2350000,
  catchUp50Limit: 750000,
  catchUp60to63Limit: 1125000,
  overall415cLimit: 7000000,
  hsaLimitSelf: 430000,
  hsaLimitFamily: 855000,
  hsaCatchUp55: 100000,
  ssWageBase: 17610000,
  // §414(v)(7) statutory base: $145,000 for 2025; the
  // $150,000 threshold first applies to 2026.
  rothCatchUpWageThreshold: 14500000,
  giftAnnualExclusionCents: 1900000,
  kiddieTaxThresholdCents: 270000,
};

export const TAX_LAW_2026: YearLaw = {
  year: 2026,
  rates: TAX_RATES,
  brackets: {
    mfj: [24800, 100800, 211400, 403550, 512450, 768700, Infinity],
    single: [12400, 50400, 105700, 201775, 256225, 640600, Infinity],
    hoh: [17700, 67450, 105700, 201750, 256200, 640600, Infinity],
  },
  standardDeduction: { mfj: 32200, single: 16100, hoh: 24150 },
  age65Addon: { mfj: 1650, single: 2050, hoh: 2050 },
  ltcgZeroTop: { mfj: 98900, single: 49450, hoh: 66200 },
  ltcg20Floor: { mfj: 613700, single: 545500, hoh: 579600 },
  niitThreshold: { mfj: 250000, single: 200000, hoh: 200000 },
  niitRate: 3.8,
  partBStandardMonthly: 202.9,
  irmaaTiers: [
    { upToSingle: 109000, upToMfj: 218000, partBTotalMonthly: 202.9, partDSurchargeMonthly: 0 },
    { upToSingle: 137000, upToMfj: 274000, partBTotalMonthly: 284.1, partDSurchargeMonthly: 14.5 },
    { upToSingle: 171000, upToMfj: 342000, partBTotalMonthly: 405.8, partDSurchargeMonthly: 37.5 },
    { upToSingle: 205000, upToMfj: 410000, partBTotalMonthly: 527.5, partDSurchargeMonthly: 60.4 },
    { upToSingle: 499999, upToMfj: 749999, partBTotalMonthly: 649.2, partDSurchargeMonthly: 83.3 },
    { upToSingle: Infinity, upToMfj: Infinity, partBTotalMonthly: 689.9, partDSurchargeMonthly: 91.0 },
  ],
  qcdLimit: 111000,
  elective401kLimit: 2450000,
  catchUp50Limit: 800000,
  catchUp60to63Limit: 1125000,
  overall415cLimit: 7200000,
  hsaLimitSelf: 440000,
  hsaLimitFamily: 875000,
  hsaCatchUp55: 100000,
  ssWageBase: 18450000,
  rothCatchUpWageThreshold: 15000000,
  giftAnnualExclusionCents: 1900000,
  kiddieTaxThresholdCents: 270000,
};

export const TAX_LAW_YEARS: YearLaw[] = [TAX_LAW_2025, TAX_LAW_2026];
// The newest published row in the table, derived from the table
// itself so it can never drift from it: the same row lawForYear
// falls back to for years with no published row, and the row
// apiProvenance reports as the current law year. Adding a new
// year's row to TAX_LAW_YEARS moves this pointer automatically.
export const CURRENT_LAW: YearLaw = TAX_LAW_YEARS[TAX_LAW_YEARS.length - 1]!;

export function lawForYear(year: number): YearLaw {
  // Called once per priced year in every simulation; the table
  // is static, so resolve by direct comparison instead of a
  // find() scan (identical result: first matching row, else the
  // current-law fallback).
  for (const law of TAX_LAW_YEARS) {
    if (law.year === year) return law;
  }
  return CURRENT_LAW;
}

/* -------- OBBBA senior deduction (2025–2028 only) --------
   $6,000 per person aged 65+, on top of the standard deduction
   (available whether or not the filer itemizes — the engine only
   models standard-deduction filers). Phases out at 6% of MAGI
   over $75,000 single / $150,000 joint; not available MFS (the
   engine has no MFS status). Amounts are statutory (not indexed).
   §224 MAGI adds back only foreign-income exclusions (which the
   engine does not model) — it does NOT add back tax-exempt
   interest, so the engine phases the deduction out on AGI. */
export const SENIOR_DEDUCTION = {
  amountPerPerson: 6000,
  firstYear: 2025,
  lastYear: 2028,
  phaseOutStart: { mfj: 150000, single: 75000, hoh: 75000 } as Record<FilingStatus, number>,
  phaseOutRate: 0.06,
};

/* -------- Social Security provisional income (IRC §86) --------
   Statutory thresholds, NOT inflation-indexed — the engine
   deflates them in today's-dollars modeling, which is what makes
   the "tax torpedo" widen over time. */
export const SS_THRESHOLDS: Record<FilingStatus, { first: number; second: number }> = {
  mfj: { first: 32000, second: 44000 },
  single: { first: 25000, second: 34000 },
  hoh: { first: 25000, second: 34000 },
};

/* -------- HHS poverty guidelines (48 contiguous states) --------
   ACA premium credits for a coverage year use the guidelines for
   the year BEFORE the coverage year (e.g. 2026 coverage uses the
   2025 guidelines: household of 2 = $21,150, so 400% FPL =
   $84,600; household of 3 = $26,650, 400% = $106,600). In
   today's-dollars modeling the guidelines are inflation-indexed,
   so future coverage years reuse the newest row: guideline years
   beyond the newest row (2026) fall back to that newest row, not
   to an older one. */
export const FPL_GUIDELINES: Record<number, { base: number; perAdditional: number }> = {
  2024: { base: 15060, perAdditional: 5380 },
  2025: { base: 15650, perAdditional: 5500 },
  // 2026 guidelines (Federal Register, Jan. 15, 2026; FR Doc.
  // 2026-00755): household of 2 = $21,640, so the 2027-coverage
  // ACA cliff for a household of 2 is $86,560.
  2026: { base: 15960, perAdditional: 5680 },
};
export function fplFor(householdSize: number, guidelineYear: number): number {
  // Fallback is the NEWEST row (2026): guideline years beyond the
  // table reuse the newest guidelines, per the convention above.
  const newest =
    FPL_GUIDELINES[Math.max(...Object.keys(FPL_GUIDELINES).map(Number))] ??
    { base: 15960, perAdditional: 5680 };
  const g = FPL_GUIDELINES[guidelineYear] ?? newest;
  const size = Math.max(1, Math.round(householdSize));
  return g.base + g.perAdditional * (size - 1);
}

/* -------- ACA applicable percentages (IRC §36B) --------
   Share of household income the household is expected to pay
   toward the benchmark (2nd-lowest Silver) plan, by income as a
   % of FPL, linearly interpolated inside each band. At or below
   the band's lower edge the initial % applies; 300–400% rises
   to the band's cap.
   2025 is the ENHANCED schedule (ARPA §9661 as extended by the
   IRA, percentages per Rev. Proc. 2024-35): 0% below 150% FPL,
   rising 0–2% / 2–4% / 4–6% / 6–8.5% across the 150–200 /
   200–250 / 250–300 / 300–400 bands, and a flat 8.5% at 400%
   FPL and above — there is NO cliff in 2025, and the engine
   prices a credit above 400% FPL for 2025 coverage.
   Above 400% FPL there is NO credit for 2026+ (the enhanced
   credits expired Dec 31, 2025) — the cliff the engine prices. */
export type AcaBand = { upToPctFpl: number; initialPct: number; finalPct: number };
export const ACA_TABLES: Record<number, AcaBand[]> = {
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
};
export function acaTableFor(coverageYear: number): AcaBand[] {
  return ACA_TABLES[coverageYear] ?? ACA_TABLES[2026] ?? [];
}

/* -------- RMD age by birth year (SECURE 2.0 §107) --------
   Born 1951–1959 → 73 (the 1959 cohort's drafting conflict is
   resolved to 73 by proposed IRS regulations); born 1960 or
   later → 75. Earlier cohorts are shown their historical ages:
   born 1949–1950 → 72 (SECURE Act), and born 1948 or earlier
   → 70½ (the pre-July-1949 cohort's RMD age was 70½; birth
   year alone cannot split 1949, which the statute splits at
   July 1, so 1949 is priced at 72). */
export function rmdAgeForBirthYear(birthYear: number): number {
  if (birthYear >= 1960) return 75;
  if (birthYear >= 1951) return 73;
  if (birthYear >= 1949) return 72;
  return 70.5;
}

/* -------- Uniform Lifetime Table (IRS Pub. 590-B, 2022+) ---- */
export const UNIFORM_DIVISORS: Record<number, number> = {
  72: 27.4, 73: 26.5, 74: 25.5, 75: 24.6, 76: 23.7, 77: 22.9,
  78: 22.0, 79: 21.1, 80: 20.2, 81: 19.4, 82: 18.5, 83: 17.7,
  84: 16.8, 85: 16.0, 86: 15.2, 87: 14.4, 88: 13.7, 89: 12.9,
  90: 12.2, 91: 11.5, 92: 10.8, 93: 10.1, 94: 9.5, 95: 8.9,
  96: 8.4, 97: 7.8, 98: 7.3, 99: 6.8, 100: 6.4, 101: 6.0,
  102: 5.6, 103: 5.2, 104: 4.9, 105: 4.6, 106: 4.3, 107: 4.1,
  108: 3.9, 109: 3.7, 110: 3.5, 111: 3.4, 112: 3.3, 113: 3.1,
  114: 3.0, 115: 2.9, 116: 2.8, 117: 2.7, 118: 2.5, 119: 2.3,
  120: 2.0,
};
export function uniformDivisor(age: number): number {
  if (age <= 72) return UNIFORM_DIVISORS[72] ?? 27.4;
  if (age >= 120) return UNIFORM_DIVISORS[120] ?? 2.0;
  return UNIFORM_DIVISORS[age] ?? UNIFORM_DIVISORS[119] ?? 2.3;
}

/* -------- Joint Life and Last Survivor Table (Table II) ----
   Used only when the spouse is the sole beneficiary AND more
   than 10 years younger. COMPLETE transcription of Table II
   as published in IRS Publication 590-B (2025), Appendix B —
   the table of Treas. Reg. §1.401(a)(9)-9(d), as updated by
   T.D. 9930 for distribution years 2022 and later: owner
   ages 70–120 × spouse ages 20–120, every cell (each row
   below is indexed by spouse age − 20). Transcription
   validated at the E2 build (2026-10-19) three ways: (1) all
   176 cells of the partial grid this table replaces match
   the published values exactly; (2) the published table is
   symmetric in the two ages, and the transcription has zero
   asymmetries and zero monotonicity violations; (3) spot
   checks against the publication — owner 75 / spouse 64 =
   25.3 (the IRS worksheet worked example), owner 75 /
   spouse 54 = 33.2, owner 86 / spouse 75 = 15.9. Ages
   outside the published table clamp to its edges; the
   table's own last row is "120+", the same treatment the
   Uniform table above gives its top age.
   (E2 history: the previous partial grid — owner 72–85 ×
   spouse 60–69 plus owner 80–85 × spouse 70–75 — clamped
   every outside pair to the nearest covered cell, which
   UNDERSTATED the divisor for much-younger spouses (75/54
   read 28.3, the spouse-60 cell, against the true 33.2 —
   an RMD overstated by $41,721.65 on an $8,000,000 balance)
   and OVERSTATED it at advanced ages (86/75 read 16.0
   against the true 15.9), mispricing RMDs both ways.) */
const JOINT_LIFE_TABLE: Record<number, number[]> = {
  70: [
    65.2, 64.2, 63.2, 62.2, 61.3, 60.3, 59.4, 58.4, 57.4, 56.5,
    55.5, 54.6, 53.6, 52.7, 51.7, 50.8, 49.9, 48.9, 48.0, 47.0,
    46.1, 45.2, 44.3, 43.3, 42.4, 41.5, 40.6, 39.7, 38.8, 38.0,
    37.1, 36.2, 35.4, 34.6, 33.8, 33.0, 32.2, 31.4, 30.7, 29.9,
    29.2, 28.5, 27.9, 27.2, 26.6, 26.0, 25.4, 24.9, 24.3, 23.9,
    23.4, 22.9, 22.5, 22.2, 21.8, 21.5, 21.2, 20.9, 20.6, 20.4,
    20.2, 20.0, 19.9, 19.7, 19.6, 19.5, 19.4, 19.3, 19.2, 19.2,
    19.1, 19.1, 19.0, 19.0, 19.0, 18.9, 18.9, 18.9, 18.9, 18.9,
    18.9, 18.9, 18.8, 18.8, 18.8, 18.8, 18.8, 18.8, 18.8, 18.8,
    18.8, 18.8, 18.8, 18.8, 18.8, 18.8, 18.8, 18.8, 18.8, 18.8,
    18.8,
  ],
  71: [
    65.1, 64.2, 63.2, 62.2, 61.3, 60.3, 59.3, 58.4, 57.4, 56.5,
    55.5, 54.6, 53.6, 52.7, 51.7, 50.8, 49.8, 48.9, 47.9, 47.0,
    46.1, 45.1, 44.2, 43.3, 42.4, 41.5, 40.6, 39.7, 38.8, 37.9,
    37.0, 36.1, 35.3, 34.5, 33.6, 32.8, 32.0, 31.2, 30.5, 29.7,
    29.0, 28.3, 27.6, 26.9, 26.3, 25.7, 25.1, 24.5, 24.0, 23.4,
    22.9, 22.5, 22.0, 21.6, 21.3, 20.9, 20.6, 20.3, 20.0, 19.8,
    19.6, 19.4, 19.2, 19.0, 18.9, 18.8, 18.7, 18.6, 18.5, 18.4,
    18.4, 18.3, 18.3, 18.2, 18.2, 18.2, 18.1, 18.1, 18.1, 18.1,
    18.1, 18.1, 18.0, 18.0, 18.0, 18.0, 18.0, 18.0, 18.0, 18.0,
    18.0, 18.0, 18.0, 18.0, 18.0, 18.0, 18.0, 18.0, 18.0, 18.0,
    18.0,
  ],
  72: [
    65.1, 64.2, 63.2, 62.2, 61.3, 60.3, 59.3, 58.4, 57.4, 56.5,
    55.5, 54.5, 53.6, 52.6, 51.7, 50.8, 49.8, 48.9, 47.9, 47.0,
    46.0, 45.1, 44.2, 43.2, 42.3, 41.4, 40.5, 39.6, 38.7, 37.8,
    36.9, 36.0, 35.2, 34.3, 33.5, 32.7, 31.9, 31.1, 30.3, 29.5,
    28.8, 28.1, 27.4, 26.7, 26.0, 25.4, 24.8, 24.2, 23.6, 23.1,
    22.5, 22.0, 21.6, 21.1, 20.7, 20.4, 20.0, 19.7, 19.4, 19.2,
    18.9, 18.7, 18.5, 18.3, 18.2, 18.1, 17.9, 17.8, 17.7, 17.7,
    17.6, 17.5, 17.5, 17.4, 17.4, 17.4, 17.4, 17.3, 17.3, 17.3,
    17.3, 17.3, 17.3, 17.3, 17.2, 17.2, 17.2, 17.2, 17.2, 17.2,
    17.2, 17.2, 17.2, 17.2, 17.2, 17.2, 17.2, 17.2, 17.2, 17.2,
    17.2,
  ],
  73: [
    65.1, 64.2, 63.2, 62.2, 61.2, 60.3, 59.3, 58.4, 57.4, 56.4,
    55.5, 54.5, 53.6, 52.6, 51.7, 50.7, 49.8, 48.8, 47.9, 46.9,
    46.0, 45.1, 44.1, 43.2, 42.3, 41.4, 40.4, 39.5, 38.6, 37.7,
    36.8, 36.0, 35.1, 34.2, 33.4, 32.6, 31.7, 30.9, 30.1, 29.4,
    28.6, 27.9, 27.2, 26.5, 25.8, 25.1, 24.5, 23.9, 23.3, 22.7,
    22.2, 21.6, 21.1, 20.7, 20.3, 19.9, 19.5, 19.1, 18.8, 18.6,
    18.3, 18.1, 17.9, 17.7, 17.5, 17.4, 17.2, 17.1, 17.0, 16.9,
    16.9, 16.8, 16.7, 16.7, 16.6, 16.6, 16.6, 16.6, 16.5, 16.5,
    16.5, 16.5, 16.5, 16.5, 16.5, 16.5, 16.5, 16.5, 16.5, 16.4,
    16.4, 16.4, 16.4, 16.4, 16.4, 16.4, 16.4, 16.4, 16.4, 16.4,
    16.4,
  ],
  74: [
    65.1, 64.1, 63.2, 62.2, 61.2, 60.3, 59.3, 58.3, 57.4, 56.4,
    55.5, 54.5, 53.6, 52.6, 51.7, 50.7, 49.8, 48.8, 47.9, 46.9,
    46.0, 45.0, 44.1, 43.2, 42.2, 41.3, 40.4, 39.5, 38.6, 37.7,
    36.8, 35.9, 35.0, 34.1, 33.3, 32.4, 31.6, 30.8, 30.0, 29.2,
    28.4, 27.7, 27.0, 26.2, 25.5, 24.9, 24.2, 23.6, 23.0, 22.4,
    21.8, 21.3, 20.7, 20.3, 19.8, 19.4, 19.0, 18.6, 18.3, 18.0,
    17.7, 17.4, 17.2, 17.0, 16.8, 16.7, 16.5, 16.4, 16.3, 16.2,
    16.1, 16.1, 16.0, 15.9, 15.9, 15.9, 15.8, 15.8, 15.8, 15.7,
    15.7, 15.7, 15.7, 15.7, 15.7, 15.7, 15.7, 15.7, 15.7, 15.7,
    15.7, 15.7, 15.7, 15.7, 15.7, 15.7, 15.6, 15.6, 15.6, 15.6,
    15.6,
  ],
  75: [
    65.1, 64.1, 63.2, 62.2, 61.2, 60.3, 59.3, 58.3, 57.4, 56.4,
    55.5, 54.5, 53.5, 52.6, 51.6, 50.7, 49.7, 48.8, 47.8, 46.9,
    45.9, 45.0, 44.1, 43.1, 42.2, 41.3, 40.3, 39.4, 38.5, 37.6,
    36.7, 35.8, 34.9, 34.1, 33.2, 32.4, 31.5, 30.7, 29.9, 29.1,
    28.3, 27.5, 26.8, 26.1, 25.3, 24.6, 24.0, 23.3, 22.7, 22.1,
    21.5, 20.9, 20.4, 19.9, 19.4, 18.9, 18.5, 18.1, 17.8, 17.4,
    17.1, 16.9, 16.6, 16.4, 16.2, 16.0, 15.9, 15.7, 15.6, 15.5,
    15.4, 15.3, 15.3, 15.2, 15.2, 15.1, 15.1, 15.0, 15.0, 15.0,
    15.0, 15.0, 14.9, 14.9, 14.9, 14.9, 14.9, 14.9, 14.9, 14.9,
    14.9, 14.9, 14.9, 14.9, 14.9, 14.9, 14.9, 14.9, 14.9, 14.8,
    14.8,
  ],
  76: [
    65.1, 64.1, 63.2, 62.2, 61.2, 60.2, 59.3, 58.3, 57.4, 56.4,
    55.4, 54.5, 53.5, 52.6, 51.6, 50.7, 49.7, 48.8, 47.8, 46.9,
    45.9, 45.0, 44.0, 43.1, 42.2, 41.2, 40.3, 39.4, 38.5, 37.5,
    36.6, 35.7, 34.9, 34.0, 33.1, 32.3, 31.4, 30.6, 29.8, 29.0,
    28.2, 27.4, 26.6, 25.9, 25.2, 24.4, 23.7, 23.1, 22.4, 21.8,
    21.2, 20.6, 20.0, 19.5, 19.0, 18.5, 18.1, 17.7, 17.3, 16.9,
    16.6, 16.3, 16.0, 15.8, 15.6, 15.4, 15.2, 15.1, 14.9, 14.8,
    14.8, 14.6, 14.6, 14.5, 14.4, 14.4, 14.3, 14.3, 14.3, 14.3,
    14.2, 14.2, 14.2, 14.2, 14.2, 14.2, 14.2, 14.2, 14.2, 14.2,
    14.2, 14.2, 14.2, 14.2, 14.1, 14.1, 14.1, 14.1, 14.1, 14.1,
    14.1,
  ],
  77: [
    65.1, 64.1, 63.1, 62.2, 61.2, 60.2, 59.3, 58.3, 57.3, 56.4,
    55.4, 54.5, 53.5, 52.6, 51.6, 50.7, 49.7, 48.8, 47.8, 46.9,
    45.9, 45.0, 44.0, 43.1, 42.1, 41.2, 40.3, 39.3, 38.4, 37.5,
    36.6, 35.7, 34.8, 33.9, 33.0, 32.2, 31.3, 30.5, 29.7, 28.8,
    28.0, 27.3, 26.5, 25.7, 25.0, 24.3, 23.5, 22.9, 22.2, 21.5,
    20.9, 20.3, 19.7, 19.1, 18.6, 18.1, 17.7, 17.2, 16.8, 16.4,
    16.1, 15.8, 15.5, 15.2, 15.0, 14.8, 14.6, 14.4, 14.3, 14.2,
    14.1, 14.0, 13.9, 13.8, 13.7, 13.7, 13.6, 13.6, 13.6, 13.5,
    13.5, 13.5, 13.5, 13.5, 13.5, 13.4, 13.4, 13.4, 13.4, 13.4,
    13.4, 13.4, 13.4, 13.4, 13.4, 13.4, 13.4, 13.4, 13.4, 13.4,
    13.3,
  ],
  78: [
    65.1, 64.1, 63.1, 62.2, 61.2, 60.2, 59.3, 58.3, 57.3, 56.4,
    55.4, 54.5, 53.5, 52.6, 51.6, 50.6, 49.7, 48.7, 47.8, 46.8,
    45.9, 44.9, 44.0, 43.0, 42.1, 41.2, 40.2, 39.3, 38.4, 37.5,
    36.5, 35.6, 34.7, 33.9, 33.0, 32.1, 31.2, 30.4, 29.6, 28.7,
    27.9, 27.1, 26.4, 25.6, 24.8, 24.1, 23.4, 22.7, 22.0, 21.3,
    20.6, 20.0, 19.4, 18.8, 18.3, 17.8, 17.3, 16.8, 16.4, 16.0,
    15.6, 15.3, 15.0, 14.7, 14.4, 14.2, 14.0, 13.8, 13.7, 13.5,
    13.4, 13.3, 13.2, 13.1, 13.1, 13.0, 12.9, 12.9, 12.9, 12.8,
    12.8, 12.8, 12.8, 12.8, 12.7, 12.7, 12.7, 12.7, 12.7, 12.7,
    12.7, 12.7, 12.7, 12.7, 12.7, 12.7, 12.7, 12.7, 12.6, 12.6,
    12.6,
  ],
  79: [
    65.1, 64.1, 63.1, 62.2, 61.2, 60.2, 59.3, 58.3, 57.3, 56.4,
    55.4, 54.5, 53.5, 52.5, 51.6, 50.6, 49.7, 48.7, 47.8, 46.8,
    45.9, 44.9, 44.0, 43.0, 42.1, 41.1, 40.2, 39.3, 38.3, 37.4,
    36.5, 35.6, 34.7, 33.8, 32.9, 32.0, 31.2, 30.3, 29.5, 28.7,
    27.8, 27.0, 26.2, 25.5, 24.7, 23.9, 23.2, 22.5, 21.8, 21.1,
    20.4, 19.8, 19.2, 18.6, 18.0, 17.4, 16.9, 16.4, 16.0, 15.6,
    15.2, 14.8, 14.5, 14.2, 13.9, 13.6, 13.4, 13.2, 13.1, 12.9,
    12.8, 12.7, 12.6, 12.5, 12.4, 12.3, 12.3, 12.2, 12.2, 12.2,
    12.1, 12.1, 12.1, 12.1, 12.0, 12.0, 12.0, 12.0, 12.0, 12.0,
    12.0, 12.0, 12.0, 12.0, 12.0, 12.0, 12.0, 12.0, 11.9, 11.9,
    11.9,
  ],
  80: [
    65.1, 64.1, 63.1, 62.1, 61.2, 60.2, 59.2, 58.3, 57.3, 56.4,
    55.4, 54.4, 53.5, 52.5, 51.6, 50.6, 49.7, 48.7, 47.8, 46.8,
    45.9, 44.9, 43.9, 43.0, 42.1, 41.1, 40.2, 39.2, 38.3, 37.4,
    36.5, 35.5, 34.6, 33.7, 32.9, 32.0, 31.1, 30.3, 29.4, 28.6,
    27.8, 26.9, 26.1, 25.3, 24.6, 23.8, 23.1, 22.3, 21.6, 20.9,
    20.2, 19.6, 18.9, 18.3, 17.7, 17.1, 16.6, 16.1, 15.6, 15.2,
    14.7, 14.4, 14.0, 13.7, 13.4, 13.1, 12.9, 12.7, 12.5, 12.3,
    12.2, 12.1, 11.9, 11.9, 11.8, 11.7, 11.6, 11.6, 11.5, 11.5,
    11.5, 11.4, 11.4, 11.4, 11.4, 11.4, 11.4, 11.4, 11.4, 11.3,
    11.3, 11.3, 11.3, 11.3, 11.3, 11.3, 11.3, 11.3, 11.3, 11.2,
    11.2,
  ],
  81: [
    65.1, 64.1, 63.1, 62.1, 61.2, 60.2, 59.2, 58.3, 57.3, 56.4,
    55.4, 54.4, 53.5, 52.5, 51.6, 50.6, 49.7, 48.7, 47.7, 46.8,
    45.8, 44.9, 43.9, 43.0, 42.0, 41.1, 40.1, 39.2, 38.3, 37.3,
    36.4, 35.5, 34.6, 33.7, 32.8, 31.9, 31.1, 30.2, 29.3, 28.5,
    27.7, 26.9, 26.0, 25.2, 24.5, 23.7, 22.9, 22.2, 21.5, 20.7,
    20.0, 19.4, 18.7, 18.1, 17.4, 16.9, 16.3, 15.8, 15.3, 14.8,
    14.4, 14.0, 13.6, 13.2, 12.9, 12.6, 12.4, 12.2, 12.0, 11.8,
    11.6, 11.5, 11.4, 11.3, 11.2, 11.1, 11.0, 11.0, 10.9, 10.9,
    10.8, 10.8, 10.8, 10.7, 10.7, 10.7, 10.7, 10.7, 10.7, 10.7,
    10.7, 10.7, 10.7, 10.7, 10.7, 10.7, 10.6, 10.6, 10.6, 10.6,
    10.5,
  ],
  82: [
    65.1, 64.1, 63.1, 62.1, 61.2, 60.2, 59.2, 58.3, 57.3, 56.3,
    55.4, 54.4, 53.5, 52.5, 51.6, 50.6, 49.7, 48.7, 47.7, 46.8,
    45.8, 44.9, 43.9, 43.0, 42.0, 41.1, 40.1, 39.2, 38.3, 37.3,
    36.4, 35.5, 34.6, 33.7, 32.8, 31.9, 31.0, 30.1, 29.3, 28.4,
    27.6, 26.8, 26.0, 25.2, 24.4, 23.6, 22.8, 22.1, 21.3, 20.6,
    19.9, 19.2, 18.5, 17.9, 17.2, 16.6, 16.0, 15.5, 15.0, 14.5,
    14.0, 13.6, 13.2, 12.8, 12.5, 12.2, 11.9, 11.7, 11.5, 11.3,
    11.1, 10.9, 10.8, 10.7, 10.6, 10.5, 10.4, 10.4, 10.3, 10.2,
    10.2, 10.2, 10.1, 10.1, 10.1, 10.1, 10.1, 10.1, 10.1, 10.1,
    10.1, 10.1, 10.1, 10.0, 10.0, 10.0, 10.0, 10.0, 10.0, 9.9,
    9.9,
  ],
  83: [
    65.1, 64.1, 63.1, 62.1, 61.2, 60.2, 59.2, 58.3, 57.3, 56.3,
    55.4, 54.4, 53.5, 52.5, 51.6, 50.6, 49.6, 48.7, 47.7, 46.8,
    45.8, 44.9, 43.9, 43.0, 42.0, 41.1, 40.1, 39.2, 38.2, 37.3,
    36.4, 35.4, 34.5, 33.6, 32.7, 31.8, 31.0, 30.1, 29.2, 28.4,
    27.5, 26.7, 25.9, 25.1, 24.3, 23.5, 22.7, 22.0, 21.2, 20.5,
    19.7, 19.0, 18.3, 17.7, 17.0, 16.4, 15.8, 15.2, 14.7, 14.2,
    13.7, 13.2, 12.8, 12.4, 12.1, 11.8, 11.5, 11.2, 11.0, 10.8,
    10.6, 10.4, 10.3, 10.1, 10.0, 9.9, 9.9, 9.8, 9.7, 9.7,
    9.6, 9.6, 9.6, 9.5, 9.5, 9.5, 9.5, 9.5, 9.5, 9.5,
    9.5, 9.5, 9.5, 9.4, 9.4, 9.4, 9.4, 9.4, 9.3, 9.3,
    9.3,
  ],
  84: [
    65.1, 64.1, 63.1, 62.1, 61.2, 60.2, 59.2, 58.3, 57.3, 56.3,
    55.4, 54.4, 53.5, 52.5, 51.5, 50.6, 49.6, 48.7, 47.7, 46.8,
    45.8, 44.9, 43.9, 42.9, 42.0, 41.0, 40.1, 39.2, 38.2, 37.3,
    36.3, 35.4, 34.5, 33.6, 32.7, 31.8, 30.9, 30.0, 29.2, 28.3,
    27.5, 26.7, 25.8, 25.0, 24.2, 23.4, 22.6, 21.9, 21.1, 20.4,
    19.6, 18.9, 18.2, 17.5, 16.8, 16.2, 15.6, 15.0, 14.4, 13.9,
    13.4, 12.9, 12.5, 12.1, 11.7, 11.4, 11.1, 10.8, 10.5, 10.3,
    10.1, 9.9, 9.8, 9.6, 9.5, 9.4, 9.3, 9.2, 9.2, 9.1,
    9.1, 9.0, 9.0, 9.0, 8.9, 8.9, 8.9, 8.9, 8.9, 8.9,
    8.9, 8.9, 8.9, 8.9, 8.9, 8.8, 8.8, 8.8, 8.8, 8.7,
    8.7,
  ],
  85: [
    65.1, 64.1, 63.1, 62.1, 61.2, 60.2, 59.2, 58.3, 57.3, 56.3,
    55.4, 54.4, 53.5, 52.5, 51.5, 50.6, 49.6, 48.7, 47.7, 46.8,
    45.8, 44.8, 43.9, 42.9, 42.0, 41.0, 40.1, 39.1, 38.2, 37.3,
    36.3, 35.4, 34.5, 33.6, 32.7, 31.8, 30.9, 30.0, 29.1, 28.3,
    27.4, 26.6, 25.8, 25.0, 24.1, 23.3, 22.6, 21.8, 21.0, 20.3,
    19.5, 18.8, 18.1, 17.4, 16.7, 16.0, 15.4, 14.8, 14.2, 13.6,
    13.1, 12.6, 12.2, 11.8, 11.4, 11.0, 10.7, 10.4, 10.1, 9.9,
    9.7, 9.5, 9.3, 9.2, 9.0, 8.9, 8.8, 8.7, 8.7, 8.6,
    8.5, 8.5, 8.5, 8.4, 8.4, 8.4, 8.4, 8.4, 8.4, 8.4,
    8.3, 8.3, 8.3, 8.3, 8.3, 8.3, 8.3, 8.2, 8.2, 8.2,
    8.1,
  ],
  86: [
    65.1, 64.1, 63.1, 62.1, 61.1, 60.2, 59.2, 58.2, 57.3, 56.3,
    55.4, 54.4, 53.5, 52.5, 51.5, 50.6, 49.6, 48.7, 47.7, 46.7,
    45.8, 44.8, 43.9, 42.9, 42.0, 41.0, 40.1, 39.1, 38.2, 37.2,
    36.3, 35.4, 34.5, 33.5, 32.6, 31.7, 30.9, 30.0, 29.1, 28.2,
    27.4, 26.6, 25.7, 24.9, 24.1, 23.3, 22.5, 21.7, 20.9, 20.2,
    19.4, 18.7, 17.9, 17.2, 16.5, 15.9, 15.2, 14.6, 14.0, 13.4,
    12.9, 12.4, 11.9, 11.5, 11.1, 10.7, 10.4, 10.0, 9.8, 9.5,
    9.3, 9.1, 8.9, 8.7, 8.6, 8.5, 8.4, 8.3, 8.2, 8.1,
    8.0, 8.0, 8.0, 7.9, 7.9, 7.9, 7.9, 7.9, 7.8, 7.8,
    7.8, 7.8, 7.8, 7.8, 7.8, 7.8, 7.7, 7.7, 7.7, 7.6,
    7.6,
  ],
  87: [
    65.0, 64.1, 63.1, 62.1, 61.1, 60.2, 59.2, 58.2, 57.3, 56.3,
    55.4, 54.4, 53.4, 52.5, 51.5, 50.6, 49.6, 48.7, 47.7, 46.7,
    45.8, 44.8, 43.9, 42.9, 42.0, 41.0, 40.1, 39.1, 38.2, 37.2,
    36.3, 35.4, 34.4, 33.5, 32.6, 31.7, 30.8, 29.9, 29.1, 28.2,
    27.4, 26.5, 25.7, 24.9, 24.0, 23.2, 22.4, 21.6, 20.9, 20.1,
    19.3, 18.6, 17.8, 17.1, 16.4, 15.7, 15.1, 14.4, 13.8, 13.2,
    12.7, 12.2, 11.7, 11.2, 10.8, 10.4, 10.0, 9.7, 9.4, 9.1,
    8.9, 8.7, 8.5, 8.3, 8.2, 8.0, 7.9, 7.8, 7.7, 7.6,
    7.6, 7.5, 7.5, 7.4, 7.4, 7.4, 7.4, 7.4, 7.4, 7.4,
    7.4, 7.3, 7.3, 7.3, 7.3, 7.3, 7.3, 7.2, 7.2, 7.1,
    7.1,
  ],
  88: [
    65.0, 64.1, 63.1, 62.1, 61.1, 60.2, 59.2, 58.2, 57.3, 56.3,
    55.4, 54.4, 53.4, 52.5, 51.5, 50.6, 49.6, 48.7, 47.7, 46.7,
    45.8, 44.8, 43.9, 42.9, 42.0, 41.0, 40.0, 39.1, 38.2, 37.2,
    36.3, 35.3, 34.4, 33.5, 32.6, 31.7, 30.8, 29.9, 29.0, 28.2,
    27.3, 26.5, 25.6, 24.8, 24.0, 23.2, 22.4, 21.6, 20.8, 20.0,
    19.2, 18.5, 17.7, 17.0, 16.3, 15.6, 14.9, 14.3, 13.7, 13.1,
    12.5, 12.0, 11.5, 11.0, 10.5, 10.1, 9.8, 9.4, 9.1, 8.8,
    8.6, 8.3, 8.1, 7.9, 7.8, 7.6, 7.5, 7.4, 7.3, 7.2,
    7.2, 7.1, 7.0, 7.0, 7.0, 6.9, 6.9, 6.9, 6.9, 6.9,
    6.9, 6.9, 6.9, 6.9, 6.9, 6.8, 6.8, 6.8, 6.7, 6.6,
    6.6,
  ],
  89: [
    65.0, 64.1, 63.1, 62.1, 61.1, 60.2, 59.2, 58.2, 57.3, 56.3,
    55.4, 54.4, 53.4, 52.5, 51.5, 50.6, 49.6, 48.7, 47.7, 46.7,
    45.8, 44.8, 43.9, 42.9, 41.9, 41.0, 40.0, 39.1, 38.1, 37.2,
    36.3, 35.3, 34.4, 33.5, 32.6, 31.7, 30.8, 29.9, 29.0, 28.2,
    27.3, 26.4, 25.6, 24.8, 24.0, 23.1, 22.3, 21.5, 20.7, 20.0,
    19.2, 18.4, 17.7, 16.9, 16.2, 15.5, 14.8, 14.2, 13.5, 12.9,
    12.3, 11.8, 11.3, 10.8, 10.3, 9.9, 9.5, 9.1, 8.8, 8.5,
    8.3, 8.0, 7.8, 7.6, 7.4, 7.3, 7.1, 7.0, 6.9, 6.8,
    6.8, 6.7, 6.6, 6.6, 6.6, 6.5, 6.5, 6.5, 6.5, 6.5,
    6.5, 6.5, 6.5, 6.4, 6.4, 6.4, 6.4, 6.3, 6.3, 6.2,
    6.1,
  ],
  90: [
    65.0, 64.1, 63.1, 62.1, 61.1, 60.2, 59.2, 58.2, 57.3, 56.3,
    55.4, 54.4, 53.4, 52.5, 51.5, 50.6, 49.6, 48.6, 47.7, 46.7,
    45.8, 44.8, 43.9, 42.9, 41.9, 41.0, 40.0, 39.1, 38.1, 37.2,
    36.3, 35.3, 34.4, 33.5, 32.6, 31.7, 30.8, 29.9, 29.0, 28.1,
    27.3, 26.4, 25.6, 24.7, 23.9, 23.1, 22.3, 21.5, 20.7, 19.9,
    19.1, 18.4, 17.6, 16.9, 16.1, 15.4, 14.8, 14.1, 13.4, 12.8,
    12.2, 11.6, 11.1, 10.6, 10.1, 9.7, 9.3, 8.9, 8.6, 8.3,
    8.0, 7.7, 7.5, 7.3, 7.1, 6.9, 6.8, 6.7, 6.6, 6.5,
    6.4, 6.3, 6.3, 6.2, 6.2, 6.1, 6.1, 6.1, 6.1, 6.1,
    6.1, 6.1, 6.1, 6.1, 6.0, 6.0, 6.0, 5.9, 5.8, 5.8,
    5.7,
  ],
  91: [
    65.0, 64.1, 63.1, 62.1, 61.1, 60.2, 59.2, 58.2, 57.3, 56.3,
    55.3, 54.4, 53.4, 52.5, 51.5, 50.6, 49.6, 48.6, 47.7, 46.7,
    45.8, 44.8, 43.9, 42.9, 41.9, 41.0, 40.0, 39.1, 38.1, 37.2,
    36.2, 35.3, 34.4, 33.5, 32.5, 31.6, 30.7, 29.9, 29.0, 28.1,
    27.3, 26.4, 25.6, 24.7, 23.9, 23.1, 22.3, 21.5, 20.7, 19.9,
    19.1, 18.3, 17.5, 16.8, 16.1, 15.3, 14.6, 14.0, 13.3, 12.7,
    12.1, 11.5, 10.9, 10.4, 9.9, 9.5, 9.1, 8.7, 8.3, 8.0,
    7.7, 7.5, 7.2, 7.0, 6.8, 6.6, 6.5, 6.4, 6.2, 6.1,
    6.0, 6.0, 5.9, 5.9, 5.8, 5.8, 5.8, 5.8, 5.7, 5.7,
    5.7, 5.7, 5.7, 5.7, 5.7, 5.6, 5.6, 5.5, 5.5, 5.4,
    5.3,
  ],
  92: [
    65.0, 64.1, 63.1, 62.1, 61.1, 60.2, 59.2, 58.2, 57.3, 56.3,
    55.3, 54.4, 53.4, 52.5, 51.5, 50.6, 49.6, 48.6, 47.7, 46.7,
    45.8, 44.8, 43.8, 42.9, 41.9, 41.0, 40.0, 39.1, 38.1, 37.2,
    36.2, 35.3, 34.4, 33.5, 32.5, 31.6, 30.7, 29.8, 29.0, 28.1,
    27.2, 26.4, 25.5, 24.7, 23.9, 23.0, 22.2, 21.4, 20.6, 19.8,
    19.0, 18.3, 17.5, 16.7, 16.0, 15.3, 14.6, 13.9, 13.2, 12.6,
    11.9, 11.4, 10.8, 10.3, 9.8, 9.3, 8.9, 8.5, 8.1, 7.8,
    7.5, 7.2, 7.0, 6.7, 6.5, 6.4, 6.2, 6.1, 5.9, 5.8,
    5.7, 5.6, 5.6, 5.5, 5.5, 5.4, 5.4, 5.4, 5.4, 5.4,
    5.4, 5.4, 5.4, 5.3, 5.3, 5.3, 5.2, 5.2, 5.1, 5.0,
    4.9,
  ],
  93: [
    65.0, 64.1, 63.1, 62.1, 61.1, 60.2, 59.2, 58.2, 57.3, 56.3,
    55.3, 54.4, 53.4, 52.5, 51.5, 50.6, 49.6, 48.6, 47.7, 46.7,
    45.8, 44.8, 43.8, 42.9, 41.9, 41.0, 40.0, 39.1, 38.1, 37.2,
    36.2, 35.3, 34.4, 33.4, 32.5, 31.6, 30.7, 29.8, 29.0, 28.1,
    27.2, 26.4, 25.5, 24.7, 23.8, 23.0, 22.2, 21.4, 20.6, 19.8,
    19.0, 18.2, 17.4, 16.7, 15.9, 15.2, 14.5, 13.8, 13.1, 12.5,
    11.9, 11.3, 10.7, 10.1, 9.6, 9.2, 8.7, 8.3, 7.9, 7.6,
    7.3, 7.0, 6.7, 6.5, 6.3, 6.1, 5.9, 5.8, 5.7, 5.5,
    5.4, 5.3, 5.3, 5.2, 5.2, 5.1, 5.1, 5.1, 5.1, 5.1,
    5.1, 5.1, 5.1, 5.0, 5.0, 5.0, 4.9, 4.9, 4.8, 4.7,
    4.6,
  ],
  94: [
    65.0, 64.1, 63.1, 62.1, 61.1, 60.2, 59.2, 58.2, 57.3, 56.3,
    55.3, 54.4, 53.4, 52.5, 51.5, 50.6, 49.6, 48.6, 47.7, 46.7,
    45.8, 44.8, 43.8, 42.9, 41.9, 41.0, 40.0, 39.1, 38.1, 37.2,
    36.2, 35.3, 34.4, 33.4, 32.5, 31.6, 30.7, 29.8, 28.9, 28.1,
    27.2, 26.3, 25.5, 24.7, 23.8, 23.0, 22.2, 21.4, 20.6, 19.8,
    19.0, 18.2, 17.4, 16.6, 15.9, 15.2, 14.4, 13.7, 13.1, 12.4,
    11.8, 11.2, 10.6, 10.0, 9.5, 9.0, 8.6, 8.2, 7.8, 7.4,
    7.1, 6.8, 6.5, 6.3, 6.1, 5.9, 5.7, 5.5, 5.4, 5.3,
    5.2, 5.1, 5.0, 4.9, 4.9, 4.9, 4.8, 4.8, 4.8, 4.8,
    4.8, 4.8, 4.8, 4.7, 4.7, 4.7, 4.6, 4.6, 4.5, 4.4,
    4.3,
  ],
  95: [
    65.0, 64.1, 63.1, 62.1, 61.1, 60.2, 59.2, 58.2, 57.3, 56.3,
    55.3, 54.4, 53.4, 52.5, 51.5, 50.6, 49.6, 48.6, 47.7, 46.7,
    45.8, 44.8, 43.8, 42.9, 41.9, 41.0, 40.0, 39.1, 38.1, 37.2,
    36.2, 35.3, 34.4, 33.4, 32.5, 31.6, 30.7, 29.8, 28.9, 28.1,
    27.2, 26.3, 25.5, 24.6, 23.8, 23.0, 22.2, 21.4, 20.6, 19.7,
    18.9, 18.2, 17.4, 16.6, 15.9, 15.1, 14.4, 13.7, 13.0, 12.3,
    11.7, 11.1, 10.5, 9.9, 9.4, 8.9, 8.5, 8.0, 7.6, 7.3,
    6.9, 6.6, 6.4, 6.1, 5.9, 5.7, 5.5, 5.3, 5.2, 5.0,
    4.9, 4.8, 4.7, 4.7, 4.6, 4.6, 4.6, 4.6, 4.5, 4.5,
    4.5, 4.5, 4.5, 4.5, 4.4, 4.4, 4.4, 4.3, 4.2, 4.1,
    4.0,
  ],
  96: [
    65.0, 64.1, 63.1, 62.1, 61.1, 60.2, 59.2, 58.2, 57.3, 56.3,
    55.3, 54.4, 53.4, 52.5, 51.5, 50.6, 49.6, 48.6, 47.7, 46.7,
    45.8, 44.8, 43.8, 42.9, 41.9, 41.0, 40.0, 39.1, 38.1, 37.2,
    36.2, 35.3, 34.3, 33.4, 32.5, 31.6, 30.7, 29.8, 28.9, 28.0,
    27.2, 26.3, 25.5, 24.6, 23.8, 23.0, 22.2, 21.3, 20.5, 19.7,
    18.9, 18.1, 17.4, 16.6, 15.8, 15.1, 14.3, 13.6, 12.9, 12.3,
    11.6, 11.0, 10.4, 9.9, 9.3, 8.8, 8.4, 7.9, 7.5, 7.1,
    6.8, 6.5, 6.2, 5.9, 5.7, 5.5, 5.3, 5.1, 5.0, 4.8,
    4.7, 4.6, 4.5, 4.5, 4.4, 4.4, 4.3, 4.3, 4.3, 4.3,
    4.3, 4.3, 4.3, 4.2, 4.2, 4.2, 4.1, 4.0, 3.9, 3.8,
    3.7,
  ],
  97: [
    65.0, 64.1, 63.1, 62.1, 61.1, 60.2, 59.2, 58.2, 57.3, 56.3,
    55.3, 54.4, 53.4, 52.5, 51.5, 50.6, 49.6, 48.6, 47.7, 46.7,
    45.8, 44.8, 43.8, 42.9, 41.9, 41.0, 40.0, 39.1, 38.1, 37.2,
    36.2, 35.3, 34.3, 33.4, 32.5, 31.6, 30.7, 29.8, 28.9, 28.0,
    27.2, 26.3, 25.5, 24.6, 23.8, 23.0, 22.1, 21.3, 20.5, 19.7,
    18.9, 18.1, 17.3, 16.6, 15.8, 15.0, 14.3, 13.6, 12.9, 12.2,
    11.6, 11.0, 10.4, 9.8, 9.2, 8.7, 8.3, 7.8, 7.4, 7.0,
    6.7, 6.4, 6.1, 5.8, 5.5, 5.3, 5.1, 4.9, 4.8, 4.6,
    4.5, 4.4, 4.3, 4.2, 4.2, 4.1, 4.1, 4.1, 4.1, 4.1,
    4.1, 4.1, 4.0, 4.0, 4.0, 4.0, 3.9, 3.8, 3.7, 3.6,
    3.4,
  ],
  98: [
    65.0, 64.1, 63.1, 62.1, 61.1, 60.2, 59.2, 58.2, 57.3, 56.3,
    55.3, 54.4, 53.4, 52.5, 51.5, 50.6, 49.6, 48.6, 47.7, 46.7,
    45.8, 44.8, 43.8, 42.9, 41.9, 41.0, 40.0, 39.1, 38.1, 37.2,
    36.2, 35.3, 34.3, 33.4, 32.5, 31.6, 30.7, 29.8, 28.9, 28.0,
    27.2, 26.3, 25.5, 24.6, 23.8, 22.9, 22.1, 21.3, 20.5, 19.7,
    18.9, 18.1, 17.3, 16.5, 15.8, 15.0, 14.3, 13.6, 12.9, 12.2,
    11.5, 10.9, 10.3, 9.7, 9.2, 8.7, 8.2, 7.7, 7.3, 6.9,
    6.6, 6.2, 5.9, 5.7, 5.4, 5.2, 5.0, 4.8, 4.6, 4.5,
    4.3, 4.2, 4.1, 4.1, 4.0, 4.0, 3.9, 3.9, 3.9, 3.9,
    3.9, 3.9, 3.8, 3.8, 3.8, 3.8, 3.7, 3.6, 3.5, 3.3,
    3.2,
  ],
  99: [
    65.0, 64.1, 63.1, 62.1, 61.1, 60.2, 59.2, 58.2, 57.3, 56.3,
    55.3, 54.4, 53.4, 52.5, 51.5, 50.6, 49.6, 48.6, 47.7, 46.7,
    45.8, 44.8, 43.8, 42.9, 41.9, 41.0, 40.0, 39.1, 38.1, 37.2,
    36.2, 35.3, 34.3, 33.4, 32.5, 31.6, 30.7, 29.8, 28.9, 28.0,
    27.2, 26.3, 25.4, 24.6, 23.8, 22.9, 22.1, 21.3, 20.5, 19.7,
    18.9, 18.1, 17.3, 16.5, 15.7, 15.0, 14.3, 13.5, 12.8, 12.2,
    11.5, 10.9, 10.2, 9.7, 9.1, 8.6, 8.1, 7.6, 7.2, 6.8,
    6.5, 6.1, 5.8, 5.5, 5.3, 5.0, 4.8, 4.6, 4.5, 4.3,
    4.2, 4.1, 4.0, 3.9, 3.8, 3.8, 3.8, 3.7, 3.7, 3.7,
    3.7, 3.7, 3.7, 3.6, 3.6, 3.6, 3.5, 3.4, 3.3, 3.1,
    3.0,
  ],
  100: [
    65.0, 64.1, 63.1, 62.1, 61.1, 60.2, 59.2, 58.2, 57.3, 56.3,
    55.3, 54.4, 53.4, 52.5, 51.5, 50.6, 49.6, 48.6, 47.7, 46.7,
    45.8, 44.8, 43.8, 42.9, 41.9, 41.0, 40.0, 39.0, 38.1, 37.1,
    36.2, 35.3, 34.3, 33.4, 32.5, 31.6, 30.7, 29.8, 28.9, 28.0,
    27.1, 26.3, 25.4, 24.6, 23.8, 22.9, 22.1, 21.3, 20.5, 19.7,
    18.9, 18.1, 17.3, 16.5, 15.7, 15.0, 14.2, 13.5, 12.8, 12.1,
    11.5, 10.8, 10.2, 9.6, 9.1, 8.5, 8.0, 7.6, 7.2, 6.8,
    6.4, 6.0, 5.7, 5.4, 5.2, 4.9, 4.7, 4.5, 4.3, 4.2,
    4.1, 3.9, 3.8, 3.7, 3.7, 3.6, 3.6, 3.6, 3.6, 3.6,
    3.5, 3.5, 3.5, 3.5, 3.5, 3.4, 3.3, 3.3, 3.1, 2.9,
    2.8,
  ],
  101: [
    65.0, 64.1, 63.1, 62.1, 61.1, 60.2, 59.2, 58.2, 57.3, 56.3,
    55.3, 54.4, 53.4, 52.5, 51.5, 50.6, 49.6, 48.6, 47.7, 46.7,
    45.8, 44.8, 43.8, 42.9, 41.9, 41.0, 40.0, 39.0, 38.1, 37.1,
    36.2, 35.3, 34.3, 33.4, 32.5, 31.6, 30.7, 29.8, 28.9, 28.0,
    27.1, 26.3, 25.4, 24.6, 23.8, 22.9, 22.1, 21.3, 20.5, 19.7,
    18.9, 18.1, 17.3, 16.5, 15.7, 15.0, 14.2, 13.5, 12.8, 12.1,
    11.4, 10.8, 10.2, 9.6, 9.0, 8.5, 8.0, 7.5, 7.1, 6.7,
    6.3, 6.0, 5.6, 5.3, 5.1, 4.8, 4.6, 4.4, 4.2, 4.1,
    3.9, 3.8, 3.7, 3.6, 3.5, 3.5, 3.5, 3.4, 3.4, 3.4,
    3.4, 3.4, 3.4, 3.4, 3.3, 3.3, 3.2, 3.1, 3.0, 2.8,
    2.6,
  ],
  102: [
    65.0, 64.1, 63.1, 62.1, 61.1, 60.2, 59.2, 58.2, 57.3, 56.3,
    55.3, 54.4, 53.4, 52.5, 51.5, 50.6, 49.6, 48.6, 47.7, 46.7,
    45.8, 44.8, 43.8, 42.9, 41.9, 41.0, 40.0, 39.0, 38.1, 37.1,
    36.2, 35.3, 34.3, 33.4, 32.5, 31.6, 30.7, 29.8, 28.9, 28.0,
    27.1, 26.3, 25.4, 24.6, 23.7, 22.9, 22.1, 21.3, 20.5, 19.7,
    18.8, 18.0, 17.3, 16.5, 15.7, 14.9, 14.2, 13.5, 12.8, 12.1,
    11.4, 10.8, 10.1, 9.6, 9.0, 8.5, 8.0, 7.5, 7.0, 6.6,
    6.3, 5.9, 5.6, 5.3, 5.0, 4.7, 4.5, 4.3, 4.1, 4.0,
    3.8, 3.7, 3.6, 3.5, 3.4, 3.4, 3.3, 3.3, 3.3, 3.3,
    3.3, 3.3, 3.2, 3.2, 3.2, 3.2, 3.1, 3.0, 2.8, 2.6,
    2.5,
  ],
  103: [
    65.0, 64.1, 63.1, 62.1, 61.1, 60.2, 59.2, 58.2, 57.3, 56.3,
    55.3, 54.4, 53.4, 52.5, 51.5, 50.5, 49.6, 48.6, 47.7, 46.7,
    45.8, 44.8, 43.8, 42.9, 41.9, 41.0, 40.0, 39.0, 38.1, 37.1,
    36.2, 35.3, 34.3, 33.4, 32.5, 31.6, 30.7, 29.8, 28.9, 28.0,
    27.1, 26.3, 25.4, 24.6, 23.7, 22.9, 22.1, 21.3, 20.5, 19.6,
    18.8, 18.0, 17.3, 16.5, 15.7, 14.9, 14.2, 13.5, 12.8, 12.1,
    11.4, 10.7, 10.1, 9.5, 9.0, 8.4, 7.9, 7.4, 7.0, 6.6,
    6.2, 5.9, 5.5, 5.2, 4.9, 4.7, 4.5, 4.2, 4.1, 3.9,
    3.7, 3.6, 3.5, 3.4, 3.3, 3.3, 3.2, 3.2, 3.2, 3.2,
    3.2, 3.2, 3.1, 3.1, 3.1, 3.1, 3.0, 2.9, 2.7, 2.5,
    2.3,
  ],
  104: [
    65.0, 64.1, 63.1, 62.1, 61.1, 60.2, 59.2, 58.2, 57.3, 56.3,
    55.3, 54.4, 53.4, 52.5, 51.5, 50.5, 49.6, 48.6, 47.7, 46.7,
    45.8, 44.8, 43.8, 42.9, 41.9, 41.0, 40.0, 39.0, 38.1, 37.1,
    36.2, 35.3, 34.3, 33.4, 32.5, 31.6, 30.7, 29.8, 28.9, 28.0,
    27.1, 26.3, 25.4, 24.6, 23.7, 22.9, 22.1, 21.3, 20.5, 19.6,
    18.8, 18.0, 17.2, 16.5, 15.7, 14.9, 14.2, 13.5, 12.7, 12.0,
    11.4, 10.7, 10.1, 9.5, 8.9, 8.4, 7.9, 7.4, 7.0, 6.6,
    6.2, 5.8, 5.5, 5.2, 4.9, 4.6, 4.4, 4.2, 4.0, 3.8,
    3.7, 3.5, 3.4, 3.3, 3.3, 3.2, 3.2, 3.2, 3.1, 3.1,
    3.1, 3.1, 3.1, 3.1, 3.0, 3.0, 2.9, 2.8, 2.6, 2.4,
    2.2,
  ],
  105: [
    65.0, 64.1, 63.1, 62.1, 61.1, 60.2, 59.2, 58.2, 57.3, 56.3,
    55.3, 54.4, 53.4, 52.5, 51.5, 50.5, 49.6, 48.6, 47.7, 46.7,
    45.7, 44.8, 43.8, 42.9, 41.9, 41.0, 40.0, 39.0, 38.1, 37.1,
    36.2, 35.3, 34.3, 33.4, 32.5, 31.6, 30.7, 29.8, 28.9, 28.0,
    27.1, 26.3, 25.4, 24.6, 23.7, 22.9, 22.1, 21.3, 20.5, 19.6,
    18.8, 18.0, 17.2, 16.5, 15.7, 14.9, 14.2, 13.4, 12.7, 12.0,
    11.4, 10.7, 10.1, 9.5, 8.9, 8.4, 7.9, 7.4, 6.9, 6.5,
    6.1, 5.8, 5.4, 5.1, 4.9, 4.6, 4.4, 4.1, 4.0, 3.8,
    3.6, 3.5, 3.4, 3.3, 3.2, 3.1, 3.1, 3.1, 3.1, 3.1,
    3.1, 3.0, 3.0, 3.0, 3.0, 2.9, 2.8, 2.7, 2.6, 2.4,
    2.1,
  ],
  106: [
    65.0, 64.1, 63.1, 62.1, 61.1, 60.2, 59.2, 58.2, 57.3, 56.3,
    55.3, 54.4, 53.4, 52.5, 51.5, 50.5, 49.6, 48.6, 47.7, 46.7,
    45.7, 44.8, 43.8, 42.9, 41.9, 41.0, 40.0, 39.0, 38.1, 37.1,
    36.2, 35.3, 34.3, 33.4, 32.5, 31.6, 30.7, 29.8, 28.9, 28.0,
    27.1, 26.3, 25.4, 24.6, 23.7, 22.9, 22.1, 21.3, 20.5, 19.6,
    18.8, 18.0, 17.2, 16.5, 15.7, 14.9, 14.2, 13.4, 12.7, 12.0,
    11.4, 10.7, 10.1, 9.5, 8.9, 8.4, 7.9, 7.4, 6.9, 6.5,
    6.1, 5.8, 5.4, 5.1, 4.8, 4.6, 4.3, 4.1, 3.9, 3.8,
    3.6, 3.5, 3.3, 3.2, 3.2, 3.1, 3.1, 3.1, 3.0, 3.0,
    3.0, 3.0, 3.0, 3.0, 2.9, 2.9, 2.8, 2.7, 2.5, 2.3,
    2.1,
  ],
  107: [
    65.0, 64.1, 63.1, 62.1, 61.1, 60.2, 59.2, 58.2, 57.3, 56.3,
    55.3, 54.4, 53.4, 52.5, 51.5, 50.5, 49.6, 48.6, 47.7, 46.7,
    45.7, 44.8, 43.8, 42.9, 41.9, 41.0, 40.0, 39.0, 38.1, 37.1,
    36.2, 35.3, 34.3, 33.4, 32.5, 31.6, 30.7, 29.8, 28.9, 28.0,
    27.1, 26.3, 25.4, 24.6, 23.7, 22.9, 22.1, 21.3, 20.5, 19.6,
    18.8, 18.0, 17.2, 16.5, 15.7, 14.9, 14.2, 13.4, 12.7, 12.0,
    11.4, 10.7, 10.1, 9.5, 8.9, 8.4, 7.9, 7.4, 6.9, 6.5,
    6.1, 5.8, 5.4, 5.1, 4.8, 4.6, 4.3, 4.1, 3.9, 3.7,
    3.6, 3.4, 3.3, 3.2, 3.2, 3.1, 3.1, 3.0, 3.0, 3.0,
    3.0, 3.0, 2.9, 2.9, 2.9, 2.9, 2.8, 2.7, 2.5, 2.3,
    2.1,
  ],
  108: [
    65.0, 64.1, 63.1, 62.1, 61.1, 60.2, 59.2, 58.2, 57.3, 56.3,
    55.3, 54.4, 53.4, 52.5, 51.5, 50.5, 49.6, 48.6, 47.7, 46.7,
    45.7, 44.8, 43.8, 42.9, 41.9, 41.0, 40.0, 39.0, 38.1, 37.1,
    36.2, 35.3, 34.3, 33.4, 32.5, 31.6, 30.7, 29.8, 28.9, 28.0,
    27.1, 26.3, 25.4, 24.6, 23.7, 22.9, 22.1, 21.3, 20.5, 19.6,
    18.8, 18.0, 17.2, 16.5, 15.7, 14.9, 14.2, 13.4, 12.7, 12.0,
    11.4, 10.7, 10.1, 9.5, 8.9, 8.4, 7.8, 7.4, 6.9, 6.5,
    6.1, 5.7, 5.4, 5.1, 4.8, 4.5, 4.3, 4.1, 3.9, 3.7,
    3.6, 3.4, 3.3, 3.2, 3.1, 3.1, 3.0, 3.0, 3.0, 3.0,
    3.0, 3.0, 2.9, 2.9, 2.9, 2.8, 2.8, 2.7, 2.5, 2.3,
    2.0,
  ],
  109: [
    65.0, 64.1, 63.1, 62.1, 61.1, 60.2, 59.2, 58.2, 57.3, 56.3,
    55.3, 54.4, 53.4, 52.5, 51.5, 50.5, 49.6, 48.6, 47.7, 46.7,
    45.7, 44.8, 43.8, 42.9, 41.9, 41.0, 40.0, 39.0, 38.1, 37.1,
    36.2, 35.3, 34.3, 33.4, 32.5, 31.6, 30.7, 29.8, 28.9, 28.0,
    27.1, 26.3, 25.4, 24.6, 23.7, 22.9, 22.1, 21.3, 20.4, 19.6,
    18.8, 18.0, 17.2, 16.4, 15.7, 14.9, 14.2, 13.4, 12.7, 12.0,
    11.3, 10.7, 10.1, 9.5, 8.9, 8.4, 7.8, 7.4, 6.9, 6.5,
    6.1, 5.7, 5.4, 5.1, 4.8, 4.5, 4.3, 4.1, 3.9, 3.7,
    3.6, 3.4, 3.3, 3.2, 3.1, 3.1, 3.0, 3.0, 3.0, 3.0,
    3.0, 3.0, 2.9, 2.9, 2.9, 2.8, 2.8, 2.6, 2.5, 2.3,
    2.0,
  ],
  110: [
    65.0, 64.1, 63.1, 62.1, 61.1, 60.2, 59.2, 58.2, 57.3, 56.3,
    55.3, 54.4, 53.4, 52.5, 51.5, 50.5, 49.6, 48.6, 47.7, 46.7,
    45.7, 44.8, 43.8, 42.9, 41.9, 41.0, 40.0, 39.0, 38.1, 37.1,
    36.2, 35.3, 34.3, 33.4, 32.5, 31.6, 30.7, 29.8, 28.9, 28.0,
    27.1, 26.3, 25.4, 24.6, 23.7, 22.9, 22.1, 21.3, 20.4, 19.6,
    18.8, 18.0, 17.2, 16.4, 15.7, 14.9, 14.2, 13.4, 12.7, 12.0,
    11.3, 10.7, 10.1, 9.5, 8.9, 8.3, 7.8, 7.4, 6.9, 6.5,
    6.1, 5.7, 5.4, 5.1, 4.8, 4.5, 4.3, 4.1, 3.9, 3.7,
    3.5, 3.4, 3.3, 3.2, 3.1, 3.1, 3.0, 3.0, 3.0, 3.0,
    3.0, 2.9, 2.9, 2.9, 2.9, 2.8, 2.7, 2.6, 2.5, 2.2,
    2.0,
  ],
  111: [
    65.0, 64.1, 63.1, 62.1, 61.1, 60.2, 59.2, 58.2, 57.3, 56.3,
    55.3, 54.4, 53.4, 52.5, 51.5, 50.5, 49.6, 48.6, 47.7, 46.7,
    45.7, 44.8, 43.8, 42.9, 41.9, 41.0, 40.0, 39.0, 38.1, 37.1,
    36.2, 35.3, 34.3, 33.4, 32.5, 31.6, 30.7, 29.8, 28.9, 28.0,
    27.1, 26.3, 25.4, 24.6, 23.7, 22.9, 22.1, 21.3, 20.4, 19.6,
    18.8, 18.0, 17.2, 16.4, 15.7, 14.9, 14.2, 13.4, 12.7, 12.0,
    11.3, 10.7, 10.1, 9.5, 8.9, 8.3, 7.8, 7.3, 6.9, 6.5,
    6.1, 5.7, 5.4, 5.1, 4.8, 4.5, 4.3, 4.1, 3.9, 3.7,
    3.5, 3.4, 3.3, 3.2, 3.1, 3.0, 3.0, 3.0, 3.0, 3.0,
    2.9, 2.9, 2.9, 2.9, 2.8, 2.8, 2.7, 2.6, 2.4, 2.2,
    2.0,
  ],
  112: [
    65.0, 64.1, 63.1, 62.1, 61.1, 60.2, 59.2, 58.2, 57.3, 56.3,
    55.3, 54.4, 53.4, 52.5, 51.5, 50.5, 49.6, 48.6, 47.7, 46.7,
    45.7, 44.8, 43.8, 42.9, 41.9, 41.0, 40.0, 39.0, 38.1, 37.1,
    36.2, 35.3, 34.3, 33.4, 32.5, 31.6, 30.7, 29.8, 28.9, 28.0,
    27.1, 26.3, 25.4, 24.6, 23.7, 22.9, 22.1, 21.3, 20.4, 19.6,
    18.8, 18.0, 17.2, 16.4, 15.7, 14.9, 14.2, 13.4, 12.7, 12.0,
    11.3, 10.7, 10.1, 9.5, 8.9, 8.3, 7.8, 7.3, 6.9, 6.5,
    6.1, 5.7, 5.4, 5.1, 4.8, 4.5, 4.3, 4.0, 3.8, 3.7,
    3.5, 3.4, 3.2, 3.1, 3.1, 3.0, 3.0, 2.9, 2.9, 2.9,
    2.9, 2.9, 2.9, 2.9, 2.8, 2.8, 2.7, 2.6, 2.4, 2.2,
    2.0,
  ],
  113: [
    65.0, 64.1, 63.1, 62.1, 61.1, 60.2, 59.2, 58.2, 57.3, 56.3,
    55.3, 54.4, 53.4, 52.5, 51.5, 50.5, 49.6, 48.6, 47.7, 46.7,
    45.7, 44.8, 43.8, 42.9, 41.9, 41.0, 40.0, 39.0, 38.1, 37.1,
    36.2, 35.3, 34.3, 33.4, 32.5, 31.6, 30.7, 29.8, 28.9, 28.0,
    27.1, 26.3, 25.4, 24.6, 23.7, 22.9, 22.1, 21.3, 20.4, 19.6,
    18.8, 18.0, 17.2, 16.4, 15.7, 14.9, 14.2, 13.4, 12.7, 12.0,
    11.3, 10.7, 10.0, 9.4, 8.9, 8.3, 7.8, 7.3, 6.9, 6.4,
    6.1, 5.7, 5.3, 5.0, 4.7, 4.5, 4.2, 4.0, 3.8, 3.6,
    3.5, 3.4, 3.2, 3.1, 3.1, 3.0, 3.0, 2.9, 2.9, 2.9,
    2.9, 2.9, 2.9, 2.8, 2.8, 2.8, 2.7, 2.6, 2.4, 2.2,
    1.9,
  ],
  114: [
    65.0, 64.1, 63.1, 62.1, 61.1, 60.2, 59.2, 58.2, 57.3, 56.3,
    55.3, 54.4, 53.4, 52.5, 51.5, 50.5, 49.6, 48.6, 47.7, 46.7,
    45.7, 44.8, 43.8, 42.9, 41.9, 41.0, 40.0, 39.0, 38.1, 37.1,
    36.2, 35.3, 34.3, 33.4, 32.5, 31.6, 30.7, 29.8, 28.9, 28.0,
    27.1, 26.3, 25.4, 24.6, 23.7, 22.9, 22.1, 21.3, 20.4, 19.6,
    18.8, 18.0, 17.2, 16.4, 15.7, 14.9, 14.1, 13.4, 12.7, 12.0,
    11.3, 10.7, 10.0, 9.4, 8.9, 8.3, 7.8, 7.3, 6.9, 6.4,
    6.0, 5.7, 5.3, 5.0, 4.7, 4.4, 4.2, 4.0, 3.8, 3.6,
    3.5, 3.3, 3.2, 3.1, 3.0, 3.0, 2.9, 2.9, 2.9, 2.9,
    2.9, 2.8, 2.8, 2.8, 2.8, 2.7, 2.6, 2.5, 2.4, 2.1,
    1.9,
  ],
  115: [
    65.0, 64.1, 63.1, 62.1, 61.1, 60.2, 59.2, 58.2, 57.3, 56.3,
    55.3, 54.4, 53.4, 52.5, 51.5, 50.5, 49.6, 48.6, 47.7, 46.7,
    45.7, 44.8, 43.8, 42.9, 41.9, 41.0, 40.0, 39.0, 38.1, 37.1,
    36.2, 35.3, 34.3, 33.4, 32.5, 31.6, 30.7, 29.8, 28.9, 28.0,
    27.1, 26.3, 25.4, 24.6, 23.7, 22.9, 22.1, 21.3, 20.4, 19.6,
    18.8, 18.0, 17.2, 16.4, 15.7, 14.9, 14.1, 13.4, 12.7, 12.0,
    11.3, 10.7, 10.0, 9.4, 8.8, 8.3, 7.8, 7.3, 6.8, 6.4,
    6.0, 5.6, 5.3, 5.0, 4.7, 4.4, 4.2, 4.0, 3.8, 3.6,
    3.4, 3.3, 3.2, 3.1, 3.0, 2.9, 2.9, 2.9, 2.8, 2.8,
    2.8, 2.8, 2.8, 2.8, 2.7, 2.7, 2.6, 2.5, 2.3, 2.1,
    1.8,
  ],
  116: [
    65.0, 64.1, 63.1, 62.1, 61.1, 60.2, 59.2, 58.2, 57.3, 56.3,
    55.3, 54.4, 53.4, 52.5, 51.5, 50.5, 49.6, 48.6, 47.7, 46.7,
    45.7, 44.8, 43.8, 42.9, 41.9, 41.0, 40.0, 39.0, 38.1, 37.1,
    36.2, 35.3, 34.3, 33.4, 32.5, 31.6, 30.7, 29.8, 28.9, 28.0,
    27.1, 26.3, 25.4, 24.6, 23.7, 22.9, 22.1, 21.3, 20.4, 19.6,
    18.8, 18.0, 17.2, 16.4, 15.6, 14.9, 14.1, 13.4, 12.7, 12.0,
    11.3, 10.6, 10.0, 9.4, 8.8, 8.3, 7.7, 7.3, 6.8, 6.4,
    6.0, 5.6, 5.2, 4.9, 4.6, 4.4, 4.1, 3.9, 3.7, 3.5,
    3.3, 3.2, 3.1, 3.0, 2.9, 2.8, 2.8, 2.8, 2.8, 2.8,
    2.7, 2.7, 2.7, 2.7, 2.6, 2.6, 2.5, 2.4, 2.2, 2.0,
    1.8,
  ],
  117: [
    65.0, 64.1, 63.1, 62.1, 61.1, 60.2, 59.2, 58.2, 57.3, 56.3,
    55.3, 54.4, 53.4, 52.5, 51.5, 50.5, 49.6, 48.6, 47.7, 46.7,
    45.7, 44.8, 43.8, 42.9, 41.9, 41.0, 40.0, 39.0, 38.1, 37.1,
    36.2, 35.3, 34.3, 33.4, 32.5, 31.6, 30.7, 29.8, 28.9, 28.0,
    27.1, 26.3, 25.4, 24.6, 23.7, 22.9, 22.1, 21.2, 20.4, 19.6,
    18.8, 18.0, 17.2, 16.4, 15.6, 14.9, 14.1, 13.4, 12.7, 12.0,
    11.3, 10.6, 10.0, 9.4, 8.8, 8.2, 7.7, 7.2, 6.8, 6.3,
    5.9, 5.5, 5.2, 4.9, 4.6, 4.3, 4.0, 3.8, 3.6, 3.4,
    3.3, 3.1, 3.0, 2.9, 2.8, 2.7, 2.7, 2.7, 2.7, 2.6,
    2.6, 2.6, 2.6, 2.6, 2.5, 2.5, 2.4, 2.3, 2.1, 1.9,
    1.6,
  ],
  118: [
    65.0, 64.1, 63.1, 62.1, 61.1, 60.2, 59.2, 58.2, 57.3, 56.3,
    55.3, 54.4, 53.4, 52.5, 51.5, 50.5, 49.6, 48.6, 47.7, 46.7,
    45.7, 44.8, 43.8, 42.9, 41.9, 41.0, 40.0, 39.0, 38.1, 37.1,
    36.2, 35.3, 34.3, 33.4, 32.5, 31.6, 30.7, 29.8, 28.9, 28.0,
    27.1, 26.3, 25.4, 24.5, 23.7, 22.9, 22.1, 21.2, 20.4, 19.6,
    18.8, 18.0, 17.2, 16.4, 15.6, 14.9, 14.1, 13.4, 12.6, 11.9,
    11.3, 10.6, 10.0, 9.3, 8.8, 8.2, 7.7, 7.2, 6.7, 6.3,
    5.8, 5.5, 5.1, 4.8, 4.5, 4.2, 3.9, 3.7, 3.5, 3.3,
    3.1, 3.0, 2.8, 2.7, 2.6, 2.6, 2.5, 2.5, 2.5, 2.5,
    2.5, 2.4, 2.4, 2.4, 2.4, 2.3, 2.2, 2.1, 1.9, 1.7,
    1.4,
  ],
  119: [
    65.0, 64.1, 63.1, 62.1, 61.1, 60.2, 59.2, 58.2, 57.3, 56.3,
    55.3, 54.4, 53.4, 52.5, 51.5, 50.5, 49.6, 48.6, 47.7, 46.7,
    45.7, 44.8, 43.8, 42.9, 41.9, 41.0, 40.0, 39.0, 38.1, 37.1,
    36.2, 35.3, 34.3, 33.4, 32.5, 31.6, 30.7, 29.8, 28.9, 28.0,
    27.1, 26.2, 25.4, 24.5, 23.7, 22.9, 22.1, 21.2, 20.4, 19.6,
    18.8, 18.0, 17.2, 16.4, 15.6, 14.8, 14.1, 13.4, 12.6, 11.9,
    11.2, 10.6, 9.9, 9.3, 8.7, 8.2, 7.6, 7.1, 6.6, 6.2,
    5.8, 5.4, 5.0, 4.7, 4.4, 4.1, 3.8, 3.6, 3.3, 3.1,
    2.9, 2.8, 2.6, 2.5, 2.4, 2.4, 2.3, 2.3, 2.3, 2.3,
    2.2, 2.2, 2.2, 2.2, 2.1, 2.1, 2.0, 1.9, 1.7, 1.3,
    1.1,
  ],
  120: [
    65.0, 64.1, 63.1, 62.1, 61.1, 60.2, 59.2, 58.2, 57.3, 56.3,
    55.3, 54.4, 53.4, 52.5, 51.5, 50.5, 49.6, 48.6, 47.7, 46.7,
    45.7, 44.8, 43.8, 42.9, 41.9, 41.0, 40.0, 39.0, 38.1, 37.1,
    36.2, 35.3, 34.3, 33.4, 32.5, 31.6, 30.6, 29.8, 28.9, 28.0,
    27.1, 26.2, 25.4, 24.5, 23.7, 22.9, 22.0, 21.2, 20.4, 19.6,
    18.8, 18.0, 17.2, 16.4, 15.6, 14.8, 14.1, 13.3, 12.6, 11.9,
    11.2, 10.5, 9.9, 9.3, 8.7, 8.1, 7.6, 7.1, 6.6, 6.1,
    5.7, 5.3, 4.9, 4.6, 4.3, 4.0, 3.7, 3.4, 3.2, 3.0,
    2.8, 2.6, 2.5, 2.3, 2.2, 2.1, 2.1, 2.1, 2.0, 2.0,
    2.0, 2.0, 2.0, 1.9, 1.9, 1.8, 1.8, 1.6, 1.4, 1.1,
    1.0,
  ],
};
export function jointDivisor(ownerAge: number, spouseAge: number): number {
  const o = Math.min(120, Math.max(70, Math.round(ownerAge)));
  const s = Math.min(120, Math.max(20, Math.round(spouseAge)));
  const row = JOINT_LIFE_TABLE[o] ?? JOINT_LIFE_TABLE[120] ?? [];
  return row[s - 20] ?? row[row.length - 1] ?? 2.0;
}
