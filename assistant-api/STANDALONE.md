# Finance Planner — Standalone Bundle

A single-file, dependency-free calculator that runs the Finance
Planner's retirement engines under plain Node.js — no MCP server, no
hosting, no install, no network, no database.

The file is `assistant-api/dist/finance-planner-cli.mjs`
(506,733 bytes, sha256
`dc0dcfa153bf864e4c088b3a05fb48cde3bda5ff5e50b1957bbe81e3af497744`),
built from source commit `19ea743` (main at the Review 6 merge; the
bundle commit also carries the Review 2 5%-default and two-stream-SS
fixes). Size and hash change with every rebuild from a new source
commit — verify the copy you hold with the `.sha256` file next to it,
not with the numbers in this paragraph.
It calls the same `dispatchTool()` the MCP server and the bun CLI
use, with the same validation, normalization, assumptions, engines,
and output envelopes. The only difference is the entry point: this
one reads a JSON file or stdin and prints JSON on stdout.

## Distribution

`dist/` **is committed** to the repo (force-added — the directory is
gitignored) so the bundle is downloadable from the repo itself.
GitHub Releases are the distribution channel: when a release is cut,
the bundle ships as a release artifact alongside its `.sha256`
checksum file, under the stable filename
`finance-planner-cli.mjs`. No release has been published yet; until
the first release, the committed copy in `dist/` is the live path.

### How to publish a release (maintainer step — no release exists yet)

1. Pick the source commit the bundle was built from and record it in
   the release notes (immutable reference, e.g. `19ea743` plus the
   bundle commit). Rebuild from that exact commit if the committed
   copy is not already byte-identical to a fresh build from it.
2. Tag the commit, e.g. `git tag -a standalone-v0.1.0 -m "Standalone
   bundle, built from <commit>"` and push the tag.
3. Create a GitHub Release from the tag and attach exactly two files:
   `assistant-api/dist/finance-planner-cli.mjs` and
   `assistant-api/dist/finance-planner-cli.mjs.sha256`, under the
   stable filename `finance-planner-cli.mjs`.
4. Record in the release notes the sha256 from the `.sha256` file and
   the source commit it was built from, so any holder can rebuild and
   compare hashes. Do not attach any other file, and never attach
   `server.json` or any household data.
5. Versioning is by tag; a later source commit gets a new tag and a
   new release — old releases stay immutable.

## Node versions

Node.js **20 or newer**. Verified by execution (not just static
analysis) under Node 20.19.5 and the system Node 24.22.1. The bundle
uses no API newer than Node 20.

## How to run calculations

```bash
node finance-planner-cli.mjs --help
node finance-planner-cli.mjs --list
node finance-planner-cli.mjs retirement_describe_capabilities
node finance-planner-cli.mjs retirement_calculate input.json
node finance-planner-cli.mjs retirement_monte_carlo --stdin
```

`input.json` is one JSON object with the scenario. Exactly one JSON
response is printed on stdout per call — no banners, warnings, or
logs on stdout (diagnostics go to stderr, and never echo input
values). Each call also writes one log line to stderr
(`[assistant-api] tool=<name> ok=<bool> ms=<n>`) — tool name, ok flag,
and duration only; input values, results, and tokens are never logged.
The bundle works from any working directory; it reads only
the input file/stdin you hand it.

Exit codes: `0` = the calculation succeeded (`ok: true`), `2` = the
calculation failed or inputs are missing (`ok: false`, still printed
— read its `error`), `1` = usage error (bad command, unreadable
input, invalid JSON, input over 256KB).

Inputs over **256KB** are rejected (exit 1, stderr message, empty
stdout) — the same cap the MCP server applies to request bodies. The
cap is a CLI-surface guard, not engine behavior: the engines
themselves set no input size. (The bun CLI has no cap, so a >256KB
input succeeds there and fails in the bundle — an intentional
CLI-surface difference.)

`retirement_describe_capabilities` needs no input: a bare call runs
it with `{}`. Every other tool needs a JSON file or `--stdin`.
`serve` is a usage error — the bundle starts no server; run the MCP
server with `bun src/server.ts` (or Docker) instead.

## The eight tools

