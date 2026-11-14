// security.test.ts — API security for the assistant-api server.
//
// Boots the real server in-process (createServer, port 0, test token)
// and exercises it over HTTP with fetch:
//   (a) bearer auth: no token / wrong token / right token
//   (b) tools/list returns exactly the 8 allowlisted tools
//   (c) tools/call of a non-existent tool is -32602 — and the
//       storage-flavoured names below MUST NOT exist
//   (d) a body over the 256KB cap is 413
//   (e) log hygiene: no input values and no token in console.log
//   (f) error responses carry no stack traces or internal paths
//
// The server is started once per file and stopped after. Only light
// tools are called over HTTP (retirement_calculate is light), so the
// 20/min expensive bucket is never approached.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "../src/server";
import { dispatchTool } from "../src/tools";

const TOKEN = "test-token-assistant-api-security";
const TOOL_NAMES = [
  "retirement_calculate",
  "retirement_monte_carlo",
  "retirement_max_spending",
  "retirement_compare_strategies",
  "retirement_roth_conversion",
  "retirement_work_years",
  "retirement_tax_year",
  "retirement_describe_capabilities",
];

let server: ReturnType<typeof createServer>;
let baseUrl: string;

function rpc(
  body: unknown,
  options: { token?: string | null; rawBody?: string } = {},
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (options.token !== undefined && options.token !== null) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: options.rawBody ?? JSON.stringify(body),
  });
}

function rpcCall(
  method: string,
  params: Record<string, unknown>,
  token: string = TOKEN,
) {
  return rpc({ jsonrpc: "2.0", id: 1, method, params }, { token });
}

/** Distinctive input values for the log-hygiene test. */
const DISTINCTIVE_ARGS = {
  pretax: 1234567,
  taxable: 2345678,
  roth: 345678,
  hsa: 45678,
  monthlySpending: 9876,
  currentAge: 54,
  spouseAge: 52,
  retirementAge: 58,
  endAge: 95,
  taxYear: 2026,
};

beforeAll(() => {
  server = createServer({ port: 0, token: TOKEN });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop();
});

describe("bearer auth", () => {
  test("no token → 401", async () => {
    const noAuth = await rpc(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      { token: null },
    );
    expect(noAuth.status).toBe(401);
    const body = (await noAuth.json()) as Record<string, unknown>;
    expect(body.error).toMatchObject({ code: "unauthorized" });
  });

  test("wrong token → 401", async () => {
    const res = await rpc(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      { token: "wrong-token" },
    );
    expect(res.status).toBe(401);
  });

  test("right token → 200", async () => {
    const res = await rpcCall("tools/list", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(body.result.tools).toHaveLength(8);
  });
});

describe("tool allowlist", () => {
  test("tools/list returns exactly the 8 allowlisted tools, no others", async () => {
    const res = await rpcCall("tools/list", {});
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(body.result.tools.map((t) => t.name).sort()).toEqual(
      [...TOOL_NAMES].sort(),
    );
  });

  test.each(["delete_backup", "reset_planner", "import_transactions"])(
    "tools/call of non-existent tool %s → -32602 (unknown tool)",
    async (name) => {
      const res = await rpcCall("tools/call", { name, arguments: {} });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        error?: { code: number; message: string };
      };
      expect(body.error?.code).toBe(-32602);
      expect(body.error?.message).toContain(name);
    },
  );
});

