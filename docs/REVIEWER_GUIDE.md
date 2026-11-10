# Finance Planner — Reviewer Guide

*For an outside auditor reviewing the pricing engine. Read this before
trusting — or doubting — any number the planner produces.*

- **Status:** written 2026-11-10, at contract version 163, with the
  hardening registry at 26 checks. The engine changes; re-check the
  counts and commands in §6 against the tree before citing them.
- **Companion documents:** [HANDOVER.md](../HANDOVER.md) is the
  operating model and standing decisions for a household's plan — read
  it for *how a plan is used*. This guide is about *how the numbers
  are computed and how to check them*. The [README](../README.md)
  describes the five views. The version log,
  [DATA-PLAN.md](../DATA-PLAN.md), is the build-by-build record and is
  figure-free.
- **Figure policy:** no figure belonging to any real household appears
  in this guide. Every worked example uses the **fictional sample
  household** in `server/src/sampleHousehold.ts` (§1.1). Public tax-law
  figures (brackets, thresholds, divisors) are quoted because they are
  law, not household data — and every one is pinned to a cited source
  in §7.

## 1. What the engine computes

### 1.1 The frame: today's dollars, one year at a time

The engine prices a household's whole retirement horizon year by year
in **today's dollars**: brackets, deductions, and thresholds are held
at their published real values and carried forward, while amounts the
statute fixes in nominal dollars (Social Security provisional-income
thresholds, NIIT thresholds, the IRMAA top-tier floor) are *deflated*
at the plan's inflation input for each year past the law row they come
from — so the "tax torpedo" widens over time exactly as the statute
implies. Returns, spending, and balances are all real. Nothing in the
engine is nominal-dollar forecasting; a year that prices under a
carried-forward law row is priced under that row's real figures.

Money units: the engine works in **dollars**; the published actions
(`server/src/actions.ts`) return money in **integer cents**, rounding
once at the boundary. A recomputation from published cents can differ
from the engine's own figures by a cent — that is rounding, not drift.

### 1.2 The sample household (fictional — every example in this guide)

`server/src/sampleHousehold.ts` is the one reference household for new
fixtures and tests. A married couple filing jointly, household of 4
(two kids), born 1968 / 1970, retiring at 62, planning to 95. Balances:
pre-tax $1,500,000; taxable $2,000,000 at 60% cost basis; Roth
$400,000; HSA $75,000; cash $100,000; 529 $150,000; non-taxable
$50,000. Spending $180,000/yr. ACA second-lowest-cost Silver
benchmarks: family $36,000/yr, couple $25,000/yr, single $17,500/yr.
Filed 2025 return: interest $1,500 (line 2b), ordinary dividends
$20,000 (line 3b), qualified dividends $15,000 (line 3a) — a 75%
qualified share, a 1.00% dividend yield and a 0.075% interest yield
over the taxable balance. Social Security $48,000/yr (primary) and
$30,000/yr (spouse), both at 67. Guardrails: protect at least $50,000
of taxable, preserve $250,000 of pre-tax, heirs' rate 24%, expected
real return 5%, inflation 2.5%.

`samplePlanInputs(overrides)` returns this household as complete
engine inputs; a case overrides only the fields its note varies. The
existing committed suites do **not** import this module (their
fictional figures were generalized inline, and re-pointing them risks
moving their pins); the module governs new work only.

### 1.3 The six pricing paths

| Path | Entry point | What it prices |
| --- | --- | --- |
| Plan march | `runRothCompare` (per scenario) | The whole horizon, year by year, under one strategy: draws, conversions, RMDs, tax, ACA credit, IRMAA, terminal tax. The baseline every comparison is scored against. |
| Funding ledger | `runRothFunding` | The same plan, as a cash identity per year: needs vs. the twelve funding sources, plus shortfall and unpaid tax (see §4.3). |
| Optimizer | `runOptimizer` in `server/src/rothOptimizer.ts` | Searches named strategies (bracket fills, cliff caps, draw orders, claiming ages) and scores each by the net-cost identity (§4.3). Called by the Strategy Lab through the compare paths. |
| Monte Carlo | `runRothMonteCarloStats` / `runMonteCarlo` in `server/src/retirementEngines.ts` | Never-runs-out rate over seeded return paths; the golden-shocks fixture pins the shock stream exactly. |
| Playground year | `runPlaygroundYear` | One standalone tax year through the shared single-year pricer (`pricePlaygroundYear`), the same function the Playground view and the December console price with — no forked tax math. |
| December draw | `runDecemberProjection` | The year-end draw: the maximum safe pre-tax December distribution, sized to land ACA MAGI at the cliff minus a safety buffer (default $5,000, §2.7). Assembles the year from actuals + range cases + strays, then prices through the single-year engine. |

