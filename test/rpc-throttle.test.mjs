import test from "node:test";
import assert from "node:assert/strict";
import { RpcClient } from "../src/ingest/rpc.mjs";

// A real timer with a small injectable interval: the regression exercises real
// concurrency, but the whole test fits into ~200ms instead of 350ms per call.
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

const jsonRes = (result) => ({
  ok: true, status: 200,
  json: async () => ({ jsonrpc: "2.0", id: 1, result }),
});

test("concurrent calls are spread by at least minIntervalMs — a queue, not a volley", async () => {
  const stamps = [];
  const c = new RpcClient({
    endpoint: "https://rpc.example",
    fetcher: async () => { stamps.push(Date.now()); return jsonRes(stamps.length); },
    sleep: realSleep,
    minIntervalMs: 40,
  });
  const N = 5;
  // Like GET /lots from two tabs: N calls start in one tick
  const results = await Promise.all(Array.from({ length: N }, (_, i) => c.call("getSlot", [i])));

  assert.deepEqual(results, [1, 2, 3, 4, 5], "each call receives the result of its own request");
  assert.equal(c.requestCount, N);
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
  const c = new RpcClient({
    endpoint: "https://rpc.example",
    fetcher: async () => { stamps.push(Date.now()); return jsonRes(1); },
    sleep: realSleep,
    minIntervalMs: 40,
  });
  const t0 = Date.now();
  await c.call("getSlot", []);
  assert.ok(stamps[0] - t0 < 40, `after an idle period the first request goes out immediately: ${stamps[0] - t0}ms passed`);
});
