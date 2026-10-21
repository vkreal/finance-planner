import { z } from "@hatch/space-sdk";
import { NW_PROPERTY_KINDS } from "./nwCore";
import { seedRothInputs } from "./rothSeed";
import type { PlaygroundYearInputs } from "./rothOptimizer";

/* ---------------- API contract core (model-friendly API) ----------------
   The pieces of the published action contract that the accuracy
   fixtures pin directly, extracted from actions.ts so the
   fixtures can pin the EXACT schemas and strings the actions
   publish without importing actions.ts (which imports the
   fixture suites for the self-check action — the same reason
   rothUiStateCore / rothRevisionCore / restoreCore exist).
   actions.ts imports everything here and re-uses it verbatim:
   there is one definition of each shape, and it lives here. */

// The six spending draw orders, as the keys the tax engine
// defines (server/src/taxEngine.ts DRAW_ORDER_OPTIONS).
export const DRAW_ORDER_KEYS = [
  "taxable-pretax-roth",
  "taxable-roth-pretax",
  "pretax-taxable-roth",
  "pretax-roth-taxable",
  "roth-taxable-pretax",
  "roth-pretax-taxable",
] as const;

export const rothFilingStatus = z.enum(["mfj", "single", "hoh"]);

/* The five balance keys' field schema, shared by every layer
   that carries a balance (the saved record's rothInputFields,
   the compute payloads, the scenario writers): integer cents,
   REQUIRED, null accepted. One definition, referenced by
   rothInputFields in actions.ts, so the base-layer omission
   rule the fixtures pin against rothBaseBalancesIn below is
   the rule the shipped schemas enforce. */
export const rothBalanceField = z.number().int().nullable();
export const rothBaseBalanceFields = {
  pretaxCents: rothBalanceField,
  pretaxSpouseCents: rothBalanceField,
  rothCents: rothBalanceField,
  taxableCents: rothBalanceField,
  hsaCents: rothBalanceField,
};
export const rothBaseBalancesIn = z.object(rothBaseBalanceFields);

/* The balance-semantics convention describeApi publishes
   (API follow-on 2, finding F9). The binding convention:
   a blank balance at the base layer means FOLLOW THE SNAPSHOT.
   The behaviour this text describes is the shipped behaviour —
   this constant only makes the contract state it. */
export const BALANCE_SEMANTICS =
  "Balance keys (pretaxCents, pretaxSpouseCents, rothCents, taxableCents, hsaCents) follow two different rules at two layers. At the base layer — the saved record and every compute action's base plan payload — each balance key is REQUIRED and nullable: an explicit null is a blank, and a blank means follow the snapshot — the balance resolves from the latest Net Worth snapshot's bucket subtotal for that bucket ($0 only when the snapshot has no value for that bucket) — while omitting the key fails validation. pretaxSpouseCents is the one exception: it has no snapshot bucket of its own. It is an explicit allocation carved out of the primary's snapshot-followed pre-tax amount — the primary's resolved pretaxCents is the snapshot Pre-tax subtotal minus pretaxSpouseCents — and a blank pretaxSpouseCents carves out $0. In scenario overrides (runRothCompare and runRothMonteCarloStats scenarios[].overrides) every balance key is optional instead: an omitted key inherits the base's already-resolved value, and an explicit null is NOT a blank — it is an affirmative what-if instruction that prices that balance at $0 for the scenario and is never re-resolved against the snapshot. One interaction: taxableExcludeCents subtracts from the snapshot-followed taxable pool only, and is inert beside an explicit taxableCents.";

/* The flexible-spending convention describeApi publishes
   (FLEXIBLE SPENDING build). The behaviour this text
   describes is the shipped behaviour (taxEngine's
   flexSpendingNeed) — this constant only makes the contract
   state it, in a December framing: the budget decision
   and the withdrawal that funds next year happen in one act
   as the year lands. */