A seventh path, `runWorkYearsCompare`, prices salary years (with
payroll tax) and is the **only** path with a salary flow — the plan
march itself has none (§3).

The Retirement view's deterministic / Historical / Monte Carlo /
Max-Spending engines live in `server/src/retirementEngines.ts` and
share the guardrails comparison (§2.8) so the simulator and the
max-spending solver can never disagree at a rail.

## 2. Engine semantics an auditor must know

### 2.1 The law table is data, not code

`server/src/taxLaw.ts` is the single source of law figures, one row
per law year. Complete rows exist for **2025 and 2026** (2026 from
IRS Rev. Proc. 2025-32). The **2027 row is partial**: it publishes
only the §36B applicable percentages (Rev. Proc. 2026-26) and prices
coverage year 2027 wherever a 2027 coverage year is priced — it is
never the fallback for 2028 or later, which fall back to the 2026
row, the newest complete row.

A year with no row of its own prices under the **nearest published
row in its own direction**: later years under the newest row, earlier
years under the oldest row — never under a later year's law. The row
actually used is named wherever a price is surfaced
(`lawYearUsed` on the Playground result), so the substitution is on
the record, never silent. Adding a new tax year is adding one table
row from that year's IRS Rev. Proc. / CMS release — no engine change.
A scheduled law change is expressed as dated table data (a new row,
or a dated window like the OBBBA senior deduction's 2025–2028 span),
never as engine code.

### 2.2 The plan march and the settlement iteration

Each march year prices spending, income, draws, conversions, RMDs,
tax, and credits — and then **re-prices itself**: the income a year's
own tax-channel debits create (realized gains on the Taxable sales
that pay the tax bill, and the full amount of any pre-tax debit that
pays tax) is priced as income of the same year, and the settlement
repeats until the tax due, the debits taken, and the priced income
agree to the cent (bounded; a year that cannot converge returns its
best iterated state). Every priced year carries the outcome on its
face: `settlementConverged`, `settlementMismatchCents` ({gains,
pretax} — both 0 when converged), and `ceilingBreached` (true when a
switched-on ceiling is still breached by the year's final figures at
conversion $0 — the draws alone breach). A non-converged year was
priced from the iteration's best state, and the Tax Plan year rows
mark it; never read a $0 conversion in a breached year as a fill
failure.

### 2.3 Draw order

Spending is drawn from the three buckets in a chosen order; all six
permutations exist (`taxable-pretax-roth`, `taxable-roth-pretax`,
`pretax-taxable-roth`, `pretax-roth-taxable`, `roth-taxable-pretax`,
`roth-pretax-taxable`). The default is **taxable → pre-tax → Roth**.
A plan may switch order at an age (`drawOrderAfter` from
`drawOrderSwitchAge`; the switch year itself already uses the
after-order). Tax is paid from taxable money (highest-basis cash
first) per `payTaxFrom`, never from Roth and never from the HSA —
except through the settlement's unpaid-tax debits, which are reported
separately (see §4.3). The operating model most plans use — live on
pre-tax withdrawals up to the ACA cliff, offset the taxes with
taxable money — is the `pretax-taxable-roth` order plus the cliff cap,
not the engine default; check which order a priced plan actually
carries before judging it.

### 2.4 Basis drift

The taxable pool is a **basis ledger**, not a single percentage.
Every sale realizes gains pro-rata against the pool's current basis
dollars; inflows (reinvested yield, surplus cash swept into Taxable
at 100% basis) join the ledger and drift the ratio, so later years
price draws at the *drifted* ratio, not the starting percentage. A
blank basis disables drift entirely and every figure takes the
pre-drift path bit-identically. Gifts reduce basis dollars pro-rata
without separately realizing gains. Basis tiers (when the pool is
split) price per-tier. The differential check (§4.4) pins the
ledger's footing: cumulative inflows bound the basis balance, and the
loss ledger's carry-out counts the year's own loss.

### 2.5 Terminal tax

The ending pre-tax balance is taxed once, at the horizon, in two
parts:

```
terminal = exitRate × min(ending pre-tax, preserve floor)
         + heirRate × max(0, ending pre-tax − preserve floor)
```

`preservePretax` is a guideline floor, not a requirement; the
preserved part prices at the plan's preserve exit rate (which
defaults to the heir rate when the plan sets no separate exit rate),
the excess at the heir rate. With no floor the preserved part is $0
and the terminal is the old single-rate figure bit for bit. The
terminal is part of the score identity (§4.3) and of ending wealth
(ending wealth subtracts it). A plan that strands pre-tax money pays
for it here — which is why "Do Nothing" can look cheap on tax and
expensive on net cost at the same time.

