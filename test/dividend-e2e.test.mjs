// Сквозной (e2e) тест дивидендного сценария: синтетическое событие DIVIDEND_ACCRUAL
// проходит фактический путь пайплайна — схема → привязка минта → движок лотов → API.
// Без сети: свой синтетический реестр (минт НЕ из живого data/tokens.json),
// мок walletScanner, сервер на 127.0.0.1:0.
//
// Карта пути (по фактическому коду, не по догадкам):
//   validateEvent (schema/events.mjs): DIVIDEND_ACCRUAL требует type/mint/effectiveDate/
//     status/sources + amountPerUnitRaw (целое > 0) и decimals (целое 0..18).
//     Даты в схеме две НЕ разделены: есть только effectiveDate (экс-дата), payout-даты нет.
//   bindMintAndValidate (events/normalize-xstocks.mjs): привязка события к минту.
//   applyEvents (lots/lots.mjs): начисление НА ВЛАДЕЛЬЦА —
//     totalRaw = BigInt(amountPerUnitRaw) × Σ qtyRaw лотов этого владельца,
//     купленных СТРОГО РАНЬШЕ effectiveDate; qty/basis лотов не меняются.
//     decimals в арифметике НЕ участвует — это метаданные для слоя отображения.
//   API (api/server.mjs): /events и /summary отдают событие; /lots — НЕ отдаёт
//     начислений: движок applyEvents к API не подключён (GAP 2, пин ниже).
//
// Синтетика: минты/владельцы — валидный base58 (без 0/O/I/l), 44 символа,
// в живом реестре отсутствуют. Числа целочисленные (BigInt), как в движке.
import test from "node:test";
import assert from "node:assert/strict";
import { validateEvent, EventValidationError } from "../src/schema/events.mjs";
import { multiplierHistoryToEvents, bindMintAndValidate } from "../src/events/normalize-xstocks.mjs";
import { applyEvents, LotError } from "../src/lots/lots.mjs";
import { crossCheckEvents } from "../src/events/crosscheck.mjs";
import { createApiServer } from "../src/api/server.mjs";

// ---- синтетические константы (валидный base58, не из живого реестра) ----

const MINT = "DivE2eMint" + "1".repeat(34); // 44 символа
const MINT_OTHER = "DivE2eNone" + "1".repeat(34); // чужой минт для негативных сценариев
const OWNER_A = "DivAddrA" + "1".repeat(36);
const OWNER_B = "DivAddrB" + "1".repeat(36);
const SYMBOL = "DVTx";

// Синтетический реестр: один дивидендный токен. Поля — как у записей loadRegistry
// (report.mjs читает symbol/name/decimals, /summary читает issuer).
const registry = [
  { mint: MINT, symbol: SYMBOL, name: "Dividend Test Token (synthetic)", decimals: 6, issuer: "test-issuer" },
];

// Дивиденд: $2.00 на целый токен, токен и выплата по 6 десятичных.
// amountPerUnitRaw — raw-единиц ВЫПЛАТЫ на одну raw-единицу ТОКЕНА (движок умножает raw×raw):
// 2 raw выплаты × qtyRaw токена. Целое — схема не принимает дроби.
// Экс-дата — 2026-09-10.
const dividendEvent = bindMintAndValidate([{
  type: "DIVIDEND_ACCRUAL",
  effectiveDate: "2026-09-10", // экс-дата (единственная дата в схеме)
  status: "confirmed",
  sources: ["https://issuer.example/dividends/2026-q3"],
  amountPerUnitRaw: 2,
  decimals: 6,
}], MINT)[0];

// blockTime в скане — секунды (report.mjs: new Date(blockTime * 1000))
const ts = (isoDate) => Math.floor(Date.parse(isoDate) / 1000);

const buy = (signature, mint, qty, isoDate) => ({
  signature, slot: 1, blockTime: ts(isoDate),
  deltas: [{ owner: OWNER_A, mint, preRaw: 0n, postRaw: qty, deltaRaw: qty }],
});

