// Chunked tax-fixture census for the packaged build.
//
// The full tax suite builds multiple GB of fixture
// state when run in one process and is OOM-killed on this machine —
// the pure source runner (server/src/taxFixtures.ts runTaxFixtures)
// dies the same way with no adapter code involved, and the live app
// likewise cannot run the suite inside one worker call (standing
// limitation S-2; prior live verification also ran it sliced). So the
// census runs the SAME fixture module the packaged bundle ships,
// sliced into chunks, one process per chunk, aggregating the counts.
//
// Each chunk also runs a teeth check: the chunk's first case is
// re-run with one corrupted expected value and must fail — proving
// the fixtures can still catch a wrong number.
//
// Env: FPKG_CHUNK (0-based chunk index), FPKG_CHUNKS (chunk count).
import { TAX_FIXTURES, runTaxFixtures } from "../server/src/taxFixtures";

const chunkIdx = Number(process.env.FPKG_CHUNK ?? "0");
const chunkCount = Number(process.env.FPKG_CHUNKS ?? "6");
const per = Math.ceil(TAX_FIXTURES.length / chunkCount);
const slice = TAX_FIXTURES.slice(chunkIdx * per, (chunkIdx + 1) * per);

const clean = runTaxFixtures(slice);
const failedIds = clean.results.filter((r) => !r.pass).map((r) => r.id);

let teethOk = false;
if (slice.length > 0) {
  const first = slice[0];
  const field = Object.keys(first.expected)[0];
  const corrupted = {
    ...first,
    expected: {
      ...first.expected,
      [field]:
        typeof first.expected[field] === "number"
          ? (first.expected[field] as number) + 1
          : "corrupted",
    },
  };
  const teeth = runTaxFixtures([corrupted as never]);
  teethOk = teeth.passed === 0 && teeth.results[0]?.pass === false;
}

console.log(
  JSON.stringify({
    chunk: chunkIdx,
    total: clean.total,
    passed: clean.passed,
    failedIds,
    teethOk,
    // The suite's OWN fixture count, read from the same bundled
    // fixture module the chunks slice — run-harness.mjs derives
    // its expected census total from this instead of hard-coding
    // a number that silently stales as fixtures are added
    // (round-7 fix H-1).
    suiteTotal: TAX_FIXTURES.length,
  }),
);
process.exit(clean.passed === clean.total && teethOk ? 0 : 1);
