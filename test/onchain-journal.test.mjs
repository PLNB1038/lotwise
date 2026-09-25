import test from "node:test";
import assert from "node:assert/strict";
import { backfillMultiplierEvent, journalTransition, OnchainNormalizeError } from "../src/events/normalize-onchain.mjs";
import { parseScaledUiAmount } from "../src/issuer/scaled-ui.mjs";
import { multiplierHistoryToEvents } from "../src/events/normalize-xstocks.mjs";
import { MultiplierTimeline } from "../src/lots/timeline.mjs";
import { loadRegistry } from "../src/registry/registry.mjs";
import { createApiServer } from "../src/api/server.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name) => parseScaledUiAmount(JSON.parse(readFileSync(path.join(dir, name), "utf8")).result.value);
const registryOf = async () => await loadRegistry("data/tokens.json");
const tokenOf = async (symbol) => (await registryOf()).find((t) => t.symbol === symbol);

// "now" after both activation dates — as in the live run of 19.09
const NOW = Date.parse("2026-09-19T00:00:00Z");

test("SPACEX: the live mint gives a backfill 1 -> 5 @ 2026-06-10", async () => {
  const t = await tokenOf("SPACEX");
  const parsed = fixture("onchain-spacex-mint.json");
  const e = backfillMultiplierEvent(t, parsed, NOW);
  assert.ok(e);
  assert.equal(e.type, "MULTIPLIER_CHANGE");
  assert.equal(e.multiplierFrom, "1");
  assert.equal(e.multiplierTo, "5");
  assert.equal(e.effectiveDate, "2026-06-10T04:30:00.000Z");
  assert.equal(e.status, "confirmed");
  assert.ok(e.sources[0].includes(t.mint));
});

test("OPENAI: a backfill 1 -> 1.4861347 @ 2026-07-17", async () => {
  const t = await tokenOf("OPENAI");
  const e = backfillMultiplierEvent(t, fixture("onchain-openai-mint.json"), NOW);
  assert.equal(e.multiplierFrom, "1");
  assert.equal(e.multiplierTo, "1.4861347");
  assert.equal(e.effectiveDate, "2026-07-17T16:30:00.000Z");
});

test("T-SpaceX (Tessera): no extension — null, that is a fact, not an error", async () => {
  const t = await tokenOf("T-SpaceX");
  assert.equal(backfillMultiplierEvent(t, fixture("onchain-t-spacex-mint.json"), NOW), null);
});

test("a pending with a future date: the event is dated by the future, the effective does not change now", async () => {
  const t = await tokenOf("SPACEX");
  const parsed = {
    hasExtension: true, decimals: 8,
    activeMultiplier: "5",
    pendingMultiplier: "6",
    pendingEffectiveDate: "2026-12-01T00:00:00.000Z",
    authority: null,
  };
  const e = backfillMultiplierEvent(t, parsed, NOW);
  assert.equal(e.multiplierFrom, "5");
  assert.equal(e.multiplierTo, "6");
  assert.equal(e.effectiveDate, "2026-12-01T00:00:00.000Z");
});

test("journal: a first observation of SPACEX — a backfill event + an entry with the effective value", async () => {
  const t = await tokenOf("SPACEX");
  const { event, entry } = journalTransition(t, fixture("onchain-spacex-mint.json"), null, NOW);
  assert.ok(event);
  assert.equal(entry.lastEffective, "5"); // the pending of 10.06 is already in force
  assert.equal(entry.observedAt, new Date(NOW).toISOString());
});

test("journal: no changes — no event, the entry only updates observedAt", async () => {
  const t = await tokenOf("SPACEX");
  const { event, entry } = journalTransition(t, fixture("onchain-spacex-mint.json"), { lastEffective: "5", observedAt: "2026-09-01T00:00:00Z" }, NOW);
  assert.equal(event, null);
  assert.equal(entry.lastEffective, "5");
});

