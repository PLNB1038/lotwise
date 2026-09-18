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