### 2.6 Social Security claiming-age derivation

The engine never stores a benefit per claiming age. It stores one
**anchor** (annual benefit at a stated start age) and derives the
rest: it backs the Primary Insurance Amount out of the anchor
(`PIA = anchor ÷ factor(anchorAge)`) and re-prices it at the new age
(`PIA × factor(claimAge)`). The factor is the SSA schedule:
5/9% per month for the first 36 early months, 5/12% per month after
that; 2/3% per month of delayed-retirement credit up to 70; full
retirement age by birth year (65 for 1937 and earlier, stepping to
67 for 1960 and later). `runRothCompare` derives; `runRothFunding`
does **not** — a funding run for a different claiming age must be
given the derived amount explicitly, or it silently prices the
un-scaled amount. Spouse benefits derive the same way when entered.

### 2.7 ACA: the cliff, the two vintages, the cap, and the buffer

Credits price under IRC §36B against the second-lowest-cost Silver
benchmark. Income as a percentage of the federal poverty line
selects the applicable percentage (linearly interpolated inside each
band); the credit is `benchmark − applicable% × MAGI`, and $0 above
the cliff.

**Prior-year lookback.** A coverage year uses the HHS poverty
guidelines for the year *before* it: 2026 coverage uses the 2025
guidelines (household of 2 = $21,150, so the household-of-2 cliff is
$84,600; household of 3 = $26,650, cliff $106,600). In today's-dollars
modeling, future coverage years reuse the newest guidelines row.

**The two cliff vintages — the fact that trips up every first
review.** For a household of 5, the 2026-coverage cliff is four times
the household-of-5 FPL on the 2025 guidelines ($37,650 — see
`FPL_GUIDELINES` in `taxLaw.ts`, and the hand-derived fixture note
that computes the cliff from it). The **$154,720** line that
appears in the fixture pins for later years is 4 × $38,680 FPL on the
**2026** guidelines — the 2027-coverage cliff, which the march's
projected years reuse because the newest guidelines row is carried
forward. Both are correct, for different years; a figure that pins
MAGI "at the cliff" must name which vintage it means. The December
reference case and the fixture suite pin both vintages explicitly.

**2025 is different.** The 2025 schedule is the enhanced (ARPA/IRA)
schedule: 0% below 150% FPL rising to a flat 8.5% at 400% FPL and
above — there is **no cliff in 2025**, and the engine prices a credit
above 400% FPL for 2025 coverage. The cliff exists for 2026 and
later, when the enhanced credits expired: a credit pays at exactly
400% FPL and is $0 above it.