test("journal: a rotation 5 -> 7 by a new pending is caught by the diff", async () => {
  const t = await tokenOf("SPACEX");
  const rotated = {
    hasExtension: true, decimals: 8,
    activeMultiplier: "5", // the field is not rotated yet (the observed chain pattern)
    pendingMultiplier: "7",
    pendingEffectiveDate: "2026-09-15T00:00:00.000Z",
    authority: null,
  };
  // a record with the REAL chain 1 -> 5: the diff 5 -> 7 continues it — emitted
  const prior = {
    lastEffective: "5", observedAt: "2026-09-01T00:00:00Z",
    events: [{
      type: "MULTIPLIER_CHANGE", mint: t.mint, effectiveDate: "2026-06-10T04:30:00.000Z",
      status: "confirmed", sources: ["solana:getAccountInfo"],
      multiplierFrom: "1", multiplierTo: "5", reason: "On-chain rebase",
    }],
  };
  const { event, entry } = journalTransition(t, rotated, prior, NOW);
  assert.ok(event);
  assert.equal(event.multiplierFrom, "5");
  assert.equal(event.multiplierTo, "7");
  assert.equal(event.effectiveDate, "2026-09-15T00:00:00.000Z");
  assert.equal(entry.lastEffective, "7");
});

test("the journal events are compatible with MultiplierTimeline: the SPACEX multiplier today = 5", async () => {
  const t = await tokenOf("SPACEX");
  const e = backfillMultiplierEvent(t, fixture("onchain-spacex-mint.json"), NOW);
  const tl = new MultiplierTimeline([e]);
  assert.equal(tl.multiplierAt("2026-06-09T23:59:59Z"), "1");
  assert.equal(tl.multiplierAt("2026-06-10T04:30:00Z"), "5");
  assert.equal(tl.multiplierAt(new Date(NOW).toISOString()), "5");
  // the adjusted quantity: 2 SPACEX raw -> 10 scaled
  const s = tl.scaledQty(200000000n, new Date(NOW).toISOString());
  assert.equal(s.whole, 1000000000n);
  assert.equal(s.exact, true);
});

test("integration: /summary sees the on-chain events (SPACEX events=1, multiplier=5)", async () => {
  const registry = await registryOf();
  const events = [];
  for (const symbol of ["SPACEX", "OPENAI"]) {
    const t = await tokenOf(symbol);
    const e = backfillMultiplierEvent(t, fixture(`onchain-${symbol.toLowerCase()}-mint.json`), NOW);
    if (e) events.push(e);
  }
  const server = await createApiServer({ registry, events });
  const { port } = server.address();
  try {
    const rows = await (await fetch(`http://127.0.0.1:${port}/summary`)).json();
    const spacex = rows.find((r) => r.symbol === "SPACEX");
    assert.equal(spacex.events, 1);
    assert.equal(spacex.currentMultiplier, "5");
    const openai = rows.find((r) => r.symbol === "OPENAI");
    assert.equal(openai.currentMultiplier, "1.4861347");
    const tesla = rows.find((r) => r.symbol === "T-SpaceX"); // no extension — multiplier 1, honestly
    assert.equal(tesla.events, 0);
    assert.equal(tesla.currentMultiplier, "1");
  } finally {
    server.close();
  }
});

test("a broken date in the pending is rejected by the schema validation, not silently", async () => {
  const t = await tokenOf("SPACEX");
  const bad = {
    hasExtension: true, decimals: 8,
    activeMultiplier: "1",
    pendingMultiplier: "5",
    pendingEffectiveDate: "not-a-date",
    authority: null,
  };
  assert.throws(() => backfillMultiplierEvent(t, bad, NOW), OnchainNormalizeError);
});

// ---- (P0): the journal events survive a process restart ----

import { planJournalStep, issuerChainComplete } from "../src/events/journal.mjs";

test("P0-restart: a replay of entry.events instead of a loss (the multiplier does not roll back to 1)", async () => {
  const t = await tokenOf("SPACEX");
  const parsed = fixture("onchain-spacex-mint.json");
  const boot1 = planJournalStep(t, null, parsed, NOW);
  assert.ok(boot1.event); // 1 -> 5
  assert.equal(boot1.entry.events.length, 1);
  // a restart: the same chain plan — no new event, the old one must be replayed
  const boot2 = planJournalStep(t, boot1.entry, parsed, NOW + 60_000);
  assert.equal(boot2.event, null);
  assert.deepEqual(boot2.replay, boot1.entry.events);
  const tl = new MultiplierTimeline(boot2.replay);
  assert.equal(tl.multiplierAt(new Date(NOW).toISOString()), "5");
});

