// Дивидендный кросс-чек: DIVIDEND_ACCRUAL получает честную ценовую проверку.
//
// Семантика (см. шапку src/events/crosscheck.mjs) — ЧЕСТНАЯ математика в raw-единицах
// токена, БЕЗ долларов и без FX (у amountPerUnitRaw в схеме нет валюты выплаты, а курса
// выплаты на экс-дату в пайплайне нет — сравнение в долларах было бы выдумкой):
//   rawClose = close × 10^decimals;  expectedDropRaw = amountPerUnitRaw;
//   actualDropRaw = rawClosePrev − rawCloseEx.
// Сравнение — долями pre-ex raw-цены; лестница допусков — та же, что у MULTIPLIER_CHANGE:
// дыра свечей > 3 дней → inconclusive; дивиденд < 0.5% цены → шум (±3%); иначе
// tolerance = max(3%, 60% ожидания) → consistent/mismatch.
// Отдельно пиним: MULTIPLIER_CHANGE-путь не изменился (порядок вердиктов — контракт
// витрины src/ui/page.mjs: сначала все ребейзы, дивиденды в хвосте).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  crossCheckMultiplierChange,
  crossCheckDividendAccrual,
  crossCheckEvents,
  CrossCheckError,
} from "../src/events/crosscheck.mjs";
import { multiplierHistoryToEvents, bindMintAndValidate } from "../src/events/normalize-xstocks.mjs";
import { createApiServer } from "../src/api/server.mjs";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const SPYx = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const MINT = "DivXcMint" + "1".repeat(35); // синтетика: валидный base58, не из живого реестра

const DAY = 86400;
const d = (yyyy, mm, dd) => Math.floor(Date.parse(`${yyyy}-${mm}-${dd}T00:00:00Z`) / 1000);
const divEv = (iso, amountPerUnitRaw, decimals) => ({
  type: "DIVIDEND_ACCRUAL", effectiveDate: iso, amountPerUnitRaw, decimals,
});
const ev = (iso, from, to) => ({
  type: "MULTIPLIER_CHANGE", effectiveDate: iso, multiplierFrom: from, multiplierTo: to, reason: "Dividend",
  status: "confirmed", sources: ["https://issuer.example/multipliers"], // для bindMintAndValidate в API-тесте
});

// --- чистая математика дивидендного вердикта (raw-единицы) ---

test("точное падение на дивиденд — consistent; raw-математика дословно", () => {
  // $2.00-эквивалент в 6 десятичных: 2_000_000 raw на raw-единицу; цена 100 → 98
  const event = divEv("2026-06-10T00:00:00Z", 2_000_000, 6);
  const candles = [
    { ts: d("2026", "06", "08"), c: 100 }, // закрылась 06-09 — последняя ДО экс-даты
    { ts: d("2026", "06", "09"), c: 100 },
    { ts: d("2026", "06", "10"), c: 98 },  // закрылась 06-11 — первая ПОСЛЕ
    { ts: d("2026", "06", "11"), c: 98.1 },
  ];
  const r = crossCheckDividendAccrual(event, candles);
  assert.equal(r.verdict, "consistent");
  // дословная raw-математика: (closePrev − closeEx) × 10^decimals === amountPerUnitRaw
  assert.equal((candles[1].c - candles[2].c) * 10 ** 6, 2_000_000);
  assert.equal(r.expectedDropRaw, 2_000_000);
  assert.equal(r.type, "DIVIDEND_ACCRUAL"); // тип в описании вердикта
  assert.equal(r.decimals, 6);
  // доли: дивиденд 2% pre-ex цены, фактическое падение 2%
  assert.equal(r.expectedDropFraction, 2_000_000 / (100 * 10 ** 6));
  assert.equal(r.observedDropFraction, (100 * 10 ** 6 - 98 * 10 ** 6) / (100 * 10 ** 6));
  assert.equal(r.observed.beforeDate, "2026-06-09");
  assert.equal(r.observed.afterDate, "2026-06-10");
  assert.match(r.note, /dividend signature/);
});

