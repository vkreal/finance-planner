import { z } from "@hatch/space-sdk";

/* ---------------- Roth view UI state ----------------
   Display-only state for the Roth Conversion view's guided
   layout: which of the five input sections are open, whether
   the Year-by-year table is expanded, and which results
   workspace (Plan / Optimize / Compare) the segmented control
   shows. The blob also carries the Playground view's
   remembered form state (playgroundFormState below). Persisted
   in settings under one JSON blob
   ("roth_ui_state_v1") so it survives reloads, new sessions,
   and devices, exactly like the other section collapse flags.
   First use (no stored blob): the everyday sections ("Your
   money", "Spending & timing", "Social Security", "Taxes &
   ACA") are open and "Advanced" is closed, the year table is
   collapsed, and the results workspace is Plan.
   A stored blob written before the workspace mode existed
   parses with the Plan default. This state never touches the
   saved Roth inputs record, the scenarios, or any amount.

   Revision / CAS: the blob carries a monotonically increasing
   integer revision (see the RothUiState type). Parsing is
   lenient — a blob written before revisions existed has no
   revision key and reads as revision 0. Writers pass the
   revision their copy of the blob was read at (baseRevision);
   applyRothUiWrite refuses the write when the stored revision
   has moved past that base (a concurrent save from another
   tab or device landed first), so an older in-flight save can
   never silently clobber newer field values. The refused
   writer re-merges against the current blob the refusal
   carries and retries at the fresh revision. baseRevision
   is REQUIRED on every write (audit N-2): a write with no
   baseRevision is refused with the current blob and its
   revision, exactly like a stale base — there is no
   unchecked write path. A first write (no stored row) is
   always insert-only at base 0, so two racing first writes
   cannot both land — the loser is refused with the winner's
   blob. Either way, an accepted write stores revision + 1. */
export const ROTH_UI_STATE_KEY = "roth_ui_state_v1";
export const ROTH_SECTION_IDS = ["household", "money", "income", "aca", "advanced"] as const;
export type RothSectionId = (typeof ROTH_SECTION_IDS)[number];
export const ROTH_RESULTS_MODES = ["plan", "optimize", "compare", "thisYear", "yearFunding", "playground", "workYears", "gift", "proof"] as const;
export type RothResultsMode = (typeof ROTH_RESULTS_MODES)[number];
/* Strategy Lab "debate dials": plan-level overrides the Lab
   applies at pricing time to every library row at once. They
   are Lab-local scratch state under Playground rules — they
   live ONLY in this UI-state blob, never in the saved Roth
   inputs record and never in a saved scenario. Every field is
   nullable: null means "no override" (each row prices on its
   own saved value, and the plan rows on the plan's), so dials
   at their defaults reprice nothing. "Reset dials" returns
   every field to null. */
export const rothLabDials = z.object({
  basisPct: z.number().min(0).max(100).nullable(),
  spendingCents: z.number().int().nullable(),
  ssPrimaryStartAge: z.number().int().min(0).max(120).nullable(),
  ssSpouseStartAge: z.number().int().min(0).max(120).nullable(),
  survivorEnabled: z.boolean().nullable(),
  survivorWho: z.enum(["primary", "spouse"]).nullable(),
  survivorDeathYear: z.number().int().min(1900).max(2200).nullable(),
  // KNOBS expansion dials (grouped in the Lab UI as ACA /
  // Assumptions / Plan shape / Starting balances). Each names
  // the saved-shape field it overrides at pricing time, in the
  // saved shape's own units (cents for money, plain numbers
  // for percents and ages), with the same ranges the saved
  // shape itself enforces. A UI-state blob written before
  // this build has none of these keys, which parse to null —
  // no override — exactly like a dial left blank.
  acaSpouseEndAge: z.number().int().min(55).max(80).nullable(),
  acaBenchmarkFamilyCents: z.number().int().nullable(),
  acaBenchmarkCoupleCents: z.number().int().nullable(),
  acaBenchmarkSingleCents: z.number().int().nullable(),
  // Health premium dials (build v208): the plan's three
  // health premium fields as Lab overrides, in cents like
  // the benchmark dials. A set dial replaces the plan's
  // field at pricing time; a blob written before this
  // build has none of these keys, parsing to null — no
  // override.
  healthPremiumAcaHouseholdCents: z.number().int().nullable(),
  healthPremiumAcaSingleCents: z.number().int().nullable(),
  healthPremiumMedicarePerPersonCents: z.number().int().nullable(),
  // The household-schedule dial (MULTI-STEP ACA HOUSEHOLD
  // SCHEDULE build): the whole schedule as one dial, replacing
  // the old size-after / step-year dial pair — a set dial
  // replaces the plan's schedule wholesale at pricing time,
  // exactly as the old pair replaced its two fields. Entries
  // are the schedule's own shape (integer year 1900–2200,
  // integer size 1–20); the parse below keeps the well-formed
  // entries and sorts them, like every lenient read here. A
  // UI-state blob written before this build has no such key,
  // which parses to null — no override — exactly like a dial
  // left blank (its legacy pair keys are no longer read).
  acaHouseholdSchedule: z
    .array(
      z.object({
        fromYear: z.number().int().min(1900).max(2200),
        householdSize: z.number().int().min(1).max(20),
      }),
    )
    .max(40)
    .nullable(),
  expectedReturnPct: z.number().nullable(),
  inflationPct: z.number().nullable(),
  heirRatePct: z.number().min(0).max(100).nullable(),
  stateRatePct: z.number().min(0).max(100).nullable(),
  windowStartAge: z.number().int().min(0).max(120).nullable(),
  windowStopAge: z.number().int().min(0).max(120).nullable(),
  preservePretaxCents: z.number().int().nullable(),
  pretaxCents: z.number().int().nullable(),
  taxableCents: z.number().int().nullable(),
  rothCents: z.number().int().nullable(),
});
export type RothLabDials = z.infer<typeof rothLabDials>;
const blankLabDials = (): RothLabDials => ({
  basisPct: null,
  spendingCents: null,
  ssPrimaryStartAge: null,
  ssSpouseStartAge: null,
  survivorEnabled: null,
  survivorWho: null,
  survivorDeathYear: null,
  acaSpouseEndAge: null,
  acaBenchmarkFamilyCents: null,
  acaBenchmarkCoupleCents: null,
  acaBenchmarkSingleCents: null,
  healthPremiumAcaHouseholdCents: null,
  healthPremiumAcaSingleCents: null,
  healthPremiumMedicarePerPersonCents: null,
  acaHouseholdSchedule: null,
  expectedReturnPct: null,
  inflationPct: null,
  heirRatePct: null,
  stateRatePct: null,
  windowStartAge: null,
  windowStopAge: null,
  preservePretaxCents: null,
  pretaxCents: null,
  taxableCents: null,
  rothCents: null,
});
/* Playground form state — the Playground view's complete
   dial set, persisted in this same UI-state blob so the form
   remembers its numbers between sessions (a deliberate
   reversal of the Playground's original scratch-only design).
   Form state ONLY: it is read and written by the Playground
   view alone, never enters the plan record or a scenario, and
   pricing reads the dials exactly as typed whether they came
   from storage or from fresh typing. Every field is stored in
   the form's own units — the raw typed strings for the money
   and number dials — so a reload restores the form exactly.
   The parse below is defensive: a missing, partial, or
   malformed blob falls back field by field to the fresh-form
   defaults, and unknown keys are ignored. The paste box is
   deliberately NOT part of this state — only the dials a
   successful paste sets are remembered, exactly like typed
   values. */
/* Projection template snapshot (projection click fix): the
   single-year dials, priced into engine inputs, captured at
   the moment the projection last (re)started. The projection
   chart runs from THIS snapshot — never from the live dials —
   so loading a projected year into the single-year view (which
   overwrites the dials) can never shrink or re-base the chart,
   in the session or across a reload. It is stored in engine-
   input units (numbers, not typed strings) because it is not
   a form the user types into; it changes only on a deliberate
   capture (opening the panel, or the panel's re-run button).
   A blob written before this field existed parses it null —
   no snapshot yet — and the view captures one when the panel
   next opens. */
