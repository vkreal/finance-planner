# Finance Planner Assistant API

> **AI assistants start here.** This is a stateless, read-only MCP
> server over the Finance Planner's own retirement engines. An AI
> asks a retirement question — "can I retire?", "how likely is my plan
> to succeed?", "how much can I spend?", "should I convert to Roth?",
> "what if I retire later?" — by calling one of 8 tools with the
> household's figures. Every call carries its complete scenario in
> dollars; nothing is saved, nothing is read from a database, and
> nothing is remembered between calls. Pricing uses the 2026 tax-law
> tables unless `taxYear` says 2025.
>
> **Endpoint (local):** `POST http://127.0.0.1:8080/mcp` (Streamable
> HTTP, JSON-RPC 2.0). No token needed on localhost.
> **Endpoint (remote):** `POST https://<host>/mcp` with
> `Authorization: Bearer <token>` — **no public endpoint is live yet;
> deployment is the reader's step** (see "Remote MCP deployment").

## The 8 tools (one line each)

- `retirement_calculate` — can the money last to the end age? Ending balance + year-by-year table + historical cross-check.
- `retirement_monte_carlo` — how likely is the plan to succeed? Success rate (0–1) + p10/p50/p90 outcomes.
- `retirement_max_spending` — highest sustainable monthly spending at 85% Monte Carlo success.
- `retirement_compare_strategies` — which account to spend from first? Taxable-first vs pre-tax-first vs Roth-first, tax-aware.
- `retirement_roth_conversion` — convert to Roth? Do Nothing vs Fill 12% vs Fill 22% vs Fill 22% capped at IRMAA Tier 1.
- `retirement_work_years` — retire at which age? Tax-aware comparison across `compareAges`; add `salaryAnnual` for the work-years leg.
- `retirement_tax_year` — one year's federal/state tax, ACA credit, and IRMAA for a published law year (2025 or 2026 today).
- `retirement_describe_capabilities` — no inputs; returns the machine-readable guide to all of the above.

## Minimal worked example

Question: "Can I retire at 58?" (fictional household: pre-tax
$1,250,000; taxable $2,100,000; Roth $375,000; HSA $62,000; spending
$9,500/mo; ages 54/52; Social Security $36,000/yr at 67, spouse
$18,000/yr at 67; taxable basis 72%; retire 58; end age 95).

```json
{
  "name": "retirement_calculate",
  "arguments": {
    "pretax": 1250000, "taxable": 2100000, "roth": 375000, "hsa": 62000,
    "monthlySpending": 9500, "currentAge": 54, "spouseAge": 52,
    "retirementAge": 58, "endAge": 95,
    "socialSecurityAnnual": 36000, "socialSecurityStartAge": 67,
    "spouseSocialSecurityAnnual": 18000, "spouseSocialSecurityStartAge": 67,
    "taxableBasisPct": 72, "taxYear": 2026
  }
}
```

Result (key figures): `neverRunsOut: true`, ending balance
$43,901,094.30 at age 95, historical never-out rate 100%.

> **Field names are the validator's names.** The names in this
> README are the ones the validator accepts (the zod schema in
> `src/schema.ts`), and the JSON Schema the server advertises over
> `tools/list` uses exactly the same names — a schema-consistency
> test (`tests/schema-consistency.test.ts`) asserts the two field
> sets are identical. Unknown keys are rejected with
> `invalid_input` naming the key (the validator is a strict
> schema, matching the advertised `additionalProperties: false`),
> so double-check spelling:
> `socialSecurityAnnual`, `socialSecurityStartAge`,
> `spouseSocialSecurityAnnual`, `spouseSocialSecurityStartAge`,
> `expectedRealReturnPct`, `state`, flat single-year fields like
> `conversionAnnual`, and `taxYear` must be a published law year (2025/2026 today). `cash`,
> `startYear`, and `inflationPct` are not accepted at all. Always
> include `spouseAge` for a married household — with the default
> `filingStatus: "mfj"` it is required.

## Architecture + data flow

```
AI client ── JSON-RPC 2.0 / Streamable HTTP ──► server.ts (auth, rate limits, 256KB cap)
                                                    │ dispatchTool(name, args)
                                                    ▼
                                              tools.ts ──► normalize.ts ──► adapter.ts
                                              (8 tools)    (validate,       (map scenario
                                                             dollars→cents,  onto engines,
                                                             defaults +      shape envelope)
                                                             provenance)
                                                    │
                          ┌─────────────────────────┼─────────────────────────┐
                          ▼                         ▼                         ▼
               retirementEngines.ts          rothOptimizer.ts           workYears.ts
               (sim / MC / historical /     (tax-aware compares,        (work-years leg,
                max-spending solver)         single-year tax price)      salary only)
                          │
                    taxEngine.ts + taxLaw.ts (static law tables; no I/O)
```

