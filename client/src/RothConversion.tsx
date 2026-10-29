import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
Area,
AreaChart,
CartesianGrid,
ComposedChart,
Legend,
Line,
ResponsiveContainer,
Tooltip,
XAxis,
YAxis,
} from "recharts";
import { api, type ApiResponse } from "./api";
import {
ceilChipActiveCls,
ceilChipCls,
ChangedMark,
FILING_LABELS,
fmtCents,
fmtCompactDollars,
fmtDollars,
fmtMoneyInput,
hintCls,
InfoNote,
inputCls,
labelCls,
moneyField,
numField,
parseDollars,
parseIntField,
parseMoney,
parseNum,
pctField,
sectionCls,
SEED_BIRTH_YEAR_PRIMARY,
SEED_BIRTH_YEAR_SPOUSE,
SEED_HEIR_RATE,
SEED_INFLATION,
SEED_PRESERVE_PRETAX_CENTS,
SEED_PROTECT_MIN_CENTS,
SEED_SS_PRIMARY_CENTS,
SEED_SS_START_AGE,
type FilingStatus,
type RetData,
type RothData,
} from "./rothShared";
// The tax engine and law tables live server-side (shared with the
// accuracy self-check fixtures) — see server/src/taxEngine.ts and
// server/src/taxLaw.ts. The client runs the same code the fixtures
// pin, so what is priced here is what is tested there.
import {
acaHouseholdSizeForYear,
DEFAULT_DRAW_ORDER_KEY,
DRAW_ORDER_OPTIONS,
ROTH_COMPARE_STRATEGIES,
drawOrderFromKey,
drawOrderKey,
drawOrderLabel,
irmaaTierUpTo,
simulateRothPlan,
type FillCeilings,
type RothPlanInputs,
type RothStrategy,
type RothYear,
} from "@space/server/taxEngine";
import { fplFor, lawForYear, rmdAgeForBirthYear } from "@space/server/taxLaw";
import { blendedExpected, STOCKS_PCT_DEFAULT } from "@space/server/retirementEngines";
import { fafsaReportableAssets, netCostBreakdown, priceExecutionYear, ROTH_MC_CHECK_SEED, ssAnnualAtClaimAge } from "@space/server/rothOptimizer";
import { giftAgeGuardMessage } from "@space/server/giftModel";
import { seedRothInputs, SEED_RETIREMENT_AGE_FALLBACK } from "@space/server/rothSeed";
import { FoldChevron } from "./FoldChevron";
import { usePersistedFold } from "./foldState";
import { December } from "./December";
import { ExplainerInfoTip } from "./Explainer";

// SavePayload is the plan record's writer (saveRothInputs) — the
// only payload that carries the execution-year fields. PlanPayload
// is the scenario / optimizer shape (rothInputFields alone):
// execution fields are plan-record only and never travel with a
// scenario or an optimizer request.
type SavePayload = Parameters<typeof api.saveRothInputs>[0];
type PlanPayload = Parameters<typeof api.saveRothScenario>[0];
type OptData = ApiResponse<typeof api, "runRothOptimizer">;
type OptScore = NonNullable<OptData["winner"]>;

// Net Worth bucket colors (same hexes as the Net Worth view, so a
// bucket reads the same colour everywhere in the app).
const BUCKET_COLORS = {
  "Pre-tax": "#e11d48",
  Roth: "#f59e0b",
  Taxable: "#3b82f6",
  HSA: "#14b8a6",
} as const;

// The Taxable starting balance is fed by TWO Net Worth buckets:
// Taxable plus Cash (the user's mapping — the taxable field is
// both the brokerage money and the bank money taxes are paid from
// and spending draws on). The 529 and Non-Taxable buckets are NOT
// counted into any starting balance. Null only when neither
// component bucket has a split anywhere in the snapshot.
function taxableSnapshotCents(snap: {
  taxableCents: number | null;
  cashCents: number | null;
} | null | undefined): number | null {
  if (!snap) return null;
  if (snap.taxableCents == null && snap.cashCents == null) return null;
  return (snap.taxableCents ?? 0) + (snap.cashCents ?? 0);
}

// Basis tiers from the Plan tab's editor rows: the saved
// {sharePct, basisPct} shape, or null when the rows do not
// (yet) describe a tier split — no rows, a row half-filled, or
// shares that do not add to 100. Null saves and prices as one
// pool at the basis %, so a half-edited tier list never
// reaches the record half-formed; the editor shows why the
// tiers are not applying yet whenever rows exist but this
// returns null.
function tiersFromRows(
  rows: { share: string; basis: string }[],
): { sharePct: number; basisPct: number }[] | null {
  if (rows.length === 0) return null;
  const tiers: { sharePct: number; basisPct: number }[] = [];
  for (const r of rows) {
    const sharePct = parseNum(r.share);
    const basisPct = parseNum(r.basis);
    if (sharePct == null || basisPct == null) return null;
    tiers.push({
      sharePct: Math.min(100, Math.max(0, sharePct)),
      basisPct: Math.min(100, Math.max(0, basisPct)),
    });
  }
  const sum = tiers.reduce((s, t) => s + t.sharePct, 0);
  if (Math.abs(sum - 100) > 0.01) return null;
  return tiers;
}

// Education students from the Plan tab's editor rows (T6
// build): the saved {year, expensesCents, aotcEligible}
// list, or null when the rows do not (yet) describe a
// complete list — no rows, or a row missing its year or its
// expenses. Null saves as "no expenses entered anywhere",
// so a half-edited student list never reaches the record
// half-formed; the editor shows why the entries are not
// applying yet whenever rows exist but this returns null.
// Each row is ONE student in ONE calendar year: the
// American Opportunity Credit prices per student, so two
// students in the same year are two rows with that year.
type EduStudentRow = { year: string; expenses: string; aotcEligible: boolean };
function studentsFromRows(
  rows: EduStudentRow[],
): { year: number; expensesCents: number; aotcEligible: boolean }[] | null {
  if (rows.length === 0) return null;
  const students: { year: number; expensesCents: number; aotcEligible: boolean }[] = [];
  for (const r of rows) {
    const y = parseIntField(r.year);
    const cents = parseMoney(r.expenses);
    if (y == null || cents == null) return null;
    students.push({
      year: Math.min(2200, Math.max(1900, y)),
      expensesCents: Math.max(0, cents),
      aotcEligible: r.aotcEligible,
    });
  }
  return students;
}

// ACA household-schedule rows (MULTI-STEP ACA HOUSEHOLD
// SCHEDULE build): the form's editable form of the plan's
// acaHouseholdSchedule — one row per step, the calendar year
// the step takes effect and the household size from that
// year on, both plain typed fields like every other dial.
// acaStepsFromRows mirrors studentsFromRows: no rows (or any
// half-filled row) reads as null = "no steps apply yet", so
// a half-edited step list never reaches the record
// half-formed, and the editor shows why the steps are not
// applying yet whenever rows exist but this returns null.
// Complete rows are clamped to the schedule's own ranges
// (year 1900–2200, size 1–20), sorted by year, and a repeated
// year keeps the LAST row for it — the saved shape's rules,
// applied at the same boundary the student rows use.
type AcaStepRow = { fromYear: string; householdSize: string };
function acaStepsFromRows(
  rows: AcaStepRow[],
): { fromYear: number; householdSize: number }[] | null {
  if (rows.length === 0) return null;
  const steps: { fromYear: number; householdSize: number }[] = [];
  for (const r of rows) {
    const y = parseIntField(r.fromYear);
    const s = parseIntField(r.householdSize);
    if (y == null || s == null) return null;
    steps.push({
      fromYear: Math.min(2200, Math.max(1900, y)),
      householdSize: Math.min(20, Math.max(1, s)),
    });
  }
  steps.sort((a, b) => a.fromYear - b.fromYear);
  const out: { fromYear: number; householdSize: number }[] = [];
  for (const s of steps) {
    if (out.length > 0 && out[out.length - 1]!.fromYear === s.fromYear) {
      out[out.length - 1] = s;
    } else {
      out.push(s);
    }
  }
  return out;
}
function acaStepRowsFrom(
  schedule: { fromYear: number; householdSize: number }[] | null | undefined,
): AcaStepRow[] {
  return (schedule ?? []).map((s) => ({
    fromYear: String(s.fromYear),
    householdSize: String(s.householdSize),
  }));
}

// Named conversion-ceiling presets: pure presentation over the
// saved ceiling fields. Each preset is one exact field
// combination (in the engine's FillCeilings terms — magiCap in
// dollars), applied by writing the same working state the
// Custom… controls edit, so a preset saves and prices exactly
// like the same combination set by hand. No preset state is
// stored anywhere: the active preset is derived by matching the
// current fields against these tuples.
const CEILING_PRESETS: { name: string; fields: FillCeilings }[] = [
  {
    name: "Fill 12%",
    fields: { bracketTopPct: 12, irmaaTierCap: null, ltcgZeroCap: false, acaCliffCap: false, acaCliffCapFamilyOnly: false, magiCap: null, acaCliffBuffer: null },
  },
  {
    name: "Fill 22%",
    fields: { bracketTopPct: 22, irmaaTierCap: null, ltcgZeroCap: false, acaCliffCap: false, acaCliffCapFamilyOnly: false, magiCap: null, acaCliffBuffer: null },
  },
  {
    name: "Under IRMAA Tier 1",
    fields: { bracketTopPct: null, irmaaTierCap: 1, ltcgZeroCap: false, acaCliffCap: false, acaCliffCapFamilyOnly: false, magiCap: null, acaCliffBuffer: null },
  },
  {
    name: "Under the ACA cliff",
    fields: { bracketTopPct: null, irmaaTierCap: null, ltcgZeroCap: false, acaCliffCap: true, acaCliffCapFamilyOnly: false, magiCap: null, acaCliffBuffer: null },
  },
];
const ceilingsMatchPreset = (c: FillCeilings, p: FillCeilings): boolean =>
  c.bracketTopPct === p.bracketTopPct &&
  c.irmaaTierCap === p.irmaaTierCap &&
  c.ltcgZeroCap === p.ltcgZeroCap &&
  c.acaCliffCap === p.acaCliffCap &&
  c.acaCliffCapFamilyOnly === p.acaCliffCapFamilyOnly &&
  c.magiCap === p.magiCap &&
  c.acaCliffBuffer === p.acaCliffBuffer;

// A draw-order key that is safe to put in a save payload: the
// key itself when it is one of the six the engine defines, the
// default order's key otherwise.
const asDrawOrderKey = (k: string): NonNullable<SavePayload["drawOrder"]> =>
  (DRAW_ORDER_OPTIONS.some((o) => o.key === k)
    ? k
    : DEFAULT_DRAW_ORDER_KEY) as NonNullable<SavePayload["drawOrder"]>;

type RothSectionId = "household" | "money" | "income" | "aca" | "advanced";
// The three results workspaces the segmented control switches
// between: the fill-to-target plan result, the lifetime-tax
// optimizer, and the strategy comparison + saved scenarios.
// Pure navigation — every workspace renders from the same
// working inputs and results state.
type RothResultsMode = "plan" | "optimize" | "compare" | "thisYear" | "yearFunding" | "workYears" | "gift" | "proof";
const PROOF_END_AGE = 110;
const ROTH_MODE_OPTIONS: { id: RothResultsMode; label: string }[] = [
  { id: "plan", label: "Plan" },
  { id: "optimize", label: "Optimize" },
  { id: "compare", label: "Strategy Lab" },
  { id: "thisYear", label: "This year" },
  { id: "yearFunding", label: "Year funding" },
  { id: "workYears", label: "Work years" },
  { id: "gift", label: "Gift stock" },
  { id: "proof", label: "Pretax Spending" },
];
// The segmented control renders only these workspaces. Optimize
// and Gift stock stay in the type, in the options list above,
// and in the tree — their workspaces render exactly as before
// when reached by code — but they are not offered as tabs.
const ROTH_MODE_OPTIONS_SHOWN = ROTH_MODE_OPTIONS.filter(
  (m) => m.id !== "optimize" && m.id !== "gift",
);
/* Watch-outs panel (Plan workspace) — collapsible, following the
   Playground collapsible-sections pattern: the heading itself is a
   toggle button carrying aria-expanded and the app's shared chip
   chevron (FoldChevron), and the heading stays visible when folded. The heading
   always shows the grouped-row count ("Watch-outs (2)") so a folded
   panel still signals what is inside it, and the heading text is
   red so the panel reads as a warning at a glance; the items
   themselves are neutral advisory rows (body text on the card,
   warning icon kept). Fold state lives in the Roth UI state
   (watchOutsOpen, persisted server-side like labDialsOpen) and is
   passed in by the caller: default OPEN whenever the key is
   absent, so warnings are never hidden by default, and a collapse
   the user chooses stays collapsed across reloads and devices.
   Folding is visual only: the warnings are computed by the caller
   exactly as before and rendered unchanged when open.
   GROUPING (presentation only — the engine's watch-out generation
   is untouched): warnings whose full rendered text is identical,
   figures included, collapse into one row, in first-appearance
   order, headed by the years and ages they cover. A group whose
   years run consecutively is headed by its first–last range; a
   group whose years do not run consecutively lists each year and
   age, so the heading never claims a year the warning did not
   fire in. A warning that occurs once renders exactly as before,
   with its single year and age. No warning text changes, no
   warning is dropped, and severity and icon are unchanged. */
const watchOutItemCls =
  "tnum inline-flex max-w-full items-start gap-1.5 rounded-[var(--radius)] border border-[var(--border)] px-2.5 py-1.5 text-xs text-[var(--text)] sm:text-sm";
type WatchOutWarning = { year: number; age: number; kind: string; text: string };
type GroupedWatchOut = { text: string; years: number[]; ages: number[] };
function groupWatchOuts(warnings: WatchOutWarning[]): GroupedWatchOut[] {
  const groups: GroupedWatchOut[] = [];
  const byText = new Map<string, GroupedWatchOut>();
  for (const w of warnings) {
    const existing = byText.get(w.text);
    if (existing) {
      existing.years.push(w.year);
      existing.ages.push(w.age);
    } else {
      const group: GroupedWatchOut = { text: w.text, years: [w.year], ages: [w.age] };
      byText.set(w.text, group);
      groups.push(group);
    }
  }
  return groups;
}
function watchOutHeading(group: GroupedWatchOut): string {
  const firstYear = group.years[0];
  const lastYear = group.years[group.years.length - 1];
  const firstAge = group.ages[0];
  const lastAge = group.ages[group.ages.length - 1];
  if (firstYear === undefined || lastYear === undefined || firstAge === undefined || lastAge === undefined) {
    return "";
  }
  if (group.years.length === 1) return `${firstYear} (age ${firstAge}):`;
  const consecutive = group.years.every(
    (year, i) => i === 0 || year === (group.years[i - 1] ?? year) + 1,
  );
  if (consecutive) return `${firstYear}–${lastYear} (ages ${firstAge}–${lastAge}):`;
  return `${group.years.join(", ")} (ages ${group.ages.join(", ")}):`;
}
function WatchOutsPanel({
  warnings,
  open,
  onToggle,
}: {
  warnings: WatchOutWarning[];
  open: boolean;
  onToggle: () => void;
}) {
  const rawId = useId();
  const panelId = `roth-watchouts-${rawId.replace(/[^a-zA-Z0-9]/g, "")}`;
  const groups = groupWatchOuts(warnings);
  if (groups.length === 0) return null;
  return (
    <section className={sectionCls} aria-label="Cliff warnings">
      <h2 className="text-base font-semibold">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          className="flex w-full items-center justify-between gap-3 text-left"
          onClick={onToggle}
        >
          <span className="text-[var(--bad)]">Watch-outs ({groups.length})</span>
          <FoldChevron open={open} />
        </button>
      </h2>
      {open && (
        <div id={panelId} className="mt-3 flex flex-col gap-2">
          {groups.map((g, i) => (
            <span key={`${g.years[0] ?? i}-${i}`} className={watchOutItemCls}>
              <span aria-hidden="true">⚠</span>
              <span>
                <strong>{watchOutHeading(g)}</strong>{" "}
                {g.text}
              </span>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

export function RothConversion() {
  const queryClient = useQueryClient();
  const rq = useQuery({ queryKey: ["rothplanner"], queryFn: () => api.getRothPlanner({}) });
  const retq = useQuery({
    queryKey: ["retirementcalc"],
    queryFn: () => api.getRetirementCalc({}),
  });
  const uiq = useQuery({ queryKey: ["rothui"], queryFn: () => api.getRothUiState({}) });
  const data: RothData | undefined = rq.data;
  const ret: RetData | undefined = retq.data;

  const [init, setInit] = useState(false);
  const [confirmResetBalances, setConfirmResetBalances] = useState(false);
  const [confirmResetPlan, setConfirmResetPlan] = useState(false);
  const [confirmBackToSaved, setConfirmBackToSaved] = useState(false);
  // Set by "Back to saved": the restore writes the saved
  // record's values into the form, and the autosave that state
  // change would normally schedule is skipped once — restoring
  // the saved values must not write anything. The next genuine
  // edit autosaves as usual.
  const suppressNextAutosaveRef = useRef(false);
  const [scenarioMsg, setScenarioMsg] = useState("");
  // The plan record's write revision (API follow-on 1): the CAS
  // base the next saveRothInputs autosave passes. Kept beside
  // the loaded record — set from the load, adopted from EVERY
  // writer response (plan save, scenario writes, reset), because
  // every accepted write bumps it, and a save based on a stale
  // revision is refused with the current record instead of
  // overwriting it.
  const planRevisionRef = useRef(0);
  // Non-blocking notice shown when a save is refused because the
  // plan changed in another tab or on another device: the form
  // has been replaced with the latest saved version.
  const [planConflictMsg, setPlanConflictMsg] = useState("");
  const [renamingName, setRenamingName] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const defaultsRef = useRef<{ label: string; value: string }[]>([]);

  // Input state (strings so fields can be edited freely).
  const [birthYearP, setBirthYearP] = useState("");
  const [birthYearS, setBirthYearS] = useState("");
  const [filingStatus, setFilingStatus] = useState<FilingStatus>("mfj");
  const [pretax, setPretax] = useState("");
  // The spouse's own pre-tax balance (Part 1). Blank = $0 / not
  // entered: the whole Net Worth Pre-tax bucket then lands in
  // the primary field; when theirs IS entered, the bucket remainder
  // (bucket − theirs, floored at $0) lands in the primary field while
  // that balance is following the snapshot.
  const [pretaxSpouse, setPretaxSpouse] = useState("");
  // Survivor scenario (Part 2): default OFF. When on, the plan
  // reprices from the death year (entered as a CALENDAR YEAR —
  // the convention this build states wherever the input shows).
  const [survivorOn, setSurvivorOn] = useState(false);
  const [survivorWho, setSurvivorWho] = useState<"primary" | "spouse">("primary");
  const [survivorDeathYear, setSurvivorDeathYear] = useState("");
  const [rothBal, setRothBal] = useState("");
  const [taxableBal, setTaxableBal] = useState("");
  // Exclude-from-plan (EXCLUDE-FROM-PLAN build): an amount of
  // the taxable pool kept out of the plan's calculations while
  // the taxable balance follows the snapshot — the money stays
  // in Net Worth in full; the plan simply never spends, sells,
  // or counts it. Blank = no exclusion. While a Taxable balance
  // override is saved (balanceOverrides.taxable), the override
  // wins and this amount is inert — the field says so on the
  // Plan tab whenever that is the case.
  const [taxableExclude, setTaxableExclude] = useState("");
  const [hsaBal, setHsaBal] = useState("");
  // Which of the four starting balances are the user's own saved
  // entries (true) versus following the latest snapshot's bucket
  // totals (false). The fields always DISPLAY the effective value
  // (saved if saved, otherwise the snapshot bucket total), but a
  // following balance saves as null so it keeps following future
  // snapshots instead of freezing today's bucket total as an
  // override the moment any other input autosaves.
  const [balanceOverrides, setBalanceOverrides] = useState({
    pretax: false,
    pretaxSpouse: false,
    roth: false,
    taxable: false,
    hsa: false,
  });
  const [basisPct, setBasisPct] = useState("");
  // Basis tiers editor rows (share % of the taxable pool,
  // basis % for that share), as typed text like every other
  // input. No rows = no tiers: the pool prices as one pool at
  // the basis % above. Rows only become the saved tiers when
  // every row is filled in and the shares add to 100 (see
  // tiersFromRows) — until then the plan keeps pricing as one
  // pool and the editor shows why.
  const [basisTiers, setBasisTiers] = useState<
    { share: string; basis: string }[]
  >([]);
  // Taxable yields: the taxable pool's annual dividend and
  // interest yields, each a % of the year's starting taxable
  // balance, priced as mandatory income for the year
  // (dividends on the capital-gains stack, interest on the
  // ordinary stack). Blank (the state for any record written
  // before these fields existed) = no yield modeled, and the
  // plan prices exactly as before.
  const [divYieldPct, setDivYieldPct] = useState("");
  const [intYieldPct, setIntYieldPct] = useState("");
  // Spend-from-cash % (SPEND-FROM-CASH build): an API-only
  // saved field with NO control in this view — the state only
  // round-trips the loaded record's value into every payload
  // this view builds, so a value set through the API is never
  // silently wiped by an autosave from here. Nothing renders
  // it and nothing here edits it.
  const [spendFromCashPct, setSpendFromCashPct] = useState<number | null>(null);
  // Flexible spending % dials (FLEXIBLE SPENDING build):
  // API-only saved fields with NO control in this view, like
  // spendFromCashPct above — the state only round-trips the
  // loaded record's values into every payload this view
  // builds, so values set through the API are never silently
  // wiped by an autosave from here. Nothing renders them and
  // nothing here edits them.
  const [flexCutPct, setFlexCutPct] = useState<number | null>(null);
  const [flexFloorPct, setFlexFloorPct] = useState<number | null>(null);
  const [spending, setSpending] = useState("");
  const [retirementAge, setRetirementAge] = useState("");
  const [endAge, setEndAge] = useState("95");
  const [expectedPct, setExpectedPct] = useState("");
  const [ssP, setSsP] = useState("");
  const [ssPAge, setSsPAge] = useState("");
  const [ssS, setSsS] = useState("");
  const [ssSAge, setSsSAge] = useState("");
  // Declared "No benefit" state for either person's Social
  // Security field (generic, symmetric): three states per field —
  // amount entered, blank (not entered yet), declared no benefit
  // (a finished answer). Declaration and amount never coexist:
  // declaring clears the amount; typing an amount clears the
  // declaration. A declared field prices exactly like $0.
  const [ssPrimaryNoBenefit, setSsPrimaryNoBenefit] = useState(false);
  const [ssSpouseNoBenefit, setSsSpouseNoBenefit] = useState(false);
  const [otherOrd, setOtherOrd] = useState("");
  const [taxExempt, setTaxExempt] = useState("");
  const [convertedAlready, setConvertedAlready] = useState("");
  // Tax-return actuals (Form 1040 lines 2b / 3a / 3b from the
  // household's most recent return): plan-record-only fields,
  // following the execution / gift pattern — they save WITH the
  // plan record under their own taxReturn* keys (via
  // buildInputsPayload only) and are read by exactly one thing:
  // the Playground's "Start from my numbers" prefill. They
  // never enter a scenario, a pricing request, or the working
  // plan inputs — the plan keeps modelling interest and
  // dividends from the yield fields. Blank = not entered.
  const [taxReturnInterest, setTaxReturnInterest] = useState("");
  const [taxReturnQualDiv, setTaxReturnQualDiv] = useState("");
  const [taxReturnOrdDiv, setTaxReturnOrdDiv] = useState("");
  const [winStart, setWinStart] = useState("");
  const [winStop, setWinStop] = useState("");
  const [payTaxFrom, setPayTaxFrom] = useState<"taxable" | "conversion">("taxable");
  const [protectMin, setProtectMin] = useState("");
  // Preserve-pre-tax reserve: a fixed nominal floor conversions
  // never cross, and the expected tax rate on the preserved
  // amount. A fresh plan seeds the amount at $500,000 (the
  // factory default — SEED_PRESERVE_PRETAX_CENTS) with the exit
  // rate blank. A SAVED record with the amount blank (including
  // any record written before these fields existed) = no
  // reserve, and the ending pre-tax prices entirely at the heir
  // rate — exactly as before: the default never backfills a
  // saved record, it only seeds a fresh / reset plan.
  const [preservePretax, setPreservePretax] = useState("");
  const [preserveExitRate, setPreserveExitRate] = useState("");
  // Spending draw order (the engine's order key): the order the
  // buckets fund spending in after each year's forced RMD.
  // Always a concrete key in the working state — a saved record
  // with no order (written before the draw-order build) hydrates
  // to the default order, and the first save writes that same
  // default, so an untouched plan's figures never move.
  const [drawOrder, setDrawOrder] = useState<string>(DEFAULT_DRAW_ORDER_KEY);
  // Draw-order switch: the age at which spending draws switch
  // to a second order, and that after-order. Blank age (the
  // state for any record written before these fields existed)
  // = no switch: the order above applies at every age, and the
  // after-order is only meaningful while an age is entered.
  const [drawOrderSwitchAge, setDrawOrderSwitchAge] = useState("");
  const [drawOrderAfter, setDrawOrderAfter] = useState<string>(DEFAULT_DRAW_ORDER_KEY);
  const [soleBeneficiary, setSoleBeneficiary] = useState(true);
  // The second beneficiary fact (round-3 fix): the primary
  // is the sole beneficiary of the SPOUSE's pre-tax
  // accounts. Separate from soleBeneficiary above (the
  // spouse is the primary's sole beneficiary). The form
  // state is a plain boolean defaulting to NOT established
  // (false) — a record written before the fact existed
  // hydrates to false, and her RMD prices on the Uniform
  // table, exactly as it did before.
  const [primarySoleBeneficiaryOfSpouse, setPrimarySoleBeneficiaryOfSpouse] =
    useState(false);
  // The household's college window, labeled by fall year —
  // drives only the FAFSA college-years watch-out. Blank (the
  // state for any record written before these fields existed)
  // means no college in the household: the watch-out never fires.
  const [collegeFromYear, setCollegeFromYear] = useState("");
  const [collegeThroughYear, setCollegeThroughYear] = useState("");
  const [acaSize, setAcaSize] = useState("3");
  const [acaSteps, setAcaSteps] = useState<AcaStepRow[]>([]);
  const [benchCouple, setBenchCouple] = useState("");
  const [benchSingle, setBenchSingle] = useState("");
  const [benchFamily, setBenchFamily] = useState("");
  const [acaSpouseEndAge, setAcaSpouseEndAge] = useState("");
  const [inflation, setInflation] = useState(String(SEED_INFLATION));
  const [stateRate, setStateRate] = useState("0");
  // State of residence (T3 build): "WA" prices Washington's
  // capital-gains excise instead of the flat state rate;
  // "other" (and a record saved before this build, which has
  // no value) keeps the flat rate.
  const [residenceState, setResidenceState] = useState<"WA" | "other">("other");
  // Capital-loss carryforward entering the plan (T4 build):
  // unused net capital losses banked before the plan's first
  // year, short-term and long-term kept separate (the IRS
  // worksheet nets them in a fixed order and character is
  // preserved). Blank = none.
  const [carryInSt, setCarryInSt] = useState("");
  const [carryInLt, setCarryInLt] = useState("");
  // Itemized deductions (T5 build): the household's annual
  // itemized components — each priced year takes the greater
  // of the itemized total (SALT capped) and the standard
  // deduction. Blank = $0 on that component.
  const [itemizedMortgage, setItemizedMortgage] = useState("");
  const [itemizedSalt, setItemizedSalt] = useState("");
  const [itemizedCharitable, setItemizedCharitable] = useState("");
  const [itemizedOther, setItemizedOther] = useState("");
  // Education expenses (T6 build): the household's entered
  // qualified education expenses as editor rows — one row
  // per student per calendar year (year + expenses as typed
  // text, plus the AOTC-eligible mark). No rows = no
  // expenses entered: no education credit prices and the
  // plan prices exactly as before. Expenses are entered
  // here only — never inferred from the 529 balances or the
  // college-years fields.
  const [eduStudents, setEduStudents] = useState<EduStudentRow[]>([]);
  const [heirRate, setHeirRate] = useState(String(SEED_HEIR_RATE));
  // Fill ceilings (the "current strategy").
  const [ceilBracket, setCeilBracket] = useState<"" | "10" | "12" | "22" | "24">("12");
  const [ceilIrmaa, setCeilIrmaa] = useState<"" | "0" | "1" | "2" | "3" | "4" | "5">("");
  const [ceilLtcg, setCeilLtcg] = useState(false);
  const [ceilAca, setCeilAca] = useState(false);
  const [ceilAcaFamilyOnly, setCeilAcaFamilyOnly] = useState(false);
  const [magiCap, setMagiCap] = useState("");
  const [cliffBuffer, setCliffBuffer] = useState("");
  // Whether the Custom… ceiling details (the five controls the
  // presets write) are expanded. The open/closed choice persists
  // in the Roth UI state (ceilCustomOpen, toggled below); on
  // load it also opens when the saved plan's ceilings match no
  // preset, so a custom ceiling shape is never hidden behind
  // the preset chips.
  const [ceilCustomOpen, setCeilCustomOpen] = useState(false);
  // Optimizer variant flags on the working strategy (also stored
  // on saved scenarios, so a saved optimizer winner reproduces
  // its schedule exactly). Tri-state on purpose: null is the saved
  // record's "never set" (a record written before the optimizer
  // existed), and it must survive every save untouched — the
  // checkboxes display null as off and the engine treats null as
  // off, but an autosave or a scenario save must not coerce the
  // saved null into a false the user never chose. Only an actual
  // toggle of the checkbox sets a boolean.
  const [guardrailOn, setGuardrailOn] = useState<boolean | null>(null);
  const [bunchingOn, setBunchingOn] = useState<boolean | null>(null);
  const [gainsHarvestOn, setGainsHarvestOn] = useState<boolean | null>(null);
  // Earliest claiming age to consider (the claim floor): a
  // saved plan input like the others — blank = no floor. It
  // constrains only which candidate the optimizer crowns;
  // every age is still priced and shown.
  const [claimAgeFloor, setClaimAgeFloor] = useState("");
  // Work years tab — the three SAVED job inputs ("Your job"):
  // yearly salary and what the employer puts into the 401(k)
  // and the HSA per year. They save with the plan record like
  // every other field and prefill the tab on every visit; the
  // tab's quit ages and runs are scratch (below) and never save.
  const [jobSalary, setJobSalary] = useState("");
  const [jobEmployer401k, setJobEmployer401k] = useState("");
  const [jobEmployerHsa, setJobEmployerHsa] = useState("");
  // Work years tab — scratch state: up to three quit ages
  // (prefilled once from the plan's window-start age, +4, +6)
  // and the last compare run. Nothing here is persisted.
  const [wyQuitAges, setWyQuitAges] = useState<string[]>(["", "", ""]);
  const wyPrefilledRef = useRef(false);
  type WyData = ApiResponse<typeof api, "runWorkYearsCompare">;
  const [wyResult, setWyResult] = useState<WyData | null>(null);
  const [wyFingerprint, setWyFingerprint] = useState("");
  const [wyError, setWyError] = useState("");
  /* Gift stock tab — the seven SAVED gift inputs (plan-record
     only, following the execution-fields pattern): they save
     WITH the plan record under their own gift* keys and are
     read only by the gift comparison run. They never enter a
     scenario or any other run. The comparison result and its
     fingerprint are scratch, like the work-years run. */
  const [giftAge, setGiftAge] = useState("");
  const [giftAmount, setGiftAmount] = useState("");
  const [giftBasis, setGiftBasis] = useState("");
  const [giftKidBirthYear, setGiftKidBirthYear] = useState("");
  // Tri-state like the optimizer variant flags: null is the
  // saved record's "never set", and it must survive hydration
  // and every save untouched — the checkbox displays null as
  // unchecked and the pricing reads null as not-a-student,
  // but only an actual toggle writes a boolean.
  const [giftKidStudent, setGiftKidStudent] = useState<boolean | null>(null);
  const [giftKidOtherIncome, setGiftKidOtherIncome] = useState("");
  const [giftSaleAge, setGiftSaleAge] = useState("");
  type GiftData = ApiResponse<typeof api, "runRothGiftCompare">;
  const [giftResult, setGiftResult] = useState<GiftData | null>(null);
  const [giftFingerprint, setGiftFingerprint] = useState("");
  const [giftError, setGiftError] = useState("");
  const [optResult, setOptResult] = useState<OptData | null>(null);
  // "How the search works" methodology expander (display only).
  const [optHowOpen, setOptHowOpen] = useState(false);
  const [optRunFailed, setOptRunFailed] = useState(false);

  /* Market-uncertainty check (Optimize workspace) — panel-local
     state, following the execution-fields pattern. The volatility
     is a plan-record-only preference: it saves WITH the plan
     record (mcVolatilityPct via buildInputsPayload) and never
     enters scenarios or any pricing request other than the check
     itself. The check result keeps a fingerprint of exactly what
     was priced (the full request object), so a later change to
     the working inputs, the optimizer winner / Do Nothing, or the
     volatility marks the shown figures stale instead of letting
     them pose as current. Running the check saves nothing. */
  const [mcVolatility, setMcVolatility] = useState("15");
  type McCheckData = ApiResponse<typeof api, "runRothMonteCarloCheck">;
  type McCheckRequest = Parameters<typeof api.runRothMonteCarloCheck>[0];
  const [mcResult, setMcResult] = useState<{
    data: McCheckData;
    fingerprint: string;
  } | null>(null);
  const [mcRunFailed, setMcRunFailed] = useState(false);

  /* ---------------- Strategy Lab ----------------
     The Compare workspace grown into a strategy library.
     Debate dials are Lab-local scratch state (Playground
     rules): they never write the plan record or a saved
     scenario; they persist in the Roth UI state so they
     survive reloads, and blank means "no override" — each
     row prices on its own saved values. The baseline choice
     persists the same way. The last library pricing and its
     request fingerprint are scratch, like the work-years and
     gift runs. */
  const [labDialBasis, setLabDialBasis] = useState("");
  const [labDialSpending, setLabDialSpending] = useState("");
  const [labDialSsP, setLabDialSsP] = useState("");
  const [labDialSsS, setLabDialSsS] = useState("");
  const [labDialSurvivor, setLabDialSurvivor] = useState<"" | "on" | "off">("");
  const [labDialSurvivorWho, setLabDialSurvivorWho] = useState<"primary" | "spouse">("primary");
  const [labDialSurvivorYear, setLabDialSurvivorYear] = useState("");
  // KNOBS expansion dials, grouped in the UI as ACA /
  // Assumptions / Plan shape / Starting balances. Same rules
  // as the original dials: scratch only, persisted with them
  // in the Roth UI state, blank = no override.
  const [labDialAcaEndAge, setLabDialAcaEndAge] = useState("");
  const [labDialBenchFamily, setLabDialBenchFamily] = useState("");
  const [labDialBenchCouple, setLabDialBenchCouple] = useState("");
  const [labDialBenchSingle, setLabDialBenchSingle] = useState("");
  const [labDialAcaSteps, setLabDialAcaSteps] = useState<AcaStepRow[]>([]);
  const [labDialReturn, setLabDialReturn] = useState("");
  const [labDialInflation, setLabDialInflation] = useState("");
  const [labDialHeir, setLabDialHeir] = useState("");
  const [labDialStateRate, setLabDialStateRate] = useState("");
  const [labDialWinStart, setLabDialWinStart] = useState("");
  const [labDialWinStop, setLabDialWinStop] = useState("");
  const [labDialPreserve, setLabDialPreserve] = useState("");
  const [labDialPretax, setLabDialPretax] = useState("");
  const [labDialTaxable, setLabDialTaxable] = useState("");
  const [labDialRoth, setLabDialRoth] = useState("");
  const [labBaseline, setLabBaseline] = useState("Do Nothing");
  const [labInit, setLabInit] = useState(false);
  type LabData = ApiResponse<typeof api, "runRothCompare">;
  const [labResult, setLabResult] = useState<LabData | null>(null);
  const [labFingerprint, setLabFingerprint] = useState("");
  const [labError, setLabError] = useState("");
  // Library row management: the row whose strategy editor is
  // open, and the row awaiting delete confirmation.
  const [labEditingName, setLabEditingName] = useState<string | null>(null);
  const [labConfirmDelete, setLabConfirmDelete] = useState<string | null>(null);
  // The row awaiting load confirmation (only ever a row whose
  // record differs from the working plan — a matching row loads
  // immediately).
  const [labConfirmLoad, setLabConfirmLoad] = useState<string | null>(null);
  // Strategy-editor fields (strings, like every other field
  // in this view; the tri-state variant flags keep the saved
  // record's null until the checkbox is actually toggled).
  const [edBracket, setEdBracket] = useState<"" | "10" | "12" | "22" | "24">("");
  const [edIrmaa, setEdIrmaa] = useState<"" | "0" | "1" | "2" | "3" | "4" | "5">("");
  const [edLtcg, setEdLtcg] = useState(false);
  const [edAca, setEdAca] = useState(false);
  const [edAcaFamilyOnly, setEdAcaFamilyOnly] = useState(false);
  const [edMagiCap, setEdMagiCap] = useState("");
  const [edCliffBuffer, setEdCliffBuffer] = useState("");
  const [edDrawOrder, setEdDrawOrder] = useState<string>(DEFAULT_DRAW_ORDER_KEY);
  const [edSwitchAge, setEdSwitchAge] = useState("");
  const [edAfterOrder, setEdAfterOrder] = useState<string>(DEFAULT_DRAW_ORDER_KEY);
  const [edWinStart, setEdWinStart] = useState("");
  const [edWinStop, setEdWinStop] = useState("");
  const [edPayTaxFrom, setEdPayTaxFrom] = useState<"taxable" | "conversion">("taxable");
  const [edGuardrail, setEdGuardrail] = useState<boolean | null>(null);
  const [edBunching, setEdBunching] = useState<boolean | null>(null);
  const [edHarvest, setEdHarvest] = useState<boolean | null>(null);
  const [edPreserve, setEdPreserve] = useState("");
  const [edPreserveRate, setEdPreserveRate] = useState("");

  /* Execution-year ("This year") inputs — plan-record only.
     They save WITH the plan record under their own execution*
     keys, stamped with the calendar year they describe; the
     server consumes a stale stamp as blank (with the rollover
     reported), so the state below always describes the CURRENT
     calendar year. The balance fields follow the plan's resolved
     balances until edited here (the override flags), exactly
     like the plan's own balance fields follow Net Worth; editing
     here never writes back to the plan's balance fields. The
     "Already converted in {year}" field is the year-to-date
     conversions figure for THIS calendar year — a different
     field from the plan's convertedAlready (the plan window's
     first year), in state, storage, and copy. */
  const [execPretax, setExecPretax] = useState("");
  const [execPretaxSpouse, setExecPretaxSpouse] = useState("");
  const [execRoth, setExecRoth] = useState("");
  const [execTaxable, setExecTaxable] = useState("");
  const [execHsa, setExecHsa] = useState("");
  const [execBalanceOverrides, setExecBalanceOverrides] = useState({
    pretax: false,
    pretaxSpouse: false,
    roth: false,
    taxable: false,
    hsa: false,
  });
  const [execOtherOrd, setExecOtherOrd] = useState("");
  const [execTaxExempt, setExecTaxExempt] = useState("");
  const [execAlready, setExecAlready] = useState("");
  const [execRolledOver, setExecRolledOver] = useState(false);
  const [execClearedYear, setExecClearedYear] = useState<number | null>(null);
  // "Show the math" for the priced execution year (display only).
  const [execDetailOpen, setExecDetailOpen] = useState(false);

  // Guided-layout UI state: which of the five input sections are
  // open, whether the Year-by-year table is expanded, and which
  // results workspace the segmented control shows. Display only —
  // persisted server-side (getRothUiState / setRothUiState) so it
  // survives reloads and devices. The local defaults match the
  // server's first-use defaults: the everyday sections open,
  // "Advanced" closed, year table collapsed, Plan workspace.
  const [openSections, setOpenSections] = useState<Record<RothSectionId, boolean>>({
    household: true,
    money: true,
    income: true,
    aca: true,
    advanced: false,
  });
  const [yearTableOpen, setYearTableOpen] = useState(false);
  // Tax-by-year chart's per-year numbers fold: closed by
  // default (the year-by-year table below carries the same
  // figures); display only, in-session like yearTableOpen.
  const [taxYearNumbersOpen, setTaxYearNumbersOpen] = useState(false);
  // Strategy Lab "Debate dials" section: collapsed by default;
  // the open/closed choice persists in the Roth UI state.
  const [labDialsOpen, setLabDialsOpen] = useState(false);
  // Plan workspace "Watch-outs" panel: open by default (warnings
  // are never hidden by default); the open/closed choice persists
  // in the Roth UI state.
  const [watchOutsOpen, setWatchOutsOpen] = useState(true);
  // Assumptions & limits expander: closed by default in every
  // mode; the open/closed choice persists in the Roth UI state.
  const [assumptionsOpen, setAssumptionsOpen] = useState(false);
  /* Plan face "What if…" section fold, in the generic
     server-side fold store (foldState.ts) like the Spending
     section folds and the Playground "Start from a known point"
     fold — the choice survives reloads and new sessions, no
     localStorage. This section DEFAULTS TO EXPANDED, the
     opposite of every other fold in that store: the store only
     carries folds left in their non-default state (a stored
     entry reads true, and closing a default-closed fold just
     removes its entry), so this hook stores the inverse flag —
     an entry under "roth.whatIfFolded" means the user left the
     section folded shut; no entry means expanded, its default.
     Display only: folding hides the section's body, and the
     what-if selection and any showing answer are left exactly
     as they were — re-expanding shows them unchanged. */
  const [whatIfFolded, setWhatIfFolded] = usePersistedFold(
    "roth.whatIfFolded",
  );
  const whatIfOpen = !whatIfFolded;
  // "Show the math" drill-down: the year whose engine detail
  // panel is open under the year-by-year table (display only).
  // The expanded year persists in the Roth UI state like the
  // view's other folds, so the drill-down comes back as left.
  const [detailYear, setDetailYear] = useState<number | null>(null);
  const [resultsMode, setResultsMode] = useState<RothResultsMode>("plan");
  /* Plan-first face (display only — never saved, never priced):
     which of the view's three faces is showing. "plan" is the
     default screen: the saved plan itself (summary line, what-if
     question buttons, ending figures, plan chart, year-by-year
     table). "change" is the guided change path — five plain
     questions writing the same fields the full form edits.
     "settings" is the full folded form ("All settings") plus the
     results workspaces, exactly as the view worked before. A
     fresh visit always opens on "plan". */
  const [face, setFace] = useState<"plan" | "change" | "settings">("plan");
  /* December draw console (display only — never saved here,
     never priced here): the December projection console lives
     inside this view since the nav-crowding move (Kyle's pick
     A) took it out of the top-level tab strip. When open it
     swaps this view's whole screen for the console — the same
     December component, with its own saved state, that used
     to sit behind the December tab — and the console's back
     control returns here, to the face the user left. In-session
     only, exactly like the face above: a fresh visit always
     opens on the Tax Plan itself. */
  const [decemberOpen, setDecemberOpen] = useState(false);
  /* Pretax Spending (proof) scratch overrides — this tab only.
     Blank = the plan's own value; a typed value replaces that
     one input in the proof run in memory. These states are
     never read by buildSavePayload, any saver, or the Roth UI
     state: they live only in this component, reset on reload,
     and leaving the tab changes nothing that is saved. */
  const [proofPretax, setProofPretax] = useState("");
  const [proofPretaxSpouse, setProofPretaxSpouse] = useState("");
  const [proofTaxable, setProofTaxable] = useState("");
  const [proofRoth, setProofRoth] = useState("");
  const [proofHsa, setProofHsa] = useState("");
  const [proofSpending, setProofSpending] = useState("");
  const [proofPayTaxFrom, setProofPayTaxFrom] = useState<
    "" | "taxable" | "conversion"
  >("");
  const [uiInit, setUiInit] = useState(false);
  /* Revision (CAS) tracking for this view's writes into the
     shared UI-state blob: the revision the blob was last read
     or successfully saved at. Every save passes it as
     baseRevision; on a conflict (another writer — the
     Playground, or this view in another tab or on another
     device — saved first) the write retries once at the
     server's fresh revision. These writes each carry one
     field's latest value and the server merges fields into
     the current blob, so the retry lands this field without
     disturbing the newer values of any other field — and a
     stale copy of the blob can never silently overwrite a
     newer save. A failed save stays silent, exactly as
     before: this is display state, and the next toggle
     re-saves. Every save is revision-checked — a write never
     reaches setRothUiState without a baseRevision. When the
     tracked revision is still null (the first state read
     failed, or a save somehow fires before it lands), the
     current state is fetched first and its revision adopted;
     if that fetch fails the write is skipped entirely and
     the next toggle re-saves. */
  const uiRevisionRef = useRef<number | null>(null);
  const persistUiState = async (
    input: Parameters<typeof api.setRothUiState>[0],
  ): Promise<void> => {
    let base = uiRevisionRef.current;
    if (base == null) {
      try {
        const fresh = await api.getRothUiState({});
        base = fresh.revision;
        uiRevisionRef.current = fresh.revision;
      } catch {
        return;
      }
    }
    try {
      const res = await api.setRothUiState({ ...input, baseRevision: base });
      if (res.ok) {
        uiRevisionRef.current = res.revision;
        return;
      }
      uiRevisionRef.current = res.revision;
      const retry = await api.setRothUiState({
        ...input,
        baseRevision: res.revision,
      });
      if (retry.ok) uiRevisionRef.current = retry.revision;
    } catch {
      // Display-only state: a failed save is silent, exactly
      // as before — the next toggle re-saves.
    }
  };
  const saveUiState = {
    mutate: (input: Parameters<typeof api.setRothUiState>[0]) => {
      void persistUiState(input);
    },
  };
  useEffect(() => {
    if (!uiq.data || uiInit) return;
    uiRevisionRef.current = uiq.data.revision;
    setOpenSections(uiq.data.open);
    setYearTableOpen(uiq.data.yearTableOpen);
    setWatchOutsOpen(uiq.data.watchOutsOpen !== false);
    setAssumptionsOpen(uiq.data.assumptionsOpen === true);
    setOptHowOpen(uiq.data.optHowOpen === true);
    setExecDetailOpen(uiq.data.execDetailOpen === true);
    setDetailYear(uiq.data.detailYear ?? null);
    // The Custom… ceiling panel's persisted open flag ORs with
    // the saved-record auto-open in the hydration effect below:
    // either one opens the panel on load, and a close the user
    // chooses afterwards persists as false.
    if (uiq.data.ceilCustomOpen) setCeilCustomOpen(true);
    // The Optimize and Gift stock tabs are hidden from the
    // segmented control (see ROTH_MODE_OPTIONS_SHOWN): a stored
    // mode naming one of them — or the retired Playground tab —
    // opens on Plan instead. Read-side only; the stored blob is
    // not rewritten on load.
    setResultsMode(
      uiq.data.mode === "playground" ||
        uiq.data.mode === "optimize" ||
        uiq.data.mode === "gift"
        ? "plan"
        : uiq.data.mode,
    );
    setUiInit(true);
  }, [uiq.data, uiInit]);
  // Keep the tracked revision in step with refetches (the
  // server invalidates this query after writes, ours included).
  // A stale in-flight refetch can only move it backwards into a
  // conflict on the next save, which the save retries at the
  // fresh revision — never into a silent overwrite.
  useEffect(() => {
    if (uiq.data) uiRevisionRef.current = uiq.data.revision;
  }, [uiq.data]);
  // Strategy Lab dials + baseline hydrate from the same UI
  // state blob (their own one-shot guard, so a later refetch
  // never overwrites dials being edited).
  useEffect(() => {
    if (!uiq.data || labInit) return;
    const d = uiq.data.labDials;
    setLabDialBasis(d.basisPct == null ? "" : String(d.basisPct));
    setLabDialSpending(d.spendingCents == null ? "" : fmtMoneyInput(d.spendingCents / 100));
    setLabDialSsP(d.ssPrimaryStartAge == null ? "" : String(d.ssPrimaryStartAge));
    setLabDialSsS(d.ssSpouseStartAge == null ? "" : String(d.ssSpouseStartAge));
    setLabDialSurvivor(d.survivorEnabled == null ? "" : d.survivorEnabled ? "on" : "off");
    setLabDialSurvivorWho(d.survivorWho ?? "primary");
    setLabDialSurvivorYear(d.survivorDeathYear == null ? "" : String(d.survivorDeathYear));
    setLabDialAcaEndAge(d.acaSpouseEndAge == null ? "" : String(d.acaSpouseEndAge));
    setLabDialBenchFamily(d.acaBenchmarkFamilyCents == null ? "" : fmtMoneyInput(d.acaBenchmarkFamilyCents / 100));
    setLabDialBenchCouple(d.acaBenchmarkCoupleCents == null ? "" : fmtMoneyInput(d.acaBenchmarkCoupleCents / 100));
    setLabDialBenchSingle(d.acaBenchmarkSingleCents == null ? "" : fmtMoneyInput(d.acaBenchmarkSingleCents / 100));
    setLabDialAcaSteps(acaStepRowsFrom(d.acaHouseholdSchedule));
    setLabDialReturn(d.expectedReturnPct == null ? "" : String(d.expectedReturnPct));
    setLabDialInflation(d.inflationPct == null ? "" : String(d.inflationPct));
    setLabDialHeir(d.heirRatePct == null ? "" : String(d.heirRatePct));
    setLabDialStateRate(d.stateRatePct == null ? "" : String(d.stateRatePct));
    setLabDialWinStart(d.windowStartAge == null ? "" : String(d.windowStartAge));
    setLabDialWinStop(d.windowStopAge == null ? "" : String(d.windowStopAge));
    setLabDialPreserve(d.preservePretaxCents == null ? "" : fmtMoneyInput(d.preservePretaxCents / 100));
    setLabDialPretax(d.pretaxCents == null ? "" : fmtMoneyInput(d.pretaxCents / 100));
    setLabDialTaxable(d.taxableCents == null ? "" : fmtMoneyInput(d.taxableCents / 100));
    setLabDialRoth(d.rothCents == null ? "" : fmtMoneyInput(d.rothCents / 100));
    if (uiq.data.labBaselineName) setLabBaseline(uiq.data.labBaselineName);
    setLabDialsOpen(uiq.data.labDialsOpen === true);
    setLabInit(true);
  }, [uiq.data, labInit]);
  const toggleSection = (id: RothSectionId) => {
    const next = !openSections[id];
    setOpenSections((p) => ({ ...p, [id]: next }));
    saveUiState.mutate({ section: id, open: next });
  };
  const toggleYearTable = () => {
    const next = !yearTableOpen;
    setYearTableOpen(next);
    saveUiState.mutate({ yearTableOpen: next });
  };
  const toggleLabDials = () => {
    const next = !labDialsOpen;
    setLabDialsOpen(next);
    saveUiState.mutate({ labDialsOpen: next });
  };
  const toggleWatchOuts = () => {
    const next = !watchOutsOpen;
    setWatchOutsOpen(next);
    saveUiState.mutate({ watchOutsOpen: next });
  };
  const toggleAssumptions = () => {
    const next = !assumptionsOpen;
    setAssumptionsOpen(next);
    saveUiState.mutate({ assumptionsOpen: next });
  };
  // The optimizer's "How the search works" expander and the
  // execution year's "Show the math" expander: each persists
  // in the Roth UI state like the folds above, so it comes
  // back open or closed exactly as left. (The work-years and
  // gift "More" explainers became ⓘ tooltips at contract v67
  // and no longer persist an open state.)
  const toggleOptHow = () => {
    const next = !optHowOpen;
    setOptHowOpen(next);
    saveUiState.mutate({ optHowOpen: next });
  };
  const toggleExecDetail = () => {
    const next = !execDetailOpen;
    setExecDetailOpen(next);
    saveUiState.mutate({ execDetailOpen: next });
  };
  const closeExecDetail = () => {
    setExecDetailOpen(false);
    saveUiState.mutate({ execDetailOpen: false });
  };
  const openDetailYear = (yr: number) => {
    setDetailYear(yr);
    saveUiState.mutate({ detailYear: yr });
  };
  const toggleDetailYear = (yr: number) => {
    const next = detailYear === yr ? null : yr;
    setDetailYear(next);
    saveUiState.mutate({ detailYear: next });
  };
  const closeDetailYear = () => {
    setDetailYear(null);
    saveUiState.mutate({ detailYear: null });
  };
  // Switching workspaces only changes which results section
  // renders — inputs, the optimizer's last result, the scenario
  // list, and the year table's open state all live outside the
  // switch and survive it untouched.
  const switchResultsMode = (mode: RothResultsMode) => {
    setResultsMode(mode);
    saveUiState.mutate({ mode });
  };

  const applyInputs = (src: {
    birthYearPrimary: number | null;
    birthYearSpouse: number | null;
    filingStatus: FilingStatus | null;
    pretaxCents: number | null;
    pretaxSpouseCents?: number | null;
    survivorEnabled?: boolean | null;
    survivorWho?: "primary" | "spouse" | null;
    survivorDeathYear?: number | null;
    rothCents: number | null;
    taxableCents: number | null;
    taxableExcludeCents?: number | null;
    hsaCents: number | null;
    taxableBasisPct: number | null;
    taxableTiers?: { sharePct: number; basisPct: number }[] | null;
    taxableDividendYieldPct?: number | null;
    taxableInterestYieldPct?: number | null;
    spendFromCashPct?: number | null;
    flexCutPct?: number | null;
    flexFloorPct?: number | null;
    annualSpendingCents: number | null;
    retirementAge: number | null;
    endAge: number | null;
    expectedReturnPct: number | null;
    ssPrimaryAnnualCents: number | null;
    ssPrimaryStartAge: number | null;
    ssPrimaryNoBenefit?: boolean | null;
    ssSpouseAnnualCents: number | null;
    ssSpouseStartAge: number | null;
    ssSpouseNoBenefit?: boolean | null;
    otherOrdinaryCents: number | null;
    taxExemptInterestCents: number | null;
    convertedAlreadyCents: number | null;
    windowStartAge: number | null;
    windowStopAge: number | null;
    payTaxFrom: "taxable" | "conversion" | null;
    protectMinTaxableCents: number | null;
    preservePretaxCents?: number | null;
    preserveExitRatePct?: number | null;
    claimAgeFloor?: number | null;
    yearlySalaryCents?: number | null;
    employer401kCents?: number | null;
    employerHsaCents?: number | null;
    drawOrder?: string | null;
    drawOrderSwitchAge?: number | null;
    drawOrderAfter?: string | null;
    spouseSoleBeneficiary: boolean | null;
    primarySoleBeneficiaryOfSpouse?: boolean | null;
    acaHouseholdSize: number | null;
    acaHouseholdSchedule: { fromYear: number; householdSize: number }[] | null;
    collegeFallFromYear?: number | null;
    collegeFallThroughYear?: number | null;
    acaBenchmarkCoupleCents: number | null;
    acaBenchmarkSingleCents: number | null;
    acaBenchmarkFamilyCents?: number | null;
    acaSpouseEndAge?: number | null;
    inflationPct: number | null;
    stateRatePct: number | null;
    residenceState?: "WA" | "other" | null;
    capitalLossCarryInStCents?: number | null;
    capitalLossCarryInLtCents?: number | null;
    itemizedMortgageInterestCents?: number | null;
    itemizedSaltPaidCents?: number | null;
    itemizedCharitableCents?: number | null;
    itemizedOtherCents?: number | null;
    educationStudents?:
      | { year: number; expensesCents: number; aotcEligible: boolean }[]
      | null;
    heirRatePct: number | null;
    ceilings: {
      bracketTopPct: number | null;
      irmaaTierCap: number | null;
      ltcgZeroCap: boolean;
      acaCliffCap: boolean;
      acaCliffCapFamilyOnly?: boolean;
      magiCapCents: number | null;
      acaCliffBufferCents?: number | null;
    } | null;
    optimizerGuardrail?: boolean | null;
    optimizerBunching?: boolean | null;
    gainsHarvest?: boolean | null;
  }) => {
    const money = (c: number | null) => (c == null ? "" : fmtMoneyInput(c / 100));
    const num = (n: number | null) => (n == null ? "" : String(n));
    setBirthYearP(num(src.birthYearPrimary));
    setBirthYearS(num(src.birthYearSpouse));
    setFilingStatus(src.filingStatus ?? "mfj");
    // Balances: a value present in the source is a fixed saved
    // amount and loads as the user's own entry. A NULL balance
    // is the follow-the-snapshot marker — exactly as in the
    // saved record — so it must NOT land as a blank / $0 field:
    // the field shows the latest snapshot's resolved value for
    // that bucket (the per-spouse remainder rule for pre-tax,
    // Taxable + Cash summed for taxable, exactly as the init
    // effect resolves the saved record) and the override stays
    // cleared, so the working inputs follow the snapshot, the
    // plan prices the snapshot's real balances, and the
    // autosave persists null for that balance — never $0.
    const snap = data?.snapshot ?? null;
    const wifeCents = src.pretaxSpouseCents ?? null;
    const resolvedPretax =
      src.pretaxCents ??
      (snap?.pretaxCents != null
        ? Math.max(0, snap.pretaxCents - (wifeCents ?? 0))
        : null);
    const resolvedRoth = src.rothCents ?? snap?.rothCents ?? null;
    const resolvedTaxable = src.taxableCents ?? taxableSnapshotCents(snap);
    const resolvedHsa = src.hsaCents ?? snap?.hsaCents ?? null;
    setPretax(money(resolvedPretax));
    setPretaxSpouse(money(wifeCents));
    setSurvivorOn(src.survivorEnabled ?? false);
    setSurvivorWho(src.survivorWho ?? "primary");
    setSurvivorDeathYear(num(src.survivorDeathYear ?? null));
    setRothBal(money(resolvedRoth));
    setTaxableBal(money(resolvedTaxable));
    setTaxableExclude(money(src.taxableExcludeCents ?? null));
    setHsaBal(money(resolvedHsa));
    // Only a balance actually present in the source counts as
    // the user's own — a snapshot-filled balance is following,
    // not saved. (The init effect re-asserts this from the
    // saved record after its own pre-resolved call.)
    setBalanceOverrides({
      pretax: src.pretaxCents != null,
      pretaxSpouse: src.pretaxSpouseCents != null,
      roth: src.rothCents != null,
      taxable: src.taxableCents != null,
      hsa: src.hsaCents != null,
    });
    setBasisPct(num(src.taxableBasisPct));
    setBasisTiers(
      (src.taxableTiers ?? []).map((t) => ({
        share: String(t.sharePct),
        basis: String(t.basisPct),
      })),
    );
    setDivYieldPct(num(src.taxableDividendYieldPct ?? null));
    setIntYieldPct(num(src.taxableInterestYieldPct ?? null));
    setSpendFromCashPct(src.spendFromCashPct ?? null);
    setFlexCutPct(src.flexCutPct ?? null);
    setFlexFloorPct(src.flexFloorPct ?? null);
    setSpending(money(src.annualSpendingCents));
    setRetirementAge(num(src.retirementAge));
    setEndAge(num(src.endAge));
    setExpectedPct(num(src.expectedReturnPct));
    // Declared "No benefit" wins over any stored amount: the
    // field shows the declared state (amount blank), never both.
    setSsPrimaryNoBenefit(src.ssPrimaryNoBenefit === true);
    setSsP(src.ssPrimaryNoBenefit === true ? "" : money(src.ssPrimaryAnnualCents));
    setSsPAge(num(src.ssPrimaryStartAge));
    setSsSpouseNoBenefit(src.ssSpouseNoBenefit === true);
    setSsS(src.ssSpouseNoBenefit === true ? "" : money(src.ssSpouseAnnualCents));
    setSsSAge(num(src.ssSpouseStartAge));
    setOtherOrd(money(src.otherOrdinaryCents));
    setTaxExempt(money(src.taxExemptInterestCents));
    setConvertedAlready(money(src.convertedAlreadyCents));
    setWinStart(num(src.windowStartAge));
    setWinStop(num(src.windowStopAge));
    setPayTaxFrom(src.payTaxFrom ?? "taxable");
    setProtectMin(money(src.protectMinTaxableCents));
    setPreservePretax(money(src.preservePretaxCents ?? null));
    setPreserveExitRate(num(src.preserveExitRatePct ?? null));
    setClaimAgeFloor(num(src.claimAgeFloor ?? null));
    setJobSalary(money(src.yearlySalaryCents ?? null));
    setJobEmployer401k(money(src.employer401kCents ?? null));
    setJobEmployerHsa(money(src.employerHsaCents ?? null));
    setDrawOrder(drawOrderKey(drawOrderFromKey(src.drawOrder ?? null)));
    setDrawOrderSwitchAge(num(src.drawOrderSwitchAge ?? null));
    setDrawOrderAfter(
      src.drawOrderAfter != null &&
        DRAW_ORDER_OPTIONS.some((o) => o.key === src.drawOrderAfter)
        ? src.drawOrderAfter
        : DEFAULT_DRAW_ORDER_KEY,
    );
    setSoleBeneficiary(src.spouseSoleBeneficiary ?? true);
    setPrimarySoleBeneficiaryOfSpouse(
      src.primarySoleBeneficiaryOfSpouse ?? false,
    );
    setAcaSize(num(src.acaHouseholdSize));
    setAcaSteps(acaStepRowsFrom(src.acaHouseholdSchedule));
    setCollegeFromYear(num(src.collegeFallFromYear ?? null));
    setCollegeThroughYear(num(src.collegeFallThroughYear ?? null));
    setBenchCouple(money(src.acaBenchmarkCoupleCents));
    setBenchSingle(money(src.acaBenchmarkSingleCents));
    setBenchFamily(money(src.acaBenchmarkFamilyCents ?? null));
    setAcaSpouseEndAge(num(src.acaSpouseEndAge ?? null));
    setInflation(num(src.inflationPct));
    setStateRate(num(src.stateRatePct));
    setResidenceState(src.residenceState === "WA" ? "WA" : "other");
    setCarryInSt(money(src.capitalLossCarryInStCents ?? null));
    setCarryInLt(money(src.capitalLossCarryInLtCents ?? null));
    setItemizedMortgage(money(src.itemizedMortgageInterestCents ?? null));
    setItemizedSalt(money(src.itemizedSaltPaidCents ?? null));
    setItemizedCharitable(money(src.itemizedCharitableCents ?? null));
    setItemizedOther(money(src.itemizedOtherCents ?? null));
    setEduStudents(
      (src.educationStudents ?? []).map((s) => ({
        year: String(s.year),
        expenses: money(s.expensesCents),
        aotcEligible: s.aotcEligible === true,
      })),
    );
    setHeirRate(num(src.heirRatePct));
    const c = src.ceilings;
    setCeilBracket(
      c?.bracketTopPct === 10 || c?.bracketTopPct === 12 || c?.bracketTopPct === 22 || c?.bracketTopPct === 24
        ? (String(c.bracketTopPct) as "10" | "12" | "22" | "24")
        : "",
    );
    setCeilIrmaa(
      c?.irmaaTierCap != null && c.irmaaTierCap >= 0 && c.irmaaTierCap <= 5
        ? (String(c.irmaaTierCap) as "0" | "1" | "2" | "3" | "4" | "5")
        : "",
    );
    setCeilLtcg(c?.ltcgZeroCap ?? false);
    setCeilAca(c?.acaCliffCap ?? false);
    setCeilAcaFamilyOnly(c?.acaCliffCapFamilyOnly ?? false);
    setMagiCap(money(c?.magiCapCents ?? null));
    setCliffBuffer(money(c?.acaCliffBufferCents ?? null));
    setGuardrailOn(src.optimizerGuardrail ?? null);
    setBunchingOn(src.optimizerBunching ?? null);
    setGainsHarvestOn(src.gainsHarvest ?? null);
  };

  // The seeded defaults the "Calculated with" strip diffs
  // against — EVERY seeded input is tracked, so the strip's
  // "seeded defaults" sentence is true. Balance seeds are the
  // latest snapshot's bucket totals (what a fresh view fills
  // in); spending / retirement age / expected return seeds come
  // from the Retirement calculator, resolved from the CURRENT
  // Retirement query state exactly as the fresh-open seed
  // resolves them. Recorded by the hydration effect on first
  // load; a plan reset re-records it from the reset response's
  // snapshot, so the strip judges the reseeded plan against the
  // same seed the reset derived.
  const seedDefaultsList = (
    snap: RothData["snapshot"],
  ): { label: string; value: string }[] => {
    const retSaved = ret?.saved ?? null;
    const seedRetAge = retSaved?.retirementAge ?? SEED_RETIREMENT_AGE_FALLBACK;
    const seedReturn =
      retSaved?.expectedReturnPct ?? blendedExpected(retSaved?.stocksPct ?? STOCKS_PCT_DEFAULT);
    const seedSpendingCents = ret?.defaultSpendingAnnualCents ?? 0;
    const snapTaxableCents = taxableSnapshotCents(snap);
    const centsOrBlank = (c: number | null | undefined) =>
      c == null ? "blank" : String(c);
    return [
      { label: "birth years", value: `${SEED_BIRTH_YEAR_PRIMARY}/${SEED_BIRTH_YEAR_SPOUSE}` },
      { label: "filing status", value: "mfj" },
      {
        label: "starting balances",
        value: `${centsOrBlank(snap?.pretaxCents)}|blank|${centsOrBlank(snap?.rothCents)}|${centsOrBlank(snapTaxableCents)}|${centsOrBlank(snap?.hsaCents)}`,
      },
      { label: "survivor scenario", value: "off" },
      { label: "taxable cost basis", value: "blank" },
      { label: "taxable excluded from plan", value: "blank" },
      { label: "taxable yields", value: "blank/blank" },
      { label: "annual spending", value: String(seedSpendingCents) },
      { label: "retirement age", value: String(seedRetAge) },
      { label: "end age", value: "95" },
      { label: "expected return", value: String(seedReturn) },
      { label: "your Social Security", value: `${SEED_SS_PRIMARY_CENTS}@${SEED_SS_START_AGE}` },
      { label: "spouse Social Security", value: "blank@" },
      { label: "other ordinary income", value: "blank" },
      { label: "tax-exempt interest", value: "blank" },
      { label: "already converted this year", value: "blank" },
      { label: "conversion window", value: `${seedRetAge}→${rmdAgeForBirthYear(SEED_BIRTH_YEAR_PRIMARY) - 1}` },
      { label: "pay tax from", value: "taxable" },
      { label: "protect-minimum taxable", value: String(SEED_PROTECT_MIN_CENTS) },
      { label: "pre-tax reserve", value: `${SEED_PRESERVE_PRETAX_CENTS}/blank` },
      { label: "earliest claim age", value: "blank" },
      { label: "draw order", value: drawOrderLabel(drawOrderFromKey(null)) },
      { label: "spouse sole beneficiary", value: "yes" },
      { label: "primary sole beneficiary of spouse", value: "blank" },
      { label: "ACA household size", value: "5" },
      { label: "ACA household steps", value: "none" },
      { label: "ACA benchmark premiums", value: "blank/blank/blank" },
      { label: "inflation", value: String(SEED_INFLATION) },
      { label: "state rate", value: "0" },
      { label: "heir rate", value: String(SEED_HEIR_RATE) },
      { label: "fill ceiling", value: "top of the 12% bracket" },
    ];
  };

  useEffect(() => {
    if (!data || !ret || init) return;
    const s = data.saved;
    const snap = data.snapshot;
    const retSaved = ret.saved;
    const seedRetAge = retSaved?.retirementAge ?? SEED_RETIREMENT_AGE_FALLBACK;
    const seedReturn =
      retSaved?.expectedReturnPct ?? blendedExpected(retSaved?.stocksPct ?? STOCKS_PCT_DEFAULT);
    const seedSpendingCents = ret.defaultSpendingAnnualCents;
    const snapTaxableCents = taxableSnapshotCents(snap);
    if (s) {
      // Per-spouse pre-tax following rule: the Pre-tax bucket
      // lands in the primary field by default; the spouse's field is an
      // override split — when theirs is saved, the bucket
      // remainder (bucket − theirs, floored at $0) lands in the primary
      // field while that balance is following. A saved primary
      // balance wins outright, as with every other bucket.
      const wifeSavedCents = s.pretaxSpouseCents ?? null;
      const primaryEffectiveCents =
        s.pretaxCents ??
        (snap?.pretaxCents != null
          ? Math.max(0, snap.pretaxCents - (wifeSavedCents ?? 0))
          : null);
      applyInputs({
        ...s,
        // Balances: a saved value wins; otherwise fall back to the
        // latest snapshot's split subtotal for that bucket (null
        // when the snapshot has not been split). Taxable falls back
        // to the Taxable and Cash bucket subtotals summed.
        pretaxCents: primaryEffectiveCents,
        pretaxSpouseCents: wifeSavedCents,
        rothCents: s.rothCents ?? snap?.rothCents ?? null,
        taxableCents: s.taxableCents ?? snapTaxableCents,
        hsaCents: s.hsaCents ?? snap?.hsaCents ?? null,
        annualSpendingCents: s.annualSpendingCents ?? seedSpendingCents,
        retirementAge: s.retirementAge ?? seedRetAge,
        expectedReturnPct: s.expectedReturnPct ?? seedReturn,
      });
      // Only a balance actually saved counts as the user's own —
      // a snapshot-filled balance is following, not an override.
      setBalanceOverrides({
        pretax: s.pretaxCents != null,
        pretaxSpouse: wifeSavedCents != null,
        roth: s.rothCents != null,
        taxable: s.taxableCents != null,
        hsa: s.hsaCents != null,
      });
      // Custom… ceiling panel auto-open, on this initial
      // saved-record application only: when the record's
      // ceilings match no preset, the panel opens so the custom
      // shape is visible. The record's ceilings are in cents;
      // the presets speak dollars — the same /100 conversion
      // the optimizer rows use below. This ORs with the
      // persisted ceilCustomOpen flag (hydrated in the UI-state
      // init effect): either one opens the panel, and the user
      // can still close it for the session.
      const sc = s.ceilings;
      const savedCeilings: FillCeilings = {
        bracketTopPct: sc?.bracketTopPct ?? null,
        irmaaTierCap: sc?.irmaaTierCap ?? null,
        ltcgZeroCap: sc?.ltcgZeroCap ?? false,
        acaCliffCap: sc?.acaCliffCap ?? false,
        acaCliffCapFamilyOnly: sc?.acaCliffCapFamilyOnly ?? false,
        magiCap: sc?.magiCapCents == null ? null : sc.magiCapCents / 100,
        acaCliffBuffer:
          sc?.acaCliffBufferCents == null ? null : sc.acaCliffBufferCents / 100,
      };
      if (
        !CEILING_PRESETS.some((p) => ceilingsMatchPreset(savedCeilings, p.fields))
      ) {
        setCeilCustomOpen(true);
      }
    } else {
      // The ONE seed derivation (server/src/rothSeed.ts),
      // shared with the server's resetRothPlanner action so a
      // fresh open and a reset start from the identical record.
      // Balances seed as null (follow the snapshot) and
      // applyInputs resolves them from the snapshot for display,
      // exactly as the inline seed did before.
      applyInputs(
        seedRothInputs({
          annualSpendingCents: seedSpendingCents,
          retirementAge: seedRetAge,
          expectedReturnPct: seedReturn,
        }),
      );
      setBalanceOverrides({ pretax: false, pretaxSpouse: false, roth: false, taxable: false, hsa: false });
    }
    // Execution-year inputs: the server has already consumed the
    // stored shape for the current calendar year (a stale stamp
    // arrives blank, with the rollover reported), so everything
    // set here describes the current year only.
    const ex = data.execution;
    const exMoney = (c: number | null) => (c == null ? "" : fmtMoneyInput(c / 100));
    setExecRolledOver(ex.rolledOver);
    setExecClearedYear(ex.clearedYear);
    setExecOtherOrd(exMoney(ex.executionOtherOrdinaryCents));
    setExecTaxExempt(exMoney(ex.executionTaxExemptInterestCents));
    setExecAlready(exMoney(ex.executionAlreadyConvertedCents));
    setExecBalanceOverrides({
      pretax: ex.executionPretaxCents != null,
      pretaxSpouse: ex.executionPretaxSpouseCents != null,
      roth: ex.executionRothCents != null,
      taxable: ex.executionTaxableCents != null,
      hsa: ex.executionHsaCents != null,
    });
    // Balance fields display the stored execution value when one
    // is saved for this year; otherwise they display the plan's
    // resolved balance — the same value the plan's own fields
    // show, per-spouse rule included (her field shows her saved
    // split, blank when she has none).
    const wifeSavedCents2 = s?.pretaxSpouseCents ?? null;
    const primaryResolvedCents = s
      ? (s.pretaxCents ??
        (snap?.pretaxCents != null
          ? Math.max(0, snap.pretaxCents - (wifeSavedCents2 ?? 0))
          : null))
      : (snap?.pretaxCents ?? null);
    setExecPretax(exMoney(ex.executionPretaxCents ?? primaryResolvedCents));
    setExecPretaxSpouse(exMoney(ex.executionPretaxSpouseCents ?? wifeSavedCents2));
    setExecRoth(
      exMoney(ex.executionRothCents ?? (s ? (s.rothCents ?? snap?.rothCents ?? null) : (snap?.rothCents ?? null))),
    );
    setExecTaxable(
      exMoney(ex.executionTaxableCents ?? (s ? (s.taxableCents ?? snapTaxableCents) : snapTaxableCents)),
    );
    setExecHsa(
      exMoney(ex.executionHsaCents ?? (s ? (s.hsaCents ?? snap?.hsaCents ?? null) : (snap?.hsaCents ?? null))),
    );
    // Market-uncertainty check volatility: the saved preference
    // when one is stored, the panel default of 15 otherwise.
    setMcVolatility(
      data.mcCheck.mcVolatilityPct != null ? String(data.mcCheck.mcVolatilityPct) : "15",
    );
    // Gift stock what-if: the saved gift description, blank on
    // any record written before the gift fields existed.
    {
      const g = data.gift;
      const gMoney = (c: number | null) => (c == null ? "" : fmtMoneyInput(c / 100));
      const gNum = (n: number | null) => (n == null ? "" : String(n));
      setGiftAge(gNum(g.giftAge));
      setGiftAmount(gMoney(g.giftAmountCents));
      setGiftBasis(gMoney(g.giftBasisCents));
      setGiftKidBirthYear(gNum(g.giftKidBirthYear));
      setGiftKidStudent(g.giftKidStudent);
      setGiftKidOtherIncome(gMoney(g.giftKidOtherIncomeCents));
      setGiftSaleAge(gNum(g.giftSaleAge));
    }
    // Tax-return actuals: the saved Form 1040 lines, blank on
    // any record written before these fields existed.
    {
      const t = data.taxReturn;
      const tMoney = (c: number | null) => (c == null ? "" : fmtMoneyInput(c / 100));
      setTaxReturnInterest(tMoney(t.taxReturnInterestCents));
      setTaxReturnQualDiv(tMoney(t.taxReturnQualifiedDividendsCents));
      setTaxReturnOrdDiv(tMoney(t.taxReturnOrdinaryDividendsCents));
    }
    // Record the seeded defaults for the "Calculated with"
    // diff (see seedDefaultsList above).
    defaultsRef.current = seedDefaultsList(snap);
    // The loaded record's revision becomes the save base.
    planRevisionRef.current = data.revision;
    setInit(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, ret, init]);

  /* Re-hydrate the whole form from a planner record — the ONE
     path shared by a plan reset's response and a save
     conflict's record: applyInputs for the plan inputs (its
     null balances resolve from the snapshot and stay
     "following"), then the same execution / MC / gift
     application the init effect performs, and adopt the
     record's revision as the save base. */
  const rehydrateFromRecord = (res: RothData) => {
    const s = res.saved;
    const snap = res.snapshot;
    if (s) applyInputs(s);
    const ex = res.execution;
    const exMoney = (c: number | null) => (c == null ? "" : fmtMoneyInput(c / 100));
    setExecRolledOver(ex.rolledOver);
    setExecClearedYear(ex.clearedYear);
    setExecOtherOrd(exMoney(ex.executionOtherOrdinaryCents));
    setExecTaxExempt(exMoney(ex.executionTaxExemptInterestCents));
    setExecAlready(exMoney(ex.executionAlreadyConvertedCents));
    setExecBalanceOverrides({
      pretax: ex.executionPretaxCents != null,
      pretaxSpouse: ex.executionPretaxSpouseCents != null,
      roth: ex.executionRothCents != null,
      taxable: ex.executionTaxableCents != null,
      hsa: ex.executionHsaCents != null,
    });
    // Execution balance fields display the plan's resolved
    // balance when no execution value is stored — the same
    // resolution the init effect applies (per-spouse rule
    // included).
    const wifeSavedCents2 = s?.pretaxSpouseCents ?? null;
    const snapTaxableCents = taxableSnapshotCents(snap);
    const primaryResolvedCents = s
      ? (s.pretaxCents ??
        (snap?.pretaxCents != null
          ? Math.max(0, snap.pretaxCents - (wifeSavedCents2 ?? 0))
          : null))
      : (snap?.pretaxCents ?? null);
    setExecPretax(exMoney(ex.executionPretaxCents ?? primaryResolvedCents));
    setExecPretaxSpouse(exMoney(ex.executionPretaxSpouseCents ?? wifeSavedCents2));
    setExecRoth(
      exMoney(ex.executionRothCents ?? (s ? (s.rothCents ?? snap?.rothCents ?? null) : (snap?.rothCents ?? null))),
    );
    setExecTaxable(
      exMoney(ex.executionTaxableCents ?? (s ? (s.taxableCents ?? snapTaxableCents) : snapTaxableCents)),
    );
    setExecHsa(
      exMoney(ex.executionHsaCents ?? (s ? (s.hsaCents ?? snap?.hsaCents ?? null) : (snap?.hsaCents ?? null))),
    );
    setMcVolatility(
      res.mcCheck.mcVolatilityPct != null ? String(res.mcCheck.mcVolatilityPct) : "15",
    );
    {
      const g = res.gift;
      const gMoney = (c: number | null) => (c == null ? "" : fmtMoneyInput(c / 100));
      const gNum = (n: number | null) => (n == null ? "" : String(n));
      setGiftAge(gNum(g.giftAge));
      setGiftAmount(gMoney(g.giftAmountCents));
      setGiftBasis(gMoney(g.giftBasisCents));
      setGiftKidBirthYear(gNum(g.giftKidBirthYear));
      setGiftKidStudent(g.giftKidStudent);
      setGiftKidOtherIncome(gMoney(g.giftKidOtherIncomeCents));
      setGiftSaleAge(gNum(g.giftSaleAge));
    }
    {
      const t = res.taxReturn;
      const tMoney = (c: number | null) => (c == null ? "" : fmtMoneyInput(c / 100));
      setTaxReturnInterest(tMoney(t.taxReturnInterestCents));
      setTaxReturnQualDiv(tMoney(t.taxReturnQualifiedDividendsCents));
      setTaxReturnOrdDiv(tMoney(t.taxReturnOrdinaryDividendsCents));
    }
    defaultsRef.current = seedDefaultsList(snap);
    planRevisionRef.current = res.revision;
  };

  /* ---------------- autosave (Retirement pattern) ----------------
     Revision-checked (CAS, API follow-on 1): every save passes
     baseRevision = the last-known revision, and adopts the
     returned revision on EVERY success — without that, the
     view's own second autosave would conflict against its
     first. Saves are serialized through saveInFlightRef: a
     debounced save that comes due while one is in flight waits
     and re-fires, so the base it sends is the one the in-flight
     save returned, never a duplicate of the in-flight base. */
  const saveTimer = useRef<number | null>(null);
  const pendingSave = useRef<SavePayload | null>(null);
  const saveInFlightRef = useRef(false);
  const save = useMutation({
    mutationFn: (input: SavePayload) =>
      api.saveRothInputs({ ...input, baseRevision: planRevisionRef.current }),
    onSuccess: (res) => {
      if (res.ok) {
        planRevisionRef.current = Math.max(planRevisionRef.current, res.revision);
        return;
      }
      // Conflict: a newer save landed first (another tab or
      // device). Deliberately NOT an auto-merge and NOT a
      // resubmit of the stale form — a plan save is a whole-form
      // snapshot with no safe field-level re-apply. Drop any
      // queued autosave of the stale form, replace the form with
      // the current saved record the refusal carries, adopt its
      // revision, and say plainly what happened. (The autosave
      // effect then re-fires on the rehydrated state and
      // persists a payload built from that record itself —
      // value-identical to what is stored, exactly as after a
      // reset.)
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
      pendingSave.current = null;
      queryClient.setQueryData(["rothplanner"], res.record);
      rehydrateFromRecord(res.record);
      setPlanConflictMsg(
        "This plan was changed in another tab or on another device, so the edits that were just saving here were not kept. The latest saved version is shown now.",
      );
    },
  });
  const saveMutateRef = useRef(save.mutate);
  saveMutateRef.current = save.mutate;
  const firePendingSave = () => {
    if (!pendingSave.current) return;
    if (saveInFlightRef.current) {
      // A save is already in flight: wait for it to settle (its
      // returned revision becomes the base) and re-fire.
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(firePendingSave, 300);
      return;
    }
    const payload = pendingSave.current;
    pendingSave.current = null;
    saveInFlightRef.current = true;
    saveMutateRef.current(payload, {
      onSettled: () => {
        saveInFlightRef.current = false;
      },
    });
  };
  useEffect(() => {
    return () => {
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
      if (pendingSave.current) {
        saveMutateRef.current(pendingSave.current);
        pendingSave.current = null;
      }
    };
  }, []);

  const buildSavePayload = (): PlanPayload => {
    const age = (s: string, max: number): number | null => {
      const n = parseIntField(s);
      return n == null ? null : Math.min(max, Math.max(0, n));
    };
    const year = (s: string): number | null => {
      const n = parseIntField(s);
      return n == null ? null : Math.min(2100, Math.max(1900, n));
    };
    const pct = (s: string): number | null => {
      const n = parseNum(s);
      return n == null ? null : Math.min(100, Math.max(0, n));
    };
    // Exclude-from-plan at the payload boundary: this payload
    // carries EFFECTIVE balances (a scenario saved from it
    // freezes the balances it was priced with, and every
    // compute run prices what it is sent), so while the
    // taxable balance follows the snapshot the amount sent is
    // the pool AFTER the exclusion — the same pool the local
    // plan prices. The exclusion amount itself rides along
    // verbatim: beside an explicit balance it is inert on the
    // server (the override wins), and in the saved plan record
    // buildInputsPayload restores taxableCents to null
    // (following), where the server's resolvePlanBalances
    // applies the exclusion against the snapshot pool itself.
    const taxableEnteredCents = parseMoney(taxableBal);
    const taxableExcludeCents = parseMoney(taxableExclude);
    const taxableEffectiveCents =
      taxableEnteredCents == null || balanceOverrides.taxable
        ? taxableEnteredCents
        : Math.max(
            0,
            taxableEnteredCents - Math.max(0, taxableExcludeCents ?? 0),
          );
    return {
      birthYearPrimary: year(birthYearP),
      birthYearSpouse: year(birthYearS),
      filingStatus,
      pretaxCents: parseMoney(pretax),
      pretaxSpouseCents: parseMoney(pretaxSpouse),
      survivorEnabled: survivorOn,
      survivorWho,
      survivorDeathYear: year(survivorDeathYear),
      rothCents: parseMoney(rothBal),
      taxableCents: taxableEffectiveCents,
      taxableExcludeCents,
      hsaCents: parseMoney(hsaBal),
      taxableBasisPct: pct(basisPct),
      taxableTiers: tiersFromRows(basisTiers),
      taxableDividendYieldPct: pct(divYieldPct),
      taxableInterestYieldPct: pct(intYieldPct),
      spendFromCashPct,
      flexCutPct,
      flexFloorPct,
      annualSpendingCents: parseMoney(spending),
      retirementAge: age(retirementAge, 120),
      endAge: age(endAge, 130),
      expectedReturnPct: parseNum(expectedPct),
      // Mutual exclusion, normalized at the payload boundary as
      // well as in the handlers: declared → amount null + flag
      // true; an amount present → flag false.
      ssPrimaryAnnualCents: ssPrimaryNoBenefit ? null : parseMoney(ssP),
      ssPrimaryStartAge: age(ssPAge, 120),
      ssPrimaryNoBenefit: ssPrimaryNoBenefit && parseMoney(ssP) == null,
      ssSpouseAnnualCents: ssSpouseNoBenefit ? null : parseMoney(ssS),
      ssSpouseStartAge: age(ssSAge, 120),
      ssSpouseNoBenefit: ssSpouseNoBenefit && parseMoney(ssS) == null,
      otherOrdinaryCents: parseMoney(otherOrd),
      taxExemptInterestCents: parseMoney(taxExempt),
      convertedAlreadyCents: parseMoney(convertedAlready),
      windowStartAge: age(winStart, 120),
      windowStopAge: age(winStop, 120),
      payTaxFrom,
      protectMinTaxableCents: parseMoney(protectMin),
      preservePretaxCents: parseMoney(preservePretax),
      preserveExitRatePct: pct(preserveExitRate),
      claimAgeFloor: (() => {
        const n = parseIntField(claimAgeFloor);
        return n == null ? null : Math.min(70, Math.max(62, n));
      })(),
      yearlySalaryCents: parseMoney(jobSalary),
      employer401kCents: parseMoney(jobEmployer401k),
      employerHsaCents: parseMoney(jobEmployerHsa),
      drawOrder: asDrawOrderKey(drawOrder),
      drawOrderSwitchAge: age(drawOrderSwitchAge, 120),
      drawOrderAfter: asDrawOrderKey(drawOrderAfter),
      spouseSoleBeneficiary: soleBeneficiary,
      primarySoleBeneficiaryOfSpouse,
      acaHouseholdSize: (() => {
        const n = parseIntField(acaSize);
        return n == null ? null : Math.min(20, Math.max(1, n));
      })(),
      acaHouseholdSchedule: acaStepsFromRows(acaSteps),
      collegeFallFromYear: (() => {
        const n = parseIntField(collegeFromYear);
        return n == null ? null : Math.min(2200, Math.max(1900, n));
      })(),
      collegeFallThroughYear: (() => {
        const n = parseIntField(collegeThroughYear);
        return n == null ? null : Math.min(2200, Math.max(1900, n));
      })(),
      acaBenchmarkCoupleCents: parseMoney(benchCouple),
      acaBenchmarkSingleCents: parseMoney(benchSingle),
      acaBenchmarkFamilyCents: parseMoney(benchFamily),
      acaSpouseEndAge: (() => {
        const n = parseIntField(acaSpouseEndAge);
        return n == null ? null : Math.min(80, Math.max(55, n));
      })(),
      inflationPct: parseNum(inflation),
      stateRatePct: pct(stateRate),
      residenceState,
      capitalLossCarryInStCents: parseMoney(carryInSt),
      capitalLossCarryInLtCents: parseMoney(carryInLt),
      itemizedMortgageInterestCents: parseMoney(itemizedMortgage),
      itemizedSaltPaidCents: parseMoney(itemizedSalt),
      itemizedCharitableCents: parseMoney(itemizedCharitable),
      itemizedOtherCents: parseMoney(itemizedOther),
      educationStudents: studentsFromRows(eduStudents),
      heirRatePct: pct(heirRate),
      ceilings: {
        bracketTopPct: ceilBracket === "" ? null : Number(ceilBracket),
        irmaaTierCap: ceilIrmaa === "" ? null : Number(ceilIrmaa),
        ltcgZeroCap: ceilLtcg,
        acaCliffCap: ceilAca,
        acaCliffCapFamilyOnly: ceilAcaFamilyOnly,
        magiCapCents: parseMoney(magiCap),
        acaCliffBufferCents: parseMoney(cliffBuffer),
      },
      optimizerGuardrail: guardrailOn,
      optimizerBunching: bunchingOn,
      gainsHarvest: gainsHarvestOn,
    };
  };

  // The payload for the working inputs: identical to the
  // effective payload EXCEPT a balance that is following the
  // snapshot saves as null — null is what "follow the snapshot"
  // means in the saved blob, so an unrelated autosave cannot
  // freeze today's bucket totals as overrides. Balances the user
  // has actually entered save their entered value. (Scenarios
  // keep using buildSavePayload: a saved scenario freezes the
  // effective balances it was priced with.)
  const buildInputsPayload = (): SavePayload => {
    const eff = buildSavePayload();
    return {
      ...eff,
      pretaxCents: balanceOverrides.pretax ? eff.pretaxCents : null,
      pretaxSpouseCents: balanceOverrides.pretaxSpouse ? eff.pretaxSpouseCents : null,
      rothCents: balanceOverrides.roth ? eff.rothCents : null,
      taxableCents: balanceOverrides.taxable ? eff.taxableCents : null,
      hsaCents: balanceOverrides.hsa ? eff.hsaCents : null,
      // Execution-year fields save WITH the plan record, stamped
      // with the current calendar year. An execution balance that
      // has not been edited in the This year panel saves as null —
      // null is what "use the plan's resolved balance" means in
      // the stored execution shape, so an unrelated autosave
      // cannot freeze today's resolved balances as execution
      // overrides. This is the only payload that carries these
      // keys: scenarios and the optimizer never see them.
      executionYear: new Date().getFullYear(),
      executionPretaxCents: execBalanceOverrides.pretax ? parseMoney(execPretax) : null,
      executionPretaxSpouseCents: execBalanceOverrides.pretaxSpouse
        ? parseMoney(execPretaxSpouse)
        : null,
      executionRothCents: execBalanceOverrides.roth ? parseMoney(execRoth) : null,
      executionTaxableCents: execBalanceOverrides.taxable ? parseMoney(execTaxable) : null,
      executionHsaCents: execBalanceOverrides.hsa ? parseMoney(execHsa) : null,
      executionOtherOrdinaryCents: parseMoney(execOtherOrd),
      executionTaxExemptInterestCents: parseMoney(execTaxExempt),
      executionAlreadyConvertedCents: parseMoney(execAlready),
      // The market-uncertainty check's volatility preference
      // saves WITH the plan record too, under its own key — the
      // only other payload piece that carries it is the check's
      // own run request. Scenarios never see it.
      mcVolatilityPct: (() => {
        const n = parseNum(mcVolatility);
        return n == null ? null : Math.min(100, Math.max(0, n));
      })(),
      // The gift-stock what-if fields save WITH the plan record
      // too, under their own gift* keys — the only other payload
      // that carries them is the gift comparison's own run
      // request. Scenarios and every other run never see them.
      giftAge: (() => {
        const n = parseIntField(giftAge);
        return n == null ? null : Math.min(120, Math.max(0, n));
      })(),
      giftAmountCents: parseMoney(giftAmount),
      giftBasisCents: parseMoney(giftBasis),
      giftKidBirthYear: (() => {
        const n = parseIntField(giftKidBirthYear);
        return n == null ? null : Math.min(2100, Math.max(1900, n));
      })(),
      giftKidStudent,
      giftKidOtherIncomeCents: parseMoney(giftKidOtherIncome),
      giftSaleAge: (() => {
        const n = parseIntField(giftSaleAge);
        return n == null ? null : Math.min(120, Math.max(0, n));
      })(),
      // The tax-return actuals save WITH the plan record too,
      // under their own taxReturn* keys — the only other reader
      // is the Playground's "Start from my numbers" prefill.
      // Scenarios and every pricing run never see them.
      taxReturnInterestCents: parseMoney(taxReturnInterest),
      taxReturnQualifiedDividendsCents: parseMoney(taxReturnQualDiv),
      taxReturnOrdinaryDividendsCents: parseMoney(taxReturnOrdDiv),
    };
  };

  // Reset balances to Net Worth: clear ONLY the four saved
  // balance overrides, so every balance field follows the latest
  // snapshot's bucket totals again. The fields immediately show
  // the snapshot values (blank for a bucket with no split), and
  // the cleared payload is saved at once — no other input moves.
  const resetBalancesToNetWorth = () => {
    setConfirmResetBalances(false);
    const snapNow = data?.snapshot ?? null;
    const money = (c: number | null) => (c == null ? "" : fmtMoneyInput(c / 100));
    setPretax(money(snapNow?.pretaxCents ?? null));
    setPretaxSpouse("");
    setRothBal(money(snapNow?.rothCents ?? null));
    setTaxableBal(money(taxableSnapshotCents(snapNow)));
    setHsaBal(money(snapNow?.hsaCents ?? null));
    setBalanceOverrides({ pretax: false, pretaxSpouse: false, roth: false, taxable: false, hsa: false });
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    pendingSave.current = null;
    const eff = buildInputsPayload();
    saveMutateRef.current({
      ...eff,
      pretaxCents: null,
      pretaxSpouseCents: null,
      rothCents: null,
      taxableCents: null,
      hsaCents: null,
    });
  };

  /* Reset plan to defaults: the server reseeds the whole plan
     record (inputs + This-year execution + gift + MC volatility)
     from the ONE seed derivation, leaving the saved scenarios
     untouched. Success returns only the new revision — the form
     refetches the reseeded record with getRothPlanner and
     re-hydrates through the shared path (applyInputs for the
     plan inputs, then the same execution / MC / gift application
     the init effect performs). A refusal returns the current
     record in saveRothInputs' conflict shape and is handled
     exactly like a save conflict.
     Autosave safety (the Load-into-plan problem): a debounced
     save of the PRE-reset form may still be queued when the
     reset is confirmed — doResetPlan drops it before the call,
     so it can never land after the reset and resurrect the old
     values. Once the seed is applied, the autosave effect
     re-fires on the new state and persists a payload built from
     the seed itself — value-identical to the record the reset
     just wrote. */
  const resetPlan = useMutation({
    mutationFn: () => api.resetRothPlanner({}),
    onSuccess: async (res) => {
      setConfirmResetPlan(false);
      if (res.ok === false) {
        if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
        pendingSave.current = null;
        queryClient.setQueryData(["rothplanner"], res.record);
        rehydrateFromRecord(res.record);
        setPlanConflictMsg(
          "This plan was changed in another tab or on another device, so the edits that were just saving here were not kept. The latest saved version is shown now.",
        );
        return;
      }
      const fresh = await api.getRothPlanner({});
      queryClient.setQueryData(["rothplanner"], fresh);
      rehydrateFromRecord(fresh);
      setPlanConflictMsg("");
      setScenarioMsg("Plan reset to the seeded defaults. Your saved strategies were kept.");
      queryClient.invalidateQueries({ queryKey: ["rothplanner"] });
    },
  });
  const doResetPlan = () => {
    // Drop any queued autosave of the pre-reset form first (see
    // the note above): the reset, not a stale payload, is the
    // last word on the record.
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    pendingSave.current = null;
    resetPlan.mutate();
  };

  // Editing the spouse's pre-tax field: that entry is an override
  // split of the Net Worth Pre-tax bucket. While the primary balance
  // is following the snapshot, the displayed primary field immediately
  // becomes the bucket remainder (bucket − theirs, floored at
  // $0); once the primary balance is a saved entry, the spouse field
  // no longer moves it.
  const handleWifePretaxEdit = (v: string) => {
    setPretaxSpouse(v);
    setBalanceOverrides((o) => (o.pretaxSpouse ? o : { ...o, pretaxSpouse: true }));
    if (!balanceOverrides.pretax) {
      const snapPretaxCents = data?.snapshot?.pretaxCents ?? null;
      if (snapPretaxCents != null) {
        const wifeDollars = parseDollars(v) ?? 0;
        setPretax(fmtMoneyInput(Math.max(0, snapPretaxCents / 100 - wifeDollars)));
      }
    }
  };

  useEffect(() => {
    if (!init) return;
    if (suppressNextAutosaveRef.current) {
      // A "Back to saved" restore just landed: the form now
      // holds the saved record's values, so there is nothing
      // to write. Skip exactly this one scheduled save.
      suppressNextAutosaveRef.current = false;
      return;
    }
    pendingSave.current = buildInputsPayload();
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(firePendingSave, 700);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    init, birthYearP, birthYearS, filingStatus, pretax, pretaxSpouse,
    survivorOn, survivorWho, survivorDeathYear, rothBal, taxableBal, taxableExclude, hsaBal,
    basisPct, basisTiers, divYieldPct, intYieldPct, spendFromCashPct, flexCutPct, flexFloorPct, spending, retirementAge, endAge, expectedPct, ssP, ssPAge, ssS, ssSAge,
    ssPrimaryNoBenefit, ssSpouseNoBenefit,
    otherOrd, taxExempt, convertedAlready, winStart, winStop, payTaxFrom, protectMin,
    preservePretax, preserveExitRate, claimAgeFloor,
    jobSalary, jobEmployer401k, jobEmployerHsa,
    drawOrder, drawOrderSwitchAge, drawOrderAfter,
    soleBeneficiary, primarySoleBeneficiaryOfSpouse, acaSize, acaSteps, collegeFromYear, collegeThroughYear, benchCouple, benchSingle, benchFamily,
    inflation, stateRate, residenceState, carryInSt, carryInLt, itemizedMortgage, itemizedSalt, itemizedCharitable, itemizedOther, eduStudents, heirRate, ceilBracket, ceilIrmaa, ceilLtcg, ceilAca, ceilAcaFamilyOnly, magiCap, cliffBuffer,
    guardrailOn, bunchingOn, gainsHarvestOn,
    balanceOverrides,
    execPretax, execPretaxSpouse, execRoth, execTaxable, execHsa,
    execOtherOrd, execTaxExempt, execAlready, execBalanceOverrides,
    mcVolatility,
    giftAge, giftAmount, giftBasis, giftKidBirthYear, giftKidStudent,
    giftKidOtherIncome, giftSaleAge,
    taxReturnInterest, taxReturnQualDiv, taxReturnOrdDiv,
  ]);

  /* ---------------- scenarios ---------------- */
  // Scenario writes bump the plan record's revision too (they
  // share the one record): every response carries the revision
  // after the attempt, and the view adopts it as the save base
  // so its next plan autosave does not conflict against the
  // scenario write it just made.
  const saveScenario = useMutation({
    mutationFn: (input: PlanPayload) => api.saveRothScenario(input),
    onSuccess: (res) => {
      planRevisionRef.current = Math.max(planRevisionRef.current, res.revision);
      setScenarioMsg(res.reason);
      queryClient.invalidateQueries({ queryKey: ["rothplanner"] });
    },
  });
  const deleteScenario = useMutation({
    mutationFn: (name: string) => api.deleteRothScenario({ name }),
    onSuccess: (res) => {
      planRevisionRef.current = Math.max(planRevisionRef.current, res.revision);
      setScenarioMsg(res.reason);
      if (res.ok) {
        setLabConfirmLoad(null);
        setLabConfirmDelete(null);
      }
      queryClient.invalidateQueries({ queryKey: ["rothplanner"] });
    },
  });
  const renameScenario = useMutation({
    mutationFn: (args: { name: string; newName: string }) => api.renameRothScenario(args),
    onSuccess: (res) => {
      planRevisionRef.current = Math.max(planRevisionRef.current, res.revision);
      setScenarioMsg(res.reason);
      if (res.ok) {
        setRenamingName(null);
        setLabConfirmLoad(null);
        setLabConfirmDelete(null);
      }
      queryClient.invalidateQueries({ queryKey: ["rothplanner"] });
    },
  });
  const updateScenario = useMutation({
    mutationFn: (input: Parameters<typeof api.updateRothScenario>[0]) =>
      api.updateRothScenario(input),
    onSuccess: (res) => {
      planRevisionRef.current = Math.max(planRevisionRef.current, res.revision);
      setScenarioMsg(res.reason);
      if (res.ok) setLabEditingName(null);
      queryClient.invalidateQueries({ queryKey: ["rothplanner"] });
    },
  });

  /* ---------------- Strategy Lab pricing ----------------
     The library prices through the compare action
     (runRothCompare) and nothing else: each saved strategy
     rides as a FULL-record patch over the current plan, so a
     row's figures are the compare's own figures for that
     exact saved shape, to the cent. The debate dials are the
     only Lab-side change: a set dial replaces that one
     plan-level field on the base AND on every row's patch at
     pricing time (a claim-age dial drops the row's stored
     benefit amount from its patch, so the compare derives
     the amount at the dial age from the base anchor, exactly
     as it derives any claim-age patch). Dials never write
     the plan record or a scenario. Extra rows price the
     current plan itself (an empty patch), Do Nothing
     (ceilings cleared), and the four built-in fill rules
     (ceilings-only patches over the same dial-adjusted base). */
  type LabRequest = Parameters<typeof api.runRothCompare>[0];
  type LabDialsObj = ReturnType<typeof labDialsObject>;
  function labDialRawNow() {
    return {
      basis: labDialBasis,
      spending: labDialSpending,
      ssP: labDialSsP,
      ssS: labDialSsS,
      survivor: labDialSurvivor,
      who: labDialSurvivorWho,
      year: labDialSurvivorYear,
      acaEndAge: labDialAcaEndAge,
      benchFamily: labDialBenchFamily,
      benchCouple: labDialBenchCouple,
      benchSingle: labDialBenchSingle,
      acaSteps: labDialAcaSteps,
      expReturn: labDialReturn,
      inflation: labDialInflation,
      heirRate: labDialHeir,
      stateRate: labDialStateRate,
      winStart: labDialWinStart,
      winStop: labDialWinStop,
      preserve: labDialPreserve,
      pretax: labDialPretax,
      taxable: labDialTaxable,
      roth: labDialRoth,
    };
  }
  function labDialsObject(raw: ReturnType<typeof labDialRawNow>) {
    const pct = (s: string): number | null => {
      const n = parseNum(s);
      return n == null ? null : Math.min(100, Math.max(0, n));
    };
    const age = (s: string): number | null => {
      const n = parseIntField(s);
      return n == null ? null : Math.min(120, Math.max(0, n));
    };
    const year = (s: string): number | null => {
      const n = parseIntField(s);
      return n == null ? null : Math.min(2200, Math.max(1900, n));
    };
    const endAge = (s: string): number | null => {
      const n = parseIntField(s);
      return n == null ? null : Math.min(80, Math.max(55, n));
    };
    return {
      basisPct: pct(raw.basis),
      spendingCents: parseMoney(raw.spending),
      ssPrimaryStartAge: age(raw.ssP),
      ssSpouseStartAge: age(raw.ssS),
      survivorEnabled: raw.survivor === "" ? null : raw.survivor === "on",
      survivorWho: raw.survivor === "" ? null : raw.who,
      survivorDeathYear: raw.survivor === "on" ? year(raw.year) : null,
      acaSpouseEndAge: endAge(raw.acaEndAge),
      acaBenchmarkFamilyCents: parseMoney(raw.benchFamily),
      acaBenchmarkCoupleCents: parseMoney(raw.benchCouple),
      acaBenchmarkSingleCents: parseMoney(raw.benchSingle),
      acaHouseholdSchedule: acaStepsFromRows(raw.acaSteps),
      expectedReturnPct: parseNum(raw.expReturn),
      inflationPct: parseNum(raw.inflation),
      heirRatePct: pct(raw.heirRate),
      stateRatePct: pct(raw.stateRate),
      windowStartAge: age(raw.winStart),
      windowStopAge: age(raw.winStop),
      preservePretaxCents: parseMoney(raw.preserve),
      pretaxCents: parseMoney(raw.pretax),
      taxableCents: parseMoney(raw.taxable),
      rothCents: parseMoney(raw.roth),
    };
  }
  /* The KNOBS dials each name the saved-shape field they
     override — the dial key IS the field key — so applying
     them to the base plan and to every row's patch is one
     uniform pass: a set dial replaces that field, a blank
     dial leaves it alone. The balance dials ride the same
     pass: on a row's patch the key must be SET (not omitted)
     so the dial's balance wins over the snapshot-followed
     inheritance, exactly as it wins on the base. */
  const KNOB_DIAL_KEYS = [
    "acaSpouseEndAge",
    "acaBenchmarkFamilyCents",
    "acaBenchmarkCoupleCents",
    "acaBenchmarkSingleCents",
    "acaHouseholdSchedule",
    "expectedReturnPct",
    "inflationPct",
    "heirRatePct",
    "stateRatePct",
    "windowStartAge",
    "windowStopAge",
    "preservePretaxCents",
    "pretaxCents",
    "taxableCents",
    "rothCents",
  ] as const;
  const resetLabDials = () => {
    setLabDialBasis("");
    setLabDialSpending("");
    setLabDialSsP("");
    setLabDialSsS("");
    setLabDialSurvivor("");
    setLabDialSurvivorWho("primary");
    setLabDialSurvivorYear("");
    setLabDialAcaEndAge("");
    setLabDialBenchFamily("");
    setLabDialBenchCouple("");
    setLabDialBenchSingle("");
    setLabDialAcaSteps([]);
    setLabDialReturn("");
    setLabDialInflation("");
    setLabDialHeir("");
    setLabDialStateRate("");
    setLabDialWinStart("");
    setLabDialWinStop("");
    setLabDialPreserve("");
    setLabDialPretax("");
    setLabDialTaxable("");
    setLabDialRoth("");
    saveUiState.mutate({
      labDials: {
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
      },
    });
  };
  /* Built-in rows: the Plan workspace's fill rules, folded
     into the Lab as variants of the CURRENT (loaded) plan.
     Each is a constructed scenario for the compare run — the
     loaded plan with only its ceilings replaced — never a
     saved scenario, so it carries no save / load / delete
     affordances and re-prices from whatever plan is loaded.
     Because the patch names only ceilings, the debate dials
     (applied to the base plan in buildLabRequest) flow into
     every built-in exactly as they flow into "Your current
     plan". The ceilings mirror ROTH_COMPARE_STRATEGIES, the
     rows the old fill-rule table priced. */
  const LAB_BUILT_INS: {
    name: string;
    ceilings: {
      bracketTopPct: number | null;
      irmaaTierCap: number | null;
      ltcgZeroCap: boolean;
      acaCliffCap: boolean;
      acaCliffCapFamilyOnly: boolean;
      magiCapCents: number | null;
      acaCliffBufferCents: number | null;
    };
  }[] = [
    {
      name: "Fill 12%",
      ceilings: { bracketTopPct: 12, irmaaTierCap: null, ltcgZeroCap: false, acaCliffCap: false, acaCliffCapFamilyOnly: false, magiCapCents: null, acaCliffBufferCents: null },
    },
    {
      name: "Fill 22%",
      ceilings: { bracketTopPct: 22, irmaaTierCap: null, ltcgZeroCap: false, acaCliffCap: false, acaCliffCapFamilyOnly: false, magiCapCents: null, acaCliffBufferCents: null },
    },
    {
      name: "Fill 22% capped at IRMAA Tier 1",
      ceilings: { bracketTopPct: 22, irmaaTierCap: 1, ltcgZeroCap: false, acaCliffCap: false, acaCliffCapFamilyOnly: false, magiCapCents: null, acaCliffBufferCents: null },
    },
    {
      name: "Fill capped at ACA cliff",
      ceilings: { bracketTopPct: null, irmaaTierCap: null, ltcgZeroCap: false, acaCliffCap: true, acaCliffCapFamilyOnly: false, magiCapCents: null, acaCliffBufferCents: null },
    },
  ];
  const LAB_BUILT_IN_NAMES: ReadonlySet<string> = new Set(
    LAB_BUILT_INS.map((b) => b.name),
  );
  // Run names must be unique across the WHOLE run — the
  // reserved rows ("Your current plan", "Do Nothing"), the
  // built-ins, and every saved strategy's mapped name. A
  // single mapping is computed from the ordered saved library
  // and used at every site (request rows, baseline options,
  // and the Saved-list priced lookup) so no site can drift:
  // seed the used-set with the reserved names, walk the saved
  // scenarios in library order, start each candidate from the
  // plain rule (suffix " (saved)" when the name itself is
  // reserved/built-in), and keep appending " (saved)" while
  // the candidate is already taken.
  const LAB_RESERVED_NAMES: ReadonlySet<string> = new Set([
    "Your current plan",
    "Do Nothing",
    ...LAB_BUILT_IN_NAMES,
  ]);
  const labRunNameMap = (
    scenarios: readonly { name: string }[],
  ): Map<string, string> => {
    const used = new Set<string>(LAB_RESERVED_NAMES);
    const map = new Map<string, string>();
    for (const sc of scenarios) {
      let candidate = LAB_RESERVED_NAMES.has(sc.name)
        ? `${sc.name} (saved)`
        : sc.name;
      while (used.has(candidate)) {
        candidate = `${candidate} (saved)`;
      }
      map.set(sc.name, candidate);
      used.add(candidate);
    }
    return map;
  };
  const labNameMap: Map<string, string> = labRunNameMap(
    data?.scenarios ?? [],
  );
  /* Display folding for the merged Lab table (presentation
     only): run rows that priced IDENTICALLY in every priced
     field the API returns — net cost, total tax, penalty,
     IRMAA, ACA credit, terminal charge, Social Security
     collected, ending after-tax wealth, and the four ending
     balances — are one outcome, shown once, under a
     plain-words title generated from the group's simplest
     strategy shape. The run data itself is untouched:
     request building, the staleness fingerprint, the
     baseline select, and the Saved-list priced lookup all
     keep working on the raw rows exactly as before. Folding
     is recomputed from each run's own figures, so rows that
     coincide under one plan / dial setting separate again in
     any run where a priced field differs; rows that merely
     tie on net cost but differ anywhere else stay separate,
     so badge ties are preserved. */
  type LabRunRow = LabData["scenarios"][number];
  // The folding key: every priced field of a run row, in a
  // fixed order. (The two delta fields are functions of
  // these fields and the baseline's, so equal keys always
  // carry equal deltas.)
  const labFoldKey = (row: LabRunRow): string =>
    JSON.stringify([
      row.netCostCents,
      row.totalTaxCents,
      row.penaltyCents,
      row.irmaaCents,
      row.acaCreditCents,
      row.terminalCents,
      row.ssCollectedCents,
      row.endingAfterTaxWealthCents,
      row.endingPretaxCents,
      row.endingRothCents,
      row.endingTaxableCents,
      row.endingHsaCents,
    ]);
  // Active-cap count of a row's ceilings — for picking a
  // folded group's SIMPLEST shape (e.g. an IRMAA tier cap
  // that never binds folds under its uncapped twin):
  // ceilings null counts 0; each set bracket top, IRMAA
  // tier, LTCG cap, ACA cliff cap, or MAGI cap counts one.
  const labShapeCapCount = (row: LabRunRow): number => {
    const c = row.effectiveInputs.ceilings;
    if (c == null) return 0;
    return (
      (c.bracketTopPct != null ? 1 : 0) +
      (c.irmaaTierCap != null ? 1 : 0) +
      (c.ltcgZeroCap ? 1 : 0) +
      (c.acaCliffCap ? 1 : 0) +
      (c.magiCapCents != null ? 1 : 0)
    );
  };
  /* Plain-words title for one row's strategy shape, from
     its priced effective inputs: "Spend <first draw bucket>
     first" plus the conversion rule its ceilings state.
     Returns null for any shape outside the plain templates —
     optimizer bunching or guardrail, gain harvesting, a live
     draw-order switch, a survivor scenario, a MAGI cap, or
     the 0%-gains cap — and the caller falls back to the
     row's run name: a plain name is never invented for an
     exotic shape. A draw-order switch counts as live only
     when BOTH halves are set; either blank is inert (the
     base order prices at every age), matching the engine. */
  const labPlainTitle = (row: LabRunRow): string | null => {
    const ei = row.effectiveInputs;
    if (ei.optimizerBunching === true || ei.optimizerGuardrail === true)
      return null;
    if (ei.gainsHarvest === true) return null;
    if (ei.survivorEnabled === true) return null;
    if (ei.drawOrderSwitchAge != null && ei.drawOrderAfter != null)
      return null;
    const first = drawOrderFromKey(ei.drawOrder ?? null)[0];
    const spend =
      first === "pretax"
        ? "Spend pre-tax first"
        : first === "taxable"
          ? "Spend taxable first"
          : first === "roth"
            ? "Spend Roth first"
            : null;
    if (spend == null) return null;
    const c = ei.ceilings;
    if (c == null) return `${spend}, no conversions`;
    if (c.magiCapCents != null || c.ltcgZeroCap) return null;
    // An era-aware cliff cap is outside the plain templates —
    // the run name and engine description carry it instead.
    if (c.acaCliffCapFamilyOnly) return null;
    const bracket = c.bracketTopPct ?? null;
    const irmaa = c.irmaaTierCap ?? null;
    const cliff = c.acaCliffCap === true;
    if (bracket == null && irmaa == null && !cliff)
      return `${spend}, no conversions`;
    if (bracket != null && irmaa == null && !cliff)
      return `${spend} + convert to ${bracket}%`;
    if (bracket == null && irmaa == null && cliff)
      return `${spend}, cap at the ACA cliff`;
    if (bracket != null && irmaa == null && cliff)
      return `${spend} + convert to the cliff`;
    if (bracket != null && irmaa != null && !cliff)
      return `${spend} + convert to ${bracket}%, capped at IRMAA Tier ${irmaa}`;
    return null;
  };
  type LabDisplayGroup = {
    key: string;
    members: LabRunRow[];
    rep: LabRunRow;
    title: string;
  };
  /* Group a run's rows for display: stable-sort by the
     engine-returned net cost (cheapest first, ties keep run
     order), then fold rows sharing a fold key. A group takes
     the position of its best-ranked member; its figures and
     engine description come from that member (every member
     priced identically, so any would do); its title comes
     from the SIMPLEST plain-titled shape among its members
     (fewest active caps, then lowest bracket top, then run
     order), falling back to that member's run name when no
     member's shape fits the plain templates. */
  const labDisplayGroups = (
    scenarios: readonly LabRunRow[],
  ): LabDisplayGroup[] => {
    const ranked = [...scenarios].sort(
      (a, b) => a.netCostCents - b.netCostCents,
    );
    const groups: LabDisplayGroup[] = [];
    const byKey = new Map<string, LabDisplayGroup>();
    for (const row of ranked) {
      const k = labFoldKey(row);
      const existing = byKey.get(k);
      if (existing) {
        existing.members.push(row);
        continue;
      }
      const g: LabDisplayGroup = {
        key: k,
        members: [row],
        rep: row,
        title: row.name,
      };
      byKey.set(k, g);
      groups.push(g);
    }
    for (const g of groups) {
      const plain = g.members.filter((m) => labPlainTitle(m) != null);
      const pool = plain.length > 0 ? plain : g.members;
      const source = [...pool].sort((a, b) => {
        const capDiff = labShapeCapCount(a) - labShapeCapCount(b);
        if (capDiff !== 0) return capDiff;
        const ba = a.effectiveInputs.ceilings?.bracketTopPct ?? -1;
        const bb = b.effectiveInputs.ceilings?.bracketTopPct ?? -1;
        return ba - bb;
      })[0]!;
      g.title = labPlainTitle(source) ?? source.name;
    }
    return groups;
  };
  /* Load-into-plan matching. Loading a saved strategy copies
     its full record into the working inputs via applyInputs,
     and the autosave then persists exactly what
     buildInputsPayload builds from that state. Whether the
     working plan already matches a strategy is judged on
     precisely those two payloads — never an approximation:
     the current side is the payload the autosave would write
     now (effective values, with a snapshot-followed balance
     still null — null is what "follow the snapshot" means in
     the saved record), and the strategy side is the scenario's
     full record normalized through the exact round trip a
     load performs (applyInputs' defaults and coercions, then
     buildSavePayload's parsing and clamps). Plan-record-only
     values (This year, Gift, Monte Carlo volatility) and the
     Lab dials / baseline are in neither payload, so they can
     never make a matching strategy look different. */
  const currentPlanPayload = (): PlanPayload => {
    const eff = buildSavePayload();
    return {
      ...eff,
      pretaxCents: balanceOverrides.pretax ? eff.pretaxCents : null,
      pretaxSpouseCents: balanceOverrides.pretaxSpouse ? eff.pretaxSpouseCents : null,
      rothCents: balanceOverrides.roth ? eff.rothCents : null,
      taxableCents: balanceOverrides.taxable ? eff.taxableCents : null,
      hsaCents: balanceOverrides.hsa ? eff.hsaCents : null,
    };
  };
  const scenarioAppliedPayload = (sc: ScenarioRow): PlanPayload => {
    // The same clamps buildSavePayload applies at its payload
    // boundary (its year / age / pct helpers and inline ranges).
    const clampYear = (v: number | null): number | null =>
      v == null ? null : Math.min(2100, Math.max(1900, v));
    const clampYear2200 = (v: number | null): number | null =>
      v == null ? null : Math.min(2200, Math.max(1900, v));
    const clampAge = (v: number | null, max: number): number | null =>
      v == null ? null : Math.min(max, Math.max(0, v));
    const clampPct = (v: number | null): number | null =>
      v == null ? null : Math.min(100, Math.max(0, v));
    const clampCount = (v: number | null): number | null =>
      v == null ? null : Math.min(20, Math.max(1, v));
    const declaredP = sc.ssPrimaryNoBenefit === true;
    const declaredS = sc.ssSpouseNoBenefit === true;
    const c = sc.ceilings;
    const bracket = c?.bracketTopPct ?? null;
    const irmaa = c?.irmaaTierCap ?? null;
    // Keys are written in buildSavePayload's own order, so the
    // JSON comparison in planMatchesScenario compares like
    // with like, field for field.
    return {
      birthYearPrimary: clampYear(sc.birthYearPrimary ?? null),
      birthYearSpouse: clampYear(sc.birthYearSpouse ?? null),
      filingStatus: sc.filingStatus ?? "mfj",
      pretaxCents: sc.pretaxCents ?? null,
      pretaxSpouseCents: sc.pretaxSpouseCents ?? null,
      survivorEnabled: sc.survivorEnabled ?? false,
      survivorWho: sc.survivorWho ?? "primary",
      survivorDeathYear: clampYear(sc.survivorDeathYear ?? null),
      rothCents: sc.rothCents ?? null,
      taxableCents: sc.taxableCents ?? null,
      taxableExcludeCents: sc.taxableExcludeCents ?? null,
      hsaCents: sc.hsaCents ?? null,
      taxableBasisPct: clampPct(sc.taxableBasisPct ?? null),
      taxableTiers:
        sc.taxableTiers == null
          ? null
          : sc.taxableTiers.map((t) => ({
              sharePct: Math.min(100, Math.max(0, t.sharePct)),
              basisPct: Math.min(100, Math.max(0, t.basisPct)),
            })),
      taxableDividendYieldPct: clampPct(sc.taxableDividendYieldPct ?? null),
      taxableInterestYieldPct: clampPct(sc.taxableInterestYieldPct ?? null),
      spendFromCashPct: clampPct(sc.spendFromCashPct ?? null),
      flexCutPct: clampPct(sc.flexCutPct ?? null),
      flexFloorPct: clampPct(sc.flexFloorPct ?? null),
      annualSpendingCents: sc.annualSpendingCents ?? null,
      retirementAge: clampAge(sc.retirementAge ?? null, 120),
      endAge: clampAge(sc.endAge ?? null, 130),
      expectedReturnPct: sc.expectedReturnPct ?? null,
      ssPrimaryAnnualCents: declaredP ? null : (sc.ssPrimaryAnnualCents ?? null),
      ssPrimaryStartAge: clampAge(sc.ssPrimaryStartAge ?? null, 120),
      ssPrimaryNoBenefit: declaredP,
      ssSpouseAnnualCents: declaredS ? null : (sc.ssSpouseAnnualCents ?? null),
      ssSpouseStartAge: clampAge(sc.ssSpouseStartAge ?? null, 120),
      ssSpouseNoBenefit: declaredS,
      otherOrdinaryCents: sc.otherOrdinaryCents ?? null,
      taxExemptInterestCents: sc.taxExemptInterestCents ?? null,
      convertedAlreadyCents: sc.convertedAlreadyCents ?? null,
      windowStartAge: clampAge(sc.windowStartAge ?? null, 120),
      windowStopAge: clampAge(sc.windowStopAge ?? null, 120),
      payTaxFrom: sc.payTaxFrom ?? "taxable",
      protectMinTaxableCents: sc.protectMinTaxableCents ?? null,
      preservePretaxCents: sc.preservePretaxCents ?? null,
      preserveExitRatePct: clampPct(sc.preserveExitRatePct ?? null),
      claimAgeFloor:
        sc.claimAgeFloor == null
          ? null
          : Math.min(70, Math.max(62, sc.claimAgeFloor)),
      yearlySalaryCents: sc.yearlySalaryCents ?? null,
      employer401kCents: sc.employer401kCents ?? null,
      employerHsaCents: sc.employerHsaCents ?? null,
      drawOrder: asDrawOrderKey(drawOrderKey(drawOrderFromKey(sc.drawOrder ?? null))),
      drawOrderSwitchAge: clampAge(sc.drawOrderSwitchAge ?? null, 120),
      drawOrderAfter: asDrawOrderKey(
        sc.drawOrderAfter != null &&
          DRAW_ORDER_OPTIONS.some((o) => o.key === sc.drawOrderAfter)
          ? sc.drawOrderAfter
          : DEFAULT_DRAW_ORDER_KEY,
      ),
      spouseSoleBeneficiary: sc.spouseSoleBeneficiary ?? true,
      primarySoleBeneficiaryOfSpouse:
        sc.primarySoleBeneficiaryOfSpouse ?? null,
      acaHouseholdSize: clampCount(sc.acaHouseholdSize ?? null),
      acaHouseholdSchedule:
        sc.acaHouseholdSchedule == null
          ? null
          : sc.acaHouseholdSchedule
              .map((s) => ({
                fromYear: clampYear2200(s.fromYear),
                householdSize: clampCount(s.householdSize),
              }))
              .filter(
                (s): s is { fromYear: number; householdSize: number } =>
                  s.fromYear != null && s.householdSize != null,
              ),
      collegeFallFromYear: clampYear2200(sc.collegeFallFromYear ?? null),
      collegeFallThroughYear: clampYear2200(sc.collegeFallThroughYear ?? null),
      acaBenchmarkCoupleCents: sc.acaBenchmarkCoupleCents ?? null,
      acaBenchmarkSingleCents: sc.acaBenchmarkSingleCents ?? null,
      acaBenchmarkFamilyCents: sc.acaBenchmarkFamilyCents ?? null,
      acaSpouseEndAge:
        sc.acaSpouseEndAge == null
          ? null
          : Math.min(80, Math.max(55, sc.acaSpouseEndAge)),
      inflationPct: sc.inflationPct ?? null,
      stateRatePct: clampPct(sc.stateRatePct ?? null),
      residenceState:
        sc.residenceState === "WA" || sc.residenceState === "other"
          ? sc.residenceState
          : null,
      capitalLossCarryInStCents: sc.capitalLossCarryInStCents ?? null,
      capitalLossCarryInLtCents: sc.capitalLossCarryInLtCents ?? null,
      itemizedMortgageInterestCents: sc.itemizedMortgageInterestCents ?? null,
      itemizedSaltPaidCents: sc.itemizedSaltPaidCents ?? null,
      itemizedCharitableCents: sc.itemizedCharitableCents ?? null,
      itemizedOtherCents: sc.itemizedOtherCents ?? null,
      educationStudents: sc.educationStudents ?? null,
      heirRatePct: clampPct(sc.heirRatePct ?? null),
      ceilings: {
        bracketTopPct:
          bracket === 10 || bracket === 12 || bracket === 22 || bracket === 24
            ? bracket
            : null,
        irmaaTierCap: irmaa != null && irmaa >= 0 && irmaa <= 5 ? irmaa : null,
        ltcgZeroCap: c?.ltcgZeroCap ?? false,
        acaCliffCap: c?.acaCliffCap ?? false,
        acaCliffCapFamilyOnly: c?.acaCliffCapFamilyOnly ?? false,
        magiCapCents: c?.magiCapCents ?? null,
        acaCliffBufferCents: c?.acaCliffBufferCents ?? null,
      },
      optimizerGuardrail: sc.optimizerGuardrail ?? null,
      optimizerBunching: sc.optimizerBunching ?? null,
      gainsHarvest: sc.gainsHarvest ?? null,
    };
  };
  const planMatchesScenario = (sc: ScenarioRow): boolean =>
    JSON.stringify(currentPlanPayload()) === JSON.stringify(scenarioAppliedPayload(sc));
  // The load itself, unchanged: the strategy's full record
  // becomes the working inputs and autosaves; the saved
  // strategy is never mutated. Feedback lands at the
  // long-standing message site.
  const loadLabScenario = (sc: ScenarioRow) => {
    setLabConfirmLoad(null);
    applyInputs(sc);
    setScenarioMsg(`Loaded ${sc.name} — the working inputs now match it.`);
  };
  const requestLabLoad = (sc: ScenarioRow) => {
    if (planMatchesScenario(sc)) {
      loadLabScenario(sc);
      return;
    }
    setLabConfirmDelete(null);
    setLabConfirmLoad(sc.name);
  };
  const buildLabRequest = (): LabRequest => {
    const dials: LabDialsObj = labDialsObject(labDialRawNow());
    const base: PlanPayload = { ...buildSavePayload() };
    if (dials.basisPct != null) base.taxableBasisPct = dials.basisPct;
    if (dials.spendingCents != null) base.annualSpendingCents = dials.spendingCents;
    // A claim dial on the base plan re-derives the benefit at
    // the dial age from the plan's own anchor, the same
    // derivation the compare applies to claim-age patches.
    const deriveBaseClaim = (
      who: "primary" | "spouse",
      dialAge: number | null,
    ) => {
      if (dialAge == null) return;
      const amountKey = who === "primary" ? "ssPrimaryAnnualCents" : "ssSpouseAnnualCents";
      const ageKey = who === "primary" ? "ssPrimaryStartAge" : "ssSpouseStartAge";
      const amount = base[amountKey];
      const anchorAge = base[ageKey];
      const birthYear = who === "primary" ? base.birthYearPrimary : base.birthYearSpouse;
      if (amount != null && anchorAge != null && birthYear != null && dialAge !== anchorAge) {
        base[amountKey] = Math.round(
          ssAnnualAtClaimAge(amount / 100, anchorAge, dialAge, birthYear) * 100,
        );
      }
      base[ageKey] = dialAge;
    };
    deriveBaseClaim("primary", dials.ssPrimaryStartAge);
    deriveBaseClaim("spouse", dials.ssSpouseStartAge);
    if (dials.survivorEnabled != null) {
      base.survivorEnabled = dials.survivorEnabled;
      if (dials.survivorEnabled) {
        base.survivorWho = dials.survivorWho ?? base.survivorWho ?? "primary";
        base.survivorDeathYear = dials.survivorDeathYear;
      }
    }
    for (const k of KNOB_DIAL_KEYS) {
      const v = dials[k];
      if (v != null) (base as Record<string, unknown>)[k] = v;
    }
    const rows: LabRequest["scenarios"] = [];
    for (const sc of data?.scenarios ?? []) {
      const { name, ...rest } = sc;
      // Only the four snapshot-followed balances treat a null
      // as "not frozen": pretaxCents, rothCents, taxableCents,
      // hsaCents — there null is the follow-the-snapshot
      // marker, so the field must be ABSENT from the patch to
      // inherit the base plan's resolved value, exactly as
      // loading the scenario follows the snapshot. EVERY other
      // field's recorded null is a frozen strategy value and
      // rides into the patch as an explicit null — the compare
      // merge treats any present key (null included) as an
      // override — exactly as ceilings: null (Do Nothing — no
      // conversions) always has. Omitting any other null would
      // silently price the base plan's value for that field
      // instead of the saved strategy's, and the row would no
      // longer be the compare's figures for the saved shape.
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rest)) {
        if (
          v === null &&
          (k === "pretaxCents" ||
            k === "rothCents" ||
            k === "taxableCents" ||
            k === "hsaCents")
        )
          continue;
        patch[k] = v;
      }
      if (dials.basisPct != null) patch.taxableBasisPct = dials.basisPct;
      if (dials.spendingCents != null) patch.annualSpendingCents = dials.spendingCents;
      if (dials.ssPrimaryStartAge != null) {
        patch.ssPrimaryStartAge = dials.ssPrimaryStartAge;
        patch.ssPrimaryAnnualCents = undefined;
      }
      if (dials.ssSpouseStartAge != null) {
        patch.ssSpouseStartAge = dials.ssSpouseStartAge;
        patch.ssSpouseAnnualCents = undefined;
      }
      if (dials.survivorEnabled != null) {
        patch.survivorEnabled = dials.survivorEnabled;
        if (dials.survivorEnabled) {
          patch.survivorWho = dials.survivorWho ?? patch.survivorWho ?? "primary";
          patch.survivorDeathYear = dials.survivorDeathYear;
        }
      }
      for (const k of KNOB_DIAL_KEYS) {
        const v = dials[k];
        if (v != null) patch[k] = v;
      }
      rows.push({
        name: labNameMap.get(name) ?? name,
        overrides: patch as LabRequest["scenarios"][number]["overrides"],
      });
    }
    rows.push({ name: "Your current plan", overrides: {} });
    rows.push({ name: "Do Nothing", overrides: { ceilings: null } });
    // Built-in fill rules of the loaded plan: a ceilings-only
    // patch over the (dial-adjusted) base, so each prices the
    // current plan under exactly one replacement ceiling set —
    // the same construction the acceptance run prices.
    for (const b of LAB_BUILT_INS) {
      rows.push({ name: b.name, overrides: { ceilings: b.ceilings } });
    }
    const baselineName = rows.some((r) => r.name === labBaseline)
      ? labBaseline
      : "Do Nothing";
    return {
      ...base,
      baselineName,
      scenarios: rows,
      fafsaReportableAssetsCents: fafsaReportableAssetsCentsValue(),
    };
  };
  const runLabMut = useMutation({
    mutationFn: (input: LabRequest) => api.runRothCompare(input),
    onSuccess: (res, vars) => {
      setLabResult(res);
      setLabFingerprint(JSON.stringify(vars));
      setLabError(res.ok ? "" : res.reason);
    },
    onError: () => setLabError("The library could not be priced — try again."),
  });
  // Persist the debate dials into the Roth UI state (debounced,
  // like the plan autosave) so they survive reloads. Scratch
  // only: this writes the UI-state blob and nothing else.
  const labDialTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!labInit) return;
    if (labDialTimer.current != null) window.clearTimeout(labDialTimer.current);
    labDialTimer.current = window.setTimeout(() => {
      saveUiState.mutate({ labDials: labDialsObject(labDialRawNow()) });
    }, 700);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    labInit, labDialBasis, labDialSpending, labDialSsP, labDialSsS,
    labDialSurvivor, labDialSurvivorWho, labDialSurvivorYear,
    labDialAcaEndAge, labDialBenchFamily, labDialBenchCouple, labDialBenchSingle,
    labDialAcaSteps, labDialReturn, labDialInflation,
    labDialHeir, labDialStateRate, labDialWinStart, labDialWinStop,
    labDialPreserve, labDialPretax, labDialTaxable, labDialRoth,
  ]);

  /* Strategy editor: open a saved row's strategy fields into
     the editor state, and save them back through the
     full-record update writer — every non-strategy field of
     the row rides along unchanged. */
  type ScenarioRow = RothData["scenarios"][number];
  const openLabEditor = (sc: ScenarioRow) => {
    const c = sc.ceilings;
    setEdBracket(
      c?.bracketTopPct === 10 || c?.bracketTopPct === 12 || c?.bracketTopPct === 22 || c?.bracketTopPct === 24
        ? (String(c.bracketTopPct) as "10" | "12" | "22" | "24")
        : "",
    );
    setEdIrmaa(
      c?.irmaaTierCap != null && c.irmaaTierCap >= 0 && c.irmaaTierCap <= 5
        ? (String(c.irmaaTierCap) as "0" | "1" | "2" | "3" | "4" | "5")
        : "",
    );
    setEdLtcg(c?.ltcgZeroCap ?? false);
    setEdAca(c?.acaCliffCap ?? false);
    setEdAcaFamilyOnly(c?.acaCliffCapFamilyOnly ?? false);
    setEdMagiCap(c?.magiCapCents == null ? "" : fmtMoneyInput(c.magiCapCents / 100));
    setEdCliffBuffer(c?.acaCliffBufferCents == null ? "" : fmtMoneyInput(c.acaCliffBufferCents / 100));
    setEdDrawOrder(drawOrderKey(drawOrderFromKey(sc.drawOrder ?? null)));
    setEdSwitchAge(sc.drawOrderSwitchAge == null ? "" : String(sc.drawOrderSwitchAge));
    setEdAfterOrder(
      sc.drawOrderAfter != null &&
        DRAW_ORDER_OPTIONS.some((o) => o.key === sc.drawOrderAfter)
        ? sc.drawOrderAfter
        : DEFAULT_DRAW_ORDER_KEY,
    );
    setEdWinStart(sc.windowStartAge == null ? "" : String(sc.windowStartAge));
    setEdWinStop(sc.windowStopAge == null ? "" : String(sc.windowStopAge));
    setEdPayTaxFrom(sc.payTaxFrom ?? "taxable");
    setEdGuardrail(sc.optimizerGuardrail ?? null);
    setEdBunching(sc.optimizerBunching ?? null);
    setEdHarvest(sc.gainsHarvest ?? null);
    setEdPreserve(sc.preservePretaxCents == null ? "" : fmtMoneyInput(sc.preservePretaxCents / 100));
    setEdPreserveRate(sc.preserveExitRatePct == null ? "" : String(sc.preserveExitRatePct));
    setLabEditingName(sc.name);
  };
  const saveLabEditor = (sc: ScenarioRow) => {
    const { name, ...rest } = sc;
    // Contract v65 (F22): the scenario payload exactly as loaded
    // is the save's scenario-level CAS base — the server refuses
    // when the stored scenario no longer matches it, and the
    // refusal reason surfaces via setScenarioMsg in the mutation's
    // onSuccess while the editor stays open.
    const age = (s: string): number | null => {
      const n = parseIntField(s);
      return n == null ? null : Math.min(120, Math.max(0, n));
    };
    const pct = (s: string): number | null => {
      const n = parseNum(s);
      return n == null ? null : Math.min(100, Math.max(0, n));
    };
    updateScenario.mutate({
      ...rest,
      name,
      baseScenario: rest,
      ceilings: {
        bracketTopPct: edBracket === "" ? null : Number(edBracket),
        irmaaTierCap: edIrmaa === "" ? null : Number(edIrmaa),
        ltcgZeroCap: edLtcg,
        acaCliffCap: edAca,
        acaCliffCapFamilyOnly: edAcaFamilyOnly,
        magiCapCents: parseMoney(edMagiCap),
        acaCliffBufferCents: parseMoney(edCliffBuffer),
      },
      drawOrder: asDrawOrderKey(edDrawOrder),
      drawOrderSwitchAge: age(edSwitchAge),
      drawOrderAfter: asDrawOrderKey(edAfterOrder),
      windowStartAge: age(edWinStart),
      windowStopAge: age(edWinStop),
      payTaxFrom: edPayTaxFrom,
      optimizerGuardrail: edGuardrail,
      optimizerBunching: edBunching,
      gainsHarvest: edHarvest,
      preservePretaxCents: parseMoney(edPreserve),
      preserveExitRatePct: pct(edPreserveRate),
    });
  };

  /* ---------------- lifetime-tax optimizer ---------------- */
  type OptRequest = Parameters<typeof api.runRothOptimizer>[0];
  const runOptimizerMut = useMutation({
    mutationFn: (input: OptRequest) => api.runRothOptimizer(input),
    onMutate: () => setOptRunFailed(false),
    onSuccess: (res) => {
      setOptRunFailed(false);
      setOptResult(res);
    },
    onError: () => setOptRunFailed(true),
  });
  // Save an optimizer result as a scenario: the working inputs
  // with the result's ceilings, window stop, and variant flags —
  // plus the result's claiming ages, stored as the scenario's
  // Social Security start ages with the derived yearly benefits
  // as its amounts — the exact parameters whose re-run
  // reproduces its schedule.
  const saveOptimizerScenario = (score: OptScore) => {
    const base = buildSavePayload();
    saveScenario.mutate({
      ...base,
      ceilings: score.ceilings,
      windowStopAge: score.windowStopAge,
      optimizerGuardrail: score.guardrail,
      optimizerBunching: score.bunching,
      drawOrder: asDrawOrderKey(score.drawOrder),
      // A declared "No benefit" is never overwritten by a
      // claiming result: that person was not searched, so the
      // scenario keeps the declaration and a null amount.
      ssPrimaryStartAge: score.claimPrimaryAge ?? base.ssPrimaryStartAge,
      ssPrimaryAnnualCents: base.ssPrimaryNoBenefit
        ? null
        : score.claimPrimaryAge != null
          ? Math.round(score.ssPrimaryAnnual * 100)
          : base.ssPrimaryAnnualCents,
      ssSpouseStartAge: score.claimSpouseAge ?? base.ssSpouseStartAge,
      ssSpouseAnnualCents: base.ssSpouseNoBenefit
        ? null
        : score.claimSpouseAge != null
          ? Math.round(score.ssSpouseAnnual * 100)
          : base.ssSpouseAnnualCents,
    });
  };

  /* ---------------- market-uncertainty check ----------------
     Read-only: re-prices the optimizer's winning strategy and Do
     Nothing across varied return paths, server-side. The request
     is the full plan payload plus the two score descriptors in
     exactly the fields the optimizer score already carries, plus
     the check's volatility. The result is stored WITH a
     fingerprint of that request object; whenever the current
     working inputs, the optimizer winner / Do Nothing, or the
     volatility differ from the fingerprint, the shown figures
     are stale and the panel says so instead of presenting them
     as current. The run itself saves nothing. */
  // The plan's FAFSA-reportable assets, assembled by the shared
  // helper: the priced taxable balance (which already includes
  // Cash when following Net Worth) plus — only while the taxable
  // balance follows the snapshot — the snapshot's College / 529
  // and Non-Taxable subtotals. Sent to the optimizer / Monte
  // Carlo check as a transient cents sibling; never saved.
  const fafsaReportableAssetsCentsValue = (): number =>
    Math.round(
      fafsaReportableAssets(
        parseDollars(taxableBal) ?? 0,
        !balanceOverrides.taxable,
        data?.snapshot?.bucket529Cents ?? null,
        data?.snapshot?.nonTaxableCents ?? null,
      ) * 100,
    );
  const mcScoreInFromScore = (s: OptScore): McCheckRequest["winner"] => ({
    name: s.name,
    windowStopAge: s.windowStopAge,
    guardrail: s.guardrail,
    bunching: s.bunching,
    ceilings: {
      bracketTopPct: s.ceilings.bracketTopPct,
      irmaaTierCap: s.ceilings.irmaaTierCap,
      ltcgZeroCap: s.ceilings.ltcgZeroCap,
      acaCliffCap: s.ceilings.acaCliffCap,
      acaCliffCapFamilyOnly: s.ceilings.acaCliffCapFamilyOnly,
      magiCapCents: s.ceilings.magiCapCents,
      acaCliffBufferCents: s.ceilings.acaCliffBufferCents,
    },
    claimPrimaryAge: s.claimPrimaryAge,
    claimSpouseAge: s.claimSpouseAge,
    ssPrimaryAnnual: s.ssPrimaryAnnual,
    ssSpouseAnnual: s.ssSpouseAnnual,
    // The check's request schema now requires one of the six
    // engine draw-order keys (API follow-on 2, F6); the score's
    // key always is one (the server emits it via drawOrderKey),
    // and asDrawOrderKey is the client's existing guard for
    // exactly this string-to-key narrowing.
    drawOrder: asDrawOrderKey(s.drawOrder),
  });
  const mcVolatilityValue = (): number => {
    const n = parseNum(mcVolatility);
    return n == null ? 15 : Math.min(100, Math.max(0, n));
  };
  const buildMcRequest = (): McCheckRequest | null => {
    if (!optResult?.ok || !optResult.winner || !optResult.doNothing) return null;
    return {
      ...buildSavePayload(),
      winner: mcScoreInFromScore(optResult.winner),
      doNothing: mcScoreInFromScore(optResult.doNothing),
      mcVolatilityPct: mcVolatilityValue(),
      fafsaReportableAssetsCents: fafsaReportableAssetsCentsValue(),
    };
  };
  const runMcCheckMut = useMutation({
    mutationFn: (input: McCheckRequest) => api.runRothMonteCarloCheck(input),
    onMutate: () => setMcRunFailed(false),
    onSuccess: (res, vars) => {
      setMcRunFailed(false);
      setMcResult({ data: res, fingerprint: JSON.stringify(vars) });
    },
    onError: () => setMcRunFailed(true),
  });

  /* ---------------- year funding ----------------
     Read-only ledger of the plan exactly as it stands: the
     run (runRothFunding) prices the working plan once,
     server-side, with the plan's own fill settings — no
     scratch dials — and returns every priced year's needs and
     funding sources in cents. Nothing here writes or saves
     anything; the selected year (deep view) is local display
     state only. Pricing runs when the tab is opened (and on
     Refresh), never live on each keystroke. */
  type YfData = ApiResponse<typeof api, "runRothFunding">;
  type YfRequest = Parameters<typeof api.runRothFunding>[0];
  const [yfResult, setYfResult] = useState<YfData | null>(null);
  const [yfFingerprint, setYfFingerprint] = useState("");
  const [yfError, setYfError] = useState("");
  const [yfYear, setYfYear] = useState<number | null>(null);
  const runYfMut = useMutation({
    mutationFn: (input: YfRequest) => api.runRothFunding(input),
    onSuccess: (res, vars) => {
      setYfResult(res);
      setYfFingerprint(JSON.stringify(vars));
      setYfError(res.ok ? "" : res.reason);
    },
    onError: () => setYfError("Year funding could not run — try again."),
  });
  const yfFingerprintNow = JSON.stringify(buildSavePayload());
  const yfStale =
    yfResult != null && yfFingerprint !== "" && yfFingerprintNow !== yfFingerprint;
  useEffect(() => {
    if (resultsMode !== "yearFunding" || !init || runYfMut.isPending) return;
    if (yfFingerprint === yfFingerprintNow && yfResult != null) return;
    runYfMut.mutate(buildSavePayload());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultsMode, init]);

  /* ---------------- work-years compare ----------------
     Compute-only: the run prices the saved plan plus the
     scratch quit ages server-side (runWorkYearsCompare) and
     saves nothing — the quit ages are never persisted, and the
     job fields reach the run through the normal save payload
     (they are saved plan fields, autosaved like the rest).
     Optimizer runs are heavy, so pricing happens on the
     Compare button only, never live. */
  type WyRequest = Parameters<typeof api.runWorkYearsCompare>[0];
  const runWyMut = useMutation({
    mutationFn: (input: WyRequest) => api.runWorkYearsCompare(input),
    onSuccess: (res, vars) => {
      setWyResult(res);
      setWyFingerprint(JSON.stringify(vars));
      setWyError(res.ok ? "" : res.reason);
    },
    onError: () => setWyError("The compare could not run — try again."),
  });
  // Prefill the scratch quit ages once, when the plan first
  // loads: window-start age, +4, +6. After that they are the
  // user's scratch — edits to the plan never rewrite them.
  useEffect(() => {
    if (!init || wyPrefilledRef.current) return;
    wyPrefilledRef.current = true;
    const start = parseIntField(winStart) ?? parseIntField(retirementAge) ?? 57;
    setWyQuitAges([String(start), String(start + 4), String(start + 6)]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [init]);
  const runWorkYears = () => {
    const startAge = parseIntField(winStart) ?? parseIntField(retirementAge);
    const ages = wyQuitAges
      .map((s) => parseIntField(s))
      .filter((n): n is number => n != null);
    if (ages.length === 0) {
      setWyError("Enter at least one quit age.");
      return;
    }
    if (new Set(ages).size !== ages.length) {
      setWyError("Quit ages must be different from each other.");
      return;
    }
    if (startAge != null && ages.some((a) => a < startAge)) {
      setWyError(
        `Quit ages must be at least your window-start age (${startAge}).`,
      );
      return;
    }
    if (ages.some((a) => a > 75)) {
      setWyError("Quit ages can be no more than 75.");
      return;
    }
    setWyError("");
    runWyMut.mutate({
      ...buildSavePayload(),
      quitAges: ages,
      fafsaReportableAssetsCents: fafsaReportableAssetsCentsValue(),
    });
  };
  // The fingerprint of what a run right now would price; the
  // stored result is current only while it matches.
  const mcRequestNow = buildMcRequest();
  const mcFingerprintNow = mcRequestNow ? JSON.stringify(mcRequestNow) : null;
  const mcResultCurrent =
    mcResult != null && mcFingerprintNow != null && mcResult.fingerprint === mcFingerprintNow;

  // Work-years staleness: the shown compare figures are current
  // only while the working inputs and quit ages still match the
  // fingerprint of the last run.
  const wyAgesNow = wyQuitAges
    .map((s) => parseIntField(s))
    .filter((n): n is number => n != null);
  const wyFingerprintNow = JSON.stringify({
    ...buildSavePayload(),
    quitAges: wyAgesNow,
    fafsaReportableAssetsCents: fafsaReportableAssetsCentsValue(),
  });
  const wyStale =
    wyResult != null && wyFingerprint !== "" && wyFingerprintNow !== wyFingerprint;
  const wySalaryBlank = (parseMoney(jobSalary) ?? 0) <= 0;

  /* ---------------- gift stock compare ----------------
     Compute-only: the run prices the saved plan plus the gift
     description server-side (runRothGiftCompare) — the plan
     twice, as saved and with the gift — and saves nothing
     beyond the gift fields themselves, which autosave with
     the plan record like every other input. Two joint
     optimizer runs are heavy, so pricing happens on the
     Compare button only, never live. */
  type GiftRequest = Parameters<typeof api.runRothGiftCompare>[0];
  const buildGiftRequest = (): GiftRequest => {
    const eff = buildInputsPayload();
    return {
      ...buildSavePayload(),
      giftAge: eff.giftAge,
      giftAmountCents: eff.giftAmountCents,
      giftBasisCents: eff.giftBasisCents,
      giftKidBirthYear: eff.giftKidBirthYear,
      giftKidStudent: eff.giftKidStudent,
      giftKidOtherIncomeCents: eff.giftKidOtherIncomeCents,
      giftSaleAge: eff.giftSaleAge,
      fafsaReportableAssetsCents: fafsaReportableAssetsCentsValue(),
    };
  };
  const runGiftMut = useMutation({
    mutationFn: (input: GiftRequest) => api.runRothGiftCompare(input),
    onSuccess: (res, vars) => {
      setGiftResult(res);
      setGiftFingerprint(JSON.stringify(vars));
      setGiftError(res.ok ? "" : res.reason);
    },
    onError: () => setGiftError("The comparison could not run — try again."),
  });
  // Age guards, computed with the ONE shared guard function
  // (giftAgeGuardMessage in server/src/giftModel.ts) that the
  // model throws and the action returns — so the message the
  // tab shows is the message the server would return, word
  // for word. Returns "" when the description can be priced
  // or when the plan's own years aren't known yet.
  const giftGuardFromFields = (): string => {
    const byP = parseIntField(birthYearP);
    const end = parseIntField(endAge);
    if (byP == null || end == null) return "";
    const startAgeCalc = new Date().getFullYear() - byP;
    const effGiftAge = parseIntField(giftAge) ?? startAgeCalc;
    const effSaleAge = parseIntField(giftSaleAge) ?? effGiftAge;
    return (
      giftAgeGuardMessage({
        startAge: startAgeCalc,
        endAge: end,
        giftAge: effGiftAge,
        saleAge: effSaleAge,
        kidBirthYear: parseIntField(giftKidBirthYear),
        saleYear: byP + effSaleAge,
      }) ?? ""
    );
  };
  const runGiftCompare = () => {
    if ((parseMoney(giftAmount) ?? 0) <= 0) {
      setGiftError("Enter a gift amount to price the comparison.");
      return;
    }
    const guard = giftGuardFromFields();
    if (guard) {
      // No priced ledgers for an unpriceable description:
      // any earlier run's figures come down with the message.
      setGiftResult(null);
      setGiftError(guard);
      return;
    }
    setGiftError("");
    runGiftMut.mutate(buildGiftRequest());
  };
  const giftFingerprintNow = JSON.stringify(buildGiftRequest());
  const giftStale =
    giftResult != null && giftFingerprint !== "" && giftFingerprintNow !== giftFingerprint;
  const giftAmountBlank = (parseMoney(giftAmount) ?? 0) <= 0;

  /* ---------------- plan inputs & results ---------------- */
  const startYear = new Date().getFullYear();
  const planInputs: RothPlanInputs | null = useMemo(() => {
    if (!init) return null;
    const byP = parseIntField(birthYearP);
    const byS = parseIntField(birthYearS);
    const spend = parseDollars(spending);
    const retAge = parseIntField(retirementAge);
    const end = parseIntField(endAge);
    const expRet = parseNum(expectedPct);
    if (byP == null || byP < 1930 || byP > 2015) return null;
    if (spend == null || spend < 0) return null;
    if (retAge == null || end == null || expRet == null) return null;
    const ageNow = startYear - byP;
    if (end <= ageNow) return null;
    const rmdAge = rmdAgeForBirthYear(byP);
    return {
      startYear,
      birthYearPrimary: byP,
      birthYearSpouse: byS,
      filingStatus,
      endAgePrimary: end,
      pretaxStart: parseDollars(pretax) ?? 0,
      pretaxSpouseStart: parseDollars(pretaxSpouse) ?? 0,
      survivorEnabled: survivorOn,
      survivorWho,
      survivorDeathYear: parseIntField(survivorDeathYear),
      rothStart: parseDollars(rothBal) ?? 0,
      // Exclude-from-plan: while the taxable balance follows
      // the snapshot, the priced pool is the displayed pool
      // minus the exclusion, floored at $0 — the excluded money
      // is not spent, sold, yielded on, or counted in ending
      // wealth. A saved Taxable override prices exactly as
      // entered and the exclusion is inert.
      taxableStart: balanceOverrides.taxable
        ? (parseDollars(taxableBal) ?? 0)
        : Math.max(
            0,
            (parseDollars(taxableBal) ?? 0) -
              Math.max(0, parseDollars(taxableExclude) ?? 0),
          ),
      hsaStart: parseDollars(hsaBal) ?? 0,
      taxableBasisPct: parseNum(basisPct) ?? 100,
      // A blank basis % models no gains on draws (the ?? 100
      // above) and leaves gain harvesting inert — no basis is
      // invented for it to step up. Basis tiers are an entered
      // basis in their own right: with a complete tier split
      // the basis is not blank even if the % field is, and the
      // tiers replace the % as the pool's basis source. An
      // incomplete split (tiersFromRows null) prices as the
      // one pool the % describes, exactly what saves.
      taxableBasisBlank:
        parseNum(basisPct) == null && tiersFromRows(basisTiers) == null,
      taxableTiers: tiersFromRows(basisTiers),
      // Taxable yields: blank = no yield modeled (the engine
      // prices the plan exactly as before); a typed % makes
      // that share of each year's starting taxable balance
      // mandatory dividend / interest income for the year.
      taxableDividendYieldPct: parseNum(divYieldPct),
      taxableInterestYieldPct: parseNum(intYieldPct),
      // Spend-from-cash (API-only field, round-tripped above):
      // the local pricing carries it exactly like the server
      // paths, with the sleeve sized from the snapshot's cash
      // bucket when the taxable balance is following the
      // snapshot, and $0 when the balance is a typed entry.
      spendFromCashPct,
      // Flexible spending (API-only fields, round-tripped
      // above): the local pricing carries them exactly like
      // the server paths.
      flexCutPct,
      flexFloorPct,
      // The sleeve is the pool's cash portion; an exclusion is
      // taken out of that cash first (mirroring the server's
      // threading in resolveArgsBalances), floored at $0.
      spendFromCashSleeveStart: balanceOverrides.taxable
        ? 0
        : Math.max(
            0,
            (data?.snapshot?.cashCents ?? 0) -
              Math.max(0, (parseDollars(taxableExclude) ?? 0) * 100),
          ) / 100,
      annualSpending: spend,
      retirementAge: retAge,
      expectedReturnPct: expRet,
      ssPrimaryAnnual: ssPrimaryNoBenefit ? 0 : (parseDollars(ssP) ?? 0),
      ssPrimaryStartAge: parseIntField(ssPAge),
      ssPrimaryNoBenefit,
      ssSpouseAnnual: ssSpouseNoBenefit ? 0 : (parseDollars(ssS) ?? 0),
      ssSpouseStartAge: parseIntField(ssSAge),
      ssSpouseNoBenefit,
      otherOrdinaryAnnual: parseDollars(otherOrd) ?? 0,
      taxExemptInterestAnnual: parseDollars(taxExempt) ?? 0,
      convertedAlreadyThisYear: parseDollars(convertedAlready) ?? 0,
      windowStartAge: parseIntField(winStart) ?? retAge,
      windowStopAge: parseIntField(winStop) ?? rmdAge - 1,
      payTaxFrom,
      protectMinTaxable: parseDollars(protectMin) ?? 0,
      preservePretax: parseDollars(preservePretax) ?? 0,
      preserveExitRatePct: parseNum(preserveExitRate) ?? (parseNum(heirRate) ?? SEED_HEIR_RATE),
      claimAgeFloor: (() => {
        const n = parseIntField(claimAgeFloor);
        return n == null ? null : Math.min(70, Math.max(62, n));
      })(),
      drawOrder: drawOrderFromKey(drawOrder),
      // Draw-order switch: the after-order only reaches the
      // engine while an age is entered — with the age blank the
      // switch is inert and the base order applies at every age.
      drawOrderSwitchAge: parseIntField(drawOrderSwitchAge),
      drawOrderAfter:
        parseIntField(drawOrderSwitchAge) != null
          ? drawOrderFromKey(drawOrderAfter)
          : null,
      spouseSoleBeneficiary: soleBeneficiary,
      primarySoleBeneficiaryOfSpouse,
      acaHouseholdSize: parseIntField(acaSize) ?? 1,
      acaHouseholdSchedule: acaStepsFromRows(acaSteps),
      collegeFallFromYear: parseIntField(collegeFromYear),
      collegeFallThroughYear: parseIntField(collegeThroughYear),
      acaBenchmarkCouple: parseDollars(benchCouple),
      acaBenchmarkSingle: parseDollars(benchSingle),
      acaBenchmarkFamily: parseDollars(benchFamily),
      acaSpouseEndAge: parseIntField(acaSpouseEndAge),
      inflationPct: parseNum(inflation) ?? SEED_INFLATION,
      stateRatePct: parseNum(stateRate) ?? 0,
      residenceState,
      capitalLossCarryInSt: parseDollars(carryInSt) ?? 0,
      capitalLossCarryInLt: parseDollars(carryInLt) ?? 0,
      itemizedMortgageInterest: parseDollars(itemizedMortgage) ?? 0,
      itemizedSaltPaid: parseDollars(itemizedSalt) ?? 0,
      itemizedCharitable: parseDollars(itemizedCharitable) ?? 0,
      itemizedOther: parseDollars(itemizedOther) ?? 0,
      educationStudents:
        studentsFromRows(eduStudents)?.map((s) => ({
          year: s.year,
          expenses: s.expensesCents / 100,
          aotcEligible: s.aotcEligible,
        })) ?? null,
      heirRatePct: parseNum(heirRate) ?? SEED_HEIR_RATE,
      // Display-layer only: gates the college-years watch-out.
      // The priced taxable balance (Cash included when following
      // Net Worth) plus — only while following — the snapshot's
      // College / 529 and Non-Taxable subtotals.
      fafsaReportableAssets: fafsaReportableAssets(
        parseDollars(taxableBal) ?? 0,
        !balanceOverrides.taxable,
        data?.snapshot?.bucket529Cents ?? null,
        data?.snapshot?.nonTaxableCents ?? null,
      ),
    };
  }, [
    init, startYear, birthYearP, birthYearS, filingStatus, pretax, pretaxSpouse,
    survivorOn, survivorWho, survivorDeathYear, rothBal, taxableBal, taxableExclude,
    hsaBal, basisPct, basisTiers, divYieldPct, intYieldPct, spendFromCashPct, flexCutPct, flexFloorPct, spending, retirementAge, endAge, expectedPct, ssP, ssPAge, ssS,
    ssSAge, ssPrimaryNoBenefit, ssSpouseNoBenefit, otherOrd, taxExempt, convertedAlready, winStart, winStop, payTaxFrom,
    protectMin, preservePretax, preserveExitRate, claimAgeFloor, drawOrder, drawOrderSwitchAge, drawOrderAfter, soleBeneficiary, primarySoleBeneficiaryOfSpouse, acaSize, acaSteps, collegeFromYear, collegeThroughYear, benchCouple,
    benchSingle, benchFamily, acaSpouseEndAge, inflation, stateRate, residenceState, carryInSt, carryInLt, itemizedMortgage, itemizedSalt, itemizedCharitable, itemizedOther, eduStudents, heirRate, balanceOverrides, data,
  ]);

  const ceilings: FillCeilings = useMemo(
    () => ({
      bracketTopPct: ceilBracket === "" ? null : Number(ceilBracket),
      irmaaTierCap: ceilIrmaa === "" ? null : Number(ceilIrmaa),
      ltcgZeroCap: ceilLtcg,
      acaCliffCap: ceilAca,
      acaCliffCapFamilyOnly: ceilAcaFamilyOnly,
      magiCap: parseDollars(magiCap),
      acaCliffBuffer: parseDollars(cliffBuffer),
    }),
    [ceilBracket, ceilIrmaa, ceilLtcg, ceilAca, ceilAcaFamilyOnly, magiCap, cliffBuffer],
  );
  const anyCeiling =
    ceilings.bracketTopPct != null ||
    ceilings.irmaaTierCap != null ||
    ceilings.ltcgZeroCap ||
    ceilings.acaCliffCap ||
    ceilings.magiCap != null;

  const currentStrategy: RothStrategy = useMemo(
    () => ({
      id: "current",
      name: "Your fill settings",
      ceilings: anyCeiling ? ceilings : null,
      guardrail: guardrailOn ?? false,
      bunching: bunchingOn ?? false,
      gainsHarvest: gainsHarvestOn ?? false,
    }),
    [ceilings, anyCeiling, guardrailOn, bunchingOn, gainsHarvestOn],
  );

  const mainResult = useMemo(
    () => (planInputs ? simulateRothPlan(planInputs, currentStrategy) : null),
    [planInputs, currentStrategy],
  );
  const compareResults = useMemo(
    () =>
      planInputs
        ? ROTH_COMPARE_STRATEGIES.map((s) => ({
            strategy: s,
            result: simulateRothPlan(planInputs, s),
          }))
        : [],
    [planInputs],
  );

  /* ---------------- proof view (non-saving) ----------------
     The proof re-runs the plan to PROOF_END_AGE (110) in memory,
     with the end age extended and — only when the reader types
     them on this tab — the scratch overrides above applied:
     starting balances (pre-tax You / wife, Taxable, Roth, HSA),
     annual spending, and where the tax bill is paid from. A
     blank override uses the plan's own value, so with nothing
     typed the run is the plan exactly as it stands. It never
     writes a plan field, never calls a save, and never touches
     the saved record: planInputs keeps the saved end age and
     values, buildSavePayload keeps saving those, and the
     overrides live only in these memos. The Do Nothing twin
     runs the same extended inputs with no ceilings, so the
     proof can show what the plan's own caps buy in pre-tax
     life. */
  const proofInputs = useMemo(() => {
    if (!planInputs) return null;
    const over = (s: string, fallback: number): number => {
      const v = parseDollars(s);
      return v == null ? fallback : v;
    };
    return {
      ...planInputs,
      endAgePrimary: Math.max(PROOF_END_AGE, planInputs.endAgePrimary),
      pretaxStart: over(proofPretax, planInputs.pretaxStart),
      pretaxSpouseStart: over(
        proofPretaxSpouse,
        planInputs.pretaxSpouseStart ?? 0,
      ),
      taxableStart: over(proofTaxable, planInputs.taxableStart),
      rothStart: over(proofRoth, planInputs.rothStart),
      hsaStart: over(proofHsa, planInputs.hsaStart),
      annualSpending: over(proofSpending, planInputs.annualSpending),
      payTaxFrom:
        proofPayTaxFrom === "" ? planInputs.payTaxFrom : proofPayTaxFrom,
      // A typed Taxable starting balance is a typed balance,
      // exactly like the plan's own: no snapshot cash sleeve
      // rides with it.
      spendFromCashSleeveStart:
        parseDollars(proofTaxable) != null
          ? 0
          : planInputs.spendFromCashSleeveStart,
    };
  }, [
    planInputs,
    proofPretax,
    proofPretaxSpouse,
    proofTaxable,
    proofRoth,
    proofHsa,
    proofSpending,
    proofPayTaxFrom,
  ]);
  const proofOverridesActive =
    proofPayTaxFrom !== "" ||
    [
      proofPretax,
      proofPretaxSpouse,
      proofTaxable,
      proofRoth,
      proofHsa,
      proofSpending,
    ].some((s) => parseDollars(s) != null);
  const resetProofOverrides = () => {
    setProofPretax("");
    setProofPretaxSpouse("");
    setProofTaxable("");
    setProofRoth("");
    setProofHsa("");
    setProofSpending("");
    setProofPayTaxFrom("");
  };
  const proofResult = useMemo(
    () => (proofInputs ? simulateRothPlan(proofInputs, currentStrategy) : null),
    [proofInputs, currentStrategy],
  );
  const proofDoNothingResult = useMemo(
    () =>
      proofInputs
        ? simulateRothPlan(proofInputs, { id: "none", name: "Do Nothing", ceilings: null })
        : null,
    [proofInputs],
  );
  const proofStats = useMemo(() => {
    if (!proofResult || !proofInputs) return null;
    const years = proofResult.years;
    const startingPretax = proofInputs.pretaxStart + (proofInputs.pretaxSpouseStart ?? 0);
    const firstZeroIdx = years.findIndex((y) => y.pretaxEnd === 0 && startingPretax > 0);
    const firstZero = firstZeroIdx >= 0 ? years[firstZeroIdx]! : null;
    const beforeZero =
      firstZeroIdx > 0 ? years[firstZeroIdx - 1]! : null;
    const dnFirstZero =
      proofDoNothingResult?.years.find((y) => y.pretaxEnd === 0 && startingPretax > 0) ?? null;
    const sum = (pick: (y: (typeof years)[number]) => number): number =>
      years.reduce((a, y) => a + pick(y), 0);
    const shortfallYears = years.filter((y) => y.spendShortfall > 0);
    const unpaidTaxTotal = sum((y) => y.unpaidTax);
    const last = years[years.length - 1] ?? null;
    return {
      startingPretax,
      firstZero,
      beforeZero,
      dnFirstZero,
      yearsSooner:
        firstZero && dnFirstZero ? firstZero.agePrimary - dnFirstZero.agePrimary : null,
      last,
      shortfallYears,
      unpaidTaxTotal,
      totals: {
        spending: sum((y) => y.funding.spending),
        ss: sum((y) => y.funding.ss),
        rmd: sum((y) => y.funding.rmd),
        otherIncome: sum((y) => y.funding.otherIncome),
        yields: sum((y) => y.funding.interestYield + y.funding.dividendYield),
        cashSpend: sum((y) => y.funding.cashSpend),
        pretaxDraw: sum((y) => y.funding.pretaxDraw),
        taxableForSpending: sum((y) => y.funding.taxableSoldForSpending),
        taxableForTax: sum((y) => y.funding.taxableSoldForTax),
        rothDraw: sum((y) => y.funding.rothDraw),
        conversions: sum((y) => y.conversion),
        acaKept: sum((y) => y.acaCreditKept),
        dnAcaKept: proofDoNothingResult
          ? proofDoNothingResult.years.reduce((a, y) => a + y.acaCreditKept, 0)
          : 0,
      },
      taxableYearsUsed: years.filter(
        (y) => y.funding.taxableSoldForSpending + y.funding.taxableSoldForTax > 0,
      ).length,
      rothYearsUsed: years.filter((y) => y.funding.rothDraw > 0).length,
      chart: years.map((y) => ({
        year: y.year,
        age: y.agePrimary,
        "Pre-tax": Math.round(y.pretaxEnd),
      })),
    };
  }, [proofResult, proofDoNothingResult, proofInputs]);

  // Execution-year result: the current calendar year priced
  // standalone through the shared engine (priceExecutionYear in
  // rothOptimizer.ts — the same code the accuracy fixtures pin),
  // with the plan's own inputs and saved ceilings, the panel's
  // balances (an unedited balance resolves to the plan's), and
  // the year-to-date actuals. No tax math lives here.
  const executionResult = useMemo(() => {
    if (!planInputs) return null;
    return priceExecutionYear(
      planInputs,
      anyCeiling ? ceilings : null,
      {
        pretax: execBalanceOverrides.pretax ? (parseDollars(execPretax) ?? 0) : null,
        pretaxSpouse: execBalanceOverrides.pretaxSpouse
          ? (parseDollars(execPretaxSpouse) ?? 0)
          : null,
        roth: execBalanceOverrides.roth ? (parseDollars(execRoth) ?? 0) : null,
        taxable: execBalanceOverrides.taxable ? (parseDollars(execTaxable) ?? 0) : null,
        hsa: execBalanceOverrides.hsa ? (parseDollars(execHsa) ?? 0) : null,
        otherOrdinaryYtd: parseDollars(execOtherOrd) ?? 0,
        taxExemptYtd: parseDollars(execTaxExempt) ?? 0,
        alreadyConvertedYtd: parseDollars(execAlready) ?? 0,
      },
      startYear,
    );
  }, [
    planInputs, ceilings, anyCeiling, startYear,
    execPretax, execPretaxSpouse, execRoth, execTaxable, execHsa,
    execOtherOrd, execTaxExempt, execAlready, execBalanceOverrides,
  ]);

  // Optimizer winner + runner-ups, re-run through the standard
  // engine from their saved parameters so the Optimize
  // workspace's takeaway can quote their ending balances,
  // scored on the same objective. (A result whose ceilings are
  // all off is the Do Nothing score — it runs with no strategy
  // ceilings.)
  const optCompareRows = useMemo(() => {
    if (!planInputs || !optResult?.ok || !optResult.winner) return [];
    const scores = [optResult.winner, ...optResult.runnersUp];
    return scores.map((score) => {
      const c = score.ceilings;
      const noCeilings =
        c.bracketTopPct == null &&
        c.irmaaTierCap == null &&
        !c.ltcgZeroCap &&
        !c.acaCliffCap &&
        c.magiCapCents == null;
      const strategy: RothStrategy = {
        id: `opt-${score.name}-${score.windowStopAge}`,
        name: score.name,
        ceilings: noCeilings
          ? null
          : {
              bracketTopPct: c.bracketTopPct,
              irmaaTierCap: c.irmaaTierCap,
              ltcgZeroCap: c.ltcgZeroCap,
              acaCliffCap: c.acaCliffCap,
              acaCliffCapFamilyOnly: c.acaCliffCapFamilyOnly ?? false,
              magiCap: c.magiCapCents == null ? null : c.magiCapCents / 100,
              acaCliffBuffer:
                c.acaCliffBufferCents == null ? null : c.acaCliffBufferCents / 100,
            },
        guardrail: score.guardrail,
        bunching: score.bunching,
      };
      return {
        score,
        result: simulateRothPlan(
          {
            ...planInputs,
            windowStopAge: score.windowStopAge,
            // Each optimizer score is also re-priced under ITS
            // OWN draw order — the order its schedule was
            // searched at — not the plan's current order.
            drawOrder: drawOrderFromKey(score.drawOrder),
            // Each optimizer score is re-priced at ITS OWN
            // claiming ages and derived benefits — the ages its
            // schedule was searched at — not the entered ages.
            ssPrimaryStartAge: score.claimPrimaryAge ?? planInputs.ssPrimaryStartAge,
            ssPrimaryAnnual: planInputs.ssPrimaryNoBenefit
              ? 0
              : score.claimPrimaryAge != null ? score.ssPrimaryAnnual : planInputs.ssPrimaryAnnual,
            ssSpouseStartAge: score.claimSpouseAge ?? planInputs.ssSpouseStartAge,
            ssSpouseAnnual: planInputs.ssSpouseNoBenefit
              ? 0
              : score.claimSpouseAge != null ? score.ssSpouseAnnual : planInputs.ssSpouseAnnual,
          },
          strategy,
        ),
      };
    });
  }, [planInputs, optResult]);

  const ceilingsSummary = useMemo(() => {
    const parts: string[] = [];
    if (ceilings.bracketTopPct != null) parts.push(`top of the ${ceilings.bracketTopPct}% bracket`);
    if (ceilings.irmaaTierCap != null) parts.push(`IRMAA Tier ${ceilings.irmaaTierCap} ceiling`);
    if (ceilings.ltcgZeroCap) parts.push("top of the 0% capital-gains space");
    if (ceilings.acaCliffCap) parts.push("at or under 400% of the poverty line (ACA)");
    if (ceilings.acaCliffCap && ceilings.acaCliffCapFamilyOnly)
      parts.push("cliff cap only until the household steps down");
    if (ceilings.acaCliffCap && ceilings.acaCliffBuffer != null && ceilings.acaCliffBuffer > 0)
      parts.push(`cliff safety buffer ${fmtDollars(ceilings.acaCliffBuffer)}`);
    if (!ceilings.acaCliffCap && ceilings.acaCliffBuffer != null && ceilings.acaCliffBuffer > 0)
      parts.push(`cliff safety buffer ${fmtDollars(ceilings.acaCliffBuffer)} (saved — not active while the cliff cap is off)`);
    if (ceilings.magiCap != null) parts.push(`MAGI cap ${fmtDollars(ceilings.magiCap)}`);
    return parts.length ? parts.join(" · ") : "no ceilings switched on — no conversions";
  }, [ceilings]);

  // The preset whose field combination the current ceilings
  // match exactly, or null when the settings are custom. Derived
  // from the same `ceilings` the engine prices — never stored.
  const activeCeilingPreset =
    CEILING_PRESETS.find((p) => ceilingsMatchPreset(ceilings, p.fields)) ?? null;

  // Apply a preset by writing the working ceiling fields —
  // the identical state (and therefore the identical autosave
  // payload and priced result) as setting the Custom… controls
  // to the same combination by hand.
  const applyCeilingPreset = (fields: FillCeilings) => {
    setCeilBracket(
      fields.bracketTopPct == null
        ? ""
        : (String(fields.bracketTopPct) as typeof ceilBracket),
    );
    setCeilIrmaa(
      fields.irmaaTierCap == null
        ? ""
        : (String(fields.irmaaTierCap) as typeof ceilIrmaa),
    );
    setCeilLtcg(fields.ltcgZeroCap);
    setCeilAca(fields.acaCliffCap);
    setCeilAcaFamilyOnly(fields.acaCliffCapFamilyOnly);
    setMagiCap(fields.magiCap == null ? "" : fmtMoneyInput(fields.magiCap));
    setCliffBuffer(
      fields.acaCliffBuffer == null ? "" : fmtMoneyInput(fields.acaCliffBuffer),
    );
  };

  const diffLabels = useMemo(() => {
    const cur: Record<string, string> = {
      "birth years": `${birthYearP}/${birthYearS}`,
      "filing status": filingStatus,
      "starting balances": `${parseMoney(pretax) ?? "blank"}|${parseMoney(pretaxSpouse) ?? "blank"}|${parseMoney(rothBal) ?? "blank"}|${parseMoney(taxableBal) ?? "blank"}|${parseMoney(hsaBal) ?? "blank"}`,
      "survivor scenario": survivorOn
        ? `${survivorWho}@${survivorDeathYear || "blank"}`
        : "off",
      "taxable cost basis": basisPct === "" ? "blank" : basisPct,
      "taxable excluded from plan": String(parseMoney(taxableExclude) ?? "blank"),
      "taxable yields": `${divYieldPct === "" ? "blank" : divYieldPct}/${intYieldPct === "" ? "blank" : intYieldPct}`,
      "annual spending": String(parseMoney(spending) ?? "blank"),
      "retirement age": retirementAge,
      "end age": endAge,
      "expected return": expectedPct,
      "your Social Security": `${parseMoney(ssP) ?? "blank"}@${ssPAge}${ssPrimaryNoBenefit ? ":none" : ""}`,
      "spouse Social Security": `${parseMoney(ssS) ?? "blank"}@${ssSAge}${ssSpouseNoBenefit ? ":none" : ""}`,
      "other ordinary income": String(parseMoney(otherOrd) ?? "blank"),
      "tax-exempt interest": String(parseMoney(taxExempt) ?? "blank"),
      "already converted this year": String(parseMoney(convertedAlready) ?? "blank"),
      "conversion window": `${winStart}→${winStop}`,
      "pay tax from": payTaxFrom,
      "protect-minimum taxable": String(parseMoney(protectMin) ?? "blank"),
      "pre-tax reserve": `${parseMoney(preservePretax) ?? "blank"}/${preserveExitRate === "" ? "blank" : preserveExitRate}`,
      "earliest claim age": claimAgeFloor === "" ? "blank" : claimAgeFloor,
      "draw order":
        parseIntField(drawOrderSwitchAge) != null
          ? `${drawOrderLabel(drawOrderFromKey(drawOrder))}, then ${drawOrderLabel(drawOrderFromKey(drawOrderAfter))} from ${parseIntField(drawOrderSwitchAge)}`
          : drawOrderLabel(drawOrderFromKey(drawOrder)),
      "spouse sole beneficiary": soleBeneficiary ? "yes" : "no",
      "primary sole beneficiary of spouse": primarySoleBeneficiaryOfSpouse
        ? "yes"
        : "blank",
      "ACA household size": acaSize,
      "ACA household steps":
        acaSteps.length === 0
          ? "none"
          : acaSteps
              .map((r) => `${r.householdSize || "?"} from ${r.fromYear || "?"}`)
              .join(", "),
      "ACA benchmark premiums": `${parseMoney(benchCouple) ?? "blank"}/${parseMoney(benchSingle) ?? "blank"}/${parseMoney(benchFamily) ?? "blank"}`,
      inflation: inflation,
      "state rate": stateRate,
      "heir rate": heirRate,
      "fill ceiling": ceilingsSummary,
    };
    return defaultsRef.current
      .filter((d) => cur[d.label] !== undefined && cur[d.label] !== d.value)
      .map((d) => d.label);
  }, [
    birthYearP, birthYearS, filingStatus, pretax, pretaxSpouse,
    survivorOn, survivorWho, survivorDeathYear, rothBal, taxableBal, taxableExclude, hsaBal, basisPct,
    divYieldPct, intYieldPct, spendFromCashPct, flexCutPct, flexFloorPct,
    spending, retirementAge, endAge, expectedPct, ssP, ssPAge, ssS, ssSAge,
    ssPrimaryNoBenefit, ssSpouseNoBenefit, otherOrd,
    taxExempt, convertedAlready, winStart, winStop, payTaxFrom, protectMin,
    preservePretax, preserveExitRate, claimAgeFloor, drawOrder, drawOrderSwitchAge, drawOrderAfter,
    soleBeneficiary, primarySoleBeneficiaryOfSpouse, acaSize, acaSteps, benchCouple, benchSingle, benchFamily,
    inflation, stateRate, heirRate, ceilingsSummary,
  ]);

  /* -------- Changed-from-saved markers + Back to saved --------
     Presentation only. The baseline is the saved record exactly
     as the init effect resolves it (snapshot-followed balances
     resolved from the latest snapshot, the Retirement-derived
     seeds filled in for a record that leaves them blank), so a
     field reads "changed" precisely when its current typed value
     differs from what is saved. Comparisons are semantic (parsed
     money / numbers), never raw-string, so typing grouping
     commas does not flicker the marker. The autosave persists
     edits as before; once the saved record catches up, the
     markers clear on their own. */
  const resolvedSavedInputs = (): Parameters<typeof applyInputs>[0] | null => {
    if (!data || !ret) return null;
    const s = data.saved;
    const snap = data.snapshot;
    const retSaved = ret.saved;
    const seedRetAge = retSaved?.retirementAge ?? SEED_RETIREMENT_AGE_FALLBACK;
    const seedReturn =
      retSaved?.expectedReturnPct ?? blendedExpected(retSaved?.stocksPct ?? STOCKS_PCT_DEFAULT);
    const seedSpendingCents = ret.defaultSpendingAnnualCents;
    const src: Parameters<typeof applyInputs>[0] = s ?? seedRothInputs({
      annualSpendingCents: seedSpendingCents,
      retirementAge: seedRetAge,
      expectedReturnPct: seedReturn,
    });
    const wifeSavedCents = src.pretaxSpouseCents ?? null;
    const primaryEffectiveCents =
      src.pretaxCents ??
      (snap?.pretaxCents != null
        ? Math.max(0, snap.pretaxCents - (wifeSavedCents ?? 0))
        : null);
    return {
      ...src,
      pretaxCents: primaryEffectiveCents,
      pretaxSpouseCents: wifeSavedCents,
      rothCents: src.rothCents ?? snap?.rothCents ?? null,
      taxableCents: src.taxableCents ?? taxableSnapshotCents(snap),
      hsaCents: src.hsaCents ?? snap?.hsaCents ?? null,
      annualSpendingCents: src.annualSpendingCents ?? seedSpendingCents,
      retirementAge: src.retirementAge ?? seedRetAge,
      expectedReturnPct: src.expectedReturnPct ?? seedReturn,
    };
  };
  const savedResolved = resolvedSavedInputs();
  const moneyChanged = (cur: string, savedCents: number | null | undefined): boolean =>
    savedResolved != null && parseMoney(cur) !== (savedCents ?? null);
  const numChanged = (cur: string, saved: number | null | undefined): boolean =>
    savedResolved != null && parseNum(cur) !== (saved ?? null);
  const intChanged = (cur: string, saved: number | null | undefined): boolean =>
    savedResolved != null && parseIntField(cur) !== (saved ?? null);
  const boolChanged = (cur: boolean, saved: boolean | null | undefined, dflt: boolean): boolean =>
    savedResolved != null && cur !== (saved ?? dflt);
  // Editor-list comparisons: the parsed list against the saved
  // list. Rows that are present but still incomplete parse to
  // null (they price as "no list"), which differs from any
  // saved list — and from a saved no-list state the typed rows
  // themselves are the change.
  const tiersChanged =
    savedResolved != null &&
    (JSON.stringify(tiersFromRows(basisTiers)) !==
      JSON.stringify(
        (savedResolved.taxableTiers ?? null) == null
          ? null
          : (savedResolved.taxableTiers ?? []).map((t) => ({
              sharePct: Math.min(100, Math.max(0, t.sharePct)),
              basisPct: Math.min(100, Math.max(0, t.basisPct)),
            })),
      ) ||
      (basisTiers.length > 0 && tiersFromRows(basisTiers) == null));
  const eduChanged =
    savedResolved != null &&
    (JSON.stringify(studentsFromRows(eduStudents)) !==
      JSON.stringify(savedResolved.educationStudents ?? null) ||
      (eduStudents.length > 0 && studentsFromRows(eduStudents) == null));
  const acaStepsChanged =
    savedResolved != null &&
    (JSON.stringify(acaStepsFromRows(acaSteps)) !==
      JSON.stringify(savedResolved.acaHouseholdSchedule ?? null) ||
      (acaSteps.length > 0 && acaStepsFromRows(acaSteps) == null));
  const changedFields = {
    filingStatus: savedResolved != null && filingStatus !== (savedResolved.filingStatus ?? "mfj"),
    birthYearP: intChanged(birthYearP, savedResolved?.birthYearPrimary),
    birthYearS: intChanged(birthYearS, savedResolved?.birthYearSpouse),
    retirementAge: intChanged(retirementAge, savedResolved?.retirementAge),
    endAge: intChanged(endAge, savedResolved?.endAge),
    winStart: intChanged(winStart, savedResolved?.windowStartAge),
    winStop: intChanged(winStop, savedResolved?.windowStopAge),
    convertedAlready: moneyChanged(convertedAlready, savedResolved?.convertedAlreadyCents),
    collegeFromYear: intChanged(collegeFromYear, savedResolved?.collegeFallFromYear),
    collegeThroughYear: intChanged(collegeThroughYear, savedResolved?.collegeFallThroughYear),
    soleBeneficiary: boolChanged(soleBeneficiary, savedResolved?.spouseSoleBeneficiary, true),
    primarySoleBeneficiaryOfSpouse: boolChanged(
      primarySoleBeneficiaryOfSpouse,
      savedResolved?.primarySoleBeneficiaryOfSpouse,
      false,
    ),
    survivorOn: boolChanged(survivorOn, savedResolved?.survivorEnabled, false),
    survivorWho: savedResolved != null && survivorWho !== (savedResolved.survivorWho ?? "primary"),
    survivorDeathYear: intChanged(survivorDeathYear, savedResolved?.survivorDeathYear),
    pretax: moneyChanged(pretax, savedResolved?.pretaxCents),
    pretaxSpouse: moneyChanged(pretaxSpouse, savedResolved?.pretaxSpouseCents),
    rothBal: moneyChanged(rothBal, savedResolved?.rothCents),
    taxableBal: moneyChanged(taxableBal, savedResolved?.taxableCents),
    taxableExclude: moneyChanged(taxableExclude, savedResolved?.taxableExcludeCents),
    hsaBal: moneyChanged(hsaBal, savedResolved?.hsaCents),
    basisPct: numChanged(basisPct, savedResolved?.taxableBasisPct),
    divYieldPct: numChanged(divYieldPct, savedResolved?.taxableDividendYieldPct),
    intYieldPct: numChanged(intYieldPct, savedResolved?.taxableInterestYieldPct),
    basisTiers: tiersChanged,
    spending: moneyChanged(spending, savedResolved?.annualSpendingCents),
    payTaxFrom: savedResolved != null && payTaxFrom !== (savedResolved.payTaxFrom ?? "taxable"),
    protectMin: moneyChanged(protectMin, savedResolved?.protectMinTaxableCents),
    preservePretax: moneyChanged(preservePretax, savedResolved?.preservePretaxCents),
    preserveExitRate: numChanged(preserveExitRate, savedResolved?.preserveExitRatePct),
    drawOrder:
      savedResolved != null &&
      drawOrder !== drawOrderKey(drawOrderFromKey(savedResolved.drawOrder ?? null)),
    drawOrderSwitchAge: intChanged(drawOrderSwitchAge, savedResolved?.drawOrderSwitchAge),
    drawOrderAfter:
      savedResolved != null &&
      drawOrderAfter !==
        (savedResolved.drawOrderAfter != null &&
        DRAW_ORDER_OPTIONS.some((o) => o.key === savedResolved.drawOrderAfter)
          ? savedResolved.drawOrderAfter
          : DEFAULT_DRAW_ORDER_KEY),
    ssP:
      moneyChanged(ssP, ssPrimaryNoBenefit ? null : savedResolved?.ssPrimaryAnnualCents) ||
      boolChanged(ssPrimaryNoBenefit, savedResolved?.ssPrimaryNoBenefit, false),
    ssPAge: intChanged(ssPAge, savedResolved?.ssPrimaryStartAge),
    ssS:
      moneyChanged(ssS, ssSpouseNoBenefit ? null : savedResolved?.ssSpouseAnnualCents) ||
      boolChanged(ssSpouseNoBenefit, savedResolved?.ssSpouseNoBenefit, false),
    ssSAge: intChanged(ssSAge, savedResolved?.ssSpouseStartAge),
    claimAgeFloor: intChanged(claimAgeFloor, savedResolved?.claimAgeFloor),
    otherOrd: moneyChanged(otherOrd, savedResolved?.otherOrdinaryCents),
    taxExempt: moneyChanged(taxExempt, savedResolved?.taxExemptInterestCents),
    taxReturnInterest: moneyChanged(taxReturnInterest, data?.taxReturn.taxReturnInterestCents),
    taxReturnQualDiv: moneyChanged(taxReturnQualDiv, data?.taxReturn.taxReturnQualifiedDividendsCents),
    taxReturnOrdDiv: moneyChanged(taxReturnOrdDiv, data?.taxReturn.taxReturnOrdinaryDividendsCents),
    acaSize: intChanged(acaSize, savedResolved?.acaHouseholdSize),
    acaSteps: acaStepsChanged,
    benchCouple: moneyChanged(benchCouple, savedResolved?.acaBenchmarkCoupleCents),
    benchSingle: moneyChanged(benchSingle, savedResolved?.acaBenchmarkSingleCents),
    benchFamily: moneyChanged(benchFamily, savedResolved?.acaBenchmarkFamilyCents),
    acaSpouseEndAge: intChanged(acaSpouseEndAge, savedResolved?.acaSpouseEndAge),
    ceilBracket:
      savedResolved != null &&
      ceilBracket !==
        (savedResolved.ceilings?.bracketTopPct === 10 ||
        savedResolved.ceilings?.bracketTopPct === 12 ||
        savedResolved.ceilings?.bracketTopPct === 22 ||
        savedResolved.ceilings?.bracketTopPct === 24
          ? String(savedResolved.ceilings.bracketTopPct)
          : ""),
    ceilIrmaa:
      savedResolved != null &&
      ceilIrmaa !==
        (savedResolved.ceilings?.irmaaTierCap != null &&
        savedResolved.ceilings.irmaaTierCap >= 0 &&
        savedResolved.ceilings.irmaaTierCap <= 5
          ? String(savedResolved.ceilings.irmaaTierCap)
          : ""),
    ceilLtcg: boolChanged(ceilLtcg, savedResolved?.ceilings?.ltcgZeroCap, false),
    ceilAca: boolChanged(ceilAca, savedResolved?.ceilings?.acaCliffCap, false),
    ceilAcaFamilyOnly: boolChanged(ceilAcaFamilyOnly, savedResolved?.ceilings?.acaCliffCapFamilyOnly, false),
    magiCap: moneyChanged(magiCap, savedResolved?.ceilings?.magiCapCents),
    cliffBuffer: moneyChanged(cliffBuffer, savedResolved?.ceilings?.acaCliffBufferCents),
    guardrailOn: savedResolved != null && (guardrailOn ?? false) !== (savedResolved.optimizerGuardrail ?? false),
    bunchingOn: savedResolved != null && (bunchingOn ?? false) !== (savedResolved.optimizerBunching ?? false),
    gainsHarvestOn: savedResolved != null && (gainsHarvestOn ?? false) !== (savedResolved.gainsHarvest ?? false),
    expectedPct: numChanged(expectedPct, savedResolved?.expectedReturnPct),
    inflation: numChanged(inflation, savedResolved?.inflationPct),
    residenceState:
      savedResolved != null &&
      residenceState !== (savedResolved.residenceState === "WA" ? "WA" : "other"),
    stateRate: numChanged(stateRate, savedResolved?.stateRatePct),
    carryInSt: moneyChanged(carryInSt, savedResolved?.capitalLossCarryInStCents),
    carryInLt: moneyChanged(carryInLt, savedResolved?.capitalLossCarryInLtCents),
    itemizedMortgage: moneyChanged(itemizedMortgage, savedResolved?.itemizedMortgageInterestCents),
    itemizedSalt: moneyChanged(itemizedSalt, savedResolved?.itemizedSaltPaidCents),
    itemizedCharitable: moneyChanged(itemizedCharitable, savedResolved?.itemizedCharitableCents),
    itemizedOther: moneyChanged(itemizedOther, savedResolved?.itemizedOtherCents),
    eduStudents: eduChanged,
    heirRate: numChanged(heirRate, savedResolved?.heirRatePct),
  };
  const changedCount = Object.values(changedFields).filter(Boolean).length;
  const sectionChangedCount = (keys: (keyof typeof changedFields)[]): number =>
    keys.filter((k) => changedFields[k]).length;
  // Restore the working form to the saved record's values.
  // Presentation/state only: any queued autosave of the edited
  // form is dropped and the restore itself schedules no save —
  // nothing is written.
  const backToSaved = () => {
    const resolved = resolvedSavedInputs();
    setConfirmBackToSaved(false);
    if (!resolved) return;
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    pendingSave.current = null;
    suppressNextAutosaveRef.current = true;
    applyInputs(resolved);
    const s = data?.saved;
    setBalanceOverrides({
      pretax: s?.pretaxCents != null,
      pretaxSpouse: s?.pretaxSpouseCents != null,
      roth: s?.rothCents != null,
      taxable: s?.taxableCents != null,
      hsa: s?.hsaCents != null,
    });
  };

  /* -------- Plain-English summary line --------
     One sentence at the top of the view, assembled live from
     whatever values are currently in the fields — household-
     neutral (every clause is generated from the field values
     themselves, and a clause with no value behind it is simply
     left out). Display only: it reads the same state the
     fields edit and never touches pricing. */
  /* The summary's clauses (contract v69): each clause that
     names one editable field is a provenance tap — it jumps
     to that field in the All settings face (see jumpToField).
     The plain string below is the same clauses joined, for
     any reader that needs the sentence whole. */
  type SummaryClause = {
    text: string;
    fieldId?: string;
    section?: RothSectionId;
    fieldLabel?: string;
  };
  const plainSummaryClauses = ((): SummaryClause[] => {
    const parts: SummaryClause[] = [];
    const retire = parseIntField(retirementAge);
    if (retire != null)
      parts.push({ text: `Retire at ${retire}`, fieldId: "roth-Retirement-age", section: "household", fieldLabel: "Retirement age" });
    const spendD = parseDollars(spending);
    if (spendD != null)
      parts.push({ text: `spend ${fmtDollars(spendD)}/yr`, fieldId: "roth-Annual-spending", section: "household", fieldLabel: "Annual spending" });
    parts.push({
      text: `draw ${drawOrderLabel(drawOrderFromKey(drawOrder)).toLowerCase()} first`,
      fieldId: "roth-draworder",
      section: "household",
      fieldLabel: "Spending draw order",
    });
    const fillParts: string[] = [];
    if (ceilBracket !== "") fillParts.push(`the top of the ${ceilBracket}% bracket`);
    if (ceilIrmaa !== "") fillParts.push(`IRMAA Tier ${ceilIrmaa}`);
    if (ceilLtcg) fillParts.push("the top of the 0% capital-gains space");
    if (ceilAca) fillParts.push("the ACA cliff");
    if (parseDollars(magiCap) != null) fillParts.push(`a MAGI cap of ${fmtDollars(parseDollars(magiCap)!)}`);
    if (fillParts.length > 0)
      parts.push({ text: `fill up to ${fillParts.join(" and ")}`, fieldId: "roth-ceil-bracket", section: "advanced", fieldLabel: "Fill ceiling" });
    else
      parts.push({ text: "no conversions (no ceiling set)", fieldId: "roth-ceil-bracket", section: "advanced", fieldLabel: "Fill ceiling" });
    parts.push({
      text:
        payTaxFrom === "taxable"
          ? "taxes paid from taxable"
          : "taxes withheld from the conversion",
      fieldId: "roth-payfrom",
      section: "household",
      fieldLabel: "Pay conversion tax from",
    });
    if (ssPrimaryNoBenefit && ssSpouseNoBenefit) {
      parts.push({ text: "no Social Security benefit", fieldId: "roth-Your-SS-start-age", section: "income", fieldLabel: "Your SS start age" });
    } else if (ssPrimaryNoBenefit) {
      const a = parseIntField(ssSAge);
      parts.push({ text: a != null ? `spouse Social Security at ${a}` : "Social Security not set", fieldId: "roth-Spouse-SS-start-age", section: "income", fieldLabel: "Spouse SS start age" });
    } else if (ssSpouseNoBenefit) {
      const a = parseIntField(ssPAge);
      parts.push({ text: a != null ? `Social Security at ${a}` : "Social Security not set", fieldId: "roth-Your-SS-start-age", section: "income", fieldLabel: "Your SS start age" });
    } else {
      const aP = parseIntField(ssPAge);
      const aS = parseIntField(ssSAge);
      if (aP != null && aS != null && aP !== aS)
        parts.push({ text: `Social Security at ${aP} and ${aS}`, fieldId: "roth-Your-SS-start-age", section: "income", fieldLabel: "Your SS start age" });
      else if (aP != null) parts.push({ text: `Social Security at ${aP}`, fieldId: "roth-Your-SS-start-age", section: "income", fieldLabel: "Your SS start age" });
      else if (aS != null) parts.push({ text: `spouse Social Security at ${aS}`, fieldId: "roth-Spouse-SS-start-age", section: "income", fieldLabel: "Spouse SS start age" });
    }
    if (survivorOn) {
      parts.push({
        text: `survivor scenario: ${survivorWho === "primary" ? "you die" : "spouse dies"}${survivorDeathYear ? ` in ${survivorDeathYear}` : ""}`,
      });
    }
    return parts;
  })();


  /* -------- The saved plan as a pricing payload (plan face) --------
     The plan face's ending figures and its what-if questions
     price the SAVED RECORD itself — this payload — never the
     working form. The form is a typed copy of the record and
     can drift from it (a field the form parses or clamps
     differently, a balance the snapshot has since moved), and
     when it does, form-priced figures quietly stop being the
     plan's figures. Building the payload straight from the
     record removes the whole class: balances ride exactly as
     saved (a null balance keeps its follow-the-snapshot
     meaning, and the server resolves it from the latest
     snapshot exactly as it prices the record anywhere else),
     and the only fills are the same Retirement-derived seeds
     resolvedSavedInputs applies to a record that leaves
     spending, retirement age, or expected return blank. The
     ending strip and every what-if baseline price THIS
     payload through runRothCompare, so the strip, the
     baselines the what-if deltas are measured against, and
     the saved plan's own numbers are one number by
     construction. */
  const buildSavedPlanPayload = (): PlanPayload | null => {
    if (!data || !ret) return null;
    const retSaved = ret.saved;
    const seedRetAge = retSaved?.retirementAge ?? SEED_RETIREMENT_AGE_FALLBACK;
    const seedReturn =
      retSaved?.expectedReturnPct ?? blendedExpected(retSaved?.stocksPct ?? STOCKS_PCT_DEFAULT);
    const seedSpendingCents = ret.defaultSpendingAnnualCents;
    const base: PlanPayload = data.saved
      ? { ...data.saved }
      : seedRothInputs({
          annualSpendingCents: seedSpendingCents,
          retirementAge: seedRetAge,
          expectedReturnPct: seedReturn,
        });
    if (base.annualSpendingCents == null) base.annualSpendingCents = seedSpendingCents;
    if (base.retirementAge == null) base.retirementAge = seedRetAge;
    if (base.expectedReturnPct == null) base.expectedReturnPct = seedReturn;
    return base;
  };

  /* -------- What-if question buttons (plan face) --------
     Plain-language questions derived from the SAVED plan's own
     values. Each button prices the saved plan with exactly one
     change through the existing scenario comparison
     (runRothCompare — the same action the Strategy Lab prices
     through): the request's base is the saved record as a
     payload (buildSavedPlanPayload), its baseline row is the
     plan itself (an empty patch), and the question rides as
     one scenario patch. The comparison is
     compute-only — a what-if never saves anything, never
     touches the working form, and its figures are the compare's
     own, to the cent. The result keeps a fingerprint of the
     request it was priced from, so a later edit to the plan
     marks the shown figures as priced on the earlier plan
     instead of letting them pose as current. */
  type WhatIfDef = {
    id: string;
    label: string;
    overrides: LabRequest["scenarios"][number]["overrides"];
  };
  const whatIfDefs: WhatIfDef[] = (() => {
    const defs: WhatIfDef[] = [];
    const sv = savedResolved;
    if (!sv) return defs;
    const retAge = sv.retirementAge ?? null;
    if (retAge != null && retAge > 30) {
      const overrides: WhatIfDef["overrides"] = { retirementAge: retAge - 1 };
      // The conversion window normally starts when work stops:
      // when the saved window starts at the retirement age, the
      // earlier retirement moves the window with it.
      if ((sv.windowStartAge ?? null) === retAge)
        overrides.windowStartAge = retAge - 1;
      defs.push({
        id: "retire-earlier",
        label: `Retire a year earlier — at ${retAge - 1}`,
        overrides,
      });
    }
    if (sv.annualSpendingCents != null) {
      defs.push({
        id: "spend-more",
        label: "Spend $10,000 more a year",
        overrides: { annualSpendingCents: sv.annualSpendingCents + 1_000_000 },
      });
    }
    const curBracket = sv.ceilings?.bracketTopPct ?? null;
    const bracketTarget = curBracket == null || curBracket < 22 ? 22 : curBracket === 22 ? 24 : 22;
    if (bracketTarget !== curBracket) {
      const c = sv.ceilings;
      defs.push({
        id: "bracket",
        label: `Convert up to the ${bracketTarget}% bracket`,
        overrides: {
          ceilings: {
            bracketTopPct: bracketTarget,
            irmaaTierCap: c?.irmaaTierCap ?? null,
            ltcgZeroCap: c?.ltcgZeroCap ?? false,
            acaCliffCap: c?.acaCliffCap ?? false,
            acaCliffCapFamilyOnly: c?.acaCliffCapFamilyOnly ?? false,
            magiCapCents: c?.magiCapCents ?? null,
            acaCliffBufferCents: c?.acaCliffBufferCents ?? null,
          },
        },
      });
    }
    const ssAge = sv.ssPrimaryStartAge ?? null;
    if (ssAge != null && ssAge < 70 && sv.ssPrimaryNoBenefit !== true) {
      defs.push({
        id: "ss-later",
        label: `Start Social Security a year later — at ${ssAge + 1}`,
        // The amount is deliberately left out of the patch: the
        // comparison derives the benefit that age actually pays
        // from the saved plan's own anchor, exactly as it does
        // for a claim-age patch in the Strategy Lab.
        overrides: { ssPrimaryStartAge: ssAge + 1 },
      });
    }
    const sched = sv.acaHouseholdSchedule;
    if (
      sched != null &&
      sched.length > 0 &&
      sv.acaHouseholdSize != null &&
      sched[sched.length - 1]!.householdSize < sv.acaHouseholdSize &&
      sched[0]!.fromYear > 1900
    ) {
      defs.push({
        id: "step-down-sooner",
        label: `Household steps down a year sooner — in ${sched[0]!.fromYear - 1}`,
        overrides: {
          acaHouseholdSchedule: sched.map((s, i) =>
            i === 0 ? { ...s, fromYear: s.fromYear - 1 } : s,
          ),
        },
      });
    }
    return defs;
  })();
  const buildWhatIfRequest = (def: WhatIfDef): LabRequest => ({
    // The base is the SAVED RECORD as a payload (see
    // buildSavedPlanPayload), not the working form: the
    // question is "what if the saved plan changed this one
    // way", so the baseline row is the saved plan itself and
    // the deltas measure from the plan's real figures. The
    // form payload remains only as a fallback for the
    // (unreachable while questions exist) no-record case.
    ...(buildSavedPlanPayload() ?? buildSavePayload()),
    baselineName: "Your saved plan",
    scenarios: [
      { name: "Your saved plan", overrides: {} },
      { name: def.label, overrides: def.overrides },
    ],
    fafsaReportableAssetsCents: fafsaReportableAssetsCentsValue(),
  });
  const [whatIfResult, setWhatIfResult] = useState<{
    label: string;
    wealthCents: number;
    netCostCents: number;
    deltaWealthCents: number;
    deltaNetCostCents: number;
    fingerprint: string;
  } | null>(null);
  const [whatIfError, setWhatIfError] = useState("");
  // The question currently being priced, then the one whose
  // answer is on screen: its button stays lit (the same
  // active-chip treatment the ceiling presets use) so the
  // answer card below is never ambiguous about which
  // question it belongs to.
  const [pendingWhatIfId, setPendingWhatIfId] = useState<string | null>(null);
  const runWhatIfMut = useMutation({
    mutationFn: (input: LabRequest) => api.runRothCompare(input),
    onSuccess: (res, vars) => {
      setPendingWhatIfId(null);
      if (!res.ok) {
        setWhatIfError(res.reason);
        return;
      }
      const base = res.scenarios.find((r) => r.name === res.baselineName);
      const scen = res.scenarios.find((r) => r.name !== res.baselineName);
      if (!base || !scen) {
        setWhatIfError("That question could not be priced — try again.");
        return;
      }
      setWhatIfError("");
      setWhatIfResult({
        label: scen.name,
        wealthCents: scen.endingAfterTaxWealthCents,
        netCostCents: scen.netCostCents,
        deltaWealthCents:
          scen.endingAfterTaxWealthCents - base.endingAfterTaxWealthCents,
        deltaNetCostCents: scen.deltaNetCostCents,
        fingerprint: JSON.stringify(vars),
      });
    },
    onError: () => {
      setPendingWhatIfId(null);
      setWhatIfError("That question could not be priced — try again.");
    },
  });
  const runWhatIf = (def: WhatIfDef) => {
    setWhatIfError("");
    setPendingWhatIfId(def.id);
    runWhatIfMut.mutate(buildWhatIfRequest(def));
  };
  // Turn a what-if off: drop the answer on screen (and any
  // error) so the face shows the saved plan only. A what-if
  // never saved anything, so clearing it writes nothing —
  // it is the chip-toggle-off and the "Back to saved" exit
  // from a priced question.
  const clearWhatIf = () => {
    setWhatIfError("");
    setPendingWhatIfId(null);
    setWhatIfResult(null);
  };
  // The fingerprint of the what-if request the CURRENT plan
  // would build for the answered question — when it no longer
  // matches the stored fingerprint, the plan changed after the
  // answer was priced.
  const whatIfStale =
    whatIfResult != null &&
    (() => {
      const def = whatIfDefs.find((d) => d.label === whatIfResult.label);
      return def
        ? JSON.stringify(buildWhatIfRequest(def)) !== whatIfResult.fingerprint
        : true;
    })();

  /* -------- Ending strip: the saved plan, priced --------
     A baseline-only compare over the saved-plan payload: the
     strip's four figures are that run's baseline row, in
     cents — the same row every what-if answer measures its
     deltas against, priced by the same action from the same
     payload, so the strip and the what-if baselines cannot
     drift apart. The query key carries the payload AND the
     snapshot it resolves against, so a saved edit or a new
     Net Worth snapshot reprices the strip; nothing here reads
     the working form. */
  const savedPlanPayload = buildSavedPlanPayload();
  const savedStripQ = useQuery({
    queryKey: [
      "rothSavedStrip",
      savedPlanPayload ? JSON.stringify(savedPlanPayload) : null,
      data?.snapshot ? JSON.stringify(data.snapshot) : null,
    ],
    enabled: face === "plan" && savedPlanPayload != null,
    queryFn: () =>
      api.runRothCompare({
        ...(savedPlanPayload as PlanPayload),
        baselineName: "Your saved plan",
        scenarios: [{ name: "Your saved plan", overrides: {} }],
      }),
  });
  const savedStripData = savedStripQ.data;
  const savedStripRow =
    savedStripData?.ok === true
      ? (savedStripData.scenarios.find(
          (r) => r.name === savedStripData.baselineName,
        ) ?? null)
      : null;

  /* -------- Tax by year: the SAVED plan's priced years --------
     The same baseline-only compare over the saved-plan payload
     as the ending strip (identical query key, so the two share
     one run), enabled wherever the plan workspace shows. The
     Tax by year section renders the baseline row's per-year
     tax readouts (contract v51) — figures priced from the
     SAVED RECORD, never the working form, exactly like the
     strip: an unsaved form edit cannot move them. */
  const savedTaxQ = useQuery({
    queryKey: [
      "rothSavedStrip",
      savedPlanPayload ? JSON.stringify(savedPlanPayload) : null,
      data?.snapshot ? JSON.stringify(data.snapshot) : null,
    ],
    enabled:
      (face === "plan" || (face === "settings" && resultsMode === "plan")) &&
      savedPlanPayload != null,
    queryFn: () =>
      api.runRothCompare({
        ...(savedPlanPayload as PlanPayload),
        baselineName: "Your saved plan",
        scenarios: [{ name: "Your saved plan", overrides: {} }],
      }),
  });
  const savedTaxData = savedTaxQ.data;
  const savedTaxRow =
    savedTaxData?.ok === true
      ? (savedTaxData.scenarios.find(
          (r) => r.name === savedTaxData.baselineName,
        ) ?? null)
      : null;
  /* The Tax by year section's net-cost explainer (contract
     v66): it now lives in the ⓘ on the section's title row
     instead of a paragraph under it — the SAME computed string
     the paragraph rendered, built from the same saved row:
     the score's remainder (state tax + pre-59½ penalties +
     tax on the ending pre-tax balance − refundable education
     credit) named component by component, so the headline
     composition still foots exactly in cents. */
  const taxByYearExplainer = ((): string | null => {
    if (!savedTaxRow) return null;
    const remainder =
      savedTaxRow.stateTaxCents +
      savedTaxRow.penaltyCents +
      savedTaxRow.terminalCents -
      savedTaxRow.educationRefundableCents;
    const remainderParts: string[] = [];
    if (savedTaxRow.stateTaxCents !== 0)
      remainderParts.push(`state tax ${fmtCents(savedTaxRow.stateTaxCents)}`);
    if (savedTaxRow.penaltyCents !== 0)
      remainderParts.push(`pre-59½ penalties ${fmtCents(savedTaxRow.penaltyCents)}`);
    if (savedTaxRow.terminalCents !== 0)
      remainderParts.push(
        `tax on the ending pre-tax balance ${fmtCents(savedTaxRow.terminalCents)}`,
      );
    if (savedTaxRow.educationRefundableCents !== 0)
      remainderParts.push(
        `less the refundable education credit ${fmtCents(savedTaxRow.educationRefundableCents)}`,
      );
    return remainderParts.length > 0
      ? `Net cost is federal tax + IRMAA − ACA credits kept, plus the rest of the score: ${remainderParts.join(", ")} — ${fmtCents(remainder)} in all. Priced from the saved record — edits not yet saved do not move these figures.`
      : "For this plan, net cost is exactly federal tax + IRMAA − ACA credits kept — there is no state tax, penalty, ending pre-tax tax, or refundable education credit in the score. Priced from the saved record — edits not yet saved do not move these figures.";
  })();

  // Years where someone is on the ACA marketplace but no benchmark
  // premium has been entered, so the credit cannot be priced.
  // Counted only from the retirement-age year onward — before
  // retirement the household is not on the marketplace yet.
  const acaNotPricedYears = useMemo(() => {
    if (!mainResult || !planInputs) return [];
    const retireYear = planInputs.birthYearPrimary + planInputs.retirementAge;
    return mainResult.years.filter((y) => {
      if (y.year < retireYear) return false;
      // The engine's own ACA scope for the year — survivor-aware
      // (after a death, only the survivor can be on the
      // marketplace).
      return y.acaActive && !y.acaPriced;
    });
  }, [mainResult, planInputs]);

  // Years priced under 138% FPL — at that income coverage routes
  // to Medicaid in most states, so the priced credit is flagged.
  const acaUnder138Years = useMemo(() => {
    if (!mainResult) return [];
    return mainResult.years.filter((y) => y.acaUnder138);
  }, [mainResult]);

  // Years where the preserve-pre-tax reserve is what stopped
  // the fill — the conversion reached the floor, or the balance
  // was already at it so nothing could convert. Empty whenever
  // no reserve is set.
  const reserveBindYears = useMemo(() => {
    if (!mainResult) return [];
    return mainResult.years.filter(
      (y) =>
        y.detail.fill.outcome === "reserve-floor" ||
        y.detail.fill.caps.some((c) => c.kind === "preserve" && c.bound),
    );
  }, [mainResult]);

  // Buckets the latest snapshot HAS been split for other buckets
  // but not this one, with no saved/manual balance covering it:
  // the plan prices that bucket as $0, and the banner must say so
  // by name. Cash is a mapped bucket in its own right — it feeds
  // the Taxable field together with the Taxable bucket — so a
  // missing Cash split is named even when the Taxable bucket
  // itself has a split filling the field. A saved Taxable balance
  // covers both Taxable and Cash (it is the user's own total).
  const missingSplitBuckets = useMemo(() => {
    const snap0 = data?.snapshot;
    if (!snap0 || !snap0.hasAnySplit) return [];
    const checks: { label: string; split: number | null; covered: boolean }[] = [
      {
        label: "Pre-tax",
        split: snap0.pretaxCents,
        covered: balanceOverrides.pretax || balanceOverrides.pretaxSpouse,
      },
      { label: "Roth", split: snap0.rothCents, covered: balanceOverrides.roth },
      { label: "Taxable", split: snap0.taxableCents, covered: balanceOverrides.taxable },
      { label: "Cash", split: snap0.cashCents, covered: balanceOverrides.taxable },
      { label: "HSA", split: snap0.hsaCents, covered: balanceOverrides.hsa },
    ];
    return checks
      .filter((c) => c.split == null && !c.covered)
      .map((c) => c.label);
  }, [data, balanceOverrides]);

  // Where the displayed starting balances come from, for the note
  // in the Your money section.
  const balanceSourceNote = useMemo(() => {
    const snap0 = data?.snapshot;
    if (!snap0) {
      return "Balances are entered manually — there is no Net Worth snapshot yet.";
    }
    if (!snap0.hasAnySplit) {
      return `Balances are entered manually — the latest Net Worth snapshot (${snap0.date}) has not been split into tax buckets yet. Once it is split, any balance you have not saved yourself will follow its buckets: Taxable from the Taxable and Cash buckets together; the College / 529 and Non-Taxable buckets are not counted here.`;
    }
    const fields: { label: string; override: boolean }[] = [
      { label: "Pre-tax", override: balanceOverrides.pretax },
      { label: "Roth", override: balanceOverrides.roth },
      { label: "Taxable", override: balanceOverrides.taxable },
      { label: "HSA", override: balanceOverrides.hsa },
    ];
    const savedLabels = fields.filter((f) => f.override).map((f) => f.label);
    const followingLabels = fields.filter((f) => !f.override).map((f) => f.label);
    if (savedLabels.length === 0) {
      return `Balances from the Net Worth snapshot ${snap0.date} — Taxable includes the Taxable and Cash buckets; the College / 529 and Non-Taxable buckets are not counted here.`;
    }
    if (followingLabels.length === 0) {
      return `Balances are your saved entries — none are following the Net Worth snapshot ${snap0.date}. Use “Reset balances to Net Worth” below to follow the snapshot again (Taxable would then include the Taxable and Cash buckets; the College / 529 and Non-Taxable buckets are not counted here).`;
    }
    return `Saved balances (entered by you): ${savedLabels.join(", ")}. Following the Net Worth snapshot ${snap0.date}: ${followingLabels.join(", ")} — Taxable includes the Taxable and Cash buckets; the College / 529 and Non-Taxable buckets are not counted here.`;
  }, [data, balanceOverrides]);

  const allWarnings = useMemo(() => {
    if (!mainResult) return [];
    return mainResult.years.flatMap((y) =>
      y.warnings.map((w) => ({ year: y.year, age: y.agePrimary, kind: w.kind, text: w.text })),
    );
  }, [mainResult]);

  const balanceChartData = useMemo(() => {
    if (!mainResult) return [];
    return mainResult.years.map((y) => ({
      year: y.year,
      "Pre-tax": Math.round(y.pretaxEnd),
      Roth: Math.round(y.rothEnd),
      Taxable: Math.round(y.taxableEnd),
      HSA: Math.round(y.hsaEnd),
    }));
  }, [mainResult]);

  const magiChartData = useMemo(() => {
    if (!mainResult || !planInputs) return [];
    const retireYear = planInputs.birthYearPrimary + planInputs.retirementAge;
    return mainResult.years.map((y) => {
      const law = lawForYear(y.year);
      const size = y.isSurvivorYear
        ? 1
        : acaHouseholdSizeForYear(
            planInputs.acaHouseholdSize,
            planInputs.acaHouseholdSchedule,
            y.year,
          );
      const row: Record<string, number | null> = { year: y.year, MAGI: Math.round(y.magi) };
      if (ceilings.irmaaTierCap != null) {
        // The cap line is the SAME top-of-tier boundary the
        // engine fills to and classifies by — irmaaTierUpTo
        // deflates the second-to-last tier's ceiling (the top
        // tier's floor, fixed through 2028).
        const cap = irmaaTierUpTo(
          ceilings.irmaaTierCap,
          planInputs.filingStatus,
          law,
          y.year,
          planInputs.inflationPct,
        );
        row["IRMAA cap"] = Number.isFinite(cap) ? cap : null;
      }
      if (ceilings.acaCliffCap) {
        // The cliff is tested by the engine against ACA MAGI (which
        // adds back the non-taxable part of Social Security), NOT
        // against the MAGI line — so ACA MAGI gets its own series,
        // and the cliff line is drawn only across in-scope years
        // (the engine's inAcaScope: at/after the retirement year
        // while anyone in the household is under 65). Nulls break
        // the line outside that span.
        row["ACA MAGI"] = Math.round(y.acaMagi);
        const inAcaScope = y.year >= retireYear && y.acaActive;
        row["ACA cliff"] = inAcaScope ? 4 * fplFor(size, y.year - 1) : null;
      }
      if (ceilings.magiCap != null) row["MAGI cap"] = ceilings.magiCap;
      return row;
    });
  }, [mainResult, planInputs, ceilings]);

  /* ---------------- render ---------------- */
  const fieldFlashTimer = useRef<number | null>(null);
  if (rq.isLoading || retq.isLoading || uiq.isLoading) {
    return <p className="pt-6 text-[var(--dim)]">Loading the Tax Plan planner…</p>;
  }
  if (rq.isError || retq.isError || !data || !ret) {
    return (
      <p className="pt-6 text-[var(--bad)]">
        The Tax Plan planner could not load. Reload the page to try again.
      </p>
    );
  }
  const snap = data.snapshot;
  const detailRow =
    detailYear != null && mainResult
      ? (mainResult.years.find((y) => y.year === detailYear) ?? null)
      : null;

  // Degenerate optimizer result: the "winning" strategy converts
  // nothing in effect — its lifetime totals are identical to Do
  // Nothing's, component by component, and the saving is exactly
  // $0.00 (e.g. a trivial pre-tax balance, where no conversion can
  // change any total). That is not a winning strategy and must not
  // be presented as one; the result card labels it plainly instead.
  // A winner whose totals differ at all — any positive saving —
  // keeps the normal winner presentation.
  const winnerDegenerate = !!(
    optResult?.ok &&
    optResult.winner &&
    optResult.doNothing &&
    optResult.winner.savingVsDoNothing === 0 &&
    optResult.winner.netCost === optResult.doNothing.netCost &&
    optResult.winner.tax === optResult.doNothing.tax &&
    optResult.winner.penalty === optResult.doNothing.penalty &&
    optResult.winner.irmaa === optResult.doNothing.irmaa &&
    optResult.winner.acaCredit === optResult.doNothing.acaCredit &&
    optResult.winner.terminal === optResult.doNothing.terminal
  );

  // The gift description's guard message for the CURRENT
  // field values ("" when priceable): while it is non-empty
  // the gift tab shows the message instead of any priced
  // ledgers, including a previous run's.
  const giftGuardNow =
    (parseMoney(giftAmount) ?? 0) > 0 ? giftGuardFromFields() : "";

  // Split-terminal pricing options for every net-cost figure
  // the view computes itself: with a preserve reserve set, the
  // ending pre-tax up to the floor prices at its expected exit
  // rate and any excess at the heir rate. Blank, the breakdown
  // is the old single-rate figure bit for bit.
  const bdOpts = planInputs
    ? {
        preservePretax: planInputs.preservePretax ?? 0,
        preserveExitRatePct: planInputs.preserveExitRatePct ?? planInputs.heirRatePct,
      }
    : undefined;
  const reserveSet = (planInputs?.preservePretax ?? 0) > 0;
  const reserveExitPct = planInputs?.preserveExitRatePct ?? planInputs?.heirRatePct ?? 0;

  // Starting-balance segments for the "Calculated with" strip's
  // stacked bar (2026-10-25: the strip's first paragraph became a
  // bar plus a one-line rules summary, replacing the text wall).
  // The values are the exact planInputs figures the strip's text
  // rendered before — the compare-pricing fold included (Taxable
  // at its folded figure, a what-if variant's values when one is
  // active) — and the segment colors follow Net Worth's Current
  // buckets bar, with the wife's pre-tax in a lighter shade of the
  // same pre-tax rose. A $0 segment draws no slice but stays in
  // the legend below the bar, as the old text showed it.
  const calcStartSegs = planInputs
    ? [
        { key: "pretax-you", label: "Pre-tax — You", color: "#e11d48", dollars: planInputs.pretaxStart },
        { key: "pretax-wife", label: "Pre-tax — wife", color: "#fb7185", dollars: planInputs.pretaxSpouseStart ?? 0 },
        { key: "roth", label: "Roth", color: "#f59e0b", dollars: planInputs.rothStart },
        { key: "taxable", label: "Taxable", color: "#3b82f6", dollars: planInputs.taxableStart },
        { key: "hsa", label: "HSA", color: "#14b8a6", dollars: planInputs.hsaStart },
      ]
    : [];
  const calcStartTotal = calcStartSegs.reduce((sum, s) => sum + s.dollars, 0);

  // The two winner badges of the merged Strategy Lab table
  // (see the Lab table below): "Lowest tax" on every folded
  // group tied at the run's minimum engine-returned net cost,
  // and "Most left at the end" on every group tied at the
  // run's maximum ending after-tax wealth. A group can carry
  // both. Saved strategies, your current plan, the baseline,
  // and the built-in fill rules are all eligible for both.
  const lowestTaxBadge = (
    <span className="mt-1 block w-fit rounded-full border border-[var(--accent)] px-2 py-0.5 text-xs font-medium whitespace-nowrap text-[var(--accent)]">
      Lowest tax
    </span>
  );
  const mostLeftBadge = (
    <span className="mt-1 block w-fit rounded-full border border-[var(--accent)] px-2 py-0.5 text-xs font-medium whitespace-nowrap text-[var(--accent)]">
      Most left at the end
    </span>
  );

  /* Plan-first faces: the workspace the results area presents.
     On the plan face the Plan workspace always shows (the saved
     plan is the screen, whatever workspace was last open in All
     settings); on the change face no workspace takeaway shows;
     in All settings the stored workspace choice rules, exactly
     as before. */
  const effMode: RothResultsMode | "change" =
    face === "plan" ? "plan" : face === "change" ? "change" : resultsMode;
  const showPlanWorkspace = effMode === "plan";

  /* -------- One-line takeaway (Plan summary) --------
     A single quiet sentence under the Results workspace tab bar,
     mirroring the Retirement view's plan summary. Assembled ONLY
     from figures the engine already computed and this view
     already displays — no new math beyond the displayed-figure
     footing rule: every dollar is fmtDollars (whole-dollar
     rounding) and any printed difference is
     Math.round(doNothing) − Math.round(plan) from the two
     displayed amounts, so the sentence foots with the numbers
     inside it. Compare mode renders no line: the comparison
     table has no single natural subject and is itself the
     summary. The PLAN branch returns { full, short } (contract
     v66): the visible line is the one-line short form generated
     from the same priced figures, and the full sentence —
     unchanged, word for word — rides the line's ⓘ. The other
     modes still return their plain sentence string. */
  const takeawayText: string | { full: string; short: string } | null = (() => {
    const joinAnd = (parts: string[]): string => {
      if (parts.length === 0) return "";
      if (parts.length === 1) return parts[0]!;
      if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
      return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
    };
    const savingClause = (planNet: number, dnNet: number): string => {
      const diff = Math.round(dnNet) - Math.round(planNet);
      if (diff > 0) return `${fmtDollars(diff)} less than Do Nothing (${fmtDollars(dnNet)})`;
      if (diff < 0) return `${fmtDollars(Math.abs(diff))} more than Do Nothing (${fmtDollars(dnNet)})`;
      return `the same lifetime net cost as Do Nothing (${fmtDollars(dnNet)})`;
    };
    if (effMode === "optimize") {
      if (!optResult?.ok || !optResult.winner || !optResult.doNothing || !planInputs) return null;
      if (winnerDegenerate) return "No conversion beats Do Nothing on these inputs";
      const winner = optResult.winner;
      const dnNet = optResult.doNothing.netCost;
      const heir = planInputs.heirRatePct;
      const claimClause = winner.claimLabel ? ` · ${winner.claimLabel}` : "";
      const winnerRow = optCompareRows[0];
      let endingClause: string | null = null;
      if (winnerRow) {
        const reproTerminal = netCostBreakdown(winnerRow.result, heir, bdOpts).terminal;
        if (Math.abs(reproTerminal - winner.terminal) < 0.01) {
          endingClause = reserveSet
            ? `ends with ${fmtDollars(winnerRow.result.endingPretax)} pre-tax (terminal tax ${fmtDollars(winner.terminal)} — ${fmtDollars(winner.preservedPretax)} preserved at the ${reserveExitPct}% exit rate, the rest at the ${heir}% heir rate)`
            : `ends with ${fmtDollars(winnerRow.result.endingPretax)} pre-tax (terminal tax ${fmtDollars(winner.terminal)} at the ${heir}% heir rate)`;
        }
      }
      if (!endingClause) {
        endingClause = reserveSet
          ? `terminal tax ${fmtDollars(winner.terminal)} on the pre-tax left over (${fmtDollars(winner.preservedPretax)} of it preserved at the ${reserveExitPct}% exit rate, the rest at the ${heir}% heir rate)`
          : `terminal tax ${fmtDollars(winner.terminal)} at the ${heir}% heir rate on the pre-tax left over`;
      }
      return `Best of ${optResult.candidatesTested} tested: ${winner.name} (${winner.windowLabel})${claimClause} — lifetime net cost ${fmtDollars(winner.netCost)}, lifetime Social Security collected ${fmtDollars(winner.ssCollected)}, ${savingClause(winner.netCost, dnNet)} → ${endingClause}.`;
    }
    if (effMode === "proof") {
      if (!planInputs || !proofInputs || !proofStats) return null;
      if (proofStats.startingPretax <= 0) return "Pretax Spending (not saved): no pre-tax balance is priced yet.";
      const payFromClause =
        proofInputs.payTaxFrom === "taxable"
          ? "paying taxes from Taxable"
          : "paying taxes from the conversion";
      return proofStats.firstZero
        ? `Pretax Spending (not saved — your plan still ends at age ${planInputs.endAgePrimary}): pre-tax empties during ${proofStats.firstZero.year}, age ${proofStats.firstZero.agePrimary}, starting from ${fmtDollars(proofStats.startingPretax)} at ${fmtDollars(proofInputs.annualSpending)}/yr of spending, ${payFromClause}.`
        : `Pretax Spending (not saved — your plan still ends at age ${planInputs.endAgePrimary}): pre-tax still holds ${fmtDollars(proofStats.last?.pretaxEnd ?? 0)} at age ${PROOF_END_AGE}, starting from ${fmtDollars(proofStats.startingPretax)} at ${fmtDollars(proofInputs.annualSpending)}/yr of spending, ${payFromClause}.`;
    }
    if (effMode !== "plan") return null;
    if (!planInputs || !mainResult) return null;
    const startingPretax = planInputs.pretaxStart + (planInputs.pretaxSpouseStart ?? 0);
    if (startingPretax === 0) {
      return "No pre-tax balance is priced yet, so there is nothing to convert — this plan currently matches Do Nothing.";
    }
    const dnEntry = compareResults.find((r) => r.strategy.id === "none");
    if (!dnEntry) return null;
    const planBd = netCostBreakdown(mainResult, planInputs.heirRatePct, bdOpts);
    const dnBd = netCostBreakdown(dnEntry.result, planInputs.heirRatePct, bdOpts);
    const planNet = planBd.netCost;
    const dnNet = dnBd.netCost;
    const heir = planInputs.heirRatePct;
    const endingFor = (ending: number, bd: typeof planBd): string =>
      reserveSet
        ? `ends with ${fmtDollars(ending)} pre-tax (terminal tax ${fmtDollars(bd.terminal)} — ${fmtDollars(bd.preservedPretax)} of it preserved at the ${reserveExitPct}% exit rate, the rest at the ${heir}% heir rate)`
        : `ends with ${fmtDollars(ending)} pre-tax (terminal tax ${fmtDollars(bd.terminal)} at the ${heir}% heir rate)`;
    // Branch selection keys on the strategy's OWN conversion:
    // additional(y) = priced conversion minus the already-made
    // part (nonzero only in the first plan year). A plan whose
    // strategy adds $0 in every year takes the converts-nothing
    // family even when an already-converted amount was priced.
    const additionalOf = (y: (typeof mainResult.years)[number]): number =>
      y.conversion - y.conversionAlready;
    const totalAdditional = mainResult.years.reduce((a, y) => a + additionalOf(y), 0);
    if (totalAdditional === 0) {
      // The stated reason comes from the engine's own per-year
      // fill outcomes in the WINDOW years — never guessed from
      // whether a ceiling is switched on. Only a uniform window
      // outcome earns a causal parenthetical; mixed outcomes, a
      // uniform outcome with no truthful plain wording here
      // (bunching off-years), or no
      // window years at all fall back to a neutral sentence that
      // asserts no cause.
      const windowOutcomes = mainResult.years
        .filter((y) => y.detail.fill.inWindow)
        .map((y) => y.detail.fill.outcome);
      const uniformOutcome =
        windowOutcomes.length > 0 &&
        windowOutcomes.every((o) => o === windowOutcomes[0])
          ? windowOutcomes[0]
          : null;
      const reason =
        uniformOutcome === "no-ceilings"
          ? "no ceilings switched on"
          : uniformOutcome === "no-room-under-ceilings"
            ? "no room under the ceilings in any window year"
            : uniformOutcome === "aca-inactive-only-ceiling"
              ? "the only ceiling switched on — the ACA limit — never applied in the window years"
              : uniformOutcome === "era-cliff-off"
                ? "the ACA cliff cap stops applying once the household steps down, and every window year is at or past the household schedule's first step year"
              : uniformOutcome === "pretax-empty"
                ? "the pre-tax balance was already gone by the window years"
                : uniformOutcome === "reserve-floor"
                  ? "the pre-tax balance is already at the preserved reserve, so nothing may convert"
                  : uniformOutcome === "already-converted-only"
                  ? "the only conversion priced is the one already made this year"
                  : null;
      const displayedDiff = Math.round(dnNet) - Math.round(planNet);
      const middle =
        displayedDiff === 0
          ? `lifetime net cost ${fmtDollars(planNet)}, the same as Do Nothing`
          : `lifetime net cost ${fmtDollars(planNet)} vs Do Nothing ${fmtDollars(dnNet)}`;
      const ending = endingFor(mainResult.endingPretax, planBd);
      // Short line (contract v66): the visible line under the
      // ending strip is ONE line generated from the same
      // priced figures (the displayed-figure delta above);
      // the full sentence rides the line's ⓘ verbatim.
      const deltaPhrase =
        displayedDiff > 0
          ? `saves ${fmtDollars(displayedDiff)} vs Do Nothing`
          : displayedDiff < 0
            ? `costs ${fmtDollars(Math.abs(displayedDiff))} more than Do Nothing`
            : "the same net cost as Do Nothing";
      return {
        full: reason
          ? `This plan converts nothing (${reason}) — ${middle} → ${ending}.`
          : `This plan converts nothing in the window years — ${middle} → ${ending}.`,
        short: reason
          ? `Converts nothing (${reason}) · ${deltaPhrase}`
          : `Converts nothing in the window years · ${deltaPhrase}`,
      };
    }
    // Normal converting plan.
    const ceilingParts: string[] = [];
    if (ceilings.bracketTopPct != null) ceilingParts.push(`top of the ${ceilings.bracketTopPct}% bracket`);
    if (ceilings.irmaaTierCap != null) ceilingParts.push(`IRMAA Tier ${ceilings.irmaaTierCap} ceiling`);
    if (ceilings.ltcgZeroCap) ceilingParts.push("top of the 0% capital-gains space");
    if (ceilings.acaCliffCap) ceilingParts.push("at or under 400% of the poverty line (ACA)");
    if (ceilings.acaCliffCap && ceilings.acaCliffCapFamilyOnly)
      ceilingParts.push("the cliff cap only until the household steps down");
    if (ceilings.acaCliffCap && ceilings.acaCliffBuffer != null && ceilings.acaCliffBuffer > 0)
      ceilingParts.push(`a ${fmtDollars(ceilings.acaCliffBuffer)} safety buffer under the cliff`);
    if (!ceilings.acaCliffCap && ceilings.acaCliffBuffer != null && ceilings.acaCliffBuffer > 0)
      ceilingParts.push(`a ${fmtDollars(ceilings.acaCliffBuffer)} cliff safety buffer is saved but not active (the cliff cap is off)`);
    if (ceilings.magiCap != null) ceilingParts.push(`MAGI cap ${fmtDollars(ceilings.magiCap)}`);
    const ceilingPhrase = ceilingParts.length ? joinAnd(ceilingParts) : "no ceilings switched on";
    let qualifiers = "";
    if (currentStrategy.guardrail) qualifiers += ", with the marginal-rate guardrail";
    if (currentStrategy.bunching) qualifiers += ", with ACA bunching";
    // Binding clause: the primary target kind is excluded; every
    // other kind with a bound cap in a converted year is named.
    const primaryKind: "bracket" | "ltcgZero" | "irmaa" | "magi" | "acaCliff" =
      ceilings.bracketTopPct != null
        ? "bracket"
        : ceilings.ltcgZeroCap
          ? "ltcgZero"
          : ceilings.acaCliffCap
            ? "acaCliff"
            : ceilings.irmaaTierCap != null
              ? "irmaa"
              : "magi";
    const capName = (kind: typeof primaryKind | "preserve"): string => {
      if (kind === "preserve") return "the pre-tax reserve";
      if (kind === "acaCliff") return "the ACA limit";
      if (kind === "irmaa") return `the IRMAA Tier ${ceilings.irmaaTierCap} ceiling`;
      if (kind === "magi") return "the MAGI cap";
      if (kind === "ltcgZero") return "the 0% capital-gains limit";
      return `the ${ceilings.bracketTopPct}% bracket top`;
    };
    const kindOrder: (typeof primaryKind | "preserve")[] = ["bracket", "ltcgZero", "irmaa", "acaCliff", "magi", "preserve"];
    const bindingParts: string[] = [];
    for (const kind of kindOrder) {
      if (kind === primaryKind) continue;
      const years: number[] = [];
      for (const y of mainResult.years) {
        if (y.detail.fill.outcome !== "converted") continue;
        const cap = y.detail.fill.caps.find((c) => c.kind === kind);
        if (cap?.bound) years.push(y.year);
      }
      if (years.length === 0) continue;
      const range =
        years.length === 1 ? `${years[0]}` : `${years[0]}–${years[years.length - 1]}`;
      bindingParts.push(`capped by ${capName(kind)} in ${range}`);
    }
    const bindingClause = bindingParts.length ? `, ${bindingParts.join(" and ")}` : "";
    let endingClause: string;
    if (mainResult.endingPretax === 0) {
      // "Fully converted" is claimed ONLY when BOTH hold:
      // (i) the FIRST year with pretaxEnd === 0 has additional
      // (strategy) conversion > 0 that year, and
      // (ii) cumulative non-conversion outflows from pre-tax
      // across the WHOLE plan are $0. Non-conversion outflows
      // are RMDs, spending draws from pre-tax
      // (detail.extraPreTaxDraw), and overflow tax debited from
      // pre-tax. The debit channel is not returned directly; it
      // is the balance-identity residual per year:
      // taxDebit = max(0, (priorPretaxBalance − rmd − additional
      // − extraPreTaxDraw) − pretaxEnd / growth), where growth
      // undoes the year's return. Withholding taken out of a
      // conversion distribution is part of the conversion
      // itself, not a separate outflow — the identity already
      // treats it so. The cumulative total counts as $0 when it
      // is ≤ $0.05 (cent-rounding of the returned fields).
      const growth = 1 + planInputs.expectedReturnPct / 100;
      let cumulativeNonConversionOutflows = 0;
      for (const y of mainResult.years) {
        const additional = additionalOf(y);
        const taxDebit = Math.max(
          0,
          y.detail.priorPretaxBalance - y.rmd - additional - y.detail.extraPreTaxDraw - y.pretaxEnd / growth,
        );
        cumulativeNonConversionOutflows += y.rmd + y.detail.extraPreTaxDraw + taxDebit;
      }
      const firstZero = mainResult.years.find((y) => y.pretaxEnd === 0);
      endingClause =
        firstZero && additionalOf(firstZero) > 0 && cumulativeNonConversionOutflows <= 0.05
          ? `pre-tax fully converted by age ${firstZero.agePrimary}`
          : endingFor(mainResult.endingPretax, planBd);
    } else {
      endingClause = endingFor(mainResult.endingPretax, planBd);
    }
    // Short line (contract v66), same treatment as the
    // converts-nothing branch: the conversion fact and the
    // exact delta vs Do Nothing on one line, the full
    // sentence verbatim in the line's ⓘ.
    const displayedDiff = Math.round(dnNet) - Math.round(planNet);
    const deltaPhrase =
      displayedDiff > 0
        ? `saves ${fmtDollars(displayedDiff)} vs Do Nothing`
        : displayedDiff < 0
          ? `costs ${fmtDollars(Math.abs(displayedDiff))} more than Do Nothing`
          : "the same net cost as Do Nothing";
    return {
      full: `Convert from age ${planInputs.windowStartAge} to ${planInputs.windowStopAge}, filling to ${ceilingPhrase}${qualifiers}${bindingClause} — lifetime net cost ${fmtDollars(planNet)}, ${savingClause(planNet, dnNet)} → ${endingClause}.`,
      short: `Converts ${fmtDollars(totalAdditional)} from age ${planInputs.windowStartAge} to ${planInputs.windowStopAge} · ${deltaPhrase}`,
    };
  })();

  // Heir-rate sensitivity strip: the optimizer re-run at heir
  // rates 0% / 22% / 32% (server-side, display only). "Same
  // winner" means the same strategy — name, window, and variant
  // flags — won at all three rates; then the strip compresses to
  // one line with the three net costs.
  const heirLines = optResult?.ok ? optResult.heirRateSensitivity : [];
  const heirFirst = heirLines[0];
  const heirSameWinner =
    heirLines.length === 3 &&
    heirFirst != null &&
    heirLines.every(
      (l) =>
        l.winnerName === heirFirst.winnerName &&
        l.windowLabel === heirFirst.windowLabel &&
        l.drawOrderLabel === heirFirst.drawOrderLabel &&
        l.guardrail === heirFirst.guardrail &&
        l.bunching === heirFirst.bunching,
    );

  // "Show the math" drill-down for one priced year — the
  // engine's own figures for the row, line by line. Shared by
  // the plan's year-by-year table and the This year panel's
  // execution year (the same RothYear shape), so a year is
  // explained exactly one way anywhere it appears.
  const renderYearDetail = (detailRow: RothYear, onCloseDetail: () => void) => (
                <div
                  className="mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-4 py-4"
                  aria-label={`How ${detailRow.year} was built`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="text-base font-semibold">
                      How {detailRow.year} was built (age {detailRow.agePrimary}
                      {detailRow.ageSpouse != null ? ` / spouse ${detailRow.ageSpouse}` : ""})
                      {" "}· filed as {FILING_LABELS[detailRow.filingStatus]}
                    </h3>
                    <button
                      type="button"
                      aria-label={`Close the math for ${detailRow.year}`}
                      className="shrink-0 rounded-[var(--radius)] border border-[var(--border)] px-2.5 py-1 text-sm hover:text-[var(--accent)]"
                      onClick={onCloseDetail}
                    >
                      Close
                    </button>
                  </div>

                  <h4 className="mt-4 text-sm font-semibold">Income</h4>
                  <ul className="mt-1.5 space-y-1 text-sm">
                    <li>
                      Required minimum distribution:{" "}
                      <span className="tnum font-medium">{fmtDollars(detailRow.rmd)}</span>
                      {detailRow.rmd > 0 && detailRow.detail.rmdDivisor != null ? (
                        <>
                          {" "}— prior Dec 31 pre-tax balance{" "}
                          <span className="tnum">{fmtDollars(detailRow.detail.priorPretaxBalance)}</span>
                          {" "}÷ divisor{" "}
                          <span className="tnum">{detailRow.detail.rmdDivisor}</span> (
                          {detailRow.detail.rmdTable === "joint"
                            ? "Joint Life and Last Survivor table — spouse is sole beneficiary and more than 10 years younger"
                            : "Uniform Lifetime table"}
                          )
                        </>
                      ) : (
                        " — no RMD is due this year"
                      )}
                    </li>
                    {(detailRow.detail.priorPretaxSpouse > 0 ||
                      detailRow.detail.rmdSpouse > 0 ||
                      detailRow.detail.isSurvivorYear ||
                      detailRow.detail.isDeathYear) && (
                      <li>
                        Per-spouse pre-tax: Your prior Dec 31 balance{" "}
                        <span className="tnum">{fmtDollars(detailRow.detail.priorPretaxPrimary)}</span>
                        {detailRow.detail.rmdPrimary > 0 && detailRow.detail.rmdDivisorPrimary != null ? (
                          <>
                            {" "}→ your RMD{" "}
                            <span className="tnum">{fmtDollars(detailRow.detail.rmdPrimary)}</span>{" "}
                            (÷ {detailRow.detail.rmdDivisorPrimary},{" "}
                            {detailRow.detail.rmdTablePrimary === "joint"
                              ? "Joint Life table"
                              : "Uniform Lifetime table"}
                            )
                          </>
                        ) : (
                          <> — no RMD due on your side this year</>
                        )}
                        {" "}· Spouse&rsquo;s prior Dec 31 balance{" "}
                        <span className="tnum">{fmtDollars(detailRow.detail.priorPretaxSpouse)}</span>
                        {detailRow.detail.rmdSpouse > 0 && detailRow.detail.rmdDivisorSpouse != null ? (
                          <>
                            {" "}→ their RMD{" "}
                            <span className="tnum">{fmtDollars(detailRow.detail.rmdSpouse)}</span>{" "}
                            (÷ {detailRow.detail.rmdDivisorSpouse},{" "}
                            {detailRow.detail.rmdTableSpouse === "joint"
                              ? "Joint Life table"
                              : "Uniform Lifetime table"}
                            )
                          </>
                        ) : (
                          <> — no RMD due on their side this year</>
                        )}
                        {detailRow.detail.isDeathYear && (
                          <>
                            {" "}Death year: each spouse&rsquo;s RMD is still
                            figured on their own balance, clock, and table, as if
                            they had lived the year, and the year still files
                            jointly. Remaining balances combine on the
                            survivor&rsquo;s side from next year.
                          </>
                        )}
                        {detailRow.detail.isSurvivorYear && (
                          <>
                            {" "}Survivor year: the combined pre-tax balance runs on
                            the survivor&rsquo;s own RMD clock (Uniform Lifetime
                            table), and the year files as a single filer.
                          </>
                        )}
                      </li>
                    )}
                    <li>
                      Roth conversion:{" "}
                      <span className="tnum font-medium">{fmtDollars(detailRow.conversion)}</span>
                      {detailRow.conversionAlready > 0 && (
                        <> (incl. {fmtDollars(detailRow.conversionAlready)} already converted before the plan ran)</>
                      )}
                    </li>
                    <li>
                      Other ordinary income:{" "}
                      <span className="tnum">{fmtDollars(detailRow.detail.otherOrdinary)}</span>
                    </li>
                    {detailRow.detail.extraPreTaxDraw > 0 && (
                      <li>
                        Extra pre-tax draw for spending:{" "}
                        <span className="tnum">{fmtDollars(detailRow.detail.extraPreTaxDraw)}</span>
                      </li>
                    )}
                    {detailRow.detail.ltcg > 0 && (
                      <li>
                        Long-term capital gains realized (from taxable-account draws):{" "}
                        <span className="tnum">{fmtDollars(detailRow.detail.ltcg)}</span>
                      </li>
                    )}
                    {detailRow.ssBenefits > 0 ? (
                      <li>
                        Social Security:{" "}
                        <span className="tnum">{fmtDollars(detailRow.ssBenefits)}</span> received,{" "}
                        <span className="tnum font-medium">{fmtDollars(detailRow.detail.ssTaxable)}</span>{" "}
                        taxable ({Math.round(detailRow.ssPctTaxed)}% of benefits). Provisional
                        income is{" "}
                        <span className="tnum">{fmtDollars(detailRow.detail.provisionalIncome)}</span>{" "}
                        — other income plus tax-exempt interest plus half of benefits — and
                        the §86 phase-in taxes benefits against the statutory thresholds
                        on that figure.
                      </li>
                    ) : (
                      <li>Social Security: no benefits received this year.</li>
                    )}
                    {detailRow.detail.taxExemptInterest > 0 && (
                      <li>
                        Tax-exempt interest:{" "}
                        <span className="tnum">{fmtDollars(detailRow.detail.taxExemptInterest)}</span>{" "}
                        — not in AGI, but counted in provisional income and MAGI.
                      </li>
                    )}
                    <li>
                      Adjusted gross income:{" "}
                      <span className="tnum font-medium">{fmtDollars(detailRow.agi)}</span>
                      {" "}· MAGI: <span className="tnum">{fmtDollars(detailRow.magi)}</span>
                      {" "}· ACA household income: <span className="tnum">{fmtDollars(detailRow.acaMagi)}</span>
                    </li>
                  </ul>

                  <h4 className="mt-4 text-sm font-semibold">From gross income to tax</h4>
                  <ul className="mt-1.5 space-y-1 text-sm">
                    <li>
                      Standard deduction:{" "}
                      <span className="tnum font-medium">{fmtDollars(detailRow.detail.standardDeduction)}</span>{" "}
                      — base <span className="tnum">{fmtDollars(detailRow.detail.baseStandardDeduction)}</span>
                      {detailRow.detail.count65 > 0 && (
                        <>
                          {" "}+ age-65 add-on{" "}
                          <span className="tnum">{fmtDollars(detailRow.detail.age65AddonTotal)}</span>{" "}
                          ({detailRow.detail.count65}{" "}
                          {detailRow.detail.count65 === 1 ? "person" : "people"} aged 65+)
                        </>
                      )}
                    </li>
                    {detailRow.detail.itemizedDeduction > 0 && (
                      <li>
                        Itemized deductions:{" "}
                        <span className="tnum">{fmtDollars(detailRow.detail.itemizedDeduction)}</span>{" "}
                        {detailRow.detail.deductionTaken === "itemized"
                          ? "— more than the standard deduction, so the itemized total is used."
                          : "— less than the standard deduction, so the standard deduction is used."}
                      </li>
                    )}
                    {detailRow.detail.section68Reduction > 0 && (
                      <li>
                        §68 limitation (2026 law): the itemized total above is after a{" "}
                        <span className="tnum">{fmtDollars(detailRow.detail.section68Reduction)}</span>{" "}
                        reduction for income over the 37%-bracket threshold.
                      </li>
                    )}
                    {detailRow.detail.nonItemizerCharitableDeduction > 0 && (
                      <li>
                        Charitable deduction for non-itemizers (§170(p), 2026 law):{" "}
                        <span className="tnum">{fmtDollars(detailRow.detail.nonItemizerCharitableDeduction)}</span>{" "}
                        — already taken off AGI above, so it is not in the deductions below.
                      </li>
                    )}
                    {detailRow.detail.seniorDeduction > 0 && (
                      <li>
                        Temporary senior deduction (2025–2028):{" "}
                        <span className="tnum">{fmtDollars(detailRow.detail.seniorDeduction)}</span>
                      </li>
                    )}
                    <li>
                      Total deductions:{" "}
                      <span className="tnum">{fmtDollars(detailRow.detail.deductions)}</span>
                      {" "}→ taxable income:{" "}
                      <span className="tnum font-medium">{fmtDollars(detailRow.taxableIncome)}</span>
                    </li>
                  </ul>
                  {detailRow.detail.bracketLayers.length > 0 ? (
                    <>
                      <p className="mt-2 text-sm">
                        Ordinary income of{" "}
                        <span className="tnum">{fmtDollars(detailRow.detail.ordinaryTaxableIncome)}</span>{" "}
                        is taxed layer by layer:
                      </p>
                      <ul className="mt-1 space-y-1 text-sm">
                        {detailRow.detail.bracketLayers.map((l) => (
                          <li key={l.ratePct} className="tnum">
                            {l.ratePct}% on {fmtDollars(l.amount)} (from {fmtDollars(l.from)}
                            {l.to != null ? ` to ${fmtDollars(l.to)}` : " and up"}) — tax{" "}
                            {fmtDollars(l.tax)}
                          </li>
                        ))}
                        <li>
                          Ordinary tax:{" "}
                          <span className="tnum font-medium">{fmtDollars(detailRow.detail.ordinaryTax)}</span>
                        </li>
                      </ul>
                    </>
                  ) : (
                    <p className="mt-2 text-sm">No ordinary taxable income this year.</p>
                  )}
                  {detailRow.detail.gainsInTaxableIncome > 0 ? (
                    <ul className="mt-2 space-y-1 text-sm">
                      <li>
                        Long-term gains of{" "}
                        <span className="tnum">{fmtDollars(detailRow.detail.gainsInTaxableIncome)}</span>{" "}
                        stack on top of the ordinary income:
                        {detailRow.detail.gainsAt0 > 0 && (
                          <> <span className="tnum">{fmtDollars(detailRow.detail.gainsAt0)}</span> at 0%,</>
                        )}
                        {detailRow.detail.gainsAt15 > 0 && (
                          <> <span className="tnum">{fmtDollars(detailRow.detail.gainsAt15)}</span> at 15%,</>
                        )}
                        {detailRow.detail.gainsAt20 > 0 && (
                          <> <span className="tnum">{fmtDollars(detailRow.detail.gainsAt20)}</span> at 20%,</>
                        )}{" "}
                        capital-gains tax{" "}
                        <span className="tnum font-medium">{fmtDollars(detailRow.detail.ltcgTax)}</span>.
                      </li>
                    </ul>
                  ) : (
                    <p className="mt-2 text-sm">No long-term gains in this year&rsquo;s taxable income.</p>
                  )}
                  <ul className="mt-2 space-y-1 text-sm">
                    <li>
                      Net Investment Income Tax:{" "}
                      <span className="tnum">{fmtDollars(detailRow.detail.niit)}</span>
                      {detailRow.detail.niit === 0 && " (not applied this year)"}
                    </li>
                    <li>
                      Federal tax for the year:{" "}
                      <span className="tnum font-semibold">{fmtDollars(detailRow.federalTax)}</span>
                      {detailRow.stateTax > 0 && (
                        <> · state tax <span className="tnum">{fmtDollars(detailRow.stateTax)}</span></>
                      )}
                      {detailRow.detail.waStandardDeduction > 0 && (
                        <>
                          {" "}
                          · Washington excise:{" "}
                          <span className="tnum">{fmtDollars(detailRow.detail.waGains)}</span>{" "}
                          of gains −{" "}
                          <span className="tnum">{fmtDollars(detailRow.detail.waStandardDeduction)}</span>{" "}
                          standard deduction ={" "}
                          <span className="tnum">{fmtDollars(detailRow.detail.waTaxableGains)}</span>{" "}
                          taxable
                        </>
                      )}
                      {detailRow.penalty > 0 && (
                        <> · early-withholding penalty <span className="tnum">{fmtDollars(detailRow.penalty)}</span></>
                      )}
                    </li>
                  </ul>
                  {(detailRow.detail.lossCarryInSt > 0 ||
                    detailRow.detail.lossCarryInLt > 0 ||
                    detailRow.detail.lossAllowance > 0 ||
                    detailRow.detail.lossCarryOutSt > 0 ||
                    detailRow.detail.lossCarryOutLt > 0) && (
                    <p className="mt-2 text-sm">
                      Capital-loss carryforward:{" "}
                      {detailRow.detail.lossCarryInSt + detailRow.detail.lossCarryInLt > 0 && (
                        <>
                          <span className="tnum">
                            {fmtDollars(detailRow.detail.lossCarryInSt + detailRow.detail.lossCarryInLt)}
                          </span>{" "}
                          carried in (
                          <span className="tnum">{fmtDollars(detailRow.detail.lossCarryInSt)}</span>{" "}
                          short-term,{" "}
                          <span className="tnum">{fmtDollars(detailRow.detail.lossCarryInLt)}</span>{" "}
                          long-term)
                        </>
                      )}
                      {detailRow.detail.lossAbsorbed > 0 && (
                        <>
                          {" "}· <span className="tnum">{fmtDollars(detailRow.detail.lossAbsorbed)}</span>{" "}
                          absorbed by this year&rsquo;s gains
                        </>
                      )}
                      {detailRow.detail.lossAllowance > 0 && (
                        <>
                          {" "}· <span className="tnum">{fmtDollars(detailRow.detail.lossAllowance)}</span>{" "}
                          used against other income (the $3,000 yearly allowance)
                        </>
                      )}
                      {" "}·{" "}
                      <span className="tnum">
                        {fmtDollars(detailRow.detail.lossCarryOutSt + detailRow.detail.lossCarryOutLt)}
                      </span>{" "}
                      carries into next year.
                    </p>
                  )}

                  <h4 className="mt-4 text-sm font-semibold">The fill</h4>
                  {detailRow.detail.fill.outcome === "converted" ? (
                    <>
                      <p className="mt-1.5 text-sm">
                        The fill converted{" "}
                        <span className="tnum font-medium">{fmtDollars(detailRow.conversion)}</span>
                        {detailRow.detail.fill.boundLabel
                          ? <> — it stopped at: <strong>{detailRow.detail.fill.boundLabel}</strong>.</>
                          : "."}
                      </p>
                      {detailRow.detail.fill.caps.length > 0 && (
                        <ul className="mt-1 space-y-1 text-sm">
                          {detailRow.detail.fill.caps.map((c) => (
                            <li key={c.kind} className="tnum">
                              {c.kind === "preserve" ? (
                                <>
                                  {c.label}: after converting, the combined pre-tax
                                  balance is {fmtDollars(c.actual)} — {fmtDollars(c.room)}{" "}
                                  above the floor
                                  {c.bound ? " (the reserve is what stopped the fill)" : ""}
                                </>
                              ) : (
                                <>
                                  {c.label}: {fmtDollars(c.actual)} of the {fmtDollars(c.cap)} cap —{" "}
                                  {fmtDollars(c.room)} of room left
                                  {c.bound ? " (this is the ceiling that bound)" : ""}
                                </>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  ) : detailRow.detail.fill.outcome === "already-converted-only" ? (
                    <p className="mt-1.5 text-sm">
                      No new conversion this year — the{" "}
                      <span className="tnum">{fmtDollars(detailRow.conversion)}</span> shown is
                      the amount already converted before the plan ran; the fill added
                      nothing further under the switched-on ceilings.
                    </p>
                  ) : (
                    <p className="mt-1.5 text-sm">
                      No conversion this year —{" "}
                      {detailRow.detail.fill.outcome === "outside-window" &&
                        `age ${detailRow.agePrimary} is outside the conversion window (ages ${detailRow.detail.fill.windowStartAge}–${detailRow.detail.fill.windowStopAge}).`}
                      {detailRow.detail.fill.outcome === "no-ceilings" &&
                        "no fill ceilings are switched on for this strategy, so it converts nothing."}
                      {detailRow.detail.fill.outcome === "pretax-empty" &&
                        "the pre-tax balance is empty after this year's RMD, so there is nothing left to convert."}
                      {detailRow.detail.fill.outcome === "bunching-off-year" &&
                        "this strategy bunches conversions around the ACA years: it converts $0 this year so the year's premium credit is kept in full."}
                      {detailRow.detail.fill.outcome === "aca-inactive-only-ceiling" &&
                        "the only ceiling switched on is the ACA cliff, and nobody is on the marketplace this year, so there is no cliff to fill under."}
                      {detailRow.detail.fill.outcome === "era-cliff-off" &&
                        "the only ceiling switched on is the ACA cliff, and this plan defends it only until the household steps down — this year is at or past the household schedule's first step year, so the cap is off and the year prices undefended."}
                      {detailRow.detail.fill.outcome === "no-room-under-ceilings" &&
                        "the year's other income already fills the space under the switched-on ceilings, so no conversion fits."}
                      {detailRow.detail.fill.outcome === "reserve-floor" &&
                        "the combined pre-tax balance is already at the preserved reserve, so conversions stop at the floor this year. RMDs and spending still draw from the reserve as usual."}
                    </p>
                  )}

                  <h4 className="mt-4 text-sm font-semibold">IRMAA</h4>
                  <ul className="mt-1.5 space-y-1 text-sm">
                    <li>
                      This year&rsquo;s MAGI of{" "}
                      <span className="tnum">{fmtDollars(detailRow.magi)}</span> sets{" "}
                      <strong>Tier {detailRow.detail.irmaa.tierSet}</strong> premiums in{" "}
                      {detailRow.detail.irmaa.premiumYear} (the two-year lookback).
                    </li>
                    {detailRow.detail.irmaa.paidTier != null ? (
                      <li>
                        IRMAA paid this year:{" "}
                        <span className="tnum font-medium">{fmtDollars(detailRow.irmaaPaid)}</span>{" "}
                        — Tier {detailRow.detail.irmaa.paidTier}, set by{" "}
                        {detailRow.detail.irmaa.paidSourceYear} MAGI of{" "}
                        <span className="tnum">{fmtDollars(detailRow.detail.irmaa.paidSourceMagi ?? 0)}</span>,
                        charged for {detailRow.detail.irmaa.personsOnMedicare}{" "}
                        {detailRow.detail.irmaa.personsOnMedicare === 1 ? "person" : "people"} on
                        Medicare.
                      </li>
                    ) : detailRow.detail.irmaa.personsOnMedicare > 0 ? (
                      <li>
                        IRMAA paid this year: $0 — the MAGI that would set this year&rsquo;s
                        tier predates the plan and is not known.
                      </li>
                    ) : (
                      <li>Nobody is on Medicare this year, so no IRMAA is paid.</li>
                    )}
                  </ul>

                  <h4 className="mt-4 text-sm font-semibold">ACA premium credit</h4>
                  {detailRow.detail.aca.active && detailRow.detail.aca.priced ? (
                    <ul className="mt-1.5 space-y-1 text-sm">
                      <li>
                        Household of {detailRow.detail.aca.householdSize}: ACA household
                        income <span className="tnum">{fmtDollars(detailRow.acaMagi)}</span>{" "}
                        against the 400% poverty line at{" "}
                        <span className="tnum">{fmtDollars(detailRow.detail.aca.cliff ?? 0)}</span>{" "}
                        (poverty line{" "}
                        <span className="tnum">{fmtDollars(detailRow.detail.aca.fpl ?? 0)}</span>;
                        income is{" "}
                        <span className="tnum">{(detailRow.detail.aca.pctFpl ?? 0).toFixed(1)}%</span>{" "}
                        of the poverty line)
                        {detailRow.detail.aca.overCliff
                          ? " — over the cliff, so no credit."
                          : "."}
                      </li>
                      <li>
                        ACA benchmark premium{" "}
                        <span className="tnum">{fmtDollars(detailRow.detail.aca.benchmark ?? 0)}</span>/yr;
                        expected contribution{" "}
                        <span className="tnum">{(detailRow.detail.aca.applicablePct ?? 0).toFixed(2)}%</span>{" "}
                        of income → credit kept:{" "}
                        <span className="tnum font-medium">{fmtDollars(detailRow.acaCreditKept)}</span>.
                      </li>
                    </ul>
                  ) : detailRow.detail.aca.active ? (
                    <p className="mt-1.5 text-sm">
                      Someone is on the marketplace this year, but no ACA benchmark premium is
                      entered for this coverage type, so no credit is priced.
                      {detailRow.detail.aca.cliff != null && (
                        <>
                          {" "}The 400% poverty line for a household of{" "}
                          {detailRow.detail.aca.householdSize} is{" "}
                          <span className="tnum">{fmtDollars(detailRow.detail.aca.cliff)}</span>;
                          this year&rsquo;s ACA household income is{" "}
                          <span className="tnum">{fmtDollars(detailRow.acaMagi)}</span>.
                        </>
                      )}
                    </p>
                  ) : (
                    <p className="mt-1.5 text-sm">
                      Not a marketplace year (before retirement, or nobody under 65) — no
                      ACA credit is priced.
                    </p>
                  )}

                  {(detailRow.detail.educationAotc > 0 ||
                    detailRow.detail.educationLlc > 0) && (
                    <>
                      <h4 className="mt-4 text-sm font-semibold">Education credits</h4>
                      <ul className="mt-1.5 space-y-1 text-sm">
                        {detailRow.detail.educationAotc > 0 && (
                          <li>
                            American Opportunity Credit:{" "}
                            <span className="tnum font-medium">{fmtDollars(detailRow.detail.educationAotc)}</span>{" "}
                            after the income phase-out —{" "}
                            <span className="tnum">{fmtDollars(detailRow.detail.educationRefundable)}</span>{" "}
                            of it is refundable (paid even past a $0 tax bill,
                            counted in the plan&rsquo;s score, and deposited
                            into the taxable account at the start of the next
                            year); the rest reduced this year&rsquo;s tax.
                          </li>
                        )}
                        {detailRow.detail.educationLlc > 0 && (
                          <li>
                            Lifetime Learning Credit:{" "}
                            <span className="tnum font-medium">{fmtDollars(detailRow.detail.educationLlc)}</span>{" "}
                            after the income phase-out — nonrefundable; it
                            reduced this year&rsquo;s tax.
                          </li>
                        )}
                        <li>
                          Nonrefundable education credits applied:{" "}
                          <span className="tnum">{fmtDollars(detailRow.detail.educationNonrefundable)}</span>{" "}
                          — already inside the federal tax above.{" "}
                          {detailRow.detail.educationChoice === "aotc"
                            ? "This year claims the American Opportunity Credit (plus the Lifetime Learning Credit on any other students' expenses) — the better of the two ways the law lets the year's expenses be claimed."
                            : "This year claims the Lifetime Learning Credit only — the better of the two ways the law lets the year's expenses be claimed."}
                        </li>
                      </ul>
                    </>
                  )}

                  {detailRow.detail.amti > 0 && (
                    <>
                      <h4 className="mt-4 text-sm font-semibold">Alternative minimum tax</h4>
                      <p className="mt-1.5 text-sm">
                        AMT income{" "}
                        <span className="tnum">{fmtDollars(detailRow.detail.amti)}</span>
                        , exemption{" "}
                        <span className="tnum">{fmtDollars(detailRow.detail.amtExemption)}</span>
                        , tentative minimum tax{" "}
                        <span className="tnum">{fmtDollars(detailRow.detail.amtTentativeTax)}</span>
                        {detailRow.detail.amtOwed > 0 ? (
                          <>
                            {" "}— AMT owed{" "}
                            <span className="tnum font-medium">{fmtDollars(detailRow.detail.amtOwed)}</span>
                            , already inside the federal tax above.
                          </>
                        ) : (
                          <> — no AMT owed; the tentative tax did not beat the regular tax.</>
                        )}
                      </p>
                    </>
                  )}

                  {detailRow.spendShortfall > 0 && (
                    <p className="mt-4 text-sm text-[var(--bad)]" role="note">
                      Spending not covered:{" "}
                      <span className="tnum font-medium">{fmtDollars(detailRow.spendShortfall)}</span>
                      {" "}— the year&rsquo;s balances could not cover all of its spending.
                    </p>
                  )}
                </div>
  );

  /* -------- guided input sections: live one-line summaries -------- */
  const moneySummaryText = (s: string): string => {
    const d = parseDollars(s);
    return d == null ? "—" : fmtDollars(d);
  };
  const householdSummary = [
    FILING_LABELS[filingStatus],
    birthYearP ? `you born ${birthYearP}` : "your birth year not entered",
    birthYearS ? `spouse born ${birthYearS}` : "spouse's birth year not entered",
    soleBeneficiary ? "spouse is sole beneficiary" : null,
    primarySoleBeneficiaryOfSpouse
      ? "you are sole beneficiary of spouse's accounts"
      : null,
    retirementAge ? `retire at ${retirementAge}` : null,
    endAge ? `plan to age ${endAge}` : null,
    parseDollars(spending) != null
      ? `spending ${fmtDollars(parseDollars(spending)!)}/yr`
      : "spending not entered",
    winStart || winStop ? `convert ${winStart || "—"} → ${winStop || "—"}` : null,
    survivorOn
      ? `survivor scenario: ${survivorWho === "primary" ? "you die" : "spouse dies"} in ${survivorDeathYear || "—"}`
      : null,
  ]
    .filter((p): p is string => p != null)
    .join(" · ");
  const allBalancesFollow =
    !balanceOverrides.pretax &&
    !balanceOverrides.pretaxSpouse &&
    !balanceOverrides.roth &&
    !balanceOverrides.taxable &&
    !balanceOverrides.hsa;
  // The draw-order switch is named in the section summary only
  // while a switch age is entered.
  const drawOrderSwitchSummary =
    parseIntField(drawOrderSwitchAge) != null
      ? ` · Draw order ${drawOrderLabel(drawOrderFromKey(drawOrder))}, then ${drawOrderLabel(drawOrderFromKey(drawOrderAfter))} from ${parseIntField(drawOrderSwitchAge)}`
      : "";
  // The header total and exclusion suffix carry cents exactly:
  // the balances themselves carry cents from the snapshot, and
  // rounding these two figures to whole dollars would hide the
  // exact pool the plan prices.
  const fmtCentsExact = (cents: number): string => {
    const neg = cents < 0;
    const s = `$${(Math.abs(cents) / 100).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
    return neg ? `−${s}` : s;
  };
  // Display-only: every component comes from buildSavePayload —
  // the same effective inputs object this view passes to pricing.
  // Its taxableCents is already the effective pool (the explicit
  // override as entered, or the followed pool minus the active
  // exclusion, floored at $0 by that builder), so no second
  // resolver lives here.
  const headerEffectiveInputs = buildSavePayload();
  const headerBalanceCents = [
    headerEffectiveInputs.pretaxCents,
    headerEffectiveInputs.pretaxSpouseCents,
    headerEffectiveInputs.taxableCents,
    headerEffectiveInputs.rothCents,
    headerEffectiveInputs.hsaCents,
  ];
  const planTotalCents = headerBalanceCents.some((c) => c != null)
    ? headerBalanceCents.reduce<number>((sum, c) => sum + (c ?? 0), 0)
    : null;
  const planTotalHeader =
    planTotalCents != null ? (
      <span className="mt-1.5 flex flex-wrap items-baseline gap-x-2">
        <span className="text-sm text-[var(--dim)]">Plan total</span>
        <span className="tnum text-xl font-bold text-[var(--accent)]">
          {fmtCentsExact(planTotalCents)}
        </span>
      </span>
    ) : null;
  const exclusionSummary =
    !balanceOverrides.taxable &&
    (headerEffectiveInputs.taxableExcludeCents ?? 0) > 0
      ? ` · ${fmtCentsExact(headerEffectiveInputs.taxableExcludeCents ?? 0)} excluded from the plan`
      : "";
  const moneySummary =
    (allBalancesFollow
      ? "Balances follow Net Worth"
      : `Pre-tax — You ${moneySummaryText(pretax)} · Pre-tax — wife ${moneySummaryText(pretaxSpouse)} · Roth ${moneySummaryText(rothBal)} · Taxable ${moneySummaryText(taxableBal)} · HSA ${moneySummaryText(hsaBal)}`) +
    exclusionSummary;
  const ssSummaryText = (amt: string, age: string, who: string, declared: boolean): string => {
    if (declared) return `${who} SS — no benefit`;
    const d = parseDollars(amt);
    if (d == null) return `${who} SS not entered`;
    return `${who} SS ${fmtDollars(d)}/yr${age ? ` from ${age}` : " (start age blank)"}`;
  };
  const incomeSummary = [
    ssSummaryText(ssP, ssPAge, "Your", ssPrimaryNoBenefit),
    ssSummaryText(ssS, ssSAge, "Spouse", ssSpouseNoBenefit),
  ].join(" · ");
  const acaSummary = [
    `Household of ${acaSize || "—"}`,
    acaSteps.length > 0
      ? acaSteps
          .map((r) => `→ ${r.householdSize || "—"} from ${r.fromYear || "—"}`)
          .join(" ")
      : "no household steps set",
    benchCouple || benchSingle || benchFamily
      ? `ACA benchmarks ${moneySummaryText(benchCouple)} / ${moneySummaryText(benchSingle)}${benchFamily ? ` / family ${moneySummaryText(benchFamily)}` : ""}`
      : "ACA benchmark premiums not entered",
  ].join(" · ");
  const advancedSummary = `${activeCeilingPreset ? activeCeilingPreset.name : `Fill to: ${ceilingsSummary}`} · heir ${heirRate || "—"}% · state ${stateRate || "—"}% · inflation ${inflation || "—"}% · return ${expectedPct || "—"}%`;
  const yearTableSummary =
    mainResult && mainResult.years.length > 0
      ? `${mainResult.years[0]!.year}–${mainResult.years[mainResult.years.length - 1]!.year} · total conversions ${fmtDollars(mainResult.years.reduce((a, y) => a + y.conversion, 0))} · total federal tax ${fmtDollars(mainResult.years.reduce((a, y) => a + y.federalTax, 0))}`
      : "";

  /* -------- What's missing strip: live gaps, display + navigation only --------
     Derived live from the same state the fields below edit — the
     effective balance fields, the following/override flags, the
     latest snapshot's bucket splits, the spouse's Social Security
     field, and the two ACA benchmark fields. Nothing here is
     hard-coded, saves anything, or touches the engine: each gap
     is a link that opens its section (through the persisted
     section state) and scrolls it into view. */
  type MissingGap = { key: string; text: string; target: RothSectionId };
  const missingGaps: MissingGap[] = (() => {
    const gaps: MissingGap[] = [];
    if (!init) return gaps;
    // 1. Balances — target: Your money.
    if (!snap) {
      const blankLabels: string[] = [];
      if (parseDollars(pretax) == null && parseDollars(pretaxSpouse) == null)
        blankLabels.push("Pre-tax");
      if (parseDollars(rothBal) == null) blankLabels.push("Roth");
      if (parseDollars(taxableBal) == null) blankLabels.push("Taxable");
      if (parseDollars(hsaBal) == null) blankLabels.push("HSA");
      if (blankLabels.length > 0) {
        gaps.push({
          key: "balances-no-snapshot",
          text:
            blankLabels.length === 1
              ? `${blankLabels[0]} balance is not entered — it prices $0 until you type it here`
              : `${blankLabels.join(", ")} balances are not entered — they price $0 until you type them here`,
          target: "money",
        });
      }
    } else if (!snap.hasAnySplit) {
      if (allBalancesFollow) {
        gaps.push({
          key: "balances-unsplit",
          text: "Balances aren't split yet — this plan prices $0 until you split the Net Worth snapshot or type balances here",
          target: "money",
        });
      } else {
        const missingLabels: string[] = [];
        if (parseDollars(pretax) == null && parseDollars(pretaxSpouse) == null)
          missingLabels.push("Pre-tax");
        if (parseDollars(rothBal) == null) missingLabels.push("Roth");
        if (parseDollars(taxableBal) == null) missingLabels.push("Taxable");
        if (parseDollars(hsaBal) == null) missingLabels.push("HSA");
        if (missingLabels.length > 0) {
          gaps.push({
            key: "balances-unsplit-partial",
            text:
              missingLabels.length === 1
                ? `${missingLabels[0]} isn't split yet — it prices $0 until you split the Net Worth snapshot or type a balance here`
                : `${missingLabels.join(", ")} aren't split yet — they price $0 until you split the Net Worth snapshot or type balances here`,
            target: "money",
          });
        }
      }
    } else {
      // Snapshot is at least partly split: name each balance that
      // is still $0, and never call a partly priced balance $0.
      if (
        snap.pretaxCents == null &&
        !balanceOverrides.pretax &&
        !balanceOverrides.pretaxSpouse
      ) {
        gaps.push({
          key: "balance-pretax",
          text: "Pre-tax has no split in the latest snapshot — it is priced as $0 until you split it in Net Worth or enter a balance",
          target: "money",
        });
      } else if (balanceOverrides.pretax && parseDollars(pretax) == null) {
        gaps.push({
          key: "balance-pretax-blank",
          text: "Pre-tax balance is not entered — it is priced as $0 until you enter it",
          target: "money",
        });
      }
      if (snap.rothCents == null && !balanceOverrides.roth) {
        gaps.push({
          key: "balance-roth",
          text: "Roth has no split in the latest snapshot — it is priced as $0 until you split it in Net Worth or enter a balance",
          target: "money",
        });
      } else if (balanceOverrides.roth && parseDollars(rothBal) == null) {
        gaps.push({
          key: "balance-roth-blank",
          text: "Roth balance is not entered — it is priced as $0 until you enter it",
          target: "money",
        });
      }
      // Taxable is fed by two buckets (Taxable + Cash), so its
      // partial states get their own exact wording.
      const taxableSplitMissing = snap.taxableCents == null && !balanceOverrides.taxable;
      const cashSplitMissing = snap.cashCents == null && !balanceOverrides.taxable;
      if (balanceOverrides.taxable && parseDollars(taxableBal) == null) {
        gaps.push({
          key: "balance-taxable-blank",
          text: "Taxable balance is not entered — it is priced as $0 until you enter it",
          target: "money",
        });
      } else if (taxableSplitMissing && cashSplitMissing) {
        gaps.push({
          key: "balance-taxable",
          text: "Taxable has no split in the latest snapshot — it is priced as $0 until you split it in Net Worth or enter a Taxable balance",
          target: "money",
        });
      } else if (taxableSplitMissing && !cashSplitMissing) {
        gaps.push({
          key: "balance-taxable",
          text: "Taxable has no split in the latest snapshot — the Taxable balance is priced from the Cash bucket only until you split it in Net Worth or enter a Taxable balance",
          target: "money",
        });
      } else if (!taxableSplitMissing && cashSplitMissing) {
        gaps.push({
          key: "balance-cash",
          text: "Cash has no split in the latest snapshot — the Taxable balance is priced from the Taxable bucket only, without Cash, until you split Cash in Net Worth or enter a Taxable balance",
          target: "money",
        });
      }
      if (snap.hsaCents == null && !balanceOverrides.hsa) {
        gaps.push({
          key: "balance-hsa",
          text: "HSA has no split in the latest snapshot — it is priced as $0 until you split it in Net Worth or enter a balance",
          target: "money",
        });
      } else if (balanceOverrides.hsa && parseDollars(hsaBal) == null) {
        gaps.push({
          key: "balance-hsa-blank",
          text: "HSA balance is not entered — it is priced as $0 until you enter it",
          target: "money",
        });
      }
    }
    // 2. Social Security — target: Income. Blank stays listed
    // as missing for either person; a declared "No benefit"
    // leaves the strip (it is a finished answer), as does an
    // entered amount.
    if (parseDollars(ssP) == null && !ssPrimaryNoBenefit) {
      gaps.push({
        key: "primary-ss",
        text: "Primary person's Social Security isn't in the plan yet — that benefit is priced as $0 until you enter it, or mark it as no benefit if there is none",
        target: "income",
      });
    }
    if (parseDollars(ssS) == null && !ssSpouseNoBenefit) {
      gaps.push({
        key: "wife-ss",
        text: "Spouse's Social Security isn't in the plan yet — it is priced as $0 until you enter it, or mark it as no benefit if there is none",
        target: "income",
      });
    }
    // 3. ACA benchmark premiums — target: ACA coverage, one item
    // per missing premium.
    if (parseDollars(benchCouple) == null) {
      gaps.push({
        key: "aca-couple",
        text: "Couple ACA benchmark premium isn't entered — the ACA premium credit isn't priced for couple coverage",
        target: "aca",
      });
    }
    if (parseDollars(benchSingle) == null) {
      gaps.push({
        key: "aca-single",
        text: "Spouse-only ACA benchmark premium isn't entered — the ACA premium credit isn't priced for spouse-only coverage",
        target: "aca",
      });
    }
    return gaps;
  })();

  const jumpToSection = (id: RothSectionId) => {
    if (!openSections[id]) {
      setOpenSections((p) => ({ ...p, [id]: true }));
      saveUiState.mutate({ section: id, open: true });
    }
    window.setTimeout(() => {
      document
        .getElementById(`roth-section-${id}`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
  };

  /* Jump-and-highlight (contract v69): the provenance-tap
     mechanism modelled on Spending's scrollToSection — open
     the target's fold first, scroll on a later frame, then
     flash an outline on the field itself for ~1.6s. The flash
     is applied to the field element directly (its outline is
     restored afterwards) so any field the form renders can be
     a target without the shared field helpers changing. */
  const jumpToField = (fieldId: string, section?: RothSectionId) => {
    setFace("settings");
    if (section && !openSections[section]) {
      setOpenSections((p) => ({ ...p, [section]: true }));
      saveUiState.mutate({ section, open: true });
    }
    window.setTimeout(() => {
      const el = document.getElementById(fieldId);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      const prevOutline = el.style.outline;
      const prevOffset = el.style.outlineOffset;
      el.style.outline = "2px solid var(--accent)";
      el.style.outlineOffset = "2px";
      if (fieldFlashTimer.current != null) {
        window.clearTimeout(fieldFlashTimer.current);
      }
      fieldFlashTimer.current = window.setTimeout(() => {
        el.style.outline = prevOutline;
        el.style.outlineOffset = prevOffset;
      }, 1600);
    }, 150);
  };

  // Social Security "No benefit" handlers (mutual exclusion):
  // typing an amount clears that person's declaration; declaring
  // clears that person's amount. Un-declaring leaves the amount
  // blank — the field returns to "not entered yet."
  const handleSsPChange = (v: string) => {
    setSsP(v);
    if (parseDollars(v) != null) setSsPrimaryNoBenefit(false);
  };
  const handleSsSChange = (v: string) => {
    setSsS(v);
    if (parseDollars(v) != null) setSsSpouseNoBenefit(false);
  };
  const handlePrimaryNoBenefit = (checked: boolean) => {
    setSsPrimaryNoBenefit(checked);
    if (checked) setSsP("");
  };
  const handleSpouseNoBenefit = (checked: boolean) => {
    setSsSpouseNoBenefit(checked);
    if (checked) setSsS("");
  };

  // One collapsible input section: a header button carrying the
  // section's title and its live one-line summary, and the fields
  // below it when open. Open state persists server-side.
  const rothSection = (
    id: RothSectionId,
    title: string,
    summary: string,
    children: ReactNode,
    headerExtra?: ReactNode,
  ) => (
    <section id={`roth-section-${id}`} className={sectionCls} aria-label={title}>
      <button
        type="button"
        aria-expanded={openSections[id]}
        aria-label={`${title} section`}
        className="flex w-full items-start justify-between gap-3 text-left"
        onClick={() => toggleSection(id)}
      >
        <span>
          <span className="block text-base font-semibold">{title}</span>
          <span className="mt-0.5 block text-sm text-[var(--dim)]">{summary}</span>
          {headerExtra}
        </span>
        <FoldChevron open={!!openSections[id]} className="mt-0.5" />
      </button>
      {openSections[id] && <div className="mt-3">{children}</div>}
    </section>
  );

  // Active-dial count for the Debate dials header: the number
  // of non-null values in the same dials object the pricing
  // path builds, so the indicator can never drift from what
  // pricing would apply. survivorWho is the one exception: it
  // is remembered (persisted) while the survivor scenario is
  // off, but pricing applies it only when the scenario is on,
  // so it counts only when survivorEnabled is true.
  const labDialsObjForCount = labDialsObject(labDialRawNow());
  const labDialsSetCount = Object.entries(labDialsObjForCount).filter(
    ([key, v]) =>
      v !== null &&
      !(key === "survivorWho" && labDialsObjForCount.survivorEnabled !== true),
  ).length;

  // Loaded-plan indicator: the saved strategies whose inputs
  // exactly reproduce the current plan, derived once per render
  // with the same projections planMatchesScenario compares —
  // the current payload is stringified once here, then each
  // scenario's applied payload is compared against it. Both
  // indicator surfaces (the Plan form header line and the
  // Strategy Lab badges / no-match line) read this one set.
  const currentPlanJson = JSON.stringify(currentPlanPayload());
  const matchedScenarios = data.scenarios.filter(
    (sc) => JSON.stringify(scenarioAppliedPayload(sc)) === currentPlanJson,
  );
  const matchedScenarioSet = new Set(matchedScenarios);
  const matchedNames = matchedScenarios.map((sc) => sc.name);

  /* -------- Guided change path ("Change the plan") --------
     Five plain questions whose answers are the SAME working
     fields the full form edits — the retirement age, the yearly
     spending, the two Social Security start ages, the draw
     strategy (draw order + fill ceilings + pay-tax-from), and
     the special items (survivor scenario, college years,
     already-converted). Nothing here has its own state: every
     control reads and writes the form's state, so answers are
     prefilled from the saved record, autosave persists them
     exactly like a form edit, and the Changed markers and Back
     to saved behave identically. */
  const guidedPretaxFirstKey =
    DRAW_ORDER_OPTIONS.find((o) => drawOrderFromKey(o.key)[0] === "pretax")?.key ??
    DEFAULT_DRAW_ORDER_KEY;
  const guidedTaxableFirstKey =
    DRAW_ORDER_OPTIONS.find((o) => drawOrderFromKey(o.key)[0] === "taxable")?.key ??
    DEFAULT_DRAW_ORDER_KEY;
  const GUIDED_NO_CONVERSIONS: FillCeilings = {
    bracketTopPct: null,
    irmaaTierCap: null,
    ltcgZeroCap: false,
    acaCliffCap: false,
    acaCliffCapFamilyOnly: false,
    magiCap: null,
    acaCliffBuffer: null,
  };
  type GuidedStrategy = {
    id: string;
    label: string;
    drawKey: string;
    ceilings: FillCeilings;
  };
  const guidedStrategies: GuidedStrategy[] = [
    {
      id: "guided-cliff",
      label: "Spend pre-tax first, and convert up to the ACA cliff",
      drawKey: guidedPretaxFirstKey,
      ceilings:
        CEILING_PRESETS.find((p) => p.name === "Under the ACA cliff")?.fields ??
        GUIDED_NO_CONVERSIONS,
    },
    {
      id: "guided-fill12",
      label: "Spend pre-tax first, and convert up to the top of the 12% bracket",
      drawKey: guidedPretaxFirstKey,
      ceilings:
        CEILING_PRESETS.find((p) => p.name === "Fill 12%")?.fields ??
        GUIDED_NO_CONVERSIONS,
    },
    {
      id: "guided-fill22",
      label: "Spend pre-tax first, and convert up to the top of the 22% bracket",
      drawKey: guidedPretaxFirstKey,
      ceilings:
        CEILING_PRESETS.find((p) => p.name === "Fill 22%")?.fields ??
        GUIDED_NO_CONVERSIONS,
    },
    {
      id: "guided-none",
      label: "Spend taxable first, and make no conversions",
      drawKey: guidedTaxableFirstKey,
      ceilings: GUIDED_NO_CONVERSIONS,
    },
  ];
  const guidedStrategyMatches = (g: GuidedStrategy): boolean =>
    drawOrder === g.drawKey &&
    payTaxFrom === "taxable" &&
    ceilingsMatchPreset(ceilings, g.ceilings);
  const guidedCurrentStrategy =
    guidedStrategies.find((g) => guidedStrategyMatches(g)) ?? null;
  const guidedCurrentDescription = `Draw order ${drawOrderLabel(drawOrderFromKey(drawOrder))} · fill conversions to ${ceilingsSummary} · taxes paid from ${payTaxFrom === "taxable" ? "the taxable account" : "the conversion"}`;
  const applyGuidedStrategy = (g: GuidedStrategy) => {
    setDrawOrder(g.drawKey);
    applyCeilingPreset(g.ceilings);
    setPayTaxFrom("taxable");
  };
  const guidedStrategyChanged =
    changedFields.drawOrder ||
    changedFields.payTaxFrom ||
    changedFields.ceilBracket ||
    changedFields.ceilIrmaa ||
    changedFields.ceilLtcg ||
    changedFields.ceilAca ||
    changedFields.ceilAcaFamilyOnly ||
    changedFields.magiCap ||
    changedFields.cliffBuffer;

  /* December draw console, open: the console takes the whole
     screen (a full-screen swap within this view), with its back
     control at the top returning to the Tax Plan face the user
     left. The December component itself is unchanged — same
     saved state, same pricing — only its doorway moved here. */
  if (decemberOpen) {
    return (
      <div>
        <div className="pt-5">
          <button
            type="button"
            aria-label="Back to Tax Plan view"
            onClick={() => setDecemberOpen(false)}
            className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium text-[var(--text)] hover:text-[var(--accent)]"
          >
            ← Tax Plan
          </button>
        </div>
        <December />
      </div>
    );
  }

  return (
    <div>
      <h1 className="pt-5 text-xl font-semibold">
        Tax Plan
        <InfoNote
          ariaLabel="About the Tax Plan view"
          text="Plans year-by-year Roth conversions in the lower-income years after retirement, before RMDs begin. Every year is priced with the real rules — RMDs first, then the conversion, Social Security by the provisional-income formula, IRMAA on the two-year lookback, and the ACA credit while anyone is on the marketplace."
        />
      </h1>

      {rq.data?.recordUnreadable && (
        <p
          role="alert"
          className="mt-3 max-w-3xl rounded-[var(--radius)] border border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-sm leading-relaxed"
        >
          <strong>Your saved record can&rsquo;t be read.</strong> A saved
          Tax Plan exists, but it can&rsquo;t be opened — so what&rsquo;s
          below is a fresh plan, not your saved one. Saving is paused while
          the record is unreadable, so nothing overwrites it.
        </p>
      )}

      {/* The view's action row: the December draw entry point
          first, then the face switch. (This view's header is a
          plain title + intro with no right-hand action cluster
          to host the button, so it leads the action row.) */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-label="December draw"
          onClick={() => setDecemberOpen(true)}
          className="rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--surface)] px-4 py-2 text-sm font-medium text-[var(--accent)] hover:bg-[var(--accent-soft)]"
        >
          December draw
        </button>

      {/* Sub-navigation (contract v67): underlined text tabs in
          the Retirement view's style — left-aligned over a
          hairline — instead of the former filled-pill segmented
          group, whose language competed with the main view tabs.
          The December draw button at the left of the row keeps
          its outline-button look: it is a jump, not a tab. On
          phone widths the tab group wraps to its own full-width
          line under the button (below 560px) so every tab stays
          reachable — the three labels cannot share the row with
          the button at 390px. */}
      <div
        role="group"
        aria-label="Tax Plan view"
        className="flex w-full min-w-0 flex-nowrap items-end border-b border-[var(--border)] min-[560px]:w-auto min-[560px]:flex-1"
      >
        {(
          [
            { id: "plan", label: "Your plan" },
            { id: "change", label: "Change the plan" },
            { id: "settings", label: "All settings" },
          ] as const
        ).map((f) => (
          <button
            key={f.id}
            type="button"
            aria-label={f.label}
            aria-pressed={face === f.id}
            className={`relative px-3.5 py-2.5 text-sm whitespace-nowrap sm:px-5 ${
              face === f.id
                ? "font-semibold text-[var(--text)]"
                : "font-medium text-[var(--dim)] hover:text-[var(--accent)]"
            }`}
            onClick={() => setFace(f.id)}
          >
            {face === f.id && (
              <span
                aria-hidden="true"
                className="absolute right-2 -bottom-px left-2 h-[2px] bg-[var(--accent)]"
              />
            )}
            {f.label}
          </button>
        ))}
      </div>
      </div>

      {init && (
        <p
          aria-label="Plan summary in plain English"
          className="mt-3 max-w-3xl text-base leading-relaxed font-medium text-[var(--text)]"
        >
          {plainSummaryClauses.map((c, i) => (
            <Fragment key={i}>
              {i > 0 && " · "}
              {c.fieldId ? (
                <button
                  type="button"
                  aria-label={`Go to the ${c.fieldLabel ?? c.text} field`}
                  className="underline decoration-dotted underline-offset-4 hover:text-[var(--accent)]"
                  onClick={() => jumpToField(c.fieldId!, c.section)}
                >
                  {c.text}
                </button>
              ) : (
                c.text
              )}
            </Fragment>
          ))}
        </p>
      )}

      {init && (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {!confirmBackToSaved ? (
            <>
              <button
                type="button"
                aria-label="Back to saved"
                className="px-1 py-2 text-xs text-[var(--dim)] underline underline-offset-2 hover:text-[var(--accent)] disabled:opacity-50"
                disabled={changedCount === 0 && whatIfResult == null}
                onClick={() => {
                  if (changedCount > 0) {
                    setConfirmBackToSaved(true);
                  } else if (whatIfResult != null) {
                    // No field has drifted, but a what-if answer
                    // is on screen: Back to saved clears it and
                    // returns the face to the saved plan only.
                    // The answer was never saved, so no
                    // confirmation is needed to drop it.
                    clearWhatIf();
                  }
                }}
              >
                Back to saved
              </button>
              <span className="text-xs text-[var(--dim)]" aria-live="polite">
                {changedCount === 0
                  ? whatIfResult != null
                    ? "Every field matches the saved plan. A what-if answer is showing — Back to saved clears it."
                    : "Every field matches the saved plan."
                  : `${changedCount} field${changedCount === 1 ? "" : "s"} changed from the saved plan — marked “Changed” below.`}
              </span>
            </>
          ) : (
            <>
              <span className="text-sm text-[var(--bad)]">
                Go back to the saved plan? The {changedCount} changed field
                {changedCount === 1 ? "" : "s"} will return to the saved values —
                nothing is written.
              </span>
              <button
                type="button"
                aria-label="Back to saved"
                className="rounded-[var(--radius)] bg-[var(--bad)] px-4 py-2 text-sm font-medium text-white"
                onClick={() => {
                  backToSaved();
                  clearWhatIf();
                }}
              >
                Back to saved
              </button>
              <button
                type="button"
                aria-label="Cancel back to saved"
                className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium text-[var(--text)]"
                onClick={() => setConfirmBackToSaved(false)}
              >
                Cancel
              </button>
            </>
          )}
        </div>
      )}

      {init && face === "settings" && (
        <section
          aria-label="What's missing"
          className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-3"
        >
          {missingGaps.length === 0 ? (
            <p className="text-sm text-[var(--dim)]">
              All inputs entered — nothing missing.
            </p>
          ) : (
            <>
              <h2 className="text-sm font-semibold">What&rsquo;s missing</h2>
              <ul className="mt-2 flex flex-col gap-1.5">
                {missingGaps.map((g) => (
                  <li key={g.key}>
                    <button
                      type="button"
                      onClick={() => jumpToSection(g.target)}
                      className="text-left text-sm text-[var(--accent)] underline underline-offset-2 hover:text-[var(--text)] focus-visible:text-[var(--text)]"
                    >
                      {g.text}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {face === "settings" && snap && !snap.hasAnySplit && (
        <div
          role="note"
          className="mt-4 rounded-[var(--radius)] border border-[var(--bad)] bg-[var(--bad-soft)] px-4 py-3 text-sm text-[var(--bad)]"
        >
          <strong>Balances are manual — snapshot not split yet.</strong> The latest
          snapshot ({snap.date}, {fmtCents(snap.totalCents)}) has no tax-bucket split,
          so enter the balances below. Once you split it in Net Worth, its bucket
          totals fill any balance you haven't saved yourself.
        </div>
      )}
      {face === "settings" && snap && snap.hasAnySplit && missingSplitBuckets.length > 0 && (
        <div
          role="note"
          className="mt-4 rounded-[var(--radius)] border border-[var(--bad)] bg-[var(--bad-soft)] px-4 py-3 text-sm text-[var(--bad)]"
        >
          <strong>Part of the latest snapshot is not split.</strong> See
          What&rsquo;s missing above for each balance priced as $0 until it is split
          in Net Worth or entered.
        </div>
      )}
      {face === "settings" && !snap && (
        <p className="mt-3 text-sm text-[var(--dim)]">
          No Net Worth snapshot yet — enter the starting balances manually below.
        </p>
      )}

      {face === "settings" && (
        <p className="mt-4 text-sm text-[var(--dim)]">
          {matchedScenarios.length > 0
            ? `Plan matches: ${matchedNames.join(", ")}`
            : "Current plan isn't a saved strategy."}
        </p>
      )}

      {face === "change" && (
        <section className={sectionCls} aria-label="Change the plan">
          <h2 className="text-base font-semibold">
            Change the plan
            <InfoNote
              ariaLabel="About changing the plan"
              text="Five plain questions. Your answers are filled in from your saved plan, and changing one saves it automatically — these are the same fields the full form under All settings edits, so anything you change here shows there too, marked “Changed” until it saves."
            />
          </h2>

          <h3 className="mt-5 text-sm font-semibold">1. When do you stop work?</h3>
          <div className="mt-2 max-w-xs">
            {numField("Retirement age", retirementAge, setRetirementAge, {
              idLabel: "Change the plan — retirement age",
              changed: changedFields.retirementAge,
            })}
          </div>

          <h3 className="mt-5 text-sm font-semibold">2. How much do you spend in a year?</h3>
          <div className="mt-2 max-w-xs">
            {moneyField("Yearly spending", spending, setSpending, {
              idLabel: "Change the plan — yearly spending",
              changed: changedFields.spending,
            })}
          </div>

          <h3 className="mt-5 text-sm font-semibold">3. When does Social Security start?</h3>
          <div className="mt-2 grid max-w-xl grid-cols-2 gap-3">
            {numField("Your Social Security start age", ssPAge, setSsPAge, {
              idLabel: "Change the plan — your Social Security start age",
              disabled: ssPrimaryNoBenefit,
              hint: ssPrimaryNoBenefit
                ? "Marked as no benefit in All settings — priced as $0."
                : undefined,
              changed: changedFields.ssPAge,
            })}
            {filingStatus !== "single" &&
              numField("Spouse Social Security start age", ssSAge, setSsSAge, {
                idLabel: "Change the plan — spouse Social Security start age",
                disabled: ssSpouseNoBenefit,
                hint: ssSpouseNoBenefit
                  ? "Marked as no benefit in All settings — priced as $0."
                  : undefined,
                changed: changedFields.ssSAge,
              })}
          </div>

          <h3 className="mt-5 text-sm font-semibold">
            4. How should the money come out?
            {guidedStrategyChanged && <ChangedMark />}
          </h3>
          <div className="mt-2 flex flex-col gap-2" role="radiogroup" aria-label="How the money comes out">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="guided-strategy"
                aria-label="Keep my current way"
                className="mt-1 h-4 w-4 shrink-0"
                checked={guidedCurrentStrategy == null}
                onChange={() => {
                  // Keeping the current way changes nothing.
                }}
              />
              <span>
                <strong>Keep my current way</strong>
                <span className="block text-[var(--dim)]">{guidedCurrentDescription}</span>
              </span>
            </label>
            {guidedStrategies.map((g) => (
              <label key={g.id} className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="guided-strategy"
                  aria-label={g.label}
                  className="mt-1 h-4 w-4 shrink-0"
                  checked={guidedCurrentStrategy?.id === g.id}
                  onChange={() => applyGuidedStrategy(g)}
                />
                <span>{g.label}</span>
              </label>
            ))}
          </div>
          <p className={hintCls}>
            A choice sets the draw order, the conversion fill, and paying the
            tax from the taxable account — the same three settings All settings
            edits. Fine-tuning (a different tax source, a draw-order switch, a
            custom ceiling) lives there.
          </p>

          <h3 className="mt-5 text-sm font-semibold">5. Anything special?</h3>
          <div className="mt-2 flex items-start gap-2">
            <input
              id="guided-survivor"
              type="checkbox"
              aria-label="Model one spouse dying"
              className="mt-1 h-4 w-4"
              checked={survivorOn}
              onChange={(e) => setSurvivorOn(e.target.checked)}
            />
            <label htmlFor="guided-survivor" className="text-sm">
              <strong>Model one spouse dying</strong> — the survivor files
              single, keeps only the larger Social Security benefit, and
              inherits the combined pre-tax balance.
              {changedFields.survivorOn && <ChangedMark />}
            </label>
          </div>
          {survivorOn && (
            <div className="mt-3 grid max-w-xl grid-cols-2 gap-3">
              <div>
                <label className={labelCls} htmlFor="guided-survivor-who">
                  Who dies
                  {changedFields.survivorWho && <ChangedMark />}
                </label>
                <select
                  id="guided-survivor-who"
                  aria-label="Who dies"
                  className={inputCls}
                  value={survivorWho}
                  onChange={(e) =>
                    setSurvivorWho(e.target.value as "primary" | "spouse")
                  }
                >
                  <option value="primary">You</option>
                  <option value="spouse">Spouse</option>
                </select>
              </div>
              {numField("Year of death (calendar year)", survivorDeathYear, setSurvivorDeathYear, {
                idLabel: "Change the plan — year of death",
                changed: changedFields.survivorDeathYear,
              })}
            </div>
          )}
          <div className="mt-3 grid max-w-xl grid-cols-2 gap-3">
            {numField("College years — first fall", collegeFromYear, setCollegeFromYear, {
              idLabel: "Change the plan — college first fall",
              hint: "Leave blank if no college in the household.",
              changed: changedFields.collegeFromYear,
            })}
            {numField("College years — last fall", collegeThroughYear, setCollegeThroughYear, {
              idLabel: "Change the plan — college last fall",
              changed: changedFields.collegeThroughYear,
            })}
            {moneyField("Already converted this year", convertedAlready, setConvertedAlready, {
              idLabel: "Change the plan — already converted this year",
              hint: "Conversions already made this calendar year — the first year's fill tops them up instead of starting over.",
              changed: changedFields.convertedAlready,
            })}
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              aria-label="Done — back to your plan"
              className="rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white"
              onClick={() => setFace("plan")}
            >
              Done — back to your plan
            </button>
            <button
              type="button"
              aria-label="Open All settings instead"
              className="px-1 py-2 text-xs text-[var(--dim)] underline underline-offset-2 hover:text-[var(--accent)]"
              onClick={() => setFace("settings")}
            >
              Open All settings instead
            </button>
          </div>
        </section>
      )}

      {face === "settings" && (
        <>
      {rothSection("money", "Your money", moneySummary + (sectionChangedCount(["pretax", "pretaxSpouse", "rothBal", "taxableBal", "taxableExclude", "hsaBal", "basisPct", "divYieldPct", "intYieldPct", "basisTiers"]) > 0 ? ` · ${sectionChangedCount(["pretax", "pretaxSpouse", "rothBal", "taxableBal", "taxableExclude", "hsaBal", "basisPct", "divYieldPct", "intYieldPct", "basisTiers"])} changed` : ""), (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {moneyField("Pre-tax — You", pretax, setPretax, {
            hint: "Traditional IRA / 401(k) money. From Net Worth, the Pre-tax bucket lands here unless the spouse field below splits it.",
            onEdit: () =>
              setBalanceOverrides((o) => (o.pretax ? o : { ...o, pretax: true })),
            changed: changedFields.pretax,
          })}
          {filingStatus !== "single" &&
            moneyField("Pre-tax — wife", pretaxSpouse, handleWifePretaxEdit, {
              hint: "The spouse's own pre-tax accounts. Blank prices as $0.",
              changed: changedFields.pretaxSpouse,
            })}
          {moneyField("Roth", rothBal, setRothBal, {
            onEdit: () =>
              setBalanceOverrides((o) => (o.roth ? o : { ...o, roth: true })),
            changed: changedFields.rothBal,
          })}
          {moneyField("Taxable (brokerage / bank)", taxableBal, setTaxableBal, {
            onEdit: () =>
              setBalanceOverrides((o) => (o.taxable ? o : { ...o, taxable: true })),
            changed: changedFields.taxableBal,
          })}
          {moneyField("Exclude from plan", taxableExclude, setTaxableExclude, {
            hint: "Part of the taxable pool (Taxable plus Cash) the plan leaves out of its calculations entirely — not spent, not sold, not counted in ending wealth. It stays in Net Worth in full. Blank = nothing excluded.",
            changed: changedFields.taxableExclude,
          })}
          {moneyField("HSA", hsaBal, setHsaBal, {
            onEdit: () =>
              setBalanceOverrides((o) => (o.hsa ? o : { ...o, hsa: true })),
            changed: changedFields.hsaBal,
          })}
          {pctField("Taxable cost basis", basisPct, setBasisPct, {
            hint: "Starting share of the taxable balance that is already-taxed basis. The plan tracks that basis in dollars from there: it does not grow as the account grows, and each withdrawal from Taxable carries its share of basis out with it. Blank = 100% (no capital gains priced on taxable withdrawals).",
            changed: changedFields.basisPct,
          })}
          {pctField("Taxable dividend yield", divYieldPct, setDivYieldPct, {
            hint: "Share of the taxable balance paid out as dividends each year. That income is taxed on the capital-gains stack and counts toward MAGI every year, whether anything is sold or not. It is part of the expected return above, not extra growth, and it is treated as reinvested — it adds to the taxable basis. Blank = no dividend income is modelled.",
            changed: changedFields.divYieldPct,
          })}
          {pctField("Taxable interest yield", intYieldPct, setIntYieldPct, {
            hint: "Share of the taxable balance paid out as interest each year. That income is taxed as ordinary income and counts toward MAGI every year, whether anything is sold or not. It is part of the expected return above, not extra growth, and it is treated as reinvested — it adds to the taxable basis. Blank = no interest income is modelled.",
            changed: changedFields.intYieldPct,
          })}
        </div>
        {(parseMoney(taxableExclude) ?? 0) > 0 && !balanceOverrides.taxable && (
          <p className="mt-3 text-sm text-[var(--text)]">
            Excluding {fmtCents(parseMoney(taxableExclude) ?? 0)} from the plan — the
            taxable pool the plan prices is{" "}
            {fmtCents(
              Math.max(
                0,
                (parseMoney(taxableBal) ?? 0) -
                  Math.max(0, parseMoney(taxableExclude) ?? 0),
              ),
            )}
            . Net Worth still shows the full pool. This applies only in the
            Tax Plan view — Net Worth, Retirement, and the other views
            are unaffected.
          </p>
        )}
        {(parseMoney(taxableExclude) ?? 0) > 0 && balanceOverrides.taxable && (
          <p className="mt-3 text-sm text-[var(--text)]">
            A saved Taxable balance is in force, so the exclusion does not
            apply — it applies only while the Taxable balance follows Net
            Worth.
          </p>
        )}
        {basisTiers.length === 0 ? (
          <div className="mt-4">
            <button
              type="button"
              className="px-1 py-1 text-xs text-[var(--dim)] underline underline-offset-2 hover:text-[var(--accent)]"
              onClick={() =>
                setBasisTiers((rows) => [...rows, { share: "", basis: "" }])
              }
            >
              Split the taxable pool into basis tiers
            </button>
            <span className="ml-2 text-xs text-[var(--dim)]">
              Optional — the pool otherwise prices as one pool at the basis % above.
            </span>
          </div>
        ) : (
        <div className="mt-4">
          <span className={labelCls}>Taxable basis tiers{changedFields.basisTiers && <ChangedMark />}</span>
          <p className={hintCls}>
            Optional: split the taxable pool (the Taxable balance, cash
            included) into lots — each lot&rsquo;s share of the pool and that
            lot&rsquo;s basis %. When a split is entered it replaces the basis
            % above as the pool&rsquo;s basis, and sales from Taxable sell the
            highest-basis lot first, so spending draws and tax payments
            realize the least gain. Money saved into Taxable later lands at
            100% basis. Blank (no rows) = one pool at the basis % above.
          </p>
          {basisTiers.map((row, i) => (
            <div key={i} className="mt-2 flex items-end gap-2">
              <div className="flex-1">
                {pctField(`Tier ${i + 1} share of taxable`, row.share, (v) =>
                  setBasisTiers((rows) =>
                    rows.map((r, j) => (j === i ? { ...r, share: v } : r)),
                  ),
                )}
              </div>
              <div className="flex-1">
                {pctField(`Tier ${i + 1} basis`, row.basis, (v) =>
                  setBasisTiers((rows) =>
                    rows.map((r, j) => (j === i ? { ...r, basis: v } : r)),
                  ),
                )}
              </div>
              <button
                type="button"
                aria-label={`Remove tier ${i + 1}`}
                className="px-2 py-2 text-base text-[var(--dim)] hover:text-[var(--bad)]"
                onClick={() =>
                  setBasisTiers((rows) => rows.filter((_, j) => j !== i))
                }
              >
                ✕
              </button>
            </div>
          ))}
          {basisTiers.length < 6 && (
            <button
              type="button"
              className="mt-2 px-1 py-1 text-xs text-[var(--dim)] underline underline-offset-2 hover:text-[var(--accent)]"
              onClick={() =>
                setBasisTiers((rows) => [...rows, { share: "", basis: "" }])
              }
            >
              Add a tier
            </button>
          )}
          {basisTiers.length > 0 && tiersFromRows(basisTiers) == null && (
            <p className="mt-2 text-sm text-[var(--bad)]">
              {basisTiers.some(
                (r) => parseNum(r.share) == null || parseNum(r.basis) == null,
              )
                ? "Fill in both numbers on every tier row. Until every row is complete and the shares add to 100%, the plan prices as one pool at the basis % above."
                : `The shares add to ${
                    Math.round(
                      basisTiers.reduce(
                        (s, r) => s + (parseNum(r.share) ?? 0),
                        0,
                      ) * 100,
                    ) / 100
                  }% — they must add to 100% for the tiers to apply. Until they do, the plan prices as one pool at the basis % above.`}
            </p>
          )}
        </div>
        )}
        <p className="mt-3 text-sm text-[var(--dim)]">
          Each pre-tax balance prices on its owner&rsquo;s clock: your RMDs use
          the Joint Life table while both spouses are alive (spouse sole
          beneficiary, 10+ years younger); your spouse&rsquo;s use the Uniform
          Lifetime table from their own RMD age. Conversions draw your balance
          first. Otherwise the two balances act as one pot for spending, tax, and
          growth. From Net Worth, the Pre-tax bucket lands in your field unless
          the spouse field splits it, in which case the bucket remainder (bucket
          minus theirs, never below $0) lands in yours.
        </p>
        <p className="mt-3 text-sm text-[var(--dim)]">{balanceSourceNote}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {!confirmResetBalances ? (
            <>
              <button
                type="button"
                aria-label="Reset balances to Net Worth"
                className="px-1 py-2 text-xs text-[var(--dim)] underline underline-offset-2 hover:text-[var(--accent)] disabled:opacity-50"
                disabled={!init}
                onClick={() => setConfirmResetBalances(true)}
              >
                Reset balances to Net Worth
              </button>
              <span className="text-xs text-[var(--dim)]">
                Clears saved balances so they follow Net Worth again — no other input
                changes.
              </span>
            </>
          ) : (
            <>
              <span className="text-sm text-[var(--bad)]">Reset balances to Net Worth? This clears your saved Pre-tax (both spouses&rsquo; fields), Roth, Taxable, and HSA balances so they follow Net Worth again.</span>
              <button
                type="button"
                aria-label="Reset balances to Net Worth"
                className="rounded-[var(--radius)] bg-[var(--bad)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                disabled={!init}
                onClick={resetBalancesToNetWorth}
              >
                Reset balances to Net Worth
              </button>
              <button
                type="button"
                aria-label="Cancel reset balances"
                className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium text-[var(--text)]"
                onClick={() => setConfirmResetBalances(false)}
              >
                Cancel
              </button>
            </>
          )}
        </div>
        </>
      ), planTotalHeader)}

      {rothSection("household", "Spending & timing", householdSummary + drawOrderSwitchSummary + (sectionChangedCount(["filingStatus", "birthYearP", "birthYearS", "retirementAge", "endAge", "winStart", "winStop", "convertedAlready", "collegeFromYear", "collegeThroughYear", "soleBeneficiary", "primarySoleBeneficiaryOfSpouse", "survivorOn", "survivorWho", "survivorDeathYear", "spending", "payTaxFrom", "protectMin", "preservePretax", "preserveExitRate", "drawOrder", "drawOrderSwitchAge", "drawOrderAfter"]) > 0 ? ` · ${sectionChangedCount(["filingStatus", "birthYearP", "birthYearS", "retirementAge", "endAge", "winStart", "winStop", "convertedAlready", "collegeFromYear", "collegeThroughYear", "soleBeneficiary", "primarySoleBeneficiaryOfSpouse", "survivorOn", "survivorWho", "survivorDeathYear", "spending", "payTaxFrom", "protectMin", "preservePretax", "preserveExitRate", "drawOrder", "drawOrderSwitchAge", "drawOrderAfter"])} changed` : ""), (
        <>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <label className={labelCls} htmlFor="roth-filing">
              Filing status
              {changedFields.filingStatus && <ChangedMark />}
            </label>
            <select
              id="roth-filing"
              aria-label="Filing status"
              className={inputCls}
              value={filingStatus}
              onChange={(e) => setFilingStatus(e.target.value as FilingStatus)}
            >
              {(Object.keys(FILING_LABELS) as FilingStatus[]).map((k) => (
                <option key={k} value={k}>
                  {FILING_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
          {numField("Your birth year", birthYearP, setBirthYearP, { changed: changedFields.birthYearP })}
          {filingStatus !== "single" &&
            numField("Spouse birth year", birthYearS, setBirthYearS, { changed: changedFields.birthYearS })}
          {numField("Retirement age", retirementAge, setRetirementAge, { changed: changedFields.retirementAge })}
          {numField("Plan end age", endAge, setEndAge, {
            hint: "Your age in the final year priced.",
            changed: changedFields.endAge,
          })}
          {numField("Convert from age", winStart, setWinStart, { changed: changedFields.winStart })}
          {numField("Convert until age", winStop, setWinStop, {
            hint: `RMDs begin at ${parseIntField(birthYearP) != null ? rmdAgeForBirthYear(parseIntField(birthYearP)!) : 75} for the birth year entered, so the seeded window stops the year before.`,
            changed: changedFields.winStop,
          })}
          {moneyField("Already converted this year", convertedAlready, setConvertedAlready, {
            hint: "Already converted some this calendar year? Enter it — the first year's fill tops it up instead of starting over.",
            changed: changedFields.convertedAlready,
          })}
          {moneyField("Annual spending", spending, setSpending, {
            hint: "Seeded from the Retirement calculator's spending figure.",
            changed: changedFields.spending,
          })}
          {numField("College years — first fall (optional)", collegeFromYear, setCollegeFromYear, { changed: changedFields.collegeFromYear })}
          {numField("College years — last fall (optional)", collegeThroughYear, setCollegeThroughYear, {
            hint: "Fall years college starts and ends (a Sep-2027 start is fall 2027; 4 years = falls 2027–2030). Drives only the FAFSA watch-out — a conversion counts as FAFSA income two years later. Leave blank if no college in the household.",
            changed: changedFields.collegeThroughYear,
          })}
          {filingStatus !== "single" && (
          <div className="col-span-2 flex items-start gap-2 pt-6 sm:col-span-2">
            <input
              id="roth-sole"
              type="checkbox"
              aria-label="Spouse is sole beneficiary of the pre-tax accounts"
              className="mt-1 h-4 w-4"
              checked={soleBeneficiary}
              onChange={(e) => setSoleBeneficiary(e.target.checked)}
            />
            <label htmlFor="roth-sole" className="text-sm">
              Spouse is sole beneficiary of the pre-tax accounts — with a spouse more
              than 10 years younger, RMDs use the Joint Life table — larger divisors,
              smaller RMDs.
              {changedFields.soleBeneficiary && <ChangedMark />}
            </label>
          </div>
          )}
          {filingStatus !== "single" && (
          <div className="col-span-2 flex items-start gap-2 sm:col-span-2">
            <input
              id="roth-sole-spouse"
              type="checkbox"
              aria-label="You are the sole beneficiary of your spouse's pre-tax accounts"
              className="mt-1 h-4 w-4"
              checked={primarySoleBeneficiaryOfSpouse}
              onChange={(e) =>
                setPrimarySoleBeneficiaryOfSpouse(e.target.checked)
              }
            />
            <label htmlFor="roth-sole-spouse" className="text-sm">
              You are the sole beneficiary of your spouse’s pre-tax accounts — a
              separate fact from the one above: it selects your spouse’s RMD table
              only. With you more than 10 years younger, her RMDs use the Joint Life
              table. Left unchecked, her RMDs use the Uniform table.
              {changedFields.primarySoleBeneficiaryOfSpouse && <ChangedMark />}
            </label>
          </div>
          )}
          <div className="col-span-2 border-t border-[var(--border)] pt-3 sm:col-span-4">
            <div className="flex items-start gap-2">
              <input
                id="roth-survivor"
                type="checkbox"
                aria-label="Model one spouse dying"
                className="mt-1 h-4 w-4"
                checked={survivorOn}
                onChange={(e) => setSurvivorOn(e.target.checked)}
              />
              <label htmlFor="roth-survivor" className="text-sm">
                <strong>Model one spouse dying</strong> — the widow&rsquo;s penalty.
                From the year after the death, the survivor files single (single
                brackets, deduction, IRMAA and capital-gains thresholds), keeps only
                the larger Social Security benefit, and inherits the combined pre-tax
                balance on their own RMD clock. The death year still files jointly,
                with both benefits. Off by default.
                {changedFields.survivorOn && <ChangedMark />}
              </label>
            </div>
            {survivorOn && (
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div>
                  <label className={labelCls} htmlFor="roth-survivor-who">
                    Who dies
                    {changedFields.survivorWho && <ChangedMark />}
                  </label>
                  <select
                    id="roth-survivor-who"
                    aria-label="Who dies"
                    className={inputCls}
                    value={survivorWho}
                    onChange={(e) =>
                      setSurvivorWho(e.target.value as "primary" | "spouse")
                    }
                  >
                    <option value="primary">You</option>
                    <option value="spouse">Spouse</option>
                  </select>
                </div>
                {numField("Year of death (calendar year)", survivorDeathYear, setSurvivorDeathYear, {
                  hint:
                    parseIntField(birthYearP) != null && parseIntField(survivorDeathYear) != null
                      ? `You would be ${parseIntField(survivorDeathYear)! - parseIntField(birthYearP)!} that year${parseIntField(birthYearS) != null ? `, your spouse ${parseIntField(survivorDeathYear)! - parseIntField(birthYearS)!}` : ""}. The scenario prices only when a year is entered.`
                      : "Entered as a calendar year. The scenario prices only when a year is entered.",
                  changed: changedFields.survivorDeathYear,
                })}
              </div>
            )}
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div>
              <label className={labelCls} htmlFor="roth-payfrom">
                Pay conversion tax from
                {changedFields.payTaxFrom && <ChangedMark />}
              </label>
              <select
                id="roth-payfrom"
                aria-label="Pay conversion tax from"
                className={inputCls}
                value={payTaxFrom}
                onChange={(e) => setPayTaxFrom(e.target.value as "taxable" | "conversion")}
              >
                <option value="taxable">Taxable account</option>
                <option value="conversion">Withheld from the conversion</option>
              </select>
              <p className={hintCls}>
                Withholding before 59½ carries a 10% early-distribution penalty on the
                amount withheld — the plan prices it.
              </p>
            </div>
            {moneyField("Protect-minimum taxable", protectMin, setProtectMin, {
              hint: "When tax is paid from Taxable, the sale for the year's tax bill stops at this much left in Taxable. Not a guaranteed minimum: spending draws and any tax the conversion can't absorb can still take Taxable below it, and sales sell the highest-basis money (cash) first — it does not set cash aside.",
              changed: changedFields.protectMin,
            })}
            {moneyField("Pre-tax to preserve (never convert)", preservePretax, setPreservePretax, {
              hint: "Conversions stop at this combined pre-tax balance. RMDs and spending still draw from it, and growth above it stays convertible. Blank = no reserve.",
              changed: changedFields.preservePretax,
            })}
            {pctField("Expected tax on the preserved amount", preserveExitRate, setPreserveExitRate, {
              hint: "The rate the preserved amount is expected to leave at — 0% if it is earmarked for charity or deductible medical costs. Blank = the heir rate.",
              changed: changedFields.preserveExitRate,
            })}
            <div>
              <label className={labelCls} htmlFor="roth-draworder">
                Spending draw order
                {changedFields.drawOrder && <ChangedMark />}
              </label>
              <select
                id="roth-draworder"
                aria-label="Spending draw order"
                className={inputCls}
                value={drawOrder}
                onChange={(e) => setDrawOrder(e.target.value)}
              >
                {DRAW_ORDER_OPTIONS.map((o) => (
                  <option key={o.key} value={o.key}>
                    {drawOrderLabel(o.order)}
                  </option>
                ))}
              </select>
              <p className={hintCls}>
                Spending draws only: after each year&rsquo;s RMD (always first, from
                Pre-tax), spending comes from the buckets in this order. Conversion
                tax still follows &lsquo;Pay conversion tax from&rsquo; and the
                protect-minimum.
              </p>
            </div>
            {numField("Switch draw order at age", drawOrderSwitchAge, setDrawOrderSwitchAge, {
              info: "From the year you reach this age, spending draws follow the second order below instead of the order above. The switch year itself already uses the new order. Leave the age blank for no switch — one order at every age.",
              hint: "Blank = no switch. The order below applies only while an age is entered here.",
              changed: changedFields.drawOrderSwitchAge,
            })}
            {parseIntField(drawOrderSwitchAge) != null && (
            <div>
              <label className={labelCls} htmlFor="roth-draworder-after">
                Draw order after the switch
                {changedFields.drawOrderAfter && <ChangedMark />}
              </label>
              <select
                id="roth-draworder-after"
                aria-label="Draw order after the switch"
                className={inputCls}
                value={drawOrderAfter}
                onChange={(e) => setDrawOrderAfter(e.target.value)}
              >
                {DRAW_ORDER_OPTIONS.map((o) => (
                  <option key={o.key} value={o.key}>
                    {drawOrderLabel(o.order)}
                  </option>
                ))}
              </select>
              <p className={hintCls}>
                Takes over from the switch age onward. It has no effect while the
                switch age above is blank.
              </p>
            </div>
            )}
          </div>
        </>
      ))}

      {rothSection("income", "Social Security", incomeSummary + (sectionChangedCount(["ssP", "ssPAge", "ssS", "ssSAge", "claimAgeFloor"]) > 0 ? ` · ${sectionChangedCount(["ssP", "ssPAge", "ssS", "ssSAge", "claimAgeFloor"])} changed` : ""), (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="col-span-2">
            <div className="grid grid-cols-2 gap-3">
              {moneyField("Your Social Security / yr", ssP, handleSsPChange, {
                disabled: ssPrimaryNoBenefit,
                hint: ssPrimaryNoBenefit
                  ? undefined
                  : "Your ssa.gov annual figure. Needs a start age too — with the age blank, $0 is priced.",
                changed: changedFields.ssP,
              })}
              {numField("Your SS start age", ssPAge, setSsPAge, {
                disabled: ssPrimaryNoBenefit,
                changed: changedFields.ssPAge,
              })}
            </div>
            <div className="mt-2 flex items-start gap-2">
              <input
                id="roth-ss-primary-no-benefit"
                type="checkbox"
                aria-label="Your Social Security — No benefit"
                className="mt-1 h-4 w-4 shrink-0"
                checked={ssPrimaryNoBenefit}
                onChange={(e) => handlePrimaryNoBenefit(e.target.checked)}
              />
              <label htmlFor="roth-ss-primary-no-benefit" className="text-sm">
                No benefit — this person has no Social Security benefit
              </label>
            </div>
            {ssPrimaryNoBenefit && (
              <p className="mt-1 text-xs text-[var(--dim)]">
                Marked as no benefit — a finished answer, priced as $0. Uncheck to enter an amount instead.
              </p>
            )}
          </div>
          {filingStatus !== "single" && (
          <div className="col-span-2">
            <div className="grid grid-cols-2 gap-3">
              {moneyField("Spouse Social Security / yr", ssS, handleSsSChange, {
                disabled: ssSpouseNoBenefit,
                hint: ssSpouseNoBenefit
                  ? undefined
                  : "Blank = $0 priced until you enter an ssa.gov figure. Needs a start age too — with the age blank, $0 is priced.",
                changed: changedFields.ssS,
              })}
              {numField("Spouse SS start age", ssSAge, setSsSAge, {
                disabled: ssSpouseNoBenefit,
                changed: changedFields.ssSAge,
              })}
            </div>
            <div className="mt-2 flex items-start gap-2">
              <input
                id="roth-ss-spouse-no-benefit"
                type="checkbox"
                aria-label="Spouse Social Security — No benefit"
                className="mt-1 h-4 w-4 shrink-0"
                checked={ssSpouseNoBenefit}
                onChange={(e) => handleSpouseNoBenefit(e.target.checked)}
              />
              <label htmlFor="roth-ss-spouse-no-benefit" className="text-sm">
                No benefit — this person has no Social Security benefit
              </label>
            </div>
            {ssSpouseNoBenefit && (
              <p className="mt-1 text-xs text-[var(--dim)]">
                Marked as no benefit — a finished answer, priced as $0. Uncheck to enter an amount instead.
              </p>
            )}
          </div>
          )}
          {numField("Earliest claiming age to consider", claimAgeFloor, setClaimAgeFloor, {
            hint: "For the optimizer: the winning strategy must claim Social Security at this age or later (62–70). Younger ages are still priced and shown in the results, marked as below this floor. Blank = no floor.",
            changed: changedFields.claimAgeFloor,
          })}
        </div>
      ))}

      {rothSection("aca", "Taxes & ACA", acaSummary + (sectionChangedCount(["acaSize", "acaSteps", "benchCouple", "benchSingle", "benchFamily", "acaSpouseEndAge", "otherOrd", "taxExempt", "taxReturnInterest", "taxReturnQualDiv", "taxReturnOrdDiv"]) > 0 ? ` · ${sectionChangedCount(["acaSize", "acaSteps", "benchCouple", "benchSingle", "benchFamily", "acaSpouseEndAge", "otherOrd", "taxExempt", "taxReturnInterest", "taxReturnQualDiv", "taxReturnOrdDiv"])} changed` : ""), (
        <>
          <p className="text-sm text-[var(--dim)]">
            From the retirement year, while anyone in the household is under 65, the household is priced as on the marketplace, and ACA MAGI sets the premium credit. Above 400% of the poverty line the credit is $0 — the whole year's credit is lost.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {numField("Household size", acaSize, setAcaSize, { changed: changedFields.acaSize })}
            <div className="col-span-2 sm:col-span-3">
              <span className={labelCls}>Household steps{changedFields.acaSteps && <ChangedMark />}</span>
              <p className={hintCls}>
                Optional: one row per change in the household size — the year
                the size changes (e.g. when a dependent leaves the return) and
                the size from that year on. Each year&rsquo;s poverty-line
                cliff and benchmark follow the size in force that year. Leave
                empty for no steps — the household size above then applies to
                every year.
              </p>
              {acaSteps.map((row, i) => (
                <div key={i} className="mt-2 flex flex-wrap items-end gap-2">
                  <div className="w-32">
                    {numField(`Step ${i + 1} from year`, row.fromYear, (v) =>
                      setAcaSteps((rows) =>
                        rows.map((r, j) => (j === i ? { ...r, fromYear: v } : r)),
                      ),
                    )}
                  </div>
                  <div className="w-32">
                    {numField(`Step ${i + 1} household size`, row.householdSize, (v) =>
                      setAcaSteps((rows) =>
                        rows.map((r, j) => (j === i ? { ...r, householdSize: v } : r)),
                      ),
                    )}
                  </div>
                  <button
                    type="button"
                    aria-label={`Remove household step ${i + 1}`}
                    className="px-2 py-2 text-base text-[var(--dim)] hover:text-[var(--bad)]"
                    onClick={() =>
                      setAcaSteps((rows) => rows.filter((_, j) => j !== i))
                    }
                  >
                    ✕
                  </button>
                </div>
              ))}
              {acaSteps.length < 40 && (
                <button
                  type="button"
                  className="mt-2 px-1 py-1 text-xs text-[var(--dim)] underline underline-offset-2 hover:text-[var(--accent)]"
                  onClick={() =>
                    setAcaSteps((rows) => [
                      ...rows,
                      { fromYear: "", householdSize: "" },
                    ])
                  }
                >
                  Add a step
                </button>
              )}
              {acaSteps.length > 0 && acaStepsFromRows(acaSteps) == null && (
                <p className="mt-2 text-sm text-[var(--bad)]">
                  Fill in the year and the household size on every step row.
                  Until every row is complete, no steps apply.
                </p>
              )}
            </div>
            {moneyField("ACA benchmark premium — couple / yr", benchCouple, setBenchCouple, {
              hint: "Second-lowest-cost Silver for the years you are both on the marketplace. Blank = the credit is not priced yet.",
              changed: changedFields.benchCouple,
            })}
            {filingStatus !== "single" &&
              moneyField("ACA benchmark premium — one spouse / yr", benchSingle, setBenchSingle, {
                hint: "For the years only one spouse is on the marketplace (after the other turns 65). Blank = the credit is not priced yet.",
                changed: changedFields.benchSingle,
              })}
            {(parseIntField(acaSize) ?? 0) >= 3 &&
              moneyField("ACA benchmark premium — family / yr", benchFamily, setBenchFamily, {
                info: "The 2nd-lowest-cost Silver premium for a household of 3 or more. It is used for the years you are both on the marketplace in a household of 3 or more; years with only one spouse on the marketplace use the one-spouse figure. If left blank, the couple figure is used for those years instead.",
                hint: "For the years you are both on the marketplace and the household is 3 or more. Blank = the couple figure is used for those years instead.",
                changed: changedFields.benchFamily,
              })}
            {filingStatus !== "single" &&
              numField("Spouse stays on the marketplace until age", acaSpouseEndAge, setAcaSpouseEndAge, {
                info: "The age your spouse leaves the marketplace for Medicare. Blank = 65. Set it higher to model her staying on marketplace coverage longer — her premium credit and the 400% cliff keep applying in those years.",
                hint: "Blank = 65.",
                changed: changedFields.acaSpouseEndAge,
              })}
            {moneyField("Other ordinary income / yr", otherOrd, setOtherOrd, {
              changed: changedFields.otherOrd,
            })}
            {moneyField("Tax-exempt interest / yr", taxExempt, setTaxExempt, {
              hint: "Counts toward provisional income and MAGI, though it is not itself taxed.",
              changed: changedFields.taxExempt,
            })}
            {moneyField("Taxable interest — Form 1040 line 2b", taxReturnInterest, setTaxReturnInterest, {
              hint: "From your most recent tax return. Prefill only — see the note below.",
              changed: changedFields.taxReturnInterest,
            })}
            {moneyField("Qualified dividends — Form 1040 line 3a", taxReturnQualDiv, setTaxReturnQualDiv, {
              hint: "From your most recent tax return. Prefill only — see the note below.",
              changed: changedFields.taxReturnQualDiv,
            })}
            {moneyField("Ordinary dividends — Form 1040 line 3b", taxReturnOrdDiv, setTaxReturnOrdDiv, {
              hint: "The total, including the line 3a qualified part. Prefill only — see the note below.",
              changed: changedFields.taxReturnOrdDiv,
            })}
          </div>
          <p className="mt-3 text-xs text-[var(--dim)]">
            The three Form 1040 lines above are your most recent tax return&rsquo;s
            actuals. They are used for one thing only: the Playground&rsquo;s
            &ldquo;Start from my numbers&rdquo; fills its Interest and Dividends
            fields from them. This plan does not price them — it models interest
            and dividends from the yield fields under Your money.
          </p>
          {acaSteps.length === 0 && (
            <p className={hintCls}>
              No household steps are set, so the household size stays{" "}
              {parseIntField(acaSize) ?? "as entered"} for every year, including the
              spouse-only years. Add a step for when a child leaves the
              tax household.
            </p>
          )}
        </>
      ))}

      {rothSection("advanced", "Advanced", advancedSummary + (sectionChangedCount(["ceilBracket", "ceilIrmaa", "ceilLtcg", "ceilAca", "ceilAcaFamilyOnly", "magiCap", "cliffBuffer", "guardrailOn", "bunchingOn", "gainsHarvestOn", "expectedPct", "inflation", "residenceState", "stateRate", "carryInSt", "carryInLt", "itemizedMortgage", "itemizedSalt", "itemizedCharitable", "itemizedOther", "eduStudents", "heirRate"]) > 0 ? ` · ${sectionChangedCount(["ceilBracket", "ceilIrmaa", "ceilLtcg", "ceilAca", "ceilAcaFamilyOnly", "magiCap", "cliffBuffer", "guardrailOn", "bunchingOn", "gainsHarvestOn", "expectedPct", "inflation", "residenceState", "stateRate", "carryInSt", "carryInLt", "itemizedMortgage", "itemizedSalt", "itemizedCharitable", "itemizedOther", "eduStudents", "heirRate"])} changed` : ""), (
        <>
          <p className="text-sm text-[var(--dim)]">
            Each year in the window, the plan converts just enough to reach the{" "}
            <strong>tightest</strong> ceiling switched on — checked in $100 steps against
            the Social Security formula, because each converted dollar can pull $0.85 of
            benefits into taxable income.
          </p>
          <div className="mt-4">
            <span className={labelCls}>Conversion ceiling</span>
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-label="Conversion ceiling presets"
            >
              {CEILING_PRESETS.map((p) => {
                const active = activeCeilingPreset?.name === p.name;
                return (
                  <button
                    key={p.name}
                    type="button"
                    aria-pressed={active}
                    onClick={() => applyCeilingPreset(p.fields)}
                    className={active ? ceilChipActiveCls : ceilChipCls}
                  >
                    {p.name}
                  </button>
                );
              })}
              {activeCeilingPreset == null && (
                <span className={ceilChipActiveCls}>Custom</span>
              )}
              <button
                type="button"
                aria-expanded={ceilCustomOpen}
                aria-controls="roth-ceil-custom"
                onClick={() => {
                  const next = !ceilCustomOpen;
                  setCeilCustomOpen(next);
                  saveUiState.mutate({ ceilCustomOpen: next });
                }}
                className={ceilChipCls}
              >
                Custom…
              </button>
            </div>
          </div>
          {ceilCustomOpen && (
          <div id="roth-ceil-custom" className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <label className={labelCls} htmlFor="roth-ceil-bracket">
                Fill to top of bracket
                {changedFields.ceilBracket && <ChangedMark />}
              </label>
              <select
                id="roth-ceil-bracket"
                aria-label="Fill to top of bracket"
                className={inputCls}
                value={ceilBracket}
                onChange={(e) => setCeilBracket(e.target.value as typeof ceilBracket)}
              >
                <option value="">Off</option>
                <option value="10">10%</option>
                <option value="12">12%</option>
                <option value="22">22%</option>
                <option value="24">24%</option>
              </select>
            </div>
            <div>
              <label className={labelCls} htmlFor="roth-ceil-irmaa">
                Cap MAGI at IRMAA tier
                {changedFields.ceilIrmaa && <ChangedMark />}
              </label>
              <select
                id="roth-ceil-irmaa"
                aria-label="Cap MAGI at IRMAA tier"
                className={inputCls}
                value={ceilIrmaa}
                onChange={(e) => setCeilIrmaa(e.target.value as typeof ceilIrmaa)}
              >
                <option value="">Off</option>
                <option value="0">Tier 0 (no surcharge)</option>
                <option value="1">Tier 1</option>
                <option value="2">Tier 2</option>
                <option value="3">Tier 3</option>
                <option value="4">Tier 4</option>
                <option value="5">Tier 5</option>
              </select>
            </div>
            <div className="flex items-start gap-2 pt-7">
              <input
                id="roth-ceil-ltcg"
                type="checkbox"
                aria-label="Cap at the top of the 0 percent capital gains space"
                className="mt-1 h-4 w-4"
                checked={ceilLtcg}
                onChange={(e) => setCeilLtcg(e.target.checked)}
              />
              <label htmlFor="roth-ceil-ltcg" className="text-sm">
                Stay inside the 0% capital-gains space
                {changedFields.ceilLtcg && <ChangedMark />}
              </label>
            </div>
            <div className="flex items-start gap-2 pt-7">
              <input
                id="roth-ceil-aca"
                type="checkbox"
                aria-label="Cap at the ACA cliff, 400 percent of the poverty line"
                className="mt-1 h-4 w-4"
                checked={ceilAca}
                onChange={(e) => setCeilAca(e.target.checked)}
              />
              <label htmlFor="roth-ceil-aca" className="text-sm">
                Stay at or under 400% FPL (keep the ACA credit)
                {changedFields.ceilAca && <ChangedMark />}
              </label>
            </div>
            {ceilAca && (
            <div className="flex items-start gap-2 pt-7">
              <input
                id="roth-ceil-aca-family-only"
                type="checkbox"
                aria-label="Only until the household steps down"
                className="mt-1 h-4 w-4"
                checked={ceilAcaFamilyOnly}
                onChange={(e) => setCeilAcaFamilyOnly(e.target.checked)}
              />
              <label htmlFor="roth-ceil-aca-family-only" className="text-sm">
                Only until the household steps down — after the first
                step year in the household schedule the plan stops
                defending the cliff and those years price undefended.
                The credit in those years is still worked out on the
                year&rsquo;s governing household size.
                {changedFields.ceilAcaFamilyOnly && <ChangedMark />}
              </label>
            </div>
            )}
            {ceilAca &&
              moneyField("Cliff safety buffer", cliffBuffer, setCliffBuffer, {
                hint: "Aim this far below the cliff, so a late-year surprise — a December fund payout, a bigger dividend than expected — can't push income $1 over the line and wipe out the whole year's credit. Blank = aim at the cliff itself.",
                changed: changedFields.cliffBuffer,
              })}
            {moneyField("Custom MAGI cap", magiCap, setMagiCap, {
              hint: "Blank = no custom cap.",
              changed: changedFields.magiCap,
            })}
          </div>
          )}
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {ceilBracket !== "" && (
            <div className="flex items-start gap-2 pt-7">
              <input
                id="roth-guardrail"
                type="checkbox"
                aria-label="Marginal-rate guardrail"
                className="mt-1 h-4 w-4"
                checked={guardrailOn ?? false}
                onChange={(e) => setGuardrailOn(e.target.checked)}
              />
              <label htmlFor="roth-guardrail" className="text-sm">
                Marginal-rate guardrail — stop each year's fill at the first $100 step
                taxed above the bracket rate (pauses in the Social Security torpedo
                zone; resumes once benefits are fully taxed). Needs a bracket ceiling.
                {changedFields.guardrailOn && <ChangedMark />}
              </label>
            </div>
            )}
            <div className="flex items-start gap-2 pt-7">
              <input
                id="roth-bunching"
                type="checkbox"
                aria-label="ACA bunching"
                className="mt-1 h-4 w-4"
                checked={bunchingOn ?? false}
                onChange={(e) => setBunchingOn(e.target.checked)}
              />
              <label htmlFor="roth-bunching" className="text-sm">
                ACA bunching — in marketplace years, alternate a big conversion year
                with a $0 year: the big year gives up that year's premium credit so
                the $0 year keeps it in full.
                {changedFields.bunchingOn && <ChangedMark />}
              </label>
            </div>
            <div className="flex items-start gap-2 pt-7">
              <input
                id="roth-gains-harvest"
                type="checkbox"
                aria-label="Harvest gains into the 0 percent bracket each year"
                className="mt-1 h-4 w-4"
                checked={gainsHarvestOn ?? false}
                onChange={(e) => setGainsHarvestOn(e.target.checked)}
              />
              <label htmlFor="roth-gains-harvest" className="text-sm">
                Harvest gains into the 0% bracket each year
                {changedFields.gainsHarvestOn && <ChangedMark />}
              </label>
              <InfoNote
                text="Sell and rebuy investments to use up the year's 0% capital-gains space, raising their cost basis so the gain is never taxed. Stops at the ACA cliff when the cliff cap is on."
                ariaLabel="About gain harvesting"
              />
            </div>
            {pctField("Expected return", expectedPct, setExpectedPct, {
              hint: "One blended real return for every bucket, from the Retirement calculator. A single steady path — no market ups and downs.",
              changed: changedFields.expectedPct,
            })}
            {pctField("Inflation", inflation, setInflation, {
              hint: "Figures the law does not index (Social Security thresholds, NIIT) shrink by this rate each year in today's dollars; indexed figures stay constant. The top IRMAA tier is frozen only until 2028.",
              changed: changedFields.inflation,
            })}
            <div>
              <label className={labelCls} htmlFor="roth-residence-state">
                State of residence
                {changedFields.residenceState && <ChangedMark />}
              </label>
              <select
                id="roth-residence-state"
                aria-label="State of residence"
                className={inputCls}
                value={residenceState}
                onChange={(e) =>
                  setResidenceState(e.target.value === "WA" ? "WA" : "other")
                }
              >
                <option value="WA">Washington — capital-gains excise</option>
                <option value="other">Other / none — flat rate below</option>
              </select>
              <p className={hintCls}>
                Washington prices the state tax under its capital-gains
                excise (on long-term gains above the state&rsquo;s standard
                deduction) instead of the flat rate. Any other state uses
                the flat rate.
              </p>
            </div>
            {pctField("State tax rate", stateRate, setStateRate, {
              hint:
                residenceState === "WA"
                  ? "Ignored for Washington — the excise prices the state tax instead."
                  : "One flat rate on taxable income.",
              changed: changedFields.stateRate,
            })}
            {moneyField("Capital-loss carryforward — short-term", carryInSt, setCarryInSt, {
              hint: "Unused net short-term capital losses banked before the plan starts. They offset later gains first, then up to $3,000 a year against other income, and keep carrying forward. Blank = none.",
              changed: changedFields.carryInSt,
            })}
            {moneyField("Capital-loss carryforward — long-term", carryInLt, setCarryInLt, {
              hint: "Unused net long-term capital losses banked before the plan starts. Short-term and long-term are tracked separately, the way the IRS worksheet does it. Blank = none.",
              changed: changedFields.carryInLt,
            })}
            {moneyField("Mortgage interest", itemizedMortgage, setItemizedMortgage, {
              hint: "Itemized deductions: the household's annual mortgage interest. Each priced year takes the greater of the itemized total and that year's standard deduction. Blank = $0.",
              changed: changedFields.itemizedMortgage,
            })}
            {moneyField("State and local taxes paid", itemizedSalt, setItemizedSalt, {
              hint: "Itemized deductions: state and local taxes PAID for the year (property tax, state income or sales tax). This component is capped on its own at the year's SALT cap ($40,000 in the 2025 table, $40,400 in the 2026 table, reduced for very high incomes) before the itemized total is compared with the standard deduction. Blank = $0.",
              changed: changedFields.itemizedSalt,
            })}
            {moneyField("Charitable contributions", itemizedCharitable, setItemizedCharitable, {
              hint: "Itemized deductions: charitable contributions for the year. This same figure is the one charitable input the Washington capital-gains layer also reads for its charitable deduction — there is no second charitable figure. Blank = $0.",
              changed: changedFields.itemizedCharitable,
            })}
            {moneyField("Other itemized deductions", itemizedOther, setItemizedOther, {
              hint: "Itemized deductions: any other itemized amounts not covered by the three fields above. The four components stay separate so the SALT cap applies to that component alone. Blank = $0.",
              changed: changedFields.itemizedOther,
            })}
            {eduStudents.length === 0 ? (
            <div className="col-span-2 sm:col-span-4">
              <span className={labelCls}>Education expenses — for education credits</span>
              <p className={hintCls}>
                No students entered — no education credits price. Expenses are
                never guessed from 529 balances or the college years.
              </p>
              <button
                type="button"
                className="mt-2 px-1 py-1 text-xs text-[var(--dim)] underline underline-offset-2 hover:text-[var(--accent)]"
                onClick={() =>
                  setEduStudents((rows) => [
                    ...rows,
                    { year: "", expenses: "", aotcEligible: true },
                  ])
                }
              >
                Add a student
              </button>
            </div>
            ) : (
            <div className="col-span-2 sm:col-span-4">
              <span className={labelCls}>Education expenses — for education credits{changedFields.eduStudents && <ChangedMark />}</span>
              <p className={hintCls}>
                Optional: one row per student per year — that student&rsquo;s
                qualified education expenses for that calendar year, and
                whether the student is eligible for the American Opportunity
                Credit (AOTC). The AOTC prices per student (100% of the first
                $2,000 plus 25% of the next $2,000 — up to $2,500 each, 40% of
                it refundable); expenses of students not marked AOTC-eligible
                price the Lifetime Learning Credit instead (20% of up to
                $10,000 per return), and the same student&rsquo;s expenses
                never count toward both. Both credits phase out as income
                runs from $160,000 to $180,000 (married filing jointly;
                $80,000–$90,000 otherwise). Leave empty for no credits —
                expenses are never guessed from 529 balances or the college
                years above.
              </p>
              {eduStudents.map((row, i) => (
                <div key={i} className="mt-2 flex flex-wrap items-end gap-2">
                  <div className="w-28">
                    {numField(`Student ${i + 1} year`, row.year, (v) =>
                      setEduStudents((rows) =>
                        rows.map((r, j) => (j === i ? { ...r, year: v } : r)),
                      ),
                    )}
                  </div>
                  <div className="min-w-40 flex-1">
                    {moneyField(`Student ${i + 1} qualified expenses`, row.expenses, (v) =>
                      setEduStudents((rows) =>
                        rows.map((r, j) => (j === i ? { ...r, expenses: v } : r)),
                      ),
                    )}
                  </div>
                  <div className="flex items-center gap-2 pb-2">
                    <input
                      id={`roth-edu-aotc-${i}`}
                      type="checkbox"
                      className="h-4 w-4"
                      checked={row.aotcEligible}
                      onChange={(e) =>
                        setEduStudents((rows) =>
                          rows.map((r, j) =>
                            j === i ? { ...r, aotcEligible: e.target.checked } : r,
                          ),
                        )
                      }
                    />
                    <label htmlFor={`roth-edu-aotc-${i}`} className="text-sm">
                      AOTC-eligible
                    </label>
                  </div>
                  <button
                    type="button"
                    aria-label={`Remove student ${i + 1}`}
                    className="px-2 py-2 text-base text-[var(--dim)] hover:text-[var(--bad)]"
                    onClick={() =>
                      setEduStudents((rows) => rows.filter((_, j) => j !== i))
                    }
                  >
                    ✕
                  </button>
                </div>
              ))}
              {eduStudents.length < 24 && (
                <button
                  type="button"
                  className="mt-2 px-1 py-1 text-xs text-[var(--dim)] underline underline-offset-2 hover:text-[var(--accent)]"
                  onClick={() =>
                    setEduStudents((rows) => [
                      ...rows,
                      { year: "", expenses: "", aotcEligible: true },
                    ])
                  }
                >
                  Add a student
                </button>
              )}
              {eduStudents.length > 0 && studentsFromRows(eduStudents) == null && (
                <p className="mt-2 text-sm text-[var(--bad)]">
                  Fill in the year and the expenses on every student row.
                  Until every row is complete, no education credits price.
                </p>
              )}
            </div>
            )}
            {pctField("Heir rate", heirRate, setHeirRate, {
              hint: "Rate applied to leftover pre-tax money in the ending after-tax wealth figure — heirs are taxed when they withdraw it.",
              changed: changedFields.heirRate,
            })}
          </div>
        </>
      ))}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          aria-label="Save current as scenario"
          className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium text-[var(--text)] hover:text-[var(--accent)] disabled:opacity-50"
          disabled={saveScenario.isPending || (data.scenarios.length >= 50)}
          onClick={() => saveScenario.mutate(buildSavePayload())}
        >
          Save current as scenario
        </button>
        {data.scenarios.length >= 50 && (
          <span className="text-xs text-[var(--dim)]">
            Maximum 50 scenarios saved — delete one in the Strategy Lab workspace to save another.
          </span>
        )}
        <span className="text-xs text-[var(--dim)]" aria-live="polite">
          {save.isPending
            ? "Saving…"
            : init
              ? "Inputs save automatically, and the results below recalculate as you type."
              : ""}
          {!planInputs &&
            " Check the inputs above — the plan needs a birth year, annual spending, a retirement age, an expected return, and an end age after the current age."}
        </span>
      </div>
      {scenarioMsg && (
        <p className="mt-2 text-sm text-[var(--dim)]" aria-live="polite">
          {scenarioMsg}
        </p>
      )}
      {planConflictMsg && (
        <p
          className="mt-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
          role="status"
        >
          {planConflictMsg}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!confirmResetPlan ? (
          <>
            <button
              type="button"
              aria-label="Reset plan to defaults"
              className="px-1 py-2 text-xs text-[var(--dim)] underline underline-offset-2 hover:text-[var(--accent)] disabled:opacity-50"
              disabled={!init || resetPlan.isPending}
              onClick={() => setConfirmResetPlan(true)}
            >
              Reset plan to defaults
            </button>
            <span className="text-xs text-[var(--dim)]">
              Restores every plan input to the seeded defaults — saved strategies are
              kept.
            </span>
          </>
        ) : (
          <>
            <span className="text-sm text-[var(--bad)]">
              Reset plan to defaults? Every plan input returns to the seeded defaults —
              including this year&rsquo;s execution figures, the gift what-if, and the
              Monte Carlo volatility. Your saved strategies are kept.
            </span>
            <button
              type="button"
              aria-label="Reset plan to defaults"
              className="rounded-[var(--radius)] bg-[var(--bad)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              disabled={!init || resetPlan.isPending}
              onClick={doResetPlan}
            >
              {resetPlan.isPending ? "Resetting…" : "Reset plan to defaults"}
            </button>
            <button
              type="button"
              aria-label="Cancel reset plan"
              className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium text-[var(--text)]"
              onClick={() => setConfirmResetPlan(false)}
            >
              Cancel
            </button>
          </>
        )}
      </div>
      {resetPlan.isError && (
        <p className="mt-2 text-sm text-[var(--bad)]" aria-live="polite">
          The reset did not go through — your plan was not changed. Try again.
        </p>
      )}
        </>
      )}

      {face === "plan" && (
        <section className={sectionCls} aria-label="What-if questions">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <button
              type="button"
              aria-expanded={whatIfOpen}
              aria-controls="roth-what-if-panel"
              className="flex flex-1 items-center justify-between gap-3 text-left"
              onClick={() => setWhatIfFolded(whatIfOpen)}
            >
              <span>What if…</span>
              <FoldChevron open={whatIfOpen} />
            </button>
            <InfoNote
              ariaLabel="About what-if questions"
              align="right"
              text="One change at a time, priced from your saved plan through the scenario comparison. Asking a question changes nothing and saves nothing — it just shows how the ending moves."
            />
          </h2>
          {whatIfOpen && (
            <div id="roth-what-if-panel">
          {whatIfDefs.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--dim)]">
              No questions yet — the plan needs a retirement age and yearly
              spending first. Add them under Change the plan.
            </p>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              {whatIfDefs.map((def) => {
                // Lit while its own pricing is in flight, and
                // stays lit while its answer is the one on
                // screen — the answer card names the question
                // in text too, but the eye lands on the button
                // row first.
                const active =
                  pendingWhatIfId === def.id ||
                  (pendingWhatIfId == null &&
                    whatIfResult != null &&
                    whatIfResult.label === def.label);
                return (
                  <button
                    key={def.id}
                    type="button"
                    aria-label={def.label}
                    aria-pressed={active}
                    className={active ? ceilChipActiveCls : ceilChipCls}
                    disabled={runWhatIfMut.isPending}
                    onClick={() => {
                      // Clicking the lit chip again turns the
                      // question off: its answer clears and the
                      // face returns to the saved plan only.
                      // Clicking any other chip prices that one.
                      if (
                        pendingWhatIfId == null &&
                        whatIfResult != null &&
                        whatIfResult.label === def.label
                      ) {
                        clearWhatIf();
                      } else {
                        runWhatIf(def);
                      }
                    }}
                  >
                    {def.label}
                  </button>
                );
              })}
            </div>
          )}
          {runWhatIfMut.isPending && (
            <p className="mt-3 text-sm text-[var(--dim)]" aria-live="polite">
              Pricing that question…
            </p>
          )}
          {whatIfError && (
            <p className="mt-3 text-sm text-[var(--bad)]" role="alert">
              {whatIfError}
            </p>
          )}
          {whatIfResult && (
            <div
              className="mt-4 rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--bg)] px-4 py-3"
              aria-live="polite"
            >
              <p className="text-sm text-[var(--dim)]">{whatIfResult.label}</p>
              <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-[var(--dim)]">Ending wealth with this change (after-tax)</dt>
                  <dd className="tnum text-lg font-semibold">
                    {fmtCents(whatIfResult.wealthCents)}{" "}
                    <span className="text-sm font-normal text-[var(--dim)]">
                      {whatIfResult.deltaWealthCents === 0
                        ? "— the same as your saved plan"
                        : `${whatIfResult.deltaWealthCents > 0 ? "+" : ""}${fmtCents(whatIfResult.deltaWealthCents)} vs your saved plan`}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--dim)]">Lifetime net cost with this change</dt>
                  <dd className="tnum text-lg font-semibold">
                    {fmtCents(whatIfResult.netCostCents)}{" "}
                    <span className="text-sm font-normal text-[var(--dim)]">
                      {whatIfResult.deltaNetCostCents === 0
                        ? "— the same as your saved plan"
                        : `${whatIfResult.deltaNetCostCents > 0 ? "+" : ""}${fmtCents(whatIfResult.deltaNetCostCents)} vs your saved plan`}
                    </span>
                  </dd>
                </div>
              </dl>
              <p className="mt-2 text-xs text-[var(--dim)]">
                Priced from your saved plan with just that one change — nothing
                was saved.
                {whatIfStale
                  ? " Your plan has changed since this answer was priced — ask the question again for current figures."
                  : ""}
              </p>
            </div>
          )}
            </div>
          )}
        </section>
      )}

      {face === "plan" && savedPlanPayload && (
        <section className={sectionCls} aria-label="Ending figures">
          <h2 className="text-base font-semibold">Where your saved plan ends</h2>
          <p className="mt-1 max-w-3xl text-sm text-[var(--dim)]">
            Priced from your saved record — the same baseline the what-if
            answers above are measured against.
          </p>
          {savedStripRow ? (
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
              {[
                {
                  label: "Ending wealth (after-tax)",
                  value: savedStripRow.endingAfterTaxWealthCents,
                },
                { label: "Lifetime net cost", value: savedStripRow.netCostCents },
                { label: "Ending pre-tax", value: savedStripRow.endingPretaxCents },
                {
                  label: "ACA premium credit kept",
                  value: savedStripRow.acaCreditCents,
                },
              ].map((f) => (
                <div key={f.label}>
                  <dt className="text-sm text-[var(--dim)]">{f.label}</dt>
                  <dd className="tnum mt-0.5 text-xl font-semibold">
                    {fmtCents(f.value)}
                  </dd>
                </div>
              ))}
            </dl>
          ) : savedStripQ.isPending || savedStripQ.isFetching ? (
            <p className="mt-3 text-sm text-[var(--dim)]" aria-live="polite">
              Pricing your saved plan…
            </p>
          ) : (
            <p className="mt-3 text-sm text-[var(--dim)]" role="status">
              Your saved plan couldn&rsquo;t be priced just now
              {savedStripData && !savedStripData.ok
                ? ` — ${savedStripData.reason}`
                : ""}
              . Open All settings to check the plan&rsquo;s inputs.
            </p>
          )}
        </section>
      )}

      {face === "plan" && !planInputs && init && (
        <section className={sectionCls} aria-label="Plan not priced yet">
          <p className="text-sm">
            The plan isn&rsquo;t pricing yet — it needs a birth year, annual
            spending, a retirement age, an expected return, and an end age
            after the current age.{" "}
            <button
              type="button"
              aria-label="Change the plan to fill in the missing inputs"
              className="font-medium text-[var(--accent)] underline underline-offset-2 hover:text-[var(--text)]"
              onClick={() => setFace("change")}
            >
              Change the plan
            </button>{" "}
            to fill them in, or open All settings.
          </p>
        </section>
      )}

      {face === "settings" && (
      <div
        role="group"
        aria-label="Results workspace"
        className="mt-5 flex w-full flex-nowrap items-end overflow-x-auto border-b border-[var(--border)]"
      >
        {ROTH_MODE_OPTIONS_SHOWN.map((m) => (
          <button
            key={m.id}
            type="button"
            aria-label={`${m.label} results`}
            aria-pressed={resultsMode === m.id}
            className={`relative shrink-0 px-3.5 py-2.5 text-sm whitespace-nowrap sm:px-5 ${
              resultsMode === m.id
                ? "font-semibold text-[var(--text)]"
                : "font-medium text-[var(--dim)] hover:text-[var(--accent)]"
            }`}
            onClick={() => switchResultsMode(m.id)}
          >
            {resultsMode === m.id && (
              <span
                aria-hidden="true"
                className="absolute right-2 -bottom-px left-2 h-[2px] bg-[var(--accent)]"
              />
            )}
            {m.label}
          </button>
        ))}
      </div>
      )}

      {takeawayText &&
        (typeof takeawayText === "string" ? (
          <p
            aria-label="Plan summary"
            className="tnum mt-2 text-sm leading-relaxed text-[var(--dim)]"
          >
            {takeawayText}
          </p>
        ) : (
          <p
            aria-label="Plan summary"
            className="tnum mt-2 text-sm leading-relaxed text-[var(--dim)]"
          >
            {takeawayText.short}
            <InfoNote
              ariaLabel="The full plan summary sentence"
              text={takeawayText.full}
            />
          </p>
        ))}

      {face === "settings" && resultsMode === "thisYear" && (
        <section className={sectionCls} aria-label={`This year — ${startYear}`}>
          <h2 className="text-base font-semibold">
            This year — {startYear}
            <InfoNote
              ariaLabel={`About this year — ${startYear}`}
              text={`Prices ${startYear} on its own, through the same engine and the plan's ceilings: income already received and conversions already made this year count first. It answers one question — how much more can still be converted before Dec 31, ${startYear}, and what will it cost? Every figure here is for ${startYear} only.`}
            />
          </h2>
          {execRolledOver && execClearedYear != null && (
            <p className="mt-3 text-sm" role="note">
              <strong>New year, clean slate:</strong> the {execClearedYear} actuals
              were cleared for the new year — last year&rsquo;s figures are never
              carried into a new year&rsquo;s pricing. The fields below start blank
              for {startYear}.
            </p>
          )}
          <h3 className="mt-4 text-sm font-semibold">Balances today</h3>
          <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {moneyField("Pre-tax today", execPretax, setExecPretax, {
              hint: "Defaults to the plan's resolved Pre-tax balance. Editing here changes this panel only — it never writes back to the plan's balances.",
              onEdit: () =>
                setExecBalanceOverrides((o) => (o.pretax ? o : { ...o, pretax: true })),
            })}
            {moneyField("Pre-tax — spouse today", execPretaxSpouse, setExecPretaxSpouse, {
              hint: "The spouse's own pre-tax balance today. Defaults to the plan's resolved spouse balance.",
              onEdit: () =>
                setExecBalanceOverrides((o) =>
                  o.pretaxSpouse ? o : { ...o, pretaxSpouse: true },
                ),
            })}
            {moneyField("Roth today", execRoth, setExecRoth, {
              onEdit: () =>
                setExecBalanceOverrides((o) => (o.roth ? o : { ...o, roth: true })),
            })}
            {moneyField("Taxable today", execTaxable, setExecTaxable, {
              onEdit: () =>
                setExecBalanceOverrides((o) => (o.taxable ? o : { ...o, taxable: true })),
            })}
            {moneyField("HSA today", execHsa, setExecHsa, {
              onEdit: () =>
                setExecBalanceOverrides((o) => (o.hsa ? o : { ...o, hsa: true })),
            })}
          </div>
          <h3 className="mt-4 text-sm font-semibold">Already happened in {startYear}</h3>
          <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {moneyField(`Other ordinary income received in ${startYear}`, execOtherOrd, setExecOtherOrd, {
              hint: "Year to date. Blank counts as $0 received so far.",
            })}
            {moneyField(`Tax-exempt interest received in ${startYear}`, execTaxExempt, setExecTaxExempt, {
              hint: "Year to date. Counts toward MAGI and provisional income, though it is not itself taxed.",
            })}
            {moneyField(`Already converted in ${startYear}`, execAlready, setExecAlready, {
              hint: `Conversions already made in ${startYear}, year to date. Not the plan's 'Already converted this year' (Spending & timing) — that one belongs to the plan window's first year; this one is priced only here.`,
            })}
          </div>
          <p className="mt-3 text-sm text-[var(--dim)]">
            <strong className="text-[var(--text)]">Filling to:</strong>{" "}
            {anyCeiling ? ceilingsSummary : "no ceilings switched on"}. Ceilings are
            the plan&rsquo;s own (set in Advanced) — this panel has no separate
            settings. Everything else in {startYear} — Social Security, RMDs, draw
            order, pay-tax-from, protect-minimum — also comes from the plan,
            unchanged.
          </p>

          {!planInputs && (
            <p className="mt-4 text-sm text-[var(--bad)]">
              Check the plan inputs above — this panel prices {startYear} from the
              plan, which needs a birth year, annual spending, a retirement age, an
              expected return, and an end age after the current age.
            </p>
          )}
          {planInputs && executionResult && executionResult.status === "no-ceiling" && (
            <p className="mt-4 text-sm" role="note">
              <strong>No fill target.</strong> The plan has no ceiling switched on,
              so there is no target to fill to in {startYear} and this panel offers
              no fill number. Switch on a ceiling in the plan (Advanced section) and
              the remaining conversion for {startYear} will be priced here.
            </p>
          )}
          {planInputs && executionResult && executionResult.status === "not-priced" && (
            <p className="mt-4 text-sm" role="note">
              <strong>No pre-tax balance is priced yet</strong> — the balances above
              price $0 of pre-tax money, so there is nothing to convert in{" "}
              {startYear}. Enter a pre-tax balance above (or split the snapshot /
              save one in the plan) and the remaining conversion will be priced here.
            </p>
          )}
          {planInputs &&
            executionResult &&
            executionResult.year &&
            executionResult.status !== "no-ceiling" &&
            executionResult.status !== "not-priced" &&
            (() => {
              const er = executionResult;
              const ey = er.year!;
              const capText = (label: string) =>
                label.startsWith("Top of ") ? `top of ${label.slice(7)}` : label;
              const showNumbers =
                er.status === "ok" || er.status === "balance-capped";
              return (
                <div className="mt-4 rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--bg)] px-4 py-3">
                  <p className="text-sm text-[var(--dim)]">
                    Remaining conversion for {startYear} — convert by Dec 31, {startYear}
                  </p>
                  <p className="tnum mt-0.5 text-3xl font-semibold">
                    {fmtDollars(er.remaining)}
                  </p>
                  {er.status === "balance-capped" && er.fillTarget != null && (
                    <p className="mt-1 text-sm">
                      That&rsquo;s the whole pre-tax balance — less than the{" "}
                      {fmtDollars(er.fillTarget)} that would fill to the{" "}
                      {er.fillTargetLabel ? capText(er.fillTargetLabel) : "plan's ceiling"}.
                    </p>
                  )}
                  {er.status === "over-ceiling-income" && (
                    <p className="mt-1 text-sm">
                      Income already received in {startYear} puts this year{" "}
                      {fmtDollars(er.overshoot)} past the{" "}
                      {er.overshootLabel ? capText(er.overshootLabel) : "plan's ceiling"}{" "}
                      — no room to convert under it this year.
                    </p>
                  )}
                  {er.status === "over-ceiling-conversions" && (
                    <p className="mt-1 text-sm">
                      You&rsquo;ve already converted {fmtDollars(er.ytdConverted)} in{" "}
                      {startYear} — that&rsquo;s past the{" "}
                      {er.fillTarget != null ? fmtDollars(er.fillTarget) : "amount"} that
                      fills to the{" "}
                      {er.overshootLabel ? capText(er.overshootLabel) : "plan's ceiling"},
                      so there&rsquo;s nothing more to convert under it this year.
                    </p>
                  )}
                  {er.status === "no-room" && (
                    <p className="mt-1 text-sm">
                      {er.fillOutcome === "aca-inactive-only-ceiling"
                        ? `The only ceiling switched on is the ACA limit, and nobody is on the marketplace in ${startYear}, so it sets no fill target this year.`
                        : er.fillOutcome === "era-cliff-off"
                          ? `The only ceiling switched on is the ACA limit, and this plan defends it only until the household steps down — ${startYear} is at or past the household schedule's first step year, so it sets no fill target this year.`
                        : er.fillOutcome === "reserve-floor"
                          ? `The pre-tax balance is already at the preserved reserve (${fmtDollars(planInputs.preservePretax ?? 0)}), so the reserve leaves no room to convert in ${startYear}.`
                          : er.ytdConverted > 0
                          ? `The conversions already made in ${startYear} fill this year to its target under the plan's ceilings — nothing more to convert under them this year.`
                          : `No room to convert under the plan's ceilings in ${startYear}.`}
                    </p>
                  )}
                  {showNumbers && er.boundLabel && er.status !== "balance-capped" && (
                    <p className="mt-1 text-sm text-[var(--dim)]">
                      Capped by the {capText(er.boundLabel)}.
                    </p>
                  )}
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
                    <div>
                      <dt className="text-[var(--dim)]">
                        Total conversion for {startYear}
                      </dt>
                      <dd className="tnum font-medium">{fmtDollars(er.totalConversion)}</dd>
                      <dd className="text-xs text-[var(--dim)]">
                        {fmtDollars(er.ytdConverted)} already converted +{" "}
                        {fmtDollars(er.remaining)} remaining
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[var(--dim)]">MAGI for {startYear}</dt>
                      <dd className="tnum font-medium">{fmtDollars(ey.magi)}</dd>
                    </div>
                    <div>
                      <dt className="text-[var(--dim)]">Taxable income for {startYear}</dt>
                      <dd className="tnum font-medium">{fmtDollars(ey.taxableIncome)}</dd>
                    </div>
                    <div>
                      <dt className="text-[var(--dim)]">Federal tax for {startYear}</dt>
                      <dd className="tnum font-medium">{fmtDollars(ey.federalTax)}</dd>
                      {ey.stateTax > 0 && (
                        <dd className="text-xs text-[var(--dim)]">
                          plus {fmtDollars(ey.stateTax)} state tax at the plan&rsquo;s
                          flat rate
                        </dd>
                      )}
                    </div>
                    <div>
                      <dt className="text-[var(--dim)]">IRMAA lookahead</dt>
                      <dd className="text-sm">
                        This year&rsquo;s MAGI sets IRMAA tier {ey.detail.irmaa.tierSet}{" "}
                        for {ey.detail.irmaa.premiumYear}
                      </dd>
                    </div>
                  </dl>
                  {ceilings.acaCliffCap && ey.acaActive && !ey.acaPriced && (
                    <p className="mt-3 text-sm" role="note">
                      ACA premium credit isn&rsquo;t priced for {startYear} yet — no
                      ACA benchmark premium is entered for this coverage — so no credit is
                      counted for this year.
                    </p>
                  )}
                  <button
                    type="button"
                    aria-label={`Show the math for ${startYear}`}
                    aria-expanded={execDetailOpen}
                    className="mt-3 font-medium text-[var(--accent)] underline underline-offset-2 hover:text-[var(--text)]"
                    onClick={toggleExecDetail}
                  >
                    {execDetailOpen ? "Hide the math" : "Show the math"} for {startYear}
                  </button>
                  {execDetailOpen &&
                    renderYearDetail(ey, closeExecDetail)}
                </div>
              );
            })()}
        </section>
      )}

      {face === "settings" && resultsMode === "yearFunding" && (
        <section className={sectionCls} aria-label="Year funding">
          <h2 className="text-base font-semibold">Year funding</h2>
          <p className="mt-1 max-w-3xl text-sm text-[var(--dim)]">
            For the plan exactly as it stands — no scratch dials — what each
            priced year needed, and what funded it. Needs are the year&rsquo;s
            spending plus its federal tax, state tax, and Medicare (IRMAA)
            premiums. Sources are the amounts actually applied to those needs:
            income first, then the year&rsquo;s taxable yield, then draws from
            the accounts, so for every year the plan can fund, each
            row&rsquo;s sources add up to its total need.
            Select a year for its full ledger.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              aria-label="Refresh year funding"
              className="rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              disabled={runYfMut.isPending || !init}
              onClick={() => runYfMut.mutate(buildSavePayload())}
            >
              {runYfMut.isPending ? "Pricing…" : "Refresh"}
            </button>
            {yfStale && (
              <span className="text-sm text-[var(--dim)]" role="note">
                Inputs have changed since this run — Refresh for current figures.
              </span>
            )}
          </div>
          {yfError && (
            <p className="mt-2 text-sm text-[var(--bad)]" role="alert">
              {yfError}
            </p>
          )}
          {yfResult?.ok && yfResult.years.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[1080px] text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] text-left">
                    <th scope="col" className="px-2 py-2 font-medium">Year</th>
                    <th scope="col" className="px-2 py-2 text-right font-medium">Total need</th>
                    <th scope="col" className="px-2 py-2 text-right font-medium">Social Security</th>
                    <th scope="col" className="px-2 py-2 text-right font-medium">RMD</th>
                    <th scope="col" className="px-2 py-2 text-right font-medium">Other income</th>
                    <th scope="col" className="px-2 py-2 text-right font-medium">Interest yield</th>
                    <th scope="col" className="px-2 py-2 text-right font-medium">Dividend yield</th>
                    {yfResult.years.some((y) => y.cashSpendCents > 0) && (
                      <th scope="col" className="px-2 py-2 text-right font-medium">Cash sleeve used for spending</th>
                    )}
                    <th scope="col" className="px-2 py-2 text-right font-medium">Pre-tax draw</th>
                    <th scope="col" className="px-2 py-2 text-right font-medium">Taxable — spending</th>
                    <th scope="col" className="px-2 py-2 text-right font-medium">Taxable — tax bill</th>
                    <th scope="col" className="px-2 py-2 text-right font-medium">Roth draw</th>
                  </tr>
                </thead>
                <tbody>
                  {yfResult.years.map((r) => {
                    const cell = (v: number) => (v === 0 ? "—" : fmtCents(v));
                    const selected = yfYear === r.year;
                    const fundedTotal =
                      r.ssCents + r.rmdCents + r.otherIncomeCents + r.interestYieldCents +
                      r.dividendYieldCents + r.cashSpendCents + r.pretaxDrawCents + r.taxableSoldForSpendingCents +
                      r.taxableSoldForTaxCents + r.rothDrawCents + r.salarySurplusCents;
                    const isShort = fundedTotal < r.totalNeedCents;
                    return (
                      <tr
                        key={r.year}
                        className={`border-b border-[var(--border)]${selected ? " bg-[var(--accent-soft)]" : ""}`}
                      >
                        <td className="tnum px-2 py-2 font-medium">
                          <button
                            type="button"
                            aria-label={`Year ${r.year} funding details`}
                            aria-pressed={selected}
                            className="underline-offset-2 hover:underline"
                            onClick={() => setYfYear(selected ? null : r.year)}
                          >
                            {r.year}
                          </button>
                          {isShort && (
                            <span className="ml-2 text-xs font-semibold text-[var(--bad)]">
                              Short
                            </span>
                          )}
                          <span className="block text-xs font-normal text-[var(--dim)]">
                            age {r.agePrimary}
                          </span>
                        </td>
                        <td className="tnum px-2 py-2 text-right font-medium">{fmtCents(r.totalNeedCents)}</td>
                        <td className="tnum px-2 py-2 text-right">{cell(r.ssCents)}</td>
                        <td className="tnum px-2 py-2 text-right">{cell(r.rmdCents)}</td>
                        <td className="tnum px-2 py-2 text-right">{cell(r.otherIncomeCents)}</td>
                        <td className="tnum px-2 py-2 text-right">{cell(r.interestYieldCents)}</td>
                        <td className="tnum px-2 py-2 text-right">{cell(r.dividendYieldCents)}</td>
                        {yfResult.years.some((y) => y.cashSpendCents > 0) && (
                          <td className="tnum px-2 py-2 text-right">{cell(r.cashSpendCents)}</td>
                        )}
                        <td className="tnum px-2 py-2 text-right">{cell(r.pretaxDrawCents)}</td>
                        <td className="tnum px-2 py-2 text-right">{cell(r.taxableSoldForSpendingCents)}</td>
                        <td className="tnum px-2 py-2 text-right">{cell(r.taxableSoldForTaxCents)}</td>
                        <td className="tnum px-2 py-2 text-right">{cell(r.rothDrawCents)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {yfResult?.ok && yfYear != null && (() => {
            const r = yfResult.years.find((y) => y.year === yfYear);
            if (!r) return null;
            const sourcesTotal =
              r.ssCents + r.rmdCents + r.otherIncomeCents + r.interestYieldCents +
              r.dividendYieldCents + r.cashSpendCents + r.pretaxDrawCents + r.taxableSoldForSpendingCents +
              r.taxableSoldForTaxCents + r.rothDrawCents + r.salarySurplusCents;
            const needRow = (label: string, v: number) => (
              <div className="flex items-baseline justify-between gap-3 py-1">
                <span>{label}</span>
                <span className="tnum">{v === 0 ? "—" : fmtCents(v)}</span>
              </div>
            );
            return (
              <div className="mt-4 rounded-[var(--radius)] border border-[var(--border)] px-4 py-3">
                <h3 className="text-base font-semibold">
                  {r.year} — age {r.agePrimary}
                  {r.ageSpouse != null ? ` · spouse ${r.ageSpouse}` : ""}
                </h3>
                <div className="mt-3 grid gap-x-8 gap-y-1 sm:grid-cols-2">
                  <div>
                    <h4 className="border-b border-[var(--border)] pb-1 font-medium">What the year needed</h4>
                    {needRow("Spending", r.spendingCents)}
                    {needRow("Federal tax", r.federalTaxCents)}
                    {needRow("State tax", r.stateTaxCents)}
                    {needRow("Medicare premiums (IRMAA)", r.irmaaCents)}
                    <div className="flex items-baseline justify-between gap-3 border-t border-[var(--border)] py-1 font-medium">
                      <span>Total need</span>
                      <span className="tnum">{fmtCents(r.totalNeedCents)}</span>
                    </div>
                    {r.spendShortfallCents > 0 && (
                      <div className="flex items-baseline justify-between gap-3 py-1 font-medium text-[var(--bad)]">
                        <span>Spending not covered</span>
                        <span className="tnum">{fmtCents(r.spendShortfallCents)}</span>
                      </div>
                    )}
                  </div>
                  <div>
                    <h4 className="border-b border-[var(--border)] pb-1 font-medium">What funded it</h4>
                    {needRow("Social Security", r.ssCents)}
                    {needRow("Required minimum distribution", r.rmdCents)}
                    {needRow("Other income", r.otherIncomeCents)}
                    {needRow("Taxable interest yield", r.interestYieldCents)}
                    {needRow("Taxable dividend yield", r.dividendYieldCents)}
                    {r.cashSpendCents > 0 &&
                      needRow("Cash sleeve used for spending", r.cashSpendCents)}
                    {needRow("Pre-tax draw", r.pretaxDrawCents)}
                    {needRow("Taxable sold — for spending", r.taxableSoldForSpendingCents)}
                    {needRow("Taxable sold — for the tax bill", r.taxableSoldForTaxCents)}
                    {needRow("Roth draw", r.rothDrawCents)}
                    <div className="flex items-baseline justify-between gap-3 border-t border-[var(--border)] py-1 font-medium">
                      <span>Total funded</span>
                      <span className="tnum">{fmtCents(sourcesTotal)}</span>
                    </div>
                  </div>
                </div>
                {sourcesTotal === r.totalNeedCents ? (
                  <p className="mt-2 text-sm text-[var(--dim)]">
                    Funded in full — sources add up to the total need.
                  </p>
                ) : (
                  <p className="mt-2 text-sm text-[var(--bad)]" role="note">
                    Short by {fmtCents(r.totalNeedCents - sourcesTotal)} — the
                    plan&rsquo;s balances could not cover this year&rsquo;s needs.
                  </p>
                )}
                <h4 className="mt-4 border-b border-[var(--border)] pb-1 font-medium">
                  Income position
                </h4>
                <div className="mt-1 space-y-1 text-sm">
                  <p className="tnum">
                    MAGI {fmtCents(r.magiCents)} · ACA MAGI {fmtCents(r.acaMagiCents)}
                    {r.acaCliffCents != null ? (
                      <>
                        {" "}against the ACA cliff at {fmtCents(r.acaCliffCents)} —{" "}
                        {r.acaMagiCents <= r.acaCliffCents
                          ? `${fmtCents(r.acaCliffCents - r.acaMagiCents)} under the line`
                          : `${fmtCents(r.acaMagiCents - r.acaCliffCents)} over the line`}
                      </>
                    ) : (
                      <> — ACA pricing not in scope this year</>
                    )}
                  </p>
                  <p className="tnum">
                    Taxable income {fmtCents(r.taxableIncomeCents)} · landing
                    bracket {r.bracketPct}%
                    {r.acaPriced ? <> · premium credit kept {fmtCents(r.acaCreditCents)}</> : null}
                  </p>
                  <p className="tnum">
                    Realized gains from the year&rsquo;s draws and tax sales:{" "}
                    {fmtCents(r.drawGainsCents)} · taxable Social Security:{" "}
                    {fmtCents(r.ssTaxableCents)}
                  </p>
                </div>
                <h4 className="mt-4 border-b border-[var(--border)] pb-1 font-medium">
                  Conversion
                </h4>
                <p className="mt-1 text-sm">
                  {r.conversionCents > 0 ? (
                    <>
                      Converted {fmtCents(r.conversionCents)} from Pre-tax to Roth.
                      A conversion moves money between accounts — it does not fund
                      spending; the tax it creates is part of this year&rsquo;s tax
                      bill above.
                    </>
                  ) : (
                    <>No conversion this year.</>
                  )}
                </p>
                {r.harvestSoldCents > 0 && (
                  <>
                    <h4 className="mt-4 border-b border-[var(--border)] pb-1 font-medium">
                      Sold and reinvested
                    </h4>
                    <p className="mt-1 text-sm">
                      Gain harvesting realized {fmtCents(r.harvestSoldCents)} of
                      gains by selling and immediately rebuying Taxable holdings —
                      the proceeds never left the account, so it is neither a
                      source nor a need above.
                    </p>
                  </>
                )}
              </div>
            );
          })()}
          {yfResult?.ok && yfResult.years.length === 0 && (
            <p className="mt-3 text-sm" role="note">
              The plan prices no years yet — enter a birth year above.
            </p>
          )}
        </section>
      )}

      {face === "settings" && resultsMode === "proof" && (
        <section className={sectionCls} aria-label="Pretax Spending — pre-tax to age 110">
          <h2 className="text-base font-semibold">
            Pretax Spending — how long the pre-tax money lasts
            <InfoNote
              ariaLabel="About Pretax Spending"
              text={`Your plan, re-run to age ${PROOF_END_AGE}. Start from your plan's numbers, or change the starting balances, the yearly spending, or where taxes are paid from in the try-it numbers below — everything else (fill ceilings, draw order, return, Social Security) stays as your plan has it. This is the year-by-year evidence behind the claim that the pre-tax bucket lasts: every year's funding split and every year's ending balances, from the same engine that prices the Plan tab.`}
            />
          </h2>
          <p className="mt-3 rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--bg)] px-3 py-2 text-sm" role="note">
            <strong>Pretax Spending only — nothing is saved.</strong> The run to
            age {PROOF_END_AGE} and any numbers you type below happen in memory
            on this screen. Your saved plan still ends at age{" "}
            {planInputs ? planInputs.endAgePrimary : "—"} and opening, reading,
            changing numbers here, or leaving this view does not change it.
          </p>

          <div className="mt-4 border-t border-[var(--border)] pt-4">
            <h3 className="text-base font-semibold">
              Try different numbers — this tab only
              <InfoNote
                ariaLabel="About trying different numbers"
                text="Type a different starting balance or spending amount, or switch where the tax bill is paid from, and the verdict, tiles, chart, and year table below re-run right away. A blank field uses your plan's value — it is shown under each field."
              />
            </h3>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {moneyField("Starting pre-tax — You", proofPretax, setProofPretax, {
                idLabel: "Pretax Spending starting pre-tax — You",
                hint: planInputs
                  ? `Blank = your plan's ${fmtDollars(planInputs.pretaxStart)}.`
                  : "Blank = your plan's value.",
              })}
              {moneyField("Starting pre-tax — wife", proofPretaxSpouse, setProofPretaxSpouse, {
                idLabel: "Pretax Spending starting pre-tax — wife",
                hint: planInputs
                  ? `Blank = your plan's ${fmtDollars(planInputs.pretaxSpouseStart ?? 0)}.`
                  : "Blank = your plan's value.",
              })}
              {moneyField("Starting Taxable", proofTaxable, setProofTaxable, {
                idLabel: "Pretax Spending starting Taxable",
                hint: planInputs
                  ? `Blank = your plan's ${fmtDollars(planInputs.taxableStart)}. This is the money taxes are paid from when “Pay taxes from” is Taxable.`
                  : "Blank = your plan's value.",
              })}
              {moneyField("Starting Roth", proofRoth, setProofRoth, {
                idLabel: "Pretax Spending starting Roth",
                hint: planInputs
                  ? `Blank = your plan's ${fmtDollars(planInputs.rothStart)}.`
                  : "Blank = your plan's value.",
              })}
              {moneyField("Starting HSA", proofHsa, setProofHsa, {
                idLabel: "Pretax Spending starting HSA",
                hint: planInputs
                  ? `Blank = your plan's ${fmtDollars(planInputs.hsaStart)}.`
                  : "Blank = your plan's value.",
              })}
              {moneyField("Annual spending", proofSpending, setProofSpending, {
                idLabel: "Pretax Spending annual spending",
                hint: planInputs
                  ? `Blank = your plan's ${fmtDollars(planInputs.annualSpending)}/yr.`
                  : "Blank = your plan's value.",
              })}
              <div>
                <label className={labelCls} htmlFor="roth-proof-payfrom">
                  Pay taxes from
                </label>
                <select
                  id="roth-proof-payfrom"
                  aria-label="Pay taxes from — Pretax Spending"
                  className={inputCls}
                  value={proofPayTaxFrom}
                  onChange={(e) =>
                    setProofPayTaxFrom(
                      e.target.value as "" | "taxable" | "conversion",
                    )
                  }
                >
                  <option value="">
                    Your plan&rsquo;s setting
                    {planInputs
                      ? ` (${planInputs.payTaxFrom === "taxable" ? "Taxable account" : "Withheld from the conversion"})`
                      : ""}
                  </option>
                  <option value="taxable">Taxable account</option>
                  <option value="conversion">Withheld from the conversion</option>
                </select>
                <p className={hintCls}>
                  Taxable pays the tax bill by selling taxable money (down to
                  your plan&rsquo;s protect-minimum). Withheld takes it out of
                  the conversion itself — before 59½ the plan prices the 10%
                  early-distribution penalty on the amount withheld.
                </p>
              </div>
            </div>
            {proofOverridesActive && (
              <p className="tnum mt-3 text-sm" role="note">
                Trying different numbers: starting pre-tax{" "}
                {fmtDollars(
                  (proofInputs?.pretaxStart ?? 0) +
                    (proofInputs?.pretaxSpouseStart ?? 0),
                )}
                , starting Taxable {fmtDollars(proofInputs?.taxableStart ?? 0)},
                spending {fmtDollars(proofInputs?.annualSpending ?? 0)}/yr,
                taxes paid from{" "}
                {proofInputs?.payTaxFrom === "taxable"
                  ? "Taxable"
                  : "the conversion"}
                .{" "}
                <button
                  type="button"
                  aria-label="Reset Pretax Spending numbers to your plan"
                  className="font-medium text-[var(--accent)] underline underline-offset-2 hover:text-[var(--text)]"
                  onClick={resetProofOverrides}
                >
                  Reset to your plan&rsquo;s numbers
                </button>
              </p>
            )}
          </div>

          {!planInputs && (
            <p className="mt-4 text-sm text-[var(--bad)]">
              Check the plan inputs above — this view prices the plan, which
              needs a birth year, annual spending, a retirement age, an expected
              return, and an end age after the current age.
            </p>
          )}

          {planInputs && proofInputs && proofResult && proofStats && (
            <>
              <div className="mt-4 rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--bg)] px-4 py-3">
                <p className="text-sm text-[var(--dim)]">The verdict</p>
                {proofStats.startingPretax <= 0 ? (
                  <p className="tnum mt-0.5 text-2xl font-semibold">
                    No pre-tax balance is priced yet
                  </p>
                ) : proofStats.firstZero ? (
                  <p className="tnum mt-0.5 text-2xl font-semibold">
                    Pre-tax empties during {proofStats.firstZero.year} — age{" "}
                    {proofStats.firstZero.agePrimary}
                  </p>
                ) : (
                  <p className="tnum mt-0.5 text-2xl font-semibold">
                    Pre-tax does not empty by age {PROOF_END_AGE} —{" "}
                    {fmtDollars(proofStats.last?.pretaxEnd ?? 0)} is still left
                  </p>
                )}
                <p className="tnum mt-1 text-sm leading-relaxed">
                  Starting from {fmtDollars(proofStats.startingPretax)} of pre-tax
                  money, spending {fmtDollars(proofInputs.annualSpending)}/yr in
                  today&rsquo;s dollars from age {proofInputs.retirementAge},
                  with taxes paid from{" "}
                  {proofInputs.payTaxFrom === "taxable"
                    ? "the Taxable account"
                    : "the conversion (withheld)"}
                  {proofInputs.ssPrimaryAnnual > 0 && proofInputs.ssPrimaryStartAge != null
                    ? `, with Social Security of ${fmtDollars(proofInputs.ssPrimaryAnnual)}/yr from age ${proofInputs.ssPrimaryStartAge}`
                    : ""}
                  {proofInputs.ssSpouseAnnual > 0 && proofInputs.ssSpouseStartAge != null
                    ? ` and spouse Social Security of ${fmtDollars(proofInputs.ssSpouseAnnual)}/yr from age ${proofInputs.ssSpouseStartAge}`
                    : ""}
                  .
                  {proofStats.firstZero && proofStats.beforeZero
                    ? ` It ends age ${proofStats.beforeZero.agePrimary} with ${fmtDollars(proofStats.beforeZero.pretaxEnd)} left, and the next year's RMD and draw finish it.`
                    : ""}
                  {proofStats.firstZero
                    ? " Emptying is not running out of money: it is only this one bucket finishing."
                    : ""}
                </p>
                {proofStats.last && (
                  <p className="tnum mt-1 text-sm text-[var(--dim)]">
                    At age {proofStats.last.agePrimary} ({proofStats.last.year})
                    the other buckets hold Taxable{" "}
                    {fmtDollars(proofStats.last.taxableEnd)}, Roth{" "}
                    {fmtDollars(proofStats.last.rothEnd)}, and HSA{" "}
                    {fmtDollars(proofStats.last.hsaEnd)}.
                  </p>
                )}
              </div>

              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-[var(--dim)]">Spending fully funded</dt>
                  <dd className="tnum font-medium">
                    {proofStats.shortfallYears.length === 0
                      ? `Yes — every year to age ${PROOF_END_AGE}`
                      : `No — short in ${proofStats.shortfallYears.map((y) => y.year).join(", ")}`}
                  </dd>
                  <dd className="text-xs text-[var(--dim)]">
                    {proofStats.shortfallYears.length === 0
                      ? "No year has spending the balances could not cover."
                      : `Unfunded spending totals ${fmtDollars(proofStats.shortfallYears.reduce((a, y) => a + y.spendShortfall, 0))}.`}
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--dim)]">Roth drawn for spending or tax</dt>
                  <dd className="tnum font-medium">
                    {proofStats.totals.rothDraw === 0
                      ? "$0 — never touched"
                      : fmtDollars(proofStats.totals.rothDraw)}
                  </dd>
                  <dd className="text-xs text-[var(--dim)]">
                    {proofStats.totals.rothDraw === 0
                      ? "The Roth only receives conversions and grows."
                      : `Drawn in ${proofStats.rothYearsUsed} year${proofStats.rothYearsUsed === 1 ? "" : "s"}.`}
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--dim)]">HSA drawn</dt>
                  <dd className="tnum font-medium">$0 — never touched</dd>
                  <dd className="text-xs text-[var(--dim)]">
                    The engine never draws the HSA; it grows from{" "}
                    {fmtDollars(proofInputs.hsaStart)} to{" "}
                    {fmtDollars(proofStats.last?.hsaEnd ?? 0)} by age{" "}
                    {PROOF_END_AGE}.
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--dim)]">Taxable sold on purpose</dt>
                  <dd className="tnum font-medium">
                    {fmtDollars(
                      proofStats.totals.taxableForSpending + proofStats.totals.taxableForTax,
                    )}
                  </dd>
                  <dd className="text-xs text-[var(--dim)]">
                    In {proofStats.taxableYearsUsed} year
                    {proofStats.taxableYearsUsed === 1 ? "" : "s"} —{" "}
                    {fmtDollars(proofStats.totals.taxableForTax)} pays the tax
                    bill and {fmtDollars(proofStats.totals.taxableForSpending)}{" "}
                    tops up spending the capped pre-tax draw cannot cover.
                    Taxable is used every year it is needed; it is not untouched.
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--dim)]">Pre-tax draw for spending &amp; tax</dt>
                  <dd className="tnum font-medium">{fmtDollars(proofStats.totals.pretaxDraw)}</dd>
                  <dd className="text-xs text-[var(--dim)]">
                    On top of RMDs of {fmtDollars(proofStats.totals.rmd)} and
                    conversions of {fmtDollars(proofStats.totals.conversions)}{" "}
                    (conversions move money to Roth — they are not spending).
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--dim)]">Social Security collected</dt>
                  <dd className="tnum font-medium">{fmtDollars(proofStats.totals.ss)}</dd>
                  <dd className="text-xs text-[var(--dim)]">
                    Benefits applied to each year&rsquo;s needs over the whole
                    run to age {PROOF_END_AGE} — this is why the spending does
                    not all come out of pre-tax.
                  </dd>
                </div>
              </dl>

              {proofStats.dnFirstZero && (
                <p className="tnum mt-4 text-sm leading-relaxed" role="note">
                  <strong>What the caps buy:</strong> the same plan with no
                  ceilings at all (Do Nothing, also run to age {PROOF_END_AGE})
                  empties its pre-tax during {proofStats.dnFirstZero.year} —
                  age {proofStats.dnFirstZero.agePrimary}
                  {proofStats.yearsSooner != null && proofStats.yearsSooner > 0
                    ? `, ${proofStats.yearsSooner} year${proofStats.yearsSooner === 1 ? "" : "s"} sooner than your plan`
                    : ""}
                  , and keeps {fmtDollars(proofStats.totals.dnAcaKept)} of ACA
                  premium credit against your plan&rsquo;s{" "}
                  {fmtDollars(proofStats.totals.acaKept)}. Holding the early
                  pre-tax draws down is what stretches the bucket.
                </p>
              )}

              <h3 className="mt-5 text-base font-semibold">Pre-tax balance, year by year</h3>
              <ul className="sr-only">
                {proofResult.years.map((y) => (
                  <li key={y.year}>
                    {`${y.year}, age ${y.agePrimary}: pre-tax ends at ${fmtDollars(y.pretaxEnd)}`}
                  </li>
                ))}
              </ul>
              <div className="mt-2 h-64 w-full" aria-hidden="true">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={proofStats.chart} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="year" tick={{ fontSize: 12 }} stroke="var(--dim)" />
                    <YAxis
                      tickFormatter={(v: number) => fmtCompactDollars(v)}
                      tick={{ fontSize: 12 }}
                      stroke="var(--dim)"
                      width={72}
                    />
                    <Tooltip
                      formatter={(value) => fmtDollars(Number(value ?? 0))}
                      contentStyle={{
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                        color: "var(--text)",
                      }}
                    />
                    <Legend />
                    <Area type="monotone" dataKey="Pre-tax" stroke={BUCKET_COLORS["Pre-tax"]} fill={BUCKET_COLORS["Pre-tax"]} fillOpacity={0.55} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              <h3 className="mt-5 text-base font-semibold">
                Every year to age {PROOF_END_AGE} — funding split and ending balances
                <InfoNote
                  ariaLabel="About the year-by-year funding table"
                  text="One row per priced year. Spending is what the year needed for living costs; the funding columns are what actually paid the year's needs (spending plus its tax bill and Medicare premiums), in the engine's own ledger — so a year with no shortfall is funded in full by the columns shown."
                />
              </h3>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--border)] text-left">
                      <th scope="col" className="px-2 py-2 font-medium">Year (age)</th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">Spending</th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">Social Security</th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">RMD</th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">Pre-tax draw</th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">Taxable — spending</th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">Taxable — tax bill</th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">Roth draw</th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">Conversion</th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">Pre-tax end</th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">Taxable end</th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">Roth end</th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">HSA end</th>
                    </tr>
                  </thead>
                  <tbody>
                    {proofResult.years.map((y) => {
                      const cell = (v: number) => (v === 0 ? "—" : fmtDollars(v));
                      const isZeroYear =
                        proofStats.firstZero != null && y.year === proofStats.firstZero.year;
                      return (
                        <tr
                          key={y.year}
                          className={`border-b border-[var(--border)] last:border-0${isZeroYear ? " bg-[var(--accent-soft)] font-medium" : ""}`}
                        >
                          <td className="tnum px-2 py-1.5 whitespace-nowrap">
                            {y.year} ({y.agePrimary}
                            {y.ageSpouse != null ? `/${y.ageSpouse}` : ""})
                            {isZeroYear && (
                              <span className="block text-xs font-semibold">
                                Pre-tax reaches $0 this year
                              </span>
                            )}
                            {y.spendShortfall > 0 && (
                              <span className="block text-xs font-semibold text-[var(--bad)]">
                                Short {fmtDollars(y.spendShortfall)}
                              </span>
                            )}
                          </td>
                          <td className="tnum px-2 py-1.5 text-right whitespace-nowrap">{cell(y.funding.spending)}</td>
                          <td className="tnum px-2 py-1.5 text-right whitespace-nowrap">{cell(y.funding.ss)}</td>
                          <td className="tnum px-2 py-1.5 text-right whitespace-nowrap">{cell(y.funding.rmd)}</td>
                          <td className="tnum px-2 py-1.5 text-right whitespace-nowrap">{cell(y.funding.pretaxDraw)}</td>
                          <td className="tnum px-2 py-1.5 text-right whitespace-nowrap">{cell(y.funding.taxableSoldForSpending)}</td>
                          <td className="tnum px-2 py-1.5 text-right whitespace-nowrap">{cell(y.funding.taxableSoldForTax)}</td>
                          <td className="tnum px-2 py-1.5 text-right whitespace-nowrap">{cell(y.funding.rothDraw)}</td>
                          <td className="tnum px-2 py-1.5 text-right whitespace-nowrap">{cell(y.conversion)}</td>
                          <td className="tnum px-2 py-1.5 text-right whitespace-nowrap">{fmtDollars(y.pretaxEnd)}</td>
                          <td className="tnum px-2 py-1.5 text-right whitespace-nowrap">{fmtDollars(y.taxableEnd)}</td>
                          <td className="tnum px-2 py-1.5 text-right whitespace-nowrap">{fmtDollars(y.rothEnd)}</td>
                          <td className="tnum px-2 py-1.5 text-right whitespace-nowrap">{fmtDollars(y.hsaEnd)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-sm text-[var(--dim)]">
                Reading it: before Social Security starts, spending is carried
                by the capped pre-tax draw plus Taxable sales. From the first
                benefit year, Social Security covers part of every year, which
                is why the full spending never comes out of pre-tax alone.
                Late in the run, RMDs move money out of pre-tax into Taxable
                faster than spending takes it out, so Taxable grows while
                pre-tax finishes its decline.
                {proofStats.unpaidTaxTotal > 0
                  ? ` Unpaid tax over the run: ${fmtDollars(proofStats.unpaidTaxTotal)} — tax no balance could pay in its year.`
                  : ""}
              </p>
            </>
          )}
        </section>
      )}

      {face === "settings" && resultsMode === "workYears" && (
        <section className={sectionCls} aria-label="Work years">
          <h2 className="text-base font-semibold">Work years</h2>
          <p className="mt-1 max-w-3xl text-sm text-[var(--dim)]">
            Quit at your planned age, or work longer? Each quit age below rolls
            the work years forward — salary taxed, payroll tax priced,
            contributions stacked to the legal caps — then prices the rest of
            the plan with the same optimizer as the Optimize tab. The tax
            figure is <strong>all-in</strong>: the conversion plan&rsquo;s tax
            plus the salary years&rsquo; own tax, which the optimizer alone
            never sees.
          </p>

          <h3 className="mt-5 border-b border-[var(--border)] pb-2 text-base font-semibold">
            Your job
          </h3>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {moneyField("Yearly salary", jobSalary, setJobSalary, {
              hint: "Your gross pay per year, held flat while you work.",
            })}
            {moneyField("Employer 401(k)", jobEmployer401k, setJobEmployer401k, {
              hint: "What your employer puts in per year — match and any other employer money, not counting your own contributions.",
            })}
            {moneyField("Employer HSA", jobEmployerHsa, setJobEmployerHsa, {
              hint: "What your employer puts into the HSA per year. It counts against the HSA limit, so your own payroll contribution is the rest of the limit.",
            })}
          </div>
          <p className="mt-2 text-xs text-[var(--dim)]">
            These three fields save with your plan, like every other input —
            the tab opens with them filled in. The quit ages and runs below are
            scratch and never save.
          </p>
          {wySalaryBlank && (
            <p className="mt-3 text-sm" role="note">
              Add a salary in Your job to price work years.
            </p>
          )}

          <h3 className="mt-6 border-b border-[var(--border)] pb-2 text-base font-semibold">
            Compare quitting at
          </h3>
          <div className="mt-3 grid grid-cols-3 gap-3 sm:max-w-md">
            {wyQuitAges.map((v, i) =>
              numField(
                ["First quit age", "Second quit age", "Third quit age"][i] ?? `Quit age ${i + 1}`,
                v,
                (next) => {
                  setWyQuitAges((prev) =>
                    prev.map((p, j) => (j === i ? next : p)),
                  );
                  setWyError("");
                },
              ),
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              aria-label="Compare quit ages"
              className="rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              disabled={runWyMut.isPending}
              onClick={runWorkYears}
            >
              {runWyMut.isPending ? "Pricing…" : "Compare"}
            </button>
            {runWyMut.isPending && (
              <span className="text-xs text-[var(--dim)]">
                Each quit age is a full optimizer run — this can take a minute.
              </span>
            )}
          </div>
          {wyError && (
            <p className="mt-2 text-sm text-[var(--bad)]" role="alert">
              {wyError}
            </p>
          )}

          {wyResult?.ok && wyResult.rows.length > 0 && (
            <>
              {wyStale && (
                <p className="mt-3 text-sm text-[var(--dim)]" role="note">
                  Inputs have changed since this run — Compare again for
                  current figures.
                </p>
              )}
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[880px] text-sm">
                  <thead>
                    <tr className="border-b border-[var(--border)] text-left">
                      <th scope="col" className="px-2 py-2 font-medium">Quit age</th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">Work years</th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">Banked while working</th>
                      <th scope="col" className="px-2 py-2 font-medium">Best plan</th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">All-in lifetime tax</th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">Ending wealth (after-tax)</th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">SS collected</th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">All-in tax if claiming at 67</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wyResult.rows.map((row) => {
                      const isMostWealth =
                        Math.round(row.endingAfterTax) ===
                        Math.max(
                          ...wyResult.rows.map((r) =>
                            Math.round(r.endingAfterTax),
                          ),
                        );
                      return (
                      <tr
                        key={row.quitAge}
                        className={`border-b border-[var(--border)]${isMostWealth ? " bg-[var(--accent-soft)]" : ""}`}
                      >
                        <td className="tnum px-2 py-2 font-medium">
                          {row.quitAge}
                          {isMostWealth && (
                            <span className="mt-1 block w-fit rounded-full border border-[var(--accent)] px-2 py-0.5 text-xs font-medium whitespace-nowrap text-[var(--accent)]">
                              Most ending wealth
                            </span>
                          )}
                        </td>
                        <td className="tnum px-2 py-2 text-right">{row.workYears}</td>
                        <td className="tnum px-2 py-2 text-right">{fmtDollars(row.ledger.banked)}</td>
                        <td className="px-2 py-2">
                          {row.winnerName}
                          {row.winnerClaimLabel ? (
                            <span className="block text-xs text-[var(--dim)]">
                              {row.winnerClaimLabel}
                            </span>
                          ) : (
                            <span className="block text-xs text-[var(--dim)]">
                              {row.winnerWindowLabel}
                            </span>
                          )}
                        </td>
                        <td className="tnum px-2 py-2 text-right">{fmtDollars(row.allInTax)}</td>
                        <td className={`tnum px-2 py-2 text-right ${isMostWealth ? "font-bold" : "font-medium"}`}>{fmtDollars(row.endingAfterTax)}</td>
                        <td className="tnum px-2 py-2 text-right">{fmtDollars(row.ssCollected)}</td>
                        <td className="tnum px-2 py-2 text-right">
                          {row.claim67AllInTax != null ? fmtDollars(row.claim67AllInTax) : "—"}
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {(() => {
                const base = wyResult.rows[0];
                if (!base) return null;
                const signed = (n: number) =>
                  n >= 0 ? `+${fmtDollars(n)}` : fmtDollars(n);
                return (
                  <div className="mt-3 space-y-1">
                    {wyResult.rows.slice(1).map((row) => {
                      const years = row.quitAge - base.quitAge;
                      const wealthDiff =
                        Math.round(row.endingAfterTax) - Math.round(base.endingAfterTax);
                      const taxDiff =
                        Math.round(row.allInTax) - Math.round(base.allInTax);
                      const cents =
                        wealthDiff > 0
                          ? Math.round((taxDiff / wealthDiff) * 100)
                          : null;
                      return (
                        <p key={row.quitAge} className="tnum text-sm">
                          Working to {row.quitAge}: {signed(wealthDiff)} ending
                          wealth ({signed(years > 0 ? Math.round(wealthDiff / years) : wealthDiff)} per year),{" "}
                          {signed(taxDiff)} lifetime tax ({signed(years > 0 ? Math.round(taxDiff / years) : taxDiff)} per year)
                          {cents != null
                            ? ` — about ${cents}¢ of tax per $1 of wealth`
                            : ""}
                          .
                        </p>
                      );
                    })}
                  </div>
                );
              })()}
              <div className="mt-3 space-y-1">
                {wyResult.rows
                  .filter((row) => row.workYears > 0)
                  .map((row) => (
                    <p key={row.quitAge} className="tnum text-xs text-[var(--dim)]">
                      Quit {row.quitAge} — while working: salary{" "}
                      {fmtDollars(row.ledger.grossSalary)}, federal tax{" "}
                      {fmtDollars(row.ledger.federal)}
                      {row.ledger.state !== 0 ? (
                        <>, state tax{" "}{fmtDollars(row.ledger.state)}</>
                      ) : null}
                      , payroll tax{" "}
                      {fmtDollars(row.ledger.payrollTax)} (Social Security{" "}
                      {fmtDollars(row.ledger.payrollSocialSecurity)}, Medicare{" "}
                      {fmtDollars(row.ledger.payrollMedicare)}
                      {row.ledger.payrollAdditionalMedicare !== 0 ? (
                        <>, additional Medicare{" "}
                        {fmtDollars(row.ledger.payrollAdditionalMedicare)}</>
                      ) : null}
                      ); banked{" "}
                      {fmtDollars(row.ledger.pretaxContributions)} to Pre-tax,{" "}
                      {fmtDollars(row.ledger.rothContributions)} to Roth,{" "}
                      {fmtDollars(row.ledger.hsaContributions)} to HSA, and{" "}
                      {fmtDollars(row.ledger.surplusBanked)} of leftover salary
                      to Taxable.
                      {row.ledger.shortfall > 0 ? (
                        <>
                          {" "}
                          Shortfall: {fmtDollars(row.ledger.shortfall)} of
                          work-year spending and tax ran past the salary plus
                          the Taxable balance, which stops at $0 — that part
                          was not funded.
                        </>
                      ) : null}
                    </p>
                  ))}
              </div>
            </>
          )}
          {wyResult && !wyResult.ok && !wyError && (
            <p className="mt-3 text-sm text-[var(--bad)]" role="alert">
              {wyResult.reason}
            </p>
          )}

          <div className="mt-5">
            <p className="max-w-3xl text-sm text-[var(--dim)]">
              Salary is held flat — no raises — and every limit comes from the
              app&rsquo;s law tables, with the latest row used for later years.
            </p>
            <ExplainerInfoTip
              id="roth.workYearsHow"
              label="how work years are priced"
            >
<p>
                Work years assume employer health coverage, so no ACA premium
                credit is priced for those years, and an HSA-eligible plan, so
                the HSA limit applies — the family limit for joint filers,
                the self-only limit for single and head-of-household
                filers. That is a simplification: a head of household with
                family coverage can legally use the family limit. Salary
                covers the plan&rsquo;s annual spending in work years; the
                portfolio is not drawn.
              </p>
              <p>
                Contributions stack to the legal caps each year: the 401(k)
                deferral, the catch-up (the larger 60–63 limit in those
                years), employer money, and the mega backdoor — the
                after-tax room left under the overall cap, which assumes
                your plan allows after-tax contributions. Employer money
                fills the same caps, so it replaces mega-backdoor room
                dollar for dollar rather than adding on top.
              </p>
              <p>
                At higher pay the law requires catch-ups to be Roth; that
                rule keys on the prior year&rsquo;s wages, and this model
                uses the salary you entered as the wage proxy. Payroll tax
                is the employee share: Social Security up to the
                year&rsquo;s wage base, Medicare on all wages, and the
                additional Medicare tax over $250,000 (joint) or $200,000
                (single). The salary years are taxed at your plan&rsquo;s
                state tax rate, the same rate the conversion years use.
              </p>
              <p>
                If a work year&rsquo;s spending and tax run past the salary,
                the Taxable balance covers the gap down to $0 — it never
                goes negative — and whatever is left uncovered is reported
                as a shortfall next to that row&rsquo;s ledger, not folded
                silently into the balances the retirement years start from.
              </p>
              <p>
                Your Social Security benefit is held at the amount on your
                plan — extra work years do not raise it here. Ending wealth
                is in age-95 nominal dollars at your plan&rsquo;s return
                assumption, after the tax on the pre-tax balance still
                standing.
              </p>
              <p>
                The work years are priced with both spouses living. If your
                plan has a survivor scenario turned on, it applies to the
                conversion years after work stops.
              </p>
            </ExplainerInfoTip>
          </div>
        </section>
      )}

      {face === "settings" && resultsMode === "gift" && (
        <section className={sectionCls} aria-label="Gift stock">
          <h2 className="text-base font-semibold">
            Gift stock to a child
            <InfoNote
              ariaLabel="About gifting stock to a child"
              text="Describe one gift of appreciated stock to one child. The plan is priced twice with the same optimizer as the Optimize tab — as saved, and with the gifted shares gone from your Taxable bucket from the gift year — and the side effects are reported as their own ledgers: what your child nets when they sell, the gift-tax exclusion, and the step-up you give up. The gift is a what-if: it never changes your saved plan's own runs."
            />
          </h2>

          <h3 className="mt-5 border-b border-[var(--border)] pb-2 text-base font-semibold">
            The gift
          </h3>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {numField("Your age in the gift year", giftAge, setGiftAge, {
              hint: "Leave blank to gift in the plan's first year.",
            })}
            {moneyField("Value of the shares you gift", giftAmount, setGiftAmount, {
              hint: "What the shares are worth in the gift year.",
            })}
            {moneyField("Your basis in those shares", giftBasis, setGiftBasis, {
              hint: "Your total cost basis in the shares — your child inherits it (carryover basis).",
            })}
            {numField("Child's birth year", giftKidBirthYear, setGiftKidBirthYear, {
              hint: "Drives the child's age at the sale, and the kiddie tax.",
            })}
            {moneyField("Child's other income in the sale year", giftKidOtherIncome, setGiftKidOtherIncome, {
              hint: "Their own income that year, priced as ordinary income on their standalone return.",
            })}
            {numField("Your age in the year the shares are sold", giftSaleAge, setGiftSaleAge, {
              hint: "Optional. When set, the as-saved side prices you selling the shares yourself that year, so the comparison includes the gain you avoid. Blank: no sale is priced on either side.",
            })}
            <div className="flex items-start gap-2 pt-6">
              <input
                id="roth-gift-student"
                type="checkbox"
                aria-label="Child is a full-time student"
                className="mt-1 h-4 w-4"
                checked={giftKidStudent === true}
                onChange={(e) => setGiftKidStudent(e.target.checked)}
              />
              <label htmlFor="roth-gift-student" className="text-sm">
                Child is a full-time student — matters for the kiddie tax,
                which reaches full-time students under 24.
              </label>
            </div>
          </div>
          <p className="mt-2 text-xs text-[var(--dim)]">
            These fields save with your plan, like every other input — the
            tab opens with them filled in. They are read only by this
            comparison.
          </p>
          {giftAmountBlank && (
            <p className="mt-3 text-sm" role="note">
              Enter the value of the shares you might gift, and this tab will
              price the gift against your plan.
            </p>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              aria-label="Compare gifting the stock"
              className="rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              disabled={runGiftMut.isPending || giftAmountBlank}
              onClick={runGiftCompare}
            >
              {runGiftMut.isPending ? "Pricing…" : "Compare"}
            </button>
            {runGiftMut.isPending && (
              <span className="text-xs text-[var(--dim)]">
                Each side is a full optimizer run — this can take a minute.
              </span>
            )}
          </div>
          {(giftError || giftGuardNow) && (
            <p className="mt-2 text-sm text-[var(--bad)]" role="alert">
              {giftError || giftGuardNow}
            </p>
          )}

          {giftResult?.ok && !giftAmountBlank && !giftGuardNow && giftResult.hasGift && giftResult.baseline && giftResult.withGift && giftResult.child && giftResult.giftTax && (
            <>
              {giftStale && (
                <p className="mt-3 text-sm text-[var(--dim)]" role="note">
                  Inputs have changed since this run — Compare again for
                  current figures.
                </p>
              )}
              {giftResult.capped && (
                <p className="mt-3 text-sm font-medium" role="note">
                  Gift modeled at {fmtDollars(giftResult.effectiveAmount)} —
                  that&rsquo;s all your Taxable bucket holds at age{" "}
                  {giftResult.giftAge} of the{" "}
                  {fmtDollars(giftResult.typedAmount)} entered.
                </p>
              )}
              <h3 className="mt-6 border-b border-[var(--border)] pb-2 text-base font-semibold">
                Your conversion plan, before and after
              </h3>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="border-b border-[var(--border)] text-left">
                      <th scope="col" className="px-2 py-2 font-medium"> </th>
                      <th scope="col" className="px-2 py-2 font-medium">Best plan</th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">Lifetime net cost</th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">Ending wealth (after-tax)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(
                      [
                        ["As saved", giftResult.baseline],
                        ["With the gift", giftResult.withGift],
                      ] as const
                    ).map(([label, side]) => (
                      <tr key={label} className="border-b border-[var(--border)]">
                        <td className="px-2 py-2 font-medium">{label}</td>
                        <td className="px-2 py-2">
                          {side.winnerName}
                          {side.claimLabel ? (
                            <span className="block text-xs text-[var(--dim)]">
                              {side.claimLabel}
                            </span>
                          ) : null}
                        </td>
                        <td className="tnum px-2 py-2 text-right">{fmtDollars(side.netCost)}</td>
                        <td className="tnum px-2 py-2 text-right">{fmtDollars(side.endingAfterTax)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {(() => {
                const base = giftResult.baseline;
                const giftSide = giftResult.withGift;
                const signed = (n: number) =>
                  n >= 0 ? `+${fmtDollars(n)}` : fmtDollars(n);
                const costDelta =
                  Math.round(giftSide.netCost) - Math.round(base.netCost);
                const wealthDelta =
                  Math.round(giftSide.endingAfterTax) - Math.round(base.endingAfterTax);
                return (
                  <p className="tnum mt-3 text-sm">
                    With the gift: {signed(costDelta)} lifetime net cost,{" "}
                    {signed(wealthDelta)} ending wealth — the wealth
                    difference is the gifted shares (and their growth) living
                    in your child&rsquo;s hands instead of yours; the
                    child&rsquo;s ledger below shows what they net.
                  </p>
                );
              })()}
              {!giftResult.salePriced && (
                <p className="mt-2 max-w-3xl text-sm text-[var(--dim)]" role="note">
                  No sale year is set, so no sale is priced on either side —
                  this comparison reflects the balance and draw-order effects
                  only. The child&rsquo;s figures below are priced as if
                  they sell in the gift year; set a sale year above to price
                  the sale you would otherwise have made yourself.
                </p>
              )}

              <h3 className="mt-6 border-b border-[var(--border)] pb-2 text-base font-semibold">
                Moved to your child
              </h3>
              <div className="tnum mt-3 space-y-1 text-sm">
                <p>
                  Worth when they sell ({giftResult.saleYear}):{" "}
                  {fmtDollars(giftResult.child.valueAtSale)} — the gift grown
                  at your plan&rsquo;s expected return
                  {giftResult.salePriced
                    ? ` from the gift year (${giftResult.giftYear}) to the sale year.`
                    : "."}
                </p>
                {giftResult.child.gain > 0 ? (
                  <p>
                    Their gain at your carryover basis:{" "}
                    {fmtDollars(giftResult.child.gain)}.
                  </p>
                ) : giftResult.child.gain < 0 ? (
                  <p>
                    Their gain at your carryover basis: $0 — the shares are
                    worth less than your basis at these figures (a{" "}
                    {fmtDollars(Math.abs(giftResult.child.gain))} loss), and
                    no tax is owed on a loss.
                  </p>
                ) : (
                  <p>
                    Their gain at your carryover basis: $0 — at these
                    figures the sale recognizes no gain or loss, and no tax
                    is owed.
                  </p>
                )}
                {giftResult.child.childTax != null ? (
                  <p>
                    Their federal tax on the sale:{" "}
                    {fmtDollars(giftResult.child.childTax)}
                    {giftResult.child.kiddieGate
                      ? ` — the kiddie tax applies (age ${giftResult.child.kidAge} at the sale): gain above the ${fmtDollars(giftResult.child.kiddieThreshold)} threshold is stacked onto your own return the way Form 8615 prices it — it fills whatever is left of your 0% capital-gains space first, then prices at your 15%/20% rates (your marginal capital-gains rate is ${giftResult.child.parentsMarginalCgRate}%).`
                      : ` — priced on their own standalone return, with their own 0% capital-gains space.`}
                  </p>
                ) : (
                  <p>
                    Their tax on the sale isn&rsquo;t priced — enter the
                    child&rsquo;s birth year above so their age at the sale
                    (and the kiddie tax) can be worked out.
                  </p>
                )}
                <p>
                  Net to your child: {fmtDollars(giftResult.child.netToChild)}.
                </p>
                {giftResult.child.gain > 0 && (
                  <p className="text-[var(--dim)]">
                    If you had held these shares until death, the{" "}
                    {fmtDollars(giftResult.child.gain)} gain would have been
                    wiped out by the basis step-up. Gifting gives that up — the
                    child pays tax on the full gain.
                  </p>
                )}
              </div>

              <h3 className="mt-6 border-b border-[var(--border)] pb-2 text-base font-semibold">
                Gift tax
              </h3>
              <div className="mt-3 max-w-3xl space-y-1 text-sm">
                {giftResult.giftTax.withinExclusion ? (
                  <p>
                    The gift fits the annual exclusion —{" "}
                    {fmtDollars(giftResult.giftTax.exclusionPerDonor)} per
                    donor per child
                    {giftResult.giftTax.donors === 2
                      ? `, ${fmtDollars(giftResult.giftTax.exclusionAvailable)} for the two of you with gift-splitting between spouses`
                      : ""}
                    — so there is no gift tax,{" "}
                    {giftResult.giftTax.donors === 2
                      ? "but splitting the gift between spouses takes an election on a gift-tax return (Form 709), even though no tax is due."
                      : "no return needed for this gift."}
                  </p>
                ) : (
                  <p>
                    The annual exclusion covers{" "}
                    {fmtDollars(giftResult.giftTax.exclusionAvailable)} of
                    this gift (
                    {fmtDollars(giftResult.giftTax.exclusionPerDonor)} per
                    donor
                    {giftResult.giftTax.donors === 2
                      ? ", two donors with gift-splitting between spouses"
                      : ""}
                    ). The {fmtDollars(giftResult.giftTax.excess)} over the
                    exclusion counts against the lifetime estate-and-gift
                    exemption, and a gift-tax return (Form 709) is due for
                    the gift year. No gift tax is priced here, and whether
                    the lifetime exemption covers the excess has not been
                    checked — if the exemption has already been used up,
                    gift tax could be due.
                  </p>
                )}
              </div>

              {giftResult.fafsaApplies && (
                <>
                  <h3 className="mt-6 border-b border-[var(--border)] pb-2 text-base font-semibold">
                    College aid watch-out
                  </h3>
                  <p className="mt-3 max-w-3xl text-sm" role="note">
                    College years: the child&rsquo;s sale year (
                    {giftResult.saleYear}) is a prior-prior year for a college
                    fall inside the college years on your plan — assets and
                    income in a child&rsquo;s name count harder for college
                    aid than the same money in a parent&rsquo;s name, so a
                    sale (or the shares themselves) in the child&rsquo;s name
                    that year can reduce aid.
                  </p>
                </>
              )}
            </>
          )}
          {giftResult && !giftResult.ok && !giftError && (
            <p className="mt-3 text-sm text-[var(--bad)]" role="alert">
              {giftResult.reason}
            </p>
          )}

          <div className="mt-5">
            <p className="max-w-3xl text-sm text-[var(--dim)]">
              The priced conversion effect is the avoided sale gain plus the
              balance and draw-order effect — here is exactly what is and
              isn&rsquo;t priced.
            </p>
            <ExplainerInfoTip
              id="roth.giftHow"
              label="how the gift comparison is priced"
            >
<p>
                How the gifted shares&rsquo; yield is priced depends on
                the dividend and interest yields entered on your plan.
                When no yields are entered, no yearly yield is priced
                anywhere — so the gifted shares&rsquo; dividends are NOT
                priced as income removed from your return. When dividend
                or interest yields are entered, your priced yield income
                is worked out each year on your Taxable balance after
                the gift — so from the gift year onward, the gifted
                shares no longer generate priced yield income for you.
                What is priced on your side either way is the gain you
                avoid when a sale year is set (that gain would otherwise
                have stacked into the sale year&rsquo;s brackets, NIIT,
                and ACA / IRMAA MAGI, and taken room from that
                year&rsquo;s conversion), plus the balance and draw-order
                effect of the shares leaving your Taxable bucket at the
                gift year.
              </p>
              <p>
                The gifted shares are grown at your plan&rsquo;s expected
                return from the gift year to the sale year, for both the
                sale you avoid and your child&rsquo;s sale. Your
                child&rsquo;s tax is the tax on the sale itself: their
                standalone federal return priced with the gain and again
                without it, and the difference reported — so the tax on
                their other income is never counted as the sale&rsquo;s
                tax. No state tax is priced for the child.
              </p>
              <p>
                Estate tax is not priced — the gift-tax ledger reports the
                annual exclusion and the lifetime-exemption use only. One
                gift to one child per run: for several children or several
                years of gifts, run the comparison once per gift.
              </p>
            </ExplainerInfoTip>
          </div>
        </section>
      )}

      {showPlanWorkspace && planInputs && (
        <div
          aria-label="What the results are calculated with"
          className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-3"
        >
          <p className="text-sm">
            <strong>Calculated with:</strong>
          </p>
          <div
            className={`mt-2 flex h-9 w-full overflow-hidden rounded-[var(--radius)]${calcStartTotal > 0 ? "" : " items-center justify-center border border-[var(--border)] bg-[var(--surface-alt)]"}`}
            role="img"
            aria-label={
              calcStartTotal > 0
                ? `Starting balances: ${calcStartSegs
                    .map(
                      (s) =>
                        `${s.label} ${fmtDollars(s.dollars)}, ${((s.dollars / calcStartTotal) * 100).toFixed(1)} percent`,
                    )
                    .join("; ")}`
                : "Starting balances: none yet — all five balances are $0"
            }
          >
            {calcStartTotal <= 0 && (
              // Zero state (2026-10-25): with every balance at $0
              // no segment draws, and the bare container used to
              // read as a blank void between the heading and the
              // legend. The empty track keeps the bar's exact
              // height and outline, labelled, so the strip's
              // layout never jumps; the legend below still echoes
              // each $0 balance, unchanged.
              <span className="text-xs text-[var(--dim)]">
                No starting balances yet
              </span>
            )}
            {calcStartSegs
              .filter((s) => s.dollars > 0)
              .map((s) => (
                <div
                  key={s.key}
                  className="flex h-full min-w-0 items-center justify-center overflow-hidden px-1"
                  style={{
                    width: `${calcStartTotal > 0 ? (s.dollars / calcStartTotal) * 100 : 0}%`,
                    background: s.color,
                  }}
                >
                  {calcStartTotal > 0 && (s.dollars / calcStartTotal) * 100 >= 7 && (
                    <span className="text-xs font-semibold whitespace-nowrap text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.45)]">
                      {s.label}
                    </span>
                  )}
                </div>
              ))}
          </div>
          <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5">
            {calcStartSegs.map((s) => (
              <li
                key={s.key}
                className="tnum flex items-baseline gap-1.5 text-sm whitespace-nowrap"
              >
                <span
                  aria-hidden="true"
                  className="inline-block h-2.5 w-2.5 shrink-0 self-center rounded-full"
                  style={{ background: s.color }}
                />
                <span className="font-medium">{s.label}</span>
                <span>{fmtDollars(s.dollars)}</span>
                <span className="text-[var(--dim)]">
                  ·{" "}
                  {calcStartTotal > 0
                    ? ((s.dollars / calcStartTotal) * 100).toFixed(1)
                    : "0.0"}
                  %
                </span>
                {s.key === "taxable" &&
                !balanceOverrides.taxable &&
                (parseDollars(taxableExclude) ?? 0) > 0 ? (
                  <span className="text-[var(--dim)]">
                    (after excluding{" "}
                    {fmtDollars(Math.max(0, parseDollars(taxableExclude) ?? 0))}{" "}
                    from the plan)
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="tnum mt-2 text-sm">
            Spending {fmtDollars(planInputs.annualSpending)}/yr · Convert ages{" "}
            {planInputs.windowStartAge} → {planInputs.windowStopAge} · Fill to:{" "}
            {ceilingsSummary} · Draw order {drawOrderLabel(planInputs.drawOrder)}
            {planInputs.drawOrderSwitchAge != null && planInputs.drawOrderAfter != null
              ? `, then ${drawOrderLabel(planInputs.drawOrderAfter)} from ${planInputs.drawOrderSwitchAge}`
              : ""}{" "}
            · Return {planInputs.expectedReturnPct}% ·{" "}
            {FILING_LABELS[planInputs.filingStatus]}
            {planInputs.survivorEnabled && planInputs.survivorDeathYear != null
              ? ` · Survivor scenario: ${planInputs.survivorWho === "spouse" ? "spouse dies" : "you die"} in ${planInputs.survivorDeathYear} — single filer from ${planInputs.survivorDeathYear + 1}`
              : ""}
            {reserveSet
              ? ` · Pre-tax reserve ${fmtDollars(planInputs.preservePretax ?? 0)} never converted, scored at the ${reserveExitPct}% exit rate`
              : ""}
          </p>
          <p className="mt-1 text-xs text-[var(--dim)]" aria-live="polite">
            {diffLabels.length === 0 ? (
              "These are the seeded defaults for this view."
            ) : (
              <>
                Custom inputs — differs from the seeded defaults
                <InfoNote
                  ariaLabel="Which inputs differ from the seeded defaults"
                  text={`Custom inputs — differs from the seeded defaults in: ${diffLabels.join(", ")}.`}
                />
              </>
            )}
          </p>
        </div>
      )}

      {showPlanWorkspace && planInputs && acaNotPricedYears.length > 0 && (
        <div
          role="note"
          className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm"
        >
          <strong>ACA premium credit is not priced yet</strong> for{" "}
          {acaNotPricedYears.length} year{acaNotPricedYears.length === 1 ? "" : "s"}
          {acaNotPricedYears.length > 1
            ? ` between ${acaNotPricedYears[0]!.year} and ${acaNotPricedYears[acaNotPricedYears.length - 1]!.year}`
            : ` (${acaNotPricedYears[0]!.year})`}
          : no ACA benchmark premium is entered for those years, so the credit is
          modeled as $0 kept. Enter the ACA benchmark premium above to price it — at these
          ages the credit can be worth more than the tax on a year's conversion.
        </div>
      )}

      {showPlanWorkspace && planInputs && reserveSet && reserveBindYears.length > 0 && (
        <div
          role="note"
          className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm"
        >
          <strong>Pre-tax reserve held.</strong> Conversions were capped by the{" "}
          {fmtDollars(planInputs.preservePretax ?? 0)} reserve in{" "}
          {reserveBindYears.length} year{reserveBindYears.length === 1 ? "" : "s"}
          {reserveBindYears.length > 1
            ? ` (${reserveBindYears[0]!.year}–${reserveBindYears[reserveBindYears.length - 1]!.year})`
            : ` (${reserveBindYears[0]!.year})`}
          : the combined pre-tax balance never converts below it. The ending
          pre-tax is scored with the preserved part at the {reserveExitPct}% exit
          rate and anything above the reserve at the {planInputs.heirRatePct}% heir
          rate.
        </div>
      )}

      {showPlanWorkspace && planInputs && allWarnings.length > 0 && (
        <WatchOutsPanel warnings={allWarnings} open={watchOutsOpen} onToggle={toggleWatchOuts} />
      )}

      {face === "settings" && resultsMode === "optimize" && planInputs && (
        <section className={sectionCls} aria-label="Lifetime-tax optimizer">
          <h2 className="text-base font-semibold">
            Lifetime-tax optimizer
            <InfoNote
              ariaLabel="About how the optimizer searches"
              text="The search screens every claiming-age combination, then fully prices every combination against every combination of fill ceiling, conversion window, guardrail, and bunching — each candidate a full lifetime simulation. Do Nothing is always a candidate, so the winner can never score worse than doing nothing. Running the search changes nothing saved — save a result as a scenario to keep it."
            />
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-[var(--dim)]">
            The optimizer searches for the fill strategy with the lowest{" "}
            <strong>lifetime net cost</strong>, in today&rsquo;s dollars: lifetime
            federal and state tax, plus pre-59½ withholding penalties, plus lifetime
            IRMAA surcharges, minus the ACA premium credit kept (tracked per year,
            never added to balances), plus a final tax on pre-tax money still standing
            at the end age at your heir rate ({planInputs.heirRatePct}%)
            {reserveSet
              ? ` — except the preserved ${fmtDollars(optResult?.winner?.preservedPretax ?? planInputs.preservePretax ?? 0)}, valued at its ${reserveExitPct}% exit rate`
              : ""}. That last
            term matters — unconverted pre-tax money is taxed eventually, through late
            RMDs or by heirs, so without it the search would convert too little.
            Ties on cost are broken by ending wealth.
          </p>
          <button
            type="button"
            aria-expanded={optHowOpen}
            aria-label="How the search works"
            className="mt-2 text-sm font-medium text-[var(--accent)] underline underline-offset-2 hover:text-[var(--text)]"
            onClick={toggleOptHow}
          >
            How the search works
          </button>
          {optHowOpen && (
          <p className="mt-2 max-w-3xl text-sm text-[var(--dim)]">
            The search is staged: every claiming-age combination
            is screened first, and every combination is then priced against the full
            strategy set — every combination of fill ceiling (each bracket top,
            each IRMAA tier line, the ACA cliff, and dollar steps in between) ×
            conversion window (stop at 65, stop the year before RMDs begin, or
            keep topping up through the RMD years) × the marginal-rate guardrail
            and ACA bunching variants — each candidate a full lifetime simulation,
            and each respecting the ceilings it switches on in its final priced
            years. Because every combination is fully priced, the winner is priced
            against — and can never lose to — either
            one-variable-at-a-time answer: the best conversions at your entered
            ages, or the best claiming ages under Do Nothing. Do Nothing is always
            a candidate, so the winner can never score worse than doing nothing.
            Social Security claiming ages are searched jointly with the strategies,
            not fixed in advance: for each person with a benefit entered who has
            not yet claimed, that person&rsquo;s attainable claiming ages are
            screened — from their current age (or 62 if they are younger) through
            70, plus their entered age itself when it is a claiming age past 70
            (the benefit at each age derived from the entered amount by the
            statutory early / delayed adjustments) — because the best claim age
            and the best conversion strategy depend on each other. A benefit that
            has already started is locked at its entered age and is not searched,
            because a claim that is already being paid cannot be changed. One steady return path drives the answer, so the
            sensitivity strips below show whether the winner changes at a return
            1% higher or lower, or at a different heir rate. Running the search
            changes nothing saved — save a result as a scenario to keep it.
          </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              aria-label="Run the lifetime-tax optimizer"
              className="rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              disabled={!planInputs || runOptimizerMut.isPending}
              onClick={() =>
                runOptimizerMut.mutate({
                  ...buildSavePayload(),
                  fafsaReportableAssetsCents: fafsaReportableAssetsCentsValue(),
                })
              }
            >
              {runOptimizerMut.isPending ? "Searching…" : "Run the optimizer"}
            </button>
            <span className="text-xs text-[var(--dim)]" aria-live="polite">
              {runOptimizerMut.isPending
                ? "Searching claiming ages and conversion strategies together — this can take a while."
                : optResult
                  ? optResult.reason
                  : "Runs with the inputs above exactly as they stand now."}
            </span>
          </div>
          {optRunFailed && (
            <p className="mt-2 text-sm text-[var(--bad)]" role="alert">
              The search didn&rsquo;t finish. Check your connection and run it again.
            </p>
          )}
          {optResult && !optResult.ok && (
            <p className="mt-2 text-sm text-[var(--bad)]" role="alert">
              {optResult.reason}
            </p>
          )}
          {optResult?.ok && optResult.winner && optResult.doNothing && (
            <div className="mt-4">
              <div className="rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--bg)] px-4 py-3">
                {winnerDegenerate ? (
                  <>
                    <p className="text-sm text-[var(--dim)]">Lifetime-tax optimizer result</p>
                    <p className="mt-0.5 text-base font-semibold">
                      No conversion beats Do Nothing on these inputs
                    </p>
                    <p className="text-sm text-[var(--dim)]">
                      The best converting strategy tested ties Do Nothing exactly — it
                      converts nothing in effect, so there is no winning strategy to
                      save. Tested {optResult.candidatesTested} strategies (including
                      Do Nothing), each a full lifetime simulation.
                      {optResult.doNothing.claimLabel
                        ? ` Do Nothing here is evaluated at the best claiming ages found — ${optResult.doNothing.claimLabel}.`
                        : ""}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-[var(--dim)]">Lowest lifetime net cost</p>
                    <p className="mt-0.5 text-base font-semibold">{optResult.winner.name}</p>
                    <p className="text-sm text-[var(--dim)]">
                      {optResult.winner.windowLabel}
                      {optResult.winner.guardrail
                        ? " · with the marginal-rate guardrail"
                        : ""}
                      {optResult.winner.bunching
                        ? " · with ACA bunching"
                        : ""}
                    </p>
                    {optResult.winner.claimLabel && (
                      <p className="text-sm font-medium text-[var(--text)]">
                        {optResult.winner.claimLabel}
                      </p>
                    )}
                  </>
                )}
                <p className="text-sm text-[var(--dim)]">
                  Draw order: {optResult.winner.drawOrderLabel}
                  {optResult.winner.drawOrder === drawOrder
                    ? " — your current order"
                    : ""}
                </p>
                <p className="tnum mt-2 text-xl font-semibold">
                  {fmtDollars(optResult.winner.netCost)}{" "}
                  <span className="text-sm font-normal text-[var(--dim)]">
                    {winnerDegenerate ? (
                      <>
                        lifetime net cost — $
                        {optResult.winner.savingVsDoNothing.toFixed(2)} saving vs Do
                        Nothing ({fmtDollars(optResult.doNothing.netCost)})
                      </>
                    ) : (
                      <>
                        lifetime net cost — {fmtDollars(optResult.winner.savingVsDoNothing)}{" "}
                        less than Do Nothing ({fmtDollars(optResult.doNothing.netCost)})
                      </>
                    )}
                  </span>
                </p>
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-[var(--dim)]">Lifetime tax (federal + state)</dt>
                    <dd className="tnum font-medium">{fmtDollars(optResult.winner.tax)}</dd>
                  </div>
                  {optResult.winner.penalty > 0 && (
                    <div>
                      <dt className="text-[var(--dim)]">Withholding penalties</dt>
                      <dd className="tnum font-medium">{fmtDollars(optResult.winner.penalty)}</dd>
                    </div>
                  )}
                  <div>
                    <dt className="text-[var(--dim)]">Lifetime IRMAA paid</dt>
                    <dd className="tnum font-medium">{fmtDollars(optResult.winner.irmaa)}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--dim)]">ACA credit kept</dt>
                    <dd className="tnum font-medium">−{fmtDollars(optResult.winner.acaCredit)}</dd>
                  </div>
                  {optResult.winner.educationRefundable > 0 && (
                    <div>
                      <dt className="text-[var(--dim)]">Refundable education credit (AOTC)</dt>
                      <dd className="tnum font-medium">−{fmtDollars(optResult.winner.educationRefundable)}</dd>
                    </div>
                  )}
                  <div>
                    <dt className="text-[var(--dim)]">Lifetime Social Security collected</dt>
                    <dd className="tnum font-medium">{fmtDollars(optResult.winner.ssCollected)}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--dim)]">
                      {reserveSet
                        ? "Terminal tax on leftover pre-tax (split at the reserve)"
                        : `Terminal tax on leftover pre-tax (at ${planInputs.heirRatePct}%)`}
                    </dt>
                    <dd className="tnum font-medium">{fmtDollars(optResult.winner.terminal)}</dd>
                    {reserveSet && (
                      <dd className="text-xs text-[var(--dim)]">
                        {fmtDollars(optResult.winner.preservedPretax)} preserved at the{" "}
                        {reserveExitPct}% exit rate →{" "}
                        {fmtDollars(optResult.winner.terminalPreserved)} ·{" "}
                        {fmtDollars(optResult.winner.excessPretax)} above the reserve at
                        the {planInputs.heirRatePct}% heir rate →{" "}
                        {fmtDollars(optResult.winner.terminalExcess)}
                      </dd>
                    )}
                  </div>
                </dl>
                <p className="mt-2 text-sm text-[var(--dim)]">
                  Do Nothing, for comparison: lifetime Social Security collected{" "}
                  {fmtDollars(optResult.doNothing.ssCollected)}.
                </p>
                {!winnerDegenerate && (
                  <>
                    <button
                      type="button"
                      aria-label="Save the winning strategy as a scenario"
                      className="mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium text-[var(--text)] hover:text-[var(--accent)] disabled:opacity-50"
                      disabled={saveScenario.isPending || data.scenarios.length >= 50}
                      onClick={() => saveOptimizerScenario(optResult.winner!)}
                    >
                      Save winner as scenario
                    </button>

                  </>
                )}
              </div>
              {/* Priced levers (contract v69): the top distinct
                  strategies the search priced that beat the
                  saved plan, each with its exact gain vs the
                  saved plan from the optimizer's own figures
                  (gainVsSavedPlan = savedPlan.netCost −
                  candidate.netCost, computed server-side) and
                  the same Save-as-scenario action the runner-up
                  rows use. Improvements only — no score. When
                  nothing priced beats the saved plan, or Do
                  Nothing won, one line says so instead. */}
              <div className="mt-5">
                <h3 className="text-base font-semibold">
                  What would improve this plan
                </h3>
                {optResult.winnerIsDoNothing ||
                optResult.improvements.length === 0 ? (
                  <p className="mt-1 text-sm text-[var(--dim)]">
                    {optResult.winnerIsDoNothing
                      ? "Do Nothing won the search — and no strategy it priced beats your saved plan."
                      : "Your saved plan is the best the search found — no strategy it priced beats it."}
                  </p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {optResult.improvements.map((s) => (
                      <li
                        key={s.name + s.windowStopAge + String(s.guardrail) + String(s.bunching) + String(s.claimPrimaryAge) + String(s.claimSpouseAge) + s.drawOrder}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5"
                      >
                        <span className="min-w-0">
                          <span className="block text-sm font-medium">
                            {s.name}
                          </span>
                          <span className="block text-xs text-[var(--dim)]">
                            {s.windowLabel}
                            {s.guardrail ? " · guardrail" : ""}
                            {s.bunching ? " · bunching" : ""}
                            {" · Draw order: "}
                            {s.drawOrderLabel}
                          </span>
                          {s.claimLabel && (
                            <span className="block text-xs font-medium text-[var(--text)]">
                              {s.claimLabel}
                            </span>
                          )}
                        </span>
                        <span className="flex flex-wrap items-center gap-3">
                          <span className="tnum text-sm font-medium">
                            {fmtDollars(s.gainVsSavedPlan)} less than your
                            saved plan
                          </span>
                          <button
                            type="button"
                            aria-label={`Save ${s.name} as a scenario`}
                            className="rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-sm hover:text-[var(--accent)] disabled:opacity-50"
                            disabled={
                              saveScenario.isPending ||
                              data.scenarios.length >= 50
                            }
                            onClick={() => saveOptimizerScenario(s)}
                          >
                            Save as scenario
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {optResult.claimSearchNote && (
                <p className="mt-3 max-w-3xl text-sm text-[var(--dim)]">
                  {optResult.claimSearchNote}
                </p>
              )}
              {optResult.claimAgeTable.length > 0 && (
                <div className="mt-5">
                  <h3 className="text-base font-semibold">
                    Best strategy at each claiming age
                    <InfoNote
                      ariaLabel="About the claiming-age table"
                      text={`Every claiming age, fully priced: the best strategy found at that age, its lifetime net cost, and the Social Security it collects. The last column is the yearly benefit a surviving spouse would keep at that claim age — the larger of the two claimed benefits.${optResult.claimAgeFloor != null ? ` Ages below your earliest claiming age to consider (${optResult.claimAgeFloor}) are marked as below your floor — priced and shown, but the winner is chosen from the ages at or above it.` : ""}`}
                    />
                  </h3>
                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full min-w-[680px] text-sm">
                      <thead>
                        <tr className="border-b border-[var(--border)] text-left">
                          <th scope="col" className="px-2 py-2 font-medium">Claiming age</th>
                          <th scope="col" className="px-2 py-2 text-right font-medium">Your benefit / yr</th>
                          <th scope="col" className="px-2 py-2 font-medium">Best strategy at that age</th>
                          <th scope="col" className="px-2 py-2 text-right font-medium">Lifetime net cost</th>
                          <th scope="col" className="px-2 py-2 text-right font-medium">Lifetime Social Security collected</th>
                          <th scope="col" className="px-2 py-2 text-right font-medium">Survivor keeps / yr</th>
                        </tr>
                      </thead>
                      <tbody>
                        {optResult.claimAgeTable.map((row) => (
                          <tr
                            key={row.primaryAge}
                            className={`border-b border-[var(--border)] last:border-0 ${row.belowFloor ? "text-[var(--dim)]" : ""}`}
                          >
                            <td className="px-2 py-2 align-top">
                              <span className="tnum font-medium">{row.primaryAge}</span>
                              {row.isWinner && (
                                <span className="ml-2 rounded-full border border-[var(--accent)] px-2 py-0.5 text-xs font-medium text-[var(--accent)]">
                                  Winner
                                </span>
                              )}
                              {row.belowFloor && (
                                <span className="block text-xs">Below your floor</span>
                              )}
                            </td>
                            <td className="tnum px-2 py-2 text-right align-top">{fmtDollars(row.primaryAnnual)}</td>
                            <td className="px-2 py-2 align-top">
                              {row.best.name}
                              <span className="block text-xs text-[var(--dim)]">
                                {row.best.windowLabel}
                                {row.best.guardrail ? " · guardrail" : ""}
                                {row.best.bunching ? " · bunching" : ""}
                              </span>
                              {row.best.claimLabel && row.best.claimLabel !== `You claim at ${row.primaryAge}` && (
                                <span className="block text-xs text-[var(--dim)]">
                                  {row.best.claimLabel}
                                </span>
                              )}
                            </td>
                            <td className="tnum px-2 py-2 text-right align-top">{fmtDollars(row.best.netCost)}</td>
                            <td className="tnum px-2 py-2 text-right align-top">{fmtDollars(row.best.ssCollected)}</td>
                            <td className="tnum px-2 py-2 text-right align-top">{fmtDollars(row.survivorAnnual)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              {optResult.runnersUp.length > 0 && (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[560px] text-sm">
                    <thead>
                      <tr className="border-b border-[var(--border)] text-left">
                        <th scope="col" className="px-2 py-2 font-medium">Runner-up strategies</th>
                        <th scope="col" className="px-2 py-2 text-right font-medium">Lifetime net cost</th>
                        <th scope="col" className="px-2 py-2 text-right font-medium">Lifetime Social Security collected</th>
                        <th scope="col" className="px-2 py-2 text-right font-medium">Saving vs Do Nothing</th>
                        <th scope="col" className="px-2 py-2 text-right font-medium">
                          <span className="sr-only">Save</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {optResult.runnersUp.map((s) => (
                        <tr key={s.name + s.windowStopAge + String(s.guardrail) + String(s.bunching) + String(s.claimPrimaryAge) + String(s.claimSpouseAge) + s.drawOrder} className="border-b border-[var(--border)] last:border-0">
                          <td className="px-2 py-2">
                            {s.name}
                            <span className="block text-xs text-[var(--dim)]">
                              {s.windowLabel}
                              {s.guardrail ? " · guardrail" : ""}
                              {s.bunching ? " · bunching" : ""}
                            </span>
                            <span className="block text-xs text-[var(--dim)]">
                              Draw order: {s.drawOrderLabel}
                            </span>
                            {s.claimLabel && (
                              <span className="block text-xs font-medium text-[var(--text)]">
                                {s.claimLabel}
                              </span>
                            )}
                          </td>
                          <td className="tnum px-2 py-2 text-right">{fmtDollars(s.netCost)}</td>
                          <td className="tnum px-2 py-2 text-right">{fmtDollars(s.ssCollected)}</td>
                          <td className="tnum px-2 py-2 text-right">{fmtDollars(s.savingVsDoNothing)}</td>
                          <td className="px-2 py-2 text-right">
                            <button
                              type="button"
                              aria-label={`Save ${s.name} as a scenario`}
                              className="rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-sm hover:text-[var(--accent)] disabled:opacity-50"
                              disabled={saveScenario.isPending || data.scenarios.length >= 50}
                              onClick={() => saveOptimizerScenario(s)}
                            >
                              Save as scenario
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {optResult.claimCombosTested > 1 && optResult.orderWinner && optResult.orderDoNothing && (
                <div className="mt-5 border-t border-[var(--border)] pt-4">
                  <h3 className="text-base font-semibold">
                    Draw order at your entered claiming ages
                    <InfoNote
                      ariaLabel="About the draw-order search"
                      text={`The claiming-age search above kept your draw order for every combination. This search holds the claiming ages at the ones entered above and prices all six draw orders against the same strategy set — ${optResult.orderTested} candidates, Do Nothing included — so the order itself competes.`}
                    />
                  </h3>
                  {optResult.orderWinnerIsDoNothing ? (
                    <p className="mt-3 text-sm text-[var(--dim)]">
                      Do Nothing wins here too: at your entered claiming ages, no
                      converting strategy in any draw order beats not converting.
                      Lifetime Social Security collected under Do Nothing:{" "}
                      {fmtDollars(optResult.orderDoNothing.ssCollected)}.
                    </p>
                  ) : (
                    <>
                      <div className="mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-4 py-3">
                        {optResult.orderWinnerIsCurrent ? (
                          <>
                            <p className="text-base font-semibold">
                              Your current draw order wins
                            </p>
                            <p className="mt-0.5 text-sm text-[var(--dim)]">
                              {optResult.orderWinner.name} ({optResult.orderWinner.windowLabel}
                              {optResult.orderWinner.guardrail ? " · guardrail" : ""}
                              {optResult.orderWinner.bunching ? " · bunching" : ""})
                              has the lowest lifetime net cost at your entered claiming
                              ages. No other draw order improves on it.
                            </p>
                          </>
                        ) : (
                          <>
                            <p className="text-sm text-[var(--dim)]">
                              Lowest lifetime net cost at your entered claiming ages
                            </p>
                            <p className="mt-0.5 text-base font-semibold">
                              {optResult.orderWinner.name}
                            </p>
                            <p className="text-sm text-[var(--dim)]">
                              {optResult.orderWinner.windowLabel}
                              {optResult.orderWinner.guardrail
                                ? " · with the marginal-rate guardrail"
                                : ""}
                              {optResult.orderWinner.bunching
                                ? " · with ACA bunching"
                                : ""}
                            </p>
                            <p className="text-sm font-medium text-[var(--text)]">
                              Draw order: {optResult.orderWinner.drawOrderLabel}
                            </p>
                          </>
                        )}
                        <p className="tnum mt-2 text-xl font-semibold">
                          {fmtDollars(optResult.orderWinner.netCost)}{" "}
                          <span className="text-sm font-normal text-[var(--dim)]">
                            lifetime net cost —{" "}
                            {fmtDollars(optResult.orderWinner.savingVsDoNothing)} less
                            than Do Nothing ({fmtDollars(optResult.orderDoNothing.netCost)})
                          </span>
                        </p>
                        <p className="mt-1 text-sm text-[var(--dim)]">
                          Lifetime Social Security collected{" "}
                          {fmtDollars(optResult.orderWinner.ssCollected)} — Do Nothing
                          collects {fmtDollars(optResult.orderDoNothing.ssCollected)}.
                        </p>
                        <button
                          type="button"
                          aria-label="Save the draw-order winner as a scenario"
                          className="mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium text-[var(--text)] hover:text-[var(--accent)] disabled:opacity-50"
                          disabled={saveScenario.isPending || data.scenarios.length >= 50}
                          onClick={() => saveOptimizerScenario(optResult.orderWinner!)}
                        >
                          Save winner as scenario
                        </button>

                      </div>
                      {optResult.orderRunnersUp.length > 0 && (
                        <div className="mt-3 overflow-x-auto">
                          <table className="w-full min-w-[560px] text-sm">
                            <thead>
                              <tr className="border-b border-[var(--border)] text-left">
                                <th scope="col" className="px-2 py-2 font-medium">Runner-up strategies</th>
                                <th scope="col" className="px-2 py-2 text-right font-medium">Lifetime net cost</th>
                                <th scope="col" className="px-2 py-2 text-right font-medium">Lifetime Social Security collected</th>
                                <th scope="col" className="px-2 py-2 text-right font-medium">Saving vs Do Nothing</th>
                                <th scope="col" className="px-2 py-2 text-right font-medium">
                                  <span className="sr-only">Save</span>
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {optResult.orderRunnersUp.map((s) => (
                                <tr key={s.name + s.windowStopAge + String(s.guardrail) + String(s.bunching) + s.drawOrder} className="border-b border-[var(--border)] last:border-0">
                                  <td className="px-2 py-2">
                                    {s.name}
                                    <span className="block text-xs text-[var(--dim)]">
                                      {s.windowLabel}
                                      {s.guardrail ? " · guardrail" : ""}
                                      {s.bunching ? " · bunching" : ""}
                                    </span>
                                    <span className="block text-xs text-[var(--dim)]">
                                      Draw order: {s.drawOrderLabel}
                                    </span>
                                  </td>
                                  <td className="tnum px-2 py-2 text-right">{fmtDollars(s.netCost)}</td>
                                  <td className="tnum px-2 py-2 text-right">{fmtDollars(s.ssCollected)}</td>
                                  <td className="tnum px-2 py-2 text-right">{fmtDollars(s.savingVsDoNothing)}</td>
                                  <td className="px-2 py-2 text-right">
                                    <button
                                      type="button"
                                      aria-label={`Save ${s.name} as a scenario`}
                                      className="rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-sm hover:text-[var(--accent)] disabled:opacity-50"
                                      disabled={saveScenario.isPending || data.scenarios.length >= 50}
                                      onClick={() => saveOptimizerScenario(s)}
                                    >
                                      Save as scenario
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
              <div className="mt-3 text-sm text-[var(--dim)]">
                <p>
                  Sensitivity — search re-run at a different return, at your entered
                  claiming ages and draw order (display only; nothing saved).
                </p>
                <ul className="mt-1 flex flex-col gap-1">
                  {optResult.sensitivity.map((s) => (
                    <li key={s.returnPct}>
                      At {s.returnPct}%: {s.winnerName} ({s.windowLabel} ·{" "}
                      {s.drawOrderLabel}) — {fmtDollars(s.netCost)} net cost,{" "}
                      {fmtDollars(s.ssCollected)} Social Security collected,{" "}
                      {s.changed ? "different winner" : "same winner"}.
                    </li>
                  ))}
                  <li>Base run: {planInputs.expectedReturnPct}%.</li>
                </ul>
              </div>
              {heirLines.length === 3 && (
                <div className="mt-3 text-sm text-[var(--dim)]">
                  <p>
                    Heir-rate sensitivity — the search re-run at other heir rates, at
                    your entered claiming ages and draw order (display only). A higher
                    heir rate favors converting more, because leftover pre-tax is
                    charged at that rate.
                  </p>
                  {heirSameWinner && heirFirst ? (
                    <p className="mt-1">
                      Same winner at every heir rate: {heirFirst.winnerName} (
                      {heirFirst.windowLabel} · draw order {heirFirst.drawOrderLabel})
                      {heirFirst.guardrail ? " · guardrail" : ""}
                      {heirFirst.bunching ? " · bunching" : ""} — net cost{" "}
                      {heirLines.map((l, i) => (
                        <span key={l.heirRatePct}>
                          {i > 0 ? ", " : ""}
                          {fmtDollars(l.netCost)} at {l.heirRatePct}% (
                          {fmtDollars(l.ssCollected)} Social Security collected)
                          {l.isCurrentRate ? " (your setting)" : ""}
                        </span>
                      ))}
                      .
                    </p>
                  ) : (
                    <ul className="mt-1 flex flex-col gap-1">
                      {heirLines.map((l) => (
                        <li key={l.heirRatePct}>
                          At a {l.heirRatePct}% heir rate
                          {l.isCurrentRate ? " (your setting)" : ""}: {l.winnerName}{" "}
                          ({l.windowLabel} · draw order {l.drawOrderLabel})
                          {l.guardrail ? " · guardrail" : ""}
                          {l.bunching ? " · bunching" : ""} —{" "}
                          {fmtDollars(l.netCost)} net cost,{" "}
                          {fmtDollars(l.ssCollected)} Social Security collected,{" "}
                          {fmtDollars(l.savingVsDoNothing)} saving vs Do Nothing.
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}
          {optResult?.ok && optResult.winner && optResult.doNothing && (
            <div className="mt-5 border-t border-[var(--border)] pt-4">
              <h3 className="text-base font-semibold">
                Market-uncertainty check
                {!winnerDegenerate && (
                  <InfoNote
                    ariaLabel="About the market-uncertainty check"
                    text="The winner above was picked on one steady return path — the expected return, earned the same every year. This check re-prices the winning strategy and Do Nothing across many varied return paths (both strategies on the same path), to show how robust the win is when returns bounce around."
                  />
                )}
              </h3>
              {winnerDegenerate ? (
                <p className="mt-1 max-w-3xl text-sm text-[var(--dim)]">
                  The optimizer&rsquo;s winner is Do Nothing on these inputs, so
                  there is no conversion strategy to stress-test.
                </p>
              ) : (
                <>
                  <div className="mt-3 flex flex-wrap items-end gap-3">
                    <div>
                      <label className={labelCls} htmlFor="roth-mc-volatility">
                        Volatility for this check (%)
                      </label>
                      <input
                        id="roth-mc-volatility"
                        className={`${inputCls} w-32`}
                        value={mcVolatility}
                        inputMode="decimal"
                        onChange={(e) => setMcVolatility(e.target.value)}
                      />
                    </div>
                    <button
                      type="button"
                      aria-label="Run the market-uncertainty check"
                      className="rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                      disabled={!mcRequestNow || runMcCheckMut.isPending}
                      onClick={() => {
                        if (mcRequestNow) runMcCheckMut.mutate(mcRequestNow);
                      }}
                    >
                      {runMcCheckMut.isPending ? "Running…" : "Run the check"}
                    </button>
                    <span className="text-xs text-[var(--dim)]" aria-live="polite">
                      {runMcCheckMut.isPending
                        ? "Pricing the winning strategy and Do Nothing across varied return paths — this can take a while."
                        : "Runs with the plan and the winning strategy exactly as they stand now. Running the check saves nothing."}
                    </span>
                  </div>
                  {mcRunFailed && (
                    <p className="mt-2 text-sm text-[var(--bad)]" role="alert">
                      The check didn&rsquo;t finish. Check your connection and run
                      it again.
                    </p>
                  )}
                  {mcResult && !mcResult.data.ok && (
                    <p className="mt-2 text-sm text-[var(--bad)]" role="alert">
                      {mcResult.data.reason}
                    </p>
                  )}
                  {mcResult?.data.ok && mcResultCurrent && (
                    <div className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-4 py-3">
                      <p className="text-sm text-[var(--dim)]">
                        Market-uncertainty check — figures across varied-return
                        paths, not the steady-path figures above
                      </p>
                      <p className="mt-0.5 text-base font-semibold">
                        Across {mcResult.data.pathsRun} varied-return paths
                        (volatility {mcResult.data.volatilityPct}%):
                      </p>
                      <ul className="mt-2 flex flex-col gap-1 text-sm">
                        <li>
                          The winning strategy beat Do Nothing in{" "}
                          {mcResult.data.winRatePct}% of paths.
                        </li>
                        <li>
                          Median advantage: {fmtDollars(mcResult.data.medianAdvantage)}{" "}
                          <span className="text-[var(--dim)]">
                            — advantage means Do Nothing&rsquo;s lifetime net cost
                            minus the winning strategy&rsquo;s, so a positive amount
                            is a win for the strategy.
                          </span>
                        </li>
                        <li>
                          10th–90th percentile advantage:{" "}
                          {fmtDollars(mcResult.data.p10Advantage)} to{" "}
                          {fmtDollars(mcResult.data.p90Advantage)}
                        </li>
                        <li>
                          Median lifetime net cost across paths — winning strategy{" "}
                          {fmtDollars(mcResult.data.winnerMedianNetCost)} · Do
                          Nothing {fmtDollars(mcResult.data.doNothingMedianNetCost)}
                        </li>
                      </ul>
                      <p className="mt-2 text-sm text-[var(--dim)]">
                        Varied returns are a stress test, not a prediction — the
                        recommendation above still comes from the plan&rsquo;s
                        single expected return.
                      </p>
                      <p className="mt-1 text-xs text-[var(--dim)]">
                        Same fixed set of paths every run (seed{" "}
                        {ROTH_MC_CHECK_SEED}) — re-running with the same inputs
                        reproduces these figures exactly.
                      </p>
                    </div>
                  )}
                  {mcResult?.data.ok && !mcResultCurrent && (
                    <p className="mt-3 max-w-3xl text-sm text-[var(--dim)]">
                      The plan or the check&rsquo;s settings changed since this
                      run, so these figures were priced on the earlier inputs —
                      run the check again for the current ones.
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </section>
      )}

      {showPlanWorkspace && planInputs && mainResult && (
        <section className={sectionCls} aria-label="Balances over time chart">
          <h2 className="text-base font-semibold">Balances by bucket — your fill settings</h2>
          <div className="mt-3 h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={balanceChartData} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="year" tick={{ fontSize: 12 }} stroke="var(--dim)" />
                <YAxis
                  tickFormatter={(v: number) => fmtCompactDollars(v)}
                  tick={{ fontSize: 12 }}
                  stroke="var(--dim)"
                  width={72}
                />
                <Tooltip
                  formatter={(value) => fmtDollars(Number(value ?? 0))}
                  contentStyle={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    color: "var(--text)",
                  }}
                />
                <Legend />
                <Area type="monotone" dataKey="Pre-tax" stackId="1" stroke={BUCKET_COLORS["Pre-tax"]} fill={BUCKET_COLORS["Pre-tax"]} fillOpacity={0.75} />
                <Area type="monotone" dataKey="Roth" stackId="1" stroke={BUCKET_COLORS.Roth} fill={BUCKET_COLORS.Roth} fillOpacity={0.75} />
                <Area type="monotone" dataKey="Taxable" stackId="1" stroke={BUCKET_COLORS.Taxable} fill={BUCKET_COLORS.Taxable} fillOpacity={0.75} />
                <Area type="monotone" dataKey="HSA" stackId="1" stroke={BUCKET_COLORS.HSA} fill={BUCKET_COLORS.HSA} fillOpacity={0.75} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </section>
      )}

      {showPlanWorkspace && planInputs && mainResult && (ceilings.irmaaTierCap != null || ceilings.acaCliffCap || ceilings.magiCap != null) && (
        <section className={sectionCls} aria-label="MAGI versus ceilings chart">
          <h2 className="text-base font-semibold">MAGI vs the ceilings switched on</h2>
          <div className="mt-3 h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={magiChartData} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="year" tick={{ fontSize: 12 }} stroke="var(--dim)" />
                <YAxis
                  tickFormatter={(v: number) => fmtCompactDollars(v)}
                  tick={{ fontSize: 12 }}
                  stroke="var(--dim)"
                  width={72}
                />
                <Tooltip
                  formatter={(value) => fmtDollars(Number(value ?? 0))}
                  contentStyle={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    color: "var(--text)",
                  }}
                />
                <Legend />
                <Line type="monotone" dataKey="MAGI" stroke="var(--accent)" strokeWidth={2} dot={false} />
                {ceilings.acaCliffCap && (
                  <Line type="monotone" dataKey="ACA MAGI" stroke="#059669" strokeWidth={2} dot={false} />
                )}
                {ceilings.irmaaTierCap != null && (
                  <Line type="monotone" dataKey="IRMAA cap" stroke="#e11d48" strokeDasharray="6 4" dot={false} />
                )}
                {ceilings.acaCliffCap && (
                  <Line
                    type="monotone"
                    dataKey="ACA cliff"
                    name="ACA cliff (400% FPL — tests ACA MAGI)"
                    stroke="#d97706"
                    strokeDasharray="6 4"
                    dot={false}
                  />
                )}
                {ceilings.magiCap != null && (
                  <Line type="monotone" dataKey="MAGI cap" stroke="#9333ea" strokeDasharray="6 4" dot={false} />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          {ceilings.acaCliffCap && (
            <p className="mt-2 text-xs text-[var(--dim)]">
              The cliff is tested against ACA MAGI, not MAGI — ACA MAGI adds back
              the non-taxable part of Social Security, so it runs higher once
              benefits flow. Drawn only for marketplace years (retirement year
              onward, while anyone is under 65).
            </p>
          )}
          {(ceilings.bracketTopPct != null || ceilings.ltcgZeroCap) && (
            <p className="mt-2 text-xs text-[var(--dim)]">
              The bracket and 0% capital-gains ceilings limit taxable income, not
              MAGI, so they are not drawn on this chart.
            </p>
          )}
        </section>
      )}

      {/* Plan income chart — one stacked bar per plan year, in the
          Playground projection chart's shape and colours, but driven
          by the SAVED plan's priced march (mainResult — the same
          simulateRothPlan result the year-by-year table below
          renders, so the chart can never disagree with the table and
          no new pricing happens here). Segment sourcing, bottom to
          top, every figure read straight off the year's own priced
          row: Interest ← detail.interestIncome; Qualified dividends
          ← detail.dividendIncome; Other ordinary income ←
          detail.otherOrdinary; Taxable Social Security ←
          detail.ssTaxable; RMD ← rmd (the table's RMD column);
          Pre-tax money out ← conversion (the table's Conversion
          column); Pre-tax draw for spending ←
          detail.extraPreTaxDraw; Long-term gains ← detail.ltcg;
          Tax-exempt interest ← detail.taxExemptInterest; and, only
          in a year the capital-loss ledger prices one, the
          capital-loss allowance as a negative top segment
          (−detail.lossAllowance). With that last segment the stack
          foots to the year's MAGI: the pieces sum to AGI and the
          tax-exempt interest completes MAGI, exactly as priceYear
          composes them. The line across the top is the table's MAGI
          column (magi); the dashed line is the ACA cliff
          (detail.aca.cliff) drawn only for marketplace years
          (acaActive with a priced cliff). Picking a bar opens that
          year's "Show the math" panel under the table below. */}
      {showPlanWorkspace && planInputs && mainResult && (() => {
        const planYears = mainResult.years;
        const segDefs = [
          { key: "interest", label: "Interest", color: "#2563eb", amount: (y: RothYear) => y.detail.interestIncome },
          { key: "qualdiv", label: "Qualified dividends", color: "#65a30d", amount: (y: RothYear) => y.detail.dividendIncome },
          { key: "other", label: "Other ordinary income", color: "#d97706", amount: (y: RothYear) => y.detail.otherOrdinary },
          { key: "ss", label: "Taxable Social Security", color: "#dc2626", amount: (y: RothYear) => y.detail.ssTaxable },
          { key: "rmd", label: "RMD", color: "#7c3aed", amount: (y: RothYear) => y.rmd },
          { key: "conv", label: "Pre-tax money out", color: "#14705a", amount: (y: RothYear) => y.conversion },
          { key: "extra", label: "Pre-tax draw for spending", color: "#14b8a6", amount: (y: RothYear) => y.detail.extraPreTaxDraw },
          { key: "gains", label: "Long-term gains", color: "#ea580c", amount: (y: RothYear) => y.detail.ltcg },
          { key: "taxexempt", label: "Tax-exempt interest", color: "#94a3b8", amount: (y: RothYear) => y.detail.taxExemptInterest },
          { key: "lossallow", label: "Capital-loss allowance", color: "#475569", amount: (y: RothYear) => -y.detail.lossAllowance },
        ] as const;
        const stackTotal = (y: RothYear): number =>
          segDefs.reduce((a, d) => a + d.amount(y), 0);
        const cliffOf = (y: RothYear): number | null =>
          y.acaActive ? y.detail.aca.cliff : null;
        const n = planYears.length;
        const yMax = Math.max(
          1,
          ...planYears.map((y) =>
            Math.max(stackTotal(y), y.magi, cliffOf(y) ?? 0),
          ),
        );
        const magiPoints = planYears
          .map((y, i) => `${i + 0.5},${100 - (y.magi / yMax) * 100}`)
          .join(" ");
        // ACA cliff line runs: consecutive marketplace years that
        // carry a priced cliff, drawn the Playground way — a step
        // segment across each year, joined to the next year's level.
        const cliffRuns: { x1: number; y1: number; x2: number; y2: number }[] = [];
        planYears.forEach((y, i) => {
          const cliff = cliffOf(y);
          if (cliff == null) return;
          const prev = i > 0 ? planYears[i - 1] : undefined;
          const prevCliff = prev != null ? cliffOf(prev) : null;
          if (prevCliff != null) {
            cliffRuns.push({
              x1: i - 0.5,
              y1: 100 - (prevCliff / yMax) * 100,
              x2: i + 0.5,
              y2: 100 - (cliff / yMax) * 100,
            });
          } else {
            cliffRuns.push({
              x1: i + 0.1,
              y1: 100 - (cliff / yMax) * 100,
              x2: i + 0.9,
              y2: 100 - (cliff / yMax) * 100,
            });
          }
        });
        const presentSegs = segDefs.filter((d) =>
          planYears.some((y) => d.amount(y) !== 0),
        );
        const openYearFromChart = (yr: number) => {
          openDetailYear(yr);
          if (!yearTableOpen) {
            setYearTableOpen(true);
            saveUiState.mutate({ yearTableOpen: true });
          }
        };
        return (
          <section className={sectionCls} aria-label="Plan income by year chart">
            <h2 className="text-base font-semibold">
              Income stack by year — ages {planYears[0]?.agePrimary} to{" "}
              {planYears[n - 1]?.agePrimary}
              <InfoNote
                ariaLabel="About the income stack chart"
                text="One bar per plan year, stacking the priced income pieces from the year-by-year table below — the money out and RMD columns, taxable Social Security, and the other income in that year's math. The line across the top is each year's MAGI from the table; the dashed line is the ACA cliff while someone is on the marketplace. Pick a bar to open that year's math under the table."
              />
            </h2>
            <div className="relative mt-3 h-56">
              <div className="absolute inset-0 flex items-end gap-[2px]">
                {planYears.map((y) => {
                  let cum = 0;
                  const segs = segDefs
                    .map((d) => {
                      const amount = d.amount(y);
                      const start = cum;
                      cum += amount;
                      return { ...d, amount, start };
                    })
                    .filter((s) => s.amount !== 0);
                  const selected = detailYear === y.year;
                  const segSummary = segs
                    .map((s) => `${s.label} ${fmtDollars(s.amount)}`)
                    .join("; ");
                  return (
                    <button
                      key={y.year}
                      type="button"
                      aria-label={`Show the math for ${y.year} (age ${y.agePrimary}) — MAGI ${fmtDollars(y.magi)}${segSummary ? ` — ${segSummary}` : ""}`}
                      aria-pressed={selected}
                      className={`relative h-full min-w-0 flex-1 rounded-sm hover:bg-[var(--accent-soft)] ${selected ? "ring-2 ring-[var(--accent)] ring-inset" : detailYear != null ? "opacity-40" : ""}`}
                      onClick={() => openYearFromChart(y.year)}
                    >
                      {segs.map((s) => (
                        <span
                          key={s.key}
                          aria-hidden="true"
                          className="absolute right-0 left-0 border-b border-[var(--bg)]"
                          style={{
                            bottom: `${(Math.min(s.start, s.start + s.amount) / yMax) * 100}%`,
                            height: `${(Math.abs(s.amount) / yMax) * 100}%`,
                            background: s.color,
                          }}
                        />
                      ))}
                    </button>
                  );
                })}
              </div>
              <svg
                className="pointer-events-none absolute inset-0 h-full w-full"
                viewBox={`0 0 ${n} 100`}
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                {cliffRuns.map((r, i) => (
                  <line
                    key={i}
                    x1={r.x1}
                    y1={r.y1}
                    x2={r.x2}
                    y2={r.y2}
                    stroke="var(--warn)"
                    strokeWidth={1.5}
                    strokeDasharray="5 3"
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
                <polyline
                  points={magiPoints}
                  fill="none"
                  stroke="var(--text)"
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            </div>
            <div className="mt-1 flex gap-[2px]" aria-hidden="true">
              {planYears.map((y) => {
                const labelSelected = detailYear === y.year;
                return (
                  <span
                    key={y.year}
                    className={`min-w-0 flex-1 text-center whitespace-nowrap ${labelSelected ? "text-[11px] font-bold text-[var(--text)]" : "text-[10px] text-[var(--dim)]"}`}
                  >
                    {labelSelected ||
                    y.agePrimary % 5 === 0 ||
                    y.agePrimary === planYears[0]?.agePrimary ||
                    y.agePrimary === planYears[n - 1]?.agePrimary
                      ? y.agePrimary
                      : ""}
                  </span>
                );
              })}
            </div>
            <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--dim)]">
              {presentSegs.map((d) => (
                <span key={d.key} className="inline-flex items-center gap-1.5">
                  <span
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                    style={{ background: d.color }}
                    aria-hidden="true"
                  />
                  {d.label}
                </span>
              ))}
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="inline-block h-0 w-4 border-t-2 border-[var(--text)]"
                />
                MAGI
              </span>
              {cliffRuns.length > 0 && (
                <span className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="inline-block h-0 w-4 border-t-2 border-dashed border-[var(--warn)]"
                  />
                  ACA cliff
                </span>
              )}
            </p>
          </section>
        );
      })()}

      {/* Tax by year — the SAVED plan's lifetime tax picture.
          Every figure comes from the baseline row of the
          saved-payload compare (savedTaxRow — the same run the
          ending strip prices from), whose per-year readouts
          (contract v51) are read straight off the priced march
          the lifetime totals sum. Priced from the saved record,
          never the working form: an unsaved edit cannot move
          these figures, exactly like the strip. The composition
          line foots to the row's net cost EXACTLY, in cents:
          net cost = federal tax + IRMAA − ACA credits kept +
          the remainder, where the remainder (state tax +
          pre-59½ penalties + tax on the ending pre-tax
          balance − refundable education credit) is named
          component by component in the title row's ⓘ
          (taxByYearExplainer, contract v66), never folded
          silently into the headline figures. */}
      {showPlanWorkspace && savedPlanPayload && (
        <section className={sectionCls} aria-label="Tax by year">
          <h2 className="text-base font-semibold">
            Tax by year
            {taxByYearExplainer && (
              <InfoNote
                ariaLabel="About the Tax by year figures"
                text={taxByYearExplainer}
              />
            )}
          </h2>
          {savedTaxQ.isPending ? (
            <p className="mt-1 text-sm text-[var(--dim)]">Pricing the saved plan…</p>
          ) : savedTaxRow ? (
            (() => {
              const planYears = savedTaxRow.years;
              const rawMax = Math.max(0, ...planYears.map((y) => y.federalTaxCents));
              const niceMax = (() => {
                if (rawMax <= 0) return 100;
                const pow = Math.pow(10, Math.floor(Math.log10(rawMax)));
                const unit = rawMax / pow;
                const nice = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10;
                return nice * pow;
              })();
              const gridFracs = [1, 0.75, 0.5, 0.25, 0];
              // X-axis year labels: the first year, the last
              // year, and every fifth year — thinned so no two
              // kept labels sit fewer than three years apart.
              // At the bar widths this chart renders, adjacent
              // labels collide (the 2065 tick against the final
              // 2066 in Kyle's screenshot); when the final year
              // crowds the tick before it, the final year wins
              // and the tick is dropped.
              const labelYearSet = (() => {
                const wanted = new Set<number>();
                const firstYr = planYears[0]?.year;
                const lastYr = planYears[planYears.length - 1]?.year;
                if (firstYr != null) wanted.add(firstYr);
                for (const y of planYears) if (y.year % 5 === 0) wanted.add(y.year);
                if (lastYr != null) wanted.add(lastYr);
                const sorted = [...wanted].sort((a, b) => a - b);
                const kept: number[] = [];
                for (const yr of sorted) {
                  const prev = kept[kept.length - 1];
                  if (prev != null && yr - prev < 3) {
                    if (yr === lastYr && prev !== firstYr)
                      kept[kept.length - 1] = yr;
                    continue;
                  }
                  kept.push(yr);
                }
                return new Set(kept);
              })();
              // The first year the saved plan takes pre-tax
              // money out by choice — a conversion or a pre-tax
              // draw for spending (an RMD alone is not a draw
              // decision, so it does not open the mini bill).
              const firstDrawYear =
                planYears.find((y) => y.pretaxDrawCents > 0) ?? null;
              const billRow = (
                label: string,
                value: string,
                opts?: { bold?: boolean; divide?: boolean },
              ) => (
                <div
                  className={`flex items-baseline justify-between gap-4 ${
                    opts?.divide ? "mt-1 border-t border-[var(--border)] pt-1.5" : "py-0.5"
                  }`}
                >
                  <span className={opts?.bold ? "font-semibold" : undefined}>{label}</span>
                  <span className={`tnum ${opts?.bold ? "font-bold" : ""}`}>{value}</span>
                </div>
              );
              return (
                <>
                  <p className="tnum mt-1 max-w-3xl text-sm">
                    Lifetime federal tax {fmtCents(savedTaxRow.federalTaxCents)} · ACA credits kept{" "}
                    {savedTaxRow.acaCreditCents > 0
                      ? `−${fmtCents(savedTaxRow.acaCreditCents)}`
                      : fmtCents(savedTaxRow.acaCreditCents)}{" "}
                    · IRMAA {fmtCents(savedTaxRow.irmaaCents)} · Lifetime net cost{" "}
                    {fmtCents(savedTaxRow.netCostCents)}
                  </p>
                  {rawMax <= 0 ? (
                    <p className="mt-3 text-sm text-[var(--dim)]">
                      Federal tax is $0 in every year of the saved plan.
                    </p>
                  ) : (
                    <>
                      <div className="mt-3 flex gap-2">
                        <div className="relative h-56 w-16 shrink-0" aria-hidden="true">
                          {gridFracs.map((f) => (
                            <span
                              key={f}
                              className="tnum absolute right-0 text-[10px] text-[var(--dim)]"
                              style={{
                                top: `${(1 - f) * 100}%`,
                                transform: "translateY(-50%)",
                              }}
                            >
                              {fmtDollars((niceMax * f) / 100)}
                            </span>
                          ))}
                        </div>
                        <div
                          className="relative h-56 min-w-0 flex-1"
                          role="img"
                          aria-label={`Bar chart of federal tax by plan year, ${planYears[0]?.year} to ${planYears[planYears.length - 1]?.year}; the largest year is ${fmtCents(rawMax)}. Per-year figures are in the numbers fold below.`}
                        >
                          {gridFracs.map((f) => (
                            <div
                              key={f}
                              aria-hidden="true"
                              className="absolute right-0 left-0 border-t border-[var(--border)]"
                              style={{ top: `${(1 - f) * 100}%` }}
                            />
                          ))}
                          <div className="absolute inset-0 flex items-end gap-[2px]">
                            {planYears.map((y) => (
                              <div
                                key={y.year}
                                className="relative h-full min-w-0 flex-1"
                                title={`${y.year}: federal tax ${fmtCents(y.federalTaxCents)}`}
                              >
                                <span
                                  aria-hidden="true"
                                  className="absolute right-0 bottom-0 left-0 rounded-t-sm"
                                  style={{
                                    height: `${(y.federalTaxCents / niceMax) * 100}%`,
                                    background: "var(--accent)",
                                  }}
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                      <div className="mt-1 flex gap-2" aria-hidden="true">
                        <div className="w-16 shrink-0" />
                        <div className="flex min-w-0 flex-1 gap-[2px]">
                          {planYears.map((y) => (
                            <span
                              key={y.year}
                              className="min-w-0 flex-1 text-center text-[10px] whitespace-nowrap text-[var(--dim)]"
                            >
                              {labelYearSet.has(y.year) ? y.year : ""}
                            </span>
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                  <button
                    type="button"
                    aria-expanded={taxYearNumbersOpen}
                    aria-label="Federal tax by year — numbers"
                    className="mt-2 flex items-center gap-2 text-sm font-medium text-[var(--accent)]"
                    onClick={() => setTaxYearNumbersOpen(!taxYearNumbersOpen)}
                  >
                    Federal tax by year — numbers
                    <FoldChevron open={taxYearNumbersOpen} />
                  </button>
                  {taxYearNumbersOpen && (
                    <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3 lg:grid-cols-4">
                      {planYears.map((y) => (
                        <p key={y.year} className="tnum flex justify-between gap-3">
                          <span className="text-[var(--dim)]">{y.year}</span>
                          <span>{fmtCents(y.federalTaxCents)}</span>
                        </p>
                      ))}
                    </div>
                  )}
                  {firstDrawYear && (
                    <div
                      className="mx-auto mt-4 max-w-xl rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-3"
                      aria-label="First draw year tax bill"
                    >
                      <p className="text-sm font-semibold">
                        First draw year — {firstDrawYear.year}
                        <span className="font-normal text-[var(--dim)]">
                          {" "}(ages {firstDrawYear.agePrimary}
                          {firstDrawYear.ageSpouse != null ? `/${firstDrawYear.ageSpouse}` : ""})
                        </span>
                      </p>
                      <div className="mt-1 text-sm">
                        {billRow("Adjusted gross income (AGI)", fmtCents(firstDrawYear.totalIncomeCents))}
                        {billRow("Taxable income", fmtCents(firstDrawYear.taxableIncomeCents))}
                        {billRow("Federal tax", fmtCents(firstDrawYear.federalTaxCents))}
                        {firstDrawYear.acaCreditCents > 0 &&
                          billRow(
                            "ACA premium credit",
                            `−${fmtCents(firstDrawYear.acaCreditCents)}`,
                          )}
                        {billRow(
                          "Net tax",
                          fmtCents(firstDrawYear.federalTaxCents - firstDrawYear.acaCreditCents),
                          { bold: true, divide: true },
                        )}
                      </div>
                      {firstDrawYear.irmaaCents > 0 && (
                        <p className="tnum mt-2 text-sm text-[var(--dim)]">
                          Medicare premium surcharges (IRMAA) paid that year:{" "}
                          {fmtCents(firstDrawYear.irmaaCents)} — premiums, not tax, so
                          they are not part of the net tax above.
                        </p>
                      )}
                    </div>
                  )}
                </>
              );
            })()
          ) : savedTaxQ.data && !savedTaxQ.data.ok ? (
            <p className="mt-1 text-sm text-[var(--dim)]">{savedTaxQ.data.reason}</p>
          ) : (
            <p className="mt-1 text-sm text-[var(--dim)]">
              The saved plan could not be priced for this picture.
            </p>
          )}
        </section>
      )}

      {showPlanWorkspace && planInputs && mainResult && (
        <section className={sectionCls} aria-label="Year by year">
          <button
            type="button"
            aria-expanded={yearTableOpen}
            aria-label="Year by year table"
            className="flex w-full items-start justify-between gap-3 text-left"
            onClick={toggleYearTable}
          >
            <span>
              <span className="block text-base font-semibold">Year by year — your fill settings</span>
              <span className="tnum mt-0.5 block text-sm text-[var(--dim)]">{yearTableSummary}</span>
            </span>
            <FoldChevron open={yearTableOpen} className="mt-0.5" />
          </button>
          {yearTableOpen && (
            <>
              <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-left">
                  <th scope="col" className="px-2 py-2 font-medium">Year (ages)</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">Conversion</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">RMD</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">SS taxed</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">MAGI</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">ACA MAGI</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">Marginal bracket</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">Federal tax</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">Eff. marginal on conversion</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">IRMAA tier set (age 63+ MAGI)</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">IRMAA paid</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">ACA credit kept</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">Pre-tax end</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">Roth end</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">Taxable end</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">5-yr clock</th>
                </tr>
              </thead>
              <tbody>
                {mainResult.years.map((y) => (
                  <tr
                    key={y.year}
                    className={`border-b border-[var(--border)] last:border-0 ${detailYear === y.year ? "bg-[var(--accent-soft)]" : ""}`}
                  >
                    <td className="tnum px-2 py-1.5 whitespace-nowrap">
                      <button
                        type="button"
                        aria-label={`Show the math for ${y.year}`}
                        aria-expanded={detailYear === y.year}
                        className="font-medium text-[var(--accent)] underline underline-offset-2 hover:text-[var(--text)]"
                        onClick={() => toggleDetailYear(y.year)}
                      >
                        {y.year} ({y.agePrimary}
                        {y.ageSpouse != null ? `/${y.ageSpouse}` : ""})
                      </button>
                      {y.isDeathYear && (
                        <span className="block text-xs font-medium whitespace-normal text-[var(--bad)]">
                          Death year — still filed jointly
                        </span>
                      )}
                      {y.isSurvivorYear && (
                        <span className="block text-xs whitespace-normal text-[var(--dim)]">
                          Survivor — single filer
                        </span>
                      )}
                    </td>
                    <td className="tnum px-2 py-1.5 text-right whitespace-nowrap">
                      {y.conversion > 0 ? (
                        <>
                          {fmtDollars(y.conversion)}
                          {y.conversionAlready > 0 && (
                            <span className="block text-xs whitespace-normal text-[var(--dim)]">
                              incl. {fmtDollars(y.conversionAlready)} already converted
                            </span>
                          )}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="tnum px-2 py-1.5 text-right whitespace-nowrap">{y.rmd > 0 ? fmtDollars(y.rmd) : "—"}</td>
                    <td className="tnum px-2 py-1.5 text-right whitespace-nowrap">{y.ssBenefits > 0 ? `${Math.round(y.ssPctTaxed)}%` : "—"}</td>
                    <td className="tnum px-2 py-1.5 text-right whitespace-nowrap">{fmtDollars(y.magi)}</td>
                    <td className="tnum px-2 py-1.5 text-right whitespace-nowrap">{fmtDollars(y.acaMagi)}</td>
                    <td className="tnum px-2 py-1.5 text-right whitespace-nowrap">{y.bracketPct}%</td>
                    <td className="tnum px-2 py-1.5 text-right whitespace-nowrap">{fmtDollars(y.federalTax)}</td>
                    <td className="tnum px-2 py-1.5 text-right whitespace-nowrap">
                      {y.effectiveMarginalPct != null ? `${y.effectiveMarginalPct.toFixed(1)}%` : "—"}
                    </td>
                    <td className="tnum px-2 py-1.5 text-right whitespace-nowrap">{y.agePrimary >= 63 ? `Tier ${y.irmaaTierSet}` : "—"}</td>
                    <td className="tnum px-2 py-1.5 text-right whitespace-nowrap">{y.irmaaPaid > 0 ? fmtDollars(y.irmaaPaid) : "—"}</td>
                    <td className="tnum px-2 py-1.5 text-right whitespace-nowrap">
                      {y.acaPriced
                        ? `${fmtDollars(y.acaCreditKept)}${y.acaUnder138 ? " †" : ""}`
                        : acaNotPricedYears.some((ny) => ny.year === y.year)
                          ? "not priced"
                          : "—"}
                    </td>
                    <td className="tnum px-2 py-1.5 text-right whitespace-nowrap">{fmtDollars(y.pretaxEnd)}</td>
                    <td className="tnum px-2 py-1.5 text-right whitespace-nowrap">{fmtDollars(y.rothEnd)}</td>
                    <td className="tnum px-2 py-1.5 text-right whitespace-nowrap">{fmtDollars(y.taxableEnd)}</td>
                    <td className="tnum px-2 py-1.5 text-right whitespace-nowrap">{y.fiveYearClockYear ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={hintCls}>
            Each conversion has its own 5-year clock: before 59½, withdrawing its
            taxable amount within 5 tax years costs a 10% penalty — this column shows
            the first penalty-free year; after 59½ the clock no longer penalizes
            principal (earnings have separate rules). IRMAA paid is set by MAGI from
            two years earlier. The ACA credit and cliff use ACA MAGI (MAGI plus the
            non-taxable part of Social Security); IRMAA and the MAGI-based fill
            ceilings (the MAGI cap and the IRMAA tier lines) use
            MAGI — the bracket-top and 0%-capital-gains ceilings limit taxable
            income, not MAGI.
          </p>
              {acaUnder138Years.length > 0 && (
                <p className={hintCls}>
                  † Under 138% of the poverty line — at that income, coverage routes
                  to Medicaid rather than a marketplace plan in most states; the credit
                  shown is the priced figure, flagged because it may not be a marketplace
                  result.
                </p>
              )}
              <p className={hintCls}>
                Select a year in the table to see how that year&rsquo;s numbers were
                built — the engine&rsquo;s own figures, line by line.
              </p>
              {detailRow && renderYearDetail(detailRow, closeDetailYear)}
            </>
          )}
        </section>
      )}

      {face === "settings" && resultsMode === "compare" && (
        <section className={sectionCls} aria-label="Strategy Lab">
          <h2 className="text-base font-semibold">
            Strategy Lab
            <InfoNote
              ariaLabel="About the Strategy Lab"
              text="Your library of saved strategies, priced side by side in one ranked list — together with your current plan, Do Nothing, and four built-in fill rules of the plan you have loaded. The built-ins re-price from the loaded plan whenever it changes; they are never saved. Add more options whenever a new idea comes up — duplicate a row and edit it, or save the current plan as a new strategy. Up to 50 strategies can be kept."
            />
          </h2>

          <button
            type="button"
            aria-expanded={labDialsOpen}
            aria-controls="lab-dials-body"
            aria-label="Debate dials"
            className="mt-5 flex w-full items-center justify-between gap-3 border-b border-[var(--border)] pb-2 text-left"
            onClick={toggleLabDials}
          >
            <span className="flex flex-wrap items-baseline gap-x-3">
              <span className="text-base font-semibold">Debate dials</span>
              {labDialsSetCount > 0 && (
                <span className="text-sm text-[var(--dim)]">
                  {labDialsSetCount} {labDialsSetCount === 1 ? "dial set" : "dials set"}
                </span>
              )}
            </span>
            <FoldChevron open={labDialsOpen} />
          </button>
          {labDialsOpen && (
          <div id="lab-dials-body">
          <p className="mt-2 max-w-3xl text-sm text-[var(--dim)]">
            Shared assumptions to debate across every option at once. A dial you
            set is applied to every row the next time you price the library; a
            blank dial leaves each strategy on its own saved value. Dials are
            scratch only — they never change your saved plan or any saved
            strategy.
          </p>
          <div className="mt-5 border-t border-[var(--border)] pt-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {pctField("Taxable basis", labDialBasis, setLabDialBasis, {
              idLabel: "Taxable basis — debate dial",
              info: "The share of the taxable account that is cost basis. The rest of every taxable draw is a taxable gain, so a lower basis makes taxable draws cost more. Your plan's basis is used when this is blank.",
            })}
            {moneyField("Annual spending", labDialSpending, setLabDialSpending, {
              idLabel: "Annual spending — debate dial",
            })}
            {numField("Your SS start age", labDialSsP, setLabDialSsP, {
              idLabel: "Your SS start age — debate dial",
              info: "The age the primary earner starts Social Security, applied to every row. The yearly benefit is re-derived at the new age from each plan's entered amount, the same way the optimizer derives it.",
            })}
            {numField("Spouse SS start age", labDialSsS, setLabDialSsS, {
              idLabel: "Spouse SS start age — debate dial",
            })}
            <div>
              <label className={labelCls} htmlFor="lab-dial-survivor">
                Survivor scenario
              </label>
              <select
                id="lab-dial-survivor"
                aria-label="Survivor scenario"
                className={inputCls}
                value={labDialSurvivor}
                onChange={(e) =>
                  setLabDialSurvivor(e.target.value as "" | "on" | "off")
                }
              >
                <option value="">Each strategy&rsquo;s own setting</option>
                <option value="on">On for every row</option>
                <option value="off">Off for every row</option>
              </select>
              <p className={hintCls}>
                Prices every row as if one spouse dies in the year below.
              </p>
            </div>
            {labDialSurvivor === "on" && (
              <div>
                <label className={labelCls} htmlFor="lab-dial-survivor-who">
                  Who dies
                </label>
                <select
                  id="lab-dial-survivor-who"
                  aria-label="Who dies — debate dial"
                  className={inputCls}
                  value={labDialSurvivorWho}
                  onChange={(e) =>
                    setLabDialSurvivorWho(e.target.value as "primary" | "spouse")
                  }
                >
                  <option value="primary">Primary earner</option>
                  <option value="spouse">Spouse</option>
                </select>
              </div>
            )}
            {labDialSurvivor === "on" &&
              numField("Year of death", labDialSurvivorYear, setLabDialSurvivorYear, {
                idLabel: "Year of death — debate dial",
                hint: "Calendar year.",
              })}
          </div>
          </div>

          <div className="mt-5 border-t border-[var(--border)] pt-4">
          <h4 className="text-sm font-semibold">ACA</h4>
          <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {numField("Spouse ACA end age", labDialAcaEndAge, setLabDialAcaEndAge, {
              idLabel: "Spouse ACA end age — debate dial",
              hint: "65 when blank there too.",
              info: "The age the spouse leaves the marketplace for Medicare, applied to every row. While she is under it, her premium credit is priced and the 400% cliff applies; her Medicare premiums start at that age instead of 65.",
            })}
            {moneyField("ACA benchmark — family / yr", labDialBenchFamily, setLabDialBenchFamily, {
              idLabel: "ACA benchmark — family / yr — debate dial",
            })}
            {moneyField("ACA benchmark — couple / yr", labDialBenchCouple, setLabDialBenchCouple, {
              idLabel: "ACA benchmark — couple / yr — debate dial",
            })}
            {moneyField("ACA benchmark — one spouse / yr", labDialBenchSingle, setLabDialBenchSingle, {
              idLabel: "ACA benchmark — one spouse / yr — debate dial",
            })}
            <div className="col-span-2 sm:col-span-3">
              <span className={labelCls}>Household schedule — debate dial</span>
              <p className={hintCls}>
                Optional: rows here replace each row&rsquo;s whole household
                schedule for the debate (the year each size takes effect and
                the size). No rows = each row keeps its own schedule.
              </p>
              {labDialAcaSteps.map((row, i) => (
                <div key={i} className="mt-2 flex flex-wrap items-end gap-2">
                  <div className="w-32">
                    {numField(`Dial step ${i + 1} from year`, row.fromYear, (v) =>
                      setLabDialAcaSteps((rows) =>
                        rows.map((r, j) => (j === i ? { ...r, fromYear: v } : r)),
                      ),
                      { idLabel: `Dial step ${i + 1} from year — debate dial` },
                    )}
                  </div>
                  <div className="w-32">
                    {numField(`Dial step ${i + 1} household size`, row.householdSize, (v) =>
                      setLabDialAcaSteps((rows) =>
                        rows.map((r, j) => (j === i ? { ...r, householdSize: v } : r)),
                      ),
                      { idLabel: `Dial step ${i + 1} household size — debate dial` },
                    )}
                  </div>
                  <button
                    type="button"
                    aria-label={`Remove dial household step ${i + 1}`}
                    className="px-2 py-2 text-base text-[var(--dim)] hover:text-[var(--bad)]"
                    onClick={() =>
                      setLabDialAcaSteps((rows) => rows.filter((_, j) => j !== i))
                    }
                  >
                    ✕
                  </button>
                </div>
              ))}
              {labDialAcaSteps.length < 40 && (
                <button
                  type="button"
                  className="mt-2 px-1 py-1 text-xs text-[var(--dim)] underline underline-offset-2 hover:text-[var(--accent)]"
                  onClick={() =>
                    setLabDialAcaSteps((rows) => [
                      ...rows,
                      { fromYear: "", householdSize: "" },
                    ])
                  }
                >
                  Add a step
                </button>
              )}
              {labDialAcaSteps.length > 0 && acaStepsFromRows(labDialAcaSteps) == null && (
                <p className="mt-2 text-sm text-[var(--bad)]">
                  Fill in the year and the household size on every dial step
                  row. Until every row is complete, the dial does not apply.
                </p>
              )}
            </div>
          </div>
          </div>

          <div className="mt-5 border-t border-[var(--border)] pt-4">
          <h4 className="text-sm font-semibold">Assumptions</h4>
          <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {pctField("Expected return", labDialReturn, setLabDialReturn, {
              idLabel: "Expected return — debate dial",
            })}
            {pctField("Inflation", labDialInflation, setLabDialInflation, {
              idLabel: "Inflation — debate dial",
            })}
            {pctField("Heir tax rate", labDialHeir, setLabDialHeir, {
              idLabel: "Heir tax rate — debate dial",
            })}
            {pctField("State tax rate", labDialStateRate, setLabDialStateRate, {
              idLabel: "State tax rate — debate dial",
            })}
          </div>
          </div>

          <div className="mt-5 border-t border-[var(--border)] pt-4">
          <h4 className="text-sm font-semibold">Plan shape</h4>
          <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {numField("Convert from age", labDialWinStart, setLabDialWinStart, {
              idLabel: "Convert from age — debate dial",
            })}
            {numField("Convert until age", labDialWinStop, setLabDialWinStop, {
              idLabel: "Convert until age — debate dial",
            })}
            {moneyField("Pre-tax to preserve", labDialPreserve, setLabDialPreserve, {
              idLabel: "Pre-tax to preserve — debate dial",
            })}
          </div>
          </div>

          <div className="mt-5 border-t border-[var(--border)] pt-4">
          <h4 className="text-sm font-semibold">Starting balances</h4>
          <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {moneyField("Starting pre-tax", labDialPretax, setLabDialPretax, {
              idLabel: "Starting pre-tax — debate dial",
            })}
            {moneyField("Starting taxable", labDialTaxable, setLabDialTaxable, {
              idLabel: "Starting taxable — debate dial",
            })}
            {moneyField("Starting Roth", labDialRoth, setLabDialRoth, {
              idLabel: "Starting Roth — debate dial",
            })}
          </div>
          </div>
          <button
            type="button"
            aria-label="Reset dials"
            className="mt-3 text-sm font-medium text-[var(--accent)] underline underline-offset-2 hover:text-[var(--text)]"
            onClick={resetLabDials}
          >
            Reset dials
          </button>
          </div>
          )}

          <h3 className="mt-5 border-b border-[var(--border)] pb-2 text-base font-semibold">
            Price the library
          </h3>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div>
              <label className={labelCls} htmlFor="lab-baseline">
                Compare against (baseline)
              </label>
              <select
                id="lab-baseline"
                aria-label="Compare against (baseline)"
                className={`${inputCls} w-auto max-w-64`}
                value={labBaseline}
                onChange={(e) => {
                  setLabBaseline(e.target.value);
                  saveUiState.mutate({ labBaselineName: e.target.value });
                }}
              >
                {data.scenarios.map((sc) => (
                  <option key={sc.name} value={labNameMap.get(sc.name) ?? sc.name}>
                    {labNameMap.get(sc.name) ?? sc.name}
                  </option>
                ))}
                <option value="Your current plan">Your current plan</option>
                <option value="Do Nothing">Do Nothing</option>
              </select>
            </div>
            <button
              type="button"
              aria-label="Price the library"
              className="rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              disabled={runLabMut.isPending}
              onClick={() => {
                setLabError("");
                runLabMut.mutate(buildLabRequest());
              }}
            >
              {runLabMut.isPending ? "Pricing…" : "Price the library"}
            </button>
            <span className="text-xs text-[var(--dim)]" aria-live="polite">
              {runLabMut.isPending
                ? "Pricing every saved strategy as a fixed strategy — this can take a moment."
                : "Prices the saved strategies, your current plan, Do Nothing, and the built-in fill rules in one run. Nothing is saved."}
            </span>
          </div>
          {labError && (
            <p className="mt-2 text-sm text-[var(--bad)]" role="alert">
              {labError}
            </p>
          )}
          {labResult?.ok && labFingerprint !== "" && JSON.stringify(buildLabRequest()) !== labFingerprint && (
            <p className="mt-2 text-sm text-[var(--dim)]">
              Inputs, dials, or the library changed since this run — price the
              library again for current figures.
            </p>
          )}
          {labResult?.ok && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] text-left">
                    <th scope="col" className="px-2 py-2 font-medium">Strategy</th>
                    <th scope="col" className="px-2 py-2 text-right font-medium">Lifetime net cost</th>
                    <th scope="col" className="px-2 py-2 text-right font-medium">Net cost vs baseline</th>
                    <th scope="col" className="px-2 py-2 text-right font-medium">Lifetime tax</th>
                    <th scope="col" className="px-2 py-2 text-right font-medium">Lifetime IRMAA</th>
                    <th scope="col" className="px-2 py-2 text-right font-medium">ACA credit kept</th>
                    <th scope="col" className="px-2 py-2 text-right font-medium">Ending after-tax wealth</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    // One ranked list: every row of the run —
                    // saved strategies, your current plan, the
                    // baseline, and the built-in fill rules —
                    // sorted by the engine-returned lifetime net
                    // cost, cheapest first, then FOLDED for
                    // display (see labDisplayGroups): rows that
                    // priced identically in every field show
                    // once, under a plain-words title, with an
                    // "Also:" line naming every folded row.
                    // Every group tied at the minimum net cost
                    // wears the Lowest tax badge, and every
                    // group tied at the maximum ending after-tax
                    // wealth wears the Most left at the end
                    // badge (a group can wear both); the group
                    // holding the baseline row keeps the
                    // Baseline badge and tint wherever it lands.
                    const groups = labDisplayGroups(labResult.scenarios);
                    const minNetCostCents = groups.length
                      ? groups[0]!.rep.netCostCents
                      : null;
                    const maxWealthCents = groups.length
                      ? Math.max(
                          ...groups.map((g) => g.rep.endingAfterTaxWealthCents),
                        )
                      : null;
                    return groups.map((group) => {
                      const row = group.rep;
                      const isBaseline = group.members.some(
                        (m) => m.name === labResult.baselineName,
                      );
                      const isBuiltIn = group.members.every((m) =>
                        LAB_BUILT_IN_NAMES.has(m.name),
                      );
                      const isLowest =
                        minNetCostCents != null &&
                        row.netCostCents === minNetCostCents;
                      const isMostLeft =
                        maxWealthCents != null &&
                        row.endingAfterTaxWealthCents === maxWealthCents;
                      return (
                    <tr
                      key={group.key}
                      className={`border-b border-[var(--border)] last:border-0 ${isBaseline || isLowest ? "bg-[var(--accent-soft)]" : ""}`}
                    >
                      <td className="px-2 py-2">
                        <span className="font-medium">{group.title}</span>
                        {isBaseline && (
                          <span className="ml-2 rounded-full border border-[var(--accent)] px-2 py-0.5 text-xs font-medium text-[var(--accent)]">
                            Baseline
                          </span>
                        )}
                        {isBuiltIn && (
                          <span className="ml-2 rounded-full border border-[var(--border)] px-2 py-0.5 text-xs font-medium whitespace-nowrap text-[var(--dim)]">
                            Built-in
                          </span>
                        )}
                        {isLowest && lowestTaxBadge}
                        {isMostLeft && mostLeftBadge}
                        <span className="block text-xs text-[var(--dim)]">
                          {row.strategyDescription}
                        </span>
                        {group.members.length > 1 && (
                          <span className="block text-xs text-[var(--dim)]">
                            Also: {group.members.map((m) => m.name).join(" · ")}
                          </span>
                        )}
                      </td>
                      <td className={`tnum px-2 py-2 text-right ${isLowest ? "font-bold" : "font-medium"}`}>{fmtCents(row.netCostCents)}</td>
                      <td className="tnum px-2 py-2 text-right">
                        {isBaseline
                          ? "—"
                          : fmtCents(row.deltaNetCostCents)}
                      </td>
                      <td className="tnum px-2 py-2 text-right">{fmtCents(row.totalTaxCents)}</td>
                      <td className="tnum px-2 py-2 text-right">{fmtCents(row.irmaaCents)}</td>
                      <td className="tnum px-2 py-2 text-right">{fmtCents(row.acaCreditCents)}</td>
                      <td className="tnum px-2 py-2 text-right">{fmtCents(row.endingAfterTaxWealthCents)}</td>
                    </tr>
                      );
                    });
                  })()}
                </tbody>
              </table>
            </div>
          )}

          <h3 className="mt-5 border-b border-[var(--border)] pb-2 text-base font-semibold">
            Saved strategies
          </h3>
          <p className="mt-2 text-sm text-[var(--dim)]">
            Load replaces your current plan's inputs with this strategy and saves automatically — the strategy itself stays saved here. Save your current plan as a strategy first if you want to keep it.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              aria-label="Add current plan as a new strategy"
              className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium text-[var(--text)] hover:text-[var(--accent)] disabled:opacity-50"
              disabled={saveScenario.isPending || data.scenarios.length >= 50}
              onClick={() => saveScenario.mutate(buildSavePayload())}
            >
              Add current plan as a new strategy
            </button>
            {data.scenarios.length >= 50 && (
              <span className="text-xs text-[var(--dim)]">
                Maximum 50 scenarios saved — delete one to save another.
              </span>
            )}
          </div>
          {matchedScenarios.length === 0 && (
            <p className="mt-3 text-sm text-[var(--dim)]" aria-live="polite">
              {"Current plan isn't a saved strategy."}
            </p>
          )}
          {data.scenarios.length === 0 && (
            <p className="mt-3 text-sm text-[var(--dim)]">
              No saved strategies yet. Add the current plan as a strategy, or
              save one from the Plan or Optimize workspaces, and it will appear
              here ready to price, duplicate, and edit.
            </p>
          )}
          <ul className="mt-3 flex flex-col gap-3">
            {data.scenarios.map((sc) => {
              const priced = labResult?.ok
                ? labResult.scenarios.find(
                    (r) => r.name === (labNameMap.get(sc.name) ?? sc.name),
                  )
                : undefined;
              return (
              <li
                key={sc.name}
                className="border-b border-[var(--border)] pb-3 last:border-0 last:pb-0"
              >
                <div className="flex flex-wrap items-center gap-2">
                {renamingName === sc.name ? (
                  <>
                    <input
                      aria-label={`New name for ${sc.name}`}
                      className={`${inputCls} max-w-56`}
                      value={renameText}
                      onChange={(e) => setRenameText(e.target.value)}
                    />
                    <button
                      type="button"
                      aria-label={`Confirm rename of ${sc.name}`}
                      className="rounded-[var(--radius)] bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                      disabled={renameScenario.isPending}
                      onClick={() =>
                        renameScenario.mutate({ name: sc.name, newName: renameText })
                      }
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      aria-label="Cancel rename"
                      className="rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-sm"
                      onClick={() => setRenamingName(null)}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <span className="font-medium">{sc.name}</span>
                    {matchedScenarioSet.has(sc) && (
                      <span className="rounded-full border border-[var(--accent)] px-2 py-0.5 text-xs font-medium whitespace-nowrap text-[var(--accent)]">
                        Loaded in plan
                      </span>
                    )}
                    <span className="text-xs text-[var(--dim)]">
                      {sc.ceilings == null ||
                      (sc.ceilings.bracketTopPct == null &&
                        sc.ceilings.irmaaTierCap == null &&
                        !sc.ceilings.ltcgZeroCap &&
                        !sc.ceilings.acaCliffCap &&
                        sc.ceilings.magiCapCents == null)
                        ? "No ceilings — no conversions"
                        : sc.ceilings.bracketTopPct != null
                          ? `Fill to ${sc.ceilings.bracketTopPct}%`
                          : "Custom ceilings"}
                      {sc.windowStartAge != null && sc.windowStopAge != null
                        ? ` · ages ${sc.windowStartAge}→${sc.windowStopAge}`
                        : ""}
                      {sc.optimizerGuardrail ? " · guardrail" : ""}
                      {sc.optimizerBunching ? " · bunching" : ""}
                      {sc.ceilings?.acaCliffCap && sc.ceilings?.acaCliffCapFamilyOnly
                        ? " · cliff cap until the household steps down"
                        : ""}
                      {sc.gainsHarvest ? " · gain harvesting" : ""}
                      {sc.drawOrder != null && sc.drawOrder !== DEFAULT_DRAW_ORDER_KEY
                        ? ` · Draw order: ${drawOrderLabel(drawOrderFromKey(sc.drawOrder))}`
                        : ""}
                    </span>
                    {priced && (
                      <span className="tnum text-xs text-[var(--dim)]">
                        Net cost {fmtCents(priced.netCostCents)}
                        {labResult?.baselineName && priced.name !== labResult.baselineName
                          ? ` · ${fmtCents(priced.deltaNetCostCents)} vs ${labResult.baselineName}`
                          : ""}
                      </span>
                    )}
                    <span className="flex-1" />
                    {labConfirmLoad === sc.name ? (
                      <>
                        <span className="text-sm">Load {sc.name}? This replaces your current plan — edits save automatically.</span>
                        <button
                          type="button"
                          aria-label={`Confirm load of ${sc.name}`}
                          className="rounded-[var(--radius)] bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white"
                          onClick={() => loadLabScenario(sc)}
                        >
                          Load
                        </button>
                        <button
                          type="button"
                          aria-label="Cancel load"
                          className="rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-sm"
                          onClick={() => setLabConfirmLoad(null)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        aria-label={`Load ${sc.name} into the current plan, replacing it`}
                        className="rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-sm hover:text-[var(--accent)]"
                        onClick={() => requestLabLoad(sc)}
                      >
                        Load into plan
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label={`Edit ${sc.name}`}
                      aria-expanded={labEditingName === sc.name}
                      className="rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-sm hover:text-[var(--accent)]"
                      onClick={() =>
                        labEditingName === sc.name
                          ? setLabEditingName(null)
                          : openLabEditor(sc)
                      }
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      aria-label={`Duplicate ${sc.name}`}
                      className="rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-sm hover:text-[var(--accent)] disabled:opacity-50"
                      disabled={saveScenario.isPending || data.scenarios.length >= 50}
                      onClick={() => {
                        const { name: _dupName, ...rest } = sc;
                        saveScenario.mutate(rest);
                      }}
                    >
                      Duplicate
                    </button>
                    <button
                      type="button"
                      aria-label={`Rename ${sc.name}`}
                      className="rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-sm hover:text-[var(--accent)]"
                      onClick={() => {
                        setRenamingName(sc.name);
                        setRenameText(sc.name);
                      }}
                    >
                      Rename
                    </button>
                    {labConfirmDelete === sc.name ? (
                      <>
                        <span className="text-sm">Delete {sc.name}?</span>
                        <button
                          type="button"
                          aria-label={`Confirm delete of ${sc.name}`}
                          className="rounded-[var(--radius)] bg-[var(--bad)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                          disabled={deleteScenario.isPending}
                          onClick={() => {
                            setLabConfirmDelete(null);
                            deleteScenario.mutate(sc.name);
                          }}
                        >
                          Delete
                        </button>
                        <button
                          type="button"
                          aria-label="Cancel delete"
                          className="rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-sm"
                          onClick={() => setLabConfirmDelete(null)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        aria-label={`Delete ${sc.name}`}
                        className="rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--bad)]"
                        onClick={() => setLabConfirmDelete(sc.name)}
                      >
                        Delete
                      </button>
                    )}
                  </>
                )}
                </div>
                {labEditingName === sc.name && renamingName !== sc.name && (
                  <div className="mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-4 py-3">
                    <p className="text-sm font-medium">Edit strategy — {sc.name}</p>
                    <p className="mt-1 text-sm text-[var(--dim)]">
                      Only the strategy settings below change; the strategy&rsquo;s
                      household and balance fields stay exactly as saved.
                    </p>
                    <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                      <div>
                        <label className={labelCls} htmlFor="lab-ed-bracket">
                          Fill up to bracket top
                        </label>
                        <select
                          id="lab-ed-bracket"
                          aria-label="Fill up to bracket top"
                          className={inputCls}
                          value={edBracket}
                          onChange={(e) => setEdBracket(e.target.value as typeof edBracket)}
                        >
                          <option value="">No bracket ceiling</option>
                          <option value="10">Top of the 10% bracket</option>
                          <option value="12">Top of the 12% bracket</option>
                          <option value="22">Top of the 22% bracket</option>
                          <option value="24">Top of the 24% bracket</option>
                        </select>
                      </div>
                      <div>
                        <label className={labelCls} htmlFor="lab-ed-irmaa">
                          Cap at IRMAA tier
                        </label>
                        <select
                          id="lab-ed-irmaa"
                          aria-label="Cap at IRMAA tier"
                          className={inputCls}
                          value={edIrmaa}
                          onChange={(e) => setEdIrmaa(e.target.value as typeof edIrmaa)}
                        >
                          <option value="">No IRMAA cap</option>
                          <option value="0">Tier 0</option>
                          <option value="1">Tier 1</option>
                          <option value="2">Tier 2</option>
                          <option value="3">Tier 3</option>
                          <option value="4">Tier 4</option>
                          <option value="5">Tier 5</option>
                        </select>
                      </div>
                      {moneyField("MAGI cap for this strategy", edMagiCap, setEdMagiCap, {
                        hint: "Blank = no custom cap.",
                      })}
                      <div className="flex items-start gap-2 pt-7">
                        <input
                          id="lab-ed-ltcg"
                          type="checkbox"
                          aria-label="Stay inside the 0 percent capital-gains space for this strategy"
                          className="mt-1 h-4 w-4"
                          checked={edLtcg}
                          onChange={(e) => setEdLtcg(e.target.checked)}
                        />
                        <label htmlFor="lab-ed-ltcg" className="text-sm">
                          Stay inside the 0% capital-gains space
                        </label>
                      </div>
                      <div className="flex items-start gap-2 pt-7">
                        <input
                          id="lab-ed-aca"
                          type="checkbox"
                          aria-label="Stay at or under the ACA cliff for this strategy"
                          className="mt-1 h-4 w-4"
                          checked={edAca}
                          onChange={(e) => setEdAca(e.target.checked)}
                        />
                        <label htmlFor="lab-ed-aca" className="text-sm">
                          Stay at or under 400% FPL (keep the ACA credit)
                        </label>
                      </div>
                      <div className="flex items-start gap-2 pt-7">
                        <input
                          id="lab-ed-aca-family-only"
                          type="checkbox"
                          aria-label="Only until the household steps down for this strategy"
                          className="mt-1 h-4 w-4"
                          checked={edAcaFamilyOnly}
                          disabled={!edAca}
                          onChange={(e) => setEdAcaFamilyOnly(e.target.checked)}
                        />
                        <label htmlFor="lab-ed-aca-family-only" className="text-sm">
                          Only until the household steps down — after the
                          first step year in the household schedule this
                          strategy stops defending the cliff and those
                          years price undefended.
                        </label>
                      </div>
                      {moneyField("Cliff safety buffer for this strategy", edCliffBuffer, setEdCliffBuffer, {
                        hint: "Aim this far below the cliff, so a late-year surprise can't push income $1 over the line and wipe out the whole year's credit. Blank = aim at the cliff itself.",
                        disabled: !edAca,
                      })}
                      <div>
                        <label className={labelCls} htmlFor="lab-ed-draw-order">
                          Draw order
                        </label>
                        <select
                          id="lab-ed-draw-order"
                          aria-label="Draw order"
                          className={inputCls}
                          value={edDrawOrder}
                          onChange={(e) => setEdDrawOrder(e.target.value)}
                        >
                          {DRAW_ORDER_OPTIONS.map((o) => (
                            <option key={o.key} value={o.key}>
                              {drawOrderLabel(o.order)}
                            </option>
                          ))}
                        </select>
                      </div>
                      {numField("Switch order at age — strategy", edSwitchAge, setEdSwitchAge, {
                        hint: "Blank = one order at every age.",
                      })}
                      <div>
                        <label className={labelCls} htmlFor="lab-ed-after-order">
                          Draw order after the switch age
                        </label>
                        <select
                          id="lab-ed-after-order"
                          aria-label="Draw order after the switch age"
                          className={inputCls}
                          value={edAfterOrder}
                          onChange={(e) => setEdAfterOrder(e.target.value)}
                        >
                          {DRAW_ORDER_OPTIONS.map((o) => (
                            <option key={o.key} value={o.key}>
                              {drawOrderLabel(o.order)}
                            </option>
                          ))}
                        </select>
                      </div>
                      {numField("Convert from age — strategy", edWinStart, setEdWinStart)}
                      {numField("Convert until age — strategy", edWinStop, setEdWinStop)}
                      <div>
                        <label className={labelCls} htmlFor="lab-ed-pay-tax">
                          Pay conversion tax from
                        </label>
                        <select
                          id="lab-ed-pay-tax"
                          aria-label="Pay conversion tax from"
                          className={inputCls}
                          value={edPayTaxFrom}
                          onChange={(e) =>
                            setEdPayTaxFrom(e.target.value as "taxable" | "conversion")
                          }
                        >
                          <option value="taxable">Taxable account</option>
                          <option value="conversion">The conversion itself</option>
                        </select>
                      </div>
                      <div className="flex items-start gap-2 pt-7">
                        <input
                          id="lab-ed-guardrail"
                          type="checkbox"
                          aria-label="Marginal-rate guardrail for this strategy"
                          className="mt-1 h-4 w-4"
                          checked={edGuardrail ?? false}
                          onChange={(e) => setEdGuardrail(e.target.checked)}
                        />
                        <label htmlFor="lab-ed-guardrail" className="text-sm">
                          Marginal-rate guardrail — stop each year's fill at the first $100 step
                          taxed above the bracket rate (pauses in the Social Security torpedo
                          zone; resumes once benefits are fully taxed). Needs a bracket ceiling.
                        </label>
                      </div>
                      <div className="flex items-start gap-2 pt-7">
                        <input
                          id="lab-ed-bunching"
                          type="checkbox"
                          aria-label="ACA bunching for this strategy"
                          className="mt-1 h-4 w-4"
                          checked={edBunching ?? false}
                          onChange={(e) => setEdBunching(e.target.checked)}
                        />
                        <label htmlFor="lab-ed-bunching" className="text-sm">
                          ACA bunching — in marketplace years, alternate a big conversion year
                          with a $0 year: the big year gives up that year's premium credit so
                          the $0 year keeps it in full.
                        </label>
                      </div>
                      <div className="flex items-start gap-2 pt-7">
                        <input
                          id="lab-ed-harvest"
                          type="checkbox"
                          aria-label="Harvest gains into the 0 percent bracket for this strategy"
                          className="mt-1 h-4 w-4"
                          checked={edHarvest ?? false}
                          onChange={(e) => setEdHarvest(e.target.checked)}
                        />
                        <label htmlFor="lab-ed-harvest" className="text-sm">
                          Harvest gains into the 0% bracket each year
                        </label>
                        <InfoNote
                          text="Sell investments in the taxable account and immediately rebuy them, deliberately realising capital gains up to the top of the 0% capital-gains bracket each year. This steps up the cost basis, so future sales realise less gain. It never pushes income past the ACA cliff (when that cap is on) or past the bracket top."
                          ariaLabel="About gain harvesting"
                        />
                      </div>
                      {moneyField("Preserved pre-tax — strategy", edPreserve, setEdPreserve, {
                        hint: "Pre-tax this strategy never converts. Blank = no reserve.",
                      })}
                      {pctField("Exit rate on preserved — strategy", edPreserveRate, setEdPreserveRate, {
                        hint: "Blank = the heir rate.",
                      })}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        aria-label={`Save changes to ${sc.name}`}
                        className="rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                        disabled={updateScenario.isPending}
                        onClick={() => saveLabEditor(sc)}
                      >
                        Save changes
                      </button>
                      <button
                        type="button"
                        aria-label="Cancel editing"
                        className="rounded-[var(--radius)] border border-[var(--border)] px-4 py-2 text-sm"
                        onClick={() => setLabEditingName(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className={sectionCls} aria-label="Assumptions and limits">
        <button
          type="button"
          aria-expanded={assumptionsOpen}
          aria-label="Assumptions and limits"
          className="flex w-full items-start justify-between gap-3 text-left"
          onClick={toggleAssumptions}
        >
          <span className="block text-base font-semibold">Assumptions & limits — read before relying on a number</span>
          <FoldChevron open={assumptionsOpen} className="mt-0.5" />
        </button>
        {assumptionsOpen && (
        <>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-[var(--dim)]">
          <li>
            One steady return path: every bucket grows at the single expected return
            above. Real markets vary, and the order of returns changes results — this
            view prices taxes, it does not forecast markets.
          </li>
          <li>
            Everything is in today's dollars. Tax figures that the law indexes for
            inflation (brackets, standard deduction, IRMAA tiers except the top one) are
            held constant; figures the law does NOT index (Social Security
            provisional-income thresholds, the NIIT threshold) shrink each year by
            the inflation input, and the frozen top IRMAA tier shrinks only until it
            becomes inflation-indexed in 2028 — which is why the Social Security
            torpedo deepens over time.
          </li>
          <li>
            Only federal income tax, the flat state rate entered, Medicare IRMAA
            surcharges, and the ACA premium credit are priced. Premiums themselves are
            not part of the spending input, so the ACA credit is tracked per year, not
            added to balances. No payroll tax in these retirement years — the employee
            payroll tax on salary is priced in the Work years tab, from each work
            year&rsquo;s own law table; no estate or local taxes; no tax on HSA
            withdrawals (assumed used for medical costs); no FAFSA or aid modeling —
            college years inside the window are flagged in the watch-outs instead.
          </li>
          <li>
            Spending is drawn in this order: the year&rsquo;s RMD first (always out
            of pre-tax — legally required), then the buckets in the draw order set in
            Your money — currently {drawOrderLabel(drawOrderFromKey(drawOrder))}. When tax is paid from Taxable: surplus income cash pays first, then Taxable down to the protect-minimum — that amount caps only this one sale. Any remainder is withheld from that year's conversion, and if there is no (or not enough) conversion, drawn from Taxable below the floor, then Pre-tax, then Roth. Spending draws ignore the protect-minimum entirely, so the pool can end a year below it: it is not a guaranteed minimum balance, and because sales sell the highest-basis money first, it does not keep any cash aside either. Tax created by the draws themselves is settled from Taxable after the draws, then the same below-floor order. The draw order governs spending draws only.
          </li>
          <li>
            Years before the retirement age draw no spending — income is assumed
            to cover living costs, tax is paid from that income, and any leftover
            is saved into Taxable.
          </li>
          <li>
            Joint Life divisors are embedded for owner ages 72–85 × spouse ages
            60–75; beyond that corner the nearest covered divisor is used, which
            slightly understates RMDs at advanced ages.
          </li>
          <li>
            Pre-tax money is tracked per spouse — see Your money for how each
            balance prices on its owner&rsquo;s clock.
          </li>
          <li>
            Survivor scenario (when switched on in Spending &amp; timing; the year of death is
            entered as a calendar year): the death year still files jointly and
            receives both Social Security benefits. From the next year the
            survivor files as a single filer — single brackets, standard
            deduction, IRMAA thresholds, and capital-gains thresholds — keeps
            only the larger of the two benefits at its modeled claim-age amount,
            and prices ACA coverage as a household of one for their remaining
            under-65 years. In the year of death, the spouse who died still
            takes their own final RMD, figured on their own balance, clock, and
            table as if they had lived that year. Only what remains combines:
            from the next year the combined pre-tax balance runs on the
            survivor&rsquo;s own clock with the Uniform Lifetime table. Spending, the other income inputs, and the plan end
            age (still the primary&rsquo;s age) are unchanged — the scenario
            reprices taxes and benefits around a death; it does not model
            changed spending, survivor-benefit claiming timing, or the
            10-year rule for anyone else inheriting.
          </li>
          <li>
            IRMAA paid assumes $0 surcharge in the first two Medicare years of a plan
            starting at 65 or older — the MAGI that would set those premiums predates
            the plan and is unknown.
          </li>
          <li>
            The optimizer&rsquo;s winner is the best of the level-ceiling strategies
            it tests on this one deterministic return path, scored as lifetime net
            cost. A different return path, or a hand-tuned year-by-year schedule, can
            beat it; the sensitivity strips show whether the winner survives a
            ±1% return change or a different heir rate.
          </li>
          <li>
            This is a planning model, not tax advice. Conversions are irrevocable,
            deadlines are calendar-year, and individual facts (residency, other
            income, ACA plan availability) move real numbers — confirm a year's
            conversion with a tax professional before executing it.
          </li>
        </ul>
        <p className="mt-3 text-xs text-[var(--dim)]">
          Tax-law figures: 2025 — IRS Rev. Proc. 2024-40 and the One Big Beautiful
          Bill Act (standard deduction as amended by the Act; brackets per the Rev.
          Proc.; senior deduction per the Act); 2026 — IRS Rev. Proc. 2025-32. IRMAA premium tiers — Centers for Medicare &amp;
          Medicaid Services, November 2025 release for 2026 premiums. ACA
          applicable-percentage table — IRS Rev. Proc. 2025-25; poverty guidelines —
          U.S. Department of Health &amp; Human Services (the prior year's guidelines
          set each coverage year). RMD divisors — IRS Publication 590-B (Uniform
          Lifetime and Joint Life and Last Survivor tables); RMD ages per SECURE 2.0.
          Years past 2026 reuse the 2026 law under the today's-dollars convention
          above. Full citations are kept with the app's data plan.
        </p>
        </>
        )}
      </section>
    </div>
  );
}
