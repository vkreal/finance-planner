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
// of the app): the tables are keyed by calendar year and the
// engine prices each plan year under ITS OWN calendar year's
// table (T1 build). A year with no published row of its own
// prices under the NEWEST published row, carried forward — so
// in today's dollars the carried-forward table's inflation-
// indexed figures (brackets, standard deduction, LTCG
// thresholds, IRMAA tiers except the frozen top tier) stay
// constant in real terms, exactly as the Retirement engines
// treat returns, until a newer row is added. A scheduled law
// change is expressed as dated table data (a new row, or a
// dated window like the OBBBA senior deduction's 2025–2028
// span), never as engine code. NON-indexed figures stated in
// a row (Social Security provisional-income thresholds, NIIT
// thresholds) are in that row's dollars: the engine DEFLATES
// them year by year at the plan's inflation input for each
// year the priced year runs past the row it prices under —
// under carry-forward that is each year past the newest row.
// The top IRMAA tier's $500k single / $750k joint floor, fixed
// by statute through 2028 and indexed after that, deflates
// only for the steps through 2028 counted from the row's year.
// The 2025 row is kept so a year can be priced under 2025 law
// exactly (the fixtures do).

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
     limits are from Rev. Proc. 2024-25 (2025) and Rev. Proc.
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
  /* ---- Employee payroll tax (T2 build) — the employee share
     of FICA (IRC §3101), priced on salary in work years by
     server/src/workYears.ts. Dated law-row data like every
     other figure here: a future row can carry different
     values with no engine change. The employer share
     (§3111) is NOT priced — it is never a household outlay.
     Rates are percentage points; the Additional Medicare
     thresholds are DOLLARS (statutory withholding thresholds,
     not indexed: $250,000 MFJ / $200,000 single or HOH). ---- */
  // Social Security (OASDI) employee rate, on wages up to
  // ssWageBase.
  payrollSsRatePct: number;
  // Medicare (HI) employee rate, on all FICA wages.
  payrollMedicareRatePct: number;
  // Additional Medicare Tax rate (IRC §3101(b)(2)), on wages
  // above payrollAdditionalMedicareThreshold.
  payrollAdditionalMedicareRatePct: number;
  payrollAdditionalMedicareThreshold: Record<FilingStatus, number>;
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
  /* ---- Washington capital-gains excise (T3 build) — RCW
     82.87, priced by waCapitalGainsTax in taxEngine.ts for a
     plan whose state of residence is Washington. Dated
     law-row data like every other figure here: a future row
     can carry different values with no engine change. All
     amounts are DOLLARS. Sources (cited in full in
     DATA-PLAN.md): RCW 82.87.040 (the tax imposed), RCW
     82.87.060 (deductions), RCW 82.87.080 (charitable
     deduction), RCW 82.87.150 (annual adjustments), and the
     WA Department of Revenue's capital-gains page and its
     June 30, 2025 special notice on the tiered rates, which
     publish the inflation-adjusted amounts for each year. ---- */
  // Standard deduction (RCW 82.87.060(1)): the statutory base
  // is $250,000 per individual — and the SAME combined
  // $250,000 for spouses or domestic partners, filing jointly
  // or separately — adjusted annually under RCW 82.87.150.
  // DOR-published adjusted amounts: $270,000 for 2024 and
  // $278,000 for 2025. DOR had published no 2026 amount when
  // this build was sourced (checked October 2026), so the
  // 2026 row carries the 2025 amount forward unchanged —
  // this table's today's-dollars convention for an
  // inflation-indexed figure whose newer row is not yet
  // published, NOT a published 2026 figure.
  waStandardDeduction: number;
  // Base excise rate (RCW 82.87.040(1)(a)): 7% of Washington
  // capital gains (the adjusted long-term gain after the
  // deductions of RCW 82.87.060).
  waRatePct: number;
  // Additional excise (RCW 82.87.040(1)(b), beginning
  // January 1, 2025, per ESSB 5813, ch. 421, Laws of 2025):
  // 2.9% on the portion of Washington capital gains exceeding
  // waAdditionalThreshold — a 9.9% combined marginal rate
  // above the threshold. The statute does not index the
  // threshold (RCW 82.87.150's adjustment list does not reach
  // it), so it is a fixed $1,000,000 in every row — and, as a
  // statute-fixed amount, the pricer deflates it in
  // today's-dollars projections (contract v61, F1); the
  // DOR-indexed standard deduction and charitable amounts
  // beside it price at their row values, undeflated.
  waAdditionalRatePct: number;
  waAdditionalThreshold: number;
  // Charitable donation deduction (RCW 82.87.080):
  // donations to qualified organizations (IRC §170(c)
  // organizations principally directed and managed in
  // Washington) are deductible only for the amount donated
  // ABOVE waCharitableThreshold, and the deduction is capped
  // at waCharitableCap. Statutory bases are $250,000 / $100,000,
  // both adjusted annually under RCW 82.87.150; DOR publishes
  // the threshold as the same amount as the year's standard
  // deduction and the cap as $108,000 for 2024 and $111,000
  // for 2025. The 2026 row carries both 2025 amounts forward,
  // on the same convention as waStandardDeduction above.
  waCharitableThreshold: number;
  waCharitableCap: number;
  /* ---- State and local tax (SALT) deduction cap (T5
     build) — IRC §164(b)(7), priced by priceYear in
     taxEngine.ts inside the itemized-deduction total.
     All amounts are DOLLARS, per RETURN (the cap
     is not doubled for a joint return; married filing
     separately takes half — $20,000 / $20,200 — a filing
     status this engine does not price). Source: §164(b)(7)
     as amended by §70120 of Public Law 119-21 (the One Big
     Beautiful Bill Act): the Tax Cuts and Jobs Act's
     $10,000 cap was replaced for 2025 by $40,000, increased
     by 1% for each of 2026–2029 ($40,400 in 2026), and
     reverts to $10,000 for tax years beginning after
     December 31, 2029. The FULL enacted schedule — every
     year 2025–2029 plus the permanent post-2029 $10,000
     limitation — lives in SALT_SCHEDULE below, and the
     pricer consults THAT schedule by calendar year for
     every year from 2025 on (Build B): these row fields
     carry only the schedule's 2025 / 2026 entries, kept so
     the law rows stay self-describing and the T5 fixtures
     that pin them keep their meaning; they price only
     years before 2025, on the pre-Build-B path. Like the
     NIIT thresholds and the §151(d)(5)(C) senior-deduction figures,
     the cap is statutory (not inflation-indexed — the 1%
     bump is a fixed statutory escalator), so the engine
     DEFLATES these dollar figures at the plan's inflation
     input for each year the priced year runs past the
     schedule entry it prices under, under the table's
     today's-dollars convention; in an entry's own year
     the deflation factor is 1 and the figures price
     exactly as enacted. ---- */
  // The year's §164(b)(7) cap on the state and local tax
  // deduction, before the modified-AGI phase-down below.
  saltCap: number;
  // The phase-down's floor: the cap never falls below this
  // amount, however high the year's modified AGI runs.
  saltCapFloor: number;
  // Modified AGI above which the cap phases down (§164(b)(7)
  // modified AGI is AGI increased by the §§911 / 931 / 933
  // foreign-income exclusions — none modeled by this engine,
  // and tax-exempt interest is NOT added back, so the engine
  // phases the cap down on AGI, exactly as it phases out
  // the §151(d)(5)(C) senior deduction).
  saltPhaseOutStart: number;
  // The phase-down rate: the cap is reduced by this percent
  // of the modified AGI above saltPhaseOutStart, down to
  // saltCapFloor.
  saltPhaseOutRatePct: number;
  /* ---- Education credits (T6 build) — IRC §25A, priced
     by educationCreditsFor in taxEngine.ts: the American
     Opportunity Tax Credit (AOTC, §25A(b) / (i)) per
     eligible student and the Lifetime Learning Credit
     (LLC, §25A(c)) per return. Dated law-row data like
     every other figure here: a future row can carry
     different values with no engine change. All amounts
     are DOLLARS. Every §25A dollar figure is statutory
     and NOT inflation-indexed (the AOTC amounts date to
     2009 and were made permanent by the PATH Act of 2015;
     the LLC expense cap dates to 2002; the shared
     phase-out thresholds were set for the LLC by the
     Taxpayer Certainty and Disaster Tax Relief Act of
     2020), so the engine DEFLATES them at the plan's
     inflation input for each year the priced year runs
     past its row, under the table's today's-dollars
     convention — in a row's own year the deflation factor
     is 1 and the figures price exactly as published.
     Sources: IRC §25A(b), (c), (d), (g), (i) and IRS
     Form 8863 / Topic No. 313; cited in full in
     DATA-PLAN.md. ---- */
  // AOTC tier 1: this percent of the first
  // aotcTier1Expenses of qualified expenses, per student.
  aotcTier1RatePct: number;
  aotcTier1Expenses: number;
  // AOTC tier 2: this percent of the next
  // aotcTier2Expenses of qualified expenses, per student.
  // (Tier 1 + tier 2 at the statutory rates is the
  // $2,500 per-student maximum credit.)
  aotcTier2RatePct: number;
  aotcTier2Expenses: number;
  // The refundable share of the AOTC (§25A(i)): 40% of
  // the credit is a refundable credit; the rest is
  // nonrefundable.
  aotcRefundablePct: number;
  // LLC: this percent of the first llcExpenseCap of
  // qualified expenses, per RETURN (all students whose
  // expenses are not claimed for the AOTC share one cap).
  llcRatePct: number;
  llcExpenseCap: number;
  // The §25A(d) phase-out, shared by both credits since
  // 2021: the credit is reduced ratably as modified AGI
  // (AGI plus the §§911 / 931 / 933 foreign-income
  // exclusions — none modeled, so the engine phases out
  // on AGI) runs from the start through start + width.
  eduPhaseOutStart: Record<FilingStatus, number>;
  eduPhaseOutWidth: Record<FilingStatus, number>;
  /* ---- Alternative minimum tax (T7 build) — IRC §55,
     priced by amtFor in taxEngine.ts: the parallel
     tentative minimum tax every priced year computes
     alongside its regular tax. Dated law-row data like
     every other figure here: a future row can carry
     different values with no engine change. All amounts
     are DOLLARS. Every §55 figure below is inflation-
     indexed (published per year in the year's revenue
     procedure), so — like the brackets, the standard
     deduction, and the LTCG thresholds — the engine does
     NOT deflate them under carry-forward: they stay
     constant in real terms in today's-dollars pricing.
     Sources: IRC §55(b), (d); IRS Rev. Proc. 2024-40
     (2025 figures) and Rev. Proc. 2025-32 (2026 figures);
     the 2026 phase-out reset — thresholds back to
     $500,000 / $1,000,000 and the phase-out rate doubled
     to 50% — is §70107 of Public Law 119-21 (the One Big
     Beautiful Bill Act) amending §55(d); cited in full in
     DATA-PLAN.md. Internal consistency check the rows
     satisfy: complete phase-out = phase-out start +
     exemption ÷ phase-out rate (2025 MFJ: $1,252,700 +
     $137,000 ÷ 0.25 = $1,800,700, the published figure;
     2026 MFJ: $1,000,000 + $140,200 ÷ 0.50 = $1,280,400,
     likewise). ---- */
  // The §55(d)(1) exemption amount by filing status.
  // Head of household takes the unmarried-individual
  // amount (§55(d)(1)(B)) — the same figure as single in
  // every published year.
  amtExemption: Record<FilingStatus, number>;
  // AMTI above which the exemption phases out
  // (§55(d)(2) / (d)(3) as amended): the exemption is
  // reduced by amtPhaseOutRatePct of the AMTI above this
  // amount, never below $0.
  amtPhaseOutStart: Record<FilingStatus, number>;
  // The phase-out rate: 25% through 2025 (§55(d)(2)'s
  // long-standing quarter), 50% from 2026 (OBBBA §70107).
  amtPhaseOutRatePct: number;
  // The §55(b)(1) breakpoint: the taxable excess (AMTI
  // minus the exemption) taxed at amtRateLowPct runs up
  // to this amount; the excess above it is taxed at
  // amtRateHighPct. The same amount for every filing
  // status this engine prices (married filing separately
  // takes half — a status the engine does not price).
  amtBreakpoint: number;
  amtRateLowPct: number;
  amtRateHighPct: number;
};

