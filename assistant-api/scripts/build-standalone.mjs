// build-standalone.mjs — build the portable, dependency-free bundle.
//
//   node assistant-api/scripts/build-standalone.mjs [--out <path>]
//
// Builds assistant-api/dist/finance-planner-cli.mjs from
// assistant-api/src/standalone-cli.ts with `bun build`
// (--target=node --format=esm), inlining every runtime dependency
// (zod, the Finance Planner engines) so the output runs under plain
// Node.js 20+ with no node_modules, no TypeScript, no Bun, no
// network, and no config at runtime.
//
// Bun is a BUILD-TIME dependency only (the spec allows it). The
// script itself runs under plain Node.js and works from any cwd:
// all paths resolve from this file's location.
//
// Output: <repo>/assistant-api/dist/finance-planner-cli.mjs by
// default (override with --out), plus a <basename>.sha256 checksum
// file next to it (sha256sum format: "<sha256>  <basename>"). Prints
// the byte size and sha256. The .sha256 file is the release
// checksum artifact (see STANDALONE.md §"Distribution").

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const ASSISTANT_API_DIR = resolve(SCRIPTS_DIR, "..");
const ENTRY = join(ASSISTANT_API_DIR, "src", "standalone-cli.ts");
const DEFAULT_OUT = join(ASSISTANT_API_DIR, "dist", "finance-planner-cli.mjs");

function fail(message) {
  console.error(`build-standalone: error: ${message}`);
  process.exit(1);
}

function parseOut(argv) {
  const idx = argv.indexOf("--out");
  if (idx === -1) return DEFAULT_OUT;
  const value = argv[idx + 1];
  if (value === undefined || value.length === 0) {
    fail("--out expects an output path");
  }
  if (argv.slice(idx + 2).some((a) => a === "--out")) {
    fail("pass --out only once");
  }
  return resolve(value);
}

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--out") {
    i++; // skip the value
  } else if (a.startsWith("--")) {
    fail(`unknown option "${a}" (only --out <path> is supported)`);
  } else {
    fail(`unexpected argument "${a}" (only --out <path> is supported)`);
  }
}
const OUT = parseOut(args);

// Bun must exist: it is the build-time bundler.
const bunCheck = spawnSync("bun", ["--version"], { encoding: "utf8" });
if (bunCheck.error || bunCheck.status !== 0) {
  fail(
    "bun is required at build time (it is the bundler) but was not found on PATH. Install Bun, then re-run this script. The generated bundle itself does not need Bun.",
  );
}
console.log(`build-standalone: bun ${bunCheck.stdout.trim()} — building…`);

mkdirSync(dirname(OUT), { recursive: true });

// Pin the bundler's cwd: bun writes the module-path comments in the
// bundle relative to its own cwd, so an unpinned cwd makes the bundle
// bytes depend on where the build was invoked from — a build run from
// a repo copy produced "// assistant-api/src/standalone-cli.ts" where
// the canonical build has "// src/standalone-cli.ts", a different
// sha256 for identical content. The script already resolves every
// path from its own location; pinning the child cwd makes the
// *output* cwd-independent too, so the bundle is byte-identical
// regardless of the caller's cwd.
const build = spawnSync(
  "bun",
  [
    "build",
    ENTRY,
    "--target=node",
    "--format=esm",
    `--outfile=${OUT}`,
  ],
  { stdio: "inherit", cwd: ASSISTANT_API_DIR },
);
if (build.error) {
  fail(`failed to run bun build: ${build.error.message}`);
}
if (build.status !== 0) {
  fail(`bun build exited with code ${build.status}`);
}

// Post-checks on the generated file: it must exist, be non-empty,
// and carry no external runtime dependency or forbidden marker.
// (The full assertions live in tests/standalone.test.ts; these are
// the build's own tripwires so a bad bundle never ships quietly.)
let text;
try {
  const stat = statSync(OUT);
  if (stat.size === 0) fail(`generated bundle is empty: ${OUT}`);
  text = readFileSync(OUT, "utf8");
} catch (err) {
  fail(`cannot read generated bundle ${OUT}: ${err.message}`);
}

const FORBIDDEN = [
  // An external zod import would mean the bundler left a runtime
  // dependency behind (the bundle must inline it).
  'from"zod"',
  "from 'zod'",
  'require("zod")',
  "require('zod')",
  // Sample / stored household data must never be in the bundle.
  "sampleHousehold",
  "samplePlanInputs",
  "seedFirstRun",
  "seedExamples",
  "getRothPlanner",
  "resetRothPlanner",
  "localStorage",
  // No Bun server API — the bundle starts no server.
  "Bun.serve",
  "Bun.file",
  // No network, no database.
  "fetch(",
  "XMLHttpRequest",
  "sqlite",
  "IndexedDB",
];
for (const marker of FORBIDDEN) {
  if (text.includes(marker)) {
    fail(`generated bundle contains forbidden marker ${JSON.stringify(marker)}`);
  }
}

// Strip the bundler's module-path comments (AFTER the tripwires
// above, so they see the unstripped text): bun annotates each
// bundled module with a `// <relative path>` line, and for modules
// outside the repo tree (zod, resolved via the repo's node_modules)
// that path is relative to the checkout's absolute location — so two
// builds from different checkout paths differ in those lines alone
// (17 lines: every zod file) and hash differently for identical
// code. The comments are inert (bun's own module separators, and the
// only `//` lines in the output), so removing them makes the bundle
// byte-identical regardless of where the tree lives. Only lines that
// are a lone `//` followed by a file path are removed; nothing else
// in the bundle is touched. The stripped text is written back before
// the hash is computed, so the checksum matches the shipped file.
const stripped = text.replace(/^\/\/[^\n]*\.(?:ts|js|mjs)\n/gm, "");
if (stripped !== text) {
  writeFileSync(OUT, stripped);
  text = stripped;
}

const hash = createHash("sha256").update(text).digest("hex");
const size = statSync(OUT).size;
writeFileSync(`${OUT}.sha256`, `${hash}  ${basename(OUT)}\n`);
console.log(`build-standalone: wrote ${OUT}`);
console.log(`build-standalone: wrote ${OUT}.sha256`);
console.log(`build-standalone: ${size} bytes, sha256 ${hash}`);