export const FLEX_SEMANTICS =
  "Flexible spending (flexCutPct / flexFloorPct): plan fields, null on records that predate them. flexCutPct null or 0 is OFF and prices bit-identically to a plan without the fields. The rule runs on the household's own rhythm: each December, as the year lands, the plan sets next year's spending budget and makes the withdrawal that funds next year, in one act — so a year's budget is decided from the year just ended. When flexCutPct is set, the budget for a year whose PRIOR simulated year's applied return was negative is cut: the year's spending need becomes its base need reduced by flexCutPct percent, but never below flexFloorPct percent of the base need (flexFloorPct null reads as 80). The cut is a single level recomputed from the base need each year — consecutive down years do not deepen it — and spending restores to full in the first year after a non-negative year. The first simulated year is never cut. On a deterministic run (and at Monte Carlo volatility 0) the applied return is the plan's expectedReturnPct every year, so flex changes nothing unless that return is negative. A year's unfunded spending (spendShortfall) is always measured against that year's effective — post-cut — need.";

/* The protect-minimum convention describeApi publishes
   (cash-floor circle-back, description fix). The behaviour
   this text describes is the shipped behaviour (taxEngine's
   settleYear: the single capped sale in the tax channel) —
   this constant only makes the contract state it, including
   what the field does NOT do. */
export const PROTECT_MIN_SEMANTICS =
  "Protect-minimum taxable (protectMinTaxableCents) caps ONE sale in a year's settlement: when a plan pays its tax from Taxable (payTaxFrom \"taxable\"), the sale out of the combined taxable+cash pool that pays the year's tax bill — federal tax plus state tax plus IRMAA, after surplus income cash has paid first — is at most the pool balance minus the protect-minimum, measured on the pool balance at that point in the settlement, so that sale alone never takes the pool below the amount. The amount is a fixed nominal figure (it does not inflate), and a blank field prices as $0, which caps nothing. What the capped sale leaves unpaid is withheld from that year's conversion; the part the conversion absorbs is, before 59½, an early distribution and carries the 10% penalty, grossed up. Whatever the conversion cannot absorb is debited from Taxable below the protect-minimum, then from Pre-tax, then Roth — that overflow carries tax only, no penalty. It is NOT a guaranteed minimum balance: spending draws in the plan's draw order ignore it entirely, the unpaid-tax debits just described go below it, and a year can end with the pool under the protect-minimum. It also does NOT preserve cash: pool sales consume basis tiers highest-basis first, so the 100%-basis (cash) tier is sold first, and no setting of the field holds any cash back — in a circle-back sweep on a sample plan the pool and its cash tier ended at $0 with the field at $0, $50,000, $100,000, and $200,000 alike. On a plan whose pool stays far above the amount (a wide pool under cliff ceilings) it never engages: such a plan prices identically with the field at $50,000 or at $0.";

/* ---------------- Monte Carlo check score input ----------------
   The runRothMonteCarloCheck winner / doNothing input: the
   fields the client already holds from an optimizer score (the
   optScoreOut shape in actions.ts). Tightened to sibling
   strictness (API follow-on 2, finding F6), mirroring
   rothCeilings / rothInputFields exactly — integer cents stay
   integer cents, ages are whole ages 0–120, and the draw order
   must be one of the six engine keys (an unknown key used to
   fall back silently to the default order while the response
   kept the caller's winner name). The Social Security amounts
   are DOLLARS and may legitimately carry cents, so they are
   finite-and-nonnegative, never forced to integers. Every rule
   here accepts exactly what the client's toOptScore can emit
   (drawOrder via drawOrderKey, the cents fields via Math.round,
   integer claim ages and window stop ages). */