/* -------- FICA payroll-tax rates --------
   Employee share (IRC §3101): Social Security 6.2% up to the
   year's wage base, Medicare 1.45% on all FICA wages, plus
   the 0.9% Additional Medicare Tax on wages over $250,000
   (MFJ) / $200,000 (Single or HOH) — the statutory
   withholding thresholds, not indexed. Since the T2 build
   these figures live IN each year's law row above
   (payrollSsRatePct / payrollMedicareRatePct /
   payrollAdditionalMedicareRatePct /
   payrollAdditionalMedicareThreshold, beside ssWageBase), so
   a salary year prices its payroll tax entirely from its own
   year's table — the T1 mechanism — and no payroll figure is
   a global constant. */

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
  payrollSsRatePct: 6.2,
  payrollMedicareRatePct: 1.45,
  payrollAdditionalMedicareRatePct: 0.9,
  payrollAdditionalMedicareThreshold: { mfj: 250000, single: 200000, hoh: 200000 },
  // §414(v)(7) statutory base: $145,000 for 2025; the
  // $150,000 threshold first applies to 2026.
  rothCatchUpWageThreshold: 14500000,
  giftAnnualExclusionCents: 1900000,
  kiddieTaxThresholdCents: 270000,
  // WA excise (T3): the 2025 row prices under 2025's own
  // DOR-published amounts ($278,000 standard deduction /
  // charitable threshold, $111,000 charitable cap); the
  // tiered rate (7% + 2.9% over $1,000,000) applies from
  // January 1, 2025 (RCW 82.87.040(1)(b)).
  waStandardDeduction: 278000,
  waRatePct: 7,
  waAdditionalRatePct: 2.9,
  waAdditionalThreshold: 1000000,
  waCharitableThreshold: 278000,
  waCharitableCap: 111000,
  // SALT cap (T5): the 2025 row prices under §164(b)(7) as
  // OBBBA §70120 rewrote it for tax year 2025 — a $40,000
  // cap, phasing down by 30% of modified AGI over $500,000
  // to a $10,000 floor.
  saltCap: 40000,
  saltCapFloor: 10000,
  saltPhaseOutStart: 500000,
  saltPhaseOutRatePct: 30,
  // Education credits (T6): §25A's figures are statutory
  // and identical in both rows — 100% of the first $2,000
  // plus 25% of the next $2,000 per student for the AOTC
  // (a $2,500 maximum), 40% of it refundable; 20% of the
  // first $10,000 per return for the LLC; the shared
  // phase-out runs $160,000–$180,000 MFJ and
  // $80,000–$90,000 for single / head of household.
  aotcTier1RatePct: 100,
  aotcTier1Expenses: 2000,
  aotcTier2RatePct: 25,
  aotcTier2Expenses: 2000,
  aotcRefundablePct: 40,
  llcRatePct: 20,
  llcExpenseCap: 10000,
  eduPhaseOutStart: { mfj: 160000, single: 80000, hoh: 80000 },
  eduPhaseOutWidth: { mfj: 20000, single: 10000, hoh: 10000 },
  // AMT (T7): Rev. Proc. 2024-40 — exemption $137,000
  // MFJ / $88,100 unmarried; phase-out from $1,252,700
  // MFJ / $626,350 unmarried at the long-standing 25%
  // rate; the 28% rate applies to the taxable excess
  // over $239,100 (§55(b)(1)).
  amtExemption: { mfj: 137000, single: 88100, hoh: 88100 },
  amtPhaseOutStart: { mfj: 1252700, single: 626350, hoh: 626350 },
  amtPhaseOutRatePct: 25,
  amtBreakpoint: 239100,
  amtRateLowPct: 26,
  amtRateHighPct: 28,
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
  payrollSsRatePct: 6.2,
  payrollMedicareRatePct: 1.45,
  payrollAdditionalMedicareRatePct: 0.9,
  payrollAdditionalMedicareThreshold: { mfj: 250000, single: 200000, hoh: 200000 },
  rothCatchUpWageThreshold: 15000000,
  giftAnnualExclusionCents: 1900000,
  kiddieTaxThresholdCents: 270000,
  // WA excise (T3): DOR had published no 2026 adjusted
  // amounts when this build was sourced, so — per the field
  // note on YearLaw — the 2025 amounts carry forward
  // unchanged (today's-dollars convention); the rate
  // structure and the unindexed $1,000,000 threshold are
  // statutory and identical in both rows.
  waStandardDeduction: 278000,
  waRatePct: 7,
  waAdditionalRatePct: 2.9,
  waAdditionalThreshold: 1000000,
  waCharitableThreshold: 278000,
  waCharitableCap: 111000,
  // SALT cap (T5): the 2026 row carries the statute's own
  // 1% escalation of the 2025 figures — a $40,400 cap and a
  // $505,000 phase-down start; the $10,000 floor and the
  // 30% rate are unchanged (§164(b)(7) as amended).
  saltCap: 40400,
  saltCapFloor: 10000,
  saltPhaseOutStart: 505000,
  saltPhaseOutRatePct: 30,
  // Education credits (T6): the same §25A figures as the
  // 2025 row — the statute does not index them, so no
  // year's revenue procedure moves them.
  aotcTier1RatePct: 100,
  aotcTier1Expenses: 2000,
  aotcTier2RatePct: 25,
  aotcTier2Expenses: 2000,
  aotcRefundablePct: 40,
  llcRatePct: 20,
  llcExpenseCap: 10000,
  eduPhaseOutStart: { mfj: 160000, single: 80000, hoh: 80000 },
  eduPhaseOutWidth: { mfj: 20000, single: 10000, hoh: 10000 },
  // AMT (T7): Rev. Proc. 2025-32 — exemption $140,200
  // MFJ / $90,100 unmarried; the OBBBA §70107 reset
  // prices the phase-out from $1,000,000 MFJ / $500,000
  // unmarried at the new 50% rate; the 28% rate applies
  // to the taxable excess over $244,500 (§55(b)(1)).
  amtExemption: { mfj: 140200, single: 90100, hoh: 90100 },
  amtPhaseOutStart: { mfj: 1000000, single: 500000, hoh: 500000 },
  amtPhaseOutRatePct: 50,
  amtBreakpoint: 244500,
  amtRateLowPct: 26,
  amtRateHighPct: 28,
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
  // find() scan (identical result: the year's own row when one
  // is published; any other year — later than the newest row,
  // or earlier than the oldest — resolves to the newest row,
  // which is the carry-forward rule for years past the table).
  for (const law of TAX_LAW_YEARS) {
    if (law.year === year) return law;
  }
  return CURRENT_LAW;
}

