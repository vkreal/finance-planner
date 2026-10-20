// Build the packaged (static, localStorage) Finance Planner site into
// packaged/dist/. Run with: bun ./build.mjs  (or `bun run build` in
// packaged/). This is a SEPARATE build target from the live artifact:
// it never touches client/dist or server/dist, and the live artifact
// continues to build and ship only through the web-artifact builder.
//
// The bundle is the live client's own entry (client/src/main.tsx,
// reached through packaged/src/main.tsx) plus the real server action
// module compiled for the browser, with the seams swapped by the
// resolver plugin in build-shared.mjs.
import { basename, join } from "node:path";
import { rm } from "node:fs/promises";
import tailwindPlugin from "bun-plugin-tailwind";
import { packagedDir, packagedPlugins } from "./build-shared.mjs";

const OUTDIR = join(packagedDir, "dist");

await rm(OUTDIR, { force: true, recursive: true });

const result = await Bun.build({
  entrypoints: [join(packagedDir, "index.html")],
  outdir: OUTDIR,
  target: "browser",
  minify: true,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  naming: {
    asset: "assets/[name]-[hash].[ext]",
    chunk: "assets/[name]-[hash].[ext]",
    entry: "[name].[ext]",
  },
  loader: {
    ".wasm": "file",
  },
  plugins: [...packagedPlugins(), tailwindPlugin],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// Same asset-URL fixup the SDK's own client bundler performs: Bun
// writes imported assets to assets/<name>-<hash>.<ext> but emits their
// URLs as bare ./<name>-<hash>.<ext>; re-prefix them so the emitted
// JS/CSS/HTML points at the real locations.
const assetFiles = result.outputs
  .filter((output) => output.kind === "asset")
  .map((output) => basename(output.path));
for (const output of result.outputs) {
  if (!/\.(js|css|html)$/.test(output.path)) continue;
  let text = await output.text();
  let changed = false;
  for (const name of assetFiles) {
    const bare = `./${name}`;
    if (text.includes(bare)) {
      text = text.split(bare).join(`./assets/${name}`);
      changed = true;
    }
  }
  if (changed) await Bun.write(output.path, text);
}

let total = 0;
for (const output of result.outputs) {
  const bytes = (await Bun.file(output.path).arrayBuffer()).byteLength;
  total += bytes;
  console.log(
    `${output.path.replace(OUTDIR, "dist")}  ${(bytes / 1024).toFixed(1)} KiB`,
  );
}
console.log(`packaged/dist total: ${(total / 1024).toFixed(1)} KiB`);
