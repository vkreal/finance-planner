// Gift-stock-to-a-child what-if — the plan-level comparison
// model for the Roth Conversion view's "Gift stock" tab. Pure
// functions only, shared by the runRothGiftCompare server
// action and the accuracy fixtures (server/src/taxFixtures.ts,
// gift-* cases), so the numbers the fixtures pin are computed
// by the exact code the tab runs.
//
// MODEL (per the settled design): the user describes ONE
// hypothetical gift of appreciated stock to ONE child. The plan
// is priced twice with the existing joint optimizer:
//   · BASELINE — the plan as saved, plus (only when a sale age
//     is set) the counterfactual sale: in the sale year the
//     parents sell the gifted shares themselves, and the gain —
//     the shares' value then, grown at the plan's expected
//     return from the gift year, minus the shares' basis — is
//     injected into that year's long-term gains stack, so the
//     shared engine prices it (bracket stacking, NIIT, ACA /
//     IRMAA MAGI, and the fill ceilings, which see the gain as
//     income occupying them). The injected position is capped
//     at the shares the baseline still holds at the start of
//     the sale year (v57, F6): if the no-gift plan has already
//     spent part of the position by then, the counterfactual
//     sale shrinks in the same proportion, basis included.
//   · WITH GIFT — the same plan with the shares removed from
//     the parents' Taxable bucket at the start of the gift
//     year (a one-time outflow that leaves the household; the
//     amount stops growing for the parents from that year).
//     The parcel's OWN basis leaves with the shares (v57, F1:
//     specific-lot semantics via the giftOutflowBasis seam),
//     not a pro-rata share of the pool's basis.
// The side ledgers (the child's own sale, the gift-tax
// exclusion, the step-up given up, the FAFSA watch-out) are
// priced here, never in the optimizer.
//
// The gift inputs are saved plan fields, but they are read
// ONLY by this comparison: planInputsFromSaved never sees
// them, and the two engine seams they use (giftOutflow /
// saleGain on RothPlanInputs) are set only in this module —
// the main Plan / Optimize / Compare / Work years runs price
// plans with neither seam set and are bit-identical to before.
//
// All money here is in DOLLARS (the tax engine's units); the
// saved gift inputs are cents and convert at the action
// boundary, like the other saved inputs.

import {
priceYear,
type RothPlanInputs,
type RothYear,
} from "./taxEngine";
import { lawForYear, type FilingStatus, type YearLaw } from "./taxLaw";
import {
claimAgeLabel,
runJointOptimizer,
type JointOptimizerResult,
} from "./rothOptimizer";

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* ---------------- Saved gift shape ----------------
   The seven gift fields as stored in the saved plan record
   (cents where money). This is the ONE parse of that stored
   shape: saveRothInputs writes it, getRothPlanner returns it
   (server/src/actions.ts imports this parse), and the
   accuracy fixtures pin its round-trip. Every
   field is nullable and null is preserved exactly — in
   particular giftKidStudent stays null ("never set") until the
   user actually sets the checkbox; it is NOT coerced to false
   on read, on hydration, or on save. */
export type RothGiftStored = {
  giftAge: number | null;
  giftAmountCents: number | null;
  giftBasisCents: number | null;
  giftKidBirthYear: number | null;
  giftKidStudent: boolean | null;
  giftKidOtherIncomeCents: number | null;
  giftSaleAge: number | null;
};

export const BLANK_ROTH_GIFT: RothGiftStored = {
  giftAge: null,
  giftAmountCents: null,
  giftBasisCents: null,
  giftKidBirthYear: null,
  giftKidStudent: null,
  giftKidOtherIncomeCents: null,
  giftSaleAge: null,
};

export function parseRothGift(raw: unknown): RothGiftStored {
  if (raw == null || typeof raw !== "object") return { ...BLANK_ROTH_GIFT };
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    giftAge: num(r.giftAge),
    giftAmountCents: num(r.giftAmountCents),
    giftBasisCents: num(r.giftBasisCents),
    giftKidBirthYear: num(r.giftKidBirthYear),
    giftKidStudent: typeof r.giftKidStudent === "boolean" ? r.giftKidStudent : null,
    giftKidOtherIncomeCents: num(r.giftKidOtherIncomeCents),
    giftSaleAge: num(r.giftSaleAge),
  };
}

