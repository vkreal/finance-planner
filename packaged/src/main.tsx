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
//   4. Append the packaged-only portable-backup panel (contract
//      v60, F5): download a passphrase-encrypted .mstbak of the
//      current data, or import one from any install.
//
// Any fetch that is not an action POST passes through to the real
// fetch untouched (in practice the packaged app makes none: there is
// no backend, and the probe verifies zero network action calls).
//
// If the stored database cannot be loaded (corrupt or incomplete —
// the generation store's recovery state, contract v60 F2), boot
// stops BEFORE the client loads and shows the recovery message:
// the stored keys are preserved untouched for recovery, never
// silently replaced with an empty database.
//
// window.__fpkg exposes the dispatcher for the headless browser probe
// and for debugging; it offers nothing the app's own UI cannot do.
import { spaceQueryClient } from "@hatch/space-sdk/client";
// @ts-ignore - bun file loader emits the sql.js wasm binary as an asset.
import sqlWasmUrl from "sql.js/dist/sql-wasm.wasm";
import { createRuntime, type PackagedRuntime } from "./runtime";
import { StoreRecoveryRequiredError } from "./localDb";
import { localStorageStore } from "./storage";

declare global {
  interface Window {
    __fpkg?: {
      ready: boolean;
      runtime?: PackagedRuntime;
      error?: string;
    };
  }
}

function showBootFailure(message: string): void {
  const div = document.createElement("div");
  div.setAttribute("role", "alert");
  div.style.cssText =
    "max-width:34rem;margin:3rem auto;padding:1.25rem 1.5rem;font-family:Georgia,serif;line-height:1.55;color:#1c2420;background:#fffdf7;border:1px solid #ddd5c2;border-radius:10px;";
  const h = document.createElement("h1");
  h.textContent = "Your saved data needs recovery";
  h.style.cssText = "font-size:1.25rem;margin:0 0 0.5rem;";
  const p = document.createElement("p");
  p.textContent = message;
  const p2 = document.createElement("p");
  p2.textContent =
    "Nothing was changed or deleted — the stored data is exactly as it was. " +
    "Reloading will not fix this; keep this browser profile as it is and get help recovering the stored database before using the app again.";
  div.append(h, p, p2);
  document.body.replaceChildren(div);
}

let runtime: PackagedRuntime | null = null;
try {
  runtime = await createRuntime({
    store: localStorageStore(),
    wasmUrl: sqlWasmUrl as string,
    onInvalidateQueries: () => {
      void spaceQueryClient.invalidateQueries();
    },
  });
} catch (err) {
  const message =
    err instanceof Error ? err.message : "The stored database could not be loaded.";
  window.__fpkg = { ready: false, error: message };
  if (err instanceof StoreRecoveryRequiredError) {
    showBootFailure(message);
  } else {
    showBootFailure(`The app could not start: ${message}`);
  }
}

if (runtime) {
  const rt = runtime;
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
      const result = await rt.dispatch(action, args);
      return new Response(result.body, {
        status: result.status,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input as never, init);
  };

  window.__fpkg = { ready: true, runtime: rt };

  await import("../../client/src/main.tsx");

  installPortableBackupPanel(rt);
}

/** The packaged-only portable backup workflow (contract v60, F5):
    a small panel appended after the app. Export downloads a
    .mstbak file holding the current dataset encrypted under a
    passphrase the user chooses; import takes such a file from
    ANY install, decrypts it with its passphrase, and restores it
    through the app's validated restorebackup. The passphrase is
    the only key — it is never stored, and a lost passphrase
    means a lost file. */
function installPortableBackupPanel(rt: PackagedRuntime): void {
  const panel = document.createElement("section");
  panel.setAttribute("aria-label", "Portable backup");
  panel.style.cssText =
    "max-width:72rem;margin:1.5rem auto 2.5rem;padding:1rem 1.25rem;font-family:inherit;color:var(--text,#1c2420);background:var(--surface,#fffdf7);border:1px solid var(--border,#ddd5c2);border-radius:10px;";

  const h = document.createElement("h2");
  h.textContent = "Portable backup (.mstbak)";
  h.style.cssText = "font-size:1rem;margin:0 0 0.35rem;";
  const intro = document.createElement("p");
  intro.textContent =
    "Download your data as an encrypted backup file you can restore here or on any other install of this app. " +
    "The passphrase you choose is the only key: it is never stored, and if you lose it the file cannot be opened.";
  intro.style.cssText = "margin:0 0 0.75rem;font-size:0.875rem;line-height:1.5;";

  const passLabel = document.createElement("label");
  passLabel.textContent = "Backup passphrase ";
  const pass = document.createElement("input");
  pass.type = "password";
  pass.setAttribute("aria-label", "Backup passphrase");
  pass.autocomplete = "new-password";
  passLabel.append(pass);

  const exportBtn = document.createElement("button");
  exportBtn.type = "button";
  exportBtn.textContent = "Download encrypted backup";

  const fileLabel = document.createElement("label");
  fileLabel.textContent = "Backup file to import ";
  const file = document.createElement("input");
  file.type = "file";
  file.accept = ".mstbak,application/json";
  file.setAttribute("aria-label", "Backup file to import");
  fileLabel.append(file);

  const importBtn = document.createElement("button");
  importBtn.type = "button";
  importBtn.textContent = "Import backup file";

  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.style.cssText = "margin:0.75rem 0 0;font-size:0.875rem;line-height:1.5;";

  const row = document.createElement("div");
  row.style.cssText =
    "display:flex;flex-wrap:wrap;gap:0.75rem;align-items:end;";
  row.append(passLabel, exportBtn, fileLabel, importBtn);
  panel.append(h, intro, row, status);
  document.body.append(panel);

  exportBtn.addEventListener("click", () => {
    void (async () => {
      try {
        if (pass.value.length < 8) {
          status.textContent = "Choose a passphrase of at least 8 characters first.";
          return;
        }
        const { filename, contents } = await rt.exportPortableBackup(pass.value);
        const url = URL.createObjectURL(
          new Blob([contents], { type: "application/json" }),
        );
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        status.textContent = `Backup downloaded as ${filename}. Keep the file and its passphrase together — both are needed to restore it.`;
      } catch (err) {
        status.textContent = `Export failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    })();
  });

  importBtn.addEventListener("click", () => {
    void (async () => {
      try {
        const chosen = file.files?.[0];
        if (!chosen) {
          status.textContent = "Choose a backup file first.";
          return;
        }
        if (!pass.value) {
          status.textContent = "Enter the backup's passphrase first.";
          return;
        }
        const contents = await chosen.text();
        const restored = await rt.importPortableBackup(contents, pass.value);
        status.textContent = `Backup restored (${restored.authenticated ? "authenticity verified" : "unauthenticated backup"}). Reloading…`;
        setTimeout(() => window.location.reload(), 800);
      } catch (err) {
        status.textContent = `Import failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    })();
  });
}