const scanOf = (txs, extra = {}) => ({
  owner: OWNER_A, signatures: txs.length, fetched: txs.length, txs, skipped: [], truncated: false, ...extra,
});

async function withServer(fn, { events = [dividendEvent], walletScanner = null } = {}) {
  const server = await createApiServer({ registry, events, walletScanner });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

// ---- сценарий 1: «дивиденд пришёл в позицию» — сквозной путь ----

test("сценарий 1 (событие): синтетический DIVIDEND_ACCRUAL доезжает до /events, /summary, /health", async () => {
  await withServer(async (base) => {
    // /events: событие привязано к минту, поля не искажены; фильтр по типу работает
    const list = await (await fetch(`${base}/events?symbol=${SYMBOL}&type=DIVIDEND_ACCRUAL`)).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].type, "DIVIDEND_ACCRUAL");
    assert.equal(list[0].mint, MINT);
    assert.equal(list[0].effectiveDate, "2026-09-10");
    assert.equal(list[0].amountPerUnitRaw, 2);
    assert.equal(list[0].decimals, 6);
    assert.equal(list[0].status, "confirmed");
    assert.deepEqual(list[0].sources, ["https://issuer.example/dividends/2026-q3"]);

    // /summary: событие посчитано за токеном; множитель честная «1» — дивиденд не ребейз,
    // таймлайна MULTIPLIER_CHANGE у минта нет и он не исключён из витрины
    const rows = await (await fetch(`${base}/summary`)).json();
    const row = rows.find((r) => r.symbol === SYMBOL);
    assert.equal(row.events, 1);
    assert.equal(row.currentMultiplier, "1");
    assert.equal("excluded" in row, false);

    // /health: событие в общем счётчике
    const h = await (await fetch(`${base}/health`)).json();
    assert.equal(h.events, 1);
  });
});

test("сценарий 1 (деньги): /lots отдаёт позицию, движок начисляет на неё, числа сходятся", async () => {
  // позиция: две покупки до экс-даты, один владелец
  const txs = [
    buy("a", MINT, 1_000_000n, "2026-09-01"),
    buy("b", MINT, 1_500_000n, "2026-09-05"),
  ];
  const scanner = async () => scanOf(txs, {
    accounts: new Map([[MINT, { address: OWNER_A, currentRaw: 2_500_000n }]]),
  });
  await withServer(async (base) => {
    const rep = await (await fetch(`${base}/lots?address=${OWNER_A}`)).json();
    const row = rep.tokens.find((t) => t.mint === MINT);
    assert.equal(row.symbol, SYMBOL);
    assert.equal(row.rawBalance, "2500000"); // 1M + 1.5M raw
    assert.equal(row.lots.length, 2);
    assert.equal(row.reconciles, true); // дельты окна сходятся с балансом на цепи
    assert.equal(row.multiplier.events, 0); // дивиденд в таймлайн множителя не попал

    // Задокументированный стык (report.mjs шапка + round6-report-lots): потребитель /lots
    // достраивает движковый контекст — в лотах отчёта НЕТ mint/owner/basisRaw.
    const engineLots = row.lots.map((l) => ({
      ...l, mint: row.mint, owner: rep.owner, qtyRaw: BigInt(l.qtyRaw), basisRaw: 0n,
    }));
    const { lots, accruals, applied } = applyEvents(engineLots, [dividendEvent]);

    assert.equal(applied, 1);
    // лоты дивидендом не тронуты: qty и даты как были
    assert.deepEqual(lots.map((l) => l.qtyRaw), [1_000_000n, 1_500_000n]);

    // начисление на владельца: обе до-экс-даты покупки агрегированы в ОДНУ запись
    assert.equal(accruals.length, 1);
    const a = accruals[0];
    assert.equal(a.owner, OWNER_A);
    assert.equal(a.mint, MINT);
    assert.equal(a.amountPerUnitRaw, 2n);
    assert.equal(a.decimals, 6);
    // ИТОГ: totalRaw = amountPerUnitRaw × Σ qtyRaw = 2 × 2 500 000 = 5 000 000 raw выплаты
    // (= 5.0 единиц при decimals 6; 2.5 токена × $2.00). Сверено с числами ИЗ API-ответа:
    assert.equal(a.totalRaw, 2n * row.lots.reduce((acc, l) => acc + BigInt(l.qtyRaw), 0n));
    assert.equal(a.totalRaw, 5_000_000n);
  }, { walletScanner: scanner });
});

