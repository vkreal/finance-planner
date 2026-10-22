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
   First use (no stored blob): only "Your money" is open, the
   year table is collapsed, and the results workspace is Plan.
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
   carries and retries at the fresh revision. A write with no
   baseRevision keeps the legacy unchecked behaviour; either
   way, an accepted write stores revision + 1. */
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
  acaHouseholdSizeAfter: z.number().int().min(1).max(20).nullable(),
  acaStepDownYear: z.number().int().min(1900).max(2200).nullable(),
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
  acaHouseholdSizeAfter: null,
  acaStepDownYear: null,
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
  stockSold: z.number(),
  stockBasis: z.number(),
  qualifiedDividends: z.number(),
  pretaxBalance: z.number().nullable(),
  spouseSoleBeneficiary: z.boolean(),
  acaHouseholdSize: z.number().nullable(),
  acaBenchmarkAnnual: z.number().nullable(),
  stateRatePct: z.number(),
  residenceState: z.enum(["WA", "other"]),
  itemizedMortgageInterest: z.number(),
  itemizedSaltPaid: z.number(),
  itemizedCharitable: z.number(),
  itemizedOther: z.number(),
  educationStudents: z
    .array(z.object({ expenses: z.number(), aotcEligible: z.boolean() }))
    .nullable(),
});
export type PlaygroundProjTemplateState = z.infer<
  typeof playgroundProjTemplateState
>;
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
  stockSold: z.string().max(64),
  stockBasis: z.string().max(64),
  qualifiedDividends: z.string().max(64),
  pretaxBalance: z.string().max(64),
  acaHouseholdSize: z.string().max(12),
  acaBenchmark: z.string().max(64),
  benchmarkSource: z
    .object({
      kind: z.enum(["family", "couple", "couple-fallback", "single"]),
      value: z.number(),
    })
    .nullable(),
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
  holdOn: z.boolean(),
  heldTarget: z.union([z.number(), z.literal("aca")]).nullable(),
  // Projection controls (Playground projection build): the
  // projection panel's own dials, in the form's typed-string
  // units like every other dial here. A blob written before
  // these fields existed parses them at the fresh defaults
  // (project to 95, repeat draw, conversions, no stop rule,
  // every override blank = follow the template / the plan).
  projOpen: z.boolean(),
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
  }),
});
export type PlaygroundFormState = z.infer<typeof playgroundFormState>;
const PG_SECTION_IDS = ["year", "income", "conversion", "stock", "aca"] as const;
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
    stockSold: "",
    stockBasis: "",
    qualifiedDividends: "",
    pretaxBalance: "",
    acaHouseholdSize: "",
    acaBenchmark: "",
    benchmarkSource: null,
    stateRate: "0",
    residenceState: "other",
    itemizedMortgageInterest: "",
    itemizedSaltPaid: "",
    itemizedCharitable: "",
    itemizedOther: "",
    educationStudents: [],
    soleBeneficiary: true,
    holdOn: false,
    heldTarget: null,
    projOpen: false,
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
    openSections: { year: true, income: true, conversion: true, stock: true, aca: true },
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
  const stockSold = num(t.stockSold);
  const stockBasis = num(t.stockBasis);
  const qualifiedDividends = num(t.qualifiedDividends);
  const pretaxBalance = numOrNull(t.pretaxBalance);
  const acaHouseholdSize = numOrNull(t.acaHouseholdSize);
  const acaBenchmarkAnnual = numOrNull(t.acaBenchmarkAnnual);
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
    stockSold,
    stockBasis,
    qualifiedDividends,
    pretaxBalance,
    spouseSoleBeneficiary: t.spouseSoleBeneficiary as boolean,
    acaHouseholdSize,
    acaBenchmarkAnnual,
    stateRatePct,
    residenceState: t.residenceState as "WA" | "other",
    itemizedMortgageInterest,
    itemizedSaltPaid,
    itemizedCharitable,
    itemizedOther,
    educationStudents,
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
  };
  if (v == null || typeof v !== "object" || Array.isArray(v)) return out;
  const o = v as Record<string, unknown>;
  for (const id of PG_SECTION_IDS) {
    if (typeof o[id] === "boolean") out[id] = o[id] as boolean;
  }
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
  revision: z.number().int().nonnegative(),
});
function defaultRothUiState(): RothUiState {
  return {
    open: { household: false, money: true, income: false, aca: false, advanced: false },
    yearTableOpen: false,
    mode: "plan",
    labDials: blankLabDials(),
    playground: defaultPlaygroundFormState(),
    labBaselineName: null,
    labDialsOpen: false,
    watchOutsOpen: true,
    assumptionsOpen: false,
    ceilCustomOpen: false,
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
        acaHouseholdSizeAfter: num(d.acaHouseholdSizeAfter),
        acaStepDownYear: num(d.acaStepDownYear),
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
        stockSold: str(g.stockSold, ""),
        stockBasis: str(g.stockBasis, ""),
        qualifiedDividends: str(g.qualifiedDividends, ""),
        pretaxBalance: str(g.pretaxBalance, ""),
        acaHouseholdSize: str(g.acaHouseholdSize, ""),
        acaBenchmark: str(g.acaBenchmark, ""),
        benchmarkSource: parsePgBenchmarkSource(g.benchmarkSource),
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
        holdOn: typeof g.holdOn === "boolean" ? g.holdOn : false,
        projOpen: typeof g.projOpen === "boolean" ? g.projOpen : false,
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
      };
    }
    if (typeof p.labBaselineName === "string" && p.labBaselineName !== "") {
      out.labBaselineName = p.labBaselineName;
    }
    if (typeof p.labDialsOpen === "boolean") out.labDialsOpen = p.labDialsOpen;
    if (typeof p.watchOutsOpen === "boolean") out.watchOutsOpen = p.watchOutsOpen;
    if (typeof p.assumptionsOpen === "boolean") out.assumptionsOpen = p.assumptionsOpen;
    if (typeof p.ceilCustomOpen === "boolean") out.ceilCustomOpen = p.ceilCustomOpen;
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
   and the writer's base revision. A writer that supplies no
   base keeps the legacy unchecked path and is always allowed.
   A supplied base must match the stored revision exactly;
   anything else means a newer write landed first and this
   write must not clobber it. */