- **Stateless.** The server keeps no sessions, no database, no files.
  The only per-process state is the in-memory rate-limit buckets
  (keyed by a SHA-256 hash of the token, never the token itself).
- **No persistence reads.** The adapter never reads the app database,
  saved records, or the fictional sample household. Its only engine
  imports are five pure modules (`retirementEngines`, `rothOptimizer`,
  `taxEngine`, `taxLaw`, `workYears`); the test suite pins the import
  graph (`tests/isolation.test.ts`).
- **Dollars in, cents inside, dollars out.** Callers think in dollars;
  `normalize.ts` converts balances and spending to integer cents for
  the engines; results come back in dollars rounded to 2dp. Percents
  are plain numbers outside (6.75 means 6.75%); the adapter divides
  by 100 where an engine takes a decimal, and reports rates back as
  fractions 0–1 (a 97% success rate reads `0.97`, never `97`).
- **Monte Carlo chart values are dollars**, passed through rounded —
  not cents.
- **Tool → engine mapping:**

  | Tool | Engine function(s) |
  | --- | --- |
  | `retirement_calculate` | `simulateDetailed` + `runHistorical` + `runNeverRunsOut` |
  | `retirement_monte_carlo` | `runMonteCarlo` + `simulateDetailed` (deterministic cross-check) |
  | `retirement_max_spending` | `solveMaxSpending` (Monte Carlo, 85% target) + historical cross-check |
  | `retirement_compare_strategies` | `runRothCompare` (3 draw orders) |
  | `retirement_roth_conversion` | `runRothCompare` (4 conversion fills) |
  | `retirement_work_years` | `runRothCompare` (one scenario per quit age) + `runWorkYearsCompare` (only when `salaryAnnual` is given) |
  | `retirement_tax_year` | `pricePlaygroundYear` |
  | `retirement_describe_capabilities` | No engine call; returns the static guide |

## Installation

