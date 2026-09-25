// Adversarial boundaries of the on-chain journal (round 7): writes/dedup/conflicts,
// reads/corruptions, recovery/degraded boot. The boundaries of rounds 5–6 are extended
// (an empty file, a BOM, an array payload, BigInt, garbage record fields). The ACTUAL
// behavior is pinned; the "GAP:" mark — a recorded contract in a place
// where the current behavior turned out to be a hole. Round 7 found two holes, and both
// were FIXED in src — the corresponding GAP pins are rewritten for the correct
// behavior (the pin recorded a bug, that is deliberate):
//   (1) events-not-an-array is treated as a record corruption (src/events/journal.mjs):
//       a backfill duplicate is not re-emitted, a loud console.error to the operator,
//       a rebuild from scratch according to the chain's fact;
//   (2) a non-serializable payload no longer leaves an empty .tmp (src/fs/atomic.mjs):
//       serialization before creating the temp, cleanup on any failure after opening.
import test from "node:test";
import assert from "node:assert/strict";
import {
  planJournalStep,
  saveJournalAtomic,
  loadJournalOnchain,
  preserveCorruptedJournal,
  bootJournalOnchain,
  persistJournalOnBoot,
} from "../src/events/journal.mjs";
import { MultiplierTimeline } from "../src/lots/timeline.mjs";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const MINT2 = "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp";
const FOREIGN = "Foreign1111111111111111111111111111111111111";
const token = { mint: MINT, symbol: "TESTx" };
const token2 = { mint: MINT2, symbol: "OTHERx" };
const NOW = Date.parse("2026-09-19T00:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

// the mint state on chain: active/pending + the pending activation date
const parsedOf = (active, pending, date) => ({
  hasExtension: true, decimals: 8,
  activeMultiplier: active,
  pendingMultiplier: pending,
  pendingEffectiveDate: date,
  authority: null,
});
// a first observation of the SPACEX pattern: pending 5 from 10.06 already in force → a 1→5 backfill
const BASE = parsedOf("1", "5", "2026-06-10T04:30:00.000Z");
const ROT7 = parsedOf("5", "7", "2026-09-15T00:00:00.000Z");

const freshDir = () => mkdtempSync(path.join(tmpdir(), "lotwise-journal-edge-"));
const busy = () => {
  throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
};

// ===========================================================================
// Group 1. Writes: conflicts, dedup, broken payloads
// ===========================================================================

test("a rotation conflict (the issuer flip-flopped 7→6): the journal is linear, the last observation wins, the history is not rewritten", () => {
  const boot1 = planJournalStep(token, null, BASE, NOW); // 1→5
  const boot2 = planJournalStep(token, boot1.entry, ROT7, NOW + 60_000); // 5→7
  const corrected = parsedOf("5", "6", "2026-09-18T00:00:00.000Z");
  const boot3 = planJournalStep(token, boot2.entry, corrected, NOW + 120_000); // 7→6

  assert.ok(boot3.event);
  assert.equal(boot3.event.multiplierFrom, "7");
  assert.equal(boot3.event.multiplierTo, "6");
  assert.equal(boot3.entry.events.length, 3, "events are appended to the tail, nothing is edited retroactively");
  assert.deepEqual(boot3.entry.events[0], boot1.entry.events[0], "the first event untouched");
  const tl = new MultiplierTimeline(boot3.entry.events);
  assert.equal(tl.multiplierAt("2026-09-19"), "6", "a timeline from the linear journal is valid: the last observation is the truth");
});

test("an intermediate rotation skipped between observations: a 5→8 event, the step 7 is unrecoverable (a documented limitation)", () => {
  const boot1 = planJournalStep(token, null, BASE, NOW); // 1→5
  const jumped = parsedOf("5", "8", "2026-09-17T00:00:00.000Z"); // the chain jumped 5→8, the 7 between observations
  const boot2 = planJournalStep(token, boot1.entry, jumped, NOW + 60_000);
  assert.ok(boot2.event);
  assert.equal(boot2.event.multiplierFrom, "5");
  assert.equal(boot2.event.multiplierTo, "8", "the diff from the last RECORDED value — one step, not two invented ones");
  assert.equal(boot2.entry.events.length, 2);
  // the journal at the same time remains a valid chain for the timeline
  const tl = new MultiplierTimeline(boot2.entry.events);
  assert.equal(tl.multiplierAt("2026-09-18"), "8");
});

test("a rotation without a pendingEffectiveDate — the event is dated by the observation moment (nowIso), not an invented date", () => {
  const prior = { lastEffective: "1", observedAt: "2026-09-01T00:00:00.000Z", events: [] };
  const activeOnly = parsedOf("5", null, null); // the pending is already lifted, we only see the new active
  const { event } = planJournalStep(token, prior, activeOnly, NOW);
  assert.ok(event);
  assert.equal(event.effectiveDate, iso(NOW), "no date on chain — an honest now, not null and not garbage");
  assert.equal(event.multiplierFrom, "1");
  assert.equal(event.multiplierTo, "5");
});

test("parsed garbage {} on a first observation: there is NO record — the next rotation is not absorbed (the GAP closed by wave C4-1)", () => {
  // It was (a documented GAP): a broken payload {} gave an entry with
  // lastEffective:undefined, "healthy" in shape on disk, and the next rotation
  // was absorbed silently. Wave C4-1: a response without facts (a falsy hasExtension) — no
  // record at all; the first live boot builds the history from scratch, the 1→5 rotation IS EMITTED.
  const s1 = planJournalStep(token, null, {}, NOW);
  assert.equal(s1.event, null);
  assert.equal(s1.chain, "ok");
  assert.equal(s1.entry, null, "no facts — no record");

  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  saveJournalAtomic(p, s1.entry === null ? {} : { [MINT]: s1.entry });
  const loaded = loadJournalOnchain(p);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.journal[MINT], undefined, "nothing rode to disk");

  const s2 = planJournalStep(token, loaded.journal[MINT], BASE, NOW + 60_000);
  assert.ok(s2.event, "the 1→5 rotation is emitted by the first live observation — not absorbed");
  assert.equal(s2.event.multiplierFrom, "1");
  assert.equal(s2.event.multiplierTo, "5");
  assert.equal(s2.entry.events.length, 1);
});

