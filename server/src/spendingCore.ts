// Spending computation core — the single implementation of the
// per-month spending math (accrual, the cash-out resolution, the
// reserve, and the Coming up forecast), shared by the dashboard and
// Year Summary actions and by the extended accuracy fixtures
// (server/src/extendedFixtures.ts), so the fixture suite exercises
// the exact code the views run.
//
// The version/date helpers below are the app's only copies; actions
// import them from here. Generic row types keep every call site's
// full row typing intact.

export type CoreBillVersion = {
  id: number;
  billId: number;
  effectiveFrom: string;
  amountCents: number;
};

export type CoreYearlyVersion = {
  id: number;
  expenseId: number;
  effectiveFrom: string;
  expectedCents: number;
  frequency: string;
};

export type CoreYearlyBill = {
  id: number;
  frequency: string;
  expectedCents: number;
  dueMonth: number | null;
  backfillBeforeFirstVersion: number;
  keepLightsOn: number;
};

export type CoreYearlyBillNamed = CoreYearlyBill & { name: string };

export type CoreTxn = {
  date: string;
  kind: string;
  sourceType: string;
  amountCents: number;
  yearlyExpenseId: number | null;
};

export type CoreMonthlyBill = { id: number; keepLightsOn: number };

// Latest version whose effectiveFrom is <= month (string compare works
// for YYYY-MM). Ties on effectiveFrom: the later row wins.
export function versionInEffect<V extends CoreBillVersion>(
  versions: V[],
  month: string,
): V | undefined {
  let best: V | undefined;
  for (const v of versions) {
    if (v.effectiveFrom > month) continue;
    if (
      !best ||
      v.effectiveFrom > best.effectiveFrom ||
      (v.effectiveFrom === best.effectiveFrom && v.id > best.id)
    ) {
      best = v;
    }
  }
  return best;
}

export function latestVersion<V extends CoreBillVersion>(
  versions: V[],
): V | undefined {
  let best: V | undefined;
  for (const v of versions) {
    if (
      !best ||
      v.effectiveFrom > best.effectiveFrom ||
      (v.effectiveFrom === best.effectiveFrom && v.id > best.id)
    ) {
      best = v;
    }
  }
  return best;
}

export function earliestYearlyVersion<V extends CoreYearlyVersion>(
  versions: V[],
): V | undefined {
  let earliest: V | undefined;
  for (const v of versions) {
    if (
      !earliest ||
      v.effectiveFrom < earliest.effectiveFrom ||
      (v.effectiveFrom === earliest.effectiveFrom && v.id < earliest.id)
    ) {
      earliest = v;
    }
  }
  return earliest;
}

// Latest yearly-expense version whose effectiveFrom is <= month.
// Return values distinguish the three cases callers must handle:
//  - a version row: that version is in effect for the month
//  - null: versions exist but the month is BEFORE the earliest version
//    and the bill is NOT a legacy/backfill bill — the bill contributes
//    ZERO for that month (it had not started yet)
//  - undefined: the bill has no versions at all — legacy row fallback
//    to the bill row itself applies for every month
// Legacy/backfill bills (flag set only by the 0007 migration for the
// pre-existing bills) fall back to their earliest version for months
// before it, preserving their historic numbers.
export function yearlyVersionInEffect<V extends CoreYearlyVersion>(
  versions: V[],
  month: string,
  backfillBeforeFirstVersion: boolean = false,
): V | undefined | null {
  if (versions.length === 0) return undefined;
  let best: V | undefined;
  let earliest: V | undefined;
  for (const v of versions) {
    if (
      !earliest ||
      v.effectiveFrom < earliest.effectiveFrom ||
      (v.effectiveFrom === earliest.effectiveFrom && v.id < earliest.id)
    ) {
      earliest = v;
    }
    if (v.effectiveFrom > month) continue;
    if (
      !best ||
      v.effectiveFrom > best.effectiveFrom ||
      (v.effectiveFrom === best.effectiveFrom && v.id > best.id)
    ) {
      best = v;
    }
  }
  if (best) return best;
  // Month is before the earliest version.
  return backfillBeforeFirstVersion ? (earliest ?? undefined) : null;
}

