// regression tests of the Lotwise review — zone src/api/server.mjs.
// Findings:
//   LW2_excluded_unmarked_multiplier_and_events — the excluded-token fix ("an excluded token
//       showed multiplier 1") covered /summary, /lots and /health, but not /multiplier
//       and /events. For an excluded token (TimelineError at startup, events hidden
//       from eventsByMint) /multiplier answers a fabricated "1" with events:0 WITHOUT the
//       excluded field — indistinguishable from an honest "no events"; /events serves a silent []
//       although the token has events.
//   LW2_excluded_token_adjusted_row_unmarked (cross-zone, the server part) — the row
//       of an excluded token in /lots carries no adjustedAvailable:false — the contract
//       for the vitrine "adjusted — not computed" (t.adjustedAvailable === false || t.excluded).
import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/api/server.mjs";
import { multiplierHistoryToEvents, bindMintAndValidate } from "../src/events/normalize-xstocks.mjs";
import { loadRegistry } from "../src/registry/registry.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const SPYx = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const OWNER = "9BB7Tt5uW5QbAorLkF3Hn1P2mGcXvcDdR7y8LbT9KdUu"; // the shared fixture owner

const historyNodes = JSON.parse(readFileSync(path.join(dir, "xstocks-spyx-history-eth.json"), "utf8")).nodes;
const events = bindMintAndValidate(multiplierHistoryToEvents(historyNodes, { symbol: "SPYx" }), SPYx);

// Server with a "poisoned" mint: a broken chain → TimelineError at startup → the token
// is excluded from the vitrine (the api.test.mjs pattern).
async function withPoisonedServer(fn, optsFn = null) {
  const registry = await loadRegistry("data/tokens.json");
  const bad = registry.find((t) => t.symbol === "T-SpaceX");
  const poisoned = [
    ...events,
    {
      type: "MULTIPLIER_CHANGE", mint: bad.mint, effectiveDate: "2026-05-01T00:00:00.000Z",
      status: "confirmed", sources: ["test:broken-chain"],
      multiplierFrom: "5", multiplierTo: "6", reason: "On-chain rebase",
    },
  ];
  const opts = typeof optsFn === "function" ? optsFn(bad) : {};
  const server = await createApiServer({ registry, events: poisoned, ...opts });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`, bad);
  } finally {
    server.close();
  }
}

// ---- LW2_excluded_unmarked_multiplier_and_events: /multiplier ----

test("/multiplier: an excluded token — the \"1\" is marked excluded+excludedReason, not bare", async () => {
  await withPoisonedServer(async (base, bad) => {
    const res = await fetch(`${base}/multiplier?symbol=T-SpaceX&raw=1000`);
    assert.equal(res.status, 200);
    const m = await res.json();
    assert.equal(m.mint, bad.mint);
    assert.equal(m.multiplier, "1"); // the value is the same raw one, but now honestly marked
    assert.equal(m.events, 0);
    assert.equal(m.excluded, true); // was: undefined — the "1" was indistinguishable from "no events"
    assert.ok(typeof m.excludedReason === "string" && m.excludedReason.length > 0);
  });
});

test("/multiplier: the marking is additive — a live token answers as before, without flags", async () => {
  await withPoisonedServer(async (base) => {
    const m = await (await fetch(`${base}/multiplier?symbol=SPYx&raw=100000000&date=2026-07-01`)).json();
    assert.equal(m.multiplier, "1.005714560286254");
    assert.equal(m.events, 4);
    assert.equal(m.sampleScaledQty.exact, false); // the fields of a legitimate response are untouched
    assert.equal(m.excluded, undefined);
    assert.equal(m.excludedReason, undefined);
  });
});

// ---- LW2_excluded_unmarked_multiplier_and_events: /events ----

test("/events: an excluded token — an honest refusal with a reason instead of a silent []", async () => {
  await withPoisonedServer(async (base) => {
    const res = await fetch(`${base}/events?symbol=T-SpaceX`);
    assert.equal(res.status, 400); // the endpoint convention for a broken symbol — same as for an unknown one
    const body = await res.json();
    assert.match(body.error, /excluded/i); // the reason is available in the message
    assert.equal(body.excluded, true);
    assert.ok(typeof body.excludedReason === "string" && body.excludedReason.length > 0);
  });
});

test("/events: the convention did not overreach — an unknown symbol 400, a live one stays an array", async () => {
  await withPoisonedServer(async (base) => {
    const unknown = await fetch(`${base}/events?symbol=NOSUCHx`);
    assert.equal(unknown.status, 400);
    const good = await (await fetch(`${base}/events?symbol=SPYx`)).json();
    assert.ok(Array.isArray(good)); // the shape of a legitimate response unchanged
    assert.equal(good.length, 4);
  });
});

// ---- LW2_excluded_token_adjusted_row_unmarked: /lots post-processing ----

test("/lots: an excluded token has adjustedAvailable:false with raw fields preserved; a regular one has no such field", async () => {
  const scanOf = (badMint) => ({
    owner: OWNER, signatures: 1, fetched: 1, skipped: [], truncated: false,
    accounts: new Map([
      [badMint, { address: "At5", currentRaw: 10n }],
      [SPYx, { address: "At6", currentRaw: 60n }],
    ]),
    txs: [
      { signature: "a", slot: 1, blockTime: 100, deltas: [{ owner: OWNER, mint: badMint, preRaw: 0n, postRaw: 10n, deltaRaw: 10n }] },
      { signature: "b", slot: 2, blockTime: 200, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 0n, postRaw: 60n, deltaRaw: 60n }] },
    ],
  });
  await withPoisonedServer(async (base) => {
    const rep = await (await fetch(`${base}/lots?address=${OWNER}`)).json();
    const excluded = rep.tokens.find((x) => x.symbol === "T-SpaceX");
    assert.ok(excluded, "the excluded-mint token is present in the report");
    assert.equal(excluded.excluded, true);
    assert.equal(excluded.adjustedAvailable, false); // the vitrine contract: "adjusted — not computed"
    assert.equal(excluded.rawBalance, "10"); // raw values are not falsified
    assert.equal(excluded.netDeltaRaw, "10");
    assert.equal(excluded.adjusted.whole, "10"); // the fallback is identical — that is why it is marked
    const good = rep.tokens.find((x) => x.symbol === "SPYx");
    assert.ok(good, "the live token is in the report too");
    // the /lots post-processing marks ONLY the excluded ones: a regular token is not shown
    // "adjusted — not computed" (the vitrine contract noAdjusted = excluded ||
    // adjustedAvailable === false does not fire). The field's value for a regular token
    // (true/undefined) is report.mjs's concern, a foreign zone: here only "not false" matters.
    assert.notEqual(good.adjustedAvailable, false);
    assert.equal(good.excluded, undefined);
  }, (bad) => ({ walletScanner: async () => scanOf(bad.mint) }));
});
