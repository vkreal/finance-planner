// Extended accuracy fixtures — pinned cases for the Spending,
// Net Worth, and Year Summary computations, run by the
// runAccuracySelfCheck maintenance action alongside the Retirement
// fixture suite (server/src/retirementFixtures.ts).
//
// The cases run on a PINNED SYNTHETIC dataset built below — never
// on the user's data — through the same shared computation cores
// the views use (server/src/spendingCore.ts, server/src/nwCore.ts),
// so a future change to the math that moves any of these numbers
// fails loudly here. Every expected value was derived by hand from
// the dataset (the derivation is in each case's note), NOT copied
// from the app's output.
//
// MAINTENANCE RULE: an expected value may only be changed after the
// new number has been verified by an independent recomputation from
// the dataset below — a moved number is a finding until then.
//
// The synthetic year is 2025 (a past year) so the Year Summary
// window rule (January–December for a past year) keeps the cases
// deterministic whenever they run.

import {
createSpendingCore,
monthlyBillUpdateOutcome,
monthlyBillUpdateSet,
versionInEffect,
yearSummaryFloorMonth,
type CoreBillVersion,
type CoreTxn,
type CoreYearlyBillNamed,
type CoreYearlyVersion,
type ForecastMonth,
type SpendingCore,
} from "./spendingCore";
import {
executeImportPlanAtomically,
planImportBatch,
type ImportTextRow,
} from "./importCore";
import {
EMPTY_IMPORT_SETTINGS,
buildCashOutProposals,
combineDebitCreditAmount,
compareCashOutProposal,
findImportProfile,
flagExactFitIdDuplicates,
flagImportDuplicates,
guessImportMapping,
importHeaderFingerprint,
normalizeImportDate,
parseImportAmount,
parseImportSettings,
serializeImportSettings,
upsertImportProfile,
withLastImportSettings,
type ImportColumnMapping,
type ImportFileSettings,
} from "./importParseCore";
import {
EMPTY_NW_IMPORT_SETTINGS,
balanceRowsFromOfx,
buildNwImportDraft,
detectNwBalanceHeader,
filterNwDraftEntries,
findNwImportProfile,
guessNwBalanceMapping,
matchNwImportRows,
normalizeNwLabel,
nwImportStatementDate,
parseNwBalanceRows,
parseNwImportSettings,
proportionalNwSplit,
serializeNwImportSettings,
upsertNwImportProfile,
withNwLabelMappings,
} from "./nwImportCore";
import {
ofxAccountDisplay,
parseOfx,
parseOfxDate,
} from "./ofxCore";
import {
attemptNwSnapshotWrite,
bucketSubtotals,
buildNwSnapshotWritePlan,
classByIdOf,
executeNwWritePlanAtomically,
isCustodialAccount,
isFutureSnapshotDate,
nwWriteStateFingerprint,
propertyKindOf,
resolveNwSnapshotRows,
snapshotTotals,
splitPartsOf,
todayDateString,
validateNwBalanceSplits,
yearMovers,
type CoreNwBalance,
type NwWriteState,
} from "./nwCore";
import {
ROTH_UI_STATE_KEY,
applyRothUiWrite,
commitGuardedRothUiWrite,
parseRothUiState,
type RothUiState,
} from "./rothUiStateCore";
import {
appendRetirementScenario,
commitGuardedRothBlobWrite,
composeRetirementBaselineBlob,
composeRetirementInputsBlob,
composeRetirementScenarioBlob,
decideRetirementBaselinePair,
decideRetirementCapture,
decideRothBlobWrite,
decideRothBlobWriteChecked,
decideRothResetAfterLoss,
deleteRetirementScenario,
parseRothBlobRevision,
renameRetirementScenario,
ROTH_RESET_MAX_ATTEMPTS,
rothBlobRevisionOf,
rothBlobRevisionState,
rothBlobRevisionValue,
rothBlobStoredRawMatches,
rothFirstWritePlan,
withRothBlobRevision,
} from "./rothRevisionCore";
import {
joinRothBlob,
runRothCompare,
splitRothBlob,
type RothCompareBaseSaved,
type RothCompareOverrides,
} from "./rothOptimizer";
import {
DEFAULT_DRAW_ORDER,
deriveSpendFromCashSleeveStartDollars,
simulateRothPlan,
type RothPlanInputs,
} from "./taxEngine";
import {
BACKUP_AUTHENTICITY_SEMANTICS,
BALANCE_SEMANTICS,
CEILINGS_REPLACEMENT_SENTENCE,
CONVERTED_ALREADY_DISTINCTION_SENTENCE,
EDUCATION_CREDIT_SEMANTICS,
LAW_YEAR_SEMANTICS,
PLAYGROUND_YEAR_SEMANTICS,
PROTECT_MIN_SEMANTICS,
ROTH_BALANCE_KEYS,
ROTH_COMPARE_EXAMPLE,
SAVE_FLATTENING_SENTENCE,
SCORE_IDENTITIES,
STATE_SEMANTICS,
TAX_RETURN_SEMANTICS,
TIER_SEMANTICS,
UNITS_SEMANTICS,
UNPAID_TAX_SEMANTICS,
WRITERS_READERS_RULE,
expectedReturnPctField,
mcScoreIn,
nwPropertyKind,
nwPropertyKindWithDefault,
rothBaseBalancesIn,
updateMonthlyBillIn,
withResolvedOverrideBalances,
withSleeveEcho,
yearlyFrequency,
yearlyFrequencyWithDefault,
} from "./apiContractCore";
import { seedRothInputs } from "./rothSeed";
import {
CLEAR_ALL_CONFIRM_PHRASE,
CLEAR_ALL_WIPE_ORDER,
attemptClearAllData,
buildClearAllPlan,
clearAllStateFingerprint,
emptyClearAllState,
type ClearAllState,
} from "./clearDataCore";
import {
BACKUP_KEY_CHECK_PLAINTEXT,
BACKUP_KEY_CHECK_SETTING,
RESTORE_ROTH_BLOB_KEY,
RESTORE_WIPE_ORDER,
attemptRestore,
backupPayload,
buildRestorePlan,
executeRestorePlanAtomically,
payloadKeyCheckValue,
restoreStateFingerprint,
restoredRothBlobRevision,
stampRestoredRothBlob,
type BackupPayload,
type RestoreState,
} from "./restoreCore";
import {
bytesToHex,
classifyBackupAuthenticity,
computeBackupMac,
hmacSha256Bytes,
sha256Hex,
utf8Bytes,
type BackupAuthenticity,
} from "./backupMacCore";
import {
backupReadSource,
chooseBackupFilename,
legacyBackupsDir,
mergeBackupListings,
perSpaceBackupsDir,
planDeleteAllBackups,
planDeleteBackup,
planPruneBackups,
type BackupFileEntry,
} from "./backupCore";
import {
ENC_PREFIX,
RESERVED_ENC_PREFIX_MESSAGE,
attemptStoreTextField,
modelCiphertext,
modelPlaintext,
planTextStore,
type TextStorePlan,
} from "./encPrefixCore";

/* ---------------- The pinned synthetic dataset ----------------
   Monthly bills: Rent $1,000.00 (Keep the lights on) and Gym
   $50.00, both in effect from Nov 2024.
   Smoothed bills (versions from Nov 2024 unless noted):
     1 AnnualSub  yearly      $1,200.00 due Mar
     2 SemiIns    semiannual    $600.00 due Feb & Aug
     3 QuarterFee quarterly     $300.00 due Jan/Apr/Jul/Oct (KLO)
     4 BiWater    bimonthly     $200.00 due odd months
     5 LateStart  yearly      $2,400.00 due Jun, version from Mar 2025
   Each of bills 1–4 annualises to $1,200.00, so while all four are
   in effect the annualised total is $4,800.00 and the set-aside is
   $400.00/mo; once LateStart joins (Mar 2025) the total is
   $7,200.00 and the set-aside $600.00/mo. */

const TXNS: CoreTxn[] = [
  // Jan 2025 — a transactions-basis month.
  { date: "2025-01-10", kind: "spending", sourceType: "checking", amountCents: 50000, yearlyExpenseId: null },
  // BiWater paid on time in its due month, from checking.
  { date: "2025-01-15", kind: "spending", sourceType: "checking", amountCents: 20000, yearlyExpenseId: 4 },
  // QuarterFee (due Jan) paid by CARD: the charge is the payment.
  { date: "2025-01-20", kind: "spending", sourceType: "card", amountCents: 30000, yearlyExpenseId: 3 },
  // Feb 2025 — AnnualSub paid a month EARLY (due Mar), from checking.
  { date: "2025-02-10", kind: "spending", sourceType: "checking", amountCents: 120000, yearlyExpenseId: 1 },
  // The card bill for January's charges leaves checking in Feb:
  // cash out, never spending, never a smoothed lump.
  { date: "2025-02-15", kind: "card_payment", sourceType: "checking", amountCents: 30000, yearlyExpenseId: null },
  // Mar 2025 — SemiIns (due Feb) paid LATE, from checking.
  { date: "2025-03-05", kind: "spending", sourceType: "checking", amountCents: 60000, yearlyExpenseId: 2 },
];

const YEARLY: CoreYearlyBillNamed[] = [
  { id: 1, name: "AnnualSub", frequency: "yearly", expectedCents: 120000, dueMonth: 3, backfillBeforeFirstVersion: 0, keepLightsOn: 0 },
  { id: 2, name: "SemiIns", frequency: "semiannual", expectedCents: 60000, dueMonth: 2, backfillBeforeFirstVersion: 0, keepLightsOn: 0 },
  { id: 3, name: "QuarterFee", frequency: "quarterly", expectedCents: 30000, dueMonth: 1, backfillBeforeFirstVersion: 0, keepLightsOn: 1 },
  { id: 4, name: "BiWater", frequency: "bimonthly", expectedCents: 20000, dueMonth: 1, backfillBeforeFirstVersion: 0, keepLightsOn: 0 },
  { id: 5, name: "LateStart", frequency: "yearly", expectedCents: 240000, dueMonth: 6, backfillBeforeFirstVersion: 0, keepLightsOn: 0 },
];

const YEARLY_VERSIONS: CoreYearlyVersion[] = [
  { id: 1, expenseId: 1, effectiveFrom: "2024-11", expectedCents: 120000, frequency: "yearly" },
  { id: 2, expenseId: 2, effectiveFrom: "2024-11", expectedCents: 60000, frequency: "semiannual" },
  { id: 3, expenseId: 3, effectiveFrom: "2024-11", expectedCents: 30000, frequency: "quarterly" },
  { id: 4, expenseId: 4, effectiveFrom: "2024-11", expectedCents: 20000, frequency: "bimonthly" },
  { id: 5, expenseId: 5, effectiveFrom: "2025-03", expectedCents: 240000, frequency: "yearly" },
];

const BILLS = [
  { id: 1, keepLightsOn: 1 },
  { id: 2, keepLightsOn: 0 },
];
const BILL_VERSIONS: CoreBillVersion[] = [
  { id: 1, billId: 1, effectiveFrom: "2024-11", amountCents: 100000 },
  { id: 2, billId: 2, effectiveFrom: "2024-11", amountCents: 5000 },
];

// Feb 2025 has an entered total; Mar 2025 has BOTH an entered total
// and items — the items win (the same-month precedence case).
const SUMMARIES = [
  { month: "2025-02", cashOutCents: 900000 },
  { month: "2025-03", cashOutCents: 999999 },
];
const CASH_OUT_ITEMS = [
  { month: "2025-03", amountCents: 300000 },
  { month: "2025-03", amountCents: 150000 },
];
const ONE_OFFS = [{ month: "2025-01", amountCents: 77700 }];

/* Net Worth: Brokerage (split across Roth/Taxable), House (property
   asset), Mortgage (property liability), Old 401k (unsplit), and
   Kid UTMA (custodial — recorded in every snapshot, counted in
   NOTHING: every pre-existing expected total/bucket/mover figure
   in this suite was derived WITHOUT the custodial balances, so
   the custodial account's presence in the dataset is itself the
   exclusion proof, and the dedicated custodial cases below pin
   the with/without comparison explicitly).
   Snapshots straddle the Dec 2024 → Jan 2025 year boundary. */
const NW_ACCOUNTS = [
  { id: 1, name: "Brokerage", propertyKind: "none" },
  { id: 2, name: "House", propertyKind: "asset" },
  { id: 3, name: "Mortgage", propertyKind: "liability" },
  { id: 4, name: "Old 401k", propertyKind: "none" },
  { id: 5, name: "Kid UTMA", propertyKind: "none", custodial: true },
];
const NW_CLASS_BY_ID = classByIdOf(NW_ACCOUNTS);
const bal = (
  accountId: number,
  balanceCents: number,
  splits: Partial<Record<"splitHsaCents" | "splitRothCents" | "splitTaxableCents" | "splitNonTaxableCents" | "split529Cents" | "splitCashCents" | "splitPreTaxCents", number>> = {},
): CoreNwBalance => ({
  accountId,
  balanceCents,
  splitHsaCents: splits.splitHsaCents ?? null,
  splitRothCents: splits.splitRothCents ?? null,
  splitTaxableCents: splits.splitTaxableCents ?? null,
  splitNonTaxableCents: splits.splitNonTaxableCents ?? null,
  split529Cents: splits.split529Cents ?? null,
  splitCashCents: splits.splitCashCents ?? null,
  splitPreTaxCents: splits.splitPreTaxCents ?? null,
});
const NW_SNAPSHOTS = [
  { id: 1, date: "2024-12-20" },
  { id: 2, date: "2025-01-15" },
  { id: 3, date: "2025-02-10" },
];
const NW_BALANCES: Record<number, CoreNwBalance[]> = {
  1: [
    bal(1, 100000000, { splitRothCents: 40000000, splitTaxableCents: 60000000 }),
    bal(2, 50000000),
    bal(3, 20000000),
    bal(4, 5000000),
    bal(5, 2500000),
  ],
  2: [
    bal(1, 110000000, { splitRothCents: 44000000, splitTaxableCents: 66000000 }),
    bal(2, 50000000),
    bal(3, 19500000),
    bal(4, 5000000),
    bal(5, 3000000),
  ],
  3: [
    bal(1, 90000000, { splitRothCents: 40000000, splitTaxableCents: 50000000 }),
    bal(2, 51000000),
    bal(3, 19000000),
    bal(4, 7000000),
    bal(5, 2750000),
  ],
};

type World = {
  core: SpendingCore;
  forecastJan: ForecastMonth[];
};

let worldCache: World | null = null;
function world(): World {
  if (worldCache) return worldCache;
  const core = createSpendingCore({
    txns: TXNS,
    yearly: YEARLY,
    yearlyVersions: YEARLY_VERSIONS,
    summaries: SUMMARIES,
    cashOutItems: CASH_OUT_ITEMS,
    bills: BILLS,
    billVersions: BILL_VERSIONS,
    oneOffs: ONE_OFFS,
    openingReserveCents: 0,
    reserveStartSetting: null,
  });
  worldCache = { core, forecastJan: core.forecastFor("2025-01") };
  return worldCache;
}

// The Year Summary's spending selection, run on the core exactly as
// the action runs it for a past year: every month of the year that
// has data contributes its effective smoothed / cash-out figures.
// firstMonthNum / lastMonthNum are the endpoints the view's scope
// line names ("August–October 2026 — totals run through the last
// month with data").
function yearSpending(core: SpendingCore, year: number) {
  let months = 0;
  let trueCost = 0;
  let cashOut = 0;
  let firstMonthNum: number | null = null;
  let lastMonthNum: number | null = null;
  for (let n = 1; n <= 12; n++) {
    const m = `${year}-${String(n).padStart(2, "0")}`;
    if (!core.monthHasData(m)) continue;
    const e = core.eff(m);
    months += 1;
    if (firstMonthNum == null) firstMonthNum = n;
    lastMonthNum = n;
    trueCost += e.smoothed;
    cashOut += e.cashOut;
  }
  return {
    months,
    trueCost,
    cashOut,
    average: months > 0 ? Math.round(trueCost / months) : 0,
    firstMonthNum,
    lastMonthNum,
  };
}

// The Year Summary's prior-year anchor, selected exactly as the
// action selects it: the last snapshot dated before Jan 1 of the
// year — the starting point the Net Worth view's Year to date is
// measured from (the change-for-the-year instead starts at the
// year's first snapshot).
function priorYearAnchor(year: number, includeProperty: boolean) {
  const prior = NW_SNAPSHOTS.filter((s) => s.date < `${year}-01-01`);
  const last = prior[prior.length - 1] ?? null;
  if (!last) return { dateNum: null, total: null };
  return {
    dateNum: Number(last.date.replace(/-/g, "")),
    total: snapshotTotals(NW_BALANCES[last.id] ?? [], NW_CLASS_BY_ID, includeProperty).totalCents,
  };
}

// The Year Summary's Net Worth block for one year, on nwCore
// exactly as the action computes it.
function yearNetWorth(year: number, includeProperty: boolean) {
  const yearSnaps = NW_SNAPSHOTS.filter((s) => s.date.startsWith(`${year}-`));
  const first = yearSnaps[0] ?? null;
  const last = yearSnaps[yearSnaps.length - 1] ?? null;
  if (!first || !last) {
    return { count: 0, first: null, last: null, change: null, pctMicro: null, movers: [] as ReturnType<typeof yearMovers> };
  }
  const firstTotal = snapshotTotals(NW_BALANCES[first.id] ?? [], NW_CLASS_BY_ID, includeProperty).totalCents;
  const lastTotal = snapshotTotals(NW_BALANCES[last.id] ?? [], NW_CLASS_BY_ID, includeProperty).totalCents;
  const change = lastTotal - firstTotal;
  return {
    count: yearSnaps.length,
    first: firstTotal,
    last: lastTotal,
    change,
    pctMicro: firstTotal !== 0 ? Math.round((change / firstTotal) * 1_000_000) : null,
    movers: yearMovers(
      NW_ACCOUNTS,
      NW_BALANCES[first.id] ?? [],
      NW_BALANCES[last.id] ?? [],
      NW_CLASS_BY_ID,
      includeProperty,
      first.id === last.id,
    ),
  };
}

// The Year Summary's year-in-spending aggregates, recomposed
// locally from core primitives exactly as the action composes
// them (the established ys-* pattern): highest / lowest month by
// True cost (earliest month wins a tie), each month's one-offs
// from core.oneOffTotalForMonth, and the keep-the-lights-on floor
// for a named month from core.keepLightsOnForMonth.
function yearInSpending(core: SpendingCore, year: number, floorMonth: string) {
  let highest: { monthNum: number; trueCost: number; oneOffs: number } | null = null;
  let lowest: { monthNum: number; trueCost: number; oneOffs: number } | null = null;
  let totalOneOffs = 0;
  for (let n = 1; n <= 12; n++) {
    const m = `${year}-${String(n).padStart(2, "0")}`;
    if (!core.monthHasData(m)) continue;
    const tc = core.eff(m).smoothed;
    const oo = core.oneOffTotalForMonth(m);
    totalOneOffs += oo;
    if (highest == null || tc > highest.trueCost) highest = { monthNum: n, trueCost: tc, oneOffs: oo };
    if (lowest == null || tc < lowest.trueCost) lowest = { monthNum: n, trueCost: tc, oneOffs: oo };
  }
  return {
    highestMonthNum: highest?.monthNum ?? null,
    highestTrueCost: highest?.trueCost ?? null,
    highestOneOffs: highest?.oneOffs ?? null,
    lowestMonthNum: lowest?.monthNum ?? null,
    lowestTrueCost: lowest?.trueCost ?? null,
    lowestOneOffs: lowest?.oneOffs ?? null,
    totalOneOffs,
    floor: core.keepLightsOnForMonth(floorMonth),
  };
}

// The Slice & dice category pivot recomposed locally from core
// primitives, exactly as getExplorer and the Year Summary's top
// categories run it: monthly bills at versionInEffect amounts,
// smoothed bills at core.billMonthlyAccrual, grouped by category,
// plus the "Everything else" residual (True cost − pivot total)
// competing in the same sort (total desc, label tie-break).
// Category assignments for the synthetic bills (the core dataset
// carries no categories, so the fixture states them here):
// monthly — Rent → Housing, Gym → Health; smoothed — AnnualSub →
// Subscriptions, SemiIns → Insurance, QuarterFee → Fees, BiWater
// → Utilities, LateStart → Subscriptions.
const MONTHLY_CATEGORY: Record<number, string> = { 1: "Housing", 2: "Health" };
const YEARLY_CATEGORY: Record<number, string> = {
  1: "Subscriptions",
  2: "Insurance",
  3: "Fees",
  4: "Utilities",
  5: "Subscriptions",
};
function categoryPivot(
  core: SpendingCore,
  months: string[],
  totalTrueCost: number,
) {
  const groupMap = new Map<string, number>();
  const addTo = (label: string, cents: number) =>
    groupMap.set(label, (groupMap.get(label) ?? 0) + cents);
  for (const b of BILLS) {
    const label = MONTHLY_CATEGORY[b.id] ?? "Uncategorized";
    for (const m of months) {
      addTo(
        label,
        versionInEffect(core.versionsByBill.get(b.id) ?? [], m)?.amountCents ?? 0,
      );
    }
  }
  for (const y of YEARLY) {
    const label = YEARLY_CATEGORY[y.id] ?? "Uncategorized";
    for (const m of months) addTo(label, core.billMonthlyAccrual(y, m));
  }
  const rows = [...groupMap.entries()].map(([label, totalCents]) => ({ label, totalCents }));
  const pivotTotal = rows.reduce((s, r) => s + r.totalCents, 0);
  rows.push({ label: "Everything else", totalCents: totalTrueCost - pivotTotal });
  rows.sort((a, b) => b.totalCents - a.totalCents || a.label.localeCompare(b.label));
  return { rows, pivotTotal, residual: totalTrueCost - pivotTotal };
}

// One multi-year trend row, recomposed exactly as the action
// computes it: the year's window (Jan–Dec for a past year,
// Jan–current month for the current year), monthHasData + eff
// for spending, and snapshotTotals first→last anchors for NW —
// change null with fewer than two snapshots, ending null with
// none.
function trendRow(core: SpendingCore, year: number, includeProperty: boolean) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonthStr = `${currentYear}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const windowEnd = year === currentYear ? currentMonthStr : `${year}-12`;
  let months = 0;
  let trueCost = 0;
  for (let n = 1; n <= 12; n++) {
    const m = `${year}-${String(n).padStart(2, "0")}`;
    if (m > windowEnd) continue;
    if (!core.monthHasData(m)) continue;
    months += 1;
    trueCost += core.eff(m).smoothed;
  }
  const snaps = NW_SNAPSHOTS.filter((s) => s.date.startsWith(`${year}-`));
  const first = snaps[0] ?? null;
  const last = snaps[snaps.length - 1] ?? null;
  const totalOf = (id: number) =>
    snapshotTotals(NW_BALANCES[id] ?? [], NW_CLASS_BY_ID, includeProperty).totalCents;
  return {
    monthsWithData: months,
    trueCostCents: months > 0 ? trueCost : null,
    nwChangeCents:
      first != null && last != null && first.id !== last.id
        ? totalOf(last.id) - totalOf(first.id)
        : null,
    nwEndingCents: last != null ? totalOf(last.id) : null,
  };
}

// The Net Worth chart's Growth transform, stated exactly as the
// view defines it (client/src/NetWorth.tsx): each point's growth
// is its level minus the FIRST point's level for that same series;
// a null level gives null growth, and a series whose first level
// is null has null growth at every point. The levels fed to it in
// the growth case below come from the nwCore primitives on the
// synthetic dataset, exactly as the chart's levels do.
function growthSeries(levels: (number | null)[]): (number | null)[] {
  const baseline = levels[0] ?? null;
  return levels.map((v) => (v == null || baseline == null ? null : v - baseline));
}

// The chart headline annotation's displayed-figure arithmetic,
// stated exactly as the view defines it: round the first and last
// totals to whole dollars, change = last − first in whole
// dollars, percent = change / first × 100 to one decimal (pinned
// here in tenths of a percent so the record stays integral). The
// percent is null — shown as no percent — for a single snapshot
// or a first displayed total of $0.
function annotationFigures(
  firstCents: number,
  lastCents: number,
  snapshotCount: number,
): { firstDollars: number; lastDollars: number; changeDollars: number; pctTenths: number | null } {
  const firstDollars = Math.round(firstCents / 100);
  const lastDollars = Math.round(lastCents / 100);
  const changeDollars = lastDollars - firstDollars;
  return {
    firstDollars,
    lastDollars,
    changeDollars,
    pctTenths:
      snapshotCount < 2 || firstDollars === 0
        ? null
        : Math.round((changeDollars / firstDollars) * 100 * 10),
  };
}

/* ---------------- Restore (cluster A) synthetic payloads ----------------
   A small prior dataset and a minimal valid backup payload, both
   plain synthetic data. The restore cases run the REAL flow the
   restorebackup handler runs — backupPayload parse (with the
   legacy defaults), preflightRestoreBackup, buildRestorePlan,
   and the atomic plan executor from server/src/restoreCore.ts —
   over this in-memory state, never the user's data. */

function restorePriorState(): RestoreState {
  const state = {
    nwBalances: [],
    nwSnapshots: [],
    nwAccounts: [],
    transactions: [],
    yearlyExpenseVersions: [],
    monthlyBillVersions: [],
    monthlyOneOffs: [],
    monthlyCashOutItems: [],
    monthlySummaries: [],
    monthlyBills: [],
    yearlyExpenses: [],
    settings: [],
  } as unknown as RestoreState;
  state.settings.push({ key: "nw_target_cents", value: "99900" });
  state.nwAccounts.push({
    id: 9, name: "Prior Brokerage", bucket: "Unbucketed",
    propertyKind: "none", custodial: 0, sortOrder: 0, archived: 0,
    createdAt: 1700000000000,
  });
  state.nwSnapshots.push({ id: 9, date: "2024-06-01", note: null, createdAt: 1700000000000 });
  state.nwBalances.push({
    id: 9, snapshotId: 9, accountId: 9, balanceCents: 11100,
    splitHsaCents: null, splitRothCents: null, splitTaxableCents: null,
    splitNonTaxableCents: null, split529Cents: null, splitCashCents: null,
    splitPreTaxCents: null,
  });
  return state;
}

function baseRestorePayload(): Record<string, unknown> {
  return {
    format: "monthly-spending-tracker-backup",
    schemaVersion: 1,
    exportedAt: "2025-02-01T00:00:00.000Z",
    yearlyExpenses: [],
    yearlyExpenseVersions: [],
    transactions: [],
    monthlySummaries: [],
    monthlyBills: [],
    monthlyBillVersions: [],
    monthlyOneOffs: [],
    monthlyCashOutItems: [],
    nwAccounts: [
      {
        id: 1, name: "Brokerage", bucket: "Unbucketed",
        propertyKind: "none", custodial: 0, sortOrder: 0, archived: 0,
        createdAt: 1700000000000,
      },
    ],
    nwSnapshots: [{ id: 1, date: "2025-01-15", note: null, createdAt: 1700000000000 }],
    nwBalances: [
      {
        id: 1, snapshotId: 1, accountId: 1, balanceCents: 30000,
        splitHsaCents: null, splitRothCents: null, splitTaxableCents: null,
        splitNonTaxableCents: null, split529Cents: null, splitCashCents: null,
        splitPreTaxCents: null,
      },
    ],
    settings: [{ key: BACKUP_KEY_CHECK_SETTING, value: BACKUP_KEY_CHECK_PLAINTEXT }],
  };
}

// The payload key-check evaluation, on the plaintext path current
// exports use (the handler's ciphertext path reaches the same
// boolean): no key-check setting -> null, the known constant ->
// true, anything else -> false.
function restoreKeyCheckValidFor(raw: unknown): boolean | null {
  const parsed = backupPayload.safeParse(raw);
  if (!parsed.success) return null;
  const value = payloadKeyCheckValue(parsed.data);
  if (value == null) return null;
  return value === BACKUP_KEY_CHECK_PLAINTEXT;
}

// The base payload SIGNED, exactly as exportbackup now writes it:
// the MAC is computed over the payload's contents (the field
// itself excluded) and attached as authenticityMac
// (backupMacCore.computeBackupMac — the same call
// buildBackupPayload makes).
function macdRestorePayload(): Record<string, unknown> {
  const raw = baseRestorePayload();
  raw.authenticityMac = computeBackupMac(raw);
  return raw;
}

// The authenticity verdict as a fixture number: verified 2,
// absent (no MAC) 1, mismatch 0.
function authenticityCode(a: BackupAuthenticity): number {
  return a === "verified" ? 2 : a === "absent" ? 1 : 0;
}

/* ------------- Backup isolation (cluster B) synthetic layout -------------
   Two synthetic spaces under one workspace, plus the legacy shared
   folder, modelled as in-memory file maps (name -> content +
   modifiedMs) — no disk is touched. Every operation runs through
   the SAME backupCore rules the privileged handlers execute:
   writes land in the calling space's own folder
   (perSpaceBackupsDir), listings are mergeBackupListings(own,
   legacy), and delete / delete-all / prune apply the plan*
   functions to the own listing only. Byte-identical checks compare
   a folder snapshot (names, contents, timestamps) taken before an
   operation with the folder afterwards. */

const BK_SPACE_A = "/synthetic/workspace/ts-spaces/space-a";
const BK_SPACE_B = "/synthetic/workspace/ts-spaces/space-b";
const BK_LEGACY_DIR = "/synthetic/workspace/spending-tracker-backups";

type BkFile = { content: string; modifiedMs: number };
type BkWorld = {
  ownA: Map<string, BkFile>;
  ownB: Map<string, BkFile>;
  legacy: Map<string, BkFile>;
};

function bkWorld(): BkWorld {
  return {
    ownA: new Map(),
    ownB: new Map(),
    legacy: new Map<string, BkFile>([
      ["backup-2026-10-12.mstbak", { content: "legacy-backup-2026-10-12", modifiedMs: 1000 }],
      ["backup-2026-10-18.mstbak", { content: "legacy-backup-2026-10-18", modifiedMs: 2000 }],
      // A non-backup file that also lives in the legacy folder:
      // it must never be listed, counted, or touched.
      ["mst-crypt2.mjs", { content: "offline-decrypt-script", modifiedMs: 500 }],
    ]),
  };
}

function bkEntries(m: Map<string, BkFile>): BackupFileEntry[] {
  return [...m.entries()].map(([name, f]) => ({
    name,
    sizeBytes: f.content.length,
    modifiedMs: f.modifiedMs,
  }));
}

function bkOwn(w: BkWorld, space: "A" | "B"): Map<string, BkFile> {
  return space === "A" ? w.ownA : w.ownB;
}

function bkList(w: BkWorld, space: "A" | "B"): BackupFileEntry[] {
  return mergeBackupListings(bkEntries(bkOwn(w, space)), bkEntries(w.legacy));
}

// Create, exactly as the privileged handler does: choose the name
// against the own folder only, write there, then prune the own
// folder to the newest BACKUP_KEEP_NEWEST.
function bkCreate(
  w: BkWorld,
  space: "A" | "B",
  datePart: string,
  timePart: string,
  content: string,
  modifiedMs: number,
): { filename: string; pruned: number } {
  const own = bkOwn(w, space);
  const filename = chooseBackupFilename(
    new Set(own.keys()),
    datePart,
    timePart,
  );
  own.set(filename, { content, modifiedMs });
  const victims = planPruneBackups(bkEntries(own));
  for (const name of victims) own.delete(name);
  return { filename, pruned: victims.length };
}

function bkDeleteOne(
  w: BkWorld,
  space: "A" | "B",
  name: string,
): { ok: boolean } {
  const own = bkOwn(w, space);
  const plan = planDeleteBackup(name, bkEntries(own), bkEntries(w.legacy));
  if (plan.ok) own.delete(name);
  return { ok: plan.ok };
}

function bkDeleteAll(w: BkWorld, space: "A" | "B"): number {
  const own = bkOwn(w, space);
  const names = planDeleteAllBackups(bkEntries(own));
  for (const name of names) own.delete(name);
  return names.length;
}

// 1 when the folder still holds exactly the snapshot's files, each
// byte-identical (same content, same modifiedMs); 0 otherwise.
function bkFolderIntact(
  m: Map<string, BkFile>,
  snapshot: Map<string, BkFile>,
): number {
  if (m.size !== snapshot.size) return 0;
  for (const [name, f] of snapshot) {
    const now = m.get(name);
    if (!now || now.content !== f.content || now.modifiedMs !== f.modifiedMs)
      return 0;
  }
  return 1;
}

function bkSnapshot(m: Map<string, BkFile>): Map<string, BkFile> {
  return new Map([...m.entries()].map(([k, v]) => [k, { ...v }]));
}

/* ------------- Net Worth snapshot writes (cluster C) -------------
   A small in-memory Net Worth write world: the shared NW_ACCOUNTS
   plus a sixth ordinary account (Savings, so a valid payload can
   carry an unrecorded entry alongside whole and split balances),
   and one prior snapshot (id 10, 2025-03-01) holding Brokerage
   $111.00 and Old 401k $222.00. Every case runs the REAL flow the
   add/update handlers run — validateNwSnapshotPayload,
   resolveNwSnapshotRows, buildNwSnapshotWritePlan, and the atomic
   plan executor from server/src/nwCore.ts (attemptNwSnapshotWrite
   composes exactly those) — over this state, never the user's
   data. */

const NW_WRITE_ACCOUNTS = [
  ...NW_ACCOUNTS,
  { id: 6, name: "Savings", propertyKind: "none" },
];
const NW_WRITE_CLASS_BY_ID = classByIdOf(NW_WRITE_ACCOUNTS);
const NW_WRITE_ACCOUNT_LIST = NW_WRITE_ACCOUNTS.map((a) => ({
  id: a.id,
  name: a.name,
}));

function nwWritePriorState(): NwWriteState {
  return {
    snapshots: [{ id: 10, date: "2025-03-01", note: "prior" }],
    balances: [
      { snapshotId: 10, ...bal(1, 11100) },
      { snapshotId: 10, ...bal(4, 22200) },
    ],
  };
}

/* ------------- Clear-all-data (cluster D) synthetic state -------------
   A small dataset with rows in all twelve tables the clearAllData
   wipe deletes. The settings table is seeded with rows standing in
   for the saved planner data — the Retirement calculator record
   and baseline, the Roth plan record, and the Roth UI state —
   alongside an ordinary setting (the NW target) and the encryption
   key-check row: 18 rows in total (2 transactions, 1 in each of the
   other nine data tables, 6 settings). Every case runs the REAL
   flow the handler runs — the confirmation gate and the ordered
   wipe plan from server/src/clearDataCore.ts (attemptClearAllData
   composes exactly those) — over this in-memory state, never the
   user's data. */

function clearAllPriorState(): ClearAllState {
  const state = emptyClearAllState();
  state.transactions.push({ id: 1 }, { id: 2 });
  state.yearlyExpenseVersions.push({ id: 1 });
  state.yearlyExpenses.push({ id: 1 });
  state.monthlySummaries.push({ month: "2025-01" });
  state.monthlyBillVersions.push({ id: 1 });
  state.monthlyBills.push({ id: 1 });
  state.monthlyOneOffs.push({ id: 1 });
  state.monthlyCashOutItems.push({ id: 1 });
  state.nwBalances.push({ id: 1 });
  state.nwSnapshots.push({ id: 1 });
  state.nwAccounts.push({ id: 1 });
  state.settings.push(
    { key: BACKUP_KEY_CHECK_SETTING, value: BACKUP_KEY_CHECK_PLAINTEXT },
    { key: "nw_target_cents", value: "600000000" },
    { key: "retirement_calc_inputs_v1", value: "synthetic-retirement-record" },
    { key: "retirement_calc_baseline_v1", value: "synthetic-retirement-baseline" },
    { key: "roth_conversion_inputs_v1", value: "synthetic-roth-plan-record" },
    { key: ROTH_UI_STATE_KEY, value: "synthetic-roth-ui-state" },
  );
  return state;
}

function clearAllTotalRows(state: ClearAllState): number {
  return CLEAR_ALL_WIPE_ORDER.reduce((n, t) => n + state[t].length, 0);
}

function clearAllEmptyTables(state: ClearAllState): number {
  return CLEAR_ALL_WIPE_ORDER.filter((t) => state[t].length === 0).length;
}

/* ------------- Reserved enc-prefix guard (cluster E) -------------
   The fixture verifier for the shared text-store decision: a value
   is verifiable ciphertext exactly when it is a model ciphertext
   (ENC_PREFIX + "model:" + plain). In production the verifier is a
   real AES decrypt attempt under the request key; the decision it
   feeds — planTextStore in server/src/encPrefixCore.ts — is the
   same one the handlers execute. */

function isModelCiphertext(value: string): boolean {
  return value.startsWith(`${ENC_PREFIX}model:`);
}

/* ------------------------- The cases ------------------------- */

export type ExtendedFixtureCase = {
  id: string;
  kind: "spending" | "networth" | "yearsummary" | "restore" | "backup" | "cleardata" | "encguard" | "apicontract";
  note: string;
  expected: Record<string, number | null>;
  actual: (w: World) => Record<string, number | null>;
};

const billById = (id: number) => YEARLY.find((y) => y.id === id) as CoreYearlyBillNamed;

export const EXTENDED_FIXTURES: ExtendedFixtureCase[] = [
  {
    id: "sp-accrual-all-frequencies",
    kind: "spending",
    note: "Jan 2025: each of the yearly/semiannual/quarterly/bimonthly bills annualises to $1,200.00 (per-bill × payments/yr), so the total is $4,800.00 and the set-aside $400.00; each bill's own monthly set-aside is $100.00.",
    expected: { totalAnnual: 480000, accrual: 40000, bill1: 10000, bill2: 10000, bill3: 10000, bill4: 10000 },
    actual: (w) => ({
      totalAnnual: w.core.totalAnnualForMonth("2025-01"),
      accrual: w.core.accrualForMonth("2025-01"),
      bill1: w.core.billMonthlyAccrual(billById(1), "2025-01"),
      bill2: w.core.billMonthlyAccrual(billById(2), "2025-01"),
      bill3: w.core.billMonthlyAccrual(billById(3), "2025-01"),
      bill4: w.core.billMonthlyAccrual(billById(4), "2025-01"),
    }),
  },
  {
    id: "sp-accrual-per-bill-rounding",
    kind: "spending",
    note: "Rounding pin: three yearly bills of $100.00 each. Per-bill monthly set-aside = round($100.00 / 12) = $8.33, so the month's set-aside is $8.33 × 3 = $24.99. The old annual-once method — round($300.00 / 12) = $25.00 — diverged by 1¢; the dashboard accrual must be the sum of the per-bill rounded set-asides the cards show.",
    expected: { totalAnnual: 30000, accrual: 2499, billMonthly: 833 },
    actual: () => {
      const bills3: CoreYearlyBillNamed[] = [1, 2, 3].map((id) => ({
        id,
        name: `Round${id}`,
        frequency: "yearly",
        expectedCents: 10000,
        dueMonth: 1,
        backfillBeforeFirstVersion: 0,
        keepLightsOn: 0,
      }));
      const versions3: CoreYearlyVersion[] = bills3.map((b, i) => ({
        id: 100 + i,
        expenseId: b.id,
        effectiveFrom: "2024-11",
        expectedCents: 10000,
        frequency: "yearly",
      }));
      const c = createSpendingCore({
        txns: [],
        yearly: bills3,
        yearlyVersions: versions3,
        summaries: [],
        cashOutItems: [],
        bills: [],
        billVersions: [],
        oneOffs: [],
        openingReserveCents: 0,
        reserveStartSetting: null,
      });
      const first = bills3[0] as CoreYearlyBillNamed;
      return {
        totalAnnual: c.totalAnnualForMonth("2025-01"),
        accrual: c.accrualForMonth("2025-01"),
        billMonthly: c.billMonthlyAccrual(first, "2025-01"),
      };
    },
  },
  {
    id: "sp-late-start-bill-zero-before-start",
    kind: "spending",
    note: "LateStart's only version starts Mar 2025: it contributes $0 in Feb (annualised still $4,800.00) and its full $2,400.00/yr from Mar (total $7,200.00, set-aside $600.00, its own set-aside $200.00).",
    expected: { febAnnual: 480000, marAnnual: 720000, marAccrual: 60000, y5Feb: 0, y5Mar: 20000 },
    actual: (w) => ({
      febAnnual: w.core.totalAnnualForMonth("2025-02"),
      marAnnual: w.core.totalAnnualForMonth("2025-03"),
      marAccrual: w.core.accrualForMonth("2025-03"),
      y5Feb: w.core.billMonthlyAccrual(billById(5), "2025-02"),
      y5Mar: w.core.billMonthlyAccrual(billById(5), "2025-03"),
    }),
  },
  {
    id: "sp-txn-month-eff",
    kind: "spending",
    note: "Jan 2025 (transactions basis): incurred = $500.00 spending + $200.00 BiWater + $300.00 card-paid QuarterFee = $1,000.00; lumps = the two linked payments $500.00; cash out counts checking only = $700.00 (the card charge is not cash out); smoothed = 1000 − 500 + 400 set-aside = $900.00.",
    expected: { incurred: 100000, cashOut: 70000, lumps: 50000, smoothed: 90000 },
    actual: (w) => {
      const e = w.core.eff("2025-01");
      return { incurred: e.incurred, cashOut: e.cashOut, lumps: e.lumps, smoothed: e.smoothed };
    },
  },
  {
    id: "sp-summary-month-lump-fallback",
    kind: "spending",
    note: "Feb 2025 (entered total $9,000.00): the total is the base — the month's transactions are not added. Only the checking lump inside it (AnnualSub's early $1,200.00 payment) is subtracted; Feb's $300.00 card payment is not a lump. Smoothed = 9000 − 1200 + 400 = $8,200.00.",
    expected: { incurred: 900000, cashOut: 900000, lumps: 120000, smoothed: 820000 },
    actual: (w) => {
      const e = w.core.eff("2025-02");
      return { incurred: e.incurred, cashOut: e.cashOut, lumps: e.lumps, smoothed: e.smoothed };
    },
  },
  {
    id: "sp-items-beat-summary-same-month",
    kind: "spending",
    note: "Mar 2025 has items ($3,000.00 + $1,500.00) AND an entered total ($9,999.99): the items win — base $4,500.00. SemiIns's late $600.00 checking payment is the lump; smoothed = 4500 − 600 + 600 set-aside (LateStart now in effect) = $4,500.00.",
    expected: { incurred: 450000, cashOut: 450000, lumps: 60000, smoothed: 450000 },
    actual: (w) => {
      const e = w.core.eff("2025-03");
      return { incurred: e.incurred, cashOut: e.cashOut, lumps: e.lumps, smoothed: e.smoothed };
    },
  },
  {
    id: "sp-one-off-excluded",
    kind: "spending",
    note: "Jan 2025's $777.00 one-off is already inside the month's spending; smoothed excluding one-offs = $900.00 − $777.00 = $123.00 (the one-off is subtracted once, never added).",
    expected: { oneOffTotal: 77700, smoothedExcl: 12300 },
    actual: (w) => ({
      oneOffTotal: w.core.oneOffTotalForMonth("2025-01"),
      smoothedExcl: w.core.eff("2025-01").smoothed - w.core.oneOffTotalForMonth("2025-01"),
    }),
  },
  {
    id: "sp-reserve-accumulation",
    kind: "spending",
    note: "Reserve from Jan 2025 (opening $0): Jan +400 set-aside − 500 lumps = −$100.00; Feb + 400 − 1,200 (the early AnnualSub payment, on the summary month's checking-lumps basis) = −$900.00; Mar + 600 − 600 (SemiIns's late payment) = −$900.00.",
    expected: { startMonth: 202501, jan: -10000, feb: -90000, mar: -90000 },
    actual: (w) => ({
      startMonth: w.core.reserveStartMonth ? Number(w.core.reserveStartMonth.replace("-", "")) : null,
      jan: w.core.reserveThrough("2025-01"),
      feb: w.core.reserveThrough("2025-02"),
      mar: w.core.reserveThrough("2025-03"),
    }),
  },
  {
    id: "sp-forecast-card-and-late-payments",
    kind: "spending",
    note: "Forecast viewed from Jan 2025. Jan: QuarterFee due — its recorded card payment ($300.00) is the amount; BiWater due and paid ($200.00); total due $500.00, projected reserve = the calculated reserve −$100.00. Feb: SemiIns due, unpaid yet — expected $600.00; projected reserve −100 + 400 − 600 due − 1,200 (AnnualSub's early Feb payment for a bill not due in Feb) = −$1,500.00. Mar: AnnualSub due — expected $1,200.00 (its actual landed in Feb); BiWater due $200.00; projected reserve −1,500 + 600 − 1,400 due − 600 (SemiIns's late Mar payment, not due in Mar) = −$2,900.00.",
    expected: {
      janDue: 50000, janProjected: -10000, janY3Amount: 30000,
      febDue: 60000, febProjected: -150000, febY2Amount: 60000,
      marDue: 140000, marProjected: -290000, marY1Amount: 120000,
    },
    actual: (w) => {
      const [jan, feb, mar] = w.forecastJan;
      const dueAmt = (f: typeof jan, id: number) =>
        f?.dueBills.find((b) => b.id === id)?.amountCents ?? null;
      return {
        janDue: jan?.totalDueCents ?? null,
        janProjected: jan?.projectedReserveCents ?? null,
        janY3Amount: jan ? dueAmt(jan, 3) : null,
        febDue: feb?.totalDueCents ?? null,
        febProjected: feb?.projectedReserveCents ?? null,
        febY2Amount: feb ? dueAmt(feb, 2) : null,
        marDue: mar?.totalDueCents ?? null,
        marProjected: mar?.projectedReserveCents ?? null,
        marY1Amount: mar ? dueAmt(mar, 1) : null,
      };
    },
  },
  {
    id: "sp-monthly-total-and-klo",
    kind: "spending",
    note: "Monthly bills total $1,050.00 every month (Rent $1,000.00 + Gym $50.00). Keep the lights on = Rent $1,000.00 + QuarterFee's $100.00 set-aside = $1,100.00, in Jan and in Mar alike (LateStart is not a lights-on bill).",
    expected: { monthlyJan: 105000, kloJan: 110000, kloMar: 110000 },
    actual: (w) => ({
      monthlyJan: w.core.monthlyTotalForMonth("2025-01"),
      kloJan: w.core.keepLightsOnForMonth("2025-01"),
      kloMar: w.core.keepLightsOnForMonth("2025-03"),
    }),
  },
  {
    id: "sp-month-has-data-window",
    kind: "spending",
    note: "Month selection: Oct 2024 predates every bill version — no data. Nov 2024 (bills take effect) and Jun 2025 (bills in effect) count as data months even with no transactions.",
    expected: { oct2024: 0, nov2024: 1, jun2025: 1 },
    actual: (w) => ({
      oct2024: w.core.monthHasData("2024-10") ? 1 : 0,
      nov2024: w.core.monthHasData("2024-11") ? 1 : 0,
      jun2025: w.core.monthHasData("2025-06") ? 1 : 0,
    }),
  },
  {
    id: "nw-totals-property-off",
    kind: "networth",
    note: "Property off: snapshot totals are the non-property balances only — Dec 2024: $1,000,000.00 + $50,000.00 = $1,050,000.00; Jan 2025: $1,150,000.00; Feb 2025: $970,000.00.",
    expected: { s1: 105000000, s2: 115000000, s3: 97000000 },
    actual: () => ({
      s1: snapshotTotals(NW_BALANCES[1] ?? [], NW_CLASS_BY_ID, false).totalCents,
      s2: snapshotTotals(NW_BALANCES[2] ?? [], NW_CLASS_BY_ID, false).totalCents,
      s3: snapshotTotals(NW_BALANCES[3] ?? [], NW_CLASS_BY_ID, false).totalCents,
    }),
  },
  {
    id: "nw-totals-property-on",
    kind: "networth",
    note: "Property on: the house adds and the mortgage subtracts — Dec 2024: 1,050,000 + 500,000 − 200,000 = $1,350,000.00; Jan: $1,455,000.00; Feb: $1,290,000.00. Property net (reported either way): $300,000.00 / $305,000.00 / $320,000.00.",
    expected: { s1: 135000000, s2: 145500000, s3: 129000000, net1: 30000000, net2: 30500000, net3: 32000000 },
    actual: () => ({
      s1: snapshotTotals(NW_BALANCES[1] ?? [], NW_CLASS_BY_ID, true).totalCents,
      s2: snapshotTotals(NW_BALANCES[2] ?? [], NW_CLASS_BY_ID, true).totalCents,
      s3: snapshotTotals(NW_BALANCES[3] ?? [], NW_CLASS_BY_ID, true).totalCents,
      net1: snapshotTotals(NW_BALANCES[1] ?? [], NW_CLASS_BY_ID, true).propertyNetCents,
      net2: snapshotTotals(NW_BALANCES[2] ?? [], NW_CLASS_BY_ID, true).propertyNetCents,
      net3: snapshotTotals(NW_BALANCES[3] ?? [], NW_CLASS_BY_ID, true).propertyNetCents,
    }),
  },
  {
    id: "nw-split-parts-sum-to-balance",
    kind: "networth",
    note: "Every split balance's parts sum exactly to its balance (Brokerage in all three snapshots, e.g. Feb 2025: Roth $400,000.00 + Taxable $500,000.00 = the $900,000.00 balance); unsplit balances have no parts.",
    expected: { splitBalancesChecked: 3, mismatches: 0, febPartsSum: 90000000, febBalance: 90000000 },
    actual: () => {
      let checked = 0;
      let mismatches = 0;
      for (const bals of Object.values(NW_BALANCES)) {
        for (const b of bals) {
          const parts = splitPartsOf(b);
          if (parts.length === 0) continue;
          checked += 1;
          if (parts.reduce((s, p) => s + p.amountCents, 0) !== b.balanceCents) mismatches += 1;
        }
      }
      const feb = (NW_BALANCES[3] ?? []).find((b) => b.accountId === 1);
      return {
        splitBalancesChecked: checked,
        mismatches,
        febPartsSum: feb ? splitPartsOf(feb).reduce((s, p) => s + p.amountCents, 0) : null,
        febBalance: feb?.balanceCents ?? null,
      };
    },
  },
  {
    id: "nw-bucket-subtotals",
    kind: "networth",
    note: "Bucket subtotals skip property accounts entirely: Feb 2025 — Roth $400,000.00, Taxable $500,000.00 (the split parts), Unbucketed $70,000.00 (the unsplit Old 401k), and HSA / Cash have no contribution (null, not $0). Dec 2024 — Taxable $600,000.00, Unbucketed $50,000.00.",
    expected: { febRoth: 40000000, febTaxable: 50000000, febUnbucketed: 7000000, febHsa: null, febCash: null, decTaxable: 60000000, decUnbucketed: 5000000 },
    actual: () => {
      const feb = bucketSubtotals(NW_BALANCES[3] ?? [], NW_CLASS_BY_ID);
      const dec = bucketSubtotals(NW_BALANCES[1] ?? [], NW_CLASS_BY_ID);
      return {
        febRoth: feb.Roth,
        febTaxable: feb.Taxable,
        febUnbucketed: feb.Unbucketed,
        febHsa: feb.HSA,
        febCash: feb.Cash,
        decTaxable: dec.Taxable,
        decUnbucketed: dec.Unbucketed,
      };
    },
  },
  {
    id: "nw-snapshot-totals-split-authoritative",
    kind: "networth",
    note: "E4 remainder — the Net Worth totals-definition alignment (engine-correctness cluster, 2026-10-19): one ordinary balance row (Old 401k) whose stored balanceCents ($500.00) disagrees with its split (Taxable $200.00 + Roth $100.00 = $300.00) — a state the writers can no longer produce (nwBalanceRowValues recomputes the stored balance from the parts, and the restore preflight normalises the same way), but a pre-cluster-A restore could leave behind. The split is authoritative — the rule bucketSubtotals has always applied — so snapshotTotals must read the row at $300.00 with the property toggle off AND on, agreeing with the sum of the bucket subtotals to the cent and leaving $0 Unbucketed. Pre-E4, snapshotTotals summed the stored balanceCents unconditionally and read $500.00 for the same row the subtotals read as $300.00: one row, two totals. Hand-derived from the row above.",
    expected: {
      splitRowTotal: 30000,
      splitRowTotalPropertyOn: 30000,
      bucketSum: 30000,
      unbucketed: 0,
      totalsAgree: 1,
    },
    actual: () => {
      const row: CoreNwBalance = {
        accountId: 4,
        balanceCents: 50000,
        splitHsaCents: null,
        splitRothCents: 10000,
        splitTaxableCents: 20000,
        splitNonTaxableCents: null,
        split529Cents: null,
        splitCashCents: null,
        splitPreTaxCents: null,
      };
      const off = snapshotTotals([row], NW_CLASS_BY_ID, false);
      const on = snapshotTotals([row], NW_CLASS_BY_ID, true);
      const subs = bucketSubtotals([row], NW_CLASS_BY_ID);
      const bucketSum = Object.values(subs).reduce(
        (acc: number, v) => acc + (v ?? 0),
        0,
      );
      return {
        splitRowTotal: off.totalCents,
        splitRowTotalPropertyOn: on.totalCents,
        bucketSum,
        unbucketed: subs.Unbucketed ?? 0,
        totalsAgree: off.totalCents === bucketSum ? 1 : 0,
      };
    },
  },
  {
    id: "nw-future-date-guard",
    kind: "networth",
    note: "Future-date guard pin: against a fixed today of 2026-10-12, a snapshot dated 2026-10-13 (tomorrow) is future (refused), 2026-10-12 (today) is not, and 2026-10-11 (yesterday) is not. todayDateString formats the server's local calendar date as YYYY-MM-DD (2026-01-05 for Jan 5, 2026), matching the app's date-string convention.",
    expected: { tomorrowIsFuture: 1, todayIsFuture: 0, yesterdayIsFuture: 0, formatted: 20260105 },
    actual: () => ({
      tomorrowIsFuture: isFutureSnapshotDate("2026-10-13", "2026-10-12") ? 1 : 0,
      todayIsFuture: isFutureSnapshotDate("2026-10-12", "2026-10-12") ? 1 : 0,
      yesterdayIsFuture: isFutureSnapshotDate("2026-10-11", "2026-10-12") ? 1 : 0,
      formatted: Number(todayDateString(new Date(2026, 0, 5)).replace(/-/g, "")),
    }),
  },
  {
    id: "nw-pretax-bucket-subtotal",
    kind: "networth",
    note: "Pre-tax (7th split bucket): a $250,000.00 balance split Pre-tax $200,000.00 + Roth $50,000.00 reports Pre-tax $200,000.00 and Roth $50,000.00, Taxable null (no contribution); the parts still sum to the balance. An unsplit balance contributes nothing to Pre-tax (null) and its whole amount to Unbucketed.",
    expected: { preTax: 20000000, roth: 5000000, taxable: null, partsSum: 25000000, unsplitPreTax: null, unsplitUnbucketed: 8000000 },
    actual: () => {
      const splitBal: CoreNwBalance = {
        accountId: 1,
        balanceCents: 25000000,
        splitHsaCents: null,
        splitRothCents: 5000000,
        splitTaxableCents: null,
        splitNonTaxableCents: null,
        split529Cents: null,
        splitCashCents: null,
        splitPreTaxCents: 20000000,
      };
      const unsplitBal: CoreNwBalance = {
        accountId: 4,
        balanceCents: 8000000,
        splitHsaCents: null,
        splitRothCents: null,
        splitTaxableCents: null,
        splitNonTaxableCents: null,
        split529Cents: null,
        splitCashCents: null,
        splitPreTaxCents: null,
      };
      const subs = bucketSubtotals([splitBal], NW_CLASS_BY_ID);
      const subsUnsplit = bucketSubtotals([unsplitBal], NW_CLASS_BY_ID);
      return {
        preTax: subs["Pre-tax"],
        roth: subs.Roth,
        taxable: subs.Taxable,
        partsSum: splitPartsOf(splitBal).reduce((s, p) => s + p.amountCents, 0),
        unsplitPreTax: subsUnsplit["Pre-tax"],
        unsplitUnbucketed: subsUnsplit.Unbucketed,
      };
    },
  },
  {
    id: "ys-2025-spending",
    kind: "yearsummary",
    note: "2025 spending over all 12 data months (the monthly bills make every month a data month): True cost = Jan $900.00 + Feb $8,200.00 + Mar $4,500.00 + 9 accrual-only months × $600.00 = $19,000.00; cash out = $700.00 + $9,000.00 + $4,500.00 = $14,200.00; average = 19000/12 rounded = $1,583.33. Scope endpoints: January (1) through December (12).",
    expected: { months: 12, trueCost: 1900000, cashOut: 1420000, average: 158333, firstMonthNum: 1, lastMonthNum: 12 },
    actual: (w) => yearSpending(w.core, 2025),
  },
  {
    id: "ys-2024-spending-partial-year",
    kind: "yearsummary",
    note: "2024 has data only in Nov and Dec (bills take effect in Nov): each is an accrual-only month at the $400.00 set-aside, so True cost $800.00 over 2 months, cash out $0.00, average $400.00. Scope endpoints: November (11) through December (12).",
    expected: { months: 2, trueCost: 80000, cashOut: 0, average: 40000, firstMonthNum: 11, lastMonthNum: 12 },
    actual: (w) => yearSpending(w.core, 2024),
  },
  {
    id: "ys-excluded-payments-after-last-month",
    kind: "yearsummary",
    note: "Excluded-payments footnote pin (the core aggregation the action runs): recorded smoothed-bill payments are the spending transactions linked to a yearly bill — Jan 2025 has BiWater $200.00 + QuarterFee $300.00, Feb has AnnualSub's early $1,200.00, Mar has SemiIns's late $600.00. With the totals' last included month at Feb 2025 (the current-year window shape: the window ends before later recorded payments), only March's $600.00 (1 payment) is excluded; with it at Jan, Feb + Mar = $1,800.00 over 2 payments in 2 months; with it at Dec, nothing is excluded. Unlinked spending (Jan's $500.00) and the Feb card payment are never counted as payments.",
    expected: {
      afterFebMonths: 1, afterFebTotal: 60000, afterFebCount: 1, afterFebMonthNum: 3,
      afterJanTotal: 180000, afterJanCount: 2, afterJanMonths: 2,
      afterDecTotal: 0, janPayments: 50000, janPaymentCount: 2,
    },
    actual: (w) => {
      const afterFeb = w.core.recordedPaymentsAfter(2025, "2025-02");
      const afterJan = w.core.recordedPaymentsAfter(2025, "2025-01");
      const afterDec = w.core.recordedPaymentsAfter(2025, "2025-12");
      const jan = w.core.recordedPaymentsForMonth("2025-01");
      return {
        afterFebMonths: afterFeb.length,
        afterFebTotal: afterFeb.reduce((s, p) => s + p.totalCents, 0),
        afterFebCount: afterFeb.reduce((s, p) => s + p.count, 0),
        afterFebMonthNum: afterFeb[0]?.monthNum ?? null,
        afterJanTotal: afterJan.reduce((s, p) => s + p.totalCents, 0),
        afterJanCount: afterJan.reduce((s, p) => s + p.count, 0),
        afterJanMonths: afterJan.length,
        afterDecTotal: afterDec.reduce((s, p) => s + p.totalCents, 0),
        janPayments: jan.totalCents,
        janPaymentCount: jan.count,
      };
    },
  },
  {
    id: "ys-prior-year-anchor-reconciliation",
    kind: "yearsummary",
    note: "Change-anchor reconciliation pin: for 2025 (property off) the prior year's last snapshot is Dec 20, 2024 at $1,050,000.00. A year-to-date measured from that anchor gives last − prior = $970,000.00 − $1,050,000.00 = −$80,000.00, while the change for the year (first → last) is −$180,000.00; the two differ by exactly the movement between the anchors, first − prior = $1,150,000.00 − $1,050,000.00 = +$100,000.00. For 2024 there is no earlier snapshot (anchor null).",
    expected: {
      priorDateNum: 20241220, priorTotal: 105000000, movement: 10000000,
      ytdStyleChange: -8000000, changeForYear: -18000000, prior2024: null,
    },
    actual: () => {
      const prior = priorYearAnchor(2025, false);
      const yr = yearNetWorth(2025, false);
      return {
        priorDateNum: prior.dateNum,
        priorTotal: prior.total,
        movement:
          yr.first != null && prior.total != null ? yr.first - prior.total : null,
        ytdStyleChange:
          yr.last != null && prior.total != null ? yr.last - prior.total : null,
        changeForYear: yr.change,
        prior2024: priorYearAnchor(2024, false).total,
      };
    },
  },
  {
    id: "ys-2025-networth-dec-jan-boundary",
    kind: "yearsummary",
    note: "2025 Net Worth (property off) is measured from the first 2025 snapshot (Jan 15: $1,150,000.00) to the last (Feb 10: $970,000.00) — the Dec 2024 snapshot belongs to 2024, not to 2025's start. Change −$180,000.00 (−15.6522%). Movers: Old 401k +$20,000.00 first, Brokerage −$200,000.00 last; property accounts are excluded with the toggle off.",
    expected: {
      count: 2, first: 115000000, last: 97000000, change: -18000000, pctMicro: -156522,
      moversCount: 2, mover0Id: 4, mover0Change: 2000000, mover1Id: 1, mover1Change: -20000000,
      mover1Start: 110000000, mover1End: 90000000,
    },
    actual: () => {
      const r = yearNetWorth(2025, false);
      return {
        count: r.count,
        first: r.first,
        last: r.last,
        change: r.change,
        pctMicro: r.pctMicro,
        moversCount: r.movers.length,
        mover0Id: r.movers[0]?.accountId ?? null,
        mover0Change: r.movers[0]?.changeCents ?? null,
        mover1Id: r.movers[1]?.accountId ?? null,
        mover1Change: r.movers[1]?.changeCents ?? null,
        mover1Start: r.movers[1]?.startCents ?? null,
        mover1End: r.movers[1]?.endCents ?? null,
      };
    },
  },
  {
    id: "ys-2025-networth-property-on-movers",
    kind: "yearsummary",
    note: "Same year with property on: first $1,455,000.00 → last $1,290,000.00, change −$165,000.00, and the property accounts join the movers — House +$10,000.00, Mortgage +$5,000.00 (its balance fell, so its signed contribution rose), Old 401k +$20,000.00 on top, Brokerage −$200,000.00 at the bottom.",
    expected: {
      first: 145500000, last: 129000000, change: -16500000, moversCount: 4,
      chg1: -20000000, chg2: 1000000, chg3: 500000, chg4: 2000000, topMoverId: 4,
    },
    actual: () => {
      const r = yearNetWorth(2025, true);
      const byId = new Map(r.movers.map((m) => [m.accountId, m.changeCents]));
      return {
        first: r.first,
        last: r.last,
        change: r.change,
        moversCount: r.movers.length,
        chg1: byId.get(1) ?? null,
        chg2: byId.get(2) ?? null,
        chg3: byId.get(3) ?? null,
        chg4: byId.get(4) ?? null,
        topMoverId: r.movers[0]?.accountId ?? null,
      };
    },
  },
  {
    id: "ys-2024-networth-single-snapshot",
    kind: "yearsummary",
    note: "2024 has exactly one snapshot (Dec 20, $1,050,000.00 property off): first = last, change $0.00, and no movers — a single snapshot has nothing to compare.",
    expected: { count: 1, first: 105000000, last: 105000000, change: 0, moversCount: 0 },
    actual: () => {
      const r = yearNetWorth(2024, false);
      return { count: r.count, first: r.first, last: r.last, change: r.change, moversCount: r.movers.length };
    },
  },
  {
    id: "nw-custodial-totals-and-target-unchanged",
    kind: "networth",
    note: "Custodial exclusion, totals + target: Kid UTMA holds $25,000.00 / $30,000.00 / $27,500.00 across the three snapshots. Snapshot totals WITH the custodial balances equal the totals computed from the same snapshots with the custodial rows removed — property off ($1,050,000.00 / $1,150,000.00 / $970,000.00) and property on ($1,350,000.00 / $1,455,000.00 / $1,290,000.00) alike. The custodial subtotal is reported separately ($25,000.00 / $30,000.00 / $27,500.00) and added nowhere. Target progress on the latest snapshot against a $2,000,000.00 target is 48.5000% with the custodial account and without it alike.",
    expected: {
      off1: 105000000, off2: 115000000, off3: 97000000,
      on1: 135000000, on2: 145500000, on3: 129000000,
      diffOff: 0, diffOn: 0,
      cust1: 2500000, cust2: 3000000, cust3: 2750000,
      targetMicroWith: 485000, targetMicroWithout: 485000,
    },
    actual: () => {
      const without = (id: number) =>
        (NW_BALANCES[id] ?? []).filter((b) => b.accountId !== 5);
      const t = (id: number, on: boolean) =>
        snapshotTotals(NW_BALANCES[id] ?? [], NW_CLASS_BY_ID, on);
      const tw = (id: number, on: boolean) =>
        snapshotTotals(without(id), NW_CLASS_BY_ID, on);
      const target = 200000000;
      return {
        off1: t(1, false).totalCents,
        off2: t(2, false).totalCents,
        off3: t(3, false).totalCents,
        on1: t(1, true).totalCents,
        on2: t(2, true).totalCents,
        on3: t(3, true).totalCents,
        diffOff: t(3, false).totalCents - tw(3, false).totalCents,
        diffOn: t(3, true).totalCents - tw(3, true).totalCents,
        cust1: t(1, false).custodialTotalCents,
        cust2: t(2, false).custodialTotalCents,
        cust3: t(3, false).custodialTotalCents,
        targetMicroWith: Math.round((t(3, false).totalCents / target) * 1_000_000),
        targetMicroWithout: Math.round((tw(3, false).totalCents / target) * 1_000_000),
      };
    },
  },
  {
    id: "nw-custodial-no-bucket-and-nw-following-unchanged",
    kind: "networth",
    note: "Custodial exclusion, buckets + NW-following figures: in Feb 2025 the custodial $27,500.00 appears in NO bucket and NOT as Unbucketed — Roth $400,000.00, Taxable $500,000.00, Unbucketed stays the Old 401k's $70,000.00, every other bucket null; the buckets sum to the $970,000.00 snapshot total. The Retirement NW-following default (latest total − 529 subtotal; the 529 subtotal is null, so $0 excluded) and the Roth view's NW-following total are both $970,000.00 with the custodial account and with its rows removed.",
    expected: {
      roth: 40000000, taxable: 50000000, unbucketed: 7000000,
      hsa: null, cash: null, preTax: null, b529: null,
      bucketSum: 97000000, retirementDefault: 97000000,
      retirementDefaultWithout: 97000000, rothTotal: 97000000,
      rothTotalWithout: 97000000,
    },
    actual: () => {
      const feb = NW_BALANCES[3] ?? [];
      const febWithout = feb.filter((b) => b.accountId !== 5);
      const sub = bucketSubtotals(feb, NW_CLASS_BY_ID);
      const bucketSum = Object.values(sub).reduce<number>(
        (s, v) => s + (v ?? 0),
        0,
      );
      const totalWith = snapshotTotals(feb, NW_CLASS_BY_ID, false).totalCents;
      const totalWithout = snapshotTotals(febWithout, NW_CLASS_BY_ID, false)
        .totalCents;
      const sub529 = bucketSubtotals(feb, NW_CLASS_BY_ID)["529"];
      const sub529Without = bucketSubtotals(febWithout, NW_CLASS_BY_ID)["529"];
      return {
        roth: sub.Roth,
        taxable: sub.Taxable,
        unbucketed: sub.Unbucketed,
        hsa: sub.HSA,
        cash: sub.Cash,
        preTax: sub["Pre-tax"],
        b529: sub["529"],
        bucketSum,
        retirementDefault: totalWith - (sub529 ?? 0),
        retirementDefaultWithout: totalWithout - (sub529Without ?? 0),
        rothTotal: totalWith,
        rothTotalWithout: totalWithout,
      };
    },
  },
  {
    id: "ys-custodial-excluded-from-yearsummary",
    kind: "yearsummary",
    note: "Custodial exclusion, Year Summary: 2025 (property off) still measures first $1,150,000.00 → last $970,000.00, change −$180,000.00, with exactly the 2 non-property movers — Kid UTMA is NOT a mover even though its balance changed ($30,000.00 → $27,500.00). With property on: first $1,455,000.00 → last $1,290,000.00, change −$165,000.00, 4 movers, custodial still absent.",
    expected: {
      first: 115000000, last: 97000000, change: -18000000, moversCount: 2,
      custodialMoverOff: 0,
      firstOn: 145500000, lastOn: 129000000, changeOn: -16500000,
      moversCountOn: 4, custodialMoverOn: 0,
    },
    actual: () => {
      const off = yearNetWorth(2025, false);
      const on = yearNetWorth(2025, true);
      return {
        first: off.first,
        last: off.last,
        change: off.change,
        moversCount: off.movers.length,
        custodialMoverOff: off.movers.some((m) => m.accountId === 5) ? 1 : 0,
        firstOn: on.first,
        lastOn: on.last,
        changeOn: on.change,
        moversCountOn: on.movers.length,
        custodialMoverOn: on.movers.some((m) => m.accountId === 5) ? 1 : 0,
      };
    },
  },
  {
    id: "nw-custodial-backup-roundtrip",
    kind: "networth",
    note: "Backup round-trip pin, on the exact field mapping the export/restore actions use: an account exports as { propertyKind, custodial: 1|0 } and restores through the same classification. Kid UTMA exports custodial 1 with propertyKind \"none\" and restores as custodial with kind \"none\"; Brokerage exports custodial 0 and restores ordinary; the House exports custodial 0 and restores as a property asset (kind code 1). Kind codes: none = 0, asset = 1.",
    expected: {
      utmaExportedCustodial: 1, utmaExportedKind: 0,
      utmaRestoredCustodial: 1, utmaRestoredKind: 0,
      brokerageExportedCustodial: 0, brokerageRestoredCustodial: 0,
      houseExportedCustodial: 0, houseRestoredKind: 1,
    },
    actual: () => {
      const kindCode = (k: string) => (k === "asset" ? 1 : 0);
      const roundTrip = (id: number) => {
        const a = NW_ACCOUNTS.find((x) => x.id === id);
        if (!a) return { exportedCustodial: null, exportedKind: null, restoredCustodial: null, restoredKind: null };
        // The export mapping (actions.ts exportbackup).
        const exported = {
          propertyKind: propertyKindOf(a),
          custodial: isCustodialAccount(a) ? 1 : 0,
        };
        // The restore mapping (actions.ts restorebackup): the payload
        // fields are stored on the row, and a reload classifies the
        // row with these same helpers — so re-classifying the payload
        // IS the round trip.
        const restoredKind = propertyKindOf({ propertyKind: exported.propertyKind });
        const restoredCustodial = isCustodialAccount({ custodial: exported.custodial });
        return {
          exportedCustodial: exported.custodial,
          exportedKind: kindCode(exported.propertyKind),
          restoredCustodial: restoredCustodial ? 1 : 0,
          restoredKind: kindCode(restoredKind),
        };
      };
      const utma = roundTrip(5);
      const brokerage = roundTrip(1);
      const house = roundTrip(2);
      return {
        utmaExportedCustodial: utma.exportedCustodial,
        utmaExportedKind: utma.exportedKind,
        utmaRestoredCustodial: utma.restoredCustodial,
        utmaRestoredKind: utma.restoredKind,
        brokerageExportedCustodial: brokerage.exportedCustodial,
        brokerageRestoredCustodial: brokerage.restoredCustodial,
        houseExportedCustodial: house.exportedCustodial,
        houseRestoredKind: house.restoredKind,
      };
    },
  },
  {
    id: "ys-year-in-spending-aggregates",
    kind: "yearsummary",
    note: "Year-in-spending aggregates for 2025, derived BY HAND from the dataset's per-month True costs (ys-2025-spending): Jan $900.00, Feb $8,200.00, Mar $4,500.00, Apr–Dec $600.00 each. Highest is therefore February (month 2) at $8,200.00 with $0 one-offs; the lowest is the earliest of the nine tied $600.00 months, April (month 4), at $600.00 with $0 one-offs. The year's only one-off is January's $777.00, so totalOneOffs is $777.00. Floor at Dec 2025: Rent $1,000.00 (lights-on) + QuarterFee's $100.00 set-aside (the only lights-on smoothed bill) = $1,100.00 — the same figure sp-monthly-total-and-klo pins for Jan and Mar.",
    expected: {
      highestMonthNum: 2, highestTrueCost: 820000, highestOneOffs: 0,
      lowestMonthNum: 4, lowestTrueCost: 60000, lowestOneOffs: 0,
      totalOneOffs: 77700, floor: 110000,
    },
    actual: (w) => yearInSpending(w.core, 2025, "2025-12"),
  },
  {
    id: "ys-top-categories-pivot-and-residual",
    kind: "yearsummary",
    note: "Top categories for 2025, derived BY HAND with the category assignments stated above categoryPivot. Over the 12 included months: Housing = Rent $1,000.00 × 12 = $12,000.00; Health = Gym $50.00 × 12 = $600.00; Subscriptions = AnnualSub accrual $100.00 × 12 ($1,200.00) + LateStart accrual $200.00 × Mar–Dec 10 months ($2,000.00) = $3,200.00; Insurance = SemiIns $100.00 × 12 = $1,200.00; Fees = QuarterFee $100.00 × 12 = $1,200.00; Utilities = BiWater $100.00 × 12 = $1,200.00. Pivot total = 12,000 + 600 + 3,200 + 1,200 × 3 = $19,400.00. Total True cost is $19,000.00 (ys-2025-spending), so the Everything else residual = 19,000 − 19,400 = −$400.00. Sorted desc with label tie-breaks, the top 5 are Housing, Subscriptions, then Fees / Insurance / Utilities (tied at $1,200.00, alphabetical) — Everything else (−$400.00) and Health ($600.00) fall outside the top 5, and all 7 rows sum exactly to True cost. Over Jan–Mar alone the same pivot gives: pivot $4,550.00 (Housing $3,000.00 + Health $150.00 + Subscriptions $300.00 + $200.00 + Insurance $300.00 + Fees $300.00 + Utilities $300.00) against True cost $900.00 + $8,200.00 + $4,500.00 = $13,600.00, so the residual is $9,050.00 and IS the top row — the residual competes like any other row.",
    expected: {
      pivotTotal: 1940000, residual: -40000,
      top1Total: 1200000, top2Total: 320000, top3Total: 120000,
      top4Total: 120000, top5Total: 120000,
      top1IsHousing: 1, top3IsFees: 1, allRowsSum: 1900000, rowCount: 7,
      janMarResidual: 905000, janMarTopIsEverythingElse: 1,
    },
    actual: (w) => {
      const months2025: string[] = [];
      for (let n = 1; n <= 12; n++) {
        const m = `2025-${String(n).padStart(2, "0")}`;
        if (w.core.monthHasData(m)) months2025.push(m);
      }
      const totalTc = months2025.reduce((s, m) => s + w.core.eff(m).smoothed, 0);
      const full = categoryPivot(w.core, months2025, totalTc);
      const janMarMonths = months2025.filter((m) => m <= "2025-03");
      const janMarTc = janMarMonths.reduce((s, m) => s + w.core.eff(m).smoothed, 0);
      const janMar = categoryPivot(w.core, janMarMonths, janMarTc);
      return {
        pivotTotal: full.pivotTotal,
        residual: full.residual,
        top1Total: full.rows[0]?.totalCents ?? null,
        top2Total: full.rows[1]?.totalCents ?? null,
        top3Total: full.rows[2]?.totalCents ?? null,
        top4Total: full.rows[3]?.totalCents ?? null,
        top5Total: full.rows[4]?.totalCents ?? null,
        top1IsHousing: full.rows[0]?.label === "Housing" ? 1 : 0,
        top3IsFees: full.rows[2]?.label === "Fees" ? 1 : 0,
        allRowsSum: full.rows.reduce((s, r) => s + r.totalCents, 0),
        rowCount: full.rows.length,
        janMarResidual: janMar.residual,
        janMarTopIsEverythingElse: janMar.rows[0]?.label === "Everything else" ? 1 : 0,
      };
    },
  },
  {
    id: "ys-trend-rows",
    kind: "yearsummary",
    note: "Multi-year trend rows, derived BY HAND (property off). 2024: spending data in Nov + Dec only, each an accrual-only $400.00 month → 2 months, True cost $800.00; exactly ONE snapshot (Dec 20, $1,050,000.00) → ending $1,050,000.00 and change null (fewer than two snapshots). 2025: 12 spending months, True cost $19,000.00 (ys-2025-spending); two snapshots Jan 15 $1,150,000.00 → Feb 10 $970,000.00 → change −$180,000.00, ending $970,000.00. 2023: no spending months and no snapshots at all → months 0, True cost null, change null, ending null.",
    expected: {
      m2024: 2, tc2024: 80000, chg2024: null, end2024: 105000000,
      m2025: 12, tc2025: 1900000, chg2025: -18000000, end2025: 97000000,
      m2023: 0, tc2023: null, chg2023: null, end2023: null,
    },
    actual: (w) => {
      const r2024 = trendRow(w.core, 2024, false);
      const r2025 = trendRow(w.core, 2025, false);
      const r2023 = trendRow(w.core, 2023, false);
      return {
        m2024: r2024.monthsWithData, tc2024: r2024.trueCostCents,
        chg2024: r2024.nwChangeCents, end2024: r2024.nwEndingCents,
        m2025: r2025.monthsWithData, tc2025: r2025.trueCostCents,
        chg2025: r2025.nwChangeCents, end2025: r2025.nwEndingCents,
        m2023: r2023.monthsWithData, tc2023: r2023.trueCostCents,
        chg2023: r2023.nwChangeCents, end2023: r2023.nwEndingCents,
      };
    },
  },
  {
    id: "nw-growth-transform",
    kind: "networth",
    note: "Growth transform on the synthetic dataset (property off), derived BY HAND from the recorded balances. Levels — totals: $1,050,000.00 / $1,150,000.00 / $970,000.00 (nw-totals-property-off); Brokerage: $1,000,000.00 / $1,100,000.00 / $900,000.00; Old 401k: $50,000.00 / $50,000.00 / $70,000.00; buckets Roth: $400,000.00 / $440,000.00 / $400,000.00, Taxable: $600,000.00 / $660,000.00 / $500,000.00, Unbucketed: $50,000.00 / $50,000.00 / $70,000.00. Growth is level minus the first level, so every series starts at 0; totals grow +$100,000.00 then fall to −$80,000.00. Brokerage DECLINES over the window: its growth ends at −$100,000.00 (a negative contribution, pinned). Component growth sums to the total growth at EVERY point — by account: Jan +$100,000.00 + $0 = +$100,000.00, Feb −$100,000.00 + $20,000.00 = −$80,000.00; by bucket: Jan +$40,000.00 + $60,000.00 + $0 = +$100,000.00, Feb $0 − $100,000.00 + $20,000.00 = −$80,000.00.",
    expected: {
      t0: 0, t1: 10000000, t2: -8000000,
      br0: 0, br1: 10000000, br2: -10000000,
      old0: 0, old1: 0, old2: 2000000,
      roth0: 0, roth1: 4000000, roth2: 0,
      tax0: 0, tax1: 6000000, tax2: -10000000,
      unb0: 0, unb1: 0, unb2: 2000000,
      sumAcct1: 10000000, sumAcct2: -8000000,
      sumBucket1: 10000000, sumBucket2: -8000000,
    },
    actual: () => {
      const totals = NW_SNAPSHOTS.map(
        (s) => snapshotTotals(NW_BALANCES[s.id] ?? [], NW_CLASS_BY_ID, false).totalCents,
      );
      const acctLevels = (id: number) =>
        NW_SNAPSHOTS.map((s) => {
          const b = (NW_BALANCES[s.id] ?? []).find((x) => x.accountId === id);
          return b ? b.balanceCents : null;
        });
      const bucketLevels = (bucket: "Roth" | "Taxable" | "Unbucketed") =>
        NW_SNAPSHOTS.map(
          (s) => bucketSubtotals(NW_BALANCES[s.id] ?? [], NW_CLASS_BY_ID)[bucket] ?? 0,
        );
      const gTotal = growthSeries(totals);
      const gBr = growthSeries(acctLevels(1));
      const gOld = growthSeries(acctLevels(4));
      const gRoth = growthSeries(bucketLevels("Roth"));
      const gTax = growthSeries(bucketLevels("Taxable"));
      const gUnb = growthSeries(bucketLevels("Unbucketed"));
      const sumAt = (arrs: (number | null)[][], i: number) =>
        arrs.reduce<number>((s, a) => s + (a[i] ?? 0), 0);
      return {
        t0: gTotal[0] ?? null, t1: gTotal[1] ?? null, t2: gTotal[2] ?? null,
        br0: gBr[0] ?? null, br1: gBr[1] ?? null, br2: gBr[2] ?? null,
        old0: gOld[0] ?? null, old1: gOld[1] ?? null, old2: gOld[2] ?? null,
        roth0: gRoth[0] ?? null, roth1: gRoth[1] ?? null, roth2: gRoth[2] ?? null,
        tax0: gTax[0] ?? null, tax1: gTax[1] ?? null, tax2: gTax[2] ?? null,
        unb0: gUnb[0] ?? null, unb1: gUnb[1] ?? null, unb2: gUnb[2] ?? null,
        sumAcct1: sumAt([gBr, gOld], 1), sumAcct2: sumAt([gBr, gOld], 2),
        sumBucket1: sumAt([gRoth, gTax, gUnb], 1),
        sumBucket2: sumAt([gRoth, gTax, gUnb], 2),
      };
    },
  },
  {
    id: "nw-growth-null-gaps",
    kind: "networth",
    note: "Growth null rules on a dedicated series array, derived BY HAND from the transform definition. A series with a gap — levels $1,000.00 / not recorded / $1,500.00 — has growth $0.00 / null / +$500.00: the gap point stays a gap, never a drop. A series absent at the first snapshot — levels not recorded / $2,000.00 / $2,600.00 — has NO baseline, so its growth is null at every point, including where it has a level.",
    expected: { gap0: 0, gap1: null, gap2: 50000, late0: null, late1: null, late2: null },
    actual: () => {
      const gap = growthSeries([100000, null, 150000]);
      const late = growthSeries([null, 200000, 260000]);
      return {
        gap0: gap[0] ?? null, gap1: gap[1] ?? null, gap2: gap[2] ?? null,
        late0: late[0] ?? null, late1: late[1] ?? null, late2: late[2] ?? null,
      };
    },
  },
  {
    id: "nw-annotation-figures",
    kind: "networth",
    note: "Headline annotation arithmetic on hand-derived numbers. Sample-series case (the NW_SEED sample totals): first $2,610,000.00 rounds to $2,610,000 and last $3,062,500.00 rounds to $3,062,500, so the change is +$452,500 and the percent is 452,500 / 2,610,000 × 100 = 17.337…% → +17.3% (173 tenths). Negative case: $1,200,000.00 → $900,000.00 is a change of −$300,000 and −25.0% (−250 tenths). Single snapshot: change $0 and NO percent (null). First displayed total $0: first $0.00 → last $50,000.00 shows the +$50,000 change with NO percent (null).",
    expected: {
      realFirst: 2610000, realLast: 3062500, realChange: 452500, realPctTenths: 173,
      negChange: -300000, negPctTenths: -250,
      singleChange: 0, singlePctTenths: null,
      zeroFirstChange: 50000, zeroFirstPctTenths: null,
    },
    actual: () => {
      const real = annotationFigures(261000000, 306250000, 15);
      const neg = annotationFigures(120000000, 90000000, 2);
      const single = annotationFigures(261000000, 261000000, 1);
      const zeroFirst = annotationFigures(0, 5000000, 2);
      return {
        realFirst: real.firstDollars, realLast: real.lastDollars,
        realChange: real.changeDollars, realPctTenths: real.pctTenths,
        negChange: neg.changeDollars, negPctTenths: neg.pctTenths,
        singleChange: single.changeDollars, singlePctTenths: single.pctTenths,
        zeroFirstChange: zeroFirst.changeDollars,
        zeroFirstPctTenths: zeroFirst.pctTenths,
      };
    },
  },
  {
    id: "restore-duplicate-snapshot-date-rejected",
    kind: "restore",
    note: "Cluster A case (a): a payload carrying two snapshots with the SAME date (2025-01-15, ids 1 and 2) — the collision that used to fail halfway through the wipe+insert sequence on the nwSnapshots UNIQUE date — is refused by preflight before any write: the restore does not commit and the prior state's fingerprint is byte-identical afterwards.",
    expected: { rejected: 1, committed: 0, priorIntact: 1 },
    actual: () => {
      const prior = restorePriorState();
      const raw = baseRestorePayload();
      (raw.nwSnapshots as Record<string, unknown>[]).push({
        id: 2, date: "2025-01-15", note: null, createdAt: 1700000000000,
      });
      const res = attemptRestore(prior, raw, restoreKeyCheckValidFor(raw));
      return {
        rejected: res.ok ? 0 : 1,
        committed: res.committed ? 1 : 0,
        priorIntact:
          restoreStateFingerprint(res.state) === restoreStateFingerprint(prior) ? 1 : 0,
      };
    },
  },
  {
    id: "restore-wrong-key-backup-rejected-before-delete",
    kind: "restore",
    note: "Cluster A case (b): a backup whose own encryption key-check value is not the known constant under this key (a backup made under a DIFFERENT key) is refused by preflight before any delete: no commit, prior state byte-identical. The same payload with the correct key-check restores fine (control: rejected 0 there would mean the check never ran).",
    expected: { rejected: 1, committed: 0, priorIntact: 1, controlRestores: 1 },
    actual: () => {
      const prior = restorePriorState();
      const raw = baseRestorePayload();
      (raw.settings as Record<string, unknown>[])[0] = {
        key: BACKUP_KEY_CHECK_SETTING,
        value: "hatch-encryption-check-v1-under-another-key",
      };
      const res = attemptRestore(prior, raw, restoreKeyCheckValidFor(raw));
      const control = attemptRestore(
        restorePriorState(),
        baseRestorePayload(),
        restoreKeyCheckValidFor(baseRestorePayload()),
      );
      return {
        rejected: res.ok ? 0 : 1,
        committed: res.committed ? 1 : 0,
        priorIntact:
          restoreStateFingerprint(res.state) === restoreStateFingerprint(prior) ? 1 : 0,
        controlRestores: control.ok && control.committed ? 1 : 0,
      };
    },
  },
  {
    id: "backup-mac-primitives-known-answers",
    kind: "backup",
    note: "S1 foundation: the pure SHA-256 / HMAC-SHA-256 implementation backupMacCore carries (the shared restore path is synchronous, so no platform crypto) matches the published known answers — FIPS 180-4 SHA-256 for the empty string, \"abc\", and the 56-byte two-block message, and RFC 4231 HMAC-SHA-256 test cases 1 (key 20×0x0b), 2 (key \"Jefe\"), and 6 (a 131-byte key, longer than the block size, exercising the hash-the-key-first path). A MAC primitive that drifted from these vectors would silently invalidate every backup ever written, so the vectors are pinned, not trusted.",
    expected: {
      sha256Empty: 1, sha256Abc: 1, sha256TwoBlock: 1,
      hmacCase1: 1, hmacCase2: 1, hmacCase6: 1,
    },
    actual: () => {
      const hex = (b: Uint8Array) => bytesToHex(b);
      return {
        sha256Empty:
          sha256Hex("") ===
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" ? 1 : 0,
        sha256Abc:
          sha256Hex("abc") ===
          "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" ? 1 : 0,
        sha256TwoBlock:
          sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq") ===
          "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1" ? 1 : 0,
        hmacCase1:
          hex(hmacSha256Bytes(new Uint8Array(20).fill(0x0b), utf8Bytes("Hi There"))) ===
          "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7" ? 1 : 0,
        hmacCase2:
          hex(hmacSha256Bytes(utf8Bytes("Jefe"), utf8Bytes("what do ya want for nothing?"))) ===
          "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843" ? 1 : 0,
        hmacCase6:
          hex(hmacSha256Bytes(
            new Uint8Array(131).fill(0xaa),
            utf8Bytes("Test Using Larger Than Block-Size Key - Hash Key First"),
          )) ===
          "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54" ? 1 : 0,
      };
    },
  },
  {
    id: "backup-mac-verified-backup-restores",
    kind: "restore",
    note: "S1 acceptance (a): a payload carrying a valid authenticity MAC — computed over its exact contents by backupMacCore, the way buildBackupPayload attaches it at export — restores clean through the real restore flow: committed, authenticity verdict 'verified' (code 2), and the payload's rows land (1 Net Worth account, 1 balance at its payload figure $300.00).",
    expected: { restored: 1, committed: 1, authenticityCode: 2, accounts: 1, balanceCents: 30000 },
    actual: () => {
      const raw = macdRestorePayload();
      const res = attemptRestore(restorePriorState(), raw, restoreKeyCheckValidFor(raw));
      const bal = res.state.nwBalances[0] ?? {};
      return {
        restored: res.ok ? 1 : 0,
        committed: res.committed ? 1 : 0,
        authenticityCode: authenticityCode(res.authenticity),
        accounts: res.state.nwAccounts.length,
        balanceCents: typeof bal.balanceCents === "number" ? bal.balanceCents : null,
      };
    },
  },
  {
    id: "backup-mac-tampered-backup-refused",
    kind: "restore",
    note: "S1 acceptance (b): the same MAC'd payload with ONE byte of content changed after signing — the balance figure $300.00 → $300.01, the MAC left exactly as exported — is refused by preflight with the authenticity error ('its authenticity check failed'): no commit, prior state byte-identical, verdict 'mismatch' (code 0). Before this build the same tampered payload passed the compatibility key check and restored silently. A second tamper — the MAC value itself altered, contents untouched — is likewise refused (macTamperRejected).",
    expected: {
      rejected: 1, committed: 0, priorIntact: 1, authenticityCode: 0,
      reasonNamesAuthenticity: 1, macTamperRejected: 1,
    },
    actual: () => {
      const prior = restorePriorState();
      const raw = macdRestorePayload();
      (raw.nwBalances as Record<string, unknown>[])[0] = {
        ...(raw.nwBalances as Record<string, unknown>[])[0],
        balanceCents: 30001,
      };
      const res = attemptRestore(prior, raw, restoreKeyCheckValidFor(raw));
      const macTampered = macdRestorePayload();
      const mac = String(macTampered.authenticityMac);
      macTampered.authenticityMac =
        (mac.startsWith("0") ? "1" : "0") + mac.slice(1);
      const res2 = attemptRestore(
        restorePriorState(),
        macTampered,
        restoreKeyCheckValidFor(macTampered),
      );
      return {
        rejected: res.ok ? 0 : 1,
        committed: res.committed ? 1 : 0,
        priorIntact:
          restoreStateFingerprint(res.state) === restoreStateFingerprint(prior) ? 1 : 0,
        authenticityCode: authenticityCode(res.authenticity),
        reasonNamesAuthenticity: res.reason.includes("authenticity check failed") ? 1 : 0,
        macTamperRejected: !res2.ok && !res2.committed ? 1 : 0,
      };
    },
  },
  {
    id: "backup-mac-premac-backup-restores-unauthenticated",
    kind: "restore",
    note: "S1 acceptance (c) — the option C compatibility rule: a pre-MAC backup (baseRestorePayload carries no authenticityMac — the shape of every backup written before this build) is NOT hard-refused: it restores and commits, with the authenticity verdict 'absent' (code 1) that the restore result labels UNAUTHENTICATED. A MAC'd backup whose MAC was stripped lands in exactly the same place (strippedRestores 1, strippedCode 1): stripping can only ever downgrade a backup to unauthenticated, never upgrade one to verified.",
    expected: { restored: 1, committed: 1, authenticityCode: 1, strippedRestores: 1, strippedCode: 1 },
    actual: () => {
      const raw = baseRestorePayload();
      const res = attemptRestore(restorePriorState(), raw, restoreKeyCheckValidFor(raw));
      const stripped = macdRestorePayload();
      delete stripped.authenticityMac;
      const res2 = attemptRestore(
        restorePriorState(),
        stripped,
        restoreKeyCheckValidFor(stripped),
      );
      return {
        restored: res.ok ? 1 : 0,
        committed: res.committed ? 1 : 0,
        authenticityCode: authenticityCode(res.authenticity),
        strippedRestores: res2.ok && res2.committed ? 1 : 0,
        strippedCode: authenticityCode(res2.authenticity),
      };
    },
  },
  {
    id: "backup-mac-canonical-form-key-order",
    kind: "backup",
    note: "S1 interop pin (supports acceptance (d)): the MAC is computed over a key-sorted canonical serialization, so identical contents MAC identically regardless of the producing object's key order — a deep key-reversed copy of a MAC'd payload yields the same MAC (reorderedMacEqual) and still verifies (reorderedVerifies), and a JSON serialize/parse round trip still verifies (roundTripVerifies). This is the property that lets a backup exported by the live app verify in the packaged build and vice versa: different builders, same contents, same MAC.",
    expected: { reorderedMacEqual: 1, reorderedVerifies: 1, roundTripVerifies: 1 },
    actual: () => {
      const raw = macdRestorePayload();
      const reorder = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(reorder);
        if (v != null && typeof v === "object") {
          const out: Record<string, unknown> = {};
          for (const k of Object.keys(v as Record<string, unknown>).reverse()) {
            out[k] = reorder((v as Record<string, unknown>)[k]);
          }
          return out;
        }
        return v;
      };
      const reordered = reorder(raw);
      const roundTripped = JSON.parse(JSON.stringify(raw)) as unknown;
      return {
        reorderedMacEqual: computeBackupMac(reordered) === computeBackupMac(raw) ? 1 : 0,
        reorderedVerifies: classifyBackupAuthenticity(reordered) === "verified" ? 1 : 0,
        roundTripVerifies: classifyBackupAuthenticity(roundTripped) === "verified" ? 1 : 0,
      };
    },
  },
  {
    id: "restore-legacy-v1-defaults",
    kind: "restore",
    note: "Cluster A case (c): a legacy v1 backup whose Net Worth account omits propertyKind AND custodial, and whose balance omits ALL SEVEN split keys, validates under the legacy defaults and restores: propertyKind defaults to \"none\" (kind code 0), custodial to 0, every split key to null (7 nulls), and the unsplit balance keeps its payload figure ($4,242.42 = 424242). Before the fix this payload failed schema validation outright.",
    expected: { restored: 1, kindCode: 0, custodial: 0, splitNulls: 7, balanceKept: 424242 },
    actual: () => {
      const raw = baseRestorePayload();
      raw.settings = [];
      raw.nwAccounts = [
        {
          id: 1, name: "Legacy Brokerage", bucket: "Unbucketed",
          sortOrder: 0, archived: 0, createdAt: 1700000000000,
        },
      ];
      raw.nwBalances = [
        { id: 1, snapshotId: 1, accountId: 1, balanceCents: 424242 },
      ];
      const res = attemptRestore(restorePriorState(), raw, restoreKeyCheckValidFor(raw));
      const acct = res.state.nwAccounts[0] ?? {};
      const balRow = res.state.nwBalances[0] ?? {};
      const splitKeys = [
        "splitHsaCents", "splitRothCents", "splitTaxableCents",
        "splitNonTaxableCents", "split529Cents", "splitCashCents",
        "splitPreTaxCents",
      ];
      return {
        restored: res.ok && res.committed ? 1 : 0,
        kindCode: acct.propertyKind === "none" ? 0 : acct.propertyKind === "asset" ? 1 : 2,
        custodial: typeof acct.custodial === "number" ? acct.custodial : null,
        splitNulls: splitKeys.filter((k) => balRow[k] === null).length,
        balanceKept: typeof balRow.balanceCents === "number" ? balRow.balanceCents : null,
      };
    },
  },
  {
    id: "restore-propertykind-typo-rejected",
    kind: "restore",
    note: "Cluster A case (d): a Net Worth account with propertyKind \"liabilty\" (a $250,000.00 mortgage typo) is refused by preflight's enum check — it must NOT be silently coerced to \"none\" (which would restore the mortgage as a +$250,000.00 asset, a ~$500,000 net-worth swing). No commit; prior state byte-identical.",
    expected: { rejected: 1, committed: 0, priorIntact: 1 },
    actual: () => {
      const prior = restorePriorState();
      const raw = baseRestorePayload();
      (raw.nwAccounts as Record<string, unknown>[])[0] = {
        id: 1, name: "Mortgage", bucket: "Unbucketed",
        propertyKind: "liabilty", custodial: 0, sortOrder: 0, archived: 0,
        createdAt: 1700000000000,
      };
      (raw.nwBalances as Record<string, unknown>[])[0] = {
        id: 1, snapshotId: 1, accountId: 1, balanceCents: 25000000,
        splitHsaCents: null, splitRothCents: null, splitTaxableCents: null,
        splitNonTaxableCents: null, split529Cents: null, splitCashCents: null,
        splitPreTaxCents: null,
      };
      const res = attemptRestore(prior, raw, restoreKeyCheckValidFor(raw));
      return {
        rejected: res.ok ? 0 : 1,
        committed: res.committed ? 1 : 0,
        priorIntact:
          restoreStateFingerprint(res.state) === restoreStateFingerprint(prior) ? 1 : 0,
      };
    },
  },
  {
    id: "restore-split-mismatch-normalized",
    kind: "restore",
    note: "Cluster A case (e) + engine E4, pinning the CHOSEN rule — normalise, matching every normal writer: a restored balance whose non-empty split (Roth $200.00 + Taxable $100.00 = $300.00) disagrees with its payload balanceCents ($500.00) is stored with balanceCents RECOMPUTED from the parts ($300.00), so snapshotTotals (sums balanceCents) and bucketSubtotals (split authoritative) agree at $300.00 instead of disagreeing by $200.00.",
    expected: { restored: 1, storedBalance: 30000, snapshotTotal: 30000, bucketSum: 30000 },
    actual: () => {
      const raw = baseRestorePayload();
      (raw.nwBalances as Record<string, unknown>[])[0] = {
        id: 1, snapshotId: 1, accountId: 1, balanceCents: 50000,
        splitHsaCents: null, splitRothCents: 20000, splitTaxableCents: 10000,
        splitNonTaxableCents: null, split529Cents: null, splitCashCents: null,
        splitPreTaxCents: null,
      };
      const res = attemptRestore(restorePriorState(), raw, restoreKeyCheckValidFor(raw));
      const row = res.state.nwBalances[0] ?? {};
      const coreBal: CoreNwBalance = {
        accountId: 1,
        balanceCents: typeof row.balanceCents === "number" ? row.balanceCents : -1,
        splitHsaCents: (row.splitHsaCents as number | null) ?? null,
        splitRothCents: (row.splitRothCents as number | null) ?? null,
        splitTaxableCents: (row.splitTaxableCents as number | null) ?? null,
        splitNonTaxableCents: (row.splitNonTaxableCents as number | null) ?? null,
        split529Cents: (row.split529Cents as number | null) ?? null,
        splitCashCents: (row.splitCashCents as number | null) ?? null,
        splitPreTaxCents: (row.splitPreTaxCents as number | null) ?? null,
      };
      const classes = classByIdOf([{ id: 1, propertyKind: "none", custodial: 0 }]);
      const subs = bucketSubtotals([coreBal], classes);
      return {
        restored: res.ok && res.committed ? 1 : 0,
        storedBalance: coreBal.balanceCents,
        snapshotTotal: snapshotTotals([coreBal], classes, false).totalCents,
        bucketSum: Object.values(subs).reduce<number>((s, v) => s + (v ?? 0), 0),
      };
    },
  },
  {
    id: "restore-atomic-batch-mid-failure",
    kind: "restore",
    note: "Cluster A staged mid-restore failure: the valid payload's restore plan (12 wipes, then inserts) is executed with a failure INJECTED at the first nwBalances insert — deep in the plan, after every wipe and almost every insert has already been applied to the working copy. The atomic executor commits nothing: the result is uncommitted and the returned state is the prior state, byte-identical. The same plan with no injected failure commits and lands the payload's snapshot (control). This mirrors the handler's single db.batch: all statements land or none do.",
    expected: { rolledBack: 1, priorIntact: 1, failedAfterWipes: 1, controlCommits: 1 },
    actual: () => {
      const prior = restorePriorState();
      const parsed = backupPayload.parse(baseRestorePayload()) as BackupPayload;
      const plan = buildRestorePlan(parsed);
      const failAt = plan.findIndex(
        (s) => s.op === "insert" && s.table === "nwBalances",
      );
      const failed = executeRestorePlanAtomically(prior, plan, failAt);
      const control = executeRestorePlanAtomically(prior, plan, null);
      return {
        rolledBack: failed.committed ? 0 : 1,
        priorIntact:
          restoreStateFingerprint(failed.state) === restoreStateFingerprint(prior)
            ? 1
            : 0,
        failedAfterWipes:
          failed.failedAt != null && failed.failedAt > RESTORE_WIPE_ORDER.length
            ? 1
            : 0,
        controlCommits:
          control.committed && control.state.nwSnapshots.length === 1 ? 1 : 0,
      };
    },
  },
  {
    id: "restore-roth-blob-without-revision-stamped-1",
    kind: "restore",
    note: "Restore pin (R4-2 / F4): the stamp is unconditional — a backup whose Roth plan record blob (settings key roth_conversion_inputs_v1, carried as the decrypted JSON document exactly as export writes it) has NO revision key restores at revision 1 (max(0, 0) + 1), gaining the key; content apart from the revision is identical to the backup's, and the blob still reads and prices the same.",
    expected: { restored: 1, revisionAfter: 1, contentPreserved: 1 },
    actual: () => {
      const blobJson = JSON.stringify({ inputs: { birthYearPrimary: 1990 }, scenarios: [] });
      const raw = baseRestorePayload();
      (raw.settings as Record<string, unknown>[]).push({
        key: "roth_conversion_inputs_v1",
        value: blobJson,
      });
      const res = attemptRestore(restorePriorState(), raw, restoreKeyCheckValidFor(raw));
      const row = res.state.settings.find((s) => s.key === "roth_conversion_inputs_v1");
      let contentPreserved = 0;
      if (row != null) {
        const a = JSON.parse(String(row.value)) as Record<string, unknown>;
        const b = JSON.parse(blobJson) as Record<string, unknown>;
        delete a.revision;
        delete b.revision;
        contentPreserved = JSON.stringify(a) === JSON.stringify(b) ? 1 : 0;
      }
      return {
        restored: res.ok && res.committed ? 1 : 0,
        revisionAfter: row ? parseRothBlobRevision(String(row.value)) : -1,
        contentPreserved,
      };
    },
  },
  {
    id: "restore-roth-blob-revision-stamped-forward",
    kind: "restore",
    note: "Restore pin (R4-2 / F4): a restore is a write generation — the restored blob's revision is stamped max(preRestore, backup) + 1 (here 41 → 42, no pre-restore row), so a tab holding the pre-restore base 41 is REFUSED afterwards instead of saving over the restored record; the document's content apart from the revision is byte-identical to the backup's.",
    expected: { restored: 1, revisionAfter: 42, contentPreserved: 1 },
    actual: () => {
      const blobJson = JSON.stringify({
        inputs: { birthYearPrimary: 1990 },
        scenarios: [],
        revision: 41,
      });
      const raw = baseRestorePayload();
      (raw.settings as Record<string, unknown>[]).push({
        key: "roth_conversion_inputs_v1",
        value: blobJson,
      });
      const res = attemptRestore(restorePriorState(), raw, restoreKeyCheckValidFor(raw));
      const row = res.state.settings.find((s) => s.key === "roth_conversion_inputs_v1");
      let contentPreserved = 0;
      if (row != null) {
        const a = JSON.parse(String(row.value)) as Record<string, unknown>;
        const b = JSON.parse(blobJson) as Record<string, unknown>;
        const aInputs = a.inputs;
        const aScenarios = a.scenarios;
        delete a.revision;
        delete b.revision;
        contentPreserved =
          JSON.stringify(a) === JSON.stringify(b) &&
          JSON.stringify(aInputs) === JSON.stringify(b.inputs) &&
          JSON.stringify(aScenarios) === JSON.stringify(b.scenarios)
            ? 1
            : 0;
      }
      return {
        restored: res.ok && res.committed ? 1 : 0,
        revisionAfter: row ? parseRothBlobRevision(String(row.value)) : -1,
        contentPreserved,
      };
    },
  },
  {
    id: "restore-roth-blob-stamp-beats-higher-prior",
    kind: "restore",
    note: "Restore pin (R4-2 / F4): the prior state carries a Roth row at revision 50; the backup's blob is at 41 → post-restore revision 51 (the max() half of the rule), content = the backup's document at 51.",
    expected: { restored: 1, revisionAfter: 51, contentPreserved: 1 },
    actual: () => {
      const blobJson = JSON.stringify({
        inputs: { birthYearPrimary: 1990 },
        scenarios: [],
        revision: 41,
      });
      const raw = baseRestorePayload();
      (raw.settings as Record<string, unknown>[]).push({
        key: "roth_conversion_inputs_v1",
        value: blobJson,
      });
      const prior = restorePriorState();
      prior.settings.push({
        key: RESTORE_ROTH_BLOB_KEY,
        value: JSON.stringify({ inputs: { birthYearPrimary: 1960 }, scenarios: [], revision: 50 }),
      });
      const res = attemptRestore(prior, raw, restoreKeyCheckValidFor(raw));
      const row = res.state.settings.find((s) => s.key === RESTORE_ROTH_BLOB_KEY);
      let contentPreserved = 0;
      if (row != null) {
        const a = JSON.parse(String(row.value)) as Record<string, unknown>;
        const b = JSON.parse(blobJson) as Record<string, unknown>;
        delete a.revision;
        delete b.revision;
        const stampedDirect = stampRestoredRothBlob(blobJson, 50);
        contentPreserved =
          JSON.stringify(a) === JSON.stringify(b) &&
          stampedDirect != null &&
          parseRothBlobRevision(stampedDirect) === 51
            ? 1
            : 0;
      }
      return {
        restored: res.ok && res.committed ? 1 : 0,
        revisionAfter: row ? parseRothBlobRevision(String(row.value)) : -1,
        contentPreserved,
      };
    },
  },
  {
    id: "restore-roth-blob-then-stale-tab-refused",
    kind: "restore",
    note: "Restore pin (R4-2 / F4): prior Roth row at 41 with content marker birthYearPrimary 1990; backup blob at 41 with marker 1980. After the restore (stamped 42): the shipped write decision for a tab holding base 41 — decideRothBlobWrite against the restored revision — is refused; the stored row is still the restored document (marker 1980, revision 42) afterwards.",
    expected: { restored: 1, revisionAfter: 42, staleRefused: 1, restoredContentIntact: 1 },
    actual: () => {
      const backupJson = JSON.stringify({
        inputs: { birthYearPrimary: 1980 },
        scenarios: [],
        revision: 41,
      });
      const raw = baseRestorePayload();
      (raw.settings as Record<string, unknown>[]).push({
        key: "roth_conversion_inputs_v1",
        value: backupJson,
      });
      const prior = restorePriorState();
      prior.settings.push({
        key: "roth_conversion_inputs_v1",
        value: JSON.stringify({ inputs: { birthYearPrimary: 1990 }, scenarios: [], revision: 41 }),
      });
      const res = attemptRestore(prior, raw, restoreKeyCheckValidFor(raw));
      const row = res.state.settings.find((s) => s.key === "roth_conversion_inputs_v1");
      const revisionAfter = row ? parseRothBlobRevision(String(row.value)) : -1;
      const decision = decideRothBlobWrite(revisionAfter, 41);
      const staleRefused = !decision.allowed ? 1 : 0;
      let restoredContentIntact = 0;
      if (row != null) {
        const doc = JSON.parse(String(row.value)) as { inputs?: { birthYearPrimary?: number }; revision?: number };
        restoredContentIntact = doc.inputs?.birthYearPrimary === 1980 && doc.revision === 42 ? 1 : 0;
      }
      return {
        restored: res.ok && res.committed ? 1 : 0,
        revisionAfter,
        staleRefused,
        restoredContentIntact,
      };
    },
  },
  {
    id: "restore-retirement-blobs-without-revision-read-0",
    kind: "restore",
    note: "Restore pin (API follow-on F23): a backup whose two Retirement blobs (settings keys retirement_calc_inputs_v1 and retirement_calc_baseline_v1, carried as the decrypted JSON documents exactly as export writes them) carry NO revision key restores with both values byte-identical, and both restored blobs read revision 0 afterwards under the lenient read (parseRothBlobRevision — the read both Retirement state readers share with the Roth record). Pre-CAS backups need no backfill: the first post-restore save on each record stamps revision 1. No restore code knows about the revision — it is just content inside the settings values.",
    expected: { restored: 1, revision1After: 0, revision2After: 0, value1Preserved: 1, value2Preserved: 1 },
    actual: () => {
      const blob1Json = JSON.stringify({
        portfolioCents: 500000000, spendingCents: 12000000, currentAge: 55,
        retirementAge: 57, endAge: 95, scenarios: [],
      });
      const blob2Json = JSON.stringify({
        kind: "saved",
        inputs: { portfolioCents: 500000000, spendingCents: 12000000 },
      });
      const raw = baseRestorePayload();
      (raw.settings as Record<string, unknown>[]).push(
        { key: "retirement_calc_inputs_v1", value: blob1Json },
        { key: "retirement_calc_baseline_v1", value: blob2Json },
      );
      const res = attemptRestore(restorePriorState(), raw, restoreKeyCheckValidFor(raw));
      const row1 = res.state.settings.find((s) => s.key === "retirement_calc_inputs_v1");
      const row2 = res.state.settings.find((s) => s.key === "retirement_calc_baseline_v1");
      return {
        restored: res.ok && res.committed ? 1 : 0,
        revision1After: row1 ? parseRothBlobRevision(String(row1.value)) : -1,
        revision2After: row2 ? parseRothBlobRevision(String(row2.value)) : -1,
        value1Preserved: row1 != null && row1.value === blob1Json ? 1 : 0,
        value2Preserved: row2 != null && row2.value === blob2Json ? 1 : 0,
      };
    },
  },
  {
    id: "restore-retirement-blobs-revisions-41-and-7-preserved",
    kind: "restore",
    note: "Restore pin (API follow-on F23): a backup whose Retirement blob 1 carries revision 41 and whose baseline blob carries revision 7 restores with both values byte-identical, and the restored blobs still read 41 and 7 afterwards — the revisions ride inside the encrypted payloads' documents, so a restore neither resets nor advances either CAS counter (a writer holding the pre-restore bases can still save afterwards; one holding anything else conflicts, exactly as for any other concurrent write).",
    expected: { restored: 1, revision1After: 41, revision2After: 7, value1Preserved: 1, value2Preserved: 1 },
    actual: () => {
      const blob1Json = JSON.stringify({
        portfolioCents: 500000000, spendingCents: 12000000, currentAge: 55,
        retirementAge: 57, endAge: 95, scenarios: [], revision: 41,
      });
      const blob2Json = JSON.stringify({
        kind: "saved",
        inputs: { portfolioCents: 500000000, spendingCents: 12000000 },
        revision: 7,
      });
      const raw = baseRestorePayload();
      (raw.settings as Record<string, unknown>[]).push(
        { key: "retirement_calc_inputs_v1", value: blob1Json },
        { key: "retirement_calc_baseline_v1", value: blob2Json },
      );
      const res = attemptRestore(restorePriorState(), raw, restoreKeyCheckValidFor(raw));
      const row1 = res.state.settings.find((s) => s.key === "retirement_calc_inputs_v1");
      const row2 = res.state.settings.find((s) => s.key === "retirement_calc_baseline_v1");
      return {
        restored: res.ok && res.committed ? 1 : 0,
        revision1After: row1 ? parseRothBlobRevision(String(row1.value)) : -1,
        revision2After: row2 ? parseRothBlobRevision(String(row2.value)) : -1,
        value1Preserved: row1 != null && row1.value === blob1Json ? 1 : 0,
        value2Preserved: row2 != null && row2.value === blob2Json ? 1 : 0,
      };
    },
  },
  {
    id: "restore-invalid-transaction-date-rejected",
    kind: "restore",
    note: "Hardening S3 (round-5 security review): a backup whose transaction carries the impossible date 2026-02-31 — which the ordinary transaction writer refuses outright — is refused by restore preflight BEFORE any write: no commit, the prior state's fingerprint is byte-identical afterwards, and the refusal names the row and the offending value. Before this fix the payload restored and the row aggregated under a February that never had a 31st.",
    expected: { rejected: 1, committed: 0, priorIntact: 1, namesValue: 1 },
    actual: () => {
      const prior = restorePriorState();
      const raw = baseRestorePayload();
      (raw.transactions as Record<string, unknown>[]).push({
        id: 1, date: "2026-02-31", description: "Synthetic", amountCents: 100,
        sourceType: "checking", accountName: "Checking", kind: "spending",
        category: "Other", yearlyExpenseId: null, createdAt: 1700000000000,
      });
      const res = attemptRestore(prior, raw, restoreKeyCheckValidFor(raw));
      return {
        rejected: res.ok ? 0 : 1,
        committed: res.committed ? 1 : 0,
        priorIntact:
          restoreStateFingerprint(res.state) === restoreStateFingerprint(prior) ? 1 : 0,
        namesValue: res.reason.includes("2026-02-31") ? 1 : 0,
      };
    },
  },
  {
    id: "restore-nota-date-snapshot-rejected",
    kind: "restore",
    note: "Hardening S3: a backup whose Net Worth snapshot date is the literal string \"not-a-date\" is refused by restore preflight before any write — no commit, prior state byte-identical, refusal names the value. Before this fix it restored, and month-based views could not associate the snapshot with any real date.",
    expected: { rejected: 1, committed: 0, priorIntact: 1, namesValue: 1 },
    actual: () => {
      const prior = restorePriorState();
      const raw = baseRestorePayload();
      (raw.nwSnapshots as Record<string, unknown>[])[0] = {
        id: 1, date: "not-a-date", note: null, createdAt: 1700000000000,
      };
      const res = attemptRestore(prior, raw, restoreKeyCheckValidFor(raw));
      return {
        rejected: res.ok ? 0 : 1,
        committed: res.committed ? 1 : 0,
        priorIntact:
          restoreStateFingerprint(res.state) === restoreStateFingerprint(prior) ? 1 : 0,
        namesValue: res.reason.includes("not-a-date") ? 1 : 0,
      };
    },
  },
  {
    id: "restore-invalid-month-fields-rejected",
    kind: "restore",
    note: "Hardening S3: the month-carrying fields validate as real YYYY-MM months in preflight — a monthly summary month of \"2025-13\" and a monthly bill version effectiveFrom of \"2025-13\" each refuse the whole restore before any write (prior state byte-identical in both runs), each refusal naming the offending value.",
    expected: {
      summaryRejected: 1, summaryPriorIntact: 1, summaryNames: 1,
      versionRejected: 1, versionPriorIntact: 1, versionNames: 1,
    },
    actual: () => {
      const priorA = restorePriorState();
      const rawA = baseRestorePayload();
      (rawA.monthlySummaries as Record<string, unknown>[]).push({
        month: "2025-13", cashOutCents: 100,
        createdAt: 1700000000000, updatedAt: 1700000000000,
      });
      const resA = attemptRestore(priorA, rawA, restoreKeyCheckValidFor(rawA));
      const priorB = restorePriorState();
      const rawB = baseRestorePayload();
      (rawB.monthlyBills as Record<string, unknown>[]).push({
        id: 1, name: "Rent", amountCents: 100000, paidBy: "Checking",
        notes: null, category: "Housing", keepLightsOn: 1, collapsed: 0,
        createdAt: 1700000000000,
      });
      (rawB.monthlyBillVersions as Record<string, unknown>[]).push({
        id: 1, billId: 1, amountCents: 100000, effectiveFrom: "2025-13",
        createdAt: 1700000000000,
      });
      const resB = attemptRestore(priorB, rawB, restoreKeyCheckValidFor(rawB));
      return {
        summaryRejected: resA.ok ? 0 : 1,
        summaryPriorIntact:
          restoreStateFingerprint(resA.state) === restoreStateFingerprint(priorA) ? 1 : 0,
        summaryNames: resA.reason.includes("2025-13") ? 1 : 0,
        versionRejected: resB.ok ? 0 : 1,
        versionPriorIntact:
          restoreStateFingerprint(resB.state) === restoreStateFingerprint(priorB) ? 1 : 0,
        versionNames: resB.reason.includes("2025-13") ? 1 : 0,
      };
    },
  },
  {
    id: "restore-valid-dates-control",
    kind: "restore",
    note: "Hardening S3 control: the same shapes with REAL dates and months — a transaction dated 2026-02-28 (February's actual last day), a summary for 2026-02, a bill version and a yearly-expense version effective 2026-02 / 2026-01 — restore and commit exactly as before the date checks existed, every added row landing in the restored state.",
    expected: { restored: 1, txns: 1, summaries: 1, billVersions: 1, expenseVersions: 1 },
    actual: () => {
      const raw = baseRestorePayload();
      (raw.transactions as Record<string, unknown>[]).push({
        id: 1, date: "2026-02-28", description: "Synthetic", amountCents: 100,
        sourceType: "checking", accountName: "Checking", kind: "spending",
        category: "Other", yearlyExpenseId: null, createdAt: 1700000000000,
      });
      (raw.monthlySummaries as Record<string, unknown>[]).push({
        month: "2026-02", cashOutCents: 100,
        createdAt: 1700000000000, updatedAt: 1700000000000,
      });
      (raw.monthlyBills as Record<string, unknown>[]).push({
        id: 1, name: "Rent", amountCents: 100000, paidBy: "Checking",
        notes: null, category: "Housing", keepLightsOn: 1, collapsed: 0,
        createdAt: 1700000000000,
      });
      (raw.monthlyBillVersions as Record<string, unknown>[]).push({
        id: 1, billId: 1, amountCents: 100000, effectiveFrom: "2026-02",
        createdAt: 1700000000000,
      });
      (raw.yearlyExpenses as Record<string, unknown>[]).push({
        id: 1, name: "AnnualSub", frequency: "yearly", expectedCents: 120000,
        dueMonth: 3, paidByType: "checking", paidByName: "Checking",
        backfillBeforeFirstVersion: 0, category: "Subscriptions",
        keepLightsOn: 0, createdAt: 1700000000000,
      });
      (raw.yearlyExpenseVersions as Record<string, unknown>[]).push({
        id: 1, expenseId: 1, expectedCents: 120000, frequency: "yearly",
        effectiveFrom: "2026-01", createdAt: 1700000000000,
      });
      const res = attemptRestore(restorePriorState(), raw, restoreKeyCheckValidFor(raw));
      return {
        restored: res.ok && res.committed ? 1 : 0,
        txns: res.state.transactions.length,
        summaries: res.state.monthlySummaries.length,
        billVersions: res.state.monthlyBillVersions.length,
        expenseVersions: res.state.yearlyExpenseVersions.length,
      };
    },
  },
  {
    id: "backup-isolation-list-own-plus-legacy",
    kind: "backup",
    note: "Cluster B case (a): two synthetic spaces under one workspace each create a backup (A on 2026-10-19, B on 2026-10-20) through the backupCore rules the privileged handlers run. A's list is exactly its own new backup plus the two legacy union files (3 entries, newest name first); it never shows B's backup. B's list mirrors that. The legacy folder's non-backup file (mst-crypt2.mjs) is never listed for either space.",
    expected: {
      aCount: 3, aSeesOwn: 1, aSeesB: 0, aSeesLegacy: 2,
      bCount: 3, bSeesOwn: 1, bSeesA: 0, nonBackupListed: 0,
    },
    actual: () => {
      const w = bkWorld();
      bkCreate(w, "A", "2026-10-19", "120000", "A-1019", 3000);
      bkCreate(w, "B", "2026-10-20", "120000", "B-1020", 3100);
      const a = bkList(w, "A");
      const b = bkList(w, "B");
      const has = (list: BackupFileEntry[], n: string) =>
        list.some((f) => f.name === n) ? 1 : 0;
      return {
        aCount: a.length,
        aSeesOwn: has(a, "backup-2026-10-19.mstbak"),
        aSeesB: has(a, "backup-2026-10-20.mstbak"),
        aSeesLegacy:
          has(a, "backup-2026-10-12.mstbak") +
          has(a, "backup-2026-10-18.mstbak"),
        bCount: b.length,
        bSeesOwn: has(b, "backup-2026-10-20.mstbak"),
        bSeesA: has(b, "backup-2026-10-19.mstbak"),
        nonBackupListed:
          has(a, "mst-crypt2.mjs") + has(b, "mst-crypt2.mjs"),
      };
    },
  },
  {
    id: "backup-prune-deleteall-leave-other-space",
    kind: "backup",
    note: "Cluster B case (b): space A creates 15 backups (2026-10-01..15, strictly increasing timestamps), so the per-space rotation prunes exactly 3 and keeps the newest 12 (2026-10-04..15). Space B's three own backups and the legacy folder stay byte-identical through A's prune. A's delete-all then removes exactly its own 12, leaving A's list as the legacy union only — and B's files and the legacy files are STILL byte-identical afterwards.",
    expected: {
      aOwnAfterCreates: 12, totalPruned: 3, aOldestSurvivorIsOct04: 1,
      bIntactAfterPrune: 1, legacyIntactAfterPrune: 1,
      deleteAllCount: 12, aOwnAfterDeleteAll: 0, aListAfterDeleteAll: 2,
      bIntactAfterDeleteAll: 1, legacyIntactAfterDeleteAll: 1,
    },
    actual: () => {
      const w = bkWorld();
      w.ownB.set("backup-2026-09-01.mstbak", { content: "B-0901", modifiedMs: 100 });
      w.ownB.set("backup-2026-09-02.mstbak", { content: "B-0902", modifiedMs: 200 });
      w.ownB.set("backup-2026-09-03.mstbak", { content: "B-0903", modifiedMs: 300 });
      const bSnap = bkSnapshot(w.ownB);
      const legacySnap = bkSnapshot(w.legacy);
      let totalPruned = 0;
      for (let d = 1; d <= 15; d++) {
        const dd = String(d).padStart(2, "0");
        totalPruned += bkCreate(
          w, "A", `2026-10-${dd}`, "120000", `A-10${dd}`, 10000 + d * 10,
        ).pruned;
      }
      const bIntactAfterPrune = bkFolderIntact(w.ownB, bSnap);
      const legacyIntactAfterPrune = bkFolderIntact(w.legacy, legacySnap);
      const aOwnAfterCreates = w.ownA.size;
      const aOldestSurvivorIsOct04 =
        w.ownA.has("backup-2026-10-04.mstbak") &&
        !w.ownA.has("backup-2026-10-03.mstbak")
          ? 1
          : 0;
      const deleted = bkDeleteAll(w, "A");
      return {
        aOwnAfterCreates,
        totalPruned,
        aOldestSurvivorIsOct04,
        bIntactAfterPrune,
        legacyIntactAfterPrune,
        deleteAllCount: deleted,
        aOwnAfterDeleteAll: w.ownA.size,
        aListAfterDeleteAll: bkList(w, "A").length,
        bIntactAfterDeleteAll: bkFolderIntact(w.ownB, bSnap),
        legacyIntactAfterDeleteAll: bkFolderIntact(w.legacy, legacySnap),
      };
    },
  },
  {
    id: "backup-legacy-listed-and-restorable",
    kind: "backup",
    note: "Cluster B case (c): with no per-space backups at all, the two legacy shared-folder backups are still listed with their real sizes (24 bytes each in the synthetic layout) and a read for either resolves to the legacy copy (backupReadSource = legacy), so they remain restorable. Deleting a legacy-only backup is refused and the file stays. When the space later creates its own backup with the SAME date as a legacy file, the listing still shows that name once — with the per-space copy's size (10 bytes) — reads resolve to the per-space copy, and the legacy file is untouched.",
    expected: {
      listCount: 2, size1018: 24, size1012: 24, legacyResolves: 1,
      deleteRefused: 1, legacyStillThere: 1,
      listCountAfterShadow: 2, ownWinsSize: 10, ownWinsRead: 1,
      legacyIntact: 1,
    },
    actual: () => {
      const w = bkWorld();
      const legacySnap = bkSnapshot(w.legacy);
      const list = bkList(w, "A");
      const entry = (n: string) => list.find((f) => f.name === n);
      const legacyResolves =
        backupReadSource(
          "backup-2026-10-18.mstbak",
          bkEntries(w.ownA),
          bkEntries(w.legacy),
        ) === "legacy"
          ? 1
          : 0;
      const del = bkDeleteOne(w, "A", "backup-2026-10-12.mstbak");
      const legacyStillThere = w.legacy.has("backup-2026-10-12.mstbak") ? 1 : 0;
      // Same date as the legacy 2026-10-18 file, in A's own folder.
      bkCreate(w, "A", "2026-10-18", "120000", "A-OWN-1018", 5000);
      const list2 = bkList(w, "A");
      const shadowed = list2.find((f) => f.name === "backup-2026-10-18.mstbak");
      return {
        listCount: list.length,
        size1018: entry("backup-2026-10-18.mstbak")?.sizeBytes ?? null,
        size1012: entry("backup-2026-10-12.mstbak")?.sizeBytes ?? null,
        legacyResolves,
        deleteRefused: del.ok ? 0 : 1,
        legacyStillThere,
        listCountAfterShadow: list2.length,
        ownWinsSize: shadowed?.sizeBytes ?? null,
        ownWinsRead:
          backupReadSource(
            "backup-2026-10-18.mstbak",
            bkEntries(w.ownA),
            bkEntries(w.legacy),
          ) === "own"
            ? 1
            : 0,
        legacyIntact: bkFolderIntact(w.legacy, legacySnap),
      };
    },
  },
  {
    id: "backup-same-date-no-collision",
    kind: "backup",
    note: "Cluster B case (d): spaces A and B each create a backup for the SAME date (2026-10-21). Because each writes into its own folder (perSpaceBackupsDir differs per space and is not the legacy dir), both get the plain date filename — no time suffix, no overwrite — and each space's listing shows its own copy's size (A's content is 14 bytes, B's is 15). The legacy dir resolves to the same canonical shared folder from both spaces.",
    expected: {
      aDirOk: 1, bDirOk: 1, dirsDistinct: 1, legacyShared: 1,
      aPlainName: 1, bPlainName: 1, aContentKept: 1, bContentKept: 1,
      aShownSize: 14, bShownSize: 15,
    },
    actual: () => {
      const w = bkWorld();
      const a = bkCreate(w, "A", "2026-10-21", "120000", "A-CONTENT-1021", 4000);
      const b = bkCreate(w, "B", "2026-10-21", "120000", "B-CONTENT-1021!", 4100);
      const aEntry = bkList(w, "A").find(
        (f) => f.name === "backup-2026-10-21.mstbak",
      );
      const bEntry = bkList(w, "B").find(
        (f) => f.name === "backup-2026-10-21.mstbak",
      );
      return {
        aDirOk:
          perSpaceBackupsDir(BK_SPACE_A) ===
            "/synthetic/workspace/ts-spaces/space-a/backups"
            ? 1
            : 0,
        bDirOk:
          perSpaceBackupsDir(BK_SPACE_B) ===
            "/synthetic/workspace/ts-spaces/space-b/backups"
            ? 1
            : 0,
        dirsDistinct:
          perSpaceBackupsDir(BK_SPACE_A) !== perSpaceBackupsDir(BK_SPACE_B) &&
          perSpaceBackupsDir(BK_SPACE_A) !== BK_LEGACY_DIR
            ? 1
            : 0,
        legacyShared:
          legacyBackupsDir(BK_SPACE_A) === BK_LEGACY_DIR &&
          legacyBackupsDir(BK_SPACE_B) === BK_LEGACY_DIR
            ? 1
            : 0,
        aPlainName: a.filename === "backup-2026-10-21.mstbak" ? 1 : 0,
        bPlainName: b.filename === "backup-2026-10-21.mstbak" ? 1 : 0,
        aContentKept:
          w.ownA.get("backup-2026-10-21.mstbak")?.content ===
            "A-CONTENT-1021"
            ? 1
            : 0,
        bContentKept:
          w.ownB.get("backup-2026-10-21.mstbak")?.content ===
            "B-CONTENT-1021!"
            ? 1
            : 0,
        aShownSize: aEntry?.sizeBytes ?? null,
        bShownSize: bEntry?.sizeBytes ?? null,
      };
    },
  },
  {
    id: "nw-write-update-unknown-account",
    kind: "networth",
    note: "Cluster C case (a): an UPDATE payload naming a nonexistent accountId (999) is refused by preflight before any write — before the header update and before the balance delete — so the attempt does not commit and the prior snapshot state (header + both balances) is byte-identical afterwards.",
    expected: { rejected: 1, committed: 0, priorIntact: 1, balancesKept: 2 },
    actual: () => {
      const prior = nwWritePriorState();
      const res = attemptNwSnapshotWrite(prior, {
        mode: "update",
        snapshotId: 10,
        date: "2025-03-02",
        note: null,
        balances: [{ accountId: 999, balanceCents: 500, splits: null }],
        accounts: NW_WRITE_ACCOUNT_LIST,
        classById: NW_WRITE_CLASS_BY_ID,
      });
      return {
        rejected: res.ok ? 0 : 1,
        committed: res.committed ? 1 : 0,
        priorIntact:
          nwWriteStateFingerprint(res.state) === nwWriteStateFingerprint(prior) ? 1 : 0,
        balancesKept: res.state.balances.length,
      };
    },
  },
  {
    id: "nw-write-add-unknown-account",
    kind: "networth",
    note: "Cluster C case (b): an ADD payload mixing one valid entry with a nonexistent accountId (999) is refused by preflight with zero writes — no snapshot header row for the attempted id/date exists afterwards and the prior state is byte-identical.",
    expected: { rejected: 1, committed: 0, headerExists: 0, snapshotCount: 1, priorIntact: 1 },
    actual: () => {
      const prior = nwWritePriorState();
      const res = attemptNwSnapshotWrite(prior, {
        mode: "add",
        snapshotId: 11,
        date: "2025-03-05",
        note: null,
        balances: [
          { accountId: 1, balanceCents: 100, splits: null },
          { accountId: 999, balanceCents: 500, splits: null },
        ],
        accounts: NW_WRITE_ACCOUNT_LIST,
        classById: NW_WRITE_CLASS_BY_ID,
      });
      return {
        rejected: res.ok ? 0 : 1,
        committed: res.committed ? 1 : 0,
        headerExists: res.state.snapshots.some((s) => s.id === 11) ? 1 : 0,
        snapshotCount: res.state.snapshots.length,
        priorIntact:
          nwWriteStateFingerprint(res.state) === nwWriteStateFingerprint(prior) ? 1 : 0,
      };
    },
  },
  {
    id: "nw-write-duplicate-account-rejected",
    kind: "networth",
    note: "Cluster C case (c): a payload listing the SAME accountId twice is refused with zero writes — even though the second Brokerage entry is unrecorded (null) and the old writer would have skipped it, so only the preflight duplicate check can catch this. Nothing is stored: no new snapshot header, prior state byte-identical. (Without the check, two recorded rows for one account would double-count it in the snapshot total.)",
    expected: { rejected: 1, committed: 0, snapshotCount: 1, priorIntact: 1 },
    actual: () => {
      const prior = nwWritePriorState();
      const res = attemptNwSnapshotWrite(prior, {
        mode: "add",
        snapshotId: 11,
        date: "2025-03-05",
        note: null,
        balances: [
          { accountId: 1, balanceCents: 1000, splits: null },
          { accountId: 1, balanceCents: null, splits: null },
        ],
        accounts: NW_WRITE_ACCOUNT_LIST,
        classById: NW_WRITE_CLASS_BY_ID,
      });
      return {
        rejected: res.ok ? 0 : 1,
        committed: res.committed ? 1 : 0,
        snapshotCount: res.state.snapshots.length,
        priorIntact:
          nwWriteStateFingerprint(res.state) === nwWriteStateFingerprint(prior) ? 1 : 0,
      };
    },
  },
  {
    id: "nw-write-duplicate-bucket-rejected",
    kind: "networth",
    note: "Cluster C case (d): an entry whose splits list the Cash bucket TWICE — [{Cash $300.00},{Cash $200.00}] — is refused with zero writes. The old writer folded duplicates last-wins, silently storing $200.00 and vanishing the $300.00; here the prior Brokerage balance ($111.00) survives, no $200.00 row exists anywhere, and the single-balance validation the updateNwBalance action runs (validateNwBalanceSplits, the same shared check) refuses the same splits too.",
    expected: {
      rejected: 1, committed: 0, priorIntact: 1, stored200: 0,
      brokerageKept: 11100, singleBalanceRejected: 1,
    },
    actual: () => {
      const prior = nwWritePriorState();
      const dupSplits = [
        { bucket: "Cash" as const, amountCents: 30000 },
        { bucket: "Cash" as const, amountCents: 20000 },
      ];
      const res = attemptNwSnapshotWrite(prior, {
        mode: "update",
        snapshotId: 10,
        date: "2025-03-01",
        note: "prior",
        balances: [{ accountId: 1, balanceCents: null, splits: dupSplits }],
        accounts: NW_WRITE_ACCOUNT_LIST,
        classById: NW_WRITE_CLASS_BY_ID,
      });
      const brokerage = res.state.balances.find((b) => b.accountId === 1);
      return {
        rejected: res.ok ? 0 : 1,
        committed: res.committed ? 1 : 0,
        priorIntact:
          nwWriteStateFingerprint(res.state) === nwWriteStateFingerprint(prior) ? 1 : 0,
        stored200: res.state.balances.some((b) => b.balanceCents === 200) ? 1 : 0,
        brokerageKept: brokerage?.balanceCents ?? null,
        singleBalanceRejected: validateNwBalanceSplits(dupSplits, "Brokerage").ok ? 0 : 1,
      };
    },
  },
  {
    id: "nw-write-atomic-mid-failure",
    kind: "networth",
    note: "Cluster C case (e): a valid UPDATE plan (header update, balance delete, then 3 balance inserts) is executed with a failure INJECTED at the second balance insert — after the header update, the delete, and one insert have already been applied to the working copy. The atomic executor commits nothing: the prior snapshot is fully intact, byte-identical. The same plan with no injected failure commits all 3 replacement balances (control). This mirrors the handler's single db.batch: all statements land or none do.",
    expected: {
      rolledBack: 1, priorIntact: 1, failedMidInserts: 1,
      controlCommits: 1, controlBalances: 3, controlFirstBalance: 1000,
    },
    actual: () => {
      const prior = nwWritePriorState();
      const rows = resolveNwSnapshotRows(
        [
          { accountId: 1, balanceCents: 1000, splits: null },
          { accountId: 4, balanceCents: 2000, splits: null },
          { accountId: 6, balanceCents: 3000, splits: null },
        ],
        NW_WRITE_CLASS_BY_ID,
      );
      const plan = buildNwSnapshotWritePlan({
        mode: "update",
        snapshotId: 10,
        date: "2025-03-02",
        note: null,
        rows,
      });
      const insertIdxs = plan
        .map((s, i) => (s.op === "insertBalance" ? i : -1))
        .filter((i) => i >= 0);
      const failAt = insertIdxs[1] ?? -1;
      const failed = executeNwWritePlanAtomically(prior, plan, failAt);
      const control = executeNwWritePlanAtomically(prior, plan, null);
      const controlFirst = control.state.balances.find((b) => b.accountId === 1);
      return {
        rolledBack: failed.committed ? 0 : 1,
        priorIntact:
          nwWriteStateFingerprint(failed.state) === nwWriteStateFingerprint(prior) ? 1 : 0,
        failedMidInserts: failAt > 2 && failed.failedAt === failAt ? 1 : 0,
        controlCommits: control.committed ? 1 : 0,
        controlBalances: control.state.balances.length,
        controlFirstBalance: controlFirst?.balanceCents ?? null,
      };
    },
  },
  {
    id: "nw-write-control-valid-payload",
    kind: "networth",
    note: "Cluster C case (f) control: a valid ADD mixing every entry shape stores exactly the rows and totals the pre-build writer semantics produce. Brokerage split Roth $200.00 + Taxable $300.00 stores $500.00 with those parts (its balanceCents 999999 is ignored, as documented); Old 401k whole $700.00; Savings unrecorded (null) stores NO row; the House (property) and Kid UTMA (custodial) entries carry a stray Cash split of 1¢ but store WHOLE ($500,000.00 / $25,000.00) with no split parts. Snapshot totals from the stored rows: property off $1,200.00 (split $500.00 + whole $700.00), property on $501,200.00 — the custodial $25,000.00 is reported separately and added nowhere.",
    expected: {
      ok: 1, committed: 1, headerStored: 1, rowCount: 4, unrecordedAbsent: 1,
      splitTotal: 50000, splitRoth: 20000, splitTaxable: 30000,
      wholeTotal: 70000,
      houseTotal: 50000000, houseParts: 0,
      utmaTotal: 2500000, utmaParts: 0,
      totalOff: 120000, totalOn: 50120000, custodialTotal: 2500000,
    },
    actual: () => {
      const prior: NwWriteState = { snapshots: [], balances: [] };
      const res = attemptNwSnapshotWrite(prior, {
        mode: "add",
        snapshotId: 20,
        date: "2025-03-10",
        note: null,
        balances: [
          {
            accountId: 1,
            balanceCents: 999999,
            splits: [
              { bucket: "Roth", amountCents: 20000 },
              { bucket: "Taxable", amountCents: 30000 },
            ],
          },
          { accountId: 4, balanceCents: 70000, splits: null },
          { accountId: 6, balanceCents: null, splits: null },
          {
            accountId: 2,
            balanceCents: 50000000,
            splits: [{ bucket: "Cash", amountCents: 1 }],
          },
          {
            accountId: 5,
            balanceCents: 2500000,
            splits: [{ bucket: "Cash", amountCents: 1 }],
          },
        ],
        accounts: NW_WRITE_ACCOUNT_LIST,
        classById: NW_WRITE_CLASS_BY_ID,
      });
      const rowFor = (id: number) => res.state.balances.find((b) => b.accountId === id);
      const brokerage = rowFor(1);
      const house = rowFor(2);
      const utma = rowFor(5);
      const totalsOff = snapshotTotals(res.state.balances, NW_WRITE_CLASS_BY_ID, false);
      const totalsOn = snapshotTotals(res.state.balances, NW_WRITE_CLASS_BY_ID, true);
      return {
        ok: res.ok ? 1 : 0,
        committed: res.committed ? 1 : 0,
        headerStored: res.state.snapshots.some((s) => s.id === 20) ? 1 : 0,
        rowCount: res.state.balances.length,
        unrecordedAbsent: rowFor(6) ? 0 : 1,
        splitTotal: brokerage?.balanceCents ?? null,
        splitRoth: brokerage?.splitRothCents ?? null,
        splitTaxable: brokerage?.splitTaxableCents ?? null,
        wholeTotal: rowFor(4)?.balanceCents ?? null,
        houseTotal: house?.balanceCents ?? null,
        houseParts: house ? splitPartsOf(house).length : null,
        utmaTotal: utma?.balanceCents ?? null,
        utmaParts: utma ? splitPartsOf(utma).length : null,
        totalOff: totalsOff.totalCents,
        totalOn: totalsOn.totalCents,
        custodialTotal: totalsOff.custodialTotalCents,
      };
    },
  },
  {
    id: "cleardata-missing-confirmation-rejected",
    kind: "cleardata",
    note: "Cluster D case (a): a clear-all attempt with NO confirmation at all (undefined — the shape a call carries when the field is absent; the action schema also makes confirm a required field) is refused by the shared gate before any delete: ok is false and every one of the 18 seeded rows across all twelve synthetic tables survives byte-identical, settings included.",
    expected: { rejected: 1, priorIntact: 1, totalRowsKept: 18, settingsKept: 6 },
    actual: () => {
      const prior = clearAllPriorState();
      const res = attemptClearAllData(prior, undefined);
      return {
        rejected: res.ok ? 0 : 1,
        priorIntact:
          clearAllStateFingerprint(res.state) === clearAllStateFingerprint(prior) ? 1 : 0,
        totalRowsKept: clearAllTotalRows(res.state),
        settingsKept: res.state.settings.length,
      };
    },
  },
  {
    id: "cleardata-wrong-confirmation-rejected",
    kind: "cleardata",
    note: "Cluster D case (b): four wrong confirmations — the empty string, the near-miss \"delete\", the case variant \"Delete everything\", and the exact phrase with a trailing space — are EACH refused with ok:false and zero deletes: after every attempt the full 18-row synthetic state is byte-identical. The gate is an exact, case-sensitive, untrimmed match, so only the precise phrase can ever open it.",
    expected: { allRejected: 1, allIntact: 1, wrongCount: 4 },
    actual: () => {
      const wrongs = ["", "delete", "Delete everything", "delete everything "];
      let allRejected = 1;
      let allIntact = 1;
      for (const w of wrongs) {
        const prior = clearAllPriorState();
        const res = attemptClearAllData(prior, w);
        if (res.ok) allRejected = 0;
        if (clearAllStateFingerprint(res.state) !== clearAllStateFingerprint(prior)) {
          allIntact = 0;
        }
      }
      return { allRejected, allIntact, wrongCount: wrongs.length };
    },
  },
  {
    id: "cleardata-exact-confirmation-wipes-all-twelve",
    kind: "cleardata",
    note: "Cluster D case (c): the exact confirmation \"delete everything\" opens the gate and the shared wipe plan — exactly 12 deleteAll statements, settings LAST — empties all twelve synthetic tables (18 rows to 0). The settings assertions are the honesty proof for the action's purpose text: the rows standing in for the Retirement calculator record, the Retirement baseline, the Roth plan record, and the Roth UI state are all deleted, as is the encryption key-check row — the wipe really does erase the saved planner data the purpose text now names.",
    expected: {
      ok: 1, planStatements: 12, planSettingsLast: 1,
      tablesEmptied: 12, totalRowsAfter: 0,
      retirementRecordGone: 1, retirementBaselineGone: 1,
      rothPlanGone: 1, rothUiStateGone: 1, keyCheckGone: 1,
    },
    actual: () => {
      const prior = clearAllPriorState();
      const plan = buildClearAllPlan();
      const res = attemptClearAllData(prior, CLEAR_ALL_CONFIRM_PHRASE);
      const settingGone = (key: string): number =>
        res.state.settings.some((r) => r.key === key) ? 0 : 1;
      return {
        ok: res.ok ? 1 : 0,
        planStatements: plan.length,
        planSettingsLast: plan[plan.length - 1]?.table === "settings" ? 1 : 0,
        tablesEmptied: clearAllEmptyTables(res.state),
        totalRowsAfter: clearAllTotalRows(res.state),
        retirementRecordGone: settingGone("retirement_calc_inputs_v1"),
        retirementBaselineGone: settingGone("retirement_calc_baseline_v1"),
        rothPlanGone: settingGone("roth_conversion_inputs_v1"),
        rothUiStateGone: settingGone(ROTH_UI_STATE_KEY),
        keyCheckGone: settingGone(BACKUP_KEY_CHECK_SETTING),
      };
    },
  },
  {
    id: "cleardata-success-shape-control",
    kind: "cleardata",
    note: "Cluster D case (d) control: a successful clear returns exactly { ok: true } — the identical success payload the action returned before the gate existed. The result object built from the confirmed attempt serialises to exactly {\"ok\":true} with a single key: the gate widened only the failure shape ({ ok: false }), never the success shape.",
    expected: { exactShape: 1, keyCount: 1 },
    actual: () => {
      const res = attemptClearAllData(clearAllPriorState(), "delete everything");
      const result = { ok: res.ok };
      return {
        exactShape: JSON.stringify(result) === '{"ok":true}' ? 1 : 0,
        keyCount: Object.keys(result).length,
      };
    },
  },
  {
    id: "encguard-prefix-value-rejected",
    kind: "encguard",
    note: "Cluster E derivation: by the decision table in encPrefixCore, a value with the reserved prefix that does NOT verify as ciphertext plans reject with RESERVED_ENC_PREFIX_MESSAGE, and a reject leaves the prior stored value byte-untouched. Hand-derived for each of the three payloads — the review's exact \"enc:v1:utilities\", the bare prefix \"enc:v1:\", and \"enc:v1:AAAA\" (prefix plus plausible-looking body, still not model ciphertext, so the verifier says no): 3 attempted, 3 rejected, 3 reasons exactly the reserved message, 3 prior values untouched.",
    expected: { attempted: 3, rejected: 3, reasonMatches: 3, priorUntouched: 3 },
    actual: () => {
      const prior = modelCiphertext("Prior $500");
      const payloads = ["enc:v1:utilities", "enc:v1:", "enc:v1:AAAA"];
      let rejected = 0;
      let reasonMatches = 0;
      let priorUntouched = 0;
      for (const p of payloads) {
        const res = attemptStoreTextField(prior, p, isModelCiphertext);
        if (!res.ok) rejected++;
        if (!res.ok && res.reason === RESERVED_ENC_PREFIX_MESSAGE) reasonMatches++;
        if (res.stored === prior) priorUntouched++;
      }
      return { attempted: payloads.length, rejected, reasonMatches, priorUntouched };
    },
  },
  {
    id: "encguard-all-writer-fields-reject",
    kind: "encguard",
    note: "Cluster E enumeration: the payload \"enc:v1:utilities\" is driven through the shared store flow once per user-text field — transactions.description, transactions.accountName, transactions.category, yearlyExpenses.name, yearlyExpenses.paidByName, yearlyExpenses.category, monthlyBills.name, monthlyBills.paidBy, monthlyBills.notes, monthlyBills.category, monthlyOneOffs.description, monthlyOneOffs.note, monthlyCashOutItems.description, monthlyCashOutItems.note, nwAccounts.name, nwSnapshots.note (16 fields). Every one of these fields is written only via encryptStr/encryptNullable in actions.ts, so the single guard covers all of them, and the fixture pins the shared decision for each field in turn. Hand-derived from the decision table (prefixed, unverifiable → reject): 16 attempted, 16 rejected, 16 reasons exactly the reserved message, 0 stored changes.",
    expected: { attempted: 16, rejected: 16, reasonMatches: 16, storedChanges: 0 },
    actual: () => {
      const fields = [
        "transactions.description",
        "transactions.accountName",
        "transactions.category",
        "yearlyExpenses.name",
        "yearlyExpenses.paidByName",
        "yearlyExpenses.category",
        "monthlyBills.name",
        "monthlyBills.paidBy",
        "monthlyBills.notes",
        "monthlyBills.category",
        "monthlyOneOffs.description",
        "monthlyOneOffs.note",
        "monthlyCashOutItems.description",
        "monthlyCashOutItems.note",
        "nwAccounts.name",
        "nwSnapshots.note",
      ];
      const prior = modelCiphertext("Existing value");
      let rejected = 0;
      let reasonMatches = 0;
      let storedChanges = 0;
      for (const field of fields) {
        void field;
        const res = attemptStoreTextField(prior, "enc:v1:utilities", isModelCiphertext);
        if (!res.ok) rejected++;
        if (!res.ok && res.reason === RESERVED_ENC_PREFIX_MESSAGE) reasonMatches++;
        if (res.stored !== prior) storedChanges++;
      }
      return { attempted: fields.length, rejected, reasonMatches, storedChanges };
    },
  },
  {
    id: "encguard-import-batch-refused-atomically",
    kind: "encguard",
    note: "Cluster E derivation, re-pinned at importCore (API follow-on 3, finding F12 — deliberate re-pin: the import plan seam moved from encPrefixCore's batch model to planImportBatch in importCore when importTransactions became atomic per call; the pinned DECISION is unchanged). planImportBatch plans EVERY row before returning — the batch's SECOND row carries \"enc:v1:utilities\" as its description, which does not verify as ciphertext, so by the decision table it plans reject, and one reject refuses the whole plan: ok false, the reason exactly the reserved message, and ZERO statements — not even a statement for the valid first row.",
    expected: { refused: 1, reasonMatches: 1, statements: 0 },
    actual: () => {
      const rows: ImportTextRow[] = [
        { description: "Rent $1,000", accountName: "Checking", category: "Housing" },
        { description: "enc:v1:utilities", accountName: "Checking", category: "Utilities" },
        { description: "Utilities $200", accountName: "Checking", category: "Utilities" },
      ];
      const plan = planImportBatch(rows, isModelCiphertext);
      return {
        refused: plan.ok ? 0 : 1,
        reasonMatches:
          !plan.ok && plan.reason === RESERVED_ENC_PREFIX_MESSAGE ? 1 : 0,
        statements: plan.statements.length,
      };
    },
  },
  {
    id: "import-plan-valid-batch-atomic-execution",
    kind: "encguard",
    note: "Import atomicity (API follow-on 3, finding F12): a valid 3-row batch — the third row's description is genuine model ciphertext, so it plans passthrough — plans exactly 3 statements. Executed cleanly through executeImportPlanAtomically (the plain-state model of the handler's single db.batch), all 3 rows append and the passthrough value is stored byte-identical. Executed with an injected failure at the SECOND statement, NOTHING commits: the stored list stays byte-identical to the prior list, so a failed call can never land a prefix the client's retry would duplicate.",
    expected: {
      planOk: 1, statements: 3,
      cleanCommitted: 1, cleanAppended: 3, passthroughKept: 1,
      failedCommitted: 0, failedAppended: 0, failedStoredUnchanged: 1,
    },
    actual: () => {
      const priorList = [modelCiphertext("Existing $100")];
      const genuine = modelCiphertext("Salary");
      const rows: ImportTextRow[] = [
        { description: "Rent $1,000", accountName: "Checking", category: "Housing" },
        { description: "Utilities $200", accountName: "Checking", category: "Utilities" },
        { description: genuine, accountName: "Checking", category: "Income" },
      ];
      const plan = planImportBatch(rows, isModelCiphertext);
      if (!plan.ok) {
        return {
          planOk: 0, statements: -1,
          cleanCommitted: 0, cleanAppended: -1, passthroughKept: 0,
          failedCommitted: 1, failedAppended: -1, failedStoredUnchanged: 0,
        };
      }
      const storeText = (v: string, p: TextStorePlan): string =>
        p.action === "passthrough" ? v : modelCiphertext(v);
      const clean = executeImportPlanAtomically(priorList, plan, rows, storeText);
      const failed = executeImportPlanAtomically(priorList, plan, rows, storeText, 1);
      const thirdRow = clean.stored[3] ? (JSON.parse(clean.stored[3]) as string[]) : [];
      return {
        planOk: 1,
        statements: plan.statements.length,
        cleanCommitted: clean.committed ? 1 : 0,
        cleanAppended: clean.stored.length - priorList.length,
        passthroughKept: thirdRow[0] === genuine ? 1 : 0,
        failedCommitted: failed.committed ? 1 : 0,
        failedAppended: failed.stored.length - priorList.length,
        failedStoredUnchanged:
          JSON.stringify(failed.stored) === JSON.stringify(priorList) ? 1 : 0,
      };
    },
  },
  {
    id: "import-debit-credit-pair-parsing",
    kind: "spending",
    note: "IM-2 dialect fix, hand-derived from combineDebitCreditAmount's rule (debit = money out by magnitude, credit = money in by magnitude, both filled nets debit − credit): a debit-only row \"84.20\" parses to +8420 cents with bothFilled unset — the single-amount path's value. A credit-only row \"250.00\" parses to −25000 (money in): before the fix this row's empty debit cell failed the amount parse and the row was silently skipped. A both-filled row (debit 100.00, credit 40.00) nets to +6000 with bothFilled set, so the preview can surface the combined-row count. Two empty cells and a garbled non-empty cell each yield null (row skipped — a garbled pair never imports one-sided), and a signed debit cell \"-30.00\" still counts by magnitude as +3000 of money out.",
    expected: {
      debitOnlyCents: 8420, debitOnlyBoth: 0,
      creditOnlyCents: -25000, creditOnlyBoth: 0,
      bothCents: 6000, bothFlag: 1,
      emptyIsNull: 1, garbledIsNull: 1, signedDebitCents: 3000,
    },
    actual: () => {
      const debitOnly = combineDebitCreditAmount("84.20", "");
      const creditOnly = combineDebitCreditAmount("", "250.00");
      const both = combineDebitCreditAmount("100.00", "40.00");
      const signedDebit = combineDebitCreditAmount("-30.00", "");
      return {
        debitOnlyCents: debitOnly?.cents ?? -999999,
        debitOnlyBoth: debitOnly?.bothFilled ? 1 : 0,
        creditOnlyCents: creditOnly?.cents ?? -999999,
        creditOnlyBoth: creditOnly?.bothFilled ? 1 : 0,
        bothCents: both?.cents ?? -999999,
        bothFlag: both?.bothFilled ? 1 : 0,
        emptyIsNull: combineDebitCreditAmount("", "") === null ? 1 : 0,
        garbledIsNull: combineDebitCreditAmount("abc", "") === null ? 1 : 0,
        signedDebitCents: signedDebit?.cents ?? -999999,
      };
    },
  },
  {
    id: "import-two-digit-year-dates",
    kind: "spending",
    note: "IM-2 dialect fix, hand-derived from the calendar: normalizeImportDate reads M/D/YY as 20YY — \"10/3/26\" is 2026-10-03 and the dash form \"10-3-26\" agrees. 2024 is a leap year so \"2/29/24\" is the real date 2024-02-29; 2026 is not, so \"2/29/26\" is refused, as are month 13 (\"13/1/26\") and the ISO impossible date \"2026-02-31\" (the pre-existing real-calendar rule, unchanged). The four-digit form \"10/3/2026\" still reads as 2026-10-03.",
    expected: {
      slashYY: 1, dashYY: 1, fourDigit: 1,
      leap24Accepted: 1, leap26Refused: 1,
      month13Refused: 1, isoImpossibleRefused: 1,
    },
    actual: () => ({
      slashYY: normalizeImportDate("10/3/26") === "2026-10-03" ? 1 : 0,
      dashYY: normalizeImportDate("10-3-26") === "2026-10-03" ? 1 : 0,
      fourDigit: normalizeImportDate("10/3/2026") === "2026-10-03" ? 1 : 0,
      leap24Accepted: normalizeImportDate("2/29/24") === "2024-02-29" ? 1 : 0,
      leap26Refused: normalizeImportDate("2/29/26") === null ? 1 : 0,
      month13Refused: normalizeImportDate("13/1/26") === null ? 1 : 0,
      isoImpossibleRefused: normalizeImportDate("2026-02-31") === null ? 1 : 0,
    }),
  },
  {
    id: "import-dedupe-flags-reimport-not-lookalikes",
    kind: "spending",
    note: "IM-1, hand-derived from flagImportDuplicates' match rule (date + amount + description + kind + account, description/account case-insensitive): against one recorded transaction (2026-10-03, 8420, \"Grocery store\", spending, Checking), an exact re-import of that row flags; a same-date same-amount row with a different description (\"Pharmacy\") does NOT flag — same amount alone is not a duplicate; the same row under a different kind (card_payment) or a different account (Card) does not flag either. A row repeated inside the file itself flags on its second appearance. Total flagged across the five rows: the exact re-import and the in-file repeat = 2.",
    expected: {
      flaggedTotal: 2, exactReimport: 1, diffDescription: 0,
      diffKind: 0, diffAccount: 0, withinFileRepeat: 1,
    },
    actual: () => {
      const existing = [
        { date: "2026-10-03", amountCents: 8420, description: "Grocery store", kind: "spending", accountName: "Checking" },
      ];
      const rows = [
        { date: "2026-10-03", amountCents: 8420, description: "Grocery store", kind: "spending", accountName: "Checking" },
        { date: "2026-10-03", amountCents: 8420, description: "Pharmacy", kind: "spending", accountName: "Checking" },
        { date: "2026-10-03", amountCents: 8420, description: "Grocery store", kind: "card_payment", accountName: "Checking" },
        { date: "2026-10-03", amountCents: 8420, description: "Grocery store", kind: "spending", accountName: "Card" },
        { date: "2026-10-03", amountCents: 8420, description: "Pharmacy", kind: "spending", accountName: "Checking" },
      ];
      const flags = flagImportDuplicates(rows, existing);
      return {
        flaggedTotal: flags.filter(Boolean).length,
        exactReimport: flags[0] ? 1 : 0,
        diffDescription: flags[1] ? 1 : 0,
        diffKind: flags[2] ? 1 : 0,
        diffAccount: flags[3] ? 1 : 0,
        withinFileRepeat: flags[4] ? 1 : 0,
      };
    },
  },
  {
    id: "import-profile-persistence-round-trip",
    kind: "spending",
    note: "IM-2, hand-derived: a profile saved for the header [Date, Description, Debit, Credit, Balance] with a user-overridden mapping (category pointed at column 4) and settings (card template is NOT used — checking, account \"Everyday\", money-out negative, custom keyword lists) survives a serialize → parse round trip byte-for-byte in effect: findImportProfile locates it from a case/whitespace-shifted copy of the same header (the fingerprint normalizes both), all seven mapping indices and all five settings fields come back identical, the blob's lastSettings is the profile's settings, and the automatic guess for this header independently maps the debit/credit pair (amount unmapped, debit 2, credit 3). withLastImportSettings then replaces lastSettings without touching the profile list (still 1 profile).",
    expected: {
      found: 1, fingerprintStable: 1, mappingKept: 1, settingsKept: 1,
      lastSettingsKept: 1, guessPair: 1, profilesAfterLastOnly: 1,
    },
    actual: () => {
      const header = ["Date", "Description", "Debit", "Credit", "Balance"];
      const mapping: ImportColumnMapping = {
        date: 0, description: 1, amount: -1, debit: 2, credit: 3, category: 4, kind: -1,
      };
      const settings: ImportFileSettings = {
        template: "checking",
        accountName: "Everyday",
        outSign: "negative",
        cardKeywords: "card payment, visa",
        transferKeywords: "transfer",
      };
      const saved = upsertImportProfile(EMPTY_IMPORT_SETTINGS, header, mapping, settings);
      const reloaded = parseImportSettings(serializeImportSettings(saved));
      const shifted = [" date ", "DESCRIPTION", "Debit", "Credit", "Balance"];
      const found = findImportProfile(reloaded, shifted);
      const mappingKept =
        found != null &&
        (Object.keys(mapping) as (keyof ImportColumnMapping)[]).every(
          (k) => found.mapping[k] === mapping[k],
        )
          ? 1
          : 0;
      const settingsKept =
        found != null &&
        found.settings.template === settings.template &&
        found.settings.accountName === settings.accountName &&
        found.settings.outSign === settings.outSign &&
        found.settings.cardKeywords === settings.cardKeywords &&
        found.settings.transferKeywords === settings.transferKeywords
          ? 1
          : 0;
      const guess = guessImportMapping(header.map((h) => h.toLowerCase()));
      const relast = withLastImportSettings(reloaded, {
        ...settings,
        accountName: "Other",
      });
      return {
        found: found ? 1 : 0,
        fingerprintStable:
          importHeaderFingerprint(shifted) === importHeaderFingerprint(header)
            ? 1
            : 0,
        mappingKept,
        settingsKept,
        lastSettingsKept:
          reloaded.lastSettings?.accountName === "Everyday" &&
          reloaded.lastSettings?.outSign === "negative"
            ? 1
            : 0,
        guessPair:
          guess.amount === -1 && guess.debit === 2 && guess.credit === 3
            ? 1
            : 0,
        profilesAfterLastOnly: relast.profiles.length,
      };
    },
  },
  {
    id: "nw-import-balance-file-matches-into-draft",
    kind: "networth",
    note: "IM-3 (a), hand-derived: the header [Account, Balance] is detected as a balance-file header and the guess maps label 0 / balance 1 / no date column. Of the body rows, the two labelled \"Brokerage\" ($100.00 and $50.50) name-match the Brokerage account and SUM into one new balance of $150.50 (15050¢); the \"Mystery fund\" row ($25.00) matches nothing and stays unmatched for the user to assign or skip. The Bank account is absent from the file, so its draft entry carries its last recorded balance ($200.00). The draft holds exactly the two app accounts.",
    expected: {
      headerDetected: 1, mapLabel: 0, mapBalance: 1, mapDate: -1,
      parsedRows: 3, skipped: 0, matchedRows: 2, unmatchedRows: 1,
      brokerageCents: 15050, bankCents: 20000, bankCarried: 1, entries: 2,
    },
    actual: () => {
      const header = ["Account", "Balance"];
      const mapping = guessNwBalanceMapping(header);
      const { rows, skipped } = parseNwBalanceRows(
        [
          ["Brokerage", "100.00"],
          ["Brokerage", "50.50"],
          ["Mystery fund", "25.00"],
        ],
        mapping,
      );
      const accounts = [
        { id: 1, name: "Brokerage" },
        { id: 2, name: "Bank" },
      ];
      const matched = matchNwImportRows(rows, accounts, {});
      const draft = buildNwImportDraft({
        accounts,
        rows: matched,
        lastBalances: {
          1: { balanceCents: 9000, splits: [] },
          2: { balanceCents: 20000, splits: [] },
        },
      });
      const e1 = draft.find((e) => e.accountId === 1);
      const e2 = draft.find((e) => e.accountId === 2);
      return {
        headerDetected: detectNwBalanceHeader(header) ? 1 : 0,
        mapLabel: mapping.label,
        mapBalance: mapping.balance,
        mapDate: mapping.date,
        parsedRows: rows.length,
        skipped,
        matchedRows: matched.filter((r) => r.target != null).length,
        unmatchedRows: matched.filter((r) => r.target == null).length,
        brokerageCents: e1?.balanceCents ?? -1,
        bankCents: e2?.balanceCents ?? -1,
        bankCarried: e2?.source === "carried" ? 1 : 0,
        entries: draft.length,
      };
    },
  },
  {
    id: "nw-import-proportional-split-sums-exactly",
    kind: "networth",
    note: "IM-3 (b), hand-derived: the last split is three equal $100.00 parts ($300.00 total). Applied to a new balance of $100.01, each share rounds to $33.34 — $100.02 in total — so the −1¢ remainder lands on the largest part (all three tied, so the first: Taxable): Taxable $33.33, Roth $33.34, Cash $33.34, summing EXACTLY to $100.01, the invariant a split's parts must satisfy. A clean $600.00 balance splits $200.00 each with no remainder. No prior parts, or parts summing to $0, propose no split at all (null).",
    expected: {
      taxable: 3333, roth: 3334, cash: 3334, sum: 10001,
      cleanEach: 20000, emptyIsNull: 1, zeroTotalIsNull: 1,
    },
    actual: () => {
      const last = [
        { bucket: "Taxable" as const, amountCents: 10000 },
        { bucket: "Roth" as const, amountCents: 10000 },
        { bucket: "Cash" as const, amountCents: 10000 },
      ];
      const parts = proportionalNwSplit(10001, last);
      const clean = proportionalNwSplit(60000, last);
      const get = (
        arr: { bucket: string; amountCents: number }[] | null,
        b: string,
      ): number => arr?.find((p) => p.bucket === b)?.amountCents ?? -1;
      return {
        taxable: get(parts, "Taxable"),
        roth: get(parts, "Roth"),
        cash: get(parts, "Cash"),
        sum: parts?.reduce((s, p) => s + p.amountCents, 0) ?? -1,
        cleanEach:
          clean != null && clean.every((p) => p.amountCents === 20000)
            ? 20000
            : -1,
        emptyIsNull: proportionalNwSplit(10001, []) === null ? 1 : 0,
        zeroTotalIsNull:
          proportionalNwSplit(10001, [{ bucket: "Cash", amountCents: 0 }]) ===
          null
            ? 1
            : 0,
      };
    },
  },
  {
    id: "nw-import-carried-account-labelled-and-removable",
    kind: "networth",
    note: "IM-3 (c), hand-derived: the file names only the Brokerage account ($600.00). The Bank account is absent from the file, so its draft entry is source \"carried\" at its last recorded balance ($750.00) with its last split (all Taxable) carried too — it is labelled \"not in file — carried\" in the draft and never silently zeroed by a partial file. A third account with no file row and no earlier balance drafts blank (null balance). Removing the carried entry (filterNwDraftEntries — the exact filter the panel's save path applies) leaves two entries whose balances total the file account's $600.00 only.",
    expected: {
      entries: 3, carriedCents: 75000, carriedSplitKept: 1, blankIsNull: 1,
      afterRemove: 2, afterRemoveHasBank: 0, afterRemoveSum: 60000,
    },
    actual: () => {
      const accounts = [
        { id: 1, name: "Brokerage" },
        { id: 2, name: "Bank" },
        { id: 3, name: "New account" },
      ];
      const matched = matchNwImportRows(
        parseNwBalanceRows([["Brokerage", "600.00"]], {
          label: 0,
          balance: 1,
          date: -1,
        }).rows,
        accounts,
        {},
      );
      const draft = buildNwImportDraft({
        accounts,
        rows: matched,
        lastBalances: {
          1: { balanceCents: 50000, splits: [] },
          2: {
            balanceCents: 75000,
            splits: [{ bucket: "Taxable", amountCents: 75000 }],
          },
        },
      });
      const bank = draft.find((e) => e.accountId === 2);
      const blank = draft.find((e) => e.accountId === 3);
      const kept = filterNwDraftEntries(draft, new Set([2]));
      return {
        entries: draft.length,
        carriedCents:
          bank?.source === "carried" ? (bank.balanceCents ?? -1) : -1,
        carriedSplitKept:
          bank?.splits?.length === 1 &&
          bank.splits[0]?.bucket === "Taxable" &&
          bank.splits[0]?.amountCents === 75000
            ? 1
            : 0,
        blankIsNull:
          blank?.source === "blank" && blank.balanceCents === null ? 1 : 0,
        afterRemove: kept.length,
        afterRemoveHasBank: kept.some((e) => e.accountId === 2) ? 1 : 0,
        afterRemoveSum: kept.reduce((s, e) => s + (e.balanceCents ?? 0), 0),
      };
    },
  },
  {
    id: "nw-import-exact-bucket-rows-beat-proportions",
    kind: "networth",
    note: "IM-3 (d), hand-derived: remembered sub-account mappings point the file's \"Brokerage Roth\" row ($40.00) at the Brokerage account's Roth bucket and its \"Brokerage Taxable\" row ($60.00) at the Taxable bucket. The account's last split was 90/10 (Taxable $90.00 / Roth $10.00 of $100.00), so proportional carry-over would propose Taxable $90.00 / Roth $10.00 against the new $100.00 balance — but the file's exact bucket amounts win instead: the draft balance is $100.00 with split Taxable $60.00 / Roth $40.00, splitSource \"exact\", and both rows report matchedBy \"remembered\".",
    expected: {
      balance: 10000, taxable: 6000, roth: 4000,
      exactSource: 1, rememberedMatches: 2,
    },
    actual: () => {
      const accounts = [{ id: 1, name: "Brokerage" }];
      const labelMappings = {
        "brokerage roth": { accountId: 1, bucket: "Roth" as const },
        "brokerage taxable": { accountId: 1, bucket: "Taxable" as const },
      };
      const matched = matchNwImportRows(
        parseNwBalanceRows(
          [
            ["Brokerage Roth", "40.00"],
            ["Brokerage Taxable", "60.00"],
          ],
          { label: 0, balance: 1, date: -1 },
        ).rows,
        accounts,
        labelMappings,
      );
      const draft = buildNwImportDraft({
        accounts,
        rows: matched,
        lastBalances: {
          1: {
            balanceCents: 10000,
            splits: [
              { bucket: "Taxable", amountCents: 9000 },
              { bucket: "Roth", amountCents: 1000 },
            ],
          },
        },
      });
      const e = draft[0];
      return {
        balance: e?.balanceCents ?? -1,
        taxable:
          e?.splits?.find((p) => p.bucket === "Taxable")?.amountCents ?? -1,
        roth: e?.splits?.find((p) => p.bucket === "Roth")?.amountCents ?? -1,
        exactSource: e?.splitSource === "exact" ? 1 : 0,
        rememberedMatches: matched.filter(
          (r) => r.matchedBy === "remembered",
        ).length,
      };
    },
  },
  {
    id: "nw-import-settings-round-trip",
    kind: "networth",
    note: "IM-3 setup persistence, hand-derived: a column profile saved for the header [Account, Balance, As of] (date hand-mapped to column 2) and a confirmed label mapping (\"brokerage roth\" → account 1's Roth bucket) survive a serialize → parse round trip: findNwImportProfile locates the profile from a case/whitespace-shifted copy of the same header (the shared fingerprint normalizes both), the mapping indices come back 0 / 1 / 2, and the label mapping's account and bucket are intact. A garbage stored value parses to the empty blob instead of throwing, so a damaged setup record can never block an import.",
    expected: {
      found: 1, mapLabel: 0, mapBalance: 1, mapDate: 2,
      labelAccount: 1, labelBucketKept: 1, garbageIsEmpty: 1,
    },
    actual: () => {
      const header = ["Account", "Balance", "As of"];
      let blob = upsertNwImportProfile(EMPTY_NW_IMPORT_SETTINGS, header, {
        label: 0,
        balance: 1,
        date: 2,
      });
      blob = withNwLabelMappings(blob, {
        "brokerage roth": { accountId: 1, bucket: "Roth" },
      });
      const reloaded = parseNwImportSettings(serializeNwImportSettings(blob));
      const found = findNwImportProfile(reloaded, [
        " account ",
        "BALANCE",
        "As of",
      ]);
      const lm = reloaded.labelMappings["brokerage roth"];
      const garbage = parseNwImportSettings("not json {");
      return {
        found: found ? 1 : 0,
        mapLabel: found?.mapping.label ?? -9,
        mapBalance: found?.mapping.balance ?? -9,
        mapDate: found?.mapping.date ?? -9,
        labelAccount: lm?.accountId ?? -1,
        labelBucketKept: lm?.bucket === "Roth" ? 1 : 0,
        garbageIsEmpty:
          garbage.profiles.length === 0 &&
          Object.keys(garbage.labelMappings).length === 0
            ? 1
            : 0,
      };
    },
  },
  {
    id: "cashout-proposal-includes-card-payments-excludes-transfers",
    kind: "spending",
    note: "IM-4 (a), hand-derived from buildCashOutProposals' rule (every money-out row counts, transfers excluded, money-in rows are not outflow): the October rows are a grocery spend $84.20, a card payment $1,500.00, a transfer out $500.00, a paycheck in −$2,500.00, an electric bill $120.50, and a transfer in −$300.00. The proposal holds the three money-out non-transfer rows and totals $84.20 + $1,500.00 + $120.50 = $1,704.70 (170470¢) — the card payment counts in full, neither transfer appears, and the deposit does not net against the total. The duplicate flag rides on the card-payment row (index 1): that item is marked isDuplicate and STILL counted, so the proposal shows the export's arithmetic as-is.",
    expected: {
      proposals: 1, totalCents: 170470, items: 3,
      cardPaymentItems: 1, dupMarked: 1, dupStillCounted: 170470,
    },
    actual: () => {
      const rows = [
        { date: "2026-10-03", description: "Grocery store", amountCents: 8420, kind: "spending" },
        { date: "2026-10-05", description: "Visa card payment", amountCents: 150000, kind: "card_payment" },
        { date: "2026-10-07", description: "Transfer to savings", amountCents: 50000, kind: "transfer" },
        { date: "2026-10-09", description: "Paycheck deposit", amountCents: -250000, kind: "spending" },
        { date: "2026-10-11", description: "Electric bill", amountCents: 12050, kind: "spending" },
        { date: "2026-10-12", description: "Transfer from savings", amountCents: -30000, kind: "transfer" },
      ];
      const flags = [false, true, false, false, false, false];
      const proposals = buildCashOutProposals(rows, flags);
      const p = proposals[0];
      return {
        proposals: proposals.length,
        totalCents: p?.totalCents ?? -1,
        items: p?.items.length ?? -1,
        cardPaymentItems: p?.items.filter((it) => it.kind === "card_payment").length ?? -1,
        dupMarked: p?.items.filter((it) => it.isDuplicate).length ?? -1,
        dupStillCounted: p?.totalCents ?? -1,
      };
    },
  },
  {
    id: "cashout-proposal-multi-month-grouping",
    kind: "spending",
    note: "IM-4 (b), hand-derived: one export spanning three months yields one proposal per month, months ascending, each totaling only its own rows. September: rent $1,400.00 + a card payment $200.00 = $1,600.00 across 2 items. October: groceries $50.00 only — its $999.00 transfer out is excluded. November: utilities $75.50, 1 item. The file lists October before September's second row; grouping is by each row's own date, not by file position.",
    expected: {
      proposals: 3, ascending: 1,
      sepTotal: 160000, sepItems: 2,
      octTotal: 5000, octItems: 1,
      novTotal: 7550, novItems: 1,
    },
    actual: () => {
      const rows = [
        { date: "2026-09-15", description: "Rent", amountCents: 140000, kind: "spending" },
        { date: "2026-10-02", description: "Groceries", amountCents: 5000, kind: "spending" },
        { date: "2026-09-20", description: "Card payment", amountCents: 20000, kind: "card_payment" },
        { date: "2026-11-01", description: "Utilities", amountCents: 7550, kind: "spending" },
        { date: "2026-10-31", description: "Transfer out", amountCents: 99900, kind: "transfer" },
      ];
      const proposals = buildCashOutProposals(rows);
      const byMonth = new Map(proposals.map((p) => [p.month, p]));
      return {
        proposals: proposals.length,
        ascending:
          proposals[0]?.month === "2026-09" &&
          proposals[1]?.month === "2026-10" &&
          proposals[2]?.month === "2026-11"
            ? 1
            : 0,
        sepTotal: byMonth.get("2026-09")?.totalCents ?? -1,
        sepItems: byMonth.get("2026-09")?.items.length ?? -1,
        octTotal: byMonth.get("2026-10")?.totalCents ?? -1,
        octItems: byMonth.get("2026-10")?.items.length ?? -1,
        novTotal: byMonth.get("2026-11")?.totalCents ?? -1,
        novItems: byMonth.get("2026-11")?.items.length ?? -1,
      };
    },
  },
  {
    id: "cashout-proposal-comparison-difference",
    kind: "spending",
    note: "IM-4 (c), hand-derived from compareCashOutProposal's rule (the recorded figure is the month's RESOLVED cash out — items sum when the month has items, else the entered total, else nothing): the proposal is $1,704.70. Against recorded items totalling $1,650.00 (3 items, entered total also present at $1,600.00) the items win, so the difference is $1,704.70 − $1,650.00 = +$54.70 (5470¢). Against an entered total alone of $1,800.00 the difference is −$95.30 (−9530¢). Against nothing recorded, both resolved and difference are null (encoded 1 in the IsNull fields). Against items alone totalling exactly $1,704.70 the difference is 0.",
    expected: {
      itemsWinResolved: 165000, itemsWinDiff: 5470,
      enteredOnlyResolved: 180000, enteredOnlyDiff: -9530,
      nothingResolvedIsNull: 1, nothingDiffIsNull: 1,
      exactMatchDiff: 0,
    },
    actual: () => {
      const proposal = buildCashOutProposals([
        { date: "2026-10-03", description: "Money out", amountCents: 170470, kind: "spending" },
      ])[0] ?? { month: "2026-10", totalCents: 0, items: [] };
      const itemsWin = compareCashOutProposal(proposal, {
        enteredTotalCents: 160000, itemsTotalCents: 165000, itemsCount: 3,
      });
      const enteredOnly = compareCashOutProposal(proposal, {
        enteredTotalCents: 180000, itemsTotalCents: 0, itemsCount: 0,
      });
      const nothing = compareCashOutProposal(proposal, {
        enteredTotalCents: null, itemsTotalCents: 0, itemsCount: 0,
      });
      const exact = compareCashOutProposal(proposal, {
        enteredTotalCents: null, itemsTotalCents: 170470, itemsCount: 2,
      });
      return {
        itemsWinResolved: itemsWin.recordedResolvedCents ?? -1,
        itemsWinDiff: itemsWin.differenceCents ?? -999999,
        enteredOnlyResolved: enteredOnly.recordedResolvedCents ?? -1,
        enteredOnlyDiff: enteredOnly.differenceCents ?? -999999,
        nothingResolvedIsNull: nothing.recordedResolvedCents === null ? 1 : 0,
        nothingDiffIsNull: nothing.differenceCents === null ? 1 : 0,
        exactMatchDiff: exact.differenceCents ?? -999999,
      };
    },
  },
  {
    id: "cashout-proposal-saved-foots-through-identity",
    kind: "spending",
    note: "IM-4 (d), hand-derived: the March 2025 proposal is rent $1,450.00 + a card payment $620.00 = $2,070.00 (207000¢); its $250.00 transfer and −$15.00 refund stay out. Saving it the way the panel does — the proposed items written as the month's cash-out items and the proposed total set as the month's entered total — makes the month's RESOLVED cash out, through spendingCore's standing identity (items sum wins over the entered total, which wins over transactions), exactly $2,070.00, even with a $9,999.99 checking transaction sitting in the same month: the transaction is not added in. Incurred follows cash out on an items month, so it reads $2,070.00 too.",
    expected: {
      proposedTotal: 207000, proposedItems: 2,
      resolvedCashOut: 207000, resolvedIncurred: 207000,
    },
    actual: () => {
      const rows = [
        { date: "2025-03-04", description: "Rent", amountCents: 145000, kind: "spending" },
        { date: "2025-03-06", description: "Mastercard payment", amountCents: 62000, kind: "card_payment" },
        { date: "2025-03-09", description: "Transfer to savings", amountCents: 25000, kind: "transfer" },
        { date: "2025-03-12", description: "Refund", amountCents: -1500, kind: "spending" },
      ];
      const proposal = buildCashOutProposals(rows)[0] ?? {
        month: "2025-03", totalCents: 0, items: [],
      };
      // The save, in the app's own stored shapes: the proposed
      // items as cash-out items, the proposed total as the
      // month's entered summary total.
      const core = createSpendingCore({
        txns: [
          { date: "2025-03-10", kind: "spending", sourceType: "checking", amountCents: 999999, yearlyExpenseId: null },
        ],
        yearly: [],
        yearlyVersions: [],
        summaries: [{ month: proposal.month, cashOutCents: proposal.totalCents }],
        cashOutItems: proposal.items.map((it) => ({
          month: proposal.month,
          amountCents: it.amountCents,
        })),
        bills: [],
        billVersions: [],
        oneOffs: [],
        openingReserveCents: 0,
        reserveStartSetting: null,
      });
      const e = core.eff(proposal.month);
      return {
        proposedTotal: proposal.totalCents,
        proposedItems: proposal.items.length,
        resolvedCashOut: e.cashOut,
        resolvedIncurred: e.incurred,
      };
    },
  },
  {
    id: "ofx-sgml-and-xml-parse-to-csv-twin-rows",
    kind: "spending",
    note: "IM-5 (a), hand-derived: an OFX 1.x SGML statement (unclosed leaf tags, FI block naming Example Bank, account 000123456789) carries three transactions — 2026-10-03 Grocery store −84.20 (FITID FIT20261003001), 2026-10-05 Visa card payment −1500.00 (FIT20261005001), 2026-10-07 Payroll deposit +2500.00 (FIT20261007001) — and a ledger balance of 4321.55 as of 2026-10-15. The parser returns exactly those rows in the file's own sign terms (money out negative: −8420, −150000, +250000 cents) and they equal, row for row, the rows its CSV twin produces through the shared CSV row reading (normalizeImportDate + parseImportAmount). The OFX 2.x XML rendering of the same statement (every tag closed) parses to the identical three rows.",
    expected: {
      ok: 1, accounts: 1, skipped: 0, txns: 3,
      firstDate: 1, firstCents: -8420, secondCents: -150000, thirdCents: 250000,
      firstFitId: 1, ledgerCents: 432155, ledgerDate: 1,
      twinRowsEqual: 1, xmlRowsEqual: 1, institution: 1, accountKind: 1,
    },
    actual: () => {
      const sgml = [
        "OFXHEADER:100",
        "DATA:OFXSGML",
        "VERSION:102",
        "SECURITY:NONE",
        "ENCODING:USASCII",
        "",
        "<OFX>",
        "<SIGNONMSGSRSV1>",
        "<SONRS>",
        "<STATUS>",
        "<CODE>0",
        "<SEVERITY>INFO",
        "</STATUS>",
        "<DTSERVER>20261015000000[-5:EST]",
        "<LANGUAGE>ENG",
        "<FI>",
        "<ORG>Example Bank",
        "<FID>9999",
        "</FI>",
        "</SONRS>",
        "</SIGNONMSGSRSV1>",
        "<BANKMSGSRSV1>",
        "<STMTTRNRS>",
        "<TRNUID>1",
        "<STMTRS>",
        "<CURDEF>USD",
        "<BANKACCTFROM>",
        "<BANKID>021000021",
        "<ACCTID>000123456789",
        "<ACCTTYPE>CHECKING",
        "</BANKACCTFROM>",
        "<BANKTRANLIST>",
        "<DTSTART>20261001000000[-5:EST]",
        "<DTEND>20261015000000[-5:EST]",
        "<STMTTRN>",
        "<TRNTYPE>DEBIT",
        "<DTPOSTED>20261003000000[-5:EST]",
        "<TRNAMT>-84.20",
        "<FITID>FIT20261003001",
        "<NAME>Grocery store",
        "</STMTTRN>",
        "<STMTTRN>",
        "<TRNTYPE>DEBIT",
        "<DTPOSTED>20261005",
        "<TRNAMT>-1500.00",
        "<FITID>FIT20261005001",
        "<NAME>Visa card payment",
        "</STMTTRN>",
        "<STMTTRN>",
        "<TRNTYPE>CREDIT",
        "<DTPOSTED>20261007",
        "<TRNAMT>2500.00",
        "<FITID>FIT20261007001",
        "<NAME>Payroll deposit",
        "</STMTTRN>",
        "</BANKTRANLIST>",
        "<LEDGERBAL>",
        "<BALAMT>4321.55",
        "<DTASOF>20261015000000[-5:EST]",
        "</LEDGERBAL>",
        "</STMTRS>",
        "</STMTTRNRS>",
        "</BANKMSGSRSV1>",
        "</OFX>",
      ].join("\n");
      const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<?OFX OFXHEADER="200" VERSION="211"?>',
        "<OFX>",
        "<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>",
        "<DTSERVER>20261015000000[-5:EST]</DTSERVER><LANGUAGE>ENG</LANGUAGE>",
        "<FI><ORG>Example Bank</ORG><FID>9999</FID></FI>",
        "</SONRS></SIGNONMSGSRSV1>",
        "<BANKMSGSRSV1><STMTTRNRS><TRNUID>1</TRNUID><STMTRS>",
        "<CURDEF>USD</CURDEF>",
        "<BANKACCTFROM><BANKID>021000021</BANKID><ACCTID>000123456789</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>",
        "<BANKTRANLIST><DTSTART>20261001000000[-5:EST]</DTSTART><DTEND>20261015000000[-5:EST]</DTEND>",
        "<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261003000000[-5:EST]</DTPOSTED><TRNAMT>-84.20</TRNAMT><FITID>FIT20261003001</FITID><NAME>Grocery store</NAME></STMTTRN>",
        "<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261005</DTPOSTED><TRNAMT>-1500.00</TRNAMT><FITID>FIT20261005001</FITID><NAME>Visa card payment</NAME></STMTTRN>",
        "<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20261007</DTPOSTED><TRNAMT>2500.00</TRNAMT><FITID>FIT20261007001</FITID><NAME>Payroll deposit</NAME></STMTTRN>",
        "</BANKTRANLIST>",
        "<LEDGERBAL><BALAMT>4321.55</BALAMT><DTASOF>20261015000000[-5:EST]</DTASOF></LEDGERBAL>",
        "</STMTRS></STMTTRNRS></BANKMSGSRSV1>",
        "</OFX>",
      ].join("\n");
      const res = parseOfx(sgml);
      if (!res.ok) {
        return {
          ok: 0, accounts: 0, skipped: -1, txns: 0,
          firstDate: 0, firstCents: 0, secondCents: 0, thirdCents: 0,
          firstFitId: 0, ledgerCents: 0, ledgerDate: 0,
          twinRowsEqual: 0, xmlRowsEqual: 0, institution: 0, accountKind: 0,
        };
      }
      const acct = res.accounts[0];
      const txns = acct?.transactions ?? [];
      const rowKey = (t: { date: string; amountCents: number; description: string; fitId: string | null }): string =>
        [t.date, String(t.amountCents), t.description, t.fitId ?? ""].join("|");
      // The CSV twin, read through the same shared row functions
      // the CSV panel path uses.
      const twinText = [
        "2026-10-03,Grocery store,-84.20",
        "2026-10-05,Visa card payment,-1500.00",
        "2026-10-07,Payroll deposit,2500.00",
      ];
      const twinKeys = twinText.map((line) => {
        const [d = "", desc = "", amt = ""] = line.split(",");
        return [
          normalizeImportDate(d) ?? "?",
          String(parseImportAmount(amt) ?? NaN),
          desc,
          "",
        ].join("|");
      });
      const ofxKeys = txns.map((t) =>
        [t.date, String(t.amountCents), t.description, ""].join("|"),
      );
      const xmlRes = parseOfx(xml);
      const xmlKeys =
        xmlRes.ok && xmlRes.accounts[0]
          ? xmlRes.accounts[0].transactions.map(rowKey)
          : [];
      return {
        ok: 1,
        accounts: res.accounts.length,
        skipped: res.skippedTxns,
        txns: txns.length,
        firstDate: txns[0]?.date === "2026-10-03" ? 1 : 0,
        firstCents: txns[0]?.amountCents ?? 0,
        secondCents: txns[1]?.amountCents ?? 0,
        thirdCents: txns[2]?.amountCents ?? 0,
        firstFitId: txns[0]?.fitId === "FIT20261003001" ? 1 : 0,
        ledgerCents: acct?.ledgerBalanceCents ?? 0,
        ledgerDate: acct?.ledgerDate === "2026-10-15" ? 1 : 0,
        twinRowsEqual:
          JSON.stringify(ofxKeys) === JSON.stringify(twinKeys) ? 1 : 0,
        xmlRowsEqual:
          JSON.stringify(xmlKeys) === JSON.stringify(txns.map(rowKey))
            ? 1
            : 0,
        institution: acct?.institution === "Example Bank" ? 1 : 0,
        accountKind: acct?.kind === "bank" ? 1 : 0,
      };
    },
  },
  {
    id: "ofx-fitid-exact-dedupe-vs-fuzzy-lookalike",
    kind: "spending",
    note: "IM-5 (b), hand-derived from flagExactFitIdDuplicates' rule (the bank id alone decides; a repeated id inside the file flags on its second appearance) against recorded FITIDs FIT-A and FIT-B: a row carrying FIT-A flags EXACT even though its date, amount, and description match nothing recorded — the id is the identity. A row with the NEW id FIT-NEW whose date/amount/description/kind/account exactly equal a recorded transaction does NOT flag exact, while the fuzzy IM-1 check flags that same row as a look-alike — the two labels stay distinct. FIT-B flags exact (recorded); a FITID-less row never flags exact; FIT-NEW repeated inside the file flags exact on its second appearance. Exact flags: [1, 0, 1, 0, 1] = 3.",
    expected: {
      exactTotal: 3, recordedIdAlone: 1, newIdNotExact: 0,
      newIdFuzzy: 1, secondRecordedId: 1, noIdNeverExact: 0,
      inFileRepeatExact: 1,
    },
    actual: () => {
      const recorded = [
        { date: "2026-10-03", amountCents: 8420, description: "Grocery store", kind: "spending", accountName: "Checking", fitId: "FIT-A" },
        { date: "2026-10-04", amountCents: 1200, description: "Coffee", kind: "spending", accountName: "Checking", fitId: "FIT-B" },
      ];
      const rows = [
        { date: "2026-09-01", amountCents: 555, description: "Unrelated", kind: "spending", accountName: "Checking", fitId: "FIT-A" },
        { date: "2026-10-03", amountCents: 8420, description: "Grocery store", kind: "spending", accountName: "Checking", fitId: "FIT-NEW" },
        { date: "2026-10-04", amountCents: 1200, description: "Coffee", kind: "spending", accountName: "Checking", fitId: "FIT-B" },
        { date: "2026-10-03", amountCents: 8420, description: "Grocery store", kind: "spending", accountName: "Checking", fitId: null },
        { date: "2026-10-03", amountCents: 8420, description: "Grocery store", kind: "spending", accountName: "Checking", fitId: "FIT-NEW" },
      ];
      const exact = flagExactFitIdDuplicates(rows, recorded);
      const fuzzy = flagImportDuplicates(rows, recorded);
      return {
        exactTotal: exact.filter(Boolean).length,
        recordedIdAlone: exact[0] ? 1 : 0,
        newIdNotExact: exact[1] ? 1 : 0,
        newIdFuzzy: fuzzy[1] ? 1 : 0,
        secondRecordedId: exact[2] ? 1 : 0,
        noIdNeverExact: exact[3] ? 1 : 0,
        inFileRepeatExact: exact[4] ? 1 : 0,
      };
    },
  },
  {
    id: "ofx-fitid-exact-dedupe-account-scoped",
    kind: "spending",
    note: "IM-5 account scoping (round-7 fix 6.1), hand-derived from flagExactFitIdDuplicates' scoped rule: a FITID is unique only within its own account, so the seen-set keys on account + FITID. Recorded: FIT-X in Checking, FIT-Y in Savings. A file row carrying FIT-X under Savings does NOT flag exact — the id is recorded, but for a different account (the pre-fix flat set false-flagged it); the same FIT-X under Checking DOES flag (recorded there). FIT-Y under Savings flags (recorded there); FIT-Y under Checking does not. Within the file, FIT-X under Savings appearing a second time flags on its second appearance — the in-file repeat rule is scoped the same way — while a FITID-less row never flags. Exact flags: [0, 1, 1, 0, 1, 0] = 3.",
    expected: {
      exactTotal: 3, otherAccountNotExact: 0, recordedAccountExact: 1,
      secondAccountExact: 1, wrongAccountForSecondId: 0,
      inFileRepeatScopedExact: 1, noIdNeverExact: 0,
    },
    actual: () => {
      const recorded = [
        { date: "2026-10-03", amountCents: 8420, description: "Grocery store", kind: "spending", accountName: "Checking", fitId: "FIT-X" },
        { date: "2026-10-04", amountCents: 1200, description: "Coffee", kind: "spending", accountName: "Savings", fitId: "FIT-Y" },
      ];
      const rows = [
        { date: "2026-09-01", amountCents: 555, description: "Unrelated", kind: "spending", accountName: "Savings", fitId: "FIT-X" },
        { date: "2026-09-02", amountCents: 556, description: "Unrelated 2", kind: "spending", accountName: "Checking", fitId: "FIT-X" },
        { date: "2026-09-03", amountCents: 557, description: "Unrelated 3", kind: "spending", accountName: "Savings", fitId: "FIT-Y" },
        { date: "2026-09-04", amountCents: 558, description: "Unrelated 4", kind: "spending", accountName: "Checking", fitId: "FIT-Y" },
        { date: "2026-09-05", amountCents: 559, description: "Unrelated 5", kind: "spending", accountName: "Savings", fitId: "FIT-X" },
        { date: "2026-09-06", amountCents: 560, description: "Unrelated 6", kind: "spending", accountName: "Savings", fitId: null },
      ];
      const exact = flagExactFitIdDuplicates(rows, recorded);
      return {
        exactTotal: exact.filter(Boolean).length,
        otherAccountNotExact: exact[0] ? 1 : 0,
        recordedAccountExact: exact[1] ? 1 : 0,
        secondAccountExact: exact[2] ? 1 : 0,
        wrongAccountForSecondId: exact[3] ? 1 : 0,
        inFileRepeatScopedExact: exact[4] ? 1 : 0,
        noIdNeverExact: exact[5] ? 1 : 0,
      };
    },
  },
  {
    id: "ofx-dtposted-timezone-suffix-lands-on-stated-date",
    kind: "spending",
    note: "IM-5 (c), hand-derived from the calendar: DTPOSTED carries the bank's stated posted date first — the time and timezone suffix that follow never shift it. \"20261003000000[-5:EST]\" lands on 2026-10-03; a late-evening timestamp in a +10 zone, \"20260228235959[+10:AEST]\", still lands on its stated 2026-02-28 (no conversion to the viewer's zone); the bare \"20261003\" form agrees. Impossible dates are refused outright: \"20260231000000[0:UTC]\" (February 31st) and month 13 both return null, and end-to-end through parseOfx a statement whose only transaction is dated 2026-02-31 yields zero transactions with one skipped row counted.",
    expected: {
      estSuffix: 1, plusTenSuffix: 1, bareDate: 1,
      feb31Refused: 1, month13Refused: 1,
      badDateTxnSkipped: 1, badDateSkippedCount: 1,
    },
    actual: () => {
      const badFile = [
        "OFXHEADER:100",
        "DATA:OFXSGML",
        "",
        "<OFX>",
        "<BANKMSGSRSV1>",
        "<STMTTRNRS>",
        "<STMTRS>",
        "<CURDEF>USD",
        "<BANKACCTFROM>",
        "<BANKID>021000021",
        "<ACCTID>000123456789",
        "<ACCTTYPE>CHECKING",
        "</BANKACCTFROM>",
        "<BANKTRANLIST>",
        "<STMTTRN>",
        "<TRNTYPE>DEBIT",
        "<DTPOSTED>20260231000000[0:UTC]",
        "<TRNAMT>-10.00",
        "<FITID>BAD1",
        "<NAME>Impossible date row",
        "</STMTTRN>",
        "</BANKTRANLIST>",
        "</STMTRS>",
        "</STMTTRNRS>",
        "</BANKMSGSRSV1>",
        "</OFX>",
      ].join("\n");
      const res = parseOfx(badFile);
      return {
        estSuffix: parseOfxDate("20261003000000[-5:EST]") === "2026-10-03" ? 1 : 0,
        plusTenSuffix: parseOfxDate("20260228235959[+10:AEST]") === "2026-02-28" ? 1 : 0,
        bareDate: parseOfxDate("20261003") === "2026-10-03" ? 1 : 0,
        feb31Refused: parseOfxDate("20260231000000[0:UTC]") === null ? 1 : 0,
        month13Refused: parseOfxDate("20261301000000") === null ? 1 : 0,
        badDateTxnSkipped:
          res.ok && (res.accounts[0]?.transactions.length ?? -1) === 0 ? 1 : 0,
        badDateSkippedCount: res.ok ? res.skippedTxns : -1,
      };
    },
  },
  {
    id: "ofx-ledger-balance-arrives-in-nw-draft",
    kind: "networth",
    note: "IM-5 (d), hand-derived: the Example Bank OFX statement's LEDGERBAL is 4321.55 as of 2026-10-15. balanceRowsFromOfx turns it into exactly one balance row — 432155 cents, dated 2026-10-15, labelled with the MASKED display \"Example Bank ····6789\" (the full account id never appears in the label) and carrying the account key as its matchKey. A remembered mapping under that key matches the row to the Everyday checking account (matchedBy \"remembered\"); the draft then holds that account as a file entry at exactly 432155 cents, the second account (no file row, no earlier balance) drafts blank, and the shared statement-date rule reads the rows' date — the ledger as-of date — as the draft's date.",
    expected: {
      rows: 1, balanceCents: 432155, rowDate: 1, maskedLabel: 1,
      matchedRemembered: 1, draftFileCents: 432155, draftBlankSecond: 1,
      statementDate: 1, skippedAccounts: 0,
    },
    actual: () => {
      const text = [
        "OFXHEADER:100",
        "DATA:OFXSGML",
        "",
        "<OFX>",
        "<SIGNONMSGSRSV1>",
        "<SONRS>",
        "<STATUS>",
        "<CODE>0",
        "<SEVERITY>INFO",
        "</STATUS>",
        "<FI>",
        "<ORG>Example Bank",
        "<FID>9999",
        "</FI>",
        "</SONRS>",
        "</SIGNONMSGSRSV1>",
        "<BANKMSGSRSV1>",
        "<STMTTRNRS>",
        "<STMTRS>",
        "<CURDEF>USD",
        "<BANKACCTFROM>",
        "<BANKID>021000021",
        "<ACCTID>000123456789",
        "<ACCTTYPE>CHECKING",
        "</BANKACCTFROM>",
        "<BANKTRANLIST>",
        "<STMTTRN>",
        "<TRNTYPE>DEBIT",
        "<DTPOSTED>20261003",
        "<TRNAMT>-84.20",
        "<FITID>FIT1",
        "<NAME>Grocery store",
        "</STMTTRN>",
        "</BANKTRANLIST>",
        "<LEDGERBAL>",
        "<BALAMT>4321.55",
        "<DTASOF>20261015",
        "</LEDGERBAL>",
        "</STMTRS>",
        "</STMTTRNRS>",
        "</BANKMSGSRSV1>",
        "</OFX>",
      ].join("\n");
      const res = parseOfx(text);
      if (!res.ok) {
        return {
          rows: 0, balanceCents: 0, rowDate: 0, maskedLabel: 0,
          matchedRemembered: 0, draftFileCents: 0, draftBlankSecond: 0,
          statementDate: 0, skippedAccounts: -1,
        };
      }
      const built = balanceRowsFromOfx(res.accounts);
      const row = built.rows[0];
      const accounts = [
        { id: 1, name: "Everyday checking" },
        { id: 2, name: "Savings" },
      ];
      const labelMappings =
        row?.matchKey != null
          ? {
              [normalizeNwLabel(row.matchKey)]: {
                accountId: 1,
                bucket: null,
              },
            }
          : {};
      const matched = matchNwImportRows(built.rows, accounts, labelMappings);
      const draft = buildNwImportDraft({
        accounts,
        rows: matched,
        lastBalances: {},
      });
      const first = draft.find((e) => e.accountId === 1);
      const second = draft.find((e) => e.accountId === 2);
      return {
        rows: built.rows.length,
        balanceCents: row?.balanceCents ?? 0,
        rowDate: row?.date === "2026-10-15" ? 1 : 0,
        maskedLabel:
          row?.label === ofxAccountDisplay({
            kind: "bank",
            institution: "Example Bank",
            accountId: "000123456789",
          }) &&
          row?.label === "Example Bank ····6789"
            ? 1
            : 0,
        matchedRemembered: matched[0]?.matchedBy === "remembered" ? 1 : 0,
        draftFileCents:
          first?.source === "file" ? (first.balanceCents ?? 0) : 0,
        draftBlankSecond:
          second?.source === "blank" && second.balanceCents === null
            ? 1
            : 0,
        statementDate:
          nwImportStatementDate(built.rows) === "2026-10-15" ? 1 : 0,
        skippedAccounts: built.skippedAccounts,
      };
    },
  },
  {
    id: "encguard-near-miss-values-round-trip",
    kind: "encguard",
    note: "Cluster E derivation: the predicate is case-sensitive, position-0 only, no trimming, so each of these six values has NO reserved prefix and plans encrypt by the decision table: \"enc:v1\" (no colon), \" enc:v1:x\" (leading space), \"ENC:V1:x\" (case), \"paid the enc:v1: fee\" (prefix not at start), \"enc:v2:other\" (other version), and \"\" (empty). Hand-derived: 6 of 6 store via the encrypt branch (stored is exactly modelCiphertext of the input) and modelPlaintext reads each back byte-identical.",
    expected: { total: 6, storedOk: 6, encryptBranch: 6, roundTripped: 6 },
    actual: () => {
      const values = [
        "enc:v1",
        " enc:v1:x",
        "ENC:V1:x",
        "paid the enc:v1: fee",
        "enc:v2:other",
        "",
      ];
      const prior = modelCiphertext("Prior");
      let storedOk = 0;
      let encryptBranch = 0;
      let roundTripped = 0;
      for (const v of values) {
        const res = attemptStoreTextField(prior, v, isModelCiphertext);
        if (res.ok) storedOk++;
        if (res.ok && res.stored === modelCiphertext(v)) encryptBranch++;
        if (res.ok && modelPlaintext(res.stored) === v) roundTripped++;
      }
      return { total: values.length, storedOk, encryptBranch, roundTripped };
    },
  },
  {
    id: "encguard-genuine-ciphertext-passthrough-control",
    kind: "encguard",
    note: "Cluster E control derivation: a stored modelCiphertext(\"Rent $1,000\") carries the reserved prefix AND verifies as ciphertext (the fixture verifier recognises model ciphertext), so by the decision table it plans passthrough — re-storing it leaves the stored string byte-identical and the lenient reader still reads \"Rent $1,000\". This pins that genuinely encrypted values keep flowing exactly as before (in production the verifier is the real decrypt; every existing stored value is this case).",
    expected: { ok: 1, planPassthrough: 1, byteIdentical: 1, readsBack: 1 },
    actual: () => {
      const stored0 = modelCiphertext("Rent $1,000");
      const plan = planTextStore(stored0, isModelCiphertext);
      const res = attemptStoreTextField(
        modelCiphertext("Other value"),
        stored0,
        isModelCiphertext,
      );
      return {
        ok: res.ok ? 1 : 0,
        planPassthrough: plan.action === "passthrough" ? 1 : 0,
        byteIdentical: res.stored === stored0 ? 1 : 0,
        readsBack: modelPlaintext(res.stored) === "Rent $1,000" ? 1 : 0,
      };
    },
  },
  {
    id: "api-balance-semantics-content-and-base-omission",
    kind: "apicontract",
    note: "Balance semantics (API follow-on 2, finding F9; R4-3, finding F8): describeApi publishes BALANCE_SEMANTICS verbatim (the handler returns this exact constant), and it must state BOTH rules — the required phrases pin them: the base layer's keys are 'REQUIRED and nullable', a blank means 'follow the snapshot', 'omitting the key fails validation', an override null 'is NOT a blank' and is 'never re-resolved against the snapshot', plus the taxableExcludeCents clause ('inert beside an explicit taxableCents'). The spouse exception is pinned too (R4-3 F8): 'pretaxSpouseCents is the one exception', 'carved out of the primary's', 'carves out $0' — the key has no snapshot bucket of its own and a blank carves out $0. At the base layer itself, the shipped balance field schemas (rothBaseBalancesIn, built from the same rothBalanceField definitions rothInputFields references) accept all five keys present-and-null, REJECT a payload that omits hsaCents, and reject a fractional balance.",
    expected: {
      phrasesFound: 9,
      allNullAccepted: 1,
      omissionRejected: 1,
      fractionalRejected: 1,
    },
    actual: () => {
      const phrases = [
        "REQUIRED and nullable",
        "follow the snapshot",
        "omitting the key fails validation",
        "is NOT a blank",
        "never re-resolved against the snapshot",
        "inert beside an explicit taxableCents",
        "pretaxSpouseCents is the one exception",
        "carved out of the primary's",
        "carves out $0",
      ];
      const allNull = {
        pretaxCents: null,
        pretaxSpouseCents: null,
        rothCents: null,
        taxableCents: null,
        hsaCents: null,
      };
      return {
        phrasesFound: phrases.filter((p) => BALANCE_SEMANTICS.includes(p))
          .length,
        allNullAccepted: rothBaseBalancesIn.safeParse(allNull).success ? 1 : 0,
        omissionRejected: rothBaseBalancesIn.safeParse({
          pretaxCents: null,
          pretaxSpouseCents: null,
          rothCents: null,
          taxableCents: null,
        }).success
          ? 0
          : 1,
        fractionalRejected: rothBaseBalancesIn.safeParse({
          ...allNull,
          pretaxCents: 100.5,
        }).success
          ? 0
          : 1,
      };
    },
  },
  {
    id: "api-protect-min-semantics-content",
    kind: "apicontract",
    note: "Protect-minimum semantics (cash-floor circle-back, description fix, 2026-10-19): describeApi publishes PROTECT_MIN_SEMANTICS verbatim (the handler returns this exact constant), and it must state the field's real behaviour — the required phrases pin them: the channel ('caps ONE sale'), the limit ('at most the pool balance minus the protect-minimum'), the spill ('withheld from that year's conversion', 'debited from Taxable below the protect-minimum'), the non-guarantees ('NOT a guaranteed minimum balance', 'does NOT preserve cash', 'highest-basis first'), the blank rule ('prices as $0'), the fixed-nominal rule ('does not inflate'), and non-engagement ('never engages'). The behaviour itself is pinned by the tax suite's protect-min sourcing fixture and the circle-back acceptance probes; this fixture pins only that the published text cannot silently drift back into overstating the field.",
    expected: { phrasesFound: 10 },
    actual: () => {
      const phrases = [
        "caps ONE sale",
        "at most the pool balance minus the protect-minimum",
        "withheld from that year's conversion",
        "debited from Taxable below the protect-minimum",
        "NOT a guaranteed minimum balance",
        "does NOT preserve cash",
        "highest-basis first",
        "never engages",
        "prices as $0",
        "does not inflate",
      ];
      return {
        phrasesFound: phrases.filter((p) => PROTECT_MIN_SEMANTICS.includes(p))
          .length,
      };
    },
  },
  {
    id: "api-backup-authenticity-semantics-content",
    kind: "apicontract",
    note: "Hardening S1 (round-5 security review; the user chose option C, 2026-10-19; MAC half shipped as the follow-on build): describeApi publishes BACKUP_AUTHENTICITY_SEMANTICS verbatim (the handler returns this exact constant), and it must state the authenticity rule in as many words: payloads carry an authenticity MAC that restore verifies before writing; a MAC that does not verify is REFUSED with an authenticity error; a payload with NO MAC still restores and is labelled UNAUTHENTICATED; the MAC's honest scope — the MAC key ships with the app, so it is tamper and corruption DETECTION, not proof of origin, and not a signature; the key check remains a COMPATIBILITY check only. The .mstbak leg stays pinned to its actual guarantee (integrity-protected by authenticated encryption, a modified file fails decryption). The behaviour itself is pinned by the backupmac restore fixtures; no phrase here may upgrade either side.",
    expected: { phrasesFound: 9 },
    actual: () => {
      const phrases = [
        "authenticity MAC",
        "is REFUSED with an authenticity error",
        "labels it UNAUTHENTICATED",
        "the MAC key ships with the app",
        "tamper and corruption DETECTION",
        "not a signature",
        "COMPATIBILITY check only",
        "integrity-protected by their authenticated encryption",
        "a modified .mstbak fails decryption",
      ];
      return {
        phrasesFound: phrases.filter((p) => BACKUP_AUTHENTICITY_SEMANTICS.includes(p))
          .length,
      };
    },
  },
  {
    id: "api-score-identities-content",
    kind: "apicontract",
    note: "Score identities (hardening package, finding A-4; extended by the T2 payroll build; extended by the cold-AI audit fix): describeApi publishes SCORE_IDENTITIES verbatim (the handler returns this exact constant), and it must state both identities in the response field names — netCostCents as totalTax + IRMAA + penalty + terminal − ACA credit − educationRefundableCents (the refundable AOTC term the cold-AI audit found missing: educationCreditSemantics credits it in the score beside the ACA credit, and netCostBreakdown subtracts it, so the printed formula must too), with the terminal split (preserveExitRatePct inside preservePretaxCents, heirRatePct on the excess) — state in the identity itself that AMT is inside federalTax and never added on top, and where the NIIT sits (inside federalTax, therefore inside totalTax) — state plainly that the score 'can be NEGATIVE', carry the synthetic fixture-plan specimen (-21041257), state the ending-wealth identity, and state the T2 fold-in: on a salary-carrying row the all-in identity holds (with the same − educationRefundable term) with totalTax folding in the work years' employee payroll tax as its own component, priced from each salary year's own law table, the employer share not priced. The identities themselves are exercised arithmetically in api-compare-example-executes and in the tax suite's workyears-payroll-fold-in-identity case; this fixture pins only that the published text cannot silently lose them.",
    expected: { phrasesFound: 10 },
    actual: () => {
      const phrases = [
        "netCostCents = totalTaxCents + irmaaCents + penaltyCents + terminalCents − acaCreditCents − educationRefundableCents",
        "priced at preserveExitRatePct, any excess at heirRatePct",
        "can be NEGATIVE",
        "-21041257",
        "endingAfterTaxWealthCents = endingPretaxCents + endingRothCents + endingTaxableCents + endingHsaCents − terminalCents",
        "payroll tax is its own component of totalTax",
        "allInTax = totalTax + penalty + irmaa − acaCredit − educationRefundable + terminal",
        "AMT is inside federalTax and never added on top",
        "The NIIT likewise sits inside federalTax",
        "credited beside the ACA premium credit",
      ];
      return {
        phrasesFound: phrases.filter((p) => SCORE_IDENTITIES.includes(p))
          .length,
      };
    },
  },
  {
    id: "api-privacy-scrub-pins",
    kind: "apicontract",
    note: "Privacy scrub pins (pre-publication scrub): the seeded fresh-user defaults and the published specimens are SYNTHETIC sample values, pinned here so a real household figure can never quietly return as a seed constant or a contract specimen. The seed record must carry the generic defaults (birth years 1975 / 1985, Social Security $48,000/yr, protect-minimum $50,000, preserve pre-tax $250,000, heir rate 24%, ACA household 2 stepping down to 2), SCORE_IDENTITIES must carry the synthetic fixture-plan specimen (-21041257), and PROTECT_MIN_SEMANTICS must state its sample-plan sweep figures ($50,000 / $200,000).",
    expected: { seedPinsMatched: 9, specimenFound: 1, protectPinsFound: 2 },
    actual: () => {
      const seed = seedRothInputs({
        annualSpendingCents: 15000000,
        retirementAge: 57,
        expectedReturnPct: 5.75,
      });
      const seedPins = [
        seed.birthYearPrimary === 1975,
        seed.birthYearSpouse === 1985,
        seed.ssPrimaryAnnualCents === 4800000,
        seed.protectMinTaxableCents === 5000000,
        seed.preservePretaxCents === 25000000,
        seed.heirRatePct === 24,
        seed.acaHouseholdSize === 2,
        seed.acaHouseholdSizeAfter === 2,
        seed.spouseSoleBeneficiary === true,
      ];
      return {
        seedPinsMatched: seedPins.filter(Boolean).length,
        specimenFound: SCORE_IDENTITIES.includes("-21041257") ? 1 : 0,
        protectPinsFound: ["$50,000", "$200,000"].filter((p) =>
          PROTECT_MIN_SEMANTICS.includes(p),
        ).length,
      };
    },
  },
  {
    id: "api-law-year-semantics-content",
    kind: "apicontract",
    note: "Law-year semantics (hardening package, finding A-13; rewritten by the T1 build, per-calendar-year law tables; extended by the cold-AI audit fix): describeApi publishes LAW_YEAR_SEMANTICS verbatim, and it must state the per-year rule — lawYear names the newest published table, each plan year 'prices under its own calendar year's table', a year past the table 'carries that newest table forward', the unindexed thresholds 'deflate at the plan's inflation rate' for years past the table priced under, and lawYearsAvailable's meaning. The cold-AI audit fix completes the deflation rule's named list — the SALT cap figures and the education-credit figures deflate too, not only the NIIT and §86 thresholds — and adds the one-sentence ACA guideline convention (projected years on the newest row in today's dollars; the single-year pricer on the statutory lookback). (The pre-T1 text stated the opposite — a single table for every year, the engine 'does not switch law tables mid-plan'; T1 replaced both the text and this pin.)",
    expected: { phrasesFound: 9 },
    actual: () => {
      const phrases = [
        "lawYear names the newest published law table",
        "prices under its own calendar year's table",
        "carries that newest table forward",
        "deflate at the plan's inflation rate",
        "lawYearsAvailable lists every table the engine holds",
        "the SALT cap figures",
        "the education-credit figures",
        "projected years price the ACA cliff on the newest poverty-guideline row in today's dollars",
        "the single-year pricer applies the statutory lookback to its named year",
      ];
      return {
        phrasesFound: phrases.filter((p) => LAW_YEAR_SEMANTICS.includes(p))
          .length,
      };
    },
  },
  {
    id: "api-cold-audit-wording-content",
    kind: "apicontract",
    note: "Cold-AI audit wording (2026-10-21 audit, explanation-level findings): describeApi publishes STATE_SEMANTICS and EDUCATION_CREDIT_SEMANTICS verbatim, and they must state two things the audit found unstated — whether the Washington $1,000,000 surtax threshold deflates (it does NOT: waCapitalGainsTax applies the nominal threshold in every year, unlike the deflating federal thresholds), and how the Playground's totalTax treats the refundable education credit (totalTax is federalTax plus stateTax and does NOT subtract the refundable portion, which is reported separately and never netted into federalTax or totalTax — the same treatment the plan score identity gives it). This fixture pins only that the published text cannot silently lose either statement.",
    expected: { phrasesFound: 4 },
    actual: () => {
      const phrases: [string, string][] = [
        ["the Washington $1,000,000 surtax threshold does NOT deflate", STATE_SEMANTICS],
        ["it stays at $1,000,000 in every priced year", STATE_SEMANTICS],
        ["The Playground's totalTax treats the refundable education credit the same way", EDUCATION_CREDIT_SEMANTICS],
        ["totalTax is federalTax plus stateTax, so it does NOT subtract the refundable portion", EDUCATION_CREDIT_SEMANTICS],
      ];
      return {
        phrasesFound: phrases.filter(([p, s]) => s.includes(p)).length,
      };
    },
  },
  {
    id: "api-playground-year-semantics-content",
    kind: "apicontract",
    note: "Playground year semantics — the dividend derivation (dividend-pair guard, projection solidity check 2026-10-21): describeApi publishes PLAYGROUND_YEAR_SEMANTICS verbatim, and it must state the single-year pricer's dividend rule in as many words — the Ordinary dividends input is 'the TOTAL ordinary dividends' (the 'Form 1099-DIV box 1a' figure), the Qualified input 'is a subset of that total', the derivation 'nonQualifiedDividends = max(0, ordinaryDividends − qualifiedDividends)', the overage rule (the qualified figure 'cannot exceed the total'; the derivation 'floors the non-qualified part at $0' and 'the excess is not counted'), and that the Playground flags the pair ('shows a note on the form in that case'). The behaviour itself is pinned by the tax suite's playground-dividend-split-normal and playground-dividend-split-overage fixtures; this fixture pins only that the published text cannot silently lose the derivation.",
    expected: { phrasesFound: 7 },
    actual: () => {
      const phrases = [
        "the TOTAL ordinary dividends",
        "Form 1099-DIV box 1a",
        "is a subset of that total",
        "nonQualifiedDividends = max(0, ordinaryDividends − qualifiedDividends)",
        "cannot exceed the total",
        "floors the non-qualified part at $0",
        "the excess is not counted",
      ];
      return {
        phrasesFound: phrases.filter((p) => PLAYGROUND_YEAR_SEMANTICS.includes(p))
          .length,
      };
    },
  },
  {
    id: "api-tax-return-semantics-content",
    kind: "apicontract",
    note: "Tax-return semantics (1040 LINES build): describeApi publishes TAX_RETURN_SEMANTICS verbatim, and it must state the three fields and their prefill-only role in as many words — the fields are the return's 'Form 1040 actuals' (line 2b 'taxable interest', line 3a 'qualified dividends', line 3b 'ordinary dividends'), they are 'plan-record only' (accepted ONLY by saveRothInputs, returned ONLY by getRothPlanner, 'never enter a saved scenario'), their one consumer is the Playground prefill with the mapping 'interest ← line 2b', 'qualified dividends ← line 3a', and ordinary dividends '← line 3b written as the TOTAL' ('never the non-qualified remainder'), and 'Plan pricing NEVER reads them' — pricing keeps modelling from 'the plan's yield fields' and a saved plan 'prices bit-identically with the three fields set or blank'. The behaviour itself is pinned by the tax suite's tax-return-prefill-mapping and tax-return-pricing-identity fixtures; this fixture pins only that the published text cannot silently lose the prefill-only role.",
    expected: { phrasesFound: 12 },
    actual: () => {
      const phrases = [
        "Form 1040 actuals",
        "taxable interest (line 2b)",
        "qualified dividends (line 3a)",
        "ordinary dividends (line 3b)",
        "plan-record only",
        "never enter a saved scenario",
        "interest ← line 2b",
        "qualified dividends ← line 3a",
        "line 3b written as the TOTAL",
        "never the non-qualified remainder",
        "Plan pricing NEVER reads them",
        "prices bit-identically with the three fields set or blank",
      ];
      return {
        phrasesFound: phrases.filter((p) => TAX_RETURN_SEMANTICS.includes(p))
          .length,
      };
    },
  },
  {
    id: "api-tier-semantics-content",
    kind: "apicontract",
    note: "Tier rules (hardening package, finding A-14): describeApi publishes TIER_SEMANTICS verbatim, and it must state the full rule set — up to six slices, sharePct 'must sum to 100 (±0.01)', consumption 'highest-basis first', and tiers replacing taxableBasisPct when present. (The protectMinSemantics convention already carried the consumption-order clause; this completes the set as its own statement.)",
    expected: { phrasesFound: 4 },
    actual: () => {
      const phrases = [
        "up to six slices",
        "must sum to 100 (±0.01)",
        "highest-basis first",
        "they replace taxableBasisPct",
      ];
      return {
        phrasesFound: phrases.filter((p) => TIER_SEMANTICS.includes(p))
          .length,
      };
    },
  },
  {
    id: "api-unpaid-tax-semantics-content",
    kind: "apicontract",
    note: "Unpaid-tax semantics (round-5 fix 1): describeApi publishes UNPAID_TAX_SEMANTICS verbatim (the handler returns this exact constant), and it must state the shipped behaviour — the required phrases pin them: the remainder is 'never treated as paid', the assessed fields 'carry the full liability either way', the funding identity 'sources + spendShortfallCents + unpaidTaxCents = totalNeedCents', the distinction from unfunded spending ('distinct from spendShortfall'), the ordinary shape that produces it ('income it does not control'), and the funded case ('$0 in every year whose balances cover the bill'). The behaviour itself is pinned by the tax suite's unpaid-tax fixtures (one-cent, zero-balance, solvent control, spend-down); this fixture pins only that the published text cannot silently drift back into presenting an unpayable bill as paid.",
    expected: { phrasesFound: 6 },
    actual: () => {
      const phrases = [
        "never treated as paid",
        "carry the full liability either way",
        "sources + spendShortfallCents + unpaidTaxCents = totalNeedCents",
        "distinct from spendShortfall",
        "income it does not control",
        "$0 in every year whose balances cover the bill",
      ];
      return {
        phrasesFound: phrases.filter((p) => UNPAID_TAX_SEMANTICS.includes(p))
          .length,
      };
    },
  },
  {
    id: "api-units-nonmoney-content",
    kind: "apicontract",
    note: "Units convention (hardening package, finding A-7): describeApi publishes UNITS_SEMANTICS verbatim (the pre-existing units text, moved into apiContractCore unchanged, plus the non-money appendix), and it must state that *Pct fields are 'percentage points (5.75 means 5.75%, not 0.0575)', ages are 'whole years of age', *Year fields are 'calendar years', and household sizes are 'person counts'. The pre-existing 'integer cents' anchor phrase is pinned too, so the move itself is proven lossless.",
    expected: { phrasesFound: 5 },
    actual: () => {
      const phrases = [
        "are integer cents",
        "percentage points (5.75 means 5.75%, not 0.0575)",
        "Ages are whole years of age",
        "calendar years",
        "person counts",
      ];
      return {
        phrasesFound: phrases.filter((p) => UNITS_SEMANTICS.includes(p))
          .length,
      };
    },
  },
  {
    id: "api-writers-readers-error-shape",
    kind: "apicontract",
    note: "Validation-error shape (hardening package, finding A-11; refresh specimen N-2): describeApi publishes WRITERS_READERS_RULE verbatim (pre-existing text moved unchanged, plus the appendix), and the appendix must publish the raw issue-array shape — 'every issue at once', each issue carrying 'path, code, expected, and message' — quote the observed 'expected number, received undefined' message, and give the nullability guidance ('pass null, not 0, for a blank'). The pre-existing 'Writers strict, readers lenient' anchor proves the move was lossless.",
    expected: { phrasesFound: 5 },
    actual: () => {
      const phrases = [
        "Writers strict, readers lenient",
        "every issue at once",
        "path, code, expected, and message",
        "expected number, received undefined",
        "pass null, not 0, for a blank",
      ];
      return {
        phrasesFound: phrases.filter((p) => WRITERS_READERS_RULE.includes(p))
          .length,
      };
    },
  },
  {
    id: "api-ceilings-replacement-sentence",
    kind: "apicontract",
    note: "Ceilings replacement (hardening package, finding A-6): CEILINGS_REPLACEMENT_SENTENCE is appended verbatim to BOTH runRothCompare's and runRothMonteCarloStats' published purposes, and it must state that a scenario's ceilings object 'replaces the base ceilings wholesale', that 'it does not merge', and the one omittable key's rule ('acaCliffCapFamilyOnly may be omitted and prices as false').",
    expected: { phrasesFound: 3 },
    actual: () => {
      const phrases = [
        "replaces the base ceilings wholesale",
        "it does not merge",
        "acaCliffCapFamilyOnly may be omitted and prices as false",
      ];
      return {
        phrasesFound: phrases.filter((p) =>
          CEILINGS_REPLACEMENT_SENTENCE.includes(p),
        ).length,
      };
    },
  },
  {
    id: "api-save-flattening-and-near-names",
    kind: "apicontract",
    note: "Fetch→save map + near-name prose (hardening package, findings A-10 and A-12(a)): SAVE_FLATTENING_SENTENCE and CONVERTED_ALREADY_DISTINCTION_SENTENCE are appended verbatim to saveRothInputs' published purpose. The map must state the flattening ('getRothPlanner's response flattened'), the mcCheck rename ('mcCheck.mcVolatilityPct is sent as mcVolatilityPct'), and the revision rename ('the record's revision is sent as baseRevision'); the distinction must state that 'convertedAlreadyCents seeds the plan's first year', that executionAlreadyConvertedCents is 'the This Year block's year-to-date figure', and that the two are 'never copied from each other'.",
    expected: { phrasesFound: 6 },
    actual: () => {
      const flat = [
        "getRothPlanner's response flattened",
        "mcCheck.mcVolatilityPct is sent as mcVolatilityPct",
        "the record's revision is sent as baseRevision",
      ];
      const near = [
        "convertedAlreadyCents seeds the plan's first year",
        "the This Year block's year-to-date figure",
        "never copied from each other",
      ];
      return {
        phrasesFound:
          flat.filter((p) => SAVE_FLATTENING_SENTENCE.includes(p)).length +
          near.filter((p) => CONVERTED_ALREADY_DISTINCTION_SENTENCE.includes(p))
            .length,
      };
    },
  },
  {
    id: "api-compare-echo-override-null-balances",
    kind: "apicontract",
    note: "Compare echo resolves override nulls (hardening package, finding A-2): at the override layer an explicit null balance prices at $0 (the published rule), so withResolvedOverrideBalances — the shaping the runRothCompare handler applies to each scenario's parsed effectiveInputs echo with the merged shape beside it — must echo that resolved 0, not the sent null, for EVERY balance key. Pricing premise, re-proven here against runRothCompare on the published example's base: for each of the five keys, {key: null} and {key: 0} price identically to the cent (perKeyPricingEqual 5), and all-five-null vs all-five-zero also price identically (allFivePricingEqual 1). Echo assertions (the parse carries the merged shape's balance values verbatim, so shaping an object built from the merged values is the handler's exact construction): the all-null merged shape's five keys resolve to 0 (nullEchoResolved 5); the all-zero shape's stay 0 and the base shape's explicit balances pass through untouched (zeroEchoUntouched 5 in the sense of unchanged values, baseEchoUntouched 5); a non-balance sentinel field is never touched (sentinelUntouched 1).",
    expected: {
      perKeyPricingEqual: 5,
      allFivePricingEqual: 1,
      nullEchoResolved: 5,
      zeroEchoCarried: 5,
      baseEchoCarried: 5,
      sentinelUntouched: 1,
    },
    actual: () => {
      const req = ROTH_COMPARE_EXAMPLE.request as unknown as Record<
        string,
        unknown
      >;
      const { scenarios: _s, baselineName: _b, ...baseRaw } = req;
      const base = baseRaw as unknown as RothCompareBaseSaved;
      const price = (overrides: RothCompareOverrides) =>
        runRothCompare(base, [{ name: "probe", overrides }], 2026, null)
          .scenarios[0]!;
      const samePrice = (
        a: ReturnType<typeof price>,
        b: ReturnType<typeof price>,
      ) =>
        a.netCostCents === b.netCostCents &&
        a.totalTaxCents === b.totalTaxCents &&
        a.endingAfterTaxWealthCents === b.endingAfterTaxWealthCents
          ? 1
          : 0;
      let perKeyPricingEqual = 0;
      for (const k of ROTH_BALANCE_KEYS) {
        perKeyPricingEqual += samePrice(
          price({ [k]: null } as RothCompareOverrides),
          price({ [k]: 0 } as RothCompareOverrides),
        );
      }
      const allNull = Object.fromEntries(
        ROTH_BALANCE_KEYS.map((k) => [k, null]),
      ) as RothCompareOverrides;
      const allZero = Object.fromEntries(
        ROTH_BALANCE_KEYS.map((k) => [k, 0]),
      ) as RothCompareOverrides;
      const allFivePricingEqual = samePrice(price(allNull), price(allZero));
      const echoOf = (merged: Record<string, unknown>) =>
        withResolvedOverrideBalances(
          { ...merged, sentinel: "keep" },
          merged as Partial<
            Record<(typeof ROTH_BALANCE_KEYS)[number], number | null>
          >,
        ) as Record<string, unknown>;
      const nullEcho = echoOf({ ...baseRaw, ...allNull });
      const zeroEcho = echoOf({ ...baseRaw, ...allZero });
      const baseEcho = echoOf({ ...baseRaw });
      return {
        perKeyPricingEqual,
        allFivePricingEqual,
        nullEchoResolved: ROTH_BALANCE_KEYS.filter(
          (k) => nullEcho[k] === 0,
        ).length,
        zeroEchoCarried: ROTH_BALANCE_KEYS.filter(
          (k) => zeroEcho[k] === 0,
        ).length,
        baseEchoCarried: ROTH_BALANCE_KEYS.filter(
          (k) => baseEcho[k] === baseRaw[k],
        ).length,
        sentinelUntouched:
          nullEcho.sentinel === "keep" && baseEcho.sentinel === "keep" ? 1 : 0,
      };
    },
  },
  {
    id: "api-compare-example-executes",
    kind: "apicontract",
    note: "Worked example (hardening package, findings A-5(b), A-4, A-12(b)): describeApi publishes ROTH_COMPARE_EXAMPLE — one complete runRothCompare request (the seeded fresh-user plan shape with explicit balances) and its response. This fixture RE-EXECUTES that exact request against runRothCompare at start year 2026 on every suite run and compares all 19 published fields of both scenarios (fieldsCompared 38, all matching: fieldsMatched 38 — unpaidTaxCents joined the compared set in the round-5 fixes build, when the field was added to the compare response; educationRefundableCents and deltaEducationRefundableCents joined in the T6 build, when the refundable education credit joined the score identity — the seeded plan enters no education expenses, so both publish 0), so the published example can never rot: if engine pricing moves a figure, this fixture fails until the example is re-derived. It also verifies the A-4 identities on the executed figures — the net-cost identity exact in cents for both scenarios (netCostIdentityExact 2; the identity subtracts the refundable education credit beside the ACA credit — both are 0 here, so the T6 term moves nothing), the wealth identity within the published one-cent rounding clause (wealthIdentityWithinCent 2) — and the A-12(b) prefix: both descriptions lead with 'Retire at ' (descriptionsCarryRetirePrefix 2).",
    expected: {
      fieldsCompared: 38,
      fieldsMatched: 38,
      netCostIdentityExact: 2,
      wealthIdentityWithinCent: 2,
      descriptionsCarryRetirePrefix: 2,
    },
    actual: () => {
      const req = ROTH_COMPARE_EXAMPLE.request as unknown as Record<
        string,
        unknown
      >;
      const { scenarios, baselineName, ...baseRaw } = req;
      const res = runRothCompare(
        baseRaw as unknown as RothCompareBaseSaved,
        scenarios as unknown as { name: string; overrides: RothCompareOverrides }[],
        2026,
        baselineName as string,
      );
      const fields = [
        "name",
        "strategyDescription",
        "netCostCents",
        "totalTaxCents",
        "penaltyCents",
        "irmaaCents",
        "acaCreditCents",
        "educationRefundableCents",
        "terminalCents",
        "ssCollectedCents",
        "unpaidTaxCents",
        "endingPretaxCents",
        "endingRothCents",
        "endingTaxableCents",
        "endingHsaCents",
        "endingAfterTaxWealthCents",
        "deltaNetCostCents",
        "deltaAcaCreditCents",
        "deltaEducationRefundableCents",
      ] as const;
      const published = ROTH_COMPARE_EXAMPLE.response.scenarios as unknown as Record<
        string,
        unknown
      >[];
      let fieldsCompared = 0;
      let fieldsMatched = 0;
      let netCostIdentityExact = 0;
      let wealthIdentityWithinCent = 0;
      let descriptionsCarryRetirePrefix = 0;
      res.scenarios.forEach((s, i) => {
        const pub = published[i]!;
        for (const f of fields) {
          fieldsCompared += 1;
          if ((s as unknown as Record<string, unknown>)[f] === pub[f])
            fieldsMatched += 1;
        }
        if (
          s.netCostCents ===
          s.totalTaxCents + s.irmaaCents + s.penaltyCents + s.terminalCents -
            s.acaCreditCents -
            s.educationRefundableCents
        )
          netCostIdentityExact += 1;
        if (
          Math.abs(
            s.endingAfterTaxWealthCents -
              (s.endingPretaxCents +
                s.endingRothCents +
                s.endingTaxableCents +
                s.endingHsaCents -
                s.terminalCents),
          ) <= 1
        )
          wealthIdentityWithinCent += 1;
        if (s.strategyDescription.startsWith("Retire at "))
          descriptionsCarryRetirePrefix += 1;
      });
      return {
        fieldsCompared,
        fieldsMatched:
          res.ok && res.baselineName === ROTH_COMPARE_EXAMPLE.response.baselineName
            ? fieldsMatched
            : -1,
        netCostIdentityExact,
        wealthIdentityWithinCent,
        descriptionsCarryRetirePrefix,
      };
    },
  },
  {
    id: "api-mc-score-in-tightened",
    kind: "apicontract",
    note: "Monte Carlo check score input (API follow-on 2, finding F6): mcScoreIn — the exact schema runRothMonteCarloCheck publishes for winner/doNothing — now mirrors its siblings: a fractional magiCapCents, a fractional acaCliffBufferCents, a fractional irmaaTierCap, a fractional windowStopAge, a fractional claim age, and a bogus drawOrder key are each REJECTED (the bogus key used to fall back silently to the default draw order while the response kept the caller's name). The client-shape control — a full score in exactly the shape the client's toOptScore emits (valid draw-order key, Math.round-integer cents fields, integer ages, a Social Security amount carrying cents, which stays legal because those fields are dollars) — is ACCEPTED.",
    expected: {
      clientShapeAccepted: 1,
      fractionalMagiRejected: 1,
      fractionalBufferRejected: 1,
      fractionalIrmaaRejected: 1,
      fractionalWindowStopRejected: 1,
      fractionalClaimAgeRejected: 1,
      bogusDrawOrderRejected: 1,
    },
    actual: () => {
      const valid = {
        name: "Winner",
        windowStopAge: 74,
        guardrail: false,
        bunching: false,
        ceilings: {
          bracketTopPct: 12,
          irmaaTierCap: 1,
          ltcgZeroCap: false,
          acaCliffCap: true,
          acaCliffCapFamilyOnly: false,
          magiCapCents: 15000000,
          acaCliffBufferCents: 500000,
        },
        claimPrimaryAge: 67,
        claimSpouseAge: null,
        ssPrimaryAnnual: 48000.5,
        ssSpouseAnnual: 0,
        drawOrder: "pretax-taxable-roth" as const,
      };
      const rejected = (over: Record<string, unknown>) =>
        mcScoreIn.safeParse({ ...valid, ...over }).success ? 0 : 1;
      const rejectedCeilings = (over: Record<string, unknown>) =>
        mcScoreIn.safeParse({
          ...valid,
          ceilings: { ...valid.ceilings, ...over },
        }).success
          ? 0
          : 1;
      return {
        clientShapeAccepted: mcScoreIn.safeParse(valid).success ? 1 : 0,
        fractionalMagiRejected: rejectedCeilings({ magiCapCents: 15000000.5 }),
        fractionalBufferRejected: rejectedCeilings({
          acaCliffBufferCents: 500000.25,
        }),
        fractionalIrmaaRejected: rejectedCeilings({ irmaaTierCap: 1.5 }),
        fractionalWindowStopRejected: rejected({ windowStopAge: 74.5 }),
        fractionalClaimAgeRejected: rejected({ claimPrimaryAge: 67.5 }),
        bogusDrawOrderRejected: rejected({ drawOrder: "bogus-key" }),
      };
    },
  },
  {
    id: "api-mc-score-bracket-top-supported-only",
    kind: "apicontract",
    note: "Round-7 R7-3 (defect K-2/A-1) on the Monte Carlo check path: mcScoreIn's ceilings.bracketTopPct is the shared bracketTopPctField (apiContractCore), so the external review's 13 and the fractional 22.5 are REJECTED on this path too, while null (no fill) and each supported rate (10, 12, 22, 24, 32, 35, 37) are ACCEPTED. The same field object is published by the writers' shared ceilings object and the strict compute ceilings in actions.ts, so every public path that accepts ceilings enforces the same list.",
    expected: {
      thirteenRejected: 1,
      fractionalRejected: 1,
      nullAccepted: 1,
      allSupportedAccepted: 1,
    },
    actual: () => {
      const valid = {
        name: "Winner",
        windowStopAge: 74,
        guardrail: false,
        bunching: false,
        ceilings: {
          bracketTopPct: 12,
          irmaaTierCap: 1,
          ltcgZeroCap: false,
          acaCliffCap: true,
          acaCliffCapFamilyOnly: false,
          magiCapCents: 15000000,
          acaCliffBufferCents: 500000,
        },
        claimPrimaryAge: 67,
        claimSpouseAge: null,
        ssPrimaryAnnual: 48000.5,
        ssSpouseAnnual: 0,
        drawOrder: "pretax-taxable-roth" as const,
      };
      const withBracket = (bracketTopPct: number | null) =>
        mcScoreIn.safeParse({
          ...valid,
          ceilings: { ...valid.ceilings, bracketTopPct },
        }).success;
      return {
        thirteenRejected: withBracket(13) ? 0 : 1,
        fractionalRejected: withBracket(22.5) ? 0 : 1,
        nullAccepted: withBracket(null) ? 1 : 0,
        allSupportedAccepted: [10, 12, 22, 24, 32, 35, 37].every(withBracket)
          ? 1
          : 0,
      };
    },
  },
  {
    id: "api-sleeve-echo-shaping",
    kind: "apicontract",
    note: "Effective-inputs sleeve echo (API follow-on 2, finding F16; R4-3, finding F7): withSleeveEcho — the shaping every compute action's effectiveInputs construction uses (computeEffectiveInputs and the runRothCompare scenario echo) — attaches the resolved sleeve the run priced with EXACTLY when one was threaded (20,000,000¢, a synthetic cash-bucket figure in the spend-from-cash fixtures' shape), and attaches null when the run priced with no sleeve (absent or explicit null alike), so the echo can never invent a sleeve. The saved shape itself is untouched: the echoed object is the parsed inputs plus this one transient key. R4-3 F7 adds the three DIVERGENCE cases as echo-vs-engine assertions: each builds engine inputs (RothPlanInputs), derives the sleeve via deriveSpendFromCashSleeveStartDollars, converts to cents, and passes the derived value through withSleeveEcho — the exact construction the handlers now use — against hand-derived expectations: (1) tiersEcho — tiers [{30% at 100% basis}, {70% at 40%}] on a $100,000 pool, pct 25, threaded sleeve null → 3,000,000¢ (the $30,000 cash tier); (2) cappedEcho — single pool, $10,000 pool, pct 25, threaded sleeve $50,000 → 1,000,000¢ (capped at the pool); (3) pctOffEcho — $2,400,000 pool, pct null, threaded sleeve $200,000 → 0¢ (the priced sleeve), while the echoed object's other fields still carry the parsed payload untouched (pctOffTaxableCarried). Each case is ALSO cross-checked against a real simulateRothPlan run's first-year sleeve state (detail.cashSleeveEnd) on a zero-spending, zero-return plan, where the year-end sleeve equals the starting sleeve exactly: the engine's own figures agree with the echo to the cent (engineTiers / engineCapped / enginePctOff), and the standing spend-from-cash tax fixtures remain the broader engine-side proof that the F7 relocation moved no priced value.",
    expected: {
      explicitEcho: 20000000, absentEcho: null, nullEcho: null,
      tiersEcho: 3000000, cappedEcho: 1000000, pctOffEcho: 0,
      pctOffTaxableCarried: 240000000,
      engineTiers: 3000000, engineCapped: 1000000, enginePctOff: 0,
    },
    actual: () => {
      const parsed = { pretaxCents: 40000000, taxableCents: 240000000 };
      const sleevePlan = (over: Partial<RothPlanInputs>): RothPlanInputs => ({
        startYear: 2026,
        birthYearPrimary: 1961,
        birthYearSpouse: 1972,
        filingStatus: "mfj",
        endAgePrimary: 85,
        pretaxStart: 400000,
        rothStart: 100000,
        taxableStart: 100000,
        hsaStart: 20000,
        taxableBasisPct: 50,
        annualSpending: 0,
        retirementAge: 65,
        expectedReturnPct: 0,
        ssPrimaryAnnual: 0,
        ssPrimaryStartAge: null,
        ssSpouseAnnual: 0,
        ssSpouseStartAge: null,
        otherOrdinaryAnnual: 0,
        taxExemptInterestAnnual: 0,
        convertedAlreadyThisYear: 0,
        windowStartAge: 65,
        windowStopAge: 74,
        payTaxFrom: "taxable",
        protectMinTaxable: 0,
        drawOrder: DEFAULT_DRAW_ORDER,
        spouseSoleBeneficiary: true,
        acaHouseholdSize: 2,
        acaHouseholdSizeAfter: 2,
        acaStepDownYear: null,
        acaBenchmarkCouple: null,
        acaBenchmarkSingle: null,
        inflationPct: 2.5,
        stateRatePct: 0,
        heirRatePct: 22,
        ...over,
      });
      const echoOf = (inputs: RothPlanInputs, echoParsed: object) =>
        withSleeveEcho(
          echoParsed,
          Math.round(deriveSpendFromCashSleeveStartDollars(inputs) * 100),
        ).spendFromCashSleeveCents;
      const engineSleeveEndCents = (inputs: RothPlanInputs) => {
        const run = simulateRothPlan(inputs, {
          id: "none",
          name: "Do Nothing",
          ceilings: null,
        });
        const first = run.years[0];
        return first == null
          ? null
          : Math.round(first.detail.cashSleeveEnd * 100);
      };
      const tiersInputs = sleevePlan({
        taxableTiers: [
          { sharePct: 30, basisPct: 100 },
          { sharePct: 70, basisPct: 40 },
        ],
        spendFromCashPct: 25,
        // No threaded sleeve (the settlement's transient-null
        // case): the field is absent, exactly as a tiers plan
        // with no snapshot threading reaches the engine.
      });
      const cappedInputs = sleevePlan({
        taxableStart: 10000,
        spendFromCashPct: 25,
        spendFromCashSleeveStart: 50000,
      });
      const pctOffInputs = sleevePlan({
        taxableStart: 2400000,
        spendFromCashPct: null,
        spendFromCashSleeveStart: 200000,
      });
      const pctOffEchoed = withSleeveEcho(
        parsed,
        Math.round(deriveSpendFromCashSleeveStartDollars(pctOffInputs) * 100),
      );
      return {
        explicitEcho: withSleeveEcho(parsed, 20000000)
          .spendFromCashSleeveCents,
        absentEcho: withSleeveEcho(parsed, undefined)
          .spendFromCashSleeveCents,
        nullEcho: withSleeveEcho(parsed, null).spendFromCashSleeveCents,
        tiersEcho: echoOf(tiersInputs, parsed),
        cappedEcho: echoOf(cappedInputs, parsed),
        pctOffEcho: pctOffEchoed.spendFromCashSleeveCents,
        pctOffTaxableCarried: pctOffEchoed.taxableCents,
        engineTiers: engineSleeveEndCents(tiersInputs),
        engineCapped: engineSleeveEndCents(cappedInputs),
        enginePctOff: engineSleeveEndCents(pctOffInputs),
      };
    },
  },
  {
    id: "ys-floor-month-follows-requested-year",
    kind: "yearsummary",
    note: "Year Summary floor month (API follow-on 3, finding F14): the floor is priced at the month yearSummaryFloorMonth chooses for the REQUESTED year, on a synthetic core whose floor differs by month — Rent (lights-on) is $1,000.00 from Nov 2024, $1,200.00 from Jun 2025, $1,500.00 from Jan 2026, and the lights-on smoothed QuarterFee adds round($1,200.00/12) = $100.00 throughout — so the floor is $1,100.00 in Mar 2025 and Dec 2024, $1,300.00 in Dec 2025, and $1,600.00 in Oct 2026. With the current month pinned at 2026-10: the CURRENT year (2026) prices at the current month ($1,600.00 — byte-identical to the old behaviour); 2025 with last included month Mar 2025 prices at 2025-03 ($1,100.00, NOT today's $1,600.00); 2025 ending in December prices at 2025-12 ($1,300.00); 2024 with no included months prices at its December ($1,100.00).",
    expected: {
      curYearMonth: 202610, curYearFloor: 160000,
      y2025Month: 202503, y2025Floor: 110000, y2025DecFloor: 130000,
      y2024Month: 202412, y2024Floor: 110000,
      differsFromCurrent: 1,
    },
    actual: () => {
      const core = createSpendingCore({
        txns: [],
        yearly: [
          { id: 3, name: "QuarterFee", frequency: "quarterly", expectedCents: 30000, dueMonth: 1, backfillBeforeFirstVersion: 0, keepLightsOn: 1 },
        ],
        yearlyVersions: [
          { id: 3, expenseId: 3, effectiveFrom: "2024-11", expectedCents: 30000, frequency: "quarterly" },
        ],
        summaries: [],
        cashOutItems: [],
        bills: [
          { id: 1, keepLightsOn: 1 },
          { id: 2, keepLightsOn: 0 },
        ],
        billVersions: [
          { id: 1, billId: 1, effectiveFrom: "2024-11", amountCents: 100000 },
          { id: 2, billId: 1, effectiveFrom: "2025-06", amountCents: 120000 },
          { id: 3, billId: 1, effectiveFrom: "2026-01", amountCents: 150000 },
          { id: 4, billId: 2, effectiveFrom: "2024-11", amountCents: 5000 },
        ],
        oneOffs: [],
        openingReserveCents: 0,
        reserveStartSetting: null,
      });
      const monthNum = (m: string) => Number(m.replace("-", ""));
      const cur = yearSummaryFloorMonth({ year: 2026, currentYear: 2026, currentMonth: "2026-10", lastIncludedMonth: "2026-10" });
      const y2025 = yearSummaryFloorMonth({ year: 2025, currentYear: 2026, currentMonth: "2026-10", lastIncludedMonth: "2025-03" });
      const y2025Dec = yearSummaryFloorMonth({ year: 2025, currentYear: 2026, currentMonth: "2026-10", lastIncludedMonth: "2025-12" });
      const y2024 = yearSummaryFloorMonth({ year: 2024, currentYear: 2026, currentMonth: "2026-10", lastIncludedMonth: null });
      const curFloor = core.keepLightsOnForMonth(cur);
      const y2025Floor = core.keepLightsOnForMonth(y2025);
      return {
        curYearMonth: monthNum(cur),
        curYearFloor: curFloor,
        y2025Month: monthNum(y2025),
        y2025Floor,
        y2025DecFloor: core.keepLightsOnForMonth(y2025Dec),
        y2024Month: monthNum(y2024),
        y2024Floor: core.keepLightsOnForMonth(y2024),
        differsFromCurrent: y2025Floor !== curFloor ? 1 : 0,
      };
    },
  },
  {
    id: "api-expected-return-floor-bound",
    kind: "apicontract",
    note: "Expected-return floor bound (round-5 fix 3), pinned through the EXACT field schema both saved records publish (expectedReturnPctField from apiContractCore — the shared definition retirementInputFields and rothInputFields reference, so scenario overrides inherit it too): the boundary value −100 is ACCEPTED (it prices a total wipeout — the engine floors the growth factor at 0), ordinary values and the blank (null) are accepted, and anything below −100 (−100.01, and the review's −150) is REJECTED at the save boundary rather than priced from a negative growth factor. The engine-side floor itself is pinned by the tax suite's return-floor fixtures.",
    expected: { accepted: 5, rejected: 2 },
    actual: () => {
      const ok = [-100, -99.99, 0, 5.75, null].filter(
        (v) => expectedReturnPctField.safeParse(v).success,
      ).length;
      const no = [-100.01, -150].filter(
        (v) => !expectedReturnPctField.safeParse(v).success,
      ).length;
      return { accepted: ok, rejected: no };
    },
  },
  {
    id: "api-defaulted-enum-fields-reject-typos",
    kind: "apicontract",
    note: "Defaulted enum/kind write fields (API follow-on 3, finding F17), pinned through the EXACT field schemas actions.ts publishes (yearlyFrequency / yearlyFrequencyWithDefault / nwPropertyKind / nwPropertyKindWithDefault from apiContractCore — the shared definitions addYearlyExpense, updateYearlyExpense, setYearlyExpenseVersion, and addNwAccount reference): an absent frequency takes the documented default \"yearly\" and an absent propertyKind \"none\"; a typo'd value (\"yearli\", \"liabilty\" — the review's exact example) is REJECTED by both defaulted fields, never silently converted into the default; every valid value is accepted (4 frequencies, 3 property kinds); and the base enums without defaults (setYearlyExpenseVersion's frequency among them) reject absence outright.",
    expected: {
      freqDefaultApplied: 1, freqTypoRejected: 1, freqValidAccepted: 4,
      kindDefaultApplied: 1, kindTypoRejected: 1, kindValidAccepted: 3,
      freqBaseAbsentRejected: 1, kindBaseAbsentRejected: 1,
    },
    actual: () => {
      const freqDefault = yearlyFrequencyWithDefault.safeParse(undefined);
      const kindDefault = nwPropertyKindWithDefault.safeParse(undefined);
      return {
        freqDefaultApplied:
          freqDefault.success && freqDefault.data === "yearly" ? 1 : 0,
        freqTypoRejected: yearlyFrequencyWithDefault.safeParse("yearli")
          .success
          ? 0
          : 1,
        freqValidAccepted: ["yearly", "bimonthly", "quarterly", "semiannual"]
          .filter((v) => yearlyFrequencyWithDefault.safeParse(v).success)
          .length,
        kindDefaultApplied:
          kindDefault.success && kindDefault.data === "none" ? 1 : 0,
        kindTypoRejected: nwPropertyKindWithDefault.safeParse("liabilty")
          .success
          ? 0
          : 1,
        kindValidAccepted: ["none", "asset", "liability"].filter((v) =>
          nwPropertyKindWithDefault.safeParse(v).success,
        ).length,
        freqBaseAbsentRejected: yearlyFrequency.safeParse(undefined).success
          ? 0
          : 1,
        kindBaseAbsentRejected: nwPropertyKind.safeParse(undefined).success
          ? 0
          : 1,
      };
    },
  },
  {
    id: "api-update-monthly-bill-partial-set",
    kind: "apicontract",
    note: "updateMonthlyBill partial edits (API follow-on 3, finding F18), pinned through the published request schema (updateMonthlyBillIn from apiContractCore) and the update-set builder the handler executes (monthlyBillUpdateSet in spendingCore): the request carries NO defaults — a minimal { id, name, paidBy } payload parses with notes / category / keepLightsOn ABSENT from the parsed object (the old defaulted schema injected null / \"Uncategorized\" / false, which the handler then wrote unconditionally). The set builder writes exactly what was sent: a keepLightsOn-only edit's set has that one key (value 1); an explicit notes: null IS in the set, as null (it clears the notes); a full payload — what the live bill form always sends — sets all five fields exactly as the old unconditional write did.",
    expected: {
      minimalParseOk: 1, defaultsInjected: 0,
      oneFieldKeys: 1, oneFieldKlo: 1,
      nullNotesKeys: 1, nullNotesPresent: 1, nullNotesIsNull: 1,
      fullKeys: 5, fullKlo: 0,
    },
    actual: () => {
      const minimal = updateMonthlyBillIn.safeParse({
        id: 7,
        name: "Rent",
        paidBy: "Checking",
      });
      const parsedKeys = minimal.success ? Object.keys(minimal.data) : [];
      const injected = ["notes", "category", "keepLightsOn"].filter((k) =>
        parsedKeys.includes(k),
      ).length;
      const oneField = monthlyBillUpdateSet({ keepLightsOn: true });
      const nullNotes = monthlyBillUpdateSet({ notes: null });
      const full = monthlyBillUpdateSet({
        name: "Rent",
        paidBy: "Checking",
        notes: "pay by the 1st",
        category: "Home",
        keepLightsOn: false,
      });
      return {
        minimalParseOk: minimal.success ? 1 : 0,
        defaultsInjected: injected,
        oneFieldKeys: Object.keys(oneField).length,
        oneFieldKlo: oneField.keepLightsOn ?? -1,
        nullNotesKeys: Object.keys(nullNotes).length,
        nullNotesPresent: "notes" in nullNotes ? 1 : 0,
        nullNotesIsNull: nullNotes.notes === null ? 1 : 0,
        fullKeys: Object.keys(full).length,
        fullKlo: full.keepLightsOn ?? -1,
      };
    },
  },
  {
    id: "api-update-monthly-bill-outcome",
    kind: "apicontract",
    note: "updateMonthlyBill affected-row outcome (R4-3, finding F10), pinned through the pure decision the handler branches on (monthlyBillUpdateOutcome in spendingCore, beside the F18 update-set seam): 0 updated rows → 'not-found' (encoded 0) — the handler returns the F22 preflight's exact not-found shape and skips the sticky paid-from write; 1 row → 'updated' (encoded 1); 2 rows → 'updated' (encoded 1 — any committed row counts). Honest split: this fixture pins the core decision only; the end-to-end interleaving (a delete landing between the preflight and the update) is review-pass probe evidence on the fixture surface, NOT a fixture — no concurrent transaction is claimed here.",
    expected: { zeroRows: 0, oneRow: 1, twoRows: 1 },
    actual: () => {
      const code = (n: number) =>
        monthlyBillUpdateOutcome(n) === "updated" ? 1 : 0;
      return {
        zeroRows: code(0),
        oneRow: code(1),
        twoRows: code(2),
      };
    },
  },
];

/* ------------------------- The runner ------------------------- */

export type ExtendedFixtureResult = {
  id: string;
  kind: string;
  pass: boolean;
  failures: string[];
};

export function runExtendedFixtures(
  cases: ExtendedFixtureCase[] = EXTENDED_FIXTURES,
): { total: number; passed: number; results: ExtendedFixtureResult[] } {
  const w = world();
  const results = cases.map((c) => {
    const failures: string[] = [];
    let actual: Record<string, number | null>;
    try {
      actual = c.actual(w);
    } catch (err) {
      return { id: c.id, kind: c.kind, pass: false, failures: [`threw: ${String(err)}`] };
    }
    for (const [field, exp] of Object.entries(c.expected)) {
      const got = actual[field] ?? null;
      if (got !== exp) failures.push(`${field}: expected ${exp}, got ${got}`);
    }
    return { id: c.id, kind: c.kind, pass: failures.length === 0, failures };
  });
  return {
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    results,
  };
}

// Teeth check: corrupt ONE expected value in ONE case by a single
// cent and confirm exactly that case — and no other — fails. Runs
// on every self-check, so the suite continuously proves it would
// catch a one-cent drift.
export function runExtendedTeethCheck(): {
  corruptedCaseId: string;
  failedCount: number;
  pass: boolean;
} {
  const corruptedCaseId = "sp-txn-month-eff";
  const corrupted = EXTENDED_FIXTURES.map((c) =>
    c.id === corruptedCaseId
      ? { ...c, expected: { ...c.expected, smoothed: (c.expected.smoothed ?? 0) + 1 } }
      : c,
  );
  const r = runExtendedFixtures(corrupted);
  const failed = r.results.filter((x) => !x.pass);
  return {
    corruptedCaseId,
    failedCount: failed.length,
    pass: failed.length === 1 && failed[0]?.id === corruptedCaseId,
  };
}

/* ---------------- Roth UI-state CAS fixtures ----------------
   Pinned cases for the Roth UI-state blob's revision/CAS write
   contract (server/src/rothUiStateCore.ts), run by the
   runAccuracySelfCheck "ui-state" suite. They exercise
   applyRothUiWrite — the exact function the setRothUiState
   handler runs between reading and writing the settings row —
   against synthetic stored blobs, never the user's data:
   (a) a stale-revision save is refused and the stored blob is
       left untouched, with the current blob carried back;
   (b) a matching-revision save succeeds and increments;
   (c) a legacy blob without a revision loads as revision 0
       and its first save establishes revision 1;
   (d) the guarded commit the setRothUiState handler performs
       in SQL (commitGuardedRothUiWrite is its testable mirror):
       evaluated against the stored value as it stands at commit
       time, a write whose base the stored revision has already
       advanced past affects 0 rows and is refused, while a
       write at the current revision affects exactly 1 row;
   (e) the ceilCustomOpen field (the Custom… ceiling panel's
       persisted open flag): a blob written before the field
       existed parses it false, a write setting it true
       round-trips, and an unrelated field write preserves it.
   Expected values follow from the contract itself (revision
   arithmetic and field preservation), not from app output. */

export type RothUiStateFixtureResult = {
  id: string;
  kind: string;
  pass: boolean;
  failures: string[];
};

// A stored blob exactly as the pre-revision writer wrote it:
// the full parsed field set with the revision key removed.
function legacyUiRaw(mutate?: (s: RothUiState) => void): string {
  const s = parseRothUiState(undefined);
  if (mutate) mutate(s);
  const o: Record<string, unknown> = {
    ...(s as unknown as Record<string, unknown>),
  };
  delete o.revision;
  return JSON.stringify(o);
}

// A stored blob at a known revision, built through the write
// path itself from a legacy blob.
function uiRawAtRevision(revision: number): string {
  let raw = legacyUiRaw();
  for (let r = 0; r < revision; r++) {
    const res = applyRothUiWrite(raw, r, () => {});
    if (res.status !== "ok") throw new Error("fixture setup write refused");
    raw = res.raw;
  }
  return raw;
}

const uiCasCases: {
  id: string;
  note: string;
  run: () => string[];
}[] = [
  {
    id: "ui-cas-legacy-loads-as-revision-0",
    note: "A blob written before revisions existed (full field set, no revision key) still loads field-for-field and reads as revision 0.",
    run: () => {
      const failures: string[] = [];
      const raw = legacyUiRaw((s) => {
        s.mode = "compare";
        s.yearTableOpen = true;
        s.playground.conversion = "12345";
      });
      const parsed = parseRothUiState(raw);
      if (parsed.revision !== 0) failures.push(`revision: expected 0, got ${parsed.revision}`);
      if (parsed.mode !== "compare") failures.push(`mode: expected compare, got ${parsed.mode}`);
      if (parsed.yearTableOpen !== true) failures.push("yearTableOpen: expected true");
      if (parsed.playground.conversion !== "12345")
        failures.push(`playground.conversion: expected 12345, got ${parsed.playground.conversion}`);
      return failures;
    },
  },
  {
    id: "ui-cas-legacy-first-write-establishes-revision-1",
    note: "The first CAS write against a legacy revision-less blob (base 0) succeeds, applies its field change, and stores revision 1.",
    run: () => {
      const failures: string[] = [];
      const raw = legacyUiRaw((s) => {
        s.playground.conversion = "12345";
      });
      const res = applyRothUiWrite(raw, 0, (s) => {
        s.yearTableOpen = true;
      });
      if (res.status !== "ok") {
        failures.push(`status: expected ok, got ${res.status}`);
        return failures;
      }
      if (res.revision !== 1) failures.push(`revision: expected 1, got ${res.revision}`);
      const stored = parseRothUiState(res.raw);
      if (stored.revision !== 1) failures.push(`stored revision: expected 1, got ${stored.revision}`);
      if (stored.yearTableOpen !== true) failures.push("stored yearTableOpen: expected true");
      if (stored.playground.conversion !== "12345")
        failures.push("stored playground.conversion: expected 12345 (untouched fields preserved)");
      return failures;
    },
  },
  {
    id: "ui-cas-matching-write-increments",
    note: "A save at the current revision (2) succeeds, applies its change, and increments the stored revision to 3.",
    run: () => {
      const failures: string[] = [];
      const raw = uiRawAtRevision(2);
      const res = applyRothUiWrite(raw, 2, (s) => {
        s.mode = "optimize";
      });
      if (res.status !== "ok") {
        failures.push(`status: expected ok, got ${res.status}`);
        return failures;
      }
      if (res.revision !== 3) failures.push(`revision: expected 3, got ${res.revision}`);
      const stored = parseRothUiState(res.raw);
      if (stored.revision !== 3) failures.push(`stored revision: expected 3, got ${stored.revision}`);
      if (stored.mode !== "optimize") failures.push(`stored mode: expected optimize, got ${stored.mode}`);
      return failures;
    },
  },
  {
    id: "ui-cas-stale-write-refused-storage-untouched",
    note: "A save replaying an old base revision (1 against stored 2) is refused as a conflict: it produces no raw form to persist, the stored blob re-parses exactly as before, and the refusal carries the current blob (with its newer values) and revision for the writer's re-merge.",
    run: () => {
      const failures: string[] = [];
      const raw = uiRawAtRevision(2);
      const before = parseRothUiState(raw);
      const res = applyRothUiWrite(raw, 1, (s) => {
        s.mode = "compare";
        s.playground.conversion = "99999";
      });
      if (res.status !== "conflict") {
        failures.push(`status: expected conflict, got ${res.status}`);
        return failures;
      }
      if ("raw" in res) failures.push("conflict result must not carry a raw form to persist");
      if (res.revision !== 2) failures.push(`conflict revision: expected 2, got ${res.revision}`);
      if (res.state.mode !== before.mode)
        failures.push("conflict state must carry the current stored values, not the refused write's");
      if (res.state.playground.conversion !== before.playground.conversion)
        failures.push("conflict state's playground must be the stored one");
      const after = parseRothUiState(raw);
      if (JSON.stringify(after) !== JSON.stringify(before))
        failures.push("stored blob changed under a refused write");
      return failures;
    },
  },
  {
    id: "ui-cas-unchecked-write-still-bumps",
    note: "A write with no base revision (the legacy unchecked path) is always allowed and still bumps the revision (2 to 3), so CAS writers that read afterwards see it.",
    run: () => {
      const failures: string[] = [];
      const raw = uiRawAtRevision(2);
      const res = applyRothUiWrite(raw, undefined, (s) => {
        s.labDialsOpen = true;
      });
      if (res.status !== "ok") {
        failures.push(`status: expected ok, got ${res.status}`);
        return failures;
      }
      if (res.revision !== 3) failures.push(`revision: expected 3, got ${res.revision}`);
      if (parseRothUiState(res.raw).labDialsOpen !== true)
        failures.push("stored labDialsOpen: expected true");
      return failures;
    },
  },
  {
    id: "ui-cas-guarded-commit-after-advance-affects-0-rows",
    note: "The simultaneity window, at the guarded-commit level: two writers both read revision 2; writer A's guarded commit lands (stored advances to revision 3, mode optimize); writer B's guarded commit is then evaluated against the commit-time stored value (revision 3) with its stale base 2 — it affects 0 rows, produces no raw form to persist, carries writer A's current blob at revision 3 for re-merge, and the stored blob is left exactly as A wrote it.",
    run: () => {
      const failures: string[] = [];
      const rawAt2 = uiRawAtRevision(2);
      const a = commitGuardedRothUiWrite(rawAt2, 2, (s) => {
        s.mode = "optimize";
      });
      if (a.affectedRows !== 1) {
        failures.push(`writer A: expected 1 affected row, got ${a.affectedRows}`);
        return failures;
      }
      if (a.revision !== 3) failures.push(`writer A revision: expected 3, got ${a.revision}`);
      const storedAfterA = a.raw;
      const b = commitGuardedRothUiWrite(storedAfterA, 2, (s) => {
        s.mode = "compare";
        s.playground.conversion = "99999";
      });
      if (b.affectedRows !== 0) {
        failures.push(`writer B: expected 0 affected rows, got ${b.affectedRows}`);
        return failures;
      }
      if ("raw" in b) failures.push("writer B: a 0-row commit must not carry a raw form to persist");
      if (b.revision !== 3) failures.push(`writer B conflict revision: expected 3, got ${b.revision}`);
      if (b.state.mode !== "optimize")
        failures.push(`writer B conflict state must carry writer A's stored values, got mode ${b.state.mode}`);
      if (b.state.playground.conversion === "99999")
        failures.push("writer B conflict state must not carry the refused write's values");
      const after = parseRothUiState(storedAfterA);
      if (after.revision !== 3 || after.mode !== "optimize")
        failures.push("stored blob changed under writer B's refused commit");
      return failures;
    },
  },
  {
    id: "ui-cas-guarded-commit-at-current-revision-affects-1-row",
    note: "A guarded commit evaluated while the stored revision still equals the base affects exactly 1 row, applies its change, and stores base + 1 — including against a legacy revision-less blob at base 0, whose missing revision key counts as 0 (the same lenient read the handler's SQL guard encodes).",
    run: () => {
      const failures: string[] = [];
      const rawAt2 = uiRawAtRevision(2);
      const res = commitGuardedRothUiWrite(rawAt2, 2, (s) => {
        s.yearTableOpen = true;
      });
      if (res.affectedRows !== 1) {
        failures.push(`expected 1 affected row, got ${res.affectedRows}`);
        return failures;
      }
      if (res.revision !== 3) failures.push(`revision: expected 3, got ${res.revision}`);
      const stored = parseRothUiState(res.raw);
      if (stored.revision !== 3) failures.push(`stored revision: expected 3, got ${stored.revision}`);
      if (stored.yearTableOpen !== true) failures.push("stored yearTableOpen: expected true");
      const legacy = commitGuardedRothUiWrite(legacyUiRaw(), 0, (s) => {
        s.labDialsOpen = true;
      });
      if (legacy.affectedRows !== 1)
        failures.push(`legacy blob at base 0: expected 1 affected row, got ${legacy.affectedRows}`);
      else if (legacy.revision !== 1)
        failures.push(`legacy blob commit revision: expected 1, got ${legacy.revision}`);
      return failures;
    },
  },
  {
    id: "ui-ceil-custom-open-persists",
    note: "The ceilCustomOpen field: a legacy blob without the key parses ceilCustomOpen false; a write setting it true round-trips through applyRothUiWrite and parse; an unrelated field write preserves it.",
    run: () => {
      const failures: string[] = [];
      // A blob exactly as a writer from before the field existed
      // left it: the full field set with ceilCustomOpen removed.
      const legacyObj = JSON.parse(legacyUiRaw()) as Record<string, unknown>;
      delete legacyObj.ceilCustomOpen;
      const raw = JSON.stringify(legacyObj);
      if (parseRothUiState(raw).ceilCustomOpen !== false)
        failures.push("legacy blob without the key: expected ceilCustomOpen false");
      const res = applyRothUiWrite(raw, 0, (s) => {
        s.ceilCustomOpen = true;
      });
      if (res.status !== "ok") {
        failures.push(`write: expected ok, got ${res.status}`);
        return failures;
      }
      if (parseRothUiState(res.raw).ceilCustomOpen !== true)
        failures.push("stored blob: expected ceilCustomOpen true after the write");
      const res2 = applyRothUiWrite(res.raw, res.revision, (s) => {
        s.yearTableOpen = true;
      });
      if (res2.status !== "ok") {
        failures.push(`unrelated write: expected ok, got ${res2.status}`);
        return failures;
      }
      const after = parseRothUiState(res2.raw);
      if (after.ceilCustomOpen !== true)
        failures.push("unrelated write must preserve ceilCustomOpen true");
      if (after.yearTableOpen !== true)
        failures.push("unrelated write: expected yearTableOpen true");
      return failures;
    },
  },
  {
    id: "ui-proj-template-persists",
    note: "The projTemplate field (projection click fix): a legacy blob without the key parses projTemplate null (no snapshot — the view captures one when the panel opens); a write storing a template snapshot round-trips it field-for-field through applyRothUiWrite and parse; an unrelated field write preserves it; and a malformed snapshot (a required figure missing) reads leniently as null rather than half-loading and mis-basing the projection. The snapshot is what the projection chart runs from, so losing or mangling it on save would re-base the chart — the exact shrink this field exists to prevent.",
    run: () => {
      const failures: string[] = [];
      const legacyObj = JSON.parse(legacyUiRaw()) as Record<string, unknown>;
      delete (legacyObj.playground as Record<string, unknown>).projTemplate;
      const raw = JSON.stringify(legacyObj);
      if (parseRothUiState(raw).playground.projTemplate !== null)
        failures.push("legacy blob without the key: expected projTemplate null");
      const template = {
        taxYear: 2050,
        filingStatus: "mfj" as const,
        agePrimary: 79,
        ageSpouse: 68,
        onMedicarePrimary: true,
        onMedicareSpouse: true,
        interest: 1200,
        ordinaryDividends: 6000,
        otherOrdinary: 0,
        taxExemptInterest: 0,
        ssPrimary: 50520,
        ssSpouse: 0,
        conversion: 35330.16,
        stockSold: 0,
        stockBasis: 0,
        qualifiedDividends: 9000,
        pretaxBalance: 37028.73,
        spouseSoleBeneficiary: true,
        acaHouseholdSize: null,
        acaBenchmarkAnnual: null,
        stateRatePct: 0,
        residenceState: "other" as const,
        itemizedMortgageInterest: 0,
        itemizedSaltPaid: 0,
        itemizedCharitable: 0,
        itemizedOther: 0,
        educationStudents: null,
      };
      const res = applyRothUiWrite(raw, 0, (s) => {
        s.playground.projTemplate = template;
      });
      if (res.status !== "ok") {
        failures.push(`write: expected ok, got ${res.status}`);
        return failures;
      }
      const stored = parseRothUiState(res.raw).playground.projTemplate;
      if (JSON.stringify(stored) !== JSON.stringify(template))
        failures.push(
          `stored projTemplate must round-trip field-for-field, got ${JSON.stringify(stored)}`,
        );
      const res2 = applyRothUiWrite(res.raw, res.revision, (s) => {
        s.playground.conversion = "999";
      });
      if (res2.status !== "ok") {
        failures.push(`unrelated write: expected ok, got ${res2.status}`);
        return failures;
      }
      if (
        JSON.stringify(parseRothUiState(res2.raw).playground.projTemplate) !==
        JSON.stringify(template)
      )
        failures.push("unrelated write must preserve projTemplate");
      const malformed = JSON.parse(res.raw) as Record<string, unknown>;
      const mp = malformed.playground as Record<string, unknown>;
      const mt = { ...(mp.projTemplate as Record<string, unknown>) };
      delete mt.conversion;
      mp.projTemplate = mt;
      if (parseRothUiState(JSON.stringify(malformed)).playground.projTemplate !== null)
        failures.push("malformed snapshot (conversion missing): expected projTemplate null");
      return failures;
    },
  },
  {
    id: "ui-proj-from-age-persists",
    note: "The projFromAge field (projection start-age control): a legacy blob without the key parses projFromAge blank (\"\" — the template's own age, exactly the behaviour before the dial existed); a write storing a from-age round-trips it through applyRothUiWrite and parse; an unrelated field write preserves it; and clearing it back to blank round-trips too, so the projection returns to the template-age walk. The dial is remembered form state like the other projection dials, so losing it on save would silently re-base the chart's window.",
    run: () => {
      const failures: string[] = [];
      const legacyObj = JSON.parse(legacyUiRaw()) as Record<string, unknown>;
      delete (legacyObj.playground as Record<string, unknown>).projFromAge;
      const raw = JSON.stringify(legacyObj);
      if (parseRothUiState(raw).playground.projFromAge !== "")
        failures.push("legacy blob without the key: expected projFromAge blank");
      const res = applyRothUiWrite(raw, 0, (s) => {
        s.playground.projFromAge = "57";
      });
      if (res.status !== "ok") {
        failures.push(`write: expected ok, got ${res.status}`);
        return failures;
      }
      if (parseRothUiState(res.raw).playground.projFromAge !== "57")
        failures.push("stored blob: expected projFromAge 57 after the write");
      const res2 = applyRothUiWrite(res.raw, res.revision, (s) => {
        s.playground.conversion = "999";
      });
      if (res2.status !== "ok") {
        failures.push(`unrelated write: expected ok, got ${res2.status}`);
        return failures;
      }
      if (parseRothUiState(res2.raw).playground.projFromAge !== "57")
        failures.push("unrelated write must preserve projFromAge");
      const res3 = applyRothUiWrite(res2.raw, res2.revision, (s) => {
        s.playground.projFromAge = "";
      });
      if (res3.status !== "ok") {
        failures.push(`clearing write: expected ok, got ${res3.status}`);
        return failures;
      }
      if (parseRothUiState(res3.raw).playground.projFromAge !== "")
        failures.push("clearing the dial must round-trip as blank");
      return failures;
    },
  },
  {
    id: "ui-proj-selected-year-persists",
    note: "The projSelectedYear field (selected projection year survives refresh): a legacy blob without the key parses projSelectedYear null (no year loaded — no highlight, exactly the behaviour before the selection was remembered); a write storing a selected year round-trips it through applyRothUiWrite and parse; an unrelated field write preserves it; clearing it back to null round-trips too (re-run / Reset clear the highlight); and a malformed value (a string, or an out-of-range year) reads leniently as null rather than lighting a bar that was never clicked. The selection drives the chart's ring, dimming, bold label, and Showing caption, so losing it on save would leave the chart and the single-year view disagreeing after a refresh — the exact gap this field exists to close.",
    run: () => {
      const failures: string[] = [];
      const legacyObj = JSON.parse(legacyUiRaw()) as Record<string, unknown>;
      delete (legacyObj.playground as Record<string, unknown>).projSelectedYear;
      const raw = JSON.stringify(legacyObj);
      if (parseRothUiState(raw).playground.projSelectedYear !== null)
        failures.push("legacy blob without the key: expected projSelectedYear null");
      const res = applyRothUiWrite(raw, 0, (s) => {
        s.playground.projSelectedYear = 2029;
      });
      if (res.status !== "ok") {
        failures.push(`write: expected ok, got ${res.status}`);
        return failures;
      }
      if (parseRothUiState(res.raw).playground.projSelectedYear !== 2029)
        failures.push("stored blob: expected projSelectedYear 2029 after the write");
      const res2 = applyRothUiWrite(res.raw, res.revision, (s) => {
        s.playground.conversion = "999";
      });
      if (res2.status !== "ok") {
        failures.push(`unrelated write: expected ok, got ${res2.status}`);
        return failures;
      }
      if (parseRothUiState(res2.raw).playground.projSelectedYear !== 2029)
        failures.push("unrelated write must preserve projSelectedYear");
      const res3 = applyRothUiWrite(res2.raw, res2.revision, (s) => {
        s.playground.projSelectedYear = null;
      });
      if (res3.status !== "ok") {
        failures.push(`clearing write: expected ok, got ${res3.status}`);
        return failures;
      }
      if (parseRothUiState(res3.raw).playground.projSelectedYear !== null)
        failures.push("clearing the selection must round-trip as null");
      for (const bad of ["2029", 1800, 2029.5]) {
        const badObj = JSON.parse(res.raw) as Record<string, unknown>;
        (badObj.playground as Record<string, unknown>).projSelectedYear = bad;
        if (parseRothUiState(JSON.stringify(badObj)).playground.projSelectedYear !== null)
          failures.push(`malformed projSelectedYear ${JSON.stringify(bad)}: expected null`);
      }
      return failures;
    },
  },
  {
    id: "ui-legacy-chart-mode-opens-stack",
    note: "The retired chartMode key (the chart card's old Stack | Waterfall toggle, removed when the card went back to the stack alone with the equation line under it): a stored blob carrying chartMode \"waterfall\" — a form saved while the toggle was in waterfall mode — parses to EXACTLY the same state as the same blob without the key (the key is not read, so the form opens on the stack with no error), the same holds for \"stack\" and for malformed values (an unknown string, a number, null), a revision-checked write on such a blob succeeds and the stored result carries no chartMode key (the retired key drops out on the next write), and an unrelated field write on the result round-trips normally.",
    run: () => {
      const failures: string[] = [];
      const baseObj = JSON.parse(legacyUiRaw()) as Record<string, unknown>;
      delete (baseObj.playground as Record<string, unknown>).chartMode;
      const baseRaw = JSON.stringify(baseObj);
      const baseParsed = JSON.stringify(parseRothUiState(baseRaw));
      for (const v of ["waterfall", "stack", "water", 1, null]) {
        const obj = JSON.parse(baseRaw) as Record<string, unknown>;
        (obj.playground as Record<string, unknown>).chartMode = v;
        let parsed: string;
        try {
          parsed = JSON.stringify(parseRothUiState(JSON.stringify(obj)));
        } catch (err) {
          failures.push(`chartMode ${JSON.stringify(v)}: parse threw ${String(err)}`);
          continue;
        }
        if (parsed !== baseParsed)
          failures.push(`chartMode ${JSON.stringify(v)}: expected the parse to ignore the retired key entirely`);
        if ("chartMode" in parseRothUiState(JSON.stringify(obj)).playground)
          failures.push(`chartMode ${JSON.stringify(v)}: parsed state must not carry the retired key`);
      }
      const wfObj = JSON.parse(baseRaw) as Record<string, unknown>;
      (wfObj.playground as Record<string, unknown>).chartMode = "waterfall";
      const res = applyRothUiWrite(JSON.stringify(wfObj), 0, (s) => {
        s.playground.conversion = "999";
      });
      if (res.status !== "ok") {
        failures.push(`write on a waterfall-saved blob: expected ok, got ${res.status}`);
        return failures;
      }
      const stored = JSON.parse(res.raw) as Record<string, unknown>;
      if ("chartMode" in (stored.playground as Record<string, unknown>))
        failures.push("stored blob: the retired chartMode key must drop out on write");
      if (parseRothUiState(res.raw).playground.conversion !== "999")
        failures.push("stored blob: expected the unrelated field write to land (conversion 999)");
      return failures;
    },
  },
  {
    id: "ui-cas-malformed-revision-reads-as-0",
    note: "A stored revision that is a string, negative, or fractional — and a wholly unparseable blob — all read leniently as revision 0 with defaults, never a crash.",
    run: () => {
      const failures: string[] = [];
      for (const bad of ["3", -2, 1.5]) {
        const raw = JSON.stringify({ ...parseRothUiState(undefined), revision: bad });
        const got = parseRothUiState(raw).revision;
        if (got !== 0) failures.push(`revision ${JSON.stringify(bad)}: expected 0, got ${got}`);
      }
      if (parseRothUiState("not json").revision !== 0)
        failures.push("unparseable blob: expected revision 0");
      if (parseRothUiState(undefined).revision !== 0)
        failures.push("missing blob: expected revision 0");
      return failures;
    },
  },
];

export function runRothUiStateFixtures(): {
  total: number;
  passed: number;
  results: RothUiStateFixtureResult[];
} {
  const results = uiCasCases.map((c) => {
    let failures: string[];
    try {
      failures = c.run();
    } catch (err) {
      failures = [`threw: ${String(err)}`];
    }
    return { id: c.id, kind: "uistate", pass: failures.length === 0, failures };
  });
  return {
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    results,
  };
}

/* ---------------- Roth plan-record CAS fixtures ----------------
   Pinned cases for the Roth plan record's revision/CAS write
   contract (server/src/rothRevisionCore.ts, API follow-on 1 /
   finding F3), run by the runAccuracySelfCheck "roth-cas"
   suite. They exercise the exact functions the handlers run —
   parseRothBlobRevision / rothBlobRevisionOf (the read paths),
   decideRothBlobWrite (saveRothInputs' fast-path check),
   withRothBlobRevision (its stamp), splitRothBlob / joinRothBlob
   with the third segment (the scenario writers' and reset's
   stamp), and commitGuardedRothBlobWrite /
   rothBlobStoredRawMatches (the testable mirror of the guarded
   SQL commit) — against synthetic stored blobs, never the
   user's data:
   (a) a stale- or future-base save is refused and storage is
       left untouched;
   (b) a matching-base save succeeds and increments, with the
       inputs and scenarios segments byte-identical apart from
       the revision key;
   (c) a legacy blob without a revision reads as revision 0 and
       its first write establishes revision 1, with no backfill;
   (d) the guarded commit, evaluated against the stored value
       as it stands at commit time: a write whose read value a
       concurrent write has already replaced affects 0 rows,
       while a write at the current value affects exactly 1.
   Expected values follow from the contract itself (revision
   arithmetic and segment preservation), not from app output. */

export type RothCasFixtureResult = {
  id: string;
  kind: string;
  pass: boolean;
  failures: string[];
};

// A stored Roth blob's plain JSON at a known revision (or, with
// no revision argument, exactly as a pre-revision writer wrote
// it: the two-key document). `birthYear` is a content marker so
// a case can tell two writes' contents apart.
function casBlob(revision?: number, birthYear = 1990): string {
  const blob: Record<string, unknown> = {
    inputs: { birthYearPrimary: birthYear, annualSpendingCents: 8707584 },
    scenarios: [{ name: "Scenario 1" }],
  };
  if (revision !== undefined) blob.revision = revision;
  return JSON.stringify(blob);
}

// The guarded-commit compose step the cases share: the
// successor is the current blob's own segments re-joined with
// the revision bumped by one — the scenario writers' stamp.
function casBumpCompose(
  currentPlain: string | undefined,
): { plain: string; revision: number } {
  const split = currentPlain ? splitRothBlob(currentPlain) : null;
  const next = parseRothBlobRevision(currentPlain) + 1;
  return {
    plain: joinRothBlob(split?.inputsRaw ?? null, split?.scenariosRaw ?? [], next),
    revision: next,
  };
}

const rothCasCases: {
  id: string;
  note: string;
  run: () => string[];
}[] = [
  {
    id: "roth-cas-legacy-blob-reads-revision-0",
    note: "A blob written before revisions existed (the two-key document, no revision key) reads as revision 0 — and so does every malformed revision (string, negative, fractional, null), an unparseable blob, and an absent blob. A well-formed revision reads as itself (control).",
    run: () => {
      const failures: string[] = [];
      if (parseRothBlobRevision(casBlob()) !== 0)
        failures.push("legacy blob: expected revision 0");
      for (const bad of ['"3"', "-2", "1.5", "null"]) {
        const raw = `{"inputs":{},"scenarios":[],"revision":${bad}}`;
        if (parseRothBlobRevision(raw) !== 0)
          failures.push(`revision ${bad}: expected 0, got ${parseRothBlobRevision(raw)}`);
      }
      if (parseRothBlobRevision("not json") !== 0)
        failures.push("unparseable blob: expected revision 0");
      if (parseRothBlobRevision(undefined) !== 0)
        failures.push("absent blob: expected revision 0");
      if (rothBlobRevisionOf(null) !== 0 || rothBlobRevisionOf([1, 2]) !== 0)
        failures.push("non-object blob values: expected revision 0");
      if (parseRothBlobRevision(casBlob(7)) !== 7)
        failures.push("control: a stored revision of 7 must read as 7");
      if (rothBlobRevisionOf({ revision: 4 }) !== 4)
        failures.push("control: rothBlobRevisionOf must read a parsed revision of 4 as 4");
      return failures;
    },
  },
  {
    id: "roth-cas-legacy-first-write-establishes-revision-1",
    note: "The first write against a legacy revision-less blob — at base 0, or with no base at all (the legacy unchecked path) — is allowed, and stamping it stores revision 1 with the inputs and scenarios segments byte-identical. No backfill write is needed: the blob gains its revision key only when a write lands.",
    run: () => {
      const failures: string[] = [];
      const stored = casBlob();
      const atBase0 = decideRothBlobWrite(0, 0);
      if (!atBase0.allowed || atBase0.nextRevision !== 1)
        failures.push("base 0 against a legacy blob must be allowed and store revision 1");
      const unchecked = decideRothBlobWrite(0, undefined);
      if (!unchecked.allowed || unchecked.nextRevision !== 1)
        failures.push("no base against a legacy blob must be allowed and store revision 1");
      const stamped = JSON.stringify(
        withRothBlobRevision(JSON.parse(stored) as Record<string, unknown>, 1),
      );
      if (parseRothBlobRevision(stamped) !== 1)
        failures.push(`stamped blob: expected revision 1, got ${parseRothBlobRevision(stamped)}`);
      const beforeSplit = splitRothBlob(stored);
      const afterSplit = splitRothBlob(stamped);
      if (JSON.stringify(afterSplit?.inputsRaw) !== JSON.stringify(beforeSplit?.inputsRaw))
        failures.push("stamping must not move the inputs segment");
      if (JSON.stringify(afterSplit?.scenariosRaw) !== JSON.stringify(beforeSplit?.scenariosRaw))
        failures.push("stamping must not move the scenarios segment");
      return failures;
    },
  },
  {
    id: "roth-cas-matching-write-increments",
    note: "A save at the current revision (2) is allowed and stores revision 3. The raw-path stamp (split/join with the third segment) and the plan writer's stamp (withRothBlobRevision over the composed document) produce the same three-key document, and both leave the inputs and scenarios segments byte-identical.",
    run: () => {
      const failures: string[] = [];
      const stored = casBlob(2);
      const decision = decideRothBlobWrite(2, 2);
      if (!decision.allowed || decision.nextRevision !== 3)
        failures.push("base == stored (2) must be allowed and store revision 3");
      const split = splitRothBlob(stored);
      if (!split) return ["stored blob failed to split"];
      const viaJoin = joinRothBlob(split.inputsRaw, split.scenariosRaw, 3);
      if (parseRothBlobRevision(viaJoin) !== 3)
        failures.push(`join-stamped blob: expected revision 3, got ${parseRothBlobRevision(viaJoin)}`);
      const viaStamp = JSON.stringify(
        withRothBlobRevision(
          { inputs: split.inputsRaw, scenarios: split.scenariosRaw },
          3,
        ),
      );
      if (viaStamp !== viaJoin)
        failures.push("the plan writer's stamp and the raw-path join must produce the same document");
      const after = splitRothBlob(viaJoin);
      if (JSON.stringify(after?.inputsRaw) !== JSON.stringify(split.inputsRaw))
        failures.push("inputs segment moved across a matching write");
      if (JSON.stringify(after?.scenariosRaw) !== JSON.stringify(split.scenariosRaw))
        failures.push("scenarios segment moved across a matching write");
      return failures;
    },
  },
  {
    id: "roth-cas-stale-write-refused-storage-untouched",
    note: "A save replaying an old base (1 against stored 2) is refused by the decision the handler runs on its decrypted read — before anything is composed or encrypted — and the guarded-commit predicate agrees the writer's read value is no longer the stored value. The stored blob afterwards is byte-identical to before.",
    run: () => {
      const failures: string[] = [];
      const stored = casBlob(2);
      const decision = decideRothBlobWrite(2, 1);
      if (decision.allowed)
        failures.push("base 1 against stored 2 must be refused");
      else if (decision.storedRevision !== 2)
        failures.push(`refusal must carry the stored revision 2, got ${decision.storedRevision}`);
      if (rothBlobStoredRawMatches(stored, casBlob(1)))
        failures.push("the commit predicate must see the writer's stale read value as no longer stored");
      if (!rothBlobStoredRawMatches(stored, casBlob(2)))
        failures.push("the commit predicate must match when the stored value is the value read");
      if (stored !== casBlob(2) || parseRothBlobRevision(stored) !== 2)
        failures.push("the stored blob changed under a refused write");
      return failures;
    },
  },
  {
    id: "roth-cas-future-base-refused",
    note: "A base from a 'future' revision (5 against stored 2) can never be valid — it claims a write that has not happened — and is refused exactly like a stale base.",
    run: () => {
      const failures: string[] = [];
      const decision = decideRothBlobWrite(2, 5);
      if (decision.allowed)
        failures.push("base 5 against stored 2 must be refused");
      else if (decision.storedRevision !== 2)
        failures.push(`refusal must carry the stored revision 2, got ${decision.storedRevision}`);
      return failures;
    },
  },
  {
    id: "roth-cas-absent-row-base-positive-refused",
    note: "A supplied base > 0 against an ABSENT row is refused: the absent row reads as revision 0, so the base cannot match, and nothing is written (the handler refuses on the decision, before any commit — the row stays absent). A base of 0 against the absent row is the establishing write and is allowed (control).",
    run: () => {
      const failures: string[] = [];
      if (parseRothBlobRevision(undefined) !== 0)
        failures.push("an absent row must read as revision 0");
      const refused = decideRothBlobWrite(0, 3);
      if (refused.allowed)
        failures.push("base 3 against an absent row must be refused");
      const establishing = decideRothBlobWrite(0, 0);
      if (!establishing.allowed || establishing.nextRevision !== 1)
        failures.push("control: base 0 against an absent row must establish revision 1");
      return failures;
    },
  },
  {
    id: "roth-cas-unchecked-write-still-bumps",
    note: "A write with no baseRevision (the legacy / dictated-write path) is always allowed and still bumps the revision — 2 to 3, and 0 to 1 on a fresh record — so CAS writers that read afterwards see the write.",
    run: () => {
      const failures: string[] = [];
      const atTwo = decideRothBlobWrite(2, undefined);
      if (!atTwo.allowed || atTwo.nextRevision !== 3)
        failures.push("unchecked write at stored 2 must store revision 3");
      const atZero = decideRothBlobWrite(0, undefined);
      if (!atZero.allowed || atZero.nextRevision !== 1)
        failures.push("unchecked write at stored 0 must store revision 1");
      return failures;
    },
  },
  {
    id: "roth-cas-guarded-commit-after-advance-affects-0-rows",
    note: "The simultaneity window, at the guarded-commit level: two writers both read the revision-2 blob; writer A's guarded commit lands (stored advances to revision 3); writer B's guarded commit is then evaluated against the commit-time stored value with the raw value B read — it affects 0 rows, produces no raw form to persist, carries the current revision 3 for the refusal, and the stored blob is left exactly as A wrote it. B's successor is never even composed (the predicate alone is the gate).",
    run: () => {
      const failures: string[] = [];
      const readRaw = casBlob(2);
      const a = commitGuardedRothBlobWrite(readRaw, readRaw, casBumpCompose);
      if (a.affectedRows !== 1) {
        failures.push(`writer A: expected 1 affected row, got ${a.affectedRows}`);
        return failures;
      }
      if (a.revision !== 3) failures.push(`writer A revision: expected 3, got ${a.revision}`);
      let composed = false;
      const b = commitGuardedRothBlobWrite(a.raw, readRaw, (cur) => {
        composed = true;
        return casBumpCompose(cur);
      });
      if (b.affectedRows !== 0) {
        failures.push(`writer B: expected 0 affected rows, got ${b.affectedRows}`);
        return failures;
      }
      if ("raw" in b) failures.push("writer B: a 0-row commit must not carry a raw form to persist");
      if (b.revision !== 3) failures.push(`writer B conflict revision: expected 3, got ${b.revision}`);
      if (composed) failures.push("writer B: the successor must not be composed once the predicate fails");
      if (parseRothBlobRevision(a.raw) !== 3)
        failures.push("the stored blob changed under writer B's refused commit");
      return failures;
    },
  },
  {
    id: "roth-cas-guarded-commit-at-current-value-affects-1-row",
    note: "A guarded commit evaluated while the stored raw value still equals the value the writer read affects exactly 1 row and stores the successor at revision + 1 — including against a legacy revision-less blob, whose successor establishes revision 1 (the absent revision key counts as 0 under the same lenient read the decision uses).",
    run: () => {
      const failures: string[] = [];
      const current = casBlob(2);
      const res = commitGuardedRothBlobWrite(current, current, casBumpCompose);
      if (res.affectedRows !== 1) {
        failures.push(`expected 1 affected row, got ${res.affectedRows}`);
        return failures;
      }
      if (res.revision !== 3) failures.push(`revision: expected 3, got ${res.revision}`);
      if (parseRothBlobRevision(res.raw) !== 3)
        failures.push(`stored revision: expected 3, got ${parseRothBlobRevision(res.raw)}`);
      const beforeSplit = splitRothBlob(current);
      const afterSplit = splitRothBlob(res.raw);
      if (JSON.stringify(afterSplit?.inputsRaw) !== JSON.stringify(beforeSplit?.inputsRaw))
        failures.push("the committed successor must preserve the inputs segment");
      const legacyRaw = casBlob();
      const legacy = commitGuardedRothBlobWrite(legacyRaw, legacyRaw, casBumpCompose);
      if (legacy.affectedRows !== 1)
        failures.push(`legacy blob: expected 1 affected row, got ${legacy.affectedRows}`);
      else if (legacy.revision !== 1 || parseRothBlobRevision(legacy.raw) !== 1)
        failures.push("legacy blob: the commit must establish revision 1");
      return failures;
    },
  },
  {
    id: "roth-cas-scenario-writer-bumps-and-preserves",
    note: "The scenario writers' raw path, exactly as mutateRothScenarios runs it: split the stored blob (revision 4), append a scenario, re-join with the revision stamped stored + 1. The inputs segment comes back byte-identical, the scenarios array gains exactly the appended record with the existing one untouched, and the revision advances by exactly 1.",
    run: () => {
      const failures: string[] = [];
      const stored = casBlob(4);
      const split = splitRothBlob(stored);
      if (!split) return ["stored blob failed to split"];
      const storedRevision = rothBlobRevisionValue(split.revisionRaw);
      if (storedRevision !== 4)
        failures.push(`split revisionRaw: expected 4, got ${storedRevision}`);
      const scenariosRaw = split.scenariosRaw as unknown[];
      const nextPlain = joinRothBlob(
        split.inputsRaw,
        [...scenariosRaw, { name: "Scenario 2" }],
        storedRevision + 1,
      );
      if (parseRothBlobRevision(nextPlain) !== 5)
        failures.push(`revision after a scenario write: expected 5, got ${parseRothBlobRevision(nextPlain)}`);
      const after = splitRothBlob(nextPlain);
      if (JSON.stringify(after?.inputsRaw) !== JSON.stringify(split.inputsRaw))
        failures.push("a scenario write must leave the inputs segment byte-identical");
      const afterScenarios = (after?.scenariosRaw ?? []) as { name?: unknown }[];
      if (afterScenarios.length !== 2)
        failures.push(`scenarios after append: expected 2, got ${afterScenarios.length}`);
      if (JSON.stringify(afterScenarios[0]) !== JSON.stringify(scenariosRaw[0]))
        failures.push("the pre-existing scenario must pass through untouched");
      if (afterScenarios[1]?.name !== "Scenario 2")
        failures.push("the appended scenario must be the second record");
      return failures;
    },
  },
  {
    id: "roth-cas-conflict-record-is-current",
    note: "The client recovery contract: a writer read revision 2 (content marker birthYear 1990); an interleaved write then stored revision 3 with different content (marker 1980). The writer's save is refused, and the record the refusal carries — built from the CURRENT stored blob, the way loadRothPlannerResponse reads it at refusal time — reflects the interleaved write (revision 3, marker 1980), never the stale read, so rehydrating from it shows the latest saved version.",
    run: () => {
      const failures: string[] = [];
      const staleRead = casBlob(2, 1990);
      const current = casBlob(3, 1980);
      const decision = decideRothBlobWrite(
        parseRothBlobRevision(current),
        parseRothBlobRevision(staleRead),
      );
      if (decision.allowed)
        failures.push("a save based on the stale read must be refused once the stored revision has advanced");
      const recordRevision = parseRothBlobRevision(current);
      const recordInputs = (
        JSON.parse(current) as { inputs: { birthYearPrimary: number } }
      ).inputs;
      if (recordRevision !== 3)
        failures.push(`conflict record revision: expected 3, got ${recordRevision}`);
      if (recordInputs.birthYearPrimary !== 1980)
        failures.push(
          `conflict record must carry the interleaved write's content (marker 1980), got ${recordInputs.birthYearPrimary}`,
        );
      return failures;
    },
  },
  {
    id: "roth-cas-first-write-plan-table",
    note: "Pin rothFirstWritePlan's table: (no row, base 0) → insert-only; (no row, no base) → legacy-upsert; (no row, base 3) → refused; (row, base 0 / base 3 / no base) → guarded-update. Plus the two-racer sequence at the decision level: both racers plan insert-only; the winner's commit establishes revision 1; the loser's post-collision checked decision against the winner's state at base 0 is refused, carrying storedRevision 1. The DB-level race is exercised by live probe in the review passes, not by this harness (it cannot import actions.ts); and within the existing-row path a no-base write still takes the legacy upsert exactly as before — the plan names the path family, it does not change legacy behaviour.",
    run: () => {
      const failures: string[] = [];
      if (rothFirstWritePlan(false, 0) !== "insert-only")
        failures.push("(no row, base 0) must plan insert-only");
      if (rothFirstWritePlan(false, undefined) !== "legacy-upsert")
        failures.push("(no row, no base) must plan legacy-upsert");
      if (rothFirstWritePlan(false, 3) !== "refused")
        failures.push("(no row, base 3) must plan refused");
      if (rothFirstWritePlan(true, 0) !== "guarded-update")
        failures.push("(row, base 0) must plan guarded-update");
      if (rothFirstWritePlan(true, 3) !== "guarded-update")
        failures.push("(row, base 3) must plan guarded-update");
      if (rothFirstWritePlan(true, undefined) !== "guarded-update")
        failures.push("(row, no base) must plan guarded-update");
      const winnerState = rothBlobRevisionState(JSON.parse(casBlob(1)) as unknown);
      const loser = decideRothBlobWriteChecked(winnerState, 0);
      if (loser.allowed)
        failures.push("the loser's post-collision checked decision at base 0 must be refused");
      else if (loser.storedRevision !== 1)
        failures.push(`loser refusal must carry storedRevision 1, got ${loser.storedRevision}`);
      return failures;
    },
  },
  {
    id: "roth-cas-reset-retry-bounded-refusal",
    note: "Pin decideRothResetAfterLoss: ROTH_RESET_MAX_ATTEMPTS === 5; lostRaces 1–4 → retry; 5 → refuse; iterate lostRaces 0–12 and assert every outcome is retry or refuse (no unconditional-write outcome exists in the decision set). The handler loop itself is verified by source inspection + pass probes (harness cannot import actions.ts).",
    run: () => {
      const failures: string[] = [];
      if (ROTH_RESET_MAX_ATTEMPTS !== 5)
        failures.push(`ROTH_RESET_MAX_ATTEMPTS: expected 5, got ${ROTH_RESET_MAX_ATTEMPTS}`);
      for (let n = 1; n <= 4; n++) {
        if (decideRothResetAfterLoss(n) !== "retry")
          failures.push(`lostRaces ${n} must retry`);
      }
      if (decideRothResetAfterLoss(5) !== "refuse")
        failures.push("lostRaces 5 must refuse");
      for (let n = 0; n <= 12; n++) {
        const o = decideRothResetAfterLoss(n);
        if (o !== "retry" && o !== "refuse")
          failures.push(`lostRaces ${n}: outcome ${String(o)} is not retry/refuse`);
      }
      return failures;
    },
  },
  {
    id: "roth-cas-invalid-stored-revision-checked-refused",
    note: "For each stored revision shape \"12\" (string), 12.5 (fractional), -3 (negative): rothBlobRevisionState → { revision: 0, present: true, valid: false }; the lenient reads still yield 0 (parseRothBlobRevision and rothBlobRevisionOf) and the document still parses; the strict decision refuses a checked write at base 0; an unchecked write (no base) is allowed and stamps nextRevision 1. Controls: key absent → { 0, false, true } and a checked base-0 write is allowed (nextRevision 1); key present and valid (7) → { 7, true, true }, base 7 allowed → 8, base 0 refused (ordinary CAS unchanged).",
    run: () => {
      const failures: string[] = [];
      for (const bad of ['"12"', "12.5", "-3"]) {
        const raw = `{"inputs":{},"scenarios":[],"revision":${bad}}`;
        const parsed = JSON.parse(raw) as unknown;
        const state = rothBlobRevisionState(parsed);
        if (state.revision !== 0 || !state.present || state.valid)
          failures.push(`revision ${bad}: expected {0,true,false}, got ${JSON.stringify(state)}`);
        if (parseRothBlobRevision(raw) !== 0)
          failures.push(`revision ${bad}: lenient parse must yield 0`);
        if (rothBlobRevisionOf(parsed) !== 0)
          failures.push(`revision ${bad}: lenient rothBlobRevisionOf must yield 0`);
        const checked = decideRothBlobWriteChecked(state, 0);
        if (checked.allowed)
          failures.push(`revision ${bad}: checked write at base 0 must be refused`);
        const unchecked = decideRothBlobWriteChecked(state, undefined);
        if (!unchecked.allowed || unchecked.nextRevision !== 1)
          failures.push(`revision ${bad}: unchecked write must be allowed and stamp 1`);
      }
      const absentState = rothBlobRevisionState(JSON.parse(casBlob()) as unknown);
      if (absentState.revision !== 0 || absentState.present || !absentState.valid)
        failures.push(`absent key: expected {0,false,true}, got ${JSON.stringify(absentState)}`);
      const absentChecked = decideRothBlobWriteChecked(absentState, 0);
      if (!absentChecked.allowed || absentChecked.nextRevision !== 1)
        failures.push("absent key: checked base-0 write must be allowed and stamp 1");
      const validState = rothBlobRevisionState(JSON.parse(casBlob(7)) as unknown);
      if (validState.revision !== 7 || !validState.present || !validState.valid)
        failures.push(`valid 7: expected {7,true,true}, got ${JSON.stringify(validState)}`);
      const at7 = decideRothBlobWriteChecked(validState, 7);
      if (!at7.allowed || at7.nextRevision !== 8)
        failures.push("valid 7: base 7 must be allowed → 8");
      const at0 = decideRothBlobWriteChecked(validState, 0);
      if (at0.allowed)
        failures.push("valid 7: base 0 must be refused");
      return failures;
    },
  },
  {
    id: "roth-cas-restore-generation-refusal-arithmetic",
    note: "Pin restoredRothBlobRevision: (41,41) → 42; (50,41) → 51; (0,41) → 42; (0,0) → 1. Then the CAS half of the F4 contract: against a stamped revision-42 state, checked writes at base 41 (the pre-restore base AND the backup's base) are refused and base 42 is allowed (→ 43); against a stamped 51, bases 50 and 41 are refused and 51 is allowed.",
    run: () => {
      const failures: string[] = [];
      if (restoredRothBlobRevision(41, 41) !== 42)
        failures.push("(41,41) must stamp 42");
      if (restoredRothBlobRevision(50, 41) !== 51)
        failures.push("(50,41) must stamp 51");
      if (restoredRothBlobRevision(0, 41) !== 42)
        failures.push("(0,41) must stamp 42");
      if (restoredRothBlobRevision(0, 0) !== 1)
        failures.push("(0,0) must stamp 1");
      const state42 = rothBlobRevisionState(JSON.parse(casBlob(42)) as unknown);
      if (decideRothBlobWriteChecked(state42, 41).allowed)
        failures.push("stamped 42: base 41 must be refused");
      const at42 = decideRothBlobWriteChecked(state42, 42);
      if (!at42.allowed || at42.nextRevision !== 43)
        failures.push("stamped 42: base 42 must be allowed → 43");
      const state51 = rothBlobRevisionState(JSON.parse(casBlob(51)) as unknown);
      if (decideRothBlobWriteChecked(state51, 50).allowed)
        failures.push("stamped 51: base 50 must be refused");
      if (decideRothBlobWriteChecked(state51, 41).allowed)
        failures.push("stamped 51: base 41 must be refused");
      const at51 = decideRothBlobWriteChecked(state51, 51);
      if (!at51.allowed || at51.nextRevision !== 52)
        failures.push("stamped 51: base 51 must be allowed → 52");
      return failures;
    },
  },
];

export function runRothCasFixtures(): {
  total: number;
  passed: number;
  results: RothCasFixtureResult[];
} {
  const results = rothCasCases.map((c) => {
    let failures: string[];
    try {
      failures = c.run();
    } catch (err) {
      failures = [`threw: ${String(err)}`];
    }
    return { id: c.id, kind: "rothcas", pass: failures.length === 0, failures };
  });
  return {
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    results,
  };
}

/* ---------------- Retirement records CAS fixtures ----------------
   Pinned cases for the two Retirement records' revision/CAS
   write contract (API follow-on F23), run by the
   runAccuracySelfCheck "retirement-cas" suite. The Retirement
   handlers SHARE the Roth record's CAS core
   (server/src/rothRevisionCore.ts) — the lenient revision read,
   decideRothBlobWrite, and the guarded-commit mirror are the
   same functions the roth-cas cases pin — and add the
   Retirement-specific pure functions that module's F23 section
   holds (the two blob composes, the scenario transforms, the
   capture predicate, and the baseline pair-commit table),
   which these cases pin here against synthetic stored blobs,
   never the user's data:
   (a) a stale- or future-base save on blob 1 is refused and
       storage is left untouched;
   (b) a matching-base save succeeds and increments, with all
       17 input fields and the scenarios array deep-equal apart
       from the revision key (the Retirement invariant is
       field-level — there is no split/join and no string
       identity to pin);
   (c) legacy blobs without a revision read as revision 0 and
       their first writes establish revision 1, with no
       backfill;
   (d) the scenario writers bump the revision and preserve
       every non-scenarios top-level field, and their retry
       re-applies the transform against the fresh blob;
   (e) "Make this my plan" bumps BOTH revisions, its baseline
       guard retries once, and a second lost race reports the
       honest stage: "baseline" shape (the pair-commit table);
   (f) the session-baseline capture is insert-if-absent
       (guard-or-skip): it can create the row at revision 1
       but can never replace an existing baseline.
   Expected values follow from the contract itself, not from
   app output. */

export type RetirementCasFixtureResult = {
  id: string;
  kind: string;
  pass: boolean;
  failures: string[];
};

// A full 17-field Retirement input set. `spendingCents` is the
// content marker cases vary to tell two writes apart.
function retInputs(spendingCents = 12000000): Record<string, unknown> {
  return {
    portfolioCents: 500000000,
    spendingCents,
    currentAge: 55,
    retirementAge: 57,
    endAge: 95,
    stocksPct: 80,
    extraIncomeCents: 0,
    extraIncomeStartAge: 67,
    expectedReturnPct: 5.5,
    volatilityPct: 12,
    strategy: "constant",
    percentOfPortfolio: 5,
    guardrailsCutPct: 120,
    guardrailsRaisePct: 80,
    guardrailsAdjustmentPct: 10,
    phaseStartAge: 75,
    phaseDeclinePct: 1,
  };
}

// A scenario record: a name plus the same 17 fields.
type RetScenarioDoc = { name: string } & Record<string, unknown>;
function retScenario(
  name: string,
  spendingCents = 12000000,
): RetScenarioDoc {
  return { name, ...retInputs(spendingCents) } as RetScenarioDoc;
}

// A stored blob 1's plain JSON at a known revision (or, with no
// revision argument, exactly as a pre-revision writer wrote it).
function retBlob1(
  revision?: number,
  spendingCents?: number,
  scenarios: unknown[] = [],
): string {
  const doc: Record<string, unknown> = {
    ...retInputs(spendingCents),
    scenarios,
  };
  if (revision !== undefined) doc.revision = revision;
  return JSON.stringify(doc);
}

// A stored blob 2's plain JSON at a known revision (or legacy).
function retBlob2(
  revision?: number,
  kind = "saved",
  spendingCents?: number,
): string {
  const doc: Record<string, unknown> = {
    kind,
    inputs: retInputs(spendingCents),
  };
  if (revision !== undefined) doc.revision = revision;
  return JSON.stringify(doc);
}

function parseDoc(raw: string): Record<string, unknown> {
  return JSON.parse(raw) as Record<string, unknown>;
}

// The document with its revision key removed — the field-level
// comparison the D2 invariant pins (equality apart from the
// revision key).
function stripRevision(doc: Record<string, unknown>): Record<string, unknown> {
  const { revision: _revision, ...rest } = doc;
  return rest;
}

const deepEq = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

// The guarded-commit compose step the blob-1 cases share: the
// successor is the current blob's own fields and scenarios
// re-composed with the revision bumped by one — the inputs
// writers' stamp.
function retBumpCompose(
  currentPlain: string | undefined,
): { plain: string; revision: number } {
  const doc = currentPlain ? parseDoc(currentPlain) : {};
  const { scenarios, revision: _rev, ...fields } = doc;
  const next = parseRothBlobRevision(currentPlain) + 1;
  return {
    plain: JSON.stringify(
      composeRetirementInputsBlob(fields, scenarios ?? [], next),
    ),
    revision: next,
  };
}

// The guarded-commit compose step for blob 2: the baseline
// successor is fully determined by the commanded snapshot —
// { kind: "saved", inputs } with the revision bumped by one.
function retBaselineBumpCompose(commanded: Record<string, unknown>) {
  return (
    currentPlain: string | undefined,
  ): { plain: string; revision: number } => {
    const next = parseRothBlobRevision(currentPlain) + 1;
    return {
      plain: JSON.stringify(
        composeRetirementBaselineBlob("saved", commanded, next),
      ),
      revision: next,
    };
  };
}

const retirementCasCases: {
  id: string;
  note: string;
  run: () => string[];
}[] = [
  {
    id: "ret-cas-legacy-blobs-read-revision-0",
    note: "BOTH blobs: a document with no revision key reads as revision 0 — and so does every malformed revision (string, negative, fractional, null) on either blob's shape. Well-formed revisions read as themselves (controls: blob 1 at 7, blob 2 at 3).",
    run: () => {
      const failures: string[] = [];
      if (parseRothBlobRevision(retBlob1()) !== 0)
        failures.push("legacy blob 1: expected revision 0");
      if (parseRothBlobRevision(retBlob2()) !== 0)
        failures.push("legacy blob 2: expected revision 0");
      for (const bad of ['"3"', "-2", "1.5", "null"]) {
        const raw1 = `{"portfolioCents":1,"scenarios":[],"revision":${bad}}`;
        if (parseRothBlobRevision(raw1) !== 0)
          failures.push(`blob 1 revision ${bad}: expected 0`);
        const raw2 = `{"kind":"saved","inputs":{},"revision":${bad}}`;
        if (parseRothBlobRevision(raw2) !== 0)
          failures.push(`blob 2 revision ${bad}: expected 0`);
      }
      if (rothBlobRevisionOf(parseDoc(retBlob1(7))) !== 7)
        failures.push("control: blob 1 at revision 7 must read as 7");
      if (rothBlobRevisionOf(parseDoc(retBlob2(3))) !== 3)
        failures.push("control: blob 2 at revision 3 must read as 3");
      if (parseRothBlobRevision(undefined) !== 0)
        failures.push("absent blob: expected revision 0");
      return failures;
    },
  },
  {
    id: "ret-cas-legacy-first-write-establishes-revision-1",
    note: "Blob 1 absent / rev-0: the first write — at base 0, or with no base at all (the legacy unchecked path) — is allowed, and the compose stores revision 1 with the input fields and the scenarios array exactly as composed. No backfill: the blob gains its revision key only when a write lands.",
    run: () => {
      const failures: string[] = [];
      const atBase0 = decideRothBlobWrite(0, 0);
      if (!atBase0.allowed || atBase0.nextRevision !== 1)
        failures.push("base 0 against a legacy blob must be allowed and store revision 1");
      const unchecked = decideRothBlobWrite(0, undefined);
      if (!unchecked.allowed || unchecked.nextRevision !== 1)
        failures.push("no base against a legacy blob must be allowed and store revision 1");
      const scenarios = [retScenario("Scenario 1")];
      const composed = composeRetirementInputsBlob(retInputs(), scenarios, 1);
      if (rothBlobRevisionOf(composed) !== 1)
        failures.push("composed blob: expected revision 1");
      if (!deepEq(stripRevision(composed), { ...retInputs(), scenarios }))
        failures.push("composed blob: fields and scenarios must be exactly as composed");
      return failures;
    },
  },
  {
    id: "ret-cas-matching-write-increments-fields-exact",
    note: "A save at the current revision (2) is allowed and stores revision 3. The composed successor carries all 17 fields of the new input set exactly (deep-equal), and the scenarios array preserved from the read deep-equal — the D2 invariant: field-level equality apart from the revision key, not string identity.",
    run: () => {
      const failures: string[] = [];
      const storedScenarios = [retScenario("Scenario 1", 111)];
      const decision = decideRothBlobWrite(2, 2);
      if (!decision.allowed || decision.nextRevision !== 3)
        failures.push("base == stored (2) must be allowed and store revision 3");
      const newInputs = retInputs(222);
      const composed = composeRetirementInputsBlob(newInputs, storedScenarios, 3);
      if (rothBlobRevisionOf(composed) !== 3)
        failures.push(`composed revision: expected 3, got ${rothBlobRevisionOf(composed)}`);
      if (!deepEq(stripRevision(composed), { ...newInputs, scenarios: storedScenarios }))
        failures.push("composed successor must carry the 17 fields and the preserved scenarios exactly");
      for (const field of Object.keys(retInputs())) {
        if (!deepEq(composed[field], newInputs[field]))
          failures.push(`field ${field} must be exact after a matching write`);
      }
      return failures;
    },
  },
  {
    id: "ret-cas-stale-write-refused-storage-untouched",
    note: "A save replaying an old base (1 against stored 2) is refused by the decision the handler runs on its decrypted read — before anything is composed or encrypted — and the guarded-commit predicate agrees the writer's read value is no longer the stored value. The stored blob afterwards is byte-identical to before.",
    run: () => {
      const failures: string[] = [];
      const stored = retBlob1(2);
      const decision = decideRothBlobWrite(2, 1);
      if (decision.allowed)
        failures.push("base 1 against stored 2 must be refused");
      else if (decision.storedRevision !== 2)
        failures.push(`refusal must carry the stored revision 2, got ${decision.storedRevision}`);
      if (rothBlobStoredRawMatches(stored, retBlob1(1)))
        failures.push("the commit predicate must see the writer's stale read value as no longer stored");
      if (!rothBlobStoredRawMatches(stored, retBlob1(2)))
        failures.push("the commit predicate must match when the stored value is the value read");
      if (stored !== retBlob1(2) || parseRothBlobRevision(stored) !== 2)
        failures.push("the stored blob changed under a refused write");
      return failures;
    },
  },
  {
    id: "ret-cas-future-base-refused",
    note: "A base from a 'future' revision (5 against stored 2) can never be valid and is refused exactly like a stale base.",
    run: () => {
      const failures: string[] = [];
      const decision = decideRothBlobWrite(2, 5);
      if (decision.allowed)
        failures.push("base 5 against stored 2 must be refused");
      else if (decision.storedRevision !== 2)
        failures.push(`refusal must carry the stored revision 2, got ${decision.storedRevision}`);
      return failures;
    },
  },
  {
    id: "ret-cas-absent-row-base-positive-refused",
    note: "A supplied base > 0 against an ABSENT row is refused: the absent row reads as revision 0, so the base cannot match, and nothing is written. A base of 0 against the absent row is the establishing write and is allowed (control).",
    run: () => {
      const failures: string[] = [];
      if (parseRothBlobRevision(undefined) !== 0)
        failures.push("an absent row must read as revision 0");
      const refused = decideRothBlobWrite(0, 3);
      if (refused.allowed)
        failures.push("base 3 against an absent row must be refused");
      const establishing = decideRothBlobWrite(0, 0);
      if (!establishing.allowed || establishing.nextRevision !== 1)
        failures.push("control: base 0 against an absent row must establish revision 1");
      return failures;
    },
  },
  {
    id: "ret-cas-unchecked-write-still-bumps",
    note: "A write with no baseRevision (the legacy / dictated-write path) is always allowed and still bumps the revision — 2 to 3, and 0 to 1 on a fresh record — so CAS writers that read afterwards see the write.",
    run: () => {
      const failures: string[] = [];
      const atTwo = decideRothBlobWrite(2, undefined);
      if (!atTwo.allowed || atTwo.nextRevision !== 3)
        failures.push("unchecked write at stored 2 must store revision 3");
      const atZero = decideRothBlobWrite(0, undefined);
      if (!atZero.allowed || atZero.nextRevision !== 1)
        failures.push("unchecked write at stored 0 must store revision 1");
      return failures;
    },
  },
  {
    id: "ret-cas-guarded-commit-after-advance-affects-0-rows",
    note: "The simultaneity window, at the guarded-commit level: two writers both read the revision-2 blob 1; writer A's guarded commit lands (stored advances to revision 3); writer B's guarded commit is then evaluated against the commit-time stored value with the raw value B read — it affects 0 rows, produces no raw form to persist, carries the current revision 3 for the refusal, and the stored blob is left exactly as A wrote it. B's successor is never even composed (the predicate alone is the gate).",
    run: () => {
      const failures: string[] = [];
      const readRaw = retBlob1(2);
      const a = commitGuardedRothBlobWrite(readRaw, readRaw, retBumpCompose);
      if (a.affectedRows !== 1) {
        failures.push(`writer A: expected 1 affected row, got ${a.affectedRows}`);
        return failures;
      }
      if (a.revision !== 3) failures.push(`writer A revision: expected 3, got ${a.revision}`);
      let composed = false;
      const b = commitGuardedRothBlobWrite(a.raw, readRaw, (cur) => {
        composed = true;
        return retBumpCompose(cur);
      });
      if (b.affectedRows !== 0) {
        failures.push(`writer B: expected 0 affected rows, got ${b.affectedRows}`);
        return failures;
      }
      if ("raw" in b) failures.push("writer B: a 0-row commit must not carry a raw form to persist");
      if (b.revision !== 3) failures.push(`writer B conflict revision: expected 3, got ${b.revision}`);
      if (composed) failures.push("writer B: the successor must not be composed once the predicate fails");
      if (parseRothBlobRevision(a.raw) !== 3)
        failures.push("the stored blob changed under writer B's refused commit");
      return failures;
    },
  },
  {
    id: "ret-cas-guarded-commit-at-current-value-affects-1-row",
    note: "A guarded commit evaluated while the stored raw value still equals the value the writer read affects exactly 1 row and stores the successor at revision + 1, fields and scenarios preserved exactly — including against a legacy revision-less blob, whose successor establishes revision 1.",
    run: () => {
      const failures: string[] = [];
      const scenarios = [retScenario("Scenario 1", 111)];
      const current = retBlob1(2, 12000000, scenarios);
      const res = commitGuardedRothBlobWrite(current, current, retBumpCompose);
      if (res.affectedRows !== 1) {
        failures.push(`expected 1 affected row, got ${res.affectedRows}`);
        return failures;
      }
      if (res.revision !== 3) failures.push(`revision: expected 3, got ${res.revision}`);
      if (!deepEq(stripRevision(parseDoc(res.raw)), stripRevision(parseDoc(current))))
        failures.push("the committed successor must preserve every field and the scenarios exactly");
      const legacyRaw = retBlob1(undefined, 12000000, scenarios);
      const legacy = commitGuardedRothBlobWrite(legacyRaw, legacyRaw, retBumpCompose);
      if (legacy.affectedRows !== 1)
        failures.push(`legacy blob: expected 1 affected row, got ${legacy.affectedRows}`);
      else if (legacy.revision !== 1 || parseRothBlobRevision(legacy.raw) !== 1)
        failures.push("legacy blob: the commit must establish revision 1");
      return failures;
    },
  },
  {
    id: "ret-cas-scenario-writer-bumps-and-preserves",
    note: "The scenario writers' path, exactly as mutateRetirementScenarios runs it: parse the stored blob (revision 4), apply the append transform (auto-named smallest free slot), stamp the successor stored + 1 with the revision assigned after the spread. Every non-scenarios top-level field is deep-equal, the existing scenario is untouched, and the revision advances by exactly 1. The transforms' validation verdicts (cap reached, not found, blank name, colliding name) and the rename no-op all decline to write against the current array, carrying the current scenarios and (in the handler's response) the current revision.",
    run: () => {
      const failures: string[] = [];
      const existing = parseDoc(retBlob1(4, 111, [retScenario("Scenario 1", 111)]));
      const storedScenarios = parseDoc(retBlob1(4, 111, [retScenario("Scenario 1", 111)])).scenarios as RetScenarioDoc[];
      const t = appendRetirementScenario(storedScenarios, retInputs(222));
      if (!t.write) return ["append transform must write against a 1-scenario blob"];
      if (!t.ok || t.reason !== "Saved as Scenario 2.")
        failures.push(`append verdict: expected ok "Saved as Scenario 2.", got "${t.reason}"`);
      const successor = composeRetirementScenarioBlob(existing, t.scenarios, 5);
      if (rothBlobRevisionOf(successor) !== 5)
        failures.push(`successor revision: expected 5, got ${rothBlobRevisionOf(successor)}`);
      const { scenarios: _s, revision: _r, ...restAfter } = successor;
      const { scenarios: _s2, revision: _r2, ...restBefore } = existing;
      if (!deepEq(restAfter, restBefore))
        failures.push("a scenario write must preserve every non-scenarios field exactly");
      const afterScenarios = successor.scenarios as Record<string, unknown>[];
      if (afterScenarios.length !== 2)
        failures.push(`scenarios after append: expected 2, got ${afterScenarios.length}`);
      if (!deepEq(afterScenarios[0], storedScenarios[0]))
        failures.push("the pre-existing scenario must pass through untouched");
      if (afterScenarios[1]?.name !== "Scenario 2")
        failures.push("the appended scenario must take the smallest free name");
      // Validation verdicts decline to write against the current array.
      const three = [retScenario("Scenario 1"), retScenario("Scenario 2"), retScenario("Scenario 3")];
      const cap = appendRetirementScenario(three, retInputs());
      if (cap.write || cap.ok)
        failures.push("append at the cap of 3 must decline (write false, ok false)");
      else if (cap.reason !== "You already have 3 scenarios saved — delete one to save another.")
        failures.push(`cap reason moved: "${cap.reason}"`);
      const delMissing = deleteRetirementScenario(storedScenarios, "Nope");
      if (delMissing.write || delMissing.ok || delMissing.reason !== "That scenario was not found.")
        failures.push("delete of a missing name must decline with the not-found verdict");
      const del = deleteRetirementScenario(storedScenarios, "Scenario 1");
      if (!del.write || !del.ok || del.scenarios.length !== 0)
        failures.push("delete of an existing name must write the filtered array");
      const blank = renameRetirementScenario(storedScenarios, "Scenario 1", "   ");
      if (blank.write || blank.ok || blank.reason !== "Give the scenario a name first.")
        failures.push("rename to a blank name must decline with the blank verdict");
      const two = [retScenario("Scenario 1"), retScenario("Scenario 2")];
      const collide = renameRetirementScenario(two, "Scenario 1", "Scenario 2");
      if (collide.write || collide.ok || collide.reason !== "Another scenario already uses that name.")
        failures.push("rename onto a sibling's name must decline with the collision verdict");
      const unchanged = renameRetirementScenario(two, "Scenario 1", "Scenario 1");
      if (unchanged.write || !unchanged.ok || unchanged.reason !== "Name unchanged.")
        failures.push("rename to the same name must be a successful no-write");
      const renamed = renameRetirementScenario(two, "Scenario 1", "  Beach house  ");
      if (!renamed.write || !renamed.ok || renamed.scenarios[0]?.name !== "Beach house")
        failures.push("rename must write the trimmed name onto the target only");
      return failures;
    },
  },
  {
    id: "ret-cas-scenario-retry-absorbs-one-race",
    note: "The retry, at the level the handler composes it: a scenario append composed against the revision-2 blob (inputs marker 111) loses its guarded commit when an interleaved write advances the stored blob to revision 3 with NEWER inputs (marker 222) and an extra scenario. Re-applying the SAME transform against the fresh blob lands the append on the newer inputs fields and the newer scenarios array (auto-name takes the smallest free slot of the FRESH array), stamped fresh + 1. A second lost race leaves the freshest blob untouched, and the failure shape the handler returns carries that freshest array and revision.",
    run: () => {
      const failures: string[] = [];
      const staleRaw = retBlob1(2, 111, [retScenario("Scenario 1", 111)]);
      const staleScenarios = parseDoc(staleRaw).scenarios as RetScenarioDoc[];
      const t1 = appendRetirementScenario(staleScenarios, retInputs(333));
      if (!t1.write) return ["first append transform must write"];
      const staleSuccessor = JSON.stringify(
        composeRetirementScenarioBlob(parseDoc(staleRaw), t1.scenarios, 3),
      );
      // The interleaved write lands first: revision 3, inputs
      // marker 222, scenarios [Scenario 1, Scenario 2].
      const freshRaw = retBlob1(3, 222, [
        retScenario("Scenario 1", 222),
        retScenario("Scenario 2", 222),
      ]);
      const lost = commitGuardedRothBlobWrite(freshRaw, staleRaw, () => ({
        plain: staleSuccessor,
        revision: 3,
      }));
      if (lost.affectedRows !== 0)
        failures.push("the stale scenario commit must affect 0 rows after the advance");
      // Retry: re-apply against the fresh blob.
      const freshDoc = parseDoc(freshRaw);
      const freshScenarios = freshDoc.scenarios as RetScenarioDoc[];
      const t2 = appendRetirementScenario(freshScenarios, retInputs(333));
      if (!t2.write) return ["retry append transform must write"];
      const retrySuccessor = composeRetirementScenarioBlob(freshDoc, t2.scenarios, 4);
      if (rothBlobRevisionOf(retrySuccessor) !== 4)
        failures.push("retry successor must stamp fresh revision + 1 (4)");
      if (retrySuccessor.spendingCents !== 222)
        failures.push("retry must land on the NEWER inputs fields (marker 222), not the stale read's");
      const retryScenarios = retrySuccessor.scenarios as Record<string, unknown>[];
      if (retryScenarios.length !== 3 || retryScenarios[2]?.name !== "Scenario 3")
        failures.push("retry append must take the smallest free name of the fresh array (Scenario 3)");
      const landed = commitGuardedRothBlobWrite(freshRaw, freshRaw, () => ({
        plain: JSON.stringify(retrySuccessor),
        revision: 4,
      }));
      if (landed.affectedRows !== 1)
        failures.push("the retried commit at the fresh value must affect exactly 1 row");
      // A second lost race: the handler's failure shape carries
      // the freshest scenarios and revision, read after the loss.
      const freshestRaw = retBlob1(5, 444, [retScenario("Scenario 1", 444)]);
      const lostAgain = commitGuardedRothBlobWrite(freshestRaw, freshRaw, () => ({
        plain: JSON.stringify(retrySuccessor),
        revision: 4,
      }));
      if (lostAgain.affectedRows !== 0 || lostAgain.revision !== 5)
        failures.push("a second lost race must affect 0 rows and carry the freshest revision (5)");
      const freshestScenarios = parseDoc(freshestRaw).scenarios as unknown[];
      if (freshestScenarios.length !== 1)
        failures.push("the failure shape must carry the freshest scenarios array");
      return failures;
    },
  },
  {
    id: "ret-cas-baseline-legacy-reads-revision-0-first-write-1",
    note: "Blob 2 legacy/absent reads revision 0, and a guarded save stamps revision 1: the decision allows base 0 (and the unchecked path), and the composed successor is { kind: \"saved\", inputs } with the inputs preserved exactly and revision 1.",
    run: () => {
      const failures: string[] = [];
      if (parseRothBlobRevision(retBlob2()) !== 0)
        failures.push("legacy baseline: expected revision 0");
      if (parseRothBlobRevision(undefined) !== 0)
        failures.push("absent baseline: expected revision 0");
      const atBase0 = decideRothBlobWrite(0, 0);
      if (!atBase0.allowed || atBase0.nextRevision !== 1)
        failures.push("base 0 against a legacy baseline must store revision 1");
      const unchecked = decideRothBlobWrite(0, undefined);
      if (!unchecked.allowed || unchecked.nextRevision !== 1)
        failures.push("unchecked write against a legacy baseline must store revision 1");
      const inputs = retInputs(222);
      const composed = composeRetirementBaselineBlob("saved", inputs, 1);
      if (rothBlobRevisionOf(composed) !== 1)
        failures.push("composed baseline: expected revision 1");
      if (composed.kind !== "saved")
        failures.push("composed baseline: kind must be \"saved\"");
      if (!deepEq(composed.inputs, inputs))
        failures.push("composed baseline: inputs must be preserved exactly");
      return failures;
    },
  },
  {
    id: "ret-cas-make-my-plan-bumps-both-revisions",
    note: "One saveRetirementBaseline: the pair table returns success when both guards pass and the baseline commit lands; blob 1's revision advances 2 → 3 with its scenarios preserved from the read, and blob 2's advances 3 → 4 with content exactly { kind: \"saved\", inputs: <args> } — both revisions move together by exactly 1.",
    run: () => {
      const failures: string[] = [];
      const outcome = decideRetirementBaselinePair({
        inputsRefused: false,
        baselineRefused: false,
        baselineCommit: "committed",
        baselineRetry: "not-run",
      });
      if (outcome !== "success")
        failures.push(`pair outcome: expected success, got ${outcome}`);
      const args = retInputs(222);
      const storedScenarios = [retScenario("Scenario 1", 111)];
      const d1 = decideRothBlobWrite(2, 2);
      const d2 = decideRothBlobWrite(3, 3);
      if (!d1.allowed || d1.nextRevision !== 3)
        failures.push("blob 1 must advance 2 → 3");
      if (!d2.allowed || d2.nextRevision !== 4)
        failures.push("blob 2 must advance 3 → 4");
      if (d1.allowed && d2.allowed) {
        const blob1 = composeRetirementInputsBlob(args, storedScenarios, d1.nextRevision);
        if (!deepEq(stripRevision(blob1), { ...args, scenarios: storedScenarios }))
          failures.push("blob 1 successor: args fields exact, scenarios preserved from the read");
        const blob2 = composeRetirementBaselineBlob("saved", args, d2.nextRevision);
        if (!deepEq(stripRevision(blob2), { kind: "saved", inputs: args }))
          failures.push("blob 2 successor: content must be exactly { kind: \"saved\", inputs: <args> }");
        if (rothBlobRevisionOf(blob2) !== 4)
          failures.push("blob 2 successor: expected revision 4");
      }
      return failures;
    },
  },
  {
    id: "ret-cas-baseline-guard-retry-and-stage-conflict",
    note: "The pair contract (decideRetirementBaselinePair + the guarded-commit mirror on blob 2): an inputs refusal — or a baseline base refusal decided up front — returns the inputs-conflict shape with NEITHER blob written. A first baseline commit at 0 rows (an interleaved write advanced blob 2) retries once against the fresh raw and succeeds: the baseline lands as the commanded snapshot, stamped fresh + 1, while blob 1 — composed and committed exactly once before the baseline half began — is byte-identical across the retry. A second 0-row returns the stage: \"baseline\" shape: blob 1's commit is NOT rolled back and the carried record shows the other writer's baseline.",
    run: () => {
      const failures: string[] = [];
      const table: [Parameters<typeof decideRetirementBaselinePair>[0], string][] = [
        [{ inputsRefused: true, baselineRefused: false, baselineCommit: "not-run", baselineRetry: "not-run" }, "inputs-conflict"],
        [{ inputsRefused: false, baselineRefused: true, baselineCommit: "not-run", baselineRetry: "not-run" }, "inputs-conflict"],
        [{ inputsRefused: false, baselineRefused: false, baselineCommit: "zero", baselineRetry: "committed" }, "success"],
        [{ inputsRefused: false, baselineRefused: false, baselineCommit: "zero", baselineRetry: "zero" }, "baseline-conflict"],
      ];
      for (const [input, expected] of table) {
        const got = decideRetirementBaselinePair(input);
        if (got !== expected)
          failures.push(`pair table ${JSON.stringify(input)}: expected ${expected}, got ${got}`);
      }
      // The retry mechanics on blob 2 itself: blob 1 already
      // committed (revision 3) before the baseline half begins.
      const blob1After = retBlob1(3, 222, [retScenario("Scenario 1", 111)]);
      const commanded = retInputs(222);
      const readRaw2 = retBlob2(3, "saved", 111);
      // An interleaved baseline write lands first (revision 4).
      const advancedRaw2 = retBlob2(4, "saved", 999);
      const first = commitGuardedRothBlobWrite(
        advancedRaw2,
        readRaw2,
        retBaselineBumpCompose(commanded),
      );
      if (first.affectedRows !== 0)
        failures.push("the first baseline commit after an advance must affect 0 rows");
      // Retry against the fresh raw: the successor re-composes
      // at the FRESH revision + 1 and lands.
      const retry = commitGuardedRothBlobWrite(
        advancedRaw2,
        advancedRaw2,
        retBaselineBumpCompose(commanded),
      );
      if (retry.affectedRows !== 1) {
        failures.push(`the baseline retry: expected 1 affected row, got ${retry.affectedRows}`);
        return failures;
      }
      if (retry.revision !== 5)
        failures.push(`the baseline retry must stamp fresh + 1 (5), got ${retry.revision}`);
      const landedDoc = parseDoc(retry.raw);
      if (landedDoc.kind !== "saved" || !deepEq(landedDoc.inputs, commanded))
        failures.push("the retried baseline must be the commanded snapshot exactly");
      if (blob1After !== retBlob1(3, 222, [retScenario("Scenario 1", 111)]))
        failures.push("blob 1 must be untouched by the baseline retry (advanced exactly once)");
      // Second 0-row: stage-conflict ingredients — blob 1 stays
      // at its committed revision 3 (no rollback), and the
      // record's baseline is the other writer's (marker 999).
      const second = commitGuardedRothBlobWrite(
        retBlob2(6, "saved", 555),
        advancedRaw2,
        retBaselineBumpCompose(commanded),
      );
      if (second.affectedRows !== 0)
        failures.push("a second lost baseline race must affect 0 rows");
      if (parseRothBlobRevision(blob1After) !== 3)
        failures.push("blob 1 must NOT be rolled back on a baseline-stage conflict");
      return failures;
    },
  },
  {
    id: "ret-cas-session-capture-insert-if-absent",
    note: "The hidden capture (decideRetirementCapture): against an absent row it writes — the candidate is { kind: \"session\", inputs: <the saved record exactly> } at revision 1, a created row being a first write. Against an existing row of EITHER kind it skips and writes nothing, so the handler returns the existing record. The §1.3 race is pinned shut: a candidate composed from OLD saved inputs, evaluated once a racing \"Make this my plan\" has landed ({ kind: \"saved\", inputs: NEW }), decides skip — the explicit saved baseline can never be replaced by the stale capture. And with no saved inputs record there is nothing to capture from (the handler does not call the capture at all).",
    run: () => {
      const failures: string[] = [];
      if (decideRetirementCapture(false) !== "write")
        failures.push("capture against an absent row must write");
      if (decideRetirementCapture(true) !== "skip")
        failures.push("capture against an existing row must skip");
      const savedInputs = retInputs(111);
      const candidate = composeRetirementBaselineBlob("session", savedInputs, 1);
      if (candidate.kind !== "session")
        failures.push("capture candidate: kind must be \"session\"");
      if (!deepEq(candidate.inputs, savedInputs))
        failures.push("capture candidate: inputs must be the saved record exactly");
      if (rothBlobRevisionOf(candidate) !== 1)
        failures.push("capture candidate: a created row establishes revision 1");
      // The race: the candidate was composed from the OLD
      // record; by commit time a saved baseline exists.
      const existingSaved = retBlob2(1, "saved", 222);
      const existsAtCommit = existingSaved.length > 0;
      if (decideRetirementCapture(existsAtCommit) !== "skip")
        failures.push("a capture evaluated after a racing save must skip");
      const afterDoc = parseDoc(existingSaved);
      if (afterDoc.kind !== "saved" || !deepEq(afterDoc.inputs, retInputs(222)))
        failures.push("the existing saved baseline must survive the capture untouched");
      const existingSession = retBlob2(1, "session", 111);
      if (decideRetirementCapture(existingSession.length > 0) !== "skip")
        failures.push("capture against an existing session baseline must also skip");
      return failures;
    },
  },
  {
    id: "ret-cas-conflict-record-is-current",
    note: "The client recovery contract, for BOTH writers: a writer read blob 1 at revision 2 (marker 111) with the baseline at revision 1; an interleaved write then stored blob 1 at revision 3 (marker 222) and the baseline at revision 2 (marker 222, kind saved). The writer's save is refused, and the lite record the refusal carries — built from the CURRENT stored blobs the way loadRetirementLiteRecord reads them at refusal time — reflects the interleaved write: saved marker 222 at revision 3, baseline marker 222 at baselineRevision 2, never the stale read — so rehydrating from it shows the latest saved version and re-bases both writes.",
    run: () => {
      const failures: string[] = [];
      const staleBlob1 = retBlob1(2, 111, [retScenario("Scenario 1", 111)]);
      const currentBlob1 = retBlob1(3, 222, [retScenario("Scenario 1", 222)]);
      const currentBlob2 = retBlob2(2, "saved", 222);
      const decision = decideRothBlobWrite(
        parseRothBlobRevision(currentBlob1),
        parseRothBlobRevision(staleBlob1),
      );
      if (decision.allowed)
        failures.push("a save based on the stale read must be refused once the stored revision has advanced");
      const record = {
        saved: stripRevision(parseDoc(currentBlob1)),
        baseline: parseDoc(currentBlob2).inputs as Record<string, unknown>,
        revision: parseRothBlobRevision(currentBlob1),
        baselineRevision: parseRothBlobRevision(currentBlob2),
      };
      if (record.revision !== 3)
        failures.push(`conflict record revision: expected 3, got ${record.revision}`);
      if (record.baselineRevision !== 2)
        failures.push(`conflict record baselineRevision: expected 2, got ${record.baselineRevision}`);
      if (record.saved.spendingCents !== 222)
        failures.push("conflict record must carry the interleaved write's saved inputs (marker 222)");
      if (record.baseline.spendingCents !== 222)
        failures.push("conflict record must carry the interleaved write's baseline (marker 222)");
      return failures;
    },
  },
];

export function runRetirementCasFixtures(): {
  total: number;
  passed: number;
  results: RetirementCasFixtureResult[];
} {
  const results = retirementCasCases.map((c) => {
    let failures: string[];
    try {
      failures = c.run();
    } catch (err) {
      failures = [`threw: ${String(err)}`];
    }
    return { id: c.id, kind: "retirementcas", pass: failures.length === 0, failures };
  });
  return {
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    results,
  };
}
