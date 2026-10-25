import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { usePersistedFold } from "./foldState";

/* Blocks dissolved out of the former Year Summary view:
   - YearInSpendingBlock: the old page's Spending section, now a
     section of the Spending view (below the monthly sections).
   - TrendBlock: the old page's "Trend — all years" table, now in
     the Net Worth view after the chart, carrying the anchor-basis
     note and the per-year Net Worth detail the table itself does
     not carry (first snapshot, change %, snapshot count, movers).
   Both read through getYearSummary — the same action, composed
   from the same spending core the dashboard and Slice & dice use
   and the same per-snapshot Net Worth totals, so no figure can
   drift from what the Year Summary view showed. */

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function fmt(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  const rem = abs % 100;
  const s = rem === 0 ? `$${dollars}` : `$${dollars}.${String(rem).padStart(2, "0")}`;
  return neg ? `−${s}` : s;
}
function fmtSigned(cents: number): string {
  if (cents === 0) return fmt(0);
  return cents > 0 ? `+${fmt(cents)}` : fmt(cents);
}
function fmtPct(frac: number): string {
  const pct = Math.abs(frac * 100).toFixed(2);
  if (frac > 0) return `+${pct}%`;
  if (frac < 0) return `−${pct}%`;
  return "0.00%";
}
function fmtDateLong(date: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${MONTH_SHORT[m - 1] ?? ""} ${d}, ${y}`;
}

const btnGhost =
  "rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-medium text-[var(--text)]";

/* The Net Worth anchor note with its reconciliation remainder
   behind a quiet local "More" toggle: the endpoints sentence
   stays visible; the remainder renders verbatim in place when
   expanded, so first + " " + rest is byte-identical to the
   note as previously printed in full. The visible first part
   is a dynamic string, so the server-persisted Explainer does
   not fit here; the open/closed state itself persists in the
   generic fold store ("nw.trendAnchor") instead, so the note
   comes back expanded or collapsed exactly as left. The
   toggle is a real button with aria-expanded / aria-controls,
   styled like the Explainer's. */
function AnchorNote({ first, rest }: { first: string; rest: string }) {
  const [open, setOpen] = usePersistedFold("nw.trendAnchor");
  const rawId = useId();
  const regionId = `ys-anchor-${rawId.replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <p className="mt-3 text-sm leading-relaxed text-[var(--dim)]">
      {first}
      {open && <span id={regionId}> {rest}</span>}{" "}
      <button
        type="button"
        aria-label={
          open
            ? "Less about the year change anchor"
            : "More about the year change anchor"
        }
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen(!open)}
        className="font-medium whitespace-nowrap text-[var(--accent)] underline underline-offset-2"
      >
        {open ? "Less" : "More"}
      </button>
    </p>
  );
}

function yearOptionsFor(
  selectedYear: number,
  currentYear: number,
  availableYears: number[] | undefined,
): number[] {
  const s = new Set<number>();
  s.add(selectedYear);
  s.add(currentYear);
  for (const y of availableYears ?? []) s.add(y);
  return [...s].sort((a, b) => a - b);
}

