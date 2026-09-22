import test from "node:test";
import assert from "node:assert/strict";
import { crossCheckMultiplierChange, crossCheckEvents, CrossCheckError } from "../src/events/crosscheck.mjs";
import { GeckoTerminalClient, PriceError } from "../src/price/geckoterminal.mjs";
import { createApiServer } from "../src/api/server.mjs";
import { multiplierHistoryToEvents, bindMintAndValidate } from "../src/events/normalize-xstocks.mjs";
import { loadRegistry } from "../src/registry/registry.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const SPYx = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";

const DAY = 86400;
const d = (yyyy, mm, dd) => Math.floor(Date.parse(`${yyyy}-${mm}-${dd}T00:00:00Z`) / 1000);
const ev = (iso, from, to) => ({
  type: "MULTIPLIER_CHANGE", effectiveDate: iso, multiplierFrom: from, multiplierTo: to, reason: "Dividend",
});

// --- чистая математика вердиктов ---

test("большой ребейз 1→2: цена raw-единицы обязана упасть вдвое — consistent/mismatch", () => {
  const event = ev("2026-06-10T00:00:00Z", "1", "2"); // ожидание 0.5
  const candles = [
    { ts: d("2026", "06", "07"), c: 100 }, // закрылась 06-08
    { ts: d("2026", "06", "08"), c: 100 }, // закрылась 06-09 — последняя ДО события
    { ts: d("2026", "06", "10"), c: 50 },  // закрылась 06-11 — первая ПОСЛЕ
    { ts: d("2026", "06", "11"), c: 51 },
  ];
  const ok = crossCheckMultiplierChange(event, candles);
  assert.equal(ok.verdict, "consistent");
  assert.equal(ok.observed.beforeDate, "2026-06-08");
  assert.equal(ok.observed.afterDate, "2026-06-10");
  assert.equal(ok.expectedRatio, 0.5);

  const bad = crossCheckMultiplierChange(event, [{ ...candles[0] }, { ...candles[1] }, { ts: d("2026", "06", "10"), c: 95 }, { ts: d("2026", "06", "11"), c: 96 }]);
  assert.equal(bad.verdict, "mismatch"); // 0.95 vs 0.5 — рынок не переоценил как ребейз
});

test("мелкий дивиденд (<0.5%): в пределах шума — consistent, грубая аномалия — suspicious", () => {
  const event = ev("2026-06-18T04:00:00Z", "1.003909240011759", "1.005714560286254"); // ожидание ~0.9982
  const calm = [
    { ts: d("2026", "06", "16"), c: 100 },
    { ts: d("2026", "06", "17"), c: 100 },
    { ts: d("2026", "06", "18"), c: 100.3 }, // закрылась 06-19, событие 04:00 внутри
    { ts: d("2026", "06", "19"), c: 100.4 },
  ];
  assert.equal(crossCheckMultiplierChange(event, calm).verdict, "consistent");

  const wild = [
    { ts: d("2026", "06", "16"), c: 100 },
    { ts: d("2026", "06", "17"), c: 100 },
    { ts: d("2026", "06", "18"), c: 105 }, // +5% за окно — дивиденд 0.18% этого не объясняет
    { ts: d("2026", "06", "19"), c: 105 },
  ];
  assert.equal(crossCheckMultiplierChange(event, wild).verdict, "suspicious");
});

test("дыра в свечах вокруг события — inconclusive, а не ложное suspicious (живой кейс SPYx 01.05)", () => {
  const event = ev("2026-05-01T00:15:00Z", "1.0026", "1.0040");
  const candles = [
    { ts: d("2026", "04", "13"), c: 100 },
    { ts: d("2026", "04", "14"), c: 100 }, // потом пул молчал два месяца
    { ts: d("2026", "06", "14"), c: 108.5 },
    { ts: d("2026", "06", "15"), c: 108.6 },
  ];
  const r = crossCheckMultiplierChange(event, candles);
  assert.equal(r.verdict, "inconclusive");
  assert.equal(r.observed.windowDays, 61);
  assert.match(r.note, /candle gap/);
});

test("нет истории до события — no-price-data с честной причиной", () => {
  const event = ev("2025-10-31T23:55:00Z", "1", "1.001");
  const candles = [
    { ts: d("2026", "03", "18"), c: 100 },
    { ts: d("2026", "03", "19"), c: 100 },
  ];
  const r = crossCheckMultiplierChange(event, candles);
  assert.equal(r.verdict, "no-price-data");
  assert.equal(r.observedRatio, null);
  assert.match(r.note, /do not reach back/);
});

