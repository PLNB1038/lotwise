// Round 6: regression tests for the findings
//   LW2_excluded_token_adjusted_row_unmarked (src/wallet/report.mjs — adjustedAvailable)
//   LW2_blocktime_null_lot_vs_applyevents_loterror (the report↔lots seam — the contract documented,
//     the behavior does NOT change: the test pins the seam so it is no longer silent)
import test from "node:test";
import assert from "node:assert/strict";
import { buildWalletReport } from "../src/wallet/report.mjs";
import { MultiplierTimeline } from "../src/lots/timeline.mjs";
import { applyEvents, LotError } from "../src/lots/lots.mjs";

// strictly base58 (alphabet without 0, O, I, l), 32–44 chars — same as in lots.test.mjs
const SPYx = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const AAPLx = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB";
const OWNER = "9BB7Tt5uW5QbAorLkF3Hn1P2mGcXvcDdR7y8LbT9KdUu";

const registry = [
  { mint: SPYx, symbol: "SPYx", name: "S&P 500 xStock", decimals: 8 },
  { mint: AAPLx, symbol: "AAPLx", name: "Apple xStock", decimals: 8 },
];
const scanOf = (txs, extra = {}) => ({
  owner: OWNER, signatures: txs.length, fetched: txs.length, txs, skipped: [], truncated: false, accounts: {}, ...extra,
});
const buy = (signature, mint, qty, blockTime = 1000) => ({
  signature, slot: 1, blockTime, deltas: [{ owner: OWNER, mint, preRaw: 0n, postRaw: qty, deltaRaw: qty }],
});

// a timeline with a NON-unity multiplier: adjusted must differ from raw — that is how the test
// distinguishes an honestly computed adjusted from the identical fallback (scaled=raw)
const timelines = new Map([
  [SPYx, new MultiplierTimeline([
    { type: "MULTIPLIER_CHANGE", effectiveDate: "2026-06-01", multiplierFrom: "1", multiplierTo: "2" },
  ])],
]);

// ---- LW2_excluded_token_adjusted_row_unmarked: the identity fallback is honestly marked ----

test("adjustedAvailable: a timeline exists — no field, adjusted is really computed (≠ raw)", () => {
  const rep = buildWalletReport(scanOf([buy("a", SPYx, 10n)]), { registry, timelines });
  const t = rep.tokens.find((x) => x.symbol === "SPYx");
  assert.equal(t.adjustedAvailable, undefined, "the absence of the field = adjusted computed by the timeline");
  assert.equal(t.adjusted.whole, "20", "10 × 2 — computed by the timeline, not the identical fallback");
});

test("adjustedAvailable: no timeline (the identity fallback scaled=raw) — false, not a silent equality", () => {
  // AAPLx without a timeline: adjusted == raw, but now it is MARKED
  const rep = buildWalletReport(scanOf([buy("a", AAPLx, 10n)]), { registry, timelines });
  const t = rep.tokens.find((x) => x.symbol === "AAPLx");
  assert.equal(t.adjustedAvailable, false);
  assert.equal(t.adjusted.whole, "10", "the fallback did not change the value — the honesty of the marking changed");
});

test("adjustedAvailable: false also on the /lots → JSON path (the serialization does not break)", () => {
  const rep = buildWalletReport(scanOf([buy("a", AAPLx, 10n)], { accounts: { [AAPLx]: { address: "At3", currentRaw: 10n } } }), { registry });
  const wire = JSON.parse(JSON.stringify(rep)); // the same path as /lots -> res.end
  assert.equal(wire.tokens[0].adjustedAvailable, false);
});

test("adjustedAvailable: a token on chain without deltas (an old position) — honestly marked too", () => {
  // pushToken is called for the out-of-window balance too: the fallback is the same, the marking must match
  const rep = buildWalletReport(scanOf([], { accounts: { [AAPLx]: { address: "At4", currentRaw: 7n } } }), { registry, timelines });
  const t = rep.tokens.find((x) => x.symbol === "AAPLx");
  assert.equal(t.adjustedAvailable, false);
});

// ---- LW2_blocktime_null_lot_vs_applyevents_loterror: the seam documented by a contract ----

test("the seam: a report lot with blockTime:null (acquiredDate:null) is poisonous for applyEvents — filter it or catch the LotError", () => {
  const txs = [buy("a", SPYx, 10n, null)]; // the Solana reality: blockTime can be null
  const rep = buildWalletReport(scanOf(txs), { registry });
  const lot = rep.tokens.find((x) => x.symbol === "SPYx").lots[0];
  assert.equal(lot.acquiredDate, null);
  // a /lots consumer assembles the engine context (a lot carries no mint/owner/basisRaw)
  const engineLot = { mint: SPYx, owner: OWNER, basisRaw: 100n, qtyRaw: BigInt(lot.qtyRaw), ...lot };
  const ev = {
    type: "SPLIT", mint: SPYx, effectiveDate: "2026-10-01", status: "confirmed",
    sources: ["https://issuer.example/x"], ratioNumerator: 2, ratioDenominator: 1,
  };
  assert.throws(() => applyEvents([engineLot], [ev]), LotError);
});
