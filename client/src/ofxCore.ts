// The OFX/QFX statement parsing core lives with the server
// cores in server/src/ofxCore.ts, so the import panels and the
// server-side accuracy fixtures run one and the same copy.
// This module only re-exports it under the client's local path
// (the importParseCore pattern).
export * from "@space/server/ofxCore";
