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
import { labWinnerFigures, type LabWinnerInput } from "./rothShared";

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
