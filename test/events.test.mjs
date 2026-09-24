import test from "node:test";
import assert from "node:assert/strict";
import { validateEvent, isValidEvent, EventValidationError } from "../src/schema/events.mjs";

const MINT = "EHTvgDbXdad1o1tfqmT4apRDYXQmbsLtc72jLLGgQAp6"; // a real mint from the stockbasis registry (SPACEX-class, base58-valid)
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

test("a valid SPLIT event passes", () => {
  assert.equal(validateEvent(valid()), true);
});

test("a valid DIVIDEND_ACCRUAL in raw units passes", () => {
  assert.equal(validateEvent(valid({
    type: "DIVIDEND_ACCRUAL",
    amountPerUnitRaw: 150_000, // 0.15 at 6 decimals
    decimals: 6,
  })), true);
});

test("a MERGER requires a new mint different from the old one", () => {
  assert.equal(isValidEvent(valid({ type: "MERGER", newMint: "9BB7Tt5uW5QbAorLkF3Hn1P2mGcXvcDdR7y8LbT9KdUu" })), true);
  assert.equal(isValidEvent(valid({ type: "MERGER", newMint: MINT })), false);
});

test("the MERGER exchange ratio is optional, but if present — positive integers", () => {
  assert.equal(isValidEvent(valid({ type: "MERGER", newMint: "9BB7Tt5uW5QbAorLkF3Hn1P2mGcXvcDdR7y8LbT9KdUu", exchangeNumerator: 2, exchangeDenominator: 1 })), true);
  assert.equal(isValidEvent(valid({ type: "MERGER", newMint: "9BB7Tt5uW5QbAorLkF3Hn1P2mGcXvcDdR7y8LbT9KdUu", exchangeNumerator: 1.5, exchangeDenominator: 1 })), false);
  assert.equal(isValidEvent(valid({ type: "MERGER", newMint: "9BB7Tt5uW5QbAorLkF3Hn1P2mGcXvcDdR7y8LbT9KdUu", exchangeDenominator: 1 })), false);
});

test("a TICKER_CHANGE must change the symbol", () => {
  assert.equal(isValidEvent(valid({ type: "TICKER_CHANGE", oldSymbol: "TSLAx", newSymbol: "TSLA2x" })), true);
  assert.equal(isValidEvent(valid({ type: "TICKER_CHANGE", oldSymbol: "TSLAx", newSymbol: "TSLAx" })), false);
});

test("a REDEEM passes without extra fields, but with a source", () => {
  assert.equal(isValidEvent(valid({ type: "REDEEM" })), true);
  assert.equal(isValidEvent(valid({ type: "REDEEM", sources: [] })), false);
});

test("an unknown type is rejected", () => {
  assert.equal(isValidEvent(valid({ type: "MOON_LANDING" })), false);
});

test("a broken mint is rejected", () => {
  assert.equal(isValidEvent(valid({ mint: "0OIlIl0OIl" })), false);
});

test("a negative/fractional split ratio is rejected", () => {
  assert.equal(isValidEvent(valid({ ratioNumerator: 0 })), false);
  assert.equal(isValidEvent(valid({ ratioNumerator: 1.5 })), false);
});

test("a dividend as a float, not a raw integer, is rejected", () => {
  assert.equal(isValidEvent(valid({ type: "DIVIDEND_ACCRUAL", amountPerUnitRaw: 0.15, decimals: 6 })), false);
});

test("without sources the event does not exist (anti-rumor)", () => {
  assert.equal(isValidEvent(valid({ sources: undefined })), false);
});

test("a validation error names the field", () => {
  try {
    validateEvent(valid({ ratioNumerator: -3 }));
    assert.fail("it must have thrown");
  } catch (err) {
    assert.ok(err instanceof EventValidationError);
    assert.equal(err.field, "ratioNumerator");
  }
});

// ---- round 4: strict dates (src/schema/isodate.mjs) ----
// Findings: Date.parse accepts garbage after the schema's form check and silently
// "rolls over" non-existent dates. The schema is the only barrier for
// the journal replay and the xstocks history, hence the validation here, not lower.

// A battery of garbage dates: the review findings (a month of 13 / 00, a 60th second, an offset 99:99),
// Date.parse roll-overs, naive datetimes, form violations.
const garbageDates = [
  "2026-13-01",                // month 13: Date.parse = NaN already AFTER the schema check
  "2026-00-10",                // month 00
  "2026-06-18T23:59:60Z",      // a 60th second (leap second) — not a time
  "2026-06-18T12:00:00+99:99", // an offset 99:99 passes the form, Date.parse = NaN
  "2026-02-30",                // Date.parse rolls it over to 02.03
  "2026-06-31",                // a roll-over to 01.07
  "2027-02-29",                // not a leap year — a roll-over to 01.03
  "2026-06-18T24:00:00Z",      // a roll-over to the next day
  "2026-06-18T12:00:00",       // a naive time: would be parsed by the host's locale
  "2026-06-18T12:00:00.500",   // a naive one with fractions — the same hole
  "2026-1-1",                  // the form: without leading zeros
  "2026-02-29",                // 2026 is not a leap year
  "2026-06-18T12:60:00Z",      // minutes 60
  "2026-06-18T12:00:00+0200",  // an offset without a colon — not the project's canonical format
];