test("planJournalStep: events not an array (a broken record field) — the backfill duplicate is NOT re-emitted, the operator warn fired, the subsequent write is correct (the GAP rewritten: earlier the history was silently reset and the duplicate re-emitted)", (t) => {
  // Round 7, fixed in src/events/journal.mjs: a record with events-not-an-array is
  // corrupted, not a "first observation". The replay is empty (an untrusted history),
  // the 1→5 duplicate is suppressed, a loud console.error with the evidence goes to the operator, the record
  // is rebuilt from scratch: lastEffective from the chain's fact, events honestly empty.
  const errLog = t.mock.method(console, "error", () => {});
  const prior = { lastEffective: "5", observedAt: "2026-09-01T00:00:00.000Z", events: "1→5 (garbage instead of an array)" };
  const step = planJournalStep(token, prior, BASE, NOW);
  assert.equal(errLog.mock.callCount(), 1, "the corruption is not silent: a loud console.error");
  const shouted = String(errLog.mock.calls[0].arguments[0]);
  assert.match(shouted, /CORRUPTED/); // round 19: EN
  assert.match(shouted, /garbage instead of an array/, "the evidence — the broken record as a whole — goes to the operator's log");
  assert.equal(step.corrupted, true, "the mint is marked corrupted");
  assert.deepEqual(step.replay, [], "the untrusted history is not mixed into the replay");
  assert.equal(step.event, null, "the 1→5 backfill duplicate is NOT re-emitted");
  assert.deepEqual(step.entry.events, [], "a rebuild from scratch: the events honestly empty, not invented");
  assert.equal(step.entry.lastEffective, "5", "lastEffective recorded from the chain's fact");

  // the subsequent write is correct: the fresh record lives by the normal mid-history semantics
  const next = planJournalStep(token, step.entry, ROT7, NOW + 60_000);
  assert.equal(next.corrupted, false);
  assert.equal(next.event, null, "5→7 does not continue the chain from \"1\" — no event is invented (like any mid-history)");
  assert.equal(next.entry.lastEffective, "7");
  assert.deepEqual(next.entry.events, []);
});

