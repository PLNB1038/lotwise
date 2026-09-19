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