test("garbage dates: a parameterized battery is rejected by the schema", () => {
  for (const bad of garbageDates) {
    assert.equal(isValidEvent(valid({ effectiveDate: bad })), false, `must be rejected: ${JSON.stringify(bad)}`);
  }
});

test("a garbage date names the field effectiveDate", () => {
  try {
    validateEvent(valid({ effectiveDate: "2026-02-30" }));
    assert.fail("a rolled-over date must have been rejected");
  } catch (err) {
    assert.ok(err instanceof EventValidationError);
    assert.equal(err.field, "effectiveDate");
  }
});

// An ANTI-regression: the canonical formats (the project's real producers) must not
// start being rejected by the strict validator.
const canonicalDates = [
  "2026-06-18",                  // date-only (the vitrine, /multiplier?date=)
  "2026-06-18T00:00:00Z",        // Z
  "2026-06-18T12:34:56Z",
  "2026-06-18T12:34:56.000Z",    // the format of the xstocks fixtures and normalize-onchain (toISOString)
  "2026-06-18T12:34:56.5Z",      // one fraction of a second
  "2026-06-18T12:34:56.123456Z", // sub-ms fractions in the string
  "2026-06-18T04:00Z",           // without seconds
  "2026-06-18T12:34:56+02:00",   // a positive offset
  "2026-06-18T12:34:56-05:30",   // a negative offset, a non-integer hour
  "2025-10-31T23:55:00.000Z",    // a real SPYx event from the fixture
  "2028-02-29",                  // a leap day is valid
  "1970-01-01",
];

test("canonical date formats are not rejected (an anti-overreach of the strict validator)", () => {
  for (const good of canonicalDates) {
    assert.equal(validateEvent(valid({ effectiveDate: good })), true, `must pass: ${good}`);
  }
});

// ---- round 4: the multiplier "0" and the precision cap ----

test("a zero multiplier does not exist: \"0\", \"0.0\", \"0.000\" are rejected, \"0.5\" is valid", () => {
  const mc = (over) => valid({ type: "MULTIPLIER_CHANGE", multiplierFrom: "1", multiplierTo: "1.005", ...over });
  for (const zero of ["0", "0.0", "0.000"]) {
    assert.equal(isValidEvent(mc({ multiplierTo: zero })), false, `multiplierTo=${zero} — the position would be silently zeroed`);
    assert.equal(isValidEvent(mc({ multiplierFrom: zero, multiplierTo: "1.005" })), false, `multiplierFrom=${zero}`);
  }
  assert.equal(isValidEvent(mc({ multiplierFrom: "0.5", multiplierTo: "1" })), true); // a half multiplier exists
});

test("the cap of the multiplier's fractional precision at 30 digits — a pair with timeline.mjs (decimalToRatio)", () => {
  const mc = (over) => valid({ type: "MULTIPLIER_CHANGE", multiplierFrom: "1", multiplierTo: "1.005", ...over });
  const m30 = "1." + "1".repeat(30);
  const m31 = "1." + "1".repeat(31);
  assert.equal(isValidEvent(mc({ multiplierTo: m30 })), true);
  assert.equal(isValidEvent(mc({ multiplierTo: m31 })), false);
});

// ---- round 4: the fuzzer invariants (schema) ----

test("canonically valid events of all 6 types are not rejected by the strict validator", () => {
  const newMint = "9BB7Tt5uW5QbAorLkF3Hn1P2mGcXvcDdR7y8LbT9KdUu";
  const byType = {
    SPLIT: { ratioNumerator: 3, ratioDenominator: 1 },
    DIVIDEND_ACCRUAL: { amountPerUnitRaw: 150_000, decimals: 6 },
    MERGER: { newMint, exchangeNumerator: 2, exchangeDenominator: 1 },
    TICKER_CHANGE: { oldSymbol: "TSLAx", newSymbol: "TSLA2x" },
    REDEEM: {},
    MULTIPLIER_CHANGE: { multiplierFrom: "1", multiplierTo: "1.005", reason: "Dividend" },
  };
  // the dates in the formats of all the project's producers: date-only (the vitrine), .000Z (toISOString), Z (manual input)
  for (const [type, extra] of Object.entries(byType)) {
    for (const date of ["2026-06-18", "2026-06-18T04:00:00.000Z", "2026-06-18T04:00Z"]) {
      assert.equal(validateEvent(valid({ type, effectiveDate: date, ...extra })), true, `${type} @ ${date}`);
    }
  }
});