test("событие 23:59: свеча дня события закрывается после — корректные before/after", () => {
  const event = ev("2026-06-05T23:59:00Z", "1", "1.001");
  const candles = [
    { ts: d("2026", "06", "04"), c: 200 }, // закрылась 06-05T00:00 — до события
    { ts: d("2026", "06", "05"), c: 201 }, // закрылась 06-06T00:00 — после события (23:59 внутри)
    { ts: d("2026", "06", "06"), c: 201 },
  ];
  const r = crossCheckMultiplierChange(event, candles);
  assert.equal(r.observed.beforeDate, "2026-06-04");
  assert.equal(r.observed.afterDate, "2026-06-05");
});

test("не MULTIPLIER_CHANGE — отказ, а не догадка", () => {
  assert.throws(
    () => crossCheckMultiplierChange({ type: "SPLIT", effectiveDate: "2026-06-05T00:00:00Z" }, []),
    CrossCheckError,
  );
});

test("crossCheckEvents: только MULTIPLIER_CHANGE + покрытие истории", () => {
  const events = [
    ev("2026-01-30T23:55:00Z", "1", "1.0015"),
    { type: "TICKER_CHANGE", effectiveDate: "2026-02-01T00:00:00Z", oldSymbol: "A", newSymbol: "B" },
    ev("2026-06-18T04:00:00Z", "1.003909240011759", "1.005714560286254"),
  ];
  const candles = [
    { ts: d("2026", "06", "16"), c: 100 },
    { ts: d("2026", "06", "17"), c: 100 },
    { ts: d("2026", "06", "18"), c: 100.2 },
  ];
  const { verdicts, coverage } = crossCheckEvents(events, candles);
  assert.equal(verdicts.length, 2); // TICKER_CHANGE не кросс-чекается ценой
  assert.equal(verdicts[0].verdict, "no-price-data"); // январь вне истории
  assert.equal(coverage.candles, 3);
  assert.equal(coverage.candlesFrom, "2026-06-16");
  assert.equal(coverage.candlesTo, "2026-06-18");
});

// --- раунд 4: строгие даты + инварианты фаззера (seed 20260919) ---

const VERDICTS = ["consistent", "mismatch", "suspicious", "inconclusive", "no-price-data"];

test("мусорная effectiveDate — CrossCheckError (батарея дат, включая перекаты Date.parse)", () => {
  const badDates = [
    "2026-13-01", "2026-00-10", "2026-06-18T23:59:60Z", "2026-06-18T12:00:00+99:99",
    "2026-02-30", "2026-06-31", "2027-02-29", "2026-06-18T24:00:00Z",
    "2026-06-18T12:00:00", "2026-1-1", "", null,
  ];
  for (const bad of badDates) {
    assert.throws(
      () => crossCheckMultiplierChange(ev(bad, "1", "2"), [{ ts: 0, c: 100 }]),
      CrossCheckError,
      `должна отвергаться: ${JSON.stringify(bad)}`,
    );
  }
});

test("канонические форматы дат проходят кросс-чек (анти-перегиб строгого валидатора)", () => {
  const candles = [
    { ts: d("2026", "06", "08"), c: 100 },
    { ts: d("2026", "06", "09"), c: 100 },
    { ts: d("2026", "06", "10"), c: 50 },
  ];
  for (const date of ["2026-06-10", "2026-06-10T00:00:00Z", "2026-06-10T00:00:00.000Z", "2026-06-10T02:00:00+02:00"]) {
    const r = crossCheckMultiplierChange(ev(date, "1", "2"), candles);
    assert.equal(r.verdict, "consistent", date); // все записи — один момент: полдень... полночь 06-10 UTC
  }
});