**Band edges are lower-inclusive.** The published tables define each
band as "at least X% but less than Y%", so income exactly at a band's
lower edge takes that band's *initial* percentage. The one edge where
this changes a priced figure is 133% (the first band's final
percentage differs from the second band's initial); every other edge
is continuous.

**Cliff cap and buffer.** A plan may cap its pre-tax draw at the
cliff (family-only cap: the cap defends only family-household years
and switches off at the step-down to a couple/single household).
The **December console** sizes the December draw to the cliff minus
a safety buffer — default **$5,000** — because December numbers are
near-final, not final; the buffer absorbs estimation gaps. The
compare paths carry the same ceilings as switchable strategy
settings, with the buffer as a named input.

**Documented limit — the enrollment-premium cap.** Form 8962 caps
each month's credit at the premium of the plan actually enrolled in,
but the long-horizon march prices the credit against the benchmark
premium alone and does not cap it by a cheaper plan's premium — with
one entered-premium exception: when the plan enters a marketplace
premium under the health-premium term, that entered premium *is* the
enrollment premium for the march's years and the retained credit is
capped at it. The cap binds only on a deliberate below-benchmark
enrollment (for example, choosing a bronze plan for HSA
eligibility); the December console takes an enrollment-premium input
and applies the cap on the surface where the draw is actually sized.

### 2.8 IRMAA

IRMAA tiers are law-table data per year and filing status: each tier
names the highest MAGI in the tier and the **total** Part B monthly
premium per person at that tier (the surcharge is total minus the
year's standard premium) plus the Part D monthly surcharge. Two
figures must never be confused:

- **IRMAA payable this year** — the surcharge on the household's
  Medicare premium notice, charged beside the base premium in the
  cash left after health premiums, never in the tax bill.
- **IRMAA this year's MAGI will cause** — priced in the forward
  block for `premiumYear = taxYear + 2`. A year's MAGI prices the
  surcharge two years out; the annual-household figure can coincide
  with the payable amount without being the same surcharge.

The top tier's $500,000 single / $750,000 joint floor is fixed by
statute through 2028 and indexed after that; it deflates only for
the steps through 2028 counted from the law row's year. The boundary
pack pins the fractional top-tier edge ($499,999.50 stays tier 4,
$500,000 is tier 5) and the deflated 2028 top.

### 2.9 Guardrails, Monte Carlo, and the optimizer

**Guardrails** (Retirement view): cut spending when the current
withdrawal rate is above the cut rail, raise it when below the raise
rail, by the adjustment step — defaults **cut 120%, raise 80%,
adjust ±10%**. The rule is strict: a rate exactly *at* a rail fires
neither, and the comparisons carry a 1e-9 relative tolerance because
the rail products can land an ulp on the wrong side in IEEE-754
floating point. At most one adjustment per year. The single shared
comparison drives both the simulator and the max-spending solver.

**Monte Carlo** replays seeded return paths (mulberry32 / Box–Muller
shocks; the golden-shocks fixture pins the stream to 1e-9) and reports
the never-runs-out rate. Agreement across seeds is asserted within 4
standard errors of binomial sampling noise — a seed-to-seed wobble is
sampling, not a defect, and the sensitivity registry pins the band.

**Optimizer** scores named strategies by the net-cost identity
(§4.3) over the full march. Winner names are never asserted by the
sensitivity checks — a winner may legitimately change brackets under
perturbation; what is asserted is the *ordering* of net cost across
caps and its monotonicity in return and spending.

### 2.10 AMT and the Washington excise

Every priced year also computes a parallel tentative minimum tax
(IRC §55, Form 6251); AMT owed is the excess of tentative over
regular tax, never below $0, and sits **inside** federal tax — never
added beside it. The exemption, phase-out, and 26%/28% breakpoint
are dated law-table data. The adjustments the engine has quantities
for are the SALT actually taken, the standard deduction (base plus
age-65+ add-ons), and the OBBBA senior deduction add-back. Named
limitations — adjustments the engine has no inputs for and invents
none for: the incentive-stock-option bargain element (§56(b)(3)),
tax-exempt interest from private-activity bonds (§57(a)(5)),
depreciation differences, other §56(a) recomputations, the AMT
foreign tax credit, and the §53 credit for prior-year minimum tax. A
household with those items can owe more AMT than the engine prices.

Washington's capital-gains excise (RCW 82.87) prices as the state
tax **instead of** the flat state rate when `residenceState` is
`'WA'` — the two never stack. It applies only to Washington-allocated
long-term capital gains (7%, plus 2.9% on the portion above
$1,000,000 — a statute-fixed threshold that deflates in projections),
after the year's standard deduction ($278,000 in the 2025 and 2026
tables) and the charitable deduction of RCW 82.87.080. Qualified
dividends, retirement distributions, and Social Security never enter
the base. Washington is the only state with a rules layer.

## 3. What is deliberately NOT modeled

- **Salary flow in the plan march.** The march prices retirement
  years; `salarySurplusCents` is always 0 on funding rows. Salary
  years price separately through `runWorkYearsCompare`, whose money
  is in dollars and whose tax folds in payroll tax (employee share
  only). Do not look for wages inside a compare run.
- **Spouse Social Security left at $0 is a household decision, not
  an engine gap.** The engine prices a spouse benefit whenever one
  is entered (same derivation as §2.6, searched jointly when
  entered). If a plan carries $0 for the spouse, that is the
  household's choice recorded in its inputs — verify the input
  before calling it a missing feature.
- **College costs** flow through ordinary spending draws; there is
  no separate college engine. (The FAFSA $40,000 asset gate appears
  only as a warning on the march.)
- **No blindness or dependent concept.** The Pub. 17 blind example
  and dependent standard-deduction table are out of scope by design;
  the engine has no inputs for them.
- **No MFS §86 thresholds.** The Pub. 915 married-filing-separately
  example is out of scope; the engine prices MFJ / single / head of
  household.
- **No enrollment-premium cap on the long-horizon credit** except
  through an entered premium (§2.7).
- **No AMT adjustments without inputs** (§2.10).

## 4. Invariants: the checks that must hold

### 4.1 The regression gate

Every build prices a fixed set **before and after** its change and
diffs per-year per-field to the cent: the December reference case
plus the sample household's full plan (`runRothCompare` +
`runRothFunding`, including a varied-return case). The set has
**6,725 leaves**; a clean build diffs **0 leaves**, byte-identical
(SHA-256 `1697107470d46def65cce81a95ba1cc43512356b16c603096b4196da1c588333`
on the banked baseline). Any difference must be the fix's intended
change, named in advance; any other difference fails the gate. The
gate probe lives in scratch (`~/workspace/scratch/…/gate-probe.ts`
with `diff-gate.py`, `gate-before.json`, `gate-after*.json`) — it is
a per-build procedure, not a committed script, and its baseline is
re-banked whenever the reference set legitimately changes.

