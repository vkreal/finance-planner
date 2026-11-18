// Engine Review C9, Build 3 NICEs fix — N1 (client leg):
// labWinnerFigures, the Strategy Lab badge decision.
//
// The badges follow the ENGINE's crowned winners (looked up by
// name) instead of a raw min/max over the rows. These tests drive
// the real helper with the three run shapes the server tests
// price (reviewC9Build3.test.ts / reviewC9Build3Nices.test.ts) —
// synthetic figures in the same structure, so this file stays
// independent of engine pricing: the helper only reads names and
// figures, never prices.
//
// - All invalid: the raw $0 winners are crowned (figures 0/0) —
//   the badges stay on them, and the component marks them
//   Unqualified from winnerQualified, which this helper does not
//   decide.
// - Mixed: the invalid $0 rows are NOT the badge figures — the
//   valid funded row is, on both objectives.
// - Valid: the badge figures are exactly the raw min net cost /
//   max ending wealth, so a valid compare badges identically to
//   before the threading.
// - Fallback: winner names absent (defensive only) → raw min/max,
//   i.e. the pre-N1 behavior.

import { describe, expect, test } from "bun:test";
import {
  labFoldKey,
  labWinnerFigures,
  parseDollars,
  parseMoney,
  type LabFoldRow,
  type LabWinnerInput,
} from "./rothShared";

const ALL_INVALID: LabWinnerInput = {
  winnerByNetCost: "taxable-first",
  winnerByEndingWealth: "taxable-first",
  scenarios: [
    { name: "taxable-first", netCostCents: 0, endingAfterTaxWealthCents: 0 },
    { name: "pre-tax-first", netCostCents: 0, endingAfterTaxWealthCents: 0 },
    { name: "roth-first", netCostCents: 0, endingAfterTaxWealthCents: 0 },
  ],
};

const MIXED: LabWinnerInput = {
  winnerByNetCost: "funded",
  winnerByEndingWealth: "funded",
  scenarios: [
    { name: "taxable-first", netCostCents: 0, endingAfterTaxWealthCents: 0 },
    { name: "pre-tax-first", netCostCents: 0, endingAfterTaxWealthCents: 0 },
    {
      name: "funded",
      netCostCents: 166954821,
      endingAfterTaxWealthCents: 900000000,
    },
  ],
};

const ALL_VALID: LabWinnerInput = {
  winnerByNetCost: "pre-tax-first",
  winnerByEndingWealth: "taxable-first",
  scenarios: [
    {
      name: "taxable-first",
      netCostCents: 103000000,
      endingAfterTaxWealthCents: 1163596462,
    },
    {
      name: "pre-tax-first",
      netCostCents: 102025683,
      endingAfterTaxWealthCents: 1100000000,
    },
    {
      name: "roth-first",
      netCostCents: 105000000,
      endingAfterTaxWealthCents: 1080000000,
    },
  ],
};

describe("C9 Build 3 NICEs — N1: Lab badges follow the engine crown", () => {
  test("all invalid: badge figures are the raw $0 winners", () => {
    expect(labWinnerFigures(ALL_INVALID)).toEqual({
      lowestTaxNetCostCents: 0,
      mostLeftWealthCents: 0,
    });
  });

  test("mixed: the invalid $0 rows are not the badge figures", () => {
    expect(labWinnerFigures(MIXED)).toEqual({
      lowestTaxNetCostCents: 166954821,
      mostLeftWealthCents: 900000000,
    });
  });

  test("valid: badge figures equal the raw min/max", () => {
    expect(labWinnerFigures(ALL_VALID)).toEqual({
      lowestTaxNetCostCents: 102025683,
      mostLeftWealthCents: 1163596462,
    });
  });

  test("winner names absent: falls back to the raw min/max", () => {
    expect(
      labWinnerFigures({
        winnerByNetCost: null,
        winnerByEndingWealth: null,
        scenarios: ALL_VALID.scenarios,
      }),
    ).toEqual({
      lowestTaxNetCostCents: 102025683,
      mostLeftWealthCents: 1163596462,
    });
    expect(
      labWinnerFigures({
        winnerByNetCost: "no-such-row",
        winnerByEndingWealth: "no-such-row",
        scenarios: ALL_VALID.scenarios,
      }),
    ).toEqual({
      lowestTaxNetCostCents: 102025683,
      mostLeftWealthCents: 1163596462,
    });
  });
});

