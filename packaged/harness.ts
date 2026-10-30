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
//   M. CAS sweep (contract v65, group B of the write-path audit):
//      every full-record editor family — transaction, cash-out
//      item, month summary, monthly bill + amount version, yearly
//      expense, reserve settings, NW snapshot + balance + account
//      rename, Roth scenario — refuses a stale-base save with the
//      stored newer value intact and accepts a fresh-base save;
//      plus the F21 remainder: after a saveRetirementBaseline
//      refusal, the fresh revisions the refusal carries complete
//      the baseline write on retry.
//   N. Result-honesty (contract v67, F04/F06/F07/F08/F09): a
//      PRESENT but unreadable record (planted by restoring a
//      MAC-stripped export whose settings value for the record's
//      key is replaced with unparseable text) surfaces its
//      getter's unreadable marker, every writer refuses against
//      it, and the stored bytes survive untouched — while an
//      absent record and a normal record behave exactly as
//      before.
//   O. Encrypted form-state blobs (contract v90, stored-data
//      findings F2/F3): the December and Roth/Playground blobs
//      store as ciphertext through the real writers, dual-read
//      legacy plaintext rows planted in settings, restore from
//      plaintext backups to encrypted stored values, restore a
//      ciphertext backup correctly, and keep the Roth UI-state
//      CAS guard working on ciphertext.
//   P. Field-bound ciphertext (contract v91, stored-data
//      finding F1): a ciphertext transplanted into another field
//      is refused on load (never a silently wrong figure); every
//      field family round-trips through its real write/read
//      actions; legacy no-AAD ciphertext dual-reads and is
//      re-encrypted bound by the loaders, while settings blobs
//      upgrade on save only; and a restore re-encrypts legacy
//      ciphertext or refuses a transplanted one with the prior
//      state untouched — all through the real actions on
//      throwaway stores with real encryption.
//   Q. Wipe purges retained generations (contract v92,
//      stored-data finding F4): a successful clearAllData
//      through the real packaged dispatch leaves no prior
//      generation readable (including the retained fallback),
//      while the store stays usable, the encryption key is
//      untouched (generations-only scope), a refused wipe
//      keeps the fallback, and an ordinary persist still
//      retains exactly its gen - 1 fallback.
//   R. Restore epoch (contract v93, stored-data finding F5): a
//      restore advances the epoch and every pre-restore snapshot
//      editor is refused afterwards — through the real actions on
//      a throwaway store with real encryption — while a fresh
//      editor and ordinary revision CAS behave as before, a
//      second restore invalidates again, and a carried stale
//      epoch value in an old backup is ignored.
//
// Run via packaged/run-harness.mjs (which bundles this file with the
// same resolver seams as the browser build).
import { createRuntime } from "./src/runtime";
import {
  memoryStore,
  ACTIVE_KEY,
  BACKUPS_KEY,
  ENC_KEY_KEY,
  GEN_CHUNK_KEY,
  META_KEY,
  RSA_PRIV_KEY,
  type KeyValueStore,
} from "./src/storage";
import { StoreRecoveryRequiredError } from "./src/localDb";
import initSqlJs from "sql.js";
import { MIGRATIONS } from "packaged-migrations";
import { bytesToHex, computeBackupMac, sha256Bytes } from "../server/src/backupMacCore";
// The single sources of truth the contract expectations derive
// from (round-7 fix H-1): the same Actions map and contract
// version constant describeApi publishes, read here directly
// instead of through the dispatcher — so a dispatcher or seam
// that dropped an action or mangled the version fails loudly
// against the source, and growing either never stales this file.
import { Actions, API_CONTRACT_VERSION } from "../server/src/actions";
import * as schema from "../server/src/schema";
import { eq as drizzleEq } from "drizzle-orm";

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
// image rewound to user_version N-3 (the last three migrations'
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
  // Rewind the last THREE migrations' effects: 0024's day column,
  // 0025's three composite unique indexes (contract v64), and
  // 0026's snapshot revision column (contract v65) — the image
  // claims MIGRATIONS.length - 3, so boot must re-run all three,
  // exactly as it re-ran the last two before v65 added 0026.
  rewound.exec("ALTER TABLE monthly_cash_out_items DROP COLUMN day");
  rewound.exec("DROP INDEX IF EXISTS nw_balances_snapshot_account_unique");
  rewound.exec("DROP INDEX IF EXISTS monthly_bill_versions_bill_effective_unique");
  rewound.exec("DROP INDEX IF EXISTS yearly_expense_versions_expense_effective_unique");
  rewound.exec("ALTER TABLE nw_snapshots DROP COLUMN revision");
  rewound.exec(`PRAGMA user_version = ${MIGRATIONS.length - 3}`);
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