export const mcScoreIn = z.strictObject({
  name: z.string(),
  windowStopAge: z.number().int().min(0).max(120),
  guardrail: z.boolean(),
  bunching: z.boolean(),
  ceilings: z.strictObject({
    bracketTopPct: z.number().nullable(),
    irmaaTierCap: z.number().int().nullable(),
    ltcgZeroCap: z.boolean(),
    acaCliffCap: z.boolean(),
    // Optional (absence = false), like the compute ceilings.
    acaCliffCapFamilyOnly: z.boolean().optional(),
    magiCapCents: z.number().int().nullable(),
    acaCliffBufferCents: z.number().int().nullable(),
  }),
  claimPrimaryAge: z.number().int().min(0).max(120).nullable(),
  claimSpouseAge: z.number().int().min(0).max(120).nullable(),
  ssPrimaryAnnual: z.number().finite().nonnegative(),
  ssSpouseAnnual: z.number().finite().nonnegative(),
  drawOrder: z.enum(DRAW_ORDER_KEYS),
});
export type McScoreIn = z.infer<typeof mcScoreIn>;

/* ---------------- Playground single-year input ----------------
   The runPlaygroundYear request (API follow-on 2, finding
   F20): validation REJECTS rather than clamps. Money dials are
   finite and nonnegative — a negative amount fails validation
   instead of being silently clamped to $0 — except
   otherOrdinary, which keeps its sign by design (a loss is
   legitimate). taxYear is bounded 2000–2100 (the 2027
   paste-loader flow stays valid); stateRatePct mirrors the
   plan inputs' 0–100 bound, the same rejection
   parsePlaygroundPaste already applies to pastes. */
export const playgroundYearIn = z.object({
  taxYear: z.number().int().min(2000).max(2100),
  filingStatus: rothFilingStatus,
  agePrimary: z.number().int().min(0).max(120),
  ageSpouse: z.number().int().min(0).max(120).nullable(),
  onMedicarePrimary: z.boolean(),
  onMedicareSpouse: z.boolean(),
  interest: z.number().finite().min(0),
  ordinaryDividends: z.number().finite().min(0),
  otherOrdinary: z.number().finite(),
  taxExemptInterest: z.number().finite().min(0),
  ssPrimary: z.number().finite().min(0),
  ssSpouse: z.number().finite().min(0),
  conversion: z.number().finite().min(0),
  stockSold: z.number().finite().min(0),
  stockBasis: z.number().finite().min(0),
  qualifiedDividends: z.number().finite().min(0),
  pretaxBalance: z.number().finite().min(0).nullable(),
  spouseSoleBeneficiary: z.boolean(),
  acaHouseholdSize: z.number().int().min(1).max(20).nullable(),
  acaBenchmarkAnnual: z.number().finite().min(0).nullable(),
  stateRatePct: z.number().finite().min(0).max(100),
});
export type PlaygroundYearArgs = z.infer<typeof playgroundYearIn>;

/* Build the engine inputs from a validated runPlaygroundYear
   payload. The only transformations left are the filing-status
   spouse coercions (for a non-MFJ return the spouse fields are
   inert: age null, Social Security $0, not on Medicare) — those
   are status semantics, not clamps. The schema has already
   rejected every negative amount, so nothing is normalized
   here; the values pass through exactly as validated.
   Dividend dials are the Form 1040's own lines, typed exactly
   as printed: ordinaryDividends is line 3b (the TOTAL, which
   includes the qualified part) and qualifiedDividends is
   line 3a (a subset of 3b, not an amount on top of it); the
   pricer (pricePlaygroundYear) splits the total so dividends
   are counted once. */
export function playgroundInputsFromArgs(
  args: PlaygroundYearArgs,
): PlaygroundYearInputs {
  return {
    taxYear: args.taxYear,
    filingStatus: args.filingStatus,
    agePrimary: args.agePrimary,
    ageSpouse: args.filingStatus === "mfj" ? args.ageSpouse : null,
    onMedicarePrimary: args.onMedicarePrimary,
    onMedicareSpouse: args.filingStatus === "mfj" ? args.onMedicareSpouse : false,
    interest: args.interest,
    ordinaryDividends: args.ordinaryDividends,
    otherOrdinary: args.otherOrdinary,
    taxExemptInterest: args.taxExemptInterest,
    ssPrimary: args.ssPrimary,
    ssSpouse: args.filingStatus === "mfj" ? args.ssSpouse : 0,
    conversion: args.conversion,
    stockSold: args.stockSold,
    stockBasis: args.stockBasis,
    qualifiedDividends: args.qualifiedDividends,
    pretaxBalance: args.pretaxBalance,
    spouseSoleBeneficiary: args.spouseSoleBeneficiary,
    acaHouseholdSize: args.acaHouseholdSize,
    acaBenchmarkAnnual: args.acaBenchmarkAnnual,
    stateRatePct: args.stateRatePct,
  };
}