Prerequisites: [Bun](https://bun.sh) ≥ 1.2 and a checkout of this
repo — the adapter lives beside the engines it wraps
(`assistant-api/src` next to `server/src`), and `zod` resolves from
the repo root's `node_modules`. The adapter package declares no
dependencies of its own, so there is nothing to install inside
`assistant-api/`; if the repo root was never installed, run
`bun install` at the repo root once.

## Local execution

Zero-config on localhost, one command from `assistant-api/`:

```sh
bun run start
# [assistant-api] finance-planner-assistant-api v0.1.0 listening on http://127.0.0.1:8080 (POST /mcp)
```

On localhost the server boots with **no token** and prints a loud
warning to stderr that auth is disabled; only the local machine can
reach it, so this is safe by construction. Health check (no auth):

```sh
curl -s http://localhost:8080/health
# {"ok":true,"service":"finance-planner-assistant-api","version":"0.1.0","tools":8,"auth":"none-localhost","warning":"..."}
```

### CLI usage

No server needed — call a tool from the command line:

```sh
bun src/cli.ts --list                        # the 8 tools, one line each
bun src/cli.ts retirement_calculate input.json
bun src/cli.ts retirement_calculate --stdin < input.json
bun src/cli.ts serve --port 8080             # start the MCP server
```

Exit codes: `0` = `ok:true` envelope, `2` = `ok:false` envelope
(still printed), `1` = usage error. `serve` on a non-loopback host
needs `ASSISTANT_API_TOKEN`, exactly like the server (below).

## Remote MCP deployment

One command, from the repo root, with a bearer token set:

```sh
ASSISTANT_API_TOKEN=<a-long-random-token> assistant-api/deploy.sh
```

What it does: builds the Docker image (`docker build -f
assistant-api/Dockerfile -t fp-assistant-api .`), then runs it
detached on `0.0.0.0:8080` with the token passed by environment name
(never on the command line, never baked into the image). Host steps
after the script: point your DNS at the host and terminate TLS in
front of it (a reverse proxy with a certificate) — the container
itself serves plain HTTP on 8080, and the script does not set up
HTTPS. Then clients call `POST https://<host>/mcp` with
`Authorization: Bearer <token>`.

> **No public HTTPS endpoint is live yet.** Until someone runs the
> deploy above on a host and fronts it with TLS, there is nothing to
> point a remote client at. Do not paste a placeholder host into a
> client config and expect it to answer.

The Dockerfile itself is **not build-tested** — there is no Docker
binary in this VM — so the first real deploy should be watched, not
assumed (see "Known limitations" (ii)).

## Generic AI client connection

Copy the `mcpServers` block from `assistant-api/mcp.json` into your
client config (Claude Desktop, or any MCP client that speaks
Streamable HTTP), replacing the two placeholders:

```json
{
  "mcpServers": {
    "finance-planner-assistant-api": {
      "type": "streamable-http",
      "url": "https://<YOUR_HOST_HERE>/mcp",
      "headers": { "Authorization": "Bearer <YOUR_TOKEN_HERE>" }
    }
  }
}
```

For local use, point the same block at `http://localhost:8080/mcp`
with no `Authorization` header (auth is off on localhost). If a
client rejects `"streamable-http"` as a type, `"http"` with the same
URL and headers is the equivalent spelling. Unsure what the server
can do? Call `retirement_describe_capabilities` first — it takes no
inputs and returns the machine-readable guide (one entry per tool:
when to use it, required/optional inputs, example call, result
summary, plus assumptions, limitations, and quick-start).

## Full tool inventory

Six inputs are required for every financial tool (explicit `0`
counts as present; omitting one is a `missing_input` error, never a
calculation on partial input): `pretax`, `taxable`, `roth`, `hsa`
(balances in dollars), `monthlySpending` (dollars/month, must be
> 0), `currentAge` (whole years). Everything else is optional and
defaults inside `normalize` (see "Input assumptions + defaults").

| Tool | Required extra | Optional that matters most | Returns |
| --- | --- | --- | --- |
| `retirement_calculate` | — (the six) | `retirementAge`, `endAge`, `spouseAge`, `socialSecurityAnnual` + `socialSecurityStartAge`, `spouseSocialSecurityAnnual` + `spouseSocialSecurityStartAge`, `stocksPct`, `expectedRealReturnPct`, `strategy`. Tax inputs (filing status, taxable basis, yields, ACA benchmarks, state rate) and `taxYear` do not change this simulation — it prices no tax. `mcRuns`, `mcSeed` and `volatilityPct` do not change it either — there is no Monte Carlo leg. | `neverRunsOut`, `endingBalance`, year-by-year balances/withdrawals, `historicalNeverOutRate`, `historicalMedianEnding` |
| `retirement_monte_carlo` | — | Same as calculate, plus `volatilityPct`, `mcRuns` (10–5000, default 1000), `mcSeed` (default 12345; set it to reproduce a run exactly) | `successRate` (0–1), `endingP10`/`endingP50`/`endingP90`, spending stats, `chart` (dollars), `deterministicEndingBalance` |
| `retirement_max_spending` | — (`monthlySpending` is still required, as the starting point) | Same as calculate, plus `volatilityPct`, `mcSeed` (default 12345). `mcRuns` is NOT used — the solver always runs the engine's fixed 1,000 simulations; results report `runs: 1000` and an `mcRunsEffective` assumption. | `maxMonthlySpending` / `maxAnnualSpending` at 85% MC success (1,000 simulations), `successRate`, `medianEnding`, `runs`, `historicalMaxMonthlySpending` / `historicalMaxAnnualSpending` |
| `retirement_compare_strategies` | — | `retirementAge`, `endAge`, `spouseAge`, `filingStatus`, `householdSize`, `stocksPct`, `expectedRealReturnPct`, `socialSecurityAnnual` + `socialSecurityStartAge`, `spouseSocialSecurityAnnual` + `spouseSocialSecurityStartAge`, `taxableBasisPct`, taxable yields, `otherOrdinaryAnnual`, `taxExemptInterestAnnual`, ACA benchmarks, `stateRatePct`, `state`. Spending strategy and volatility do not change this comparison. `taxYear` does not change it either — the march starts in the current year and prices each year under that year's tables. **No strategy input** — all three orders are always compared. | `scenarios` (taxable-first / pre-tax-first / roth-first) with lifetime tax, ACA credit, IRMAA, ending wealth; `winnerByEndingWealth`, `winnerByNetCost`, `deltas` vs baseline, `yearly` table |
| `retirement_roth_conversion` | — | Same as compare_strategies. | `scenarios` (do-nothing / fill-12% / fill-22% / fill-22%-irmaa-tier-1) with federal/state tax, ACA credit, IRMAA, conversions total, terminal tax, ending wealth; winners + deltas; `yearly` table |
| `retirement_work_years` | — | Same as compare_strategies, plus `compareAges` (2–5 ages; default `[retirementAge, +2, +5]`), `salaryAnnual` (needed for the work-years leg), `employer401kAnnual`, `employerHsaAnnual` | Per-age Roth-compare scenarios + winners/deltas, plus `workYears` rows (all-in tax per quit age) and `workYearsWinnerByAllInTax` — the rows are `[]` and the winner `null` without a salary |
| `retirement_tax_year` | — | `taxYear` (a published law year — 2025/2026 today), single-year flat fields: `interestAnnual`, `ordinaryDividendsAnnual`, `qualifiedDividendsAnnual`, `conversionAnnual`, `spendingDrawAnnual`, `cashDrawAnnual`, `rothDrawAnnual`, plus `filingStatus`, `householdSize`, `spouseAge`, Social Security amounts and start ages, `otherOrdinaryAnnual`, `taxExemptInterestAnnual`, ACA benchmarks, `stateRatePct`, `state`. `retirementAge`, `endAge`, portfolio assumptions and taxable basis do not change this year's price; the four balances are required by the contract but no prior-year balance is carried in, so no RMD is priced. | Single-year price: income stack, AGI/MAGI, `federalTax`, `stateTax`, `totalTax`, ACA credit, IRMAA, cash left vs spending |
| `retirement_describe_capabilities` | None — takes no inputs | None | `tools` (8 guide entries), `requiredInputsGlobal`, `assumptionsSummary`, `limitations`, `quickStart`, `engine` block |

## Example calls + responses

One full `retirement_calculate` response, trimmed (yearly tables
cut to first/last rows). Fictional household as in the worked
example above, retiring now at 54:

```jsonc
// POST /mcp — {"jsonrpc":"2.0","id":1,"method":"tools/call",
//   "params":{"name":"retirement_calculate","arguments":{...}}}
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [{ "type": "text", "text": "{...envelope below as JSON...}" }],
    "structuredContent": {
      "ok": true,
      "source": "finance-planner-engine",
      "adapterVersion": "assistant-api 0.1.0",
      "apiContractVersion": 163,
      "taxLawYear": 2026,
      "effectiveInputs": {
        "pretax": 1250000, "taxable": 2100000, "roth": 375000, "hsa": 62000,
        "portfolioDollars": 3787000,
        "monthlySpending": 9500, "annualSpending": 114000,
        "currentAge": 54, "spouseAge": 52, "retirementAge": 54, "endAge": 95,
        "filingStatus": "mfj", "householdSize": 2,
        "stocksPct": 95, "expectedRealReturnPct": 6.75, "volatilityPct": 17.4,
        "strategy": "constant",
        "socialSecurityAnnual": 36000, "socialSecurityStartAge": 67,
        "spouseSocialSecurityAnnual": 18000, "spouseSocialSecurityStartAge": 67,
        "taxableBasisPct": 72, "taxableBasisBlank": false,
        "taxYear": 2026, "startYear": 2026, "mcSeed": 12345, "mcRuns": 1000
        // ... every resolved field is echoed here
      },
      "assumptions": [
        { "field": "stocksPct", "value": 95, "provenance": "engine_constant",
          "note": "Engine default stock mix 95% (retirementEngines.ts STOCKS_PCT_DEFAULT)." }
        // ... one entry per resolved field: user / assumption / engine_constant
      ],
      "results": {
        "neverRunsOut": true,
        "endingBalance": 37459082.11,
        "endingAge": 95,
        "yearlyBalances": [
          { "age": 54, "balance": 3787000 },
          "... 41 more rows ...",
          { "age": 96, "balance": 37459082.11 }
        ],
        "strategy": "constant",
        "historicalNeverOutRate": 1,
        "historicalMedianEnding": 34871176.88
      },
      "warnings": [
        "No ACA benchmark provided — ACA premium credits are not modeled (credit $0)."
      ]
    }
  }
}
```

Every successful response has the same envelope: `ok`, `source`
(`"finance-planner-engine"`), `adapterVersion`
(`"assistant-api 0.1.0"`), `apiContractVersion` (`163`),
`taxLawYear`, `effectiveInputs` (the resolved inputs, dollars),
`assumptions` (one entry per field, with provenance), `results`,
`warnings`. `taxLawYear` is the first plan year priced — the
single-year tool reports the year it priced instead, and the
compare tools price each march year under that year's tables
starting from this year (a caller-supplied `taxYear` does not move
a compare march). The sim tools price no tax. A failure is the same envelope shape with `ok: false`
and `error: { code, message, ... }` — see "Security model" for the
codes. The `content[0].text` field carries the same envelope as a
JSON string, for clients that only read text.

> **Terminal row.** `yearlyBalances` runs from `currentAge`
> through `endAge + 1`: the last row is a terminal row at
> `endAge + 1` holding the ending balance (the engine/app
> convention — `endingAge` itself is still `endAge`). The Monte
> Carlo `chart` carries the same terminal row, downsampled to at
> most 41 rows (every Nth row plus the terminal row).

## Input assumptions + defaults

Every resolved field is labelled in `assumptions` with its
provenance: `user` (the caller supplied it), `assumption` (an
adapter convention), or `engine_constant` (a constant from the
engines). The table below is the summary; the response is the
authority for any single call.

| Field | Default when omitted | Provenance |
| --- | --- | --- |
| `pretax`, `taxable`, `roth`, `hsa`, `monthlySpending`, `currentAge` | **Required** — no default (explicit `0` counts) | user |
| `retirementAge` | `currentAge` (retire now) | assumption |
| `endAge` | `95` | engine_constant |
| `filingStatus` | `"mfj"` | assumption |
| `householdSize` | `2` for mfj, `1` for single/hoh | assumption |
| `spouseAge` | **Required when mfj** (missing → `missing_input` + question) | user |
| `stocksPct` | `95` | engine_constant |
| `expectedRealReturnPct` | Engine blend: stocks% × 7% + bonds% × 2% (6.75 at 95% stocks) | engine_constant |
| `volatilityPct` | Engine blend: stocks% × 18% + bonds% × 6% (17.4 at 95% stocks) | engine_constant |
| `strategy` | `"constant"` | assumption |
| `percentOfPortfolio` | `5` — 5% of the start-of-year balance each year (only when `strategy` is `"percent"`) | engine_constant |
| `guardrailsCutPct` / `guardrailsRaisePct` / `guardrailsAdjustmentPct` | `120` / `80` / `10` — cut 10% when the spending rate tops 120% of the starting rate, raise 10% when it falls below 80%, at most one adjustment a year (only when `strategy` is `"guardrails"`) | engine_constant |
| `phaseStartAge` / `phaseDeclinePct` | `75` / `1` — flat until age 75, then −1% a year (only when `strategy` is `"phased"`) | engine_constant |
| `socialSecurityAnnual` / `spouseSocialSecurityAnnual` | `0` (none modeled); a start age is required when the amount is > 0 | assumption |
| `taxableBasisPct` | `100` — blank-basis path, no gains on draws | assumption |
| `taxableDividendYieldPct` / `taxableInterestYieldPct` | `null` (no yield modeled) | assumption |
| `otherOrdinaryAnnual` / `taxExemptInterestAnnual` | `0` | assumption |
| `acaBenchmarkCouple` / `acaBenchmarkSingle` / `acaBenchmarkFamily` | `null` (no credit modeled) + a warning | assumption |
| `state` | Omitted → no state tax. `"WA"`/`"Washington"` → WA excise path (a supplied rate is ignored, with a warning). Other → `stateRatePct` applies. | assumption |
| `stateRatePct` | `0` | assumption |
| `taxYear` | Current calendar year clamped to the latest published law year; only the published law years (2025/2026 today) accepted | assumption |
| `salaryAnnual` | `null` — only the work-years tool needs it | assumption |
| `employer401kAnnual` / `employerHsaAnnual` | `0` | assumption |
| `inflationPct` | `0` — all figures in today's dollars | assumption |
| Single-year fields (`interestAnnual`, `ordinaryDividendsAnnual`, `qualifiedDividendsAnnual`, `conversionAnnual`, `spendingDrawAnnual`, `cashDrawAnnual`, `rothDrawAnnual`) | `0` each | assumption |
| `mcSeed` / `mcRuns` | `12345` / `1000` | engine_constant |
| `compareAges` | `[retirementAge, retirementAge+2, retirementAge+5]` (no assumption entry when omitted) | — |
| Tax-aware extras (not in the input schema) | Spouse's own pre-tax balance `$0`; heir/exit rate `22%` (engine_constant); no pre-tax preserve floor; spouse is the sole beneficiary when mfj (Joint Life Table RMDs); health premiums are **not** priced — only the ACA credit and IRMAA | assumption / engine_constant |

Missing essentials return a structured error, never a guess:

```json
{ "ok": false, "source": "finance-planner-engine",
  "adapterVersion": "assistant-api 0.1.0", "apiContractVersion": 163,
  "error": { "code": "missing_input",
    "message": "Missing required input: spouseAge.",
    "missing": ["spouseAge"],
    "questions": [{ "field": "spouseAge",
      "question": "How old is your spouse?" }] } }
```

Error codes: `missing_input` (a required field is absent — ask the
user the attached question), `invalid_input` (a value fails
validation — the message names the field, never the value),
`unsupported` (the question has no answer for these inputs, e.g. a
tax year outside the published law years, or fewer than two comparable quit ages),
`engine_error` (the engine could not price the scenario; the message
carries no internals).

## Security model

- **Bearer token.** Remote deployments require `ASSISTANT_API_TOKEN`
  on every `/mcp` request (`Authorization: Bearer <token>`),
  compared in constant time. A non-loopback bind without a token
  refuses to boot (exit 1). There is never a default token, and no
  token is committed anywhere — the token comes from the environment
  only. `/health` and `/` are unauthenticated; only `/mcp` needs the
  token.
- **Loopback rule.** No token + loopback host (127.x, ::1,
  localhost) boots with auth **disabled** and a loud stderr warning
  — zero-config local use only. Never bind that mode to a
  non-loopback address.
- **Allowlist of 8 tools only.** `tools/list` returns exactly the 8
  tools in this README. There are no storage, deletion, import, or
  reset tools: `tools/call` of anything else (e.g.
  `delete_backup`, `reset_planner`, `import_transactions`) is
  JSON-RPC `-32602` (unknown tool). The server cannot write, save,
  or change anything — it only prices the scenario it is handed.
- **The adapter never reads the app database, saved records, or the
  sample household.** Every call's figures come from the call itself;
  the import graph is pinned by test (`tests/isolation.test.ts`).
- **Assumptions are labelled.** Every resolved input carries a
  provenance (`user` / `assumption` / `engine_constant`) in the
  response, so an AI can tell the user what was assumed instead of
  what they said.
- **Rate limits.** Expensive tools (Monte Carlo, max spending, the
  three compares) are 20 calls/minute per token; everything else is
  120/minute. Over the limit is HTTP 429 with a `Retry-After`
  header.
- **Body cap.** Request bodies over 256KB are HTTP 413.
- **No personal data in logs.** Request logs carry method, path,
  status, and duration only; tool logs carry the tool name, ok flag,
  and duration. Input values, results, and tokens are never logged.
  Error bodies carry no stack traces or internal paths.
- **Horizon cap.** The server additionally refuses `endAge` over 120.

## Test commands + how to run the suite

From `assistant-api/` (Bun test; the layout mirrors the repo, so the
same commands work when the tests are placed):

```sh
bun test tests/                    # whole suite (~90–120s, mostly the work-years test)
bun test tests/input.test.ts       # input correctness
bun test tests/isolation.test.ts   # sample isolation (highest priority)
bun test tests/parity.test.ts      # engine parity (includes the ~95s work-years leg)
bun test tests/security.test.ts    # auth, allowlist, body cap, log/error hygiene
bun test tests/mcp-interop.test.ts # official-SDK interop (needs the SDK, see below)
bun tests/mcp-client-smoke.ts     # standalone SDK smoke check (see below)
bun x tsc --noEmit -p tsconfig.check.json   # typecheck of src + tests
```

What the suite pins: dollars→cents conversion and monthly→annual
spending; explicit zero vs omitted; invalid values (negative, NaN,
string, `taxYear` 2027, `retirementAge < currentAge`,
`endAge ≤ retirementAge`, > $100,000,000); missing ages/SS details
with questions; `effectiveInputs` echo + provenance on every
resolved field; no `sampleHousehold`/storage import anywhere in the
adapter or engine chain; `$0` and `$99,000,000` extremes pricing
independently; A-then-B-then-A bit-identical; rewriting the sample
module's `SAMPLE_HOUSEHOLD` object mid-test moves nothing;
calculate/MC/blended/single-year parity against direct engine calls
to the cent; success rate as a 0–1 fraction; MC chart in dollars;
the corrected ending-wealth identity
(`endingWealth = endingPretax + endingTaxable + endingRoth +
endingHsa − terminalTax`); Roth deltas as (scenario − baseline);
both work-years branches (salary / no salary); auth 401s; the exact
8-tool allowlist; `-32602` for non-existent tools; the 413 body cap;
log hygiene; error hygiene (no stacks, no paths).

Notes:

- The `@modelcontextprotocol/sdk` is **not** a repo dependency, so
  `mcp-interop.test.ts` skips its functional tests (with a clear
  reason) when the SDK is not resolvable. To run them, make the SDK
  resolvable — e.g. set `MCP_SDK_DIR` to an SDK install:
  `MCP_SDK_DIR=/tmp/mcp-smoke-test/node_modules/@modelcontextprotocol/sdk
  bun test tests/mcp-interop.test.ts`. The same variable drives the
  standalone smoke script (default: that same scratch install).
  Bun does not honour `NODE_PATH`; use `MCP_SDK_DIR`. The SDK
  install at `/tmp/mcp-smoke-test` is missing its root entry
  (`dist/esm/index.js`), so the test and the smoke script import the
  `client/index.js` + `client/streamableHttp.js` subpaths directly.
- MC runs stay ≤ 200 in the tests — except the max-spending solver,
  which always uses the engine's fixed 1,000 runs (default 1000 in
  the product); no joint optimizer runs except the one work-years test.
