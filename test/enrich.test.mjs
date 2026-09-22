// Юнит-тесты конвейера обогащения decimals (enrich-decimals).
// Разбор кода: scripts/enrich-decimals.mjs — тонкая top-level обёртка: сам делает
// fetch на lite-api.jup.ag/price/v3 (URL захардкожен, fetcher не инжектится, при
// импорте скрипт сразу лезет в сеть и читает data/tokens.json) — поэтому в тесты
// он НЕ импортируется. Вся логика живёт в src/registry/enrich.mjs: она принимает
// УЖЕ распарсенный батч-ответ Jupiter как аргумент prices — это и есть шов для
// моков (никаких сетевых вызовов; инжект — чистыми данными + временный файл).
// Источник — Jupiter Price API v3, форма ответа Record<mint, {usdPrice, blockId,
// decimals, priceChange24h}>: обогащение обязано потреблять только поле decimals.
// Числовая валидация (null | integer 0..18) выполняется НА ВХОДЕ enrich: мусор от
// API (отрицательные, >18, не-целые, не-числа) не доходит до файла — запись не
// трогается, символ уходит в skipped с причиной "invalid-decimals"; null/undefined
// в ответе единообразно «нет значения». validateRegistryEntry в registry.mjs —
// второй рубеж на загрузке (осознанное изменение контракта: раньше enrich писал
// как есть, и мусорная запись эмитента клала весь реестр в corrupted-режим).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyJupiterDecimals, enrichDecimalsFile } from "../src/registry/enrich.mjs";
import { validateRegistryEntry, loadRegistrySafe, RegistryError } from "../src/registry/registry.mjs";

const freshDir = () => mkdtempSync(path.join(tmpdir(), "lotwise-enrich-"));
const fullJson = (list) => JSON.stringify(list, null, 1) + "\n"; // формат atomicWriteJson

// Реальные минты из data/tokens.json (валидный base58 — чтобы цепочка проходила
// через validateRegistryEntry/loadRegistrySafe без изменений)
const SPYX = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const AAPLX = "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp";
const NVDA = "9BB7Tt5uW5QbAorLkF3Hn1P2mGcXvcDdR7y8LbT9KdUu";

const token = (mint, symbol, decimals = null) => ({
  mint,
  symbol,
  name: `${symbol} Tokenized`,
  issuer: "backed",
  decimals,
});

// Реалистичная запись батч-ответа Jupiter v3: enrich обязан взять только decimals
const jup = (decimals) => ({ usdPrice: 123.45, blockId: 31415926, decimals, priceChange24h: -0.42 });

// ---- успешное обогащение из ответа Jupiter ----

test("успешное обогащение: decimals из батч-ответа Jupiter v3, лишние поля ответа игнорируются", () => {
  const list = [token(SPYX, "SPYx"), token(AAPLX, "AAPLx"), token(NVDA, "NVDAx")];
  const r = applyJupiterDecimals(list, {
    [SPYX]: jup(8),
    [AAPLX]: jup(6),
    // NVDAx Jupiter не знает: остаётся с decimals=null
  });
  assert.equal(r.filled, 2);
  assert.deepEqual(r.unknown, ["NVDAx"], "unknown — символы, а не минты");
  assert.deepEqual(r.skipped, [], "все значения валидны — отклонённых нет");
  assert.equal(list[0].decimals, 8);
  assert.equal(list[1].decimals, 6);
  assert.equal(list[0].usdPrice, undefined, "только decimals потребляется, остальной мусор ответа в запись не течёт");
  // нетронутая запись не изменилась вообще (никаких sourceDecimals/undefined-хвостов)
  assert.deepEqual(list[2], token(NVDA, "NVDAx"));
});

