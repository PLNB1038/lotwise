
// regression tests for the findings
//   LW_applyevents_ignores_acquired_date (src/lots/lots.mjs — date semantics of events)
//   LW_report_negative_raw_balance (src/wallet/report.mjs — honest name of the window net delta)
import test from "node:test";
import assert from "node:assert/strict";
import { applyEvents, LotError } from "../src/lots/lots.mjs";
import { buildWalletReport } from "../src/wallet/report.mjs";

// strictly base58 (alphabet without 0, O, I, l), 32–44 chars — same as in lots.test.mjs
const MINT = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"; // TSLAx
const MINT2 = "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp"; // AAPLx
const OWNER = "9BB7Tt5uW5QbAorLkF3Hn1P2mGcXvcDdR7y8LbT9KdUu";

const lot = (over = {}) => ({
  id: "L1",
  mint: MINT,
  owner: OWNER,
  qtyRaw: 1_000_000n,
  acquiredDate: "2026-09-01",
  basisRaw: 250_000_000n,
  ...over,
});

const ev = (over = {}) => ({
  type: "SPLIT",
  mint: MINT,
  effectiveDate: "2026-10-01",
  status: "confirmed",
  sources: ["https://issuer.example/x"],
  ratioNumerator: 2,
  ratioDenominator: 1,
  ...over,
});

// ---- LW_applyevents_ignores_acquired_date: an event applies only to lots BEFORE it ----

test("SPLIT: a lot bought AFTER effectiveDate gets no split; a lot before — does", () => {
  const { lots } = applyEvents(
    [lot({ id: "early", acquiredDate: "2026-09-01" }), lot({ id: "late", acquiredDate: "2026-11-01" })],
    [ev()],
  );
  assert.equal(lots.find((l) => l.id === "early").qtyRaw, 2_000_000n);
  assert.equal(lots.find((l) => l.id === "late").qtyRaw, 1_000_000n, "bought after the split — the price is already post-split");
});

test("boundary: a lot bought ON the event day (date-only) is already after — the event is not applied", () => {
  // the "strictly earlier" rule: a purchase on the event day buys by post-event rules
  const { lots } = applyEvents([lot({ acquiredDate: "2026-10-01" })], [ev()]);
  assert.equal(lots[0].qtyRaw, 1_000_000n);
});

test("dates are compared as numbers (unix-ms), not lexicographically", () => {
  // "2026-10-01" = midnight UTC; the lot is bought at 12:00 UTC of the same day — LATER than the event,
  // even though lexicographically "2026-10-01T12:00:00Z" is longer and "greater" than the event date
  const after = applyEvents([lot({ acquiredDate: "2026-10-01T12:00:00Z" })], [ev()]);
  assert.equal(after.lots[0].qtyRaw, 1_000_000n);
  const before = applyEvents([lot({ acquiredDate: "2026-09-30" })], [ev({ effectiveDate: "2026-10-01T12:00:00Z" })]);
  assert.equal(before.lots[0].qtyRaw, 2_000_000n);
});

test("DIVIDEND_ACCRUAL: accrual only to lots bought before the ex-date", () => {
  const { accruals } = applyEvents(
    [lot({ id: "early", acquiredDate: "2026-09-01" }), lot({ id: "late", acquiredDate: "2026-10-15" })],
    [ev({ type: "DIVIDEND_ACCRUAL", amountPerUnitRaw: 100, decimals: 6 })],
  );
  assert.equal(accruals.length, 1);
  assert.equal(accruals[0].totalRaw, 100n * 1_000_000n, "only the early lot is in the base");
});

test("MERGER: exchange of lots before the date only; a later lot stays in the old mint", () => {
  // 910_000n is not divisible by 3 — the old code would crash on the untouched lot
  const { lots } = applyEvents(
    [
      lot({ id: "early", acquiredDate: "2026-09-01", qtyRaw: 900_000n }),
      lot({ id: "late", acquiredDate: "2026-11-01", qtyRaw: 910_000n }),
    ],
    [ev({ type: "MERGER", newMint: MINT2, exchangeNumerator: 3, exchangeDenominator: 1 })],
  );
  const early = lots.find((l) => l.id === "early");
  const late = lots.find((l) => l.id === "late");
  assert.equal(early.mint, MINT2);
  assert.equal(early.qtyRaw, 300_000n);
  assert.equal(late.mint, MINT, "a lot after the exchange is not converted");
  assert.equal(late.qtyRaw, 910_000n);
});

