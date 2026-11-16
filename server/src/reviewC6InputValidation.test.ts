// Engine Review C6, review Pass 1 SHOULD-1 — work-years job
// money is unsigned at the save boundary.
//
// A negative yearly salary / employer 401(k) / employer HSA was
// previously accepted by the plan-inputs schema and then priced
// as a negative contribution: a negative employer HSA inflated
// the employee's own HSA past the limit and broke the pinned
// identity accepted employer + accepted employee === bucket,
// and a negative employer 401(k) read as a negative
// contribution that inflated the mega backdoor. The three fields
// now carry .min(0), like annualSpendingCents (build v66, same
// failure mode) and extraIncomeCents.
//
// This file pins the boundary only: the saved shape
// (rothInputFields, used by the writers and the saved scenarios)
// and the compute variant (rothComputeFields, spread from the
// same field schemas, so the bound rides along) both reject a
// negative in any of the three fields, while 0, a positive
// amount, and null (blank) still validate. The compare
// overrides wrap the same field schemas (optionalFields), so
// they inherit the bound too.
//
// The values here are generic test cents (100000 = $1,000);
// this is a schema test and needs no household figures.
// Run per-file:
//   bun test server/src/reviewC6InputValidation.test.ts

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { rothComputeFields, rothInputFields } from "./actions";

// The shapes are strict records with every key required, so a
// single-field payload is tested through .partial(): the field's
// own constraint is what fails or passes, not a missing key.
const saveShape = z.object(rothInputFields).partial();
const computeShape = z.object(rothComputeFields).partial();

const FIELDS = [
  "yearlySalaryCents",
  "employer401kCents",
  "employerHsaCents",
] as const;

describe("work-years job money is unsigned (SHOULD-1)", () => {
  for (const field of FIELDS) {
    test(`${field}: a negative value is rejected by the saved shape`, () => {
      for (const bad of [-1, -100000]) {
        const r = saveShape.safeParse({ [field]: bad });
        expect(r.success).toBe(false);
        if (r.success) continue;
        expect(r.error.issues.length).toBeGreaterThan(0);
        expect(r.error.issues.at(0)?.path).toContain(field);
      }
    });

    test(`${field}: a negative value is rejected by the compute shape`, () => {
      const r = computeShape.safeParse({ [field]: -1 });
      expect(r.success).toBe(false);
      if (r.success) return;
      expect(r.error.issues.at(0)?.path).toContain(field);
    });

    test(`${field}: 0, a positive amount, and null still validate`, () => {
      for (const good of [null, 0, 1, 100000]) {
        expect(saveShape.safeParse({ [field]: good }).success).toBe(true);
        expect(computeShape.safeParse({ [field]: good }).success).toBe(
          true,
        );
      }
    });
  }

  test("all three negative at once are rejected together", () => {
    const r = saveShape.safeParse({
      yearlySalaryCents: -1,
      employer401kCents: -1,
      employerHsaCents: -1,
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    const paths = r.error.issues.map((i) => i.path.join("."));
    expect(paths).toContain("yearlySalaryCents");
    expect(paths).toContain("employer401kCents");
    expect(paths).toContain("employerHsaCents");
  });
});
