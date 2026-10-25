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

/* Round-7 fix R7-3 (defect K-2/A-1): bracketTopPct input
   integrity. The only bracket tops a ceiling may name are the
   seven federal ordinary rates the law tables carry. Before
   this fix any number validated, and an unsupported value
   (13, 22.5) priced as NO ceiling at all — the cap lookup
   missed the rate table and the fill ran unbounded while the
   label still claimed a bracket top. This field schema is the
   ONE definition every public path that accepts ceilings
   uses (the writers' shared ceilings object, the strict
   compute ceilings, scenario overrides, and the Monte Carlo
   check score below): null stays valid (no fill), each
   supported rate is accepted, and anything else is rejected
   with a validation error naming the supported values. */
export const SUPPORTED_BRACKET_TOP_PCTS = [10, 12, 22, 24, 32, 35, 37] as const;
export const bracketTopPctField = z
  .number()
  .nullable()
  .refine(
    (v) =>
      v == null ||
      (SUPPORTED_BRACKET_TOP_PCTS as readonly number[]).includes(v),
    {
      message:
        "bracketTopPct must be one of the supported federal bracket rates (10, 12, 22, 24, 32, 35, 37) or null (no fill).",
    },
  );

/* Round-7 fix R7-5 (item K-1): the IRMAA tier-cap semantics
   the contract publishes. The behaviour this text describes
   is the shipped behaviour — the fill sizer (fillConversion),
   the settlement compliance checker (respectsCeilings), and
   the harvest predicate all measure MAGI against the same
   irmaaTierUpTo boundary — this constant only makes the
   contract state it. */
export const IRMAA_TIER_CAP_SEMANTICS =
  "irmaaTierCap N means the year's MAGI must not exceed the TOP of IRMAA tier N for the filing status and law year (2026 MFJ: tier 0 → $218,000, tier 1 → $274,000, tier 2 → $342,000, tier 3 → $410,000, tier 4 → $749,999 MFJ / $499,999 single, tier 5 → no cap). The conversion sizer targets that same MAGI ceiling the compliance checker measures, accounting for the settlement's gains feedback, so a capped year's priced MAGI lands at or under the tier top whenever a conversion at or above $0 can achieve it.";

/* Build E: the IRMAA lookback-status semantics the contract
   publishes. The behaviour this text describes is the
   shipped behaviour (the lookback record in
   simulateRothPlan, taxEngine.ts, and the work-year seed
   rollWorkYears builds in workYears.ts) — this constant
   only makes the contract state it, including the SSA-44
   scope limit. */
export const IRMAA_LOOKBACK_SEMANTICS =
  "IRMAA lookback (Medicare income-related monthly adjustment amounts): a premium year's IRMAA tier and surcharge are determined from the tax return filed two years earlier — the premium year's MAGI plays no part in its own surcharge — using the filing status on THAT return, not the premium year's filing status (SSA POMS HI 01101.010 and HI 01101.020; 20 CFR 418.1135). The plan march records every priced year's MAGI together with the filing status that year was priced under, and a premium year's tier is read from the tier table for the LOOKBACK year's recorded status, at the premium year's law row (the tier amounts and premium amounts remain the premium year's). The consequence that matters: after a spouse's death, the two premium years whose lookback returns were filed jointly are still graded on the joint table — a $400,000 joint return is tier 3 on the joint table even when the premium year is a survivor year filed single (on the single table the same MAGI would be tier 4) — and only premium years whose lookback return was itself filed single are graded on the single table. Plan-year rows surface the lookback each premium year was graded on (paidSourceYear, paidSourceMagi, and paidSourceFilingStatus on the year detail's irmaa block). WORK YEARS: the work years priced before a plan's retirement march starts (the salary years of the work-years roll, and any pre-retirement years the march itself prices) are recorded in the same lookback record with their own priced MAGI and filing status, so a household retiring near 65 has real work-year lookbacks for its first premium years — a rolled plan whose march starts at the quit age carries those work years as its lookback seed (irmaaLookbackSeed on the engine inputs, built by the roll from its own priced lines), and a premium year with no recorded lookback at all (its source year predates every priced year and no seed covers it) prices $0 of IRMAA with a null paid tier, as before. SCOPE — SSA-44 REDETERMINATION NOT MODELED: the engine prices SSA's DEFAULT determination from the lookback return. SSA permits a beneficiary whose income has fallen after a life-changing event — a spouse's death among them — to request a new determination on more recent income (Form SSA-44), which can lower or eliminate a survivor's surcharge sooner than the two-year lookback rolls past the joint returns; that redetermination is NOT modeled, no input requests it, and no priced figure assumes it will be granted, so a survivor plan's IRMAA in the first two premium years after a death is the default-determination figure, potentially higher than what an approved SSA-44 would charge.";

/* Round-7 fix R7-4 (defect 2.2): the ceiling-breached
   indicator. The behaviour this text describes is the
   shipped behaviour (taxEngine's settlement: after the
   re-solve loop, a final clamp bisects the conversion
   against the final priced figures until the year complies
   or the conversion reaches $0; a breach that remains at
   conversion $0 is disclosed, never silently shipped). */
export const CEILING_BREACHED_SEMANTICS =
  "Ceiling breached (ceilingBreached): when a plan year carries a switched-on ceiling (a bracket fill, the 0% capital-gains space, an IRMAA tier cap, a custom MAGI cap, or the ACA cliff cap) and the year's FINAL priced figures still exceed that ceiling after the settlement has reduced the year's conversion as far as $0, the year is flagged: ceilingBreached is true on the plan-year rows (runPlanYearDetail) and on the funding rows (runRothFunding), both booleans. A flagged year means the breach comes from income the conversion cannot control — the year's draws, RMD, or other mandatory income alone exceed the ceiling — not from the fill. Years with no ceiling switched on, and years whose final figures respect every switched-on ceiling, carry ceilingBreached false. settlementConverged is a different statement: it reports only that the settlement iteration reached an exact fixed point, and is never a claim of ceiling compliance — a year can be settlementConverged and ceilingBreached at once.";

/* ---------------- ACA household schedule ----------------
   The saved-shape field for the household schedule (MULTI-STEP
   ACA HOUSEHOLD SCHEDULE build): an ordered list of steps,
   each { fromYear, householdSize } — from fromYear on, the
   ACA household size is that step's size, until a later step
   replaces it. Defined ONCE here, like bracketTopPctField
   and rothBalanceField, and referenced by rothInputFields
   in actions.ts (and, in its own lenient form, by the
   UI-state lab dials), so the fixtures pin the EXACT schema
   the writers enforce: integer years 1900–2200, integer
   sizes 1–20 (generic person counts), at most 40 steps,
   years strictly increasing (one size per year, in order).
   Null = no steps: the plan's acaHouseholdSize governs
   every year. The field REPLACES the old pair
   (acaStepDownYear / acaHouseholdSizeAfter): writers no
   longer accept or write the pair, and a stored record that
   still carries it is migrated by the readers — see
   ACA_HOUSEHOLD_SCHEDULE_SEMANTICS below. */
