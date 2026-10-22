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
//     years, alternate a big conversion year with a $0 year.
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
applyLossLedger,
ceilingsActive,
drawOrderFromKey,
drawOrderKey,
drawOrderLabel,
effectiveSsPrimaryAnnual,
effectiveSsSpouseAnnual,
fillConversion,
irmaaAnnualPerPerson,
priceYear,
rmdForYear,
simulateRothPlan,
type DrawOrder,
type EducationStudent,
type FilingStatus,
type FillCeilings,
type PriceYearInput,
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
lawForYear,
rmdAgeForBirthYear,
} from "./taxLaw";
import { irmaaTierUpTo } from "./taxEngine";

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* ---------------- Social Security claiming ages ----------------
   The entered benefit is the ANCHOR: the yearly amount the user
   entered, at the start age they entered. Any other claiming age
   is priced from the primary insurance amount (PIA) the anchor
   implies, using the statutory adjustments against the person's
   own full retirement age (FRA) from their birth year:
     · claiming before FRA reduces the benefit by 5/9 of 1% per
       month for the first 36 months early and 5/12 of 1% per
       month beyond that;
     · delaying past FRA adds 2/3 of 1% per month (8%/yr), with
       no credit past age 70.
   FRA by birth year (SSA): 1937 and earlier 65; 1938–1942 rise
   two months per year to 66; 1943–1954 are 66; 1955–1959 rise
   two months per year; 1960 or later are 67. */

// FRA in months from birth year.
export function fullRetirementAgeMonths(birthYear: number): number {
  if (birthYear >= 1960) return 67 * 12;
  if (birthYear >= 1955) return 66 * 12 + (birthYear - 1954) * 2;
  if (birthYear >= 1943) return 66 * 12;
  if (birthYear >= 1938) return 65 * 12 + (birthYear - 1937) * 2;
  return 65 * 12;
}

// Benefit at `claimAge` as a fraction of the PIA.
export function ssBenefitFactor(claimAge: number, birthYear: number): number {
  const fraMonths = fullRetirementAgeMonths(birthYear);
  const diff = Math.round(claimAge * 12) - fraMonths;
  if (diff < 0) {
    const early = -diff;
    const reduction =
      Math.min(early, 36) * (5 / 9 / 100) + Math.max(0, early - 36) * (5 / 12 / 100);
    return 1 - reduction;
  }
  if (diff > 0) {
    const delayed = Math.min(diff, 70 * 12 - fraMonths);
    return 1 + Math.max(0, delayed) * (2 / 3 / 100);
  }
  return 1;
}

// The yearly benefit at `claimAge` implied by an anchor benefit
// (`anchorAnnual` at `anchorAge`). Returns the anchor unchanged
// when the anchor age is missing or equals the claim age.
export function ssAnnualAtClaimAge(
  anchorAnnual: number,
  anchorAge: number | null,
  claimAge: number,
  birthYear: number,
): number {
  if (anchorAge == null || anchorAge === claimAge || anchorAnnual <= 0) {
    return anchorAnnual;
  }
  const anchorFactor = ssBenefitFactor(anchorAge, birthYear);
  if (anchorFactor <= 0) return anchorAnnual;
  const pia = anchorAnnual / anchorFactor;
  return r2(pia * ssBenefitFactor(claimAge, birthYear));
}

// Which claiming ages a scored candidate was priced at, and the
// yearly benefits those ages imply. `searched*` marks the
// spouses whose claiming age the joint search actually varied
// (only a spouse with an entered benefit is searched); for a
// fixed-age run both flags are false and the ages are the
// entered ones. `locked*` (Round-7 Build 3, N-1) marks a person
// whose benefit had already started at plan start — their
// entered claim age is the ONLY candidate age for them, because
// a claim that is already being paid cannot be changed.
// Optional so every pre-existing literal keeps its meaning:
// absent = not locked.
export type ClaimAgeInfo = {
  primaryAge: number | null;
  spouseAge: number | null;
  primaryAnnual: number;
  spouseAnnual: number;
  searchedPrimary: boolean;
  searchedSpouse: boolean;
  lockedPrimary?: boolean;
  lockedSpouse?: boolean;
};

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

// "You claim at 70 · Spouse claims at 67" — only the searched
// spouses appear; empty when neither benefit was entered.
export function claimAgeLabel(c: ClaimAgeInfo): string {
  const parts: string[] = [];
  if (c.searchedPrimary && c.primaryAge != null) parts.push(`You claim at ${c.primaryAge}`);
  if (c.searchedSpouse && c.spouseAge != null) parts.push(`Spouse claims at ${c.spouseAge}`);
  return parts.join(" · ");
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
    educationRefundable,
    amt,
    terminal,
    preservedPretax,
    terminalPreserved,
    excessPretax,
    terminalExcess,
    netCost: r2(tax + penalty + irmaa - acaCredit - educationRefundable + terminal),
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
  // The spending draw order this candidate is priced under.
  drawOrder: DrawOrder;
};

export type ScoredCandidate = {
  spec: OptimizerCandidateSpec;
  result: RothPlanResult;
  cost: NetCostBreakdown;
  // The claiming ages this candidate was priced at (the entered
  // ages for a fixed-age run; the combination's ages for a joint
  // run). A saved joint winner reproduces exactly by re-running
  // its strategy at these ages and amounts.
  claimAges: ClaimAgeInfo;
};

