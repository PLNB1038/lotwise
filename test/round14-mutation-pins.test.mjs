// Раунд 14 — киллер-тесты мутационного аудита (_bughunt/e1-*): каждая выжившая
// мутация = класс бага, который сьют не ловил. Эти пины обязаны быть ЗЕЛЁНЫМИ против
// текущего кода (код корректен, дырявым был сьют); покрасневший пин = мутационник
// нашёл настоящий баг.
//   J01 journal: реплей легаси-«5.0»-истории поверх НОВОЙ ротации обязан эмитить событие
//   W03 wallet: гэп скана → complete:false (контракт-пин; выражение частично избыточно
//        при reconciles, см. e1-отчёт W03/W05 — defense-in-depth)
//   E02 schema: суб-единичные и ведущие-нулевые множители канонизируются предсказуемо
//   I02/I04/I05 isodate: век 2100 (не високос), дробь секунды .5=500мс, оффсет-минуты 60+
//   R03 rpc: error.code:null + message-транзиент → ретраи, итог kind "rate-limit"
//   T02 timeline: схема-валидная 30-значная дробь строит таймлайн (граница «пары»)
//   E05 schema: обязательное строковое поле "" — отказ, а не «валидно»
//   S05 api: lotsConsidered строго раньше effectiveDate (лот ровно В экс-дату не в базе)
import test from "node:test";
import assert from "node:assert/strict";
import { planJournalStep } from "../src/events/journal.mjs";
import { parseScaledUiAmount } from "../src/issuer/scaled-ui.mjs";
import { canonicalDecimalString } from "../src/schema/events.mjs";
import { parseIsoDateMs } from "../src/schema/isodate.mjs";
import { RpcClient, RpcError } from "../src/ingest/rpc.mjs";
import { MultiplierTimeline } from "../src/lots/timeline.mjs";
import { buildWalletReport } from "../src/wallet/report.mjs";
import { loadRegistry } from "../src/registry/registry.mjs";
import { createApiServer } from "../src/api/server.mjs";
import { bindMintAndValidate } from "../src/events/normalize-xstocks.mjs";

const MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const SPYx = MINT;
const TOKEN = { mint: MINT, symbol: "TESTx" };
const OWNER = "DivAddrA" + "1".repeat(36);

const mintState = (state) => ({
  owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  data: { parsed: { info: { decimals: 8, extensions: [{ extension: "scaledUiAmountConfig", state: { newMultiplierEffectiveTimestamp: 0, ...state } }] } } },
});
const settled = (m) => mintState({ multiplier: m, newMultiplier: 0 });

// ---- J01: легаси-«5.0» поверх новой ротации ----

test("journal: легаси-запись с «5.0» в истории + цепь ушла на 6 — ротация ЭМИТИТСЯ", () => {
  const priorEntry = {
    lastEffective: "5", // уже каноничен
    observedAt: "2026-09-01T00:00:00.000Z",
    events: [{ effectiveDate: "2026-06-10T04:30:00.000Z", multiplierFrom: "1", multiplierTo: "5.0", reason: "legacy build" }], // сырая репрезентация старого билда
  };
  const r = planJournalStep(TOKEN, priorEntry, parseScaledUiAmount(settled("6")));
  assert.notEqual(r.event, null, "реальная ротация 5→6 не глотается из-за сырой старой записи");
  assert.equal(r.entry.lastEffective, "6");
});

// ---- W03: гэп → complete:false (контракт-пин) ----

test("wallet: непокрытый расход (гэп) — complete:false, даже если прочие флаги чистые", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const txs = [
    { signature: "sell-first", slot: 1, blockTime: 100, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 500n, postRaw: 200n, deltaRaw: -300n }] },
    { signature: "buy-later", slot: 2, blockTime: 200, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 200n, postRaw: 260n, deltaRaw: 60n }] },
  ];
  const rep = buildWalletReport(
    { owner: OWNER, signatures: 2, fetched: 2, txs, skipped: [], truncated: false, accounts: {} },
    { registry },
  );
  assert.equal(rep.tokens.find((t) => t.mint === SPYx).gaps.length, 1, "гэп зафиксирован");
  assert.equal(rep.complete, false, "гэп ⇒ неполный отчёт — наблюдаемый контракт для потребителей");
});

// ---- E02: суб-единичные множители ----

test("schema: canonicalDecimalString суб-единиц и ведущих нулей — предсказуемо", () => {
  assert.equal(canonicalDecimalString("0.5"), "0.5", "суб-единичный множитель не теряет ведущий ноль");
  assert.equal(canonicalDecimalString("0"), "0", "ноль остаётся нулём, а не пустой строкой");
  assert.equal(canonicalDecimalString("00.500"), "0.5", "ведущие и хвостовые нули схлопываются до канона");
  assert.equal(canonicalDecimalString("0.0040015369331659"), "0.0040015369331659", "реальный дивидендный множитель JPMx-класса — без искажений");
});

// ---- I02 / I04 / I05: границы isodate ----

