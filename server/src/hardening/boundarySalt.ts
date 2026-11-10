/* ---------------- Boundary SALT ----------------
   Part 2 of the hardening block (boundary-case fixture
   pack). Pins the §164(b)(7) SALT cap and its phase-down
   as the schedule prices it by calendar year: the cap at
   ±1¢, the phase-down start and slope, the $10,000
   floor (and the AGI where the floor first binds), the
   2027–2029 schedule escalation, and the 2030 reversion
   to a flat $10,000 with no phase-down. Every expected
   value is hand-derived from the schedule entries in
   taxLaw.ts, never from the engine's own outputs — and
   every pin is also priced by the independent
   implementation, which must agree with the hand value
   too, so each pin is a three-way agreement: statute,
   engine, oracle. A pin that fails is a finding, never
   a reason to loosen the pin.

   capApplied = max(floor, cap − 0.30 × max(0, AGI −
   start)), priced in the entry's own year (deflation
   factor 1), so the floor first binds at AGI = start +
   (cap − floor) / 0.30. The cap does not depend on
   filing status; the cross-status pins below assert
   exactly that. */

import { deflationFactor, priceYear } from "../taxEngine";
import type { PriceYearInput, PriceYearResult } from "../taxEngine";
import { saltScheduleForYear } from "../taxLaw";
import type { FilingStatus } from "../taxLaw";
import { priceYearIndependent } from "./secondImplementation";
import type { IndependentYearInput } from "./secondImplementation";
import type {
  HardeningCheckModule,
  HardeningCheckResult,
  HardeningTeethResult,
} from "./types";

function roundCent(n: number): number {
  return Math.round(n * 100) / 100;
}

// One pin: a priced year plus the hand-derived SALT
// figures it must carry. `itemizedSaltCap` is the
// applied cap (before the paid amount limits it);
// `itemizedSaltAllowed` is min(paid, cap).
type SaltPin = {
  id: string;
  input: PriceYearInput;
  expect: {
    itemizedSaltCap: number;
    itemizedSaltAllowed: number;
  };
};

function base(
  year: number,
  fs: FilingStatus,
  over: Partial<PriceYearInput> = {},
): PriceYearInput {
  return {
    calendarYear: year,
    filingStatus: fs,
    agePrimary: 60,
    ageSpouse: fs === "mfj" ? 58 : null,
    otherOrdinary: 0,
    rmd: 0,
    conversion: 0,
    extraPreTaxDraw: 0,
    ssBenefits: 0,
    taxExemptInterest: 0,
    ltcg: 0,
    inflationPct: 2.5,
    stateRatePct: 0,
    residenceState: "other",
    ...over,
  };
}

// Hand derivation of the applied SALT cap for a year and
// AGI, from the schedule entry the year prices under.
function expectedSaltCap(year: number, agi: number): number {
  const entry = saltScheduleForYear(year);
  const defl = deflationFactor(year, entry.entryYear, 2.5);
  return roundCent(
    Math.max(
      entry.capFloor * defl,
      entry.cap * defl -
        (entry.phaseOutRatePct / 100) *
          Math.max(0, agi - entry.phaseOutStart * defl),
    ),
  );
}

// The AGI where the floor first binds, in the entry's own
// year: cap − 0.30 × (AGI − start) = floor.
function floorAgi(year: number): number {
  const entry = saltScheduleForYear(year);
  return roundCent(
    entry.phaseOutStart + (entry.cap - entry.capFloor) / 0.3,
  );
}

function saltPin(
  id: string,
  year: number,
  fs: FilingStatus,
  agi: number,
  paid: number,
): SaltPin {
  const cap = expectedSaltCap(year, agi);
  return {
    id,
    input: base(year, fs, {
      otherOrdinary: agi,
      itemizedSaltPaid: paid,
    }),
    expect: {
      itemizedSaltCap: cap,
      itemizedSaltAllowed: Math.min(paid, cap),
    },
  };
}

// ---------- Fast pins (the brief's probe-verified pins) ----------

