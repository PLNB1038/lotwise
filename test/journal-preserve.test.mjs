// formerly round6-journal-preserve.test.mjs
// Round 6 regression tests — finding LW2_journal_evidence_clobber_on_failed_preserve.
// The round-5 guard itself destroyed the evidence in its failure branch: preserveCorruptedJournal
// swallowed ANY renameSync error (AV/indexer/EBUSY on Windows) and returned null,
// serve.mjs did not branch on null — and the final saveJournalAtomic renamed the fresh
// journal OVER the corrupted original, erasing the only copy of the history.
// Contract after the fix:
//   (1) preserve tries rename several times with different names, and as a last resort
//       COPIES the evidence nearby (the original stays, but the copy is already outside the write window);
//   (2) no evidence at all ⇒ boot in read-only mode: no final journal write exists,
//       the corrupted original is guaranteed to outlive the boot until restart;
//   (3) the flag is readable from outside: createApiServer pipes journal.preserveFailed into /health.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  bootJournalOnchain,
  persistJournalOnBoot,
  preserveCorruptedJournal,
  saveJournalAtomic,
} from "../src/events/journal.mjs";
import { createApiServer } from "../src/api/server.mjs";

const freshDir = () => mkdtempSync(path.join(tmpdir(), "lotwise-r6-journal-"));
const torn = '{"Mint11111111111111111111111111111111":{"lastEff'; // truncated by an interrupted write
const writeTorn = (p) => writeFileSync(p, torn);
const busy = () => {
  throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
};

// ---- bootJournalOnchain: load + evidence preservation in a single point ----

test("boot with a corrupted journal: evidence preserved by rename — preserveFailed=false, the original moved into the evidence", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  writeTorn(p);
  const boot = bootJournalOnchain(p);
  assert.equal(boot.corrupted, true);
  assert.ok(boot.reason);
  assert.ok(boot.backup, "the evidence must exist");
  assert.match(path.basename(boot.backup), /\.corrupt-/);
  assert.equal(readFileSync(boot.backup, "utf8"), torn); // evidence content = the corrupted original
  assert.equal(existsSync(p), false); // rename succeeded: the original moved into the evidence
  assert.equal(boot.preserveFailed, false);
  // an empty journal for backfill — the normal continuation of the boot
  assert.deepEqual(boot.journal, {});
});

test("a healthy journal and its absence — corrupted=false, preserve does not fire", () => {
  const dir = freshDir();
  const ok = path.join(dir, "ok.json");
  saveJournalAtomic(ok, { Mint1: { lastEffective: "5", events: [] } });
  const bootOk = bootJournalOnchain(ok);
  assert.equal(bootOk.corrupted, false);
  assert.equal(bootOk.preserveFailed, false);
  assert.equal(bootOk.backup, null);
  assert.deepEqual(bootOk.journal, { Mint1: { lastEffective: "5", events: [] } });

  const bootFirst = bootJournalOnchain(path.join(dir, "no-file.json")); // first run
  assert.equal(bootFirst.corrupted, false);
  assert.equal(bootFirst.backup, null);
});

// ---- retries and the copy fallback: strengthening preserve against a "temporary" rename failure ----

test("preserve retries call rename with DIFFERENT names; the second attempt succeeds", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  writeTorn(p);
  const attempted = [];
  const flakyRename = (from, to) => {
    attempted.push(to);
    if (attempted.length < 2) busy(); // AV held the file for a moment
    renameSync(from, to); // the second attempt — the real move
  };
  const backup = preserveCorruptedJournal(p, { attempts: 3, rename: flakyRename });
  assert.equal(attempted.length, 2);
  assert.notEqual(attempted[0], attempted[1], "each attempt gets its own evidence name");
  assert.equal(backup, attempted[1]);
  assert.equal(existsSync(p), false);
  assert.equal(readFileSync(backup, "utf8"), torn);
});

