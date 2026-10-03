// The corruption gate of the on-chain journal must distrust EVERY element of
// entry.events that would not survive the replay validation — not only the ones with an
// unknown/absent type. An element of a KNOWN type carrying a garbage VALUE (a
// calendar-impossible effectiveDate, a non-array sources, a bad status) used to pass the
// gate as "healthy", ride into the replay, and throw NormalizeError in the boot loop
// AFTER the entry had already been applied to the in-memory journal: the token was
// silently dead on every boot, the final persist rewrote the poison to disk forever, and
// /health kept showing a clean journal. The contract (see the comment at the gate): an
// element is trusted only if it passes the SAME schema validation the replay applies;
// everything else routes to the corrupted branch — a loud console.error with the evidence,
// no replay over the distrusted history, a rebuild from the chain's fact (or an honest
// untouched entry when the chain is unavailable).
import test from "node:test";
import assert from "node:assert/strict";
import { planJournalStep } from "../src/events/journal.mjs";
import { bindMintAndValidate } from "../src/events/normalize-xstocks.mjs";

const MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const token = { mint: MINT, symbol: "TESTx" };
const NOW = Date.parse("2026-10-02T00:00:00Z");

const parsedOf = (active, pending, date, hasExtension = true) => ({
  hasExtension, decimals: 8,
  activeMultiplier: active,
  pendingMultiplier: pending,
  pendingEffectiveDate: date,
  authority: null,
});
const LIVE = parsedOf("1", "5", "2026-06-10T04:30:00.000Z");

// shape-valid record (events IS an array, element type IS known) with one poisoned VALUE
const eventOf = (overrides) => ({
  type: "MULTIPLIER_CHANGE",
  mint: MINT,
  effectiveDate: "2026-09-01T00:00:00.000Z",
  status: "confirmed",
  multiplierFrom: "1",
  multiplierTo: "2",
  sources: ["solana:getAccountInfo:x#scaledUiAmountConfig"],
  ...overrides,
});
const poisonEntryOf = (event) => ({
  lastEffective: "2",
  observedAt: "2026-09-01T00:00:00.000Z",
  events: [event],
});

test("a known-type event with a garbage VALUE field is corruption: routed to the corrupted branch before any assignment, not into the replay", (t) => {
  const errLog = t.mock.method(console, "error", () => {});
  const prior = poisonEntryOf(eventOf({ effectiveDate: "2026-02-30" })); // a calendar-impossible date

  // chain unavailable: nothing is replayed over the distrusted record, the entry on disk
  // is untouched until a rebuild by the chain's fact
  const down = planJournalStep(token, prior, null, NOW);
  assert.equal(down.corrupted, true, "a value-poisoned element must be classified corrupted, not healthy");
  assert.deepEqual(down.replay, [], "the poisoned history is not mixed into the replay");
  assert.equal(down.event, null);
  assert.equal(down.entry, null, "with the chain down the broken record is not touched");
  assert.equal(errLog.mock.callCount(), 1, "the corruption is loud: one console.error with the evidence");
  const shouted = String(errLog.mock.calls[0].arguments[0]);
  assert.match(shouted, /CORRUPTED/);
  assert.match(shouted, /invalid element/, "the reason names the element, not the record shape");
  assert.match(shouted, /2026-02-30/, "the evidence carries the poison itself");

  // chain live: a rebuild from scratch — the token comes back alive with a clean entry
  // (the chain's fact here is "5": the pending rotation is already in force)
  errLog.mock.resetCalls();
  const live = planJournalStep(token, prior, LIVE, NOW);
  assert.equal(live.corrupted, true);
  assert.deepEqual(live.replay, [], "the poisoned history is not replayed");
  assert.equal(live.event, null, "the backfill duplicate is NOT re-emitted over a distrusted base");
  assert.equal(live.entry.lastEffective, "5", "lastEffective is rebuilt from the chain's fact");
  assert.deepEqual(live.entry.events, [], "the old history is unrecoverable — events honestly empty");
  assert.equal(errLog.mock.callCount(), 1);

  // the rebuilt record survives the exact validation the boot replay applies — the
  // "silently dead each session" trap cannot close over it again
  assert.doesNotThrow(() => bindMintAndValidate(live.replay, MINT));
  assert.doesNotThrow(() => bindMintAndValidate(live.entry.events, MINT));
});

test("a missing or non-string event type is corruption (the same gate, the other sub-kind)", (t) => {
  const errLog = t.mock.method(console, "error", () => {});
  for (const [label, bad] of [
    ["no type at all", eventOf({ type: undefined })],
    ["numeric type", eventOf({ type: 42 })],
    ["null element", null],
  ]) {
    errLog.mock.resetCalls();
    const prior = bad === null
      ? { lastEffective: "2", observedAt: "2026-09-01T00:00:00.000Z", events: [null] }
      : poisonEntryOf(bad);
    const down = planJournalStep(token, prior, null, NOW);
    assert.equal(down.corrupted, true, `${label}: trusted only as an object with a KNOWN string type`);
    assert.deepEqual(down.replay, [], `${label}: nothing rides into the replay`);
    const live = planJournalStep(token, prior, LIVE, NOW);
    assert.equal(live.corrupted, true, `${label}: live chain rebuilds, not skips`);
    assert.equal(live.entry.lastEffective, "5", `${label}: rebuilt from the chain's fact`);
    assert.deepEqual(live.entry.events, [], `${label}: the distrusted history is not carried over`);
    assert.equal(errLog.mock.callCount(), 2, `${label}: the corruption is loud on every boot while the record persists`);
  }
});