/* ---------------- Age guards ----------------
   One guard implementation shared by the model
   (computeGiftComparison throws its message), the
   runRothGiftCompare action (which returns it as the run's
   reason, with no priced ledgers), and the Gift stock tab
   (which imports this same function, so the client and the
   server can never disagree about whether a description can
   be priced, or about the wording). All messages are plain
   and household-neutral. */
export function giftAgeGuardMessage(args: {
  startAge: number;
  endAge: number;
  giftAge: number;
  saleAge: number;
  kidBirthYear: number | null;
  saleYear: number;
}): string | null {
  if (args.giftAge < args.startAge || args.giftAge > args.endAge) {
    return `The gift age is outside the plan's years — enter an age from ${args.startAge} to ${args.endAge}, the years this plan covers.`;
  }
  if (args.saleAge < args.giftAge) {
    return "The sale age can't be earlier than the gift age — the shares are sold after they're given.";
  }
  if (args.saleAge < args.startAge || args.saleAge > args.endAge) {
    return `The sale age is outside the plan's years — enter an age from ${args.startAge} to ${args.endAge}, the years this plan covers.`;
  }
  if (args.kidBirthYear != null && args.kidBirthYear > args.saleYear) {
    return `The child's birth year is after the sale year — enter a birth year no later than ${args.saleYear}.`;
  }
  return null;
}

export function giftValidationError(
  plan: RothPlanInputs,
  gift: GiftParams,
): string | null {
  const startAge = plan.startYear - plan.birthYearPrimary;
  const giftAge = gift.giftAge ?? startAge;
  const saleAge = gift.saleAge ?? giftAge;
  const saleYear = plan.birthYearPrimary + saleAge;
  return giftAgeGuardMessage({
    startAge,
    endAge: plan.endAgePrimary,
    giftAge,
    saleAge,
    kidBirthYear: gift.kidBirthYear,
    saleYear,
  });
}

/* ---------------- The gift description ---------------- */

export type GiftParams = {
  // Primary's age in the gift year. Null = the plan's first
  // year (the age the plan starts at).
  giftAge: number | null;
  // Value of the gifted shares in the gift year, dollars.
  amount: number;
  // Total cost basis in the gifted shares, dollars (the child
  // inherits it — carryover basis).
  basis: number;
  // The child's birth year. Null = the child's side cannot be
  // priced (no age, so no kiddie-tax gate can be applied).
  kidBirthYear: number | null;
  // The child is a full-time student (drives the under-24
  // kiddie-tax gate).
  kidStudent: boolean;
  // The child's own other income in the sale year, dollars —
  // priced as ordinary income on their standalone return.
  kidOtherIncome: number;
  // Primary's age in the year the shares are sold. Null = no
  // sale is priced on either side: the parents' comparison
  // then reflects the balance and draw-order effects only,
  // and the child's sale is priced as of the gift year.
  saleAge: number | null;
};

/* ---------------- Result shapes ---------------- */

export type GiftPlanSide = {
  winnerName: string;
  claimLabel: string;
  claimPrimaryAge: number | null;
  // Lifetime net cost on the optimizer's objective (dollars).
  netCost: number;
  // Parents' ending after-tax wealth (dollars).
  endingAfterTax: number;
};