/* P-S8 (parity audit, SHOULD): the snapshot carries the FULL
   PlaygroundYearInputs the projection runs from — every fact
   buildPgInputs supplies — including the December-era facts
   an earlier shape dropped on save (the ACA settlement
   facts, the health premiums, the loss carry-ins, the RMD
   already received, the dependent MAGI, the funding draws,
   the reinvested-yield flag, the annual spending, and the
   harvest pair), so a template restored after a reload
   reprices the projection identically. Each such field is
   read leniently by parsePgProjTemplate below: a blob
   written before it was carried parses it at its no-fact
   value (null / 0 / false — each the pricer's absent
   reading), so an older stored template still loads and
   prices exactly as the lossy restore priced it, and the
   view's is-current check (comparing through the full
   mapping, projTemplateCore.ts) reads it not-current
   against the live dials until the panel next captures. */
export const playgroundProjTemplateState = z.object({
  taxYear: z.number().int(),
  filingStatus: z.enum(["mfj", "single", "hoh"]),
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
  /* The pre-tax draw for spending the template year
     carries (R3-M1) — the projection walk overrides each
     year's draw from its money-out kind, so this only
     round-trips the captured dial; a blob written before
     this field existed parses it 0 (no draw — the years
     price exactly as before). */
  spendingDraw: z.number(),
  stockSold: z.number(),
  stockBasis: z.number(),
  qualifiedDividends: z.number(),
  pretaxBalance: z.number().nullable(),
  /* The spouse's share of the pre-tax balance, priced on the
     spouse's own RMD clock — a blob written before this
     field existed parses it null (no spouse balance, no
     spouse RMD — the year prices exactly as before). */
  pretaxBalanceSpouse: z.number().nullable(),
  spouseSoleBeneficiary: z.boolean(),
  /* The reciprocal beneficiary fact (N-1): the primary is
     the sole beneficiary of the SPOUSE's pre-tax accounts
     — the fact that selects the spouse's RMD table in the
     template's years. Tri-state like the engine input:
     null = not established (the spouse's RMD prices
     Uniform). A blob written before this field existed
     parses it null, exactly as before. */
  primarySoleBeneficiaryOfSpouse: z.boolean().nullable(),
  acaHouseholdSize: z.number().nullable(),
  acaBenchmarkAnnual: z.number().nullable(),
  /* The ACA filing-settlement facts (P-S8): the advance
     credit taken and the coverage-month reduction (each
     null when the stored template carries no settlement
     fact — the pre-P-S8 spelling), and the enrollment
     premium the settlement caps the final credit at (null
     = no cap). */
  aptcTaken: z.number().nullable(),
  acaCoverageReduction: z.number().nullable(),
  acaEnrollmentPremiumAnnual: z.number().nullable(),
  /* The health premium facts (P-S8): the marketplace
     gross premium and the per-person Medicare base
     premium the after-health readout prices from, each
     null when none was entered. */
  healthPremiumAcaAnnual: z.number().nullable(),
  healthPremiumMedicarePerPerson: z.number().nullable(),
  /* The loss carry-ins (P-S8): the federal short / long
     pair and each character's Washington-attributable
     portion — the projection walk's entering ledger. */
  capitalLossCarryInSt: z.number(),
  capitalLossCarryInLt: z.number(),
  capitalLossCarryInStWa: z.number(),
  capitalLossCarryInLtWa: z.number(),
  /* The RMD already received and the dependent's MAGI
     (P-S8), each null when not supplied. */
  rmdAlreadyReceived: z.number().nullable(),
  dependentMagiForAca: z.number().nullable(),
  /* The cash / Roth funding draws (P-S8): the template
     year's spendable funding from the cash sleeve and
     the Roth accounts. */
  cashDraw: z.number(),
  rothDraw: z.number(),
  /* The reinvested-yield flag (P-S8): the template year's
     yield stays inside the taxable balance and counts
     $0 of cash in. */
  yieldReinvested: z.boolean(),
  /* The annual spending (P-S8): the figure each projected
     year's "enough for the year" verdict runs against,
     null when the template year carried none. */
  annualSpending: z.number().nullable(),
  /* The gain-harvest pair (P-S8): the taxable pool
     available to sell and its blended basis percent;
     either null prices no harvest. */
  harvestPoolAmount: z.number().nullable(),
  harvestPoolBasisPct: z.number().nullable(),
  stateRatePct: z.number(),
  residenceState: z.enum(["WA", "other"]),
  itemizedMortgageInterest: z.number(),
  itemizedSaltPaid: z.number(),
  itemizedCharitable: z.number(),
  itemizedOther: z.number(),
  educationStudents: z
    .array(z.object({ expenses: z.number(), aotcEligible: z.boolean() }))
    .nullable(),
  /* The inflation rate the template's years price with
     (S-4) — a blob written before this field existed
     parses it null (no rate captured — the projected
     years price undeflated, exactly as before). */
  inflationPct: z.number().nullable(),
});
export type PlaygroundProjTemplateState = z.infer<
  typeof playgroundProjTemplateState
>;
/* Income-dial provenance (build v150): where one of the
   Playground's three income dials (interest, ordinary
   dividends, qualified dividends) got its current figure —
   "return": the stored tax return's figure (year = the
   return's calendar year, or null when the record never
   named one); "plan": the saved plan's priced figure for
   that year (the yield-based estimate); "typed": the user's
   own value (typed in the dial, or loaded by a paste). The
   client uses it to word each dial's source hint and to
   re-derive a return- or plan-sourced dial when the Tax
   year changes; a typed figure is never re-derived. The
   recorded kind is the ONLY provenance (re-audit
   NICE-TO-HAVE N-1): it is never inferred from a dial's
   value. It is display/bookkeeping only — it never enters
   pricing. */
export const pgIncomeSourceState = z
  .union([
    z.object({
      kind: z.literal("return"),
      year: z.number().int().min(1900).max(2200).nullable(),
    }),
    z.object({
      kind: z.literal("plan"),
      year: z.number().int().min(1900).max(2200),
    }),
    z.object({ kind: z.literal("typed") }),
  ])
  .nullable();