export const acaHouseholdStepField = z.object({
  fromYear: z.number().int().min(1900).max(2200),
  householdSize: z.number().int().min(1).max(20),
});
export const acaHouseholdScheduleField = z
  .array(acaHouseholdStepField)
  .max(40)
  .nullable()
  .superRefine((steps, ctx) => {
    if (steps == null) return;
    for (let i = 1; i < steps.length; i++) {
      const prev = steps[i - 1];
      const cur = steps[i];
      if (prev != null && cur != null && cur.fromYear <= prev.fromYear) {
        ctx.addIssue({
          code: "custom",
          message:
            "acaHouseholdSchedule step years must be strictly increasing — one household size per year, in year order.",
        });
        return;
      }
    }
  });

/* The household-schedule convention describeApi publishes
   (MULTI-STEP ACA HOUSEHOLD SCHEDULE build). The behaviour
   this text describes is the shipped behaviour
   (acaHouseholdSizeForYear / resolveAcaHouseholdSchedule in
   taxEngine.ts and the march in simulateRothPlan) — this
   constant only makes the contract state it. */
export const ACA_HOUSEHOLD_SCHEDULE_SEMANTICS =
  "ACA household schedule (acaHouseholdSchedule on the Roth inputs): an ordered list of steps, each {fromYear, householdSize}, that replaces the single step-down the plan inputs carried before this contract version (acaStepDownYear + acaHouseholdSizeAfter — both keys are gone from the saved shape, the compute payloads, and scenario overrides). WHICH SIZE GOVERNS A YEAR: the household size for a plan year is the householdSize of the LAST step whose fromYear is at or before that year; years before the first step — and every year when the schedule is null or empty — are governed by the plan's acaHouseholdSize. A survivor year is still a household of 1, as before. The governing size drives that year's 400%-of-poverty-line ACA cliff (4 × the federal poverty guideline for the governing size) and its applicable-percentage math. BENCHMARK SELECTION PER SIZE: the benchmark premium still keys on WHO is on the marketplace that year, not on size alone — when both spouses are on the marketplace the family benchmark applies only in a year whose governing size is 3 or more and a family figure is entered, and the couple figure prices the year otherwise (including every both-on year whose governing size has stepped to 2); a year with only one spouse on the marketplace prices the one-spouse figure at any governing size; household size never selects the benchmark by itself. CLIFF-CAP FAMILY-ONLY BEHAVIOR ACROSS STEPS: the era-aware cliff cap (ceilings.acaCliffCap with acaCliffCapFamilyOnly) defends the cliff only in years governed by the INITIAL size — the years before the schedule's FIRST step year. From the first step year on, the cap (and with it the cliff safety buffer, which applies in exactly the years the cap does) is off for the year, through every later step however many there are; the ACA credit itself is never gated — it is priced on the year's governing size and actual ACA MAGI in step years exactly as in initial-size years. Steps are generic: fromYear is a calendar year 1900–2200, householdSize a person count 1–20, step years strictly increasing, at most 40 steps; a step may raise the size as well as lower it, and a step dated after the plan's last year (or before its first) simply never governs (or always governs) — both price without error. MIGRATION: a saved record written before this build, carrying acaStepDownYear / acaHouseholdSizeAfter and no schedule, reads as the one-entry schedule [{fromYear: acaStepDownYear, householdSize: acaHouseholdSizeAfter}] (the after size falling back to acaHouseholdSize, then to 1, exactly as the old passthrough read it) beside its unchanged acaHouseholdSize, and prices bit-identically to the old pair in every year — same governing sizes, same first step year for the cliff-cap gate; the first save under this build writes the schedule and drops the old keys. A record with neither a schedule nor a step-down year has no steps, as before. COMPARE CANONICALIZATION (Prompt 14 build): when a compare scenario is built (buildCompareScenario, behind runRothCompare and the Monte Carlo stats), the BASE shape is canonicalized before the scenario's overrides merge over it — its schedule is resolved once (the migration synthesis above, for a base still carrying the legacy pair) and the resolved schedule is written back onto the base copy, with the legacy pair deleted. A scenario whose overrides do not mention the schedule therefore prices bit-identically to before, while an override that explicitly sets acaHouseholdSchedule to null (or an empty list) TRULY CLEARS the steps: no legacy pair survives on the canonical base for the resolver to fall through to. (Before this build the un-canonicalized merge let a clearing override be silently undone by the legacy pair on a raw, unmigrated base; the app's record path migrates records before compare, so no saved record ever priced that way.) The built scenario's returned saved shape is the canonicalized merged shape.";

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
    bracketTopPct: bracketTopPctField,
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
  // State of residence (T3 build): OPTIONAL so payloads from
  // before this build keep validating — absent prices the
  // flat stateRatePct exactly as before. "WA" prices
  // Washington's capital-gains excise instead of the flat
  // rate; "other" is the explicit flat-rate choice.
  residenceState: z.enum(["WA", "other"]).optional(),
  // Itemized deductions (T5 build): OPTIONAL so payloads
  // from before this build keep validating — absent prices
  // the standard deduction exactly as before. The four
  // components (dollars) price through the shared
  // greater-of rule; negative amounts fail validation like
  // every other money dial here.
  itemizedMortgageInterest: z.number().finite().min(0).optional(),
  itemizedSaltPaid: z.number().finite().min(0).optional(),
  itemizedCharitable: z.number().finite().min(0).optional(),
  itemizedOther: z.number().finite().min(0).optional(),
  // Education students (T6 build): OPTIONAL so payloads
  // from before this build keep validating — absent prices
  // no credits exactly as before. Each entry is one of the
  // year's students: qualified expenses in dollars
  // (negative fails validation like every other money dial
  // here) and the household's AOTC-eligibility mark.
  educationStudents: z
    .array(
      z.object({
        expenses: z.number().finite().min(0),
        aotcEligible: z.boolean(),
      }),
    )
    .max(12)
    .optional(),
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
   are counted once — nonQualifiedDividends = max(0,
   ordinaryDividends − qualifiedDividends), the derivation
   the playgroundYearSemantics convention describeApi
   publishes (see PLAYGROUND_YEAR_SEMANTICS below). */
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
    residenceState: args.residenceState ?? null,
    itemizedMortgageInterest: args.itemizedMortgageInterest,
    itemizedSaltPaid: args.itemizedSaltPaid,
    itemizedCharitable: args.itemizedCharitable,
    itemizedOther: args.itemizedOther,
    // Education students (T6): carried verbatim; absent =
    // no students, so the year prices exactly as before.
    educationStudents: args.educationStudents ?? null,
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
  "Score identities, in the field names the pricing responses carry: netCostCents = totalTaxCents + irmaaCents + penaltyCents + terminalCents − acaCreditCents − educationRefundableCents, where totalTaxCents is lifetime federal plus state tax, educationRefundableCents is the lifetime refundable education credit (the refundable AOTC portion, §25A(i)) credited beside the ACA premium credit, and terminalCents is the exit tax on the ending pre-tax balance — the preserved portion (up to preservePretaxCents) priced at preserveExitRatePct, any excess at heirRatePct. AMT is inside federalTax and never added on top: each year's federalTax is its regular income tax after nonrefundable credits plus its NIIT plus any AMT owed, so the AMT sits inside totalTax (and totalTaxCents) already and the lifetime and scenario AMT figures name that component only. The NIIT likewise sits inside federalTax — it is a component of the year's federalTax and therefore of totalTax, never a separate add-on beside them. For a plan with salary years (priced through runWorkYearsCompare, whose money is in dollars), the same identity holds on the all-in figures: allInTax = totalTax + penalty + irmaa − acaCredit − educationRefundable + terminal, where totalTax folds in the work years' own federal tax, state tax, and employee payroll tax — payroll tax is its own component of totalTax (the payrollTax field on the compare rows and in the work-years ledger, with its Social Security, Medicare, and Additional Medicare parts), priced from each salary year's own law table (that year's wage base, rates, and Additional Medicare threshold); the employer share of payroll tax is not priced. A plan with no salary years carries payrollTax of $0 and prices exactly as before. The score can be NEGATIVE: when a plan's lifetime ACA premium credits exceed its lifetime taxes, the plan net-saves — an observed runRothCompare run on a synthetic fixture plan returned netCostCents of -21041257, a net gain, not an error. endingAfterTaxWealthCents = endingPretaxCents + endingRothCents + endingTaxableCents + endingHsaCents − terminalCents (the engine computes wealth from unrounded dollars and rounds once, so recomputing it from the published cents can differ by a cent).";