export type GiftComparison = {
  hasGift: boolean;
  giftAge: number;
  giftYear: number;
  // The amount the user typed, and the amount actually
  // modeled: the effective gift is the lesser of the typed
  // amount and the Taxable bucket's value at the start of
  // the gift year (you cannot gift shares the bucket does
  // not hold — modeling the full typed amount on the
  // child's side while the parents' side clamps at the
  // bucket would manufacture money). `capped` is true when
  // the two differ; every ledger (parents' outflow, the
  // child's value / gain, the gift-tax exclusion) prices
  // the EFFECTIVE amount, and the modeled basis scales in
  // the same proportion as the amount, so the parcel's
  // basis ratio is preserved.
  typedAmount: number;
  effectiveAmount: number;
  effectiveBasis: number;
  capped: boolean;
  taxableAtGiftYear: number;
  // True when a sale age was set, so the baseline prices the
  // parents' counterfactual sale and the child's sale is
  // priced in the sale year. False: no sale priced on either
  // side; the child's sale is priced as of the gift year.
  salePriced: boolean;
  saleAge: number;
  saleYear: number;
  baseline: GiftPlanSide;
  withGift: GiftPlanSide;
  // The child's sale ledger.
  child: {
    // The child's age in the sale year; null when no birth
    // year is entered (the child's tax is then not priced).
    kidAge: number | null;
    // Value of the shares in the sale year: the gift amount
    // grown at the plan's expected return from the gift year.
    valueAtSale: number;
    // Recognized gain (or loss, negative) on the child's
    // sale under the §1015 dual basis: gain measured from
    // the donor's carryover basis, loss measured from the
    // lower gift-date value, $0 between the two bases.
    gain: number;
    kiddieGate: boolean;
    // The law row's kiddie threshold for the sale year.
    kiddieThreshold: number;
    // The parents' marginal capital-gains rate (%) in the
    // baseline sale year — reported for display. When the
    // kiddie gate fires, the excess over the threshold is
    // priced by the Form 8615 stack (parentsAllocableCgTax),
    // whose top rate on the parents' return this is.
    parentsMarginalCgRate: number;
    // The child's federal tax on the sale (standalone
    // single-filer estimate); null when not priced.
    childTax: number | null;
    // Value at sale minus the child's tax.
    netToChild: number;
  };
  // The gift-tax ledger (gift year).
  giftTax: {
    exclusionPerDonor: number;
    donors: number;
    exclusionAvailable: number;
    excess: number;
    withinExclusion: boolean;
  };
  // True when the plan's college-years fields are set and the
  // child's sale year is a prior-prior year for a college fall
  // inside the span.
  fafsaApplies: boolean;
};

function sideOf(opt: JointOptimizerResult): GiftPlanSide {
  return {
    winnerName: opt.winner.spec.name,
    claimLabel: claimAgeLabel(opt.winner.claimAges),
    claimPrimaryAge: opt.winner.claimAges.primaryAge,
    netCost: opt.winner.cost.netCost,
    endingAfterTax: opt.winner.result.endingAfterTaxWealth,
  };
}

// The parents' marginal capital-gains rate (%) on the next
// dollar of gain in a priced year: where the year's ordinary
// income plus its gains already in taxable income sit on the
// gains staircase (0% space, then 15%, then 20%) under that
// year's law row and the filing status the year was priced
// under.
export function marginalCgRateForYear(row: RothYear): number {
  const law = lawForYear(row.year);
  const fs = row.filingStatus;
  const stackTop =
    row.detail.ordinaryTaxableIncome + row.detail.gainsInTaxableIncome;
  if (stackTop < law.ltcgZeroTop[fs]) return 0;
  if (stackTop < law.ltcg20Floor[fs]) return 15;
  return 20;
}

// The federal tax on a capital-gains stack, computed exactly
// as priceYear computes it (taxEngine.ts): ordinary taxable
// income fills the staircase first; the gains then price at
// 0% up to the year's ltcgZeroTop, 15% up to the ltcg20Floor,
// and 20% above, for a filing status under a law row.
export function cgStackTax(
  law: YearLaw,
  fs: FilingStatus,
  ordinaryTi: number,
  gainsInTi: number,
): number {
  const zeroSpace = Math.max(0, law.ltcgZeroTop[fs] - ordinaryTi);
  const at0 = Math.min(gainsInTi, zeroSpace);
  const afterZero = gainsInTi - at0;
  const twentySpace = Math.max(0, law.ltcg20Floor[fs] - ordinaryTi - at0);
  const at15 = Math.min(afterZero, twentySpace);
  const at20 = afterZero - at15;
  return 0.15 * at15 + 0.2 * at20;
}