test("isodate: правило века — 2100-02-29 отвергается, 2000-02-29 валиден", () => {
  assert.equal(parseIsoDateMs("2100-02-29"), null, "2100 НЕ високосный (делится на 100, не на 400)");
  assert.equal(parseIsoDateMs("1900-02-29"), null);
  assert.notEqual(parseIsoDateMs("2000-02-29"), null, "2000 високосный (делится на 400)");
  assert.notEqual(parseIsoDateMs("2400-02-29"), null);
});

test("isodate: дробная секунда .5 — это 500 мс, не 50 и не 5000", () => {
  const base = parseIsoDateMs("2026-09-24T00:00:00Z");
  const half = parseIsoDateMs("2026-09-24T00:00:00.5Z");
  assert.equal(half - base, 500, "доля секунды читается до третьего знака как есть");
});

test("isodate: минуты оффсета 60+ («+01:60») — мусор, null", () => {
  assert.equal(parseIsoDateMs("2026-09-24T00:00:00+01:60"), null);
  assert.equal(parseIsoDateMs("2026-09-24T00:00:00+01:99"), null);
  assert.notEqual(parseIsoDateMs("2026-09-24T00:00:00+01:59"), null, "валидная минута проходит");
});

// ---- R03: code:null + message-транзиент ----

test("rpc: {code:null, message:\"node is behind…\"} — транзиент с ретраями, итог rate-limit", async () => {
  let calls = 0;
  const client = new RpcClient({
    endpoint: "https://rpc.example",
    fetcher: async () => {
      calls++;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: null, message: "node is behind by 12 slots" } }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
    sleep: async () => {}, minIntervalMs: 0, maxRetries: 2,
  });
  await assert.rejects(() => client.call("m", []), (err) => {
    assert.equal(err.kind, "rate-limit", "исчерпание message-транзиентов — класс rate-limit, не фатальный rpc");
    return err instanceof RpcError;
  });
  assert.equal(calls, 3, "1 + 2 ретрая — null-код не делает ошибку детерминированной");
});

// ---- T02: 30-значная дробь на границе контракта ----

test("timeline: множитель с 30-значной дробью (граница схемы) строит таймлайн", () => {
  const to = "1." + "3".repeat(30); // 30 знаков — валидно по контракту «пара»
  const mult = bindMintAndValidate([{
    type: "MULTIPLIER_CHANGE", effectiveDate: "2026-06-10", status: "confirmed",
    sources: ["test"], multiplierFrom: "1", multiplierTo: to, reason: "precision boundary",
  }], MINT);
  const tl = new MultiplierTimeline(mult);
  assert.equal(tl.multiplierAt("2026-06-09"), "1");
  assert.equal(tl.multiplierAt("2026-06-11"), to, "значение на границе допуска не исключает токен из витрины");
});

// ---- E05: пустая строка в обязательном поле ----

test("schema: обязательное поле-строка «» — отказ валидации (TICKER_CHANGE newSymbol)", async () => {
  const { validateEvent, EventValidationError } = await import("../src/schema/events.mjs");
  assert.throws(
    () => validateEvent({
      type: "TICKER_CHANGE", mint: MINT, effectiveDate: "2026-06-10", status: "confirmed",
      sources: ["test"], oldSymbol: "OLDx", newSymbol: "", reason: "empty target",
    }),
    EventValidationError,
    "пустая строка — не «новый тикер», а мусор",
  );
});

// ---- S05: lotsConsidered строго раньше экс-даты ----

test("api: /accruals — лот, купленный РОВНО в effectiveDate, не попадает в lotsConsidered", async () => {
  const A_MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
  const A_ADDR = OWNER;
  const registry = [{ mint: A_MINT, symbol: "SPYx", name: "t", decimals: 6, issuer: "test" }];
  const events = bindMintAndValidate([{
    type: "DIVIDEND_ACCRUAL", effectiveDate: "2026-09-10", status: "confirmed",
    sources: ["test"], amountPerUnitRaw: 2, decimals: 6,
  }], A_MINT);
  const buy = (sig, qty, iso) => ({
    signature: sig, slot: 1, blockTime: Math.floor(Date.parse(iso) / 1000),
    deltas: [{ owner: A_ADDR, mint: A_MINT, preRaw: 0n, postRaw: qty, deltaRaw: qty }],
  });
  const txs = [
    buy("before", 1_000_000n, "2026-09-09T23:59:59Z"),
    buy("exactly-on", 5_000_000n, "2026-09-10T00:00:00Z"), // ровно экс-дата
  ];
  const server = await createApiServer({
    registry, events,
    walletScanner: async () => ({ owner: A_ADDR, signatures: txs.length, fetched: txs.length, txs, skipped: [], truncated: false, accounts: {} }),
  });
  const { port } = server.address();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/accruals?symbol=SPYx&address=${A_ADDR}`);
    assert.equal(r.status, 200);
    const rows = await r.json();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].lotsConsidered, 1, "только строго-ранний лот; купленный ровно в экс-дату — как и движок");
  } finally {
    server.close();
  }
});
