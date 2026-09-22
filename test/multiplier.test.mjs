import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isValidEvent } from "../src/schema/events.mjs";
import { multiplierHistoryToEvents, bindMintAndValidate, NormalizeError } from "../src/events/normalize-xstocks.mjs";
import { decimalToRatio, MultiplierTimeline, TimelineError } from "../src/lots/timeline.mjs";
import { fetchMultiplierHistory } from "../src/issuer/xstocks.mjs";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W"; // SPYx

// ЖИВАЯ история SPYx (Ethereum): 4 дивиденда, новая сверху
const historyFixture = JSON.parse(readFileSync(path.join(dir, "xstocks-spyx-history-eth.json"), "utf8"));
const history = { hasNextPage: false, nodes: historyFixture.nodes.map((n) => ({ ...n })) };

const ev = (over = {}) => ({
  type: "MULTIPLIER_CHANGE",
  mint: MINT,
  effectiveDate: "2026-06-18T04:00:00.000Z",
  status: "confirmed",
  sources: ["https://api.xstocks.fi/api/v2/public/assets/SPYx/multiplier/history?network=Ethereum#node:x"],
  multiplierFrom: "1.003909240011759",
  multiplierTo: "1.005714560286254",
  reason: "Dividend",
  ...over,
});

// ---- схема ----

test("MULTIPLIER_CHANGE валиден с десятичными строками", () => {
  assert.equal(isValidEvent(ev()), true);
});

test("float вместо строки отклоняется (float запрещён)", () => {
  assert.equal(isValidEvent(ev({ multiplierTo: 1.0057 })), false);
});

test("битовый формат и from==to отклоняются", () => {
  assert.equal(isValidEvent(ev({ multiplierTo: "1.00.5" })), false);
  assert.equal(isValidEvent(ev({ multiplierTo: "-1.5" })), false);
  assert.equal(isValidEvent(ev({ multiplierTo: ev().multiplierFrom })), false);
});

// ---- нормализатор ----

test("живая история SPYx → 4 канонических события, старые→новые, схема валидна", () => {
  const events = bindMintAndValidate(multiplierHistoryToEvents(history.nodes, { symbol: "SPYx" }), MINT);
  assert.equal(events.length, 4);
  assert.equal(events[0].effectiveDate, "2025-10-31T23:55:00.000Z");
  assert.equal(events[0].multiplierFrom, "1");
  assert.equal(events[3].multiplierTo, "1.005714560286254");
  assert.equal(events[3].reason, "Dividend");
  for (const e of events) assert.equal(e.type, "MULTIPLIER_CHANGE");
});

