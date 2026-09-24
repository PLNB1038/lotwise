// formerly round6-chain-date-strict.test.mjs
// Round 6 regression tests — the finding LW2_issuer_chain_complete_dateparse_divergence.
// issuerChainComplete was the last place of the pipeline on Date.parse: rolled-over dates
// ("2026-02-30T00:00:00Z" → March 2) and naive dates (the host's local time) passed
// the chain completeness gate, then fell in multiplierHistoryToEvents with NormalizeError —
// the gate and the normalizer lived in different date semantics, and serve.mjs classified
// this as "source unavailable" with the source alive. Contract: the same strict
// parseIsoDateMs as the rest of the pipeline (schema/isodate.mjs); a node with a garbage
// date does not participate in choosing the oldest — the gate answers complete:false with an honest
// "unparseable date" reason (fail-closed, as before for "not-a-date").
import test from "node:test";
import assert from "node:assert/strict";
import { issuerChainComplete } from "../src/events/journal.mjs";
import { multiplierHistoryToEvents, NormalizeError } from "../src/events/normalize-xstocks.mjs";

test("the rolled-over date 2026-02-30 does not pass the gate (Date.parse rolled it over to March 2 and gave complete:true)", () => {
  const r = issuerChainComplete([
    { previousMultiplier: "1", multiplier: "2", activationDateTime: "2026-02-30T00:00:00Z" },
  ]);
  assert.equal(r.complete, false);
  // NOTE (i18n sync): matches the RUSSIAN reason text produced by src/events/journal.mjs
  // src now says "unparseable activation date" (round 19: EN).
  assert.match(r.reason, /unparseable activation date/); // round 19: EN
  assert.match(r.reason, /2026-02-30/); // the reason names the specific node
});

test("a naive date without a timezone does not pass the gate (Date.parse treated it as local time)", () => {
  const r = issuerChainComplete([
    { previousMultiplier: "1", multiplier: "2", activationDateTime: "2026-05-01T12:00:00" },
  ]);
  assert.equal(r.complete, false);
  // NOTE (i18n sync): matches the RUSSIAN reason text of src/events/journal.mjs (see above).
  assert.match(r.reason, /unparseable activation date/); // round 19: EN
});

test("a garbage date does not participate in choosing the oldest: the verdict is incomplete regardless of the other nodes", () => {
  // even if the valid nodes form a chain from "1" — a node with a rolled-over date makes
  // the set unverifiable, a "rolled-over" oldest does not substitute the verdict
  const r = issuerChainComplete([
    { previousMultiplier: "1.002", multiplier: "1.005", activationDateTime: "2026-01-01T00:00:00Z" },
    { previousMultiplier: "1", multiplier: "1.002", activationDateTime: "2026-02-30T00:00:00Z" },
  ]);
  assert.equal(r.complete, false);
  // and vice versa: a genuinely incomplete start is not masked by a neighbor's garbage date
  const r2 = issuerChainComplete([
    { previousMultiplier: "1.002", multiplier: "1.005", activationDateTime: "2026-01-01T00:00:00Z" },
    { previousMultiplier: "1", multiplier: "1.002", activationDateTime: "not-a-date" },
  ]);
  assert.equal(r2.complete, false);
});

test("a valid chain is not broken by the strict parser: mixed second precision, any order", () => {
  const nodes = [
    { previousMultiplier: "1.02", multiplier: "1.04", activationDateTime: "2026-08-01T00:00:00.500Z" },
    { previousMultiplier: "1", multiplier: "1.02", activationDateTime: "2026-01-15T00:00:00Z" },
  ];
  assert.deepEqual(issuerChainComplete(nodes), { complete: true, reason: null });
  assert.deepEqual(issuerChainComplete([...nodes].reverse()), { complete: true, reason: null });
});

test("the pipeline in one date semantics: everything passing the gate must be accepted by the normalizer", () => {
  const nodes = [
    { id: "a", reason: "Split", multiplier: "2", previousMultiplier: "1", activationDateTime: "2026-03-01T00:00:00Z" },
  ];
  assert.deepEqual(issuerChainComplete(nodes), { complete: true, reason: null });
  const events = multiplierHistoryToEvents(nodes, { symbol: "TESTx" });
  assert.equal(events[0].effectiveDate, "2026-03-01T00:00:00Z");
});

test("the sought divergence is dead: the gate refuses BEFORE the normalizer — \"source unavailable\" no longer lies", () => {
  const rollover = [{ previousMultiplier: "1", multiplier: "2", activationDateTime: "2026-02-30T00:00:00Z" }];
  const naive = [{ previousMultiplier: "1", multiplier: "2", activationDateTime: "2026-05-01T12:00:00" }];
  for (const nodes of [rollover, naive]) {
    // the gate: events are not fed to the timeline, with an honest reason
    assert.equal(issuerChainComplete(nodes).complete, false);
    // and if they were fed anyway — the normalizer is still fail-closed, it did not get quieter
    assert.throws(() => multiplierHistoryToEvents(nodes, { symbol: "TESTx" }), NormalizeError);
  }
});