// ---------- M. CAS sweep (contract v65) ----------
// Every family follows the same script on a fresh store: load a
// record, move it with a newer (base-less, legacy-tolerated)
// write, then prove (a) a stale-base save is refused with
// conflict: true and the stored newer value intact, and (b) a
// fresh-base save on the current value succeeds.
{
  const storeM = memoryStore();
  const rtM = await createRuntime({ store: storeM, wasmUrl: wasmPath });
  await rtM.call("clearAllData", { confirm: "delete everything" });
  const dash = (month: string) => rtM.call<any>("getDashboard", { month });

  // --- F13: transaction guarded update ---
  const txnAdd = await rtM.call<any>("addTransaction", {
    date: "2026-10-05",
    description: "CAS Groceries",
    amountCents: 10000,
    sourceType: "checking",
    accountName: "Checking",
    kind: "spending",
    category: "Other",
    yearlyExpenseId: null,
    fitId: null,
  });
  check("M1 transaction added", typeof txnAdd.id === "number", JSON.stringify(txnAdd));
  const txnOf = async () =>
    (await dash("2026-10")).monthTransactions.find((t: any) => t.id === txnAdd.id);
  const t0 = await txnOf();
  const txnBase = {
    date: t0.date,
    description: t0.description,
    amountCents: t0.amountCents,
    sourceType: t0.sourceType,
    accountName: t0.accountName,
    kind: t0.kind,
    category: t0.category,
    yearlyExpenseId: t0.yearlyExpenseId ?? null,
  };
  const txnNewer = await rtM.call<any>("updateTransaction", {
    id: txnAdd.id, ...txnBase, amountCents: 20000, fitId: null,
  });
  eq("M2 newer base-less transaction write lands", txnNewer.ok, true);
  const txnStale = await rtM.call<any>("updateTransaction", {
    id: txnAdd.id, ...txnBase, amountCents: 15000, fitId: null, base: txnBase,
  });
  eq("M3 stale transaction save refused as conflict", [txnStale.ok, txnStale.conflict], [false, true]);
  eq("M4 stored transaction keeps the newer value", (await txnOf())?.amountCents, 20000);
  const txnBase2 = { ...txnBase, amountCents: 20000 };
  const txnFresh = await rtM.call<any>("updateTransaction", {
    id: txnAdd.id, ...txnBase2, amountCents: 25000, fitId: null, base: txnBase2,
  });
  eq("M5 fresh-base transaction save succeeds", txnFresh.ok, true);
  eq("M6 fresh value stored", (await txnOf())?.amountCents, 25000);

  // --- F14: cash-out item guarded update ---
  const itemAdd = await rtM.call<any>("addCashOutItem", {
    month: "2026-10", day: 3, description: "CAS Item", amountCents: 7500, note: null,
  });
  const itemOf = async () =>
    (await dash("2026-10")).cashOutItems.find((i: any) => i.id === itemAdd.id);
  const i0 = await itemOf();
  const itemBase = {
    month: i0.month, description: i0.description, amountCents: i0.amountCents,
    note: i0.note ?? null, day: i0.day,
  };
  await rtM.call("updateCashOutItem", { id: itemAdd.id, ...itemBase, amountCents: 10000 });
  const itemStale = await rtM.call<any>("updateCashOutItem", {
    id: itemAdd.id, ...itemBase, amountCents: 8000, base: itemBase,
  });
  eq("M7 stale cash-out item save refused as conflict", [itemStale.ok, itemStale.conflict], [false, true]);
  eq("M8 stored item keeps the newer value", (await itemOf())?.amountCents, 10000);
  const itemBase2 = { ...itemBase, amountCents: 10000 };
  const itemFresh = await rtM.call<any>("updateCashOutItem", {
    id: itemAdd.id, ...itemBase2, amountCents: 11000, base: itemBase2,
  });
  eq("M9 fresh-base item save succeeds", itemFresh.ok, true);

  // --- F15: monthly summary base ---
  const sumNew = await rtM.call<any>("upsertMonthlySummary", {
    month: "2026-11", cashOutCents: 30000, base: { cashOutCents: null },
  });
  eq("M10 summary save on a null base (no stored total) succeeds", sumNew.ok, true);
  const sumFresh = await rtM.call<any>("upsertMonthlySummary", {
    month: "2026-11", cashOutCents: 50000, base: { cashOutCents: 30000 },
  });
  eq("M11 fresh-base summary save succeeds", sumFresh.ok, true);
  const sumStale = await rtM.call<any>("upsertMonthlySummary", {
    month: "2026-11", cashOutCents: 45000, base: { cashOutCents: 30000 },
  });
  eq("M12 stale summary save refused as conflict", [sumStale.ok, sumStale.conflict], [false, true]);
  const sumStored = (await dash("2026-11")).summaries.find((s: any) => s.month === "2026-11");
  eq("M13 stored month total keeps the newer value", sumStored?.cashOutCents, 50000);

  // --- F18 + F16: monthly bill fields and amount version ---
  const billAdd = await rtM.call<any>("addMonthlyBill", {
    name: "CAS Bill", amountCents: 10000, effectiveFrom: "2026-10", paidBy: "Checking",
  });
  const billOf = async () =>
    (await dash("2026-10")).monthlyBills.find((b: any) => b.id === billAdd.id);
  const b0 = await billOf();
  const billBase = {
    name: b0.name, paidBy: b0.paidBy, notes: b0.notes ?? null,
    category: b0.category, keepLightsOn: b0.keepLightsOn,
  };
  await rtM.call("updateMonthlyBill", { id: billAdd.id, ...billBase, keepLightsOn: true });
  const billStale = await rtM.call<any>("updateMonthlyBill", {
    id: billAdd.id, ...billBase, name: "CAS Bill Renamed", base: billBase,
  });
  eq("M14 stale bill save refused as conflict", [billStale.ok, billStale.conflict], [false, true]);
  const bAfter = await billOf();
  eq("M15 stored bill keeps the newer fields", [bAfter?.name, bAfter?.keepLightsOn], ["CAS Bill", true]);
  const billBase2 = { ...billBase, keepLightsOn: true };
  const billFresh = await rtM.call<any>("updateMonthlyBill", {
    id: billAdd.id, ...billBase2, name: "CAS Bill Renamed", base: billBase2,
  });
  eq("M16 fresh-base bill save succeeds", billFresh.ok, true);
  const amtFresh = await rtM.call<any>("setMonthlyBillAmount", {
    billId: billAdd.id, amountCents: 20000, effectiveFrom: "2026-10",
    base: { amountCents: 10000 },
  });
  eq("M17 fresh-base amount save succeeds", amtFresh.ok, true);
  const amtStale = await rtM.call<any>("setMonthlyBillAmount", {
    billId: billAdd.id, amountCents: 15000, effectiveFrom: "2026-10",
    base: { amountCents: 10000 },
  });
  eq("M18 stale amount save refused as conflict", [amtStale.ok, amtStale.conflict], [false, true]);
  const octVersion = (await billOf())?.history.find((h: any) => h.effectiveFrom === "2026-10");
  eq("M19 stored version keeps the newer amount", octVersion?.amountCents, 20000);

  // --- F17: yearly expense parent + version ---
  const yrAdd = await rtM.call<any>("addYearlyExpense", {
    name: "CAS Insurance", frequency: "yearly", expectedCents: 120000,
    dueMonth: 6, paidByType: "checking", paidByName: "Checking",
    category: "Insurance", keepLightsOn: true, effectiveFrom: "2026-01",
  });
  check("M20 yearly expense added", typeof yrAdd.id === "number", JSON.stringify(yrAdd));
  const yrOf = async () =>
    (await dash("2026-10")).yearly.find((y: any) => y.id === yrAdd.id);
  const yrBase = {
    name: "CAS Insurance", dueMonth: 6, paidByType: "checking",
    paidByName: "Checking", category: "Insurance", keepLightsOn: true,
    version: { expectedCents: 120000, frequency: "yearly" },
  };
  const yrNewer = await rtM.call<any>("updateYearlyExpense", {
    id: yrAdd.id, name: "CAS Insurance", frequency: "yearly",
    expectedCents: 240000, dueMonth: 6, paidByType: "checking",
    paidByName: "Checking", category: "Insurance", keepLightsOn: true,
    effectiveFrom: "2026-01",
  });
  eq("M21 newer base-less yearly write lands", yrNewer.ok, true);
  const yrStale = await rtM.call<any>("updateYearlyExpense", {
    id: yrAdd.id, name: "CAS Insurance", frequency: "yearly",
    expectedCents: 240000, dueMonth: 6, paidByType: "checking",
    paidByName: "Checking", category: "Insurance", keepLightsOn: true,
    effectiveFrom: "2026-01", base: yrBase,
  });
  eq("M22 stale yearly save refused (same-month version moved)", [yrStale.ok, yrStale.conflict], [false, true]);
  eq("M23 stored version keeps the newer amount", (await yrOf())?.latestExpectedCents, 240000);
  const yrBase2 = { ...yrBase, version: { expectedCents: 240000, frequency: "yearly" as const } };
  const yrFresh = await rtM.call<any>("updateYearlyExpense", {
    id: yrAdd.id, name: "CAS Insurance", frequency: "yearly",
    expectedCents: 240000, dueMonth: 6, paidByType: "checking",
    paidByName: "Checking", category: "Taxes", keepLightsOn: true,
    effectiveFrom: "2026-01", base: yrBase2,
  });
  eq("M24 fresh-base yearly save succeeds", yrFresh.ok, true);
  eq("M25 fresh category stored", (await yrOf())?.category, "Taxes");

  // --- F26: reserve settings pair ---
  await rtM.call("updateSettings", { openingReserveCents: 100000, reserveStartMonth: "2026-01" });
  const setStale = await rtM.call<any>("updateSettings", {
    openingReserveCents: 150000, reserveStartMonth: "2026-01",
    base: { openingReserveCents: 50000, reserveStartMonth: null },
  });
  eq("M26 stale settings save refused as conflict", [setStale.ok, setStale.conflict], [false, true]);
  eq("M27 stored opening reserve intact", (await dash("2026-10")).openingReserveCents, 100000);
  const setFresh = await rtM.call<any>("updateSettings", {
    openingReserveCents: 200000, reserveStartMonth: "2026-01",
    base: { openingReserveCents: 100000, reserveStartMonth: "2026-01" },
  });
  eq("M28 fresh-base settings save succeeds", setFresh.ok, true);
  eq("M29 fresh reserve stored", (await dash("2026-10")).openingReserveCents, 200000);

  // --- F11 + F12: NW snapshot revision counter ---
  const acctM = await rtM.call<any>("addNwAccount", { name: "CAS Bank" });
  const snapM = await rtM.call<any>("addNwSnapshot", {
    date: "2026-10-01", note: null,
    balances: [{ accountId: acctM.id, balanceCents: 10000000, splits: null }],
  });
  check("M30 snapshot added", snapM.ok === true, snapM.reason);
  const nwOf = async () =>
    (await rtM.call<any>("getNetWorth", {})).snapshots.find((s: any) => s.id === snapM.id);
  const rev0 = (await nwOf())?.revision;
  eq("M31 a new snapshot starts at revision 0", rev0, 0);
  const balSave = await rtM.call<any>("updateNwBalance", {
    snapshotId: snapM.id, accountId: acctM.id, balanceCents: 15000000,
    splits: null, baseRevision: rev0,
  });
  eq("M32 balance save at the loaded revision succeeds and bumps it", [balSave.ok, balSave.revision], [true, 1]);
  const snapStale = await rtM.call<any>("updateNwSnapshot", {
    id: snapM.id, date: "2026-10-01", note: "stale edit",
    balances: [{ accountId: acctM.id, balanceCents: 10000000, splits: null }],
    baseRevision: rev0,
  });
  eq("M33 stale whole-snapshot save refused as conflict", [snapStale.ok, snapStale.conflict], [false, true]);
  const nwAfterStale = await nwOf();
  eq("M34 stored snapshot keeps the corrected balance and revision", [nwAfterStale?.totalCents, nwAfterStale?.revision], [15000000, 1]);
  const balStale = await rtM.call<any>("updateNwBalance", {
    snapshotId: snapM.id, accountId: acctM.id, balanceCents: 10000000,
    splits: null, baseRevision: rev0,
  });
  eq("M35 stale balance save refused as conflict", [balStale.ok, balStale.conflict], [false, true]);
  const snapFresh = await rtM.call<any>("updateNwSnapshot", {
    id: snapM.id, date: "2026-10-01", note: "fresh edit",
    balances: [{ accountId: acctM.id, balanceCents: 15000000, splits: null }],
    baseRevision: 1,
  });
  eq("M36 fresh whole-snapshot save succeeds and bumps the revision", [snapFresh.ok, snapFresh.revision], [true, 2]);

  // --- F19: account rename guard ---
  await rtM.call("renameNwAccount", { id: acctM.id, name: "CAS Bank 2" });
  const acctBaseStale = { name: "CAS Bank", propertyKind: "none" as const, custodial: false };
  const renStale = await rtM.call<any>("renameNwAccount", {
    id: acctM.id, name: "CAS Bank Stale", propertyKind: "none", custodial: false,
    base: acctBaseStale,
  });
  eq("M37 stale rename refused as conflict", [renStale.ok, renStale.conflict], [false, true]);
  const acctOf = async () =>
    (await rtM.call<any>("getNetWorth", {})).accounts.find((a: any) => a.id === acctM.id);
  eq("M38 stored account keeps the newer name", (await acctOf())?.name, "CAS Bank 2");
  const renFresh = await rtM.call<any>("renameNwAccount", {
    id: acctM.id, name: "CAS Bank 3", propertyKind: "none", custodial: false,
    base: { name: "CAS Bank 2", propertyKind: "none", custodial: false },
  });
  eq("M39 fresh-base rename succeeds", renFresh.ok, true);

  // --- F22: Roth scenario-level CAS ---
  await rtM.call("resetRothPlanner", {});
  const planner0 = await rtM.call<any>("getRothPlanner", {});
  check("M40 planner defaults present after reset", planner0.saved != null);
  const scSave = await rtM.call<any>("saveRothScenario", { ...planner0.saved });
  eq("M41 scenario saved", scSave.ok, true);
  const scName = scSave.scenarios[0]?.name;
  const planner1 = await rtM.call<any>("getRothPlanner", {});
  const sc0 = planner1.scenarios.find((s: any) => s.name === scName);
  const { name: _scName, ...scBase } = sc0;
  const scNewer = await rtM.call<any>("updateRothScenario", {
    name: scName, ...scBase, annualSpendingCents: 9000000,
  });
  eq("M42 newer base-less scenario write lands", scNewer.ok, true);
  const scStale = await rtM.call<any>("updateRothScenario", {
    name: scName, ...scBase, annualSpendingCents: 8000000, baseScenario: scBase,
  });
  eq("M43 stale scenario save refused as conflict", [scStale.ok, scStale.conflict], [false, true]);
  const planner2 = await rtM.call<any>("getRothPlanner", {});
  eq(
    "M44 stored scenario keeps the newer payload",
    planner2.scenarios.find((s: any) => s.name === scName)?.annualSpendingCents,
    9000000,
  );
  const scBase2 = { ...scBase, annualSpendingCents: 9000000 };
  const scFresh = await rtM.call<any>("updateRothScenario", {
    name: scName, ...scBase2, annualSpendingCents: 9500000, baseScenario: scBase2,
  });
  eq("M45 fresh-base scenario save succeeds", scFresh.ok, true);
  // A write to a DIFFERENT scenario moves the blob but must not
  // refuse a save whose own scenario base is still current.
  const scSave2 = await rtM.call<any>("saveRothScenario", { ...planner0.saved });
  eq("M46 second scenario saved", scSave2.ok, true);
  const scBase3 = { ...scBase2, annualSpendingCents: 9500000 };
  const scUnrelated = await rtM.call<any>("updateRothScenario", {
    name: scName, ...scBase3, annualSpendingCents: 9600000, baseScenario: scBase3,
  });
  eq("M47 save succeeds after an unrelated scenario write moved the blob", scUnrelated.ok, true);

  // --- F21 remainder: baseline retry after a refusal ---
  // Verdict evidence: a saveRetirementBaseline refused for stale
  // bases carries the lite record with BOTH fresh revisions, and
  // a retry using ONLY those carried revisions completes the
  // baseline write — no code change was needed. (A stage-
  // "baseline" conflict itself needs two writers racing between
  // the pair's two commits and cannot be forced sequentially
  // through the public actions; the retry path it depends on is
  // the one exercised here.)
  const retFields = {
    portfolioCents: 10000000, spendingCents: 8000000, currentAge: 55,
    retirementAge: 60, endAge: 90, stocksPct: 60, extraIncomeCents: null,
    extraIncomeStartAge: null, expectedReturnPct: 5, volatilityPct: 10,
    strategy: "constant", percentOfPortfolio: null, guardrailsCutPct: null,
    guardrailsRaisePct: null, guardrailsAdjustmentPct: null,
    phaseStartAge: null, phaseDeclinePct: null,
  };
  const retSave = await rtM.call<any>("saveRetirementCalc", {
    ...retFields, baseRevision: 0,
  });
  eq("M48 retirement inputs saved at revision 1", [retSave.ok, retSave.revision], [true, 1]);
  const baseSave = await rtM.call<any>("saveRetirementBaseline", {
    ...retFields, spendingCents: 10000000, baseRevision: 1, baseBaselineRevision: 0,
  });
  eq("M49 baseline pair save completes", [baseSave.ok, baseSave.baselineKind, baseSave.baseline?.spendingCents], [true, "saved", 10000000]);
  const retSave2 = await rtM.call<any>("saveRetirementCalc", {
    ...retFields, spendingCents: 11000000, baseRevision: 2,
  });
  eq("M50 working inputs advance to revision 3 (baseline now behind)", [retSave2.ok, retSave2.revision], [true, 3]);
  const retryStale = await rtM.call<any>("saveRetirementBaseline", {
    ...retFields, spendingCents: 11000000, baseRevision: 1, baseBaselineRevision: 0,
  });
  eq("M51 retry with the original bases is refused", retryStale.ok, false);
  eq(
    "M52 the refusal carries both fresh revisions",
    [retryStale.record?.revision, retryStale.record?.baselineRevision],
    [3, 1],
  );
  const retryFresh = await rtM.call<any>("saveRetirementBaseline", {
    ...retFields, spendingCents: 11000000,
    baseRevision: retryStale.record.revision,
    baseBaselineRevision: retryStale.record.baselineRevision,
  });
  eq("M53 retry on the carried revisions completes the pair", [retryFresh.ok, retryFresh.baselineKind, retryFresh.baseline?.spendingCents], [true, "saved", 11000000]);
  const retFinal = await rtM.call<any>("getRetirementCalc", {});
  eq(
    "M54 baseline now equals the working inputs",
    [retFinal.baseline?.spendingCents, retFinal.saved?.spendingCents],
    [11000000, 11000000],
  );
}

