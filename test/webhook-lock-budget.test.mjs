// The webhook store lock (withStoreLock) must cap its wait by the WALL CLOCK
// (~staleMs), not by the attempt count. The ceiling `ceil(staleMs / retryPauseMs) + 100`
// assumes Atomics.wait honors its timeout; on Windows the ~15.6ms timer quantum makes
// 2100 attempts (the default for staleMs=10s) burn ~33s of blocking instead of the
// contract ~10s — updateStore is synchronous, so a CLI webhook command against a live
// but stuck lock owner freezes the terminal for the whole budget. The journal twin
// (acquireSyncLock) already holds the honest deadline: degradation no later than
// ~staleMs regardless of OS, with the attempt cap kept as the loop's backstop. Both
// twins must agree.
import test from "node:test";
import assert from "node:assert/strict";
import { withStoreLock } from "../src/webhooks/subscriptions.mjs";
import { writeFileSync, utimesSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// a lock held by a LIVE owner (our own pid) with an ancient mtime: past staleMs, so the
// break-check branch engages, but the owner is alive — the lock is never broken and the
// contender must wait out its full budget, then fail honestly.
const heldLock = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lotwise-lock-budget-"));
  const store = path.join(dir, "webhooks.json");
  writeFileSync(store + ".lock", JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  utimesSync(store + ".lock", new Date(0), new Date(0));
  return { dir, store };
};

test("the wait ceiling is the wall clock: the default attempt budget cannot stretch past ~staleMs", () => {
  const { dir, store } = heldLock();
  try {
    const t0 = Date.now();
    assert.throws(
      () => withStoreLock(store, () => "ran", { staleMs: 1000 }),
      (err) => /locked/i.test(err.message),
      "the degradation is an honest error, not silence",
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 500, `the budget is still waited out, not skipped (${elapsed}ms)`);
    assert.ok(elapsed < 3000, `the wait must be capped at ~staleMs by the wall clock, got ${elapsed}ms ` +
      `(the default ${Math.ceil(1000 / 5) + 100} attempts burn ~4.7s under the Windows timer quantum)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a raised attempt cap does not raise the wait: the deadline wins over the counter", () => {
  const { dir, store } = heldLock();
  try {
    const t0 = Date.now();
    assert.throws(
      () => withStoreLock(store, () => "ran", { staleMs: 1000, attempts: 2000, retryPauseMs: 5 }),
      (err) => /locked/i.test(err.message),
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 5000, `2000 attempts must not become ~31s of blocking — the wall-clock deadline caps the wait, got ${elapsed}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the deadline does not touch the healthy paths: a stale lock with a dead owner is broken at once, a fresh one is waited for", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lotwise-lock-budget-2-"));
  try {
    const store = path.join(dir, "webhooks.json");
    // an orphan of a dead owner: broken immediately, no budget burned
    writeFileSync(store + ".lock", JSON.stringify({ pid: 999999999, createdAt: new Date().toISOString() }));
    utimesSync(store + ".lock", new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const t0 = Date.now();
    const out = withStoreLock(store, () => "ok", { staleMs: 10_000, retryPauseMs: 5 });
    assert.equal(out, "ok");
    assert.ok(Date.now() - t0 < 2000, "a dead owner is broken without waiting out the budget");

    // a fresh foreign lock: waited for honestly (mtime aging inside staleMs), and a live
    // owner's lock is never broken by mtime alone
    writeFileSync(store + ".lock", JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    assert.throws(
      () => withStoreLock(store, () => "no", { staleMs: 100, attempts: 10, retryPauseMs: 5 }),
      (err) => /locked/i.test(err.message),
      "a live owner keeps the lock — an honest refusal",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
