// Work-years engine — the quit-vs-work pricing layer for the
// Roth Conversion view's "Work years" tab. Pure functions only,
// shared by the runWorkYearsCompare server action and the
// accuracy fixtures (server/src/taxFixtures.ts, workyears-*
// cases), so the numbers the fixtures pin are computed by the
// exact code the tab runs.
//
// MODEL (per the settled design):
//   · Each work year from the plan's window-start age to the
//     quit age − 1 is priced as a salary year: the contribution
//     stack (401(k) deferral + catch-up + mega backdoor Roth +
//     HSA) is built from the year's law row, the salary year's
//     federal tax comes from the SHARED priceYear path, and
//     the employee payroll tax (FICA) is computed ENTIRELY
//     from the year's own law row — its wage base, its Social
//     Security / Medicare / Additional Medicare rates, and
//     its Additional Medicare threshold (T2 build; the rates
//     and thresholds were global constants before). The
//     employer share of payroll tax is NOT priced: it is
//     never a household outlay. No ACA credit is priced in work
//     years (employer coverage assumed) and the portfolio is
//     never drawn — salary covers the plan's annual spending.
//   · The cash surplus (salary − federal tax − state tax −
//     FICA − spending − the employee's own contributions)
//     lands in Taxable at year end. Every bucket grows at the
//     plan's expected return each year; contributions land at
//     year end, so they earn no growth in the year they are
//     made. A deficit year's surplus draws the Taxable balance
//     down only to $0 — never below — and the unfunded
//     remainder is reported as that year's shortfall (totals
//     and the compare ledger carry the sum), the same honesty
//     the retirement engine applies to its own shortfall years.
//   · After the roll, the scenario is priced with the EXISTING
//     joint optimizer machinery at the quit age, and the
//     all-in lifetime tax is the optimizer's net cost plus the
//     work years' own federal tax + state tax + payroll tax —
//     the salary years' tax never passes through the optimizer,
//     so it is added here, once, in this one place. Payroll
//     tax is its OWN component everywhere that total is shown
//     (per-year lines, roll totals, compare rows): it folds
//     into the compare's totalTax and all-in score exactly as
//     the contract's score-identities text states, never
//     merged invisibly into the federal or state figures.
//   · A quit age equal to the window-start age means ZERO work
//     years: the rolled inputs are the plan itself, untouched,
//     so the result reproduces the plain optimizer run exactly.
//     A salary of $0 (or blank) prices no work years at any
//     quit age — every quit age is the no-work run.
//
// All money here is in DOLLARS (the tax engine's units); the
// law-row work-years limits are stored in cents and converted
// at this boundary, as are the saved job inputs (cents).

import { priceYear, type RothPlanInputs } from "./taxEngine";
import { lawForYear, type FilingStatus, type YearLaw } from "./taxLaw";
import {
runJointOptimizer,
type JointOptimizerResult,
} from "./rothOptimizer";

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* ---------------- The job inputs ---------------- */

export type WorkYearJob = {
  // Yearly salary, dollars. $0 / blank = no work years priced.
  salary: number;
  // What the employer puts into the 401(k) per year, dollars.
  employer401k: number;
  // What the employer puts into the HSA per year, dollars.
  employerHsa: number;
};

/* ---------------- One year's contribution stack ---------------- */

