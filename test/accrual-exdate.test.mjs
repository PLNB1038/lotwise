// Round 21 (finance audit F1): the dividend accrual base is the position held ON THE
// EX-DATE, replayed from the scan window's deltas — not today's open FIFO lots. The old
// endpoint fed the engine the post-sale lot queue, so any sale after the ex-date silently
// shrank the dividend income (Scenario B of _bughunt/round21-f1: buy 200, ex-date, sell 100
// → the answer was [] or half the truth). Dividends are declared per ex-date holding;
// the report must not lose them to a later disposal.
import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/api/server.mjs";
import { bindMintAndValidate } from "../src/events/normalize-xstocks.mjs";

const A_MINT = "ExDateMint" + "1".repeat(34);
const A_ADDR = "ExDateAddr" + "1".repeat(34);
const A_SYMBOL = "EXDx";
const aRegistry = [{ mint: A_MINT, symbol: A_SYMBOL, name: "Ex-date Token", decimals: 6, issuer: "test" }];

const divEvent = (effectiveDate, amountPerUnitRaw) =>
  bindMintAndValidate([{
    type: "DIVIDEND_ACCRUAL",
    effectiveDate,
    status: "confirmed",
    sources: ["https://issuer.example/dividends/exdate"],
    amountPerUnitRaw,
    decimals: 6,
  }], A_MINT)[0];

const aTx = (signature, deltaRaw, isoDate, slot = 1) => ({
  signature,
  slot,
  blockTime: isoDate === null ? null : Math.floor(Date.parse(isoDate) / 1000),
  deltas: [{ owner: A_ADDR, mint: A_MINT, preRaw: 0n, postRaw: 0n, deltaRaw }],
});
const aScan = (txs) => ({
  owner: A_ADDR, signatures: txs.length, fetched: txs.length, txs, skipped: [], truncated: false, accounts: {},
});