test("P0-degradation: the chain unavailable at startup — a replay of the cache, the record untouched", async () => {
  const t = await tokenOf("SPACEX");
  const parsed = fixture("onchain-spacex-mint.json");
  const boot1 = planJournalStep(t, null, parsed, NOW);
  const boot2 = planJournalStep(t, boot1.entry, null, NOW + 60_000);
  assert.equal(boot2.chain, "unavailable");
  assert.equal(boot2.replay.length, 1);
  assert.equal(boot2.entry, boot1.entry); // the same reference: observedAt does not lie "observed now"
});

test("P0-migration: a v1 record (without events) self-heals by backfill", async () => {
  const t = await tokenOf("SPACEX");
  const parsed = fixture("onchain-spacex-mint.json");
  const v1 = { lastEffective: "5", observedAt: "2026-09-19T03:50:00Z" }; // the old file format on disk
  const step = planJournalStep(t, v1, parsed, NOW);
  assert.ok(step.event); // the pending is still visible in the mint — the backfill re-emits 1 -> 5
  assert.equal(step.entry.events.length, 1);
});

test("a rotation over a replay: the continuity 1 -> 5 -> 7 after a restart", async () => {
  const t = await tokenOf("SPACEX");
  const parsed = fixture("onchain-spacex-mint.json");
  const boot1 = planJournalStep(t, null, parsed, NOW);
  const rotated = {
    hasExtension: true, decimals: 8,
    activeMultiplier: "5", pendingMultiplier: "7",
    pendingEffectiveDate: "2026-09-15T00:00:00.000Z", authority: null,
  };
  const boot2 = planJournalStep(t, boot1.entry, rotated, NOW);
  assert.ok(boot2.event);
  assert.equal(boot2.event.multiplierFrom, "5");
  const tl = new MultiplierTimeline([...boot2.replay, boot2.event]);
  assert.equal(tl.multiplierAt("2026-09-20"), "7");
  assert.equal(tl.multiplierAt("2026-06-15"), "5");
});

test("P0-integration: /summary after a restart sees SPACEX=5, /health serves the journal stats", async () => {
  const registry = await registryOf();
  const t = await tokenOf("SPACEX");
  const parsed = fixture("onchain-spacex-mint.json");
  const boot1 = planJournalStep(t, null, parsed, NOW);
  const boot2 = planJournalStep(t, boot1.entry, parsed, NOW + 60_000);
  const events = [...boot2.replay, ...(boot2.event ? [boot2.event] : [])]; // as serve.mjs pushes
  const server = await createApiServer({
    registry, events,
    journalStats: { replayed: boot2.replay.length, unavailable: 0 },
  });
  const { port } = server.address();
  try {
    const rows = await (await fetch(`http://127.0.0.1:${port}/summary`)).json();
    assert.equal(rows.find((r) => r.symbol === "SPACEX").currentMultiplier, "5");
    const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.deepEqual(h.journal, { replayed: 1, unavailable: 0 });
  } finally {
    server.close();
  }
});

// ---- (P1): the eternal boot-loop — events only as a continuation of the chain from "1" ----

// trigger A: a token is first observed in the middle of the history (an active "5" baked in, a pending in the future)
const midHistoryMint = {
  hasExtension: true, decimals: 8,
  activeMultiplier: "5", pendingMultiplier: "6",
  pendingEffectiveDate: "2026-12-01T00:00:00.000Z",
  authority: null,
};

test("trigger A: a first mid-history observation — no event is invented (event=null, events=[])", async () => {
  const t = await tokenOf("SPACEX");
  // earlier a 5->6 was emitted here: a TimelineError in createApiServer, the poison persisted — an eternal boot-loop
  const { event, entry } = journalTransition(t, midHistoryMint, null, NOW);
  assert.equal(event, null);
  assert.equal(entry.lastEffective, "5"); // lastEffective updated
  assert.deepEqual(entry.events, []);
});