/* A-13: what lawYear means across a multi-decade plan, as
   rewritten by the T1 build (per-calendar-year law tables):
   the engine prices each plan year under that year's own
   table, carrying the newest table forward past the end of
   the published table, and the statutorily unindexed
   thresholds deflate from the table's own year — the rule a
   cold reader needs to price a future year by hand. */
/* T3: the state-tax semantics. The behaviour this text
   describes is the shipped behaviour (priceYear's state
   branch and waCapitalGainsTax in taxEngine.ts): state tax
   stays its own component of every year's tax and of the
   score identity either way — only what prices it changes
   with the residence field. */
export const STATE_SEMANTICS =
  "State tax: the plan's state of residence (residenceState on the Roth inputs; the Playground prices it per year) decides how the stateTax component is priced, and stateTax remains its own component of each year's tax and of the score identity either way. With no residence chosen (absent / null) or residenceState 'other', the state tax is the flat stateRatePct applied to the year's federal taxable income, exactly as before this build. With residenceState 'WA', Washington's capital-gains excise (RCW 82.87) prices the state tax INSTEAD of the flat rate — the two never stack, and the flat rate is ignored for a Washington year. The excise applies only to the year's Washington-allocated long-term capital gains: in this engine, the realized long-term gains from taxable-account sales (a plan year's detail.ltcg; a Playground year's stock gain). Qualified dividends are not capital gains and never enter the base; retirement-account distributions (RMDs, conversions, pre-tax draws) and Social Security never enter it either — assets held in retirement accounts are exempt under RCW 82.87.050. The year's own law table carries the excise parameters: a 7% rate on taxable Washington capital gains, plus 2.9% on the portion of taxable Washington capital gains above $1,000,000 (the threshold is statutory and unindexed, stated in nominal dollars in every year — the Washington $1,000,000 surtax threshold does NOT deflate: it stays at $1,000,000 in every priced year, unlike the unindexed federal thresholds named in lawYearSemantics, which do deflate), after the year's standard deduction ($278,000 in the 2025 and 2026 tables — the 2026 table carries the 2025 amount forward because the Department of Revenue had not published a 2026 amount when the table was sourced) and after the charitable donation deduction of RCW 82.87.080 (donations to qualified organizations above the year's threshold, capped; the donations figure is the household's ONE charitable input — the same figure that is the charitable component of the federal itemized deductions (see the itemizedDeductionSemantics convention) — so the deduction prices in plan years and Playground years alike whenever that input is entered, and is $0 when it is not). A year whose gains are at or below the standard deduction prices $0 of state tax; a net capital loss year prices $0 and carries nothing forward (RCW 82.87.040(3)). Plan-year rows surface the priced excise's components as waGains, waStandardDeduction, and waTaxableGains; the Playground result carries waGains, waStandardDeduction, and waTaxableGains likewise. Washington is the only state with a rules layer; every other state prices through the flat rate.";

/* T4: the capital-loss carryforward semantics. The
   behaviour this text describes is the shipped behaviour
   (applyLossLedger + the ledger wiring in simulateRothPlan,
   taxEngine.ts): the ledger is a plan-level mechanism — the
   single-year Playground is untouched by it and keeps its
   in-year §1211(b) pricing. */
export const LOSS_CARRYFORWARD_SEMANTICS =
  "Capital-loss carryforward: plan pricing carries a capital-loss carryforward ledger across the plan's years (IRC §§1211(b) / 1212). A year's net capital loss first offsets that year's capital gains, then up to $3,000 of it ($1,500 if married filing separately, a filing status this engine does not price) offsets ordinary income for the year, and the remainder carries into the next year with its character preserved. The allowance is claimed on the year's return in full — the year's AGI and tax price exactly as if every allowance dollar were used — but the carryforward is consumed only by the part of the allowance that actually offset the year's taxable income (the Capital Loss Carryover Worksheet's utilization limit: the allowance capped at the year's taxable income computed without the allowance, reconciled against the year's final priced taxable income). The unused part is not consumed and carries into the next year with the rest, the used part still taken short-term first: a year with no taxable income for the allowance to offset consumes none of it, however many such years run in a row, and a year that absorbs only part of the allowance consumes exactly that part. Short-term and long-term losses are tracked separately and consumed in the statutory (Capital Loss Carryover Worksheet) order: a long-term carryover nets inside the long-term column first, a short-term carryover then nets against a surviving net long-term gain, and the year's $3,000 allowance is taken from the short-term remainder before the long-term remainder. The plan inputs capitalLossCarryInStCents / capitalLossCarryInLtCents state the household's banked losses entering the plan's first year (integer cents, losses stated as positive amounts; blank / absent = $0 = no banked loss, and the plan prices exactly as before this build). Later years' gains absorb the carryforward like any gains — including gains a strategy's gain harvest realizes — and in a year whose net capital result is still a loss the priced allowance also reduces the year's §1411 NIIT base, the same allowable-loss rule the single-year pricer already applies. Qualified dividends are never netted against a loss or a carryforward; they price whole in every year. A carryforward is a tax attribute, not a balance: it never touches an account balance, the taxable pool's basis, or ending wealth, and an unused balance at the plan's end simply expires. Washington's capital-gains excise takes no carryforward: it prices on the year's own realized long-term gains before any federal netting (a Washington loss year carries nothing, RCW 82.87.040(3)). Plan-year rows surface the ledger per year (lossCarryInSt / lossCarryInLt entering, lossAbsorbed consumed against the year's gains, lossAllowance priced, lossCarryOutSt / lossCarryOutLt leaving; the funding rows carry the same figures in integer cents). The single-year Playground has no ledger: it prices its typed year in-year only, exactly as before.";

/* T5: the itemized-vs-standard deduction semantics. The
   behaviour this text describes is the shipped behaviour
   (priceYear's deduction step in taxEngine.ts): the
   greater-of rule in one place, shared by every pricing
   surface, with the SALT cap carried as dated law-row data
   (taxLaw.ts) rather than engine constants. */