test("почти точное падение (дельта внутри допуска) — тоже consistent", () => {
  const event = divEv("2026-06-10T00:00:00Z", 2_000_000, 6); // ожидание 2%
  const r = crossCheckDividendAccrual(event, [
    { ts: d("2026", "06", "09"), c: 100 },
    { ts: d("2026", "06", "10"), c: 98.1 }, // упало 1.9%: |0.019 − 0.02| = 0.001 << 0.03
  ]);
  assert.equal(r.verdict, "consistent");
});

test("масштаб decimals работает: 2.00 при двух десятичных — та же доля 2%", () => {
  const event = divEv("2026-06-10T00:00:00Z", 200, 2); // 200 raw при 10^2 = те же «2.00»
  const r = crossCheckDividendAccrual(event, [
    { ts: d("2026", "06", "09"), c: 100 },
    { ts: d("2026", "06", "10"), c: 98 },
  ]);
  assert.equal(r.expectedDropFraction, 200 / (100 * 10 ** 2));
  assert.equal(r.verdict, "consistent");
});

test("свечная рамка дивиденда — та же, что у MULTIPLIER_CHANGE: закрытие ровно в момент события = before", () => {
  const evTs = Date.parse("2026-06-12T00:00:00Z") / 1000;
  const r = crossCheckDividendAccrual(divEv("2026-06-12T00:00:00Z", 2_000_000, 6), [
    { ts: evTs - DAY, c: 100 }, // close ровно в момент экс-даты: цена ещё без дивиденда
    { ts: evTs, c: 98 },
  ]);
  assert.equal(r.verdict, "consistent");
  assert.equal(r.observed.beforeDate, "2026-06-11");
  assert.equal(r.observed.afterDate, "2026-06-12");
});

test("мелкий дивиденд (<0.5% цены): в пределах шума — consistent, грубая аномалия — suspicious", () => {
  const event = divEv("2026-06-18T04:00:00Z", 300_000, 6); // 0.3% цены 100
  const calm = crossCheckDividendAccrual(event, [
    { ts: d("2026", "06", "16"), c: 100 },
    { ts: d("2026", "06", "17"), c: 100 },
    { ts: d("2026", "06", "18"), c: 100.2 }, // +0.2% — шум
  ]);
  assert.equal(calm.verdict, "consistent");
  assert.match(calm.note, /daily noise/);

  const wild = crossCheckDividendAccrual(event, [
    { ts: d("2026", "06", "16"), c: 100 },
    { ts: d("2026", "06", "17"), c: 100 },
    { ts: d("2026", "06", "18"), c: 105 }, // +5% — дивиденд 0.3% этого не объясняет
  ]);
  assert.equal(wild.verdict, "suspicious");
  assert.match(wild.note, /cannot explain/);
});

test("рынок не упал на дивиденд — mismatch: рост и падение, многократно превышающие допуск", () => {
  const event = divEv("2026-06-10T00:00:00Z", 200, 2); // ожидание 2% цены, допуск 3%
  const rose = crossCheckDividendAccrual(event, [
    { ts: d("2026", "06", "09"), c: 100 },
    { ts: d("2026", "06", "10"), c: 103 }, // цена ВЫРОСЛА на 3% — дивиденд не упал
  ]);
  assert.equal(rose.verdict, "mismatch");
  assert.ok(rose.observedDropFraction < 0, "рост = отрицательная дельта падения");
  assert.match(rose.note, /did not drop by the dividend amount/);

  const sank = crossCheckDividendAccrual(event, [
    { ts: d("2026", "06", "09"), c: 100 },
    { ts: d("2026", "06", "10"), c: 92 }, // упало 8% при дивиденде 2% — не дивидендная сигнатура
  ]);
  assert.equal(sank.verdict, "mismatch");
});

test("дыра в свечах вокруг экс-даты — inconclusive, доля падения при этом посчитана", () => {
  const r = crossCheckDividendAccrual(divEv("2026-05-01T00:15:00Z", 2_000_000, 6), [
    { ts: d("2026", "04", "14"), c: 100 }, // потом пул молчал два месяца
    { ts: d("2026", "06", "14"), c: 93 },
  ]);
  assert.equal(r.verdict, "inconclusive");
  assert.equal(r.observed.windowDays, 61);
  assert.match(r.note, /candle gap/);
  assert.equal(r.observedDropFraction, (100 * 10 ** 6 - 93 * 10 ** 6) / (100 * 10 ** 6));
});

