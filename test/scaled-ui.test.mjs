import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseScaledUiAmount, reconcileMultiplier, ScaledUiError } from "../src/issuer/scaled-ui.mjs";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

// ЖИВОЙ ответ mainnet для минта SPYx (18.09.2026): active 1.0039…, pending 1.0057… c 18.06
const live = JSON.parse(readFileSync(path.join(dir, "onchain-spyx-mint.json"), "utf8")).result.value;

test("живой on-chain SPYx: extension распарсен, оба множителя и дата активации", () => {
  const m = parseScaledUiAmount(live);
  assert.equal(m.hasExtension, true);
  assert.equal(m.decimals, 8);
  assert.equal(m.activeMultiplier, "1.003909240011759");
  assert.equal(m.pendingMultiplier, "1.005714560286254");
  assert.equal(m.pendingEffectiveDate, "2026-06-18T04:00:00.000Z");
  assert.equal(m.program, "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
  assert.equal(typeof m.authority, "string");
});

test("токен без scaledUiAmountConfig = множитель 1, hasExtension false", () => {
  const plain = { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { parsed: { info: { decimals: 6, extensions: [{ extension: "mintCloseAuthority" }] } } } };
  const m = parseScaledUiAmount(plain);
  assert.deepEqual(
    { activeMultiplier: m.activeMultiplier, pendingMultiplier: m.pendingMultiplier, hasExtension: m.hasExtension },
    { activeMultiplier: "1", pendingMultiplier: null, hasExtension: false },
  );
});

test("не-минт аккаунт даёт понятную ошибку", () => {
  assert.throws(() => parseScaledUiAmount({ data: {} }), ScaledUiError);
  assert.throws(() => parseScaledUiAmount(undefined), ScaledUiError);
});

test("РЕАЛЬНЫЙ КЕЙС: API-план (1.0057) vs on-chain (active 1.0039, effective 1.0057) на 18.09", () => {
  const onChain = parseScaledUiAmount(live);
  const r = reconcileMultiplier("1.005714560286254", onChain, "2026-09-18T00:00:00.000Z");
  // pending уже должен был активироваться 18.06 → эффективный совпадает с API → ok
  assert.equal(r.onChainEffective, "1.005714560286254");
  assert.equal(r.verdict, "ok");
});

test("до активации pending: эффективный = active; расхождение с API видно", () => {
  const onChain = parseScaledUiAmount(live);
  const before = reconcileMultiplier("1.005714560286254", onChain, "2026-06-01T00:00:00.000Z");
  assert.equal(before.onChainEffective, "1.003909240011759");
  assert.equal(before.verdict, "planes-disagree"); // API уже перешёл, цепь ещё нет — ловим
  const matched = reconcileMultiplier("1.003909240011759", onChain, "2026-06-01T00:00:00.000Z");
  assert.equal(matched.verdict, "ok");
});

// ---- раунд-2: свертка планов на границе дат ----

test("pending активируется В ДЕНЬ своей даты даже date-only запросом", () => {
  const onChain = {
    activeMultiplier: "1.003909240011759",
    pendingMultiplier: "1.005714560286254",
    pendingEffectiveDate: "2026-06-18T00:00:00.000Z",
    pendingTs: null, authority: null, hasExtension: true,
  };
  // до фикса строковое сравнение считало pending неактивным ровно в день активации
  const r = reconcileMultiplier("1.005714560286254", onChain, "2026-06-18");
  assert.equal(r.onChainEffective, "1.005714560286254");
  assert.equal(r.verdict, "ok");
});

test("мусорная дата свертки — ScaledUiError, а не тихое сравнение строк", () => {
  assert.throws(
    () => reconcileMultiplier("1", { activeMultiplier: "1", pendingMultiplier: null, pendingEffectiveDate: null }, "not-a-date"),
    ScaledUiError,
  );
});

// ---- раунд-4: гварды парсера on-chain состояния ----

// Синтетический минт с scaledUiAmountConfig в заданным state.
const mintWith = (state) => ({
  owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  data: { parsed: { info: { decimals: 8, extensions: [{ extension: "scaledUiAmountConfig", state }] } } },
});
const T0 = String(Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000)); // прошедший
const T1 = String(Math.floor(Date.parse("2027-01-01T00:00:00Z") / 1000)); // будущий

