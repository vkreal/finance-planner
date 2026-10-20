// Packaged-build verification harness.
//
// Runs the packaged runtime (real server actions + local adapter) in
// bun against an in-memory store and verifies, against the same
// numbers the live app produces:
//   A. Contract: describeApi reports contract v10 and all 90 actions.
//   B. Fixture census: extended 85 · roth-cas 15 · retirement-cas 16 ·
//      ui-state 9 · retirement 55 · integrity 0 through the packaged
//      dispatcher (plus teeth suites), and the tax census 329 run
//      chunked from the same bundled fixture module (taxtest.ts —
//      the single-call suite OOMs on this machine exactly as it
//      exceeds the live worker's call cap, standing limitation S-2).
//   C. Seeded state + the describeApi runRothCompare example priced
//      to the live-pinned figures.
//   D. Backup interop: exportbackup -> clearAllData -> restorebackup
//      round trip; createBackupNow .mstbak envelope decrypted with
//      the install's private key and verified against its sha256.
//   E. Persistence: a second runtime over the same store reads back
//      identical state (the localStorage chunk round trip).
//   F. CAS spot check: a stale-revision saveRothInputs is refused
//      and leaves the stored record untouched.
//
// Run via packaged/run-harness.mjs (which bundles this file with the
// same resolver seams as the browser build).
import { createRuntime } from "./src/runtime";
import { memoryStore, BACKUPS_KEY, RSA_PRIV_KEY } from "./src/storage";