test("planJournalStep: events not an array + the chain unavailable — entry null, the broken evidence on disk is untouched, the warn fired (the degradation pin rewritten as fail-closed)", (t) => {
  const errLog = t.mock.method(console, "error", () => {});
  const prior = { lastEffective: "5", observedAt: "2026-09-01T00:00:00.000Z", events: 42 };
  const down = planJournalStep(token, prior, null, NOW + 60_000);
  assert.equal(errLog.mock.callCount(), 1, "the corruption is loud even with the chain down");
  assert.equal(down.chain, "unavailable");
  assert.equal(down.corrupted, true);
  assert.equal(down.entry, null, "there is nothing to replace the broken record with — on disk it is untouched until a rebuild by the chain's fact");
  assert.deepEqual(down.replay, []);
  assert.equal(down.event, null);
});

test("parsed=null on a first boot (the chain is down, no journal): entry null — the file is not created; the recovery gives a full backfill", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  const down = planJournalStep(token, null, null, NOW);
  assert.equal(down.chain, "unavailable");
  assert.equal(down.entry, null, "nothing to write: the history not started");
  assert.equal(down.event, null);
  assert.deepEqual(down.replay, []);
  // the fact: at priorEntry=null the flag computes as null (a falsy quirk of the expression
  // base === null && priorEntry && …), not false — all consumers check
  // truthiness, so the warn does not fire, but we pin the actual value
  assert.equal(down.unavailableV1, null);

  persistJournalOnBoot(p, {}, { preserveFailed: false }); // serve writes an empty journal
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), {});
  // the recovery with a live chain: an ordinary first observation with a full backfill
  const ok = planJournalStep(token, undefined, BASE, NOW + 60_000);
  assert.ok(ok.event);
  assert.equal(ok.event.multiplierTo, "5");
  assert.equal(ok.chain, "ok");
});

test("mint isolation: a rotation of mint A does not rewrite mint B's entry — the journal map is independent by keys", () => {
  const stepA = planJournalStep(token, null, BASE, NOW); // 1→5
  const quiet = parsedOf("1", null, null); // B is all quiet, active 1
  const stepB = planJournalStep(token2, null, quiet, NOW);
  assert.equal(stepB.event, null);
  assert.equal(stepB.entry.lastEffective, "1");

  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  const journal = { [MINT]: stepA.entry, [MINT2]: stepB.entry };
  saveJournalAtomic(p, journal);
  const loaded = loadJournalOnchain(p);
  assert.deepEqual(loaded.journal[MINT2], stepB.entry, "B untouched by A's rotation");
  // the next rotation of A: B does not change at all
  const next = planJournalStep(token, loaded.journal[MINT], ROT7, NOW + 60_000);
  assert.ok(next.event);
  assert.equal(next.event.multiplierFrom, "5");
  const againB = planJournalStep(token2, loaded.journal[MINT2], quiet, NOW + 60_000);
  assert.equal(againB.event, null);
  assert.equal(againB.entry.lastEffective, "1");
  assert.deepEqual(againB.entry.events, []);
});

// ===========================================================================
// Group 2. Reads/persistence: corruption boundaries (the extension of rounds 5–6)
// ===========================================================================

test("loadJournalOnchain: an empty file (0 bytes) — corrupted, not a \"first run\"; the evidence preserves the emptiness", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  writeFileSync(p, ""); // an interruption BEFORE the first bytes were written
  const r = loadJournalOnchain(p);
  assert.equal(r.ok, false);
  assert.equal(r.corrupted, true);
  assert.match(r.reason, /JSON/i);
  const backup = preserveCorruptedJournal(p);
  assert.ok(backup);
  assert.equal(readFileSync(backup, "utf8"), "", "the evidence is honestly empty: the corruption fact is not rewritten");
  assert.equal(existsSync(p), false);
});

// Round 21 (SRE P3-5) REWRITES this pin: a BOM used to be treated as corruption (an
// earlier round chose "not silently trimmed"). The SRE pass priced the operator cost:
// a perfectly valid journal went to quarantine and needed a manual strip-and-restore.
// A UTF-8 BOM is an editor fingerprint, not damage; the loader strips it in-memory.
test("loadJournalOnchain: a BOM before the JSON is stripped and the journal loads (round 21 rewrite of the quarantine pin)", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  writeFileSync(p, "\uFEFF{\"M\":{}}");
  const r = loadJournalOnchain(p);
  assert.equal(r.ok, true, "a BOM-prefixed valid journal loads");
  assert.equal(r.corrupted, false);
  assert.deepEqual(r.journal, { M: {} });
  assert.equal(readFileSync(p, "utf8").charCodeAt(0), 0xFEFF, "the file itself is untouched — the strip is in-memory only");
});

