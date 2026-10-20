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
//     FICA is computed from the law row's wage base and the
//     FICA_RATES constants. No ACA credit is priced in work
//     years (employer coverage assumed) and the portfolio is
//     never drawn — salary covers the plan's annual spending.
//   · The cash surplus (salary − federal tax − state tax −
//     FICA − spending − the employee's own contributions)
//     lands in Taxable at year end. Every bucket grows at the
//     plan's expected return each year; contributions land at
//     year end, so they earn no growth in the year they are
//     made.
//   · After the roll, the scenario is priced with the EXISTING
//     joint optimizer machinery at the quit age, and the
//     all-in lifetime tax is the optimizer's net cost plus the
//     work years' own federal tax + state tax + FICA — the
//     salary years' tax never passes through the optimizer,
//     so it is added here, once, in this one place.
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
import { FICA_RATES, lawForYear, type FilingStatus, type YearLaw } from "./taxLaw";
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
  const employerLanded = Math.min(
    employer401k,
    Math.max(0, law.overall415cLimit / 100 - deferral),
  );
  const megaRoom = Math.max(
    0,
    law.overall415cLimit / 100 - deferral - employerLanded,
  );
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

/* ---------------- FICA ---------------- */

// Employee payroll tax on one year's FICA wages (salary minus
// the employee's own payroll HSA contribution): 6.2% up to the
// year's wage base, 1.45% on all of it, plus 0.9% over the
// filing status's Additional Medicare threshold.
export function ficaTax(
  ficaWages: number,
  filingStatus: FilingStatus,
  law: YearLaw,
): number {
  if (ficaWages <= 0) return 0;
  const ss =
    (FICA_RATES.socialSecurityPct / 100) *
    Math.min(ficaWages, law.ssWageBase / 100);
  const medicare = (FICA_RATES.medicarePct / 100) * ficaWages;
  const additional =
    (FICA_RATES.additionalMedicarePct / 100) *
    Math.max(0, ficaWages - FICA_RATES.additionalMedicareThreshold[filingStatus]);
  return r2(ss + medicare + additional);
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
  federalTax: number;
  // State tax on the salary year, from the shared priceYear
  // path at the plan's state tax rate (0 at a 0% rate).
  stateTax: number;
  ficaWages: number;
  fica: number;
  // Salary − federal − state − FICA − the plan's annual
  // spending − the employee's own contributions (deferral +
  // catch-up + mega + own HSA). Banked into Taxable at year
  // end.
  surplus: number;
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
  });
  const ficaWages = r2(job.salary - stack.ownHsa);
  const fica = ficaTax(Math.max(0, ficaWages), plan.filingStatus, law);
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
    federalTax: priced.federalTax,
    stateTax: priced.stateTax,
    ficaWages,
    fica,
    surplus,
  };
}

/* ---------------- The roll ---------------- */

export type WorkYearTotals = {
  years: number;
  grossSalary: number;
  federal: number;
  state: number;
  fica: number;
  // Contributions by bucket (all sources).
  pretaxContributions: number;
  rothContributions: number;
  hsaContributions: number;
  totalContributions: number;
  // Contributions by source.
  employeeContributions: number;
  employerContributions: number;
  surplusBanked: number;
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
        pretaxContributions: 0,
        rothContributions: 0,
        hsaContributions: 0,
        totalContributions: 0,
        employeeContributions: 0,
        employerContributions: 0,
        surplusBanked: 0,
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
    pretaxContributions: 0,
    rothContributions: 0,
    hsaContributions: 0,
    totalContributions: 0,
    employeeContributions: 0,
    employerContributions: 0,
    surplusBanked: 0,
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
    const line = priceOneWorkYear(plan, job, age, priorYearWages);
    priorYearWages = line.ficaWages;
    lines.push(line);
    const s = line.stack;
    const catchUpPreTax = s.catchUpIsRoth ? 0 : s.catchUp;
    const catchUpRoth = s.catchUpIsRoth ? s.catchUp : 0;
    const pretaxIn = s.deferral + catchUpPreTax + s.employer401k;
    const rothIn = catchUpRoth + s.mega;
    // Grow first, then land the year-end contributions — the
    // contributions earn no growth in the year they are made.
    pretaxPrimary = pretaxPrimary * growth + pretaxIn;
    pretaxSpouse = pretaxSpouse * growth;
    roth = roth * growth + rothIn;
    taxable = taxable * growth + line.surplus;
    hsa = hsa * growth + s.hsaBucket;
    totals.grossSalary += line.salary;
    totals.federal += line.federalTax;
    totals.state += line.stateTax;
    totals.fica += line.fica;
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
    totals.surplusBanked += line.surplus;
  }
  totals.grossSalary = r2(totals.grossSalary);
  totals.federal = r2(totals.federal);
  totals.state = r2(totals.state);
  totals.fica = r2(totals.fica);
  totals.pretaxContributions = r2(totals.pretaxContributions);
  totals.rothContributions = r2(totals.rothContributions);
  totals.hsaContributions = r2(totals.hsaContributions);
  totals.totalContributions = r2(
    totals.pretaxContributions + totals.rothContributions + totals.hsaContributions,
  );
  totals.employeeContributions = r2(totals.employeeContributions);
  totals.employerContributions = r2(totals.employerContributions);
  totals.surplusBanked = r2(totals.surplusBanked);
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
  // The work years' own tax (federal + state + FICA) — never
  // priced by the optimizer, added here for the all-in figures.
  workTax: number;
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
      allInTax: r2(opt.winner.cost.netCost + workTax),
      claim67AllInTax:
        claim67 == null ? null : r2(claim67.best.cost.netCost + workTax),
      endingNominal,
      endingAfterTax: opt.winner.result.endingAfterTaxWealth,
    };
  });
}
