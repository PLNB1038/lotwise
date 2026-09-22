// Раунд 5: регрессионные тесты находок
//   LW_applyevents_ignores_acquired_date (src/lots/lots.mjs — датная семантика событий)
//   LW_report_negative_raw_balance (src/wallet/report.mjs — честное имя нетто-дельты окна)
import test from "node:test";
import assert from "node:assert/strict";
import { applyEvents, LotError } from "../src/lots/lots.mjs";
import { buildWalletReport } from "../src/wallet/report.mjs";

// строго base58 (алфавит без 0, O, I, l), 32–44 символа — как в lots.test.mjs
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

// ---- LW_applyevents_ignores_acquired_date: событие действует только на лоты ДО него ----

test("SPLIT: лот, купленный ПОСЛЕ effectiveDate, сплит не получает; лот до — получает", () => {
  const { lots } = applyEvents(
    [lot({ id: "early", acquiredDate: "2026-09-01" }), lot({ id: "late", acquiredDate: "2026-11-01" })],
    [ev()],
  );
  assert.equal(lots.find((l) => l.id === "early").qtyRaw, 2_000_000n);
  assert.equal(lots.find((l) => l.id === "late").qtyRaw, 1_000_000n, "куплен после сплита — цена уже пост-сплит");
});

test("граница: лот, купленный В ДЕНЬ события (date-only), — уже после, событие не применяется", () => {
  // правило «строго раньше»: купленный в день события покупается по пост-событийным правилам
  const { lots } = applyEvents([lot({ acquiredDate: "2026-10-01" })], [ev()]);
  assert.equal(lots[0].qtyRaw, 1_000_000n);
});

test("сравнение дат числом (unix-ms), не лексикографически", () => {
  // "2026-10-01" = полночь UTC; лот куплен в 12:00 UTC того же дня — ПОЗЖЕ события,
  // хотя лексикографически "2026-10-01T12:00:00Z" длиннее и «больше» даты события
  const after = applyEvents([lot({ acquiredDate: "2026-10-01T12:00:00Z" })], [ev()]);
  assert.equal(after.lots[0].qtyRaw, 1_000_000n);
  const before = applyEvents([lot({ acquiredDate: "2026-09-30" })], [ev({ effectiveDate: "2026-10-01T12:00:00Z" })]);
  assert.equal(before.lots[0].qtyRaw, 2_000_000n);
});

test("DIVIDEND_ACCRUAL: начисление только на лоты, купленные до экс-даты", () => {
  const { accruals } = applyEvents(
    [lot({ id: "early", acquiredDate: "2026-09-01" }), lot({ id: "late", acquiredDate: "2026-10-15" })],
    [ev({ type: "DIVIDEND_ACCRUAL", amountPerUnitRaw: 100, decimals: 6 })],
  );
  assert.equal(accruals.length, 1);
  assert.equal(accruals[0].totalRaw, 100n * 1_000_000n, "в базе только early-лот");
});

test("MERGER: обмен только лотов до даты; лот после остаётся в старом минте", () => {
  // 910_000n не делится на 3 — старый код упал бы на незатронутом лоте
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
  assert.equal(late.mint, MINT, "лот после обмена не конвертируется");
  assert.equal(late.qtyRaw, 910_000n);
});