export function latestYearlyVersion<V extends CoreYearlyVersion>(
  versions: V[],
): V | undefined {
  let best: V | undefined;
  for (const v of versions) {
    if (
      !best ||
      v.effectiveFrom > best.effectiveFrom ||
      (v.effectiveFrom === best.effectiveFrom && v.id > best.id)
    ) {
      best = v;
    }
  }
  return best;
}

// Payments per year for each frequency: yearly 1, every 6 months 2,
// every 3 months 4, every other month 6. The monthly set-aside is always
// annualised / 12, i.e. per-bill ÷ period for the periodic frequencies
// (per-bill ÷ 3 for quarterly).
export function paymentsPerYear(frequency: string): number {
  if (frequency === "bimonthly") return 6;
  if (frequency === "quarterly") return 4;
  if (frequency === "semiannual") return 2;
  return 1;
}

export function annualCentsFor(y: { expectedCents: number; frequency: string }): number {
  return y.expectedCents * paymentsPerYear(y.frequency);
}

export function annualCentsForValues(expectedCents: number, frequency: string): number {
  return expectedCents * paymentsPerYear(frequency);
}

export function dueMonthsFor(y: { frequency: string; dueMonth: number | null }): number[] {
  if (y.dueMonth == null) return [];
  if (y.frequency === "yearly") return [y.dueMonth];
  const step = 12 / paymentsPerYear(y.frequency);
  const out: number[] = [];
  for (let m = 1; m <= 12; m++) {
    if ((m - y.dueMonth) % step === 0) out.push(m);
  }
  return out;
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function shiftMonth(month: string, delta: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + delta;
  const d = new Date(Date.UTC(y, m, 1));
  const yy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${yy}-${mm}`;
}

export function monthsBetween(a: string, b: string): number {
  const ay = Number(a.slice(0, 4));
  const am = Number(a.slice(5, 7));
  const by = Number(b.slice(0, 4));
  const bm = Number(b.slice(5, 7));
  return (by - ay) * 12 + (bm - am);
}

/* ---------------- Cash-out item day ----------------
   A cash-out item's full date is its month (YYYY-MM) plus a
   day-of-month. The day is display/order only: it never feeds
   any total (the month's items sum is its cash out regardless
   of the days). These helpers are the ONE implementation of
   the day rule — the writers (actions.ts), the restore
   preflight (restoreCore.ts imports the length helper), and
   the accuracy fixtures all go through them, and the client
   mirrors the same rule for its inline form error. */

/* Number of days in the month named by a YYYY-MM key,
   leap-year aware (Feb 2024 → 29, Feb 2026 → 28). */
export function daysInMonthOf(month: string): number {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/* The plain validation message for a (month, day) pair, or null
   when the day is a real day of that month. A non-integer or
   out-of-range day gets the month-specific bound so the message
   the form shows and the message the writer refuses with are
   the same words. */
export function cashOutDayError(month: string, day: number): string | null {
  if (!coreMonthRe.test(month)) return null;
  const max = daysInMonthOf(month);
  if (!Number.isInteger(day) || day < 1 || day > max) {
    return `Enter the day the cash went out — a whole number from 1 to ${max} for that month.`;
  }
  return null;
}

export type CoreCashOutItemOrder = { month: string; day: number; id: number };

/* Cash-out item order: by month, then by day ascending within
   the month, with entry order (id) breaking day ties. */
export function compareCashOutItems(
  a: CoreCashOutItemOrder,
  b: CoreCashOutItemOrder,
): number {
  if (a.month !== b.month) return a.month < b.month ? -1 : 1;
  if (a.day !== b.day) return a.day - b.day;
  return a.id - b.id;
}

export function sortCashOutItems<T extends CoreCashOutItemOrder>(items: T[]): T[] {
  return [...items].sort(compareCashOutItems);
}

const coreMonthRe = /^\d{4}-(0[1-9]|1[0-2])$/;

export type MonthAgg = {
  incurred: number;
  lumps: number;
  lumpsChecking: number;
  cashOut: number;
};

export type EffMonth = {
  incurred: number;
  cashOut: number;
  lumps: number;
  smoothed: number;
  accrual: number;
};

export type ForecastMonth = {
  month: string;
  dueBills: {
    id: number;
    name: string;
    frequency: string;
    expectedCents: number;
    amountCents: number;
  }[];
  totalDueCents: number;
  projectedReserveCents: number;
  shortfallCents: number;
};

export type SpendingCoreInput<
  YV extends CoreYearlyVersion,
  YB extends CoreYearlyBillNamed,
> = {
  txns: CoreTxn[];
  yearly: YB[];
  yearlyVersions: YV[];
  summaries: { month: string; cashOutCents: number }[];
  cashOutItems: { month: string; amountCents: number }[];
  bills?: CoreMonthlyBill[];
  billVersions?: CoreBillVersion[];
  oneOffs?: { month: string; amountCents: number }[];
  openingReserveCents?: number;
  reserveStartSetting?: string | null;
};

// Build the per-month computation over one loaded dataset. Every
// figure the Spending dashboard and the Year Summary publish derives
// from the closures returned here.
export function createSpendingCore<
  YV extends CoreYearlyVersion,
  YB extends CoreYearlyBillNamed,
>(input: SpendingCoreInput<YV, YB>) {
  const { txns, yearly, yearlyVersions, summaries, cashOutItems } = input;
  const bills = input.bills ?? [];
  const billVersions = input.billVersions ?? [];
  const oneOffs = input.oneOffs ?? [];
  const openingReserveCents = input.openingReserveCents ?? 0;
  const settingStart = input.reserveStartSetting ?? null;

  // Smoothed-bill versions grouped per expense.
  const yearlyVersionsByExpense = new Map<number, YV[]>();
  for (const v of yearlyVersions) {
    const arr = yearlyVersionsByExpense.get(v.expenseId) ?? [];
    arr.push(v);
    yearlyVersionsByExpense.set(v.expenseId, arr);
  }
  // Annualised total for a given month uses each bill's version in
  // effect for THAT month. This is the single lookup used for
  // accrual, smoothed, reserve and history, so they all agree:
  // a non-legacy bill before its first version contributes 0;
  // a legacy/backfill bill falls back to its earliest version;
  // a bill with no versions at all falls back to its own row.
  const totalAnnualForMonth = (m: string): number =>
    yearly.reduce((s, y) => {
      const vs = yearlyVersionsByExpense.get(y.id) ?? [];
      const v = yearlyVersionInEffect(vs, m, y.backfillBeforeFirstVersion === 1);
      if (v === null) return s;
      return s + (v ? annualCentsForValues(v.expectedCents, v.frequency) : annualCentsFor(y));
    }, 0);
  // One smoothed bill's monthly set-aside for a month, on the
  // per-bill rounding the bill cards and the Keep the lights on
  // floor use: a bill that has not started contributes 0.
  const billMonthlyAccrual = (y: YB, m: string): number => {
    const vs = yearlyVersionsByExpense.get(y.id) ?? [];
    const vRaw = yearlyVersionInEffect(vs, m, y.backfillBeforeFirstVersion === 1);
    if (vRaw === null) return 0;
    const effExpected = vRaw?.expectedCents ?? y.expectedCents;
    const effFrequency = vRaw?.frequency ?? y.frequency;
    return Math.round(annualCentsForValues(effExpected, effFrequency) / 12);
  };
  // The month's set-aside is the SUM of the per-bill rounded monthly
  // set-asides — the exact figures the bill cards and the lights-on
  // floor show — never the annual total rounded once. The two can
  // differ by a cent (three $100/yr bills: per-bill $8.33 × 3 =
  // $24.99, annual-once $300 ÷ 12 = $25.00), so every surface now
  // uses this one definition.
  const accrualForMonth = (m: string): number =>
    yearly.reduce((s, y) => s + billMonthlyAccrual(y, m), 0);

  const emptyAgg = (): MonthAgg => ({
    incurred: 0,
    lumps: 0,
    lumpsChecking: 0,
    cashOut: 0,
  });
  const byMonth = new Map<string, MonthAgg>();
  for (const t of txns) {
    const m = monthOf(t.date);
    const e = byMonth.get(m) ?? emptyAgg();
    if (t.kind === "spending") {
      e.incurred += t.amountCents;
      if (t.yearlyExpenseId != null) {
        e.lumps += t.amountCents;
        if (t.sourceType === "checking") e.lumpsChecking += t.amountCents;
      }
    }
    if (t.sourceType === "checking") e.cashOut += t.amountCents;
    byMonth.set(m, e);
  }

  const summaryByMonth = new Map(
    summaries.map((s) => [s.month, s.cashOutCents]),
  );

  // Cash-out items grouped per month: their sum is the month's
  // cash out whenever the month has at least one item.
  const itemsByMonth = new Map<string, { total: number; count: number }>();
  for (const it of cashOutItems) {
    const cur = itemsByMonth.get(it.month) ?? { total: 0, count: 0 };
    cur.total += it.amountCents;
    cur.count += 1;
    itemsByMonth.set(it.month, cur);
  }

  // Effective numbers for a month. THE cash-out resolution, used by
  // every figure on every surface: items sum (month has ≥1 item)
  // > entered cash-out total > transactions. Itemized and summary
  // months both use the base as-is — their transactions are not
  // added in, and only smoothed bills that left checking are
  // subtracted in the smoothed formula. The accrual is per-month:
  // the version in effect for that month.
  const eff = (m: string): EffMonth => {
    const e = byMonth.get(m) ?? emptyAgg();
    const acc = accrualForMonth(m);
    const items = itemsByMonth.get(m);
    if (items) {
      return {
        incurred: items.total,
        cashOut: items.total,
        lumps: e.lumpsChecking,
        smoothed: items.total - e.lumpsChecking + acc,
        accrual: acc,
      };
    }
    const entered = summaryByMonth.get(m);
    if (entered != null) {
      return {
        incurred: entered,
        cashOut: entered,
        lumps: e.lumpsChecking,
        smoothed: entered - e.lumpsChecking + acc,
        accrual: acc,
      };
    }
    return {
      incurred: e.incurred,
      cashOut: e.cashOut,
      lumps: e.lumps,
      smoothed: e.incurred - e.lumps + acc,
      accrual: acc,
    };
  };

  // Recorded smoothed-bill payments in one month: the spending
  // transactions linked to a yearly/periodic bill — the same rows
  // the dashboard counts as "Yearly & periodic expenses paid-out".
  const recordedPaymentsForMonth = (
    m: string,
  ): { totalCents: number; count: number } => {
    let totalCents = 0;
    let count = 0;
    for (const t of txns) {
      if (t.kind !== "spending" || t.yearlyExpenseId == null) continue;
      if (monthOf(t.date) !== m) continue;
      totalCents += t.amountCents;
      count += 1;
    }
    return { totalCents, count };
  };

  // Recorded smoothed-bill payments that fall in `year` AFTER
  // `afterMonth` (the last month a year view's totals include).
  // A payment always makes its own month a data month, so within
  // the totals' window such payments are always included; the only
  // ones left out sit past the window's end (for the current year,
  // the window ends at the current month, so a payment already
  // recorded for a later month is excluded). The Year Summary
  // names these in a footnote instead of dropping them silently.
  const recordedPaymentsAfter = (
    year: number,
    afterMonth: string,
  ): { month: string; monthNum: number; totalCents: number; count: number }[] => {
    const out: { month: string; monthNum: number; totalCents: number; count: number }[] = [];
    for (let n = 1; n <= 12; n++) {
      const m = `${year}-${String(n).padStart(2, "0")}`;
      if (m <= afterMonth) continue;
      const p = recordedPaymentsForMonth(m);
      if (p.count > 0) out.push({ month: m, monthNum: n, totalCents: p.totalCents, count: p.count });
    }
    return out;
  };

  const monthAgg = (m: string): MonthAgg => byMonth.get(m) ?? emptyAgg();

  const txnEarliest =
    txns.length > 0 ? monthOf(txns[0]?.date ?? "") : null;
  const sumEarliest =
    summaries.length > 0 ? (summaries[0]?.month ?? null) : null;
  const itemEarliest =
    cashOutItems.length > 0 ? (cashOutItems[0]?.month ?? null) : null;
  const earliest = [txnEarliest, sumEarliest, itemEarliest]
    .filter((v): v is string => v != null && v !== "")
    .sort()[0] ?? null;
  const reserveStartMonth =
    settingStart && coreMonthRe.test(settingStart) ? settingStart : earliest;

  // Reserve through a month: opening reserve plus, from the reserve
  // start month, each month's accrual minus its effective lumps.
  // Summary months count only the lumps that left checking, matching
  // the smoothed formula for those months.
  const reserveThrough = (month: string): number => {
    let reserveCents = openingReserveCents;
    if (reserveStartMonth && reserveStartMonth <= month) {
      const n = monthsBetween(reserveStartMonth, month) + 1;
      for (let i = 0; i < n; i++) {
        const m = shiftMonth(reserveStartMonth, i);
        reserveCents += accrualForMonth(m) - eff(m).lumps;
      }
    }
    return reserveCents;
  };

  const oneOffsByMonth = new Map<string, number>();
  for (const o of oneOffs) {
    oneOffsByMonth.set(o.month, (oneOffsByMonth.get(o.month) ?? 0) + o.amountCents);
  }
  const oneOffTotalForMonth = (m: string): number => oneOffsByMonth.get(m) ?? 0;

  // ---- Forecast: the viewed month and the next 2 ----
  // Per bill, per month: use recorded actual if one exists for that
  // bill that month, otherwise the expected per-payment amount when
  // the bill is due that month (from its due-month pattern and the
  // version in effect for that month). Bills with no due month are
  // excluded from the forecast.
  const actualByBillMonth = new Map<string, { total: number; count: number }>();
  for (const t of txns) {
    if (t.kind !== "spending" || t.yearlyExpenseId == null) continue;
    const key = `${t.yearlyExpenseId}:${monthOf(t.date)}`;
    const cur = actualByBillMonth.get(key) ?? { total: 0, count: 0 };
    cur.total += t.amountCents;
    cur.count += 1;
    actualByBillMonth.set(key, cur);
  }
  const dueBillsForMonth = (m: string) => {
    const out: { id: number; name: string; frequency: string; expectedCents: number; lumpCents: number }[] = [];
    for (const y of yearly) {
      if (y.dueMonth == null) continue;
      const vs = yearlyVersionsByExpense.get(y.id) ?? [];
      const vRaw = yearlyVersionInEffect(vs, m, y.backfillBeforeFirstVersion === 1);
      if (vRaw === null) continue;
      const effFreq = vRaw?.frequency ?? y.frequency;
      const effExpected = vRaw?.expectedCents ?? y.expectedCents;
      const dues = dueMonthsFor({ frequency: effFreq, dueMonth: y.dueMonth });
      const mNum = Number(m.slice(5, 7));
      if (!dues.includes(mNum)) continue;
      const actual = actualByBillMonth.get(`${y.id}:${m}`);
      const lumpCents = actual && actual.count > 0 ? actual.total : effExpected;
      out.push({ id: y.id, name: y.name, frequency: effFreq, expectedCents: effExpected, lumpCents });
    }
    return out;
  };
  const projectedLumpsForMonth = (m: string): number =>
    dueBillsForMonth(m).reduce((s, b) => s + b.lumpCents, 0);
  // Recorded payments in month m for bills NOT due that month
  // (a late or early payment). The due-based projection above
  // never sees them — it only looks at bills whose due pattern
  // lands in m — but the money still leaves the reserve in m,
  // so a future month's projection must subtract them there.
  const recordedNonDueLumpsForMonth = (m: string): number => {
    const dueIds = new Set(dueBillsForMonth(m).map((b) => b.id));
    let sum = 0;
    for (const [key, v] of actualByBillMonth) {
      const sep = key.lastIndexOf(":");
      if (key.slice(sep + 1) !== m) continue;
      if (dueIds.has(Number(key.slice(0, sep)))) continue;
      sum += v.total;
    }
    return sum;
  };

  const forecastFor = (month: string): ForecastMonth[] => {
    const forecastStart = reserveStartMonth ?? month;
    const forecast: ForecastMonth[] = [];
    for (let offset = 0; offset < 3; offset++) {
      const fm = shiftMonth(month, offset);
      const due = dueBillsForMonth(fm);
      // Projected reserve through fm: opening + accruals from the
      // reserve start through fm − lumps over the same span, on ONE
      // basis per month so no recorded payment is ever counted
      // twice or dropped:
      //  - Months at or before the viewed month use the reserve's
      //    own actual basis, eff(mm).lumps — exactly the movement
      //    reserveThrough accumulates.
      //  - Months after the viewed month use the due-based
      //    projection (recorded actual in place of expected for a
      //    due bill) PLUS any payment already recorded in that
      //    month for a bill not due then, which the due projection
      //    alone would drop entirely.
      // For fm === the viewed month this reduces to reserveThrough
      // exactly, so the first forecast column always agrees with
      // the calculated reserve.
      let proj = openingReserveCents;
      if (forecastStart <= fm) {
        const n = monthsBetween(forecastStart, fm) + 1;
        for (let i = 0; i < n; i++) {
          const mm = shiftMonth(forecastStart, i);
          if (mm <= month) {
            proj += accrualForMonth(mm) - eff(mm).lumps;
          } else {
            proj +=
              accrualForMonth(mm) -
              projectedLumpsForMonth(mm) -
              recordedNonDueLumpsForMonth(mm);
          }
        }
      }
      forecast.push({
        month: fm,
        dueBills: due.map(({ lumpCents, ...b }) => ({ ...b, amountCents: lumpCents })),
        totalDueCents: due.reduce((s, b) => s + b.lumpCents, 0),
        projectedReserveCents: proj,
        shortfallCents: proj < 0 ? -proj : 0,
      });
    }
    return forecast;
  };

  // Monthly-bill versions grouped per bill.
  const versionsByBill = new Map<number, CoreBillVersion[]>();
  for (const v of billVersions) {
    const arr = versionsByBill.get(v.billId) ?? [];
    arr.push(v);
    versionsByBill.set(v.billId, arr);
  }
  const monthlyTotalForMonth = (m: string): number =>
    bills.reduce(
      (s, b) =>
        s + (versionInEffect(versionsByBill.get(b.id) ?? [], m)?.amountCents ?? 0),
      0,
    );
  const keepLightsOnForMonth = (m: string): number => {
    const monthlyPart = bills.reduce(
      (s, b) =>
        s +
        (b.keepLightsOn === 1
          ? (versionInEffect(versionsByBill.get(b.id) ?? [], m)?.amountCents ?? 0)
          : 0),
      0,
    );
    const smoothedPart = yearly.reduce(
      (s, y) => s + (y.keepLightsOn === 1 ? billMonthlyAccrual(y, m) : 0),
      0,
    );
    return monthlyPart + smoothedPart;
  };

  // Whether a month carries any data at all (the Year Summary's
  // month-selection rule).
  const monthHasData = (m: string): boolean => {
    if (byMonth.has(m)) return true;
    if (summaryByMonth.has(m)) return true;
    if (itemsByMonth.has(m)) return true;
    if (oneOffsByMonth.has(m)) return true;
    for (const b of bills) {
      if (versionInEffect(versionsByBill.get(b.id) ?? [], m)) return true;
    }
    for (const y of yearly) {
      const v = yearlyVersionInEffect(yearlyVersionsByExpense.get(y.id) ?? [], m, false);
      if (v !== null) return true;
    }
    return false;
  };

  return {
    yearlyVersionsByExpense,
    versionsByBill,
    byMonth,
    summaryByMonth,
    itemsByMonth,
    totalAnnualForMonth,
    accrualForMonth,
    eff,
    monthAgg,
    earliest,
    reserveStartMonth,
    reserveThrough,
    oneOffTotalForMonth,
    dueBillsForMonth,
    forecastFor,
    monthlyTotalForMonth,
    billMonthlyAccrual,
    keepLightsOnForMonth,
    monthHasData,
    recordedPaymentsForMonth,
    recordedPaymentsAfter,
  };
}

export type SpendingCore = ReturnType<
  typeof createSpendingCore<CoreYearlyVersion, CoreYearlyBillNamed>
>;

/* ---------------- Year Summary floor month (F14) ----------------
   Which month's Keep-the-lights-on floor a Year Summary reports
   for the REQUESTED year (API follow-on 3, finding F14 — the
   handler used to price every year's floor at the CURRENT month,
   so a past year inherited today's bill versions). The rule:
   the requested year IS the current year → the current month
   (byte-identical to the old behaviour for the current year);
   otherwise → the last month included in that year's totals, or
   December of the requested year when the year has no included
   months. The floor MATH (keepLightsOnForMonth above,
   version-aware) is unchanged — only the month it is priced at
   is chosen here, so the fixtures pin this choice directly. */
export function yearSummaryFloorMonth(input: {
  year: number;
  currentYear: number;
  currentMonth: string;
  lastIncludedMonth: string | null;
}): string {
  if (input.year === input.currentYear) return input.currentMonth;
  return input.lastIncludedMonth ?? `${input.year}-12`;
}

/* ---------------- updateMonthlyBill update set (F18) ----------------
   The write set for one updateMonthlyBill call (API follow-on 3,
   finding F18): exactly the fields the caller actually sent. The
   update request (updateMonthlyBillIn in apiContractCore) gives
   notes / category / keepLightsOn NO defaults, so an absent field
   arrives here as undefined and is ABSENT from the set — the
   stored value is preserved — while an explicitly sent
   notes: null IS in the set as null and clears the notes. Values
   are in stored plain form (keepLightsOn as the 0/1 flag the
   table stores); the handler encrypts the text fields it finds
   here. A full payload (what the live bill form always sends)
   sets all five fields exactly as the old unconditional write
   did. */
export type MonthlyBillUpdateArgs = {
  name?: string;
  paidBy?: string;
  notes?: string | null;
  category?: string;
  keepLightsOn?: boolean;
};

export type MonthlyBillUpdateSet = {
  name?: string;
  paidBy?: string;
  notes?: string | null;
  category?: string;
  keepLightsOn?: number;
};

/* ---------------- updateMonthlyBill outcome (F10) ----------------
   The row-count branch updateMonthlyBill takes after its
   update (R4-3, finding F10), as a pure decision the fixture
   harness can pin (the handler itself cannot be imported by
   the harness). A delete that won the race between the F22
   existence preflight and the update is indistinguishable
   from a delete that happened first, so both take the same
   not-found shape (the preflight's exact reason string,
   deliberately); the sticky paid-from default writes only on
   "updated". */
export function monthlyBillUpdateOutcome(
  updatedRowCount: number,
): "updated" | "not-found" {
  return updatedRowCount >= 1 ? "updated" : "not-found";
}

export function monthlyBillUpdateSet(
  args: MonthlyBillUpdateArgs,
): MonthlyBillUpdateSet {
  const set: MonthlyBillUpdateSet = {};
  if (args.name !== undefined) set.name = args.name;
  if (args.paidBy !== undefined) set.paidBy = args.paidBy;
  if (args.notes !== undefined) set.notes = args.notes;
  if (args.category !== undefined) set.category = args.category;
  if (args.keepLightsOn !== undefined) {
    set.keepLightsOn = args.keepLightsOn ? 1 : 0;
  }
  return set;
}