// ---------- N. Result-honesty: unreadable present records (contract v67) ----------
// Corruption is planted honestly: export the store, strip the
// MAC (the pre-MAC restore shape section D already exercises),
// replace ONE settings value with unparseable text, and restore.
// The restore stores that value verbatim (opaque settings blobs
// ride unvalidated), so the record on disk is exactly the
// damaged bytes a real corruption would leave — and a later
// export reads them back for the byte-intact checks.
{
  const storeN = memoryStore();
  const rtN = await createRuntime({ store: storeN, wasmUrl: wasmPath });
  await rtN.call("clearAllData", { confirm: "delete everything" });

  // Absent records: no markers, null reads — unchanged behaviour.
  const absentRet = await rtN.call<any>("getRetirementCalc", {});
  eq("N1 absent Retirement record carries no unreadable markers",
    [absentRet.saved, absentRet.savedUnreadable, absentRet.baselineUnreadable],
    [null, false, false]);
  const absentRoth = await rtN.call<any>("getRothPlanner", {});
  eq("N2 absent Roth record carries no unreadable marker",
    [absentRoth.saved, absentRoth.recordUnreadable], [null, false]);
  const absentDec = await rtN.call<any>("getDecemberProjection", {});
  eq("N3 absent December record is unstored and readable-shaped",
    [absentDec.hasStored, absentDec.storedUnreadable], [false, false]);
  const absentBase = await rtN.call<any>("getRetirementBaselineResults", {
    mcSeed: 1, solverEngine: "historical", solverTarget: 95,
  });
  eq("N4 absent baseline is not unreadable", absentBase.baselineUnreadable, false);

  // Normal records: written through the real writers, read back
  // with no markers — the baseline the corruption legs compare to.
  const retFieldsN = {
    portfolioCents: 10000000, spendingCents: 8000000, currentAge: 55,
    retirementAge: 60, endAge: 90, stocksPct: 60, extraIncomeCents: null,
    extraIncomeStartAge: null, expectedReturnPct: 5, volatilityPct: 10,
    strategy: "constant", percentOfPortfolio: null, guardrailsCutPct: null,
    guardrailsRaisePct: null, guardrailsAdjustmentPct: null,
    phaseStartAge: null, phaseDeclinePct: null,
  };
  const retSaveN = await rtN.call<any>("saveRetirementCalc", { ...retFieldsN, baseRevision: 0 });
  eq("N5 normal Retirement save ok", retSaveN.ok, true);
  const baseSaveN = await rtN.call<any>("saveRetirementBaseline", {
    ...retFieldsN, baseRevision: 1, baseBaselineRevision: 0,
  });
  eq("N6 normal baseline save ok", baseSaveN.ok, true);
  const resetN = await rtN.call<any>("resetRothPlanner", {});
  eq("N7 normal Roth record materialized by reset", resetN.ok, true);
  const decSaveN = await rtN.call<any>("saveDecemberProjection", {
    state: absentDec.state, baseRevision: 0,
  });
  eq("N8 normal December save ok", decSaveN.ok, true);
  const normalRet = await rtN.call<any>("getRetirementCalc", {});
  eq("N9 normal records read with no markers",
    [normalRet.saved?.spendingCents, normalRet.savedUnreadable, normalRet.baselineUnreadable],
    [8000000, false, false]);

  const CORRUPT = "corrupt{{{not-json";
  const cleanPayload = await rtN.call<any>("exportbackup", {});
  const corruptedPayload = (key: string) => {
    const pl = JSON.parse(JSON.stringify(cleanPayload));
    delete pl.authenticityMac;
    pl.settings = pl.settings.map((s: any) =>
      s.key === key ? { ...s, value: CORRUPT } : s,
    );
    return pl;
  };
  const storedValue = async (key: string) => {
    const pl = await rtN.call<any>("exportbackup", {});
    return pl.settings.find((s: any) => s.key === key)?.value;
  };

  // F06: unreadable Retirement inputs record.
  const resRet = await rtN.call<any>("restorebackup", corruptedPayload("retirement_calc_inputs_v1"));
  eq("N10 corrupt Retirement restore accepted (pre-MAC shape)", resRet.ok, true);
  const corRet = await rtN.call<any>("getRetirementCalc", {});
  eq("N11 unreadable Retirement record is marked, not fresh",
    [corRet.saved, corRet.savedUnreadable], [null, true]);
  const corRetSave = await rtN.call<any>("saveRetirementCalc", { ...retFieldsN, baseRevision: 0 });
  eq("N12 save against the unreadable record is refused",
    [corRetSave.ok, corRetSave.conflict], [false, true]);
  eq("N13 stored Retirement bytes intact after the refused save",
    await storedValue("retirement_calc_inputs_v1"), CORRUPT);

  // F07: unreadable baseline record (inputs record valid again).
  const resBase = await rtN.call<any>("restorebackup", corruptedPayload("retirement_calc_baseline_v1"));
  eq("N14 corrupt baseline restore accepted", resBase.ok, true);
  const corBase = await rtN.call<any>("getRetirementCalc", {});
  eq("N15 unreadable baseline is marked, not missing",
    [corBase.baseline, corBase.baselineUnreadable, corBase.savedUnreadable],
    [null, true, false]);
  const corBaseResults = await rtN.call<any>("getRetirementBaselineResults", {
    mcSeed: 1, solverEngine: "historical", solverTarget: 95,
  });
  eq("N16 baseline results carry the unreadable marker",
    [corBaseResults.baselineKind, corBaseResults.baselineUnreadable], [null, true]);
  const corBaseSave = await rtN.call<any>("saveRetirementBaseline", {
    ...retFieldsN,
    baseRevision: corBase.revision,
    baseBaselineRevision: corBase.baselineRevision,
  });
  eq("N17 baseline save against the unreadable record is refused", corBaseSave.ok, false);
  eq("N18 stored baseline bytes intact after the refused save",
    await storedValue("retirement_calc_baseline_v1"), CORRUPT);

  // F08: unreadable Roth plan record — the strict writer's
  // existing refusal engages on the reader's honest state.
  const resRoth = await rtN.call<any>("restorebackup", corruptedPayload("roth_conversion_inputs_v1"));
  eq("N19 corrupt Roth restore accepted", resRoth.ok, true);
  const corRoth = await rtN.call<any>("getRothPlanner", {});
  eq("N20 unreadable Roth record is marked, not fresh",
    [corRoth.saved, corRoth.recordUnreadable], [null, true]);
  const goodRoth = JSON.parse(JSON.stringify(cleanPayload));
  const goodPlannerState = goodRoth.settings.find((s: any) => s.key === "roth_conversion_inputs_v1");
  check("N21 clean payload carries a Roth record to rebuild save args from", !!goodPlannerState);
  const corRothSave = await rtN.call<any>("saveRothInputs", {
    ...JSON.parse(goodPlannerState.value).inputs,
    baseRevision: 0,
  });
  eq("N22 saveRothInputs against the unreadable record is refused",
    [corRothSave.ok, corRothSave.conflict], [false, true]);
  const corRothReset = await rtN.call<any>("resetRothPlanner", {});
  eq("N23 reset against the unreadable record is refused", corRothReset.ok, false);
  eq("N24 stored Roth bytes intact after the refused saves",
    await storedValue("roth_conversion_inputs_v1"), CORRUPT);

  // F09: unparseable December record.
  const resDec = await rtN.call<any>("restorebackup", corruptedPayload("december_projection_v1"));
  eq("N25 corrupt December restore accepted", resDec.ok, true);
  const corDec = await rtN.call<any>("getDecemberProjection", {});
  eq("N26 unparseable December record is flagged beside hasStored",
    [corDec.hasStored, corDec.storedUnreadable], [true, true]);
  const corDecSave = await rtN.call<any>("saveDecemberProjection", {
    state: corDec.state, baseRevision: corDec.revision,
  });
  eq("N27 December save on an unparseable base is refused as a conflict",
    [corDecSave.ok, corDecSave.conflict, corDecSave.storedUnreadable], [false, true, true]);
  eq("N28 stored December bytes intact after the refused save",
    await storedValue("december_projection_v1"), CORRUPT);

  // F04: the one-off editor's server shape — a missing id is a
  // data refusal ({ ok: false, reason }), the exact result the
  // client guard now keys on; a real id updates fine.
  const oneOffAdd = await rtN.call<any>("addMonthlyOneOff", {
    month: "2026-10", description: "Honesty check", amountCents: 12345, note: null,
  });
  const oneOffMissing = await rtN.call<any>("updateMonthlyOneOff", {
    id: 999999, month: "2026-10", description: "Honesty check", amountCents: 12345, note: null,
  });
  eq("N29 updateMonthlyOneOff on a missing id refuses with a reason",
    [oneOffMissing.ok, oneOffMissing.reason],
    [false, "That one-off expense was not found."]);
  const oneOffOk = await rtN.call<any>("updateMonthlyOneOff", {
    id: oneOffAdd.id, month: "2026-10", description: "Honesty check edited", amountCents: 23456, note: null,
  });
  eq("N30 updateMonthlyOneOff on a real id succeeds", oneOffOk.ok, true);

  // Clean restore: the normal records read and price again.
  const cleanStripped = JSON.parse(JSON.stringify(cleanPayload));
  delete cleanStripped.authenticityMac;
  const resClean = await rtN.call<any>("restorebackup", cleanStripped);
  eq("N31 clean restore ok", resClean.ok, true);
  const backRet = await rtN.call<any>("getRetirementCalc", {});
  eq("N32 restored Retirement record reads normally",
    [backRet.saved?.spendingCents, backRet.savedUnreadable, backRet.baselineUnreadable],
    [8000000, false, false]);
  const backRoth = await rtN.call<any>("getRothPlanner", {});
  eq("N33 restored Roth record reads normally",
    [backRoth.saved != null, backRoth.recordUnreadable], [true, false]);
  const backDec = await rtN.call<any>("getDecemberProjection", {});
  eq("N34 restored December record reads normally",
    [backDec.hasStored, backDec.storedUnreadable], [true, false]);
}

