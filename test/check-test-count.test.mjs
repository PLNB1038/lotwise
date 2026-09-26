// scripts/check-test-count.mjs turns the README's drifting "N tests, all green" claim into
// a red run. These tests pin the contracts that make the check trustworthy without running
// the suite here (the checker runs it for real on its own): the public-file filter mirrors
// the CI glob test/*.test.mjs, the TAP trailer parse fails loudly instead of guessing, and
// every rejection names both numbers plus the README file:line — or the operator cannot
// act on a red CI build.
import test from "node:test";
import assert from "node:assert/strict";
import {
  listPublicTestFiles,
  parseTapSummary,
  readmeClaim,
  mismatchMessage,
  verdict,
} from "../scripts/check-test-count.mjs";

const TAP_OK = [
  "TAP version 13",
  "ok 1 - something holds",
  "1..823",
  "# tests 823",
  "# suites 0",
  "# pass 823",
  "# fail 0",
].join("\n");

test("check-test-count: the public-file filter mirrors the CI glob test/*.test.mjs (direct children only)", () => {
  const files = listPublicTestFiles([
    "test/lots.test.mjs",
    "test/fixtures/helper.mjs", // not *.test.mjs — a fixture, never counted
    "test/nested/deep.test.mjs", // a subdirectory — the glob never matches it
    "test/wallet.test.mjs", // a second legitimate suite file
    "scripts/check-test-count.mjs", // outside test/
  ]);
  assert.deepEqual(files.sort(), ["test/lots.test.mjs", "test/wallet.test.mjs"]);
});

test("check-test-count: the TAP trailer is parsed; a missing trailer is a loud null, not a false green", () => {
  assert.deepEqual(parseTapSummary(TAP_OK), { tests: 823, fail: 0 });
  assert.deepEqual(parseTapSummary("# tests 5\n# fail 2"), { tests: 5, fail: 2 });
  assert.equal(parseTapSummary("ok 1 - everything passed, no trailer"), null);
  assert.equal(parseTapSummary(""), null);
});

test("check-test-count: the README claim is the first 'N tests' occurrence with its 1-based line", () => {
  const readme = [
    "[![tests](https://example/badge.svg)](https://example/workflows/tests.yml)",
    "",
    "823 tests, all green (plain `node:test`).",
  ].join("\n");
  assert.deepEqual(readmeClaim(readme), { file: "README.md", count: 823, line: 3 });
  assert.equal(readmeClaim("no claim in this text\n"), null);
});

test("check-test-count: the mismatch message names both numbers and the file:line", () => {
  const msg = mismatchMessage({ file: "README.md", count: 823, line: 127 }, 824);
  assert.match(msg, /README\.md:127/, "the operator lands on the exact line");
  assert.match(msg, /\b823\b/, "what the README claims");
  assert.match(msg, /\b824\b/, "what the run reports");
  assert.match(msg, /Update the count in README\.md/, "the fix is spelled out");
});

test("check-test-count: canary — a matching claim is silent success (exit 0, empty message)", () => {
  assert.deepEqual(verdict({ file: "README.md", count: 823, line: 127 }, { tests: 823, fail: 0 }), {
    code: 0,
    message: "",
  });
});

test("check-test-count: canary — an off-by-one in either direction is caught with both numbers", () => {
  for (const [claimed, reported] of [
    [823, 824], // a test was added, the bump was forgotten
    [823, 822], // a test was removed (the rarer, sneakier direction)
  ]) {
    const v = verdict({ file: "README.md", count: claimed, line: 127 }, { tests: reported, fail: 0 });
    assert.equal(v.code, 1, `${claimed} vs ${reported} must be a red run`);
    assert.match(v.message, /README\.md:127/);
    assert.match(v.message, new RegExp(`\\b${claimed}\\b`));
    assert.match(v.message, new RegExp(`\\b${reported}\\b`));
  }
});

test("check-test-count: a red run (fail > 0) is not evaluated — the count is not compared", () => {
  const v = verdict({ file: "README.md", count: 823, line: 127 }, { tests: 823, fail: 2 });
  assert.equal(v.code, 1);
  assert.match(v.message, /red run/, "the reason says the claim was skipped, not that it passed");
  assert.doesNotMatch(v.message, /823 tests.*all green/);
});

test("check-test-count: a README without the claim is a rejection that names the file", () => {
  const v = verdict(null, { tests: 823, fail: 0 });
  assert.equal(v.code, 1);
  assert.match(v.message, /README\.md/);
  assert.match(v.message, /no "N tests" claim/);
});
