
// — killer tests of the mutation audit F2 (32 mutations across the code of rounds 13–14,
// 6 survived — all clean suite gaps, the prod code unchanged; each is closed here).
//   F09 acquireSyncLock: the staleness boundary — EXACTLY staleMs is still "fresh" (a break strictly later)
//   F10 saveJournalMerged: the lock is cleaned up after itself after a successful write
//   F12 degradation without a lock: a FOREIGN fresh lock is not torn down (fd===null ⇒ finally stays silent)
//   F16 assertHostResolvable: lookup is called with the passed host (not a constant)
//   F27 the issuer dictionary in the 400 is sorted — the exact string is stable across instances
//   F31 enrich-decimals: a flag without a value — exit 2 in one line, no stack
//   F11 (a bonus pin): saveJournalMerged does not mutate the passed journal object
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { saveJournalMerged } from "../src/events/journal.mjs";
import { assertHostResolvable } from "../src/cli/flags.mjs";
import { createApiServer } from "../src/api/server.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = (m) => ({ lastEffective: m, observedAt: "2026-09-24T00:00:00.000Z", events: [] });

const tmpJournal = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lw-f2-"));
  return { dir, jp: path.join(dir, "onchain-journal.json"), lock: path.join(dir, "onchain-journal.json.lock") };
};

test("journal lock: the staleness boundary — within ±staleMs it is fresh, past it a break (F09)", () => {
  // The exact boundary (age == staleMs) is not portably checkable: NTFS rounds the mtime
  // UP (age slightly smaller), the ext family truncates to 1µs DOWN (age slightly bigger —
  // the H1 probe on live Linux, deltaNs=-1000). We pin points DELIBERATELY inside.
  const { dir, jp, lock } = tmpJournal();
  try {
    const staleMs = 10_000;
    const now = Date.now();
    writeFileSync(jp, JSON.stringify({ A: entry("1") }));
    writeFileSync(lock, "");
    utimesSync(lock, new Date(now - staleMs + 25), new Date(now - staleMs + 25)); // 25ms BEFORE the boundary
    saveJournalMerged(jp, { B: entry("2") }, { staleMs, attempts: 1, retryPauseMs: 1, nowMs: now });
    assert.ok(existsSync(lock), "the lock inside the boundary is NOT broken and survived the degraded write");

    utimesSync(lock, new Date(now - staleMs - 60_000), new Date(now - staleMs - 60_000)); // explicitly stale
    saveJournalMerged(jp, { C: entry("3") }, { staleMs, attempts: 1, retryPauseMs: 1, nowMs: now });
    assert.ok(!existsSync(lock), "the stale one (past the boundary) is broken and removed by our finally");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("journal lock: after a successful write there is no lock on disk (F10)", () => {
  const { dir, jp, lock } = tmpJournal();
  try {
    saveJournalMerged(jp, { A: entry("1") });
    assert.ok(!existsSync(lock), "the lock is removed — the next writer does not retry for 3.5s and does not accumulate *.lock");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("journal lock: degradation without a lock does NOT tear down a foreign fresh lock (F12)", () => {
  const { dir, jp, lock } = tmpJournal();
  try {
    writeFileSync(jp, JSON.stringify({ A: entry("1") }));
    writeFileSync(lock, "foreign-live"); // a foreign LIVE lock (not stale)
    saveJournalMerged(jp, { B: entry("2") }, { staleMs: 10_000, attempts: 2, retryPauseMs: 1 });
    assert.ok(existsSync(lock), "the foreign fresh lock is in place — fd===null stays silent in finally");
    assert.equal(readFileSync(lock, "utf8"), "foreign-live", "and is not overwritten");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("flags: assertHostResolvable resolves EXACTLY the passed host (F16)", async () => {
  const seen = [];
  const mock = async (h) => {
    seen.push(h);
    if (h === "no-such-host.invalid") {
      const e = new Error("getaddrinfo ENOTFOUND");
      e.code = "ENOTFOUND";
      throw e;
    }
    return { address: "1.2.3.4" };
  };
  await assertHostResolvable("example.com", mock);
  await assert.rejects(() => assertHostResolvable("no-such-host.invalid", mock), /ENOTFOUND/);
  assert.deepEqual(seen, ["example.com", "no-such-host.invalid"], "lookup received the arguments, not a constant");
});

test("api: the issuer dictionary in the 400 is sorted — the string is stable (F27)", async () => {
  const M = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
  // An UNSORTED registry order: zeta goes before alpha
  const registry = [
    { symbol: "Zx", name: "z", issuer: "zeta", mint: M, decimals: 8 },
    { symbol: "Ax", name: "a", issuer: "alpha", mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", decimals: 8 },
  ];
  const server = await createApiServer({ registry });
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/tokens?issuer=${encodeURIComponent("garbage")}`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes("valid: alpha, zeta"), `the dictionary is sorted regardless of the registry order (got: ${body.error})`);
  } finally {
    server.close();
  }
});

test("cli: enrich-decimals --registry without a value — exit 2, one line, no stack (F31)", async () => {
  const child = spawn(process.execPath, [path.join(ROOT, "scripts", "enrich-decimals.mjs"), "--registry"]);
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += c; });
  child.stdout.on("data", () => {});
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 2, `the contract error code of a flag (stderr: ${stderr.slice(0, 200)})`);
  assert.match(stderr, /--registry requires a value/);
  assert.ok(!/TypeError|at /.test(stderr), "a clean refusal, not a raw stack from readFileSync(null)");
});

test("journal: saveJournalMerged does not mutate the passed object (the F11 pin)", () => {
  const { dir, jp } = tmpJournal();
  try {
    writeFileSync(jp, JSON.stringify({ FOREIGN: entry("9") }));
    const input = { MINE: entry("5") };
    const snapshot = JSON.parse(JSON.stringify(input));
    saveJournalMerged(jp, input);
    assert.deepEqual(input, snapshot, "the input is not aliased with the merged result");
    const after = JSON.parse(readFileSync(jp, "utf8"));
    assert.ok(after.FOREIGN && after.MINE, "the merge is still correct");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