// ---- сценарий 2: «дивиденд без позиции» — ничего не ломает, начисления нет ----

test("сценарий 2 (движок): нет лотов и чужой минт — accruals пуст, применение безопасно", () => {
  const none = applyEvents([], [dividendEvent]);
  assert.deepEqual(none.accruals, []);
  assert.deepEqual(none.lots, []);
  assert.equal(none.applied, 1); // событие применено (посчитано), но держателей нет

  // позиция в ЧУЖОМ минте: дивиденд не переносится
  const other = applyEvents([{
    id: "X1", mint: MINT_OTHER, owner: OWNER_A, qtyRaw: 999n, acquiredDate: "2026-09-01", basisRaw: 1n,
  }], [dividendEvent]);
  assert.deepEqual(other.accruals, []);
  assert.equal(other.lots[0].qtyRaw, 999n); // чужая позиция не тронута
});

test("сценарий 2 (API): кошелёк без позиции — /lots пуст, событие в /events живёт", async () => {
  const scanner = async () => scanOf([]); // пустой скан
  await withServer(async (base) => {
    const rep = await (await fetch(`${base}/lots?address=${OWNER_A}`)).json();
    assert.deepEqual(rep.tokens, []); // ни позиции, ни выдуманных строк
    // начислений в ответе нет вообще — по всему wire-формату
    assert.equal(JSON.stringify(rep).includes("accrual"), false);

    // при этом событие отдаётся: событие ≠ начисление, оно существует без позиции
    const list = await (await fetch(`${base}/events?symbol=${SYMBOL}&type=DIVIDEND_ACCRUAL`)).json();
    assert.equal(list.length, 1);
  }, { walletScanner: scanner });
});

// ---- сценарий 3: «дивиденд между двумя покупками» — только лоты на экс-дате ----

test("сценарий 3: покупка ПОСЛЕ экс-даты не получает начисление, ДО — получает", () => {
  const { accruals } = applyEvents([
    { id: "L1", mint: MINT, owner: OWNER_A, qtyRaw: 1_000_000n, acquiredDate: "2026-09-01", basisRaw: 1n },
    { id: "L2", mint: MINT, owner: OWNER_A, qtyRaw: 700_000n, acquiredDate: "2026-09-20", basisRaw: 1n },
  ], [dividendEvent]);
  assert.equal(accruals.length, 1);
  assert.equal(accruals[0].totalRaw, 2n * 1_000_000n, "в базе только лот, купленный до экс-даты");
});

test("сценарий 3 (граница): купленный В ДЕНЬ экс-даты исключён; внутри дня сравнение unix-ms", () => {
  // «строго раньше»: купленный date-only в день события — уже по пост-событийным правилам
  const sameDay = applyEvents([
    { id: "L1", mint: MINT, owner: OWNER_A, qtyRaw: 100n, acquiredDate: "2026-09-10", basisRaw: 1n },
  ], [dividendEvent]);
  assert.deepEqual(sameDay.accruals, []);

  // событие в полночь UTC: покупка в 12:00 того же дня — ПОЗЖЕ события (числовое сравнение,
  // не лексикографическое), покупка за секунду до полуночи — ДО
  const intraday = applyEvents([
    { id: "early", mint: MINT, owner: OWNER_A, qtyRaw: 10n, acquiredDate: "2026-09-09T23:59:59Z", basisRaw: 1n },
    { id: "late", mint: MINT, owner: OWNER_A, qtyRaw: 20n, acquiredDate: "2026-09-10T12:00:00Z", basisRaw: 1n },
  ], [dividendEvent]);
  assert.equal(intraday.accruals.length, 1);
  assert.equal(intraday.accruals[0].totalRaw, 2n * 10n);
});