function fmtDollars(n: number): string {
  const neg = n < 0;
  const abs = Math.abs(Math.round(n));
  // Manual thousands grouping — identical output to
  // toLocaleString("en-US") for a non-negative integer, without
  // the ICU call (this runs while naming every candidate spec).
  let digits = String(abs);
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
  const add = (
    ceilings: FillCeilings,
    window: { kind: OptimizerWindowKind; stop: number },
    guardrail: boolean,
    bunching: boolean,
    drawOrder: DrawOrder,
  ) => {
    const key = [
      ceilingsKey(ceilings),
      window.stop,
      guardrail ? "gr" : "-",
      bunching ? "bu" : "-",
      drawOrderKey(drawOrder),
    ].join(":");
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      key,
      name: nameForCeilings(ceilings),
      ceilings,
      windowStopAge: window.stop,
      windowKind: window.kind,
      windowLabel: windowLabelFor(window.kind, inputs.windowStartAge, window.stop),
      guardrail,
      bunching,
      drawOrder,
    });
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
      claimAges,
    });
  }
  scored.sort((a, b) => compareScoredCandidates(a, b, planOrderKey));
  return scored;
}

export type OptimizerResult = {
  candidatesTested: number;
  doNothing: ScoredCandidate;
  winner: ScoredCandidate;
  // The next-best distinct candidates after the winner (up to 3).
  runnersUp: ScoredCandidate[];
  scored: ScoredCandidate[];
};

