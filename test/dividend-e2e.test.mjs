// An end-to-end (e2e) test of the dividend scenario: a synthetic DIVIDEND_ACCRUAL event
// passes the actual pipeline path — the schema → mint binding → the lot engine → the API.
// No network: its own synthetic registry (the mint is NOT from the live data/tokens.json),
// a mock walletScanner, a server on 127.0.0.1:0.
//
// The path map (from the actual code, not guesses):
//   validateEvent (schema/events.mjs): DIVIDEND_ACCRUAL requires type/mint/effectiveDate/
//     status/sources + amountPerUnitRaw (an integer > 0) and decimals (an integer 0..18).
//     The schema has NOT two dates: there is only effectiveDate (the ex-date), no payout date.
//   bindMintAndValidate (events/normalize-xstocks.mjs): binding the event to the mint.
//   applyEvents (lots/lots.mjs): the accrual TO THE OWNER —
//     totalRaw = BigInt(amountPerUnitRaw) × Σ qtyRaw of that owner's lots,
//     bought STRICTLY EARLIER than effectiveDate; the lots' qty/basis are unchanged.
//     decimals does NOT participate in the arithmetic — it is metadata for the display layer.
//   API (api/server.mjs): /events and /summary serve the event; /lots does NOT serve
//     accruals: the applyEvents engine is not connected to the API (GAP 2, pinned below).
//
// Synthetics: mints/owners — valid base58 (without 0/O/I/l), 44 chars,
// absent from the live registry. The numbers are integers (BigInt), as in the engine.
import test from "node:test";
import assert from "node:assert/strict";
import { validateEvent, EventValidationError } from "../src/schema/events.mjs";
import { multiplierHistoryToEvents, bindMintAndValidate } from "../src/events/normalize-xstocks.mjs";
import { applyEvents, LotError } from "../src/lots/lots.mjs";
import { crossCheckEvents } from "../src/events/crosscheck.mjs";
import { createApiServer } from "../src/api/server.mjs";

// ---- synthetic constants (valid base58, not from the live registry) ----

const MINT = "DivE2eMint" + "1".repeat(34); // 44 chars
const MINT_OTHER = "DivE2eNone" + "1".repeat(34); // a foreign mint for negative scenarios
const OWNER_A = "DivAddrA" + "1".repeat(36);
const OWNER_B = "DivAddrB" + "1".repeat(36);
const SYMBOL = "DVTx";

// A synthetic registry: one dividend token. The fields — like loadRegistry records
// (report.mjs reads symbol/name/decimals, /summary reads issuer).
const registry = [
  { mint: MINT, symbol: SYMBOL, name: "Dividend Test Token (synthetic)", decimals: 6, issuer: "test-issuer" },
];

// The dividend: $2.00 per whole token, the token and the payout both 6 decimals.
// amountPerUnitRaw — raw units of the PAYOUT per one raw unit of the TOKEN (the engine multiplies raw×raw):
// 2 payout raw × the token qtyRaw. An integer — the schema does not accept fractions.
// The ex-date — 2026-09-10.
const dividendEvent = bindMintAndValidate([{
  type: "DIVIDEND_ACCRUAL",
  effectiveDate: "2026-09-10", // the ex-date (the only date in the schema)
  status: "confirmed",
  sources: ["https://issuer.example/dividends/2026-q3"],
  amountPerUnitRaw: 2,
  decimals: 6,
}], MINT)[0];

// blockTime in the scan — seconds (report.mjs: new Date(blockTime * 1000))
const ts = (isoDate) => Math.floor(Date.parse(isoDate) / 1000);

const buy = (signature, mint, qty, isoDate) => ({
  signature, slot: 1, blockTime: ts(isoDate),
  deltas: [{ owner: OWNER_A, mint, preRaw: 0n, postRaw: qty, deltaRaw: qty }],
});

const scanOf = (txs, extra = {}) => ({
  owner: OWNER_A, signatures: txs.length, fetched: txs.length, txs, skipped: [], truncated: false, ...extra,
});

