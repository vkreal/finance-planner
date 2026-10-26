import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
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
  defaultDecemberState,
  type DecemberCaseKind,
  type DecemberState,
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
   Plan record where available; everything else starts blank. */

/* The form carries typed strings, like the Playground form;
   the saved state carries numbers. These two converters are
   the only boundary. A $0 amount shows blank, as on the other
   views' money dials. */
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
  aptcTaken: string;
  bufferDollars: string;
  pretaxBalance: string;
  spouseSoleBeneficiary: boolean;
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
  strayDivInt: StrayForm;
  strayPlannedSales: StrayForm;
  strayROC: StrayForm;
  strayAgiReducers: StrayForm;
  strayCoverage: StrayForm;
  strayTradeDate: StrayForm;
};

const moneyStr = (n: number): string => (n === 0 ? "" : fmtMoneyInput(n));
const numStr = (n: number | null): string => (n == null ? "" : String(n));
const parseMoney = (s: string): number => {
  const cleaned = s.replace(/[$,\s]/g, "");
  if (cleaned === "") return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
};
const parseMoneyOrNull = (s: string): number | null => {
  const cleaned = s.replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
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
    acaBenchmarkAnnual: moneyStr(s.acaBenchmarkAnnual ?? 0),
    aptcTaken: moneyStr(s.aptcTaken),
    bufferDollars: fmtMoneyInput(s.bufferDollars),
    pretaxBalance: s.pretaxBalance == null ? "" : moneyStr(s.pretaxBalance),
    spouseSoleBeneficiary: s.spouseSoleBeneficiary,
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
    strayDivInt: st(s.strayDivInt),
    strayPlannedSales: st(s.strayPlannedSales),
    strayROC: st(s.strayROC),
    strayAgiReducers: st(s.strayAgiReducers),
    strayCoverage: st(s.strayCoverage),
    strayTradeDate: st(s.strayTradeDate),
  };
}