export type PgIncomeSourceState = z.infer<typeof pgIncomeSourceState>;
export const playgroundFormState = z.object({
  year: z.string().max(12),
  filing: z.enum(["mfj", "single", "hoh"]),
  agePrimary: z.string().max(12),
  ageSpouse: z.string().max(12),
  medicarePrimary: z.boolean().nullable(),
  medicareSpouse: z.boolean().nullable(),
  interest: z.string().max(64),
  ordinaryDividends: z.string().max(64),
  otherOrdinary: z.string().max(64),
  taxExemptInterest: z.string().max(64),
  ssPrimary: z.string().max(64),
  ssSpouse: z.string().max(64),
  conversion: z.string().max(64),
  /* The pre-tax draw for spending (R3-M1, engines review
     round 3): the draw half of the money-out split, as a
     typed string like every money dial here. A blob
     written before this build parses it blank ("" = no
     draw — the year's money out all on the conversion
     dial, exactly as before). */
  spendingDraw: z.string().max(64),
  stockSold: z.string().max(64),
  stockBasis: z.string().max(64),
  qualifiedDividends: z.string().max(64),
  pretaxBalance: z.string().max(64),
  /* The spouse's pre-tax balance (prior Dec 31), as a typed
     string like every money dial here. A blob written before
     this field existed parses it blank ("" = no spouse
     balance = no spouse RMD — the year prices exactly as
     before). */
  pretaxBalanceSpouse: z.string().max(64),
  acaHouseholdSize: z.string().max(12),
  acaBenchmark: z.string().max(64),
  // Health premium dials (build v208): the single-year
  // pricer's entered marketplace premium and Medicare base
  // premium per person, as typed strings like every money
  // dial here. A blob written before this build parses
  // them blank ("" = not entered — the year prices exactly
  // as before).
  healthPremiumAca: z.string().max(64),
  healthPremiumMedicare: z.string().max(64),
  // ACA reconciliation dials (S-1, engines review round 2):
  // the advance premium credit actually taken and the
  // coverage-month reduction, as typed strings like every
  // money dial here. A blob written before this build parses
  // them blank ("" = $0 taken / no reduction — the
  // Playground then prices the year's filing settlement at
  // those facts, agreeing with the December console).
  aptcTaken: z.string().max(64),
  acaCoverageReduction: z.string().max(64),
  // December-only pricing dials (S-2, engines review
  // round 2): the entering capital-loss carryforward (the
  // short-term and long-term amounts and each one's
  // Washington-attributable portion), the RMD already
  // received, and the dependent MAGI for ACA, as typed
  // strings like every money dial here. A blob written
  // before this build parses them blank ("" = none / $0 —
  // the year prices exactly as before).
  capitalLossCarryInSt: z.string().max(64),
  capitalLossCarryInLt: z.string().max(64),
  capitalLossCarryInStWa: z.string().max(64),
  capitalLossCarryInLtWa: z.string().max(64),
  rmdAlreadyReceived: z.string().max(64),
  dependentMagiForAca: z.string().max(64),
  // Cash and Roth funding dials (S-6, engines review
  // round 2): the year's spendable funding drawn from the
  // cash sleeve and from the Roth accounts, as typed
  // strings like every money dial here. A blob written
  // before this build parses them blank ("" = no funding
  // drawn — the year prices exactly as before).
  cashDraw: z.string().max(64),
  rothDraw: z.string().max(64),
  // Reinvested-yield flag (S-3, engines review round 2):
  // true only while the dials hold a year loaded from the
  // saved plan — its interest and dividends are the march's
  // reinvested yield, priced as income but kept out of
  // cash in. A blob written before this build parses it
  // false (the yield counts as cash — the year prices
  // exactly as before).
  yieldReinvested: z.boolean(),
  // ACA cliff buffer (ACA buffer guide build): the Playground
  // One year face's "Buffer below the ACA cliff" guide dial,
  // as a typed string like every money dial here. It is a
  // guide value only — it helps choose the conversion dial
  // (the cliff − buffer fill) and never enters pricing. A
  // blob written before this field existed parses it at the
  // $5,000 default (the December cushion).
  acaBuffer: z.string().max(64),
  benchmarkSource: z
    .object({
      kind: z.enum(["family", "couple", "couple-fallback", "single"]),
      value: z.number(),
    })
    .nullable(),
  // Income-dial provenance (build v150, see
  // pgIncomeSourceState above): one source record per income
  // dial. A blob written before this field existed parses all
  // three null (no recorded source). Provenance is EXPLICIT
  // ONLY (re-audit NICE-TO-HAVE N-1): the stored kind is the
  // dial's source, never a value the client infers — a dial
  // with no recorded source is not return-sourced however
  // its value compares to the stored return figure, and a
  // recorded "typed" stays "typed" even when its value
  // coincidentally equals that figure.
  incomeSources: z.object({
    interest: pgIncomeSourceState,
    ordinaryDividends: pgIncomeSourceState,
    qualifiedDividends: pgIncomeSourceState,
  }),
  stateRate: z.string().max(12),
  // State of residence (T3 build): which rules layer prices
  // the Playground year's state tax. A blob written before
  // this field existed parses as "other" (the flat rate).
  residenceState: z.enum(["WA", "other"]),
  // Itemized deductions (T5 build): the Playground year's
  // four itemized components, as typed strings like every
  // money dial here. A blob written before these fields
  // existed parses them blank ("" = no amount = the
  // standard deduction prices the year).
  itemizedMortgageInterest: z.string().max(64),
  itemizedSaltPaid: z.string().max(64),
  itemizedCharitable: z.string().max(64),
  itemizedOther: z.string().max(64),
  // Education students (T6 build): the Playground year's
  // entered students — each row's qualified expenses as a
  // typed string like every money dial here, plus the
  // household's AOTC-eligibility mark. A blob written
  // before this field existed parses as no students
  // (no credits price — the year prices exactly as before).
  educationStudents: z
    .array(
      z.object({
        expenses: z.string().max(64),
        aotcEligible: z.boolean(),
      }),
    )
    .max(12),
  soleBeneficiary: z.boolean(),
  // The reciprocal beneficiary fact (N-1, engines review
  // round 2): the primary is the sole beneficiary of the
  // SPOUSE's pre-tax accounts — a SEPARATE fact from
  // soleBeneficiary above (the spouse is the PRIMARY's
  // sole beneficiary), carried from the plan record by
  // the "Start from my numbers" prefill so the spouse's
  // RMD prices on the Joint table when the record
  // establishes it. Tri-state like the engine input:
  // null = not established (a blob written before this
  // field existed parses it null — the spouse's RMD
  // prices on the Uniform Lifetime Table, exactly as
  // every remembered form priced before this build).
  primarySoleBeneficiaryOfSpouse: z.boolean().nullable(),
  holdOn: z.boolean(),
  heldTarget: z.union([z.number(), z.literal("aca")]).nullable(),
  // Projection controls (Playground projection build): the
  // projection panel's own dials, in the form's typed-string
  // units like every other dial here. A blob written before
  // these fields existed parses them at the fresh defaults
  // (project to 95, repeat draw, conversions, no stop rule,
  // every override blank = follow the template / the plan).
  projOpen: z.boolean(),
  // The Projection panel's "More" methodology expander
  // (collapse-persistence build): remembered with the rest of
  // the form like projOpen, so the expander comes back as the
  // user left it. A blob written before this field existed
  // parses it false (collapsed — its long-standing default).
  projHowOpen: z.boolean(),
  projToAge: z.string().max(12),
  // Projection from age (start-age control build): the
  // projection panel's own start-age dial, in the form's
  // typed-string units like every other dial here. Blank
  // ("") = the template's own age — exactly the behaviour
  // before this field existed. A blob written before this
  // field existed parses it blank.
  projFromAge: z.string().max(12),
  projTaxableStart: z.string().max(64),
  projRothStart: z.string().max(64),
  projReturnPct: z.string().max(12),
  projDrawMode: z.enum(["repeat", "replace"]),
  projMoneyOutKind: z.enum(["conversion", "draw"]),
  projStopKind: z.enum(["none", "age", "floor"]),
  projStopValue: z.string().max(64),
  projSsPrimaryClaimAge: z.string().max(12),
  projSsSpouseClaimAge: z.string().max(12),
  projSsPrimaryAnnual: z.string().max(64),
  projSsSpouseAnnual: z.string().max(64),
  projAcaSizeAfter: z.string().max(12),
  projAcaStepYear: z.string().max(12),
  // Projection selected year: the calendar year last loaded
  // from the projection chart into the single-year view.
  // Remembered with the rest of the form so a refresh
  // restores the chart's highlight (ring, dimming, bold
  // label) and the "Showing …" caption on the year actually
  // being viewed. Null = no year loaded. A blob written
  // before this field existed parses it null.
  projSelectedYear: z.number().int().min(1900).max(2200).nullable(),
  // Projection template snapshot (see playgroundProjTemplateState
  // above): null = no snapshot captured yet.
  projTemplate: playgroundProjTemplateState.nullable(),
  openSections: z.object({
    year: z.boolean(),
    income: z.boolean(),
    conversion: z.boolean(),
    stock: z.boolean(),
    aca: z.boolean(),
    // Build v145: the Playground's Spending dial section.
    spending: z.boolean(),
  }),
  // The two super-group folds ("Single-year dials" /
  // "Projection dials") that group the section cards
  // (collapse-persistence build): remembered with the rest of
  // the form, both OPEN by default — a blob written before
  // this field existed parses both open, exactly the groups'
  // long-standing first-open behaviour.
  groupOpen: z.object({
    single: z.boolean(),
    projection: z.boolean(),
  }),
});
export type PlaygroundFormState = z.infer<typeof playgroundFormState>;
const PG_SECTION_IDS = ["year", "income", "conversion", "stock", "aca", "spending"] as const;
// The fresh Playground form — exactly the state the view
// opens with when nothing is stored, and the state "Reset
// playground" returns it to.
function defaultPlaygroundFormState(): PlaygroundFormState {
  return {
    year: String(new Date().getFullYear()),
    filing: "mfj",
    agePrimary: "",
    ageSpouse: "",
    medicarePrimary: null,
    medicareSpouse: null,
    interest: "",
    ordinaryDividends: "",
    otherOrdinary: "",
    taxExemptInterest: "",
    ssPrimary: "",
    ssSpouse: "",
    conversion: "",
    spendingDraw: "",
    stockSold: "",
    stockBasis: "",
    qualifiedDividends: "",
    pretaxBalance: "",
    pretaxBalanceSpouse: "",
    acaHouseholdSize: "",
    acaBenchmark: "",
    healthPremiumAca: "",
    healthPremiumMedicare: "",
    aptcTaken: "",
    acaCoverageReduction: "",
    capitalLossCarryInSt: "",
    capitalLossCarryInLt: "",
    capitalLossCarryInStWa: "",
    capitalLossCarryInLtWa: "",
    rmdAlreadyReceived: "",
    dependentMagiForAca: "",
    cashDraw: "",
    rothDraw: "",
    yieldReinvested: false,
    acaBuffer: "5000",
    benchmarkSource: null,
    incomeSources: {
      interest: null,
      ordinaryDividends: null,
      qualifiedDividends: null,
    },
    stateRate: "0",
    residenceState: "other",
    itemizedMortgageInterest: "",
    itemizedSaltPaid: "",
    itemizedCharitable: "",
    itemizedOther: "",
    educationStudents: [],
    soleBeneficiary: true,
    primarySoleBeneficiaryOfSpouse: null,
    holdOn: false,
    heldTarget: null,
    projOpen: false,
    projHowOpen: false,
    projToAge: "95",
    projFromAge: "",
    projTaxableStart: "",
    projRothStart: "",
    projReturnPct: "",
    projDrawMode: "repeat",
    projMoneyOutKind: "conversion",
    projStopKind: "none",
    projStopValue: "",
    projSsPrimaryClaimAge: "",
    projSsSpouseClaimAge: "",
    projSsPrimaryAnnual: "",
    projSsSpouseAnnual: "",
    projAcaSizeAfter: "",
    projAcaStepYear: "",
    projSelectedYear: null,
    projTemplate: null,
    openSections: { year: true, income: true, conversion: true, stock: true, aca: true, spending: true },
    groupOpen: { single: true, projection: true },
  };
}
function parsePgBenchmarkSource(
  v: unknown,
): PlaygroundFormState["benchmarkSource"] {
  if (v == null || typeof v !== "object" || Array.isArray(v)) return null;
  const b = v as Record<string, unknown>;
  const kinds = ["family", "couple", "couple-fallback", "single"] as const;
  if (
    typeof b.kind === "string" &&
    (kinds as readonly string[]).includes(b.kind) &&
    typeof b.value === "number" &&
    Number.isFinite(b.value)
  ) {
    return { kind: b.kind as (typeof kinds)[number], value: b.value };
  }
  return null;
}
/* Lenient read of one income dial's provenance record
   (build v150): a well-formed record survives; anything
   else reads as null (no recorded source), exactly like a
   blob written before the field existed. A "return" record
   keeps a null year (the record never named the return's
   year); a "plan" record without a usable year is not a
   record at all. */