export type ContributionStack = {
  // §402(g) deferral — always pre-tax, capped at the salary.
  deferral: number;
  // §414(v) catch-up (50+, or the 60–63 super limit). Roth when
  // the §414(v)(7) mandate applies: the year is 2026 or later
  // (the mandate's first year, after IRS Notice 2023-62's
  // transition period) AND the participant's PRIOR-calendar-
  // year §3121(a) wages (W-2 Box 3: salary minus the payroll
  // HSA contribution — pre-tax 401(k) deferrals do NOT reduce
  // them) exceed the law row's Roth catch-up wage threshold.
  // The caller passes the prior year's wages when it prices a
  // sequence (rollWorkYears threads each year's own FICA
  // wages into the next); for the FIRST year of a sequence —
  // and for a standalone one-year price — there is no in-model
  // prior year, so this year's own Box-3 wages stand in as
  // the disclosed proxy (the continuing-job estimate: same
  // job, same payroll deductions, last year as this year).
  // Pre-tax otherwise.
  catchUp: number;
  catchUpIsRoth: boolean;
  // Mega backdoor: after-tax room left under the §415(c)
  // overall limit after deferral and employer money (catch-ups
  // are excluded from §415(c) annual additions), modeled into
  // Roth. $0 when the other pieces fill the cap.
  mega: number;
  // Employer 401(k) money, into Pre-tax.
  employer401k: number;
  // The household's own HSA contribution through payroll (the
  // year's HSA limit minus the employer's part, floored at $0).
  ownHsa: number;
  employerHsa: number;
  // What the HSA bucket receives: own + employer, capped at
  // the year's limit.
  hsaBucket: number;
  hsaLimit: number;
};

export function contributionStack(
  age: number,
  salary: number,
  employer401k: number,
  employerHsa: number,
  filingStatus: FilingStatus,
  law: YearLaw,
  // The PRIOR calendar year's §3121(a) wages (W-2 Box 3) from
  // the plan sponsor, when the caller prices a sequence of
  // years; null / omitted for the first year of a sequence or
  // a standalone price, where this year's own Box-3 wages are
  // the disclosed proxy (see the ContributionStack note).
  priorYearWages?: number | null,
): ContributionStack {
  const empty: ContributionStack = {
    deferral: 0,
    catchUp: 0,
    catchUpIsRoth: false,
    mega: 0,
    employer401k: 0,
    ownHsa: 0,
    employerHsa: 0,
    hsaBucket: 0,
    hsaLimit: 0,
  };
  if (salary <= 0) return empty;
  const elective = law.elective401kLimit / 100;
  const deferral = Math.min(elective, salary);
  let catchUp = 0;
  if (age >= 50) {
    const bandLimit =
      (age >= 60 && age <= 63 ? law.catchUp60to63Limit : law.catchUp50Limit) / 100;
    catchUp = Math.max(0, Math.min(bandLimit, salary - deferral));
  }
  // The year's own §3121(a) wages (W-2 Box 3): salary minus
  // the employee's payroll HSA contribution (a §125 cafeteria
  // deduction — it reduces Box 3; the pre-tax 401(k) deferral
  // does NOT). Computed here because the catch-up test below
  // reads wages; the HSA figures themselves are unchanged.
  const hsaLimit =
    (filingStatus === "mfj" ? law.hsaLimitFamily : law.hsaLimitSelf) / 100 +
    (age >= 55 ? law.hsaCatchUp55 / 100 : 0);
  const ownHsa = Math.max(
    0,
    Math.min(hsaLimit - employerHsa, salary - deferral - catchUp),
  );
  const box3ThisYear = salary - ownHsa;
  // §414(v)(7) Roth catch-up mandate (SECURE 2.0 §603): a
  // participant whose PRIOR-calendar-year §3121(a) wages from
  // the plan sponsor exceed the threshold must make catch-ups
  // as Roth — but only for tax years beginning after 2025.
  // IRS Notice 2023-62's administrative transition period made
  // pre-tax catch-ups permissible through 2025 regardless of
  // wages, so the gate is the law row's year: a 2025-law year
  // never forces Roth. (E1: the mandate previously applied in
  // 2025 too, one year early — on a maxed 2025 catch-up that
  // mischaracterized $1,650 of contributions as Roth.)
  // (Round-5 fix 2: the wage figure is the PRIOR year's Box 3
  // — the caller threads it through a priced sequence; the
  // first year of a sequence, and any standalone price, fall
  // back to this year's own Box 3 as the disclosed proxy. The
  // pre-fix code compared the CURRENT year's gross salary,
  // which both overstated the wages (no HSA reduction) and
  // read the wrong year.)
  const wageBasis = priorYearWages != null ? priorYearWages : box3ThisYear;
  const catchUpIsRoth =
    law.year >= 2026 && wageBasis > law.rothCatchUpWageThreshold / 100;
  // The typed employer 401(k) lands only up to the §415(c) room
  // left after the deferral — a larger typed figure cannot push
  // the year's additions past the overall cap. Catch-up
  // contributions are excluded from §415(c) annual additions, so
  // they do not net against the room for employer money or for
  // the mega backdoor.
  // §415(c) room is the LESSER of the year's dollar cap and
  // 100% of the participant's compensation (the salary, here):
  // on a $10,000 salary the year's total additions cannot
  // exceed $10,000 however large the typed employer figure is.
  // (Round-7 fix 4.1: the room previously read only the dollar
  // cap, so a $10,000 salary with a $50,000 typed employer
  // contribution booked $60,000 of additions against a $10,000
  // legal limit.)
  const additionsCap = Math.min(law.overall415cLimit / 100, salary);
  const employerLanded = Math.min(
    employer401k,
    Math.max(0, additionsCap - deferral),
  );
  const megaRoom = Math.max(0, additionsCap - deferral - employerLanded);
  // (hsaLimit and ownHsa are computed above — the catch-up
  // wage test reads them.)
  const mega = Math.max(
    0,
    Math.min(megaRoom, salary - deferral - catchUp - ownHsa),
  );
  const hsaBucket = Math.min(hsaLimit, ownHsa + employerHsa);
  return {
    deferral: r2(deferral),
    catchUp: r2(catchUp),
    catchUpIsRoth,
    mega: r2(mega),
    employer401k: r2(employerLanded),
    ownHsa: r2(ownHsa),
    employerHsa: r2(employerHsa),
    hsaBucket: r2(hsaBucket),
    hsaLimit: r2(hsaLimit),
  };
}

