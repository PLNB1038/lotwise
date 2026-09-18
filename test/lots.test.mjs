import test from "node:test";
import assert from "node:assert/strict";
import { applyEvents, LotError } from "../src/lots/lots.mjs";

const MINT = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"; // TSLAx
const MINT2 = "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp"; // AAPLx
const OWNER = "9BB7Tt5uW5QbAorLkF3Hn1P2mGcXvcDdR7y8LbT9KdUu";

const lot = (over = {}) => ({
  id: "L1",
  mint: MINT,
  owner: OWNER,
  qtyRaw: 1_000_000n,
  acquiredDate: "2026-09-01",
  basisRaw: 250_000_000n, // raw стейбл
  ...over,
});

const ev = (over = {}) => ({
  type: "SPLIT",
  mint: MINT,
  effectiveDate: "2026-10-01",
  status: "confirmed",
  sources: ["https://issuer.example/x"],
  ratioNumerator: 3,
  ratioDenominator: 1,
  ...over,
});

test("SPLIT 3/1: qty × 3, basis сохранён", () => {
  const { lots } = applyEvents([lot()], [ev()]);
  assert.equal(lots[0].qtyRaw, 3_000_000n);
  assert.equal(lots[0].basisRaw, 250_000_000n);
});

test("SPLIT 3/2 на неделимом лоте — ошибка, без округлений", () => {
  assert.throws(() => applyEvents([lot({ qtyRaw: 1_000_003n })], [ev({ ratioNumerator: 3, ratioDenominator: 2 })]), LotError);
});

test("DIVIDEND_ACCRUAL: qty не меняется, начиления целые и по владельцу", () => {
  const twoLots = [lot(), lot({ id: "L2", qtyRaw: 500_000n })];
  const { lots, accruals } = applyEvents(twoLots, [ev({
    type: "DIVIDEND_ACCRUAL", amountPerUnitRaw: 150_000, decimals: 6,
  })]);
  assert.equal(lots.length, 2);
  assert.equal(lots[0].qtyRaw, 1_000_000n);
  assert.equal(accruals.length, 1);
  assert.equal(accruals[0].totalRaw, 150_000n * 1_500_000n); // (1M + 0.5M) × 0.15
});

test("MERGER c коэффициентом 3:1 меняет минт и делит qty", () => {
  const { lots } = applyEvents([lot({ qtyRaw: 900_000n })], [ev({
    type: "MERGER", newMint: MINT2, exchangeNumerator: 3, exchangeDenominator: 1,
  })]);
  assert.equal(lots[0].mint, MINT2);
  assert.equal(lots[0].qtyRaw, 300_000n);
  assert.equal(lots[0].basisRaw, 250_000_000n);
});

test("MERGER без коэффициента — ошибка «не гадаем»", () => {
  assert.throws(() => applyEvents([lot()], [ev({ type: "MERGER", newMint: MINT2 })]), /without exchange ratio/);
});

test("MERGER на неделимом qty — ошибка", () => {
  assert.throws(() => applyEvents([lot({ qtyRaw: 910_000n })], [ev({
    type: "MERGER", newMint: MINT2, exchangeNumerator: 3, exchangeDenominator: 1,
  })]), /not divisible/);
});

test("TICKER_CHANGE трогает только карту символов", () => {
  const before = lot();
  const { lots, symbolMap } = applyEvents([before], [ev({
    type: "TICKER_CHANGE", oldSymbol: "TSLAx", newSymbol: "TSLA2x",
  })]);
  assert.deepEqual(lots[0], before);
  assert.equal(symbolMap.TSLAx, "TSLA2x");
});

test("REDEEM закрывает лоты и выносит в realized по владельцу", () => {
  const two = [lot(), lot({ id: "L2", qtyRaw: 400_000n, basisRaw: 100_000_000n })];
  const { lots, realized } = applyEvents(two, [ev({ type: "REDEEM" })]);
  assert.equal(lots.length, 0);
  assert.equal(realized.length, 1);
  assert.equal(realized[0].qtyRaw, 1_400_000n);
  assert.equal(realized[0].basisRaw, 350_000_000n);
});

test("событие чужого минта не трогает лоты", () => {
  const { lots } = applyEvents([lot()], [ev({ mint: MINT2 })]);
  assert.deepEqual(lots[0], lot());
});

test("порядок: SPLIT → DIVIDEND считает дивиденд на НОВЫЙ qty", () => {
  const { accruals } = applyEvents([lot()], [
    ev({ ratioNumerator: 2, ratioDenominator: 1 }),
    ev({ type: "DIVIDEND_ACCRUAL", amountPerUnitRaw: 10, decimals: 6 }),
  ]);
  assert.equal(accruals[0].totalRaw, 10n * 2_000_000n);
});

test("атомарность: невалидное событие откатывает всё состояние", () => {
  const original = [lot()];
  const bad = ev({ type: "MERGER", newMint: MINT2 }); // без коэффициента = ошибка в фазе применения
  assert.throws(() => applyEvents(original, [ev({ ratioNumerator: 3, ratioDenominator: 1 }), bad]), LotError);
  // original не изменился (функция работала с копией)
  assert.deepEqual(original[0], lot());
});

test("невалидное по схеме событие отклоняется до применения", () => {
  assert.throws(() => applyEvents([lot()], [ev({ ratioNumerator: -1 })]), /invalid event/);
});

test("несколько владельцев: дивиденды и redeem агрегируются раздельно", () => {
  const two = [lot(), lot({ id: "L2", owner: "Ho5371KcABCDMN2e9gFyqiLtzfXyF1f2hKwPqRSUVwCd" })];
  const { accruals } = applyEvents(two, [ev({ type: "DIVIDEND_ACCRUAL", amountPerUnitRaw: 5, decimals: 6 })]);
  assert.equal(accruals.length, 2);
  assert.ok(accruals.every((a) => a.totalRaw === 5n * 1_000_000n));
});

test("пустой список событий возвращает лоты как есть", () => {
  const { lots, applied } = applyEvents([lot()], []);
  assert.deepEqual(lots, [lot()]);
  assert.equal(applied, 0);
});

test("MULTIPLIER_CHANGE — no-op для raw-лотов (множитель живёт в слое отображения)", () => {
  const before = lot();
  const { lots, applied } = applyEvents([before], [ev({
    type: "MULTIPLIER_CHANGE", multiplierFrom: "1", multiplierTo: "1.005714560286254", reason: "Dividend",
  })]);
  assert.deepEqual(lots[0], before);
  assert.equal(applied, 1);
});