// The parents' Form 8615 allocable tax on `excess` dollars of
// a child's net unearned income: the difference the excess
// makes to the parents' own gains-staircase tax when it is
// stacked on top of the parents' sale-year return — their
// WITH-GIFT year, the world where the child, not the
// parents, sells. Form 8615 (Tax for Certain Children Who
// Have Unearned Income, implementing IRC §1(g)) computes
// exactly this with-minus-without difference on the parents'
// return. (E3: the previous construction charged the
// parents' single top marginal rate on the whole excess,
// which overstates the tax whenever the excess straddles
// the parents' 0% boundary — the first dollars fill the
// parents' remaining 0% space at 0%, not at 15%.) Like the
// marginal-rate helper above, this prices the staircase
// only; the §1411 NIIT is not part of either figure.
export function parentsAllocableCgTax(
  parentsRow: RothYear,
  excess: number,
): number {
  if (excess <= 0) return 0;
  const law = lawForYear(parentsRow.year);
  const fs = parentsRow.filingStatus;
  const ordinaryTi = parentsRow.detail.ordinaryTaxableIncome;
  const gainsInTi = parentsRow.detail.gainsInTaxableIncome;
  return (
    cgStackTax(law, fs, ordinaryTi, gainsInTi + excess) -
    cgStackTax(law, fs, ordinaryTi, gainsInTi)
  );
}