/* ---------------- Payroll tax (employee FICA) ---------------- */

export type PayrollTaxBreakdown = {
  // Social Security tax: the year's rate on wages up to the
  // year's wage base.
  socialSecurity: number;
  // Medicare tax: the year's rate on all FICA wages.
  medicare: number;
  // Additional Medicare Tax: the year's rate on wages above
  // the year's filing-status threshold.
  additionalMedicare: number;
  // The total employee payroll tax. Computed from the
  // UNROUNDED components and rounded once, exactly as the
  // pre-T2 ficaTax computed it — so the components (each
  // rounded for display) can differ from the total by a cent
  // on a half-cent edge, and no priced figure moves.
  total: number;
};

// Employee payroll tax on one year's FICA wages (salary minus
// the employee's own payroll HSA contribution), priced
// ENTIRELY from the year's own law row (T2): Social Security
// at the row's rate on wages up to the row's wage base,
// Medicare at the row's rate on all wages, plus the
// Additional Medicare Tax at the row's rate over the row's
// filing-status threshold. The employer share is not priced.
export function payrollTaxBreakdown(
  ficaWages: number,
  filingStatus: FilingStatus,
  law: YearLaw,
): PayrollTaxBreakdown {
  if (ficaWages <= 0) {
    return { socialSecurity: 0, medicare: 0, additionalMedicare: 0, total: 0 };
  }
  const ss =
    (law.payrollSsRatePct / 100) *
    Math.min(ficaWages, law.ssWageBase / 100);
  const medicare = (law.payrollMedicareRatePct / 100) * ficaWages;
  const additional =
    (law.payrollAdditionalMedicareRatePct / 100) *
    Math.max(0, ficaWages - law.payrollAdditionalMedicareThreshold[filingStatus]);
  return {
    socialSecurity: r2(ss),
    medicare: r2(medicare),
    additionalMedicare: r2(additional),
    total: r2(ss + medicare + additional),
  };
}

export function ficaTax(
  ficaWages: number,
  filingStatus: FilingStatus,
  law: YearLaw,
): number {
  return payrollTaxBreakdown(ficaWages, filingStatus, law).total;
}

/* ---------------- One work year ---------------- */