### 4.2 Fixture suites

`runAccuracySelfCheck` runs one suite per call
(`suite: tax | tax-teeth | tax-teeth-opt | extended |
extended-teeth | retirement | retirement-teeth | integrity |
ui-state | roth-cas | retirement-cas | replay | december |
hardening`). Counts verified from the tree (array lengths, and — for
retirement and December — by running them):

| Suite | Cases | Notes |
| --- | --- | --- |
| Tax (`server/src/taxFixtures.ts`) | 595 | Hand-derived pins, cents-exact; the census runs them chunked (§6). |
| Extended (`server/src/extendedFixtures.ts`) | 162 | Optimizer / compare / settlement cases. |
| Retirement (`server/src/retirementFixtures.ts`) | 63 | Includes the Trinity benchmark case (§7). Verified 63/63 by running the suite on 2026-11-10. |
| December (`runDecemberFixtures` in `server/src/decemberCore.ts`) | 96 | Solver-independent figures exact to the cent; figures out of the cliff solver's cent-by-cent search within ±$0.02. Verified 96/96 by running the suite on 2026-11-10. |
| Teeth (per suite) | — | Each suite corrupts its own pins and must *fail* — a teeth check that passes on corrupted data is a dead check. |

### 4.3 Score and footing identities

These hold on every priced plan and are the first thing to check
when a figure looks wrong:

- **Net cost:** `netCostCents = totalTaxCents + irmaaCents +
  penaltyCents + terminalCents − acaCreditCents −
  educationRefundableCents`, plus — only when the plan enters the
  health-premium term — `healthPremiumCents` (lifetime *gross*
  premium, added beside the ACA credit subtracted above, so the net
  effect is the net premium). AMT and NIIT sit inside federal tax
  and are never added again. The score can be negative: credits
  exceeding taxes is a net gain, not an error.
- **Ending wealth:** `endingAfterTaxWealthCents =
  endingPretaxCents + endingRothCents + endingTaxableCents +
  endingHsaCents − terminalCents`.
- **Funding identity:** for every year, the twelve funding sources
  sum to the year's total need (spending + federal tax + state tax +
  IRMAA); the twelve sources plus `spendShortfallCents` plus
  `unpaidTaxCents` foot to it exactly. Income beyond the year's
  needs is saved into Taxable and is not a source; reinvested yield
  is income but not cash funding; a cash draw is the household's own
  cash coming back (no sale, no gain, no income) and a Roth draw is
  already-taxed money — neither enters AGI, MAGI, the ACA or IRMAA
  bases, or any tax.
- **Unpaid tax is reported, never treated as paid.** A year whose
  balances cannot cover its bill carries `unpaidTaxCents`; the
  compare scenarios carry it as a lifetime total beside the score.

### 4.4 The hardening registry (26 checks)