// ---------- O. Encrypted form-state blobs (contract v90, F2/F3) ----------
// Real writers on a throwaway store, with the raw stored
// settings value read through the runtime's local DB — the
// only view that can see whether the value at rest is
// ciphertext (exportbackup decrypts, so it cannot tell).
{
  const storeO = memoryStore();
  const rtO = await createRuntime({ store: storeO, wasmUrl: wasmPath });
  const dbO = rtO.localDb.db;
  const rawStored = async (k: string): Promise<string | undefined> => {
    // Client-side find, NOT a drizzle where(eq(...)): this file's
    // local eq() assertion helper shadows drizzle-orm's eq, so a
    // where(eq(...)) here silently calls the assertion (printing
    // a spurious FAIL and returning undefined, i.e. no filter)
    // and rows[0] is whatever row happens to be first — the
    // section-O ciphertext assertions would then pass vacuously
    // against the wrong row's bytes. Selecting all rows and
    // finding by key reads the row this key actually holds.
    const rows = await dbO.select().from(schema.settings);
    return rows.find((r) => r.key === k)?.value;
  };
  const plantPlaintext = async (k: string, value: string): Promise<void> => {
    await dbO
      .insert(schema.settings)
      .values({ key: k, value })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value } });
  };

  // O-A: December save stores ciphertext; read-back identical.
  const decFresh = await rtO.call<any>("getDecemberProjection", {});
  const decState = {
    ...decFresh.state,
    ytdInterest: 12500,
    pretaxBalancePrimary: 1800000,
    pretaxBalance: 1800000,
  };
  const decSave = await rtO.call<any>("saveDecemberProjection", {
    state: decState,
    baseRevision: 0,
  });
  eq("O1 December save ok at revision 1", [decSave.ok, decSave.revision], [true, 1]);
  const decRaw = await rawStored("december_projection_v1");
  check("O2 December stored value is ciphertext", decRaw?.startsWith("enc:v1:") === true);
  check(
    "O3 December stored value holds no plaintext figures",
    decRaw !== undefined &&
      !decRaw.includes('"ytdInterest":12500') &&
      !decRaw.includes('"pretaxBalancePrimary":1800000'),
  );
  const decBack = await rtO.call<any>("getDecemberProjection", {});
  eq(
    "O4 December read-back identical",
    [decBack.revision, decBack.state.ytdInterest, decBack.state.pretaxBalancePrimary],
    [1, 12500, 1800000],
  );

  // O-B: Roth/Playground UI-state save stores ciphertext; read-back identical.
  const uiFresh = await rtO.call<any>("getRothUiState", {});
  const uiSave = await rtO.call<any>("setRothUiState", {
    labDials: {
      ...uiFresh.labDials,
      spendingCents: 25000000,
      pretaxCents: 180000000,
      taxableCents: 90000000,
      rothCents: 120000000,
    },
    playground: { ...uiFresh.playground, interest: "45000" },
    baseRevision: 0,
  });
  eq("O5 Roth UI-state save ok at revision 1", [uiSave.ok, uiSave.revision], [true, 1]);
  const uiRaw = await rawStored("roth_ui_state_v1");
  check("O6 Roth UI-state stored value is ciphertext", uiRaw?.startsWith("enc:v1:") === true);
  check(
    "O7 Roth UI-state stored value holds no plaintext figures",
    uiRaw !== undefined &&
      !uiRaw.includes('"interest":"45000"') &&
      !uiRaw.includes('"spendingCents":25000000'),
  );
  const uiBack = await rtO.call<any>("getRothUiState", {});
  eq(
    "O8 Roth UI-state read-back identical",
    [
      uiBack.revision,
      uiBack.labDials.spendingCents,
      uiBack.labDials.pretaxCents,
      uiBack.playground.interest,
    ],
    [1, 25000000, 180000000, "45000"],
  );

  // O-CAS: the guarded commit still refuses a stale base
  // against ciphertext, and accepts a fresh base.
  const uiStale = await rtO.call<any>("setRothUiState", {
    labDialsOpen: true,
    baseRevision: 0,
  });
  eq("O9 stale Roth UI-state save conflicts", [uiStale.ok, uiStale.conflict], [false, true]);
  eq("O10 stored Roth UI-state bytes intact after stale save", await rawStored("roth_ui_state_v1"), uiRaw);
  const uiFreshSave = await rtO.call<any>("setRothUiState", {
    labDialsOpen: true,
    baseRevision: 1,
  });
  eq("O11 fresh-base Roth UI-state save ok at revision 2", [uiFreshSave.ok, uiFreshSave.revision], [true, 2]);

  // O-C: legacy plaintext rows planted directly in settings
  // dual-read correctly, with zero user action.
  const legacyDec = JSON.stringify({
    ...decFresh.state,
    ytdInterest: 7777,
    pretaxBalancePrimary: 424242,
    pretaxBalance: 424242,
    decemberStateFormat: 3,
    revision: 5,
  });
  await plantPlaintext("december_projection_v1", legacyDec);
  const decLegacy = await rtO.call<any>("getDecemberProjection", {});
  eq(
    "O12 legacy plaintext December row reads correctly",
    [decLegacy.revision, decLegacy.state.ytdInterest, decLegacy.state.pretaxBalancePrimary],
    [5, 7777, 424242],
  );
  const legacyUi = JSON.stringify({
    ...uiBack,
    labDials: { ...uiBack.labDials, spendingCents: 424242 },
    revision: 3,
  });
  await plantPlaintext("roth_ui_state_v1", legacyUi);
  const uiLegacy = await rtO.call<any>("getRothUiState", {});
  eq(
    "O13 legacy plaintext Roth UI-state row reads correctly",
    [uiLegacy.revision, uiLegacy.labDials.spendingCents],
    [3, 424242],
  );

  // O-D: a backup carrying PLAINTEXT values for both keys
  // restores to ENCRYPTED stored values that read back.
  const payloadO = await rtO.call<any>("exportbackup", {});
  const plainPayload = JSON.parse(JSON.stringify(payloadO));
  delete plainPayload.authenticityMac;
  plainPayload.settings = plainPayload.settings.map((s: any) =>
    s.key === "december_projection_v1"
      ? { ...s, value: legacyDec }
      : s.key === "roth_ui_state_v1"
        ? { ...s, value: legacyUi }
        : s,
  );
  const resPlain = await rtO.call<any>("restorebackup", plainPayload);
  eq("O14 plaintext backup restores ok", resPlain.ok, true);
  const decRawAfter = await rawStored("december_projection_v1");
  const uiRawAfter = await rawStored("roth_ui_state_v1");
  check(
    "O15 restored December value is encrypted at rest",
    decRawAfter?.startsWith("enc:v1:") === true,
  );
  check(
    "O16 restored Roth UI-state value is encrypted at rest",
    uiRawAfter?.startsWith("enc:v1:") === true,
  );
  const decRestored = await rtO.call<any>("getDecemberProjection", {});
  eq(
    "O17 restored December state reads back",
    [decRestored.revision, decRestored.state.ytdInterest, decRestored.state.pretaxBalancePrimary],
    [5, 7777, 424242],
  );
  const uiRestored = await rtO.call<any>("getRothUiState", {});
  eq(
    "O18 restored Roth UI-state reads back",
    [uiRestored.revision, uiRestored.labDials.spendingCents],
    [3, 424242],
  );

  // O-D2: a backup carrying CIPHERTEXT values (same key)
  // restores correctly and reads back.
  const cipherPayload = JSON.parse(JSON.stringify(payloadO));
  delete cipherPayload.authenticityMac;
  cipherPayload.settings = cipherPayload.settings.map((s: any) =>
    s.key === "december_projection_v1"
      ? { ...s, value: decRawAfter }
      : s.key === "roth_ui_state_v1"
        ? { ...s, value: uiRawAfter }
        : s,
  );
  const resCipher = await rtO.call<any>("restorebackup", cipherPayload);
  eq("O19 ciphertext backup restores ok", resCipher.ok, true);
  const decCipherBack = await rtO.call<any>("getDecemberProjection", {});
  eq(
    "O20 ciphertext backup December reads back",
    [decCipherBack.state.ytdInterest, decCipherBack.state.pretaxBalancePrimary],
    [7777, 424242],
  );
  const uiCipherBack = await rtO.call<any>("getRothUiState", {});
  eq("O21 ciphertext backup Roth UI-state reads back", uiCipherBack.labDials.spendingCents, 424242);

  // O-E: export carries both blobs decrypted (the cross-key
  // portability shape the v60 sticky-defaults fix established).
  const exportO = await rtO.call<any>("exportbackup", {});
  const decExported = exportO.settings.find((s: any) => s.key === "december_projection_v1")?.value;
  const uiExported = exportO.settings.find((s: any) => s.key === "roth_ui_state_v1")?.value;
  check(
    "O22 exported December value is decrypted JSON",
    typeof decExported === "string" &&
      !decExported.startsWith("enc:v1:") &&
      JSON.parse(decExported).ytdInterest === 7777,
  );
  check(
    "O23 exported Roth UI-state value is decrypted JSON",
    typeof uiExported === "string" &&
      !uiExported.startsWith("enc:v1:") &&
      JSON.parse(uiExported).labDials.spendingCents === 424242,
  );
}

