import test from "node:test";
import assert from "node:assert/strict";
import { GeckoTerminalClient, PriceError } from "../src/price/geckoterminal.mjs";

// A real timer with a small injectable interval: the regression exercises real
// concurrency, but the whole file fits into ~300ms instead of 350ms per call.
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

const poolsRes = (n) => ({
  ok: true, status: 200,
  json: async () => ({ data: [{ id: `solana_pool${n}`, attributes: { name: `pool${n}` } }] }),
});

test("concurrent poolsForMint are spread by at least minIntervalMs — a queue, not a volley", async () => {
  const stamps = [];
  const gt = new GeckoTerminalClient({
    endpoint: "https://gt.example/api/v2",
    fetcher: async () => { stamps.push(Date.now()); return poolsRes(stamps.length); },
    sleep: realSleep,
    minIntervalMs: 40,
  });
  const N = 5;
  // Like parallel GET /crosscheck over different symbols: N calls start in one tick
  const pools = await Promise.all(Array.from({ length: N }, (_, i) => gt.poolsForMint(`mint${i}`)));

  assert.deepEqual(pools.map((p) => p[0].id), Array.from({ length: N }, (_, i) => `solana_pool${i + 1}`),
    "each call receives the result of its own request");
  assert.equal(gt.requestCount, N);
  assert.equal(stamps.length, N);
  for (let i = 1; i < stamps.length; i++) {
    const gap = stamps[i] - stamps[i - 1];
    assert.ok(gap >= 40 - 1, `the requests ${i - 1}->${i} spread by ${gap}ms, need >= ~40ms (minIntervalMs)`);
  }
  assert.ok(stamps[N - 1] - stamps[0] >= (N - 1) * 40 - 1,
    `${N} concurrent requests must take >= ${(N - 1) * 40}ms, not go out in a volley`);
});

test("an idle client does not delay the first call of the queue", async () => {
  const stamps = [];
  const gt = new GeckoTerminalClient({
    endpoint: "https://gt.example/api/v2",
    fetcher: async () => { stamps.push(Date.now()); return poolsRes(1); },
    sleep: realSleep,
    minIntervalMs: 40,
  });
  const t0 = Date.now();
  await gt.poolsForMint("mintA");
  assert.ok(stamps[0] - t0 < 40, `after an idle period the first request goes out immediately: ${stamps[0] - t0}ms passed`);
});

test("a failure of one call does not poison the tail of the queue", async () => {
  let calls = 0;
  const gt = new GeckoTerminalClient({
    endpoint: "https://gt.example/api/v2",
    fetcher: async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return poolsRes(calls);
    },
    sleep: realSleep,
    minIntervalMs: 40,
    maxRetries: 0, // the first call falls immediately, without retries
  });
  // the failing and the successful calls start simultaneously: the first one's error must not break the second
  const [failed, ok] = await Promise.allSettled([gt.poolsForMint("mintBad"), gt.poolsForMint("mintGood")]);
  assert.equal(failed.status, "rejected");
  assert.ok(failed.reason instanceof PriceError, "the failing call honestly throws a PriceError");
  assert.equal(ok.status, "fulfilled", "the tail of the queue arrives after the neighbor's failure");
  assert.equal(ok.value[0].id, "solana_pool2");
});

test("the queue neither caches nor dedups: two identical calls — two requests", async () => {
  // a guard: the pool/candles dedup lives in the priceProvider under separate keys —
  // the throttler must not silently glue identical requests
  let calls = 0;
  const gt = new GeckoTerminalClient({
    endpoint: "https://gt.example/api/v2",
    fetcher: async () => { calls++; return poolsRes(calls); },
    sleep: realSleep,
    minIntervalMs: 40,
  });
  const [a, b] = await Promise.all([gt.poolsForMint("same"), gt.poolsForMint("same")]);
  assert.equal(calls, 2, "both calls reached the network");
  assert.notDeepEqual(a, b, "the responses are not substituted by one cached one");
});