export const ITEMIZED_DEDUCTION_SEMANTICS =
  "Itemized deductions: a plan may enter four itemized components — itemizedMortgageInterestCents (mortgage interest), itemizedSaltPaidCents (state and local taxes paid), itemizedCharitableCents (charitable contributions), and itemizedOtherCents (other itemized deductions), all integer cents; the Playground prices the same four components per year in dollars. Every component is optional: blank / absent = $0, and with no components entered the itemized total is $0 and every year prices exactly as before this build. Each priced year takes the GREATER of (a) its standard deduction — the year's law-table amount for the filing status plus the age-65+ additional amounts for each person aged 65+ on the return (the add-ons belong to the standard side only) — and (b) the itemized total, the sum of the four components with the state-and-local-taxes component first capped at that year's SALT cap. The SALT cap is dated law-table data (IRC §164(b)(7), as amended by §70120 of Public Law 119-21), consulted by the pricer BY CALENDAR YEAR from the enacted schedule — never a single hard-coded figure across years, and never the newest law row's figure carried forward. The schedule is enacted law, stated in full: the applicable limitation is $40,000 for 2025, $40,400 for 2026, $40,804 for 2027, $41,212.04 for 2028, and $41,624.16 for 2029 (the statute applies 101% of the prior year's amount successively, producing those cents), and for taxable years beginning after 2029 the limitation is $10,000, flat and permanently — no year after 2029 ever falls back to a higher cap. The limitation is the same for every filing status this engine prices; married filing separately takes half (a status this engine does not price). The cap phases down for high incomes exactly as the statute writes it, before 2030 only: reduced by 30% of the year's modified AGI above that year's phase-down threshold — $500,000 for 2025, $505,000 for 2026, $510,050 for 2027, $515,150.50 for 2028, and $520,302.01 for 2029 (the same successive 101% escalation) — never below the $10,000 floor; from 2030 the limitation is $10,000 with no phase-down, so it is $10,000 at any income. Modified AGI for this purpose is AGI (the statute adds back only foreign-income exclusions the engine does not model, and tax-exempt interest is not added back). The cap's dollar figures are statutory, not inflation-indexed, so under the engine's today's-dollars convention they deflate at the plan's inflation rate for each year the priced year runs past the schedule entry it prices under — in an entry's own year they apply exactly as enacted, and the post-2029 entry is dated 2030. The components stay separate at every layer — never one lump — so the SALT dollars remain identifiable (the cap applies to them alone, and the itemizedSaltAllowed figure on the year outputs is the SALT amount after the cap). The temporary senior deduction (2025–2028) is NOT part of either side of the comparison: it is added on top of whichever side wins, because §224 allows it whether or not the filer itemizes. The state and local taxes the engine itself prices (the T3 state layer) are never re-entered here — the SALT component is taxes PAID, as the household knows them. There is exactly ONE charitable input: itemizedCharitableCents is a component of the federal itemized total AND the donations figure the Washington charitable deduction (RCW 82.87.080) prices from — no second charitable figure exists. Plan-year rows and funding rows surface the year's itemizedDeduction (the capped itemized total; integer cents on the funding rows) and deductionTaken ('standard' or 'itemized' — 'standard' on a tie), and the Playground result carries itemizedDeduction, itemizedSaltAllowed, and deductionTaken likewise, so every priced year shows which deduction won and by how much. 2026 DEDUCTION TRIO (Public Law 119-21, tax years beginning after December 31, 2025 — law years 2026 and later ONLY; a year priced under the 2025 law row takes none of the three and prices exactly as before): (1) Charitable floor for itemizers (IRC §170(b)(1)(I)): the charitable component of the itemized total is the entered charitable input reduced by 0.5% of the contribution base — the year's AGI (the engine models no net-operating-loss carryback) — floored at $0. The floor applies to the engine's single aggregate charitable input; floor-disallowed amounts do NOT carry forward. The allowed amount is surfaced as itemizedCharitableAllowed on the year outputs (integer cents as itemizedCharitableAllowedCents on the funding rows). CHARITABLE PERCENTAGE CEILING (IRC §170(b)(1)(G); engine-audit round-2 Finding 4 fix — NOT part of the 2026 trio: the 60% cash limit is in effect for every law year this engine holds, so the ceiling applies in every priced year, including a year priced under the 2025 law row): the charitable component of the itemized total may not exceed 60% of the contribution base — the year's AGI (the engine models no net-operating-loss carryback). The engine's single aggregate charitable input carries no cash/property split and is treated throughout as cash contributions to public charities, so the 60% cash ceiling applies to the whole input. ORDERING: the §170(b)(1)(I) floor is applied to the entered input FIRST and the 60% ceiling then caps the after-floor amount, so the final charitable component never exceeds 60% of AGI (on the audit's case — 2026 MFJ, AGI $100,000, $80,000 of cash giving — the floor leaves $79,500 and the ceiling caps the component at $60,000; the pre-fix engine allowed the full $79,500). The excess over the ceiling is NOT deducted in the year and does NOT carry forward: the engine keeps no §170(d)(1) five-year carryforward ledger (floor-disallowed amounts likewise do not carry), so the ceiling errs conservative — it can overstate a later year's tax, never understate the current year's. The §68 limitation still applies AFTER the ceiling, as after every other limitation. The ceiling applies ONLY to the itemized charitable component: the §170(p) non-itemizer deduction keeps its own per-status caps, and the Washington excise's charitable deduction keeps pricing from the raw charitable input exactly as before. (2) The §68 limitation, applied AFTER all other limitations (the SALT cap, the charitable floor and ceilings, and the mortgage rules; home mortgage interest is NOT exempt — the 2025 amendment removed the old carve-outs): the otherwise-allowable itemized total is reduced by 2/37 of the lesser of (a) the itemized total or (b) the amount by which (taxable income determined without regard to §68, increased by the itemized total) exceeds the dollar threshold where the 37% bracket begins for the filing status and law year — read from the year's law row (the top of its 35% bracket; $768,700 for married filing jointly in 2026). The reduction is surfaced as section68Reduction (section68ReductionCents on the funding rows), and the REDUCED itemized total is the itemizedDeduction that competes against the standard side. The AMT tentative computation keeps using the unreduced figures: in an itemized year AMTI is priced from the taxable income determined without regard to §68. (3) The non-itemizer charitable deduction (IRC §170(p)): when the standard side wins, the year's charitable input is ALSO deductible, capped at $2,000 married filing jointly / $1,000 single or head of household / $500 married filing separately (the $500 married-filing-separately figure is ASSUMED — the Code's usual halving of the single amount; this engine prices no married-filing-separately status, so the assumed figure never prices). SIMPLIFICATION: the engine's single charitable input carries no cash/property split, so the whole input is treated as cash contributions for §170(p). The 0.5% floor NEVER applies to the §170(p) deduction. PLACEMENT: §170(p) is a deduction FROM adjusted gross income in determining taxable income — §63(b)(4) lists it among the amounts subtracted from AGI for a taxpayer who does not itemize, and §62 (the adjustments in arriving at AGI) does not list it — so it is priced BELOW THE LINE: it does NOT reduce the year's agi, magi, or acaMagi, and on a standard-side year it is INSIDE the deductions figure (the standard deduction + the §170(p) amount + any §224 senior deduction), so taxable income still foots as AGI minus deductions (surfaced as nonItemizerCharitableDeduction, or nonItemizerCharitableDeductionCents on the funding rows). The standard-vs-itemized comparison accounts for §170(p) exactly as before: the standard side carries standard + §170(p) against the itemized total after the floor and §68. The §224 senior deduction's phase-out is priced on the year's AGI — the true AGI, on either side, because §170(p) never touches AGI; the §86 taxable-benefits amount is unaffected by §170(p) either way. (Placement corrected by the engine-audit round-2 fix: the deduction trio's original build priced §170(p) above the line as a flagged judgment call; the statute places it in §63(b), below the line.) The Washington excise's charitable deduction is unaffected: it prices from the raw charitable input exactly as before.";