/* ---------------- Expected-return write field ----------------
   Round-5 fix 3: the expectedReturnPct field of both saved
   records (the Retirement record's retirementInputFields and
   the Roth record's rothInputFields in actions.ts), defined
   ONCE here so the fixtures pin the EXACT published schema.
   The bound: a return below −100% is refused at the save
   boundary — a balance cannot lose more than everything, and
   the engine's growth factor is floored at 0 besides, so a
   stored value under −100 could only ever price as a
   wipeout while claiming otherwise. −100 itself is valid:
   it prices a total wipeout, balances to $0. Null stays the
   blank (the caller's default applies), as on both records
   today. */
export const expectedReturnPctField = z.number().min(-100).nullable();

/* ---------------- Defaulted enum/kind write fields ----------------
   API follow-on 3, finding F17: the enum/kind fields on write
   inputs that carry a default. Each field schema is defined ONCE
   here and imported verbatim by actions.ts, so the fixtures pin
   the EXACT published field schema. The contract for every one
   of them: an ABSENT field takes the documented default (the
   live client relies on omission in places), and an unknown
   value — a typo like propertyKind "liabilty" — is REJECTED by
   the enum, never silently converted into the default. (Zod's
   .default only fills an absent value; it does not rescue an
   invalid one — the fixtures prove that against these objects.)
   The exhaustive sweep behind this list: every write action's
   request schema was checked for enum/kind fields carrying
   .default(...) or .optional().default(...); the only ones are
   the yearly-expense frequency (add + update) and the Net Worth
   account propertyKind (add) below. Every other enum/kind field
   in the registry (sourceType, txnKind, the split-bucket enum,
   drawOrder, solverEngine, spending unit, setYearlyExpenseVersion's
   frequency) is required or plain-optional and already rejects
   unknown values by construction. */

// The smoothed-bill frequencies, in the order describeApi and
// the client present them.
export const YEARLY_FREQUENCIES = [
  "yearly",
  "bimonthly",
  "quarterly",
  "semiannual",
] as const;
export const yearlyFrequency = z.enum(YEARLY_FREQUENCIES);
// addYearlyExpense / updateYearlyExpense: absent = "yearly".
export const yearlyFrequencyWithDefault = yearlyFrequency.default("yearly");

// Net Worth account property kinds (the values live in nwCore).
export const nwPropertyKind = z.enum(NW_PROPERTY_KINDS);
// addNwAccount: absent = "none" (an ordinary account).
export const nwPropertyKindWithDefault = nwPropertyKind
  .optional()
  .default("none");

/* ---------------- updateMonthlyBill request ----------------
   API follow-on 3, finding F18: the update request carries NO
   defaults for the optional fields. notes / category /
   keepLightsOn are optional-and-defaultless: absent means
   "preserve the stored value" (the handler writes only the
   fields actually sent, via monthlyBillUpdateSet in
   spendingCore), while an explicitly sent notes: null still
   clears the notes — the live bill form sends null for blank
   notes and always sends all five fields, so it behaves exactly
   as before. addMonthlyBill keeps its own defaults; this schema
   is the update's alone. */
export const updateMonthlyBillIn = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).max(120),
  paidBy: z.string().min(1).max(60),
  notes: z.string().max(300).nullable().optional(),
  category: z.string().min(1).max(60).optional(),
  keepLightsOn: z.boolean().optional(),
});
export type UpdateMonthlyBillArgs = z.infer<typeof updateMonthlyBillIn>;

