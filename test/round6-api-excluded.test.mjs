// Регрессионные тесты раунда 6 ревью Lotwise — зона src/api/server.mjs.
// Находки:
//   LW2_excluded_unmarked_multiplier_and_events — фикс ROUND5 №5 («исключённый токен
//       показывал множитель 1») покрыл /summary, /lots и /health, но не /multiplier
//       и /events. Для исключённого токена (TimelineError на старте, события скрыты
//       из eventsByMint) /multiplier отвечает сфабрикованной «1» с events:0 БЕЗ поля
//       excluded — неотличимо от честного «событий не было»; /events отдаёт тихий []
//       хотя события у токена есть.
//   LW2_excluded_token_adjusted_row_unmarked (кросс-зонная, серверная часть) — строка
//       исключённого токена в /lots не несёт adjustedAvailable:false — контракта для
//       витрины «adjusted — not computed» (t.adjustedAvailable === false || t.excluded).
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
const OWNER = "9BB7Tt5uW5QbAorLkF3Hn1P2mGcXvcDdR7y8LbT9KdUu"; // как в round5-api-ui.test.mjs

const historyNodes = JSON.parse(readFileSync(path.join(dir, "xstocks-spyx-history-eth.json"), "utf8")).nodes;
const events = bindMintAndValidate(multiplierHistoryToEvents(historyNodes, { symbol: "SPYx" }), SPYx);

// Сервер с «отравленным» минтом: кривая цепочка → TimelineError на старте → токен
// исключается из витрины (паттерн round5-api-ui.test.mjs / api.test.mjs).
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

test("/multiplier: исключённый токен — «1» помечена excluded+excludedReason, а не голая", async () => {
  await withPoisonedServer(async (base, bad) => {
    const res = await fetch(`${base}/multiplier?symbol=T-SpaceX&raw=1000`);
    assert.equal(res.status, 200);
    const m = await res.json();
    assert.equal(m.mint, bad.mint);
    assert.equal(m.multiplier, "1"); // значение то же сырое, но теперь честно помечено
    assert.equal(m.events, 0);
    assert.equal(m.excluded, true); // было: undefined — «1» неотличима от «событий не было»
    assert.ok(typeof m.excludedReason === "string" && m.excludedReason.length > 0);
  });
});

test("/multiplier: пометка аддитивна — живой токен отвечает как раньше, без флагов", async () => {
  await withPoisonedServer(async (base) => {
    const m = await (await fetch(`${base}/multiplier?symbol=SPYx&raw=100000000&date=2026-07-01`)).json();
    assert.equal(m.multiplier, "1.005714560286254");
    assert.equal(m.events, 4);
    assert.equal(m.sampleScaledQty.exact, false); // поля легитимного ответа не тронуты
    assert.equal(m.excluded, undefined);
    assert.equal(m.excludedReason, undefined);
  });
});

// ---- LW2_excluded_unmarked_multiplier_and_events: /events ----

test("/events: исключённый токен — честный отказ с причиной вместо тихого []", async () => {
  await withPoisonedServer(async (base) => {
    const res = await fetch(`${base}/events?symbol=T-SpaceX`);
    assert.equal(res.status, 400); // конвенция эндпоинта для кривого symbol — как у неизвестного
    const body = await res.json();
    assert.match(body.error, /excluded/i); // причина доступна в сообщении
    assert.equal(body.excluded, true);
    assert.ok(typeof body.excludedReason === "string" && body.excludedReason.length > 0);
  });
});

test("/events: конвенция не перегнута — неизвестный symbol 400, живой остаётся массивом", async () => {
  await withPoisonedServer(async (base) => {
    const unknown = await fetch(`${base}/events?symbol=NOSUCHx`);
    assert.equal(unknown.status, 400);
    const good = await (await fetch(`${base}/events?symbol=SPYx`)).json();
    assert.ok(Array.isArray(good)); // форма легитимного ответа не менялась
    assert.equal(good.length, 4);
  });
});

// ---- LW2_excluded_token_adjusted_row_unmarked: /lots пост-обработка ----

test("/lots: у исключённого токена adjustedAvailable:false, raw-поля сохранены; у обычного поля нет", async () => {
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
    assert.ok(excluded, "токен исключённого минта присутствует в отчёте");
    assert.equal(excluded.excluded, true);
    assert.equal(excluded.adjustedAvailable, false); // контракт витрины: «adjusted — not computed»
    assert.equal(excluded.rawBalance, "10"); // сырые значения не перевираются
    assert.equal(excluded.netDeltaRaw, "10");
    assert.equal(excluded.adjusted.whole, "10"); // fallback тождественный — потому и помечен
    const good = rep.tokens.find((x) => x.symbol === "SPYx");
    assert.ok(good, "живой токен тоже в отчёте");
    // пост-обработка /lots помечает ТОЛЬКО исключённые: обычному токену «adjusted —
    // not computed» не показывается (контракт витрины noAdjusted = excluded ||
    // adjustedAvailable === false не срабатывает). Значение поля у обычного токена
    // (true/undefined) — забота report.mjs, чужая зона: здесь важно лишь «не false».
    assert.notEqual(good.adjustedAvailable, false);
    assert.equal(good.excluded, undefined);
  }, (bad) => ({ walletScanner: async () => scanOf(bad.mint) }));
});