const FAST_PINS: SaltPin[] = [
  // 2026 cap trio at AGI $100,000.
  saltPin("salt-2026-at-cap", 2026, "mfj", 100000, 40400),
  saltPin("salt-2026-over-cap", 2026, "mfj", 100000, 40400.01),
  saltPin("salt-2026-under-cap", 2026, "mfj", 100000, 40399.99),
  // 2026 phase-down, $60,000 paid.
  saltPin("salt-2026-phase-start", 2026, "mfj", 505000, 60000),
  saltPin("salt-2026-phase-plus-100", 2026, "mfj", 505100, 60000),
  saltPin("salt-2026-phase-plus-100k", 2026, "mfj", 605000, 60000),
  // 2026 floor: binds at AGI $606,333.33 and holds above.
  saltPin("salt-2026-floor", 2026, "mfj", 606333.33, 60000),
  saltPin("salt-2026-floor-plus-1", 2026, "mfj", 606333.34, 60000),
  saltPin("salt-2026-floor-holds", 2026, "mfj", 706333.33, 60000),
  // 2025: $40,000 cap, $500,000 start, floor at $600,000.
  saltPin("salt-2025-phase-start", 2025, "mfj", 500000, 60000),
  saltPin("salt-2025-floor", 2025, "mfj", 600000, 60000),
  // Schedule years via priceYear, $60,000 paid, AGI $100,000.
  saltPin("salt-2027-cap", 2027, "mfj", 100000, 60000),
  saltPin("salt-2028-cap", 2028, "mfj", 100000, 60000),
  saltPin("salt-2029-cap", 2029, "mfj", 100000, 60000),
  // 2030 reversion: flat $10,000, no phase-down.
  saltPin("salt-2030-reversion", 2030, "mfj", 100000, 60000),
  saltPin("salt-2030-high-agi", 2030, "mfj", 1000000, 60000),
];

// The schedule table itself, read directly (not through
// priceYear): the cap and phase-out rate per year.
const SCHEDULE_CHECKS: { id: string; actual: number; expected: number }[] =
  [
    { id: "salt-schedule-2025-cap", actual: saltScheduleForYear(2025).cap, expected: 40000 },
    { id: "salt-schedule-2026-cap", actual: saltScheduleForYear(2026).cap, expected: 40400 },
    { id: "salt-schedule-2027-cap", actual: saltScheduleForYear(2027).cap, expected: 40804 },
    { id: "salt-schedule-2028-cap", actual: saltScheduleForYear(2028).cap, expected: 41212.04 },
    { id: "salt-schedule-2029-cap", actual: saltScheduleForYear(2029).cap, expected: 41624.16 },
    { id: "salt-schedule-2030-cap", actual: saltScheduleForYear(2030).cap, expected: 10000 },
    {
      id: "salt-schedule-2030-rate",
      actual: saltScheduleForYear(2030).phaseOutRatePct,
      expected: 0,
    },
    {
      id: "salt-schedule-2027-start",
      actual: saltScheduleForYear(2027).phaseOutStart,
      expected: 510050,
    },
    {
      id: "salt-schedule-2028-start",
      actual: saltScheduleForYear(2028).phaseOutStart,
      expected: 515150.5,
    },
    {
      id: "salt-schedule-2029-start",
      actual: saltScheduleForYear(2029).phaseOutStart,
      expected: 520302.01,
    },
  ];

// ---------- Full sweeps ----------

