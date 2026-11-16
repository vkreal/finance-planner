// Taxable-basis tier ledger — the shared tier-sale and
// reinvested-yield-basis transforms (Engine Review C1, F-8
// unification: extracted verbatim from server/src/taxEngine.ts,
// whose sellFromTiers / reinvestYieldIntoTiers were line-for-line
// duplicates of server/src/workYears.ts's sellFromLedgerTiers /
// stepUpLedgerForYield tiers path).
//
// A LEAF module: it imports nothing, so no engine module can
// cycle through it. The march and the work-years roll both price
// tier sales and reinvested-yield basis through this one pair —
// no surface can price a tier sale two different ways. (The
// harvest's stepUpTiers stays in taxEngine: the capped rebuy is
// a different mechanic, not a duplicate. The march's inflow /
// cash flags and the roll's surplus landing stay in their own
// files: they are caller behavior around these transforms, not
// part of them.)
//
// The minimal tier shape is { bal, basis }: the march's
// TierLedger ({ bal, basis, inflow, cash? }) and the roll's
// WorkTierLedger ({ bal, basis }) are both structurally
// assignable to it, so neither caller converts.
//
// All money is in DOLLARS (the tax engine's units).

// One lot of the taxable pool: its balance and the basis
// dollars paid for it. A basis may pass its balance when the
// tier is underwater (a decline shrank the balance, not the
// basis paid) — basis is dollars paid, floored at $0 only.
export type TierLedgerEntry = { bal: number; basis: number };

// Consume `amount` of balance from a tier ledger, HIGHEST
// current basis ratio first ("highest" — ordinary sales: sell
// the least-gain shares first) or LOWEST first ("lowest" —
// the gain harvest: the gains live in the most-appreciated
// tier). The order is re-evaluated on every call; within a
// tier the sale is pro-rata (basis leaves at the tier's ratio
// in force), so a tier's ratio never changes by selling from
// it, and a sale larger than the top tier spills into the
// next tier in the same call. Returns the gains realized.
// Mutates the ledger in place; the caller owns the copies it
// passes (a settlement works on its own snapshot).
export function sellFromTiers(
  tiers: TierLedgerEntry[],
  amount: number,
  order: "highest" | "lowest",
): number {
  if (amount <= 0) return 0;
  const ranked = tiers
    .map((t) => ({ tier: t, ratio: t.bal > 0 ? t.basis / t.bal : null }))
    .filter((o): o is { tier: TierLedgerEntry; ratio: number } => o.ratio != null)
    .sort((a, b) => (order === "highest" ? b.ratio - a.ratio : a.ratio - b.ratio));
  let remaining = amount;
  let gains = 0;
  for (const { tier: t } of ranked) {
    if (remaining <= 0) break;
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

// Reinvested taxable yield on the tiers path: the yield cash
// is already inside the year's balance (the balance grows at
// the total return, of which the yield is a component), so NO
// tier balance moves here — unlike a real after-tax inflow
// (buyIntoTiers), which arrives with its own balance and
// raises the inflow tier's balance with it. Only the basis
// ledger rises, by the FULL yield amount — the single pool's
// uncapped basisIn treatment (basisBal += yieldTotal), NOT
// the harvest's step-up helper: stepUpTiers caps each tier's
// addition at its own unrealized gain, which is right for a
// harvest rebuy (the rebuy's basis cannot exceed the gain it
// realized) but wrong for reinvested yield, whose basis is
// dollars actually paid for the reinvested shares. Capping
// it discarded real basis whenever a tier stood at (or
// under) its basis — a 100%-basis tier reinvesting a 2%
// yield added NO basis at all — and invented a gain on the
// later sale (FOLLOW-UP #2, engines review: the settlement's
// worked example priced $300 of extra federal tax at 15% on
// a $100,000 pool for exactly this discard).
// Distribution: the added basis fills the tiers in the
// ledger's standing order — lowest basis ratio first, the
// order the capped path already used, so every total the
// cap did not bind is unchanged — but it does NOT stop at
// each tier's balance: once every tier stands at (or above)
// its own balance, the remaining yield basis lands on the
// first tier in that order, pushing its basis past its
// balance rather than being discarded. A tier's basis may
// therefore pass its balance when the tier is underwater at
// reinvestment time (a decline shrank the balance, not the
// basis paid); that excess is real basis, floored at $0
// only, exactly as the single pool and the commit/growth
// reconciler already treat it. The total added is the full
// amount in every case.
export function reinvestYieldIntoTiers(
  tiers: TierLedgerEntry[],
  amount: number,
): void {
  if (amount <= 0 || tiers.length === 0) return;
  const ranked = tiers
    .map((t) => ({ tier: t, ratio: t.bal > 0 ? t.basis / t.bal : 1 }))
    .sort((a, b) => a.ratio - b.ratio);
  let remaining = amount;
  for (const { tier: t } of ranked) {
    if (remaining <= 0) break;
    const room = Math.max(0, t.bal - t.basis);
    const add = Math.min(room, remaining);
    t.basis += add;
    remaining -= add;
  }
  if (remaining > 0) {
    // The overflow host is the first tier in the lowest-ratio
    // order: ranked is built from tiers by map, so it is
    // non-empty exactly when tiers is — and the guard above
    // already returned on an empty ledger. The check below is
    // the narrowing, not a behavior branch: it fails loudly
    // instead of pricing on an undefined tier if that
    // invariant ever breaks.
    const first = ranked[0];
    if (first === undefined) {
      throw new Error(
        "reinvestYieldIntoTiers: empty ranking for a non-empty ledger",
      );
    }
    first.tier.basis += remaining;
  }
}