function parsePgIncomeSource(v: unknown): PgIncomeSourceState {
  if (v == null || typeof v !== "object" || Array.isArray(v)) return null;
  const s = v as Record<string, unknown>;
  const yearOf = (x: unknown): number | null =>
    typeof x === "number" && Number.isInteger(x) && x >= 1900 && x <= 2200
      ? x
      : null;
  if (s.kind === "typed") return { kind: "typed" };
  if (s.kind === "plan") {
    const y = yearOf(s.year);
    return y != null ? { kind: "plan", year: y } : null;
  }
  if (s.kind === "return") {
    if (s.year == null) return { kind: "return", year: null };
    const y = yearOf(s.year);
    return y != null ? { kind: "return", year: y } : null;
  }
  return null;
}
/* Lenient read of the projection template snapshot: every
   required field must be present and well-typed, or the whole
   snapshot reads as null (no snapshot — the view captures a
   fresh one when the panel opens). A malformed snapshot can
   never half-load and mis-base the projection. */
function parsePgProjTemplate(
  v: unknown,
): PlaygroundFormState["projTemplate"] {
  if (v == null || typeof v !== "object" || Array.isArray(v)) return null;
  const t = v as Record<string, unknown>;
  const num = (x: unknown): number | null =>
    typeof x === "number" && Number.isFinite(x) ? x : null;
  const numOrNull = (x: unknown): number | null | undefined =>
    x === null ? null : num(x) ?? undefined;
  const taxYear = num(t.taxYear);
  const agePrimary = num(t.agePrimary);
  const ageSpouse = numOrNull(t.ageSpouse);
  const interest = num(t.interest);
  const ordinaryDividends = num(t.ordinaryDividends);
  const otherOrdinary = num(t.otherOrdinary);
  const taxExemptInterest = num(t.taxExemptInterest);
  const ssPrimary = num(t.ssPrimary);
  const ssSpouse = num(t.ssSpouse);
  const conversion = num(t.conversion);
  /* The spending draw (R3-M1) is lenient like the spouse
     balance above: absent (a template written before it
     existed) parses as 0 — no draw captured — and it is
     deliberately NOT in the rejection check below. */
  const spendingDraw = num(t.spendingDraw) ?? 0;
  const stockSold = num(t.stockSold);
  const stockBasis = num(t.stockBasis);
  const qualifiedDividends = num(t.qualifiedDividends);
  const pretaxBalance = numOrNull(t.pretaxBalance);
  /* Absent (a template written before this field existed)
     parses as null — no spouse balance, no spouse RMD —
     so old templates still load and price exactly as
     before. It is deliberately NOT in the rejection check
     below. */
  const pretaxBalanceSpouse = numOrNull(t.pretaxBalanceSpouse);
  /* The inflation rate (S-4) is lenient the same way:
     absent (a template written before it existed) parses
     as null — no rate captured, the projected years price
     undeflated, exactly as before — and it is likewise
     NOT in the rejection check below. */
  const inflationPct = numOrNull(t.inflationPct);
  /* The reciprocal beneficiary fact (N-1) is lenient the
     same way: absent (a template written before it
     existed) parses as null — not established, exactly
     as before — a stored boolean stands, anything else
     reads as null, and it is likewise NOT in the
     rejection check below. */
  const primarySoleBeneficiaryOfSpouse =
    typeof t.primarySoleBeneficiaryOfSpouse === "boolean"
      ? t.primarySoleBeneficiaryOfSpouse
      : null;
  const acaHouseholdSize = numOrNull(t.acaHouseholdSize);
  const acaBenchmarkAnnual = numOrNull(t.acaBenchmarkAnnual);
  /* The P-S8 facts are lenient like the spending draw
     above: a template written before they were carried
     parses each at its no-fact value — the settlement
     facts, the health premiums, the RMD received, the
     dependent MAGI, the annual spending, and the harvest
     pair as null (no settlement, no premium, no verdict,
     no harvest priced), the carry-ins and funding draws
     as 0, the reinvested-yield flag as false — every one
     the pricer's absent reading, so an older stored
     template loads and prices exactly as the lossy
     restore priced it. None is in the rejection check
     below. */
  const aptcTaken = numOrNull(t.aptcTaken) ?? null;
  const acaCoverageReduction = numOrNull(t.acaCoverageReduction) ?? null;
  const acaEnrollmentPremiumAnnual =
    numOrNull(t.acaEnrollmentPremiumAnnual) ?? null;
  const healthPremiumAcaAnnual = numOrNull(t.healthPremiumAcaAnnual) ?? null;
  const healthPremiumMedicarePerPerson =
    numOrNull(t.healthPremiumMedicarePerPerson) ?? null;
  const capitalLossCarryInSt = num(t.capitalLossCarryInSt) ?? 0;
  const capitalLossCarryInLt = num(t.capitalLossCarryInLt) ?? 0;
  const capitalLossCarryInStWa = num(t.capitalLossCarryInStWa) ?? 0;
  const capitalLossCarryInLtWa = num(t.capitalLossCarryInLtWa) ?? 0;
  const rmdAlreadyReceived = numOrNull(t.rmdAlreadyReceived) ?? null;
  const dependentMagiForAca = numOrNull(t.dependentMagiForAca) ?? null;
  const cashDraw = num(t.cashDraw) ?? 0;
  const rothDraw = num(t.rothDraw) ?? 0;
  const yieldReinvested =
    typeof t.yieldReinvested === "boolean" ? t.yieldReinvested : false;
  const annualSpending = numOrNull(t.annualSpending) ?? null;
  const harvestPoolAmount = numOrNull(t.harvestPoolAmount) ?? null;
  const harvestPoolBasisPct = numOrNull(t.harvestPoolBasisPct) ?? null;
  const stateRatePct = num(t.stateRatePct);
  const itemizedMortgageInterest = num(t.itemizedMortgageInterest);
  const itemizedSaltPaid = num(t.itemizedSaltPaid);
  const itemizedCharitable = num(t.itemizedCharitable);
  const itemizedOther = num(t.itemizedOther);
  if (
    taxYear == null ||
    !Number.isInteger(taxYear) ||
    agePrimary == null ||
    ageSpouse === undefined ||
    interest == null ||
    ordinaryDividends == null ||
    otherOrdinary == null ||
    taxExemptInterest == null ||
    ssPrimary == null ||
    ssSpouse == null ||
    conversion == null ||
    stockSold == null ||
    stockBasis == null ||
    qualifiedDividends == null ||
    pretaxBalance === undefined ||
    acaHouseholdSize === undefined ||
    acaBenchmarkAnnual === undefined ||
    stateRatePct == null ||
    itemizedMortgageInterest == null ||
    itemizedSaltPaid == null ||
    itemizedCharitable == null ||
    itemizedOther == null ||
    (t.filingStatus !== "mfj" && t.filingStatus !== "single" && t.filingStatus !== "hoh") ||
    typeof t.onMedicarePrimary !== "boolean" ||
    typeof t.onMedicareSpouse !== "boolean" ||
    typeof t.spouseSoleBeneficiary !== "boolean" ||
    (t.residenceState !== "WA" && t.residenceState !== "other")
  ) {
    return null;
  }
  let educationStudents: { expenses: number; aotcEligible: boolean }[] | null =
    null;
  if (Array.isArray(t.educationStudents)) {
    const rows: { expenses: number; aotcEligible: boolean }[] = [];
    for (const rawRow of t.educationStudents as unknown[]) {
      if (rawRow == null || typeof rawRow !== "object") return null;
      const row = rawRow as Record<string, unknown>;
      const expenses = num(row.expenses);
      if (expenses == null || typeof row.aotcEligible !== "boolean") return null;
      rows.push({ expenses, aotcEligible: row.aotcEligible });
    }
    educationStudents = rows;
  } else if (t.educationStudents !== null && t.educationStudents !== undefined) {
    return null;
  }
  return {
    taxYear,
    filingStatus: t.filingStatus as "mfj" | "single" | "hoh",
    agePrimary,
    ageSpouse,
    onMedicarePrimary: t.onMedicarePrimary as boolean,
    onMedicareSpouse: t.onMedicareSpouse as boolean,
    interest,
    ordinaryDividends,
    otherOrdinary,
    taxExemptInterest,
    ssPrimary,
    ssSpouse,
    conversion,
    spendingDraw,
    stockSold,
    stockBasis,
    qualifiedDividends,
    pretaxBalance,
    pretaxBalanceSpouse: pretaxBalanceSpouse ?? null,
    spouseSoleBeneficiary: t.spouseSoleBeneficiary as boolean,
    primarySoleBeneficiaryOfSpouse,
    acaHouseholdSize,
    acaBenchmarkAnnual,
    aptcTaken,
    acaCoverageReduction,
    acaEnrollmentPremiumAnnual,
    healthPremiumAcaAnnual,
    healthPremiumMedicarePerPerson,
    capitalLossCarryInSt,
    capitalLossCarryInLt,
    capitalLossCarryInStWa,
    capitalLossCarryInLtWa,
    rmdAlreadyReceived,
    dependentMagiForAca,
    cashDraw,
    rothDraw,
    yieldReinvested,
    annualSpending,
    harvestPoolAmount,
    harvestPoolBasisPct,
    stateRatePct,
    residenceState: t.residenceState as "WA" | "other",
    itemizedMortgageInterest,
    itemizedSaltPaid,
    itemizedCharitable,
    itemizedOther,
    educationStudents,
    inflationPct: inflationPct ?? null,
  };
}
function parsePgOpenSections(
  v: unknown,
): PlaygroundFormState["openSections"] {
  const out: PlaygroundFormState["openSections"] = {
    year: true,
    income: true,
    conversion: true,
    stock: true,
    aca: true,
    spending: true,
  };
  if (v == null || typeof v !== "object" || Array.isArray(v)) return out;
  const o = v as Record<string, unknown>;
  for (const id of PG_SECTION_IDS) {
    if (typeof o[id] === "boolean") out[id] = o[id] as boolean;
  }
  return out;
}
/* Lenient read of the super-group folds, field by field like
   parsePgOpenSections: each group defaults OPEN, and only a
   stored boolean overrides it, so a missing or malformed
   groupOpen (or one malformed side of it) opens the groups
   exactly as the view always has. */
