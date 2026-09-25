// the dividend accrual base is the position held ON THE
// EX-DATE, replayed from the scan window's deltas — not today's open FIFO lots. The old
// endpoint fed the engine the post-sale lot queue, so any sale after the ex-date silently
// shrank the dividend income (buy 200, ex-date, sell 100
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
  // the control must model a scan that RECONCILES: a live account whose balance equals
  // the window's net delta. (The shared aScan helper carries no accounts, which is a
  // chain-disagreeing scan — exactly what baseIncomplete exists to flag.)
  const txs = [aTx("a", 1_000_000n, "2026-09-01"), aTx("b", 2_000_000n, "2026-09-05")];
  const server = await createApiServer({
    registry: aRegistry,
    events: [divEvent("2026-09-10", 2)],
    walletScanner: async () => ({
      owner: A_ADDR, signatures: txs.length, fetched: txs.length, txs, skipped: [], truncated: false,
      accounts: new Map([[A_MINT, { addresses: ["Ata" + "1".repeat(41)], currentRaw: 3_000_000n }]]),
    }),
  });
  const { port } = server.address();
  try {
    const rows = await (await fetch(`http://127.0.0.1:${port}/accruals?symbol=${A_SYMBOL}&address=${A_ADDR}`)).json();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].totalRaw, "6000000", "3M × 2, unchanged from the pre-F1 behavior");
    assert.equal(rows[0].lotsConsidered, 2);
    assert.equal(rows[0].baseIncomplete, undefined);
  } finally {
    server.close();
  }
});

test("accruals: a scan gap (spend without coverage) flags the base incomplete", async () => {
  await withServer(async (base) => {
    const rows = await (await fetch(`${base}/accruals?symbol=${A_SYMBOL}&address=${A_ADDR}`)).json();
    assert.equal(rows[0].baseIncomplete, true, "the window never saw the opening balance — the ex-date base is not guaranteed");
    assert.equal(rows[0].totalRaw, null, " (F4): a negative base is not a number — the window knows only the disposal; null, not -100 an integrator would subtract");
  }, {
    events: [divEvent("2026-02-01", 1)],
    txs: [aTx("s1", -100n, "2026-01-15")], // sells what predates the window: a gap
  });
});

// the engine's semantic dividend dedup must reach
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

// a truncated scan window silently understated the ex-date base — the
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

// the store order must not decide money. A tz twin's
// effectiveDate ("2026-02-01T00:00:00+02:00") has a different INSTANT than "2026-02-01" —
// the dedup kept the first and ITS instant became the base, so the same declarations in
// two row orders answered 200 vs a confident "0". The base is now the UTC midnight of the
// calendar ex-day, identically for both twins, and the producer canonicalizes to date-only.
test("accruals: tz twins in EITHER store order give the same money (the ex-day's UTC midnight is the base)", async () => {
  const twinA = () => divEvent("2026-02-01", 2); // date-only: 2026-02-01T00:00:00Z
  const twinB = () => divEvent("2026-02-01T00:00:00+02:00", 2); // 2026-01-31T22:00:00Z — same DAY
  const buyAtEdge = aTx("b1", 100n, "2026-01-31T23:30:00.000Z"); // between the two instants
  for (const [name, events] of [["date-only first", [twinA(), twinB()]], ["tz first", [twinB(), twinA()]]]) {
    await withServer(async (base) => {
      const rows = await (await fetch(`${base}/accruals?symbol=${A_SYMBOL}&address=${A_ADDR}`)).json();
      assert.equal(rows.length, 1, `${name}: one dividend`);
      assert.equal(rows[0].totalRaw, "200", `${name}: the calendar day's base — 100 held on Feb 1 UTC — same money in both orders`);
    }, { events, txs: [buyAtEdge] });
  }
});

// the engine's dedup identity is the same calendar day — the route and the
// library must not diverge on the seam f704599 was fixing.
test("engine: applyEvents dedups tz twins of one calendar ex-day (parity with the route)", async () => {
  const { applyEvents } = await import("../src/lots/lots.mjs");
  const ev = (date, sources) => bindMintAndValidate([{
    type: "DIVIDEND_ACCRUAL", effectiveDate: date, status: "confirmed",
    sources, amountPerUnitRaw: 2, decimals: 6,
  }], A_MINT)[0];
  const lot = { id: "L1", mint: A_MINT, owner: A_ADDR, qtyRaw: 100n, acquiredDate: "2026-01-01", basisRaw: 0n };
  const { accruals } = applyEvents([lot], [
    ev("2026-02-01", ["https://x.example/1"]),
    ev("2026-02-01T00:00:00+02:00", ["https://x.example/2"]),
  ]);
  assert.equal(accruals.length, 1, "the engine sees one dividend, like the route");
});