export function runOptimizer(
  inputs: RothPlanInputs,
  opts?: { searchOrders?: boolean },
): OptimizerResult {
  const scored = scoreAllCandidates(inputs, enteredClaimInfo(inputs), opts);
  const doNothing = scored.find((s) => s.spec.key === DO_NOTHING_SPEC.key) ?? scored[0]!;
  const winner = scored[0]!;
  return {
    candidatesTested: scored.length,
    doNothing,
    winner,
    runnersUp: scored.slice(1, 4),
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
   bit for bit as before. */

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
};

// One row of the per-claiming-age pricing table: the best
// FULLY-priced candidate found at one primary claiming age, the
// yearly benefit that age pays, and the yearly benefit a
// surviving spouse would keep at that age (the larger of the
// two claimed benefits under the row's best candidate — the
// amount the engine's survivor years continue). Present only
// for ages the joint search actually varied (the primary's
// ages 62–70); empty when the primary's claiming age was not
// searched.
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
};

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
  const all = buildOptimizerCandidates(inputs, [inputs.drawOrder]).filter(
    (s) => !s.guardrail && !s.bunching,
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
    return { ...res, jointSearch: info, claimAgeTable: [] };
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
  // none.
  const eligible =
    floor == null
      ? scoredAll
      : scoredAll.filter(
          (s) => s.claimAges.primaryAge == null || s.claimAges.primaryAge >= floor,
        );
  const winner = (eligible[0] ?? scoredAll[0])!;
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
        survivorAnnual: Math.max(
          best.claimAges.primaryAnnual,
          best.claimAges.spouseAnnual,
        ),
        belowFloor: floor != null && age < floor,
        isWinner: best === winner,
        best,
      });
    }
  }
  return {
    candidatesTested: scoredAll.length,
    doNothing,
    winner,
    runnersUp,
    scored: scoredAll,
    jointSearch: info,
    claimAgeTable,
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
function jointInputsKey(inputs: RothPlanInputs): string {
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
  return JSON.stringify(sortValue(inputs));
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
  const floorSentence =
    info.claimAgeFloor != null
      ? ` Your earliest claiming age to consider is ${info.claimAgeFloor}: the winner is the best strategy at a claiming age of ${info.claimAgeFloor} or later, and the younger ages in the table below are marked as below your floor.`
      : "";
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
    if (declaredPrimary && declaredSpouse) {
      return "Neither person has a Social Security benefit — both are marked as having no benefit — so there are no claiming ages to search. The strategies above were priced with no Social Security benefit for either person, with all six draw orders searched as part of the strategy set.";
    }
    if (declaredSpouse && !declaredPrimary) {
      return "The spouse has no Social Security benefit, and the primary person's benefit hasn't been entered yet, so there were no claiming ages to search — the strategies above were priced at the entered ages, with all six draw orders searched as part of the strategy set.";
    }
    if (declaredPrimary && !declaredSpouse) {
      return "The primary person has no Social Security benefit, and the spouse's benefit hasn't been entered yet, so there were no claiming ages to search — the strategies above were priced at the entered ages, with all six draw orders searched as part of the strategy set.";
    }
    return "No Social Security benefit is entered, so there were no claiming ages to search — the strategies above were priced at the entered ages, with all six draw orders searched as part of the strategy set.";
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

// mulberry32 + Box–Muller, replicated from retirementEngines.ts
// (runMonteCarlo draws its batch exactly this way); that module
// is not modified.
function mcMulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function mcNormalRandom(rng: () => number): number {
  // Box–Muller
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// The check's random stream: one mulberry32 seeded
// `seed * 7919 + 17`, the runMonteCarlo convention.
export function rothMcStream(seed: number): () => number {
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
// sorted values, clamped to the ends. Replicated here as tiny
// helpers; retirementEngines is not modified.
function mcMedianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}
function mcPercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((p / 100) * sorted.length)),
  );
  return sorted[idx] ?? 0;
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
  const rng = rothMcStream(opts.seed);
  const paths: RothMcCheckPath[] = [];
  for (let i = 0; i < opts.pathCount; i++) {
    // Draw the full series first, then price BOTH candidates
    // from that same series array — paired paths by construction.
    const series = rothMcReturnSeries(inputs, opts.volatilityPct, rng);
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

   Pairing: one rng stream (rothMcStream(seed)); per path a
   shared standardized shock series is drawn ONCE, with length
   equal to the longest horizon among the base plan and every
   built scenario, then every scenario is priced from its own
   prefix of those shocks centered on its own expected return
   (each scenario's series value is its own expectedReturnPct
   plus volatilityPct × the shared shock) — paired across
   scenarios exactly as the check pairs its two candidates, and
   series generation never depends on the candidates.
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
  // Share of paths with NO shortfall year, in percent to one
  // decimal (the winRatePct rounding convention); 100 = the
  // money lasted on every path.
  neverShortfallRatePct: number;
  // Per-path lifetime shortfall (the sum of the path's yearly
  // spendShortfall), percentiles across ALL paths — p50 is 0
  // whenever at least half the paths never ran short.
  totalShortfallP50Cents: number;
  totalShortfallP90Cents: number;
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
  opts: { volatilityPct: number; pathCount: number; seed: number },
): RothMcStatsResult {
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
    const b = buildCompareScenario(base, s.name, s.overrides, startYear);
    if (!b) return noBirthYear;
    built.push(b);
  }
  type PathRow = {
    netCostCents: number;
    wealthCents: number;
    pretaxCents: number;
    shortfallCents: number;
    hasShortfall: boolean;
  };
  const perScenario: PathRow[][] = built.map(() => []);
  const rng = rothMcStream(opts.seed);
  const horizonYears = (inputs: RothPlanInputs): number =>
    inputs.endAgePrimary - (inputs.startYear - inputs.birthYearPrimary) + 1;
  const baseYears = horizonYears(baseInputs);
  const scenarioYears = built.map((b) => horizonYears(b.inputs));
  const maxYears = Math.max(baseYears, ...scenarioYears);
  for (let i = 0; i < opts.pathCount; i++) {
    // Draw the shared standardized shocks once, then price
    // EVERY scenario from its own prefix centered on its own
    // expected return — paired paths by construction.
    const z = rothMcShockSeries(maxYears, rng);
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
      for (const y of result.years) {
        if (y.spendShortfall > 0) hasShortfall = true;
        shortfallDollars += y.spendShortfall;
      }
      perScenario[j]!.push({
        netCostCents: toCents(cost.netCost),
        wealthCents: toCents(result.endingAfterTaxWealth),
        pretaxCents: toCents(result.endingPretax),
        shortfallCents: toCents(shortfallDollars),
        hasShortfall,
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
      const shortfalls = rows.map((r) => r.shortfallCents);
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
      const size = y.isSurvivorYear
        ? 1
        : inputs.acaStepDownYear != null && y.year >= inputs.acaStepDownYear
          ? inputs.acaHouseholdSizeAfter
          : inputs.acaHouseholdSize;
      const cliff = 4 * fplFor(size, y.year - 1);
      if (y.acaMagi > cliff + 0.01) violations++;
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
  survivorEnabled?: boolean | null;
  survivorWho?: "primary" | "spouse" | null;
  survivorDeathYear?: number | null;
  rothCents: number | null;
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
  // neither key, which reads as blank = no yield modeled, so
  // an untouched record prices bit-identically to before.
  // When set, each priced year's dividend / interest yield %
  // of the starting taxable balance is mandatory income for
  // the year (see taxEngine's RothPlanInputs note).
  taxableDividendYieldPct?: number | null;
  taxableInterestYieldPct?: number | null;
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
  acaHouseholdSize: number | null;
  acaHouseholdSizeAfter: number | null;
  acaStepDownYear: number | null;
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
// and carries no allowance, bit-identical to before.
function executionLedgerFields(
  plan: RothPlanInputs,
  y: RothYear,
): { ltcg: number; capitalLossAllowance?: number; waGainsBase?: number } {
  const st = Math.max(0, plan.capitalLossCarryInSt ?? 0);
  const lt = Math.max(0, plan.capitalLossCarryInLt ?? 0);
  if (st <= 0 && lt <= 0) return { ltcg: y.detail.ltcg };
  const led = applyLossLedger({ st, lt }, y.detail.ltcg, y.filingStatus);
  return {
    ltcg: led.netResult,
    capitalLossAllowance: led.allowance,
    waGainsBase: y.detail.ltcg,
  };
}

function executionFillTarget(
  plan: RothPlanInputs,
  execInputs: RothPlanInputs,
  y: RothYear,
  ceilings: FillCeilings,
): { target: number; base: PriceYearInput; targetLabel: string | null } {
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
  const target = fillConversion({
    base,
    ceilings,
    maxConversion: 100_000_000,
    acaCliff: y.detail.aca.active ? y.detail.aca.cliff : null,
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
  return { target, base, targetLabel };
}

export function priceExecutionYear(
  plan: RothPlanInputs,
  ceilings: FillCeilings | null,
  exec: ExecutionYearDollars,
  currentYear: number,
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
  // the plan's household step-down year and the family-only
  // flag is on, the cliff cap is off for this year. The sim's
  // own per-year gate would strip it anyway; stripping once
  // here keeps the fill-target re-solve below (which works
  // from the ceilings directly) pricing the same undefended
  // year the sim priced.
  const eraCeilings: FillCeilings | null =
    ceilings != null &&
    ceilings.acaCliffCap &&
    ceilings.acaCliffCapFamilyOnly &&
    plan.acaStepDownYear != null &&
    currentYear >= plan.acaStepDownYear
      ? { ...ceilings, acaCliffCap: false }
      : ceilings;
  const result = simulateRothPlan(execInputs, {
    id: "execution-year",
    name: "This year",
    ceilings: eraCeilings,
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
  const fill = executionFillTarget(plan, execInputs, y, eraCeilings);
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
   priced at inflation 0, i.e. the named year's own law row in
   that year's dollars (for a year past the law table, the
   current-law row, undeflated); the pre-tax balance, when
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
  conversion: number; // the typed Roth conversion for the year
  stockSold: number;
  stockBasis: number;
  // Qualified dividends, exactly as printed on the Form 1040
  // (line 3a): a SUBSET of ordinaryDividends (line 3b) above,
  // never an amount on top of it.
  qualifiedDividends: number;
  // Combined pre-tax balance at the prior Dec 31, or null when
  // not entered — null prices no RMD and caps nothing.
  pretaxBalance: number | null;
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
  // deduction prices from. Deliberately NOT part of the
  // paste payload, like residenceState: old pastes keep
  // loading and price exactly as before.
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
  // year is PROJECTED pricing and prices on the 2026 table
  // for every projected year (acaCreditFor's projected
  // mode), while under "lookback" a specific coverage year
  // prices its own table — including the 2027 table
  // (Rev. Proc. 2026-26) for coverage year 2027 exactly.
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
  // (When qualified alone was entered with no total, this
  // is $0 and the qualified amount still prices once, on
  // the gains stack.)
  nonQualifiedDividends: number;
  otherOrdinary: number;
  // Ordinary-stack total: interest + non-qualified
  // dividends + other ordinary income.
  otherOrdinaryTotal: number;
  rmdPriced: boolean;
  rmd: number;
  rmdDivisor: number | null;
  rmdTable: "joint" | "uniform" | null;
  ssBenefits: number;
  ssTaxable: number;
  ssPctTaxed: number; // % of benefits taxed under §86 (0 when no benefits)
  taxExemptInterest: number;
  conversion: number;
  stockGain: number; // sold − basis (negative = the sale is a loss)
  qualifiedDividends: number;
  // The net capital gain or loss from CAPITAL transactions
  // only (the stock gain; negative = a net capital loss).
  // Qualified dividends are NOT capital gains for netting
  // (round-7 R7-1): a net capital loss never reduces them.
  ltcgNet: number;
  // What the preferential stack priced: the priced capital
  // gain, max(0, ltcgNet), PLUS the qualified dividends,
  // whole.
  ltcgPriced: number;
  capitalLoss: number; // max(0, −ltcgNet) — the net capital loss for the year
  // The IRC §1211(b) capital-loss allowance priced this
  // year: min($3,000, capitalLoss), applied against
  // ordinary income. $0 when there is no net capital
  // loss. Any loss beyond the allowance is not priced
  // (in real life it carries forward).
  capitalLossAllowance: number;
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
  // deduction applied above the line (already inside agi
  // / magi / acaMagi above; NOT inside deductions below).
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
  // Watch-out: the typed conversion exceeds the pre-tax balance
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
  };
  // IRMAA: applies when at least one person is on Medicare.
  // The tier is this year's MAGI read through the engine's own
  // tier classifier — the surcharge it sets is paid in
  // premiumYear (taxYear + 2).
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
  // ready-to-render sentence; when the year's total tax exceeds
  // the proceeds it says so plainly instead of printing a
  // negative "left".
  saleAfterTax: PlaygroundSaleAfterTax | null;
};

// The sale-after-tax line's figures: the cash a typed stock
// sale brought in, netted against the year's TOTAL tax as
// priced (total federal tax — ordinary + gains, NIIT included —
// plus the state tax whenever a state rate is typed and priced;
// the sentence therefore never calls the figure federal).
export type PlaygroundSaleAfterTax = {
  proceeds: number; // the typed sale amount, whole dollars as printed
  totalTax: number; // displayed federal + displayed state, whole dollars as printed
  // proceeds − totalTax at the printed (whole-dollar) precision;
  // negative when the year's tax exceeds the sale's cash.
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
  // The preferential income as typed: sale gain + qualified
  // dividends (an arithmetic total of what was typed, NOT a
  // netting — a sale loss in it never reduces the dividends
  // the engine priced; negative = the typed total is a loss).
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

export function pricePlaygroundYear(inp: PlaygroundYearInputs): PlaygroundYearResult {
  const fs = inp.filingStatus;
  const joint = fs === "mfj";
  const ageSpouse = joint ? inp.ageSpouse : null;
  const law = lawForYear(inp.taxYear);
  const ssBenefits = r2(inp.ssPrimary + (joint ? inp.ssSpouse : 0));
  // Dividends are entered exactly as printed on the Form
  // 1040: ordinaryDividends is the line 3b TOTAL, which
  // already includes the line 3a qualified part. Count them
  // once by splitting the total — the non-qualified part
  // (total − qualified, floored at $0) rides the ordinary
  // stack, the qualified part rides the gains stack below.
  // (Qualified entered with no total still prices once:
  // the non-qualified part is $0 and the qualified amount
  // prices on the gains stack alone.)
  const nonQualifiedDividends = r2(
    Math.max(0, inp.ordinaryDividends - inp.qualifiedDividends),
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
  const ltcgNet = stockGain;
  const ltcgPriced = r2(Math.max(0, stockGain) + inp.qualifiedDividends);
  const capitalLoss = Math.max(0, -stockGain);
  const capitalLossAllowance = Math.min(3000, capitalLoss);
  // The total preferential income typed (capital result +
  // qualified dividends) — the gains flags' stack figure and
  // phrase, as before.
  const prefTyped = r2(stockGain + inp.qualifiedDividends);

  // The year's RMD — the plan's own rule (rmdForYear on the
  // primary's clock, Joint Life when applicable) over the
  // combined prior-Dec-31 balance. No balance entered → no RMD
  // priced, and the conversion is not capped against anything.
  let rmd = 0;
  let rmdDivisor: number | null = null;
  let rmdTable: "joint" | "uniform" | null = null;
  if (inp.pretaxBalance != null) {
    const r = rmdForYear({
      priorDec31PreTax: inp.pretaxBalance,
      agePrimary: inp.agePrimary,
      ageSpouse,
      birthYearPrimary: inp.taxYear - inp.agePrimary,
      spouseSoleBeneficiary: inp.spouseSoleBeneficiary,
    });
    rmd = r.rmd;
    rmdDivisor = r.divisor;
    rmdTable = r.table;
  }

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
    otherOrdinary: inp.otherOrdinary,
    interestIncome: inp.interest,
    // priceYear's ordinaryDividends is the NON-qualified
    // part only (its internal stack contract) — the split
    // of the entered line 3b total computed above.
    ordinaryDividends: nonQualifiedDividends,
    rmd,
    conversion: inp.conversion,
    extraPreTaxDraw: 0,
    ssBenefits,
    taxExemptInterest: inp.taxExemptInterest,
    // The capital result passes RAW (negative = a net
    // capital loss): priceYear prices max(0, ltcg) on the
    // gains stack and never nets the loss against the
    // qualified dividends passed beside it.
    ltcg: stockGain,
    qualifiedDividends: inp.qualifiedDividends,
    capitalLossAllowance,
    inflationPct: 0,
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
  const priced = priceYear(base);
  const pricedZero = priceYear({ ...base, conversion: 0 });

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
  // convention. The applicable-percentage table no longer
  // rides this coverage-year value (Build C): acaCreditFor
  // is told explicitly whether this is projected pricing
  // (acaProjected below), and in projected mode it prices
  // the 2026 table whatever this value is — before Build C
  // the table fell back to 2026 for every year past 2026,
  // so the coverage-year shift was table-inert; with the
  // 2027 partial row published it would otherwise have
  // leaked the 2027 percentages into projected 2026 and
  // 2027 years. Pre-2026 years keep the real coverage year:
  // the enhanced-credit schedule has no cliff to re-price.
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
  };
  if (acaApplies && inp.acaHouseholdSize != null) {
    const res = acaCreditFor({
      magi: priced.acaMagi,
      householdSize: inp.acaHouseholdSize,
      coverageYear: acaCoverageYear,
      benchmarkAnnual: inp.acaBenchmarkAnnual ?? 0,
      projected: acaProjected,
    });
    aca = {
      ...aca,
      fpl: res.fpl,
      cliff: res.cliff,
      pctFpl: res.pctFpl,
      overCliff: res.overCliff,
      positionDollars: r2(res.cliff - priced.acaMagi),
      credit: inp.acaBenchmarkAnnual != null ? res.credit : null,
      applicablePct: inp.acaBenchmarkAnnual != null ? res.applicablePct : null,
    };
  }

  // IRMAA — the tier this year's MAGI sets, from the engine's
  // own classifier (priceYear already computed it), charged per
  // person on Medicare in taxYear + 2.
  const personsOnMedicare =
    (inp.onMedicarePrimary ? 1 : 0) + (joint && inp.onMedicareSpouse ? 1 : 0);
  const tier = priced.irmaaTier;
  const annualPerPerson = irmaaAnnualPerPerson(tier, law);
  const nextTierRaw = irmaaTierUpTo(tier, fs, law, inp.taxYear, 0);
  const irmaa: PlaygroundYearResult["irmaa"] = {
    applies: personsOnMedicare > 0,
    personsOnMedicare,
    tier,
    premiumYear: inp.taxYear + 2,
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
  const hasGainsTyped = stockGain !== 0 || inp.qualifiedDividends !== 0;
  let withoutAcaOverCliff = false;
  let withoutAcaPosition: number | null = null;
  let withoutAcaCredit: number | null = null;
  if (acaApplies && inp.acaHouseholdSize != null) {
    const resW = acaCreditFor({
      magi: pricedWithoutGains.acaMagi,
      householdSize: inp.acaHouseholdSize,
      coverageYear: acaCoverageYear,
      benchmarkAnnual: inp.acaBenchmarkAnnual ?? 0,
      projected: acaProjected,
    });
    withoutAcaOverCliff = resW.overCliff;
    withoutAcaPosition = r2(resW.cliff - pricedWithoutGains.acaMagi);
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
        withoutAcaMagi: pricedWithoutGains.acaMagi,
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
        withoutAcaMagi: pricedWithoutGains.acaMagi,
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
        withoutAcaMagi: pricedWithoutGains.acaMagi,
        text: `${gainsPhrase.charAt(0).toUpperCase()}${gainsPhrase.slice(1)} ${verb} the credit — ${fmtDollars(aca.credit ?? 0)} with it, ${fmtDollars(withoutAcaCredit ?? 0)} without it.`,
      };
    }
  }
  let irmaaFlag: PlaygroundIrmaaGainsFlag | null = null;
  if (hasGainsTyped && personsOnMedicare > 0 && tier !== pricedWithoutGains.irmaaTier) {
    const withoutTier = pricedWithoutGains.irmaaTier;
    const lowerTier = Math.min(tier, withoutTier);
    const lineRaw = irmaaTierUpTo(lowerTier, fs, law, inp.taxYear, 0);
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
    withoutAcaMagi: pricedWithoutGains.acaMagi,
    withoutTier: pricedWithoutGains.irmaaTier,
    acaFlag,
    irmaaFlag,
  };

  // Sale-after-tax line: only a typed stock sale triggers it
  // (proceeds are the sale's cash, whatever the gain or loss —
  // a loss sale still brought its proceeds in). The tax netted
  // against it is the year's total tax as priced: federal
  // (ordinary + gains, NIIT included) plus state when priced.
  // Figures are rounded to the whole dollars the readout
  // prints, and the leftover is computed from those rounded
  // figures so the three printed numbers foot exactly. The
  // total tax is the SUM OF THE TWO DISPLAYED COMPONENTS —
  // Math.round(federal) + Math.round(state), exactly as the
  // Tax block's own rows print them — not the rounding of the
  // raw sum, which can differ by $1 when both carry cents.
  let saleAfterTax: PlaygroundSaleAfterTax | null = null;
  if (inp.stockSold > 0) {
    const proceeds = Math.round(inp.stockSold);
    const totalTax =
      Math.round(priced.federalTax) + Math.round(priced.stateTax);
    const leftover = proceeds - totalTax;
    saleAfterTax = {
      proceeds,
      totalTax,
      leftover,
      text:
        leftover >= 0
          ? `Sale brought in ${fmtDollars(proceeds)}. After this year's total tax of ${fmtDollars(totalTax)}, ${fmtDollars(leftover)} of it is left.`
          : `Sale brought in ${fmtDollars(proceeds)}. This year's total tax is ${fmtDollars(totalTax)} — ${fmtDollars(-leftover)} more than the sale brought in.`,
    };
  }

  return {
    interest: inp.interest,
    ordinaryDividends: inp.ordinaryDividends,
    nonQualifiedDividends,
    otherOrdinary: inp.otherOrdinary,
    otherOrdinaryTotal,
    rmdPriced: inp.pretaxBalance != null,
    rmd,
    rmdDivisor,
    rmdTable,
    ssBenefits,
    ssTaxable: priced.ssTaxable,
    ssPctTaxed: ssBenefits > 0 ? r2((priced.ssTaxable / ssBenefits) * 100) : 0,
    taxExemptInterest: inp.taxExemptInterest,
    conversion: inp.conversion,
    stockGain,
    qualifiedDividends: inp.qualifiedDividends,
    ltcgNet,
    ltcgPriced,
    capitalLoss,
    capitalLossAllowance,
    agi: priced.agi,
    magi: priced.magi,
    acaMagi: priced.acaMagi,
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
    landingBracketPct,
    landingBracketTop,
    landingRoomLeft,
    landingExactlyFilled,
    conversionFederalCost: r2(priced.federalTax - pricedZero.federalTax),
    conversionTotalCost: r2(
      priced.federalTax + priced.stateTax - (pricedZero.federalTax + pricedZero.stateTax),
    ),
    conversionExceedsBalance:
      inp.pretaxBalance != null &&
      inp.conversion > inp.pretaxBalance - rmd + 0.005,
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
     (prior Dec 31) pre-tax balance, exactly as the template
     year prices it;
   · the ACA household size steps down at the step-down year
     when one is set, and ACA ends on its own once everyone
     is on Medicare (the pricer's own applicability rule);
   · every projected year prices its ACA cliff on the PLAN
     convention — the newest poverty-guideline row, in
     today's dollars (acaConvention "newest" above) — and,
     since Build C, its applicable percentage on the 2026
     table for every projected year, while the single-year
     pricer prices a specific 2027 coverage year on the
     published 2027 table. Those are the sanctioned
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
   bookkeeping, not a second tax model. Each year: the
   pre-tax balance is drawn down by the year's RMD and the
   money out; the taxable balance by the year's stock sale
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
  // ACA step-down: from acaStepDownYear (a calendar year) on,
  // the household size is acaHouseholdSizeAfter. Either null
  // = no step-down.
  acaHouseholdSizeAfter: number | null;
  acaStepDownYear: number | null;
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
    (template.pretaxBalance != null
      ? rmdForYear({
          priorDec31PreTax: template.pretaxBalance,
          agePrimary: walkStartAge,
          ageSpouse: walkStartSpouseAge,
          birthYearPrimary,
          spouseSoleBeneficiary: template.spouseSoleBeneficiary,
        }).rmd
      : 0);
  const growth = 1 + opts.returnPct / 100;
  let pretax: number | null = template.pretaxBalance;
  let taxable: number | null = opts.startTaxable;
  let roth = opts.startRoth;
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
    // The year's RMD on the starting balance — the engine's
    // own rmdForYear, the same call pricePlaygroundYear makes
    // with this balance, so the figure the draw mode and the
    // caps use is the figure the pricing produces.
    const rmdThis =
      pretax != null
        ? rmdForYear({
            priorDec31PreTax: pretax,
            agePrimary: age,
            ageSpouse,
            birthYearPrimary,
            spouseSoleBeneficiary: template.spouseSoleBeneficiary,
          }).rmd
        : 0;
    let moneyOut = Math.max(0, template.conversion);
    if (opts.stopKind === "age" && opts.stopAge != null && age > opts.stopAge) {
      moneyOut = 0;
    }
    if (opts.drawMode === "replace" && moneyOut > 0) {
      const arrival = ssPrimary + ssSpouse + rmdThis;
      moneyOut = Math.max(0, moneyOut - Math.max(0, arrival - baselineArrival));
    }
    if (pretax != null && moneyOut > 0) {
      const afterRmd = Math.max(0, pretax - rmdThis);
      moneyOut = Math.min(moneyOut, afterRmd);
      if (opts.stopKind === "floor" && opts.stopFloor != null) {
        moneyOut = Math.min(moneyOut, Math.max(0, afterRmd - opts.stopFloor));
      }
    }
    moneyOut = r2(moneyOut);
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
    const householdSize =
      template.acaHouseholdSize == null
        ? null
        : opts.acaStepDownYear != null &&
            opts.acaHouseholdSizeAfter != null &&
            calendarYear >= opts.acaStepDownYear
          ? opts.acaHouseholdSizeAfter
          : template.acaHouseholdSize;
    const inputs: PlaygroundYearInputs = {
      ...template,
      taxYear: calendarYear,
      agePrimary: age,
      ageSpouse,
      onMedicarePrimary: age >= 65,
      onMedicareSpouse: ageSpouse != null && ageSpouse >= 65,
      ssPrimary,
      ssSpouse,
      conversion: moneyOut,
      stockSold: stockSoldEffective,
      stockBasis: stockBasisEffective,
      pretaxBalance: pretax,
      acaHouseholdSize: householdSize,
      acaConvention: "newest",
    };
    const result = pricePlaygroundYear(inputs);
    const startBalances: PlaygroundProjectionBalances = {
      pretax,
      taxable,
      roth,
    };
    const endPretax =
      pretax == null
        ? null
        : r2(Math.max(0, pretax - result.rmd - moneyOut) * growth);
    const endTaxable =
      taxable == null
        ? null
        : r2(Math.max(0, taxable - stockSoldEffective) * growth);
    const endRoth = r2(
      (roth + (opts.moneyOutKind === "conversion" ? moneyOut : 0)) * growth,
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
    pretax = endPretax;
    taxable = endTaxable;
    roth = endRoth;
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
    endBalances: { pretax, taxable, roth },
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
  if (inp.pretaxBalance != null) {
    capCents = Math.max(0, Math.round((inp.pretaxBalance - zero.rmd) * 100));
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
  "residenceState" | "educationStudents"
> & {
  kind: "playground-year";
  version: 1;
  // Always present in a payload this builder emits (null when
  // unset), so a replay prices the same state layer and the
  // same credits the copied year priced.
  residenceState: "WA" | "other" | null;
  educationStudents: EducationStudent[] | null;
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
  "spouseSoleBeneficiary",
  "acaHouseholdSize",
  "acaBenchmarkAnnual",
  "stateRatePct",
  "residenceState",
  "educationStudents",
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
    spouseSoleBeneficiary: inp.spouseSoleBeneficiary,
    acaHouseholdSize: inp.acaHouseholdSize,
    acaBenchmarkAnnual: inp.acaBenchmarkAnnual,
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
      spouseSoleBeneficiary: r.spouseSoleBeneficiary,
      acaHouseholdSize,
      acaBenchmarkAnnual,
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
   CASH IDENTITY: for every row, the eleven source fields plus
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
  totalNeedCents: number;
  // Sources (integer cents, applied amounts — see the
  // RothYearFunding waterfall).
  ssCents: number;
  rmdCents: number;
  otherIncomeCents: number;
  interestYieldCents: number;
  dividendYieldCents: number;
  pretaxDrawCents: number;
  taxableSoldForSpendingCents: number;
  taxableSoldForTaxCents: number;
  // Spend-from-cash: the part of the year's spending need the
  // pool's cash sleeve paid (an eleventh source — see the
  // RothYearFunding waterfall in taxEngine.ts). $0 in every
  // year unless the plan sets spendFromCashPct.
  cashSpendCents: number;
  rothDrawCents: number;
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
  // integer cents (both 0 when converged).
  settlementConverged: boolean;
  settlementMismatchCents: { gains: number; pretax: number };
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
  // above the line (inside magiCents / acaMagiCents; it is
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
      totalNeedCents: 0,
      ssCents: cents(f.ss),
      rmdCents: cents(f.rmd),
      otherIncomeCents: cents(f.otherIncome),
      interestYieldCents: cents(f.interestYield),
      dividendYieldCents: cents(f.dividendYield),
      pretaxDrawCents: cents(f.pretaxDraw),
      taxableSoldForSpendingCents: cents(f.taxableSoldForSpending),
      taxableSoldForTaxCents: cents(f.taxableSoldForTax),
      cashSpendCents: cents(f.cashSpend),
      rothDrawCents: cents(f.rothDraw),
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
      row.spendingCents + row.federalTaxCents + row.stateTaxCents + row.irmaaCents;
    const sourceKeys = [
      "ssCents",
      "rmdCents",
      "otherIncomeCents",
      "interestYieldCents",
      "dividendYieldCents",
      "pretaxDrawCents",
      "taxableSoldForSpendingCents",
      "taxableSoldForTaxCents",
      "cashSpendCents",
      "rothDrawCents",
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
  return {
    startYear,
    birthYearPrimary,
    birthYearSpouse: saved.birthYearSpouse,
    filingStatus: saved.filingStatus ?? "mfj",
    endAgePrimary: saved.endAge ?? 95,
    pretaxStart: dollars(saved.pretaxCents),
    pretaxSpouseStart: dollars(saved.pretaxSpouseCents ?? null),
    survivorEnabled: saved.survivorEnabled ?? false,
    survivorWho: saved.survivorWho ?? "primary",
    survivorDeathYear: saved.survivorDeathYear ?? null,
    rothStart: dollars(saved.rothCents),
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
    // Taxable yields passthrough: absent / null = blank = no
    // yield modeled, bit-identical to before. Every pricing
    // path (optimizer candidates, Monte Carlo check, gift and
    // work-years compares) builds its engine inputs from this
    // one construction or spreads it, so the yields reach
    // every path exactly as entered.
    taxableDividendYieldPct: saved.taxableDividendYieldPct ?? null,
    taxableInterestYieldPct: saved.taxableInterestYieldPct ?? null,
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
    expectedReturnPct: saved.expectedReturnPct ?? 0,
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
    preserveExitRatePct: saved.preserveExitRatePct ?? saved.heirRatePct ?? 22,
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
    acaHouseholdSize: saved.acaHouseholdSize ?? 1,
    acaHouseholdSizeAfter:
      saved.acaHouseholdSizeAfter ?? saved.acaHouseholdSize ?? 1,
    acaStepDownYear: saved.acaStepDownYear,
    acaBenchmarkCouple:
      saved.acaBenchmarkCoupleCents == null ? null : saved.acaBenchmarkCoupleCents / 100,
    acaBenchmarkSingle:
      saved.acaBenchmarkSingleCents == null ? null : saved.acaBenchmarkSingleCents / 100,
    acaBenchmarkFamily:
      saved.acaBenchmarkFamilyCents == null ? null : saved.acaBenchmarkFamilyCents / 100,
    // Spouse ACA end age passthrough: absent / null = blank =
    // the engine's 65 default, bit-identical to before.
    acaSpouseEndAge: saved.acaSpouseEndAge ?? null,
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
    heirRatePct: saved.heirRatePct ?? 22,
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
export function buildCompareScenario(
  base: RothCompareBaseSaved,
  name: string,
  overrides: RothCompareOverrides,
  startYear: number,
): RothCompareScenarioBuilt | null {
  const merged: RothCompareBaseSaved = { ...base };
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

export type RothCompareScenarioResult = {
  name: string;
  strategyDescription: string;
  saved: RothCompareBaseSaved;
  netCostCents: number;
  totalTaxCents: number;
  penaltyCents: number;
  irmaaCents: number;
  acaCreditCents: number;
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
): RothCompareResult {
  if (scenarios.length === 0) {
    return {
      ok: false,
      reason: "The compare needs at least one scenario — name a strategy to price.",
      baselineName: null,
      scenarios: [],
    };
  }
  const built: RothCompareScenarioBuilt[] = [];
  for (const s of scenarios) {
    const b = buildCompareScenario(base, s.name, s.overrides, startYear);
    if (!b) {
      return {
        ok: false,
        reason:
          "The compare needs a birth year before it can price a plan — enter it in the base plan and run again.",
        baselineName: null,
        scenarios: [],
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
      penaltyCents: toCents(cost.penalty),
      irmaaCents: toCents(cost.irmaa),
      acaCreditCents: toCents(cost.acaCredit),
      educationRefundableCents: toCents(cost.educationRefundable),
      amtCents: toCents(cost.amt),
      terminalCents: toCents(cost.terminal),
      ssCollectedCents: toCents(cost.ssCollected),
      unpaidTaxCents: toCents(result.lifetimeUnpaidTax),
      endingPretaxCents: toCents(result.endingPretax),
      endingRothCents: toCents(result.endingRoth),
      endingTaxableCents: toCents(result.endingTaxable),
      endingHsaCents: toCents(result.endingHsa),
      endingAfterTaxWealthCents: toCents(result.endingAfterTaxWealth),
    };
  });
  const basePriced = priced.find((p) => p.built === baseline) ?? priced[0]!;
  return {
    ok: true,
    reason: `Priced ${priced.length} scenario${priced.length === 1 ? "" : "s"} as fixed strategies against the baseline "${baseline.name}". Deltas are scenario − baseline, in cents: a negative net-cost delta means the scenario costs less than the baseline; a positive ACA-credit delta means it keeps more premium credit.`,
    baselineName: baseline.name,
    scenarios: priced.map((p) => ({
      name: p.built.name,
      strategyDescription: p.built.strategyDescription,
      saved: p.built.saved,
      netCostCents: p.netCostCents,
      totalTaxCents: p.totalTaxCents,
      penaltyCents: p.penaltyCents,
      irmaaCents: p.irmaaCents,
      acaCreditCents: p.acaCreditCents,
      educationRefundableCents: p.educationRefundableCents,
      amtCents: p.amtCents,
      terminalCents: p.terminalCents,
      ssCollectedCents: p.ssCollectedCents,
      unpaidTaxCents: p.unpaidTaxCents,
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
