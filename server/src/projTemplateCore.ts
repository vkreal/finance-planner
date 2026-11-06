/* ---------------- Projection template storage mapping ----------------
   The Playground projection template in the store's shape, and
   back. The template is a full PlaygroundYearInputs captured
   from the dials (buildPgInputs in the Playground view); the
   store carries it in the UI-state blob under
   playgroundProjTemplateState (server/src/rothUiStateCore.ts),
   whose parse reads a blob written before a field existed at
   that field's no-fact value, so an older stored template
   still loads.

   P-S8 (parity audit, SHOULD — settled STAND): the stored
   shape once carried only the base dials + itemized +
   education + inflation + the beneficiary facts, so the
   December-era facts buildPgInputs always supplies — the
   ACA filing-settlement facts (aptcTaken,
   acaCoverageReduction, acaEnrollmentPremiumAnnual), the
   health premiums (healthPremiumAcaAnnual,
   healthPremiumMedicarePerPerson), the loss carry-ins
   (federal and Washington-attributable), rmdAlreadyReceived,
   dependentMagiForAca, the cash / Roth funding draws, the
   reinvested-yield flag, the annual spending, and the gain-
   harvest pair — were dropped on save and absent on reload,
   and the same projection repriced differently after a
   reload, silently. The mapping now carries EVERY field of
   PlaygroundYearInputs the walk reads, and the template-is-
   current check in the view compares through this same full
   mapping on both sides, so it can detect any future loss
   instead of comparing through the lossy shape. The mapping
   lives here — not in the view — so the accuracy fixtures
   pin the exact production functions the view calls (the
   tax suite's tax-engines-playground-proj-template-reload-ps8
   fixture round-trips a template carrying every fact
   through these functions, the stored parse, and the
   projection walk).

   The two shapes differ only in the optional-field spellings
   buildPgInputs leaves open: a fact the engine input spells
   "absent" (undefined) is stored as its explicit no-fact
   value (null for the nullable facts, 0 for the carry-ins
   and funding draws, false for the reinvested-yield flag) —
   each of which the pricer reads exactly as the absent
   spelling, so the round-trip reprices bit-identically. */
import type { PlaygroundYearInputs } from "./rothOptimizer";
import type { PlaygroundProjTemplateState } from "./rothUiStateCore";