test("rename failed, copy saves the evidence — preserveFailed=false, the original stays, writes allowed", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  writeTorn(p);
  const boot = bootJournalOnchain(p, { rename: busy });
  assert.ok(boot.backup, "the evidence must be saved by copying");
  assert.equal(readFileSync(boot.backup, "utf8"), torn);
  assert.equal(existsSync(p), true); // the original is in place (rename failed)…
  assert.equal(boot.preserveFailed, false); // …but the evidence is already outside the write window
  // the final write is allowed: it can clobber only the original, the evidence is intact
  const saved = persistJournalOnBoot(p, {}, { preserveFailed: boot.preserveFailed });
  assert.equal(saved.written, true);
  assert.equal(readFileSync(boot.backup, "utf8"), torn); // the evidence was not harmed by the write
});

// ---- the core of the finding: no evidence ⇒ read-only, the original outlives the boot ----

test("neither rename nor copy succeeded — preserveFailed=true, the corrupted original INTACT in place", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  writeTorn(p);
  const boot = bootJournalOnchain(p, { rename: busy, copy: busy });
  assert.equal(boot.backup, null);
  assert.equal(boot.preserveFailed, true);
  assert.equal(readFileSync(p, "utf8"), torn, "the boot had no right to touch the only copy of the history");
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
});

test("the serve-boot contract end-to-end: preserveFailed=true ⇒ the final write DOES NOT exist, the original outlives the boot", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  writeTorn(p);
  // exactly the serve.mjs sequence: boot → (final write with the preserveFailed decision)
  const boot = bootJournalOnchain(p, { rename: busy, copy: busy });
  const saved = persistJournalOnBoot(
    p,
    { Mint1: { lastEffective: "7", observedAt: "2026-09-20T00:00:00.000Z", events: [] } },
    { preserveFailed: boot.preserveFailed },
  );
  assert.equal(saved.readonly, true);
  assert.equal(saved.written, false);
  assert.equal(readFileSync(p, "utf8"), torn, "the truncated history had to outlive the boot — saveJournalAtomic used to clobber it");
  assert.deepEqual(readdirSync(dir), ["onchain-journal.json"], "no decoy evidence, no tmp litter");
});

test("persistJournalOnBoot: a normal boot writes atomically; a failed write — written=false without read-only", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  const saved = persistJournalOnBoot(p, { Mint1: { lastEffective: "5", events: [] } });
  assert.equal(saved.written, true);
  assert.equal(saved.readonly, false);
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { Mint1: { lastEffective: "5", events: [] } });

  const doomed = path.join(dir, "no-such-folder", "j.json"); // an unreachable directory
  const failed = persistJournalOnBoot(doomed, {});
  assert.equal(failed.written, false);
  assert.equal(failed.readonly, false); // this is not read-only mode, an ordinary write error
  assert.ok(failed.error instanceof Error);
});

// ---- the contract for the vitrine: preserveFailed readable from outside via /health ----

test("createApiServer: /health pipes journal.preserveFailed (the vitrine banner keys on truthiness)", async () => {
  const server = await createApiServer({
    registry: [],
    events: [],
    journalStats: { replayed: 0, unavailable: 0, corrupted: 1, preserveFailed: 1 },
  });
  const { port } = server.address();
  try {
    const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(h.journal.corrupted, 1);
    assert.equal(h.journal.preserveFailed, 1); // a 0|1 number, like journal.corrupted
    // a healthy journal: both flags are honest zeros
    const server2 = await createApiServer({
      registry: [],
      events: [],
      journalStats: { replayed: 3, unavailable: 0, corrupted: 0, preserveFailed: 0 },
    });
    try {
      const h2 = await (await fetch(`http://127.0.0.1:${server2.address().port}/health`)).json();
      assert.equal(h2.journal.preserveFailed, 0);
      assert.equal(h2.journal.corrupted, 0);
    } finally {
      server2.close();
    }
  } finally {
    server.close();
  }
});
