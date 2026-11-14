// Multi-view visual audit of the packaged static site.
//
// WHY THIS EXISTS
// The platform's automated audit (web_artifact_audit, driven by
// playwright-audit.ts + probe-ui-observe.ts under
// /opt/hatch/skills/spaces/ts-runtime) navigates to the artifact
// once and audits the landing view only. This app has five views
// (Spending, Tax Plan, Retirement, Net Worth, Playground), so
// four of them were never audited at all — every visual defect
// the platform audit missed lived on a view it never rendered
// (2026-11-10 visual sweep, inspection 044bb4fe). The platform
// files are read-only system code, so this harness does NOT edit
// them: it reproduces their clipping walk (same thresholds, same
// caps) over CDP against packaged/dist, driving the real UI
// through all five views, opening the True cost detail panel
// once, and excluding visually-hidden 1px elements from the
// text_truncated check (fix #3 below).
//
// WHAT IT CHECKS, per viewport (desktop 1440x900, mobile 390x844):
//   1. Each of the five views renders (view-switcher button's
//      aria-pressed flips) and is scanned for clipped text.
//   2. On Spending (desktop), one chart bar is clicked to open
//      the True cost detail panel, which is scanned too.
//   3. The clip scan SKIPS visually-hidden 1px elements: the
//      app marks screen-reader-only text with `sr-only`
//      (1px x 1px, overflow hidden), and the platform walk flags
//      those as text_truncated because their long text overflows
//      a 1px box by design. The skip is on EITHER dimension at
//      1px or under: the sr-only containers are 1x1, but their
//      descendants — the <li> items of the screen-reader month
//      lists — are 1px wide and full height (1x24), invisible
//      only because the 1x1 ancestor clips them. Skipped
//      elements are recorded per view (text + class) so the
//      exclusion is auditable, not just a count.
//   A past_viewport finding inside a horizontally scrollable
//   container is reported but does not fail the run: the user
//   can swipe to it, and the platform calls that shape
//   needs_inner_scroll (informational). text_truncated and
//   non-scroller past_viewport do fail.
//   Each view is gated on a render-ready marker before its
//   walk, so a half-rendered view cannot pass vacuously.
//   Typecheck: bun run typecheck (packaged/tsconfig.json;
//   the root typecheck does not cover packaged/*.ts).
//
// Usage: bun ./audit-views.ts [--self-test] [--viewport desktop|mobile|both] [--out <dir>]
//   --self-test  after the audit, inject control elements and
//                assert the walk flags real truncation, skips
//                exactly three 1px elements (counted + recorded),
//                and flags a 2px strip.
//   --viewport   which viewports to audit (default: both).
//   --out        report + screenshots directory
//                (default: /tmp/audit-views-<timestamp>).
// Expects packaged/dist to be built (bun ./build.mjs).
// Exit 0: no blocking clipped text and (with --self-test) all
// control assertions pass. Exit 1: any blocking clipped text
// found, a view failed to render, the detail panel failed to
// open, or a control assertion failed.

import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { packagedDir } from "./build-shared.mjs";

const PORT = 8932;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const VIEWS = [
  { key: "spending", label: "Spending view" },
  { key: "roth", label: "Tax Plan view" },
  { key: "retirement", label: "Retirement view" },
  { key: "networth", label: "Net Worth view" },
  { key: "playground", label: "Playground view" },
] as const;
const VIEWPORTS = {
  desktop: { width: 1440, height: 900, mobile: false },
  mobile: { width: 390, height: 844, mobile: true },
} as const;