| Tool | What it answers |
| --- | --- |
| `retirement_calculate` | Can the money last? Ending balance + year-by-year table + historical cross-check. |
| `retirement_monte_carlo` | How likely is the plan to succeed? Success probability + distribution. Portfolio-only (no taxes) — never present it as a tax-aware projection. |
| `retirement_max_spending` | Highest sustainable monthly spending at 85% Monte Carlo success. |
| `retirement_compare_strategies` | Which account to spend from first? Taxable-first vs pretax-first vs roth-first, tax-aware. |
| `retirement_roth_conversion` | Convert or not? Do Nothing vs Fill 12% vs Fill 22% vs Fill 22% capped at IRMAA Tier 1, tax-aware. |
| `retirement_work_years` | Is working longer worth it? Retiring at each age in `compareAges`, tax-aware; with `salaryAnnual` it also prices the earned-income leg. |
| `retirement_tax_year` | The tax bill for one specific year. |
| `retirement_describe_capabilities` | The machine-readable guide: every tool, its inputs, example calls, assumptions, limitations. No calculation. |

Full input/output field lists live in `retirement_describe_capabilities`
(call it first) and in `assistant-api/README.md`.

## Input schema

Every financial call carries its **complete scenario** — nothing is
saved between calls, and nothing is filled in from sample or saved
household data. The six essential inputs (omitting any one is a
`missing_input` error, exit 2): `pretax`, `taxable`, `roth`, `hsa`,
`monthlySpending`, `currentAge` (all dollars, whole years), plus
`spouseAge` for married households — married filing jointly (the
default) requires it; single filers do not need it. An explicitly
entered zero is valid for the four balances; `monthlySpending` must
be over $0. Unknown fields are rejected with `invalid_input` naming
the key (the validator is a strict schema — double-check spelling).

Optional inputs include `retirementAge` (defaults to your current
age — retire now), `endAge` (defaults to 95),
`socialSecurityAnnual` + `socialSecurityStartAge`,
`spouseSocialSecurityAnnual` + `spouseSocialSecurityStartAge`,
`taxableBasisPct`, `taxYear`, and per-tool options (`mcRuns`,
`mcSeed`, `compareAges`, `salaryAnnual`, …). The response's
`effectiveInputs` echoes exactly what was priced, and `assumptions`
names every default and engine constant used.

## Output schema

Every call returns one JSON envelope:

```json
{
  "ok": true,
  "source": "finance-planner-engine",
  "adapterVersion": "assistant-api 0.1.0",
  "apiContractVersion": 163,
  "taxLawYear": 2026,
  "effectiveInputs": { "...": "what was priced" },
  "assumptions": [ { "field": "…", "value": "…", "provenance": "…" } ],
  "results": { "...": "the priced answer" }
}
```

`ok: false` envelopes carry an `error` object (`code`, `message`,
and any missing-input `details`) instead of `results`. Units: dollars
throughout, ages in whole years, percents as numbers (5 = 5%).
Results are rounded to cents (2dp) by the adapter. Account buckets
stay distinct (pre-tax / taxable / Roth / HSA / cash / 529 /
non-taxable) — the response never merges them.

## Assumptions and default behavior

- All money is dollars, ages are whole years, percents are numbers.
- Every financial call carries its complete scenario; nothing is saved.
- Missing optional fields fall back to documented defaults inside
  the normalizer: `retirementAge` defaults to the current age,
  `endAge` to 95, Social Security to none.
- Pricing uses the latest published tax-law tables (the envelope
  names the year); earlier law years are available via `taxYear`.
- Each tool prices only the inputs its engine reads; a field outside
  that tool's list is accepted but has no effect on that tool's
  answer (notably `mcRuns` for max-spending, which always solves at
  the engine's fixed 1,000 runs).
- Monte Carlo runs are capped at 5,000 simulations per call; the
  planning horizon ends at age 120.
- The work-years comparison can take a minute or more; it runs to
  completion in-process with no preemption.
- Results are planning estimates from the Finance Planner engines,
  not tax advice.

## Limitations

- Tax law years 2025–2026 only. Later tables are not yet published,
  so later-year pricing is not available.
- `retirement_work_years` with a spouse Social Security benefit
  needs more than 6 GB of memory; the test suite pins the
  spouse-benefit field to $0 for that tool. Other tools are
  unaffected.
- The bundle is deterministic for a fixed input except Monte Carlo
  with no seed (pass `mcSeed` for reproducible runs).
- The bundle never reads sample household records, browser storage,
  saved inputs, Net Worth snapshots, settings, or databases — it
  reads only the input file/stdin you hand it. Changing the
  repository's sample household cannot change its results (proven by
  the mutation-rebuild test in `tests/standalone.test.ts`).