test("a poisoned replay can no longer throw AFTER the entry was built: what the step hands out survives the boot validation", (t) => {
  // every field-poison class, in one record: what matters is
  // that NONE of them reaches the replay as "healthy history"
  const prior = {
    lastEffective: "2",
    observedAt: "2026-09-01T00:00:00.000Z",
    events: [
      eventOf({ status: "confirmed-ish" }), // a status outside the vocabulary
      eventOf({ sources: "not-an-array" }), // a sources string
      eventOf({ multiplierTo: "2.0.1" }), // a non-decimal multiplier
      eventOf({ mint: "short" }), // a mint that is not a pubkey
    ],
  };
  const down = planJournalStep(token, prior, null, NOW);
  assert.equal(down.corrupted, true);
  assert.deepEqual(down.replay, []);
  const live = planJournalStep(token, prior, LIVE, NOW);
  assert.equal(live.corrupted, true);
  assert.deepEqual(live.entry.events, []);
  // the full boot sequence over the step's output must not throw: replay is empty,
  // the rebuilt events are schema-clean
  assert.doesNotThrow(() => bindMintAndValidate(live.replay, MINT));
});

test("a schema-clean history still passes the gate untouched: the entry is returned by reference when the chain is down", () => {
  const prior = {
    lastEffective: "2",
    observedAt: "2026-09-01T00:00:00.000Z",
    events: [eventOf({})],
  };
  const down = planJournalStep(token, prior, null, NOW);
  assert.equal(down.corrupted, false, "a valid history is not distrusted");
  assert.equal(down.entry, prior, "the healthy entry keeps the by-reference contract");
  assert.deepEqual(down.replay, prior.events, "the healthy history is replayed");
  assert.doesNotThrow(() => bindMintAndValidate(down.replay, MINT));
});

test("a mint-LESS element is a genuine legacy record, not corruption — the gate binds the token's mint itself", (t) => {
  // every journal element carries mint because the WRITER bound it; the gate must not
  // demand it back: validation runs over a copy with the token's mint bound, and the
  // boot replay binds the mint the same way. A gate that refuses mint-less elements
  // classifies the honest legacy history corrupted — fail-closed erases it on the
  // first live load (replay: [], events: []) with no chain evidence of wrongdoing.
  const errLog = t.mock.method(console, "error", () => {});
  const legacy = {
    type: "MULTIPLIER_CHANGE",
    effectiveDate: "2026-06-10T04:30:00.000Z",
    status: "confirmed",
    sources: ["solana:getAccountInfo:x#scaledUiAmountConfig"],
    multiplierFrom: "1", multiplierTo: "5",
  };
  const prior = {
    lastEffective: "5",
    observedAt: "2026-09-01T00:00:00.000Z",
    events: [legacy],
  };
  const down = planJournalStep(token, prior, null, NOW);
  assert.equal(down.corrupted, false, "a mint-less element is completed by the token's mint, not distrusted");
  assert.equal(errLog.mock.callCount(), 0, "no corruption is reported for a healthy legacy record");
  assert.deepEqual(down.replay, prior.events, "the legacy history is replayed");
  assert.equal(down.entry, prior, "the legacy entry keeps the by-reference contract");
  // the exact boot sequence over the step's output: the replay binding supplies the mint
  assert.doesNotThrow(() => bindMintAndValidate(down.replay, MINT), "the replay survives the boot validation unchanged");
  // and on a live chain the legacy base produces the normal mid-history step, no wipe
  const live = planJournalStep(token, prior, LIVE, NOW);
  assert.equal(live.corrupted, false, "the legacy history is not wiped on a live chain either");
  assert.notEqual(live.entry, null);
  assert.notEqual(live.entry.events.length, 0, "the legacy history is carried over, not reset to empty");
});

test("the gate classifies a COPY: a datetime DIVIDEND_ACCRUAL is validated without rewriting the record in place", (t) => {
  // validateEvent canonicalizes a DIVIDEND_ACCRUAL's date in place — that is correct on
  // the ENTRY paths it owns, but the gate is a PREDICATE over a record it may decline or
  // hand back untouched: validating the element itself would silently rewrite the journal
  // on disk (the tz-spelling "2026-06-18T05:00:00+03:00" becomes "2026-06-18" merely
  // because the token's health was checked) and the by-reference contract would return
  // the mutated record. The element carries its own mint — a healthy record, classified
  // through a copy — so the assertion below isolates the copy, not the mint binding.
  const dividend = {
    type: "DIVIDEND_ACCRUAL", mint: MINT,
    effectiveDate: "2026-06-18T05:00:00+03:00",
    status: "confirmed", sources: ["https://issuer.example/dividends/q2"],
    amountPerUnitRaw: 1000, decimals: 6,
  };
  const prior = {
    lastEffective: "2",
    observedAt: "2026-09-01T00:00:00.000Z",
    events: [dividend],
  };
  const before = JSON.stringify(prior);
  const down = planJournalStep(token, prior, null, NOW);
  assert.equal(down.corrupted, false, "a datetime spelling is schema-valid — the element is healthy");
  assert.equal(down.entry, prior, "the healthy entry keeps the by-reference contract");
  assert.deepEqual(down.replay, prior.events, "the healthy history is replayed");
  assert.equal(JSON.stringify(prior), before, "classification left the record byte-identical");
  assert.equal(prior.events[0].effectiveDate, "2026-06-18T05:00:00+03:00",
    "the tz-spelled effectiveDate was not canonicalized in place by the gate");
});