async function withServer(fn, { events = [dividendEvent], walletScanner = null } = {}) {
  const server = await createApiServer({ registry, events, walletScanner });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

// ---- scenario 1: "the dividend arrived into the position" — the end-to-end path ----

test("scenario 1 (event): a synthetic DIVIDEND_ACCRUAL arrives into /events, /summary, /health", async () => {
  await withServer(async (base) => {
    // /events: the event is bound to the mint, the fields are not distorted; the type filter works
    const list = await (await fetch(`${base}/events?symbol=${SYMBOL}&type=DIVIDEND_ACCRUAL`)).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].type, "DIVIDEND_ACCRUAL");
    assert.equal(list[0].mint, MINT);
    assert.equal(list[0].effectiveDate, "2026-09-10");
    assert.equal(list[0].amountPerUnitRaw, "2"); // round 23: decimal strings on the wire (was the internal number)
    assert.equal(list[0].decimals, 6);
    assert.equal(list[0].status, "confirmed");
    assert.deepEqual(list[0].sources, ["https://issuer.example/dividends/2026-q3"]);

    // /summary: the event counted for the token; the multiplier an honest "1" — a dividend is not a rebase,
    // the mint has no MULTIPLIER_CHANGE timeline and it is not excluded from the vitrine
    const rows = await (await fetch(`${base}/summary`)).json();
    const row = rows.find((r) => r.symbol === SYMBOL);
    assert.equal(row.events, 1);
    assert.equal(row.currentMultiplier, "1");
    assert.equal("excluded" in row, false);

    // /health: the event in the total counter
    const h = await (await fetch(`${base}/health`)).json();
    assert.equal(h.events, 1);
  });
});

test("scenario 1 (money): /lots serves the position, the engine accrues onto it, the numbers converge", async () => {
  // the position: two buys before the ex-date, one owner
  const txs = [
    buy("a", MINT, 1_000_000n, "2026-09-01"),
    buy("b", MINT, 1_500_000n, "2026-09-05"),
  ];
  const scanner = async () => scanOf(txs, {
    accounts: new Map([[MINT, { address: OWNER_A, currentRaw: 2_500_000n }]]),
  });
  await withServer(async (base) => {
    const rep = await (await fetch(`${base}/lots?address=${OWNER_A}`)).json();
    const row = rep.tokens.find((t) => t.mint === MINT);
    assert.equal(row.symbol, SYMBOL);
    assert.equal(row.rawBalance, "2500000"); // 1M + 1.5M raw
    assert.equal(row.lots.length, 2);
    assert.equal(row.reconciles, true); // the window deltas converge with the on-chain balance
    assert.equal(row.multiplier.events, 0); // the dividend did not get into the multiplier timeline

    // the documented seam (report.mjs header + round6-report-lots): a /lots consumer
    // assembles the engine context — the report lots carry NO mint/owner/basisRaw.
    const engineLots = row.lots.map((l) => ({
      ...l, mint: row.mint, owner: rep.owner, qtyRaw: BigInt(l.qtyRaw), basisRaw: 0n,
    }));
    const { lots, accruals, applied } = applyEvents(engineLots, [dividendEvent]);

    assert.equal(applied, 1);
    // the lots are untouched by the dividend: qty and dates as they were
    assert.deepEqual(lots.map((l) => l.qtyRaw), [1_000_000n, 1_500_000n]);

    // the accrual to the owner: both pre-ex-date buys aggregated into ONE record
    assert.equal(accruals.length, 1);
    const a = accruals[0];
    assert.equal(a.owner, OWNER_A);
    assert.equal(a.mint, MINT);
    assert.equal(a.amountPerUnitRaw, 2n);
    assert.equal(a.decimals, 6);
    // TOTAL: totalRaw = amountPerUnitRaw × Σ qtyRaw = 2 × 2 500 000 = 5 000 000 payout raw
    // (= 5.0 units at decimals 6; 2.5 tokens × $2.00). Cross-checked with the numbers FROM the API response:
    assert.equal(a.totalRaw, 2n * row.lots.reduce((acc, l) => acc + BigInt(l.qtyRaw), 0n));
    assert.equal(a.totalRaw, 5_000_000n);
  }, { walletScanner: scanner });
});