function parsePgGroupOpen(
  v: unknown,
): PlaygroundFormState["groupOpen"] {
  const out: PlaygroundFormState["groupOpen"] = {
    single: true,
    projection: true,
  };
  if (v == null || typeof v !== "object" || Array.isArray(v)) return out;
  const o = v as Record<string, unknown>;
  if (typeof o.single === "boolean") out.single = o.single;
  if (typeof o.projection === "boolean") out.projection = o.projection;
  return out;
}
export type RothUiState = {
  open: Record<RothSectionId, boolean>;
  yearTableOpen: boolean;
  mode: RothResultsMode;
  labDials: RothLabDials;
  // The Playground view's remembered form state (see
  // playgroundFormState above). A blob written before this
  // field existed parses with the fresh-form defaults.
  playground: PlaygroundFormState;
  // The Strategy Lab's chosen baseline: a saved scenario's
  // name, or one of the client's reserved row labels. Display
  // state only — pricing reads it as the compare's baseline
  // name at run time. Null = the Lab default (Do Nothing).
  labBaselineName: string | null;
  labDialsOpen: boolean;
  // The Plan tab "Watch-outs" panel's open flag. Default true
  // (expanded): warnings are never hidden by default, and an
  // absent key in a stored blob reads as expanded; only an
  // explicit collapse persists as false.
  watchOutsOpen: boolean;
  // The "Assumptions & limits" section's open flag (rendered at
  // the foot of every Roth workspace). Default false (closed),
  // matching its long-standing first-open behaviour.
  assumptionsOpen: boolean;
  // The Plan tab's Custom… ceiling panel open flag. Default
  // false (closed); a blob written before this field existed
  // parses it false. The Roth view ORs it on load with its
  // auto-open rule (a saved plan whose ceilings match no
  // preset opens the panel), and a close the user chooses
  // persists here as false.
  ceilCustomOpen: boolean;
  // The three workspaces' "More" how-it-is-priced expanders
  // (Work years, Gift stock, Optimize) and the execution
  // year's "Show the math" expander (collapse-persistence
  // build): each defaults false (collapsed — the views'
  // long-standing first-open behaviour), and a blob written
  // before these fields existed parses them false.
  wyHowOpen: boolean;
  giftHowOpen: boolean;
  optHowOpen: boolean;
  execDetailOpen: boolean;
  // The year-by-year table's expanded detail year ("Show the
  // math" drill-down): the calendar year whose engine detail
  // panel is open under the table, or null when none is
  // (collapse-persistence build). Default null; a blob
  // written before this field existed parses it null, and a
  // malformed value (non-integer, out of range) reads as null.
  detailYear: number | null;
  // The blob's write revision (CAS — see the header comment).
  // 0 for a blob written before revisions existed; every
  // accepted write stores the previous revision + 1.
  revision: number;
};
export const rothUiStateResponse = z.object({
  open: z.object({
    household: z.boolean(),
    money: z.boolean(),
    income: z.boolean(),
    aca: z.boolean(),
    advanced: z.boolean(),
  }),
  yearTableOpen: z.boolean(),
  mode: z.enum(ROTH_RESULTS_MODES),
  labDials: rothLabDials,
  playground: playgroundFormState,
  labBaselineName: z.string().nullable(),
  labDialsOpen: z.boolean(),
  watchOutsOpen: z.boolean(),
  assumptionsOpen: z.boolean(),
  ceilCustomOpen: z.boolean(),
  wyHowOpen: z.boolean(),
  giftHowOpen: z.boolean(),
  optHowOpen: z.boolean(),
  execDetailOpen: z.boolean(),
  detailYear: z.number().int().min(1900).max(2200).nullable(),
  revision: z.number().int().nonnegative(),
});
function defaultRothUiState(): RothUiState {
  return {
    open: { household: true, money: true, income: true, aca: true, advanced: false },
    yearTableOpen: false,
    mode: "plan",
    labDials: blankLabDials(),
    playground: defaultPlaygroundFormState(),
    labBaselineName: null,
    labDialsOpen: false,
    watchOutsOpen: true,
    assumptionsOpen: false,
    ceilCustomOpen: false,
    wyHowOpen: false,
    giftHowOpen: false,
    optHowOpen: false,
    execDetailOpen: false,
    detailYear: null,
    revision: 0,
  };
}
export function parseRothUiState(raw: string | undefined): RothUiState {
  const out = defaultRothUiState();
  if (!raw) return out;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return out;
    const p = parsed as {
      open?: unknown;
      yearTableOpen?: unknown;
      mode?: unknown;
      labDials?: unknown;
      playground?: unknown;
      labBaselineName?: unknown;
      labDialsOpen?: unknown;
      watchOutsOpen?: unknown;
      assumptionsOpen?: unknown;
      ceilCustomOpen?: unknown;
      wyHowOpen?: unknown;
      giftHowOpen?: unknown;
      optHowOpen?: unknown;
      execDetailOpen?: unknown;
      detailYear?: unknown;
      revision?: unknown;
    };
    if (p.open != null && typeof p.open === "object" && !Array.isArray(p.open)) {
      const o = p.open as Record<string, unknown>;
      for (const id of ROTH_SECTION_IDS) {
        if (typeof o[id] === "boolean") out.open[id] = o[id] as boolean;
      }
    }
    if (typeof p.yearTableOpen === "boolean") out.yearTableOpen = p.yearTableOpen;
    if (
      typeof p.mode === "string" &&
      (ROTH_RESULTS_MODES as readonly string[]).includes(p.mode)
    ) {
      out.mode = p.mode as RothResultsMode;
    }
    if (p.labDials != null && typeof p.labDials === "object" && !Array.isArray(p.labDials)) {
      const d = p.labDials as Record<string, unknown>;
      const num = (v: unknown): number | null =>
        typeof v === "number" && Number.isFinite(v) ? v : null;
      out.labDials = {
        basisPct: num(d.basisPct),
        spendingCents: num(d.spendingCents),
        ssPrimaryStartAge: num(d.ssPrimaryStartAge),
        ssSpouseStartAge: num(d.ssSpouseStartAge),
        survivorEnabled: typeof d.survivorEnabled === "boolean" ? d.survivorEnabled : null,
        survivorWho:
          d.survivorWho === "primary" || d.survivorWho === "spouse" ? d.survivorWho : null,
        survivorDeathYear: num(d.survivorDeathYear),
        acaSpouseEndAge: num(d.acaSpouseEndAge),
        acaBenchmarkFamilyCents: num(d.acaBenchmarkFamilyCents),
        acaBenchmarkCoupleCents: num(d.acaBenchmarkCoupleCents),
        acaBenchmarkSingleCents: num(d.acaBenchmarkSingleCents),
        healthPremiumAcaHouseholdCents: num(d.healthPremiumAcaHouseholdCents),
        healthPremiumAcaSingleCents: num(d.healthPremiumAcaSingleCents),
        healthPremiumMedicarePerPersonCents: num(d.healthPremiumMedicarePerPersonCents),
        // The schedule dial, read leniently like every field
        // here: keep the well-formed entries of a stored array
        // (integer year 1900–2200, integer size 1–20), sorted
        // ascending with a repeated year deduped last-wins —
        // the same sanitization the plan record's resolver
        // applies; anything else reads as null = no override.
        acaHouseholdSchedule: ((): RothLabDials["acaHouseholdSchedule"] => {
          if (!Array.isArray(d.acaHouseholdSchedule)) return null;
          const byYear = new Map<number, number>();
          for (const rawEntry of d.acaHouseholdSchedule as unknown[]) {
            if (rawEntry == null || typeof rawEntry !== "object") continue;
            const e = rawEntry as Record<string, unknown>;
            const fromYear = num(e.fromYear);
            const householdSize = num(e.householdSize);
            if (
              fromYear == null ||
              !Number.isInteger(fromYear) ||
              fromYear < 1900 ||
              fromYear > 2200 ||
              householdSize == null ||
              !Number.isInteger(householdSize) ||
              householdSize < 1 ||
              householdSize > 20
            )
              continue;
            byYear.set(fromYear, householdSize);
          }
          if (byYear.size === 0) return null;
          return [...byYear.entries()]
            .sort((a, b) => a[0] - b[0])
            .slice(0, 40)
            .map(([fromYear, householdSize]) => ({ fromYear, householdSize }));
        })(),
        expectedReturnPct: num(d.expectedReturnPct),
        inflationPct: num(d.inflationPct),
        heirRatePct: num(d.heirRatePct),
        stateRatePct: num(d.stateRatePct),
        windowStartAge: num(d.windowStartAge),
        windowStopAge: num(d.windowStopAge),
        preservePretaxCents: num(d.preservePretaxCents),
        pretaxCents: num(d.pretaxCents),
        taxableCents: num(d.taxableCents),
        rothCents: num(d.rothCents),
      };
    }
    if (
      p.playground != null &&
      typeof p.playground === "object" &&
      !Array.isArray(p.playground)
    ) {
      // Field-by-field defensive parse: any field of the wrong
      // type falls back to its fresh-form default, so a
      // partial or malformed saved form can never break the
      // Playground — it just opens closer to blank.
      const g = p.playground as Record<string, unknown>;
      const d = defaultPlaygroundFormState();
      const str = (v: unknown, dflt: string): string =>
        typeof v === "string" ? v : dflt;
      const boolOrNull = (v: unknown): boolean | null =>
        typeof v === "boolean" ? v : null;
      out.playground = {
        year: str(g.year, d.year),
        filing:
          g.filing === "mfj" || g.filing === "single" || g.filing === "hoh"
            ? g.filing
            : "mfj",
        agePrimary: str(g.agePrimary, ""),
        ageSpouse: str(g.ageSpouse, ""),
        medicarePrimary: boolOrNull(g.medicarePrimary),
        medicareSpouse: boolOrNull(g.medicareSpouse),
        interest: str(g.interest, ""),
        ordinaryDividends: str(g.ordinaryDividends, ""),
        otherOrdinary: str(g.otherOrdinary, ""),
        taxExemptInterest: str(g.taxExemptInterest, ""),
        ssPrimary: str(g.ssPrimary, ""),
        ssSpouse: str(g.ssSpouse, ""),
        conversion: str(g.conversion, ""),
        spendingDraw: str(g.spendingDraw, ""),
        stockSold: str(g.stockSold, ""),
        stockBasis: str(g.stockBasis, ""),
        qualifiedDividends: str(g.qualifiedDividends, ""),
        pretaxBalance: str(g.pretaxBalance, ""),
        pretaxBalanceSpouse: str(g.pretaxBalanceSpouse, ""),
        acaHouseholdSize: str(g.acaHouseholdSize, ""),
        acaBenchmark: str(g.acaBenchmark, ""),
        healthPremiumAca: str(g.healthPremiumAca, ""),
        healthPremiumMedicare: str(g.healthPremiumMedicare, ""),
        aptcTaken: str(g.aptcTaken, ""),
        acaCoverageReduction: str(g.acaCoverageReduction, ""),
        capitalLossCarryInSt: str(g.capitalLossCarryInSt, ""),
        capitalLossCarryInLt: str(g.capitalLossCarryInLt, ""),
        capitalLossCarryInStWa: str(g.capitalLossCarryInStWa, ""),
        capitalLossCarryInLtWa: str(g.capitalLossCarryInLtWa, ""),
        rmdAlreadyReceived: str(g.rmdAlreadyReceived, ""),
        dependentMagiForAca: str(g.dependentMagiForAca, ""),
        cashDraw: str(g.cashDraw, ""),
        rothDraw: str(g.rothDraw, ""),
        yieldReinvested:
          typeof g.yieldReinvested === "boolean" ? g.yieldReinvested : false,
        acaBuffer: str(g.acaBuffer, "5000"),
        benchmarkSource: parsePgBenchmarkSource(g.benchmarkSource),
        incomeSources: ((): PlaygroundFormState["incomeSources"] => {
          const raw =
            g.incomeSources != null &&
            typeof g.incomeSources === "object" &&
            !Array.isArray(g.incomeSources)
              ? (g.incomeSources as Record<string, unknown>)
              : {};
          return {
            interest: parsePgIncomeSource(raw.interest),
            ordinaryDividends: parsePgIncomeSource(raw.ordinaryDividends),
            qualifiedDividends: parsePgIncomeSource(raw.qualifiedDividends),
          };
        })(),
        stateRate: str(g.stateRate, "0"),
        residenceState: g.residenceState === "WA" ? "WA" : "other",
        itemizedMortgageInterest: str(g.itemizedMortgageInterest, ""),
        itemizedSaltPaid: str(g.itemizedSaltPaid, ""),
        itemizedCharitable: str(g.itemizedCharitable, ""),
        itemizedOther: str(g.itemizedOther, ""),
        // Education students (T6), read leniently like every
        // field here: keep the well-formed rows of a stored
        // array (a string expense and a boolean mark);
        // anything else reads as no students.
        educationStudents: ((): { expenses: string; aotcEligible: boolean }[] => {
          if (!Array.isArray(g.educationStudents)) return [];
          const rows: { expenses: string; aotcEligible: boolean }[] = [];
          for (const rawRow of g.educationStudents as unknown[]) {
            if (rawRow == null || typeof rawRow !== "object") continue;
            const row = rawRow as Record<string, unknown>;
            if (typeof row.aotcEligible !== "boolean") continue;
            rows.push({
              expenses: str(row.expenses, ""),
              aotcEligible: row.aotcEligible,
            });
            if (rows.length >= 12) break;
          }
          return rows;
        })(),
        soleBeneficiary:
          typeof g.soleBeneficiary === "boolean" ? g.soleBeneficiary : true,
        // The reciprocal beneficiary fact (N-1), read
        // leniently like its sibling: a stored boolean
        // stands; absent (a blob written before the field
        // existed) or malformed reads as null — not
        // established, the spouse's RMD prices Uniform.
        primarySoleBeneficiaryOfSpouse: boolOrNull(
          g.primarySoleBeneficiaryOfSpouse,
        ),
        holdOn: typeof g.holdOn === "boolean" ? g.holdOn : false,
        projOpen: typeof g.projOpen === "boolean" ? g.projOpen : false,
        projHowOpen: typeof g.projHowOpen === "boolean" ? g.projHowOpen : false,
        projToAge: str(g.projToAge, "95"),
        projFromAge: str(g.projFromAge, ""),
        projTaxableStart: str(g.projTaxableStart, ""),
        projRothStart: str(g.projRothStart, ""),
        projReturnPct: str(g.projReturnPct, ""),
        projDrawMode: g.projDrawMode === "replace" ? "replace" : "repeat",
        projMoneyOutKind: g.projMoneyOutKind === "draw" ? "draw" : "conversion",
        projStopKind:
          g.projStopKind === "age" || g.projStopKind === "floor"
            ? g.projStopKind
            : "none",
        projStopValue: str(g.projStopValue, ""),
        projSsPrimaryClaimAge: str(g.projSsPrimaryClaimAge, ""),
        projSsSpouseClaimAge: str(g.projSsSpouseClaimAge, ""),
        projSsPrimaryAnnual: str(g.projSsPrimaryAnnual, ""),
        projSsSpouseAnnual: str(g.projSsSpouseAnnual, ""),
        projAcaSizeAfter: str(g.projAcaSizeAfter, ""),
        projAcaStepYear: str(g.projAcaStepYear, ""),
        projSelectedYear:
          typeof g.projSelectedYear === "number" &&
          Number.isInteger(g.projSelectedYear) &&
          g.projSelectedYear >= 1900 &&
          g.projSelectedYear <= 2200
            ? g.projSelectedYear
            : null,
        // A stored blob may still carry the retired chartMode
        // key (the chart card's old Stack | Waterfall toggle —
        // including a form saved in "waterfall"). It is
        // deliberately not read: the card is stack-only now, so
        // such a blob parses exactly like any other and opens
        // on the stack, and the key drops out of the blob on
        // the next write.
        projTemplate: parsePgProjTemplate(g.projTemplate),
        heldTarget:
          g.heldTarget === "aca"
            ? "aca"
            : typeof g.heldTarget === "number" && Number.isFinite(g.heldTarget)
              ? g.heldTarget
              : null,
        openSections: parsePgOpenSections(g.openSections),
        groupOpen: parsePgGroupOpen(g.groupOpen),
      };
    }
    if (typeof p.labBaselineName === "string" && p.labBaselineName !== "") {
      out.labBaselineName = p.labBaselineName;
    }
    if (typeof p.labDialsOpen === "boolean") out.labDialsOpen = p.labDialsOpen;
    if (typeof p.watchOutsOpen === "boolean") out.watchOutsOpen = p.watchOutsOpen;
    if (typeof p.assumptionsOpen === "boolean") out.assumptionsOpen = p.assumptionsOpen;
    if (typeof p.ceilCustomOpen === "boolean") out.ceilCustomOpen = p.ceilCustomOpen;
    if (typeof p.wyHowOpen === "boolean") out.wyHowOpen = p.wyHowOpen;
    if (typeof p.giftHowOpen === "boolean") out.giftHowOpen = p.giftHowOpen;
    if (typeof p.optHowOpen === "boolean") out.optHowOpen = p.optHowOpen;
    if (typeof p.execDetailOpen === "boolean") out.execDetailOpen = p.execDetailOpen;
    if (
      typeof p.detailYear === "number" &&
      Number.isInteger(p.detailYear) &&
      p.detailYear >= 1900 &&
      p.detailYear <= 2200
    ) {
      out.detailYear = p.detailYear;
    }
    // Lenient revision read: only a non-negative integer
    // counts; a missing, fractional, negative, or non-numeric
    // revision reads as 0, exactly like a legacy blob written
    // before revisions existed.
    if (
      typeof p.revision === "number" &&
      Number.isInteger(p.revision) &&
      p.revision >= 0
    ) {
      out.revision = p.revision;
    }
    return out;
  } catch {
    return out;
  }
}