function stateFromForm(f: DecForm): DecemberState {
  const clamp0 = (n: number) => Math.max(0, n);
  const rg = (r: RangeForm) => ({
    low: parseMoney(r.low),
    likely: parseMoney(r.likely),
    high: parseMoney(r.high),
  });
  const st = (x: StrayForm): DecemberStray => ({
    status: x.status,
    amount: clamp0(parseMoney(x.amount)),
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
    remCapDist: rg(f.remCapDist),
    remInterest: rg(f.remInterest),
    remOrdinaryDividends: rg(f.remOrdinaryDividends),
    remQualifiedDividends: rg(f.remQualifiedDividends),
    remOtherOrdinary: rg(f.remOtherOrdinary),
    acaHouseholdSize: size != null && size >= 1 && size <= 20 ? size : null,
    acaBenchmarkAnnual: (() => {
      const n = parseMoneyOrNull(f.acaBenchmarkAnnual);
      return n == null ? null : clamp0(n);
    })(),
    aptcTaken: clamp0(parseMoney(f.aptcTaken)),
    bufferDollars: clamp0(parseMoney(f.bufferDollars)),
    pretaxBalance: (() => {
      const n = parseMoneyOrNull(f.pretaxBalance);
      return n == null ? null : clamp0(n);
    })(),
    spouseSoleBeneficiary: f.spouseSoleBeneficiary,
    stateRatePct: Math.min(100, clamp0(parseMoney(f.stateRatePct))),
    residenceState: f.residenceState,
    itemizedMortgageInterest: clamp0(parseMoney(f.itemizedMortgageInterest)),
    itemizedSaltPaid: clamp0(parseMoney(f.itemizedSaltPaid)),
    itemizedCharitable: clamp0(parseMoney(f.itemizedCharitable)),
    itemizedOther: clamp0(parseMoney(f.itemizedOther)),
    strayCapDist: st(f.strayCapDist),
    strayK1: st(f.strayK1),
    strayTaxExempt: st(f.strayTaxExempt),
    strayDependent: st(f.strayDependent),
    straySeverance: st(f.straySeverance),
    strayLossHarvest: st(f.strayLossHarvest),
    strayCutoff: st(f.strayCutoff),
    strayJanPaid: st(f.strayJanPaid),
    strayDivInt: st(f.strayDivInt),
    strayPlannedSales: st(f.strayPlannedSales),
    strayROC: st(f.strayROC),
    strayAgiReducers: st(f.strayAgiReducers),
    strayCoverage: st(f.strayCoverage),
    strayTradeDate: st(f.strayTradeDate),
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
    mutationFn: (state: DecemberState) => api.saveDecemberProjection({ state }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["decemberprojection"] });
    },
  });

  const [form, setForm] = useState<DecForm | null>(null);
  const hydratedRef = useRef(false);
  const dirtyRef = useRef(false);
  const [saveNote, setSaveNote] = useState<string>("");
  const [resetArmed, setResetArmed] = useState(false);
  const [detailOpen, setDetailOpen] = usePersistedFold("december.detail", false);

  /* Hydrate once from the stored blob. On a first-ever open
     (nothing stored) preseed the year block from the saved Tax
     Plan record where available, and save that preseed so the
     session reopens on it. */
  useEffect(() => {
    if (hydratedRef.current) return;
    if (!decQ.data) return;
    // On a first open the preseed reads the Tax Plan record —
    // wait for that read to settle before hydrating, so the
    // preseed is never skipped just for losing a race. A stored
    // console needs no preseed and hydrates immediately.
    if (!decQ.data.hasStored && rothQ.isPending) return;
    hydratedRef.current = true;
    let initial = formFromState(decQ.data.state);
    if (!decQ.data.hasStored && rothQ.data) {
      const s = rothQ.data.saved;
      const snap = rothQ.data.snapshot;
      const year = decQ.data.state.taxYear;
      if (s) {
        const size =
          s.acaHouseholdSize != null
            ? acaHouseholdSizeForYear(s.acaHouseholdSize, s.acaHouseholdSchedule ?? null, year)
            : null;
        const benchmarkCents =
          size == null
            ? null
            : size >= 3
              ? (s.acaBenchmarkFamilyCents ?? s.acaBenchmarkCoupleCents)
              : size === 2
                ? s.acaBenchmarkCoupleCents
                : s.acaBenchmarkSingleCents;
        const pretaxCents =
          (s.pretaxCents ?? snap?.pretaxCents ?? null) != null ||
          s.pretaxSpouseCents != null
            ? (s.pretaxCents ?? snap?.pretaxCents ?? 0) + (s.pretaxSpouseCents ?? 0)
            : null;
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
          pretaxBalance: pretaxCents != null ? fmtMoneyInput(pretaxCents / 100) : initial.pretaxBalance,
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
    setForm(initial);
    if (!decQ.data.hasStored) {
      dirtyRef.current = true;
    }
    // Hydrate exactly once, from the first stored read (plus the
    // Tax Plan record on a first open, per the wait above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decQ.data, rothQ.data, rothQ.isPending]);

  /* Debounced autosave of every edit, so the December session
     can be left and reopened at any point. */
  useEffect(() => {
    if (!form || !dirtyRef.current) return;
    setSaveNote("Saving…");
    const t = setTimeout(() => {
      saveMut.mutate(stateFromForm(form), {
        onSuccess: () => setSaveNote("Saved"),
        onError: () => setSaveNote("Could not save — your entries stay on this screen."),
      });
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
      | "strayAgiReducers"
      | "strayCoverage"
      | "strayTradeDate",
    opts?: { amountLabel?: string; hint?: string },
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
            onChange={(e) =>
              edit((f) => ({
                ...f,
                [key]: { ...f[key], status: e.target.value as StrayForm["status"] },
              }))
            }
          >
            <option value="na">Doesn’t apply</option>
            <option value="confirmed">Checked — none / confirmed</option>
            {hasAmount && <option value="amount">Amount applies</option>}
          </select>
        </div>
        {opts?.hint && <p className={hintCls}>{opts.hint}</p>}
        {hasAmount && item.status === "amount" && (
          <div className="mt-2 max-w-xs">
            {moneyField(opts.amountLabel!, item.amount, (v) =>
              edit((f) => ({ ...f, [key]: { ...f[key], amount: v } })),
            { idLabel: `December stray ${label} amount` },
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      <h2 className="mt-4 text-base font-semibold">December projection</h2>
      <p className="mt-1 max-w-3xl text-sm text-[var(--dim)]">
        A year-end projection for the December decision: enter what has already posted this
        year and what is still to come, and read the largest pre-tax draw that keeps the
        year under the ACA cliff, with a safety buffer. Priced by the same single-year tax
        engine as the Playground.
      </p>
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
          {moneyField("Pre-tax balance (prior Dec 31)", form.pretaxBalance, (v) =>
            set("pretaxBalance", v),
          { idLabel: "December pretax balance", hint: "Sizes any RMD and caps the draw." },
          )}
        </div>
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
          { idLabel: "December YTD other ordinary" },
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
          { idLabel: "December ACA benchmark", hint: "Second-lowest-cost Silver plan for the household." },
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
          hint: "A dividend declared in October–December with a December record date and paid in January is deemed received on December 31 — check each fund’s declarations and distribution calendar, not just cash postings. An exempt-interest portion belongs under the tax-exempt item below, not here.",
        })}
        {strayRow("Dividends & interest actuals complete", "strayDivInt", {
          amountLabel: "Money-market dividends / savings-bond interest not entered above",
          hint: "Include money-market dividends from any cash sleeve, and savings-bond interest in the year a bond matures or is redeemed — both are easy to leave out of the actuals above.",
        })}
        {strayRow("Gains on sales planned to fund taxes or raise cash", "strayPlannedSales", {
          amountLabel: "Forecast net gain on planned sales",
          hint: "Selling investments to pay the tax bill or raise spending cash realizes a gain too. Forecast it lot by lot (specific share lots), net of any prior-year capital-loss carryforward.",
        })}
        {strayRow("Return of capital received", "strayROC", {
          amountLabel: "Only the part that is income (over basis, or reclassified)",
          hint: "Return of capital normally just reduces basis — it is income only when it is reclassified as a dividend or distribution, or once it exceeds the shares’ basis (then it is a capital gain). Enter only that income part; a pure basis reduction is “checked — none”.",
        })}
        {strayRow("K-1 income (partnership, S-corp, trust)", "strayK1", {
          amountLabel: "K-1 income expected for the year",
        })}
        {strayRow("Tax-exempt interest beyond the actuals above", "strayTaxExempt", {
          amountLabel: "Additional tax-exempt interest",
          hint: "Federally tax-free, but added back for ACA MAGI.",
        })}
        {strayRow("A dependent in the household is required to file", "strayDependent", {
          amountLabel: "That dependent’s income",
          hint: "Count a dependent’s income toward household MAGI only when the dependent is required to file because their income meets the filing threshold — a return filed only to recover withholding does not count. Run the threshold test for each dependent.",
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
