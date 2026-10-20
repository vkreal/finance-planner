// Packaged-build shim for "@hatch/space-sdk" (server surface).
//
// The live server bundle resolves "@hatch/space-sdk" to the SDK install
// pinned by the repo's root package.json. The packaged build instead
// resolves it here, and this shim re-exports the SDK's server-contract
// module from the vendored copy under packaged/vendor/space-sdk/ — the
// exact same SDK version (0.13.0) the live artifact builds against, so
// `defineAction`, `z`, and the privileged-contract helpers are the real
// implementations, not re-creations. Only the server-contract module is
// re-exported: the packaged bundle never pulls the SDK's node-side
// entry (which also wires PDF/host plumbing the static site lacks).
//
// @ts-ignore - plain JS module inside the vendored SDK copy.
export * from "../vendor/space-sdk/dist/server-contract.js";
// @ts-ignore - plain JS module inside the vendored SDK copy.
import { createDefineAction } from "../vendor/space-sdk/dist/server-contract.js";

export const defineAction = createDefineAction();