function buildFullPins(): SaltPin[] {
  const pins: SaltPin[] = [];
  // Every schedule year 2025–2029: AGI stepped around
  // the phase-down start, the slope, and the floor
  // (first binding AGI, one cent past it, $100,000 past
  // it), $60,000 paid.
  for (let year = 2025; year <= 2029; year++) {
    const entry = saltScheduleForYear(year);
    const floor = floorAgi(year);
    for (const [label, agi] of [
      ["start-minus-1", entry.phaseOutStart - 1],
      ["start", entry.phaseOutStart],
      ["start-plus-1", entry.phaseOutStart + 1],
      ["start-plus-100", entry.phaseOutStart + 100],
      ["start-plus-100k", entry.phaseOutStart + 100000],
      ["floor", floor],
      ["floor-plus-1", roundCent(floor + 0.01)],
      ["floor-plus-100k", roundCent(floor + 100000)],
    ] as const) {
      pins.push(
        saltPin(`salt-full-${year}-${label}`, year, "mfj", agi, 60000),
      );
    }
    // Below-cap paid amount: the allowed figure is the
    // paid amount, the cap is the schedule cap.
    pins.push(
      saltPin(
        `salt-full-${year}-below-cap`,
        year,
        "mfj",
        100000,
        entry.cap - 100,
      ),
    );
  }
  // 2030: flat $10,000 at every AGI, no phase-down.
  for (const agi of [100000, 500000, 1000000, 2000000]) {
    pins.push(saltPin(`salt-full-2030-agi${agi}`, 2030, "mfj", agi, 60000));
  }
  pins.push(saltPin("salt-full-2030-below-cap", 2030, "mfj", 100000, 9900));
  // The cap does not depend on filing status.
  pins.push(saltPin("salt-full-2026-single", 2026, "single", 100000, 60000));
  pins.push(saltPin("salt-full-2026-hoh", 2026, "hoh", 100000, 60000));
  pins.push(saltPin("salt-full-2028-single", 2028, "single", 100000, 60000));
  pins.push(saltPin("salt-full-2028-hoh", 2028, "hoh", 100000, 60000));
  return pins;
}

// ---------- Pin runner ----------

function toIndependentInput(input: PriceYearInput): IndependentYearInput {
  return {
    calendarYear: input.calendarYear,
    filingStatus: input.filingStatus,
    agePrimary: input.agePrimary,
    ageSpouse: input.ageSpouse,
    otherOrdinary: input.otherOrdinary,
    rmd: input.rmd,
    conversion: input.conversion,
    extraPreTaxDraw: input.extraPreTaxDraw,
    ssBenefits: input.ssBenefits,
    taxExemptInterest: input.taxExemptInterest,
    ltcg: input.ltcg,
    interestIncome: input.interestIncome ?? 0,
    ordinaryDividends: input.ordinaryDividends ?? 0,
    qualifiedDividends: input.qualifiedDividends ?? 0,
    capitalLossAllowance: input.capitalLossAllowance ?? 0,
    inflationPct: input.inflationPct,
    stateRatePct: input.stateRatePct,
    residenceState: input.residenceState ?? "other",
    itemizedMortgageInterest: input.itemizedMortgageInterest,
    itemizedSaltPaid: input.itemizedSaltPaid,
    itemizedCharitable: input.itemizedCharitable,
    itemizedOther: input.itemizedOther,
  };
}

function checkPins(pins: SaltPin[]): {
  failures: string[];
  pinsFailed: number;
  fieldsChecked: number;
  engineMismatches: number;
  independentMismatches: number;
} {
  const failures: string[] = [];
  let pinsFailed = 0;
  let fieldsChecked = 0;
  let engineMismatches = 0;
  let independentMismatches = 0;
  for (const pin of pins) {
    const engine: PriceYearResult = priceYear(pin.input);
    const mine = priceYearIndependent(toIndependentInput(pin.input));
    let pinFailed = false;
    for (const field of [
      "itemizedSaltCap",
      "itemizedSaltAllowed",
    ] as const) {
      const expected = pin.expect[field];
      fieldsChecked += 2;
      const eActual = engine[field];
      if (Math.round(eActual * 100) !== Math.round(expected * 100)) {
        engineMismatches++;
        pinFailed = true;
        failures.push(
          `${pin.id} engine ${field}: ${eActual} != hand-derived ${expected}`,
        );
      }
      const mActual = mine[field];
      if (Math.round(mActual * 100) !== Math.round(expected * 100)) {
        independentMismatches++;
        pinFailed = true;
        failures.push(
          `${pin.id} independent ${field}: ${mActual} != hand-derived ${expected}`,
        );
      }
    }
    if (pinFailed) pinsFailed++;
  }
  return {
    failures: failures.slice(0, 25),
    pinsFailed,
    fieldsChecked,
    engineMismatches,
    independentMismatches,
  };
}