test("нет истории до экс-даты и пустой набор свечей — no-price-data с честной причиной", () => {
  const event = divEv("2025-10-31T23:55:00Z", 2_000_000, 6);
  const short = crossCheckDividendAccrual(event, [
    { ts: d("2026", "03", "18"), c: 100 },
    { ts: d("2026", "03", "19"), c: 100 },
  ]);
  assert.equal(short.verdict, "no-price-data");
  assert.equal(short.observedDropFraction, null);
  assert.equal(short.observed, null);
  assert.match(short.note, /do not reach back/);

  const empty = crossCheckDividendAccrual(event, []);
  assert.equal(empty.verdict, "no-price-data");
  assert.equal(empty.observedDropFraction, null);
});

test("нулевая pre-ex цена — inconclusive, а не деление на ноль", () => {
  const r = crossCheckDividendAccrual(divEv("2026-06-10T00:00:00Z", 2_000_000, 6), [
    { ts: d("2026", "06", "09"), c: 0 }, // вырожденный пул
    { ts: d("2026", "06", "10"), c: 0 },
  ]);
  assert.equal(r.verdict, "inconclusive");
  // ROUND9 №5: гвард обеих сторон — нота про close ВОКРУГ экс-даты (было «pre-ex»)
  assert.match(r.note, /unusable close around the ex-date/); // раунд 10: finite-гвард, формулировка шире
});

test("кривое событие — отказ, а не догадка: тип, дата, amount, decimals", () => {
  const ok = divEv("2026-06-10T00:00:00Z", 2_000_000, 6);
  assert.throws(() => crossCheckDividendAccrual({ ...ok, type: "SPLIT" }, []), CrossCheckError);
  assert.throws(() => crossCheckDividendAccrual(divEv("2026-02-30", 2_000_000, 6), []), CrossCheckError); // перекат Date.parse
  for (const bad of [0, -5, 1.5, undefined, null]) {
    assert.throws(
      () => crossCheckDividendAccrual({ ...ok, amountPerUnitRaw: bad }, []),
      CrossCheckError,
      `amountPerUnitRaw=${JSON.stringify(bad)} должен отвергаться`,
    );
  }
  for (const bad of [19, -1, 1.5, undefined]) {
    assert.throws(
      () => crossCheckDividendAccrual({ ...ok, decimals: bad }, []),
      CrossCheckError,
      `decimals=${JSON.stringify(bad)} должен отвергаться`,
    );
  }
});

// --- crossCheckEvents: порядок вердиктов — контракт витрины, дивиденды в хвосте ---

test("crossCheckEvents: MULTIPLIER_CHANGE-вердикты первыми и байт-в-байт прежние, дивиденд в хвосте с type", () => {
  const M1 = ev("2026-06-10T00:00:00Z", "1", "2");
  const D1 = divEv("2026-06-12T00:00:00Z", 2_000_000, 6);
  const M2 = ev("2026-06-18T04:00:00Z", "1.003909240011759", "1.005714560286254");
  const candles = [
    { ts: d("2026", "06", "08"), c: 100 },
    { ts: d("2026", "06", "09"), c: 100 },
    { ts: d("2026", "06", "10"), c: 50 }, // ребейз 1→2 отработал
    { ts: d("2026", "06", "12"), c: 49 }, // дивиденд отработал (не падение в 2 раза)
    { ts: d("2026", "06", "17"), c: 49 },
    { ts: d("2026", "06", "18"), c: 49.2 },
  ];
  const { verdicts } = crossCheckEvents([M1, D1, M2], candles);
  assert.equal(verdicts.length, 3);

  // первые два — вердикты M1 и M2, идентичные чистой функции (витрина keyирует их по seq)
  assert.deepEqual(verdicts[0], crossCheckMultiplierChange(M1, candles));
  assert.deepEqual(verdicts[1], crossCheckMultiplierChange(M2, candles));
  assert.equal("type" in verdicts[0], false); // форма прежних вердиктов не тронута
  assert.equal(verdicts[0].verdict, "consistent");
  assert.equal(verdicts[1].verdict, "consistent");

  // дивиденд — последним, помечен типом
  assert.equal(verdicts[2].type, "DIVIDEND_ACCRUAL");
  assert.equal(verdicts[2].amountPerUnitRaw, 2_000_000);
  assert.equal(verdicts[2].verdict, "consistent");
});

