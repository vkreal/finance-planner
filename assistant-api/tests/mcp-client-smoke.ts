// mcp-client-smoke.ts — standalone MCP smoke check for the adapter.
//
// Boots the server in-process, connects the OFFICIAL
// @modelcontextprotocol/sdk client, and calls
// retirement_describe_capabilities + retirement_calculate. Prints one
// line per call and exits 0 when both return ok:true, 1 otherwise.
//
// Run it from the repo root:
//
//   bun assistant-api/tests/mcp-client-smoke.ts
//
// The SDK is not a repo dependency, so the script resolves it from
// the directory named by MCP_SDK_DIR (default: the scratch install
// at /tmp/mcp-smoke-test/node_modules/@modelcontextprotocol/sdk).
// To point at a different SDK install:
//
//   MCP_SDK_DIR=/path/to/node_modules/@modelcontextprotocol/sdk \
//     bun assistant-api/tests/mcp-client-smoke.ts
//
// NOTE: Bun does not honour NODE_PATH, so setting NODE_PATH does not
// make the SDK resolvable — use MCP_SDK_DIR (or run `bun install`
// @modelcontextprotocol/sdk into the repo and import it by bare
// specifier instead). The server port comes from PORT (default: a
// random free port); the token from ASSISTANT_API_TOKEN (default: a
// throwaway smoke-test token, localhost only).

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "../src/server";

const SDK_DIR =
  process.env.MCP_SDK_DIR ??
  "/tmp/mcp-smoke-test/node_modules/@modelcontextprotocol/sdk";
const TOKEN = process.env.ASSISTANT_API_TOKEN ?? "smoke-test-token";
const PORT = process.env.PORT ? Number(process.env.PORT) : 0;

async function main(): Promise<number> {
  let Client: new (
    info: { name: string; version: string },
    options: Record<string, unknown>,
  ) => {
    connect: (t: unknown) => Promise<void>;
    listTools: () => Promise<{ tools: Array<{ name: string }> }>;
    callTool: (p: {
      name: string;
      arguments?: Record<string, unknown>;
    }) => Promise<{ structuredContent?: Record<string, unknown> }>;
    close: () => Promise<void>;
  };
  let StreamableHTTPClientTransport: new (
    url: URL,
    options?: Record<string, unknown>,
  ) => unknown;
  try {
    const clientMod = (await import(
      pathToFileURL(join(SDK_DIR, "dist/esm/client/index.js")).href
    )) as { Client: typeof Client };
    const transportMod = (await import(
      pathToFileURL(join(SDK_DIR, "dist/esm/client/streamableHttp.js")).href
    )) as { StreamableHTTPClientTransport: typeof StreamableHTTPClientTransport };
    Client = clientMod.Client;
    StreamableHTTPClientTransport = transportMod.StreamableHTTPClientTransport;
  } catch (err) {
    console.error(
      `error: could not load @modelcontextprotocol/sdk from ${SDK_DIR}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    console.error("Set MCP_SDK_DIR to an SDK install and re-run.");
    return 1;
  }

  const server = createServer({ port: PORT, token: TOKEN });
  const url = `http://127.0.0.1:${server.port}/mcp`;
  const client = new Client(
    { name: "assistant-api-mcp-smoke", version: "0.1.0" },
    { capabilities: {} },
  );
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }),
    );
    const { tools } = await client.listTools();
    console.log(
      `tools/list: ${tools.length} tools (${tools.map((t) => t.name).join(", ")})`,
    );

    // Fictional household only (see tests/helpers.ts for the figures).
    const args = {
      pretax: 1250000,
      taxable: 2100000,
      roth: 375000,
      hsa: 62000,
      monthlySpending: 9500,
      currentAge: 54,
      spouseAge: 52,
      retirementAge: 58,
      endAge: 95,
      socialSecurityAnnual: 36000,
      socialSecurityStartAge: 67,
      spouseSocialSecurityAnnual: 18000,
      spouseSocialSecurityStartAge: 67,
      taxableBasisPct: 72,
      taxYear: 2026,
    };
    const describe = await client.callTool({
      name: "retirement_describe_capabilities",
      arguments: {},
    });
    console.log(
      `retirement_describe_capabilities: ok=${describe.structuredContent?.ok}`,
    );
    const calc = await client.callTool({
      name: "retirement_calculate",
      arguments: args,
    });
    const results = calc.structuredContent?.results as
      | { neverRunsOut: boolean; endingBalance: number }
      | undefined;
    console.log(
      `retirement_calculate: ok=${calc.structuredContent?.ok} ` +
        `neverRunsOut=${results?.neverRunsOut} ` +
        `endingBalance=$${results?.endingBalance?.toLocaleString("en-US")}`,
    );
    return calc.structuredContent?.ok === true &&
      describe.structuredContent?.ok === true
      ? 0
      : 1;
  } catch (err) {
    console.error(
      `error: smoke check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  } finally {
    await client.close();
    server.stop();
  }
}

process.exit(await main());
