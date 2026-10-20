// Headless-browser probe of the packaged static site.
//
// Serves packaged/dist/ locally, drives headless Chromium over the
// DevTools protocol, and walks the acceptance path:
//   load (zero network action calls — every request is a same-origin
//   static asset) -> sample data present -> price the seeded Roth
//   example + a Playground year against live-pinned figures -> make
//   an edit -> reload -> edit persisted from localStorage ->
//   exportbackup -> clearAllData -> restorebackup -> state returns.
//
// Usage: bun ./probe.ts   (expects packaged/dist to be built)
import { join } from "node:path";
import { packagedDir } from "./build-shared.mjs";

const PORT = 8931;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const requests: string[] = [];

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    requests.push(`${req.method} ${url.pathname}`);
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(join(packagedDir, "dist", path));
    if (await file.exists()) return new Response(file);
    return new Response("not found", { status: 404 });
  },
});

// ---------- launch chromium ----------
const profileDir = `/tmp/fpkg-probe-${Date.now()}`;
const chrome = Bun.spawn(
  [
    "/opt/meta-chromium/chrome",
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    // This Chromium build blocks loopback navigations with Local
    // Network Access checks; declaring the probe origin's address
    // space "public" lifts the check for the probe only.
    `--ip-address-space-overrides=127.0.0.1:${PORT}=public`,
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    // The app URL as the initial tab: a browser-initiated navigation
    // (a created target navigating to 127.0.0.1 is blocked by
    // Chrome's Local Network Access checks).
    `${ORIGIN}/`,
  ],
  { stdout: "pipe", stderr: "pipe" },
);
const wsUrl = await new Promise<string>((resolve, reject) => {
  const reader = chrome.stderr.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return reject(new Error("chrome exited before DevTools was ready"));
      buf += decoder.decode(value);
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) return resolve(m[1]);
    }
  })();
  setTimeout(() => reject(new Error("DevTools listen timeout")), 30_000);
});

// ---------- minimal CDP client ----------
const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
let nextId = 1;
let sessionId: string | undefined;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const networkUrls: string[] = [];
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(String(event.data));
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  }
  if (msg.method === "Network.requestWillBeSent") {
    networkUrls.push(msg.params.request.url);
  }
  if (msg.method === "Runtime.exceptionThrown") {
    console.log("PAGE EXCEPTION:", JSON.stringify(msg.params.exceptionDetails?.exception?.description ?? msg.params).slice(0, 400));
  }
});
function cdp(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(
      JSON.stringify({
        id,
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
      }),
    );
  });
}
async function evaluate<T>(expression: string): Promise<T> {
  const res = await cdp("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    throw new Error(`evaluate failed: ${JSON.stringify(res.exceptionDetails).slice(0, 500)}`);
  }
  return res.result.value as T;
}
const call = (action: string, args: unknown) =>
  evaluate(
    `window.__fpkg.runtime.call(${JSON.stringify(action)}, ${JSON.stringify(args)})`,
  );

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