test("сценарий 3 (владельцы): два владельца — две записи; два лота одного владельца — одна сумма", () => {
  const { accruals } = applyEvents([
    { id: "A1", mint: MINT, owner: OWNER_A, qtyRaw: 100n, acquiredDate: "2026-09-01", basisRaw: 1n },
    { id: "A2", mint: MINT, owner: OWNER_A, qtyRaw: 40n, acquiredDate: "2026-09-02", basisRaw: 1n },
    { id: "B1", mint: MINT, owner: OWNER_B, qtyRaw: 60n, acquiredDate: "2026-09-03", basisRaw: 1n },
    { id: "A3", mint: MINT, owner: OWNER_A, qtyRaw: 50n, acquiredDate: "2026-09-20", basisRaw: 1n }, // после экс-даты
  ], [dividendEvent]);
  assert.equal(accruals.length, 2);
  const byOwner = new Map(accruals.map((a) => [a.owner, a.totalRaw]));
  assert.equal(byOwner.get(OWNER_A), 2n * 140n); // A1+A2, A3 мимо
  assert.equal(byOwner.get(OWNER_B), 2n * 60n);

  // вход не мутируется: начисление — отдельная запись, лоты как были
  const input = [{ id: "Z1", mint: MINT, owner: OWNER_A, qtyRaw: 11n, acquiredDate: "2026-09-01", basisRaw: 7n }];
  const { lots } = applyEvents(input, [dividendEvent]);
  assert.equal(input[0].qtyRaw, 11n);
  assert.deepEqual(lots[0], input[0]);
});

// ---- схема fail-closed: кривой дивиденд отклоняется ДО движка ----

test("схема: amountPerUnitRaw 0/отрицательное/дробное и decimals вне 0..18 отклоняются", () => {
  const bad = (over) => ({ ...dividendEvent, ...over });
  for (const e of [
    bad({ amountPerUnitRaw: 0 }),
    bad({ amountPerUnitRaw: -5 }),
    bad({ amountPerUnitRaw: 1.5 }), // дробь запрещена: движок умножает BigInt
    bad({ decimals: 19 }),
    bad({ decimals: -1 }),
    bad({ decimals: undefined }),
    bad({ effectiveDate: "2026-13-45" }), // мусорная дата — не доезжает до Date.parse
  ]) {
    assert.throws(() => validateEvent(e), EventValidationError, JSON.stringify(e));
    // движок оборачивает в LotError ДО изменения состояния (атомарность)
    assert.throws(() => applyEvents([{
      id: "L", mint: MINT, owner: OWNER_A, qtyRaw: 1n, acquiredDate: "2026-09-01", basisRaw: 1n,
    }], [e]), LotError);
  }
});

// ---- GAP-пины: честная фиксация фактического состояния (поведение НЕ выдумывается) ----

test("GAP 1: производитель DIVIDEND_ACCRUAL в src отсутствует — дивиденд эмитента доезжает только как MULTIPLIER_CHANGE", () => {
  // Факт: единственный нормализатор источников (normalize-xstocks) рождает ТОЛЬКО
  // MULTIPLIER_CHANGE, даже когда reason эмитента — «Dividend» (узел ровно той формы,
  // что отдаёт история множителей эмитента). В src/ ни один модуль не создаёт
  // DIVIDEND_ACCRUAL (строка встречается только в schema, lots и тексте UI): тип
  // достижим лишь внешней/ручной подачей, как в этом файле. Значит «дивидендный
  // путь» на живых источниках сегодня считается ребейзом множителя, а не начислением.
  const events = multiplierHistoryToEvents([
    { id: "node-1", reason: "Dividend", previousMultiplier: "1", multiplier: "1.005",
      activationDateTime: "2026-06-18T00:00:00.000Z" },
  ], { symbol: SYMBOL });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "MULTIPLIER_CHANGE");
  assert.equal(events[0].reason, "Dividend");
});

