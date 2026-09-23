// Регрессионные тесты раунда 7 ревью Lotwise — «ядро честности».
// Находки ROUND7:
//   №3 (schema/events.mjs): ZERO_MULTIPLIER_RE /^0(\.0+)?$/ ловил только каноническую
//       запись нуля — «00»/«000»/«00.0» проходили схему (при этом «0.0» и «0.00»
//       отказывались): валидный шаг 1→«00» молча обнулял позицию (scaledQty → 0 exact).
//   №11 (events/crosscheck.mjs): crossCheckMultiplierChange без дегенеративных гвардов —
//       before.c=0 давал observedRatio=Infinity → строгий «mismatch»; мусорный множитель
//       → NaN → «mismatch»; JSON сериализует Infinity/NaN как null — вердикт выглядел
//       обоснованным. Сиблинг crossCheckDividendAccrual гварды имеет (rawPrev<=0 →
//       inconclusive, мусор → CrossCheckError) — асимметрия.
//   №12 (events/dividends.mjs): дедуп по сырому exDate — «2026-06-18» и
//       «2026-06-18T00:00:00Z» (один момент) давали ДВА DIVIDEND_ACCRUAL, движок
//       начислял дважды. Ключ дедупа обязан быть инстантом.
import test from "node:test";
import assert from "node:assert/strict";
import { validateEvent } from "../src/schema/events.mjs";
import { crossCheckMultiplierChange, CrossCheckError } from "../src/events/crosscheck.mjs";
import { dividendsFromDeclarations } from "../src/events/dividends.mjs";

const MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";

const multEvent = (from, to) => ({
  type: "MULTIPLIER_CHANGE", mint: MINT,
  effectiveDate: "2026-06-18T00:00:00.000Z", status: "confirmed",
  sources: ["test:round7"], multiplierFrom: from, multiplierTo: to,
  reason: "On-chain rebase",
});

// ---- ROUND7 №3: нулевой множитель в любой записи ----

test("schema: нулевой множитель в ЛЮБОЙ записи («00», «000», «00.0», «0.00») отвергается", () => {
  for (const zero of ["0", "00", "000", "00.0", "0.00", "0.0000"]) {
    assert.throws(
      () => validateEvent(multEvent("1", zero)),
      (err) => err.name === "EventValidationError" && /must be positive/.test(err.message),
      `multiplierTo="${zero}" должен быть отвергнут`,
    );
    assert.throws(
      () => validateEvent(multEvent(zero, "5")),
      (err) => err.name === "EventValidationError" && /must be positive/.test(err.message),
      `multiplierFrom="${zero}" должен быть отвергнут`,
    );
  }
});

test("schema: после ужесточения нуля — «0.5» и «5» по-прежнему валидны (нуль ≠ малость)", () => {
  assert.doesNotThrow(() => validateEvent(multEvent("1", "0.5")));
  assert.doesNotThrow(() => validateEvent(multEvent("0.5", "5")));
});

// ---- ROUND7 №11: дегенеративные гварды crossCheckMultiplierChange ----

// честные свечи вокруг 2026-06-18: after-свеча = та, что ЗАКРЫВАЕТСЯ после события
// (свеча 18-го), её close и несёт post-событие — сплит 1→2 = 100 → 50
const candles = [
  { ts: Date.UTC(2026, 5, 16) / 1000, c: 100 },
  { ts: Date.UTC(2026, 5, 17) / 1000, c: 100 },
  { ts: Date.UTC(2026, 5, 18) / 1000, c: 50 },
  { ts: Date.UTC(2026, 5, 19) / 1000, c: 50 },
  { ts: Date.UTC(2026, 5, 20) / 1000, c: 50 },
];

test("crosscheck: вырожденная цена пула (close <= 0) — inconclusive, а не mismatch c Infinity", () => {
  const degenerate = candles.map((c, i) => (i === 1 ? { ...c, c: 0 } : c)); // before.c = 0
  const v = crossCheckMultiplierChange(multEvent("1", "2"), degenerate);
  assert.equal(v.verdict, "inconclusive");
  assert.equal(v.observedRatio, null); // не Infinity, который JSON молча превращает в null
  assert.match(v.note, /unusable|non-positive/i); // раунд 10: формулировка расширена на нечисловые close

  const negative = candles.map((c, i) => (i === 1 ? { ...c, c: -3 } : c));
  const v2 = crossCheckMultiplierChange(multEvent("1", "2"), negative);
  assert.equal(v2.verdict, "inconclusive");
});

test("crosscheck: мусорные строки множителя — CrossCheckError, а не «mismatch» с NaN", () => {
  assert.throws(
    () => crossCheckMultiplierChange(multEvent("abc", "2"), candles),
    (err) => err instanceof CrossCheckError && /multiplier/i.test(err.message),
  );
  assert.throws(
    () => crossCheckMultiplierChange({ ...multEvent("1", "2"), multiplierTo: null }, candles),
    (err) => err instanceof CrossCheckError,
  );
});

test("crosscheck: живые входы считают как раньше — консистентный сплит 1→2 остаётся consistent", () => {
  const v = crossCheckMultiplierChange(multEvent("1", "2"), candles);
  assert.equal(v.verdict, "consistent"); // 100 → 50 = ровно ожидание from/to
  assert.ok(Number.isFinite(v.observedRatio));
});

// ---- ROUND7 №12: дедуп дивидендов по моменту, а не по строке ----

test("dividends: эквивалентные канонические даты («2026-06-18» vs «…T00:00:00Z») — ОДНО событие", () => {
  const decl = (exDate) => ({
    symbol: "KOx", exDate, amountPerUnitRaw: 2500000, decimals: 8,
    sourceUrl: "https://issuer.example/ko/dividends",
  });
  const out = dividendsFromDeclarations(
    [decl("2026-06-18"), decl("2026-06-18T00:00:00Z"), decl("2026-06-18")],
    { symbol: "KOx" },
  );
  assert.equal(out.length, 1, "один и тот же момент = одно начисление, не два");
  assert.equal(out[0].amountPerUnitRaw, 2500000);
});

test("dividends: разные источники одной даты по-прежнему НЕ схлопываются (задокументированный трейд-офф)", () => {
  const decl = (sourceUrl) => ({
    symbol: "KOx", exDate: "2026-06-18", amountPerUnitRaw: 2500000, decimals: 8, sourceUrl,
  });
  const out = dividendsFromDeclarations(
    [decl("https://a.example/x"), decl("https://b.example/y")],
    { symbol: "KOx" },
  );
  assert.equal(out.length, 2);
});

test("dividends: разные ДАТЫ — по-прежнему разные события (дедуп не перегнут)", () => {
  const decl = (exDate) => ({
    symbol: "KOx", exDate, amountPerUnitRaw: 2500000, decimals: 8,
    sourceUrl: "https://issuer.example/ko/dividends",
  });
  const out = dividendsFromDeclarations(
    [decl("2026-06-18"), decl("2026-09-17"), decl("2026-06-18T00:00:00+00:00")],
    { symbol: "KOx" },
  );
  assert.equal(out.length, 2);
});