/* -------- SALT dated schedule (Build B) — IRC §164(b)(7),
   as amended by §70120 of Public Law 119-21 --------
   The statute does not leave the SALT limitation to a
   carry-forward: it ENACTS the amount for every year.
   §164(b)(7) sets the applicable limitation at $40,000
   for 2025 and increases it by 1% for each succeeding
   year through 2029 — 101% of the prior year's amount,
   successively, rounded to cents: $40,400 (2026),
   $40,804 (2027), $41,212.04 (2028), $41,624.16 (2029) —
   and for taxable years beginning after 2029 the
   limitation is $10,000, permanently: no later year ever
   returns to a higher cap. The same 101% escalator runs
   on the phase-down threshold ($500,000 for 2025:
   $505,000, $510,050, $515,150.50, $520,302.01), and the
   pre-2030 phase-down mechanics are the T5 mechanics
   unchanged: the cap is reduced by 30% of modified AGI
   above the year's threshold, never below the $10,000
   floor. From 2030 the limitation is $10,000 with NO
   phase-down (the rate below is 0 and the floor equals
   the cap, so the applied cap is $10,000 at any income).
   The limitation is the same for every filing status
   this engine prices; married filing separately takes
   half — a status this engine does not price.
   The pricer (priceYear in taxEngine.ts) consults this
   schedule BY CALENDAR YEAR for every year from 2025
   on, instead of the law row's SALT fields: a priced
   year can no longer inherit the 2026 row's $40,400 cap
   by carry-forward. Each entry prices exactly in its
   own year; the post-2029 entry is dated 2030 and, like
   every other unindexed statutory figure carried past
   its row, deflates at the plan's inflation input for
   years past 2030 under the today's-dollars convention.
   The 2025 and 2026 entries replicate the law rows'
   SALT fields exactly, so 2025 and 2026 pricing is
   bit-identical to before this build. */
