import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/api/server.mjs";
import { multiplierHistoryToEvents, bindMintAndValidate } from "../src/events/normalize-xstocks.mjs";
import { loadRegistry } from "../src/registry/registry.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const SPYx = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";

const historyNodes = JSON.parse(readFileSync(path.join(dir, "xstocks-spyx-history-eth.json"), "utf8")).nodes;
const events = bindMintAndValidate(multiplierHistoryToEvents(historyNodes, { symbol: "SPYx" }), SPYx);
// the expected registry size — from the file itself, so a registry expansion
// does not require editing the tests (the registry = the source of truth, the token count is not an API contract)
const TOKENS = (await loadRegistry("data/tokens.json")).length;

async function withServer(fn) {
  const registry = await loadRegistry("data/tokens.json");
  const server = await createApiServer({ registry, events });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("/health answers with stats", async () => {
  await withServer(async (base) => {
    const r = await (await fetch(`${base}/health`)).json();
    assert.equal(r.ok, true);
    assert.equal(r.tokens, TOKENS);
    assert.equal(r.events, 4);
  });
});

test("/tokens serves the registry and filters by issuer", async () => {
  await withServer(async (base) => {
    const all = await (await fetch(`${base}/tokens`)).json();
    assert.equal(all.length, TOKENS);
    const tessera = await (await fetch(`${base}/tokens?issuer=tessera`)).json();
    assert.equal(tessera.length, 3);
    assert.ok(tessera.every((t) => t.issuer === "tessera"));
  });
});

test("/events by symbol: the 4 SPYx dividends", async () => {
  await withServer(async (base) => {
    const list = await (await fetch(`${base}/events?symbol=SPYx`)).json();
    assert.equal(list.length, 4);
    assert.ok(list.every((e) => e.type === "MULTIPLIER_CHANGE"));
    const filtered = await fetch(`${base}/events?symbol=SPYx&type=NOPE`);
    // a garbage type — an honest 400 with a dictionary (a silent [] is indistinguishable from "there were none")
    assert.equal(filtered.status, 400);
    assert.match((await filtered.json()).error, /SPLIT/);
  });
});

test("/events without mint/symbol — a clear 400", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/events`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /mint or symbol required/);
  });
});

test("/multiplier: before the events = 1, after all = 1.0057…, scaledQty integral", async () => {
  await withServer(async (base) => {
    const before = await (await fetch(`${base}/multiplier?symbol=SPYx&date=2025-10-30`)).json();
    assert.equal(before.multiplier, "1");
    assert.equal(before.sampleScaledQty.exact, true);

    const after = await (await fetch(`${base}/multiplier?symbol=SPYx&date=2026-07-01`)).json();
    assert.equal(after.multiplier, "1.005714560286254");
    assert.equal(after.events, 4);
    assert.equal(after.sampleScaledQty.whole, "100571456"); // raw=100000000 × 1.0057…
    assert.equal(after.sampleScaledQty.exact, false); // the dust honestly shown
  });
});

test("an unknown route — a 404 with the endpoint list", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(Array.isArray(body.endpoints));
  });
});

// ----: the API input validation ----

test("/multiplier: raw digits only — hex/negatives/garbage = 400", async () => {
  await withServer(async (base) => {
    // BigInt silently accepts "0x10" (=16) and "-5" — that is a quiet lie, not a convenience
    assert.equal((await fetch(`${base}/multiplier?symbol=SPYx&raw=0x10`)).status, 400);
    assert.equal((await fetch(`${base}/multiplier?symbol=SPYx&raw=-5`)).status, 400);
    assert.equal((await fetch(`${base}/multiplier?symbol=SPYx&raw=1.5`)).status, 400);
    assert.equal((await fetch(`${base}/multiplier?symbol=SPYx&raw=abc`)).status, 400);
    assert.equal((await fetch(`${base}/multiplier?symbol=SPYx&raw=1000&date=not-a-date`)).status, 400);
    assert.equal((await fetch(`${base}/multiplier?symbol=SPYx&raw=1000`)).status, 200);
  });
});

test("/onchain: a garbage date = 400, a date-only on the pending activation day does not lie", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const server = await createApiServer({
    registry, events,
    onchainReader: async () => ({
      activeMultiplier: "1.003909240011759",
      pendingMultiplier: "1.005714560286254",
      pendingEffectiveDate: "2026-06-18T00:00:00.000Z",
      hasExtension: true,
    }),
  });
  const { port } = server.address();
  try {
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/onchain?symbol=SPYx&date=garbage`)).status, 400);
    const r = await (await fetch(`${base}/onchain?symbol=SPYx&date=2026-06-18`)).json();
    assert.equal(r.onChainEffective, "1.005714560286254"); // the pending active on its day
  } finally {
    server.close();
  }
});