function checkScheduleTable(): string[] {
  const failures: string[] = [];
  for (const check of SCHEDULE_CHECKS) {
    if (
      Math.round(check.actual * 100) !== Math.round(check.expected * 100)
    ) {
      failures.push(
        `${check.id}: schedule table ${check.actual} != hand-derived ${check.expected}`,
      );
    }
  }
  return failures;
}

function runSaltInner(full: boolean): HardeningCheckResult {
  const pins = full ? [...FAST_PINS, ...buildFullPins()] : FAST_PINS;
  const checked = checkPins(pins);
  const tableFailures = checkScheduleTable();
  const failures = [...checked.failures, ...tableFailures].slice(0, 25);
  const pass = checked.pinsFailed === 0 && tableFailures.length === 0;
  const detail =
    `Boundary SALT over ${pins.length} pins ` +
    `(${full ? "fast pins plus the full sweeps" : "fast pins only"}) and ` +
    `${SCHEDULE_CHECKS.length} schedule-table checks: ` +
    `${checked.fieldsChecked} field checks (engine and independent ` +
    `implementation against hand-derived values), ` +
    `${checked.engineMismatches} engine mismatches, ` +
    `${checked.independentMismatches} independent mismatches, ` +
    `${tableFailures.length} schedule-table mismatches, ` +
    `${checked.pinsFailed} pins failed. ` +
    `Coverage: cap ±1¢, phase-down start/slope/floor every schedule ` +
    `year 2025–2029, 2030 reversion, status-independence` +
    `${full ? "" : " (full sweeps run in runFull)"}.`;
  return {
    id: "boundary-salt",
    name: "Boundary SALT: cap, phase-down, floor, schedule 2027–2029, 2030 reversion",
    pass,
    detail,
    failures,
    counts: {
      pins: pins.length,
      fieldsChecked: checked.fieldsChecked,
      engineMismatches: checked.engineMismatches,
      independentMismatches: checked.independentMismatches,
      scheduleTableChecks: SCHEDULE_CHECKS.length,
      scheduleTableMismatches: tableFailures.length,
      violations: checked.pinsFailed + tableFailures.length,
    },
  };
}

function runSaltFast(): HardeningCheckResult {
  return runSaltInner(false);
}

function runSaltFull(): HardeningCheckResult {
  return runSaltInner(true);
}

// Teeth: corrupt the 2026 at-cap pin's hand value by 1
// cent ($40,400 → $40,400.01). The clean run must pass
// first; the corrupted run must fail exactly that one pin.
function runSaltTeeth(): HardeningTeethResult {
  const clean = runSaltFast();
  if (!clean.pass) {
    return {
      corruptedCaseId: "boundary-salt:clean-run-failed",
      failedCount: clean.counts.violations ?? 0,
      pass: false,
    };
  }
  const pin = FAST_PINS.find((p) => p.id === "salt-2026-at-cap")!;
  const corrupted: SaltPin = {
    ...pin,
    expect: { ...pin.expect, itemizedSaltCap: 40400.01 },
  };
  const checked = checkPins([corrupted]);
  const pass = checked.pinsFailed === 1;
  return {
    corruptedCaseId: "boundary-salt:salt-2026-at-cap:cap+0.01",
    failedCount: checked.pinsFailed,
    pass,
  };
}

export const boundarySaltCheck: HardeningCheckModule = {
  id: "boundary-salt",
  name: "Boundary SALT: cap, phase-down, floor, schedule 2027–2029, 2030 reversion",
  runFast: runSaltFast,
  runFull: runSaltFull,
  runTeeth: runSaltTeeth,
};
