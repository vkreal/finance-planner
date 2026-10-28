// Actions for the Finance Planner.
//
// Math (accrual / cash basis — one basis for every entry mode,
// contract v59):
//   incurred(month)   = sum of "spending" transactions dated that month
//                       (checking bills + card charges; refunds are negative
//                       spending rows, so they net out automatically).
//                       Reported as the Actual figure; it no longer
//                       feeds True cost.
//   cashOut(month)    = sum of ALL checking transactions that month
//                       (spending + card payments + transfers) — what
//                       really left checking
//   settledLumps(month) = the yearly-expense money that left checking
//                       that month: a smoothed bill paid from checking
//                       counts in its own month; a smoothed bill charged
//                       to a card counts in the month a card payment
//                       settles it (FIFO against outstanding card-paid
//                       yearly charges — see spendingCore.ts).
//   accrual(month)    = the sum of the per-bill monthly set-asides
//                       (the figures the bill cards show), using each
//                       bill's version in effect for that month
//                       (a yearly item annualises at its expected amount;
//                       a periodic item annualises at per-bill × payments
//                       per year — ×6 every other month, ×4 every 3
//                       months, ×2 every 6 months). Each bill's monthly
//                       set-aside uses CUMULATIVE rounding —
//                       round(annual × n/12) − round(annual × (n−1)/12)
//                       for calendar month n — so twelve monthly
//                       set-asides sum to the annual amount exactly.
//                       Smoothed bills
//                       are versioned like monthly bills: editing an
//                       amount or frequency creates a new version from
//                       a chosen month onward and never rewrites earlier
//                       months. Months BEFORE a bill's earliest version
//                       contribute ZERO, except for legacy/migrated bills
//                       flagged backfillBeforeFirstVersion (set only by
//                       the 0007 migration for pre-existing bills): those
//                       fall back to their earliest version so their
//                       historic Aug/Sep/Oct numbers are preserved.
//   smoothed(month)   = cashOut - settledLumps + accrual   (True cost)
//   reserve(month)    = opening reserve + sum over months up to this one
//                       of (accrual - settledLumps)
// Card payments and transfers are never "spending"; a card payment
// enters True cost only as the settlement of an outstanding
// card-paid yearly charge (above), never as a charge counted twice.
//
// Cash-out items: a month can instead be itemized — line items whose
// sum IS the month's cash out. Precedence, one resolution used by every
// surface (dashboard, YTD, explorer): items sum (when the month has at
// least one item) > entered lump total > transactions. A month with
// both items and an entered total uses the items sum; the entered total
// stays stored and is shown as a reference so the user can reconcile.
// Deleting all of a month's items returns it to its entered total.
//
// Monthly summary months (the user's original method): when a cash-out
// total is entered for a month, that total IS the month's cash-out /
// spending base — the month's transactions are never added on top of it.
//   smoothed(month) = entered cash out
//                     − yearly lump sums that left checking that month
//                     + accrual
//
// Monthly bills (mortgage, etc.) are a recurring breakdown of what is
// already inside the month's cash out. They are never added to spending
// or cash out — left after monthly bills = cash out − monthly bills total.

import {
defineAction,
z,
type ActionsModule,
type Ctx,
} from "@hatch/space-sdk";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { privileged } from "@space/privileged";
import * as schema from "./schema";
import {
runRetirementFixtures,
runRetirementTeethCheck,
runTrinityBenchmark,
TRINITY_PUBLISHED,
} from "./retirementFixtures";
import {
runExtendedFixtures,
runExtendedTeethCheck,
runRetirementCasFixtures,
runRothCasFixtures,
runRothUiStateFixtures,
} from "./extendedFixtures";
import {
DECEMBER_STATE_KEY,
computeDecemberProjection,
decemberState,
decideDecemberWrite,
isDecemberStateUnparseable,
parseDecemberRevision,
parseDecemberState,
runDecemberFixtures,
serializeDecemberState,
} from "./decemberCore";
import {
applyRothUiWrite,
parseRothUiState,
playgroundFormState,
ROTH_SECTION_IDS,
ROTH_RESULTS_MODES,
ROTH_UI_STATE_KEY,
rothLabDials,
rothUiStateResponse,
setRothUiStateResponse,
type SetRothUiStateResponse,
} from "./rothUiStateCore";
import {
applyUiFoldSet,
parseUiFoldState,
UI_FOLD_STATE_KEY,
} from "./uiFoldCore";
import {
appendRetirementScenario,
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
rothBlobRevisionState,
rothBlobRevisionValue,
rothFirstWritePlan,
saveRothInputsOkResponse,
withRothBlobRevision,
type RetirementScenarioTransform,
type RothBlobRevisionState,
} from "./rothRevisionCore";
import {
  casConflictReason,
  casDeepEqual,
  casFieldMismatch,
  decideCasRevision,
} from "./casCore";
import {
BACKUP_AUTHENTICITY_SEMANTICS,
RESTORE_VALIDATION_SEMANTICS,
BALANCE_SEMANTICS,
CEILING_BREACHED_SEMANTICS,
CEILINGS_REPLACEMENT_SENTENCE,
CONVERTED_ALREADY_DISTINCTION_SENTENCE,
DRAW_ORDER_KEYS,
ACA_HOUSEHOLD_SCHEDULE_SEMANTICS,
ACA_SEMANTICS,
AMT_SEMANTICS,
EDUCATION_CREDIT_SEMANTICS,
FLEX_SEMANTICS,
GUARDRAILS_SEMANTICS,
IRMAA_LOOKBACK_SEMANTICS,
IRMAA_TIER_CAP_SEMANTICS,
ITEMIZED_DEDUCTION_SEMANTICS,
LAW_YEAR_SEMANTICS,
LOSS_CARRYFORWARD_SEMANTICS,
RMD_AGE_SEMANTICS,
RMD_BENEFICIARY_SEMANTICS,
PLAYGROUND_YEAR_SEMANTICS,
PROTECT_MIN_SEMANTICS,
ROTH_COMPARE_EXAMPLE,
SAVE_FLATTENING_SENTENCE,
SCORE_IDENTITIES,
STATE_SEMANTICS,
TAX_RETURN_SEMANTICS,
TIER_SEMANTICS,
UNITS_SEMANTICS,
UNPAID_TAX_SEMANTICS,
WRITERS_READERS_RULE,
YEAR_CAPTURE_SEMANTICS,
acaHouseholdScheduleField,
bracketTopPctField,
expectedReturnPctField,
mcScoreIn,
nwPropertyKind,
nwPropertyKindWithDefault,
playgroundInputsFromArgs,
playgroundYearIn,
rothBalanceField,
rothFilingStatus,
updateMonthlyBillIn,
withResolvedOverrideBalances,
withSleeveEcho,
yearlyFrequency,
yearlyFrequencyWithDefault,
type McScoreIn,
} from "./apiContractCore";
import { planImportBatch } from "./importCore";
import { parseImportSettings } from "./importParseCore";
import { parseNwImportSettings } from "./nwImportCore";
import {
runReplayDiagnostic,
runTaxFixtures,
runTaxTeethCheck,
} from "./taxFixtures";
import {
blendedExpected,
buildSimInputs as buildRetirementSimInputs,
MONTE_CARLO_TAB_RUNS,
runHistorical as runRetirementHistorical,
runMonteCarlo as runRetirementMonteCarlo,
simulate as simulateRetirement,
solveMaxSpending as solveRetirementMaxSpending,
STOCKS_PCT_DEFAULT,
} from "./retirementEngines";
import {
DO_NOTHING_SPEC,
ROTH_MC_CHECK_PATHS,
ROTH_SCENARIO_LIMIT,
ROTH_MC_CHECK_SEED,
buildRothFunding,
claimAgeLabel,
consumeExecutionInputs,
enteredClaimInfo,
joinRothBlob,
jointSearchNote,
normalizeSsDeclarations,
optimizerHeirSensitivity,
optimizerImprovements,
optimizerSensitivity,
planInputsFromSaved,
planNetCost,
playgroundPastePayload,
pricePlanYearDetail,
pricePlaygroundYear,
resolvePlanBalances,
runJointOptimizer,
runOptimizer,
runRothCompare,
runRothMonteCarloCheck,
runRothMonteCarloStats,
splitRothBlob,
type ClaimAgeInfo,
type OptimizerCandidateSpec,
type RothExecutionCents,
type RothSavedLike,
type ScoredCandidate,
} from "./rothOptimizer";
import {
deriveSpendFromCashSleeveStartDollars,
drawOrderFromKey,
drawOrderKey,
drawOrderLabel,
resolveAcaHouseholdSchedule,
simulateRothPlan,
type AcaHouseholdStep,
type FillCeilings,
type RothStrategy,
} from "./taxEngine";
import { runWorkYearsCompare } from "./workYears";
import { CURRENT_LAW, TAX_LAW_YEARS, lawForYear } from "./taxLaw";
import {
BLANK_ROTH_GIFT,
computeGiftComparison,
giftValidationError,
parseRothGift,
type RothGiftStored,
} from "./giftModel";
import {
BLANK_ROTH_TAX_RETURN,
parseRothTaxReturn,
type RothTaxReturnStored,
} from "./taxReturnCore";
import {
SEED_RETIREMENT_AGE_FALLBACK,
seedRothRecord,
} from "./rothSeed";
import {
annualCentsForValues,
cashOutDayError,
createSpendingCore,
dueMonthsFor,
earliestYearlyVersion,
latestVersion,
latestYearlyVersion,
monthOf,
monthlyAccrualForAnnual,
monthlyBillUpdateOutcome,
monthlyBillUpdateSet,
monthsBetween,
paymentsPerYear,
shiftMonth,
sortCashOutItems,
versionInEffect,
yearSummaryFloorMonth,
yearlyVersionInEffect
} from "./spendingCore";
import {
NW_SPLIT_BUCKETS,
bucketSubtotals,
buildNwSnapshotWritePlan,
classByIdOf,
effectiveBalanceCents,
isCustodialAccount,
isFutureSnapshotDate,
isPropertyKind,
nwBalanceRowPlain,
propertyKindOf,
snapshotTotals,
splitPartsOf,
todayDateString,
validateNwBalanceSplits,
validateNwSnapshotPayload,
yearMovers,
type CoreNwBalance,
type NwPropertyKind,
type NwSplitBucket,
} from "./nwCore";
import {
BACKUP_FORMAT,
BACKUP_SCHEMA_VERSION,
RESTORE_ROTH_BLOB_KEY,
backupNwAccount,
backupPayload,
backupSetting,
isEncryptedAtRestSettingKey,
isRealCalendarDate,
normalizeBackupBalance,
payloadKeyCheckValue,
preflightRestoreBackup,
stampRestoredRothBlob,
} from "./restoreCore";
import {
  billNameField,
  billNotesField,
  category60Field,
  descriptionField,
  dueMonthField,
  fitIdField,
  longNoteField,
  nwAccountNameField,
  paidByField,
  snapshotNoteField,
  txnCategoryField,
} from "./fieldValidators";
import {
  datasetIsEmpty,
  nonEmptyDatasetTables,
  type DatasetPresence,
} from "./seedGuardCore";
import {
buildClearAllPlan,
isClearAllConfirmed,
type ClearAllTable,
} from "./clearDataCore";
import {
classifyBackupAuthenticity,
computeBackupMac,
sha256Hex,
} from "./backupMacCore";
import {
ENC_PREFIX,
RESERVED_ENC_PREFIX_MESSAGE,
hasReservedEncPrefix,
} from "./encPrefixCore";

const monthRe = /^\d{4}-(0[1-9]|1[0-2])$/;
const dateRe = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
// dateRe alone accepts impossible calendar dates (2026-02-31 passes:
// day 31 is in range for the pattern but February has no 31st). The
// stored month is all the math uses, so such a row computed fine but
// displayed a date that never existed. dateString additionally
// requires a real calendar date — isRealCalendarDate is the ONE
// implementation, defined in restoreCore.ts and imported above, so
// the writers and the backup restore enforce the same rule.
const dateString = z
  .string()
  .regex(dateRe)
  .refine(isRealCalendarDate, "not a real calendar date");


/* ============ Encryption at rest (app-level, AES-256-GCM) ============
   Every user-entered financial value stored in the DB is ciphertext
   text "enc:v1:<base64(nonce|ciphertext|tag)>" — amounts, balances,
   names, descriptions, notes, categories, paid-by/account labels.
   The 256-bit key comes from the privileged on-host key store (see
   server/src/privileged.ts): it is never in the database, never in
   client code, and never returned by any action. A key-check value
   (encryption of a known constant, stored in settings under
   "encryption_key_check_v1") is verified on every data load: a wrong
   or missing key fails loudly instead of corrupting data. Reads
   tolerate legacy plaintext (pre-encryption rows) and migrate them
   in place, exactly once — the marker prefix makes migration
   idempotent. This is app-level encryption only: the server still
   decrypts to compute and display, exactly as before. */
const KEY_CHECK_SETTING = "encryption_key_check_v1";
const KEY_CHECK_PLAINTEXT = "hatch-encryption-check-v1";
let cachedKeyBase64: string | null = null;
let cachedCryptoKey: CryptoKey | null = null;

function isEncrypted(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(ENC_PREFIX);
}
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function getCryptoKey(ctx: Ctx): Promise<CryptoKey> {
  const { keyBase64 } = await ctx.executePrivileged(
    privileged.ensureEncryptionKey,
    { spaceDir: ctx.spaceDir },
  );
  if (cachedCryptoKey && cachedKeyBase64 === keyBase64) return cachedCryptoKey;
  const raw = base64ToBytes(keyBase64);
  if (raw.length !== 32) {
    throw new Error("Encryption key is invalid (expected 256-bit).");
  }
  cachedKeyBase64 = keyBase64;
  cachedCryptoKey = await globalThis.crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  return cachedCryptoKey;
}
async function encryptStr(key: CryptoKey, plain: string): Promise<string> {
  // Reserved-prefix guard (cluster E, see ./encPrefixCore): a value
  // starting with ENC_PREFIX is stored as-is ONLY when it verifies
  // as genuine ciphertext under this key (an internal path
  // re-storing a value it just read). A user-typed value that merely
  // starts with those characters is not ciphertext — storing it
  // verbatim would poison the row and break the next data load — so
  // it is refused here, before any write, with the reserved message.
  if (hasReservedEncPrefix(plain)) {
    try {
      await decryptStr(key, plain);
      return plain;
    } catch {
      throw new Error(RESERVED_ENC_PREFIX_MESSAGE);
    }
  }
  const nonce = new Uint8Array(12);
  globalThis.crypto.getRandomValues(nonce);
  const ct = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      new TextEncoder().encode(plain),
    ),
  );
  const combined = new Uint8Array(nonce.length + ct.length);
  combined.set(nonce, 0);
  combined.set(ct, nonce.length);
  return ENC_PREFIX + bytesToBase64(combined);
}
async function decryptStr(key: CryptoKey, value: string): Promise<string> {
  if (!isEncrypted(value)) return value;
  try {
    const combined = base64ToBytes(value.slice(ENC_PREFIX.length));
    const nonce = combined.subarray(0, 12);
    const ct = combined.subarray(12);
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      ct,
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error(
      "Encrypted data cannot be decrypted — the encryption key may be missing or incorrect.",
    );
  }
}
async function decryptNum(key: CryptoKey, raw: unknown): Promise<number> {
  if (typeof raw === "number") return raw;
  const s = await decryptStr(key, String(raw ?? "0"));
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}
async function encryptNum(key: CryptoKey, cents: number): Promise<string> {
  return encryptStr(key, String(Math.trunc(cents)));
}
async function decryptNullable(
  key: CryptoKey,
  value: string | null | undefined,
): Promise<string | null> {
  if (value == null) return null;
  return decryptStr(key, value);
}
async function encryptNullable(
  key: CryptoKey,
  value: string | null | undefined,
): Promise<string | null> {
  if (value == null) return null;
  return encryptStr(key, value);
}
// Verify (or create) the key-check value. Fails loudly on a wrong key.
async function ensureKeyCheck(
  _ctx: Ctx,
  db: any,
  key: CryptoKey,
): Promise<void> {
  const rows = await db.select().from(schema.settings);
  const check = rows.find((r: any) => r.key === KEY_CHECK_SETTING);
  if (check) {
    const plain = await decryptStr(key, check.value);
    if (plain !== KEY_CHECK_PLAINTEXT) {
      throw new Error(
        "Encryption key check failed — the stored key does not match this data. Refusing to read or write encrypted data.",
      );
    }
    return;
  }
  const encrypted = await encryptStr(key, KEY_CHECK_PLAINTEXT);
  await db
    .insert(schema.settings)
    .values({ key: KEY_CHECK_SETTING, value: encrypted })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: encrypted },
    });
}

const txnKind = z.enum(["spending", "card_payment", "transfer"]);
const sourceType = z.enum(["checking", "card"]);

const txnInput = z.object({
  date: dateString,
  description: descriptionField,
  amountCents: z.number().int(),
  sourceType,
  accountName: paidByField,
  kind: txnKind,
  category: txnCategoryField,
  yearlyExpenseId: z.number().int().positive().nullable().default(null),
  // IM-5: the bank's transaction id (OFX FITID) when this row
  // comes from an OFX/QFX import; null for everything else. Only
  // importTransactions records it (the manual add/edit actions
  // accept the shared input shape but never set it, and an edit
  // never clears a recorded id — their SET lists don't name the
  // column). Stored encrypted; see schema.ts.
  fitId: fitIdField.nullable().default(null),
});

const txnOut = z.object({
  id: z.number(),
  date: z.string(),
  description: z.string(),
  amountCents: z.number(),
  sourceType: z.string(),
  accountName: z.string(),
  kind: z.string(),
  category: z.string(),
  yearlyExpenseId: z.number().nullable(),
});

const yearlyVersionOut = z.object({
  id: z.number(),
  expectedCents: z.number(),
  frequency: z.string(),
  annualCents: z.number(),
  // The cumulative-rounded monthly set-aside this version
  // contributes in its own effective-from month.
  monthlyAccrualCents: z.number(),
  effectiveFrom: z.string(),
});

const yearlyOut = z.object({
  id: z.number(),
  name: z.string(),
  // "yearly" | "bimonthly" (every other month) | "quarterly" (every
  // 3 months) | "semiannual" (every 6 months)
  // Values below are the version in effect for the selected month.
  frequency: z.string(),
  // Payments per year for this frequency: 1, 6, 4, or 2 respectively.
  paymentsPerYear: z.number(),
  // As entered: per year for yearly items, per bill for periodic items.
  expectedCents: z.number(),
  // Annualised cost: expectedCents × paymentsPerYear.
  annualCents: z.number(),
  // Expected cost due SO FAR in the selected month's calendar year:
  // expectedCents × duePaymentsToDate. The "differs" check compares
  // the year-to-date actual against this — never against the full
  // annualCents mid-year, which flagged every periodic bill whose
  // remaining payments simply were not due yet. Once every payment
  // for the year is due, this equals annualCents exactly.
  expectedToDateCents: z.number(),
  // Payments counted in expectedToDateCents: due months of this year
  // that have arrived (and are not before the bill started), raised
  // to the number of whole payments the recorded amount covers when
  // more was paid than was due (an early payment still benchmarks at
  // one payment's expected amount, not zero). The raise counts
  // covered payments from the amount, never transaction rows — one
  // due paid in two instalments covers one payment.
  duePaymentsToDate: z.number(),
  // This item's monthly set-aside for the selected month: the
  // cumulative-rounded share of annualCents — round(annual × n/12)
  // − round(annual × (n−1)/12) for calendar month n — so the year's
  // twelve set-asides sum to annualCents exactly (per-bill ÷ 2 for
  // every-other-month items, per-bill ÷ 3 for every-3-month items,
  // per-bill ÷ 6 for every-6-month items, before the rounding).
  monthlyAccrualCents: z.number(),
  // Month the selected month's version took effect; null when the item
  // has no versions (legacy fallback to the row itself) or when the
  // item is not yet in effect for the selected month.
  effectiveFrom: z.string().nullable(),
  // False when the selected month is before this (non-legacy) bill's
  // first version — it contributes $0 that month. True otherwise,
  // including legacy bills whose earliest version backfills.
  inEffectForMonth: z.boolean(),
  // True only for legacy/migrated bills whose earliest version backfills
  // months before it (set by migration, never for newly created bills).
  backfillBeforeFirstVersion: z.boolean(),
  // Newest version's values, regardless of month.
  latestExpectedCents: z.number(),
  latestFrequency: z.string(),
  history: z.array(yearlyVersionOut),
  dueMonth: z.number().nullable(),
  // All due months (1-12) in a year: one for yearly items, six for
  // every-other-month items, four for every-3-month items, two for
  // every-6-month items — in each case stepping from the anchor month
  // by the frequency's period.
  dueMonths: z.array(z.number()),
  paidByType: z.string(),
  paidByName: z.string(),
  category: z.string(),
  keepLightsOn: z.boolean(),
  actualThisYearCents: z.number(),
  actualCountThisYear: z.number(),
  lastActualDate: z.string().nullable(),
  lastActualCents: z.number().nullable(),
  status: z.string(),
});

const summaryOut = z.object({
  month: z.string(),
  cashOutCents: z.number(),
});

const oneOffOut = z.object({
  id: z.number(),
  month: z.string(),
  description: z.string(),
  amountCents: z.number(),
  note: z.string().nullable(),
});

const oneOffInput = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  description: descriptionField,
  amountCents: z.number().int().nonnegative(),
  note: longNoteField.nullable().default(null),
});

const cashOutItemOut = z.object({
  id: z.number(),
  month: z.string(),
  description: z.string(),
  amountCents: z.number(),
  note: z.string().nullable(),
  // Day of the month the cash went out (1–31, validated against
  // the month's real length by the writers). Display/order only.
  day: z.number(),
});

/* The day rule for cash-out item writers: the day must be a real
   day of the item's month (31/30/29/28 by month and leap year).
   cashOutDayError (spendingCore) is the one implementation; the
   same check rides both the add and the update input shapes. */
function refineCashOutDay(
  val: { month: string; day: number },
  ctx: z.RefinementCtx,
): void {
  const err = cashOutDayError(val.month, val.day);
  if (err) {
    ctx.addIssue({ code: "custom", path: ["day"], message: err });
  }
}

const cashOutItemFields = {
  month: z.string().regex(monthRe),
  description: descriptionField,
  amountCents: z.number().int().nonnegative(),
  note: longNoteField.nullable().default(null),
  // New items default to day 1 when no day is supplied.
  day: z.number().int().min(1).max(31).default(1),
};

const cashOutItemInput = z.object(cashOutItemFields).superRefine(refineCashOutDay);

const cashOutItemUpdateInput = z
  .object({
    ...cashOutItemFields,
    id: z.number().int().positive(),
    // Contract v65 (CAS sweep, F14): the item as the editor loaded
    // it — see updateCashOutItem. Optional: omitting it keeps the
    // legacy unchecked write (named in DATA-PLAN).
    base: z
      .object({
        month: z.string().regex(monthRe),
        description: descriptionField,
        amountCents: z.number().int().nonnegative(),
        note: longNoteField.nullable(),
        day: z.number().int().min(1).max(31),
      })
      .optional(),
  })
  .superRefine(refineCashOutDay);

const billVersionOut = z.object({
  id: z.number(),
  amountCents: z.number(),
  effectiveFrom: z.string(),
});

const monthlyBillOut = z.object({
  id: z.number(),
  name: z.string(),
  // Amount in effect for the dashboard's selected month (0 when the bill
  // had no version in effect yet that month).
  amountCents: z.number(),
  // Month the selected month's amount took effect; null when none was
  // in effect for the selected month.
  effectiveFrom: z.string().nullable(),
  // Newest version's amount, regardless of month.
  latestAmountCents: z.number(),
  paidBy: z.string(),
  notes: z.string().nullable(),
  category: z.string(),
  keepLightsOn: z.boolean(),
  history: z.array(billVersionOut),
});

const monthlyBillInput = z.object({
  name: billNameField,
  amountCents: z.number().int().nonnegative(),
  effectiveFrom: z.string().regex(monthRe),
  paidBy: paidByField,
  notes: billNotesField.nullable().default(null),
  category: category60Field.default("Uncategorized"),
  keepLightsOn: z.boolean().default(false),
});

type RawBillVersionRow = typeof schema.monthlyBillVersions.$inferSelect;
type BillVersionRow = Omit<RawBillVersionRow, "amountCents"> & { amountCents: number };

type RawYearlyVersionRow = typeof schema.yearlyExpenseVersions.$inferSelect;
type YearlyVersionRow = Omit<RawYearlyVersionRow, "expectedCents"> & { expectedCents: number };

type RawTxnRow = typeof schema.transactions.$inferSelect;
// fitId rides as plaintext here (decrypted in loadAll like the
// other text fields); the raw row's fitId is ciphertext or null.
type TxnRow = Omit<RawTxnRow, "amountCents" | "fitId"> & {
  amountCents: number;
  fitId: string | null;
};
type RawYearlyRow = typeof schema.yearlyExpenses.$inferSelect;
type YearlyRow = Omit<RawYearlyRow, "expectedCents"> & { expectedCents: number };
type RawSummaryRow = typeof schema.monthlySummaries.$inferSelect;
type SummaryRow = Omit<RawSummaryRow, "cashOutCents"> & { cashOutCents: number };
type RawMonthlyBillRow = typeof schema.monthlyBills.$inferSelect;
type MonthlyBillRow = Omit<RawMonthlyBillRow, "amountCents"> & { amountCents: number };
type RawOneOffRow = typeof schema.monthlyOneOffs.$inferSelect;
type OneOffRow = Omit<RawOneOffRow, "amountCents"> & { amountCents: number };
type RawCashOutItemRow = typeof schema.monthlyCashOutItems.$inferSelect;
type CashOutItemRow = Omit<RawCashOutItemRow, "amountCents"> & { amountCents: number };

async function loadAll(ctx: Ctx) {
  const db = ctx.db<typeof schema>();
  const key = await getCryptoKey(ctx);
  await ensureKeyCheck(ctx, db, key);
  const rawTxns = await db
    .select()
    .from(schema.transactions)
    .orderBy(asc(schema.transactions.date), asc(schema.transactions.id));
  const rawYearly = await db
    .select()
    .from(schema.yearlyExpenses)
    .orderBy(asc(schema.yearlyExpenses.id));
  const rawYearlyVersions = await db
    .select()
    .from(schema.yearlyExpenseVersions)
    .orderBy(asc(schema.yearlyExpenseVersions.id));
  const rawSummaries = await db
    .select()
    .from(schema.monthlySummaries)
    .orderBy(asc(schema.monthlySummaries.month));
  const rawBills = await db
    .select()
    .from(schema.monthlyBills)
    .orderBy(asc(schema.monthlyBills.id));
  const rawBillVersions = await db
    .select()
    .from(schema.monthlyBillVersions)
    .orderBy(asc(schema.monthlyBillVersions.id));
  const rawOneOffs = await db
    .select()
    .from(schema.monthlyOneOffs)
    .orderBy(asc(schema.monthlyOneOffs.month), asc(schema.monthlyOneOffs.id));
  const rawCashOutItems = await db
    .select()
    .from(schema.monthlyCashOutItems)
    .orderBy(
      asc(schema.monthlyCashOutItems.month),
      asc(schema.monthlyCashOutItems.day),
      asc(schema.monthlyCashOutItems.id),
    );
  const settingRows = await db.select().from(schema.settings);

  // Decrypt every row; any legacy plaintext field is encrypted and
  // written back in place (migration, idempotent via the prefix).
  // Contract v64 (A4): every migration write in this loader is
  // COMPARE-AND-WRITE — its WHERE clause also requires every field
  // it rewrites to still hold the exact raw value read above, so a
  // legitimate update that landed between the read and this write
  // wins and the migration rewrite touches zero rows instead of
  // restoring the stale plaintext-era values (audit F25).
  const txns: TxnRow[] = [];
  for (const r of rawTxns) {
    const plain: TxnRow = {
      ...r,
      description: await decryptStr(key, r.description),
      amountCents: await decryptNum(key, r.amountCents as unknown),
      accountName: await decryptStr(key, r.accountName),
      category: await decryptStr(key, r.category),
      fitId: await decryptNullable(key, r.fitId),
    };
    txns.push(plain);
    if (!isEncrypted(r.description) || !isEncrypted(r.amountCents) || !isEncrypted(r.accountName) || !isEncrypted(r.category) || (r.fitId != null && !isEncrypted(r.fitId))) {
      await db.update(schema.transactions).set({
        description: await encryptStr(key, plain.description),
        amountCents: await encryptNum(key, plain.amountCents),
        accountName: await encryptStr(key, plain.accountName),
        category: await encryptStr(key, plain.category),
        fitId: await encryptNullable(key, plain.fitId),
      }).where(and(
        eq(schema.transactions.id, r.id),
        eq(schema.transactions.description, r.description),
        eq(schema.transactions.amountCents, r.amountCents),
        eq(schema.transactions.accountName, r.accountName),
        eq(schema.transactions.category, r.category),
        r.fitId == null
          ? isNull(schema.transactions.fitId)
          : eq(schema.transactions.fitId, r.fitId),
      ));
    }
  }
  const yearly: YearlyRow[] = [];
  for (const r of rawYearly) {
    const plain: YearlyRow = {
      ...r,
      name: await decryptStr(key, r.name),
      expectedCents: await decryptNum(key, r.expectedCents as unknown),
      paidByName: await decryptStr(key, r.paidByName),
      category: await decryptStr(key, r.category),
    };
    yearly.push(plain);
    if (!isEncrypted(r.name) || !isEncrypted(r.expectedCents) || !isEncrypted(r.paidByName) || !isEncrypted(r.category)) {
      await db.update(schema.yearlyExpenses).set({
        name: await encryptStr(key, plain.name),
        expectedCents: await encryptNum(key, plain.expectedCents),
        paidByName: await encryptStr(key, plain.paidByName),
        category: await encryptStr(key, plain.category),
      }).where(and(
        eq(schema.yearlyExpenses.id, r.id),
        eq(schema.yearlyExpenses.name, r.name),
        eq(schema.yearlyExpenses.expectedCents, r.expectedCents),
        eq(schema.yearlyExpenses.paidByName, r.paidByName),
        eq(schema.yearlyExpenses.category, r.category),
      ));
    }
  }
  const yearlyVersions: YearlyVersionRow[] = [];
  for (const r of rawYearlyVersions) {
    const plain: YearlyVersionRow = { ...r, expectedCents: await decryptNum(key, r.expectedCents as unknown) };
    yearlyVersions.push(plain);
    if (!isEncrypted(r.expectedCents)) {
      await db.update(schema.yearlyExpenseVersions).set({
        expectedCents: await encryptNum(key, plain.expectedCents),
      }).where(and(
        eq(schema.yearlyExpenseVersions.id, r.id),
        eq(schema.yearlyExpenseVersions.expectedCents, r.expectedCents),
      ));
    }
  }
  const summaries: SummaryRow[] = [];
  for (const r of rawSummaries) {
    const plain: SummaryRow = { ...r, cashOutCents: await decryptNum(key, r.cashOutCents as unknown) };
    summaries.push(plain);
    if (!isEncrypted(r.cashOutCents)) {
      await db.update(schema.monthlySummaries).set({
        cashOutCents: await encryptNum(key, plain.cashOutCents),
      }).where(and(
        eq(schema.monthlySummaries.month, r.month),
        eq(schema.monthlySummaries.cashOutCents, r.cashOutCents),
      ));
    }
  }
  const bills: MonthlyBillRow[] = [];
  for (const r of rawBills) {
    const plain: MonthlyBillRow = {
      ...r,
      name: await decryptStr(key, r.name),
      amountCents: await decryptNum(key, r.amountCents as unknown),
      paidBy: await decryptStr(key, r.paidBy),
      notes: await decryptNullable(key, r.notes),
      category: await decryptStr(key, r.category),
    };
    bills.push(plain);
    if (!isEncrypted(r.name) || !isEncrypted(r.amountCents) || !isEncrypted(r.paidBy) || (r.notes != null && !isEncrypted(r.notes)) || !isEncrypted(r.category)) {
      await db.update(schema.monthlyBills).set({
        name: await encryptStr(key, plain.name),
        amountCents: await encryptNum(key, plain.amountCents),
        paidBy: await encryptStr(key, plain.paidBy),
        notes: await encryptNullable(key, plain.notes),
        category: await encryptStr(key, plain.category),
      }).where(and(
        eq(schema.monthlyBills.id, r.id),
        eq(schema.monthlyBills.name, r.name),
        eq(schema.monthlyBills.amountCents, r.amountCents),
        eq(schema.monthlyBills.paidBy, r.paidBy),
        r.notes == null
          ? isNull(schema.monthlyBills.notes)
          : eq(schema.monthlyBills.notes, r.notes),
        eq(schema.monthlyBills.category, r.category),
      ));
    }
  }
  const billVersions: BillVersionRow[] = [];
  for (const r of rawBillVersions) {
    const plain: BillVersionRow = { ...r, amountCents: await decryptNum(key, r.amountCents as unknown) };
    billVersions.push(plain);
    if (!isEncrypted(r.amountCents)) {
      await db.update(schema.monthlyBillVersions).set({
        amountCents: await encryptNum(key, plain.amountCents),
      }).where(and(
        eq(schema.monthlyBillVersions.id, r.id),
        eq(schema.monthlyBillVersions.amountCents, r.amountCents),
      ));
    }
  }
  const oneOffs: OneOffRow[] = [];
  for (const r of rawOneOffs) {
    const plain: OneOffRow = {
      ...r,
      description: await decryptStr(key, r.description),
      amountCents: await decryptNum(key, r.amountCents as unknown),
      note: await decryptNullable(key, r.note),
    };
    oneOffs.push(plain);
    if (!isEncrypted(r.description) || !isEncrypted(r.amountCents) || (r.note != null && !isEncrypted(r.note))) {
      await db.update(schema.monthlyOneOffs).set({
        description: await encryptStr(key, plain.description),
        amountCents: await encryptNum(key, plain.amountCents),
        note: await encryptNullable(key, plain.note),
      }).where(and(
        eq(schema.monthlyOneOffs.id, r.id),
        eq(schema.monthlyOneOffs.description, r.description),
        eq(schema.monthlyOneOffs.amountCents, r.amountCents),
        r.note == null
          ? isNull(schema.monthlyOneOffs.note)
          : eq(schema.monthlyOneOffs.note, r.note),
      ));
    }
  }
  const cashOutItems: CashOutItemRow[] = [];
  for (const r of rawCashOutItems) {
    const plain: CashOutItemRow = {
      ...r,
      description: await decryptStr(key, r.description),
      amountCents: await decryptNum(key, r.amountCents as unknown),
      note: await decryptNullable(key, r.note),
    };
    cashOutItems.push(plain);
    if (!isEncrypted(r.description) || !isEncrypted(r.amountCents) || (r.note != null && !isEncrypted(r.note))) {
      await db.update(schema.monthlyCashOutItems).set({
        description: await encryptStr(key, plain.description),
        amountCents: await encryptNum(key, plain.amountCents),
        note: await encryptNullable(key, plain.note),
      }).where(and(
        eq(schema.monthlyCashOutItems.id, r.id),
        eq(schema.monthlyCashOutItems.description, r.description),
        eq(schema.monthlyCashOutItems.amountCents, r.amountCents),
        r.note == null
          ? isNull(schema.monthlyCashOutItems.note)
          : eq(schema.monthlyCashOutItems.note, r.note),
      ));
    }
  }
  // Settings: only the opening reserve is financial content — decrypt
  // it for consumers and migrate a legacy plaintext value in place.
  // UI flags and the key-check value itself stay as stored.
  const settingsMap = new Map<string, string>();
  for (const r of settingRows) {
    if (r.key === "opening_reserve_cents") {
      const plainVal = isEncrypted(r.value) ? await decryptStr(key, r.value) : r.value;
      settingsMap.set(r.key, plainVal);
      if (!isEncrypted(r.value) && r.value !== "") {
        const enc = await encryptStr(key, plainVal);
        // Compare-and-write (contract v64, A4): only while the
        // stored value is still the one read here.
        await db.update(schema.settings).set({ value: enc }).where(and(
          eq(schema.settings.key, r.key),
          eq(schema.settings.value, r.value),
        ));
      }
    } else {
      settingsMap.set(r.key, r.value);
    }
  }
  // The decrypted rows ride in the SQL order above; re-sort through
  // the shared comparator (spendingCore) so the within-month day
  // order has exactly one implementation.
  return { db, key, txns, yearly, yearlyVersions, summaries, bills, billVersions, oneOffs, cashOutItems: sortCashOutItems(cashOutItems), settingsMap };
}

function yearlyOutFor(
  y: YearlyRow,
  txns: TxnRow[],
  selectedMonth: string,
  versions: YearlyVersionRow[] = [],
): z.infer<typeof yearlyOut> {
  const year = selectedMonth.slice(0, 4);
  const linked = txns.filter(
    (t) => t.yearlyExpenseId === y.id && t.kind === "spending",
  );
  const backfill = y.backfillBeforeFirstVersion === 1;
  // The month this (non-legacy) bill started: its earliest version's
  // effective-from. Legacy/backfill bills and bills with no versions
  // have no start boundary — every month counts, as before. The
  // due-month side below already ignores dues before this month; the
  // payment side uses the same boundary (see thisYear).
  const startMonth =
    !backfill && versions.length > 0
      ? (earliestYearlyVersion(versions)?.effectiveFrom ?? null)
      : null;
  // "This year" means year-to-date THROUGH the viewed month: a payment
  // recorded in a later month must not leak into an earlier month's
  // view. It did — a bill due in August with its payment recorded in
  // November showed "Paid this year … in line with expected" (and a
  // last-paid date in November) when October was viewed, and could
  // never read as overdue for August–October. The expected-to-date
  // benchmark below is already scoped to dues that have arrived by
  // the viewed month; the actual side now uses the same window, and
  // "last payment" likewise never names a date after the viewed month.
  // Payments recorded BEFORE the bill itself started are excluded for
  // the same reason pre-start dues are: a payment made before the
  // bill's first version cannot cover a due that came after it — it
  // did, so a semiannual bill that started in June read "ok" in
  // August on the strength of a March payment, with its July due
  // never paid and no overdue warning.
  const thisYear = linked.filter(
    (t) =>
      t.date.startsWith(year) &&
      monthOf(t.date) <= selectedMonth &&
      (startMonth == null || monthOf(t.date) >= startMonth),
  );
  const actualThisYearCents = thisYear.reduce((s, t) => s + t.amountCents, 0);
  const last = thisYear.length > 0 ? thisYear[thisYear.length - 1] : undefined;
  const inEffectRaw = yearlyVersionInEffect(versions, selectedMonth, backfill);
  const notStarted = inEffectRaw === null;
  const inEffect = notStarted ? undefined : (inEffectRaw ?? undefined);
  const latest = latestYearlyVersion(versions);
  const effExpected = notStarted ? 0 : (inEffect?.expectedCents ?? y.expectedCents);
  const effFrequency = notStarted
    ? (latest?.frequency ?? y.frequency)
    : (inEffect?.frequency ?? y.frequency);
  const annualCents = notStarted
    ? 0
    : annualCentsForValues(effExpected, effFrequency);
  // Due months follow the frequency in effect for the selected month.
  const dueMonths = dueMonthsFor({ ...y, frequency: effFrequency as YearlyRow["frequency"] });
  // Due months BEFORE the bill itself started do not count: a bill
  // added in October whose pattern includes January was not owed
  // anything in January — it can be neither overdue for January nor
  // expected to have been paid for it. Legacy/backfill bills predate
  // their first version, so for them every due month counts, exactly
  // as before; bills with no versions at all use the row fallback
  // and likewise count all.
  const selMonthNum = Number(selectedMonth.slice(5, 7));
  const relevantDues = dueMonths.filter(
    (d) =>
      startMonth == null ||
      `${year}-${String(d).padStart(2, "0")}` >= startMonth,
  );
  // Expected-to-date benchmark for the "differs" check: the payments
  // whose due months have arrived this year. Comparing the
  // year-to-date actual against the FULL annualised cost instead
  // flagged every periodic bill mid-year — a semiannual bill paid
  // exactly on schedule in February "differed" from its annual total
  // until the August payment landed. Recorded money beyond the due
  // count (paid early) raises the benchmark to the number of whole
  // payments the recorded AMOUNT covers, capped at a full year's
  // payments, so an on-amount early payment never flags either. The
  // count is derived from the amount, never from the number of
  // transaction rows: one due paid in two instalments (two rows
  // summing to exactly the expected amount) covers ONE payment —
  // counting rows instead benchmarked it at two payments and flagged
  // an exact payment as "differs". When all of the year's payments
  // are due, the benchmark IS the annualised cost, as before.
  const duesArrived = relevantDues.filter((d) => d <= selMonthNum).length;
  const paidPayments =
    effExpected > 0 && actualThisYearCents > 0
      ? Math.ceil(actualThisYearCents / effExpected)
      : 0;
  const duePaymentsToDate = Math.max(
    duesArrived,
    Math.min(paidPayments, paymentsPerYear(effFrequency)),
  );
  const expectedToDateCents = effExpected * duePaymentsToDate;
  let status = "ok";
  if (notStarted) {
    status = "not-started";
  } else {
    if (actualThisYearCents !== 0 && expectedToDateCents > 0) {
      const diff = actualThisYearCents - expectedToDateCents;
      const threshold = Math.max(Math.round(expectedToDateCents * 0.1), 2500);
      if (Math.abs(diff) >= threshold) status = "differs";
    }
    if (status === "ok" && y.dueMonth != null) {
      // Overdue once a due month has passed with no payment covering
      // THAT due. Coverage is counted from the recorded amount (the
      // same paidPayments figure as the benchmark above): the
      // recorded money covers the earliest dues first, and the first
      // due it does not reach decides. The previous check required
      // NOTHING paid all year, so a periodic bill that paid its
      // first due and missed a later one read "ok" whenever the
      // missed amount fell inside the "differs" tolerance — a $20
      // semiannual bill that paid January and missed July showed no
      // warning at all in August. A payment recorded against a $0
      // bill covers every due (there is nothing to owe).
      const coveredPayments =
        actualThisYearCents === 0
          ? 0
          : effExpected > 0
            ? Math.min(paidPayments, relevantDues.length)
            : relevantDues.length;
      const firstUncoveredDue = relevantDues[coveredPayments] ?? null;
      if (firstUncoveredDue != null && firstUncoveredDue < selMonthNum) {
        status = "overdue";
      } else if (actualThisYearCents === 0) {
        status = "upcoming";
      }
    }
    if (status === "ok" && y.dueMonth == null) status = "no-due-month";
  }
  return {
    id: y.id,
    name: y.name,
    frequency: effFrequency,
    paymentsPerYear: paymentsPerYear(effFrequency),
    expectedCents: effExpected,
    annualCents,
    expectedToDateCents,
    duePaymentsToDate,
    monthlyAccrualCents: monthlyAccrualForAnnual(annualCents, selectedMonth),
    effectiveFrom: notStarted ? null : (inEffect?.effectiveFrom ?? null),
    inEffectForMonth: !notStarted,
    backfillBeforeFirstVersion: backfill,
    latestExpectedCents: latest?.expectedCents ?? y.expectedCents,
    latestFrequency: latest?.frequency ?? y.frequency,
    history: [...versions]
      .sort((a, c) =>
        a.effectiveFrom === c.effectiveFrom
          ? c.id - a.id
          : a.effectiveFrom < c.effectiveFrom
            ? 1
            : -1,
      )
      .map((v) => ({
        id: v.id,
        expectedCents: v.expectedCents,
        frequency: v.frequency,
        annualCents: annualCentsForValues(v.expectedCents, v.frequency),
        // The set-aside this version contributes in its OWN first
        // month (cumulative rounding — see monthlyAccrualForAnnual):
        // the history list shows one figure per version, so it is
        // priced at the version's effective-from month.
        monthlyAccrualCents: monthlyAccrualForAnnual(
          annualCentsForValues(v.expectedCents, v.frequency),
          v.effectiveFrom,
        ),
        effectiveFrom: v.effectiveFrom,
      })),
    dueMonth: y.dueMonth ?? null,
    dueMonths,
    paidByType: y.paidByType,
    paidByName: y.paidByName,
    category: y.category,
    keepLightsOn: y.keepLightsOn === 1,
    actualThisYearCents,
    actualCountThisYear: thisYear.length,
    lastActualDate: last ? last.date : null,
    lastActualCents: last ? last.amountCents : null,
    status,
  };
}


type RawNwBalanceRow = typeof schema.nwBalances.$inferSelect;
type NwBalanceRow = Omit<
  RawNwBalanceRow,
  "balanceCents" | "splitHsaCents" | "splitRothCents" | "splitTaxableCents" | "splitNonTaxableCents" | "split529Cents" | "splitCashCents" | "splitPreTaxCents"
> & {
  balanceCents: number;
  splitHsaCents: number | null;
  splitRothCents: number | null;
  splitTaxableCents: number | null;
  splitNonTaxableCents: number | null;
  split529Cents: number | null;
  splitCashCents: number | null;
  splitPreTaxCents: number | null;
};

// Tax buckets and property kinds live in server/src/nwCore.ts
// (NW_SPLIT_BUCKETS / NW_PROPERTY_KINDS and the balance math are
// imported from there — the single implementation the Net Worth and
// Year Summary views and the accuracy fixtures all run).
const nwSplitBucketEnum = z.enum(NW_SPLIT_BUCKETS);
// The property-kind enum's ONE definition lives in
// apiContractCore (API follow-on 3, finding F17) so the fixtures
// pin the exact schema the actions publish.
const nwPropertyKindEnum = nwPropertyKind;
const NW_INCLUDE_PROPERTY_KEY = "nw_include_property";
const NW_TARGET_KEY = "nw_target_cents";

// Decrypt Net Worth rows; legacy plaintext migrates in place (once).
async function loadNetWorthDecrypted(ctx: Ctx, db: any, key: CryptoKey) {
  await ensureKeyCheck(ctx, db, key);
  const rawAccounts = await db
    .select()
    .from(schema.nwAccounts)
    .orderBy(asc(schema.nwAccounts.sortOrder), asc(schema.nwAccounts.id));
  const rawSnaps = await db
    .select()
    .from(schema.nwSnapshots)
    .orderBy(asc(schema.nwSnapshots.date));
  const rawBalances = await db.select().from(schema.nwBalances);
  const accounts = [];
  for (const a of rawAccounts) {
    const name = await decryptStr(key, a.name);
    accounts.push({ ...a, name, propertyKind: propertyKindOf(a as { propertyKind?: string | null }), custodial: isCustodialAccount(a as { custodial?: number | null }) });
    if (!isEncrypted(a.name)) {
      await db
        .update(schema.nwAccounts)
        .set({ name: await encryptStr(key, name) })
        .where(eq(schema.nwAccounts.id, a.id));
    }
  }
  const snapshots = [];
  for (const s of rawSnaps) {
    const note = await decryptNullable(key, s.note);
    snapshots.push({ ...s, note });
    if (s.note != null && !isEncrypted(s.note)) {
      await db.update(schema.nwSnapshots).set({ note: await encryptNullable(key, note) }).where(eq(schema.nwSnapshots.id, s.id));
    }
  }
  const balances: NwBalanceRow[] = [];
  for (const b of rawBalances) {
    const balanceCents = await decryptNum(key, b.balanceCents as unknown);
    const rawSplitHsa = (b as { splitHsaCents?: string | null }).splitHsaCents ?? null;
    const rawSplitRoth = (b as { splitRothCents?: string | null }).splitRothCents ?? null;
    const rawSplitTaxable = (b as { splitTaxableCents?: string | null }).splitTaxableCents ?? null;
    const rawSplitNonTaxable = (b as { splitNonTaxableCents?: string | null }).splitNonTaxableCents ?? null;
    const rawSplit529 = (b as { split529Cents?: string | null }).split529Cents ?? null;
    const rawSplitCash = (b as { splitCashCents?: string | null }).splitCashCents ?? null;
    const rawSplitPreTax = (b as { splitPreTaxCents?: string | null }).splitPreTaxCents ?? null;
    const splitHsaCents = rawSplitHsa == null ? null : await decryptNum(key, rawSplitHsa as unknown);
    const splitRothCents = rawSplitRoth == null ? null : await decryptNum(key, rawSplitRoth as unknown);
    const splitTaxableCents = rawSplitTaxable == null ? null : await decryptNum(key, rawSplitTaxable as unknown);
    const splitNonTaxableCents = rawSplitNonTaxable == null ? null : await decryptNum(key, rawSplitNonTaxable as unknown);
    const split529Cents = rawSplit529 == null ? null : await decryptNum(key, rawSplit529 as unknown);
    const splitCashCents = rawSplitCash == null ? null : await decryptNum(key, rawSplitCash as unknown);
    const splitPreTaxCents = rawSplitPreTax == null ? null : await decryptNum(key, rawSplitPreTax as unknown);
    balances.push({ ...b, balanceCents, splitHsaCents, splitRothCents, splitTaxableCents, splitNonTaxableCents, split529Cents, splitCashCents, splitPreTaxCents });
    if (
      !isEncrypted(b.balanceCents) ||
      (rawSplitHsa != null && !isEncrypted(rawSplitHsa)) ||
      (rawSplitRoth != null && !isEncrypted(rawSplitRoth)) ||
      (rawSplitTaxable != null && !isEncrypted(rawSplitTaxable)) ||
      (rawSplitNonTaxable != null && !isEncrypted(rawSplitNonTaxable)) ||
      (rawSplit529 != null && !isEncrypted(rawSplit529)) ||
      (rawSplitCash != null && !isEncrypted(rawSplitCash)) ||
      (rawSplitPreTax != null && !isEncrypted(rawSplitPreTax))
    ) {
      await db.update(schema.nwBalances).set({
        balanceCents: await encryptNum(key, balanceCents),
        splitHsaCents: splitHsaCents == null ? null : await encryptNum(key, splitHsaCents),
        splitRothCents: splitRothCents == null ? null : await encryptNum(key, splitRothCents),
        splitTaxableCents: splitTaxableCents == null ? null : await encryptNum(key, splitTaxableCents),
        splitNonTaxableCents: splitNonTaxableCents == null ? null : await encryptNum(key, splitNonTaxableCents),
        split529Cents: split529Cents == null ? null : await encryptNum(key, split529Cents),
        splitCashCents: splitCashCents == null ? null : await encryptNum(key, splitCashCents),
        splitPreTaxCents: splitPreTaxCents == null ? null : await encryptNum(key, splitPreTaxCents),
      }).where(eq(schema.nwBalances.id, b.id));
    }
  }
  return { accounts, snapshots, balances };
}

/* ---------------- Net Worth seed ----------------
   SAMPLE DATA — invented for demonstration on a fresh install.
   A complete sample household: twelve monthly snapshots ending
   in the current month, so a fresh install shows a full year of
   history, a growth chart with a real dip and recovery, tax-
   bucket splits, a house and mortgage behind the property
   toggle, and a custodial account that is recorded but never
   counted. These figures are synthetic; they are not any
   household's real balances.
   Values are USD dollars per account in NW_SEED_ACCOUNTS order;
   they are stored as integer cents. Snapshot totals (property
   and custodial excluded, as the view defaults) run from
   $2,610,000 to $3,062,500 — the packaged harness and probe pin
   those two totals. Seeding is idempotent: seedNetWorth does
   nothing when any NW account already exists. */
type NwSeedAccount = {
  name: string;
  propertyKind: "none" | "asset" | "liability";
  custodial: boolean;
  // Tax-bucket split for this account's balances, as shares of
  // the balance (the parts always sum to the balance: every part
  // but the last is the share rounded to the nearest $10, and the
  // last part takes the remainder). Empty = no split: the whole
  // balance counts as Unbucketed. Property and custodial accounts
  // never carry a split.
  splitShares: { bucket: NwSplitBucket; share: number }[];
};
const NW_SEED_ACCOUNTS: NwSeedAccount[] = [
  { name: "Joint Brokerage", propertyKind: "none", custodial: false, splitShares: [{ bucket: "Taxable", share: 0.92 }, { bucket: "Cash", share: 0.08 }] },
  { name: "Cash & Savings", propertyKind: "none", custodial: false, splitShares: [{ bucket: "Cash", share: 1 }] },
  { name: "401(k)", propertyKind: "none", custodial: false, splitShares: [{ bucket: "Pre-tax", share: 1 }] },
  { name: "Roth IRA", propertyKind: "none", custodial: false, splitShares: [{ bucket: "Roth", share: 1 }] },
  { name: "Traditional IRA", propertyKind: "none", custodial: false, splitShares: [{ bucket: "Pre-tax", share: 1 }] },
  { name: "HSA", propertyKind: "none", custodial: false, splitShares: [{ bucket: "HSA", share: 1 }] },
  { name: "College 529", propertyKind: "none", custodial: false, splitShares: [{ bucket: "529", share: 1 }] },
  { name: "House", propertyKind: "asset", custodial: false, splitShares: [] },
  { name: "Mortgage", propertyKind: "liability", custodial: false, splitShares: [] },
  { name: "UTMA — Child", propertyKind: "none", custodial: true, splitShares: [] },
];
// One row per snapshot month, oldest first: the twelve months
// ending in the current month, snapshotted on the 1st. The
// invested accounts follow one market year together — steady
// gains, a sharp dip in month 6, then recovery — on top of
// regular contributions; the house appreciates slowly, the
// mortgage pays down $1,250 a month, and cash moves with the
// household's saving and spending.
const NW_SEED_VALUES: number[][] = [
  [612000, 118000, 1148000, 286000, 342000, 38500, 65500, 685000, 402000, 12400],
  [625300, 119400, 1171650, 291600, 347200, 39450, 67400, 687500, 400750, 12550],
  [635650, 121100, 1190100, 295800, 350850, 40250, 69050, 689000, 399500, 12400],
  [631550, 120200, 1182750, 293250, 346850, 40700, 69850, 692000, 398250, 12800],
  [652750, 122600, 1220400, 302450, 356050, 41850, 72250, 694500, 397000, 12150],
  [621000, 121900, 1164000, 287100, 337800, 41500, 71150, 696000, 395750, 12900],
  [653050, 123800, 1221050, 301300, 352550, 43000, 74350, 699000, 394500, 13150],
  [670900, 125100, 1252750, 308950, 359900, 44100, 76600, 701500, 393250, 13300],
  [683150, 124300, 1274450, 313950, 364350, 45000, 78450, 704000, 392000, 13700],
  [704400, 126200, 1312100, 323150, 373350, 46150, 80950, 707500, 390750, 13600],
  [701550, 127600, 1307100, 321200, 370150, 46650, 81750, 711000, 389500, 13950],
  [726800, 132000, 1353800, 332500, 385400, 47500, 84500, 715000, 388250, 14250],
];
const NW_SEED_NOTES: (string | null)[] = [
  "First full snapshot — starting point",
  null, null, null, null,
  "Market dip this month — no changes made",
  null, null, null, null, null, null,
];
// The sample household's net worth target ($3,500,000), stored
// exactly as setNwTarget stores it (plain integer-cents string).
const NW_SEED_TARGET_CENTS = 350000000;

const nwBalanceEntry = z.object({
  accountId: z.number().int().positive(),
  // null = not recorded for that account on that date (no row stored).
  // When `splits` is a non-empty array, the split amounts ARE the
  // balance: the server stores their sum as the balance total and
  // ignores balanceCents. Null/empty splits = a single whole balance.
  balanceCents: z.number().int().nullable(),
  splits: z
    .array(
      z.object({
        bucket: nwSplitBucketEnum,
        amountCents: z.number().int(),
      }),
    )
    // One part per bucket in NW_SPLIT_BUCKETS (currently six: HSA,
    // Roth, Taxable, Non-Taxable, 529, Cash) — the editor can submit
    // all six, so the cap must cover every bucket.
    .max(NW_SPLIT_BUCKETS.length)
    .nullable()
    .optional()
    .default(null),
});

// Resolve one balance entry into the row values to store, or null when
// the account was not recorded. The numeric resolution (split entries:
// the stored total is the sum of the parts and each part goes in its
// bucket column; whole entries: the balance as entered) is
// nwBalanceRowPlain in nwCore.ts — this wrapper only encrypts its
// fields. Property accounts never carry a tax-bucket split — their
// balances are stored whole (noSplit forces the whole-balance path).
// Custodial accounts never carry a split either, for the same reason.
// CALLER CONTRACT (cluster C): every caller validates the payload
// first (validateNwSnapshotPayload / validateNwBalanceSplits in
// nwCore.ts), so a bucket can never appear twice in one entry's
// splits here — duplicates are refused before any write, never
// folded or silently dropped.
async function nwBalanceRowValues(
  key: CryptoKey,
  entry: z.infer<typeof nwBalanceEntry>,
  noSplit: boolean = false,
): Promise<{
  balanceCents: string;
  splitHsaCents: string | null;
  splitRothCents: string | null;
  splitTaxableCents: string | null;
  splitNonTaxableCents: string | null;
  split529Cents: string | null;
  splitCashCents: string | null;
  splitPreTaxCents: string | null;
} | null> {
  const plain = nwBalanceRowPlain(entry, noSplit);
  if (!plain) return null;
  const enc = async (v: number | null): Promise<string | null> =>
    v == null ? null : encryptNum(key, v);
  return {
    balanceCents: await encryptNum(key, plain.balanceCents),
    splitHsaCents: await enc(plain.splitHsaCents),
    splitRothCents: await enc(plain.splitRothCents),
    splitTaxableCents: await enc(plain.splitTaxableCents),
    splitNonTaxableCents: await enc(plain.splitNonTaxableCents),
    split529Cents: await enc(plain.split529Cents),
    splitCashCents: await enc(plain.splitCashCents),
    splitPreTaxCents: await enc(plain.splitPreTaxCents),
  };
}

type NwEncryptedRowValues = NonNullable<
  Awaited<ReturnType<typeof nwBalanceRowValues>>
>;

const nwSnapshotInput = z.object({
  date: dateString,
  note: snapshotNoteField.nullable().default(null),
  balances: z.array(nwBalanceEntry).max(200),
});

const nwMutationOut = z.object({
  ok: z.boolean(),
  reason: z.string(),
  id: z.number().nullable(),
  // Contract v65 (CAS sweep): present (true) when the write was
  // refused because the caller's loaded base no longer matches the
  // stored record — a newer copy was saved elsewhere. `revision`
  // carries the snapshot's stored revision after the attempt on
  // the snapshot/balance writers, so the caller can re-base.
  conflict: z.boolean().optional(),
  revision: z.number().int().nonnegative().optional(),
});

/* The spending family's mutation result (API follow-on 3,
   finding F22): an update/delete/setter that targets one row by
   id (or one month) reports an honest { ok: false, reason } when
   the target does not exist, instead of the old bare
   { ok: true } success for a write that touched nothing. The
   same shape deleteMonthlyBillVersion / deleteYearlyExpenseVersion
   already published. */
const okReasonResponse = z.object({
  ok: z.boolean(),
  reason: z.string(),
  // Contract v65 (CAS sweep): present (true) when the write was
  // refused because the caller's loaded base no longer matches the
  // stored record — a newer copy was saved elsewhere and the stored
  // newer value is intact.
  conflict: z.boolean().optional(),
});
type OkReason = z.infer<typeof okReasonResponse>;

/* The settings/summary writers' result (contract v65): success is
   { ok: true }; a CAS refusal is { ok: false, conflict: true,
   reason } with the December-style newer-copy message. */
const casOkResponse = z.object({
  ok: z.boolean(),
  conflict: z.boolean().optional(),
  reason: z.string().optional(),
});
type CasOk = z.infer<typeof casOkResponse>;

/* ---------------- Backup / restore ----------------
   exportbackup returns the COMPLETE dataset as one payload: every
   spending table and every Net Worth table, with every encrypted
   value decrypted to its true figure exactly as the other actions
   return it (amounts as integer cents, text as plaintext).
   restorebackup accepts that exact payload and replaces the entire
   dataset with it, preserving ids and relationships, re-encrypting
   every value on write. The settings array carries every settings
   row; the opening reserve and the internal encryption key-check
   constant are exported decrypted like every other figure (the
   key-check is re-encrypted and re-validated on restore).
   Authenticity (S1): the payload also carries an authenticityMac —
   a keyed HMAC-SHA-256 over the payload's canonical form
   (server/src/backupMacCore.ts), computed here at export and
   verified in restorebackup's preflight. A carried MAC that does
   not verify refuses the restore; a payload with no MAC (written
   before MAC signing) restores labelled UNAUTHENTICATED. */

function backupTsToMs(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}
function backupMsToDate(ms: number): Date {
  return typeof ms === "number" && ms > 0 ? new Date(ms) : new Date();
}

/* The payload schemas live in server/src/restoreCore.ts (shared
   with the accuracy fixtures): backupPayload and its row
   schemas, BACKUP_FORMAT, and BACKUP_SCHEMA_VERSION are
   imported from there. */

const restoreBackupOut = z.object({
  ok: z.boolean(),
  reason: z.string(),
  // The restored backup's authenticity verdict (S1): true ONLY
  // when the payload carried an authenticity MAC that verified
  // over its contents. A pre-MAC backup (no MAC) restores with
  // authenticated: false and the reason labels it
  // UNAUTHENTICATED; a MAC that fails verification never reaches
  // a restore at all (ok: false from preflight).
  authenticated: z.boolean(),
});

/* Builds the complete backup payload (every spending and Net Worth
   table, decrypted to true figures). Shared by exportbackup and by
   createBackupNow, so a manual backup created from the Backups panel
   carries exactly the payload the weekly agent-run backups carry. */
async function buildBackupPayload(
  ctx: Ctx,
): Promise<z.infer<typeof backupPayload>> {
  const {
    db,
    key,
    txns,
    yearly,
    yearlyVersions,
    summaries,
    bills,
    billVersions,
    oneOffs,
    cashOutItems,
    settingsMap,
  } = await loadAll(ctx);
  const { accounts, snapshots, balances } = await loadNetWorthDecrypted(
    ctx,
    db,
    key,
  );
  const rawSettings = await db.select().from(schema.settings);
  // The legacy nw_accounts.bucket column holds encrypted values
  // for older rows (plaintext for newer ones) — decrypt either
  // way so the payload carries only true figures.
  const nwAccountsExport: z.infer<typeof backupNwAccount>[] = [];
  for (const a of accounts) {
    nwAccountsExport.push({
      id: a.id,
      name: a.name,
      bucket: await decryptStr(
        key,
        (a as { bucket?: string }).bucket ?? "Unbucketed",
      ),
      propertyKind: propertyKindOf(a),
      custodial: isCustodialAccount(a) ? 1 : 0,
      sortOrder: a.sortOrder,
      archived: a.archived,
      createdAt: backupTsToMs(a.createdAt),
    });
  }
  const settingsExport: z.infer<typeof backupSetting>[] = [];
  for (const r of rawSettings) {
    settingsExport.push({
      key: r.key,
      // The opening reserve is a financial figure, the key-check
      // row is an encrypted constant, and the saved retirement
      // inputs are an encrypted JSON blob: export all three
      // decrypted like every other figure, so the payload can be
      // restored under a different encryption key with nothing
      // silently lost (the retirement blob previously travelled
      // as ciphertext and a cross-key restore dropped the saved
      // inputs while every other figure survived). The CSV
      // import setup blobs (IMPORT_SETTINGS_KEY and
      // NW_IMPORT_SETTINGS_KEY) get the same treatment for the
      // same reason, as do the encrypted sticky entry defaults
      // (ENTRY_DEFAULT_MONTHLY_PAID_FROM_KEY and
      // ENTRY_DEFAULT_YEARLY_PAID_NAME_KEY — added at contract
      // v60 when the packaged cross-install restore caught them
      // travelling as source-install ciphertext). All remaining settings
      // (UI flags, the include-property toggle, the reserve
      // start month) are stored plaintext already and are
      // carried exactly as stored. A legacy plaintext import
      // setup value decrypts to itself via the lenient reader.
      value:
        r.key === "opening_reserve_cents"
          ? (settingsMap.get(r.key) ?? r.value)
          : r.key === KEY_CHECK_SETTING ||
              r.key === "retirement_calc_inputs_v1" ||
              r.key === "retirement_calc_baseline_v1" ||
              r.key === "roth_conversion_inputs_v1"
            ? await decryptStr(key, r.value)
            : r.key === IMPORT_SETTINGS_KEY ||
                r.key === NW_IMPORT_SETTINGS_KEY ||
                // The encrypted sticky entry defaults (contract
                // v60): their label values are stored encrypted,
                // so they export decrypted like every other
                // encrypted figure — before v60 they travelled
                // as the source install's ciphertext and broke
                // every load after a cross-key restore. (The
                // lenient reader: a legacy plaintext value
                // exports as itself.)
                r.key === ENTRY_DEFAULT_MONTHLY_PAID_FROM_KEY ||
                r.key === ENTRY_DEFAULT_YEARLY_PAID_NAME_KEY
              ? ((await decryptSettingValue(key, r.value)) ?? r.value)
              : r.value,
    });
  }
  const payload: z.infer<typeof backupPayload> = {
    format: BACKUP_FORMAT,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    // Filled in below, once the payload's contents are final:
    // the MAC is computed over the payload with this field
    // excluded, then attached (backupMacCore).
    authenticityMac: null,
    yearlyExpenses: yearly.map((y) => ({
      id: y.id,
      name: y.name,
      frequency: y.frequency,
      expectedCents: y.expectedCents,
      dueMonth: y.dueMonth ?? null,
      paidByType: y.paidByType,
      paidByName: y.paidByName,
      backfillBeforeFirstVersion: y.backfillBeforeFirstVersion,
      category: y.category,
      keepLightsOn: y.keepLightsOn,
      createdAt: backupTsToMs(y.createdAt),
    })),
    yearlyExpenseVersions: yearlyVersions.map((v) => ({
      id: v.id,
      expenseId: v.expenseId,
      expectedCents: v.expectedCents,
      frequency: v.frequency,
      effectiveFrom: v.effectiveFrom,
      createdAt: backupTsToMs(v.createdAt),
    })),
    transactions: txns.map((t) => ({
      id: t.id,
      date: t.date,
      description: t.description,
      amountCents: t.amountCents,
      sourceType: t.sourceType,
      accountName: t.accountName,
      kind: t.kind,
      category: t.category,
      yearlyExpenseId: t.yearlyExpenseId ?? null,
      fitId: t.fitId ?? null,
      createdAt: backupTsToMs(t.createdAt),
    })),
    monthlySummaries: summaries.map((s) => ({
      month: s.month,
      cashOutCents: s.cashOutCents,
      createdAt: backupTsToMs(s.createdAt),
      updatedAt: backupTsToMs(s.updatedAt),
    })),
    monthlyBills: bills.map((b) => ({
      id: b.id,
      name: b.name,
      amountCents: b.amountCents,
      paidBy: b.paidBy,
      notes: b.notes ?? null,
      category: b.category,
      keepLightsOn: b.keepLightsOn,
      collapsed: b.collapsed,
      createdAt: backupTsToMs(b.createdAt),
    })),
    monthlyBillVersions: billVersions.map((v) => ({
      id: v.id,
      billId: v.billId,
      amountCents: v.amountCents,
      effectiveFrom: v.effectiveFrom,
      createdAt: backupTsToMs(v.createdAt),
    })),
    monthlyOneOffs: oneOffs.map((o) => ({
      id: o.id,
      month: o.month,
      description: o.description,
      amountCents: o.amountCents,
      note: o.note ?? null,
      createdAt: backupTsToMs(o.createdAt),
    })),
    monthlyCashOutItems: cashOutItems.map((o) => ({
      id: o.id,
      month: o.month,
      description: o.description,
      amountCents: o.amountCents,
      note: o.note ?? null,
      day: o.day,
      createdAt: backupTsToMs(o.createdAt),
    })),
    nwAccounts: nwAccountsExport,
    nwSnapshots: snapshots.map((s) => ({
      id: s.id,
      date: s.date,
      note: s.note ?? null,
      createdAt: backupTsToMs(s.createdAt),
    })),
    nwBalances: balances.map((b) => ({
      id: b.id,
      snapshotId: b.snapshotId,
      accountId: b.accountId,
      balanceCents: b.balanceCents,
      splitHsaCents: b.splitHsaCents,
      splitRothCents: b.splitRothCents,
      splitTaxableCents: b.splitTaxableCents,
      splitNonTaxableCents: b.splitNonTaxableCents,
      split529Cents: b.split529Cents,
      splitCashCents: b.splitCashCents,
      splitPreTaxCents: b.splitPreTaxCents,
    })),
    settings: settingsExport,
  };
  payload.authenticityMac = computeBackupMac(payload);
  return payload;
}

/* ---------------- Retirement calculator storage ----------------
   All calculator state lives in ONE encrypted JSON blob in settings
   under "retirement_calc_inputs_v1": the input fields at the top
   level, plus a "scenarios" array (up to 3 saved input sets). Keeping
   scenarios inside the same blob means the backup export / restore
   handling for that key (decrypt on export, re-encrypt on restore)
   covers them with no extra cases, and every writer below merges
   with the existing blob so saving inputs never wipes scenarios and
   saving a scenario never wipes inputs. A Reset-to-defaults is just
   a saveRetirementCalc with the default values (strategy Constant),
   so it preserves scenarios by construction. */
const RETIREMENT_KEY = "retirement_calc_inputs_v1";
const retirementStrategy = z.enum(["constant", "percent", "guardrails", "phased"]);
const retirementInputFields = {
  portfolioCents: z.number().int().nullable(),
  spendingCents: z.number().int().nullable(),
  currentAge: z.number().int().min(0).max(120).nullable(),
  retirementAge: z.number().int().min(0).max(120).nullable(),
  endAge: z.number().int().min(0).max(130).nullable(),
  stocksPct: z.number().min(0).max(100).nullable(),
  // Unsigned money (contract v66, boundary audit F11): extra
  // income is an income field — a negative was previously
  // accepted here and then silently floored to $0 when priced,
  // so the saved value was not the priced value. int≥0 at the
  // writer, and the Math.max(0, …) floors are gone from
  // buildSimInputs and the client, so saved = priced with no
  // undisclosed substitution.
  extraIncomeCents: z.number().int().min(0).nullable(),
  extraIncomeStartAge: z.number().int().min(0).max(120).nullable(),
  // RETURN FLOOR bound (round-5 fix 3): the shared
  // expectedReturnPctField (apiContractCore) — below −100%
  // refused at the save boundary; −100 prices a wipeout.
  expectedReturnPct: expectedReturnPctField,
  volatilityPct: z.number().min(0).nullable(),
  strategy: retirementStrategy.nullable(),
  percentOfPortfolio: z.number().min(0).max(100).nullable(),
  // Guardrails knobs (percent values). Null = the professional
  // default (cut 120%, raise 80%, adjustment 10%), substituted by
  // the client wherever the strategy runs — the same blank-means-
  // default pattern as expected return / volatility.
  guardrailsCutPct: z.number().min(50).max(300).nullable(),
  guardrailsRaisePct: z.number().min(50).max(300).nullable(),
  guardrailsAdjustmentPct: z.number().min(1).max(50).nullable(),
  // Phased knobs. Null = the defaults (step-down starts at 75,
  // declining 1%/yr), substituted wherever the strategy runs —
  // the same blank-means-default pattern as the guardrails knobs.
  // Records stored before the phased strategy existed carry no
  // such fields at all; the readers below resolve that absence
  // to null, and hence to the defaults — stored records are
  // never rewritten to add them. The start age's range runs to
  // the end-age ceiling (130): a start at or beyond the plan's
  // end age is valid and simply keeps the plan flat.
  phaseStartAge: z.number().int().min(0).max(130).nullable(),
  phaseDeclinePct: z.number().min(0).max(100).nullable(),
};
/* Cross-field save refusal (contract v66, boundary audit F6):
   when both ages are entered, the retirement age must be
   before the plan's end age. A plan with no retired years
   gives the Max Spending solver no year of spending to test —
   it used to return its search cap ($1,000,000/yr on a
   $100,000 portfolio) as if it were the sustainable-spending
   answer. The solver entry refuses the same combination
   (solveMaxSpending returns its no-answer null), and this
   refinement makes every Retirement save that feeds it refuse
   up front, naming the problem. Either age blank is untouched
   (the defaults are substituted downstream, as before). */
const retirementAgesRefinement = (
  v: { retirementAge: number | null; endAge: number | null },
  ctx: z.RefinementCtx,
) => {
  if (
    v.retirementAge != null &&
    v.endAge != null &&
    v.retirementAge >= v.endAge
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["retirementAge"],
      message: `Retirement age (${v.retirementAge}) must be before the plan's end age (${v.endAge}): with no retired years there is no year of spending for the Max Spending solver to test, so it cannot give an answer. Lower the retirement age or raise the end age.`,
    });
  }
};
const retirementScenario = z.object({
  name: z.string(),
  ...retirementInputFields,
});
type RetirementScenario = z.infer<typeof retirementScenario>;
type RetirementBlob = Record<string, unknown>;

/* The blob-1 state read (API follow-on F23): the parsed blob
   as readRetirementBlob returns it, its parsed scenarios, the
   record's write revision (the lenient read shared with the
   Roth record via rothRevisionCore — absent, non-integer, or
   negative counts as 0, so a blob written before revisions
   existed needs no backfill), and the stored raw value exactly
   as read (the ciphertext), or undefined when no row exists.
   The CAS writers predicate their guarded commits on that raw
   value; pure readers use readRetirementBlob below. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readRetirementBlobState(
  db: any,
  key: CryptoKey,
): Promise<{
  blob: RetirementBlob | null;
  scenarios: RetirementScenario[];
  revision: number;
  storedRaw: string | undefined;
  // Result-honesty (contract v67, F06): the record's presence /
  // readability, in the rothRevisionCore idiom — a PRESENT but
  // unreadable record reports { present: true, valid: false }
  // instead of masquerading as an absent one ({ present: false,
  // valid: true } is reserved for "no row stored").
  revisionState: { present: boolean; valid: boolean };
}> {
  const rows = await db.select().from(schema.settings);
  const raw = rows.find((r: { key: string }) => r.key === RETIREMENT_KEY)?.value;
  if (!raw)
    return {
      blob: null,
      scenarios: [],
      revision: 0,
      storedRaw: undefined,
      revisionState: { present: false, valid: true },
    };
  try {
    const plain = isEncrypted(raw) ? await decryptStr(key, raw) : raw;
    const parsed = JSON.parse(plain) as unknown;
    if (parsed == null || typeof parsed !== "object")
      return {
        blob: null,
        scenarios: [],
        revision: 0,
        storedRaw: raw,
        revisionState: { present: true, valid: false },
      };
    const blob = parsed as RetirementBlob;
    return {
      blob,
      scenarios: parseRetirementScenarios(blob),
      revision: parseRothBlobRevision(plain),
      storedRaw: raw,
      revisionState: { present: true, valid: true },
    };
  } catch {
    return {
      blob: null,
      scenarios: [],
      revision: 0,
      storedRaw: raw,
      revisionState: { present: true, valid: false },
    };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readRetirementBlob(db: any, key: CryptoKey): Promise<RetirementBlob | null> {
  return (await readRetirementBlobState(db, key)).blob;
}

/* The legacy unconditional blob-1 commit (a pre-encrypted
   value): used when a writer supplied no baseRevision, or no
   row exists yet to guard against. Guarded writes go through
   commitSettingsValueGuarded on RETIREMENT_KEY instead. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function upsertRetirementBlobValue(db: any, enc: string): Promise<void> {
  await db
    .insert(schema.settings)
    .values({ key: RETIREMENT_KEY, value: enc })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: enc },
    });
}

function parseRetirementScenarios(blob: RetirementBlob | null): RetirementScenario[] {
  if (!blob || !Array.isArray(blob.scenarios)) return [];
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const out: RetirementScenario[] = [];
  for (const raw of blob.scenarios as unknown[]) {
    if (raw == null || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const strat =
      r.strategy === "constant" || r.strategy === "percent" || r.strategy === "guardrails" || r.strategy === "phased"
        ? r.strategy
        : null;
    out.push({
      name: typeof r.name === "string" && r.name !== "" ? r.name : "Scenario",
      portfolioCents: num(r.portfolioCents),
      spendingCents: num(r.spendingCents),
      currentAge: num(r.currentAge),
      retirementAge: num(r.retirementAge),
      endAge: num(r.endAge),
      stocksPct: num(r.stocksPct),
      extraIncomeCents: num(r.extraIncomeCents),
      extraIncomeStartAge: num(r.extraIncomeStartAge),
      expectedReturnPct: num(r.expectedReturnPct),
      volatilityPct: num(r.volatilityPct),
      strategy: strat,
      percentOfPortfolio: num(r.percentOfPortfolio),
      guardrailsCutPct: num(r.guardrailsCutPct),
      guardrailsRaisePct: num(r.guardrailsRaisePct),
      guardrailsAdjustmentPct: num(r.guardrailsAdjustmentPct),
      phaseStartAge: num(r.phaseStartAge),
      phaseDeclinePct: num(r.phaseDeclinePct),
    });
    if (out.length >= 3) break;
  }
  return out;
}

/* ---------------- Retirement plan baseline ----------------
   The what-if comparison baseline for the Retirement view, stored
   as its own encrypted JSON blob in settings under
   "retirement_calc_baseline_v1": { kind, inputs } where inputs is
   a full retirement input set (the same fields saveRetirementCalc
   takes) and kind is "saved" (the user explicitly chose "Save as
   my plan") or "session" (captured automatically from the saved
   inputs record the first time the view is opened with no explicit
   baseline stored — see getRetirementCalc). Living in settings
   like the other calc state, it survives reloads and devices, and
   the backup export / restore handling for encrypted settings keys
   covers it (both lists name this key explicitly). */
const RETIREMENT_BASELINE_KEY = "retirement_calc_baseline_v1";
const retirementInputsShape = z.object({ ...retirementInputFields });
type RetirementInputs = z.infer<typeof retirementInputsShape>;
type RetirementBaselineKind = "saved" | "session";

function retirementInputsFromRecord(
  r: Record<string, unknown>,
): RetirementInputs {
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    portfolioCents: num(r.portfolioCents),
    spendingCents: num(r.spendingCents),
    currentAge: num(r.currentAge),
    retirementAge: num(r.retirementAge),
    endAge: num(r.endAge),
    stocksPct: num(r.stocksPct),
    extraIncomeCents: num(r.extraIncomeCents),
    extraIncomeStartAge: num(r.extraIncomeStartAge),
    expectedReturnPct: num(r.expectedReturnPct),
    volatilityPct: num(r.volatilityPct),
    strategy:
      r.strategy === "constant" ||
      r.strategy === "percent" ||
      r.strategy === "guardrails" ||
      r.strategy === "phased"
        ? r.strategy
        : null,
    percentOfPortfolio: num(r.percentOfPortfolio),
    guardrailsCutPct: num(r.guardrailsCutPct),
    guardrailsRaisePct: num(r.guardrailsRaisePct),
    guardrailsAdjustmentPct: num(r.guardrailsAdjustmentPct),
    phaseStartAge: num(r.phaseStartAge),
    phaseDeclinePct: num(r.phaseDeclinePct),
  };
}

/* The blob-2 state read (API follow-on F23 + result-honesty
   contract v67, F07): the parsed baseline (null when there is no
   usable one), the record's write revision (the same lenient
   read — absent, non-integer, or negative counts as 0), the
   stored raw value exactly as read (undefined when no row
   exists), and the record's presence / readability in the
   rothRevisionCore idiom: a PRESENT but unreadable baseline
   (malformed, not an object, or carrying no inputs object)
   reports { present: true, valid: false } with baseline null —
   it is NOT "no baseline". */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readRetirementBaselineState(
  db: any,
  key: CryptoKey,
): Promise<{
  baseline: { kind: RetirementBaselineKind; inputs: RetirementInputs } | null;
  revision: number;
  storedRaw: string | undefined;
  present: boolean;
  valid: boolean;
}> {
  const rows = await db.select().from(schema.settings);
  const raw = rows.find(
    (r: { key: string }) => r.key === RETIREMENT_BASELINE_KEY,
  )?.value;
  if (!raw)
    return {
      baseline: null,
      revision: 0,
      storedRaw: undefined,
      present: false,
      valid: true,
    };
  try {
    const plain = isEncrypted(raw) ? await decryptStr(key, raw) : raw;
    const parsed = JSON.parse(plain) as unknown;
    if (parsed == null || typeof parsed !== "object")
      return {
        baseline: null,
        revision: 0,
        storedRaw: raw,
        present: true,
        valid: false,
      };
    const blob = parsed as Record<string, unknown>;
    if (blob.inputs == null || typeof blob.inputs !== "object")
      return {
        baseline: null,
        revision: 0,
        storedRaw: raw,
        present: true,
        valid: false,
      };
    return {
      baseline: {
        kind: blob.kind === "saved" ? "saved" : "session",
        inputs: retirementInputsFromRecord(
          blob.inputs as Record<string, unknown>,
        ),
      },
      revision: parseRothBlobRevision(plain),
      storedRaw: raw,
      present: true,
      valid: true,
    };
  } catch {
    return {
      baseline: null,
      revision: 0,
      storedRaw: raw,
      present: true,
      valid: false,
    };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readRetirementBaseline(
  db: any,
  key: CryptoKey,
): Promise<{ kind: RetirementBaselineKind; inputs: RetirementInputs } | null> {
  return (await readRetirementBaselineState(db, key)).baseline;
}

/* The legacy unconditional blob-2 commit (a pre-encrypted
   value): used when a writer supplied no baseBaselineRevision,
   or no row exists yet to guard against. Guarded writes go
   through commitSettingsValueGuarded on
   RETIREMENT_BASELINE_KEY instead. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function upsertRetirementBaselineValue(db: any, enc: string): Promise<void> {
  await db
    .insert(schema.settings)
    .values({ key: RETIREMENT_BASELINE_KEY, value: enc })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: enc },
    });
}

/* ---------------- Retirement CAS shapes (F23) ----------------
   The lite current record a refused Retirement write carries:
   exactly the saved-state slice of getRetirementCalc's
   response (the defaults block is NOT recomputed for a
   refusal — the client already holds it from its load, and
   rehydration concerns saved state only), plus both records'
   revisions. Freshly read at refusal time, so the client
   rehydrates to the latest saved version and re-bases both
   writes from the one refusal. */
const retirementLiteRecord = z.object({
  saved: retirementInputsShape.nullable(),
  scenarios: z.array(retirementScenario),
  baseline: retirementInputsShape.nullable(),
  baselineKind: z.enum(["saved", "session"]).nullable(),
  revision: z.number().int().nonnegative(),
  baselineRevision: z.number().int().nonnegative(),
});
type RetirementLiteRecord = z.infer<typeof retirementLiteRecord>;

const saveRetirementCalcResponse = z.union([
  z.object({
    ok: z.literal(true),
    revision: z.number().int().nonnegative(),
  }),
  z.object({
    ok: z.literal(false),
    conflict: z.literal(true),
    revision: z.number().int().nonnegative(),
    baselineRevision: z.number().int().nonnegative(),
    record: retirementLiteRecord,
  }),
]);
type SaveRetirementCalcResponse = z.infer<typeof saveRetirementCalcResponse>;

const saveRetirementBaselineResponse = z.union([
  z.object({
    ok: z.literal(true),
    revision: z.number().int().nonnegative(),
    baselineRevision: z.number().int().nonnegative(),
    baseline: retirementInputsShape,
    baselineKind: z.literal("saved"),
  }),
  z.object({
    ok: z.literal(false),
    conflict: z.literal(true),
    // Present only on the baseline-stage conflict: the working
    // inputs WERE saved (blob 1 committed) but the baseline did
    // not move. Absent on an inputs-stage refusal, where
    // neither blob was written.
    stage: z.literal("baseline").optional(),
    revision: z.number().int().nonnegative(),
    baselineRevision: z.number().int().nonnegative(),
    record: retirementLiteRecord,
  }),
]);
type SaveRetirementBaselineResponse = z.infer<
  typeof saveRetirementBaselineResponse
>;

/* The three scenario writers' shared response (F23): the
   verdict, the reason, the scenarios array after the attempt,
   and blob 1's revision after the attempt — carried in
   success AND failure shapes alike, so the client adopts the
   fresh CAS base immediately. */
const retirementScenarioWriteResponse = z.object({
  ok: z.boolean(),
  reason: z.string(),
  scenarios: z.array(retirementScenario),
  revision: z.number().int().nonnegative(),
});
type RetirementScenarioWriteResult = z.infer<
  typeof retirementScenarioWriteResponse
>;

/* Read the lite record fresh (both blobs' current state) —
   the ONE builder behind every F23 conflict response. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadRetirementLiteRecord(
  db: any,
  key: CryptoKey,
): Promise<RetirementLiteRecord> {
  const blobState = await readRetirementBlobState(db, key);
  const baselineState = await readRetirementBaselineState(db, key);
  return {
    saved: blobState.blob
      ? retirementInputsFromRecord(blobState.blob)
      : null,
    scenarios: blobState.scenarios,
    baseline: baselineState.baseline?.inputs ?? null,
    baselineKind: baselineState.baseline?.kind ?? null,
    revision: blobState.revision,
    baselineRevision: baselineState.revision,
  };
}

/* One Retirement scenario write (F23): apply the caller's
   name-keyed transform to the stored scenarios array and
   commit the result with the revision stamped stored + 1,
   through the guarded commit (see
   commitSettingsValueGuarded). The scenario writers take no
   baseRevision — discrete clicks, not autosaves — so instead
   of refusing on a lost race they re-read ONCE and re-apply
   the transform against the fresh blob (append / filter /
   map by name are safely re-appliable, and the transform's
   validation re-runs against the fresh array, so a delete
   whose target vanished in the race returns the honest
   not-found verdict). A second lost race returns the failure
   shape carrying the freshest scenarios and revision. A
   transform that declines to write (a validation failure, or
   the rename no-op) returns its verdict against the current
   array without touching storage. Either way the response
   carries blob 1's revision after the attempt. The successor
   spreads the PARSED stored document and stamps the revision
   after the spread (composeRetirementScenarioBlob), so every
   other top-level field is preserved exactly. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function mutateRetirementScenarios(
  db: any,
  key: CryptoKey,
  transform: (
    scenarios: RetirementScenario[],
  ) => RetirementScenarioTransform<RetirementScenario>,
): Promise<RetirementScenarioWriteResult> {
  let state = await readRetirementBlobState(db, key);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Result-honesty (contract v67, F06): never compose a
    // successor over a PRESENT but unreadable record — that
    // would replace the damaged bytes with an empty document.
    if (state.revisionState.present && !state.revisionState.valid) {
      return {
        ok: false,
        reason:
          "Your saved Retirement record can't be read, so the scenarios were not changed.",
        scenarios: state.scenarios,
        revision: state.revision,
      };
    }
    const t = transform(state.scenarios);
    if (!t.write) {
      return {
        ok: t.ok,
        reason: t.reason,
        scenarios: state.scenarios,
        revision: state.revision,
      };
    }
    const nextRevision = state.revision + 1;
    const enc = await encryptStr(
      key,
      JSON.stringify(
        composeRetirementScenarioBlob(
          state.blob ?? {},
          t.scenarios,
          nextRevision,
        ),
      ),
    );
    if (state.storedRaw === undefined) {
      // No row yet: the first write establishes revision 1.
      await upsertRetirementBlobValue(db, enc);
      return {
        ok: t.ok,
        reason: t.reason,
        scenarios: t.scenarios,
        revision: nextRevision,
      };
    }
    if (
      await commitSettingsValueGuarded(
        db,
        RETIREMENT_KEY,
        state.storedRaw,
        enc,
      )
    ) {
      return {
        ok: t.ok,
        reason: t.reason,
        scenarios: t.scenarios,
        revision: nextRevision,
      };
    }
    if (attempt === 0) {
      // A concurrent write landed between our read and commit:
      // re-read and re-apply the transform against the fresh blob.
      state = await readRetirementBlobState(db, key);
    }
  }
  // A second lost race: report the freshest state we can read.
  const fresh = await readRetirementBlobState(db, key);
  return {
    ok: false,
    reason: "The saved scenarios changed elsewhere — try again.",
    scenarios: fresh.scenarios,
    revision: fresh.revision,
  };
}

/* ---------------- Roth Conversion storage ----------------
   Same one-blob pattern as the Retirement calculator: inputs at
   the top level plus a "scenarios" array (up to 50 saved fill
   strategies — ROTH_SCENARIO_LIMIT in rothOptimizer.ts), one encrypted JSON value in settings under
   "roth_conversion_inputs_v1". Every writer merges, so saving
   inputs never wipes scenarios and vice versa, and the backup
   export / restore handling for encrypted settings keys covers
   this blob the same way it covers the Retirement one. */
const ROTH_INPUTS_KEY = "roth_conversion_inputs_v1";
// rothFilingStatus and DRAW_ORDER_KEYS (the six spending draw
// orders, as the keys the tax engine defines) live in
// server/src/apiContractCore.ts — extracted so the accuracy
// fixtures pin the exact definitions the actions publish.
const rothPayTaxFrom = z.enum(["taxable", "conversion"]);
const rothCeilings = z.object({
  // Round-7 R7-3: only the seven supported federal bracket
  // rates validate (bracketTopPctField, apiContractCore);
  // null = no fill.
  bracketTopPct: bracketTopPctField,
  irmaaTierCap: z.number().int().nullable(),
  ltcgZeroCap: z.boolean(),
  acaCliffCap: z.boolean(),
  // Era-aware cliff cap (ERA-AWARE ACA CLIFF CAP build): when
  // true, the ACA cliff cap defends the line only before the
  // plan's first household-schedule step year. This key is OPTIONAL in both
  // ceilings schemas (this lenient one and the strict compute
  // variant below): a payload or stored record that omits the
  // key validates and reads as false (parseRothInputs coerces
  // with === true), so every record written before this build
  // keeps pricing bit-identically with no migration write.
  // The client always sends it. (The draw-order switch pair
  // is a different case: the writers REQUIRE it, and it is
  // omittable only in compute payloads — see rothComputeFields.)
  acaCliffCapFamilyOnly: z.boolean().optional(),
  magiCapCents: z.number().int().nullable(),
  // ACA cliff safety buffer (CLIFF SAFETY BUFFER build): the
  // plan's cliff targets aim this far BELOW the 400% FPL line.
  // Required with null accepted, like magiCapCents — the
  // client always sends it; null prices as no buffer.
  acaCliffBufferCents: z.number().int().nullable(),
});
/* Strict ceilings for the COMPUTE actions only (Piece 3 of the
   model-friendly API build): identical fields and constraints to
   rothCeilings, but unknown keys are REJECTED instead of silently
   stripped, so a misspelled ceiling key fails validation loudly
   instead of quietly pricing without that ceiling. The writers
   (saveRothInputs / saveRothScenario) keep the shared lenient
   rothCeilings above — writers strict on required keys, readers
   lenient there is the standing rule for SAVED records; the
   compute boundary is the reverse by explicit user approval. */
const rothCeilingsStrict = z.strictObject({
  bracketTopPct: bracketTopPctField,
  irmaaTierCap: z.number().int().nullable(),
  ltcgZeroCap: z.boolean(),
  acaCliffCap: z.boolean(),
  // Optional even here (see rothCeilings): absence prices as
  // false; an unknown key is still rejected.
  acaCliffCapFamilyOnly: z.boolean().optional(),
  magiCapCents: z.number().int().nullable(),
  // Required with null accepted (see rothCeilings): a compute
  // payload must name the buffer explicitly, null = none.
  acaCliffBufferCents: z.number().int().nullable(),
});
/* Basis tiers (BASIS TIERS build): the taxable pool split
   into up to 6 lots, each {sharePct, basisPct} — sharePct is
   the tier's share of the combined taxable pool (taxable +
   cash), basisPct the share of that tier that is basis. The
   tier object is STRICT (an unknown key fails loudly, like the
   compute ceilings), each % is bounded 0–100, and a non-empty
   list's shares must sum to 100 within a small epsilon — the
   writers enforce all of it through this one schema, which
   rides rothInputFields into every writer and compute action.
   Null (or an empty list, normalized to null by the reader) =
   no tiers: the pool prices as one pool at taxableBasisPct. */
const rothTaxableTier = z.strictObject({
  sharePct: z.number().min(0).max(100),
  basisPct: z.number().min(0).max(100),
});
const rothTaxableTiers = z
  .array(rothTaxableTier)
  .max(6)
  .nullable()
  .superRefine((tiers, ctx) => {
    if (tiers == null || tiers.length === 0) return;
    const sum = tiers.reduce((s, t) => s + t.sharePct, 0);
    if (Math.abs(sum - 100) > 0.01) {
      ctx.addIssue({
        code: "custom",
        message: `Taxable basis tier shares must add up to 100% (they add to ${sum}%).`,
      });
    }
  });
/* Education students (T6 build): the household's entered
   qualified education expenses as a list of per-student,
   per-calendar-year entries — one object per student per
   year, never one household lump, because the American
   Opportunity Tax Credit prices per student. Each entry is
   STRICT (an unknown key fails loudly, like the basis tiers
   above), the year is a calendar year, expenses are
   non-negative integer cents, and aotcEligible is the
   household's own declaration that the student is
   AOTC-eligible (the engine prices credit math and
   phase-outs from it; it does not judge enrollment
   eligibility). Null (or an empty list, normalized to null
   by the reader) = no expenses entered anywhere = no
   education credit prices, so an untouched record prices
   bit-identically to before. The list rides rothInputFields
   into every writer and compute action, so a compare
   scenario can override it like any other input. */
const rothEducationStudent = z.strictObject({
  year: z.number().int().min(1900).max(2200),
  expensesCents: z.number().int().min(0),
  aotcEligible: z.boolean(),
});
const rothEducationStudents = z
  .array(rothEducationStudent)
  .max(24)
  .nullable();
const rothInputFields = {
  birthYearPrimary: z.number().int().min(1900).max(2100).nullable(),
  birthYearSpouse: z.number().int().min(1900).max(2100).nullable(),
  filingStatus: rothFilingStatus.nullable(),
  pretaxCents: rothBalanceField,
  // Per-spouse pre-tax (the spouse's own balance) and the survivor
  // scenario — added with the per-spouse / survivor build. Null
  // on records written before it = spouse's balance not entered
  // (prices $0 / follows the Net Worth split rule on the client)
  // and the scenario off, so an untouched record prices exactly
  // as before. The first save after this build writes these
  // fields at those same defaults.
  pretaxSpouseCents: rothBalanceField,
  survivorEnabled: z.boolean().nullable(),
  survivorWho: z.enum(["primary", "spouse"]).nullable(),
  survivorDeathYear: z.number().int().min(1900).max(2200).nullable(),
  rothCents: rothBalanceField,
  taxableCents: rothBalanceField,
  // Exclude-from-plan (EXCLUDE-FROM-PLAN build): an amount of
  // the snapshot-followed taxable pool (Taxable + Cash buckets)
  // kept out of the plan's calculations entirely — not spent,
  // not sold, not in the yield base, not in ending wealth —
  // while Net Worth keeps the full amounts everywhere. It
  // applies only while taxableCents is null (the balance
  // follows the snapshot): resolvePlanBalances subtracts it
  // from the followed pool, floored at $0, before basis-tier
  // shares are computed; an explicit taxableCents override
  // wins exactly as before and the exclusion is inert. Null
  // on records written before this build = blank = no
  // exclusion, so an untouched record prices bit-identically.
  // A required key like every field here: null accepted,
  // omission rejected. SCENARIOS: the field rides the shared
  // record shape like every other balance field (the writers
  // are strict on it for scenarios too), but it is NOT a
  // Strategy Lab dial and a compare patch cannot use it to
  // re-price a snapshot pool — the compare's base is already
  // resolved when patches merge, so beside a frozen taxable
  // balance it is inert there, exactly as it is beside any
  // explicit override.
  taxableExcludeCents: z.number().int().nullable(),
  hsaCents: rothBalanceField,
  taxableBasisPct: z.number().min(0).max(100).nullable(),
  // Basis tiers: see rothTaxableTiers above. Null on records
  // written before this build = blank = one pool at the basis
  // % above, so an untouched record prices bit-identically.
  taxableTiers: rothTaxableTiers,
  // Taxable yields (TAXABLE YIELDS build): the taxable pool's
  // annual dividend and interest yields, each a % of the
  // year's starting taxable balance, priced as mandatory
  // income for the year (dividends on the capital-gains stack,
  // interest on the ordinary stack — see taxEngine). Null on
  // records written before this build = blank = no yield
  // modeled, so an untouched record prices bit-identically.
  // Required keys like every field here: null accepted,
  // omission rejected. Adding these two fields grows the
  // saved-inputs schema by two leaf fields.
  taxableDividendYieldPct: z.number().min(0).max(100).nullable(),
  taxableInterestYieldPct: z.number().min(0).max(100).nullable(),
  // Spend-from-cash (SPEND-FROM-CASH build): the % of each
  // year's spending need paid from the taxable pool's cash
  // tier first — no income, no gains, no MAGI from that share
  // (see taxEngine's RothPlanInputs note for the semantics
  // and the sleeve invariant). Null on records written before
  // this build = blank = off, so an untouched record prices
  // bit-identically. A required key like every field here:
  // null accepted, omission rejected. The sleeve's SIZE is
  // not a saved field: it is the snapshot Cash bucket portion
  // of the pool, threaded server-side at pricing time (see
  // resolveArgsBalances).
  spendFromCashPct: z.number().min(0).max(100).nullable(),
  // Flexible spending (FLEXIBLE SPENDING build): the % a
  // year's spending need is cut when the PRIOR simulated
  // year's applied return was negative, and the floor the
  // cut can never take a year below, as a % of the base need
  // (see apiContractCore's FLEX_SEMANTICS, published by
  // describeApi). Null on records written before this build:
  // flexCutPct null = blank = off, so an untouched record
  // prices bit-identically; flexFloorPct null reads as 80
  // inside a triggered cut. Required keys like every field
  // here: null accepted, omission rejected.
  flexCutPct: z.number().min(0).max(100).nullable(),
  flexFloorPct: z.number().min(0).max(100).nullable(),
  // Unsigned money (contract v66, boundary audit F1): annual
  // spending is a need the march funds, never a signed flow —
  // a negative value made the surplus sweep CREDIT the taxable
  // balance with money from nowhere. int≥0 here, in the shared
  // fields, so saveRothInputs AND every compute path refuse a
  // negative together — the same treatment the itemized / loss
  // fields below already carry. Deliberately signed fields
  // (otherOrdinaryCents and kin) stay signed.
  annualSpendingCents: z.number().int().min(0).nullable(),
  retirementAge: z.number().int().min(0).max(120).nullable(),
  endAge: z.number().int().min(0).max(130).nullable(),
  // RETURN FLOOR bound (round-5 fix 3): the shared
  // expectedReturnPctField (apiContractCore), as on the
  // Retirement record — below −100% refused at the save
  // boundary; the engine's growth factor is floored at 0
  // besides, so no pricing path can grow a balance below zero.
  expectedReturnPct: expectedReturnPctField,
  ssPrimaryAnnualCents: z.number().int().nullable(),
  ssPrimaryStartAge: z.number().int().min(0).max(120).nullable(),
  // Declared "No benefit" for either person's Social Security
  // (generic, symmetric). Null on records written before this
  // build = undeclared (false) with zero behavior change. Saves
  // normalize via normalizeSsDeclarations: declared → amount
  // null + flag true; amount present → flag false.
  ssPrimaryNoBenefit: z.boolean().nullable(),
  ssSpouseAnnualCents: z.number().int().nullable(),
  ssSpouseStartAge: z.number().int().min(0).max(120).nullable(),
  ssSpouseNoBenefit: z.boolean().nullable(),
  otherOrdinaryCents: z.number().int().nullable(),
  // Unsigned money (contract v66, boundary audit F4):
  // tax-exempt interest is interest received, never a signed
  // gain/loss — a negative value flowed straight into MAGI and
  // the ACA MAGI and understated both dollar for dollar.
  // int≥0, same shared-fields treatment as annualSpendingCents.
  taxExemptInterestCents: z.number().int().min(0).nullable(),
  convertedAlreadyCents: z.number().int().nullable(),
  windowStartAge: z.number().int().min(0).max(120).nullable(),
  windowStopAge: z.number().int().min(0).max(120).nullable(),
  payTaxFrom: rothPayTaxFrom.nullable(),
  protectMinTaxableCents: z.number().int().nullable(),
  // Preserve-pre-tax reserve: a fixed nominal floor conversions
  // may never cross, and the expected tax rate on the preserved
  // amount. Both nullable; null on records written before this
  // build = blank = no reserve / exit at the heir rate, so an
  // untouched record prices bit-identically to before.
  preservePretaxCents: z.number().int().nullable(),
  preserveExitRatePct: z.number().min(0).max(100).nullable(),
  // Earliest claiming age to consider (the claim floor) for
  // the optimizer's joint claiming-age search: the crowned
  // winner must claim at this age or later. Null on records
  // written before this build = blank = no floor, so an
  // untouched record crowns exactly the pre-build winner. It
  // constrains only the crowning — never a priced figure —
  // and below-floor ages are still priced and shown.
  claimAgeFloor: z.number().int().min(62).max(70).nullable(),
  spouseSoleBeneficiary: z.boolean().nullable(),
  // The second beneficiary fact (round-3 fix): the primary
  // is the sole beneficiary of the SPOUSE's pre-tax
  // accounts — a SEPARATE fact from spouseSoleBeneficiary
  // above (the spouse is the PRIMARY's sole beneficiary,
  // which selects only the primary's RMD table). This fact
  // alone selects the spouse's RMD table in the march.
  // Null on records written before this build = not
  // established = her RMD prices on the Uniform Lifetime
  // Table, so an untouched record prices bit-identically
  // to before (see the rmdBeneficiarySemantics convention
  // describeApi publishes). A required key like every field
  // here: null accepted, omission rejected — the compute
  // variant below makes it optional there.
  primarySoleBeneficiaryOfSpouse: z.boolean().nullable(),
  acaHouseholdSize: z.number().int().min(1).max(20).nullable(),
  // The household schedule (MULTI-STEP ACA HOUSEHOLD SCHEDULE
  // build): the ordered (fromYear → householdSize) steps away
  // from acaHouseholdSize — the shared acaHouseholdScheduleField
  // (apiContractCore): integer years 1900–2200, integer sizes
  // 1–20, at most 40 steps, years strictly increasing. It
  // REPLACES the old acaHouseholdSizeAfter / acaStepDownYear
  // pair: the writers no longer accept those keys, and a
  // record still carrying them is migrated by the readers
  // (parseRothInputs resolves it to the one-entry schedule
  // that prices bit-identically; the first save under this
  // build writes the schedule and drops the pair). Null =
  // no steps = the household size above governs every year,
  // so a fresh user with no steps sees exactly the defaults
  // the seed has always carried. A required key like every
  // field here: null accepted, omission rejected.
  acaHouseholdSchedule: acaHouseholdScheduleField,
  // The household's college window, labeled by fall year.
  // Drives ONLY the Roth view's FAFSA college-years watch-out
  // (a conversion in tax year Y feeds the FAFSA for academic
  // year Y+2). Null on records written before this build =
  // blank = no college in the household = the watch-out never
  // fires; every other input and figure is unaffected.
  collegeFallFromYear: z.number().int().min(1900).max(2200).nullable(),
  collegeFallThroughYear: z.number().int().min(1900).max(2200).nullable(),
  acaBenchmarkCoupleCents: z.number().int().nullable(),
  acaBenchmarkSingleCents: z.number().int().nullable(),
  // Family benchmark (household of 3+). Null on records written
  // before this build = blank = a household-3+ year falls back
  // to the benchmark that priced it before (the couple figure
  // in the family years), so an untouched record prices
  // bit-identically to before.
  acaBenchmarkFamilyCents: z.number().int().nullable(),
  // Spouse ACA end age: the age the spouse leaves the
  // marketplace for Medicare. Her ACA pricing runs while her
  // age is under it, and her Medicare / IRMAA premium count
  // starts at it; the primary's own 65 is untouched. Null on
  // records written before this build = blank = 65, so an
  // untouched record prices bit-identically to before. Whole
  // ages 55–80 only: an out-of-range value fails validation
  // loudly here (writers and compute actions alike) — it is
  // never silently clamped.
  acaSpouseEndAge: z.number().int().min(55).max(80).nullable(),
  // Inflation (contract v66, boundary audit F2): must be
  // finite and strictly greater than −100 — at exactly −100
  // the deflation factor divides by (1 + pct/100) = 0 and
  // statute-fixed amounts price at Infinity. The exclusive
  // bound lives here in the shared fields so every writer and
  // compute path refuses together; deflationFactor also
  // refuses a non-finite factor at its consumption sites as
  // defense in depth.
  inflationPct: z.number().finite().gt(-100).nullable(),
  stateRatePct: z.number().min(0).max(100).nullable(),
  // State of residence (T3 build): "WA" prices Washington's
  // capital-gains excise (RCW 82.87) instead of the flat
  // stateRatePct; "other" and null both price the flat rate.
  // Null on records written before this build = no rules
  // layer chosen = the flat rate, bit-identical to before.
  residenceState: z.enum(["WA", "other"]).nullable(),
  // Capital-loss carryforward entering the plan (T4 build):
  // the household's banked capital losses from before the
  // plan starts, short-term and long-term, in integer cents
  // (losses stated as positive amounts). Null on records
  // written before this build = blank = $0 = no banked loss,
  // so an untouched record prices bit-identically to
  // before; the engine's cross-year ledger consumes them
  // from there (see the lossCarryforwardSemantics
  // convention describeApi publishes). Negative amounts
  // fail validation — a carryforward is a loss, never a
  // gain. Adding these two fields grows the saved-inputs
  // schema from 57 to 59 leaf fields.
  capitalLossCarryInStCents: z.number().int().min(0).nullable(),
  capitalLossCarryInLtCents: z.number().int().min(0).nullable(),
  // Itemized deductions (T5 build): the household's annual
  // itemized components in integer cents — mortgage
  // interest, state and local taxes paid, charitable
  // contributions, and other itemized deductions — kept
  // separate (never one lump) because the SALT component is
  // capped on its own at the priced year's §164(b)(7) cap
  // and the charitable component is the one charitable
  // input the Washington layer also reads. Null on records
  // written before this build = blank = $0 on that
  // component, so an untouched record prices
  // bit-identically to before (the itemized total is $0
  // and the standard deduction wins every year — see the
  // itemizedDeductionSemantics convention describeApi
  // publishes). Negative amounts fail validation — a
  // deduction component is never negative. Adding these
  // four fields grows the saved-inputs schema from 59 to
  // 63 leaf fields.
  itemizedMortgageInterestCents: z.number().int().min(0).nullable(),
  itemizedSaltPaidCents: z.number().int().min(0).nullable(),
  itemizedCharitableCents: z.number().int().min(0).nullable(),
  itemizedOtherCents: z.number().int().min(0).nullable(),
  // Education expenses (T6 build): the per-student,
  // per-calendar-year qualified-expense entries (see
  // rothEducationStudents above). Null on records written
  // before this build = blank = no expenses entered
  // anywhere, so no education credit prices and an
  // untouched record prices bit-identically to before (see
  // the educationCreditSemantics convention describeApi
  // publishes). Expenses are entered, never inferred —
  // nothing in this schema derives them from the 529 /
  // college fields or any other input. Adding this field
  // grows the saved-inputs schema from 63 to 64 leaf fields.
  educationStudents: rothEducationStudents,
  heirRatePct: z.number().min(0).max(100).nullable(),
  ceilings: rothCeilings.nullable(),
  // Lifetime-Tax Optimizer variant flags carried by the working
  // strategy and by saved scenarios, so a scenario saved from an
  // optimizer result reproduces its schedule exactly. Null on
  // blobs written before the optimizer existed = both off.
  optimizerGuardrail: z.boolean().nullable(),
  optimizerBunching: z.boolean().nullable(),
  // Gain harvesting (option 8): a per-strategy toggle carried
  // by the working inputs and by saved scenarios exactly like
  // the optimizer variant flags above. When true, each
  // simulated year — after its draws and conversions settle —
  // realizes taxable gains up to the year's remaining 0%
  // capital-gains space and steps the taxable basis up by the
  // harvested amount, respecting every ceiling the strategy
  // carries. Null on records written before this build = off,
  // so an untouched record prices bit-identically to before.
  gainsHarvest: z.boolean().nullable(),
  // Spending draw order: the order the Taxable / Pre-tax / Roth
  // buckets fund spending in after the year's forced RMD.
  // Carried by the working inputs and by saved scenarios, so a
  // scenario saved from an optimizer winner reproduces its
  // schedule exactly. Null on blobs written before the
  // draw-order build = the default order (Taxable → Pre-tax →
  // Roth); the first save after this build writes the field at
  // that same default for an untouched plan, so the saved
  // plan's figures do not move.
  drawOrder: z.enum(DRAW_ORDER_KEYS).nullable(),
  // Draw-order switch: the age at which spending draws switch
  // to a different order, and that after-order (same six-value
  // enum as drawOrder). Both nullable; null on records written
  // before this build = blank = no switch, so an untouched
  // record prices bit-identically to before. If EITHER field is
  // blank the switch is inert — the base draw order applies at
  // every age. Adding these two fields grows the saved-inputs
  // schema from 55 to 57 leaf fields.
  drawOrderSwitchAge: z.number().int().min(0).max(120).nullable(),
  drawOrderAfter: z.enum(DRAW_ORDER_KEYS).nullable(),
  // Work-years job inputs (the Work years tab's "Your job"
  // group): the yearly salary and what the employer puts into
  // the 401(k) and the HSA per year. Saved plan fields like
  // every other field here — they are the tab's defaults.
  // Null on records written before this build = blank = no
  // salary entered, so no work years are priced and every
  // other figure is exactly as before.
  yearlySalaryCents: z.number().int().nullable(),
  employer401kCents: z.number().int().nullable(),
  employerHsaCents: z.number().int().nullable(),
};
/* Compute-request variant of the plan-input shape: the SAME
   properties, in the same order, with the same constraints —
   except the two draw-order switch fields are OPTIONAL, so a
   pricing payload that simply OMITS them validates and prices
   the legacy behaviour (absent ≡ null; the handlers and
   planInputsFromSaved already default them with ?? null).
   Used by every read-only pricing action that takes the plan
   inputs (optimizer, compare, Monte Carlo check, work-years,
   gift compare, plan-year detail). The writers keep the strict
   shape above: saveRothInputs (and saveRothScenario) persist
   complete records, so every field stays required there. The
   compare action's nested scenarios[].overrides object needs
   no variant — it is already .partial(), so neither switch
   key is required at that level. */
const rothComputeFields = {
  ...rothInputFields,
  drawOrderSwitchAge: rothInputFields.drawOrderSwitchAge.optional(),
  drawOrderAfter: rothInputFields.drawOrderAfter.optional(),
  // Compute path only (T3): a pricing payload may omit the
  // residence — absent prices exactly as null (the flat rate).
  residenceState: rothInputFields.residenceState.optional(),
  // Compute path only (T4): a pricing payload may omit the
  // entering loss carryforwards — absent prices exactly as
  // null ($0 banked, the ledger never engages).
  capitalLossCarryInStCents: rothInputFields.capitalLossCarryInStCents.optional(),
  capitalLossCarryInLtCents: rothInputFields.capitalLossCarryInLtCents.optional(),
  // Compute path only (T5): a pricing payload may omit the
  // itemized components — absent prices exactly as null
  // ($0 on that component; the standard deduction wins).
  itemizedMortgageInterestCents: rothInputFields.itemizedMortgageInterestCents.optional(),
  itemizedSaltPaidCents: rothInputFields.itemizedSaltPaidCents.optional(),
  itemizedCharitableCents: rothInputFields.itemizedCharitableCents.optional(),
  itemizedOtherCents: rothInputFields.itemizedOtherCents.optional(),
  // Compute path only (T6): a pricing payload may omit the
  // education students — absent prices exactly as null (no
  // expenses entered, no credits).
  educationStudents: rothInputFields.educationStudents.optional(),
  // Compute path only (round-3 fix): a pricing payload may
  // omit the second beneficiary fact — absent prices
  // exactly as null (not established; the spouse's RMD
  // prices on the Uniform Lifetime Table).
  primarySoleBeneficiaryOfSpouse:
    rothInputFields.primarySoleBeneficiaryOfSpouse.optional(),
  // Compute path only: the strict ceilings variant (unknown keys
  // rejected). rothInputFields itself — and therefore the writers
  // and the saved shape — keeps the lenient shared object.
  ceilings: rothCeilingsStrict.nullable(),
};
/* Strict partial overrides for runRothCompare's scenarios: the
   saved-shape fields, every one optional (a patch — no key
   required), built inside a strictObject so an unknown or
   misspelled override key fails validation instead of being
   silently dropped, and with the strict ceilings variant nested.
   Built from the rothInputFields record WITHOUT altering it:
   each field schema is re-wrapped as .optional(). */
function optionalFields<T extends Record<string, z.ZodType>>(fields: T): {
  [K in keyof T]: z.ZodOptional<T[K]>;
} {
  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k, v.optional()]),
  ) as { [K in keyof T]: z.ZodOptional<T[K]> };
}
const rothOverridesStrict = z.strictObject({
  ...optionalFields(rothInputFields),
  ceilings: rothCeilingsStrict.nullable().optional(),
});
/* Execution-year ("This year") fields — PLAN-RECORD ONLY.
   They live in the same saved inputs record, under their own
   execution* keys, stamped with the calendar year they describe
   (executionYear). They are deliberately NOT part of
   rothInputFields: that object is shared by the scenario schema,
   the scenario writers, and the optimizer request, and execution
   fields must never leak into any of them — saved scenarios
   neither carry nor restore them, and saving / loading /
   deleting a scenario never touches them (the scenario writers
   pass the inputs record through raw, execution keys included).
   Only saveRothInputs — the plan record's own writer — accepts
   them, and only getRothPlanner returns them (consumed for the
   current calendar year via consumeExecutionInputs, so a stale
   year stamp can never price). executionAlreadyConvertedCents
   is the year-to-date conversions figure for the stamped year —
   a DIFFERENT field from convertedAlreadyCents above, which
   belongs to the plan window's first year. */
const rothExecutionFields = {
  executionYear: z.number().int().min(1900).max(2200).nullable(),
  executionPretaxCents: z.number().int().nullable(),
  executionPretaxSpouseCents: z.number().int().nullable(),
  executionRothCents: z.number().int().nullable(),
  executionTaxableCents: z.number().int().nullable(),
  executionHsaCents: z.number().int().nullable(),
  executionOtherOrdinaryCents: z.number().int().nullable(),
  executionTaxExemptInterestCents: z.number().int().nullable(),
  executionAlreadyConvertedCents: z.number().int().nullable(),
};
const rothExecutionResponse = z.object({
  ...rothExecutionFields,
  // True when a stored execution shape was stamped with an
  // earlier calendar year and has been consumed as blank for
  // the new year; clearedYear names the year that was cleared.
  rolledOver: z.boolean(),
  clearedYear: z.number().nullable(),
});
type RothExecutionResponse = z.infer<typeof rothExecutionResponse>;

/* Market-uncertainty check fields — PLAN-RECORD ONLY, following
   the execution-fields pattern exactly. The check's volatility
   is a display preference of the Optimize workspace's
   market-uncertainty panel: it lives in the same saved inputs
   record under its own key, accepted ONLY by saveRothInputs and
   returned ONLY by getRothPlanner (its own mcCheck block). It
   is deliberately NOT part of rothInputFields: it never enters
   scenarios, never reaches planInputsFromSaved, and never
   affects planner / optimizer / compare / execution pricing.
   Null / absent = the panel default of 15. */
const rothMcCheckFields = {
  mcVolatilityPct: z.number().min(0).max(100).nullable(),
};
const rothMcCheckResponse = z.object({ ...rothMcCheckFields });
type RothMcCheckStored = z.infer<typeof rothMcCheckResponse>;

/* Gift-stock what-if fields — PLAN-RECORD ONLY, following the
   execution / mcCheck pattern exactly. The gift description
   (one hypothetical gift of appreciated stock to one child)
   lives in the same saved inputs record under its own gift*
   keys, accepted ONLY by saveRothInputs, returned ONLY by
   getRothPlanner (its own gift block), and read ONLY by the
   runRothGiftCompare action. The fields are deliberately NOT
   part of rothInputFields: they never enter scenarios, never
   reach planInputsFromSaved, and never affect the Plan /
   Optimize / Compare / Work years runs — the comparison
   prices the plan twice itself (server/src/giftModel.ts).
   All nullable; null on records written before this build =
   blank = no gift described, so an untouched record is
   exactly as before. Adding these seven fields grows the
   saveRothInputs request from 60 to 67 fields. */
const rothGiftFields = {
  giftAge: z.number().int().min(0).max(120).nullable(),
  giftAmountCents: z.number().int().nullable(),
  giftBasisCents: z.number().int().nullable(),
  giftKidBirthYear: z.number().int().min(1900).max(2100).nullable(),
  giftKidStudent: z.boolean().nullable(),
  giftKidOtherIncomeCents: z.number().int().nullable(),
  giftSaleAge: z.number().int().min(0).max(120).nullable(),
};
const rothGiftResponse = z.object({ ...rothGiftFields });
// The stored gift shape and its ONE parse live in
// server/src/giftModel.ts (parseRothGift / BLANK_ROTH_GIFT,
// imported above) so the accuracy fixtures pin the exact
// parse the planner uses. parseRothInputs never sees these
// keys — exactly like the execution and mcCheck blocks.

/* Tax-return actuals fields — PLAN-RECORD ONLY, following the
   execution / mcCheck / gift pattern exactly. The household's
   most recent Form 1040 actuals (line 2b taxable interest,
   line 3a qualified dividends, line 3b ordinary dividends)
   live in the same saved inputs record under their own
   taxReturn* keys, accepted ONLY by saveRothInputs and
   returned ONLY by getRothPlanner (its own taxReturn block).
   They are deliberately NOT part of rothInputFields: they
   never enter scenarios, never reach planInputsFromSaved, and
   never affect planner / optimizer / compare / funding /
   work-years pricing — those keep modelling interest and
   dividends from the yield fields. Their ONE consumer is the
   Playground's "Start from my numbers" prefill (see
   taxReturnCore.ts and the taxReturnSemantics convention
   describeApi publishes). All nullable integer cents; null on
   records written before this build = blank = that line not
   entered, so an untouched record is exactly as before.
   Adding these three fields grows the saveRothInputs request
   from 67 to 70 fields. */
const rothTaxReturnFields = {
  taxReturnInterestCents: z.number().int().nullable(),
  taxReturnQualifiedDividendsCents: z.number().int().nullable(),
  taxReturnOrdinaryDividendsCents: z.number().int().nullable(),
};
const rothTaxReturnResponse = z.object({ ...rothTaxReturnFields });
// The stored tax-return shape, its ONE parse, and the prefill
// mapping live in server/src/taxReturnCore.ts
// (parseRothTaxReturn / BLANK_ROTH_TAX_RETURN /
// taxReturnPrefillDollars, imported above) so the accuracy
// fixtures pin the exact parse and mapping the app uses.
// parseRothInputs never sees these keys — exactly like the
// execution, mcCheck, and gift blocks.

/* ---------------- API contract & provenance (model-friendly API) ----------------
   Version stamps shared by describeApi (Piece 1) and by the
   provenance block on every pricing response (Piece 2) — ONE
   definition, used identically everywhere:
   - API_CONTRACT_VERSION: integer version of the action contract
     (request/response shapes + conventions) published by
     describeApi. Starts at 1; bump when a published shape or
     convention changes incompatibly.
   - ENGINE_VERSION: version stamp of the pricing engine (the
     taxEngine / rothOptimizer / workYears / giftModel stack as
     priced through these actions). Scheme: "engine-<n>", an
     integer counter starting at 1; bump when engine pricing
     behaviour changes. It is a stamp, not a calculation input —
     no engine file reads it.
   - Law versions are NOT constants here: lawYear and
     lawYearsAvailable are derived at call time from taxLaw.ts
     (CURRENT_LAW / TAX_LAW_YEARS), so they can never drift from
     the tables the engine actually prices with. */
// Exported so the packaged verification harness derives its
// expected contract version from this same constant instead of
// hard-coding a number that silently stales on the next bump
// (round-7 fix H-1).
export const API_CONTRACT_VERSION = 77;
const ENGINE_VERSION = "engine-1";

const provenanceOut = z.object({
  apiContractVersion: z.number().int(),
  engineVersion: z.string(),
  lawYear: z.number().int(),
  lawYearsAvailable: z.array(z.number().int()),
});
type Provenance = z.infer<typeof provenanceOut>;

function apiProvenance(): Provenance {
  return {
    apiContractVersion: API_CONTRACT_VERSION,
    engineVersion: ENGINE_VERSION,
    lawYear: CURRENT_LAW.year,
    lawYearsAvailable: TAX_LAW_YEARS.map((l) => l.year),
  };
}

/* The resolved plan inputs a pricing run actually priced, in the
   saved-shape integer-cents form: the request payload with null
   balances resolved from the latest Net Worth snapshot
   (resolveArgsBalances), parsed back through parseRothInputs —
   exactly the construction runRothCompare uses for its
   per-scenario effectiveInputs. Null when the payload cannot be
   parsed into the saved shape (defensive; a validated compute
   payload always parses). */
async function computeEffectiveInputs<T extends {
  pretaxCents: number | null;
  pretaxSpouseCents: number | null;
  rothCents: number | null;
  taxableCents: number | null;
  hsaCents: number | null;
  spendFromCashSleeveCents?: number | null;
}>(
  ctx: Ctx,
  args: T,
  // Year-capture (v37): the calling Roth compute action's ONE
  // captured calendar year. When supplied, this helper uses it
  // instead of re-reading the clock, so the whole invocation
  // prices and echoes with a single startYear. Absent = legacy
  // behaviour (read the clock here) for any non-compute caller.
  capturedYear?: number,
): Promise<{ resolved: T; effectiveInputs: RothEffectiveInputs | null }> {
  const resolved = await resolveArgsBalances(ctx, args);
  const parsed = parseRothInputs(resolved);
  // The echoed sleeve is the engine's effective starting
  // sleeve, DERIVED from the same resolved payload the run
  // prices with (R4-3, F7) — not the threaded transient, which
  // can disagree with the priced sleeve in tiers mode, above
  // the pool cap, or when spendFromCashPct is blank / 0. The
  // sleeve-relevant outputs of planInputsFromSaved are
  // start-year-independent, so this derivation prices the
  // same sleeve the handler's own planInputsFromSaved call
  // does.
  // Every caller passes a full saved-shape payload (the same
  // assumption parseRothInputs(resolved) above already makes);
  // the generic constraint names only the balance fields this
  // function itself reads, so the resolved payload is viewed
  // as the saved shape for the engine-input construction.
  const engineInputs = planInputsFromSaved(
    resolved as unknown as RothSavedLike,
    capturedYear ?? new Date().getFullYear(),
  );
  const sleeveCents =
    engineInputs == null
      ? null
      : Math.round(deriveSpendFromCashSleeveStartDollars(engineInputs) * 100);
  return {
    resolved,
    effectiveInputs: parsed == null ? null : withSleeveEcho(parsed, sleeveCents),
  };
}

const rothSavedInputs = z.object({ ...rothInputFields });
/* The compute-echo shape (API follow-on 2, finding F16): the
   saved-shape inputs object extended with the priced
   spend-from-cash sleeve — a transient the compute actions
   accept and resolveArgsBalances threads, now echoed back so a
   caller can see the sleeve size the run actually priced with
   (integer cents, null when no sleeve was priced). Used for
   EVERY compute action's effectiveInputs slot; getRothPlanner's
   saved field and all writer responses keep rothSavedInputs —
   the sleeve is not a saved field and never appears there. */
const rothEffectiveInputsOut = z.object({
  ...rothInputFields,
  spendFromCashSleeveCents: z.number().int().nullable(),
});
type RothEffectiveInputs = z.infer<typeof rothEffectiveInputsOut>;
const rothScenario = z.object({ name: z.string(), ...rothInputFields });
/* The four Roth scenario writers' shared response (API
   follow-on 1): the verdict, the reason, the scenarios array
   after the attempt, and the record's revision after the
   attempt — carried in success AND failure shapes alike, so
   the client can adopt the fresh CAS base immediately. */
const rothScenarioWriteResponse = z.object({
  ok: z.boolean(),
  reason: z.string(),
  scenarios: z.array(rothScenario),
  revision: z.number().int().nonnegative(),
  // Contract v65 (CAS sweep, F22): present (true) when an
  // updateRothScenario write was refused at the SCENARIO level —
  // the named scenario's stored payload no longer matches the
  // editor's loaded base payload, even though the record blob
  // itself committed fine for other writers.
  conflict: z.boolean().optional(),
});
type RothInputs = z.infer<typeof rothSavedInputs>;
type RothScenario = z.infer<typeof rothScenario>;
type RothStoredInputs = RothInputs &
  RothExecutionCents &
  RothMcCheckStored &
  RothGiftStored &
  RothTaxReturnStored;

function parseRothInputs(raw: unknown): RothInputs | null {
  if (raw == null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
  const fs =
    r.filingStatus === "mfj" || r.filingStatus === "single" || r.filingStatus === "hoh"
      ? r.filingStatus
      : null;
  const ptf = r.payTaxFrom === "taxable" || r.payTaxFrom === "conversion" ? r.payTaxFrom : null;
  let ceilings: RothInputs["ceilings"] = null;
  if (r.ceilings != null && typeof r.ceilings === "object") {
    const c = r.ceilings as Record<string, unknown>;
    ceilings = {
      bracketTopPct: num(c.bracketTopPct),
      irmaaTierCap: num(c.irmaaTierCap),
      ltcgZeroCap: c.ltcgZeroCap === true,
      acaCliffCap: c.acaCliffCap === true,
      // Absent on a record written before the era-aware build
      // reads as false — the record prices exactly as before.
      acaCliffCapFamilyOnly: c.acaCliffCapFamilyOnly === true,
      magiCapCents: num(c.magiCapCents),
      // Absent on a record written before the cliff-buffer
      // build reads as null — no buffer, exactly as before.
      acaCliffBufferCents: num(c.acaCliffBufferCents),
    };
  }
  return {
    birthYearPrimary: num(r.birthYearPrimary),
    birthYearSpouse: num(r.birthYearSpouse),
    filingStatus: fs,
    pretaxCents: num(r.pretaxCents),
    pretaxSpouseCents: num(r.pretaxSpouseCents),
    survivorEnabled: bool(r.survivorEnabled),
    survivorWho:
      r.survivorWho === "primary" || r.survivorWho === "spouse"
        ? r.survivorWho
        : null,
    survivorDeathYear: num(r.survivorDeathYear),
    rothCents: num(r.rothCents),
    taxableCents: num(r.taxableCents),
    // Exclude-from-plan, read leniently like every field here:
    // absent on a pre-build record reads as null = blank = no
    // exclusion, bit-identical pricing.
    taxableExcludeCents: num(r.taxableExcludeCents),
    hsaCents: num(r.hsaCents),
    taxableBasisPct: num(r.taxableBasisPct),
    // Basis tiers, read leniently (readers lenient is the
    // standing rule): keep the well-formed entries of a stored
    // array — an entry needs two finite numbers — capped at 6;
    // anything else (absent, not an array, no well-formed
    // entry) reads as null = no tiers. The sum-to-100 rule is
    // the writers' to enforce; the engine normalizes shares
    // defensively, so a stored list can never split less than
    // the whole pool.
    taxableTiers: ((): { sharePct: number; basisPct: number }[] | null => {
      if (!Array.isArray(r.taxableTiers)) return null;
      const tiers: { sharePct: number; basisPct: number }[] = [];
      for (const raw of r.taxableTiers as unknown[]) {
        if (raw == null || typeof raw !== "object") continue;
        const t = raw as Record<string, unknown>;
        const sharePct = num(t.sharePct);
        const basisPct = num(t.basisPct);
        if (sharePct == null || basisPct == null) continue;
        tiers.push({ sharePct, basisPct });
        if (tiers.length >= 6) break;
      }
      return tiers.length > 0 ? tiers : null;
    })(),
    // Taxable yields, read leniently like every field here:
    // absent on a pre-build record reads as null = blank = no
    // yield modeled, bit-identical pricing.
    taxableDividendYieldPct: num(r.taxableDividendYieldPct),
    taxableInterestYieldPct: num(r.taxableInterestYieldPct),
    // Spend-from-cash, read leniently like the yield fields:
    // absent on a pre-build record reads as null = blank = off.
    spendFromCashPct: num(r.spendFromCashPct),
    // Flexible spending, read leniently like the fields
    // above: absent on a pre-build record reads as null =
    // off (cut) / floor 80 inside a triggered cut (floor).
    flexCutPct: num(r.flexCutPct),
    flexFloorPct: num(r.flexFloorPct),
    annualSpendingCents: num(r.annualSpendingCents),
    retirementAge: num(r.retirementAge),
    endAge: num(r.endAge),
    expectedReturnPct: num(r.expectedReturnPct),
    ssPrimaryAnnualCents:
      r.ssPrimaryNoBenefit === true ? null : num(r.ssPrimaryAnnualCents),
    ssPrimaryStartAge: num(r.ssPrimaryStartAge),
    ssPrimaryNoBenefit: bool(r.ssPrimaryNoBenefit),
    ssSpouseAnnualCents:
      r.ssSpouseNoBenefit === true ? null : num(r.ssSpouseAnnualCents),
    ssSpouseStartAge: num(r.ssSpouseStartAge),
    ssSpouseNoBenefit: bool(r.ssSpouseNoBenefit),
    otherOrdinaryCents: num(r.otherOrdinaryCents),
    taxExemptInterestCents: num(r.taxExemptInterestCents),
    convertedAlreadyCents: num(r.convertedAlreadyCents),
    windowStartAge: num(r.windowStartAge),
    windowStopAge: num(r.windowStopAge),
    payTaxFrom: ptf,
    protectMinTaxableCents: num(r.protectMinTaxableCents),
    preservePretaxCents: num(r.preservePretaxCents),
    preserveExitRatePct: num(r.preserveExitRatePct),
    claimAgeFloor: num(r.claimAgeFloor),
    spouseSoleBeneficiary: bool(r.spouseSoleBeneficiary),
    // The second beneficiary fact, read leniently like its
    // sibling: absent on a pre-round-3 record reads as null
    // = not established (the spouse's RMD prices Uniform),
    // bit-identical pricing.
    primarySoleBeneficiaryOfSpouse: bool(r.primarySoleBeneficiaryOfSpouse),
    acaHouseholdSize: num(r.acaHouseholdSize),
    // Household schedule (MULTI-STEP ACA HOUSEHOLD SCHEDULE
    // build), read leniently like the basis tiers and
    // education students above: keep the well-formed entries
    // of a stored array (each an object carrying two finite
    // numbers — the resolver checks integrality and range),
    // then resolve through the ONE resolver
    // (resolveAcaHouseholdSchedule): it sanitizes, sorts, and
    // dedupes the entries, and — when the record carries NO
    // usable schedule — synthesizes the one-entry migration
    // schedule from a pre-build record's legacy
    // acaStepDownYear / acaHouseholdSizeAfter pair, so an
    // untouched legacy record prices bit-identically. The
    // legacy keys are read HERE only; nothing writes them.
    acaHouseholdSchedule: ((): AcaHouseholdStep[] | null => {
      const entries: AcaHouseholdStep[] = [];
      if (Array.isArray(r.acaHouseholdSchedule)) {
        for (const rawEntry of r.acaHouseholdSchedule as unknown[]) {
          if (rawEntry == null || typeof rawEntry !== "object") continue;
          const e = rawEntry as Record<string, unknown>;
          const fromYear = num(e.fromYear);
          const householdSize = num(e.householdSize);
          if (fromYear == null || householdSize == null) continue;
          entries.push({ fromYear, householdSize });
        }
      }
      return resolveAcaHouseholdSchedule({
        acaHouseholdSchedule: entries.length > 0 ? entries : null,
        acaHouseholdSizeAfter: num(r.acaHouseholdSizeAfter),
        acaStepDownYear: num(r.acaStepDownYear),
        acaHouseholdSize: num(r.acaHouseholdSize),
      });
    })(),
    collegeFallFromYear: num(r.collegeFallFromYear),
    collegeFallThroughYear: num(r.collegeFallThroughYear),
    acaBenchmarkCoupleCents: num(r.acaBenchmarkCoupleCents),
    acaBenchmarkSingleCents: num(r.acaBenchmarkSingleCents),
    acaBenchmarkFamilyCents: num(r.acaBenchmarkFamilyCents),
    acaSpouseEndAge: num(r.acaSpouseEndAge),
    inflationPct: num(r.inflationPct),
    stateRatePct: num(r.stateRatePct),
    // Lenient read (T3): only the two known values survive;
    // anything else (including absence on pre-build records)
    // reads as null = the flat-rate fallback.
    residenceState:
      r.residenceState === "WA"
        ? "WA"
        : r.residenceState === "other"
          ? "other"
          : null,
    // Loss carryforward entering the plan (T4), read
    // leniently like every field here: absent on a pre-build
    // record reads as null = blank = $0 banked. A stored
    // negative is not a loss and reads as null too — the
    // writers reject negatives at validation, so one can
    // only arrive in a hand-edited blob, where blank is the
    // honest read.
    capitalLossCarryInStCents:
      typeof r.capitalLossCarryInStCents === "number" &&
      Number.isFinite(r.capitalLossCarryInStCents) &&
      r.capitalLossCarryInStCents >= 0
        ? Math.round(r.capitalLossCarryInStCents)
        : null,
    capitalLossCarryInLtCents:
      typeof r.capitalLossCarryInLtCents === "number" &&
      Number.isFinite(r.capitalLossCarryInLtCents) &&
      r.capitalLossCarryInLtCents >= 0
        ? Math.round(r.capitalLossCarryInLtCents)
        : null,
    // Itemized components (T5), read leniently like the
    // carryforwards above: absent on a pre-build record
    // reads as null = blank = $0 on that component. A stored
    // negative is not a deduction component and reads as
    // null too — the writers reject negatives at validation,
    // so one can only arrive in a hand-edited blob, where
    // blank is the honest read.
    itemizedMortgageInterestCents:
      typeof r.itemizedMortgageInterestCents === "number" &&
      Number.isFinite(r.itemizedMortgageInterestCents) &&
      r.itemizedMortgageInterestCents >= 0
        ? Math.round(r.itemizedMortgageInterestCents)
        : null,
    itemizedSaltPaidCents:
      typeof r.itemizedSaltPaidCents === "number" &&
      Number.isFinite(r.itemizedSaltPaidCents) &&
      r.itemizedSaltPaidCents >= 0
        ? Math.round(r.itemizedSaltPaidCents)
        : null,
    itemizedCharitableCents:
      typeof r.itemizedCharitableCents === "number" &&
      Number.isFinite(r.itemizedCharitableCents) &&
      r.itemizedCharitableCents >= 0
        ? Math.round(r.itemizedCharitableCents)
        : null,
    itemizedOtherCents:
      typeof r.itemizedOtherCents === "number" &&
      Number.isFinite(r.itemizedOtherCents) &&
      r.itemizedOtherCents >= 0
        ? Math.round(r.itemizedOtherCents)
        : null,
    // Education students (T6), read leniently like the basis
    // tiers above: keep the well-formed entries of a stored
    // array — an entry needs an integer calendar year,
    // non-negative integer expenses in cents, and a boolean
    // AOTC-eligibility mark — capped at 24; anything else
    // (absent, not an array, no well-formed entry) reads as
    // null = no expenses entered anywhere, so an untouched
    // record prices bit-identically to before.
    educationStudents: ((): {
      year: number;
      expensesCents: number;
      aotcEligible: boolean;
    }[] | null => {
      if (!Array.isArray(r.educationStudents)) return null;
      const students: {
        year: number;
        expensesCents: number;
        aotcEligible: boolean;
      }[] = [];
      for (const rawEntry of r.educationStudents as unknown[]) {
        if (rawEntry == null || typeof rawEntry !== "object") continue;
        const e = rawEntry as Record<string, unknown>;
        const year = num(e.year);
        const expensesCents = num(e.expensesCents);
        if (
          year == null ||
          !Number.isInteger(year) ||
          year < 1900 ||
          year > 2200 ||
          expensesCents == null ||
          expensesCents < 0 ||
          typeof e.aotcEligible !== "boolean"
        )
          continue;
        students.push({
          year,
          expensesCents: Math.round(expensesCents),
          aotcEligible: e.aotcEligible,
        });
        if (students.length >= 24) break;
      }
      return students.length > 0 ? students : null;
    })(),
    heirRatePct: num(r.heirRatePct),
    ceilings,
    optimizerGuardrail: bool(r.optimizerGuardrail),
    optimizerBunching: bool(r.optimizerBunching),
    gainsHarvest: bool(r.gainsHarvest),
    drawOrder:
      typeof r.drawOrder === "string" &&
      (DRAW_ORDER_KEYS as readonly string[]).includes(r.drawOrder)
        ? (r.drawOrder as (typeof DRAW_ORDER_KEYS)[number])
        : null,
    drawOrderSwitchAge: num(r.drawOrderSwitchAge),
    drawOrderAfter:
      typeof r.drawOrderAfter === "string" &&
      (DRAW_ORDER_KEYS as readonly string[]).includes(r.drawOrderAfter)
        ? (r.drawOrderAfter as (typeof DRAW_ORDER_KEYS)[number])
        : null,
    yearlySalaryCents: num(r.yearlySalaryCents),
    employer401kCents: num(r.employer401kCents),
    employerHsaCents: num(r.employerHsaCents),
  };
}

function parseRothScenarios(raw: unknown): RothScenario[] {
  if (!Array.isArray(raw)) return [];
  const out: RothScenario[] = [];
  for (const item of raw as unknown[]) {
    if (item == null || typeof item !== "object") continue;
    const parsed = parseRothInputs(item);
    if (!parsed) continue;
    const nameRaw = (item as Record<string, unknown>).name;
    out.push({
      name: typeof nameRaw === "string" && nameRaw !== "" ? nameRaw : "Scenario",
      ...parsed,
    });
    if (out.length >= ROTH_SCENARIO_LIMIT) break;
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readRothBlob(
  db: any,
  key: CryptoKey,
): Promise<{
  inputs: RothInputs | null;
  scenarios: RothScenario[];
  execution: RothExecutionResponse;
  mcVolatilityPct: number | null;
  gift: RothGiftStored;
  taxReturn: RothTaxReturnStored;
  // The record's write revision (lenient read — see
  // rothRevisionCore.ts): 0 for a blob written before revisions
  // existed, and for an absent or unreadable row.
  revision: number;
  revisionState: RothBlobRevisionState;
  // The stored raw value exactly as read (the ciphertext), or
  // undefined when no row exists. saveRothInputs' guarded
  // commit predicates on this value (API follow-on 1).
  storedRaw: string | undefined;
}> {
  const currentYear = new Date().getFullYear();
  const blankExecution: RothExecutionResponse = {
    ...consumeExecutionInputs(null, currentYear).execution,
    rolledOver: false,
    clearedYear: null,
  };
  const blankGift = { ...BLANK_ROTH_GIFT };
  const blankTaxReturn = { ...BLANK_ROTH_TAX_RETURN };
  const rows = await db.select().from(schema.settings);
  const raw = rows.find((r: { key: string }) => r.key === ROTH_INPUTS_KEY)?.value;
  if (!raw)
    return { inputs: null, scenarios: [], execution: blankExecution, mcVolatilityPct: null, gift: blankGift, taxReturn: blankTaxReturn, revision: 0, revisionState: { revision: 0, present: false, valid: true }, storedRaw: undefined };
  try {
    const plain = isEncrypted(raw) ? await decryptStr(key, raw) : raw;
    const parsed = JSON.parse(plain) as unknown;
    if (parsed == null || typeof parsed !== "object")
      // Result-honesty (contract v67, F08): a PRESENT record whose
      // document is not an object is present-but-invalid, not absent.
      return { inputs: null, scenarios: [], execution: blankExecution, mcVolatilityPct: null, gift: blankGift, taxReturn: blankTaxReturn, revision: 0, revisionState: { revision: 0, present: true, valid: false }, storedRaw: raw };
    const blob = parsed as Record<string, unknown>;
    // Execution inputs are consumed HERE, at load: a shape whose
    // year stamp is not the current calendar year comes back
    // blank (with the rollover reported), so a stale stamp can
    // never reach the panel or a pricing run.
    const consumed = consumeExecutionInputs(blob.inputs, currentYear);
    // The market-uncertainty check's volatility preference rides
    // along in the same record; parseRothInputs never sees it,
    // so it can never reach a pricing path.
    const inputsRec =
      blob.inputs != null && typeof blob.inputs === "object"
        ? (blob.inputs as Record<string, unknown>)
        : null;
    const mcVolRaw = inputsRec?.mcVolatilityPct;
    return {
      inputs: parseRothInputs(blob.inputs),
      scenarios: parseRothScenarios(blob.scenarios),
      execution: {
        ...consumed.execution,
        rolledOver: consumed.rolledOver,
        clearedYear: consumed.clearedYear,
      },
      mcVolatilityPct:
        typeof mcVolRaw === "number" && Number.isFinite(mcVolRaw) ? mcVolRaw : null,
      // The gift what-if block rides along in the same record;
      // parseRothInputs never sees it, so it can never reach a
      // pricing path other than the gift comparison itself.
      gift: parseRothGift(blob.inputs),
      // The tax-return actuals block rides along in the same
      // record; parseRothInputs never sees it, so it can never
      // reach a pricing path — its only consumer is the
      // Playground's "Start from my numbers" prefill.
      taxReturn: parseRothTaxReturn(blob.inputs),
      // The record's write revision: a sibling of `inputs` at
      // the blob's top level, read leniently (absent, non-integer,
      // or negative counts as 0) — parseRothInputs never sees it.
      revision: parseRothBlobRevision(plain),
      revisionState: rothBlobRevisionState(parsed),
      storedRaw: raw,
    };
  } catch {
    // Result-honesty (contract v67, F08): an unreadable PRESENT
    // record reports { present: true, valid: false } with the
    // stored bytes retained — decideRothBlobWriteChecked then
    // refuses every save against it, so the damaged record can
    // never be silently replaced by a fresh-looking one.
    return { inputs: null, scenarios: [], execution: blankExecution, mcVolatilityPct: null, gift: blankGift, taxReturn: blankTaxReturn, revision: 0, revisionState: { revision: 0, present: true, valid: false }, storedRaw: raw };
  }
}

/* The encrypted-blob records' commit paths (API
   follow-on 1 — see rothRevisionCore.ts for the contract).
   insertRothBlobValueIfAbsent is the Roth record's insert-only
   first write; commitSettingsValueGuarded is the atomic CAS
   commit, generalized by settings key (F23) so the Roth record
   and both Retirement records share the ONE statement: ONE
   UPDATE whose WHERE clause requires the row for
   `settingsKey` to still hold the raw value the writer read,
   branched on the affected-row count — true means exactly 1
   row committed; false means a concurrent write landed
   between the read and this commit and storage is untouched
   by this invocation. There is no unconditional upsert of the
   Roth record: saveRothInputs requires a CAS base on every
   call (decideRothBlobWriteChecked). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function insertRothBlobValueIfAbsent(db: any, enc: string): Promise<boolean> {
  const rows = await db
    .insert(schema.settings)
    .values({ key: ROTH_INPUTS_KEY, value: enc })
    .onConflictDoNothing()
    .returning({ key: schema.settings.key });
  return rows.length === 1;
}

/* The generalized insert-only first write for a settings-keyed
   blob (contract v64, A2): INSERT … ON CONFLICT DO NOTHING
   against the given settings key, branched on the returned row
   count — true means this invocation established the row; false
   means a row appeared between the caller's read and this
   commit and this invocation wrote nothing. The Retirement
   records' CAS writers (saveRetirementCalc /
   saveRetirementBaseline) use it for their first write when a
   baseRevision was supplied, mirroring saveRothInputs'
   rothFirstWritePlan insert-only outcome (audit F20). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function insertSettingsValueIfAbsent(db: any, settingsKey: string, enc: string): Promise<boolean> {
  const rows = await db
    .insert(schema.settings)
    .values({ key: settingsKey, value: enc })
    .onConflictDoNothing()
    .returning({ key: schema.settings.key });
  return rows.length === 1;
}

/* The Roth UI-state blob's insert-only first write (state
   audit fix 1): INSERT … ON CONFLICT DO NOTHING against the
   UI-state key, branched on the returned row count — true
   means this invocation established the row; false means a
   concurrent first write landed first and this invocation
   wrote nothing. Mirrors insertRothBlobValueIfAbsent and the
   testable mirror commitInsertOnlyRothUiWrite in
   rothUiStateCore.ts. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function insertRothUiStateValueIfAbsent(db: any, raw: string): Promise<boolean> {
  const rows = await db
    .insert(schema.settings)
    .values({ key: ROTH_UI_STATE_KEY, value: raw })
    .onConflictDoNothing()
    .returning({ key: schema.settings.key });
  return rows.length === 1;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function commitSettingsValueGuarded(
  db: any,
  settingsKey: string,
  storedRaw: string,
  enc: string,
): Promise<boolean> {
  const updated = await db
    .update(schema.settings)
    .set({ value: enc })
    .where(
      and(
        eq(schema.settings.key, settingsKey),
        eq(schema.settings.value, storedRaw),
      ),
    )
    .returning({ key: schema.settings.key });
  return updated.length === 1;
}

/* Raw blob access for the SCENARIO writers (save / delete / rename
   a scenario). Those writes must leave the saved inputs record
   exactly as it was — byte-identical, nulls included — so they
   never round-trip the inputs through parseRothInputs (which
   normalizes: missing keys become explicit nulls and the ceilings
   booleans coerce to false). Instead the inputs travel as the raw
   parsed JSON value from splitRothBlob to joinRothBlob untouched;
   only the scenarios array is parsed and rewritten. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readRothBlobRaw(
  db: any,
  key: CryptoKey,
): Promise<{
  inputsRaw: unknown;
  scenariosRaw: unknown;
  scenarios: RothScenario[];
  revision: number;
  storedRaw: string | undefined;
  // Result-honesty (contract v67, F08): false when a row EXISTS
  // but its document cannot be split (unparseable / not an
  // object) — the scenario writers must refuse rather than
  // compose a successor over the damaged bytes.
  valid: boolean;
}> {
  const rows = await db.select().from(schema.settings);
  const raw = rows.find((r: { key: string }) => r.key === ROTH_INPUTS_KEY)?.value;
  if (!raw)
    return { inputsRaw: null, scenariosRaw: [], scenarios: [], revision: 0, storedRaw: undefined, valid: true };
  try {
    const plain = isEncrypted(raw) ? await decryptStr(key, raw) : raw;
    const split = splitRothBlob(plain);
    if (!split)
      return { inputsRaw: null, scenariosRaw: [], scenarios: [], revision: 0, storedRaw: raw, valid: false };
    return {
      inputsRaw: split.inputsRaw,
      scenariosRaw: split.scenariosRaw,
      scenarios: parseRothScenarios(split.scenariosRaw),
      revision: rothBlobRevisionValue(split.revisionRaw),
      storedRaw: raw,
      valid: true,
    };
  } catch {
    return { inputsRaw: null, scenariosRaw: [], scenarios: [], revision: 0, storedRaw: raw, valid: false };
  }
}

/* One scenario write (API follow-on 1): apply the caller's
   name-keyed transform to the stored scenarios array and commit
   the result with the revision stamped stored + 1, through the
   guarded commit (see commitSettingsValueGuarded). The scenario
   writers take no baseRevision — discrete clicks, not autosaves
   — so instead of refusing on a lost race they re-read ONCE and
   re-apply the transform against the fresh blob (append /
   filter-by-name / map-by-name are safely re-appliable, and the
   transform's own validation — limit, duplicate name, missing
   name — re-runs against the fresh array). A second lost race
   returns the failure shape carrying the freshest scenarios and
   revision. A transform that declines to write (a validation
   failure) returns its verdict against the current array
   without touching storage. Either way the response carries
   the record's revision after the attempt, so the client can
   adopt the fresh base for its next plan save immediately. */
type RothScenarioTransform =
  | { write: true; ok: boolean; reason: string; scenarios: RothScenario[] }
  | { write: false; ok: boolean; reason: string };
type RothScenarioWriteResult = {
  ok: boolean;
  reason: string;
  scenarios: RothScenario[];
  revision: number;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function mutateRothScenarios(
  db: any,
  key: CryptoKey,
  transform: (scenarios: RothScenario[]) => RothScenarioTransform,
): Promise<RothScenarioWriteResult> {
  let blob = await readRothBlobRaw(db, key);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Result-honesty (contract v67, F08): a PRESENT but
    // unreadable record is never composed over.
    if (!blob.valid) {
      return {
        ok: false,
        reason:
          "Your saved Tax Plan record can't be read, so the strategies were not changed.",
        scenarios: blob.scenarios,
        revision: blob.revision,
      };
    }
    const t = transform(blob.scenarios);
    if (!t.write) {
      return { ok: t.ok, reason: t.reason, scenarios: blob.scenarios, revision: blob.revision };
    }
    const nextRevision = blob.revision + 1;
    const enc = await encryptStr(
      key,
      joinRothBlob(blob.inputsRaw, t.scenarios, nextRevision),
    );
    if (blob.storedRaw === undefined) {
      // No row yet: the first write establishes revision 1,
      // insert-only so a concurrent first write is not eaten.
      const inserted = await insertRothBlobValueIfAbsent(db, enc);
      if (inserted) {
        return { ok: t.ok, reason: t.reason, scenarios: t.scenarios, revision: nextRevision };
      }
      if (attempt === 0) {
        blob = await readRothBlobRaw(db, key);
        continue;
      }
      break;
    }
    if (await commitSettingsValueGuarded(db, ROTH_INPUTS_KEY, blob.storedRaw, enc)) {
      return { ok: t.ok, reason: t.reason, scenarios: t.scenarios, revision: nextRevision };
    }
    if (attempt === 0) {
      // A concurrent write landed between our read and commit:
      // re-read and re-apply the transform against the fresh blob.
      blob = await readRothBlobRaw(db, key);
    }
  }
  // A second lost race: report the freshest state we can read.
  const fresh = await readRothBlobRaw(db, key);
  return {
    ok: false,
    reason: "The saved strategies changed elsewhere — try again.",
    scenarios: fresh.scenarios,
    revision: fresh.revision,
  };
}

/* The seeded Roth plan record (fresh-user defaults), derived
   EXACTLY as the fresh-open seed derives it — the derivation
   itself is the ONE implementation in server/src/rothSeed.ts,
   shared with the client's fresh-open path; only the three
   Retirement-derived values are resolved here, from the same
   sources the client's seed reads through getRetirementCalc:
   the saved Retirement record (retirement age / expected
   return / stocks mix) and the trailing True-cost default
   spending (computeRetirementDefaults). Used ONLY by
   resetRothPlanner: a fresh open never persists a record
   server-side — the client seeds its form and its first
   autosave writes this same record. */
async function seedRothStoredInputs(
  ctx: Ctx,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  key: CryptoKey,
): Promise<RothStoredInputs> {
  const { defaultSpendingAnnualCents } = await computeRetirementDefaults(ctx, db, key);
  const retBlob = await readRetirementBlob(db, key);
  const retSaved = retBlob ? retirementInputsFromRecord(retBlob) : null;
  const seed = seedRothRecord(
    {
      annualSpendingCents: defaultSpendingAnnualCents,
      retirementAge: retSaved?.retirementAge ?? SEED_RETIREMENT_AGE_FALLBACK,
      expectedReturnPct:
        retSaved?.expectedReturnPct ??
        blendedExpected(retSaved?.stocksPct ?? STOCKS_PCT_DEFAULT),
    },
    new Date().getFullYear(),
  );
  return {
    ...seed.inputs,
    ...seed.execution,
    mcVolatilityPct: seed.mcVolatilityPct,
    ...seed.gift,
    ...seed.taxReturn,
  };
}

/* The stored Roth blob's commit state for the reset writer: the
   scenarios array as the RAW parsed JSON value (splitRothBlob's
   scenarios segment, untouched — the reset re-serializes it next
   to the reseeded inputs via joinRothBlob, so the saved
   scenarios pass through the reset byte-identical: same records,
   same order, same fields), the record's current revision, and
   the stored raw value the guarded commit predicates on. A
   missing or unreadable blob reads as an empty array at
   revision 0. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readRothBlobRawState(
  db: any,
  key: CryptoKey,
): Promise<{
  scenariosRaw: unknown;
  revision: number;
  storedRaw: string | undefined;
  // Result-honesty (contract v67, F08): false when a row EXISTS
  // but cannot be split — the reset writer refuses against it
  // instead of reseeding over the damaged bytes.
  valid: boolean;
}> {
  const rows = await db.select().from(schema.settings);
  const raw = rows.find((r: { key: string }) => r.key === ROTH_INPUTS_KEY)?.value;
  if (!raw) return { scenariosRaw: [], revision: 0, storedRaw: undefined, valid: true };
  try {
    const plain = isEncrypted(raw) ? await decryptStr(key, raw) : raw;
    const split = splitRothBlob(plain);
    if (!split) return { scenariosRaw: [], revision: 0, storedRaw: raw, valid: false };
    return {
      scenariosRaw: split.scenariosRaw,
      revision: rothBlobRevisionValue(split.revisionRaw),
      storedRaw: raw,
      valid: true,
    };
  } catch {
    return { scenariosRaw: [], revision: 0, storedRaw: raw, valid: false };
  }
}

/* ---------------- Roth view UI state ----------------
   The UI-state blob's schemas, defensive parse, and the
   revision/CAS write contract live in
   server/src/rothUiStateCore.ts — extracted so the accuracy
   fixtures can pin the CAS rules without importing this
   module. The getRothUiState / setRothUiState actions below
   are its only storage path. */

/* ---------------- Roth optimizer action shapes ----------------
   The optimizer runs server-side (a few hundred full lifetime
   simulations per scan, plus the two sensitivity re-runs) and
   returns only the scored summaries — the client re-runs the
   winner's parameters through the standard engine itself when it
   needs the year-by-year schedule. Money in these outputs is
   DOLLARS (the tax engine's units), unlike the stored inputs,
   which are cents. */
const optScoreOut = z.object({
  name: z.string(),
  windowLabel: z.string(),
  windowStopAge: z.number(),
  guardrail: z.boolean(),
  bunching: z.boolean(),
  // Gain harvesting (contract v56): the strategy's
  // gainsHarvest state — true for a harvest twin (its name
  // also carries the harvesting phrase), false otherwise,
  // including Do Nothing.
  gainsHarvest: z.boolean(),
  ceilings: z.object({
    bracketTopPct: z.number().nullable(),
    irmaaTierCap: z.number().nullable(),
    ltcgZeroCap: z.boolean(),
    acaCliffCap: z.boolean(),
    acaCliffCapFamilyOnly: z.boolean(),
    magiCapCents: z.number().nullable(),
    acaCliffBufferCents: z.number().nullable(),
  }),
  tax: z.number(),
  penalty: z.number(),
  irmaa: z.number(),
  acaCredit: z.number(),
  // Lifetime refundable education credit (T6, dollars): the
  // score component the net-cost identity subtracts beside
  // acaCredit. $0 for any plan with no entered education
  // expenses.
  educationRefundable: z.number(),
  // Lifetime AMT owed (T7, dollars): already inside `tax`
  // above — this line names the AMT component of the
  // lifetime tax. $0 for any plan whose tentative minimum
  // tax never exceeds its regular tax.
  amt: z.number(),
  terminal: z.number(),
  // Terminal split under a preserve reserve (dollars): the
  // preserved ending pre-tax and its tax at the reserve's exit
  // rate, and the excess and its tax at the heir rate. With no
  // reserve set, preserved is $0 and the excess is the whole
  // ending balance — the pre-reserve display.
  terminalPreserved: z.number(),
  preservedPretax: z.number(),
  terminalExcess: z.number(),
  excessPretax: z.number(),
  netCost: z.number(),
  // Lifetime Social Security collected under this candidate
  // (dollars) — display only; not part of the score.
  ssCollected: z.number(),
  savingVsDoNothing: z.number(),
  // Joint claiming-age search: the claiming ages this score was
  // priced at and the yearly benefits they imply (dollars). For
  // a spouse who was not searched these are the entered values.
  claimPrimaryAge: z.number().nullable(),
  claimSpouseAge: z.number().nullable(),
  ssPrimaryAnnual: z.number(),
  ssSpouseAnnual: z.number(),
  claimLabel: z.string(),
  // The spending draw order this score was priced under (the
  // engine's order key) and its plain-language label — part of
  // the recommendation, and stored on a scenario saved from the
  // score so the schedule reproduces exactly.
  drawOrder: z.string(),
  drawOrderLabel: z.string(),
});

function toOptScore(
  s: ScoredCandidate,
  doNothingNetCost: number,
): z.infer<typeof optScoreOut> {
  return {
    name: s.spec.name,
    windowLabel: s.spec.windowLabel,
    windowStopAge: s.spec.windowStopAge,
    guardrail: s.spec.guardrail,
    bunching: s.spec.bunching,
    gainsHarvest: s.spec.gainsHarvest ?? false,
    ceilings: {
      bracketTopPct: s.spec.ceilings.bracketTopPct,
      irmaaTierCap: s.spec.ceilings.irmaaTierCap,
      ltcgZeroCap: s.spec.ceilings.ltcgZeroCap,
      acaCliffCap: s.spec.ceilings.acaCliffCap,
      acaCliffCapFamilyOnly: s.spec.ceilings.acaCliffCapFamilyOnly,
      magiCapCents:
        s.spec.ceilings.magiCap == null ? null : Math.round(s.spec.ceilings.magiCap * 100),
      acaCliffBufferCents:
        s.spec.ceilings.acaCliffBuffer == null
          ? null
          : Math.round(s.spec.ceilings.acaCliffBuffer * 100),
    },
    tax: s.cost.tax,
    penalty: s.cost.penalty,
    irmaa: s.cost.irmaa,
    acaCredit: s.cost.acaCredit,
    educationRefundable: s.cost.educationRefundable,
    amt: s.cost.amt,
    terminal: s.cost.terminal,
    terminalPreserved: s.cost.terminalPreserved,
    preservedPretax: s.cost.preservedPretax,
    terminalExcess: s.cost.terminalExcess,
    excessPretax: s.cost.excessPretax,
    netCost: s.cost.netCost,
    ssCollected: s.cost.ssCollected,
    savingVsDoNothing:
      Math.round((doNothingNetCost - s.cost.netCost) * 100) / 100,
    claimPrimaryAge: s.claimAges.primaryAge,
    claimSpouseAge: s.claimAges.spouseAge,
    ssPrimaryAnnual: s.claimAges.primaryAnnual,
    ssSpouseAnnual: s.claimAges.spouseAnnual,
    claimLabel: claimAgeLabel(s.claimAges),
    drawOrder: drawOrderKey(s.spec.drawOrder),
    drawOrderLabel: drawOrderLabel(s.spec.drawOrder),
  };
}

/* ---------------- Roth market-uncertainty check shapes --------
   The check's request carries the two optimizer scores it
   re-prices (the winner and Do Nothing) in exactly the fields
   the client already holds from an optimizer score (the
   optScoreOut shape), plus the plan payload and the check's
   volatility. The handler rebuilds each candidate's spec and
   claiming ages from the payload — ceilings' MAGI cap converts
   cents back to dollars, the draw order resolves from its key —
   so the module prices precisely the strategies the optimizer
   scored. The doNothing slot is rebuilt with DO_NOTHING_SPEC's
   key, which is how the module knows to price it as Do Nothing. */
// mcScoreIn and its McScoreIn type live in
// server/src/apiContractCore.ts — extracted so the accuracy
// fixtures pin the exact tightened schema this action publishes.

function mcCandidateFromScore(
  score: McScoreIn,
  isDoNothing: boolean,
): { spec: OptimizerCandidateSpec; claimAges: ClaimAgeInfo } {
  const ceilings: FillCeilings = {
    bracketTopPct: score.ceilings.bracketTopPct,
    irmaaTierCap: score.ceilings.irmaaTierCap,
    ltcgZeroCap: score.ceilings.ltcgZeroCap,
    acaCliffCap: score.ceilings.acaCliffCap,
    acaCliffCapFamilyOnly: score.ceilings.acaCliffCapFamilyOnly === true,
    magiCap: score.ceilings.magiCapCents == null ? null : score.ceilings.magiCapCents / 100,
    acaCliffBuffer:
      score.ceilings.acaCliffBufferCents == null
        ? null
        : score.ceilings.acaCliffBufferCents / 100,
  };
  return {
    spec: {
      key: isDoNothing ? DO_NOTHING_SPEC.key : `mc-winner:${score.name}`,
      name: score.name,
      ceilings,
      windowStopAge: score.windowStopAge,
      windowKind: "throughRmd",
      windowLabel: "",
      guardrail: score.guardrail,
      bunching: score.bunching,
      gainsHarvest: score.gainsHarvest ?? false,
      drawOrder: drawOrderFromKey(score.drawOrder),
    },
    claimAges: {
      primaryAge: score.claimPrimaryAge,
      spouseAge: score.claimSpouseAge,
      primaryAnnual: score.ssPrimaryAnnual,
      spouseAnnual: score.ssSpouseAnnual,
      searchedPrimary: false,
      searchedSpouse: false,
    },
  };
}

/* ---------------- Engine-access shapes & helpers ----------------
   Compute-only access to the shipped engine (the engine-access
   build): runPlaygroundYear prices ONE standalone year through
   pricePlaygroundYear — the exact function the Playground tab
   prices with — and runPlanYearDetail prices one year of a plan
   plus its with/without-conversion two-pricing. Neither writes
   anything. The plan-level compute actions (optimizer, MC check,
   work-years, gift, plan-year detail) resolve null balance
   fields from the latest Net Worth snapshot server-side, per
   field, exactly as the client does (resolvePlanBalances in
   rothOptimizer.ts) — an explicitly-passed balance is used
   as-is, so a caller can no longer price a degenerate $0 plan
   by passing the saved record's blank balances. */

// The latest snapshot's bucket subtotals (cents), or null when
// there is no snapshot. Same computation getRothPlanner serves.
async function latestSnapshotSubtotals(ctx: Ctx) {
  const db = ctx.db<typeof schema>();
  const key = await getCryptoKey(ctx);
  const nw = await loadNetWorthDecrypted(ctx, db, key);
  const latest = nw.snapshots.length
    ? nw.snapshots[nw.snapshots.length - 1]!
    : null;
  if (!latest) return null;
  const rows = nw.balances.filter((b) => b.snapshotId === latest.id);
  const classById = classByIdOf(nw.accounts);
  const sub = bucketSubtotals(rows, classById);
  return {
    pretaxCents: sub["Pre-tax"],
    rothCents: sub.Roth,
    taxableCents: sub.Taxable,
    cashCents: sub.Cash,
    hsaCents: sub.HSA,
  };
}

// Resolve a plan payload's null balances from the latest
// snapshot. Fast path: every balance present → the payload is
// returned untouched and the snapshot is never loaded.
// SPEND-FROM-CASH sleeve threading (the same snapshot path):
// the sleeve size is not a saved field — when the payload's
// taxable balance FOLLOWS the snapshot (taxableCents null)
// and the caller did not supply a sleeve explicitly, the
// snapshot's Cash bucket subtotal is threaded onto the
// resolved payload as spendFromCashSleeveCents, so the engine
// prices the sleeve that is actually inside the folded pool.
// An explicit taxableCents (no snapshot context for the pool)
// leaves the sleeve exactly as supplied — absent = $0 cash,
// pricing identical to spendFromCashPct blank.
// EXCLUDE-FROM-PLAN sleeve rule (single pool): when an
// exclusion applies on this same followed path, it is taken
// out of the cash sleeve FIRST — the threaded sleeve is the
// Cash bucket minus the exclusion, floored at $0 — so excluded
// money can never be spent as sleeve cash; any exclusion
// beyond the Cash bucket reduces the invested part of the
// pool through resolvePlanBalances itself. (In tiers mode the
// engine derives the sleeve from the reduced pool's cash
// tier, so the tier shares rule applies there instead.)
async function resolveArgsBalances<T extends {
  pretaxCents: number | null;
  pretaxSpouseCents: number | null;
  rothCents: number | null;
  taxableCents: number | null;
  taxableExcludeCents?: number | null;
  hsaCents: number | null;
  spendFromCashSleeveCents?: number | null;
}>(ctx: Ctx, args: T): Promise<T> {
  if (
    args.pretaxCents != null &&
    args.rothCents != null &&
    args.taxableCents != null &&
    args.hsaCents != null
  ) {
    return args;
  }
  const snap = await latestSnapshotSubtotals(ctx);
  const resolved = resolvePlanBalances(args, snap);
  if (args.spendFromCashSleeveCents == null && args.taxableCents == null) {
    const excludeCents = Math.max(0, args.taxableExcludeCents ?? 0);
    resolved.spendFromCashSleeveCents =
      snap?.cashCents == null
        ? null
        : Math.max(0, snap.cashCents - excludeCents);
  }
  return resolved;
}

// The strategy the planner runs for a payload: its saved
// ceilings (all-off = Do Nothing, priced with no ceilings),
// with the optimizer variant flags carried as the client
// carries them on its current strategy.
function strategyFromSavedArgs(args: {
  ceilings: z.infer<typeof rothCeilings> | null;
  optimizerGuardrail?: boolean | null;
  optimizerBunching?: boolean | null;
  gainsHarvest?: boolean | null;
}): RothStrategy {
  const c = args.ceilings;
  const anyCeiling =
    c != null &&
    (c.bracketTopPct != null ||
      c.irmaaTierCap != null ||
      c.ltcgZeroCap ||
      c.acaCliffCap ||
      c.magiCapCents != null);
  const ceilings: FillCeilings | null = anyCeiling
    ? {
        bracketTopPct: c.bracketTopPct,
        irmaaTierCap: c.irmaaTierCap,
        ltcgZeroCap: c.ltcgZeroCap,
        acaCliffCap: c.acaCliffCap,
        acaCliffCapFamilyOnly: c.acaCliffCapFamilyOnly === true,
        magiCap: c.magiCapCents == null ? null : c.magiCapCents / 100,
        acaCliffBuffer:
          c.acaCliffBufferCents == null ? null : c.acaCliffBufferCents / 100,
      }
    : null;
  return {
    id: "current",
    name: "Your fill settings",
    ceilings,
    guardrail: args.optimizerGuardrail ?? false,
    bunching: args.optimizerBunching ?? false,
    gainsHarvest: args.gainsHarvest ?? false,
  };
}

// playgroundYearIn lives in server/src/apiContractCore.ts —
// extracted so the accuracy fixtures pin the exact tightened
// schema this action publishes.

const bracketLayerOut = z.object({
  ratePct: z.number(),
  from: z.number(),
  to: z.number().nullable(),
  amount: z.number(),
  tax: z.number(),
});

const playgroundYearOut = z.object({
  interest: z.number(),
  ordinaryDividends: z.number(),
  nonQualifiedDividends: z.number(),
  otherOrdinary: z.number(),
  otherOrdinaryTotal: z.number(),
  rmdPriced: z.boolean(),
  rmd: z.number(),
  rmdGross: z.number(),
  rmdPrimary: z.number(),
  rmdSpouse: z.number(),
  rmdAlreadyReceived: z.number(),
  dependentMagiForAca: z.number(),
  rmdDivisor: z.number().nullable(),
  rmdTable: z.enum(["joint", "uniform"]).nullable(),
  ssBenefits: z.number(),
  ssTaxable: z.number(),
  ssPctTaxed: z.number(),
  taxExemptInterest: z.number(),
  conversion: z.number(),
  stockGain: z.number(),
  qualifiedDividends: z.number(),
  ltcgNet: z.number(),
  ltcgPriced: z.number(),
  capitalLoss: z.number(),
  capitalLossAllowance: z.number(),
  agi: z.number(),
  magi: z.number(),
  acaMagi: z.number(),
  baseStandardDeduction: z.number(),
  age65AddonTotal: z.number(),
  count65: z.number(),
  standardDeduction: z.number(),
  seniorDeduction: z.number(),
  // Itemized deduction (T5; $0 unless itemized amounts are
  // typed): the itemized total after the §164(b)(7) SALT
  // cap, the SALT amount allowed after that cap, and which
  // side of the greater-of comparison the year took.
  itemizedDeduction: z.number(),
  itemizedSaltAllowed: z.number(),
  deductionTaken: z.enum(["standard", "itemized"]),
  // 2026 deduction trio: the charitable amount allowed
  // inside the itemized total after the §170(b)(1)(I)
  // floor, the §68 reduction, and the §170(p) non-itemizer
  // charitable deduction applied below the line
  // (§63(b)(4): inside deductions as part of the standard
  // side; agi / magi / acaMagi are NOT reduced by it).
  // All $0 under the 2025 law row.
  itemizedCharitableAllowed: z.number(),
  section68Reduction: z.number(),
  nonItemizerCharitableDeduction: z.number(),
  // Education credits (T6; $0 / "none" unless students are
  // entered): the tentative AOTC and Lifetime Learning
  // Credit after their phase-outs, the choice taken, the
  // nonrefundable portion applied (inside federalTax), and
  // the refundable AOTC portion (reported separately; NOT
  // inside federalTax or totalTax).
  educationAotc: z.number(),
  educationLlc: z.number(),
  educationChoice: z.enum(["aotc", "llc", "none"]),
  educationNonrefundable: z.number(),
  educationRefundable: z.number(),
  // Alternative minimum tax (T7): AMTI, the §55(d)
  // exemption after its phase-out, the tentative minimum
  // tax, and the AMT owed (inside federalTax / totalTax).
  amti: z.number(),
  amtExemption: z.number(),
  amtTentativeTax: z.number(),
  amtOwed: z.number(),
  deductions: z.number(),
  taxableIncome: z.number(),
  ordinaryTaxableIncome: z.number(),
  gainsInTaxableIncome: z.number(),
  bracketLayers: z.array(bracketLayerOut),
  gainsAt0: z.number(),
  gainsAt15: z.number(),
  gainsAt20: z.number(),
  gainsZeroRoomLeft: z.number(),
  ordinaryTax: z.number(),
  ltcgTax: z.number(),
  niit: z.number(),
  federalTax: z.number(),
  stateTax: z.number(),
  // Washington excise breakdown (T3; $0 unless the year's
  // residence is Washington).
  waGains: z.number(),
  waStandardDeduction: z.number(),
  waTaxableGains: z.number(),
  totalTax: z.number(),
  landingBracketPct: z.number().nullable(),
  landingBracketTop: z.number().nullable(),
  landingRoomLeft: z.number().nullable(),
  landingExactlyFilled: z.boolean(),
  conversionFederalCost: z.number(),
  conversionTotalCost: z.number(),
  conversionExceedsBalance: z.boolean(),
  aca: z.object({
    applies: z.boolean(),
    everyoneOnMedicare: z.boolean(),
    householdSize: z.number().nullable(),
    fpl: z.number().nullable(),
    cliff: z.number().nullable(),
    pctFpl: z.number().nullable(),
    overCliff: z.boolean(),
    positionDollars: z.number().nullable(),
    credit: z.number().nullable(),
    applicablePct: z.number().nullable(),
  }),
  irmaa: z.object({
    applies: z.boolean(),
    personsOnMedicare: z.number(),
    tier: z.number(),
    premiumYear: z.number(),
    monthlyPerPerson: z.number(),
    annualPerPerson: z.number(),
    annualHousehold: z.number(),
    nextTierLine: z.number().nullable(),
    roomToNextTier: z.number().nullable(),
  }),
  gainsFlags: z.object({
    gainsStack: z.number(),
    hasGainsTyped: z.boolean(),
    withoutMagi: z.number(),
    withoutAcaMagi: z.number(),
    withoutTier: z.number(),
    acaFlag: z
      .object({
        kind: z.enum(["flipped-over", "flipped-under", "credit-changed"]),
        gainsStack: z.number(),
        typedOverCliff: z.boolean(),
        withoutOverCliff: z.boolean(),
        typedPositionDollars: z.number().nullable(),
        withoutPositionDollars: z.number().nullable(),
        typedCredit: z.number().nullable(),
        withoutCredit: z.number().nullable(),
        withoutAcaMagi: z.number(),
        text: z.string(),
      })
      .nullable(),
    irmaaFlag: z
      .object({
        kind: z.enum(["tier-up", "tier-down"]),
        gainsStack: z.number(),
        typedTier: z.number(),
        withoutTier: z.number(),
        premiumYear: z.number(),
        line: z.number().nullable(),
        text: z.string(),
      })
      .nullable(),
  }),
  saleAfterTax: z
    .object({
      proceeds: z.number(),
      totalTax: z.number(),
      leftover: z.number(),
      text: z.string(),
    })
    .nullable(),
});

/* The December projection's priced result (decemberCore's
   computeDecemberProjection), published by runDecemberProjection
   and computed identically in the December view. */
const decemberCaseOut = z.object({
  kind: z.enum(["low", "likely", "high"]),
  nonDrawAcaMagi: z.number(),
  maxDraw: z.number().nullable(),
  magiAtHeadline: z.number(),
  distanceAtHeadline: z.number().nullable(),
  overCliffAtHeadline: z.boolean(),
  overCliffEvenAtZero: z.boolean(),
  creditAtHeadline: z.number().nullable(),
  excessAptcRepayment: z.number().nullable(),
  creditStillDue: z.number().nullable(),
  repaymentExposure: z.number(),
  federalTaxAtHeadline: z.number(),
  totalTaxAtHeadline: z.number(),
  totalIncomeAtHeadline: z.number(),
  taxableIncomeAtHeadline: z.number(),
  stateTaxAtHeadline: z.number(),
  netSettleAtHeadline: z.number().nullable(),
  netSettleNote: z.string().nullable(),
});
const decemberProjectionOut = z.object({
  priced: z.boolean(),
  reason: z.string().nullable(),
  cliff: z.number().nullable(),
  targetMagi: z.number().nullable(),
  headlineDraw: z.number().nullable(),
  headlineText: z.string(),
  zeroDrawOverCliff: z.boolean(),
  cases: z.array(decemberCaseOut),
  warnings: z.array(z.string()),
});

/* The December console's get / save responses, hoisted so the
   handlers annotate against them (a returned `ok: true`
   widens to boolean unless the handler's return type pins
   the literal). The save response is the compare-and-swap
   union: success carries the new revision; a conflict carries
   the stored revision and the stored state so the client
   reloads it instead of overwriting it. */
const getDecemberProjectionResponse = z.object({
  state: decemberState,
  hasStored: z.boolean(),
  revision: z.number(),
  // Result-honesty flag (contract v67, F09): true when a blob
  // IS stored (hasStored) but cannot be parsed as a state
  // document — state then carries the factory defaults the
  // lenient parse falls back to, and this flag is the only
  // thing distinguishing that from a genuinely fresh console.
  storedUnreadable: z.boolean(),
});

const saveDecemberProjectionResponse = z.union([
  z.object({ ok: z.literal(true), revision: z.number() }),
  z.object({
    ok: z.literal(false),
    conflict: z.literal(true),
    revision: z.number(),
    state: decemberState,
    hasStored: z.boolean(),
    // Result-honesty flag (contract v67, F09): true when this
    // refusal is because the stored record cannot be parsed —
    // an unparseable stored record is a conflict, never a
    // revision-0 base the save may build on.
    storedUnreadable: z.boolean(),
  }),
]);

const playgroundPasteOut = z.object({
  kind: z.string(),
  version: z.number(),
  taxYear: z.number(),
  filingStatus: z.string(),
  agePrimary: z.number(),
  ageSpouse: z.number().nullable(),
  onMedicarePrimary: z.boolean(),
  onMedicareSpouse: z.boolean(),
  interest: z.number(),
  ordinaryDividends: z.number(),
  otherOrdinary: z.number(),
  taxExemptInterest: z.number(),
  ssPrimary: z.number(),
  ssSpouse: z.number(),
  conversion: z.number(),
  stockSold: z.number(),
  stockBasis: z.number(),
  qualifiedDividends: z.number(),
  pretaxBalance: z.number().nullable(),
  spouseSoleBeneficiary: z.boolean(),
  acaHouseholdSize: z.number().nullable(),
  acaBenchmarkAnnual: z.number().nullable(),
  stateRatePct: z.number(),
  // Cold-AI audit fix: the paste payload carries the state
  // of residence and the year's education students, so
  // replaying a paste reprices the same state layer and the
  // same §25A credits instead of silently dropping them.
  residenceState: z.enum(["WA", "other"]).nullable(),
  educationStudents: z
    .array(
      z.object({
        expenses: z.number(),
        aotcEligible: z.boolean(),
      }),
    )
    .nullable(),
});

const planYearRowOut = z.object({
  year: z.number(),
  agePrimary: z.number(),
  ageSpouse: z.number().nullable(),
  conversion: z.number(),
  // Gain harvested into the 0% capital-gains space after the
  // year's draws and conversions settled (dollars; $0 unless
  // the plan's gainsHarvest toggle is on and space remained).
  gainsHarvested: z.number(),
  rmdPrimary: z.number(),
  rmdSpouse: z.number(),
  rmd: z.number(),
  ssBenefits: z.number(),
  ssTaxable: z.number(),
  deductions: z.number(),
  federalTax: z.number(),
  stateTax: z.number(),
  // Washington excise surfacing (T3): the year's WA-allocated
  // gains entering the excise base, its standard deduction,
  // and the taxable Washington capital gains after
  // deductions — so a $0 state-tax year shows why. All $0 on
  // the flat-rate path.
  waGains: z.number(),
  waStandardDeduction: z.number(),
  waTaxableGains: z.number(),
  // Capital-loss carryforward ledger (T4): the loss carried
  // into the year by character, the part this year's gains
  // absorbed, the §1211(b) allowance priced against ordinary
  // income, and the loss carried out into the next year by
  // character (dollars, like every money figure in this
  // row). All $0 in every year of a plan with no entering
  // carryforward.
  lossCarryInSt: z.number(),
  lossCarryInLt: z.number(),
  lossAbsorbed: z.number(),
  lossAllowance: z.number(),
  lossCarryOutSt: z.number(),
  lossCarryOutLt: z.number(),
  // Itemized-vs-standard (T5): the year's itemized total
  // after the §164(b)(7) SALT cap (dollars, like every
  // money figure in this row) and which side of the
  // greater-of comparison the year's deduction took. $0 /
  // "standard" in every year of a plan with no itemized
  // inputs.
  itemizedDeduction: z.number(),
  deductionTaken: z.enum(["standard", "itemized"]),
  // 2026 deduction trio (dollars, like every money figure
  // in this row): the charitable amount allowed inside the
  // itemized total after the §170(b)(1)(I) floor, the §68
  // reduction, and the §170(p) non-itemizer charitable
  // deduction applied below the line (§63(b)(4): inside
  // deductions as part of the standard side; the row's
  // magi / acaMagi are NOT reduced by it). All $0 in
  // every year priced under the 2025 law row.
  itemizedCharitableAllowed: z.number(),
  section68Reduction: z.number(),
  nonItemizerCharitableDeduction: z.number(),
  // Education credits (T6): the year's §25A credits under
  // the winning allocation (dollars, like every money
  // figure in this row) — the tentative AOTC and Lifetime
  // Learning Credit after their phase-outs, the choice
  // taken, the nonrefundable portion applied (inside
  // federalTax above), and the refundable AOTC portion
  // (NOT inside federalTax; the plan score credits it).
  // All $0 / "none" in every year with no entered
  // expenses.
  educationAotc: z.number(),
  educationLlc: z.number(),
  educationChoice: z.enum(["aotc", "llc", "none"]),
  educationNonrefundable: z.number(),
  educationRefundable: z.number(),
  // Alternative minimum tax (T7): the year's AMTI, the
  // §55(d) exemption after its phase-out, the tentative
  // minimum tax, and the AMT owed (dollars; inside
  // federalTax above). amtOwed is $0 in every year whose
  // tentative tax does not exceed its regular tax.
  amti: z.number(),
  amtExemption: z.number(),
  amtTentativeTax: z.number(),
  amtOwed: z.number(),
  penalty: z.number(),
  acaCreditKept: z.number(),
  acaPriced: z.boolean(),
  irmaaPaid: z.number(),
  irmaaTierSet: z.number(),
  magi: z.number(),
  acaMagi: z.number(),
  taxableIncome: z.number(),
  bracketPct: z.number(),
  effectiveMarginalPct: z.number().nullable(),
  endingPretax: z.number(),
  endingRoth: z.number(),
  endingTaxable: z.number(),
  endingHsa: z.number(),
  // BASIS-DRIFT surfacing: the year's ending taxable basis
  // (the basis-dollars ledger at year end — the starting %'s
  // dollars after the year's draws carried their pro-rata
  // share out, after-tax inflows and any harvest step-up came
  // in, and no growth) and the year's realized gain from
  // ordinary draws (tax payments from Taxable plus spending
  // draws). Like every money figure in this row the VALUES
  // are dollars (the plan-year response convention), so the
  // names carry no Cents suffix — a Cents suffix in this row
  // would claim cents the values do not hold.
  endingTaxableBasis: z.number(),
  drawGains: z.number(),
  // TAXABLE YIELDS surfacing: the year's priced dividend and
  // interest income (dollars) — the yield % of the year's
  // starting taxable balance, already inside the row's magi /
  // acaMagi / tax figures (dividends on the gains stack,
  // interest on the ordinary stack). $0 when no yield is
  // modeled.
  dividendIncome: z.number(),
  interestIncome: z.number(),
  // SPEND-FROM-CASH surfacing: the year's cash-paid spending
  // (dollars) — the spendFromCashPct share of the year's
  // spending need paid from the cash sleeve (no income, no
  // gains, no MAGI) — and the sleeve's balance at year end.
  // Both $0 when spendFromCashPct is blank / 0 (off).
  cashSpend: z.number(),
  cashSleeveEnd: z.number(),
  // SPEND SHORTFALL surfacing (FIX 3): the year's unfunded
  // spending (dollars) — the spending need left after cash
  // income, the tax channels' prior claim on balances, the
  // cash sleeve, and the draw-order draws, measured on the
  // final settlement. Spending only (unpaid tax is a
  // different quantity). $0 when the year funds in full.
  spendShortfall: z.number(),
  // UNPAID TAX surfacing (round-5 fix 1): the year's priced
  // tax the balances could not pay (dollars) — the part of
  // the assessed federal/state tax, penalty, and IRMAA the
  // debit chain (Taxable → Pre-tax → Roth) could not cover.
  // The tax fields above carry the full assessed liability;
  // this is the unpaid remainder. $0 when the year pays in
  // full.
  unpaidTax: z.number(),
  // SETTLEMENT CONVERGENCE surfacing (LOW-1): whether the
  // year's kept settlement was an exact fixed point of the
  // settlement iteration (assumed feedback pair == created
  // pair), and the kept round's residual mismatch per
  // component in integer cents (both 0 when converged). A
  // non-converged year was priced from the iteration's best
  // iterated state, not an exact fixed point.
  settlementConverged: z.boolean(),
  settlementMismatchCents: z.object({
    gains: z.number(),
    pretax: z.number(),
  }),
  // Ceiling breached (round-7 R7-4): the year's final priced
  // figures still exceed a switched-on ceiling at conversion
  // $0 (see the ceilingBreachedSemantics convention).
  ceilingBreached: z.boolean(),
});

function toPlanYearRow(y: {
  year: number;
  agePrimary: number;
  ageSpouse: number | null;
  conversion: number;
  gainsHarvested: number;
  rmd: number;
  ssBenefits: number;
  federalTax: number;
  stateTax: number;
  penalty: number;
  educationRefundable: number;
  acaCreditKept: number;
  acaPriced: boolean;
  irmaaPaid: number;
  irmaaTierSet: number;
  magi: number;
  acaMagi: number;
  taxableIncome: number;
  bracketPct: number;
  effectiveMarginalPct: number | null;
  pretaxEnd: number;
  rothEnd: number;
  taxableEnd: number;
  hsaEnd: number;
  spendShortfall: number;
  unpaidTax: number;
  detail: {
    rmdPrimary: number;
    rmdSpouse: number;
    ssTaxable: number;
    deductions: number;
    waGains: number;
    waStandardDeduction: number;
    waTaxableGains: number;
    lossCarryInSt: number;
    lossCarryInLt: number;
    lossAbsorbed: number;
    lossAllowance: number;
    lossCarryOutSt: number;
    lossCarryOutLt: number;
    itemizedDeduction: number;
    deductionTaken: "standard" | "itemized";
    itemizedCharitableAllowed: number;
    section68Reduction: number;
    nonItemizerCharitableDeduction: number;
    educationAotc: number;
    educationLlc: number;
    educationChoice: "aotc" | "llc" | "none";
    educationNonrefundable: number;
    amti: number;
    amtExemption: number;
    amtTentativeTax: number;
    amtOwed: number;
    taxableBasisDollars: number;
    drawGains: number;
    dividendIncome: number;
    interestIncome: number;
    cashSpend: number;
    cashSleeveEnd: number;
  };
  settlementConverged: boolean;
  settlementMismatchCents: { gains: number; pretax: number };
  ceilingBreached: boolean;
}): z.infer<typeof planYearRowOut> {
  return {
    year: y.year,
    agePrimary: y.agePrimary,
    ageSpouse: y.ageSpouse,
    conversion: y.conversion,
    gainsHarvested: y.gainsHarvested,
    rmdPrimary: y.detail.rmdPrimary,
    rmdSpouse: y.detail.rmdSpouse,
    rmd: y.rmd,
    ssBenefits: y.ssBenefits,
    ssTaxable: y.detail.ssTaxable,
    deductions: y.detail.deductions,
    federalTax: y.federalTax,
    stateTax: y.stateTax,
    waGains: y.detail.waGains,
    waStandardDeduction: y.detail.waStandardDeduction,
    waTaxableGains: y.detail.waTaxableGains,
    lossCarryInSt: y.detail.lossCarryInSt,
    lossCarryInLt: y.detail.lossCarryInLt,
    lossAbsorbed: y.detail.lossAbsorbed,
    lossAllowance: y.detail.lossAllowance,
    lossCarryOutSt: y.detail.lossCarryOutSt,
    lossCarryOutLt: y.detail.lossCarryOutLt,
    itemizedDeduction: y.detail.itemizedDeduction,
    deductionTaken: y.detail.deductionTaken,
    itemizedCharitableAllowed: y.detail.itemizedCharitableAllowed,
    section68Reduction: y.detail.section68Reduction,
    nonItemizerCharitableDeduction: y.detail.nonItemizerCharitableDeduction,
    educationAotc: y.detail.educationAotc,
    educationLlc: y.detail.educationLlc,
    educationChoice: y.detail.educationChoice,
    educationNonrefundable: y.detail.educationNonrefundable,
    educationRefundable: y.educationRefundable,
    amti: y.detail.amti,
    amtExemption: y.detail.amtExemption,
    amtTentativeTax: y.detail.amtTentativeTax,
    amtOwed: y.detail.amtOwed,
    penalty: y.penalty,
    acaCreditKept: y.acaCreditKept,
    acaPriced: y.acaPriced,
    irmaaPaid: y.irmaaPaid,
    irmaaTierSet: y.irmaaTierSet,
    magi: y.magi,
    acaMagi: y.acaMagi,
    taxableIncome: y.taxableIncome,
    bracketPct: y.bracketPct,
    effectiveMarginalPct: y.effectiveMarginalPct,
    endingPretax: y.pretaxEnd,
    endingRoth: y.rothEnd,
    endingTaxable: y.taxableEnd,
    endingHsa: y.hsaEnd,
    endingTaxableBasis: y.detail.taxableBasisDollars,
    drawGains: y.detail.drawGains,
    dividendIncome: y.detail.dividendIncome,
    interestIncome: y.detail.interestIncome,
    cashSpend: y.detail.cashSpend,
    cashSleeveEnd: y.detail.cashSleeveEnd,
    spendShortfall: y.spendShortfall,
    unpaidTax: y.unpaidTax,
    settlementConverged: y.settlementConverged,
    settlementMismatchCents: y.settlementMismatchCents,
    ceilingBreached: y.ceilingBreached,
  };
}

/* ---------------- Year-funding row (runRothFunding) ----------
   One row per priced year of the plan, all money in integer
   cents (the runRothCompare convention — the field names carry
   the Cents suffix because the values ARE cents). The row type
   is RothFundingRow in rothOptimizer.ts; the action's purpose
   entry in ACTION_PURPOSES defines every field's sign/scope. */
const fundingRowOut = z.object({
  year: z.number(),
  agePrimary: z.number(),
  ageSpouse: z.number().nullable(),
  spendingCents: z.number(),
  federalTaxCents: z.number(),
  stateTaxCents: z.number(),
  irmaaCents: z.number(),
  totalNeedCents: z.number(),
  ssCents: z.number(),
  rmdCents: z.number(),
  otherIncomeCents: z.number(),
  interestYieldCents: z.number(),
  dividendYieldCents: z.number(),
  pretaxDrawCents: z.number(),
  taxableSoldForSpendingCents: z.number(),
  taxableSoldForTaxCents: z.number(),
  cashSpendCents: z.number(),
  rothDrawCents: z.number(),
  salarySurplusCents: z.number(),
  // Spend shortfall (FIX 3): the year's unfunded spending in
  // integer cents — not a source; the eleven sources plus
  // spendShortfallCents foot to totalNeedCents. $0 in every
  // year the plan can fund.
  spendShortfallCents: z.number(),
  // Unpaid tax (round-5 fix 1): the year's priced tax the
  // balances could not pay, in integer cents — not a source
  // either; the eleven sources plus spendShortfallCents plus
  // unpaidTaxCents foot to totalNeedCents. $0 in every year
  // whose balances cover the tax bill.
  unpaidTaxCents: z.number(),
  conversionCents: z.number(),
  harvestSoldCents: z.number(),
  magiCents: z.number(),
  acaMagiCents: z.number(),
  acaCliffCents: z.number().nullable(),
  acaCreditCents: z.number(),
  acaPriced: z.boolean(),
  taxableIncomeCents: z.number(),
  bracketPct: z.number(),
  drawGainsCents: z.number(),
  ssTaxableCents: z.number(),
  // Settlement convergence (LOW-1): whether the year's kept
  // settlement was an exact fixed point of the settlement
  // iteration, and the kept round's residual mismatch per
  // component in integer cents (both 0 when converged).
  settlementConverged: z.boolean(),
  settlementMismatchCents: z.object({
    gains: z.number(),
    pretax: z.number(),
  }),
  // Ceiling breached (round-7 R7-4): true when a switched-on
  // ceiling is still breached by the year's final priced
  // figures at conversion $0 — the draws alone breach (see
  // the ceilingBreachedSemantics convention describeApi
  // publishes). False when no ceiling is on or the year
  // complies.
  ceilingBreached: z.boolean(),
  // Capital-loss carryforward ledger (T4): the loss carried
  // into the year by character, the part this year's gains
  // absorbed, the §1211(b) allowance priced, and the loss
  // carried out into the next year by character (integer
  // cents, like every money figure in this row). All 0 in
  // every year of a plan with no entering carryforward.
  lossCarryInStCents: z.number(),
  lossCarryInLtCents: z.number(),
  lossAbsorbedCents: z.number(),
  lossAllowanceCents: z.number(),
  lossCarryOutStCents: z.number(),
  lossCarryOutLtCents: z.number(),
  // Itemized-vs-standard (T5): the year's itemized total
  // after the §164(b)(7) SALT cap (integer cents, like
  // every money figure in this row) and which side of the
  // greater-of comparison the year's deduction took. 0 /
  // "standard" in every year of a plan with no itemized
  // inputs.
  itemizedDeductionCents: z.number(),
  deductionTaken: z.enum(["standard", "itemized"]),
  // 2026 deduction trio (integer cents, like every money
  // figure in this row): the charitable amount allowed
  // inside the itemized total after the §170(b)(1)(I)
  // floor, the §68 reduction, and the §170(p) non-itemizer
  // charitable deduction applied below the line
  // (§63(b)(4): inside the deductions figure; the row's
  // magiCents / acaMagiCents are NOT reduced by it; never
  // a funding source or
  // need). All 0 under the 2025 law row.
  itemizedCharitableAllowedCents: z.number(),
  section68ReductionCents: z.number(),
  nonItemizerCharitableDeductionCents: z.number(),
  // Education credits (T6): the year's refundable AOTC
  // portion, the tentative AOTC and Lifetime Learning
  // Credit after their phase-outs, the nonrefundable
  // portion applied (inside federalTaxCents — the year's
  // federal need is net of it), and the choice taken
  // (integer cents, like every money figure in this row).
  // The refundable portion is a credit the score counts,
  // not a funding source or need — it never enters the
  // cash identity. It is not lost cash, though (Build D):
  // the march deposits it into the taxable pool at 100%
  // basis at the start of the FOLLOWING year, so it raises
  // that year's opening balance (and a final year's portion
  // is inside the ending taxable balance) rather than
  // appearing as a source on any year's row. All 0 / "none"
  // in every year with no entered expenses.
  educationRefundableCents: z.number(),
  educationAotcCents: z.number(),
  educationLlcCents: z.number(),
  educationNonrefundableCents: z.number(),
  educationChoice: z.enum(["aotc", "llc", "none"]),
  // Alternative minimum tax (T7): the year's AMTI, the
  // §55(d) exemption after its phase-out, the tentative
  // minimum tax, and the AMT owed (integer cents, like
  // every money figure in this row). The owed amount is
  // inside federalTaxCents — the year's federal need
  // includes it — so these lines name the component and
  // never enter the cash identity a second time.
  // amtOwedCents is 0 in every year with no AMT exposure.
  amtiCents: z.number(),
  amtExemptionCents: z.number(),
  amtTentativeTaxCents: z.number(),
  amtOwedCents: z.number(),
});

/* ---------------- Work-years compare shapes ----------------
   The Work years tab's run is compute-only: the request is the
   saved-plan-shaped inputs (rothInputFields, which now carry
   the three job fields) plus up to three scratch quit ages
   that are never persisted. Money in these outputs is DOLLARS
   (the tax engine's units), like the optimizer outputs. */
const workYearsLedgerOut = z.object({
  grossSalary: z.number(),
  federal: z.number(),
  state: z.number(),
  fica: z.number(),
  // Payroll tax as its own named component (T2): the same
  // figure as fica, plus its three priced parts (Social
  // Security, Medicare, Additional Medicare) summed over the
  // work years — each priced from its own year's law row.
  payrollTax: z.number(),
  payrollSocialSecurity: z.number(),
  payrollMedicare: z.number(),
  payrollAdditionalMedicare: z.number(),
  pretaxContributions: z.number(),
  rothContributions: z.number(),
  hsaContributions: z.number(),
  totalContributions: z.number(),
  employeeContributions: z.number(),
  employerContributions: z.number(),
  surplusBanked: z.number(),
  // Unfunded work-year shortfall (round-7 fix 1.1): spending
  // and taxes in the work years that the salary plus the
  // Taxable balance could not cover — the Taxable balance
  // floors at $0 instead of booking a negative asset, and the
  // remainder is reported here. $0 whenever the work years
  // funded themselves.
  shortfall: z.number(),
  banked: z.number(),
});
const workYearsRowOut = z.object({
  quitAge: z.number(),
  workYears: z.number(),
  // Balances at the quit age, after the roll (dollars).
  balancesAtQuit: z.object({
    pretax: z.number(),
    roth: z.number(),
    taxable: z.number(),
    hsa: z.number(),
  }),
  ledger: workYearsLedgerOut,
  winnerName: z.string(),
  winnerWindowLabel: z.string(),
  winnerClaimLabel: z.string(),
  winnerNetCost: z.number(),
  winnerTax: z.number(),
  winnerPenalty: z.number(),
  winnerIrmaa: z.number(),
  winnerAcaCredit: z.number(),
  // The winner's lifetime refundable education credit (T6):
  // the score component winnerNetCost subtracts beside
  // winnerAcaCredit. 0 when no education expenses are entered.
  winnerEducationRefundable: z.number(),
  winnerTerminal: z.number(),
  doNothingNetCost: z.number(),
  // Work years' own federal tax + state tax + payroll tax, and
  // the all-in figures (optimizer net + work tax).
  workTax: z.number(),
  // The work years' employee payroll tax as its own component
  // (T2), and the plan's total tax with the work years folded
  // in: winnerTax + workTax, payroll included (see the
  // contract's score-identities text).
  payrollTax: z.number(),
  totalTax: z.number(),
  allInTax: z.number(),
  doNothingAllInTax: z.number(),
  claim67AllInTax: z.number().nullable(),
  endingPretax: z.number(),
  endingRoth: z.number(),
  endingTaxable: z.number(),
  endingHsa: z.number(),
  endingNominal: z.number(),
  endingAfterTax: z.number(),
  ssCollected: z.number(),
});

/* ---------------- Data integrity checks ----------------
   Standing invariants over the durable data, evaluated on every
   data load: getDashboard surfaces the spending-side checks and
   getNetWorth the Net Worth checks as plain warning lines (only
   when a violation exists — a clean load shows nothing new), and
   the runAccuracySelfCheck maintenance action runs all five.
   A violation is REPORTED, never silently repaired: these checks
   only read the decrypted data.
   (a) NW snapshot totals. Totals are computed from the balance
       rows at read time, never stored, so the check guards the
       inputs to that computation: every balance row must belong
       to an existing snapshot and an existing account, no
       (snapshot, account) pair may repeat (it would be counted
       twice), and each snapshot's total — with the property
       treatment the current view setting implies — is recomputed
       two independent ways, which must agree.
   (b) NW bucket splits. When a balance carries split parts, the
       parts must sum to the balance. A split stored on a property
       account's balance is a violation: property balances are
       served whole, so stored parts would be silently dropped.
   (c) Bill version chains (monthly bills and yearly/periodic
       expenses). Versions take effect from a month and run until
       the next version, so two versions of one bill effective
       from the SAME month overlap — a violation, as is a version
       whose bill no longer exists.
   (d) Recorded payments. A transaction linked to a yearly /
       periodic expense must reference an expense that exists.
   (e) Monthly cash-out items. A month's cash out resolves as
       items sum > entered lump total > transactions, so a month
       holding both items and a lump total is by design, NOT a
       violation. The true stored-sum inconsistencies are
       malformed rows: an item with a negative or non-integer
       amount or an invalid month key, or a lump total stored
       under an invalid month key. */

type IntegrityViolation = { record: string; detail: string };
type IntegrityCheck = {
  id: string;
  label: string;
  checked: number;
  violations: IntegrityViolation[];
};

function fmtMoneyCents(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const s = `$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
  return neg ? `−${s}` : s;
}

type SpendingDataSubset = {
  txns: TxnRow[];
  yearly: YearlyRow[];
  yearlyVersions: YearlyVersionRow[];
  summaries: SummaryRow[];
  bills: MonthlyBillRow[];
  billVersions: BillVersionRow[];
  cashOutItems: CashOutItemRow[];
};
type NwDataSubset = Awaited<ReturnType<typeof loadNetWorthDecrypted>>;

function checkNwSnapshotTotals(
  nw: NwDataSubset,
  includeProperty: boolean,
): IntegrityCheck {
  const violations: IntegrityViolation[] = [];
  const snapIds = new Set(nw.snapshots.map((s) => s.id));
  const acctById = new Map(nw.accounts.map((a) => [a.id, a]));
  const seenPairs = new Set<string>();
  for (const b of nw.balances) {
    if (!snapIds.has(b.snapshotId)) {
      violations.push({
        record: `Balance #${b.id}`,
        detail: `belongs to snapshot #${b.snapshotId}, which no longer exists — it is left out of every Net Worth total.`,
      });
    }
    if (!acctById.has(b.accountId)) {
      violations.push({
        record: `Balance #${b.id}`,
        detail: `belongs to account #${b.accountId}, which no longer exists — totals treat it as an ordinary account.`,
      });
    }
    const pair = `${b.snapshotId}:${b.accountId}`;
    if (seenPairs.has(pair)) {
      violations.push({
        record: `Balance #${b.id}`,
        detail:
          "is a second balance for the same account on the same snapshot — it would be counted twice in that snapshot's total.",
      });
    }
    seenPairs.add(pair);
  }
  for (const s of nw.snapshots) {
    const contribution = (b: NwBalanceRow): number => {
      const acct = acctById.get(b.accountId);
      // Custodial balances are recorded but never counted.
      if (acct && isCustodialAccount(acct)) return 0;
      const kind = acct?.propertyKind ?? "none";
      return isPropertyKind(kind) && !includeProperty
        ? 0
        : effectiveBalanceCents(kind, b.balanceCents);
    };
    let grouped = 0;
    for (const b of nw.balances) {
      if (b.snapshotId === s.id) grouped += contribution(b);
    }
    const flat = nw.balances
      .filter((b) => b.snapshotId === s.id)
      .reduce((sum, b) => sum + contribution(b), 0);
    if (grouped !== flat) {
      violations.push({
        record: `Snapshot ${s.date}`,
        detail: `two recomputations of its total disagree (${fmtMoneyCents(grouped)} vs ${fmtMoneyCents(flat)}).`,
      });
    }
  }
  return {
    id: "nw-snapshot-totals",
    label: "Net Worth snapshot totals",
    checked: nw.snapshots.length,
    violations,
  };
}

function checkNwBucketSplits(nw: NwDataSubset): IntegrityCheck {
  const violations: IntegrityViolation[] = [];
  const acctById = new Map(nw.accounts.map((a) => [a.id, a]));
  const snapById = new Map(nw.snapshots.map((s) => [s.id, s]));
  let checked = 0;
  for (const b of nw.balances) {
    const parts = splitPartsOf(b);
    if (parts.length === 0) continue;
    checked++;
    const acct = acctById.get(b.accountId);
    const where = `${acct?.name ?? `Account #${b.accountId}`} on ${snapById.get(b.snapshotId)?.date ?? `snapshot #${b.snapshotId}`}`;
    if (acct && isPropertyKind(acct.propertyKind)) {
      violations.push({
        record: where,
        detail:
          "a property balance carries tax-bucket split parts, which the totals ignore — the stored parts would be silently dropped.",
      });
    }
    if (acct && isCustodialAccount(acct)) {
      violations.push({
        record: where,
        detail:
          "a custodial balance carries tax-bucket split parts — custodial balances are recorded whole and never counted, so the stored parts would be silently dropped.",
      });
    }
    const sum = parts.reduce((s, p) => s + p.amountCents, 0);
    if (sum !== b.balanceCents) {
      violations.push({
        record: where,
        detail: `split parts add to ${fmtMoneyCents(sum)} but the balance is ${fmtMoneyCents(b.balanceCents)}.`,
      });
    }
  }
  return {
    id: "nw-bucket-splits",
    label: "Net Worth bucket splits",
    checked,
    violations,
  };
}

function checkBillVersionChains(data: SpendingDataSubset): IntegrityCheck {
  const violations: IntegrityViolation[] = [];
  let checked = 0;
  const chains: {
    kindLabel: string;
    ownerIds: Set<number>;
    ownerName: Map<number, string>;
    versions: { id: number; ownerId: number; effectiveFrom: string }[];
  }[] = [
    {
      kindLabel: "Monthly bill",
      ownerIds: new Set(data.bills.map((b) => b.id)),
      ownerName: new Map(data.bills.map((b) => [b.id, b.name])),
      versions: data.billVersions.map((v) => ({
        id: v.id,
        ownerId: v.billId,
        effectiveFrom: v.effectiveFrom,
      })),
    },
    {
      kindLabel: "Yearly expense",
      ownerIds: new Set(data.yearly.map((y) => y.id)),
      ownerName: new Map(data.yearly.map((y) => [y.id, y.name])),
      versions: data.yearlyVersions.map((v) => ({
        id: v.id,
        ownerId: v.expenseId,
        effectiveFrom: v.effectiveFrom,
      })),
    },
  ];
  for (const chain of chains) {
    const byOwner = new Map<number, { id: number; effectiveFrom: string }[]>();
    for (const v of chain.versions) {
      const arr = byOwner.get(v.ownerId) ?? [];
      arr.push(v);
      byOwner.set(v.ownerId, arr);
    }
    for (const [ownerId, versions] of byOwner) {
      const label = `${chain.kindLabel} "${chain.ownerName.get(ownerId) ?? `#${ownerId}`}"`;
      if (!chain.ownerIds.has(ownerId)) {
        violations.push({
          record: label,
          detail: `${versions.length} stored version(s) belong to a bill that no longer exists.`,
        });
        continue;
      }
      checked++;
      const seenMonths = new Set<string>();
      for (const v of versions) {
        if (seenMonths.has(v.effectiveFrom)) {
          violations.push({
            record: label,
            detail: `has two versions effective from ${v.effectiveFrom} — their effective periods overlap.`,
          });
        }
        seenMonths.add(v.effectiveFrom);
      }
    }
  }
  return {
    id: "bill-version-chains",
    label: "Bill version chains",
    checked,
    violations,
  };
}

function checkPaymentReferences(data: SpendingDataSubset): IntegrityCheck {
  const violations: IntegrityViolation[] = [];
  const ids = new Set(data.yearly.map((y) => y.id));
  let checked = 0;
  for (const t of data.txns) {
    if (t.yearlyExpenseId == null) continue;
    checked++;
    if (!ids.has(t.yearlyExpenseId)) {
      violations.push({
        record: `${t.date} "${t.description}" (${fmtMoneyCents(t.amountCents)})`,
        detail: `is recorded against yearly bill #${t.yearlyExpenseId}, which no longer exists.`,
      });
    }
  }
  return {
    id: "payment-references",
    label: "Recorded payment references",
    checked,
    violations,
  };
}

function checkCashOutItems(data: SpendingDataSubset): IntegrityCheck {
  const violations: IntegrityViolation[] = [];
  const months = new Set<string>();
  for (const it of data.cashOutItems) {
    months.add(it.month);
    if (!monthRe.test(it.month)) {
      violations.push({
        record: `Cash-out item "${it.description}"`,
        detail: `is stored under the invalid month "${it.month}".`,
      });
    }
    if (!Number.isInteger(it.amountCents) || it.amountCents < 0) {
      violations.push({
        record: `Cash-out item "${it.description}" (${it.month})`,
        detail: `has an invalid stored amount (${it.amountCents} cents).`,
      });
    }
    if (monthRe.test(it.month)) {
      const dayErr = cashOutDayError(it.month, it.day);
      if (dayErr) {
        violations.push({
          record: `Cash-out item "${it.description}" (${it.month})`,
          detail: `has an invalid stored day (${it.day}) — ${dayErr}`,
        });
      }
    }
  }
  for (const s of data.summaries) {
    months.add(s.month);
    if (!monthRe.test(s.month)) {
      violations.push({
        record: `Entered cash-out total for "${s.month}"`,
        detail: "is stored under an invalid month key.",
      });
    }
    if (!Number.isInteger(s.cashOutCents)) {
      violations.push({
        record: `Entered cash-out total for ${s.month}`,
        detail: `has a non-integer stored amount (${s.cashOutCents} cents).`,
      });
    }
  }
  return {
    id: "cash-out-items",
    label: "Monthly cash-out items",
    checked: months.size,
    violations,
  };
}

function integrityWarningLines(checks: IntegrityCheck[]): string[] {
  const lines: string[] = [];
  for (const c of checks) {
    for (const v of c.violations) {
      lines.push(`Data check — ${c.label}: ${v.record} — ${v.detail}`);
    }
  }
  return lines;
}

/* ---------------- Entry defaults (new-bill forms) ----------------
   Sticky "Paid from" values for the new-bill forms, persisted in
   settings exactly like the app's other UI preferences. The monthly
   form's Paid from is a single free-text label; the yearly form's is
   a paid-by type ("checking" / "card") plus an account name. The
   label values are user-entered account labels, so they are stored
   encrypted at rest like every other paid-by label in the app; the
   type is a structural enum and stays plain, like the yearly
   expenses' own paid_by_type column. Updated (server-side) whenever
   a bill is added or edited, so the next new-bill form pre-fills
   with the value used last time. First-ever use (nothing stored)
   falls back to the household's modal values: "Credit Card" for
   monthly bills, "Checking" for yearly bills. Editing an existing
   bill never reads these — it always shows the bill's own value. */
/* ---------------- CSV import setup (remembered) ----------------
   IM-2: the import panel's per-import answers (template, account
   name, sign convention, keyword lists) and its column-mapping
   profiles — one per file header layout — persist as ONE
   settings value under this key, following the app's existing
   settings-storage pattern (no new storage mechanism). The blob
   carries user-entered account labels, so it is stored encrypted
   at rest like the entry-default labels below, exported
   decrypted in backups like the other saved blobs, and read
   leniently (a legacy plaintext value is migrated in place on
   read). Its shape is owned by ./importParseCore
   (parseImportSettings / serializeImportSettings), which the
   panel and the fixtures share. */
const IMPORT_SETTINGS_KEY = "spending_import_settings_v1";
/* IM-3: the Net Worth balance import's remembered setup — one
   column-mapping profile per balance-file header layout, plus
   the label → account/bucket mappings the user confirmed —
   persists under this key with exactly the spending blob's
   treatment: encrypted at rest, exported decrypted in backups,
   re-encrypted on restore, read leniently with a legacy
   plaintext value migrated in place. Its shape is owned by
   ./nwImportCore (parseNwImportSettings /
   serializeNwImportSettings), which the panel and the fixtures
   share. */
const NW_IMPORT_SETTINGS_KEY = "nw_import_settings_v1";
const ENTRY_DEFAULT_MONTHLY_PAID_FROM_KEY = "entry_default_monthly_paid_from_v1";
const ENTRY_DEFAULT_YEARLY_PAID_TYPE_KEY = "entry_default_yearly_paid_type_v1";
const ENTRY_DEFAULT_YEARLY_PAID_NAME_KEY = "entry_default_yearly_paid_name_v1";
const MONTHLY_PAID_FROM_FALLBACK = "Credit Card";
const YEARLY_PAID_NAME_FALLBACK = "Checking";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function upsertPlainSetting(db: any, settingKey: string, value: string): Promise<void> {
  await db
    .insert(schema.settings)
    .values({ key: settingKey, value })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value },
    });
}

async function decryptSettingValue(
  key: CryptoKey,
  raw: string | undefined,
): Promise<string | null> {
  if (raw == null || raw === "") return null;
  return isEncrypted(raw) ? decryptStr(key, raw) : raw;
}

/* ---------------- Retirement defaults ----------------
   The live defaults every Retirement engine path reads:
   the Net Worth-following starting portfolio (latest snapshot
   total respecting the Include house & mortgage toggle, minus
   that snapshot's 529 bucket subtotal) and the trailing True
   cost annual spending. Computed here once and shared by
   getRetirementCalc and the baseline-results action, so the
   baseline is priced against exactly the same defaults as
   the working plan. */
async function computeRetirementDefaults(
  ctx: Ctx,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  key: CryptoKey,
): Promise<{
  defaultPortfolioCents: number;
  nwTotalCents: number;
  bucket529Cents: number | null;
  latestSnapshotHasAnySplit: boolean;
  defaultSpendingAnnualCents: number;
  // The exact window the trailing True cost average covers: the
  // first and last month ("YYYY-MM") and how many months were
  // averaged (up to 12 — fewer when the data starts later). The
  // Retirement view's Annual spending provenance line names this
  // window; it is display provenance only, computed from the
  // same window the average itself uses.
  defaultSpendingWindowStart: string | null;
  defaultSpendingWindowEnd: string | null;
  defaultSpendingMonths: number;
  includeProperty: boolean;
  // Factory default for the Current age field (fresh start, Reset
  // to defaults, blank fallback — the same paths the stocks-%
  // factory default feeds): the current calendar year minus the
  // birth year stored in the Roth Conversion inputs, so the default
  // ages with the user instead of going stale. When no birth year
  // is stored, the fixed fallback 55 is kept. A saved current age
  // is never overridden by this — it only fills a never-set field.
  defaultCurrentAge: number;
  // True when defaultCurrentAge was derived from a stored birth
  // year (false when it is the fixed 55 fallback), so the view's
  // helper copy can say where the number came from honestly.
  defaultCurrentAgeFromBirthYear: boolean;
}> {
  const settingRows = await db.select().from(schema.settings);
  const includeProperty =
    settingRows.find((r: { key: string; value: string }) => r.key === NW_INCLUDE_PROPERTY_KEY)?.value === "1";

  // --- default portfolio: latest snapshot total (toggle-aware) ---
  const { accounts, snapshots: nwSnaps, balances } =
    await loadNetWorthDecrypted(ctx, db, key);
  const classById = classByIdOf(accounts);
  let nwTotalCents = 0;
  let bucket529Cents: number | null = null;
  let latestSnapshotHasAnySplit = false;
  const latestSnap = nwSnaps[nwSnaps.length - 1] ?? null;
  if (latestSnap) {
    const latestRows = balances.filter((b) => b.snapshotId === latestSnap.id);
    // Route through nwCore's snapshotTotals — the single
    // implementation of the property-toggle math every other
    // consumer (Net Worth, Year Summary, Roth) uses — so there is
    // exactly one place the property rule lives. Custodial
    // balances are excluded there too, so they never reach the
    // starting portfolio or the 529 auto-exclude basis.
    nwTotalCents = snapshotTotals(latestRows, classById, includeProperty).totalCents;
    bucket529Cents = bucketSubtotals(latestRows, classById)["529"];
    latestSnapshotHasAnySplit = latestRows.some(
      (b) => splitPartsOf(b).length > 0,
    );
  }
  // The Net Worth-following starting portfolio — the ONE
  // default every Retirement engine path reads (the live
  // inputs' blank fallback, Reset to defaults, and scenario
  // compare for a scenario with no portfolio of its own):
  // the toggle-aware latest Net Worth total minus the latest
  // snapshot's 529 (college) bucket subtotal. College money is
  // spoken for, so it is not counted as retirement money while
  // the field follows Net Worth. A snapshot with no 529 split
  // excludes $0.
  const defaultPortfolioCents = nwTotalCents - (bucket529Cents ?? 0);

  // --- default spending: trailing True cost, annualised ---
  const { txns, yearly, yearlyVersions, summaries, cashOutItems } =
    await loadAll(ctx);
  // The per-month computation (the cumulative-rounded accrual and
  // the cash-out resolution behind the smoothed figure) lives in
  // the shared spending core (server/src/spendingCore.ts) — the
  // same code the dashboard runs — so this default can never
  // drift from the Spending views on rounding.
  const core = createSpendingCore({
    txns,
    yearly,
    yearlyVersions,
    summaries,
    cashOutItems,
  });
  const effSmoothed = (m: string): number => core.eff(m).smoothed;
  const monthCandidates = [
    ...new Set([
      ...txns.map((t) => monthOf(t.date)),
      ...summaries.map((s) => s.month),
      ...cashOutItems.map((it) => it.month),
    ]),
  ].sort();
  const earliestMonth = monthCandidates[0] ?? null;
  const nowD = new Date();
  const currentMonthStr = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, "0")}`;
  let defaultSpendingAnnualCents = 0;
  let defaultSpendingWindowStart: string | null = null;
  let defaultSpendingWindowEnd: string | null = null;
  let defaultSpendingMonths = 0;
  if (earliestMonth && earliestMonth <= currentMonthStr) {
    // Mirror getDashboard's Actual average exactly: a trailing
    // window of up to 12 months ending at the current month,
    // counting every month in the window from the first month
    // that has data — a month with no data still contributes
    // its smoothed accrual, it is not skipped.
    const windowStart = shiftMonth(currentMonthStr, -11);
    const start =
      earliestMonth > windowStart ? earliestMonth : windowStart;
    const count = monthsBetween(start, currentMonthStr) + 1;
    let sum = 0;
    let m = start;
    for (let i = 0; i < count; i++) {
      sum += effSmoothed(m);
      m = shiftMonth(m, 1);
    }
    if (count > 0) {
      defaultSpendingAnnualCents = Math.round((sum / count) * 12);
      defaultSpendingWindowStart = start;
      defaultSpendingWindowEnd = currentMonthStr;
      defaultSpendingMonths = count;
    }
  }
  // --- default current age: from the Roth inputs' birth year ---
  // Read-only here: this never writes the Roth blob — it only reads
  // the birth year the user already stored there.
  const rothBlob = await readRothBlob(db, key);
  const birthYearPrimary = rothBlob.inputs?.birthYearPrimary ?? null;
  const defaultCurrentAge =
    birthYearPrimary != null
      ? Math.min(120, Math.max(0, new Date().getFullYear() - birthYearPrimary))
      : 55;
  const defaultCurrentAgeFromBirthYear = birthYearPrimary != null;
  return { defaultPortfolioCents, nwTotalCents, bucket529Cents, latestSnapshotHasAnySplit, defaultSpendingAnnualCents, defaultSpendingWindowStart, defaultSpendingWindowEnd, defaultSpendingMonths, includeProperty, defaultCurrentAge, defaultCurrentAgeFromBirthYear };
}

const accuracyFixtureSuiteSchema = z.object({
  total: z.number(),
  passed: z.number(),
  results: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      pass: z.boolean(),
      failures: z.array(z.string()),
    }),
  ),
});
const accuracyTeethSchema = z.object({
  corruptedCaseId: z.string(),
  failedCount: z.number(),
  pass: z.boolean(),
});
const accuracyTrinitySchema = z.array(
  z.object({
    mix: z.string(),
    stocksPct: z.number(),
    appSuccessRate: z.number(),
    windows: z.number(),
    publishedSuccessRate: z.number(),
    withinTolerance: z.boolean(),
  }),
);
const accuracyIntegritySchema = z.object({
  totalViolations: z.number(),
  checks: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      checked: z.number(),
      violations: z.array(
        z.object({ record: z.string(), detail: z.string() }),
      ),
    }),
  ),
});
const accuracyReplayDivergenceSchema = z
  .object({
    scope: z.string(),
    year: z.number().nullable(),
    candidateIndex: z.number().nullable(),
    candidateKey: z.string().nullable(),
    component: z.string(),
    run1: z.union([z.number(), z.string()]).nullable(),
    run2: z.union([z.number(), z.string()]).nullable(),
  })
  .nullable();
const accuracyReplaySchema = z.object({
  isolationLevel: z.string(),
  summary: z.string(),
  takeaway: z.object({
    identical: z.boolean(),
    yearsCompared: z.number(),
    componentsComparedPerYear: z.number(),
    planMutatedByFirstRun: z.boolean(),
    firstDivergence: accuracyReplayDivergenceSchema,
    lifetimeNetCostRun1: z.number().nullable(),
    lifetimeNetCostRun2: z.number().nullable(),
  }),
  scoreVector: z.object({
    identical: z.boolean(),
    candidatesCompared: z.number(),
    firstDivergence: accuracyReplayDivergenceSchema,
    winnerKeyRun1: z.string().nullable(),
    winnerKeyRun2: z.string().nullable(),
    winnerNetCostRun1: z.number().nullable(),
    winnerNetCostRun2: z.number().nullable(),
  }),
  orderDependence: z.object({
    ordersTested: z.array(z.string()),
    fixtureIdsRequested: z.array(z.string()),
    fixtureIdsFound: z.array(z.string()),
    fixtureIdsMissing: z.array(z.string()),
    anyOrderDependent: z.boolean(),
    details: z.array(
      z.object({
        id: z.string(),
        found: z.boolean(),
        orderDependent: z.boolean(),
        outcomes: z.array(
          z.object({
            order: z.string(),
            pass: z.boolean(),
            failures: z.array(z.string()),
          }),
        ),
      }),
    ),
  }),
});
const accuracySuiteEnum = z.enum([
  "tax",
  "tax-teeth",
  "tax-teeth-opt",
  "extended",
  "extended-teeth",
  "retirement",
  "retirement-teeth",
  "integrity",
  "ui-state",
  "roth-cas",
  "retirement-cas",
  "replay",
  "december",
]);
const accuracySelfCheckResponse = z.object({
  suite: z.string(),
  note: z.string(),
  fixtures: accuracyFixtureSuiteSchema.nullable(),
  trinity: accuracyTrinitySchema.nullable(),
  trinityCitation: z.string().nullable(),
  extendedFixtures: accuracyFixtureSuiteSchema.nullable(),
  taxFixtures: accuracyFixtureSuiteSchema.nullable(),
  uiStateFixtures: accuracyFixtureSuiteSchema.nullable(),
  rothCasFixtures: accuracyFixtureSuiteSchema.nullable(),
  retirementCasFixtures: accuracyFixtureSuiteSchema.nullable(),
  decemberFixtures: accuracyFixtureSuiteSchema.nullable(),
  teeth: z.object({
    retirement: accuracyTeethSchema.nullable(),
    extended: accuracyTeethSchema.nullable(),
    tax: accuracyTeethSchema.nullable(),
  }),
  integrity: accuracyIntegritySchema.nullable(),
  replay: accuracyReplaySchema.nullable(),
});
type AccuracySelfCheckResponse = z.infer<typeof accuracySelfCheckResponse>;

/* ---------------- describeApi: purposes ----------------
   ONE purpose line per published action — the single record
   describeApi reads. describeApi's response carries a self-check
   (actionsMissingPurpose) listing any published action with no
   entry here, so a future action added without a purpose is
   visible in the contract itself rather than drifting silently. */
const ACTION_PURPOSES: Record<string, string> = {
  getDashboard: "Spending dashboard for one month: true cost, cash out, bills, yearly expenses, category breakdown, and quick-view tiles.",
  getYearView: "One calendar year's spending: monthly true cost and cash out, totals, and the year's bills.",
  getExplorer: "Slice & dice explorer: pivot recorded spending by category, bill, paid-from, lights-on, or month over a month range.",
  addTransaction: "Record one spending transaction (checking or card).",
  updateTransaction: "Edit one recorded transaction. Returns { ok: false, reason } when the id does not exist. Compare-and-swap (contract v65): when the caller supplies `base` (the transaction as loaded), the write is a guarded update that applies only where the stored row still equals the base fields; a mismatch returns { ok: false, conflict: true, reason } and the stored newer value stays intact. Omitting `base` keeps the legacy unchecked write.",
  deleteTransaction: "Delete one recorded transaction. Returns { ok: false, reason } when the id does not exist.",
  importTransactions: "Import a batch of transactions at once (the statement import path — CSV and OFX/QFX files alike; both are parsed client-side into these rows). One call is ATOMIC: the whole batch is preflighted (including the reserved enc:v1: prefix check on every row's text fields and on its bank transaction id) and then inserted as a single batch — any failure inserts ZERO rows from that call and throws with its reason, and success returns { imported } equal to the full row count. A row may carry the bank's own transaction id (fitId, from an OFX/QFX file's FITID), which is stored encrypted with the row so later previews can recognise that exact transaction. Duplicate protection lives in the import preview, not in this action: the panel compares parsed rows against the already-recorded transactions for the same account and months (fuzzy matching on date, amount, description, kind, and account, plus EXACT matching on the bank transaction id when both sides carry one — see getImportData) and excludes rows that look or are already recorded unless the user explicitly includes them, so re-importing the same file does not double-record it. This action itself inserts exactly the rows it is given. BATCH IDEMPOTENCY KEY (contract v64, F02): the optional batchKey makes one batch retry-safe against a lost response — a completed keyed batch is recorded durably (a settings row holding the batch's rows hash and count, committed in the SAME batch as the rows), and a repeat call with the same key and the same rows returns the original { imported } count inserting ZERO additional rows; the same key with DIFFERENT rows is refused with a clear error and inserts nothing; a genuinely new import under a new key inserts identical rows normally (the key guards retries, not content). Requests without a key behave exactly as before. The import panel generates one key per 500-row batch and reuses it when re-offering that batch after a failure.",
  getImportData: "Read support for the statement import panel: the remembered import setup (last-used settings plus column-mapping profiles keyed by header layout and remembered OFX account mappings, as one JSON string owned by importParseCore; null when nothing is saved yet) and the already-recorded transactions in the given months (date, amount, description, kind, account, and the bank transaction id recorded with the row or null — plaintext read data) so the preview can flag rows that look already recorded and rows that are exact duplicates by bank id. It also returns, per given month, the recorded cash-out state (the entered month total, or null, and the recorded cash-out items with ids) so the IM-4 cash-out proposal can show what is already recorded for a month and a confirmed save can replace that month's items through the existing item writes. Matching happens in the panel, where plaintext exists; stored data is encrypted at rest and is never content-matched server-side. An empty months list returns just the setup. Read-only apart from migrating a legacy plaintext setup value to encrypted in place — a compare-and-write (contract v64) that applies only while the stored value still equals the value read, so a concurrent setup save wins.",
  saveImportSettings: "Save the CSV import panel's remembered setup (last-used settings plus column-mapping profiles) as one settings value, stored encrypted at rest and carried in backup/restore like the app's other saved blobs. The value must parse as an import-settings blob (importParseCore); anything else is refused and nothing is stored.",
  getNwImportSettings: "Read support for the Net Worth balance-import panel: its remembered setup (column-mapping profiles keyed by header layout, plus confirmed file-label to account/bucket mappings) as one JSON string owned by nwImportCore; null when nothing is saved yet. Read-only apart from migrating a legacy plaintext setup value to encrypted in place — a compare-and-write (contract v64) that applies only while the stored value still equals the value read, so a concurrent setup save wins.",
  saveNwImportSettings: "Save the Net Worth balance-import panel's remembered setup (column-mapping profiles plus confirmed label mappings) as one settings value, stored encrypted at rest and carried in backup/restore like the app's other saved blobs. The value must parse as an NW import-settings blob (nwImportCore); anything else is refused and nothing is stored.",
  addYearlyExpense: "Add a yearly or periodic (smoothed) expense bill. An absent frequency defaults to \"yearly\"; an unknown frequency value is rejected, never defaulted.",
  updateYearlyExpense: "Edit a yearly/periodic expense's details. An absent frequency defaults to \"yearly\"; an unknown frequency value is rejected, never defaulted. Returns { ok: false, reason } when the id does not exist (checked before any version rows are touched). The version write is an atomic upsert on the (expense, effective month) pair, which the database enforces as unique (contract v64). Compare-and-swap (contract v65): when the caller supplies `base` (the parent fields as loaded, plus the version stored for the save's effective month — null when none existed), the write is refused with { ok: false, conflict: true, reason } when any of those no longer matches storage, checked before any write so the parent and every version stay intact. Omitting `base` keeps the legacy unchecked write.",
  setYearlyExpenseVersion: "Set a new amount/frequency version for a yearly/periodic expense from a chosen month onward. Returns { ok: false, reason } when the expense does not exist. The version write is an atomic upsert on the (expense, effective month) pair, which the database enforces as unique (contract v64).",
  deleteYearlyExpense: "Delete a yearly/periodic expense and its versions. Returns { ok: false, reason } when the id does not exist.",
  deleteYearlyExpenseVersion: "Remove one version from a yearly/periodic expense's history.",
  setYearlyDueMonth: "Set the due month of a yearly expense. Returns { ok: false, reason } when the id does not exist.",
  addMonthlyOneOff: "Record a one-off expense against a month.",
  updateMonthlyOneOff: "Edit a recorded one-off expense. Returns { ok: false, reason } when the id does not exist.",
  deleteMonthlyOneOff: "Delete a recorded one-off expense. Returns { ok: false, reason } when the id does not exist.",
  addCashOutItem: "Add an itemized cash-out line to a month.",
  updateCashOutItem: "Edit an itemized cash-out line. Returns { ok: false, reason } when the id does not exist. Compare-and-swap (contract v65): when the caller supplies `base` (the item as loaded), the write is a guarded update that applies only where the stored row still equals the base fields; a mismatch returns { ok: false, conflict: true, reason } and the stored newer value stays intact. Omitting `base` keeps the legacy unchecked write.",
  deleteCashOutItem: "Delete an itemized cash-out line from a month. Returns { ok: false, reason } when the id does not exist.",
  updateSettings: "Update spending settings (opening reserve and reserve start month). Compare-and-swap (contract v65): when the caller supplies `base` (both stored keys as loaded), the write is refused with { ok: false, conflict: true, reason } when either stored key no longer matches its base, and both stored values stay intact. Omitting `base` keeps the legacy unchecked write. Success returns { ok: true }.",
  upsertMonthlySummary: "Enter or update a month's direct cash-out total (supersedes that month's transactions). Compare-and-swap (contract v65): when the caller supplies `base` (the stored month total as loaded, null when none was stored), the write is refused with { ok: false, conflict: true, reason } when the stored total differs from the base. Omitting `base` keeps the legacy unchecked write. Success returns { ok: true }.",
  deleteMonthlySummary: "Remove a month's entered cash-out total. Returns { ok: false, reason } when no total is recorded for that month.",
  addMonthlyBill: "Add a monthly bill.",
  updateMonthlyBill: "Edit a monthly bill's details. Only the fields actually sent are written: notes, category, and keepLightsOn are optional with no defaults, so an absent field preserves the stored value, while an explicitly sent notes: null clears the notes. Returns { ok: false, reason } when the id does not exist. Compare-and-swap (contract v65): when the caller supplies `base` (the bill's five form fields as loaded), the write is refused with { ok: false, conflict: true, reason } when any field this save would replace no longer matches its base in storage. Omitting `base` keeps the legacy unchecked write.",
  setMonthlyBillCategory: "Set a monthly bill's category (relabels past months' grouping). Returns { ok: false, reason } when the id does not exist.",
  setYearlyCategory: "Set a yearly/periodic expense's category (relabels past months' grouping). Returns { ok: false, reason } when the id does not exist.",
  setMonthlyBillKeepLightsOn: "Toggle a monthly bill's Keep-the-lights-on flag. Returns { ok: false, reason } when the id does not exist.",
  setMonthlyBillsCollapsedAll: "Persist the Monthly bills section's collapsed/expanded state.",
  setYearlyBillsCollapsedAll: "Persist the Yearly & periodic expenses section's collapsed/expanded state.",
  setByCategoryCollapsedAll: "Persist the By category section's collapsed/expanded state.",
  setYearInSpendingCollapsedAll: "Persist the Year in spending section's collapsed/expanded state.",
  getExplainerState: "Read the explainer panel's expanded state.",
  setExplainerExpanded: "Persist the explainer panel's expanded state.",
  getUiFoldState: "Read the generic fold state: the open/closed map for the Spending and Net Worth collapsible pieces not owned by a more specific store (per-month cash-out item lists, the import panels, the reserve settings fold, the Trend anchor note). Only folds left open are carried; an absent id is that fold's default (closed).",
  setUiFoldState: "Persist one generic fold's open/closed state (see getUiFoldState). Display-only; setting a fold closed removes its entry, since every fold in this store defaults to closed.",
  setYearlyKeepLightsOn: "Toggle a yearly/periodic expense's Keep-the-lights-on flag. Returns { ok: false, reason } when the id does not exist.",
  setMonthlyBillAmount: "Set a monthly bill's amount from a chosen month onward. Returns { ok: false, reason } when the bill does not exist. The version write is an atomic upsert on the (bill, effective month) pair, which the database enforces as unique (contract v64). Compare-and-swap (contract v65): when the caller supplies `base` (the amount stored for that effective month as loaded — null when no version existed for it), the write is refused with { ok: false, conflict: true, reason } when the stored amount for that month differs from the base. Omitting `base` keeps the legacy unchecked write.",
  deleteMonthlyBill: "Delete a monthly bill and its versions. Returns { ok: false, reason } when the id does not exist.",
  deleteMonthlyBillVersion: "Remove one version from a monthly bill's history.",
  seedExamples: "Seed the example spending dataset. Refused unless the WHOLE dataset is empty — every dataset table, settings included (the one global first-run emptiness check, seedGuardCore): a tracker holding any real record receives no sample rows. The seed commits as ONE atomic batch (contract v64): a failure mid-seed leaves the dataset empty and a plain retry can succeed.",
  seedFirstRun: "First-run seed: run the one global emptiness check over every dataset table, then seed BOTH sample datasets (spending and Net Worth) as a single all-or-nothing operation — both datasets' inserts commit as ONE atomic batch (contract v64), so a failure anywhere leaves an EMPTY dataset and a plain retry can succeed. Returns seeded: false (with the tables that blocked it) when the dataset holds any record, so the caller marks the store seeded only when the seed actually ran.",
  clearAllData: "Erase ALL tracker data: all spending data, all Net Worth data, and all saved planner data and settings — including the Retirement calculator record and baseline, the Roth plan record, and the Roth UI state. Requires confirm to carry the exact phrase \"delete everything\"; any other confirmation deletes nothing.",
  seedNetWorth: "Seed the Net Worth accounts and snapshots from the built-in sample data. Refused (seeded: false) unless the WHOLE dataset is empty — the same global first-run emptiness check seedExamples uses, so sample history never lands beside real records in any table. The seed commits as ONE atomic batch (contract v64), like seedExamples.",
  getNetWorth: "Net Worth view: accounts, snapshots (each carrying its whole-snapshot revision, the CAS base for the snapshot and single-balance editors — contract v65), totals, bucket split subtotals, and target progress.",
  setNwIncludeProperty: "Set whether property (house/mortgage) counts in Net Worth totals.",
  setNwTarget: "Set the Net Worth target amount.",
  getRetirementCalc: "Retirement calculator: saved inputs, defaults from Net Worth and trailing spending, and priced results. Also carries savedUnreadable / baselineUnreadable markers (contract v67): true when the saved inputs record / baseline record exists but cannot be read — in that state saved / baseline read as null exactly as an absent record would, and the markers are the distinction.",
  setRetirementAssumptionsCollapsed: "Persist the Retirement assumptions section's collapsed state.",
  setRetirementSpendingUnit: "Persist the Retirement annual-spending entry unit (per year / per month).",
  saveRetirementCalc: "Save the Retirement calculator inputs. Revision-checked (CAS): a write whose baseRevision no longer matches the stored revision is refused with the current lite record (saved inputs, scenarios, baseline, and both revisions) instead of overwriting it; a write with no baseRevision keeps the legacy unchecked behaviour, and every accepted write bumps the revision and returns it. FIRST WRITE (contract v64): when no record exists yet and a baseRevision is supplied, the write is insert-if-absent — if a first save from elsewhere landed between the read and the write, this write is refused with the same conflict shape instead of overwriting it, so two overlapping first saves at base 0 produce exactly one success and one conflict.",
  saveRetirementBaseline: "Make the given Retirement inputs both the working inputs and the comparison baseline ('Make this my plan'). Revision-checked (CAS) on BOTH records: a write whose baseRevision or baseBaselineRevision no longer matches the stored revision is refused before anything is written, with the current lite record and both revisions; a baseline commit that loses a commit-time race is retried once against the fresh baseline, and a second loss returns a stage \"baseline\" conflict (the working inputs were saved; the baseline did not move). Writes with no bases keep the legacy unchecked behaviour, and every accepted write bumps both revisions and returns them. FIRST WRITE (contract v64): when a record does not exist yet and its base is supplied, that record's write is insert-if-absent — a landed concurrent first save refuses this write (an inputs-stage conflict when the working record landed, a stage \"baseline\" conflict when only the baseline landed) instead of being overwritten.",
  getRetirementBaselineResults: "Price the saved Retirement baselines against the current defaults. Carries baselineUnreadable (contract v67): true when a baseline record exists but cannot be read, distinct from no baseline.",
  saveRetirementScenario: "Save a Retirement scenario.",
  deleteRetirementScenario: "Delete a saved Retirement scenario.",
  renameRetirementScenario: "Rename a saved Retirement scenario.",
  getRothPlanner: "Roth Conversion planner: saved plan inputs, saved scenarios, execution-year block, tax-return actuals block, and the latest Net Worth snapshot subtotals. Carries recordUnreadable (contract v67): true when the saved plan record exists but cannot be read — saved then reads as null exactly as an absent record would.",
  resetRothPlanner: "Reset the Roth plan record (plan inputs plus the execution-year, gift, MC-volatility, and tax-return blocks) to the seeded fresh-user defaults; saved scenarios pass through untouched. The reset commits against the record it read, retrying against the freshest record a bounded number of times if another save lands first; if it keeps losing that race it is refused with the current record — the same conflict shape saveRothInputs returns — instead of overwriting the newer save.",
  getRothUiState: "Read the Roth view's UI state (open sections, year table, workspace mode) plus the Playground form's remembered dial state, with the blob's current write revision.",
  setRothUiState: "Persist one piece of the Roth view's UI state, or the Playground form's remembered dial state. Revision-checked (CAS): a write whose baseRevision no longer matches the stored revision is refused with the current blob and its revision instead of overwriting it.",
  saveRothInputs: "Save the Roth plan record (inputs plus execution-year, MC-volatility, gift, and tax-return blocks). Writers are strict: a complete record is required, and baseRevision is required on every call. Revision-checked (CAS): a write whose baseRevision is missing, or no longer matches the stored revision, is refused with the current record and its revision instead of overwriting it — there is no unchecked write path — and every accepted write bumps the revision and returns it. " + SAVE_FLATTENING_SENTENCE + " " + CONVERTED_ALREADY_DISTINCTION_SENTENCE,
  saveRothScenario: "Save the given plan inputs as a new named Roth scenario (complete record required).",
  updateRothScenario: "Replace the saved Roth scenario with the given name by the given complete record (the name itself is kept). Scenario-level compare-and-swap (contract v65): when the caller supplies `baseScenario` (the named scenario's complete payload as loaded), the write is refused with { ok: false, conflict: true, reason } when the named scenario's stored payload no longer matches that base — inside the record blob's own raw-value CAS, which by itself proves only that the blob is fresh, not that this scenario is. A concurrent write to a different scenario or to the working inputs does not refuse this save. Omitting `baseScenario` keeps the legacy blob-CAS-only behaviour.",
  deleteRothScenario: "Delete a saved Roth scenario by name.",
  renameRothScenario: "Rename a saved Roth scenario.",
  runRothOptimizer: "Price the joint claiming-age × conversion-strategy search and return the winning strategy, Do Nothing, runner-ups, and sensitivity strips. The winner is the candidate with the lowest lifetime net cost; ties on cost are broken by ending wealth (the higher ending after-tax wealth wins). The searched candidate space includes gain-harvesting variants of every conversion candidate when the plan holds a taxable balance with basis below 100% (and is unchanged otherwise): each conversion candidate also gets a gainsHarvest twin, Do Nothing never does, and there is no separate ltcgZeroCap ceiling candidate family. Every scored candidate in the response (winner, runnersUp, doNothing, orderWinner, orderRunnersUp, orderDoNothing, claim-age table best entries, and the sensitivity entries) exposes its gainsHarvest state as a boolean, and a harvest twin's name carries the harvesting phrase (gain harvesting into the 0% bracket). Claiming-age floor conflicts are reported via claimAgeFloorMet and an explicit note rather than asserted away: claimAgeFloorMet is null when no claimAgeFloor is set, true when the crowned winner claims at or above the floor (or has no primary claiming age to violate it, or is the floor-exempt Do Nothing benchmark), and false when the winner claims below the floor — including a locked claim and the no-eligible-candidate fallback — in which case claimSearchNote states the conflict plainly, naming the floor and the winner's actual claiming age (and the locked reason when the claim is locked), and does not assert the winner meets the floor; the note never references below-floor markings in the per-age table when the claim age table is empty. PRICED LEVERS (contract v69): the response also carries savedPlan — the entered plan priced as its own fixed strategy (its saved ceilings, window, draw order, and entered claiming ages) in the same score shape — improvements, the top three DISTINCT searched candidates (Do Nothing excluded) whose net cost beats savedPlan's, each extended with gainVsSavedPlan (savedPlan.netCost − candidate.netCost, dollars, from the search's own figures), and winnerIsDoNothing. Compute-only; saves nothing.",
  runRothCompare: "Price an ordered list of named scenario patches against one base plan and return per-scenario results in cents with deltas versus the baseline scenario. Each scenario also carries unpaidTaxCents: the lifetime part of its assessed tax its balances could not pay (0 whenever the scenario always covers its bill — see the unpaidTaxSemantics convention describeApi publishes). PER-YEAR TAX READOUTS (contract v51): each scenario also carries federalTaxCents and stateTaxCents (the lifetime federal / state split of totalTaxCents — the two sum to totalTaxCents) and a years array, one readout per priced march year in cents, read straight off the same priced rows the lifetime totals sum: year, agePrimary, ageSpouse, federalTaxCents, stateTaxCents, totalIncomeCents (the year's adjusted gross income (AGI)), taxableIncomeCents, acaCreditCents (the year's ACA premium credit kept), irmaaCents (IRMAA surcharges PAID that year — Medicare premiums, not tax), conversionCents, and pretaxDrawCents (the year's pre-tax money out by choice: its conversion plus its pre-tax draw for spending; an RMD alone is not in it). Display-only readouts — no score, ranking, or delta is derived from them, and no pricing changed. Compute-only; saves nothing. Balance keys follow the two balanceSemantics rules describeApi publishes: in the base plan payload a null balance is a blank that follows the Net Worth snapshot (and an omitted key fails validation), while in a scenario's overrides an omitted balance key inherits the base's resolved value and an explicit null prices that balance at $0 for the scenario — and the scenario's effectiveInputs echo shows that resolved $0, not the null that was sent. Scenario overrides may set flexCutPct / flexFloorPct (flexible spending — see conventions). " + CEILINGS_REPLACEMENT_SENTENCE,
  runRothMonteCarloCheck: "Re-price the optimizer's winner and Do Nothing across varied return paths and report win rate and advantage percentiles. Compute-only; saves nothing. Results come from 250 paths from the fixed stream (seed 12345): identical payloads return identical results on every call. Each path's yearly return is the plan's expected return plus volatilityPct × a standard-normal shock; at volatilityPct 0 every path equals the deterministic run.",
  runRothMonteCarloStats: "Price up to four named scenario patches against one base plan across 250 varied return paths (the market-uncertainty check's fixed stream: one shared shock stream per path, each scenario's series centered on its own expected return) and report per scenario, in cents: pathsWithShortfall and neverShortfallRatePct (the share of paths with no unfunded-spending year), total-shortfall p50/p90, and ending after-tax wealth / ending pre-tax / lifetime net cost p10/p50/p90. Each scenario also carries fullyFundedRatePct (the share of paths with neither an unfunded-spending year nor an unpaid-tax year), pathsWithUnpaidTax, and the total unpaid tax p50/p90 in cents; neverShortfallRatePct and pathsWithShortfall remain the SPENDING-shortfall-only measures — a path can fund every dollar of spending yet leave assessed tax unpaid, and only fullyFundedRatePct counts that as a failure. Every scenario's horizon is validated like the base plan's (its end age must be after the current age); a scenario that fails makes the whole call fail with a reason naming that scenario. Each path draws a fixed 160-year shock vector (MC_STREAM_STRIDE_YEARS) regardless of which scenarios are batched, so a scenario's statistics are identical whether it is priced alone or alongside longer- or shorter-horizon companions. Compute-only; saves nothing. Results come from 250 paths from the fixed stream (seed 12345): identical payloads return identical results on every call. Each path's yearly return is the scenario's own expected return plus volatilityPct × a standard-normal shock, so at volatilityPct 0 every path equals that scenario's deterministic run. Each year's return is applied with the year's growth factor floored at zero (returns floored at −100%), which at volatility near the 100% maximum raises the applied distribution's effective mean and lowers its effective volatility (a requested 0% mean / 100% volatility applies as approximately +8.33% / 86.67%), while at ordinary volatilities the effect is negligible. Scenario overrides may set flexCutPct / flexFloorPct (flexible spending — see conventions). The response also carries effectiveInputs, the base plan's resolved inputs the run priced from. " + CEILINGS_REPLACEMENT_SENTENCE,
  runWorkYearsCompare: "Price quitting work at up to three ages: roll the work years forward, then price each with the joint optimizer. Compute-only; saves nothing. In each work year the plan's taxable interest and dividend yields are priced as mandatory income on the year's opening Taxable balance, and Social Security benefits whose start age has been reached are deposited and taxed during the work years — the pre-full-retirement-age earnings test is NOT modeled, so benefits are deposited in full. A work-year deficit funded from Taxable realizes capital gains on the sale, priced into that year's tax, and the taxable account's cost basis rolls forward in dollars into the plan priced at the quit age. The optional medicareAgePrimary request field (the primary's Medicare enrollment age; request-only, never saved) stops all HSA contributions — the employee's and the employer's — in work years at or after that age; the employer HSA figure is read as the employer's contribution only in years the primary is HSA-eligible.",
  runRothGiftCompare: "Price the plan as saved versus with a one-off gift of appreciated stock to a child, including the child's sale tax and the gift-tax exclusion check. The gifted parcel's own basis leaves the parents' basis ledger with the shares; the counterfactual sale is capped at the shares the baseline still holds in the sale year; the exclusion's donor count follows the gift year's filing status (one donor after a spouse's death year). Compute-only; saves nothing.",
  runPlaygroundYear: "Price ONE standalone tax year with the Playground's dial set through the shared single-year engine. Compute-only; reads and writes nothing. The request rejects negative amounts with a validation error instead of clamping them (otherOrdinary excepted — it keeps its sign by design), rejects a stateRatePct outside 0–100, and rejects a taxYear outside 2000–2100. A taxYear with no published law row prices under the newest published law row; the response's lawYearUsed names the row actually priced. The optional residenceState prices the state tax under a state's rules layer instead of the flat stateRatePct when present ('WA' = Washington's capital-gains excise, RCW 82.87 — see the stateSemantics convention); absent prices the flat rate exactly as before. Dividends follow the playgroundYearSemantics convention describeApi publishes: the Ordinary dividends input is the total and the Qualified input is its subset, and the pricer derives the non-qualified part from the pair.",
  runPlanYearDetail: "Price one year of a plan (by calendar year or age) with the plan's fill settings, plus the same year with its conversion forced to $0. Compute-only; saves nothing. Under basis drift, spending draws and tax paid from Taxable realize gains pro-rata. The year settlement iterates to a fixed point: the income its own tax-channel debits create — realized gains on the Taxable sales that pay tax (the initial sale, the reprice-delta sale, and the unpaid-tax debits' Taxable leg, at the year's gain rate or per-tier under basis tiers) and the full amount of any pre-tax debit that pays tax — is priced as income of the same year, and the settlement repeats until the tax due, the debits taken, and the priced income agree to the cent (bounded; a year that cannot converge returns its best iterated state). Gifts still reduce basis dollars pro-rata without separately realizing gains; college costs flow through ordinary spending draws and are in the gain-realizing set. Each row also carries unpaidTax (dollars): the year's priced tax the balances could not pay, $0 when the year pays in full (see the unpaidTaxSemantics convention describeApi publishes); settlementConverged (whether the year's kept settlement was an exact fixed point of the settlement iteration — the feedback pair it assumed equals the pair its debits created) and settlementMismatchCents ({gains, pretax} — the kept round's residual mismatch per component in integer cents, both 0 when converged; a non-converged year was priced from the iteration's best iterated state); ceilingBreached (true when a switched-on ceiling is still breached by the year's final priced figures at conversion $0 — the draws alone breach; see the ceilingBreachedSemantics convention describeApi publishes). Flexible spending (flexCutPct) applies on this deterministic path exactly as a compare run prices it: with a non-negative expectedReturnPct it never triggers and the detail is identical to flex-off; with a negative expectedReturnPct the cut years show as priced. There is no per-year flex counterfactual in v1 — the detail cannot show what a year would look like had the prior year been a down year.",
  runRothFunding: "Price the plan exactly as given (its own ceilings strategy, as the Plan tab runs it) and return one funding row per priced year, all money in integer cents. Needs per year: spendingCents (the year's spending need — annual spending from the retirement-age year on, $0 before it) (the year's spending need is the effective need — post-flex-cut when the plan sets flexCutPct), federalTaxCents (final federal tax plus any pre-59½ withholding penalty, which is paid as part of the federal withholding), stateTaxCents, irmaaCents (Medicare premiums paid that year); totalNeedCents is their sum. Sources are APPLIED amounts under one waterfall, so the eleven source fields sum to totalNeedCents for every year the plan can fund: cash income first (ssCents Social Security received, rmdCents the year's RMD, otherIncomeCents other ordinary income — in that order; income beyond the year's needs is saved into Taxable by the engine and is not a source), then taxable yield income (interestYieldCents, then dividendYieldCents — each the yield on the year's opening Taxable balance, reinvested in the engine's mechanics, so its application offsets the year's taxable sales, spending sales first), then account draws (cashSpendCents: the spend-from-cash share of the year's spending need — see the spendFromCashPct input field: blank = off; when set, X% of each year's spending need is paid from the cash tier of the taxable pool first, with no income, no gains, and no MAGI from that share; the sleeve is the snapshot cash portion of the taxable pool (threaded server-side as spendFromCashSleeveCents when the taxable balance follows the snapshot; with basis tiers it is the 100%-basis tier's balance) and it ends when it empties — tax sales still follow the existing highest-basis-first order and can also drain the sleeve, so the cash share can end early; $0 in every year when the field is blank; pretaxDrawCents: the extra pre-tax spending draw plus every pre-tax amount applied to the tax bill — conversion withholding including its penalty gross-up and pre-tax debits; taxableSoldForSpendingCents / taxableSoldForTaxCents: Taxable sold for the spending settlement and for the tax bill, following the engine's settlement — the tax channel per payTaxFrom, with protectMinTaxableCents capping only that channel's own tax-bill sale (see the protectMinSemantics convention describeApi publishes: the unpaid-tax debits and settlement/harvest reprice deltas that also land in taxableSoldForTaxCents are NOT capped by it, and neither are spending sales) — net of the yield cash applied to them; rothDrawCents: the Roth spending draw plus Roth debits applied to the tax bill; salarySurplusCents: always 0 — plan pricing has no salary flow). spendShortfallCents is the year's unfunded spending — the spending need left after cash income, the tax channels' prior claim on balances, the cash sleeve, and the draw-order draws, measured on the final settlement; spending only, so a tax bill the balances could not pay is not in it; $0 in every year the plan can fund; it is not a source — the eleven sources plus spendShortfallCents plus unpaidTaxCents foot to totalNeedCents in every year. unpaidTaxCents is the year's unpaid tax: the part of the assessed tax bill (federal, state, penalty, IRMAA) still owed after every balance the debit chain could draw from was exhausted — reported, never treated as paid (see the unpaidTaxSemantics convention describeApi publishes); neither it nor the shortfall is ever reconciled into a source field. A year whose balances cannot cover its needs foots exactly, by the sum of its unfunded spending and its unpaid tax. conversionCents (the year's total priced conversion) is a transfer between buckets, not a source; harvestSoldCents is the gain realized by selling and immediately rebuying into the 0% space (sold and reinvested — neither a source nor a need). Also per year: magiCents, acaMagiCents, acaCliffCents (null when ACA pricing is not in scope), acaCreditCents, acaPriced, taxableIncomeCents, bracketPct, drawGainsCents (realized gains from the year's draws and tax sales), ssTaxableCents, settlementConverged (whether the year's kept settlement was an exact fixed point of the settlement iteration — the feedback pair it assumed equals the pair its debits created) and settlementMismatchCents ({gains, pretax} — the kept round's residual mismatch per component in integer cents, both 0 when converged; a non-converged year was priced from the iteration's best iterated state) and ceilingBreached (true when a switched-on ceiling is still breached by the year's final priced figures at conversion $0 — the draws alone breach; see the ceilingBreachedSemantics convention describeApi publishes). Compute-only; saves nothing.",
  getYearSummary: "Year summary for one year: spending figures and Net Worth movement on the same math as their own views. The Keep-the-lights-on floor is priced for the requested year: at the current month for the current year, otherwise at the last month included in that year's totals (or that year's December when it has none).",
  setNwAccountsCollapsed: "Persist the Net Worth Accounts section's collapsed state.",
  setNwHistoryCollapsed: "Persist the Net Worth History section's collapsed state.",
  setNwGrowthSince: "Persist the Net Worth Growth chart's “Change since” baseline snapshot date; null returns the baseline to the first snapshot.",
  addNwSnapshot: "Add a Net Worth snapshot with per-account balances (splits define the balance).",
  updateNwSnapshot: "Replace a Net Worth snapshot's date, note, and balances. Revision-checked (CAS, contract v65): when the caller supplies `baseRevision` (the snapshot revision loaded from getNetWorth), the replacement is refused with { ok: false, conflict: true, revision, reason } when the stored revision has moved — by either snapshot writer — and the stored snapshot stays intact; an accepted write bumps the revision and returns it. Omitting `baseRevision` keeps the legacy unchecked write.",
  updateNwBalance: "Correct one account's balance in one snapshot (null removes it). The write is ONE atomic upsert on the (snapshot, account) pair, which the database enforces as unique (contract v64), so overlapping writes can never create two balance rows for one account in one snapshot. Revision-checked (CAS, contract v65): when the caller supplies `baseRevision` (the snapshot revision loaded from getNetWorth), the write is refused with { ok: false, conflict: true, revision, reason } when the snapshot's revision has moved, and an accepted write bumps that same revision — so a whole-snapshot editor holding the older revision conflicts instead of restoring the old balance. Omitting `baseRevision` keeps the legacy unchecked write.",
  deleteNwSnapshot: "Delete a Net Worth snapshot and its balances. Returns ok: false when the snapshot does not exist.",
  addNwAccount: "Add a Net Worth account (ordinary, property, or custodial). An absent propertyKind defaults to \"none\"; an unknown propertyKind value is rejected, never defaulted.",
  renameNwAccount: "Rename a Net Worth account and optionally update its property/custodial flags. Returns ok: false when the account does not exist. Compare-and-swap (contract v65): when the caller supplies `base` (the account's name, propertyKind, and custodial flag as loaded), the write is refused with { ok: false, conflict: true, reason } when any field this save writes no longer matches its base in storage. Omitting `base` keeps the legacy unchecked write.",
  setNwAccountArchived: "Archive or restore a Net Worth account. Returns ok: false when the account does not exist.",
  deleteNwAccount: "Permanently delete an archived, non-property Net Worth account and its balances.",
  exportbackup: "Export the complete dataset as one decrypted backup payload. The payload carries an authenticityMac — a keyed MAC over its contents — which restorebackup verifies before restoring.",
  restorebackup: "Replace the entire dataset with a backup payload from exportbackup, preserving ids. Authenticity rule: a payload carrying an authenticityMac is verified before anything is written — if the MAC does not verify, the restore is REFUSED with an authenticity error and nothing changes. A payload with NO MAC (written before MAC signing) still restores, but the result labels it UNAUTHENTICATED (authenticated: false) — nothing proves its contents are unmodified. The MAC key ships with the app (the same key in the live app and the packaged build, so backups verify on either side), so the MAC is tamper/corruption detection, not proof of who made the file; the payload's encryption key check remains a compatibility check only. Validation rule: preflight also enforces the ordinary writers' invariants before anything is written — every amount a writer requires nonnegative must be nonnegative; every backed-up field's own writer rule holds (string lengths for names, descriptions, categories, paid-by labels and notes; the yearly dueMonth within 1–12 or null; every stored flag a 0/1 value; row ids and foreign keys positive; no tax-bucket split on a property or custodial account's balance — the field rules are the shared fieldValidators fragments the writers themselves use); and typed settings must parse as their writers parse them (opening_reserve_cents a valid integer, nw_target_cents a positive integer, reserve_start_month a month or blank) — and a payload violating one is REFUSED with the reason and nothing changes. Named exclusions: settings values other than those three scalar typed settings ride as opaque blobs (their writers validate structured objects at save time and their readers parse leniently), the Net Worth account bucket field is a legacy column no current writer writes, and server-assigned values (sortOrder, createdAt timestamps) are carried without range checks; transaction amounts and Net Worth balances stay signed because their writers accept negatives. Every encrypted-at-rest setting, both import-settings blobs included, is stored encrypted immediately on restore — see the restoreValidationSemantics convention describeApi publishes. Before restoring a payload from a file you were handed, say which case it is and confirm with the user; restore only payloads from a trusted source — see the backupAuthenticitySemantics convention describeApi publishes.",
  listBackups: "List the encrypted backup files the Backups panel shows: this space's own backups folder unioned with the legacy shared folder. Each entry's source says which folder it resolved to — \"own\" (deletable from the app) or \"legacy\" (exists only in the legacy folder, which is read-only: listed and restorable, never deletable from here).",
  deleteBackup: "Delete one backup-*.mstbak file from this space's own backups folder. A backup that exists only in the legacy shared folder is refused — that folder is read-only.",
  deleteAllBackups: "Delete every backup file in this space's own backups folder. Legacy-folder backups are never deleted.",
  createBackupNow: "Create an encrypted backup file now from the current dataset (same payload as exportbackup).",
  runAccuracySelfCheck: "Maintenance: run one accuracy fixture suite (tax, extended, retirement, teeth checks, data integrity, the replay reproducibility diagnostic, or the December console fixtures) per call.",
  getDecemberProjection: "Read the December projection console's saved inputs. Returns {state, hasStored, revision, storedUnreadable}: storedUnreadable (contract v67) is true when a blob is stored but cannot be parsed as a state document — state then carries the lenient-parse defaults, and the flag is the distinction from a fresh console. The other fields: state is the console's complete input set (one settings blob, parsed leniently field by field — see saveDecemberProjection for the state fields' meanings, including the per-owner pre-tax balances, rmdAlreadyReceived, acaEnrollmentPremiumAnnual, and the stray character splits); hasStored says whether a blob was ever saved (a first open can preseed from the saved Tax Plan record); revision is the blob's write revision — pass it back as baseRevision when saving, and a blob written before revisions existed reads as revision 0. Read-only.",
  saveDecemberProjection: "Save the December projection console's inputs as one settings blob, as a compare-and-swap on the blob's write revision. Contract v67: a save whose stored record cannot be parsed is refused as a conflict carrying storedUnreadable: true — an unparseable stored record is never treated as a revision-0 base, and its bytes are left intact; the conflict shape also carries storedUnreadable on its other refusals (false there). REQUEST: {state, baseRevision} — baseRevision is REQUIRED and must equal the revision the caller's copy was read at (from getDecemberProjection; 0 when nothing is stored). RESPONSES: success is {ok:true, revision} with the NEW revision (the next save must pass it); a stale base is NOT an error throw — it returns the machine-readable conflict object {ok:false, conflict:true, revision, state, hasStored} carrying the currently stored revision and state, and writes nothing, so the caller reloads state instead of overwriting it. STATE FIELDS (all dollars, all lenient on read — a missing field reads at its inert default): pretaxBalancePrimary / pretaxBalanceSpouse are the two owners' SEPARATE prior-Dec-31 pre-tax balances (null = not entered for that owner); each owner's RMD is computed on their own age from their own balance, and each owner's table is selected by THAT owner's own beneficiary fact — the two facts are separate and neither is read for the other owner: spouseSoleBeneficiary states the spouse is the sole beneficiary of the PRIMARY's pre-tax accounts and selects ONLY the primary's table, while primarySoleBeneficiaryOfSpouse states the primary is the sole beneficiary of the SPOUSE's pre-tax accounts and selects ONLY the spouse's table — that field is TRI-STATE (boolean or null): true / false are explicit answers, and null = UNANSWERED (a blob written before that field existed parses a missing key as null, never as false); at load an unanswered console value is resolved from the saved Tax Plan record's value for the same fact when the record answers (an explicit console value is never overwritten, and the resolution writes nothing — the blob changes only when the user saves in the console), and only an explicit true selects the Joint table, so null and false both price the spouse's RMD on the Uniform table. FORMAT MARKER (contract v52): every save writes decemberStateFormat 3 beside the state fields; a blob WITHOUT the marker is pre-marker format — a stored false for primarySoleBeneficiaryOfSpouse in it is a STORED ANSWER and stands (the record overlay never overrides it), but it parses with legacyBeneficiaryAnswerUnconfirmed set, the console asks the user to confirm it, and the flag clears only when the user changes that control; a with-marker false is likewise a genuine answer; a stored true in a pre-marker blob stays true, and a missing key or explicit null still reads as UNANSWERED (null). RESOLUTION IS AN OVERLAY (v52): the record-resolved value is displayed and priced, but a save persists the console's OWN value for this field — still null while unanswered — unless the user changed that control in the console; the first-open preseed likewise stores the field unanswered. An owner's table is the Joint and Last Survivor table when that owner's fact is true and their spouse is more than 10 years younger, otherwise the Uniform Lifetime table. A balance entered as 0 is a REAL balance, distinct from null: it prices that owner's RMD as $0 and caps the draw at what the entered balances hold (a $0 total caps the draw at $0), while null caps nothing. pretaxBalance is the legacy combined total — writers set it to the split's sum when a split is explicit. A stored blob carrying only pretaxBalance (its split keys hold no amount for either owner) has balance ownership UNANSWERED (v52): the parsed state carries pretaxSplitExplicit=false with null split fields and the combined amount preserved — at load, when the Tax Plan record supplies BOTH owner amounts with a positive sum, resolution allocates the SAVED combined total across the owners by the record split's proportions (each share rounded to cents, the residual to the larger rounded share, tie to the primary) and never changes the total; when the record supplies EXACTLY ONE owner amount, that owner receives min(known, saved total) and the other owner receives the remainder (saved total minus that), both as numbers, so the total is still preserved exactly; a totals mismatch over $0.01 between the record split's sum and the saved total surfaces a console note naming both totals, and the partial-cap case (exactly one amount known and that amount above the saved total by more than $0.01) likewise surfaces a note naming the record figure and the saved total; the combined-to-primary assignment survives only as the last-resort fallback when the record has no usable split (neither amount known, or a both-known record sum of $0), an explicit blob split always governs over the record, and a save persists the stored provenance until the user edits either balance field in the console. rmdAlreadyReceived is the part of this year's RMD already paid AND already included in ytdOtherOrdinary — it is netted from the computed RMD (floored at $0) so a paid RMD is never counted twice. acaEnrollmentPremiumAnnual is the annual premium of the plan actually enrolled in (null = blank = NO cap, the benchmark-based credit stands); when entered, each case's final credit is capped at min(benchmark-based credit, this premium) BEFORE any coverage-month reduction. Stray character splits: strayROC is return of capital that is income OVER BASIS (a capital gain — rides the gains stack) while strayROCOrdinary is return of capital RECLASSIFIED AS AN ORDINARY DIVIDEND (rides ordinary dividends); strayJanPaid is the total of fund distributions paid in January but deemed received Dec 31 (§852(b)(7)), and strayJanPaidQualifiedAmount is the qualified-dividends PORTION of that total (a portion, clamped to the total). LEGACY CHARACTER PROVENANCE (contract v52): format-3 blobs carry the flags (legacyRocSplitUnconfirmed / legacyJanPaidSplitUnconfirmed) as stored — authoritative; pre-format-3 blobs derive them (a strayROC amount whose strayROCOrdinary key is absent or still at its default, or a strayJanPaid amount whose strayJanPaidQualifiedAmount key is absent or still $0). The flags change no pricing, and each flag clears ONLY when the user edits the matching control (the ROC ordinary split, the January-paid qualified amount) — an unrelated save no longer clears them. strayDependent's amount counts toward the ACA household MAGI ONLY — never the parents' AGI, taxable income, or tax. strayK1 is the one SIGNED stray: a negative amount is a deductible K-1 loss and reduces ordinary income; every other stray amount is non-negative. The blob rides the backup export / restore settings array like the other form-state blobs. Saving inputs prices nothing and touches no other view. (Pricing is runDecemberProjection's: its settlement reconciliation treats a no-marketplace year — nobody marketplace-eligible on the console's Medicare facts — as a $0 credit while creditAtHeadline itself stays null, and a null net carries a netSettleNote reason; see runDecemberProjection.)",
  runDecemberProjection: "Price the December year-end projection from the given console inputs (same state shape as saveDecemberProjection) through the shared single-year engine (pricePlaygroundYear) and its ACA-cliff solver. Compute-only; reads and writes nothing. RESPONSE FIELDS: priced=false with reason set means the year cannot be priced (no primary age entered) and every other field is inert. cliff is the year's 400%-of-FPL line in dollars, or null when NO cliff applies — nobody on the marketplace, or a pre-2026 tax year (the enhanced-credit years have no cliff; headlineText then reads 'No ACA cliff this year — the draw is not cliff-constrained.'). targetMagi is cliff − bufferDollars (null when cliff is null). headlineDraw is the maximum safe December pre-tax draw for the LIKELY case landing MAGI at targetMagi: null means 'not cliff-constrained' (cliff is null — no draw limit from the cliff), while 0 means a cliff EXISTS but no draw is safe — the room under cliff − buffer is already used up, income already posted is over the cliff at a $0 draw (zeroDrawOverCliff=true, and headlineText says no draw can fix that year), or the entered pre-tax balance is $0 so there is nothing to draw (headlineText then says exactly that, whenever the empty balance is the sole binding reason and income room otherwise exists). headlineText is the plain-language headline and always disambiguates the null/0 cases and names the binding reason for a $0 draw. PER CASE (low / likely / high range cases, all priced AT the headline draw): nonDrawAcaMagi is the case's ACA household MAGI before any draw; maxDraw is that case's OWN maximum safe draw (null when cliff is null); magiAtHeadline is the case's MAGI at the headline draw; distanceAtHeadline is cliff − magiAtHeadline (negative = over the cliff; null when cliff is null); overCliffAtHeadline / overCliffEvenAtZero say whether the case is over at the headline draw / even at $0. creditAtHeadline is the case's final allowable credit — the benchmark-based credit capped at acaEnrollmentPremiumAnnual when entered, less any coverage-month reduction, $0 when over the cliff — or null when no benchmark premium was entered (credit not priced). The ACA reconciliation runs on the case's EFFECTIVE final credit (contract v54): the priced credit when there is one; $0 when the priced credit is null because nobody in the household can be on the marketplace on the console's Medicare facts (a known-zero credit — the allowable credit is $0 by construction); null only when the priced credit is null AND someone is marketplace-eligible but no benchmark premium was entered (genuinely unpriced). creditAtHeadline itself is unchanged — it remains the engine's priced credit, null in both null cases. creditStillDue is max(0, effective final credit − aptcTaken) whenever the effective credit is known, in ALL years; it is null only when the credit is genuinely unpriced. excessAptcRepayment: for 2026 and later it is max(0, aptcTaken − effective final credit) — after 2025 there are no repayment caps (P.L. 119-21 §71305), so any APTC taken above the final credit is repaid in full in EVERY case, under the cliff as well as over it (over the cliff the final credit is $0 and the whole APTC taken is repaid); before 2026 it is $0 when aptcTaken is at or below the effective final credit and null when aptcTaken exceeds it (repayment genuinely unmodeled — pre-2026 caps are not modeled); it is null in every year when the credit is genuinely unpriced. repaymentExposure is excessAptcRepayment as an always-a-number field ($0 when unpriced). federalTaxAtHeadline / totalTaxAtHeadline are the case's taxes at the headline draw. PROJECTED TAX BILL (contract v50): each case also carries the priced year's bill readouts at the headline draw — totalIncomeAtHeadline (the year's adjusted gross income (AGI) — the figure the bill labels 'Adjusted gross income (AGI)'; the December assembly nets its above-the-line reducers into income itself, so AGI is the figure this readout carries), taxableIncomeAtHeadline (the year's taxable income), stateTaxAtHeadline (the state component inside totalTaxAtHeadline — $0 at a 0% flat rate, the Washington capital-gains excise when residenceState prices it), and netSettleAtHeadline (nullable): when non-null it is totalTaxAtHeadline − creditStillDue + excessAptcRepayment, equivalently totalTaxAtHeadline − effective final credit + aptcTaken whenever the effective credit is known and the repayment is modeled — so a no-marketplace (known-zero) year produces a number (the total tax, plus any repayment) even though creditAtHeadline stays null; the net is null only when the repayment is unmodeled (pre-2026 APTC above the effective final credit) or the credit is genuinely unpriced, and each case also carries netSettleNote (string | null): null whenever the net is a number, otherwise the reason no single settlement figure is shown, naming which of the two null cases applies (the unpriced-credit reason wins whenever the credit itself is unpriced, in any year). A negative netSettleAtHeadline is an estimated refund at filing (the console labels it 'Estimated refund at filing'; a non-negative net is labeled 'Estimated amount to settle at filing'). The net is an estimate BEFORE withholding and estimated payments, which the console does not track. All four are readouts of the same priced year — no pricing changed. warnings lists input problems priced as entered (e.g. a range whose low/likely/high are out of order) and, when the state's legacy character-provenance flags are set (legacyRocSplitUnconfirmed / legacyJanPaidSplitUnconfirmed), a warning naming the unconfirmed tax character — the flags change no priced figure.",
  describeApi: "Return the machine-readable API contract for every published action, generated live from the actions' own zod schemas, with version stamps and conventions.",
};

const describeApiResponse = z.object({
  apiContractVersion: z.number().int(),
  engineVersion: z.string(),
  lawYear: z.number().int(),
  lawYearsAvailable: z.array(z.number().int()),
  units: z.string(),
  deltaConvention: z.string(),
  writersReadersRule: z.string(),
  balanceSemantics: z.string(),
  flexSemantics: z.string(),
  protectMinSemantics: z.string(),
  unpaidTaxSemantics: z.string(),
  irmaaTierCapSemantics: z.string(),
  irmaaLookbackSemantics: z.string(),
  ceilingBreachedSemantics: z.string(),
  backupAuthenticitySemantics: z.string(),
  restoreValidationSemantics: z.string(),
  scoreIdentities: z.string(),
  lawYearSemantics: z.string(),
  rmdAgeSemantics: z.string(),
  rmdBeneficiarySemantics: z.string(),
  acaSemantics: z.string(),
  acaHouseholdScheduleSemantics: z.string(),
  stateSemantics: z.string(),
  lossCarryforwardSemantics: z.string(),
  itemizedDeductionSemantics: z.string(),
  educationCreditSemantics: z.string(),
  amtSemantics: z.string(),
  tierSemantics: z.string(),
  playgroundYearSemantics: z.string(),
  taxReturnSemantics: z.string(),
  yearCaptureSemantics: z.string(),
  guardrailsSemantics: z.string(),
  examples: z.array(
    z.object({
      action: z.string(),
      note: z.string(),
      request: z.unknown(),
      response: z.unknown(),
    }),
  ),
  actions: z.array(
    z.object({
      name: z.string(),
      purpose: z.string(),
      requestSchema: z.unknown(),
      responseSchema: z.unknown(),
    }),
  ),
  actionsMissingPurpose: z.array(z.string()),
});
type DescribeApiResponse = z.infer<typeof describeApiResponse>;

/* Render one action schema for describeApi EXACTLY as the
   published action surface (artifact.list_actions) renders a
   request schema: zod's toJSONSchema with io "input" and
   unrepresentable "any" — the same conversion, with the same
   options, the runtime applies to each definition's request
   schema when it publishes the action list. The io option is
   what makes the additionalProperties flag truthful: under
   io "output" (the toJSONSchema default) zod stamps
   additionalProperties:false on EVERY object, but under
   io "input" it stamps the flag only where the object's
   catchall is z.never() — that is, exactly the z.strictObject
   definitions, which are the ones that actually reject unknown
   keys — at every nesting level, and omits the flag for plain
   z.object definitions, whose unknown keys are stripped
   instead. Strictness is therefore derived by zod itself from
   each schema definition's catchall: there is no
   hand-maintained list of strict actions or field paths, and a
   future change of any object between strict and non-strict
   shows up identically here and on the published surface with
   no second edit. The same rendering is applied to response
   schemas, so a response object claims closedness only if it
   is actually strict (no response object is strict today). A
   schema zod cannot represent yields undefined, mirroring the
   published surface's fallback for that action. */
function publishedJsonSchema(schema: z.ZodType) {
  try {
    return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  } catch {
    return undefined;
  }
}

/* The getRothPlanner response shape, hoisted to ONE definition:
   getRothPlanner serves it as-is, and the Roth writers' conflict
   shape carries it as the current record. */
const rothPlannerResponse = z.object({
  snapshot: z
    .object({
      date: z.string(),
      totalCents: z.number(),
      pretaxCents: z.number().nullable(),
      rothCents: z.number().nullable(),
      taxableCents: z.number().nullable(),
      hsaCents: z.number().nullable(),
      cashCents: z.number().nullable(),
      nonTaxableCents: z.number().nullable(),
      bucket529Cents: z.number().nullable(),
      // True when at least one balance in the latest snapshot
      // carries split parts — i.e. the snapshot has actually
      // been split into buckets. False means the bucket
      // figures above are all null and the view must run on
      // manual balance entries.
      hasAnySplit: z.boolean(),
    })
    .nullable(),
  saved: rothSavedInputs.nullable(),
  scenarios: z.array(rothScenario),
  execution: rothExecutionResponse,
  // The market-uncertainty check's volatility preference —
  // its own block, plan-record only (see rothMcCheckFields).
  mcCheck: rothMcCheckResponse,
  // The gift-stock what-if description — its own block,
  // plan-record only (see rothGiftFields).
  gift: rothGiftResponse,
  // The tax-return actuals (Form 1040 lines 2b / 3a / 3b) —
  // its own block, plan-record only (see rothTaxReturnFields).
  taxReturn: rothTaxReturnResponse,
  // The record's write revision (API follow-on 1): writers pass
  // it back as saveRothInputs' baseRevision so a stale save is
  // refused instead of silently overwriting a newer one. 0 for
  // a record written before revisions existed.
  revision: z.number().int().nonnegative(),
  // Result-honesty marker (contract v67, F08): true when the
  // saved plan record EXISTS but cannot be read. saved then
  // reads as null exactly as an absent record would — this
  // marker is how the view tells "your saved record can't be
  // read" apart from "no record yet".
  recordUnreadable: z.boolean(),
});
type RothPlannerResponse = z.infer<typeof rothPlannerResponse>;

/* saveRothInputs' response (API follow-on 1), mirroring
   setRothUiStateResponse: an accepted write returns the
   revision it stored; a refused write returns the CURRENT
   planner record and its revision — exactly what
   loadRothPlannerResponse returns at refusal time — so the
   writer re-hydrates from it and re-bases. Storage is left
   untouched on a refusal. */
const saveRothInputsResponse = z.union([
  saveRothInputsOkResponse,
  z.object({
    ok: z.literal(false),
    conflict: z.literal(true),
    revision: z.number().int().nonnegative(),
    record: rothPlannerResponse,
  }),
]);
type SaveRothInputsResponse = z.infer<typeof saveRothInputsResponse>;

/* Load the full Roth planner read model (snapshot subtotals +
   the saved record's parsed blocks) — the ONE implementation
   behind getRothPlanner's handler and the conflict records the
   Roth writers (saveRothInputs, resetRothPlanner) return. */
async function loadRothPlannerResponse(ctx: Ctx): Promise<RothPlannerResponse> {
  const db = ctx.db<typeof schema>();
  const key = await getCryptoKey(ctx);
  const nw = await loadNetWorthDecrypted(ctx, db, key);
  const classById = classByIdOf(nw.accounts);
  const settingRows = await db.select().from(schema.settings);
  const includeProperty =
    settingRows.find((r) => r.key === NW_INCLUDE_PROPERTY_KEY)?.value === "1";
  const latest = nw.snapshots.length
    ? nw.snapshots[nw.snapshots.length - 1]!
    : null;
  let snapshot: RothPlannerResponse["snapshot"] = null;
  if (latest) {
    const rows = nw.balances.filter((b) => b.snapshotId === latest.id);
    const totals = snapshotTotals(rows, classById, includeProperty);
    const sub = bucketSubtotals(rows, classById);
    snapshot = {
      date: latest.date,
      totalCents: totals.totalCents,
      pretaxCents: sub["Pre-tax"],
      rothCents: sub.Roth,
      taxableCents: sub.Taxable,
      hsaCents: sub.HSA,
      cashCents: sub.Cash,
      nonTaxableCents: sub["Non-Taxable"],
      bucket529Cents: sub["529"],
      hasAnySplit: rows.some((b) => splitPartsOf(b).length > 0),
    };
  }
  const blob = await readRothBlob(db, key);
  return {
    snapshot,
    saved: blob.inputs,
    scenarios: blob.scenarios,
    execution: blob.execution,
    mcCheck: { mcVolatilityPct: blob.mcVolatilityPct },
    gift: blob.gift,
    taxReturn: blob.taxReturn,
    revision: blob.revision,
    recordUnreadable: blob.revisionState.present && !blob.revisionState.valid,
  };
}

/* First-run seed presence (contract v60, F7): whether each
   dataset table holds at least one record, for seedGuardCore's
   single emptiness predicate. The settings count excludes the
   encryption key-check row — infrastructure ensureKeyCheck
   creates on the first data load, not user data; every other
   settings row is a real record and blocks seeding. */
async function loadDatasetPresence(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
): Promise<DatasetPresence> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const has = async (table: any): Promise<boolean> =>
    (await db.select().from(table).limit(1)).length > 0;
  const settingRows = (await db
    .select({ key: schema.settings.key })
    .from(schema.settings)) as { key: string }[];
  return {
    transactions: await has(schema.transactions),
    yearlyExpenses: await has(schema.yearlyExpenses),
    yearlyExpenseVersions: await has(schema.yearlyExpenseVersions),
    monthlySummaries: await has(schema.monthlySummaries),
    monthlyBills: await has(schema.monthlyBills),
    monthlyBillVersions: await has(schema.monthlyBillVersions),
    monthlyOneOffs: await has(schema.monthlyOneOffs),
    monthlyCashOutItems: await has(schema.monthlyCashOutItems),
    nwAccounts: await has(schema.nwAccounts),
    nwSnapshots: await has(schema.nwSnapshots),
    nwBalances: await has(schema.nwBalances),
    settings: settingRows.some((r) => r.key !== KEY_CHECK_SETTING),
  };
}

/* The next explicit id for a seed insert: one past the table's
   current maximum (contract v64, A3). The seed builders assign
   ids themselves because the statements commit as ONE db.batch,
   which cannot hand back inserted ids — and version / payment /
   balance rows must reference their parents' ids. The first-run
   guard guarantees the tables are empty when a seed runs, but
   deriving from the live maximum stays correct even when a
   table's autoincrement sequence has advanced past deleted rows
   (e.g. a re-seed after clearAllData). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function nextSeedId(db: any, table: any): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (await db.select({ id: table.id }).from(table)) as { id: number }[];
  return rows.reduce((m, r) => Math.max(m, r.id), 0) + 1;
}

/* Build the sample-spending seed's insert statements WITHOUT
   executing any of them (contract v64, A3 — audit F23/F24): the
   caller commits them as ONE db.batch, so a failure anywhere in
   the seed lands NONE of it and a plain retry can succeed. All
   three seed actions share this builder (and its Net Worth
   sibling): seedExamples / seedNetWorth batch their own dataset,
   and seedFirstRun batches BOTH builders' statements as a
   single all-or-nothing commit. */
async function seedExamplesStatements(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  key: CryptoKey,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ ok: boolean; reason: string; statements: any[] }> {
  /* SAMPLE DATA — a complete sample household for a fresh
     install (this is what the public demo loads). Twelve
     months ending in the current month, recorded the way
     the app is meant to be used: a roster of monthly bills,
     smoothed yearly & periodic bills with their payments
     recorded as transactions, and one entered cash-out
     total per month. The three layers agree by construction:
     each month's cash out is exactly its monthly bills +
     the smoothed payments that left that month + a positive
     "everything else" remainder, so the Quick view tiles,
     the Keep the lights on floor, the category breakdown,
     and the Coming up forecast all show real, consistent
     figures. All figures are synthetic. */
  const now = new Date();
  const curMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const MONTH_COUNT = 12;
  const startMonth = shiftMonth(curMonth, -(MONTH_COUNT - 1));
  const monthAt = (offset: number) => shiftMonth(startMonth, offset);
  // Two monthly bills step up partway through the year (a
  // grocery budget increase and a utility rate change at
  // offset 7), so the bill history shows a version change.
  const BUMP_OFFSET = 7;

  type MonthlySeed = {
    name: string;
    paidBy: string;
    category: string;
    keepLightsOn: boolean;
    amountCents: number;
    bumpedAmountCents?: number;
  };
  const monthlySeed: MonthlySeed[] = [
    { name: "Mortgage", paidBy: "Checking", category: "Housing", keepLightsOn: true, amountCents: 185000 },
    { name: "Groceries & household", paidBy: "Credit Card", category: "Food & household", keepLightsOn: false, amountCents: 65000, bumpedAmountCents: 68500 },
    { name: "Dining out", paidBy: "Credit Card", category: "Food & household", keepLightsOn: false, amountCents: 24000 },
    { name: "Electric & gas", paidBy: "Checking", category: "Utilities", keepLightsOn: true, amountCents: 15800, bumpedAmountCents: 17100 },
    { name: "Water & sewer", paidBy: "Checking", category: "Utilities", keepLightsOn: true, amountCents: 8600 },
    { name: "Internet", paidBy: "Checking", category: "Internet", keepLightsOn: true, amountCents: 7900 },
    { name: "Phone", paidBy: "Checking", category: "Phone", keepLightsOn: true, amountCents: 11800 },
    { name: "Fuel & transit", paidBy: "Credit Card", category: "Transportation", keepLightsOn: false, amountCents: 21000 },
    { name: "Health insurance premium", paidBy: "Checking", category: "Health Insurance", keepLightsOn: true, amountCents: 34200 },
    { name: "Gym", paidBy: "Credit Card", category: "Gym", keepLightsOn: false, amountCents: 5800 },
    { name: "Streaming & apps", paidBy: "Credit Card", category: "Subscriptions", keepLightsOn: false, amountCents: 3600 },
    { name: "Pet care", paidBy: "Credit Card", category: "Other", keepLightsOn: false, amountCents: 7400 },
  ];
  const monthlyAmountAt = (b: MonthlySeed, offset: number): number =>
    offset >= BUMP_OFFSET && b.bumpedAmountCents != null
      ? b.bumpedAmountCents
      : b.amountCents;
  const monthlyTotalAt = (offset: number): number =>
    monthlySeed.reduce((s, b) => s + monthlyAmountAt(b, offset), 0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const statements: any[] = [];
  let nextBillId = await nextSeedId(db, schema.monthlyBills);
  let nextBillVersionId = await nextSeedId(db, schema.monthlyBillVersions);
  for (const b of monthlySeed) {
    const latestCents = monthlyAmountAt(b, MONTH_COUNT - 1);
    const billId = nextBillId++;
    statements.push(
      db.insert(schema.monthlyBills).values({
        id: billId,
        name: await encryptStr(key, b.name),
        amountCents: await encryptNum(key, latestCents),
        paidBy: await encryptStr(key, b.paidBy),
        notes: null,
        category: await encryptStr(key, b.category),
        keepLightsOn: b.keepLightsOn ? 1 : 0,
      }),
    );
    statements.push(
      db.insert(schema.monthlyBillVersions).values({
        id: nextBillVersionId++,
        billId,
        amountCents: await encryptNum(key, b.amountCents),
        effectiveFrom: startMonth,
      }),
    );
    if (b.bumpedAmountCents != null) {
      statements.push(
        db.insert(schema.monthlyBillVersions).values({
          id: nextBillVersionId++,
          billId,
          amountCents: await encryptNum(key, b.bumpedAmountCents),
          effectiveFrom: monthAt(BUMP_OFFSET),
        }),
      );
    }
  }

  type SmoothedSeed = {
    name: string;
    expectedCents: number;
    frequency: "yearly" | "semiannual" | "quarterly";
    dueMonth: number;
    category: string;
    keepLightsOn: boolean;
    // One recorded payment that differed from the set-aside
    // amount (a renewal that came in higher) — the app shows
    // the difference on the bill's card.
    actualDeltaCents?: number;
  };
  const smoothedSeed: SmoothedSeed[] = [
    { name: "Property tax", expectedCents: 265000, frequency: "semiannual", dueMonth: 4, category: "Taxes", keepLightsOn: true },
    { name: "Home insurance", expectedCents: 184200, frequency: "yearly", dueMonth: 3, category: "Insurance", keepLightsOn: true, actualDeltaCents: 3200 },
    { name: "Auto insurance", expectedCents: 87600, frequency: "semiannual", dueMonth: 2, category: "Insurance", keepLightsOn: true },
    { name: "Umbrella insurance", expectedCents: 38500, frequency: "yearly", dueMonth: 8, category: "Insurance", keepLightsOn: false },
    { name: "Vehicle registration", expectedCents: 27600, frequency: "yearly", dueMonth: 9, category: "Transportation", keepLightsOn: false },
    { name: "Trash & recycling", expectedCents: 11700, frequency: "quarterly", dueMonth: 1, category: "Utilities", keepLightsOn: true },
    { name: "Pest control", expectedCents: 14500, frequency: "quarterly", dueMonth: 2, category: "Housing", keepLightsOn: false },
    { name: "Warehouse club membership", expectedCents: 6500, frequency: "yearly", dueMonth: 9, category: "Subscriptions", keepLightsOn: false },
    { name: "Cloud backup", expectedCents: 12000, frequency: "yearly", dueMonth: 12, category: "Subscriptions", keepLightsOn: false },
  ];
  const smoothedIds = new Map<string, number>();
  let nextExpenseId = await nextSeedId(db, schema.yearlyExpenses);
  let nextExpenseVersionId = await nextSeedId(db, schema.yearlyExpenseVersions);
  for (const y of smoothedSeed) {
    const encExpected = await encryptNum(key, y.expectedCents);
    const expenseId = nextExpenseId++;
    smoothedIds.set(y.name, expenseId);
    statements.push(
      db.insert(schema.yearlyExpenses).values({
        id: expenseId,
        name: await encryptStr(key, y.name),
        expectedCents: encExpected,
        dueMonth: y.dueMonth,
        paidByType: "checking" as const,
        paidByName: await encryptStr(key, "Checking"),
        category: await encryptStr(key, y.category),
        backfillBeforeFirstVersion: 0,
        frequency: y.frequency,
        keepLightsOn: y.keepLightsOn ? 1 : 0,
      }),
    );
    statements.push(
      db.insert(schema.yearlyExpenseVersions).values({
        id: nextExpenseVersionId++,
        expenseId,
        expectedCents: encExpected,
        frequency: y.frequency,
        effectiveFrom: startMonth,
      }),
    );
  }
  // The smoothed payments recorded in one month: every bill
  // whose due pattern lands in that calendar month, at its
  // expected amount (plus the one renewal difference).
  const paymentsAt = (offset: number) => {
    const calMonth = Number(monthAt(offset).slice(5, 7));
    const out: { seed: SmoothedSeed; amountCents: number }[] = [];
    for (const y of smoothedSeed) {
      const dues = dueMonthsFor({ frequency: y.frequency, dueMonth: y.dueMonth });
      if (!dues.includes(calMonth)) continue;
      out.push({ seed: y, amountCents: y.expectedCents + (y.actualDeltaCents ?? 0) });
    }
    return out;
  };

  // "Everything else" per month — the day-to-day spending
  // beyond the bill roster and the smoothed payments. Always
  // comfortably positive, so no month shows the negative
  // remainder an unfinished month shows.
  const everythingElse: number[] = [
    112400, 98700, 124600, 108300, 131900, 95400,
    118700, 142600, 106900, 129400, 115800, 138200,
  ];
  const cashOutAt = (offset: number): number =>
    monthlyTotalAt(offset) +
    paymentsAt(offset).reduce((s, p) => s + p.amountCents, 0) +
    (everythingElse[offset] ?? 115000);

  // Entered cash-out totals (the checking-account outflow
  // for the month) — the month's spending base.
  for (let i = 0; i < MONTH_COUNT; i++) {
    statements.push(
      db.insert(schema.monthlySummaries).values({
        month: monthAt(i),
        cashOutCents: await encryptNum(key, cashOutAt(i)),
        createdAt: now,
        updatedAt: now,
      }),
    );
  }
  // The recorded smoothed-bill payments themselves.
  let nextTxnId = await nextSeedId(db, schema.transactions);
  for (let i = 0; i < MONTH_COUNT; i++) {
    const m = monthAt(i);
    for (const p of paymentsAt(i)) {
      statements.push(
        db.insert(schema.transactions).values({
          id: nextTxnId++,
          date: `${m}-10`,
          description: await encryptStr(key, `${p.seed.name} payment`),
          amountCents: await encryptNum(key, p.amountCents),
          sourceType: "checking",
          accountName: await encryptStr(key, "Checking"),
          kind: "spending",
          category: await encryptStr(key, p.seed.category),
          yearlyExpenseId: smoothedIds.get(p.seed.name) ?? null,
        }),
      );
    }
  }
  // Two one-offs, already counted in their months' cash out:
  // they explain part of those months' Everything else.
  const oneOffSeed = [
    { offset: 5, description: "Water heater replacement", amountCents: 64800 },
    { offset: 9, description: "Weekend trip", amountCents: 51200 },
  ];
  let nextOneOffId = await nextSeedId(db, schema.monthlyOneOffs);
  for (const o of oneOffSeed) {
    statements.push(
      db.insert(schema.monthlyOneOffs).values({
        id: nextOneOffId++,
        month: monthAt(o.offset),
        description: await encryptStr(key, o.description),
        amountCents: await encryptNum(key, o.amountCents),
        note: await encryptNullable(key, "One-off — already counted in that month's cash out."),
      }),
    );
  }
  // The current month's cash out, itemized: the bill groups,
  // that month's smoothed payments, and the remainder. The
  // items sum to the entered total exactly, demonstrating
  // the itemized month at a $0 difference.
  {
    const offset = MONTH_COUNT - 1;
    const m = monthAt(offset);
    const billAmount = (name: string): number => {
      const b = monthlySeed.find((x) => x.name === name);
      return b ? monthlyAmountAt(b, offset) : 0;
    };
    const groupAmount = (names: string[]): number =>
      names.reduce((s, n) => s + billAmount(n), 0);
    const items: { description: string; amountCents: number }[] = [
      { description: "Mortgage", amountCents: billAmount("Mortgage") },
      { description: "Groceries & household", amountCents: billAmount("Groceries & household") },
      { description: "Dining, fuel, pet care, gym & streaming", amountCents: groupAmount(["Dining out", "Fuel & transit", "Pet care", "Gym", "Streaming & apps"]) },
      { description: "Electric, water, internet & phone", amountCents: groupAmount(["Electric & gas", "Water & sewer", "Internet", "Phone"]) },
      { description: "Health insurance premium", amountCents: billAmount("Health insurance premium") },
      ...paymentsAt(offset).map((p) => ({
        description: `${p.seed.name} payment`,
        amountCents: p.amountCents,
      })),
      { description: "Everything else — day-to-day spending", amountCents: everythingElse[offset] ?? 115000 },
    ];
    let nextItemId = await nextSeedId(db, schema.monthlyCashOutItems);
    for (const it of items) {
      statements.push(
        db.insert(schema.monthlyCashOutItems).values({
          id: nextItemId++,
          month: m,
          description: await encryptStr(key, it.description),
          amountCents: await encryptNum(key, it.amountCents),
          note: null,
          day: 1,
        }),
      );
    }
  }
  // The smoothed-bill reserve opens with $2,500 already set
  // aside, so the reserve and the Coming up forecast start
  // from a realistic, positive position.
  statements.push(
    db
      .insert(schema.settings)
      .values({ key: "opening_reserve_cents", value: await encryptStr(key, "250000") })
      .onConflictDoNothing(),
  );
  statements.push(
    db
      .insert(schema.settings)
      .values({ key: "reserve_start_month", value: startMonth })
      .onConflictDoNothing(),
  );
  return { ok: true, reason: "Sample household loaded — twelve months of bills, smoothed expenses, and cash-out totals.", statements };
}


/* Build the sample Net Worth seed's insert statements WITHOUT
   executing any of them (contract v64, A3): see
   seedExamplesStatements — the caller commits them as ONE
   db.batch (alone, or together with the spending seed's
   statements in seedFirstRun's single all-or-nothing commit). */
async function seedNetWorthStatements(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  key: CryptoKey,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ ok: boolean; seeded: boolean; reason: string; statements: any[] }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const statements: any[] = [];
  let nextAccountId = await nextSeedId(db, schema.nwAccounts);
  const accountIds: number[] = [];
  for (let i = 0; i < NW_SEED_ACCOUNTS.length; i++) {
    const acct = NW_SEED_ACCOUNTS[i];
    if (!acct) continue;
    const accountId = nextAccountId++;
    accountIds.push(accountId);
    statements.push(
      db.insert(schema.nwAccounts).values({
        id: accountId,
        name: await encryptStr(key, acct.name),
        sortOrder: i,
        archived: 0,
        propertyKind: acct.propertyKind,
        custodial: acct.custodial ? 1 : 0,
      }),
    );
  }
  // Twelve monthly snapshots ending in the current month, on
  // the 1st — the same relative window seedExamples uses for
  // the spending side, so the two sample datasets line up.
  const now = new Date();
  const curMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const startMonth = shiftMonth(curMonth, -(NW_SEED_VALUES.length - 1));
  let nextSnapshotId = await nextSeedId(db, schema.nwSnapshots);
  let nextBalanceId = await nextSeedId(db, schema.nwBalances);
  for (let s = 0; s < NW_SEED_VALUES.length; s++) {
    const values = NW_SEED_VALUES[s];
    if (!values) continue;
    const snapshotId = nextSnapshotId++;
    statements.push(
      db.insert(schema.nwSnapshots).values({
        id: snapshotId,
        date: `${shiftMonth(startMonth, s)}-01`,
        note: await encryptNullable(key, NW_SEED_NOTES[s] ?? null),
      }),
    );
    for (let i = 0; i < accountIds.length; i++) {
      const dollars = values[i];
      const accountId = accountIds[i];
      const acct = NW_SEED_ACCOUNTS[i];
      if (dollars == null || accountId == null || !acct) continue;
      const balanceCents = Math.round(dollars * 100);
      // Split balances go through the same row writer as a
      // hand-entered snapshot, so the stored balance is the
      // sum of its parts by construction.
      const noSplit =
        acct.splitShares.length === 0 ||
        acct.propertyKind !== "none" ||
        acct.custodial;
      let splits: { bucket: NwSplitBucket; amountCents: number }[] | null = null;
      if (!noSplit) {
        splits = [];
        let assigned = 0;
        for (let p = 0; p < acct.splitShares.length; p++) {
          const part = acct.splitShares[p];
          if (!part) continue;
          const isLast = p === acct.splitShares.length - 1;
          const amountCents = isLast
            ? balanceCents - assigned
            : Math.round((balanceCents * part.share) / 1000) * 1000;
          assigned += amountCents;
          splits.push({ bucket: part.bucket, amountCents });
        }
      }
      const rowValues = await nwBalanceRowValues(
        key,
        { accountId, balanceCents, splits },
        noSplit,
      );
      if (!rowValues) continue;
      statements.push(
        db.insert(schema.nwBalances).values({
          id: nextBalanceId++,
          snapshotId,
          accountId,
          ...rowValues,
        }),
      );
    }
  }
  // The sample target, only when no target is stored yet.
  statements.push(
    db
      .insert(schema.settings)
      .values({ key: NW_TARGET_KEY, value: String(NW_SEED_TARGET_CENTS) })
      .onConflictDoNothing(),
  );
  return { ok: true, seeded: true, reason: "Net Worth history seeded from the sample dataset.", statements };
}


/* ---------------- Import batch idempotency (contract v64, F02) ----------------
   importTransactions accepts an OPTIONAL client-supplied batch
   key. The completed batch is recorded as ONE settings row —
   key "import_batch_v1:<batchKey>", value a small JSON record
   { hash, imported } holding only the SHA-256 of the batch's
   canonical row list and the imported count (no financial
   content). Settings storage is deliberate: the row lives in the
   same dataset as the transactions it guards, in BOTH the hosted
   and packaged stores (the same settings table), rides the
   encrypted backup/restore path automatically (settings rows are
   carried in the backup payload and replaced with the dataset on
   restore, so a key and the rows it recorded can never drift
   apart), and is erased by clearAllData together with those
   rows. The claim row is inserted in the SAME db.batch as the
   transaction rows, so a completed batch and its claim commit
   atomically — there is no state where the rows landed but the
   key was not recorded, or the reverse.

   Semantics: a repeat call with the same key and the SAME rows
   (same hash) is a no-op returning the original { imported }
   count — the response-loss retry. The same key with DIFFERENT
   rows (a different hash) is refused with a clear error and
   inserts nothing — a key never silently stands for two
   different batches. A new key with identical rows inserts
   normally: the key guards retries, not content. Requests with
   no key behave exactly as before (no claim is read or written).
   A batch refused by preflight (the reserved-prefix plan)
   records no claim, so fixing the rows and retrying the same
   key is a fresh batch. */
const IMPORT_BATCH_KEY_PREFIX = "import_batch_v1:";
const IMPORT_BATCH_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const importBatchKeyField = z
  .string()
  .min(1)
  .max(128)
  .regex(IMPORT_BATCH_KEY_RE)
  .optional();

type ImportBatchClaim = { hash: string; imported: number };

function importBatchRowsHash(
  rows: {
    date: string;
    description: string;
    amountCents: number;
    sourceType: string;
    accountName: string;
    kind: string;
    category: string;
    yearlyExpenseId: number | null;
    fitId: string | null;
  }[],
): string {
  return sha256Hex(
    JSON.stringify(
      rows.map((r) => [
        r.date,
        r.description,
        r.amountCents,
        r.sourceType,
        r.accountName,
        r.kind,
        r.category,
        r.yearlyExpenseId ?? null,
        r.fitId ?? null,
      ]),
    ),
  );
}

function parseImportBatchClaim(
  value: string,
): ImportBatchClaim | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed == null || typeof parsed !== "object") return null;
    const rec = parsed as Record<string, unknown>;
    if (
      typeof rec.hash !== "string" ||
      typeof rec.imported !== "number" ||
      !Number.isInteger(rec.imported) ||
      rec.imported < 0
    ) {
      return null;
    }
    return { hash: rec.hash, imported: rec.imported };
  } catch {
    return null;
  }
}

const IMPORT_BATCH_COLLISION_MESSAGE =
  "This import batch key was already used for a different set of rows, so nothing was imported. Start a fresh preview to import these rows as a new batch.";

export const Actions = {
  // Machine-readable API contract (model-friendly API, Piece 1):
  // generated AT CALL TIME from the live action definitions —
  // each action's request/response JSON schema comes from the
  // SAME zod schema object passed to its defineAction (carried
  // on the definition as .request/.response), converted with
  // publishedJsonSchema above (the published surface's own
  // conversion, so the additionalProperties flag means exactly
  // what it means there). There is no hand-maintained schema
  // copy to drift. Read-only: reads no data, writes nothing.
  describeApi: defineAction({
    // A-5(a): an optional action filter — a caller learning
    // one action's contract passes { action: "<name>" } and
    // gets the same response with the actions array narrowed
    // to that one entry (empty when the name is not a
    // published action). No argument = the whole contract,
    // byte-stable apart from the fields the hardening package
    // added.
    request: z.object({ action: z.string().min(1).max(120).optional() }),
    response: describeApiResponse,
    async handler(_ctx, args): Promise<DescribeApiResponse> {
      const entries = Object.entries(Actions);
      const missing = entries
        .map(([name]) => name)
        .filter((name) => !(name in ACTION_PURPOSES));
      const visible = args.action
        ? entries.filter(([name]) => name === args.action)
        : entries;
      return {
        ...apiProvenance(),
        units: UNITS_SEMANTICS,
        deltaConvention:
          "runRothCompare deltas are scenario − baseline, in cents: delta = scenario − baseline. A negative deltaNetCostCents means the scenario costs less than the baseline; a positive deltaAcaCreditCents means the scenario keeps more ACA premium credit than the baseline.",
        writersReadersRule: WRITERS_READERS_RULE,
        balanceSemantics: BALANCE_SEMANTICS,
        flexSemantics: FLEX_SEMANTICS,
        protectMinSemantics: PROTECT_MIN_SEMANTICS,
        unpaidTaxSemantics: UNPAID_TAX_SEMANTICS,
        irmaaTierCapSemantics: IRMAA_TIER_CAP_SEMANTICS,
        irmaaLookbackSemantics: IRMAA_LOOKBACK_SEMANTICS,
        ceilingBreachedSemantics: CEILING_BREACHED_SEMANTICS,
        backupAuthenticitySemantics: BACKUP_AUTHENTICITY_SEMANTICS,
        restoreValidationSemantics: RESTORE_VALIDATION_SEMANTICS,
        scoreIdentities: SCORE_IDENTITIES,
        lawYearSemantics: LAW_YEAR_SEMANTICS,
        rmdAgeSemantics: RMD_AGE_SEMANTICS,
        rmdBeneficiarySemantics: RMD_BENEFICIARY_SEMANTICS,
        acaSemantics: ACA_SEMANTICS,
        acaHouseholdScheduleSemantics: ACA_HOUSEHOLD_SCHEDULE_SEMANTICS,
        stateSemantics: STATE_SEMANTICS,
        lossCarryforwardSemantics: LOSS_CARRYFORWARD_SEMANTICS,
        itemizedDeductionSemantics: ITEMIZED_DEDUCTION_SEMANTICS,
        educationCreditSemantics: EDUCATION_CREDIT_SEMANTICS,
        amtSemantics: AMT_SEMANTICS,
        tierSemantics: TIER_SEMANTICS,
        playgroundYearSemantics: PLAYGROUND_YEAR_SEMANTICS,
        taxReturnSemantics: TAX_RETURN_SEMANTICS,
        yearCaptureSemantics: YEAR_CAPTURE_SEMANTICS,
        guardrailsSemantics: GUARDRAILS_SEMANTICS,
        examples: [ROTH_COMPARE_EXAMPLE],
        actions: visible.map(([name, def]) => ({
          name,
          purpose: ACTION_PURPOSES[name] ?? "",
          requestSchema: publishedJsonSchema(def.request),
          responseSchema: publishedJsonSchema(def.response),
        })),
        actionsMissingPurpose: missing,
      };
    },
  }),

  getDashboard: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.object({ month: z.string().regex(monthRe) }),
    response: z.object({
      month: z.string(),
      totalExpectedYearlyCents: z.number(),
      totalAnnualCents: z.number(),
      accrualCents: z.number(),
      incurredCents: z.number(),
      yearlyLumpsCents: z.number(),
      smoothedCents: z.number(),
      cashOutCents: z.number(),
      isSummaryMonth: z.boolean(),
      enteredCashOutCents: z.number().nullable(),
      transactionIncurredCents: z.number(),
      transactionCashOutCents: z.number(),
      transactionCountThisMonth: z.number(),
      yearlyLumpsCheckingCents: z.number(),
      // Total of yearly/periodic expense money that LEFT CHECKING in
      // the viewed month (contract v59): a bill paid from checking
      // counts in its own month; a bill charged to a card counts in
      // the month a card payment settles it (FIFO attribution in the
      // spending core), whether or not the month is an entered-total
      // (summary) month. This is the same settlement-basis figure
      // the smoothed formula subtracts (yearlyLumpsCents) and the
      // Everything else plug subtracts. A bill's settlement month
      // often differs from its scheduled due month and from its
      // charge month, so this uses settlements, never the due
      // schedule and never raw charge dates.
      yearlyPaidOutCents: z.number(),
      summaries: z.array(summaryOut),
      // Cash-out items for the SELECTED month, and whether the selected
      // month's cash out comes from items.
      cashOutItems: z.array(cashOutItemOut),
      cashOutItemsTotalCents: z.number(),
      cashOutItemsCount: z.number(),
      isItemsMonth: z.boolean(),
      // Every month that has an entered total and/or items, with the
      // resolved cash out (items sum wins over the entered total).
      // enteredCashOutCents is null for item-only months; the entered
      // total is still reported alongside the items sum so the UI can
      // show the reconciliation difference when both exist.
      cashOutMonths: z.array(
        z.object({
          month: z.string(),
          enteredCashOutCents: z.number().nullable(),
          itemsTotalCents: z.number(),
          itemsCount: z.number(),
          resolvedCashOutCents: z.number(),
          items: z.array(cashOutItemOut),
        }),
      ),
      monthlyBills: z.array(monthlyBillOut),
      monthlyBillsTotalCents: z.number(),
      // Section-level UI state: true when the whole Monthly bills list
      // is collapsed (every bill shows header-only). One flag for the
      // whole section, persisted server-side in settings so it survives
      // reloads and works across devices. Default (no stored value) is
      // COLLAPSED for all four sections; once the user toggles a
      // section, the stored value ("1" collapsed / "0" expanded) wins.
      monthlyBillsCollapsedAll: z.boolean(),
      yearlyBillsCollapsedAll: z.boolean(),
      byCategoryCollapsedAll: z.boolean(),
      yearInSpendingCollapsedAll: z.boolean(),
      // Sticky entry defaults for the NEW-bill forms (see the entry
      // defaults note above): the Paid from value used last time, or
      // the first-ever fallbacks — "Credit Card" for a new monthly
      // bill, "Checking" (type "checking") for a new yearly bill.
      // Display defaults only: they pre-fill a new form and never
      // override a saved bill's own value.
      lastMonthlyPaidFrom: z.string(),
      lastYearlyPaidByType: z.string(),
      lastYearlyPaidByName: z.string(),
      categoryBreakdown: z.array(
        z.object({
          category: z.string(),
          monthlyCents: z.number(),
          smoothedCents: z.number(),
          totalCents: z.number(),
          billCount: z.number(),
        }),
      ),
      categoryBreakdownTotalCents: z.number(),
      billCategories: z.array(z.string()),
      // "Keep the lights on" floor for the viewed month: checked monthly
      // bills (amount in effect that month) + checked smoothed bills'
      // set-aside for that month. A derived label grouping only — it
      // feeds no other figure.
      keepLightsOnMonthlyCents: z.number(),
      keepLightsOnSmoothedCents: z.number(),
      keepLightsOnTotalCents: z.number(),
      // Year-to-date: for each month from January of the viewed month's
      // calendar year through the viewed month, the SAME six quantities
      // the Quick view tiles display for that month, summed. Computed
      // with the identical per-month helpers as the tiles themselves, so
      // tile and YTD always agree and the partition identity holds:
      // everythingElse = cashOut − totalMonthly − yearlyPaidOut.
      ytd: z.object({
        trueCostCents: z.number(),
        cashOutCents: z.number(),
        totalMonthlyCents: z.number(),
        everythingElseCents: z.number(),
        keepLightsOnCents: z.number(),
        yearlyPaidOutCents: z.number(),
      }),
      remainingOutflowCents: z.number(),
      trailingMonthsCovered: z.number(),
      trailingAvgCents: z.number(),
      avgSmoothedCents: z.number(),
      avgCashOutCents: z.number(),
      divergenceCents: z.number(),
      divergencePct: z.number(),
      reserveCents: z.number(),
      reserveStartMonth: z.string().nullable(),
      openingReserveCents: z.number(),
      hasAnyData: z.boolean(),
      monthTransactions: z.array(txnOut),
      categories: z.array(
        z.object({ category: z.string(), amountCents: z.number() }),
      ),
      history: z.array(
        z.object({
          month: z.string(),
          incurredCents: z.number(),
          cashOutCents: z.number(),
          smoothedCents: z.number(),
          yearlyLumpsCents: z.number(),
          oneOffTotalCents: z.number(),
          hasOneOff: z.boolean(),
          // True when this history month is after the current
          // calendar month — its figures were entered ahead and
          // are estimates, the same flag the entered-ahead rows
          // carry (contract v59, finding F4).
          estimate: z.boolean(),
        }),
      ),
      // Months AFTER the viewed month that already carry entered
      // figures — cash-out items, a directly entered month total, or
      // recorded transactions — each with that month's own effective
      // figures from the same eff() computation every other month
      // uses. The Month-mode chart appends these past the viewed
      // month so figures entered ahead of time are visible; no other
      // surface reads this list, and the trailing averages above are
      // computed without it — they never include any month after
      // the current calendar month, whatever month is viewed.
      enteredAheadMonths: z.array(
        z.object({
          month: z.string(),
          smoothedCents: z.number(),
          cashOutCents: z.number(),
        }),
      ),
      oneOffs: z.array(oneOffOut),
      oneOffsTotalCents: z.number(),
      smoothedExcludingOneOffsCents: z.number(),
      forecast: z.array(
        z.object({
          month: z.string(),
          dueBills: z.array(
            z.object({
              id: z.number(),
              name: z.string(),
              frequency: z.string(),
              expectedCents: z.number(),
              // The amount this bill contributes to totalDueCents:
              // the recorded actual for the month when one exists,
              // otherwise the expected amount. The UI lists THIS
              // figure per bill, so the listed bills always add up
              // to the month's Total due (previously the list showed
              // expectedCents while the total summed actuals, and the
              // two disagreed whenever a recorded payment differed
              // from the expected amount).
              amountCents: z.number(),
            }),
          ),
          totalDueCents: z.number(),
          projectedReserveCents: z.number(),
          shortfallCents: z.number(),
        }),
      ),
      noDueMonthBills: z.array(
        z.object({
          id: z.number(),
          name: z.string(),
          frequency: z.string(),
          expectedCents: z.number(),
          annualCents: z.number(),
        }),
      ),
      yearly: z.array(yearlyOut),
      accountNames: z.array(z.string()),
      // Data-integrity warning lines for this load (bill version
      // chains, payment references, cash-out items). Empty when the
      // stored data passes every check — the UI renders nothing
      // for an empty list.
      integrityWarnings: z.array(z.string()),
    }),
    async handler(ctx, args) {
      const { txns, yearly, yearlyVersions, summaries, bills, billVersions, oneOffs, cashOutItems, settingsMap, key } =
        await loadAll(ctx);
      const month = args.month;
      // Sticky entry defaults for the new-bill forms (fallbacks on
      // first-ever use, before anything has been stored).
      const storedMonthlyPaidFrom = await decryptSettingValue(
        key,
        settingsMap.get(ENTRY_DEFAULT_MONTHLY_PAID_FROM_KEY),
      );
      const lastMonthlyPaidFrom =
        storedMonthlyPaidFrom && storedMonthlyPaidFrom.trim() !== ""
          ? storedMonthlyPaidFrom
          : MONTHLY_PAID_FROM_FALLBACK;
      const storedYearlyPaidType = settingsMap.get(
        ENTRY_DEFAULT_YEARLY_PAID_TYPE_KEY,
      );
      const lastYearlyPaidByType =
        storedYearlyPaidType === "card" ? "card" : "checking";
      const storedYearlyPaidName = await decryptSettingValue(
        key,
        settingsMap.get(ENTRY_DEFAULT_YEARLY_PAID_NAME_KEY),
      );
      const lastYearlyPaidByName =
        storedYearlyPaidName && storedYearlyPaidName.trim() !== ""
          ? storedYearlyPaidName
          : YEARLY_PAID_NAME_FALLBACK;
      const openingReserveCents = Number(
        settingsMap.get("opening_reserve_cents") ?? "0",
      );
      // The per-month computation (accrual, the cash-out resolution,
      // the reserve, the forecast) lives in the shared spending core
      // (server/src/spendingCore.ts) — the same code the Year Summary
      // and the accuracy fixtures run.
      const core = createSpendingCore({
        txns,
        yearly,
        yearlyVersions,
        summaries,
        cashOutItems,
        bills,
        billVersions,
        oneOffs,
        openingReserveCents,
        reserveStartSetting: settingsMap.get("reserve_start_month") ?? null,
      });
      const {
        yearlyVersionsByExpense,
        byMonth,
        summaryByMonth,
        itemsByMonth,
        totalAnnualForMonth,
        accrualForMonth,
        eff,
        earliest,
        reserveStartMonth,
        monthlyTotalForMonth,
        keepLightsOnForMonth,
        yearlyPaidOutForMonth,
      } = core;
      const totalAnnualCents = totalAnnualForMonth(month);
      const totalExpectedYearlyCents = totalAnnualCents;
      const accrualCents = accrualForMonth(month);

      const cur = core.monthAgg(month);
      const curEff = eff(month);
      const isSummaryMonth = summaryByMonth.has(month);
      const isItemsMonth = itemsByMonth.has(month);
      const smoothedCents = curEff.smoothed;

      // Trailing window: up to 12 months ending at the earlier of
      // the selected month and the current calendar month, and only
      // months from the first month that has data — and
      // NEVER past the current calendar month (contract v59,
      // finding F4): when a future month is selected, the averages
      // still cover only months up to the current month, so figures
      // entered ahead can never blend into the "actual" averages.
      const nowForTrailing = new Date();
      const currentMonthStr = `${nowForTrailing.getFullYear()}-${String(nowForTrailing.getMonth() + 1).padStart(2, "0")}`;
      const trailingEnd = month < currentMonthStr ? month : currentMonthStr;
      const windowStart = shiftMonth(trailingEnd, -11);
      const coveredStart =
        earliest && earliest > windowStart ? earliest : windowStart;
      const trailingMonthsCovered =
        earliest == null || coveredStart > trailingEnd
          ? 0
          : Math.max(0, monthsBetween(coveredStart, trailingEnd) + 1);
      let trailingSum = 0;
      let smoothedSum = 0;
      let cashOutSum = 0;
      for (let i = 0; i < trailingMonthsCovered; i++) {
        const m = shiftMonth(coveredStart, i);
        const e = eff(m);
        trailingSum += e.incurred;
        smoothedSum += e.smoothed;
        cashOutSum += e.cashOut;
      }
      const trailingAvgCents =
        trailingMonthsCovered > 0
          ? Math.round(trailingSum / trailingMonthsCovered)
          : 0;
      const avgSmoothedCents =
        trailingMonthsCovered > 0
          ? Math.round(smoothedSum / trailingMonthsCovered)
          : 0;
      // Cash-out average over the SAME trailing window as the two
      // averages above (same months, same rounding): the Quick view
      // averages line reads this beside avgSmoothedCents, so the
      // line can never disagree with the dashboard's own window.
      const avgCashOutCents =
        trailingMonthsCovered > 0
          ? Math.round(cashOutSum / trailingMonthsCovered)
          : 0;
      const divergenceCents = avgSmoothedCents - trailingAvgCents;
      const divergencePct =
        trailingAvgCents !== 0
          ? divergenceCents / Math.abs(trailingAvgCents)
          : 0;

      // Reserve: accrual minus lumps, accumulated from the start month.
      // Every month counts only the lumps whose money left checking
      // that month (the settlement basis), matching
      // the smoothed formula for those months.
      const reserveCents = core.reserveThrough(month);

      const oneOffsByMonth = new Map<string, number>();
      for (const o of oneOffs) {
        oneOffsByMonth.set(o.month, (oneOffsByMonth.get(o.month) ?? 0) + o.amountCents);
      }
      const monthOneOffs = oneOffs
        .filter((o) => o.month === month)
        .map((o) => ({
          id: o.id,
          month: o.month,
          description: o.description,
          amountCents: o.amountCents,
          note: o.note ?? null,
        }));
      const oneOffsTotalCents = monthOneOffs.reduce((s, o) => s + o.amountCents, 0);
      const smoothedExcludingOneOffsCents = smoothedCents - oneOffsTotalCents;

      const history = [];
      for (let i = 11; i >= 0; i--) {
        const m = shiftMonth(month, -i);
        const e = eff(m);
        // Months before tracking started show nothing — the set-aside
        // only applies once there is data.
        const beforeStart = earliest != null && m < earliest;
        const ooTotal = oneOffsByMonth.get(m) ?? 0;
        history.push({
          month: m,
          incurredCents: e.incurred,
          cashOutCents: e.cashOut,
          smoothedCents: beforeStart ? 0 : e.smoothed,
          yearlyLumpsCents: e.lumps,
          oneOffTotalCents: ooTotal,
          hasOneOff: ooTotal !== 0,
          // Entered-ahead months keep their estimate flag in the
          // history rows too (contract v59, finding F4).
          estimate: m > currentMonthStr,
        });
      }

      // Months after the viewed month that already carry entered
      // figures (an entered total, cash-out items, or any recorded
      // transaction), with that month's own effective figures.
      const enteredAheadMonths = [
        ...new Set([
          ...[...summaryByMonth.keys()].filter((m) => m > month),
          ...[...itemsByMonth.keys()].filter((m) => m > month),
          ...[...byMonth.keys()].filter((m) => m > month),
        ]),
      ]
        .sort()
        .map((m) => {
          const e = eff(m);
          return { month: m, smoothedCents: e.smoothed, cashOutCents: e.cashOut };
        });

      // ---- Forecast: the viewed month and the next 2 ----
      // Computed by the shared spending core (see spendingCore.ts):
      // recorded actuals where they exist, expected amounts for
      // bills due, and a projected reserve that counts every
      // recorded payment exactly once.
      const forecast = core.forecastFor(month);

      const noDueMonthBills = yearly
        .filter((y) => y.dueMonth == null)
        .map((y) => {
          const vs = yearlyVersionsByExpense.get(y.id) ?? [];
          const vRaw = yearlyVersionInEffect(vs, month, y.backfillBeforeFirstVersion === 1);
          const latest = latestYearlyVersion(vs);
          const effFreq = vRaw && vRaw !== null ? vRaw.frequency : (latest?.frequency ?? y.frequency);
          const effExpected = vRaw && vRaw !== null ? vRaw.expectedCents : (latest?.expectedCents ?? y.expectedCents);
          return {
            id: y.id,
            name: y.name,
            frequency: effFreq as string,
            expectedCents: effExpected,
            annualCents: annualCentsForValues(effExpected, effFreq as string),
          };
        });

      const catMap = new Map<string, number>();
      for (const t of txns) {
        if (monthOf(t.date) === month && t.kind === "spending") {
          catMap.set(t.category, (catMap.get(t.category) ?? 0) + t.amountCents);
        }
      }
      const categories = [...catMap.entries()]
        .map(([category, amountCents]) => ({ category, amountCents }))
        .filter((c) => c.amountCents !== 0)
        .sort((a, b) => b.amountCents - a.amountCents);

      const monthTransactions = txns
        .filter((t) => monthOf(t.date) === month)
        .map((t) => ({
          id: t.id,
          date: t.date,
          description: t.description,
          amountCents: t.amountCents,
          sourceType: t.sourceType,
          accountName: t.accountName,
          kind: t.kind,
          category: t.category,
          yearlyExpenseId: t.yearlyExpenseId ?? null,
        }))
        .reverse();

      const accountNames = [
        ...new Set([
          ...txns.map((t) => t.accountName),
          ...yearly.map((y) => y.paidByName),
          "Checking",
        ]),
      ];

      // Bill amounts are versioned: this month's breakdown uses the
      // version in effect for THIS month, so a future amount change
      // never rewrites an earlier month's total or the amount left after monthly bills.
      const versionsByBill = new Map<number, BillVersionRow[]>();
      for (const v of billVersions) {
        const arr = versionsByBill.get(v.billId) ?? [];
        arr.push(v);
        versionsByBill.set(v.billId, arr);
      }
      const billsOut = bills.map((b) => {
        const vs = versionsByBill.get(b.id) ?? [];
        const inEffect = versionInEffect(vs, month);
        const latest = latestVersion(vs);
        return {
          id: b.id,
          name: b.name,
          amountCents: inEffect?.amountCents ?? 0,
          effectiveFrom: inEffect?.effectiveFrom ?? null,
          latestAmountCents: latest?.amountCents ?? b.amountCents,
          paidBy: b.paidBy,
          notes: b.notes ?? null,
          category: b.category,
          keepLightsOn: b.keepLightsOn === 1,
          history: [...vs]
            .sort((a, c) =>
              a.effectiveFrom === c.effectiveFrom
                ? c.id - a.id
                : a.effectiveFrom < c.effectiveFrom
                  ? 1
                  : -1,
            )
            .map((v) => ({
              id: v.id,
              amountCents: v.amountCents,
              effectiveFrom: v.effectiveFrom,
            })),
          _inEffectCents: inEffect?.amountCents ?? 0,
        };
      });
      const monthlyBillsTotalCents = billsOut.reduce(
        (s, b) => s + b._inEffectCents,
        0,
      );
      const yearlyOuts = yearly.map((y) =>
        yearlyOutFor(y, txns, month, yearlyVersionsByExpense.get(y.id) ?? []),
      );
      // By-category breakdown: a label-only grouping. Monthly part uses
      // the amount version in effect for this month; smoothed part uses
      // each bill's monthly set-aside for this month. Categories feed no
      // other figure; the grand total is monthly bills total + accrual.
      const catBreakMap = new Map<
        string,
        { monthlyCents: number; smoothedCents: number; billCount: number }
      >();
      for (const b of billsOut) {
        const e = catBreakMap.get(b.category) ?? {
          monthlyCents: 0,
          smoothedCents: 0,
          billCount: 0,
        };
        e.monthlyCents += b._inEffectCents;
        e.billCount += 1;
        catBreakMap.set(b.category, e);
      }
      for (const y of yearlyOuts) {
        const e = catBreakMap.get(y.category) ?? {
          monthlyCents: 0,
          smoothedCents: 0,
          billCount: 0,
        };
        e.smoothedCents += y.monthlyAccrualCents;
        e.billCount += 1;
        catBreakMap.set(y.category, e);
      }
      const categoryBreakdown = [...catBreakMap.entries()]
        .map(([category, e]) => ({
          category,
          monthlyCents: e.monthlyCents,
          smoothedCents: e.smoothedCents,
          totalCents: e.monthlyCents + e.smoothedCents,
          billCount: e.billCount,
        }))
        .sort(
          (a, b) =>
            b.totalCents - a.totalCents || a.category.localeCompare(b.category),
        );
      const categoryBreakdownTotalCents = categoryBreakdown.reduce(
        (s, c) => s + c.totalCents,
        0,
      );
      const billCategories = [
        ...new Set([
          ...bills.map((b) => b.category),
          ...yearly.map((y) => y.category),
        ]),
      ].sort((a, b) => a.localeCompare(b));
      // Keep-the-lights-on floor: the checked bills only, using this
      // month's in-effect amounts — monthly bills at their version in
      // effect, smoothed bills at their monthly set-aside in effect.
      const keepLightsOnMonthlyCents = billsOut.reduce(
        (s, b) => s + (b.keepLightsOn ? b._inEffectCents : 0),
        0,
      );
      const keepLightsOnSmoothedCents = yearlyOuts.reduce(
        (s, y) => s + (y.keepLightsOn ? y.monthlyAccrualCents : 0),
        0,
      );
      const keepLightsOnTotalCents =
        keepLightsOnMonthlyCents + keepLightsOnSmoothedCents;

      // ---- Year-to-date (Quick view) ----
      // Sum the six tile quantities over January of the viewed month's
      // calendar year through the viewed month, using the same
      // per-month figures the tiles show. Months before tracking
      // started (before the earliest data month) contribute 0.
      // The per-month totals come from the shared spending core
      // (monthlyTotalForMonth / keepLightsOnForMonth, destructured
      // above) — the same implementation every other surface uses.
      const ytd = {
        trueCostCents: 0,
        cashOutCents: 0,
        totalMonthlyCents: 0,
        everythingElseCents: 0,
        keepLightsOnCents: 0,
        yearlyPaidOutCents: 0,
      };
      {
        const jan = `${month.slice(0, 4)}-01`;
        const n = monthsBetween(jan, month) + 1;
        for (let i = 0; i < n; i++) {
          const m = shiftMonth(jan, i);
          if (earliest != null && m < earliest) continue;
          const e = eff(m);
          const mt = monthlyTotalForMonth(m);
          const paid = yearlyPaidOutForMonth(m);
          ytd.trueCostCents += e.smoothed;
          ytd.cashOutCents += e.cashOut;
          ytd.totalMonthlyCents += mt;
          ytd.everythingElseCents += e.cashOut - mt - paid;
          ytd.keepLightsOnCents += keepLightsOnForMonth(m);
          ytd.yearlyPaidOutCents += paid;
        }
      }
      return {
        month,
        totalExpectedYearlyCents,
        totalAnnualCents,
        accrualCents,
        incurredCents: curEff.incurred,
        yearlyLumpsCents: curEff.lumps,
        smoothedCents,
        cashOutCents: curEff.cashOut,
        isSummaryMonth,
        enteredCashOutCents: summaryByMonth.get(month) ?? null,
        transactionIncurredCents: cur.incurred,
        transactionCashOutCents: cur.cashOut,
        transactionCountThisMonth: txns.filter(
          (t) => monthOf(t.date) === month,
        ).length,
        yearlyLumpsCheckingCents: cur.lumpsChecking,
        yearlyPaidOutCents: yearlyPaidOutForMonth(month),
        summaries: summaries.map((s) => ({
          month: s.month,
          cashOutCents: s.cashOutCents,
        })),
        cashOutItems: cashOutItems
          .filter((it) => it.month === month)
          .map((it) => ({
            id: it.id,
            month: it.month,
            description: it.description,
            amountCents: it.amountCents,
            note: it.note ?? null,
            day: it.day,
          })),
        cashOutItemsTotalCents: itemsByMonth.get(month)?.total ?? 0,
        cashOutItemsCount: itemsByMonth.get(month)?.count ?? 0,
        isItemsMonth,
        cashOutMonths: [
          ...new Set([
            ...summaries.map((s) => s.month),
            ...cashOutItems.map((it) => it.month),
          ]),
        ]
          .sort()
          .map((m) => {
            const entered = summaryByMonth.get(m) ?? null;
            const items = itemsByMonth.get(m);
            return {
              month: m,
              enteredCashOutCents: entered,
              itemsTotalCents: items?.total ?? 0,
              itemsCount: items?.count ?? 0,
              resolvedCashOutCents: items ? items.total : (entered ?? 0),
              items: cashOutItems
                .filter((it) => it.month === m)
                .map((it) => ({
                  id: it.id,
                  month: it.month,
                  description: it.description,
                  amountCents: it.amountCents,
                  note: it.note ?? null,
                  day: it.day,
                })),
            };
          }),
        monthlyBills: billsOut.map(({ _inEffectCents, ...b }) => b),
        monthlyBillsTotalCents,
        monthlyBillsCollapsedAll:
          settingsMap.get("monthly_bills_collapsed_all") !== "0",
        yearlyBillsCollapsedAll:
          settingsMap.get("yearly_bills_collapsed_all") !== "0",
        byCategoryCollapsedAll:
          settingsMap.get("by_category_collapsed_all") !== "0",
        yearInSpendingCollapsedAll:
          settingsMap.get("year_in_spending_collapsed_all") !== "0",
        lastMonthlyPaidFrom,
        lastYearlyPaidByType,
        lastYearlyPaidByName,
        categoryBreakdown,
        categoryBreakdownTotalCents,
        billCategories,
        keepLightsOnMonthlyCents,
        keepLightsOnSmoothedCents,
        keepLightsOnTotalCents,
        ytd,
        remainingOutflowCents: curEff.cashOut - monthlyBillsTotalCents,
        trailingMonthsCovered,
        trailingAvgCents,
        avgSmoothedCents,
        avgCashOutCents,
        divergenceCents,
        divergencePct,
        reserveCents,
        reserveStartMonth: reserveStartMonth ?? null,
        openingReserveCents,
        hasAnyData:
          txns.length > 0 ||
          yearly.length > 0 ||
          summaries.length > 0 ||
          bills.length > 0 ||
          oneOffs.length > 0 ||
          cashOutItems.length > 0,
        monthTransactions,
        categories,
        history,
        enteredAheadMonths,
        oneOffs: monthOneOffs,
        oneOffsTotalCents,
        smoothedExcludingOneOffsCents,
        forecast,
        noDueMonthBills,
        yearly: yearlyOuts,
        accountNames,
        integrityWarnings: integrityWarningLines([
          checkBillVersionChains({ txns, yearly, yearlyVersions, summaries, bills, billVersions, cashOutItems }),
          checkPaymentReferences({ txns, yearly, yearlyVersions, summaries, bills, billVersions, cashOutItems }),
          checkCashOutItems({ txns, yearly, yearlyVersions, summaries, bills, billVersions, cashOutItems }),
        ]),
      };
    },
  }),

  // Read-only Year view for the Quick view: twelve month panels, each
  // carrying that month's own Quick view figures. Reuses the exact
  // same per-month computation as getDashboard / YTD / explorer: one
  // math path, so a month panel and the Month-mode tiles for that
  // month can never disagree. It never writes anything.
  // `totals` sums the summary window only (January through the current
  // month for the current year, the full year otherwise) over months
  // that have data; panels cover all twelve months regardless.
  getYearView: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.object({ year: z.number().int().min(1900).max(2200) }),
    response: z.object({
      year: z.number(),
      currentYear: z.number(),
      currentMonth: z.string(),
      windowStart: z.string(),
      windowEnd: z.string(),
      windowMonths: z.number(),
      isCurrentYear: z.boolean(),
      earliestMonth: z.string().nullable(),
      hasAnyData: z.boolean(),
      months: z.array(
        z.object({
          month: z.string(),
          monthNum: z.number(),
          inWindow: z.boolean(),
          hasData: z.boolean(),
          trueCostCents: z.number(),
          cashOutCents: z.number(),
          totalMonthlyCents: z.number(),
          everythingElseCents: z.number(),
          keepLightsOnCents: z.number(),
          yearlyPaidOutCents: z.number(),
          oneOffsTotalCents: z.number(),
          oneOffsCount: z.number(),
        }),
      ),
      totals: z.object({
        trueCostCents: z.number(),
        cashOutCents: z.number(),
        totalMonthlyCents: z.number(),
        everythingElseCents: z.number(),
        keepLightsOnCents: z.number(),
        yearlyPaidOutCents: z.number(),
      }),
    }),
    async handler(ctx, args) {
      const { txns, yearly, yearlyVersions, summaries, bills, billVersions, oneOffs, cashOutItems } =
        await loadAll(ctx);
      const year = args.year;

      const now = new Date();
      const currentYear = now.getFullYear();
      const currentMonthStr = `${currentYear}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const isCurrentYear = year === currentYear;
      const windowStart = `${year}-01`;
      const windowEnd = isCurrentYear ? currentMonthStr : `${year}-12`;
      const windowMonths = monthsBetween(windowStart, windowEnd) + 1;

      // --- Same per-month computation as getDashboard: the
      // shared spending core (server/src/spendingCore.ts) ---
      const core = createSpendingCore({
        txns,
        yearly,
        yearlyVersions,
        summaries,
        cashOutItems,
        bills,
        billVersions,
        oneOffs,
      });
      const { eff, monthlyTotalForMonth, keepLightsOnForMonth } = core;

      const txnEarliest = txns.length > 0 ? monthOf(txns[0]?.date ?? windowStart) : null;
      const sumEarliest = summaries.length > 0 ? (summaries[0]?.month ?? null) : null;
      const itemEarliest = cashOutItems.length > 0 ? (cashOutItems[0]?.month ?? null) : null;
      const earliestMonth =
        [txnEarliest, sumEarliest, itemEarliest]
          .filter((v): v is string => v != null)
          .sort()[0] ?? null;

      const oneOffsByMonth = new Map<string, { total: number; count: number }>();
      for (const o of oneOffs) {
        const cur = oneOffsByMonth.get(o.month) ?? { total: 0, count: 0 };
        cur.total += o.amountCents;
        cur.count += 1;
        oneOffsByMonth.set(o.month, cur);
      }

      // A month "has data" when anything real happened or was in
      // effect that month: a monthly bill version in effect, a
      // smoothed bill whose first version has started (checked WITHOUT
      // the legacy backfill fallback, so months before a bill existed
      // don't count it), any transaction, an entered cash-out total,
      // cash-out items, one-offs, or a recorded smoothed-bill payment.
      // Months with bills in effect but no cash out yet (e.g. future
      // months of the current year) still count — they get full
      // panels with their real bill-based figures. The rule itself
      // lives in the shared spending core (monthHasData).
      const monthHasData = core.monthHasData;
      const figuresForMonth = (m: string, hasData: boolean) => {
        const oo = oneOffsByMonth.get(m) ?? { total: 0, count: 0 };
        if (!hasData) {
          return { trueCostCents: 0, cashOutCents: 0, totalMonthlyCents: 0, everythingElseCents: 0, keepLightsOnCents: 0, yearlyPaidOutCents: 0, oneOffsTotalCents: oo.total, oneOffsCount: oo.count };
        }
        const e = eff(m);
        const mt = monthlyTotalForMonth(m);
        const paid = core.yearlyPaidOutForMonth(m);
        return {
          trueCostCents: e.smoothed,
          cashOutCents: e.cashOut,
          totalMonthlyCents: mt,
          everythingElseCents: e.cashOut - mt - paid,
          keepLightsOnCents: keepLightsOnForMonth(m),
          yearlyPaidOutCents: paid,
          oneOffsTotalCents: oo.total,
          oneOffsCount: oo.count,
        };
      };

      const months = [];
      const totals = { trueCostCents: 0, cashOutCents: 0, totalMonthlyCents: 0, everythingElseCents: 0, keepLightsOnCents: 0, yearlyPaidOutCents: 0 };
      let hasAnyData = false;
      for (let n = 1; n <= 12; n++) {
        const m = `${year}-${String(n).padStart(2, "0")}`;
        const inWindow = m >= windowStart && m <= windowEnd;
        const hasData = monthHasData(m);
        const figs = figuresForMonth(m, hasData);
        if (hasData) hasAnyData = true;
        if (hasData && inWindow) {
          totals.trueCostCents += figs.trueCostCents;
          totals.cashOutCents += figs.cashOutCents;
          totals.totalMonthlyCents += figs.totalMonthlyCents;
          totals.everythingElseCents += figs.everythingElseCents;
          totals.keepLightsOnCents += figs.keepLightsOnCents;
          totals.yearlyPaidOutCents += figs.yearlyPaidOutCents;
        }
        months.push({ month: m, monthNum: n, inWindow, hasData, ...figs });
      }

      return {
        year,
        currentYear,
        currentMonth: currentMonthStr,
        windowStart,
        windowEnd,
        windowMonths,
        isCurrentYear,
        earliestMonth,
        hasAnyData,
        months,
        totals,
      };
    },
  }),

  // Read-only explorer ("slice & dice"). Reuses the exact same
  // per-month computation as getDashboard: monthly bills at the
  // version in effect for the month, smoothed bills at their monthly
  // set-aside via yearlyOutFor / yearlyVersionInEffect, summary-month
  // cash-out handling in eff(), and one-offs as explanation totals.
  // It never writes anything.
  getExplorer: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.object({
      fromMonth: z.string().regex(monthRe),
      toMonth: z.string().regex(monthRe),
      groupBy: z.enum(["category", "bill", "paidFrom", "keepLightsOn", "month"]),
    }),
    response: z.object({
      fromMonth: z.string(),
      toMonth: z.string(),
      groupBy: z.string(),
      months: z.array(z.string()),
      earliestMonth: z.string().nullable(),
      rows: z.array(
        z.object({
          label: z.string(),
          valuesCents: z.array(z.number()),
          totalCents: z.number(),
        }),
      ),
      columnTotalsCents: z.array(z.number()),
      grandTotalCents: z.number(),
      monthRows: z.array(
        z.object({
          month: z.string(),
          cashOutCents: z.number(),
          trueCostCents: z.number(),
          totalMonthlyCents: z.number(),
          yearlyPaidOutCents: z.number(),
          everythingElseCents: z.number(),
          oneOffsCents: z.number(),
        }),
      ),
      monthTotals: z.object({
        cashOutCents: z.number(),
        trueCostCents: z.number(),
        totalMonthlyCents: z.number(),
        yearlyPaidOutCents: z.number(),
        everythingElseCents: z.number(),
        oneOffsCents: z.number(),
      }),
    }),
    async handler(ctx, args) {
      const { txns, yearly, yearlyVersions, summaries, bills, billVersions, oneOffs, cashOutItems } =
        await loadAll(ctx);
      let fromMonth = args.fromMonth;
      let toMonth = args.toMonth;
      if (fromMonth > toMonth) {
        const tmp = fromMonth;
        fromMonth = toMonth;
        toMonth = tmp;
      }
      // Cap the range at 36 months.
      if (monthsBetween(fromMonth, toMonth) + 1 > 36) {
        toMonth = shiftMonth(fromMonth, 35);
      }
      const monthCount = monthsBetween(fromMonth, toMonth) + 1;
      const months: string[] = [];
      for (let i = 0; i < monthCount; i++) months.push(shiftMonth(fromMonth, i));

      const txnEarliest = txns.length > 0 ? monthOf(txns[0]?.date ?? fromMonth) : null;
      const sumEarliest = summaries.length > 0 ? (summaries[0]?.month ?? null) : null;
      const itemEarliest = cashOutItems.length > 0 ? (cashOutItems[0]?.month ?? null) : null;
      const earliestMonth =
        [txnEarliest, sumEarliest, itemEarliest]
          .filter((v): v is string => v != null)
          .sort()[0] ?? null;

      // --- Same per-month computation as getDashboard: the
      // shared spending core (server/src/spendingCore.ts). The
      // core's version maps also feed the bill pivot below. ---
      const core = createSpendingCore({
        txns,
        yearly,
        yearlyVersions,
        summaries,
        cashOutItems,
        bills,
        billVersions,
        oneOffs,
      });
      const {
        yearlyVersionsByExpense,
        versionsByBill,
        eff,
        monthlyTotalForMonth,
      } = core;
      const oneOffsByMonth = new Map<string, number>();
      for (const o of oneOffs) {
        oneOffsByMonth.set(o.month, (oneOffsByMonth.get(o.month) ?? 0) + o.amountCents);
      }

      // --- Month view rows (same aggregates as the Quick view) ---
      const monthRows = months.map((m) => {
        const e = eff(m);
        const mt = monthlyTotalForMonth(m);
        const paid = core.yearlyPaidOutForMonth(m);
        return {
          month: m,
          cashOutCents: e.cashOut,
          trueCostCents: e.smoothed,
          totalMonthlyCents: mt,
          yearlyPaidOutCents: paid,
          everythingElseCents: e.cashOut - mt - paid,
          oneOffsCents: oneOffsByMonth.get(m) ?? 0,
        };
      });
      const monthTotals = monthRows.reduce(
        (acc, r) => ({
          cashOutCents: acc.cashOutCents + r.cashOutCents,
          trueCostCents: acc.trueCostCents + r.trueCostCents,
          totalMonthlyCents: acc.totalMonthlyCents + r.totalMonthlyCents,
          yearlyPaidOutCents: acc.yearlyPaidOutCents + r.yearlyPaidOutCents,
          everythingElseCents: acc.everythingElseCents + r.everythingElseCents,
          oneOffsCents: acc.oneOffsCents + r.oneOffsCents,
        }),
        { cashOutCents: 0, trueCostCents: 0, totalMonthlyCents: 0, yearlyPaidOutCents: 0, everythingElseCents: 0, oneOffsCents: 0 },
      );

      // --- Bill pivot (all groupings except Month) ---
      type BillEntry = { label: string; category: string; paidFrom: string; keepLightsOn: boolean; values: number[] };
      const entries: BillEntry[] = [];
      for (const b of bills) {
        const values = months.map((m) => versionInEffect(versionsByBill.get(b.id) ?? [], m)?.amountCents ?? 0);
        entries.push({ label: b.name, category: b.category, paidFrom: b.paidBy, keepLightsOn: b.keepLightsOn === 1, values });
      }
      for (const y of yearly) {
        const values = months.map((m) => yearlyOutFor(y, txns, m, yearlyVersionsByExpense.get(y.id) ?? []).monthlyAccrualCents);
        entries.push({ label: y.name, category: y.category, paidFrom: y.paidByName, keepLightsOn: y.keepLightsOn === 1, values });
      }
      const groupLabelFor = (e: BillEntry): string => {
        if (args.groupBy === "bill") return e.label;
        if (args.groupBy === "paidFrom") return e.paidFrom || "Checking";
        if (args.groupBy === "keepLightsOn") return e.keepLightsOn ? "Keep the lights on" : "Not essential";
        return e.category || "Uncategorized";
      };
      const groupMap = new Map<string, { label: string; valuesCents: number[] }>();
      if (args.groupBy !== "month") {
        for (const e of entries) {
          const label = groupLabelFor(e);
          const g = groupMap.get(label) ?? { label, valuesCents: months.map(() => 0) };
          e.values.forEach((v, i) => {
            g.valuesCents[i] = (g.valuesCents[i] ?? 0) + v;
          });
          groupMap.set(label, g);
        }
      }
      const rows = [...groupMap.values()]
        .map((g) => ({ label: g.label, valuesCents: g.valuesCents, totalCents: g.valuesCents.reduce((s, v) => s + v, 0) }))
        .sort((a, b) => b.totalCents - a.totalCents || a.label.localeCompare(b.label));
      // "Other spending" (day-to-day, not bills) is not part of the
      // bill pivot above, but it is real money. Append it as ONE
      // final row (after the sorted bill rows, never sorted into
      // them) so each month column totals to that month's True cost
      // and the grand total equals the range's total True cost. The
      // row is therefore the True-cost residual — True cost minus
      // the bill pivot's own column total — NOT the Quick view's
      // cash-out-based Everything else (Cash out − Total monthly −
      // Yearly paid out, kept as-is in monthRows / Month grouping).
      // The two are different quantities and, since contract v59
      // (finding F5), carry different labels: the plug keeps
      // "Everything else"; this residual is "Other spending". Since
      // the v59 cash-basis unification the two agree whenever a
      // month's cash out equals its True cost basis with no
      // unsettled card-paid smoothed bills; using the cash-out
      // figure here would drop card amounts from the column totals
      // (verified pre-v59: a $500 card charge in a transaction-only
      // month, and a $1,200 card-paid yearly bill in an
      // entered-total month, each vanished from the totals).
      if (args.groupBy !== "month") {
        const everythingElseValues = monthRows.map(
          (r, i) =>
            r.trueCostCents -
            rows.reduce((s, row) => s + (row.valuesCents[i] ?? 0), 0),
        );
        const everythingElseTotal = everythingElseValues.reduce((s, v) => s + v, 0);
        if (rows.length > 0 || everythingElseValues.some((v) => v !== 0)) {
          rows.push({
            label: "Other spending",
            valuesCents: everythingElseValues,
            totalCents: everythingElseTotal,
          });
        }
      }
      const columnTotalsCents = months.map((_, i) => rows.reduce((s, r) => s + (r.valuesCents[i] ?? 0), 0));
      const grandTotalCents = columnTotalsCents.reduce((s, v) => s + v, 0);

      return {
        fromMonth,
        toMonth,
        groupBy: args.groupBy as string,
        months,
        earliestMonth,
        rows: args.groupBy === "month" ? [] : rows,
        columnTotalsCents: args.groupBy === "month" ? [] : columnTotalsCents,
        grandTotalCents: args.groupBy === "month" ? 0 : grandTotalCents,
        monthRows,
        monthTotals,
      };
    },
  }),

  addTransaction: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: txnInput,
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      const [row] = await db
        .insert(schema.transactions)
        .values({
          date: args.date,
          description: await encryptStr(key, args.description),
          amountCents: await encryptNum(key, args.amountCents),
          sourceType: args.sourceType,
          accountName: await encryptStr(key, args.accountName),
          kind: args.kind,
          category: await encryptStr(key, args.category),
          yearlyExpenseId: args.yearlyExpenseId,
        })
        .returning({ id: schema.transactions.id });
      if (!row) throw new Error("insert failed");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  updateTransaction: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    // Contract v65 (CAS sweep, F13): `base` is the transaction as
    // the editor loaded it. When supplied, the write is a GUARDED
    // update: it applies only where the stored row still equals
    // the base fields (compared decrypted, then re-checked against
    // the raw stored values inside the UPDATE's WHERE, so a write
    // landing between the read and the commit also refuses). A
    // mismatch returns the conflict shape and the stored newer
    // value stays intact. A call omitting `base` keeps the legacy
    // unchecked behaviour (named in DATA-PLAN).
    request: txnInput.extend({
      id: z.number().int().positive(),
      base: z
        .object({
          date: dateString,
          description: descriptionField,
          amountCents: z.number().int(),
          sourceType,
          accountName: paidByField,
          kind: txnKind,
          category: txnCategoryField,
          yearlyExpenseId: z.number().int().positive().nullable(),
        })
        .optional(),
    }),
    response: okReasonResponse,
    async handler(ctx, args): Promise<OkReason> {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      const { base, ...fields } = args;
      let guardRaw: typeof schema.transactions.$inferSelect | undefined;
      if (base !== undefined) {
        const [raw] = await db
          .select()
          .from(schema.transactions)
          .where(eq(schema.transactions.id, args.id));
        if (!raw) {
          return { ok: false, reason: "That transaction was not found." };
        }
        const stored = {
          date: raw.date,
          description: await decryptStr(key, raw.description),
          amountCents: await decryptNum(key, raw.amountCents as unknown),
          sourceType: raw.sourceType,
          accountName: await decryptStr(key, raw.accountName),
          kind: raw.kind,
          category: await decryptStr(key, raw.category),
          yearlyExpenseId: raw.yearlyExpenseId ?? null,
        };
        const mismatch = casFieldMismatch(stored, base, [
          "date",
          "description",
          "amountCents",
          "sourceType",
          "accountName",
          "kind",
          "category",
          "yearlyExpenseId",
        ]);
        if (mismatch) {
          return {
            ok: false,
            conflict: true,
            reason: casConflictReason("transaction"),
          };
        }
        guardRaw = raw;
      }
      const updated = await db
        .update(schema.transactions)
        .set({
          date: fields.date,
          description: await encryptStr(key, fields.description),
          amountCents: await encryptNum(key, fields.amountCents),
          sourceType: fields.sourceType,
          accountName: await encryptStr(key, fields.accountName),
          kind: fields.kind,
          category: await encryptStr(key, fields.category),
          yearlyExpenseId: fields.yearlyExpenseId,
        })
        .where(
          guardRaw
            ? and(
                eq(schema.transactions.id, args.id),
                eq(schema.transactions.date, guardRaw.date),
                eq(schema.transactions.description, guardRaw.description),
                eq(schema.transactions.amountCents, guardRaw.amountCents),
                eq(schema.transactions.sourceType, guardRaw.sourceType),
                eq(schema.transactions.accountName, guardRaw.accountName),
                eq(schema.transactions.kind, guardRaw.kind),
                eq(schema.transactions.category, guardRaw.category),
                guardRaw.yearlyExpenseId == null
                  ? isNull(schema.transactions.yearlyExpenseId)
                  : eq(schema.transactions.yearlyExpenseId, guardRaw.yearlyExpenseId),
              )
            : eq(schema.transactions.id, args.id),
        )
        .returning({ id: schema.transactions.id });
      if (updated.length === 0) {
        if (guardRaw) {
          const [stillThere] = await db
            .select({ id: schema.transactions.id })
            .from(schema.transactions)
            .where(eq(schema.transactions.id, args.id));
          if (stillThere) {
            return {
              ok: false,
              conflict: true,
              reason: casConflictReason("transaction"),
            };
          }
        }
        return { ok: false, reason: "That transaction was not found." };
      }
      ctx.invalidateQueries();
      return { ok: true, reason: "Transaction updated." };
    },
  }),

  deleteTransaction: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: okReasonResponse,
    async handler(ctx, args): Promise<OkReason> {
      const db = ctx.db<typeof schema>();
      const deleted = await db
        .delete(schema.transactions)
        .where(eq(schema.transactions.id, args.id))
        .returning({ id: schema.transactions.id });
      if (deleted.length === 0) {
        return { ok: false, reason: "That transaction was not found." };
      }
      ctx.invalidateQueries();
      return { ok: true, reason: "Transaction deleted." };
    },
  }),

  /* Import panel read support (IM-1 + IM-2): the remembered
     import setup, plus the already-recorded transactions for the
     months being previewed so the panel can flag rows that look
     already recorded. Dedupe matching happens in the panel
     against this read data — stored amounts and descriptions
     are ciphertext, so the server never content-matches them. */
  getImportData: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.object({
      months: z.array(z.string().regex(monthRe)).max(60),
    }),
    response: z.object({
      settingsJson: z.string().nullable(),
      existing: z.array(
        z.object({
          date: z.string(),
          amountCents: z.number(),
          description: z.string(),
          kind: z.string(),
          accountName: z.string(),
          // IM-5: the recorded transaction's bank id (OFX FITID),
          // null for rows that didn't come from an OFX import —
          // the preview's exact-duplicate check matches on it.
          fitId: z.string().nullable(),
        }),
      ),
      // IM-4: the recorded cash-out state per requested month —
      // the entered month total (null when none) and the recorded
      // cash-out items (id, description, amount), so the proposal
      // preview can compare against what is recorded and a
      // confirmed save can replace the month's items through the
      // existing delete/add item writes.
      cashOut: z.array(
        z.object({
          month: z.string(),
          enteredCashOutCents: z.number().nullable(),
          items: z.array(
            z.object({
              id: z.number(),
              description: z.string(),
              amountCents: z.number(),
            }),
          ),
        }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      const row = (await db.select().from(schema.settings)).find(
        (r) => r.key === IMPORT_SETTINGS_KEY,
      );
      let settingsJson: string | null = null;
      if (row && row.value !== "") {
        settingsJson = await decryptSettingValue(key, row.value);
        // Migrate a legacy plaintext value to encrypted in place
        // (the loadAll opening-reserve pattern). Compare-and-write
        // (contract v64, A4): the update applies only while the
        // stored value still equals the value read here, so a
        // concurrent saveImportSettings write wins over this
        // migration rewrite.
        if (settingsJson != null && !isEncrypted(row.value)) {
          await db
            .update(schema.settings)
            .set({ value: await encryptStr(key, settingsJson) })
            .where(and(
              eq(schema.settings.key, IMPORT_SETTINGS_KEY),
              eq(schema.settings.value, row.value),
            ));
        }
      }
      const existing: {
        date: string;
        amountCents: number;
        description: string;
        kind: string;
        accountName: string;
        fitId: string | null;
      }[] = [];
      const cashOut: {
        month: string;
        enteredCashOutCents: number | null;
        items: { id: number; description: string; amountCents: number }[];
      }[] = [];
      if (args.months.length > 0) {
        const { txns, summaries, cashOutItems } = await loadAll(ctx);
        const wanted = new Set(args.months);
        for (const t of txns) {
          if (!wanted.has(t.date.slice(0, 7))) continue;
          existing.push({
            date: t.date,
            amountCents: t.amountCents,
            description: t.description,
            kind: t.kind,
            accountName: t.accountName,
            fitId: t.fitId ?? null,
          });
        }
        const summaryByMonth = new Map(
          summaries.map((s) => [s.month, s.cashOutCents]),
        );
        for (const m of args.months) {
          cashOut.push({
            month: m,
            enteredCashOutCents: summaryByMonth.get(m) ?? null,
            items: cashOutItems
              .filter((it) => it.month === m)
              .map((it) => ({
                id: it.id,
                description: it.description,
                amountCents: it.amountCents,
              })),
          });
        }
      }
      return { settingsJson, existing, cashOut };
    },
  }),

  /* Import panel setup save (IM-2): persists the remembered
     settings + header-keyed mapping profiles as ONE encrypted
     settings value (IMPORT_SETTINGS_KEY), validated against the
     shared blob shape before anything is stored. */
  saveImportSettings: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.object({
      settingsJson: z.string().min(2).max(60000),
    }),
    response: z.object({ saved: z.literal(true) }),
    async handler(
      ctx,
      args,
    ): Promise<{ saved: true }> {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      let parsed: unknown;
      try {
        parsed = JSON.parse(args.settingsJson);
      } catch {
        throw new Error("That import setup could not be read — nothing was saved.");
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !Array.isArray((parsed as { profiles?: unknown }).profiles)
      ) {
        throw new Error("That import setup could not be read — nothing was saved.");
      }
      // Round-trip through the shared parser so what lands is
      // exactly the shape the panel reads back.
      const blob = parseImportSettings(args.settingsJson);
      const value = await encryptStr(key, JSON.stringify(blob));
      await db
        .insert(schema.settings)
        .values({ key: IMPORT_SETTINGS_KEY, value })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value },
        });
      ctx.invalidateQueries();
      return { saved: true };
    },
  }),

  /* Net Worth balance-import panel read support (IM-3): the
     remembered setup for the balance importer — column-mapping
     profiles keyed by header layout plus the confirmed
     file-label → account/bucket mappings. Same storage pattern
     as the spending import setup (getImportData): one encrypted
     settings value, read leniently, a legacy plaintext value
     migrated to encrypted in place. The snapshot write itself
     goes through the existing addNwSnapshot — this pair only
     carries the panel's setup. */
  getNwImportSettings: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.object({}),
    response: z.object({
      settingsJson: z.string().nullable(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      const row = (await db.select().from(schema.settings)).find(
        (r) => r.key === NW_IMPORT_SETTINGS_KEY,
      );
      let settingsJson: string | null = null;
      if (row && row.value !== "") {
        settingsJson = await decryptSettingValue(key, row.value);
        // Compare-and-write (contract v64, A4): see getImportData.
        if (settingsJson != null && !isEncrypted(row.value)) {
          await db
            .update(schema.settings)
            .set({ value: await encryptStr(key, settingsJson) })
            .where(and(
              eq(schema.settings.key, NW_IMPORT_SETTINGS_KEY),
              eq(schema.settings.value, row.value),
            ));
        }
      }
      return { settingsJson };
    },
  }),

  /* Net Worth balance-import setup save (IM-3): persists the
     remembered profiles + label mappings as ONE encrypted
     settings value (NW_IMPORT_SETTINGS_KEY), validated against
     the shared blob shape before anything is stored. */
  saveNwImportSettings: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.object({
      settingsJson: z.string().min(2).max(200000),
    }),
    response: z.object({ saved: z.literal(true) }),
    async handler(
      ctx,
      args,
    ): Promise<{ saved: true }> {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      let parsed: unknown;
      try {
        parsed = JSON.parse(args.settingsJson);
      } catch {
        throw new Error("That import setup could not be read — nothing was saved.");
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !Array.isArray((parsed as { profiles?: unknown }).profiles) ||
        typeof (parsed as { labelMappings?: unknown }).labelMappings !==
          "object" ||
        (parsed as { labelMappings?: unknown }).labelMappings === null ||
        Array.isArray((parsed as { labelMappings?: unknown }).labelMappings)
      ) {
        throw new Error("That import setup could not be read — nothing was saved.");
      }
      // Round-trip through the shared parser so what lands is
      // exactly the shape the panel reads back.
      const blob = parseNwImportSettings(args.settingsJson);
      const value = await encryptStr(key, JSON.stringify(blob));
      await db
        .insert(schema.settings)
        .values({ key: NW_IMPORT_SETTINGS_KEY, value })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value },
        });
      ctx.invalidateQueries();
      return { saved: true };
    },
  }),

  importTransactions: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.object({
      rows: z.array(txnInput).min(1).max(1000),
      // Optional batch idempotency key (contract v64, F02) — see
      // the import-batch note above the Actions map. Absent =
      // the pre-v64 behaviour exactly.
      batchKey: importBatchKeyField,
    }),
    response: z.object({ imported: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      // ONE call is atomic (API follow-on 3, finding F12; the plan
      // decision lives in ./importCore, the reserved-prefix
      // decision in ./encPrefixCore): the whole batch is planned
      // BEFORE any write — a value carrying the reserved prefix
      // that is not genuine ciphertext refuses the whole import
      // here with zero rows inserted. Verification runs first
      // (one decrypt attempt per distinct prefixed value) so the
      // pure plan sees a synchronous verifier.
      const verified = new Set<string>();
      for (const r of args.rows) {
        for (const value of [r.description, r.accountName, r.category]) {
          if (hasReservedEncPrefix(value) && !verified.has(value)) {
            try {
              await decryptStr(key, value);
              verified.add(value);
            } catch {
              // Not genuine ciphertext: the plan refuses below.
            }
          }
        }
      }
      const plan = planImportBatch(args.rows, (v) => verified.has(v));
      if (!plan.ok) throw new Error(plan.reason);
      // IM-5: a row's FITID is imported text too, so the same
      // reserved-prefix guard covers it — a bank id is never
      // genuine ciphertext, so any prefixed value refuses the
      // whole batch here, before any write, with the shared
      // reserved message.
      for (const r of args.rows) {
        if (r.fitId != null && hasReservedEncPrefix(r.fitId)) {
          throw new Error(RESERVED_ENC_PREFIX_MESSAGE);
        }
      }
      // Batch-key idempotency (contract v64, F02): with a key,
      // look for the recorded claim BEFORE building any write. A
      // claim whose rows hash matches is a completed batch being
      // retried after its success response was lost — return the
      // original count and insert ZERO rows. A claim with a
      // different hash (or an unreadable claim record) is the key
      // reused for different rows — refuse and insert nothing.
      const batchKey = args.batchKey;
      const rowsHash =
        batchKey !== undefined ? importBatchRowsHash(args.rows) : null;
      if (batchKey !== undefined && rowsHash !== null) {
        const claimRow = (await db.select().from(schema.settings)).find(
          (r: { key: string }) => r.key === IMPORT_BATCH_KEY_PREFIX + batchKey,
        );
        if (claimRow) {
          const claim = parseImportBatchClaim(claimRow.value);
          if (!claim || claim.hash !== rowsHash) {
            throw new Error(IMPORT_BATCH_COLLISION_MESSAGE);
          }
          return { imported: claim.imported };
        }
      }
      // Build EVERY row's encrypted insert statement before any
      // write executes, then run them as ONE db.batch: any
      // failure throws with its reason and zero rows from this
      // call are inserted (the client's per-batch retry can then
      // never duplicate a landed prefix). This action inserts
      // exactly the rows it is given: duplicate protection lives
      // in the import preview (IM-1), where the panel compares
      // parsed rows against read data and excludes the ones that
      // look already recorded unless the user includes them.
      type BatchItem = Parameters<typeof db.batch>[0][number];
      const statements: BatchItem[] = [];
      for (const r of args.rows) {
        statements.push(
          db.insert(schema.transactions).values({
            date: r.date,
            description: await encryptStr(key, r.description),
            amountCents: await encryptNum(key, r.amountCents),
            sourceType: r.sourceType,
            accountName: await encryptStr(key, r.accountName),
            kind: r.kind,
            category: await encryptStr(key, r.category),
            yearlyExpenseId: r.yearlyExpenseId,
            fitId: await encryptNullable(key, r.fitId),
          }),
        );
      }
      if (batchKey !== undefined && rowsHash !== null) {
        // The claim rides the SAME batch as the rows (a plain
        // insert — its primary-key conflict fails the whole batch
        // atomically), so rows and claim always commit together.
        statements.push(
          db.insert(schema.settings).values({
            key: IMPORT_BATCH_KEY_PREFIX + batchKey,
            value: JSON.stringify({
              hash: rowsHash,
              imported: args.rows.length,
            }),
          }),
        );
      }
      try {
        await db.batch(statements as [BatchItem, ...BatchItem[]]);
      } catch (err) {
        // The batch failed. If a claim for this key now exists, a
        // concurrent dispatch of the same batch completed first:
        // same rows → report its success; different rows (or an
        // unreadable claim) → the collision refusal. No claim →
        // the failure is this call's own; rethrow it untouched.
        if (batchKey !== undefined && rowsHash !== null) {
          const claimRow = (await db.select().from(schema.settings)).find(
            (r: { key: string }) =>
              r.key === IMPORT_BATCH_KEY_PREFIX + batchKey,
          );
          if (claimRow) {
            const claim = parseImportBatchClaim(claimRow.value);
            if (claim && claim.hash === rowsHash) {
              ctx.invalidateQueries();
              return { imported: claim.imported };
            }
            throw new Error(IMPORT_BATCH_COLLISION_MESSAGE);
          }
        }
        throw err;
      }
      ctx.invalidateQueries();
      return { imported: args.rows.length };
    },
  }),

  addYearlyExpense: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.object({
      name: billNameField,
      frequency: yearlyFrequencyWithDefault,
      expectedCents: z.number().int().nonnegative(),
      dueMonth: dueMonthField.default(null),
      paidByType: sourceType,
      paidByName: paidByField,
      category: category60Field.default("Uncategorized"),
      keepLightsOn: z.boolean().default(false),
      effectiveFrom: z.string().regex(monthRe).optional(),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      const encExpected = await encryptNum(key, args.expectedCents);
      const [row] = await db
        .insert(schema.yearlyExpenses)
        .values({
          name: await encryptStr(key, args.name),
          frequency: args.frequency,
          expectedCents: encExpected,
          dueMonth: args.dueMonth,
          paidByType: args.paidByType,
          paidByName: await encryptStr(key, args.paidByName),
          category: await encryptStr(key, args.category),
          keepLightsOn: args.keepLightsOn ? 1 : 0,
          // New bills never backfill: months before their first version
          // contribute zero. Only the 0007 migration sets this to 1,
          // and only for bills that existed before versioning.
          backfillBeforeFirstVersion: 0,
        })
        .returning({ id: schema.yearlyExpenses.id });
      if (!row) throw new Error("insert failed");
      const now = new Date();
      const eff = args.effectiveFrom ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      await db.insert(schema.yearlyExpenseVersions).values({
        expenseId: row.id,
        expectedCents: encExpected,
        frequency: args.frequency,
        effectiveFrom: eff,
      });
      // Remember this Paid from as the sticky default for the next
      // new yearly bill (see the entry defaults note above).
      await upsertPlainSetting(db, ENTRY_DEFAULT_YEARLY_PAID_TYPE_KEY, args.paidByType);
      await upsertPlainSetting(
        db,
        ENTRY_DEFAULT_YEARLY_PAID_NAME_KEY,
        await encryptStr(key, args.paidByName),
      );
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  updateYearlyExpense: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    // Contract v65 (CAS sweep, F17): `base` is the expense as the
    // editor loaded it — the parent fields AND the version stored
    // for the save's effective month (null = no version existed
    // for that month). When supplied, the write is refused when
    // any parent field the form replaces, or that month's version,
    // differs from its loaded base in storage; both checks run
    // before ANY write, so a refusal leaves the parent and every
    // version intact. Omitting `base` keeps the legacy unchecked
    // behaviour (named in DATA-PLAN).
    request: z.object({
      id: z.number().int().positive(),
      name: billNameField,
      frequency: yearlyFrequencyWithDefault,
      expectedCents: z.number().int().nonnegative(),
      dueMonth: dueMonthField.default(null),
      paidByType: sourceType,
      paidByName: paidByField,
      category: category60Field.default("Uncategorized"),
      keepLightsOn: z.boolean().default(false),
      effectiveFrom: z.string().regex(monthRe).optional(),
      base: z
        .object({
          name: billNameField,
          dueMonth: dueMonthField,
          paidByType: sourceType,
          paidByName: paidByField,
          category: category60Field,
          keepLightsOn: z.boolean(),
          version: z
            .object({
              expectedCents: z.number().int().nonnegative(),
              frequency: yearlyFrequency,
            })
            .nullable(),
        })
        .optional(),
    }),
    response: okReasonResponse,
    async handler(ctx, args): Promise<OkReason> {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      // Existence preflight (API follow-on 3, finding F22): a
      // missing expense fails HERE, before any write — the old
      // flow updated zero rows and then went on to INSERT version
      // rows for the bogus id.
      const [existingExpense] = await db
        .select()
        .from(schema.yearlyExpenses)
        .where(eq(schema.yearlyExpenses.id, args.id));
      if (!existingExpense) {
        return { ok: false, reason: "That yearly expense was not found." };
      }
      // The effective month is resolved BEFORE the CAS checks:
      // the version base is the version stored for THIS month.
      const now = new Date();
      const eff =
        args.effectiveFrom ??
        `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      if (args.base !== undefined) {
        const storedParent = {
          name: await decryptStr(key, existingExpense.name),
          dueMonth: existingExpense.dueMonth ?? null,
          paidByType: existingExpense.paidByType,
          paidByName: await decryptStr(key, existingExpense.paidByName),
          category: await decryptStr(key, existingExpense.category),
          keepLightsOn: existingExpense.keepLightsOn === 1,
        };
        const parentMismatch = casFieldMismatch(storedParent, args.base, [
          "name",
          "dueMonth",
          "paidByType",
          "paidByName",
          "category",
          "keepLightsOn",
        ]);
        const [versionRow] = await db
          .select()
          .from(schema.yearlyExpenseVersions)
          .where(
            and(
              eq(schema.yearlyExpenseVersions.expenseId, args.id),
              eq(schema.yearlyExpenseVersions.effectiveFrom, eff),
            ),
          );
        const storedVersion = versionRow
          ? {
              expectedCents: await decryptNum(
                key,
                versionRow.expectedCents as unknown,
              ),
              frequency: versionRow.frequency,
            }
          : null;
        const versionMismatch = !casDeepEqual(storedVersion, args.base.version);
        if (parentMismatch || versionMismatch) {
          return {
            ok: false,
            conflict: true,
            reason: casConflictReason("yearly expense"),
          };
        }
      }
      const encExpectedArg = await encryptNum(key, args.expectedCents);
      // Metadata (name, due month, paid-by, keep-the-lights-on flag)
      // updates in place. Amount and
      // frequency are versioned: a change creates / upserts a version
      // for the chosen effective-from month and never rewrites versions
      // for other months, so earlier months keep their set-aside.
      // Recorded actual payments are separate transaction rows and are
      // never rewritten here.
      await db
        .update(schema.yearlyExpenses)
        .set({
          name: await encryptStr(key, args.name),
          dueMonth: args.dueMonth,
          paidByType: args.paidByType,
          paidByName: await encryptStr(key, args.paidByName),
          category: await encryptStr(key, args.category),
          keepLightsOn: args.keepLightsOn ? 1 : 0,
        })
        .where(eq(schema.yearlyExpenses.id, args.id));
      // Atomic upsert on the (expenseId, effectiveFrom) pair
      // (contract v64, A1): see setMonthlyBillAmount. This one
      // statement covers both cases the old read-then-write
      // branched on — a legacy expense with no versions yet (the
      // upsert inserts its first version at eff) and an existing
      // version for the same month (the upsert updates it).
      await db
        .insert(schema.yearlyExpenseVersions)
        .values({
          expenseId: args.id,
          expectedCents: encExpectedArg,
          frequency: args.frequency,
          effectiveFrom: eff,
        })
        .onConflictDoUpdate({
          target: [
            schema.yearlyExpenseVersions.expenseId,
            schema.yearlyExpenseVersions.effectiveFrom,
          ],
          set: { expectedCents: encExpectedArg, frequency: args.frequency },
        });
      const allRaw = await db
        .select()
        .from(schema.yearlyExpenseVersions)
        .where(eq(schema.yearlyExpenseVersions.expenseId, args.id));
      const all: YearlyVersionRow[] = [];
      for (const v of allRaw) all.push({ ...v, expectedCents: await decryptNum(key, v.expectedCents as unknown) });
      const latest = latestYearlyVersion(all);
      if (latest) {
        await db
          .update(schema.yearlyExpenses)
          .set({ expectedCents: await encryptNum(key, latest.expectedCents), frequency: latest.frequency })
          .where(eq(schema.yearlyExpenses.id, args.id));
      }
      // Remember this Paid from as the sticky default for the next
      // new yearly bill (see the entry defaults note above).
      await upsertPlainSetting(db, ENTRY_DEFAULT_YEARLY_PAID_TYPE_KEY, args.paidByType);
      await upsertPlainSetting(
        db,
        ENTRY_DEFAULT_YEARLY_PAID_NAME_KEY,
        await encryptStr(key, args.paidByName),
      );
      ctx.invalidateQueries();
      return { ok: true, reason: "Yearly expense updated." };
    },
  }),

  // Explicit version setter for a smoothed bill (mirrors
  // setMonthlyBillAmount). Upserts the version for (expense,
  // effectiveFrom); other months' versions are untouched.
  setYearlyExpenseVersion: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.object({
      expenseId: z.number().int().positive(),
      expectedCents: z.number().int().nonnegative(),
      frequency: yearlyFrequency,
      effectiveFrom: z.string().regex(monthRe),
    }),
    response: okReasonResponse,
    async handler(ctx, args): Promise<OkReason> {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      // Existence preflight (finding F22): a version must never
      // be inserted for an expense that does not exist.
      const [existingExpense] = await db
        .select({ id: schema.yearlyExpenses.id })
        .from(schema.yearlyExpenses)
        .where(eq(schema.yearlyExpenses.id, args.expenseId));
      if (!existingExpense) {
        return { ok: false, reason: "That yearly expense was not found." };
      }
      const encExpectedArg = await encryptNum(key, args.expectedCents);
      // Atomic upsert on the (expenseId, effectiveFrom) pair
      // (contract v64, A1): see setMonthlyBillAmount.
      await db
        .insert(schema.yearlyExpenseVersions)
        .values({
          expenseId: args.expenseId,
          expectedCents: encExpectedArg,
          frequency: args.frequency,
          effectiveFrom: args.effectiveFrom,
        })
        .onConflictDoUpdate({
          target: [
            schema.yearlyExpenseVersions.expenseId,
            schema.yearlyExpenseVersions.effectiveFrom,
          ],
          set: { expectedCents: encExpectedArg, frequency: args.frequency },
        });
      const allRaw = await db
        .select()
        .from(schema.yearlyExpenseVersions)
        .where(eq(schema.yearlyExpenseVersions.expenseId, args.expenseId));
      const all: YearlyVersionRow[] = [];
      for (const v of allRaw) all.push({ ...v, expectedCents: await decryptNum(key, v.expectedCents as unknown) });
      const latest = latestYearlyVersion(all);
      if (latest) {
        await db
          .update(schema.yearlyExpenses)
          .set({ expectedCents: await encryptNum(key, latest.expectedCents), frequency: latest.frequency })
          .where(eq(schema.yearlyExpenses.id, args.expenseId));
      }
      ctx.invalidateQueries();
      return { ok: true, reason: "Version saved." };
    },
  }),

  deleteYearlyExpense: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: okReasonResponse,
    async handler(ctx, args): Promise<OkReason> {
      const db = ctx.db<typeof schema>();
      const [existingExpense] = await db
        .select({ id: schema.yearlyExpenses.id })
        .from(schema.yearlyExpenses)
        .where(eq(schema.yearlyExpenses.id, args.id));
      if (!existingExpense) {
        return { ok: false, reason: "That yearly expense was not found." };
      }
      await db
        .update(schema.transactions)
        .set({ yearlyExpenseId: null })
        .where(eq(schema.transactions.yearlyExpenseId, args.id));
      await db
        .delete(schema.yearlyExpenseVersions)
        .where(eq(schema.yearlyExpenseVersions.expenseId, args.id));
      await db
        .delete(schema.yearlyExpenses)
        .where(eq(schema.yearlyExpenses.id, args.id));
      ctx.invalidateQueries();
      return { ok: true, reason: "Yearly expense deleted." };
    },
  }),

  // Delete ONE version of a smoothed bill. The months that version
  // covered fall back to the previous version (next-earliest
  // effective-from); if the deleted version was the earliest and
  // others remain, the bill simply starts at the next version.
  // A bill's ONLY remaining version cannot be deleted — deleting
  // the whole bill remains the deleteYearlyExpense flow above.
  // Recorded transactions / actual payments are never touched.
  deleteYearlyExpenseVersion: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.object({ versionId: z.number().int().positive() }),
    response: z.object({ ok: z.boolean(), reason: z.string() }),
    async handler(
      ctx,
      args,
    ): Promise<{ ok: boolean; reason: string }> {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      const [target] = await db
        .select()
        .from(schema.yearlyExpenseVersions)
        .where(eq(schema.yearlyExpenseVersions.id, args.versionId));
      if (!target) {
        return { ok: false, reason: "That history entry was not found." };
      }
      const all = await db
        .select()
        .from(schema.yearlyExpenseVersions)
        .where(
          eq(schema.yearlyExpenseVersions.expenseId, target.expenseId),
        );
      if (all.length <= 1) {
        return {
          ok: false,
          reason:
            "A bill must keep at least one history entry. To remove the bill entirely, delete the bill itself.",
        };
      }
      await db
        .delete(schema.yearlyExpenseVersions)
        .where(eq(schema.yearlyExpenseVersions.id, args.versionId));
      const remainingRaw = await db
        .select()
        .from(schema.yearlyExpenseVersions)
        .where(
          eq(schema.yearlyExpenseVersions.expenseId, target.expenseId),
        );
      const remaining: YearlyVersionRow[] = [];
      for (const v of remainingRaw) remaining.push({ ...v, expectedCents: await decryptNum(key, v.expectedCents as unknown) });
      const latest = latestYearlyVersion(remaining);
      if (latest) {
        await db
          .update(schema.yearlyExpenses)
          .set({
            expectedCents: await encryptNum(key, latest.expectedCents),
            frequency: latest.frequency,
          })
          .where(eq(schema.yearlyExpenses.id, target.expenseId));
      }
      ctx.invalidateQueries();
      return { ok: true, reason: "History entry removed." };
    },
  }),

  // Quick due-month setter: only the due-month anchor changes, never
  // amounts, frequencies, or versions.
  setYearlyDueMonth: defineAction({
    request: z.object({
      id: z.number().int().positive(),
      dueMonth: dueMonthField,
    }),
    response: okReasonResponse,
    async handler(ctx, args): Promise<OkReason> {
      const db = ctx.db<typeof schema>();
      const updated = await db
        .update(schema.yearlyExpenses)
        .set({ dueMonth: args.dueMonth })
        .where(eq(schema.yearlyExpenses.id, args.id))
        .returning({ id: schema.yearlyExpenses.id });
      if (updated.length === 0) {
        return { ok: false, reason: "That yearly expense was not found." };
      }
      ctx.invalidateQueries();
      return { ok: true, reason: "Due month saved." };
    },
  }),

  addMonthlyOneOff: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: oneOffInput,
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      const [row] = await db
        .insert(schema.monthlyOneOffs)
        .values({
          month: args.month,
          description: await encryptStr(key, args.description),
          amountCents: await encryptNum(key, args.amountCents),
          note: await encryptNullable(key, args.note),
        })
        .returning({ id: schema.monthlyOneOffs.id });
      if (!row) throw new Error("insert failed");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  updateMonthlyOneOff: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: oneOffInput.extend({ id: z.number().int().positive() }),
    response: okReasonResponse,
    async handler(ctx, args): Promise<OkReason> {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      const updated = await db
        .update(schema.monthlyOneOffs)
        .set({
          month: args.month,
          description: await encryptStr(key, args.description),
          amountCents: await encryptNum(key, args.amountCents),
          note: await encryptNullable(key, args.note),
        })
        .where(eq(schema.monthlyOneOffs.id, args.id))
        .returning({ id: schema.monthlyOneOffs.id });
      if (updated.length === 0) {
        return { ok: false, reason: "That one-off expense was not found." };
      }
      ctx.invalidateQueries();
      return { ok: true, reason: "One-off expense updated." };
    },
  }),

  deleteMonthlyOneOff: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: okReasonResponse,
    async handler(ctx, args): Promise<OkReason> {
      const db = ctx.db<typeof schema>();
      const deleted = await db
        .delete(schema.monthlyOneOffs)
        .where(eq(schema.monthlyOneOffs.id, args.id))
        .returning({ id: schema.monthlyOneOffs.id });
      if (deleted.length === 0) {
        return { ok: false, reason: "That one-off expense was not found." };
      }
      ctx.invalidateQueries();
      return { ok: true, reason: "One-off expense deleted." };
    },
  }),

  addCashOutItem: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: cashOutItemInput,
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      const [row] = await db
        .insert(schema.monthlyCashOutItems)
        .values({
          month: args.month,
          description: await encryptStr(key, args.description),
          amountCents: await encryptNum(key, args.amountCents),
          note: await encryptNullable(key, args.note),
          day: args.day,
        })
        .returning({ id: schema.monthlyCashOutItems.id });
      if (!row) throw new Error("insert failed");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  updateCashOutItem: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    // Contract v65 (CAS sweep, F14): `base` is the item as the
    // editor loaded it. When supplied, the write is a GUARDED
    // update in the same shape as updateTransaction (F13): it
    // applies only where the stored row still equals the base
    // fields, and a mismatch returns the conflict shape with the
    // stored newer value intact. Omitting `base` keeps the legacy
    // unchecked behaviour (named in DATA-PLAN).
    request: cashOutItemUpdateInput,
    response: okReasonResponse,
    async handler(ctx, args): Promise<OkReason> {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      const { base, ...fields } = args;
      let guardRaw: typeof schema.monthlyCashOutItems.$inferSelect | undefined;
      if (base !== undefined) {
        const [raw] = await db
          .select()
          .from(schema.monthlyCashOutItems)
          .where(eq(schema.monthlyCashOutItems.id, args.id));
        if (!raw) {
          return { ok: false, reason: "That cash-out item was not found." };
        }
        const stored = {
          month: raw.month,
          description: await decryptStr(key, raw.description),
          amountCents: await decryptNum(key, raw.amountCents as unknown),
          note: await decryptNullable(key, raw.note),
          day: raw.day,
        };
        const mismatch = casFieldMismatch(stored, base, [
          "month",
          "description",
          "amountCents",
          "note",
          "day",
        ]);
        if (mismatch) {
          return {
            ok: false,
            conflict: true,
            reason: casConflictReason("cash-out item"),
          };
        }
        guardRaw = raw;
      }
      const updated = await db
        .update(schema.monthlyCashOutItems)
        .set({
          month: fields.month,
          description: await encryptStr(key, fields.description),
          amountCents: await encryptNum(key, fields.amountCents),
          note: await encryptNullable(key, fields.note),
          day: fields.day,
        })
        .where(
          guardRaw
            ? and(
                eq(schema.monthlyCashOutItems.id, args.id),
                eq(schema.monthlyCashOutItems.month, guardRaw.month),
                eq(schema.monthlyCashOutItems.description, guardRaw.description),
                eq(schema.monthlyCashOutItems.amountCents, guardRaw.amountCents),
                guardRaw.note == null
                  ? isNull(schema.monthlyCashOutItems.note)
                  : eq(schema.monthlyCashOutItems.note, guardRaw.note),
                eq(schema.monthlyCashOutItems.day, guardRaw.day),
              )
            : eq(schema.monthlyCashOutItems.id, args.id),
        )
        .returning({ id: schema.monthlyCashOutItems.id });
      if (updated.length === 0) {
        if (guardRaw) {
          const [stillThere] = await db
            .select({ id: schema.monthlyCashOutItems.id })
            .from(schema.monthlyCashOutItems)
            .where(eq(schema.monthlyCashOutItems.id, args.id));
          if (stillThere) {
            return {
              ok: false,
              conflict: true,
              reason: casConflictReason("cash-out item"),
            };
          }
        }
        return { ok: false, reason: "That cash-out item was not found." };
      }
      ctx.invalidateQueries();
      return { ok: true, reason: "Cash-out item updated." };
    },
  }),

  deleteCashOutItem: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: okReasonResponse,
    async handler(ctx, args): Promise<OkReason> {
      const db = ctx.db<typeof schema>();
      const deleted = await db
        .delete(schema.monthlyCashOutItems)
        .where(eq(schema.monthlyCashOutItems.id, args.id))
        .returning({ id: schema.monthlyCashOutItems.id });
      if (deleted.length === 0) {
        return { ok: false, reason: "That cash-out item was not found." };
      }
      ctx.invalidateQueries();
      return { ok: true, reason: "Cash-out item deleted." };
    },
  }),

  updateSettings: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    // Contract v65 (CAS sweep, F26): `base` is the settings pair
    // as the settings form loaded it. When supplied, the write is
    // refused when EITHER stored key (opening reserve, reserve
    // start month) no longer matches its loaded base — both keys
    // are checked before either is written, so a refusal leaves
    // both stored values intact. Omitting `base` keeps the legacy
    // unchecked behaviour (named in DATA-PLAN).
    request: z.object({
      openingReserveCents: z.number().int(),
      reserveStartMonth: z.string().regex(monthRe).nullable().default(null),
      base: z
        .object({
          openingReserveCents: z.number().int(),
          reserveStartMonth: z.string().regex(monthRe).nullable(),
        })
        .optional(),
    }),
    response: casOkResponse,
    async handler(ctx, args): Promise<CasOk> {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      if (args.base !== undefined) {
        const rows = await db.select().from(schema.settings);
        const rawReserve = rows.find(
          (r) => r.key === "opening_reserve_cents",
        )?.value;
        const storedReserve =
          rawReserve == null
            ? 0
            : Number(await decryptStr(key, rawReserve));
        const rawStart = rows.find(
          (r) => r.key === "reserve_start_month",
        )?.value;
        const storedStart = rawStart == null || rawStart === "" ? null : rawStart;
        if (
          storedReserve !== args.base.openingReserveCents ||
          storedStart !== args.base.reserveStartMonth
        ) {
          return {
            ok: false,
            conflict: true,
            reason: casConflictReason("reserve settings"),
          };
        }
      }
      const encReserve = await encryptStr(key, String(args.openingReserveCents));
      await db
        .insert(schema.settings)
        .values({
          key: "opening_reserve_cents",
          value: encReserve,
        })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value: encReserve },
        });
      await db
        .insert(schema.settings)
        .values({
          key: "reserve_start_month",
          value: args.reserveStartMonth ?? "",
        })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value: args.reserveStartMonth ?? "" },
        });
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  upsertMonthlySummary: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    // Contract v65 (CAS sweep, F15): `base` is the month total as
    // the editor loaded it (null = no total was stored for the
    // month). When supplied, the write is refused when the stored
    // month total differs from the base — the month primary key
    // prevented duplication but not stale replacement. Omitting
    // `base` keeps the legacy unchecked behaviour (named in
    // DATA-PLAN).
    request: z.object({
      month: z.string().regex(monthRe),
      cashOutCents: z.number().int().nonnegative(),
      base: z
        .object({
          cashOutCents: z.number().int().nonnegative().nullable(),
        })
        .optional(),
    }),
    response: casOkResponse,
    async handler(ctx, args): Promise<CasOk> {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      if (args.base !== undefined) {
        const [row] = await db
          .select()
          .from(schema.monthlySummaries)
          .where(eq(schema.monthlySummaries.month, args.month));
        const storedCents = row
          ? await decryptNum(key, row.cashOutCents as unknown)
          : null;
        if (storedCents !== args.base.cashOutCents) {
          return {
            ok: false,
            conflict: true,
            reason: casConflictReason("month's cash-out total"),
          };
        }
      }
      const now = new Date();
      const encCashOut = await encryptNum(key, args.cashOutCents);
      await db
        .insert(schema.monthlySummaries)
        .values({
          month: args.month,
          cashOutCents: encCashOut,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: schema.monthlySummaries.month,
          set: { cashOutCents: encCashOut, updatedAt: now },
        });
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deleteMonthlySummary: defineAction({
    request: z.object({ month: z.string().regex(monthRe) }),
    response: okReasonResponse,
    async handler(ctx, args): Promise<OkReason> {
      const db = ctx.db<typeof schema>();
      const deleted = await db
        .delete(schema.monthlySummaries)
        .where(eq(schema.monthlySummaries.month, args.month))
        .returning({ month: schema.monthlySummaries.month });
      if (deleted.length === 0) {
        return {
          ok: false,
          reason: "No cash-out total is recorded for that month.",
        };
      }
      ctx.invalidateQueries();
      return { ok: true, reason: "Cash-out total removed." };
    },
  }),

  addMonthlyBill: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: monthlyBillInput,
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      const encAmount = await encryptNum(key, args.amountCents);
      const [row] = await db
        .insert(schema.monthlyBills)
        .values({
          name: await encryptStr(key, args.name),
          amountCents: encAmount,
          paidBy: await encryptStr(key, args.paidBy),
          notes: await encryptNullable(key, args.notes),
          category: await encryptStr(key, args.category),
          keepLightsOn: args.keepLightsOn ? 1 : 0,
        })
        .returning({ id: schema.monthlyBills.id });
      if (!row) throw new Error("insert failed");
      await db.insert(schema.monthlyBillVersions).values({
        billId: row.id,
        amountCents: encAmount,
        effectiveFrom: args.effectiveFrom,
      });
      // Remember this Paid from as the sticky default for the next
      // new monthly bill (see the entry defaults note above).
      await upsertPlainSetting(
        db,
        ENTRY_DEFAULT_MONTHLY_PAID_FROM_KEY,
        await encryptStr(key, args.paidBy),
      );
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  updateMonthlyBill: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    // The request schema lives in apiContractCore
    // (updateMonthlyBillIn): notes / category / keepLightsOn are
    // optional with NO defaults (finding F18).
    request: updateMonthlyBillIn,
    response: okReasonResponse,
    async handler(ctx, args): Promise<OkReason> {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      // Existence preflight (finding F22).
      const [existingBill] = await db
        .select()
        .from(schema.monthlyBills)
        .where(eq(schema.monthlyBills.id, args.id));
      if (!existingBill) {
        return { ok: false, reason: "That monthly bill was not found." };
      }
      // CAS guard (contract v65, F18): when the caller supplied
      // the loaded base, refuse if any field this save would
      // replace no longer matches its base in storage — checked
      // before any write, so the stored newer bill stays intact.
      if (args.base !== undefined) {
        const storedBill = {
          name: await decryptStr(key, existingBill.name),
          paidBy: await decryptStr(key, existingBill.paidBy),
          notes: await decryptNullable(key, existingBill.notes),
          category: await decryptStr(key, existingBill.category),
          keepLightsOn: existingBill.keepLightsOn === 1,
        };
        const sentFields = (
          ["name", "paidBy", "notes", "category", "keepLightsOn"] as const
        ).filter((f) => args[f] !== undefined);
        if (casFieldMismatch(storedBill, args.base, sentFields)) {
          return {
            ok: false,
            conflict: true,
            reason: casConflictReason("monthly bill"),
          };
        }
      }
      // Write ONLY the fields the caller actually sent (finding
      // F18): monthlyBillUpdateSet (spendingCore) builds the set
      // from the parsed args — an absent field preserves the
      // stored value; an explicitly sent notes: null clears the
      // notes. The live form always sends all five fields, so it
      // writes exactly what the old unconditional write did.
      const plain = monthlyBillUpdateSet(args);
      const set: {
        name?: string;
        paidBy?: string;
        notes?: string | null;
        category?: string;
        keepLightsOn?: number;
      } = {};
      if (plain.name !== undefined) set.name = await encryptStr(key, plain.name);
      if (plain.paidBy !== undefined) set.paidBy = await encryptStr(key, plain.paidBy);
      if (plain.notes !== undefined) set.notes = await encryptNullable(key, plain.notes);
      if (plain.category !== undefined) set.category = await encryptStr(key, plain.category);
      if (plain.keepLightsOn !== undefined) set.keepLightsOn = plain.keepLightsOn;
      const updated = await db
        .update(schema.monthlyBills)
        .set(set)
        .where(eq(schema.monthlyBills.id, args.id))
        .returning({ id: schema.monthlyBills.id });
      // Affected-row check (R4-3, finding F10): a delete that
      // won the race between the preflight above and this
      // update is indistinguishable from a delete that happened
      // first, so zero updated rows take the preflight's exact
      // not-found shape — and the sticky paid-from default
      // below writes ONLY on a committed row.
      if (monthlyBillUpdateOutcome(updated.length) === "not-found") {
        return { ok: false, reason: "That monthly bill was not found." };
      }
      // Remember this Paid from as the sticky default for the next
      // new monthly bill (see the entry defaults note above).
      await upsertPlainSetting(
        db,
        ENTRY_DEFAULT_MONTHLY_PAID_FROM_KEY,
        await encryptStr(key, args.paidBy),
      );
      ctx.invalidateQueries();
      return { ok: true, reason: "Bill updated." };
    },
  }),

  // Set a monthly bill's category. Label only — no amount, version,
  // or total is touched. Blank falls back to "Uncategorized".
  setMonthlyBillCategory: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.object({
      id: z.number().int().positive(),
      category: z.string().max(60),
    }),
    response: okReasonResponse,
    async handler(ctx, args): Promise<OkReason> {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      const updated = await db
        .update(schema.monthlyBills)
        .set({ category: await encryptStr(key, args.category.trim() || "Uncategorized") })
        .where(eq(schema.monthlyBills.id, args.id))
        .returning({ id: schema.monthlyBills.id });
      if (updated.length === 0) {
        return { ok: false, reason: "That monthly bill was not found." };
      }
      ctx.invalidateQueries();
      return { ok: true, reason: "Category saved." };
    },
  }),

  // Set a smoothed bill's category. Label only — no amount, frequency,
  // version, or total is touched. Blank falls back to "Uncategorized".
  setYearlyCategory: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.object({
      id: z.number().int().positive(),
      category: z.string().max(60),
    }),
    response: okReasonResponse,
    async handler(ctx, args): Promise<OkReason> {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      const updated = await db
        .update(schema.yearlyExpenses)
        .set({ category: await encryptStr(key, args.category.trim() || "Uncategorized") })
        .where(eq(schema.yearlyExpenses.id, args.id))
        .returning({ id: schema.yearlyExpenses.id });
      if (updated.length === 0) {
        return { ok: false, reason: "That yearly expense was not found." };
      }
      ctx.invalidateQueries();
      return { ok: true, reason: "Category saved." };
    },
  }),

  // Toggle a monthly bill's "Keep the lights on" check. Label only —
  // no amount, version, or total is touched.
  setMonthlyBillKeepLightsOn: defineAction({
    request: z.object({
      id: z.number().int().positive(),
      keepLightsOn: z.boolean(),
    }),
    response: okReasonResponse,
    async handler(ctx, args): Promise<OkReason> {
      const db = ctx.db<typeof schema>();
      const updated = await db
        .update(schema.monthlyBills)
        .set({ keepLightsOn: args.keepLightsOn ? 1 : 0 })
        .where(eq(schema.monthlyBills.id, args.id))
        .returning({ id: schema.monthlyBills.id });
      if (updated.length === 0) {
        return { ok: false, reason: "That monthly bill was not found." };
      }
      ctx.invalidateQueries();
      return { ok: true, reason: "Keep-the-lights-on flag saved." };
    },
  }),

  // Set the Monthly bills section's collapsed-all UI state. Display
  // only — one flag for the whole section, persisted server-side in
  // settings so it survives reloads, new sessions, and devices.
  // No amount, version, or total is touched.
  setMonthlyBillsCollapsedAll: defineAction({
    request: z.object({
      collapsed: z.boolean(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db
        .insert(schema.settings)
        .values({
          key: "monthly_bills_collapsed_all",
          value: args.collapsed ? "1" : "0",
        })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value: args.collapsed ? "1" : "0" },
        });
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // Set the Yearly & periodic expenses section's collapsed-all UI
  // state. Display only — one flag for the whole section, persisted
  // server-side in settings so it survives reloads, new sessions, and
  // devices. Independent of the Monthly bills and By category flags.
  // No amount, version, or total is touched.
  setYearlyBillsCollapsedAll: defineAction({
    request: z.object({
      collapsed: z.boolean(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db
        .insert(schema.settings)
        .values({
          key: "yearly_bills_collapsed_all",
          value: args.collapsed ? "1" : "0",
        })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value: args.collapsed ? "1" : "0" },
        });
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // Set the By category section's collapsed-all UI state. Display
  // only — one flag for the whole section, persisted server-side in
  // settings so it survives reloads, new sessions, and devices.
  // Independent of the Monthly bills and Yearly bills flags.
  // No amount, version, or total is touched.
  setByCategoryCollapsedAll: defineAction({
    request: z.object({
      collapsed: z.boolean(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db
        .insert(schema.settings)
        .values({
          key: "by_category_collapsed_all",
          value: args.collapsed ? "1" : "0",
        })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value: args.collapsed ? "1" : "0" },
        });
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // Set the Year in spending section's collapsed UI state. Display
  // only — one flag for the whole section, persisted server-side in
  // settings so it survives reloads, new sessions, and devices.
  // Independent of the Monthly bills, Yearly bills, and By category
  // flags. Default (absent) is collapsed. No amount, version, or
  // total is touched.
  setYearInSpendingCollapsedAll: defineAction({
    request: z.object({
      collapsed: z.boolean(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db
        .insert(schema.settings)
        .values({
          key: "year_in_spending_collapsed_all",
          value: args.collapsed ? "1" : "0",
        })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value: args.collapsed ? "1" : "0" },
        });
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // ---- Explainer ("one-line summary + More") UI state ----
  // Every long section intro across the app renders as one summary
  // line plus a "More" control that expands the section's full
  // original text in place. Whether a given section's full text is
  // expanded is display-only UI state, persisted server-side in
  // settings under ONE JSON blob ("explainer_expanded_v1": a map of
  // section id -> true) so it survives reloads, new sessions, and
  // devices, exactly like the section collapse flags above. Default
  // (no stored entry) is collapsed — summary line only. No amount,
  // version, or total is ever touched by these actions.
  getExplainerState: defineAction({
    request: z.object({}),
    response: z.object({
      expanded: z.record(z.string(), z.boolean()),
    }),
    async handler(ctx): Promise<{ expanded: Record<string, boolean> }> {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.settings);
      const raw = rows.find((r) => r.key === "explainer_expanded_v1")?.value;
      if (!raw) return { expanded: {} };
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return { expanded: {} };
        }
        const out: Record<string, boolean> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (v === true) out[k] = true;
        }
        return { expanded: out };
      } catch {
        return { expanded: {} };
      }
    },
  }),

  setExplainerExpanded: defineAction({
    request: z.object({
      id: z.string().min(1).max(80),
      expanded: z.boolean(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.settings);
      const raw = rows.find((r) => r.key === "explainer_expanded_v1")?.value;
      let map: Record<string, boolean> = {};
      if (raw) {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
            for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
              if (v === true) map[k] = true;
            }
          }
        } catch {
          map = {};
        }
      }
      if (args.expanded) map[args.id] = true;
      else delete map[args.id];
      const value = JSON.stringify(map);
      await db
        .insert(schema.settings)
        .values({ key: "explainer_expanded_v1", value })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value },
        });
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // ---- Generic fold ("collapsed / expanded") UI state ----
  // The collapsible pieces of the Spending and Net Worth views
  // that no more specific store owns: the per-month cash-out
  // item lists ("spending.cashout.<month>"), the statement
  // import panels ("spending.import" / "nw.import"), the
  // reserve settings fold ("spending.reserve"), and the Net
  // Worth Trend anchor note's "More" expander
  // ("nw.trendAnchor"). Open/closed is display-only UI state,
  // persisted server-side in settings under ONE JSON blob
  // ("ui_fold_state_v1": a map of fold id -> true), following
  // the explainer-state pattern above, so each fold comes back
  // exactly as the user left it after a reload, in a new
  // session, and on another device; the packaged build runs
  // these same actions against its browser-side store. Every
  // fold in this store defaults to closed, so only folds left
  // open carry an entry. The parse/set logic lives in
  // uiFoldCore.ts, where the accuracy fixtures pin it. No
  // amount, version, or total is ever touched by these actions.
  getUiFoldState: defineAction({
    request: z.object({}),
    response: z.object({
      open: z.record(z.string(), z.boolean()),
    }),
    async handler(ctx): Promise<{ open: Record<string, boolean> }> {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.settings);
      return {
        open: parseUiFoldState(
          rows.find((r) => r.key === UI_FOLD_STATE_KEY)?.value,
        ),
      };
    },
  }),

  setUiFoldState: defineAction({
    request: z.object({
      id: z.string().min(1).max(80),
      open: z.boolean(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.settings);
      const value = applyUiFoldSet(
        rows.find((r) => r.key === UI_FOLD_STATE_KEY)?.value,
        args.id,
        args.open,
      );
      await db
        .insert(schema.settings)
        .values({ key: UI_FOLD_STATE_KEY, value })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value },
        });
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // Toggle a smoothed bill's "Keep the lights on" check. Label only —
  // no amount, frequency, version, or total is touched.
  setYearlyKeepLightsOn: defineAction({
    request: z.object({
      id: z.number().int().positive(),
      keepLightsOn: z.boolean(),
    }),
    response: okReasonResponse,
    async handler(ctx, args): Promise<OkReason> {
      const db = ctx.db<typeof schema>();
      const updated = await db
        .update(schema.yearlyExpenses)
        .set({ keepLightsOn: args.keepLightsOn ? 1 : 0 })
        .where(eq(schema.yearlyExpenses.id, args.id))
        .returning({ id: schema.yearlyExpenses.id });
      if (updated.length === 0) {
        return { ok: false, reason: "That yearly expense was not found." };
      }
      ctx.invalidateQueries();
      return { ok: true, reason: "Keep-the-lights-on flag saved." };
    },
  }),

  // Set a bill's amount from a given month onward. This is the only way
  // amounts change: it upserts the version for (bill, effectiveFrom) and
  // never touches versions for other months, so earlier months keep the
  // amount that was in effect then. Choosing an earlier effectiveFrom is
  // the explicit way to correct a past month.
  setMonthlyBillAmount: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    // Contract v65 (CAS sweep, F16): `base` is the amount stored
    // for (bill, effectiveFrom) as the editor loaded it (null = no
    // version existed for that month). When supplied, the write is
    // refused when the stored amount for that effective month
    // differs from the base, on top of v64's atomic upsert.
    // Omitting `base` keeps the legacy unchecked behaviour (named
    // in DATA-PLAN).
    request: z.object({
      billId: z.number().int().positive(),
      amountCents: z.number().int().nonnegative(),
      effectiveFrom: z.string().regex(monthRe),
      base: z
        .object({
          amountCents: z.number().int().nonnegative().nullable(),
        })
        .optional(),
    }),
    response: okReasonResponse,
    async handler(ctx, args): Promise<OkReason> {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      // Existence preflight (finding F22): a version must never
      // be inserted for a bill that does not exist.
      const [existingBill] = await db
        .select({ id: schema.monthlyBills.id })
        .from(schema.monthlyBills)
        .where(eq(schema.monthlyBills.id, args.billId));
      if (!existingBill) {
        return { ok: false, reason: "That monthly bill was not found." };
      }
      if (args.base !== undefined) {
        const [versionRow] = await db
          .select()
          .from(schema.monthlyBillVersions)
          .where(
            and(
              eq(schema.monthlyBillVersions.billId, args.billId),
              eq(schema.monthlyBillVersions.effectiveFrom, args.effectiveFrom),
            ),
          );
        const storedAmount = versionRow
          ? await decryptNum(key, versionRow.amountCents as unknown)
          : null;
        if (storedAmount !== args.base.amountCents) {
          return {
            ok: false,
            conflict: true,
            reason: casConflictReason("monthly bill amount"),
          };
        }
      }
      const encAmountArg = await encryptNum(key, args.amountCents);
      // Atomic upsert on the (billId, effectiveFrom) pair
      // (contract v64, A1): the composite unique index (schema +
      // migration 0025) makes the pair a real conflict target, so
      // two overlapping writes for the same month can never insert
      // duplicate version rows — the second updates the pair's
      // single row instead.
      await db
        .insert(schema.monthlyBillVersions)
        .values({
          billId: args.billId,
          amountCents: encAmountArg,
          effectiveFrom: args.effectiveFrom,
        })
        .onConflictDoUpdate({
          target: [
            schema.monthlyBillVersions.billId,
            schema.monthlyBillVersions.effectiveFrom,
          ],
          set: { amountCents: encAmountArg },
        });
      const allRaw = await db
        .select()
        .from(schema.monthlyBillVersions)
        .where(eq(schema.monthlyBillVersions.billId, args.billId));
      const all: BillVersionRow[] = [];
      for (const v of allRaw) all.push({ ...v, amountCents: await decryptNum(key, v.amountCents as unknown) });
      const latest = latestVersion(all);
      if (latest) {
        await db
          .update(schema.monthlyBills)
          .set({ amountCents: await encryptNum(key, latest.amountCents) })
          .where(eq(schema.monthlyBills.id, args.billId));
      }
      ctx.invalidateQueries();
      return { ok: true, reason: "Amount saved." };
    },
  }),

  deleteMonthlyBill: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: okReasonResponse,
    async handler(ctx, args): Promise<OkReason> {
      const db = ctx.db<typeof schema>();
      const [existingBill] = await db
        .select({ id: schema.monthlyBills.id })
        .from(schema.monthlyBills)
        .where(eq(schema.monthlyBills.id, args.id));
      if (!existingBill) {
        return { ok: false, reason: "That monthly bill was not found." };
      }
      await db
        .delete(schema.monthlyBillVersions)
        .where(eq(schema.monthlyBillVersions.billId, args.id));
      await db
        .delete(schema.monthlyBills)
        .where(eq(schema.monthlyBills.id, args.id));
      ctx.invalidateQueries();
      return { ok: true, reason: "Bill deleted." };
    },
  }),

  // Delete ONE version of a monthly bill. The months that version
  // covered fall back to the previous version (next-earliest
  // effective-from); if the deleted version was the earliest and
  // others remain, the bill simply starts at the next version.
  // A bill's ONLY remaining version cannot be deleted — deleting
  // the whole bill remains the deleteMonthlyBill flow above.
  deleteMonthlyBillVersion: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.object({ versionId: z.number().int().positive() }),
    response: z.object({ ok: z.boolean(), reason: z.string() }),
    async handler(
      ctx,
      args,
    ): Promise<{ ok: boolean; reason: string }> {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      const [target] = await db
        .select()
        .from(schema.monthlyBillVersions)
        .where(eq(schema.monthlyBillVersions.id, args.versionId));
      if (!target) {
        return { ok: false, reason: "That history entry was not found." };
      }
      const all = await db
        .select()
        .from(schema.monthlyBillVersions)
        .where(eq(schema.monthlyBillVersions.billId, target.billId));
      if (all.length <= 1) {
        return {
          ok: false,
          reason:
            "A bill must keep at least one history entry. To remove the bill entirely, delete the bill itself.",
        };
      }
      await db
        .delete(schema.monthlyBillVersions)
        .where(eq(schema.monthlyBillVersions.id, args.versionId));
      const remainingRaw = await db
        .select()
        .from(schema.monthlyBillVersions)
        .where(eq(schema.monthlyBillVersions.billId, target.billId));
      const remaining: BillVersionRow[] = [];
      for (const v of remainingRaw) remaining.push({ ...v, amountCents: await decryptNum(key, v.amountCents as unknown) });
      const latest = latestVersion(remaining);
      if (latest) {
        await db
          .update(schema.monthlyBills)
          .set({ amountCents: await encryptNum(key, latest.amountCents) })
          .where(eq(schema.monthlyBills.id, target.billId));
      }
      ctx.invalidateQueries();
      return { ok: true, reason: "History entry removed." };
    },
  }),

  seedExamples: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.object({}),
    response: z.object({ ok: z.boolean(), reason: z.string() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      // Global first-run emptiness (contract v60, F7): the ONE
      // predicate in seedGuardCore, over every dataset table —
      // before v60 this guard looked at four spending tables
      // only, so sample rows could land beside real records held
      // in an unchecked table (a settings blob, a one-off, a
      // Net Worth account).
      const presence = await loadDatasetPresence(db);
      if (!datasetIsEmpty(presence)) {
        return {
          ok: false,
          reason: `Example data only loads into a completely empty tracker — this tracker already has data (${nonEmptyDatasetTables(presence).join(", ")}). Nothing was seeded.`,
        };
      }
      // Atomic seed (contract v64, A3): the builder only BUILDS
      // the insert statements; they commit as ONE db.batch, so a
      // failure mid-seed lands nothing and a retry can succeed.
      const built = await seedExamplesStatements(db, key);
      if (!built.ok) {
        return { ok: false, reason: built.reason };
      }
      type BatchItem = Parameters<typeof db.batch>[0][number];
      if (built.statements.length > 0) {
        await db.batch(built.statements as [BatchItem, ...BatchItem[]]);
      }
      ctx.invalidateQueries();
      return { ok: true, reason: built.reason };
    },
  }),

  // Delete ALL of the tracker's data — every spending table, every
  // Net Worth table, and every settings row: the collapse flags, the
  // NW target, the reserve settings, AND the saved planner data the
  // settings table carries — the Retirement calculator record and
  // baseline, the Roth plan record, and the Roth UI state. Nothing
  // user-entered survives this: Net Worth accounts/snapshots/
  // balances are deleted too (children first, settings last — the
  // shared wipe plan in server/src/clearDataCore.ts).
  // The safeguard is server-side: the request must carry confirm
  // with the EXACT phrase "delete everything", and the gate
  // (clearDataCore's isClearAllConfirmed) is checked before any
  // delete statement is reachable — a missing, empty, or inexact
  // confirmation returns { ok: false } and deletes nothing. No
  // client calls this action today, so no UI confirmation exists
  // to rely on; the gate here is the only one.
  // The encryption key-check row goes with the other settings; the
  // next data load recreates it via ensureKeyCheck.
  clearAllData: defineAction({
    request: z.object({ confirm: z.string() }),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx, args): Promise<{ ok: boolean }> {
      if (!isClearAllConfirmed(args.confirm)) {
        return { ok: false };
      }
      const db = ctx.db<typeof schema>();
      const wipeStep: Record<ClearAllTable, () => Promise<void>> = {
        transactions: async () => { await db.delete(schema.transactions); },
        yearlyExpenseVersions: async () => { await db.delete(schema.yearlyExpenseVersions); },
        yearlyExpenses: async () => { await db.delete(schema.yearlyExpenses); },
        monthlySummaries: async () => { await db.delete(schema.monthlySummaries); },
        monthlyBillVersions: async () => { await db.delete(schema.monthlyBillVersions); },
        monthlyBills: async () => { await db.delete(schema.monthlyBills); },
        monthlyOneOffs: async () => { await db.delete(schema.monthlyOneOffs); },
        monthlyCashOutItems: async () => { await db.delete(schema.monthlyCashOutItems); },
        nwBalances: async () => { await db.delete(schema.nwBalances); },
        nwSnapshots: async () => { await db.delete(schema.nwSnapshots); },
        nwAccounts: async () => { await db.delete(schema.nwAccounts); },
        settings: async () => { await db.delete(schema.settings); },
      };
      for (const stmt of buildClearAllPlan()) {
        await wipeStep[stmt.table]();
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  /* ---------------- Net Worth actions ---------------- */

  // Idempotent seed of the sample Net Worth history. Runs only
  // into a completely empty dataset (the global seedGuardCore
  // check), so re-running it can never duplicate or mix sample
  // rows with real records.
  seedNetWorth: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.object({}),
    response: z.object({ ok: z.boolean(), seeded: z.boolean(), reason: z.string() }),
    async handler(ctx): Promise<{ ok: boolean; seeded: boolean; reason: string }> {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      // Global first-run emptiness (contract v60, F7): the same
      // seedGuardCore predicate seedExamples uses — before v60
      // this guard looked only at Net Worth accounts, so the
      // sample history could be seeded beside real spending data.
      const presence = await loadDatasetPresence(db);
      if (!datasetIsEmpty(presence)) {
        return {
          ok: true,
          seeded: false,
          reason: `Dataset is not empty (${nonEmptyDatasetTables(presence).join(", ")}) — nothing seeded.`,
        };
      }
      // Atomic seed (contract v64, A3): see seedExamples.
      const built = await seedNetWorthStatements(db, key);
      if (!built.seeded) {
        return { ok: false, seeded: false, reason: built.reason };
      }
      type BatchItem = Parameters<typeof db.batch>[0][number];
      if (built.statements.length > 0) {
        await db.batch(built.statements as [BatchItem, ...BatchItem[]]);
      }
      ctx.invalidateQueries();
      return { ok: true, seeded: true, reason: built.reason };
    },
  }),

  // First-run seed (contract v60, F7): ONE global emptiness
  // check over every dataset table (seedGuardCore), then BOTH
  // sample datasets as a single all-or-nothing operation — the
  // packaged build's boot path calls this instead of the two
  // individual seed actions, so a store holding any real record
  // receives no sample rows from either seed, and a store that
  // passes the check receives both datasets or (on failure) is
  // reported unseeded so the caller does not mark it seeded.
  seedFirstRun: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.object({}),
    response: z.object({ ok: z.boolean(), seeded: z.boolean(), reason: z.string() }),
    async handler(ctx): Promise<{ ok: boolean; seeded: boolean; reason: string }> {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      const presence = await loadDatasetPresence(db);
      if (!datasetIsEmpty(presence)) {
        return {
          ok: true,
          seeded: false,
          reason: `Dataset is not empty (${nonEmptyDatasetTables(presence).join(", ")}) — nothing seeded.`,
        };
      }
      // All-or-nothing, as this action's contract has always
      // claimed (contract v64, A3 — audit F23/F24): BOTH builders
      // only BUILD their statements, and the two sets commit as
      // ONE db.batch. A failure anywhere — including the second
      // dataset's statements — lands NOTHING from either, leaving
      // an empty dataset a plain retry can seed; and two
      // overlapping dispatches cannot double the roster, because
      // the loser's batch collides on the builders' explicit ids
      // and rolls back whole (its emptiness read raced, its batch
      // cannot land).
      const spending = await seedExamplesStatements(db, key);
      if (!spending.ok) {
        return { ok: false, seeded: false, reason: spending.reason };
      }
      const nw = await seedNetWorthStatements(db, key);
      if (!nw.seeded) {
        return { ok: false, seeded: false, reason: nw.reason };
      }
      type BatchItem = Parameters<typeof db.batch>[0][number];
      const all = [...spending.statements, ...nw.statements];
      if (all.length > 0) {
        await db.batch(all as [BatchItem, ...BatchItem[]]);
      }
      ctx.invalidateQueries();
      return { ok: true, seeded: true, reason: "Sample data loaded." };
    },
  }),

  getNetWorth: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.object({}),
    response: z.object({
      // View-level toggle: true only when the persisted
      // "nw_include_property" setting is "1". Default (absent) = off,
      // so property accounts are excluded from every total below.
      includeProperty: z.boolean(),
      // Editable net worth target in cents, stored in settings under
      // "nw_target_cents". Null when no target has been set (the
      // default) — the view then shows only a subtle set affordance.
      targetCents: z.number().nullable(),
      // Section fold state for the Net Worth view's Accounts and
      // History sections, persisted in settings like the spending
      // side's collapse flags. Default (absent) = collapsed; only an
      // explicit "0" (user expanded it) reads as expanded.
      accountsCollapsed: z.boolean(),
      historyCollapsed: z.boolean(),
      // The Growth chart's "Change since" baseline: the stored
      // "nw_growth_since" setting when it holds a plain
      // YYYY-MM-DD date, else null — the view then baselines
      // growth at the first snapshot.
      growthSinceDate: z.string().nullable(),
      accounts: z.array(
        z.object({
          id: z.number(),
          name: z.string(),
          sortOrder: z.number(),
          archived: z.boolean(),
          propertyKind: nwPropertyKindEnum,
          // True for a custodial account (e.g. UTMA/UGMA): recorded
          // like any other account, but never counted in any total
          // or calculation. Custodial accounts are never property
          // accounts (propertyKind stays "none").
          custodial: z.boolean(),
        }),
      ),
      snapshots: z.array(
        z.object({
          id: z.number(),
          date: z.string(),
          note: z.string().nullable(),
          // Whole-snapshot revision (contract v65, F11/F12): the
          // CAS base the snapshot and single-balance editors pass
          // back as baseRevision when saving.
          revision: z.number(),
          // Grand total for this snapshot, respecting the toggle:
          // property accounts contribute nothing when it is off;
          // when on, property assets add and property liabilities
          // subtract. Non-property balances count as entered.
          totalCents: z.number(),
          // Signed net of this snapshot's property accounts alone
          // (assets − liabilities), whether or not the toggle is on.
          // Null when no property account has a balance recorded.
          // Invariant: when the toggle is on,
          // totalCents = (non-property total) + (propertyNetCents ?? 0),
          // and bucket subtotals (client-side, property excluded)
          // + property net = totalCents.
          propertyNetCents: z.number().nullable(),
          // Sum of this snapshot's custodial balances, reported for
          // display only — it is added to NO total. Null when no
          // custodial account has a balance recorded.
          custodialTotalCents: z.number().nullable(),
          balances: z.array(
            z.object({
              accountId: z.number(),
              balanceCents: z.number(),
              // The balance's split across tax buckets. Empty array =
              // no split: the whole balance counts as Unbucketed.
              // When non-empty, the parts sum to balanceCents.
              // Property accounts never carry splits.
              splits: z.array(
                z.object({ bucket: nwSplitBucketEnum, amountCents: z.number() }),
              ),
            }),
          ),
        }),
      ),
      // Data-integrity warning lines for this load (snapshot
      // totals, bucket splits). Empty when the stored data passes
      // every check — the UI renders nothing for an empty list.
      integrityWarnings: z.array(z.string()),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      const { accounts, snapshots: snaps, balances } = await loadNetWorthDecrypted(ctx, db, key);
      const settingRows = await db.select().from(schema.settings);
      const includeProperty =
        settingRows.find((r) => r.key === NW_INCLUDE_PROPERTY_KEY)?.value === "1";
      const accountsCollapsed =
        settingRows.find((r) => r.key === "nw_accounts_collapsed")?.value !== "0";
      const historyCollapsed =
        settingRows.find((r) => r.key === "nw_history_collapsed")?.value !== "0";
      const growthSinceRaw =
        settingRows.find((r) => r.key === "nw_growth_since")?.value;
      const growthSinceDate =
        growthSinceRaw != null && dateRe.test(growthSinceRaw)
          ? growthSinceRaw
          : null;
      const targetRaw = settingRows.find((r) => r.key === NW_TARGET_KEY)?.value;
      let targetCents: number | null = null;
      if (targetRaw != null && targetRaw !== "") {
        if (isEncrypted(targetRaw)) {
          const n = await decryptNum(key, targetRaw as unknown);
          targetCents = Number.isFinite(n) && n > 0 ? n : null;
        } else {
          const n = Number.parseInt(targetRaw, 10);
          targetCents = Number.isFinite(n) && n > 0 ? n : null;
        }
      }
      const classById = classByIdOf(accounts);
      const bySnapshot = new Map<
        number,
        { accountId: number; balanceCents: number; splits: { bucket: NwSplitBucket; amountCents: number }[] }[]
      >();
      // The raw rows alongside: snapshotTotals reads the split
      // columns itself (nwCore's effective-balance rule), so it
      // is fed the un-reshaped balances.
      const rawBySnapshot = new Map<number, CoreNwBalance[]>();
      for (const b of balances) {
        const arr = bySnapshot.get(b.snapshotId) ?? [];
        const cls = classById.get(b.accountId) ?? { kind: "none" as NwPropertyKind, custodial: false };
        arr.push({
          accountId: b.accountId,
          balanceCents: b.balanceCents,
          // Property and custodial accounts never carry splits.
          splits: isPropertyKind(cls.kind) || cls.custodial ? [] : splitPartsOf(b),
        });
        bySnapshot.set(b.snapshotId, arr);
        const raw = rawBySnapshot.get(b.snapshotId) ?? [];
        raw.push(b);
        rawBySnapshot.set(b.snapshotId, raw);
      }
      return {
        includeProperty,
        targetCents,
        accountsCollapsed,
        historyCollapsed,
        growthSinceDate,
        accounts: accounts.map((a) => ({
          id: a.id,
          name: a.name,
          sortOrder: a.sortOrder,
          archived: a.archived === 1,
          propertyKind: propertyKindOf(a),
          custodial: isCustodialAccount(a),
        })),
        snapshots: snaps.map((s) => {
          const bs = bySnapshot.get(s.id) ?? [];
          // The total / property-net math lives in the shared NW
          // core (server/src/nwCore.ts) — the same code the Year
          // Summary and the accuracy fixtures run.
          const totals = snapshotTotals(rawBySnapshot.get(s.id) ?? [], classById, includeProperty);
          return {
            id: s.id,
            date: s.date,
            note: s.note ?? null,
            revision: s.revision ?? 0,
            totalCents: totals.totalCents,
            propertyNetCents: totals.propertyNetCents,
            custodialTotalCents: totals.custodialTotalCents,
            balances: bs,
          };
        }),
        integrityWarnings: integrityWarningLines([
          checkNwSnapshotTotals({ accounts, snapshots: snaps, balances }, includeProperty),
          checkNwBucketSplits({ accounts, snapshots: snaps, balances }),
        ]),
      };
    },
  }),

  // Persist the Net Worth view's "Include house & mortgage" toggle.
  // Display-scope only in the sense that it changes which accounts
  // the totals/charts include — it never touches any account,
  // snapshot, or balance row. Default (no stored value) is off.
  setNwIncludeProperty: defineAction({
    request: z.object({ include: z.boolean() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db
        .insert(schema.settings)
        .values({
          key: NW_INCLUDE_PROPERTY_KEY,
          value: args.include ? "1" : "0",
        })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value: args.include ? "1" : "0" },
        });
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // Set (or clear) the editable net worth target. Stored in settings
  // under "nw_target_cents" as a plain integer-cents string; null
  // clears it (the row is deleted, returning to the empty default).
  setNwTarget: defineAction({
    request: z.object({
      targetCents: z.number().int().positive().nullable(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      if (args.targetCents == null) {
        await db
          .delete(schema.settings)
          .where(eq(schema.settings.key, NW_TARGET_KEY));
      } else {
        await db
          .insert(schema.settings)
          .values({ key: NW_TARGET_KEY, value: String(args.targetCents) })
          .onConflictDoUpdate({
            target: schema.settings.key,
            set: { value: String(args.targetCents) },
          });
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  /* ---------------- Retirement calculator ----------------
     Inputs persist as one encrypted JSON blob in settings under
     "retirement_calc_inputs_v1" (the existing settings mechanism).
     Defaults are computed live from the app's own figures: the
     starting portfolio is the latest snapshot total from
     getNetWorth (respecting the Include house & mortgage toggle)
     minus that snapshot's 529 (college) bucket subtotal,
     and annual spending is the trailing True cost (smoothed)
     average, annualised ×12, using the exact per-month eff() math
     and the same trailing-12-month window as getDashboard's
     Actual average. */
  getRetirementCalc: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.object({}),
    response: z.object({
      defaultPortfolioCents: z.number(),
      // The toggle-aware latest Net Worth total BEFORE the 529
      // exclusion, and the latest snapshot's 529 (college) bucket
      // subtotal that was excluded from it (null = the snapshot has
      // no 529 split, so $0 was excluded). The Starting portfolio
      // note in the Retirement view shows the subtraction from
      // these two figures; defaultPortfolioCents is the result.
      nwTotalCents: z.number(),
      bucket529Cents: z.number().nullable(),
      latestSnapshotHasAnySplit: z.boolean(),
      defaultSpendingAnnualCents: z.number(),
      // The window the trailing True cost average covers (see
      // computeRetirementDefaults): first/last month "YYYY-MM"
      // (null when there is no data) and the number of months
      // averaged. Display provenance for the Annual spending
      // source line only — no engine reads these.
      defaultSpendingWindowStart: z.string().nullable(),
      defaultSpendingWindowEnd: z.string().nullable(),
      defaultSpendingMonths: z.number(),
      includeProperty: z.boolean(),
      // Factory default for Current age (see computeRetirementDefaults):
      // current year minus the birth year stored in the Roth inputs,
      // or the fixed fallback 55 when no birth year is stored.
      defaultCurrentAge: z.number(),
      defaultCurrentAgeFromBirthYear: z.boolean(),
      saved: z
        .object({
          portfolioCents: z.number().nullable(),
          spendingCents: z.number().nullable(),
          currentAge: z.number().nullable(),
          retirementAge: z.number().nullable(),
          endAge: z.number().nullable(),
          stocksPct: z.number().nullable(),
          extraIncomeCents: z.number().nullable(),
          extraIncomeStartAge: z.number().nullable(),
          expectedReturnPct: z.number().nullable(),
          volatilityPct: z.number().nullable(),
          strategy: retirementStrategy.nullable(),
          percentOfPortfolio: z.number().nullable(),
          guardrailsCutPct: z.number().nullable(),
          guardrailsRaisePct: z.number().nullable(),
          guardrailsAdjustmentPct: z.number().nullable(),
          phaseStartAge: z.number().nullable(),
          phaseDeclinePct: z.number().nullable(),
        })
        .nullable(),
      scenarios: z.array(retirementScenario),
      // The what-if comparison baseline (see the baseline storage
      // note above): the input set the working inputs are compared
      // against, and which kind it is — "saved" after an explicit
      // "Make this my plan", "session" when it was captured from the
      // saved inputs on first open. Null only when there is no
      // saved inputs record yet to capture from.
      baseline: retirementInputsShape.nullable(),
      baselineKind: z.enum(["saved", "session"]).nullable(),
      // The two records' write revisions (API follow-on F23):
      // writers pass them back as saveRetirementCalc's
      // baseRevision / saveRetirementBaseline's baseRevision +
      // baseBaselineRevision so a stale save is refused instead
      // of silently overwriting a newer one. 0 for a record
      // written before revisions existed, and for an absent row.
      revision: z.number().int().nonnegative(),
      baselineRevision: z.number().int().nonnegative(),
      // Result-honesty markers (contract v67, F06/F07): true when
      // the saved inputs record / the baseline record EXISTS but
      // cannot be read. In that state saved / baseline read as
      // null exactly as an absent record would — these markers
      // are how the view tells "your saved record can't be read"
      // apart from "no record yet" instead of pricing the
      // defaults as a fresh plan.
      savedUnreadable: z.boolean(),
      baselineUnreadable: z.boolean(),
      // Assumptions group UI state: true when the Retirement
      // view's Assumptions group (Expected return, Volatility) is
      // collapsed. Persisted server-side in settings like the
      // Spending sections' collapse flags, so it survives reloads
      // and works across devices. Default (no stored value) is
      // COLLAPSED. Display only — no engine reads it.
      assumptionsCollapsed: z.boolean(),
      // Spending-field entry unit UI state: which period the
      // Retirement view's spending field opens in. Persisted
      // server-side in settings like the Assumptions collapse
      // flag, so it survives reloads and works across devices.
      // Default (no stored value) is "month". Display only —
      // the stored spending value is annual cents everywhere
      // and no engine reads this.
      spendingUnit: z.enum(["month", "year"]),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      const {
        defaultPortfolioCents,
        nwTotalCents,
        bucket529Cents,
        latestSnapshotHasAnySplit,
        defaultSpendingAnnualCents,
        defaultSpendingWindowStart,
        defaultSpendingWindowEnd,
        defaultSpendingMonths,
        includeProperty,
        defaultCurrentAge,
        defaultCurrentAgeFromBirthYear,
      } = await computeRetirementDefaults(ctx, db, key);

      // --- saved inputs (encrypted JSON in settings) ---
      const blobState = await readRetirementBlobState(db, key);
      const blob = blobState.blob;
      const scenarios = blobState.scenarios;
      const saved: RetirementInputs | null = blob
        ? retirementInputsFromRecord(blob)
        : null;

      // --- baseline: the stored one wins; with none stored and a
      // saved inputs record present, capture the session baseline
      // from that record exactly as it stands at this first open
      // and persist it, so it survives reloads and devices until
      // an explicit "Make this my plan" replaces it. ---
      // F23: the capture is INSERT-IF-ABSENT (guard-or-skip —
      // decideRetirementCapture in rothRevisionCore.ts). A CAS
      // refusal cannot be surfaced from inside a read, so the
      // capture may CREATE the row, atomically, only if it is
      // still absent at commit; it may never REPLACE one. (The
      // pre-F23 read-then-upsert could land after a racing
      // "Make this my plan" and silently replace the explicit
      // saved baseline with a stale session capture.) A created
      // row is a first write and establishes revision 1; if the
      // insert no-ops (a racing writer landed first), the
      // baseline state is re-read and THAT is returned instead
      // of the captured candidate.
      const baselineState = await readRetirementBaselineState(db, key);
      let baselineRec: {
        kind: RetirementBaselineKind;
        inputs: RetirementInputs;
      } | null = baselineState.baseline;
      let baselineRevision = baselineState.revision;
      // Result-honesty (contract v67, F07): a baseline that exists
      // but cannot be read is NOT "no baseline" — the capture below
      // must not run against it (its insert-if-absent would no-op
      // anyway, but the marker is what the view renders from).
      const baselineUnreadable =
        baselineState.present && !baselineState.valid;
      if (!baselineRec && saved && !baselineUnreadable) {
        const settingRowsNow = await db.select().from(schema.settings);
        const baselineExists = settingRowsNow.some(
          (r: { key: string }) => r.key === RETIREMENT_BASELINE_KEY,
        );
        if (decideRetirementCapture(baselineExists) === "write") {
          const enc = await encryptStr(
            key,
            JSON.stringify(
              composeRetirementBaselineBlob("session", saved, 1),
            ),
          );
          await db
            .insert(schema.settings)
            .values({ key: RETIREMENT_BASELINE_KEY, value: enc })
            .onConflictDoNothing();
          const after = await readRetirementBaselineState(db, key);
          if (after.baseline) {
            baselineRec = after.baseline;
            baselineRevision = after.revision;
          }
        }
      }

      // --- Assumptions group collapse flag (settings, plain) ---
      const settingRows = await db.select().from(schema.settings);
      const assumptionsCollapsed =
        settingRows.find(
          (r: { key: string }) => r.key === "retirement_assumptions_collapsed",
        )?.value !== "0";

      // --- Spending-field entry unit (settings, plain): the
      // last-used unit wins; only an explicitly stored "year"
      // opens per year — anything else (including no stored
      // value) opens per month, the starting default. ---
      const spendingUnit =
        settingRows.find(
          (r: { key: string }) => r.key === "retirement_spending_unit",
        )?.value === "year"
          ? ("year" as const)
          : ("month" as const);

      return { defaultPortfolioCents, nwTotalCents, bucket529Cents, latestSnapshotHasAnySplit, defaultSpendingAnnualCents, defaultSpendingWindowStart, defaultSpendingWindowEnd, defaultSpendingMonths, includeProperty, defaultCurrentAge, defaultCurrentAgeFromBirthYear, saved, scenarios, baseline: baselineRec?.inputs ?? null, baselineKind: baselineRec?.kind ?? null, revision: blobState.revision, baselineRevision, savedUnreadable: blobState.revisionState.present && !blobState.revisionState.valid, baselineUnreadable, assumptionsCollapsed, spendingUnit };
    },
  }),

  // Set the Retirement view Assumptions group's collapsed UI
  // state. Display only — persisted server-side in settings so it
  // survives reloads, new sessions, and devices, exactly like the
  // Spending sections' set*CollapsedAll actions. No input,
  // amount, or total is touched.
  setRetirementAssumptionsCollapsed: defineAction({
    request: z.object({
      collapsed: z.boolean(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db
        .insert(schema.settings)
        .values({
          key: "retirement_assumptions_collapsed",
          value: args.collapsed ? "1" : "0",
        })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value: args.collapsed ? "1" : "0" },
        });
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // Set the Retirement view spending field's entry unit (per
  // year / per month). Display only — persisted server-side in
  // settings so it survives reloads, new sessions, and devices,
  // exactly like setRetirementAssumptionsCollapsed. The stored
  // spending value is annual cents and is NOT touched: flipping
  // the unit writes only this preference.
  setRetirementSpendingUnit: defineAction({
    request: z.object({
      unit: z.enum(["month", "year"]),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db
        .insert(schema.settings)
        .values({
          key: "retirement_spending_unit",
          value: args.unit,
        })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value: args.unit },
        });
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  saveRetirementCalc: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    // baseRevision (API follow-on F23) is the CAS base: the
    // blob-1 revision the writer's copy of the record was read
    // at. It is stripped before the compose, so it can never be
    // stored as a blob field — the revision lives as its own
    // top-level key, stamped by the compose.
    request: z
      .object({
        ...retirementInputFields,
        baseRevision: z.number().int().nonnegative().optional(),
      })
      .superRefine(retirementAgesRefinement),
    response: saveRetirementCalcResponse,
    async handler(ctx, args): Promise<SaveRetirementCalcResponse> {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      const { baseRevision, ...fields } = args;
      const state = await readRetirementBlobState(db, key);
      // Result-honesty (contract v67, F06): a PRESENT but
      // unreadable record is never overwritten — refuse with the
      // lite record, exactly like a CAS conflict, and leave the
      // stored bytes intact.
      if (state.revisionState.present && !state.revisionState.valid) {
        const record = await loadRetirementLiteRecord(db, key);
        return {
          ok: false as const,
          conflict: true as const,
          revision: record.revision,
          baselineRevision: record.baselineRevision,
          record,
        };
      }
      // Fast-path CAS check on the decrypted read (mirrors
      // saveRothInputs): a writer whose base is already stale
      // (or from a "future" revision, or positive against an
      // absent row, which reads as revision 0) is refused
      // WITHOUT composing or encrypting anything, carrying the
      // lite current record freshly read at refusal time.
      // Storage is untouched.
      const decision = decideRothBlobWrite(state.revision, baseRevision);
      if (!decision.allowed) {
        const record = await loadRetirementLiteRecord(db, key);
        return {
          ok: false as const,
          conflict: true as const,
          revision: record.revision,
          baselineRevision: record.baselineRevision,
          record,
        };
      }
      const nextRevision = decision.nextRevision;
      // Merge with the existing blob so saved scenarios survive
      // every input save (including Reset to defaults). The
      // revision stamp is EXPLICIT in the compose — spreading
      // the request fields alone would drop a stored revision.
      const enc = await encryptStr(
        key,
        JSON.stringify(
          composeRetirementInputsBlob(fields, state.scenarios, nextRevision),
        ),
      );
      if (baseRevision === undefined) {
        // Legacy unchecked write (no baseRevision): unconditional
        // upsert, as before — except the write still bumps the
        // revision and returns it.
        await upsertRetirementBlobValue(db, enc);
        ctx.invalidateQueries();
        return { ok: true as const, revision: nextRevision };
      }
      if (state.storedRaw === undefined) {
        // First write WITH a CAS base (contract v64, A2 — audit
        // F20): insert-if-absent, mirroring saveRothInputs'
        // insert-only first write. Two overlapping first saves
        // both read "no record" and both pass the decision above
        // at base 0; the loser's insert is a no-op here and it is
        // refused with the current lite record instead of
        // overwriting the winner's save — exactly one success
        // and one conflict, never two revision-1 successes. A
        // CAS base > 0 against an absent row never reaches here:
        // the decision above already refused it (absent reads as
        // revision 0).
        const inserted = await insertSettingsValueIfAbsent(
          db,
          RETIREMENT_KEY,
          enc,
        );
        if (inserted) {
          ctx.invalidateQueries();
          return { ok: true as const, revision: nextRevision };
        }
        const record = await loadRetirementLiteRecord(db, key);
        return {
          ok: false as const,
          conflict: true as const,
          revision: record.revision,
          baselineRevision: record.baselineRevision,
          record,
        };
      }
      // CAS write against an existing row: commit with ONE
      // guarded UPDATE on the stored raw value. 0 affected rows
      // means a concurrent write landed between this
      // invocation's read and its commit: storage is untouched
      // by this invocation, so refuse with the re-read lite
      // record, exactly like the sequential conflict above.
      const committed = await commitSettingsValueGuarded(
        db,
        RETIREMENT_KEY,
        state.storedRaw,
        enc,
      );
      if (committed) {
        ctx.invalidateQueries();
        return { ok: true as const, revision: nextRevision };
      }
      const record = await loadRetirementLiteRecord(db, key);
      return {
        ok: false as const,
        conflict: true as const,
        revision: record.revision,
        baselineRevision: record.baselineRevision,
        record,
      };
    },
  }),

  // "Make this my plan": make the given input set BOTH the working
  // inputs (through the same merge saveRetirementCalc performs, so
  // saved scenarios survive) AND the comparison baseline, marked
  // as explicitly saved. From then on the baseline stays this
  // record until the next explicit save — autosaves of the working
  // inputs never move it.
  saveRetirementBaseline: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    // baseRevision / baseBaselineRevision (API follow-on F23)
    // are the CAS bases for blob 1 / blob 2 — the revisions the
    // writer's copy of each record was read at. Both are
    // stripped before any compose, so neither can be stored as
    // a blob field.
    request: z
      .object({
        ...retirementInputFields,
        baseRevision: z.number().int().nonnegative().optional(),
        baseBaselineRevision: z.number().int().nonnegative().optional(),
      })
      .superRefine(retirementAgesRefinement),
    response: saveRetirementBaselineResponse,
    async handler(ctx, args): Promise<SaveRetirementBaselineResponse> {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      const { baseRevision, baseBaselineRevision, ...fields } = args;
      const blobState = await readRetirementBlobState(db, key);
      const baselineState = await readRetirementBaselineState(db, key);
      const baselineStored = baselineState.revision;
      // Result-honesty (contract v67, F06/F07): if EITHER record
      // exists but cannot be read, refuse with NEITHER blob
      // written — an unreadable record is never overwritten.
      if (
        (blobState.revisionState.present && !blobState.revisionState.valid) ||
        (baselineState.present && !baselineState.valid)
      ) {
        const record = await loadRetirementLiteRecord(db, key);
        return {
          ok: false as const,
          conflict: true as const,
          revision: record.revision,
          baselineRevision: record.baselineRevision,
          record,
        };
      }
      // Decide BOTH bases up front, on the decrypted reads: a
      // refusal on either returns the inputs-conflict shape
      // with NEITHER blob written (the pair-commit decision
      // table, decideRetirementBaselinePair in
      // rothRevisionCore.ts).
      const inputsDecision = decideRothBlobWrite(
        blobState.revision,
        baseRevision,
      );
      const baselineDecision = decideRothBlobWrite(
        baselineStored,
        baseBaselineRevision,
      );
      const fastPath = decideRetirementBaselinePair({
        inputsRefused: !inputsDecision.allowed,
        baselineRefused: !baselineDecision.allowed,
        baselineCommit: "not-run",
        baselineRetry: "not-run",
      });
      if (fastPath === "inputs-conflict") {
        const record = await loadRetirementLiteRecord(db, key);
        return {
          ok: false as const,
          conflict: true as const,
          revision: record.revision,
          baselineRevision: record.baselineRevision,
          record,
        };
      }
      // --- Commit blob 1 exactly as saveRetirementCalc does ---
      const nextRevision = inputsDecision.allowed
        ? inputsDecision.nextRevision
        : blobState.revision + 1;
      const enc1 = await encryptStr(
        key,
        JSON.stringify(
          composeRetirementInputsBlob(
            fields,
            blobState.scenarios,
            nextRevision,
          ),
        ),
      );
      let inputsCommitted: boolean;
      if (baseRevision === undefined) {
        await upsertRetirementBlobValue(db, enc1);
        inputsCommitted = true;
      } else if (blobState.storedRaw === undefined) {
        // First write WITH a CAS base (contract v64, A2 — audit
        // F20): insert-if-absent, exactly as saveRetirementCalc.
        // A landed concurrent first save makes this a no-op, and
        // the refusal below returns the inputs-conflict shape
        // with NOTHING of this invocation written to either blob.
        inputsCommitted = await insertSettingsValueIfAbsent(
          db,
          RETIREMENT_KEY,
          enc1,
        );
      } else {
        inputsCommitted = await commitSettingsValueGuarded(
          db,
          RETIREMENT_KEY,
          blobState.storedRaw,
          enc1,
        );
      }
      if (!inputsCommitted) {
        // The blob-1 commit itself lost the commit-time race:
        // nothing of this invocation landed on either blob, so
        // refuse with the fresh lite record, exactly like the
        // fast-path conflict.
        const record = await loadRetirementLiteRecord(db, key);
        return {
          ok: false as const,
          conflict: true as const,
          revision: record.revision,
          baselineRevision: record.baselineRevision,
          record,
        };
      }
      // --- Commit blob 2: successor { kind: "saved", inputs:
      // args, revision: baselineStored + 1 }, guarded on blob
      // 2's stored raw when a base was supplied (legacy
      // unchecked upsert when it wasn't) ---
      const successShape = (newBaselineRevision: number) =>
        ({
          ok: true as const,
          revision: nextRevision,
          baselineRevision: newBaselineRevision,
          baseline: fields,
          baselineKind: "saved" as const,
        }) satisfies SaveRetirementBaselineResponse;
      if (baseBaselineRevision === undefined) {
        const nextBaselineRevision = baselineDecision.allowed
          ? baselineDecision.nextRevision
          : baselineStored + 1;
        await upsertRetirementBaselineValue(
          db,
          await encryptStr(
            key,
            JSON.stringify(
              composeRetirementBaselineBlob(
                "saved",
                fields,
                nextBaselineRevision,
              ),
            ),
          ),
        );
        ctx.invalidateQueries();
        return successShape(nextBaselineRevision);
      }
      if (baselineState?.storedRaw === undefined) {
        // First baseline write WITH a CAS base (contract v64,
        // A2 — audit F20): insert-if-absent, exactly as blob 1's
        // first write above. A landed concurrent first baseline
        // makes this a no-op; blob 1 IS committed and is NOT
        // rolled back (a rollback write would itself be an
        // unguarded clobber), so the refusal is the honest
        // stage: "baseline" conflict — the working inputs were
        // saved; the baseline did not move.
        const nextBaselineRevision = baselineDecision.allowed
          ? baselineDecision.nextRevision
          : baselineStored + 1;
        const inserted = await insertSettingsValueIfAbsent(
          db,
          RETIREMENT_BASELINE_KEY,
          await encryptStr(
            key,
            JSON.stringify(
              composeRetirementBaselineBlob(
                "saved",
                fields,
                nextBaselineRevision,
              ),
            ),
          ),
        );
        if (inserted) {
          ctx.invalidateQueries();
          return successShape(nextBaselineRevision);
        }
        const record = await loadRetirementLiteRecord(db, key);
        return {
          ok: false as const,
          conflict: true as const,
          stage: "baseline" as const,
          revision: record.revision,
          baselineRevision: record.baselineRevision,
          record,
        };
      }
      const nextBaselineRevision = baselineDecision.allowed
        ? baselineDecision.nextRevision
        : baselineStored + 1;
      const enc2 = await encryptStr(
        key,
        JSON.stringify(
          composeRetirementBaselineBlob(
            "saved",
            fields,
            nextBaselineRevision,
          ),
        ),
      );
      const firstCommit = await commitSettingsValueGuarded(
        db,
        RETIREMENT_BASELINE_KEY,
        baselineState.storedRaw,
        enc2,
      );
      if (firstCommit) {
        ctx.invalidateQueries();
        return successShape(nextBaselineRevision);
      }
      // 0-row baseline commit: the successor is fully
      // determined by the request, so re-read blob 2 ONCE and
      // re-commit against the fresh raw, stamping the fresh
      // revision + 1 (the retry-once analogue of the scenario
      // writers' re-apply).
      const freshBaseline = await readRetirementBaselineState(db, key);
      let retryCommitted = false;
      let retryRevision = nextBaselineRevision;
      if (freshBaseline?.storedRaw !== undefined) {
        retryRevision = freshBaseline.revision + 1;
        const retryEnc = await encryptStr(
          key,
          JSON.stringify(
            composeRetirementBaselineBlob("saved", fields, retryRevision),
          ),
        );
        retryCommitted = await commitSettingsValueGuarded(
          db,
          RETIREMENT_BASELINE_KEY,
          freshBaseline.storedRaw,
          retryEnc,
        );
      } else {
        // The baseline row vanished in the race: establishing
        // it fresh (revision 1) is the retry's commit.
        retryRevision = 1;
        await upsertRetirementBaselineValue(
          db,
          await encryptStr(
            key,
            JSON.stringify(
              composeRetirementBaselineBlob("saved", fields, retryRevision),
            ),
          ),
        );
        retryCommitted = true;
      }
      const pairOutcome = decideRetirementBaselinePair({
        inputsRefused: false,
        baselineRefused: false,
        baselineCommit: "zero",
        baselineRetry: retryCommitted ? "committed" : "zero",
      });
      if (pairOutcome === "success") {
        ctx.invalidateQueries();
        return successShape(retryRevision);
      }
      // A second 0-row: the honest stage: "baseline" conflict.
      // Blob 1 IS committed (revision is its new value) and is
      // NOT rolled back — a rollback write would itself be an
      // unguarded clobber. The carried record shows the
      // current, someone-else's baseline.
      const record = await loadRetirementLiteRecord(db, key);
      return {
        ok: false as const,
        conflict: true as const,
        stage: "baseline" as const,
        revision: record.revision,
        baselineRevision: record.baselineRevision,
        record,
      };
    },
  }),

  // Headline results for the BASELINE inputs, computed here with
  // the same engines the view runs (the shared retirementEngines
  // module), so each what-if delta compares a real engine run on
  // the baseline against the live run on the working inputs —
  // never arithmetic on displayed figures alone. The Historical
  // and Monte Carlo success rates returned here are the engines'
  // never-runs-out rates (neverOutSuccessRate) — the same
  // predicate the tabs headline — so a success-point delta
  // compares the same test on both sides. The Monte Carlo
  // uses the view's current seed and run count, and the Max
  // Spending solve uses the view's current solver engine / target,
  // so both sides of every delta are priced identically.
  getRetirementBaselineResults: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.object({
      mcSeed: z.number().int(),
      solverEngine: z.enum(["historical", "montecarlo"]),
      solverTarget: z.number(),
    }),
    response: z.object({
      baselineKind: z.enum(["saved", "session"]).nullable(),
      // Result-honesty marker (contract v67, F07): true when a
      // baseline record EXISTS but cannot be read — distinct
      // from "no baseline" (baselineKind null, marker false).
      baselineUnreadable: z.boolean(),
      projectionEndingCents: z.number().nullable(),
      historicalSuccessRate: z.number().nullable(),
      historicalMedianCents: z.number().nullable(),
      monteCarloSuccessRate: z.number().nullable(),
      maxSpendingCents: z.number().nullable(),
      maxSpendingSuccessRate: z.number().nullable(),
    }),
    async handler(ctx, args) {
      const empty = {
        baselineKind: null,
        baselineUnreadable: false,
        projectionEndingCents: null,
        historicalSuccessRate: null,
        historicalMedianCents: null,
        monteCarloSuccessRate: null,
        maxSpendingCents: null,
        maxSpendingSuccessRate: null,
      } as const;
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      const baselineState = await readRetirementBaselineState(db, key);
      const baselineRec = await readRetirementBaseline(db, key);
      if (!baselineRec)
        return {
          ...empty,
          baselineUnreadable: baselineState.present && !baselineState.valid,
        };
      const { defaultPortfolioCents, defaultSpendingAnnualCents, defaultCurrentAge } =
        await computeRetirementDefaults(ctx, db, key);
      const built = buildRetirementSimInputs(baselineRec.inputs, {
        portfolioCents: defaultPortfolioCents,
        spendingCents: defaultSpendingAnnualCents,
        defaultCurrentAge,
      });
      if (!built) return { ...empty, baselineKind: baselineRec.kind };
      const { inputs, stocks, expected, vol } = built;
      const years = Math.max(0, inputs.endAge - inputs.currentAge);
      const projPath = simulateRetirement(
        inputs,
        Array.from({ length: years }, () => expected),
      );
      const hist = runRetirementHistorical(inputs, stocks);
      const mc = runRetirementMonteCarlo(
        inputs,
        expected,
        vol,
        args.mcSeed,
        MONTE_CARLO_TAB_RUNS,
      );
      const target = Math.min(100, Math.max(0, args.solverTarget));
      const solver = solveRetirementMaxSpending(
        inputs,
        stocks,
        expected,
        vol,
        args.solverEngine,
        target,
        args.mcSeed,
      );
      return {
        baselineKind: baselineRec.kind,
        baselineUnreadable: false,
        projectionEndingCents: projPath[projPath.length - 1] ?? null,
        historicalSuccessRate: hist?.neverOutSuccessRate ?? null,
        historicalMedianCents: hist?.medianEnding ?? null,
        monteCarloSuccessRate: mc?.neverOutSuccessRate ?? null,
        maxSpendingCents: solver?.maxSpendingCents ?? null,
        maxSpendingSuccessRate: solver?.successRate ?? null,
      };
    },
  }),

  // Save the full current input set as a scenario (up to 3). The
  // name is auto-assigned the smallest free "Scenario N" slot. The
  // inputs part of the blob is preserved exactly. The write goes
  // through mutateRetirementScenarios (guarded commit, revision
  // bumped, one re-read-and-retry on a lost race — F23).
  saveRetirementScenario: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z
      .object({
        ...retirementInputFields,
      })
      .superRefine(retirementAgesRefinement),
    response: retirementScenarioWriteResponse,
    async handler(ctx, args): Promise<RetirementScenarioWriteResult> {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      const res = await mutateRetirementScenarios(db, key, (scenarios) =>
        appendRetirementScenario(scenarios, args),
      );
      if (res.ok) ctx.invalidateQueries();
      return res;
    },
  }),

  deleteRetirementScenario: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.object({ name: z.string().min(1).max(60) }),
    response: retirementScenarioWriteResponse,
    async handler(ctx, args): Promise<RetirementScenarioWriteResult> {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      const res = await mutateRetirementScenarios(db, key, (scenarios) =>
        deleteRetirementScenario(scenarios, args.name),
      );
      if (res.ok) ctx.invalidateQueries();
      return res;
    },
  }),

  // Rename a saved scenario. Names identify scenarios for load and
  // delete, so the new name must be non-blank (after trimming) and
  // must not collide with a different scenario's name. The stored
  // inputs and the blob's other fields are preserved exactly.
  renameRetirementScenario: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.object({
      name: z.string().min(1).max(60),
      newName: z.string().min(1).max(60),
    }),
    response: retirementScenarioWriteResponse,
    async handler(ctx, args): Promise<RetirementScenarioWriteResult> {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      const res = await mutateRetirementScenarios(db, key, (scenarios) =>
        renameRetirementScenario(scenarios, args.name, args.newName),
      );
      if (res.ok) ctx.invalidateQueries();
      return res;
    },
  }),

  /* ---------------- Roth Conversion planner ----------------
     Inputs and saved strategies live in the settings table as ONE
     encrypted JSON blob (ROTH_INPUTS_KEY), mirroring the
     Retirement calculator's blob: the inputs writer merges so a
     save never wipes the saved scenarios, and vice versa. All
     money fields are integer cents (the tax engine works in
     dollars; the client converts at the boundary). Every field is
     nullable: null means "use the client-side default / seed". */
  getRothPlanner: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.object({}),
    response: rothPlannerResponse,
    async handler(ctx): Promise<RothPlannerResponse> {
      return loadRothPlannerResponse(ctx);
    },
  }),

  // Reset the Roth plan record to the seeded defaults (the
  // fresh-user record): the plan inputs AND the This-year
  // execution block AND the gift block AND the MC-check
  // volatility all return to their seed values, derived by the
  // ONE seed implementation (server/src/rothSeed.ts, via
  // seedRothStoredInputs) from the current Retirement record
  // state and the latest snapshot conventions — balances seed
  // as null, which is what "follow the snapshot" means in the
  // saved record. SCENARIO SAFETY: the saved scenarios array is
  // carried through RAW (readRothBlobRawState + joinRothBlob),
  // never parsed or rewritten, so it passes through the reset
  // byte-identical — same records, same order, same fields.
  // REVISION (R4-2 / F3): the reset commits against the record
  // it read — guarded against the raw value the scenarios were
  // read from, or insert-only when no row exists — and stamps
  // revision = current + 1, never restarting the counter, so any
  // writer holding a pre-reset base conflicts cleanly afterwards
  // instead of accidentally matching a recycled 0. If another
  // save lands first, the reset re-reads and retries against the
  // freshest record a bounded number of times (scenarios still
  // pass through from the freshest read); if it keeps losing
  // that race it is refused with the current record — the same
  // conflict shape saveRothInputs returns — instead of
  // overwriting the newer save. No code path writes
  // unconditionally.
  // resetRothPlanner deliberately returns saveRothInputsResponse
  // — the SAME union saveRothInputs uses — so the family has
  // one conflict shape.
  resetRothPlanner: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.object({}),
    response: saveRothInputsResponse,
    async handler(ctx): Promise<SaveRothInputsResponse> {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      const stored = await seedRothStoredInputs(ctx, db, key);
      let state = await readRothBlobRawState(db, key);
      // Result-honesty (contract v67, F08): a reset never
      // reseeds over a PRESENT but unreadable record.
      if (state.storedRaw !== undefined && !state.valid) {
        const record = await loadRothPlannerResponse(ctx);
        return {
          ok: false as const,
          conflict: true as const,
          revision: record.revision,
          record,
        };
      }
      let lost = 0;
      for (;;) {
        const enc = await encryptStr(
          key,
          joinRothBlob(stored, state.scenariosRaw, state.revision + 1),
        );
        let committed: boolean;
        if (state.storedRaw === undefined) {
          committed = await insertRothBlobValueIfAbsent(db, enc);
        } else {
          committed = await commitSettingsValueGuarded(db, ROTH_INPUTS_KEY, state.storedRaw, enc);
        }
        if (committed) {
          ctx.invalidateQueries();
          return { ok: true as const, revision: state.revision + 1 };
        }
        lost += 1;
        if (decideRothResetAfterLoss(lost) === "refuse") {
          const record = await loadRothPlannerResponse(ctx);
          return {
            ok: false as const,
            conflict: true as const,
            revision: record.revision,
            record,
          };
        }
        state = await readRothBlobRawState(db, key);
      }
    },
  }),

  // The Roth view's guided-layout UI state: which input
  // sections are open, whether the Year-by-year table is
  // expanded, and which results workspace is showing — plus
  // the Playground view's remembered form state. Display and
  // form state only — defaults (no stored blob) are the
  // everyday sections open and "Advanced" closed, the year
  // table collapsed, the Plan workspace, and a fresh
  // Playground form. The response carries the blob's current write
  // revision, which writers pass back as baseRevision when
  // they save (see setRothUiState).
  getRothUiState: defineAction({
    request: z.object({}),
    response: rothUiStateResponse,
    async handler(ctx): Promise<z.infer<typeof rothUiStateResponse>> {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.settings);
      return parseRothUiState(rows.find((r) => r.key === ROTH_UI_STATE_KEY)?.value);
    },
  }),

  // Persist one piece of the Roth view's UI state (one section's
  // open flag, the year table's expanded flag, or the results
  // workspace mode) or the Playground form's complete remembered
  // state, merged into the stored blob so the pieces persist
  // independently. Display and form state only — no plan input,
  // scenario, or amount is touched.
  // Revision/CAS: a writer passes baseRevision — the revision
  // its copy of the blob was read at. If the stored revision
  // has moved on (a concurrent save from another tab or device
  // landed first), the write is refused with the current blob
  // and its revision, and storage is left untouched; the
  // writer re-merges against the current blob and retries at
  // the fresh revision. A write with no baseRevision keeps the
  // legacy unchecked behaviour against an EXISTING row. Either
  // way, an accepted write bumps the revision by one and
  // returns it.
  // The CAS commit is atomic, not just checked: against an
  // existing row it is a single UPDATE whose predicate requires
  // the revision inside the stored blob to still equal
  // baseRevision at commit time, verified by the statement's
  // affected-row count — so two invocations that both read
  // revision N before either commits cannot both succeed; the
  // second's UPDATE matches 0 rows and it is refused with the
  // re-read current blob, exactly like a sequential conflict.
  // A first write (no stored row) commits INSERT-ONLY, never
  // an unconditional upsert (state audit fix 1): two
  // invocations that both read "no row" at baseRevision 0
  // cannot both succeed — the second's insert conflicts, it
  // writes nothing, and it is refused with the re-read current
  // blob, exactly like a sequential conflict.
  setRothUiState: defineAction({
    request: z.object({
      section: z.enum(ROTH_SECTION_IDS).optional(),
      open: z.boolean().optional(),
      yearTableOpen: z.boolean().optional(),
      mode: z.enum(ROTH_RESULTS_MODES).optional(),
      labDials: rothLabDials.optional(),
      playground: playgroundFormState.optional(),
      labBaselineName: z.string().max(120).nullable().optional(),
      labDialsOpen: z.boolean().optional(),
      watchOutsOpen: z.boolean().optional(),
      assumptionsOpen: z.boolean().optional(),
      ceilCustomOpen: z.boolean().optional(),
      wyHowOpen: z.boolean().optional(),
      giftHowOpen: z.boolean().optional(),
      optHowOpen: z.boolean().optional(),
      execDetailOpen: z.boolean().optional(),
      detailYear: z.number().int().min(1900).max(2200).nullable().optional(),
      baseRevision: z.number().int().nonnegative().optional(),
    }),
    response: setRothUiStateResponse,
    async handler(ctx, args): Promise<SetRothUiStateResponse> {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.settings);
      const storedRaw = rows.find((r) => r.key === ROTH_UI_STATE_KEY)?.value;
      const result = applyRothUiWrite(
        storedRaw,
        args.baseRevision,
        (state) => {
          if (args.section !== undefined && args.open !== undefined) {
            state.open[args.section] = args.open;
          }
          if (args.yearTableOpen !== undefined) {
            state.yearTableOpen = args.yearTableOpen;
          }
          if (args.mode !== undefined) {
            state.mode = args.mode;
          }
          if (args.labDials !== undefined) {
            state.labDials = args.labDials;
          }
          if (args.playground !== undefined) {
            state.playground = args.playground;
          }
          if (args.labBaselineName !== undefined) {
            state.labBaselineName = args.labBaselineName;
          }
          if (args.labDialsOpen !== undefined) {
            state.labDialsOpen = args.labDialsOpen;
          }
          if (args.watchOutsOpen !== undefined) {
            state.watchOutsOpen = args.watchOutsOpen;
          }
          if (args.assumptionsOpen !== undefined) {
            state.assumptionsOpen = args.assumptionsOpen;
          }
          if (args.ceilCustomOpen !== undefined) {
            state.ceilCustomOpen = args.ceilCustomOpen;
          }
          if (args.wyHowOpen !== undefined) {
            state.wyHowOpen = args.wyHowOpen;
          }
          if (args.giftHowOpen !== undefined) {
            state.giftHowOpen = args.giftHowOpen;
          }
          if (args.optHowOpen !== undefined) {
            state.optHowOpen = args.optHowOpen;
          }
          if (args.execDetailOpen !== undefined) {
            state.execDetailOpen = args.execDetailOpen;
          }
          if (args.detailYear !== undefined) {
            state.detailYear = args.detailYear;
          }
        },
      );
      if (result.status === "conflict") {
        return {
          ok: false as const,
          conflict: true as const,
          revision: result.revision,
          state: result.state,
        };
      }
      if (storedRaw === undefined) {
        // First write establishing the row: INSERT-ONLY (state
        // audit fix 1), mirroring the plan record's first-write
        // pattern (insertRothBlobValueIfAbsent). A CAS base > 0
        // against an absent row never reaches here —
        // applyRothUiWrite already refused it above, carrying
        // the lenient-parsed default state at revision 0, and
        // nothing was written. If the insert conflicts, a
        // concurrent first write landed between this
        // invocation's read and its commit: this invocation
        // wrote nothing, so re-read the current blob and return
        // the conflict response, exactly like a sequential
        // conflict.
        const inserted = await insertRothUiStateValueIfAbsent(db, result.raw);
        if (inserted) {
          ctx.invalidateQueries();
          return { ok: true as const, revision: result.revision };
        }
        const currentRows = await db.select().from(schema.settings);
        const current = parseRothUiState(
          currentRows.find((r) => r.key === ROTH_UI_STATE_KEY)?.value,
        );
        return {
          ok: false as const,
          conflict: true as const,
          revision: current.revision,
          state: current,
        };
      }
      if (args.baseRevision === undefined) {
        // Legacy unchecked write (no baseRevision) against an
        // existing row: unconditional upsert, as before.
        await db
          .insert(schema.settings)
          .values({ key: ROTH_UI_STATE_KEY, value: result.raw })
          .onConflictDoUpdate({
            target: schema.settings.key,
            set: { value: result.raw },
          });
        ctx.invalidateQueries();
        return { ok: true as const, revision: result.revision };
      }
      // CAS write against an existing row: commit with ONE
      // guarded UPDATE. Its predicate re-checks, inside the same
      // statement that writes, that the revision stored in the
      // blob still equals the writer's base — the CASE over
      // json_extract reproduces parseRothUiState's lenient
      // revision read (unparseable blob, missing key, non-integer
      // or negative revision all count as 0), the same predicate
      // commitGuardedRothUiWrite mirrors in rothUiStateCore.ts.
      // Exactly 1 affected row is the commit. 0 rows means a
      // concurrent write landed between this invocation's read
      // above and this commit and advanced the stored revision
      // past the base: storage is untouched by this invocation,
      // so re-read the current blob and refuse with it, exactly
      // like the sequential conflict above.
      const baseRevision = args.baseRevision;
      const updated = await db
        .update(schema.settings)
        .set({ value: result.raw })
        .where(
          and(
            eq(schema.settings.key, ROTH_UI_STATE_KEY),
            sql`(case when json_valid(${schema.settings.value}) = 0 then 0 when json_extract(${schema.settings.value}, '$.revision') is null then 0 when typeof(json_extract(${schema.settings.value}, '$.revision')) <> 'integer' then 0 when json_extract(${schema.settings.value}, '$.revision') < 0 then 0 else json_extract(${schema.settings.value}, '$.revision') end) = ${baseRevision}`,
          ),
        )
        .returning({ key: schema.settings.key });
      if (updated.length === 1) {
        ctx.invalidateQueries();
        return { ok: true as const, revision: result.revision };
      }
      const currentRows = await db.select().from(schema.settings);
      const current = parseRothUiState(
        currentRows.find((r) => r.key === ROTH_UI_STATE_KEY)?.value,
      );
      return {
        ok: false as const,
        conflict: true as const,
        revision: current.revision,
        state: current,
      };
    },
  }),

  saveRothInputs: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    // The plan record's own writer is the ONLY writer that
    // accepts the execution-year fields — they save WITH the
    // plan inputs, in the same record. The scenario writers use
    // rothInputFields alone and the pricing requests (the
    // optimizer request included) spread rothComputeFields, so
    // execution fields can never leak into a scenario or a
    // pricing request. The market-uncertainty check's volatility
    // preference follows the same rule (rothMcCheckFields), and
    // so do the tax-return actuals (rothTaxReturnFields).
    // baseRevision (API follow-on 1) is the CAS base: the
    // revision the writer's copy of the record was read at.
    // It is REQUIRED on every call (state audit fix 2): the
    // strict decision (decideRothBlobWriteChecked) refuses a
    // missing or stale base with the conflict response, and
    // the legacy unconditional-upsert branch is deleted. The
    // field stays optional in this transport schema only so an
    // omitted base reaches that decision and returns the
    // structured conflict instead of a bare validation error;
    // contractually (see describeApi) it is not optional.
    request: z.object({
      ...rothInputFields,
      ...rothExecutionFields,
      ...rothMcCheckFields,
      ...rothGiftFields,
      ...rothTaxReturnFields,
      baseRevision: z.number().int().nonnegative().optional(),
    }),
    response: saveRothInputsResponse,
    async handler(ctx, args): Promise<SaveRothInputsResponse> {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      // Merge: saving inputs never wipes saved scenarios.
      // Normalize the declared "No benefit" state so declaration
      // and amount never coexist in storage. baseRevision is the
      // CAS base ONLY: it is stripped before normalization (which
      // spreads its input into the stored record), so the
      // revision can never leak into `inputs` — it lives as a
      // sibling key at the blob's top level, stamped below.
      const { baseRevision, ...recordArgs } = args;
      const normalized = normalizeSsDeclarations(recordArgs);
      const stored: RothStoredInputs = {
        ...normalized,
        giftAge: args.giftAge,
        giftAmountCents: args.giftAmountCents,
        giftBasisCents: args.giftBasisCents,
        giftKidBirthYear: args.giftKidBirthYear,
        giftKidStudent: args.giftKidStudent,
        giftKidOtherIncomeCents: args.giftKidOtherIncomeCents,
        giftSaleAge: args.giftSaleAge,
        executionYear: args.executionYear,
        executionPretaxCents: args.executionPretaxCents,
        executionPretaxSpouseCents: args.executionPretaxSpouseCents,
        executionRothCents: args.executionRothCents,
        executionTaxableCents: args.executionTaxableCents,
        executionHsaCents: args.executionHsaCents,
        executionOtherOrdinaryCents: args.executionOtherOrdinaryCents,
        executionTaxExemptInterestCents: args.executionTaxExemptInterestCents,
        executionAlreadyConvertedCents: args.executionAlreadyConvertedCents,
        mcVolatilityPct: args.mcVolatilityPct,
        taxReturnInterestCents: args.taxReturnInterestCents,
        taxReturnQualifiedDividendsCents: args.taxReturnQualifiedDividendsCents,
        taxReturnOrdinaryDividendsCents: args.taxReturnOrdinaryDividendsCents,
      };
      const blob = await readRothBlob(db, key);
      // Fast-path CAS check on the decrypted read (the strict
      // decision — baseRevision is required): a writer whose
      // base is MISSING, already stale (or from a "future"
      // revision, or positive against an absent row, which
      // reads as revision 0) is refused WITHOUT composing or
      // encrypting anything, carrying the current record exactly
      // as loadRothPlannerResponse returns it. Storage is
      // untouched. First-ever creation is the base-0 case
      // against an absent row, allowed here and committed
      // insert-only below.
      const decision = decideRothBlobWriteChecked(blob.revisionState, baseRevision);
      if (!decision.allowed) {
        const record = await loadRothPlannerResponse(ctx);
        return {
          ok: false as const,
          conflict: true as const,
          revision: record.revision,
          record,
        };
      }
      const nextRevision = decision.nextRevision;
      const enc = await encryptStr(
        key,
        JSON.stringify(
          withRothBlobRevision(
            { inputs: stored, scenarios: blob.scenarios },
            nextRevision,
          ),
        ),
      );
      const plan = rothFirstWritePlan(blob.storedRaw !== undefined, baseRevision);
      if (plan === "insert-only") {
        const inserted = await insertRothBlobValueIfAbsent(db, enc);
        if (inserted) {
          ctx.invalidateQueries();
          return { ok: true as const, revision: nextRevision };
        }
        const record = await loadRothPlannerResponse(ctx);
        return {
          ok: false as const,
          conflict: true as const,
          revision: record.revision,
          record,
        };
      }
      if (plan === "refused" || blob.storedRaw === undefined) {
        // Unreachable while the strict decision above and the
        // plan agree (a missing base, a positive base against
        // an absent row, and an invalid stored revision are all
        // refused by the decision before anything is composed).
        // Kept as a refuse-only backstop: there is NO unchecked
        // commit path in this handler — every route from here
        // is insert-only or the guarded update below.
        const record = await loadRothPlannerResponse(ctx);
        return {
          ok: false as const,
          conflict: true as const,
          revision: record.revision,
          record,
        };
      }
      // CAS write against an existing row: commit with ONE
      // guarded UPDATE (see commitSettingsValueGuarded). 0
      // affected rows means a concurrent write landed between
      // this invocation's read and its commit: storage is
      // untouched by this invocation, so refuse with the
      // re-read current record, exactly like the sequential
      // conflict above.
      const committed = await commitSettingsValueGuarded(db, ROTH_INPUTS_KEY, blob.storedRaw, enc);
      if (committed) {
        ctx.invalidateQueries();
        return { ok: true as const, revision: nextRevision };
      }
      const record = await loadRothPlannerResponse(ctx);
      return {
        ok: false as const,
        conflict: true as const,
        revision: record.revision,
        record,
      };
    },
  }),

  saveRothScenario: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.object({ ...rothInputFields }),
    response: rothScenarioWriteResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      // Merge: saving a scenario never wipes the working inputs —
      // and never rewrites them either: the inputs record goes back
      // exactly as it was stored (raw passthrough, nulls included).
      // The write goes through mutateRothScenarios (guarded
      // commit, revision bumped, one re-read-and-retry on a lost
      // race — API follow-on 1).
      const res = await mutateRothScenarios(db, key, (scenarios) => {
        if (scenarios.length >= ROTH_SCENARIO_LIMIT) {
          return {
            write: false,
            ok: false,
            reason:
              "You can keep up to 50 saved Roth strategies. Delete one first, then save this one.",
          };
        }
        const used = new Set(scenarios.map((s) => s.name));
        let n = scenarios.length + 1;
        while (used.has(`Scenario ${n}`)) n += 1;
        const normalized = normalizeSsDeclarations(args);
        return {
          write: true,
          ok: true,
          reason: `Saved as Scenario ${n}. Open Saved strategies to rename, load, or delete it.`,
          scenarios: [...scenarios, { name: `Scenario ${n}`, ...normalized }],
        };
      });
      if (res.ok) ctx.invalidateQueries();
      return res;
    },
  }),

  deleteRothScenario: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.object({ name: z.string().min(1).max(120) }),
    response: rothScenarioWriteResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      const res = await mutateRothScenarios(db, key, (scenarios) => {
        const next = scenarios.filter((s) => s.name !== args.name);
        if (next.length === scenarios.length) {
          return { write: false, ok: false, reason: "That scenario no longer exists." };
        }
        return {
          write: true,
          ok: true,
          reason: `Deleted ${args.name}.`,
          scenarios: next,
        };
      });
      if (res.ok) ctx.invalidateQueries();
      return res;
    },
  }),

  renameRothScenario: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.object({
      name: z.string().min(1).max(120),
      newName: z.string().max(120),
    }),
    response: rothScenarioWriteResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      const trimmed = args.newName.trim();
      const res = await mutateRothScenarios(db, key, (scenarios) => {
        if (!trimmed) {
          return { write: false, ok: false, reason: "Enter a name for the scenario." };
        }
        if (
          trimmed !== args.name &&
          scenarios.some((s) => s.name.toLowerCase() === trimmed.toLowerCase())
        ) {
          return {
            write: false,
            ok: false,
            reason: `A scenario named "${trimmed}" already exists.`,
          };
        }
        const next = scenarios.map((s) =>
          s.name === args.name ? { ...s, name: trimmed } : s,
        );
        if (!next.some((s) => s.name === trimmed)) {
          return { write: false, ok: false, reason: "That scenario no longer exists." };
        }
        return {
          write: true,
          ok: true,
          reason: `Renamed ${args.name} to ${trimmed}.`,
          scenarios: next,
        };
      });
      if (res.ok) ctx.invalidateQueries();
      return res;
    },
  }),

  /* Replace one saved scenario's record in place (the Strategy
     Lab's editor): the same full-record writer contract as
     saveRothScenario — a complete record is required and the
     "No benefit" declarations are normalized the same way —
     but the scenario keeps its name and its place in the
     library instead of appending a new auto-named row. The
     working inputs record passes through raw, untouched,
     exactly like the other scenario writers. */
  updateRothScenario: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    // Contract v65 (CAS sweep, F22): `baseScenario` is the named
    // scenario's complete payload as the editor loaded it. When
    // supplied, the transform refuses — at the SCENARIO level,
    // inside the blob's own raw-value CAS — when the named
    // scenario's stored payload no longer deep-equals the base:
    // blob freshness alone does not prove the scenario the editor
    // saw is still the scenario being replaced (another writer
    // may have edited THIS scenario while leaving the blob's
    // other scenarios, and the record's working inputs, alone).
    // The check re-runs on the mutate retry against the fresh
    // blob, so a concurrent write to a DIFFERENT scenario (or to
    // the working inputs) does not refuse this save. Omitting
    // `baseScenario` keeps the legacy blob-CAS-only behaviour
    // (named in DATA-PLAN).
    request: z.object({
      name: z.string().min(1).max(120),
      ...rothInputFields,
      baseScenario: z.object(rothInputFields).optional(),
    }),
    response: rothScenarioWriteResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      const { name, baseScenario, ...record } = args;
      let scenarioConflict = false;
      const res = await mutateRothScenarios(db, key, (scenarios) => {
        const stored = scenarios.find((s) => s.name === name);
        if (!stored) {
          return { write: false, ok: false, reason: "That scenario no longer exists." };
        }
        if (baseScenario !== undefined) {
          const { name: _storedName, ...storedPayload } = stored;
          if (!casDeepEqual(storedPayload, baseScenario)) {
            scenarioConflict = true;
            return {
              write: false,
              ok: false,
              reason: casConflictReason("saved strategy"),
            };
          }
        }
        const normalized = normalizeSsDeclarations(record);
        return {
          write: true,
          ok: true,
          reason: `Saved changes to ${name}.`,
          scenarios: scenarios.map((s) =>
            s.name === name ? { name, ...normalized } : s,
          ),
        };
      });
      if (res.ok) ctx.invalidateQueries();
      return scenarioConflict ? { ...res, conflict: true as const } : res;
    },
  }),

  // Lifetime-Tax Optimizer (Option 2): exhaustive scan of
  // level-ceiling strategies through the shared tax engine,
  // scored on lifetime net cost (tax + penalties + IRMAA − ACA
  // credit kept + terminal tax on leftover pre-tax at the heir
  // rate). The main run is the JOINT search: each entered Social
  // Security benefit's claiming age (every age 62–70) is varied
  // together with the conversion strategies (see
  // runJointOptimizer for the staged shape), and the winner and
  // runner-ups carry their claiming ages and derived benefits.
  // The joint search keeps the plan's draw order for every
  // combination; a separate fixed-age run (orderWinner /
  // orderRunnersUp below) holds the claiming ages at the
  // entered ones and searches all six draw orders against the
  // same strategy set, so the draw order itself competes there.
  // Read-only: it prices the inputs it is given and saves
  // nothing — saving the winner is the existing saveRothScenario
  // with the winner's parameters, claiming ages and draw order
  // included. The sensitivity strip re-runs the search at the
  // expected return ±1%, and the heir-rate strip re-runs it at
  // heir rates of 0%, 22%, and 32%, both at the entered claiming
  // ages and the plan's draw order (display only — neither strip
  // writes anything).
  runRothOptimizer: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.strictObject({
      ...rothComputeFields,
      // Transient FAFSA-reportable assets (cents), assembled
      // client-side — display-layer only (gates the college
      // watch-out in priced results). Deliberately NOT part of
      // rothInputFields: it is never persisted and never enters
      // a scenario; planInputsFromSaved passes it through to the
      // engine field.
      fafsaReportableAssetsCents: z.number().int().nullable().optional(),
      // Transient spend-from-cash sleeve size (cents) — the
      // snapshot Cash bucket portion of the taxable pool; never
      // persisted, never part of rothInputFields. Absent = the
      // server threads it from the snapshot when the taxable
      // balance follows the snapshot (see resolveArgsBalances).
      spendFromCashSleeveCents: z.number().int().nullable().optional(),
    }),
    response: z.object({
      ok: z.boolean(),
      reason: z.string(),
      provenance: provenanceOut,
      effectiveInputs: rothEffectiveInputsOut.nullable(),
      candidatesTested: z.number(),
      doNothing: optScoreOut.nullable(),
      winner: optScoreOut.nullable(),
      runnersUp: z.array(optScoreOut),
      // Priced levers (contract v69): the entered plan priced as
      // its own fixed strategy (its saved ceilings / window /
      // draw order / claiming ages), and the top distinct
      // candidates the search priced that beat it — each with
      // its exact gain vs that plan (savedPlan.netCost −
      // candidate.netCost, dollars, from the search's own
      // figures). winnerIsDoNothing crowns the benchmark
      // instead of a lever.
      savedPlan: optScoreOut.nullable(),
      improvements: z.array(
        optScoreOut.extend({ gainVsSavedPlan: z.number() }),
      ),
      winnerIsDoNothing: z.boolean(),
      // Draw-order search at the entered claiming ages (the
      // fixed-age run). When no claiming age was searched, the
      // joint run IS this run and these are its own scores.
      orderTested: z.number(),
      orderWinner: optScoreOut.nullable(),
      orderDoNothing: optScoreOut.nullable(),
      orderRunnersUp: z.array(optScoreOut),
      orderWinnerIsCurrent: z.boolean(),
      orderWinnerIsDoNothing: z.boolean(),
      sensitivity: z.array(
        z.object({
          returnPct: z.number(),
          winnerName: z.string(),
          windowLabel: z.string(),
          drawOrderLabel: z.string(),
          // The varied run winner's gain-harvesting state
          // (contract v56).
          gainsHarvest: z.boolean(),
          netCost: z.number(),
          // Lifetime Social Security collected under the varied
          // run's winner (dollars) — display only, beside the net
          // cost, in the same whole-dollar format as the winner
          // card. The engine accumulates it on every plan result.
          ssCollected: z.number(),
          changed: z.boolean(),
        }),
      ),
      heirRateSensitivity: z.array(
        z.object({
          heirRatePct: z.number(),
          winnerName: z.string(),
          windowLabel: z.string(),
          drawOrderLabel: z.string(),
          guardrail: z.boolean(),
          bunching: z.boolean(),
          gainsHarvest: z.boolean(),
          netCost: z.number(),
          ssCollected: z.number(),
          savingVsDoNothing: z.number(),
          isCurrentRate: z.boolean(),
        }),
      ),
      claimCombosTested: z.number(),
      claimSearchNote: z.string(),
      // The claim floor in effect for this run (62–70), or null
      // when none is set.
      claimAgeFloor: z.number().nullable(),
      // Whether the crowned winner meets the claim floor
      // (contract v56): null when no floor is set; true when
      // the winner claims at or above the floor (or has no
      // primary claiming age, or is the floor-exempt Do
      // Nothing benchmark); false when the winner claims
      // below the floor.
      claimAgeFloorMet: z.boolean().nullable(),
      // Per-claiming-age pricing table: one row per primary
      // claiming age the joint search varied, carrying that
      // age's best fully-priced candidate as a full score.
      // Empty when the primary's claiming age was not searched.
      claimAgeTable: z.array(
        z.object({
          primaryAge: z.number(),
          primaryAnnual: z.number(),
          survivorAnnual: z.number(),
          belowFloor: z.boolean(),
          isWinner: z.boolean(),
          best: optScoreOut,
        }),
      ),
    }),
    async handler(ctx, args) {
      // Plan-year capture (contract v60, F6): the Roth compute
      // actions (runRothOptimizer, runRothCompare,
      // runRothMonteCarloCheck / Stats, runWorkYearsCompare) and
      // the December console's default year read the year in UTC,
      // so the same instant prices the same starting year on the
      // server and in a browser in any timezone — before v60 the
      // local clock let a Los Angeles browser still be in the old
      // year while a UTC server had rolled over, pricing a
      // different horizon. Every other clock read in this file
      // (dashboard month strings, effectiveFrom defaults, seed
      // windows, the Retirement default age, and the non-listed
      // Roth readers runRothGiftCompare / runPlanYearDetail /
      // runRothFunding) stays on the local clock deliberately:
      // those are user-local calendar displays and defaults, not
      // priced plan years.
      const capturedYear = new Date().getUTCFullYear();
      const empty = {
        candidatesTested: 0,
        doNothing: null,
        winner: null,
        runnersUp: [],
        savedPlan: null,
        improvements: [],
        winnerIsDoNothing: false,
        orderTested: 0,
        orderWinner: null,
        orderDoNothing: null,
        orderRunnersUp: [],
        orderWinnerIsCurrent: false,
        orderWinnerIsDoNothing: false,
        sensitivity: [],
        heirRateSensitivity: [],
        claimCombosTested: 0,
        claimSearchNote: "",
        claimAgeFloor: null,
        claimAgeFloorMet: null,
        claimAgeTable: [],
      };
      const { resolved, effectiveInputs } = await computeEffectiveInputs(ctx, args, capturedYear);
      const inputs = planInputsFromSaved(resolved, capturedYear);
      if (!inputs) {
        return {
          ok: false,
          reason:
            "The optimizer needs a birth year before it can price a plan — enter it above and run again.",
          provenance: apiProvenance(),
          effectiveInputs,
          ...empty,
        };
      }
      const ageNow = inputs.startYear - inputs.birthYearPrimary;
      if (inputs.endAgePrimary <= ageNow) {
        return {
          ok: false,
          reason:
            "The plan end age is not after the current age, so there is no lifetime to optimize — raise the end age above and run again.",
          provenance: apiProvenance(),
          effectiveInputs,
          ...empty,
        };
      }
      const res = runJointOptimizer(inputs);
      const dnCost = res.doNothing.cost.netCost;
      const winnerKey = res.winner.spec.key;
      // Priced levers (contract v69): price the entered plan
      // itself as one fixed strategy — the same construction
      // the planner prices it with (strategyFromSavedArgs over
      // the resolved payload) at the entered claiming ages —
      // then select the distinct searched candidates that beat
      // its net cost from BOTH runs' scored lists (the joint
      // run varies claiming ages; the fixed-age run below
      // varies draw orders).
      const savedStrategy = strategyFromSavedArgs(resolved);
      const savedResult = simulateRothPlan(inputs, savedStrategy);
      const savedCost = planNetCost(savedResult, inputs);
      const savedPlanScore: ScoredCandidate = {
        spec: {
          key: "entered-plan",
          name: "Your saved plan",
          ceilings: savedStrategy.ceilings ?? {
            bracketTopPct: null,
            irmaaTierCap: null,
            ltcgZeroCap: false,
            acaCliffCap: false,
            acaCliffCapFamilyOnly: false,
            magiCap: null,
            acaCliffBuffer: null,
          },
          windowStopAge: inputs.windowStopAge,
          windowKind: "throughRmd",
          windowLabel: "",
          guardrail: savedStrategy.guardrail ?? false,
          bunching: savedStrategy.bunching ?? false,
          gainsHarvest: savedStrategy.gainsHarvest ?? false,
          drawOrder: inputs.drawOrder,
        },
        result: savedResult,
        cost: savedCost,
        claimAges: enteredClaimInfo(inputs),
      };
      // Draw-order search at the entered claiming ages: the
      // fixed-age run, which prices all six draw orders against
      // the full strategy set. When no claiming age was searched
      // there is only one combination and the joint run above IS
      // the fixed-age run — reuse it instead of pricing the same
      // scan twice.
      const fixedAge = res.jointSearch.combosTested > 1 ? runOptimizer(inputs) : res;
      const fixedDnCost = fixedAge.doNothing.cost.netCost;
      const orderWinnerIsDoNothing = fixedAge.winner.spec.key === DO_NOTHING_SPEC.key;
      const orderWinnerIsCurrent =
        !orderWinnerIsDoNothing &&
        drawOrderKey(fixedAge.winner.spec.drawOrder) === drawOrderKey(inputs.drawOrder);
      const sensitivity = [-1, 1].map((delta) => {
        const s = optimizerSensitivity(inputs, delta);
        return {
          returnPct: Math.round(s.returnPct * 100) / 100,
          winnerName: s.winner.spec.name,
          windowLabel: s.winner.spec.windowLabel,
          drawOrderLabel: drawOrderLabel(s.winner.spec.drawOrder),
          gainsHarvest: s.winner.spec.gainsHarvest ?? false,
          netCost: s.winner.cost.netCost,
          ssCollected: s.winner.cost.ssCollected,
          changed: s.winner.spec.key !== winnerKey,
        };
      });
      const heirRateSensitivity = [0, 22, 32].map((rate) => {
        const s = optimizerHeirSensitivity(inputs, rate);
        return {
          heirRatePct: rate,
          winnerName: s.winner.spec.name,
          windowLabel: s.winner.spec.windowLabel,
          drawOrderLabel: drawOrderLabel(s.winner.spec.drawOrder),
          guardrail: s.winner.spec.guardrail,
          bunching: s.winner.spec.bunching,
          gainsHarvest: s.winner.spec.gainsHarvest ?? false,
          netCost: s.winner.cost.netCost,
          ssCollected: s.winner.cost.ssCollected,
          savingVsDoNothing:
            Math.round((s.doNothing.cost.netCost - s.winner.cost.netCost) * 100) / 100,
          isCurrentRate: rate === inputs.heirRatePct,
        };
      });
      return {
        ok: true,
        reason:
          res.jointSearch.combosTested > 1
            ? `Searched ${res.jointSearch.combosTested} claiming-age combinations jointly with the conversion strategies — screened each combination, then fully priced ${res.candidatesTested} candidates (including Do Nothing) across every combination.`
            : `Tested ${res.candidatesTested} strategies (including Do Nothing), each a full lifetime simulation.`,
        provenance: apiProvenance(),
        effectiveInputs,
        candidatesTested: res.candidatesTested,
        doNothing: toOptScore(res.doNothing, dnCost),
        winner: toOptScore(res.winner, dnCost),
        runnersUp: res.runnersUp.map((s) => toOptScore(s, dnCost)),
        savedPlan: toOptScore(savedPlanScore, dnCost),
        improvements: optimizerImprovements(
          [res.scored, fixedAge.scored],
          savedCost.netCost,
        ).map(({ candidate, gainVsSavedPlan }) => ({
          ...toOptScore(candidate, dnCost),
          gainVsSavedPlan,
        })),
        winnerIsDoNothing: winnerKey === res.doNothing.spec.key,
        orderTested: fixedAge.candidatesTested,
        orderWinner: toOptScore(fixedAge.winner, fixedDnCost),
        orderDoNothing: toOptScore(fixedAge.doNothing, fixedDnCost),
        orderRunnersUp: fixedAge.runnersUp.map((s) => toOptScore(s, fixedDnCost)),
        orderWinnerIsCurrent,
        orderWinnerIsDoNothing,
        sensitivity,
        heirRateSensitivity,
        claimCombosTested: res.jointSearch.combosTested,
        claimSearchNote: jointSearchNote(res.jointSearch),
        claimAgeFloor: res.jointSearch.claimAgeFloor ?? null,
        claimAgeFloorMet: res.claimAgeFloorMet,
        claimAgeTable: res.claimAgeTable.map((row) => ({
          primaryAge: row.primaryAge,
          primaryAnnual: row.primaryAnnual,
          survivorAnnual: row.survivorAnnual,
          belowFloor: row.belowFloor,
          isWinner: row.isWinner,
          best: toOptScore(row.best, dnCost),
        })),
      };
    },
  }),

  // Engine-side scenario compare (saves nothing, like
  // runRothOptimizer): prices an ordered list of NAMED scenarios
  // against one base plan. Each scenario is a partial patch over
  // the base saved shape (drawOrder, drawOrderSwitchAge /
  // drawOrderAfter, ceilings, optimizerGuardrail /
  // optimizerBunching, survivor fields, claiming ages,
  // payTaxFrom, window ages, ACA fields — any saved field may be
  // patched; a key set to null clears it, an absent key inherits
  // the base). Each scenario is priced as ONE FIXED strategy
  // through simulateRothPlan — no candidate search — and the
  // response carries, per scenario and in request order: the
  // headline results in integer cents (net cost, total federal +
  // state tax, pre-59½ penalty, IRMAA, ACA credit kept, terminal
  // tax, Social Security collected, and the ending balances),
  // the effective strategy description, the scenario's merged
  // effective inputs echoed back (provenance), and the deltas of
  // net cost and ACA credit versus the baseline scenario —
  // computed in the engine, in cents, as scenario − baseline
  // (a negative net-cost delta = the scenario costs less). The
  // baseline is the scenario named by baselineName, defaulting
  // to the first scenario. A Do Nothing scenario is an ordinary
  // patch (ceilings: null) and can serve as the baseline.
  runRothCompare: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.strictObject({
      ...rothComputeFields,
      // Transient FAFSA-reportable assets (cents) — same
      // display-layer passthrough as runRothOptimizer; never
      // persisted, never part of rothInputFields.
      fafsaReportableAssetsCents: z.number().int().nullable().optional(),
      // Transient spend-from-cash sleeve size (cents) — the
      // snapshot Cash bucket portion of the taxable pool; never
      // persisted, never part of rothInputFields. Absent = the
      // server threads it from the snapshot when the taxable
      // balance follows the snapshot (see resolveArgsBalances).
      spendFromCashSleeveCents: z.number().int().nullable().optional(),
      baselineName: z.string().min(1).max(120).nullable().optional(),
      scenarios: z
        .array(
          z.strictObject({
            name: z.string().min(1).max(120),
            overrides: rothOverridesStrict,
          }),
        )
        .min(1)
        // Sized for the Strategy Lab: a full library (50 saved
        // strategies) plus the current-plan and Do Nothing rows
        // prices in one run.
        .max(60),
    }),
    response: z.object({
      ok: z.boolean(),
      reason: z.string(),
      provenance: provenanceOut,
      baselineName: z.string().nullable(),
      deltaConvention: z.string(),
      scenarios: z.array(
        z.object({
          name: z.string(),
          strategyDescription: z.string(),
          netCostCents: z.number(),
          totalTaxCents: z.number(),
          // Lifetime federal / state split of totalTaxCents
          // (contract v51): the two sum to totalTaxCents.
          federalTaxCents: z.number(),
          stateTaxCents: z.number(),
          // Per-year tax readouts (contract v51): one row
          // per priced march year, read off the same priced
          // rows the lifetime totals sum. Display only.
          years: z.array(
            z.object({
              year: z.number(),
              agePrimary: z.number(),
              ageSpouse: z.number().nullable(),
              federalTaxCents: z.number(),
              stateTaxCents: z.number(),
              totalIncomeCents: z.number(),
              taxableIncomeCents: z.number(),
              acaCreditCents: z.number(),
              irmaaCents: z.number(),
              conversionCents: z.number(),
              pretaxDrawCents: z.number(),
            }),
          ),
          penaltyCents: z.number(),
          irmaaCents: z.number(),
          acaCreditCents: z.number(),
          // Lifetime refundable education credit (T6): the
          // component the net-cost identity subtracts beside
          // acaCreditCents. 0 for any scenario with no
          // entered education expenses.
          educationRefundableCents: z.number(),
          // Lifetime AMT owed (T7): already inside
          // totalTaxCents — this line names the AMT
          // component of the scenario's lifetime tax. 0
          // for any scenario with no AMT exposure.
          amtCents: z.number(),
          terminalCents: z.number(),
          ssCollectedCents: z.number(),
          // Lifetime unpaid tax (round-5 fix 1): the part of
          // the scenario's assessed tax its balances could not
          // pay. 0 whenever the scenario always covers its bill.
          unpaidTaxCents: z.number(),
          endingPretaxCents: z.number(),
          endingRothCents: z.number(),
          endingTaxableCents: z.number(),
          endingHsaCents: z.number(),
          endingAfterTaxWealthCents: z.number(),
          deltaNetCostCents: z.number(),
          deltaAcaCreditCents: z.number(),
          // Scenario − baseline refundable education credit
          // (T6): positive means the scenario receives more.
          deltaEducationRefundableCents: z.number(),
          effectiveInputs: rothEffectiveInputsOut,
        }),
      ),
    }),
    async handler(ctx, args) {
      const capturedYear = new Date().getUTCFullYear();
      const resolved = await resolveArgsBalances(ctx, args);
      const result = runRothCompare(
        resolved,
        args.scenarios.map((s) => ({ name: s.name, overrides: s.overrides })),
        capturedYear,
        args.baselineName ?? null,
      );
      const fallbackInputs = parseRothInputs(resolved);
      return {
        ok: result.ok,
        reason: result.reason,
        provenance: apiProvenance(),
        baselineName: result.baselineName,
        deltaConvention:
          "Deltas are scenario − baseline, in cents: a negative deltaNetCostCents means the scenario costs less than the baseline; a positive deltaAcaCreditCents means the scenario keeps more ACA premium credit than the baseline.",
        scenarios: result.scenarios.map((s) => {
          const scenarioInputs = planInputsFromSaved(s.saved, capturedYear);
          return {
          name: s.name,
          strategyDescription: s.strategyDescription,
          netCostCents: s.netCostCents,
          totalTaxCents: s.totalTaxCents,
          federalTaxCents: s.federalTaxCents,
          stateTaxCents: s.stateTaxCents,
          years: s.years,
          penaltyCents: s.penaltyCents,
          irmaaCents: s.irmaaCents,
          acaCreditCents: s.acaCreditCents,
          educationRefundableCents: s.educationRefundableCents,
          amtCents: s.amtCents,
          terminalCents: s.terminalCents,
          ssCollectedCents: s.ssCollectedCents,
          unpaidTaxCents: s.unpaidTaxCents,
          endingPretaxCents: s.endingPretaxCents,
          endingRothCents: s.endingRothCents,
          endingTaxableCents: s.endingTaxableCents,
          endingHsaCents: s.endingHsaCents,
          endingAfterTaxWealthCents: s.endingAfterTaxWealthCents,
          deltaNetCostCents: s.deltaNetCostCents,
          deltaAcaCreditCents: s.deltaAcaCreditCents,
          deltaEducationRefundableCents: s.deltaEducationRefundableCents,
          // The echo carries the merged scenario's DERIVED
          // sleeve (the engine's effective starting sleeve for
          // that scenario, R4-3 F7), not the threaded
          // transient — attached exactly like the other
          // compute echoes. Balance keys pass through
          // withResolvedOverrideBalances first (hardening
          // package, finding A-2): an override's explicit null
          // priced that balance at $0, so the echo shows the
          // resolved 0 — the value that priced — not the null
          // that was sent.
          effectiveInputs: withSleeveEcho(
            withResolvedOverrideBalances(
              parseRothInputs(s.saved) ?? fallbackInputs ?? (resolved as z.infer<typeof rothSavedInputs>),
              s.saved,
            ),
            scenarioInputs == null
              ? null
              : Math.round(deriveSpendFromCashSleeveStartDollars(scenarioInputs) * 100),
          ),
          };
        }),
      };
    },
  }),

  // Read-only market-uncertainty check (saves nothing, like
  // runRothOptimizer): re-prices the optimizer's winning strategy
  // and Do Nothing across ROTH_MC_CHECK_PATHS varied return paths
  // from the one fixed stream (ROTH_MC_CHECK_SEED), both priced
  // from the same series on each path, and reports how robust
  // the win is. The volatility is the request's own
  // mcVolatilityPct — a panel preference that rides along here
  // only; it is not part of the plan payload and prices nothing
  // else.
  runRothMonteCarloCheck: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.strictObject({
      ...rothComputeFields,
      winner: mcScoreIn,
      doNothing: mcScoreIn,
      mcVolatilityPct: z.number().min(0).max(100),
      // Transient FAFSA-reportable assets (cents) — same
      // display-layer passthrough as runRothOptimizer; never
      // persisted, never part of rothInputFields.
      fafsaReportableAssetsCents: z.number().int().nullable().optional(),
      // Transient spend-from-cash sleeve size (cents) — the
      // snapshot Cash bucket portion of the taxable pool; never
      // persisted, never part of rothInputFields. Absent = the
      // server threads it from the snapshot when the taxable
      // balance follows the snapshot (see resolveArgsBalances).
      spendFromCashSleeveCents: z.number().int().nullable().optional(),
    }),
    response: z.object({
      ok: z.boolean(),
      reason: z.string(),
      provenance: provenanceOut,
      effectiveInputs: rothEffectiveInputsOut.nullable(),
      pathsRun: z.number(),
      winRatePct: z.number(),
      medianAdvantage: z.number(),
      p10Advantage: z.number(),
      p90Advantage: z.number(),
      winnerMedianNetCost: z.number(),
      doNothingMedianNetCost: z.number(),
      volatilityPct: z.number(),
      winnerName: z.string(),
    }),
    async handler(ctx, args) {
      const capturedYear = new Date().getUTCFullYear();
      const empty = {
        pathsRun: 0,
        winRatePct: 0,
        medianAdvantage: 0,
        p10Advantage: 0,
        p90Advantage: 0,
        winnerMedianNetCost: 0,
        doNothingMedianNetCost: 0,
        volatilityPct: args.mcVolatilityPct,
        winnerName: args.winner.name,
      };
      const { resolved, effectiveInputs } = await computeEffectiveInputs(ctx, args, capturedYear);
      const inputs = planInputsFromSaved(resolved, capturedYear);
      if (!inputs) {
        return {
          ok: false,
          reason:
            "The market-uncertainty check needs a birth year before it can price a plan — enter it above and run again.",
          provenance: apiProvenance(),
          effectiveInputs,
          ...empty,
        };
      }
      const ageNow = inputs.startYear - inputs.birthYearPrimary;
      if (inputs.endAgePrimary <= ageNow) {
        return {
          ok: false,
          reason:
            "The plan end age is not after the current age, so there is no lifetime to stress-test — raise the end age above and run again.",
          provenance: apiProvenance(),
          effectiveInputs,
          ...empty,
        };
      }
      const check = runRothMonteCarloCheck(
        inputs,
        mcCandidateFromScore(args.winner, false),
        mcCandidateFromScore(args.doNothing, true),
        {
          volatilityPct: args.mcVolatilityPct,
          pathCount: ROTH_MC_CHECK_PATHS,
          seed: ROTH_MC_CHECK_SEED,
        },
      );
      return {
        ok: true,
        reason: `Priced the winning strategy and Do Nothing across ${check.pathsRun} varied-return paths at ${args.mcVolatilityPct}% volatility.`,
        provenance: apiProvenance(),
        effectiveInputs,
        pathsRun: check.pathsRun,
        winRatePct: check.winRatePct,
        medianAdvantage: check.medianAdvantage,
        p10Advantage: check.p10Advantage,
        p90Advantage: check.p90Advantage,
        winnerMedianNetCost: check.winnerMedianNetCost,
        doNothingMedianNetCost: check.doNothingMedianNetCost,
        volatilityPct: args.mcVolatilityPct,
        winnerName: args.winner.name,
      };
    },
  }),

  // Monte Carlo stats for arbitrary scenarios (compute-only;
  // saves nothing, like runRothCompare): the sibling of the
  // market-uncertainty check above. Where the check prices the
  // optimizer's winner against Do Nothing and keeps only each
  // path's net cost, this prices COMPARE scenarios — the same
  // base payload + scenario patches runRothCompare accepts,
  // basis tiers included — across the check's fixed paired
  // stream (ROTH_MC_CHECK_PATHS paths, ROTH_MC_CHECK_SEED), and
  // reports the per-path detail the check discards: how many
  // paths ever ran an unfunded-spending year, and the ending
  // wealth / ending pre-tax / net cost percentiles, all in
  // integer cents (the runRothCompare convention). The scenario
  // cap is a runtime budget, not a library limit: every
  // scenario costs ROTH_MC_CHECK_PATHS full simulations, so
  // four scenarios is the check's own two-candidate sizing
  // doubled — well inside the worker budget on a typical plan.
  runRothMonteCarloStats: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.strictObject({
      ...rothComputeFields,
      // Transient FAFSA-reportable assets (cents) — same
      // display-layer passthrough as runRothCompare; never
      // persisted, never part of rothInputFields.
      fafsaReportableAssetsCents: z.number().int().nullable().optional(),
      // Transient spend-from-cash sleeve size (cents) — same
      // passthrough as runRothCompare. Absent = the server
      // threads it from the snapshot when the taxable balance
      // follows the snapshot (see resolveArgsBalances).
      spendFromCashSleeveCents: z.number().int().nullable().optional(),
      // Required, no default: an omitted or misspelled key
      // fails validation instead of silently pricing at some
      // assumed volatility (the F6/F20 lesson).
      volatilityPct: z.number().min(0).max(100),
      scenarios: z
        .array(
          z.strictObject({
            name: z.string().min(1).max(120),
            overrides: rothOverridesStrict,
          }),
        )
        .min(1)
        .max(4),
    }),
    response: z.object({
      ok: z.boolean(),
      reason: z.string(),
      provenance: provenanceOut,
      effectiveInputs: rothEffectiveInputsOut.nullable(),
      volatilityPct: z.number(),
      scenarios: z.array(
        z.object({
          name: z.string(),
          strategyDescription: z.string(),
          pathsRun: z.number(),
          pathsWithShortfall: z.number(),
          neverShortfallRatePct: z.number(),
          totalShortfallP50Cents: z.number(),
          totalShortfallP90Cents: z.number(),
          fullyFundedRatePct: z.number(),
          pathsWithUnpaidTax: z.number(),
          totalUnpaidTaxP50Cents: z.number(),
          totalUnpaidTaxP90Cents: z.number(),
          endingAfterTaxWealthP10Cents: z.number(),
          endingAfterTaxWealthP50Cents: z.number(),
          endingAfterTaxWealthP90Cents: z.number(),
          endingPretaxP10Cents: z.number(),
          endingPretaxP50Cents: z.number(),
          endingPretaxP90Cents: z.number(),
          netCostP10Cents: z.number(),
          netCostP50Cents: z.number(),
          netCostP90Cents: z.number(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const capturedYear = new Date().getUTCFullYear();
      const { resolved, effectiveInputs } = await computeEffectiveInputs(ctx, args, capturedYear);
      const result = runRothMonteCarloStats(
        resolved,
        args.scenarios.map((s) => ({ name: s.name, overrides: s.overrides })),
        capturedYear,
        {
          volatilityPct: args.volatilityPct,
          pathCount: ROTH_MC_CHECK_PATHS,
          seed: ROTH_MC_CHECK_SEED,
        },
      );
      return {
        ok: result.ok,
        reason: result.reason,
        provenance: apiProvenance(),
        effectiveInputs,
        volatilityPct: args.volatilityPct,
        scenarios: result.scenarios,
      };
    },
  }),

  // Work years compare (the Roth view's "Work years" tab):
  // compute-only — it prices the inputs it is given plus up to
  // three scratch quit ages and saves nothing. For each quit
  // age the work years are rolled forward by the tested
  // work-year engine (server/src/workYears.ts: contribution
  // stack from the law tables, salary-year federal tax through
  // the shared priceYear path, employee payroll tax priced
  // entirely from each year's own law row — wage base, rates,
  // and Additional Medicare threshold as dated table data;
  // contract v58: work-year yields and already-started Social
  // Security benefits priced as work-year income, deficit-
  // funding Taxable sales realizing gains off a basis ledger
  // that rolls forward in dollars into the rolled plan, the
  // roll never pricing a year before the plan's current age,
  // and the request-only medicareAgePrimary field stopping
  // HSA contributions in Medicare-enrolled years), then the
  // rolled balances are priced with the existing joint
  // optimizer.
  // The all-in lifetime tax is the optimizer's net cost plus
  // the work years' own federal tax + state tax + payroll tax,
  // and the row's totalTax folds the same work-year taxes into
  // the winner's tax, payroll as its own component. A quit age that
  // prices zero work years prices retiring at that quit age
  // (the rolled inputs carry the quit age as the retirement
  // age); a blank / $0 salary prices no work years at any age.
  runWorkYearsCompare: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.strictObject({
      ...rothComputeFields,
      quitAges: z.array(z.number().int()).min(1).max(3),
      // The primary's Medicare enrollment age (contract v58,
      // F6): request-only — never persisted, never part of the
      // saved record. In work years at or after this age the
      // household is HSA-ineligible and no HSA contribution
      // (employee or employer) is made. Absent / null = not
      // enrolled during the work years.
      medicareAgePrimary: z.number().int().min(0).max(120).nullable().optional(),
      fafsaReportableAssetsCents: z.number().int().nullable().optional(),
      // Transient spend-from-cash sleeve size (cents) — the
      // snapshot Cash bucket portion of the taxable pool; never
      // persisted, never part of rothInputFields. Absent = the
      // server threads it from the snapshot when the taxable
      // balance follows the snapshot (see resolveArgsBalances).
      spendFromCashSleeveCents: z.number().int().nullable().optional(),
    }),
    response: z.object({
      ok: z.boolean(),
      reason: z.string(),
      provenance: provenanceOut,
      effectiveInputs: rothEffectiveInputsOut.nullable(),
      rows: z.array(workYearsRowOut),
    }),
    async handler(ctx, args) {
      const capturedYear = new Date().getUTCFullYear();
      const { resolved, effectiveInputs } = await computeEffectiveInputs(ctx, args, capturedYear);
      const inputs = planInputsFromSaved(resolved, capturedYear);
      if (!inputs) {
        return {
          ok: false,
          reason:
            "The work-years compare needs a birth year before it can price a plan — enter it above and run again.",
          provenance: apiProvenance(),
          effectiveInputs,
          rows: [],
        };
      }
      const ages = [...args.quitAges].sort((a, b) => a - b);
      const distinct = new Set(ages);
      if (
        distinct.size !== ages.length ||
        ages.some((a) => a < inputs.windowStartAge || a > 75)
      ) {
        return {
          ok: false,
          reason: `Quit ages must be distinct, at least your window-start age (${inputs.windowStartAge}), and no more than 75.`,
          provenance: apiProvenance(),
          effectiveInputs,
          rows: [],
        };
      }
      const job = {
        salary: (args.yearlySalaryCents ?? 0) / 100,
        employer401k: (args.employer401kCents ?? 0) / 100,
        employerHsa: (args.employerHsaCents ?? 0) / 100,
        medicareAgePrimary: args.medicareAgePrimary ?? null,
      };
      const compared = runWorkYearsCompare(inputs, job, ages);
      return {
        ok: true,
        reason:
          job.salary > 0
            ? `Priced quitting at ${ages.join(", ")} — work years rolled forward, then each priced with the joint optimizer.`
            : "No salary is entered, so no work years were priced — every row is the plan as it stands.",
        provenance: apiProvenance(),
        effectiveInputs,
        rows: compared.map((row) => ({
          quitAge: row.quitAge,
          workYears: row.workYears,
          balancesAtQuit: {
            pretax: row.roll.balances.pretax,
            roth: row.roll.balances.roth,
            taxable: row.roll.balances.taxable,
            hsa: row.roll.balances.hsa,
          },
          ledger: {
            grossSalary: row.roll.totals.grossSalary,
            federal: row.roll.totals.federal,
            state: row.roll.totals.state,
            fica: row.roll.totals.fica,
            payrollTax: row.roll.totals.payrollTax,
            payrollSocialSecurity: row.roll.totals.payrollSocialSecurity,
            payrollMedicare: row.roll.totals.payrollMedicare,
            payrollAdditionalMedicare: row.roll.totals.payrollAdditionalMedicare,
            pretaxContributions: row.roll.totals.pretaxContributions,
            rothContributions: row.roll.totals.rothContributions,
            hsaContributions: row.roll.totals.hsaContributions,
            totalContributions: row.roll.totals.totalContributions,
            employeeContributions: row.roll.totals.employeeContributions,
            employerContributions: row.roll.totals.employerContributions,
            surplusBanked: row.roll.totals.surplusBanked,
            shortfall: row.roll.totals.shortfall,
            banked: row.roll.totals.banked,
          },
          winnerName: row.optimizer.winner.spec.name,
          winnerWindowLabel: row.optimizer.winner.spec.windowLabel,
          winnerClaimLabel: claimAgeLabel(row.optimizer.winner.claimAges),
          winnerNetCost: row.optimizer.winner.cost.netCost,
          winnerTax: row.optimizer.winner.cost.tax,
          winnerPenalty: row.optimizer.winner.cost.penalty,
          winnerIrmaa: row.optimizer.winner.cost.irmaa,
          winnerAcaCredit: row.optimizer.winner.cost.acaCredit,
          winnerEducationRefundable: row.optimizer.winner.cost.educationRefundable,
          winnerTerminal: row.optimizer.winner.cost.terminal,
          doNothingNetCost: row.optimizer.doNothing.cost.netCost,
          workTax: row.workTax,
          payrollTax: row.payrollTax,
          totalTax: row.totalTax,
          allInTax: row.allInTax,
          doNothingAllInTax:
            Math.round((row.optimizer.doNothing.cost.netCost + row.workTax) * 100) / 100,
          claim67AllInTax: row.claim67AllInTax,
          endingPretax: row.optimizer.winner.result.endingPretax,
          endingRoth: row.optimizer.winner.result.endingRoth,
          endingTaxable: row.optimizer.winner.result.endingTaxable,
          endingHsa: row.optimizer.winner.result.endingHsa,
          endingNominal: row.endingNominal,
          endingAfterTax: row.endingAfterTax,
          ssCollected: row.optimizer.winner.cost.ssCollected,
        })),
      };
    },
  }),

  // Gift stock compare (the Roth view's "Gift stock" tab):
  // compute-only — it prices the inputs it is given plus the
  // gift description (the plan-record-only gift fields, carried
  // on this request alone) and saves nothing. The plan is
  // priced twice with the joint optimizer by the gift model
  // (server/src/giftModel.ts): as saved — plus the
  // counterfactual sale gain in the sale year when a sale age
  // is set — and with the gifted shares removed from the
  // Taxable bucket at the gift year. The gift fields never
  // enter planInputsFromSaved, so no other run can see them.
  // Money in these outputs is DOLLARS (the tax engine's
  // units), like the optimizer outputs.
  runRothGiftCompare: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.strictObject({
      ...rothComputeFields,
      ...rothGiftFields,
      // Transient FAFSA-reportable assets (cents) — same
      // display-layer passthrough as runRothOptimizer; never
      // persisted, never part of rothInputFields.
      fafsaReportableAssetsCents: z.number().int().nullable().optional(),
      // Transient spend-from-cash sleeve size (cents) — the
      // snapshot Cash bucket portion of the taxable pool; never
      // persisted, never part of rothInputFields. Absent = the
      // server threads it from the snapshot when the taxable
      // balance follows the snapshot (see resolveArgsBalances).
      spendFromCashSleeveCents: z.number().int().nullable().optional(),
    }),
    response: z.object({
      ok: z.boolean(),
      reason: z.string(),
      provenance: provenanceOut,
      effectiveInputs: rothEffectiveInputsOut.nullable(),
      hasGift: z.boolean(),
      giftAge: z.number().nullable(),
      giftYear: z.number().nullable(),
      typedAmount: z.number(),
      effectiveAmount: z.number(),
      effectiveBasis: z.number(),
      capped: z.boolean(),
      taxableAtGiftYear: z.number(),
      salePriced: z.boolean(),
      saleAge: z.number().nullable(),
      saleYear: z.number().nullable(),
      baseline: z
        .object({
          winnerName: z.string(),
          claimLabel: z.string(),
          claimPrimaryAge: z.number().nullable(),
          netCost: z.number(),
          endingAfterTax: z.number(),
        })
        .nullable(),
      withGift: z
        .object({
          winnerName: z.string(),
          claimLabel: z.string(),
          claimPrimaryAge: z.number().nullable(),
          netCost: z.number(),
          endingAfterTax: z.number(),
        })
        .nullable(),
      child: z
        .object({
          kidAge: z.number().nullable(),
          valueAtSale: z.number(),
          gain: z.number(),
          kiddieGate: z.boolean(),
          kiddieThreshold: z.number(),
          parentsMarginalCgRate: z.number(),
          childTax: z.number().nullable(),
          netToChild: z.number(),
        })
        .nullable(),
      giftTax: z
        .object({
          exclusionPerDonor: z.number(),
          donors: z.number(),
          exclusionAvailable: z.number(),
          excess: z.number(),
          withinExclusion: z.boolean(),
        })
        .nullable(),
      fafsaApplies: z.boolean(),
    }),
    async handler(ctx, args) {
      const capturedYear = new Date().getFullYear();
      const empty = {
        hasGift: false,
        giftAge: null,
        giftYear: null,
        typedAmount: 0,
        effectiveAmount: 0,
        effectiveBasis: 0,
        capped: false,
        taxableAtGiftYear: 0,
        salePriced: false,
        saleAge: null,
        saleYear: null,
        baseline: null,
        withGift: null,
        child: null,
        giftTax: null,
        fafsaApplies: false,
      };
      const { resolved, effectiveInputs } = await computeEffectiveInputs(ctx, args, capturedYear);
      const inputs = planInputsFromSaved(resolved, capturedYear);
      if (!inputs) {
        return {
          ok: false,
          reason:
            "The gift comparison needs a birth year before it can price a plan — enter it above and run again.",
          provenance: apiProvenance(),
          effectiveInputs,
          ...empty,
        };
      }
      const ageNow = inputs.startYear - inputs.birthYearPrimary;
      if (inputs.endAgePrimary <= ageNow) {
        return {
          ok: false,
          reason:
            "The plan end age is not after the current age, so there is no lifetime to price — raise the end age above and run again.",
          provenance: apiProvenance(),
          effectiveInputs,
          ...empty,
        };
      }
      const amount = (args.giftAmountCents ?? 0) / 100;
      if (amount <= 0) {
        return {
          ok: true,
          reason: "No gift amount is entered yet.",
          provenance: apiProvenance(),
          effectiveInputs,
          ...empty,
        };
      }
      const giftParams = {
        giftAge: args.giftAge,
        amount,
        basis: (args.giftBasisCents ?? 0) / 100,
        kidBirthYear: args.giftKidBirthYear,
        kidStudent: args.giftKidStudent === true,
        kidOtherIncome: (args.giftKidOtherIncomeCents ?? 0) / 100,
        saleAge: args.giftSaleAge,
      };
      // Age guards (shared with the model and the client —
      // see giftAgeGuardMessage in giftModel.ts): an
      // out-of-window or inconsistent description returns
      // the plain message with NO priced ledgers.
      const guardError = giftValidationError(inputs, giftParams);
      if (guardError) {
        return { ok: false, reason: guardError, provenance: apiProvenance(), effectiveInputs, ...empty };
      }
      const cmp = computeGiftComparison(inputs, giftParams);
      return {
        ok: true,
        provenance: apiProvenance(),
        effectiveInputs,
        reason: cmp.salePriced
          ? `Priced the plan as saved (with the sale at age ${cmp.saleAge} priced in) and with the gift at age ${cmp.giftAge} — each a full joint optimizer run.`
          : `Priced the plan as saved and with the gift at age ${cmp.giftAge} — each a full joint optimizer run. No sale year is set, so no sale is priced on either side.`,
        hasGift: cmp.hasGift,
        giftAge: cmp.giftAge,
        giftYear: cmp.giftYear,
        typedAmount: cmp.typedAmount,
        effectiveAmount: cmp.effectiveAmount,
        effectiveBasis: cmp.effectiveBasis,
        capped: cmp.capped,
        taxableAtGiftYear: cmp.taxableAtGiftYear,
        salePriced: cmp.salePriced,
        saleAge: cmp.saleAge,
        saleYear: cmp.saleYear,
        baseline: cmp.baseline,
        withGift: cmp.withGift,
        child: cmp.child,
        giftTax: cmp.giftTax,
        fafsaApplies: cmp.fafsaApplies,
      };
    },
  }),

  // Single-year pricing (engine access, part 1): prices ONE
  // standalone year with EXACTLY the Playground's dial set and
  // semantics, through pricePlaygroundYear — the same function
  // the Playground tab prices with, shared via rothOptimizer.ts;
  // the math is not forked. The request schema rejects negative
  // amounts with a validation error (otherOrdinary excepted —
  // it keeps its sign by design, since a loss is legitimate),
  // so the handler passes the validated dials through directly
  // and normalizes nothing silently; the client's one dial
  // construction clamps at typing time, so the tab never emits
  // a dial set this action refuses. The only transformations
  // left are the filing-status spouse coercions (a non-MFJ
  // return's spouse fields are inert), which are status
  // semantics, not clamps. Compute-only: nothing is read from
  // or written to the database. The response is the full
  // readout PLUS the canonical paste payload for the
  // Playground's loader, built from the priced inputs, so
  // pasting it back reproduces this exact pricing in the tab.
  runPlaygroundYear: defineAction({
    request: playgroundYearIn,
    response: z.object({
      provenance: provenanceOut,
      // The law row the year actually priced under: a taxYear
      // with no published row prices under the newest published
      // row (the lawForYear fallback), and this names that row.
      lawYearUsed: z.number().int(),
      result: playgroundYearOut,
      pastePayload: playgroundPasteOut,
      pasteText: z.string(),
    }),
    async handler(_ctx, args) {
      const inputs = playgroundInputsFromArgs(args);
      const result = pricePlaygroundYear(inputs);
      const pastePayload = playgroundPastePayload(inputs);
      return {
        provenance: apiProvenance(),
        lawYearUsed: lawForYear(args.taxYear).year,
        result,
        pastePayload,
        pasteText: JSON.stringify(pastePayload),
      };
    },
  }),

  // December projection console: the saved December inputs
  // (one settings blob, form state in the Playground blob's
  // style — see decemberCore). get returns the leniently parsed
  // state, whether a blob was ever stored, and the blob's
  // write revision; save is a compare-and-swap on that
  // revision (the Roth records' pattern): the caller passes
  // the revision its copy was read at (baseRevision), and a
  // save whose base no longer matches is refused with the
  // stored state instead of overwriting it. Neither prices
  // anything.
  getDecemberProjection: defineAction({
    request: z.object({}),
    response: getDecemberProjectionResponse,
    async handler(ctx): Promise<z.infer<typeof getDecemberProjectionResponse>> {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.settings);
      const raw = rows.find((r) => r.key === DECEMBER_STATE_KEY)?.value;
      return {
        state: parseDecemberState(raw, new Date().getUTCFullYear()),
        hasStored: raw !== undefined,
        revision: parseDecemberRevision(raw),
        storedUnreadable: isDecemberStateUnparseable(raw),
      };
    },
  }),

  saveDecemberProjection: defineAction({
    request: z.object({
      state: decemberState,
      baseRevision: z.number().int().min(0),
    }),
    response: saveDecemberProjectionResponse,
    async handler(ctx, args): Promise<z.infer<typeof saveDecemberProjectionResponse>> {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.settings);
      const current = rows.find((r) => r.key === DECEMBER_STATE_KEY);
      const storedRevision = parseDecemberRevision(current?.value);
      // Result-honesty (contract v67, F09): a save whose base was
      // read from an UNPARSEABLE stored record is refused as a
      // conflict — the damaged bytes are left intact, never
      // treated as a revision-0 record the save may build on.
      if (isDecemberStateUnparseable(current?.value)) {
        return {
          ok: false as const,
          conflict: true as const,
          revision: storedRevision,
          state: parseDecemberState(current?.value, new Date().getUTCFullYear()),
          hasStored: true,
          storedUnreadable: true,
        };
      }
      const decision = decideDecemberWrite(storedRevision, args.baseRevision);
      if (!decision.allowed) {
        return {
          ok: false as const,
          conflict: true as const,
          revision: storedRevision,
          state: parseDecemberState(current?.value, new Date().getUTCFullYear()),
          hasStored: current !== undefined,
          storedUnreadable: false,
        };
      }
      const blob = serializeDecemberState(args.state, decision.nextRevision);
      if (current === undefined) {
        // First write: claim the key insert-only (the Roth
        // insert-if-absent pattern, on the December key) —
        // the guarded insert is the atomic compare.
        const claimedRows = await db
          .insert(schema.settings)
          .values({ key: DECEMBER_STATE_KEY, value: blob })
          .onConflictDoNothing()
          .returning({ key: schema.settings.key });
        const claimed = claimedRows.length === 1;
        if (!claimed) {
          const after = await db.select().from(schema.settings);
          const afterRaw = after.find((r) => r.key === DECEMBER_STATE_KEY)?.value;
          return {
            ok: false as const,
            conflict: true as const,
            revision: parseDecemberRevision(afterRaw),
            state: parseDecemberState(afterRaw, new Date().getUTCFullYear()),
            hasStored: afterRaw !== undefined,
            storedUnreadable: isDecemberStateUnparseable(afterRaw),
          };
        }
      } else {
        // The guarded commit takes the DB handle (db), like
        // every other commitSettingsValueGuarded call site —
        // passing ctx here was the December save bug (found
        // 2026-10-26): ctx has no .update, so a correct-
        // revision save on an existing blob always threw
        // "db.update is not a function" while stale saves
        // (refused before this line) and first writes (the
        // insert path above) worked.
        const committed = await commitSettingsValueGuarded(
          db,
          DECEMBER_STATE_KEY,
          current.value,
          blob,
        );
        if (!committed) {
          const after = await db.select().from(schema.settings);
          const afterRaw = after.find((r) => r.key === DECEMBER_STATE_KEY)?.value;
          return {
            ok: false as const,
            conflict: true as const,
            revision: parseDecemberRevision(afterRaw),
            state: parseDecemberState(afterRaw, new Date().getUTCFullYear()),
            hasStored: afterRaw !== undefined,
            storedUnreadable: isDecemberStateUnparseable(afterRaw),
          };
        }
      }
      ctx.invalidateQueries();
      return { ok: true as const, revision: decision.nextRevision };
    },
  }),

  // December projection pricing (compute-only): assembles the
  // year's income from the console inputs (actuals + range case
  // + strays) and prices it through the shared single-year
  // engine — see decemberCore. Saves nothing.
  runDecemberProjection: defineAction({
    request: z.object({ state: decemberState }),
    response: z.object({
      provenance: provenanceOut,
      result: decemberProjectionOut,
    }),
    async handler(_ctx, args) {
      return {
        provenance: apiProvenance(),
        result: computeDecemberProjection(args.state),
      };
    },
  }),

  // Plan-year detail (engine access, part 2): runs the planner
  // (the payload's own ceilings strategy, as the Plan tab runs
  // it) and returns the target year's complete row PLUS the
  // with/without-conversion two-pricing for that year — the
  // same plan re-priced with that year's conversion forced to
  // $0 (pricePlanYearDetail in rothOptimizer.ts) — so a
  // watch-out decomposition is engine output, not a derivation.
  // The target is a calendar year (targetYear) or the primary's
  // age that year (targetAge); targetYear wins when both are
  // given. Balances resolve server-side like the other
  // plan-level actions. Compute-only: saves nothing.
  runPlanYearDetail: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.strictObject({
      ...rothComputeFields,
      targetYear: z.number().int().min(1900).max(2200).nullable().optional(),
      targetAge: z.number().int().min(0).max(130).nullable().optional(),
      fafsaReportableAssetsCents: z.number().int().nullable().optional(),
      // Transient spend-from-cash sleeve size (cents) — the
      // snapshot Cash bucket portion of the taxable pool; never
      // persisted, never part of rothInputFields. Absent = the
      // server threads it from the snapshot when the taxable
      // balance follows the snapshot (see resolveArgsBalances).
      spendFromCashSleeveCents: z.number().int().nullable().optional(),
    }),
    response: z.object({
      ok: z.boolean(),
      reason: z.string(),
      provenance: provenanceOut,
      effectiveInputs: rothEffectiveInputsOut.nullable(),
      targetYear: z.number().nullable(),
      targetAge: z.number().nullable(),
      row: planYearRowOut.nullable(),
      withoutRow: planYearRowOut.nullable(),
      deltaFederal: z.number(),
      deltaState: z.number(),
      deltaIrmaa: z.number(),
      deltaAcaCredit: z.number(),
      conversionCost: z.number(),
      effectiveRatePct: z.number().nullable(),
    }),
    async handler(ctx, args) {
      const capturedYear = new Date().getFullYear();
      const empty = {
        targetYear: null,
        targetAge: null,
        row: null,
        withoutRow: null,
        deltaFederal: 0,
        deltaState: 0,
        deltaIrmaa: 0,
        deltaAcaCredit: 0,
        conversionCost: 0,
        effectiveRatePct: null,
      };
      const { resolved, effectiveInputs } = await computeEffectiveInputs(ctx, args, capturedYear);
      const inputs = planInputsFromSaved(resolved, capturedYear);
      if (!inputs) {
        return {
          ok: false,
          reason:
            "The plan-year detail needs a birth year before it can price a plan — enter it above and run again.",
          provenance: apiProvenance(),
          effectiveInputs,
          ...empty,
        };
      }
      const targetYear =
        args.targetYear ?? (args.targetAge != null ? inputs.birthYearPrimary + args.targetAge : null);
      if (targetYear == null) {
        return {
          ok: false,
          reason: "Name the year to price — a calendar year or an age — and run again.",
          provenance: apiProvenance(),
          effectiveInputs,
          ...empty,
        };
      }
      const detail = pricePlanYearDetail(
        inputs,
        strategyFromSavedArgs(resolved),
        targetYear,
      );
      if (!detail) {
        return {
          ok: false,
          reason: `The plan does not price ${targetYear} — it runs from ${inputs.startYear} to age ${inputs.endAgePrimary}.`,
          provenance: apiProvenance(),
          effectiveInputs,
          ...empty,
          targetYear,
          targetAge: targetYear - inputs.birthYearPrimary,
        };
      }
      return {
        ok: true,
        reason: `Priced ${targetYear} (age ${detail.with.agePrimary}) with the plan's fill settings, and again with that year's conversion forced to $0.`,
        provenance: apiProvenance(),
        effectiveInputs,
        targetYear,
        targetAge: detail.with.agePrimary,
        row: toPlanYearRow(detail.with),
        withoutRow: toPlanYearRow(detail.without),
        deltaFederal: detail.deltaFederal,
        deltaState: detail.deltaState,
        deltaIrmaa: detail.deltaIrmaa,
        deltaAcaCredit: detail.deltaAcaCredit,
        conversionCost: detail.conversionCost,
        effectiveRatePct: detail.effectiveRatePct,
      };
    },
  }),

  // Year funding (YEAR FUNDING build): price the plan exactly
  // as given — its own ceilings strategy, as the Plan tab runs
  // it — in ONE simulation and return every priced year's
  // funding ledger (buildRothFunding in rothOptimizer.ts, from
  // the engine's settlement internals). Following the
  // plan-year-detail payload conventions: balances resolve
  // server-side, unknown request keys are rejected, and the
  // response carries provenance + the effective inputs priced.
  // Compute-only: saves nothing.
  runRothFunding: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.strictObject({
      ...rothComputeFields,
      // Transient spend-from-cash sleeve size (cents) — same
      // passthrough as the other compute actions; absent = the
      // server threads it from the snapshot when the taxable
      // balance follows the snapshot.
      spendFromCashSleeveCents: z.number().int().nullable().optional(),
    }),
    response: z.object({
      ok: z.boolean(),
      reason: z.string(),
      provenance: provenanceOut,
      effectiveInputs: rothEffectiveInputsOut.nullable(),
      years: z.array(fundingRowOut),
    }),
    async handler(ctx, args) {
      const capturedYear = new Date().getFullYear();
      const { resolved, effectiveInputs } = await computeEffectiveInputs(ctx, args, capturedYear);
      const inputs = planInputsFromSaved(resolved, capturedYear);
      if (!inputs) {
        return {
          ok: false,
          reason:
            "Year funding needs a birth year before it can price a plan — enter it above and run again.",
          provenance: apiProvenance(),
          effectiveInputs,
          years: [],
        };
      }
      const years = buildRothFunding(inputs, strategyFromSavedArgs(resolved));
      return {
        ok: true,
        reason: `Priced ${years.length} year${years.length === 1 ? "" : "s"} of the plan as saved and funded each year's spending and tax bill from its own settlement.`,
        provenance: apiProvenance(),
        effectiveInputs,
        years,
      };
    },
  }),

  // Read-only Year summary: for one chosen year, the spending
  // figures (reusing the exact per-month math of getYearView) and
  // the Net Worth figures (reusing the exact per-snapshot totals of
  // getNetWorth, including the "Include house & mortgage" setting).
  // It never writes anything. availableYears is the union of every
  // year present in the data (NW snapshot years plus spending years).
  getYearSummary: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.object({ year: z.number().int().min(1900).max(2200) }),
    response: z.object({
      year: z.number(),
      availableYears: z.array(z.number()),
      includeProperty: z.boolean(),
      spending: z.object({
        hasData: z.boolean(),
        months: z.array(
          z.object({
            month: z.string(),
            monthNum: z.number(),
            trueCostCents: z.number(),
            cashOutCents: z.number(),
          }),
        ),
        totalTrueCostCents: z.number(),
        totalCashOutCents: z.number(),
        averageTrueCostCents: z.number(),
        monthsWithData: z.number(),
        highestMonth: z
          .object({
            month: z.string(),
            monthNum: z.number(),
            trueCostCents: z.number(),
            oneOffsCents: z.number(),
          })
          .nullable(),
        lowestMonth: z
          .object({
            month: z.string(),
            monthNum: z.number(),
            trueCostCents: z.number(),
            oneOffsCents: z.number(),
          })
          .nullable(),
        totalOneOffsCents: z.number(),
        topCategories: z.array(
          z.object({ label: z.string(), totalCents: z.number() }),
        ),
        keepLightsOnFloorCents: z.number(),
        lastMonthInProgress: z.boolean(),
        excludedPayments: z.array(
          z.object({
            month: z.string(),
            monthNum: z.number(),
            totalCents: z.number(),
            count: z.number(),
          }),
        ),
      }),
      trend: z.array(
        z.object({
          year: z.number(),
          monthsWithData: z.number(),
          trueCostCents: z.number().nullable(),
          nwChangeCents: z.number().nullable(),
          nwEndingCents: z.number().nullable(),
        }),
      ),
      netWorth: z.object({
        hasData: z.boolean(),
        snapshotCount: z.number(),
        firstDate: z.string().nullable(),
        firstTotalCents: z.number().nullable(),
        lastDate: z.string().nullable(),
        lastTotalCents: z.number().nullable(),
        priorYearLastDate: z.string().nullable(),
        priorYearLastTotalCents: z.number().nullable(),
        changeCents: z.number().nullable(),
        changePctFrac: z.number().nullable(),
        movers: z.array(
          z.object({
            accountId: z.number(),
            accountName: z.string(),
            startCents: z.number().nullable(),
            endCents: z.number().nullable(),
            changeCents: z.number(),
          }),
        ),
      }),
    }),
    async handler(ctx, args) {
      const year = args.year;
      const { txns, yearly, yearlyVersions, summaries, bills, billVersions, oneOffs, cashOutItems } =
        await loadAll(ctx);
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      const { accounts, snapshots: nwSnaps, balances } =
        await loadNetWorthDecrypted(ctx, db, key);
      const settingRows = await db.select().from(schema.settings);
      const includeProperty =
        settingRows.find((r) => r.key === NW_INCLUDE_PROPERTY_KEY)?.value === "1";

      // ---- available years (union of all data) ----
      const yearSet = new Set<number>();
      for (const s of nwSnaps) yearSet.add(Number(s.date.slice(0, 4)));
      for (const t of txns) yearSet.add(Number(t.date.slice(0, 4)));
      for (const s of summaries) yearSet.add(Number(s.month.slice(0, 4)));
      for (const it of cashOutItems) yearSet.add(Number(it.month.slice(0, 4)));
      for (const o of oneOffs) yearSet.add(Number(o.month.slice(0, 4)));
      if (yearSet.size === 0) yearSet.add(year);
      const availableYears = [...yearSet].sort((a, b) => a - b);

      // ---- spending: same helpers as getYearView ----
      const now = new Date();
      const currentYear = now.getFullYear();
      const currentMonthStr = `${currentYear}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const isCurrentYear = year === currentYear;
      const windowStart = `${year}-01`;
      const windowEnd = isCurrentYear ? currentMonthStr : `${year}-12`;
      // The per-month computation (accrual, the cash-out resolution,
      // month selection) lives in the shared spending core
      // (server/src/spendingCore.ts) — the same code the dashboard
      // and the accuracy fixtures run.
      const core = createSpendingCore({
        txns,
        yearly,
        yearlyVersions,
        summaries,
        cashOutItems,
        bills,
        billVersions,
        oneOffs,
      });
      const eff = core.eff;
      const monthHasData = core.monthHasData;
      const spendingMonths: { month: string; monthNum: number; trueCostCents: number; cashOutCents: number }[] = [];
      let totalTrueCostCents = 0;
      let totalCashOutCents = 0;
      for (let n = 1; n <= 12; n++) {
        const m = `${year}-${String(n).padStart(2, "0")}`;
        const inWindow = m >= windowStart && m <= windowEnd;
        if (!inWindow) continue;
        if (!monthHasData(m)) continue;
        const e = eff(m);
        spendingMonths.push({ month: m, monthNum: n, trueCostCents: e.smoothed, cashOutCents: e.cashOut });
        totalTrueCostCents += e.smoothed;
        totalCashOutCents += e.cashOut;
      }
      const monthsWithData = spendingMonths.length;
      const averageTrueCostCents =
        monthsWithData > 0 ? Math.round(totalTrueCostCents / monthsWithData) : 0;
      // Payments already recorded for months after the last month
      // these totals include (for the current year the window ends
      // at the current month) are NOT in the totals above; the view
      // names them in a footnote rather than dropping them silently.
      const lastIncludedMonth =
        spendingMonths[spendingMonths.length - 1]?.month ?? null;
      const excludedPayments =
        lastIncludedMonth != null
          ? core.recordedPaymentsAfter(year, lastIncludedMonth)
          : [];

      // ---- Year in spending aggregates (presentation only; every
      // figure below is composed from the same core primitives the
      // dashboard and Slice & dice run — no second implementation) ----
      const totalOneOffsCents = spendingMonths.reduce(
        (s, m) => s + core.oneOffTotalForMonth(m.month),
        0,
      );
      const monthWithOneOffs = (m: (typeof spendingMonths)[number]) => ({
        month: m.month,
        monthNum: m.monthNum,
        trueCostCents: m.trueCostCents,
        oneOffsCents: core.oneOffTotalForMonth(m.month),
      });
      let highestMonth: ReturnType<typeof monthWithOneOffs> | null = null;
      let lowestMonth: ReturnType<typeof monthWithOneOffs> | null = null;
      for (const m of spendingMonths) {
        if (highestMonth == null || m.trueCostCents > highestMonth.trueCostCents) {
          highestMonth = monthWithOneOffs(m);
        }
        if (lowestMonth == null || m.trueCostCents < lowestMonth.trueCostCents) {
          lowestMonth = monthWithOneOffs(m);
        }
      }
      // The lights-on floor is priced for the REQUESTED year
      // (finding F14): the current year uses the current month
      // (unchanged from before); any other year uses its own last
      // included month — or its December when it has none — so a
      // past year's floor reflects that year's bill versions, not
      // today's. The choice is yearSummaryFloorMonth in
      // spendingCore; the floor math itself is unchanged.
      const keepLightsOnFloorCents = core.keepLightsOnForMonth(
        yearSummaryFloorMonth({
          year,
          currentYear,
          currentMonth: currentMonthStr,
          lastIncludedMonth,
        }),
      );
      const lastMonthInProgress =
        isCurrentYear && lastIncludedMonth != null && lastIncludedMonth === currentMonthStr;
      // Top categories: the Slice & dice category pivot over exactly
      // the year's included months — monthly bills at the version in
      // effect for the month, smoothed bills at their monthly accrual
      // (core.billMonthlyAccrual, the same accrual yearlyOutFor
      // reports), grouped by bill category (empty → "Uncategorized"),
      // plus the "Other spending" residual row (True cost − the
      // pivot's own total) so the rows sum exactly to True cost.
      // The residual competes for a top-5 place like any other row.
      const topCategories: { label: string; totalCents: number }[] = (() => {
        if (spendingMonths.length === 0) return [];
        const groupMap = new Map<string, number>();
        const addTo = (label: string, cents: number) =>
          groupMap.set(label, (groupMap.get(label) ?? 0) + cents);
        for (const b of bills) {
          const label = b.category || "Uncategorized";
          for (const m of spendingMonths) {
            addTo(
              label,
              versionInEffect(core.versionsByBill.get(b.id) ?? [], m.month)
                ?.amountCents ?? 0,
            );
          }
        }
        for (const y of yearly) {
          const label = y.category || "Uncategorized";
          for (const m of spendingMonths) {
            addTo(label, core.billMonthlyAccrual(y, m.month));
          }
        }
        const rows = [...groupMap.entries()].map(([label, totalCents]) => ({
          label,
          totalCents,
        }));
        const pivotTotal = rows.reduce((s, r) => s + r.totalCents, 0);
        rows.push({
          label: "Other spending",
          totalCents: totalTrueCostCents - pivotTotal,
        });
        rows.sort(
          (a, b) => b.totalCents - a.totalCents || a.label.localeCompare(b.label),
        );
        return rows.slice(0, 5);
      })();

      // ---- net worth: same per-snapshot totals as getNetWorth ----
      const classById = classByIdOf(accounts);
      const balancesBySnapshot = new Map<number, typeof balances>();
      for (const b of balances) {
        const arr = balancesBySnapshot.get(b.snapshotId) ?? [];
        arr.push(b);
        balancesBySnapshot.set(b.snapshotId, arr);
      }
      const totalForSnapshot = (snapId: number): number =>
        snapshotTotals(balancesBySnapshot.get(snapId) ?? [], classById, includeProperty)
          .totalCents;
      const yearPrefix = `${year}-`;
      const yearSnaps = nwSnaps.filter((s) => s.date.startsWith(yearPrefix));
      const firstSnap = yearSnaps[0] ?? null;
      const lastSnap = yearSnaps[yearSnaps.length - 1] ?? null;
      // The last snapshot before this year starts — the anchor the
      // Net Worth view's Year to date is measured from. The change
      // below is instead measured from this year's FIRST snapshot,
      // so the view discloses both anchors and the movement between
      // this prior snapshot and the year's first one.
      const priorSnaps = nwSnaps.filter((s) => s.date < `${year}-01-01`);
      const priorSnap = priorSnaps[priorSnaps.length - 1] ?? null;
      const priorYearLastDate = priorSnap?.date ?? null;
      const priorYearLastTotalCents =
        priorSnap != null ? totalForSnapshot(priorSnap.id) : null;
      let netWorthOut: {
        hasData: boolean;
        snapshotCount: number;
        firstDate: string | null;
        firstTotalCents: number | null;
        lastDate: string | null;
        lastTotalCents: number | null;
        priorYearLastDate: string | null;
        priorYearLastTotalCents: number | null;
        changeCents: number | null;
        changePctFrac: number | null;
        movers: { accountId: number; accountName: string; startCents: number | null; endCents: number | null; changeCents: number }[];
      };
      if (!firstSnap || !lastSnap) {
        netWorthOut = {
          hasData: false,
          snapshotCount: 0,
          firstDate: null,
          firstTotalCents: null,
          lastDate: null,
          lastTotalCents: null,
          priorYearLastDate,
          priorYearLastTotalCents,
          changeCents: null,
          changePctFrac: null,
          movers: [],
        };
      } else {
        const firstTotal = totalForSnapshot(firstSnap.id);
        const lastTotal = totalForSnapshot(lastSnap.id);
        const change = lastTotal - firstTotal;
        const pct = firstTotal !== 0 ? change / firstTotal : null;
        // The movers math lives in the shared NW core
        // (server/src/nwCore.ts) — the same code the accuracy
        // fixtures run.
        const movers = yearMovers(
          accounts,
          balancesBySnapshot.get(firstSnap.id) ?? [],
          balancesBySnapshot.get(lastSnap.id) ?? [],
          classById,
          includeProperty,
          firstSnap.id === lastSnap.id,
        );
        netWorthOut = {
          hasData: true,
          snapshotCount: yearSnaps.length,
          firstDate: firstSnap.date,
          firstTotalCents: firstTotal,
          lastDate: lastSnap.date,
          lastTotalCents: lastTotal,
          priorYearLastDate,
          priorYearLastTotalCents,
          changeCents: change,
          changePctFrac: pct,
          movers,
        };
      }

      // ---- Multi-year trend: one row per available year, on the
      // same window rule + monthHasData + eff for spending and the
      // same first→last snapshot anchors (with the same
      // includeProperty setting) as the blocks above. A year with
      // fewer than two snapshots has no change; a year with no
      // snapshots has no ending figure either. ----
      const trend = availableYears.map((trendYear) => {
        const trendIsCurrent = trendYear === currentYear;
        const trendStart = `${trendYear}-01`;
        const trendEnd = trendIsCurrent ? currentMonthStr : `${trendYear}-12`;
        let trendMonths = 0;
        let trendTrueCost = 0;
        for (let n = 1; n <= 12; n++) {
          const m = `${trendYear}-${String(n).padStart(2, "0")}`;
          if (m < trendStart || m > trendEnd) continue;
          if (!monthHasData(m)) continue;
          trendMonths += 1;
          trendTrueCost += eff(m).smoothed;
        }
        const trendSnaps = nwSnaps.filter((s) =>
          s.date.startsWith(`${trendYear}-`),
        );
        const trendFirst = trendSnaps[0] ?? null;
        const trendLast = trendSnaps[trendSnaps.length - 1] ?? null;
        return {
          year: trendYear,
          monthsWithData: trendMonths,
          trueCostCents: trendMonths > 0 ? trendTrueCost : null,
          nwChangeCents:
            trendFirst != null && trendLast != null && trendFirst.id !== trendLast.id
              ? totalForSnapshot(trendLast.id) - totalForSnapshot(trendFirst.id)
              : null,
          nwEndingCents: trendLast != null ? totalForSnapshot(trendLast.id) : null,
        };
      });

      return {
        year,
        availableYears,
        includeProperty,
        spending: {
          hasData: monthsWithData > 0,
          months: spendingMonths,
          totalTrueCostCents,
          totalCashOutCents,
          averageTrueCostCents,
          monthsWithData,
          highestMonth,
          lowestMonth,
          totalOneOffsCents,
          topCategories,
          keepLightsOnFloorCents,
          lastMonthInProgress,
          excludedPayments,
        },
        trend,
        netWorth: netWorthOut,
      };
    },
  }),

  // Set the Net Worth Accounts section's collapsed UI state.
  // Display only — persisted server-side in settings so it survives
  // reloads, new sessions, and devices. Absent = collapsed (the
  // default); the client stores an explicit value on first toggle.
  setNwAccountsCollapsed: defineAction({
    request: z.object({
      collapsed: z.boolean(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db
        .insert(schema.settings)
        .values({
          key: "nw_accounts_collapsed",
          value: args.collapsed ? "1" : "0",
        })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value: args.collapsed ? "1" : "0" },
        });
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // Set the Net Worth History section's collapsed UI state. Display
  // only, persisted like the Accounts flag, independent of it.
  // Absent = collapsed (the default).
  setNwHistoryCollapsed: defineAction({
    request: z.object({
      collapsed: z.boolean(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db
        .insert(schema.settings)
        .values({
          key: "nw_history_collapsed",
          value: args.collapsed ? "1" : "0",
        })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value: args.collapsed ? "1" : "0" },
        });
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // Set the Net Worth Growth chart's "Change since" baseline
  // snapshot date. Stored in settings under "nw_growth_since" as
  // a plain YYYY-MM-DD string; null clears it (stored empty,
  // which getNetWorth reads back as null), returning the growth
  // baseline to the first snapshot. Display only.
  setNwGrowthSince: defineAction({
    request: z.object({
      date: z.string().regex(dateRe).nullable(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db
        .insert(schema.settings)
        .values({
          key: "nw_growth_since",
          value: args.date ?? "",
        })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value: args.date ?? "" },
        });
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  addNwSnapshot: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: nwSnapshotInput,
    response: nwMutationOut,
    async handler(ctx, args): Promise<z.infer<typeof nwMutationOut>> {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      if (isFutureSnapshotDate(args.date, todayDateString())) {
        return {
          ok: false,
          reason: "Snapshot date can't be in the future",
          id: null,
        };
      }
      const [dupe] = await db
        .select()
        .from(schema.nwSnapshots)
        .where(eq(schema.nwSnapshots.date, args.date));
      if (dupe) {
        return {
          ok: false,
          reason: `A snapshot already exists for ${args.date} — edit that snapshot instead.`,
          id: dupe.id,
        };
      }
      /* ---- FULL preflight — before ANY write (cluster C) ----
         Every balance entry's accountId must reference an existing
         account, no accountId may appear twice in the payload, and
         no bucket may appear twice within one entry's splits. Any
         failure returns here with zero writes. */
      const { accounts } = await loadNetWorthDecrypted(ctx, db, key);
      const classById = classByIdOf(accounts);
      const validation = validateNwSnapshotPayload(args.balances, accounts);
      if (!validation.ok) {
        return { ok: false, reason: validation.reason, id: null };
      }
      // Reserved-prefix check on the note (cluster E): the trimmed
      // note is the exact value encryptNullable would store, so a
      // note carrying the reserved prefix is refused here, in the
      // preflight, with zero writes.
      if (hasReservedEncPrefix(args.note?.trim() ? args.note.trim() : null)) {
        return { ok: false, reason: RESERVED_ENC_PREFIX_MESSAGE, id: null };
      }
      /* ---- Build every row value BEFORE the write ----
         All fallible work (encryption included) happens here, so
         nothing after this point can fail partway for a payload
         reason. Entries that resolve to null (unrecorded) produce
         no row, exactly as before. */
      const encNote = await encryptNullable(
        key,
        args.note?.trim() ? args.note.trim() : null,
      );
      const rows: ({ accountId: number } & NwEncryptedRowValues)[] = [];
      for (const b of args.balances) {
        const cls = classById.get(b.accountId);
        const values = await nwBalanceRowValues(
          key,
          b,
          // Property and custodial balances are stored whole.
          cls != null && (isPropertyKind(cls.kind) || cls.custodial),
        );
        if (!values) continue;
        rows.push({ accountId: b.accountId, ...values });
      }
      /* ---- ONE atomic batch: header + balances, all or nothing ----
         The new snapshot's id is pre-derived at the statement level
         as max(existing snapshot id) + 1 (1 when the table is
         empty) and carried explicitly by the header insert, so the
         balance inserts in the SAME batch can reference it — no
         second commit and no follow-up fix-up write. The derived id
         cannot collide with an existing row (it exceeds every
         existing id); if it somehow did, the batch's primary-key
         failure would roll the whole batch back atomically rather
         than land partially. */
      const [maxRow] = await db
        .select({ maxId: sql<number | null>`max(${schema.nwSnapshots.id})` })
        .from(schema.nwSnapshots);
      const newSnapshotId = (maxRow?.maxId ?? 0) + 1;
      const plan = buildNwSnapshotWritePlan({
        mode: "add",
        snapshotId: newSnapshotId,
        date: args.date,
        note: encNote,
        rows,
      });
      type BatchItem = Parameters<typeof db.batch>[0][number];
      const statements: BatchItem[] = plan.map((stmt): BatchItem => {
        switch (stmt.op) {
          case "insertSnapshot":
            return db.insert(schema.nwSnapshots).values({
              id: stmt.snapshotId,
              date: stmt.date,
              note: stmt.note,
            });
          case "insertBalance": {
            const { accountId, ...values } = stmt.row;
            return db.insert(schema.nwBalances).values({
              snapshotId: stmt.snapshotId,
              accountId,
              ...values,
            });
          }
          default:
            throw new Error(`Unexpected add-plan statement: ${stmt.op}`);
        }
      });
      await db.batch(statements as [BatchItem, ...BatchItem[]]);
      ctx.invalidateQueries();
      return { ok: true, reason: "Snapshot added.", id: newSnapshotId };
    },
  }),

  updateNwSnapshot: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    // Contract v65 (CAS sweep, F11): `baseRevision` is the
    // snapshot revision the editor loaded (from getNetWorth). When
    // supplied, the whole-snapshot replacement is refused when the
    // stored revision has moved — whether the move came from
    // another updateNwSnapshot or from an updateNwBalance, both of
    // which bump the same counter. Omitting it keeps the legacy
    // unchecked behaviour (named in DATA-PLAN).
    request: nwSnapshotInput.extend({
      id: z.number().int().positive(),
      baseRevision: z.number().int().nonnegative().optional(),
    }),
    response: nwMutationOut,
    async handler(ctx, args): Promise<z.infer<typeof nwMutationOut>> {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      const [target] = await db
        .select()
        .from(schema.nwSnapshots)
        .where(eq(schema.nwSnapshots.id, args.id));
      if (!target) return { ok: false, reason: "That snapshot was not found.", id: null };
      const revisionDecision = decideCasRevision(
        target.revision ?? 0,
        args.baseRevision,
      );
      if (!revisionDecision.allowed) {
        return {
          ok: false,
          conflict: true,
          revision: target.revision ?? 0,
          reason: casConflictReason("snapshot"),
          id: null,
        };
      }
      const nextRevision = revisionDecision.nextRevision;
      if (isFutureSnapshotDate(args.date, todayDateString())) {
        return {
          ok: false,
          reason: "Snapshot date can't be in the future",
          id: null,
        };
      }
      const [dupe] = await db
        .select()
        .from(schema.nwSnapshots)
        .where(eq(schema.nwSnapshots.date, args.date));
      if (dupe && dupe.id !== args.id) {
        return {
          ok: false,
          reason: `Another snapshot already exists for ${args.date} — pick a different date or edit that snapshot.`,
          id: dupe.id,
        };
      }
      /* ---- FULL preflight — before ANY write (cluster C) ----
         Runs before the header update AND before the balance
         delete: every balance entry's accountId must reference an
         existing account, no accountId may appear twice in the
         payload, and no bucket may appear twice within one entry's
         splits. Any failure returns here with zero writes — the
         snapshot keeps its prior date, note, and balances. */
      const { accounts } = await loadNetWorthDecrypted(ctx, db, key);
      const classById = classByIdOf(accounts);
      const validation = validateNwSnapshotPayload(args.balances, accounts);
      if (!validation.ok) {
        return { ok: false, reason: validation.reason, id: null };
      }
      // Reserved-prefix check on the note (cluster E): the trimmed
      // note is the exact value encryptNullable would store, so a
      // note carrying the reserved prefix is refused here, in the
      // preflight, with zero writes.
      if (hasReservedEncPrefix(args.note?.trim() ? args.note.trim() : null)) {
        return { ok: false, reason: RESERVED_ENC_PREFIX_MESSAGE, id: null };
      }
      /* ---- Build every row value BEFORE the write ---- */
      const encNote = await encryptNullable(
        key,
        args.note?.trim() ? args.note.trim() : null,
      );
      const rows: ({ accountId: number } & NwEncryptedRowValues)[] = [];
      for (const b of args.balances) {
        const cls = classById.get(b.accountId);
        const values = await nwBalanceRowValues(
          key,
          b,
          // Property and custodial balances are stored whole.
          cls != null && (isPropertyKind(cls.kind) || cls.custodial),
        );
        if (!values) continue;
        rows.push({ accountId: b.accountId, ...values });
      }
      /* ---- ONE atomic batch: header update, balance delete, and
         one insert per stored balance row land together or not at
         all — a failure mid-write can no longer leave the snapshot
         emptied or partial. */
      const plan = buildNwSnapshotWritePlan({
        mode: "update",
        snapshotId: args.id,
        date: args.date,
        note: encNote,
        rows,
      });
      type BatchItem = Parameters<typeof db.batch>[0][number];
      const statements: BatchItem[] = plan.map((stmt): BatchItem => {
        switch (stmt.op) {
          case "updateSnapshot":
            return db
              .update(schema.nwSnapshots)
              .set({ date: stmt.date, note: stmt.note, revision: nextRevision })
              .where(eq(schema.nwSnapshots.id, stmt.snapshotId));
          case "deleteBalances":
            return db
              .delete(schema.nwBalances)
              .where(eq(schema.nwBalances.snapshotId, stmt.snapshotId));
          case "insertBalance": {
            const { accountId, ...values } = stmt.row;
            return db.insert(schema.nwBalances).values({
              snapshotId: stmt.snapshotId,
              accountId,
              ...values,
            });
          }
          default:
            throw new Error(`Unexpected update-plan statement: ${stmt.op}`);
        }
      });
      await db.batch(statements as [BatchItem, ...BatchItem[]]);
      ctx.invalidateQueries();
      return { ok: true, reason: "Snapshot saved.", id: args.id, revision: nextRevision };
    },
  }),

  // Correct ONE account's balance in ONE snapshot — the quick fix for
  // a mistyped amount (e.g. an extra $80,000 typed into a new account).
  // Unlike updateNwSnapshot this touches nothing else in the snapshot:
  // every other account's recorded balance stays exactly as it was.
  // balanceCents null (and no splits) removes that account's balance
  // from the snapshot, as if it had never been recorded on that date.
  updateNwBalance: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    // Contract v65 (CAS sweep, F12, folded into F11's counter):
    // `baseRevision` is the SNAPSHOT revision the editor loaded.
    // When supplied, the write is refused when the snapshot's
    // revision has moved since (by either snapshot writer), and an
    // accepted write bumps that same revision — so a whole-snapshot
    // editor holding the pre-correction revision conflicts instead
    // of silently restoring the old balance. Omitting it keeps the
    // legacy unchecked behaviour (named in DATA-PLAN).
    request: nwBalanceEntry.extend({
      snapshotId: z.number().int().positive(),
      baseRevision: z.number().int().nonnegative().optional(),
    }),
    response: nwMutationOut,
    async handler(ctx, args): Promise<z.infer<typeof nwMutationOut>> {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      const [snapshot] = await db
        .select()
        .from(schema.nwSnapshots)
        .where(eq(schema.nwSnapshots.id, args.snapshotId));
      if (!snapshot) {
        return { ok: false, reason: "That snapshot was not found.", id: null };
      }
      const revisionDecision = decideCasRevision(
        snapshot.revision ?? 0,
        args.baseRevision,
      );
      if (!revisionDecision.allowed) {
        return {
          ok: false,
          conflict: true,
          revision: snapshot.revision ?? 0,
          reason: casConflictReason("snapshot"),
          id: null,
        };
      }
      const nextRevision = revisionDecision.nextRevision;
      const bumpSnapshotRevision = async () => {
        await db
          .update(schema.nwSnapshots)
          .set({ revision: nextRevision })
          .where(eq(schema.nwSnapshots.id, args.snapshotId));
      };
      const [account] = await db
        .select()
        .from(schema.nwAccounts)
        .where(eq(schema.nwAccounts.id, args.accountId));
      if (!account) {
        return { ok: false, reason: "That account was not found.", id: null };
      }
      // Duplicate-bucket rejection (cluster C): this action shares
      // the snapshot writers' row-resolution path, so a bucket
      // listed twice in the splits is refused here too, before any
      // write — never folded with the first amount silently dropped.
      const splitsCheck = validateNwBalanceSplits(
        args.splits ?? null,
        await decryptStr(key, account.name),
      );
      if (!splitsCheck.ok) {
        return { ok: false, reason: splitsCheck.reason, id: null };
      }
      const values = await nwBalanceRowValues(
        key,
        { accountId: args.accountId, balanceCents: args.balanceCents, splits: args.splits ?? null },
        // Property and custodial balances are stored whole.
        isPropertyKind(account.propertyKind as NwPropertyKind) ||
          isCustodialAccount(account),
      );
      if (!values) {
        // Removal targets the (snapshot, account) pair directly —
        // at most one row can exist for it (the composite unique
        // index below), so no read is needed to find it.
        await db
          .delete(schema.nwBalances)
          .where(
            and(
              eq(schema.nwBalances.snapshotId, args.snapshotId),
              eq(schema.nwBalances.accountId, args.accountId),
            ),
          );
        await bumpSnapshotRevision();
        ctx.invalidateQueries();
        return {
          ok: true,
          reason: "Balance removed from that snapshot.",
          id: args.snapshotId,
          revision: nextRevision,
        };
      }
      // Atomic upsert on the (snapshotId, accountId) pair
      // (contract v64, A1 — audit F09): the composite unique
      // index (schema + migration 0025) makes the pair a real
      // conflict target, so this ONE statement inserts or updates
      // the pair's single row. The old read-then-insert path let
      // two overlapping writes both see "no row yet" and insert
      // two balance rows for one account in one snapshot, double-
      // counting it in the snapshot total (which sums rows).
      await db
        .insert(schema.nwBalances)
        .values({
          snapshotId: args.snapshotId,
          accountId: args.accountId,
          ...values,
        })
        .onConflictDoUpdate({
          target: [schema.nwBalances.snapshotId, schema.nwBalances.accountId],
          set: values,
        });
      await bumpSnapshotRevision();
      ctx.invalidateQueries();
      return { ok: true, reason: "Balance saved.", id: args.snapshotId, revision: nextRevision };
    },
  }),

  deleteNwSnapshot: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: nwMutationOut,
    async handler(ctx, args): Promise<z.infer<typeof nwMutationOut>> {
      const db = ctx.db<typeof schema>();
      const [existingSnapshot] = await db
        .select({ id: schema.nwSnapshots.id })
        .from(schema.nwSnapshots)
        .where(eq(schema.nwSnapshots.id, args.id));
      if (!existingSnapshot) {
        return { ok: false, reason: "That snapshot was not found.", id: null };
      }
      await db
        .delete(schema.nwBalances)
        .where(eq(schema.nwBalances.snapshotId, args.id));
      await db
        .delete(schema.nwSnapshots)
        .where(eq(schema.nwSnapshots.id, args.id));
      ctx.invalidateQueries();
      return { ok: true, reason: "Snapshot deleted.", id: args.id };
    },
  }),

  addNwAccount: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.object({
      name: nwAccountNameField,
      propertyKind: nwPropertyKindWithDefault,
      // Custodial (e.g. UTMA/UGMA): recorded but never counted.
      // A custodial account is never a property account — when
      // this is true the stored propertyKind is forced to "none".
      custodial: z.boolean().optional().default(false),
    }),
    response: nwMutationOut,
    async handler(ctx, args): Promise<z.infer<typeof nwMutationOut>> {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      const name = args.name.trim();
      if (!name) return { ok: false, reason: "Give the account a name.", id: null };
      if (hasReservedEncPrefix(args.name.trim())) {
        return { ok: false, reason: RESERVED_ENC_PREFIX_MESSAGE, id: null };
      }
      const allRaw = await db.select().from(schema.nwAccounts);
      const all = [];
      for (const a of allRaw) all.push({ ...a, name: await decryptStr(key, a.name) });
      if (all.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
        return { ok: false, reason: `An account named “${name}” already exists.`, id: null };
      }
      const sortOrder = all.reduce((m, a) => Math.max(m, a.sortOrder), -1) + 1;
      const [row] = await db
        .insert(schema.nwAccounts)
        .values({
          name: await encryptStr(key, name),
          sortOrder,
          archived: 0,
          propertyKind: args.custodial ? "none" : (args.propertyKind ?? "none"),
          custodial: args.custodial ? 1 : 0,
        })
        .returning({ id: schema.nwAccounts.id });
      if (!row) throw new Error("insert failed");
      ctx.invalidateQueries();
      return { ok: true, reason: "Account added.", id: row.id };
    },
  }),

  renameNwAccount: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    // Contract v65 (CAS sweep, F19): `base` is the account's
    // (name, propertyKind, custodial) as the editor loaded them.
    // When supplied, the write is refused when any field this save
    // writes no longer matches its base in storage — the name
    // always; propertyKind / custodial only when this save sends
    // them (they remain optional writes). Omitting `base` keeps
    // the legacy unchecked behaviour (named in DATA-PLAN).
    request: z.object({
      id: z.number().int().positive(),
      name: nwAccountNameField,
      // Optional so older callers that only rename keep working;
      // when present, the account's property flag is updated too.
      propertyKind: nwPropertyKindEnum.optional(),
      // Optional like propertyKind: when present, the account's
      // custodial flag is updated too. Marking an account
      // custodial forces its propertyKind to "none" (a custodial
      // account is never a property account).
      custodial: z.boolean().optional(),
      base: z
        .object({
          name: nwAccountNameField,
          propertyKind: nwPropertyKindEnum,
          custodial: z.boolean(),
        })
        .optional(),
    }),
    response: nwMutationOut,
    async handler(ctx, args): Promise<z.infer<typeof nwMutationOut>> {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);
      await ensureKeyCheck(ctx, db, key);
      const name = args.name.trim();
      if (!name) return { ok: false, reason: "Give the account a name.", id: null };
      if (hasReservedEncPrefix(args.name.trim())) {
        return { ok: false, reason: RESERVED_ENC_PREFIX_MESSAGE, id: null };
      }
      const allRaw = await db.select().from(schema.nwAccounts);
      const all = [];
      for (const a of allRaw) all.push({ ...a, name: await decryptStr(key, a.name) });
      // Existence check (finding F22): renaming a missing account
      // must not report success for an update that touched nothing.
      const targetAccount = all.find((a) => a.id === args.id);
      if (!targetAccount) {
        return { ok: false, reason: "That account was not found.", id: null };
      }
      if (args.base !== undefined) {
        const storedAccount = {
          name: targetAccount.name,
          propertyKind: propertyKindOf(targetAccount),
          custodial: isCustodialAccount(targetAccount),
        };
        const guardedFields: string[] = ["name"];
        if (args.propertyKind !== undefined || args.custodial === true) {
          guardedFields.push("propertyKind");
        }
        if (args.custodial !== undefined) guardedFields.push("custodial");
        if (casFieldMismatch(storedAccount, args.base, guardedFields)) {
          return {
            ok: false,
            conflict: true,
            reason: casConflictReason("account"),
            id: null,
          };
        }
      }
      if (
        all.some(
          (a) => a.id !== args.id && a.name.toLowerCase() === name.toLowerCase(),
        )
      ) {
        return { ok: false, reason: `An account named “${name}” already exists.`, id: null };
      }
      await db
        .update(schema.nwAccounts)
        .set({
          name: await encryptStr(key, name),
          ...(args.custodial === true
            ? { propertyKind: "none" as const }
            : args.propertyKind
              ? { propertyKind: args.propertyKind }
              : {}),
          ...(args.custodial !== undefined
            ? { custodial: args.custodial ? 1 : 0 }
            : {}),
        })
        .where(eq(schema.nwAccounts.id, args.id));
      ctx.invalidateQueries();
      return { ok: true, reason: "Account saved.", id: args.id };
    },
  }),

  setNwAccountArchived: defineAction({
    request: z.object({ id: z.number().int().positive(), archived: z.boolean() }),
    response: nwMutationOut,
    async handler(ctx, args): Promise<z.infer<typeof nwMutationOut>> {
      const db = ctx.db<typeof schema>();
      const updated = await db
        .update(schema.nwAccounts)
        .set({ archived: args.archived ? 1 : 0 })
        .where(eq(schema.nwAccounts.id, args.id))
        .returning({ id: schema.nwAccounts.id });
      if (updated.length === 0) {
        return { ok: false, reason: "That account was not found.", id: null };
      }
      ctx.invalidateQueries();
      return {
        ok: true,
        reason: args.archived ? "Account archived." : "Account restored.",
        id: args.id,
      };
    },
  }),

  // Permanent removal of an account and every balance it has in
  // every snapshot. Two deliberate guards make this unreachable by
  // accident: the account must already be archived (archiving is
  // the first step; this action refuses a live account), and
  // property accounts (the house, its mortgage) are never
  // hard-deletable through this action. Custodial accounts follow
  // the NORMAL rule (archived first, like ordinary accounts) — only
  // property accounts are refused. Snapshot totals are computed
  // from the remaining balances, so they recompute on their own.
  deleteNwAccount: defineAction({
    request: z.object({ id: z.number().int().positive() }),
    response: nwMutationOut,
    async handler(ctx, args): Promise<z.infer<typeof nwMutationOut>> {
      const db = ctx.db<typeof schema>();
      const [account] = await db
        .select()
        .from(schema.nwAccounts)
        .where(eq(schema.nwAccounts.id, args.id));
      if (!account) {
        return { ok: false, reason: "That account no longer exists.", id: null };
      }
      if (account.archived !== 1) {
        return {
          ok: false,
          reason:
            "Archive the account first — only archived accounts can be deleted permanently.",
          id: args.id,
        };
      }
      if (isPropertyKind(propertyKindOf(account))) {
        return {
          ok: false,
          reason: "Property accounts can't be deleted permanently.",
          id: args.id,
        };
      }
      await db
        .delete(schema.nwBalances)
        .where(eq(schema.nwBalances.accountId, args.id));
      await db
        .delete(schema.nwAccounts)
        .where(eq(schema.nwAccounts.id, args.id));
      ctx.invalidateQueries();
      return { ok: true, reason: "Account deleted permanently.", id: args.id };
    },
  }),

  /* ---------------- Backup / restore actions ---------------- */

  // Returns the complete dataset as one payload (see the backup
  // schema above). No UI calls this directly — it exists for
  // agent-run encrypted backups; the Backups panel's create button
  // uses the same payload builder via createBackupNow. All values
  // are decrypted to their true figures, exactly as the other
  // actions return them.
  exportbackup: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.object({}),
    response: backupPayload,
    async handler(ctx): Promise<z.infer<typeof backupPayload>> {
      return buildBackupPayload(ctx);
    }
  }),

  // Replaces the ENTIRE dataset with the given backup payload
  // (the exact shape exportbackup returns), preserving ids and
  // relationships and re-encrypting every value on write. After a
  // restore, getDashboard / getNetWorth return figures identical
  // to the exported ones.
  restorebackup: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: backupPayload,
    response: restoreBackupOut,
    async handler(ctx, args): Promise<z.infer<typeof restoreBackupOut>> {
      const db = ctx.db<typeof schema>();
      const key = await getCryptoKey(ctx);

      /* ---- FULL preflight — before ANY write (cluster A) ----
         The payload arrives schema-validated by the action contract
         (with restoreCore's legacy defaults applied: a missing
         propertyKind restores as "none", missing split keys as
         null). Everything else that can refuse the restore is
         checked here, against the payload alone: its own encryption
         key-check under the current key, its authenticity MAC
         (S1 — a carried MAC that does not verify refuses; no MAC
         restores labelled unauthenticated), every enum,
         intra-payload uniqueness, and referential integrity. Any
         failure returns ok:false with zero writes — the current
         data is untouched, byte for byte. */
      const keyCheckValue = payloadKeyCheckValue(args);
      let payloadKeyCheckValid: boolean | null = null;
      if (keyCheckValue != null) {
        if (isEncrypted(keyCheckValue)) {
          // An older export carrying the key-check as ciphertext:
          // it validates only if it decrypts under the CURRENT key
          // to the known constant.
          try {
            payloadKeyCheckValid =
              (await decryptStr(key, keyCheckValue)) === KEY_CHECK_PLAINTEXT;
          } catch {
            payloadKeyCheckValid = false;
          }
        } else {
          // Current exports carry the key-check decrypted, like
          // every other figure in the payload.
          payloadKeyCheckValid = keyCheckValue === KEY_CHECK_PLAINTEXT;
        }
      }
      // The authenticity MAC verdict (S1), computed from the
      // payload alone by backupMacCore's pure classifier — the
      // same verdict restoreCore's fixture model computes:
      // "verified" (MAC present, verifies), "mismatch" (MAC
      // present, does not verify — preflight refuses), "absent"
      // (no MAC — a pre-MAC backup; restores, labelled
      // UNAUTHENTICATED in the result below).
      const payloadAuthenticity = classifyBackupAuthenticity(args);
      const preflight = preflightRestoreBackup(
        args,
        payloadKeyCheckValid,
        payloadAuthenticity,
      );
      if (!preflight.ok) {
        return { ok: false, reason: preflight.reason, authenticated: false };
      }

      /* ---- Build every row value (encrypting as we go) ----
         All fallible work — encryption included — happens here,
         before the replacement, so nothing after this point can
         fail partway for a payload reason. Settings are built
         first (the key-check is re-validated at the end). The
         settings stored encrypted at rest (opening reserve,
         key-check, saved retirement inputs) are re-encrypted here
         when the payload carries them decrypted; a payload from an
         older export that still carries one as ciphertext under
         the same key is stored as-is. Net Worth balances are
         normalised by restoreCore's rule: a non-empty split IS the
         balance, so balanceCents is recomputed from the parts
         exactly as every normal writer computes it. */
      // R4-2 / F4: the restored Roth blob is stamped a new
      // generation — read the CURRENT Roth row's revision once,
      // before the build loop, leniently parsed.
      const currentSettingRows = await db.select().from(schema.settings);
      const currentRothRow = currentSettingRows.find(
        (r: { key: string }) => r.key === RESTORE_ROTH_BLOB_KEY,
      );
      let preRestoreRothRevision = 0;
      if (currentRothRow?.value) {
        if (isEncrypted(currentRothRow.value)) {
          try {
            preRestoreRothRevision = parseRothBlobRevision(
              await decryptStr(key, currentRothRow.value),
            );
          } catch {
            preRestoreRothRevision = 0;
          }
        } else {
          preRestoreRothRevision = parseRothBlobRevision(currentRothRow.value);
        }
      }
      const settingsRows: (typeof schema.settings.$inferInsert)[] = [];
      for (const s of args.settings) {
        let stored = s.value;
        // The encrypted-at-rest keys are restoreCore's ONE list
        // (ENCRYPTED_AT_REST_SETTING_KEYS, via
        // isEncryptedAtRestSettingKey) — security round-2,
        // finding 3: the hand-written list here omitted
        // IMPORT_SETTINGS_KEY, so a restored spending-import
        // settings value was stored as plaintext until a later
        // save happened to rewrite it.
        if (isEncryptedAtRestSettingKey(s.key)) {
          if (isEncrypted(s.value)) {
            // Reserved-prefix verification (cluster E): a value for
            // one of these encrypted-at-rest keys that CARRIES the
            // prefix is stored as-is only when it genuinely
            // decrypts under the current key. One that does not is
            // fake ciphertext (or another key's) and would break
            // every later load, so the restore is refused here —
            // while rows are still only being built, before the
            // atomic batch, with zero writes.
            let decrypted: string;
            try {
              decrypted = await decryptStr(key, s.value);
            } catch {
              return {
                ok: false,
                reason:
                  "A saved planner value in that backup can't be decrypted with this app's encryption key, so the restore was refused — nothing was changed.",
                authenticated: false,
              };
            }
            if (s.key === RESTORE_ROTH_BLOB_KEY) {
              const stamped = stampRestoredRothBlob(decrypted, preRestoreRothRevision);
              stored = stamped != null ? await encryptStr(key, stamped) : s.value;
            } else {
              stored = s.value;
            }
          } else if (s.key === RESTORE_ROTH_BLOB_KEY) {
            const stamped = stampRestoredRothBlob(s.value, preRestoreRothRevision);
            stored = stamped != null ? await encryptStr(key, stamped) : await encryptStr(key, s.value);
          } else {
            stored = await encryptStr(key, s.value);
          }
        }
        settingsRows.push({ key: s.key, value: stored });
      }
      const yearlyExpenseRows: (typeof schema.yearlyExpenses.$inferInsert)[] = [];
      for (const y of args.yearlyExpenses) {
        yearlyExpenseRows.push({
          id: y.id,
          name: await encryptStr(key, y.name),
          frequency: y.frequency as typeof schema.yearlyExpenses.$inferInsert.frequency,
          expectedCents: await encryptNum(key, y.expectedCents),
          dueMonth: y.dueMonth,
          paidByType: y.paidByType as typeof schema.yearlyExpenses.$inferInsert.paidByType,
          paidByName: await encryptStr(key, y.paidByName),
          backfillBeforeFirstVersion: y.backfillBeforeFirstVersion,
          category: await encryptStr(key, y.category),
          keepLightsOn: y.keepLightsOn,
          createdAt: backupMsToDate(y.createdAt),
        });
      }
      const yearlyExpenseVersionRows: (typeof schema.yearlyExpenseVersions.$inferInsert)[] = [];
      for (const v of args.yearlyExpenseVersions) {
        yearlyExpenseVersionRows.push({
          id: v.id,
          expenseId: v.expenseId,
          expectedCents: await encryptNum(key, v.expectedCents),
          frequency: v.frequency as typeof schema.yearlyExpenseVersions.$inferInsert.frequency,
          effectiveFrom: v.effectiveFrom,
          createdAt: backupMsToDate(v.createdAt),
        });
      }
      const monthlyBillRows: (typeof schema.monthlyBills.$inferInsert)[] = [];
      for (const b of args.monthlyBills) {
        monthlyBillRows.push({
          id: b.id,
          name: await encryptStr(key, b.name),
          amountCents: await encryptNum(key, b.amountCents),
          paidBy: await encryptStr(key, b.paidBy),
          notes: await encryptNullable(key, b.notes),
          category: await encryptStr(key, b.category),
          keepLightsOn: b.keepLightsOn,
          collapsed: b.collapsed,
          createdAt: backupMsToDate(b.createdAt),
        });
      }
      const monthlyBillVersionRows: (typeof schema.monthlyBillVersions.$inferInsert)[] = [];
      for (const v of args.monthlyBillVersions) {
        monthlyBillVersionRows.push({
          id: v.id,
          billId: v.billId,
          amountCents: await encryptNum(key, v.amountCents),
          effectiveFrom: v.effectiveFrom,
          createdAt: backupMsToDate(v.createdAt),
        });
      }
      const monthlySummaryRows: (typeof schema.monthlySummaries.$inferInsert)[] = [];
      for (const s of args.monthlySummaries) {
        monthlySummaryRows.push({
          month: s.month,
          cashOutCents: await encryptNum(key, s.cashOutCents),
          createdAt: backupMsToDate(s.createdAt),
          updatedAt: backupMsToDate(s.updatedAt),
        });
      }
      const monthlyOneOffRows: (typeof schema.monthlyOneOffs.$inferInsert)[] = [];
      for (const o of args.monthlyOneOffs) {
        monthlyOneOffRows.push({
          id: o.id,
          month: o.month,
          description: await encryptStr(key, o.description),
          amountCents: await encryptNum(key, o.amountCents),
          note: await encryptNullable(key, o.note),
          createdAt: backupMsToDate(o.createdAt),
        });
      }
      const monthlyCashOutItemRows: (typeof schema.monthlyCashOutItems.$inferInsert)[] = [];
      for (const o of args.monthlyCashOutItems) {
        monthlyCashOutItemRows.push({
          id: o.id,
          month: o.month,
          description: await encryptStr(key, o.description),
          amountCents: await encryptNum(key, o.amountCents),
          note: await encryptNullable(key, o.note),
          day: o.day,
          createdAt: backupMsToDate(o.createdAt),
        });
      }
      const transactionRows: (typeof schema.transactions.$inferInsert)[] = [];
      for (const t of args.transactions) {
        transactionRows.push({
          id: t.id,
          date: t.date,
          description: await encryptStr(key, t.description),
          amountCents: await encryptNum(key, t.amountCents),
          sourceType: t.sourceType as typeof schema.transactions.$inferInsert.sourceType,
          accountName: await encryptStr(key, t.accountName),
          kind: t.kind as typeof schema.transactions.$inferInsert.kind,
          category: await encryptStr(key, t.category),
          yearlyExpenseId: t.yearlyExpenseId,
          fitId: await encryptNullable(key, t.fitId),
          createdAt: backupMsToDate(t.createdAt),
        });
      }
      const nwAccountRows: (typeof schema.nwAccounts.$inferInsert)[] = [];
      for (const a of args.nwAccounts) {
        nwAccountRows.push({
          id: a.id,
          name: await encryptStr(key, a.name),
          bucket: a.bucket,
          // Preflight has already validated propertyKind against
          // the enum, so this cast can no longer smuggle an
          // unrecognised value into "none".
          propertyKind: a.propertyKind as typeof schema.nwAccounts.$inferInsert.propertyKind,
          custodial: isCustodialAccount(a) ? 1 : 0,
          sortOrder: a.sortOrder,
          archived: a.archived,
          createdAt: backupMsToDate(a.createdAt),
        });
      }
      const nwSnapshotRows: (typeof schema.nwSnapshots.$inferInsert)[] = [];
      for (const s of args.nwSnapshots) {
        nwSnapshotRows.push({
          id: s.id,
          date: s.date,
          note: await encryptNullable(key, s.note),
          createdAt: backupMsToDate(s.createdAt),
        });
      }
      const nwBalanceRows: (typeof schema.nwBalances.$inferInsert)[] = [];
      for (const raw of args.nwBalances) {
        const b = normalizeBackupBalance(raw);
        nwBalanceRows.push({
          id: b.id,
          snapshotId: b.snapshotId,
          accountId: b.accountId,
          balanceCents: await encryptNum(key, b.balanceCents),
          splitHsaCents:
            b.splitHsaCents == null ? null : await encryptNum(key, b.splitHsaCents),
          splitRothCents:
            b.splitRothCents == null ? null : await encryptNum(key, b.splitRothCents),
          splitTaxableCents:
            b.splitTaxableCents == null
              ? null
              : await encryptNum(key, b.splitTaxableCents),
          splitNonTaxableCents:
            b.splitNonTaxableCents == null
              ? null
              : await encryptNum(key, b.splitNonTaxableCents),
          split529Cents:
            b.split529Cents == null ? null : await encryptNum(key, b.split529Cents),
          splitCashCents:
            b.splitCashCents == null ? null : await encryptNum(key, b.splitCashCents),
          splitPreTaxCents:
            b.splitPreTaxCents == null ? null : await encryptNum(key, b.splitPreTaxCents),
        });
      }

      /* ---- ONE atomic batch: wipe + insert, all or nothing ----
         The platform's batch is the atomic multi-statement write
         set (the SDK deliberately offers no transaction handle):
         if any statement fails, none of them land and the previous
         dataset survives whole. Rows are inserted in chunks so no
         single statement carries an unbounded row count. */
      type BatchItem = Parameters<typeof db.batch>[0][number];
      const statements: BatchItem[] = [];
      // Wipe every table, children before parents.
      statements.push(db.delete(schema.nwBalances));
      statements.push(db.delete(schema.nwSnapshots));
      statements.push(db.delete(schema.nwAccounts));
      statements.push(db.delete(schema.transactions));
      statements.push(db.delete(schema.yearlyExpenseVersions));
      statements.push(db.delete(schema.monthlyBillVersions));
      statements.push(db.delete(schema.monthlyOneOffs));
      statements.push(db.delete(schema.monthlyCashOutItems));
      statements.push(db.delete(schema.monthlySummaries));
      statements.push(db.delete(schema.monthlyBills));
      statements.push(db.delete(schema.yearlyExpenses));
      statements.push(db.delete(schema.settings));
      const CHUNK = 100;
      const pushInserts = <T,>(table: any, rows: T[]): void => {
        for (let i = 0; i < rows.length; i += CHUNK) {
          statements.push(db.insert(table).values(rows.slice(i, i + CHUNK) as any));
        }
      };
      pushInserts(schema.settings, settingsRows);
      pushInserts(schema.yearlyExpenses, yearlyExpenseRows);
      pushInserts(schema.yearlyExpenseVersions, yearlyExpenseVersionRows);
      pushInserts(schema.monthlyBills, monthlyBillRows);
      pushInserts(schema.monthlyBillVersions, monthlyBillVersionRows);
      pushInserts(schema.monthlySummaries, monthlySummaryRows);
      pushInserts(schema.monthlyOneOffs, monthlyOneOffRows);
      pushInserts(schema.monthlyCashOutItems, monthlyCashOutItemRows);
      pushInserts(schema.transactions, transactionRows);
      pushInserts(schema.nwAccounts, nwAccountRows);
      pushInserts(schema.nwSnapshots, nwSnapshotRows);
      pushInserts(schema.nwBalances, nwBalanceRows);
      await db.batch(statements as [BatchItem, ...BatchItem[]]);

      // Recreate / verify the encryption key-check for the restored
      // settings (creates it when the payload did not carry one).
      await ensureKeyCheck(ctx, db, key);
      ctx.invalidateQueries();
      // The authenticity label (S1): a MAC-verified restore says
      // so; a pre-MAC backup (no MAC) is labelled UNAUTHENTICATED
      // in as many words — it restored, but nothing in it proves
      // its contents are unmodified since export.
      const authenticated = payloadAuthenticity === "verified";
      return {
        ok: true,
        authenticated,
        reason: authenticated
          ? `Backup restored (authenticity MAC verified): ${args.monthlyBills.length} monthly bills, ${args.yearlyExpenses.length} yearly expenses, ${args.transactions.length} transactions, ${args.nwAccounts.length} Net Worth accounts, ${args.nwSnapshots.length} snapshots, ${args.nwBalances.length} balances.`
          : `Backup restored (UNAUTHENTICATED backup — no authenticity MAC, so nothing proves its contents are unmodified since export; written before MAC signing or the MAC was removed): ${args.monthlyBills.length} monthly bills, ${args.yearlyExpenses.length} yearly expenses, ${args.transactions.length} transactions, ${args.nwAccounts.length} Net Worth accounts, ${args.nwSnapshots.length} snapshots, ${args.nwBalances.length} balances.`,
      };
    },
  }),

  /* ---------------- Backup files (outside the app) ----------------
     The encrypted backups live as files named backup-*.mstbak in
     this space's own backups folder (<spaceDir>/backups), outside
     the app so they survive its deletion. These actions list and
     delete those REAL files, read live on every call. The former
     workspace-level folder (~/workspace/spending-tracker-backups)
     is a READ-ONLY legacy union: its files are still listed and
     restorable, but are never written, deleted, or pruned from
     here — delete, delete-all, and the newest-12 prune operate only
     on this space's own files. The listing marks each entry's
     source ("own" / "legacy") so the panel can label legacy-only
     backups read-only up front instead of offering a Delete that
     can only refuse. All filesystem work goes through
     the privileged handlers, which execute the rules in
     backupCore.ts and only ever touch files matching
     backup-*.mstbak in one of those two folders — never
     mst-crypt.mjs, never any key file, never anything else. */

  listBackups: defineAction({
    privileged: [privileged.listBackups],
    request: z.object({}),
    response: z.object({
      backups: z.array(
        z.object({
          name: z.string(),
          sizeBytes: z.number(),
          modifiedMs: z.number(),
          source: z.enum(["own", "legacy"]),
        }),
      ),
    }),
    async handler(ctx) {
      const { backups } = await ctx.executePrivileged(
        privileged.listBackups,
        { spaceDir: ctx.spaceDir },
      );
      return { backups };
    },
  }),

  deleteBackup: defineAction({
    privileged: [privileged.deleteBackup],
    request: z.object({ filename: z.string().min(1).max(120) }),
    response: z.object({ ok: z.boolean(), reason: z.string() }),
    async handler(
      ctx,
      args,
    ): Promise<{ ok: boolean; reason: string }> {
      // Defence in depth alongside the privileged check: refuse
      // anything that is not a plain backup-*.mstbak filename.
      if (
        !/^backup-[A-Za-z0-9][A-Za-z0-9._-]*\.mstbak$/.test(args.filename) ||
        args.filename.includes("..") ||
        args.filename.includes("/") ||
        args.filename.includes("\\")
      ) {
        return {
          ok: false,
          reason:
            "Refused: only backup-*.mstbak files in the backups folder can be deleted.",
        };
      }
      const res = await ctx.executePrivileged(privileged.deleteBackup, {
        spaceDir: ctx.spaceDir,
        filename: args.filename,
      });
      ctx.invalidateQueries();
      return res;
    },
  }),

  deleteAllBackups: defineAction({
    privileged: [privileged.deleteAllBackups],
    request: z.object({}),
    response: z.object({
      ok: z.boolean(),
      reason: z.string(),
      deletedCount: z.number(),
    }),
    async handler(
      ctx,
    ): Promise<{ ok: boolean; reason: string; deletedCount: number }> {
      const res = await ctx.executePrivileged(
        privileged.deleteAllBackups,
        { spaceDir: ctx.spaceDir },
      );
      ctx.invalidateQueries();
      return res;
    },
  }),

  // Creates a backup right now, from the Backups panel: builds the
  // exact payload exportbackup returns and hands it to the
  // privileged handler, which encrypts it with the existing A1
  // scheme (public key only) and writes it into the same backups
  // folder listBackups reads, under the same newest-12 rotation the
  // weekly backups use. Read-only with respect to app data: nothing
  // in the dataset is created, changed, or deleted.
  createBackupNow: defineAction({
    privileged: [privileged.ensureEncryptionKey, privileged.createBackup],
    request: z.object({}),
    response: z.object({
      ok: z.boolean(),
      filename: z.string().nullable(),
      reason: z.string(),
      prunedCount: z.number(),
    }),
    async handler(
      ctx,
    ): Promise<{
      ok: boolean;
      filename: string | null;
      reason: string;
      prunedCount: number;
    }> {
      const payload = await buildBackupPayload(ctx);
      const res = await ctx.executePrivileged(privileged.createBackup, {
        spaceDir: ctx.spaceDir,
        payloadJson: JSON.stringify(payload),
      });
      if (res.ok) ctx.invalidateQueries();
      return res;
    },
  }),
  /* ---------------- Accuracy self-check (maintenance) ----------------
     Not a user-facing feature: no screen calls this. It runs ONE
     suite per invocation so each call completes well inside the
     space-worker time cap — the combined suites previously timed
     out. Pass `suite` to select: "tax", "tax-teeth",
     "tax-teeth-opt", "extended",
     "extended-teeth", "retirement" (fixtures + Trinity benchmark),
     "retirement-teeth", "integrity" (the five data-integrity
     checks over durable data), "ui-state" (the Roth UI-state
     blob's revision/CAS write contract), "roth-cas" (the Roth
     plan record's revision/CAS write contract),
     "retirement-cas" (the two Retirement records' revision/CAS
     write contract), or "replay" (the optimizer-determinism
     replay diagnostic — see runReplayDiagnostic in
     taxFixtures.ts; its report is the `replay` field). The full verification is the
     sequence of those per-suite calls; each returns the same
     per-suite counts/results shape as before, with the suites
     that did not run left null. A call with no `suite` does NOT
     silently skip suites: it runs only the fast integrity suite
     and says so explicitly in `note`. It reads data and changes
     nothing. */
  runAccuracySelfCheck: defineAction({
    privileged: [privileged.ensureEncryptionKey],
    request: z.object({ suite: accuracySuiteEnum.optional() }),
    response: accuracySelfCheckResponse,
    async handler(ctx, args): Promise<AccuracySelfCheckResponse> {
      const empty: AccuracySelfCheckResponse = {
        suite: args.suite ?? "none",
        note: "",
        fixtures: null,
        trinity: null,
        trinityCitation: null,
        extendedFixtures: null,
        taxFixtures: null,
        uiStateFixtures: null,
        rothCasFixtures: null,
        retirementCasFixtures: null,
        decemberFixtures: null,
        teeth: { retirement: null, extended: null, tax: null },
        integrity: null,
        replay: null,
      };
      const loadIntegrity = async (): Promise<
        z.infer<typeof accuracyIntegritySchema>
      > => {
        const data = await loadAll(ctx);
        const nw = await loadNetWorthDecrypted(ctx, data.db, data.key);
        const includeProperty =
          data.settingsMap.get(NW_INCLUDE_PROPERTY_KEY) === "1";
        const checks = [
          checkNwSnapshotTotals(nw, includeProperty),
          checkNwBucketSplits(nw),
          checkBillVersionChains(data),
          checkPaymentReferences(data),
          checkCashOutItems(data),
        ];
        return {
          totalViolations: checks.reduce(
            (n, c) => n + c.violations.length,
            0,
          ),
          checks,
        };
      };
      switch (args.suite) {
        case "tax":
          return {
            ...empty,
            suite: "tax",
            note: "Ran the tax fixtures suite only.",
            taxFixtures: runTaxFixtures(),
          };
        case "tax-teeth":
          return {
            ...empty,
            suite: "tax-teeth",
            note: "Ran the tax teeth suite (core corrupted-case check) only. Run suite tax-teeth-opt for the per-optimizer-case teeth check.",
            teeth: {
              retirement: null,
              extended: null,
              tax: runTaxTeethCheck("core"),
            },
          };
        case "tax-teeth-opt":
          return {
            ...empty,
            suite: "tax-teeth-opt",
            note: "Ran the tax teeth suite (per-optimizer-case check) only.",
            teeth: {
              retirement: null,
              extended: null,
              tax: runTaxTeethCheck("opt"),
            },
          };
        case "extended":
          return {
            ...empty,
            suite: "extended",
            note: "Ran the extended fixtures suite only.",
            extendedFixtures: runExtendedFixtures(),
          };
        case "extended-teeth":
          return {
            ...empty,
            suite: "extended-teeth",
            note: "Ran the extended teeth suite only.",
            teeth: {
              retirement: null,
              extended: runExtendedTeethCheck(),
              tax: null,
            },
          };
        case "retirement":
          return {
            ...empty,
            suite: "retirement",
            note: "Ran the retirement fixtures suite (including the Trinity benchmark) only.",
            fixtures: runRetirementFixtures(),
            trinity: runTrinityBenchmark(),
            trinityCitation: TRINITY_PUBLISHED.citation,
          };
        case "retirement-teeth":
          return {
            ...empty,
            suite: "retirement-teeth",
            note: "Ran the retirement teeth suite only.",
            teeth: {
              retirement: runRetirementTeethCheck(),
              extended: null,
              tax: null,
            },
          };
        case "integrity":
          return {
            ...empty,
            suite: "integrity",
            note: "Ran the integrity suite only.",
            integrity: await loadIntegrity(),
          };
        case "ui-state":
          return {
            ...empty,
            suite: "ui-state",
            note: "Ran the Roth UI-state CAS fixtures suite only.",
            uiStateFixtures: runRothUiStateFixtures(),
          };
        case "roth-cas":
          return {
            ...empty,
            suite: "roth-cas",
            note: "Ran the Roth plan-record CAS fixtures suite only.",
            rothCasFixtures: runRothCasFixtures(),
          };
        case "retirement-cas":
          return {
            ...empty,
            suite: "retirement-cas",
            note: "Ran the Retirement records CAS fixtures suite only.",
            retirementCasFixtures: runRetirementCasFixtures(),
          };
        case "december":
          return {
            ...empty,
            suite: "december",
            note: "Ran the December projection console fixtures suite only.",
            decemberFixtures: runDecemberFixtures(),
          };
        case "replay":
          return {
            ...empty,
            suite: "replay",
            note: "Ran the replay diagnostic only: in-process double-price of takeaway-multi-ceiling-inputs, full score-vector double-run of opt-aca-bunching-beats-level-cliff, and permuted-order runs of the known-flaky fixtures. The replay field is the report: it names the first divergence or states which isolation level is clean.",
            replay: runReplayDiagnostic(),
          };
        default:
          return {
            ...empty,
            suite: "none",
            note: "No suite selected: ran only the fast integrity suite. The tax, tax-teeth, tax-teeth-opt, extended, extended-teeth, retirement, retirement-teeth, ui-state, roth-cas, retirement-cas, replay, and december suites were NOT run. Call again with suite set to one of: tax, tax-teeth, tax-teeth-opt, extended, extended-teeth, retirement, retirement-teeth, integrity, ui-state, roth-cas, retirement-cas, replay, december.",
            integrity: await loadIntegrity(),
          };
      }
    },
  }),
} satisfies ActionsModule;