/* Fixture-honesty repair (2026-10-23): the 1949 RMD-age
   simplification, stated in the contract as well as at the
   code site. The behaviour this text describes is the
   shipped behaviour (rmdAgeForBirthYear in taxLaw.ts, whose
   comment says the same thing) — this constant only makes
   the contract state it: the statute splits the 1949 birth
   cohort at July 1, and the engine's birth-year-only inputs
   cannot express that split. */
export const RMD_AGE_SEMANTICS =
  "RMD age by birth year (SECURE 2.0 §107): the engine's inputs are birth YEARS only (birthYearPrimary / birthYearSpouse), and the RMD age is read from the birth year — 1948 or earlier → 70½, 1949–1950 → 72, 1951–1959 → 73, 1960 or later → 75. DOCUMENTED SIMPLIFICATION — the 1949 cohort: the statute splits that one birth year at July 1 (26 CFR §1.401(a)(9)-2(b)(2)): a person born BEFORE July 1, 1949 has an RMD age of 70½, and a person born on or after July 1, 1949 has an RMD age of 72. A birth year alone cannot express that split, so the engine prices ALL of 1949 at 72 — a January–June 1949 birth is therefore priced with the July-onward cohort's age (72) instead of its statutory 70½. No other cohort is affected: every other birth year maps to a single statutory age, and the split matters only to a household whose pre-tax owner's birth date falls in January–June 1949.";

export const LAW_YEAR_SEMANTICS =
  "lawYear names the newest published law table the engine holds; lawYearsAvailable lists every table the engine holds. Each year of a plan prices under its own calendar year's table: a year with a published table prices under that table, and a year beyond the newest published table carries that newest table forward in today's dollars — its inflation-indexed figures (brackets, standard deduction, capital-gains thresholds, IRMAA tiers) stay at their table values in real terms — so a scheduled law change takes effect in a plan exactly when its dated table does, with no engine change. Figures a statute does not inflation-index — the NIIT thresholds, the Social Security provisional-income thresholds (§86), the SALT cap figures (the cap, its phase-down start, and its floor), and the education-credit figures (the AOTC and Lifetime Learning expense caps, credit amounts, and the §25A phase-out range) — are stated in their table's dollars and deflate at the plan's inflation rate for each year the priced year runs past the table it prices under. ACA guideline convention: projected years price the ACA cliff on the newest poverty-guideline row in today's dollars, while the single-year pricer applies the statutory lookback to its named year.";

/* Build C: the ACA applicable-percentage semantics. The
   behaviour this text describes is the shipped behaviour
   (acaCreditFor in taxEngine.ts + acaTableFor in
   taxLaw.ts): one shared §36B step prices every surface,
   with the percentage tables carried as dated data in
   taxLaw.ts — including the 2027 partial row and the
   projected-mode scope limit that keeps it out of every
   projection. */
export const ACA_SEMANTICS =
  "ACA applicable percentages (IRC §36B): the share of household income a household is expected to contribute toward the benchmark (second-lowest-cost Silver) plan is read from the coverage year's applicable-percentage table by income as a percentage of the federal poverty line, linearly interpolated inside each band. BAND EDGES ARE LOWER-INCLUSIVE: the published tables define each band as at least X% but less than Y% of the poverty line (Rev. Proc. 2025-25, §3.01 for coverage year 2026; Rev. Proc. 2026-26 for coverage year 2027), so income exactly at a band's lower edge takes that band's INITIAL percentage, interpolating to its final percentage at the top edge — for example, income at exactly 133% of the poverty line prices the second band's initial percentage (3.14% for 2026 coverage; 3.23% for 2027 coverage), not the first band's percentage (2.10% for 2026; 2.15% for 2027), while income a hair below 133% prices the first band. This lower-inclusive selection applies uniformly to every band edge (133%, 150%, 200%, 250%, and 300%) and every table row; at the other edges the lower band's final percentage equals the next band's initial percentage, so only the 133% edge changes a priced figure. The 400% cliff semantics are unchanged: for 2026 and later coverage a credit pays at exactly 400% of the poverty line and is $0 above it. The 2027 table (Rev. Proc. 2026-26, Internal Revenue Bulletin 2026-31) is: under 133% → 2.15%; 133–150% → 3.23% to 4.30%; 150–200% → 4.30% to 6.78%; 200–250% → 6.78% to 8.66%; 250–300% → 8.66% to 10.22%; 300–400% → 10.22%; the required contribution percentage for 2027 is 10.22%. SCOPE OF THE 2027 TABLE: it prices coverage year 2027 wherever a 2027 coverage year is priced — the single-year pricer (runPlaygroundYear / pricePlaygroundYear under its statutory lookback convention, and acaCreditFor in its default mode) AND projected pricing for coverage year 2027 itself: the plan march (the Roth plan pricing behind runRothCompare, runRothFunding, runPlanYearDetail, and the optimizer) and the Playground projection (projectPlaygroundYears) price a projected 2027 on the 2027 table, because that table is published law for that year. It is NOT the fallback for 2028 or later: a coverage year after 2027 — specific or projected — prices on the 2026 table, the newest complete law row, and never on the 2027 percentages. Projected years at or before 2026 price exactly as before. The pricing paths that use the 2027 table are therefore exactly the paths pricing coverage year 2027; every other path prices the table stated above.";

/* T6: the education-credit semantics. The behaviour this
   text describes is the shipped behaviour
   (educationCreditsFor + priceYear's federal-tax step in
   taxEngine.ts): one shared §25A step prices every surface,
   with the credit terms carried as dated law-row data
   (taxLaw.ts) rather than engine constants. */
