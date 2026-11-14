// helpers.ts — shared fixtures for the assistant-api tests.
//
// ONE fictional household throughout (never real figures): pretax
// $1,250,000; taxable $2,100,000; Roth $375,000; HSA $62,000;
// spending $9,500/mo; basis 72%; Social Security $36,000/yr at 67
// (spouse $18,000/yr at 67); ages 54/52; retire 58; end age 95.
// Every test that needs different numbers overrides only the fields
// its note varies, so a failure names the variation, not a new
// household.

import { normalizeInputs, type NormalizedScenario } from "../src/normalize";
import type { AdapterResponse, AdapterResult } from "../src/types";
import { expect } from "bun:test";

/** The fictional scenario, in the dollars the caller thinks in. */
export const FICTIONAL = {
  pretax: 1250000,
  taxable: 2100000,
  roth: 375000,
  hsa: 62000,
  monthlySpending: 9500,
  currentAge: 54,
  spouseAge: 52,
  retirementAge: 58,
  endAge: 95,
  socialSecurityAnnual: 36000,
  socialSecurityStartAge: 67,
  spouseSocialSecurityAnnual: 18000,
  spouseSocialSecurityStartAge: 67,
  taxableBasisPct: 72,
  // Pinned to 2026 law so the suite is year-proof: the adapter's
  // default taxYear is the current calendar year, and the law
  // tables cover 2025/2026 only.
  taxYear: 2026,
} as const;

/** The fictional scenario with per-test overrides applied. */
export function fictionalScenario(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...FICTIONAL, ...overrides };
}

/** Normalize the fictional scenario (with overrides); throws if the
 *  fixture itself fails to normalize, so a bad fixture fails loudly
 *  instead of silently testing the error path. */
export function normalizedScenario(
  overrides: Record<string, unknown> = {},
): NormalizedScenario {
  const n = normalizeInputs(fictionalScenario(overrides));
  if (!n.ok) {
    throw new Error(
      `fixture failed to normalize: ${JSON.stringify(n.error)}`,
    );
  }
  return n.scenario;
}

/** Assert an adapter result is ok:true and return its results. */
export function expectOk<T>(result: AdapterResult<T>): T {
  if (!result.ok) {
    throw new Error(
      `expected ok:true, got ${JSON.stringify(result.error)}`,
    );
  }
  return result.results;
}

/** Assert an adapter result is the full ok envelope and return it. */
export function expectEnvelope<T>(
  result: AdapterResult<T>,
): AdapterResponse<T> {
  if (!result.ok) {
    throw new Error(
      `expected ok:true, got ${JSON.stringify(result.error)}`,
    );
  }
  expect(result.source).toBe("finance-planner-engine");
  expect(result.adapterVersion).toBe("assistant-api 0.1.0");
  expect(result.apiContractVersion).toBe(163);
  expect(result.taxLawYear).toBe(2026);
  return result;
}

/** Round to 2dp, the adapter's rounding for dollar results. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Recursively round every number to 2dp (mirrors adapter roundDeep). */
export function roundDeep<T>(value: T): T {
  if (typeof value === "number") return round2(value) as T;
  if (Array.isArray(value)) return value.map(roundDeep) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = roundDeep(v);
    }
    return out as T;
  }
  return value;
}

/** The six essential keys: omitting any one is missing_input. */
export const ESSENTIAL_KEYS = [
  "pretax",
  "taxable",
  "roth",
  "hsa",
  "monthlySpending",
  "currentAge",
] as const;