export type WorkYearLine = {
  age: number;
  calendarYear: number;
  salary: number;
  stack: ContributionStack;
  // Salary minus pre-tax deferral, pre-tax catch-up, and the
  // employee's own HSA — the wages the federal price runs on.
  taxableWages: number;
  // The year's priced MAGI (the shared priceYear result's
  // magi: AGI plus tax-exempt interest — $0 of the latter in
  // a work year). Build E: the roll records it in the rolled
  // plan's IRMAA lookback seed, so the retirement march's
  // first premium years grade these work-year returns
  // instead of pricing no lookback at all.
  magi: number;
  federalTax: number;
  // State tax on the salary year, from the shared priceYear
  // path at the plan's state tax rate (0 at a 0% rate).
  stateTax: number;
  ficaWages: number;
  fica: number;
  // Payroll tax as its own named component (T2): the same
  // figure as `fica` (kept under its long-standing name for
  // every existing reader), plus its three priced parts from
  // the year's law row — Social Security, Medicare, and the
  // Additional Medicare Tax — so a year output can show the
  // payroll tax and its makeup without re-deriving either.
  payrollTax: number;
  payrollSocialSecurity: number;
  payrollMedicare: number;
  payrollAdditionalMedicare: number;
  // Salary − federal − state − FICA − the plan's annual
  // spending − the employee's own contributions (deferral +
  // catch-up + mega + own HSA). Banked into Taxable at year
  // end.
  surplus: number;
  // The part of a NEGATIVE surplus the Taxable balance could
  // not absorb (round-7 fix 1.1): the roll floors the balance
  // at $0 — a work year never books a negative asset — and the
  // unfunded remainder is reported here as the year's
  // shortfall instead of being hidden inside a negative
  // balance the retirement engine would later floor away
  // silently. $0 in every year the balance covers the deficit.
  // priceOneWorkYear has no balance context and always returns
  // 0; rollWorkYears fills in the real figure.
  shortfall: number;
};

export function priceOneWorkYear(
  plan: RothPlanInputs,
  job: WorkYearJob,
  age: number,
  // The prior calendar year's §3121(a) wages (W-2 Box 3) for
  // the §414(v)(7) catch-up test — rollWorkYears passes the
  // previous priced year's own FICA wages; omitted (a
  // standalone price) the stack falls back to this year's own
  // Box 3 as the disclosed proxy.
  priorYearWages?: number | null,
): WorkYearLine {
  const calendarYear = plan.birthYearPrimary + age;
  const law = lawForYear(calendarYear);
  const stack = contributionStack(
    age,
    job.salary,
    job.employer401k,
    job.employerHsa,
    plan.filingStatus,
    law,
    priorYearWages,
  );
  const catchUpPreTax = stack.catchUpIsRoth ? 0 : stack.catchUp;
  const taxableWages = r2(
    job.salary - stack.deferral - catchUpPreTax - stack.ownHsa,
  );
  const ageSpouse =
    plan.birthYearSpouse != null ? calendarYear - plan.birthYearSpouse : null;
  const priced = priceYear({
    calendarYear,
    filingStatus: plan.filingStatus,
    agePrimary: age,
    ageSpouse,
    otherOrdinary: Math.max(0, taxableWages),
    rmd: 0,
    conversion: 0,
    extraPreTaxDraw: 0,
    ssBenefits: 0,
    taxExemptInterest: 0,
    ltcg: 0,
    inflationPct: plan.inflationPct,
    stateRatePct: plan.stateRatePct,
    // A work year realizes no capital gains (ltcg: 0), so a
    // Washington residence prices $0 of excise here — the
    // state line of a salary year is $0 either way.
    residenceState: plan.residenceState ?? null,
    // Itemized deductions (T5): a salary year takes the same
    // greater-of deduction as any priced year — the plan's
    // itemized components against the standard side — so a
    // work year's federal tax is priced with the household's
    // deduction, not a forced standard deduction.
    itemizedMortgageInterest: plan.itemizedMortgageInterest,
    itemizedSaltPaid: plan.itemizedSaltPaid,
    itemizedCharitable: plan.itemizedCharitable,
    itemizedOther: plan.itemizedOther,
    // Education expenses (T6): this calendar year's entered
    // students price their §25A credits in the work year
    // exactly as in any priced year — the nonrefundable
    // portion is inside priced.federalTax, so the surplus
    // below already reflects it. The refundable portion is
    // NOT added to the surplus: the surplus is salary minus
    // priced taxes and spending, and the refundable credit
    // is returned money the roll-forward does not spend —
    // the same conservative treatment the work-year surplus
    // gives every other refundable figure (it adds none).
    educationStudents: (plan.educationStudents ?? []).filter(
      (e) => e.year === calendarYear,
    ),
  });
  const ficaWages = r2(job.salary - stack.ownHsa);
  const payroll = payrollTaxBreakdown(
    Math.max(0, ficaWages),
    plan.filingStatus,
    law,
  );
  const fica = payroll.total;
  const ownContributions =
    stack.deferral + stack.catchUp + stack.mega + stack.ownHsa;
  const surplus = r2(
    job.salary -
      priced.federalTax -
      priced.stateTax -
      fica -
      plan.annualSpending -
      ownContributions,
  );
  return {
    age,
    calendarYear,
    salary: job.salary,
    stack,
    taxableWages,
    magi: priced.magi,
    federalTax: priced.federalTax,
    stateTax: priced.stateTax,
    ficaWages,
    fica,
    payrollTax: payroll.total,
    payrollSocialSecurity: payroll.socialSecurity,
    payrollMedicare: payroll.medicare,
    payrollAdditionalMedicare: payroll.additionalMedicare,
    surplus,
    // No balance context in a standalone price — the roll
    // computes the year's real shortfall (see WorkYearLine).
    shortfall: 0,
  };
}

