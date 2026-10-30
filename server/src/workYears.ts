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
//     years (employer coverage assumed); salary covers the
//     plan's annual spending, and a year whose outgo runs past
//     the salary draws the Taxable balance (see the deficit
//     settlement below).
//   · The cash surplus (salary − federal tax − state tax −
//     FICA − spending − the employee's own contributions +
//     any Social Security benefits already being collected)
//     lands in Taxable at year end. The refundable §25A
//     credit is NOT part of that surplus: like the
//     retirement march, the roll carries it undeposited and
//     lands it in Taxable at the start of the NEXT work
//     year, at 100% basis (the return is filed the next
//     spring); a credit earned in the roll's last work year
//     is included in the quit-age Taxable balance instead,
//     so no refund dollar is ever dropped. Every bucket grows at the
//     plan's expected return each year; contributions land at
//     year end, so they earn no growth in the year they are
//     made. A deficit year's surplus draws the Taxable balance
//     down only to $0 — never below — and the unfunded
//     remainder is reported as that year's shortfall (totals
//     and the compare ledger carry the sum), the same honesty
//     the retirement engine applies to its own shortfall years.
//     A deficit funded from Taxable is a SALE: it realizes
//     capital gains off the taxable basis ledger (contract
//     v58, F1), priced into the work year itself by settling
//     the year to a fixed point — the drawn amount and the
//     gain it realizes agree to the cent. The basis ledger
//     itself rolls forward in dollars alongside the balance
//     (F2): growth adds no basis, the year's taxable yields
//     step basis up (the march's rule), a positive surplus
//     lands at 100% basis, and a deficit sale consumes basis
//     in the march's sale order. The rolled plan's basis
//     fields are rebuilt from those dollars, so the march
//     prices the quit-age plan on the true basis.
//   · Work-year income is the household's full mandatory
//     income: the plan's taxable interest / dividend yields
//     price on the year's opening Taxable balance exactly as
//     the march prices them (F3), and Social Security
//     benefits whose start age has been reached are deposited
//     and taxed (§86, inside the shared priceYear) during the
//     work years (F4). The pre-full-retirement-age earnings
//     test is NOT modeled — no machinery for it exists
//     anywhere in the engine — so benefits deposit in full.
//   · Required minimum distributions price in salary years
//     too (contract v98, engine-calendar fix F5): each owner's
//     RMD is computed by the plan engine's own shared helper
//     on that owner's prior-Dec-31 pre-tax balance — the
//     balance the year opens with, before this year's growth
//     and before this year's contributions land, so a
//     contribution made DURING a year never counts toward
//     that year's RMD — with the same RMD-age mapping and the
//     same per-owner Joint-vs-Uniform table selection the
//     plan march applies (the spouse sole beneficiary and
//     more than 10 years younger selects the Joint table for
//     that owner; each owner's own beneficiary fact selects
//     only that owner's table). The distribution is priced
//     exactly as the march prices it: ordinary income inside
//     the shared priceYear, cash in the year's surplus on the
//     same footing as Social Security benefits, and money out
//     of the pre-tax balance (the post-distribution balance
//     is what grows and what this year's contributions land
//     on). LIMITATION (settled with the fix): no still-working
//     exception is priced — the work-years path, like the
//     plan, carries pre-tax money as one aggregated balance
//     per owner with no 401(k)/IRA distinction, so a worker
//     past RMD age whose balance sits entirely in a current
//     employer's plan and who could qualify for that
//     exception is priced with an RMD anyway.
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
//   · ZERO work years (contract v58, F5): a quit age at or
//     below the roll's first year prices no work years, and
//     the rolled inputs are the plan with its retirement age
//     and window-start age set to the QUIT age (balances and
//     zero totals exactly as the plan's) — the row prices
//     retiring AT the quit age, not at the plan's saved
//     retirement age. The roll's first year is never in the
//     past: it is the later of the plan's window-start age
//     and the plan's current age (startYear − birth year),
//     so a window start below the current age cannot invent
//     already-past salary years on top of today's balances.
//     A salary of $0 (or blank) prices no work years at any
//     quit age.
//
// All money here is in DOLLARS (the tax engine's units); the
// law-row work-years limits are stored in cents and converted
// at this boundary, as are the saved job inputs (cents).

