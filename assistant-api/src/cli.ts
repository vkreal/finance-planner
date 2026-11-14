// cli.ts — local CLI / test harness for the Finance Planner assistant API.
//
//   bun src/cli.ts --help
//   bun src/cli.ts --list
//   bun src/cli.ts <tool> [input.json]
//   bun src/cli.ts <tool> --stdin
//   bun src/cli.ts serve [--port N]
//
// A tool call reads JSON from the file argument or stdin, dispatches it and
// prints the envelope as pretty JSON on stdout. Exit codes: 0 when the
// envelope has ok:true, 2 when it has ok:false (the envelope is still
// printed), 1 on usage errors. No auth is needed: this is a local process.
// `serve` starts the MCP server. It needs ASSISTANT_API_TOKEN only when
// binding a non-loopback host; on localhost (the default) it boots with
// auth disabled and a loud warning — see server.ts for the rule.

import { readFile } from "node:fs/promises";
import { createServer, DEFAULT_HOST, DEFAULT_PORT } from "./server";
import { TOOLS, dispatchTool } from "./tools";

const USAGE = `finance-planner-assistant-api CLI (v0.1.0)

Usage:
  bun src/cli.ts --help                  Show this usage
  bun src/cli.ts --list                  List tools with one-line descriptions
  bun src/cli.ts <tool> [input.json]     Call a tool with JSON from a file
  bun src/cli.ts <tool> --stdin          Call a tool with JSON from stdin
  bun src/cli.ts serve [--port N] [--host H]   Start the MCP server (default http://127.0.0.1:8080, no token needed on localhost; a non-loopback host requires ASSISTANT_API_TOKEN)

Exit codes: 0 = ok:true envelope, 2 = ok:false envelope, 1 = usage error.
No auth is needed for local tool calls; serve needs ASSISTANT_API_TOKEN only off localhost.
`;

function usageError(message: string): never {
  console.error(`error: ${message}\n\n${USAGE}`);
  process.exit(1);
}

async function readStdin(): Promise<string> {
  let out = "";
  for await (const chunk of process.stdin) {
    out += chunk;
  }
  return out;
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
    let port = Number(process.env.PORT ?? DEFAULT_PORT);
    let host = process.env.HOST ?? DEFAULT_HOST;
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === "--port") {
        const n = Number(argv[i + 1]);
        if (!Number.isInteger(n) || n <= 0 || n > 65535) {
          usageError(`--port expects a port number, got "${argv[i + 1] ?? ""}"`);
        }
        port = n;
        i++;
      } else if (argv[i] === "--host") {
        if (argv[i + 1] === undefined || argv[i + 1].length === 0) {
          usageError(`--host expects a hostname, got "${argv[i + 1] ?? ""}"`);
        }
        host = argv[i + 1];
        i++;
      } else {
        usageError(`unknown serve option "${argv[i]}"`);
      }
    }
    let server;
    try {
      server = createServer({ port, host });
    } catch (err) {
      console.error(
        `error: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
    console.log(
      `[assistant-api] finance-planner-assistant-api v0.1.0 listening on http://${server.hostname}:${server.port} (POST /mcp)`,
    );
    return;
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
  if (!useStdin && fileArgs.length !== 1) {
    usageError(`usage: bun src/cli.ts ${toolName} [input.json] | --stdin`);
  }

  void runTool(toolName, useStdin ? null : fileArgs[0]);
}

async function runTool(toolName: string, file: string | null): Promise<void> {
  let raw: string;
  try {
    raw = file === null ? await readStdin() : await readFile(file, "utf8");
  } catch (err) {
    console.error(
      `error: could not read input: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
  let args: unknown;
  try {
    args = JSON.parse(raw);
  } catch {
    console.error("error: input is not valid JSON");
    process.exit(1);
  }
  let envelope;
  try {
    envelope = dispatchTool(toolName, args);
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