export const projTemplateToStored = (
  inp: PlaygroundYearInputs,
): PlaygroundProjTemplateState => ({
  taxYear: inp.taxYear,
  filingStatus: inp.filingStatus,
  agePrimary: inp.agePrimary,
  ageSpouse: inp.ageSpouse,
  onMedicarePrimary: inp.onMedicarePrimary,
  onMedicareSpouse: inp.onMedicareSpouse,
  interest: inp.interest,
  ordinaryDividends: inp.ordinaryDividends,
  otherOrdinary: inp.otherOrdinary,
  taxExemptInterest: inp.taxExemptInterest,
  ssPrimary: inp.ssPrimary,
  ssSpouse: inp.ssSpouse,
  conversion: inp.conversion,
  // The draw half of the money-out split (R3-M1): carried
  // so a template captured from a year with a draw typed
  // keeps the split the dials priced with.
  spendingDraw: inp.spendingDraw ?? 0,
  stockSold: inp.stockSold,
  stockBasis: inp.stockBasis,
  qualifiedDividends: inp.qualifiedDividends,
  pretaxBalance: inp.pretaxBalance,
  pretaxBalanceSpouse: inp.pretaxBalanceSpouse ?? null,
  spouseSoleBeneficiary: inp.spouseSoleBeneficiary,
  // The reciprocal beneficiary fact (N-1): carried so a
  // template captured from a prefilled year keeps the
  // spouse's RMD table selection the dials priced with.
  primarySoleBeneficiaryOfSpouse:
    inp.primarySoleBeneficiaryOfSpouse ?? null,
  acaHouseholdSize: inp.acaHouseholdSize,
  acaBenchmarkAnnual: inp.acaBenchmarkAnnual,
  // The ACA filing-settlement facts (P-S8): the advance
  // credit taken, the coverage-month reduction, and the
  // enrollment premium the settlement caps the final
  // credit at. buildPgInputs supplies the first two as
  // numbers always (blank reads $0 — a settlement with
  // nothing taken) and the third as the marketplace
  // premium dial or null; the stored shape keeps the
  // nullable spelling so a template written before these
  // facts were carried parses them null — no settlement
  // priced — exactly as the lossy restore priced it.
  aptcTaken: inp.aptcTaken ?? null,
  acaCoverageReduction: inp.acaCoverageReduction ?? null,
  acaEnrollmentPremiumAnnual: inp.acaEnrollmentPremiumAnnual ?? null,
  // The health premium facts (P-S8): the marketplace gross
  // and the per-person Medicare base the premium readout
  // and the after-health cash left price from, each null
  // when no premium was entered.
  healthPremiumAcaAnnual: inp.healthPremiumAcaAnnual ?? null,
  healthPremiumMedicarePerPerson:
    inp.healthPremiumMedicarePerPerson ?? null,
  // The loss carry-ins (P-S8): the federal pair and each
  // character's Washington-attributable portion — the
  // entering ledger the projection's first walked year
  // nets its gains against (the walk chains the carry-out
  // from there). $0 is the pricer's no-carry-in reading,
  // so the number spelling is lossless.
  capitalLossCarryInSt: inp.capitalLossCarryInSt ?? 0,
  capitalLossCarryInLt: inp.capitalLossCarryInLt ?? 0,
  capitalLossCarryInStWa: inp.capitalLossCarryInStWa ?? 0,
  capitalLossCarryInLtWa: inp.capitalLossCarryInLtWa ?? 0,
  // The RMD already received and the dependent's MAGI
  // (P-S8): nullable engine facts (null = none supplied),
  // stored in the same spelling.
  rmdAlreadyReceived: inp.rmdAlreadyReceived ?? null,
  dependentMagiForAca: inp.dependentMagiForAca ?? null,
  // The cash / Roth funding draws (P-S8): first-year
  // funding facts the walk prices whole in its first year
  // (P-S4(c)). $0 is the pricer's no-draw reading.
  cashDraw: inp.cashDraw ?? 0,
  rothDraw: inp.rothDraw ?? 0,
  // The reinvested-yield flag (P-S8): the loaded-year fact
  // that keeps the year's yield out of cash in. False is
  // the pricer's absent reading.
  yieldReinvested: inp.yieldReinvested ?? false,
  // The annual spending (P-S8): the figure the "enough
  // for the year" verdict runs against in every projected
  // year; null when the template year carried none (no
  // verdict), exactly the pricer's absent reading.
  annualSpending: inp.annualSpending ?? null,
  // The gain-harvest pair (P-S8): the pool and its blended
  // basis the pricer sizes each projected year's harvest
  // from; either null = no harvest priced, the pricer's
  // absent reading.
  harvestPoolAmount: inp.harvestPoolAmount ?? null,
  harvestPoolBasisPct: inp.harvestPoolBasisPct ?? null,
  stateRatePct: inp.stateRatePct,
  residenceState: inp.residenceState === "WA" ? "WA" : "other",
  itemizedMortgageInterest: inp.itemizedMortgageInterest ?? 0,
  itemizedSaltPaid: inp.itemizedSaltPaid ?? 0,
  itemizedCharitable: inp.itemizedCharitable ?? 0,
  itemizedOther: inp.itemizedOther ?? 0,
  educationStudents: inp.educationStudents ?? null,
  inflationPct: inp.inflationPct ?? null,
});

export const projTemplateFromStored = (
  s: PlaygroundProjTemplateState,
): PlaygroundYearInputs => ({ ...s });
