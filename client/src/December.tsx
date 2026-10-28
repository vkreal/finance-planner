import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ApiResponse } from "./api";
import { usePersistedFold } from "./foldState";
import { FoldChevron } from "./FoldChevron";
import {
  fmtDollars,
  fmtMoneyInput,
  hintCls,
  inputCls,
  labelCls,
  moneyField,
  numField,
  pctField,
  sectionCls,
  type FilingStatus,
} from "./rothShared";
import { acaHouseholdSizeForYear } from "@space/server/taxEngine";
import {
  computeDecemberProjection,
  decemberBenchmarkTier,
  decemberNullableMoneyFormValue,
  decemberNullableMoneyFromFormValue,
  decemberStateForSave,
  decemberStoredProvenanceOf,
  defaultDecemberState,
  resolveDecemberStateAtLoad,
  type DecemberCaseKind,
  type DecemberRecordFacts,
  type DecemberState,
  type DecemberStoredProvenance,
  type DecemberStray,
} from "@space/server/decemberCore";

/* The December projection console — a year-end projection for
   a household managing MAGI against the ACA cliff. The form's
   inputs persist as one server blob (getDecemberProjection /
   saveDecemberProjection) so the December session reopens and
   adjusts as finals post; pricing runs through the shared
   single-year engine via decemberCore's
   computeDecemberProjection — the same code the server action
   and the accuracy fixtures run. On a first open (nothing
   stored yet) the year block is preseeded from the saved Tax
   Plan record where available; everything else starts blank.
   Saves carry the stored blob's revision (compare-and-swap):
   if the stored copy moved since this screen read it, the
   save is refused with the stored state instead of silently
   overwriting it, and this screen reloads that state. */

/* The form carries typed strings, like the Playground form;
   the saved state carries numbers. These two converters are
   the only boundary. A $0 amount shows blank, as on the other
   views' money dials — EXCEPT the four nullable money fields
   (the two per-owner pre-tax balances, the ACA benchmark,
   and the enrollment premium), where null (not entered) and
   $0 are different facts with different pricing: those four
   convert through decemberCore's nullable-money pair, which
   renders an entered $0 as "0" and reads blank back as null,
   so a known $0 round-trips as zero (round-2 fix 1). */
type RangeForm = { low: string; likely: string; high: string };
type StrayForm = { status: DecemberStray["status"]; amount: string };
type DecForm = {
  taxYear: string;
  filingStatus: FilingStatus;
  agePrimary: string;
  ageSpouse: string;
  onMedicarePrimary: boolean;
  onMedicareSpouse: boolean;
  ytdOtherOrdinary: string;
  ytdInterest: string;
  ytdOrdinaryDividends: string;
  ytdQualifiedDividends: string;
  ytdTaxExemptInterest: string;
  ytdCapitalGain: string;
  ytdSsPrimary: string;
  ytdSsSpouse: string;
  remCapDist: RangeForm;
  remInterest: RangeForm;
  remOrdinaryDividends: RangeForm;
  remQualifiedDividends: RangeForm;
  remOtherOrdinary: RangeForm;
  acaHouseholdSize: string;
  acaBenchmarkAnnual: string;
  acaEnrollmentPremiumAnnual: string;
  aptcTaken: string;
  bufferDollars: string;
  pretaxBalancePrimary: string;
  pretaxBalanceSpouse: string;
  rmdAlreadyReceived: string;
  spouseSoleBeneficiary: boolean;
  // Tri-state (round-4 fix): true / false are explicit
  // answers; null = not answered — the three states are
  // distinct in the saved state and in the form control.
  primarySoleBeneficiaryOfSpouse: boolean | null;
  stateRatePct: string;
  residenceState: "WA" | "other";
  itemizedMortgageInterest: string;
  itemizedSaltPaid: string;
  itemizedCharitable: string;
  itemizedOther: string;
  strayCapDist: StrayForm;
  strayK1: StrayForm;
  strayTaxExempt: StrayForm;
  strayDependent: StrayForm;
  straySeverance: StrayForm;
  strayLossHarvest: StrayForm;
  strayCutoff: StrayForm;
  strayJanPaid: StrayForm;
  strayJanPaidQualifiedAmount: string;
  strayDivInt: StrayForm;
  strayPlannedSales: StrayForm;
  strayROC: StrayForm;
  strayROCOrdinary: StrayForm;
  strayAgiReducers: StrayForm;
  strayCoverage: StrayForm;
  strayTradeDate: StrayForm;
  // Provenance, carried passively through the form:
  // whether the balance split is the console's own
  // explicit split, the two legacy character flags (they
  // drive the checklist notes), and the beneficiary-
  // answer confirm flag (round-6; it drives the note by
  // the beneficiary select). decemberStateForSave clears
  // a flag only when its own control was edited.
  pretaxSplitExplicit: boolean;
  legacyRocSplitUnconfirmed: boolean;
  legacyJanPaidSplitUnconfirmed: boolean;
  legacyBeneficiaryAnswerUnconfirmed: boolean;
};

/* The Tax Plan record facts load resolution draws on,
   in December dollars: the record's beneficiary answer
   and its per-owner pre-tax split (the primary's amount
   falls back to the snapshot's pre-tax total, the same
   fallback the first-open preseed uses). */
function recordFactsOf(
  data: ApiResponse<typeof api, "getRothPlanner"> | undefined,
): DecemberRecordFacts {
  const s = data?.saved;
  const primaryCents = s?.pretaxCents ?? data?.snapshot?.pretaxCents ?? null;
  return {
    primarySoleBeneficiaryOfSpouse:
      s?.primarySoleBeneficiaryOfSpouse ?? null,
    pretaxBalancePrimary: primaryCents != null ? primaryCents / 100 : null,
    pretaxBalanceSpouse:
      s?.pretaxSpouseCents != null ? s.pretaxSpouseCents / 100 : null,
  };
}

const moneyStr = (n: number): string => (n === 0 ? "" : fmtMoneyInput(n));
const numStr = (n: number | null): string => (n == null ? "" : String(n));
const parseMoney = (s: string): number => {
  const cleaned = s.replace(/[$,\s]/g, "");
  if (cleaned === "") return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
};
const parseIntOrNull = (s: string): number | null => {
  const cleaned = s.replace(/\s/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n) : null;
};

function formFromState(s: DecemberState): DecForm {
  const rg = (r: DecemberState["remCapDist"]): RangeForm => ({
    low: moneyStr(r.low),
    likely: moneyStr(r.likely),
    high: moneyStr(r.high),
  });
  const st = (x: DecemberStray): StrayForm => ({
    status: x.status,
    amount: moneyStr(x.amount),
  });
  return {
    taxYear: String(s.taxYear),
    filingStatus: s.filingStatus,
    agePrimary: numStr(s.agePrimary),
    ageSpouse: numStr(s.ageSpouse),
    onMedicarePrimary: s.onMedicarePrimary,
    onMedicareSpouse: s.onMedicareSpouse,
    ytdOtherOrdinary: moneyStr(s.ytdOtherOrdinary),
    ytdInterest: moneyStr(s.ytdInterest),
    ytdOrdinaryDividends: moneyStr(s.ytdOrdinaryDividends),
    ytdQualifiedDividends: moneyStr(s.ytdQualifiedDividends),
    ytdTaxExemptInterest: moneyStr(s.ytdTaxExemptInterest),
    ytdCapitalGain: moneyStr(s.ytdCapitalGain),
    ytdSsPrimary: moneyStr(s.ytdSsPrimary),
    ytdSsSpouse: moneyStr(s.ytdSsSpouse),
    remCapDist: rg(s.remCapDist),
    remInterest: rg(s.remInterest),
    remOrdinaryDividends: rg(s.remOrdinaryDividends),
    remQualifiedDividends: rg(s.remQualifiedDividends),
    remOtherOrdinary: rg(s.remOtherOrdinary),
    acaHouseholdSize: numStr(s.acaHouseholdSize),
    // The four nullable money fields render through the
    // nullable-money converter: null shows blank, an
    // entered $0 shows "0" — never the generic moneyStr,
    // whose $0-shows-blank would erase the distinction.
    acaBenchmarkAnnual: decemberNullableMoneyFormValue(s.acaBenchmarkAnnual),
    acaEnrollmentPremiumAnnual: decemberNullableMoneyFormValue(
      s.acaEnrollmentPremiumAnnual,
    ),
    aptcTaken: moneyStr(s.aptcTaken),
    bufferDollars: fmtMoneyInput(s.bufferDollars),
    pretaxBalancePrimary: decemberNullableMoneyFormValue(s.pretaxBalancePrimary),
    pretaxBalanceSpouse: decemberNullableMoneyFormValue(s.pretaxBalanceSpouse),
    rmdAlreadyReceived: moneyStr(s.rmdAlreadyReceived),
    spouseSoleBeneficiary: s.spouseSoleBeneficiary,
    primarySoleBeneficiaryOfSpouse: s.primarySoleBeneficiaryOfSpouse,
    stateRatePct: String(s.stateRatePct),
    residenceState: s.residenceState,
    itemizedMortgageInterest: moneyStr(s.itemizedMortgageInterest),
    itemizedSaltPaid: moneyStr(s.itemizedSaltPaid),
    itemizedCharitable: moneyStr(s.itemizedCharitable),
    itemizedOther: moneyStr(s.itemizedOther),
    strayCapDist: st(s.strayCapDist),
    strayK1: st(s.strayK1),
    strayTaxExempt: st(s.strayTaxExempt),
    strayDependent: st(s.strayDependent),
    straySeverance: st(s.straySeverance),
    strayLossHarvest: st(s.strayLossHarvest),
    strayCutoff: st(s.strayCutoff),
    strayJanPaid: st(s.strayJanPaid),
    strayJanPaidQualifiedAmount: moneyStr(s.strayJanPaidQualifiedAmount),
    strayDivInt: st(s.strayDivInt),
    strayPlannedSales: st(s.strayPlannedSales),
    strayROC: st(s.strayROC),
    strayROCOrdinary: st(s.strayROCOrdinary),
    strayAgiReducers: st(s.strayAgiReducers),
    strayCoverage: st(s.strayCoverage),
    strayTradeDate: st(s.strayTradeDate),
    pretaxSplitExplicit: s.pretaxSplitExplicit,
    legacyRocSplitUnconfirmed: s.legacyRocSplitUnconfirmed,
    legacyJanPaidSplitUnconfirmed: s.legacyJanPaidSplitUnconfirmed,
    legacyBeneficiaryAnswerUnconfirmed: s.legacyBeneficiaryAnswerUnconfirmed,
  };
}