describe("body cap", () => {
  test("a body over 256KB → 413", async () => {
    const res = await rpc(null, {
      token: TOKEN,
      rawBody: "x".repeat(300 * 1024),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toMatchObject({ code: "request_too_large" });
  });
});

describe("log hygiene and error hygiene", () => {
  test("logs contain none of the input values and no token", async () => {
    const lines: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    // The dispatch log line lives on stderr (S1); capture both streams
    // so the hygiene check still covers it.
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      // In-process dispatch (logs tool name + ok + duration only).
      dispatchTool("retirement_calculate", DISTINCTIVE_ARGS);
      // And the same call over HTTP (logs method/path/status/duration).
      const res = await rpcCall("tools/call", {
        name: "retirement_calculate",
        arguments: DISTINCTIVE_ARGS,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result: { structuredContent: { ok: boolean } };
      };
      expect(body.result.structuredContent.ok).toBe(true);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    const joined = lines.join("\n");
    for (const secret of ["1234567", "2345678", "9876", TOKEN]) {
      expect(joined, `log must not contain ${secret}`).not.toContain(secret);
    }
    expect(lines.length).toBeGreaterThan(0);
  });

  test("error responses contain no stack traces or internal paths", async () => {
    const bodies: string[] = [];
    // Unknown tool (JSON-RPC error).
    const unknown = await rpcCall("tools/call", {
      name: "delete_backup",
      arguments: {},
    });
    bodies.push(await unknown.text());
    // 401 body.
    const unauth = await rpc(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      { token: null },
    );
    bodies.push(await unauth.text());
    // 413 body.
    const big = await rpc(null, { token: TOKEN, rawBody: "x".repeat(300 * 1024) });
    bodies.push(await big.text());
    // An adapter invalid_input envelope over tools/call.
    const bad = await rpcCall("tools/call", {
      name: "retirement_calculate",
      arguments: { ...DISTINCTIVE_ARGS, pretax: -1 },
    });
    bodies.push(await bad.text());
    // A 404 body.
    const missing = await fetch(`${baseUrl}/no-such-path`);
    bodies.push(await missing.text());

    for (const text of bodies) {
      expect(text).not.toContain("server/src/");
      expect(text).not.toContain(".ts:");
      expect(text).not.toMatch(/^\s+at\s/m); // no stack frames
      expect(text).not.toContain("node_modules");
    }
  });

  test("the invalid_input envelope names the field, not the value", async () => {
    const res = await rpcCall("tools/call", {
      name: "retirement_calculate",
      arguments: { ...DISTINCTIVE_ARGS, pretax: -1234567 },
    });
    const text = await res.text();
    expect(text).not.toContain("1234567");
    expect(text).toContain("invalid_input");
  });
});

describe("server behavior (rate limits, horizon cap, boot refusal)", () => {
  // A fresh server + fresh token per test: rate-limit buckets are
  // per-token, so each test starts with empty buckets.
  function freshServer(token: string) {
    const srv = createServer({ port: 0, token });
    return { srv, url: `http://127.0.0.1:${srv.port}/mcp` };
  }

  function post(url: string, token: string, body: unknown) {
    return fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  }

  function toolCall(name: string, args: Record<string, unknown>) {
    return {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    };
  }

  test("expensive bucket: the 21st Monte Carlo call in a minute → 429", async () => {
    const token = "test-token-assistant-api-ratelimit-exp";
    const { srv, url } = freshServer(token);
    try {
      const args = { ...DISTINCTIVE_ARGS, mcRuns: 10, mcSeed: 7 };
      for (let i = 0; i < 20; i++) {
        const res = await post(url, token, toolCall("retirement_monte_carlo", args));
        expect(res.status).toBe(200);
        await res.text();
      }
      const limited = await post(
        url,
        token,
        toolCall("retirement_monte_carlo", args),
      );
      expect(limited.status).toBe(429);
      expect(limited.headers.get("Retry-After")).not.toBeNull();
    } finally {
      srv.stop();
    }
  }, 60_000);

  test("light bucket: the 121st describe call in a minute → 429", async () => {
    const token = "test-token-assistant-api-ratelimit-light";
    const { srv, url } = freshServer(token);
    try {
      for (let i = 0; i < 120; i++) {
        const res = await post(
          url,
          token,
          toolCall("retirement_describe_capabilities", {}),
        );
        expect(res.status).toBe(200);
        await res.text();
      }
      const limited = await post(
        url,
        token,
        toolCall("retirement_describe_capabilities", {}),
      );
      expect(limited.status).toBe(429);
    } finally {
      srv.stop();
    }
  }, 60_000);

  test("endAge 115 is accepted over HTTP (server cap is 120, not 110)", async () => {
    const res = await rpcCall("tools/call", {
      name: "retirement_calculate",
      arguments: { ...DISTINCTIVE_ARGS, endAge: 115 },
    });
    const body = (await res.json()) as {
      result: { structuredContent: { ok: boolean } };
    };
    expect(body.result.structuredContent.ok).toBe(true);
  });

  test("endAge 121 is invalid_input over HTTP", async () => {
    const res = await rpcCall("tools/call", {
      name: "retirement_calculate",
      arguments: { ...DISTINCTIVE_ARGS, endAge: 121 },
    });
    const text = await res.text();
    expect(text).toContain("invalid_input");
  });

  test("non-loopback boot without a token throws", () => {
    const saved = process.env.ASSISTANT_API_TOKEN;
    delete process.env.ASSISTANT_API_TOKEN;
    try {
      expect(() => createServer({ port: 0, host: "0.0.0.0" })).toThrow(
        /ASSISTANT_API_TOKEN/,
      );
    } finally {
      if (saved !== undefined) process.env.ASSISTANT_API_TOKEN = saved;
    }
  });
});
