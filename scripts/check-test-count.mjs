// check-test-count — the README's "N tests, all green" claim, kept honest. The claim has
// drifted repeatedly (every test-adding commit that forgets the bump ships a stale README);
// this check turns the drift into a red run instead: it re-runs the same public suite CI
// runs and diffs the run's own count against the number in README.md.
//
// Run from the repo root:
//   node scripts/check-test-count.mjs
// Exit codes: 0 — the claim matches the run (silence is success); 1 — mismatch, a red run
// or a missing claim; 2 — launch/read error.
//
// Deliberate decisions:
// - The public tree = `git ls-files test` filtered to direct children *.test.mjs — the same
//   set the CI glob (test/*.test.mjs) expands on a fresh clone. Untracked local-only files
//   never reach the filter, so the number is identical locally and in CI.
// - The suite is re-run rather than parsed from a leftover log: one command, no state, an
//   honest number. The suite is hermetic and ~7s (see .github/workflows/tests.yml).
// - The reporter is forced to TAP: the default reporter is environment-dependent (spec on a
//   TTY, tap when piped), while the "# tests N" trailer is a stable contract to parse.
// - No auto-fix, no auto-commit: the count belongs to the commit that adds the tests, so a
//   mismatch fails and names both numbers plus the README file:line — the bump ships there.
// - A red run (fail > 0) is not evaluated: a count from a failing run is noise.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const README_PATH = "README.md";
const TEST_DIR = "test";

// The shell glob test/*.test.mjs matches direct children of test/ only — the same filter
// here. Tracked-ness is decided upstream (git ls-files); this only mirrors the glob shape.
export function listPublicTestFiles(paths) {
  return paths.filter((p) => {
    const parts = p.split(/[\\/]/);
    return parts.length === 2 && parts[0] === TEST_DIR && parts[1].endsWith(".test.mjs");
  });
}

// The trailer node --test --test-reporter=tap appends. null = the contract changed — a loud
// error (exit 2), never a false green.
export function parseTapSummary(tapText) {
  const tests = tapText.match(/^# tests (\d+)$/m);
  const fail = tapText.match(/^# fail (\d+)$/m);
  if (!tests || !fail) return null;
  return { tests: Number(tests[1]), fail: Number(fail[1]) };
}

// The README claim: the first "N tests" occurrence, with its 1-based line number.
export function readmeClaim(readmeText, file = README_PATH) {
  const m = readmeText.match(/(\d+) tests/);
  if (!m) return null;
  const line = readmeText.slice(0, m.index).split("\n").length;
  return { file, count: Number(m[1]), line };
}

// The operator-facing mismatch message: both numbers + file:line + the fix.
export function mismatchMessage(claim, reported) {
  return (
    `${claim.file}:${claim.line}: claims ${claim.count} tests, but the fresh-clone run reports ${reported}. ` +
    `Update the count in ${claim.file} (the "N tests, all green" line) and commit it with the test change.`
  );
}

// The pure decision behind the exit code: 0 + empty message when the claim is healthy
// (silence is success), 1 + the reason otherwise. IO stays in main(); this is the testable
// contract.
export function verdict(claim, summary) {
  if (summary.fail > 0) {
    return {
      code: 1,
      message: `the suite itself is red (${summary.fail} failure(s)) — the count claim is not evaluated on a red run.`,
    };
  }
  if (!claim) {
    return {
      code: 1,
      message: `no "N tests" claim found in ${README_PATH} — add one (the "N tests, all green" line).`,
    };
  }
  if (claim.count === summary.tests) return { code: 0, message: "" };
  return { code: 1, message: mismatchMessage(claim, summary.tests) };
}

// Returns the exit code (0/1/2), writes nothing to files.
export async function main() {
  const ls = spawnSync("git", ["ls-files", TEST_DIR], { encoding: "utf8" });
  if (ls.error || ls.status !== 0) {
    console.error(`[check-test-count] git ls-files failed: ${ls.error ? ls.error.message : ls.stderr}`);
    return 2;
  }
  const files = listPublicTestFiles(ls.stdout.split(/\r?\n/).filter(Boolean));
  if (files.length === 0) {
    console.error(`[check-test-count] no tracked ${TEST_DIR}/*.test.mjs files — run from the repo root?`);
    return 2;
  }
  const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...files], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (run.error) {
    console.error(`[check-test-count] could not launch the suite: ${run.error.message}`);
    return 2;
  }
  const summary = parseTapSummary(run.stdout || "");
  if (!summary) {
    console.error(
      "[check-test-count] the TAP summary (# tests N) was not found in the run output — has the node --test reporter contract changed?",
    );
    return 2;
  }
  let claim;
  try {
    claim = readmeClaim(readFileSync(README_PATH, "utf8"));
  } catch (err) {
    console.error(`[check-test-count] ${README_PATH} is unreadable: ${err.message}`);
    return 2;
  }
  const v = verdict(claim, summary);
  if (v.message) console.error(`[check-test-count] ${v.message}`);
  return v.code;
}

// CLI mode only when run directly (tests import the functions without side effects).
const invokedAs = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
const isSelf =
  import.meta.url === invokedAs ||
  (process.platform === "win32" && import.meta.url.toLowerCase() === invokedAs.toLowerCase());
if (isSelf) process.exitCode = await main(); // exitCode, not exit
