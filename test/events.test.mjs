import test from "node:test";
import assert from "node:assert/strict";
import { validateEvent, isValidEvent, EventValidationError } from "../src/schema/events.mjs";

const MINT = "EHTvgDbXdad1o1tfqmT4apRDYXQmbsLtc72jLLGgQAp6"; // реальный минт из стокбейсовского реестра (SPACEX-класс, base58-валидный)
const valid = (over = {}) => ({
  type: "SPLIT",
  mint: MINT,
  effectiveDate: "2026-10-01",
  status: "confirmed",
  sources: ["https://issuer.example/announcement"],
  ratioNumerator: 3,
  ratioDenominator: 1,
  ...over,
});

test("валидное событие SPLIT проходит", () => {
  assert.equal(validateEvent(valid()), true);
});

test("валидное DIVIDEND_ACCRUAL в raw-единицах проходит", () => {
  assert.equal(validateEvent(valid({
    type: "DIVIDEND_ACCRUAL",
    amountPerUnitRaw: 150_000, // 0.15 при 6 decimals
    decimals: 6,
  })), true);
});

test("MERGER требует новый минт, отличный от старого", () => {
  assert.equal(isValidEvent(valid({ type: "MERGER", newMint: "9BB7Tt5uW5QbAorLkF3Hn1P2mGcXvcDdR7y8LbT9KdUu" })), true);
  assert.equal(isValidEvent(valid({ type: "MERGER", newMint: MINT })), false);
});

test("MERGER-коэффициент обмена опционален, но если есть — целые положительные", () => {
  assert.equal(isValidEvent(valid({ type: "MERGER", newMint: "9BB7Tt5uW5QbAorLkF3Hn1P2mGcXvcDdR7y8LbT9KdUu", exchangeNumerator: 2, exchangeDenominator: 1 })), true);
  assert.equal(isValidEvent(valid({ type: "MERGER", newMint: "9BB7Tt5uW5QbAorLkF3Hn1P2mGcXvcDdR7y8LbT9KdUu", exchangeNumerator: 1.5, exchangeDenominator: 1 })), false);
  assert.equal(isValidEvent(valid({ type: "MERGER", newMint: "9BB7Tt5uW5QbAorLkF3Hn1P2mGcXvcDdR7y8LbT9KdUu", exchangeDenominator: 1 })), false);
});

test("TICKER_CHANGE должен менять символ", () => {
  assert.equal(isValidEvent(valid({ type: "TICKER_CHANGE", oldSymbol: "TSLAx", newSymbol: "TSLA2x" })), true);
  assert.equal(isValidEvent(valid({ type: "TICKER_CHANGE", oldSymbol: "TSLAx", newSymbol: "TSLAx" })), false);
});

test("REDEEM проходит без доп-полей, но с источником", () => {
  assert.equal(isValidEvent(valid({ type: "REDEEM" })), true);
  assert.equal(isValidEvent(valid({ type: "REDEEM", sources: [] })), false);
});

test("неизвестный тип отклоняется", () => {
  assert.equal(isValidEvent(valid({ type: "MOON_LANDING" })), false);
});

test("битый минт отклоняется", () => {
  assert.equal(isValidEvent(valid({ mint: "0OIlIl0OIl" })), false);
});

test("отрицательный/дробный коэффициент сплита отклоняется", () => {
  assert.equal(isValidEvent(valid({ ratioNumerator: 0 })), false);
  assert.equal(isValidEvent(valid({ ratioNumerator: 1.5 })), false);
});

test("дивиденд в float, а не raw-целом, отклоняется", () => {
  assert.equal(isValidEvent(valid({ type: "DIVIDEND_ACCRUAL", amountPerUnitRaw: 0.15, decimals: 6 })), false);
});

test("без источников событие не существует (анти-слух)", () => {
  assert.equal(isValidEvent(valid({ sources: undefined })), false);
});

test("ошибка валидации называет поле", () => {
  try {
    validateEvent(valid({ ratioNumerator: -3 }));
    assert.fail("должен был бросить");
  } catch (err) {
    assert.ok(err instanceof EventValidationError);
    assert.equal(err.field, "ratioNumerator");
  }
});

// ---- раунд 4: строгие даты (src/schema/isodate.mjs) ----
// Находки: Date.parse принимает мусор после схемной проверки формы и тихо
// «перекатывает» несуществующие даты. Схема — единственный барьер для
// журнал-реплея и xstocks-истории, поэтому валидация здесь, а не ниже.

// Батарея мусорных дат: находки ревью (месяц 13 / 00, 60-я секунда, оффсет 99:99),
// перекаты Date.parse, наивные datetime, нарушения формы.
const garbageDates = [
  "2026-13-01",                // месяц 13: Date.parse = NaN уже ПОСЛЕ схемной проверки
  "2026-00-10",                // месяц 00
  "2026-06-18T23:59:60Z",      // 60-я секунда (leap second) — не время
  "2026-06-18T12:00:00+99:99", // оффсет 99:99 проходит форму, Date.parse = NaN
  "2026-02-30",                // Date.parse перекатывает на 02.03
  "2026-06-31",                // перекат на 01.07
  "2027-02-29",                // не високосный — перекат на 01.03
  "2026-06-18T24:00:00Z",      // перекат на следующий день
  "2026-06-18T12:00:00",       // наивное время: парсилось бы локалью хоста
  "2026-06-18T12:00:00.500",   // наивное с долями — та же дыра
  "2026-1-1",                  // форма: без ведущих нулей
  "2026-02-29",                // 2026 не високосный
  "2026-06-18T12:60:00Z",      // минуты 60
  "2026-06-18T12:00:00+0200",  // оффсет без двоеточия — не канонический формат проекта
];