`server/src/hardening/registry.ts` — one runner,
`runHardeningChecks("fast" | "full")`, over self-contained modules
that each declare their own inputs and assertions. Adding a check is
adding a module and one registry line. Verified 2026-11-10:
`bun server/src/hardening/run.ts --fast` → **26/26 checks passed,
teeth pass (44 corrupted pins failed as expected)**, ~67 s.

| Part | Checks | What they pin |
| --- | --- | --- |
| 1 — Cross-check harness | differential, invariants, rounding (3) | Thousands of seeded households priced by the engine *and* by an independent second implementation built from the law tables only (0 mismatches / 144,735 comparisons on the 2,000-household full run); money-conservation invariants across trajectory years; cent-quantization sweep. |
| 2 — Boundary pack | aca, irmaa, brackets, gains, deductions, salt, rmd-claim, phase-outs, wa-excise, fafsa-kiddie (10) | Every boundary the engine prices, both sides, ±$1/±1¢ pins — the deliberate enumeration the seeded differential only covers by chance. |
| 3 — Known-answer checks | pub915, pub590b, ssa, pub17, trinity, mc-golden, maxifi (7) | Published worked examples priced by the engine vs. the published answer (§7). |
| 4 — Sensitivity review | return, spending, caps, cliff, mc-seed, strips (6) | Directional / monotonicity probes on the fictional sample household: ending wealth non-decreasing in return, non-increasing in spending; conversion-cap net-cost ordering stable under perturbation; credit non-increasing in MAGI across the cliff; Monte Carlo agreement across seeds; optimizer strip monotonicity. |

**Teeth convention:** every module carries its own teeth check — it
corrupts one pin by a cent (or the equivalent) and the check must
fail. The runner aggregates teeth across all modules; a teeth pass
with a failing check, or a check pass with failing teeth, is a red
flag either way.

## 5. How to interrogate describeApi

`describeApi` returns the machine-readable API contract for every
published action, **generated live from the actions' own zod
schemas** — never a hand-written list. It carries version stamps and
the conventions the actions publish.

- **Contract version:** `API_CONTRACT_VERSION` in
  `server/src/actions.ts` — **163** at the time of writing. Bump
  when a published shape or convention changes. A consumer that
  cached an older contract must re-read it; do not trust a stale
  copy.
- **What it returns:** the action list with a purpose string per
  action (the authoritative description of what each action prices
  and returns), the request/response schemas, and the published
  conventions — the long-form semantics in
  `server/src/apiContractCore.ts` (score identities, balance
  semantics, tax-return semantics, guardrails semantics, ceiling
  semantics, settlement semantics, and the rest). When the prose in
  this guide and a convention disagree, the convention wins; when a
  convention and the code disagree, the code wins and the convention
  is a bug.
- **How to call it:** it is an ordinary published action — call it
  through the app's action dispatcher like any other action. Headless,
  the packaged harness checks it (`packaged/harness.ts`, section A:
  the reported contract version and action list are derived from the
  source, never hard-coded).
- **How to price a case:** read the saved plan with
  `getRothPlanner` (inputs, saved scenarios, execution-year and
  tax-return blocks, latest Net Worth snapshot subtotals), then price
  with `runRothCompare` (an ordered list of named scenario patches
  against one base plan; per-scenario results in cents with deltas
  versus the baseline) or `runRothFunding` (the plan as given, one
  funding row per year). Single years go through
  `runPlaygroundYear`; one plan year in detail through
  `runPlanYearDetail` (the same year with its conversion forced to
  $0 alongside, for the counterfactual).
- **Provenance echoes — read these before re-deriving anything:**
  every compute response echoes the values it actually priced with
  (`effectiveInputs` — including the threaded yield fallbacks and
  qualified-dividend share derived from the stored tax return, and
  the resolved yields), the law year actually used (`lawYearUsed`),
  and the settlement flags (§2.2). In a compare run each scenario
  carries its own echo, re-derived from its own resolved pool. A
  figure that disagrees with a hand computation is usually a
  threaded value the echo names — check the echo first.
- **Two asymmetries to know before comparing actions:**
  (1) a compare year's `federalTaxCents` **excludes** its
  pre-59½ penalty while the funding row's `federalTaxCents` for the
  same year **includes** it (paid as part of the federal
  withholding) — add `penaltyCents` beside the compare figure to
  agree with funding; (2) `pretaxDrawCents` (funding) is the extra
  spending draw plus pre-tax amounts applied to the tax bill,
  while `pretaxOutByChoiceCents` (compare) is the conversion plus
  the pre-tax spending draw and excludes tax-bill debits — the
  per-year split (`pretaxSpendingDrawCents` /
  `pretaxTaxDebitCents` / `extraPreTaxDrawCents`) is carried on both
  so the two can be reconciled without re-derivation.
