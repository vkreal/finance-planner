// server.ts — Streamable HTTP MCP server for the Finance Planner assistant
// API. Hand-rolled JSON-RPC 2.0 over Bun.serve; NO new dependencies.
//
// Notes the reader needs:
// - zod (used by ./schema via ./normalize) resolves from the repo root
//   node_modules at runtime; this package declares no dependencies of its own.
// - Auth is a single bearer token from ASSISTANT_API_TOKEN, and the rule
//   depends on where the server binds (HOST env, default 127.0.0.1; PORT
//   env, default 8080):
//     * Token set -> auth is ON, on any host. Every /mcp request needs
//       `Authorization: Bearer <token>`.
//     * No token + loopback host (127.0.0.1, any 127.x, ::1, localhost) ->
//       the server boots WITH AUTH DISABLED for zero-config local use, prints
//       a LOUD warning to stderr on boot, and /health reports
//       auth:"none-localhost" with a warning field. Only the local machine
//       can reach it, so this is safe by construction.
//     * No token + non-loopback host (0.0.0.0 or anything else) -> the
//       server REFUSES to boot (exit 1). A remotely reachable server must
//       never run unauthenticated. Set ASSISTANT_API_TOKEN to deploy.
//   There is never a default token. /health and / are unauthenticated;
//   only /mcp requires the bearer token (when auth is on).
// - Rate-limit buckets are keyed by a SHA-256 hash of the token, never the
//   token itself. Tokens, arguments and results are never logged.
// - Engine calls are synchronous and run to completion in-process. There is
//   no hard preemption in v1; typical calls return in under 2 seconds and
//   wall time is logged per call. Input caps (mcRuns <= 5000 in the schema,
//   endAge <= 120 enforced here) bound the work instead.
// - structuredContent is included on every tools/call result. The MCP spec
//   added it in protocol version 2025-06-18; older clients ignore unknown
//   fields, and this stateless server keeps no per-client session to
//   negotiate against, so "include by default" is the rule.
// - GET /mcp is a documented limitation: server-initiated SSE streams are
//   not implemented, so the endpoint accepts POST (Streamable HTTP) only.

import { createHash, timingSafeEqual } from "node:crypto";
import { ADAPTER_VERSION, API_CONTRACT_VERSION_REPORTED } from "./types";
import { TOOL_NAMES, TOOLS, dispatchTool } from "./tools";

export const SERVER_NAME = "finance-planner-assistant-api";
export const SERVER_VERSION = "0.1.0";
export const DEFAULT_PORT = 8080;
export const DEFAULT_HOST = "127.0.0.1";
export const MCP_PATH = "/mcp";
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_END_AGE = 120;
export const SLOW_CALL_MS = 10_000;

const EXPENSIVE_TOOLS: ReadonlySet<string> = new Set([
  "retirement_monte_carlo",
  "retirement_max_spending",
  "retirement_compare_strategies",
  "retirement_roth_conversion",
  "retirement_work_years",
]);
const EXPENSIVE_LIMIT_PER_MIN = 20;
const LIGHT_LIMIT_PER_MIN = 120;
const WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// Auth + rate limiting (per-token, token never stored or logged in clear).
// ---------------------------------------------------------------------------