test("источник события ссылается на конкретный узел API", () => {
  const events = multiplierHistoryToEvents(history.nodes, { symbol: "SPYx" });
  assert.match(events[0].sources[0], /#node:/);
});

// ---- decimalToRatio ----

test("«1» → 1/1; «1.005714560286254» → точная дробь", () => {
  assert.deepEqual(decimalToRatio("1"), { num: 1n, den: 1n });
  const r = decimalToRatio("1.005714560286254");
  assert.equal(r.num, 1005714560286254n);
  assert.equal(r.den, 10n ** 15n);
});

test("мусор отклоняется", () => {
  assert.throws(() => decimalToRatio("abc"), TimelineError);
  assert.throws(() => decimalToRatio(1.5), TimelineError);
  assert.throws(() => decimalToRatio("1.5.6"), TimelineError);
});

// ---- MultiplierTimeline ----

function spyxTimeline() {
  const events = bindMintAndValidate(multiplierHistoryToEvents(history.nodes, { symbol: "SPYx" }), MINT);
  return new MultiplierTimeline(events);
}

test("шкала из живой истории: множитель по датам до/между/после событий", () => {
  const tl = spyxTimeline();
  assert.equal(tl.multiplierAt("2025-10-30"), "1");
  assert.equal(tl.multiplierAt("2025-10-31T23:55:00.000Z"), "1.00099942056");
  assert.equal(tl.multiplierAt("2026-02-01"), "1.0025607582229898");
  assert.equal(tl.multiplierAt("2026-07-01"), "1.005714560286254");
  assert.equal(tl.multiplierAt("2099-01-01"), "1.005714560286254");
});

test("разрыв цепочки = ошибка, не догадка (fail-closed)", () => {
  const events = multiplierHistoryToEvents(history.nodes, { symbol: "SPYx" });
  events[2].multiplierFrom = "9.99"; // порвать цепочку
  assert.throws(() => new MultiplierTimeline(events), /chain discontinuity/);
});

test("первое событие не от 1 = ошибка", () => {
  const events = multiplierHistoryToEvents(history.nodes, { symbol: "SPYx" }).slice(1); // выбросили первое
  assert.throws(() => new MultiplierTimeline(events), /chain discontinuity/);
});

test("пустая шкала = множитель 1 всюду", () => {
  const tl = new MultiplierTimeline([]);
  assert.equal(tl.multiplierAt("2026-01-01"), "1");
  assert.deepEqual(tl.scaledQty(1_000_000n, "2026-01-01"), { whole: 1_000_000n, remainder: 0n, den: 1n, exact: true });
});

test("scaledQty: точный случай и случай с «пылью» (без молчаливого округления)", () => {
  const tl = spyxTimeline();
  // raw 10^15 × 1.005714560286254 = 1005714560286254 — делится нацело
  const exact = tl.scaledQty(10n ** 15n, "2026-07-01");
  assert.equal(exact.exact, true);
  assert.equal(exact.whole, 1005714560286254n);
  // raw 10^9: 1e9×num/10^15 — не делится: whole + remainder честно
  const dusty = tl.scaledQty(10n ** 9n, "2026-07-01");
  assert.equal(dusty.exact, false);
  assert.equal(dusty.whole, 1005714560n);
  assert.equal(dusty.remainder, 286254000000000n); // 0.286254 единицы в den-единицах
  assert.equal(dusty.den, 10n ** 15n);
});

test("чужой тип события в шкале отклоняется", () => {
  assert.throws(() => new MultiplierTimeline([{ type: "SPLIT", effectiveDate: "2026-01-01" }]), /only MULTIPLIER_CHANGE/);
});

test("интеграция: живая фикстура → клиент → нормализатор → валидная схема", async () => {
  const okRes = (payload) => ({ ok: true, status: 200, json: async () => payload });
  const h = await fetchMultiplierHistory("SPYx", "Ethereum", {
    fetcher: async () => okRes(historyFixture), // сырой JSON с ЧИСЛАМИ, как отдаёт API
  });
  const events = bindMintAndValidate(multiplierHistoryToEvents(h.nodes, { symbol: "SPYx" }), MINT);
  assert.equal(events.length, 4);
  assert.equal(events[0].multiplierFrom, "1");
  assert.equal(events[3].multiplierTo, "1.005714560286254");
});

// ---- раунд-2: даты числом, а не лексикографически ----

test("date-only запрос: событие дня Д считается уже эффективным", () => {
  const e = ev({ effectiveDate: "2026-06-18T00:00:00.000Z", multiplierFrom: "1", multiplierTo: "1.005" });
  const tl = new MultiplierTimeline([e]);
  assert.equal(tl.multiplierAt("2026-06-17"), "1");
  // до фикса: "2026-06-18T00:00:00.000Z" > "2026-06-18" строково → калькулятор витрины
  // показывал ДО-событийный множитель ровно в день события
  assert.equal(tl.multiplierAt("2026-06-18"), "1.005");
  assert.equal(tl.multiplierAt("2026-06-18T00:00:00Z"), "1.005"); // смешанная точность = тот же момент
});

test("сортировка смешанной точности дат не рвёт непрерывность цепочки", () => {
  const a = ev({ effectiveDate: "2026-01-01T00:00:00Z", multiplierFrom: "1", multiplierTo: "1.1" });
  const b = ev({ effectiveDate: "2026-02-01T00:00:00.000Z", multiplierFrom: "1.1", multiplierTo: "1.2" }); // «длиннее» строкой, позже фактом
  const tl = new MultiplierTimeline([b, a]); // подаем не по порядку
  assert.equal(tl.multiplierAt("2026-01-15"), "1.1");
  assert.equal(tl.multiplierAt("2026-02-01"), "1.2");
});

test("мусорная дата в multiplierAt — TimelineError, не молчаливая неправда", () => {
  const tl = new MultiplierTimeline([ev({ multiplierFrom: "1" })]);
  assert.throws(() => tl.multiplierAt("не-дата"), TimelineError);
});

// ---- раунд 4: строгие даты (schema/isodate.mjs) ----

// Та же батарея мусора, что в test/events.test.mjs (схема), — здесь второй барьер:
// timeline нельзя строить из мусора даже мимо схемы.
const garbageDates = [
  "2026-13-01",                // NaN уже после схемной формы
  "2026-00-10",
  "2026-06-18T23:59:60Z",      // leap second
  "2026-06-18T12:00:00+99:99", // оффсет 99:99
  "2026-02-30",                // Date.parse перекатывает на 02.03 — множитель с чужого дня
  "2026-06-31",                // перекат на 01.07
  "2027-02-29",                // перекат на 01.03
  "2026-06-18T24:00:00Z",      // перекат на следующий день
  "2026-06-18T12:00:00",       // наивное время = локаль хоста
  "2026-06-18T12:00:00.500",   // наивное с долями
  "2026-1-1",                  // форма
  "2026-02-29",                // не високосный
  "2026-06-18T12:60:00Z",
  "",
  null,
];

test("мусорная effectiveDate в событии — TimelineError при построении шкалы (батарея)", () => {
  for (const bad of garbageDates) {
    assert.throws(
      () => new MultiplierTimeline([ev({ effectiveDate: bad, multiplierFrom: "1" })]),
      TimelineError,
      `должна отвергаться: ${JSON.stringify(bad)}`,
    );
  }
});

test("мусорная дата в multiplierAt — TimelineError (батарея)", () => {
  const tl = spyxTimeline();
  for (const bad of garbageDates) {
    assert.throws(() => tl.multiplierAt(bad), TimelineError, `должна отвергаться: ${JSON.stringify(bad)}`);
  }
});

// АНТИ-регрессия: канонические форматы проходят, эквивалентность моментов сохранена.
test("канонические форматы дат работают в шкале (анти-перегиб строгого валидатора)", () => {
  for (const date of ["2026-01-30T23:55:00.000Z", "2026-01-30T23:55:00Z", "2026-01-31T01:55:00+02:00", "2026-01-30T19:55:00-04:00"]) {
    const tl = new MultiplierTimeline([ev({ effectiveDate: date, multiplierFrom: "1", multiplierTo: "1.2" })]);
    assert.equal(tl.multiplierAt("2026-01-31"), "1.2", date);
  }
});

// ---- раунд 4 (P4): одиночное событие с битой датой — громко, как и при 2+ ----

test("ОДИНОЧНОЕ событие с effectiveDate null — TimelineError, а не тихая «базовая линия»", () => {
  // до фикса: для 1 элемента компаратор не вызывался → шаг с at:null попадал в steps,
  // multiplierAt пропускал его как базовую линию — ребейз ×5 терялся молча
  const e = ev({ effectiveDate: null, multiplierFrom: "1", multiplierTo: "5" });
  assert.throws(() => new MultiplierTimeline([e]), TimelineError);
  // а до этого падало громко только при 2+ событиях — несимметрично
  assert.throws(
    () => new MultiplierTimeline([e, ev({ effectiveDate: "2026-07-01T00:00:00Z", multiplierFrom: "5", multiplierTo: "6" })]),
    TimelineError,
  );
});

test("ОДИНОЧНОЕ событие с effectiveDate-перекатом («2026-02-30») тоже громкая ошибка", () => {
  assert.throws(
    () => new MultiplierTimeline([ev({ effectiveDate: "2026-02-30", multiplierFrom: "1", multiplierTo: "5" })]),
    TimelineError,
  );
});

// ---- раунд 4: инварианты, подтверждённые фаззером (seed 20260919) ----

function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
}