// The producer always wrote date-only; the schema accepting datetime forms split the
// dividend's identity in two and left the class a schema-valid mine for the first
// datetime producer. The gate canonicalizes: the day part IS the ex-day, everywhere.
test("schema: a datetime dividend canonicalizes to its calendar ex-day at the validation gate", () => {
  const e = divEvent("2026-02-01T00:00:00+02:00", 2);
  assert.equal(e.effectiveDate, "2026-02-01", "date-only, exactly what the producer emits");
});

// "Same day OR same instant" is not transitive: X—Y share an instant, Y—Z share a day —
// the dedup collapsed 2 rows or 1 row depending on the store order. One identity
// (calendar ex-day + amount) is a true equivalence: order decides nothing.
test("accruals: the dividend identity is order-independent (calendar ex-day + amount)", async () => {
  const X = () => divEvent("2026-02-01T23:00:00-02:00", 2); // Feb 2 01:00Z, day Feb 1
  const Y = () => divEvent("2026-02-02T01:00:00Z", 2); // the SAME instant, day Feb 2
  const Z = () => divEvent("2026-02-02T06:00:00Z", 2); // the same DAY as Y, another instant
  for (const [name, events] of [["X,Y,Z", [X(), Y(), Z()]], ["Y,Z,X", [Y(), Z(), X()]]]) {
    await withServer(async (base) => {
      const rows = await (await fetch(`${base}/accruals?symbol=${A_SYMBOL}&address=${A_ADDR}`)).json();
      assert.equal(rows.length, 2, `${name}: two declared ex-days — two dividends, in any order`);
      const days = rows.map((r) => String(r.effectiveDate).slice(0, 10)).sort();
      assert.deepEqual(days, ["2026-02-01", "2026-02-02"], `${name}: the canonical days, both orders`);
      for (const r of rows) assert.equal(r.totalRaw, "200", "100 held on the ex-date × 2");
    }, { events, txs: [aTx("b1", 100n, "2026-01-15")] });
  }
});

test("engine: the dividend identity is the calendar ex-day — order-independent like the route", async () => {
  const { applyEvents } = await import("../src/lots/lots.mjs");
  const ev = (date) => bindMintAndValidate([{
    type: "DIVIDEND_ACCRUAL", effectiveDate: date, status: "confirmed",
    sources: ["https://x.example/1"], amountPerUnitRaw: 2, decimals: 6,
  }], A_MINT)[0];
  const lot = { id: "L1", mint: A_MINT, owner: A_ADDR, qtyRaw: 100n, acquiredDate: "2026-01-01", basisRaw: 0n };
  for (const events of [
    [ev("2026-02-01T23:00:00-02:00"), ev("2026-02-02T01:00:00Z"), ev("2026-02-02T06:00:00Z")],
    [ev("2026-02-02T01:00:00Z"), ev("2026-02-02T06:00:00Z"), ev("2026-02-01T23:00:00-02:00")],
  ]) {
    const { accruals } = applyEvents([lot], events);
    assert.equal(accruals.length, 2, "two calendar ex-days — two accruals, any store order");
  }
});

// The route listened to gaps, truncation, undated txs and a negative base — but not to the
// report's own reconcile signal. A holder whose position predates the window (a live
// account, an empty or shallow window) got a confident "0" — or a silently understated
// base — with no flag, while /lots in the same breath said reconciles:false.
test("accruals: a position older than the window is flagged, not answered with a confident zero", async () => {
  const server = await createApiServer({
    registry: aRegistry,
    events: [divEvent("2026-06-01", 2)],
    walletScanner: async () => ({
      owner: A_ADDR, signatures: 0, fetched: 0, txs: [], skipped: [], truncated: false,
      accounts: new Map([[A_MINT, { addresses: ["Ata" + "1".repeat(41)], currentRaw: 1_000_000n }]]),
    }),
  });
  const { port } = server.address();
  try {
    const rows = await (await fetch(`http://127.0.0.1:${port}/accruals?symbol=${A_SYMBOL}&address=${A_ADDR}`)).json();
    assert.equal(rows[0].baseIncomplete, true, "the window cannot see the opening balance — reconciles:false says so");
    assert.equal(rows[0].totalRaw, "0", "what the window saw is still reported, flagged");
  } finally {
    server.close();
  }
});

