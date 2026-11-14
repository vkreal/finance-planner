// cli.test.ts — the CLI contract: stdout carries ONLY the JSON envelope.
//
// Regression (review pass 1, S1): dispatchTool used to console.log a
// "[assistant-api] tool=…" line to stdout, which broke JSON parsing
// of CLI output. The dispatch log now goes to stderr; these tests pin
// stdout purity plus the exit codes (0 ok, 2 error envelope).

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FICTIONAL } from "./helpers";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");

async function runCli(input: Record<string, unknown>): Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
}> {
  const dir = await mkdtemp(join(tmpdir(), "assistant-api-cli-"));
  try {
    const inputPath = join(dir, "input.json");
    await writeFile(inputPath, JSON.stringify(input));
    const proc = Bun.spawn(
      [process.execPath, CLI_PATH, "retirement_calculate", inputPath],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("CLI stdout purity", () => {
  test("calculate prints only the JSON envelope on stdout, exit 0", async () => {
    const { stdout, stderr, code } = await runCli({ ...FICTIONAL });
    expect(stdout.trimStart().startsWith("{")).toBe(true);
    const envelope = JSON.parse(stdout) as Record<string, unknown>;
    expect(envelope.ok).toBe(true);
    expect(code).toBe(0);
    // The dispatch log line lives on stderr now, never on stdout.
    expect(stdout).not.toContain("[assistant-api]");
    expect(stderr).toContain("[assistant-api] tool=retirement_calculate");
  });

  test("missing input exits 2 with an ok:false envelope on stdout", async () => {
    const { stdout, code } = await runCli({});
    expect(stdout.trimStart().startsWith("{")).toBe(true);
    const envelope = JSON.parse(stdout) as Record<string, unknown>;
    expect(envelope.ok).toBe(false);
    expect(
      (envelope.error as Record<string, unknown>).code,
    ).toBe("missing_input");
    expect(code).toBe(2);
  });
});
