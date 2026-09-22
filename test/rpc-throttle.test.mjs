import test from "node:test";
import assert from "node:assert/strict";
import { RpcClient } from "../src/ingest/rpc.mjs";

// Настоящий таймер с мелким вводимым интервалом: регресс гоняет реальную
// конкурентность, но весь тест укладывается в ~200мс вместо 350мс на вызов.
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

const jsonRes = (result) => ({
  ok: true, status: 200,
  json: async () => ({ jsonrpc: "2.0", id: 1, result }),
});

test("конкурентные call разносятся минимум на minIntervalMs — очередь, а не залп", async () => {
  const stamps = [];
  const c = new RpcClient({
    endpoint: "https://rpc.example",
    fetcher: async () => { stamps.push(Date.now()); return jsonRes(stamps.length); },
    sleep: realSleep,
    minIntervalMs: 40,
  });
  const N = 5;
  // Как GET /lots из двух вкладок: N вызовов стартуют в один тик
  const results = await Promise.all(Array.from({ length: N }, (_, i) => c.call("getSlot", [i])));

  assert.deepEqual(results, [1, 2, 3, 4, 5], "каждый вызов получает результат своего запроса");
  assert.equal(c.requestCount, N);
  assert.equal(stamps.length, N);
  for (let i = 1; i < stamps.length; i++) {
    const gap = stamps[i] - stamps[i - 1];
    assert.ok(gap >= 40 - 1, `запросы ${i - 1}->${i} разнесены на ${gap}мс, нужно >= ~40мс (minIntervalMs)`);
  }
  assert.ok(stamps[N - 1] - stamps[0] >= (N - 1) * 40 - 1,
    `${N} одновременных запросов должны занять >= ${(N - 1) * 40}мс, а не уйти залпом`);
});

test("простаивавший клиент не задерживает первый вызов очереди", async () => {
  const stamps = [];
  const c = new RpcClient({
    endpoint: "https://rpc.example",
    fetcher: async () => { stamps.push(Date.now()); return jsonRes(1); },
    sleep: realSleep,
    minIntervalMs: 40,
  });
  const t0 = Date.now();
  await c.call("getSlot", []);
  assert.ok(stamps[0] - t0 < 40, `после простоя первый запрос уходит сразу: прошло ${stamps[0] - t0}мс`);
});