test("trigger A, the activation day: the diff with an empty history is not emitted — a second 5->6 does not appear", async () => {
  const t = await tokenOf("SPACEX");
  const boot = journalTransition(t, midHistoryMint, null, NOW); // an observation before the activation
  const activated = { ...midHistoryMint, pendingEffectiveDate: "2026-09-10T00:00:00.000Z" }; // the pending already in force
  const { event, entry } = journalTransition(t, activated, boot.entry, NOW);
  assert.equal(event, null); // from="5" with events=[] — the same chain-break class
  assert.equal(entry.lastEffective, "6");
  assert.deepEqual(entry.events, []); // no duplicate of the old 5->6 — zero events at all
  // the serve.mjs warn condition honestly fires on such a record
  assert.ok(entry.lastEffective !== "1" && entry.events.length === 0);
});

test("trigger B: seen after a completed rotation — the next rotation does not emit from='5'", async () => {
  const t = await tokenOf("SPACEX");
  const completed = {
    hasExtension: true, decimals: 8,
    activeMultiplier: "5", pendingMultiplier: null,
    pendingEffectiveDate: null, authority: null,
  };
  const boot = journalTransition(t, completed, null, NOW);
  assert.equal(boot.event, null);
  assert.equal(boot.entry.lastEffective, "5");
  assert.deepEqual(boot.entry.events, []);
  // the next corporate action: earlier the diff 5->6 tore the timeline; now only lastEffective
  const rotated = { ...completed, pendingMultiplier: "6", pendingEffectiveDate: "2026-09-10T00:00:00.000Z" };
  const step = journalTransition(t, rotated, boot.entry, NOW);
  assert.equal(step.event, null);
  assert.equal(step.entry.lastEffective, "6");
  assert.deepEqual(step.entry.events, []);
  assert.ok(step.entry.lastEffective !== "1" && step.entry.events.length === 0); // the warn condition
});

test("an inconsistent journal (the last event does not end at lastEffective) — the diff is not emitted", async () => {
  const t = await tokenOf("SPACEX");
  const prior = {
    lastEffective: "5", observedAt: "2026-09-01T00:00:00Z",
    events: [{
      type: "MULTIPLIER_CHANGE", mint: t.mint, effectiveDate: "2026-06-10T04:30:00.000Z",
      status: "confirmed", sources: ["journal:hand-edited"],
      multiplierFrom: "1", multiplierTo: "7", reason: "On-chain rebase",
    }],
  };
  const rotated = {
    hasExtension: true, decimals: 8,
    activeMultiplier: "5", pendingMultiplier: "6",
    pendingEffectiveDate: "2026-09-15T00:00:00.000Z", authority: null,
  };
  const { event, entry } = journalTransition(t, rotated, prior, NOW);
  assert.equal(event, null); // from="5" but the chain ends at "7" — must not be pushed
  assert.equal(entry.lastEffective, "6");
  assert.equal(entry.events.length, 1); // the history untouched
});

test("a full boot on a broken mint: the events are empty, the timeline builds — a boot-loop excluded", async () => {
  const t = await tokenOf("SPACEX");
  const boot1 = planJournalStep(t, null, midHistoryMint, NOW);
  assert.equal(boot1.event, null);
  const activated = { ...midHistoryMint, pendingEffectiveDate: "2026-09-10T00:00:00.000Z" };
  const boot2 = planJournalStep(t, boot1.entry, activated, NOW + 60_000);
  assert.equal(boot2.event, null);
  const fed = [...boot2.replay, ...(boot2.event ? [boot2.event] : [])]; // as serve.mjs pushes
  const tl = new MultiplierTimeline(fed); // earlier it threw TimelineError: chain discontinuity
  assert.equal(tl.multiplierAt(new Date(NOW).toISOString()), "1");
});

test("a normal chain continuation is emitted as before (the positive control of the gate)", async () => {
  const t = await tokenOf("SPACEX");
  const boot1 = planJournalStep(t, null, fixture("onchain-spacex-mint.json"), NOW); // 1 -> 5
  const rotated = {
    hasExtension: true, decimals: 8,
    activeMultiplier: "5", pendingMultiplier: "7",
    pendingEffectiveDate: "2026-09-15T00:00:00.000Z", authority: null,
  };
  const boot2 = planJournalStep(t, boot1.entry, rotated, NOW);
  assert.ok(boot2.event); // the priorEvents end at "5" === from — a continuation
  assert.equal(boot2.event.multiplierTo, "7");
});