async function withServer(fn, { events, txs }) {
  const server = await createApiServer({ registry: aRegistry, events, walletScanner: async () => aScan(txs) });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("accruals: a sale AFTER the ex-date does not shrink the dividend base (F1 scenario D)", async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/accruals?symbol=${A_SYMBOL}&address=${A_ADDR}`);
    assert.equal(r.status, 200);
    const rows = await r.json();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].totalRaw, "400", "200 held on the ex-date × 2, the later sale is irrelevant");
    assert.equal(rows[0].lotsConsidered, 2, "both buys formed the base");
  }, {
    events: [divEvent("2026-02-01", 2)],
    txs: [
      aTx("b1", 100n, "2026-01-01"),
      aTx("b2", 100n, "2026-01-05"),
      aTx("s1", -100n, "2026-02-20"), // the disposal — AFTER the ex-date
    ],
  });
});

test("accruals: a sale BEFORE the ex-date does shrink the base (the cutoff works both ways)", async () => {
  await withServer(async (base) => {
    const rows = await (await fetch(`${base}/accruals?symbol=${A_SYMBOL}&address=${A_ADDR}`)).json();
    assert.equal(rows[0].totalRaw, "200", "200 bought − 100 sold before the ex-date = 100 × 2");
  }, {
    events: [divEvent("2026-02-01", 2)],
    txs: [
      aTx("b1", 200n, "2026-01-01"),
      aTx("s1", -100n, "2026-01-15"),
    ],
  });
});

test("accruals: a position fully closed before the ex-date earns nothing, closed after — full base", async () => {
  await withServer(async (base) => {
    const rows = await (await fetch(`${base}/accruals?symbol=${A_SYMBOL}&address=${A_ADDR}`)).json();
    assert.equal(rows[0].totalRaw, "0", "nothing held on the ex-date");
  }, {
    events: [divEvent("2026-02-01", 2)],
    txs: [aTx("b1", 100n, "2026-01-01"), aTx("s1", -100n, "2026-01-15")],
  });
  await withServer(async (base) => {
    const rows = await (await fetch(`${base}/accruals?symbol=${A_SYMBOL}&address=${A_ADDR}`)).json();
    assert.equal(rows[0].totalRaw, "200", "bought back: the position existed on the ex-date again");
  }, {
    events: [divEvent("2026-02-01", 2)],
    txs: [aTx("b1", 100n, "2026-01-01"), aTx("s1", -100n, "2026-01-15"), aTx("b2", 100n, "2026-01-20")],
  });
});

test("accruals: a sale in the same second as the ex-date — the position is counted strictly before it", async () => {
  await withServer(async (base) => {
    const rows = await (await fetch(`${base}/accruals?symbol=${A_SYMBOL}&address=${A_ADDR}`)).json();
    assert.equal(rows[0].totalRaw, "400", "buy 200 counted (< ex-date), the same-second sale is not (<, not ≤): 200 × 2");
  }, {
    events: [divEvent("2026-02-01T00:00:00.000Z", 2)],
    txs: [aTx("b1", 200n, "2026-01-01"), aTx("s1", -100n, "2026-02-01T00:00:00.000Z")],
  });
});

test("accruals: honest incompleteness — a tx without blockTime or a scan gap flags the base", async () => {
  await withServer(async (base) => {
    const rows = await (await fetch(`${base}/accruals?symbol=${A_SYMBOL}&address=${A_ADDR}`)).json();
    assert.equal(rows[0].baseIncomplete, true, "a tx that cannot be ordered against the ex-date flags the base");
    assert.equal(rows[0].totalRaw, "100", "what the window knows is still reported: (100 known buy − 50 sale) × 2, the undated buy only flags");
  }, {
    events: [divEvent("2026-02-01", 2)],
    txs: [aTx("b1", 100n, "2026-01-01"), aTx("b2", 100n, null), aTx("s1", -50n, "2026-01-20")],
  });
});

test("accruals: no sales — same answer as the engine always gave (the control)", async () => {
  await withServer(async (base) => {
    const rows = await (await fetch(`${base}/accruals?symbol=${A_SYMBOL}&address=${A_ADDR}`)).json();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].totalRaw, "6000000", "3M × 2, unchanged from the pre-F1 behavior");
    assert.equal(rows[0].lotsConsidered, 2);
    assert.equal(rows[0].baseIncomplete, undefined);
  }, {
    events: [divEvent("2026-09-10", 2)],
    txs: [aTx("a", 1_000_000n, "2026-09-01"), aTx("b", 2_000_000n, "2026-09-05")],
  });
});

test("accruals: a scan gap (spend without coverage) flags the base incomplete", async () => {
  await withServer(async (base) => {
    const rows = await (await fetch(`${base}/accruals?symbol=${A_SYMBOL}&address=${A_ADDR}`)).json();
    assert.equal(rows[0].baseIncomplete, true, "the window never saw the opening balance — the ex-date base is not guaranteed");
    assert.equal(rows[0].totalRaw, null, "round 22 (F4): a negative base is not a number — the window knows only the disposal; null, not -100 an integrator would subtract");
  }, {
    events: [divEvent("2026-02-01", 1)],
    txs: [aTx("s1", -100n, "2026-01-15")], // sells what predates the window: a gap
  });
});

// Round 22 (finance-v2 F1): the engine's semantic dividend dedup (round 21) must reach
// the ONLY live consumer. One dividend reaching the store from two sources (a press page
// and an API node) used to double /accruals rows after the ex-date rewrite bypassed the engine.
test("accruals: the same dividend from two sources — a single row, not doubled income", async () => {
  const div = (sources) =>
    bindMintAndValidate([{
      type: "DIVIDEND_ACCRUAL",
      effectiveDate: "2026-02-01",
      status: "confirmed",
      sources,
      amountPerUnitRaw: 2,
      decimals: 6,
    }], A_MINT)[0];
  await withServer(async (base) => {
    const rows = await (await fetch(`${base}/accruals?symbol=${A_SYMBOL}&address=${A_ADDR}`)).json();
    assert.equal(rows.length, 1, "one economics — one row");
    assert.equal(rows[0].totalRaw, "400", "200 × 2, not doubled");
  }, {
    events: [div(["https://issuer.example/press/q1"]), div(["https://api.issuer.example/nodes/q1"])],
    txs: [aTx("b1", 200n, "2026-01-01")],
  });
});

// Round 22 (F3): a truncated scan window silently understated the ex-date base — the
// flag now travels like gaps and undated transactions do.
test("accruals: a truncated window flags the base incomplete (history beyond the cap is unknown)", async () => {
  const { scanWallet } = await import("../src/wallet/scan.mjs");
  void scanWallet;
  const events = [divEvent("2026-02-01", 2)];
  const txs = [aTx("b1", 200n, "2026-01-01")];
  await (async () => {
    const server = await createApiServer({
      registry: aRegistry,
      events,
      walletScanner: async () => ({ owner: A_ADDR, signatures: 1, fetched: 1, txs, skipped: [], truncated: true, accounts: {} }),
    });
    const { port } = server.address();
    try {
      const rows = await (await fetch(`http://127.0.0.1:${port}/accruals?symbol=${A_SYMBOL}&address=${A_ADDR}`)).json();
      assert.equal(rows[0].baseIncomplete, true, "the cap cut the window — the ex-date base is not guaranteed");
      assert.equal(rows[0].totalRaw, "400", "what the window saw is still reported");
    } finally {
      server.close();
    }
  })();
});
