// Тесты производителя DIVIDEND_ACCRUAL из деклараций эмитента (src/events/dividends.mjs).
//
// Контекст (dividend-e2e, GAP 1): единственный нормализатор источников рождает
// только MULTIPLIER_CHANGE, даже для узлов с reason "Dividend". Исследование живого
// API (2026-09-22, фикстуры dividends-*.json) показало: в узлах истории множителей
// НЕТ суммы на единицу и payout-дат — только id/reason/multiplier/previousMultiplier/
// activationDateTime; эндпоинта /dividends нет (404), в карточке актива дивидендных
// полей нет. Поэтому производитель — вариант Б: контракт «декларация эмитента»,
// без какого-либо вывода суммы из множителя.
//
// Фикстуры dividends-*.json — ЖИВЫЕ ответы api.xstocks.fi, снятые при исследовании:
// они используются как пин честности («в реальных данных суммы нет — событие
// не синтезируется»), а не как источник событий.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dividendsFromDeclarations, DeclarationError } from "../src/events/dividends.mjs";
import * as dividendsModule from "../src/events/dividends.mjs";
import { bindMintAndValidate, NormalizeError } from "../src/events/normalize-xstocks.mjs";
import { validateEvent, EventValidationError } from "../src/schema/events.mjs";
import { applyEvents } from "../src/lots/lots.mjs";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

// Живые ответы эмитента, снятые 2026-09-22 (network=Solana)
const koxHistory = JSON.parse(readFileSync(path.join(dir, "dividends-kox-history-sol.json"), "utf8"));
const spyxHistory = JSON.parse(readFileSync(path.join(dir, "dividends-spyx-history-sol.json"), "utf8"));
const spyxAssetRoot = JSON.parse(readFileSync(path.join(dir, "dividends-spyx-asset-root.json"), "utf8"));

const MINT = "DividendMint" + "1".repeat(32); // 44 символа base58 (без 0/O/I/l), синтетика
const OWNER = "DividendAddr" + "1".repeat(32);

// ---- декларации ----

// KOx реально платит квартальные дивиденды (5 узлов "Dividend" в живой истории);
// суммы ниже — СИНТЕТИЧЕСКИЕ декларации для тестов контракта, не данные API.
const decl = (over = {}) => ({
  symbol: "KOx",
  exDate: "2026-09-15",
  amountPerUnitRaw: "410000", // $4.10 на токен при decimals 8, raw-строкой
  decimals: 8,
  sourceUrl: "https://issuer.example/ko-dividend-q3-2026",
  ...over,
});

const err = (fn, tag) => assert.throws(fn, DeclarationError, tag);

// ---- happy path ----

test("декларации → DIVIDEND_ACCRUAL: поля из декларации 1:1, сорт старые→новые", () => {
  const events = dividendsFromDeclarations([
    decl({ exDate: "2026-09-15T00:30:00.000Z" }),           // «новая» подана первой
    decl({ exDate: "2025-12-15", amountPerUnitRaw: 405000, sourceUrl: "https://issuer.example/ko-dividend-q4-2025" }),
    decl({ exDate: "2026-06-14T23:55:00Z", sourceUrl: "https://issuer.example/ko-dividend-q2-2026" }),
  ], { symbol: "KOx" });

  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.effectiveDate), [
    "2025-12-15",
    "2026-06-14T23:55:00Z",
    "2026-09-15T00:30:00.000Z",
  ]);
  for (const e of events) {
    assert.equal(e.type, "DIVIDEND_ACCRUAL");
    assert.equal(e.status, "confirmed"); // декларация = утверждение эмитента
    assert.equal(e.decimals, 8);
    assert.equal("mint" in e, false); // минт подставит bindMintAndValidate
    assert.equal("reason" in e, false); // reason — признак узлов множителя, тут его нет
  }
  assert.equal(events[0].amountPerUnitRaw, 405000); // число-вход остаётся числом
  assert.equal(events[2].amountPerUnitRaw, 410000); // строка-вход «410000» → то же целое
  assert.deepEqual(events[2].sources, ["https://issuer.example/ko-dividend-q3-2026"]); // как прислали
});

test("события проходят bindMintAndValidate и схему; вход не мутируется", () => {
  const input = [decl(), decl({ exDate: "2026-06-14" })];
  const snapshot = JSON.stringify(input);
  const bound = bindMintAndValidate(dividendsFromDeclarations(input, { symbol: "KOx" }), MINT);

  assert.equal(bound.length, 2);
  for (const e of bound) {
    assert.equal(e.mint, MINT);
    assert.equal(validateEvent(e), true); // двойная проверка напрямую схемой
  }
  assert.equal(JSON.stringify(input), snapshot); // декларации не тронуты
});

