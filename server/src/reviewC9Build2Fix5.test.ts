// Engine Review C9, Build 2, Fix 5 — the top-up LOT step can zero
// an IRA ledger while conversion lots stand on a $0 KNOWN ledger
// (Pass 6 SHOULD-1).
//
// THE DEFECT (demonstrated by execution in Pass 6, scouts 4/5):
// the march's top-up path reduces balances in TWO places — the lot
// step (which consumes the new conversion lot directly against the
// ledger balance) and the residual shrink. When the lot step zeroes
// the balance, the residual shrink is skipped (shrinkLeft = 0, the
// `if (shrinkLeft > 0)` guard is false) or, in the sub-case where
// the lot is smaller than the top-up, the residual enters shrink at
// $0 and hits the `take <= 0` early return — which also does not
// call the backstop. Either way Fix 4's backstop never fires.
// Design (Pass 6 scout 4/5): post-decline P IRA $500,000 =
// $400,000 contributions + 2024 lot $600,000, basis 0% taxable,
// spending $660,000, conversion $100,000 (new lot $91,480.66 after
// $8,519.34 opening withholding), −50% return in 2026, +5% after.
// At the reprice point B1 = top-up = $2,176.59, the lot step zeroes
// the balance, and $500,000.00 of lots stand on a $0 KNOWN ledger
// (old 2024 lot $410,695.93 + new 2027 lot $89,304.07).
// The phantom is transient and unpriced (2028 reads bit-identical
// to the control) — the fix restores the invariant, it moves no
// priced figure.
//
// THE FIX (taxEngine.ts, two parts):
// (1) settleRound's top-up path calls clearEmptyRothAccountLedger on
//     sRothLedP.ira and sRothLedS.ira after the lot-step loop /
//     residual block — ONE call site covering BOTH sub-cases
//     (shrinkLeft = 0 where the residual never runs, AND the
//     shrink-at-$0 early return).
// (2) shrinkRothAccountLedgerBalance calls the backstop above its
//     `take <= 0` early return, so a ledger entered already at $0
//     with standing composition is cleared too (the reviewer's
//     (z)/(z2) boundary — {balance $0, contributions $40, lot 2024
//     $50} shrunk $30 left $30 with the composition standing).
// Fixing shrink's early return alone does NOT fix the demonstrated
// case (the residual never runs there) — the post-block call site
// is the fix; the early-return call is the second sub-case.
// The backstop is a no-op whenever the balance is positive or
// composition is already clear, so the gate stays byte-identical.
// Lots stay on an UNKNOWN ledger, per the Fix 1 design.
//
// CORRECTION (Pass 6): the Fix 4 test-file header's inference
// ("the lot step cannot zero a ledger holding standing
// contributions, so the hole was the residual shrink's alone") is
// FALSE for LOTS — the lot step zeroed a KNOWN ledger holding
// $500,000.00 of standing lots. The hole spans the lot step AND
// the residual. The merge comment's guarantee and the shrink
// comment's "no lot stands" clause are reworded to the fixed
// mechanism in taxEngine.ts.
//
// Fixture: the C9 spec fixture on the FICTIONAL sample household
// (server/src/sampleHousehold.ts — every figure here is invented,
// none describes any real household), shaped exactly as the Pass 6
// reviewer's probes (probes-pass6-build2/pass6-lotstep4.ts,
// pass6-lotstep5.ts, pass6-fix4.test.ts (z)/(z2)).

import { describe, expect, test } from "bun:test";
import {
  clearEmptyRothAccountLedger,
  shrinkRothAccountLedgerBalance,
  simulateRothPlan,
  type RothAccountLedger,
  type RothPlanInputs,
} from "./taxEngine";
import { samplePlanInputs } from "./sampleHousehold";

const led = (
  balance: number,
  contributions: number,
  lots: { year: number; taxable: number; nontaxable: number }[] = [],
  known = true,
): RothAccountLedger => ({
  balance,
  contributions,
  lots: lots.map((l) => ({ ...l })),
  firstYear: 2020,
  known,
});

