# Finance Planner — packaged (static / localStorage) build

A fully static build of the Finance Planner that runs entirely in a
visitor's browser: same screens, same engine, same fixtures as the
live app, with **all data in browser localStorage and no backend**.

This is an *additional* build target. The live artifact (the owner's
server-backed app) builds and ships only through the web-artifact
builder and is untouched by everything in this folder: no live source
file is modified, and the packaged bundle is never shipped through the
builder interface.

## How it works

The client talks to the server only through `client/src/api.ts`
(~90 actions over one POST endpoint). The packaged build keeps every
live source file unchanged and swaps the three server-only seams
behind their existing interfaces:

| Seam | Live | Packaged |
| --- | --- | --- |
| Transport | HTTP POST to the space worker | `packaged/src/main.tsx` installs a `fetch` interceptor before the client bundle loads and routes action POSTs to a local dispatcher |
| Action handlers | `server/src/actions.ts` in the worker | **the same module**, compiled into the browser bundle, dispatched by `packaged/src/runtime.ts` with the worker's wire semantics ({data} envelope, raw zod issues on validation failure) |
| Database (`ctx.db()`) | Drizzle over libSQL | Drizzle's sqlite-proxy driver over **sql.js** (SQLite/WASM), schema and migrations identical (`server/src/schema.ts`, `drizzle/*.sql` inlined at build time); the DB image persists to localStorage as base64 chunks after every action |
| Privileged ops (`ctx.executePrivileged`) | `server/src/privileged.ts` (node fs) | `packaged/src/localPrivileged.ts`: the at-rest encryption key and the backup vault live in localStorage; backup filename/rotation/delete rules reuse `server/src/backupCore.ts` verbatim |
| `@hatch/space-sdk` | root `package.json` file: install | `packaged/src/spaceSdkShim.ts` re-exports the vendored copy in `packaged/vendor/space-sdk/` (SDK 0.13.0 — refresh it if the SDK revs) |

On first boot the packaged app seeds the sample data by calling the
app's own seed actions (`seedExamples`, `seedNetWorth`) once — the
same actions the in-app seed buttons call.

### Known differences from the live app (by design or by platform)

- **No sync / no server.** Data lives in one browser's localStorage
  (~5–10 MB origin quota). Export/import files are the move/backup
  path.
- **Encryption-key custody.** At-rest values use the same `enc:v1:`
  AES-256-GCM format, but the key is generated and stored in
  localStorage beside the data (the live app keeps it in a server-side
  `.secrets/` file). It protects exports and casual inspection, not a
  attacker with full localStorage access. Backup *payloads*
  interoperate both directions regardless: restore re-encrypts under
  the importing app's key.
- **Backup (.mstbak) key custody.** Envelopes are byte-format
  identical (RSA-4096 OAEP-SHA256 + AES-256-GCM) and decryptable with
  the same offline tooling, but the packaged build generates a fresh
  RSA-4096 pair per install and keeps the private half in localStorage
  (exportable from there); the live app wraps with a public key whose
  private half never leaves the owner's offline store.
- **Transport error envelope.** Handler errors surface as
  `500 {error: message}` JSON; the live worker's outer envelope can
  differ in shape (the success and validation paths are byte-identical,
  including the raw zod issues array on a 400).
- `ctx.agent` / `ctx.inference` / `ctx.tool` / `ctx.blobs` are stubs
  that throw if called — no action in this app uses them.

## Build & deploy

```sh
cd packaged
bun install
bun run build     # -> packaged/dist/ (static site, ~4 MB)
```

GitHub Pages: `.github/workflows/pages.yml` runs the same build on
every push to `main` and deploys `packaged/dist/` with the official
Pages actions. (The workflow briefly points the root `package.json`
SDK dependency at `packaged/vendor/space-sdk/` so the runner can
install the root dependencies the client stylesheet needs; the
committed tree is unchanged.) One manual step: repo **Settings →
Pages → Source: GitHub Actions**.

## Verification

```sh
cd packaged
bun run harness   # fixture census + seeded pricing + backup/restore
                  # round trip through the packaged dispatcher
bun run probe     # headless-Chromium probe of packaged/dist:
                  # zero network action calls, sample data, pinned
                  # figures, edit -> reload persistence, export ->
                  # wipe -> restore
```