/* ---------------- The roll ---------------- */

export type WorkYearTotals = {
  years: number;
  grossSalary: number;
  federal: number;
  state: number;
  fica: number;
  // Payroll tax totals as their own component (T2): the same
  // figure as `fica`, plus its three priced parts summed over
  // the roll's years.
  payrollTax: number;
  payrollSocialSecurity: number;
  payrollMedicare: number;
  payrollAdditionalMedicare: number;
  // Contributions by bucket (all sources).
  pretaxContributions: number;
  rothContributions: number;
  hsaContributions: number;
  totalContributions: number;
  // Contributions by source.
  employeeContributions: number;
  employerContributions: number;
  // What actually landed in Taxable from the surplus stream:
  // each year's surplus as absorbed by the balance (a deficit
  // year reduces it only down to a $0 balance — see shortfall).
  // Equals the plain sum of the yearly surpluses whenever no
  // year ran a shortfall.
  surplusBanked: number;
  // Total unfunded work-year shortfall (round-7 fix 1.1): the
  // sum of the yearly shortfalls — spending and taxes the
  // salary plus the Taxable balance could not cover. Reported
  // plainly here and in the compare's ledger, never netted
  // into a balance.
  shortfall: number;
  // Everything that landed in the buckets while working:
  // total contributions + surplus banked into Taxable.
  banked: number;
};

export type WorkYearRoll = {
  lines: WorkYearLine[];
  totals: WorkYearTotals;
  // Balances at the quit age, after the last work year's
  // growth + year-end contributions.
  balances: {
    pretax: number; // primary + spouse combined
    pretaxPrimary: number;
    pretaxSpouse: number;
    roth: number;
    taxable: number;
    hsa: number;
  };
  // The plan inputs the optimizer prices for this quit age:
  // the plan itself, untouched, when there are no work years;
  // otherwise the same plan with its start / retirement /
  // window-start ages set to the quit age and its balances
  // replaced by the rolled balances.
  rolledInputs: RothPlanInputs;
};