- The work-years leg **with a spouse Social Security benefit is not
  run by the suite**: it needs substantially more than this VM's
  6 GB (verified OOM, twice). The suite's work-years test uses
  spouse SS $0 only. See "Known limitations" (i).
- Suite timing on this VM: 118 tests, 0 failures; total ~90–150s per
  run (the work-years leg is most of it). Per file: input 34,
  isolation 23, parity 24, schema-consistency 14, security 16,
  mcp-interop 5, cli 2.

## Worked conversation transcripts

Four full examples, in the order a household usually asks them. All
figures are the fictional household (pre-tax $1,250,000; taxable
$2,100,000; Roth $375,000; HSA $62,000; spending $9,500/mo; ages
54/52; Social Security $36,000/yr at 67, spouse $18,000/yr at 67;
taxable basis 72%; end age 95; 2026 law) and were measured from the
live adapter, not invented. Each shows: the user's question → the
exact tool call → the engine's key figures → the plain-English
answer the AI gives.

### (1) "Can I retire now?" → `retirement_calculate`

User question: "Can I retire now? I'm 54."

Tool call:

```json
{
  "name": "retirement_calculate",
  "arguments": {
    "pretax": 1250000, "taxable": 2100000, "roth": 375000, "hsa": 62000,
    "monthlySpending": 9500, "currentAge": 54, "spouseAge": 52,
    "retirementAge": 54, "endAge": 95,
    "socialSecurityAnnual": 36000, "socialSecurityStartAge": 67,
    "spouseSocialSecurityAnnual": 18000, "spouseSocialSecurityStartAge": 67,
    "taxableBasisPct": 72, "taxYear": 2026
  }
}
```

