// The historical dataset lives with the retirement engines in
// server/src/retirementData.ts, so the client view and the
// server-side accuracy self-check read one and the same copy.
// This module only re-exports it under the client's original path.
export * from "@space/server/retirementData";