test("produced event двигает движок лотов: totalRaw = amount × qty (стык с lots.mjs)", () => {
  const [e] = bindMintAndValidate(dividendsFromDeclarations([decl()], { symbol: "KOx" }), MINT);
  const { accruals, applied } = applyEvents([{
    id: "L1", mint: MINT, owner: OWNER, qtyRaw: 100_000_000n, acquiredDate: "2026-09-01", basisRaw: 1n,
  }], [e]);
  assert.equal(applied, 1);
  assert.equal(accruals.length, 1);
  assert.equal(accruals[0].totalRaw, 410000n * 100_000_000n); // raw × raw, BigInt
});

// ---- границы количества ----

test("amountPerUnitRaw: 0, -1, float, мусор-строки, NaN/Infinity, выше MAX_SAFE — все в DeclarationError", () => {
  for (const bad of [
    0, -1, 1.5, -0.0001, NaN, Infinity, -Infinity,
    "", "abc", "-1", "4.10", " 410000", "410000 ", "1e6", "+1", "0x10", "десять",
    null, undefined, true, {}, ["410000"],
    "10000000000000000000",  // строка выше Number.MAX_SAFE_INTEGER — Number(bi) потерял бы точность
    1e21,                    // целое number, но вне safe-диапазона схемы
  ]) {
    err(() => dividendsFromDeclarations([decl({ amountPerUnitRaw: bad })], { symbol: "KOx" }),
      `amountPerUnitRaw=${JSON.stringify(bad)}`);
  }
});

test("amountPerUnitRaw: границы safe-диапазона — MAX_SAFE проходит, MAX_SAFE+1 нет", () => {
  const ok = dividendsFromDeclarations([decl({ amountPerUnitRaw: Number.MAX_SAFE_INTEGER })], { symbol: "KOx" });
  assert.equal(ok[0].amountPerUnitRaw, 9007199254740991); // точно, без потери точности
  err(() => dividendsFromDeclarations([decl({ amountPerUnitRaw: "9007199254740992" })], { symbol: "KOx" }));
});

test("decimals: вне 0..18, float, мусор — отклонены; границы 0 и 18 валидны; строки-цифры ок", () => {
  for (const bad of [-1, 19, 1.5, "8.5", "abc", "", null, undefined, true, {}, "100000000000000000000"]) {
    err(() => dividendsFromDeclarations([decl({ decimals: bad })], { symbol: "KOx" }), `decimals=${JSON.stringify(bad)}`);
  }
  for (const good of [0, 18, "0", "18"]) {
    const [e] = dividendsFromDeclarations([decl({ decimals: good })], { symbol: "KOx" });
    assert.equal(e.decimals, Number(good), `decimals=${JSON.stringify(good)}`);
  }
});

// ---- форматы exDate ----

test("exDate: канонические ISO-формы принимаются и ложатся в effectiveDate как есть", () => {
  for (const good of ["2026-09-15", "2026-09-15T00:00:00Z", "2026-09-15T14:30:00+02:00", "2026-09-15T00:30:00.000Z"]) {
    const [e] = dividendsFromDeclarations([decl({ exDate: good })], { symbol: "KOx" });
    assert.equal(e.effectiveDate, good, good);
  }
});

test("exDate: мусорные форматы — DeclarationError ДО движения в движок (батарея)", () => {
  for (const bad of [
    "2026-02-30",            // перекат-дата (Date.parse молча перенёс бы на март)
    "2026-13-01",
    "2026-9-15",             // не каноническая форма
    "2026-09-15T12:00:00",   // наивное время = локаль хоста
    "09/15/2026",
    "15-09-2026",
    "20260915",
    20260915,                // число вместо строки
    null, undefined, true, {}, [],
    "",
  ]) {
    err(() => dividendsFromDeclarations([decl({ exDate: bad })], { symbol: "KOx" }), `exDate=${JSON.stringify(bad)}`);
  }
});

// ---- фильтр по символу ----

test("ctx.symbol: обязателен; чужие символы скипаются, своё ловится без учёта регистра", () => {
  err(() => dividendsFromDeclarations([decl()], {}), "нет ctx.symbol");
  err(() => dividendsFromDeclarations([decl()], { symbol: "" }), "пустой ctx.symbol");
  err(() => dividendsFromDeclarations([decl()], { symbol: 42 }), "не-строка ctx.symbol");
  err(() => dividendsFromDeclarations("не-массив", { symbol: "KOx" }), "не-массив деклараций");

  const mixed = [
    decl({ symbol: "JPMx", sourceUrl: "https://issuer.example/jpm" }),
    decl({ sourceUrl: "https://issuer.example/ko-a" }),
    decl({ symbol: "kox", exDate: "2026-06-14", sourceUrl: "https://issuer.example/ko-b" }), // другой регистр
  ];
  const events = dividendsFromDeclarations(mixed, { symbol: "KOx" });
  assert.equal(events.length, 2); // JPMx скипнут, "KOx" и "kox" взяты
  assert.deepEqual(events.map((e) => e.sources[0]), [
    "https://issuer.example/ko-b",
    "https://issuer.example/ko-a",
  ]);
});

