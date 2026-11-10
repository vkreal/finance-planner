/* ---------------- Hardening check registry ----------------
   Part 1 of the hardening block (Oct 16: "why not do all?"
   / "Do all of them but make it last" / "Implement it in
   way we can refactor or add new"). The registry: the list
   of check modules and the one runner that executes all
   registered checks and reports per-check verdicts.
   Adding a check = adding a module that conforms to
   HardeningCheckModule (see types.ts) and registering it
   in HARDENING_REGISTRY below — nothing else changes.

   Registered checks (Part 1):
   - differential-single-year: thousands of seeded
     randomized households priced by the engine and by the
     independent second implementation (from the law
     tables), diffed to the cent.
   - invariants-trajectory: money-conservation invariants
     across trajectory years (funding footing,
     terminal-wealth identity, basis bounds, loss-ledger
     conservation, non-negativity).
   - rounding-sweep: cent-quantization across the
     differential set, plus the cliff-tolerance pin.

   Registered checks (Part 2 — boundary pack, the
   deliberate enumeration the seeded differential only
   covers by chance; every boundary the engine prices,
   both sides, ±$1/±1¢ pins):
   - boundary-aca: ACA cliff / 100% FPL / 133% band edge,
     household sizes 1–5, years 2025–2028, engine vs
     independent vs hand-derived.
   - boundary-irmaa: every IRMAA tier edge, 2025+2026
     rows, all filing statuses; fractional top-tier
     ($499,999.50 stays tier 4, $500,000 is tier 5) and
     the deflated 2028 top.
   - boundary-brackets: every bracket top, both years,
     all statuses; marginal step AT the top (the rate the
     next dollar faces), +$100 tax step, differential
     equality at top±1¢.
   - boundary-gains: LTCG 0% top and 20% floor, both
     years, all statuses; ordinary-first stack;
     cgStackTax straddle. Closes the harness generator's
     LTCG-zero-top gap (all zero-top pins land on top:
     gains > 0, no itemized, in every construction).
   - boundary-deductions: standard/itemized tie (→
     standard), §68, charitable floor/ceiling, §170(p),
     senior deduction phase-out.
   - boundary-salt: SALT cap, 30% phase-down, floor,
     schedule 2027–2029, 2030 reversion.
   - boundary-rmd-claim: RMD age by birth year, uniform
     divisors 72–120, joint grid with the exactly-10 gap
     → uniform, FRA table, claiming factors, anchor
     derivation.
   - boundary-phase-outs: AMT exemption phase-out and
     breakpoint (tentative, not owed), §25A keep fraction,
     §86 provisional thresholds, NIIT (AGI, not MAGI).
   - boundary-wa-excise: WA excise pure pricer and
     priced-year integration, incl. the deflated surtax
     threshold.
   - boundary-fafsa-kiddie: FAFSA $40,000 asset gate on
     the march warnings, kiddie $2,700 threshold,
     cgStackTax straddle.

   Registered checks (Part 3 — known-answer checks, published
   worked examples priced by the engine vs the published answer;
   each module cites its publication, section, and example number):
   - known-pub915: IRS Pub. 915 (2025) Worksheet 1 Examples 1–3
     (§86 taxable Social Security; Ex. 4 MFS out of scope — no MFS
     thresholds; Ex. 2 direct-only — priceYear has no Schedule 1
     adjustments input).
   - known-pub590b: IRS Pub. 590-B (2025) RMD worked examples
     ($100,000 ÷ 24.6 and ÷ 25.3, both legs of the excess-distribution
     example). The 2026 leg is pinned to the corrected $1,364.71
     (divisor 25.5 at age 74); the publication's printed $1,313
     (divisor 26.5) contradicts its own rule and Table III — an
     adjudicated disagreement, engine right.
   - known-ssa: SSA Benefits Planner age-62 chart ($1,000-at-FRA
     dollars by birth year) and POMS RS 00615.693 age-70 percentages,
     vs the claiming-age derivation (SSA truncates monthly dollars;
     factors pinned exact, dollars within $1).
   - known-pub17: IRS Pub. 17 (2025) Ch. 10 standard-deduction
     Examples 1 and 3 end-to-end through priceYear, plus the 2025
     and 2026 law rows (blind Example 2 and dependent Table 10-3
     out of scope — no blindness or dependent concept; Tax Table
     out of scope — formula brackets, not the $50-range table).
   - known-trinity: the Trinity benchmark, wired in (Cooley,
     Hubbard & Walz 1998 Table 3, ±6pt).
   - known-mc-golden: the Monte Carlo golden shocks, wired in
     (externally computed mulberry32/Box–Muller literals, 1e-9).
   - known-maxifi: the MaxiFi property, wired in (joint beats both
     separate optima). No MaxiFi-published dollar figure exists in
     the repo; the check pins the named property, not a published
     figure. Costs ~7–15s per invocation (two per registry run);
     the fast suite now takes tens of seconds, still well inside
     the 120s worker cap.

   Registered checks (Part 4 — sensitivity review, the
   directional/monotonicity probes: a small input change must
   move the output in the expected direction, never the other
   way; each module prices the fictional sample household and
   carries its own teeth check):
   - sens-return: ending wealth non-decreasing in expected
     return (Do Nothing ladder 3–7%, full adds 4.75/5.25%).
   - sens-spending: ending wealth non-increasing in annual
     spending (Do Nothing ladder $165k–$190k/yr, full adds
     $179k/$181k).
   - sens-caps: conversion-cap net-cost ordering (Fill 22% <
     Fill to cliff < Fill 12% < Do Nothing) stable across a
     9-point perturbation grid (spending ±$1,000, return
     ±0.25%, corners); a pair may swap only inside the $5,000
     near-tie band (only Do Nothing / Fill 12% is within it).
   - sens-cliff: ACA credit non-increasing in MAGI across the
     cliff (direct ladder, HH4/HH2/HH5 in full) and in pre-tax
     draw at $1 steps through the December path; the 100%
     FPL edge is out of scope by design (the credit jumps
     from $0 below it to the full credit at it).
   - sens-mc-seed: runMonteCarlo never-out rate agrees across
     seeds within 4 standard errors of binomial sampling
     noise (two plans, fast 2 seeds, full 6).
   - sens-strips: the optimizer's return strip (winner net
     cost non-decreasing at 4/5/6%) and heir-rate strip
     (winner and Do Nothing net cost non-decreasing at
     0/22/32%); winner names are never asserted — the return
     strip's winner legitimately changes brackets. At every
     point on both strips the winner must also STRICTLY beat
     Do Nothing repriced independently (the same two calls
     scoreAllCandidates uses for its Do Nothing entry,
     applied directly), never the sensitivity helper's own
     doNothing field. Fast runs the return strip only
     (~10s); full runs both (~20s); teeth re-prices both
     strips (~18s) in either mode, so the module costs the
     suite ~28s fast / ~37s full.

   Later builds register further families here without
   touching the runner. runHardeningChecks("fast") is the
   suite-safe run (small seeded subsets, seconds); "full"
   is the committed bun script's run (thousands of
   households). The teeth result aggregates each module's
   own teeth check, in the shared convention (failedCount
   counts the corrupted pins that failed as they should). */