- **Balance semantics:** in a base plan payload a null balance is a
  blank that follows the Net Worth snapshot (an omitted key fails
  validation); in a scenario's overrides an omitted balance key
  inherits the base's resolved value and an explicit null prices
  that balance at $0 — and the scenario's echo shows the resolved
  $0, not the null that was sent.

## 6. How to run the suites

| Task | Command | Notes |
| --- | --- | --- |
| Typecheck | `bun run typecheck` | Both client and server tsconfigs. Note: bare `bun x tsc --noEmit` from the repo root prints help and exits 1 — use the script. |
| One accuracy suite | `runAccuracySelfCheck` with `suite` set to one of `tax`, `tax-teeth`, `tax-teeth-opt`, `extended`, `extended-teeth`, `retirement`, `retirement-teeth`, `integrity`, `ui-state`, `roth-cas`, `retirement-cas`, `replay`, `december`, `hardening` | One suite per call, by design. The `hardening` entry runs the registry's **fast** checks. |
| Hardening registry | `bun server/src/hardening/run.ts [--fast \| --full]` | Default `--full`: 2,000 seeded households in the differential. `--fast` is the suite-safe run (subset seeds). Exits 1 on any check or teeth failure. |
| Packaged verification | `bun ./run-harness.mjs` from `packaged/` | Builds the harness + tax-test bundles and runs the packaged runtime against an in-memory store: contract check, fixture census, seeded pricing, backup/restore interop, persistence, CAS spot checks, December end-to-end. |
| Tax census | chunked, via `packaged/taxtest.ts` (invoked by `run-harness.mjs`) | **Do not run the whole tax suite in one process or one worker call.** The single-call suite builds multiple GB of fixture state and is OOM-killed on this machine — standing limitation S-2. The census driver slices it (24 chunks is the working count; 12-way chunking OOM-kills) with a sequential-retry fallback for chunks that die under concurrency. |
| Regression gate | per-build procedure (§4.1) | The gate probe lives in scratch, not in the repo. Price the fixed set before and after; 0 differing leaves or the build fails its own verification. |

**Worker cap.** A live worker call caps at 120 s. The full
differential (thousands of households) cannot run inside one call —
that is why the full run lives in the committed bun script
(`server/src/hardening/run.ts`) and the accuracy self-check runs only
the fast subset. A suite that takes minutes is expected; a suite that
takes minutes *inside a worker call* is a misuse, not a slow engine.

**Fresh-clone notes.** `bun install` fails the `@hatch/space-sdk`
tarball integrity check in a fresh clone — copy `node_modules` from
a working tree. `server/src/actions.ts` cannot find
`@space/privileged` in a fresh clone (a git-ignored generated file);
that is an environment artifact, not a defect.

## 7. Provenance and citations

Each hardening module cites its publication, section, and example
number in its header — those headers are the citation source of
record. The table below lists only sources verified to exist in the
repo's hardening modules and law-table comments. It is not a complete
citation set for the law table.

| Source | What it pins | Where |
| --- | --- | --- |
| IRS Publication 915 (2025), Worksheet 1, Examples 1–3 | §86 taxable Social Security | `knownPub915.ts` |
| IRS Publication 590-B (2025), RMD worked examples; Appendix B Tables II and III | RMD divisors, joint-life table | `knownPub590b.ts`, `taxLaw.ts` (Uniform + Joint tables) |
| SSA Benefits Planner age-62 chart; POMS RS 00615.693 | Claiming-age factors, age-70 row | `knownSsa.ts` |
| IRS Publication 17 (2025), Ch. 10, Examples 1 and 3; Tables 10-1/10-2 | Standard deduction | `knownPub17.ts` |
| IRS Rev. Proc. 2025-32 | 2026 law rows (brackets, standard deduction, AMT) | `taxLaw.ts` |
| IRS Rev. Proc. 2025-25, §3.01 | §36B applicable percentages, 2026 | `taxLaw.ts`, `apiContractCore.ts` |
| IRS Rev. Proc. 2026-26 (IRB 2026-31) | §36B applicable percentages, 2027 (partial row) | `taxLaw.ts` |
| IRS Rev. Proc. 2024-35 | 2025 enhanced §36B schedule | `taxLaw.ts` |
| IRS Rev. Proc. 2024-40 | 2025 AMT exemption / phase-out | `apiContractCore.ts` |
| Cooley, Hubbard & Walz, "Retirement Savings: Choosing a Withdrawal Rate That Is Sustainable", AAII Journal, Feb 1998, Table 3 | Trinity benchmark (4% rule) | `knownTrinity.ts`, `retirementFixtures.ts` |
| RCW 82.87 | Washington capital-gains excise | `taxLaw.ts`, `apiContractCore.ts` (state semantics) |
| HHS poverty guidelines 2024–2026 (2026: Federal Register, Jan. 15, 2026; FR Doc. 2026-00755) | FPL lookback, cliff math | `taxLaw.ts` |

