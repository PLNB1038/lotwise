// Регрессионные тесты раунда 11 — фиксы апокалипс-волны C (P0/P1-прицел).
//   C4-1 [P1]: шлюз без scaledUiAmountConfig = «нет факта», а не «сброс до 1» —
//              дифф журнала фабриковал фантом X→1 и вечный дубль-триплет.
//   C3-1 [P1]: URL RPC с кредами утекал в 503-тела и boot-лог через err.message.
//   C3-2 [P2]: SSRF-обход данлиста хостом с концевой точкой (localhost.).
//   C3-3: X-Content-Type-Options: nosniff на всех ответах.
//   C2:   GeckoTerminal дубль-свечи (тот же ts) — дедуп в dailyCandles.
import test from "node:test";
import assert from "node:assert/strict";
import { planJournalStep } from "../src/events/journal.mjs";
import { parseScaledUiAmount } from "../src/issuer/scaled-ui.mjs";
import { validateSubscription } from "../src/webhooks/subscriptions.mjs";
import { RpcClient, RpcError } from "../src/ingest/rpc.mjs";
import { GeckoTerminalClient } from "../src/price/geckoterminal.mjs";
import { createApiServer } from "../src/api/server.mjs";
import { loadRegistry } from "../src/registry/registry.mjs";

const MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const TOKEN = { mint: MINT, symbol: "TESTx" };

const mintState = (state) => ({
  owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  data: { parsed: { info: { decimals: 8, extensions: [{ extension: "scaledUiAmountConfig", state: { newMultiplierEffectiveTimestamp: 0, ...state } }] } } },
});
const settled = (m) => mintState({ multiplier: m, newMultiplier: 0 });
const rotation = (a, p) => mintState({
  multiplier: a, newMultiplier: p, newMultiplierEffectiveTimestamp: Date.UTC(2026, 5, 10) / 1000,
});
// Шлюз «потерял» extension: аккаунт жив, но без scaledUiAmountConfig
const extDropped = () => ({
  owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  data: { parsed: { info: { decimals: 8, extensions: [{ extension: "mintCloseAuthority" }] } } },
});

// ---- C4-1 [P1]: extDrop = «нет факта», не «сброс до 1» ----

test("journal: шлюз без extension НЕ фабрикует сброс X→1 — запись не тронута", () => {
  // бут A: честная ротация 1→8 (pending активировался)
  const bootA = planJournalStep(TOKEN, null, parseScaledUiAmount(rotation("1", "8")));
  assert.ok(bootA.event, "ротация наблюдена");
  // бут B: шлюз деградировал — extension исчез, парсер отдал дефолт «1»
  const bootB = planJournalStep(TOKEN, bootA.entry, parseScaledUiAmount(extDropped()));
  assert.equal(bootB.event, null, "«1» без extension — дефолт парсера, не наблюдение");
  assert.equal(bootB.entry.lastEffective, "8", "последний ФАКТ сохранён");
  assert.equal(bootB.entry.events.length, 1, "история не пополнилась фантомом");
  // бут C: правда вернулась (settled 8) — дубликата-возврата нет
  const bootC = planJournalStep(TOKEN, bootB.entry, parseScaledUiAmount(settled("8")));
  assert.equal(bootC.event, null);
  assert.equal(bootC.entry.events.length, 1, "вечной дубль-триплет не возник (C4-марафон: 1221 находок этого класса)");
});

test("journal: первое наблюдение extension-less минта — записи нет (нет фактов — нет записи)", () => {
  const r = planJournalStep(TOKEN, null, parseScaledUiAmount(extDropped()));
  assert.equal(r.event, null);
  assert.equal(r.entry, null, "пустая запись {lastEffective:1} не персистится");
});

// ---- C3-1 [P1]: редакция URL из ошибок RPC ----

test("rpc: err.message с URL-кредами НЕ покидает клиент — редакция на границе", async () => {
  const leak = "Request cannot be constructed from a URL that includes credentials: http://user:supersecret@rpc.example/x";
  const client = new RpcClient({
    endpoint: "http://user:supersecret@rpc.example/x",
    fetcher: async () => { throw new TypeError(leak); },
    sleep: async () => {}, minIntervalMs: 0, maxRetries: 0,
  });
  await assert.rejects(() => client.call("m", []), (err) => {
    assert.ok(!err.message.includes("supersecret"), "креды не утекают");
    assert.ok(!/https?:\/\//.test(err.message), "полный URL не утекает");
    return err instanceof RpcError && err.kind === "network";
  });
});

test("rpc: провайдер-текст JSON-RPC ошибки с URL — тоже редактирован", async () => {
  const client = new RpcClient({
    endpoint: "https://rpc.example",
    fetcher: async () => new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32015, message: "failed for https://k.example/?api-key=LEAKED" } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
    sleep: async () => {}, minIntervalMs: 0, maxRetries: 0,
  });
  await assert.rejects(() => client.call("m", []), (err) => {
    assert.ok(!err.message.includes("LEAKED"), "ключ из провайдер-текста не утекает");
    return err.code === -32015;
  });
});

// ---- C3-2 [P2]: концевая точка хоста ----

test("подписки: localhost. (концевая точка) и 127.0.0.1. отвергаются", () => {
  for (const url of ["http://localhost.:8790/hook", "http://LOCALHOST./hook", "http://127.0.0.1./hook"]) {
    assert.throws(
      () => validateSubscription({ id: "wh_x", url, symbols: "*", secret: "s", createdAt: "2026-09-23T00:00:00.000Z", active: true }),
      (err) => /url/.test(err.field ?? ""),
      `${url} должен быть отвергнут`,
    );
  }
  assert.doesNotThrow(() =>
    validateSubscription({ id: "wh_x", url: "https://example.com./hook", symbols: "*", secret: "s", createdAt: "2026-09-23T00:00:00.000Z", active: true }),
    "публичный FQDN в root-форме — легитимлен");
});

// ---- C3-3: nosniff ----

test("api: каждый ответ несёт X-Content-Type-Options: nosniff", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const server = await createApiServer({ registry, events: [] });
  const { port } = server.address();
  try {
    for (const path of ["/health", "/", "/nope"]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff", `${path}: nosniff присутствует`);
    }
  } finally {
    server.close();
  }
});

// ---- C2: GeckoTerminal дубль-свечи ----

test("gecko: дубль-свечи (тот же ts) схлопывается — последняя запись выигрывает", async () => {
  let calls = 0;
  const fetcher = async (url) => {
    calls++;
    if (String(url).includes("/pools") && !String(url).includes("/ohlcv")) {
      return new Response(JSON.stringify({ data: { attributes: {} } }), { status: 200 }); // не используется в этом тесте
    }
    return new Response(JSON.stringify({
      data: { attributes: { ohlcv_list: [
        [1774224000, "650.9", "675.1", "638.9", "658.9"], // дубль, СТАРАЯ версия дня
        [1774224000, "658.9", "680.0", "640.0", "670.0"], // дубль, НОВАЯ версия того же дня
        [1774310400, "670.0", "690.0", "660.0", "680.0"],
      ] } },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const gt = new GeckoTerminalClient({ fetcher, sleep: async () => {} });
  const candles = await gt.dailyCandles("PoolAddr");
  assert.equal(candles.length, 2, "дубль схлопнут");
  assert.deepEqual(candles.map((c) => c.c), ["670.0", "680.0"], "победила последняя запись дня (GT-семантика перезаписи)");
  assert.ok(candles[0].ts < candles[1].ts, "порядок возрастания сохранён");
});
