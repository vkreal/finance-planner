// Roth Conversion Lifetime-Tax Optimizer (Option 2) — the solver
// layer on top of the shared tax engine (server/src/taxEngine.ts).
// Pure functions only, shared by the runRothOptimizer server
// action, the Roth Conversion view (client, via "@space/server/*"),
// and the accuracy fixtures (server/src/taxFixtures.ts), so the
// numbers the fixtures pin are computed by the exact code the
// user sees.
//
// OBJECTIVE (stated in plain language on screen): minimize the
// lifetime net cost, in today's dollars, of
//   lifetime federal + state tax (plus any pre-59½ withholding
//   penalty the plan prices)
//   + lifetime Medicare IRMAA surcharges paid
//   − lifetime ACA premium credit kept
//   + a terminal tax on the pre-tax balance still standing at
//     the plan's end age, priced at the heir-rate input.
// The terminal term is required: without it the solver
// under-converts, because pre-tax money it "saves" the household
// from converting is still taxed eventually — by the owner via
// late RMDs or by heirs under the SECURE Act 10-year rule.
//
// SEARCH: exhaustive scan, deliberately NO binary search over
// the ceiling. Lifetime cost is non-monotone in the ceiling (the
// lesson the Retirement calc's Max Spending solver taught), so
// every candidate is a full lifetime simulation through the
// standard engine with the standard fill mechanics, and the best
// score wins. Candidates are level-ceiling strategies — "each
// year in the window, convert up to ceiling C" — across:
//   · ceilings: every federal bracket top, every IRMAA tier line,
//     the ACA 400% FPL cliff, bracket × IRMAA combinations, and
//     intermediate MAGI-cap steps between those lines;
//   · window variants: stop at 65 / stop the year before RMDs
//     begin / keep converting through the RMD years (topping up
//     around the RMD);
//   · the marginal-rate guardrail variant (for bracket ceilings):
//     stop a year's fill at the first $100 step whose effective
//     marginal rate would exceed the strategy's own bracket rate;
//   · the ACA bunching variant (for non-cliff ceilings): in ACA
//     years, alternate a big conversion year with a $0 year;
//   · the gain-harvesting variant (build v56): when the
//     plan holds a taxable balance with basis below 100%
//     (harvestGatePasses), EVERY conversion candidate above
//     also gets a gainsHarvest twin; when the gate fails no
//     twins are generated and the candidate space is exactly
//     as before. There is deliberately no separate
//     ltcgZeroCap ceiling candidate family.
// Do Nothing is always in the candidate set, so the winner can
// never score worse than doing nothing on this objective.
//
// DRAW ORDER: the fixed-age run (runOptimizer) also searches
// the discretionary spending draw order — all six orderings of
// Taxable / Pre-tax / Roth — as a full strategy dimension:
// every strategy above is priced under every order. Do Nothing
// stays at the plan's own order (it is the "change nothing"
// benchmark), and exact ties break toward the plan's order, so
// a different order is only ever recommended when it prices
// strictly lower. The joint claiming-age search does NOT vary
// the order: every combination keeps the plan's current order,
// and its result note says so.

import {
ALL_DRAW_ORDERS,
DEFAULT_DRAW_ORDER,
NO_CEILINGS,
acaCreditFor,
acaEmbeddedNetPremiumFor,
acaFirstStepYear,
acaHouseholdSizeForYear,
ceilingsActive,
debitRothOwnerLedger,
drawOrderFromKey,
drawOrderKey,
drawOrderLabel,
effectiveSsPrimaryAnnual,
effectiveSsSpouseAnnual,
fillConversion,
initRothAccountLedger,
irmaaAnnualPerPerson,
priceYear,
resolveAcaHouseholdSchedule,
rmdForYear,
settleFirstRmdDeferral,
simulateRothPlan,
splitRothBasisAcrossAccounts,
survivorBenefitAnnualEnhanced,
type AcaHouseholdStep,
type DrawOrder,
type EducationStudent,
type FilingStatus,
type FillCeilings,
type FirstRmdDeferralState,
type PriceYearInput,
type RothConversionLotInput,
type RothConversionLotSaved,
type RothOwnerLedger,
type RothPlanInputs,
type RothPlanResult,
type RothStrategy,
type RothYear,
type TaxableTier,
} from "./taxEngine";
import {
CURRENT_LAW,
FPL_GUIDELINES,
fplFor,
fullRetirementAgeMonths,
lawForYear,
rmdAgeForBirthYear,
ssAnnualAtClaimAge,
ssBenefitFactor,
} from "./taxLaw";
// Social Security claiming law lives in taxLaw.ts (Engine
// Review 5) and is re-exported here so the import sites that
// read it from this module — fixtures, hardening, the
// optimizer's own claiming-age search — keep working unchanged.
// The import above (not a bare `export ... from`) is what puts
// the names in this module's own scope: the optimizer's search
// calls ssAnnualAtClaimAge directly.
export { fullRetirementAgeMonths, ssAnnualAtClaimAge, ssBenefitFactor };
import { irmaaTierFor, irmaaTierUpTo } from "./taxEngine";
import { applyLossLedger } from "./lossLedger";
import {
  impliedYieldPctsFromTaxReturn,
  type RothTaxReturnStored,
} from "./taxReturnCore";
import { DEFAULT_HEIR_RATE_PCT } from "./rothDefaults";
import {
  blendedExpected,
  medianOf as sharedMedianOf,
  mulberry32 as sharedMulberry32,
  normalRandom as sharedNormalRandom,
  percentile as sharedPercentile,
  STOCKS_PCT_DEFAULT,
  validateMonteCarloSeed,
} from "./retirementEngines";
import { claimAgeLabel, type ClaimAgeInfo } from "./claimAge";
// The claiming-age label lives in claimAge.ts (Engine Review
// C1, NICE-3) and is re-exported here so the import sites that
// read it from this module — the gift action, the fixtures —
// keep working unchanged. The import above (not a bare
// `export ... from`) is what puts the type in this module's own
// scope: the optimizer's claiming-age search annotates with
// ClaimAgeInfo directly.
export { claimAgeLabel, type ClaimAgeInfo };

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* ---------------- Social Security claiming ages ----------------
   The entered benefit is the ANCHOR: the yearly amount the user
   entered, at the start age they entered. Any other claiming age
   is priced from the primary insurance amount (PIA) the anchor
   implies, using the statutory adjustments against the person's
   own full retirement age (FRA) from their birth year — the
   functions themselves live in taxLaw.ts (Engine Review 5:
   pure law, so taxEngine can price survivor rules from them
   without an import cycle) and are re-exported here, so every
   existing import site and every figure is unchanged. */

export function enteredClaimInfo(inputs: RothPlanInputs): ClaimAgeInfo {
  return {
    primaryAge: inputs.ssPrimaryStartAge,
    spouseAge: inputs.ssSpouseStartAge,
    primaryAnnual: effectiveSsPrimaryAnnual(inputs),
    spouseAnnual: effectiveSsSpouseAnnual(inputs),
    searchedPrimary: false,
    searchedSpouse: false,
  };
}

/* ---------------- Objective ---------------- */

export type NetCostBreakdown = {
  // Lifetime federal + state income tax.
  tax: number;
  // Lifetime pre-59½ penalties on tax withheld from conversions.
  penalty: number;
  // Lifetime IRMAA surcharges paid.
  irmaa: number;
  // Lifetime ACA premium credit kept (subtracted).
  acaCredit: number;
  // Lifetime health premiums (build v208): the GROSS
  // premium the plan's health premium term charges (added
  // — beside the credit above, which it offsets, so the
  // identity's net premium effect is healthPremiumNet) and
  // that NET figure itself (gross less the years' priced
  // credits as funded; display). The credit above is each
  // year's credit KEPT — capped at that year's entered
  // marketplace premium in the engine (R3-M2), so the
  // identity's premium-minus-credit is the net premium and
  // never a benefit beyond the premium paid. Both $0 for
  // any plan that does not enter the term, and the identity
  // then reduces to the pre-v208 formula bit for bit —
  // including its known pre-v208 treatment of the credit.
  healthPremium: number;
  healthPremiumNet: number;
  // Lifetime refundable education credit (subtracted; T6):
  // the sum of the years' refundable American Opportunity
  // Credit portions. The NONrefundable education portions
  // are already inside `tax` — they reduced the years'
  // federal tax bills directly — so only the refundable
  // portion is credited here, exactly as the ACA premium
  // credit is: a credit the household receives beyond its
  // tax bills, which a floored federal tax must not
  // silently drop. $0 for any plan with no entered
  // education expenses.
  educationRefundable: number;
  // Lifetime AMT owed (T7): the sum of the years' AMT —
  // already inside `tax` above (each year's AMT raised its
  // federal tax bill, which lifetimeFederalTax sums), so
  // this line only NAMES the component of the lifetime
  // tax; it is never added to or subtracted from the
  // identity a second time. $0 for any plan whose
  // tentative minimum tax never exceeds its regular tax.
  amt: number;
  // Terminal tax on the ending pre-tax balance. Without a
  // preserve reserve this is the whole balance × heir rate,
  // exactly as before. With a reserve it splits: the portion
  // up to the floor at the reserve's expected exit rate, any
  // excess at the heir rate (terminalPreserved +
  // terminalExcess = terminal).
  terminal: number;
  // The ending pre-tax dollars priced at the reserve's exit
  // rate, and the tax on them. Both 0 when no reserve is set.
  preservedPretax: number;
  terminalPreserved: number;
  // The ending pre-tax dollars above the floor, and the tax
  // on them at the heir rate. The whole balance / its full
  // heir-rate tax when no reserve is set.
  excessPretax: number;
  terminalExcess: number;
  netCost: number;
  // Lifetime Social Security collected under this candidate
  // (the engine's year-by-year benefits actually paid, summed
  // on the same nominal basis as the lifetime tax figure;
  // survivor years count only the benefit that continues).
  // Display only — it is NOT part of the objective, the
  // ranking, or winner selection.
  ssCollected: number;
};

export function netCostBreakdown(
  result: RothPlanResult,
  heirRatePct: number,
  opts?: { preservePretax?: number; preserveExitRatePct?: number },
): NetCostBreakdown {
  const tax = r2(result.lifetimeFederalTax + result.lifetimeStateTax);
  const penalty = r2(result.lifetimePenalty);
  const irmaa = r2(result.lifetimeIrmaa);
  const acaCredit = r2(result.lifetimeAcaKept);
  const healthPremium = r2(result.lifetimeHealthPremiumGross ?? 0);
  const healthPremiumNet = r2(result.lifetimeHealthPremiumNet ?? 0);
  const educationRefundable = r2(result.lifetimeEducationRefundable);
  const amt = r2(result.lifetimeAmt);
  // Split terminal pricing. With no reserve (floor absent /
  // 0) the preserved part is $0 and the terminal is the old
  // single-rate figure bit for bit: r2(0 × exit) = 0 and
  // r2(ending × heir) is computed exactly as before.
  const floor = Math.max(0, opts?.preservePretax ?? 0);
  const exitRatePct = opts?.preserveExitRatePct ?? heirRatePct;
  const preservedPretax = r2(Math.min(result.endingPretax, floor));
  const excessPretax = r2(result.endingPretax - preservedPretax);
  const terminalPreserved = r2(preservedPretax * (exitRatePct / 100));
  const terminalExcess = r2(excessPretax * (heirRatePct / 100));
  const terminal = r2(terminalPreserved + terminalExcess);
  return {
    tax,
    penalty,
    irmaa,
    acaCredit,
    healthPremium,
    healthPremiumNet,
    educationRefundable,
    amt,
    terminal,
    preservedPretax,
    terminalPreserved,
    excessPretax,
    terminalExcess,
    netCost: r2(
      tax + penalty + irmaa + healthPremium - acaCredit - educationRefundable + terminal,
    ),
    ssCollected: r2(result.lifetimeSsCollected),
  };
}

// The plan-aware scoring call every optimizer / MC-check /
// sensitivity path uses: the plan's own reserve (floor + exit
// rate) applied on top of its heir rate. A plan without a
// reserve scores bit-identically to the pre-reserve objective.
export function planNetCost(
  result: RothPlanResult,
  inputs: RothPlanInputs,
): NetCostBreakdown {
  return netCostBreakdown(result, inputs.heirRatePct, {
    preservePretax: inputs.preservePretax ?? 0,
    preserveExitRatePct: inputs.preserveExitRatePct ?? inputs.heirRatePct,
  });
}

/* ---------------- Candidate integrity (Engine Review 4, E4-S1) ----
   The optimizer sorts candidates by lifetime net cost, but a
   candidate whose own pricing did not settle is not a reliable
   winner however cheap it scores. The tax engine exposes three
   per-year diagnostics (RothYear): settlementConverged /
   settlementMismatchCents (whether the year's settlement
   iteration reached an exact fixed point, and the kept round's
   residual mismatch per component in integer cents — gains,
   pre-tax, and, since Engine Review C3, the ACA credit
   residual), ceiling
   Breached (a switched-on ceiling still breached at conversion
   $0 — the draws alone breach), unpaidTax (assessed tax no
   balance could pay), and spendShortfall (spending need the
   year's draws could not fund). This section assesses a priced
   candidate against them, with one documented tolerance.

   SETTLEMENT TOLERANCE (derived, not guessed): 2 cents per
   component per year. REPRODUCED (review probe, Oct 25
   single-filer case and its equivalents): the single-filer
   shape of the fictional sample household prices non-converged
   years 2047/2049 (compare/simulate shapes) and the MFJ
   household prices 2038/2049/2056 on Fill 22% — every one a
   1-cent GAINS mismatch, pre-tax $0, and across the full
   3,025-candidate optimizer search in BOTH filing statuses
   (≈9,800 non-converged year-instances) the worst mismatch is
   1 cent, never more. That 1-cent basis was SUPERSEDED by
   Engine Review C3 (W4, V2-F1): a reproducible 2-cent GAINS
   mismatch exists on the sample household itself — spending
   $254,500, taxable-first draw order, 60% taxable basis,
   fill-aca strategy, year 2047, {gains: 2, pre-tax: 0},
   deterministic across runs, with the neighbouring spendings
   $254,499 and $254,501 both converging at {0, 0} (a
   knife-edge at a Taxable-balance saturation kink, not a
   family — a $2,500-step hunt over $100k–$300k found zero
   further years ≥ 2¢). The tolerance is therefore raised to
   2 cents: the observed worst case, still a benign rounding
   residual, not a settlement defect: the iteration compares
   r2-rounded feedback gains, and a 2-cent gains difference
   moves the year's tax by at most ~$0.008 (2¢ × the top 37%
   ordinary / 23.8% gains rate), which rounds to $0.00 at the
   cent the engine prices in, and its balance knock-on stays
   under ~7¢ over a 40-year horizon at 5%. A residual above
   the tolerance is NOT assumed benign: it is independently
   material, and the candidate is invalid until its settlement
   is reproduced and understood.

   CEILING BREACH is deliberately NOT an invalidity by itself:
   a breached year at conversion $0 means the year's mandatory
   income alone exceeds the ceiling — no fill can fix it, and
   the engine already reduced the conversion to $0 and flagged
   it honestly (round-7 R7-4). The ONE breach that IS an
   invalidity is a breach with conversion above $0: the final
   clamp bisects the conversion to compliance or $0, so a
   breached year still converting contradicts the clamp and is a
   real defect, not a disclosure. */

export const SETTLEMENT_TOLERANCE_CENTS = 2;

export type CandidateIntegrityStatus =
  | "valid"
  | "valid-with-benign-residual"
  | "invalid";

export type CandidateIntegrity = {
  status: CandidateIntegrityStatus;
  // Non-converged years (count + calendar years, for the note).
  nonConvergedYears: number;
  nonConvergedYearList: number[];
  // Worst residual per component over the march, integer cents.
  // (Engine Review C3, C3-S1): the ACA credit residual is a
  // third component — a year can fail on credit alone while
  // gains / pre-tax converge, and the gate judged such a year
  // benign before this field existed.
  maxMismatchGainsCents: number;
  maxMismatchPretaxCents: number;
  maxMismatchAcaCreditCents: number;
  // Ceiling-breach counts: all breached years, and the subset
  // breached at conversion $0 (draws alone — not a defect).
  ceilingBreachedYears: number;
  ceilingBreachedAtZeroConversionYears: number;
  // Lifetime assessed tax no balance could pay, and lifetime
  // spending need the draws could not fund (dollars).
  unpaidTaxTotal: number;
  spendShortfallTotal: number;
  // Human-readable reasons; empty unless invalid.
  reasons: string[];
};

export function assessCandidateIntegrity(
  result: RothPlanResult,
): CandidateIntegrity {
  const nonConvergedYearList: number[] = [];
  let maxMismatchGainsCents = 0;
  let maxMismatchPretaxCents = 0;
  let maxMismatchAcaCreditCents = 0;
  const acaMismatchYears: number[] = [];
  let ceilingBreachedYears = 0;
  let ceilingBreachedAtZeroConversionYears = 0;
  let spendShortfallTotal = 0;
  const convertingBreachedYears: number[] = [];
  for (const y of result.years) {
    // Defensive reads (?? 0 / ?? false): the engine always sets
    // these fields, but a caller assessing a mapped row (e.g. a
    // compare-path readout) must never NaN-poison the totals.
    const mismatch = y.settlementMismatchCents ?? { gains: 0, pretax: 0, roth: 0, hsa: 0, acaCredit: 0 };
    const conversion = y.conversion ?? 0;
    if (!y.settlementConverged) nonConvergedYearList.push(y.year);
    maxMismatchGainsCents = Math.max(maxMismatchGainsCents, mismatch.gains ?? 0);
    maxMismatchPretaxCents = Math.max(maxMismatchPretaxCents, mismatch.pretax ?? 0);
    const acaCredit = mismatch.acaCredit ?? 0;
    if (acaCredit > 0) acaMismatchYears.push(y.year);
    maxMismatchAcaCreditCents = Math.max(maxMismatchAcaCreditCents, acaCredit);
    if (y.ceilingBreached) {
      ceilingBreachedYears++;
      if (conversion <= 0) ceilingBreachedAtZeroConversionYears++;
      else convertingBreachedYears.push(y.year);
    }
    spendShortfallTotal += y.spendShortfall ?? 0;
  }
  const reasons: string[] = [];
  if (
    maxMismatchGainsCents > SETTLEMENT_TOLERANCE_CENTS ||
    maxMismatchPretaxCents > SETTLEMENT_TOLERANCE_CENTS
  ) {
    reasons.push(
      `unresolved settlement mismatch above the ${SETTLEMENT_TOLERANCE_CENTS}¢ tolerance ` +
        `(gains ${maxMismatchGainsCents}¢, pre-tax ${maxMismatchPretaxCents}¢)`,
    );
  }
  // (Engine Review C3, C3-S1): the ACA credit residual is
  // judged by the same tolerance — a credit-only failure is
  // a real funding inconsistency (the funded need is short
  // of the need at the year's own priced credit by exactly
  // the residual), not a rounding artifact, so anything
  // above the tolerance invalidates the candidate exactly
  // as a gains / pre-tax residual does.
  if (maxMismatchAcaCreditCents > SETTLEMENT_TOLERANCE_CENTS) {
    reasons.push(
      `unresolved ACA credit settlement mismatch above the ${SETTLEMENT_TOLERANCE_CENTS}¢ tolerance ` +
        `(ACA credit ${maxMismatchAcaCreditCents}¢ in ${acaMismatchYears.join(", ")})`,
    );
  }
  if (convertingBreachedYears.length > 0) {
    reasons.push(
      `ceiling still breached with conversion above $0 in ${convertingBreachedYears.join(", ")} ` +
        `(the final clamp should have reduced the conversion to $0 or compliance)`,
    );
  }
  const unpaidTaxTotal = r2(result.lifetimeUnpaidTax ?? 0);
  if (unpaidTaxTotal > 0) {
    reasons.push(
      `unpaid tax of ${fmtDollars(unpaidTaxTotal)}: assessed tax the balances could not pay`,
    );
  }
  spendShortfallTotal = r2(spendShortfallTotal);
  if (spendShortfallTotal > 0) {
    reasons.push(
      `unfunded spending of ${fmtDollars(spendShortfallTotal)}: the plan cannot fund its own spending need`,
    );
  }
  const status: CandidateIntegrityStatus =
    reasons.length > 0
      ? "invalid"
      : nonConvergedYearList.length > 0
        ? "valid-with-benign-residual"
        : "valid";
  return {
    status,
    nonConvergedYears: nonConvergedYearList.length,
    nonConvergedYearList,
    maxMismatchGainsCents,
    maxMismatchPretaxCents,
    maxMismatchAcaCreditCents,
    ceilingBreachedYears,
    ceilingBreachedAtZeroConversionYears,
    unpaidTaxTotal,
    spendShortfallTotal,
    reasons,
  };
}

/* ---------------- Distinct optimization objectives (E4-S2) ----
   The comparator has always prioritized lifetime net cost and
   used ending after-tax wealth only as a tie-breaker. That
   objective is PRESERVED — and now each run names both winners
   separately, so a reader can see when the two objectives
   disagree instead of learning it from the tie-break:

   · winnerByNetCost — lowest lifetime net cost among the VALID
     tested candidates (the integrity assessment above: a
     candidate with a material unresolved discrepancy, unpaid
     tax, or unfunded spending is not eligible to win on cost).
   · winnerByEndingWealth — highest ending after-tax wealth
     among the VALID tested candidates (the engine's own
     endingAfterTaxWealth: ending pre-tax net of its terminal
     tax at the heir / reserve exit rates, plus Roth, taxable,
     and HSA — never gross balances).
   · selectedWinner — the cost-first recommended candidate: the
     winnerByNetCost. When the raw cost-first candidate over ALL
     tested candidates is invalid, it is NOT silently crowned:
     the result names it as excludedInvalidWinner with its
     integrity reasons, and the selected winner is the best
     valid candidate. When no candidate is valid at all the raw
     winner is still crowned (there is nothing else to
     recommend) and winnerQualified is false, so the
     recommendation carries its disqualification in the open.

   Neither winner is a mathematical global optimum, and the
   result never calls one that: the search prices the candidate
   families its scope names, not every conceivable strategy. */

// The cost-first objective, in the words the UI and the
// adapter print beside the winner.
export const OPTIMIZER_OBJECTIVE =
  "Lowest lifetime net cost first: lifetime federal + state tax + pre-59½ penalties + IRMAA surcharges + gross health premiums − ACA premium credit kept − refundable education credit + terminal tax on the ending pre-tax balance. Exact net-cost ties break toward the highest ending after-tax wealth. Best among the candidates actually tested — not a mathematical global optimum.";

export type OptimizerSearchScope = {
  // One plain-language paragraph naming what was priced and
  // what was held fixed, so a reader can tell at a glance
  // whether claiming ages, draw orders, or windows were
  // searched or frozen.
  description: string;
  // Conversion windows priced (stop ages actually searched).
  windowStopAges: number[];
  // Ceiling families priced.
  ceilingFamilies: string[];
  // Draw orders: searched (all six) or held at the plan order.
  drawOrdersSearched: boolean;
  drawOrderLabels: string[];
  // Claiming ages: searched jointly, or held at the entered ages.
  claimingAgesSearched: boolean;
  claimingAgeCombinations: number;
  // Search variants priced.
  variants: string[];
  // Everything the run held fixed, in plain words.
  heldFixed: string[];
};

function describeOptimizerSearchScope(
  inputs: RothPlanInputs,
  opts: { searchOrders: boolean; claimingAgesSearched: boolean; combosTested: number },
): OptimizerSearchScope {
  const rmdAge = Math.ceil(rmdAgeForBirthYear(inputs.birthYearPrimary));
  const stops = [...new Set([65, rmdAge - 1, inputs.endAgePrimary])].filter(
    (s) => s >= inputs.windowStartAge,
  );
  const ceilingFamilies = [
    "every federal bracket top",
    "every IRMAA tier ceiling, and bracket × IRMAA combinations",
    "ACA-cliff caps (alone and with the 12% / 22% brackets)",
    "MAGI-cap steps ($150,000–$500,000)",
  ];
  const variants = [
    "marginal-rate guardrail variants (bracket ceilings)",
    "ACA bunching variants (non-cliff ceilings)",
    ...(harvestGatePasses(inputs)
      ? ["gain-harvest twins of every conversion candidate"]
      : []),
    "Do Nothing as the benchmark",
  ];
  const heldFixed: string[] = [];
  if (!opts.searchOrders) heldFixed.push(`draw order (held at the plan order, ${drawOrderLabel(inputs.drawOrder)})`);
  if (!opts.claimingAgesSearched) {
    const parts: string[] = [];
    if (inputs.ssPrimaryStartAge != null) parts.push(`primary claims at ${inputs.ssPrimaryStartAge}`);
    if (inputs.ssSpouseStartAge != null) parts.push(`spouse claims at ${inputs.ssSpouseStartAge}`);
    heldFixed.push(
      parts.length > 0
        ? `claiming ages (held at the entered ages: ${parts.join(", ")})`
        : "claiming ages (no benefit entered, so none searched)",
    );
  }
  const description =
    `Conversion ceilings: ${ceilingFamilies.join("; ")}. ` +
    `Conversion windows: stop at ${stops.join(", ")} (stop at 65 / stop the year before RMDs begin / keep topping up through the RMD years). ` +
    (opts.searchOrders
      ? "Draw orders: all six permutations searched. "
      : `Draw orders: held at the plan order (${drawOrderLabel(inputs.drawOrder)}). `) +
    (opts.claimingAgesSearched
      ? `Claiming ages: searched jointly with the conversion strategies (${opts.combosTested} combinations). `
      : "Claiming ages: held at the entered ages. ") +
    `Variants: ${variants.join("; ")}.`;
  return {
    description,
    windowStopAges: stops,
    ceilingFamilies,
    drawOrdersSearched: opts.searchOrders,
    drawOrderLabels: opts.searchOrders
      ? ALL_DRAW_ORDERS.map((o) => drawOrderLabel(o))
      : [drawOrderLabel(inputs.drawOrder)],
    claimingAgesSearched: opts.claimingAgesSearched,
    claimingAgeCombinations: opts.claimingAgesSearched ? opts.combosTested : 1,
    variants,
    heldFixed,
  };
}

// Pick the two objective winners out of a cost-first-sorted
// VALID list. The net-cost winner is the list head; the wealth
// winner is the max ending after-tax wealth, with exact wealth
// ties broken by the same cost-first order (lowest net cost,
// then the list order) so the pick is deterministic.
export function pickNetCostWinner(
  validSorted: ScoredCandidate[],
): ScoredCandidate | null {
  return validSorted[0] ?? null;
}

export function pickEndingWealthWinner(
  validSorted: ScoredCandidate[],
): ScoredCandidate | null {
  let best: ScoredCandidate | null = null;
  for (const s of validSorted) {
    if (
      best == null ||
      s.result.endingAfterTaxWealth > best.result.endingAfterTaxWealth
    ) {
      best = s;
    }
  }
  return best;
}

// Crown the objective winners for one sorted scored list.
// Returns the qualified winners plus, when the raw cost-first
// candidate over ALL tested candidates is invalid, that
// candidate with its integrity — so the exclusion is disclosed,
// never silent. When the valid set is empty the raw winner is
// crowned anyway and qualified is false.
export function crownOptimizerWinners(
  sortedAll: ScoredCandidate[],
): {
  winnerByNetCost: ScoredCandidate;
  winnerByEndingWealth: ScoredCandidate;
  selectedWinner: ScoredCandidate;
  validCandidatesTested: number;
  invalidCandidatesTested: number;
  excludedInvalidWinner: {
    candidate: ScoredCandidate;
    integrity: CandidateIntegrity;
  } | null;
  winnerQualified: boolean;
  winnersDiffer: boolean;
} {
  // E6 NICEs fix — a candidate with NO integrity assessment
  // attached is never excluded as invalid: under E4's
  // assessCandidateIntegrity contract a candidate is invalid
  // only when an assessment finds a reason (unresolved
  // settlement, unpaid tax, unfunded spending, converting
  // breach), and no assessment means no such verdict exists.
  // Real candidates always carry one (scoreAllCandidates
  // attaches assessCandidateIntegrity to every candidate), so
  // no real verdict is weakened; this only stops a stub
  // without an assessment (e.g. the Extended fixture's
  // synthetic scored candidates) from throwing here.
  const valid = sortedAll.filter((s) => s.integrity?.status !== "invalid");
  const invalid = sortedAll.length - valid.length;
  const rawFirst = sortedAll[0]!;
  const excludedInvalidWinner =
    rawFirst.integrity?.status === "invalid"
      ? { candidate: rawFirst, integrity: rawFirst.integrity }
      : null;
  const netCostWinner = pickNetCostWinner(valid);
  const wealthWinner = pickEndingWealthWinner(valid);
  if (netCostWinner == null || wealthWinner == null) {
    // No valid candidate at all: crown the raw winner and say
    // so — the recommendation is unqualified, in the open.
    return {
      winnerByNetCost: rawFirst,
      winnerByEndingWealth:
        pickEndingWealthWinner(sortedAll) ?? rawFirst,
      selectedWinner: rawFirst,
      validCandidatesTested: 0,
      invalidCandidatesTested: invalid,
      excludedInvalidWinner,
      winnerQualified: false,
      winnersDiffer:
        (pickEndingWealthWinner(sortedAll)?.spec.key ?? rawFirst.spec.key) !==
        rawFirst.spec.key,
    };
  }
  return {
    winnerByNetCost: netCostWinner,
    winnerByEndingWealth: wealthWinner,
    selectedWinner: netCostWinner,
    validCandidatesTested: valid.length,
    invalidCandidatesTested: invalid,
    excludedInvalidWinner,
    winnerQualified: true,
    winnersDiffer: wealthWinner.spec.key !== netCostWinner.spec.key,
  };
}

// One fixed compare scenario, as crownCompareWinners ranks it:
// the scenario's own name, its priced net cost and ending
// after-tax wealth in cents, and its integrity verdict.
export type CompareCrownEntry = {
  name: string;
  netCostCents: number;
  endingAfterTaxWealthCents: number;
  integrity: CandidateIntegrity;
};

// Crown the two objective winners for one compare run — the
// compare-path mirror of crownOptimizerWinners (Engine Review
// C9, Build 3 — W4-GAP-1). Same rule, same tie-breaks: only
// VALID candidates may win; exact net-cost ties break toward the
// highest ending after-tax wealth (the cost-first sort carries
// the wealth order, exactly as compareScoredCandidates does for
// the optimizer); exact wealth ties keep the cost-first-earliest
// candidate (lowest net cost, then list order — mirroring
// pickEndingWealthWinner's strict-greater scan over the
// cost-first-sorted list). The deterministic fallback leg is
// list order alone — unlike the optimizer, whose fallback ranks
// Do-Nothing first, then plan order, then candidate key
// (crownOptimizerWinners): compare entries carry no candidate
// key and no Do-Nothing scenario, so there is nothing else to
// rank by, and "same tie-breaks" must not be read as full
// parity on a full tie. When no candidate is valid the raw
// winners are crowned anyway and qualified is false, so the
// disqualification is disclosed, never silent. Deliberately NOT
// crownOptimizerWinners: compare scenarios have no optimizer
// spec (no candidate key, no ceilings / window / draw-order spec
// to display), so forcing them into ScoredCandidate would invent
// a spec the run never priced. Callers pass at least one entry
// (runRothCompare refuses an empty scenario list first).
export function crownCompareWinners(
  entries: CompareCrownEntry[],
): {
  winnerByNetCost: CompareCrownEntry;
  winnerByEndingWealth: CompareCrownEntry;
  validCandidatesTested: number;
  invalidCandidatesTested: number;
  excludedInvalidWinner: {
    name: string;
    integrity: CandidateIntegrity;
  } | null;
  winnerQualified: boolean;
  winnersDiffer: boolean;
} {
  const sorted = entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) =>
      a.e.netCostCents !== b.e.netCostCents
        ? a.e.netCostCents - b.e.netCostCents
        : a.e.endingAfterTaxWealthCents !== b.e.endingAfterTaxWealthCents
          ? b.e.endingAfterTaxWealthCents - a.e.endingAfterTaxWealthCents
          : a.i - b.i,
    )
    .map((x) => x.e);
  const valid = sorted.filter((e) => e.integrity.status !== "invalid");
  const invalid = sorted.length - valid.length;
  const rawFirst = sorted[0]!;
  const excludedInvalidWinner =
    rawFirst.integrity.status === "invalid"
      ? { name: rawFirst.name, integrity: rawFirst.integrity }
      : null;
  const netCostWinner = valid[0] ?? null;
  // Strict-greater scan over the cost-first-sorted valid list:
  // wealth ties keep the earliest entry (lowest net cost, then
  // list order) — the pickEndingWealthWinner rule.
  const wealthWinner = valid.reduce<CompareCrownEntry | null>(
    (best, e) =>
      best == null || e.endingAfterTaxWealthCents > best.endingAfterTaxWealthCents
        ? e
        : best,
    null,
  );
  if (netCostWinner == null || wealthWinner == null) {
    // No valid candidate at all: crown the raw winners and say
    // so — the recommendation is unqualified, in the open.
    const rawWealthWinner = sorted.reduce<CompareCrownEntry>(
      (best, e) =>
        e.endingAfterTaxWealthCents > best.endingAfterTaxWealthCents ? e : best,
      rawFirst,
    );
    return {
      winnerByNetCost: rawFirst,
      winnerByEndingWealth: rawWealthWinner,
      validCandidatesTested: 0,
      invalidCandidatesTested: invalid,
      excludedInvalidWinner,
      winnerQualified: false,
      winnersDiffer: rawWealthWinner.name !== rawFirst.name,
    };
  }
  return {
    winnerByNetCost: netCostWinner,
    winnerByEndingWealth: wealthWinner,
    validCandidatesTested: valid.length,
    invalidCandidatesTested: invalid,
    excludedInvalidWinner,
    winnerQualified: true,
    winnersDiffer: wealthWinner.name !== netCostWinner.name,
  };
}

/* ---------------- Candidates ---------------- */

export type OptimizerWindowKind = "stop65" | "stopRmd" | "throughRmd";

export type OptimizerCandidateSpec = {
  key: string;
  name: string;
  ceilings: FillCeilings;
  windowStopAge: number;
  windowKind: OptimizerWindowKind;
  windowLabel: string;
  guardrail: boolean;
  bunching: boolean;
  // Gain harvesting (build v56): true = this candidate is
  // the harvest twin of the same ceilings/window/variant/order
  // — it prices with gainsHarvest on. Absent = false, so every
  // pre-existing literal keeps its meaning. Do Nothing never
  // carries it (the change-nothing benchmark).
  gainsHarvest?: boolean;
  // The spending draw order this candidate is priced under.
  drawOrder: DrawOrder;
};

/* Gain-harvesting gate (build v56): harvest twins are
   generated only when harvesting can bind on the resolved
   plan inputs — the resolved taxable balance is above $0 AND
   the blended basis is below 100%. With tiers the blended
   basis test is: any positive-share tier has basisPct < 100.
   With no tiers it is taxableBasisPct < 100. A blank basis
   prices harvesting as inert in the engine (no basis to step
   up), so it never passes. When the gate fails NO twins are
   generated and candidate counts are exactly as before —
   harvesting is then a provable no-op. */
export function harvestGatePasses(inputs: RothPlanInputs): boolean {
  if (!(inputs.taxableStart > 0)) return false;
  if (inputs.taxableBasisBlank === true) return false;
  if (Array.isArray(inputs.taxableTiers) && inputs.taxableTiers.length > 0) {
    return inputs.taxableTiers.some(
      (t) =>
        (t.sharePct ?? 0) > 0 &&
        Math.min(100, Math.max(0, t.basisPct)) < 100,
    );
  }
  return Math.min(100, Math.max(0, inputs.taxableBasisPct)) < 100;
}

export const HARVEST_NAME_PHRASE = "gain harvesting into the 0% bracket";

export type ScoredCandidate = {
  spec: OptimizerCandidateSpec;
  result: RothPlanResult;
  cost: NetCostBreakdown;
  // Candidate-integrity assessment (E4-S1): the settlement /
  // funding diagnostics of this candidate's own priced march.
  // Attached at scoring time, so every consumer reads the same
  // assessment the crowning used.
  integrity: CandidateIntegrity;
  // The claiming ages this candidate was priced at (the entered
  // ages for a fixed-age run; the combination's ages for a joint
  // run). A saved joint winner reproduces exactly by re-running
  // its strategy at these ages and amounts.
  claimAges: ClaimAgeInfo;
};

function fmtDollars(n: number): string {
  const neg = n < 0;
  const abs = Math.abs(n);
  if (abs > 0 && abs < 0.5) {
    // A non-zero amount that rounds to $0 at whole dollars
    // (Engine Review C9, Build 3 NICEs, N5): a 1¢ unpaid tax
    // reasoned as "unpaid tax of $0" — verdict and money
    // correct, the human-readable amount wrong. Show cents, so
    // a sub-$0.50 amount never reads as $0. (Totals reaching
    // here are cent-rounded upstream, so the cents figure is
    // exact; a sub-half-cent remainder renders $0.00.)
    const cents = Math.round(abs * 100);
    const s = `$0.${String(cents).padStart(2, "0")}`;
    return neg ? `−${s}` : s;
  }
  const rounded = Math.round(abs);
  // Manual thousands grouping — identical output to
  // toLocaleString("en-US") for a non-negative integer, without
  // the ICU call (this runs while naming every candidate spec).
  let digits = String(rounded);
  let grouped = "";
  while (digits.length > 3) {
    grouped = `,${digits.slice(-3)}${grouped}`;
    digits = digits.slice(0, -3);
  }
  const s = `$${digits}${grouped}`;
  return neg ? `−${s}` : s;
}

// The winning ceiling named in plain terms, e.g. "Fill to the top
// of the 22% bracket, capped at IRMAA Tier 1".
export function nameForCeilings(ceilings: FillCeilings): string {
  const caps: string[] = [];
  if (ceilings.irmaaTierCap != null) caps.push(`IRMAA Tier ${ceilings.irmaaTierCap}`);
  if (ceilings.ltcgZeroCap) caps.push("the top of the 0% capital-gains space");
  if (ceilings.acaCliffCap) caps.push("the ACA cliff (400% of the poverty line)");
  // Cliff safety buffer (CLIFF SAFETY BUFFER build): named
  // whenever it is set, with the client's own phrase, so a
  // buffered strategy never reads identically to an unbuffered
  // one. Inert (and unnamed) when the cliff cap is off or the
  // buffer is blank/0.
  if (
    ceilings.acaCliffCap &&
    ceilings.acaCliffBuffer != null &&
    ceilings.acaCliffBuffer > 0
  )
    caps.push(`a ${fmtDollars(ceilings.acaCliffBuffer)} safety buffer under the cliff`);
  if (ceilings.magiCap != null) caps.push(`a ${fmtDollars(ceilings.magiCap)} MAGI cap`);
  let head: string;
  if (ceilings.bracketTopPct != null) {
    head = `Fill to the top of the ${ceilings.bracketTopPct}% bracket`;
  } else if (ceilings.irmaaTierCap != null) {
    head = `Fill up to the IRMAA Tier ${ceilings.irmaaTierCap} ceiling`;
    caps.shift();
  } else if (ceilings.acaCliffCap) {
    head = "Fill up to the ACA cliff (400% of the poverty line)";
    caps.shift();
  } else if (ceilings.magiCap != null) {
    head = `Fill to a ${fmtDollars(ceilings.magiCap)} MAGI cap`;
    caps.shift();
  } else if (ceilings.ltcgZeroCap) {
    head = "Fill up to the top of the 0% capital-gains space";
    caps.shift();
  } else {
    head = "Convert with no ceiling";
  }
  return caps.length ? `${head}, capped at ${caps.join(" and ")}` : head;
}

function windowLabelFor(
  kind: OptimizerWindowKind,
  startAge: number,
  stopAge: number,
): string {
  const base = `Convert ages ${startAge}–${stopAge}`;
  if (kind === "stop65") return `${base} (stop at 65)`;
  if (kind === "stopRmd") return `${base} (stop the year before RMDs begin)`;
  return `${base} (keep topping up through the RMD years)`;
}

type CeilingSet = { ceilings: FillCeilings; bracketBearing: boolean; acaBearing: boolean };

function ceilingSets(): CeilingSet[] {
  const sets: CeilingSet[] = [];
  const push = (ceilings: FillCeilings) =>
    sets.push({
      ceilings,
      bracketBearing: ceilings.bracketTopPct != null,
      acaBearing: ceilings.acaCliffCap,
    });
  // Every federal bracket top.
  for (const rate of CURRENT_LAW.rates) {
    push({ ...NO_CEILINGS, bracketTopPct: rate });
  }
  // Every IRMAA tier line (Tier 5's ceiling is unbounded — no cap).
  for (let tier = 0; tier <= 4; tier++) {
    push({ ...NO_CEILINGS, irmaaTierCap: tier });
  }
  // Bracket × IRMAA combinations (the named-fill pattern).
  for (const rate of [10, 12, 22, 24]) {
    for (const tier of [0, 1, 2]) {
      push({ ...NO_CEILINGS, bracketTopPct: rate, irmaaTierCap: tier });
    }
  }
  // The ACA cliff, alone and with the two most-used brackets.
  push({ ...NO_CEILINGS, acaCliffCap: true });
  push({ ...NO_CEILINGS, bracketTopPct: 12, acaCliffCap: true });
  push({ ...NO_CEILINGS, bracketTopPct: 22, acaCliffCap: true });
  // Intermediate MAGI-cap steps between the bracket tops and the
  // IRMAA lines, in MAGI space.
  for (const cap of [150000, 200000, 250000, 300000, 400000, 500000]) {
    push({ ...NO_CEILINGS, magiCap: cap });
  }
  return sets;
}

function ceilingsKey(c: FillCeilings): string {
  return [
    c.bracketTopPct ?? "-",
    c.irmaaTierCap ?? "-",
    c.ltcgZeroCap ? "g" : "-",
    c.acaCliffCap ? "a" : "-",
    c.magiCap ?? "-",
  ].join("|");
}

export function buildOptimizerCandidates(
  inputs: RothPlanInputs,
  orders: DrawOrder[] = ALL_DRAW_ORDERS,
): OptimizerCandidateSpec[] {
  const rmdAge = Math.ceil(rmdAgeForBirthYear(inputs.birthYearPrimary));
  const stops: { kind: OptimizerWindowKind; stop: number }[] = [
    { kind: "stop65", stop: 65 },
    { kind: "stopRmd", stop: rmdAge - 1 },
    { kind: "throughRmd", stop: inputs.endAgePrimary },
  ];
  const seenStops = new Set<number>();
  const windows = stops.filter((w) => {
    if (w.stop < inputs.windowStartAge) return false;
    if (seenStops.has(w.stop)) return false;
    seenStops.add(w.stop);
    return true;
  });
  const out: OptimizerCandidateSpec[] = [];
  const seen = new Set<string>();
  const harvestGate = harvestGatePasses(inputs);
  const addOne = (
    ceilings: FillCeilings,
    window: { kind: OptimizerWindowKind; stop: number },
    guardrail: boolean,
    bunching: boolean,
    drawOrder: DrawOrder,
    gainsHarvest: boolean,
  ) => {
    const baseKey = [
      ceilingsKey(ceilings),
      window.stop,
      guardrail ? "gr" : "-",
      bunching ? "bu" : "-",
      drawOrderKey(drawOrder),
    ].join(":");
    // Non-harvest keys are exactly the pre-v56 keys, so every
    // existing key pin on a gate-failing shape is unmoved. A
    // harvest twin's key appends ":hv", making twins distinct
    // for counting, candidate keys, and the total tie-break
    // order (no two candidates compare equal on every key).
    const key = gainsHarvest ? `${baseKey}:hv` : baseKey;
    if (seen.has(key)) return;
    seen.add(key);
    const baseName = nameForCeilings(ceilings);
    out.push({
      key,
      name: gainsHarvest ? `${baseName} · ${HARVEST_NAME_PHRASE}` : baseName,
      ceilings,
      windowStopAge: window.stop,
      windowKind: window.kind,
      windowLabel: windowLabelFor(window.kind, inputs.windowStartAge, window.stop),
      guardrail,
      bunching,
      gainsHarvest,
      drawOrder,
    });
  };
  const add = (
    ceilings: FillCeilings,
    window: { kind: OptimizerWindowKind; stop: number },
    guardrail: boolean,
    bunching: boolean,
    drawOrder: DrawOrder,
  ) => {
    addOne(ceilings, window, guardrail, bunching, drawOrder, false);
    // Gain-harvesting twin (build v56): EVERY generated
    // conversion candidate also gets a gainsHarvest twin when
    // the gate passes. Do Nothing is never generated here, so
    // it never gets a twin.
    if (harvestGate) addOne(ceilings, window, guardrail, bunching, drawOrder, true);
  };
  for (const set of ceilingSets()) {
    for (const window of windows) {
      for (const order of orders) {
        add(set.ceilings, window, false, false, order);
        // Guardrail variant: only for bracket ceilings (its target
        // is the strategy's own bracket rate).
        if (set.bracketBearing) add(set.ceilings, window, true, false, order);
        // Bunching variant: only for non-cliff ceilings — a
        // bunching candidate deliberately forfeits the cliff in its
        // big years, so a cliff cap contradicts the variant.
        if (!set.acaBearing) add(set.ceilings, window, false, true, order);
      }
    }
  }
  return out;
}

export function candidateStrategy(spec: OptimizerCandidateSpec): RothStrategy {
  return {
    id: `opt-${spec.key}`,
    name: spec.name,
    ceilings: spec.ceilings,
    guardrail: spec.guardrail,
    bunching: spec.bunching,
    gainsHarvest: spec.gainsHarvest ?? false,
  };
}

export const DO_NOTHING_SPEC: OptimizerCandidateSpec = {
  key: "do-nothing",
  name: "Do Nothing",
  ceilings: NO_CEILINGS,
  windowStopAge: 0,
  windowKind: "stopRmd",
  windowLabel: "No conversions",
  guardrail: false,
  bunching: false,
  gainsHarvest: false,
  drawOrder: DEFAULT_DRAW_ORDER,
};

/* ---------------- Winner ordering (Round-7 Build 3, N-3) ----
   The winner is the LOWEST lifetime net cost; exact ties on
   net cost are broken by ENDING WEALTH (the candidate's ending
   after-tax wealth — higher wins); the remaining tie-breaks
   keep their existing order after that (Do Nothing first, then
   the plan's own draw order, then the candidate key, then —
   in the joint search — the claiming ages). The candidate's
   ending wealth is the engine's own endingAfterTaxWealth on
   its priced result, which the lean pricing path produces
   exactly as the full path does, so no candidate's priced
   figures move — the wealth was always computed; it simply
   was not part of the ordering before. Both comparators are
   exported so the fixtures pin the ordering directly. */

export function compareScoredCandidates(
  a: ScoredCandidate,
  b: ScoredCandidate,
  planOrderKey: string,
): number {
  const dnRank = (s: ScoredCandidate): number =>
    s.spec.key === DO_NOTHING_SPEC.key ? 0 : 1;
  const orderRank = (s: ScoredCandidate): number =>
    drawOrderKey(s.spec.drawOrder) === planOrderKey ? 0 : 1;
  return (
    a.cost.netCost - b.cost.netCost ||
    b.result.endingAfterTaxWealth - a.result.endingAfterTaxWealth ||
    dnRank(a) - dnRank(b) ||
    orderRank(a) - orderRank(b) ||
    (a.spec.key < b.spec.key ? -1 : a.spec.key > b.spec.key ? 1 : 0)
  );
}

export function compareJointCandidates(
  a: ScoredCandidate,
  b: ScoredCandidate,
): number {
  const dnRank = (s: ScoredCandidate): number =>
    s.spec.key === DO_NOTHING_SPEC.key ? 0 : 1;
  return (
    a.cost.netCost - b.cost.netCost ||
    b.result.endingAfterTaxWealth - a.result.endingAfterTaxWealth ||
    dnRank(a) - dnRank(b) ||
    (a.spec.key < b.spec.key ? -1 : a.spec.key > b.spec.key ? 1 : 0) ||
    (a.claimAges.primaryAge ?? 0) - (b.claimAges.primaryAge ?? 0) ||
    (a.claimAges.spouseAge ?? 0) - (b.claimAges.spouseAge ?? 0)
  );
}

/* ---------------- The scan ---------------- */

// Score every candidate (plus Do Nothing) against the objective.
// Sorted best-first by the winner ordering above: lowest net
// cost, ending wealth breaking exact cost ties, then Do
// Nothing, then the plan's own draw order (a different order
// must price strictly lower — or tie on cost with higher
// ending wealth — to be recommended), then the candidate key
// so the ordering — and therefore the winner — is
// deterministic. With `searchOrders: false` only the plan's
// own draw order is priced: the joint claiming-age search and
// the sensitivity strips hold the order, the fixed-age run
// searches it.
export function scoreAllCandidates(
  inputs: RothPlanInputs,
  claimAges: ClaimAgeInfo = enteredClaimInfo(inputs),
  opts?: { searchOrders?: boolean },
): ScoredCandidate[] {
  const orders =
    opts?.searchOrders === false ? [inputs.drawOrder] : ALL_DRAW_ORDERS;
  const planOrderKey = drawOrderKey(inputs.drawOrder);
  const scored: ScoredCandidate[] = [];
  const dnResult = simulateRothPlan(
    inputs,
    {
      id: "none",
      name: "Do Nothing",
      ceilings: null,
    },
    undefined,
    { leanDetail: true },
  );
  scored.push({
    spec: {
      ...DO_NOTHING_SPEC,
      windowStopAge: inputs.windowStopAge,
      drawOrder: inputs.drawOrder,
    },
    result: dnResult,
    cost: planNetCost(dnResult, inputs),
    integrity: assessCandidateIntegrity(dnResult),
    claimAges,
  });
  for (const spec of buildOptimizerCandidates(inputs, orders)) {
    const candidateInputs =
      spec.windowStopAge === inputs.windowStopAge &&
      drawOrderKey(spec.drawOrder) === planOrderKey
        ? inputs
        : { ...inputs, windowStopAge: spec.windowStopAge, drawOrder: spec.drawOrder };
    const result = simulateRothPlan(candidateInputs, candidateStrategy(spec), undefined, {
      leanDetail: true,
    });
    scored.push({
      spec,
      result,
      cost: planNetCost(result, inputs),
      integrity: assessCandidateIntegrity(result),
      claimAges,
    });
  }
  scored.sort((a, b) => compareScoredCandidates(a, b, planOrderKey));
  return scored;
}

export type OptimizerResult = {
  candidatesTested: number;
  // Candidates whose priced march is valid to recommend
  // (E4-S1): every tested candidate minus the invalid ones.
  validCandidatesTested: number;
  invalidCandidatesTested: number;
  doNothing: ScoredCandidate;
  winner: ScoredCandidate;
  // The cost-first recommended candidate (E4-S2): identical to
  // `winner` — the lowest-net-cost VALID candidate. Kept as its
  // own field so the recommendation names its objective.
  selectedWinner: ScoredCandidate;
  // Lowest lifetime net cost among the valid tested candidates.
  winnerByNetCost: ScoredCandidate;
  // Highest ending after-tax wealth among the valid tested
  // candidates. Routinely a different candidate from the
  // net-cost winner: the two objectives disagree, and the
  // result says so instead of hiding it behind the tie-break.
  winnerByEndingWealth: ScoredCandidate;
  // True when the two objective winners are different
  // candidates.
  winnersDiffer: boolean;
  // True when the crowned winner is a valid candidate. False
  // only when no candidate was valid at all and the raw winner
  // was crowned anyway (see crownOptimizerWinners).
  winnerQualified: boolean;
  // The raw cost-first candidate over ALL tested candidates,
  // when it was excluded as invalid — so a material unresolved
  // discrepancy can never silently produce an unqualified
  // winner recommendation. Null on every plan whose cheapest
  // candidate is valid (the ordinary case).
  excludedInvalidWinner: {
    candidate: ScoredCandidate;
    integrity: CandidateIntegrity;
  } | null;
  // The cost-first objective, in plain words.
  objective: string;
  // What the search priced and what it held fixed.
  searchScope: OptimizerSearchScope;
  // The next-best distinct candidates after the winner (up to 3).
  runnersUp: ScoredCandidate[];
  scored: ScoredCandidate[];
};

/* ---------------- Priced levers vs the entered plan (build v69) ----
   The "What would improve this plan" list: the top few DISTINCT
   candidates the search priced whose lifetime net cost BEATS the
   entered plan's own priced net cost. The entered plan is priced
   as its own fixed strategy (its saved ceilings / window / draw
   order / claiming ages) by the caller; this selector only
   compares the search's own scored figures against that cost —
   the gain is savedPlanNetCost − candidate netCost, rounded to
   the cent, and a candidate counts only when that gain is at
   least one cent. Do Nothing is never a lever (it is the
   benchmark, not a change), and duplicates — the same lever
   (name, window stop, claiming ages, draw order) priced by both
   the joint and the fixed-age runs — collapse to their cheapest
   pricing. Ordering is the winner ordering (lowest net cost,
   ending wealth breaking ties). */
export type OptimizerImprovement = {
  candidate: ScoredCandidate;
  gainVsSavedPlan: number;
};

export function optimizerImprovements(
  scoredLists: ScoredCandidate[][],
  savedPlanNetCost: number,
  limit = 3,
): OptimizerImprovement[] {
  const byLever = new Map<string, ScoredCandidate>();
  for (const list of scoredLists) {
    for (const s of list) {
      if (s.spec.key === DO_NOTHING_SPEC.key) continue;
      // E4-S1: a lever whose own pricing did not settle, left
      // tax unpaid, or left spending unfunded is not a
      // recommendation, however cheap it scores. (E6 NICEs
      // fix: the optional chain — a candidate with no
      // integrity assessment attached is never excluded as
      // invalid; see crownOptimizerWinners above.)
      if (s.integrity?.status === "invalid") continue;
      const gain = Math.round((savedPlanNetCost - s.cost.netCost) * 100) / 100;
      if (gain < 0.01) continue;
      const leverKey = [
        s.spec.name,
        s.spec.windowStopAge,
        s.claimAges.primaryAge ?? "",
        s.claimAges.spouseAge ?? "",
        drawOrderKey(s.spec.drawOrder),
      ].join("|");
      const prev = byLever.get(leverKey);
      if (!prev || s.cost.netCost < prev.cost.netCost) byLever.set(leverKey, s);
    }
  }
  const distinct = [...byLever.values()];
  distinct.sort(
    (a, b) =>
      a.cost.netCost - b.cost.netCost ||
      b.result.endingAfterTaxWealth - a.result.endingAfterTaxWealth,
  );
  return distinct.slice(0, limit).map((candidate) => ({
    candidate,
    gainVsSavedPlan:
      Math.round((savedPlanNetCost - candidate.cost.netCost) * 100) / 100,
  }));
}

export function runOptimizer(
  inputs: RothPlanInputs,
  opts?: { searchOrders?: boolean },
): OptimizerResult {
  const scored = scoreAllCandidates(inputs, enteredClaimInfo(inputs), opts);
  const doNothing = scored.find((s) => s.spec.key === DO_NOTHING_SPEC.key) ?? scored[0]!;
  // Crowning (E4-S1/E4-S2): the winner is the best VALID
  // candidate by the cost-first ordering — the scoring order
  // itself is unchanged, so every plan whose cheapest candidate
  // is valid (the ordinary case, including both regression
  // anchors) crowns bit-identically to before.
  const crowned = crownOptimizerWinners(scored);
  const winner = crowned.selectedWinner;
  const runnersUp = scored
    .filter(
      // E6 NICEs fix: optional chain — no assessment attached
      // is never an invalid verdict (see crownOptimizerWinners).
      (s) => s.integrity?.status !== "invalid" && s !== winner,
    )
    .slice(0, 3);
  return {
    candidatesTested: scored.length,
    validCandidatesTested: crowned.validCandidatesTested,
    invalidCandidatesTested: crowned.invalidCandidatesTested,
    doNothing,
    winner,
    selectedWinner: crowned.selectedWinner,
    winnerByNetCost: crowned.winnerByNetCost,
    winnerByEndingWealth: crowned.winnerByEndingWealth,
    winnersDiffer: crowned.winnersDiffer,
    winnerQualified: crowned.winnerQualified,
    excludedInvalidWinner: crowned.excludedInvalidWinner,
    objective: OPTIMIZER_OBJECTIVE,
    searchScope: describeOptimizerSearchScope(inputs, {
      searchOrders: opts?.searchOrders !== false,
      claimingAgesSearched: false,
      combosTested: 1,
    }),
    runnersUp,
    scored,
  };
}

/* ---------------- Joint claiming-age search ----------------
   The optimizer above prices ONE claiming-age pair: the entered
   ages. Separate optima are not joint optima (the MaxiFi point):
   the best conversion strategy at the entered ages, and the best
   claiming ages under Do Nothing, can both lose to a combination
   neither search finds alone — delaying a claim, for instance,
   opens low-income gap years where conversions are cheap, and
   the bigger later benefit changes which ceiling wins after.
   This search therefore varies each ENTERED benefit's claiming
   age over every age 62–70 JOINTLY with the conversion
   strategies — over ATTAINABLE ages only (Round-7 Build 3,
   N-1): a person whose benefit already started at plan start
   is locked at their entered age, and a person who has not
   claimed yet is only offered ages at or after their current
   age. A spouse whose benefit is blank is not searched —
   there is no anchor to derive other ages from — and the result
   says so.

   SEARCH SHAPE (staged, so the joint space stays practical):
   the full strategy set is 253 candidates at the plan's draw
   order (the joint search never varies the order — the
   fixed-age run is where draw orders compete), and the claim
   space is up to 9 × 9 = 81 combinations. Stage 1 screens EVERY
   claim combination with a reduced strategy set (Do Nothing
   plus eight representative ceilings on the stop-before-RMDs
   window — the screening scores are real engine prices, and a
   combination's Do Nothing score is exact at any stage). Stage
   2 runs the FULL strategy set for EVERY combination, so the
   per-claiming-age table can report each primary age's true
   best fully-priced strategy — not a screening estimate — and
   the reported winner is the best fully-priced candidate
   found. The search never optimizes claiming first and
   conversions second (or the reverse): every combination is
   priced as a combination, and the winner is chosen among
   combinations.

   CLAIM FLOOR: the plan may carry an earliest claiming age to
   consider (claimAgeFloor, 62–70; absent / null = no floor).
   The floor changes only which candidate is CROWNED: the
   winner is the best fully-priced candidate whose primary
   claiming age is at or above the floor, and the runners-up
   are the next-best eligible candidates. Every age is still
   priced and still shown in the per-age table — below-floor
   rows are marked, not hidden — and Do Nothing (the best Do
   Nothing found, at its own best claiming ages) is unchanged.
   With no floor the crowning is the plain best-first order,
   bit for bit as before. When no candidate can meet the floor
   (a locked claim below it, or the single-combination path),
   the same plain-best winner is still crowned, but the result
   reports the conflict honestly (build v56): the joint
   result's claimAgeFloorMet is false and the result note
   states the conflict plainly instead of asserting the winner
   meets the floor. */

export type JointSearchInfo = {
  searchedPrimary: boolean;
  searchedSpouse: boolean;
  // Declared "No benefit" flags for either person (generic,
  // symmetric). A declared person is never searched — there is
  // no benefit to search — but the result note states that as a
  // settled fact, distinct from the blank / not-entered case.
  declaredPrimary: boolean;
  declaredSpouse: boolean;
  combosTested: number;
  screenStrategiesPerCombo: number;
  finalistCombos: number;
  // The earliest claiming age the winner may use (62–70), or
  // null when no floor is set. Optional on the type so a plain
  // info literal (the fixtures' note-copy cases) needs no key:
  // absent reads exactly as null.
  claimAgeFloor?: number | null;
  // Round-7 Build 3 (N-1): a searched person whose benefit had
  // already started at plan start is LOCKED at their entered
  // claim age — the search kept that age as their only
  // candidate. Optional for the same literal reason as the
  // floor: absent = nobody locked, and the note copy is then
  // exactly the pre-build wording.
  lockedPrimary?: boolean;
  lockedSpouse?: boolean;
  lockedPrimaryAge?: number | null;
  lockedSpouseAge?: number | null;
  // The claiming ages actually searched for each person whose
  // age varied (small-fry copy pass, 2026-10-21): the attainable
  // candidate list from claimAgeCombos. Since N-1 a
  // not-yet-claimed person's list starts at their current age,
  // so the result note quotes these ages instead of asserting
  // the full 62–70 grid. Set only for a varied person (a locked
  // or unsearched person has no searched ages). Optional for
  // the same literal reason as the lock fields: absent = the
  // full 62–70 grid, and the note copy is then exactly the
  // pre-pass wording.
  searchedPrimaryAges?: number[];
  searchedSpouseAges?: number[];
  // The plan's draw order, kept by every combination the joint
  // search prices — named in the result note.
  drawOrderLabel: string;
  // Floor-conflict honesty (build v56): whether the crowned
  // winner meets the claiming-age floor, the winner's primary
  // claiming age, whether the winner is the floor-exempt Do
  // Nothing benchmark, and whether the claim-age table is
  // empty. Set by computeJointOptimizer after crowning so
  // jointSearchNote can state a conflict plainly instead of
  // asserting compliance, and can avoid referencing per-age
  // table markings when there is no table. Optional for the
  // same literal reason as the floor: absent = no conflict
  // information, and the note then keeps its prior wording
  // (except that an absent table state never claims markings
  // exist when a floor sentence is built from a plain literal
  // — see jointSearchNote).
  claimAgeFloorMet?: boolean | null;
  winnerPrimaryAge?: number | null;
  winnerIsDoNothing?: boolean;
  claimAgeTableEmpty?: boolean;
};

// One row of the per-claiming-age pricing table: the best
// FULLY-priced candidate found at one primary claiming age, the
// yearly benefit that age pays, and the yearly benefit a
// surviving spouse would keep at that age — the amount the
// engine's survivor years continue. Under the simplified rule
// it is the larger of the two claimed benefits under the row's
// best candidate; under the enhanced mode (a survivor scenario
// with an explicit survivorClaimAge) it is the SSA survivor
// benefit at that claiming age, priced through
// survivorBenefitAnnualEnhanced. Present only for ages the
// joint search actually varied (the primary's ages 62–70);
// empty when the primary's claiming age was not searched.
export type ClaimAgeRow = {
  primaryAge: number;
  primaryAnnual: number;
  survivorAnnual: number;
  // True when a claim floor is set and this age sits below it:
  // the row is priced and shown, but its candidates cannot be
  // crowned.
  belowFloor: boolean;
  // True when this row's best candidate is the crowned winner.
  isWinner: boolean;
  best: ScoredCandidate;
};

export type JointOptimizerResult = OptimizerResult & {
  jointSearch: JointSearchInfo;
  claimAgeTable: ClaimAgeRow[];
  // Floor-conflict honesty (build v56): null when no
  // claimAgeFloor is set; true when the crowned winner's
  // primary claiming age is at or above the floor (or there
  // is no primary claiming age to violate it, or the winner
  // is the floor-exempt Do Nothing benchmark); false when
  // the winner claims below the floor — including the
  // single-combination/locked path and the no-eligible-
  // candidate fallback. The crowning itself is unchanged.
  claimAgeFloorMet: boolean | null;
};

export function claimAgeFloorMetFor(
  floor: number | null,
  winner: ScoredCandidate,
): boolean | null {
  if (floor == null) return null;
  if (winner.spec.key === DO_NOTHING_SPEC.key) return true;
  const age = winner.claimAges.primaryAge;
  if (age == null) return true;
  return age >= floor;
}

type ClaimCombo = {
  inputs: RothPlanInputs;
  claimAges: ClaimAgeInfo;
  isEntered: boolean;
};

export function claimAgeCombos(inputs: RothPlanInputs): ClaimCombo[] {
  const effPrimary = effectiveSsPrimaryAnnual(inputs);
  const effSpouse = effectiveSsSpouseAnnual(inputs);
  const searchedPrimary =
    effPrimary > 0 && inputs.ssPrimaryStartAge != null;
  const searchedSpouse =
    effSpouse > 0 &&
    inputs.ssSpouseStartAge != null &&
    inputs.birthYearSpouse != null;
  // ATTAINABLE claiming ages (Round-7 Build 3, N-1): the search
  // must never recommend changing a claim that is already made,
  // or claiming in the past. Per person, independently:
  //   (a) already receiving at plan start — the entered start
  //       age is at or below the person's age at plan start —
  //       the ONLY candidate is the entered age (locked);
  //   (b) not yet claimed — candidates are the person's current
  //       age or later (the claimAgeFloor still applies on top
  //       of this at crowning time, unchanged).
  const currentAgePrimary = inputs.startYear - inputs.birthYearPrimary;
  const currentAgeSpouse =
    inputs.birthYearSpouse != null
      ? inputs.startYear - inputs.birthYearSpouse
      : null;
  const attainable = (
    searched: boolean,
    entered: number | null,
    currentAge: number | null,
  ): { ages: (number | null)[]; locked: boolean } => {
    if (!searched || entered == null) return { ages: [entered], locked: false };
    if (currentAge != null && entered <= currentAge) {
      return { ages: [entered], locked: true };
    }
    const floorAge = currentAge ?? 62;
    const list = [62, 63, 64, 65, 66, 67, 68, 69, 70].filter(
      (a) => a >= floorAge,
    );
    // The entered age itself stays a candidate when it is a
    // real claiming age outside the 62–70 grid (a claim past
    // 70); an entered age under 62 was never on the grid and
    // is not invented as one.
    if (!list.includes(entered) && entered >= 62) list.push(entered);
    list.sort((x, y) => x - y);
    return { ages: list, locked: false };
  };
  const primaryAtt = attainable(
    searchedPrimary,
    inputs.ssPrimaryStartAge,
    currentAgePrimary,
  );
  const spouseAtt = attainable(
    searchedSpouse,
    inputs.ssSpouseStartAge,
    currentAgeSpouse,
  );
  const combos: ClaimCombo[] = [];
  for (const pAge of primaryAtt.ages) {
    for (const sAge of spouseAtt.ages) {
      const primaryAnnual =
        searchedPrimary && pAge != null
          ? ssAnnualAtClaimAge(
              effPrimary,
              inputs.ssPrimaryStartAge,
              pAge,
              inputs.birthYearPrimary,
            )
          : effPrimary;
      const spouseAnnual =
        searchedSpouse && sAge != null && inputs.birthYearSpouse != null
          ? ssAnnualAtClaimAge(
              effSpouse,
              inputs.ssSpouseStartAge,
              sAge,
              inputs.birthYearSpouse,
            )
          : effSpouse;
      combos.push({
        inputs: {
          ...inputs,
          ssPrimaryAnnual: primaryAnnual,
          ssPrimaryStartAge: pAge,
          ssSpouseAnnual: spouseAnnual,
          ssSpouseStartAge: sAge,
        },
        claimAges: {
          primaryAge: pAge,
          spouseAge: sAge,
          primaryAnnual,
          spouseAnnual,
          searchedPrimary,
          searchedSpouse,
          lockedPrimary: primaryAtt.locked,
          lockedSpouse: spouseAtt.locked,
        },
        isEntered:
          pAge === inputs.ssPrimaryStartAge && sAge === inputs.ssSpouseStartAge,
      });
    }
  }
  return combos;
}

// The stage-1 screening set: Do Nothing plus the representative
// ceilings, on the stop-before-RMDs window when the plan has one.
const SCREEN_CEILINGS: FillCeilings[] = [
  { ...NO_CEILINGS, bracketTopPct: 12 },
  { ...NO_CEILINGS, bracketTopPct: 22 },
  { ...NO_CEILINGS, bracketTopPct: 24 },
  { ...NO_CEILINGS, irmaaTierCap: 0 },
  { ...NO_CEILINGS, irmaaTierCap: 1 },
  { ...NO_CEILINGS, bracketTopPct: 22, irmaaTierCap: 1 },
  { ...NO_CEILINGS, acaCliffCap: true },
  { ...NO_CEILINGS, magiCap: 250000 },
];

function screenSpecs(inputs: RothPlanInputs): OptimizerCandidateSpec[] {
  // Stage-1 screen stays harvest-free (build v56): the
  // screen set is built from the non-harvest candidates only.
  // That is safe ONLY because stage 2 fully prices every
  // combination's full candidate set — harvest twins included,
  // via scoreAllCandidates — so screening cannot influence
  // selection: it only orders the combinations for stage 2,
  // and every combination is fully priced regardless of its
  // screening score. (Verified in computeJointOptimizer: the
  // screened list feeds nothing else — finalists are ALL
  // combinations, and crowning, runners-up, the per-age table,
  // and Do Nothing all read the stage-2 scored set.)
  const all = buildOptimizerCandidates(inputs, [inputs.drawOrder]).filter(
    (s) => !s.guardrail && !s.bunching && !s.gainsHarvest,
  );
  const windowKind: OptimizerWindowKind = all.some((s) => s.windowKind === "stopRmd")
    ? "stopRmd"
    : (all[0]?.windowKind ?? "throughRmd");
  const specs: OptimizerCandidateSpec[] = [];
  for (const ceilings of SCREEN_CEILINGS) {
    const spec = all.find(
      (s) =>
        s.windowKind === windowKind && ceilingsKey(s.ceilings) === ceilingsKey(ceilings),
    );
    if (spec) specs.push(spec);
  }
  return specs;
}

// The claiming-age table's "Survivor keeps / yr" column for one
// row's claim ages: the simplified max() of the two claimed
// benefits, or — when a survivor scenario with an explicit
// claiming age is priced — the enhanced SSA survivor benefit at
// that claiming age, the steady-state amount the march's
// survivor years price once both claim ages are reached (the
// survivor's age here is the later of the survivor claiming age
// and the survivor's own claim age, so both sides are active).
// The anchors are the row's claim-age amounts, the death age is
// the death year minus the deceased's birth year — the same
// mapping the march uses, with the row's claim ages in place of
// the plan's entered ones. Falls back to the simplified max()
// whenever the scenario is incomplete (no death year, no
// claiming age, or a missing birth year), so an unpriced
// scenario never changes a row.
export function claimAgeRowSurvivorAnnual(
  inputs: RothPlanInputs,
  claimAges: ClaimAgeInfo,
): number {
  const simple = Math.max(claimAges.primaryAnnual, claimAges.spouseAnnual);
  const claimAge = inputs.survivorClaimAge;
  if (
    !inputs.survivorEnabled ||
    inputs.survivorDeathYear == null ||
    claimAge == null
  ) {
    return simple;
  }
  const deceasedIsPrimary = (inputs.survivorWho ?? "primary") === "primary";
  const deceasedBirthYear = deceasedIsPrimary
    ? inputs.birthYearPrimary
    : inputs.birthYearSpouse;
  const survivorBirthYear = deceasedIsPrimary
    ? inputs.birthYearSpouse
    : inputs.birthYearPrimary;
  if (deceasedBirthYear == null || survivorBirthYear == null) {
    return simple;
  }
  const survivorOwnAge = deceasedIsPrimary
    ? claimAges.spouseAge
    : claimAges.primaryAge;
  return survivorBenefitAnnualEnhanced({
    deceasedAnchorAnnual: deceasedIsPrimary
      ? claimAges.primaryAnnual
      : claimAges.spouseAnnual,
    deceasedAnchorAge: deceasedIsPrimary
      ? claimAges.primaryAge
      : claimAges.spouseAge,
    deceasedBirthYear,
    deceasedDeathAge: inputs.survivorDeathYear - deceasedBirthYear,
    survivorBirthYear,
    survivorAge: Math.max(claimAge, survivorOwnAge ?? claimAge),
    survivorClaimAge: claimAge,
    ownAnnualThisYear: deceasedIsPrimary
      ? claimAges.spouseAnnual
      : claimAges.primaryAnnual,
  });
}

function computeJointOptimizer(inputs: RothPlanInputs): JointOptimizerResult {
  const combos = claimAgeCombos(inputs);
  const first = combos[0];
  const floor = inputs.claimAgeFloor ?? null;
  const info: JointSearchInfo = {
    searchedPrimary: first?.claimAges.searchedPrimary ?? false,
    searchedSpouse: first?.claimAges.searchedSpouse ?? false,
    declaredPrimary: inputs.ssPrimaryNoBenefit === true,
    declaredSpouse: inputs.ssSpouseNoBenefit === true,
    combosTested: combos.length,
    screenStrategiesPerCombo: SCREEN_CEILINGS.length + 1,
    finalistCombos: 1,
    claimAgeFloor: floor,
    lockedPrimary: first?.claimAges.lockedPrimary === true,
    lockedSpouse: first?.claimAges.lockedSpouse === true,
    lockedPrimaryAge:
      first?.claimAges.lockedPrimary === true ? first.claimAges.primaryAge : null,
    lockedSpouseAge:
      first?.claimAges.lockedSpouse === true ? first.claimAges.spouseAge : null,
    drawOrderLabel: drawOrderLabel(inputs.drawOrder),
  };
  // The ages actually searched for each varied person, quoted
  // by the result note: the distinct candidate ages the
  // combinations carry for that person (the cross product holds
  // each person's full attainable list). A locked person's only
  // candidate is the entered age — not a search — so they get
  // no list, exactly like an unsearched person.
  const distinctAges = (pick: (c: ClaimCombo) => number | null): number[] =>
    [...new Set(combos.map(pick).filter((a): a is number => a != null))].sort(
      (x, y) => x - y,
    );
  if (info.searchedPrimary && !info.lockedPrimary) {
    info.searchedPrimaryAges = distinctAges((c) => c.claimAges.primaryAge);
  }
  if (info.searchedSpouse && !info.lockedSpouse) {
    info.searchedSpouseAges = distinctAges((c) => c.claimAges.spouseAge);
  }
  if (combos.length <= 1) {
    const res = runOptimizer(inputs);
    // Single-combination / locked path (build v56): this
    // path never applied the floor eligibility filter, and it
    // still crowns the same winner — but the floor conflict is
    // now reported honestly via claimAgeFloorMet and the note.
    const met = claimAgeFloorMetFor(floor, res.winner);
    info.claimAgeFloorMet = met;
    info.winnerPrimaryAge = res.winner.claimAges.primaryAge;
    info.winnerIsDoNothing = res.winner.spec.key === DO_NOTHING_SPEC.key;
    info.claimAgeTableEmpty = true;
    return { ...res, jointSearch: info, claimAgeTable: [], claimAgeFloorMet: met };
  }
  // Stage 1 — screen every combination.
  const specs = screenSpecs(inputs);
  info.screenStrategiesPerCombo = specs.length + 1;
  type Screened = {
    combo: ClaimCombo;
    best: number;
    doNothingCost: number;
  };
  const screened: Screened[] = combos.map((combo) => {
    const dnResult = simulateRothPlan(
      combo.inputs,
      {
        id: "none",
        name: "Do Nothing",
        ceilings: null,
      },
      undefined,
      { leanDetail: true },
    );
    const doNothingCost = planNetCost(dnResult, inputs).netCost;
    let best = doNothingCost;
    for (const spec of specs) {
      const candidateInputs =
        spec.windowStopAge === combo.inputs.windowStopAge
          ? combo.inputs
          : { ...combo.inputs, windowStopAge: spec.windowStopAge };
      const result = simulateRothPlan(candidateInputs, candidateStrategy(spec), undefined, {
        leanDetail: true,
      });
      const cost = planNetCost(result, inputs).netCost;
      if (cost < best) best = cost;
    }
    return { combo, best, doNothingCost };
  });
  // Stage 2 — EVERY combination gets the full strategy set, in
  // screening order, so each primary claiming age ends with a
  // genuine fully-priced best for the per-age table.
  const byScreen = [...screened].sort(
    (a, b) =>
      a.best - b.best ||
      (a.combo.claimAges.primaryAge ?? 0) - (b.combo.claimAges.primaryAge ?? 0) ||
      (a.combo.claimAges.spouseAge ?? 0) - (b.combo.claimAges.spouseAge ?? 0),
  );
  const finalists: ClaimCombo[] = byScreen.map((s) => s.combo);
  info.finalistCombos = finalists.length;

  const scoredAll: ScoredCandidate[] = [];
  for (const combo of finalists) {
    scoredAll.push(
      ...scoreAllCandidates(combo.inputs, combo.claimAges, { searchOrders: false }),
    );
  }
  // The winner ordering (N-3): lowest net cost, ending wealth
  // breaking exact cost ties, then the existing tie-breaks —
  // Do Nothing first, the candidate key, and the claiming
  // ages. The per-age table's bests and the Do Nothing pick
  // below read this same order, so every "best" the joint
  // search reports is crowned the same way.
  scoredAll.sort(compareJointCandidates);
  // Crowning. With no floor the winner is the best candidate
  // found, exactly as before. With a floor, the winner is the
  // best candidate whose primary claiming age is at or above
  // it (a candidate with no primary claiming age — no benefit
  // entered — is never excluded by the floor); if somehow no
  // candidate qualifies, the plain best is crowned rather than
  // none. E4-S1/E4-S2: crowning runs over the eligible VALID
  // candidates — a materially unsettled candidate cannot win
  // the joint search either — and both objective winners are
  // named, with any excluded raw winner disclosed.
  const eligible =
    floor == null
      ? scoredAll
      : scoredAll.filter(
          (s) => s.claimAges.primaryAge == null || s.claimAges.primaryAge >= floor,
        );
  // The no-eligible-candidate fallback (documented on the
  // runRothOptimizer action): a locked primary claim below the
  // floor can leave `eligible` empty — crown over the plain
  // best instead of crowning nothing (crownOptimizerWinners
  // requires a non-empty list). claimAgeFloorMet then reports
  // false and the note states the conflict.
  const crowned = crownOptimizerWinners(
    eligible.length > 0 ? eligible : scoredAll,
  );
  const winner = crowned.selectedWinner;
  const winnerByNetCost = crowned.winnerByNetCost;
  const winnerByEndingWealth = crowned.winnerByEndingWealth;
  // Re-derive the wealth winner over the eligible set when the
  // crowning above had to fall back to the raw winner (no valid
  // candidate): crownOptimizerWinners already did that over the
  // same eligible list, so no second pass is needed here.
  // Do Nothing for the joint result is the best Do Nothing found
  // — evaluated at its own best claiming ages (it is one of the
  // combinations by construction), not at the entered ages. The
  // floor never moves it: it is the "change nothing" benchmark.
  const doNothing =
    scoredAll
      .filter((s) => s.spec.key === DO_NOTHING_SPEC.key)
      .sort(compareJointCandidates)[0] ?? winner;
  const runnersUp: ScoredCandidate[] = [];
  for (const s of eligible) {
    if (runnersUp.length >= 3) break;
    // E6 NICEs fix: optional chain — no assessment attached
    // is never an invalid verdict (see crownOptimizerWinners).
    if (s.integrity?.status === "invalid") continue;
    if (
      s.spec.key === winner.spec.key &&
      s.claimAges.primaryAge === winner.claimAges.primaryAge &&
      s.claimAges.spouseAge === winner.claimAges.spouseAge
    ) {
      continue;
    }
    runnersUp.push(s);
  }
  // The per-claiming-age table: for each primary age the search
  // varied, the best fully-priced candidate at that age.
  // scoredAll is sorted best-first, so the first candidate seen
  // at an age is that age's best.
  const claimAgeTable: ClaimAgeRow[] = [];
  if (info.searchedPrimary) {
    const bestByAge = new Map<number, ScoredCandidate>();
    for (const s of scoredAll) {
      const age = s.claimAges.primaryAge;
      if (age == null || bestByAge.has(age)) continue;
      bestByAge.set(age, s);
    }
    for (const age of [...bestByAge.keys()].sort((a, b) => a - b)) {
      const best = bestByAge.get(age)!;
      claimAgeTable.push({
        primaryAge: age,
        primaryAnnual: best.claimAges.primaryAnnual,
        survivorAnnual: claimAgeRowSurvivorAnnual(inputs, best.claimAges),
        belowFloor: floor != null && age < floor,
        isWinner: best === winner,
        best,
      });
    }
  }
  const met = claimAgeFloorMetFor(floor, winner);
  info.claimAgeFloorMet = met;
  info.winnerPrimaryAge = winner.claimAges.primaryAge;
  info.winnerIsDoNothing = winner.spec.key === DO_NOTHING_SPEC.key;
  info.claimAgeTableEmpty = claimAgeTable.length === 0;
  return {
    candidatesTested: scoredAll.length,
    validCandidatesTested: crowned.validCandidatesTested,
    invalidCandidatesTested: crowned.invalidCandidatesTested,
    doNothing,
    winner,
    selectedWinner: crowned.selectedWinner,
    winnerByNetCost,
    winnerByEndingWealth,
    winnersDiffer: crowned.winnersDiffer,
    winnerQualified: crowned.winnerQualified,
    excludedInvalidWinner: crowned.excludedInvalidWinner,
    objective: OPTIMIZER_OBJECTIVE,
    searchScope: describeOptimizerSearchScope(inputs, {
      searchOrders: false,
      claimingAgesSearched: true,
      combosTested: combos.length,
    }),
    runnersUp,
    scored: scoredAll,
    jointSearch: info,
    claimAgeTable,
    claimAgeFloorMet: met,
  };
}

/* Memoized joint search. The joint optimizer is a pure,
   deterministic function of its plan inputs, and several
   callers (notably the accuracy fixtures' golden work-years
   cases) price the identical plan shape more than once in one
   process. Keying on a stable serialization of the FULL inputs
   and returning a deep clone of the stored result keeps every
   result bit-identical to a fresh search while skipping the
   duplicate work. The stored copy is never handed out, so a
   caller mutating its result cannot poison the cache. Bounded:
   the cache clears when it grows past 50 entries. */
const jointOptimizerCache = new Map<string, JointOptimizerResult>();
// Cache key for the joint search: a stable serialization of the FULL
// inputs with keys sorted recursively. Non-finite numbers get distinct
// object tokens — plain JSON.stringify maps NaN, Infinity, and
// -Infinity all to `null`, so without this a NaN run and a null run
// key identically and the second call is served the first call's
// result (Engine Review C7, A4: a null call after a NaN run returned
// the NaN run's NaN netCost in hit time, while a fresh null run
// prices finite). The tokens are objects, not bare strings, so a
// genuine string field can never collide with one; every finite
// value serializes exactly as before, so valid inputs hit the cache
// bit-identically to the pre-fix key. (Engine Review C6, §7 addressed
// the same collision with string sentinels; the object tokens here
// supersede them — a literal string field could have collided with a
// sentinel — which also closes C6's NICE-2.)
export function jointInputsKey(inputs: RothPlanInputs): string {
  const sortValue = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortValue);
    if (v != null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = sortValue((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  const nonFiniteReplacer = (_key: string, value: unknown): unknown => {
    if (typeof value === "number") {
      if (Number.isNaN(value)) return { __c7NonFinite__: "NaN" };
      if (value === Infinity) return { __c7NonFinite__: "Infinity" };
      if (value === -Infinity) return { __c7NonFinite__: "-Infinity" };
    }
    return value;
  };
  return JSON.stringify(sortValue(inputs), nonFiniteReplacer);
}
export function runJointOptimizer(inputs: RothPlanInputs): JointOptimizerResult {
  const key = jointInputsKey(inputs);
  const hit = jointOptimizerCache.get(key);
  if (hit) return structuredClone(hit);
  const result = computeJointOptimizer(inputs);
  if (jointOptimizerCache.size >= 50) jointOptimizerCache.clear();
  jointOptimizerCache.set(key, structuredClone(result));
  return result;
}

// Plain-language statement of what the joint search covered, for
// the optimizer result card. Wording is household-neutral for the
// declared "No benefit" cases (generic for any household); the
// blank / not-entered cases keep their exact prior wording, so an
// undeclared record's copy does not move. A declared person is
// never described as a missing input: the note states the settled
// fact — that person has no benefit, so there is no claiming age
// to search for them. The searched branches quote the claiming
// ages the search actually covered (info.searched*Ages): a
// benefit already being paid is locked at its entered age and
// not searched, and a not-yet-claimed person's ages start at
// their current age — the note never describes the search as
// covering ages it did not.
export function jointSearchNote(info: JointSearchInfo): string {
  const declaredPrimary = info.declaredPrimary === true;
  const declaredSpouse = info.declaredSpouse === true;
  // How the full pricing is described: when every screened
  // combination was priced against the full strategy set (the
  // search's normal shape), say so; a partial finalist count
  // keeps the older phrasing.
  const pricedPhrase =
    info.finalistCombos >= info.combosTested
      ? "every combination priced against the full strategy set"
      : `the best ${info.finalistCombos} priced against the full strategy set`;
  // The claim floor's effect, in plain words, when one is set.
  // Floor-conflict honesty (build v56): when the crowned
  // winner claims below the floor (claimAgeFloorMet === false),
  // the note states the conflict plainly — naming the floor and
  // the winner's actual primary claiming age, and the locked
  // reason when the claim is locked — and never carries the
  // compliance assertion. When the floor is met, the prior
  // wording stands, except that the per-age-table marking
  // clause is included only when a claim-age table exists:
  // the note never references below-floor markings in a table
  // when the table is empty, in any case. For a plain info
  // literal with no conflict information, an absent table
  // state is inferred from the searched flags (a searched
  // primary produces a table in a real run); a literal that
  // sets claimAgeTableEmpty explicitly governs.
  // Floor-exempt Do Nothing winner below the floor (contract
  // v107, round-15 F3): claimAgeFloorMetFor deliberately
  // returns true for Do Nothing (the floor exemption — Do
  // Nothing stays eligible and can still win), so a met floor
  // must NOT be read as proof the winning claim is at or
  // after the floor. When the winner is Do Nothing claiming
  // below the floor, the note states the actual claiming age
  // and the exemption plainly, and never carries the
  // compliance assertion — the same plain-conflict treatment
  // a locked non-Do-Nothing winner below the floor gets,
  // extended to the exempt winner. A Do Nothing winner at or
  // above the floor, and every non-Do-Nothing path, keep the
  // wording below exactly.
  const floorMet: boolean | null =
    info.claimAgeFloor == null
      ? null
      : info.claimAgeFloorMet !== undefined
        ? info.claimAgeFloorMet
        : info.winnerPrimaryAge != null
          ? info.winnerIsDoNothing === true || info.winnerPrimaryAge >= info.claimAgeFloor
          : true;
  const exemptBelowFloor =
    info.winnerIsDoNothing === true &&
    info.claimAgeFloor != null &&
    info.winnerPrimaryAge != null &&
    info.winnerPrimaryAge < info.claimAgeFloor;
  const tableEmpty =
    info.claimAgeTableEmpty !== undefined
      ? info.claimAgeTableEmpty
      : !info.searchedPrimary;
  const floorSentence =
    info.claimAgeFloor == null
      ? ""
      : exemptBelowFloor
        ? ` Your earliest claiming age to consider is ${info.claimAgeFloor}, but the winner is Do Nothing, which claims at ${info.winnerPrimaryAge}, below your floor — Do Nothing is exempt from the floor, so it can still win even though its claiming age is below the floor.`
        : floorMet === false
          ? ` Your earliest claiming age to consider is ${info.claimAgeFloor}, but the winner claims at ${info.winnerPrimaryAge ?? "an age below it"}, below your floor — the winner does not meet your floor.${info.lockedPrimary === true ? ` That claim is locked at ${info.winnerPrimaryAge} because the benefit has already started, so the entered age cannot move.` : ""}`
          : tableEmpty
            ? ` Your earliest claiming age to consider is ${info.claimAgeFloor}: the winner is the best strategy at a claiming age of ${info.claimAgeFloor} or later.`
            : ` Your earliest claiming age to consider is ${info.claimAgeFloor}: the winner is the best strategy at a claiming age of ${info.claimAgeFloor} or later, and the younger ages in the table below are marked as below your floor.`;
  // Locked claiming ages (N-1), in plain words, when a benefit
  // had already started at plan start. Empty when nobody is
  // locked, so an unlocked record's note is exactly as before.
  const lockedPrimary = info.lockedPrimary === true;
  const lockedSpouse = info.lockedSpouse === true;
  const lockedSentence =
    lockedPrimary && lockedSpouse
      ? ` Your claiming age is locked at ${info.lockedPrimaryAge} and your spouse's at ${info.lockedSpouseAge} because those benefits have already started — a claim that is already being paid cannot be changed, so the search kept both ages exactly as entered.`
      : lockedPrimary
        ? ` Your claiming age is locked at ${info.lockedPrimaryAge} because your benefit has already started — a claim that is already being paid cannot be changed, so the search kept it exactly as entered.`
        : lockedSpouse
          ? ` Your spouse's claiming age is locked at ${info.lockedSpouseAge} because their benefit has already started — a claim that is already being paid cannot be changed, so the search kept it exactly as entered.`
          : "";
  if (!info.searchedPrimary && !info.searchedSpouse) {
    // A floor conflict is stated even on this branch (v56),
    // and so is the exempt-below-floor Do Nothing statement
    // (v107); a met or unset floor keeps the prior wording
    // exactly.
    const conflictSuffix = floorMet === false || exemptBelowFloor ? floorSentence : "";
    if (declaredPrimary && declaredSpouse) {
      return `Neither person has a Social Security benefit — both are marked as having no benefit — so there are no claiming ages to search. The strategies above were priced with no Social Security benefit for either person, with all six draw orders searched as part of the strategy set.${conflictSuffix}`;
    }
    if (declaredSpouse && !declaredPrimary) {
      return `The spouse has no Social Security benefit, and the primary person's benefit hasn't been entered yet, so there were no claiming ages to search — the strategies above were priced at the entered ages, with all six draw orders searched as part of the strategy set.${conflictSuffix}`;
    }
    if (declaredPrimary && !declaredSpouse) {
      return `The primary person has no Social Security benefit, and the spouse's benefit hasn't been entered yet, so there were no claiming ages to search — the strategies above were priced at the entered ages, with all six draw orders searched as part of the strategy set.${conflictSuffix}`;
    }
    return `No Social Security benefit is entered, so there were no claiming ages to search — the strategies above were priced at the entered ages, with all six draw orders searched as part of the strategy set.${conflictSuffix}`;
  }
  // Every searched benefit is locked (N-1): no claiming age
  // was actually varied, so the note says so plainly instead
  // of describing a 62–70 search that never happened.
  const variedPrimary = info.searchedPrimary && !lockedPrimary;
  const variedSpouse = info.searchedSpouse && !lockedSpouse;
  // The ages a varied person's claiming age was searched over,
  // quoted exactly: since N-1 the attainable list starts at
  // the person's current age when they are past 62, so the
  // pre-N-1 "every age 62–70" claim is only made when the list
  // really is the full grid (an absent list reads as the full
  // grid, per the JointSearchInfo contract). A contiguous list
  // quotes as its end ages; a list with a gap (an entered claim
  // age past 70 rides along above the grid) is enumerated, so
  // the note never claims an age was searched that was not.
  const rangePhrase = (ages: number[] | undefined): string => {
    const list =
      ages && ages.length > 0 ? ages : [62, 63, 64, 65, 66, 67, 68, 69, 70];
    const first = list[0]!;
    const last = list[list.length - 1]!;
    if (list.length === 1) return `at age ${first}`;
    const contiguous = list.every((a, i) => i === 0 || a === list[i - 1]! + 1);
    if (contiguous) return `over every age ${first}–${last}`;
    return `over ages ${list.slice(0, -1).join(", ")} and ${last}`;
  };
  // The "whose claiming age, over which ages" clause for a
  // searched branch: one shared span when both people varied
  // over the same ages, otherwise each person's own span.
  const searchedClause = (
    primaryLabel: string,
    spouseLabel: string,
    bothLabel: string,
  ): string => {
    if (variedPrimary && variedSpouse) {
      const primaryRange = rangePhrase(info.searchedPrimaryAges);
      const spouseRange = rangePhrase(info.searchedSpouseAges);
      return primaryRange === spouseRange
        ? `${bothLabel} ${primaryRange}`
        : `${primaryLabel} ${primaryRange} and ${spouseLabel} ${spouseRange}`;
    }
    if (variedPrimary) {
      return `${primaryLabel} ${rangePhrase(info.searchedPrimaryAges)}`;
    }
    return `${spouseLabel} ${rangePhrase(info.searchedSpouseAges)}`;
  };
  if (!variedPrimary && !variedSpouse) {
    return `No claiming ages were searched.${lockedSentence} The strategies above were priced at the entered claiming ages, with all six draw orders searched as part of the strategy set.${floorSentence}`;
  }
  // At least one benefit was searched. When the unsearched person
  // is declared, use neutral labels throughout and the settled-fact
  // sentence; otherwise keep the prior wording exactly.
  if ((info.searchedPrimary && declaredSpouse) || (info.searchedSpouse && declaredPrimary)) {
    const settled = info.searchedPrimary && declaredSpouse
      ? " The spouse has no Social Security benefit, so there is no second claiming age to search."
      : " The primary person has no Social Security benefit, so there is no second claiming age to search.";
    return `Claiming ages were searched jointly with the conversion strategies: ${searchedClause("the primary person's claiming age", "the spouse's claiming age", "both people's claiming ages")} (${info.combosTested} combinations screened, ${pricedPhrase}).${settled} Every combination kept your draw order (${info.drawOrderLabel}) — draw order itself is searched at your entered claiming ages, in the draw-order result below.${floorSentence}`;
  }
  const notSearched = info.searchedPrimary && !info.searchedSpouse
    ? " The spouse's Social Security isn't entered, so their claiming age wasn't searched."
    : !info.searchedPrimary && info.searchedSpouse
      ? " Your Social Security isn't entered, so your claiming age wasn't searched."
      : "";
  return `Claiming ages were searched jointly with the conversion strategies: ${searchedClause("your claiming age", "the spouse's claiming age", "both spouses' claiming ages")} (${info.combosTested} combinations screened, ${pricedPhrase}).${notSearched} Every combination kept your draw order (${info.drawOrderLabel}) — draw order itself is searched at your entered claiming ages, in the draw-order result below.${lockedSentence}${floorSentence}`;
}

// Re-run the whole search at a different expected return (the
// sensitivity strip). Only the winner summary is used — the
// saved plan is never touched. The strip holds the plan's draw
// order (searchOrders: false): it is a sensitivity check on the
// strategy search at the entered claiming ages and the plan's
// order, not a second draw-order search.
export function optimizerSensitivity(
  inputs: RothPlanInputs,
  deltaPct: number,
): { returnPct: number; winner: ScoredCandidate } {
  const shifted = { ...inputs, expectedReturnPct: inputs.expectedReturnPct + deltaPct };
  const res = runOptimizer(shifted, { searchOrders: false });
  return { returnPct: shifted.expectedReturnPct, winner: res.winner };
}

// Re-run the whole search at a different heir rate (the
// heir-rate sensitivity strip). The heir rate enters the
// objective only through the terminal tax on the pre-tax
// balance still standing at the plan's end age, so a higher heir
// rate makes converting more attractive — this strip shows
// whether the WINNER (not just its price) depends on the rate
// assumed. Same candidate set, same guardrail / bunching
// variants, same everything except heirRatePct; the winner and
// the Do Nothing score both come from that real run. Like the
// return strip, it holds the plan's draw order. Display only —
// the saved plan is never touched.
export function optimizerHeirSensitivity(
  inputs: RothPlanInputs,
  heirRatePct: number,
): { heirRatePct: number; winner: ScoredCandidate; doNothing: ScoredCandidate } {
  const shifted = { ...inputs, heirRatePct };
  const res = runOptimizer(shifted, { searchOrders: false });
  return { heirRatePct, winner: res.winner, doNothing: res.doNothing };
}

/* ---------------- Monte Carlo market-uncertainty check --------
   The optimizer picks its winner under the plan's single
   expected-return assumption. This check stress-tests that
   winner: it re-prices the winning STRATEGY (its ceilings
   re-solve year by year under each path — never frozen dollar
   conversions) and Do Nothing under many varied return paths,
   both candidates priced from the SAME series on each path
   (paired paths), and reports how robust the win is: the share
   of paths where the winner still beats Do Nothing on the
   optimizer's own objective (netCostBreakdown's net cost), the
   median and 10th–90th percentile dollar advantage (Do Nothing
   cost − winner cost), and the median net cost of each side.

   Return draws mirror runMonteCarlo in retirementEngines.ts
   exactly: one mulberry32 stream seeded `seed * 7919 + 17` for
   the whole batch, Box–Muller normals, per-year return pct =
   expectedReturnPct + volatilityPct * z. For each path in
   order the full series is drawn first, then BOTH candidates
   are priced from that same series array. The seed is fixed
   (ROTH_MC_CHECK_SEED), so the same inputs always reproduce the
   same figures — it is the same fixed set of paths every run,
   not a fresh random draw. */

// The fixed stream seed for the check: same inputs reproduce
// the same figures on re-run.
export const ROTH_MC_CHECK_SEED = 12345;
// Path count, sized by measurement: one simulateRothPlan call
// on a realistic funded plan (MFJ, retire 57, end 95,
// seven-figure balances) costs ≈0.8 ms for a ceiling strategy
// and ≈0.4 ms for Do Nothing; the slowest realistic winner
// shape (a marginal-rate-guardrail strategy under an enabled
// survivor scenario) costs ≈56 ms. The check runs 2 × paths
// simulations, so 250 paths finish in well under a second on a
// typical plan and ≈15 s even in that slowest shape — clearly
// under the optimizer's own ~40–50 s and the ~30 s budget.
export const ROTH_MC_CHECK_PATHS = 250;

// Fixed stream stride for runRothMonteCarloStats (F3,
// batch-independent streams) and, since build v110 (round-16
// F2), for runRothMonteCarloCheck as well: both runs draw
// exactly this many standardized shocks per path from the
// shared stream, whatever scenarios are in the call, so a
// scenario's trial streams — and therefore its statistics —
// are identical whether it is priced alone or batched with
// longer- or shorter-horizon companions, and the check and
// the stats action sample the SAME paths for an identical
// strategy, volatility, horizon, and seed. Within-call pairing
// is preserved: every scenario still consumes its own prefix
// of the same per-path vector. 160 covers the longest horizon
// the schemas permit (endAge max 130, earliest current age
// 0 → 131 years) with headroom. Trial 0's shocks are
// unchanged from the old discipline — the stream starts
// identically; only the per-path consumption count is fixed.
export const MC_STREAM_STRIDE_YEARS = 160;

// mulberry32 + Box–Muller, imported from retirementEngines.ts
// (Engine Review C5, C5-S2): the Roth stream helpers are the
// same primitives runMonteCarlo draws with — one implementation,
// one sequence — not a replication. The names stay local aliases
// so the stream helpers below read unchanged, and the drawn
// sequence is bit-identical to the replicated pair (pinned by the
// mc-golden-shocks fixture's externally computed shock literals).
const mcMulberry32 = sharedMulberry32;
const mcNormalRandom = sharedNormalRandom;

// The check's random stream: one mulberry32 seeded
// `seed * 7919 + 17`, the runMonteCarlo convention.
export function rothMcStream(seed: number): () => number {
  validateMonteCarloSeed(seed);
  return mcMulberry32(seed * 7919 + 17);
}

// `years` standardized normals, drawn via mcNormalRandom(rng)
// in year order — the exact draw sequence rothMcReturnSeries
// performs.
export function rothMcShockSeries(years: number, rng: () => number): number[] {
  const out: number[] = [];
  for (let i = 0; i < years; i++) {
    out.push(mcNormalRandom(rng));
  }
  return out;
}

// One path's per-year real-return series (percents), drawn from
// `rng` in year order. Series length = the number of simulated
// years (endAgePrimary − age at startYear + 1); index = year −
// startYear, the simulateRothPlan series convention.
export function rothMcReturnSeries(
  inputs: RothPlanInputs,
  volatilityPct: number,
  rng: () => number,
): number[] {
  const years =
    inputs.endAgePrimary - (inputs.startYear - inputs.birthYearPrimary) + 1;
  const z = rothMcShockSeries(years, rng);
  return z.map((zi) => inputs.expectedReturnPct + volatilityPct * zi);
}

// Median and percentile with the SAME convention as
// retirementEngines' medianOf / percentile — the median is the
// middle value of a sorted copy (or the mean of the two middle
// values), and percentile p reads index floor(p/100 × n) of the
// sorted values, clamped to the ends. Imported from
// retirementEngines (Engine Review C5, C5-S2) rather than
// replicated: the conventions are identical, so the shared
// helpers price bit-identically here.
const mcMedianOf = sharedMedianOf;
const mcPercentile = sharedPercentile;

// ----- Monte Carlo input validation (Engine Review C5, C5-M1) -----
// The Roth entry points used to accept any path count, seed, and
// volatility: pathCount 0 / negative returned a successful result
// (the check) or ok:true (the stats run) with zero-value summary
// statistics, a fractional count silently ran ceil(N) paths, a
// NaN seed silently drew the seed-0 stream, and a NaN volatility
// priced NaN costs while the shortfall rates still read 100%.
// The API actions already fix pathCount at ROTH_MC_CHECK_PATHS
// (250) and seed at ROTH_MC_CHECK_SEED (12345) and zod-validate
// volatility 0–100, so these guards are defense in depth at the
// core and change no valid call. The bound is 4× the 250-path
// API default. The check throws (it has no ok:false channel);
// the stats run returns { ok: false, reason } — its existing
// error channel, which the API handler forwards directly.
export const MAX_ROTH_MONTE_CARLO_PATHS = 1000;
function invalidRothMcOptsReason(opts: {
  volatilityPct: number;
  pathCount: number;
  seed: number;
}): string | null {
  if (
    !Number.isInteger(opts.pathCount) ||
    opts.pathCount < 1 ||
    opts.pathCount > MAX_ROTH_MONTE_CARLO_PATHS
  ) {
    return `The Monte Carlo path count must be a whole number from 1 to ${MAX_ROTH_MONTE_CARLO_PATHS}, got ${opts.pathCount}.`;
  }
  if (!Number.isInteger(opts.seed)) {
    return `Monte Carlo seed must be a finite integer, got ${opts.seed}.`;
  }
  if (
    !Number.isFinite(opts.volatilityPct) ||
    opts.volatilityPct < 0 ||
    opts.volatilityPct > 100
  ) {
    return `Monte Carlo volatility must be between 0 and 100 percent, got ${opts.volatilityPct}.`;
  }
  return null;
}

// Price one candidate under one return series, mirroring
// scoreAllCandidates EXACTLY: the candidate's claiming ages are
// folded into comboInputs; Do Nothing (spec.key ===
// DO_NOTHING_SPEC.key) prices as the engine's ceilings-null
// strategy; any other candidate prices its strategy at its own
// window stop / draw order unless they already match the plan's.
// The score is the optimizer's objective at the plan's heir rate.
function priceMcCandidate(
  inputs: RothPlanInputs,
  candidate: { spec: OptimizerCandidateSpec; claimAges: ClaimAgeInfo },
  series: readonly number[],
): number {
  const { spec, claimAges } = candidate;
  const comboInputs: RothPlanInputs = {
    ...inputs,
    ssPrimaryAnnual: claimAges.primaryAnnual,
    ssPrimaryStartAge: claimAges.primaryAge,
    ssSpouseAnnual: claimAges.spouseAnnual,
    ssSpouseStartAge: claimAges.spouseAge,
  };
  if (spec.key === DO_NOTHING_SPEC.key) {
    const result = simulateRothPlan(
      comboInputs,
      { id: "none", name: "Do Nothing", ceilings: null },
      series,
    );
    return planNetCost(result, inputs).netCost;
  }
  const candidateInputs =
    spec.windowStopAge === comboInputs.windowStopAge &&
    drawOrderKey(spec.drawOrder) === drawOrderKey(comboInputs.drawOrder)
      ? comboInputs
      : { ...comboInputs, windowStopAge: spec.windowStopAge, drawOrder: spec.drawOrder };
  const result = simulateRothPlan(candidateInputs, candidateStrategy(spec), series);
  return planNetCost(result, inputs).netCost;
}

export type RothMcCheckPath = {
  winnerCost: number;
  doNothingCost: number;
  advantage: number; // doNothingCost − winnerCost; > 0 = the winner won the path
};

export type RothMcCheckResult = {
  pathsRun: number;
  wins: number;
  winRatePct: number; // one decimal
  medianAdvantage: number;
  p10Advantage: number;
  p90Advantage: number;
  winnerMedianNetCost: number;
  doNothingMedianNetCost: number;
  // Per-path detail, in path order — the fixtures pin pairing
  // and the zero-volatility identity against it.
  paths: RothMcCheckPath[];
};

export function runRothMonteCarloCheck(
  inputs: RothPlanInputs,
  winner: { spec: OptimizerCandidateSpec; claimAges: ClaimAgeInfo },
  doNothing: { spec: OptimizerCandidateSpec; claimAges: ClaimAgeInfo },
  opts: { volatilityPct: number; pathCount: number; seed: number },
): RothMcCheckResult {
  // C5-M1: a 0-path check must not return zero-value statistics.
  const optsError = invalidRothMcOptsReason(opts);
  if (optsError) throw new RangeError(optsError);
  const rng = rothMcStream(opts.seed);
  const paths: RothMcCheckPath[] = [];
  // The plan's horizon in years — the prefix of each path's
  // shock vector this check consumes.
  const years =
    inputs.endAgePrimary - (inputs.startYear - inputs.birthYearPrimary) + 1;
  for (let i = 0; i < opts.pathCount; i++) {
    // Draw the fixed-stride shock vector first (build v110,
    // round-16 F2: the same MC_STREAM_STRIDE_YEARS stride the
    // stats run draws), then price BOTH candidates from the
    // horizon prefix of that same vector — paired paths by
    // construction, and the same paths the stats action samples
    // for an identical strategy, volatility, horizon, and seed.
    const z = rothMcShockSeries(MC_STREAM_STRIDE_YEARS, rng);
    const series = z
      .slice(0, Math.max(0, years))
      .map((zi) => inputs.expectedReturnPct + opts.volatilityPct * zi);
    const winnerCost = priceMcCandidate(inputs, winner, series);
    const doNothingCost = priceMcCandidate(inputs, doNothing, series);
    paths.push({
      winnerCost,
      doNothingCost,
      advantage: r2(doNothingCost - winnerCost),
    });
  }
  const wins = paths.filter((p) => p.advantage > 0).length;
  const sortedAdvantages = paths.map((p) => p.advantage).sort((a, b) => a - b);
  return {
    pathsRun: paths.length,
    wins,
    winRatePct:
      paths.length > 0 ? Math.round((wins / paths.length) * 1000) / 10 : 0,
    medianAdvantage: r2(mcMedianOf(sortedAdvantages)),
    p10Advantage: r2(mcPercentile(sortedAdvantages, 10)),
    p90Advantage: r2(mcPercentile(sortedAdvantages, 90)),
    winnerMedianNetCost: r2(mcMedianOf(paths.map((p) => p.winnerCost))),
    doNothingMedianNetCost: r2(mcMedianOf(paths.map((p) => p.doNothingCost))),
    paths,
  };
}

/* ---------------- Monte Carlo stats for arbitrary scenarios ----
   The sibling of the market-uncertainty check above. Where the
   check prices exactly two OPTIMIZER candidates and keeps only
   each path's net cost, this prices any list of COMPARE
   scenarios — the buildCompareScenario construction, so
   ceilings patches, draw orders, basis tiers and the rest of
   the saved shape all price exactly as runRothCompare prices
   them — on the same paired fixed stream, and keeps the
   per-path detail the check discards: whether the path ever ran
   a spending shortfall, the path's total shortfall, and its
   ending after-tax wealth / ending pre-tax / net cost.

   Pairing and batch independence: one rng stream
   (rothMcStream(seed)); per path a shared standardized shock
   vector of exactly MC_STREAM_STRIDE_YEARS (160) shocks is
   drawn ONCE — a fixed stride, whatever scenarios are in the
   call — then every scenario is priced from its own prefix
   of those shocks centered on its own expected return (each
   scenario's series value is its own expectedReturnPct plus
   volatilityPct × the shared shock). Paired across scenarios
   exactly as the check pairs its two candidates, and series
   generation never depends on the candidates. Because the
   per-path consumption is the fixed stride rather than the
   batch's longest horizon, a scenario's trial streams — and
   therefore its statistics — are identical whether it is
   priced alone or batched with longer- or shorter-horizon
   companions.
   Percentiles use the check's own helpers
   (mcPercentile / mcMedianOf), so p50 is the median convention
   the check reports. Money out is integer cents (the
   runRothCompare convention): each path's figures are
   converted with the compare's toCents BEFORE aggregating, so
   at volatility 0 — where every series value is exactly the
   scenario's own expected return — every percentile of every
   scenario equals its runRothCompare figure to the cent.
   Ending after-tax
   wealth is the simulateRothPlan field runRothCompare maps to
   endingAfterTaxWealthCents, unchanged. */

export type RothMcStatsScenarioResult = {
  name: string;
  strategyDescription: string;
  pathsRun: number;
  // Paths on which at least one year ran a spending shortfall.
  pathsWithShortfall: number;
  // Share of paths with NO spending-shortfall year, in percent
  // to one decimal (the winRatePct rounding convention);
  // 100 = spending was funded on every path. This is the
  // SPENDING-shortfall-only rate — a path can score here while
  // still leaving assessed tax unpaid (see fullyFundedRatePct).
  neverShortfallRatePct: number;
  // Per-path lifetime shortfall (the sum of the path's yearly
  // spendShortfall), percentiles across ALL paths — p50 is 0
  // whenever at least half the paths never ran short.
  totalShortfallP50Cents: number;
  totalShortfallP90Cents: number;
  // Share of paths with NO spending shortfall AND NO unpaid
  // tax, in percent to one decimal (the same rounding
  // convention as neverShortfallRatePct); 100 = every path
  // funded both its spending and its assessed tax in full.
  fullyFundedRatePct: number;
  // Paths on which at least one year left assessed tax unpaid.
  pathsWithUnpaidTax: number;
  // Per-path lifetime unpaid tax (the sum of the path's yearly
  // unpaidTax), percentiles across ALL paths — p50 is 0
  // whenever at least half the paths never left tax unpaid.
  totalUnpaidTaxP50Cents: number;
  totalUnpaidTaxP90Cents: number;
  endingAfterTaxWealthP10Cents: number;
  endingAfterTaxWealthP50Cents: number;
  endingAfterTaxWealthP90Cents: number;
  endingPretaxP10Cents: number;
  endingPretaxP50Cents: number;
  endingPretaxP90Cents: number;
  netCostP10Cents: number;
  netCostP50Cents: number;
  netCostP90Cents: number;
};

export type RothMcStatsResult = {
  ok: boolean;
  reason: string;
  scenarios: RothMcStatsScenarioResult[];
};

export function runRothMonteCarloStats(
  base: RothCompareBaseSaved,
  scenarios: { name: string; overrides: RothCompareOverrides }[],
  startYear: number,
  opts: {
    volatilityPct: number;
    pathCount: number;
    seed: number;
    // The plan record's stored tax-return actuals, threaded to
    // buildCompareScenario exactly as runRothCompare threads
    // them (contract v140, re-audit SHOULD S-2).
    taxReturnActuals?: RothTaxReturnStored | null;
  },
): RothMcStatsResult {
  // C5-M1: invalid Monte Carlo options fail in this function's
  // own { ok: false, reason } channel, before any pricing — a
  // 0-path run must not report ok:true with zero statistics.
  const optsError = invalidRothMcOptsReason(opts);
  if (optsError) return { ok: false, reason: optsError, scenarios: [] };
  const noBirthYear: RothMcStatsResult = {
    ok: false,
    reason:
      "The Monte Carlo stats run needs a birth year before it can price a plan — enter it in the base plan and run again.",
    scenarios: [],
  };
  if (scenarios.length === 0) {
    return {
      ok: false,
      reason:
        "The Monte Carlo stats run needs at least one scenario — name a strategy to price.",
      scenarios: [],
    };
  }
  const baseInputs = planInputsFromSaved(base, startYear);
  if (!baseInputs) return noBirthYear;
  const ageNow = baseInputs.startYear - baseInputs.birthYearPrimary;
  if (baseInputs.endAgePrimary <= ageNow) {
    return {
      ok: false,
      reason:
        "The plan end age is not after the current age, so there is no lifetime to stress-test — raise the end age in the base plan and run again.",
      scenarios: [],
    };
  }
  const built: RothCompareScenarioBuilt[] = [];
  for (const s of scenarios) {
    const b = buildCompareScenario(
      base,
      s.name,
      s.overrides,
      startYear,
      opts.taxReturnActuals,
    );
    if (!b) return noBirthYear;
    built.push(b);
  }
  // F2: every built scenario's horizon is validated with the
  // base plan's predicate — a scenario whose end age is not
  // after the current age has no lifetime to stress-test, and
  // pricing it would report a silent 100% over zero years.
  for (const b of built) {
    if (b.inputs.endAgePrimary <= ageNow) {
      return {
        ok: false,
        reason: `Scenario "${b.name}": the plan end age is not after the current age, so there is no lifetime to stress-test — raise the end age in that scenario and run again.`,
        scenarios: [],
      };
    }
  }
  type PathRow = {
    netCostCents: number;
    wealthCents: number;
    pretaxCents: number;
    shortfallCents: number;
    hasShortfall: boolean;
    unpaidTaxCents: number;
    hasUnpaidTax: boolean;
  };
  const perScenario: PathRow[][] = built.map(() => []);
  const rng = rothMcStream(opts.seed);
  const horizonYears = (inputs: RothPlanInputs): number =>
    inputs.endAgePrimary - (inputs.startYear - inputs.birthYearPrimary) + 1;
  const scenarioYears = built.map((b) => horizonYears(b.inputs));
  for (let i = 0; i < opts.pathCount; i++) {
    // Draw the fixed-stride standardized shock vector once,
    // then price EVERY scenario from its own prefix centered
    // on its own expected return — paired paths by
    // construction, and identical streams alone or batched.
    const z = rothMcShockSeries(MC_STREAM_STRIDE_YEARS, rng);
    for (let j = 0; j < built.length; j++) {
      const b = built[j]!;
      const yearsS = scenarioYears[j] ?? 0;
      const series =
        yearsS > 0
          ? z
              .slice(0, yearsS)
              .map(
                (zi) => b.inputs.expectedReturnPct + opts.volatilityPct * zi,
              )
          : [];
      const result = simulateRothPlan(b.inputs, b.strategy, series);
      const cost = planNetCost(result, b.inputs);
      let shortfallDollars = 0;
      let hasShortfall = false;
      let unpaidTaxDollars = 0;
      let hasUnpaidTax = false;
      for (const y of result.years) {
        if (y.spendShortfall > 0) hasShortfall = true;
        shortfallDollars += y.spendShortfall;
        if (y.unpaidTax > 0) hasUnpaidTax = true;
        unpaidTaxDollars += y.unpaidTax;
      }
      perScenario[j]!.push({
        netCostCents: toCents(cost.netCost),
        wealthCents: toCents(result.endingAfterTaxWealth),
        pretaxCents: toCents(result.endingPretax),
        shortfallCents: toCents(shortfallDollars),
        hasShortfall,
        unpaidTaxCents: toCents(unpaidTaxDollars),
        hasUnpaidTax,
      });
    }
  }
  const sortedCopy = (values: number[]): number[] =>
    [...values].sort((a, b) => a - b);
  return {
    ok: true,
    reason: `Priced ${built.length} scenario${built.length === 1 ? "" : "s"} across ${opts.pathCount} varied-return paths at ${opts.volatilityPct}% volatility.`,
    scenarios: built.map((b, j) => {
      const rows = perScenario[j]!;
      const withShortfall = rows.filter((r) => r.hasShortfall).length;
      const withUnpaidTax = rows.filter((r) => r.hasUnpaidTax).length;
      const fullyFunded = rows.filter(
        (r) => !r.hasShortfall && !r.hasUnpaidTax,
      ).length;
      const shortfalls = rows.map((r) => r.shortfallCents);
      const unpaidTaxes = rows.map((r) => r.unpaidTaxCents);
      const wealths = rows.map((r) => r.wealthCents);
      const pretaxes = rows.map((r) => r.pretaxCents);
      const costs = rows.map((r) => r.netCostCents);
      return {
        name: b.name,
        strategyDescription: b.strategyDescription,
        pathsRun: rows.length,
        pathsWithShortfall: withShortfall,
        neverShortfallRatePct:
          rows.length > 0
            ? Math.round(((rows.length - withShortfall) / rows.length) * 1000) /
              10
            : 0,
        totalShortfallP50Cents: Math.round(mcMedianOf(shortfalls)),
        totalShortfallP90Cents: mcPercentile(sortedCopy(shortfalls), 90),
        fullyFundedRatePct:
          rows.length > 0
            ? Math.round((fullyFunded / rows.length) * 1000) / 10
            : 0,
        pathsWithUnpaidTax: withUnpaidTax,
        totalUnpaidTaxP50Cents: Math.round(mcMedianOf(unpaidTaxes)),
        totalUnpaidTaxP90Cents: mcPercentile(sortedCopy(unpaidTaxes), 90),
        endingAfterTaxWealthP10Cents: mcPercentile(sortedCopy(wealths), 10),
        endingAfterTaxWealthP50Cents: Math.round(mcMedianOf(wealths)),
        endingAfterTaxWealthP90Cents: mcPercentile(sortedCopy(wealths), 90),
        endingPretaxP10Cents: mcPercentile(sortedCopy(pretaxes), 10),
        endingPretaxP50Cents: Math.round(mcMedianOf(pretaxes)),
        endingPretaxP90Cents: mcPercentile(sortedCopy(pretaxes), 90),
        netCostP10Cents: mcPercentile(sortedCopy(costs), 10),
        netCostP50Cents: Math.round(mcMedianOf(costs)),
        netCostP90Cents: mcPercentile(sortedCopy(costs), 90),
      };
    }),
  };
}

/* ---------------- Ceiling respect (fixture / audit helper) ------
   Count the years of a scored candidate's schedule where the
   strategy actually converted (beyond any already-converted
   amount) AND the final priced year breaches a switched-on
   ceiling. Years where the draws alone forced a breach with no
   strategy conversion are the engine's honest disclosure, not a
   violation of the fill rule — the convergence loop already
   shrinks the conversion to $0 there. Bunching candidates carry
   no ACA cliff cap by construction, so the cliff is not checked
   for them. */
export function countCeilingViolations(
  inputs: RothPlanInputs,
  spec: OptimizerCandidateSpec,
  result: RothPlanResult,
): number {
  const c = spec.ceilings;
  let violations = 0;
  for (const y of result.years) {
    if (y.conversion - y.conversionAlready <= 0) continue;
    const law = lawForYear(y.year);
    // A survivor year prices under Single, so its ceilings are
    // the single filer's — the same status the year carries.
    const fs = y.filingStatus ?? inputs.filingStatus;
    if (c.bracketTopPct != null) {
      const idx = law.rates.indexOf(c.bracketTopPct);
      const top = idx >= 0 ? (law.brackets[fs][idx] ?? Infinity) : Infinity;
      if (y.taxableIncome > top + 0.01) violations++;
    }
    if (c.ltcgZeroCap && y.taxableIncome > law.ltcgZeroTop[fs] + 0.01) violations++;
    if (c.irmaaTierCap != null) {
      const cap = irmaaTierUpTo(c.irmaaTierCap, fs, law, y.year, inputs.inflationPct);
      if (Number.isFinite(cap) && y.magi > cap + 0.01) violations++;
    }
    if (c.magiCap != null && y.magi > c.magiCap + 0.01) violations++;
    if (c.acaCliffCap && !spec.bunching && y.acaActive) {
      /* ERA-AWARE GATE (Prompt 14 Finding 2 fix): with the
         family-only flag on, simulateRothPlan strips the cliff
         cap from the first household-schedule step year on
         (taxEngine.ts, eraCliffOff) — those years are
         DELIBERATELY uncapped, so this audit must not count
         them as violations. The gate mirrors the simulator's
         exactly: family-only flag set, a first step year
         exists, and the priced year is at or after it.
         Pre-step years are still checked exactly as before. */
      const firstStepYear = acaFirstStepYear(inputs.acaHouseholdSchedule);
      const eraCliffOff =
        c.acaCliffCapFamilyOnly === true &&
        firstStepYear != null &&
        y.year >= firstStepYear;
      if (!eraCliffOff) {
        const size = y.isSurvivorYear
          ? 1
          : acaHouseholdSizeForYear(
              inputs.acaHouseholdSize,
              inputs.acaHouseholdSchedule,
              y.year,
            );
        const cliff = 4 * fplFor(size, y.year - 1);
        if (y.acaMagi > cliff + 0.01) violations++;
      }
    }
  }
  return violations;
}

/* ---------------- Saved-blob raw split / join ----------------
   The Roth planner blob is one JSON document: { inputs, scenarios }
   — plus, since the revision-locking build (API follow-on 1), a
   third top-level segment: the record's write revision (see
   server/src/rothRevisionCore.ts). Scenario save / delete / rename
   must be SIDE-EFFECT-FREE on the saved inputs record: appending
   or removing a scenario must not rewrite the inputs — not even
   by round-tripping them through a parser that fills in defaults
   or coerces nulls (a saved inputs record written before the
   optimizer existed carries optimizerGuardrail / optimizerBunching
   as null — "never set" — and a scenario save that turned those
   into false would be a silent rewrite of the planner inputs,
   however inert the two values are in the engine). These two
   helpers are the ONLY split and join the scenario writers use:
   split keeps the inputs as the exact parsed JSON value, and
   join re-serializes that same value untouched next to the new
   scenarios array, so the inputs segment of the document comes
   back byte-identical (same keys, same order, same nulls) after
   a save + delete round trip. The revision segment rides the
   same way: split returns it raw (revisionRaw, null when the
   blob predates revisions), and join emits the revision key ONLY
   when a revision is passed — every two-argument call site keeps
   producing today's two-key document byte-for-byte, while the
   writers stamp stored + 1 through the third argument. */

export function splitRothBlob(plain: string): {
  inputsRaw: unknown;
  scenariosRaw: unknown;
  revisionRaw: unknown;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plain) as unknown;
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== "object") return null;
  const blob = parsed as Record<string, unknown>;
  return {
    inputsRaw: blob.inputs ?? null,
    scenariosRaw: blob.scenarios ?? [],
    revisionRaw: blob.revision ?? null,
  };
}

export function joinRothBlob(
  inputsRaw: unknown,
  scenarios: unknown,
  revision?: number,
): string {
  return revision === undefined
    ? JSON.stringify({ inputs: inputsRaw, scenarios })
    : JSON.stringify({ inputs: inputsRaw, scenarios, revision });
}

/* ---------------- Saved-inputs conversion ----------------
   The optimizer action receives the Roth view's saved-inputs
   shape (integer cents, every field nullable). This is the ONE
   conversion from that shape to engine inputs: its fallbacks
   mirror the Roth view's own plan-input construction field by
   field, so the plan the optimizer prices is the plan the view
   prices, and a scenario saved with a winner's parameters
   reproduces the winner's schedule exactly when the view re-runs
   it through the standard engine. */

/* ---------------- FAFSA-reportable assets ----------------
   The ONE assembly of the plan's FAFSA-reportable asset figure
   (dollars), shared by the Roth view and pinned by the fixtures.
   Reportable = the plan's priced taxableStart — when balances
   follow Net Worth that figure already includes the Cash bucket,
   so cash is never double-counted — PLUS, only when the taxable
   balance is FOLLOWING the Net Worth snapshot, the latest
   snapshot's College / 529 subtotal and Non-Taxable subtotal
   (both parent-reportable on FAFSA, neither priced in the plan's
   balances). When the taxable balance is a typed / manual entry,
   reportable = the typed taxableStart alone (unknown pots never
   suppress the watch-out). NEVER reportable: Pre-tax (either
   person), Roth, HSA. Unbucketed money in a partially split
   snapshot is not counted — the subtotals are split-only by
   construction. */
export function fafsaReportableAssets(
  taxableStartDollars: number,
  taxableFollowing: boolean,
  bucket529Cents: number | null,
  nonTaxableCents: number | null,
): number {
  return (
    taxableStartDollars +
    (taxableFollowing
      ? ((bucket529Cents ?? 0) + (nonTaxableCents ?? 0)) / 100
      : 0)
  );
}

export type RothSavedLike = {
  birthYearPrimary: number | null;
  birthYearSpouse: number | null;
  filingStatus: "mfj" | "single" | "hoh" | null;
  pretaxCents: number | null;
  // Per-spouse pre-tax + survivor scenario (added with the
  // per-spouse / survivor build). Optional: a saved record
  // written before that build has none of them, which prices
  // exactly as before (spouse $0, scenario off).
  pretaxSpouseCents?: number | null;
  // Rule-of-55-eligible pre-tax + separation age (Engine
  // Review C9, Build 1). Optional: a saved record written
  // before this build has none of them, which reads as
  // eligibility NOT ESTABLISHED for that owner — the engine
  // prices $0 penalty on pre-59½ pre-tax spending draws
  // exactly as before, with the year's
  // earlyWithdrawalEligibilityUnknown flag saying the $0 is
  // unknown, not computed. Cents for the eligible balances
  // (like pretaxCents); whole years for the separation ages.
  // An entered 0 eligible balance is a real answer (none of
  // that owner's pre-tax is in an eligible plan). The
  // complement is computed, never entered; nothing here is
  // ever inferred from a label, a contribution flow, or a
  // retirement age.
  pretax401kEligiblePrimaryCents?: number | null;
  pretax401kEligibleSpouseCents?: number | null;
  separationAgePrimary?: number | null;
  separationAgeSpouse?: number | null;
  survivorEnabled?: boolean | null;
  survivorWho?: "primary" | "spouse" | null;
  survivorDeathYear?: number | null;
  // Survivor claiming age + first-RMD deferral elections
  // (Engine Review 5). Optional: a saved record written before
  // this build has none of them — survivorClaimAge absent reads
  // as the simplified max-of-two-benefits rule, the elections
  // absent read as the immediate-payment default — so an
  // untouched record prices exactly as before.
  survivorClaimAge?: number | null;
  firstRmdDeferralPrimary?: boolean | null;
  firstRmdDeferralSpouse?: boolean | null;
  rothCents: number | null;
  // Roth IRA vs designated Roth split + Roth basis / clock
  // (Engine Review C9, Build 2 — W3). Optional: a saved
  // record written before this build has none of them,
  // which reads as NOT ESTABLISHED — the engine prices $0
  // income and $0 penalty on Roth draws exactly as before,
  // with the year's rothBasisUnknown flag saying the $0 is
  // unknown, not computed. Cents for the split and the
  // bases; the lots carry cents too (taxableAmountCents /
  // nontaxableAmountCents per lot); whole years for the
  // clocks. An entered 0 basis is a real answer; an entered
  // empty lot list is a real answer (no prior conversions).
  // The split divides the followed Roth balance (see
  // planInputsFromSaved); no per-owner balance split is
  // carried. Nothing here is ever inferred or defaulted to
  // the full balance.
  rothIraCents?: number | null;
  rothEmployerCents?: number | null;
  rothContributionBasisPrimaryCents?: number | null;
  rothContributionBasisSpouseCents?: number | null;
  rothConversionLotsPrimary?: RothConversionLotSaved[] | null;
  rothConversionLotsSpouse?: RothConversionLotSaved[] | null;
  firstRothYearPrimary?: number | null;
  firstRothYearSpouse?: number | null;
  firstDesignatedRothYearPrimary?: number | null;
  firstDesignatedRothYearSpouse?: number | null;
  taxableCents: number | null;
  // Exclude-from-plan amount for the taxable pool (added with
  // the EXCLUDE-FROM-PLAN build). Optional: a saved record
  // written before this build has no such key, which reads as
  // blank = no exclusion, so an untouched record prices
  // bit-identically to before. When set (and only when the
  // taxable balance FOLLOWS THE SNAPSHOT — taxableCents null),
  // resolvePlanBalances subtracts it from the snapshot pool
  // (Taxable + Cash buckets, floored at $0) and the excluded
  // money leaves the plan entirely: never spent, never sold,
  // never in the yield base, never in ending wealth. Net
  // Worth is untouched — the subtraction happens only here,
  // at plan pricing time. An explicit taxableCents override
  // wins exactly as before and the exclusion is inert.
  taxableExcludeCents?: number | null;
  hsaCents: number | null;
  taxableBasisPct: number | null;
  // Basis tiers (added with the BASIS TIERS build). Optional:
  // a saved record written before this build has no such key,
  // which reads as blank = the single pool at taxableBasisPct,
  // so an untouched record prices bit-identically to before.
  // When a non-empty tier list is present it replaces the
  // basis % as the pool's basis source (see taxEngine).
  taxableTiers?: TaxableTier[] | null;
  // Taxable yields (added with the TAXABLE YIELDS build).
  // Optional: a saved record written before this build has
  // neither key, which reads as blank = no yield entered. When
  // set, each priced year's dividend / interest yield % of the
  // starting taxable balance is mandatory income for the year
  // (see taxEngine's RothPlanInputs note). A BLANK field no
  // longer prices as $0 when the household's stored tax-return
  // actuals imply a yield for it: the fallback transients
  // below stand in for the blank field (contract v136, audit
  // MUST M-1 — see planInputsFromSaved).
  taxableDividendYieldPct?: number | null;
  taxableInterestYieldPct?: number | null;
  // Blank-yield fallback yields (contract v136, audit MUST
  // M-1) — TRANSIENT engine inputs, never saved user fields:
  // the implied yields derived from the plan record's stored
  // tax-return actuals over the plan's resolved taxable pool
  // (impliedYieldPctsFromTaxReturn in taxReturnCore.ts),
  // threaded by the layer that holds both the record and the
  // resolved pool — the actions layer's resolveArgsBalances
  // on the server, the plan-input constructions in the
  // client — exactly the way the snapshot balances and the
  // cash sleeve are threaded. planInputsFromSaved uses each
  // one ONLY when the matching yield field above is blank
  // (absent / null): an entered yield, including an explicit
  // 0%, always prices as entered. Absent / null transient =
  // no estimate exists for that line (no stored actual, or no
  // pool to imply from), and a blank field then prices $0
  // exactly as before this build. The actuals themselves
  // never ride this shape: only the derived percentages do
  // (contract v139, re-audit MUST M-1: the return amounts
  // never enter pricing as amounts; pricing reads only the
  // two derived percentages — the tax-return-pricing-identity
  // fixture pins that action path, resolveArgsBalances'
  // threading, not the bare conversion).
  yieldFallbackDividendPct?: number | null;
  yieldFallbackInterestPct?: number | null;
  // Qualified-dividend share (contract v138, audit SHOULD
  // S-1) — a TRANSIENT engine input in the same family as
  // the yield fallbacks above, never a saved user field: the
  // % of the plan's dividend yield income that is QUALIFIED,
  // derived from the plan record's stored tax-return actuals
  // (line 3a ÷ line 3b —
  // qualifiedDividendSharePctFromTaxReturn in
  // taxReturnCore.ts) and threaded by the same layers that
  // thread the yield fallbacks (the actions layer's
  // resolveArgsBalances on the server, the plan-input
  // constructions in the client). planInputsFromSaved passes
  // it to the engine as taxableDividendQualifiedPct, which
  // splits each year's dividend income between the gains and
  // ordinary stacks. Absent / null transient = no stored
  // return implies a share, and the engine prices 100%
  // qualified exactly as before this build. Unlike the yield
  // fallbacks this share applies whether or not a yield was
  // entered: it describes the CHARACTER of the dividend
  // income, not its size. The actuals themselves never ride
  // this shape — only the derived percentage does — so the
  // tax-return-pricing-identity fixture pins the action path
  // on this transient too: amounts never enter as amounts,
  // only the derived share reaches pricing (contract v139).
  qualifiedDividendSharePct?: number | null;
  // Spend-from-cash % (added with the SPEND-FROM-CASH build).
  // Optional: a saved record written before this build has no
  // such key, which reads as blank = off, so an untouched
  // record prices bit-identically to before. When set, X% of
  // each year's spending need is paid from the taxable pool's
  // cash tier first (see taxEngine's RothPlanInputs note).
  spendFromCashPct?: number | null;
  // Flexible spending % dials (added with the FLEXIBLE
  // SPENDING build). Optional: a saved record written before
  // this build has neither key, which reads as null = off
  // (flexCutPct) / floor 80 inside a triggered cut
  // (flexFloorPct), so an untouched record prices
  // bit-identically to before. When set, a year's spending
  // need is cut after a negative-return year (see
  // taxEngine's flexSpendingNeed).
  flexCutPct?: number | null;
  flexFloorPct?: number | null;
  // The cash sleeve's starting size, in cents — a TRANSIENT
  // engine input, never a saved user field: the actions layer
  // threads the latest snapshot's Cash bucket subtotal here
  // when (and only when) the plan's taxable balance follows
  // the snapshot, exactly the way the snapshot balances
  // themselves are threaded (see resolveArgsBalances in
  // actions.ts). Absent / null = $0 cash: a compute base that
  // passes an explicit taxableCents with no snapshot context
  // prices with no sleeve, identical to blank.
  spendFromCashSleeveCents?: number | null;
  annualSpendingCents: number | null;
  retirementAge: number | null;
  endAge: number | null;
  expectedReturnPct: number | null;
  // Stocks mix % (round-4 SHOULD-3): the mix the blank-return
  // seed below blends from. The Roth record itself carries no
  // mix — the household's mix lives on the Retirement record —
  // so this is an OPTIONAL transient a caller that holds both
  // records may thread; absent / null = no mix available here,
  // and the seed falls back to STOCKS_PCT_DEFAULT, exactly the
  // fallback the clients apply (retSaved?.stocksPct ??
  // STOCKS_PCT_DEFAULT) before they price or save.
  stocksPct?: number | null;
  ssPrimaryAnnualCents: number | null;
  ssPrimaryStartAge: number | null;
  // Declared "No benefit" flags (generic, symmetric). Optional:
  // a saved record written before this build has neither key,
  // which reads as undeclared (false) with zero behavior change.
  // When true the engine input is $0 regardless of any stored
  // amount; saves normalize so declaration and amount never
  // coexist (declared → amount null + flag true; amount present
  // → flag false).
  ssPrimaryNoBenefit?: boolean | null;
  ssSpouseAnnualCents: number | null;
  ssSpouseStartAge: number | null;
  ssSpouseNoBenefit?: boolean | null;
  otherOrdinaryCents: number | null;
  taxExemptInterestCents: number | null;
  convertedAlreadyCents: number | null;
  windowStartAge: number | null;
  windowStopAge: number | null;
  payTaxFrom: "taxable" | "conversion" | null;
  protectMinTaxableCents: number | null;
  // Preserve-pre-tax reserve (added with the reserve build).
  // Optional: a saved record written before this build has
  // neither key, which prices exactly as before (no reserve;
  // exit rate = heir rate). Null = blank = the same.
  preservePretaxCents?: number | null;
  preserveExitRatePct?: number | null;
  // Earliest claiming age to consider (the claim floor).
  // Optional: a saved record written before this build has no
  // key, which reads as blank = no floor, so an untouched
  // record crowns exactly the pre-build winner. It constrains
  // only the optimizer's crowning — never a priced figure.
  claimAgeFloor?: number | null;
  drawOrder: string | null;
  // Draw-order switch (added with the switch build). Optional:
  // a saved record written before this build has neither key,
  // which reads as blank = no switch, so an untouched record
  // prices bit-identically to before. If either field is blank
  // the switch is inert (see effectiveDrawOrder in taxEngine).
  drawOrderSwitchAge?: number | null;
  drawOrderAfter?: string | null;
  spouseSoleBeneficiary: boolean | null;
  // The second beneficiary fact (round-3 fix): the primary
  // is the sole beneficiary of the SPOUSE's pre-tax
  // accounts — separate from spouseSoleBeneficiary (the
  // spouse is the PRIMARY's sole beneficiary). Optional:
  // a saved record written before this build has no key,
  // which reads as null = NOT established, so the spouse's
  // RMD prices on the Uniform Lifetime Table and an
  // untouched record prices bit-identically to before.
  primarySoleBeneficiaryOfSpouse?: boolean | null;
  acaHouseholdSize: number | null;
  // The household schedule (MULTI-STEP ACA HOUSEHOLD SCHEDULE
  // build): the ordered steps away from acaHouseholdSize.
  // Null = no steps. The two legacy keys below it are OPTIONAL
  // and read ONLY by planInputsFromSaved's migration fallback
  // (resolveAcaHouseholdSchedule): a record written before
  // this build carries the pair instead of a schedule, and
  // resolves to the one-entry schedule that prices
  // bit-identically. No writer writes them any more.
  acaHouseholdSchedule: AcaHouseholdStep[] | null;
  acaHouseholdSizeAfter?: number | null;
  acaStepDownYear?: number | null;
  acaBenchmarkCoupleCents: number | null;
  acaBenchmarkSingleCents: number | null;
  // Family benchmark (household of 3+). Optional: a saved
  // record written before this build has no such key, which
  // reads as blank = the fallback behaviour (see taxEngine),
  // so an untouched record prices bit-identically to before.
  acaBenchmarkFamilyCents?: number | null;
  // Spouse ACA end age (added with the KNOBS build). Optional:
  // a saved record written before this build has no such key,
  // which reads as blank = 65 = the spouse's ACA pricing stops
  // at 65 and her Medicare / IRMAA count starts at 65, exactly
  // as before.
  acaSpouseEndAge?: number | null;
  // IRMAA LOOKBACK SEED (Engine Review 6, E6-S1): explicitly
  // supplied prior-year returns — the tax year, that year's
  // MAGI in cents, and the filing status that year's return
  // was filed under — so a plan whose march starts within two
  // years of a Medicare start can price its first premium
  // years from real returns instead of finding no lookback at
  // all. Optional: absent / null / empty = no supplied
  // returns, and the march prices exactly as before (a
  // premium year with no recorded lookback prices $0 of
  // IRMAA and is now flagged unknown — see taxEngine). The
  // work-years roll builds the same seed from its own priced
  // lines (workYears.ts) and never passes through this field.
  // Entries are NEVER invented: only returns the caller
  // supplies, with their own MAGI and filing status, land
  // here — current balances or retirement spending are never
  // used to guess a prior-year income.
  irmaaLookbackSeedCents?: {
    year: number;
    magiCents: number;
    filingStatus: "mfj" | "single" | "hoh";
  }[] | null;
  // Health premium term (build v208). Optional: a saved
  // record written before this build has none of these keys,
  // which reads as blank = the term is not entered, so an
  // untouched record prices bit-identically to before (the
  // v135 embedded reconciliation exactly as it was). When
  // any is entered, the engine funds the year's actual
  // health premium on top of spending (see taxEngine's
  // RothPlanInputs note).
  healthPremiumAcaHouseholdCents?: number | null;
  healthPremiumAcaSingleCents?: number | null;
  healthPremiumMedicarePerPersonCents?: number | null;
  inflationPct: number | null;
  stateRatePct: number | null;
  // State of residence (T3 build). Optional: a saved record
  // written before this build has no such key, which reads as
  // blank = the flat stateRatePct prices the state tax,
  // bit-identical to before. "WA" prices Washington's
  // capital-gains excise instead.
  residenceState?: "WA" | "other" | null;
  // Capital-loss carryforward entering the plan (T4 build),
  // short-term and long-term, in integer cents. Optional: a
  // saved record written before this build has neither key,
  // which reads as blank = $0 = no banked loss, so an
  // untouched record prices bit-identically to before.
  capitalLossCarryInStCents?: number | null;
  capitalLossCarryInLtCents?: number | null;
  // Washington-attributable portions of the entering
  // carryforward (build v101, round-14 fix F4), integer
  // cents like the totals they are portions of. Optional:
  // a saved record written before this build has neither
  // key, which reads as blank = $0 = no Washington
  // attribution, so an untouched record prices
  // bit-identically to before.
  capitalLossCarryInStWaCents?: number | null;
  capitalLossCarryInLtWaCents?: number | null;
  // Itemized deductions (T5 build), in integer cents:
  // mortgage interest, state and local taxes paid,
  // charitable contributions, and other itemized
  // deductions, kept as separate components (the SALT
  // component is capped on its own in pricing, and the
  // charitable component is the one charitable input the
  // Washington layer also reads). Optional: a saved record
  // written before this build has none of the keys, which
  // reads as blank = $0 on every component, so an untouched
  // record prices bit-identically to before.
  itemizedMortgageInterestCents?: number | null;
  itemizedSaltPaidCents?: number | null;
  itemizedCharitableCents?: number | null;
  itemizedOtherCents?: number | null;
  // Education expenses (T6 build): the household's entered
  // qualified education expenses as a list of per-student,
  // per-calendar-year entries, expenses in integer cents.
  // Optional: a saved record written before this build has
  // no such key, which reads as blank = no expenses entered
  // anywhere = no education credit prices, so an untouched
  // record prices bit-identically to before. Entries are
  // never inferred from any other field (not from 529
  // balances, not from the college window below).
  educationStudents?:
    | { year: number; expensesCents: number; aotcEligible: boolean }[]
    | null;
  heirRatePct: number | null;
  // Transient FAFSA-reportable assets (integer cents), assembled
  // client-side via fafsaReportableAssets and sent ONLY with the
  // optimizer / Monte Carlo check requests. Optional: a payload
  // without it prices exactly as before (unknown assets never
  // suppress the college watch-out). It is NEVER persisted — the
  // saved-inputs schema and writer do not carry it, and scenarios
  // never carry it.
  fafsaReportableAssetsCents?: number | null;
  // The household's college window, labeled by fall year —
  // PERSISTED saved fields (they ride the saved shape and
  // scenarios like the other Household fields). Optional: a
  // record written before this build has neither key, which
  // reads as blank = no college window = the college watch-out
  // never fires.
  collegeFallFromYear?: number | null;
  collegeFallThroughYear?: number | null;
  // Work-years job inputs (added with the Work years tab).
  // Optional: a saved record written before this build has
  // none of them, which reads as blank = no salary entered =
  // no work years priced. They are the tab's saved defaults;
  // planInputsFromSaved never reads them (the work-year
  // engine in server/src/workYears.ts consumes them).
  yearlySalaryCents?: number | null;
  employer401kCents?: number | null;
  employerHsaCents?: number | null;
};

// Save normalization for the declared "No benefit" state:
// declaration and amount never coexist. Declared → amount stored
// null + flag true (the flag wins, so the engine input is $0
// regardless of any stored amount). Amount present → flag false.
// Blank + undeclared → flag false (an explicit finished "not
// declared"), amount stays null. Used by every writer of the
// saved shape (plan inputs and scenarios) so all saves normalize
// identically.
export function normalizeSsDeclarations<
  T extends {
    ssPrimaryAnnualCents: number | null;
    ssPrimaryNoBenefit?: boolean | null;
    ssSpouseAnnualCents: number | null;
    ssSpouseNoBenefit?: boolean | null;
  },
>(input: T): T {
  const primaryDeclared = input.ssPrimaryNoBenefit === true;
  const spouseDeclared = input.ssSpouseNoBenefit === true;
  return {
    ...input,
    ssPrimaryAnnualCents: primaryDeclared ? null : input.ssPrimaryAnnualCents,
    ssPrimaryNoBenefit: primaryDeclared ? true : false,
    ssSpouseAnnualCents: spouseDeclared ? null : input.ssSpouseAnnualCents,
    ssSpouseNoBenefit: spouseDeclared ? true : false,
  };
}

/* ---------------- Execution-year mode ("This year") ----------------
   The planner looks ahead from its window's first year; a
   conversion is EXECUTED in one specific calendar year, with
   income already received and conversions already made in that
   year. This section prices the CURRENT calendar year standalone
   through the same shared engine (simulateRothPlan), with the
   year-to-date actuals folded in through the engine's existing
   input concepts:
     · YTD other ordinary income   → the year's otherOrdinaryAnnual
     · YTD tax-exempt interest     → the year's taxExemptInterestAnnual
     · YTD conversions             → the year's convertedAlreadyThisYear
       (the engine's converted-already amount: priced as income in
       that year without moving buckets, and the fill tops it up)
   Exactly ONE year is priced: the run starts at the current
   calendar year and its end age is the primary's age in that
   year, and the conversion window is narrowed to that single
   age so the year prices exactly as a first window year. The
   strategy's ceilings are the plan's saved ceilings verbatim.
   Everything else — Social Security at the entered amounts /
   start ages (declared "No benefit" included), RMDs, ACA scope,
   draw order, pay-tax-from, protect-minimum, state rate,
   inflation — is the plan's own parameters, untouched.

   REMAINING conversion = the priced year's total conversion
   minus the YTD conversions already done. It is never negative.

   Execution inputs are PLAN-RECORD ONLY: they live in the saved
   inputs record under the execution* keys below, stamped with
   the calendar year they describe (executionYear). They are NOT
   scenario parameters — the scenario shape (rothInputFields in
   actions.ts) never carries them, planInputsFromSaved never
   reads them, and the planner / optimizer / compare paths never
   see them. */

// The stored execution shape (integer cents, every field
// nullable; null balance = fall back to the plan's resolved
// balance, null YTD amount = nothing entered, priced as $0
// received / converted so far).
export type RothExecutionCents = {
  executionYear: number | null;
  executionPretaxCents: number | null;
  executionPretaxSpouseCents: number | null;
  executionRothCents: number | null;
  executionTaxableCents: number | null;
  executionHsaCents: number | null;
  executionOtherOrdinaryCents: number | null;
  executionTaxExemptInterestCents: number | null;
  // YTD conversions — a DIFFERENT field from the plan's
  // convertedAlreadyCents (which belongs to the plan window's
  // first year). The two are never conflated in code, storage
  // keys, or copy.
  executionAlreadyConvertedCents: number | null;
};

export const BLANK_EXECUTION_CENTS: RothExecutionCents = {
  executionYear: null,
  executionPretaxCents: null,
  executionPretaxSpouseCents: null,
  executionRothCents: null,
  executionTaxableCents: null,
  executionHsaCents: null,
  executionOtherOrdinaryCents: null,
  executionTaxExemptInterestCents: null,
  executionAlreadyConvertedCents: null,
};

// Consume a stored execution shape for `currentYear` — the ONE
// rollover enforcement point, used by the client load path
// (getRothPlanner) and pinned by the fixtures. A shape whose
// year stamp does not match the current calendar year is
// consumed as BLANK (last year's actuals are never carried into
// a new year's pricing) and reported as rolled over, naming the
// cleared year. A record with no stamp (written before this
// build, or no execution inputs at all) is blank with no
// rollover to report.
export function consumeExecutionInputs(
  raw: unknown,
  currentYear: number,
): { execution: RothExecutionCents; rolledOver: boolean; clearedYear: number | null } {
  const blank: RothExecutionCents = { ...BLANK_EXECUTION_CENTS, executionYear: currentYear };
  if (raw == null || typeof raw !== "object") {
    return { execution: blank, rolledOver: false, clearedYear: null };
  }
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const stamp = num(r.executionYear);
  if (stamp == null) return { execution: blank, rolledOver: false, clearedYear: null };
  if (stamp !== currentYear) {
    return { execution: blank, rolledOver: true, clearedYear: stamp };
  }
  return {
    execution: {
      executionYear: stamp,
      executionPretaxCents: num(r.executionPretaxCents),
      executionPretaxSpouseCents: num(r.executionPretaxSpouseCents),
      executionRothCents: num(r.executionRothCents),
      executionTaxableCents: num(r.executionTaxableCents),
      executionHsaCents: num(r.executionHsaCents),
      executionOtherOrdinaryCents: num(r.executionOtherOrdinaryCents),
      executionTaxExemptInterestCents: num(r.executionTaxExemptInterestCents),
      executionAlreadyConvertedCents: num(r.executionAlreadyConvertedCents),
    },
    rolledOver: false,
    clearedYear: null,
  };
}

// The execution inputs in the tax engine's units (dollars).
// Balances stay nullable: null means "use the plan's resolved
// balance for that bucket". YTD amounts resolve null → $0.
export type ExecutionYearDollars = {
  pretax: number | null;
  pretaxSpouse: number | null;
  roth: number | null;
  taxable: number | null;
  hsa: number | null;
  otherOrdinaryYtd: number;
  taxExemptYtd: number;
  alreadyConvertedYtd: number;
};

export function executionDollarsFromCents(exec: RothExecutionCents): ExecutionYearDollars {
  const dollars = (cents: number | null) => (cents == null ? null : cents / 100);
  return {
    pretax: dollars(exec.executionPretaxCents),
    pretaxSpouse: dollars(exec.executionPretaxSpouseCents),
    roth: dollars(exec.executionRothCents),
    taxable: dollars(exec.executionTaxableCents),
    hsa: dollars(exec.executionHsaCents),
    otherOrdinaryYtd: dollars(exec.executionOtherOrdinaryCents) ?? 0,
    taxExemptYtd: dollars(exec.executionTaxExemptInterestCents) ?? 0,
    alreadyConvertedYtd: dollars(exec.executionAlreadyConvertedCents) ?? 0,
  };
}

export type ExecutionYearStatus =
  | "ok" // a remaining amount (possibly $0 at an exactly-filled target)
  | "no-ceiling" // the plan has no fill target switched on
  | "not-priced" // the pre-tax balance prices $0 — nothing to convert
  | "balance-capped" // the room exceeds the pre-tax balance available
  | "over-ceiling-income" // YTD income (at the priced conversion level) is past the ceiling
  | "over-ceiling-conversions" // the YTD conversions alone are past the fill
  | "no-room"; // $0 of room for another stated reason (see fillOutcome)

export type ExecutionYearResult = {
  status: ExecutionYearStatus;
  // The priced execution year — the same RothYear shape the
  // planner's year-by-year table and "Show the math" drill-down
  // render. Null only when the plan cannot price a year at all.
  year: RothYear | null;
  // Additional conversion still to make before Dec 31 of the
  // execution year. Never negative.
  remaining: number;
  // The priced year's total conversion (YTD + remaining).
  totalConversion: number;
  ytdConverted: number;
  // The total conversion that would fill exactly to the binding
  // ceiling, balance permitting (the engine's own fill solver
  // against the settled year's base). Null when no ceiling is
  // switched on.
  fillTarget: number | null;
  // The label of the cap the fill target binds (e.g. "Top of
  // the 12% bracket"), named from the priced year's own cap
  // records at the target conversion.
  fillTargetLabel: string | null;
  // For the over-ceiling states: how far the priced year's
  // binding cap figure sits past its cap, and that cap's label.
  overshoot: number;
  overshootLabel: string | null;
  // The engine's own fill bound label for the priced year
  // (e.g. "Top of the 12% bracket"), when the fill stopped at
  // something.
  boundLabel: string | null;
  fillOutcome: RothYear["detail"]["fill"]["outcome"] | null;
  // Pre-tax still available to convert in the priced year
  // (prior Dec 31 balance − this year's RMD).
  availableAdditional: number;
  // The pre-tax total the year was priced with (both spouses).
  pretaxPriced: number;
};

// The total conversion that fills the settled year exactly to
// its ceilings, balance permitting — the engine's own
// fillConversion solver run against the settled year's base
// (the realized gains / extra pre-tax draw the settlement
// produced included), so the figure is the same fill the
// planner would solve for this year. Also returns the settled
// base (for the over-ceiling cause test) and the label of the
// cap that binds at the target, measured by pricing the target
// through the engine's priceYear and matching the priced
// year's own cap records.
// T4: the loss-ledger fields for a reconstructed one-year
// base (the execution-year re-solves below). The execution
// year is priced by a one-year simulateRothPlan run that
// starts at the plan's entering carryforward, so when the
// plan carries a banked loss, the reconstructed base's
// gross gains (detail.ltcg — the year's own total) are
// netted through the same ledger transform the march
// priced with, and the re-solve prices the year the sim
// priced. No banked loss → the base keeps its gross ltcg
// and carries the year's own priced allowance
// (detail.capitalLossAllowance — min(cap, −gross) on a
// loss year, $0 otherwise), so the re-solve prices the
// same AGI / MAGI / taxable income the march priced for
// that year. (Round 2 SHOULD-2: the early return below
// used to carry no allowance at all, so a no-carry-in
// loss year re-solved $3,000 too high.)
// Build v101: the Washington base here is the same
// figure the march priced — the gross gains minus the
// Washington-attributable absorbed part the shared
// transform reports — never the bare gross gains.
function executionLedgerFields(
  plan: RothPlanInputs,
  y: RothYear,
): { ltcg: number; capitalLossAllowance?: number; waGainsBase?: number } {
  const st = Math.max(0, plan.capitalLossCarryInSt ?? 0);
  const lt = Math.max(0, plan.capitalLossCarryInLt ?? 0);
  if (st <= 0 && lt <= 0)
    return {
      ltcg: y.detail.ltcg,
      capitalLossAllowance: y.detail.capitalLossAllowance,
    };
  // Only the netted result and the CLAIMED allowance are
  // read here — never the carry-out (the one-year sim that
  // priced this year reconciled its own carry-out against
  // its final taxable income) — so utilization is passed
  // as unbounded, exactly as the march's trial pricings
  // pass it.
  const led = applyLossLedger(
    { st, lt },
    y.detail.ltcg,
    y.filingStatus,
    Number.POSITIVE_INFINITY,
    {
      st: Math.max(0, plan.capitalLossCarryInStWa ?? 0),
      lt: Math.max(0, plan.capitalLossCarryInLtWa ?? 0),
    },
  );
  return {
    ltcg: led.netResult,
    capitalLossAllowance: led.allowance,
    waGainsBase: r2(y.detail.ltcg - led.waAbsorbedByGains),
  };
}

export function executionFillTarget(
  plan: RothPlanInputs,
  execInputs: RothPlanInputs,
  y: RothYear,
  ceilings: FillCeilings,
  guardrail = false,
): { target: number; base: PriceYearInput; targetLabel: string | null } {
  // The year's dividend split, exactly as the sim priced it
  // (see the yield-income comment on the base below).
  const qualifiedPct = Math.min(
    100,
    Math.max(0, plan.taxableDividendQualifiedPct ?? 100),
  );
  const qualifiedDividends =
    Math.round(((y.detail.dividendIncome * qualifiedPct) / 100) * 100) / 100;
  const ordinaryDividends =
    Math.round((y.detail.dividendIncome - qualifiedDividends) * 100) / 100;
  const base: PriceYearInput = {
    calendarYear: y.year,
    filingStatus: y.filingStatus,
    agePrimary: y.agePrimary,
    ageSpouse: y.ageSpouse,
    otherOrdinary: execInputs.otherOrdinaryAnnual,
    rmd: y.rmd,
    conversion: 0,
    extraPreTaxDraw: y.detail.extraPreTaxDraw,
    ssBenefits: y.ssBenefits,
    taxExemptInterest: execInputs.taxExemptInterestAnnual,
    ...executionLedgerFields(plan, y),
    // Taxable yield income (S-10): the re-solve prices the
    // settled year, so its base carries the year's interest
    // and dividend income exactly as the sim priced them —
    // the sim's own split of the year's dividend total by the
    // plan's qualified share (qualified on the gains stack,
    // the remainder on the ordinary stack). The guardrail's
    // stop is defined on consecutive steps' tax cost, and the
    // §86 provisional income that drives the torpedo steps
    // includes this yield income: a base without it places
    // the torpedo zone thousands of dollars too late (on the
    // sample household's torpedo year the re-solve named a
    // $31,500 target against the march's $16,400 fill). A
    // year with no yield income carries $0s here and prices
    // bit-identically to before.
    interestIncome: y.detail.interestIncome,
    qualifiedDividends,
    ordinaryDividends,
    inflationPct: plan.inflationPct,
    stateRatePct: plan.stateRatePct,
    residenceState: plan.residenceState ?? null,
    // Itemized deductions (T5): the re-solve prices the
    // settled year, so its base carries the plan's itemized
    // components exactly as the sim priced them — a fill
    // target solved against the standard deduction for a
    // year the sim priced as itemized would name the wrong
    // room.
    itemizedMortgageInterest: plan.itemizedMortgageInterest,
    itemizedSaltPaid: plan.itemizedSaltPaid,
    itemizedCharitable: plan.itemizedCharitable,
    itemizedOther: plan.itemizedOther,
    // Education expenses (T6): the same — this execution
    // year's entered students, exactly as the sim priced
    // them, so the fill target re-solves against the year's
    // real (phase-out-shrunken) credits.
    educationStudents: (plan.educationStudents ?? []).filter(
      (e) => e.year === y.year,
    ),
  };
  // Marginal-rate guardrail (S-10): the re-solve carries the
  // same guardrail target the march's own fill carries — the
  // strategy's bracket ceiling rate, when the guardrail is on
  // and a bracket ceiling exists (the exact rule
  // simulateRothPlan applies per year) — so the fill target
  // stops where the march stopped. Before S-10 this solver
  // priced the ceilings alone and named a target far past the
  // guardrail stop (on the torpedo year, a $185,800 target
  // against the march's $16,400 fill).
  const guardrailTargetPct =
    guardrail && ceilings.bracketTopPct != null ? ceilings.bracketTopPct : null;
  const target = fillConversion({
    base,
    ceilings,
    maxConversion: 100_000_000,
    acaCliff: y.detail.aca.active ? y.detail.aca.cliff : null,
    guardrailTargetPct,
  });
  let targetLabel: string | null = null;
  // The preserve-reserve cap is a balance floor, not a priced
  // income figure — priceYear cannot measure it, so it never
  // takes part in naming the ceiling target (priceExecutionYear
  // names it separately when it is what binds).
  const ceilingCaps = y.detail.fill.caps.filter((c) => c.kind !== "preserve");
  if (ceilingCaps.length > 0) {
    const atTarget = priceYear({ ...base, conversion: target });
    const measure = (kind: string): number =>
      kind === "bracket" || kind === "ltcgZero"
        ? atTarget.taxableIncome
        : kind === "acaCliff"
          ? atTarget.acaMagi
          : atTarget.magi;
    const bound = ceilingCaps.find(
      (c) => Math.abs(measure(c.kind) - c.cap) <= 0.01,
    );
    targetLabel = bound?.label ?? ceilingCaps[0]?.label ?? null;
  }
  // When the guardrail is what stopped the fill — the
  // ceilings-alone solver would have gone further — the
  // guardrail names the target, in the march's own words for
  // the same stop (the priced year's fill bound label). When
  // a ceiling binds first (the two targets agree), the
  // ceiling's label above stands.
  if (guardrailTargetPct != null) {
    const ceilingOnlyTarget = fillConversion({
      base,
      ceilings,
      maxConversion: 100_000_000,
      acaCliff: y.detail.aca.active ? y.detail.aca.cliff : null,
    });
    if (target < ceilingOnlyTarget - 0.005) {
      targetLabel = `Marginal-rate guardrail (${guardrailTargetPct}%)`;
    }
  }
  return { target, base, targetLabel };
}

export function priceExecutionYear(
  plan: RothPlanInputs,
  ceilings: FillCeilings | null,
  exec: ExecutionYearDollars,
  currentYear: number,
  // Marginal-rate guardrail (S-10, engines review round 2):
  // the saved strategy's guardrail flag, carried by the caller
  // exactly as it carries the ceilings. Optional — absent /
  // false prices bit-identically to before S-10 (every
  // pre-existing caller). Before S-10 the parameter did not
  // exist and the one-year strategy literal below carried
  // ceilings only, so a guardrail plan's execution year filled
  // straight through the Social Security torpedo zone the
  // march stopped in — on the sample household's torpedo year
  // the execution year priced a $155,100 conversion and a
  // $185,800 fill target where the march filled $16,400.
  guardrail = false,
): ExecutionYearResult {
  const age = currentYear - plan.birthYearPrimary;
  const execInputs: RothPlanInputs = {
    ...plan,
    startYear: currentYear,
    endAgePrimary: age,
    windowStartAge: age,
    windowStopAge: age,
    pretaxStart: exec.pretax ?? plan.pretaxStart,
    pretaxSpouseStart: exec.pretaxSpouse ?? (plan.pretaxSpouseStart ?? 0),
    rothStart: exec.roth ?? plan.rothStart,
    taxableStart: exec.taxable ?? plan.taxableStart,
    hsaStart: exec.hsa ?? plan.hsaStart,
    otherOrdinaryAnnual: exec.otherOrdinaryYtd,
    taxExemptInterestAnnual: exec.taxExemptYtd,
    convertedAlreadyThisYear: exec.alreadyConvertedYtd,
  };
  const pretaxPriced = execInputs.pretaxStart + (execInputs.pretaxSpouseStart ?? 0);
  // Era-aware cliff cap: when the execution year is at or past
  // the plan's first household-schedule step year and the family-only
  // flag is on, the cliff cap is off for this year. The sim's
  // own per-year gate would strip it anyway; stripping once
  // here keeps the fill-target re-solve below (which works
  // from the ceilings directly) pricing the same undefended
  // year the sim priced.
  const execFirstStepYear = acaFirstStepYear(plan.acaHouseholdSchedule);
  const eraCeilings: FillCeilings | null =
    ceilings != null &&
    ceilings.acaCliffCap &&
    ceilings.acaCliffCapFamilyOnly &&
    execFirstStepYear != null &&
    currentYear >= execFirstStepYear
      ? { ...ceilings, acaCliffCap: false }
      : ceilings;
  const result = simulateRothPlan(execInputs, {
    id: "execution-year",
    name: "This year",
    ceilings: eraCeilings,
    // S-10: the guardrail rides the strategy literal, so the
    // one-year march prices with the same marginal-rate stop
    // as the plan's own march (its fill, its ceiling
    // convergence, and its cliff / IRMAA grow-backs all read
    // the strategy's guardrail through the one
    // guardrailTargetPct derivation in simulateRothPlan).
    guardrail,
  });
  const y = result.years[0] ?? null;
  const base: ExecutionYearResult = {
    status: "ok",
    year: y,
    remaining: 0,
    totalConversion: y ? y.conversion : 0,
    ytdConverted: exec.alreadyConvertedYtd,
    fillTarget: null,
    fillTargetLabel: null,
    overshoot: 0,
    overshootLabel: null,
    boundLabel: y ? y.detail.fill.boundLabel : null,
    fillOutcome: y ? y.detail.fill.outcome : null,
    availableAdditional: y
      ? Math.max(0, y.detail.priorPretaxBalance - y.rmd)
      : 0,
    pretaxPriced,
  };
  if (!y) return { ...base, status: "no-room" };
  if (eraCeilings == null || !ceilingsActive(eraCeilings)) {
    return { ...base, status: "no-ceiling" };
  }
  const fill = executionFillTarget(plan, execInputs, y, eraCeilings, guardrail);
  base.fillTarget = fill.target;
  base.fillTargetLabel = fill.targetLabel;
  // When the preserve reserve is what stopped the priced
  // year's fill, the year's own conversion IS the fill target
  // (the ceiling solver alone would have gone further), and
  // the reserve names it.
  const reserveCap = y.detail.fill.caps.find((c) => c.kind === "preserve");
  if (reserveCap?.bound) {
    base.fillTarget = y.conversion;
    base.fillTargetLabel = reserveCap.label;
  }
  if (pretaxPriced <= 0) return { ...base, status: "not-priced" };
  const additional = Math.max(0, y.conversion - y.conversionAlready);
  base.remaining = Math.max(0, y.conversion - exec.alreadyConvertedYtd);
  if (base.remaining > 0) {
    const balanceCapped =
      base.fillTarget != null &&
      base.fillTarget > y.conversion + 0.005 &&
      additional >= base.availableAdditional - 0.005;
    return { ...base, status: balanceCapped ? "balance-capped" : "ok" };
  }
  // Remaining is $0: attribute the cause from the priced
  // figures. An overshot cap (the priced year's measured figure
  // past its cap) decides first — then whether INCOME ALONE, at
  // $0 of conversion, already overshoots that same cap (priced
  // through the engine's priceYear on the settled year's base),
  // or whether the YTD conversions are what carried the year
  // past the fill.
  // The preserve-reserve cap is excluded: it is a floor the
  // balance sits ABOVE by design, so its actual > cap is the
  // normal state, never an overshoot.
  const overshot = y.detail.fill.caps
    .filter((c) => c.kind !== "preserve" && c.actual > c.cap + 0.005)
    .sort((a, b) => b.actual - b.cap - (a.actual - a.cap))[0];
  if (overshot) {
    const atZero = priceYear({
      calendarYear: y.year,
      filingStatus: y.filingStatus,
      agePrimary: y.agePrimary,
      ageSpouse: y.ageSpouse,
      otherOrdinary: execInputs.otherOrdinaryAnnual,
      rmd: y.rmd,
      conversion: 0,
      extraPreTaxDraw: y.detail.extraPreTaxDraw,
      ssBenefits: y.ssBenefits,
      taxExemptInterest: execInputs.taxExemptInterestAnnual,
      ...executionLedgerFields(plan, y),
      inflationPct: plan.inflationPct,
      stateRatePct: plan.stateRatePct,
      residenceState: plan.residenceState ?? null,
      // Education expenses (T6): this execution year's
      // entered students ride the at-zero pricing too, so
      // every pricing of the settled year carries the same
      // credits (the measures read here — taxable income
      // and MAGI — do not depend on credits, but the year
      // is priced whole, exactly as the sim priced it).
      educationStudents: (plan.educationStudents ?? []).filter(
        (e) => e.year === y.year,
      ),
    });
    const measureAtZero =
      overshot.kind === "bracket" || overshot.kind === "ltcgZero"
        ? atZero.taxableIncome
        : overshot.kind === "acaCliff"
          ? atZero.acaMagi
          : atZero.magi;
    return {
      ...base,
      status:
        measureAtZero > overshot.cap + 0.005
          ? "over-ceiling-income"
          : "over-ceiling-conversions",
      overshoot: Math.round((overshot.actual - overshot.cap) * 100) / 100,
      overshootLabel: overshot.label,
    };
  }
  return { ...base, status: "no-room" };
}

/* ---------------- Playground ("Playground") ----------------
   One standalone year, priced from typed dials — the inverse of
   the execution year above: instead of solving for the
   conversion that fills the plan's ceilings, the user TYPES the
   conversion (and the year's other income) and this prices
   where the year lands. Every figure comes from the shared
   engine's own one-year machinery — priceYear (the same pass
   simulateRothPlan settles each plan year with), rmdForYear for
   the RMD, acaCreditFor for the premium credit, and the IRMAA
   tier helpers — so the playground can never disagree with the
   plan. There is NO second tax implementation here and no state:
   the inputs are request-only scratch (client-side state),
   never persisted, never part of the saved shape or a scenario.

   Conventions: the conversion is stacked LAST in the ordinary
   stack (after other ordinary income, the RMD, and taxable
   Social Security) for the bracket-landing readout; the year is
   priced under the named year's own law row (for a year past
   the law table, the current-law row), with the law row's
   statute-fixed dollar amounts deflated at the inflation rate
   the caller supplies (the inflationPct input — the plan's own
   rate, so a future year prices exactly as the plan march
   prices it; absent, the amounts stand undeflated, the
   pre-S-4 pricing); the pre-tax balance, when
   entered, is the combined prior-Dec-31 balance and the RMD
   runs on the primary's clock (rmdForYear — the Joint Life
   table when the spouse is sole beneficiary and more than 10
   years younger), exactly the plan's primary RMD rule. */

export type PlaygroundYearInputs = {
  taxYear: number;
  filingStatus: FilingStatus;
  agePrimary: number;
  ageSpouse: number | null; // joint returns only
  // Medicare status per person — drives IRMAA (people on
  // Medicare) vs ACA (people not on Medicare) treatment. The
  // client defaults each to that person's age being 65+ and
  // lets the user override.
  onMedicarePrimary: boolean;
  onMedicareSpouse: boolean;
  interest: number;
  // TOTAL ordinary dividends, exactly as printed on the
  // Form 1040 (line 3b) / 1099-DIV: this total INCLUDES the
  // qualified part below. The pricer counts dividends once —
  // the non-qualified part (total − qualified) rides the
  // ordinary stack and the qualified part rides the gains
  // stack (see pricePlaygroundYear).
  ordinaryDividends: number;
  otherOrdinary: number; // wages, pension, etc.
  taxExemptInterest: number;
  ssPrimary: number;
  ssSpouse: number; // joint returns only
  // The typed Roth conversion for the year. A conversion is
  // priced as ordinary income exactly like any pre-tax money
  // out, but it is NOT spendable cash: it moves money from
  // pre-tax to Roth and creates no cash to spend, so it never
  // enters cashIn (M-2 split, engines review round 2 — before
  // the split it did, and a big enough conversion flipped the
  // "enough for the year" verdict by itself). A pre-tax amount
  // taken out FOR SPENDING rides the separate spendingDraw
  // dial below: same tax pricing, but spendable cash.
  conversion: number;
  // A pre-tax DRAW taken for spending (M-2 split; supplied
  // by the December console and by the Playground projection
  // in draw mode — absent / 0 on every other caller, and the
  // year then prices bit-identically to before): priced
  // through the SAME pre-tax money-out stack as the conversion
  // (priceYear's conversion dial receives conversion +
  // spendingDraw — a distribution for spending is taxed
  // identically to a conversion dollar-for-dollar in a single
  // year), but UNLIKE a conversion it IS spendable cash, so it
  // is the money-out term cashIn counts. The two solvers vary
  // the conversion dial alone, with any draw held fixed.
  spendingDraw?: number;
  // Cash and Roth funding draws (S-6, engines review round
  // 2; supplied by the Playground's own dials and by the
  // saved-plan-year loader from the march's funding ledger —
  // absent / 0 on every other caller, and the year then
  // prices bit-identically to before): money taken out of
  // the CASH sleeve (cashDraw) and out of the ROTH accounts
  // (rothDraw) to fund the year's spending. Each is priced
  // as its OWN source: a cash draw is the household's own
  // cash coming back — no sale, no gain, no income — and a
  // Roth draw is a distribution of already-taxed money,
  // which the single-year pricer treats as tax-free funding
  // exactly as the plan march's funding ledger does (its
  // rothDraw row is a source, never income) — WHILE its
  // composition shelters it (Engine Review C9, Build 2 —
  // W3): the non-qualified earnings portion of a Roth draw
  // IS ordinary income, priced through the other-ordinary
  // dial, plus the §72(t) 10% under 59½ (see the
  // rothContributionBasis / rothConversionLots /
  // firstRothYear inputs below and the result's
  // rothEarningsIncome / rothPenalty). With no composition
  // entered the draw prices under the assumed-qualified
  // default — tax-free, with the result's rothBasisUnknown
  // / rothAssumedQualified flags saying so. The CASH draw
  // never enters the tax pricing at all — not AGI, not
  // MAGI, not the ACA or IRMAA bases, not the gains stack;
  // the ROTH draw enters it only through its non-qualified
  // earnings portion (above). Both draws enter cashIn, as
  // spendable funding, beside the spending draw.
  // Before S-6 the Playground had no dial for either, so a
  // cash- or Roth-funded year showed no funding for the
  // money that actually paid its spending and its verdict
  // read short by the whole draw (the mirror image of M-2:
  // a $100,000 cash drawing read −$78,500 "Short" against
  // $180,000 of spending where the true answer is +$21,500
  // "Enough" — pinned by the tax suite's
  // tax-engines-playground-cash-roth-funding-s6 fixture).
  cashDraw?: number;
  rothDraw?: number;
  // ROTH BASIS / CLOCK (Engine Review C9, Build 2 — W3):
  // the composition facts the rothDraw dial above prices
  // against — the single-owner (primary) form of the march's
  // per-owner ledgers. All optional — absent / null on every
  // pre-existing caller, and the year then prices exactly as
  // before ($0 income, $0 penalty on the Roth draw) with the
  // result's rothBasisUnknown / rothAssumedQualified flags
  // saying the $0 is unknown, not computed:
  // · rothContributionBasis — the regular contributions
  //   still sitting in the Roth accounts (ordering tier 1,
  //   always tax-free, never penalized). An entered 0 is a
  //   real answer.
  // · rothConversionLots — the prior conversions still
  //   sitting in the Roth IRA, one lot per conversion year,
  //   FIFO (ordering tier 2; the 10% prices on the TAXABLE
  //   portion withdrawn while the owner is under 59½ and
  //   the lot is inside its own 5-year period). An entered
  //   empty list is a real answer (no prior conversions).
  // · firstRothYear — the first taxable year of any Roth IRA
  //   contribution (the qualified-distribution 5-year
  //   clock). Absent while earnings are reached prices the
  //   earnings as ordinary income (the non-qualified
  //   direction) with the flag set.
  // · firstDesignatedRothYear — the first taxable year of
  //   designated Roth contributions to the employer plan
  //   (that plan's own 5-year clock). It governs ONLY the
  //   employer ledger's earnings; it never carries into a
  //   Roth IRA on rollover (see taxEngine's rollover clock
  //   rule). The pricer holds ONE combined ledger for the
  //   draw: the IRA clock governs the IRA share, the
  //   designated clock the employer share — see
  //   pricePlaygroundYear.
  // · rothBalance — the Roth balance the draw comes out of
  //   (the total of both accounts). Absent = the draw is
  //   assumed to come out of a balance at least as large as
  //   the draw itself (the draw prices in full, never
  //   capped by an unknown balance).
  // · rothIraBalance / rothEmployerBalance — the split of
  //   that balance between the Roth IRA and the designated
  //   Roth employer plan. Both absent = the whole balance
  //   is a Roth IRA (the single-clock case); only the
  //   employer share entered = the IRA share is the balance
  //   less the employer share. The draw debits the IRA
  //   ledger first, then the employer ledger, each on its
  //   own 5-year clock (firstRothYear / firstDesignatedRothYear
  //   above) — the march's per-account ordering, in
  //   single-owner form. The entered contribution basis
  //   splits across the two accounts in proportion to their
  //   balances; entered conversion lots attach to the IRA
  //   ledger.
  rothContributionBasis?: number | null;
  rothConversionLots?: RothConversionLotInput[] | null;
  firstRothYear?: number | null;
  firstDesignatedRothYear?: number | null;
  rothBalance?: number | null;
  rothIraBalance?: number | null;
  rothEmployerBalance?: number | null;
  // Reinvested yield (S-3, engines review round 2; supplied
  // ONLY by the saved-plan-year loader — absent / false on
  // every other caller, and the year then prices
  // bit-identically to before): the year's interest and
  // ordinary dividends are the plan march's taxable yield,
  // which the march REINVESTED — it stays inside the taxable
  // balance (the balance grows at the full expected return,
  // of which the yield is a component) and counts $0 of
  // funding in the march's funding ledger. The yield still
  // prices as income in full (AGI, MAGI, tax, credit are
  // exactly as without the flag); only the cash-in readout
  // changes: the reinvested yield is NOT spendable cash, so
  // cashIn excludes interest + ordinaryDividends. Before
  // this flag the loader's construction counted the same
  // yield as cash ON TOP of the march-sized sales and draws
  // that funded the year — the yield was spent twice, and a
  // loaded year repriced with more cash left than the march
  // funded, by the yield (plus the pre-M-2 conversion term,
  // and less any cash-sleeve or Roth funding the Playground
  // has no dial for: diff = yield + conversion − cashSpend
  // − rothDraw on the settlement's identity).
  yieldReinvested?: boolean;
  // Inflation (S-4, engines review round 2; optional —
  // absent / null on every pre-existing caller, and the
  // year then prices bit-identically to before): the
  // annual inflation rate, in percent, at which the
  // year's statute-fixed dollar amounts are deflated —
  // the SAME rate the plan march prices with (the saved
  // record's inflationPct, planInputsFromSaved's 2.5
  // default), handed to the shared priceYear pass and to
  // the IRMAA tier helpers exactly as the march hands it,
  // so a future year prices its §86 Social Security
  // thresholds, §1411 NIIT thresholds, senior-deduction
  // amount, SALT caps, and IRMAA lines at their deflated
  // values and agrees with the march on taxable Social
  // Security, tax, and NIIT — and the cliff / bracket
  // fill solvers, which price through this same function,
  // solve to the march's conversions. Before S-4 the
  // pricer hard-coded 0, so a future year priced those
  // amounts at their undeflated law-row values and
  // disagreed with the march by amounts that grow with
  // the horizon. The Playground supplies the saved plan's
  // rate — inflation's home record is the Tax Plan, so
  // there is deliberately no second Playground dial for
  // it — falling back to the plan default 2.5 when no
  // plan rate is stored. A rate at or below −100% is
  // outside the deflation factor's domain and reads as
  // unset (the request and paste validators reject it
  // before it can reach here).
  inflationPct?: number | null;
  stockSold: number;
  stockBasis: number;
  // Qualified dividends, exactly as printed on the Form 1040
  // (line 3a): a SUBSET of ordinaryDividends (line 3b) above,
  // never an amount on top of it. When an entered pair breaks
  // that rule (qualified > total), pricePlaygroundYear clamps
  // the qualified part to the total before pricing (audit
  // S-8/S-11) — the excess prices on neither stack.
  qualifiedDividends: number;
  // Combined pre-tax balance at the prior Dec 31, or null when
  // not entered — null prices no RMD and caps nothing. When
  // pretaxBalanceSpouse is present (below), this field is the
  // PRIMARY's own balance instead, and the two balances are
  // kept apart for the RMD step.
  pretaxBalance: number | null;
  // December-fix optional inputs — ABSENT (undefined / null)
  // on every pre-existing caller, and each prices bit-
  // identically to before:
  // · pretaxBalanceSpouse: the spouse's own prior-Dec-31
  //   pre-tax balance. When present, the spouse's RMD is
  //   computed on the spouse's OWN clock — rmdForYear with
  //   the roles swapped (owner = spouse, beneficiary =
  //   primary), so the table selection mirrors the
  //   primary's exactly: the Joint and Last Survivor Table
  //   when the primary is the spouse's sole beneficiary and
  //   more than 10 years younger, the Uniform Lifetime
  //   Table otherwise (round-2 fix: the spouse branch
  //   originally always used the Uniform table) — and added
  //   to the year's RMD income beside the primary's.
  // · primarySoleBeneficiaryOfSpouse: the SECOND
  //   beneficiary fact (round-3 fix) — the primary is the
  //   sole beneficiary of the SPOUSE's pre-tax accounts.
  //   It ALONE gates the spouse branch's Joint-table
  //   selection above. spouseSoleBeneficiary (below) says
  //   the spouse is the PRIMARY's sole beneficiary and
  //   drives ONLY the primary's table selection, exactly
  //   as before round 2; the round-2 spouse branch read it
  //   symmetrically, which inferred a reciprocal
  //   designation the one fact does not establish.
  //   Absent / null / false = NOT established → the
  //   spouse's RMD prices on the Uniform Lifetime Table
  //   (the conservative direction — Uniform gives the
  //   larger RMD). Carriage (N-1, engines review round 2):
  //   the Playground's "Start from my numbers" prefill now
  //   carries this fact from the saved plan record into
  //   the Playground's pricing (before N-1 the prefill
  //   carried only spouseSoleBeneficiary, so a prefilled
  //   year priced the spouse's RMD on the Uniform table
  //   even when the record established reciprocity); the
  //   remembered form, the paste payload, and the
  //   runPlaygroundYear request carry it the same way.
  // · rmdAlreadyReceived: the part of this year's computed
  //   RMD the household has ALREADY received (and already
  //   counted in its entered income). The RMD income the
  //   pricer adds is the gross RMD net of this amount,
  //   floored at $0, so a paid RMD is never counted twice.
  //   Supplied by the December console and, since S-2
  //   (engines review round 2), by the Playground's own
  //   dial — before S-2 the Playground passed none, so a
  //   year whose entered income already held a paid RMD
  //   priced that RMD twice.
  // · firstRmdDeferralPrimary / firstRmdDeferralSpouse
  //   (Engine Review 5, E5-S2): the first-RMD deferral
  //   election, per owner — true defers a first RMD year to
  //   April 1 of the following year, exactly as the march
  //   prices it. A single-year price has no threaded state,
  //   so first-RMD status reads off the ages (the priced
  //   age is the year the owner reaches their RMD age); an
  //   election entered past the first-RMD year is a no-op
  //   and the response names $0 deferred. The deferred
  //   amount from a prior year's election enters as
  //   firstRmdDeferredCarryPrimary / firstRmdDeferredCarrySpouse
  //   (dollars) and prices on top of this year's own RMD —
  //   the two-RMD year. A standalone year prices no death
  //   (the single-year inputs carry no survivor scenario),
  //   so the death-year rule — no deferral in a death year —
  //   never engages here.
  firstRmdDeferralPrimary?: boolean | null;
  firstRmdDeferralSpouse?: boolean | null;
  firstRmdDeferredCarryPrimary?: number | null;
  firstRmdDeferredCarrySpouse?: number | null;
  // · dependentMagiForAca: a filing dependent's MAGI that
  //   belongs in the §36B household MAGI (Form 8962 line 2b)
  //   ONLY. It is added to the ACA MAGI the credit / cliff
  //   step reads — never to AGI, taxable income, federal or
  //   state tax, or the IRMAA MAGI. Supplied by the
  //   December console (its filing-dependent stray) and,
  //   since S-2, by the Playground's own dial — before S-2
  //   the Playground passed none, so a year with a filing
  //   dependent priced its ACA position on the parents'
  //   MAGI alone and could show a credit (and an under-the-
  //   cliff position) the household is not owed.
  pretaxBalanceSpouse?: number | null;
  // Rule-of-55 eligibility for the pre-tax spending draw
  // (Engine Review C9, Build 1 fix 1 — SHOULD 2): the eligible
  // 401(k) balance and separation age per owner — the SAME four
  // inputs the plan march carries on RothPlanInputs (and the
  // saved record carries in cents). All optional — absent /
  // null = unanswered, and the year's pre-tax spending draw
  // then prices $0 penalty with the disclosure flag set on a
  // pre-59½ year (the march's bit-identical landing default),
  // exactly as an unanswered march year does. The pricer
  // replicates the march's eligible-first ledger for the draw
  // (RMD, then conversion, then draw — see
  // pricePlaygroundYear), so these are the ENTERED balances;
  // the draw-time remainders are computed inside. NOT part of
  // the runPlaygroundYear request yet — no API/client wiring
  // in this fix (the engine prices the disclosure on the
  // unanswered default until a caller supplies them).
  pretax401kEligiblePrimary?: number | null;
  pretax401kEligibleSpouse?: number | null;
  separationAgePrimary?: number | null;
  separationAgeSpouse?: number | null;
  rmdAlreadyReceived?: number | null;
  dependentMagiForAca?: number | null;
  primarySoleBeneficiaryOfSpouse?: boolean | null;
  spouseSoleBeneficiary: boolean;
  acaHouseholdSize: number | null;
  acaBenchmarkAnnual: number | null;
  stateRatePct: number;
  // State of residence (T3 build; optional — absent / null /
  // "other" = the flat stateRatePct prices the state tax,
  // bit-identical to before; "WA" = Washington's
  // capital-gains excise prices it instead, on the year's
  // realized stock gain only). Part of the paste payload
  // (cold-AI audit fix): a paste carries it so replaying the
  // paste reprices the same state layer; pastes written
  // before it was included carry no such key and load with
  // it absent (the flat rate), exactly as before.
  residenceState?: "WA" | "other" | null;
  // Itemized deductions (T5 build; all optional — absent /
  // 0 = blank, and the year prices on the standard side
  // exactly as before): the year's itemized components,
  // priced through the same shared priceYear greater-of
  // rule as a plan year (the SALT component capped at the
  // typed taxYear's law-row cap). The charitable component
  // is the one charitable input — on a Washington year it
  // is also the donations figure the RCW 82.87.080
  // deduction prices from. Part of the paste payload
  // (P-M2, parity audit): a paste carries all four
  // components so replaying the paste reprices the same
  // deduction; pastes written before they were included
  // carry none of the four keys and load with them absent
  // (the standard side), exactly as before. (An earlier
  // note here claimed the opposite by analogy to
  // residenceState; the analogy was false — residenceState
  // IS carried — and the parity audit's M2 finding settled
  // it: the exclusion was a silent drop, not a contract.)
  itemizedMortgageInterest?: number;
  itemizedSaltPaid?: number;
  itemizedCharitable?: number;
  itemizedOther?: number;
  // Education expenses (T6 build; optional — absent / null /
  // empty = no students entered, no credits price, and the
  // year prices exactly as before): the year's students,
  // each with their qualified expenses and the household's
  // AOTC-eligibility mark, priced through the same shared
  // priceYear §25A step as a plan year. Part of the paste
  // payload (cold-AI audit fix): a paste carries the list so
  // replaying the paste reprices the same credits; pastes
  // written before it was included carry no such key and
  // load with it absent (no students), exactly as before.
  educationStudents?: EducationStudent[] | null;
  // Capital-loss carryforward entering the year (contract
  // v111, round-17 fix F1+F2; supplied by the December
  // console and, since S-2 (engines review round 2), by
  // the Playground's own dials — absent / 0 when neither
  // supplies them, and the year then prices bit-identically
  // to before): the banked
  // short-term and long-term losses from prior years, in
  // dollars, stated as positive amounts, plus the
  // Washington-attributable portion of each (a portion of
  // that character's total, clamped inside the ledger).
  // When any carry-in is positive, pricePlaygroundYear
  // runs the year's own net long-term result through the
  // SAME shared applyLossLedger the plan march uses: the
  // carry-in nets against the year's gains, the §1211(b)
  // allowance is the ledger's, the Washington excise base
  // is the gross gains minus only the Washington-
  // attributable part the gains actually absorbed (so the
  // federal and Washington bases can differ — the F2
  // defect was one signed gain serving both), and the
  // result carries the reconciled carry-out. With no
  // carry-in (and no net loss of the year's own — R1) the
  // ledger never runs and the in-year-only pricing below
  // is untouched; with no carry-in but a newly realized
  // net loss, the ledger runs on the loss alone and the
  // result carries the carry-out that loss generates.
  capitalLossCarryInSt?: number;
  capitalLossCarryInLt?: number;
  capitalLossCarryInStWa?: number;
  capitalLossCarryInLtWa?: number;
  // Gain harvest (build v113, round-17 fix F3; supplied
  // by the December console and, since P-S3 (parity
  // audit), by the runPlaygroundYear request and the
  // paste payload — absent / null on every other caller,
  // and the year then prices bit-identically to before): the
  // taxable pool available to sell and its basis, the two
  // facts the plan march's harvest sizes itself from
  // (simulateRothPlan's harvestOn block). The march draws on
  // the COMBINED taxable pool (the Taxable bucket plus the
  // Cash bucket — the pool resolvePlanBalances assembles)
  // and sizes against its TOTAL basis dollars; tier walking
  // in the march moves only the basis step-up bookkeeping
  // between years, never the size, so a single pool amount
  // plus its BLENDED basis % (basis dollars ÷ pool) carries
  // the sizing exactly: available unrealized gain = pool −
  // pool × basisPct / 100. BOTH facts present = price a
  // harvest inside this pricing (see pricePlaygroundYear);
  // either absent = no harvest is priced and harvestedGain
  // reads $0 — the December layer, which owns the toggle,
  // decides whether that absence is a silent $0 or an
  // unpriced-harvest qualification on the settlement.
  harvestPoolAmount?: number | null;
  harvestPoolBasisPct?: number | null;
  // ACA reconciliation facts (build v193, re-audit round 3
  // SHOULD-4; supplied by the December console AND, since
  // S-1 (engines review round 2), by the Playground, whose
  // dials carry the same three facts — a year priced
  // without them prices bit-identically to before): the
  // facts of the year's FILING
  // SETTLEMENT — the advance premium credit actually taken
  // during the year (aptcTaken), the premium of the plan
  // actually enrolled in (acaEnrollmentPremiumAnnual, when
  // entered), and the coverage-month reduction
  // (acaCoverageReduction, dollars). When aptcTaken is
  // present, pricePlaygroundYear prices the settlement
  // itself inside the shared pricer — the final allowable
  // credit (the priced credit capped at the enrollment
  // premium when one is supplied, less the coverage
  // reduction, $0 over the cliff), the credit still due
  // and the excess-APTC repayment against aptcTaken, with
  // the reconciliation running on the effective final
  // credit (the priced credit; $0 when nobody in the
  // household can be on the marketplace, a known-zero
  // credit; unpriced only when someone is marketplace-
  // eligible but no benchmark was entered) — and
  // netTaxBill IS that settlement, so cashLeftAfterTax is
  // the year's cash left after its filing settlement: the
  // same figure the December console reports for the same
  // year and facts (the console adds only its taxable
  // cash at its assembly). Absent aptcTaken no
  // reconciliation is priced: the credit is treated as
  // fully advanced against the year's premiums — the plan
  // model's treatment, in which the household pays the
  // NET premium and the credit never settles in cash — and
  // netTaxBill is the total tax less the refundable
  // education credit exactly as before. The annual spending
  // the cash left is compared against does NOT hold the
  // premium in either form: since build v208 the health
  // premium is priced separately, in the cash left after
  // health premiums readout, so the credit counts once —
  // in the settlement when the facts are supplied, in the
  // net premium readout when they are not — and never
  // twice. (The earlier F7 wording claimed the spending
  // already held the net premium; v208 inverted that
  // premise, which is what let the Playground's
  // un-reconciled cash left disagree with December's
  // settlement figure by the whole credit — S-1.) When
  // the facts are present but
  // the settlement cannot price — the credit genuinely
  // unpriced, or a pre-2026 year whose APTC taken exceeds
  // the effective final credit (the capped-repayment
  // rules are not modeled) — netTaxBill falls back to
  // that same un-reconciled bill; the December layer,
  // which owns the facts, shows no cash left in those
  // cases instead of either figure.
  aptcTaken?: number | null;
  acaEnrollmentPremiumAnnual?: number | null;
  acaCoverageReduction?: number | null;
  // Health premium term (build v208; optional — absent /
  // null on every pre-existing caller, December included,
  // and the year then prices bit-identically to before):
  // the year's GROSS marketplace premium of the plan
  // actually enrolled in (healthPremiumAcaAnnual — read
  // only when someone is not on Medicare this year) and
  // the Medicare BASE premium per person on Medicare
  // (healthPremiumMedicarePerPerson — Part B standard +
  // Part D base, excluding the IRMAA surcharge, which the
  // irmaa block prices separately for premiumYear + 2).
  // The pricer reports the year's gross and NET health
  // premium (net = the marketplace gross less the year's
  // priced credit capped at that gross, plus the Medicare
  // base in full) and cashLeftAfterHealthPremium =
  // cashLeftAfterTax − the net premium. The premium never
  // enters the tax, the MAGI, or netTaxBill: it is a cash
  // cost of the year, reported beside them.
  healthPremiumAcaAnnual?: number | null;
  // The two marketplace premium TIERS (ChatGPT SHOULD-1;
  // optional — absent / null on every pre-existing caller,
  // and the year then prices bit-identically to before):
  // the household (two-person) amount and the single
  // amount, in dollars per year. The single-year pricer
  // above reads NEITHER — it prices the one applicable
  // amount in healthPremiumAcaAnnual, the plan actually
  // enrolled in for the priced year. The projection walk
  // (projectPlaygroundYears) reads both and resolves the
  // applicable tier per walked year — the household amount
  // while both spouses are on the marketplace, the single
  // amount while exactly one is — the march's own
  // per-year resolution (taxEngine.ts healthGrossAca).
  // Before, the template carried only the one amount and
  // the walk spread it into every year, so a spouse-only
  // year priced the two-person premium. A template with
  // neither tier entered (an older stored template, or a
  // directly built one) keeps the old spread: the walk
  // prices the one amount in every year, exactly as
  // before, so no stored template silently reprices.
  healthPremiumAcaHouseholdAnnual?: number | null;
  healthPremiumAcaSingleAnnual?: number | null;
  healthPremiumMedicarePerPerson?: number | null;
  // IRMAA surcharge payable THIS year (internal review
  // round 3 SHOULD-2; optional — absent / null on every
  // pre-existing caller, and the year then prices
  // bit-identically to before): the Medicare Income-Related
  // Monthly Adjustment Amount actually payable in the
  // priced year, in dollars for the whole household — the
  // figure on the household's Medicare premium notice, or
  // the plan march's own IRMAA for that year. The forward
  // irmaa block prices the surcharge this year's MAGI will
  // cause in premiumYear (taxYear + 2); this input prices
  // the surcharge this year PAYS, which depends on the
  // MAGI from two years prior and no input carried before
  // this build — so a Medicare year charged the base
  // premium in cashLeftAfterHealthPremium and silently
  // omitted the surcharge on the same premium, and the
  // "enough for the year" verdict overstated by the whole
  // payable amount. The amount is charged beside the base
  // premium in cashLeftAfterHealthPremium — never in
  // netTaxBill, so the December console's cash left (which
  // derives from cashLeftAfterTax) is untouched and its
  // premium-free verdict stays consistent. Blank = no
  // payable IRMAA charged, exactly as before; a negative
  // amount is floored at $0 by the pricer (the request
  // validator rejects it before it can reach here).
  // Single-year only: the projection walk prices no
  // payable IRMAA (see projectPlaygroundYears) and the
  // stored projection template does not carry this fact
  // (see projTemplateCore) — a walked year has its own
  // payable IRMAA, which no single entered amount can
  // state.
  irmaaPayableAnnual?: number | null;
  // Annual spending (build v126, "enough for the year"):
  // the year's annual spending in dollars, for the
  // cash-left-vs-spending comparison ONLY — it never enters
  // the tax pricing (no income, no MAGI, no credit, no tax
  // reads it), so a year priced with it is bit-identical to
  // the same year priced without it except for the two
  // comparison readouts. Absent / null = no spending given,
  // no comparison is shown.
  annualSpending?: number | null;
  // ACA guideline convention (Playground projection build):
  // absent / "lookback" = the single-year rule — acaCreditFor
  // prices the coverage year off the PRIOR year's poverty
  // guidelines, the statutory §36B lookback. "newest" = the
  // plan convention for projected future years — the cliff
  // prices off the NEWEST guideline row in the table, in
  // today's dollars, the same carry-forward the plan engine
  // reaches for years past the guideline table. This is the
  // ONE sanctioned difference between a projected year and
  // the single-year pricer for the same inputs: every other
  // figure is bit-identical. Only the guideline year moves —
  // the applicable-percentage table still keys on the real
  // coverage year (its fallback row is the newest table), and
  // the convention never invents a cliff for a pre-2026 year
  // (the enhanced-credit years have none under either rule).
  // Build C adds a SECOND sanctioned difference, on the
  // applicable-percentage table alone: under "newest" the
  // year is PROJECTED pricing (acaCreditFor's projected
  // mode) — a projected coverage year 2027 prices on the
  // 2027 table, projected years after 2027 on the 2026
  // table (engine-audit round-2 fix) — while under
  // "lookback" a specific coverage year prices its own
  // table — including the 2027 table (Rev. Proc. 2026-26)
  // for coverage year 2027 exactly. Build v95 (F1)
  // keeps the two years separate inside acaCreditFor: the
  // relabelled coverage year governs only the guideline
  // row, and the table keys on the real coverage year
  // passed as tableYear — so a relabelled 2026 prices on
  // the 2026 table, never on the 2027 table the relabel
  // names, while a real 2027 still prices on the 2027
  // table under either convention.
  acaConvention?: "lookback" | "newest";
};

export type PlaygroundYearResult = {
  // Income stack (engine-priced components).
  interest: number;
  // The total ordinary dividends as entered (Form 1040
  // line 3b — includes the qualified part).
  ordinaryDividends: number;
  // The NON-qualified part of that total — max(0, total −
  // qualified) — the part that rides the ordinary stack.
  // (On an impossible pair — qualified entered above the
  // total — the qualified part is clamped to the total
  // first, so this is $0 and the total prices once, all of
  // it on the gains stack; the excess prices nowhere.)
  nonQualifiedDividends: number;
  otherOrdinary: number;
  // Ordinary-stack total: interest + non-qualified
  // dividends + other ordinary income.
  otherOrdinaryTotal: number;
  rmdPriced: boolean;
  // The RMD income actually priced (the gross RMD net of
  // any rmdAlreadyReceived). With no received amount typed
  // this is the gross RMD, exactly as before.
  rmd: number;
  // December-fix RMD detail: the gross computed RMD before
  // the received netting, its per-owner split (the spouse
  // part is $0 unless a spouse balance was entered), and
  // the received amount actually applied against it.
  rmdGross: number;
  rmdPrimary: number;
  rmdSpouse: number;
  rmdAlreadyReceived: number;
  // First-RMD deferral detail (Engine Review 5, E5-S2):
  // the amount deferred THIS year (a first RMD year the
  // election priced at $0) and the amount deferred from a
  // prior year PAID this year (part of rmdPrimary /
  // rmdSpouse above, named here so the two-RMD year is
  // readable). The rmdPrimary / rmdSpouse figures above
  // are the SETTLED amounts paid this year — $0 for an
  // owner whose first RMD was deferred, the carry plus
  // this year's own RMD in a two-RMD year.
  rmdDeferredPrimary: number;
  rmdDeferredSpouse: number;
  rmdDeferredPaidPrimary: number;
  rmdDeferredPaidSpouse: number;
  // The dependent MAGI added to the ACA MAGI only (the
  // dependentMagiForAca input, echoed; $0 when absent).
  dependentMagiForAca: number;
  rmdDivisor: number | null;
  rmdTable: "joint" | "uniform" | null;
  ssBenefits: number;
  ssTaxable: number;
  ssPctTaxed: number; // % of benefits taxed under §86 (0 when no benefits)
  taxExemptInterest: number;
  conversion: number;
  stockGain: number; // sold − basis (negative = the sale is a loss)
  // The qualified dividends AS PRICED — the entered figure
  // clamped to the ordinary-dividends total (audit S-8/S-11),
  // so on an impossible pair this reads the total, never the
  // entered excess.
  qualifiedDividends: number;
  // The literal clamp inputs AS ENTERED (re-audit SHOULD
  // S-7): the two dividend dials exactly as supplied to the
  // pricer, before the S-8/S-11 clamp — so a consumer can
  // see what was entered beside what was priced, and how
  // much the clamp trimmed (qualifiedDividendsExcess, $0 on
  // a possible pair; qualifiedDividendsWasClamped names
  // whether it trimmed anything). Pure echoes of this
  // function's own inputs and its already-computed clamped
  // figure — the clamp itself is unchanged.
  ordinaryDividendsEntered: number;
  qualifiedDividendsEntered: number;
  qualifiedDividendsWasClamped: boolean;
  qualifiedDividendsExcess: number;
  // The net capital gain or loss from CAPITAL transactions
  // only (the stock gain; negative = a net capital loss).
  // Qualified dividends are NOT capital gains for netting
  // (round-7 R7-1): a net capital loss never reduces them.
  ltcgNet: number;
  // What the preferential stack priced: the priced capital
  // gain, max(0, ltcgNet), PLUS the qualified dividends as
  // clamped to the ordinary total.
  ltcgPriced: number;
  capitalLoss: number; // max(0, −ltcgNet) — the net capital loss for the year
  // The IRC §1211(b) capital-loss allowance priced this
  // year: min($3,000, capitalLoss), applied against
  // ordinary income. $0 when there is no net capital
  // loss. Any loss beyond the allowance is not priced
  // (in real life it carries forward).
  capitalLossAllowance: number;
  // Capital-loss carryforward LEAVING the year (contract
  // v111): the entering carry-in (plus any of the year's
  // own net loss) that neither the year's gains nor the
  // USED part of the §1211(b) allowance consumed,
  // reconciled once against the priced year's final
  // taxable income before the allowance — the plan march's
  // year-end reconciliation pattern. The Washington fields
  // are the Washington-attributable portions of the same
  // carry-out. All four are $0 whenever the ledger did not
  // run — no carry-in entered and the year's own result
  // not a loss. Since R1 (parity re-review) the ledger
  // also runs on a newly realized loss alone, so a year
  // with no carry-in entered still reports the carry-out
  // its own net loss generates.
  lossCarryOutSt: number;
  lossCarryOutLt: number;
  lossCarryOutStWa: number;
  lossCarryOutLtWa: number;
  // The long-term gain this pricing's harvest realized into
  // the 0% capital-gains band (build v113): the largest
  // gain, capped by the entered pool's unrealized gain,
  // whose addition to the year's gains stack leaves every
  // harvested dollar inside the 0% band (the plan march's
  // harvest predicate — gains priced at 15% / 20% do not
  // rise). It is already INSIDE ltcgNet / ltcgPriced / agi /
  // acaMagi above (it rides the gains stack through
  // priceYear, netted by any entering loss carryforward
  // exactly as the march's ledgerFields nets it, and counts
  // in the Washington base and the NIIT base the same way);
  // this field only NAMES the harvested part. $0 whenever
  // no harvest facts were supplied or no gain fit the band.
  harvestedGain: number;
  agi: number;
  magi: number;
  acaMagi: number;
  // Deductions → taxable income.
  baseStandardDeduction: number;
  age65AddonTotal: number;
  count65: number;
  standardDeduction: number;
  seniorDeduction: number;
  // Itemized deduction (T5): the year's itemized total
  // after the §164(b)(7) SALT cap, the SALT amount allowed
  // after that cap, and which side of the greater-of
  // comparison the year's deduction took. $0 / "standard"
  // when no itemized amounts are typed.
  itemizedDeduction: number;
  itemizedSaltAllowed: number;
  deductionTaken: "standard" | "itemized";
  // 2026 deduction trio: the charitable amount allowed
  // inside the itemized total after the §170(b)(1)(I)
  // floor, the §68 reduction taken off the itemized
  // total, and the §170(p) non-itemizer charitable
  // deduction applied below the line (§63(b)(4): inside
  // deductions below as part of the standard side; agi /
  // magi / acaMagi above are NOT reduced by it).
  // All $0 under the 2025 law row.
  itemizedCharitableAllowed: number;
  section68Reduction: number;
  nonItemizerCharitableDeduction: number;
  // Education credits (T6): the year's §25A credits under
  // the winning allocation — the tentative AOTC after its
  // phase-out, the tentative Lifetime Learning Credit
  // after its phase-out, the choice taken, the
  // nonrefundable portion applied (already inside
  // federalTax), and the refundable AOTC portion
  // (reported separately; NOT inside federalTax or
  // totalTax). All $0 / "none" when no students are
  // entered.
  educationAotc: number;
  educationLlc: number;
  educationChoice: "aotc" | "llc" | "none";
  educationNonrefundable: number;
  educationRefundable: number;
  // Alternative minimum tax (T7): the year's AMTI, the
  // §55(d) exemption after its phase-out, the tentative
  // minimum tax, and the AMT owed (already inside
  // federalTax / totalTax — these lines name the
  // component and the year's AMT position). amtOwed is
  // $0 whenever the tentative tax does not exceed the
  // regular tax.
  amti: number;
  amtExemption: number;
  amtTentativeTax: number;
  amtOwed: number;
  deductions: number;
  taxableIncome: number;
  ordinaryTaxableIncome: number;
  gainsInTaxableIncome: number;
  bracketLayers: RothYear["detail"]["bracketLayers"];
  // Gains stack.
  gainsAt0: number;
  gainsAt15: number;
  gainsAt20: number;
  gainsZeroRoomLeft: number; // 0%-zone room left after this year's gains
  // Tax.
  ordinaryTax: number;
  ltcgTax: number;
  niit: number;
  federalTax: number;
  stateTax: number;
  // Washington excise breakdown (T3; $0 unless residence is
  // Washington): the WA-allocated gains entering the excise
  // base, the standard deduction applied, and the taxable
  // Washington capital gains the tiered rate priced. The
  // charitable deduction prices from the year's one
  // charitable input (T5 — the itemized charitable
  // component) and is $0 when none is typed.
  waGains: number;
  waStandardDeduction: number;
  waTaxableGains: number;
  totalTax: number;
  // Early-withdrawal penalty on the pre-tax spending draw
  // (Engine Review C9, Build 1 fix 1 — SHOULD 2): the §72(t)
  // penalty on the year's spendingDraw, priced with the
  // march's draw-loop semantics (per-owner own-age test,
  // eligible-first shelter, separation-age gate — see
  // pricePlaygroundYear's ledger). $0 when the draw was fully
  // sheltered, absent, or post-59½, and $0 with the flag below
  // when the eligibility was unanswered. It is NOT inside
  // totalTax above (the Tax block's federal + state display)
  // — it IS inside netTaxBill below, the year's net tax bill,
  // exactly as the march's funding row carries federal +
  // penalty. A conversion carries no penalty here (a rollover;
  // its only penalty is withheld tax, which this pricer never
  // models).
  earlyWithdrawalPenalty: number;
  // True exactly when this year priced a pre-59½ pre-tax
  // spending draw while the drawing owner's eligibility was
  // unanswered (no eligible balance entered for that owner)
  // — so the $0 penalty above is UNKNOWN, not a computed $0.
  // False when every pre-59½ pre-tax draw was priced with
  // the eligibility answered, and false in every year with no
  // pre-59½ pre-tax draw.
  earlyWithdrawalEligibilityUnknown: boolean;
  // Cash-in / cash-left readouts (build v114): cashIn is
  // every dollar of cash the year's entered income brings
  // in — interest, the TOTAL ordinary dividends (Form 1040
  // line 3b, its qualified part included, counted once),
  // other ordinary income, tax-exempt interest, the FULL
  // Social Security benefits (not just the taxable part),
  // the year's RMD cash, a pre-tax SPENDING DRAW when one
  // rides the spendingDraw dial (the December console's
  // draw), the CASH and ROTH funding draws when they ride
  // the cashDraw / rothDraw dials (S-6 — spendable funding
  // priced as its own source: no sale, no gain, no income),
  // and the gross proceeds of any stock sale (its
  // return-of-basis part included — it is cash in hand, not
  // income). A Roth CONVERSION is never in it (M-2 split,
  // engines review round 2): a conversion moves money from
  // pre-tax to Roth — it creates no cash to spend — so
  // counting it overstated the cash left by the whole
  // conversion and could flip the "enough for the year"
  // verdict on a year with no spendable cash at all. The RMD cash
  // is counted ONCE (build v127, round-19 finding 2):
  // the part already received sits inside other ordinary
  // income — the input contract states it is already
  // counted in the entered income — and the priced net RMD
  // is the part still to come, so the two together are the
  // gross RMD with no term added for the received part a
  // second time. A harvested gain is NOT in it: a harvest's
  // proceeds are reinvested by construction, never cash in hand. netTaxBill
  // (build v116) is the year's NET tax bill. When the
  // caller supplies the year's reconciliation facts
  // (aptcTaken — build v193, re-audit round 3 SHOULD-4) it
  // is the year's FILING SETTLEMENT: totalTax less the
  // credit still due, plus any excess advance credit to
  // repay, less the refundable education credit — the
  // identical figure the December console settles the
  // same year on, so the two surfaces' cash left cannot
  // disagree. When no facts are supplied it is totalTax
  // plus the §72(t) penalty on the pre-tax spending draw
  // (C9 fix 1 — SHOULD 2), less the refundable education
  // credit alone: the ACA
  // premium credit is NOT subtracted then — it is treated
  // as fully advanced, and it offsets only the separately
  // priced health premium (build v208: the annual spending
  // the cash left is compared against does NOT hold the
  // premium; the premium is priced in the cash left after
  // health premiums readout). The Playground supplies the
  // facts since S-1, so its cash left is the settlement
  // form; a caller that supplies none gets the plan-model
  // form. (The plan score identity's own netting still
  // credits both beside the tax — that is the march's
  // lifetime score, not this single-year cash readout.)
  // When the facts are supplied but the settlement cannot
  // price (credit genuinely unpriced, or a pre-2026
  // repayment unmodeled), the bill falls back to the
  // un-reconciled form. cashLeftAfterTax
  // is cashIn minus netTaxBill — BEFORE any spending: what
  // the year leaves in hand once its tax is settled. Pure
  // readouts of the same pricing; no priced figure moves.
  // ONE exception to the cashIn definition above (S-3):
  // when the caller supplies yieldReinvested (the
  // saved-plan-year loader — the year's interest and
  // dividends are the plan march's yield, which the march
  // reinvested and counted as $0 of funding), cashIn
  // EXCLUDES interest and the total ordinary dividends:
  // that yield is not spendable cash on top of the
  // march-sized sales and draws the loader also loads, and
  // counting it spent the same yield twice.
  netTaxBill: number;
  cashIn: number;
  cashLeftAfterTax: number;
  // Reinvested yield (S-3): the yieldReinvested input echoed,
  // and the amount it kept out of cashIn — interest + the
  // TOTAL ordinary dividends when the flag was supplied, $0
  // otherwise. The yield still priced as income in full
  // (interest / ordinaryDividends / agi above are untouched);
  // these two fields only name what the cash readout did.
  yieldReinvested: boolean;
  reinvestedYield: number;
  // Cash and Roth funding draws (S-6): the cashDraw /
  // rothDraw inputs echoed — the spendable funding each
  // draw added to cashIn ($0 when the caller supplied
  // none). The draws priced as their own source: they are
  // in cashIn and in NO income, gain, MAGI, or tax figure
  // above — EXCEPT the Roth draw's non-qualified earnings
  // portion (Engine Review C9, Build 2 — W3): that portion
  // IS ordinary income, priced through the other-ordinary
  // dial (see rothEarningsIncome below), so a Roth draw
  // prices the same tax as the same year funded any other
  // way ONLY while its composition shelters it.
  cashDraw: number;
  rothDraw: number;
  // ROTH DRAW ORDERING (Engine Review C9, Build 2 — W3):
  // the Roth draw's priced pieces, following the march's
  // ordering (contributions → conversion lots FIFO →
  // earnings, IRA ledger first, then the employer ledger,
  // on the primary's age):
  // · rothEarningsIncome — the non-qualified earnings
  //   portion of the draw, priced as ordinary income
  //   (inside agi / magi / acaMagi above, through the
  //   other-ordinary dial — Roth distributions are NOT
  //   net investment income, so the NIIT base never sees
  //   it). $0 on a qualified or basis-covered draw.
  // · rothPenalty — the §72(t) 10% on the taxable portion
  //   of conversion lots inside their 5-year period and on
  //   non-qualified earnings, both under 59½. It IS inside
  //   netTaxBill below (beside earlyWithdrawalPenalty),
  //   never inside totalTax above.
  // · rothBasisUnknown — true when the draw priced while
  //   the composition was unentered (contributions and/or
  //   lots absent) — so the $0 income and $0 penalty above
  //   are UNKNOWN, not computed. False when the draw was
  //   priced with the composition answered, and false with
  //   no draw.
  // · rothAssumedQualified — true exactly when the draw
  //   priced under the assumed-qualified default (basis
  //   absent): the draw is treated as a qualified
  //   distribution because no composition was entered to
  //   say otherwise. False whenever the composition was
  //   entered (the draw then prices on its own facts), and
  //   false with no draw.
  rothEarningsIncome: number;
  rothPenalty: number;
  rothBasisUnknown: boolean;
  rothAssumedQualified: boolean;
  // Pre-tax spending draw (R3-M1, engines review round 3):
  // the spendingDraw input echoed — the part of the year's
  // pre-tax money out that was taken FOR SPENDING and so
  // counted in cashIn ($0 when the caller supplied none).
  // The conversion above is the other part: income in full,
  // never cash in. Before R3-M1 the result carried no such
  // echo, and the Playground's form had no draw dial at
  // all — its one money-out dial fed the conversion alone,
  // so a draw priced through the form read as a conversion
  // and its cash left fell by the whole draw.
  spendingDraw: number;
  // Inflation priced with (S-4): the inflationPct input
  // resolved — the rate the year's statute-fixed amounts
  // were deflated by, echoed so a consumer can see which
  // treatment priced the year. 0 when the caller supplied
  // none (the pre-S-4 pricing).
  inflationPct: number;
  // Health premium term (build v208): the year's GROSS
  // health premium (the entered marketplace premium when
  // someone is not on Medicare, plus the entered Medicare
  // base premium × the persons on Medicare this year) and
  // the NET premium, and the cash left after BOTH tax and
  // the net premium. The marketplace part of the net is the
  // gross less the credit cash actually received toward the
  // premium: when the year's filing settlement prices
  // (S-1 — the reconciliation facts supplied and the
  // settlement priced), that is the advance credit taken —
  // the rest of the final credit settles inside the net
  // tax bill, so the credit counts exactly once across the
  // two readouts; when no settlement prices, the credit is
  // treated as fully advanced and the marketplace part is
  // the gross less the year's priced credit, capped at
  // that part (an unpriced credit — no benchmark entered —
  // leaves the marketplace part in full). The Medicare part
  // always counts in full. All three are $0 /
  // cashLeftAfterTax itself when no premium input was
  // supplied, so a year priced without them is bit-identical.
  healthPremiumGross: number;
  healthPremiumNet: number;
  // IRMAA surcharge payable this year (internal review
  // round 3 SHOULD-2): the irmaaPayableAnnual input as
  // charged — floored at $0, $0 when none was entered.
  // It is the surcharge actually payable IN the priced
  // year, beside the forward irmaa block's surcharge for
  // premiumYear (taxYear + 2) — the two are different
  // figures and must never be confused: the forward
  // block's annualHousehold can coincide with this
  // amount (the tier-1 per-person amount is the same in
  // both years' tables in the worked example) without
  // being the same surcharge.
  irmaaPayableAnnual: number;
  cashLeftAfterHealthPremium: number;
  // Annual spending for the "enough for the year" comparison
  // (build v126): the annualSpending input echoed in
  // dollars — null when no spending was given — and the
  // comparison itself: cashLeftAfterHealthPremium minus
  // that spending (R3-M3: the spending the comparison is
  // against EXCLUDES health premiums — build v208 reads
  // annualSpending that way — so the cash it is compared
  // against must be the cash left after the year's net
  // health premium, not the cash left after tax alone;
  // before R3-M3 the comparison subtracted the spending
  // from cashLeftAfterTax and overstated the verdict by
  // the whole net premium whenever one priced). Positive
  // = enough for the year, negative = short of a year's
  // spending. Pure readouts of the same pricing (the
  // spending never enters the tax); null exactly when no
  // spending was given, so a year priced without one is
  // bit-identical. When no premium prices, the net premium
  // is $0 and cashLeftAfterHealthPremium IS
  // cashLeftAfterTax, so the comparison is bit-identical
  // to before R3-M3 on every such year.
  annualSpending: number | null;
  cashLeftVsSpending: number | null;
  // Bracket landing for the conversion (stacked last): the
  // bracket its last dollar falls in, that bracket's top, the
  // room left in it, and whether it is filled exactly. All null
  // when no conversion dollar reaches taxable income (no
  // conversion typed, or deductions shelter all of it).
  landingBracketPct: number | null;
  landingBracketTop: number | null; // null top = the open-ended top bracket
  landingRoomLeft: number | null;
  landingExactlyFilled: boolean;
  // The conversion's own price: federal tax with the typed
  // conversion minus federal tax on the same year at $0 of
  // conversion (two engine pricings).
  conversionFederalCost: number;
  conversionTotalCost: number; // the same difference, state tax included
  // Watch-out: the typed pre-tax money out (the conversion
  // plus any spending draw) exceeds the pre-tax balance
  // left after the priced RMD (only when a balance was entered).
  conversionExceedsBalance: boolean;
  // ACA: applies when at least one person is NOT on Medicare.
  aca: {
    applies: boolean;
    everyoneOnMedicare: boolean;
    householdSize: number | null;
    fpl: number | null;
    cliff: number | null; // 400% FPL for the household size and year
    pctFpl: number | null;
    overCliff: boolean;
    // cliff − ACA MAGI: positive = under the cliff by that much,
    // negative = over it by that much.
    positionDollars: number | null;
    // Estimated credit — null when no benchmark premium was
    // entered (the credit is then not priced at all).
    credit: number | null;
    applicablePct: number | null;
    // ELIGIBILITY (Engine Review 6, E6-S2): true when the
    // year's ACA MAGI is under 100% FPL — the credit is $0
    // under the standard §36B income test, with the reason
    // in eligibilityNote (null when not below 100%). False
    // when the ACA block does not apply at all.
    below100Fpl: boolean;
    eligibilityNote: string | null;
  };
  // IRMAA: applies when at least one person is on Medicare
  // in the premium year (by premium-year age, not by the
  // priced year's Medicare flags). The tier is this year's
  // MAGI read through the premium year's law row — the
  // surcharge it sets is paid in premiumYear (taxYear + 2).
  irmaa: {
    applies: boolean;
    personsOnMedicare: number;
    tier: number;
    premiumYear: number;
    monthlyPerPerson: number;
    annualPerPerson: number;
    annualHousehold: number;
    // The MAGI line where the NEXT tier starts (the current
    // tier's ceiling) and the room under it; null at the top tier.
    nextTierLine: number | null;
    roomToNextTier: number | null;
  };
  // Gains-deciding flags: the same year priced a second time
  // through the shared engine with the gains stack zeroed
  // (stock-sale gain and qualified dividends both 0, everything
  // else identical). A flag is present only when that second
  // pricing changes the ACA outcome or the IRMAA tier — silent
  // (both flags null) when no gains were typed or when the
  // gains change neither outcome. Every counterfactual figure
  // in a flag comes from that second engine pricing, never
  // from subtracting displayed figures.
  gainsFlags: PlaygroundGainsFlags;
  // Sale-after-tax line for the readout's Tax block: present
  // only when a stock sale was typed (stockSold > 0 — qualified
  // dividends alone never trigger it, the line is about sale
  // cash). All three figures are whole dollars, rounded exactly
  // as the readout prints them, and the leftover is derived
  // FROM those rounded figures, so printed proceeds − printed
  // tax = printed leftover, always. `text` is the
  // ready-to-render sentence; when the tax netted against the
  // sale exceeds the proceeds it says so plainly instead of
  // printing a negative "left".
  saleAfterTax: PlaygroundSaleAfterTax | null;
};

// The sale-after-tax line's figures: the cash a typed stock
// sale brought in, netted against the year's TOTAL tax as
// priced (total federal tax — ordinary + gains, NIIT included —
// plus the state tax whenever a state rate is typed and priced,
// plus the §72(t) early-withdrawal penalty on the pre-tax
// spending draw when one is priced — C9 fix 2; the sentence
// therefore never calls the figure federal). It does NOT net
// the refundable education credit or the APTC settlement
// adjustments (credit still due / excess repayment) that
// netTaxBill carries (C9 fix 3): leftover == proceeds −
// netTaxBill only in the no-credit / no-settlement case — in a
// credit or settlement shape the leftover differs from
// proceeds − netTaxBill by exactly −educationRefundable −
// creditStillDue + excessAptcRepayment, and the sentence names
// the three items it nets instead of calling the figure "this
// year's total tax".
export type PlaygroundSaleAfterTax = {
  proceeds: number; // the typed sale amount, whole dollars as printed
  totalTax: number; // displayed federal + displayed state + displayed penalty, whole dollars as printed
  // proceeds − totalTax at the printed (whole-dollar) precision;
  // negative when the tax netted against the sale exceeds the
  // sale's cash.
  leftover: number;
  text: string;
};

// One ACA gains flag: the typed gains stack was the deciding
// factor for the year's ACA outcome. `kind` distinguishes the
// cliff flip (either direction) from a credit change with no
// flip. All dollar figures are engine-priced (typed run and
// without-gains run); `text` is the ready-to-render sentence.
export type PlaygroundAcaGainsFlag = {
  kind: "flipped-over" | "flipped-under" | "credit-changed";
  gainsStack: number; // sale gain + qualified dividends, as typed (negative = net loss)
  typedOverCliff: boolean;
  withoutOverCliff: boolean;
  typedPositionDollars: number | null;
  withoutPositionDollars: number | null;
  typedCredit: number | null;
  withoutCredit: number | null;
  withoutAcaMagi: number;
  text: string;
};

// One IRMAA gains flag: the typed gains stack moved the year
// across an IRMAA tier line. `line` is the MAGI line crossed
// (the ceiling of the lower of the two tiers).
export type PlaygroundIrmaaGainsFlag = {
  kind: "tier-up" | "tier-down";
  gainsStack: number;
  typedTier: number;
  withoutTier: number;
  premiumYear: number;
  line: number | null;
  text: string;
};

export type PlaygroundGainsFlags = {
  // The preferential income as priced: sale gain + qualified
  // dividends as clamped to the ordinary total (NOT a
  // netting — a sale loss in it never reduces the dividends
  // the engine priced; negative = the priced total is a loss).
  gainsStack: number;
  // True when anything was typed into the gains stack at all
  // (a non-zero sale gain or any qualified dividends).
  hasGainsTyped: boolean;
  // The without-gains run's headline figures (second engine
  // pricing, gains stack zeroed).
  withoutMagi: number;
  withoutAcaMagi: number;
  withoutTier: number;
  acaFlag: PlaygroundAcaGainsFlag | null;
  irmaaFlag: PlaygroundIrmaaGainsFlag | null;
};

/* The Playground's "Cash left after tax" justification text
   (S-1, engines review round 2): the exact words the
   Playground's ⓘ renders after its cash-in and net-bill
   figures, exported so the client renders this constant
   verbatim and the accuracy fixtures pin its substance —
   the filing-settlement definition of the bill, and the
   build v208 premium treatment (the premium is NOT in the
   annual spending; it is priced separately), which is what
   makes the settlement form the honest one. The earlier
   text claimed the spending already held the net premium;
   v208 inverted that premise, and the Playground's cash
   left disagreed with December's by the whole credit until
   S-1 supplied the reconciliation facts. */
export const PLAYGROUND_CASH_LEFT_BASIS =
  "the net tax bill is the year's filing settlement — the total tax, less the premium credit still due at filing, plus any advance credit taken above the final credit to repay, less any refundable education credit. The health premium is not in the annual spending: since the premium build it is priced separately, in the cash left after health premiums — so the credit counts once, here in the settlement, and the premium counts once, in its own readout.";

/* S-12 (engines review round 2, settled STAND): the spouse's
   pre-tax balance is the SPOUSE's money — it counts toward a
   year's pre-tax total only on a joint return. A balance typed
   while filing jointly goes stale when the filing switches to
   single or head of household: the spouse dial keeps its value
   in the form state, but none of it is the filer's to draw.
   Before this gate, every total of the pair in this module —
   the pricer's balance total (and with it the
   conversionExceedsBalance check), the projection walk's
   combined balance, and both fill solvers' draw caps — summed
   the stale balance in, so a single filer holding $50,000 with
   a stale $200,000 spouse balance was capped at $250,000 and
   the ACA cliff fill solved a $62,600 draw (the whole
   household-of-1 cliff room) against money the filer does not
   hold. The gate lives here, in the shared pricing module, so
   every caller prices the exclusion identically — the
   Playground's fill chips, the December console (whose
   headline and per-case draws solve through
   solvePlaygroundAcaCliffFill on inputs that carry the
   console's entered split verbatim), and any future caller.
   An MFJ year is untouched: the spouse's balance counts in
   full, exactly as before. (The spouse's RMD branch below was
   already joint-gated; the totals were the leak.) */
function countedSpousePretax(inp: {
  filingStatus: FilingStatus;
  pretaxBalanceSpouse?: number | null;
}): number | null {
  return inp.filingStatus === "mfj"
    ? (inp.pretaxBalanceSpouse ?? null)
    : null;
}

export function pricePlaygroundYear(inp: PlaygroundYearInputs): PlaygroundYearResult {
  const fs = inp.filingStatus;
  const joint = fs === "mfj";
  const ageSpouse = joint ? inp.ageSpouse : null;
  const law = lawForYear(inp.taxYear);
  // The inflation the year prices with (S-4): the caller's
  // rate when it is a usable one (finite and above −100% —
  // the deflation factor 1 / (1 + p/100)^n needs p > −100),
  // else 0, the pre-S-4 pricing — bit-identical for every
  // caller that supplies nothing (the December console
  // included; its year is the current year, whose deflation
  // factor is 1 at any rate). This one resolved rate feeds
  // the priceYear pass below and every IRMAA tier call in
  // this pricing, exactly as the plan march feeds its own
  // rate to the same helpers.
  const inflationPct =
    inp.inflationPct != null &&
    Number.isFinite(inp.inflationPct) &&
    inp.inflationPct > -100
      ? inp.inflationPct
      : 0;
  const ssBenefits = r2(inp.ssPrimary + (joint ? inp.ssSpouse : 0));
  // The year's pre-tax money out, split by purpose (M-2,
  // engines review round 2): the conversion (money moved to
  // Roth — NOT spendable cash) and the spending draw (money
  // taken out to spend — spendable cash). The TAX pricing
  // cannot tell them apart and must not: both are ordinary
  // income dollar-for-dollar, so priceYear's conversion dial
  // below receives the SUM. Only the cash-in readout separates
  // them — it counts the draw and never the conversion.
  const spendingDraw = Math.max(0, inp.spendingDraw ?? 0);
  const moneyOut = r2(inp.conversion + spendingDraw);
  // Cash and Roth funding draws (S-6, engines review round
  // 2): spendable funding priced as its own source — the
  // draws never enter the tax pricing below (no stack reads
  // them); they join cashIn only, at the readout. Absent
  // reads $0, bit-identical to before.
  const cashDraw = Math.max(0, inp.cashDraw ?? 0);
  const rothDraw = Math.max(0, inp.rothDraw ?? 0);
  // ROTH DRAW ORDERING (Engine Review C9, Build 2 — W3):
  // the rothDraw dial above, priced on the primary's
  // ledgers — the single-owner form of the march's
  // per-owner ledgers (contributions → conversion lots
  // FIFO → earnings, IRA ledger first, then the employer
  // ledger, each on its own 5-year clock, on the primary's
  // whole-year age). The balance split resolves exactly
  // like the march's (see the input fields' notes): an
  // absent total balance is assumed at least as large as
  // the draw, so the draw prices in full, never capped by
  // an unknown balance. The earnings portion is ordinary
  // income — it rides the base's otherOrdinary dial below
  // (Roth distributions are NOT net investment income, so
  // the NIIT base never sees it) — and the penalty joins
  // the result beside the pre-tax draw's penalty. With no
  // composition entered the draw prices under the
  // assumed-qualified default ($0 income, $0 penalty) and
  // the flags below say so. The draw's FULL amount still
  // joins cashIn (spendable funding), and the earnings
  // never join otherOrdinaryTotal (that echo is the
  // ENTERED income only — the draw's cash is already in
  // cashIn as rothDraw).
  const rothEmployerBal = Math.max(0, inp.rothEmployerBalance ?? 0);
  const rothIraBal =
    inp.rothIraBalance != null
      ? Math.max(0, inp.rothIraBalance)
      : inp.rothBalance != null
        ? Math.max(0, inp.rothBalance - rothEmployerBal)
        : Math.max(0, rothDraw - rothEmployerBal);
  const rothBasisSplit = splitRothBasisAcrossAccounts(
    inp.rothContributionBasis,
    rothIraBal,
    rothEmployerBal,
  );
  const pgRothLedger: RothOwnerLedger = {
    ira: initRothAccountLedger(
      rothIraBal,
      rothBasisSplit.ira,
      inp.rothConversionLots,
      inp.firstRothYear,
    ),
    employer: initRothAccountLedger(
      rothEmployerBal,
      rothBasisSplit.employer,
      // As in the march: the employer ledger never holds
      // conversion lots, so its lot list is entered-empty,
      // never unentered — otherwise the ledger would stay
      // unknown whatever the caller entered.
      [],
      inp.firstDesignatedRothYear,
    ),
  };
  const pgRothOut =
    rothDraw > 0
      ? debitRothOwnerLedger(pgRothLedger, rothDraw, {
          year: inp.taxYear,
          age: inp.agePrimary,
        })
      : { drawn: 0, income: 0, penalty: 0, unknown: false };
  const rothEarningsIncome = r2(pgRothOut.income);
  const rothPenalty = r2(pgRothOut.penalty);
  const rothBasisUnknown = pgRothOut.unknown;
  const rothAssumedQualified =
    rothDraw > 0 &&
    inp.rothContributionBasis == null &&
    inp.rothConversionLots == null;
  // Dividends are entered exactly as printed on the Form
  // 1040: ordinaryDividends is the line 3b TOTAL, which
  // already includes the line 3a qualified part. Count them
  // once by splitting the total — the non-qualified part
  // (total − qualified, floored at $0) rides the ordinary
  // stack, the qualified part rides the gains stack below.
  // THE CLAMP (audit S-8 + S-11, settled — the shared fix):
  // on a real 1099-DIV the qualified figure cannot exceed
  // the total, so the qualified part is clamped to the
  // total before any pricing reads it. Before this clamp
  // only the non-qualified part was floored, and an entered
  // excess (qualified > total) priced whole on the gains
  // stack — phantom dividends entering AGI, MAGI, and the
  // ACA / NIIT bases. Now the entered total is the ceiling:
  // the pair prices at most the total, counted once, and
  // every figure below (the priceYear pass, ltcgPriced, the
  // gains flags, this result's qualifiedDividends) reads
  // the clamped figure, never the entered excess.
  const qualifiedDividends = r2(
    Math.min(
      Math.max(0, inp.qualifiedDividends),
      Math.max(0, inp.ordinaryDividends),
    ),
  );
  const nonQualifiedDividends = r2(
    Math.max(0, inp.ordinaryDividends - qualifiedDividends),
  );
  const otherOrdinaryTotal = r2(inp.interest + nonQualifiedDividends + inp.otherOrdinary);
  const stockGain = r2(inp.stockSold - inp.stockBasis);
  // Capital netting (round-7 R7-1, defect 5.1; §§1222/1211(b)/
  // 1(h)): capital gains and losses net against each other
  // ONLY. The stock gain/loss is the year's net capital
  // result; qualified dividends are not capital gains and are
  // never netted against a capital loss — they stay whole in
  // the preferential stack (ltcgPriced below and the
  // qualifiedDividends passed to priceYear separately). A
  // net capital loss reaches ordinary income only through
  // the §1211(b) allowance: up to $3,000 of it offsets
  // ordinary income this year. (Before this fix the loss was
  // netted against the qualified dividends first, erasing
  // them from AGI and inventing ACA credit.)
  // Entering capital-loss carryforward (build v111,
  // round-17 fix F1+F2): when any carry-in is entered, the
  // year's own net long-term result runs through the SAME
  // shared applyLossLedger the plan march's ledgerFields
  // runs — trial pricing takes the netted result, the
  // CLAIMED allowance, and the Washington base (gross gains
  // minus only the Washington-attributable part the gains
  // absorbed) with utilization UNBOUNDED, and the carry-out
  // is reconciled once, after priceYear, against the priced
  // year's taxable income before the allowance (the plan's
  // year-end pattern). When no carry-in is entered (and,
  // since R1 below, the year's own result is not a loss)
  // the ledger never runs and every figure below is the
  // pre-v111 in-year computation, term for term.
  // R1 (parity re-review, MUST): the ledger ALSO runs when
  // the year's own typed result is itself a net loss, even
  // with no carry-in entered — a newly realized loss is a
  // carryforward the year generates, not only one it can
  // inherit. With a zero carry-in the ledger's trial
  // transform is the identity term for term (net result =
  // the gross result, allowance = the in-year §1211(b)
  // figure, Washington absorbed part $0), so the year's own
  // pricing is unchanged; only the year-end reconciliation
  // below gains a figure — the new loss's carry-out,
  // reconciled against the final taxable income exactly as
  // an inherited carry-in's is. (The harvested gain sized
  // below is never negative, so the year's total result can
  // be negative only when the typed result already is —
  // the gate reads the typed result alone.)
  const carryInSt = Math.max(0, inp.capitalLossCarryInSt ?? 0);
  const carryInLt = Math.max(0, inp.capitalLossCarryInLt ?? 0);
  const carryInStWa = Math.max(0, inp.capitalLossCarryInStWa ?? 0);
  const carryInLtWa = Math.max(0, inp.capitalLossCarryInLtWa ?? 0);
  const lossLedgerOn = carryInSt > 0 || carryInLt > 0 || stockGain < 0;
  // The priceYear gains fields for a GROSS capital result
  // (the typed stock gain, plus any harvested gain when the
  // harvest below sizes one): with the ledger on, the
  // shared ledger's transform at that gross total — the
  // plan march's ledgerFields, term for term; without it,
  // the identity (the gross result prices as-is, the
  // allowance is the in-year §1211(b) figure). The harvest
  // search and the final pricing both read this one
  // transform, so they can never disagree about the year's
  // netting.
  const gainsFieldsFor = (
    grossGains: number,
  ): {
    ltcg: number;
    capitalLossAllowance: number;
    waGainsBase?: number;
  } => {
    if (!lossLedgerOn) {
      return {
        ltcg: grossGains,
        capitalLossAllowance: Math.min(3000, Math.max(0, -grossGains)),
      };
    }
    const led = applyLossLedger(
      { st: carryInSt, lt: carryInLt },
      grossGains,
      fs,
      Number.POSITIVE_INFINITY,
      { st: carryInStWa, lt: carryInLtWa },
    );
    return {
      ltcg: led.netResult,
      capitalLossAllowance: led.allowance,
      waGainsBase: r2(grossGains - led.waAbsorbedByGains),
    };
  };
  let ltcgNet = stockGain;
  let capitalLossAllowance = Math.min(3000, Math.max(0, -stockGain));
  let waGainsBase: number | undefined;
  {
    const f0 = gainsFieldsFor(stockGain);
    ltcgNet = f0.ltcg;
    capitalLossAllowance = f0.capitalLossAllowance;
    waGainsBase = f0.waGainsBase;
  }

  // The year's RMD — the plan's own rule (rmdForYear on the
  // primary's clock, Joint Life when applicable) over the
  // prior-Dec-31 balance. No balance entered → no RMD
  // priced, and the conversion is not capped against anything.
  // December fix: when a SPOUSE balance is entered, the
  // primary's RMD runs on the primary's balance alone and
  // the spouse's RMD is computed on the spouse's OWN clock
  // (rmdForYear with the roles swapped — the same table
  // selection as the primary's: Joint and Last Survivor
  // when the spouse's sole-beneficiary spouse, the
  // primary, is more than 10 years younger; Uniform
  // otherwise) and added; with
  // no spouse balance the single-balance path below is the
  // pre-fix computation term for term. The RMD income the
  // year prices is the gross RMD net of any amount already
  // received (rmdAlreadyReceived, floored at $0) — the
  // received part already sits in the caller's entered
  // income, so pricing it again would count it twice. The
  // balance caps keep using the GROSS RMD: the received
  // part has left the accounts too.
  // S-12: only a JOINT year's spouse balance counts toward
  // the total (countedSpousePretax) — on a single or head-of-
  // household return a spouse balance still on the dial is
  // stale and prices as not entered: no spouse RMD (the branch
  // below was already joint-gated), no addition to the total
  // the conversion is checked against, and — when the primary
  // balance is also unentered — no balance at all (rmdPriced
  // reads false, as a year with nothing entered does).
  const spouseBalanceCounted = countedSpousePretax(inp);
  const hasSpouseBalance = spouseBalanceCounted != null;
  const totalPretaxBalance =
    inp.pretaxBalance == null && !hasSpouseBalance
      ? null
      : r2((inp.pretaxBalance ?? 0) + (spouseBalanceCounted ?? 0));
  let rmdPrimary = 0;
  let rmdSpouse = 0;
  let rmdDivisor: number | null = null;
  let rmdTable: "joint" | "uniform" | null = null;
  if (inp.pretaxBalance != null || hasSpouseBalance) {
    const r = rmdForYear({
      priorDec31PreTax: inp.pretaxBalance ?? 0,
      agePrimary: inp.agePrimary,
      ageSpouse,
      birthYearPrimary: inp.taxYear - inp.agePrimary,
      spouseSoleBeneficiary: inp.spouseSoleBeneficiary,
    });
    rmdPrimary = r.rmd;
    rmdDivisor = r.divisor;
    rmdTable = r.table;
  }
  if (hasSpouseBalance && joint && ageSpouse != null) {
    // The spouse's own RMD, priced by the SAME rule as the
    // primary's with the roles swapped: the owner is the
    // spouse, the beneficiary whose age can select the
    // Joint Life table is the primary. Round-2 fix: this
    // branch originally always used the Uniform Lifetime
    // Table, which overstates the RMD when the primary is
    // the spouse's sole beneficiary and more than 10 years
    // younger (the Joint table's larger divisor applies).
    // Round-3 fix: the table selection is gated on the
    // SECOND beneficiary fact — the primary is the
    // spouse's sole beneficiary
    // (primarySoleBeneficiaryOfSpouse) — never on
    // spouseSoleBeneficiary, which states only that the
    // spouse is the PRIMARY's sole beneficiary and does
    // not establish the reciprocal designation. Absent /
    // false → the Uniform table.
    const rs = rmdForYear({
      priorDec31PreTax: inp.pretaxBalanceSpouse ?? 0,
      agePrimary: ageSpouse,
      ageSpouse: inp.agePrimary,
      birthYearPrimary: inp.taxYear - ageSpouse,
      spouseSoleBeneficiary:
        inp.primarySoleBeneficiaryOfSpouse === true,
    });
    rmdSpouse = rs.rmd;
    if (rmdDivisor == null && rs.divisor != null) {
      rmdDivisor = rs.divisor;
      rmdTable = rs.table;
    }
  }
  // FIRST-RMD DEFERRAL (Engine Review 5, E5-S2): each
  // owner's computed RMD settles through the shared helper.
  // A single-year price has no threaded state, so the
  // year's first-RMD status reads off the ages: an owner
  // is in their first RMD year when the priced age is the
  // first year a computed RMD is PAYABLE — ceil(rmdAge),
  // so a 70.5 RMD age is first payable in the year they
  // turn 71 (at 70 the computed RMD is $0, and the
  // attainment year still counts as the first even on a $0
  // balance — see settleFirstRmdDeferral's rmdAgeReached;
  // a later positive year cannot defer).
  // Ceil is the identity on integer RMD ages, so no other
  // cohort changes, and it matches the optimizer's own
  // window stop (buildOptimizerCandidates uses ceil too).
  // The fresh state seeds had the same way the march's
  // threaded state would stand at this one year: false in
  // the first RMD year (so an election defers) — unless a
  // carried-in deferral enters, which seeds had true, so
  // the year pays its own RMD plus the carry and defers
  // nothing — true in any later year (so an election
  // entered past the first RMD year is a no-op and names $0
  // deferred). The attainment
  // year itself counts even on a $0 balance (it defers $0),
  // so a later positive-balance year is past the first —
  // the march and the roll read it the same way through
  // settleFirstRmdDeferral's rmdAgeReached, so all three
  // engines agree.
  // a deferred first RMD from a prior year on top of this
  // year's own RMD — the two-RMD year. The settled amount
  // is what the year prices as RMD income, what the
  // balance caps read, and what the deferred fields below
  // name; the divisor and table stay the computed ones.
  // No death year is priced here (the single-year inputs
  // carry no survivor scenario), so deathYearForPerson is
  // always false.
  const dState: FirstRmdDeferralState = {
    hadPrimary:
      (inp.firstRmdDeferredCarryPrimary ?? 0) > 0 ||
      !(
        inp.pretaxBalance != null &&
        Math.ceil(rmdAgeForBirthYear(inp.taxYear - inp.agePrimary)) ===
          inp.agePrimary
      ),
    hadSpouse:
      (inp.firstRmdDeferredCarrySpouse ?? 0) > 0 ||
      !(
        hasSpouseBalance &&
        ageSpouse != null &&
        Math.ceil(rmdAgeForBirthYear(inp.taxYear - ageSpouse)) ===
          ageSpouse
      ),
    pendingPrimary: 0,
    pendingSpouse: 0,
  };
  const settledP = settleFirstRmdDeferral(dState, {
    who: "primary",
    computed: rmdPrimary,
    deferElected: inp.firstRmdDeferralPrimary === true,
    deathYearForPerson: false,
    carryIn: Math.max(0, inp.firstRmdDeferredCarryPrimary ?? 0),
    rmdAgeReached:
      inp.agePrimary >=
      Math.ceil(rmdAgeForBirthYear(inp.taxYear - inp.agePrimary)),
  });
  const settledS = settleFirstRmdDeferral(dState, {
    who: "spouse",
    computed: rmdSpouse,
    deferElected: inp.firstRmdDeferralSpouse === true,
    deathYearForPerson: false,
    carryIn: Math.max(0, inp.firstRmdDeferredCarrySpouse ?? 0),
    rmdAgeReached:
      ageSpouse != null &&
      ageSpouse >=
        Math.ceil(rmdAgeForBirthYear(inp.taxYear - ageSpouse)),
  });
  rmdPrimary = settledP.pay;
  rmdSpouse = settledS.pay;
  const rmdGross = r2(rmdPrimary + rmdSpouse);
  const rmdAlreadyReceived = Math.min(
    rmdGross,
    Math.max(0, inp.rmdAlreadyReceived ?? 0),
  );
  const rmd = r2(rmdGross - rmdAlreadyReceived);
  const dependentMagiForAca = Math.max(0, inp.dependentMagiForAca ?? 0);

  // RULE-OF-55 ELIGIBILITY (C9 fix 1 — SHOULD 2): the eligible
  // ledger the year's pre-tax spending draw arrives with,
  // replicating the march's order — the RMD consumes eligible
  // dollars first, then the conversion, then the draw
  // (settleRound's debit order; every pre-tax outflow takes
  // eligible dollars first within its owner's pool). The draw
  // itself splits primary-first across the balances left after
  // the RMD and the conversion, the march's sourcing rule, each
  // side capped by what is actually left there (a draw beyond
  // the pools prices its income in full but its penalty only
  // on the dollars the pools could actually distribute — the
  // march shortfalls the rest instead). All of it is computed
  // ONLY when a pre-tax balance was entered: with no balance
  // the draw cannot be attributed to an owner, so no facts are
  // passed and priceYear prices $0 with the flag set (unknown)
  // on a pre-59½ draw. An entered eligible balance clamps to
  // its owner's pool (the march's init rule); an unentered one
  // stays null (unanswered), never $0.
  const pgPrimaryBalance = Math.max(0, inp.pretaxBalance ?? 0);
  const pgSpouseBalance = Math.max(0, spouseBalanceCounted ?? 0);
  const pgEligP0 =
    totalPretaxBalance == null || inp.pretax401kEligiblePrimary == null
      ? null
      : Math.min(
          Math.max(0, inp.pretax401kEligiblePrimary),
          pgPrimaryBalance,
        );
  const pgEligS0 =
    totalPretaxBalance == null || inp.pretax401kEligibleSpouse == null
      ? null
      : Math.min(
          Math.max(0, inp.pretax401kEligibleSpouse),
          pgSpouseBalance,
        );
  const pgEligP1 =
    pgEligP0 == null ? null : Math.max(0, pgEligP0 - rmdPrimary);
  const pgEligS1 =
    pgEligS0 == null ? null : Math.max(0, pgEligS0 - rmdSpouse);
  const pgConvFromP = Math.min(
    Math.max(0, inp.conversion),
    Math.max(0, pgPrimaryBalance - rmdPrimary),
  );
  const pgConvFromS = Math.max(0, Math.max(0, inp.conversion) - pgConvFromP);
  const pgEligP2 =
    pgEligP1 == null ? null : Math.max(0, pgEligP1 - pgConvFromP);
  const pgEligS2 =
    pgEligS1 == null ? null : Math.max(0, pgEligS1 - pgConvFromS);
  const pgDrawAvailP = Math.max(
    0,
    pgPrimaryBalance - rmdPrimary - pgConvFromP,
  );
  const pgDrawAvailS = Math.max(
    0,
    pgSpouseBalance - rmdSpouse - pgConvFromS,
  );
  const pgDrawP =
    totalPretaxBalance == null
      ? undefined
      : Math.min(spendingDraw, pgDrawAvailP);
  const pgDrawS =
    totalPretaxBalance == null
      ? undefined
      : Math.min(Math.max(0, spendingDraw - (pgDrawP ?? 0)), pgDrawAvailS);
  // C9 fix 4 — SHOULD 2: when the pools cannot distribute the
  // whole draw, the split attributes only part of it and the
  // unattributed remainder is unanswered — its penalty is
  // unknown, not a computed $0. The flag is set on this side
  // (the surface that builds the split), OR-ed into the result
  // below, so the shape holds on the Playground path itself:
  // priceYear (fix 4, SHOULD 1) flags the same remainder
  // through its must-sum contract, and the two agree by
  // construction. The split itself is still passed — the
  // penalty on the dollars the pools COULD distribute stays
  // priced (a partial draw keeps its attributed penalty);
  // only the unattributed remainder is flagged, never
  // re-priced. With no balance entered there is no split at
  // all, so priceYear's no-split path already flags — this
  // term is $0 there by construction.
  const pgSplitShort =
    totalPretaxBalance == null
      ? 0
      : Math.max(0, spendingDraw - (pgDrawP ?? 0) - (pgDrawS ?? 0));
  const pgSplitShortUnknown =
    pgSplitShort > 0 &&
    (inp.agePrimary < 59.5 ||
      (ageSpouse != null && ageSpouse < 59.5));

  const base: PriceYearInput = {
    calendarYear: inp.taxYear,
    filingStatus: fs,
    agePrimary: inp.agePrimary,
    ageSpouse,
    // The three ordinary dials reach priceYear separately —
    // not folded into one lump — so the §1411 NIIT base can
    // tell investment income (interest, and the non-qualified
    // dividends typed here) from other ordinary income: the
    // statute taxes the former, never the latter. The sums
    // priceYear forms (AGI, provisional income, the ordinary
    // stack) are the same total as the folded otherOrdinaryTotal
    // this replaces, term for term.
    otherOrdinary: r2((inp.otherOrdinary ?? 0) + rothEarningsIncome),
    interestIncome: inp.interest,
    // priceYear's ordinaryDividends is the NON-qualified
    // part only (its internal stack contract) — the split
    // of the entered line 3b total computed above.
    ordinaryDividends: nonQualifiedDividends,
    rmd,
    // The pre-tax money out, split by purpose (M-2): the
    // conversion rides priceYear's conversion dial and the
    // spending draw rides its extraPreTaxDraw dial — the two
    // dials sum to the same money-out total, so the year's
    // tax, MAGI, and credit are exactly what the folded
    // moneyOut priced at the same total. The split matters
    // because only the DRAW is a §72(t) distribution: the
    // conversion is a rollover, and the draw's penalty prices
    // on the extraPreTaxDraw dial through the eligibility
    // facts below (C9 fix 1 — SHOULD 2).
    conversion: inp.conversion,
    extraPreTaxDraw: spendingDraw,
    // Rule-of-55 eligibility (C9 fix 1 — SHOULD 2): the
    // eligible balances the draw arrives with and its
    // per-owner split (the ledger above) — passed only when
    // a pre-tax balance was entered; with no balance the draw
    // cannot be attributed, so no facts are passed and the
    // draw prices $0 with the flag set on a pre-59½ year.
    ...(totalPretaxBalance != null
      ? {
          pretax401kEligiblePrimary: pgEligP2,
          pretax401kEligibleSpouse: pgEligS2,
          separationAgePrimary: inp.separationAgePrimary ?? null,
          separationAgeSpouse: inp.separationAgeSpouse ?? null,
          extraPreTaxDrawPrimary: pgDrawP ?? 0,
          extraPreTaxDrawSpouse: pgDrawS ?? 0,
        }
      : {}),
    ssBenefits,
    taxExemptInterest: inp.taxExemptInterest,
    // The capital result passes RAW (negative = a net
    // capital loss): priceYear prices max(0, ltcg) on the
    // gains stack and never nets the loss against the
    // qualified dividends passed beside it. With an
    // entering carryforward (v111) this is the LEDGER-
    // NETTED result (ltcgNet), and the Washington excise
    // prices on its own base — the gross gains minus the
    // Washington-attributable absorbed part — so the two
    // bases can differ; with no carry-in ltcgNet IS the
    // typed stock gain — and when the ledger runs on a
    // newly realized loss alone (R1) the waGainsBase
    // passed is that same figure (nothing Washington-
    // attributable was absorbed), so the excise prices
    // on ltcg exactly as before either way.
    ltcg: ltcgNet,
    ...(waGainsBase != null ? { waGainsBase } : {}),
    qualifiedDividends,
    capitalLossAllowance,
    // The caller's inflation (S-4): priceYear deflates the
    // law row's statute-fixed amounts by the years between
    // the priced year and the law row at this rate — the
    // march's own treatment, so the two agree.
    inflationPct,
    stateRatePct: inp.stateRatePct,
    residenceState: inp.residenceState ?? null,
    // Itemized deductions (T5): the typed components price
    // through the shared greater-of rule, identically to a
    // plan year — absent = blank = the standard side.
    itemizedMortgageInterest: inp.itemizedMortgageInterest,
    itemizedSaltPaid: inp.itemizedSaltPaid,
    itemizedCharitable: inp.itemizedCharitable,
    itemizedOther: inp.itemizedOther,
    // Education expenses (T6): the typed students price
    // through the shared §25A step, identically to a plan
    // year — absent = no students = no credits.
    educationStudents: inp.educationStudents ?? null,
  };
  // Gain harvest (build v113, round-17 fix F3): when the
  // caller supplies the pool / basis facts, size the year's
  // harvest EXACTLY as the plan march sizes its own
  // (simulateRothPlan's harvestOn block): the available
  // unrealized gain is the pool less its basis dollars —
  // LESS this year's typed sale and the basis it retired
  // (SHOULD-3): the pool left after the sale, matching
  // the march's post-settlement cap — and the harvest is
  // the largest amount of it — searched to the cent —
  // whose addition to the year's gross gains leaves the
  // gains priced at 15% and at 20% unchanged, i.e. every
  // harvested dollar lands inside the 0% capital-gains
  // band. The march ALSO caps its search by the
  // strategy's own ceilings (a bracket top, an IRMAA
  // tier cap, a custom MAGI cap, and the ACA cliff cap);
  // the single-year pricer carries no strategy ceilings —
  // its one ceiling, the ACA cliff, is the cliff solver's
  // own target, and because the harvest is sized inside
  // every pricing the solver's trial draws see it too, so
  // the solved draw shrinks by the harvested gain when the
  // cliff target binds. The harvested gain rides the gains
  // stack through the SAME gainsFieldsFor transform as the
  // typed gain — an entering loss carryforward absorbs it
  // first (the march's ledgerFields nets the total
  // including the harvest), and Washington / NIIT price it
  // exactly as priceYear prices any long-term gain in the
  // stack. When either fact is absent, no harvest is sized
  // and every figure below is the pre-v113 pricing, term
  // for term.
  let harvestedGain = 0;
  const harvestPool = inp.harvestPoolAmount ?? null;
  const harvestBasisPct = inp.harvestPoolBasisPct ?? null;
  if (harvestPool != null && harvestBasisPct != null) {
    // SHOULD-3: the harvest sizes from the pool LEFT
    // after this year's typed sale — the pool less the
    // sale's proceeds, less the basis the sale retired —
    // never from the starting pool, which would harvest
    // gains the sale already realized. The basis percent
    // is floored at 0 only, never capped at 100: the walk
    // carries an underwater pool's basis as a ratio above
    // 100, and capping it would understate the retired
    // basis on a partial sale from such a pool.
    const pool = Math.max(0, harvestPool);
    const basisPct = Math.max(0, harvestBasisPct);
    const basisDollars = (basisPct / 100) * pool;
    const saleProceeds = Math.max(0, inp.stockSold);
    const saleBasis = Math.max(0, inp.stockBasis);
    const poolLeft = Math.max(0, pool - saleProceeds);
    const basisLeft = Math.max(0, basisDollars - saleBasis);
    const availableGain = Math.max(0, poolLeft - basisLeft);
    if (availableGain > 0) {
      const settled = priceYear(base);
      const settledAt15 = settled.gainsAt15;
      const settledAt20 = settled.gainsAt20;
      const harvestFits = (h: number): boolean => {
        const f = gainsFieldsFor(stockGain + h);
        const p = priceYear({
          ...base,
          ltcg: f.ltcg,
          capitalLossAllowance: f.capitalLossAllowance,
          ...(f.waGainsBase != null ? { waGainsBase: f.waGainsBase } : {}),
        });
        return (
          p.gainsAt15 <= settledAt15 + 0.005 &&
          p.gainsAt20 <= settledAt20 + 0.005
        );
      };
      if (harvestFits(0)) {
        let lo = 0;
        let hi = Math.floor(availableGain * 100);
        while (lo < hi) {
          const mid = Math.floor((lo + hi + 1) / 2);
          if (harvestFits(mid / 100)) {
            lo = mid;
          } else {
            hi = mid - 1;
          }
        }
        if (lo > 0) {
          harvestedGain = lo / 100;
          const fH = gainsFieldsFor(stockGain + harvestedGain);
          ltcgNet = fH.ltcg;
          capitalLossAllowance = fH.capitalLossAllowance;
          waGainsBase = fH.waGainsBase;
          base.ltcg = fH.ltcg;
          base.capitalLossAllowance = fH.capitalLossAllowance;
          if (fH.waGainsBase != null) {
            base.waGainsBase = fH.waGainsBase;
          } else {
            delete base.waGainsBase;
          }
        }
      }
    }
  }
  const ltcgPriced = r2(Math.max(0, ltcgNet) + qualifiedDividends);
  const capitalLoss = Math.max(0, -ltcgNet);
  // The total preferential income priced (the possibly
  // netted capital result + the clamped qualified
  // dividends) — the gains flags' stack figure and phrase,
  // as before.
  const prefTyped = r2(ltcgNet + qualifiedDividends);

  const priced = priceYear(base);
  // The no-CONVERSION price: the conversion dial is zeroed
  // while the spending draw still rides the extraPreTaxDraw
  // dial (M-2 split) — so the conversion's own cost below is
  // the tax the conversion alone adds on top of the same year
  // with the same draw still taken. With no draw entered this
  // is exactly the pre-split $0-conversion price.
  const pricedZero = priceYear({ ...base, conversion: 0 });

  // Loss-ledger year-end reconciliation (build v111):
  // the carry-out is fixed ONCE, against the priced year's
  // final taxable income before the allowance — the plan
  // march's ledFinal pattern — so only the part of the
  // claimed allowance that actually offset taxable income
  // is consumed from the carryforward. All four figures
  // stay $0 when the ledger never ran — no carry-in entered
  // AND the year's own result not a loss (R1: a year whose
  // own result IS a loss reconciles its newly realized
  // carry-out here even with no carry-in entered; the trial
  // pricing's unbounded-utilization result above is never
  // surfaced as a carry-out either way).
  let lossCarryOutSt = 0;
  let lossCarryOutLt = 0;
  let lossCarryOutStWa = 0;
  let lossCarryOutLtWa = 0;
  if (lossLedgerOn) {
    const ledFinal = applyLossLedger(
      { st: carryInSt, lt: carryInLt },
      // The year's own total gains INCLUDING any harvested
      // gain — the plan march's year-end pattern (its T4
      // ledger outcome runs on draws' gains + injected gain
      // + harvested gain), so the carry-out reconciles
      // against the same total the trial pricings netted.
      stockGain + harvestedGain,
      fs,
      priced.taxableIncomeBeforeLossAllowance,
      { st: carryInStWa, lt: carryInLtWa },
    );
    lossCarryOutSt = ledFinal.carryOut.st;
    lossCarryOutLt = ledFinal.carryOut.lt;
    lossCarryOutStWa = ledFinal.waCarryOut.st;
    lossCarryOutLtWa = ledFinal.waCarryOut.lt;
  }

  // Bracket landing: with the conversion stacked last, its last
  // dollar lands in the top bracket layer the year's ordinary
  // taxable income reaches — provided the conversion actually
  // added taxable ordinary income over the $0-conversion price.
  let landingBracketPct: number | null = null;
  let landingBracketTop: number | null = null;
  let landingRoomLeft: number | null = null;
  let landingExactlyFilled = false;
  const topLayer = priced.bracketLayers[priced.bracketLayers.length - 1] ?? null;
  if (
    inp.conversion > 0 &&
    topLayer != null &&
    priced.ordinaryTaxableIncome > pricedZero.ordinaryTaxableIncome + 0.005
  ) {
    landingBracketPct = topLayer.ratePct;
    landingBracketTop = topLayer.to;
    if (topLayer.to != null) {
      const room = topLayer.to - priced.ordinaryTaxableIncome;
      landingRoomLeft = r2(Math.max(0, room));
      landingExactlyFilled = Math.abs(room) < 0.01;
    }
  }

  // ACA — priced whenever at least one person is not on
  // Medicare. The cliff position needs only the household size;
  // the credit additionally needs the benchmark premium.
  const notMedicareCount =
    (inp.onMedicarePrimary ? 0 : 1) +
    (joint && !inp.onMedicareSpouse ? 1 : 0);
  const acaApplies = notMedicareCount > 0;
  // The coverage year the ACA block prices off. Normally the
  // year's own (acaCreditFor then applies the statutory
  // lookback to the prior year's guidelines). Under the
  // projection's "newest" convention, a coverage year of
  // (newest guideline year + 1) makes acaCreditFor's lookback
  // land exactly on the newest guideline row — the plan
  // convention. That relabel governs ONLY the guideline row
  // (and with it the cliff): the applicable-percentage table
  // keys on the REAL coverage year, passed to acaCreditFor
  // as tableYear (build v95, F1) — the convention doc
  // above states the rule, and the relabel must never move
  // the table. A relabelled 2026 therefore prices on the
  // 2026 table, a real 2027 on the 2027 table (projected
  // mode, the engine-audit round-2 fix), later years on
  // the 2026 table, and pre-2026 years keep the real
  // coverage year: the enhanced-credit schedule has no
  // cliff to re-price.
  const newestGuidelineYear = Math.max(
    ...Object.keys(FPL_GUIDELINES).map(Number),
  );
  const acaCoverageYear =
    inp.acaConvention === "newest" && inp.taxYear >= 2026
      ? Math.max(inp.taxYear, newestGuidelineYear + 1)
      : inp.taxYear;
  const acaProjected = inp.acaConvention === "newest";
  let aca: PlaygroundYearResult["aca"] = {
    applies: acaApplies,
    everyoneOnMedicare: notMedicareCount === 0,
    householdSize: inp.acaHouseholdSize,
    fpl: null,
    cliff: null,
    pctFpl: null,
    overCliff: false,
    positionDollars: null,
    credit: null,
    applicablePct: null,
    below100Fpl: false,
    eligibilityNote: null,
  };
  // The §36B household MAGI: the year's own ACA MAGI plus
  // any filing dependent's MAGI (dependentMagiForAca). The
  // dependent amount touches ONLY this figure and the ACA
  // step that reads it — AGI, MAGI (IRMAA), and every tax
  // figure keep the priced values untouched.
  const acaHouseholdMagi = r2(priced.acaMagi + dependentMagiForAca);
  if (acaApplies && inp.acaHouseholdSize != null) {
    const res = acaCreditFor({
      magi: acaHouseholdMagi,
      householdSize: inp.acaHouseholdSize,
      coverageYear: acaCoverageYear,
      // F1: the table keys on the real coverage year, never
      // on the relabelled year that fetches the guideline row.
      tableYear: inp.taxYear,
      benchmarkAnnual: inp.acaBenchmarkAnnual ?? 0,
      projected: acaProjected,
    });
    aca = {
      ...aca,
      fpl: res.fpl,
      cliff: res.cliff,
      pctFpl: res.pctFpl,
      overCliff: res.overCliff,
      positionDollars: r2(res.cliff - acaHouseholdMagi),
      credit: inp.acaBenchmarkAnnual != null ? res.credit : null,
      applicablePct: inp.acaBenchmarkAnnual != null ? res.applicablePct : null,
      below100Fpl: res.below100Fpl,
      eligibilityNote: res.eligibilityNote,
    };
  }

  // IRMAA — the tier this year's MAGI sets, charged per
  // person on Medicare in premiumYear (taxYear + 2), under
  // the PREMIUM year's law row — the plan engine's rule,
  // mirrored exactly (build v97, engine-calendar F3+F4).
  // Participants count by AGE in the premium year: the
  // primary from 65, the spouse from 65 too — the plan's
  // spouse threshold is her ACA end age, which defaults to
  // 65, and the single-year pricer carries no end-age input
  // to thread a different boundary, so the default governs
  // both persons here. The current-year onMedicare flags
  // do NOT gate this block: they still drive only the ACA
  // block above (current-year marketplace coverage), and a
  // person who turns 65 in the premium year counts here
  // even while the flag for the priced year is off. Tier
  // thresholds AND surcharge rates both read the premium
  // law row (lawForYear's own carry-forward for a premium
  // year past the table — no new table). The 2-year MAGI
  // lookback is preserved: the MAGI graded is this priced
  // year's own (premiumYear − 2), exactly as the plan
  // grades a lookback year's MAGI under the premium row.
  // The source-year law row (`law`, above) keeps pricing
  // the tax year itself and is untouched here, as is
  // priceYear's own irmaaTier, which classifies the priced
  // year under its own row and plays no part in this block.
  const premiumYear = inp.taxYear + 2;
  const premiumLaw = lawForYear(premiumYear);
  const personsOnMedicare =
    (inp.agePrimary + 2 >= 65 ? 1 : 0) +
    (joint && ageSpouse != null && ageSpouse + 2 >= 65 ? 1 : 0);
  const tier = irmaaTierFor(priced.magi, fs, premiumLaw, premiumYear, inflationPct);
  const annualPerPerson = irmaaAnnualPerPerson(tier, premiumLaw);
  const nextTierRaw = irmaaTierUpTo(tier, fs, premiumLaw, premiumYear, inflationPct);
  const irmaa: PlaygroundYearResult["irmaa"] = {
    applies: personsOnMedicare > 0,
    personsOnMedicare,
    tier,
    premiumYear,
    monthlyPerPerson: r2(annualPerPerson / 12),
    annualPerPerson,
    annualHousehold: r2(annualPerPerson * personsOnMedicare),
    nextTierLine: Number.isFinite(nextTierRaw) ? nextTierRaw : null,
    roomToNextTier: Number.isFinite(nextTierRaw)
      ? r2(Math.max(0, nextTierRaw - priced.magi))
      : null,
  };

  // Gains-deciding comparison: the same year priced a second
  // time through the shared engine with the gains stack zeroed
  // (ltcg 0 — the sale gain and the qualified dividends both
  // removed, and with them the capital-loss allowance a net
  // loss priced — there is no loss without the gains stack;
  // every other input identical, including the RMD and
  // the conversion). Flags derive ONLY from comparing the two
  // engine pricings.
  const pricedWithoutGains = priceYear({
    ...base,
    ltcg: 0,
    qualifiedDividends: 0,
    capitalLossAllowance: 0,
  });
  const hasGainsTyped = stockGain !== 0 || qualifiedDividends !== 0;
  const withoutAcaHouseholdMagi = r2(
    pricedWithoutGains.acaMagi + dependentMagiForAca,
  );
  let withoutAcaOverCliff = false;
  let withoutAcaPosition: number | null = null;
  let withoutAcaCredit: number | null = null;
  if (acaApplies && inp.acaHouseholdSize != null) {
    const resW = acaCreditFor({
      magi: withoutAcaHouseholdMagi,
      householdSize: inp.acaHouseholdSize,
      coverageYear: acaCoverageYear,
      // F1: same split as the main ACA call above — the
      // table keys on the real coverage year.
      tableYear: inp.taxYear,
      benchmarkAnnual: inp.acaBenchmarkAnnual ?? 0,
      projected: acaProjected,
    });
    withoutAcaOverCliff = resW.overCliff;
    withoutAcaPosition = r2(resW.cliff - withoutAcaHouseholdMagi);
    withoutAcaCredit =
      inp.acaBenchmarkAnnual != null ? resW.credit : null;
  }
  const gainsPhrase =
    prefTyped < 0
      ? `the ${fmtDollars(-prefTyped)} loss`
      : `the ${fmtDollars(prefTyped)} gain`;
  let acaFlag: PlaygroundAcaGainsFlag | null = null;
  if (
    hasGainsTyped &&
    acaApplies &&
    aca.cliff != null &&
    aca.positionDollars != null &&
    withoutAcaPosition != null
  ) {
    const flipped = aca.overCliff !== withoutAcaOverCliff;
    const creditChanged =
      inp.acaBenchmarkAnnual != null &&
      (aca.credit != null || withoutAcaCredit != null) &&
      aca.credit !== withoutAcaCredit;
    if (flipped && aca.overCliff) {
      const creditClause =
        inp.acaBenchmarkAnnual != null && withoutAcaCredit != null
          ? ` and the credit would be ${fmtDollars(withoutAcaCredit)}`
          : "";
      acaFlag = {
        kind: "flipped-over",
        gainsStack: prefTyped,
        typedOverCliff: aca.overCliff,
        withoutOverCliff: withoutAcaOverCliff,
        typedPositionDollars: aca.positionDollars,
        withoutPositionDollars: withoutAcaPosition,
        typedCredit: aca.credit,
        withoutCredit: withoutAcaCredit,
        withoutAcaMagi: withoutAcaHouseholdMagi,
        text: `Over the cliff by ${fmtDollars(-aca.positionDollars)} — ${gainsPhrase} is what put you over; without it you'd be under by ${fmtDollars(withoutAcaPosition)}${creditClause}.`,
      };
    } else if (flipped && !aca.overCliff) {
      const creditClause =
        inp.acaBenchmarkAnnual != null && withoutAcaCredit != null
          ? ` and the credit would be ${fmtDollars(withoutAcaCredit)}`
          : "";
      acaFlag = {
        kind: "flipped-under",
        gainsStack: prefTyped,
        typedOverCliff: aca.overCliff,
        withoutOverCliff: withoutAcaOverCliff,
        typedPositionDollars: aca.positionDollars,
        withoutPositionDollars: withoutAcaPosition,
        typedCredit: aca.credit,
        withoutCredit: withoutAcaCredit,
        withoutAcaMagi: withoutAcaHouseholdMagi,
        text: `Under the cliff by ${fmtDollars(aca.positionDollars)} — ${gainsPhrase} is what kept you under; without it you'd be over by ${fmtDollars(-withoutAcaPosition)}${creditClause}.`,
      };
    } else if (creditChanged) {
      const verb =
        (aca.credit ?? 0) < (withoutAcaCredit ?? 0)
          ? "shrank"
          : "increased";
      acaFlag = {
        kind: "credit-changed",
        gainsStack: prefTyped,
        typedOverCliff: aca.overCliff,
        withoutOverCliff: withoutAcaOverCliff,
        typedPositionDollars: aca.positionDollars,
        withoutPositionDollars: withoutAcaPosition,
        typedCredit: aca.credit,
        withoutCredit: withoutAcaCredit,
        withoutAcaMagi: withoutAcaHouseholdMagi,
        text: `${gainsPhrase.charAt(0).toUpperCase()}${gainsPhrase.slice(1)} ${verb} the credit — ${fmtDollars(aca.credit ?? 0)} with it, ${fmtDollars(withoutAcaCredit ?? 0)} without it.`,
      };
    }
  }
  let irmaaFlag: PlaygroundIrmaaGainsFlag | null = null;
  // The without-gains tier on the SAME premium-year basis:
  // the without-gains MAGI graded under the premium law row,
  // so the flag compares two premium-year tiers, never a
  // premium tier against a source-year one.
  const withoutTier = irmaaTierFor(
    pricedWithoutGains.magi,
    fs,
    premiumLaw,
    premiumYear,
    inflationPct,
  );
  if (hasGainsTyped && personsOnMedicare > 0 && tier !== withoutTier) {
    const lowerTier = Math.min(tier, withoutTier);
    const lineRaw = irmaaTierUpTo(lowerTier, fs, premiumLaw, premiumYear, inflationPct);
    const line = Number.isFinite(lineRaw) ? lineRaw : null;
    if (tier > withoutTier) {
      irmaaFlag = {
        kind: "tier-up",
        gainsStack: prefTyped,
        typedTier: tier,
        withoutTier,
        premiumYear: inp.taxYear + 2,
        line,
        text:
          line != null
            ? `Tier ${tier} for ${inp.taxYear + 2} — ${gainsPhrase} pushed you past the ${fmtDollars(line)} line; without it, ${withoutTier === 0 ? "no surcharge (Tier 0)" : `Tier ${withoutTier}`}.`
            : `Tier ${tier} for ${inp.taxYear + 2} — ${gainsPhrase} pushed you up from Tier ${withoutTier}; without it, ${withoutTier === 0 ? "no surcharge (Tier 0)" : `Tier ${withoutTier}`}.`,
      };
    } else {
      irmaaFlag = {
        kind: "tier-down",
        gainsStack: prefTyped,
        typedTier: tier,
        withoutTier,
        premiumYear: inp.taxYear + 2,
        line,
        text:
          line != null
            ? `Tier ${tier} for ${inp.taxYear + 2} — ${gainsPhrase} is what kept you under the ${fmtDollars(line)} line; without it, Tier ${withoutTier}.`
            : `Tier ${tier} for ${inp.taxYear + 2} — ${gainsPhrase} is what kept you at Tier ${tier}; without it, Tier ${withoutTier}.`,
      };
    }
  }
  const gainsFlags: PlaygroundGainsFlags = {
    gainsStack: prefTyped,
    hasGainsTyped,
    withoutMagi: pricedWithoutGains.magi,
    withoutAcaMagi: withoutAcaHouseholdMagi,
    withoutTier,
    acaFlag,
    irmaaFlag,
  };

  // Sale-after-tax line: only a typed stock sale triggers it
  // (proceeds are the sale's cash, whatever the gain or loss —
  // a loss sale still brought its proceeds in). The tax netted
  // against it is the year's total tax as priced: federal
  // (ordinary + gains, NIIT included) plus state when priced,
  // PLUS the §72(t) early-withdrawal penalty on the pre-tax
  // spending draw (C9 fix 2) — and NOTHING ELSE. It does NOT
  // net the refundable education credit or the APTC settlement
  // adjustments (credit still due / excess repayment) that the
  // result's netTaxBill carries, so the leftover agrees with
  // cashLeftAfterTax on the sale's share of the year's cash
  // ONLY in the no-credit / no-settlement case; in a credit or
  // settlement shape the leftover differs from proceeds −
  // netTaxBill by exactly −educationRefundable − creditStillDue
  // + excessAptcRepayment (C9 fix 3, Pass 1c SHOULD). The
  // sentence therefore names the three items it nets instead of
  // calling the figure "this year's total tax", so it never
  // reads as the year's net filing outcome. Before fix 2 the
  // line netted federal+state only and overstated the
  // penalty-inclusive cash by exactly the penalty. Figures are
  // rounded to the whole dollars the readout prints, and the
  // leftover is computed from those rounded figures so the three
  // printed numbers foot exactly. The total tax is the SUM OF
  // THE DISPLAYED COMPONENTS — Math.round(federal) +
  // Math.round(state) + Math.round(penalty), exactly as the Tax
  // block's own rows print them — not the rounding of the raw
  // sum, which can differ by $1 when both carry cents. The
  // penalty term is BOTH early-withdrawal penalties (Engine
  // Review C9, Build 2 — W3): the pre-tax draw's and the Roth
  // draw's — the Roth penalty is an additional tax liability
  // of the year too, so the sale's leftover nets it exactly
  // like the pre-tax penalty.
  let saleAfterTax: PlaygroundSaleAfterTax | null = null;
  if (inp.stockSold > 0) {
    const proceeds = Math.round(inp.stockSold);
    const totalTax =
      Math.round(priced.federalTax) +
      Math.round(priced.stateTax) +
      Math.round(priced.earlyWithdrawalPenalty) +
      Math.round(rothPenalty);
    const leftover = proceeds - totalTax;
    // The sentence names exactly what the line nets — federal +
    // state tax, plus the early-withdrawal penalty when one is
    // priced (a $0 penalty is not named) — so it never reads as
    // the year's net filing outcome: the refundable education
    // credit and the APTC settlement adjustments are NOT in this
    // figure (C9 fix 3).
    const penaltyPriced =
      Math.round(priced.earlyWithdrawalPenalty) > 0 ||
      Math.round(rothPenalty) > 0;
    const taxNoun = penaltyPriced
      ? "federal + state tax and the early-withdrawal penalty"
      : "federal + state tax";
    const taxNounCap = penaltyPriced
      ? "Federal + state tax and the early-withdrawal penalty"
      : "Federal + state tax";
    const taxVerb = penaltyPriced ? "come" : "comes";
    saleAfterTax = {
      proceeds,
      totalTax,
      leftover,
      text:
        leftover >= 0
          ? `Sale brought in ${fmtDollars(proceeds)}. After ${taxNoun} of ${fmtDollars(totalTax)}, ${fmtDollars(leftover)} of it is left.`
          : `Sale brought in ${fmtDollars(proceeds)}. ${taxNounCap} ${taxVerb} to ${fmtDollars(totalTax)} — ${fmtDollars(-leftover)} more than the sale brought in.`,
    };
  }

  // Cash left after tax (build v114, net bill exposed
  // build v116): the year's cash in (see the field's
  // note on PlaygroundYearResult) less its net tax bill.
  // The bill has two forms (build v193, re-audit round 3
  // SHOULD-4). UN-RECONCILED (no reconciliation facts
  // supplied — the plan model's form, and the form every
  // Playground year priced before S-1): the total tax,
  // less the refundable education credit. The ACA premium
  // credit is NOT subtracted here: it is treated as fully
  // advanced against the year's premiums, and it enters
  // only the health premium readout below, which nets it
  // off the separately priced premium. The annual spending
  // the cash left is compared against does NOT hold the
  // premium (build v208 prices the premium separately), so
  // an un-reconciled cash left is the year's cash before
  // its filing settlement — it understates the settlement
  // figure by the credit still due (or overstates it by
  // any excess advance), which is exactly the gap S-1
  // closed by having the Playground supply the facts.
  // SETTLEMENT (the caller supplied the year's
  // reconciliation facts — aptcTaken present, as the
  // December console's assembly always supplies and the
  // Playground's dial construction supplies since S-1): the
  // bill is the year's filing settlement, derived from
  // this same pricing exactly as the December layer
  // derives it — the final allowable credit (the priced
  // credit capped at the enrollment premium when one was
  // supplied, less the coverage reduction, $0 over the
  // cliff), the reconciliation on the EFFECTIVE final
  // credit (the priced credit; $0 when nobody can be on
  // the marketplace — a known-zero credit; unpriced only
  // when someone is marketplace-eligible but no benchmark
  // was entered), the credit still due and the excess
  // advance credit to repay (repaid in full for 2026 and
  // later — P.L. 119-21 §71305; before 2026 the capped
  // repayment is not modeled, so the settlement does not
  // price when APTC taken exceeds the effective final
  // credit) — total tax − credit still due + excess
  // repayment − the refundable education credit. In that
  // form this cash left IS the December console's cash
  // left for the same year (the console adds only its
  // taxable cash, at its assembly), so the two surfaces
  // cannot price the same year to two different figures.
  // When the facts are supplied but the settlement
  // cannot price, the bill falls back to the un-reconciled
  // form; the December layer shows no cash left then.
  // The money-out term is the SPENDING DRAW only (M-2,
  // engines review round 2): before the split, cashIn
  // counted inp.conversion, so a conversion — money moved
  // from pre-tax to Roth, never cash in hand — inflated the
  // cash left by its full amount and the "enough for the
  // year" verdict flipped on conversion size alone (a
  // $200,000 conversion read $11,480 to the good against
  // $180,000 of spending on a year whose true cash left was
  // −$8,520). A draw taken for spending IS cash in hand, so
  // the December console's draw rides the spendingDraw dial
  // and counts here exactly as it did when it rode the
  // conversion dial — December's cash left is unchanged.
  // The reinvested-yield exclusion (S-3, engines review
  // round 2): when the caller supplies yieldReinvested (the
  // saved-plan-year loader), the year's interest + total
  // ordinary dividends are the plan march's yield — the
  // march reinvested that yield (it stays in the balance
  // and counts $0 of funding), and the loader's sales and
  // draws are already march-sized, so counting the yield
  // as cash here spent it a second time and a loaded year
  // repriced with more cash left than the march funded.
  // The yield still prices as income in full above (AGI,
  // MAGI, tax, credit untouched); only this readout keeps
  // it out. Absent / false, the term is $0 and the readout
  // is bit-identical to before.
  // The cash and Roth funding draws (S-6, engines review
  // round 2) are the mirror image: cash the year DID have
  // that no term above counted. A draw from the cash
  // sleeve or from Roth funded the year's spending exactly
  // as a taxable sale or a pre-tax draw does, but it is
  // neither — no gain rides it and no income stack takes
  // it — so before S-6 a year funded that way read its
  // verdict short by the whole draw. The two draws count
  // here, dollar for dollar, and in no priced figure.
  const yieldReinvested = inp.yieldReinvested === true;
  const reinvestedYield = yieldReinvested
    ? r2(inp.interest + inp.ordinaryDividends)
    : 0;
  const cashIn = r2(
    inp.interest +
      inp.ordinaryDividends -
      reinvestedYield +
      inp.otherOrdinary +
      inp.taxExemptInterest +
      ssBenefits +
      // Build v127 (round-19 finding 2): NO
      // rmdAlreadyReceived term here — the received part is
      // already inside otherOrdinary (the input contract),
      // and rmd above is the net part still to come, so the
      // two together count the gross RMD exactly once. An
      // extra term overstated cash-in by the received
      // amount.
      rmd +
      spendingDraw +
      // Cash and Roth funding draws (S-6): the year's
      // spendable funding from the cash sleeve and the
      // Roth accounts — cash in hand, priced as their own
      // source (never income, never a taxable sale), so
      // they count here and nowhere else in the pricing.
      cashDraw +
      rothDraw +
      inp.stockSold,
  );
  // The year's total tax bill, INCLUDING the §72(t) penalties
  // — the pre-tax spending draw's (C9 fix 1 — SHOULD 2) AND
  // the Roth draw's (Engine Review C9, Build 2 — W3): both
  // are additional tax liabilities the year must fund,
  // exactly as the march's funding row carries federal +
  // penalty — so they enter the net bill (and the cash left)
  // here. totalTax on the result below stays federal + state
  // (the Tax block's display invariant); each penalty is named
  // on its own result field beside it.
  const earlyWithdrawalPenalty = priced.earlyWithdrawalPenalty;
  const totalTaxBill = r2(
    priced.federalTax + priced.stateTax + earlyWithdrawalPenalty + rothPenalty,
  );
  let netTaxBill = r2(totalTaxBill - priced.educationRefundable);
  // Whether the settlement below actually priced — the
  // health premium pairing further down keys on it (S-1).
  let settlementPriced = false;
  if (inp.aptcTaken != null) {
    // The filing settlement, on this pricing's own
    // figures — the same derivation the December layer
    // runs on the same readouts (build v193): whenever
    // it prices, it replaces the un-reconciled bill.
    const settlementCliff =
      inp.taxYear >= 2026 ? aca.cliff : null;
    const settlementOverCliff =
      settlementCliff != null && aca.overCliff;
    const cappedCredit =
      aca.credit == null
        ? null
        : inp.acaEnrollmentPremiumAnnual == null
          ? aca.credit
          : Math.min(aca.credit, inp.acaEnrollmentPremiumAnnual);
    const finalCredit = settlementOverCliff
      ? 0
      : cappedCredit == null
        ? null
        : r2(
            Math.max(
              0,
              cappedCredit - (inp.acaCoverageReduction ?? 0),
            ),
          );
    const acaInPlay =
      !inp.onMedicarePrimary ||
      (inp.filingStatus === "mfj" && !inp.onMedicareSpouse);
    const effectiveFinalCredit: number | null =
      finalCredit != null ? finalCredit : acaInPlay ? null : 0;
    const creditStillDue: number | null =
      effectiveFinalCredit != null
        ? r2(Math.max(0, effectiveFinalCredit - inp.aptcTaken))
        : null;
    const excessAptcRepayment: number | null =
      effectiveFinalCredit == null
        ? null
        : inp.taxYear >= 2026
          ? r2(Math.max(0, inp.aptcTaken - effectiveFinalCredit))
          : inp.aptcTaken <= effectiveFinalCredit
            ? 0
            : null;
    if (excessAptcRepayment != null) {
      netTaxBill = r2(
        totalTaxBill -
          (creditStillDue ?? 0) +
          excessAptcRepayment -
          priced.educationRefundable,
      );
      settlementPriced = true;
    }
  }
  const cashLeftAfterTax = r2(cashIn - netTaxBill);
  // HEALTH PREMIUM TERM (build v208): the year's health
  // premium from the entered amounts — the marketplace
  // gross counts only when someone is not on Medicare
  // (aca.applies), the Medicare base counts per person on
  // Medicare THIS year (the onMedicare flags, not the
  // IRMAA premium-year count). The net marketplace part is
  // the gross less the credit cash received toward the
  // premium (see healthCreditTowardPremium below): the
  // advance credit taken when the filing settlement priced
  // (S-1), otherwise the priced credit capped at the
  // gross; an unpriced credit (null — no benchmark) leaves
  // the gross whole. Readouts only: no priced figure moves.
  const healthGrossAcaPg =
    inp.healthPremiumAcaAnnual != null && aca.applies
      ? Math.max(0, inp.healthPremiumAcaAnnual)
      : 0;
  const healthMedicarePersonsPg =
    (inp.onMedicarePrimary ? 1 : 0) +
    (joint && inp.onMedicareSpouse ? 1 : 0);
  const healthGrossMedicarePg =
    inp.healthPremiumMedicarePerPerson != null
      ? r2(Math.max(0, inp.healthPremiumMedicarePerPerson) * healthMedicarePersonsPg)
      : 0;
  const healthPremiumGross = r2(healthGrossAcaPg + healthGrossMedicarePg);
  // The credit cash netted off the marketplace gross: the
  // advance credit actually taken when the settlement
  // above priced (S-1 — the remainder of the final credit
  // already settled inside netTaxBill, so netting the full
  // priced credit here as well would count it twice and
  // the after-health readout would fall by the credit
  // still due); otherwise the priced credit capped at the
  // gross (the fully-advanced treatment), exactly as before.
  const healthCreditTowardPremium = settlementPriced
    ? Math.max(0, inp.aptcTaken ?? 0)
    : Math.min(aca.credit ?? 0, healthGrossAcaPg);
  const healthPremiumNet = r2(
    healthGrossMedicarePg +
      (healthGrossAcaPg > 0
        ? Math.max(0, healthGrossAcaPg - healthCreditTowardPremium)
        : 0),
  );
  // IRMAA surcharge payable THIS year (internal review round 3
  // SHOULD-2): the entered irmaaPayableAnnual, floored at $0 —
  // $0 when none was entered, so a year priced without it is
  // bit-identical. Charged beside the base premium in the cash
  // left after health premiums — never in netTaxBill, so the
  // December console's cash left (which derives from
  // cashLeftAfterTax) is untouched. This is NOT the forward
  // irmaa block's figure: that block prices the surcharge this
  // year's MAGI will cause in premiumYear (taxYear + 2), and
  // its annualHousehold can coincide with this amount without
  // being the same surcharge.
  const irmaaPayableAnnual = r2(Math.max(0, inp.irmaaPayableAnnual ?? 0));
  const cashLeftAfterHealthPremium = r2(
    cashLeftAfterTax - healthPremiumNet - irmaaPayableAnnual,
  );
  // "Enough for the year" (build v126; R3-M3): cash left
  // after HEALTH PREMIUMS minus the annual spending — a
  // pure readout, the spending never entering the tax
  // above. The spending excludes health premiums (build
  // v208), so it is compared against the cash left after
  // the net premium: comparing it against cashLeftAfterTax
  // alone (the pre-R3-M3 form) left the premium uncharged
  // in the verdict and overstated it by healthPremiumNet
  // whenever a premium priced. Null when no spending was
  // given.
  const annualSpending = inp.annualSpending ?? null;
  const cashLeftVsSpending =
    annualSpending == null
      ? null
      : r2(cashLeftAfterHealthPremium - annualSpending);

  return {
    interest: inp.interest,
    ordinaryDividends: inp.ordinaryDividends,
    nonQualifiedDividends,
    otherOrdinary: inp.otherOrdinary,
    otherOrdinaryTotal,
    rmdPriced: totalPretaxBalance != null,
    rmd,
    rmdGross,
    rmdPrimary,
    rmdSpouse,
    rmdAlreadyReceived,
    rmdDeferredPrimary: settledP.deferredThisYear,
    rmdDeferredSpouse: settledS.deferredThisYear,
    rmdDeferredPaidPrimary: settledP.deferredPaid,
    rmdDeferredPaidSpouse: settledS.deferredPaid,
    dependentMagiForAca,
    rmdDivisor,
    rmdTable,
    ssBenefits,
    ssTaxable: priced.ssTaxable,
    ssPctTaxed: ssBenefits > 0 ? r2((priced.ssTaxable / ssBenefits) * 100) : 0,
    taxExemptInterest: inp.taxExemptInterest,
    conversion: inp.conversion,
    stockGain,
    qualifiedDividends,
    ordinaryDividendsEntered: inp.ordinaryDividends,
    qualifiedDividendsEntered: inp.qualifiedDividends,
    qualifiedDividendsWasClamped:
      r2(Math.max(0, inp.qualifiedDividends)) > qualifiedDividends,
    qualifiedDividendsExcess: r2(
      Math.max(0, Math.max(0, inp.qualifiedDividends) - qualifiedDividends),
    ),
    ltcgNet,
    ltcgPriced,
    capitalLoss,
    capitalLossAllowance,
    lossCarryOutSt,
    lossCarryOutLt,
    lossCarryOutStWa,
    lossCarryOutLtWa,
    harvestedGain,
    agi: priced.agi,
    magi: priced.magi,
    acaMagi: acaHouseholdMagi,
    baseStandardDeduction: priced.baseStandardDeduction,
    age65AddonTotal: priced.age65AddonTotal,
    count65: priced.count65,
    standardDeduction: priced.standardDeduction,
    seniorDeduction: priced.seniorDeduction,
    itemizedDeduction: priced.itemizedDeduction,
    itemizedSaltAllowed: priced.itemizedSaltAllowed,
    deductionTaken: priced.deductionTaken,
    itemizedCharitableAllowed: priced.itemizedCharitableAllowed,
    section68Reduction: priced.section68Reduction,
    nonItemizerCharitableDeduction: priced.nonItemizerCharitableDeduction,
    educationAotc: priced.educationAotc,
    educationLlc: priced.educationLlc,
    educationChoice: priced.educationChoice,
    educationNonrefundable: priced.educationNonrefundable,
    educationRefundable: priced.educationRefundable,
    amti: priced.amti,
    amtExemption: priced.amtExemption,
    amtTentativeTax: priced.amtTentativeTax,
    amtOwed: priced.amtOwed,
    deductions: priced.deductions,
    taxableIncome: priced.taxableIncome,
    ordinaryTaxableIncome: priced.ordinaryTaxableIncome,
    gainsInTaxableIncome: priced.gainsInTaxableIncome,
    bracketLayers: priced.bracketLayers,
    gainsAt0: priced.gainsAt0,
    gainsAt15: priced.gainsAt15,
    gainsAt20: priced.gainsAt20,
    gainsZeroRoomLeft: r2(
      Math.max(0, law.ltcgZeroTop[fs] - priced.ordinaryTaxableIncome - priced.gainsAt0),
    ),
    ordinaryTax: priced.ordinaryTax,
    ltcgTax: priced.ltcgTax,
    niit: priced.niit,
    federalTax: priced.federalTax,
    stateTax: priced.stateTax,
    waGains: priced.waGains,
    waStandardDeduction: priced.waStandardDeduction,
    waTaxableGains: priced.waTaxableGains,
    totalTax: r2(priced.federalTax + priced.stateTax),
    earlyWithdrawalPenalty,
    earlyWithdrawalEligibilityUnknown:
      priced.earlyWithdrawalEligibilityUnknown || pgSplitShortUnknown,
    netTaxBill,
    cashIn,
    cashLeftAfterTax,
    yieldReinvested,
    reinvestedYield,
    cashDraw,
    rothDraw,
    rothEarningsIncome,
    rothPenalty,
    rothBasisUnknown,
    rothAssumedQualified,
    spendingDraw,
    inflationPct,
    healthPremiumGross,
    healthPremiumNet,
    irmaaPayableAnnual,
    cashLeftAfterHealthPremium,
    annualSpending,
    cashLeftVsSpending,
    landingBracketPct,
    landingBracketTop,
    landingRoomLeft,
    landingExactlyFilled,
    conversionFederalCost: r2(priced.federalTax - pricedZero.federalTax),
    conversionTotalCost: r2(
      priced.federalTax + priced.stateTax - (pricedZero.federalTax + pricedZero.stateTax),
    ),
    conversionExceedsBalance:
      totalPretaxBalance != null &&
      moneyOut > totalPretaxBalance - rmdGross + 0.005,
    aca,
    irmaa,
    gainsFlags,
    saleAfterTax,
  };
}

// Sibling helper for the gains-deciding comparison: the priced
// result already carries the comparison (pricePlaygroundYear
// prices the year twice through the shared engine), so this is
// a thin, fixture-testable accessor over that same comparison
// — never a second calculation.
export function playgroundGainsComparison(
  inp: PlaygroundYearInputs,
): PlaygroundGainsFlags {
  return pricePlaygroundYear(inp).gainsFlags;
}

// Sibling helper for the sale-after-tax line: the priced result
// already carries the line (pricePlaygroundYear computes it
// from the same engine pricing), so this is a thin,
// fixture-testable accessor over that same computation — never
// a second calculation.
export function playgroundSaleAfterTax(
  inp: PlaygroundYearInputs,
): PlaygroundSaleAfterTax | null {
  return pricePlaygroundYear(inp).saleAfterTax;
}

/* ---------------- Playground projection ----------------
   The Playground's projection mode: the current single-year
   dials become a TEMPLATE year, repeated from the primary's
   template age through an end age (95 by default), one year
   at a time. Every projected year is priced by
   pricePlaygroundYear itself — the same pricing path as the
   single-year view — with only the year's age-driven inputs
   changed:

   · ages advance one year per step (the calendar year with
     them); Medicare follows age — on at 65 for each person,
     whatever the template year's checkboxes said;
   · Social Security pays $0 before the person's claiming
     age and the entered yearly amount from that age on (a
     null claiming age keeps the template amount every year);
   · the RMD is priced by the pricer off the year's starting
     (prior Dec 31) pre-tax balances — EACH owner's balance
     on that owner's own clock when the template carries the
     split (R3-S2), exactly as the template year prices it;
   · the ACA household size steps down at the step-down year
     when one is set, and ACA ends on its own once everyone
     is on Medicare (the pricer's own applicability rule);
   · every projected year prices its ACA cliff on the PLAN
     convention — the newest poverty-guideline row, in
     today's dollars (acaConvention "newest" above) — and
     its applicable percentage on the projected-mode table
     for its coverage year (the 2027 table for a projected
     coverage year 2027, the 2026 table for projected years
     after 2027), while the single-year pricer prices a
     specific 2027 coverage year on the published 2027
     table. Those are the sanctioned
     differences from the single-year pricer, which applies
     the statutory lookback to its named year; with the
     template's own switches aligned, a projected year
     reproduces the single-year result on every figure
     except the ACA block.

   The template's pre-tax money out repeats each year,
   adjusted by two user controls:
   · draw mode "replace": Social Security and RMDs that
     arrive beyond what the template year itself carried
     shrink the amount dollar for dollar, floored at $0
     (mode "repeat" leaves it exactly as entered);
   · a stop rule: with "age", the amount runs through the
     stop age and is $0 after it; with "floor", the amount
     is capped so the pre-tax balance left after the year's
     RMD and the amount itself never goes below the floor
     (and is $0 once the balance is at the floor).
   Either way the amount never exceeds the pre-tax balance
   left after the year's RMD when a balance is in play.

   Balances evolve beside the pricing — presentation-grade
   bookkeeping, not a second tax model. Each year: each
   owner's pre-tax balance is drawn down by that owner's
   own RMD and that owner's share of the money out (the
   money out drains the primary's post-RMD balance first,
   the spouse's second — the plan march's allocation,
   R3-S2); the taxable balance by the year's stock sale
   (a sale larger than the balance sells what is there, its
   basis scaled by the same fraction, so the priced gain
   ratio is the template's); in "conversion" mode the money
   out lands in the Roth balance, in "draw" mode it leaves
   as spending. What remains of each balance then grows at
   the entered return for the year. Taxes are NOT debited
   from any balance — the priced drawdowns are exactly the
   draws, sales, RMDs, and conversions, as the balances
   chart's caption states. A balance the user never entered
   (a blank pre-tax dial, or no starting taxable entered)
   stays unentered: its years price exactly as the
   single-year view prices a blank balance (no RMD, no cap,
   sales unscaled) and the chart shows no balance for it.

   The projection's start age (opts.fromAge — the panel's
   "Projection from age" dial; null / absent = the template's
   own age, exactly the walk above):
   · EARLIER than the template age: the walk itself starts
     at the from-age. Calendar years and the spouse's age
     shift by the same difference, the template's income
     shape repeats from that age, and every age-keyed switch
     above follows each projected year's own ages — ACA
     while it applies on the plan convention, Medicare at 65
     for each person, Social Security from its claiming age,
     RMDs from the RMD age. The starting balances — the
     template's pre-tax balance and the entered starting
     taxable and Roth balances — are the balances AT that
     first projected year: the walk begins there, it does not
     walk forward to the template year first. The "replace"
     draw mode likewise measures arrivals beyond the FIRST
     projected year's own arrival, not the template year's.
   · LATER than the template age: the walk still computes
     from the template year (so balances walk), and only the
     years from the from-age on are returned — the first
     shown year's starting balances are the walked ones, not
     the entered starting balances. */

export type PlaygroundProjectionOptions = {
  // Last primary age projected (inclusive).
  toAge: number;
  // First primary age shown / walked from (see the header
  // comment): null (or absent) = the template's own age.
  fromAge?: number | null;
  // Claiming ages for the two benefits; null = the template
  // amount (if any) is in pay every year, as typed.
  ssPrimaryClaimAge: number | null;
  ssSpouseClaimAge: number | null;
  // Yearly benefit from the claiming age; null = the
  // template year's typed amount.
  ssPrimaryAnnual: number | null;
  ssSpouseAnnual: number | null;
  // ACA household schedule: the steps away from the template
  // year's household size, as (fromYear → householdSize)
  // entries. Null = no steps — the template size governs
  // every projected year.
  acaHouseholdSchedule: AcaHouseholdStep[] | null;
  // Starting balances: taxable is null when none was entered
  // (sales then repeat unscaled and no taxable balance is
  // tracked); Roth starts at the entered figure ($0 default).
  startTaxable: number | null;
  startRoth: number;
  // Yearly growth applied to each balance after the year's
  // drawdowns (and the conversion's landing in Roth).
  returnPct: number;
  drawMode: "repeat" | "replace";
  moneyOutKind: "conversion" | "draw";
  stopKind: "none" | "age" | "floor";
  stopAge: number | null;
  stopFloor: number | null;
};

export type PlaygroundProjectionBalances = {
  pretax: number | null;
  taxable: number | null;
  roth: number;
};

export type PlaygroundProjectionYear = {
  calendarYear: number;
  agePrimary: number;
  ageSpouse: number | null;
  // The exact inputs this year was priced with — clicking
  // the year in the chart loads these into the single-year
  // view's dials.
  inputs: PlaygroundYearInputs;
  result: PlaygroundYearResult;
  // The effective pre-tax money out priced (after the draw
  // mode, the stop rule, and the balance cap).
  moneyOut: number;
  stockSoldEffective: number;
  stockBasisEffective: number;
  startBalances: PlaygroundProjectionBalances;
  endBalances: PlaygroundProjectionBalances;
};

export type PlaygroundProjection = {
  years: PlaygroundProjectionYear[];
  // Balances after the final projected year (the last year's
  // endBalances; the starting balances when the range is
  // empty).
  endBalances: PlaygroundProjectionBalances;
};

export function projectPlaygroundYears(
  template: PlaygroundYearInputs,
  opts: PlaygroundProjectionOptions,
): PlaygroundProjection {
  const joint = template.filingStatus === "mfj";
  const birthYearPrimary = template.taxYear - template.agePrimary;
  const birthYearSpouse =
    joint && template.ageSpouse != null
      ? template.taxYear - template.ageSpouse
      : null;
  /* R3-S2 (engines review round 3, SHOULD — settled STAND):
     the walk tracks BOTH owners' pre-tax balances apart and
     prices each owner's RMD on that owner's OWN clock,
     exactly as pricePlaygroundYear prices a split year —
     the primary's RMD through rmdForYear on the primary's
     balance (Joint Life when the spouse is the primary's
     sole beneficiary and more than 10 years younger), the
     spouse's through rmdForYear with the roles swapped on
     the spouse's balance (Joint Life only when the primary
     is the SPOUSE's sole beneficiary —
     primarySoleBeneficiaryOfSpouse — and more than 10 years
     younger). Before R3-S2 the walk combined the balances,
     priced one RMD on the primary's clock, and nulled the
     spouse balance in the per-year inputs, so a spouse
     below RMD age (or on a different divisor) was charged
     the primary's RMD on money that owed none — the
     settlement's worked example invented a whole second
     RMD that way. The walk's money out still caps against
     the COMBINED post-RMD balance (the pricer's own cap is
     on the total) and the floor still guards the combined
     balance; the money out itself drains the PRIMARY's
     post-RMD balance first and the spouse's second — the
     plan march's own allocation (simulateRothPlan takes
     conversions and pre-tax draws primary-first) — and each
     owner's remainder then grows on its own, so the next
     year's two RMDs price off the two walked balances.
     startBalances / endBalances keep reporting the COMBINED
     pre-tax total (the chart's one pre-tax line); the split
     lives in the per-year inputs each year was priced with,
     which is what loading a projected year reads. */
  // S-12: the spouse's balance counts only on a joint
  // template (countedSpousePretax) — a stale spouse balance
  // on a single / head-of-household template is not the
  // filer's money and never enters the walk.
  const countedSpouse = countedSpousePretax(template);
  const primaryEntered = template.pretaxBalance != null;
  const spouseEntered = countedSpouse != null;
  const hasPretax = primaryEntered || spouseEntered;
  let pretaxPrimary: number | null = template.pretaxBalance ?? null;
  let pretaxSpouse: number | null = countedSpouse;
  let pretaxCombined: number | null = hasPretax
    ? r2((pretaxPrimary ?? 0) + (pretaxSpouse ?? 0))
    : null;
  // Both owners' gross RMDs on a pair of starting balances
  // at a pair of ages — the same two rmdForYear calls
  // pricePlaygroundYear makes on the same facts, so the
  // figure the draw mode and the caps use is the figure the
  // pricing produces. Gross: an amount already received is
  // part of the RMD that has left the accounts too (the
  // pricer's own balance-cap rule), so the walk's balance
  // math below reads these gross figures, never the priced
  // result's net-of-received RMD.
  const rmdsFor = (
    pBal: number | null,
    sBal: number | null,
    ageP: number,
    ageS: number | null,
  ): { primary: number; spouse: number; total: number } => {
    if (!hasPretax) return { primary: 0, spouse: 0, total: 0 };
    const rp = rmdForYear({
      priorDec31PreTax: pBal ?? 0,
      agePrimary: ageP,
      ageSpouse: ageS,
      birthYearPrimary,
      spouseSoleBeneficiary: template.spouseSoleBeneficiary,
    }).rmd;
    const rs =
      joint && ageS != null && birthYearSpouse != null
        ? rmdForYear({
            priorDec31PreTax: sBal ?? 0,
            agePrimary: ageS,
            ageSpouse: ageP,
            birthYearPrimary: birthYearSpouse,
            spouseSoleBeneficiary:
              template.primarySoleBeneficiaryOfSpouse === true,
          }).rmd
        : 0;
    return { primary: rp, spouse: rs, total: r2(rp + rs) };
  };
  // The projection's start age (see the header comment):
  // an earlier from-age moves the WALK's start (the entered
  // starting balances are that first year's balances); a
  // later from-age leaves the walk starting at the template
  // year and only slices the returned years.
  const requestedFromAge =
    opts.fromAge != null && Number.isFinite(opts.fromAge)
      ? Math.max(0, Math.round(opts.fromAge))
      : null;
  const walkStartAge =
    requestedFromAge != null
      ? Math.min(requestedFromAge, template.agePrimary)
      : template.agePrimary;
  const displayFromAge = requestedFromAge ?? template.agePrimary;
  const ssFor = (
    claimAge: number | null,
    annual: number | null,
    typed: number,
    personAge: number | null,
  ): number => {
    if (personAge == null) return 0;
    if (claimAge == null) return typed;
    return personAge >= claimAge ? (annual ?? typed) : 0;
  };
  const spouseAgeAt = (age: number): number | null =>
    joint && template.ageSpouse != null
      ? template.ageSpouse + (age - template.agePrimary)
      : null;
  // The baseline the "replace" draw mode measures arrivals
  // against: the FIRST walked year's own Social Security
  // total and RMD (its starting pre-tax balance is the
  // template's balance, at the walk's first year). With no
  // from-age — or a later one — the first walked year IS the
  // template year, so this is exactly the template baseline
  // the walk has always used; an earlier start re-anchors it
  // to the earlier first year, whose switches price by that
  // year's own ages.
  const walkStartSpouseAge = spouseAgeAt(walkStartAge);
  const baselineArrival =
    ssFor(
      opts.ssPrimaryClaimAge,
      opts.ssPrimaryAnnual,
      template.ssPrimary,
      walkStartAge,
    ) +
    (joint
      ? ssFor(
          opts.ssSpouseClaimAge,
          opts.ssSpouseAnnual,
          template.ssSpouse,
          walkStartSpouseAge,
        )
      : 0) +
    // The first walked year's RMD arrival is the SUM of the
    // two owners' own RMDs (R3-S2), not one RMD priced on
    // the combined balance at the primary's divisor.
    rmdsFor(pretaxPrimary, pretaxSpouse, walkStartAge, walkStartSpouseAge)
      .total;
  const growth = 1 + opts.returnPct / 100;
  let taxable: number | null = opts.startTaxable;
  let roth = opts.startRoth;
  /* P-S4 (parity audit, SHOULD — settled STAND in
     substance): four of the facts the per-year spread
     below repeats from the template are not levels the
     walk is defined to repeat — they are one-year or
     ledger facts, and repeating them made every
     projected year internally inconsistent:
     (b) the entering capital-loss carryforward is a
     LEDGER balance: each projected year now enters with
     the PRIOR year's reconciled carry-out (the result's
     lossCarryOut* — federal short / long and their
     Washington-attributable portions), exactly as the
     plan march chains its ledger year to year. Before,
     the walk re-fed the template's carry-in whole into
     every year, so a banked loss sheltered the same
     gains again and again and never ran down.
     (c) the cash / Roth funding draws are one-year
     funding facts: the template's cash draw prices in
     the walk's FIRST year exactly as the single-year
     pricer prices the template year (the walk tracks
     no cash balance that could fund a repeat, so from
     the second year on the cash draw is $0), and the
     Roth draw is capped at the tracked Roth balance
     in EVERY walked year, the first included — a
     first-year draw larger than the balance prices
     only up to the balance (ChatGPT SHOULD-5: before,
     the first year priced the whole draw as cash in
     hand against a balance that could not fund it,
     while later years already capped). Every year's
     draw — the first year's included — depletes the
     tracked balance in the endRoth math below.
     Before, both draws repeated whole forever:
     spendable funding no balance paid for.
     (d) the Medicare flags can carry a user OVERRIDE:
     the form's tri-state checkboxes resolve into the
     template's booleans, so a template flag that
     DISAGREES with the age rule at the template's own
     age is an explicit answer (on Medicare before 65,
     or not on Medicare at 65+) and is carried through
     the walk; a flag that AGREES with the rule is the
     follow-age default, and the walk keeps pricing
     each year by that year's own age, exactly as
     before. Before, the walk re-derived both flags
     from age every year, so an override never reached
     a projected year.
     Sub-case (a) of the same finding — rmdAlreadyReceived
     netting every year's RMD — needed no change here:
     its income half cancels against the repeated
     other-ordinary the received amount sits inside (the
     input contract: the received amount is already
     counted in the entered income), so a projected
     year's RMD income is its gross RMD, not the gross
     less the received amount a second time; and its
     balance half is already closed above — the walk's
     balance math reads the GROSS per-owner RMDs
     (rmdsFor), never the priced result's net-of-
     received RMD, so the pre-tax balance depletes by
     result.rmdGross. (At the audit's anchor the walk
     still subtracted the net result.rmd; the R3-S2
     per-owner rewrite is what closed it.) Pinned by
     the tax suite's
     tax-engines-playground-projection-one-year-facts-ps4
     fixture. */
  let carryInSt = Math.max(0, template.capitalLossCarryInSt ?? 0);
  let carryInLt = Math.max(0, template.capitalLossCarryInLt ?? 0);
  let carryInStWa = Math.max(0, template.capitalLossCarryInStWa ?? 0);
  let carryInLtWa = Math.max(0, template.capitalLossCarryInLtWa ?? 0);
  /* R2 (parity re-review, SHOULD — settled STAND): the
     gain-harvest pair is a ledger fact of the opposite
     kind. A harvest sells shares and immediately
     repurchases them, so the pool's BALANCE does not
     fall — the endTaxable math below is right to leave
     it alone — but the repurchased shares carry a basis
     stepped up by the gain the harvest realized, exactly
     as the plan march steps its own basis up after a
     harvest (stepUpTiers / taxableBasisDollars +=
     gainsHarvested in taxEngine.ts). Before R2 the walk
     re-spread the template's pool and basis percent into
     every year untouched, so each projected year
     re-sized its harvest from the ORIGINAL unrealized
     gain and harvested the same gain again and again.
     The walk now carries the pool's basis DOLLARS
     forward beside the balances: each year's harvest
     basis percent is re-derived from the carried basis
     (the template's own percent in the first walked
     year), and each year's priced harvestedGain steps
     the carried basis up for the next year. SHOULD-3
     carries the pool's BALANCE forward too — the
     template's pool amount in the first walked year,
     reduced by each year's sale and grown by the
     return, exactly like the tracked taxable balance —
     so each year's harvest sizes from the pool that
     remains, not the template's starting pool restated
     every year, and each year's repeated sale retires
     basis at the pool's own tracked ratio. The balance
     is separate from the tracked taxable balance
     because the pool need not equal the walk's starting
     taxable balance (or any taxable balance at all).
     With either harvest fact absent the state stays null
     and every year prices exactly as before. Pinned by
     the tax suite's
     tax-engines-playground-projection-harvest-step-up-r2
     fixture. */
  const harvestPoolAmount =
    template.harvestPoolAmount != null
      ? Math.max(0, template.harvestPoolAmount)
      : null;
  let harvestBasisDollars: number | null =
    harvestPoolAmount != null && template.harvestPoolBasisPct != null
      ? r2(
          (Math.min(100, Math.max(0, template.harvestPoolBasisPct)) / 100) *
            harvestPoolAmount,
        )
      : null;
  let harvestPoolBalance: number | null = harvestPoolAmount;
  const templateCashDraw = Math.max(0, template.cashDraw ?? 0);
  const templateRothDraw = Math.max(0, template.rothDraw ?? 0);
  // ChatGPT SHOULD-3 (see the per-year override below):
  // the received RMD the template carries — the part of
  // the template year's RMD already received, already
  // counted in the template's other ordinary income.
  const receivedRmd = Math.max(0, template.rmdAlreadyReceived ?? 0);
  // A template Medicare flag is an override exactly
  // when it disagrees with the age rule at the
  // template's own age; otherwise it is the follow-age
  // default and no override is carried (null).
  const medicareOverrideFor = (
    flag: boolean,
    ageAtTemplate: number | null,
  ): boolean | null =>
    ageAtTemplate != null && flag !== (ageAtTemplate >= 65) ? flag : null;
  const medicareOverridePrimary = medicareOverrideFor(
    template.onMedicarePrimary,
    template.agePrimary,
  );
  const medicareOverrideSpouse = joint
    ? medicareOverrideFor(template.onMedicareSpouse, template.ageSpouse)
    : null;
  let firstWalkYear = true;
  const years: PlaygroundProjectionYear[] = [];
  const toAge = Math.max(
    template.agePrimary,
    walkStartAge,
    displayFromAge,
    Math.round(opts.toAge),
  );
  for (let age = walkStartAge; age <= toAge; age++) {
    const step = age - template.agePrimary;
    const calendarYear = template.taxYear + step;
    const ageSpouse = spouseAgeAt(age);
    const ssPrimary = ssFor(
      opts.ssPrimaryClaimAge,
      opts.ssPrimaryAnnual,
      template.ssPrimary,
      age,
    );
    const ssSpouse = joint
      ? ssFor(
          opts.ssSpouseClaimAge,
          opts.ssSpouseAnnual,
          template.ssSpouse,
          ageSpouse,
        )
      : 0;
    // The year's RMDs on the starting balances — each
    // owner's own rmdForYear call, the same two calls
    // pricePlaygroundYear makes on these balances, so the
    // figure the draw mode and the caps use is the figure
    // the pricing produces (R3-S2: their SUM replaces the
    // one combined-balance RMD on the primary's clock).
    const rmds = rmdsFor(pretaxPrimary, pretaxSpouse, age, ageSpouse);
    const rmdThis = rmds.total;
    const afterRmdPrimary = Math.max(0, (pretaxPrimary ?? 0) - rmds.primary);
    const afterRmdSpouse = Math.max(0, (pretaxSpouse ?? 0) - rmds.spouse);
    const afterRmd = afterRmdPrimary + afterRmdSpouse;
    // The year's money out starts from the template's
    // TOTAL pre-tax money out — the conversion and the
    // spending draw together (P-M4, parity audit MUST):
    // since the M-2 split, the money out a year carries
    // is the two dials' sum (the pricer's own moneyOut,
    // and the form's "Pre-tax money out" figure), so a
    // template whose amount rides the draw dial alone —
    // a draw year captured as the projection's template —
    // projected $0 of money out when the base read the
    // conversion dial alone: the draw never entered the
    // walk, and every projected year priced without it.
    // The moneyOutKind below decides which ONE dial the
    // total rides in each projected year; the stop rules,
    // the replace mode, and the balance caps then apply
    // to that total exactly as they applied to the
    // conversion alone, and a template carrying its money
    // out on the conversion dial alone (every pre-P-M4
    // template) walks bit-identically to before.
    let moneyOut = Math.max(
      0,
      template.conversion + Math.max(0, template.spendingDraw ?? 0),
    );
    if (opts.stopKind === "age" && opts.stopAge != null && age > opts.stopAge) {
      moneyOut = 0;
    }
    if (opts.drawMode === "replace" && moneyOut > 0) {
      const arrival = ssPrimary + ssSpouse + rmdThis;
      moneyOut = Math.max(0, moneyOut - Math.max(0, arrival - baselineArrival));
    }
    if (hasPretax && moneyOut > 0) {
      moneyOut = Math.min(moneyOut, afterRmd);
      if (opts.stopKind === "floor" && opts.stopFloor != null) {
        moneyOut = Math.min(moneyOut, Math.max(0, afterRmd - opts.stopFloor));
      }
    }
    moneyOut = r2(moneyOut);
    // The money out drains the primary's post-RMD balance
    // first, the spouse's second (the plan march's
    // allocation, above) — the split decides which owner's
    // balance the NEXT year's RMD prices off.
    const fromPrimary = r2(Math.min(moneyOut, afterRmdPrimary));
    const fromSpouse = r2(moneyOut - fromPrimary);
    // The year's sale: capped at the tracked taxable balance
    // when one was entered, its basis scaled by the same
    // fraction so the gain ratio is the template's.
    let stockSoldEffective = template.stockSold;
    let stockBasisEffective = template.stockBasis;
    if (taxable != null && template.stockSold > 0 && template.stockSold > taxable) {
      stockSoldEffective = Math.max(0, taxable);
      stockBasisEffective = r2(
        template.stockBasis * (stockSoldEffective / template.stockSold),
      );
    }
    // SHOULD-3: when harvest facts are carried, the
    // repeated sale's basis is the pool's own tracked
    // ratio — the sale retires basis at the pool's basis
    // dollars over its balance — not the template's typed
    // basis, which goes stale the first year a harvest
    // steps the basis up (the settlement's year-2 leg:
    // the sale priced at the template's +$20,000 gain
    // against a pool whose true remaining gain was zero).
    // With no harvest facts, or an empty pool, the
    // template basis above stands.
    // SHOULD-2 (ChatGPT review, settled STAND): in the
    // FIRST walked year the sale is the KNOWN sale, and
    // its typed lot basis stands — the pool ratio would
    // overwrite the known lot's basis (the settlement's
    // worked example: a full-basis lot priced at the
    // pool's ratio, $10,000 of gain the lot never had).
    // From the second year on the sale is a MODELED
    // repeat, and the pool ratio applies as before. A
    // first-year sale with NO typed basis (blank reads
    // $0) still takes the pool ratio, exactly as before,
    // so a plan without a typed first-year sale basis
    // does not move. The ledger update below retires
    // stockBasisEffective — the typed amount, in year 1
    // — from the pool's basis dollars, so the lot's
    // basis is not counted again in later years.
    if (
      harvestBasisDollars != null &&
      harvestPoolBalance != null &&
      harvestPoolBalance > 0 &&
      stockSoldEffective > 0 &&
      !(firstWalkYear && template.stockBasis > 0)
    ) {
      stockBasisEffective = r2(
        (stockSoldEffective * harvestBasisDollars) / harvestPoolBalance,
      );
    }
    const householdSize =
      template.acaHouseholdSize == null
        ? null
        : acaHouseholdSizeForYear(
            template.acaHouseholdSize,
            opts.acaHouseholdSchedule,
            calendarYear,
          );
    // P-S4(c) (see the state block above the loop), as
    // extended by ChatGPT SHOULD-5: the cash draw
    // prices whole in the walk's first year and is $0
    // after; the Roth draw is capped at the Roth
    // balance the walk tracks into the year in EVERY
    // walked year, the first included — the cap is the
    // same one later years already applied, so a
    // first-year draw above the balance prices only up
    // to the balance, and the unfunded part simply
    // never enters cash in (later years present the
    // cap the same way: the priced draw is the capped
    // amount, with no separate unfunded readout).
    const cashDrawEffective = firstWalkYear ? templateCashDraw : 0;
    const rothDrawEffective = Math.min(templateRothDraw, Math.max(0, roth));
    // ChatGPT SHOULD-1: the year's Medicare flags (P-S4(d)
    // above), hoisted so the premium resolution below reads
    // the same flags the year's inputs carry.
    const yearOnMedicarePrimary = medicareOverridePrimary ?? age >= 65;
    const yearOnMedicareSpouse =
      ageSpouse == null ? false : (medicareOverrideSpouse ?? ageSpouse >= 65);
    // ChatGPT SHOULD-1: the marketplace premium resolves
    // per walked year from the two tiers the template
    // carries — the household amount while both spouses
    // are on the marketplace, the single amount while
    // exactly one is (the march's own per-year resolution,
    // taxEngine.ts healthGrossAca). The enrollment premium
    // resolves to the same amount: the entered premium IS
    // the enrollment premium, so the retained-credit cap
    // keys on the year's own tier, not the template year's.
    // With neither tier entered the template carries no
    // tier facts (an older stored template, or a directly
    // built one) and the resolution is skipped: the year's
    // premium rides the template's one amount in every
    // year, exactly as before, so no stored template
    // silently reprices. When the term is active but the
    // applicable tier was never entered, the year's gross
    // falls back to the template's benchmark — the march's
    // own fallback for a null tier amount (and the
    // prefill's dial-level fallback), never $0 while a
    // premium term is entered. The fallback reads the
    // TEMPLATE's benchmark (the template year's applicable
    // benchmark): the walk does not resolve benchmarks per
    // year — a pre-existing gap, out of scope here — so
    // the fallback matches the march's rule in kind, not
    // in amount, until that gap is closed. In the template
    // year itself the resolution equals the dial by
    // construction (buildPgInputs puts the dial on the
    // template year's tier), so the first walked year
    // prices the template whole, exactly as before.
    const premiumTierHousehold = template.healthPremiumAcaHouseholdAnnual ?? null;
    const premiumTierSingle = template.healthPremiumAcaSingleAnnual ?? null;
    const premiumHasTiers =
      premiumTierHousehold != null || premiumTierSingle != null;
    const primaryOnMarketplace = !yearOnMedicarePrimary;
    const spouseOnMarketplace = joint && !yearOnMedicareSpouse;
    const premiumApplicable =
      primaryOnMarketplace && spouseOnMarketplace
        ? premiumTierHousehold
        : primaryOnMarketplace !== spouseOnMarketplace
          ? premiumTierSingle
          : null;
    const premiumTermActive =
      template.healthPremiumAcaAnnual != null ||
      premiumTierHousehold != null ||
      premiumTierSingle != null ||
      template.healthPremiumMedicarePerPerson != null;
    const premiumResolved = premiumApplicable ??
      (premiumTermActive ? (template.acaBenchmarkAnnual ?? null) : null);
    // R2 (see the state block above the loop) as
    // extended by SHOULD-3: the year's harvest basis
    // percent is the CURRENT pool's ratio — the carried
    // basis dollars over the carried pool balance,
    // uncapped, so an underwater pool's ratio above 100
    // rides through to the pricer, whose netting
    // reconstructs the true basis dollars from it (the
    // pricer floors the percent at 0 only). The first
    // walked year this is the template's own percent.
    // With no harvest facts the template's own value
    // rides through untouched.
    const harvestBasisPctEffective =
      harvestBasisDollars != null &&
      harvestPoolBalance != null &&
      harvestPoolBalance > 0
        ? (100 * harvestBasisDollars) / harvestPoolBalance
        : template.harvestPoolBasisPct;
    const inputs: PlaygroundYearInputs = {
      ...template,
      taxYear: calendarYear,
      agePrimary: age,
      ageSpouse,
      // P-S4(d): a carried Medicare override (the
      // template flag that disagreed with the age rule
      // at the template's age) wins over the year's age
      // rule; with no override the year's own age rule
      // prices, exactly as before. (Hoisted above as
      // yearOnMedicarePrimary / yearOnMedicareSpouse so
      // the premium resolution reads the same flags.)
      onMedicarePrimary: yearOnMedicarePrimary,
      onMedicareSpouse: yearOnMedicareSpouse,
      ssPrimary,
      ssSpouse,
      // The walk's money out rides the dial its kind names
      // (M-2 split): a conversion on the conversion dial —
      // not spendable cash, so the year's cash-in / cash-left
      // readouts exclude it — and a draw on the spendingDraw
      // dial, where it counts as cash in hand. The priced tax
      // is identical either way (the pricer prices the two
      // dials' sum as the year's pre-tax money out), and the
      // walk's own balance math below reads moneyOut itself,
      // never the dials, so no balance moves.
      conversion: opts.moneyOutKind === "conversion" ? moneyOut : 0,
      spendingDraw: opts.moneyOutKind === "draw" ? moneyOut : 0,
      stockSold: stockSoldEffective,
      stockBasis: stockBasisEffective,
      /* R3-S2: each owner's starting balance rides its OWN
         field, so the pricer prices the two RMDs on the two
         clocks — never a combined balance on the primary's
         clock with the spouse's nulled. A side the template
         never entered stays null, exactly as the single-year
         view prices it. */
      pretaxBalance: pretaxPrimary,
      pretaxBalanceSpouse: pretaxSpouse,
      acaHouseholdSize: householdSize,
      acaConvention: "newest",
      // ChatGPT SHOULD-1: the year's marketplace premium
      // and enrollment premium are the resolved tier
      // (see premiumResolved above) when the template
      // carries tier facts; otherwise the template's own
      // amounts ride through, exactly as before.
      healthPremiumAcaAnnual: premiumHasTiers
        ? premiumResolved
        : template.healthPremiumAcaAnnual,
      acaEnrollmentPremiumAnnual: premiumHasTiers
        ? premiumResolved
        : template.acaEnrollmentPremiumAnnual,
      // P-S4(b): the year's entering carryforward is
      // the chained ledger state (the template's own
      // carry-in in the first walked year, the prior
      // year's reconciled carry-out after that), never
      // the template's spread repeated.
      capitalLossCarryInSt: carryInSt,
      capitalLossCarryInLt: carryInLt,
      capitalLossCarryInStWa: carryInStWa,
      capitalLossCarryInLtWa: carryInLtWa,
      // P-S4(c): the year's effective funding draws
      // (see cashDrawEffective above).
      cashDraw: cashDrawEffective,
      rothDraw: rothDrawEffective,
      // SHOULD-3: the year's harvest pool is the CARRIED
      // balance — the template's pool in the first walked
      // year, reduced by each prior year's sale — and its
      // basis percent is the carried ratio (see
      // harvestBasisPctEffective above). A harvest sells
      // and repurchases, so it never changes the balance;
      // the year's SALE does, and the pricer nets that
      // sale out of the pool it is handed.
      harvestPoolAmount: harvestPoolBalance,
      harvestPoolBasisPct: harvestBasisPctEffective,
      // ChatGPT SHOULD-3 (ChatGPT review, SHOULD —
      // settled STAND): the received RMD is a ONE-YEAR
      // fact, so from the second walked year on it is
      // neither income nor a netting. The recurring other
      // ordinary income drops the received amount — it
      // prices only in the template year it was received
      // in — and the netting input is zero, so the walked
      // year prices its own gross RMD whole. Before, the
      // spread repeated BOTH facts into every year: the
      // income half outlived the netting half the moment
      // the walked gross RMD fell below the received
      // amount, so a year whose pre-tax account was empty
      // still priced the received amount as income and
      // cash. While the gross RMD stays above the received
      // amount the two halves cancel exactly as P-S4
      // states, so those years price bit-identically; the
      // first walked year prices the template whole,
      // exactly as before.
      otherOrdinary: firstWalkYear
        ? template.otherOrdinary
        : template.otherOrdinary - receivedRmd,
      rmdAlreadyReceived: firstWalkYear ? template.rmdAlreadyReceived : 0,
      // IRMAA payable this year (internal review round 3
      // SHOULD-2): the walk prices NONE, whatever the
      // template carries — the entered amount states the
      // surcharge payable in the ONE priced year, and a
      // walked year has its own payable IRMAA (its MAGI
      // two years prior), which no single entered amount
      // can state. Carrying the template's amount into
      // every walked year would charge the same surcharge
      // in years whose MAGIs price different ones. The
      // stored template does not carry this fact either
      // (see projTemplateCore), so a restored template
      // arrives without it; this strip covers a template
      // captured in-memory from the dials.
      irmaaPayableAnnual: undefined,
      // ROTH BASIS / CLOCK (Engine Review C9, Build 2 —
      // W3): the template's Roth composition is a ONE-YEAR
      // opening fact — the first walked year prices the
      // template whole, exactly as before, but the walk
      // does NOT track the ledger forward (no depletion of
      // contributions / lots, no lot appended by the
      // walk's conversions), so from the second walked
      // year on the composition is unknown, not the
      // template's opening figures repeated: the inputs
      // are stripped and those years price the Roth draw
      // under the assumed-qualified default with the
      // result's rothBasisUnknown flag saying so. Carrying
      // the opening basis into every year would price
      // every year's draw against basis the first year
      // already spent. A full ledger walk (chaining the
      // ledger state like the loss carryforward above) is
      // a follow-up — see the builder report.
      rothContributionBasis: firstWalkYear
        ? template.rothContributionBasis
        : undefined,
      rothConversionLots: firstWalkYear
        ? template.rothConversionLots
        : undefined,
      firstRothYear: firstWalkYear ? template.firstRothYear : undefined,
      firstDesignatedRothYear: firstWalkYear
        ? template.firstDesignatedRothYear
        : undefined,
      rothBalance: firstWalkYear ? template.rothBalance : undefined,
      rothIraBalance: firstWalkYear ? template.rothIraBalance : undefined,
      rothEmployerBalance: firstWalkYear
        ? template.rothEmployerBalance
        : undefined,
    };
    const result = pricePlaygroundYear(inputs);
    const startBalances: PlaygroundProjectionBalances = {
      pretax: pretaxCombined,
      taxable,
      roth,
    };
    // Each owner's balance falls by that owner's own gross
    // RMD and that owner's share of the money out, then
    // grows — the combined end is the sum of the two walked
    // ends (each rounded as the plan march rounds its
    // per-owner ends). With no spouse balance entered the
    // spouse side is $0 throughout and this is the pre-R3-S2
    // combined walk term for term.
    const endPrimaryNum = hasPretax
      ? r2(Math.max(0, (pretaxPrimary ?? 0) - rmds.primary - fromPrimary) * growth)
      : null;
    const endSpouseNum = hasPretax
      ? r2(Math.max(0, (pretaxSpouse ?? 0) - rmds.spouse - fromSpouse) * growth)
      : null;
    const endPretax =
      endPrimaryNum == null || endSpouseNum == null
        ? null
        : r2(endPrimaryNum + endSpouseNum);
    const endTaxable =
      taxable == null
        ? null
        : r2(Math.max(0, taxable - stockSoldEffective) * growth);
    // P-S4(c): the year's Roth draw LEAVES the tracked
    // Roth balance like every other drawdown — before,
    // the balance grew by the conversion alone and the
    // draw was never subtracted, so the same Roth
    // dollars funded every projected year.
    const endRoth = r2(
      Math.max(
        0,
        roth +
          (opts.moneyOutKind === "conversion" ? moneyOut : 0) -
          rothDrawEffective,
      ) * growth,
    );
    years.push({
      calendarYear,
      agePrimary: age,
      ageSpouse,
      inputs,
      result,
      moneyOut,
      stockSoldEffective,
      stockBasisEffective,
      startBalances,
      endBalances: { pretax: endPretax, taxable: endTaxable, roth: endRoth },
    });
    // A side the template never entered stays unentered
    // (null) for the whole walk; an entered side walks its
    // own numeric end forward.
    pretaxPrimary = primaryEntered ? endPrimaryNum : null;
    pretaxSpouse = spouseEntered ? endSpouseNum : null;
    pretaxCombined = endPretax;
    taxable = endTaxable;
    roth = endRoth;
    // P-S4(b): the next walked year enters with THIS
    // year's reconciled carry-out — the loss ledger
    // chains through the projection.
    carryInSt = result.lossCarryOutSt;
    carryInLt = result.lossCarryOutLt;
    carryInStWa = result.lossCarryOutStWa;
    carryInLtWa = result.lossCarryOutLtWa;
    // R2, as extended by SHOULD-3: the year's sale
    // retires basis at the priced sale basis, the
    // harvest steps it back up by the gain it realized,
    // and the pool balance falls by the sale — grown by
    // the year's return beside the tracked taxable
    // balance — so the next year opens on the pool that
    // remains, at its true ratio. The basis floors at $0
    // (a sale retires no more basis than the pool
    // carries) and, being fixed dollars, does not grow
    // with the return the way the balance does.
    if (harvestBasisDollars != null) {
      harvestBasisDollars = r2(
        Math.max(
          0,
          harvestBasisDollars - stockBasisEffective + result.harvestedGain,
        ),
      );
    }
    if (harvestPoolBalance != null) {
      harvestPoolBalance = r2(
        Math.max(0, harvestPoolBalance - stockSoldEffective) * growth,
      );
    }
    firstWalkYear = false;
  }
  // A later from-age only slices the shown years (the walk
  // above still ran from the template / walk-start year, so
  // the first shown year's startBalances are the walked
  // ones); an earlier or absent from-age shows the whole walk.
  const shownYears =
    displayFromAge > walkStartAge
      ? years.filter((y) => y.agePrimary >= displayFromAge)
      : years;
  return {
    years: shownYears,
    endBalances: { pretax: pretaxCombined, taxable, roth },
  };
}

/* Bracket-fill solve for the Playground's quick-set chips.
   Returns the conversion (to the cent) that lands the year's
   ORDINARY taxable income exactly on the top of the named
   federal bracket, given everything else in `inp` — solved
   entirely by repricing candidate conversions through
   pricePlaygroundYear above (the shared priceYear path), so
   there is no second calculator to drift: typed interest,
   ordinary dividends and other ordinary income stack first and
   shrink the fill; the RMD priced off a typed pre-tax balance
   stacks first too; Social Security counts at its §86 taxable
   portion, which itself grows as the conversion rises (the
   solve iterates against the engine, so that feedback is in
   the answer); the year's deductions (standard deduction,
   65+ add-ons, the senior deduction as priced) come from the
   same engine pass. Qualified dividends and the stock gain do
   NOT consume ordinary bracket room — ordinary taxable income
   already excludes the gains stack — so they never shrink the
   fill (they still count toward MAGI in the readout, as
   before). Ordinary taxable income is non-decreasing in the
   conversion under the engine, so a cent-level binary search
   over engine pricings finds the largest conversion whose
   landing is at or under the bracket top; when the next cent
   would overshoot, that conversion is the fill (its landing
   is within the step of the top — in the ordinary slope-1
   case it is exact to the cent, which is what lights the
   readout's exact-fill detection). Honest edges: other income
   alone at or past the top → $0 (no fill left); a typed
   balance whose maximum convertible amount (balance − RMD)
   cannot reach the top → that maximum. */
export function solvePlaygroundBracketFill(
  inp: PlaygroundYearInputs,
  bracketTopPct: number,
): number {
  const law = lawForYear(inp.taxYear);
  const idx = law.rates.indexOf(bracketTopPct);
  if (idx < 0) return 0;
  const top = law.brackets[inp.filingStatus][idx] ?? Infinity;
  if (!Number.isFinite(top)) return 0;
  // "Past the top" is read off the priced bracket layers, not
  // the rounded ordinary-taxable-income figure: in the §86
  // phase-in zone a cent of conversion moves taxable income by
  // up to ~1.85 cents, so the unrounded landing can sit a
  // fraction of a cent past the top while the rounded figure
  // still reads exactly on it — and the readout's landing
  // detection (which keys off the same layers) would then name
  // the NEXT bracket. The last layer's ceiling is the bracket
  // the unrounded landing actually falls in.
  const pastTop = (conversion: number): boolean => {
    const layers = pricePlaygroundYear({ ...inp, conversion }).bracketLayers;
    const last = layers[layers.length - 1];
    return last != null && (last.to == null || last.to > top);
  };
  const zero = pricePlaygroundYear({ ...inp, conversion: 0 });
  if (zero.ordinaryTaxableIncome >= top - 1e-9 || pastTop(0)) return 0;
  // Cap: never set more than can actually be converted out of
  // a typed balance (the RMD comes out first). If even the cap
  // does not reach the top, the cap is the answer — the
  // bracket simply can't be filled from this balance.
  let capCents: number | null = null;
  // S-12: the cap totals only the balance the filer holds —
  // the spouse's balance counts on a joint return alone
  // (countedSpousePretax), so a stale spouse balance left on
  // the dial by a switch to single filing cannot raise it.
  const countedSpouse = countedSpousePretax(inp);
  const typedTotalBalance =
    inp.pretaxBalance == null && countedSpouse == null
      ? null
      : (inp.pretaxBalance ?? 0) + (countedSpouse ?? 0);
  if (typedTotalBalance != null) {
    capCents = Math.max(0, Math.round((typedTotalBalance - zero.rmdGross) * 100));
    if (!pastTop(capCents / 100)) return r2(capCents / 100);
  }
  // Upper bound (cents) past the top: grow from the slope-1
  // estimate until the engine says it crosses.
  let hiCents = Math.max(100, Math.round((top - zero.ordinaryTaxableIncome) * 100));
  if (capCents != null) hiCents = Math.min(hiCents, capCents);
  while (!pastTop(hiCents / 100)) {
    hiCents = hiCents * 2 + 100;
    if (capCents != null && hiCents >= capCents) {
      hiCents = capCents;
      break;
    }
    if (hiCents > 1_000_000_000) break; // $10M — far past any bracket top
  }
  // Binary search: the largest cent conversion whose landing
  // is not past the top.
  let loCents = 0;
  let hi = hiCents;
  while (loCents < hi) {
    const mid = Math.floor((loCents + hi + 1) / 2);
    if (!pastTop(mid / 100)) {
      loCents = mid;
    } else {
      hi = mid - 1;
    }
  }
  return r2(loCents / 100);
}

/* ACA-cliff fill solve for the Playground's ACA cliff chip and
   its cliff − buffer guide (ACA BUFFER GUIDE build). Returns
   the pre-tax money out (to the cent) that lands the year's
   ACA MAGI exactly on a target line — the 400%-of-FPL cliff
   the engine reports for the typed year + household size,
   LESS `bufferDollars` (default 0: the plain cliff fill the
   chip has always solved; a positive buffer aims that far
   under the cliff, the December safety cushion). The buffer
   is a GUIDE for choosing the conversion dial only: it is
   not an input to pricePlaygroundYear and never enters any
   priced figure — for any fixed conversion the year prices
   bit-identically with any buffer. Returns null when the
   priced year has no hard cliff to aim at (the ACA block
   does not apply — everyone on Medicare — no household size
   typed, or a coverage year before 2026, whose enhanced
   credit has no cliff by design: acaCreditFor's hasCliff
   rule). The cliff the engine reports already carries the
   §36B guideline lookback (acaCreditFor reads the prior
   year's guideline row for the coverage year), so the target
   is the engine's own line, not a recomputation. The solve
   iterates against the engine rather than subtracting
   displayed figures, so every MAGI component the engine
   counts is in the answer — interest, ordinary and qualified
   dividends, other ordinary income, tax-exempt interest, the
   stock sale's gain, the year's RMD, and Social Security at
   the amount the engine counts toward ACA MAGI as the draw
   rises. ACA MAGI is non-decreasing in the pre-tax amount,
   so a cent-level binary search over engine pricings finds
   the largest amount whose ACA MAGI is at or under the
   target — in the ordinary slope-1 case that amount prices
   ACA MAGI exactly on the target. Honest edges, mirroring
   solvePlaygroundBracketFill: other income alone already at
   or past the target (with a buffer, already past
   cliff − buffer at $0 of conversion) → $0, never negative
   (nothing can pull it back); a typed balance whose maximum
   drawable amount (balance − RMD) cannot reach the target →
   that maximum. A buffer at or above the cliff makes the
   target ≤ $0 of MAGI, which $0 of conversion already meets
   or exceeds, so the answer is $0 by the same edge. */
export function solvePlaygroundAcaCliffFill(
  inp: PlaygroundYearInputs,
  bufferDollars = 0,
): number | null {
  if (inp.taxYear < 2026) return null;
  const buffer = Math.max(0, bufferDollars);
  const zero = pricePlaygroundYear({ ...inp, conversion: 0 });
  const cliff = zero.aca.cliff;
  if (!zero.aca.applies || cliff == null) return null;
  const target = cliff - buffer;
  const pastTarget = (conversion: number): boolean =>
    pricePlaygroundYear({ ...inp, conversion }).acaMagi > target + 1e-9;
  if (zero.acaMagi >= target - 1e-9) return 0;
  // Cap: never set more than can actually come out of a typed
  // balance (the RMD comes out first). If even the cap does
  // not reach the target, the cap is the answer.
  let capCents: number | null = null;
  // S-12: the cap totals only the balance the filer holds —
  // the spouse's balance counts on a joint return alone
  // (countedSpousePretax), so a stale spouse balance left on
  // the dial by a switch to single filing cannot raise it.
  // This is the December headline's solver too: the console's
  // entered split reaches it verbatim, stale balance included.
  const countedSpouse = countedSpousePretax(inp);
  const typedTotalBalance =
    inp.pretaxBalance == null && countedSpouse == null
      ? null
      : (inp.pretaxBalance ?? 0) + (countedSpouse ?? 0);
  if (typedTotalBalance != null) {
    capCents = Math.max(0, Math.round((typedTotalBalance - zero.rmdGross) * 100));
    if (!pastTarget(capCents / 100)) return r2(capCents / 100);
  }
  // Upper bound (cents) past the target: grow from the
  // slope-1 estimate until the engine says it crosses.
  let hiCents = Math.max(100, Math.round((target - zero.acaMagi) * 100));
  if (capCents != null) hiCents = Math.min(hiCents, capCents);
  while (!pastTarget(hiCents / 100)) {
    hiCents = hiCents * 2 + 100;
    if (capCents != null && hiCents >= capCents) {
      hiCents = capCents;
      break;
    }
    if (hiCents > 1_000_000_000) break; // $10M — far past any cliff
  }
  // Binary search: the largest cent amount whose ACA MAGI is
  // not past the target.
  let loCents = 0;
  let hi = hiCents;
  while (loCents < hi) {
    const mid = Math.floor((loCents + hi + 1) / 2);
    if (!pastTarget(mid / 100)) {
      loCents = mid;
    } else {
      hi = mid - 1;
    }
  }
  return r2(loCents / 100);
}

/* ---------------- Engine access (shared helpers) ----------------
   The engine-access build exposes the shipped engine through
   server actions (runPlaygroundYear / runPlanYearDetail in
   server/src/actions.ts) so a priced question can be answered —
   and re-checked — by CALLING the engine instead of deriving by
   hand. The helpers below are the shared, fixture-pinned pieces:
   the Playground paste payload (emitted by the pricing action,
   consumed by the Playground's paste loader in the client — the
   same module both sides import), the snapshot balance
   resolution the plan-level actions apply server-side, and the
   plan-year two-pricing. No state lives here: every helper is a
   pure function over its inputs. */

/* The canonical Playground paste payload: a compact JSON object
   naming every Playground dial, in dollars (the engine's units),
   exactly as PlaygroundYearInputs carries them. `kind`/`version`
   tag the shape so a loader can refuse anything else plainly. */
export type PlaygroundPastePayload = Omit<
  PlaygroundYearInputs,
  | "residenceState"
  | "educationStudents"
  | "spendingDraw"
  | "capitalLossCarryInSt"
  | "capitalLossCarryInLt"
  | "capitalLossCarryInStWa"
  | "capitalLossCarryInLtWa"
  | "rmdAlreadyReceived"
  | "dependentMagiForAca"
  | "cashDraw"
  | "rothDraw"
  | "pretaxBalanceSpouse"
  | "primarySoleBeneficiaryOfSpouse"
  | "aptcTaken"
  | "acaCoverageReduction"
  | "acaEnrollmentPremiumAnnual"
  | "healthPremiumAcaAnnual"
  | "healthPremiumMedicarePerPerson"
  | "irmaaPayableAnnual"
  | "itemizedMortgageInterest"
  | "itemizedSaltPaid"
  | "itemizedCharitable"
  | "itemizedOther"
  | "harvestPoolAmount"
  | "harvestPoolBasisPct"
> & {
  kind: "playground-year";
  version: 1;
  // The spouse's pre-tax balance: always present in a
  // payload this builder emits (null when no spouse
  // balance was entered), so a replay prices the same
  // spouse RMD the copied year priced. (The engine inputs
  // type it as an optional nullable; the payload carries
  // it always-present nullable, like every other unset
  // dial here.)
  pretaxBalanceSpouse: number | null;
  // Always present in a payload this builder emits (null when
  // unset), so a replay prices the same state layer and the
  // same credits the copied year priced.
  residenceState: "WA" | "other" | null;
  educationStudents: EducationStudent[] | null;
  // The entering capital-loss carryforward (S-2): always
  // present in a payload this builder emits (null when
  // unset), so a replay prices the same loss ledger the
  // copied year priced. (The engine inputs type these four
  // as optional numbers; the payload carries them nullable,
  // like every other unset dial here.)
  capitalLossCarryInSt: number | null;
  capitalLossCarryInLt: number | null;
  capitalLossCarryInStWa: number | null;
  capitalLossCarryInLtWa: number | null;
  // The RMD already received and the dependent MAGI (S-2):
  // the same always-present, null-when-unset spelling.
  rmdAlreadyReceived: number | null;
  dependentMagiForAca: number | null;
  // The reinvested-yield fact (S-3): always present in a
  // payload this builder emits (false when unset), so a
  // replayed paste of a loaded saved-plan year keeps the
  // yield out of cash in exactly as the loader priced it.
  yieldReinvested: boolean;
  // The inflation rate (S-4): always present in a payload
  // this builder emits (null when unset), so a replay
  // prices the same deflated statute-fixed amounts the
  // copied year priced.
  inflationPct: number | null;
  // The cash and Roth funding draws (S-6): always present
  // in a payload this builder emits (null when unset), so
  // a replay prices the same spendable funding the copied
  // year priced. (The engine inputs type these two as
  // optional numbers; the payload carries them nullable,
  // like every other unset dial here.)
  cashDraw: number | null;
  rothDraw: number | null;
  // The pre-tax spending draw (R3-M1, engines review
  // round 3): always present in a payload this builder
  // emits (null when unset), so a replay prices the same
  // spendable money out the copied year priced — before
  // R3-M1 the payload omitted the draw entirely (the
  // form had no draw dial), so a pasted draw year lost
  // the draw's cash-in whole. (The engine inputs type it
  // as an optional number; the payload carries it
  // nullable, like every other unset dial here.)
  spendingDraw: number | null;
  // The reciprocal beneficiary fact (N-1, engines review
  // round 2): always present in a payload this builder
  // emits (null when unset), so a replay prices the same
  // spouse RMD table the copied year priced. (The engine
  // inputs type this fact as an optional boolean-or-null;
  // the payload carries it always-present nullable, like
  // every other unset fact here.)
  primarySoleBeneficiaryOfSpouse: boolean | null;
  // The itemized deduction components (P-M2, parity audit):
  // always present in a payload this builder emits (null
  // when unset), so a replay prices the same greater-of
  // deduction the copied year priced — before P-M2 the
  // payload omitted all four, so a pasted itemized year
  // silently repriced on the standard deduction. (The
  // engine inputs type these four as optional numbers;
  // the payload carries them nullable, like every other
  // unset dial here.)
  itemizedMortgageInterest: number | null;
  itemizedSaltPaid: number | null;
  itemizedCharitable: number | null;
  itemizedOther: number | null;
  // The enrollment premium (P-M3, parity audit): always
  // present in a payload this builder emits (null when
  // unset), so a replay prices the same capped filing
  // settlement the copied year priced — before P-M3 the
  // payload carried the premium's health twin
  // (healthPremiumAcaAnnual, which prices the premium
  // readout) but never this fact, and the settlement cap
  // keys off this fact alone, so a pasted year repriced
  // with the uncapped benchmark credit. (The engine
  // inputs type it as an optional nullable; the payload
  // carries it always-present nullable, like every other
  // unset dial here.)
  acaEnrollmentPremiumAnnual: number | null;
  // The ACA reconciliation facts (S-1): always present
  // in a payload this builder emits (null when unset), so
  // a replay prices the same filing settlement the copied
  // year priced. (The engine inputs type the pair as
  // optional nullables; the payload carries them
  // always-present nullable, like every other unset fact
  // here.)
  aptcTaken: number | null;
  acaCoverageReduction: number | null;
  // The health premiums and the payable IRMAA surcharge
  // (v208 / internal review round 3 SHOULD-2): always
  // present in a payload this builder emits (null when
  // unset), so a replay prices the same cash left after
  // health premiums the copied year priced. (The engine
  // inputs type the three as optional nullables; the
  // payload carries them always-present nullable, like
  // every other unset dial here.)
  healthPremiumAcaAnnual: number | null;
  healthPremiumMedicarePerPerson: number | null;
  irmaaPayableAnnual: number | null;
  // The annual spending (P-S2, parity audit): always
  // present in a payload this builder emits (null when
  // the priced year carried no spending), so a replay
  // prices the same "enough for the year" comparison the
  // copied year priced — before P-S2 the payload omitted
  // it, so a pasted year carried no spending and the
  // comparison fell back to the live record's figure,
  // repricing (or losing) the verdict against a figure
  // the copied year never priced with. (The engine inputs
  // type it as an optional nullable; the payload carries
  // it always-present nullable, like every other unset
  // dial here.)
  annualSpending: number | null;
  // The gain-harvest facts (P-S3, parity audit): always
  // present in a payload this builder emits (null when
  // unset), so a replay prices the same harvest the
  // copied year priced — before P-S3 the facts sat in
  // this payload's type (they survive the Omit above
  // from the engine inputs) but in neither the field
  // list nor the builder, and the parser refused them
  // as unknown fields, so a harvest year could not
  // round-trip and a hand-built paste carrying the
  // facts was refused outright. (The engine inputs type
  // the pair as optional nullables; the payload carries
  // them always-present nullable, like every other
  // unset dial here. The pricer sizes a harvest only
  // when BOTH are present.)
  harvestPoolAmount: number | null;
  harvestPoolBasisPct: number | null;
};

export const PLAYGROUND_PASTE_FIELDS = [
  "taxYear",
  "filingStatus",
  "agePrimary",
  "ageSpouse",
  "onMedicarePrimary",
  "onMedicareSpouse",
  "interest",
  "ordinaryDividends",
  "otherOrdinary",
  "taxExemptInterest",
  "ssPrimary",
  "ssSpouse",
  "conversion",
  "stockSold",
  "stockBasis",
  "qualifiedDividends",
  "pretaxBalance",
  "pretaxBalanceSpouse",
  "primarySoleBeneficiaryOfSpouse",
  "spouseSoleBeneficiary",
  "acaHouseholdSize",
  "acaBenchmarkAnnual",
  "aptcTaken",
  "acaCoverageReduction",
  "acaEnrollmentPremiumAnnual",
  "healthPremiumAcaAnnual",
  "healthPremiumMedicarePerPerson",
  /* The IRMAA surcharge payable this year (internal review
     round 3 SHOULD-2): carried so a replayed paste
     reprices the same cash left after health premiums the
     copied year priced — the payable surcharge beside the
     base premium — instead of silently pricing none. */
  "irmaaPayableAnnual",
  "stateRatePct",
  "residenceState",
  "educationStudents",
  /* The December-only pricing facts (S-2): the entering
     capital-loss carryforward (four dials), the RMD
     already received, and the dependent MAGI for ACA —
     carried so a replayed paste reprices the same year
     the Playground's dials price. */
  "capitalLossCarryInSt",
  "capitalLossCarryInLt",
  "capitalLossCarryInStWa",
  "capitalLossCarryInLtWa",
  "rmdAlreadyReceived",
  "dependentMagiForAca",
  /* The reinvested-yield fact (S-3): carried so a replayed
     paste of a loaded saved-plan year reprices the same
     cash left the loader priced (the yield kept out of
     cash in). */
  "yieldReinvested",
  /* The inflation rate (S-4): carried so a replayed paste
     reprices the same deflated statute-fixed amounts the
     copied year priced. */
  "inflationPct",
  /* The cash and Roth funding draws (S-6): carried so a
     replayed paste reprices the same spendable funding
     the copied year priced (the draws in cash in, never
     in the tax). */
  "cashDraw",
  "rothDraw",
  /* The pre-tax spending draw (R3-M1): carried so a
     replayed paste reprices the same money-out split the
     copied year priced — the draw in cash in beside its
     income pricing, the conversion as income alone. */
  "spendingDraw",
  /* The itemized deduction components (P-M2): carried so
     a replayed paste reprices the same greater-of
     deduction the copied year priced, instead of falling
     back to the standard deduction. */
  "itemizedMortgageInterest",
  "itemizedSaltPaid",
  "itemizedCharitable",
  "itemizedOther",
  /* The annual spending (P-S2): carried so a replayed
     paste prices the same "enough for the year"
     comparison the copied year priced, instead of
     falling back to the live record's spending. */
  "annualSpending",
  /* The gain-harvest facts (P-S3): carried so a
     replayed paste reprices the same harvest the
     copied year priced, instead of silently pricing
     no harvest — the pair the December console
     supplies its harvest with. */
  "harvestPoolAmount",
  "harvestPoolBasisPct",
] as const;

/* The paste fields a payload written before the cold-AI
   audit fix may legitimately omit: residenceState and
   educationStudents were added to the payload by that fix,
   so an older paste carries neither key and must still load
   (absent prices exactly as before — the flat state rate and
   no students). Every other field stays required. */
export const PLAYGROUND_PASTE_OPTIONAL_FIELDS = [
  "residenceState",
  "educationStudents",
  /* The spouse's pre-tax balance (split-balance build): a
     paste written before it existed carries no such key and
     loads with it absent — no spouse balance, no spouse
     RMD, exactly as before. */
  "pretaxBalanceSpouse",
  /* The health premium inputs (health premium build): a
     paste written before they existed carries neither key
     and loads with both absent — no premium priced, exactly
     as before. */
  "healthPremiumAcaAnnual",
  "healthPremiumMedicarePerPerson",
  /* The IRMAA surcharge payable this year (internal review
     round 3 SHOULD-2): a paste written before it was
     carried carries no such key and loads with it absent
     — no payable IRMAA charged, exactly as before. */
  "irmaaPayableAnnual",
  /* The ACA reconciliation facts (S-1): a paste written
     before they existed carries neither key and loads with
     both absent — no filing settlement priced, exactly as
     before. */
  "aptcTaken",
  "acaCoverageReduction",
  /* The December-only pricing facts (S-2): a paste written
     before they existed carries none of the six keys and
     loads with them all absent — no carry-in netted, no
     RMD netted, no dependent MAGI added, exactly as
     before. */
  "capitalLossCarryInSt",
  "capitalLossCarryInLt",
  "capitalLossCarryInStWa",
  "capitalLossCarryInLtWa",
  "rmdAlreadyReceived",
  "dependentMagiForAca",
  /* The reinvested-yield fact (S-3): a paste written before
     it existed carries no such key and loads with it absent
     — the yield counts as cash in, exactly as before. */
  "yieldReinvested",
  /* The inflation rate (S-4): a paste written before it
     existed carries no such key and loads with it absent —
     statute-fixed amounts undeflated, exactly as before. */
  "inflationPct",
  /* The cash and Roth funding draws (S-6): a paste written
     before they existed carries neither key and loads with
     both absent — no cash or Roth funding counted, exactly
     as before. */
  "cashDraw",
  "rothDraw",
  /* The pre-tax spending draw (R3-M1): a paste written
     before it was carried carries no such key and loads
     with it absent — no draw counted, the year's money
     out all on the conversion dial, exactly as before. */
  "spendingDraw",
  /* The reciprocal beneficiary fact (N-1): a paste written
     before it was carried carries no such key and loads
     with it absent — not established, so the spouse's RMD
     prices on the Uniform Lifetime Table, exactly as
     before. */
  "primarySoleBeneficiaryOfSpouse",
  /* The itemized deduction components (P-M2): a paste
     written before they were carried carries none of the
     four keys and loads with them all absent — no itemized
     amounts entered, so the year prices on the standard
     side, exactly as before. */
  "itemizedMortgageInterest",
  "itemizedSaltPaid",
  "itemizedCharitable",
  "itemizedOther",
  /* The enrollment premium (P-M3): a paste written before
     it was carried carries no such key and loads with it
     absent — no cap on the settlement credit, exactly as
     before. */
  "acaEnrollmentPremiumAnnual",
  /* The annual spending (P-S2): a paste written before
     it was carried carries no such key and loads with it
     absent — no spending carried, so the loader resolves
     the comparison's spending exactly as before. */
  "annualSpending",
  /* The gain-harvest facts (P-S3): a paste written
     before they were carried carries neither key and
     loads with both absent — no harvest priced, exactly
     as before. */
  "harvestPoolAmount",
  "harvestPoolBasisPct",
] as const;

export function playgroundPastePayload(
  inp: PlaygroundYearInputs,
): PlaygroundPastePayload {
  return {
    kind: "playground-year",
    version: 1,
    taxYear: inp.taxYear,
    filingStatus: inp.filingStatus,
    agePrimary: inp.agePrimary,
    ageSpouse: inp.ageSpouse,
    onMedicarePrimary: inp.onMedicarePrimary,
    onMedicareSpouse: inp.onMedicareSpouse,
    interest: inp.interest,
    ordinaryDividends: inp.ordinaryDividends,
    otherOrdinary: inp.otherOrdinary,
    taxExemptInterest: inp.taxExemptInterest,
    ssPrimary: inp.ssPrimary,
    ssSpouse: inp.ssSpouse,
    conversion: inp.conversion,
    stockSold: inp.stockSold,
    stockBasis: inp.stockBasis,
    qualifiedDividends: inp.qualifiedDividends,
    pretaxBalance: inp.pretaxBalance,
    pretaxBalanceSpouse: inp.pretaxBalanceSpouse ?? null,
    primarySoleBeneficiaryOfSpouse:
      inp.primarySoleBeneficiaryOfSpouse ?? null,
    spouseSoleBeneficiary: inp.spouseSoleBeneficiary,
    acaHouseholdSize: inp.acaHouseholdSize,
    acaBenchmarkAnnual: inp.acaBenchmarkAnnual,
    aptcTaken: inp.aptcTaken ?? null,
    acaCoverageReduction: inp.acaCoverageReduction ?? null,
    acaEnrollmentPremiumAnnual: inp.acaEnrollmentPremiumAnnual ?? null,
    annualSpending: inp.annualSpending ?? null,
    healthPremiumAcaAnnual: inp.healthPremiumAcaAnnual ?? null,
    healthPremiumMedicarePerPerson: inp.healthPremiumMedicarePerPerson ?? null,
    irmaaPayableAnnual: inp.irmaaPayableAnnual ?? null,
    capitalLossCarryInSt: inp.capitalLossCarryInSt ?? null,
    capitalLossCarryInLt: inp.capitalLossCarryInLt ?? null,
    capitalLossCarryInStWa: inp.capitalLossCarryInStWa ?? null,
    capitalLossCarryInLtWa: inp.capitalLossCarryInLtWa ?? null,
    rmdAlreadyReceived: inp.rmdAlreadyReceived ?? null,
    dependentMagiForAca: inp.dependentMagiForAca ?? null,
    yieldReinvested: inp.yieldReinvested === true,
    inflationPct: inp.inflationPct ?? null,
    cashDraw: inp.cashDraw ?? null,
    rothDraw: inp.rothDraw ?? null,
    spendingDraw: inp.spendingDraw ?? null,
    itemizedMortgageInterest: inp.itemizedMortgageInterest ?? null,
    itemizedSaltPaid: inp.itemizedSaltPaid ?? null,
    itemizedCharitable: inp.itemizedCharitable ?? null,
    itemizedOther: inp.itemizedOther ?? null,
    harvestPoolAmount: inp.harvestPoolAmount ?? null,
    harvestPoolBasisPct: inp.harvestPoolBasisPct ?? null,
    stateRatePct: inp.stateRatePct,
    residenceState: inp.residenceState ?? null,
    educationStudents: inp.educationStudents
      ? inp.educationStudents.map((s) => ({
          expenses: s.expenses,
          aotcEligible: s.aotcEligible,
        }))
      : null,
  };
}

/* Validate a parsed paste (the JSON.parse result) FULLY, before
   anything is applied: the object must carry the canonical
   keys (kind/version plus every dial field — an unknown key
   or a missing required one refuses the whole paste), and
   every field must be of the right type and in range. The
   two fields the cold-AI audit fix added (residenceState,
   educationStudents) are OPTIONAL: a paste written before
   that fix carries neither and loads with them absent,
   pricing exactly as before. Money fields may not be
   negative — except otherOrdinary, which the Playground
   itself prices signed (a genuine loss). On success the dial
   inputs are returned whole; on failure one plain error
   string and nothing else. */
export function parsePlaygroundPaste(
  raw: unknown,
): { ok: true; inputs: PlaygroundYearInputs } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return fail("That paste is not a Playground inputs object — nothing was loaded.");
  }
  const r = raw as Record<string, unknown>;
  const allowed = new Set<string>(["kind", "version", ...PLAYGROUND_PASTE_FIELDS]);
  const optional = new Set<string>(PLAYGROUND_PASTE_OPTIONAL_FIELDS);
  for (const k of Object.keys(r)) {
    if (!allowed.has(k)) {
      return fail(`That paste has a field this loader does not know (“${k}”) — nothing was loaded.`);
    }
  }
  for (const k of allowed) {
    if (optional.has(k)) continue;
    if (!(k in r)) {
      return fail(`That paste is missing the “${k}” field — nothing was loaded.`);
    }
  }
  if (r.kind !== "playground-year" || r.version !== 1) {
    return fail("That paste is not a Playground inputs payload — nothing was loaded.");
  }
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const money = (k: string, allowNegative = false): number | null => {
    const n = num(r[k]);
    if (n == null || (!allowNegative && n < 0)) return null;
    return n;
  };
  const taxYear = num(r.taxYear);
  if (taxYear == null || !Number.isInteger(taxYear) || taxYear < 1900 || taxYear > 2200) {
    return fail("That paste’s tax year is not a valid year — nothing was loaded.");
  }
  if (r.filingStatus !== "mfj" && r.filingStatus !== "single" && r.filingStatus !== "hoh") {
    return fail("That paste’s filing status is not one this loader knows — nothing was loaded.");
  }
  const agePrimary = num(r.agePrimary);
  if (agePrimary == null || !Number.isInteger(agePrimary) || agePrimary < 0 || agePrimary > 120) {
    return fail("That paste’s age is not a valid age — nothing was loaded.");
  }
  let ageSpouse: number | null = null;
  if (r.ageSpouse !== null) {
    const n = num(r.ageSpouse);
    if (n == null || !Number.isInteger(n) || n < 0 || n > 120) {
      return fail("That paste’s spouse age is not a valid age — nothing was loaded.");
    }
    ageSpouse = n;
  }
  if (typeof r.onMedicarePrimary !== "boolean" || typeof r.onMedicareSpouse !== "boolean") {
    return fail("That paste’s Medicare flags are not yes/no values — nothing was loaded.");
  }
  if (typeof r.spouseSoleBeneficiary !== "boolean") {
    return fail("That paste’s sole-beneficiary flag is not a yes/no value — nothing was loaded.");
  }
  /* The reciprocal beneficiary fact is optional (N-1): a
     paste written before the payload carried it has no
     such key and loads with it absent — not established,
     so the spouse's RMD prices on the Uniform Lifetime
     Table, exactly as before; a present value must be a
     yes/no value or null (unset). */
  let primarySoleBeneficiaryOfSpouse: boolean | null = null;
  if (
    r.primarySoleBeneficiaryOfSpouse !== null &&
    r.primarySoleBeneficiaryOfSpouse !== undefined
  ) {
    if (typeof r.primarySoleBeneficiaryOfSpouse !== "boolean") {
      return fail("That paste’s reciprocal-beneficiary flag is not a yes/no value — nothing was loaded.");
    }
    primarySoleBeneficiaryOfSpouse = r.primarySoleBeneficiaryOfSpouse;
  }
  const interest = money("interest");
  const ordinaryDividends = money("ordinaryDividends");
  const otherOrdinary = money("otherOrdinary", true);
  const taxExemptInterest = money("taxExemptInterest");
  const ssPrimary = money("ssPrimary");
  const ssSpouse = money("ssSpouse");
  const conversion = money("conversion");
  const stockSold = money("stockSold");
  const stockBasis = money("stockBasis");
  const qualifiedDividends = money("qualifiedDividends");
  if (
    interest == null || ordinaryDividends == null || otherOrdinary == null ||
    taxExemptInterest == null || ssPrimary == null || ssSpouse == null ||
    conversion == null || stockSold == null || stockBasis == null ||
    qualifiedDividends == null
  ) {
    return fail("That paste has an amount that is not a valid dollar figure — nothing was loaded.");
  }
  let pretaxBalance: number | null = null;
  if (r.pretaxBalance !== null) {
    const n = num(r.pretaxBalance);
    if (n == null || n < 0) {
      return fail("That paste’s pre-tax balance is not a valid dollar figure — nothing was loaded.");
    }
    pretaxBalance = n;
  }
  /* The spouse's balance is optional (a paste written before
     the split-balance build carries no such key): absent
     parses as null — no spouse balance, no spouse RMD. */
  let pretaxBalanceSpouse: number | null = null;
  if (r.pretaxBalanceSpouse !== null && r.pretaxBalanceSpouse !== undefined) {
    const n = num(r.pretaxBalanceSpouse);
    if (n == null || n < 0) {
      return fail("That paste’s spouse pre-tax balance is not a valid dollar figure — nothing was loaded.");
    }
    pretaxBalanceSpouse = n;
  }
  let acaHouseholdSize: number | null = null;
  if (r.acaHouseholdSize !== null) {
    const n = num(r.acaHouseholdSize);
    if (n == null || !Number.isInteger(n) || n < 1 || n > 20) {
      return fail("That paste’s ACA household size is not a valid size — nothing was loaded.");
    }
    acaHouseholdSize = n;
  }
  let acaBenchmarkAnnual: number | null = null;
  if (r.acaBenchmarkAnnual !== null) {
    const n = num(r.acaBenchmarkAnnual);
    if (n == null || n < 0) {
      return fail("That paste’s benchmark premium is not a valid dollar figure — nothing was loaded.");
    }
    acaBenchmarkAnnual = n;
  }
  /* The ACA reconciliation facts are optional (S-1): a paste
     written before they existed carries neither key and
     loads with both absent — no filing settlement priced,
     exactly as before; absent or null parses as null, and a
     value must be a valid non-negative dollar figure. */
  let aptcTaken: number | null = null;
  if (r.aptcTaken !== null && r.aptcTaken !== undefined) {
    const n = num(r.aptcTaken);
    if (n == null || n < 0) {
      return fail("That paste’s advance credit taken is not a valid dollar figure — nothing was loaded.");
    }
    aptcTaken = n;
  }
  let acaCoverageReduction: number | null = null;
  if (r.acaCoverageReduction !== null && r.acaCoverageReduction !== undefined) {
    const n = num(r.acaCoverageReduction);
    if (n == null || n < 0) {
      return fail("That paste’s coverage-month reduction is not a valid dollar figure — nothing was loaded.");
    }
    acaCoverageReduction = n;
  }
  /* The enrollment premium is optional the same way
     (P-M3): a paste written before the payload carried
     it has no such key and loads with it absent — no cap
     on the settlement credit, exactly as before; absent
     or null parses as unset, and a value must be a valid
     non-negative dollar figure. Like its S-1 siblings it
     returns as undefined when unset (its engine input
     spelling). */
  let acaEnrollmentPremiumAnnual: number | null = null;
  if (
    r.acaEnrollmentPremiumAnnual !== null &&
    r.acaEnrollmentPremiumAnnual !== undefined
  ) {
    const n = num(r.acaEnrollmentPremiumAnnual);
    if (n == null || n < 0) {
      return fail("That paste’s enrollment premium is not a valid dollar figure — nothing was loaded.");
    }
    acaEnrollmentPremiumAnnual = n;
  }
  /* The December-only pricing facts are optional (S-2): a
     paste written before they existed carries none of the
     six keys and loads with them all absent — no carry-in
     netted, no RMD netted, no dependent MAGI added, exactly
     as before; absent or null parses as unset, and a value
     must be a valid non-negative dollar figure. The four
     carry-ins return as undefined when unset (their engine
     input spelling); the RMD received and the dependent
     MAGI return as null (theirs). */
  const optMoney = (
    k: string,
    label: string,
  ): { ok: true; value: number | null } | { ok: false; error: string } => {
    if (r[k] === null || r[k] === undefined) return { ok: true, value: null };
    const n = num(r[k]);
    if (n == null || n < 0) {
      return {
        ok: false,
        error: `That paste’s ${label} is not a valid dollar figure — nothing was loaded.`,
      };
    }
    return { ok: true, value: n };
  };
  const carryInStP = optMoney("capitalLossCarryInSt", "short-term loss carried in");
  if (!carryInStP.ok) return carryInStP;
  const carryInLtP = optMoney("capitalLossCarryInLt", "long-term loss carried in");
  if (!carryInLtP.ok) return carryInLtP;
  const carryInStWaP = optMoney("capitalLossCarryInStWa", "Washington part of the short-term loss carried in");
  if (!carryInStWaP.ok) return carryInStWaP;
  const carryInLtWaP = optMoney("capitalLossCarryInLtWa", "Washington part of the long-term loss carried in");
  if (!carryInLtWaP.ok) return carryInLtWaP;
  const rmdReceivedP = optMoney("rmdAlreadyReceived", "RMD already received");
  if (!rmdReceivedP.ok) return rmdReceivedP;
  const dependentMagiP = optMoney("dependentMagiForAca", "dependent MAGI");
  if (!dependentMagiP.ok) return dependentMagiP;
  /* The cash and Roth funding draws are optional (S-6): a
     paste written before they existed carries neither key
     and loads with both absent — no funding counted,
     exactly as before; absent or null parses as unset, and
     a value must be a valid non-negative dollar figure.
     Like the S-2 facts they return as undefined when unset
     (their engine input spelling). */
  const cashDrawP = optMoney("cashDraw", "cash drawn for spending");
  if (!cashDrawP.ok) return cashDrawP;
  const rothDrawP = optMoney("rothDraw", "Roth drawn for spending");
  if (!rothDrawP.ok) return rothDrawP;
  /* The pre-tax spending draw is optional the same way
     (R3-M1): a paste written before the payload carried
     it has no such key and loads with it absent — no draw
     counted, exactly as before; absent or null parses as
     unset, and a value must be a valid non-negative
     dollar figure. Like the S-6 draws it returns as
     undefined when unset (its engine input spelling). */
  const spendingDrawP = optMoney("spendingDraw", "pre-tax draw for spending");
  if (!spendingDrawP.ok) return spendingDrawP;
  /* The itemized deduction components are optional the
     same way (P-M2): a paste written before the payload
     carried them has none of the four keys and loads with
     them all absent — no itemized amounts entered, so the
     year prices on the standard side, exactly as before;
     absent or null parses as unset, and a value must be a
     valid non-negative dollar figure. Like the S-2 facts
     they return as undefined when unset (their engine
     input spelling). */
  const itemizedMortgageP = optMoney(
    "itemizedMortgageInterest",
    "mortgage interest",
  );
  if (!itemizedMortgageP.ok) return itemizedMortgageP;
  const itemizedSaltP = optMoney("itemizedSaltPaid", "state and local taxes paid");
  if (!itemizedSaltP.ok) return itemizedSaltP;
  const itemizedCharitableP = optMoney(
    "itemizedCharitable",
    "charitable contributions",
  );
  if (!itemizedCharitableP.ok) return itemizedCharitableP;
  const itemizedOtherP = optMoney("itemizedOther", "other itemized deductions");
  if (!itemizedOtherP.ok) return itemizedOtherP;
  /* The annual spending is optional the same way (P-S2):
     a paste written before the payload carried it has no
     such key and loads with it absent — no spending
     carried, so the loader resolves the comparison's
     spending exactly as before; absent or null parses as
     unset, and a value must be a valid non-negative
     dollar figure. Like the S-2 facts it returns as
     undefined when unset (its engine input spelling). */
  const annualSpendingP = optMoney("annualSpending", "annual spending");
  if (!annualSpendingP.ok) return annualSpendingP;
  /* The gain-harvest facts are optional the same way
     (P-S3): a paste written before the payload carried
     them has neither key and loads with both absent —
     no harvest priced, exactly as before; absent or
     null parses as unset, the pool must be a valid
     non-negative dollar figure, and the basis must be
     a percent within 0–100 (the December console's own
     bounds on the same facts; the pricer clamps what
     reaches it, but a paste states the fact, so an
     out-of-range percent refuses the whole paste like
     any other invalid field). Like the S-2 facts they
     return as undefined when unset (their engine input
     spelling) — the pricer sizes a harvest only when
     BOTH return present. */
  const harvestPoolP = optMoney("harvestPoolAmount", "harvest pool");
  if (!harvestPoolP.ok) return harvestPoolP;
  let harvestPoolBasisPct: number | undefined;
  if (r.harvestPoolBasisPct !== null && r.harvestPoolBasisPct !== undefined) {
    const n = num(r.harvestPoolBasisPct);
    if (n == null || n < 0 || n > 100) {
      return fail("That paste’s harvest basis is not a valid percent — nothing was loaded.");
    }
    harvestPoolBasisPct = n;
  }
  /* The reinvested-yield fact is optional (S-3): a paste
     written before it existed carries no such key and loads
     with it absent — the yield counts as cash in, exactly
     as before; a present value must be a yes/no value. */
  let yieldReinvested = false;
  if (r.yieldReinvested !== null && r.yieldReinvested !== undefined) {
    if (typeof r.yieldReinvested !== "boolean") {
      return fail("That paste’s reinvested-yield flag is not a yes/no value — nothing was loaded.");
    }
    yieldReinvested = r.yieldReinvested;
  }
  /* The inflation rate is optional (S-4): a paste written
     before it existed carries no such key and loads with
     it absent — statute-fixed amounts undeflated, exactly
     as before; absent or null parses as unset, and a value
     must be a finite percent above −100 (the deflation
     factor's domain). Like the S-2 / S-3 facts it returns
     as undefined when unset, so the round-trip identity
     holds. */
  let inflationPct: number | undefined;
  if (r.inflationPct !== null && r.inflationPct !== undefined) {
    const n = num(r.inflationPct);
    if (n == null || n <= -100) {
      return fail("That paste’s inflation rate is not a valid percent — nothing was loaded.");
    }
    inflationPct = n;
  }
  /* The health premium inputs are optional (a paste written
     before the health premium build carries neither key):
     absent or null parses as null — no premium priced,
     exactly as before; a value must be a valid non-negative
     dollar figure. */
  let healthPremiumAcaAnnual: number | null = null;
  if (r.healthPremiumAcaAnnual !== null && r.healthPremiumAcaAnnual !== undefined) {
    const n = num(r.healthPremiumAcaAnnual);
    if (n == null || n < 0) {
      return fail("That paste’s marketplace premium is not a valid dollar figure — nothing was loaded.");
    }
    healthPremiumAcaAnnual = n;
  }
  let healthPremiumMedicarePerPerson: number | null = null;
  if (
    r.healthPremiumMedicarePerPerson !== null &&
    r.healthPremiumMedicarePerPerson !== undefined
  ) {
    const n = num(r.healthPremiumMedicarePerPerson);
    if (n == null || n < 0) {
      return fail("That paste’s Medicare premium is not a valid dollar figure — nothing was loaded.");
    }
    healthPremiumMedicarePerPerson = n;
  }
  /* The IRMAA surcharge payable this year is optional
     (internal review round 3 SHOULD-2): a paste written
     before it was carried carries no such key and loads
     with it absent — no payable IRMAA charged, exactly as
     before; absent or null parses as null, and a value must
     be a valid non-negative dollar figure. */
  let irmaaPayableAnnual: number | null = null;
  if (
    r.irmaaPayableAnnual !== null &&
    r.irmaaPayableAnnual !== undefined
  ) {
    const n = num(r.irmaaPayableAnnual);
    if (n == null || n < 0) {
      return fail("That paste’s IRMAA surcharge is not a valid dollar figure — nothing was loaded.");
    }
    irmaaPayableAnnual = n;
  }
  const stateRatePct = num(r.stateRatePct);
  if (stateRatePct == null || stateRatePct < 0 || stateRatePct > 100) {
    return fail("That paste’s state rate is not a valid percent — nothing was loaded.");
  }
  // residenceState (cold-AI audit fix): absent (an older
  // paste) or null prices the flat rate, exactly as before;
  // "WA" / "other" carry through; anything else refuses.
  let residenceState: "WA" | "other" | null = null;
  if ("residenceState" in r && r.residenceState !== null && r.residenceState !== undefined) {
    if (r.residenceState !== "WA" && r.residenceState !== "other") {
      return fail("That paste’s state of residence is not one this loader knows — nothing was loaded.");
    }
    residenceState = r.residenceState;
  }
  // educationStudents (cold-AI audit fix): absent (an older
  // paste) or null prices no students, exactly as before; a
  // list carries through entry by entry after the same
  // validation the action schema applies (at most 12
  // students, expenses a valid non-negative dollar figure,
  // the eligibility mark a yes/no value); anything else
  // refuses the whole paste.
  let educationStudents: EducationStudent[] | null = null;
  if (
    "educationStudents" in r &&
    r.educationStudents !== null &&
    r.educationStudents !== undefined
  ) {
    if (!Array.isArray(r.educationStudents) || r.educationStudents.length > 12) {
      return fail("That paste’s education students are not a valid list — nothing was loaded.");
    }
    const parsedStudents: EducationStudent[] = [];
    for (const entry of r.educationStudents) {
      if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
        return fail("That paste’s education students are not a valid list — nothing was loaded.");
      }
      const e = entry as Record<string, unknown>;
      const exp = num(e.expenses);
      if (exp == null || exp < 0 || typeof e.aotcEligible !== "boolean") {
        return fail("That paste’s education students are not a valid list — nothing was loaded.");
      }
      parsedStudents.push({ expenses: exp, aotcEligible: e.aotcEligible });
    }
    educationStudents = parsedStudents;
  }
  return {
    ok: true,
    inputs: {
      taxYear,
      filingStatus: r.filingStatus,
      agePrimary,
      ageSpouse,
      onMedicarePrimary: r.onMedicarePrimary,
      onMedicareSpouse: r.onMedicareSpouse,
      interest,
      ordinaryDividends,
      otherOrdinary,
      taxExemptInterest,
      ssPrimary,
      ssSpouse,
      conversion,
      stockSold,
      stockBasis,
      qualifiedDividends,
      pretaxBalance,
      pretaxBalanceSpouse,
      spouseSoleBeneficiary: r.spouseSoleBeneficiary,
      acaHouseholdSize,
      acaBenchmarkAnnual,
      /* The optional money facts (the S-1 settlement facts
         and the S-2 December-only facts) spell "unset" as undefined
         in the parsed inputs, never null: a JSON round-trip
         drops undefined keys, so a paste of a year where the
         fact was never entered parses back to inputs identical
         to the ones that produced it — the identity the
         round-trip fixtures pin. The engine reads absent,
         undefined, and null identically for every one of them. */
      aptcTaken: aptcTaken ?? undefined,
      acaCoverageReduction: acaCoverageReduction ?? undefined,
      acaEnrollmentPremiumAnnual: acaEnrollmentPremiumAnnual ?? undefined,
      healthPremiumAcaAnnual,
      healthPremiumMedicarePerPerson,
      irmaaPayableAnnual,
      capitalLossCarryInSt: carryInStP.value ?? undefined,
      capitalLossCarryInLt: carryInLtP.value ?? undefined,
      capitalLossCarryInStWa: carryInStWaP.value ?? undefined,
      capitalLossCarryInLtWa: carryInLtWaP.value ?? undefined,
      rmdAlreadyReceived: rmdReceivedP.value ?? undefined,
      dependentMagiForAca: dependentMagiP.value ?? undefined,
      /* The cash and Roth funding draws (S-6) join the same
         spelling: unset is undefined in the parsed inputs,
         never null, so a paste of a year with no funding
         entered parses back to inputs identical to the ones
         that produced it. */
      cashDraw: cashDrawP.value ?? undefined,
      rothDraw: rothDrawP.value ?? undefined,
      /* The pre-tax spending draw (R3-M1) joins the same
         spelling: unset is undefined in the parsed inputs,
         never null, so a paste of a year with no draw
         entered parses back to inputs identical to the
         ones that produced it. */
      spendingDraw: spendingDrawP.value ?? undefined,
      /* The itemized deduction components (P-M2) join the
         same spelling: unset is undefined in the parsed
         inputs, never null, so a paste of a year with no
         itemized amounts entered parses back to inputs
         identical to the ones that produced it. */
      itemizedMortgageInterest: itemizedMortgageP.value ?? undefined,
      itemizedSaltPaid: itemizedSaltP.value ?? undefined,
      itemizedCharitable: itemizedCharitableP.value ?? undefined,
      itemizedOther: itemizedOtherP.value ?? undefined,
      /* The annual spending (P-S2) joins the same
         spelling: unset is undefined in the parsed inputs,
         never null, so a paste of a year priced with no
         spending parses back to inputs identical to the
         ones that produced it; a carried figure returns
         whole, so the parsed inputs price the same
         "enough for the year" verdict the copied year
         priced. */
      annualSpending: annualSpendingP.value ?? undefined,
      /* The gain-harvest facts (P-S3) join the same
         spelling: unset is undefined in the parsed
         inputs, never null, so a paste of a year priced
         with no harvest parses back to inputs identical
         to the ones that produced it; a carried pair
         returns whole, so the parsed inputs size the
         same harvest the copied year priced. */
      harvestPoolAmount: harvestPoolP.value ?? undefined,
      harvestPoolBasisPct,
      /* The reciprocal beneficiary fact (N-1) joins the
         same spelling: unset is undefined in the parsed
         inputs, never null, so a paste of a year where the
         fact was never established parses back to inputs
         identical to the ones that produced it; the engine
         reads absent, undefined, and null identically. */
      primarySoleBeneficiaryOfSpouse:
        primarySoleBeneficiaryOfSpouse ?? undefined,
      /* The reinvested-yield flag (S-3) joins the same
         spelling: "off" is undefined in the parsed inputs,
         so a paste of a year where the flag was never set
         parses back to inputs identical to the ones that
         produced it; the engine reads absent and false
         identically. */
      yieldReinvested: yieldReinvested ? true : undefined,
      /* The inflation rate (S-4) joins the same spelling:
         unset is undefined in the parsed inputs, never
         null, so a paste of a year priced without a rate
         parses back to inputs identical to the ones that
         produced it. */
      inflationPct,
      stateRatePct,
      residenceState,
      educationStudents,
    },
  };
}

/* Server-side balance resolution for the plan-level compute
   actions, mirroring the client's following-the-snapshot rule
   exactly (see the init effect in RothConversion.tsx): a balance
   the caller passed explicitly is used as-is; a null balance
   resolves from the latest Net Worth snapshot's bucket subtotals
   (all in cents) — Pre-tax from the Pre-tax bucket (less the
   spouse's own saved split, which lands in her field), Roth from
   the Roth bucket, Taxable from the Taxable and Cash buckets
   together (null only when neither has a split), HSA from the
   HSA bucket. Taxable alone carries one further adjustment: a
   saved taxableExcludeCents is subtracted from that followed
   pool (floored at $0) — see the field note on RothSavedLike. A null snapshot (or an unsplit bucket) leaves the
   field null, which the plan builder prices as $0 — exactly the
   client's behavior on an unsplit snapshot. Pure: the caller
   supplies the subtotals, so the fixtures pin this exact code. */
export type PlanBalanceSnapshotCents = {
  pretaxCents: number | null;
  rothCents: number | null;
  taxableCents: number | null;
  cashCents: number | null;
  hsaCents: number | null;
};
export type PlanBalanceFields = {
  pretaxCents: number | null;
  pretaxSpouseCents: number | null;
  rothCents: number | null;
  taxableCents: number | null;
  // Exclude-from-plan amount (EXCLUDE-FROM-PLAN build): see
  // the field note on RothSavedLike. Optional here so every
  // pre-existing caller of this resolver keeps its meaning —
  // absent / null = no exclusion.
  taxableExcludeCents?: number | null;
  hsaCents: number | null;
};
export function resolvePlanBalances<T extends PlanBalanceFields>(
  saved: T,
  snap: PlanBalanceSnapshotCents | null,
): T {
  const snapTaxableCents =
    snap == null || (snap.taxableCents == null && snap.cashCents == null)
      ? null
      : (snap.taxableCents ?? 0) + (snap.cashCents ?? 0);
  // EXCLUDE-FROM-PLAN: the exclusion applies ONLY on the
  // snapshot-followed path (saved.taxableCents null) — an
  // explicit taxableCents override wins exactly as before and
  // the exclusion is inert beside it. The effective pool is
  // the snapshot pool (Taxable + Cash) minus the exclusion,
  // floored at $0; a negative entered amount reads as $0.
  // TIER INTERACTION (explicit choice): the exclusion is
  // subtracted HERE, against the pool, before the resolved
  // balance ever reaches planInputsFromSaved — so when basis
  // tiers are set, the tier shares are computed against the
  // already-reduced pool (each tier shrinks in proportion to
  // its share; the basis % of each tier is unchanged). In the
  // single-pool model the pool simply shrinks and
  // taxableBasisPct is unchanged.
  const excludeCents =
    saved.taxableCents == null
      ? Math.max(0, saved.taxableExcludeCents ?? 0)
      : 0;
  return {
    ...saved,
    pretaxCents:
      saved.pretaxCents ??
      (snap?.pretaxCents != null
        ? Math.max(0, snap.pretaxCents - (saved.pretaxSpouseCents ?? 0))
        : null),
    rothCents: saved.rothCents ?? snap?.rothCents ?? null,
    taxableCents:
      saved.taxableCents ??
      (snapTaxableCents == null
        ? null
        : Math.max(0, snapTaxableCents - excludeCents)),
    hsaCents: saved.hsaCents ?? snap?.hsaCents ?? null,
  };
}

/* Plan-year detail two-pricing: the plan run as given (the
   `with` row) and the same plan re-priced with the target
   year's conversion forced to $0 (the `without` row, via the
   engine's forceZeroConversionYear seam). The deltas are the
   with-row's figures minus the without-row's, taken from the
   target year only — the conversion's own price for that year:
   its federal and state tax, the IRMAA surcharge PAID that year
   (set by MAGI two years earlier, so a single year's forcing
   does not move it), and the ACA credit kept that year. The
   effective rate is the conversion's total delta cost —
   Δfederal + Δstate + ΔIRMAA − ΔACA credit (a credit the
   conversion SHRINKS adds to its cost; a credit it creates or
   grows subtracts) — over the conversion itself, in percent.
   Every figure is engine output from the two runs. */
export type PlanYearDetail = {
  targetYear: number;
  with: RothYear;
  without: RothYear;
  deltaFederal: number;
  deltaState: number;
  deltaIrmaa: number;
  deltaAcaCredit: number;
  conversionCost: number;
  effectiveRatePct: number | null;
};
export function pricePlanYearDetail(
  inputs: RothPlanInputs,
  strategy: RothStrategy,
  targetYear: number,
): PlanYearDetail | null {
  const withResult = simulateRothPlan(inputs, strategy);
  const withRow = withResult.years.find((y) => y.year === targetYear);
  if (!withRow) return null;
  const withoutResult = simulateRothPlan(inputs, strategy, undefined, {
    forceZeroConversionYear: targetYear,
  });
  const withoutRow = withoutResult.years.find((y) => y.year === targetYear);
  if (!withoutRow) return null;
  const deltaFederal = r2(withRow.federalTax - withoutRow.federalTax);
  const deltaState = r2(withRow.stateTax - withoutRow.stateTax);
  const deltaIrmaa = r2(withRow.irmaaPaid - withoutRow.irmaaPaid);
  const deltaAcaCredit = r2(withRow.acaCreditKept - withoutRow.acaCreditKept);
  const conversionCost = r2(deltaFederal + deltaState + deltaIrmaa - deltaAcaCredit);
  return {
    targetYear,
    with: withRow,
    without: withoutRow,
    deltaFederal,
    deltaState,
    deltaIrmaa,
    deltaAcaCredit,
    conversionCost,
    effectiveRatePct:
      withRow.conversion > 0
        ? r2((conversionCost / withRow.conversion) * 100)
        : null,
  };
}

/* ---------------- Year funding (YEAR FUNDING build) ----------
   The funding ledger for a whole plan: one row per priced
   year, in integer cents, built from the engine's own settled
   funding capture (RothYear.funding in taxEngine.ts — the
   settlement internals, attributed under the waterfall that
   type documents). This layer only converts units and adds
   the deep-view context the row already carries (MAGI / ACA
   MAGI against the year's cliff, the premium credit kept,
   taxable income and the landing bracket, the income-stack
   pieces the detail priced). It prices nothing of its own:
   the rows come from ONE simulateRothPlan run of the plan
   exactly as given, with the given fixed strategy.
   CASH IDENTITY: for every row, the thirteen source fields plus
   spendShortfallCents plus unpaidTaxCents sum to the four
   need fields (totalNeedCents) — totalNeedCents includes the
   full assessed tax, spendShortfallCents is spending-only,
   and unpaidTaxCents (round-5 fix 1) is the part of the tax
   bill the balances could not pay, so an insolvent-tax year
   now foots exactly instead of footing short by an amount
   no field carried. spendShortfallCents is the year's
   unfunded SPENDING (the engine's RothYearFunding
   .spendShortfall, in cents): $0 in every year the plan can
   fund, so for funded years the sources alone sum to the
   needs exactly as before. Dollar-to-cent rounding of
   balance-limited draws can leave a residue of a few cents;
   when the residue (needs − sources − shortfall) is at most
   10 cents it is reconciled onto the row's largest source
   field (ordinary ledger cent-rounding — a missing flow
   would be dollars, not cents, and a larger residue is left
   standing so the accuracy fixtures fail on it honestly).
   The shortfall itself is never reconciled into a source:
   it is a need the year's balances could not meet, not a
   flow. */

export type RothFundingRow = {
  year: number;
  agePrimary: number;
  ageSpouse: number | null;
  // Needs (integer cents).
  spendingCents: number;
  federalTaxCents: number;
  stateTaxCents: number;
  irmaaCents: number;
  // Health premium (build v208): the year's NET health
  // premium as its own need (the engine's
  // RothYearFunding.healthPremium). spendingCents EXCLUDES
  // it, and totalNeedCents includes it, so the cash
  // identity foots exactly as before. $0 in every year of
  // a plan that does not enter the health premium term.
  healthPremiumCents: number;
  // LOOKBACK AVAILABILITY + ELIGIBILITY (Engine Review 6,
  // display only): whether the year's IRMAA surcharge is
  // KNOWN (false = someone on Medicare, no lookback entry
  // for year − 2, so irmaaCents is $0 UNKNOWN, not a
  // computed $0) and whether the year's ACA MAGI is under
  // 100% FPL (credit $0 under the standard §36B income
  // test). Read off the engine's RothYear.
  irmaaSurchargeKnown: boolean;
  acaBelow100Fpl: boolean;
  // EARLY-WITHDRAWAL ELIGIBILITY UNKNOWN (Engine Review C9,
  // Build 1): true exactly when this year priced a pre-59½
  // pre-tax spending draw while the drawing owner's Rule-of-55
  // eligibility was unanswered — so the $0 penalty the row's
  // federal tax carries on that draw is UNKNOWN, not a
  // computed $0. Read off the engine's RothYear. Display only.
  earlyWithdrawalEligibilityUnknown: boolean;
  // ROTH BASIS UNKNOWN (Engine Review C9, Build 2 — W3):
  // true exactly when this year priced a Roth draw while
  // the drawing owner's Roth composition was unentered —
  // so the $0 income and $0 penalty the year shows on that
  // draw are UNKNOWN, not computed. Read off the engine's
  // RothYear. Display only.
  rothBasisUnknown: boolean;
  totalNeedCents: number;
  // Sources (integer cents, applied amounts — see the
  // RothYearFunding waterfall).
  ssCents: number;
  rmdCents: number;
  otherIncomeCents: number;
  // Tax-exempt interest applied as cash funding (a twelfth
  // source — see the RothYearFunding waterfall). $0 in every
  // year with no tax-exempt interest entered.
  taxExemptCents: number;
  interestYieldCents: number;
  dividendYieldCents: number;
  pretaxDrawCents: number;
  // The S-10 split of the year's priced pre-tax draw
  // (re-audit SHOULD S-8 surfacing; from the engine's
  // RothYearDetail, integer cents): the pre-tax draw for
  // spending alone, the pre-tax debits that paid the tax
  // bill alone, and their sum (the detail's
  // extraPreTaxDraw). Display only — none of the three is
  // a funding source and none enters the cash identity;
  // pretaxDrawCents above remains the applied pre-tax
  // funding source (it also counts conversion withholding
  // applied to the bill — see the pretaxDrawSplitSemantics
  // convention describeApi publishes).
  pretaxSpendingDrawCents: number;
  pretaxTaxDebitCents: number;
  extraPreTaxDrawCents: number;
  taxableSoldForSpendingCents: number;
  taxableSoldForTaxCents: number;
  // Spend-from-cash: the part of the year's spending need the
  // pool's cash sleeve paid (one of the thirteen sources — see the
  // RothYearFunding waterfall in taxEngine.ts). $0 in every
  // year unless the plan sets spendFromCashPct.
  cashSpendCents: number;
  rothDrawCents: number;
  // HSA DRAW (Engine Review C9, Build 4 — W2-D1): the HSA
  // amount applied to the year's tax bill, in integer cents
  // (the engine's RothYearFunding.hsaDraw) — the
  // last-resort leg of the settlement's tax-payment debit
  // chain. A source: it is money actually applied to the
  // bill. $0 in every year whose earlier legs cover the
  // bill. The distribution is ordinary income (see
  // hsaTaxDebitCents below) and, before 65, carries the
  // §223(f)(4) 20% additional tax — priced by the leg's
  // gross-up and scored inside federalTaxCents beside it,
  // so the cash identity still foots exactly.
  hsaDrawCents: number;
  // HSA TAX DEBIT (Engine Review C9, Build 4 — W2-D1): the
  // HSA debits that paid the tax bill alone, in integer
  // cents (the detail's hsaTaxDebit — the same distribution
  // hsaDrawCents carries as a source). Display only — not
  // a second source and not part of the cash identity; the
  // HSA has no spending draw, so the two are equal by
  // construction (if an HSA spending draw is ever added,
  // they diverge: the draw would carry the spending part).
  hsaTaxDebitCents: number;
  salarySurplusCents: number;
  // SPEND SHORTFALL (FIX 3): the year's unfunded spending in
  // integer cents — the spending need left after cash income,
  // the tax channels' prior claim on balances, the cash
  // sleeve, and the draw-order draws (the engine's
  // RothYearFunding.spendShortfall). Not a source and not a
  // need: sources + spendShortfallCents foot to
  // totalNeedCents (see the CASH IDENTITY note above). $0 in
  // every year the plan can fund. Spending only — unpaid tax
  // is a different quantity and is not included.
  spendShortfallCents: number;
  // UNPAID TAX (round-5 fix 1): the year's priced tax the
  // balances could not pay, in integer cents (the engine's
  // RothYearFunding.unpaidTax). Not a source and not a need:
  // sources + spendShortfallCents + unpaidTaxCents foot to
  // totalNeedCents (see the CASH IDENTITY note above). $0 in
  // every year whose balances cover the tax bill.
  unpaidTaxCents: number;
  // Deep-view blocks (integer cents): the year's conversion
  // (a transfer, not a source) and the gain its harvest
  // realized by selling and immediately rebuying (proceeds
  // reinvested — neither a source nor a need).
  conversionCents: number;
  harvestSoldCents: number;
  // Deep-view context: the year's MAGI stack position.
  magiCents: number;
  acaMagiCents: number;
  acaCliffCents: number | null;
  acaCreditCents: number;
  acaPriced: boolean;
  taxableIncomeCents: number;
  bracketPct: number;
  // Income-stack pieces the detail priced (integer cents):
  // realized gains from the year's draws and tax sales, and
  // the taxable part of Social Security.
  drawGainsCents: number;
  ssTaxableCents: number;
  // Settlement convergence (LOW-1, from the engine's RothYear):
  // whether the year's kept settlement was an exact fixed
  // point of the settlement iteration, and — when it was not —
  // the kept round's residual mismatch per component in
  // integer cents (gains, pre-tax, and — Engine Review C3,
  // C3-S1 — the ACA credit residual; all 0 when converged),
  // plus how many rounds / passes the kept settlement took
  // and why each level stopped.
  settlementConverged: boolean;
  settlementMismatchCents: { gains: number; pretax: number; roth: number; hsa: number; acaCredit: number };
  settlementRounds: number;
  settlementPasses: number;
  settlementStopReason: "converged" | "repeated-assumption" | "iteration-limit";
  settlementInnerStopReason: "converged" | "repeated-assumption" | "iteration-limit";
  // Ceiling breached (round-7 R7-4, from the engine's
  // RothYear): true when a switched-on ceiling is still
  // breached by the year's final priced figures at
  // conversion $0 — the draws alone breach. See the
  // ceilingBreachedSemantics convention describeApi
  // publishes.
  ceilingBreached: boolean;
  // Capital-loss carryforward ledger (T4, from the engine's
  // RothYearDetail; integer cents): the loss carried into
  // the year by character, the part this year's gains
  // absorbed, the §1211(b) allowance priced, and the loss
  // carried out into the next year by character. All 0 in
  // every year of a plan with no entering carryforward.
  lossCarryInStCents: number;
  lossCarryInLtCents: number;
  lossAbsorbedCents: number;
  lossAllowanceCents: number;
  lossCarryOutStCents: number;
  lossCarryOutLtCents: number;
  // Itemized-vs-standard (T5, from the engine's
  // RothYearDetail): the year's itemized total after the
  // §164(b)(7) SALT cap, in integer cents, and which side
  // of the greater-of comparison the year's deduction
  // took. 0 / "standard" in every year of a plan with no
  // itemized inputs.
  itemizedDeductionCents: number;
  deductionTaken: "standard" | "itemized";
  // 2026 deduction trio (from the engine's RothYearDetail;
  // integer cents): the charitable amount allowed inside
  // the itemized total after the §170(b)(1)(I) floor, the
  // §68 reduction taken off the itemized total, and the
  // §170(p) non-itemizer charitable deduction applied
  // below the line (§63(b)(4): inside the deductions
  // figure; magiCents / acaMagiCents are NOT reduced by
  // it; it is
  // not a funding source or need and never enters the
  // cash identity). All 0 under the 2025 law row.
  itemizedCharitableAllowedCents: number;
  section68ReductionCents: number;
  nonItemizerCharitableDeductionCents: number;
  // Education credits (T6, from the engine's RothYear /
  // RothYearDetail; integer cents): the year's refundable
  // AOTC portion (credited in the plan score, not a
  // funding source or need — it never enters the cash
  // identity, exactly as acaCreditCents does not), the
  // tentative AOTC and Lifetime Learning Credit after
  // their phase-outs, the nonrefundable portion applied
  // (already inside federalTaxCents — the year's federal
  // tax NEED is net of it), and the choice taken. All 0 /
  // "none" in every year with no entered expenses.
  educationRefundableCents: number;
  educationAotcCents: number;
  educationLlcCents: number;
  educationNonrefundableCents: number;
  educationChoice: "aotc" | "llc" | "none";
  // Alternative minimum tax (T7, from the engine's
  // RothYearDetail; integer cents): the year's AMTI, the
  // §55(d) exemption after its phase-out, the tentative
  // minimum tax, and the AMT owed — already inside
  // federalTaxCents (the year's federal tax NEED includes
  // it), so these lines name the component and never
  // enter the cash identity a second time. amtOwedCents
  // is 0 in every year with no AMT exposure.
  amtiCents: number;
  amtExemptionCents: number;
  amtTentativeTaxCents: number;
  amtOwedCents: number;
};

export function buildRothFunding(
  inputs: RothPlanInputs,
  strategy: RothStrategy,
): RothFundingRow[] {
  const result = simulateRothPlan(inputs, strategy);
  const cents = (dollars: number): number => Math.round(dollars * 100);
  return result.years.map((y) => {
    const f = y.funding;
    const row: RothFundingRow = {
      year: y.year,
      agePrimary: y.agePrimary,
      ageSpouse: y.ageSpouse,
      spendingCents: cents(f.spending),
      federalTaxCents: cents(f.federalTax),
      stateTaxCents: cents(f.stateTax),
      irmaaCents: cents(f.irmaa),
      healthPremiumCents: cents(f.healthPremium),
      irmaaSurchargeKnown: y.irmaaSurchargeKnown,
      acaBelow100Fpl: y.acaBelow100Fpl,
      earlyWithdrawalEligibilityUnknown: y.earlyWithdrawalEligibilityUnknown,
      rothBasisUnknown: y.rothBasisUnknown,
      totalNeedCents: 0,
      ssCents: cents(f.ss),
      rmdCents: cents(f.rmd),
      otherIncomeCents: cents(f.otherIncome),
      taxExemptCents: cents(f.taxExempt),
      interestYieldCents: cents(f.interestYield),
      dividendYieldCents: cents(f.dividendYield),
      pretaxDrawCents: cents(f.pretaxDraw),
      pretaxSpendingDrawCents: cents(y.detail.pretaxSpendingDraw),
      pretaxTaxDebitCents: cents(y.detail.pretaxTaxDebit),
      extraPreTaxDrawCents: cents(y.detail.extraPreTaxDraw),
      taxableSoldForSpendingCents: cents(f.taxableSoldForSpending),
      taxableSoldForTaxCents: cents(f.taxableSoldForTax),
      cashSpendCents: cents(f.cashSpend),
      rothDrawCents: cents(f.rothDraw),
      hsaDrawCents: cents(f.hsaDraw),
      hsaTaxDebitCents: cents(y.detail.hsaTaxDebit),
      salarySurplusCents: cents(f.salarySurplus),
      spendShortfallCents: cents(f.spendShortfall),
      unpaidTaxCents: cents(f.unpaidTax),
      conversionCents: cents(f.conversion),
      harvestSoldCents: cents(f.harvestSold),
      magiCents: cents(y.magi),
      acaMagiCents: cents(y.acaMagi),
      acaCliffCents: y.detail.aca.cliff == null ? null : cents(y.detail.aca.cliff),
      acaCreditCents: cents(y.acaCreditKept),
      acaPriced: y.acaPriced,
      taxableIncomeCents: cents(y.taxableIncome),
      bracketPct: y.bracketPct,
      drawGainsCents: cents(y.detail.drawGains),
      ssTaxableCents: cents(y.detail.ssTaxable),
      settlementConverged: y.settlementConverged,
      settlementMismatchCents: y.settlementMismatchCents,
      settlementRounds: y.settlementRounds,
      settlementPasses: y.settlementPasses,
      settlementStopReason: y.settlementStopReason,
      settlementInnerStopReason: y.settlementInnerStopReason,
      ceilingBreached: y.ceilingBreached,
      lossCarryInStCents: cents(y.detail.lossCarryInSt),
      lossCarryInLtCents: cents(y.detail.lossCarryInLt),
      lossAbsorbedCents: cents(y.detail.lossAbsorbed),
      lossAllowanceCents: cents(y.detail.lossAllowance),
      lossCarryOutStCents: cents(y.detail.lossCarryOutSt),
      lossCarryOutLtCents: cents(y.detail.lossCarryOutLt),
      itemizedDeductionCents: cents(y.detail.itemizedDeduction),
      deductionTaken: y.detail.deductionTaken,
      itemizedCharitableAllowedCents: cents(y.detail.itemizedCharitableAllowed),
      section68ReductionCents: cents(y.detail.section68Reduction),
      nonItemizerCharitableDeductionCents: cents(y.detail.nonItemizerCharitableDeduction),
      educationRefundableCents: cents(y.educationRefundable),
      educationAotcCents: cents(y.detail.educationAotc),
      educationLlcCents: cents(y.detail.educationLlc),
      educationNonrefundableCents: cents(y.detail.educationNonrefundable),
      educationChoice: y.detail.educationChoice,
      amtiCents: cents(y.detail.amti),
      amtExemptionCents: cents(y.detail.amtExemption),
      amtTentativeTaxCents: cents(y.detail.amtTentativeTax),
      amtOwedCents: cents(y.detail.amtOwed),
    };
    row.totalNeedCents =
      row.spendingCents +
      row.federalTaxCents +
      row.stateTaxCents +
      row.irmaaCents +
      row.healthPremiumCents;
    const sourceKeys = [
      "ssCents",
      "rmdCents",
      "otherIncomeCents",
      "taxExemptCents",
      "interestYieldCents",
      "dividendYieldCents",
      "pretaxDrawCents",
      "taxableSoldForSpendingCents",
      "taxableSoldForTaxCents",
      "cashSpendCents",
      "rothDrawCents",
      "hsaDrawCents",
      "salarySurplusCents",
    ] as const;
    const sourcesTotal = sourceKeys.reduce((s, k) => s + row[k], 0);
    // The shortfall and the unpaid tax are part of the
    // identity, never part of the residue: an unfunded year
    // foots as sources + spendShortfallCents + unpaidTaxCents
    // = totalNeedCents, and only the cent-rounding remainder
    // is reconciled onto a source. (Before round-5 fix 1 the
    // unpaid tax WAS part of this residue: a small unpaid
    // remainder — even a single cent — was absorbed onto the
    // largest source field, presenting the tax as paid.)
    const residue =
      row.totalNeedCents -
      sourcesTotal -
      row.spendShortfallCents -
      row.unpaidTaxCents;
    if (residue !== 0 && Math.abs(residue) <= 10) {
      let largest: (typeof sourceKeys)[number] = sourceKeys[0];
      for (const k of sourceKeys) {
        if (Math.abs(row[k]) > Math.abs(row[largest])) largest = k;
      }
      row[largest] += residue;
    }
    return row;
  });
}

export function planInputsFromSaved(
  saved: RothSavedLike,
  startYear: number,
): RothPlanInputs | null {
  if (saved.birthYearPrimary == null) return null;
  const dollars = (cents: number | null) => (cents == null ? 0 : cents / 100);
  const retirementAge = saved.retirementAge ?? 57;
  const birthYearPrimary = saved.birthYearPrimary;
  const planInputs: RothPlanInputs = {
    startYear,
    birthYearPrimary,
    birthYearSpouse: saved.birthYearSpouse,
    filingStatus: saved.filingStatus ?? "mfj",
    endAgePrimary: saved.endAge ?? 95,
    pretaxStart: dollars(saved.pretaxCents),
    pretaxSpouseStart: dollars(saved.pretaxSpouseCents ?? null),
    // Rule-of-55 eligibility (Engine Review C9, Build 1):
    // the saved cents map to engine dollars; absent / null =
    // not established (the engine's null), never $0 — an
    // entered 0 stays 0 through dollars() and is a real
    // answer. Separation ages pass through as whole years.
    pretax401kEligiblePrimary:
      saved.pretax401kEligiblePrimaryCents == null
        ? null
        : dollars(saved.pretax401kEligiblePrimaryCents),
    pretax401kEligibleSpouse:
      saved.pretax401kEligibleSpouseCents == null
        ? null
        : dollars(saved.pretax401kEligibleSpouseCents),
    separationAgePrimary: saved.separationAgePrimary ?? null,
    separationAgeSpouse: saved.separationAgeSpouse ?? null,
    survivorEnabled: saved.survivorEnabled ?? false,
    survivorWho: saved.survivorWho ?? "primary",
    survivorDeathYear: saved.survivorDeathYear ?? null,
    survivorClaimAge: saved.survivorClaimAge ?? null,
    firstRmdDeferralPrimary: saved.firstRmdDeferralPrimary ?? undefined,
    firstRmdDeferralSpouse: saved.firstRmdDeferralSpouse ?? undefined,
    rothStart: dollars(saved.rothCents),
    // Roth IRA vs designated Roth split + Roth basis / clock
    // (Engine Review C9, Build 2 — W3): the saved cents map
    // to engine dollars; absent / null = not established
    // (the engine's null), never $0 — an entered 0 stays 0
    // through dollars() and is a real answer. The split
    // divides the followed Roth balance: the IRA share is the
    // entered rothIraCents when present, else the total less
    // the employer share; the employer share is the entered
    // rothEmployerCents when present, else $0 (the engine's
    // own fallback — the nulls here let it resolve). The
    // lots convert cents to dollars lot by lot; an entered
    // empty list stays an empty list (no prior conversions),
    // null stays null (not established). The clocks pass
    // through as whole years. No per-owner balance split is
    // carried — a saved plan always lands the split on the
    // primary (see the RothSavedLike note).
    rothIraStart:
      saved.rothIraCents == null ? null : dollars(saved.rothIraCents),
    rothEmployerStart:
      saved.rothEmployerCents == null
        ? null
        : dollars(saved.rothEmployerCents),
    rothContributionBasisPrimary:
      saved.rothContributionBasisPrimaryCents == null
        ? null
        : dollars(saved.rothContributionBasisPrimaryCents),
    rothContributionBasisSpouse:
      saved.rothContributionBasisSpouseCents == null
        ? null
        : dollars(saved.rothContributionBasisSpouseCents),
    rothConversionLotsPrimary:
      saved.rothConversionLotsPrimary == null
        ? null
        : saved.rothConversionLotsPrimary.map((l) => ({
            year: l.year,
            taxableAmount: l.taxableAmountCents / 100,
            nontaxableAmount: l.nontaxableAmountCents / 100,
          })),
    rothConversionLotsSpouse:
      saved.rothConversionLotsSpouse == null
        ? null
        : saved.rothConversionLotsSpouse.map((l) => ({
            year: l.year,
            taxableAmount: l.taxableAmountCents / 100,
            nontaxableAmount: l.nontaxableAmountCents / 100,
          })),
    firstRothYearPrimary: saved.firstRothYearPrimary ?? null,
    firstRothYearSpouse: saved.firstRothYearSpouse ?? null,
    firstDesignatedRothYearPrimary:
      saved.firstDesignatedRothYearPrimary ?? null,
    firstDesignatedRothYearSpouse:
      saved.firstDesignatedRothYearSpouse ?? null,
    taxableStart: dollars(saved.taxableCents),
    hsaStart: dollars(saved.hsaCents),
    taxableBasisPct: saved.taxableBasisPct ?? 100,
    // Blank-basis passthrough: a null saved basis % prices
    // draws exactly as before (mapped to 100 above), and the
    // flag tells the engine's gain harvest there is no basis
    // to step up, so harvesting stays inert on a blank basis.
    // Basis tiers count as an entered basis: a record carrying
    // tiers is never blank, even if its basis % field is null —
    // the tiers are the basis source.
    taxableBasisBlank:
      saved.taxableBasisPct == null &&
      !(saved.taxableTiers != null && saved.taxableTiers.length > 0),
    // Basis tiers passthrough: absent / null / empty = the
    // single pool at the basis % above, bit-identical.
    taxableTiers: saved.taxableTiers ?? null,
    // Taxable yields passthrough, with the blank-yield
    // fallback (contract v136, audit MUST M-1): an entered
    // yield prices exactly as entered — an explicit 0% is a
    // real answer and prices $0 — while a blank (absent /
    // null) field takes the threaded fallback transient when
    // one was derived from the household's stored tax-return
    // actuals, so a blank field prices the implied estimate
    // instead of $0. With no fallback threaded (no stored
    // actual for the line), a blank field stays null and the
    // engine prices $0, bit-identical to before. Every
    // pricing path (optimizer candidates, Monte Carlo check,
    // gift and work-years compares) builds its engine inputs
    // from this one construction or spreads it, so the
    // resolved yields reach every path exactly once.
    taxableDividendYieldPct:
      saved.taxableDividendYieldPct ?? saved.yieldFallbackDividendPct ?? null,
    taxableInterestYieldPct:
      saved.taxableInterestYieldPct ?? saved.yieldFallbackInterestPct ?? null,
    // Qualified-dividend share passthrough (contract v138,
    // audit SHOULD S-1): the transient threaded from the
    // stored return's actuals, passed to the engine as-is —
    // absent / null = no share implied, and the engine prices
    // 100% of the dividend yield as qualified, bit-identical
    // to before. Every pricing path builds its engine inputs
    // from this one construction or spreads it, so the split
    // reaches every path exactly once.
    taxableDividendQualifiedPct: saved.qualifiedDividendSharePct ?? null,
    // Spend-from-cash passthrough: absent / null % = blank =
    // off, bit-identical to before; the sleeve size rides the
    // transient cents field (absent / null = $0 — no snapshot
    // context, no sleeve). Every pricing path (optimizer
    // candidates, Monte Carlo check, gift and work-years
    // compares) builds its engine inputs from this one
    // construction or spreads it, so the field reaches every
    // path exactly as entered and no generated candidate can
    // drop or alter it.
    spendFromCashPct: saved.spendFromCashPct ?? null,
    spendFromCashSleeveStart: (saved.spendFromCashSleeveCents ?? 0) / 100,
    // Flexible spending passthrough: absent / null cut =
    // off, bit-identical to before; absent / null floor
    // reads as 80 inside a triggered cut. Every pricing path
    // builds its engine inputs from this one construction or
    // spreads it, so the fields reach every path exactly as
    // entered and no generated candidate can drop or alter
    // them.
    flexCutPct: saved.flexCutPct ?? null,
    flexFloorPct: saved.flexFloorPct ?? null,
    annualSpending: dollars(saved.annualSpendingCents),
    retirementAge,
    // Blank-return seed (round-4 SHOULD-3): the save/request
    // schema keeps a null return legal — "null stays the blank
    // (the caller's default applies)" — and a blank return is
    // NOT "no growth": nobody who leaves the return blank
    // means their portfolio earns 0% forever. Every client
    // path seeds the blank before pricing or saving with the
    // blended expectation of the household's stocks mix
    // (retSaved?.expectedReturnPct ?? blendedExpected(stocksPct
    // ?? STOCKS_PCT_DEFAULT)); this construction now applies
    // the SAME seed server-side, so an API caller that passes
    // the record through unseeded prices the same plan the
    // in-app paths price. An entered return — including an
    // explicit 0% — prices exactly as entered. When no mix
    // rides the record, the seed falls back to
    // blendedExpected(STOCKS_PCT_DEFAULT). Every pricing path
    // (compare, funding, march, optimizer candidates) builds
    // its engine inputs from this one construction or spreads
    // it, so the seed reaches every path exactly once.
    expectedReturnPct:
      saved.expectedReturnPct ??
      blendedExpected(saved.stocksPct ?? STOCKS_PCT_DEFAULT),
    ssPrimaryAnnual:
      saved.ssPrimaryNoBenefit === true ? 0 : dollars(saved.ssPrimaryAnnualCents),
    ssPrimaryStartAge: saved.ssPrimaryStartAge,
    ssPrimaryNoBenefit: saved.ssPrimaryNoBenefit === true,
    ssSpouseAnnual:
      saved.ssSpouseNoBenefit === true ? 0 : dollars(saved.ssSpouseAnnualCents),
    ssSpouseStartAge: saved.ssSpouseStartAge,
    ssSpouseNoBenefit: saved.ssSpouseNoBenefit === true,
    otherOrdinaryAnnual: dollars(saved.otherOrdinaryCents),
    taxExemptInterestAnnual: dollars(saved.taxExemptInterestCents),
    convertedAlreadyThisYear: dollars(saved.convertedAlreadyCents),
    windowStartAge: saved.windowStartAge ?? retirementAge,
    windowStopAge:
      saved.windowStopAge ?? Math.ceil(rmdAgeForBirthYear(birthYearPrimary)) - 1,
    payTaxFrom: saved.payTaxFrom ?? "taxable",
    protectMinTaxable: dollars(saved.protectMinTaxableCents),
    // Preserve reserve passthrough: absent / null cents = no
    // floor (engine field 0); absent / null exit rate = the
    // heir rate (today's single-rate terminal pricing).
    preservePretax: dollars(saved.preservePretaxCents ?? null),
    preserveExitRatePct: saved.preserveExitRatePct ?? saved.heirRatePct ?? DEFAULT_HEIR_RATE_PCT,
    // Claim floor passthrough: absent / null = no floor. The
    // engine never reads the field; only the joint search's
    // crowning does.
    claimAgeFloor: saved.claimAgeFloor ?? null,
    drawOrder: drawOrderFromKey(saved.drawOrder),
    // Draw-order switch passthrough: absent / null age or
    // after-order = blank = the switch is inert and the plan
    // prices bit-identically to before.
    drawOrderSwitchAge: saved.drawOrderSwitchAge ?? null,
    drawOrderAfter:
      saved.drawOrderAfter != null ? drawOrderFromKey(saved.drawOrderAfter) : null,
    spouseSoleBeneficiary: saved.spouseSoleBeneficiary ?? true,
    // Second beneficiary fact passthrough (round-3 fix):
    // absent / null = not established — the march prices the
    // spouse's RMD on the Uniform table, bit-identical to
    // before. Every pricing path builds its engine inputs
    // from this one construction or spreads it, so the fact
    // reaches every path exactly as entered.
    primarySoleBeneficiaryOfSpouse:
      saved.primarySoleBeneficiaryOfSpouse ?? null,
    acaHouseholdSize: saved.acaHouseholdSize ?? 1,
    // Household schedule passthrough (MULTI-STEP ACA HOUSEHOLD
    // SCHEDULE build): the saved schedule, resolved through
    // the one sanitizer — which also synthesizes the
    // one-entry migration schedule from a pre-build record's
    // legacy step-down pair, so an untouched legacy record
    // prices bit-identically. Absent / null / empty = no
    // steps: the initial size governs every year.
    acaHouseholdSchedule: resolveAcaHouseholdSchedule(saved),
    acaBenchmarkCouple:
      saved.acaBenchmarkCoupleCents == null ? null : saved.acaBenchmarkCoupleCents / 100,
    acaBenchmarkSingle:
      saved.acaBenchmarkSingleCents == null ? null : saved.acaBenchmarkSingleCents / 100,
    acaBenchmarkFamily:
      saved.acaBenchmarkFamilyCents == null ? null : saved.acaBenchmarkFamilyCents / 100,
    // Spouse ACA end age passthrough: absent / null = blank =
    // the engine's 65 default, bit-identical to before.
    acaSpouseEndAge: saved.acaSpouseEndAge ?? null,
    // IRMAA lookback seed passthrough (Engine Review 6,
    // E6-S1): explicitly supplied prior-year returns reach
    // the engine as dollar seeds. Entries are sanitized —
    // an integer year 1900–2200, a finite non-negative MAGI,
    // a known filing status — and a malformed entry is
    // dropped, never repaired by guessing. Absent / null /
    // empty = no supplied returns, and the march prices
    // exactly as before. Every pricing path builds its
    // engine inputs from this one construction or spreads
    // it, so the supplied returns reach every path exactly
    // once; the work-years roll's own seed (workYears.ts)
    // is built directly on RothPlanInputs and never passes
    // through this field.
    irmaaLookbackSeed:
      saved.irmaaLookbackSeedCents == null
        ? null
        : saved.irmaaLookbackSeedCents
            .filter(
              (s): s is NonNullable<typeof s> =>
                s != null &&
                Number.isInteger(s.year) &&
                s.year >= 1900 &&
                s.year <= 2200 &&
                Number.isFinite(s.magiCents) &&
                s.magiCents >= 0 &&
                (s.filingStatus === "mfj" ||
                  s.filingStatus === "single" ||
                  s.filingStatus === "hoh"),
            )
            .map((s) => ({
              year: s.year,
              magi: s.magiCents / 100,
              filingStatus: s.filingStatus,
            })),
    // Health premium term passthrough (build v208): absent /
    // null cents on all three = blank = the term is not
    // entered and the plan prices bit-identically to before.
    // Every pricing path builds its engine inputs from this
    // one construction or spreads it, so the entered amounts
    // reach every path exactly as entered.
    healthPremiumAcaHousehold:
      saved.healthPremiumAcaHouseholdCents == null
        ? null
        : saved.healthPremiumAcaHouseholdCents / 100,
    healthPremiumAcaSingle:
      saved.healthPremiumAcaSingleCents == null
        ? null
        : saved.healthPremiumAcaSingleCents / 100,
    healthPremiumMedicarePerPerson:
      saved.healthPremiumMedicarePerPersonCents == null
        ? null
        : saved.healthPremiumMedicarePerPersonCents / 100,
    inflationPct: saved.inflationPct ?? 2.5,
    stateRatePct: saved.stateRatePct ?? 0,
    // Residence passthrough (T3): absent / null / "other" =
    // the flat rate prices the state tax, bit-identical.
    residenceState: saved.residenceState ?? null,
    // Loss-carryforward passthrough (T4): absent / null
    // cents = blank = $0 entering either character, so the
    // ledger never engages and the plan prices
    // bit-identically to before. Every pricing path builds
    // its engine inputs from this one construction or
    // spreads it, so the banked loss reaches every path
    // exactly as entered.
    capitalLossCarryInSt: dollars(saved.capitalLossCarryInStCents ?? null),
    capitalLossCarryInLt: dollars(saved.capitalLossCarryInLtCents ?? null),
    // Washington-attribution passthrough (build v101):
    // absent / null cents = blank = $0 attributable on that
    // character, so the Washington base stays at the gross
    // gains and the plan prices bit-identically to before.
    capitalLossCarryInStWa: dollars(saved.capitalLossCarryInStWaCents ?? null),
    capitalLossCarryInLtWa: dollars(saved.capitalLossCarryInLtWaCents ?? null),
    // Itemized passthrough (T5): absent / null cents = blank
    // = $0 on that component, so the itemized total is $0,
    // the standard deduction wins, and the plan prices
    // bit-identically to before. Every pricing path builds
    // its engine inputs from this one construction or
    // spreads it, so the components reach every path exactly
    // as entered.
    itemizedMortgageInterest: dollars(saved.itemizedMortgageInterestCents ?? null),
    itemizedSaltPaid: dollars(saved.itemizedSaltPaidCents ?? null),
    itemizedCharitable: dollars(saved.itemizedCharitableCents ?? null),
    itemizedOther: dollars(saved.itemizedOtherCents ?? null),
    // Education passthrough (T6): absent / null = blank =
    // no entries, so no credit prices and the plan prices
    // bit-identically to before. Cents convert to engine
    // dollars entry by entry; the year and the household's
    // AOTC-eligibility mark ride verbatim. Every pricing
    // path builds its engine inputs from this one
    // construction or spreads it, so the entries reach
    // every path exactly as entered.
    educationStudents:
      saved.educationStudents == null
        ? null
        : saved.educationStudents.map((s) => ({
            year: s.year,
            expenses: s.expensesCents / 100,
            aotcEligible: s.aotcEligible === true,
          })),
    heirRatePct: saved.heirRatePct ?? DEFAULT_HEIR_RATE_PCT,
    // Transient display-layer passthrough (cents → dollars):
    // gates only the college watch-out's emission. Absent / null
    // leaves the engine field unset (unknown → never suppress).
    ...(saved.fafsaReportableAssetsCents != null
      ? { fafsaReportableAssets: saved.fafsaReportableAssetsCents / 100 }
      : {}),
    // College window passthrough: absent keys (older records)
    // convert to blank engine fields — no window, never fires.
    collegeFallFromYear: saved.collegeFallFromYear ?? null,
    collegeFallThroughYear: saved.collegeFallThroughYear ?? null,
  };
  // ACA premium reconciliation passthrough (build v135):
  // the net premium the saved annualSpending embeds, derived
  // from the built inputs by the engine's one derivation
  // (acaEmbeddedNetPremiumFor — the first ACA-active year's
  // net premium at its cliff). It is NOT a saved field: it is
  // a property of the spending figure and the plan's own
  // marketplace configuration, derived identically on every
  // pricing path that builds from this construction (optimizer
  // candidates, compare scenarios, funding, plan-year detail,
  // Monte Carlo, gift and work-years compares), so no path can
  // drop or alter it and no candidate re-derives a different
  // reference. Null (no ACA-active year with a benchmark) =
  // the field stays unset and the march funds annualSpending
  // verbatim, bit-identical to before.
  const embeddedNetPremium = acaEmbeddedNetPremiumFor(planInputs);
  if (embeddedNetPremium != null) {
    planInputs.acaEmbeddedNetPremium = embeddedNetPremium;
  }
  return planInputs;
}

/* ---------------- Engine-side scenario compare ----------------
   The compare run (the runRothCompare action) prices a list of
   NAMED scenarios against one base plan. Each scenario is a
   partial patch over the base plan's saved shape; the merged
   shape is priced as ONE FIXED strategy — its own ceilings,
   window, draw order (switch included), survivor scenario and
   claiming ages — through the same simulateRothPlan path the
   optimizer uses for a candidate. There is NO candidate search
   per scenario: the scenarios ARE the strategies, which is what
   keeps a nine-scenario compare inside one action call.

   A Do Nothing scenario is an ordinary patch: ceilings null
   (or all-off) so no conversion ever fills.

   CLAIMING AGES: a patch that changes a claiming age without
   naming a new yearly amount re-derives the amount from the
   base plan's anchor (its entered amount at its entered age)
   through ssAnnualAtClaimAge — exactly the derivation the
   optimizer's claim search applies to a combination — so a
   scenario priced at a different claiming age carries the
   benefit that age actually pays. A patch that names an amount
   uses it verbatim. A person declared "No benefit" is never
   re-derived.

   DELTAS: computed here, in integer cents, against the
   baseline scenario (the one named by baselineName, defaulting
   to the first scenario). Sign convention: delta = scenario −
   baseline, so a NEGATIVE deltaNetCostCents means the scenario
   costs LESS than the baseline, and a POSITIVE
   deltaAcaCreditCents means the scenario keeps MORE premium
   credit than the baseline. The baseline's own deltas are 0. */

export type RothCompareCeilingsCents = {
  bracketTopPct: number | null;
  irmaaTierCap: number | null;
  ltcgZeroCap: boolean;
  acaCliffCap: boolean;
  // Era-aware cliff cap modifier (see FillCeilings): optional
  // here so a compare base or patch built before the field
  // existed still type-checks and prices with it false.
  acaCliffCapFamilyOnly?: boolean;
  magiCapCents: number | null;
  // ACA cliff safety buffer (see FillCeilings): optional here
  // for the same reason as the era modifier — a compare base
  // or patch built before the field existed still type-checks
  // and prices with no buffer.
  acaCliffBufferCents?: number | null;
};

/* The saved-strategy library limit: how many named Roth
   strategies a record may keep. The scenario writer
   (saveRothScenario in actions.ts) refuses beyond this bound
   and the scenario reader (parseRothScenarios) truncates at
   it; both read this one constant so the boundary the
   accuracy fixtures pin is the boundary the app enforces.
   Raised from 5 to 50 with the Strategy Lab build so the
   library can grow option by option. */
export const ROTH_SCENARIO_LIMIT = 50;

// The saved shape a compare run works on: the plan shape plus
// the working strategy's ceilings and optimizer variant flags
// (the fields strategyFromSavedArgs reads in actions.ts).
export type RothCompareBaseSaved = RothSavedLike & {
  ceilings?: RothCompareCeilingsCents | null;
  optimizerGuardrail?: boolean | null;
  optimizerBunching?: boolean | null;
  // Gain-harvesting toggle, carried like the variant flags
  // above: a scenario patch may switch it on or off against
  // any baseline, which is how option 8 prices against any
  // saved plan.
  gainsHarvest?: boolean | null;
};

// A scenario patch: any subset of the base shape's fields. A
// key present with value null CLEARS that field (e.g. ceilings:
// null is how a Do Nothing scenario is expressed against a base
// plan that carries ceilings); an absent key inherits the base.
export type RothCompareOverrides = Partial<RothCompareBaseSaved>;

export type RothCompareScenarioBuilt = {
  name: string;
  // The merged saved shape this scenario prices (provenance —
  // the action echoes it back verbatim).
  saved: RothCompareBaseSaved;
  inputs: RothPlanInputs;
  strategy: RothStrategy;
  strategyDescription: string;
};

// The fixed strategy a merged saved shape prices: its ceilings
// (all-off = Do Nothing, priced with no ceilings), with the
// optimizer variant flags carried exactly as the planner
// carries the working strategy's.
export function compareStrategyFromSaved(saved: RothCompareBaseSaved): RothStrategy {
  const c = saved.ceilings ?? null;
  const anyCeiling =
    c != null &&
    (c.bracketTopPct != null ||
      c.irmaaTierCap != null ||
      c.ltcgZeroCap ||
      c.acaCliffCap ||
      c.magiCapCents != null);
  const ceilings: FillCeilings | null = anyCeiling
    ? {
        bracketTopPct: c.bracketTopPct,
        irmaaTierCap: c.irmaaTierCap,
        ltcgZeroCap: c.ltcgZeroCap,
        acaCliffCap: c.acaCliffCap,
        acaCliffCapFamilyOnly: c.acaCliffCapFamilyOnly === true,
        magiCap: c.magiCapCents == null ? null : c.magiCapCents / 100,
        acaCliffBuffer:
          c.acaCliffBufferCents == null ? null : c.acaCliffBufferCents / 100,
      }
    : null;
  return {
    id: "compare",
    name: ceilings ? nameForCeilings(ceilings) : "Do Nothing",
    ceilings,
    guardrail: saved.optimizerGuardrail ?? false,
    bunching: saved.optimizerBunching ?? false,
    gainsHarvest: saved.gainsHarvest ?? false,
  };
}

// Plain-language description of the fixed strategy a scenario
// prices, naming every dimension that separates scenarios:
// the retirement age FIRST (hardening package, finding
// A-12(b) — a scenario that moves the retirement age must say
// so up front, or a reader summarising from the description
// can miss that the override took), then the fill, the
// conversion window, the draw order (with the switch when one
// is set), the variant flags, and the survivor scenario when
// it is on.
export function compareStrategyDescription(
  inputs: RothPlanInputs,
  strategy: RothStrategy,
): string {
  const parts: string[] = [`Retire at ${inputs.retirementAge}`, strategy.name];
  if (strategy.ceilings) {
    parts.push(`Convert ages ${inputs.windowStartAge}–${inputs.windowStopAge}`);
  }
  const switchOn =
    inputs.drawOrderSwitchAge != null && inputs.drawOrderAfter != null;
  parts.push(
    switchOn
      ? `Draw order ${drawOrderLabel(inputs.drawOrder)}, then ${drawOrderLabel(inputs.drawOrderAfter as DrawOrder)} from age ${inputs.drawOrderSwitchAge}`
      : `Draw order ${drawOrderLabel(inputs.drawOrder)}`,
  );
  if (strategy.guardrail) parts.push("marginal-rate guardrail");
  if (strategy.bunching) parts.push("ACA bunching");
  if (strategy.ceilings?.acaCliffCap && strategy.ceilings.acaCliffCapFamilyOnly) {
    parts.push("ACA cliff cap only until the household steps down");
  }
  if (strategy.gainsHarvest) parts.push("gain harvesting into the 0% bracket");
  if (inputs.survivorEnabled && inputs.survivorDeathYear != null) {
    parts.push(
      `survivor scenario: ${inputs.survivorWho ?? "primary"} dies in ${inputs.survivorDeathYear}`,
    );
  }
  return parts.join(" · ");
}

// Merge one scenario patch over the base saved shape and build
// everything needed to price it. Returns null when the merged
// shape has no primary birth year (nothing can be priced).
//
// The optional taxReturnActuals parameter carries the plan
// record's stored tax-return actuals (the Form 1040 lines the
// blank-yield fallback derives from — see taxReturnCore.ts).
// The actions layer passes them on every compare build; pure
// callers that omit them keep the pre-v140 behaviour exactly
// (the scenario inherits whatever fallback transients the base
// shape carries).
export function buildCompareScenario(
  base: RothCompareBaseSaved,
  name: string,
  overrides: RothCompareOverrides,
  startYear: number,
  taxReturnActuals?: RothTaxReturnStored | null,
): RothCompareScenarioBuilt | null {
  /* CANONICALIZE THE BASE (Prompt 14 Finding 1 fix): resolve the
     base's ACA household schedule ONCE and write the resolved
     schedule back onto the base copy, deleting the legacy pair
     (acaStepDownYear / acaHouseholdSizeAfter). The resolver
     synthesizes exactly the schedule a legacy base prices with
     today, so a base WITHOUT a schedule override prices
     bit-identically to before this fix. What changes is an
     explicit clearing override — acaHouseholdSchedule: null (or
     an empty list) in the scenario patch: before this fix the
     merged shape still carried the legacy pair, the resolver
     fell through to it and resurrected the step the override
     meant to clear (a $36,528.03 lifetime-credit delta in the
     reviewer's repro on a raw legacy base); with the legacy
     pair gone from the canonical base, the resolver has nothing
     to fall through to and the clear truly clears. The app's
     record path migrates records before compare, so this was a
     latent trap in the pure functions, not a live mispricing. */
  const canonicalBase: RothCompareBaseSaved = { ...base };
  canonicalBase.acaHouseholdSchedule = resolveAcaHouseholdSchedule(base);
  delete canonicalBase.acaStepDownYear;
  delete canonicalBase.acaHouseholdSizeAfter;
  const merged: RothCompareBaseSaved = { ...canonicalBase };
  for (const k of Object.keys(overrides) as (keyof RothCompareOverrides)[]) {
    if (overrides[k] !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (merged as Record<string, unknown>)[k] = overrides[k] as any;
    }
  }
  // Claiming-age derivation (see the section header): a patch
  // that moves a claiming age without naming an amount derives
  // the amount that age pays from the BASE anchor.
  if (
    overrides.ssPrimaryStartAge !== undefined &&
    overrides.ssPrimaryAnnualCents === undefined &&
    merged.ssPrimaryNoBenefit !== true &&
    base.ssPrimaryAnnualCents != null &&
    base.ssPrimaryStartAge != null &&
    merged.ssPrimaryStartAge != null &&
    merged.birthYearPrimary != null
  ) {
    merged.ssPrimaryAnnualCents = Math.round(
      ssAnnualAtClaimAge(
        base.ssPrimaryAnnualCents / 100,
        base.ssPrimaryStartAge,
        merged.ssPrimaryStartAge,
        merged.birthYearPrimary,
      ) * 100,
    );
  }
  if (
    overrides.ssSpouseStartAge !== undefined &&
    overrides.ssSpouseAnnualCents === undefined &&
    merged.ssSpouseNoBenefit !== true &&
    base.ssSpouseAnnualCents != null &&
    base.ssSpouseStartAge != null &&
    merged.ssSpouseStartAge != null &&
    merged.birthYearSpouse != null
  ) {
    merged.ssSpouseAnnualCents = Math.round(
      ssAnnualAtClaimAge(
        base.ssSpouseAnnualCents / 100,
        base.ssSpouseStartAge,
        merged.ssSpouseStartAge,
        merged.birthYearSpouse,
      ) * 100,
    );
  }
  /* COMPARE SLEEVE REVISIT (parity audit S6): the base's
     spendFromCashSleeveCents is a snapshot-derived transient —
     resolveArgsBalances threads it (snapshot Cash less the
     exclusion, floored at $0) ONLY when the plan's taxable
     balance follows the snapshot, and the Tax Plan save path
     writes $0 beside a typed taxable balance (buildSavePayload
     in RothConversion.tsx). A scenario whose overrides give an
     explicit taxableCents therefore prices a pool with no
     snapshot context, and the sleeve its own balance implies
     is $0 — but the merge above inherits the base's threaded
     sleeve verbatim, so the scenario would spend the BASE
     pool's cash sleeve out of its own pool (on the settlement's
     worked example it priced a $45,000 first-year cash share
     and never realized the $18,000 of gain the direct pricing
     realizes, ~$2,700 of federal tax low). Revisit the sleeve
     here, the way the yield fallback is re-derived below: an
     explicit taxableCents override (an explicit null included —
     it prices the pool at $0, where no sleeve can spend)
     resets the merged sleeve to $0, unless the scenario's own
     overrides supply a sleeve — a passable transient, used
     exactly as supplied and never overwritten, the same rule
     the fallback re-derivation gives a scenario-supplied
     fallback. A scenario that leaves taxableCents untouched
     keeps the base's sleeve bit-identically: its pool IS the
     base's pool, so the threaded sleeve is its own. Tiers mode
     is unaffected either way —
     deriveSpendFromCashSleeveStartDollars derives the sleeve
     from the 100%-basis tier and ignores this transient. */
  if (
    overrides.taxableCents !== undefined &&
    overrides.spendFromCashSleeveCents === undefined
  ) {
    merged.spendFromCashSleeveCents = 0;
  }
  /* COMPARE FALLBACK RE-DERIVATION (contract v140, re-audit
     SHOULD S-2): the blank-yield fallback threaded onto the
     base was derived over the BASE plan's resolved taxable
     pool (resolveArgsBalances in actions.ts). A scenario whose
     overrides change the taxable balance prices from a
     DIFFERENT pool, so inheriting the base's percentages would
     price its yield income off the base's pool — a half-pool
     scenario priced exactly half the household's filed yield
     income, a double-pool scenario twice it. When the caller
     supplies the stored actuals, each scenario's fallback is
     re-derived here from the MERGED shape's own resolved pool
     through the ONE shared derivation
     (impliedYieldPctsFromTaxReturn), exactly as
     resolveArgsBalances derives the base's: only for a side
     whose merged yield field is still blank (an entered yield,
     the scenario's own included, always wins), and only when
     the merged pool is a positive figure (a $0 or unresolved
     pool derives no estimate — the inherited transient, if
     any, then prices on a $0 pool and yields $0 either way).
     A scenario that leaves the pool unchanged re-derives
     exactly the base's percentages — same actuals, same pool,
     same rounding — so its pricing is bit-identical to the
     inheritance it replaces. The qualified-dividend share is
     NOT re-derived: it is a ratio of the two dividend lines
     and never depended on any pool. PASSABLE TRANSIENTS
     (re-audit SHOULD S-7): a fallback a scenario's own
     overrides supply (present in the overrides, an explicit
     null included) is never overwritten here. An inherited
     fallback is re-derived ONLY when it cannot describe this
     scenario: when the merged shape carries none yet, or
     when the scenario's pool differs from the base's pool
     (the S-2 case — the inherited percentages were derived
     over the base's pool). With the pool unchanged, an
     inherited fallback stands exactly as threaded or
     supplied on the base. */
  if (taxReturnActuals != null) {
    const poolCents = merged.taxableCents ?? null;
    const basePoolCents = base.taxableCents ?? null;
    if (poolCents != null && poolCents > 0) {
      const implied = impliedYieldPctsFromTaxReturn(
        taxReturnActuals,
        poolCents / 100,
      );
      if (
        (merged.taxableDividendYieldPct ?? null) == null &&
        overrides.yieldFallbackDividendPct === undefined &&
        ((merged.yieldFallbackDividendPct ?? null) == null ||
          poolCents !== basePoolCents)
      ) {
        merged.yieldFallbackDividendPct = implied.dividendYieldPct;
      }
      if (
        (merged.taxableInterestYieldPct ?? null) == null &&
        overrides.yieldFallbackInterestPct === undefined &&
        ((merged.yieldFallbackInterestPct ?? null) == null ||
          poolCents !== basePoolCents)
      ) {
        merged.yieldFallbackInterestPct = implied.interestYieldPct;
      }
    }
  }
  const inputs = planInputsFromSaved(merged, startYear);
  if (!inputs) return null;
  const strategy = compareStrategyFromSaved(merged);
  return {
    name,
    saved: merged,
    inputs,
    strategy,
    strategyDescription: compareStrategyDescription(inputs, strategy),
  };
}

/* Per-year tax readouts for one compare scenario (contract
   v51): the priced march's own rows, in cents — read straight
   off the same RothYear rows the scenario's lifetime totals
   sum, so a per-year display can never disagree with the
   lifetime figures beside it. Display only: no score, ranking,
   or delta is derived from them. pretaxOutByChoiceCents is
   the year's pre-tax money out by choice — its conversion
   plus its pre-tax draw for spending (an RMD alone is not
   in it). It is NOT the funding run's pretaxDrawCents
   (build v127, round-19 finding 11): that field is the
   extra spending draw plus pre-tax amounts applied to the
   tax bill, and excludes the conversion — the shared name
   used to say they were the same quantity, and they are
   not. The spending-draw component is the year's
   detail.pretaxSpendingDraw (audit S-10): the earlier
   computation read detail.extraPreTaxDraw, whose total
   also carries the tax-bill debits, and so overstated
   this field by exactly those debits in every year they
   occurred. The split itself is surfaced beside this
   field (re-audit SHOULD S-8): each year readout also
   carries pretaxSpendingDrawCents, pretaxTaxDebitCents,
   and extraPreTaxDrawCents — the two components of the
   year's total priced pre-tax draw and that total, read
   straight off the same detail (see the
   pretaxDrawSplitSemantics convention describeApi
   publishes). */
export type RothCompareScenarioYear = {
  year: number;
  agePrimary: number;
  ageSpouse: number | null;
  federalTaxCents: number;
  stateTaxCents: number;
  // The year's pre-59½ withholding penalty (P-S11, parity
  // audit): the march's own per-year penalty (RothYear
  // .penalty) — 10% of the tax withheld from a conversion
  // before the conversion owner turned 59½, grossed up.
  // $0 in every year that prices no penalty. It is NOT
  // inside federalTaxCents above: the funding rows fold it
  // into their federalTaxCents (the penalty is paid as part
  // of the federal withholding), so a per-year tax bill
  // built from these readouts must add penaltyCents beside
  // federalTaxCents to agree with the funding rows — the
  // scenario result has always carried the penalty as a
  // lifetime total (penaltyCents on the scenario), and the
  // per-year readouts now sum to it. Display only, exactly
  // like the other readouts on this type.
  penaltyCents: number;
  // The year's adjusted gross income (AGI).
  totalIncomeCents: number;
  taxableIncomeCents: number;
  // The year's ACA premium credit kept ($0 when the year
  // prices no credit).
  acaCreditCents: number;
  // The year's refundable American Opportunity Credit
  // portion — money the household receives even past a $0
  // tax bill (the pricer nets it into the net bill, so the
  // display must too). $0 in every year with no entered
  // education expenses.
  educationRefundableCents: number;
  // IRMAA surcharges PAID that year (Medicare premiums, not
  // tax — carried separately so a bill display never folds
  // them into a tax line).
  irmaaCents: number;
  // LOOKBACK AVAILABILITY (Engine Review 6, E6-S1): whether
  // the IRMAA surcharge for this year is KNOWN — false
  // exactly when someone is on Medicare this year and no
  // MAGI + filing status is recorded for the lookback year
  // (year − 2). When false, irmaaCents is $0 and that $0 is
  // UNKNOWN, not a computed $0 surcharge. Display only.
  irmaaSurchargeKnown: boolean;
  // ELIGIBILITY (Engine Review 6, E6-S2): the year's ACA MAGI
  // is under 100% FPL, so the credit is $0 under the standard
  // §36B income test. Display only.
  acaBelow100Fpl: boolean;
  // EARLY-WITHDRAWAL ELIGIBILITY UNKNOWN (Engine Review C9,
  // Build 1): true exactly when this year priced a pre-59½
  // pre-tax spending draw while the drawing owner's Rule-of-55
  // eligibility was unanswered — so the $0 penalty the year
  // shows on that draw is UNKNOWN, not a computed $0. Display
  // only — no score, ranking, or delta reads it.
  earlyWithdrawalEligibilityUnknown: boolean;
  // ROTH BASIS UNKNOWN (Engine Review C9, Build 2 — W3):
  // true exactly when this year priced a Roth draw while
  // the drawing owner's Roth composition was unentered —
  // so the $0 income and $0 penalty the year shows on that
  // draw are UNKNOWN, not computed. Display only — no score,
  // ranking, or delta reads it.
  rothBasisUnknown: boolean;
  // Health premium (build v208): the year's NET health
  // premium funded (the engine's RothYear.healthPremiumNet).
  // $0 in every year of a plan that does not enter the
  // health premium term.
  healthPremiumCents: number;
  // Health premium gross (Review 3 R3-S1): the year's GROSS
  // health premium (the engine's RothYear.healthPremiumGross),
  // carried so a display can show gross and net side by side
  // without re-deriving the gross from the net and the credit.
  // $0 in every year of a plan that does not enter the term.
  // Display only — no score, ranking, or delta reads it.
  healthPremiumGrossCents: number;
  conversionCents: number;
  pretaxOutByChoiceCents: number;
  // The S-10 split of the year's total priced pre-tax draw
  // (re-audit SHOULD S-8 surfacing; see the
  // pretaxDrawSplitSemantics convention): the pre-tax draw
  // for spending alone, the pre-tax debits that paid the
  // tax bill alone, and their sum — the year's
  // detail.extraPreTaxDraw, the amount the priced AGI
  // carries. pretaxOutByChoiceCents above is the
  // conversion plus the FIRST component only.
  pretaxSpendingDrawCents: number;
  pretaxTaxDebitCents: number;
  extraPreTaxDrawCents: number;
  // Settlement convergence (round-8 SHOULD-1, from the engine's
  // RothYear): whether the year's kept settlement was an exact fixed
  // point of the settlement iteration, and — when it was not — the
  // kept round's residual mismatch per component in integer cents
  // (gains, pre-tax, and — Engine Review C3, C3-S1 — the ACA
  // credit residual; all 0 when converged), plus how many
  // rounds / passes the kept settlement took and why each level
  // stopped. Display only — no score, ranking, or delta is
  // derived from them, and no pricing changed.
  settlementConverged: boolean;
  settlementMismatchCents: { gains: number; pretax: number; roth: number; hsa: number; acaCredit: number };
  settlementRounds: number;
  settlementPasses: number;
  settlementStopReason: "converged" | "repeated-assumption" | "iteration-limit";
  settlementInnerStopReason: "converged" | "repeated-assumption" | "iteration-limit";
  // Ceiling breached (round-8 SHOULD-1, from the engine's
  // RothYear): true when a switched-on ceiling is still breached
  // by the year's final priced figures at conversion $0 — the
  // draws alone breach. See the ceilingBreachedSemantics
  // convention describeApi publishes. Display only.
  ceilingBreached: boolean;
  // RMD + survivor readouts (Engine Review 5, display only —
  // carried through from the same priced march row the other
  // readouts read, no new derivation, no pricing reads them):
  // the year's settled RMDs by owner, the amount deferred THIS
  // year and the amount deferred from a prior year PAID this
  // year (the two-RMD year), the year's total Social Security
  // collected (both benefits before a death; the survivor's
  // benefit alone in survivor years), and the survivor-benefit
  // modeling mode + claiming age for survivor years (null when
  // the year is not a survivor year).
  ssCollectedCents: number;
  rmdPrimaryCents: number;
  rmdSpouseCents: number;
  rmdDeferredPrimaryCents: number;
  rmdDeferredSpouseCents: number;
  rmdDeferredPaidPrimaryCents: number;
  rmdDeferredPaidSpouseCents: number;
  survivorSsMode: "simplified" | "enhanced" | null;
  survivorClaimAge: number | null;
};

export type RothCompareScenarioResult = {
  name: string;
  strategyDescription: string;
  saved: RothCompareBaseSaved;
  netCostCents: number;
  totalTaxCents: number;
  // Lifetime federal / state split of totalTaxCents
  // (build v51): federalTaxCents + stateTaxCents =
  // totalTaxCents, so a composition display can name the
  // federal part exactly instead of re-deriving it.
  federalTaxCents: number;
  stateTaxCents: number;
  // Per-year readouts of the scenario's priced march
  // (build v51; see RothCompareScenarioYear).
  years: RothCompareScenarioYear[];
  penaltyCents: number;
  irmaaCents: number;
  acaCreditCents: number;
  // LOOKBACK + ELIGIBILITY SUMMARIES (Engine Review 6,
  // display only): the premium years whose IRMAA surcharge
  // is UNKNOWN (someone on Medicare, no lookback entry for
  // year − 2 — the $0 in those years is not a computed $0,
  // and irmaaCents excludes the unknown amounts) and the
  // ACA-priced years under 100% FPL (credit $0 under the
  // standard §36B income test). Both empty on a scenario
  // with complete lookbacks and no below-100% year.
  irmaaLookbackMissingYears: number[];
  acaBelow100FplYears: number[];
  // EARLY-WITHDRAWAL UNKNOWN YEARS (Engine Review C9,
  // Build 1, display only): the years whose pre-59½ pre-tax
  // spending draw was priced while the drawing owner's
  // Rule-of-55 eligibility was unanswered — the $0 penalty
  // in those years is unknown, not computed. Empty on a
  // scenario with no pre-59½ pre-tax draw, or with
  // eligibility answered for every drawing owner.
  earlyWithdrawalUnknownYears: number[];
  // ROTH BASIS UNKNOWN YEARS (Engine Review C9, Build 2 —
  // W3, display only): the years whose Roth draw was priced
  // while the drawing owner's Roth composition was
  // unentered — the $0 income and $0 penalty in those years
  // are unknown, not computed. Empty on a scenario with no
  // Roth draw, or with the composition answered for every
  // drawing owner.
  rothBasisUnknownYears: number[];
  // Lifetime health premiums (build v208): the GROSS
  // premium the score identity adds beside acaCreditCents,
  // and the NET premium (gross less the funded credits) for
  // display. 0 for any scenario that does not enter the
  // health premium term.
  healthPremiumCents: number;
  healthPremiumNetCents: number;
  // Lifetime refundable education credit (T6): the sum of
  // the scenario's years' refundable AOTC portions — the
  // component the net-cost identity subtracts beside
  // acaCreditCents (the nonrefundable portions are already
  // inside totalTaxCents, having reduced the years'
  // federal tax). 0 for any scenario with no entered
  // education expenses.
  educationRefundableCents: number;
  // Lifetime AMT owed (T7): the sum of the scenario's
  // years' AMT — already inside totalTaxCents (each
  // year's AMT raised its federal tax), so this line
  // names the component of the lifetime tax and is never
  // counted a second time in the identity. 0 for any
  // scenario whose tentative minimum tax never exceeds
  // its regular tax.
  amtCents: number;
  terminalCents: number;
  ssCollectedCents: number;
  // Lifetime UNPAID TAX (round-5 fix 1): the part of the
  // scenario's lifetime assessed tax its balances could not
  // pay (the engine's lifetimeUnpaidTax). totalTaxCents
  // carries the full assessed liability; this is the portion
  // never actually paid out of the accounts. 0 for any
  // scenario whose balances always cover the bill.
  unpaidTaxCents: number;
  // INTEGRITY (Engine Review C9, Build 3 — W4-GAP-1): the
  // E4 verdict on this scenario's OWN priced march
  // (assessCandidateIntegrity) — valid,
  // valid-with-benign-residual, or invalid with reasons.
  // Its totals are DOLLARS (unpaidTaxTotal /
  // spendShortfallTotal), while every other money field on
  // this scenario is CENTS — read them as dollars,
  // never as cents.
  integrity: CandidateIntegrity;
  endingPretaxCents: number;
  endingRothCents: number;
  endingTaxableCents: number;
  endingHsaCents: number;
  endingAfterTaxWealthCents: number;
  deltaNetCostCents: number;
  deltaAcaCreditCents: number;
  // Scenario − baseline refundable education credit (T6),
  // same sign convention as deltaAcaCreditCents: positive
  // means the scenario receives more refundable credit.
  deltaEducationRefundableCents: number;
};

export type RothCompareResult = {
  ok: boolean;
  reason: string;
  baselineName: string | null;
  scenarios: RothCompareScenarioResult[];
  // Crowned winners (Engine Review C9, Build 3 — W4-GAP-1):
  // the two objective winners, crowned by crownCompareWinners
  // over the VALID scenarios only. winnerQualified is false
  // exactly when no scenario was valid — the raw winners
  // are still crowned (there is nothing else to recommend)
  // and excludedInvalidWinner names the raw cheapest with its
  // integrity reasons. Null / false / null / false on an
  // ok:false return, where nothing was crowned.
  winnerByNetCost: string | null;
  winnerByEndingWealth: string | null;
  winnerQualified: boolean;
  excludedInvalidWinner: {
    name: string;
    integrity: CandidateIntegrity;
  } | null;
  winnersDiffer: boolean;
};

const toCents = (dollars: number): number => Math.round(dollars * 100);

// Price every scenario as one fixed strategy and compute the
// deltas against the baseline. Pure — the action is a thin
// wrapper (balance resolution + response shaping) around this.
export function runRothCompare(
  base: RothCompareBaseSaved,
  scenarios: { name: string; overrides: RothCompareOverrides }[],
  startYear: number,
  baselineName?: string | null,
  // The plan record's stored tax-return actuals, when the
  // caller holds them (the actions layer does): each scenario's
  // blank-yield fallback is re-derived from that scenario's own
  // resolved pool (contract v140, re-audit SHOULD S-2 — see
  // buildCompareScenario). Omitted / null = the pre-v140
  // inheritance of the base's threaded transients.
  taxReturnActuals?: RothTaxReturnStored | null,
): RothCompareResult {
  if (scenarios.length === 0) {
    return {
      ok: false,
      reason: "The compare needs at least one scenario — name a strategy to price.",
      baselineName: null,
      scenarios: [],
      winnerByNetCost: null,
      winnerByEndingWealth: null,
      winnerQualified: false,
      excludedInvalidWinner: null,
      winnersDiffer: false,
    };
  }
  const built: RothCompareScenarioBuilt[] = [];
  for (const s of scenarios) {
    const b = buildCompareScenario(base, s.name, s.overrides, startYear, taxReturnActuals);
    if (!b) {
      return {
        ok: false,
        reason:
          "The compare needs a birth year before it can price a plan — enter it in the base plan and run again.",
        baselineName: null,
        scenarios: [],
        winnerByNetCost: null,
        winnerByEndingWealth: null,
        winnerQualified: false,
        excludedInvalidWinner: null,
        winnersDiffer: false,
      };
    }
    built.push(b);
  }
  const baseline =
    built.find((b) => b.name === baselineName) ?? built[0]!;
  if (baselineName != null && baseline.name !== baselineName) {
    return {
      ok: false,
      reason: `No scenario is named "${baselineName}" — the baseline must be one of the scenarios in the run.`,
      baselineName: null,
      scenarios: [],
      winnerByNetCost: null,
      winnerByEndingWealth: null,
      winnerQualified: false,
      excludedInvalidWinner: null,
      winnersDiffer: false,
    };
  }
  const priced = built.map((b) => {
    const result = simulateRothPlan(b.inputs, b.strategy, undefined, {
      leanDetail: true,
    });
    const cost = planNetCost(result, b.inputs);
    return {
      built: b,
      netCostCents: toCents(cost.netCost),
      totalTaxCents: toCents(cost.tax),
      federalTaxCents: toCents(result.lifetimeFederalTax),
      stateTaxCents: toCents(result.lifetimeStateTax),
      years: result.years.map((y) => ({
        year: y.year,
        agePrimary: y.agePrimary,
        ageSpouse: y.ageSpouse,
        federalTaxCents: toCents(y.federalTax),
        stateTaxCents: toCents(y.stateTax),
        penaltyCents: toCents(y.penalty),
        totalIncomeCents: toCents(y.agi),
        taxableIncomeCents: toCents(y.taxableIncome),
        acaCreditCents: toCents(y.acaCreditKept),
        educationRefundableCents: toCents(y.educationRefundable),
        irmaaCents: toCents(y.irmaaPaid),
        irmaaSurchargeKnown: y.irmaaSurchargeKnown,
        acaBelow100Fpl: y.acaBelow100Fpl,
        earlyWithdrawalEligibilityUnknown: y.earlyWithdrawalEligibilityUnknown,
        rothBasisUnknown: y.rothBasisUnknown,
        healthPremiumCents: toCents(y.healthPremiumNet),
        healthPremiumGrossCents: toCents(y.healthPremiumGross),
        conversionCents: toCents(y.conversion),
        // Audit S-10: the spending draw ALONE
        // (detail.pretaxSpendingDraw), never
        // detail.extraPreTaxDraw — that total also carries
        // the pre-tax debits that paid the tax bill
        // (detail.pretaxTaxDebit), which are not money out
        // by choice and would collapse this field into
        // runRothFunding's pretaxDrawCents.
        pretaxOutByChoiceCents: toCents(y.conversion + y.detail.pretaxSpendingDraw),
        // The S-10 split, surfaced (re-audit SHOULD S-8):
        // the year's detail components and their total,
        // read off the same detail the by-choice field
        // reads its spending component from — no new
        // derivation, no pricing reads them.
        pretaxSpendingDrawCents: toCents(y.detail.pretaxSpendingDraw),
        pretaxTaxDebitCents: toCents(y.detail.pretaxTaxDebit),
        extraPreTaxDrawCents: toCents(y.detail.extraPreTaxDraw),
        // Settlement flags (round-8 SHOULD-1): carried through
        // from the same priced march row the other readouts read
        // — the mismatch is already integer cents on the march
        // row, so it passes through unscaled, exactly as the
        // funding rows carry it. Display only.
        settlementConverged: y.settlementConverged,
        settlementMismatchCents: y.settlementMismatchCents,
        settlementRounds: y.settlementRounds,
        settlementPasses: y.settlementPasses,
        settlementStopReason: y.settlementStopReason,
        settlementInnerStopReason: y.settlementInnerStopReason,
        ceilingBreached: y.ceilingBreached,
        // RMD + survivor readouts (Engine Review 5, display
        // only): the march row's own detail, in cents.
        ssCollectedCents: toCents(y.ssBenefits),
        rmdPrimaryCents: toCents(y.detail.rmdPrimary),
        rmdSpouseCents: toCents(y.detail.rmdSpouse),
        rmdDeferredPrimaryCents: toCents(y.detail.rmdDeferredPrimary),
        rmdDeferredSpouseCents: toCents(y.detail.rmdDeferredSpouse),
        rmdDeferredPaidPrimaryCents: toCents(y.detail.rmdDeferredPaidPrimary),
        rmdDeferredPaidSpouseCents: toCents(y.detail.rmdDeferredPaidSpouse),
        survivorSsMode: y.detail.survivorSsMode,
        survivorClaimAge: y.detail.survivorClaimAge,
      })),
      penaltyCents: toCents(cost.penalty),
      irmaaCents: toCents(cost.irmaa),
      acaCreditCents: toCents(cost.acaCredit),
      // LOOKBACK + ELIGIBILITY SUMMARIES (Engine Review 6,
      // display only): the premium years whose IRMAA is
      // UNKNOWN (someone on Medicare, no lookback entry —
      // the $0 in those years is not a computed $0) and the
      // ACA-priced years under 100% FPL (credit $0 under the
      // standard §36B income test). Read off the priced
      // march's own lists, never re-derived.
      irmaaLookbackMissingYears: result.irmaaLookbackMissingYears,
      acaBelow100FplYears: result.acaBelow100FplYears,
      earlyWithdrawalUnknownYears: result.earlyWithdrawalUnknownYears,
      rothBasisUnknownYears: result.rothBasisUnknownYears,
      healthPremiumCents: toCents(cost.healthPremium),
      healthPremiumNetCents: toCents(cost.healthPremiumNet),
      educationRefundableCents: toCents(cost.educationRefundable),
      amtCents: toCents(cost.amt),
      terminalCents: toCents(cost.terminal),
      ssCollectedCents: toCents(cost.ssCollected),
      unpaidTaxCents: toCents(result.lifetimeUnpaidTax),
      // (Engine Review C9, Build 3 — W4-GAP-1): the E4 verdict
      // on this scenario's OWN priced march, attached here so
      // the crowning below and every consumer read the same
      // assessment — never re-derived from the mapped rows.
      integrity: assessCandidateIntegrity(result),
      endingPretaxCents: toCents(result.endingPretax),
      endingRothCents: toCents(result.endingRoth),
      endingTaxableCents: toCents(result.endingTaxable),
      endingHsaCents: toCents(result.endingHsa),
      endingAfterTaxWealthCents: toCents(result.endingAfterTaxWealth),
    };
  });
  const basePriced = priced.find((p) => p.built === baseline) ?? priced[0]!;
  // (Engine Review C9, Build 3 — W4-GAP-1): crown the two
  // objective winners over the VALID scenarios only — an
  // invalid candidate is never a qualified winner on the
  // compare path either. The crowning reads the integrity
  // attached to each priced march above.
  const crowned = crownCompareWinners(
    priced.map((p) => ({
      name: p.built.name,
      netCostCents: p.netCostCents,
      endingAfterTaxWealthCents: p.endingAfterTaxWealthCents,
      integrity: p.integrity,
    })),
  );
  return {
    ok: true,
    reason: `Priced ${priced.length} scenario${priced.length === 1 ? "" : "s"} as fixed strategies against the baseline "${baseline.name}". Deltas are scenario − baseline, in cents: a negative net-cost delta means the scenario costs less than the baseline; a positive ACA-credit delta means it keeps more premium credit.`,
    baselineName: baseline.name,
    winnerByNetCost: crowned.winnerByNetCost.name,
    winnerByEndingWealth: crowned.winnerByEndingWealth.name,
    winnerQualified: crowned.winnerQualified,
    excludedInvalidWinner: crowned.excludedInvalidWinner,
    winnersDiffer: crowned.winnersDiffer,
    scenarios: priced.map((p) => ({
      name: p.built.name,
      strategyDescription: p.built.strategyDescription,
      saved: p.built.saved,
      netCostCents: p.netCostCents,
      totalTaxCents: p.totalTaxCents,
      federalTaxCents: p.federalTaxCents,
      stateTaxCents: p.stateTaxCents,
      years: p.years,
      penaltyCents: p.penaltyCents,
      irmaaCents: p.irmaaCents,
      acaCreditCents: p.acaCreditCents,
      irmaaLookbackMissingYears: p.irmaaLookbackMissingYears,
      acaBelow100FplYears: p.acaBelow100FplYears,
      earlyWithdrawalUnknownYears: p.earlyWithdrawalUnknownYears,
      rothBasisUnknownYears: p.rothBasisUnknownYears,
      healthPremiumCents: p.healthPremiumCents,
      healthPremiumNetCents: p.healthPremiumNetCents,
      educationRefundableCents: p.educationRefundableCents,
      amtCents: p.amtCents,
      terminalCents: p.terminalCents,
      ssCollectedCents: p.ssCollectedCents,
      unpaidTaxCents: p.unpaidTaxCents,
      integrity: p.integrity,
      endingPretaxCents: p.endingPretaxCents,
      endingRothCents: p.endingRothCents,
      endingTaxableCents: p.endingTaxableCents,
      endingHsaCents: p.endingHsaCents,
      endingAfterTaxWealthCents: p.endingAfterTaxWealthCents,
      deltaNetCostCents: p.netCostCents - basePriced.netCostCents,
      deltaAcaCreditCents: p.acaCreditCents - basePriced.acaCreditCents,
      deltaEducationRefundableCents:
        p.educationRefundableCents - basePriced.educationRefundableCents,
    })),
  };
}

/* =================================================================
   ENGINE REVIEW C10 — DYNAMIC WITHDRAWAL OPTIMIZER
   -----------------------------------------------------------------
   A year-by-year optimizer that re-optimizes at every year of the
   plan instead of fixing one draw order + one conversion ceiling
   for the whole horizon. It prices NOTHING of its own: every
   candidate policy is priced by the shared engine —
   simulateRothPlan on re-anchored inputs — with the shared
   settlement, the shared tax law, and the shared net-cost
   scorer (planNetCost). The only new arithmetic in this section
   is bookkeeping BETWEEN marches: carrying balances, the
   taxable-basis ledger, the Rule-of-55 eligibility ledger, and
   the Roth contribution / conversion-lot ledgers from one year's
   priced march into the next year's re-anchored inputs, each
   derived from the priced year's own engine outputs (see the
   ledger notes below) and each covered by the roll-forward
   parity test (a fixed policy rolled forward year by year must
   reproduce its single full march to the cent).

   METHOD (greedy roll-forward with a fixed-policy floor):
   at each year, every policy in dynamicPolicySet() — the fixed
   conversion fills (Do Nothing, Fill 12% / 22% / 22%-IRMAA-1 /
   ACA-cliff, bracket fills also with the marginal-rate
   guardrail) × the three conversion windows (stop 65 / stop the
   year before RMDs begin / through the RMD years) × all six
   draw orders — is priced over the REMAINING horizon from the
   year's actual balances, scored sunk-net-cost + remaining
   planNetCost, and the best VALID policy's first year becomes
   the schedule's row for that year. The state then advances to
   that year's priced ending balances and the process repeats.
   The greedy choice is myopic by construction (it re-prices the
   whole remaining horizon each year, so the myopia is only the
   commitment to one year at a time — not a one-year lookahead),
   and NO global-optimality claim is made: the result is
   reported beside the best valid FIXED policy over the same
   policy set, and when the greedy trajectory scores worse than
   that fixed policy on lifetime net cost the fixed trajectory
   is returned instead (floorBound: true, named in the result)
   — so the dynamic result is never worse than the best valid
   fixed order on the scored objective. The raw greedy figures
   are still reported (greedyNetCost / greedyEndingWealth) so
   the floor is auditable, never silent. The floor triggers
   only when the greedy trajectory scores worse by more than
   $0.10 (DYNAMIC_FLOOR_EPSILON): re-anchoring carries the
   march's year rows, which are cent-rounded, while the march
   itself carries fractional-cent float balances internally —
   so a re-anchored year can price a cent differently from the
   uninterrupted march (observed worst case: $0.02 over 13
   years on the sample household). A sub-$0.10 gap is rounding
   noise, not a worse policy, and must not trigger the floor.

   7 PHASES: every schedule year carries one phase, by this
   precedence (first match wins): survivor (any year after a
   death year — single filer, inherited balances); rmd (primary
   75+, RMDs priced); ss (67–74, Social Security started, before
   RMDs); bridge (65–66, Medicare, before Social Security);
   early (primary under 59½ — the §72(t) penalty window);
   aca (60–64, pre-Medicare ACA years). The seventh phase,
   terminal, is not a year: it is the end-age settlement —
   terminal tax on the standing pre-tax balance, the step-up in
   basis on the taxable balance, and the inherited-Roth vs
   inherited-traditional split — reported as the result's
   terminal block. A year is in exactly one of the six year
   phases; the terminal phase closes the schedule.

   RMD EXPOSURE is first-class output: every row carries its
   RMD (primary + spouse split), the result totals lifetime RMDs
   and names the first RMD year, and the schedule's RMD column
   is the engine's own priced RMD (RothYear.detail), never a
   re-derivation.

   SEARCH LIMITS (disclosed, not hidden): the per-year policy
   set is the fixed-fill family above (114 policies) — it does
   NOT include the full optimizer's thousands of ceilings
   (bracket × IRMAA combinations, MAGI-cap steps, bunching,
   gain-harvest twins) or per-year conversion amounts finer
   than a ceiling fill, and the choice is greedy one year at a
   time. Against the EXISTING full optimizer (3,025 candidates)
   the dynamic result is compared, not assumed superior: see
   BUILDER-REPORT.md for the reference-scenario comparison.
   ================================================================= */

export type DynamicPhase =
  | "early"
  | "aca"
  | "bridge"
  | "ss"
  | "rmd"
  | "survivor"
  | "terminal";

export function dynamicPhaseForYear(args: {
  agePrimary: number;
  isSurvivorYear: boolean;
  rmdAge: number;
  ssStartAge: number | null;
}): DynamicPhase {
  if (args.isSurvivorYear) return "survivor";
  if (args.agePrimary >= args.rmdAge) return "rmd";
  if (args.ssStartAge != null && args.agePrimary >= args.ssStartAge) return "ss";
  if (args.agePrimary >= 65) return "bridge";
  if (args.agePrimary < 59.5) return "early";
  return "aca";
}

export type DynamicPolicy = {
  key: string;
  name: string;
  ceilings: FillCeilings | null;
  guardrail: boolean;
  windowStopAge: number;
  drawOrder: DrawOrder;
};

/* The per-year policy set: the fixed fills the compare prices
   (Do Nothing, Fill 12%, Fill 22%, Fill 22% capped at IRMAA
   Tier 1, Fill capped at the ACA cliff), bracket fills also
   with the marginal-rate guardrail (the full-search winner's
   shape), × windows stopping at 65 / the year before RMDs
   begin / the end age × all six draw orders. Do Nothing is
   window-inert, so it appears once per order (6), not once per
   window: 6 + 6 fills × 3 windows × 6 orders = 114 policies. */
export function dynamicPolicySet(rmdStopAge: number, endAge: number): DynamicPolicy[] {
  const fills: { key: string; name: string; ceilings: FillCeilings; guardrail: boolean }[] = [
    { key: "fill12", name: "Fill 12%", ceilings: { ...NO_CEILINGS, bracketTopPct: 12 }, guardrail: false },
    { key: "fill12g", name: "Fill 12% (guardrail)", ceilings: { ...NO_CEILINGS, bracketTopPct: 12 }, guardrail: true },
    { key: "fill22", name: "Fill 22%", ceilings: { ...NO_CEILINGS, bracketTopPct: 22 }, guardrail: false },
    { key: "fill22g", name: "Fill 22% (guardrail)", ceilings: { ...NO_CEILINGS, bracketTopPct: 22 }, guardrail: true },
    { key: "fill22-irmaa1", name: "Fill 22% capped at IRMAA Tier 1", ceilings: { ...NO_CEILINGS, bracketTopPct: 22, irmaaTierCap: 1 }, guardrail: false },
    { key: "fill-aca", name: "Fill capped at ACA cliff", ceilings: { ...NO_CEILINGS, acaCliffCap: true }, guardrail: false },
  ];
  const stops = [65, rmdStopAge, endAge];
  const out: DynamicPolicy[] = [];
  for (const order of ALL_DRAW_ORDERS) {
    out.push({
      key: `do-nothing|${drawOrderKey(order)}`,
      name: "Do Nothing",
      ceilings: null,
      guardrail: false,
      windowStopAge: endAge,
      drawOrder: order,
    });
  }
  for (const fill of fills) {
    for (const stop of stops) {
      for (const order of ALL_DRAW_ORDERS) {
        out.push({
          key: `${fill.key}|stop${stop}|${drawOrderKey(order)}`,
          name: `${fill.name} · stop ${stop}`,
          ceilings: fill.ceilings,
          guardrail: fill.guardrail,
          windowStopAge: stop,
          drawOrder: order,
        });
      }
    }
  }
  return out;
}

/* Terminal tax — the SAME split rule netCostBreakdown prices
   (preserved pre-tax at the exit rate, excess at the heir
   rate), computed from a standing pre-tax balance instead of a
   priced march, so the dynamic trajectory (which is many
   marches, not one) can score its own terminal term. The
   reviewC10Dynamic terminal test asserts this agrees with
   netCostBreakdown's terminal on a march with the same ending
   pre-tax balance. */
export function dynamicTerminalTax(args: {
  endingPretax: number;
  heirRatePct: number;
  preservePretax?: number;
  preserveExitRatePct?: number;
}): { terminal: number; preservedPretax: number; terminalPreserved: number; excessPretax: number; terminalExcess: number } {
  const floor = Math.max(0, args.preservePretax ?? 0);
  const exitRatePct = args.preserveExitRatePct ?? args.heirRatePct;
  const preservedPretax = r2(Math.min(args.endingPretax, floor));
  const excessPretax = r2(args.endingPretax - preservedPretax);
  const terminalPreserved = r2((preservedPretax * exitRatePct) / 100);
  const terminalExcess = r2((excessPretax * args.heirRatePct) / 100);
  return {
    terminal: r2(terminalPreserved + terminalExcess),
    preservedPretax,
    terminalPreserved,
    excessPretax,
    terminalExcess,
  };
}

/* Taxable-basis ledger, carried between marches from the
   priced year's own outputs (taxEngine's documented ledger
   rules: outflows reduce basis pro-rata at the ratio in force
   — so the ratio is invariant through a year's sales; inflows
   of after-tax money raise basis dollar-for-dollar; growth
   adds to the balance, never to basis; gain harvesting, when
   on, adds the harvested gain — this module never turns it on,
   so no harvest term). The year's reinvested yield (dividend +
   interest income, a component of the return — the balance's
   growth already carries it, so it adds to basis WITHOUT
   adding to the balance) is the one inflow the balance
   identity cannot see, so it enters as its own term:
   yieldReinvested = the year's dividend + interest income.
   Given the year's start balance / basis, its priced sales
   and gains, its priced ending balance, and its reinvested
   yield: basis consumed by sales = sold − realized gains
   (the gains ARE the non-basis part of the proceeds); the
   surplus sweep into taxable = ending/growth − start + sold
   (the ending balance is (start − sold + sweep) × growth);
   ending basis = start basis − consumed + sweep + yield. */
export function trackTaxableBasisEnd(args: {
  taxableStart: number;
  basisStart: number;
  taxableSold: number;
  drawGains: number;
  taxableEnd: number;
  growthFactor: number;
  yieldReinvested: number;
}): number {
  const basisConsumed = Math.max(0, args.taxableSold - args.drawGains);
  const sweepIn = args.taxableEnd / args.growthFactor - args.taxableStart + args.taxableSold;
  // Cent-rounded: the march prices gains to the cent off this
  // ledger, so a fractional-cent remainder carried forward
  // would price a different cent of gains in a later year.
  return r2(Math.max(0, args.basisStart - basisConsumed + sweepIn + args.yieldReinvested));
}

/* Rule-of-55 eligibility ledger, carried between marches:
   every pre-tax outflow consumes the eligible dollars FIRST
   within that owner's pool (taxEngine's ledger rule), so the
   eligible remainder after a year is (eligible − total
   outflows) × growth, floored at $0 and capped at the ending
   balance; total outflows = start − ending/growth. Null in =
   unanswered eligibility = null out (the next march prices $0
   penalty with the unknown flag, exactly as before). */
export function trackEligibleEnd(args: {
  eligibleStart: number | null;
  pretaxStart: number;
  pretaxEnd: number;
  growthFactor: number;
}): number | null {
  if (args.eligibleStart == null) return null;
  const outflows = args.pretaxStart - args.pretaxEnd / args.growthFactor;
  return r2(
    Math.min(
      Math.max(0, args.pretaxEnd),
      Math.max(0, (args.eligibleStart - outflows) * args.growthFactor),
    ),
  );
}

export type DynamicYearRow = {
  year: number;
  agePrimary: number;
  ageSpouse: number | null;
  phase: DynamicPhase;
  policyKey: string;
  policyName: string;
  drawOrder: string;
  windowStopAge: number;
  spending: number;
  ss: number;
  rmd: number;
  rmdPrimary: number;
  rmdSpouse: number;
  pretaxDraw: number;
  taxableSoldForSpending: number;
  taxableSoldForTax: number;
  rothDraw: number;
  conversion: number;
  federalTax: number;
  stateTax: number;
  penalty: number;
  irmaa: number;
  acaCreditKept: number;
  healthPremiumGross: number;
  magi: number;
  acaMagi: number;
  acaCliff: number | null;
  taxableIncome: number;
  bracketPct: number;
  pretaxEnd: number;
  pretaxPrimaryEnd: number;
  pretaxSpouseEnd: number;
  rothEnd: number;
  taxableEnd: number;
  taxableBasisEnd: number;
  hsaEnd: number;
  settlementConverged: boolean;
  spendShortfall: number;
  unpaidTax: number;
  earlyWithdrawalEligibilityUnknown: boolean;
  rothBasisUnknown: boolean;
  /** The year's net-cost contribution (tax + penalty + IRMAA +
      gross health premium − ACA credit − refundable education
      credit); the terminal term is scored once, at the end. */
  netCostYear: number;
};

export type DynamicOptimizerResult = {
  ok: boolean;
  reason?: string;
  years: DynamicYearRow[];
  policiesEvaluatedPerYear: number;
  lifetimeNetCost: number;
  lifetimeFederalTax: number;
  lifetimeStateTax: number;
  lifetimePenalty: number;
  lifetimeIrmaa: number;
  lifetimeAcaCreditKept: number;
  lifetimeHealthPremiumGross: number;
  lifetimeRmd: number;
  firstRmdYear: number | null;
  conversionsTotal: number;
  spendShortfallTotal: number;
  unpaidTaxTotal: number;
  endingPretax: number;
  endingRoth: number;
  endingTaxable: number;
  endingHsa: number;
  endingWealth: number;
  terminal: ReturnType<typeof dynamicTerminalTax>;
  endingAfterTaxWealth: number;
  /** Step-up at death (terminal phase): the taxable balance's
      unrealized gain, the heir tax on it WITHOUT a step-up
      (heir rate × gain — an approximation: the heirs' own rate
      is unknown, so the heir rate input is used and the
      assumption is stated), and wealth with / without it. */
  stepUp: {
    unrealizedGains: number;
    heirTaxWithoutStepUp: number;
    wealthWithStepUp: number;
    wealthWithoutStepUp: number;
  };
  /** The best valid FIXED policy over the same policy set,
      priced as one full-horizon march each. The dynamic result
      is never worse than this on net cost (see floorBound). */
  bestFixed: { policyKey: string; policyName: string; netCost: number; endingWealth: number } | null;
  /** True when the greedy trajectory scored worse than the
      best fixed policy and the fixed trajectory was returned
      instead. The greedy figures are still reported below. */
  floorBound: boolean;
  greedyNetCost: number;
  greedyEndingWealth: number;
  /** The raw greedy trajectory's rows — identical to `years`
      when the floor did not bind; the trajectory the floor
      replaced when it did. Reported so the floor is auditable,
      never silent. */
  greedyYears: DynamicYearRow[];
  /** Every year settled, no shortfall, no unpaid tax. */
  valid: boolean;
  searchLimits: string;
};

type DynamicLedgerState = {
  pretaxP: number;
  pretaxS: number;
  roth: number;
  taxable: number;
  taxableBasis: number;
  hsa: number;
  eligP: number | null;
  eligS: number | null;
  rothContribP: number | null;
  rothContribS: number | null;
  rothLotsP: RothConversionLotInput[];
  rothLotsS: RothConversionLotInput[];
  rmdDeferredPendingP: number;
  rmdDeferredPendingS: number;
  firstRmdPriced: boolean;
};

function dynamicReanchorInputs(
  base: RothPlanInputs,
  state: DynamicLedgerState,
  year: number,
  policy: DynamicPolicy,
  annualSpending: number,
): RothPlanInputs {
  const taxableBasisPct =
    state.taxable > 0 ? (state.taxableBasis / state.taxable) * 100 : 100;
  return {
    ...base,
    startYear: year,
    pretaxStart: state.pretaxP,
    pretaxSpouseStart: state.pretaxS,
    rothStart: state.roth,
    taxableStart: state.taxable,
    taxableBasisPct,
    hsaStart: state.hsa,
    annualSpending,
    // retirementAge and windowStartAge stay the plan's own:
    // the re-anchored march must respect the plan's
    // conversion window (no conversions before its start) and
    // its retirement age exactly as the original march does —
    // overriding either would let the dynamic year convert in
    // years the fixed policies cannot, and the fixed-vs-
    // dynamic comparison would stop being a fair one.
    windowStopAge: policy.windowStopAge,
    drawOrder: [...policy.drawOrder],
    pretax401kEligiblePrimary: state.eligP,
    pretax401kEligibleSpouse: state.eligS,
    rothContributionBasisPrimary: state.rothContribP,
    rothContributionBasisSpouse: state.rothContribS,
    rothConversionLotsPrimary: state.rothLotsP.length > 0 ? state.rothLotsP : null,
    rothConversionLotsSpouse: state.rothLotsS.length > 0 ? state.rothLotsS : null,
    // A first-RMD deferral already priced in a chosen year must
    // not defer again: the flag is off once the first RMD year
    // has been priced, and any amount still pending is carried
    // in as owed in this march's first year.
    firstRmdDeferralPrimary: state.firstRmdPriced ? false : base.firstRmdDeferralPrimary,
    firstRmdDeferralSpouse: state.firstRmdPriced ? false : base.firstRmdDeferralSpouse,
    firstRmdDeferredCarryPrimary: state.rmdDeferredPendingP,
    firstRmdDeferredCarrySpouse: state.rmdDeferredPendingS,
  };
}

/* Debit a Roth draw against the tracked ledgers in the
   engine's ordering (contributions, then conversion lots
   FIFO, then earnings as the residual): returns the updated
   contribution basis and lots. Lots created by this module
   are fully taxable conversions (nontaxable $0), so a lot's
   remaining taxable amount IS its remaining balance. */
function dynamicDebitRothDraw(
  contrib: number | null,
  lots: RothConversionLotInput[],
  draw: number,
): { contrib: number | null; lots: RothConversionLotInput[] } {
  if (draw <= 0) return { contrib, lots };
  let remaining = draw;
  let nextContrib = contrib;
  if (nextContrib != null && nextContrib > 0) {
    const take = Math.min(nextContrib, remaining);
    nextContrib -= take;
    remaining -= take;
  }
  const nextLots: RothConversionLotInput[] = [];
  for (const lot of lots) {
    if (remaining <= 0) {
      nextLots.push(lot);
      continue;
    }
    const lotTotal = lot.taxableAmount + lot.nontaxableAmount;
    const take = Math.min(lotTotal, remaining);
    remaining -= take;
    const left = lotTotal - take;
    if (left > 0.005) {
      // The taxable share of what is left keeps the lot's
      // original taxable proportion (a fully-taxable lot
      // stays fully taxable).
      const taxableShare = lotTotal > 0 ? lot.taxableAmount / lotTotal : 1;
      nextLots.push({
        year: lot.year,
        taxableAmount: r2(left * taxableShare),
        nontaxableAmount: r2(left * (1 - taxableShare)),
      });
    }
  }
  return { contrib: nextContrib, lots: nextLots };
}

function dynamicRowFromYear(
  y: RothYear,
  policy: DynamicPolicy,
  taxableBasisEnd: number,
  rmdAge: number,
  ssStartAge: number | null,
): DynamicYearRow {
  const f = y.funding;
  const d = y.detail;
  return {
    year: y.year,
    agePrimary: y.agePrimary,
    ageSpouse: y.ageSpouse,
    phase: dynamicPhaseForYear({
      agePrimary: y.agePrimary,
      isSurvivorYear: y.isSurvivorYear,
      rmdAge,
      ssStartAge,
    }),
    policyKey: policy.key,
    policyName: policy.name,
    drawOrder: drawOrderKey(policy.drawOrder),
    windowStopAge: policy.windowStopAge,
    spending: f.spending,
    ss: f.ss,
    rmd: f.rmd,
    rmdPrimary: d.rmdPrimary,
    rmdSpouse: d.rmdSpouse,
    pretaxDraw: f.pretaxDraw,
    taxableSoldForSpending: f.taxableSoldForSpending,
    taxableSoldForTax: f.taxableSoldForTax,
    rothDraw: f.rothDraw,
    conversion: f.conversion,
    federalTax: y.federalTax,
    stateTax: y.stateTax,
    penalty: y.penalty,
    irmaa: y.irmaaPaid,
    acaCreditKept: y.acaCreditKept,
    healthPremiumGross: y.healthPremiumGross,
    magi: y.magi,
    acaMagi: y.acaMagi,
    acaCliff: d.aca.cliff,
    taxableIncome: y.taxableIncome,
    bracketPct: y.bracketPct,
    pretaxEnd: y.pretaxEnd,
    pretaxPrimaryEnd: y.pretaxPrimaryEnd,
    pretaxSpouseEnd: y.pretaxSpouseEnd,
    rothEnd: y.rothEnd,
    taxableEnd: y.taxableEnd,
    taxableBasisEnd,
    hsaEnd: y.hsaEnd,
    settlementConverged: y.settlementConverged,
    spendShortfall: f.spendShortfall,
    unpaidTax: f.unpaidTax,
    earlyWithdrawalEligibilityUnknown: y.earlyWithdrawalEligibilityUnknown,
    rothBasisUnknown: y.rothBasisUnknown,
    netCostYear: r2(
      y.federalTax + y.stateTax + y.penalty + y.irmaaPaid + y.healthPremiumGross -
        y.acaCreditKept - y.educationRefundable,
    ),
  };
}

/* Walk a priced march's years carrying the taxable-basis
   ledger forward (same rules as trackTaxableBasisEnd): the
   ending basis dollars of a fixed policy's march, from its own
   year rows. The caller supplies the march's starting taxable
   balance (the basis walk needs the year's start balance, and
   only the first year needs it from outside — later years
   start where the prior year ended). */
/* The year's reinvested yield income (dividend + interest),
   priced exactly as the march prices it: each yield percent
   applied to the year's START taxable balance and rounded to
   the cent, then summed. */
export function dynamicYieldForYear(args: {
  taxableStart: number;
  dividendYieldPct: number | null | undefined;
  interestYieldPct: number | null | undefined;
}): number {
  const div = Math.max(0, args.dividendYieldPct ?? 0);
  const int = Math.max(0, args.interestYieldPct ?? 0);
  return r2((args.taxableStart * div) / 100) + r2((args.taxableStart * int) / 100);
}

export function dynamicBasisWalkYears(
  years: readonly RothYear[],
  taxableStart: number,
  basisStart: number,
  growthFactor: number,
  dividendYieldPct: number | null | undefined,
  interestYieldPct: number | null | undefined,
): number {
  let basis = basisStart;
  let start = taxableStart;
  for (const y of years) {
    const sold = y.funding.taxableSoldForSpending + y.funding.taxableSoldForTax;
    basis = trackTaxableBasisEnd({
      taxableStart: start,
      basisStart: basis,
      taxableSold: sold,
      drawGains: y.detail.drawGains,
      taxableEnd: y.taxableEnd,
      growthFactor,
      yieldReinvested: dynamicYieldForYear({ taxableStart: start, dividendYieldPct, interestYieldPct }),
    });
    start = y.taxableEnd;
  }
  return basis;
}

export type DynamicFixedScored = {
  policy: DynamicPolicy;
  netCost: number;
  netCostExTerminal: number;
  endingWealth: number;
  endingPretax: number;
  endingRoth: number;
  endingTaxable: number;
  endingHsa: number;
  conversionsTotal: number;
  lifetimeAcaCreditKept: number;
  lifetimeRmd: number;
  integrityStatus: string;
  result: RothPlanResult;
};

/* Price every policy in the set as ONE full-horizon march
   each (the fixed-policy baseline the dynamic result is
   floored against and the sensitivity strips re-score).
   Invalid candidates (unsettled / shortfall / unpaid tax)
   are excluded, exactly as the optimizer excludes them. */
export function priceFixedDynamicPolicies(
  base: RothPlanInputs,
  policies: DynamicPolicy[],
): { best: DynamicFixedScored | null; scored: DynamicFixedScored[] } {
  const scored: DynamicFixedScored[] = [];
  for (const policy of policies) {
    const inputs: RothPlanInputs = {
      ...base,
      windowStopAge: policy.windowStopAge,
      drawOrder: [...policy.drawOrder],
    };
    const result = simulateRothPlan(
      inputs,
      { id: `dyn-${policy.key}`, name: policy.name, ceilings: policy.ceilings, guardrail: policy.guardrail },
      undefined,
      { leanDetail: true },
    );
    const integrity = assessCandidateIntegrity(result);
    if (integrity.status === "invalid") continue;
    const cost = planNetCost(result, inputs);
    scored.push({
      policy,
      netCost: cost.netCost,
      netCostExTerminal: r2(cost.netCost - cost.terminal),
      endingWealth: result.endingAfterTaxWealth,
      endingPretax: result.endingPretax,
      endingRoth: result.endingRoth,
      endingTaxable: result.endingTaxable,
      endingHsa: result.endingHsa,
      // RothPlanResult carries no lifetime conversion / RMD
      // totals — both are sums of the priced year rows.
      conversionsTotal: r2(result.years.reduce((s, y) => s + y.funding.conversion, 0)),
      lifetimeAcaCreditKept: result.lifetimeAcaKept,
      lifetimeRmd: r2(result.years.reduce((s, y) => s + y.funding.rmd, 0)),
      integrityStatus: integrity.status,
      result,
    });
  }
  scored.sort(
    (a, b) =>
      a.netCost - b.netCost ||
      b.endingWealth - a.endingWealth ||
      (a.policy.key < b.policy.key ? -1 : a.policy.key > b.policy.key ? 1 : 0),
  );
  return { best: scored[0] ?? null, scored };
}

/* Re-score a priced fixed-policy set under a DIFFERENT
   terminal assumption (heir rate / preserve floor) WITHOUT
   re-marching: the march does not depend on the terminal
   parameters (no preserve-cap ceiling is in the policy set),
   so only the terminal term moves. Returns the ranking under
   the new assumption, best first. */
export function rescoreDynamicTerminal(
  scored: readonly DynamicFixedScored[],
  args: { heirRatePct: number; preservePretax?: number; preserveExitRatePct?: number },
): { policyKey: string; policyName: string; netCost: number; endingWealth: number }[] {
  return scored
    .map((s) => {
      const term = dynamicTerminalTax({
        endingPretax: s.endingPretax,
        heirRatePct: args.heirRatePct,
        preservePretax: args.preservePretax,
        preserveExitRatePct: args.preserveExitRatePct,
      });
      return {
        policyKey: s.policy.key,
        policyName: s.policy.name,
        netCost: r2(s.netCostExTerminal + term.terminal),
        endingWealth: r2(s.endingPretax + s.endingRoth + s.endingTaxable + s.endingHsa - term.terminal),
      };
    })
    .sort((a, b) => a.netCost - b.netCost || b.endingWealth - a.endingWealth);
}

const DYNAMIC_SEARCH_LIMITS =
  "Greedy roll-forward over 114 fixed-fill policies per year (Do Nothing, Fill 12%/22% ± guardrail, Fill 22% IRMAA-1, Fill ACA-cliff × windows stop-65 / stop-year-before-RMD / through-RMD × all six draw orders), each priced over the remaining horizon by the shared engine; one year committed at a time; no per-year conversion amounts finer than a ceiling fill; no bunching, gain-harvest, or claiming-age search. No global-optimality claim.";

/* The fixed-policy floor triggers only past this gap (see the
   header note): re-anchor rounding noise is cents, a real
   greedy shortfall is dollars. */
export const DYNAMIC_FLOOR_EPSILON = 0.1;

function dynamicResultFromRows(args: {
  rows: DynamicYearRow[];
  base: RothPlanInputs;
  bestFixed: DynamicOptimizerResult["bestFixed"];
  floorBound: boolean;
  greedyNetCost: number;
  greedyEndingWealth: number;
  greedyYears: DynamicYearRow[];
  policiesEvaluatedPerYear: number;
}): DynamicOptimizerResult {
  const { rows, base } = args;
  const last = rows[rows.length - 1];
  const lifetimeNetCostExTerminal = r2(rows.reduce((s, r) => s + r.netCostYear, 0));
  const terminal = dynamicTerminalTax({
    endingPretax: last?.pretaxEnd ?? 0,
    heirRatePct: base.heirRatePct,
    preservePretax: base.preservePretax,
    preserveExitRatePct: base.preserveExitRatePct,
  });
  const endingWealth = r2(
    (last?.pretaxEnd ?? 0) + (last?.rothEnd ?? 0) + (last?.taxableEnd ?? 0) + (last?.hsaEnd ?? 0),
  );
  const unrealizedGains = Math.max(0, r2((last?.taxableEnd ?? 0) - (last?.taxableBasisEnd ?? 0)));
  const heirTaxWithoutStepUp = r2((unrealizedGains * base.heirRatePct) / 100);
  const endingAfterTaxWealth = r2(endingWealth - terminal.terminal);
  return {
    ok: true,
    years: rows,
    policiesEvaluatedPerYear: args.policiesEvaluatedPerYear,
    lifetimeNetCost: r2(lifetimeNetCostExTerminal + terminal.terminal),
    lifetimeFederalTax: r2(rows.reduce((s, r) => s + r.federalTax, 0)),
    lifetimeStateTax: r2(rows.reduce((s, r) => s + r.stateTax, 0)),
    lifetimePenalty: r2(rows.reduce((s, r) => s + r.penalty, 0)),
    lifetimeIrmaa: r2(rows.reduce((s, r) => s + r.irmaa, 0)),
    lifetimeAcaCreditKept: r2(rows.reduce((s, r) => s + r.acaCreditKept, 0)),
    lifetimeHealthPremiumGross: r2(rows.reduce((s, r) => s + r.healthPremiumGross, 0)),
    lifetimeRmd: r2(rows.reduce((s, r) => s + r.rmd, 0)),
    firstRmdYear: rows.find((r) => r.rmd > 0)?.year ?? null,
    conversionsTotal: r2(rows.reduce((s, r) => s + r.conversion, 0)),
    spendShortfallTotal: r2(rows.reduce((s, r) => s + r.spendShortfall, 0)),
    unpaidTaxTotal: r2(rows.reduce((s, r) => s + r.unpaidTax, 0)),
    endingPretax: last?.pretaxEnd ?? 0,
    endingRoth: last?.rothEnd ?? 0,
    endingTaxable: last?.taxableEnd ?? 0,
    endingHsa: last?.hsaEnd ?? 0,
    endingWealth,
    terminal,
    endingAfterTaxWealth,
    stepUp: {
      unrealizedGains,
      heirTaxWithoutStepUp,
      wealthWithStepUp: endingAfterTaxWealth,
      wealthWithoutStepUp: r2(endingAfterTaxWealth - heirTaxWithoutStepUp),
    },
    bestFixed: args.bestFixed,
    floorBound: args.floorBound,
    greedyNetCost: args.greedyNetCost,
    greedyEndingWealth: args.greedyEndingWealth,
    greedyYears: args.greedyYears,
    valid: rows.every((r) => r.settlementConverged && r.spendShortfall === 0 && r.unpaidTax === 0),
    searchLimits: DYNAMIC_SEARCH_LIMITS,
  };
}

function dynamicRowsFromFixedMarch(
  result: RothPlanResult,
  policy: DynamicPolicy,
  base: RothPlanInputs,
  basisStart: number,
): DynamicYearRow[] {
  const growthFactor = Math.max(0, 1 + base.expectedReturnPct / 100);
  const rmdAge = Math.ceil(rmdAgeForBirthYear(base.birthYearPrimary));
  const ssStartAge = base.ssPrimaryStartAge ?? null;
  const rows: DynamicYearRow[] = [];
  let basis = basisStart;
  let taxableStart = base.taxableStart;
  for (const y of result.years) {
    const sold = y.funding.taxableSoldForSpending + y.funding.taxableSoldForTax;
    basis = trackTaxableBasisEnd({
      taxableStart,
      basisStart: basis,
      taxableSold: sold,
      drawGains: y.detail.drawGains,
      taxableEnd: y.taxableEnd,
      growthFactor,
      yieldReinvested: dynamicYieldForYear({
        taxableStart,
        dividendYieldPct: base.taxableDividendYieldPct,
        interestYieldPct: base.taxableInterestYieldPct,
      }),
    });
    rows.push(dynamicRowFromYear(y, policy, basis, rmdAge, ssStartAge));
    taxableStart = y.taxableEnd;
  }
  return rows;
}

export function runDynamicOptimizer(
  base: RothPlanInputs,
  opts?: { annualSpending?: number; policies?: DynamicPolicy[] },
): DynamicOptimizerResult {
  const annualSpending = opts?.annualSpending ?? base.annualSpending;
  const rmdAge = Math.ceil(rmdAgeForBirthYear(base.birthYearPrimary));
  const policies = opts?.policies ?? dynamicPolicySet(rmdAge - 1, base.endAgePrimary);
  const growthFactor = Math.max(0, 1 + base.expectedReturnPct / 100);
  const ssStartAge = base.ssPrimaryStartAge ?? null;

  const state: DynamicLedgerState = {
    pretaxP: base.pretaxStart,
    pretaxS: base.pretaxSpouseStart ?? 0,
    roth: base.rothStart,
    taxable: base.taxableStart,
    taxableBasis: (base.taxableBasisPct / 100) * base.taxableStart,
    hsa: base.hsaStart,
    eligP: base.pretax401kEligiblePrimary ?? null,
    eligS: base.pretax401kEligibleSpouse ?? null,
    rothContribP: base.rothContributionBasisPrimary ?? null,
    rothContribS: base.rothContributionBasisSpouse ?? null,
    rothLotsP: (base.rothConversionLotsPrimary ?? []).map((l) => ({ ...l })),
    rothLotsS: (base.rothConversionLotsSpouse ?? []).map((l) => ({ ...l })),
    rmdDeferredPendingP: base.firstRmdDeferredCarryPrimary ?? 0,
    rmdDeferredPendingS: base.firstRmdDeferredCarrySpouse ?? 0,
    firstRmdPriced: false,
  };

  const rows: DynamicYearRow[] = [];
  let sunkNetCost = 0;
  for (let year = base.startYear; ; year++) {
    const agePrimary = year - base.birthYearPrimary;
    if (agePrimary > base.endAgePrimary) break;
    let best: { policy: DynamicPolicy; total: number; result: RothPlanResult; reanchored: RothPlanInputs } | null = null;
    for (const policy of policies) {
      const reanchored = dynamicReanchorInputs(base, state, year, policy, annualSpending);
      const result = simulateRothPlan(
        reanchored,
        { id: `dyn-${policy.key}`, name: policy.name, ceilings: policy.ceilings, guardrail: policy.guardrail },
        undefined,
        { leanDetail: true },
      );
      const integrity = assessCandidateIntegrity(result);
      if (integrity.status === "invalid") continue;
      const cost = planNetCost(result, reanchored);
      const total = r2(sunkNetCost + cost.netCost);
      if (
        best == null ||
        total < best.total - 0.005 ||
        (Math.abs(total - best.total) <= 0.005 &&
          (result.endingAfterTaxWealth > best.result.endingAfterTaxWealth + 0.005 ||
            (Math.abs(result.endingAfterTaxWealth - best.result.endingAfterTaxWealth) <= 0.005 &&
              policy.key < best.policy.key)))
      ) {
        best = { policy, total, result, reanchored };
      }
    }
    if (best == null) {
      return {
        ok: false,
        reason: `No valid policy priced for ${year}: every candidate in the dynamic set was invalid (unsettled, shortfall, or unpaid tax).`,
        years: rows,
        policiesEvaluatedPerYear: policies.length,
        lifetimeNetCost: 0,
        lifetimeFederalTax: 0,
        lifetimeStateTax: 0,
        lifetimePenalty: 0,
        lifetimeIrmaa: 0,
        lifetimeAcaCreditKept: 0,
        lifetimeHealthPremiumGross: 0,
        lifetimeRmd: 0,
        firstRmdYear: null,
        conversionsTotal: 0,
        spendShortfallTotal: 0,
        unpaidTaxTotal: 0,
        endingPretax: 0,
        endingRoth: 0,
        endingTaxable: 0,
        endingHsa: 0,
        endingWealth: 0,
        terminal: dynamicTerminalTax({ endingPretax: 0, heirRatePct: base.heirRatePct }),
        endingAfterTaxWealth: 0,
        stepUp: { unrealizedGains: 0, heirTaxWithoutStepUp: 0, wealthWithStepUp: 0, wealthWithoutStepUp: 0 },
        bestFixed: null,
        floorBound: false,
        greedyNetCost: 0,
        greedyEndingWealth: 0,
        greedyYears: [],
        valid: false,
        searchLimits: DYNAMIC_SEARCH_LIMITS,
      };
    }
    const y0 = best.result.years[0];
    if (!y0) {
      return {
        ok: false,
        reason: `The winning remaining-horizon march for ${year} priced no years.`,
        years: rows,
        policiesEvaluatedPerYear: policies.length,
        lifetimeNetCost: 0,
        lifetimeFederalTax: 0,
        lifetimeStateTax: 0,
        lifetimePenalty: 0,
        lifetimeIrmaa: 0,
        lifetimeAcaCreditKept: 0,
        lifetimeHealthPremiumGross: 0,
        lifetimeRmd: 0,
        firstRmdYear: null,
        conversionsTotal: 0,
        spendShortfallTotal: 0,
        unpaidTaxTotal: 0,
        endingPretax: 0,
        endingRoth: 0,
        endingTaxable: 0,
        endingHsa: 0,
        endingWealth: 0,
        terminal: dynamicTerminalTax({ endingPretax: 0, heirRatePct: base.heirRatePct }),
        endingAfterTaxWealth: 0,
        stepUp: { unrealizedGains: 0, heirTaxWithoutStepUp: 0, wealthWithStepUp: 0, wealthWithoutStepUp: 0 },
        bestFixed: null,
        floorBound: false,
        greedyNetCost: 0,
        greedyEndingWealth: 0,
        greedyYears: [],
        valid: false,
        searchLimits: DYNAMIC_SEARCH_LIMITS,
      };
    }
    const sold = y0.funding.taxableSoldForSpending + y0.funding.taxableSoldForTax;
    const basisEnd = trackTaxableBasisEnd({
      taxableStart: state.taxable,
      basisStart: state.taxableBasis,
      taxableSold: sold,
      drawGains: y0.detail.drawGains,
      taxableEnd: y0.taxableEnd,
      growthFactor,
      yieldReinvested: dynamicYieldForYear({
        taxableStart: state.taxable,
        dividendYieldPct: base.taxableDividendYieldPct,
        interestYieldPct: base.taxableInterestYieldPct,
      }),
    });
    const row = dynamicRowFromYear(y0, best.policy, basisEnd, rmdAge, ssStartAge);
    rows.push(row);
    sunkNetCost = r2(sunkNetCost + row.netCostYear);
    // Advance the ledgers from the priced year's outputs.
    const eligP = trackEligibleEnd({
      eligibleStart: state.eligP,
      pretaxStart: state.pretaxP,
      pretaxEnd: y0.pretaxPrimaryEnd,
      growthFactor,
    });
    const eligS = trackEligibleEnd({
      eligibleStart: state.eligS,
      pretaxStart: state.pretaxS,
      pretaxEnd: y0.pretaxSpouseEnd,
      growthFactor,
    });
    // Roth draws debit the primary's ledgers first, then the
    // spouse's (the conversion attribution below is primary-
    // first too, matching the engine's conversion order, and
    // is exact whenever the spouse's pre-tax balance is $0).
    let rothDrawLeft = y0.funding.rothDraw;
    const debitP = dynamicDebitRothDraw(state.rothContribP, state.rothLotsP, rothDrawLeft);
    rothDrawLeft = Math.max(
      0,
      rothDrawLeft -
        ((state.rothContribP ?? 0) - (debitP.contrib ?? 0)) -
        (state.rothLotsP.reduce((s, l) => s + l.taxableAmount + l.nontaxableAmount, 0) -
          debitP.lots.reduce((s, l) => s + l.taxableAmount + l.nontaxableAmount, 0)),
    );
    const debitS = dynamicDebitRothDraw(state.rothContribS, state.rothLotsS, rothDrawLeft);
    let lotsP = debitP.lots;
    let lotsS = debitS.lots;
    if (y0.funding.conversion > 0) {
      const primaryConverted = Math.min(
        y0.funding.conversion,
        Math.max(0, state.pretaxP - y0.detail.rmdPrimary),
      );
      const spouseConverted = Math.max(0, y0.funding.conversion - primaryConverted);
      if (primaryConverted > 0.005) {
        lotsP = [...lotsP, { year, taxableAmount: r2(primaryConverted), nontaxableAmount: 0 }];
      }
      if (spouseConverted > 0.005) {
        lotsS = [...lotsS, { year, taxableAmount: r2(spouseConverted), nontaxableAmount: 0 }];
      }
    }
    state.pretaxP = y0.pretaxPrimaryEnd;
    state.pretaxS = y0.pretaxSpouseEnd;
    state.roth = y0.rothEnd;
    state.taxable = y0.taxableEnd;
    state.taxableBasis = basisEnd;
    state.hsa = y0.hsaEnd;
    state.eligP = eligP;
    state.eligS = eligS;
    state.rothContribP = debitP.contrib;
    state.rothContribS = debitS.contrib;
    state.rothLotsP = lotsP;
    state.rothLotsS = lotsS;
    state.rmdDeferredPendingP = y0.detail.rmdDeferredPrimary;
    state.rmdDeferredPendingS = y0.detail.rmdDeferredSpouse;
    if (y0.rmd > 0 || agePrimary >= rmdAge) state.firstRmdPriced = true;
  }

  const greedyRows = rows;
  const greedyTerminal = dynamicTerminalTax({
    endingPretax: greedyRows[greedyRows.length - 1]?.pretaxEnd ?? 0,
    heirRatePct: base.heirRatePct,
    preservePretax: base.preservePretax,
    preserveExitRatePct: base.preserveExitRatePct,
  });
  const greedyNetCost = r2(sunkNetCost + greedyTerminal.terminal);
  const greedyEndingWealth = r2(
    (greedyRows[greedyRows.length - 1]?.pretaxEnd ?? 0) +
      (greedyRows[greedyRows.length - 1]?.rothEnd ?? 0) +
      (greedyRows[greedyRows.length - 1]?.taxableEnd ?? 0) +
      (greedyRows[greedyRows.length - 1]?.hsaEnd ?? 0) -
      greedyTerminal.terminal,
  );

  // The fixed-policy floor: the best valid fixed policy over
  // the same set, priced as full-horizon marches. The dynamic
  // result is never worse than it on net cost.
  const fixed = priceFixedDynamicPolicies(
    { ...base, annualSpending },
    policies,
  );
  const bestFixed = fixed.best
    ? {
        policyKey: fixed.best.policy.key,
        policyName: fixed.best.policy.name,
        netCost: fixed.best.netCost,
        endingWealth: fixed.best.endingWealth,
      }
    : null;
  if (bestFixed && fixed.best && bestFixed.netCost < greedyNetCost - DYNAMIC_FLOOR_EPSILON) {
    const floorRows = dynamicRowsFromFixedMarch(
      fixed.best.result,
      fixed.best.policy,
      { ...base, annualSpending },
      (base.taxableBasisPct / 100) * base.taxableStart,
    );
    return dynamicResultFromRows({
      rows: floorRows,
      base: { ...base, annualSpending },
      bestFixed,
      floorBound: true,
      greedyNetCost,
      greedyEndingWealth,
      greedyYears: greedyRows,
      policiesEvaluatedPerYear: policies.length,
    });
  }
  return dynamicResultFromRows({
    rows: greedyRows,
    base: { ...base, annualSpending },
    bestFixed,
    floorBound: false,
    greedyNetCost,
    greedyEndingWealth,
    greedyYears: greedyRows,
    policiesEvaluatedPerYear: policies.length,
  });
}

/* ---------------- A-vs-B equal-income-budget experiment ---------
   For one spending target (the year's income need), three ways
   to fund it, all priced by the shared engine on the same
   inputs:
   A — traditional spending: pre-tax-first draw order, no
       conversions (the $100K comes out of the 401(k)/IRA).
   B — taxable spending + Roth conversions: taxable-first draw
       order with a Fill-12% conversion (the $100K of spending
       comes from taxable sales while $100K converts to Roth).
   C — blended: the dynamic optimizer at this spending target
       (year-by-year re-optimization, floored at the best fixed
       policy — so C is never worse than the better of A/B's
       policy family on net cost).
   The $100K central question is answered by the $100K target's
   year-1 rows: the same $100K of ordinary income either way,
   but B also realizes the taxable sale's gains and consumes
   ACA MAGI headroom, while A leaves the taxable gains
   deferred. Targets run $0, $50K, $100K, $150K, $200K. */
export type DynamicAbTargetResult = {
  target: number;
  a: { netCost: number; endingWealth: number; conversionsTotal: number; lifetimeRmd: number; lifetimeAcaCreditKept: number; endingPretax: number; endingTaxable: number; endingRoth: number; unrealizedGains: number; wealthWithoutStepUp: number };
  b: { netCost: number; endingWealth: number; conversionsTotal: number; lifetimeRmd: number; lifetimeAcaCreditKept: number; endingPretax: number; endingTaxable: number; endingRoth: number; unrealizedGains: number; wealthWithoutStepUp: number };
  c: { netCost: number; endingWealth: number; conversionsTotal: number; lifetimeRmd: number; lifetimeAcaCreditKept: number; endingPretax: number; endingTaxable: number; endingRoth: number; unrealizedGains: number; wealthWithoutStepUp: number; floorBound: boolean };
};

function dynamicAbArm(
  result: RothPlanResult,
  base: RothPlanInputs,
  inputs: RothPlanInputs,
): DynamicAbTargetResult["a"] {
  const cost = planNetCost(result, inputs);
  const growthFactor = Math.max(0, 1 + base.expectedReturnPct / 100);
  const basisEnd = dynamicBasisWalkYears(
    result.years,
    base.taxableStart,
    (base.taxableBasisPct / 100) * base.taxableStart,
    growthFactor,
    base.taxableDividendYieldPct,
    base.taxableInterestYieldPct,
  );
  const unrealizedGains = Math.max(0, r2(result.endingTaxable - basisEnd));
  return {
    netCost: cost.netCost,
    endingWealth: result.endingAfterTaxWealth,
    conversionsTotal: r2(result.years.reduce((s, y) => s + y.funding.conversion, 0)),
    lifetimeRmd: r2(result.years.reduce((s, y) => s + y.funding.rmd, 0)),
    lifetimeAcaCreditKept: result.lifetimeAcaKept,
    endingPretax: result.endingPretax,
    endingTaxable: result.endingTaxable,
    endingRoth: result.endingRoth,
    unrealizedGains,
    wealthWithoutStepUp: r2(result.endingAfterTaxWealth - (unrealizedGains * base.heirRatePct) / 100),
  };
}

export function runDynamicAbExperiment(
  base: RothPlanInputs,
  targets: number[],
): DynamicAbTargetResult[] {
  const out: DynamicAbTargetResult[] = [];
  for (const target of targets) {
    const inputs = { ...base, annualSpending: target };
    const aResult = simulateRothPlan(
      { ...inputs, drawOrder: ["pretax", "taxable", "roth"] },
      { id: "ab-a", name: "A traditional spending", ceilings: null },
      undefined,
      { leanDetail: true },
    );
    const bResult = simulateRothPlan(
      { ...inputs, drawOrder: ["taxable", "roth", "pretax"] },
      { id: "ab-b", name: "B taxable spending + Fill 12% conversions", ceilings: { ...NO_CEILINGS, bracketTopPct: 12 } },
      undefined,
      { leanDetail: true },
    );
    const cResult = runDynamicOptimizer(inputs);
    const c = cResult.ok
      ? {
          netCost: cResult.lifetimeNetCost,
          endingWealth: cResult.endingAfterTaxWealth,
          conversionsTotal: cResult.conversionsTotal,
          lifetimeRmd: cResult.lifetimeRmd,
          lifetimeAcaCreditKept: cResult.lifetimeAcaCreditKept,
          endingPretax: cResult.endingPretax,
          endingTaxable: cResult.endingTaxable,
          endingRoth: cResult.endingRoth,
          unrealizedGains: cResult.stepUp.unrealizedGains,
          wealthWithoutStepUp: cResult.stepUp.wealthWithoutStepUp,
          floorBound: cResult.floorBound,
        }
      : {
          netCost: NaN,
          endingWealth: NaN,
          conversionsTotal: NaN,
          lifetimeRmd: NaN,
          lifetimeAcaCreditKept: NaN,
          endingPretax: NaN,
          endingTaxable: NaN,
          endingRoth: NaN,
          unrealizedGains: NaN,
          wealthWithoutStepUp: NaN,
          floorBound: false,
        };
    out.push({
      target,
      a: dynamicAbArm(aResult, base, { ...inputs, drawOrder: ["pretax", "taxable", "roth"] }),
      b: dynamicAbArm(bResult, base, { ...inputs, drawOrder: ["taxable", "roth", "pretax"] }),
      c,
    });
  }
  return out;
}

/* ---------------- ACA benchmark sensitivity (bias audit) -------
   Price the fixed-policy set (and, when asked, the dynamic
   optimizer) under each supplied ACA benchmark set and report
   the winner + credit kept per benchmark. The benchmark is the
   ONLY thing that changes between runs: the same balances,
   ages, spending, and policy set. A null benchmark prices no
   credit (the baseline's condition); a supplied couple
   benchmark prices the credit the cliff-capped policies keep.
   The dynamic re-run per benchmark is optional (it costs a
   full roll-forward each) — the fixed-set re-ranking is the
   audit's core, because the bias question is whether the
   RANKING moves when the credit is priced. */
export type DynamicAcaSensitivityRow = {
  label: string;
  acaBenchmarkCouple: number | null;
  acaBenchmarkSingle: number | null;
  acaBenchmarkFamily: number | null;
  bestFixedPolicyKey: string | null;
  bestFixedPolicyName: string | null;
  bestFixedNetCost: number | null;
  bestFixedEndingWealth: number | null;
  bestFixedAcaCreditKept: number | null;
  doNothingNetCost: number | null;
  doNothingAcaCreditKept: number | null;
  dynamicNetCost: number | null;
  dynamicEndingWealth: number | null;
  dynamicAcaCreditKept: number | null;
  dynamicFloorBound: boolean | null;
};

export function runDynamicAcaSensitivity(
  base: RothPlanInputs,
  benchmarks: { label: string; acaBenchmarkCouple: number | null; acaBenchmarkSingle: number | null; acaBenchmarkFamily: number | null }[],
  opts?: { runDynamic?: boolean },
): DynamicAcaSensitivityRow[] {
  const rmdAge = Math.ceil(rmdAgeForBirthYear(base.birthYearPrimary));
  const policies = dynamicPolicySet(rmdAge - 1, base.endAgePrimary);
  const rows: DynamicAcaSensitivityRow[] = [];
  for (const bench of benchmarks) {
    const inputs: RothPlanInputs = {
      ...base,
      acaBenchmarkCouple: bench.acaBenchmarkCouple,
      acaBenchmarkSingle: bench.acaBenchmarkSingle,
      acaBenchmarkFamily: bench.acaBenchmarkFamily,
    };
    const fixed = priceFixedDynamicPolicies(inputs, policies);
    const dn = fixed.scored.find((s) => s.policy.ceilings == null && s.policy.drawOrder[0] === "taxable");
    let dynamic: DynamicOptimizerResult | null = null;
    if (opts?.runDynamic === true) dynamic = runDynamicOptimizer(inputs);
    rows.push({
      label: bench.label,
      acaBenchmarkCouple: bench.acaBenchmarkCouple,
      acaBenchmarkSingle: bench.acaBenchmarkSingle,
      acaBenchmarkFamily: bench.acaBenchmarkFamily,
      bestFixedPolicyKey: fixed.best?.policy.key ?? null,
      bestFixedPolicyName: fixed.best?.policy.name ?? null,
      bestFixedNetCost: fixed.best?.netCost ?? null,
      bestFixedEndingWealth: fixed.best?.endingWealth ?? null,
      bestFixedAcaCreditKept: fixed.best?.lifetimeAcaCreditKept ?? null,
      doNothingNetCost: dn?.netCost ?? null,
      doNothingAcaCreditKept: dn?.lifetimeAcaCreditKept ?? null,
      dynamicNetCost: dynamic?.lifetimeNetCost ?? null,
      dynamicEndingWealth: dynamic?.endingAfterTaxWealth ?? null,
      dynamicAcaCreditKept: dynamic?.lifetimeAcaCreditKept ?? null,
      dynamicFloorBound: dynamic?.floorBound ?? null,
    });
  }
  return rows;
}