test("инвариант: перемешанная подача событий = та же шкала (все 24 перестановки живой истории)", () => {
  const base = bindMintAndValidate(multiplierHistoryToEvents(history.nodes, { symbol: "SPYx" }), MINT);
  const queries = ["2025-10-30", "2025-10-31T23:55:00.000Z", "2026-02-01", "2026-05-01T00:15:00.000Z", "2026-07-01"];
  const expected = queries.map((q) => new MultiplierTimeline(base).multiplierAt(q));
  const perms = permutations(base);
  assert.equal(perms.length, 24); // 4! — покрыты ВСЕ порядки входа, не пара примеров
  for (const perm of perms) {
    const tl = new MultiplierTimeline(perm);
    assert.deepEqual(queries.map((q) => tl.multiplierAt(q)), expected, perm.map((e) => e.effectiveDate).join(" | "));
  }
});

test("инвариант: до первого события множитель = 1 (в любом порядке подачи)", () => {
  const events = bindMintAndValidate(multiplierHistoryToEvents(history.nodes, { symbol: "SPYx" }), MINT);
  for (const order of [events, [...events].reverse()]) {
    const tl = new MultiplierTimeline(order);
    assert.equal(tl.multiplierAt("2025-10-30"), "1");
    assert.equal(tl.multiplierAt("2025-01-01T00:00:00Z"), "1");
    assert.equal(tl.multiplierAt("1970-01-01"), "1");
  }
});