import {
  deflationFactor,
  priceYear,
  rmdForYear,
  type RothPlanInputs,
} from "./taxEngine";
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
  // The primary's Medicare enrollment age (contract v58, F6):
  // request-only, never persisted. In any work year at or
  // after this age the household is HSA-ineligible — no
  // employee or employer HSA contribution is made. Absent /
  // null = not enrolled during the work years (the household
  // stays HSA-eligible at every work-year age).
  medicareAgePrimary?: number | null;
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
  // The primary's Medicare enrollment age (contract v58, F6):
  // when set and this year's age is at or after it, the
  // household is HSA-ineligible for the year — the employee
  // HSA contribution is $0, the employer's HSA lands $0, and
  // the HSA bucket receives $0. Everything downstream follows
  // the stack's normal routing (taxable and FICA wages rise by
  // the freed HSA amount; the mega-backdoor room reads the
  // freed salary through its existing formula). Absent / null
  // = not enrolled this year.
  medicareAgePrimary?: number | null,
  // The priced year's deflation factor (deflationFactor of
  // the calendar year against the law row's year at the
  // plan's inflation rate), applied ONLY to the statute-fixed
  // HSA age-55 catch-up (contract v61, F3). The indexed base
  // limits stay as read from the row. Omitted = 1 (a year
  // pricing under its own law row, and every direct fixture
  // call, deflates zero steps).
  defl?: number,
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
  // The base limits are inflation-indexed and stay as read
  // from the row; the age-55 catch-up is statute-fixed at
  // $1,000 (§223(b)(3), not indexed), so it deflates into
  // today's dollars by the year's factor (contract v61, F3).
  const hsaLimit =
    (filingStatus === "mfj" ? law.hsaLimitFamily : law.hsaLimitSelf) / 100 +
    (age >= 55 ? (law.hsaCatchUp55 / 100) * (defl ?? 1) : 0);
  // HSA eligibility (contract v58, F6): Medicare enrollment
  // ends HSA eligibility, so a year at or after the primary's
  // Medicare enrollment age makes NO HSA contribution of
  // either source. (Eligibility turns on enrollment, not on
  // reaching 65 — a worker who lawfully delays Medicare stays
  // eligible; the input, not the age, is the switch.)
  const hsaEligible =
    !(medicareAgePrimary != null && age >= medicareAgePrimary);
  const employerHsaLanded = hsaEligible ? employerHsa : 0;
  const ownHsa = hsaEligible
    ? Math.max(
        0,
        Math.min(hsaLimit - employerHsa, salary - deferral - catchUp),
      )
    : 0;
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
  const hsaBucket = Math.min(hsaLimit, ownHsa + employerHsaLanded);
  return {
    deferral: r2(deferral),
    catchUp: r2(catchUp),
    catchUpIsRoth,
    mega: r2(mega),
    employer401k: r2(employerLanded),
    ownHsa: r2(ownHsa),
    employerHsa: r2(employerHsaLanded),
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
// The wage base and the rates are inflation-indexed / rate
// data and stay as read; the Additional Medicare threshold
// is statute-fixed (§3101(b)(2), not indexed), so it deflates
// into today's dollars by the caller's deflation factor
// (contract v61, F2; omitted = 1, a year pricing under its
// own law row deflates zero steps).
export function payrollTaxBreakdown(
  ficaWages: number,
  filingStatus: FilingStatus,
  law: YearLaw,
  defl = 1,
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
    Math.max(
      0,
      ficaWages - law.payrollAdditionalMedicareThreshold[filingStatus] * defl,
    );
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
  defl = 1,
): number {
  return payrollTaxBreakdown(ficaWages, filingStatus, law, defl).total;
}

/* ---------------- The taxable basis ledger (contract v58, F2) ----------------
   Basis DOLLARS carried alongside the Taxable balance through
   the roll, mirroring the retirement march's ledger semantics
   (taxEngine.ts: tier init, "highest-basis-ratio first" sale
   order, yield step-up): balances grow with the return and
   basis dollars do not; the year's yield steps basis up into
   unrealized gain; a positive surplus lands as 100%-basis
   cash; a deficit sale consumes basis in sale order. The
   march's helpers are not exported, so the two small ones the
   roll needs are reimplemented here on the roll's own ledger
   shape. A blank basis (taxableBasisBlank) keeps the march's
   posture: no tiers, and the rolled plan's basis fields are
   left exactly as entered — the march prices a blank-basis
   plan off its flat entered percentage, not off dollars. */

export type WorkTierLedger = { bal: number; basis: number };

export type TaxableLedger = {
  // Per-tier ledger when the plan carries basis tiers;
  // null = the single pool, whose basis dollars are `basis`.
  tiers: WorkTierLedger[] | null;
  // Total basis dollars (the single pool's basis, or the sum
  // over tiers). Invariant: 0 ≤ basis ≤ balance at every step.
  basis: number;
  // Index of the cash tier — the FIRST tier entered at a
  // 100% basis — or −1 when there is none. A positive surplus
  // lands there (see landSurplusInLedger).
  cashTierIndex: number;
};

function initTaxableLedger(plan: RothPlanInputs): TaxableLedger {
  const tiersActive =
    plan.taxableBasisBlank !== true &&
    Array.isArray(plan.taxableTiers) &&
    plan.taxableTiers.length > 0;
  if (tiersActive) {
    // The march's exact init: shares normalized to the whole
    // pool, per-tier basis = tier balance × its basis %.
    const rawTiers = plan.taxableTiers as { sharePct: number; basisPct: number }[];
    const shareTotal = rawTiers.reduce((s, t) => s + Math.max(0, t.sharePct), 0);
    let cashTierIndex = -1;
    const tiers = rawTiers.map((t, i) => {
      const share = shareTotal > 0 ? Math.max(0, t.sharePct) / shareTotal : 0;
      const bal = plan.taxableStart * share;
      const basisPct = Math.min(100, Math.max(0, t.basisPct));
      if (cashTierIndex < 0 && basisPct >= 100) cashTierIndex = i;
      return { bal, basis: bal * (basisPct / 100) };
    });
    return {
      tiers,
      basis: tiers.reduce((s, t) => s + t.basis, 0),
      cashTierIndex,
    };
  }
  const basisPct =
    Math.min(100, Math.max(0, plan.taxableBasisPct)) / 100;
  return { tiers: null, basis: basisPct * plan.taxableStart, cashTierIndex: -1 };
}

// The gain realized by selling `drawn` from a ledger whose
// balance (already grown for the year) is `grownBalance`,
// WITHOUT mutating the ledger — the F1 repricing iterations
// price candidate sales against the year's opening ledger
// before the roll consumes the settled sale for real.
// Single pool: the sale is pro-rata at the pool's ratio.
// Tiers: highest-basis-ratio first, each tier's sold slice
// realizing sold × (1 − tierBasis/tierBal).
function gainOnLedgerSale(
  ledger: TaxableLedger,
  grownBalance: number,
  drawn: number,
): number {
  const sold = Math.min(Math.max(0, drawn), Math.max(0, grownBalance));
  if (sold <= 0 || grownBalance <= 0) return 0;
  if (!ledger.tiers) {
    const basis = Math.min(Math.max(0, ledger.basis), grownBalance);
    return sold * (1 - basis / grownBalance);
  }
  const clone = ledger.tiers.map((t) => ({ ...t }));
  return sellFromLedgerTiers(clone, sold);
}

// Consume a settled sale of `drawn` from the ledger in place
// (the march's sale order) and return the gain realized —
// the same figure gainOnLedgerSale prices for the same sale.
// A fully drained balance carries basis $0.
function consumeLedgerSale(
  ledger: TaxableLedger,
  grownBalance: number,
  drawn: number,
): number {
  const sold = Math.min(Math.max(0, drawn), Math.max(0, grownBalance));
  if (sold <= 0) return 0;
  let gain: number;
  if (!ledger.tiers) {
    const basis = Math.min(Math.max(0, ledger.basis), grownBalance);
    gain = sold * (1 - basis / grownBalance);
    ledger.basis =
      sold >= grownBalance ? 0 : Math.max(0, ledger.basis - sold * (basis / grownBalance));
  } else {
    gain = sellFromLedgerTiers(ledger.tiers, sold);
    ledger.basis = ledger.tiers.reduce((s, t) => s + t.basis, 0);
    if (sold >= grownBalance) {
      for (const t of ledger.tiers) t.basis = 0;
      ledger.basis = 0;
    }
  }
  return gain;
}

// Sell `amount` from tier ledgers, highest current basis
// ratio first (the march's sellFromTiers "highest" order):
// within a tier the sale is pro-rata, so a tier's ratio never
// changes by selling from it. Returns the gains realized and
// mutates the tiers passed in.
function sellFromLedgerTiers(tiers: WorkTierLedger[], amount: number): number {
  if (amount <= 0) return 0;
  const ranked = tiers
    .map((t, i) => ({ i, ratio: t.bal > 0 ? t.basis / t.bal : null }))
    .filter((o): o is { i: number; ratio: number } => o.ratio != null)
    .sort((a, b) => b.ratio - a.ratio);
  let remaining = amount;
  let gains = 0;
  for (const { i } of ranked) {
    if (remaining <= 0) break;
    const t = tiers[i]!;
    const take = Math.min(remaining, t.bal);
    if (take <= 0) continue;
    const ratio = t.basis / t.bal;
    gains += take * (1 - ratio);
    t.basis = Math.max(0, t.basis - take * ratio);
    t.bal -= take;
    remaining -= take;
  }
  return gains;
}

// The yield step-up (the march's reinvestYieldIntoTiers /
// single-pool basisIn cap): the year's yield cash is already
// inside the balance (it is a component of the return), so no
// balance moves — basis rises by the yield, filling
// unrealized gain. Single pool: basis capped at the grown
// balance. Tiers: lowest-basis-ratio first, capped at each
// tier's own balance (the march's stepUpTiers).
function stepUpLedgerForYield(
  ledger: TaxableLedger,
  grownBalance: number,
  yieldTotal: number,
): void {
  if (yieldTotal <= 0) return;
  if (!ledger.tiers) {
    ledger.basis = Math.min(Math.max(0, grownBalance), ledger.basis + yieldTotal);
    return;
  }
  const ranked = ledger.tiers
    .map((t, i) => ({ i, ratio: t.bal > 0 ? t.basis / t.bal : 1 }))
    .sort((a, b) => a.ratio - b.ratio);
  let remaining = yieldTotal;
  for (const { i } of ranked) {
    if (remaining <= 0) break;
    const t = ledger.tiers[i]!;
    const room = Math.max(0, t.bal - t.basis);
    const add = Math.min(room, remaining);
    t.basis += add;
    remaining -= add;
  }
  ledger.basis = ledger.tiers.reduce((s, t) => s + t.basis, 0);
}

// Land a positive surplus — a real inflow of after-tax cash —
// in the ledger at 100% basis (F2). The caller moves the
// balance; this moves basis dollars (and, on the tiers path,
// the tier balances with them). TIER CHOICE: the surplus
// lands in the cash tier (the first 100%-basis tier) when one
// exists — new savings are cash-like, and the march likewise
// keeps after-tax inflows in one identified lot. With no cash
// tier it lands pro-rata by tier balance, each landed dollar
// carrying 100% basis; with every tier at $0 it lands in the
// first tier. Totals stay exact and 0 ≤ basis ≤ bal per tier.
function landSurplusInLedger(
  ledger: TaxableLedger,
  grownBalance: number,
  surplus: number,
): void {
  if (surplus <= 0) return;
  if (!ledger.tiers) {
    ledger.basis += surplus;
    return;
  }
  const tiers = ledger.tiers;
  if (ledger.cashTierIndex >= 0 && tiers[ledger.cashTierIndex]) {
    const t = tiers[ledger.cashTierIndex]!;
    t.bal += surplus;
    t.basis += surplus;
  } else if (grownBalance > 0) {
    let landed = 0;
    tiers.forEach((t, i) => {
      const share =
        i === tiers.length - 1
          ? surplus - landed
          : (surplus * Math.max(0, t.bal)) / grownBalance;
      t.bal += share;
      t.basis += share;
      landed += share;
    });
  } else if (tiers[0]) {
    tiers[0].bal += surplus;
    tiers[0].basis += surplus;
  }
  ledger.basis = tiers.reduce((s, t) => s + t.basis, 0);
}

// The rolled plan's basis fields rebuilt from ledger dollars
// (F2): tiers are re-expressed as shares of the final balance
// (normalized to sum to exactly 100 when the balance is
// positive — the last tier absorbs the rounding dust) with
// each tier's basis % read off its own dollars; the single
// pool's basis % is its dollars over its balance. A drained
// pool keeps the plan's entered figures (there is nothing to
// re-express, and a $0 balance prices no gains either way).
// A blank-basis plan is returned untouched (see the section
// note above).
function rebuildRolledBasisFields(
  plan: RothPlanInputs,
  ledger: TaxableLedger,
  finalBalance: number,
): Pick<RothPlanInputs, "taxableBasisPct" | "taxableTiers"> {
  if (plan.taxableBasisBlank === true) {
    return { taxableBasisPct: plan.taxableBasisPct, taxableTiers: plan.taxableTiers };
  }
  if (ledger.tiers) {
    const totalBasis = ledger.tiers.reduce((s, t) => s + t.basis, 0);
    if (finalBalance <= 0) {
      return { taxableBasisPct: plan.taxableBasisPct, taxableTiers: plan.taxableTiers };
    }
    let shareSoFar = 0;
    const tiers = ledger.tiers.map((t, i) => {
      const sharePct =
        i === ledger.tiers!.length - 1
          ? 100 - shareSoFar
          : (100 * Math.max(0, t.bal)) / finalBalance;
      shareSoFar += sharePct;
      return {
        sharePct,
        basisPct: t.bal > 0 ? (100 * t.basis) / t.bal : 100,
      };
    });
    return {
      taxableBasisPct: (100 * totalBasis) / finalBalance,
      taxableTiers: tiers,
    };
  }
  return {
    taxableBasisPct:
      finalBalance > 0 ? (100 * ledger.basis) / finalBalance : plan.taxableBasisPct,
    taxableTiers: plan.taxableTiers,
  };
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
  // The year's taxable interest income (contract v58, F3):
  // the plan's interest yield % × the Taxable balance the
  // year opens with, priced as ordinary income through the
  // shared priceYear (the march's yield split).
  interestIncome: number;
  // The year's taxable dividend income (F3): the plan's
  // dividend yield % × the opening balance, priced as
  // qualified dividends (the march's split: the whole
  // dividend yield rides as qualifiedDividends).
  dividendIncome: number;
  // Social Security benefits collected this year (F4): the
  // household benefits whose start age has been reached,
  // priced through priceYear's §86 taxation and deposited
  // into the year's surplus as household cash. $0 when no
  // benefit has started.
  ssBenefits: number;
  // Required minimum distributions priced this year
  // (contract v98, F5): each owner's own RMD, computed by
  // the shared rmdForYear helper on that owner's
  // prior-Dec-31 pre-tax balance (the balance the year
  // opens with — this year's contributions never count
  // toward it), on that owner's own RMD clock, with that
  // owner's table selected by that owner's own beneficiary
  // fact exactly as the plan march selects it. `rmd` is the
  // household total the shared priceYear prices as ordinary
  // income; the distributed cash is in the year's surplus
  // (see below) and the roll takes each owner's amount out
  // of that owner's pre-tax balance before growth. All $0
  // (divisors and tables null) in a year before either
  // owner's RMD age. No still-working exception is priced:
  // the balances carry no 401(k)/IRA distinction (see the
  // model note at the top of this file).
  rmd: number;
  rmdPrimary: number;
  rmdSpouse: number;
  rmdDivisorPrimary: number | null;
  rmdDivisorSpouse: number | null;
  rmdTablePrimary: "joint" | "uniform" | null;
  rmdTableSpouse: "joint" | "uniform" | null;
  // The long-term capital gain realized by this year's
  // deficit-funding Taxable sale (F1): priced into the year
  // only when the roll supplies the taxable context and the
  // year's settlement draws from Taxable; a standalone price
  // (no balance context) realizes no sale and reports $0.
  ltcg: number;
  // Salary − federal − state − FICA − the plan's annual
  // spending − the employee's own contributions (deferral +
  // catch-up + mega + own HSA) + the year's Social Security
  // benefits + the year's RMDs (F5: the distribution is
  // household cash on the same footing as the benefits —
  // it funds the year's spending and taxes and any leftover
  // banks into Taxable, exactly the plan march's surplus
  // sweep). The year's refundable §25A credit is NOT in
  // this figure: it is carried undeposited and lands in
  // Taxable at the start of the next simulated year (see
  // rollWorkYears), so it can neither fund this year's
  // deficit nor bank at this year's end. Banked into
  // Taxable at year end.
  surplus: number;
  // The year's refundable §25A education credit, from the
  // shared priceYear result: the portion of the year's
  // credit that arrives as cash when the year's return is
  // filed the next spring. Reported here so the roll can
  // carry it into the next year's opening Taxable pool
  // (or, in the roll's last year, into the quit-age
  // balance); never netted into the surplus above.
  educationRefundable: number;
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

// The roll's per-year taxable context (contract v58, F1/F3):
// the Taxable balance the year opens with (the balance
// carried into the year, before this year's growth — the
// base the year's yields price on), the balance after this
// year's growth (the balance a deficit sale draws from), and
// the basis ledger in its grown state (balances grown, basis
// dollars unmoved, the year's yield step-up applied). Absent
// (a standalone price) the year prices its yields on
// plan.taxableStart as the opening balance and realizes no
// sale — there is no balance to draw from.
export type WorkYearTaxableContext = {
  openingBalance: number;
  grownBalance: number;
  ledger: TaxableLedger;
};

// The roll's per-year pre-tax context (contract v98, F5):
// each owner's pre-tax balance the year opens with — the
// prior Dec-31 balance that owner's RMD prices on. The roll
// threads the balances it carries into the year (the prior
// year-end balances: grown, net of that year's distribution,
// plus that year's landed contributions), so a contribution
// made DURING a year lands after that year's RMD is priced
// and counts only toward the NEXT year's RMD, exactly as
// the plan march's year-opening balances do. Absent (a
// standalone price) the year prices its RMDs on the plan's
// starting balances — plan.pretaxStart / pretaxSpouseStart
// are the year's opening balances by construction, the same
// convention the taxable context's opening balance follows.
export type WorkYearPretaxContext = {
  priorPrimary: number;
  priorSpouse: number;
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
  // The roll's taxable context for this year (F1/F3); omitted
  // for a standalone price.
  taxableCtx?: WorkYearTaxableContext | null,
  // The roll's pre-tax context for this year (F5): each
  // owner's prior-Dec-31 balance, the base that owner's RMD
  // prices on; omitted for a standalone price, which reads
  // the plan's starting balances as its opening balances.
  pretaxCtx?: WorkYearPretaxContext | null,
): WorkYearLine {
  const calendarYear = plan.birthYearPrimary + age;
  const law = lawForYear(calendarYear);
  // Today's-dollars deflation for this priced year (contract
  // v61, F2/F3): the plan's inflationPct against the law
  // row's year — 1.0 for a year with its own row. Only the
  // statute-fixed amounts deflate (the §3101(b)(2) Additional
  // Medicare threshold in the payroll below, the §223(b)(3)
  // HSA age-55 catch-up inside the stack); every indexed
  // amount (wage base, base HSA limits, deferral limits) is
  // read from the row unchanged.
  const defl = deflationFactor(calendarYear, law.year, plan.inflationPct);
  const stack = contributionStack(
    age,
    job.salary,
    job.employer401k,
    job.employerHsa,
    plan.filingStatus,
    law,
    priorYearWages,
    job.medicareAgePrimary ?? null,
    defl,
  );
  const catchUpPreTax = stack.catchUpIsRoth ? 0 : stack.catchUp;
  const taxableWages = r2(
    job.salary - stack.deferral - catchUpPreTax - stack.ownHsa,
  );
  const ageSpouse =
    plan.birthYearSpouse != null ? calendarYear - plan.birthYearSpouse : null;
  // REQUIRED MINIMUM DISTRIBUTIONS (contract v98, F5):
  // priced exactly as the plan march prices them — per
  // owner, through the SHARED rmdForYear helper (its RMD-age
  // mapping and divisor tables are the only ones; nothing is
  // re-derived here), each on that owner's prior-Dec-31
  // balance: the balance the year opens with, supplied by
  // the roll from the balances it carries in (a standalone
  // price reads the plan's starting balances, its opening
  // balances by construction). This year's contributions
  // land at year end, after this pricing, so they never
  // count toward this year's RMD. Table selection is the
  // march's, per owner: the primary's RMD runs on
  // spouseSoleBeneficiary, the spouse's on
  // primarySoleBeneficiaryOfSpouse with the roles swapped —
  // the two facts are separate and neither is read for the
  // other owner. DIVISOR-SELECTION FALLBACK: none is needed
  // beyond the helper's own rule — the work-years path
  // carries every input the march's selection reads (both
  // birth years, both beneficiary facts) on the same plan
  // inputs, and where a fact is absent (the spouse's fact is
  // optional on the inputs) the march's own rule applies
  // inside the helper: only an explicit true selects the
  // Joint table, anything else prices the Uniform table; a
  // missing spouse birth year prices no spouse RMD at all.
  // No still-working exception is priced (see the model
  // note): the balances carry no 401(k)/IRA distinction.
  const priorPretaxPrimary = pretaxCtx?.priorPrimary ?? plan.pretaxStart;
  const priorPretaxSpouse =
    pretaxCtx?.priorSpouse ?? (plan.pretaxSpouseStart ?? 0);
  const rmdPrimaryRes = rmdForYear({
    priorDec31PreTax: priorPretaxPrimary,
    agePrimary: age,
    ageSpouse,
    birthYearPrimary: plan.birthYearPrimary,
    spouseSoleBeneficiary: plan.spouseSoleBeneficiary,
  });
  const rmdSpouseRes =
    ageSpouse != null && plan.birthYearSpouse != null
      ? rmdForYear({
          priorDec31PreTax: priorPretaxSpouse,
          agePrimary: ageSpouse,
          ageSpouse: age,
          birthYearPrimary: plan.birthYearSpouse,
          spouseSoleBeneficiary:
            plan.primarySoleBeneficiaryOfSpouse === true,
        })
      : { rmd: 0, divisor: null, table: null };
  const rmdTotal = r2(rmdPrimaryRes.rmd + rmdSpouseRes.rmd);
  // TAXABLE YIELDS (contract v58, F3): priced exactly as the
  // retirement march prices them — interest and dividend
  // income on the balance the year OPENS with (in the roll,
  // the prior year-end balance; standalone, plan.taxableStart
  // is the year's opening balance by construction). Fixed for
  // the year: computed once here and held constant across the
  // F1 repricing iterations below.
  const openingBalance = taxableCtx?.openingBalance ?? plan.taxableStart;
  const interestIncome = r2(
    (Math.max(0, openingBalance) * Math.max(0, plan.taxableInterestYieldPct ?? 0)) / 100,
  );
  const dividendIncome = r2(
    (Math.max(0, openingBalance) * Math.max(0, plan.taxableDividendYieldPct ?? 0)) / 100,
  );
  // SOCIAL SECURITY ALREADY STARTED (contract v58, F4): the
  // year's household benefits from the plan's own fields,
  // mirroring the march's collection test — each benefit
  // counts once its own start age is reached (the primary's
  // against the primary's age, the spouse's against the
  // spouse's age that year), $0 for a side declared to have
  // no benefit. The sum prices through priceYear's §86
  // taxation and deposits into the surplus below. The
  // pre-full-retirement-age earnings test is NOT modeled
  // (no machinery for it exists anywhere in the engine), so
  // benefits deposit in full.
  const ssPrimaryThisYear =
    plan.ssPrimaryStartAge != null && age >= plan.ssPrimaryStartAge
      ? plan.ssPrimaryNoBenefit
        ? 0
        : plan.ssPrimaryAnnual
      : 0;
  const ssSpouseThisYear =
    plan.ssSpouseStartAge != null &&
    ageSpouse != null &&
    ageSpouse >= plan.ssSpouseStartAge
      ? plan.ssSpouseNoBenefit
        ? 0
        : plan.ssSpouseAnnual
      : 0;
  const ssBenefits = r2(ssPrimaryThisYear + ssSpouseThisYear);
  const priceWithGain = (ltcg: number) =>
    priceYear({
    calendarYear,
    filingStatus: plan.filingStatus,
    agePrimary: age,
    ageSpouse,
    otherOrdinary: Math.max(0, taxableWages),
    // The year's RMDs (F5): ordinary income inside the
    // shared price, exactly the march's treatment — the
    // distribution is priced here, its cash joins the
    // surplus below, and the roll takes it out of the
    // pre-tax balances.
    rmd: rmdTotal,
    conversion: 0,
    extraPreTaxDraw: 0,
    ssBenefits,
    taxExemptInterest: 0,
    ltcg,
    interestIncome,
    qualifiedDividends: dividendIncome,
    inflationPct: plan.inflationPct,
    stateRatePct: plan.stateRatePct,
    // A work year realizes capital gains only on a
    // deficit-funding Taxable sale (F1: the ltcg settled
    // below); a Washington residence prices its excise on
    // that gain through this same residenceState path.
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
    // NOT added to the surplus below (contract v96): like
    // the retirement march (Build D), the roll carries it
    // undeposited and deposits it in Taxable at the start
    // of the next simulated year — the year's return is
    // filed the next spring — so the same-year surplus
    // must not bank cash the household has not received,
    // and a deficit year must not fund itself from it.
    educationStudents: (plan.educationStudents ?? []).filter(
      (e) => e.year === calendarYear,
    ),
    });
  const ficaWages = r2(job.salary - stack.ownHsa);
  const payroll = payrollTaxBreakdown(
    Math.max(0, ficaWages),
    plan.filingStatus,
    law,
    defl,
  );
  const fica = payroll.total;
  const ownContributions =
    stack.deferral + stack.catchUp + stack.mega + stack.ownHsa;
  const surplusOf = (p: ReturnType<typeof priceYear>): number =>
    r2(
      job.salary -
        p.federalTax -
        p.stateTax -
        fica -
        plan.annualSpending -
        ownContributions +
        // The year's Social Security benefits (F4): household
        // cash, banked into Taxable like any surplus. The
        // refundable §25A credit (p.educationRefundable) is
        // deliberately NOT added here (contract v96): it is
        // next spring's cash, carried by the roll and
        // deposited at the start of the next simulated year.
        ssBenefits +
        // The year's RMDs (F5): the distribution is household
        // cash on the same footing as the benefits above —
        // the plan march counts it in the year's cash income
        // that covers spending first and whose leftover sweeps
        // into Taxable; here it is one term of the same net
        // surplus figure, so it funds this year's deficit
        // settlement exactly as the march's cash does.
        rmdTotal,
    );
  // DEFICIT-FUNDING SALE SETTLEMENT (contract v58, F1): price
  // the year first with no sale (ltcg $0). When the roll
  // supplies the taxable context and that price runs a
  // deficit, the deficit is funded by selling Taxable, and
  // the sale realizes gains off the basis ledger — which
  // raises the year's tax, which deepens the deficit. Iterate
  // to the fixed point the way the retirement march's
  // settlement converges: drawn from the priced deficit, gain
  // realized on the drawn amount (capped at the grown
  // balance), reprice with that gain, until the drawn amount
  // and the priced gain agree to the cent (bounded; then
  // settle on the last pricing). The final line's taxes,
  // MAGI, and surplus all come from the FINAL converged
  // pricing. When the grown balance cannot cover the
  // converged deficit, the drawn amount is the whole grown
  // balance, the gain is priced on that full sale, and the
  // roll reports the unfunded remainder as the shortfall.
  let priced = priceWithGain(0);
  let surplus = surplusOf(priced);
  let ltcg = 0;
  if (taxableCtx && surplus < 0) {
    let drawn = -surplus;
    for (let i = 0; i < 100; i++) {
      const gain = gainOnLedgerSale(
        taxableCtx.ledger,
        taxableCtx.grownBalance,
        drawn,
      );
      const repriced = priceWithGain(gain);
      const s2 = surplusOf(repriced);
      const drawn2 = s2 < 0 ? -s2 : 0;
      const gainImplied = gainOnLedgerSale(
        taxableCtx.ledger,
        taxableCtx.grownBalance,
        drawn2,
      );
      priced = repriced;
      surplus = s2;
      ltcg = gain;
      if (
        Math.abs(drawn2 - drawn) < 0.005 &&
        Math.abs(gainImplied - gain) < 0.005
      ) {
        break;
      }
      drawn = drawn2;
      if (drawn <= 0) break;
    }
  }
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
    interestIncome,
    dividendIncome,
    ssBenefits,
    rmd: rmdTotal,
    rmdPrimary: rmdPrimaryRes.rmd,
    rmdSpouse: rmdSpouseRes.rmd,
    rmdDivisorPrimary: rmdPrimaryRes.divisor,
    rmdDivisorSpouse: rmdSpouseRes.divisor,
    rmdTablePrimary: rmdPrimaryRes.table,
    rmdTableSpouse: rmdSpouseRes.table,
    ltcg: r2(ltcg),
    surplus,
    // The year's refundable §25A credit, carried by the roll
    // (contract v96) — never part of the surplus above.
    educationRefundable: priced.educationRefundable,
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
  // year reduces it only down to a $0 balance — see shortfall),
  // plus every refundable §25A deposit the roll landed
  // (contract v96: start-of-year deposits and the
  // horizon-end deposit). Equals the plain sum of the yearly
  // surpluses plus the landed refunds whenever no year ran
  // a shortfall.
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
  // growth + year-end contributions, plus any horizon-end
  // education refund deposit (contract v96).
  balances: {
    pretax: number; // primary + spouse combined
    pretaxPrimary: number;
    pretaxSpouse: number;
    roth: number;
    taxable: number;
    // The Taxable balance's basis dollars at the quit age
    // (contract v58, F2) — the dollars the rolled plan's
    // basis fields are rebuilt from. Exposed for fixture
    // pinning; the action response shape does not carry it.
    taxableBasis: number;
    hsa: number;
  };
  // The plan inputs the optimizer prices for this quit age:
  // when there are no work years, the plan with its retirement
  // age and window-start age set to the quit age (F5a) and
  // every balance untouched; otherwise the same plan with its
  // start / retirement / window-start ages set to the quit
  // age, its balances replaced by the rolled balances, and
  // its taxable basis fields rebuilt from the rolled basis
  // dollars (F2).
  rolledInputs: RothPlanInputs;
};

export function rollWorkYears(
  plan: RothPlanInputs,
  job: WorkYearJob,
  quitAge: number,
): WorkYearRoll {
  // NEVER PRICE A PAST YEAR (contract v58, F5b): the roll's
  // first year is the later of the plan's window-start age
  // and the plan's CURRENT age — the ageNow derivation used
  // across actions.ts (startYear − birth year). A window
  // start below the current age would otherwise price
  // already-past salary years on top of today's balances.
  const currentAge = plan.startYear - plan.birthYearPrimary;
  const effectiveStart = Math.max(plan.windowStartAge, currentAge);
  const count =
    job.salary > 0 ? Math.max(0, Math.floor(quitAge) - effectiveStart) : 0;
  const startLedger = initTaxableLedger(plan);
  const startBalances = {
    pretax: r2(plan.pretaxStart + (plan.pretaxSpouseStart ?? 0)),
    pretaxPrimary: plan.pretaxStart,
    pretaxSpouse: plan.pretaxSpouseStart ?? 0,
    roth: plan.rothStart,
    taxable: plan.taxableStart,
    taxableBasis: r2(startLedger.basis),
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
      // ZERO-YEAR HANDOFF (contract v58, F5a): the row prices
      // retiring AT the quit age, so the rolled inputs carry
      // the quit age as both the retirement age and the
      // window-start age — not the plan's saved retirement
      // age. Balances and every other input are the plan's
      // own, exactly as before. No pending refundable credit
      // arises here to carry anywhere: no work year is
      // priced, so no work-year credit is earned; the
      // rolled march prices education credits for its own
      // years (from the quit age on) through its own
      // pending-refund carry, and nothing is threaded
      // through it from the roll.
      rolledInputs: {
        ...plan,
        retirementAge: Math.floor(quitAge),
        windowStartAge: Math.floor(quitAge),
      },
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
  // The taxable basis ledger (F2), carried in dollars beside
  // the balance through every rolled year.
  const ledger = initTaxableLedger(plan);
  // PENDING EDUCATION REFUND (contract v96): the refundable
  // §25A credit the previous work year priced, carried here
  // undeposited — the plan march's pendingEduRefund shape.
  // It lands in the taxable pool at the start of the next
  // simulated year (the deposit block at the top of the
  // loop), and whatever is still pending after the last
  // work year lands in the quit-age balance instead (the
  // horizon-end deposit after the loop), so a refund is
  // never dropped. eduRefundsDeposited is the total the
  // roll actually landed, counted into surplusBanked so
  // the totals still name every dollar that reached
  // Taxable.
  let pendingEduRefund = 0;
  let eduRefundsDeposited = 0;
  for (let i = 0; i < count; i++) {
    const age = effectiveStart + i;
    // EDUCATION REFUND DEPOSIT (contract v96, Build D
    // timing): last year's refundable credit lands in the
    // taxable pool at the START of this year — the prior
    // year's return is filed this spring — before this
    // year's yields, growth, and settlement run, at 100%
    // basis, so it funds this year's spending and taxes
    // and grows with the pool exactly as the march's
    // start-of-year deposit does. The ledger landing runs
    // before the tier balances grow below, so the deposit
    // grows with the pool too; the pro-rata denominator is
    // the pre-deposit opening balance, the balance the
    // tier ledgers currently sum to.
    if (pendingEduRefund > 0) {
      landSurplusInLedger(ledger, taxable, pendingEduRefund);
      taxable += pendingEduRefund;
      eduRefundsDeposited += pendingEduRefund;
      pendingEduRefund = 0;
    }
    // TAXABLE LEDGER for the year (F1/F2/F3): the year opens
    // with the balance carried in (the base the year's yields
    // price on); the balance then grows at the plan's return
    // while basis dollars do not move; the year's yield steps
    // basis up into the grown balance's unrealized gain. The
    // yield total is computed here on the opening balance
    // with the same formula priceOneWorkYear prices it with,
    // so the ledger and the priced year agree.
    const openingTaxable = taxable;
    const yieldTotal =
      r2(
        (Math.max(0, openingTaxable) *
          Math.max(0, plan.taxableInterestYieldPct ?? 0)) /
          100,
      ) +
      r2(
        (Math.max(0, openingTaxable) *
          Math.max(0, plan.taxableDividendYieldPct ?? 0)) /
          100,
      );
    const grownTaxable = openingTaxable * growth;
    if (ledger.tiers) {
      for (const t of ledger.tiers) t.bal *= growth;
    }
    stepUpLedgerForYield(ledger, grownTaxable, yieldTotal);
    const pricedLine = priceOneWorkYear(
      plan,
      job,
      age,
      priorYearWages,
      {
        openingBalance: openingTaxable,
        grownBalance: grownTaxable,
        ledger,
      },
      // The prior-Dec-31 pre-tax balances (F5): the balances
      // carried into this year — the loop variables still
      // hold the prior year-end figures at this point (this
      // year's growth and contributions land below, after
      // the pricing), so each owner's RMD prices on exactly
      // the balance the plan march would read for the year.
      { priorPrimary: pretaxPrimary, priorSpouse: pretaxSpouse },
    );
    priorYearWages = pricedLine.ficaWages;
    // This year's refundable credit becomes next year's
    // deposit (contract v96): carried undeposited until
    // the start of the next simulated year. It is assigned
    // here, after the year's pricing has converged, so the
    // deficit settlement above never funds itself from
    // cash that arrives next spring.
    pendingEduRefund = r2(pricedLine.educationRefundable);
    const s = pricedLine.stack;
    const catchUpPreTax = s.catchUpIsRoth ? 0 : s.catchUp;
    const catchUpRoth = s.catchUpIsRoth ? s.catchUp : 0;
    const pretaxIn = s.deferral + catchUpPreTax + s.employer401k;
    const rothIn = catchUpRoth + s.mega;
    // The year's RMD leaves its owner's balance first (F5 —
    // the march's order: the distribution is taken from the
    // prior-Dec-31 balance, and the post-distribution balance
    // is what grows), then grow, then land the year-end
    // contributions — the contributions earn no growth in
    // the year they are made, and they count toward the NEXT
    // year's RMD, never this year's.
    pretaxPrimary =
      Math.max(0, pretaxPrimary - pricedLine.rmdPrimary) * growth + pretaxIn;
    pretaxSpouse =
      Math.max(0, pretaxSpouse - pricedLine.rmdSpouse) * growth;
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
    // The deficit is a SALE (F1): priceOneWorkYear already
    // priced the gain on the drawn amount into the year's
    // taxes (its surplus is the converged figure), and the
    // sale consumes basis here in the same order it was
    // priced. A positive surplus lands as 100%-basis cash.
    const rawTaxable = grownTaxable + pricedLine.surplus;
    const shortfall = rawTaxable < 0 ? r2(-rawTaxable) : 0;
    if (pricedLine.surplus >= 0) {
      landSurplusInLedger(ledger, grownTaxable, pricedLine.surplus);
    } else {
      consumeLedgerSale(ledger, grownTaxable, -pricedLine.surplus);
    }
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
  // HORIZON-END EDUCATION REFUND (contract v96): a
  // refundable credit earned in the roll's LAST work year
  // has no following work year inside the roll, so — like
  // the plan march's final-year exception — it is added
  // to the quit-age taxable balance directly, after the
  // final year's growth, as the undeposited dollars
  // themselves (the return is filed after the roll ends).
  // It lands at 100% basis and flows into the rolled
  // plan's opening taxable balance and rebuilt basis
  // fields below, so the retirement march prices on it
  // from its first year; it is never dropped and never
  // deposited twice (the loop's deposit block consumed
  // every earlier year's credit at the next year's start).
  if (pendingEduRefund > 0) {
    landSurplusInLedger(ledger, taxable, pendingEduRefund);
    taxable += pendingEduRefund;
    eduRefundsDeposited += pendingEduRefund;
    pendingEduRefund = 0;
  }
  // Refund deposits that actually landed in Taxable —
  // start-of-year deposits plus the horizon-end deposit —
  // count into surplusBanked, so the totals name every
  // dollar the surplus-and-refund stream landed.
  totals.surplusBanked += eduRefundsDeposited;
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
    taxableBasis: r2(ledger.basis),
    hsa: r2(hsa),
  };
  // BASIS REBUILD (contract v58, F2): the rolled plan's basis
  // fields are re-expressed from the ledger dollars the roll
  // actually carried, so the march's own ledger initializes
  // from the true basis — not from the entered percentage
  // applied to a balance that has since grown, banked
  // surpluses, and sold shares.
  const basisFields = rebuildRolledBasisFields(plan, ledger, balances.taxable);
  const rolledInputs: RothPlanInputs = {
    ...plan,
    taxableBasisPct: basisFields.taxableBasisPct,
    taxableTiers: basisFields.taxableTiers,
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
  // Identical effective plans price the optimizer once and
  // share the result. Rolled rows key on their quit age and
  // balances; ZERO-year rows key on the quit age itself
  // (contract v58, F5a): a zero-year row's rolled inputs carry
  // its own quit age as the retirement age, so two zero-year
  // rows at different quit ages are different plans and must
  // not share one optimizer run.
  const cache = new Map<string, { roll: WorkYearRoll; optimizer: JointOptimizerResult }>();
  return quitAges.map((quitAge) => {
    const roll = rollWorkYears(plan, job, quitAge);
    const key =
      roll.totals.years === 0
        ? `no-work:${quitAge}`
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