const wasmPath = process.env.FPKG_WASM;
if (!wasmPath) throw new Error("FPKG_WASM env var is required");

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}
function eq(label: string, actual: unknown, expected: unknown) {
  check(
    label,
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

const store = memoryStore();
const rt = await createRuntime({ store, wasmUrl: wasmPath });

// ---------- A. Contract ----------
// describeApi with no action filter returns the full contract;
// passing {action} returns just that action's entry.
const api = await rt.call<any>("describeApi", {});
eq("A1 apiContractVersion", api.apiContractVersion, 10);
eq("A2 action count", api.actions.length, 90);
eq("A3 actionsMissingPurpose", api.actionsMissingPurpose, []);

// ---------- B. Fixture census ----------
async function suite(name: string): Promise<any> {
  const t0 = Date.now();
  const res = await rt.call<any>("runAccuracySelfCheck", { suite: name });
  console.log(`  suite ${name}: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return res;
}
// FPKG_ONLY (comma-separated suite names) runs just those suites and
// exits; FPKG_SKIP skips the named suites and continues with the
// remaining phases. The full tax suite is heavy enough (multiple GB
// of fixture state) to deserve its own process — exactly as it runs
// in its own worker on the live app (standing limitation S-2) — so
// run-harness.mjs runs it separately via FPKG_ONLY.
const only = (process.env.FPKG_ONLY ?? "").split(",").filter(Boolean);
const skip = (process.env.FPKG_SKIP ?? "").split(",").filter(Boolean);
const want = (name: string) =>
  (only.length === 0 || only.includes(name)) && !skip.includes(name);
if (want("integrity")) {
  const integrity = await suite("integrity");
  eq("B-integrity violations", integrity.integrity?.totalViolations, 0);
}
if (want("extended")) {
  const extended = await suite("extended");
  eq("B-extended passed", extended.extendedFixtures?.passed, 85);
  eq("B-extended total", extended.extendedFixtures?.total, 85);
}
if (want("retirement")) {
  const retirement = await suite("retirement");
  eq("B-retirement passed", retirement.fixtures?.passed, 55);
}
if (want("roth-cas")) {
  const rothCas = await suite("roth-cas");
  eq("B-roth-cas passed", rothCas.rothCasFixtures?.passed, 15);
}
if (want("retirement-cas")) {
  const retCas = await suite("retirement-cas");
  eq("B-retirement-cas passed", retCas.retirementCasFixtures?.passed, 16);
}
if (want("ui-state")) {
  const uiState = await suite("ui-state");
  eq("B-ui-state passed", uiState.uiStateFixtures?.passed, 9);
}
if (want("tax")) {
  // The tax census runs chunked in its own processes (see
  // packaged/taxtest.ts and run-harness.mjs): the single-call suite
  // exceeds this machine's memory exactly as it exceeds the live
  // worker's call cap (S-2). Nothing is asserted here.
  console.log("  suite tax: verified by the chunked census in run-harness");
}
if (want("extended-teeth")) {
  const extTeeth = await suite("extended-teeth");
  check(
    "B-extended-teeth all pass",
    (extTeeth.teeth?.extended?.results ?? []).every((r: any) => r.pass),
  );
}
if (want("retirement-teeth")) {
  const retTeeth = await suite("retirement-teeth");
  check(
    "B-retirement-teeth all pass",
    (retTeeth.teeth?.retirement?.results ?? []).every((r: any) => r.pass),
  );
}
if (only.length > 0) {
  console.log(`\n${checks - failures}/${checks} harness checks passed (FPKG_ONLY=${only.join(",")})`);
  process.exit(failures === 0 ? 0 : 1);
}

// ---------- C. Seeded state + example pricing ----------
const nw = await rt.call<any>("getNetWorth", {});
const snapTotals: number[] = (nw.snapshots ?? []).map((s: any) => s.totalCents);
check("C1 seeded NW snapshots present", snapTotals.length > 0, `${snapTotals.length} snapshots`);
eq("C2 seeded NW first snapshot total", snapTotals[0], 261000000);
eq("C3 seeded NW last snapshot total", snapTotals[snapTotals.length - 1], 306250000);
const planner = await rt.call<any>("getRothPlanner", {});
// Live-fresh parity: with no Roth record stored yet, getRothPlanner
// returns saved === null (the Roth tab seeds its form client-side).
// resetRothPlanner is the action that materializes the seeded record.
eq("C4 fresh store has no Roth record yet", planner.saved, null);
const reset = await rt.call<any>("resetRothPlanner", {});
eq("C5 resetRothPlanner ok", reset.ok, true);
const seededPlanner = await rt.call<any>("getRothPlanner", {});
eq("C6 seeded Roth birthYearPrimary", seededPlanner.saved?.birthYearPrimary, 1975);
eq("C7 seeded Roth birthYearSpouse", seededPlanner.saved?.birthYearSpouse, 1985);
eq("C8 seeded Roth SS primary", seededPlanner.saved?.ssPrimaryAnnualCents, 4800000);
eq("C9 seeded Roth protect-min", seededPlanner.saved?.protectMinTaxableCents, 5000000);
eq("C10 seeded Roth preserve", seededPlanner.saved?.preservePretaxCents, 25000000);
eq("C11 seeded Roth heir rate", seededPlanner.saved?.heirRatePct, 24);
const dash = await rt.call<any>("getDashboard", { month: "2026-09" });
eq("C12 seeded dashboard hasAnyData", dash.hasAnyData, true);

const example = api.examples.find((e: any) => e.action === "runRothCompare");
check("C13 describeApi example present", !!example);
const priced = await rt.call<any>("runRothCompare", example.request);
const base = priced.scenarios?.[0];
// Figures pinned from the LIVE app's describeApi example response
// (contract v10, captured 2026-10-19 before any packaged code ran).
eq("C14 example endingAfterTaxWealthCents", base?.endingAfterTaxWealthCents, 3913424968);
eq("C15 example netCostCents", base?.netCostCents, 194504904);
eq("C16 example endingPretaxCents", base?.endingPretaxCents, 330981245);
eq("C17 example endingRothCents", base?.endingRothCents, 1924336965);
eq("C18 example endingTaxableCents", base?.endingTaxableCents, 1601394776);
eq("C19 example endingHsaCents", base?.endingHsaCents, 136147480);
eq("C20 example terminalCents", base?.terminalCents, 79435499);
eq("C21 example totalTaxCents", base?.totalTaxCents, 108376285);
eq("C22 example irmaaCents", base?.irmaaCents, 6693120);
eq("C23 example ssCollectedCents", base?.ssCollectedCents, 139200000);

// Playground year on a synthetic neutral shape — figures pinned from
// the LIVE app (runPlaygroundYear, same request, 2026-10-19).
const pg = await rt.call<any>("runPlaygroundYear", {
  taxYear: 2026, filingStatus: "mfj", agePrimary: 60, ageSpouse: 50,
  onMedicarePrimary: false, onMedicareSpouse: false, interest: 4000,
  ordinaryDividends: 9000, otherOrdinary: 0, taxExemptInterest: 500,
  ssPrimary: 0, ssSpouse: 0, conversion: 100000, stockSold: 20000,
  stockBasis: 12000, qualifiedDividends: 7000, pretaxBalance: 1500000,
  spouseSoleBeneficiary: true, acaHouseholdSize: 2,
  acaBenchmarkAnnual: 22000, stateRatePct: 0,
});
eq("C24 playground magi (live-pinned)", pg.result?.magi, 128500);
eq("C25 playground federalTax (live-pinned)", pg.result?.federalTax, 9200);
eq("C26 playground lawYearUsed (live-pinned)", pg.lawYearUsed, 2026);

// ---------- D. Backup / restore interop ----------
const payload = await rt.call<any>("exportbackup", {});
check("D1 exportbackup payload has tables", !!payload && typeof payload === "object");
const nwBefore = await rt.call<any>("getNetWorth", {});
const cleared = await rt.call<any>("clearAllData", { confirm: "delete everything" });
eq("D2 clearAllData ok", cleared.ok, true);
const dashWiped = await rt.call<any>("getDashboard", { month: "2026-09" });
eq("D3 wiped dashboard hasAnyData", dashWiped.hasAnyData, false);
const restored = await rt.call<any>("restorebackup", payload);
eq("D4 restorebackup ok", restored.ok, true);
const nwAfter = await rt.call<any>("getNetWorth", {});
eq(
  "D5 NW totals identical after restore",
  (nwAfter.snapshots ?? []).map((s: any) => s.totalCents),
  (nwBefore.snapshots ?? []).map((s: any) => s.totalCents),
);

const created = await rt.call<any>("createBackupNow", {});
eq("D6 createBackupNow ok", created.ok, true);
check("D7 backup filename shape", /^backup-.*\.mstbak$/.test(created.filename ?? ""), created.filename);
const listed = await rt.call<any>("listBackups", {});
eq("D8 listBackups count", listed.backups?.length, 1);
eq("D9 listBackups name", listed.backups?.[0]?.name, created.filename);

const vault = JSON.parse(store.get(BACKUPS_KEY) ?? "[]") as any[];
const envelope = JSON.parse(vault[0].envelopeJson);
eq("D10 envelope format", envelope.format, "mst-backup-enc");
eq("D11 envelope v", envelope.v, 2);
eq("D12 envelope alg", envelope.alg, "RSA-4096-OAEP-SHA256 + AES-256-GCM");
// Decrypt the envelope with the install's private key, exactly as the
// owner's offline tooling would: RSA-OAEP unwrap -> AES-256-GCM open.
const privJwk = JSON.parse(store.get(RSA_PRIV_KEY) ?? "null");
const privKey = await crypto.subtle.importKey(
  "jwk",
  privJwk,
  { name: "RSA-OAEP", hash: "SHA-256" },
  false,
  ["decrypt"],
);
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const dataKeyRaw = new Uint8Array(
  await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privKey, b64(envelope.wrappedKey) as BufferSource),
);
const aesKey = await crypto.subtle.importKey("raw", dataKeyRaw as BufferSource, { name: "AES-GCM" }, false, ["decrypt"]);
const sealed = new Uint8Array(b64(envelope.data).length + b64(envelope.tag).length);
sealed.set(b64(envelope.data), 0);
sealed.set(b64(envelope.tag), b64(envelope.data).length);
const plainBytes = new Uint8Array(
  await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(envelope.iv) as BufferSource }, aesKey, sealed as BufferSource),
);
const plainText = new TextDecoder().decode(plainBytes);
const digest = await crypto.subtle.digest("SHA-256", plainBytes as BufferSource);
const digestHex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
eq("D13 envelope payloadSha256 verifies", digestHex, envelope.payloadSha256);
check("D14 decrypted payload is a backup payload", (() => { try { const p = JSON.parse(plainText); return typeof p === "object" && p !== null; } catch { return false; } })());

const deleted = await rt.call<any>("deleteBackup", { filename: created.filename });
eq("D15 deleteBackup ok", deleted.ok, true);
const listedAfterDelete = await rt.call<any>("listBackups", {});
eq("D16 listBackups after delete", listedAfterDelete.backups?.length, 0);

// ---------- E. Persistence across runtimes (same store) ----------
const plannerBeforeReload = await rt.call<any>("getRothPlanner", {});
const rt2 = await createRuntime({ store, wasmUrl: wasmPath });
const nwReloaded = await rt2.call<any>("getNetWorth", {});
eq(
  "E1 NW totals identical after reload",
  (nwReloaded.snapshots ?? []).map((s: any) => s.totalCents),
  (nwAfter.snapshots ?? []).map((s: any) => s.totalCents),
);
const plannerReloaded = await rt2.call<any>("getRothPlanner", {});
eq("E2 Roth revision survives reload", plannerReloaded.revision, plannerBeforeReload.revision);
eq(
  "E3 Roth record content survives reload",
  plannerReloaded.saved?.birthYearPrimary,
  plannerBeforeReload.saved?.birthYearPrimary,
);

// ---------- F. CAS spot check ----------
const current = await rt2.call<any>("getRothPlanner", {});
const rev = current.revision as number;
// saveRothInputs is the strict writer: the complete record, flattened
// (plan fields + execution-year + MC + gift blocks), plus baseRevision.
const saveArgs = {
  ...current.saved,
  ...current.execution,
  ...current.mcCheck,
  ...current.gift,
  baseRevision: rev,
};
const savedOnce = await rt2.call<any>("saveRothInputs", saveArgs);
eq("F1 save at current revision ok", savedOnce.ok, true);
eq("F2 revision bumped", savedOnce.revision, rev + 1);
const stale = await rt2.dispatch("saveRothInputs", saveArgs);
const staleBody = JSON.parse(stale.body);
check(
  "F3 stale save refused as conflict (not ok)",
  stale.status === 200 ? staleBody.data?.ok === false : true,
  `status ${stale.status}`,
);
const afterStale = await rt2.call<any>("getRothPlanner", {});
eq("F4 revision unchanged by stale save", afterStale.revision, rev + 1);

console.log(`\n${checks - failures}/${checks} harness checks passed`);
process.exit(failures === 0 ? 0 : 1);
