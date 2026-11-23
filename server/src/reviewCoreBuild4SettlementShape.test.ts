// Core engine review 2026-11-21, Build 4 — settlement-mismatch shape (M-2).
//
// M-2: the published prose promised a 5-component settlementMismatchCents
// ({gains, pretax, roth, hsa, acaCredit}) while the published schemas
// delivered 3 — the Roth/HSA residuals were silently dropped at the
// action boundary by zod's default strip of unknown keys. The fix
// carries all five fields in planYearRowOut / fundingRowOut / the
// compare years readout (and the toPlanYearRow input type).
//
// These tests pin the published shapes directly: a fabricated 5-field
// mismatch parsed through the action's real schemas must survive with
// all five components, and a compare run shaped + parsed through the
// action's real response schema must carry the Roth/HSA fields in
// both the per-year rows and the per-scenario integrity verdicts.
// Pre-fix every assertion below fails (the fields parse to undefined).
// All mismatch figures here are fabricated test values, none describes
// any real household; the compare runs use the shared fictional sample
// household (server/src/sampleHousehold.ts).

import { describe, expect, test } from "bun:test";
import {
  Actions,
  fundingRowOut,
  planYearRowOut,
  shapeRothCompareResponse,
} from "./actions";
import { buildRothFunding, runRothCompare } from "./rothOptimizer";
import { ROTH_COMPARE_STRATEGIES } from "./taxEngine";
import { samplePlanInputs } from "./sampleHousehold";
import { sampleCompareBase } from "./hardening/sensCompareBase";

const THREE_ORDERS = [
  { name: "taxable-first", overrides: { drawOrder: "taxable-pretax-roth" } },
  { name: "pre-tax-first", overrides: { drawOrder: "pretax-taxable-roth" } },
  { name: "roth-first", overrides: { drawOrder: "roth-taxable-pretax" } },
] as never;

// The core review's S-1 repro, as a fabricated mismatch: every
// component except Roth/HSA is 0, so only the 5-field shape can
// carry the residual at all.
const FIVE_FIELD_MISMATCH = {
  gains: 0,
  pretax: 0,
  roth: 500,
  hsa: 300,
  acaCredit: 0,
};

describe("Build 4 (M-2) — the published settlement-mismatch shape is 5-field", () => {
  test("planYearRowOut carries all five mismatch components", () => {
    const parsed = planYearRowOut.shape.settlementMismatchCents.parse(
      FIVE_FIELD_MISMATCH,
    );
    expect(parsed).toEqual(FIVE_FIELD_MISMATCH);
  });

  test("fundingRowOut carries all five mismatch components", () => {
    const parsed = fundingRowOut.shape.settlementMismatchCents.parse(
      FIVE_FIELD_MISMATCH,
    );
    expect(parsed).toEqual(FIVE_FIELD_MISMATCH);
  });

  test("compare: the shaped response carries the Roth/HSA max fields on every scenario's integrity", () => {
    const base = sampleCompareBase();
    const cmp = runRothCompare(base, THREE_ORDERS, 2026, "taxable-first");
    const res = Actions.runRothCompare.response.parse(
      shapeRothCompareResponse(cmp, base, 2026),
    );
    expect(res.scenarios).toHaveLength(3);
    for (const sc of res.scenarios) {
      expect(sc.integrity.maxMismatchRothCents).toBe(0);
      expect(sc.integrity.maxMismatchHsaCents).toBe(0);
    }
  });

  test("compare: a fabricated Roth/HSA residual on a march year survives shaping + parsing", () => {
    const base = sampleCompareBase();
    const cmp = runRothCompare(base, THREE_ORDERS, 2026, "taxable-first");
    // Mutate one priced year to carry the S-1 repro residual: the
    // engine carries 5 fields internally, so this is exactly what
    // a Roth/HSA-only settlement failure would look like arriving
    // at the action boundary.
    const year = cmp.scenarios[0]!.years[0]!;
    year.settlementConverged = false;
    year.settlementMismatchCents = { ...FIVE_FIELD_MISMATCH };
    const res = Actions.runRothCompare.response.parse(
      shapeRothCompareResponse(cmp, base, 2026),
    );
    const published = res.scenarios[0]!.years[0]!;
    expect(published.settlementConverged).toBe(false);
    expect(published.settlementMismatchCents).toEqual(FIVE_FIELD_MISMATCH);
  });
});

// Build 4 (M-2) — funding rows carry the 5-field shape end to end
// (Pass 1 NICE-2: the M-2 funding test parsed only the sub-schema;
// these run buildRothFunding through the action's real response
// schema, so a future mapper or handler change that re-drops
// Roth/HSA is caught here, not by code reading alone).
const DO_NOTHING = ROTH_COMPARE_STRATEGIES[0]!;

function parseFundingResponse(
  rows: ReturnType<typeof buildRothFunding>,
) {
  return Actions.runRothFunding.response.parse({
    ok: true,
    reason: "test",
    provenance: {
      apiContractVersion: 165,
      engineVersion: "test",
      lawYear: 2026,
      lawYearsAvailable: [2025, 2026],
    },
    effectiveInputs: null,
    years: rows,
  });
}

describe("Build 4 (M-2) — the published funding shape is 5-field end to end", () => {
  test("funding: the action's response carries the Roth/HSA fields on every row", () => {
    const rows = buildRothFunding(
      samplePlanInputs(),
      DO_NOTHING as never,
    );
    const res = parseFundingResponse(rows);
    expect(res.years.length).toBeGreaterThan(0);
    for (const row of res.years) {
      expect(row.settlementMismatchCents).toEqual({
        gains: expect.any(Number),
        pretax: expect.any(Number),
        roth: expect.any(Number),
        hsa: expect.any(Number),
        acaCredit: expect.any(Number),
      });
    }
  });

  test("funding: a fabricated Roth/HSA residual on a funding row survives the action response parse", () => {
    const rows = buildRothFunding(
      samplePlanInputs(),
      DO_NOTHING as never,
    );
    // Mutate one priced year to carry the S-1 repro residual.
    const row = rows[0]!;
    row.settlementConverged = false;
    row.settlementMismatchCents = { ...FIVE_FIELD_MISMATCH };
    const res = parseFundingResponse(rows);
    const published = res.years[0]!;
    expect(published.settlementConverged).toBe(false);
    expect(published.settlementMismatchCents).toEqual(FIVE_FIELD_MISMATCH);
  });
});