/* Attach the priced spend-from-cash sleeve to a parsed
   effective-inputs echo (API follow-on 2, finding F16; R4-3,
   finding F7): the echo carries the engine's effective
   starting sleeve the run actually priced with. Callers pass
   that value derived by deriveSpendFromCashSleeveStartDollars
   (taxEngine) from the same resolved inputs the run priced
   with, so the echoed value is the priced sleeve in every
   mode — tiers-derived, pool-capped, or $0 when
   spendFromCashPct is blank / 0 — as integer cents, or null
   only when no derivation was possible. The sleeve is a
   transient, never a saved field, so this shaping lives only
   on compute echoes. */
export function withSleeveEcho<T extends object>(
  parsed: T,
  sleeveCents: number | null | undefined,
): T & { spendFromCashSleeveCents: number | null } {
  return { ...parsed, spendFromCashSleeveCents: sleeveCents ?? null };
}

/* ---------------- Hardening package (findings refresh 2026-10-19) ----------------
   The convention strings and shapings the hardening package
   publishes. Each follows the established pattern: the
   behaviour described is the shipped behaviour — these
   constants only make the contract state it — and the
   accuracy fixtures pin their required phrases so the text
   cannot silently drift. */

/* A-4: the score identities, in the field names the pricing
   responses carry. Verified against netCostBreakdown
   (rothOptimizer): netCost = tax + penalty + irmaa −
   acaCredit + terminal, the terminal split at the preserve
   floor (preserveExitRatePct inside it, heirRatePct on the
   excess), and endingAfterTaxWealth = the four ending
   balances minus terminal (the engine's own construction in
   taxEngine). NEGATIVE specimen: a synthetic fixture plan
   (MFJ, born 1975/1985, retire 57, $200,000 pre-tax / $800,000
   Roth / $1,000,000 taxable at a 100% basis, $60,000/yr
   spending, household of 5 stepping down to 2, family
   benchmark $32,000) priced through runRothCompare returned
   netCostCents -21041257. */
export const SCORE_IDENTITIES =
  "Score identities, in the field names the pricing responses carry: netCostCents = totalTaxCents + irmaaCents + penaltyCents + terminalCents − acaCreditCents, where totalTaxCents is lifetime federal plus state tax, and terminalCents is the exit tax on the ending pre-tax balance — the preserved portion (up to preservePretaxCents) priced at preserveExitRatePct, any excess at heirRatePct. The score can be NEGATIVE: when a plan's lifetime ACA premium credits exceed its lifetime taxes, the plan net-saves — an observed runRothCompare run on a synthetic fixture plan returned netCostCents of -21041257, a net gain, not an error. endingAfterTaxWealthCents = endingPretaxCents + endingRothCents + endingTaxableCents + endingHsaCents − terminalCents (the engine computes wealth from unrounded dollars and rounds once, so recomputing it from the published cents can differ by a cent).";

/* A-13: what lawYear means across a multi-decade plan (the
   audit's drafted sentence; the engine prices every plan year
   from the one CURRENT_LAW table, in real — today's-dollar —
   terms). */
export const LAW_YEAR_SEMANTICS =
  "lawYear names the single published law table every year of a plan prices under (today's law, in today's dollars); the engine does not switch law tables mid-plan. lawYearsAvailable lists every table the engine holds.";

/* Round-5 fix 1: unpaid tax. The behaviour this text
   describes is the shipped behaviour (taxEngine's settleYear
   debit chain and its two reprice-delta chains): every debit
   is capped at the balance it draws from, and the remainder
   after the last balance is reported, never discarded. */