const lotTotal = (l: RothAccountLedger): number =>
  l.lots.reduce((s, lot) => s + lot.taxable + lot.nontaxable, 0);

describe("top-up lot step zeroing (Fix 5, Pass 6 SHOULD-1)", () => {
  test("lot step alone leaves the phantom standing on a KNOWN ledger (the defect mechanism)", () => {
    // The exact post-draw, pre-lot-step P IRA state from the
    // Pass 6 phantom: balance $2,176.59, contributions $0 (the
    // $589,304.07 spending draw consumed the $400,000
    // contributions first, then $189,304.07 of the 2024 lot),
    // old 2024 lot $410,695.93 + new 2027 lot $91,480.66.
    // Replay the lot step exactly as settleRound does it:
    // s = min(shrinkLeft, lot.taxable); the appended lot
    // shrinks, the balance falls by the same dollars.
    const l = led(2176.59, 0, [
      { year: 2024, taxable: 410695.93, nontaxable: 0 },
      { year: 2027, taxable: 91480.66, nontaxable: 0 },
    ]);
    const shrinkLeft = 2176.59;
    const appended = l.lots[1]!;
    const s = Math.min(shrinkLeft, appended.taxable);
    appended.taxable -= s;
    l.balance = Math.max(0, l.balance - s);
    // WITHOUT the backstop this is the phantom: balance $0
    // with $500,000.00 of lots standing on a KNOWN ledger.
    expect(l.balance).toBe(0);
    expect(l.contributions).toBe(0);
    expect(lotTotal(l)).toBeCloseTo(500000, 2);
    expect(l.lots).toHaveLength(2);
  });

  test("the post-block backstop clears the lot-step-zeroed KNOWN ledger (P)", () => {
    const l = led(2176.59, 0, [
      { year: 2024, taxable: 410695.93, nontaxable: 0 },
      { year: 2027, taxable: 91480.66, nontaxable: 0 },
    ]);
    const appended = l.lots[1]!;
    const s = Math.min(2176.59, appended.taxable);
    appended.taxable -= s;
    l.balance = Math.max(0, l.balance - s);
    expect(l.balance).toBe(0);
    // The Fix 5 call site: after the lot-step loop / residual
    // block, settleRound calls the backstop on both IRA legs.
    clearEmptyRothAccountLedger(l);
    expect(l.balance).toBe(0);
    expect(l.contributions).toBe(0);
    expect(l.lots).toEqual([]);
  });

  test("the post-block backstop clears the lot-step-zeroed KNOWN ledger (S)", () => {
    // Spouse leg, same shape at invented smaller figures: the
    // lot step zeroes the balance against the appended lot
    // while the old lot stands.
    const l = led(1500, 0, [
      { year: 2024, taxable: 20000, nontaxable: 0 },
      { year: 2027, taxable: 50000, nontaxable: 0 },
    ]);
    const appended = l.lots[1]!;
    const s = Math.min(1500, appended.taxable);
    appended.taxable -= s;
    l.balance = Math.max(0, l.balance - s);
    expect(l.balance).toBe(0);
    expect(lotTotal(l)).toBeCloseTo(68500, 2);
    clearEmptyRothAccountLedger(l);
    expect(l.contributions).toBe(0);
    expect(l.lots).toEqual([]);
  });

  test("unknown-ledger variant: the backstop clears contributions but lots stay (Fix 1 design)", () => {
    const l = led(
      2176.59,
      0,
      [
        { year: 2024, taxable: 410695.93, nontaxable: 0 },
        { year: 2027, taxable: 91480.66, nontaxable: 0 },
      ],
      false,
    );
    const appended = l.lots[1]!;
    const s = Math.min(2176.59, appended.taxable);
    appended.taxable -= s;
    l.balance = Math.max(0, l.balance - s);
    clearEmptyRothAccountLedger(l);
    expect(l.balance).toBe(0);
    expect(l.contributions).toBe(0);
    // Lots stay on an UNKNOWN ledger — the Fix 1 design.
    expect(lotTotal(l)).toBeCloseTo(500000, 2);
    expect(l.lots).toHaveLength(2);
  });
});