export function rollWorkYears(
  plan: RothPlanInputs,
  job: WorkYearJob,
  quitAge: number,
): WorkYearRoll {
  const startAge = plan.windowStartAge;
  const count =
    job.salary > 0 ? Math.max(0, Math.floor(quitAge) - startAge) : 0;
  const startBalances = {
    pretax: r2(plan.pretaxStart + (plan.pretaxSpouseStart ?? 0)),
    pretaxPrimary: plan.pretaxStart,
    pretaxSpouse: plan.pretaxSpouseStart ?? 0,
    roth: plan.rothStart,
    taxable: plan.taxableStart,
    hsa: plan.hsaStart,
  };
  if (count === 0) {
    return {
      lines: [],
      totals: {
        years: 0,
        grossSalary: 0,
        federal: 0,
        state: 0,
        fica: 0,
        payrollTax: 0,
        payrollSocialSecurity: 0,
        payrollMedicare: 0,
        payrollAdditionalMedicare: 0,
        pretaxContributions: 0,
        rothContributions: 0,
        hsaContributions: 0,
        totalContributions: 0,
        employeeContributions: 0,
        employerContributions: 0,
        surplusBanked: 0,
        shortfall: 0,
        banked: 0,
      },
      balances: startBalances,
      rolledInputs: plan,
    };
  }
  // RETURN FLOOR (round-5 fix 3): the same Math.max(0, ·)
  // floor the retirement engine applies — a return below
  // −100% cannot shrink a rolled balance below zero.
  const growth = Math.max(0, 1 + plan.expectedReturnPct / 100);
  let pretaxPrimary = plan.pretaxStart;
  let pretaxSpouse = plan.pretaxSpouseStart ?? 0;
  let roth = plan.rothStart;
  let taxable = plan.taxableStart;
  let hsa = plan.hsaStart;
  const lines: WorkYearLine[] = [];
  const totals: WorkYearTotals = {
    years: count,
    grossSalary: 0,
    federal: 0,
    state: 0,
    fica: 0,
    payrollTax: 0,
    payrollSocialSecurity: 0,
    payrollMedicare: 0,
    payrollAdditionalMedicare: 0,
    pretaxContributions: 0,
    rothContributions: 0,
    hsaContributions: 0,
    totalContributions: 0,
    employeeContributions: 0,
    employerContributions: 0,
    surplusBanked: 0,
    shortfall: 0,
    banked: 0,
  };
  // PRIOR-YEAR WAGES threading (round-5 fix 2): each year's
  // §414(v)(7) test reads the PREVIOUS year's §3121(a) wages —
  // the previous line's own FICA wages (salary − payroll HSA),
  // which is exactly the Box-3 figure this model computes.
  // The first priced year has no in-model predecessor and
  // prices on the disclosed proxy (its own Box 3).
  let priorYearWages: number | null = null;
  for (let i = 0; i < count; i++) {
    const age = startAge + i;
    const pricedLine = priceOneWorkYear(plan, job, age, priorYearWages);
    priorYearWages = pricedLine.ficaWages;
    const s = pricedLine.stack;
    const catchUpPreTax = s.catchUpIsRoth ? 0 : s.catchUp;
    const catchUpRoth = s.catchUpIsRoth ? s.catchUp : 0;
    const pretaxIn = s.deferral + catchUpPreTax + s.employer401k;
    const rothIn = catchUpRoth + s.mega;
    // Grow first, then land the year-end contributions — the
    // contributions earn no growth in the year they are made.
    pretaxPrimary = pretaxPrimary * growth + pretaxIn;
    pretaxSpouse = pretaxSpouse * growth;
    roth = roth * growth + rothIn;
    // DEFICIT FLOOR (round-7 fix 1.1): a work year's surplus
    // can be negative — outgo past the salary — but the
    // Taxable balance is an asset and cannot go below $0. The
    // balance absorbs the deficit down to zero and the
    // unfunded remainder becomes the year's SHORTFALL,
    // reported on the line and in the totals, mirroring the
    // retirement engine's honesty (a shortfall year floors
    // the balance and reports the unfunded need). The pre-fix
    // roll added the negative surplus straight into the
    // balance, manufacturing a negative asset the retirement
    // engine later floored away with no shortfall reported
    // anywhere.
    const grownTaxable = taxable * growth;
    const rawTaxable = grownTaxable + pricedLine.surplus;
    const shortfall = rawTaxable < 0 ? r2(-rawTaxable) : 0;
    taxable = rawTaxable < 0 ? 0 : rawTaxable;
    const line: WorkYearLine = { ...pricedLine, shortfall };
    lines.push(line);
    hsa = hsa * growth + s.hsaBucket;
    totals.grossSalary += line.salary;
    totals.federal += line.federalTax;
    totals.state += line.stateTax;
    totals.fica += line.fica;
    totals.payrollTax += line.payrollTax;
    totals.payrollSocialSecurity += line.payrollSocialSecurity;
    totals.payrollMedicare += line.payrollMedicare;
    totals.payrollAdditionalMedicare += line.payrollAdditionalMedicare;
    totals.pretaxContributions += pretaxIn;
    totals.rothContributions += rothIn;
    totals.hsaContributions += s.hsaBucket;
    totals.employeeContributions +=
      s.deferral + s.catchUp + s.mega + s.ownHsa;
    // Employer HSA counts only what actually lands in the HSA
    // bucket (hsaBucket − ownHsa): a typed employer HSA above
    // the year's limit cannot make employer + employee
    // contributions exceed totalContributions.
    totals.employerContributions +=
      s.employer401k + (s.hsaBucket - s.ownHsa);
    // What actually landed in Taxable from this year's surplus
    // stream: the surplus itself, plus back any part the $0
    // floor refused (that part is the year's shortfall, counted
    // separately below — never double-counted into a balance).
    totals.surplusBanked += line.surplus + line.shortfall;
    totals.shortfall += line.shortfall;
  }
  totals.grossSalary = r2(totals.grossSalary);
  totals.federal = r2(totals.federal);
  totals.state = r2(totals.state);
  totals.fica = r2(totals.fica);
  totals.payrollTax = r2(totals.payrollTax);
  totals.payrollSocialSecurity = r2(totals.payrollSocialSecurity);
  totals.payrollMedicare = r2(totals.payrollMedicare);
  totals.payrollAdditionalMedicare = r2(totals.payrollAdditionalMedicare);
  totals.pretaxContributions = r2(totals.pretaxContributions);
  totals.rothContributions = r2(totals.rothContributions);
  totals.hsaContributions = r2(totals.hsaContributions);
  totals.totalContributions = r2(
    totals.pretaxContributions + totals.rothContributions + totals.hsaContributions,
  );
  totals.employeeContributions = r2(totals.employeeContributions);
  totals.employerContributions = r2(totals.employerContributions);
  totals.surplusBanked = r2(totals.surplusBanked);
  totals.shortfall = r2(totals.shortfall);
  totals.banked = r2(totals.totalContributions + totals.surplusBanked);
  const balances = {
    pretax: r2(pretaxPrimary + pretaxSpouse),
    pretaxPrimary: r2(pretaxPrimary),
    pretaxSpouse: r2(pretaxSpouse),
    roth: r2(roth),
    taxable: r2(taxable),
    hsa: r2(hsa),
  };
  const rolledInputs: RothPlanInputs = {
    ...plan,
    // IRMAA LOOKBACK SEED (Build E): the work years this roll
    // just priced, recorded with the filing status each was
    // priced under — the plan's own status, the only status
    // the roll prices (the roll models no survivor change
    // during the work years) — so the rolled march, which
    // starts at the quit age and never prices these years
    // itself, grades its first premium years from these real
    // work-year returns (SSA's two-year lookback) instead of
    // finding no lookback at all. A quit age of 65 is the
    // case that bites: without the seed, premium years 65
    // and 66 would price $0 of IRMAA whatever the salary
    // years' MAGI was.
    irmaaLookbackSeed: lines.map((l) => ({
      year: l.calendarYear,
      magi: l.magi,
      filingStatus: plan.filingStatus,
    })),
    startYear: plan.birthYearPrimary + Math.floor(quitAge),
    retirementAge: Math.floor(quitAge),
    windowStartAge: Math.floor(quitAge),
    pretaxStart: Math.max(0, balances.pretaxPrimary),
    pretaxSpouseStart: Math.max(0, balances.pretaxSpouse),
    rothStart: Math.max(0, balances.roth),
    taxableStart: Math.max(0, balances.taxable),
    hsaStart: Math.max(0, balances.hsa),
    convertedAlreadyThisYear: 0,
  };
  return { lines, totals, balances, rolledInputs };
}