// ---------- P. Field-bound ciphertext (contract v91, F1) ----------
// Real actions on throwaway stores with real encryption. Direct
// database writes below plant or transplant stored bytes exactly
// as a database writer would; every read then goes through the
// real actions, so a context mismatch must surface as a refusal,
// never as a wrong figure.
{
  // Legacy (pre-v91) encryption: AES-256-GCM, random nonce, NO
  // associated data — the exact scheme every stored value used
  // before this build. Planting its output is how the dual-read
  // migration is proven without touching a real store.
  const legacyEncrypt = async (plain: string, keyBase64: string): Promise<string> => {
    const raw = Buffer.from(keyBase64, "base64");
    const ck = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt"]);
    const nonce = new Uint8Array(12);
    crypto.getRandomValues(nonce);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, ck, new TextEncoder().encode(plain)),
    );
    const combined = new Uint8Array(nonce.length + ct.length);
    combined.set(nonce, 0);
    combined.set(ct, nonce.length);
    return "enc:v1:" + Buffer.from(combined).toString("base64");
  };
  const storedSetting = async (db: any, k: string): Promise<string | undefined> => {
    const rows = await db.select().from(schema.settings);
    return rows.find((r: any) => r.key === k)?.value;
  };

  // P-B/C runtime: write/read round-trips, then legacy plants.
  const storeP = memoryStore();
  const rtP = await createRuntime({ store: storeP, wasmUrl: wasmPath });
  const dbP = rtP.localDb.db;
  await rtP.call<any>("getDashboard", { month: "2027-01" });
  const keyBase64P = storeP.get(ENC_KEY_KEY) ?? "";
  check("P0 packaged encryption key present", keyBase64P.length > 0);

  // P-B: one write + read per field family through the real actions.
  await rtP.call<any>("addTransaction", {
    date: "2027-01-15", description: "P field binding txn", amountCents: 432100,
    sourceType: "checking", accountName: "Checking", kind: "spending",
    category: "Groceries", yearlyExpenseId: null, fitId: "P-FIT-1",
  });
  // The bank transaction id is recorded only by the import
  // batch action (the manual add/edit actions accept the shared
  // shape but never set the column — documented at txnInput), so
  // the fit_id context family is proven through that path.
  const impTx = await rtP.call<any>("importTransactions", {
    rows: [{
      date: "2027-01-16", description: "P field binding import txn", amountCents: 98700,
      sourceType: "checking", accountName: "Checking", kind: "spending",
      category: "Groceries", yearlyExpenseId: null, fitId: "P-FIT-1",
    }],
  });
  eq("P-B0c import transaction recorded", impTx.imported, 1);
  const yExp = await rtP.call<any>("addYearlyExpense", {
    name: "P binding yearly", frequency: "yearly", expectedCents: 300000,
    dueMonth: 3, paidByType: "checking", paidByName: "Checking", category: "Housing",
  });
  eq("P-B0 yearly expense created", typeof yExp.id, "number");
  await rtP.call<any>("setYearlyExpenseVersion", {
    expenseId: yExp.id, expectedCents: 310000, frequency: "yearly", effectiveFrom: "2027-02",
  });
  const bill = await rtP.call<any>("addMonthlyBill", {
    name: "P binding bill", amountCents: 150000, effectiveFrom: "2027-01",
    paidBy: "Checking", notes: "P note", category: "Utilities",
  });
  await rtP.call<any>("setMonthlyBillAmount", {
    billId: bill.id, amountCents: 155000, effectiveFrom: "2027-02",
  });
  await rtP.call<any>("upsertMonthlySummary", { month: "2027-01", cashOutCents: 1200000 });
  await rtP.call<any>("addMonthlyOneOff", {
    month: "2027-01", description: "P one-off", amountCents: 64000, note: "P one-off note",
  });
  await rtP.call<any>("addCashOutItem", {
    month: "2027-01", description: "P cash item", amountCents: 210000, note: null, day: 5,
  });
  const acct = await rtP.call<any>("addNwAccount", {
    name: "P binding account", propertyKind: "none", custodial: false,
  });
  const snap = await rtP.call<any>("addNwSnapshot", {
    date: "2026-09-15", note: "P snapshot note",
    balances: [{
      accountId: acct.id, balanceCents: 5000000,
      splits: [
        { bucket: "Roth", amountCents: 2000000 },
        { bucket: "Taxable", amountCents: 3000000 },
      ],
    }],
  });
  eq("P-B0a NW snapshot created", snap.ok, true);
  await rtP.call<any>("saveImportSettings", {
    settingsJson: JSON.stringify({
      lastSettings: { template: "checking", outSign: "positive", accountName: "Checking", cardKeywords: "", transferKeywords: "" },
      profiles: [], ofxAccounts: {},
    }),
  });
  const impBack = await rtP.call<any>("getImportData", { months: [] });
  check(
    "P-B0b import settings round-trip",
    typeof impBack.settingsJson === "string" && impBack.settingsJson.includes("Checking"),
  );
  await rtP.call<any>("updateSettings", { openingReserveCents: 250000, reserveStartMonth: null });

  // The export payload is the round-trip oracle: it decrypts every
  // field, so any encrypt/decrypt context mismatch fails here.
  const payloadP = await rtP.call<any>("exportbackup", {});
  const expTxn = payloadP.transactions.find((t: any) => t.description === "P field binding txn");
  eq("P-B1 exported transaction amount", expTxn?.amountCents, 432100);
  eq("P-B2 exported transaction bank id", payloadP.transactions.find((t: any) => t.description === "P field binding import txn")?.fitId, "P-FIT-1");
  const expY = payloadP.yearlyExpenses.find((y: any) => y.name === "P binding yearly");
  eq("P-B3 exported yearly amount (latest version)", expY?.expectedCents, 310000);
  eq(
    "P-B4 yearly version rows present",
    payloadP.yearlyExpenseVersions.filter((v: any) => v.expenseId === yExp.id).length,
    2,
  );
  eq(
    "P-B5 exported summary",
    payloadP.monthlySummaries.find((s: any) => s.month === "2027-01")?.cashOutCents,
    1200000,
  );
  const expB = payloadP.monthlyBills.find((b: any) => b.name === "P binding bill");
  eq("P-B6 exported bill amount (latest version)", expB?.amountCents, 155000);
  eq("P-B7 exported bill note", expB?.notes, "P note");
  const expO = payloadP.monthlyOneOffs.find((o: any) => o.description === "P one-off");
  eq("P-B8 exported one-off", [expO?.amountCents, expO?.note], [64000, "P one-off note"]);
  eq(
    "P-B9 exported cash-out item",
    payloadP.monthlyCashOutItems.find((c: any) => c.description === "P cash item")?.amountCents,
    210000,
  );
  const nwP = await rtP.call<any>("getNetWorth", {});
  eq(
    "P-B10 NW snapshot total (split sum)",
    nwP.snapshots.find((s: any) => s.date === "2026-09-15")?.totalCents,
    5000000,
  );

  // P-C: legacy no-AAD ciphertext dual-reads and is re-encrypted
  // bound by the loaders (table rows), while settings blobs
  // upgrade on save only.
  const legacyKc = await legacyEncrypt("hatch-encryption-check-v1", keyBase64P);
  await dbP
    .update(schema.settings)
    .set({ value: legacyKc })
    .where(drizzleEq(schema.settings.key, "encryption_key_check_v1"));
  await rtP.call<any>("getDashboard", { month: "2027-01" });
  const kcAfter = await storedSetting(dbP, "encryption_key_check_v1");
  check(
    "P-C1 legacy key-check rebound on load",
    kcAfter !== undefined && kcAfter !== legacyKc && kcAfter.startsWith("enc:v1:"),
  );

  const legacySum = await legacyEncrypt("777700", keyBase64P);
  await dbP
    .update(schema.monthlySummaries)
    .set({ cashOutCents: legacySum })
    .where(drizzleEq(schema.monthlySummaries.month, "2027-01"));
  await rtP.call<any>("getDashboard", { month: "2027-01" });
  const payloadC = await rtP.call<any>("exportbackup", {});
  eq(
    "P-C2 legacy summary reads correctly",
    payloadC.monthlySummaries.find((s: any) => s.month === "2027-01")?.cashOutCents,
    777700,
  );
  const sumAfter = (await dbP.select().from(schema.monthlySummaries)).find(
    (r: any) => r.month === "2027-01",
  )?.cashOutCents;
  check(
    "P-C3 legacy summary rebound on load",
    sumAfter !== undefined && sumAfter !== legacySum && sumAfter.startsWith("enc:v1:"),
  );

  const decFresh = await rtP.call<any>("getDecemberProjection", {});
  const legacyDecState = JSON.stringify({ ...decFresh.state, ytdInterest: 4242, revision: 0 });
  const legacyDec = await legacyEncrypt(legacyDecState, keyBase64P);
  await dbP
    .insert(schema.settings)
    .values({ key: "december_projection_v1", value: legacyDec })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: legacyDec } });
  const decBack = await rtP.call<any>("getDecemberProjection", {});
  eq("P-C4 legacy December blob reads correctly", decBack.state.ytdInterest, 4242);
  eq(
    "P-C5 December blob not rewritten on read (save-only upgrade)",
    await storedSetting(dbP, "december_projection_v1"),
    legacyDec,
  );
  const decSave = await rtP.call<any>("saveDecemberProjection", {
    state: decBack.state, baseRevision: decBack.revision,
  });
  eq("P-C6 December save ok", decSave.ok, true);
  const decRawSaved = await storedSetting(dbP, "december_projection_v1");
  check(
    "P-C7 December blob bound after save",
    decRawSaved !== undefined && decRawSaved !== legacyDec && decRawSaved.startsWith("enc:v1:"),
  );

  // P-A: transplanted ciphertext is refused on load, in its own
  // runtimes (a refused load leaves the runtime behind, and the
  // point is the refusal, not recovery).
  {
    const storeT = memoryStore();
    const rtT = await createRuntime({ store: storeT, wasmUrl: wasmPath });
    const dbT = rtT.localDb.db;
    await rtT.call<any>("getDashboard", { month: "2027-01" });
    const yT = await rtT.call<any>("addYearlyExpense", {
      name: "P transplant source", frequency: "yearly", expectedCents: 300000,
      dueMonth: 3, paidByType: "checking", paidByName: "Checking", category: "Housing",
    });
    await rtT.call<any>("upsertMonthlySummary", { month: "2027-01", cashOutCents: 1200000 });
    const yRaw = (await dbT.select().from(schema.yearlyExpenses)).find(
      (r: any) => r.id === yT.id,
    )?.expectedCents as string;
    await dbT
      .update(schema.monthlySummaries)
      .set({ cashOutCents: yRaw })
      .where(drizzleEq(schema.monthlySummaries.month, "2027-01"));
    let threw = false;
    try {
      await rtT.call<any>("getDashboard", { month: "2027-01" });
    } catch {
      threw = true;
    }
    check("P-A1 transplanted amount ciphertext refused on load", threw);
  }
  {
    const storeT2 = memoryStore();
    const rtT2 = await createRuntime({ store: storeT2, wasmUrl: wasmPath });
    const dbT2 = rtT2.localDb.db;
    await rtT2.call<any>("getDashboard", { month: "2027-01" });
    const billT = await rtT2.call<any>("addMonthlyBill", {
      name: "P transplant name", amountCents: 100000, effectiveFrom: "2027-01",
      paidBy: "Checking", notes: null, category: "Utilities",
    });
    const yT2 = await rtT2.call<any>("addYearlyExpense", {
      name: "P victim yearly", frequency: "yearly", expectedCents: 100000,
      dueMonth: 3, paidByType: "checking", paidByName: "Checking", category: "Housing",
    });
    const billRawName = (await dbT2.select().from(schema.monthlyBills)).find(
      (r: any) => r.id === billT.id,
    )?.name as string;
    await dbT2
      .update(schema.yearlyExpenses)
      .set({ name: billRawName })
      .where(drizzleEq(schema.yearlyExpenses.id, yT2.id));
    let threw = false;
    try {
      await rtT2.call<any>("getDashboard", { month: "2027-01" });
    } catch {
      threw = true;
    }
    check("P-A2 transplanted name ciphertext refused on load", threw);
  }

  // P-D: restore re-encrypts (bound backup, legacy backup) or
  // refuses a transplant inside the backup with state untouched.
  const storeD = memoryStore();
  const rtD = await createRuntime({ store: storeD, wasmUrl: wasmPath });
  const dbD = rtD.localDb.db;
  await rtD.call<any>("getDashboard", { month: "2027-01" });
  const keyBase64D = storeD.get(ENC_KEY_KEY) ?? "";
  const payloadD = await rtP.call<any>("exportbackup", {});
  await rtD.call<any>("clearAllData", { confirm: "delete everything" });
  const resD = await rtD.call<any>("restorebackup", payloadD);
  eq("P-D1 bound backup restores ok", resD.ok, true);
  const payloadD2 = await rtD.call<any>("exportbackup", {});
  eq(
    "P-D2 restored summary reads back",
    payloadD2.monthlySummaries.find((s: any) => s.month === "2027-01")?.cashOutCents,
    777700,
  );
  const yCipherD = (await dbD.select().from(schema.yearlyExpenses)).find(
    (r: any) => typeof r.expectedCents === "string" && r.expectedCents.startsWith("enc:v1:"),
  )?.expectedCents as string;
  check("P-D2a transplant source ciphertext present", typeof yCipherD === "string" && yCipherD.length > 0);
  const tamperedP = JSON.parse(JSON.stringify(payloadD));
  delete tamperedP.authenticityMac;
  tamperedP.settings = tamperedP.settings.filter((s: any) => s.key !== "december_projection_v1");
  tamperedP.settings.push({ key: "december_projection_v1", value: yCipherD });
  const resTampered = await rtD.call<any>("restorebackup", tamperedP);
  eq("P-D3 transplanted ciphertext in backup refused", resTampered.ok, false);
  check(
    "P-D4 refusal names decryption",
    typeof resTampered.reason === "string" && resTampered.reason.includes("can't be decrypted"),
    resTampered.reason,
  );
  const afterD = await rtD.call<any>("exportbackup", {});
  eq(
    "P-D5 state untouched by refused restore",
    afterD.monthlySummaries.find((s: any) => s.month === "2027-01")?.cashOutCents,
    777700,
  );
  const legacyP = JSON.parse(JSON.stringify(payloadD));
  delete legacyP.authenticityMac;
  const decPlain = JSON.stringify((await rtP.call<any>("getDecemberProjection", {})).state);
  const legacyDecD = await legacyEncrypt(decPlain, keyBase64D);
  legacyP.settings = legacyP.settings.filter((s: any) => s.key !== "december_projection_v1");
  legacyP.settings.push({ key: "december_projection_v1", value: legacyDecD });
  const resLegacy = await rtD.call<any>("restorebackup", legacyP);
  eq("P-D6 legacy-ciphertext backup restores ok", resLegacy.ok, true);
  const decRawD = await storedSetting(dbD, "december_projection_v1");
  check(
    "P-D7 restored December value is bound, not the planted legacy bytes",
    decRawD !== undefined && decRawD !== legacyDecD && decRawD.startsWith("enc:v1:"),
  );
  const decBackD = await rtD.call<any>("getDecemberProjection", {});
  eq("P-D8 restored December state reads back", decBackD.state.ytdInterest, 4242);
}