function stateFromForm(f: DecForm): DecemberState {
  const clamp0 = (n: number) => Math.max(0, n);
  const rg = (r: RangeForm) => ({
    low: parseMoney(r.low),
    likely: parseMoney(r.likely),
    high: parseMoney(r.high),
  });
  // The unsigned remaining-income ranges (contract v66,
  // boundary audit F5): the same clamp0 the unsigned YTD
  // fields below already get — interest, dividends, and
  // capital distributions still to come are never negative.
  // remOtherOrdinary keeps rg: it is signed by design.
  const rg0 = (r: RangeForm) => ({
    low: clamp0(parseMoney(r.low)),
    likely: clamp0(parseMoney(r.likely)),
    high: clamp0(parseMoney(r.high)),
  });
  const st = (x: StrayForm): DecemberStray => ({
    status: x.status,
    amount: clamp0(parseMoney(x.amount)),
  });
  // The K-1 stray is the one signed stray: a deductible K-1
  // loss is negative income, so its amount keeps its sign.
  const stSigned = (x: StrayForm): DecemberStray => ({
    status: x.status,
    amount: parseMoney(x.amount),
  });
  const size = parseIntOrNull(f.acaHouseholdSize);
  return {
    taxYear: parseIntOrNull(f.taxYear) ?? new Date().getFullYear(),
    filingStatus: f.filingStatus,
    agePrimary: parseIntOrNull(f.agePrimary),
    ageSpouse: f.filingStatus === "mfj" ? parseIntOrNull(f.ageSpouse) : null,
    onMedicarePrimary: f.onMedicarePrimary,
    onMedicareSpouse: f.filingStatus === "mfj" ? f.onMedicareSpouse : false,
    ytdOtherOrdinary: parseMoney(f.ytdOtherOrdinary),
    ytdInterest: clamp0(parseMoney(f.ytdInterest)),
    ytdOrdinaryDividends: clamp0(parseMoney(f.ytdOrdinaryDividends)),
    ytdQualifiedDividends: clamp0(parseMoney(f.ytdQualifiedDividends)),
    ytdTaxExemptInterest: clamp0(parseMoney(f.ytdTaxExemptInterest)),
    ytdCapitalGain: parseMoney(f.ytdCapitalGain),
    ytdSsPrimary: clamp0(parseMoney(f.ytdSsPrimary)),
    ytdSsSpouse: f.filingStatus === "mfj" ? clamp0(parseMoney(f.ytdSsSpouse)) : 0,
    remCapDist: rg0(f.remCapDist),
    remInterest: rg0(f.remInterest),
    remOrdinaryDividends: rg0(f.remOrdinaryDividends),
    remQualifiedDividends: rg0(f.remQualifiedDividends),
    remOtherOrdinary: rg(f.remOtherOrdinary),
    acaHouseholdSize: size != null && size >= 1 && size <= 20 ? size : null,
    acaBenchmarkAnnual: (() => {
      const n = decemberNullableMoneyFromFormValue(f.acaBenchmarkAnnual);
      return n == null ? null : clamp0(n);
    })(),
    acaEnrollmentPremiumAnnual: (() => {
      const n = decemberNullableMoneyFromFormValue(f.acaEnrollmentPremiumAnnual);
      return n == null ? null : clamp0(n);
    })(),
    aptcTaken: clamp0(parseMoney(f.aptcTaken)),
    bufferDollars: clamp0(parseMoney(f.bufferDollars)),
    pretaxBalancePrimary: (() => {
      const n = decemberNullableMoneyFromFormValue(f.pretaxBalancePrimary);
      return n == null ? null : clamp0(n);
    })(),
    pretaxBalanceSpouse: (() => {
      const n = decemberNullableMoneyFromFormValue(f.pretaxBalanceSpouse);
      return n == null ? null : clamp0(n);
    })(),
    // The legacy combined field is derived as the split's
    // sum, so the saved blob's two views of the money agree.
    pretaxBalance: (() => {
      const prim = decemberNullableMoneyFromFormValue(f.pretaxBalancePrimary);
      const sp = decemberNullableMoneyFromFormValue(f.pretaxBalanceSpouse);
      if (prim == null && sp == null) return null;
      return clamp0(prim ?? 0) + clamp0(sp ?? 0);
    })(),
    rmdAlreadyReceived: clamp0(parseMoney(f.rmdAlreadyReceived)),
    spouseSoleBeneficiary: f.spouseSoleBeneficiary,
    primarySoleBeneficiaryOfSpouse: f.primarySoleBeneficiaryOfSpouse,
    stateRatePct: Math.min(100, clamp0(parseMoney(f.stateRatePct))),
    residenceState: f.residenceState,
    itemizedMortgageInterest: clamp0(parseMoney(f.itemizedMortgageInterest)),
    itemizedSaltPaid: clamp0(parseMoney(f.itemizedSaltPaid)),
    itemizedCharitable: clamp0(parseMoney(f.itemizedCharitable)),
    itemizedOther: clamp0(parseMoney(f.itemizedOther)),
    strayCapDist: st(f.strayCapDist),
    strayK1: stSigned(f.strayK1),
    strayTaxExempt: st(f.strayTaxExempt),
    strayDependent: st(f.strayDependent),
    straySeverance: st(f.straySeverance),
    strayLossHarvest: st(f.strayLossHarvest),
    strayCutoff: st(f.strayCutoff),
    strayJanPaid: st(f.strayJanPaid),
    strayJanPaidQualifiedAmount: clamp0(parseMoney(f.strayJanPaidQualifiedAmount)),
    strayDivInt: st(f.strayDivInt),
    strayPlannedSales: st(f.strayPlannedSales),
    strayROC: st(f.strayROC),
    strayROCOrdinary: st(f.strayROCOrdinary),
    strayAgiReducers: st(f.strayAgiReducers),
    strayCoverage: st(f.strayCoverage),
    strayTradeDate: st(f.strayTradeDate),
    pretaxSplitExplicit: f.pretaxSplitExplicit,
    legacyRocSplitUnconfirmed: f.legacyRocSplitUnconfirmed,
    legacyJanPaidSplitUnconfirmed: f.legacyJanPaidSplitUnconfirmed,
    legacyBeneficiaryAnswerUnconfirmed: f.legacyBeneficiaryAnswerUnconfirmed,
  };
}

const CASE_LABELS: Record<DecemberCaseKind, string> = {
  low: "Low",
  likely: "Likely",
  high: "High",
};