// ---- (P1): a pending "0" from the chain — the issuer's way to "reset" the pending ----

const zeroPendingMint = {
  hasExtension: true, decimals: 8,
  activeMultiplier: "5", pendingMultiplier: "0",
  pendingEffectiveDate: "2026-01-01T00:00:00.000Z", // a past date — earlier a "0" would be considered effective
  authority: null,
};

test("a pending '0' is treated as absent: effective = active, not '0'", async () => {
  const t = await tokenOf("SPACEX");
  const { event, entry } = journalTransition(t, zeroPendingMint, null, NOW);
  assert.equal(entry.lastEffective, "5"); // not "0": the journal does not emit 5->0, the vitrine shows no zeros
  assert.equal(event, null);
  assert.deepEqual(entry.events, []);
});

test("a pending '0': no backfill event is built (a 5->0 will not get into the journal)", async () => {
  const t = await tokenOf("SPACEX");
  assert.equal(backfillMultiplierEvent(t, zeroPendingMint, NOW), null);
});

// ---- (P1): a v1 record + an unavailable chain — an honest warn, not a quiet multiplier 1 ----

test("a v1 record + an unavailable chain: unavailableV1=true — the vitrine does not stay silent about the multiplier 1", async () => {
  const t = await tokenOf("SPACEX");
  const step = planJournalStep(t, { lastEffective: "5", observedAt: "2026-09-19T03:50:00Z" }, null, NOW);
  assert.equal(step.chain, "unavailable");
  assert.equal(step.entry, null);
  assert.deepEqual(step.replay, []);
  assert.equal(step.unavailableV1, true); // a signal for the warn in serve.mjs
  // a v1 with the multiplier "1" — no lie, no warn needed
  const trivial = planJournalStep(t, { lastEffective: "1", observedAt: "2026-09-19T03:50:00Z" }, null, NOW);
  assert.equal(trivial.unavailableV1, false);
  // a v2 record is replayed from the cache — the flag does not fire
  const boot1 = planJournalStep(t, null, fixture("onchain-spacex-mint.json"), NOW);
  const down = planJournalStep(t, boot1.entry, null, NOW + 60_000);
  assert.equal(down.unavailableV1, false);
  assert.equal(down.replay.length, 1);
  // and on a live chain the flag does not fire
  const ok = planJournalStep(t, boot1.entry, fixture("onchain-spacex-mint.json"), NOW + 60_000);
  assert.equal(ok.unavailableV1, false);
});

// ---- (P2): the completeness of the issuer history chain (the serve pagination) ----

test("issuerChainComplete: a chain from '1' is complete, the node order does not matter", () => {
  const nodes = [
    { previousMultiplier: "1.005", multiplier: "1.01", activationDateTime: "2026-06-01T00:00:00Z" },
    { previousMultiplier: "1", multiplier: "1.005", activationDateTime: "2026-01-01T00:00:00Z" },
  ];
  assert.deepEqual(issuerChainComplete(nodes), { complete: true, reason: null });
});

test("issuerChainComplete: the oldest node not from '1' — the history incomplete (a truncated pagination)", () => {
  const nodes = [
    { previousMultiplier: "1.005", multiplier: "1.01", activationDateTime: "2026-06-01T00:00:00Z" },
    { previousMultiplier: "1.002", multiplier: "1.005", activationDateTime: "2026-01-01T00:00:00Z" },
  ];
  const r = issuerChainComplete(nodes);
  assert.equal(r.complete, false);
  assert.match(r.reason, /not from "1"/); // EN
});

test("issuerChainComplete: an empty history is complete, date garbage — incomplete (fail-closed)", () => {
  assert.deepEqual(issuerChainComplete([]), { complete: true, reason: null });
  const bad = issuerChainComplete([{ previousMultiplier: "1", multiplier: "2", activationDateTime: "not-a-date" }]);
  assert.equal(bad.complete, false);
  assert.match(bad.reason, /unparseable activation date/); // EN
});
