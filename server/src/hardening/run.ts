/* ---------------- Hardening runner script ----------------
   Part 1 of the hardening block (Oct 16 hardening options).
   The committed bun script: the primary runner for the
   full hardening run. The thousands-of-households
   differential cannot run inside a worker call (the 120s
   cap and the census OOM history force this), so the full
   run lives here; the accuracy self-check's "hardening"
   suite entry runs the fast subset instead.

   Usage: bun server/src/hardening/run.ts [--fast | --full]
   Defaults to --full. Prints the report as JSON plus a
   one-line human summary; exits 1 when any check fails
   or any teeth check fails, 0 when the registry is clean. */

import { runHardeningChecks } from "./registry";

if (import.meta.main) {
  const mode = process.argv.includes("--fast") ? "fast" : "full";
  const report = runHardeningChecks(mode);
  console.log(JSON.stringify(report, null, 1));
  const ok = report.failedChecks === 0 && report.teeth.pass;
  console.log(
    `hardening ${mode}: ${report.passedChecks}/${report.totalChecks} checks passed; teeth ${report.teeth.pass ? "pass" : "FAIL"} (${report.teeth.failedCount} corrupted pins failed as expected)`,
  );
  if (!ok) process.exit(1);
}
