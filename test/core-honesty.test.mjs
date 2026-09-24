// formerly round7-core-honesty.test.mjs
// Round 7 regression tests of the Lotwise review — the "core honesty".
// ROUND7 findings:
//   #3 (schema/events.mjs): ZERO_MULTIPLIER_RE /^0(\.0+)?$/ caught only the canonical
//       spelling of zero — "00"/"000"/"00.0" passed the schema (while "0.0" and "0.00"
//       were refused): a valid step 1→"00" silently zeroed the position (scaledQty → 0 exact).
//   #11 (events/crosscheck.mjs): crossCheckMultiplierChange had no degenerate guards —
//       before.c=0 gave observedRatio=Infinity → a strict "mismatch"; a garbage multiplier
//       → NaN → "mismatch"; JSON serializes Infinity/NaN as null — the verdict looked
//       justified. The sibling crossCheckDividendAccrual has the guards (rawPrev<=0 →
//       inconclusive, garbage → CrossCheckError) — an asymmetry.
//   #12 (events/dividends.mjs): dedup by the raw exDate — "2026-06-18" and
//       "2026-06-18T00:00:00Z" (the same instant) produced TWO DIVIDEND_ACCRUAL events, the engine
//       accrued twice. The dedup key must be an instant.
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

// ---- ROUND7 #3: a zero multiplier in any spelling ----

test("schema: a zero multiplier in ANY spelling (\"00\", \"000\", \"00.0\", \"0.00\") is rejected", () => {
  for (const zero of ["0", "00", "000", "00.0", "0.00", "0.0000"]) {
    assert.throws(
      () => validateEvent(multEvent("1", zero)),
      (err) => err.name === "EventValidationError" && /must be positive/.test(err.message),
      `multiplierTo="${zero}" must be rejected`,
    );
    assert.throws(
      () => validateEvent(multEvent(zero, "5")),
      (err) => err.name === "EventValidationError" && /must be positive/.test(err.message),
      `multiplierFrom="${zero}" must be rejected`,
    );
  }
});

test("schema: after the zero tightening — \"0.5\" and \"5\" remain valid (zero ≠ smallness)", () => {
  assert.doesNotThrow(() => validateEvent(multEvent("1", "0.5")));
  assert.doesNotThrow(() => validateEvent(multEvent("0.5", "5")));
});

// ---- ROUND7 #11: degenerate guards of crossCheckMultiplierChange ----

// honest candles around 2026-06-18: the after-candle is the one that CLOSES after the event
// (the candle of the 18th); its close carries the post-event price — split 1→2 = 100 → 50
const candles = [
  { ts: Date.UTC(2026, 5, 16) / 1000, c: 100 },
  { ts: Date.UTC(2026, 5, 17) / 1000, c: 100 },
  { ts: Date.UTC(2026, 5, 18) / 1000, c: 50 },
  { ts: Date.UTC(2026, 5, 19) / 1000, c: 50 },
  { ts: Date.UTC(2026, 5, 20) / 1000, c: 50 },
];

test("crosscheck: a degenerate pool price (close <= 0) — inconclusive, not a mismatch with Infinity", () => {
  const degenerate = candles.map((c, i) => (i === 1 ? { ...c, c: 0 } : c)); // before.c = 0
  const v = crossCheckMultiplierChange(multEvent("1", "2"), degenerate);
  assert.equal(v.verdict, "inconclusive");
  assert.equal(v.observedRatio, null); // not Infinity, which JSON silently turns into null
  assert.match(v.note, /unusable|non-positive/i); // round 10: the wording is extended to non-numeric closes

  const negative = candles.map((c, i) => (i === 1 ? { ...c, c: -3 } : c));
  const v2 = crossCheckMultiplierChange(multEvent("1", "2"), negative);
  assert.equal(v2.verdict, "inconclusive");
});

test("crosscheck: garbage multiplier strings — CrossCheckError, not a \"mismatch\" with NaN", () => {
  assert.throws(
    () => crossCheckMultiplierChange(multEvent("abc", "2"), candles),
    (err) => err instanceof CrossCheckError && /multiplier/i.test(err.message),
  );
  assert.throws(
    () => crossCheckMultiplierChange({ ...multEvent("1", "2"), multiplierTo: null }, candles),
    (err) => err instanceof CrossCheckError,
  );
});

test("crosscheck: live inputs compute as before — a consistent split 1→2 stays consistent", () => {
  const v = crossCheckMultiplierChange(multEvent("1", "2"), candles);
  assert.equal(v.verdict, "consistent"); // 100 → 50 = exactly the from/to expectation
  assert.ok(Number.isFinite(v.observedRatio));
});

// ---- ROUND7 #12: dividend dedup by instant, not by string ----

test("dividends: equivalent canonical dates (\"2026-06-18\" vs \"…T00:00:00Z\") — ONE event", () => {
  const decl = (exDate) => ({
    symbol: "KOx", exDate, amountPerUnitRaw: 2500000, decimals: 8,
    sourceUrl: "https://issuer.example/ko/dividends",
  });
  const out = dividendsFromDeclarations(
    [decl("2026-06-18"), decl("2026-06-18T00:00:00Z"), decl("2026-06-18")],
    { symbol: "KOx" },
  );
  assert.equal(out.length, 1, "the same instant = one accrual, not two");
  assert.equal(out[0].amountPerUnitRaw, 2500000);
});

test("dividends: different sources of one date still do NOT collapse (a documented trade-off)", () => {
  const decl = (sourceUrl) => ({
    symbol: "KOx", exDate: "2026-06-18", amountPerUnitRaw: 2500000, decimals: 8, sourceUrl,
  });
  const out = dividendsFromDeclarations(
    [decl("https://a.example/x"), decl("https://b.example/y")],
    { symbol: "KOx" },
  );
  assert.equal(out.length, 2);
});

test("dividends: different DATES — still different events (the dedup did not overreach)", () => {
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
