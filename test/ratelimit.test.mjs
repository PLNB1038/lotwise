import test from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter } from "../src/api/ratelimit.mjs";
import { createApiServer } from "../src/api/server.mjs";
import { loadRegistry } from "../src/registry/registry.mjs";

test("createRateLimiter: ровно max за окно, потом отказ с retryAfter, окно сбрасывается", () => {
  let t = 1_000_000; // управляемые часы: фиксированное окно 10_000мс
  const limiter = createRateLimiter({ windowMs: 10_000, max: 2, now: () => t });
  assert.deepEqual(limiter.check("a"), { allowed: true, retryAfterMs: 0 });
  assert.deepEqual(limiter.check("a"), { allowed: true, retryAfterMs: 0 });
  const denied = limiter.check("a");
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterMs > 0 && denied.retryAfterMs <= 10_000);
  // ключи изолированы: чужая корзина не мешает
  assert.equal(limiter.check("b").allowed, true);
  // окно прокатилось — счёт с нуля (t=1_010_000 попадает в окно 1_010_000..1_020_000)
  t = 1_010_000;
  assert.deepEqual(limiter.check("a"), { allowed: true, retryAfterMs: 0 });
});

test("createRateLimiter: мусорные параметры — явный бросок, а не молчаливый unlimited", () => {
  assert.throws(() => createRateLimiter({ windowMs: 0, max: 1 }), RangeError);
  assert.throws(() => createRateLimiter({ windowMs: 1000, max: 0 }), RangeError);
  assert.throws(() => createRateLimiter({ windowMs: 1000.5, max: 1 }), RangeError);
});

// форма скана — по контракту report.mjs (как aScan в api.test.mjs): пустой кошелёк
const scanStub = () => ({ owner: ADDR, signatures: 0, fetched: 0, txs: [], skipped: [], truncated: false, accounts: {} });

async function withLimitedServer(fn, opts = {}) {
  const registry = await loadRegistry("data/tokens.json");
  const server = await createApiServer({
    registry,
    events: [],
    walletScanner: scanStub,
    rateLimits: { scan: { windowMs: 60_000, max: 2 }, rpc: { windowMs: 60_000, max: 2 } },
    ...opts,
  });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

const ADDR = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"; // валидный base58 pubkey (не в реестре — не важно для /lots)

test("/lots: третий скан за окно — 429 с Retry-After, сканер реально звался дважды", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const calls = [];
  // свой сервер со счётчиком вызовов: важно, что 429 останавливает ДО сканера
  const server = await createApiServer({
    registry,
    events: [],
    walletScanner: (a) => {
      calls.push(a);
      return Promise.resolve(scanStub());
    },
    rateLimits: { scan: { windowMs: 60_000, max: 2 }, rpc: { windowMs: 60_000, max: 2 } },
  });
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/lots?address=${ADDR}`;
  try {
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await fetch(url)).status, 200);
    const blocked = await fetch(url);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
    assert.match((await blocked.json()).error, /rate limit exceeded/);
    assert.equal(calls.length, 2); // третий запрос не дошёл до сканера
  } finally {
    server.close();
  }
});

test("/lots: мусорные адресы (400 до лимита) не сжигают квоту; /health не лимитирован", async () => {
  await withLimitedServer(async (base) => {
    for (let i = 0; i < 5; i++) {
      assert.equal((await fetch(`${base}/lots?address=junk${i}`)).status, 400);
    }
    assert.equal((await fetch(`${base}/lots?address=${ADDR}`)).status, 200); // квота цела
    for (let i = 0; i < 5; i++) {
      assert.equal((await fetch(`${base}/health`)).status, 200); // дешёвые эндпоинты без лимита
    }
  });
});

test("trustProxy: X-Forwarded-For задаёт корзину, без него — адрес сокета (одна корзина)", async () => {
  await withLimitedServer(async (base) => {
    // без trustProxy XFF игнорируется: оба «клиента» делят корзину сокета (max=2),
    // подделка заголовка не даёт себе новых корзин
    const h1 = { "x-forwarded-for": "1.1.1.1" };
    const h2 = { "x-forwarded-for": "2.2.2.2" };
    assert.equal((await fetch(`${base}/lots?address=${ADDR}`, { headers: h1 })).status, 200);
    assert.equal((await fetch(`${base}/lots?address=${ADDR}`, { headers: h2 })).status, 200);
    assert.equal((await fetch(`${base}/lots?address=${ADDR}`, { headers: h2 })).status, 429);
  }, { trustProxy: false });

  await withLimitedServer(async (base) => {
    // с trustProxy каждый XFF — своя корзина (max=2): оба «клиента» живут независимо
    const h1 = { "x-forwarded-for": "1.1.1.1" };
    const h2 = { "x-forwarded-for": "2.2.2.2" };
    assert.equal((await fetch(`${base}/lots?address=${ADDR}`, { headers: h1 })).status, 200);
    assert.equal((await fetch(`${base}/lots?address=${ADDR}`, { headers: h2 })).status, 200);
    assert.equal((await fetch(`${base}/lots?address=${ADDR}`, { headers: h2 })).status, 200);
    assert.equal((await fetch(`${base}/lots?address=${ADDR}`, { headers: h2 })).status, 429); // корзина 2.2.2.2 исчерпана
    assert.equal((await fetch(`${base}/lots?address=${ADDR}`, { headers: h1 })).status, 200); // а 1.1.1.1 всё ещё жива
  }, { trustProxy: true });
});

test("rateLimits: null — лимиты выключены (локальные эксперименты)", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const server = await createApiServer({ registry, events: [], walletScanner: scanStub, rateLimits: null });
  const { port } = server.address();
  try {
    for (let i = 0; i < 5; i++) {
      assert.equal((await fetch(`http://127.0.0.1:${port}/lots?address=${ADDR}`)).status, 200);
    }
  } finally {
    server.close();
  }
});