/* ---------------- The compare (roll + joint optimizer) ---------------- */

export type WorkYearsCompareRow = {
  quitAge: number;
  workYears: number;
  roll: WorkYearRoll;
  optimizer: JointOptimizerResult;
  // The work years' own tax (federal + state + payroll) — never
  // priced by the optimizer, added here for the all-in figures.
  workTax: number;
  // The work years' employee payroll tax as its own component
  // (T2): the payroll part of workTax, named separately
  // wherever the work years' tax is shown.
  payrollTax: number;
  // The plan's TOTAL tax on this row (T2 fold-in): the
  // optimizer winner's lifetime federal + state tax PLUS the
  // work years' federal + state + payroll tax. The score
  // identity on a salary-carrying row is therefore the same
  // shape as on any other row — allInTax = totalTax + penalty
  // + irmaa − acaCredit + terminal — with payroll tax inside
  // totalTax as its own component, as the contract's
  // score-identities text states. On a row with no work years
  // totalTax is the winner's tax exactly.
  totalTax: number;
  // Total unfunded work-year shortfall across the roll
  // (round-7 fix 1.1): spending and taxes the salary plus the
  // Taxable balance could not cover in the work years. The
  // optimizer prices the floored balances, so without this
  // figure the shortfall would vanish from the handoff.
  shortfall: number;
  // Optimizer winner net cost + workTax.
  allInTax: number;
  // The claim-67 row's best net cost + workTax, when the joint
  // search priced claim 67; null when it did not.
  claim67AllInTax: number | null;
  // Winner's ending balances (nominal) and after-tax ending
  // wealth (ending nominal − terminal tax on ending pre-tax,
  // the engine's endingAfterTaxWealth).
  endingNominal: number;
  endingAfterTax: number;
};