Engine result (key figures): `neverRunsOut: true`, ending balance
$37,459,082.11 at age 95, historical never-out rate 100%
(`historicalNeverOutRate: 1`), historical median ending
$34,871,176.88.

Plain-English answer: "Yes — on these figures, the money lasts to
95. The flat projection ends with about $37.5M, and in every
historical market path since the 1920s it also lasts, with a typical
ending around $34.9M. That's the projection saying yes, not a
guarantee: it assumes $9,500 a month of spending and the returns the
engine blends from your 95% stock mix."

### (2) Monte Carlo to 95 → `retirement_monte_carlo`

User question: "How likely is that to actually work? Give me a
probability, not a yes or no."

Tool call: same household, retiring at 58, `mcRuns: 1000`,
`mcSeed: 42` (the seed makes the run reproducible).

```json
{
  "name": "retirement_monte_carlo",
  "arguments": {
    "pretax": 1250000, "taxable": 2100000, "roth": 375000, "hsa": 62000,
    "monthlySpending": 9500, "currentAge": 54, "spouseAge": 52,
    "retirementAge": 58, "endAge": 95,
    "socialSecurityAnnual": 36000, "socialSecurityStartAge": 67,
    "spouseSocialSecurityAnnual": 18000, "spouseSocialSecurityStartAge": 67,
    "taxableBasisPct": 72, "mcRuns": 1000, "mcSeed": 42, "taxYear": 2026
  }
}
```