export type SaltScheduleEntry = {
  // The year's applicable limitation, before phase-down.
  cap: number;
  // The phase-down floor (the $10,000 statutory floor).
  capFloor: number;
  // Modified AGI above which the cap phases down.
  phaseOutStart: number;
  // The phase-down rate, percent of modified AGI above
  // phaseOutStart (0 from 2030: no phase-down).
  phaseOutRatePct: number;
};

export const SALT_SCHEDULE_FIRST_YEAR = 2025;
export const SALT_REVERSION_YEAR = 2030;

export const SALT_SCHEDULE: Record<number, SaltScheduleEntry> = {
  2025: { cap: 40000, capFloor: 10000, phaseOutStart: 500000, phaseOutRatePct: 30 },
  2026: { cap: 40400, capFloor: 10000, phaseOutStart: 505000, phaseOutRatePct: 30 },
  2027: { cap: 40804, capFloor: 10000, phaseOutStart: 510050, phaseOutRatePct: 30 },
  2028: { cap: 41212.04, capFloor: 10000, phaseOutStart: 515150.5, phaseOutRatePct: 30 },
  2029: { cap: 41624.16, capFloor: 10000, phaseOutStart: 520302.01, phaseOutRatePct: 30 },
};

// Taxable years beginning after 2029 (§164(b)(7)): the
// $10,000 limitation, flat and permanent, no phase-down.
export const SALT_POST_2029: SaltScheduleEntry = {
  cap: 10000,
  capFloor: 10000,
  phaseOutStart: Infinity,
  phaseOutRatePct: 0,
};

