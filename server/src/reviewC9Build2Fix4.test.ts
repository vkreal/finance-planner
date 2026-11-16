// Engine Review C9, Build 2, Fix 4 — shrink to $0 clears the
// ledger (Pass 5 SHOULD-1: shrinkRothAccountLedgerBalance
// left standing composition on a post-decline ledger).
//
// THE DEFECT (demonstrated by execution in Pass 5):
// shrinkRothAccountLedgerBalance consumed only `take` dollars
// of composition — contributions first, then conversion lots
// FIFO, then earnings implicit — and returned the leftover,
// never calling clearEmptyRothAccountLedger. A ledger that
// entered the shrink with composition ABOVE its balance (the
// post-decline state: a negative-return year shrank the
// balance while basis deliberately survived, exactly like
// the taxable basis beside it) kept composition standing
// after a full-balance shrink: {balance $50, contributions
// $90} shrunk $50 ended balance $0 with contributions $40
// standing; {balance $50, contributions $40, lot 2024
// taxable $60} shrunk $50 ended balance $0 with lot taxable
// $50 standing on a KNOWN ledger. The debit does NOT share
// the hole — both debit returns call the backstop — and the
// lot step cannot zero a ledger holding standing
// contributions at ordinary magnitudes (the draw consumes
// contributions first), BUT the inference drawn from that —
// "so the hole was the residual shrink's alone" — is FALSE
// for LOTS, as Pass 6 showed (C9 Build 2 fix 5): the lot
// step zeroed a KNOWN ledger holding $500,000.00 of standing
// lots (old 2024 lot $410,695.93 + new 2027 lot $89,304.07),
// and Fix 4's backstop never fired on that path — the
// residual never runs (shrinkLeft = 0) or enters shrink at
// $0 and early-returns. The hole spans the lot step AND the
// residual; Fix 5 adds the backstop after the lot-step /
// residual block in settleRound and above shrink's take-$0
// early return.
//
// THE FIX (Fix 4's fix, in shrinkRothAccountLedgerBalance
// only — extended by Fix 5, see the note above): one clearEmptyRothAccountLedger(led) call after the
// composition consumption, so a shrink to $0 clears
// contributions — and lots on a KNOWN ledger (lots stay on
// an UNKNOWN ledger, per the Fix 1 design, as the backstop
// already implements). The call is a no-op whenever the
// balance is positive or composition is already clear, so
// the gate stays byte-identical. Consumption order, scope
// (IRA legs only, P first), and the balance reduction are
// unchanged.
//
// Fixture: the C9 spec fixture on the FICTIONAL sample
// household (server/src/sampleHousehold.ts — every figure
// here is invented, none describes any real household),
// shaped exactly as the Pass 5 reviewer's probe
// (probes-pass5-build2/pass5-backstop.test.ts (a)/(a2)).

import { describe, expect, test } from "bun:test";
import {
  shrinkRothAccountLedgerBalance,
  type RothAccountLedger,
} from "./taxEngine";

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

describe("shrinkRothAccountLedgerBalance clears a ledger shrunk to $0 (Fix 4)", () => {
  test("(a) post-decline exhaustion: $50 balance / $90 contributions shrunk $50 ends $0/$0", () => {
    const l = led(50, 90);
    const left = shrinkRothAccountLedgerBalance(l, 50);
    expect(left).toBe(0);
    expect(l.balance).toBe(0);
    // THE invariant: balance $0 ⟹ contributions $0.
    expect(l.contributions).toBe(0);
    expect(l.lots).toEqual([]);
  });

  test("(a2) post-decline exhaustion with lots: $50 balance / $40 contributions / 2024 lot $60 shrunk $50 ends $0/$0, lots [] on a KNOWN ledger", () => {
    const l = led(50, 40, [{ year: 2024, taxable: 60, nontaxable: 0 }]);
    const left = shrinkRothAccountLedgerBalance(l, 50);
    expect(left).toBe(0);
    expect(l.balance).toBe(0);
    expect(l.contributions).toBe(0);
    expect(l.lots).toEqual([]);
  });

  test("unknown-ledger variant: contributions cleared, lots stay per the Fix 1 design", () => {
    // The shrink still consumes composition in order
    // (contributions $40, then $10 of the $60 lot), so the
    // lot stands at taxable $50 — and the backstop leaves
    // it there on an UNKNOWN ledger instead of clearing it.
    const l = led(50, 40, [{ year: 2024, taxable: 60, nontaxable: 0 }], false);
    const left = shrinkRothAccountLedgerBalance(l, 50);
    expect(left).toBe(0);
    expect(l.balance).toBe(0);
    expect(l.contributions).toBe(0);
    expect(l.lots).toEqual([{ year: 2024, taxable: 50, nontaxable: 0 }]);
  });

  test("positive-balance shrink is unchanged: backstop is a no-op, consumption order preserved", () => {
    // Shrink $30 of a $100 balance: contributions first
    // ($40 → $10), lots untouched, balance $70 — the
    // backstop must NOT clear composition while the balance
    // is positive.
    const l = led(100, 40, [{ year: 2024, taxable: 60, nontaxable: 0 }]);
    const left = shrinkRothAccountLedgerBalance(l, 30);
    expect(left).toBe(0);
    expect(l.balance).toBe(70);
    expect(l.contributions).toBe(10);
    expect(l.lots).toEqual([{ year: 2024, taxable: 60, nontaxable: 0 }]);
  });

  test("Probe A shape: $4,000 balance ($3,000 contributions) shrunk $4,166.67 returns $166.67, ends $0/$0", () => {
    const l = led(4000, 3000, []);
    const left = shrinkRothAccountLedgerBalance(l, 4166.67);
    expect(left).toBeCloseTo(166.67, 2);
    expect(l.balance).toBe(0);
    expect(l.contributions).toBe(0);
    expect(l.lots).toEqual([]);
  });
});
