
// — the killer pins of the H4 mutations (12 mutations across, 4 survived) + regressions
// of the attack findings:
//   M6/H4-P3 "age < -staleMs" without a pin: the age<0 mutation broke a fresh legacy lock with
//          an mtime a fraction of a ms "in the future" — the NTFS guard must tolerate it (−staleMs, 0).
//   M3     a string pid ("123") = legacy content: a fresh lock waits, NOT broken instantly.
//   M1     isPidAlive EPERM = alive (a DI seam of kill): the EPERM→false mutation would tear down
//          live foreign ownership.
//   M4     the lock content {pid} is really written (without writeSync the pid liveness is a no-op).
//   H4-P3  the eq form "--api=--evil" — a usage refusal with exit 2, not a runtime stack.
//   H4-P4  nowMs:null/NaN — injection validation: a fresh legacy lock is NOT broken.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync, readFileSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { saveJournalMerged, isPidAlive, acquireSyncLock } from "../src/events/journal.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = (m) => ({ lastEffective: m, observedAt: "2026-09-25T00:00:00.000Z", events: [] });
const tmpJournal = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lw-h4-"));
  return { dir, jp: path.join(dir, "onchain-journal.json"), lock: path.join(dir, "onchain-journal.json.lock") };
};

test("journal lock: age in (−staleMs, 0) — the \"minus-millisecond future\" of a fresh lock, NOT a break (M6)", () => {
  const { dir, jp, lock } = tmpJournal();
  try {
    const staleMs = 10_000;
    const now = Date.now();
    writeFileSync(jp, JSON.stringify({ A: entry("1") }));
    writeFileSync(lock, "legacy"); // legacy content
    utimesSync(lock, new Date(now), new Date(now));
    // nowMs 0.5ms "earlier" than the mtime: the NTFS world of a fresh lock; the guard must tolerate it
    saveJournalMerged(jp, { B: entry("2") }, { staleMs, attempts: 1, retryPauseMs: 1, nowMs: now - 0.5 });
    assert.ok(existsSync(lock), "age ∈ (−staleMs, 0) — NOT a future skew, the fresh legacy lock is intact");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("journal lock: a string pid (\"123\") — legacy content: a fresh lock waits, not broken (M3)", () => {
  const { dir, jp, lock } = tmpJournal();
  try {
    writeFileSync(jp, JSON.stringify({ A: entry("1") }));
    writeFileSync(lock, JSON.stringify({ pid: "123", createdAt: new Date().toISOString() })); // a pid STRING
    saveJournalMerged(jp, { B: entry("2") }, { staleMs: 10_000, attempts: 2, retryPauseMs: 1 });
    assert.ok(existsSync(lock), "the Number.isInteger guard must cut off the string → legacy semantics, without an instant break");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("journal lock: isPidAlive — EPERM = ALIVE (a foreign process), ESRCH = dead (M1, the DI seam)", () => {
  const eperm = (pid, sig) => {
    const e = new Error("EPERM");
    e.code = "EPERM";
    throw e;
  };
  const esrch = () => {
    const e = new Error("ESRCH");
    e.code = "ESRCH";
    throw e;
  };
  assert.equal(isPidAlive(4242, eperm), true, "EPERM = exists but foreign — an ALIVE owner");
  assert.equal(isPidAlive(4242, esrch), false);
  assert.equal(isPidAlive("4242"), false, "a non-integer pid = dead for the classifier");
  assert.equal(isPidAlive(process.pid), true, "our own pid is alive without injection");
});

test("journal lock: the {pid} content is really written into the lock under the taken lock (M4)", () => {
  // An observer in the same process is impossible: saveJournalMerged is synchronous and blocks
  // the event loop — we pin acquireSyncLock itself (the "writeSync removed" mutation lived exactly
  // there): without the content the next writer treats the lock as legacy and the pid liveness is a no-op.
  const dir = mkdtempSync(path.join(tmpdir(), "lw-h4m-"));
  const lockPath = path.join(dir, "onchain-journal.json.lock");
  let fd = null;
  try {
    fd = acquireSyncLock(lockPath, { staleMs: 10_000, attempts: 3, retryPauseMs: 1 });
    assert.ok(fd !== null, "the lock is taken");
    const meta = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.ok(Number.isInteger(meta.pid), `the content is load-bearing: {pid} an integer (got ${JSON.stringify(meta)})`);
    assert.equal(meta.pid, process.pid);
    assert.ok(typeof meta.createdAt === "string");
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: enrich \"--api=--evil\" — a usage refusal with exit 2, not a runtime stack (H4-P3)", async () => {
  const api = http.createServer((req, res) => { res.writeHead(400); res.end(); });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(path.join(tmpdir(), "lw-h4e-"));
  try {
    writeFileSync(path.join(dir, "reg.json"), JSON.stringify([]));
    const child = spawn(process.execPath, [path.join(ROOT, "scripts", "enrich-decimals.mjs"),
      "--registry", path.join(dir, "reg.json"), "--api=--evil"]);
    let stderr = "";
    child.stderr.on("data", (c) => { stderr += c; });
    const code = await new Promise((r) => child.on("close", r));
    assert.equal(code, 2, `a usage code, not runtime (stderr: ${stderr.slice(0, 150)})`);
    assert.match(stderr, /--api requires a non-empty value/);
    assert.ok(!/TypeError|ENOENT|undici/.test(stderr), "no raw stacks");
  } finally {
    await new Promise((r) => api.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("journal lock: nowMs:null / NaN — the injection is ignored, a fresh legacy lock is NOT broken (H4-P4)", () => {
  for (const bad of [null, NaN, Infinity]) {
    const { dir, jp, lock } = tmpJournal();
    try {
      writeFileSync(jp, JSON.stringify({ A: entry("1") }));
      writeFileSync(lock, "legacy-fresh");
      saveJournalMerged(jp, { B: entry("2") }, { staleMs: 10_000, attempts: 1, retryPauseMs: 1, nowMs: bad });
      assert.ok(existsSync(lock), `nowMs=${String(bad)}: injection validation — the fresh lock is intact`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
