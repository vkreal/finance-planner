// Capital-loss carryforward ledger — the §§1211(b) / 1212
// transform and its types (Engine Review C1: extracted verbatim
// from server/src/taxEngine.ts, which re-exports them).
//
// A LEAF module: it imports only a type from taxLaw (erased at
// compile time), so no engine module can cycle through it. The
// march, the Playground pricer, and the work-years roll all price
// carryforward years through this one transform — no surface can
// price a carryforward year two different ways.
//
// All money is in DOLLARS (the tax engine's units).

import type { FilingStatus } from "./taxLaw";

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* ---------------- Capital-loss carryforward ledger (§§1211(b) / 1212) ----------------
   The T4 build. A net capital loss does not vanish at year
   end: it offsets the year's gains first, then takes the
   §1211(b) allowance (up to $3,000 — $1,500 married filing
   separately) against ordinary income, and the remainder
   carries into the next year with its character preserved —
   a short-term loss stays short-term, a long-term loss stays
   long-term (§1212(b)). In a later year the carryovers are
   treated as losses of that year and consumed in the
   worksheet's order (the Capital Loss Carryover Worksheet,
   Schedule D instructions):

     1. The long-term carryover nets inside the long-term
        column against the year's own long-term result.
     2. The short-term carryover — this engine realizes no
        short-term activity of its own, so the short-term
        column is the carryover standing alone as a loss —
        nets against a surviving net long-term gain.
     3. If a net loss remains, the year's allowance is
        CLAIMED against ordinary income in full (it prices
        the year's AGI and tax), but only the part of it
        that actually offset the year's taxable income —
        the worksheet's utilization limit: the allowance
        capped at the year's taxable income computed
        without the allowance — is treated as USED and
        consumed, from the short-term remainder first,
        then the long-term remainder. The unused part of
        the allowance is not consumed: a year with no
        taxable income for the allowance to offset burns
        none of the carryforward.
     4. What survives — including every unused allowance
        dollar — carries out, character intact.

   Washington attribution (build v101, round-14 fix F4):
   the ledger also tracks, inside each character, the part
   of the carryforward that is directly attributable to
   losses from sales or exchanges allocated to Washington
   (RCW 82.87.100) — the plan inputs
   capitalLossCarryInStWa / capitalLossCarryInLtWa state it
   for the entering balance, each a portion of (never more
   than) that character's total. The accounting invariant
   for a priced year is:

     Washington excise base = the year's gross realized
     gains − the Washington-attributable carryforward the
     year's gains absorbed

   (equivalently, the netted federal long-term gain plus
   the NON-Washington-attributable carryforward the gains
   absorbed). Only the absorbed part counts: a
   Washington-attributable loss that instead rides the
   §1211(b) allowance against ordinary income, or carries
   out unused, never reduces the excise base — RCW
   82.87.040(3) includes the carryforward in adjusted
   capital gain only to the extent it is included in the
   federal net long-term capital gain computation. Within
   a character the pool is fungible, so consumption is
   attributed PRO-RATA: the Washington share of each
   character's gains-absorption, and of each character's
   allowance consumption, is that character's Washington
   share of the amount being consumed. The non-Washington
   remainder (which includes any exempt-sale and pre-2022
   carryovers the household does not mark Washington) is
   the RCW 82.87.020(1)(c)–(e) addback population: it never
   reduces the Washington base.

   This transform is the single place those rules live: the
   plan march routes every pricing of a ledger year through
   it (via ledgerFields in simulateRothPlan), and the
   execution-year re-solves in rothOptimizer apply it to
   their reconstructed bases, so no surface can price a
   carryforward year two different ways. It is a tax
   attribute only: it never touches a balance, the taxable
   pool's basis dollars, or the basis-tier machinery. */

export type LossCarryforward = {
  st: number; // short-term capital loss carried (a loss amount, ≥ 0)
  lt: number; // long-term capital loss carried (a loss amount, ≥ 0)
};

export type LossLedgerYearResult = {
  // The year's net capital result after the carry-in
  // netting — the signed figure the year's pricing carries
  // as its capital result (a net gain when positive; the
  // year's net capital loss when negative, in full — the
  // allowance below is priced separately, exactly the split
  // priceYear has always taken).
  netResult: number;
  // The §1211(b) allowance priced this year: the part of
  // the year's net capital loss that offsets ordinary
  // income (≤ the cap, ≤ the loss). This is the amount
  // CLAIMED on the year's return — it prices the year's
  // AGI and tax in full, whether or not the year's
  // taxable income could absorb it.
  allowance: number;
  // The part of the claimed allowance the year's taxable
  // income actually absorbed (the Capital Loss Carryover
  // Worksheet's utilization limit): the only part consumed
  // from the carryforward. Equals `allowance` whenever the
  // year's taxable income before the allowance covers the
  // allowance; $0 in a year with no taxable income for the
  // allowance to offset; in between, exactly the absorbed
  // part. The unused remainder carries forward.
  allowanceUsed: number;
  // The part of the carry-in consumed against this year's
  // own gains (as opposed to consumed by the allowance or
  // carried out) — the absorption a gains year performs.
  absorbedByGains: number;
  // The Washington-attributable part of the carry-in the
  // year's own gains absorbed (build v101): the ONLY
  // part of the federal netting that reduces the year's
  // Washington excise base (see the attribution rules in
  // the ledger header above). Utilization-independent, like
  // absorbedByGains: it is fixed by the year's gains and
  // the entering attribution, never by the allowance
  // reconciliation. $0 whenever no Washington-attributable
  // carryforward entered.
  waAbsorbedByGains: number;
  // What carries into the next year, character preserved.
  carryOut: LossCarryforward;
  // The Washington-attributable part of what carries into
  // the next year, character preserved (build v101):
  // the entering attribution minus its pro-rata share of
  // the year's gains-absorption and of the allowance
  // actually used. All $0 whenever no Washington-attributable
  // carryforward entered.
  waCarryOut: LossCarryforward;
};

// The §1211(b) allowance cap: $3,000, or $1,500 for married
// filing separately. MFS is not among the filing statuses
// this engine prices (FilingStatus is mfj / single / hoh —
// the law table holds no MFS row), so every priceable
// status takes the $3,000 cap; the MFS figure is stated in
// the ledger rules above so the rule is complete if an MFS
// row is ever added.
export function capitalLossAllowanceCap(filingStatus: FilingStatus): number {
  void filingStatus;
  return 3000;
}

export function applyLossLedger(
  carryIn: LossCarryforward,
  // The year's own net long-term capital result from capital
  // transactions (gains positive). In the plan march this is
  // the year's gross realized gains (draws + any injected
  // sale gain + harvested gains) — negative when the year's
  // draws realize a loss, which the underwater-draw path
  // produces (a negative-return year shrinks the taxable
  // balance while its basis dollars stand, so the next
  // year's draws price at a negative gain rate); the
  // transform is stated for any signed value.
  ownLongTermResult: number,
  filingStatus: FilingStatus,
  // The year's taxable income computed WITHOUT the §1211(b)
  // allowance (the worksheet's utilization base — see
  // PriceYearResult.taxableIncomeBeforeLossAllowance). The
  // allowance is CLAIMED on the year's return in full
  // (`allowance` above is the priced figure either way), but
  // the worksheet treats only the part of it that actually
  // offset taxable income as USED: the used part is the
  // allowance capped at this figure (floored at $0), and
  // only the used part is consumed from the carryforward —
  // the unused part carries forward with the rest. A caller
  // pricing a trial year whose carry-out is never read (the
  // march's trial pricings, the optimizer's execution-year
  // re-solves) passes Infinity: utilization is reconciled
  // once, at year end, against the year's final priced
  // taxable income.
  taxableIncomeBeforeAllowance: number,
  // The Washington-attributable part of the carry-in, by
  // character (build v101; see the attribution rules in
  // the ledger header above). Optional: absent = none of
  // the carry-in is Washington-attributable, the result's
  // Washington fields are $0, and every pre-v101 caller
  // prices bit-identically. Each character's figure is
  // clamped to that character's carry-in — an attribution
  // is a portion of the pool, never more than the pool.
  waIn?: LossCarryforward,
): LossLedgerYearResult {
  const stIn = Math.max(0, carryIn.st);
  const ltIn = Math.max(0, carryIn.lt);
  const waStIn = Math.min(stIn, Math.max(0, waIn?.st ?? 0));
  const waLtIn = Math.min(ltIn, Math.max(0, waIn?.lt ?? 0));
  // Long-term column: the year's own long-term result netted
  // with the long-term carryover entering as a loss.
  const ltNet = ownLongTermResult - ltIn;
  // Short-term column: the carryover standing alone as a
  // loss, netted next against a surviving long-term gain.
  let remainingStLoss = stIn;
  let remainingLtLoss = 0;
  let pricedGain = 0;
  if (ltNet >= 0) {
    pricedGain = Math.max(0, ltNet - remainingStLoss);
    remainingStLoss = Math.max(0, remainingStLoss - ltNet);
  } else {
    remainingLtLoss = -ltNet;
  }
  const totalLoss = remainingStLoss + remainingLtLoss;
  const allowance =
    totalLoss > 0
      ? Math.min(capitalLossAllowanceCap(filingStatus), totalLoss)
      : 0;
  // Worksheet utilization (the round-3 audit fix): the
  // claimed allowance reduces the carryforward only by the
  // part that actually offset the year's taxable income.
  // A year with no taxable income before the allowance uses
  // none of it — the whole loss carries forward, however
  // many such years run in a row — and a year that absorbs
  // only part of the allowance consumes exactly that part.
  const allowanceUsed = Math.min(
    allowance,
    Math.max(0, taxableIncomeBeforeAllowance),
  );
  // The used part is consumed from the short-term remainder
  // first (the worksheet's ordering), the balance from the
  // long-term remainder; the unused part is not consumed
  // at all and carries out with the rest.
  const stConsumedByAllowance = Math.min(allowanceUsed, remainingStLoss);
  const ltConsumedByAllowance = allowanceUsed - stConsumedByAllowance;
  const carryOut: LossCarryforward = {
    st: r2(remainingStLoss - stConsumedByAllowance),
    lt: r2(remainingLtLoss - ltConsumedByAllowance),
  };
  const absorbedByGains = r2(
    Math.max(0, stIn + ltIn - carryOut.st - carryOut.lt - allowanceUsed),
  );
  // Washington attribution (build v101): each character's
  // gains-absorption is the part of that character's pool the
  // year's gains consumed before the allowance ran (the
  // long-term pool less its remainder, the short-term pool
  // less its remainder), and the Washington share of every
  // consumption is pro-rata within the character — of the
  // gains-absorption against the entering pool, and of the
  // allowance's used part against the post-gains remainder.
  const ltAbsorbedByGains = Math.max(0, ltIn - remainingLtLoss);
  const stAbsorbedByGains = Math.max(0, stIn - remainingStLoss);
  const waLtAbsorbed =
    ltIn > 0 ? (waLtIn * ltAbsorbedByGains) / ltIn : 0;
  const waStAbsorbed =
    stIn > 0 ? (waStIn * stAbsorbedByGains) / stIn : 0;
  const waStRemainder = waStIn - waStAbsorbed;
  const waLtRemainder = waLtIn - waLtAbsorbed;
  const waStUsedByAllowance =
    remainingStLoss > 0
      ? (waStRemainder * stConsumedByAllowance) / remainingStLoss
      : 0;
  const waLtUsedByAllowance =
    remainingLtLoss > 0
      ? (waLtRemainder * ltConsumedByAllowance) / remainingLtLoss
      : 0;
  const waCarryOut: LossCarryforward = {
    st: r2(Math.max(0, waStRemainder - waStUsedByAllowance)),
    lt: r2(Math.max(0, waLtRemainder - waLtUsedByAllowance)),
  };
  return {
    netResult: r2(totalLoss > 0 ? -totalLoss : pricedGain),
    allowance: r2(allowance),
    allowanceUsed: r2(allowanceUsed),
    absorbedByGains,
    waAbsorbedByGains: r2(waStAbsorbed + waLtAbsorbed),
    carryOut,
    waCarryOut,
  };
}
