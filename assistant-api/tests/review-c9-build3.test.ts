// Engine Review C9, Build 3 — adapter leg: the compare verdict
// reaches the caller (W4-GAP-1).
//
// The engine leg lives in server/src/reviewC9Build3.test.ts; this
// file checks the same verdict where an AI caller reads it: the
// mapped scenarios carry the four new fields, the comparison
// scope carries the qualification verdict and the excluded invalid
// winner, and the warnings array names the unqualified crown.
//
// Fixture: the adapter's own fictional household (see
// assistant-api/tests/helpers.ts — never real figures). The
// depleted household is that household with its balances cut to
// $10,000 pre-tax / $10,000 taxable against $114,000/yr spending.
// Every pinned figure below is the adapter's own output on the
// stated shape, verified by execution before pinning.

import { describe, expect, test } from "bun:test";
import {
  compareWithdrawalStrategies,
  type ComparisonScopeInfo,
} from "../src/adapter";
import { normalizedScenario } from "./helpers";

const UNQUALIFIED_WARNING =
  "No tested candidate was fully valid — treat the winner as unqualified.";

type CompareResults = {
  winnerByNetCost: string | null;
  winnerByEndingWealth: string | null;
  scenarios: Array<{
    name: string;
    unpaidTax: number;
    spendShortfall: number;
    integrityStatus: string;
    integrityReasons: string[];
  }>;
  comparisonScope: ComparisonScopeInfo;
};

describe("C9 Build 3 — adapter: the compare verdict reaches the caller", () => {
  test("depleted household: mapped scenarios carry integrity, winner unqualified, warning present", () => {
    // Every order shorts $2,777,689.88 of spending (unpaid tax
    // $0 — the shortfall is spending, not tax, and the two
    // signals stay distinct). The mapped scenarios carry the
    // four new fields, the scope says the winner is
    // unqualified and names the excluded raw cheapest, and
    // the warnings array carries the unqualified-winner line
    // beside the pre-existing warnings.
    const res = compareWithdrawalStrategies(
      normalizedScenario({ pretax: 10000, taxable: 10000, roth: 0, hsa: 0 }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("fixture failed");
    const r = res.results as unknown as CompareResults;
    expect(r.winnerByNetCost).toBe("taxable-first");
    expect(r.winnerByEndingWealth).toBe("taxable-first");
    expect(r.comparisonScope.winnerQualified).toBe(false);
    expect(r.comparisonScope.excludedInvalidWinner).toEqual({
      name: "taxable-first",
      reasons: [
        "unfunded spending of $2,777,690: the plan cannot fund its own spending need",
      ],
    });
    for (const sc of r.scenarios) {
      expect(sc.unpaidTax).toBe(0);
      expect(sc.spendShortfall).toBe(2777689.88);
      expect(sc.integrityStatus).toBe("invalid");
      expect(sc.integrityReasons).toEqual([
        "unfunded spending of $2,777,690: the plan cannot fund its own spending need",
      ]);
    }
    expect(res.warnings).toContain(UNQUALIFIED_WARNING);
  });

  test("valid household control: qualified, nothing excluded, no unqualified warning", () => {
    const res = compareWithdrawalStrategies(normalizedScenario());
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("fixture failed");
    const r = res.results as unknown as CompareResults;
    expect(r.comparisonScope.winnerQualified).toBe(true);
    expect(r.comparisonScope.excludedInvalidWinner).toBeNull();
    expect(res.warnings).not.toContain(UNQUALIFIED_WARNING);
  });
});