test("декларация без symbol / с не-строкой — брак подачи: громкая ошибка, не тихий скип", () => {
  err(() => dividendsFromDeclarations([{ exDate: "2026-09-15", amountPerUnitRaw: 1, decimals: 8, sourceUrl: "https://x.example/a" }], { symbol: "KOx" }));
  err(() => dividendsFromDeclarations([decl({ symbol: 42 })], { symbol: "KOx" }));
  err(() => dividendsFromDeclarations([null], { symbol: "KOx" }));
  err(() => dividendsFromDeclarations(["2026-09-15"], { symbol: "KOx" }));
});

// ---- источники и дедуп ----

test("sourceUrl: отсутствующий/короткий/не-строка — DeclarationError; валидный ложится в sources дословно", () => {
  for (const bad of [undefined, null, "", "ab", "  ", 42, {}]) {
    err(() => dividendsFromDeclarations([decl({ sourceUrl: bad })], { symbol: "KOx" }), `sourceUrl=${JSON.stringify(bad)}`);
  }
  const [e] = dividendsFromDeclarations([decl({ sourceUrl: "doc:R25 п.3" })], { symbol: "KOx" }); // не URL — но ссылка
  assert.deepEqual(e.sources, ["doc:R25 п.3"]);
});

test("точный дубликат декларации схлопнут (повтор подачи не удваивает начисление), близкий — нет", () => {
  const dup = [decl(), JSON.parse(JSON.stringify(decl()))]; // глубокая копия — то же содержимое
  assert.equal(dividendsFromDeclarations(dup, { symbol: "KOx" }).length, 1);

  // другой sourceUrl при прочих равных — сознательно НЕ схлопывается: без id в
  // декларации «повтор» от «второго объявления» не отличить (трейд-офф модуля)
  const near = [decl(), decl({ sourceUrl: "https://issuer.example/ko-dividend-q3-mirror" })];
  assert.equal(dividendsFromDeclarations(near, { symbol: "KOx" }).length, 2);
});

// ---- пины честности: реальный API не содержит суммы → событие НЕ синтезируется ----

test("ПИН: живые узлы 'Dividend' эмитента НЕ декларации — производитель их отвергает, не выдумывает сумму", () => {
  // В живой истории KOx 5 узлов reason "Dividend" с реальными дельтами множителя —
  // и ни одного поля суммы/экс-даты выплаты. Подача узлов как деклараций обязана
  // падать: у узла нет ни amountPerUnitRaw, ни sourceUrl.
  assert.equal(koxHistory.nodes.length, 5);
  assert.ok(koxHistory.nodes.every((n) => n.reason === "Dividend"));
  err(() => dividendsFromDeclarations(koxHistory.nodes, { symbol: "KOx" }));
  err(() => dividendsFromDeclarations(spyxHistory.nodes, { symbol: "SPYx" }));
});

test("ПИН: у живых дивидендных узлов ровно 5 полей — суммы и payout-дат в данных эмитента нет", () => {
  for (const n of [...koxHistory.nodes, ...spyxHistory.nodes]) {
    assert.deepEqual(Object.keys(n).sort(), ["activationDateTime", "id", "multiplier", "previousMultiplier", "reason"]);
    // значит, вывести amountPerUnitRaw неоткуда — ни одного числового кандидата
    assert.equal("amount" in n, false);
    assert.equal("amountPerUnit" in n, false);
    assert.equal("dividendPerShare" in n, false);
  }
});

test("ПИН: карточка актива не содержит дивидендных/NAV-полей (рекурсивный скан живого ответа)", () => {
  const keys = [];
  (function walk(o, p = "") {
    for (const [k, v] of Object.entries(o)) {
      keys.push(p + k);
      if (v && typeof v === "object" && !Array.isArray(v)) walk(v, p + k + ".");
    }
  })(spyxAssetRoot);
  assert.equal(keys.filter((k) => /div|nav|yield|amount|cash|distribution/i.test(k)).length, 0);
});

test("ПИН: в модуле нет синтезатора «множитель → дивиденд» — экспорт исчерпывается контрактом деклараций", () => {
  assert.deepEqual(Object.keys(dividendsModule).sort(), ["DeclarationError", "dividendsFromDeclarations"]);
});

// ---- стык с существующим конвейером ----

test("bindMintAndValidate оборачивает схемную ошибку в NormalizeError — контракт един с xstocks-путём", () => {
  // Производитель не пропустит мусор, но контракт привязки проверяем независимо:
  // подделать событие мимо производителя и скормить bindMintAndValidate — громко.
  const forged = [{ type: "DIVIDEND_ACCRUAL", effectiveDate: "2026-09-15", status: "confirmed",
    sources: ["https://x.example/a"], amountPerUnitRaw: 1.5, decimals: 8 }];
  assert.throws(() => bindMintAndValidate(forged, MINT), NormalizeError);
  // и напрямую схемой — EventValidationError
  assert.throws(() => validateEvent({ ...forged[0], mint: MINT }), EventValidationError);
});