// Folded-group integrity (N6): the fold key carries the
// integrity verdict, not just the priced fields. Two rows can
// price identically while one is invalid — the folded group
// shows its representative row's Invalid badge and reasons,
// so those rows must never fold together. Synthetic rows in
// the same structure as the Lab action response; the helper
// only reads priced fields and the verdict, never prices.
const PRICED_IDENTICAL: Omit<LabFoldRow, "integrity"> = {
  netCostCents: 0,
  totalTaxCents: 0,
  penaltyCents: 0,
  irmaaCents: 0,
  acaCreditCents: 0,
  terminalCents: 0,
  ssCollectedCents: 0,
  endingAfterTaxWealthCents: 0,
  endingPretaxCents: 0,
  endingRothCents: 0,
  endingTaxableCents: 0,
  endingHsaCents: 0,
};

describe("C9 Build 3 NICEs — N6: folded groups never mix integrity verdicts", () => {
  test("rows differing ONLY in integrity status do not fold together", () => {
    // Every priced field identical — before this fix the two
    // rows shared a fold key and the group showed the
    // representative row's verdict alone.
    const invalidRow: LabFoldRow = {
      ...PRICED_IDENTICAL,
      integrity: {
        status: "invalid",
        reasons: [
          "unfunded spending of $3,970,954: the plan cannot fund its own spending need",
        ],
      },
    };
    const validRow: LabFoldRow = {
      ...PRICED_IDENTICAL,
      integrity: { status: "valid", reasons: [] },
    };
    expect(labFoldKey(invalidRow)).not.toBe(labFoldKey(validRow));
  });

  test("rows differing ONLY in integrity reasons do not fold together", () => {
    // Same status, same priced fields — but the group shows
    // the representative's reasons line, so different reasons
    // are different displayed outcomes.
    const shortfallRow: LabFoldRow = {
      ...PRICED_IDENTICAL,
      integrity: {
        status: "invalid",
        reasons: [
          "unfunded spending of $3,970,954: the plan cannot fund its own spending need",
        ],
      },
    };
    const unpaidRow: LabFoldRow = {
      ...PRICED_IDENTICAL,
      integrity: {
        status: "invalid",
        reasons: [
          "unpaid tax of $611,945: assessed tax the balances could not pay",
        ],
      },
    };
    expect(labFoldKey(shortfallRow)).not.toBe(labFoldKey(unpaidRow));
  });

  test("identical rows (same priced fields, same verdict) still fold together", () => {
    const a: LabFoldRow = {
      ...PRICED_IDENTICAL,
      integrity: {
        status: "invalid",
        reasons: [
          "unfunded spending of $3,970,954: the plan cannot fund its own spending need",
        ],
      },
    };
    const b: LabFoldRow = { ...a, integrity: { ...a.integrity } };
    expect(labFoldKey(a)).toBe(labFoldKey(b));
  });
});

// Engine Review C6 NICEs — NICE-1: parseMoney's safe-integer
// guard. A typed dollar figure whose rounded cents are not a
// safe integer (past ~$90,071,992,547,409.91, i.e. 2^53 − 1
// cents) reads back as a neighbouring value, so the parser
// rejects it — the same rejection the server converters apply
// (adapter dollarsToCents), in this parser's null convention.
// Ordinary figures parse exactly as before.
describe("C6 NICEs — NICE-1: parseMoney rejects unrepresentable cents", () => {
  test("largest exactly representable amount still parses", () => {
    expect(parseMoney("90071992547409.91")).toBe(9007199254740991);
    expect(parseMoney("-90071992547409.91")).toBe(-9007199254740991);
  });

  test("one cent past the boundary returns null", () => {
    expect(parseMoney("90071992547409.92")).toBeNull();
    expect(parseMoney("-90071992547409.92")).toBeNull();
    expect(parseMoney("90071992547409.99")).toBeNull();
  });

  test("non-finite results return null", () => {
    expect(parseMoney("1e308")).toBeNull();
    expect(parseMoney("Infinity")).toBeNull();
    expect(parseMoney("NaN")).toBeNull();
  });

  test("ordinary figures parse exactly as before", () => {
    expect(parseMoney("1,234.56")).toBe(123456);
    expect(parseMoney("$1,234.56")).toBe(123456);
    expect(parseMoney("0")).toBe(0);
    expect(parseMoney("-5.25")).toBe(-525);
    expect(parseMoney("")).toBeNull();
  });

  test("parseDollars inherits the guard", () => {
    expect(parseDollars("90071992547409.92")).toBeNull();
    expect(parseDollars("1,234.56")).toBe(1234.56);
  });
});