function tokenMatches(candidate: string | null, expected: string): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function tokenKey(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

interface Bucket {
  windowStart: number;
  count: number;
}

interface TokenBuckets {
  expensive: Bucket;
  light: Bucket;
}

const buckets = new Map<string, TokenBuckets>();

function freshBucket(now: number): Bucket {
  return { windowStart: now, count: 0 };
}

/** Returns 0 when allowed, otherwise retry-after in whole seconds. */
function checkRateLimit(kind: "expensive" | "light", key: string): number {
  const now = Date.now();
  let entry = buckets.get(key);
  if (!entry) {
    entry = { expensive: freshBucket(now), light: freshBucket(now) };
    buckets.set(key, entry);
  }
  const bucket = entry[kind];
  const limit = kind === "expensive" ? EXPENSIVE_LIMIT_PER_MIN : LIGHT_LIMIT_PER_MIN;
  if (now - bucket.windowStart >= WINDOW_MS) {
    bucket.windowStart = now;
    bucket.count = 0;
  }
  if (bucket.count >= limit) {
    return Math.max(1, Math.ceil((bucket.windowStart + WINDOW_MS - now) / 1000));
  }
  bucket.count += 1;
  return 0;
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 plumbing.
// ---------------------------------------------------------------------------

type JsonRpcId = string | number | null;

interface RpcResponse {
  status: number;
  body: Record<string, unknown> | null; // null = 202 with an empty body
}

function rpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  status = 200,
): RpcResponse {
  return {
    status,
    body: { jsonrpc: "2.0", id: id ?? null, error: { code, message } },
  };
}

function rpcResult(id: JsonRpcId, result: unknown): RpcResponse {
  return { status: 200, body: { jsonrpc: "2.0", id, result } };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function publicTools(): Array<Record<string, unknown>> {
  return TOOLS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}

function handleRpc(body: unknown): RpcResponse {
  if (Array.isArray(body)) {
    // Batch requests are not supported.
    return rpcError(null, -32600, "Batch requests are not supported");
  }
  if (!isRecord(body)) {
    return rpcError(null, -32600, "Invalid Request: expected a JSON-RPC object");
  }
  const id: JsonRpcId =
    typeof body.id === "string" || typeof body.id === "number" ? body.id : null;
  const method = body.method;
  if (body.jsonrpc !== "2.0" || typeof method !== "string") {
    return rpcError(id, -32600, "Invalid Request");
  }
  const params = isRecord(body.params) ? body.params : {};

  // Notifications (no id) are acknowledged with an empty 202.
  if (id === null && body.id === undefined) {
    return { status: 202, body: null };
  }

  switch (method) {
    case "initialize": {
      const protocolVersion =
        typeof params.protocolVersion === "string" && params.protocolVersion.length > 0
          ? params.protocolVersion
          : "2025-06-18";
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {}, logging: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          "Stateless read-only retirement calculations over the Finance Planner engines. " +
          "Every call carries its complete scenario; no data is saved.",
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: publicTools() });
    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string" || name.length === 0) {
        return rpcError(id, -32602, "Invalid params: tools/call requires a tool name");
      }
      const args: unknown = params.arguments === undefined ? {} : params.arguments;
      // Extra guard on top of the schema cap: the planning horizon ends at 120.
      if (
        isRecord(args) &&
        typeof args.endAge === "number" &&
        args.endAge > MAX_END_AGE
      ) {
        const envelope = {
          ok: false,
          source: "finance-planner-engine",
          adapterVersion: ADAPTER_VERSION,
          apiContractVersion: API_CONTRACT_VERSION_REPORTED,
          error: {
            code: "invalid_input",
            message: `endAge must be ${MAX_END_AGE} or less`,
          },
        };
        return rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(envelope) }],
          structuredContent: envelope,
        });
      }
      try {
        const envelope = dispatchTool(name, args);
        return rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(envelope) }],
          structuredContent: envelope,
        });
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Unknown tool:")) {
          return rpcError(id, -32602, `Invalid params: unknown tool "${name}"`);
        }
        // Generic message only — no stack, no internals.
        return rpcError(id, -32603, "Internal error");
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP layer.
// ---------------------------------------------------------------------------

function jsonResponse(
  status: number,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

// Read a request body with an early abort: returns null (body
// discarded) once more than maxBytes arrive, so an oversized body
// never has to be fully buffered. Returns "" for a bodyless request.
async function readBodyCapped(
  req: Request,
  maxBytes: number,
): Promise<string | null> {
  const body = req.body;
  if (body === null) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // Already closed.
      }
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return (
    h === "localhost" || h === "::1" || h === "127.0.0.1" || h.startsWith("127.")
  );
}