test("SPLIT: an indivisible lot AFTER the date does not break the application — divisibility is checked only for affected lots", () => {
  const { lots } = applyEvents(
    [
      lot({ id: "early", acquiredDate: "2026-09-01" }),
      lot({ id: "late", acquiredDate: "2026-11-01", qtyRaw: 999_999n }), // 999_999 % 2 !== 0
    ],
    [ev({ ratioNumerator: 3, ratioDenominator: 2 })],
  );
  assert.equal(lots.find((l) => l.id === "early").qtyRaw, 1_500_000n);
  assert.equal(lots.find((l) => l.id === "late").qtyRaw, 999_999n);
});

test("REDEEM: only lots bought before the redemption date are realized and closed", () => {
  const { lots, realized } = applyEvents(
    [lot({ id: "early", acquiredDate: "2026-09-01" }), lot({ id: "late", acquiredDate: "2026-11-01" })],
    [ev({ type: "REDEEM" })],
  );
  assert.equal(lots.length, 1, "a lot after the redemption is not invented out of nothing");
  assert.equal(lots[0].id, "late");
  assert.equal(realized.length, 1);
  assert.equal(realized[0].qtyRaw, 1_000_000n);
});

test("acquiredDate: null on a lot of the affected mint — LotError (fail-closed: we do not guess)", () => {
  assert.throws(
    () => applyEvents([lot({ acquiredDate: null })], [ev()]),
    (e) => e instanceof LotError && /acquiredDate/.test(e.message),
  );
});

test("garbage acquiredDate on a lot — LotError, not a silent comparison", () => {
  assert.throws(() => applyEvents([lot({ acquiredDate: "2026-13-45" })], [ev()]), LotError);
});

test("TICKER_CHANGE does not require acquiredDate — lots are untouched, no date check needed", () => {
  const { lots, symbolMap } = applyEvents(
    [lot({ acquiredDate: null })],
    [ev({ type: "TICKER_CHANGE", oldSymbol: "TSLAx", newSymbol: "TSLA2x" })],
  );
  assert.equal(lots.length, 1);
  assert.equal(symbolMap.TSLAx, "TSLA2x");
});

test("unchanged contract: input lots are not mutated, atomicity preserved", () => {
  const original = [lot({ id: "early", acquiredDate: "2026-09-01" }), lot({ id: "late", acquiredDate: "2026-11-01" })];
  applyEvents(original, [ev()]);
  assert.equal(original.find((l) => l.id === "early").qtyRaw, 1_000_000n);
  assert.equal(original.find((l) => l.id === "late").qtyRaw, 1_000_000n);
});

// ---- LW_report_negative_raw_balance: the window net delta ≠ the balance on chain ----

const SPYx = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const registry = [{ mint: SPYx, symbol: "SPYx", name: "S&P 500 xStock", decimals: 8 }];
const scanOf = (txs, extra = {}) => ({
  owner: OWNER, signatures: txs.length, fetched: txs.length, txs, skipped: [], truncated: false, accounts: {}, ...extra,
});

test("netDeltaRaw: with a gap, a negative window net delta is visible under an honest name", () => {
  // window: sold 300 (the position existed before the window), bought 60 → net -240, on chain not a "balance of -240"
  const txs = [
    { signature: "sell-first", slot: 1, blockTime: 100, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 500n, postRaw: 200n, deltaRaw: -300n }] },
    { signature: "buy-later", slot: 2, blockTime: 200, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 200n, postRaw: 260n, deltaRaw: 60n }] },
  ];
  const rep = buildWalletReport(scanOf(txs), { registry });
  const t = rep.tokens.find((x) => x.symbol === "SPYx");
  assert.equal(t.rawBalance, "-240", "the legacy field keeps the value (otherwise the vitrine breaks)");
  assert.equal(t.netDeltaRaw, "-240", "the honest name of the same number: the sum of scan-window deltas");
  assert.equal(t.reconciles, false);
  assert.equal(rep.complete, false);
});

test("full window: netDeltaRaw matches the on-chain balance (onchainNow) only when reconciles", () => {
  const txs = [
    { signature: "a", slot: 1, blockTime: 100, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 0n, postRaw: 60n, deltaRaw: 60n }] },
  ];
  const rep = buildWalletReport(scanOf(txs, { accounts: { [SPYx]: { address: "At1", currentRaw: 60n } } }), { registry });
  const t = rep.tokens.find((x) => x.symbol === "SPYx");
  assert.equal(t.reconciles, true);
  assert.equal(t.netDeltaRaw, "60");
  assert.equal(t.onchainNow, "60", "the on-chain balance is a separate field");
});

test("netDeltaRaw survives into JSON (the /lots serialization does not break)", () => {
  const txs = [
    { signature: "sell-first", slot: 1, blockTime: 100, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 500n, postRaw: 200n, deltaRaw: -300n }] },
  ];
  const rep = buildWalletReport(scanOf(txs), { registry });
  const wire = JSON.parse(JSON.stringify(rep));
  assert.equal(wire.tokens[0].netDeltaRaw, "-300");
});
