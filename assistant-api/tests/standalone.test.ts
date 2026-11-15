// standalone.test.ts — tests for the standalone, dependency-free
// bundle (assistant-api/dist/finance-planner-cli.mjs).
//
// What is proven here, and nothing else:
//   - the bundle builds repeatably (byte-identical, from any cwd) and
//     its checksum file matches;
//   - the bundle carries no runtime dependency outside itself (only
//     node:fs / node:fs/promises), no network/Bun/post-Node-20 API,
//     no sample or stored household data, no secrets;
//   - the historical market table is inlined, not read from disk;
//   - the CLI surface (--help, --list, file/stdin, bare describe,
//     usage errors) behaves as the spec says;
//   - all 8 tools return byte-identical results to the direct (bun)
//     CLI path on the same inputs, under the system Node and under a
//     real Node 20 binary;
//   - edge cases (missing inputs, malformed JSON, explicit zeros,
//     oversized input), MC reproducibility, successive-request
//     isolation, JSON-only stdout, no-Bun-on-PATH, and a clean
//     environment holding only the .mjs.
//
// The fixture household is the adapter's fictional one (see
// tests/helpers.ts) — never real figures, never $12,000/mo.
// The work-years legs are minutes of CPU per run and this VM is
// shared and often heavily loaded, so their timeout is generous on
// purpose: a timeout failure under load proves nothing about the
// bundle. The manual parity loops (verify runs) measure the same
// pair at ~2–3 minutes on a quiet VM.

import { describe, test, expect, beforeAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fictionalScenario } from "./helpers";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const ASSISTANT_API_DIR = join(TESTS_DIR, "..");
const REPO_DIR = join(ASSISTANT_API_DIR, "..");
const BUILD_SCRIPT = join(
  ASSISTANT_API_DIR,
  "scripts",
  "build-standalone.mjs",
);
const BUNDLE = join(ASSISTANT_API_DIR, "dist", "finance-planner-cli.mjs");
const CHECKSUM_FILE = `${BUNDLE}.sha256`;