export const EDUCATION_CREDIT_SEMANTICS =
  "Education credits (IRC §25A): qualified education expenses are entered as a list of per-student, per-calendar-year entries (educationStudents on the saved plan: each {year, expensesCents, aotcEligible}; the Playground prices the year's students via educationStudents: [{expenses, aotcEligible}] in dollars). The American Opportunity Tax Credit prices PER STUDENT the household marks aotcEligible — 100% of the first $2,000 of that student's expenses plus 25% of the next $2,000, a $2,500 maximum per student — and the Lifetime Learning Credit prices PER RETURN at 20% of up to $10,000 of the expenses of the students NOT claimed for the AOTC. The same student's expenses never support both credits (the §25A coordination rule): the engine prices both statutory allocations — AOTC for the eligible students plus the LLC over the remaining students, and the LLC alone over every student — and takes the allocation with the larger total benefit, naming the choice in every year output (educationChoice: aotc / llc / none). Both credits phase out ratably as the year's AGI runs through the §25A(d) range ($160,000–$180,000 married filing jointly, $80,000–$90,000 otherwise; MAGI here is AGI — the statute adds back only foreign-income exclusions the engine does not model). Credit amounts, expense caps, phase-out ranges and the refundable share are dated law-table data (the T1 mechanism: the aotc / llc / eduPhaseOut fields on each year's law row in taxLaw.ts), statutory and unindexed, so they deflate for plan years past the law row exactly like the NIIT thresholds. 40% of the AOTC after its phase-out is refundable (§25A(i)): it is reported separately (educationRefundable, per year and lifetime) and credited in the plan score identity beside the ACA premium credit, never netted into the year's federal tax; the nonrefundable portion (the AOTC remainder plus the LLC) reduces the year's federal income tax but never below $0 of income tax (it never offsets the NIIT — the Form 1040 ordering). The Playground's totalTax treats the refundable education credit the same way: totalTax is federalTax plus stateTax, so it does NOT subtract the refundable portion — the refundable credit is reported separately as educationRefundable and is never netted into totalTax (just as it is never netted into federalTax). REFUNDABLE-CREDIT DEPOSIT — the cash-flow timing and basis rule (Build D): in the plan march (the simulation behind runRothCompare, runRothFunding, runPlanYearDetail, and the optimizer), a year's refundable portion is received as cash at the start of the FOLLOWING plan year — the year's return is filed the next spring — and deposited into the taxable account at 100% basis: in the basis ledger it is an after-tax inflow (the basis dollars rise one-for-one; with basis tiers it merges into the inflow tier), so from that year on it funds spending and taxes and grows like any other taxable dollar. A refundable credit earned in the plan's FINAL year has no following year inside the plan, so it is included in that plan's ending taxable balance (added after the final year's growth, as the undeposited dollars themselves), and the final year's row reports that same ending balance. The funding identity therefore holds in every plan year: every refundable dollar the score credits is a dollar in a balance — no scored dollar is left undeposited. The single-year pricers (the Playground year, the execution year) carry no balances and only report the credit; work years price the credit in the year's tax AND deposit the refundable portion: the work-year roll-forward adds the year's refundable credit to that year's surplus (engine-audit round-2 fix), so it lands in the taxable balance through the roll-forward, banked at that year's end — the same deposit the plan march makes — and no work-year refund dollar vanishes from the balance sheet either. Blank / absent / empty educationStudents = no expenses entered = no credits, and every figure prices bit-identically to before. Expenses are entered, never inferred: the engine does not derive them from 529 balances, the college-years span, or any other saved field, and the aotcEligible mark is the household's declaration — the engine prices credit math and phase-outs, not enrollment eligibility.";

/* T7: the alternative-minimum-tax semantics. The behaviour
   this text describes is the shipped behaviour (amtFor +
   priceYear's federal-tax step in taxEngine.ts): one shared
   §55 step prices every surface, with the AMT terms carried
   as dated law-row data (taxLaw.ts) rather than engine
   constants. */
export const AMT_SEMANTICS =
  "Alternative minimum tax (IRC §55, Form 6251): every priced year also computes a parallel tentative minimum tax, and the year's AMT owed is the excess of that tentative tax over the year's regular tax, never below $0. Alternative minimum taxable income (amti on the year outputs) starts from the year's regular taxable income — in an itemized year, the taxable income determined WITHOUT regard to the §68 limitation (the AMT tentative computation keeps using the unreduced figures; see the itemizedDeductionSemantics convention) — and adds back only the adjustments the engine has the quantities for (the core scope): the state-and-local-tax deduction actually taken — the year's itemized SALT after the §164(b)(7) cap (itemizedSaltAllowed) — in a year the itemized deduction won, and the standard deduction (base plus age-65+ add-ons) in a year the standard deduction won. The year's priced OBBBA §224 senior deduction amount is also added back in EITHER year: §224 is claimable whether or not the filer itemizes, and the 2025 Form 6251 instructions place its add-back in §56(b)(5)(D), the standard-deduction disallowance family. Mortgage interest and charitable contributions are not adjustments. The §55(d) exemption, its phase-out start and rate, and the 26% / 28% breakpoint are dated law-table data read from the priced year's own law row (the T1 mechanism): exemption $137,000 married filing jointly / $88,100 single or head of household with a 25% phase-out from $1,252,700 / $626,350 in the 2025 table (Rev. Proc. 2024-40), and $140,200 / $90,100 with a 50% phase-out from $1,000,000 / $500,000 in the 2026 table (Rev. Proc. 2025-32; the phase-out reset is §70107 of Public Law 119-21). The exemption is reduced by the row's phase-out rate for each dollar of AMTI above the row's phase-out start, never below $0. The tentative minimum tax (amtTentativeTax) taxes the excess of AMTI over the surviving exemption at 26% up to the row's breakpoint ($239,100 in 2025, $244,500 in 2026) and 28% above it, EXCEPT that the year's long-term capital gains and qualified dividends keep their preferential 0% / 15% / 20% rates under the capital-gain worksheet treatment (§55(b)(3)): those dollars are taxed on the same staircase as the regular tax, stacked on the year's regular-tax ordinary stack (regular taxable income minus the preferential dollars inside it) against the year's own capital-gains thresholds — Form 6251 Part III (lines 20 / 27) imports the stack amounts from the regular-tax Qualified Dividends and Capital Gain Tax Worksheet, so the thresholds are consumed by the regular ordinary stack, not by the ordinary portion of the AMT taxable excess; the AMT taxable excess still controls the total amount subject to the tentative tax. The regular tax the tentative tax is compared against is the year's income tax (ordinary plus capital-gains) after nonrefundable credits; the NIIT is not part of that comparison (it is a separate tax, never on Form 6251) and is added beside the AMT. AMT owed (amtOwed per year, amtCents per compare scenario, lifetimeAmt on the plan result) is INSIDE the year's federalTax and therefore inside totalTax and the plan score identity — the lifetime and scenario AMT figures name the component of the tax total and are never counted a second time. No new input exists for AMT: it prices from the year's own priced quantities on every surface (plan years, funding rows, compare, optimizer, Playground) with no opt-in, and a year whose tentative tax does not exceed its regular tax owes $0 and prices bit-identically to before this build. NAMED LIMITATIONS — adjustments and preferences the engine has no inputs for are NOT modeled and no inputs are invented for them: the incentive-stock-option bargain element (§56(b)(3)), tax-exempt interest from private-activity bonds (§57(a)(5)), depreciation differences (§56(a)(1) / (g)), other §56(a) recomputations (passive activities, installment sales, long-term contracts), the AMT foreign tax credit, and the §53 credit for prior-year minimum tax. A household with those items can owe more AMT than the engine prices.";