test("инвариант: вердикт всегда из {consistent,mismatch,suspicious,inconclusive,no-price-data}", () => {
  const scenarios = [
    // consistent: большой ребейз, рынок переоценил
    [ev("2026-06-10T00:00:00Z", "1", "2"), [
      { ts: d("2026", "06", "08"), c: 100 }, { ts: d("2026", "06", "09"), c: 100 },
      { ts: d("2026", "06", "10"), c: 50 }, { ts: d("2026", "06", "11"), c: 51 },
    ]],
    // mismatch: рынок не переоценил
    [ev("2026-06-10T00:00:00Z", "1", "2"), [
      { ts: d("2026", "06", "08"), c: 100 }, { ts: d("2026", "06", "09"), c: 100 },
      { ts: d("2026", "06", "10"), c: 95 }, { ts: d("2026", "06", "11"), c: 96 },
    ]],
    // suspicious: мелкий дивиденд + грубая аномалия цены
    [ev("2026-06-18T04:00:00Z", "1.003909240011759", "1.005714560286254"), [
      { ts: d("2026", "06", "16"), c: 100 }, { ts: d("2026", "06", "17"), c: 100 },
      { ts: d("2026", "06", "18"), c: 105 }, { ts: d("2026", "06", "19"), c: 105 },
    ]],
    // inconclusive: дыра в свечах
    [ev("2026-05-01T00:15:00Z", "1.0026", "1.0040"), [
      { ts: d("2026", "04", "14"), c: 100 }, { ts: d("2026", "06", "14"), c: 108.5 },
    ]],
    // no-price-data: история не достаёт до события
    [ev("2025-10-31T23:55:00Z", "1", "1.001"), [
      { ts: d("2026", "03", "18"), c: 100 }, { ts: d("2026", "03", "19"), c: 100 },
    ]],
    // no-price-data: свечей нет вообще
    [ev("2026-06-10T00:00:00Z", "1", "2"), []],
  ];
  const seen = new Set();
  for (const [e, cs] of scenarios) {
    const r = crossCheckMultiplierChange(e, cs);
    assert.ok(VERDICTS.includes(r.verdict), `неизвестный вердикт: ${r.verdict}`);
    seen.add(r.verdict);
  }
  assert.equal(seen.size, VERDICTS.length, "все 5 вердиктов достижимы и покрыты");
});

test("инвариант: inconclusive ⟺ окно > 3 дней (3 дня — ещё решаемо, 4 — уже нет)", () => {
  const event = ev("2026-06-11T12:00:00Z", "1", "2"); // полдень 06-11
  const base = d("2026", "06", "10"); // полночь 06-10
  const candles = (w) => [
    { ts: base, c: 100 },             // закрылась 06-11T00:00 — до события
    { ts: base + w * DAY, c: 50 },    // закрылась через w суток после базы
  ];
  const w3 = crossCheckMultiplierChange(event, candles(3));
  assert.equal(w3.observed.windowDays, 3);
  assert.notEqual(w3.verdict, "inconclusive");
  assert.equal(w3.verdict, "consistent");
  const w4 = crossCheckMultiplierChange(event, candles(4));
  assert.equal(w4.observed.windowDays, 4);
  assert.equal(w4.verdict, "inconclusive");
});

test("инвариант: свеча, закрывшаяся РОВНО в момент события (ts = evTs − DAY), считается before", () => {
  const evTs = Date.parse("2026-06-12T00:00:00Z") / 1000; // полночь 06-12
  const event = ev("2026-06-12T00:00:00Z", "1", "2");
  const candles = [
    { ts: evTs - DAY, c: 100 }, // close ровно в момент события: цена ещё без ребейза
    { ts: evTs, c: 50 },        // закрылась 06-13 — первая после
  ];
  const r = crossCheckMultiplierChange(event, candles);
  assert.equal(r.verdict, "consistent"); // 100→50 = ожидаемый ребейз: close до события использован как before
  assert.equal(r.observed.beforeDate, "2026-06-11");
  assert.equal(r.observed.afterDate, "2026-06-12");
  assert.equal(r.observedRatio, 0.5);
});

// --- клиент GeckoTerminal на фейке ---

function fakeFetch(routes) {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    const hit = routes.find((r) => url.includes(r.match));
    if (!hit) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => hit.body };
  };
  return { fetcher, calls };
}

const gtPools = (mint, baseMint) => ({
  data: [
    { id: "solana_Po0AAAA", attributes: { name: "STONK / SPYx", volume_usd: { h24: "9000000" } },
      relationships: { base_token: { data: { id: "solana_ST0NK" } }, quote_token: { data: { id: `solana_${mint}` } } } },
    { id: `solana_${baseMint}`, attributes: { name: "SPYx / USDC", volume_usd: { h24: "4000000" } },
      relationships: { base_token: { data: { id: `solana_${mint}` } }, quote_token: { data: { id: "solana_USDC" } } } },
  ],
});

test("GT bestBasePool: берёт пул с НАШИМ base (даже меньший по объёму) — ловушка ориентации", async () => {
  const { fetcher, calls } = fakeFetch([
    { match: "/pools", body: gtPools(SPYx, "Poo1USDC") },
  ]);
  const gt = new GeckoTerminalClient({ fetcher, sleep: async () => {}, minIntervalMs: 0 });
  const pool = await gt.bestBasePool(SPYx);
  assert.equal(pool.address, "Poo1USDC"); // НЕ Po0AAAA (STONK-база, объёмнее)
  assert.equal(pool.name, "SPYx / USDC");
});

test("GT bestBasePool: пула с нашим base нет — null", async () => {
  const { fetcher } = fakeFetch([
    { match: "/pools", body: { data: [
      { id: "solana_X", attributes: { name: "A / B", volume_usd: { h24: "1" } },
        relationships: { base_token: { data: { id: "solana_notours" } } } },
    ] } },
  ]);
  const gt = new GeckoTerminalClient({ fetcher, sleep: async () => {}, minIntervalMs: 0 });
  assert.equal(await gt.bestBasePool(SPYx), null);
});

