// The corrupted branch of planJournalStep must honor the journal contract "no chain
// fact — no record". When the corrupted history is distrusted and the live chain offers
// NO fact (a token without the scaledUiAmount extension: the parser's default "1" is not
// a fact), journalTransition honestly returns entry:null — and the rebuild used to
// spread {...null, events:[]} into a GHOST record: no lastEffective, no observedAt,
// persisted forever, in violation of the documented entry shape. A recovery that has
// nothing to recover with must leave the journal slot untouched — the broken record on
// disk stays as the evidence (loudly reported on every boot) until a chain fact rebuilds it.
import test from "node:test";
import assert from "node:assert/strict";
import { planJournalStep, saveJournalAtomic, loadJournalOnchain } from "../src/events/journal.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const token = { mint: MINT, symbol: "TESTx" };
const NOW = Date.parse("2026-10-02T12:00:00Z");

const parsedOf = (active, pending, date, hasExtension = true) => ({
  hasExtension, decimals: 8,
  activeMultiplier: active,
  pendingMultiplier: pending,
  pendingEffectiveDate: date,
  authority: null,
});

test("corrupted record + live chain + no rebase extension: entry null, the ghost {events:[]} is not materialized", (t) => {
  const errLog = t.mock.method(console, "error", () => {});
  const prior = { lastEffective: "1", observedAt: "2026-09-01T00:00:00.000Z", events: "garbage" };
  const step = planJournalStep(token, prior, parsedOf("1", null, null, false), NOW);
  assert.equal(step.corrupted, true);
  assert.equal(step.chain, "ok");
  assert.equal(step.entry, null, "no chain fact — no record: an entry-less rebuild must not invent a shapeless one");
  assert.equal(errLog.mock.callCount(), 1, "the corruption stays loud");
});

test("the untouched slot keeps the broken evidence on disk: the next boot still reports corruption instead of trusting a ghost", (t) => {
  const errLog = t.mock.method(console, "error", () => {});
  const dir = mkdtempSync(path.join(tmpdir(), "lotwise-journal-ghost-"));
  const p = path.join(dir, "onchain-journal.json");
  try {
    const prior = { lastEffective: "1", observedAt: "2026-09-01T00:00:00.000Z", events: "garbage" };
    const step = planJournalStep(token, prior, parsedOf("1", null, null, false), NOW);
    assert.equal(step.entry, null, "precondition: the step left the slot untouched");
    // serve persists the whole map; the slot was never reassigned — the poisoned record
    // stays exactly as it was on disk (the evidence survives the step)
    saveJournalAtomic(p, { [MINT]: prior });
    const loaded = loadJournalOnchain(p);
    assert.equal(loaded.ok, true);
    assert.deepEqual(loaded.journal[MINT], prior, "the broken record is not replaced by a ghost");

    const next = planJournalStep(token, loaded.journal[MINT], parsedOf("1", null, null, false), NOW + 86_400_000);
    assert.equal(next.corrupted, true, "the next boot does not mistake the ghost for a healthy entry");
    assert.equal(next.entry, null);
    assert.equal(errLog.mock.callCount(), 2, "the evidence is re-reported on every boot, not swallowed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with a chain fact the rebuild keeps its full honest shape: lastEffective + observedAt + empty events", (t) => {
  const errLog = t.mock.method(console, "error", () => {});
  const prior = { lastEffective: "1", observedAt: "2026-09-01T00:00:00.000Z", events: "garbage" };
  const step = planJournalStep(token, prior, parsedOf("5", null, null, true), NOW);
  assert.equal(step.corrupted, true);
  assert.notEqual(step.entry, null, "a chain fact rebuilds the record");
  assert.equal(step.entry.lastEffective, "5", "lastEffective fixed from the chain's fact");
  assert.equal(step.entry.observedAt, new Date(NOW).toISOString(), "observedAt is the observation moment");
  assert.deepEqual(step.entry.events, [], "the old history is unrecoverable — events honestly empty");
});