test("/health: the journal stats present when passed", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const server = await createApiServer({ registry, events, journalStats: { replayed: 2, unavailable: 1 } });
  const { port } = server.address();
  try {
    const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.deepEqual(h.journal, { replayed: 2, unavailable: 1 });
  } finally {
    server.close();
  }
});

// ----: the isolation of a broken mint and strict query dates ----

test("a broken chain of one mint does not kill the server: the token excluded from the vitrine, the rest alive", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const bad = registry.find((t) => t.symbol === "T-SpaceX");
  const poisoned = [
    ...events,
    {
      type: "MULTIPLIER_CHANGE", mint: bad.mint, effectiveDate: "2026-05-01T00:00:00.000Z",
      status: "confirmed", sources: ["test:broken-chain"],
      multiplierFrom: "5", multiplierTo: "6", reason: "On-chain rebase",
    },
  ];
  // earlier createApiServer fell right here: TimelineError (chain discontinuity) at startup
  const server = await createApiServer({ registry, events: poisoned });
  const { port } = server.address();
  try {
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/health`)).status, 200); // the server alive
    const excludedRes = await fetch(`${base}/events?symbol=T-SpaceX`);
    assert.equal(excludedRes.status, 400); // an honest refusal instead of a silent []
    assert.match((await excludedRes.json()).error, /excluded/i); // the broken mint's events are not served partially
    const good = await (await fetch(`${base}/events?symbol=SPYx`)).json();
    assert.equal(good.length, 4); // the other tokens with data
    const rows = await (await fetch(`${base}/summary`)).json();
    assert.equal(rows.find((r) => r.symbol === "T-SpaceX").events, 0); // an honest degradation
    assert.equal(rows.find((r) => r.symbol === "SPYx").events, 4);
  } finally {
    server.close();
  }
});

test("/onchain: the date is validated BEFORE calling the reader — garbage does not warm the cache with a real RPC", async () => {
  const registry = await loadRegistry("data/tokens.json");
  let calls = 0;
  const server = await createApiServer({
    registry, events,
    onchainReader: async () => {
      calls += 1;
      throw new Error("rpc down");
    },
  });
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/onchain?symbol=SPYx&date=garbage`);
    assert.equal(res.status, 400); // a 400, not a 503
    assert.equal(calls, 0); // the reader not called
  } finally {
    server.close();
  }
});

test("a strict date format in the query: '2026-1-1' and a time without a zone = 400 (a local midnight would lie)", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const server = await createApiServer({ registry, events });
  const { port } = server.address();
  try {
    const base = `http://127.0.0.1:${port}`;
    // "2026-1-1" Date.parse eats as a LOCAL midnight; a time without a zone — also local
    for (const bad of ["2026-1-1", "2026-01-01T00:00", "01-01-2026", "2026-13-01"]) {
      assert.equal((await fetch(`${base}/multiplier?symbol=SPYx&date=${bad}`)).status, 400, bad);
      assert.equal((await fetch(`${base}/onchain?symbol=SPYx&date=${bad}`)).status, 400, bad);
    }
    // the valid forms pass: date-only (midnight UTC) and a full RFC3339 with a zone
    assert.equal((await fetch(`${base}/multiplier?symbol=SPYx&date=2026-01-01`)).status, 200);
    assert.equal((await fetch(`${base}/multiplier?symbol=SPYx&date=2026-01-01T00:00:00Z`)).status, 200);
  } finally {
    server.close();
  }
});