/* Round-5 fix 1: unpaid tax. The behaviour this text
   describes is the shipped behaviour (taxEngine's settleYear
   debit chain and its two reprice-delta chains): every debit
   is capped at the balance it draws from, and the remainder
   after the last balance is reported, never discarded. */
export const UNPAID_TAX_SEMANTICS =
  "Unpaid tax: a year's priced tax bill is paid from surplus income cash first, then from the accounts in the engine's debit order (the payTaxFrom channel, conversion withholding, then debits from Taxable below the protect-minimum, Pre-tax, and Roth). Each debit takes at most the balance it draws from; if every balance is exhausted with part of the bill still owed, that remainder is the year's UNPAID TAX — reported per year as unpaidTax on the plan-year rows (runPlanYearDetail, dollars) and unpaidTaxCents on the funding rows (runRothFunding) and per scenario as the lifetime unpaidTaxCents (runRothCompare), never treated as paid: the assessed tax fields (federalTax / stateTax / penalty / irmaaPaid, and totalTaxCents in the compare) carry the full liability either way, the funding sources carry only amounts actually applied, and the funding identity foots as sources + spendShortfallCents + unpaidTaxCents = totalNeedCents. Unpaid tax is distinct from spendShortfall (unfunded SPENDING): a year can owe unpaid tax with its spending fully funded, whenever income it does not control (for example Social Security or pension income) is taxed after the accounts have run out. It is $0 in every year whose balances cover the bill.";

/* Security-hardening S1 (round-5 security review; the user chose
   option C, 2026-10-19): the plaintext-backup authenticity
   line. The warning half shipped with the hardening batch (a
   plaintext payload is not authenticated; its key check is a
   compatibility check only); this text now states the MAC
   half, shipped as the follow-on build: payloads carry a keyed
   authenticity MAC, verified at restore, with the pre-MAC
   compatibility rule and the honest scope of the guarantee —
   the key ships with the app, so the MAC is tamper/corruption
   detection, not proof of origin. The behaviour this text
   describes is the shipped behaviour (backupMacCore +
   restoreCore's preflight + the restorebackup handler). The
   .mstbak statement stays scoped to what its authenticated
   encryption actually provides — tamper evidence on
   decryption — not origin authentication. */
export const BACKUP_AUTHENTICITY_SEMANTICS =
  "Backup authenticity: exportbackup returns the complete dataset as a PLAINTEXT payload, and restorebackup replaces the entire dataset with a payload it is handed. Every payload exportbackup writes carries an authenticity MAC (the authenticityMac field: a keyed HMAC-SHA-256 over the payload's contents), and restorebackup verifies it before writing anything. A payload whose MAC does not verify is REFUSED with an authenticity error — its contents were changed or corrupted after export — and nothing is restored. A payload carrying NO MAC — every backup written before MAC signing — still restores, and the restore result labels it UNAUTHENTICATED (authenticated: false): nothing in it proves its contents are unmodified since export, so restore one only from a source you trust, state plainly before restoring that the file is unauthenticated, and confirm with the user — restoring replaces everything. What the MAC proves, and what it does not: the MAC key ships with the app — the same key in the live app and the packaged build, which is what lets a backup verify on either side — so the MAC is tamper and corruption DETECTION, not proof of origin: it catches any change made without recomputing the MAC with the app key (a hand-edited figure, a truncated or damaged file, a payload assembled by other software), but anyone holding the app could in principle compute a valid MAC for altered contents, so it is not a signature and does not prove who made the file. The payload's encryption key check is unchanged and remains a COMPATIBILITY check only — it shows the payload was made under this app's encryption key, so the values it carries will decrypt here; it says nothing about the file's contents. Encrypted backup files (backup-*.mstbak, created by createBackupNow) are integrity-protected by their authenticated encryption: a modified .mstbak fails decryption instead of restoring altered figures; the plaintext payload inside an .mstbak carries the same MAC, and the same restore rule applies to it.";

/* A-14: the basis-tier rules as one statement (the schema's
   superRefine enforces the sum; the engine consumes tiers
   highest-basis first and prices the pool from the tiers
   alone when they are present — taxableBasisPct applies only
   to the single-pool shape). */
export const TIER_SEMANTICS =
  "taxableTiers: up to six slices of the taxable pool; sharePct values must sum to 100 (±0.01); sales consume the slices highest-basis first; when tiers are present they replace taxableBasisPct.";

/* Playground dividend-pair guard (projection solidity check,
   2026-10-21): the Playground single-year dividend derivation,
   stated as its own convention. The behaviour this text
   describes is the shipped behaviour (pricePlaygroundYear in
   rothOptimizer.ts) — this constant only makes the contract
   state it, including what happens on the impossible pair
   (qualified entered greater than the total). */
export const PLAYGROUND_YEAR_SEMANTICS =
  "Playground year — dividends: the single-year pricer (runPlaygroundYear / pricePlaygroundYear) takes the two dividend dials exactly as printed on the tax forms. The Ordinary dividends input (ordinaryDividends) is the TOTAL ordinary dividends for the year — the Form 1099-DIV box 1a figure (Form 1040 line 3b) — and the Qualified dividends input (qualifiedDividends) is a subset of that total — the box 1b figure (Form 1040 line 3a) — never an amount on top of the total. The pricer derives the non-qualified part as nonQualifiedDividends = max(0, ordinaryDividends − qualifiedDividends): the non-qualified part rides the ordinary stack and the qualified part rides the gains (preferential) stack, so the entered total is counted once. On a real Form 1099-DIV the qualified figure cannot exceed the total; when qualifiedDividends is entered greater than ordinaryDividends, the derivation floors the non-qualified part at $0 and the excess is not counted as non-qualified dividends — and the Playground shows a note on the form in that case, so the impossible pair is flagged instead of silently priced.";

/* Tax-return actuals (1040 LINES build): the plan record's
   three most-recent-return amounts and their one consumer.
   The behaviour this text describes is the shipped behaviour
   (parseRothTaxReturn / taxReturnPrefillDollars in
   taxReturnCore.ts, the saveRothInputs writer, and the
   Playground's prefill) — this constant only makes the
   contract state it, including the fields' prefill-only role. */
export const TAX_RETURN_SEMANTICS =
  "Tax-return actuals (taxReturnInterestCents, taxReturnQualifiedDividendsCents, taxReturnOrdinaryDividendsCents): three optional fields on the Roth plan record holding the household's most recent tax return's Form 1040 actuals — taxable interest (line 2b), qualified dividends (line 3a), and ordinary dividends (line 3b) — in integer cents, like the record's other money fields; null on any field means that line was not entered. They are plan-record only: accepted ONLY by saveRothInputs and returned ONLY by getRothPlanner (its own taxReturn block), exactly like the execution-year, MC-volatility, and gift blocks — they are NOT part of the saved plan inputs, so they never enter a saved scenario and no compute action accepts them. They feed ONE consumer: the Playground's \"Start from my numbers\" prefill, which maps them onto its income dials as interest ← line 2b, qualified dividends ← line 3a, and ordinary dividends ← line 3b written as the TOTAL (the 3b total, which includes the 3a qualified part — the prefill writes the total, never the non-qualified remainder; see the playgroundYearSemantics convention for how the pricer splits the pair). Plan pricing NEVER reads them: funding, compare, the optimizer, and every other pricing path keep modelling interest and dividends from the plan's yield fields (taxableInterestYieldPct / taxableDividendYieldPct) exactly as before, and a saved plan prices bit-identically with the three fields set or blank — the tax suite's tax-return-pricing-identity fixture pins that isolation.";