// a poisoned-date event must not make /events ordering undefined — garbage
// sorts to the end deterministically instead of a NaN comparator.
test("events: a poisoned-date event sorts to the END, deterministically, valid rows stay chronological", async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/events?symbol=${A_SYMBOL}`);
    assert.equal(r.status, 200, "the endpoint still serves the mint");
    const rows = await r.json();
    assert.ok(Array.isArray(rows));
    const valid = rows.filter((e) => /^\d{4}-\d{2}-\d{2}/.test(String(e.effectiveDate)));
    const ts = valid.map((e) => Date.parse(e.effectiveDate));
    for (let i = 1; i < ts.length; i++) assert.ok(ts[i - 1] <= ts[i], "valid rows chronological");
    const last = rows[rows.length - 1];
    assert.ok(!/^\d{4}-\d{2}-\d{2}/.test(String(last.effectiveDate)) || valid.length === rows.length,
      "poisoned rows sit after every valid row");
  }, {
    events: [
      divEvent("2026-06-01", 1),
      divEvent("2026-02-01", 1),
      { type: "DIVIDEND_ACCRUAL", effectiveDate: "garbage", status: "confirmed", sources: ["https://x.example/p"], amountPerUnitRaw: 1, decimals: 6, mint: A_MINT },
    ],
  });
});

// The engine's dividend gate must use the same DAY-MIDNIGHT base as the route — a
// datetime twin (not through the producer) used to split them: route 100, engine 0.
test("engine parity: applyEvents prices a datetime twin at the same ex-day midnight as the route", async () => {
  const { applyEvents } = await import("../src/lots/lots.mjs");
  const ev = (date) => bindMintAndValidate([{
    type: "DIVIDEND_ACCRUAL", effectiveDate: date, status: "confirmed",
    sources: ["https://x.example/d"], amountPerUnitRaw: 2, decimals: 6,
  }], A_MINT)[0];
  // a lot bought between the twin's instant (Feb 1 22:00Z) and the day midnight (Feb 2 00:00Z)
  const lot = { id: "L1", mint: A_MINT, owner: A_ADDR, qtyRaw: 100n, acquiredDate: "2026-02-01T23:00:00.000Z", basisRaw: 0n };
  const { accruals } = applyEvents([lot], [ev("2026-02-02T01:00:00+02:00")]); // instant = Feb 1 23:00Z
  assert.equal(accruals.length, 1);
  assert.equal(accruals[0].totalRaw, 200n, "held at the ex-day's UTC midnight — same as the route");
});

test("schema: isValidEvent is a pure predicate — the caller's object is not canonicalized under it", async () => {
  const { isValidEvent } = await import("../src/schema/events.mjs");
  const e = { type: "DIVIDEND_ACCRUAL", effectiveDate: "2026-02-01T00:00:00+02:00", status: "confirmed", sources: ["https://x.example/1"], amountPerUnitRaw: 2, decimals: 6, mint: A_MINT };
  assert.equal(isValidEvent(e), true);
  assert.equal(e.effectiveDate, "2026-02-01T00:00:00+02:00", "validation answered, the object is untouched");
});

test("engine: applyEvents does not mutate the caller's event objects", async () => {
  const { applyEvents } = await import("../src/lots/lots.mjs");
  const e = { type: "DIVIDEND_ACCRUAL", effectiveDate: "2026-02-01T00:00:00+02:00", status: "confirmed", sources: ["https://x.example/1"], amountPerUnitRaw: 2, decimals: 6, mint: A_MINT };
  const lot = { id: "L1", mint: A_MINT, owner: A_ADDR, qtyRaw: 100n, acquiredDate: "2026-01-01", basisRaw: 0n };
  const { accruals } = applyEvents([lot], [e]);
  assert.equal(accruals.length, 1, "the event still applies on its calendar day");
  assert.equal(e.effectiveDate, "2026-02-01T00:00:00+02:00", "the input array is untouched");
});