/* The schedule entry a calendar year prices under, with
   the year that entry is dated (its deflation anchor —
   see deflationFactor in taxEngine.ts). Years from 2030
   on resolve to the post-2029 entry, dated 2030; years
   before the schedule's first year resolve to the 2025
   entry (the pricer does not consult the schedule for
   those years — it keeps the law-row path — so this
   fallback serves direct callers only). */
export function saltScheduleForYear(
  calendarYear: number,
): SaltScheduleEntry & { entryYear: number } {
  if (calendarYear >= SALT_REVERSION_YEAR) {
    return { ...SALT_POST_2029, entryYear: SALT_REVERSION_YEAR };
  }
  const entry = SALT_SCHEDULE[calendarYear];
  if (entry) return { ...entry, entryYear: calendarYear };
  return {
    ...SALT_SCHEDULE[SALT_SCHEDULE_FIRST_YEAR]!,
    entryYear: SALT_SCHEDULE_FIRST_YEAR,
  };
}

/* -------- Charitable percentage ceiling (IRC
   §170(b)(1)(G)) --------
   The deduction for CASH contributions to public charities
   may not exceed 60% of the contribution base (AGI; the
   engine models no NOL carryback). The 60% figure has been
   in effect for every law year this engine holds (enacted
   for 2018–2025 by the TCJA and made permanent by Pub. L.
   119-21), so the ceiling applies in EVERY priced year —
   unlike the 2026 deduction trio below, it is not gated on
   the 2026 law row. The engine's ONE aggregate charitable
   input carries no cash/property split and is documented
   throughout as treated as cash contributions, so the 60%
   cash ceiling applies to the whole input. ORDERING (the
   engine-audit round-2 settlement noted both orders; this
   is the order implemented): the §170(b)(1)(I) floor (2026
   and later) is applied to the entered input FIRST, and the
   60% ceiling then caps the after-floor amount — the final
   charitable component of the itemized total therefore
   never exceeds 60% of AGI. The excess over the ceiling is
   NOT deducted and does NOT carry forward: the engine
   keeps no §170(d)(1) carryforward ledger (the
   floor-disallowed amounts likewise do not carry), so the
   cap errs conservative — it can overstate a later year's
   tax, never understate the current year's. The ceiling
   applies ONLY to the itemized charitable component: the
   §170(p) non-itemizer deduction keeps its own per-status
   caps, and the Washington excise's charitable deduction
   keeps pricing from the raw input. */