test("SPLIT: неделимый лот ПОСЛЕ даты не роняет применение — делимость проверяется только у затронутых", () => {
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

test("REDEEM: реализуются и закрываются только лоты, купленные до даты выкупа", () => {
  const { lots, realized } = applyEvents(
    [lot({ id: "early", acquiredDate: "2026-09-01" }), lot({ id: "late", acquiredDate: "2026-11-01" })],
    [ev({ type: "REDEEM" })],
  );
  assert.equal(lots.length, 1, "лот после выкупа не выдуманно не уничтожается");
  assert.equal(lots[0].id, "late");
  assert.equal(realized.length, 1);
  assert.equal(realized[0].qtyRaw, 1_000_000n);
});

test("acquiredDate: null у лота затронутого минта — LotError (fail-closed: не угадываем)", () => {
  assert.throws(
    () => applyEvents([lot({ acquiredDate: null })], [ev()]),
    (e) => e instanceof LotError && /acquiredDate/.test(e.message),
  );
});

test("acquiredDate-мусор у лота — LotError, а не тихое сравнение", () => {
  assert.throws(() => applyEvents([lot({ acquiredDate: "2026-13-45" })], [ev()]), LotError);
});

test("TICKER_CHANGE не требует acquiredDate — лоты не трогаются, датная проверка не нужна", () => {
  const { lots, symbolMap } = applyEvents(
    [lot({ acquiredDate: null })],
    [ev({ type: "TICKER_CHANGE", oldSymbol: "TSLAx", newSymbol: "TSLA2x" })],
  );
  assert.equal(lots.length, 1);
  assert.equal(symbolMap.TSLAx, "TSLA2x");
});

test("неизменённый контракт: входные лоты не мутируются, атомарность сохранена", () => {
  const original = [lot({ id: "early", acquiredDate: "2026-09-01" }), lot({ id: "late", acquiredDate: "2026-11-01" })];
  applyEvents(original, [ev()]);
  assert.equal(original.find((l) => l.id === "early").qtyRaw, 1_000_000n);
  assert.equal(original.find((l) => l.id === "late").qtyRaw, 1_000_000n);
});

// ---- LW_report_negative_raw_balance: нетто-дельта окна ≠ баланс на цепи ----

const SPYx = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const registry = [{ mint: SPYx, symbol: "SPYx", name: "S&P 500 xStock", decimals: 8 }];
const scanOf = (txs, extra = {}) => ({
  owner: OWNER, signatures: txs.length, fetched: txs.length, txs, skipped: [], truncated: false, accounts: {}, ...extra,
});

test("netDeltaRaw: при гэпе отрицательная нетто-дельта окна видна под честным именем", () => {
  // окно: продано 300 (позиция была до окна), куплено 60 → нетто -240, на цепи не «баланс -240»
  const txs = [
    { signature: "sell-first", slot: 1, blockTime: 100, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 500n, postRaw: 200n, deltaRaw: -300n }] },
    { signature: "buy-later", slot: 2, blockTime: 200, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 200n, postRaw: 260n, deltaRaw: 60n }] },
  ];
  const rep = buildWalletReport(scanOf(txs), { registry });
  const t = rep.tokens.find((x) => x.symbol === "SPYx");
  assert.equal(t.rawBalance, "-240", "легаси-поле сохраняет значение (иначе ломается витрина)");
  assert.equal(t.netDeltaRaw, "-240", "честное имя того же числа: Σ дельт окна скана");
  assert.equal(t.reconciles, false);
  assert.equal(rep.complete, false);
});

test("полное окно: netDeltaRaw совпадает с балансом на цепи (onchainNow) только при reconciles", () => {
  const txs = [
    { signature: "a", slot: 1, blockTime: 100, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 0n, postRaw: 60n, deltaRaw: 60n }] },
  ];
  const rep = buildWalletReport(scanOf(txs, { accounts: { [SPYx]: { address: "At1", currentRaw: 60n } } }), { registry });
  const t = rep.tokens.find((x) => x.symbol === "SPYx");
  assert.equal(t.reconciles, true);
  assert.equal(t.netDeltaRaw, "60");
  assert.equal(t.onchainNow, "60", "баланс на цепи — отдельное поле");
});

test("netDeltaRaw доезжает до JSON (сериализация /lots не ломается)", () => {
  const txs = [
    { signature: "sell-first", slot: 1, blockTime: 100, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 500n, postRaw: 200n, deltaRaw: -300n }] },
  ];
  const rep = buildWalletReport(scanOf(txs), { registry });
  const wire = JSON.parse(JSON.stringify(rep));
  assert.equal(wire.tokens[0].netDeltaRaw, "-300");
});