import { boundaryAcaCheck } from "./boundaryAca";
import { boundaryBracketsCheck } from "./boundaryBrackets";
import { boundaryDeductionsCheck } from "./boundaryDeductions";
import { boundaryFafsaKiddieCheck } from "./boundaryFafsaKiddie";
import { boundaryGainsCheck } from "./boundaryGains";
import { boundaryIrmaaCheck } from "./boundaryIrmaa";
import { boundaryPhaseOutsCheck } from "./boundaryPhaseOuts";
import { boundaryRmdClaimCheck } from "./boundaryRmdClaim";
import { boundarySaltCheck } from "./boundarySalt";
import { boundaryWaCheck } from "./boundaryWa";
import { differentialCheck } from "./differential";
import { invariantsCheck } from "./invariants";
import { knownMaxifiCheck } from "./knownMaxifi";
import { knownMcGoldenCheck } from "./knownMcGolden";
import { knownPub17Check } from "./knownPub17";
import { knownPub590bCheck } from "./knownPub590b";
import { knownPub915Check } from "./knownPub915";
import { knownSsaCheck } from "./knownSsa";
import { knownTrinityCheck } from "./knownTrinity";
import { roundingCheck } from "./rounding";
import { sensCapsCheck } from "./sensCaps";
import { sensCliffCheck } from "./sensCliff";
import { sensMcSeedCheck } from "./sensMcSeed";
import { sensReturnCheck } from "./sensReturn";
import { sensSpendingCheck } from "./sensSpending";
import { sensStripsCheck } from "./sensStrips";
import type {
  HardeningCheckResult,
  HardeningTeethResult,
} from "./types";

export const HARDENING_REGISTRY = [
  differentialCheck,
  invariantsCheck,
  roundingCheck,
  boundaryAcaCheck,
  boundaryIrmaaCheck,
  boundaryBracketsCheck,
  boundaryGainsCheck,
  boundaryDeductionsCheck,
  boundarySaltCheck,
  boundaryRmdClaimCheck,
  boundaryPhaseOutsCheck,
  boundaryWaCheck,
  boundaryFafsaKiddieCheck,
  knownPub915Check,
  knownPub590bCheck,
  knownSsaCheck,
  knownPub17Check,
  knownTrinityCheck,
  knownMcGoldenCheck,
  knownMaxifiCheck,
  sensReturnCheck,
  sensSpendingCheck,
  sensCapsCheck,
  sensCliffCheck,
  sensMcSeedCheck,
  sensStripsCheck,
];

export type HardeningReport = {
  mode: "fast" | "full";
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  checks: HardeningCheckResult[];
  teeth: HardeningTeethResult;
};

export function runHardeningChecks(
  mode: "fast" | "full",
): HardeningReport {
  const checks =
    mode === "full"
      ? HARDENING_REGISTRY.map((m) => m.runFull())
      : HARDENING_REGISTRY.map((m) => m.runFast());
  const teethResults = HARDENING_REGISTRY.map((m) => m.runTeeth());
  const teeth: HardeningTeethResult = {
    corruptedCaseId: teethResults.map((t) => t.corruptedCaseId).join(" | "),
    failedCount: teethResults.reduce((n, t) => n + t.failedCount, 0),
    pass: teethResults.every((t) => t.pass),
  };
  return {
    mode,
    totalChecks: checks.length,
    passedChecks: checks.filter((c) => c.pass).length,
    failedChecks: checks.filter((c) => !c.pass).length,
    checks,
    teeth,
  };
}
