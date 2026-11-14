// mcp-interop.test.ts — AI interoperability via the OFFICIAL MCP SDK.
//
// Boots the server in-process and drives it with a real
// @modelcontextprotocol/sdk client (StreamableHTTPClientTransport),
// the way an AI client would. The SDK is not a repo dependency — it
// lives in scratch (/tmp/mcp-smoke-test) — so the import is dynamic
// with fallbacks: bare specifier first, then the SDK directory named
// by MCP_SDK_DIR (default /tmp/mcp-smoke-test/node_modules/
// @modelcontextprotocol/sdk). If no import path resolves, every
// functional test in this file is skipped with that reason instead
// of failing; see README "Test commands" for how to make the SDK
// resolvable.
//
// NOTE on schemas: the seven financial tools carry a `required`
// array with the six essential keys. retirement_describe_capabilities
// takes no inputs, so its schema carries no `required` array at all —
// the test pins that split rather than demanding `required` on all 8.

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "../src/server";
import { FICTIONAL } from "./helpers";

const TOKEN = "test-token-assistant-api-mcp";

const SDK_DIR =
  process.env.MCP_SDK_DIR ??
  "/tmp/mcp-smoke-test/node_modules/@modelcontextprotocol/sdk";

type SdkClientCtor = new (
  info: { name: string; version: string },
  options: Record<string, unknown>,
) => {
  connect: (transport: unknown) => Promise<void>;
  listTools: () => Promise<{ tools: Array<Record<string, unknown>> }>;
  callTool: (params: {
    name: string;
    arguments?: Record<string, unknown>;
  }) => Promise<{
    content?: unknown;
    structuredContent?: Record<string, unknown>;
  }>;
  close: () => Promise<void>;
};

type SdkTransportCtor = new (
  url: URL,
  options?: Record<string, unknown>,
) => unknown;

async function loadSdk(): Promise<{
  Client: SdkClientCtor;
  StreamableHTTPClientTransport: SdkTransportCtor;
} | null> {
  // 1. Bare specifier (works when the SDK is installed alongside
  //    the repo, e.g. via the scratch node_modules symlink).
  try {
    // @ts-ignore — optional test-only dependency; tsc cannot resolve
    // it in a checkout without the SDK installed, and the try/catch
    // below falls back to the explicit SDK directory.
    const clientMod = (await import("@modelcontextprotocol/sdk/client/index.js")) as { Client: SdkClientCtor };
    // @ts-ignore — same optional-dependency note as above.
    const transportMod = (await import("@modelcontextprotocol/sdk/client/streamableHttp.js")) as {
      StreamableHTTPClientTransport: SdkTransportCtor;
    };
    if (
      typeof clientMod.Client === "function" &&
      typeof transportMod.StreamableHTTPClientTransport === "function"
    ) {
      return {
        Client: clientMod.Client,
        StreamableHTTPClientTransport:
          transportMod.StreamableHTTPClientTransport,
      };
    }
  } catch {
    // Fall through to the explicit SDK directory.
  }
  // 2. Explicit SDK directory (the coordinator runs this file with
  //    the SDK from /tmp/mcp-smoke-test). The package root entry
  //    (dist/esm/index.js) is missing from that install, so the
  //    client + transport subpaths are imported directly.
  try {
    const clientUrl = pathToFileURL(
      join(SDK_DIR, "dist/esm/client/index.js"),
    ).href;
    const transportUrl = pathToFileURL(
      join(SDK_DIR, "dist/esm/client/streamableHttp.js"),
    ).href;
    const clientMod = (await import(clientUrl)) as { Client: SdkClientCtor };
    const transportMod = (await import(transportUrl)) as {
      StreamableHTTPClientTransport: SdkTransportCtor;
    };
    if (
      typeof clientMod.Client === "function" &&
      typeof transportMod.StreamableHTTPClientTransport === "function"
    ) {
      return {
        Client: clientMod.Client,
        StreamableHTTPClientTransport:
          transportMod.StreamableHTTPClientTransport,
      };
    }
  } catch {
    // No SDK anywhere: the file's tests skip (see below).
  }
  return null;
}