describe("shrink entered at $0 (Fix 5, reviewer's (z)/(z2))", () => {
  test("(z) shrink $30 on a $0 KNOWN ledger with standing composition clears it", () => {
    // Pre-fix this early-returned WITHOUT the backstop: left
    // $30, balance $0, contributions $40 standing, lot $50
    // standing. Post-fix the backstop runs above the early
    // return, so the ledger is cleared.
    const l = led(0, 40, [{ year: 2024, taxable: 50, nontaxable: 0 }]);
    const left = shrinkRothAccountLedgerBalance(l, 30);
    expect(left).toBe(30);
    expect(l.balance).toBe(0);
    expect(l.contributions).toBe(0);
    expect(l.lots).toEqual([]);
  });

  test("(z2) shrink $0 on a $0 KNOWN ledger with standing composition clears it", () => {
    const l = led(0, 40, [{ year: 2024, taxable: 50, nontaxable: 0 }]);
    const left = shrinkRothAccountLedgerBalance(l, 0);
    expect(left).toBe(0);
    expect(l.balance).toBe(0);
    expect(l.contributions).toBe(0);
    expect(l.lots).toEqual([]);
  });

  test("unknown variant at $0: contributions cleared, lot stays (Fix 1 design)", () => {
    const l = led(0, 40, [{ year: 2024, taxable: 50, nontaxable: 0 }], false);
    const left = shrinkRothAccountLedgerBalance(l, 30);
    expect(left).toBe(30);
    expect(l.balance).toBe(0);
    expect(l.contributions).toBe(0);
    expect(l.lots).toEqual([{ year: 2024, taxable: 50, nontaxable: 0 }]);
  });

  test("positive-balance shrink is unchanged by the early-return backstop", () => {
    const l = led(100, 40, [{ year: 2024, taxable: 60, nontaxable: 0 }]);
    const left = shrinkRothAccountLedgerBalance(l, 30);
    expect(left).toBe(0);
    expect(l.balance).toBe(70);
    expect(l.contributions).toBe(10);
    expect(l.lots).toEqual([{ year: 2024, taxable: 60, nontaxable: 0 }]);
  });

  test("shrink $0 on a positive balance is a no-op", () => {
    const l = led(100, 40, [{ year: 2024, taxable: 60, nontaxable: 0 }]);
    const left = shrinkRothAccountLedgerBalance(l, 0);
    expect(left).toBe(0);
    expect(l.balance).toBe(100);
    expect(l.contributions).toBe(40);
    expect(l.lots).toEqual([{ year: 2024, taxable: 60, nontaxable: 0 }]);
  });
});

const FILL22 = {
  id: "fill22",
  name: "Fill 22%",
  ceilings: {
    bracketTopPct: 22,
    irmaaTierCap: null,
    ltcgZeroCap: false,
    acaCliffCap: false,
    acaCliffCapFamilyOnly: false,
    magiCap: null,
    acaCliffBuffer: null,
  },
} as const;

function marchInputs(overrides: Partial<RothPlanInputs> = {}): RothPlanInputs {
  return samplePlanInputs({
    birthYearPrimary: 1971,
    birthYearSpouse: 1973,
    endAgePrimary: 95,
    pretaxStart: 200_000,
    pretaxSpouseStart: 0,
    rothStart: 1_000_000,
    rothEmployerStart: 0,
    rothIraStartSpouse: 0,
    rothContributionBasisPrimary: 400_000,
    rothConversionLotsPrimary: [{ year: 2024, taxableAmount: 600_000, nontaxableAmount: 0 }],
    firstRothYearPrimary: 2020,
    rothContributionBasisSpouse: 0,
    rothConversionLotsSpouse: [],
    firstRothYearSpouse: 2020,
    taxableStart: 930_000,
    taxableBasisPct: 0,
    hsaStart: 0,
    annualSpending: 660_000,
    retirementAge: 55,
    expectedReturnPct: 5,
    ssPrimaryAnnual: 0,
    ssPrimaryStartAge: 67,
    ssSpouseAnnual: 0,
    ssSpouseStartAge: 67,
    drawOrder: ["taxable", "pretax", "roth"],
    payTaxFrom: "conversion",
    windowStartAge: 56,
    windowStopAge: 59,
    ...overrides,
  });
}