test("GT dailyCandles: парсит и сортирует по возрастанию ts", async () => {
  const { fetcher } = fakeFetch([
    { match: "/ohlcv/day", body: { data: { attributes: { ohlcv_list: [
      [200, 2, 2, 2, 2.2], [100, 1, 1, 1, 1.1], [150, 1.5, 1.6, 1.4, 1.5],
    ] } } } },
  ]);
  const gt = new GeckoTerminalClient({ fetcher, sleep: async () => {}, minIntervalMs: 0 });
  const candles = await gt.dailyCandles("Poo1");
  assert.deepEqual(candles.map((c) => c.ts), [100, 150, 200]);
  assert.equal(candles[0].c, 1.1);
});

test("GT: сплошной 429 — PriceError rate-limit после ретраев", async () => {
  const fetcher = async () => ({ ok: false, status: 429, json: async () => ({}) });
  const gt = new GeckoTerminalClient({ fetcher, sleep: async () => {}, minIntervalMs: 0, maxRetries: 1 });
  await assert.rejects(gt.dailyCandles("X"), (e) => e instanceof PriceError && e.kind === "rate-limit");
});

test("GT: 404 — сразу PriceError http, без ретраев", async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return { ok: false, status: 404, json: async () => ({}) }; };
  const gt = new GeckoTerminalClient({ fetcher, sleep: async () => {}, minIntervalMs: 0, maxRetries: 2 });
  await assert.rejects(gt.dailyCandles("X"), (e) => e instanceof PriceError && e.kind === "http" && e.status === 404);
  assert.equal(calls, 1, "404 пула не транзиентен — ретраить нечего");
});

// --- маршрут /crosscheck ---

async function withServer(priceProvider, fn) {
  const historyNodes = JSON.parse(readFileSync(path.join(dir, "xstocks-spyx-history-eth.json"), "utf8")).nodes;
  const events = bindMintAndValidate(multiplierHistoryToEvents(historyNodes, { symbol: "SPYx" }), SPYx);
  const registry = await loadRegistry("data/tokens.json");
  const server = await createApiServer({ registry, events, priceProvider });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("/crosscheck: без провайдера — 503, неизвестный символ — 400", async () => {
  await withServer(null, async (base) => {
    assert.equal((await fetch(`${base}/crosscheck?symbol=SPYx`)).status, 503);
    assert.equal((await fetch(`${base}/crosscheck?symbol=NOPE`)).status, 400);
  });
});

test("/crosscheck: вердикты по событиям SPYx + пул и покрытие в ответе", async () => {
  const candles = [
    { ts: d("2026", "06", "16"), c: 100 },
    { ts: d("2026", "06", "17"), c: 100 },
    { ts: d("2026", "06", "18"), c: 100.2 },
    { ts: d("2026", "06", "19"), c: 100.3 },
  ];
  await withServer({ pool: async () => ({ address: "P1", name: "SPYx / USDC", volume24hUsd: "1" }), candles: async () => candles }, async (base) => {
    const r = await (await fetch(`${base}/crosscheck?symbol=SPYx`)).json();
    assert.equal(r.symbol, "SPYx");
    assert.equal(r.pool.name, "SPYx / USDC");
    assert.equal(r.coverage.candles, 4);
    assert.equal(r.verdicts.length, 4);
    const june = r.verdicts.find((v) => v.effectiveDate.startsWith("2026-06-18"));
    assert.equal(june.verdict, "consistent");
    const oct = r.verdicts.find((v) => v.effectiveDate.startsWith("2025-10-31"));
    assert.equal(oct.verdict, "no-price-data");
  });
});

test("/crosscheck: пула нет — 200 со всеми no-price-data (не 500, не пустые догадки)", async () => {
  await withServer({ pool: async () => null, candles: async () => { throw new Error("unreachable"); } }, async (base) => {
    const r = await (await fetch(`${base}/crosscheck?symbol=SPYx`)).json();
    assert.equal(r.pool, null);
    assert.equal(r.coverage.candles, 0);
    assert.ok(r.verdicts.every((v) => v.verdict === "no-price-data"));
  });
});

test("/crosscheck: источник цен упал — 503 с kind", async () => {
  const err = new PriceError("rate-limit", "HTTP 429");
  await withServer({ pool: async () => { throw err; }, candles: async () => [] }, async (base) => {
    const res = await fetch(`${base}/crosscheck?symbol=SPYx`);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).kind, "rate-limit");
  });
});