export const UNPAID_TAX_SEMANTICS =
  "Unpaid tax: a year's priced tax bill is paid from surplus income cash first, then from the accounts in the engine's debit order (the payTaxFrom channel, conversion withholding, then debits from Taxable below the protect-minimum, Pre-tax, and Roth). Each debit takes at most the balance it draws from; if every balance is exhausted with part of the bill still owed, that remainder is the year's UNPAID TAX — reported per year as unpaidTax on the plan-year rows (runPlanYearDetail, dollars) and unpaidTaxCents on the funding rows (runRothFunding) and per scenario as the lifetime unpaidTaxCents (runRothCompare), never treated as paid: the assessed tax fields (federalTax / stateTax / penalty / irmaaPaid, and totalTaxCents in the compare) carry the full liability either way, the funding sources carry only amounts actually applied, and the funding identity foots as sources + spendShortfallCents + unpaidTaxCents = totalNeedCents. Unpaid tax is distinct from spendShortfall (unfunded SPENDING): a year can owe unpaid tax with its spending fully funded, whenever income it does not control (for example Social Security or pension income) is taxed after the accounts have run out. It is $0 in every year whose balances cover the bill.";

/* Security-hardening S1 (round-5 security review; Kyle ruled
   option C, 2026-10-19): the plaintext-backup authenticity
   line. The behaviour this text describes is the shipped
   behaviour (restoreCore's three-state key check + the
   restorebackup handler): the check was only ever a
   compatibility check, and the contract now says so in as
   many words, so no caller can mistake it for proof a file is
   genuine. The .mstbak statement is scoped to what its
   authenticated encryption actually provides — tamper
   evidence on decryption — not origin authentication. */
export const BACKUP_AUTHENTICITY_SEMANTICS =
  "Backup authenticity: exportbackup returns the complete dataset as a PLAINTEXT payload, and restorebackup replaces the entire dataset with a payload it is handed. A plaintext backup payload is NOT authenticated: nothing in it proves who made it or that its contents are unmodified since export. Its encryption key check is a COMPATIBILITY check only — it shows the payload was made under this app's encryption key, so the values it carries will decrypt here; it is not a signature or a MAC, it says nothing about the file's contents, and a payload carrying no key check at all is likewise accepted as compatible. Only restore a plaintext backup from a source you trust, and state plainly before restoring that the file is not authenticated and confirm with the user — restoring replaces everything. Encrypted backup files (backup-*.mstbak, created by createBackupNow) are integrity-protected by their authenticated encryption: a modified .mstbak fails decryption instead of restoring altered figures.";

/* A-14: the basis-tier rules as one statement (the schema's
   superRefine enforces the sum; the engine consumes tiers
   highest-basis first and prices the pool from the tiers
   alone when they are present — taxableBasisPct applies only
   to the single-pool shape). */
export const TIER_SEMANTICS =
  "taxableTiers: up to six slices of the taxable pool; sharePct values must sum to 100 (±0.01); sales consume the slices highest-basis first; when tiers are present they replace taxableBasisPct.";

/* A-7: the units convention, extended with the non-money
   units (the pre-existing text moves here verbatim from the
   describeApi handler so the fixtures can pin it, exactly
   like BALANCE_SEMANTICS). */
export const UNITS_SEMANTICS =
  "Money fields whose names end in Cents are integer cents (e.g. pretaxCents, netCostCents). Optimizer-family responses (runRothOptimizer, runRothMonteCarloCheck, runWorkYearsCompare, runRothGiftCompare) and the Playground / plan-year responses (runPlaygroundYear, runPlanYearDetail) report money in DOLLARS, as the tax engine computes it. runRothCompare and runRothMonteCarloStats are the exceptions among the pricing actions: their per-scenario figures are integer cents, as their *Cents names say. Each action's own schema is authoritative where a name is ambiguous. Compute effectiveInputs echoes also carry spendFromCashSleeveCents (integer cents) — the engine's effective starting spend-from-cash sleeve the run priced with, a resolved value, never a saved field: with basis tiers it is the first 100%-basis tier's balance; in the single pool it is the threaded sleeve size capped at the pool; and it is $0 whenever spendFromCashPct is blank or 0. Fields ending in Pct are percentage points (5.75 means 5.75%, not 0.0575). Ages are whole years of age; fields ending in Year are calendar years; household sizes are person counts.";