### 7.1 Pending: the law-table provenance audit — NOT YET RUN

**The full citation set for the law table does not exist yet.** A
law-table provenance audit — one citation per law-table figure,
checked against its primary source — was approved and queued with the
GitHub preparation work and has **not run**. Until it runs, treat §7
as the verified subset, not the complete provenance: a law-table
figure whose citation is not listed above is *unverified by this
guide*, not verified. The audit is the pending follow-up; its output
belongs in this section (and produces the reviewer guide's full
citation set). Do not cite this guide as the law table's provenance
until the audit lands.

### 7.2 Adjudicated disagreements (the engine is right; the publication is wrong)

- **IRS Pub. 590-B, 2026 excess-distribution leg.** The publication
  prints $1,313 ($34,800 ÷ 26.5, "denominator for age 73 per Table
  III"), but its own rule (denominator by age as of birthday in
  2026) plus its own Table III (73 → 26.5, 74 → 25.5) require 25.5 —
  the owner turned 73 on Dec 15, 2025 and is 74 in 2026. The pin
  uses the corrected **$1,364.71** and documents the disagreement.
- **Trinity 75/25 passes by 2.1 pt** (app 94.1% vs. published 98%,
  tolerance ±6pt; 50/50 is 92.6% vs. 95%). Recorded in the
  module and the version log, not a failure — and a future data or
  method change that nudges the app rate down will fail this check
  first, which is correct pin behavior.
- **No MaxiFi-published dollar figure exists in the repo.** The
  MaxiFi check pins the joint-beats-separate property as an
  externally-named invariant, not a published figure. No figure was
  invented for it.
- **SSA rounding.** SSA truncates monthly dollars to whole dollars
  and calls its percentages "approximate" — factors are pinned
  exact, dollars within $1.00; SSA-annualized dollars are never
  pinned (SSA annual is truncated monthly × 12).
- **The 133% FPL pin** derives from the actual float `pctFpl`
  (132.99999999999997 on some household/year combinations); a +1¢
  pin covers the true discontinuity. The float is the engine's, not
  a law-table error.

## Appendix: file map

| File | What lives there |
| --- | --- |
| `server/src/taxLaw.ts` | Versioned law tables; FPL guidelines; ACA tables; RMD ages and divisors; IRMAA tier type. |
| `server/src/taxEngine.ts` | Shared single-year pricer (`priceYear`, `pricePlaygroundYear`); ACA credit; basis ledger; settlement; draw order. |
| `server/src/rothOptimizer.ts` | Plan march; compare; optimizer; funding; SS derivation; terminal pricing; net-cost identity. |
| `server/src/retirementEngines.ts` | Deterministic / Historical / Monte Carlo / Max-Spending engines; guardrails. |
| `server/src/decemberCore.ts` | December console; December fixtures. |
| `server/src/sampleHousehold.ts` | The fictional sample household for new fixtures and tests. |
| `server/src/taxFixtures.ts`, `extendedFixtures.ts`, `retirementFixtures.ts` | The committed fixture suites. |
| `server/src/hardening/` | The check registry, runner, and all check modules. |
| `server/src/actions.ts` | Published actions; `describeApi`; `API_CONTRACT_VERSION`. |
| `server/src/apiContractCore.ts` | The conventions describeApi publishes. |
| `packaged/harness.ts`, `packaged/taxtest.ts`, `packaged/run-harness.mjs` | Packaged-build verification harness and chunked tax census. |
| `HANDOVER.md`, `DATA-PLAN.md`, `AGENTS.md` | Operating model; build-by-build version log; build rules. |