try {
  const targets = await cdp("Target.getTargets");
  const page = (targets.targetInfos ?? []).find(
    (t: any) => t.type === "page" && typeof t.url === "string" && t.url.startsWith(ORIGIN),
  );
  if (!page) throw new Error("app page target not found");
  const attached = await cdp("Target.attachToTarget", {
    targetId: page.targetId,
    flatten: true,
  });
  sessionId = attached.sessionId;
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Network.enable");

  // Wait for the packaged runtime to be ready.
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    ready = await evaluate<boolean>(
      "!!(window.__fpkg && window.__fpkg.ready)",
    ).catch(() => false);
    if (!ready) await new Promise((r) => setTimeout(r, 500));
  }
  check("1. packaged runtime boots in browser", ready);

  const domText = await evaluate<string>("document.body.innerText.slice(0, 4000)");
  check("2. app UI rendered", /net worth|spending|retirement/i.test(domText));

  const actionRequests = requests.filter((r) => r.includes("actions"));
  check("3. zero network action requests", actionRequests.length === 0, `${requests.length} static requests total`);
  const external = networkUrls.filter((u) => !u.startsWith(ORIGIN) && !u.startsWith("data:") && !u.startsWith("blob:"));
  check("4. zero external requests", external.length === 0, external.slice(0, 3).join(", "));

  const lsKeys = await evaluate<string[]>(
    "Object.keys(localStorage).filter(k => k.startsWith('fpkg:'))",
  );
  check("5. localStorage holds packaged state", lsKeys.length >= 4, lsKeys.slice(0, 6).join(", "));

  const nw = await call("getNetWorth", {});
  const totals = (nw.snapshots ?? []).map((s: any) => s.totalCents);
  check(
    "6. sample Net Worth data present after load",
    totals[0] === 261000000 && totals[totals.length - 1] === 306250000,
    `first ${totals[0]}, last ${totals[totals.length - 1]}`,
  );

  const api = await call("describeApi", { action: "describeApi" });
  const example = api.examples.find((e: any) => e.action === "runRothCompare");
  const priced: any = await call("runRothCompare", example.request);
  check(
    "7. seeded Roth example prices to the live-pinned figure",
    priced.scenarios?.[0]?.endingAfterTaxWealthCents === 3913424968,
    `wealth ${priced.scenarios?.[0]?.endingAfterTaxWealthCents}`,
  );

  const pg: any = await call("runPlaygroundYear", {
    taxYear: 2026, filingStatus: "mfj", agePrimary: 60, ageSpouse: 50,
    onMedicarePrimary: false, onMedicareSpouse: false, interest: 4000,
    ordinaryDividends: 9000, otherOrdinary: 0, taxExemptInterest: 500,
    ssPrimary: 0, ssSpouse: 0, conversion: 100000, stockSold: 20000,
    stockBasis: 12000, qualifiedDividends: 7000, pretaxBalance: 1500000,
    spouseSoleBeneficiary: true, acaHouseholdSize: 2,
    acaBenchmarkAnnual: 22000, stateRatePct: 0,
  });
  check(
    "8. Playground year matches live-pinned figures",
    pg.result?.magi === 128500 && pg.result?.federalTax === 9200 && pg.lawYearUsed === 2026,
    `magi ${pg.result?.magi}, tax ${pg.result?.federalTax}, lawYear ${pg.lawYearUsed}`,
  );

  // Edit, then reload and confirm persistence.
  const added: any = await call("addMonthlyBill", {
    name: "Probe Bill", amountCents: 12345, effectiveFrom: "2026-08", paidBy: "Checking",
  });
  check("9. edit accepted (addMonthlyBill)", typeof added.id === "number", `id ${added.id}`);
  await cdp("Page.reload", {});
  let readyAgain = false;
  for (let i = 0; i < 120 && !readyAgain; i++) {
    readyAgain = await evaluate<boolean>(
      "!!(window.__fpkg && window.__fpkg.ready)",
    ).catch(() => false);
    if (!readyAgain) await new Promise((r) => setTimeout(r, 500));
  }
  check("10. runtime reboots after reload", readyAgain);
  const dashAfterReload: any = await call("getDashboard", { month: "2026-09" });
  check(
    "11. edit persisted across reload (from localStorage)",
    (dashAfterReload.monthlyBills ?? []).some((b: any) => b.name === "Probe Bill"),
  );

  // Export -> wipe -> restore.
  const payload: any = await call("exportbackup", {});
  const cleared: any = await call("clearAllData", { confirm: "delete everything" });
  const dashWiped: any = await call("getDashboard", { month: "2026-09" });
  check("12. wipe empties the app", cleared.ok === true && dashWiped.hasAnyData === false);
  const restored: any = await call("restorebackup", payload);
  const dashRestored: any = await call("getDashboard", { month: "2026-09" });
  check(
    "13. restore brings the state back",
    restored.ok === true &&
      (dashRestored.monthlyBills ?? []).some((b: any) => b.name === "Probe Bill"),
  );

  const shot = await cdp("Page.captureScreenshot", { format: "png" });
  await Bun.write("/tmp/fpkg-probe.png", Buffer.from(shot.data, "base64"));
  console.log("screenshot: /tmp/fpkg-probe.png");
} finally {
  try {
    sessionId = undefined; // Browser.close is a browser-level method
    await cdp("Browser.close");
  } catch {
    chrome.kill();
  }
  server.stop(true);
}

console.log(failures === 0 ? "\nPROBE: all checks passed" : `\nPROBE: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