/* A-11: the writers/readers rule, extended with the
   validation-error shape (the pre-existing text moves here
   verbatim from the describeApi handler). The specimen is
   the refresh's N-2 observation: getRetirementBaselineResults
   called with {} returns the raw zod issue array. */
export const WRITERS_READERS_RULE =
  "Writers strict, readers lenient: the writer actions (saveRothInputs, saveRothScenario) persist complete records and require every field of the record they save, while the read-only compute actions accept a payload that omits the draw-order switch fields (drawOrderSwitchAge, drawOrderAfter) — an omitted switch field prices exactly as null (no switch) — or the ceilings key acaCliffCapFamilyOnly, which prices exactly as false. Separately, by explicit approval, the eight compute actions (runRothOptimizer, runRothCompare, runPlanYearDetail, runRothFunding, runRothMonteCarloCheck, runRothMonteCarloStats, runWorkYearsCompare, runRothGiftCompare) reject unknown request keys — at the top level, inside ceilings objects, inside runRothCompare and runRothMonteCarloStats scenario items and their overrides, and inside runRothMonteCarloCheck's winner/doNothing objects — so a misspelled key fails validation instead of silently pricing without it. All other actions strip unknown keys as zod objects do by default. Validation failures return every issue at once, as an array of issue objects in the validator's raw shape — each issue carries path, code, expected, and message fields (for example, calling getRetirementBaselineResults with {} returns issues reporting 'expected number, received undefined' for the missing keys). A field whose schema is nullable accepts an explicit null: that same 'received undefined' message on a nullable field means the key itself is required — pass null, not 0, for a blank.";

/* A-6: ceilings replacement, stated once and appended to
   both runRothCompare's and runRothMonteCarloStats'
   purposes (the audit's drafted sentence). */
export const CEILINGS_REPLACEMENT_SENTENCE =
  "A scenario's ceilings object replaces the base ceilings wholesale — it does not merge; inside it, acaCliffCapFamilyOnly may be omitted and prices as false.";

/* A-10: the fetch→save flattening map, appended to
   saveRothInputs' purpose (verified against the action's
   request composition: rothInputFields + execution fields +
   mcCheck field + gift fields + baseRevision, all top
   level; getRothPlanner returns those as the saved /
   execution / mcCheck / gift blocks plus the top-level
   revision). */
export const SAVE_FLATTENING_SENTENCE =
  "The request is getRothPlanner's response flattened: the saved block's fields, then the execution and gift blocks' fields, all at top level; mcCheck.mcVolatilityPct is sent as mcVolatilityPct; the record's revision is sent as baseRevision.";

/* A-12(a): the near-name distinction, appended to
   saveRothInputs' purpose. Both are persisted field names,
   so prose is the fix — a rename would be a migration. */
export const CONVERTED_ALREADY_DISTINCTION_SENTENCE =
  "convertedAlreadyCents seeds the plan's first year; executionAlreadyConvertedCents is the This Year block's year-to-date figure for the current execution year — different fields, never copied from each other.";

/* A-2: the compare echo's balance resolution. A scenario's
   merged saved shape carries an override's explicit null
   verbatim, and parseRothInputs echoes it raw — but at the
   override layer null is an affirmative $0 instruction, so
   the echo must show the value that PRICED (0), exactly as
   base-layer nulls echo their snapshot-resolved values.
   Applied to the parsed echo with the merged shape beside
   it: an override null resolves to 0; a merged number the
   parse somehow left blank is restored; anything else is
   untouched. Pricing never reads the echo, so no priced
   figure can move. */
