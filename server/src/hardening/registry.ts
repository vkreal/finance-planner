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

   Later builds register further families here (boundary
   pack, known-answer checks, sensitivity review) without
   touching the runner. runHardeningChecks("fast") is the
   suite-safe run (small seeded subsets, seconds); "full"
   is the committed bun script's run (thousands of
   households). The teeth result aggregates each module's
   own teeth check, in the shared convention (failedCount
   counts the corrupted pins that failed as they should). */

import { differentialCheck } from "./differential";
import { invariantsCheck } from "./invariants";
import { roundingCheck } from "./rounding";
import type {
  HardeningCheckResult,
  HardeningTeethResult,
} from "./types";

export const HARDENING_REGISTRY = [
  differentialCheck,
  invariantsCheck,
  roundingCheck,
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