## Security and privacy

- The bundle contains no credentials, tokens, or private data. It
  makes no network calls and reads no files besides the input.
- Keep inputs private and do not commit actual household data.
- The bundle is third-party code: an AI must not execute it unless
  its environment permits executing third-party code. If it cannot
  execute code, it should say so rather than invent results.

## How to build it

```bash
cd assistant-api
bun run build:standalone
```

That runs `bun build --target=node --format=esm` over
`src/standalone-cli.ts`, inlining every runtime dependency (zod, the
Finance Planner engines, historical market data), and writes
`dist/finance-planner-cli.mjs` plus `dist/finance-planner-cli.mjs.sha256`,
printing the path, byte size, and sha256. The build fails if a
forbidden marker (external zod import, sample/storage markers, Bun
server API) appears in the output. The build is deterministic:
building twice from the same tree produces byte-identical output
(pinned by `tests/standalone.test.ts`), from any working directory —
the build script pins the bundler's own working directory, and strips
the bundler's module-path comments (which are relative to the
checkout's absolute location for external deps like zod), so a build
invoked from elsewhere — or from a different checkout of the same
tree — still produces the same bytes and the same sha256.

Build-time requirements: Bun (the bundler) and the repo's
`node_modules` (for zod). Runtime requirements: Node.js 20+ only.

## How to verify a bundle checksum

```bash
sha256sum -c finance-planner-cli.mjs.sha256
# finance-planner-cli.mjs: OK
```

The `.sha256` file holds one line in `sha256sum` format
(`<sha256>  finance-planner-cli.mjs`). It is committed next to the
bundle and ships with every release.

## How an AI assistant can use it without MCP

See `assistant-api/AI_USAGE.md` — the primary hint file for an AI
that just found the bundle: the one-command run, the complete-inputs
rule, the "don't invent results" rule, and a worked example. The
`llms.txt` file at the repo root points at both this file and
`AI_USAGE.md`.

## Verification

- Typecheck clean on both tsconfigs (`bun run typecheck` in
  `assistant-api/`).
- Full adapter suite green (`bun test tests/`), including
  `tests/standalone.test.ts`.
- Parity: all 8 tools byte-identical to the direct (bun) CLI path on
  the same inputs, under the system Node and under Node 20.19.5
  (per-tool tests in `tests/standalone.test.ts`).
- Sample isolation: rebuilding from a repo copy with every sample
  figure rewritten to $0.01 gives a byte-identical bundle, and that
  bundle prices the fictional household identically.
- Clean environment: copying only the `.mjs` to an empty directory
  (no repo source, no `node_modules`, no Bun on PATH) runs all 8
  tools plus a stdin calculation, byte-identical to the bun CLI.
- Scrub: zero matches over every added file and the added lines of
  every changed file. The bundle itself carries exactly four
  matches of one bare five-digit figure — the Lifetime Learning
  Credit phaseout start for single and head-of-household filers in
  the engine's tax-law tables (2025 and 2026 rows), a public IRS
  constant already committed in `server/src/taxLaw.ts` and inlined
  by the bundler as the spec requires — NOT a household figure.

## Source layout

- `src/standalone-cli.ts` — the Node-only entry point (mirrors
  `src/cli.ts`, minus `serve`, plus the bare-describe call and the
  256KB input cap).
- `scripts/build-standalone.mjs` — the build script.
- `tests/standalone.test.ts` — the standalone test suite.
- `dist/finance-planner-cli.mjs` (+ `.sha256`) — the generated bundle.
- `STANDALONE.md` (this file) — the reference. `AI_USAGE.md` — the
  AI-facing guide.