test("инвариант: эквивалентность форматов — date-only = Z = .000Z = ±HH:MM (один момент, один множитель)", () => {
  const tl = new MultiplierTimeline([
    ev({ effectiveDate: "2026-06-18T00:00:00.000Z", multiplierFrom: "1", multiplierTo: "1.5" }),
  ]);
  // все запросы — ОДИН и тот же момент: событие уже действует (<=)
  const sameMoment = [
    "2026-06-18",
    "2026-06-18T00:00:00Z",
    "2026-06-18T00:00:00.000Z",
    "2026-06-18T05:00:00+05:00",
    "2026-06-17T21:00:00-03:00",
  ];
  for (const q of sameMoment) {
    assert.equal(tl.multiplierAt(q), "1.5", q);
  }
});

test("инвариант реконструкции: whole·den + remainder = qty·num, 0 ≤ remainder < den", () => {
  const tl = spyxTimeline();
  for (const qty of [1n, 7n, 999n, 10n ** 9n, 10n ** 15n, 12345678901234567890n]) {
    for (const date of ["2025-10-30", "2026-02-01", "2026-07-01"]) {
      const { num, den } = tl.factorAt(date);
      const { whole, remainder, exact } = tl.scaledQty(qty, date);
      assert.ok(remainder >= 0n && remainder < den, `remainder вне диапазона: ${qty} @ ${date}`);
      assert.equal(whole * den + remainder, qty * num, `${qty} @ ${date}`);
      assert.equal(exact, remainder === 0n);
    }
  }
});

// ---- раунд 4 (P3): нормализатор — сорт по моменту времени, не по строке ----

test("сорт по моменту: смешанная точность внутри секунды больше не переворачивает хронологию", () => {
  // как отдаёт API — новые сверху. localeCompare ставил ".500Z" ПЕРЕД "Z"
  // (".", 0x2E, < "Z", 0x5A) → ПОЗЖЕ шёл раньше, хронология перевёрнута
  const nodes = [
    { id: "new", multiplier: 1.3, previousMultiplier: 1.1, activationDateTime: "2026-01-01T00:00:00.500Z" }, // момент ПОЗЖЕ
    { id: "old", multiplier: 1.1, previousMultiplier: 1, activationDateTime: "2026-01-01T00:00:00Z" },        // момент РАНЬШЕ
  ];
  const events = multiplierHistoryToEvents(nodes, { symbol: "SPYx" });
  assert.deepEqual(events.map((e) => e.effectiveDate), [
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00.500Z",
  ]);
  // цепочка после честного сорта собирается, момент события = момент действия
  const tl = new MultiplierTimeline(bindMintAndValidate(events, MINT));
  assert.equal(tl.multiplierAt("2026-01-01T00:00:00Z"), "1.1");
  assert.equal(tl.multiplierAt("2026-01-01T00:00:00.250Z"), "1.1"); // между событиями
  assert.equal(tl.multiplierAt("2026-01-01T00:00:00.500Z"), "1.3");
});

test("непарсируемая activationDateTime — NormalizeError (fail-closed), не тихий порядок", () => {
  assert.throws(
    () => multiplierHistoryToEvents([
      { id: "x", multiplier: 1.2, previousMultiplier: 1.1, activationDateTime: "2026-02-30" }, // перекат-дата
    ], { symbol: "SPYx" }),
    NormalizeError,
  );
  assert.throws(
    () => multiplierHistoryToEvents([
      { id: "y", multiplier: 1.2, previousMultiplier: 1.1, activationDateTime: 0 }, // как в xstocks-spyx-current.json
    ], { symbol: "SPYx" }),
    NormalizeError,
  );
});

test("кап дробной точности един на уровне схемы и шкалы: 31 знак валит и схему, и decimalToRatio", () => {
  const m31 = "1." + "1".repeat(31);
  assert.equal(isValidEvent(ev({ multiplierTo: m31 })), false);
  assert.throws(() => decimalToRatio(m31), TimelineError);
});