export const ROTH_BALANCE_KEYS = [
  "pretaxCents",
  "pretaxSpouseCents",
  "rothCents",
  "taxableCents",
  "hsaCents",
] as const;
export function withResolvedOverrideBalances<T extends object>(
  parsed: T,
  merged: Partial<
    Record<(typeof ROTH_BALANCE_KEYS)[number], number | null | undefined>
  >,
): T {
  const out: Record<string, unknown> = {
    ...(parsed as Record<string, unknown>),
  };
  for (const k of ROTH_BALANCE_KEYS) {
    if (merged[k] === null) out[k] = 0;
    else if (out[k] == null && typeof merged[k] === "number") out[k] = merged[k];
  }
  return out as T;
}

/* A-5(b): ONE worked runRothCompare example, published by
   describeApi. The base is the seeded fresh-user plan shape
   (seedRothInputs) with EXPLICIT balances, so the request is
   complete and self-contained — it prices identically on any
   install, with no snapshot involved. The response figures
   are the engine's actual output for this exact request at
   start year 2026, pinned by the api-compare-example-executes
   fixture, which re-executes the request against
   runRothCompare on every suite run: if the engine's pricing
   ever moves them, the fixture fails and the example is
   re-derived, so the published example can never rot. The
   live action prices with the current calendar year as its
   start year, so a live call in a later year can differ
   where a year boundary moves a figure. */
const ROTH_COMPARE_EXAMPLE_BASE = {
  ...seedRothInputs({
    annualSpendingCents: 15000000,
    retirementAge: 57,
    expectedReturnPct: 5.75,
  }),
  pretaxCents: 180000000,
  pretaxSpouseCents: 15000000,
  rothCents: 55000000,
  taxableCents: 230000000,
  hsaCents: 11000000,
};
export const ROTH_COMPARE_EXAMPLE = {
  action: "runRothCompare",
  note: "A complete, valid runRothCompare request and the response it prices. The base plan is the seeded fresh-user plan shape with explicit balances (a saved record's balances are usually null, which follows the Net Worth snapshot instead). Response figures are the engine's output for this exact request at start year 2026, re-verified by the accuracy fixtures on every run.",
  request: {
    ...ROTH_COMPARE_EXAMPLE_BASE,
    baselineName: "Seeded plan as-is",
    scenarios: [
      { name: "Seeded plan as-is", overrides: {} },
      { name: "Retire at 56", overrides: { retirementAge: 56 } },
    ],
  },
  response: {
    ok: true,
    baselineName: "Seeded plan as-is",
    scenarios: [
      {
        name: "Seeded plan as-is",
        strategyDescription:
          "Retire at 57 · Fill to the top of the 12% bracket · Convert ages 57–74 · Draw order Taxable → Pre-tax → Roth",
        netCostCents: 194504904,
        totalTaxCents: 108376285,
        penaltyCents: 0,
        irmaaCents: 6693120,
        acaCreditCents: 0,
        terminalCents: 79435499,
        ssCollectedCents: 139200000,
        unpaidTaxCents: 0,
        endingPretaxCents: 330981245,
        endingRothCents: 1924336965,
        endingTaxableCents: 1601394776,
        endingHsaCents: 136147480,
        endingAfterTaxWealthCents: 3913424968,
        deltaNetCostCents: 0,
        deltaAcaCreditCents: 0,
      },
      {
        name: "Retire at 56",
        strategyDescription:
          "Retire at 56 · Fill to the top of the 12% bracket · Convert ages 57–74 · Draw order Taxable → Pre-tax → Roth",
        netCostCents: 194504904,
        totalTaxCents: 108376285,
        penaltyCents: 0,
        irmaaCents: 6693120,
        acaCreditCents: 0,
        terminalCents: 79435499,
        ssCollectedCents: 139200000,
        unpaidTaxCents: 0,
        endingPretaxCents: 330981245,
        endingRothCents: 1924336965,
        endingTaxableCents: 1461014433,
        endingHsaCents: 136147480,
        endingAfterTaxWealthCents: 3773044624,
        deltaNetCostCents: 0,
        deltaAcaCreditCents: 0,
      },
    ],
  },
};
