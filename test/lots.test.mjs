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
  basisRaw: 250_000_000n, // raw of a stable
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

test("SPLIT 3/1: qty × 3, the basis preserved", () => {
  const { lots } = applyEvents([lot()], [ev()]);
  assert.equal(lots[0].qtyRaw, 3_000_000n);
  assert.equal(lots[0].basisRaw, 250_000_000n);
});

test("SPLIT 3/2 on an indivisible lot — an error, without roundings", () => {
  assert.throws(() => applyEvents([lot({ qtyRaw: 1_000_003n })], [ev({ ratioNumerator: 3, ratioDenominator: 2 })]), LotError);
});

test("DIVIDEND_ACCRUAL: qty unchanged, the accruals integral and per owner", () => {
  const twoLots = [lot(), lot({ id: "L2", qtyRaw: 500_000n })];
  const { lots, accruals } = applyEvents(twoLots, [ev({
    type: "DIVIDEND_ACCRUAL", amountPerUnitRaw: 150_000, decimals: 6,
  })]);
  assert.equal(lots.length, 2);
  assert.equal(lots[0].qtyRaw, 1_000_000n);
  assert.equal(accruals.length, 1);
  assert.equal(accruals[0].totalRaw, 150_000n * 1_500_000n); // (1M + 0.5M) × 0.15
});

test("a MERGER with a ratio of 3:1 changes the mint and divides the qty", () => {
  const { lots } = applyEvents([lot({ qtyRaw: 900_000n })], [ev({
    type: "MERGER", newMint: MINT2, exchangeNumerator: 3, exchangeDenominator: 1,
  })]);
  assert.equal(lots[0].mint, MINT2);
  assert.equal(lots[0].qtyRaw, 300_000n);
  assert.equal(lots[0].basisRaw, 250_000_000n);
});

test("a MERGER without a ratio — a \"we do not guess\" error", () => {
  assert.throws(() => applyEvents([lot()], [ev({ type: "MERGER", newMint: MINT2 })]), /without exchange ratio/);
});

test("a MERGER on an indivisible qty — an error", () => {
  assert.throws(() => applyEvents([lot({ qtyRaw: 910_000n })], [ev({
    type: "MERGER", newMint: MINT2, exchangeNumerator: 3, exchangeDenominator: 1,
  })]), /not divisible/);
});

test("a TICKER_CHANGE touches only the symbol map", () => {
  const before = lot();
  const { lots, symbolMap } = applyEvents([before], [ev({
    type: "TICKER_CHANGE", oldSymbol: "TSLAx", newSymbol: "TSLA2x",
  })]);
  assert.deepEqual(lots[0], before);
  assert.equal(symbolMap.TSLAx, "TSLA2x");
});

test("a REDEEM closes the lots and carries them into realized per owner", () => {
  const two = [lot(), lot({ id: "L2", qtyRaw: 400_000n, basisRaw: 100_000_000n })];
  const { lots, realized } = applyEvents(two, [ev({ type: "REDEEM" })]);
  assert.equal(lots.length, 0);
  assert.equal(realized.length, 1);
  assert.equal(realized[0].qtyRaw, 1_400_000n);
  assert.equal(realized[0].basisRaw, 350_000_000n);
});

test("an event of a foreign mint does not touch the lots", () => {
  const { lots } = applyEvents([lot()], [ev({ mint: MINT2 })]);
  assert.deepEqual(lots[0], lot());
});

test("the order: SPLIT → DIVIDEND computes the dividend on the NEW qty", () => {
  const { accruals } = applyEvents([lot()], [
    ev({ ratioNumerator: 2, ratioDenominator: 1 }),
    ev({ type: "DIVIDEND_ACCRUAL", amountPerUnitRaw: 10, decimals: 6 }),
  ]);
  assert.equal(accruals[0].totalRaw, 10n * 2_000_000n);
});

test("atomicity: an invalid event rolls back the whole state", () => {
  const original = [lot()];
  const bad = ev({ type: "MERGER", newMint: MINT2 }); // without a ratio = an error in the application phase
  assert.throws(() => applyEvents(original, [ev({ ratioNumerator: 3, ratioDenominator: 1 }), bad]), LotError);
  // original unchanged (the function worked on a copy)
  assert.deepEqual(original[0], lot());
});

test("a schema-invalid event is rejected before application", () => {
  assert.throws(() => applyEvents([lot()], [ev({ ratioNumerator: -1 })]), /invalid event/);
});

test("several owners: the dividends and the redeem are aggregated separately", () => {
  const two = [lot(), lot({ id: "L2", owner: "Ho5371KcABCDMN2e9gFyqiLtzfXyF1f2hKwPqRSUVwCd" })];
  const { accruals } = applyEvents(two, [ev({ type: "DIVIDEND_ACCRUAL", amountPerUnitRaw: 5, decimals: 6 })]);
  assert.equal(accruals.length, 2);
  assert.ok(accruals.every((a) => a.totalRaw === 5n * 1_000_000n));
});

test("an empty event list returns the lots as is", () => {
  const { lots, applied } = applyEvents([lot()], []);
  assert.deepEqual(lots, [lot()]);
  assert.equal(applied, 0);
});

test("a MULTIPLIER_CHANGE — a no-op for raw lots (the multiplier lives in the display layer)", () => {
  const before = lot();
  const { lots, applied } = applyEvents([before], [ev({
    type: "MULTIPLIER_CHANGE", multiplierFrom: "1", multiplierTo: "1.005714560286254", reason: "Dividend",
  })]);
  assert.deepEqual(lots[0], before);
  assert.equal(applied, 1);
});
