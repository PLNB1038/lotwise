// Round 5, the finding LW_journal_write_non_atomic: the persistence of the on-chain journal.
// (a) the save is atomic (a temp in the same directory + rename, no litter and truncated files);
// (b) a broken journal file at load — an explicit "corrupted" state, not a quiet "empty journal".
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadJournalOnchain, saveJournalAtomic, saveJournalMerged, preserveCorruptedJournal } from "../src/events/journal.mjs";

const JOURNAL = {
  Mint11111111111111111111111111111111: {
    lastEffective: "5",
    observedAt: "2026-09-19T03:50:00.000Z",
    events: [{
      type: "MULTIPLIER_CHANGE", multiplierFrom: "1", multiplierTo: "5",
      effectiveDate: "2026-06-10T04:30:00.000Z", status: "confirmed",
    }],
  },
};

const freshDir = () => mkdtempSync(path.join(tmpdir(), "lotwise-journal-"));

// ---- (a) an atomic write ----

test("saveJournalAtomic: the final file valid, no temp litter left in the directory", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  saveJournalAtomic(p, JOURNAL);
  assert.deepEqual(readdirSync(dir), ["onchain-journal.json"]); // exactly one file: the temp went into the rename
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), JOURNAL);
});

test("saveJournalAtomic: rewriting a live journal updates the content and again without litter", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  saveJournalAtomic(p, JOURNAL);
  const updated = {
    ...JOURNAL,
    Mint22222222222222222222222222222222: { lastEffective: "1", observedAt: "2026-09-20T00:00:00.000Z", events: [] },
  };
  saveJournalAtomic(p, updated);
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), updated);
  assert.deepEqual(readdirSync(dir), ["onchain-journal.json"]);
});

test("saveJournalAtomic: an empty journal — also a valid JSON object", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  saveJournalAtomic(p, {});
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), {});
});

test("saveJournalAtomic: an unreachable directory — throws, leaves nothing nearby", () => {
  const dir = freshDir();
  const p = path.join(dir, "no-such-folder", "journal.json");
  assert.throws(() => saveJournalAtomic(p, JOURNAL));
  assert.deepEqual(readdirSync(dir), []);
});

test("loadJournalOnchain after saveJournalAtomic: a roundtrip without losses", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  saveJournalAtomic(p, JOURNAL);
  const r = loadJournalOnchain(p);
  assert.equal(r.ok, true);
  assert.equal(r.corrupted, false);
  assert.deepEqual(r.journal, JOURNAL);
});

// ---- (b) a broken file ≠ a quiet empty journal ----

test("loadJournalOnchain: no file — an honest first run (ok, corrupted=false)", () => {
  const dir = freshDir();
  const r = loadJournalOnchain(path.join(dir, "onchain-journal.json"));
  assert.equal(r.ok, true);
  assert.equal(r.corrupted, false);
  assert.deepEqual(r.journal, {});
});

test("loadJournalOnchain: a truncated JSON (an interrupted write) — corrupted, NOT masked as a first run", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  const raw = JSON.stringify(JOURNAL, null, 1);
  writeFileSync(p, raw.slice(0, Math.floor(raw.length / 2))); // as after a kill -9 at the writeFileSync moment
  const r = loadJournalOnchain(p);
  assert.equal(r.ok, false);
  assert.equal(r.corrupted, true);
  assert.deepEqual(r.journal, {});
  assert.match(r.reason, /JSON/i);
});

test("loadJournalOnchain: garbage instead of JSON — corrupted", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  writeFileSync(p, "\x00this is not json at all{{{");
  const r = loadJournalOnchain(p);
  assert.equal(r.ok, false);
  assert.equal(r.corrupted, true);
  assert.deepEqual(r.journal, {});
});

test("loadJournalOnchain: a valid JSON but not an object (a number/array/null/string) — corrupted", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  for (const bad of ["5", "[1,2]", "null", '"str"']) {
    writeFileSync(p, bad);
    const r = loadJournalOnchain(p);
    assert.equal(r.corrupted, true, `must be corrupted: ${bad}`);
    assert.equal(r.ok, false, `must be refused: ${bad}`);
    assert.deepEqual(r.journal, {});
  }
});

test("loadJournalOnchain: the file is unreadable (a directory in its place) — corrupted, not a quiet first run", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  mkdirSync(p);
  const r = loadJournalOnchain(p);
  assert.equal(r.ok, false);
  assert.equal(r.corrupted, true);
  assert.deepEqual(r.journal, {});
});

// ---- the evidence: a corrupted file survives the first rewrite ----