export function computeGiftComparison(
  plan: RothPlanInputs,
  gift: GiftParams,
): GiftComparison {
  // Guards first: an out-of-window or inconsistent
  // description is never priced. The action pre-checks with
  // the same helper and returns the message with no ledgers;
  // a direct caller gets the same message as a thrown error.
  const validationError = giftValidationError(plan, gift);
  if (validationError) throw new Error(validationError);
  const startAge = plan.startYear - plan.birthYearPrimary;
  const giftAge = gift.giftAge ?? startAge;
  const giftYear = plan.birthYearPrimary + giftAge;
  const salePriced = gift.saleAge != null;
  const saleAge = gift.saleAge ?? giftAge;
  const saleYear = plan.birthYearPrimary + saleAge;
  const typedAmount = Math.max(0, gift.amount);
  const typedBasis = Math.max(0, gift.basis);
  const growthYears = Math.max(0, saleAge - giftAge);
  const growthFactor = Math.pow(1 + plan.expectedReturnPct / 100, growthYears);
  const valueFor = (amt: number): number => r2(amt * growthFactor);
  const gainFor = (amt: number, bas: number): number =>
    Math.max(0, r2(valueFor(amt) - bas));

  // The Taxable bucket's value at the start of the gift
  // year. In the plan's first year that is the starting
  // balance; in a later year it is the baseline winner's
  // Taxable balance at the end of the year before — which
  // needs a provisional baseline run priced with the typed
  // amount's sale gain (reused as the final baseline when
  // the gift turns out not to be capped).
  let taxableAtGiftYear: number;
  let provisionalBaseline: JointOptimizerResult | null = null;
  if (giftAge <= startAge) {
    taxableAtGiftYear = plan.taxableStart;
  } else {
    const provisionalGain = salePriced
      ? gainFor(typedAmount, typedBasis)
      : 0;
    provisionalBaseline = runJointOptimizer(
      salePriced && provisionalGain > 0
        ? { ...plan, saleGainAge: saleAge, saleGainAmount: provisionalGain }
        : plan,
    );
    const prevRow = provisionalBaseline.winner.result.years.find(
      (y) => y.agePrimary === giftAge - 1,
    );
    taxableAtGiftYear = prevRow ? prevRow.taxableEnd : plan.taxableStart;
  }
  const amount = r2(Math.min(typedAmount, Math.max(0, taxableAtGiftYear)));
  const capped = amount < typedAmount;
  const basis =
    typedAmount > 0 ? r2(typedBasis * (amount / typedAmount)) : typedBasis;
  const valueAtSale = valueFor(amount);
  const parentsGain = Math.max(0, r2(valueAtSale - basis));
  // The child's recognized gain/loss follows the §1015 dual
  // basis (v57, F3): the GAIN basis is the donor's (effective)
  // basis, but the LOSS basis is the lower of that basis and
  // the gift-date fair market value (the effective gift
  // amount). A sale above the gain basis recognizes the gain;
  // a sale below the loss basis recognizes the loss; a sale
  // between the two bases recognizes neither.
  const childLossBasis = Math.min(basis, amount);
  const childGain =
    valueAtSale > basis
      ? r2(valueAtSale - basis)
      : valueAtSale < childLossBasis
        ? r2(valueAtSale - childLossBasis)
        : 0;

  // F6 (v57) — cap the counterfactual sale at the shares the
  // baseline still holds in the sale year. The parents cannot
  // sell shares the no-gift plan has already spent: the
  // baseline's Taxable holdings at the start of the sale year
  // come from a NO-INJECTION baseline run (its winner's
  // Taxable balance at the end of the year before the sale
  // year; the plan's starting Taxable when the sale year is
  // the plan's first year). When the grown share value
  // exceeds those holdings, the counterfactual position
  // scales down in the same proportion, basis included.
  let baselineGain = parentsGain;
  if (salePriced && parentsGain > 0) {
    let holdings: number;
    if (saleAge <= startAge) {
      holdings = plan.taxableStart;
    } else {
      const noInjectionBaseline = runJointOptimizer(plan);
      const startRow = noInjectionBaseline.winner.result.years.find(
        (y) => y.agePrimary === saleAge - 1,
      );
      holdings = startRow ? startRow.taxableEnd : plan.taxableStart;
    }
    holdings = Math.max(0, holdings);
    if (valueAtSale > 0 && valueAtSale > holdings) {
      const remainingValue = Math.min(valueAtSale, holdings);
      baselineGain =
        remainingValue <= 0
          ? 0
          : Math.min(
              parentsGain,
              Math.max(
                0,
                r2(remainingValue - (basis * remainingValue) / valueAtSale),
              ),
            );
    }
  }

  // Baseline: the plan as saved, plus the (holdings-capped)
  // counterfactual sale gain in the sale year when a sale age
  // is set. The provisional run is reused only when it was
  // priced with exactly the final gain and the gift was not
  // capped — otherwise the baseline is priced fresh.
  const baselineOpt =
    !capped && baselineGain === parentsGain && provisionalBaseline
      ? provisionalBaseline
      : runJointOptimizer(
          salePriced && baselineGain > 0
            ? { ...plan, saleGainAge: saleAge, saleGainAmount: baselineGain }
            : plan,
        );
  // With gift: the shares leave the Taxable bucket at the
  // gift year, and the parcel's own (effective) basis leaves
  // with them (giftOutflowBasis). A blank / $0 effective gift
  // is the identity — the gift side IS the baseline run,
  // exactly.
  const withGiftOpt =
    amount > 0
      ? runJointOptimizer({
          ...plan,
          giftOutflowAge: giftAge,
          giftOutflowAmount: amount,
          giftOutflowBasis: basis,
        })
      : baselineOpt;

  // The parents' marginal capital-gains rate from the
  // baseline run's sale-year pricing (the winner's schedule).
  const saleRow =
    baselineOpt.winner.result.years.find((y) => y.agePrimary === saleAge) ??
    baselineOpt.winner.result.years[baselineOpt.winner.result.years.length - 1];
  const parentsMarginalCgRate = saleRow ? marginalCgRateForYear(saleRow) : 15;

  // The parents' own sale-year row in the WITH-GIFT run —
  // the return Form 8615 stacks the child's net unearned
  // income onto (in that world the parents did not sell;
  // the child did). Falls back to the run's last year, like
  // the baseline sale row above.
  const parentsRow =
    withGiftOpt.winner.result.years.find((y) => y.agePrimary === saleAge) ??
    withGiftOpt.winner.result.years[
      withGiftOpt.winner.result.years.length - 1
    ];

  // The child's sale: the tax ON THE SALE — the child's
  // standalone single-filer return priced twice, with the
  // gain and with the gain zeroed, and the difference
  // reported. (Pricing the return once, with the gain,
  // reports the tax on the child's whole return — their
  // other income's own tax included — which is not the tax
  // the sale causes: at a $0 gain the tax on the sale is
  // $0, however much other income the child has.) The gain
  // (carryover basis, floored at $0 for pricing — a loss
  // prices $0 of tax) sits on their own gains staircase.
  // When the kiddie gate fires, the gain above the law
  // row's kiddie threshold is priced the Form 8615 way
  // instead: the gain up to the threshold prices on the
  // child's own return, and the excess is the parents'
  // allocable tax — the with-minus-without difference of
  // stacking the excess onto the parents' own sale-year
  // return (parentsAllocableCgTax), so the excess fills
  // the parents' remaining 0% gains space before any of
  // it prices at 15% or 20%. The same with-minus-without
  // difference is then applied to that whole construction,
  // so the golden kiddie case (parents wholly inside the
  // 15% band, where the stack and the old flat rate agree,
  // and no other income, so the without-gain return is
  // $0) is unchanged.
  const kidAge = gift.kidBirthYear != null ? saleYear - gift.kidBirthYear : null;
  const kiddieGate =
    kidAge != null && (kidAge < 19 || (kidAge < 24 && gift.kidStudent));
  const kiddieThreshold = lawForYear(saleYear).kiddieTaxThresholdCents / 100;
  const gainTaxed = Math.max(0, childGain);
  let childTax: number | null = null;
  if (kidAge != null) {
    const priceChild = (ltcg: number): number =>
      priceYear({
        calendarYear: saleYear,
        filingStatus: "single",
        agePrimary: kidAge,
        ageSpouse: null,
        otherOrdinary: Math.max(0, gift.kidOtherIncome),
        rmd: 0,
        conversion: 0,
        extraPreTaxDraw: 0,
        ssBenefits: 0,
        taxExemptInterest: 0,
        ltcg,
        inflationPct: plan.inflationPct,
        // No state tax is priced for the child (disclosed).
        stateRatePct: 0,
      }).federalTax;
    const priceWithGain = (ltcg: number): number =>
      kiddieGate
        ? r2(
            priceChild(Math.min(ltcg, kiddieThreshold)) +
              (parentsRow
                ? parentsAllocableCgTax(
                    parentsRow,
                    Math.max(0, ltcg - kiddieThreshold),
                  )
                : (Math.max(0, ltcg - kiddieThreshold) *
                    parentsMarginalCgRate) /
                  100),
          )
        : priceChild(ltcg);
    childTax = r2(priceWithGain(gainTaxed) - priceWithGain(0));
  }

  // Gift-tax ledger: the gift year's annual exclusion per
  // donor, times the number of donors in the GIFT YEAR —
  // two when the plan files jointly that year (gift-splitting
  // between spouses), one otherwise. The count follows the
  // gift year's filing status, mirroring the march's
  // survivor switch (v57, F2): with a survivor scenario, the
  // death year itself still files jointly (two donors), but
  // every later year has one donor, because the survivor
  // files single from then on.
  const exclusionPerDonor =
    lawForYear(giftYear).giftAnnualExclusionCents / 100;
  const donors =
    plan.filingStatus === "mfj" &&
    !(
      plan.survivorEnabled === true &&
      plan.survivorDeathYear != null &&
      giftYear > plan.survivorDeathYear
    )
      ? 2
      : 1;
  const exclusionAvailable = exclusionPerDonor * donors;
  const excess = r2(Math.max(0, amount - exclusionAvailable));

  // FAFSA watch-out gate: the sale year is the prior-prior
  // year for the college fall two years later.
  const fafsaApplies =
    plan.collegeFallFromYear != null &&
    plan.collegeFallThroughYear != null &&
    plan.collegeFallFromYear <= saleYear + 2 &&
    saleYear + 2 <= plan.collegeFallThroughYear;

  return {
    hasGift: typedAmount > 0,
    giftAge,
    giftYear,
    typedAmount,
    effectiveAmount: amount,
    effectiveBasis: basis,
    capped,
    taxableAtGiftYear: r2(Math.max(0, taxableAtGiftYear)),
    salePriced,
    saleAge,
    saleYear,
    baseline: sideOf(baselineOpt),
    withGift: sideOf(withGiftOpt),
    child: {
      kidAge,
      valueAtSale,
      gain: childGain,
      kiddieGate,
      kiddieThreshold,
      parentsMarginalCgRate,
      childTax,
      netToChild: r2(valueAtSale - (childTax ?? 0)),
    },
    giftTax: {
      exclusionPerDonor,
      donors,
      exclusionAvailable,
      excess,
      withinExclusion: excess <= 0,
    },
    fafsaApplies,
  };
}