/* ---------------- UI-state write contract (CAS) ----------------
   setRothUiState's response: an accepted write returns the
   revision it stored; a refused write returns the CURRENT
   stored blob and its revision, so the writer can re-merge
   against it and retry at the fresh revision. Storage is left
   untouched on a refusal — there is no raw form to persist. */
export const setRothUiStateResponse = z.union([
  z.object({ ok: z.literal(true), revision: z.number().int().nonnegative() }),
  z.object({
    ok: z.literal(false),
    conflict: z.literal(true),
    revision: z.number().int().nonnegative(),
    state: rothUiStateResponse,
  }),
]);
export type SetRothUiStateResponse = z.infer<typeof setRothUiStateResponse>;

/* The CAS decision for one write, given the stored revision
   and the writer's base revision. baseRevision is REQUIRED
   (audit N-2, mirroring saveRothInputs' strict decision
   decideRothBlobWriteChecked): a missing base is refused,
   exactly like a stale base — there is no unchecked write
   path into this blob. A supplied base must match the stored
   revision exactly; anything else means a newer write landed
   first and this write must not clobber it. First-ever
   creation still works: base 0 against an absent row (which
   reads as revision 0) is allowed and stores revision 1. */
export type RothUiCasDecision =
  | { allowed: true; nextRevision: number }
  | { allowed: false; storedRevision: number };