export type RothUiCasDecision =
  | { allowed: true; nextRevision: number }
  | { allowed: false; storedRevision: number };

export function decideRothUiWrite(
  storedRevision: number,
  baseRevision: number | undefined,
): RothUiCasDecision {
  if (baseRevision !== undefined && baseRevision !== storedRevision) {
    return { allowed: false, storedRevision };
  }
  return { allowed: true, nextRevision: storedRevision + 1 };
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
   CAS write against an existing row with a single UPDATE whose
   WHERE clause re-checks the revision INSIDE the stored value
   at commit time (a CASE over json_extract(value, '$.revision')
   that reproduces parseRothUiState's lenient revision read:
   missing, non-integer, or negative counts as 0), and branches
   on the statement's affected-row count: exactly 1 row is the
   commit; 0 rows means the stored revision had already
   advanced past the writer's base, storage is untouched by
   that invocation, and the writer is refused with the current
   blob re-read after the failed update.

   The two functions below are that commit's testable mirror.
   rothUiStoredRevisionMatches is the exact predicate the SQL
   guard evaluates — "the leniently parsed revision of THIS
   stored value equals the writer's base" — and
   commitGuardedRothUiWrite is a SINGLE-GATE mirror of it: its
   affected-rows verdict depends on that predicate alone,
   exactly as the handler's commit does (in production the SQL
   CASE predicate is the sole commit-time gate; the handler's
   JS decision runs earlier, on the stale pre-read).
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
  state.revision = state.revision + 1;
  return {
    affectedRows: 1,
    revision: state.revision,
    state,
    raw: JSON.stringify(state),
  };
}