test("P1: newMultiplier «0» из цепи = pending сброшен, а не нулевой множитель", () => {
  // Конвенция эмитента (xstocks.mjs: Number(pending) !== 0, живая фикстура
  // xstocks-spyx-current.json): 0 в new_multiplier — способ снять pending. Строка "0"
  // truthy и раньше проезжала как настоящий множитель → журнал эмитил 5→0, витрина
  // молча показывала нулевые балансы.
  for (const ts of [T0, T1]) {
    const m = parseScaledUiAmount(mintWith({ multiplier: "5", newMultiplier: "0", newMultiplierEffectiveTimestamp: ts }));
    assert.equal(m.activeMultiplier, "5");
    assert.equal(m.pendingMultiplier, null);
    // дата обнуляется ВМЕСТЕ с pending: пара (pending, date) атомарна, дата без
    // pending — мусор в ответе; форма ответа не меняется
    assert.equal(m.pendingEffectiveDate, null);
  }
  // числовой 0 и вовсе отсутствующее поле — тот же вектор
  assert.equal(parseScaledUiAmount(mintWith({ multiplier: "5", newMultiplier: 0, newMultiplierEffectiveTimestamp: 1 })).pendingMultiplier, null);
  assert.equal(parseScaledUiAmount(mintWith({ multiplier: "5" })).pendingMultiplier, null);
});

test("P3: active не десятичная строка — честный ScaledUiError, а не «undefined» в дальние слои", () => {
  // отсутствующий multiplier раньше давал String(undefined) = "undefined" и падал
  // где-то в валидации с невнятным сообщением
  assert.throws(() => parseScaledUiAmount(mintWith({ newMultiplier: "2" })), (e) =>
    e instanceof ScaledUiError && /decimal string/.test(e.message));
  assert.throws(() => parseScaledUiAmount(mintWith({ multiplier: "abc", newMultiplier: "2" })), ScaledUiError);
  assert.throws(() => parseScaledUiAmount(mintWith({ multiplier: "1.2.3", newMultiplier: "2" })), ScaledUiError);
  assert.throws(() => parseScaledUiAmount(mintWith({ multiplier: null, newMultiplier: "2" })), ScaledUiError);
  // валидные формы проходят: целая и дробная десятичная строка
  assert.equal(parseScaledUiAmount(mintWith({ multiplier: "5", newMultiplier: "0" })).activeMultiplier, "5");
  assert.equal(parseScaledUiAmount(mintWith({ multiplier: "1.25", newMultiplier: "0" })).activeMultiplier, "1.25");
});

test("P3: pending жив, а таймстамп мусор — ScaledUiError вместо молча null-даты", () => {
  // до фикса: Number("abc") = NaN → ts > 0 false → дата null → pending "6" тихо
  // игнорировался нижележащими слоями
  assert.throws(
    () => parseScaledUiAmount(mintWith({ multiplier: "5", newMultiplier: "6", newMultiplierEffectiveTimestamp: "abc" })),
    (e) => e instanceof ScaledUiError && /timestamp/i.test(e.message),
  );
});

test("P3: pending нет — мусорный таймстамп значения не имеет, не бросаем", () => {
  const m = parseScaledUiAmount(mintWith({ multiplier: "5", newMultiplier: "0", newMultiplierEffectiveTimestamp: "abc" }));
  assert.equal(m.activeMultiplier, "5");
  assert.equal(m.pendingMultiplier, null);
  assert.equal(m.pendingEffectiveDate, null);
});

test("здоровый on-chain state с целым множителем — без регрессий", () => {
  const m = parseScaledUiAmount(mintWith({
    multiplier: "5",
    newMultiplier: "10",
    newMultiplierEffectiveTimestamp: "1782000000",
  }));
  assert.deepEqual(
    { activeMultiplier: m.activeMultiplier, pendingMultiplier: m.pendingMultiplier, pendingEffectiveDate: m.pendingEffectiveDate },
    { activeMultiplier: "5", pendingMultiplier: "10", pendingEffectiveDate: new Date(1782000000 * 1000).toISOString() },
  );
  // pending без объявленной даты (ts отсутствует) — прежнее поведение: дата null,
  // сам pending не выбрасывается
  const m2 = parseScaledUiAmount(mintWith({ multiplier: "5", newMultiplier: "10" }));
  assert.equal(m2.pendingMultiplier, "10");
  assert.equal(m2.pendingEffectiveDate, null);
});