function YearPicker({
  id,
  ariaLabel,
  selectedYear,
  options,
  onChange,
}: {
  id: string;
  ariaLabel: string;
  selectedYear: number;
  options: number[];
  onChange: (year: number) => void;
}) {
  return (
    <div className="flex items-center gap-2 print:hidden">
      <button
        type="button"
        aria-label="Previous year"
        className={btnGhost}
        onClick={() => onChange(selectedYear - 1)}
      >
        ←
      </button>
      <label htmlFor={id} className="sr-only">
        Year
      </label>
      <select
        id={id}
        aria-label={ariaLabel}
        className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-base text-[var(--text)]"
        value={selectedYear}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
      >
        {options.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
      <button
        type="button"
        aria-label="Next year"
        className={btnGhost}
        onClick={() => onChange(selectedYear + 1)}
      >
        →
      </button>
    </div>
  );
}

/* ---------------- Year in spending (Spending view) ---------------- */

export function YearInSpendingBlock({
  collapsed,
  onToggleCollapsed,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState<number>(currentYear);
  const summary = useQuery({
    queryKey: ["yearsummary", selectedYear],
    queryFn: () => api.getYearSummary({ year: selectedYear }),
    enabled: !collapsed,
  });
  const data = summary.data;

  const yearOptions = yearOptionsFor(
    selectedYear,
    currentYear,
    data?.availableYears,
  );

  // Spending scope: the months the totals actually cover (first →
  // last month with data), named in a line under the section title.
  const spendingScopeLabel = (() => {
    if (!data?.spending.hasData) return null;
    const months = data.spending.months;
    const first = months[0];
    const last = months[months.length - 1];
    if (!first || !last) return null;
    const firstName = MONTH_NAMES[first.monthNum - 1] ?? "";
    const lastName = MONTH_NAMES[last.monthNum - 1] ?? "";
    const base =
      first.month === last.month
        ? `${firstName} ${selectedYear} — totals run through the last month with data.`
        : `${firstName}–${lastName} ${selectedYear} — totals run through the last month with data.`;
    return data.spending.lastMonthInProgress
      ? `${base} ${lastName} is still in progress.`
      : base;
  })();

  // The in-progress month, when the viewed year is the current year:
  // the last included month is the current month.
  const inProgressMonth = data?.spending.lastMonthInProgress
    ? (data.spending.months[data.spending.months.length - 1]?.month ?? null)
    : null;
  const monthLine = (
    m: { month: string; monthNum: number; trueCostCents: number; oneOffsCents: number },
    label: string,
  ) => (
    <li key={label} className="flex flex-wrap items-baseline gap-x-2">
      <span className="font-medium">{label}:</span>
      <span>
        {MONTH_NAMES[m.monthNum - 1] ?? m.month} — {fmt(m.trueCostCents)}
        {m.oneOffsCents > 0 && <> incl. {fmt(m.oneOffsCents)} one-offs</>}
        {inProgressMonth != null && m.month === inProgressMonth && (
          <> (month still in progress)</>
        )}
      </span>
    </li>
  );

  return (
    <section
      id="section-year-in-spending"
      aria-label="Year in spending"
      className="mt-8 scroll-mt-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="display text-xl font-semibold">Year in spending</h2>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={btnGhost}
            aria-expanded={!collapsed}
            aria-controls="year-in-spending-content"
            onClick={onToggleCollapsed}
          >
            {collapsed ? "Expand all" : "Collapse all"}
          </button>
          <YearPicker
            id="year-in-spending-year"
            ariaLabel="Select year for Year in spending"
            selectedYear={selectedYear}
            options={yearOptions}
            onChange={setSelectedYear}
          />
        </div>
      </div>

      {!collapsed && (
        <div id="year-in-spending-content">
          {summary.isPending && (
            <p className="py-6 text-center text-[var(--dim)]">Loading…</p>
          )}
          {summary.isError && (
            <p className="py-6 text-center text-[var(--bad)]">
              Something went wrong loading this year. Try again.
            </p>
          )}
          {data && (
            <>
              {!data.spending.hasData ? (
                <p className="mt-3 text-sm text-[var(--dim)]">
                  No spending data for this year.
                </p>
              ) : (
                <>
                  {spendingScopeLabel && (
                    <p className="mt-1.5 text-sm text-[var(--dim)]">
                      {spendingScopeLabel}
                    </p>
                  )}
                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div className="rounded-[var(--radius)] border border-[var(--border)] p-3.5">
                      <p className="text-[10.5px] font-medium tracking-[0.02em] text-[var(--dim)] uppercase">
                        Total True cost
                      </p>
                      <p className="tnum display mt-1.5 text-xl font-semibold">
                        {fmt(data.spending.totalTrueCostCents)}
                      </p>
                      <p className="mt-1 text-xs text-[var(--dim)]">
                        {data.spending.monthsWithData}{" "}
                        {data.spending.monthsWithData === 1 ? "month" : "months"} with data
                      </p>
                    </div>
                    <div className="rounded-[var(--radius)] border border-[var(--border)] p-3.5">
                      <p className="text-[10.5px] font-medium tracking-[0.02em] text-[var(--dim)] uppercase">
                        Total Cash out
                      </p>
                      <p className="tnum display mt-1.5 text-xl font-semibold">
                        {fmt(data.spending.totalCashOutCents)}
                      </p>
                    </div>
                    <div className="rounded-[var(--radius)] border border-[var(--border)] p-3.5">
                      <p className="text-[10.5px] font-medium tracking-[0.02em] text-[var(--dim)] uppercase">
                        Monthly average True cost
                      </p>
                      <p className="tnum display mt-1.5 text-xl font-semibold">
                        {fmt(data.spending.averageTrueCostCents)}
                      </p>
                      <p className="mt-1 text-xs text-[var(--dim)]">
                        Total True cost ÷ months with data
                      </p>
                    </div>
                  </div>
                  <div className="mt-4 overflow-x-auto">
                    <table className="tnum w-full min-w-[420px] border-collapse text-sm">
                      <caption className="sr-only">
                        True cost and Cash out by month for {selectedYear}
                      </caption>
                      <thead>
                        <tr className="border-b border-[var(--border)] text-left">
                          <th scope="col" className="py-2 pr-3 font-semibold">Month</th>
                          <th scope="col" className="py-2 pr-3 text-right font-semibold">True cost</th>
                          <th scope="col" className="py-2 text-right font-semibold">Cash out</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.spending.months.map((m) => (
                          <tr key={m.month} className="border-b border-[var(--border)]">
                            <th scope="row" className="py-2 pr-3 text-left font-medium">
                              {MONTH_NAMES[m.monthNum - 1] ?? m.month} {selectedYear}
                            </th>
                            <td className="py-2 pr-3 text-right whitespace-nowrap">
                              {fmt(m.trueCostCents)}
                            </td>
                            <td className="py-2 text-right whitespace-nowrap">
                              {fmt(m.cashOutCents)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="font-semibold">
                          <th scope="row" className="py-2 pr-3 text-left">Total</th>
                          <td className="py-2 pr-3 text-right whitespace-nowrap">
                            {fmt(data.spending.totalTrueCostCents)}
                          </td>
                          <td className="py-2 text-right whitespace-nowrap">
                            {fmt(data.spending.totalCashOutCents)}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                  <div className="mt-5 border-t border-[var(--border)] pt-4">
                    <ul className="space-y-1.5 text-sm">
                      {data.spending.highestMonth &&
                        monthLine(data.spending.highestMonth, "Highest month")}
                      {data.spending.lowestMonth &&
                        monthLine(data.spending.lowestMonth, "Lowest month")}
                      {data.spending.totalOneOffsCents > 0 && (
                        <li className="flex flex-wrap items-baseline gap-x-2">
                          <span className="font-medium">One-offs this year:</span>
                          <span>{fmt(data.spending.totalOneOffsCents)}</span>
                        </li>
                      )}
                    </ul>
                    {data.spending.topCategories.length > 0 && (
                      <div className="mt-3">
                        <h3 className="text-sm font-semibold">Top categories</h3>
                        <ul className="mt-1.5 space-y-1.5">
                          {data.spending.topCategories.map((c) => (
                            <li
                              key={c.label}
                              className="flex items-baseline justify-between gap-3 text-sm"
                            >
                              <span className="min-w-0 truncate">{c.label}</span>
                              <span className="tnum shrink-0 font-medium">
                                {fmt(c.totalCents)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <p className="mt-3 text-sm text-[var(--dim)]">
                      Average month {fmt(data.spending.averageTrueCostCents)} — the
                      keep-the-lights-on floor is{" "}
                      {fmt(data.spending.keepLightsOnFloorCents)}/mo at today&apos;s bills.
                    </p>
                  </div>
                  {data.spending.excludedPayments.map((p) => (
                    <p key={p.month} className="mt-3 text-sm text-[var(--dim)]">
                      {MONTH_NAMES[p.monthNum - 1] ?? p.month} payments of{" "}
                      {fmt(p.totalCents)} are recorded but not included in
                      these totals.
                    </p>
                  ))}
                </>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

/* ---------------- Trend — all years (Net Worth view) ---------------- */

export function TrendBlock() {
  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState<number>(currentYear);
  const summary = useQuery({
    queryKey: ["yearsummary", selectedYear],
    queryFn: () => api.getYearSummary({ year: selectedYear }),
  });
  const data = summary.data;

  const yearOptions = yearOptionsFor(
    selectedYear,
    currentYear,
    data?.availableYears,
  );

  const gains =
    data?.netWorth.movers.filter((m) => m.changeCents > 0).slice(0, 3) ?? [];
  const declines =
    data?.netWorth.movers
      .filter((m) => m.changeCents < 0)
      .slice()
      .sort((a, b) => a.changeCents - b.changeCents)
      .slice(0, 3) ?? [];

  // Net Worth change-anchor reconciliation: this view's change runs
  // from the year's first snapshot to its last; the Net Worth view's
  // Year to date runs from the prior year's last snapshot. When a
  // prior snapshot exists, the two differ by the movement between
  // that snapshot and this year's first.
  const nwAnchorParts = (() => {
    if (!data?.netWorth.hasData) return null;
    const nw = data.netWorth;
    if (!nw.firstDate || !nw.lastDate) return null;
    const endpoints = `Change for the year is measured from this year's first snapshot (${fmtDateLong(nw.firstDate)}) to its last (${fmtDateLong(nw.lastDate)}).`;
    if (
      nw.priorYearLastDate &&
      nw.priorYearLastTotalCents != null &&
      nw.firstTotalCents != null
    ) {
      const movement = nw.firstTotalCents - nw.priorYearLastTotalCents;
      return {
        first: endpoints,
        rest: `The Net Worth view's Year to date is measured from the prior year's last snapshot (${fmtDateLong(nw.priorYearLastDate)}), so the two differ by the ${fmtSigned(movement)} movement between ${fmtDateLong(nw.priorYearLastDate)} and ${fmtDateLong(nw.firstDate)}.`,
      };
    }
    return {
      first: endpoints,
      rest: `No snapshot precedes this year, so there is no earlier starting point for the Net Worth view's Year to date to differ from.`,
    };
  })();

  return (
    <section
      aria-label="Multi-year trend"
      className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5 print:break-inside-avoid"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="display text-xl font-semibold">Trend — all years</h3>
        <YearPicker
          id="trend-year"
          ariaLabel="Select year for year detail"
          selectedYear={selectedYear}
          options={yearOptions}
          onChange={setSelectedYear}
        />
      </div>

      {summary.isPending && (
        <p className="py-6 text-center text-[var(--dim)]">Loading trend…</p>
      )}
      {summary.isError && (
        <p className="py-6 text-center text-[var(--bad)]">
          Something went wrong loading the trend. Try again.
        </p>
      )}

      {data && (
        <>
          <div className="mt-3 overflow-x-auto">
            <table className="tnum w-full min-w-[560px] border-collapse text-sm">
              <caption className="sr-only">
                Spending and net worth by year
              </caption>
              <thead>
                <tr className="border-b border-[var(--border)] text-left">
                  <th scope="col" className="py-2 pr-3 font-semibold">Year</th>
                  <th scope="col" className="py-2 pr-3 text-right font-semibold">
                    Months of spending data
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-semibold">
                    True cost
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-semibold">
                    Net-worth change
                  </th>
                  <th scope="col" className="py-2 text-right font-semibold">
                    Ending net worth
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.trend.map((row) => (
                  <tr
                    key={row.year}
                    className={`border-b border-[var(--border)] ${
                      row.year === selectedYear
                        ? "bg-[var(--bg)] font-semibold"
                        : ""
                    }`}
                  >
                    <th scope="row" className="py-2 pr-3 text-left font-medium">
                      {row.year}
                    </th>
                    <td className="py-2 pr-3 text-right">{row.monthsWithData}</td>
                    <td className="py-2 pr-3 text-right whitespace-nowrap">
                      {row.trueCostCents != null ? fmt(row.trueCostCents) : "—"}
                    </td>
                    <td className="py-2 pr-3 text-right whitespace-nowrap">
                      {row.nwChangeCents != null
                        ? fmtSigned(row.nwChangeCents)
                        : "—"}
                    </td>
                    <td className="py-2 text-right whitespace-nowrap">
                      {row.nwEndingCents != null ? fmt(row.nwEndingCents) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {nwAnchorParts && (
            <AnchorNote
              first={nwAnchorParts.first}
              rest={nwAnchorParts.rest}
            />
          )}

          {/* Per-year Net Worth detail the Trend table does not
              carry: the year's first snapshot, the change as a
              percentage with the snapshot count, the last snapshot's
              date, and the biggest movers. The change and ending
              dollar figures themselves live in the table above. */}
          <div className="mt-5 border-t border-[var(--border)] pt-4">
            <h4 className="text-base font-semibold">
              Net Worth — {selectedYear}
            </h4>
            {!data.netWorth.hasData ? (
              <p className="mt-3 text-sm text-[var(--dim)]">
                No data for {selectedYear}
              </p>
            ) : (
              <>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="rounded-[var(--radius)] border border-[var(--border)] p-3.5">
                    <p className="text-[10.5px] font-medium tracking-[0.02em] text-[var(--dim)] uppercase">
                      First snapshot
                    </p>
                    <p className="tnum display mt-1.5 text-xl font-semibold">
                      {data.netWorth.firstTotalCents != null
                        ? fmt(data.netWorth.firstTotalCents)
                        : "—"}
                    </p>
                    <p className="mt-1 text-xs text-[var(--dim)]">
                      {data.netWorth.firstDate
                        ? fmtDateLong(data.netWorth.firstDate)
                        : ""}
                    </p>
                  </div>
                  <div className="rounded-[var(--radius)] border border-[var(--border)] p-3.5">
                    <p className="text-[10.5px] font-medium tracking-[0.02em] text-[var(--dim)] uppercase">
                      Change for the year
                    </p>
                    <p
                      className={`tnum display mt-1.5 text-xl font-semibold ${
                        (data.netWorth.changeCents ?? 0) > 0
                          ? "text-[var(--accent)]"
                          : (data.netWorth.changeCents ?? 0) < 0
                            ? "text-[var(--bad)]"
                            : ""
                      }`}
                    >
                      {data.netWorth.changePctFrac != null
                        ? fmtPct(data.netWorth.changePctFrac)
                        : "—"}
                    </p>
                    <p className="tnum mt-1 text-xs text-[var(--dim)]">
                      {data.netWorth.snapshotCount}{" "}
                      {data.netWorth.snapshotCount === 1 ? "snapshot" : "snapshots"} this year
                    </p>
                  </div>
                  <div className="rounded-[var(--radius)] border border-[var(--border)] p-3.5">
                    <p className="text-[10.5px] font-medium tracking-[0.02em] text-[var(--dim)] uppercase">
                      Last snapshot
                    </p>
                    <p className="display mt-1.5 text-xl font-semibold">
                      {data.netWorth.lastDate
                        ? fmtDateLong(data.netWorth.lastDate)
                        : "—"}
                    </p>
                  </div>
                </div>

                {(gains.length > 0 || declines.length > 0) && (
                  <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <h5 className="text-base font-semibold">Biggest gains</h5>
                      {gains.length === 0 ? (
                        <p className="mt-2 text-sm text-[var(--dim)]">No accounts gained this year.</p>
                      ) : (
                        <ul className="mt-2 space-y-2">
                          {gains.map((m) => (
                            <li
                              key={m.accountId}
                              className="flex items-baseline justify-between gap-3 border-b border-[var(--border)] pb-2"
                            >
                              <span className="min-w-0">
                                <span className="block truncate text-sm font-medium">{m.accountName}</span>
                                <span className="tnum block text-xs text-[var(--dim)]">
                                  {m.startCents != null ? fmt(m.startCents) : "—"} →{" "}
                                  {m.endCents != null ? fmt(m.endCents) : "—"}
                                </span>
                              </span>
                              <span className="tnum shrink-0 text-sm font-medium text-[var(--accent)]">
                                {fmtSigned(m.changeCents)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div>
                      <h5 className="text-base font-semibold">Biggest declines</h5>
                      {declines.length === 0 ? (
                        <p className="mt-2 text-sm text-[var(--dim)]">No accounts declined this year.</p>
                      ) : (
                        <ul className="mt-2 space-y-2">
                          {declines.map((m) => (
                            <li
                              key={m.accountId}
                              className="flex items-baseline justify-between gap-3 border-b border-[var(--border)] pb-2"
                            >
                              <span className="min-w-0">
                                <span className="block truncate text-sm font-medium">{m.accountName}</span>
                                <span className="tnum block text-xs text-[var(--dim)]">
                                  {m.startCents != null ? fmt(m.startCents) : "—"} →{" "}
                                  {m.endCents != null ? fmt(m.endCents) : "—"}
                                </span>
                              </span>
                              <span className="tnum shrink-0 text-sm font-medium text-[var(--bad)]">
                                {fmtSigned(m.changeCents)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                )}
                {gains.length === 0 && declines.length === 0 && (
                  <p className="mt-3 text-sm text-[var(--dim)]">
                    {data.netWorth.snapshotCount <= 1
                      ? "Only one snapshot this year, so there are no movers to compare yet."
                      : "No account changed this year, so there are no movers to show."}
                  </p>
                )}
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
