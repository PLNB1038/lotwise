import test from "node:test";
import assert from "node:assert/strict";
import { GeckoTerminalClient, PriceError } from "../src/price/geckoterminal.mjs";

// Настоящий таймер с мелким вводимым интервалом: регресс гоняет реальную
// конкурентность, но весь файл укладывается в ~300мс вместо 350мс на вызов.
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

const poolsRes = (n) => ({
  ok: true, status: 200,
  json: async () => ({ data: [{ id: `solana_pool${n}`, attributes: { name: `pool${n}` } }] }),
});

test("конкурентные poolsForMint разносятся минимум на minIntervalMs — очередь, а не залп", async () => {
  const stamps = [];
  const gt = new GeckoTerminalClient({
    endpoint: "https://gt.example/api/v2",
    fetcher: async () => { stamps.push(Date.now()); return poolsRes(stamps.length); },
    sleep: realSleep,
    minIntervalMs: 40,
  });
  const N = 5;
  // Как параллельные GET /crosscheck по разным символам: N вызовов стартуют в один тик
  const pools = await Promise.all(Array.from({ length: N }, (_, i) => gt.poolsForMint(`mint${i}`)));

  assert.deepEqual(pools.map((p) => p[0].id), Array.from({ length: N }, (_, i) => `solana_pool${i + 1}`),
    "каждый вызов получает результат своего запроса");
  assert.equal(gt.requestCount, N);
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
  const gt = new GeckoTerminalClient({
    endpoint: "https://gt.example/api/v2",
    fetcher: async () => { stamps.push(Date.now()); return poolsRes(1); },
    sleep: realSleep,
    minIntervalMs: 40,
  });
  const t0 = Date.now();
  await gt.poolsForMint("mintA");
  assert.ok(stamps[0] - t0 < 40, `после простоя первый запрос уходит сразу: прошло ${stamps[0] - t0}мс`);
});

test("провал одного вызова не отравляет хвост очереди", async () => {
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
    maxRetries: 0, // первый вызов падает сразу, без ретраев
  });
  // упавший и успешный вызовы стартуют одновременно: ошибка первого не должна сломать второй
  const [failed, ok] = await Promise.allSettled([gt.poolsForMint("mintBad"), gt.poolsForMint("mintGood")]);
  assert.equal(failed.status, "rejected");
  assert.ok(failed.reason instanceof PriceError, "упавший вызов честно бросает PriceError");
  assert.equal(ok.status, "fulfilled", "хвост очереди доезжает после провала соседа");
  assert.equal(ok.value[0].id, "solana_pool2");
});

test("очередь не кэширует и не дедуплицирует: два одинаковых вызова — два запроса", async () => {
  // guard: дедуп pool/candles живёт в priceProvider по раздельным ключам —
  // троттлер не должен незаметно склеивать одинаковые запросы
  let calls = 0;
  const gt = new GeckoTerminalClient({
    endpoint: "https://gt.example/api/v2",
    fetcher: async () => { calls++; return poolsRes(calls); },
    sleep: realSleep,
    minIntervalMs: 40,
  });
  const [a, b] = await Promise.all([gt.poolsForMint("same"), gt.poolsForMint("same")]);
  assert.equal(calls, 2, "оба вызова дошли до сети");
  assert.notDeepEqual(a, b, "ответы не подменены одним закэшированным");
});