Engine result (key figures): `successRate: 0.97`, `endingP10:
$2,929,179.57`, `endingP50: $21,651,743.88`, `endingP90:
$100,031,364.32`, deterministic ending balance $43,901,094.30.

Plain-English answer: "97 out of 100 random market paths last to
95. The middle path ends with about $21.7M; even the weak path
(the 1-in-10 bad one) ends with about $2.9M. The 3 paths in 100 that
fail are the ones where bad returns arrive early, while you're still
spending $9,500 a month."

### (3) "How much can I safely spend?" → `retirement_max_spending`

User question: "I'm spending $9,500 a month now — how much could I
spend in retirement without breaking the plan?"

Tool call: same household, retiring at 58, `mcSeed: 42`. The
solver always runs 1,000 simulations — `mcRuns` is not used for
this tool, and the result reports `runs: 1000` with an
`mcRunsEffective` assumption.

```json
{
  "name": "retirement_max_spending",
  "arguments": {
    "pretax": 1250000, "taxable": 2100000, "roth": 375000, "hsa": 62000,
    "monthlySpending": 9500, "currentAge": 54, "spouseAge": 52,
    "retirementAge": 58, "endAge": 95,
    "socialSecurityAnnual": 36000, "socialSecurityStartAge": 67,
    "spouseSocialSecurityAnnual": 18000, "spouseSocialSecurityStartAge": 67,
    "mcSeed": 42
  }
}
```