export function December() {
  const decQ = useQuery({
    queryKey: ["decemberprojection"],
    queryFn: () => api.getDecemberProjection({}),
  });
  const rothQ = useQuery({
    queryKey: ["rothplanner"],
    queryFn: () => api.getRothPlanner({}),
  });
  const queryClient = useQueryClient();
  const saveMut = useMutation({
    mutationFn: (state: DecemberState) =>
      api.saveDecemberProjection({ state, baseRevision: revisionRef.current }),
    onSuccess: (res, variables) => {
      if (res.ok) {
        revisionRef.current = res.revision;
        // The saved state is the new provenance baseline:
        // whatever it holds for the beneficiary fact and
        // the balance split is now the stored truth the
        // next save preserves.
        storedProvenanceRef.current = decemberStoredProvenanceOf(variables);
        queryClient.invalidateQueries({ queryKey: ["decemberprojection"] });
        return;
      }
      // Compare-and-swap conflict: the stored copy moved
      // since this screen read it (another tab or device
      // saved first). Reload the stored state into the form
      // instead of overwriting it, and say so plainly. An
      // unanswered second beneficiary fact in that state
      // resolves from the Tax Plan record exactly as at
      // first load (display only — nothing is written).
      // The reloaded form is NOT a user edit: clear the
      // dirty flag before replacing it, or the autosave
      // effect would immediately cycle "Saving…" over the
      // conflict note below and re-save the stored state
      // (contract v63, December save-note fix — the note
      // must survive until the user's next real edit).
      dirtyRef.current = false;
      revisionRef.current = res.revision;
      storedProvenanceRef.current = decemberStoredProvenanceOf(res.state);
      setBeneficiaryEdited(false);
      setBalancesEdited(false);
      setRocCharacterEdited(false);
      setJanPaidCharacterEdited(false);
      setForm(
        formFromState(
          resolveDecemberStateAtLoad(res.state, recordFactsOf(rothQ.data)),
        ),
      );
      setSaveNote(
        res.storedUnreadable
          ? "Your saved December entries can’t be read, so this edit wasn’t saved over them — the stored record is left exactly as it is."
          : "These entries were changed in another tab or on another device, so your last edit wasn’t saved over them — the saved entries are shown now.",
      );
    },
  });

  const [form, setForm] = useState<DecForm | null>(null);
  const hydratedRef = useRef(false);
  const dirtyRef = useRef(false);
  // Round-5 provenance: the STORED blob's own beneficiary
  // fact and balance split (before load resolution), and
  // whether the user has edited those controls in this
  // console since hydration. Every autosave derives its
  // state through decemberStateForSave, which restores
  // the stored values for anything not edited here — so
  // a record-resolved (inherited) value is displayed and
  // priced, but never becomes the console's saved answer
  // just because another field was edited.
  const storedProvenanceRef = useRef<DecemberStoredProvenance>({
    primarySoleBeneficiaryOfSpouse: null,
    pretaxBalancePrimary: null,
    pretaxBalanceSpouse: null,
    pretaxBalance: null,
    pretaxSplitExplicit: false,
    legacyBeneficiaryAnswerUnconfirmed: false,
    legacyRocSplitUnconfirmed: false,
    legacyJanPaidSplitUnconfirmed: false,
  });
  const [beneficiaryEdited, setBeneficiaryEdited] = useState(false);
  const [balancesEdited, setBalancesEdited] = useState(false);
  // Round-6: whether the user has edited each tax-
  // character control in this console since hydration —
  // the matching legacy character flag clears only on
  // its own edit (decemberStateForSave).
  const [rocCharacterEdited, setRocCharacterEdited] = useState(false);
  const [janPaidCharacterEdited, setJanPaidCharacterEdited] = useState(false);
  // The revision of the stored blob this screen's form was
  // read at; every save passes it as the base revision.
  const revisionRef = useRef(0);
  const [saveNote, setSaveNote] = useState<string>("");
  const [resetArmed, setResetArmed] = useState(false);
  const [detailOpen, setDetailOpen] = usePersistedFold("december.detail", false);
  // The projected tax bill's income lines (total income →
  // MAGI → taxable income) sit behind the bill block's own
  // fold; the tax, credit, and net lines always show.
  const [billIncomeOpen, setBillIncomeOpen] = usePersistedFold(
    "december.billIncome",
    false,
  );

  /* Hydrate once from the stored blob. On a first-ever open
     (nothing stored) preseed the year block from the saved Tax
     Plan record where available, and save that preseed so the
     session reopens on it. On a stored open, an UNANSWERED
     (null) second beneficiary fact is resolved at load from
     the Tax Plan record (round-4 fix, resolveDecemberStateAtLoad
     in decemberCore): the record's explicit true/false supplies
     the effective value for display and pricing, an explicit
     console value is never overwritten, and the resolution is
     display-only — dirtyRef stays unset, so opening the
     console never rewrites the stored blob; it changes only
     when the user saves in the console. */
  useEffect(() => {
    if (hydratedRef.current) return;
    if (!decQ.data) return;
    // The preseed (first open) and the load-time resolution of
    // an unanswered beneficiary fact (any open) both read the
    // Tax Plan record — wait for that read to settle before
    // hydrating, so neither is skipped just for losing a race.
    // A stored console whose fact is explicitly answered needs
    // no record and hydrates immediately.
    const needsRecord =
      !decQ.data.hasStored ||
      decQ.data.state.primarySoleBeneficiaryOfSpouse == null ||
      (!decQ.data.state.pretaxSplitExplicit &&
        decQ.data.state.pretaxBalance != null);
    if (needsRecord && rothQ.isPending) return;
    hydratedRef.current = true;
    revisionRef.current = decQ.data.revision;
    // The stored blob's own provenance, captured BEFORE
    // resolution: saves preserve these values for any
    // field the user does not edit here (round-5).
    storedProvenanceRef.current = decemberStoredProvenanceOf(decQ.data.state);
    setBeneficiaryEdited(false);
    setBalancesEdited(false);
    setRocCharacterEdited(false);
    setJanPaidCharacterEdited(false);
    let initial = formFromState(
      decQ.data.hasStored
        ? resolveDecemberStateAtLoad(decQ.data.state, recordFactsOf(rothQ.data))
        : decQ.data.state,
    );
    if (!decQ.data.hasStored && rothQ.data) {
      const s = rothQ.data.saved;
      const snap = rothQ.data.snapshot;
      const year = decQ.data.state.taxYear;
      if (s) {
        const size =
          s.acaHouseholdSize != null
            ? acaHouseholdSizeForYear(s.acaHouseholdSize, s.acaHouseholdSchedule ?? null, year)
            : null;
        // The benchmark tier keys on WHO is on the
        // marketplace, never on household size alone —
        // the same selection the long-horizon engine makes
        // (decemberBenchmarkTier pins it): both spouses on
        // ACA take the family tier at household size 3+ and
        // the couple tier below; one spouse on ACA takes
        // the single tier at any household size.
        const tier = decemberBenchmarkTier({
          filingStatus: s.filingStatus ?? "mfj",
          householdSize: size,
          onMedicarePrimary:
            s.birthYearPrimary != null ? year - s.birthYearPrimary >= 65 : false,
          onMedicareSpouse:
            s.birthYearSpouse != null ? year - s.birthYearSpouse >= 65 : false,
        });
        const benchmarkCents =
          tier === "family"
            ? (s.acaBenchmarkFamilyCents ?? s.acaBenchmarkCoupleCents)
            : tier === "couple"
              ? s.acaBenchmarkCoupleCents
              : tier === "single"
                ? s.acaBenchmarkSingleCents
                : null;
        // Each owner's pre-tax balance seeds their own
        // field — the record's own fields, never summed —
        // so each owner's RMD prices on their own clock.
        const primaryPretaxCents = s.pretaxCents ?? snap?.pretaxCents ?? null;
        const spousePretaxCents = s.pretaxSpouseCents ?? null;
        initial = {
          ...initial,
          filingStatus: s.filingStatus ?? initial.filingStatus,
          agePrimary:
            s.birthYearPrimary != null ? String(year - s.birthYearPrimary) : initial.agePrimary,
          ageSpouse:
            s.birthYearSpouse != null ? String(year - s.birthYearSpouse) : initial.ageSpouse,
          onMedicarePrimary:
            s.birthYearPrimary != null ? year - s.birthYearPrimary >= 65 : initial.onMedicarePrimary,
          onMedicareSpouse:
            s.birthYearSpouse != null ? year - s.birthYearSpouse >= 65 : initial.onMedicareSpouse,
          acaHouseholdSize: size != null ? String(size) : initial.acaHouseholdSize,
          acaBenchmarkAnnual:
            benchmarkCents != null ? fmtMoneyInput(benchmarkCents / 100) : initial.acaBenchmarkAnnual,
          stateRatePct: s.stateRatePct != null ? String(s.stateRatePct) : initial.stateRatePct,
          residenceState: s.residenceState ?? initial.residenceState,
          spouseSoleBeneficiary: s.spouseSoleBeneficiary ?? initial.spouseSoleBeneficiary,
          // The second beneficiary fact preseeds from the
          // plan record when the record carries it; absent
          // there (null on any record written before it
          // existed) the form keeps its unset default —
          // not established, so the spouse's RMD prices on
          // the Uniform table.
          primarySoleBeneficiaryOfSpouse:
            s.primarySoleBeneficiaryOfSpouse ?? initial.primarySoleBeneficiaryOfSpouse,
          pretaxBalancePrimary:
            primaryPretaxCents != null
              ? fmtMoneyInput(primaryPretaxCents / 100)
              : initial.pretaxBalancePrimary,
          pretaxBalanceSpouse:
            spousePretaxCents != null
              ? fmtMoneyInput(spousePretaxCents / 100)
              : initial.pretaxBalanceSpouse,
          itemizedMortgageInterest:
            s.itemizedMortgageInterestCents != null
              ? fmtMoneyInput(s.itemizedMortgageInterestCents / 100)
              : initial.itemizedMortgageInterest,
          itemizedSaltPaid:
            s.itemizedSaltPaidCents != null
              ? fmtMoneyInput(s.itemizedSaltPaidCents / 100)
              : initial.itemizedSaltPaid,
          itemizedCharitable:
            s.itemizedCharitableCents != null
              ? fmtMoneyInput(s.itemizedCharitableCents / 100)
              : initial.itemizedCharitable,
          itemizedOther:
            s.itemizedOtherCents != null
              ? fmtMoneyInput(s.itemizedOtherCents / 100)
              : initial.itemizedOther,
        };
      }
    }
    if (!decQ.data.hasStored) {
      // First-open preseed provenance (round-5): the
      // preseeded BALANCES become the console's own stored
      // values (they are this console's initial entries),
      // but the beneficiary fact stays UNANSWERED in the
      // preseeded blob even when the record answers it —
      // load resolution supplies the record's answer for
      // display and pricing until the user answers here.
      const preseeded = stateFromForm(initial);
      storedProvenanceRef.current = {
        primarySoleBeneficiaryOfSpouse: null,
        pretaxBalancePrimary: preseeded.pretaxBalancePrimary,
        pretaxBalanceSpouse: preseeded.pretaxBalanceSpouse,
        pretaxBalance: preseeded.pretaxBalance,
        pretaxSplitExplicit:
          preseeded.pretaxBalancePrimary != null ||
          preseeded.pretaxBalanceSpouse != null,
        legacyBeneficiaryAnswerUnconfirmed: false,
        legacyRocSplitUnconfirmed: false,
        legacyJanPaidSplitUnconfirmed: false,
      };
    }
    setForm(initial);
    if (!decQ.data.hasStored) {
      dirtyRef.current = true;
    }
    // Hydrate exactly once, from the first stored read (plus the
    // Tax Plan record on a first open, per the wait above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decQ.data, rothQ.data, rothQ.isPending]);

  /* Debounced autosave of every edit, so the December session
     can be left and reopened at any point. The saved state is
     derived through decemberStateForSave (round-5): fields
     the user has not edited in this console — the beneficiary
     fact, the balance split — save their STORED values, never
     a load-resolved (inherited) value, so an inherited answer
     keeps no precedence over a later record change. */
  useEffect(() => {
    if (!form || !dirtyRef.current) return;
    setSaveNote("Saving…");
    const t = setTimeout(() => {
      saveMut.mutate(
        decemberStateForSave(
          stateFromForm(form),
          storedProvenanceRef.current,
          {
            beneficiary: beneficiaryEdited,
            balances: balancesEdited,
            rocCharacter: rocCharacterEdited,
            janPaidCharacter: janPaidCharacterEdited,
          },
        ),
        {
          // Guarded on res.ok (contract v63, December save-note
          // fix): a CAS conflict RESOLVES as data (ok: false), so
          // this per-call success callback fires for conflicts
          // too — and in @tanstack/query-core it runs AFTER the
          // mutation-level onSuccess above (Mutation.execute
          // awaits the options callback before dispatching the
          // success that notifies the mutate callbacks), so an
          // unguarded "Saved" here overwrote the conflict note
          // the mutation-level handler had just set, in the same
          // completion. Only a real save may say "Saved".
          onSuccess: (res) => {
            if (res.ok) setSaveNote("Saved");
          },
          onError: () => setSaveNote("Could not save — your entries stay on this screen."),
        },
      );
    }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form]);

  const edit = (fn: (f: DecForm) => DecForm) => {
    dirtyRef.current = true;
    setResetArmed(false);
    setForm((f) => (f ? fn(f) : f));
  };
  const set = <K extends keyof DecForm>(key: K, value: DecForm[K]) =>
    edit((f) => ({ ...f, [key]: value }));

  const state = useMemo(() => (form ? stateFromForm(form) : null), [form]);
  const result = useMemo(
    () => (state ? computeDecemberProjection(state) : null),
    [state],
  );

  if (decQ.error && !form) {
    return (
      <p className="py-10 text-center text-[var(--bad)]">
        Something went wrong loading the December console.
      </p>
    );
  }
  if (decQ.isPending || !form || !result || !state) {
    return <p className="py-10 text-center text-[var(--dim)]">Loading…</p>;
  }

  const joint = form.filingStatus === "mfj";
  /* Projected tax bill (contract v50): the likely case's
     bill at the headline draw, from the core result's
     readouts — the view does no settlement arithmetic of
     its own. The state rows show only when a state tax is
     in play (a rate entered, or a priced state amount —
     the Washington excise at a 0% flat rate); at a plain
     0% state the federal line stands alone. */
  const likelyCase = result.cases.find((c) => c.kind === "likely") ?? null;
  const billShowState =
    likelyCase != null &&
    (state.stateRatePct > 0 || likelyCase.stateTaxAtHeadline > 0);
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
  const rangeRow = (
    label: string,
    key: "remCapDist" | "remInterest" | "remOrdinaryDividends" | "remQualifiedDividends" | "remOtherOrdinary",
    hint?: string,
  ) => (
    <div className="mt-3">
      <span className="block text-sm font-medium text-[var(--text)]">{label}</span>
      {hint && <p className={hintCls}>{hint}</p>}
      <div className="mt-1 grid grid-cols-3 gap-2">
        {(["low", "likely", "high"] as const).map((k) =>
          moneyField(CASE_LABELS[k], form[key][k], (v) =>
            edit((f) => ({ ...f, [key]: { ...f[key], [k]: v } })),
          { idLabel: `December ${label} ${k}`, ariaLabel: `${label} — ${CASE_LABELS[k]}` },
          ),
        )}
      </div>
    </div>
  );

  const strayRow = (
    label: string,
    key:
      | "strayCapDist"
      | "strayK1"
      | "strayTaxExempt"
      | "strayDependent"
      | "straySeverance"
      | "strayLossHarvest"
      | "strayCutoff"
      | "strayJanPaid"
      | "strayDivInt"
      | "strayPlannedSales"
      | "strayROC"
      | "strayROCOrdinary"
      | "strayAgiReducers"
      | "strayCoverage"
      | "strayTradeDate",
    opts?: {
      amountLabel?: string;
      hint?: string;
      extra?: ReactNode;
      note?: string;
      // Round-6 character edit tracking: invoked from
      // BOTH the status select and the amount field, so
      // touching this row's character control counts as
      // confirming its tax character.
      onEdit?: () => void;
    },
  ) => {
    const item = form[key];
    const hasAmount = opts?.amountLabel != null;
    return (
      <div className="mt-3 rounded-[var(--radius)] border border-[var(--border)] px-3 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium text-[var(--text)]">{label}</span>
          <select
            aria-label={`${label} — status`}
            className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)]"
            value={item.status}
            onChange={(e) => {
              opts?.onEdit?.();
              edit((f) => ({
                ...f,
                [key]: { ...f[key], status: e.target.value as StrayForm["status"] },
              }));
            }}
          >
            <option value="na">Doesn’t apply</option>
            <option value="confirmed">Checked — none / confirmed</option>
            {hasAmount && <option value="amount">Amount applies</option>}
          </select>
        </div>
        {opts?.hint && <p className={hintCls}>{opts.hint}</p>}
        {opts?.note && (
          <p className="mt-1 text-sm text-[var(--warn)]" role="note">
            {opts.note}
          </p>
        )}
        {hasAmount && item.status === "amount" && (
          <div className="mt-2 max-w-xs">
            {moneyField(opts.amountLabel!, item.amount, (v) => {
              opts?.onEdit?.();
              edit((f) => ({ ...f, [key]: { ...f[key], amount: v } }));
            },
            { idLabel: `December stray ${label} amount` },
            )}
          </div>
        )}
        {item.status === "amount" && opts?.extra}
      </div>
    );
  };

  return (
    <div>
      <h2 className="mt-4 text-base font-semibold">December draw</h2>
      <p className="mt-1 max-w-3xl text-sm text-[var(--dim)]">
        A year-end projection for the December decision: enter what has already posted this
        year and what is still to come, and read the largest pre-tax draw that keeps the
        year under the ACA cliff, with a safety buffer. Priced by the same single-year tax
        engine as the Playground.
      </p>
      {decQ.data?.storedUnreadable && (
        <p
          role="alert"
          className="mt-2 max-w-3xl rounded-[var(--radius)] border border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-sm leading-relaxed"
        >
          <strong>Your saved December entries can&rsquo;t be read.</strong>{" "}
          A saved record exists, but it can&rsquo;t be opened — the entries
          below are the starting defaults, not your saved ones. Saving is
          paused while the record is unreadable, so nothing overwrites it.
        </p>
      )}
      {saveNote && (
        <p className="mt-1 text-xs text-[var(--dim)]" role="status">
          {saveNote} — entries are saved as you type and reopen where you left them.
        </p>
      )}

      {/* Headline — the one number the user acts on. */}
      <section className={sectionCls} aria-label="December headline">
        {!result.priced ? (
          <p className="text-base font-semibold">{result.reason}</p>
        ) : (
          <>
            {result.headlineDraw != null && !result.zeroDrawOverCliff && (
              <p className="tnum text-3xl font-bold text-[var(--accent)]">
                {fmtDollars(result.headlineDraw)}
              </p>
            )}
            <p className="mt-1 max-w-3xl text-base font-semibold">{result.headlineText}</p>
            {result.cliff != null && (
              <p className="mt-1 text-sm text-[var(--dim)]">
                Cliff {fmtDollars(result.cliff)} · aim at {fmtDollars(result.targetMagi ?? 0)}{" "}
                (cliff − {fmtDollars(state.bufferDollars)} buffer)
              </p>
            )}
            {likelyCase && (
              <div
                className="mt-3 max-w-xl rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-3"
                aria-label="Projected tax bill"
              >
                <p className="text-sm font-semibold">
                  Projected tax bill
                  <span className="font-normal text-[var(--dim)]">
                    {" "}— likely case
                    {result.headlineDraw != null ? ", at the headline draw" : ""}
                  </span>
                </p>
                <div className="mt-1 text-sm">
                  <button
                    type="button"
                    aria-expanded={billIncomeOpen}
                    onClick={() => setBillIncomeOpen(!billIncomeOpen)}
                    className="flex w-full items-center justify-between gap-3 py-0.5 text-left"
                  >
                    <span>Income details</span>
                    <FoldChevron open={billIncomeOpen} />
                  </button>
                  {billIncomeOpen && (
                    <>
                      {billRow("Adjusted gross income (AGI)", fmtDollars(likelyCase.totalIncomeAtHeadline))}
                      {billRow("MAGI", fmtDollars(likelyCase.magiAtHeadline))}
                      {billRow("Taxable income", fmtDollars(likelyCase.taxableIncomeAtHeadline))}
                    </>
                  )}
                  {billRow("Federal tax", fmtDollars(likelyCase.federalTaxAtHeadline))}
                  {billShowState && billRow("State tax", fmtDollars(likelyCase.stateTaxAtHeadline))}
                  {billShowState && billRow("Total tax", fmtDollars(likelyCase.totalTaxAtHeadline))}
                  {likelyCase.creditAtHeadline != null &&
                    billRow(
                      "ACA premium credit",
                      likelyCase.creditAtHeadline > 0
                        ? `−${fmtDollars(likelyCase.creditAtHeadline)}`
                        : fmtDollars(likelyCase.creditAtHeadline),
                    )}
                  {likelyCase.excessAptcRepayment != null &&
                    likelyCase.excessAptcRepayment > 0 &&
                    billRow("Advance credit to repay", fmtDollars(likelyCase.excessAptcRepayment))}
                  {likelyCase.netSettleAtHeadline == null ? (
                    <p className="mt-1 border-t border-[var(--border)] pt-1.5 text-sm">
                      {likelyCase.netSettleNote ??
                        "For years before 2026 the advance-credit repayment isn’t modeled, so no single settlement figure is shown."}
                    </p>
                  ) : (
                    billRow(
                      likelyCase.netSettleAtHeadline < 0
                        ? "Estimated refund at filing"
                        : "Estimated amount to settle at filing",
                      fmtDollars(likelyCase.netSettleAtHeadline),
                      { bold: true, divide: true },
                    )
                  )}
                </div>
                <p className="mt-2 text-xs text-[var(--dim)]">
                  This estimate is before any withholding or estimated payments,
                  which this console does not track.
                </p>
              </div>
            )}
            {result.cases.length > 0 && (
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                {result.cases.map((c) => (
                  <div
                    key={c.kind}
                    className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-3"
                  >
                    <p className="text-sm font-semibold">
                      {CASE_LABELS[c.kind]} case
                      {c.kind === "likely" ? " — the headline case" : ""}
                    </p>
                    <p className="tnum mt-1 text-sm">
                      MAGI at the headline draw: {fmtDollars(c.magiAtHeadline)}
                    </p>
                    {c.distanceAtHeadline != null && (
                      <p className="tnum text-sm">
                        {c.distanceAtHeadline >= 0
                          ? `${fmtDollars(c.distanceAtHeadline)} under the cliff`
                          : `${fmtDollars(-c.distanceAtHeadline)} over the cliff`}
                      </p>
                    )}
                    <p className="mt-1 text-sm">
                      {result.cliff == null
                        ? "No cliff priced"
                        : c.overCliffAtHeadline
                          ? "Credit lost — the final credit is $0"
                          : c.creditAtHeadline != null
                            ? `Final credit: ${fmtDollars(c.creditAtHeadline)}`
                            : "Credit kept"}
                    </p>
                    {result.cliff != null && state.aptcTaken > 0 && (
                      <p className="tnum mt-1 text-sm">
                        {c.overCliffAtHeadline
                          ? `Excess APTC repayment: repay the full ${fmtDollars(c.repaymentExposure)} of advance credit taken`
                          : c.excessAptcRepayment != null
                            ? `Excess APTC repayment: ${fmtDollars(c.excessAptcRepayment)}`
                            : "Excess APTC repayment: not priced — enter the benchmark premium"}
                      </p>
                    )}
                    {result.cliff != null &&
                      c.creditStillDue != null &&
                      c.creditStillDue > 0 && (
                        <p className="tnum mt-1 text-sm">
                          Additional credit still due: {fmtDollars(c.creditStillDue)}
                        </p>
                      )}
                    {c.netSettleAtHeadline == null ? (
                      <p className="mt-1 text-sm">
                        {c.netSettleNote ??
                          "For years before 2026 the advance-credit repayment isn’t modeled, so no single settlement figure is shown."}
                      </p>
                    ) : (
                      <p className="tnum mt-1 text-sm">
                        {c.netSettleAtHeadline < 0
                          ? "Estimated refund at filing"
                          : "Estimated amount to settle at filing"}
                        :{" "}
                        <span className="font-semibold">
                          {fmtDollars(c.netSettleAtHeadline)}
                        </span>
                      </p>
                    )}
                    {c.overCliffEvenAtZero && (
                      <p className="mt-1 text-sm font-medium text-[var(--bad)]">
                        Over the cliff even with a $0 draw.
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
            {result.warnings.map((w) => (
              <p key={w} className="mt-2 text-sm text-[var(--warn)]" role="note">
                {w}
              </p>
            ))}
          </>
        )}
      </section>

      {/* The year */}
      <section className={sectionCls} aria-label="The year">
        <h3 className="text-base font-semibold">The year</h3>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {numField("Tax year", form.taxYear, (v) => set("taxYear", v), {
            idLabel: "December tax year",
          })}
          <div>
            <label className={labelCls} htmlFor="december-filing">
              Filing status
            </label>
            <select
              id="december-filing"
              aria-label="December filing status"
              className={`${inputCls}`}
              value={form.filingStatus}
              onChange={(e) => set("filingStatus", e.target.value as FilingStatus)}
            >
              <option value="mfj">Married filing jointly</option>
              <option value="single">Single</option>
              <option value="hoh">Head of household</option>
            </select>
          </div>
          {numField("Age — primary", form.agePrimary, (v) => set("agePrimary", v), {
            idLabel: "December age primary",
            hint: "Age in the tax year.",
          })}
          {joint &&
            numField("Age — spouse", form.ageSpouse, (v) => set("ageSpouse", v), {
              idLabel: "December age spouse",
            })}
          {moneyField("Pre-tax balance — primary (prior Dec 31)", form.pretaxBalancePrimary, (v) => {
            setBalancesEdited(true);
            edit((f) => ({ ...f, pretaxBalancePrimary: v, pretaxSplitExplicit: true }));
          },
          { idLabel: "December pretax balance primary", hint: "The primary filer's own pre-tax balance. Sizes their RMD on their own clock and caps the draw. Enter 0 for a known-empty balance — blank means not entered, and only an entered balance caps the draw." },
          )}
          {joint &&
            moneyField("Pre-tax balance — spouse (prior Dec 31)", form.pretaxBalanceSpouse, (v) => {
              setBalancesEdited(true);
              edit((f) => ({ ...f, pretaxBalanceSpouse: v, pretaxSplitExplicit: true }));
            },
            { idLabel: "December pretax balance spouse", hint: "The spouse's own pre-tax balance — their RMD is computed on their own age and divisor table, not the primary's. Enter 0 for a known-empty balance — blank means not entered." },
            )}
          {moneyField("RMD already received this year", form.rmdAlreadyReceived, (v) =>
            set("rmdAlreadyReceived", v),
          { idLabel: "December RMD already received", hint: "The part of this year's RMD already paid — and already inside the year-to-date income below. It is subtracted from the RMD the balances imply, so a paid RMD is never counted twice." },
          )}
        </div>
        {decQ.data?.state &&
          !decQ.data.state.pretaxSplitExplicit &&
          decQ.data.state.pretaxBalance != null &&
          !balancesEdited && (
            <p className="mt-2 max-w-3xl text-sm text-[var(--dim)]" role="note">
              Balance ownership: this console’s saved state holds only a combined pre-tax
              total, so the per-owner balances above come from your Tax Plan record.
              Editing either balance here makes them this console’s own from then on.
            </p>
          )}
        {decQ.data?.state &&
          !decQ.data.state.pretaxSplitExplicit &&
          decQ.data.state.pretaxBalance != null &&
          !balancesEdited &&
          (() => {
            // Round-6: when the record's per-owner total
            // disagrees with this console's saved total,
            // name BOTH totals — the console prices its
            // own saved total, allocated by the record's
            // proportions (decemberCore resolution).
            const facts = recordFactsOf(rothQ.data);
            const savedTotal = decQ.data?.state?.pretaxBalance ?? null;
            if (
              facts.pretaxBalancePrimary == null ||
              facts.pretaxBalanceSpouse == null ||
              savedTotal == null
            ) {
              return null;
            }
            const recordSum = facts.pretaxBalancePrimary + facts.pretaxBalanceSpouse;
            if (Math.abs(recordSum - savedTotal) <= 0.01) return null;
            return (
              <p className="mt-2 max-w-3xl text-sm text-[var(--dim)]" role="note">
                Balance totals differ: your Tax Plan record’s per-owner balances add
                to {fmtDollars(recordSum)}, while this console’s saved total is{" "}
                {fmtDollars(savedTotal)}. This console prices its own saved total,
                split between the owners in the record’s proportions.
              </p>
            );
          })()}
        {decQ.data?.state &&
          !decQ.data.state.pretaxSplitExplicit &&
          decQ.data.state.pretaxBalance != null &&
          !balancesEdited &&
          (() => {
            // Round-7 fix A: the partial-cap case — exactly
            // one record amount is known and it exceeds the
            // saved total, so resolution caps that owner at
            // the saved total. Name both figures, in the
            // same one-note voice as the totals note above.
            const facts = recordFactsOf(rothQ.data);
            const savedTotal = decQ.data?.state?.pretaxBalance ?? null;
            if (savedTotal == null) return null;
            const known =
              facts.pretaxBalancePrimary != null &&
              facts.pretaxBalanceSpouse == null
                ? facts.pretaxBalancePrimary
                : facts.pretaxBalanceSpouse != null &&
                    facts.pretaxBalancePrimary == null
                  ? facts.pretaxBalanceSpouse
                  : null;
            if (known == null || known <= savedTotal + 0.01) return null;
            return (
              <p className="mt-2 max-w-3xl text-sm text-[var(--dim)]" role="note">
                Balance totals differ: your Tax Plan record shows{" "}
                {fmtDollars(known)} for one owner, while this console’s saved
                total is {fmtDollars(savedTotal)}. This console prices its own
                saved total, with that owner’s share capped at the saved total.
              </p>
            );
          })()}
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={form.onMedicarePrimary}
              onChange={(e) => set("onMedicarePrimary", e.target.checked)}
            />
            Primary on Medicare
          </label>
          {joint && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={form.onMedicareSpouse}
                onChange={(e) => set("onMedicareSpouse", e.target.checked)}
              />
              Spouse on Medicare
            </label>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={form.spouseSoleBeneficiary}
              onChange={(e) => set("spouseSoleBeneficiary", e.target.checked)}
            />
            Spouse is sole beneficiary of the pre-tax accounts
          </label>
        </div>
        {joint && (
          <div className="mt-3 max-w-md">
            <label
              className={labelCls}
              htmlFor="december-primary-sole-beneficiary-of-spouse"
            >
              You are the sole beneficiary of your spouse’s pre-tax accounts
            </label>
            <select
              id="december-primary-sole-beneficiary-of-spouse"
              aria-label="You are the sole beneficiary of your spouse’s pre-tax accounts"
              className={inputCls}
              value={
                form.primarySoleBeneficiaryOfSpouse == null
                  ? "unanswered"
                  : form.primarySoleBeneficiaryOfSpouse
                    ? "yes"
                    : "no"
              }
              onChange={(e) => {
                setBeneficiaryEdited(true);
                // Answering here settles the carried-over
                // answer too: the confirm flag clears.
                edit((f) => ({
                  ...f,
                  primarySoleBeneficiaryOfSpouse:
                    e.target.value === "unanswered"
                      ? null
                      : e.target.value === "yes",
                  legacyBeneficiaryAnswerUnconfirmed: false,
                }));
              }}
            >
              <option value="unanswered">Not answered</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
            {form.legacyBeneficiaryAnswerUnconfirmed && (
              <p className="mt-1 text-sm text-[var(--warn)]" role="note">
                This answer was carried over from an older version of this
                console — please check that it is still right.
              </p>
            )}
            <p className={hintCls}>
              This fact alone picks your spouse’s RMD table. “Not answered”
              prices it on the Uniform table; when your Tax Plan record
              answers this, that answer shows here until you answer in this
              console — and it is not saved into this console unless you
              change it here, so a later change to the record still flows
              in.
            </p>
          </div>
        )}
      </section>

      {/* Year-to-date actuals */}
      <section className={sectionCls} aria-label="Year-to-date actuals">
        <h3 className="text-base font-semibold">Already in — year-to-date actuals</h3>
        <p className="mt-1 text-sm text-[var(--dim)]">
          Income already posted this year, by category. These are facts, not estimates —
          enter them from year-to-date statements.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {moneyField("Wages & other ordinary income", form.ytdOtherOrdinary, (v) =>
            set("ytdOtherOrdinary", v),
          { idLabel: "December YTD other ordinary", hint: "Includes any RMD already received — enter that amount in “RMD already received this year” above so it isn’t counted twice." },
          )}
          {moneyField("Interest", form.ytdInterest, (v) => set("ytdInterest", v), {
            idLabel: "December YTD interest",
          })}
          {moneyField("Ordinary dividends (total)", form.ytdOrdinaryDividends, (v) =>
            set("ytdOrdinaryDividends", v),
          { idLabel: "December YTD ordinary dividends", hint: "The total — it includes the qualified part below." },
          )}
          {moneyField("Qualified dividends", form.ytdQualifiedDividends, (v) =>
            set("ytdQualifiedDividends", v),
          { idLabel: "December YTD qualified dividends" },
          )}
          {moneyField("Tax-exempt interest", form.ytdTaxExemptInterest, (v) =>
            set("ytdTaxExemptInterest", v),
          { idLabel: "December YTD tax-exempt interest", hint: "Tax-free, but it counts toward ACA MAGI." },
          )}
          {moneyField("Realized capital gain / loss so far", form.ytdCapitalGain, (v) =>
            set("ytdCapitalGain", v),
          { idLabel: "December YTD capital gain", hint: "Signed — enter a net loss as a negative amount." },
          )}
          {moneyField("Social Security — primary", form.ytdSsPrimary, (v) =>
            set("ytdSsPrimary", v),
          { idLabel: "December YTD SS primary" },
          )}
          {joint &&
            moneyField("Social Security — spouse", form.ytdSsSpouse, (v) =>
              set("ytdSsSpouse", v),
            { idLabel: "December YTD SS spouse" },
            )}
        </div>
      </section>

      {/* Remaining ranges */}
      <section className={sectionCls} aria-label="Still to come">
        <h3 className="text-base font-semibold">Still to come — December stragglers</h3>
        <p className="mt-1 text-sm text-[var(--dim)]">
          Income not yet posted, as a low / likely / high range per line. The headline draw
          is sized on the likely case; the low and high cases show what the same draw does
          if the stragglers land light or heavy.
        </p>
        {rangeRow("Capital-gain distributions still to come", "remCapDist",
          "Fund distributions estimated in the fall, final when they post in December.")}
        {rangeRow("Interest still to come", "remInterest")}
        {rangeRow("Ordinary dividends still to come (total)", "remOrdinaryDividends")}
        {rangeRow("Qualified dividends still to come", "remQualifiedDividends")}
        {rangeRow("Other income still to come", "remOtherOrdinary")}
      </section>

      {/* ACA block */}
      <section className={sectionCls} aria-label="ACA and the cliff">
        <h3 className="text-base font-semibold">ACA and the cliff</h3>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {numField("ACA household size", form.acaHouseholdSize, (v) =>
            set("acaHouseholdSize", v),
          { idLabel: "December ACA household size", hint: "The tax household for the year." },
          )}
          {moneyField("Benchmark premium (annual)", form.acaBenchmarkAnnual, (v) =>
            set("acaBenchmarkAnnual", v),
          { idLabel: "December ACA benchmark", hint: "Second-lowest-cost Silver plan for the household. Blank means the credit is not priced; an entered 0 prices a $0 credit." },
          )}
          {moneyField("Enrollment premium (annual, the plan actually enrolled in)", form.acaEnrollmentPremiumAnnual, (v) =>
            set("acaEnrollmentPremiumAnnual", v),
          { idLabel: "December ACA enrollment premium", hint: "Optional — leave blank for no cap. When entered, each case’s final credit is capped at this premium (the credit never exceeds the premium of the plan actually enrolled in), applied before any coverage-month reduction." },
          )}
          {moneyField("Advance credit (APTC) already taken", form.aptcTaken, (v) =>
            set("aptcTaken", v),
          { idLabel: "December APTC taken", hint: "Year-to-date. The repayment control is tracking cumulative advance credit taken — plus any scheduled remaining advances — against the projected final credit at the landing, which each case above shows. Any amount above the final credit is repaid in full at filing — no repayment caps after 2025. Over the cliff the final credit is $0, so the whole amount is repaid. Aligning the marketplace income estimate with the target is a starting input only and does not guarantee zero repayment — advances already paid under a different estimate are sunk." },
          )}
          {moneyField("Buffer below the cliff", form.bufferDollars, (v) =>
            set("bufferDollars", v),
          { idLabel: "December cliff buffer", hint: "The draw aims at cliff − buffer, so late surprises land in the buffer, not over the cliff." },
          )}
        </div>
        <p className="mt-3 max-w-3xl text-sm text-[var(--dim)]">
          The cliff rule: eligibility is lost only when MAGI ends <em>above</em> 400% of
          the poverty line for the household size — landing exactly at 400% remains
          eligible. The draw still aims at cliff − buffer, so the distinction changes
          nothing about the target, only about what counts as over.
        </p>
      </section>

      {/* Strays checklist */}
      <section className={sectionCls} aria-label="Strays checklist">
        <h3 className="text-base font-semibold">Strays checklist</h3>
        <p className="mt-1 text-sm text-[var(--dim)]">
          The late and easily missed items. Mark each one “doesn’t apply”, checked, or enter
          its amount — an amount flows into every case, on top of the ranges above, so don’t
          enter the same income in both places.
        </p>
        {strayRow("Capital-gain distribution estimates received", "strayCapDist", {
          amountLabel: "Estimated distributions not in the ranges above",
          hint: "Estimates are not finals — the final amounts can move when they post. The buffer absorbs that gap; it does not bound it.",
        })}
        {strayRow("Fund distributions paid in January but taxed this year", "strayJanPaid", {
          amountLabel: "January-paid distributions deemed received December 31",
          note: form.legacyJanPaidSplitUnconfirmed
            ? "Saved before the qualified-dividend split existed — check it: this amount predates the “of which qualified” field, so confirm the qualified portion below before relying on it."
            : undefined,
          hint: "A dividend declared in October–December with a December record date and paid in January is deemed received on December 31 — check each fund’s declarations and distribution calendar, not just cash postings. An exempt-interest portion belongs under the tax-exempt item below, not here.",
          extra: (
            <div className="mt-2 max-w-xs">
              {moneyField("Of which qualified dividends", form.strayJanPaidQualifiedAmount, (v) => {
                // Round-6: this field IS the January-paid
                // character control — editing it confirms
                // the character and clears its flag.
                setJanPaidCharacterEdited(true);
                edit((f) => ({
                  ...f,
                  strayJanPaidQualifiedAmount: v,
                  legacyJanPaidSplitUnconfirmed: false,
                }));
              },
              { idLabel: "December stray January-paid qualified portion", hint: "The part of the total above that is qualified dividends — it keeps its qualified character. Leave at $0 if none of it is qualified." },
              )}
            </div>
          ),
        })}
        {strayRow("Dividends & interest actuals complete", "strayDivInt", {
          amountLabel: "Money-market dividends / savings-bond interest not entered above",
          hint: "Include money-market dividends from any cash sleeve, and savings-bond interest in the year a bond matures or is redeemed — both are easy to leave out of the actuals above.",
        })}
        {strayRow("Gains on sales planned to fund taxes or raise cash", "strayPlannedSales", {
          amountLabel: "Forecast net gain on planned sales",
          hint: "Selling investments to pay the tax bill or raise spending cash realizes a gain too. Forecast it lot by lot (specific share lots), net of any prior-year capital-loss carryforward.",
        })}
        {strayRow("Return of capital reclassified as an ordinary dividend", "strayROCOrdinary", {
          // Round-6: this row IS the ROC character
          // control — editing it (status or amount)
          // confirms the character and clears its flag.
          onEdit: () => {
            setRocCharacterEdited(true);
            edit((f) => ({ ...f, legacyRocSplitUnconfirmed: false }));
          },
          amountLabel: "Amount reclassified as an ordinary dividend",
          note: form.legacyRocSplitUnconfirmed
            ? "Saved before this split existed — check it: the return-of-capital amount below was entered before there were two items, so confirm how much of it belongs here as an ordinary dividend."
            : undefined,
          hint: "When a fund reclassifies return of capital as a dividend, that part is an ORDINARY dividend — it is taxed as ordinary income, not as a capital gain. Enter it here, not under the capital part below.",
        })}
        {strayRow("Return of capital over basis (capital gain)", "strayROC", {
          amountLabel: "Income over basis (capital gain)",
          note: form.legacyRocSplitUnconfirmed
            ? "Saved before the split existed — check it: this amount was entered before the capital / ordinary split, so confirm the part above that was reclassified as an ordinary dividend."
            : undefined,
          hint: "Return of capital normally just reduces basis — it becomes income only once it exceeds the shares’ basis, and that part is a capital gain. Enter only that over-basis part here; a pure basis reduction is “checked — none”.",
        })}
        {strayRow("K-1 income (partnership, S-corp, trust)", "strayK1", {
          amountLabel: "K-1 income expected for the year (a deductible loss as a negative amount)",
          hint: "Taxable K-1 allocations count whether or not cash was distributed. A currently deductible K-1 loss is entered as a negative amount and reduces income dollar for dollar.",
        })}
        {strayRow("Tax-exempt interest beyond the actuals above", "strayTaxExempt", {
          amountLabel: "Additional tax-exempt interest",
          hint: "Federally tax-free, but added back for ACA MAGI.",
        })}
        {strayRow("A dependent in the household is required to file", "strayDependent", {
          amountLabel: "That dependent’s income",
          hint: "Count a dependent’s income toward household MAGI only when the dependent is required to file because their income meets the filing threshold — a return filed only to recover withholding does not count. Run the threshold test for each dependent. The amount counts toward the ACA household MAGI only — it is never added to the parents’ own taxable income.",
        })}
        {strayRow("Severance, bonus, or other one-off pay landing this year", "straySeverance", {
          amountLabel: "One-off pay still to land",
          hint: "Count actual pay events — severance, a bonus, an RSU settlement, an option exercise, deferred comp, a leave payout — from the payroll and equity-award schedules; vesting alone is not always a taxable event. Pay that already landed belongs in the year-to-date actuals, not here.",
        })}
        {strayRow("AGI reducers that actually work, used", "strayAgiReducers", {
          amountLabel: "Deductible HSA / IRA contributions & pre-tax deferrals not already reflected above",
          hint: "Below-the-line deductions never touch MAGI, but these do: deductible HSA contributions while eligible, pre-tax deferrals while working, and deductible traditional IRA contributions — including a spousal IRA for a nonworking spouse — where the household has earned compensation in the year and the deduction phase-outs allow it (IRA contributions for this year can be made until April 15 of next year). For HSA: eligibility is determined month by month, on the first of the month; the limit is net of employer contributions; disqualifying coverage (such as a general-purpose health FSA or a spouse’s non-HDHP plan) removes eligibility; and using the last-month rule carries a following-year testing period. An HSA contribution for this year can also still be made up to April 15 of next year — a post-December correction valve. A net capital loss also reduces AGI, up to $3,000 — that one rides the loss-harvesting item below. Enter only amounts not already reflected in the actuals above.",
        })}
        {strayRow("Coverage months reconciled", "strayCoverage", {
          amountLabel: "Credit reduction for ineligible months",
          hint: "The credit is monthly, not annual: a month in which a household member had an affordable employer offer, or was eligible for Medicare or CHIP, shrinks that month’s credit whatever the annual MAGI says. Reconcile each coverage month against the Form 1095-A; enter the total credit reduction for any ineligible months.",
        })}
        {strayRow("Loss harvesting done, wash sales checked", "strayLossHarvest", {
          amountLabel: "Harvested loss amount",
          hint: "A loss re-bought inside 30 days — in any account, including a spouse’s — is disallowed; check before counting it. Forward control: after any December loss sale, make no substantially identical purchases in any household account — including automatic dividend reinvestment and scheduled buys — until that sale’s 30-day post-sale window closes (the window runs into late January); a January purchase retroactively disallows a December loss. A wash sale triggered by an IRA repurchase disallows the loss permanently, not just for this year.",
        })}
        {strayRow("Brokerage clock: sales count by trade date", "strayTradeDate", {
          hint: "A sale executed on December 31 belongs to this tax year even though the proceeds settle in January. Use trade dates for every sale in the gains above — this clock is separate from the plan-distribution clock below.",
        })}
        {strayRow("Plan clock: the distribution counts when it is paid", "strayCutoff", {
          hint: "A plan distribution counts in the year it is paid — actually or constructively received — not the year it is requested and not when the cash finishes settling at the bank. Get the administrator’s payment date and December cutoff confirmed in writing; cutoffs land well before December 31. Also confirm the plan permits repeatable partial post-separation withdrawals — not only the payment date and cutoff.",
        })}
      </section>

      {/* Detail fold */}
      <section className={sectionCls} aria-label="Projection detail">
        <button
          type="button"
          aria-expanded={detailOpen}
          onClick={() => setDetailOpen(!detailOpen)}
          className="flex w-full items-start justify-between gap-3 text-left"
        >
          <span>
            <span className="block text-base font-semibold">Detail & pricing settings</span>
            <span className="mt-0.5 block text-sm text-[var(--dim)]">
              Per-case figures at the headline draw, state tax and itemized settings.
            </span>
          </span>
          <FoldChevron open={detailOpen} className="mt-0.5" />
        </button>
        {detailOpen && (
          <div className="mt-3">
            {result.priced && result.cases.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[34rem] text-sm">
                  <thead>
                    <tr className="text-left text-[var(--dim)]">
                      <th className="py-1 pr-3 font-medium">Case</th>
                      <th className="py-1 pr-3 font-medium">MAGI before any draw</th>
                      <th className="py-1 pr-3 font-medium">Own max draw</th>
                      <th className="py-1 pr-3 font-medium">Excess APTC repayment at headline</th>
                      <th className="py-1 pr-3 font-medium">Federal tax at headline</th>
                      <th className="py-1 font-medium">Total tax at headline</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.cases.map((c) => (
                      <tr key={c.kind} className="tnum border-t border-[var(--border)]">
                        <td className="py-1.5 pr-3 font-medium">{CASE_LABELS[c.kind]}</td>
                        <td className="py-1.5 pr-3">{fmtDollars(c.nonDrawAcaMagi)}</td>
                        <td className="py-1.5 pr-3">
                          {c.maxDraw == null ? "—" : fmtDollars(c.maxDraw)}
                        </td>
                        <td className="py-1.5 pr-3">
                          {c.excessAptcRepayment == null
                            ? "—"
                            : fmtDollars(c.excessAptcRepayment)}
                        </td>
                        <td className="py-1.5 pr-3">{fmtDollars(c.federalTaxAtHeadline)}</td>
                        <td className="py-1.5">{fmtDollars(c.totalTaxAtHeadline)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {pctField("State tax rate", form.stateRatePct, (v) => set("stateRatePct", v), {
                idLabel: "December state rate",
              })}
              <div>
                <label className={labelCls} htmlFor="december-residence">
                  State of residence
                </label>
                <select
                  id="december-residence"
                  aria-label="December state of residence"
                  className={inputCls}
                  value={form.residenceState}
                  onChange={(e) =>
                    set("residenceState", e.target.value as "WA" | "other")
                  }
                >
                  <option value="other">Flat state rate</option>
                  <option value="WA">Washington (capital-gains excise)</option>
                </select>
              </div>
              {moneyField("Itemized — mortgage interest", form.itemizedMortgageInterest, (v) =>
                set("itemizedMortgageInterest", v),
              { idLabel: "December itemized mortgage" },
              )}
              {moneyField("Itemized — state & local taxes paid", form.itemizedSaltPaid, (v) =>
                set("itemizedSaltPaid", v),
              { idLabel: "December itemized SALT" },
              )}
              {moneyField("Itemized — charitable", form.itemizedCharitable, (v) =>
                set("itemizedCharitable", v),
              { idLabel: "December itemized charitable" },
              )}
              {moneyField("Itemized — other", form.itemizedOther, (v) =>
                set("itemizedOther", v),
              { idLabel: "December itemized other" },
              )}
            </div>
            <p className="mt-3 max-w-3xl text-sm text-[var(--dim)]">
              How it prices: the year is assembled from the actuals, one range case, and the
              stray amounts, then priced by the shared single-year engine — the pre-tax draw
              rides the same pre-tax-money-out pricing as a conversion, dollar for dollar.
              The headline draw is the largest draw whose ACA MAGI stays at or under the
              cliff minus the buffer. Eligibility is lost only when MAGI ends above 400% of
              the poverty line — exactly 400% remains eligible — and the draw aims at
              cliff − buffer either way. Itemized deductions never change MAGI — they sit
              below the line — so they move the tax, never the cliff room. Reconciliation
              after 2025 has no repayment caps: every case repays any advance credit taken
              above its final allowable credit in full — over the cliff the final credit is
              $0, so the whole year’s advance credit taken is repaid; under the cliff, only
              the excess over the final credit.
            </p>
          </div>
        )}
      </section>

      <div className="mt-4">
        {!resetArmed ? (
          <button
            type="button"
            className="text-sm text-[var(--dim)] underline underline-offset-2 hover:text-[var(--text)]"
            onClick={() => setResetArmed(true)}
          >
            Reset the December console
          </button>
        ) : (
          <span className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-[var(--dim)]">
              Clear every December entry back to blank?
            </span>
            <button
              type="button"
              className="rounded-[var(--radius)] bg-[var(--bad)] px-4 py-2 text-sm font-medium text-white"
              onClick={() => {
                const blank = defaultDecemberState(new Date().getFullYear());
                dirtyRef.current = true;
                // A reset is the user's own answer for every
                // field: the blank state saves verbatim, with
                // no stored provenance preserved.
                setBeneficiaryEdited(true);
                setBalancesEdited(true);
                setRocCharacterEdited(true);
                setJanPaidCharacterEdited(true);
                setForm(formFromState(blank));
                setResetArmed(false);
              }}
            >
              Yes, clear it
            </button>
            <button
              type="button"
              className="rounded-[var(--radius)] border border-[var(--border)] px-4 py-2 text-sm font-medium hover:text-[var(--accent)]"
              onClick={() => setResetArmed(false)}
            >
              Keep my entries
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