export const CHARITABLE_CEILING = {
  ratePct: 60,
};

/* -------- 2026 deduction trio (Pub. L. 119-21, tax years
   beginning after December 31, 2025) --------
   Three deduction rules the year pricer (priceYear in
   taxEngine.ts) applies ONLY for law years 2026 and later;
   a year priced under the 2025 row is untouched by all
   three:
   · The charitable floor for itemizers (IRC §170(b)(1)(I)):
     an itemizer's deductible charitable contributions are
     reduced by 0.5% of the contribution base (AGI; the
     engine models no NOL carryback). Floor-disallowed
     amounts do NOT carry forward.
   · The non-itemizer charitable deduction (IRC §170(p)):
     a standard-deduction filer's charitable contributions
     (the engine's single charitable input, treated as cash
     contributions) are deductible up to the cap below.
     The floor never applies to this deduction.
   · The §68 limitation: the otherwise-allowable itemized
     total is reduced by 2/37 of the lesser of the itemized
     total or the excess of (taxable income without regard
     to §68, plus the itemized total) over the dollar
     threshold where the 37% bracket begins for the filing
     status and law year — that threshold is READ FROM the
     year's bracket row (the top of the 35% bracket), never
     a separate constant here. §68 applies AFTER every other
     limitation (the SALT cap, the charitable floor, the
     mortgage rules), and home mortgage interest is NOT
     exempt (the 2025 amendment removed the old carve-outs).
   The §170(p) caps are statutory for the statuses this
   engine prices ($2,000 MFJ / $1,000 single or head of
   household); married filing separately — a status this
   engine does not price — is shown at $500, the Code's
   usual halving of the single figure: that $500 is an
   ASSUMED figure, named as such in the API contract. */
