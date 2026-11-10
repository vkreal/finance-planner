/* ---------------- Hardening registry: shared types ----------------
   Part 1 of the hardening block (Oct 16: "why not do all?" /
   "Do all of them but make it last" / "Implement it in way we
   can refactor or add new"). The check registry's shared
   vocabulary, kept in its own leaf module so the check
   modules and the registry both import it with no import
   cycle: a check module declares its inputs and assertions
   by conforming to HardeningCheckModule, and the registry
   (registry.ts) executes the registered modules and reports
   per-check verdicts. Adding a check = adding a module that
   conforms to this interface and registering it. */

export type HardeningCheckResult = {
  // Stable machine id of the check (e.g. "differential-single-year").
  id: string;
  // Human name shown in reports.
  name: string;
  pass: boolean;
  // One-paragraph human summary: what ran, how much, what
  // was found. Includes the household/case counts and the
  // coverage summary for the differential.
  detail: string;
  // Failure lines, first N (human-readable, one per
  // mismatch or violated invariant). Empty when passing.
  failures: string[];
  // Machine counts the runner and the suite surface
  // (households priced, fields compared, mismatches,
  // invariants checked, violations).
  counts: Record<string, number>;
};

// The teeth-check result, in the same shape the existing
// teeth suites report (corruptedCaseId / failedCount /
// pass): corrupt one pin and exactly that check
// must fail. A module's runTeeth proves its own assertions
// have teeth — a check that cannot fail is not a check.
export type HardeningTeethResult = {
  corruptedCaseId: string;
  failedCount: number;
  pass: boolean;
};

export type HardeningCheckModule = {
  id: string;
  name: string;
  // The suite-safe run: fast enough for the accuracy
  // self-check worker call (invariants + a small seeded
  // differential subset). Must complete in seconds.
  runFast(): HardeningCheckResult;
  // The full run: the committed bun script's run (thousands
  // of seeded households, full sweeps). Same assertions,
  // larger N.
  runFull(): HardeningCheckResult;
  // The module's own teeth check: corrupt one pin
  // and prove exactly that check fails.
  runTeeth(): HardeningTeethResult;
};