// ---------- Q. Wipe purges retained generations (contract v92, F4) ----------
// A successful wipe must leave NO pre-wipe image readable: the
// retained gen - 1 fallback is itself the pre-wipe image, and
// any older generation lingering in the store goes with it.
// The just-committed empty image is the store's state and
// stays; the encryption key and backup vault are outside the
// generations-only scope and stay too. A refused wipe and an
// ordinary persist keep the fallback exactly as before.
{
  const activeGen = (s: KeyValueStore): number =>
    (JSON.parse(s.get(ACTIVE_KEY) as string) as { gen: number }).gen;
  const hasGenChunk = (s: KeyValueStore, g: number): boolean =>
    s.get(GEN_CHUNK_KEY(g, 0)) != null;

  // Q-A: data at generation 5, wiped through the real dispatch.
  const storeQ = memoryStore();
  const rtQ = await createRuntime({ store: storeQ, wasmUrl: wasmPath });
  await rtQ.call<any>("addMonthlyBill", {
    name: "Q pre-wipe bill", amountCents: 12300, effectiveFrom: "2027-01", paidBy: "Checking",
  });
  // Each dispatch persists one generation; drive the pointer
  // to exactly 5 with read-only dispatches so the pre-wipe
  // image under test is generation 5 itself.
  for (let i = 0; i < 10 && activeGen(storeQ) < 5; i++) {
    await rtQ.call<any>("getDashboard", { month: "2027-01" });
  }
  eq("Q-A0 active generation is 5 before the wipe", activeGen(storeQ), 5);
  check(
    "Q-A0a gen 4 fallback present before the wipe",
    hasGenChunk(storeQ, 4),
  );
  // Stale chunks under older generation numbers, as a store
  // whose earlier cleanups missed them would hold: the purge
  // sweep must remove those too, not only the fallback.
  storeQ.set(GEN_CHUNK_KEY(1, 0), "stale");
  storeQ.set(GEN_CHUNK_KEY(3, 0), "stale");
  const keyBefore = storeQ.get(ENC_KEY_KEY) ?? "";
  check("Q-A0b encryption key present before the wipe", keyBefore.length > 0);
  const wiped = await rtQ.call<any>("clearAllData", { confirm: "delete everything" });
  eq("Q-A1 clearAllData ok", wiped.ok, true);
  eq("Q-A2 wipe commits the next generation", activeGen(storeQ), 6);
  check(
    "Q-A3 no prior generation chunk remains (fallback and older)",
    [1, 2, 3, 4, 5].every((g) => !hasGenChunk(storeQ, g)),
    `remaining: ${[1, 2, 3, 4, 5].filter((g) => hasGenChunk(storeQ, g)).join(",") || "none"}`,
  );
  check("Q-A4 the committed empty image remains", hasGenChunk(storeQ, 6));
  check(
    "Q-A5 encryption key untouched by the generations-only purge",
    storeQ.get(ENC_KEY_KEY) === keyBefore,
  );
  // The store stays usable: a fresh runtime over the same
  // store loads the empty image, and a fresh write/read cycle
  // works on top of it (acceptance C).
  const rtQ2 = await createRuntime({ store: storeQ, wasmUrl: wasmPath });
  const dashWiped = await rtQ2.call<any>("getDashboard", { month: "2027-01" });
  check(
    "Q-A6 wiped store reloads usable and empty",
    dashWiped.hasAnyData === false && (dashWiped.monthlyBills ?? []).length === 0,
    `hasAnyData ${dashWiped.hasAnyData}`,
  );
  const postWipe = await rtQ2.call<any>("addMonthlyBill", {
    name: "Q post-wipe bill", amountCents: 45600, effectiveFrom: "2027-01", paidBy: "Checking",
  });
  check("Q-A7 fresh write after the wipe commits", typeof postWipe.id === "number", `id ${postWipe.id}`);
  const rtQ3 = await createRuntime({ store: storeQ, wasmUrl: wasmPath });
  const dashPost = await rtQ3.call<any>("getDashboard", { month: "2027-01" });
  check(
    "Q-A8 fresh write reads back after reload",
    (dashPost.monthlyBills ?? []).some((b: any) => b.name === "Q post-wipe bill"),
  );

  // Q-B: an ordinary (non-wipe) persist still retains exactly
  // the gen - 1 fallback and advances the pointer.
  const storeB = memoryStore();
  const rtB = await createRuntime({ store: storeB, wasmUrl: wasmPath });
  await rtB.call<any>("addMonthlyBill", {
    name: "Q ordinary bill one", amountCents: 11100, effectiveFrom: "2027-01", paidBy: "Checking",
  });
  const genB1 = activeGen(storeB);
  check(
    "Q-B1 ordinary persist retains the prior generation",
    hasGenChunk(storeB, genB1 - 1),
    `active ${genB1}`,
  );
  await rtB.call<any>("addMonthlyBill", {
    name: "Q ordinary bill two", amountCents: 22200, effectiveFrom: "2027-01", paidBy: "Checking",
  });
  eq("Q-B2 ordinary persist advances the pointer by one", activeGen(storeB), genB1 + 1);
  check(
    "Q-B3 ordinary persist retains exactly the new fallback",
    hasGenChunk(storeB, genB1) && !hasGenChunk(storeB, genB1 - 1),
    `active ${activeGen(storeB)}`,
  );

  // Q-D: a refused wipe (wrong confirmation) purges nothing:
  // the fallback stays, and the data stays.
  const storeR = memoryStore();
  const rtR = await createRuntime({ store: storeR, wasmUrl: wasmPath });
  await rtR.call<any>("addMonthlyBill", {
    name: "Q refused-wipe bill", amountCents: 33300, effectiveFrom: "2027-01", paidBy: "Checking",
  });
  const genR = activeGen(storeR);
  const refused = await rtR.call<any>("clearAllData", { confirm: "delete everythin" });
  eq("Q-D1 refused wipe returns ok false", refused.ok, false);
  check(
    "Q-D2 refused wipe keeps the fallback generation",
    hasGenChunk(storeR, genR),
    `active ${activeGen(storeR)}, prior ${genR}`,
  );
  const dashR = await rtR.call<any>("getDashboard", { month: "2027-01" });
  check(
    "Q-D3 refused wipe leaves the data intact",
    (dashR.monthlyBills ?? []).some((b: any) => b.name === "Q refused-wipe bill"),
  );
}