test("мусорные даты: параметризованная батарея отвергается схемой", () => {
  for (const bad of garbageDates) {
    assert.equal(isValidEvent(valid({ effectiveDate: bad })), false, `должна отвергаться: ${JSON.stringify(bad)}`);
  }
});

test("мусорная дата называется полем effectiveDate", () => {
  try {
    validateEvent(valid({ effectiveDate: "2026-02-30" }));
    assert.fail("перекат-дата должна была быть отвергнута");
  } catch (err) {
    assert.ok(err instanceof EventValidationError);
    assert.equal(err.field, "effectiveDate");
  }
});

// АНТИ-регрессия: канонические форматы (реальные продюсеры проекта) не должны
// начать отвергаться строгим валидатором.
const canonicalDates = [
  "2026-06-18",                  // date-only (витрина, /multiplier?date=)
  "2026-06-18T00:00:00Z",        // Z
  "2026-06-18T12:34:56Z",
  "2026-06-18T12:34:56.000Z",    // формат xstocks-фикстур и normalize-onchain (toISOString)
  "2026-06-18T12:34:56.5Z",      // одна доля секунды
  "2026-06-18T12:34:56.123456Z", // суб-мс доли в строке
  "2026-06-18T04:00Z",           // без секунд
  "2026-06-18T12:34:56+02:00",   // положительный оффсет
  "2026-06-18T12:34:56-05:30",   // отрицательный оффсет, нецелый час
  "2025-10-31T23:55:00.000Z",    // реальное событие SPYx из фикстуры
  "2028-02-29",                  // високосный день валиден
  "1970-01-01",
];

test("канонические форматы дат не отвергаются (анти-перегиб строгого валидатора)", () => {
  for (const good of canonicalDates) {
    assert.equal(validateEvent(valid({ effectiveDate: good })), true, `должна проходить: ${good}`);
  }
});

// ---- раунд 4: множитель «0» и кап точности ----

test("нулевой множитель не существует: «0», «0.0», «0.000» отвергаются, «0.5» валиден", () => {
  const mc = (over) => valid({ type: "MULTIPLIER_CHANGE", multiplierFrom: "1", multiplierTo: "1.005", ...over });
  for (const zero of ["0", "0.0", "0.000"]) {
    assert.equal(isValidEvent(mc({ multiplierTo: zero })), false, `multiplierTo=${zero} — позиция обнулилась бы молча`);
    assert.equal(isValidEvent(mc({ multiplierFrom: zero, multiplierTo: "1.005" })), false, `multiplierFrom=${zero}`);
  }
  assert.equal(isValidEvent(mc({ multiplierFrom: "0.5", multiplierTo: "1" })), true); // пол-множителя существует
});

test("кап дробной точности множителя 30 знаков — пара с timeline.mjs (decimalToRatio)", () => {
  const mc = (over) => valid({ type: "MULTIPLIER_CHANGE", multiplierFrom: "1", multiplierTo: "1.005", ...over });
  const m30 = "1." + "1".repeat(30);
  const m31 = "1." + "1".repeat(31);
  assert.equal(isValidEvent(mc({ multiplierTo: m30 })), true);
  assert.equal(isValidEvent(mc({ multiplierTo: m31 })), false);
});

// ---- раунд 4: инварианты фаззера (schema) ----

test("канонически валидные события всех 6 типов не отвергаются строгим валидатором", () => {
  const newMint = "9BB7Tt5uW5QbAorLkF3Hn1P2mGcXvcDdR7y8LbT9KdUu";
  const byType = {
    SPLIT: { ratioNumerator: 3, ratioDenominator: 1 },
    DIVIDEND_ACCRUAL: { amountPerUnitRaw: 150_000, decimals: 6 },
    MERGER: { newMint, exchangeNumerator: 2, exchangeDenominator: 1 },
    TICKER_CHANGE: { oldSymbol: "TSLAx", newSymbol: "TSLA2x" },
    REDEEM: {},
    MULTIPLIER_CHANGE: { multiplierFrom: "1", multiplierTo: "1.005", reason: "Dividend" },
  };
  // даты в форматах всех продюсеров проекта: date-only (витрина), .000Z (toISOString), Z (ручной ввод)
  for (const [type, extra] of Object.entries(byType)) {
    for (const date of ["2026-06-18", "2026-06-18T04:00:00.000Z", "2026-06-18T04:00Z"]) {
      assert.equal(validateEvent(valid({ type, effectiveDate: date, ...extra })), true, `${type} @ ${date}`);
    }
  }
});