// ----: /accruals — the applyEvents accrual engine connected to the API ----
// Synthetics modeled on dividend-e2e: the mint/owner — a valid base58 (without 0/O/I/l),
// absent from the live data/tokens.json; the walletScanner is mocked, no network needed.

const A_MINT = "DivAccMint" + "1".repeat(34); // 44 chars
const A_ADDR = "DivAccAddr" + "1".repeat(34); // 44 chars
const A_SYMBOL = "ACRx";
const aRegistry = [{ mint: A_MINT, symbol: A_SYMBOL, name: "Accrual Test Token", decimals: 6, issuer: "test" }];

const divEvent = (effectiveDate, amountPerUnitRaw) =>
  bindMintAndValidate([{
    type: "DIVIDEND_ACCRUAL",
    effectiveDate,
    status: "confirmed",
    sources: ["https://issuer.example/dividends/test"],
    amountPerUnitRaw,
    decimals: 6,
  }], A_MINT)[0];

// blockTime in the scan — seconds (report.mjs: new Date(blockTime * 1000)); null — a tx without a blockTime
const aBuy = (signature, qty, isoDate) => ({
  signature, slot: 1,
  blockTime: isoDate === null ? null : Math.floor(Date.parse(isoDate) / 1000),
  deltas: [{ owner: A_ADDR, mint: A_MINT, preRaw: 0n, postRaw: qty, deltaRaw: qty }],
});
const aScan = (txs) => {
  // a RECONCILING chain: the live balance equals the window's net delta — the default
  // fixture models a fully covered position. (An empty accounts map is a chain-disagreeing
  // scan, and /accruals flags exactly that as an incomplete base.) A zero net position is
  // NO live account at all: a zero-balance token account does not exist on chain.
  const netRaw = txs.reduce(
    (sum, t) => sum + t.deltas.filter((d) => d.mint === A_MINT).reduce((x, d) => x + d.deltaRaw, 0n),
    0n,
  );
  return {
    owner: A_ADDR, signatures: txs.length, fetched: txs.length, txs, skipped: [], truncated: false,
    accounts: netRaw > 0n
      ? new Map([[A_MINT, { addresses: ["Ata" + "1".repeat(41)], currentRaw: netRaw }]])
      : new Map(),
  };
};

const NO_SCANNER = Symbol("no-scanner"); // a sentinel: the walletScanner is not passed to the server at all
async function withAccrualServer(fn, { events = [], txs = [], scanner = null } = {}) {
  const server = await createApiServer({
    registry: aRegistry,
    events,
    ...(scanner === NO_SCANNER ? {} : { walletScanner: scanner ?? (async () => aScan(txs)) }),
  });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("/accruals: two dividends — a row per event, BigInt as strings, the date gate per each", async () => {
  // the buys: L1 before both ex-dates, L2 between them, L3 after both
  const txs = [
    aBuy("a", 1_000_000n, "2026-09-01"),
    aBuy("b", 2_000_000n, "2026-09-12"),
    aBuy("c", 7_000_000n, "2026-09-20"),
  ];
  const events = [divEvent("2026-09-10", 2), divEvent("2026-09-15", 5)];
  await withAccrualServer(async (base) => {
    const r = await fetch(`${base}/accruals?symbol=${A_SYMBOL}&address=${A_ADDR}`);
    assert.equal(r.status, 200);
    const rows = await r.json();
    assert.equal(rows.length, 2);
    // the dividend of 09-10: only L1 in the base (strictly earlier); L2/L3 bought after the ex-date
    assert.deepEqual(rows[0], {
      symbol: A_SYMBOL,
      effectiveDate: "2026-09-10",
      amountPerUnitRaw: "2",
      totalRaw: "2000000", // 2 × 1 000 000
      lotsConsidered: 1,
    });
    // the dividend of 09-15: L1 + L2, L3 missed
    assert.deepEqual(rows[1], {
      symbol: A_SYMBOL,
      effectiveDate: "2026-09-15",
      amountPerUnitRaw: "5",
      totalRaw: "15000000", // 5 × (1 000 000 + 2 000 000)
      lotsConsidered: 2,
    });
  }, { events, txs });
});

test("/accruals: a lot with acquiredDate:null (a tx without a blockTime) is excluded BEFORE the engine — a 200, not a 500", async () => {
  // applyEvents on such a lot throws LotError (fail-closed, the contract in the header
  // of report.mjs); the endpoint must filter the poison: the accrual is computed over the healthy
  // lots, the poisoned one does not get into the base and does not crash the output
  const txs = [aBuy("poison", 9_000_000n, null), aBuy("ok", 1_000_000n, "2026-09-01")];
  await withAccrualServer(async (base) => {
    const r = await fetch(`${base}/accruals?symbol=${A_SYMBOL}&address=${A_ADDR}`);
    assert.equal(r.status, 200);
    const rows = await r.json();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].totalRaw, "2000000"); // 2 × 1 000 000 — the healthy lot only
    assert.equal(rows[0].lotsConsidered, 1);
  }, { events: [divEvent("2026-09-10", 2)], txs });
});