test("регрессия MULTIPLIER_CHANGE на живой фикстуре SPYx: вердикты прежние, дивидендов в фикстуре нет", () => {
  const historyNodes = JSON.parse(
    readFileSync(path.join(dir, "xstocks-spyx-history-eth.json"), "utf8"),
  ).nodes;
  const events = bindMintAndValidate(multiplierHistoryToEvents(historyNodes, { symbol: "SPYx" }), SPYx);
  const candles = [
    { ts: d("2026", "06", "16"), c: 100 },
    { ts: d("2026", "06", "17"), c: 100 },
    { ts: d("2026", "06", "18"), c: 100.2 },
    { ts: d("2026", "06", "19"), c: 100.3 },
  ];
  const { verdicts } = crossCheckEvents(events, candles);
  assert.equal(verdicts.length, 4); // 4 ребейза, ни одного дивиденда — путь не изменился
  assert.ok(verdicts.every((v) => "multiplierFrom" in v && !("type" in v)));
  const june = verdicts.find((v) => v.effectiveDate.startsWith("2026-06-18"));
  assert.equal(june.verdict, "consistent");
  const oct = verdicts.find((v) => v.effectiveDate.startsWith("2025-10-31"));
  assert.equal(oct.verdict, "no-price-data");
});

// --- витрина: /crosscheck отдаёт дивидендный вердикт без правок сервера ---

async function withServer(events, candles, fn) {
  const registry = [{ mint: MINT, symbol: "DVTx", name: "Dividend Crosscheck Token (synthetic)", decimals: 6, issuer: "test-issuer" }];
  const server = await createApiServer({
    registry,
    events,
    priceProvider: {
      pool: async () => ({ address: "P1", name: "DVTx / USDC", volume24hUsd: "1" }),
      candles: async () => candles,
    },
  });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("/crosscheck: ребейз и дивиденд в одном ответе — сначала вердикт ребейза, дивиденд помечен type", async () => {
  const events = bindMintAndValidate([
    // таймлайн обязан начинаться с «1», иначе MultiplierTimeline исключит минт из витрины
    ev("2026-06-18T04:00:00Z", "1", "1.0015"),
    { type: "DIVIDEND_ACCRUAL", effectiveDate: "2026-06-10T00:00:00Z", amountPerUnitRaw: 2_000_000, decimals: 6, status: "confirmed", sources: ["https://issuer.example/div"] },
  ], MINT);
  const candles = [
    { ts: d("2026", "06", "09"), c: 100 },
    { ts: d("2026", "06", "10"), c: 98 },  // дивиденд: точное падение на 2.00
    { ts: d("2026", "06", "17"), c: 98 },
    { ts: d("2026", "06", "18"), c: 98.2 }, // ребейз: в пределах шума
  ];
  await withServer(events, candles, async (base) => {
    const r = await (await fetch(`${base}/crosscheck?symbol=DVTx`)).json();
    assert.equal(r.symbol, "DVTx");
    assert.equal(r.verdicts.length, 2);
    // контракт витрины: вердикты ребейзов идут в порядке MULTIPLIER_CHANGE-событий
    assert.equal("multiplierFrom" in r.verdicts[0], true);
    assert.equal(r.verdicts[0].verdict, "consistent");
    // дивидендный вердикт доезжает до витрины и распознаётся по type
    assert.equal(r.verdicts[1].type, "DIVIDEND_ACCRUAL");
    assert.equal(r.verdicts[1].verdict, "consistent");
    assert.equal(r.verdicts[1].expectedDropRaw, 2_000_000);
  });
});
