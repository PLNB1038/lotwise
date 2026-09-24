// formerly round7-api-excluded.test.mjs
// Round 7 regression tests of the Lotwise review — zone src/api/server.mjs.
// Finding ROUND7 #1/#2: rounds 5–6 marked excluded tokens in /summary, /lots,
// /multiplier, /events, /accruals, /health — but not /onchain and not /crosscheck.
//   /onchain: for an excluded token `timelines.get(mint)?.multiplierAt(date) ?? "1"`
//   fabricated api:"1" and a planes-disagree/ok verdict without reconciling the two real planes,
//   hit the real RPC reader and carried no excluded field (found by two agents independently).
//   /crosscheck: the excluded mint's events were removed → a silent verdicts:[] is indistinguishable
//   from "no events", while pool+candles WERE called at the price provider (quota).
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

const historyNodes = JSON.parse(readFileSync(path.join(dir, "xstocks-spyx-history-eth.json"), "utf8")).nodes;
const events = bindMintAndValidate(multiplierHistoryToEvents(historyNodes, { symbol: "SPYx" }), SPYx);

// Server with a "poisoned" mint (TimelineError at startup → token excluded) — the
// round6-api-excluded.test.mjs pattern. optsFn adds readers with call counting.
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

// ---- ROUND7 #1: /onchain ----

test("/onchain: an excluded token — an honest 400 with a reason, WITHOUT calling the RPC reader and without fabricating api", async () => {
  let readerCalls = 0;
  await withPoisonedServer(async (base) => {
    const res = await fetch(`${base}/onchain?symbol=T-SpaceX`);
    assert.equal(res.status, 400); // the /events convention: an excluded token — refusal with a reason
    const body = await res.json();
    assert.match(body.error, /excluded/i);
    assert.equal(body.excluded, true);
    assert.ok(typeof body.excludedReason === "string" && body.excludedReason.length > 0);
    assert.equal(readerCalls, 0); // not a single chain request for a token whose plan is unknown
  }, () => ({
    onchainReader: async () => {
      readerCalls++;
      throw new Error("must not be called for excluded token");
    },
  }));
});

test("/onchain: a live token — the reader is called, the response carries api/verdict as before", async () => {
  let readerCalls = 0;
  await withPoisonedServer(async (base) => {
    const res = await fetch(`${base}/onchain?symbol=T-SpaceX`.replace("T-SpaceX", "SPYx"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.mint, SPYx);
    assert.equal(typeof body.api, "string"); // the live token's issuer plan is computed, not "?? 1"
    assert.ok("verdict" in body);
    assert.equal(body.excluded, undefined);
    assert.equal(readerCalls, 1);
  }, () => ({
    onchainReader: async () => {
      readerCalls++;
      return {
        activeMultiplier: "1.005714560286254", pendingMultiplier: null,
        pendingEffectiveDate: null, hasExtension: true,
      };
    },
  }));
});

// ---- ROUND7 #2: /crosscheck ----

test("/crosscheck: an excluded token — an honest 400 with a reason, WITHOUT spending the price provider's quota", async () => {
  const calls = { pool: 0, candles: 0 };
  await withPoisonedServer(async (base) => {
    const res = await fetch(`${base}/crosscheck?symbol=T-SpaceX`);
    assert.equal(res.status, 400); // a silent [] is indistinguishable from "no events" — the same class as /events
    const body = await res.json();
    assert.match(body.error, /excluded/i);
    assert.equal(body.excluded, true);
    assert.ok(typeof body.excludedReason === "string" && body.excludedReason.length > 0);
    assert.equal(calls.pool, 0); // the GeckoTerminal quota is not burned on a token without events
    assert.equal(calls.candles, 0);
  }, () => ({
    priceProvider: {
      pool: async () => {
        calls.pool++;
        return { address: "PoolAddr", baseToken: SPYx };
      },
      candles: async () => {
        calls.candles++;
        return [];
      },
    },
  }));
});

test("/crosscheck: a live token — the provider is called, the response shape is unchanged", async () => {
  const calls = { pool: 0, candles: 0 };
  await withPoisonedServer(async (base) => {
    const res = await fetch(`${base}/crosscheck?symbol=SPYx`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.verdicts));
    assert.equal(body.pool.address, "PoolAddr");
    assert.equal(body.excluded, undefined);
    assert.equal(calls.pool, 1);
    assert.equal(calls.candles, 1);
  }, () => ({
    priceProvider: {
      pool: async () => {
        calls.pool++;
        return { address: "PoolAddr", baseToken: SPYx };
      },
      candles: async () => {
        calls.candles++;
        return [];
      },
    },
  }));
});