test("loadJournalOnchain: a valid object with garbage values — loaded as is (depth validation is the transition layer)", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  const journal = {
    [MINT]: "a string instead of an entry",
    [MINT2]: { lastEffective: 5, events: null }, // wrong field types
  };
  saveJournalAtomic(p, journal);
  const r = loadJournalOnchain(p);
  assert.equal(r.ok, true, "the top level {mint: …} is valid — the reader does not check the depth");
  assert.equal(r.corrupted, false);
  assert.deepEqual(r.journal, journal);
});

test("a journal with a mint outside the registry — loaded and booted whole: the journal layer does not know the registry", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  const journal = {
    [FOREIGN]: { lastEffective: "9", observedAt: "2026-09-01T00:00:00.000Z", events: [] },
    [MINT]: { lastEffective: "5", observedAt: "2026-09-02T00:00:00.000Z", events: [] },
  };
  saveJournalAtomic(p, journal);
  const boot = bootJournalOnchain(p);
  assert.equal(boot.corrupted, false);
  assert.deepEqual(Object.keys(boot.journal).sort(), [FOREIGN, MINT].sort(),
    "the foreign mint arrives: serve does the registry filtering at replay, not the loader");
});

test("saveJournalAtomic: an array payload is written without a check, but the reader honestly marks corrupted (a writer/reader asymmetry)", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  saveJournalAtomic(p, [{ mint: MINT }]); // the writer accepts any JSON
  const r = loadJournalOnchain(p);
  assert.equal(r.ok, false);
  assert.equal(r.corrupted, true);
  assert.match(r.reason, /array/, "the reader knows the shape: the journal must be an object {mint: entry}");
  assert.deepEqual(r.journal, {});
});

test("atomicWriteJson: a non-serializable payload (BigInt) — the exception is propagated, zero tmp files in the directory, the target byte-for-byte the same (the GAP rewritten: earlier an empty .tmp was left)", () => {
  // Round 7, fixed in src/fs/atomic.mjs: the serialization is now BEFORE creating the temp,
  // so a JSON.stringify throw creates no file at all; on a write/fsync/rename
  // failure after opening the temp, the latter is cleaned up in catch.
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  saveJournalAtomic(p, { [MINT]: { lastEffective: "5", events: [] } });
  const before = readFileSync(p, "utf8");
  assert.throws(() => saveJournalAtomic(p, { [MINT]: { qty: 1n } }), TypeError);
  assert.equal(readFileSync(p, "utf8"), before, "the target byte-for-byte the same: the old version survived the failure");
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.endsWith(".tmp")),
    [],
    "zero temp litter: the serialization falls before the file is created",
  );
});

// ===========================================================================
// Group 3. Recovery/boot: the degraded mode with and without the journal
// ===========================================================================

test("a boot on an empty file: rename and copy both save the empty evidence, a write after — normal", () => {
  // variant 1: the rename succeeded — the original went into an empty evidence, the boot writes a fresh journal
  const dir1 = freshDir();
  const p1 = path.join(dir1, "onchain-journal.json");
  writeFileSync(p1, "");
  const boot1 = bootJournalOnchain(p1);
  assert.equal(boot1.corrupted, true);
  assert.equal(boot1.preserveFailed, false);
  assert.equal(readFileSync(boot1.backup, "utf8"), "");
  assert.equal(existsSync(p1), false);
  const saved = persistJournalOnBoot(p1, { [MINT]: { lastEffective: "5", observedAt: iso(NOW), events: [] } });
  assert.equal(saved.written, true);

  // variant 2: the rename failed (EBUSY) — the copy saves the empty evidence, the original stays
  const dir2 = freshDir();
  const p2 = path.join(dir2, "onchain-journal.json");
  writeFileSync(p2, "");
  const boot2 = bootJournalOnchain(p2, { rename: busy });
  assert.ok(boot2.backup);
  assert.equal(readFileSync(boot2.backup, "utf8"), "");
  assert.equal(existsSync(p2), true);
  assert.equal(boot2.preserveFailed, false);
});