// ---- scenario 2: "a dividend without a position" — breaks nothing, no accrual ----

test("scenario 2 (engine): no lots and a foreign mint — accruals empty, the application is safe", () => {
  const none = applyEvents([], [dividendEvent]);
  assert.deepEqual(none.accruals, []);
  assert.deepEqual(none.lots, []);
  assert.equal(none.applied, 1); // the event applied (computed), but there are no holders

  // a position in a FOREIGN mint: the dividend does not carry over
  const other = applyEvents([{
    id: "X1", mint: MINT_OTHER, owner: OWNER_A, qtyRaw: 999n, acquiredDate: "2026-09-01", basisRaw: 1n,
  }], [dividendEvent]);
  assert.deepEqual(other.accruals, []);
  assert.equal(other.lots[0].qtyRaw, 999n); // the foreign position untouched
});

test("scenario 2 (API): a wallet without a position — /lots empty, the event lives in /events", async () => {
  const scanner = async () => scanOf([]); // an empty scan
  await withServer(async (base) => {
    const rep = await (await fetch(`${base}/lots?address=${OWNER_A}`)).json();
    assert.deepEqual(rep.tokens, []); // neither a position nor invented rows
    // there are no accruals in the response at all — over the whole wire format
    assert.equal(JSON.stringify(rep).includes("accrual"), false);

    // meanwhile the event is served: an event ≠ an accrual, it exists without a position
    const list = await (await fetch(`${base}/events?symbol=${SYMBOL}&type=DIVIDEND_ACCRUAL`)).json();
    assert.equal(list.length, 1);
  }, { walletScanner: scanner });
});

// ---- scenario 3: "a dividend between two buys" — only lots on the ex-date ----

test("scenario 3: a buy AFTER the ex-date gets no accrual, BEFORE — does", () => {
  const { accruals } = applyEvents([
    { id: "L1", mint: MINT, owner: OWNER_A, qtyRaw: 1_000_000n, acquiredDate: "2026-09-01", basisRaw: 1n },
    { id: "L2", mint: MINT, owner: OWNER_A, qtyRaw: 700_000n, acquiredDate: "2026-09-20", basisRaw: 1n },
  ], [dividendEvent]);
  assert.equal(accruals.length, 1);
  assert.equal(accruals[0].totalRaw, 2n * 1_000_000n, "only the lot bought before the ex-date is in the base");
});

test("scenario 3 (boundary): one bought ON the ex-date is excluded; within the day the comparison is unix-ms", () => {
  // "strictly earlier": one bought date-only on the event day — already by post-event rules
  const sameDay = applyEvents([
    { id: "L1", mint: MINT, owner: OWNER_A, qtyRaw: 100n, acquiredDate: "2026-09-10", basisRaw: 1n },
  ], [dividendEvent]);
  assert.deepEqual(sameDay.accruals, []);

  // the event at midnight UTC: a buy at 12:00 of the same day — LATER than the event (a numeric comparison,
  // not lexicographic), a buy a second before midnight — BEFORE
  const intraday = applyEvents([
    { id: "early", mint: MINT, owner: OWNER_A, qtyRaw: 10n, acquiredDate: "2026-09-09T23:59:59Z", basisRaw: 1n },
    { id: "late", mint: MINT, owner: OWNER_A, qtyRaw: 20n, acquiredDate: "2026-09-10T12:00:00Z", basisRaw: 1n },
  ], [dividendEvent]);
  assert.equal(intraday.accruals.length, 1);
  assert.equal(intraday.accruals[0].totalRaw, 2n * 10n);
});

