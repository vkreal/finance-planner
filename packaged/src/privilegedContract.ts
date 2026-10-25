// Packaged-build stand-in for the virtual "@space/privileged" module.
//
// In the live build, the artifact builder generates
// server/.generated/privileged.contract.ts from server/src/privileged.ts
// and the server bundle resolves "@space/privileged" to it. The packaged
// build resolves "@space/privileged" to this file instead (see the
// resolver plugin in packaged/build-shared.mjs). The contract specs
// below are copied verbatim from server/src/privileged.ts (lines 46-92
// at the time of the packaged build) — same names, same zod schemas —
// so the server actions' ctx.executePrivileged(...) calls validate
// identically. The HANDLERS behind these contracts are the local
// implementations in packaged/src/localPrivileged.ts.
import { definePrivilegedContracts, z } from "./spaceSdkShim";

export const privileged = definePrivilegedContracts({
  ensureEncryptionKey: {
    request: z.object({ spaceDir: z.string().min(1) }),
    response: z.object({ keyBase64: z.string() }),
  },
  listBackups: {
    request: z.object({ spaceDir: z.string().min(1) }),
    response: z.object({
      backups: z.array(
        z.object({
          name: z.string(),
          sizeBytes: z.number(),
          modifiedMs: z.number(),
          source: z.enum(["own", "legacy"]),
        }),
      ),
    }),
  },
  deleteBackup: {
    request: z.object({
      spaceDir: z.string().min(1),
      filename: z.string().min(1),
    }),
    response: z.object({
      ok: z.boolean(),
      reason: z.string(),
    }),
  },
  deleteAllBackups: {
    request: z.object({ spaceDir: z.string().min(1) }),
    response: z.object({
      ok: z.boolean(),
      reason: z.string(),
      deletedCount: z.number(),
    }),
  },
  createBackup: {
    request: z.object({
      spaceDir: z.string().min(1),
      payloadJson: z.string().min(1),
    }),
    response: z.object({
      ok: z.boolean(),
      filename: z.string().nullable(),
      reason: z.string(),
      prunedCount: z.number(),
    }),
  },
});