export function runWorkYearsCompare(
  plan: RothPlanInputs,
  job: WorkYearJob,
  quitAges: number[],
): WorkYearsCompareRow[] {
  // Identical effective plans (the zero-salary case, where
  // every quit age is the no-work run) price the optimizer
  // once and share the result.
  const cache = new Map<string, { roll: WorkYearRoll; optimizer: JointOptimizerResult }>();
  return quitAges.map((quitAge) => {
    const roll = rollWorkYears(plan, job, quitAge);
    const key =
      roll.totals.years === 0
        ? "no-work"
        : `${quitAge}:${roll.balances.pretax}:${roll.balances.roth}:${roll.balances.taxable}:${roll.balances.hsa}`;
    let entry = cache.get(key);
    if (!entry) {
      entry = { roll, optimizer: runJointOptimizer(roll.rolledInputs) };
      cache.set(key, entry);
    }
    const opt = entry.optimizer;
    const workTax = r2(roll.totals.federal + roll.totals.state + roll.totals.fica);
    const claim67 =
      opt.claimAgeTable.find((row) => row.primaryAge === 67) ?? null;
    const endingNominal = r2(
      opt.winner.result.endingPretax +
        opt.winner.result.endingRoth +
        opt.winner.result.endingTaxable +
        opt.winner.result.endingHsa,
    );
    return {
      quitAge,
      workYears: roll.totals.years,
      roll,
      optimizer: opt,
      workTax,
      payrollTax: roll.totals.payrollTax,
      totalTax: r2(opt.winner.cost.tax + workTax),
      shortfall: roll.totals.shortfall,
      allInTax: r2(opt.winner.cost.netCost + workTax),
      claim67AllInTax:
        claim67 == null ? null : r2(claim67.best.cost.netCost + workTax),
      endingNominal,
      endingAfterTax: opt.winner.result.endingAfterTaxWealth,
    };
  });
}