test("scenario 3 (owners): two owners — two records; two lots of one owner — one sum", () => {
  const { accruals } = applyEvents([
    { id: "A1", mint: MINT, owner: OWNER_A, qtyRaw: 100n, acquiredDate: "2026-09-01", basisRaw: 1n },
    { id: "A2", mint: MINT, owner: OWNER_A, qtyRaw: 40n, acquiredDate: "2026-09-02", basisRaw: 1n },
    { id: "B1", mint: MINT, owner: OWNER_B, qtyRaw: 60n, acquiredDate: "2026-09-03", basisRaw: 1n },
    { id: "A3", mint: MINT, owner: OWNER_A, qtyRaw: 50n, acquiredDate: "2026-09-20", basisRaw: 1n }, // after the ex-date
  ], [dividendEvent]);
  assert.equal(accruals.length, 2);
  const byOwner = new Map(accruals.map((a) => [a.owner, a.totalRaw]));
  assert.equal(byOwner.get(OWNER_A), 2n * 140n); // A1+A2, A3 missed
  assert.equal(byOwner.get(OWNER_B), 2n * 60n);

  // the input is not mutated: the accrual is a separate record, the lots as they were
  const input = [{ id: "Z1", mint: MINT, owner: OWNER_A, qtyRaw: 11n, acquiredDate: "2026-09-01", basisRaw: 7n }];
  const { lots } = applyEvents(input, [dividendEvent]);
  assert.equal(input[0].qtyRaw, 11n);
  assert.deepEqual(lots[0], input[0]);
});

// ---- the schema is fail-closed: a broken dividend is rejected BEFORE the engine ----

test("schema: amountPerUnitRaw 0/negative/fractional and decimals outside 0..18 are rejected", () => {
  const bad = (over) => ({ ...dividendEvent, ...over });
  for (const e of [
    bad({ amountPerUnitRaw: 0 }),
    bad({ amountPerUnitRaw: -5 }),
    bad({ amountPerUnitRaw: 1.5 }), // a fraction forbidden: the engine multiplies BigInt
    bad({ decimals: 19 }),
    bad({ decimals: -1 }),
    bad({ decimals: undefined }),
    bad({ effectiveDate: "2026-13-45" }), // a garbage date — does not reach Date.parse
  ]) {
    assert.throws(() => validateEvent(e), EventValidationError, JSON.stringify(e));
    // the engine wraps into a LotError BEFORE changing the state (atomicity)
    assert.throws(() => applyEvents([{
      id: "L", mint: MINT, owner: OWNER_A, qtyRaw: 1n, acquiredDate: "2026-09-01", basisRaw: 1n,
    }], [e]), LotError);
  }
});

// ---- GAP pins: an honest fixation of the actual state (the behavior is NOT invented) ----

test("GAP 1: no DIVIDEND_ACCRUAL producer exists in src — an issuer dividend arrives only as MULTIPLIER_CHANGE", () => {
  // The fact: the only source normalizer (normalize-xstocks) produces ONLY
  // MULTIPLIER_CHANGE, even when the issuer's reason is "Dividend" (a node of exactly the shape
  // the issuer's multiplier history serves). In src/ no module creates
  // a DIVIDEND_ACCRUAL (the string occurs only in the schema, lots and the UI text): the type
  // is reachable only via external/manual submission, as in this file. Hence the "dividend
  // path" on live sources is today computed as a multiplier rebase, not an accrual.
  const events = multiplierHistoryToEvents([
    { id: "node-1", reason: "Dividend", previousMultiplier: "1", multiplier: "1.005",
      activationDateTime: "2026-06-18T00:00:00.000Z" },
  ], { symbol: SYMBOL });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "MULTIPLIER_CHANGE");
  assert.equal(events[0].reason, "Dividend");
});