// The platform clip scan (probe-ui-observe.ts, second pass of
// observeWalkScript), ported verbatim except for the 1px guard
// marked FIX below. Same bounds: 4000 elements scanned, 3px
// minimum overflow, 20 findings max — so its results are
// directly comparable to the platform audit's `clipped` output.
const CLIP_WALK_SCRIPT = `(() => {
  const MAX_CLIP_SCAN = 4000;
  const CLIP_MIN_PX = 3;
  const clipped = [];
  let scanned = 0;
  let hidden1pxSkipped = 0;
  const hidden1px = [];
  for (const el of Array.from(document.body ? document.body.querySelectorAll("*") : [])) {
    if (scanned >= MAX_CLIP_SCAN) break;
    scanned += 1;
    if (clipped.length >= 20) break;
    const own = Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && (n.textContent || "").trim().length > 0,
    );
    if (!own) continue;
    const r2 = el.getBoundingClientRect();
    if (r2.width <= 0 || r2.height <= 0) continue;
    const cs2 = getComputedStyle(el);
    if (cs2.visibility === "hidden" || cs2.display === "none") continue;
    // FIX (2026-11-14): visually-hidden 1px elements are not
    // visibly cut off. The app marks screen-reader-only text
    // sr-only (1px x 1px, overflow hidden); its long text
    // overflows the 1px box by design and the platform walk
    // reports it as text_truncated. The skip is on EITHER
    // dimension at 1px or under — the sr-only containers are
    // 1x1, but their descendants (the <li> items of the
    // screen-reader month lists) are 1px WIDE and full height
    // (1x24), and their text is invisible only because the
    // 1x1 ancestor clips it. A both-dimensions rule was tried
    // and immediately falsified by the verification run: it
    // un-skipped every 1x24 list item and flooded the report
    // with false positives. No readable text can render in a
    // 1px dimension, so either-dimension is the sound
    // predicate here — and the skipped elements are recorded
    // (text + class, capped at 50) so a reader can verify
    // they are all truly sr-only.
    if (r2.width <= 1 || r2.height <= 1) {
      hidden1pxSkipped += 1;
      if (hidden1px.length < 50) {
        hidden1px.push({
          text: (el.textContent || "").trim().slice(0, 40),
          cls: (el.getAttribute("class") || "").slice(0, 40),
        });
      }
      continue;
    }
    const truncPx = el.clientWidth > 0 ? el.scrollWidth - el.clientWidth : 0;
    const pastPx = r2.right - window.innerWidth;
    const kind = truncPx >= CLIP_MIN_PX
      ? "text_truncated"
      : pastPx >= CLIP_MIN_PX
        ? "past_viewport"
        : null;
    if (kind === null) continue;
    // Annotation (not an exemption): is the element inside a
    // horizontally scrollable container the user can swipe?
    // The chart scrollers are that shape by design, so a
    // past_viewport label inside one is a different verdict
    // from text cut off where no scroll can reach it.
    let inHScroller = false;
    for (let a = el.parentElement; a; a = a.parentElement) {
      const csA = getComputedStyle(a);
      if ((csA.overflowX === "auto" || csA.overflowX === "scroll") && a.scrollWidth > a.clientWidth + 1) {
        inHScroller = true;
        break;
      }
    }
    clipped.push({
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 60),
      kind,
      overflow_px: Math.round(kind === "text_truncated" ? truncPx : pastPx),
      in_h_scroller: inHScroller,
      overflow_x: cs2.overflowX,
      overflow_y: cs2.overflowY,
      white_space: cs2.whiteSpace,
      bbox: [Math.round(r2.x), Math.round(r2.y), Math.round(r2.width), Math.round(r2.height)],
    });
  }
  return { clipped, hidden1pxSkipped, hidden1px, scanned, capped: scanned >= MAX_CLIP_SCAN };
})()`;

