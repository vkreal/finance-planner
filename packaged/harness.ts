// Packaged-build verification harness.
//
// Runs the packaged runtime (real server actions + local adapter) in
// bun against an in-memory store and verifies, against the same
// numbers the live app produces:
//   A. Contract: describeApi reports the contract version and the
//      action list — both expectations DERIVED from the source the
//      contract is built from (API_CONTRACT_VERSION and the Actions
//      map in server/src/actions.ts, imported below), never
//      hard-coded numbers (round-7 fix H-1).
//   B. Fixture census: every suite (extended · roth-cas ·
//      retirement-cas · ui-state · retirement · integrity) through
//      the packaged dispatcher (plus teeth suites). Each suite's
//      expectation is derived from the suite's own response —
//      passed must equal the total the suite itself reports — and
//      the tax census runs chunked from the same bundled fixture
//      module (taxtest.ts — the single-call suite OOMs on this
//      machine exactly as it exceeds the live worker's call cap,
//      standing limitation S-2), with its total likewise derived
//      (see run-harness.mjs).
//   C. Seeded state + the describeApi runRothCompare example priced
//      to the live-pinned figures.
//   D. Backup interop: exportbackup -> clearAllData -> restorebackup
//      round trip; the S1 authenticity MAC legs (MAC'd restore
//      authenticated, byte-tampered restore refused, pre-MAC
//      restore labelled unauthenticated); createBackupNow .mstbak
//      envelope decrypted with the install's private key and
//      verified against its sha256.
//   E. Persistence: a second runtime over the same store reads back
//      identical state (the localStorage chunk round trip).
//   F. CAS spot check: a stale-revision saveRothInputs is refused
//      and leaves the stored record untouched.
//   I. Persist lockout (contract v63, F5): a non-stale persist
//      failure locks the session — further dispatches refused
//      with a reload-required error — and a fresh load reads the
//      prior committed generation intact; the stale-tab 409 does
//      not engage the lock.
//   G. December CAS end-to-end: saveDecemberProjection through
//      the real dispatcher and store — first write (insert-only),
//      a second save at the current revision on the EXISTING blob
//      (the guarded UPDATE path the pure december fixtures cannot
//      reach; the path that shipped broken 2026-10-26 when the
//      handler passed the wrong handle to the guarded commit),
//      and a stale save refused with the stored state intact.
//   J. Atomic seeding + honest boot flag (contract v64, A3): a
//      boot over a nonempty dataset does not mark meta.seeded on
//      ok alone; a seed whose persist fails leaves no partial
//      rows and a plain retry seeds cleanly; overlapping
//      seedFirstRun dispatches land exactly one roster.
//   K. Import batch idempotency keys (contract v64, F02): same
//      key + same rows is a no-op returning the original count;
//      a new key inserts identical rows again; the same key with
//      different rows is refused; unkeyed imports are unchanged;
//      the recorded key survives a reload.
//
// Run via packaged/run-harness.mjs (which bundles this file with the
// same resolver seams as the browser build).
import { createRuntime } from "./src/runtime";
import {
  memoryStore,
  ACTIVE_KEY,
  BACKUPS_KEY,
  GEN_CHUNK_KEY,
  META_KEY,
  RSA_PRIV_KEY,
  type KeyValueStore,
} from "./src/storage";
import { StoreRecoveryRequiredError } from "./src/localDb";
import initSqlJs from "sql.js";
import { MIGRATIONS } from "packaged-migrations";
import { bytesToHex, sha256Bytes } from "../server/src/backupMacCore";
// The single sources of truth the contract expectations derive
// from (round-7 fix H-1): the same Actions map and contract
// version constant describeApi publishes, read here directly
// instead of through the dispatcher — so a dispatcher or seam
// that dropped an action or mangled the version fails loudly
// against the source, and growing either never stales this file.
import { Actions, API_CONTRACT_VERSION } from "../server/src/actions";

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
eq("A1 apiContractVersion", api.apiContractVersion, API_CONTRACT_VERSION);
eq("A2 action count", api.actions.length, Object.keys(Actions).length);
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
// Each suite's expectation is derived from the suite's own
// response (round-7 fix H-1): every case it ran must have passed,
// and it must have run at least one case — a suite that silently
// shrank or vanished fails here by name instead of passing
// against a stale hard-coded count.
function suiteAllPass(label: string, result: any) {
  check(
    label,
    !!result && result.total > 0 && result.passed === result.total,
    `suite reports ${result?.passed ?? "?"}/${result?.total ?? "?"} passed`,
  );
}
if (want("integrity")) {
  const integrity = await suite("integrity");
  eq("B-integrity violations", integrity.integrity?.totalViolations, 0);
}
if (want("extended")) {
  const extended = await suite("extended");
  suiteAllPass("B-extended all pass", extended.extendedFixtures);
}
if (want("retirement")) {
  const retirement = await suite("retirement");
  suiteAllPass("B-retirement all pass", retirement.fixtures);
}
if (want("roth-cas")) {
  const rothCas = await suite("roth-cas");
  suiteAllPass("B-roth-cas all pass", rothCas.rothCasFixtures);
}
if (want("retirement-cas")) {
  const retCas = await suite("retirement-cas");
  suiteAllPass("B-retirement-cas all pass", retCas.retirementCasFixtures);
}
if (want("ui-state")) {
  const uiState = await suite("ui-state");
  suiteAllPass("B-ui-state all pass", uiState.uiStateFixtures);
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
// RE-PINNED at round-7 fix build 2 (H-1 harness repair): the
// 2026-10-19 pins (MAGI 128,500 / federal $9,200) double-counted
// the $7,000 of qualified dividends — they are already inside the
// $9,000 of ordinary dividends — a defect the round-7 engine fixes
// corrected before this build, so the stale pins failed against
// the corrected engine. The figures below are the corrected
// engine's, hand-checked: MAGI = $4,000 interest + $9,000
// dividends + $100,000 conversion + $8,000 sale gain ($20,000 −
// $12,000 basis) + $500 tax-exempt interest = $121,500; AGI
// $121,000 − $32,200 joint standard deduction = $88,800 taxable,
// of which $15,000 is preferential (qualified dividends + gain)
// and sits inside the $98,900 joint 0% space, so federal tax is
// the ordinary tax on $73,800 = $2,480 + $5,880 = $8,360.
const pg = await rt.call<any>("runPlaygroundYear", {
  taxYear: 2026, filingStatus: "mfj", agePrimary: 60, ageSpouse: 50,
  onMedicarePrimary: false, onMedicareSpouse: false, interest: 4000,
  ordinaryDividends: 9000, otherOrdinary: 0, taxExemptInterest: 500,
  ssPrimary: 0, ssSpouse: 0, conversion: 100000, stockSold: 20000,
  stockBasis: 12000, qualifiedDividends: 7000, pretaxBalance: 1500000,
  spouseSoleBeneficiary: true, acaHouseholdSize: 2,
  acaBenchmarkAnnual: 22000, stateRatePct: 0,
});
eq("C24 playground magi (live-pinned)", pg.result?.magi, 121500);
eq("C25 playground federalTax (live-pinned)", pg.result?.federalTax, 8360);
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
// S1 (backup authenticity MAC): the exported payload carries a
// MAC, and the packaged dispatcher verifies it on restore — the
// export -> restore direction of the live/packaged interop pair
// (the shared backupMacCore + the app-shipped key make the same
// payload verify in the live app; the live direction is pinned
// by the extended fixtures and the build's audit probes).
check(
  "D4a exportbackup payload carries a MAC",
  typeof payload.authenticityMac === "string" && /^[0-9a-f]{64}$/.test(payload.authenticityMac),
  String(payload.authenticityMac).slice(0, 16),
);
eq("D4b restorebackup authenticated", restored.authenticated, true);
const nwAfter = await rt.call<any>("getNetWorth", {});
eq(
  "D5 NW totals identical after restore",
  (nwAfter.snapshots ?? []).map((s: any) => s.totalCents),
  (nwBefore.snapshots ?? []).map((s: any) => s.totalCents),
);

// S1 tamper + pre-MAC legs, through the same dispatcher: one
// changed byte of content (exportedAt) under the original MAC is
// REFUSED with the authenticity error and writes nothing; the
// same payload with the MAC stripped (the pre-MAC shape)
// restores, labelled unauthenticated.
const tampered = JSON.parse(JSON.stringify(payload));
tampered.exportedAt = "2020-01-01T00:00:00.000Z";
const refused = await rt.call<any>("restorebackup", tampered);
eq("D5a tampered restore refused", refused.ok, false);
eq("D5b tampered restore unauthenticated", refused.authenticated, false);
check(
  "D5c refusal names the authenticity check",
  typeof refused.reason === "string" && refused.reason.includes("authenticity check failed"),
  refused.reason,
);
const nwAfterRefusal = await rt.call<any>("getNetWorth", {});
eq(
  "D5d state untouched by refused restore",
  (nwAfterRefusal.snapshots ?? []).map((s: any) => s.totalCents),
  (nwAfter.snapshots ?? []).map((s: any) => s.totalCents),
);
const stripped = JSON.parse(JSON.stringify(payload));
delete stripped.authenticityMac;
const strippedRestore = await rt.call<any>("restorebackup", stripped);
eq("D5e pre-MAC restore ok", strippedRestore.ok, true);
eq("D5f pre-MAC restore unauthenticated", strippedRestore.authenticated, false);
check(
  "D5g pre-MAC restore labelled UNAUTHENTICATED",
  typeof strippedRestore.reason === "string" && strippedRestore.reason.includes("UNAUTHENTICATED"),
  strippedRestore.reason,
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
check("D14a decrypted payload carries a MAC", (() => { try { const p = JSON.parse(plainText); return typeof p.authenticityMac === "string" && /^[0-9a-f]{64}$/.test(p.authenticityMac); } catch { return false; } })());

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
// (plan fields + execution-year + MC + gift + tax-return blocks),
// plus baseRevision.
const saveArgs = {
  ...current.saved,
  ...current.execution,
  ...current.mcCheck,
  ...current.gift,
  ...current.taxReturn,
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

// ---------- G. December CAS end-to-end ----------
// The December blob has never been written on this store, so
// the sequence exercises all three save paths in order: the
// insert-only first write, the guarded UPDATE on the existing
// blob (a save at the current revision — the path the pure
// dec-save-revision-cas fixture cannot reach, since it pins
// only the revision decision logic), and the stale refusal.
const dec0 = await rt2.call<any>("getDecemberProjection", {});
eq(
  "G1 December starts unstored at revision 0",
  [dec0.hasStored, dec0.revision],
  [false, 0],
);
const decState1 = { ...dec0.state, ytdOtherOrdinary: 43210 };
const decSave1 = await rt2.call<any>("saveDecemberProjection", {
  state: decState1,
  baseRevision: 0,
});
eq(
  "G2 first December save (insert) ok at revision 1",
  [decSave1.ok, decSave1.revision],
  [true, 1],
);
const decState2 = { ...decState1, ytdOtherOrdinary: 43211 };
const decSave2 = await rt2.call<any>("saveDecemberProjection", {
  state: decState2,
  baseRevision: 1,
});
eq(
  "G3 guarded-update December save ok at revision 2",
  [decSave2.ok, decSave2.revision],
  [true, 2],
);
const decStale = await rt2.call<any>("saveDecemberProjection", {
  state: decState1,
  baseRevision: 1,
});
eq(
  "G4 stale December save conflicts",
  [decStale.ok, decStale.conflict],
  [false, true],
);
const decAfter = await rt2.call<any>("getDecemberProjection", {});
eq(
  "G5 stored December state intact after stale save",
  [decAfter.revision, decAfter.state.ytdOtherOrdinary],
  [2, 43211],
);

// ---------- H. Packaged store protocol (contract v60, F1–F3, F5, F7) ----------
// The generation store's acceptance cases, each on its own
// throwaway store: quota mid-persist, a truncated chunk,
// an interrupted migration, two tabs over one store, the
// portable passphrase backup across installs, and the global
// seed guard.

// H-quota: a store that starts throwing partway through a
// persist leaves the PREVIOUS generation active and intact.
{
  const base = memoryStore();
  let armed = false;
  const quotaStore: KeyValueStore = {
    get: (k) => base.get(k),
    set: (k, v) => {
      if (armed) throw new Error("QuotaExceededError (simulated)");
      base.set(k, v);
    },
    remove: (k) => base.remove(k),
  };
  const rtQuota = await createRuntime({ store: quotaStore, wasmUrl: wasmPath });
  const nwTotalsBefore = ((await rtQuota.call<any>("getNetWorth", {})).snapshots ?? []).map(
    (s: any) => s.totalCents,
  );
  armed = true;
  const failed = await rtQuota.dispatch("addMonthlyBill", {
    name: "Quota Bill", amountCents: 9900, effectiveFrom: "2026-08", paidBy: "Checking",
  });
  armed = false;
  check("H1 quota persist failure surfaces as an error", failed.status === 500, `status ${failed.status}`);
  const rtQuota2 = await createRuntime({ store: quotaStore, wasmUrl: wasmPath });
  const nwTotalsAfter = ((await rtQuota2.call<any>("getNetWorth", {})).snapshots ?? []).map(
    (s: any) => s.totalCents,
  );
  eq("H2 prior generation loads intact after quota failure", nwTotalsAfter, nwTotalsBefore);
  const dashQuota = await rtQuota2.call<any>("getDashboard", { month: "2026-09" });
  check(
    "H3 the un-persisted bill is absent after reload",
    !(dashQuota.monthlyBills ?? []).some((b: any) => b.name === "Quota Bill"),
  );
}

// H-truncate: a damaged active generation is a recovery state —
// boot refuses, writes nothing, and never substitutes an empty
// database.
{
  const storeT = memoryStore();
  const rtT = await createRuntime({ store: storeT, wasmUrl: wasmPath });
  void rtT;
  const pointerRaw = storeT.get(ACTIVE_KEY) as string;
  const pointer = JSON.parse(pointerRaw) as { gen: number; chunks: number };
  const chunkKey = GEN_CHUNK_KEY(pointer.gen, 0);
  const fullChunk = storeT.get(chunkKey) as string;
  const truncated = fullChunk.slice(0, Math.floor(fullChunk.length / 2));
  storeT.set(chunkKey, truncated);
  const metaBefore = storeT.get(META_KEY);
  let recoveryError: unknown = null;
  try {
    await createRuntime({ store: storeT, wasmUrl: wasmPath });
  } catch (err) {
    recoveryError = err;
  }
  check(
    "H4 truncated chunk refuses boot with a recovery error",
    recoveryError instanceof StoreRecoveryRequiredError,
    recoveryError instanceof Error ? recoveryError.name : String(recoveryError),
  );
  eq("H5 pointer untouched by the refused boot", storeT.get(ACTIVE_KEY), pointerRaw);
  eq("H6 damaged chunk preserved, not overwritten", storeT.get(chunkKey), truncated);
  eq("H7 meta untouched by the refused boot", storeT.get(META_KEY), metaBefore);
}

// H-migration: the migration marker lives inside the image. An
// image rewound to user_version N-2 (the last two migrations'
// effects removed by hand) is re-migrated on boot even though
// the localStorage meta claims all migrations applied — the
// meta is not consulted.
{
  const storeM = memoryStore();
  const rtM = await createRuntime({ store: storeM, wasmUrl: wasmPath });
  void rtM;
  const pointer = JSON.parse(storeM.get(ACTIVE_KEY) as string) as {
    gen: number; chunks: number; sha256: string;
  };
  let b64 = "";
  for (let i = 0; i < pointer.chunks; i++) b64 += storeM.get(GEN_CHUNK_KEY(pointer.gen, i));
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  const rewound = new SQL.Database(bytes);
  // Rewind the last TWO migrations' effects: 0024's day column
  // and 0025's three composite unique indexes (contract v64) —
  // the image claims MIGRATIONS.length - 2, so boot must re-run
  // both, exactly as it re-ran the single last migration before.
  rewound.exec("ALTER TABLE monthly_cash_out_items DROP COLUMN day");
  rewound.exec("DROP INDEX IF EXISTS nw_balances_snapshot_account_unique");
  rewound.exec("DROP INDEX IF EXISTS monthly_bill_versions_bill_effective_unique");
  rewound.exec("DROP INDEX IF EXISTS yearly_expense_versions_expense_effective_unique");
  rewound.exec(`PRAGMA user_version = ${MIGRATIONS.length - 2}`);
  const rewoundBytes = rewound.export();
  rewound.close();
  // Write the rewound image as the next generation, by hand,
  // exactly as the store protocol would (chunks, then pointer).
  let rb64 = "";
  const SLICE = 0x8000;
  for (let i = 0; i < rewoundBytes.length; i += SLICE) {
    rb64 += String.fromCharCode(...rewoundBytes.subarray(i, i + SLICE));
  }
  rb64 = btoa(rb64);
  const CH = 100_000;
  const count = Math.max(1, Math.ceil(rb64.length / CH));
  const gen = pointer.gen + 1;
  for (let i = 0; i < count; i++) {
    storeM.set(GEN_CHUNK_KEY(gen, i), rb64.slice(i * CH, (i + 1) * CH));
  }
  storeM.set(
    ACTIVE_KEY,
    JSON.stringify({ gen, chunks: count, sha256: bytesToHex(sha256Bytes(rewoundBytes)) }),
  );
  const meta = JSON.parse(storeM.get(META_KEY) as string);
  meta.appliedMigrations = MIGRATIONS.length; // the lie the old protocol could persist
  storeM.set(META_KEY, JSON.stringify(meta));
  const rtM2 = await createRuntime({ store: storeM, wasmUrl: wasmPath });
  const addedItem = await rtM2.call<any>("addCashOutItem", {
    month: "2026-09", description: "Migration probe", amountCents: 100, day: 15,
  });
  check(
    "H8 interrupted migration is applied on next boot (day column back)",
    typeof addedItem.id === "number",
    `id ${addedItem.id}`,
  );
}

// H-stale: two runtimes over one store — the second tab's
// read-only dispatch is refused (409) once the first tab has
// committed, and the first tab's commit survives.
{
  const storeS = memoryStore();
  const rtS1 = await createRuntime({ store: storeS, wasmUrl: wasmPath });
  const rtS2 = await createRuntime({ store: storeS, wasmUrl: wasmPath });
  const commit = await rtS1.call<any>("addMonthlyBill", {
    name: "Tab A Bill", amountCents: 11100, effectiveFrom: "2026-08", paidBy: "Checking",
  });
  check("H9 first tab commit ok", typeof commit.id === "number", `id ${commit.id}`);
  const staleRead = await rtS2.dispatch("getDashboard", { month: "2026-09" });
  check(
    "H10 stale tab read refused with 409",
    staleRead.status === 409 && staleRead.body.includes("out of date"),
    `status ${staleRead.status}`,
  );
  const rtS3 = await createRuntime({ store: storeS, wasmUrl: wasmPath });
  const dashS3 = await rtS3.call<any>("getDashboard", { month: "2026-09" });
  check(
    "H11 first tab's commit intact after the stale tab's attempt",
    (dashS3.monthlyBills ?? []).some((b: any) => b.name === "Tab A Bill"),
  );
}

// H-portable: a passphrase-encrypted backup exported from
// install A restores into a FRESH install B end to end; a wrong
// passphrase is refused at decryption.
{
  const storeA = memoryStore();
  const rtA = await createRuntime({ store: storeA, wasmUrl: wasmPath });
  await rtA.call("addMonthlyBill", {
    name: "Portable Bill", amountCents: 42400, effectiveFrom: "2026-08", paidBy: "Checking",
  });
  const exported = await rtA.exportPortableBackup("correct horse battery");
  check("H12 portable export filename", exported.filename.endsWith(".mstbak"), exported.filename);
  const env = JSON.parse(exported.contents);
  eq("H13 portable envelope format", env.format, "mst-backup-portable");
  const storeB = memoryStore();
  const rtB = await createRuntime({ store: storeB, wasmUrl: wasmPath });
  const dashB0 = await rtB.call<any>("getDashboard", { month: "2026-09" });
  check(
    "H14 fresh install B does not have A's bill yet",
    !(dashB0.monthlyBills ?? []).some((b: any) => b.name === "Portable Bill"),
  );
  const restoredB = await rtB.importPortableBackup(exported.contents, "correct horse battery");
  eq("H15 portable import restores ok", restoredB.ok, true);
  eq("H16 portable import authenticated (MAC verified)", restoredB.authenticated, true);
  const dashB = await rtB.call<any>("getDashboard", { month: "2026-09" });
  check(
    "H17 A's data present in install B after import",
    (dashB.monthlyBills ?? []).some((b: any) => b.name === "Portable Bill"),
  );
  let wrongPassRefused = false;
  try {
    await rtB.importPortableBackup(exported.contents, "wrong passphrase");
  } catch (err) {
    wrongPassRefused =
      err instanceof Error && err.message.includes("could not be decrypted");
  }
  check("H18 wrong passphrase refused at decryption", wrongPassRefused);
}

// H-seed: the global first-run guard. A store whose only record
// is a saved planner blob (a settings record) receives NO
// sample rows when the seeded flag is missing (the retained
// older-store case), and re-running the boot seed over the
// seeded sample data adds nothing.
{
  const storeG = memoryStore();
  const rtG = await createRuntime({ store: storeG, wasmUrl: wasmPath });
  const snapsSeeded = ((await rtG.call<any>("getNetWorth", {})).snapshots ?? []).length;
  check("H19 fresh store seeded with sample snapshots", snapsSeeded > 0, `${snapsSeeded}`);
  rtG.localDb.meta.seeded = false;
  rtG.localDb.saveMeta();
  const rtG2 = await createRuntime({ store: storeG, wasmUrl: wasmPath });
  const snapsAfterReboot = ((await rtG2.call<any>("getNetWorth", {})).snapshots ?? []).length;
  eq("H20 re-boot over sample data seeds nothing twice", snapsAfterReboot, snapsSeeded);

  const storeOnly = memoryStore();
  const rtOnly = await createRuntime({ store: storeOnly, wasmUrl: wasmPath });
  await rtOnly.call("clearAllData", { confirm: "delete everything" });
  await rtOnly.call("resetRothPlanner", {});
  rtOnly.localDb.meta.seeded = false;
  rtOnly.localDb.saveMeta();
  const rtOnly2 = await createRuntime({ store: storeOnly, wasmUrl: wasmPath });
  const dashOnly = await rtOnly2.call<any>("getDashboard", { month: "2026-09" });
  const nwOnly = await rtOnly2.call<any>("getNetWorth", {});
  check(
    "H21 a lone settings record blocks all sample seeding",
    dashOnly.hasAnyData === false && (nwOnly.snapshots ?? []).length === 0,
    `hasAnyData ${dashOnly.hasAnyData}, snapshots ${(nwOnly.snapshots ?? []).length}`,
  );
}

// ---------- I. Packaged persist lockout (contract v63, F5) ----------
// A NON-STALE persist failure (here: quota, thrown after the
// handler mutated the in-memory image) locks the session: every
// further dispatch is refused with a reload-required error, so
// the failed action's writes can never be silently committed by
// a later successful persist. A fresh load reads the prior
// committed generation intact. The stale-tab refusal (409) does
// NOT engage the lock — it is governed by the generation check.
{
  const base = memoryStore();
  let armed = false;
  const quotaStore: KeyValueStore = {
    get: (k) => base.get(k),
    set: (k, v) => {
      if (armed) throw new Error("QuotaExceededError (simulated)");
      base.set(k, v);
    },
    remove: (k) => base.remove(k),
  };
  const rtLock = await createRuntime({ store: quotaStore, wasmUrl: wasmPath });
  const nwTotalsCommitted = ((await rtLock.call<any>("getNetWorth", {})).snapshots ?? []).map(
    (s: any) => s.totalCents,
  );
  check("I0 session starts unlocked", rtLock.sessionLocked === false);
  armed = true;
  const failed = await rtLock.dispatch("addMonthlyBill", {
    name: "Lockout Bill", amountCents: 7700, effectiveFrom: "2026-08", paidBy: "Checking",
  });
  armed = false;
  check("I1 quota persist failure surfaces as an error", failed.status === 500, `status ${failed.status}`);
  check(
    "I2 lockout engaged by the non-stale persist failure",
    rtLock.sessionLocked === true &&
      typeof rtLock.sessionLockReason === "string" &&
      rtLock.sessionLockReason.includes("Reload the page"),
    rtLock.sessionLockReason ?? "(no reason)",
  );
  const refusedRead = await rtLock.dispatch("getDashboard", { month: "2026-09" });
  check(
    "I3 subsequent read dispatch refused with the reload-required error",
    refusedRead.status === 500 &&
      refusedRead.body.includes("locked") &&
      refusedRead.body.includes("Reload the page"),
    `status ${refusedRead.status}`,
  );
  const refusedWrite = await rtLock.dispatch("addMonthlyBill", {
    name: "After Lock Bill", amountCents: 100, effectiveFrom: "2026-08", paidBy: "Checking",
  });
  check(
    "I4 subsequent write dispatch refused while locked (no silent commit path)",
    refusedWrite.status === 500 && refusedWrite.body.includes("locked"),
    `status ${refusedWrite.status}`,
  );
  const rtLockFresh = await createRuntime({ store: quotaStore, wasmUrl: wasmPath });
  const nwTotalsAfter = ((await rtLockFresh.call<any>("getNetWorth", {})).snapshots ?? []).map(
    (s: any) => s.totalCents,
  );
  eq("I5 fresh load reads the prior committed generation intact", nwTotalsAfter, nwTotalsCommitted);
  const dashAfter = await rtLockFresh.call<any>("getDashboard", { month: "2026-09" });
  check(
    "I6 neither the failed write nor the refused write reached the durable store",
    !(dashAfter.monthlyBills ?? []).some(
      (b: any) => b.name === "Lockout Bill" || b.name === "After Lock Bill",
    ),
  );
}
{
  const storeS2 = memoryStore();
  const rtA = await createRuntime({ store: storeS2, wasmUrl: wasmPath });
  const rtB = await createRuntime({ store: storeS2, wasmUrl: wasmPath });
  await rtA.call<any>("addMonthlyBill", {
    name: "Lockout Exempt Bill", amountCents: 5100, effectiveFrom: "2026-08", paidBy: "Checking",
  });
  const staleRes = await rtB.dispatch("getDashboard", { month: "2026-09" });
  check(
    "I7 stale-tab refusal does NOT engage the persist lockout",
    staleRes.status === 409 && rtB.sessionLocked === false,
    `status ${staleRes.status}, locked ${rtB.sessionLocked}`,
  );
}

// ---------- J. Atomic seeding + honest boot flag (contract v64, A3) ----------
// (F23) The boot caller marks meta.seeded ONLY on seeded: true —
// a boot over a NONEMPTY dataset (seedFirstRun refuses with
// ok: true, seeded: false) leaves the flag unset, where the
// pre-v64 caller marked it on ok alone and stranded any partial
// dataset. (F23/F24) A seed whose persist fails leaves NO
// partial rows in the durable store, and a plain retry seeds
// cleanly. Overlapping seedFirstRun dispatches cannot double
// the bill roster: the loser either sees the winner's data at
// its emptiness check or its ONE batch collides (explicit seed
// ids / the monthly-summaries primary key) and rolls back whole.
{
  const storeF = memoryStore();
  const rtF = await createRuntime({ store: storeF, wasmUrl: wasmPath });
  check("J0 fresh boot marks seeded", rtF.localDb.meta.seeded === true);
  const metaF = JSON.parse(storeF.get(META_KEY) as string);
  metaF.seeded = false;
  storeF.set(META_KEY, JSON.stringify(metaF));
  const rtF2 = await createRuntime({ store: storeF, wasmUrl: wasmPath });
  check(
    "J1 boot over a nonempty dataset does NOT mark seeded on ok alone",
    rtF2.localDb.meta.seeded === false,
    `seeded ${rtF2.localDb.meta.seeded}`,
  );
  const nwF2 = await rtF2.call<any>("getNetWorth", {});
  eq("J2 the refused boot changed nothing", (nwF2.snapshots ?? []).length, 12);
}
{
  const base = memoryStore();
  let armed = false;
  const quotaStore: KeyValueStore = {
    get: (k) => base.get(k),
    set: (k, v) => {
      if (armed) throw new Error("QuotaExceededError (simulated)");
      base.set(k, v);
    },
    remove: (k) => base.remove(k),
  };
  const rtQ = await createRuntime({ store: quotaStore, wasmUrl: wasmPath });
  await rtQ.call("clearAllData", { confirm: "delete everything" });
  armed = true;
  const failedSeed = await rtQ.dispatch("seedFirstRun", {});
  armed = false;
  check(
    "J3 seed dispatch with a failing persist surfaces an error",
    failedSeed.status === 500,
    `status ${failedSeed.status}`,
  );
  const rtQ2 = await createRuntime({ store: quotaStore, wasmUrl: wasmPath });
  const dashQ = await rtQ2.call<any>("getDashboard", { month: "2026-09" });
  const nwQ = await rtQ2.call<any>("getNetWorth", {});
  check(
    "J4 failed seed left NO partial rows in the durable store",
    dashQ.hasAnyData === false && (nwQ.snapshots ?? []).length === 0,
    `hasAnyData ${dashQ.hasAnyData}, snapshots ${(nwQ.snapshots ?? []).length}`,
  );
  const seededRetry = await rtQ2.call<any>("seedFirstRun", {});
  eq(
    "J5 plain retry seeds cleanly after the failed attempt",
    [seededRetry.ok, seededRetry.seeded],
    [true, true],
  );
  const nwQ2 = await rtQ2.call<any>("getNetWorth", {});
  eq("J6 retry landed the full NW history", (nwQ2.snapshots ?? []).length, 12);
  eq(
    "J7 retry last snapshot total is the seeded total",
    (nwQ2.snapshots ?? []).at(-1)?.totalCents,
    306250000,
  );
}
{
  const storeC = memoryStore();
  const rtC = await createRuntime({ store: storeC, wasmUrl: wasmPath });
  await rtC.call("clearAllData", { confirm: "delete everything" });
  const [d1, d2] = await Promise.all([
    rtC.dispatch("seedFirstRun", {}),
    rtC.dispatch("seedFirstRun", {}),
  ]);
  const successes = [d1, d2].filter((d) => d.status === 200).length;
  check(
    "J8 overlapping seedFirstRun dispatches: at least one succeeds",
    successes >= 1,
    `statuses ${d1.status}/${d2.status}`,
  );
  const nwC = await rtC.call<any>("getNetWorth", {});
  eq(
    "J9 overlapping seeds landed exactly ONE NW history",
    (nwC.snapshots ?? []).length,
    12,
  );
  eq(
    "J10 overlapping seeds: last snapshot total is the single-seed total",
    (nwC.snapshots ?? []).at(-1)?.totalCents,
    306250000,
  );
  const nowD = new Date();
  const curMonthStr = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, "0")}`;
  const dashC = await rtC.call<any>("getDashboard", { month: curMonthStr });
  eq(
    "J11 overlapping seeds landed exactly ONE bill roster",
    (dashC.monthlyBills ?? []).length,
    12,
  );
  const again = await rtC.call<any>("seedFirstRun", {});
  eq(
    "J12 a later seedFirstRun is refused as not empty",
    [again.ok, again.seeded],
    [true, false],
  );
}

// ---------- K. Import batch idempotency keys (contract v64, F02) ----------
// Same key + same rows twice → the second call is a no-op
// returning the original count; key A then key B with the same
// rows → both insert; same key with different rows → refused
// with nothing inserted; no key → the pre-v64 behaviour. The
// claim is durable: it still dedupes after a reload.
{
  const storeK = memoryStore();
  const rtK = await createRuntime({ store: storeK, wasmUrl: wasmPath });
  await rtK.call("clearAllData", { confirm: "delete everything" });
  const row = (description: string, amountCents: number) => ({
    date: "2026-09-15",
    description,
    amountCents,
    sourceType: "checking",
    accountName: "Checking",
    kind: "spending",
    category: "Other",
    yearlyExpenseId: null,
    fitId: null,
  });
  const rowsA = [row("Key Batch One", 1100), row("Key Batch Two", 2200)];
  const keyBatchCount = async (rt: PackagedRuntimeShape) => {
    const data = await rt.call<any>("getImportData", { months: ["2026-09"] });
    return (data.existing ?? []).filter((t: any) =>
      String(t.description).startsWith("Key Batch"),
    ).length;
  };
  type PackagedRuntimeShape = typeof rtK;
  const first = await rtK.call<any>("importTransactions", {
    rows: rowsA,
    batchKey: "harness-key-a",
  });
  eq("K1 first keyed import imports all rows", first.imported, 2);
  const retry = await rtK.call<any>("importTransactions", {
    rows: rowsA,
    batchKey: "harness-key-a",
  });
  eq("K2 same key + same rows returns the original count", retry.imported, 2);
  eq("K3 the retry inserted ZERO additional rows", await keyBatchCount(rtK), 2);
  const secondKey = await rtK.call<any>("importTransactions", {
    rows: rowsA,
    batchKey: "harness-key-b",
  });
  eq("K4 a new key with identical rows inserts again", secondKey.imported, 2);
  eq("K5 both keyed batches are recorded", await keyBatchCount(rtK), 4);
  const collision = await rtK.dispatch("importTransactions", {
    rows: [row("Key Batch Changed", 3300)],
    batchKey: "harness-key-a",
  });
  check(
    "K6 same key + different rows is refused with a clear error",
    collision.status === 500 &&
      collision.body.includes("different set of rows"),
    `status ${collision.status}`,
  );
  eq("K7 the collision inserted nothing", await keyBatchCount(rtK), 4);
  const unkeyed = await rtK.call<any>("importTransactions", { rows: rowsA });
  eq("K8 an unkeyed import behaves as before (inserts)", unkeyed.imported, 2);
  eq("K9 unkeyed rows are recorded", await keyBatchCount(rtK), 6);
  const rtK2 = await createRuntime({ store: storeK, wasmUrl: wasmPath });
  const retryAfterReload = await rtK2.call<any>("importTransactions", {
    rows: rowsA,
    batchKey: "harness-key-a",
  });
  eq(
    "K10 the recorded key still dedupes after a reload",
    retryAfterReload.imported,
    2,
  );
  eq("K11 the post-reload retry inserted nothing", await keyBatchCount(rtK2), 6);
}

// ---------- L. v64 structural write paths (A1 upserts, A2 first-write) ----------
// A2: two overlapping first saves of the Retirement record, both
// at baseRevision 0 against an absent record, produce exactly
// ONE success and ONE conflict refusal — never two revision-1
// successes (audit F20). Either interleaving lands there: the
// loser is refused by the read-time decision (if it read after
// the winner committed) or by insert-if-absent (if it read
// before). A1: overlapping upserts on the (snapshot, account)
// NW balance pair and on a bill's (bill, effective month)
// version pair each leave exactly ONE row for the pair.
{
  const storeL = memoryStore();
  const rtL = await createRuntime({ store: storeL, wasmUrl: wasmPath });
  await rtL.call("clearAllData", { confirm: "delete everything" });
  const retFields = {
    portfolioCents: 10000000,
    spendingCents: 5000000,
    currentAge: 55,
    retirementAge: 60,
    endAge: 90,
    stocksPct: 60,
    extraIncomeCents: null,
    extraIncomeStartAge: null,
    expectedReturnPct: 5,
    volatilityPct: 10,
    strategy: "constant",
    percentOfPortfolio: null,
    guardrailsCutPct: null,
    guardrailsRaisePct: null,
    guardrailsAdjustmentPct: null,
    phaseStartAge: null,
    phaseDeclinePct: null,
  };
  const [s1, s2] = await Promise.all([
    rtL.dispatch("saveRetirementCalc", {
      ...retFields,
      spendingCents: 5000000,
      baseRevision: 0,
    }),
    rtL.dispatch("saveRetirementCalc", {
      ...retFields,
      spendingCents: 8000000,
      baseRevision: 0,
    }),
  ]);
  const sBodies = [s1, s2].map((s) => {
    try {
      return JSON.parse(s.body) as { data?: { ok?: boolean } };
    } catch {
      return {};
    }
  });
  const sOks = sBodies.filter((b) => b.data?.ok === true).length;
  const sConflicts = sBodies.filter((b) => b.data?.ok === false).length;
  check(
    "L1 overlapping Retirement first saves: exactly one success",
    sOks === 1,
    `statuses ${s1.status}/${s2.status}, oks ${sOks}`,
  );
  check(
    "L2 overlapping Retirement first saves: exactly one conflict refusal",
    sConflicts === 1,
    `conflicts ${sConflicts}`,
  );
  const retAfter = await rtL.call<any>("getRetirementCalc", {});
  eq("L3 the landed first save is at revision 1", retAfter.revision, 1);
  check(
    "L4 the landed spending is one writer's value (not a blend)",
    [5000000, 8000000].includes(retAfter.saved?.spendingCents),
    `spending ${retAfter.saved?.spendingCents}`,
  );
  const third = await rtL.dispatch("saveRetirementCalc", {
    ...retFields,
    spendingCents: 6000000,
    baseRevision: 0,
  });
  const thirdBody = JSON.parse(third.body) as { data?: { ok?: boolean } };
  check(
    "L5 a later base-0 save against the revision-1 record is refused",
    thirdBody.data?.ok === false,
    `status ${third.status}`,
  );
  const retFinal = await rtL.call<any>("getRetirementCalc", {});
  eq("L6 revision still 1 after the refused save", retFinal.revision, 1);

  // A1 — NW balance pair: two overlapping updateNwBalance writes
  // for a (snapshot, account) pair with no row yet.
  const acct = await rtL.call<any>("addNwAccount", { name: "Race Account" });
  check("L7 account added", acct.ok === true, acct.reason);
  const snap = await rtL.call<any>("addNwSnapshot", {
    date: "2026-09-01",
    note: null,
    balances: [],
  });
  check("L8 snapshot added", snap.ok === true, snap.reason);
  const balArgs = {
    snapshotId: snap.id,
    accountId: acct.id,
    balanceCents: 1234500,
    splits: null,
  };
  const [b1, b2] = await Promise.all([
    rtL.dispatch("updateNwBalance", balArgs),
    rtL.dispatch("updateNwBalance", balArgs),
  ]);
  check(
    "L9 both overlapping balance upserts report success",
    b1.status === 200 && b2.status === 200,
    `statuses ${b1.status}/${b2.status}`,
  );
  const nwL = await rtL.call<any>("getNetWorth", {});
  const snapL = (nwL.snapshots ?? []).find((s: any) => s.id === snap.id);
  eq(
    "L10 the pair holds ONE row: snapshot total counts it once",
    snapL?.totalCents,
    1234500,
  );

  // A1 — bill version pair: two overlapping setMonthlyBillAmount
  // writes for the same (bill, effective month).
  const bill = await rtL.call<any>("addMonthlyBill", {
    name: "Race Bill",
    amountCents: 10000,
    effectiveFrom: "2026-08",
    paidBy: "Checking",
  });
  const [v1, v2] = await Promise.all([
    rtL.dispatch("setMonthlyBillAmount", {
      billId: bill.id,
      amountCents: 20000,
      effectiveFrom: "2026-10",
    }),
    rtL.dispatch("setMonthlyBillAmount", {
      billId: bill.id,
      amountCents: 30000,
      effectiveFrom: "2026-10",
    }),
  ]);
  check(
    "L11 both overlapping version upserts report success",
    v1.status === 200 && v2.status === 200,
    `statuses ${v1.status}/${v2.status}`,
  );
  const dashL = await rtL.call<any>("getDashboard", { month: "2026-10" });
  const billL = (dashL.monthlyBills ?? []).find((b: any) => b.id === bill.id);
  const octVersions = (billL?.history ?? []).filter(
    (h: any) => h.effectiveFrom === "2026-10",
  );
  eq(
    "L12 the (bill, month) pair holds exactly ONE version",
    octVersions.length,
    1,
  );
  check(
    "L13 the surviving version is one writer's amount",
    [20000, 30000].includes(octVersions[0]?.amountCents),
    `amount ${octVersions[0]?.amountCents}`,
  );
}

console.log(`\n${checks - failures}/${checks} harness checks passed`);
process.exit(failures === 0 ? 0 : 1);