test("GAP 2: движок лотов не подключён к API — /lots не отдаёт начислений", async () => {
  // Факт по коду: server.mjs и report.mjs НЕ вызывают applyEvents (упоминание в report.mjs —
  // только в комментарии-контракте). Пин витриной: в полном wire-ответе /lots нет ни поля
  // accruals, ни суммы начисления. Начисление существует, только пока его не посчитал
  // внешний потребитель (как в сценарии 1).
  const txs = [buy("a", MINT, 1_000_000n, "2026-09-01")];
  const scanner = async () => scanOf(txs);
  await withServer(async (base) => {
    const rep = await (await fetch(`${base}/lots?address=${OWNER_A}`)).json();
    const wire = JSON.stringify(rep);
    assert.equal(wire.includes("accrual"), false, "начисления не доезжают до /lots");
    assert.equal(wire.includes("dividend"), false);
    // движок при этом на тех же данных начисляет — разрыв между движком и витриной
    const row = rep.tokens.find((t) => t.mint === MINT);
    const engineLots = row.lots.map((l) => ({ ...l, mint: row.mint, owner: rep.owner, qtyRaw: BigInt(l.qtyRaw), basisRaw: 0n }));
    const { accruals } = applyEvents(engineLots, [dividendEvent]);
    assert.equal(accruals[0].totalRaw, 2_000_000n); // а движок бы начислил
  }, { walletScanner: scanner });
});

test("GAP 3: accrual движка несёт BigInt — напрямую в JSON-ответ не сериализуется", () => {
  // Факт: accruals.push({ ..., amountPerUnitRaw: BigInt, totalRaw: BigInt }) (lots.mjs).
  // JSON.stringify на BigInt бросает: выдача начислений через json()-хелпер сервера как есть
  // дала бы 500. Рабочий путь — ручной String()-адаптер, как делает report.mjs для лотов.
  const { accruals } = applyEvents([{
    id: "L", mint: MINT, owner: OWNER_A, qtyRaw: 1_000_000n, acquiredDate: "2026-09-01", basisRaw: 1n,
  }], [dividendEvent]);
  assert.throws(() => JSON.stringify(accruals[0]), /Do not know how to serialize a BigInt/);
  // адаптер-потребитель (так пришлось бы делать любому эндпоинту):
  const wire = { ...accruals[0], amountPerUnitRaw: String(accruals[0].amountPerUnitRaw), totalRaw: String(accruals[0].totalRaw) };
  assert.equal(JSON.parse(JSON.stringify(wire)).totalRaw, "2000000");
});

test("GAP 4 (закрыт): /crosscheck теперь даёт вердикт DIVIDEND_ACCRUAL — молчаливой фильтрации нет", () => {
  // Было (пин факта): crossCheckEvents фильтровал вход к MULTIPLIER_CHANGE — дивиденд
  // не проверялся против рыночной цены вообще: ни verdict, ни упоминания в выдаче.
  // Закрыто в src/events/crosscheck.mjs (crossCheckDividendAccrual): честная сигнатура
  // падения в raw-единицах токена (rawClosePrev − amountPerUnitRaw ≈ rawCloseEx),
  // вердикт помечен type: "DIVIDEND_ACCRUAL" и идёт в хвосте списка вердиктов
  // (после всех MULTIPLIER_CHANGE — контракт витрины src/ui/page.mjs не сломан).
  const { verdicts } = crossCheckEvents([dividendEvent], []);
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].type, "DIVIDEND_ACCRUAL");
  assert.equal(verdicts[0].amountPerUnitRaw, 2);
  // свечей нет — честное «нет цены», а не выдуманный вердикт (та же таксономия, что у ребейза)
  assert.equal(verdicts[0].verdict, "no-price-data");
});

test("GAP 5: в схеме нет payout-даты — effectiveDate единственная дата начисления", () => {
  // Факт: validateEvent для DIVIDEND_ACCRUAL требует только amountPerUnitRaw и decimals;
  // полей exDate/payDate/recordDate в схеме нет. Начисление датируется экс-датой —
  // «когда деньги придут» схема выразить не может. Пин контракта, поведение не меняется.
  const e = { ...dividendEvent };
  assert.equal(validateEvent(e), true);
  assert.equal("payDate" in e, false);
  assert.equal("recordDate" in e, false);
});