export function decideRothUiWrite(
  storedRevision: number,
  baseRevision: number | undefined,
): RothUiCasDecision {
  if (baseRevision === undefined) {
    return { allowed: false, storedRevision };
  }
  if (baseRevision !== storedRevision) {
    return { allowed: false, storedRevision };
  }
  return { allowed: true, nextRevision: storedRevision + 1 };
}

/* The strict CAS decision — setRothUiState's decision, named
   for parity with saveRothInputs' decideRothBlobWriteChecked.
   It is exactly decideRothUiWrite above, which is itself
   strict (this blob has no other writer that needs a lenient
   form): baseRevision is required on every call, and a
   missing or stale base is refused with the stored revision
   so the caller can fetch the current blob and retry. */
export function decideRothUiWriteChecked(
  storedRevision: number,
  baseRevision: number | undefined,
): RothUiCasDecision {
  return decideRothUiWrite(storedRevision, baseRevision);
}

/* Write-time normalization for labBaselineName: the request
   schema accepts "" (a cleared name), the reader has always
   read "" back as null, so the stored form is canonicalized
   to null at write time — schema, writer, reader, and stored
   form agree, and a nonempty name round-trips exactly. A blob
   stored before this normalization that carries "" still
   parses as null, exactly as it always has. */
export function normalizeRothUiStateForWrite(state: RothUiState): void {
  if (state.labBaselineName === "") state.labBaselineName = null;
}