Engine result (key figures): `maxMonthlySpending: $14,358.33`,
`maxAnnualSpending: $172,300`, `successRate: 0.85`, `runs: 1000`,
`medianEnding: $13,982,528.25`,
`historicalMaxMonthlySpending: $18,616.67`
(`historicalMaxAnnualSpending: $223,400`).

Plain-English answer: "About $14,358 a month — that's the highest
spending that still succeeds in 85 out of 100 random paths. Your
current $9,500 a month is about two-thirds of that, so there's
roughly $4,858 a month of headroom on this measure. History is
kinder than the random paths: on actual historical markets the
maximum was about $18,617 a month."

### (4) "Retire at 56 or 60" → `retirement_work_years`

User question: "Is it worth working four more years — retiring at
60 instead of 56?"

Tool call: same household, `retirementAge: 56`,
`compareAges: [56, 60]`, `salaryAnnual: 120000`. Note the spouse
Social Security is set to $0 here: the work-years leg with a spouse
benefit needs more than 6 GB (see "Known limitations" (i)), so this
call prices the primary's $36,000 at 67 only.

```json
{
  "name": "retirement_work_years",
  "arguments": {
    "pretax": 1250000, "taxable": 2100000, "roth": 375000, "hsa": 62000,
    "monthlySpending": 9500, "currentAge": 54, "spouseAge": 52,
    "retirementAge": 56, "endAge": 95, "compareAges": [56, 60],
    "salaryAnnual": 120000,
    "socialSecurityAnnual": 36000, "socialSecurityStartAge": 67,
    "spouseSocialSecurityAnnual": 0,
    "taxableBasisPct": 72, "taxYear": 2026
  }
}
```

