// Bundle and run the packaged verification harness:
//   1. The tax census (329 fixtures), chunked across processes via
//      packaged/taxtest.ts — the single-process suite builds multiple
//      GB of fixture state and is OOM-killed on this machine (the
//      pure source runner dies identically; the live app likewise
//      cannot run it inside one worker call — standing limitation
//      S-2, and prior live verification ran it sliced too).
//   2. packaged/harness.ts — every other suite through the packaged
//      dispatcher, plus seeded pricing, backup/restore interop,
//      persistence, and the CAS spot check.
// Both bundles use the same resolver seams as the browser build.
// Usage: bun ./run-harness.mjs
import { join } from "node:path";
import { packagedDir, packagedPlugins } from "./build-shared.mjs";

const outdir = join(packagedDir, ".harness");
const result = await Bun.build({
  entrypoints: [join(packagedDir, "harness.ts"), join(packagedDir, "taxtest.ts")],
  outdir,
  target: "bun",
  plugins: packagedPlugins(),
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const CHUNKS = 6;
let taxTotal = 0;
let taxPassed = 0;
let taxOk = true;
for (let i = 0; i < CHUNKS; i++) {
  const proc = Bun.spawn(["bun", join(outdir, "taxtest.js")], {
    cwd: packagedDir,
    env: {
      ...process.env,
      FPKG_CHUNK: String(i),
      FPKG_CHUNKS: String(CHUNKS),
    },
    stdout: "pipe",
    stderr: "inherit",
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  const line = out.trim().split("\n").pop() ?? "";
  try {
    const parsed = JSON.parse(line);
    taxTotal += parsed.total;
    taxPassed += parsed.passed;
    console.log(
      `tax chunk ${i}: ${parsed.passed}/${parsed.total} passed, teeth ${parsed.teethOk ? "ok" : "FAILED"}${parsed.failedIds.length ? `, failures: ${parsed.failedIds.join(", ")}` : ""}`,
    );
    if (code !== 0 || parsed.passed !== parsed.total || !parsed.teethOk) taxOk = false;
  } catch {
    console.error(`tax chunk ${i}: unparseable output (exit ${code}): ${line.slice(0, 200)}`);
    taxOk = false;
  }
}
console.log(`tax census: ${taxPassed}/${taxTotal} fixtures passed`);
if (!taxOk || taxTotal !== 329 || taxPassed !== 329) {
  console.error("harness: tax census failed");
  process.exit(1);
}

const proc = Bun.spawn(["bun", join(outdir, "harness.js")], {
  cwd: packagedDir,
  env: {
    ...process.env,
    FPKG_WASM: join(packagedDir, "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
    FPKG_SKIP: "tax",
  },
  stdout: "inherit",
  stderr: "inherit",
});
const code = await proc.exited;
if (code !== 0) {
  console.error(`harness: main process exited ${code}`);
  process.exit(code);
}
console.log("harness: all processes passed");