/** The system node binary ("node" on PATH). */
const SYSTEM_NODE = "node";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function run(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string;
    input?: string;
    env?: Record<string, string>;
  } = {},
): { status: number | null; stdout: string; stderr: string } {
  const env = opts.env
    ? { ...process.env, ...opts.env }
    : undefined;
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? REPO_DIR,
    input: opts.input,
    env,
    encoding: "utf8",
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

/** The Node 20 binary for the compatibility leg: NODE20_BIN wins,
 *  then `node20` on PATH, then the system node if it is v20. Null
 *  when no Node 20 is available — the Node 20 tests skip then. */
function node20Path(): string | null {
  const fromEnv = process.env.NODE20_BIN;
  if (fromEnv) return fromEnv;
  const which = run("which", ["node20"]);
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  const version = run(SYSTEM_NODE, ["--version"]).stdout.trim();
  if (version.startsWith("v20.")) return SYSTEM_NODE;
  return null;
}
const NODE20 = node20Path();
const itNode20 = NODE20 ? test : test.skip;

function runBunCli(tool: string, file: string) {
  return run(
    "bun",
    [join(ASSISTANT_API_DIR, "src", "cli.ts"), tool, file],
    { cwd: ASSISTANT_API_DIR },
  );
}

function runBundle(
  node: string,
  tool: string,
  file: string | null,
  opts: { cwd?: string; input?: string; env?: Record<string, string> } = {},
) {
  const args = [BUNDLE, tool];
  if (file !== null) args.push(file);
  return run(node, args, opts);
}

const TOOL_TIMEOUT = 120_000;
// The work-years leg is minutes of CPU per run (the Roth-compare
// marches for each quit age), and this VM is shared and often heavily
// loaded — a bun+node pair took 20 minutes wall-clock at load ~15 on
// 2026-11-14 and timed out the 1,200s budget by 283ms, so the budget
// is 1,800s. The budget is generous on purpose: the test's job is
// byte-identical parity, and a timeout failure under load proves
// nothing about the bundle.
const WORK_YEARS_TIMEOUT = 1_800_000;

const TOOL_NAMES = [
  "retirement_calculate",
  "retirement_monte_carlo",
  "retirement_max_spending",
  "retirement_compare_strategies",
  "retirement_roth_conversion",
  "retirement_work_years",
  "retirement_tax_year",
  "retirement_describe_capabilities",
] as const;

const PARITY_CASES: { tool: string; input: Record<string, unknown> }[] = [
  { tool: "retirement_calculate", input: fictionalScenario() },
  {
    tool: "retirement_monte_carlo",
    input: fictionalScenario({ mcRuns: 500, mcSeed: 42 }),
  },
  {
    tool: "retirement_max_spending",
    input: fictionalScenario({ mcSeed: 7 }),
  },
  { tool: "retirement_compare_strategies", input: fictionalScenario() },
  { tool: "retirement_roth_conversion", input: fictionalScenario() },
  {
    tool: "retirement_work_years",
    input: fictionalScenario({
      compareAges: [58, 60],
      salaryAnnual: 120000,
      employer401kAnnual: 5000,
      employerHsaAnnual: 1000,
      // Spouse SS $0: the work-years leg with a spouse benefit needs
      // more than 6 GB (see README "Known limitations" (i)).
      spouseSocialSecurityAnnual: 0,
    }),
  },
  {
    tool: "retirement_tax_year",
    input: fictionalScenario({
      taxYear: 2026,
      interestAnnual: 1000,
      ordinaryDividendsAnnual: 5000,
      qualifiedDividendsAnnual: 3000,
      conversionAnnual: 20000,
      spendingDrawAnnual: 114000,
      cashDrawAnnual: 0,
      rothDrawAnnual: 0,
    }),
  },
  { tool: "retirement_describe_capabilities", input: {} },
];

function writeParityInputs(): string {
  const dir = mkdtempSync(join(tmpdir(), "standalone-parity-"));
  for (const c of PARITY_CASES) {
    writeFileSync(join(dir, `${c.tool}.json`), JSON.stringify(c.input));
  }
  return dir;
}

let bundleText = "";

beforeAll(() => {
  // Build once for the whole file; the determinism test builds again.
  const build = run(SYSTEM_NODE, [BUILD_SCRIPT], { cwd: ASSISTANT_API_DIR });
  expect(
    build.status,
    `build failed: ${build.stderr}`,
  ).toBe(0);
  expect(existsSync(BUNDLE)).toBe(true);
  bundleText = readFileSync(BUNDLE, "utf8");
  expect(bundleText.length).toBeGreaterThan(0);
});

describe("build: repeatable, deterministic, checksummed", () => {
  test("the checksum file matches the bundle", () => {
    expect(existsSync(CHECKSUM_FILE)).toBe(true);
    const recorded = readFileSync(CHECKSUM_FILE, "utf8").trim();
    expect(recorded).toBe(`${sha256(bundleText)}  finance-planner-cli.mjs`);
  });

  test(
    "building twice produces byte-identical output — from any cwd",
    () => {
      const outDir = mkdtempSync(join(tmpdir(), "standalone-rebuild-"));
      const second = join(outDir, "finance-planner-cli.mjs");
      const build = run(SYSTEM_NODE, [BUILD_SCRIPT, "--out", second], {
        cwd: ASSISTANT_API_DIR,
      });
      expect(build.status, `rebuild failed: ${build.stderr}`).toBe(0);
      const secondText = readFileSync(second, "utf8");
      expect(sha256(secondText)).toBe(sha256(bundleText));
      // And from a completely different working directory: bun writes
      // the bundle's module-path comments relative to its cwd, so the
      // build script must pin it — a build invoked from elsewhere
      // must produce the same bytes, not a different sha256 for
      // identical content.
      const third = join(outDir, "finance-planner-cli-2.mjs");
      const buildFromElsewhere = run(
        SYSTEM_NODE,
        [BUILD_SCRIPT, "--out", third],
        { cwd: outDir },
      );
      expect(
        buildFromElsewhere.status,
        `rebuild from another cwd failed: ${buildFromElsewhere.stderr}`,
      ).toBe(0);
      const thirdText = readFileSync(third, "utf8");
      expect(sha256(thirdText)).toBe(sha256(bundleText));
    },
    60_000,
  );
});

describe("bundle contents: no runtime dependency outside itself", () => {
  test("only node:fs / node:fs/promises are imported", () => {
    const imports = new Set<string>();
    for (const m of bundleText.matchAll(/from\s*["']([^"']+)["']/g)) {
      imports.add(m[1]!);
    }
    for (const m of bundleText.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
      imports.add(m[1]!);
    }
    for (const spec of imports) {
      expect(
        spec,
        `bundle imports ${spec} — it must be self-contained`,
      ).toMatch(/^node:(fs|fs\/promises)$/);
    }
    expect([...imports].sort()).toEqual(["node:fs", "node:fs/promises"]);
  });

  test("no network, Bun, or post-Node-20 API in the bundle", () => {
    for (const marker of [
      // Network.
      "fetch(",
      "XMLHttpRequest",
      "http.request",
      "https.request",
      "net.connect",
      // Bun runtime APIs (the string "Bun." also occurs as
      // sentence-ending prose — "no Bun." — in the help/guide text;
      // only the API names are forbidden here).
      "Bun.serve",
      "Bun.file",
      "Bun.spawn",
      "Bun.$",
      "Bun.build",
      "Bun.sleep",
      // APIs newer than Node 20.
      "Promise.withResolvers",
      "Array.fromAsync",
      "Object.groupBy",
      "Map.groupBy",
      "Symbol.dispose",
      "Symbol.asyncDispose",
    ]) {
      expect(
        bundleText,
        `bundle must not contain ${marker}`,
      ).not.toContain(marker);
    }
    // No bare `bun` import either.
    expect(bundleText).not.toMatch(/from\s*["']bun["']/);
  });

  test("no zod import left behind by the bundler", () => {
    expect(bundleText).not.toContain('from"zod"');
    expect(bundleText).not.toContain("from 'zod'");
    expect(bundleText).not.toContain('require("zod")');
    expect(bundleText).not.toContain("require('zod')");
  });

  test("no sample household / seeding / storage marker", () => {
    for (const marker of [
      "sampleHousehold",
      "samplePlanInputs",
      "seedFirstRun",
      "seedExamples",
      "getRothPlanner",
      "resetRothPlanner",
      "localStorage",
      "sessionStorage",
      "IndexedDB",
      "sampleHousehold.ts",
    ]) {
      expect(
        bundleText,
        `bundle must not contain ${marker}`,
      ).not.toContain(marker);
    }
  });

  test("no secret-looking string in the artifact", () => {
    for (const marker of ["ghp_", "sk-", "AKIA", "ASSISTANT_API_TOKEN="]) {
      expect(
        bundleText,
        `bundle must not contain ${marker}`,
      ).not.toContain(marker);
    }
  });

  test("the historical market table is inlined, not read from disk", () => {
    expect(bundleText).toContain("1928");
    expect(bundleText).toContain("HISTORICAL");
    // The only occurrence of the module name is the bundler's inert
    // `//../server/src/retirementData.ts` path comment — strip
    // comments before asserting the module itself is not referenced.
    const noComments = bundleText.replace(/^\/\/.*$/gm, "");
    expect(noComments).not.toContain("retirementData");
  });
});

describe("CLI surface", () => {
  test("--help names the bundle, Node 20+, and the guides", () => {
    const r = run(SYSTEM_NODE, [BUNDLE, "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("finance-planner-cli.mjs");
    expect(r.stdout).toContain("Node.js 20+");
    expect(r.stdout).toContain("AI_USAGE.md");
    expect(r.stdout).toContain("STANDALONE.md");
    expect(r.stderr).toBe("");
  }, TOOL_TIMEOUT);

  test("--list lists exactly the 8 tools", () => {
    const r = run(SYSTEM_NODE, [BUNDLE, "--list"]);
    expect(r.status).toBe(0);
    const names = r.stdout
      .split("\n")
      .filter((line) => line.startsWith("retirement_"));
    expect(names).toEqual([...TOOL_NAMES]);
  }, TOOL_TIMEOUT);

  test("no arguments is a usage error (exit 1, nothing on stdout)", () => {
    const r = run(SYSTEM_NODE, [BUNDLE]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Usage:");
  }, TOOL_TIMEOUT);

  test("serve is a usage error — the bundle starts no server", () => {
    const r = run(SYSTEM_NODE, [BUNDLE, "serve"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("no server");
  }, TOOL_TIMEOUT);

  test("unknown tool is a usage error (exit 1)", () => {
    const r = run(SYSTEM_NODE, [BUNDLE, "retirement_dance"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("unknown tool");
  }, TOOL_TIMEOUT);

  test("describe_capabilities names the standalone bundle", () => {
    const dir = writeParityInputs();
    const r = runBundle(
      SYSTEM_NODE,
      "retirement_describe_capabilities",
      join(dir, "retirement_describe_capabilities.json"),
    );
    expect(r.status).toBe(0);
    const envelope = JSON.parse(r.stdout);
    expect(envelope.ok).toBe(true);
    const results = JSON.stringify(envelope.results);
    expect(results).toContain("Standalone");
    expect(envelope.results.quickStart.standalone).toContain(
      "finance-planner-cli.mjs",
    );
  }, TOOL_TIMEOUT);

  test("describe_capabilities also runs bare — no file, no stdin (§4/§8)", () => {
    const dir = writeParityInputs();
    const bare = run(SYSTEM_NODE, [BUNDLE, "retirement_describe_capabilities"]);
    expect(bare.status).toBe(0);
    // stderr carries the adapter's one tool-call log line (tool name,
    // ok flag, duration — never inputs or results), not silence.
    expect(bare.stderr).toMatch(
      /^\[assistant-api\] tool=retirement_describe_capabilities ok=true ms=\d+\n$/,
    );
    const fromFile = runBundle(
      SYSTEM_NODE,
      "retirement_describe_capabilities",
      join(dir, "retirement_describe_capabilities.json"),
    );
    expect(bare.stdout).toBe(fromFile.stdout);
    // Any other tool still needs an input source.
    const bareCalc = run(SYSTEM_NODE, [BUNDLE, "retirement_calculate"]);
    expect(bareCalc.status).toBe(1);
    expect(bareCalc.stdout).toBe("");
  }, TOOL_TIMEOUT);
});

describe("parity with the direct (bun) CLI", () => {
  for (const { tool } of PARITY_CASES) {
    const timeout =
      tool === "retirement_work_years" ? WORK_YEARS_TIMEOUT : TOOL_TIMEOUT;
    test(
      `${tool}: byte-identical stdout + exit code (system node)`,
      () => {
        const inputsDir = writeParityInputs();
        const file = join(inputsDir, `${tool}.json`);
        const bun = runBunCli(tool, file);
        const node = runBundle(SYSTEM_NODE, tool, file);
        expect(node.status).toBe(bun.status);
        expect(node.stdout).toBe(bun.stdout);
      },
      timeout,
    );
  }

  for (const { tool } of PARITY_CASES) {
    const timeout =
      tool === "retirement_work_years" ? WORK_YEARS_TIMEOUT : TOOL_TIMEOUT;
    itNode20(
      `${tool}: byte-identical under Node 20`,
      () => {
        const inputsDir = writeParityInputs();
        const file = join(inputsDir, `${tool}.json`);
        const bun = runBunCli(tool, file);
        const node = runBundle(NODE20!, tool, file);
        expect(node.status).toBe(bun.status);
        expect(node.stdout).toBe(bun.stdout);
      },
      timeout,
    );
  }

  test("spec §4 example via stdin (Node 20 when available)", () => {
    const example = {
      pretax: 850000,
      taxable: 650000,
      roth: 200000,
      hsa: 30000,
      monthlySpending: 6000,
      currentAge: 60,
      spouseAge: 58,
      retirementAge: 60,
      endAge: 95,
    };
    const dir = mkdtempSync(join(tmpdir(), "standalone-spec4-"));
    const file = join(dir, "mc.json");
    writeFileSync(file, JSON.stringify(example));
    const bun = run(
      "bun",
      [
        join(ASSISTANT_API_DIR, "src", "cli.ts"),
        "retirement_monte_carlo",
        "--stdin",
      ],
      { cwd: ASSISTANT_API_DIR, input: JSON.stringify(example) },
    );
    const node = run(
      NODE20 ?? SYSTEM_NODE,
      [BUNDLE, "retirement_monte_carlo", "--stdin"],
      {
        cwd: dir,
        input: JSON.stringify(example),
      },
    );
    expect(node.status).toBe(bun.status);
    expect(node.stdout).toBe(bun.stdout);
    const envelope = JSON.parse(node.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.results).toHaveProperty("successRate");
  }, TOOL_TIMEOUT);

  test("missing spouseAge: identical ok:false envelope, exit 2", () => {
    const { spouseAge: _omitted, ...noSpouse } = fictionalScenario();
    const dir = mkdtempSync(join(tmpdir(), "standalone-missing-"));
    const file = join(dir, "calc.json");
    writeFileSync(file, JSON.stringify(noSpouse));
    const bun = runBunCli("retirement_calculate", file);
    const node = runBundle(SYSTEM_NODE, "retirement_calculate", file);
    expect(bun.status).toBe(2);
    expect(node.status).toBe(2);
    expect(node.stdout).toBe(bun.stdout);
    expect(JSON.parse(node.stdout)).toHaveProperty("ok", false);
  }, TOOL_TIMEOUT);

  // P3-M1: each omitted essential must be a `missing_input` envelope
  // (with the `missing` array and plain-language `questions`), byte-
  // identical to the bun CLI — not `invalid_input`. The bundle used
  // to sniff zod's locale-dependent "received undefined" message,
  // which bun's bundler drops, so all six came back `invalid_input`.
  test("each omitted essential: identical missing_input envelope, exit 2", () => {
    const essentials = [
      "pretax",
      "taxable",
      "roth",
      "hsa",
      "monthlySpending",
      "currentAge",
    ] as const;
    for (const key of essentials) {
      const scenario = fictionalScenario();
      delete scenario[key];
      const dir = mkdtempSync(join(tmpdir(), "standalone-missing-"));
      const file = join(dir, "calc.json");
      writeFileSync(file, JSON.stringify(scenario));
      const bun = runBunCli("retirement_calculate", file);
      const node = runBundle(SYSTEM_NODE, "retirement_calculate", file);
      expect(bun.status).toBe(2);
      expect(node.status).toBe(2);
      expect(node.stdout).toBe(bun.stdout);
      const envelope = JSON.parse(node.stdout);
      expect(envelope.ok).toBe(false);
      expect(envelope.error.code).toBe("missing_input");
      expect(envelope.error.missing).toEqual([key]);
      expect(envelope.error.questions).toEqual([
        { field: key, question: expect.any(String) },
      ]);
    }
  }, TOOL_TIMEOUT);

  test("malformed JSON is a usage error (exit 1, silent stdout)", () => {
    const dir = mkdtempSync(join(tmpdir(), "standalone-malformed-"));
    const file = join(dir, "bad.json");
    writeFileSync(file, "{not json");
    const node = runBundle(SYSTEM_NODE, "retirement_calculate", file);
    expect(node.status).toBe(1);
    expect(node.stdout).toBe("");
    expect(node.stderr).toContain("not valid JSON");
  }, TOOL_TIMEOUT);

  test("explicit zeros price sanely (all balances zero)", () => {
    const input = {
      pretax: 0,
      taxable: 0,
      roth: 0,
      hsa: 0,
      monthlySpending: 9500,
      currentAge: 54,
      spouseAge: 52,
      retirementAge: 58,
      endAge: 95,
      taxYear: 2026,
    };
    const dir = mkdtempSync(join(tmpdir(), "standalone-zeros-"));
    const file = join(dir, "calc.json");
    writeFileSync(file, JSON.stringify(input));
    const bun = runBunCli("retirement_calculate", file);
    const node = runBundle(SYSTEM_NODE, "retirement_calculate", file);
    expect(bun.status).toBe(0);
    expect(node.status).toBe(0);
    expect(node.stdout).toBe(bun.stdout);
    const envelope = JSON.parse(node.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.results.neverRunsOut).toBe(false);
  }, TOOL_TIMEOUT);

  test("oversized input is rejected (exit 1, file and stdin)", () => {
    const big = {
      ...fictionalScenario(),
      note: "x".repeat(300 * 1024),
    };
    const dir = mkdtempSync(join(tmpdir(), "standalone-oversized-"));
    const file = join(dir, "big.json");
    writeFileSync(file, JSON.stringify(big));
    const byFile = runBundle(SYSTEM_NODE, "retirement_calculate", file);
    expect(byFile.status).toBe(1);
    expect(byFile.stdout).toBe("");
    expect(byFile.stderr).toContain("256KB");
    const byStdin = run(
      SYSTEM_NODE,
      [BUNDLE, "retirement_calculate", "--stdin"],
      { cwd: dir, input: JSON.stringify(big) },
    );
    expect(byStdin.status).toBe(1);
    expect(byStdin.stdout).toBe("");
    expect(byStdin.stderr).toContain("256KB");
  }, TOOL_TIMEOUT);

  test("Monte Carlo with an identical seed is byte-identical", () => {
    const dir = writeParityInputs();
    const file = join(dir, "retirement_monte_carlo.json");
    const first = runBundle(SYSTEM_NODE, "retirement_monte_carlo", file);
    const second = runBundle(SYSTEM_NODE, "retirement_monte_carlo", file);
    expect(first.status).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    const bun = runBunCli("retirement_monte_carlo", file);
    expect(first.stdout).toBe(bun.stdout);
  }, TOOL_TIMEOUT);

  test("successive requests cannot affect each other (A, B, A)", () => {
    const dir = mkdtempSync(join(tmpdir(), "standalone-aba-"));
    const fileA = join(dir, "a.json");
    const fileB = join(dir, "b.json");
    writeFileSync(fileA, JSON.stringify(fictionalScenario()));
    writeFileSync(
      fileB,
      JSON.stringify(fictionalScenario({ monthlySpending: 6000 })),
    );
    const a1 = runBundle(SYSTEM_NODE, "retirement_calculate", fileA);
    const b = runBundle(SYSTEM_NODE, "retirement_calculate", fileB);
    const a2 = runBundle(SYSTEM_NODE, "retirement_calculate", fileA);
    expect(a1.stdout).not.toBe(b.stdout);
    expect(a2.stdout).toBe(a1.stdout);
  }, TOOL_TIMEOUT);

  test("stdout is exactly one JSON envelope; stderr carries only the one tool-call log line", () => {
    const dir = writeParityInputs();
    const r = runBundle(
      SYSTEM_NODE,
      "retirement_calculate",
      join(dir, "retirement_calculate.json"),
    );
    expect(r.status).toBe(0);
    // The adapter logs one line per call to stderr — tool name, ok
    // flag, duration — and never an input value (the pretax figure
    // must not appear in it).
    expect(r.stderr).toMatch(
      /^\[assistant-api\] tool=retirement_calculate ok=true ms=\d+\n$/,
    );
    expect(r.stderr).not.toContain("1250000");
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    expect(JSON.parse(r.stdout)).toHaveProperty("ok", true);
  }, TOOL_TIMEOUT);
});

describe("sample-data isolation: a sample change cannot move results", () => {
  test(
    "rebuilding from a repo copy with the sample rewritten to $0.01 gives byte-identical results",
    () => {
      const tmp = mkdtempSync(join(tmpdir(), "standalone-mutated-"));
      // Copy only what the build reads: the assistant-api and engine
      // sources, plus the root package.json. node_modules is a
      // symlink — the build resolves zod from the repo root's install.
      // ("junction" keeps the directory symlink working on Windows.)
      cpSync(ASSISTANT_API_DIR, join(tmp, "assistant-api"), {
        recursive: true,
      });
      cpSync(join(REPO_DIR, "server"), join(tmp, "server"), {
        recursive: true,
      });
      copyFileSync(join(REPO_DIR, "package.json"), join(tmp, "package.json"));
      symlinkSync(
        join(REPO_DIR, "node_modules"),
        join(tmp, "node_modules"),
        "junction",
      );

      // Build the unmutated copy first: the reference hash. Both
      // builds run from the SAME tree (same cwd), so the only
      // difference between the two outputs is the mutation itself —
      // the comparison cannot be tripped by build-cwd drift (the
      // build script pins the bundler's cwd, but this proof must not
      // depend on that).
      const outDir = join(tmp, "dist");
      const refOut = join(outDir, "finance-planner-cli-ref.mjs");
      const refBuild = run(
        SYSTEM_NODE,
        [
          join(tmp, "assistant-api", "scripts", "build-standalone.mjs"),
          "--out",
          refOut,
        ],
        { cwd: tmp },
      );
      expect(refBuild.status, `reference build failed: ${refBuild.stderr}`).toBe(0);
      const refBundle = readFileSync(refOut, "utf8");
      // A clean copy reproduces the shipped bundle byte for byte.
      expect(sha256(refBundle)).toBe(sha256(bundleText));

      // Rewrite every sample figure to $0.01 (1 cent): the
      // SAMPLE_*_CENTS consts feed the SAMPLE_HOUSEHOLD object, so
      // this rewrites the whole sample household at once.
      const samplePath = join(tmp, "server", "src", "sampleHousehold.ts");
      const sample = readFileSync(samplePath, "utf8");
      const mutated = sample.replace(
        /^(export const SAMPLE_\w+ = )[\d_]+(;.*)$/gm,
        "$11$2",
      );
      expect(mutated, "the sample mutation must change the file").not.toBe(
        sample,
      );
      expect(mutated).toContain("SAMPLE_PRETAX_CENTS = 1;");
      writeFileSync(samplePath, mutated);

      const mutatedOut = join(outDir, "finance-planner-cli.mjs");
      const build = run(
        SYSTEM_NODE,
        [
          join(tmp, "assistant-api", "scripts", "build-standalone.mjs"),
          "--out",
          mutatedOut,
        ],
        { cwd: tmp },
      );
      expect(build.status, `mutated build failed: ${build.stderr}`).toBe(0);
      const mutatedBundle = readFileSync(mutatedOut, "utf8");
      // The strongest form of the proof: the bundle built from the
      // mutated tree is byte-identical to the one from the unmutated
      // tree — the sample is not embedded anywhere, so changing it
      // changes nothing.
      expect(sha256(mutatedBundle)).toBe(sha256(refBundle));

      // And the mutated bundle prices the fictional household
      // identically, run for run.
      const dir = mkdtempSync(join(tmpdir(), "standalone-mutated-run-"));
      const file = join(dir, "calc.json");
      writeFileSync(file, JSON.stringify(fictionalScenario()));
      const original = runBundle(SYSTEM_NODE, "retirement_calculate", file);
      const fromMutated = run(
        SYSTEM_NODE,
        [mutatedOut, "retirement_calculate", file],
        { cwd: dir },
      );
      expect(fromMutated.status).toBe(0);
      expect(fromMutated.stdout).toBe(original.stdout);
    },
    180_000,
  );
});

describe("clean environment: only the .mjs, no repo, no node_modules, no Bun", () => {
  test(
    "all 8 tools + a stdin calculation, byte-identical to the bun CLI",
    () => {
      const clean = mkdtempSync(join(tmpdir(), "standalone-clean-"));
      copyFileSync(BUNDLE, join(clean, "finance-planner-cli.mjs"));
      const inputsDir = writeParityInputs();
      for (const { tool } of PARITY_CASES) {
        const file = join(inputsDir, `${tool}.json`);
        const bun = runBunCli(tool, file);
        const node = run(
          SYSTEM_NODE,
          [join(clean, "finance-planner-cli.mjs"), tool, file],
          { cwd: clean },
        );
        expect(node.status, `${tool} in clean dir`).toBe(bun.status);
        expect(node.stdout, `${tool} in clean dir`).toBe(bun.stdout);
      }
      // And a stdin calculation in the clean dir.
      const example = {
        pretax: 850000,
        taxable: 650000,
        roth: 200000,
        hsa: 30000,
        monthlySpending: 6000,
        currentAge: 60,
        spouseAge: 58,
        retirementAge: 60,
        endAge: 95,
      };
      const nodeStdin = run(
        SYSTEM_NODE,
        [
          join(clean, "finance-planner-cli.mjs"),
          "retirement_monte_carlo",
          "--stdin",
        ],
        { cwd: clean, input: JSON.stringify(example) },
      );
      expect(nodeStdin.status).toBe(0);
      expect(JSON.parse(nodeStdin.stdout)).toHaveProperty("ok", true);
    },
    WORK_YEARS_TIMEOUT,
  );

  test("the bundle runs with Bun removed from PATH", () => {
    const clean = mkdtempSync(join(tmpdir(), "standalone-nobun-"));
    copyFileSync(BUNDLE, join(clean, "finance-planner-cli.mjs"));
    const dir = writeParityInputs();
    const bunDir = dirname(
      run("which", ["bun"]).stdout.trim(),
    );
    const filteredPath = process.env.PATH!.split(":")
      .filter((p) => p !== bunDir)
      .join(":");
    const env = { ...process.env, PATH: filteredPath };
    const check = spawnSync("which", ["bun"], { env, encoding: "utf8" });
    expect(check.status, "bun must be absent from the filtered PATH").not.toBe(0);
    const r = run(
      SYSTEM_NODE,
      [
        join(clean, "finance-planner-cli.mjs"),
        "retirement_calculate",
        join(dir, "retirement_calculate.json"),
      ],
      { cwd: clean, env: { PATH: filteredPath } },
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toHaveProperty("ok", true);
  }, TOOL_TIMEOUT);

  test("the clean directory holds nothing but the bundle", () => {
    const clean = mkdtempSync(join(tmpdir(), "standalone-cleanonly-"));
    copyFileSync(BUNDLE, join(clean, "finance-planner-cli.mjs"));
    expect(readdirSync(clean)).toEqual(["finance-planner-cli.mjs"]);
    const r = run(
      SYSTEM_NODE,
      [join(clean, "finance-planner-cli.mjs"), "--help"],
      { cwd: clean },
    );
    expect(r.status).toBe(0);
    expect(statSync(join(clean, "finance-planner-cli.mjs")).size).toBeGreaterThan(0);
  }, TOOL_TIMEOUT);
});