Engine result (key figures) — Roth-compare leg: retire-56 ending
wealth $35,126,287.19, retire-60 ending wealth $40,779,375.57
(delta +$5,653,088.38); lifetime tax $1,532,899.80 at **both**
ages (an exact tie — net cost $2,671,227.76 both ways). Work-years
leg: quit 56 all-in tax $306,904.83 (salary tax $0, payroll tax $0);
quit 60 all-in tax $530,225.68 (salary tax $53,616.52, payroll tax
$33,736.52 over 4 extra working years); winner by all-in tax:
`retire-56`. Winning strategies: at 56, "Fill to the top of the 24%
bracket, capped at IRMAA Tier 2 · gain harvesting into the 0%
bracket", claiming the primary at 66; at 60, "Fill to the top of the
32% bracket", claiming at 65.

Plain-English answer: "Working to 60 leaves about $5.65M more at
95 — four more years of salary and growth, and four fewer years of
spending. But it isn't free: the work-years measure adds about
$223,000 of tax for the extra working years ($53,617 of salary tax
plus $33,737 of payroll tax, plus the tax on the bigger plan), so
on tax alone, retiring at 56 wins. One caution: the two ending
balances span different horizons, so compare the tax, not the
balances — the adapter says so in its own warning."

## Known limitations

Honest and complete — read before relying on an answer.

(i) **`retirement_work_years` with a spouse Social Security benefit
needs substantially more than 6 GB.** Verified OOM in this VM,
twice, even with only 2 quit ages. Without the spouse benefit it
completes — 2 ages took ~95s on this VM under load (a quiet run
measured ~27s for 3 ages); the suite's work-years test carries a
180s timeout for it). If the household has a spouse
benefit, run the comparison without it and say so, or run it on a
bigger host. The Roth-compare legs are unaffected (they complete
with spouse SS present).

(ii) **Dockerfile not build-tested.** There is no Docker binary in
this VM; `deploy.sh` was syntax-checked only (`bash -n`). The first
real deploy should be watched, not assumed.

(iii) **GET `/mcp` SSE streams are not implemented** (405 —
server-initiated messages unsupported). The endpoint accepts POST
(Streamable HTTP) only.

(iv) **No public endpoint is live yet.** Deployment is the reader's
step; `mcp.json` and `server.json` carry `{host}` / `<YOUR_HOST_HERE>`
placeholders until a deployment exists.

(v) **Clean-checkout verification of `bun run start` is pending the
feature branch.** The server was run from a tree copy, not a fresh
clone.

(vi) **Single-year tax covers the published law years only
(2025/2026 today).** Later tables are not yet published, so
later-year pricing is not available.

(vii) **The deterministic projection models one Social Security
stream (the earliest-starting).** With two streams starting in
different years, the second stream is priced in the tax-aware
compares, not the sim; the response says so in a warning. Two
streams starting the same year sum exactly.

(viii) **Work-years ending balances are not like-for-like across
quit ages** (different horizons — each quit age is priced as its own
plan starting at that quit age with rolled balances). Compare
all-in tax, not ending wealth; the response carries the warning.

(ix) **MCP Registry `server.json` is metadata only, not published,**
and the `{host}` URL is a placeholder until a deployment exists.

(x) **`taxYear` defaults to the current calendar year clamped to
the latest published law year (2026).** The default never names a
year the tables don't cover, and `describe_capabilities` reports
the same derived year. (The accepted set is derived from the
published law tables — when the 2027 tables publish, the schema
accepts 2027 with no code change.)

(xi) **A long call stalls the whole server.** Engine calls run
synchronously in-process with no timeout in v1: while one call
runs — notably `retirement_work_years`, which can take a minute or
more — the server answers nothing else, not even `/health`
(measured 2m36.7s for a health check issued mid-call under load).
A worker thread or timeout is future work; for now, don't rely on
the server answering anything else during a work-years call.

## Source layout

```
assistant-api/
  src/
    server.ts    Streamable HTTP MCP server (Bun.serve, auth, rate limits)
    tools.ts     the 8 tool definitions + dispatchTool
    adapter.ts   NormalizedScenario → engine calls → AdapterResponse
    normalize.ts validation, dollars→cents, defaults, provenance
    schema.ts    zod input schema (the accepting schema)
    types.ts     envelope / assumption / error types + versions
    cli.ts       local CLI + `serve`
  tests/
    helpers.ts            shared fictional household + envelope helpers
    input.test.ts         input correctness
    isolation.test.ts     sample isolation (structural + behavioral)
    parity.test.ts        engine parity (incl. the slow work-years leg)
    security.test.ts      server security over HTTP
    mcp-interop.test.ts   official-SDK interop (skips without the SDK)
    mcp-client-smoke.ts   standalone SDK smoke check
  package.json  (bun run start / bun run test / bun run typecheck)
  tsconfig.json / tsconfig.check.json  (src only / src + tests)
  Dockerfile  deploy.sh  mcp.json  server.json
```