// ---------- R. Restore epoch (contract v93, F5) ----------
// The reviewer's interleaving through the real actions: an
// editor reads a snapshot, a valid backup restore replaces it
// (revision restarts at 0, exactly the pre-v93 hole), and the
// pre-restore editor's write must be refused with the
// restore-naming reason while the restored balance stays
// intact. A fresh editor after the restore succeeds; ordinary
// revision CAS without a restore is unchanged; a second
// restore invalidates the first-restore-era editor again; and
// a carried epoch value in an old backup is ignored — the
// restore always stamps one past the destination's epoch.
{
  const storeR = memoryStore();
  const rtR = await createRuntime({ store: storeR, wasmUrl: wasmPath });
  // A fresh runtime boots seeded (section C's sample dataset),
  // so wipe first — the section M idiom — leaving an empty
  // store at epoch 0 for the interleaving below.
  const wipedR = await rtR.call<any>("clearAllData", { confirm: "delete everything" });
  eq("R-A0a store wiped empty before the interleaving", wipedR.ok, true);
  const acctR = await rtR.call<any>("addNwAccount", { name: "Epoch Bank" });
  const snapR = await rtR.call<any>("addNwSnapshot", {
    date: "2026-10-01", note: null,
    balances: [{ accountId: acctR.id, balanceCents: 1000000, splits: null }],
  });
  check("R-A0 snapshot added", snapR.ok === true, snapR.reason);
  const snapOf = async () =>
    (await rtR.call<any>("getNetWorth", {})).snapshots.find((s: any) => s.id === snapR.id);
  const nwR0 = await rtR.call<any>("getNetWorth", {});
  eq("R-A1 editor loads at epoch 0", nwR0.restoreEpoch, 0);
  eq("R-A2 editor loads at revision 0", (await snapOf())?.revision, 0);
  eq("R-A3 loaded balance is the pre-restore figure", (await snapOf())?.totalCents, 1000000);

  // The restore payload: an export from before any restore, so
  // it carries no epoch key at all (the old-backup shape), with
  // the snapshot's balance replaced by the restored figure and
  // re-signed so the restore verifies as authenticated.
  const payloadR = await rtR.call<any>("exportbackup", {});
  check(
    "R-A4 pre-restore export carries no epoch key",
    !(payloadR.settings ?? []).some((s: any) => s.key === "nw_restore_epoch_v1"),
  );
  const setBalance = (p: any, cents: number) => {
    const row = (p.nwBalances ?? []).find((b: any) => b.snapshotId === snapR.id);
    if (row) {
      // A non-empty split IS the balance under the restore
      // normalisation, so the replaced figure must ride with
      // every split part cleared, or the edit is normalised
      // away and the check below passes vacuously.
      row.balanceCents = cents;
      row.splitHsaCents = null;
      row.splitRothCents = null;
      row.splitTaxableCents = null;
      row.splitNonTaxableCents = null;
      row.split529Cents = null;
      row.splitCashCents = null;
      row.splitPreTaxCents = null;
    }
    return p;
  };
  const restored1 = setBalance(JSON.parse(JSON.stringify(payloadR)), 2000000);
  restored1.authenticityMac = computeBackupMac(restored1);
  const res1 = await rtR.call<any>("restorebackup", restored1);
  eq("R-A5 first restore ok and authenticated", [res1.ok, res1.authenticated], [true, true]);
  eq("R-A6 epoch advanced to 1 by the restore", (await rtR.call<any>("getNetWorth", {})).restoreEpoch, 1);
  eq("R-A7 restored snapshot restarts at revision 0", (await snapOf())?.revision, 0);
  eq("R-A8 restored balance is intact after the restore", (await snapOf())?.totalCents, 2000000);

  // Editor A: the pre-restore view (revision 0, epoch 0).
  const staleWhole = await rtR.call<any>("updateNwSnapshot", {
    id: snapR.id, date: "2026-10-01", note: "stale edit",
    balances: [{ accountId: acctR.id, balanceCents: 1000000, splits: null }],
    baseRevision: 0, baseEpoch: 0,
  });
  eq("R-A9 stale whole-snapshot write refused", [staleWhole.ok, staleWhole.conflict], [false, true]);
  check(
    "R-A10 stale refusal names the restore",
    typeof staleWhole.reason === "string" && staleWhole.reason.includes("A backup was restored"),
    staleWhole.reason,
  );
  eq("R-A11 restored balance intact after the stale write", (await snapOf())?.totalCents, 2000000);
  eq("R-A12 revision unmoved by the stale write", (await snapOf())?.revision, 0);
  const staleBal = await rtR.call<any>("updateNwBalance", {
    snapshotId: snapR.id, accountId: acctR.id, balanceCents: 1000000,
    splits: null, baseRevision: 0, baseEpoch: 0,
  });
  eq("R-A13 stale balance write refused", [staleBal.ok, staleBal.conflict], [false, true]);
  check(
    "R-A14 stale balance refusal names the restore",
    typeof staleBal.reason === "string" && staleBal.reason.includes("A backup was restored"),
    staleBal.reason,
  );
  eq("R-A15 restored balance intact after the stale balance write", (await snapOf())?.totalCents, 2000000);

  // Fresh editor: reads after the restore (revision 0, epoch 1).
  const freshWhole = await rtR.call<any>("updateNwSnapshot", {
    id: snapR.id, date: "2026-10-01", note: "fresh edit",
    balances: [{ accountId: acctR.id, balanceCents: 2100000, splits: null }],
    baseRevision: 0, baseEpoch: 1,
  });
  eq("R-B1 fresh whole-snapshot write succeeds and bumps the revision", [freshWhole.ok, freshWhole.revision], [true, 1]);
  eq("R-B2 fresh edit stored", (await snapOf())?.totalCents, 2100000);
  const freshBal = await rtR.call<any>("updateNwBalance", {
    snapshotId: snapR.id, accountId: acctR.id, balanceCents: 2200000,
    splits: null, baseRevision: 1, baseEpoch: 1,
  });
  eq("R-B3 fresh balance write succeeds and bumps the revision", [freshBal.ok, freshBal.revision], [true, 2]);

  // Ordinary revision CAS, no restore since: a stale revision is
  // refused with the ordinary reason, a fresh one succeeds.
  const ordinaryStale = await rtR.call<any>("updateNwBalance", {
    snapshotId: snapR.id, accountId: acctR.id, balanceCents: 2100000,
    splits: null, baseRevision: 1, baseEpoch: 1,
  });
  eq("R-D1 stale revision without a restore refused", [ordinaryStale.ok, ordinaryStale.conflict], [false, true]);
  check(
    "R-D2 ordinary refusal does not name a restore",
    typeof ordinaryStale.reason === "string" && !ordinaryStale.reason.includes("A backup was restored"),
    ordinaryStale.reason,
  );
  const ordinaryFresh = await rtR.call<any>("updateNwBalance", {
    snapshotId: snapR.id, accountId: acctR.id, balanceCents: 2300000,
    splits: null, baseRevision: 2, baseEpoch: 1,
  });
  eq("R-D3 fresh revision without a restore succeeds", [ordinaryFresh.ok, ordinaryFresh.revision], [true, 3]);

  // Second restore: a MAC-stripped (pre-MAC) payload carrying a
  // STALE epoch value and a new balance. The carried value must
  // be ignored — the restore stamps one past the destination's
  // epoch (1 -> 2), and the first-restore-era editor is refused.
  const payloadR2 = await rtR.call<any>("exportbackup", {});
  const stripped2 = setBalance(JSON.parse(JSON.stringify(payloadR2)), 3000000);
  delete stripped2.authenticityMac;
  const epochRow = (stripped2.settings ?? []).find((s: any) => s.key === "nw_restore_epoch_v1");
  check("R-C0 second export carries the stamped epoch", epochRow?.value === "1", String(epochRow?.value));
  if (epochRow) epochRow.value = "0";
  const res2 = await rtR.call<any>("restorebackup", stripped2);
  eq("R-C1 second restore ok, labelled unauthenticated", [res2.ok, res2.authenticated], [true, false]);
  eq("R-C2 epoch advanced to 2 despite the carried stale value", (await rtR.call<any>("getNetWorth", {})).restoreEpoch, 2);
  eq("R-C3 second restored balance stored", (await snapOf())?.totalCents, 3000000);
  const era1Stale = await rtR.call<any>("updateNwSnapshot", {
    id: snapR.id, date: "2026-10-01", note: "first-restore-era edit",
    balances: [{ accountId: acctR.id, balanceCents: 2300000, splits: null }],
    baseRevision: 3, baseEpoch: 1,
  });
  eq("R-C4 first-restore-era write refused after the second restore", [era1Stale.ok, era1Stale.conflict], [false, true]);
  check(
    "R-C5 second-restore refusal names the restore",
    typeof era1Stale.reason === "string" && era1Stale.reason.includes("A backup was restored"),
    era1Stale.reason,
  );
  eq("R-C6 second restored balance intact", (await snapOf())?.totalCents, 3000000);
  const freshAfterSecond = await rtR.call<any>("updateNwSnapshot", {
    id: snapR.id, date: "2026-10-01", note: "second-restore-era edit",
    balances: [{ accountId: acctR.id, balanceCents: 3100000, splits: null }],
    baseRevision: 0, baseEpoch: 2,
  });
  eq("R-C7 fresh editor after the second restore succeeds", [freshAfterSecond.ok, freshAfterSecond.revision], [true, 1]);
}