const args = process.argv.slice(2);
const selfTest = args.includes("--self-test");
const viewportIdx = args.indexOf("--viewport");
const viewportFlag = viewportIdx >= 0 ? (args[viewportIdx + 1] ?? "both") : "both";
const outIdx = args.indexOf("--out");
const outFlag = outIdx >= 0 ? args[outIdx + 1] : undefined;
const outDir =
  outFlag ?? `/tmp/audit-views-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const viewports =
  viewportFlag === "both"
    ? (["desktop", "mobile"] as const)
    : viewportFlag === "desktop" || viewportFlag === "mobile"
      ? ([viewportFlag] as const)
      : null;
if (viewports === null) {
  console.error(`unknown --viewport ${viewportFlag} (want desktop|mobile|both)`);
  process.exit(1);
}

const distIndex = join(packagedDir, "dist", "index.html");
if (!(await Bun.file(distIndex).exists())) {
  console.error(`packaged/dist is not built — run: bun ./build.mjs (from packaged/)`);
  process.exit(1);
}
await mkdir(outDir, { recursive: true });

// Headless Chrome needs the Hatch WebGL domain policy (same as
// probe.ts runs): the policy file must end with a trailing
// newline; its sha256 is asserted against the documented value.
const POLICY = "hatch-webgl-all-origins-v1\n";
const POLICY_SHA256 = "8097045f0459c96c4cdc76e3a1af4e0f43f640b4b59c43d6db35e3641c0264c6";
await Bun.write("/tmp/webgl-policy-1.txt", POLICY);
const policySha = new Bun.CryptoHasher("sha256").update(POLICY).digest("hex");
if (policySha !== POLICY_SHA256) {
  console.error(`webgl policy sha mismatch: ${policySha}`);
  process.exit(1);
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(join(packagedDir, "dist", path));
    if (await file.exists()) return new Response(file);
    return new Response("not found", { status: 404 });
  },
});

const profileDir = `/tmp/audit-views-profile-${Date.now()}`;
const chrome = Bun.spawn(
  [
    "/opt/meta-chromium/chrome",
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    `--ip-address-space-overrides=127.0.0.1:${PORT}=public`,
    "--hatch-webgl-allowed-domains-file=/tmp/webgl-policy-1.txt",
    `--hatch-webgl-allowed-domains-sha256=${policySha}`,
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
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
      if (m?.[1]) return resolve(m[1]);
    }
  })();
  setTimeout(() => reject(new Error("DevTools listen timeout")), 30_000);
});

const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
let nextId = 1;
let sessionId: string | undefined;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(String(event.data));
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  }
  if (msg.method === "Runtime.exceptionThrown") {
    console.log("PAGE EXCEPTION:", JSON.stringify(msg.params.exceptionDetails?.exception?.description ?? msg.params).slice(0, 400));
  }
});
function cdp(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type ViewResult = {
  view: string;
  clipped: Array<{ tag: string; text: string; kind: string; overflow_px: number; in_h_scroller: boolean; overflow_x: string; overflow_y: string; white_space: string; bbox: number[] }>;
  hidden1pxSkipped: number;
  hidden1px: Array<{ text: string; cls: string }>;
  scanned: number;
  capped: boolean;
  screenshot: string;
};
type ViewportResult = { viewport: string; views: ViewResult[] };

const report: {
  tool: string;
  generatedAt: string;
  outDir: string;
  viewports: ViewportResult[];
  detailOpened: { viewport: string; view: string; monthLabel: string | null; openedVia: string } | null;
  selfTest: { truncatedFlagged: boolean; onePxNotFlagged: boolean; onePxSkippedDeltaOk: boolean; wideStripSkipped: boolean; flatStripSkipped: boolean; twoPxStripFlagged: boolean } | null;
  ok: boolean;
} = {
  tool: "packaged/audit-views.ts",
  generatedAt: new Date().toISOString(),
  outDir,
  viewports: [],
  detailOpened: null,
  selfTest: null,
  ok: true,
};
let failures = 0;
function fail(label: string, detail = "") {
  failures += 1;
  report.ok = false;
  console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
}
function pass(label: string, detail = "") {
  console.log(`PASS  ${label}${detail ? ` — ${detail}` : ""}`);
}

// A past_viewport label inside a horizontally scrollable
// container is reachable by swiping — the platform calls it
// needs_inner_scroll, informational, never blocking. It is
// still recorded (and counted in the PASS note), but it must
// not fail the run: by-design scroller content would make the
// mobile leg fail forever. text_truncated and non-scroller
// past_viewport still fail.
function splitFindings(clipped: ViewResult["clipped"]) {
  const blocking = clipped.filter((c) => !(c.kind === "past_viewport" && c.in_h_scroller));
  const scrollerNotes = clipped.filter((c) => c.kind === "past_viewport" && c.in_h_scroller);
  return { blocking, scrollerNotes };
}

// One render-ready marker per view: the walk must measure a
// rendered view, not a skeleton — a fixed sleep after the tab
// click cannot tell the difference. Markers are stable
// elements that exist on each view's default face.
const VIEW_MARKERS: Record<string, { selector?: string; text?: string }> = {
  spending: { selector: 'section[aria-label="True cost vs Cash out by month"]' },
  roth: { selector: '[aria-label="Balances over time chart"]' },
  retirement: { selector: '[aria-label="Plan verdict and inputs"]' },
  networth: { text: "Net worth over time" },
  playground: { selector: 'section[aria-label="Single-year dials"]' },
};
async function waitForMarker(viewKey: string): Promise<boolean> {
  const marker = VIEW_MARKERS[viewKey];
  if (!marker) return false;
  for (let i = 0; i < 40; i++) {
    const found = await evaluate<boolean>(
      marker.selector
        ? `document.querySelector(${JSON.stringify(marker.selector)}) != null`
        : `document.body.innerText.includes(${JSON.stringify(marker.text ?? "")})`,
    ).catch(() => false);
    if (found) return true;
    await sleep(250);
  }
  return false;
}

async function screenshot(name: string) {
  const shot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  const path = join(outDir, name);
  await Bun.write(path, Buffer.from(shot.data, "base64"));
  return path;
}

async function clipWalk(): Promise<{
  clipped: ViewResult["clipped"];
  hidden1pxSkipped: number;
  hidden1px: ViewResult["hidden1px"];
  scanned: number;
  capped: boolean;
}> {
  return evaluate(CLIP_WALK_SCRIPT);
}

try {
  const targets = await cdp("Target.getTargets");
  const page = (targets.targetInfos ?? []).find(
    (t: any) => t.type === "page" && typeof t.url === "string" && t.url.startsWith(ORIGIN),
  );
  if (!page) throw new Error("app page target not found");
  const attached = await cdp("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  sessionId = attached.sessionId;
  await cdp("Page.enable");
  await cdp("Runtime.enable");

  for (const vp of viewports) {
    const dims = VIEWPORTS[vp];
    await cdp("Emulation.setDeviceMetricsOverride", {
      width: dims.width,
      height: dims.height,
      deviceScaleFactor: dims.mobile ? 2 : 1,
      mobile: dims.mobile,
    });
    await cdp("Page.navigate", { url: `${ORIGIN}/` });
    // Let the navigation commit before evaluating: polling
    // immediately can run against the stale page (which may
    // still report __fpkg.ready from the previous view).
    await sleep(1000);
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) {
      ready = await evaluate<boolean>("!!(window.__fpkg && window.__fpkg.ready)").catch(() => false);
      if (!ready) await sleep(500);
    }
    if (!ready) {
      fail(`${vp}: packaged runtime boots`);
      continue;
    }
    pass(`${vp}: packaged runtime boots`);
    // The ready flag fires before the landing view's first full
    // render, and topView is persisted, so a reload after the
    // previous pass opens on the last view visited (e.g.
    // Playground), which has no chart section at all. Reset to
    // Spending first, then wait for its marker — a fixed sleep
    // cannot tell a rendered view from a skeleton.
    await evaluate(
      `(document.querySelector('button[aria-label="Spending view"]') || {}).click?.()`,
    );
    if (!(await waitForMarker("spending"))) {
      fail(`${vp}: spending view never rendered`);
      continue;
    }
    await sleep(400);

    const vpResult: ViewportResult = { viewport: vp, views: [] };
    let detailOpenedThisViewport = false;

    for (const view of VIEWS) {
      if (view.key !== "spending") {
        await evaluate(
          `(document.querySelector('button[aria-label="${view.label}"]') || {}).click?.()`,
        );
        // The pressed flip is a React re-render: poll for it
        // instead of reading it in the same instant as the click.
        let pressed = false;
        for (let i = 0; i < 10 && !pressed; i++) {
          pressed = await evaluate<boolean>(
            `document.querySelector('button[aria-label="${view.label}"]')?.getAttribute("aria-pressed") === "true"`,
          ).catch(() => false);
          if (!pressed) await sleep(200);
        }
        if (!pressed) {
          fail(`${vp}/${view.key}: view switch`, `button ${view.label} did not become pressed`);
          continue;
        }
        if (!(await waitForMarker(view.key))) {
          fail(`${vp}/${view.key}: view content never rendered`, `marker ${JSON.stringify(VIEW_MARKERS[view.key])} never appeared`);
          continue;
        }
        await sleep(400);
      }
      const walk = await clipWalk();
      const shot = await screenshot(`${vp}-${view.key}.png`);
      vpResult.views.push({
        view: view.key,
        clipped: walk.clipped,
        hidden1pxSkipped: walk.hidden1pxSkipped,
        hidden1px: walk.hidden1px,
        scanned: walk.scanned,
        capped: walk.capped,
        screenshot: shot,
      });
      const { blocking, scrollerNotes } = splitFindings(walk.clipped);
      const scrollerNote = scrollerNotes.length > 0 ? `, ${scrollerNotes.length} past_viewport inside h-scrollers (reachable by swipe)` : "";
      if (blocking.length > 0) {
        fail(
          `${vp}/${view.key}: clipped text`,
          blocking.map((c) => `${c.kind} ${c.overflow_px}px "${c.text}"`).join(" | ") + scrollerNote,
        );
      } else {
        pass(
          `${vp}/${view.key}: no clipped text`,
          `scanned ${walk.scanned}${walk.capped ? " (capped at 4000)" : ""}, 1px skipped ${walk.hidden1pxSkipped}${scrollerNote}`,
        );
      }

      // Open the True cost detail once (desktop Spending only).
      // Preferred path: a real tap on a chart bar (the user
      // path), self-checked — the bar's centre must hit-test to
      // a bar path first, because the section mounts BOTH the
      // Month and Year charts and their bars animate in, so a
      // raw rect can belong to a hidden/animating chart and the
      // click lands on page background instead. If no bar
      // hit-tests (animation still settling, hidden chart),
      // fall back to the keyboard month button, which calls the
      // same toggle and opens the same panel; the fallback is
      // logged, not silent. The bar-tap path itself is covered
      // by the probe-ui feel passes (real taps); this harness
      // audits the resulting panel state.
      if (vp === "desktop" && view.key === "spending" && !detailOpenedThisViewport) {
        detailOpenedThisViewport = true;
        const bar = await (async (): Promise<{ x: number; y: number } | null> => {
          for (let attempt = 0; attempt < 8; attempt++) {
            const hit = await evaluate<{ x: number; y: number } | null>(`(() => {
              const sec = document.querySelector('section[aria-label="True cost vs Cash out by month"]');
              if (!sec) return null;
              sec.scrollIntoView({ block: "center", behavior: "instant" });
              const paths = Array.from(sec.querySelectorAll(".recharts-bar-rectangle path"));
              const usable = paths.filter((p) => {
                const r = p.getBoundingClientRect();
                return r.width >= 4 && r.height >= 4;
              });
              if (usable.length === 0) return null;
              // The chart lives in a horizontal scroller whose
              // content can start off-viewport (svg left edge at
              // x=-101 in the probe): bars in the scrolled-out
              // part report a rect but are not painted there, so
              // their centres hit-test to page background. Take
              // the first bar whose centre actually hit-tests to
              // a bar path — that is a bar a user can tap.
              for (const p of usable) {
                const r = p.getBoundingClientRect();
                const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
                const at = document.elementFromPoint(cx, cy);
                if (!at || !(at.closest(".recharts-bar-rectangle") || at.closest("svg"))) continue;
                return { x: cx, y: cy };
              }
              return null;
            })()`);
            if (hit) return hit;
            await sleep(600);
          }
          return null;
        })();
        let openedVia = "bar";
        if (!bar) {
          console.log("detail: no bar hit-tests after settling; opening via the keyboard month button instead");
          openedVia = "month button";
          const clicked = await evaluate<boolean>(`(() => {
            const btns = Array.from(document.querySelectorAll('button[aria-label^="Show detail for "]'));
            const mid = btns[Math.floor(btns.length / 2)];
            if (!mid) return false;
            mid.click();
            return true;
          })()`);
          if (!clicked) {
            fail("detail: no month button found to click");
          }
        } else {
          await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: bar.x, y: bar.y, button: "left", clickCount: 1 });
          await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: bar.x, y: bar.y, button: "left", clickCount: 1 });
        }
        await sleep(700);
        {
          const monthLabelRaw = await evaluate<string | null>(
            `document.querySelector('section[aria-label="True cost vs Cash out by month"] [role="region"][aria-label^="Detail for "]')?.getAttribute("aria-label")?.replace("Detail for ", "") ?? null`,
          );
          // Second detector: the keyboard month button for the
          // selected month carries aria-pressed=true.
          const pressedMonth = await evaluate<string | null>(
            `document.querySelector('button[aria-label^="Show detail for "][aria-pressed="true"]')?.getAttribute("aria-label")?.replace("Show detail for ", "") ?? null`,
          );
          const monthLabel = monthLabelRaw ?? pressedMonth;
          if (monthLabel == null) {
            fail("detail: panel did not open after bar click", `via ${openedVia}; region: ${monthLabelRaw ?? "none"}, pressed month button: ${pressedMonth ?? "none"}`);
          } else {
            report.detailOpened = { viewport: vp, view: "spending", monthLabel, openedVia };
            const detailWalk = await clipWalk();
            const detailShot = await screenshot(`${vp}-spending-detail.png`);
            vpResult.views.push({
              view: "spending+detail",
              clipped: detailWalk.clipped,
              hidden1pxSkipped: detailWalk.hidden1pxSkipped,
              hidden1px: detailWalk.hidden1px,
              scanned: detailWalk.scanned,
              capped: detailWalk.capped,
              screenshot: detailShot,
            });
            const detailSplit = splitFindings(detailWalk.clipped);
            const detailScrollerNote = detailSplit.scrollerNotes.length > 0 ? `, ${detailSplit.scrollerNotes.length} past_viewport inside h-scrollers (reachable by swipe)` : "";
            if (detailSplit.blocking.length > 0) {
              fail(
                `${vp}/spending+detail: clipped text`,
                detailSplit.blocking.map((c) => `${c.kind} ${c.overflow_px}px "${c.text}"`).join(" | ") + detailScrollerNote,
              );
            } else {
              pass(
                `${vp}/spending+detail: no clipped text`,
                `detail for ${monthLabel}, scanned ${detailWalk.scanned}, 1px skipped ${detailWalk.hidden1pxSkipped}${detailScrollerNote}`,
              );
            }
          }
        }
      }
    }
    report.viewports.push(vpResult);
  }

  // Control (--self-test): pins the walk's discrimination.
  // Runs last, on the desktop Spending view (reset first, so
  // the comment is true — topView is persisted), and the
  // controls are removed afterwards. Five assertions:
  //   1. a deliberately truncated element IS flagged;
  //   2. a deliberately 1x1 element is NOT flagged;
  //   3. the 1x1 element raises hidden1pxSkipped by exactly 3
  //      (itself plus the two 1px strips, all skipped) and
  //      appears in the recorded skipped samples (a bare
  //      absence-from-clipped would be weaker);
  //   4./5. a 1x200 strip and a 200x1 strip are ALSO skipped —
  //      the either-dimension rule treats any 1px dimension
  //      as visually hidden, like sr-only descendants;
  //   6. a 2x200 strip IS flagged, pinning the boundary at 1px.
  if (selfTest) {
    await cdp("Emulation.setDeviceMetricsOverride", {
      width: VIEWPORTS.desktop.width,
      height: VIEWPORTS.desktop.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp("Page.navigate", { url: `${ORIGIN}/` });
    // Same stale-page guard as the viewport loop: let the
    // navigation commit before evaluating.
    await sleep(1000);
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) {
      ready = await evaluate<boolean>("!!(window.__fpkg && window.__fpkg.ready)").catch(() => false);
      if (!ready) await sleep(500);
    }
    if (!ready) {
      fail("self-test: packaged runtime did not boot");
    } else {
      await evaluate(
        `(document.querySelector('button[aria-label="Spending view"]') || {}).click?.()`,
      );
      if (!(await waitForMarker("spending"))) {
        fail("self-test: spending view never rendered");
      } else {
        await sleep(400);
        const baseline = await clipWalk();
        await evaluate(`(() => {
          const t = document.createElement("div");
          t.id = "audit-views-control-truncated";
          t.textContent = "CONTROL deliberately truncated label for self-test";
          t.setAttribute("style", "width:60px;overflow:hidden;white-space:nowrap");
          document.body.appendChild(t);
          const h = document.createElement("div");
          h.id = "audit-views-control-1px";
          h.textContent = "CONTROL deliberately hidden one pixel caption for self-test";
          h.setAttribute("style", "position:absolute;width:1px;height:1px;overflow:hidden;white-space:nowrap");
          document.body.appendChild(h);
          const w = document.createElement("div");
          w.id = "audit-views-control-wide-strip";
          w.textContent = "CONTROL one pixel wide strip for self-test with deliberately long text";
          w.setAttribute("style", "position:absolute;width:1px;height:200px;overflow:hidden;white-space:nowrap");
          document.body.appendChild(w);
          const f = document.createElement("div");
          f.id = "audit-views-control-flat-strip";
          f.textContent = "CONTROL one pixel tall strip for self-test with deliberately long text that must overflow";
          f.setAttribute("style", "position:absolute;width:200px;height:1px;overflow:hidden;white-space:nowrap");
          document.body.appendChild(f);
          const two = document.createElement("div");
          two.id = "audit-views-control-two-px-strip";
          two.textContent = "CONTROL two pixel wide strip for self-test with deliberately long text";
          two.setAttribute("style", "position:absolute;width:2px;height:200px;overflow:hidden;white-space:nowrap");
          document.body.appendChild(two);
        })()`);
        const control = await clipWalk();
        const truncatedFlagged = control.clipped.some((c) => c.text.includes("CONTROL deliberately truncated"));
        const onePxNotFlagged = !control.clipped.some((c) => c.text.includes("CONTROL deliberately hidden"));
        // Delta is exactly 3: the 1x1 control plus the two
        // 1px strips (both skipped, like sr-only descendants).
        // The 2px strip is NOT skipped — it is flagged — so it
        // does not add to the delta.
        const onePxSkippedDeltaOk =
          control.hidden1pxSkipped - baseline.hidden1pxSkipped === 3 &&
          control.hidden1px.some((h) => h.text.includes("CONTROL deliberately hidden"));
        const wideStripSkipped = !control.clipped.some((c) => c.text.includes("CONTROL one pixel wide strip"));
        const flatStripSkipped = !control.clipped.some((c) => c.text.includes("CONTROL one pixel tall strip"));
        const twoPxStripFlagged = control.clipped.some(
          (c) => c.kind === "text_truncated" && c.text.includes("CONTROL two pixel wide strip"),
        );
        report.selfTest = { truncatedFlagged, onePxNotFlagged, onePxSkippedDeltaOk, wideStripSkipped, flatStripSkipped, twoPxStripFlagged };
        if (truncatedFlagged) pass("self-test: real truncation still flagged");
        else fail("self-test: real truncation NOT flagged (control broken)");
        if (onePxNotFlagged) pass("self-test: 1px element not flagged");
        else fail("self-test: 1px element flagged (exclusion broken)");
        if (onePxSkippedDeltaOk) pass("self-test: 1px skips counted exactly (+3) and recorded");
        else fail("self-test: 1px skip delta/sample wrong", `baseline ${baseline.hidden1pxSkipped}, control ${control.hidden1pxSkipped}`);
        if (wideStripSkipped) pass("self-test: 1x200 strip skipped (1px in one dimension)");
        else fail("self-test: 1x200 strip flagged (should be skipped like sr-only descendants)");
        if (flatStripSkipped) pass("self-test: 200x1 strip skipped (1px in one dimension)");
        else fail("self-test: 200x1 strip flagged (should be skipped like sr-only descendants)");
        if (twoPxStripFlagged) pass("self-test: 2x200 strip flagged (boundary pinned at 1px)");
        else fail("self-test: 2x200 strip NOT flagged (guard swallowing past 1px)");
        await evaluate(`(() => {
          document.getElementById("audit-views-control-truncated")?.remove();
          document.getElementById("audit-views-control-1px")?.remove();
          document.getElementById("audit-views-control-wide-strip")?.remove();
          document.getElementById("audit-views-control-flat-strip")?.remove();
          document.getElementById("audit-views-control-two-px-strip")?.remove();
        })()`);
      }
    }
  }
} finally {
  try {
    sessionId = undefined;
    await cdp("Browser.close");
  } catch {
    chrome.kill();
  }
  server.stop(true);
}

await writeFile(join(outDir, "report.json"), JSON.stringify(report, null, 2));
console.log(`\nreport: ${join(outDir, "report.json")}`);
console.log(
  failures === 0
    ? "AUDIT-VIEWS: all views clean"
    : `AUDIT-VIEWS: ${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