test("sourceDecimals — строка-метка источника: у заполненных ровно 'jupiter', чужие метки не перезатираются", () => {
  const list = [
    token(SPYX, "SPYx"),
    token(AAPLX, "AAPLx"),
    { ...token(NVDA, "NVDAx", 9), sourceDecimals: "rpc" }, // метка из ручного прохода, как в живом data/tokens.json
  ];
  const r = applyJupiterDecimals(list, { [SPYX]: jup(8), [AAPLX]: jup(6), [NVDA]: jup(42) });
  assert.equal(r.filled, 2, "заполненных (новых) — двое, запись с 'rpc' уже обогащена");
  assert.deepEqual(r.skipped, [], "уже обогащённая запись игнорируется целиком: мусор (42) в её части ответа — не повод для skipped");
  for (const t of [list[0], list[1]]) {
    assert.equal(typeof t.sourceDecimals, "string");
    assert.equal(t.sourceDecimals, "jupiter", "метка источника консистентна у всех, кого заполнил enrich");
  }
  assert.equal(list[2].decimals, 9, "уже обогащённая запись: decimals не перезатёрты");
  assert.equal(list[2].sourceDecimals, "rpc", "чужая метка источника сохранена");
});

// ---- идемпотентность повторного прогона ----

test("идемпотентность: повторный прогон по обогащённому файлу — filled=0, written=false, файл байт в байт", () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  writeFileSync(p, fullJson([token(SPYX, "SPYx"), token(AAPLX, "AAPLx")]));
  const first = enrichDecimalsFile(p, { [SPYX]: jup(8), [AAPLX]: jup(6) });
  assert.equal(first.filled, 2);
  assert.equal(first.written, true);
  const afterFirst = readFileSync(p, "utf8");
  // второй прогон с ДРУГИМИ значениями в ответе: перезаписывать уже обогащённое нельзя
  const second = enrichDecimalsFile(p, { [SPYX]: jup(9), [AAPLX]: jup(7) });
  assert.equal(second.filled, 0, "заполняются только записи с decimals === null");
  assert.equal(second.written, false, "нечего писать — файл не открывается на запись вовсе");
  assert.deepEqual(second.unknown, []);
  assert.deepEqual(second.skipped, [], "уже обогащённые записи не проходят валидацию повторно");
  assert.equal(readFileSync(p, "utf8"), afterFirst, "файл байт в байт, значения первого прогона живы");
  const list = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(list[0].decimals, 8);
  assert.equal(list[0].sourceDecimals, "jupiter");
  assert.deepEqual(readdirSync(dir), ["tokens.json"], "без tmp-мусора: записи-то и не было");
});

// ---- ошибки файла реестра: понятная ошибка, а не порча ----

test("битый JSON реестра — SyntaxError до всякой записи, файл не портится", () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  const torn = fullJson([token(SPYX, "SPYx")]).slice(0, 40); // как после kill в окне записи
  writeFileSync(p, torn);
  assert.throws(() => enrichDecimalsFile(p, { [SPYX]: jup(8) }), SyntaxError);
  assert.equal(readFileSync(p, "utf8"), torn, "обогащение упало ДО записи — усечённый файл не дописан и не заменён");
  assert.deepEqual(readdirSync(dir), ["tokens.json"]);
});

test("файла реестра нет — бросает, ничего не создаёт", () => {
  const dir = freshDir();
  const p = path.join(dir, "нет-файла.json");
  assert.throws(() => enrichDecimalsFile(p, { [SPYX]: jup(8) }));
  assert.deepEqual(readdirSync(dir), [], "молча создавать реестр обогащение не имеет права");
});

// ---- неожиданная форма ответа Jupiter ----