export const DEDUCTION_2026 = {
  firstYear: 2026,
  charitableFloorRatePct: 0.5,
  nonItemizerCharitableCap: {
    mfj: 2000,
    single: 1000,
    hoh: 1000,
  } as Record<FilingStatus, number>,
  section68Numerator: 2,
  section68Denominator: 37,
};

/* -------- OBBBA senior deduction (2025–2028 only) --------
   $6,000 per person aged 65+, on top of the standard deduction
   (available whether or not the filer itemizes — the engine only
   models standard-deduction filers). Phases out at 6% of MAGI
   over $75,000 single / $150,000 joint; not available MFS (the
   engine has no MFS status). Amounts are statutory (not indexed).
   §151(d)(5)(C) MAGI adds back only foreign-income exclusions (which the
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
   % of FPL, linearly interpolated inside each band.
   BAND EDGES ARE LOWER-INCLUSIVE (Build C): the published
   tables define each band as "at least X% but less than Y%"
   (Rev. Proc. 2025-25, §3.01 for 2026; Rev. Proc. 2026-26 for
   2027), so income exactly at a band's lower edge takes THAT
   band's INITIAL percentage, interpolating to its final
   percentage at the top edge. The selector in acaCreditFor
   (taxEngine.ts) therefore matches a band only when
   pctFpl < upToPctFpl (the last band also takes its top edge
   and, in 2025, everything above it). The one edge where this
   changes the priced figure is 133%: the first band's final
   percentage (2.10% in 2026, 2.15% in 2027) differs from the
   second band's initial percentage (3.14% in 2026, 3.23% in
   2027); every other edge is continuous (the lower band's
   final equals the next band's initial), so the rule prices
   identically there either way. The 400% cliff is unchanged:
   for 2026+ a credit pays at exactly 400% FPL and is $0 above.
   2025 is the ENHANCED schedule (ARPA §9661 as extended by the
   IRA, percentages per Rev. Proc. 2024-35): 0% below 150% FPL,
   rising 0–2% / 2–4% / 4–6% / 6–8.5% across the 150–200 /
   200–250 / 250–300 / 300–400 bands, and a flat 8.5% at 400%
   FPL and above — there is NO cliff in 2025, and the engine
   prices a credit above 400% FPL for 2025 coverage.
   Above 400% FPL there is NO credit for 2026+ (the enhanced
   credits expired Dec 31, 2025) — the cliff the engine prices.
   2027 TABLE SCOPE (Build C, as corrected by the
   engine-audit round-2 fix): the 2027 row (Rev. Proc.
   2026-26, Internal Revenue Bulletin 2026-31) is a PARTIAL
   law row — it publishes only the §36B applicable
   percentages, not a complete 2027 law table. It prices
   coverage year 2027 wherever a 2027 coverage year is
   priced: where a specific coverage year is priced (the
   single-year pricer: acaCreditFor's default mode, and
   pricePlaygroundYear under its statutory "lookback"
   convention) AND in projected pricing for coverage year
   2027 itself (the plan march and the Playground
   projection price a projected 2027 on the 2027 row —
   that table is published law for that year). It is NOT
   the fallback for 2028 or later — a coverage year after
   2027, specific or projected, falls back to the 2026
   row, the newest COMPLETE law row, and never to the
   2027 percentages. */
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
  // 2027 (Rev. Proc. 2026-26, IRB 2026-31): under 133% →
  // 2.15; 133–150% → 3.23 to 4.30; 150–200% → 4.30 to 6.78;
  // 200–250% → 6.78 to 8.66; 250–300% → 8.66 to 10.22;
  // 300–400% → 10.22 (the required contribution percentage
  // for 2027 is likewise 10.22%).
  2027: [
    { upToPctFpl: 133, initialPct: 2.15, finalPct: 2.15 },
    { upToPctFpl: 150, initialPct: 3.23, finalPct: 4.3 },
    { upToPctFpl: 200, initialPct: 4.3, finalPct: 6.78 },
    { upToPctFpl: 250, initialPct: 6.78, finalPct: 8.66 },
    { upToPctFpl: 300, initialPct: 8.66, finalPct: 10.22 },
    { upToPctFpl: 400, initialPct: 10.22, finalPct: 10.22 },
  ],
};
/* The ACA table a coverage year prices under. Default
   ("specific") mode — a named coverage year priced on its
   own: the year's own row when one is published (2025,
   2026, or the partial 2027 row for coverage year 2027
   exactly), otherwise the 2026 row — the newest complete
   law row, and deliberately NOT the 2027 partial row, so
   2028+ never falls back to 2027 percentages. Projected
   mode — a year inside a multi-year projection (the plan
   march, the Playground projection): a projected coverage
   year 2027 prices on the 2027 row (published law for
   that year); projected years after 2027 price on the
   2026 row and NEVER fall back to the 2027 percentages;
   projected years at or before 2026 price exactly as in
   specific mode. */
export function acaTableFor(
  coverageYear: number,
  opts?: { projected?: boolean },
): AcaBand[] {
  if (opts?.projected) {
    // Engine-audit round-2 fix: a projected 2027 prices on
    // the 2027 row; projected 2028+ keep the 2026 row (the
    // 2027 percentages are never a later year's fallback);
    // projected years at or before 2026 are unchanged.
    if (coverageYear === 2027) return ACA_TABLES[2027] ?? [];
    const own = coverageYear <= 2026 ? ACA_TABLES[coverageYear] : undefined;
    return own ?? ACA_TABLES[2026] ?? [];
  }
  if (coverageYear === 2027) return ACA_TABLES[2027] ?? [];
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