// ---------- S. Legacy bucket field at restore preflight (contract v94, F6) ----------
// The reviewer's reproduction through the real actions: a restore
// carrying an undecryptable enc:v1:-prefixed bucket must be
// refused at preflight with the prior data intact, while valid
// legacy forms — a plaintext bucket, a legacy no-AAD ciphertext
// bucket, and a field-bound ciphertext bucket — restore and
// export again afterwards. The bucket is the one backup field
// the restore stores verbatim while the export decrypts, so it
// is the one field whose poisoned value an accepted restore
// would carry into every later export.
{
  const storeS = memoryStore();
  const rtS = await createRuntime({ store: storeS, wasmPath });
  await rtS.call<any>("clearAllData", { confirm: "delete everything" });
  await rtS.call<any>("getDashboard", { month: "2027-01" });
  const keyBase64S = storeS.get(ENC_KEY_KEY) ?? "";
  check("S0 packaged encryption key present", keyBase64S.length > 0);
  const acctS = await rtS.call<any>("addNwAccount", { name: "Bucket Bank" });
  const snapS = await rtS.call<any>("addNwSnapshot", {
    date: "2026-10-01", note: null,
    balances: [{ accountId: acctS.id, balanceCents: 4000000, splits: null }],
  });
  check("S0a snapshot added", snapS.ok === true, snapS.reason);
  const totalOf = async () =>
    (await rtS.call<any>("getNetWorth", {})).snapshots.find((s: any) => s.id === snapS.id)?.totalCents;
  const priorTotal = await totalOf();
  eq("S0b prior total is the entered figure", priorTotal, 4000000);

  // Ciphertext crafters in the two forms the export reader
  // accepts: legacy no-AAD (pre-v91) and field-bound under
  // the bucket field's own context — the same context literal
  // the export decrypt site uses.
  const importBucketKey = async () => {
    const raw = Buffer.from(keyBase64S, "base64");
    return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt"]);
  };
  const encryptBucket = async (plain: string, bound: boolean): Promise<string> => {
    const ck = await importBucketKey();
    const nonce = new Uint8Array(12);
    crypto.getRandomValues(nonce);
    const params: AesGcmParams = bound
      ? {
          name: "AES-GCM", iv: nonce,
          additionalData: new TextEncoder().encode("fp-aad-v1:nw_accounts.bucket"),
        }
      : { name: "AES-GCM", iv: nonce };
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(params, ck, new TextEncoder().encode(plain)),
    );
    const combined = new Uint8Array(nonce.length + ct.length);
    combined.set(nonce, 0);
    combined.set(ct, nonce.length);
    return "enc:v1:" + Buffer.from(combined).toString("base64");
  };
  const withBucket = (payload: any, bucket: string) => {
    const p = JSON.parse(JSON.stringify(payload));
    const row = (p.nwAccounts ?? []).find((a: any) => a.id === acctS.id);
    if (row) row.bucket = bucket;
    p.authenticityMac = computeBackupMac(p);
    return p;
  };
  const exportedBucket = async (): Promise<string | undefined> => {
    const p = await rtS.call<any>("exportbackup", {});
    return p.nwAccounts.find((a: any) => a.id === acctS.id)?.bucket;
  };

  // S-A: the reviewer's poisoned value is refused, names the
  // bucket, and leaves the prior data and later exports intact.
  const poisoned = withBucket(await rtS.call<any>("exportbackup", {}), "enc:v1:!");
  const refusedS = await rtS.call<any>("restorebackup", poisoned);
  eq("S1 poisoned bucket restore refused", refusedS.ok, false);
  check(
    "S2 poisoned refusal names the bucket field",
    typeof refusedS.reason === "string" && refusedS.reason.includes("bucket"),
    refusedS.reason,
  );
  eq("S3 prior total intact after the refused restore", await totalOf(), priorTotal);
  eq("S4 export still works after the refused restore", await exportedBucket(), "Unbucketed");

  // S-B: a plaintext legacy bucket restores and exports again.
  const plainS = await rtS.call<any>("restorebackup", withBucket(await rtS.call<any>("exportbackup", {}), "Taxable"));
  eq("S5 plaintext bucket restore ok", plainS.ok, true);
  eq("S6 plaintext bucket exports again", await exportedBucket(), "Taxable");

  // S-C: a legacy no-AAD ciphertext bucket restores and exports
  // to its plaintext tag.
  const legacyBucket = await encryptBucket("Roth", false);
  const legacyS = await rtS.call<any>("restorebackup", withBucket(await rtS.call<any>("exportbackup", {}), legacyBucket));
  eq("S7 legacy ciphertext bucket restore ok", legacyS.ok, true);
  eq("S8 legacy ciphertext bucket exports to its tag", await exportedBucket(), "Roth");

  // S-D: a field-bound ciphertext bucket restores and exports
  // to its plaintext tag.
  const boundBucket = await encryptBucket("Cash", true);
  const boundS = await rtS.call<any>("restorebackup", withBucket(await rtS.call<any>("exportbackup", {}), boundBucket));
  eq("S9 bound ciphertext bucket restore ok", boundS.ok, true);
  eq("S10 bound ciphertext bucket exports to its tag", await exportedBucket(), "Cash");

  // S-E: a second undecryptable value class (invalid base64
  // after the prefix) refuses the same way.
  const badB64 = withBucket(await rtS.call<any>("exportbackup", {}), "enc:v1:%%%");
  const refusedB64 = await rtS.call<any>("restorebackup", badB64);
  eq("S11 invalid-base64 bucket restore refused", refusedB64.ok, false);
  check(
    "S12 invalid-base64 refusal names the bucket field",
    typeof refusedB64.reason === "string" && refusedB64.reason.includes("bucket"),
    refusedB64.reason,
  );
  eq("S13 prior total intact after the second refusal", await totalOf(), priorTotal);
}

console.log(`\n${checks - failures}/${checks} harness checks passed`);
process.exit(failures === 0 ? 0 : 1);
