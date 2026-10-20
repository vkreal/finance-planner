// Packaged (static, localStorage) entry point.
//
// Boot order matters:
//   1. Create the local runtime (sql.js database over localStorage,
//      migrations, first-boot seeding) — the real server action
//      handlers behind a local dispatcher.
//   2. Install a window.fetch interceptor that routes the client SDK's
//      action POSTs ("./actions") to that dispatcher and answers with
//      synthetic Responses. The interceptor must be in place BEFORE
//      the client bundle evaluates, because client/src/api.ts captures
//      globalThis.fetch when its module initializes.
//   3. Dynamically import the live client's entry (client/src/main.tsx)
//      unchanged — same components, same queries, same screens.
//
// Any fetch that is not an action POST passes through to the real
// fetch untouched (in practice the packaged app makes none: there is
// no backend, and the probe verifies zero network action calls).
//
// window.__fpkg exposes the dispatcher for the headless browser probe
// and for debugging; it offers nothing the app's own UI cannot do.
import { spaceQueryClient } from "@hatch/space-sdk/client";
// @ts-ignore - bun file loader emits the sql.js wasm binary as an asset.
import sqlWasmUrl from "sql.js/dist/sql-wasm.wasm";
import { createRuntime, type PackagedRuntime } from "./runtime";
import { localStorageStore } from "./storage";

declare global {
  interface Window {
    __fpkg?: {
      ready: boolean;
      runtime: PackagedRuntime;
    };
  }
}

const runtime = await createRuntime({
  store: localStorageStore(),
  wasmUrl: sqlWasmUrl as string,
  onInvalidateQueries: () => {
    void spaceQueryClient.invalidateQueries();
  },
});

const realFetch = window.fetch.bind(window);

function isActionRequest(input: unknown, init?: RequestInit): boolean {
  const method =
    init?.method ??
    (input instanceof Request ? input.method : undefined) ??
    "GET";
  if (String(method).toUpperCase() !== "POST") return false;
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input instanceof Request
          ? input.url
          : "";
  return url === "./actions" || url.endsWith("/actions");
}

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  if (isActionRequest(input, init)) {
    let rawBody: string | null | undefined;
    if (typeof init?.body === "string") {
      rawBody = init.body;
    } else if (input instanceof Request) {
      rawBody = await input.clone().text();
    }
    let action = "";
    let args: unknown = {};
    try {
      const body = JSON.parse(rawBody ?? "{}") as {
        action?: string;
        args?: unknown;
      };
      action = body.action ?? "";
      args = body.args ?? {};
    } catch {
      return new Response(
        JSON.stringify({ error: "Malformed action request body." }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    const result = await runtime.dispatch(action, args);
    return new Response(result.body, {
      status: result.status,
      headers: { "content-type": "application/json" },
    });
  }
  return realFetch(input as never, init);
};

window.__fpkg = { ready: true, runtime };

await import("../../client/src/main.tsx");