const SDK = await loadSdk();
const SKIP_REASON =
  "@modelcontextprotocol/sdk is not resolvable: it is not a repo " +
  "dependency. Install it (or set MCP_SDK_DIR to an SDK install, e.g. " +
  "/tmp/mcp-smoke-test/node_modules/@modelcontextprotocol/sdk) and " +
  "re-run. See assistant-api/README.md, 'Test commands'.";

// `it` is test when the SDK loaded, test.skip when it did not — so a
// missing SDK skips the file instead of failing it.
const it = SDK ? test : test.skip;

let server: ReturnType<typeof createServer> | null = null;
let client: InstanceType<SdkClientCtor> | null = null;

beforeAll(async () => {
  if (!SDK) {
    console.log(`[mcp-interop] SKIPPED: ${SKIP_REASON}`);
    return;
  }
  server = createServer({ port: 0, token: TOKEN });
  const c = new SDK.Client(
    { name: "assistant-api-interop-test", version: "0.1.0" },
    { capabilities: {} },
  );
  const transport = new SDK.StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${server.port}/mcp`),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${TOKEN}` },
      },
    },
  );
  await c.connect(transport);
  client = c;
});

afterAll(async () => {
  if (client) await client.close();
  if (server) server.stop();
});

describe("MCP interop via the official SDK", () => {
  test("SDK availability is reported (passes either way)", () => {
    if (!SDK) {
      console.log(`[mcp-interop] SDK missing — functional tests skipped.`);
    }
    expect(typeof SDK === "object" || SDK === null).toBe(true);
  });

  it("tools/list discovers exactly 8 tools with valid JSON Schemas", async () => {
    const { tools } = await client!.listTools();
    expect(tools.map((t) => t.name as string).sort()).toEqual(
      [
        "retirement_calculate",
        "retirement_monte_carlo",
        "retirement_max_spending",
        "retirement_compare_strategies",
        "retirement_roth_conversion",
        "retirement_work_years",
        "retirement_tax_year",
        "retirement_describe_capabilities",
      ].sort(),
    );
    const financial = tools.filter(
      (t) => t.name !== "retirement_describe_capabilities",
    );
    for (const tool of financial) {
      const schema = tool.inputSchema as Record<string, unknown>;
      expect(schema.type).toBe("object");
      expect(typeof schema.properties).toBe("object");
      expect(Array.isArray(schema.required)).toBe(true);
      expect(schema.required).toEqual(
        expect.arrayContaining([
          "pretax",
          "taxable",
          "roth",
          "hsa",
          "monthlySpending",
          "currentAge",
        ]),
      );
    }
    // The capabilities tool takes no inputs: no `required` array.
    const describe = tools.find(
      (t) => t.name === "retirement_describe_capabilities",
    )!;
    const describeSchema = describe.inputSchema as Record<string, unknown>;
    expect(describeSchema.type).toBe("object");
    expect(describeSchema.properties).toEqual({});
    expect("required" in describeSchema).toBe(false);
  });

  it("retirement_describe_capabilities returns an ok envelope with structuredContent", async () => {
    const res = await client!.callTool({
      name: "retirement_describe_capabilities",
      arguments: {},
    });
    expect(res.structuredContent).toBeDefined();
    expect(res.structuredContent!.ok).toBe(true);
    expect(res.structuredContent!.source).toBe("finance-planner-engine");
    const results = res.structuredContent!.results as {
      tools: Array<{ name: string }>;
    };
    expect(results.tools.map((t) => t.name)).toHaveLength(8);
  });

  it("retirement_calculate returns an ok envelope with structuredContent", async () => {
    const res = await client!.callTool({
      name: "retirement_calculate",
      arguments: { ...FICTIONAL },
    });
    expect(res.structuredContent).toBeDefined();
    expect(res.structuredContent!.ok).toBe(true);
    const results = res.structuredContent!.results as {
      neverRunsOut: boolean;
      endingBalance: number;
    };
    expect(typeof results.neverRunsOut).toBe("boolean");
    expect(results.neverRunsOut).toBe(true);
    expect(results.endingBalance).toBeGreaterThan(0);
  });

  it("calling an unknown tool surfaces JSON-RPC -32602", async () => {
    let caught: { code?: number } | null = null;
    try {
      await client!.callTool({ name: "delete_backup", arguments: {} });
    } catch (err) {
      caught = err as { code?: number };
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe(-32602);
  });
});