const SERIES = [-50, 5, 5, 5, 5, 5];

const pickRow = (res: ReturnType<typeof simulateRothPlan>, y: number) => {
  const r = res.years.find((yy) => yy.year === y)!;
  return {
    conv: r.conversion,
    fed: r.federalTax,
    pen: r.penalty,
    unpaid: r.unpaidTax,
    short: r.spendShortfall,
    rothEnd: r.rothEnd,
    earnInc: r.rothEarningsIncome,
    clock: r.fiveYearClockYear,
    unknown: r.rothBasisUnknown,
    rothDraw: r.funding.rothDraw,
    pretaxDraw: r.funding.pretaxDraw,
    taxSale: r.funding.taxableSoldForSpending,
    taxForTax: r.funding.taxableSoldForTax,
  };
};

// The opening withholding, measured the reviewer's way (Pass 6
// scout 4): at age 60 with the window open at 60 the top-up is
// off, so the 2027 pretaxDraw IS the raw opening tax; grossed
// ×10/9 it is the withholding priced at 56.
function measureOpeningWithholding(): number {
  const res = simulateRothPlan(
    marchInputs({
      birthYearPrimary: 1967,
      taxableStart: 916_000,
      annualSpending: 650_000,
      windowStartAge: 60,
      windowStopAge: 64,
    }),
    FILL22 as never,
    SERIES as never,
  );
  const raw = pickRow(res, 2027).pretaxDraw;
  expect(raw).toBeCloseTo(7667.41, 2);
  return (raw * 10) / 9;
}

