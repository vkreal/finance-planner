# AI Usage — Finance Planner Standalone Bundle

You just found `finance-planner-cli.mjs`. This file tells you how to
use it. Assume nothing else: no server, no repo checkout, no
account, no prior conversation about it.

## The one-command run

```bash
node finance-planner-cli.mjs retirement_describe_capabilities
```

That call needs no input and returns the machine-readable guide:
every tool, what it is for, its required and optional inputs, an
example call, and the assumptions and limits. Call it first, before
any financial question.

A calculation looks like this:

```bash
node finance-planner-cli.mjs retirement_calculate input.json
```

Or with stdin:

```bash
node finance-planner-cli.mjs retirement_monte_carlo --stdin < input.json
```

Requirements: **Node.js 20 or newer** (check with
`node --version`). The file is self-contained — no `npm install`,
no `node_modules`, no network, no config, no database. It works
from any directory. It starts no server.

## Three rules

1. **Supply complete inputs on every call.** Every financial call
   carries its full scenario — balances, spending, ages — because
   nothing is saved between calls. The six essential inputs are
   `pretax`, `taxable`, `roth`, `hsa`, `monthlySpending`, and
   `currentAge` (dollars, whole years), plus `spouseAge` for married
   households (married filing jointly, the default, requires it).
   Omitting one returns `ok: false` with `error.code:
   "missing_input"` and exit code 2 — ask the user for the missing
   figure; do not guess it. An explicit zero is a real value, not a
   missing one, for the four balances; `monthlySpending` must be
   over $0.
2. **Don't invent results.** Use this bundle as the calculation
   source. Do not hand-compute retirement, Monte Carlo, or tax
   figures. If you cannot execute the bundle (your environment does
   not permit running third-party code), say so plainly and do not
   present a figure as engine-generated. Never claim the tool ran
   when execution failed or was unavailable.
3. **Don't use sample data.** The bundle never reads the repository's
   sample household, saved inputs, or snapshots — it prices only
   what you pass in. Do not substitute sample or example figures for
   a user's missing inputs.

## How to answer a retirement question

- Pick the right tool for the question (see the guide from
  `retirement_describe_capabilities`): `retirement_calculate` for
  "can I retire?", `retirement_monte_carlo` for "how likely is it
  to work?", `retirement_max_spending` for "how much can I spend?",
  `retirement_compare_strategies` for withdrawal order,
  `retirement_roth_conversion` for conversions,
  `retirement_work_years` for "is working longer worth it?",
  `retirement_tax_year` for one year's tax bill.
- When the user changes only one variable, keep every other input
  exactly as before and change just that one — then run again and
  report the difference between the two engine results.
- Before explaining a result, inspect `effectiveInputs` (exactly
  what was priced) and `assumptions` (every default and engine
  constant used) in the response envelope.
- Distinguish portfolio-only simulations from tax-aware
  projections: `retirement_monte_carlo` and `retirement_calculate`
  are portfolio-only (they do not include taxes); the compare,
  Roth, work-years, and tax-year tools are tax-aware. Never present
  a Monte Carlo result as a tax-aware projection.
- Label numeric results as engine-generated (e.g. "the engine
  prices this at …"). The envelope carries `source`,
  `adapterVersion`, `apiContractVersion`, and `taxLawYear` — quote
  the tax law year when a result depends on it.
- Exactly one JSON response is printed on stdout per call;
  diagnostics go to stderr. Exit codes: `0` = the calculation
  succeeded (`ok: true`), `2` = the calculation failed or inputs
  are missing (`ok: false`, still printed — read its `error`), `1`
  = usage error (bad command, unreadable input, invalid JSON,
  input over 256KB).
- Keep inputs private and do not commit actual household data.

## Worked example

Question (fictional household — pre-tax $1,250,000; taxable
$2,100,000; Roth $375,000; HSA $62,000; spending $9,500/mo; ages
54/52; Social Security $36,000/yr at 67, spouse $18,000/yr at 67;
taxable basis 72%): "Can I retire at 54?"

```bash
node finance-planner-cli.mjs retirement_calculate retire-54.json
```

where `retire-54.json` is:

```json
{
  "pretax": 1250000, "taxable": 2100000, "roth": 375000, "hsa": 62000,
  "monthlySpending": 9500, "currentAge": 54, "spouseAge": 52,
  "retirementAge": 54, "endAge": 95,
  "socialSecurityAnnual": 36000, "socialSecurityStartAge": 67,
  "spouseSocialSecurityAnnual": 18000, "spouseSocialSecurityStartAge": 67,
  "taxableBasisPct": 72, "taxYear": 2026
}
```

Engine result (measured from the bundle under Node 20):
`neverRunsOut: true`, ending balance $16,594,936.46 at age 95,
historical never-out rate 100%, historical median ending
$34,450,724.84.

Plain-English answer: "Yes — on these figures, the money lasts to
95. The flat projection ends with about $16.6M, and in every
historical market path since the 1920s it also lasts, with a typical
ending around $34.5M."

The user follows up: "What if I retire at 60 instead?" Change
**one** input (`retirementAge`: 54 → 60), keep everything else
identical, and run again:

Engine result: `neverRunsOut: true`, ending balance
$21,310,569.24 at age 95, historical never-out rate 100%,
historical median ending $42,143,819.62.

Plain-English answer: "Retiring at 60 instead of 54 ends about
$4.72M higher — $21,310,569.24 vs $16,594,936.46 — because the
portfolio grows for six more years before spending starts. Both
plans last to 95 in every historical path."

## Where to get the bundle and the reference

- The bundle: `assistant-api/dist/finance-planner-cli.mjs` in the
  repo, or the `finance-planner-cli.mjs` artifact on the GitHub
  Releases page, with `finance-planner-cli.mjs.sha256` next to it.
  Verify with `sha256sum -c finance-planner-cli.mjs.sha256`.
- The reference: `assistant-api/STANDALONE.md` — build, tools,
  input/output schema, assumptions, limitations, verification.
- The adapter's own guide: `assistant-api/README.md` (Method A:
  Remote MCP; Method B: this standalone bundle).
- The repo's AI front door: repo-root `llms.txt`.
