// the error contract and typing contract on the
// paths the first integrator never walked. A broken store event must be a typed 503
// kind:"parse", never a fabricated totalRaw:"0"; /crosscheck must not leak a bare 500;
// amountPerUnitRaw is a STRING everywhere (the README's own "decimal strings" rule);
// the dividend dedup keys on the calendar ex-day, not the exact instant (tz twins of one
// day are one dividend); a native 429 carries kind:"rate-limit"; /events is chronological.
import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/api/server.mjs";
import { bindMintAndValidate } from "../src/events/normalize-xstocks.mjs";

const MINT = "ContractMi" + "1".repeat(34);
const MINT2 = "ContractMx" + "2".repeat(34);
const ADDR = "R23Wa11et" + "a".repeat(34);
const REG = [
  { mint: MINT, symbol: "R23x", name: "Contract", issuer: "test", decimals: 6 },
  { mint: MINT2, symbol: "R23y", name: "Second", issuer: "test", decimals: 6 },
];

const div = (over = {}) => bindMintAndValidate([{
  type: "DIVIDEND_ACCRUAL",
  effectiveDate: "2026-02-01",
  status: "confirmed",
  sources: ["https://issuer.example/d"],
  amountPerUnitRaw: 2,
  decimals: 6,
  ...over,
}], MINT)[0];

// a CONTINUOUS chain (the timeline rejects discontinuities), built per index
const multEvent = (i, date) => bindMintAndValidate([{
  type: "MULTIPLIER_CHANGE",
  effectiveDate: date,
  status: "confirmed",
  sources: ["https://issuer.example/m"],
  multiplierFrom: String(i),
  multiplierTo: String(i + 1),
  reason: "split",
}], MINT2)[0];

const scan = (txs) => async () => ({ owner: ADDR, signatures: txs.length, fetched: txs.length, txs, skipped: [], truncated: false, accounts: {} });
const buy = (sig, qty, iso) => ({
  signature: sig, slot: 1, blockTime: Math.floor(Date.parse(iso) / 1000),
  deltas: [{ owner: ADDR, mint: MINT, preRaw: 0n, postRaw: 0n, deltaRaw: BigInt(qty) }],
});

async function withSrv(fn, opts = {}) {
  const server = await createApiServer({
    registry: REG,
    walletScanner: scan([buy("b1", 200n, "2026-01-01")]),
    ...opts,
  });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("accruals: a store event with an unparseable date — a typed 503 kind:parse, never a fabricated \"0\"", async () => {
  await withSrv(async (base) => {
    const r = await fetch(`${base}/accruals?symbol=R23x&address=${ADDR}`);
    assert.equal(r.status, 503, "refused, not answered");
    const body = await r.json();
    assert.equal(body.kind, "parse");
    assert.match(body.error, /accrual/i);
  }, {
    // a broken event placed into the store DIRECTLY (every validating path refuses it —
    // the consumer's question is what the API does when the store holds one anyway)
    events: [{ type: "DIVIDEND_ACCRUAL", effectiveDate: "2026-13-45", status: "confirmed", sources: ["https://issuer.example/d"], amountPerUnitRaw: 2, decimals: 6, mint: MINT }],
  });
});

test("crosscheck: a broken store event — a typed 503 kind:parse, not a bare internal 500", async () => {
  await withSrv(async (base) => {
    const r = await fetch(`${base}/crosscheck?symbol=R23x`);
    assert.notEqual(r.status, 200);
    const body = await r.json();
    if (r.status === 503) assert.equal(body.kind, "parse");
    assert.notEqual(body.error, "internal error", "the real reason, not the anonymous blanket");
  }, {
    events: [{ type: "DIVIDEND_ACCRUAL", effectiveDate: "2026-13-45", status: "confirmed", sources: ["https://issuer.example/d"], amountPerUnitRaw: 2, decimals: 6, mint: MINT }],
    priceProvider: { pool: async () => ({ address: "Po0l" + "p".repeat(39), price: "1" }), candles: async () => [] },
  });
});

test("events: amountPerUnitRaw is serialized as a STRING (the README's decimal-strings contract)", async () => {
  await withSrv(async (base) => {
    const rows = await (await fetch(`${base}/events?symbol=R23x`)).json();
    assert.equal(rows.length, 1);
    assert.equal(typeof rows[0].amountPerUnitRaw, "string", "/events used to leak the internal number");
    assert.equal(rows[0].amountPerUnitRaw, "2");
  }, { events: [div()] });
});

test("accruals dedup: tz twins of one calendar ex-day are ONE dividend finance F1)", async () => {
  await withSrv(async (base) => {
    const rows = await (await fetch(`${base}/accruals?symbol=R23x&address=${ADDR}`)).json();
    assert.equal(rows.length, 1, "2026-02-01 and 2026-02-01T00:00:00+02:00 are the same ex-day");
    assert.equal(rows[0].totalRaw, "400", "200 × 2 once, not 900-ish across two instants");
  }, {
    events: [
      div({ sources: ["https://issuer.example/press"] }),
      div({ effectiveDate: "2026-02-01T00:00:00+02:00", sources: ["https://api.issuer.example/node"] }),
    ],
  });
});

test("lots: a lying scanner (not a scan shape) — a real 500 with the reason, not the anonymous blanket", async () => {
  const server = await createApiServer({ registry: REG, walletScanner: async () => ({ nonsense: true }) });
  const { port } = server.address();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/lots?address=${ADDR}`);
    assert.equal(r.status, 500);
    const body = await r.json();
    assert.notEqual(body.error, "internal error");
    assert.match(body.error, /scan/i);
  } finally {
    server.close();
  }
});

test("rate limit: a native 429 body carries kind:\"rate-limit\" (the README error contract)", async () => {
  const server = await createApiServer({
    registry: REG,
    walletScanner: scan([buy("b1", 200n, "2026-01-01")]),
    rateLimits: { scan: { windowMs: 60_000, max: 1 }, rpc: { windowMs: 60_000, max: 60 } },
  });
  const { port } = server.address();
  try {
    await fetch(`http://127.0.0.1:${port}/lots?address=${ADDR}`);
    const r = await fetch(`http://127.0.0.1:${port}/lots?address=${ADDR}`);
    assert.equal(r.status, 429);
    const body = await r.json();
    assert.equal(body.kind, "rate-limit");
    assert.ok(r.headers.get("retry-after"));
  } finally {
    server.close();
  }
});

test("events: chronological order across mixed event types", async () => {
  await withSrv(async (base) => {
    const rows = await (await fetch(`${base}/events?symbol=R23y`)).json();
    const ts = rows.map((e) => Date.parse(e.effectiveDate));
    for (let i = 1; i < ts.length; i++) {
      assert.ok(ts[i - 1] <= ts[i], `row ${i} out of order: ${rows[i - 1].effectiveDate} then ${rows[i].effectiveDate}`);
    }
  }, { events: [multEvent(3, "2026-06-01T00:00:00Z"), multEvent(1, "2026-02-01T00:00:00Z"), multEvent(2, "2026-04-01T00:00:00Z")] });
});
