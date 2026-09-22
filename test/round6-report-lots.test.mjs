// Раунд 6: регрессионные тесты находок
//   LW2_excluded_token_adjusted_row_unmarked (src/wallet/report.mjs — adjustedAvailable)
//   LW2_blocktime_null_lot_vs_applyevents_loterror (стык report↔lots — контракт задокументирован,
//     поведение НЕ меняется: тест фиксирует стык, чтобы он больше не был молчаливым)
import test from "node:test";
import assert from "node:assert/strict";
import { buildWalletReport } from "../src/wallet/report.mjs";
import { MultiplierTimeline } from "../src/lots/timeline.mjs";
import { applyEvents, LotError } from "../src/lots/lots.mjs";

// строго base58 (алфавит без 0, O, I, l), 32–44 символа — как в lots.test.mjs
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

// timeline с НЕединичным множителем: adjusted обязан отличаться от raw — так тест
// отличает честно посчитанный adjusted от тождественного fallback (scaled=raw)
const timelines = new Map([
  [SPYx, new MultiplierTimeline([
    { type: "MULTIPLIER_CHANGE", effectiveDate: "2026-06-01", multiplierFrom: "1", multiplierTo: "2" },
  ])],
]);

// ---- LW2_excluded_token_adjusted_row_unmarked: identity-fallback помечен честно ----

test("adjustedAvailable: таймлайн есть — поля нет, adjusted реально посчитан (≠ raw)", () => {
  const rep = buildWalletReport(scanOf([buy("a", SPYx, 10n)]), { registry, timelines });
  const t = rep.tokens.find((x) => x.symbol === "SPYx");
  assert.equal(t.adjustedAvailable, undefined, "отсутствие поля = adjusted посчитан таймлайном");
  assert.equal(t.adjusted.whole, "20", "10 × 2 — посчитано таймлайном, не тождественный fallback");
});

test("adjustedAvailable: таймлайна нет (identity-fallback scaled=raw) — false, не тихое равенство", () => {
  // AAPLx без таймлайна: adjusted == raw, но теперь это ПОМЕЧЕНО
  const rep = buildWalletReport(scanOf([buy("a", AAPLx, 10n)]), { registry, timelines });
  const t = rep.tokens.find((x) => x.symbol === "AAPLx");
  assert.equal(t.adjustedAvailable, false);
  assert.equal(t.adjusted.whole, "10", "fallback не изменил значение — изменилась честность пометки");
});

test("adjustedAvailable: false и на пути /lots → JSON (сериализация не ломается)", () => {
  const rep = buildWalletReport(scanOf([buy("a", AAPLx, 10n)], { accounts: { [AAPLx]: { address: "At3", currentRaw: 10n } } }), { registry });
  const wire = JSON.parse(JSON.stringify(rep)); // тот же путь, что /lots -> res.end
  assert.equal(wire.tokens[0].adjustedAvailable, false);
});

test("adjustedAvailable: токен на цепи без дельт (старая позиция) — тоже честно помечен", () => {
  // pushToken вызывается и для мимо-оконного баланса: fallback тот же, пометка обязана совпасть
  const rep = buildWalletReport(scanOf([], { accounts: { [AAPLx]: { address: "At4", currentRaw: 7n } } }), { registry, timelines });
  const t = rep.tokens.find((x) => x.symbol === "AAPLx");
  assert.equal(t.adjustedAvailable, false);
});

// ---- LW2_blocktime_null_lot_vs_applyevents_loterror: стык задокументирован контрактом ----

test("стык: лот из отчёта с blockTime:null (acquiredDate:null) ядовит для applyEvents — фильтруй или лови LotError", () => {
  const txs = [buy("a", SPYx, 10n, null)]; // Solana-реальность: blockTime бывает null
  const rep = buildWalletReport(scanOf(txs), { registry });
  const lot = rep.tokens.find((x) => x.symbol === "SPYx").lots[0];
  assert.equal(lot.acquiredDate, null);
  // потребитель /lots достраивает движковый контекст (mint/owner/basisRaw в лоте нет)
  const engineLot = { mint: SPYx, owner: OWNER, basisRaw: 100n, qtyRaw: BigInt(lot.qtyRaw), ...lot };
  const ev = {
    type: "SPLIT", mint: SPYx, effectiveDate: "2026-10-01", status: "confirmed",
    sources: ["https://issuer.example/x"], ratioNumerator: 2, ratioDenominator: 1,
  };
  assert.throws(() => applyEvents([engineLot], [ev]), LotError);
});