test("preserveCorruptedJournal: the broken file renamed to .corrupt-*, not left in place", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  writeFileSync(p, "{\"Mint1\": {\"lastEff"); // truncated
  const backup = preserveCorruptedJournal(p);
  assert.ok(backup, "it must return the evidence path");
  assert.match(path.basename(backup), /\.corrupt-/);
  assert.equal(existsSync(p), false);
  assert.equal(readFileSync(backup, "utf8"), "{\"Mint1\": {\"lastEff");
});

test("preserveCorruptedJournal: the rename failed — an honest null, not an invented path", () => {
  const r = preserveCorruptedJournal(path.join(freshDir(), "no-such-file.json"));
  assert.equal(r, null);
});

// ---- the integration of the serve.mjs scenario: an interruption → corrupted → a boot with an empty one → an atomic write, the evidence intact ----

test("the interruption scenario: a new write does not clobber the corrupted file, the history stays in the evidence", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  const torn = JSON.stringify(JOURNAL, null, 1).slice(0, 40);
  writeFileSync(p, torn);

  const loaded = loadJournalOnchain(p); // step 1: the load sees the corruption
  assert.equal(loaded.corrupted, true);
  const backup = preserveCorruptedJournal(p); // step 2: the evidence preserved
  assert.ok(backup);

  saveJournalAtomic(p, {}); // step 3: the server continues the boot, writes a fresh journal atomically
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), {});
  assert.equal(readFileSync(backup, "utf8"), torn); // the corrupted history not lost
});


// ---- round 21 SRE P3: the journal's own BOM and rewrite hygiene ----

test("journal: a BOM-prefixed valid journal loads (round 21, SRE P3-5 — not quarantined)", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  writeFileSync(p, "\ufeff" + JSON.stringify({ ["Mint11111111111111111111111111111111"]: { lastEffective: "5", observedAt: "2026-09-01T00:00:00.000Z", events: [] } }, null, 1) + "\n");
  const r = loadJournalOnchain(p);
  assert.equal(r.ok, true, `must load (reason: ${r.reason})`);
  assert.equal(r.corrupted, false);
  assert.equal(r.journal["Mint11111111111111111111111111111111"].lastEffective, "5");
});

test("journal: saveJournalAtomic skips the write when the serialization is unchanged (round 21, SRE P3-4)", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  const journal = { ["Mint11111111111111111111111111111111"]: { lastEffective: "5", observedAt: "2026-09-01T00:00:00.000Z", events: [] } };
  const first = saveJournalAtomic(p, journal);
  assert.equal(first.written, true, "the first save writes the file");
  const before = readFileSync(p, "utf8");
  const second = saveJournalAtomic(p, { ["Mint11111111111111111111111111111111"]: { lastEffective: "5", observedAt: "2026-09-01T00:00:00.000Z", events: [] } });
  assert.equal(second.written, false, "an identical journal (even a fresh deep-equal object) does not rewrite the file");
  assert.equal(readFileSync(p, "utf8"), before, "the file bytes are untouched");
  const third = saveJournalAtomic(p, { ["Mint11111111111111111111111111111111"]: { lastEffective: "7", observedAt: "2026-09-02T00:00:00.000Z", events: [] } });
  assert.equal(third.written, true, "a changed observation writes again");
});

// round 22 (security): a __proto__ key in a foreign journal file is skipped LOUDLY on
// merge — it used to silently vanish ("in" matched the prototype) or would have mutated
// it; real mints survive the merge alongside
test("saveJournalMerged: a dangerous key is skipped loudly, real mints survive", (t) => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  const M = "Mint11111111111111111111111111111111";
  const foreign = {};
  foreign.__proto__ = undefined; // (no-op for the prototype in this construction)
  const fileJournal = JSON.parse('{"' + String.fromCharCode(95,95) + 'proto' + String.fromCharCode(95,95) + '":{"lastEffective":"9"},"' + M + '":{"lastEffective":"5","observedAt":"2026-09-01T00:00:00.000Z","events":[]}}');
  writeFileSync(p, JSON.stringify(fileJournal));
  const mine = { Other11111111111111111111111111111111: { lastEffective: "1", observedAt: "2026-09-02T00:00:00.000Z", events: [] } };
  saveJournalMerged(p, mine);
  const after = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(after[M].lastEffective, "5", "the foreign real mint survived");
  assert.equal(after.Other11111111111111111111111111111111.lastEffective, "1", "the fresh mint is there");
  assert.equal(Object.prototype.hasOwnProperty.call(after, String.fromCharCode(95,95) + "proto" + String.fromCharCode(95,95)), false, "the dangerous key did not become data");
  const errLog = t.mock.method(console, "error", () => {});
  try {
    writeFileSync(p, JSON.stringify(fileJournal)); // the dangerous file is back on disk
    saveJournalMerged(p, mine);
  } finally {
    errLog.mock.restore();
  }
  assert.equal(errLog.mock.callCount(), 1, "the skip is loud — silently dropping is the bug this pins");
});