test("/accruals: an empty output as an honest [] — either no dividend events or no position", async () => {
  const txs = [aBuy("a", 1_000_000n, "2026-09-01")];
  await withAccrualServer(async (base) => {
    // a position exists but no dividend events (an empty store) — "no accruals", a 200 []
    const noEvents = await fetch(`${base}/accruals?symbol=${A_SYMBOL}&address=${A_ADDR}`);
    assert.equal(noEvents.status, 200);
    assert.deepEqual(await noEvents.json(), []);
  }, { events: [], txs });
  await withAccrualServer(async (base) => {
    // events exist, no position — also an honest [] (an event ≠ an accrual)
    const noLots = await fetch(`${base}/accruals?symbol=${A_SYMBOL}&address=${A_ADDR}`);
    assert.equal(noLots.status, 200);
    assert.deepEqual(await noLots.json(), []);
  }, { events: [divEvent("2026-09-10", 2)], txs: [] });
});

test("/accruals: the error convention as the neighbors' — 400 for a symbol/address, 503 without a scanner/when the scanner falls", async () => {
  await withAccrualServer(async (base) => {
    // an unknown symbol — like /events and /multiplier: a 400 "not tracked"
    const badSymbol = await fetch(`${base}/accruals?symbol=NOPE&address=${A_ADDR}`);
    assert.equal(badSymbol.status, 400);
    assert.match((await badSymbol.json()).error, /mint or symbol required/);
    // the address is mandatory and valid — the same 400s as /lots
    assert.equal((await fetch(`${base}/accruals?symbol=${A_SYMBOL}`)).status, 400);
    const badAddr = await fetch(`${base}/accruals?symbol=${A_SYMBOL}&address=abc`);
    assert.equal(badAddr.status, 400);
    assert.match((await badAddr.json()).error, /base58 Solana pubkey/);
  }, { events: [divEvent("2026-09-10", 2)] });
  // the scanner is not configured — a 503, like /lots
  await withAccrualServer(async (base) => {
    const r = await fetch(`${base}/accruals?symbol=${A_SYMBOL}&address=${A_ADDR}`);
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /wallet scanner not configured/);
  }, { events: [divEvent("2026-09-10", 2)], scanner: NO_SCANNER });
  // the scanner falls — a 503 with a reason, the server alive
  await withAccrualServer(async (base) => {
    const r = await fetch(`${base}/accruals?symbol=${A_SYMBOL}&address=${A_ADDR}`);
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /rpc down/);
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
  }, {
    events: [divEvent("2026-09-10", 2)],
    scanner: async () => { throw new Error("rpc down"); },
  });
});