/* Year-capture (contract v37): the eight Roth compute actions
   capture the calendar year ONCE at the top of each invocation
   and thread that single value through every pricing and
   response-echo construction in the call — planInputsFromSaved,
   runRothCompare / runRothMonteCarloStats startYear, the
   per-scenario sleeve echoes, and computeEffectiveInputs. The
   behaviour this text describes is the shipped behaviour
   (actions.ts handlers) — this constant only makes the
   contract state it. A call that does not span a calendar-year
   boundary prices bit-identically to before; a call spanning
   Dec 31 midnight now prices and describes with ONE startYear
   instead of potentially two. */
export const YEAR_CAPTURE_SEMANTICS =
  "Year capture (Roth compute actions): each invocation of runRothOptimizer, runRothCompare, runRothMonteCarloCheck, runRothMonteCarloStats, runWorkYearsCompare, runRothGiftCompare, runPlanYearDetail, and runRothFunding captures the current calendar year exactly once, at the top of the invocation, and uses that single captured value as the startYear for every plan construction, pricing call, and effectiveInputs / scenario echo in that invocation. No Roth compute action re-reads the calendar year mid-invocation, so a call spanning a calendar-year boundary (Dec 31 midnight) prices and describes with the same startYear throughout. Calls that do not span a boundary price bit-identically to before this convention. Non-Roth actions keep their own current-month / current-year logic and are not covered by this convention.";

/* Guardrails semantics (Prompt 13 fix, contract v40): the
   Retirement engines' guardrails rail rule, its numerical
   tolerance, and the max-spending solver's inclusive
   endpoint. The behaviour this text describes is the shipped
   behaviour (guardrailsAdjustedSpending and
   solveGuardrailsScan in retirementEngines.ts) — this
   constant only makes the contract state it, including the
   tolerance value and its rationale. */
export const GUARDRAILS_SEMANTICS =
  "Guardrails strategy (Retirement engines): each retired year, before withdrawing, the current withdrawal rate (current spending ÷ current balance) is compared with the rails set from the initial withdrawal rate at retirement (the base spending ÷ the portfolio at that moment): spending is cut by guardrailsAdjustmentPct % only when the current rate is strictly above guardrailsCutPct % of the initial rate, and raised by the same % only when it is strictly below guardrailsRaisePct % of the initial rate — a rate exactly AT a rail fires neither adjustment; at most one adjustment fires per year and the adjusted level carries into following years (adjustments compound, never reset). NUMERICAL TOLERANCE: the rail comparisons carry a relative tolerance of 1e-9 (GUARDRAILS_RATE_REL_TOLERANCE in retirementEngines.ts): a rate within 1e-9 (relative) of a rail is treated as AT the rail. Rationale: the rails are computed as (cutPct / 100) × initialRate in IEEE-754 floating point, and at exact mathematical equality that product can land about one ulp on the wrong side of the current rate — (120 / 100) × (200000 / 1200000) evaluates to 0.19999999999999998, below the exactly-equal current rate 0.2, and (80 / 100) × 0.2 evaluates to 0.16000000000000003, above the exactly-equal 0.16 — so a raw comparison fired a 10% adjustment the strict rule forbids. The representation error in these products is at most a few ulps (~1e-15 relative); the 1e-9 tolerance is roughly a million times that error, yet far smaller than any economically distinguishable rate difference, so every rate past a rail by more than the tolerance fires exactly as before. Both year loops (simulateDetailed and runNeverRunsOut) apply the SAME comparison through one shared helper, so the simulator and the max-spending solver cannot disagree at a rail. MAX-SPENDING SOLVER ENDPOINT: the guardrails max-spending scan is INCLUSIVE of its proven ceiling — the $100 step at exactly the best run's balance at retirement plus the eventual extra income is scanned like every other step; steps above that ceiling cannot succeed for any run (their first-year net withdrawal exceeds every run's retirement balance), while the step at the ceiling can succeed because an exactly funded withdrawal is not short under the never-runs-out predicate. Feasibility of every scanned step, the endpoint included, is decided by runNeverRunsOut.";

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
  "Writers strict, readers lenient: the writer actions (saveRothInputs, saveRothScenario) persist complete records and require every field of the record they save — saveRothInputs additionally requires its baseRevision CAS base on every call — while the read-only compute actions accept a payload that omits the draw-order switch fields (drawOrderSwitchAge, drawOrderAfter) — an omitted switch field prices exactly as null (no switch) — or the ceilings key acaCliffCapFamilyOnly, which prices exactly as false. Separately, by explicit approval, the eight compute actions (runRothOptimizer, runRothCompare, runPlanYearDetail, runRothFunding, runRothMonteCarloCheck, runRothMonteCarloStats, runWorkYearsCompare, runRothGiftCompare) reject unknown request keys — at the top level, inside ceilings objects, inside runRothCompare and runRothMonteCarloStats scenario items and their overrides, and inside runRothMonteCarloCheck's winner/doNothing objects — so a misspelled key fails validation instead of silently pricing without it. All other actions strip unknown keys as zod objects do by default. Validation failures return every issue at once, as an array of issue objects in the validator's raw shape — each issue carries path, code, expected, and message fields (for example, calling getRetirementBaselineResults with {} returns issues reporting 'expected number, received undefined' for the missing keys). A field whose schema is nullable accepts an explicit null: that same 'received undefined' message on a nullable field means the key itself is required — pass null, not 0, for a blank.";

/* A-6: ceilings replacement, stated once and appended to
   both runRothCompare's and runRothMonteCarloStats'
   purposes (the audit's drafted sentence). */
export const CEILINGS_REPLACEMENT_SENTENCE =
  "A scenario's ceilings object replaces the base ceilings wholesale — it does not merge; inside it, acaCliffCapFamilyOnly may be omitted and prices as false.";

/* A-10: the fetch→save flattening map, appended to
   saveRothInputs' purpose (verified against the action's
   request composition: rothInputFields + execution fields +
   mcCheck field + gift fields + tax-return fields +
   baseRevision, all top level; getRothPlanner returns those
   as the saved / execution / mcCheck / gift / taxReturn
   blocks plus the top-level revision). */
export const SAVE_FLATTENING_SENTENCE =
  "The request is getRothPlanner's response flattened: the saved block's fields, then the execution, gift, and tax-return blocks' fields, all at top level; mcCheck.mcVolatilityPct is sent as mcVolatilityPct; the record's revision is sent as baseRevision. baseRevision is REQUIRED on every saveRothInputs call: a call that omits it, or whose base no longer matches the stored revision, is refused with the current record (the conflict response) and writes nothing — there is no unchecked save path; the first-ever record is created with baseRevision 0.";

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
        educationRefundableCents: 0,
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
        deltaEducationRefundableCents: 0,
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
        educationRefundableCents: 0,
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
        deltaEducationRefundableCents: 0,
      },
    ],
  },
};