describe("phantom alignment pinned at march level (Pass 6 scouts 4/5)", () => {
  test("phantom T=930k S=660k: B1 == top-up == $2,176.59, the cap binds exactly", () => {
    const wOpen = measureOpeningWithholding();
    expect(wOpen).toBeCloseTo(8519.34, 2);
    const res = simulateRothPlan(marchInputs(), FILL22 as never, SERIES as never);
    const y26 = pickRow(res, 2026);
    const y27 = pickRow(res, 2027);
    const y28 = pickRow(res, 2028);
    const spend = 660_000;
    const fundSpendRoth = spend - y27.taxSale - y27.short;
    const fundTaxRoth = y27.rothDraw - fundSpendRoth;
    const B0 = y26.rothEnd;
    const N = y27.conv;
    const lot = N - wOpen; // new lot = conversion − opening withholding
    const B1 = B0 + lot - fundSpendRoth; // P IRA balance at the reprice point
    const topUp = y27.pretaxDraw - wOpen;
    expect(B0).toBe(500000);
    expect(N).toBe(100000);
    expect(lot).toBeCloseTo(91480.66, 2);
    expect(fundSpendRoth).toBeCloseTo(589304.07, 2);
    expect(B1).toBeCloseTo(2176.59, 2);
    expect(topUp).toBeCloseTo(2176.59, 2);
    // W-independent identity: topUp − B1 = pretaxDraw − B0 − N
    // + D_P, which the withholding cancels out of — $0.00.
    expect(y27.pretaxDraw - B0 - N + fundSpendRoth).toBeCloseTo(0, 2);
    // No post-top-up Roth debit: the lot step zeroed the
    // balance, so fundTaxRoth is $0.00.
    expect(fundTaxRoth).toBeCloseTo(0, 2);
    // Old lots surviving the draw: $1,000,000 − D_P.
    expect(1000000 - fundSpendRoth).toBeCloseTo(410695.93, 2);
    expect(y27).toEqual({
      conv: 100000, fed: 12221.33, pen: 20000, unpaid: 21525.4,
      short: 0, rothEnd: 0, earnInc: 0, clock: 2029, unknown: false,
      rothDraw: 589304.07, pretaxDraw: 10695.93, taxSale: 70695.93,
      taxForTax: 0,
    });
    expect(y28).toEqual({
      conv: 0, fed: 0, pen: 0, unpaid: 0, short: 660000, rothEnd: 0,
      earnInc: 0, clock: null, unknown: false, rothDraw: 0,
      pretaxDraw: 0, taxSale: 0, taxForTax: 0,
    });
  });

  // Re-pinned under Fix 8: the old pins embedded the r2-draw dust
  // (short -0.01, fundSpendRoth 1c high) that Fix 6 removed. The
  // fixed march matches the 58bb12e base bit-for-bit on every
  // quantity pinned here (probe logs-fix7/b1-base.log vs
  // b1-repo.log — identical B1, topUp, fundSpendRoth, rothDraw,
  // taxSale, pretaxDraw), so the pins now read the base-consistent
  // values: B1 $3,832.76 (not .75), short 0, fundTaxRoth $0.01.
  test("tracking S=659k: B1 $3,832.76, top-up $3,832.75 — a cent apart at the cap, not a coincidence", () => {
    const wOpen = measureOpeningWithholding();
    const res = simulateRothPlan(
      marchInputs({ annualSpending: 659_000 }),
      FILL22 as never,
      SERIES as never,
    );
    const y26 = pickRow(res, 2026);
    const y27 = pickRow(res, 2027);
    const y28 = pickRow(res, 2028);
    const fundSpendRoth = 659_000 - y27.taxSale - y27.short;
    const fundTaxRoth = y27.rothDraw - fundSpendRoth;
    const B1 = y26.rothEnd + (y27.conv - wOpen) - fundSpendRoth;
    const topUp = y27.pretaxDraw - wOpen;
    expect(B1).toBeCloseTo(3832.76, 2);
    expect(topUp).toBeCloseTo(3832.75, 2);
    expect(fundTaxRoth).toBeCloseTo(0.01, 2);
    expect(1000000 - fundSpendRoth).toBeCloseTo(412352.1, 2);
    expect(y27).toEqual({
      conv: 100000, fed: 12321.07, pen: 20000, unpaid: 19968.98,
      short: 0, rothEnd: 0, earnInc: 0, clock: 2029, unknown: false,
      rothDraw: 587647.91, pretaxDraw: 12352.09, taxSale: 71352.1,
      taxForTax: 0,
    });
    expect(y28.short).toBe(659000);
    expect(y28.clock).toBeNull();
    expect(y28.rothEnd).toBe(0);
  });

  test("control rothStart $1,020k: balance survives the lot step, 2028 bit-identical to the phantom", () => {
    const wOpen = measureOpeningWithholding();
    const phantom = simulateRothPlan(marchInputs(), FILL22 as never, SERIES as never);
    const control = simulateRothPlan(
      marchInputs({ rothStart: 1_020_000 }),
      FILL22 as never,
      SERIES as never,
    );
    const y27 = pickRow(control, 2027);
    const y28 = pickRow(control, 2028);
    const fundSpendRoth = 660_000 - y27.taxSale - y27.short;
    const fundTaxRoth = y27.rothDraw - fundSpendRoth;
    const B1 = 510000 + (y27.conv - wOpen) - fundSpendRoth;
    const topUp = y27.pretaxDraw - wOpen;
    expect(B1).toBeCloseTo(12176.59, 2);
    expect(topUp).toBeCloseTo(5059.91, 2);
    // The penalty-payment debit clears the remainder via its
    // own backstop — fundTaxRoth $7,116.68, not $0.
    expect(fundTaxRoth).toBeCloseTo(7116.68, 2);
    expect(y27).toEqual({
      conv: 100000, fed: 12221.33, pen: 20288.33, unpaid: 11813.73,
      short: 0, rothEnd: 0, earnInc: 0, clock: 2029, unknown: false,
      rothDraw: 596420.75, pretaxDraw: 13579.25, taxSale: 70695.93,
      taxForTax: 0,
    });
    // 2028 bit-identical to the phantom run: the phantom
    // moves no priced figure.
    expect(y28).toEqual(pickRow(phantom, 2028));
  });
});