test("GAP 2: the lot engine is not connected to the API — /lots serves no accruals", async () => {
  // The fact by code: server.mjs and report.mjs do NOT call applyEvents (a mention in report.mjs —
  // only in a contract comment). Pinned by the vitrine: the full /lots wire response has neither an
  // accruals field nor an accrual sum. The accrual exists only until an external
  // consumer computes it (as in scenario 1).
  const txs = [buy("a", MINT, 1_000_000n, "2026-09-01")];
  const scanner = async () => scanOf(txs);
  await withServer(async (base) => {
    const rep = await (await fetch(`${base}/lots?address=${OWNER_A}`)).json();
    const wire = JSON.stringify(rep);
    assert.equal(wire.includes("accrual"), false, "accruals do not arrive into /lots");
    assert.equal(wire.includes("dividend"), false);
    // meanwhile the engine accrues on the same data — a gap between the engine and the vitrine
    const row = rep.tokens.find((t) => t.mint === MINT);
    const engineLots = row.lots.map((l) => ({ ...l, mint: row.mint, owner: rep.owner, qtyRaw: BigInt(l.qtyRaw), basisRaw: 0n }));
    const { accruals } = applyEvents(engineLots, [dividendEvent]);
    assert.equal(accruals[0].totalRaw, 2_000_000n); // the engine would accrue
  }, { walletScanner: scanner });
});

test("GAP 3: the engine accrual carries BigInt — it does not serialize into a JSON response directly", () => {
  // The fact: accruals.push({ ..., amountPerUnitRaw: BigInt, totalRaw: BigInt }) (lots.mjs).
  // JSON.stringify on a BigInt throws: serving accruals through the server's json() helper as is
  // would give a 500. The working path — a manual String() adapter, as report.mjs does for lots.
  const { accruals } = applyEvents([{
    id: "L", mint: MINT, owner: OWNER_A, qtyRaw: 1_000_000n, acquiredDate: "2026-09-01", basisRaw: 1n,
  }], [dividendEvent]);
  assert.throws(() => JSON.stringify(accruals[0]), /Do not know how to serialize a BigInt/);
  // a consumer adapter (any endpoint would have to do the same):
  const wire = { ...accruals[0], amountPerUnitRaw: String(accruals[0].amountPerUnitRaw), totalRaw: String(accruals[0].totalRaw) };
  assert.equal(JSON.parse(JSON.stringify(wire)).totalRaw, "2000000");
});

test("GAP 4 (closed): /crosscheck now gives a DIVIDEND_ACCRUAL verdict — no silent filtering", () => {
  // It was (a fact pin): crossCheckEvents filtered the input to MULTIPLIER_CHANGE — a dividend
  // was not checked against the market price at all: no verdict, no mention in the output.
  // Closed in src/events/crosscheck.mjs (crossCheckDividendAccrual): an honest signature
  // of the drop in the token's raw units (rawClosePrev − amountPerUnitRaw ≈ rawCloseEx),
  // the verdict is marked type: "DIVIDEND_ACCRUAL" and goes at the tail of the verdict list
  // (after all MULTIPLIER_CHANGE — the vitrine contract of src/ui/page.mjs is not broken).
  const { verdicts } = crossCheckEvents([dividendEvent], []);
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].type, "DIVIDEND_ACCRUAL");
  assert.equal(verdicts[0].amountPerUnitRaw, 2);
  // no candles — an honest "no price", not an invented verdict (the same taxonomy as the rebase)
  assert.equal(verdicts[0].verdict, "no-price-data");
});

test("GAP 5: the schema has no payout date — effectiveDate is the only accrual date", () => {
  // The fact: validateEvent for DIVIDEND_ACCRUAL requires only amountPerUnitRaw and decimals;
  // the exDate/payDate/recordDate fields are not in the schema. The accrual is dated by the ex-date —
  // "when the money arrives" the schema cannot express. A contract pin, the behavior unchanged.
  const e = { ...dividendEvent };
  assert.equal(validateEvent(e), true);
  assert.equal("payDate" in e, false);
  assert.equal("recordDate" in e, false);
});
