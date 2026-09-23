// Регрессионные тесты раунда 7 ревью Lotwise — зона src/api/server.mjs.
// Находка ROUND7 №1/№2: раунды 5–6 пометили исключённые токены в /summary, /lots,
// /multiplier, /events, /accruals, /health — но не /onchain и не /crosscheck.
//   /onchain: для исключённого токена `timelines.get(mint)?.multiplierAt(date) ?? "1"`
//   фабриковал api:"1" и вердикт planes-disagree/ok без сверки двух реальных планов,
//   дёргал настоящий RPC-ридер и не нёс поля excluded (нашли два агента независимо).
//   /crosscheck: события исключённого минта удалены → тихий verdicts:[] неотличим от
//   «событий не было», при этом pool+candles у провайдера цен ВЫЗЫВАЛИСЬ (квота).
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

// Сервер с «отравленным» минтом (TimelineError на старте → токен исключён) — паттерн
// round6-api-excluded.test.mjs. optsFn добавляет ридеры с подсчётом вызовов.
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

// ---- ROUND7 №1: /onchain ----

test("/onchain: исключённый токен — честный 400 с причиной, БЕЗ вызова RPC-ридера и без фабрикации api", async () => {
  let readerCalls = 0;
  await withPoisonedServer(async (base) => {
    const res = await fetch(`${base}/onchain?symbol=T-SpaceX`);
    assert.equal(res.status, 400); // конвенция /events: исключённый токен — отказ с причиной
    const body = await res.json();
    assert.match(body.error, /excluded/i);
    assert.equal(body.excluded, true);
    assert.ok(typeof body.excludedReason === "string" && body.excludedReason.length > 0);
    assert.equal(readerCalls, 0); // ни одного запроса к цепи по токену, чей план неизвестен
  }, () => ({
    onchainReader: async () => {
      readerCalls++;
      throw new Error("must not be called for excluded token");
    },
  }));
});

test("/onchain: живой токен — ридер вызван, ответ несёт api/verdict как раньше", async () => {
  let readerCalls = 0;
  await withPoisonedServer(async (base) => {
    const res = await fetch(`${base}/onchain?symbol=T-SpaceX`.replace("T-SpaceX", "SPYx"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.mint, SPYx);
    assert.equal(typeof body.api, "string"); // план эмитента живого токена — вычислен, не «?? 1»
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

// ---- ROUND7 №2: /crosscheck ----

test("/crosscheck: исключённый токен — честный 400 с причиной, БЕЗ траты квоты провайдера цен", async () => {
  const calls = { pool: 0, candles: 0 };
  await withPoisonedServer(async (base) => {
    const res = await fetch(`${base}/crosscheck?symbol=T-SpaceX`);
    assert.equal(res.status, 400); // тихий [] неотличим от «событий не было» — тот же класс, что /events
    const body = await res.json();
    assert.match(body.error, /excluded/i);
    assert.equal(body.excluded, true);
    assert.ok(typeof body.excludedReason === "string" && body.excludedReason.length > 0);
    assert.equal(calls.pool, 0); // квота GeckoTerminal не горит на токене без событий
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

test("/crosscheck: живой токен — провайдер вызван, форма ответа прежняя", async () => {
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