export type RothUiWriteResult =
  | { status: "ok"; revision: number; state: RothUiState; raw: string }
  | { status: "conflict"; revision: number; state: RothUiState };

/* One complete UI-state write against the stored raw blob:
   parse, check the writer's base revision, apply the caller's
   field mutations, stamp the next revision, and serialize.
   On a conflict nothing is mutated and no raw form is
   produced — the caller persists `raw` only on "ok" and
   returns `state` to the refused writer. This is the exact
   code path the setRothUiState handler runs (its only I/O is
   reading and writing the settings row around this call), and
   the exact path the accuracy fixtures pin. */
export function applyRothUiWrite(
  storedRaw: string | undefined,
  baseRevision: number | undefined,
  mutate: (state: RothUiState) => void,
): RothUiWriteResult {
  const state = parseRothUiState(storedRaw);
  const decision = decideRothUiWrite(state.revision, baseRevision);
  if (!decision.allowed) {
    return { status: "conflict", revision: state.revision, state };
  }
  mutate(state);
  normalizeRothUiStateForWrite(state);
  state.revision = decision.nextRevision;
  return {
    status: "ok",
    revision: state.revision,
    state,
    raw: JSON.stringify(state),
  };
}

/* ---------------- Guarded commit (atomic CAS) ----------------
   applyRothUiWrite decides against the stored value the writer
   READ. Two invocations can both read revision N before either
   commits, both decide "allowed", and — if the commit were an
   unconditional upsert — the second would silently overwrite
   the first. The setRothUiState handler therefore commits a
   CAS write against an existing row with a single UPDATE
   whose WHERE clause requires the row to still hold the exact
   raw value the writer read (build v90: the blob is stored
   encrypted, so no revision can be read out of it in SQL —
   the guard is ciphertext byte equality, the Roth plan
   record's commitSettingsValueGuarded pattern, sound here
   because every encryption uses a fresh random nonce), and
   branches on the statement's affected-row count: exactly 1
   row is the commit; 0 rows means a concurrent write landed
   first, storage is untouched by that invocation, and the
   writer is refused with the current blob re-read after the
   failed update. (Before v90 the guard was a CASE over
   json_extract(value, '$.revision') reproducing
   parseRothUiState's lenient revision read; the predicate
   below still mirrors the revision decision the handler
   makes on the decrypted read.)

   The two functions below are that commit's testable mirror.
   rothUiStoredRevisionMatches mirrors the revision decision the
   handler makes on the DECRYPTED read — "the leniently parsed
   revision of THIS plaintext value equals the writer's base" —
   while the SQL guard itself is ciphertext byte equality (the
   stored raw value must still equal the value the writer read).
   commitGuardedRothUiWrite is a SINGLE-GATE mirror of the
   revision decision: its affected-rows verdict depends on that
   predicate alone, exactly as the handler's read-time decision
   does (in production the SQL raw-value predicate is the sole
   commit-time gate; the handler's JS decision runs earlier, on
   the stale decrypted pre-read).
   commitGuardedRothUiWrite evaluates a guarded commit against
   the stored value AS IT STANDS AT COMMIT TIME (not a stale
   read snapshot): predicate false → affectedRows 0 and no raw
   form to persist; predicate true → the write is applied
   against that current value and affects exactly 1 row, with
   applyRothUiWrite computing the committed blob but its
   decision never consulted for the verdict — otherwise a
   predicate broken to always match would be masked by the
   second gate and the fixtures could not catch it. The
   accuracy fixtures pin the interleaving the SQL guard exists
   for through these functions; the handler itself performs the
   same check atomically in SQL, because only the database can
   evaluate it without a gap between check and write. */
export function rothUiStoredRevisionMatches(
  storedRaw: string | undefined,
  baseRevision: number,
): boolean {
  return parseRothUiState(storedRaw).revision === baseRevision;
}

export type RothUiGuardedCommitResult =
  | { affectedRows: 1; revision: number; state: RothUiState; raw: string }
  | { affectedRows: 0; revision: number; state: RothUiState };

export function commitGuardedRothUiWrite(
  currentStoredRaw: string | undefined,
  baseRevision: number,
  mutate: (state: RothUiState) => void,
): RothUiGuardedCommitResult {
  // Single gate: the predicate alone decides the verdict.
  // applyRothUiWrite below only computes the blob a passing
  // commit persists; its decision is never consulted, so a
  // predicate broken to always match (or never match) moves
  // the verdict and the fixtures see it.
  if (!rothUiStoredRevisionMatches(currentStoredRaw, baseRevision)) {
    const current = parseRothUiState(currentStoredRaw);
    return { affectedRows: 0, revision: current.revision, state: current };
  }
  const res = applyRothUiWrite(currentStoredRaw, baseRevision, mutate);
  if (res.status === "ok") {
    return {
      affectedRows: 1,
      revision: res.revision,
      state: res.state,
      raw: res.raw,
    };
  }
  // Unreachable while the predicate above and decideRothUiWrite
  // agree (both compare the same leniently parsed revision to
  // the same base). The predicate passed, so the commit stands:
  // compute the blob the write applies against the stored value
  // directly, rather than let a decision this mirror does not
  // consult veto a verdict it does not own.
  const state = parseRothUiState(currentStoredRaw);
  mutate(state);
  normalizeRothUiStateForWrite(state);
  state.revision = state.revision + 1;
  return {
    affectedRows: 1,
    revision: state.revision,
    state,
    raw: JSON.stringify(state),
  };
}

/* ---------------- Insert-only first-write commit ----------------
   The first write of the blob (no stored row when the writer
   read) commits INSERT-ONLY — the same pattern the Roth plan
   record's first write uses (insertRothBlobValueIfAbsent in
   actions.ts) — never an unconditional upsert. Two writers
   can both read "no row" and both pass applyRothUiWrite's
   decision at baseRevision 0; the insert-only commit is what
   stops the second from silently overwriting the first: the
   row's existence at commit time is the sole gate. The loser
   is refused with the CURRENT blob re-read after the failed
   insert (the winner's state and revision), exactly like a
   sequential conflict.

   commitInsertOnlyRothUiWrite is that commit's testable
   mirror, the analogue of commitGuardedRothUiWrite above:
   evaluated against the stored value AS IT STANDS AT COMMIT
   TIME — a row present → affectedRows 0, no raw form to
   persist, and the current blob carried for the refusal; no
   row → the candidate the writer composed affects exactly
   1 row. In production the handler performs the same gate
   atomically with INSERT … ON CONFLICT DO NOTHING and
   branches on the returned row count. */
export type RothUiInsertOnlyCommitResult =
  | { affectedRows: 1; revision: number; state: RothUiState; raw: string }
  | { affectedRows: 0; revision: number; state: RothUiState };

export function commitInsertOnlyRothUiWrite(
  currentStoredRaw: string | undefined,
  candidate: { revision: number; state: RothUiState; raw: string },
): RothUiInsertOnlyCommitResult {
  if (currentStoredRaw !== undefined) {
    const current = parseRothUiState(currentStoredRaw);
    return { affectedRows: 0, revision: current.revision, state: current };
  }
  return {
    affectedRows: 1,
    revision: candidate.revision,
    state: candidate.state,
    raw: candidate.raw,
  };
}