test("a degraded boot with a journal (the chain down): the SAME record goes to the file — observedAt honestly stale, it does not lie \"observed now\"", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  const boot1 = planJournalStep(token, null, BASE, NOW); // 1→5, observedAt = NOW
  const down = planJournalStep(token, boot1.entry, null, NOW + 60_000);
  assert.equal(down.chain, "unavailable");
  assert.equal(down.entry, boot1.entry, "the same reference: the record is not reassembled");

  const saved = persistJournalOnBoot(p, { [MINT]: down.entry });
  assert.equal(saved.written, true);
  const loaded = loadJournalOnchain(p);
  assert.equal(loaded.journal[MINT].observedAt, iso(NOW),
    "the old observedAt on disk: with an unavailable chain the observation time is not invented");
  assert.equal(loaded.journal[MINT].events.length, 1, "the events survive the degradation");
});

test("degrade→restore on disk: an unavailable chain does not roll back events, after recovery the chain grows monotonically", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");

  // step 1: a live chain — 1→5, a write to disk
  const boot1 = planJournalStep(token, null, BASE, NOW);
  persistJournalOnBoot(p, { [MINT]: boot1.entry });

  // step 2: the chain went down — a write with the same state (a replay without events)
  const down = planJournalStep(token, boot1.entry, null, NOW + 60_000);
  persistJournalOnBoot(p, { [MINT]: down.entry });
  let loaded = loadJournalOnchain(p);
  assert.equal(loaded.journal[MINT].events.length, 1, "the degradation lost and doubled no event");

  // step 3: the chain came back with a rotation — the 5→7 event appended, the journal monotonic
  const restore = planJournalStep(token, loaded.journal[MINT], ROT7, NOW + 120_000);
  assert.ok(restore.event);
  assert.equal(restore.replay.length, 1, "the previous session's replay mixed in before the transition");
  persistJournalOnBoot(p, { [MINT]: restore.entry });
  loaded = loadJournalOnchain(p);
  assert.equal(loaded.journal[MINT].events.length, 2);
  const tl = new MultiplierTimeline(loaded.journal[MINT].events);
  assert.equal(tl.multiplierAt("2026-09-16"), "7", "the recovered journal — a valid chain for the timeline");
});

// Round 21 (SRE P2-3): a journal record whose events ARRAY carries an invalid ELEMENT
// (an unknown event type — a future/downgraded writer) is corruption, not a forever-skip.
// It used to survive every boot: replay validation threw, the token was silently dead
// each session, and the broken record was rewritten to disk as-is, forever.
test("planJournalStep: an events array with an invalid element — corrupted, the token recovers instead of dying forever", (t) => {
  const errLog = t.mock.method(console, "error", () => {});
  const prior = {
    lastEffective: "5",
    observedAt: "2026-09-01T00:00:00.000Z",
    events: [{ type: "FOO_CHANGE", effectiveDate: "2026-06-10T04:30:00.000Z", status: "confirmed", sources: ["https://x"] }],
  };
  const step = planJournalStep(token, prior, BASE, NOW);
  assert.equal(errLog.mock.callCount(), 1, "the corruption is loud, not a boot-log line to lose in journald rotation");
  const shouted = String(errLog.mock.calls[0].arguments[0]);
  assert.match(shouted, /CORRUPTED/);
  assert.match(shouted, /FOO_CHANGE/, "the evidence names the invalid element");
  assert.equal(step.corrupted, true, "the mint is marked corrupted — visible in /health counters");
  assert.deepEqual(step.replay, [], "the untrusted history does not enter the replay (it would throw downstream anyway)");
  assert.deepEqual(step.entry.events, [], "rebuilt from the chain's fact: the token is ALIVE again, not dead until a manual journal edit");
  assert.equal(step.entry.lastEffective, "5");

  // the next boot on the rebuilt record is the normal mid-history path
  const next = planJournalStep(token, step.entry, ROT7, NOW + 60_000);
  assert.equal(next.corrupted, false);
  assert.equal(next.event, null);
  assert.equal(next.entry.lastEffective, "7");
});