test("неожиданная форма ответа не роняет обогащение и не портит записи", () => {
  const list = () => [token(SPYX, "SPYx"), token(AAPLX, "AAPLx")];

  // ответа нет вовсе (null/undefined распарсенного JSON)
  let r = applyJupiterDecimals(list(), null);
  assert.equal(r.filled, 0);
  assert.deepEqual(r.unknown, ["SPYx", "AAPLx"]);
  assert.deepEqual(r.skipped, []);
  assert.ok(r.filled === 0 && list().every((t) => t.decimals === null));

  // ответ — массив (ключей по минтам нет)
  r = applyJupiterDecimals(list(), []);
  assert.equal(r.filled, 0);
  assert.deepEqual(r.unknown, ["SPYx", "AAPLx"]);

  // запись ответа — не объект (строка/число): охрана «нет значения» спасает
  r = applyJupiterDecimals(list(), { [SPYX]: "oops", [AAPLX]: 42 });
  assert.equal(r.filled, 0);
  assert.equal(r.unknown.length, 0, "факт: ключ есть — в unknown минт не попадает, но и заполнить нечего");
  assert.deepEqual(r.skipped, [], "undefined в ответе — «нет значения», а не мусор");
  const l = list();
  applyJupiterDecimals(l, { [SPYX]: "oops" });
  assert.equal(l[0].decimals === null, true, "мусорное значение ответа не записывается в decimals");

  // запись есть, поля decimals нет — минт «известен», но заполнять нечем
  r = applyJupiterDecimals(list(), { [SPYX]: { usdPrice: 1.5 }, [AAPLX]: {} });
  assert.equal(r.filled, 0);
  assert.deepEqual(r.unknown, []);
  assert.deepEqual(r.skipped, []);
});

test("decimals:null и undefined в ответе Jupiter единообразно — «нет значения»: запись не тронута, метка не ставится", () => {
  for (const noValue of [null, undefined]) {
    const list = [token(SPYX, "SPYx")];
    const r = applyJupiterDecimals(list, { [SPYX]: { usdPrice: 100, decimals: noValue } });
    // раньше null ошибочно считался значением: filled тикал и лепилась метка 'jupiter'
    assert.equal(r.filled, 0, `decimals=${noValue} — не заполнение`);
    assert.deepEqual(r.skipped, [], "отсутствие значения — не мусор, в skipped не попадает");
    assert.deepEqual(list[0], token(SPYX, "SPYx"), "запись байт в байт: ни undefined-хвостов, ни sourceDecimals");
  }
});

// ---- некорректные decimals: валидация НА ВХОДЕ, контракт 0..18 ----

test("мусорные decimals от Jupiter (отрицательные, >18, не-целые, не-числа) не записываются: запись не тронута, символ в skipped", () => {
  for (const bad of [-1, 19, 6.5, "8", NaN]) {
    const list = [token(SPYX, "SPYx")];
    const r = applyJupiterDecimals(list, { [SPYX]: jup(bad) });
    assert.equal(r.filled, 0, `decimals=${bad} не должен тикать filled`);
    assert.deepEqual(r.skipped, [{ symbol: "SPYx", reason: "invalid-decimals" }], `decimals=${bad} — отклонён с причиной`);
    assert.deepEqual(list[0], token(SPYX, "SPYx"), "запись не тронута: decimals остаётся null, метки нет");
    // запись, которую enrich не тронул, остаётся валидной для реестра (второй рубеж не нужен)
    assert.ok(validateRegistryEntry(list[0]));
  }
});

test("границы контракта 0 и 18 записываются; смешанный прогон: валидные заполнены, мусорный — в skipped", () => {
  const list = [token(SPYX, "SPYx"), token(AAPLX, "AAPLx"), token(NVDA, "NVDAx")];
  const r = applyJupiterDecimals(list, { [SPYX]: jup(0), [AAPLX]: jup(18), [NVDA]: jup(19) });
  assert.equal(r.filled, 2);
  assert.equal(list[0].decimals, 0, "граница 0 — валидное значение");
  assert.equal(list[0].sourceDecimals, "jupiter");
  assert.equal(list[1].decimals, 18, "граница 18 — валидное значение");
  assert.deepEqual(r.skipped, [{ symbol: "NVDAx", reason: "invalid-decimals" }]);
  assert.equal(list[2].decimals, null, "мусорная запись не тронута");
});

