// Shared bun build plugins for the packaged build (used by both
// build.mjs for the browser bundle and run-harness.mjs for the
// headless verification harness, so both compile the same module
// graph with the same seams):
//
//   "@hatch/space-sdk"        -> packaged/src/spaceSdkShim.ts
//                                (re-exports the vendored SDK's
//                                server-contract module)
//   "@hatch/space-sdk/client" -> packaged/vendor/space-sdk/dist/client.js
//   "@space/privileged"       -> packaged/src/privilegedContract.ts
//   "packaged-migrations"     -> virtual module inlining drizzle/*.sql
//                                from the live tree, filename order
//   every other bare import   -> resolved from packaged/node_modules,
//                                so the packaged bundle is hermetic:
//                                it never picks up the live tree's
//                                installed packages (the two installs
//                                pin identical versions regardless)
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const packagedDir = import.meta.dir;
export const repoRoot = join(packagedDir, "..");

export function packagedPlugins() {
  return [
    {
      name: "packaged-resolver",
      setup(build) {
        build.onResolve({ filter: /^packaged-migrations$/ }, () => ({
          path: "packaged-migrations",
          namespace: "pkgmig",
        }));
        build.onLoad({ filter: /.*/, namespace: "pkgmig" }, () => {
          const dir = join(repoRoot, "drizzle");
          const names = readdirSync(dir)
            .filter((f) => f.endsWith(".sql"))
            .sort();
          const sqls = names.map((f) => readFileSync(join(dir, f), "utf8"));
          return {
            contents:
              `export const MIGRATION_NAMES = ${JSON.stringify(names)};\n` +
              `export const MIGRATIONS = ${JSON.stringify(sqls)};\n`,
            loader: "js",
          };
        });
        build.onResolve({ filter: /^@hatch\/space-sdk$/ }, () => ({
          path: join(packagedDir, "src", "spaceSdkShim.ts"),
        }));
        build.onResolve({ filter: /^@hatch\/space-sdk\/client$/ }, () => ({
          path: join(packagedDir, "vendor", "space-sdk", "dist", "client.js"),
        }));
        build.onResolve({ filter: /^@space\/privileged$/ }, () => ({
          path: join(packagedDir, "src", "privilegedContract.ts"),
        }));
        build.onResolve({ filter: /^[^./]/ }, (args) => {
          if (args.path.startsWith("node:") || args.path === "bun") {
            return undefined;
          }
          try {
            const resolved = Bun.resolveSync(args.path, packagedDir);
            // Builtins (crypto, fs, ...) resolve to their bare name —
            // leave those to Bun's own handling.
            if (!resolved.startsWith("/")) return undefined;
            return { path: resolved };
          } catch {
            return undefined;
          }
        });
      },
    },
  ];
}