export const AUTH_DISABLED_WARNING =
  "WARNING: ASSISTANT_API_TOKEN is not set and this server is running " +
  "WITH AUTHENTICATION DISABLED (localhost only). Anyone on this machine " +
  "can call it with no token. Never bind it to a non-loopback address " +
  "without setting ASSISTANT_API_TOKEN.";

export function createServer(
  options: { port?: number; host?: string; token?: string } = {},
) {
  const host = options.host ?? process.env.HOST ?? DEFAULT_HOST;
  const rawToken = options.token ?? process.env.ASSISTANT_API_TOKEN;
  const token =
    rawToken !== undefined && rawToken.length > 0 ? rawToken : undefined;
  const authEnabled = token !== undefined;
  if (!authEnabled && !isLoopbackHost(host)) {
    throw new Error(
      `ASSISTANT_API_TOKEN is not set and HOST="${host}" is not loopback. ` +
        "Refusing to boot unauthenticated on a non-loopback address: " +
        "set ASSISTANT_API_TOKEN to a long random bearer token and restart, " +
        "or bind to 127.0.0.1 for local use.",
    );
  }
  if (!authEnabled) {
    // LOUD warning to stderr: auth is off by explicit local-only choice.
    console.error(`[assistant-api] ${AUTH_DISABLED_WARNING}`);
  }
  const port = options.port ?? Number(process.env.PORT ?? DEFAULT_PORT);

  const server = Bun.serve({
    port,
    hostname: host,
    fetch: async (req: Request): Promise<Response> => {
      const started = Date.now();
      const url = new URL(req.url);
      const label = `${req.method} ${url.pathname}`;
      const finish = (status: number, note = ""): Response | null => {
        // One line per request: method/path, status, duration. Never
        // arguments, results or tokens.
        console.log(
          `[assistant-api] ${label}${note ? ` ${note}` : ""} ${status} ${Date.now() - started}ms`,
        );
        return null;
      };

      if (url.pathname === "/health" && req.method === "GET") {
        finish(200);
        return jsonResponse(200, {
          ok: true,
          service: SERVER_NAME,
          version: SERVER_VERSION,
          tools: TOOL_NAMES.length,
          auth: authEnabled ? "bearer" : "none-localhost",
          ...(authEnabled ? {} : { warning: AUTH_DISABLED_WARNING }),
        });
      }
      if (url.pathname === "/" && req.method === "GET") {
        finish(200);
        return jsonResponse(200, {
          name: SERVER_NAME,
          version: SERVER_VERSION,
          mcp: MCP_PATH,
          tools: TOOL_NAMES.length,
        });
      }
      if (url.pathname === MCP_PATH && req.method === "GET") {
        finish(405);
        return jsonResponse(405, {
          error: {
            code: "method_not_allowed",
            message:
              "This endpoint accepts POST (Streamable HTTP) only; server-initiated SSE streams are not implemented",
          },
        });
      }
      if (url.pathname !== MCP_PATH) {
        finish(404);
        return jsonResponse(404, {
          error: { code: "not_found", message: "Not found" },
        });
      }
      if (req.method !== "POST") {
        finish(405);
        return jsonResponse(405, {
          error: { code: "method_not_allowed", message: "Method not allowed" },
        });
      }

      // Accept: allow application/json, text/event-stream, or */* (curl and
      // most clients send */* by default). Anything else is a 406.
      const accept = req.headers.get("accept") ?? "";
      if (
        accept.length > 0 &&
        !accept.includes("application/json") &&
        !accept.includes("text/event-stream") &&
        !accept.includes("*/*")
      ) {
        finish(406);
        return jsonResponse(406, {
          error: {
            code: "not_acceptable",
            message: "Accept header must allow application/json",
          },
        });
      }

      // Auth (Bearer token required on /mcp when auth is on; skipped
      // entirely when the server booted unauthenticated on localhost).
      // Rate limiting still applies in both modes; the no-auth mode shares
      // one fixed bucket key instead of a per-token key.
      let key = "local-no-auth";
      if (authEnabled) {
        const auth = req.headers.get("authorization") ?? "";
        const presented = auth.startsWith("Bearer ")
          ? auth.slice("Bearer ".length)
          : null;
        if (!tokenMatches(presented, token as string)) {
          finish(401);
          return jsonResponse(401, {
            error: { code: "unauthorized", message: "Missing or invalid bearer token" },
          });
        }
        key = tokenKey(presented as string);
      }

      // Body limit: 256KB -> 413. A declared Content-Length over the
      // cap is refused without reading the body at all; anything else
      // is streamed with an early abort (readBodyCapped).
      const declaredLength = req.headers.get("content-length");
      if (declaredLength !== null) {
        const declared = Number(declaredLength);
        if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) {
          finish(413);
          return jsonResponse(413, {
            error: { code: "request_too_large", message: "Request body exceeds 256KB" },
          });
        }
      }
      let raw: string | null;
      try {
        raw = await readBodyCapped(req, MAX_BODY_BYTES);
      } catch {
        finish(400);
        return jsonResponse(400, {
          error: { code: "bad_request", message: "Could not read request body" },
        });
      }
      if (raw === null) {
        finish(413);
        return jsonResponse(413, {
          error: { code: "request_too_large", message: "Request body exceeds 256KB" },
        });
      }
      if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
        finish(413);
        return jsonResponse(413, {
          error: { code: "request_too_large", message: "Request body exceeds 256KB" },
        });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        finish(200, "jsonrpc=-32700");
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        });
      }

      // Rate limit: method- and tool-aware. tools/list, initialize and ping
      // are light (120/min); the expensive calculation tools are 20/min.
      const methodForLimit =
        isRecord(parsed) && typeof parsed.method === "string" ? parsed.method : "";
      let kind: "expensive" | "light" = "light";
      let toolForLimit = "";
      if (methodForLimit === "tools/call" && isRecord(parsed) && isRecord(parsed.params)) {
        const t = parsed.params.name;
        if (typeof t === "string") {
          toolForLimit = t;
          if (EXPENSIVE_TOOLS.has(t)) kind = "expensive";
        }
      }
      const retryAfterSeconds = checkRateLimit(kind, key);
      if (retryAfterSeconds > 0) {
        finish(429, toolForLimit ? `tools/call:${toolForLimit}` : methodForLimit);
        return jsonResponse(
          429,
          {
            error: {
              code: "rate_limited",
              message: "Rate limit exceeded",
              retryAfterSeconds,
            },
          },
          { "Retry-After": String(retryAfterSeconds) },
        );
      }

      const startedCall = Date.now();
      const rpc = handleRpc(parsed);
      const callMs = Date.now() - startedCall;
      if (callMs > SLOW_CALL_MS) {
        console.log(
          `[assistant-api] slow call ${toolForLimit || methodForLimit} ${callMs}ms`,
        );
      }
      const note =
        methodForLimit === "tools/call" && toolForLimit
          ? `tools/call:${toolForLimit}`
          : methodForLimit;
      finish(rpc.status, note);
      if (rpc.body === null) {
        return new Response(null, { status: rpc.status });
      }
      return jsonResponse(rpc.status, rpc.body);
    },
  });

  return server;
}

function main(): void {
  let server;
  try {
    server = createServer();
  } catch (err) {
    console.error(
      `[assistant-api] failed to start: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
  console.log(
    `[assistant-api] ${SERVER_NAME} v${SERVER_VERSION} listening on http://${server.hostname}:${server.port} (POST ${MCP_PATH})`,
  );
}

if (import.meta.main) {
  main();
}