test("сквозная цепочка: мусорный decimals от Jupiter не доходит до файла — реестр не падает в corrupted", async () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  writeFileSync(p, fullJson([token(SPYX, "SPYx")]));
  const before = readFileSync(p, "utf8");
  const r = enrichDecimalsFile(p, { [SPYX]: jup(42) }); // Jupiter отдал 42 — enrich отклоняет
  assert.equal(r.filled, 0);
  assert.equal(r.written, false, "заполнять нечего (всё в skipped) — файл не открывается на запись");
  assert.deepEqual(r.skipped, [{ symbol: "SPYx", reason: "invalid-decimals" }]);
  assert.equal(readFileSync(p, "utf8"), before, "файл байт в байт — мусор не попал в реестр");
  const boot = await loadRegistrySafe(p);
  // раньше enrich записал бы 42, и одна мусорная запись эмитента клала весь реестр в corrupted
  assert.equal(boot.ok, true, "реестр здоров: валидация на входе закрыла путь к corrupted");
  assert.equal(boot.corrupted, false);
  assert.deepEqual(boot.registry.map((t) => t.decimals), [null]);
});

test("enrichDecimalsFile: только skipped без filled — файл не перезаписан, skipped доходит до вызывающего", () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  writeFileSync(p, fullJson([token(SPYX, "SPYx"), token(AAPLX, "AAPLx")]));
  const before = readFileSync(p, "utf8");
  const r = enrichDecimalsFile(p, { [SPYX]: jup(6.5), [AAPLX]: jup(-3) });
  assert.equal(r.filled, 0);
  assert.equal(r.written, false);
  assert.deepEqual(r.skipped, [
    { symbol: "SPYx", reason: "invalid-decimals" },
    { symbol: "AAPLx", reason: "invalid-decimals" },
  ]);
  assert.equal(readFileSync(p, "utf8"), before);
  assert.deepEqual(readdirSync(dir), ["tokens.json"], "без tmp-мусора: записи-то и не было");
});

test("enrichDecimalsFile: смешанный прогон — валидные заполняются и пишутся атомарно, мусорные в файл не текут", () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  writeFileSync(p, fullJson([token(SPYX, "SPYx"), token(AAPLX, "AAPLx")]));
  const r = enrichDecimalsFile(p, { [SPYX]: jup(8), [AAPLX]: jup(6.5) });
  assert.equal(r.filled, 1);
  assert.equal(r.written, true);
  assert.deepEqual(r.skipped, [{ symbol: "AAPLx", reason: "invalid-decimals" }]);
  const list = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(list[0].decimals, 8);
  assert.equal(list[0].sourceDecimals, "jupiter");
  assert.equal(list[1].decimals, null, "мусор не записан — запись в исходном виде");
  assert.equal(list[1].sourceDecimals, undefined);
  // второй рубеж на месте: если мусор всё же просочится в файл иным путём, валидатор его отбивает
  assert.throws(
    () => validateRegistryEntry({ ...list[1], decimals: 42 }),
    (err) => err instanceof RegistryError && /decimals/.test(err.message),
  );
});


// ---- согласованность живого реестра с контрактом enrich ----

test("реальный data/tokens.json согласован: у каждой записи sourceDecimals — непустая строка-метка, decimals — integer", () => {
  const registryPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "tokens.json");
  const list = JSON.parse(readFileSync(registryPath, "utf8"));
  assert.ok(list.length >= 20, `ожидали >=20 токенов, получили ${list.length}`);
  for (const t of list) {
    assert.equal(typeof t.sourceDecimals, "string", `${t.symbol}: метка источника обязана быть строкой`);
    assert.ok(t.sourceDecimals.length > 0, `${t.symbol}: пустая метка источника`);
    assert.ok(Number.isInteger(t.decimals), `${t.symbol}: decimals=${t.decimals}, ожидаем integer после enrich`);
    // метка 'jupiter' совместима с реальными значениями (в живом файле 6..9)
    assert.ok(t.decimals >= 0 && t.decimals <= 18, `${t.symbol}: decimals=${t.decimals} вне контракта 0..18`);
  }
});
