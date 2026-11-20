// standalone-cli.ts — Node-only entry point for the standalone
// Finance Planner bundle (assistant-api/dist/finance-planner-cli.mjs).
//
//   node finance-planner-cli.mjs --help
//   node finance-planner-cli.mjs --list
//   node finance-planner-cli.mjs retirement_describe_capabilities
//   node finance-planner-cli.mjs <tool> [input.json]
//   node finance-planner-cli.mjs <tool> --stdin
//
// A tool call reads JSON from the file argument or stdin, dispatches it
// through the SAME dispatchTool() the MCP server and the bun CLI use,
// and prints the envelope as JSON on stdout. Exit codes: 0 when the
// envelope has ok:true, 2 when it has ok:false (the envelope is still
// printed), 1 on usage errors.
//
// This file starts NO server: the bundle is a calculator, not a
// service. `serve` is a usage error — the MCP server lives in
// src/server.ts and runs under Bun (see assistant-api/README.md).
// Only Node.js standard-library modules are imported here
// (node:fs / node:fs/promises for input reads); everything else is
// bundled, so the generated .mjs runs under plain Node.js 20+ with no
// node_modules, no TypeScript, no Bun, and no network.
//
// Input size: a single input over 256KB is rejected (exit 1) — the
// same cap the MCP server applies to request bodies — so a runaway
// paste cannot blow up the process. The cap is a CLI-surface guard,
// not engine behavior: the engines themselves set no input size.

import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { TOOLS, dispatchTool } from "./tools";
import { enableStandaloneInThreadFallback } from "../../server/src/enginePool";

const USAGE = `finance-planner-cli.mjs — single-file Finance Planner calculator. Needs only Node.js 20+, no server, no install, no network. Full guide: assistant-api/AI_USAGE.md and assistant-api/STANDALONE.md.

Usage:
  node finance-planner-cli.mjs --help                  Show this usage
  node finance-planner-cli.mjs --list                  List tools with one-line descriptions
  node finance-planner-cli.mjs retirement_describe_capabilities   Describe the tools (no input needed)
  node finance-planner-cli.mjs <tool> [input.json]     Call a tool with JSON from a file
  node finance-planner-cli.mjs <tool> --stdin          Call a tool with JSON from stdin

Exit codes: 0 = ok:true envelope, 2 = ok:false envelope, 1 = usage error.
Inputs over 256KB are rejected. No auth is needed; nothing is saved between calls.
`;

// The MCP server's request-body cap, reused here so the standalone CLI
// rejects the same oversized inputs the server would.
const MAX_INPUT_BYTES = 256 * 1024;

function usageError(message: string): never {
  console.error(`error: ${message}\n\n${USAGE}`);
  process.exit(1);
}

async function readStdinCapped(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_INPUT_BYTES) {
      console.error(
        `error: input exceeds the 256KB limit (${total} bytes read)`,
      );
      process.exit(1);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function readFileCapped(file: string): Promise<string> {
  let size: number;
  try {
    size = statSync(file).size;
  } catch (err) {
    console.error(
      `error: could not read input: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
  if (size > MAX_INPUT_BYTES) {
    console.error(
      `error: input exceeds the 256KB limit (${size} bytes)`,
    );
    process.exit(1);
  }
  return readFile(file, "utf8");
}

function main(): void {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    if (argv.length === 0) {
      console.error(USAGE);
      process.exit(1);
    }
    console.log(USAGE);
    process.exit(0);
  }

  if (argv[0] === "--list") {
    for (const t of TOOLS) {
      const firstLine = t.description.split(/(?<=\.)\s/)[0] ?? t.description;
      console.log(`${t.name}\n  ${firstLine}`);
    }
    process.exit(0);
  }

  if (argv[0] === "serve") {
    usageError(
      "the standalone bundle starts no server — run the MCP server with `bun src/server.ts` (or Docker) instead; see assistant-api/README.md",
    );
  }

  const toolName = argv[0];
  if (!TOOLS.some((t) => t.name === toolName)) {
    usageError(
      `unknown tool "${toolName}". Run with --list to see the available tools.`,
    );
  }

  const rest = argv.slice(1);
  const useStdin = rest.includes("--stdin");
  const fileArgs = rest.filter((a) => a !== "--stdin");
  if (useStdin && fileArgs.length > 0) {
    usageError("pass either a JSON file or --stdin, not both");
  }
  // retirement_describe_capabilities takes no inputs, so a bare call
  // runs it with {} — the one tool the spec shows without an input.
  // (The bun CLI requires an input file for every tool; the bundle
  // deliberately does not for this one.) Every other tool still needs
  // exactly one input source.
  if (!useStdin && fileArgs.length === 0) {
    if (toolName === "retirement_describe_capabilities") {
      void runTool(toolName, null, true);
      return;
    }
    usageError(
      `usage: node finance-planner-cli.mjs ${toolName} [input.json] | --stdin`,
    );
  }
  if (!useStdin && fileArgs.length !== 1) {
    usageError(
      `usage: node finance-planner-cli.mjs ${toolName} [input.json] | --stdin`,
    );
  }

  void runTool(toolName, useStdin ? null : fileArgs[0]);
}

async function runTool(
  toolName: string,
  file: string | null,
  bareDescribe = false,
): Promise<void> {
  let args: unknown;
  if (bareDescribe) {
    args = {};
  } else {
    let raw: string;
    try {
      raw =
        file === null ? await readStdinCapped() : await readFileCapped(file);
    } catch (err) {
      console.error(
        `error: could not read input: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
    try {
      args = JSON.parse(raw);
    } catch {
      console.error("error: input is not valid JSON");
      process.exit(1);
    }
  }
  let envelope;
  try {
    // The single-file bundle has no engineWorker.js beside it,
    // so the pool runs engine jobs in-thread instead of in a
    // worker. This is the ONLY call site of
    // enableStandaloneInThreadFallback — the server / MCP paths
    // always use the worker pool. runTool also serves
    // retirement_describe_capabilities, which dispatches no pool
    // job, so enabling the fallback there is harmless.
    enableStandaloneInThreadFallback();
    envelope = await dispatchTool(toolName, args);
  } catch (err) {
    console.error(
      `error: tool failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
  console.log(JSON.stringify(envelope, null, 2));
  process.exit(envelope.ok ? 0 : 2);
}

main();
