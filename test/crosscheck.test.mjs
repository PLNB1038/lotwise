import test from "node:test";
import assert from "node:assert/strict";
import { crossCheckMultiplierChange, crossCheckEvents, CrossCheckError } from "../src/events/crosscheck.mjs";
import { GeckoTerminalClient, PriceError } from "../src/price/geckoterminal.mjs";
import { createApiServer } from "../src/api/server.mjs";
import { multiplierHistoryToEvents, bindMintAndValidate } from "../src/events/normalize-xstocks.mjs";
import { loadRegistry } from "../src/registry/registry.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const SPYx = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";

const DAY = 86400;
const d = (yyyy, mm, dd) => Math.floor(Date.parse(`${yyyy}-${mm}-${dd}T00:00:00Z`) / 1000);
const ev = (iso, from, to) => ({
  type: "MULTIPLIER_CHANGE", effectiveDate: iso, multiplierFrom: from, multiplierTo: to, reason: "Dividend",
});

// --- the pure math of the verdicts ---

test("a large rebase 1→2: the raw-unit price must fall twofold — consistent/mismatch", () => {
  const event = ev("2026-06-10T00:00:00Z", "1", "2"); // an expectation of 0.5
  const candles = [
    { ts: d("2026", "06", "07"), c: 100 }, // closed 06-08
    { ts: d("2026", "06", "08"), c: 100 }, // closed 06-09 — the last one BEFORE the event
    { ts: d("2026", "06", "10"), c: 50 },  // closed 06-11 — the first one AFTER
    { ts: d("2026", "06", "11"), c: 51 },
  ];
  const ok = crossCheckMultiplierChange(event, candles);
  assert.equal(ok.verdict, "consistent");
  assert.equal(ok.observed.beforeDate, "2026-06-08");
  assert.equal(ok.observed.afterDate, "2026-06-10");
  assert.equal(ok.expectedRatio, 0.5);

  const bad = crossCheckMultiplierChange(event, [{ ...candles[0] }, { ...candles[1] }, { ts: d("2026", "06", "10"), c: 95 }, { ts: d("2026", "06", "11"), c: 96 }]);
  assert.equal(bad.verdict, "mismatch"); // 0.95 vs 0.5 — the market did not reprice as a rebase
});

test("a small dividend (<0.5%): within the noise — consistent, a gross anomaly — suspicious", () => {
  const event = ev("2026-06-18T04:00:00Z", "1.003909240011759", "1.005714560286254"); // an expectation of ~0.9982
  const calm = [
    { ts: d("2026", "06", "16"), c: 100 },
    { ts: d("2026", "06", "17"), c: 100 },
    { ts: d("2026", "06", "18"), c: 100.3 }, // closed 06-19, the event at 04:00 inside
    { ts: d("2026", "06", "19"), c: 100.4 },
  ];
  assert.equal(crossCheckMultiplierChange(event, calm).verdict, "consistent");

  const wild = [
    { ts: d("2026", "06", "16"), c: 100 },
    { ts: d("2026", "06", "17"), c: 100 },
    { ts: d("2026", "06", "18"), c: 105 }, // +5% over the window — a dividend of 0.18% does not explain it
    { ts: d("2026", "06", "19"), c: 105 },
  ];
  assert.equal(crossCheckMultiplierChange(event, wild).verdict, "suspicious");
});

test("a hole in the candles around the event — inconclusive, not a false suspicious (the live SPYx case of 01.05)", () => {
  const event = ev("2026-05-01T00:15:00Z", "1.0026", "1.0040");
  const candles = [
    { ts: d("2026", "04", "13"), c: 100 },
    { ts: d("2026", "04", "14"), c: 100 }, // then the pool went silent for two months
    { ts: d("2026", "06", "14"), c: 108.5 },
    { ts: d("2026", "06", "15"), c: 108.6 },
  ];
  const r = crossCheckMultiplierChange(event, candles);
  assert.equal(r.verdict, "inconclusive");
  assert.equal(r.observed.windowDays, 61);
  assert.match(r.note, /candle gap/);
});

test("no history before the event — no-price-data with an honest reason", () => {
  const event = ev("2025-10-31T23:55:00Z", "1", "1.001");
  const candles = [
    { ts: d("2026", "03", "18"), c: 100 },
    { ts: d("2026", "03", "19"), c: 100 },
  ];
  const r = crossCheckMultiplierChange(event, candles);
  assert.equal(r.verdict, "no-price-data");
  assert.equal(r.observedRatio, null);
  assert.match(r.note, /do not reach back/);
});

test("an event at 23:59: the candle of the event day closes after — correct before/after", () => {
  const event = ev("2026-06-05T23:59:00Z", "1", "1.001");
  const candles = [
    { ts: d("2026", "06", "04"), c: 200 }, // closed 06-05T00:00 — before the event
    { ts: d("2026", "06", "05"), c: 201 }, // closed 06-06T00:00 — after the event (23:59 inside)
    { ts: d("2026", "06", "06"), c: 201 },
  ];
  const r = crossCheckMultiplierChange(event, candles);
  assert.equal(r.observed.beforeDate, "2026-06-04");
  assert.equal(r.observed.afterDate, "2026-06-05");
});

test("not a MULTIPLIER_CHANGE — a refusal, not a guess", () => {
  assert.throws(
    () => crossCheckMultiplierChange({ type: "SPLIT", effectiveDate: "2026-06-05T00:00:00Z" }, []),
    CrossCheckError,
  );
});

test("crossCheckEvents: only MULTIPLIER_CHANGE + the history coverage", () => {
  const events = [
    ev("2026-01-30T23:55:00Z", "1", "1.0015"),
    { type: "TICKER_CHANGE", effectiveDate: "2026-02-01T00:00:00Z", oldSymbol: "A", newSymbol: "B" },
    ev("2026-06-18T04:00:00Z", "1.003909240011759", "1.005714560286254"),
  ];
  const candles = [
    { ts: d("2026", "06", "16"), c: 100 },
    { ts: d("2026", "06", "17"), c: 100 },
    { ts: d("2026", "06", "18"), c: 100.2 },
  ];
  const { verdicts, coverage } = crossCheckEvents(events, candles);
  assert.equal(verdicts.length, 2); // a TICKER_CHANGE is not cross-checked by price
  assert.equal(verdicts[0].verdict, "no-price-data"); // January outside the history
  assert.equal(coverage.candles, 3);
  assert.equal(coverage.candlesFrom, "2026-06-16");
  assert.equal(coverage.candlesTo, "2026-06-18");
});

// ---: strict dates + the fuzzer invariants (seed 20260919) ---

const VERDICTS = ["consistent", "mismatch", "suspicious", "inconclusive", "no-price-data"];

test("a garbage effectiveDate — CrossCheckError (a battery of dates, including Date.parse roll-overs)", () => {
  const badDates = [
    "2026-13-01", "2026-00-10", "2026-06-18T23:59:60Z", "2026-06-18T12:00:00+99:99",
    "2026-02-30", "2026-06-31", "2027-02-29", "2026-06-18T24:00:00Z",
    "2026-06-18T12:00:00", "2026-1-1", "", null,
  ];
  for (const bad of badDates) {
    assert.throws(
      () => crossCheckMultiplierChange(ev(bad, "1", "2"), [{ ts: 0, c: 100 }]),
      CrossCheckError,
      `must be rejected: ${JSON.stringify(bad)}`,
    );
  }
});

test("canonical date formats pass the cross-check (an anti-overreach of the strict validator)", () => {
  const candles = [
    { ts: d("2026", "06", "08"), c: 100 },
    { ts: d("2026", "06", "09"), c: 100 },
    { ts: d("2026", "06", "10"), c: 50 },
  ];
  for (const date of ["2026-06-10", "2026-06-10T00:00:00Z", "2026-06-10T00:00:00.000Z", "2026-06-10T02:00:00+02:00"]) {
    const r = crossCheckMultiplierChange(ev(date, "1", "2"), candles);
    assert.equal(r.verdict, "consistent", date); // all the spellings — one moment: midnight of 06-10 UTC
  }
});

test("invariant: the verdict is always from {consistent,mismatch,suspicious,inconclusive,no-price-data}", () => {
  const scenarios = [
    // consistent: a large rebase, the market repriced
    [ev("2026-06-10T00:00:00Z", "1", "2"), [
      { ts: d("2026", "06", "08"), c: 100 }, { ts: d("2026", "06", "09"), c: 100 },
      { ts: d("2026", "06", "10"), c: 50 }, { ts: d("2026", "06", "11"), c: 51 },
    ]],
    // mismatch: the market did not reprice
    [ev("2026-06-10T00:00:00Z", "1", "2"), [
      { ts: d("2026", "06", "08"), c: 100 }, { ts: d("2026", "06", "09"), c: 100 },
      { ts: d("2026", "06", "10"), c: 95 }, { ts: d("2026", "06", "11"), c: 96 },
    ]],
    // suspicious: a small dividend + a gross price anomaly
    [ev("2026-06-18T04:00:00Z", "1.003909240011759", "1.005714560286254"), [
      { ts: d("2026", "06", "16"), c: 100 }, { ts: d("2026", "06", "17"), c: 100 },
      { ts: d("2026", "06", "18"), c: 105 }, { ts: d("2026", "06", "19"), c: 105 },
    ]],
    // inconclusive: a hole in the candles
    [ev("2026-05-01T00:15:00Z", "1.0026", "1.0040"), [
      { ts: d("2026", "04", "14"), c: 100 }, { ts: d("2026", "06", "14"), c: 108.5 },
    ]],
    // no-price-data: the history does not reach back to the event
    [ev("2025-10-31T23:55:00Z", "1", "1.001"), [
      { ts: d("2026", "03", "18"), c: 100 }, { ts: d("2026", "03", "19"), c: 100 },
    ]],
    // no-price-data: no candles at all
    [ev("2026-06-10T00:00:00Z", "1", "2"), []],
  ];
  const seen = new Set();
  for (const [e, cs] of scenarios) {
    const r = crossCheckMultiplierChange(e, cs);
    assert.ok(VERDICTS.includes(r.verdict), `an unknown verdict: ${r.verdict}`);
    seen.add(r.verdict);
  }
  assert.equal(seen.size, VERDICTS.length, "all 5 verdicts reachable and covered");
});

test("invariant: inconclusive ⟺ the window > 3 days (3 days is still solvable, 4 — no longer)", () => {
  const event = ev("2026-06-11T12:00:00Z", "1", "2"); // noon of 06-11
  const base = d("2026", "06", "10"); // midnight of 06-10
  const candles = (w) => [
    { ts: base, c: 100 },             // closed 06-11T00:00 — before the event
    { ts: base + w * DAY, c: 50 },    // closed w days after the base
  ];
  const w3 = crossCheckMultiplierChange(event, candles(3));
  assert.equal(w3.observed.windowDays, 3);
  assert.notEqual(w3.verdict, "inconclusive");
  assert.equal(w3.verdict, "consistent");
  const w4 = crossCheckMultiplierChange(event, candles(4));
  assert.equal(w4.observed.windowDays, 4);
  assert.equal(w4.verdict, "inconclusive");
});

test("invariant: a candle that closed EXACTLY at the event moment (ts = evTs − DAY) counts as before", () => {
  const evTs = Date.parse("2026-06-12T00:00:00Z") / 1000; // midnight of 06-12
  const event = ev("2026-06-12T00:00:00Z", "1", "2");
  const candles = [
    { ts: evTs - DAY, c: 100 }, // a close exactly at the event moment: the price is still without the rebase
    { ts: evTs, c: 50 },        // closed 06-13 — the first one after
  ];
  const r = crossCheckMultiplierChange(event, candles);
  assert.equal(r.verdict, "consistent"); // 100→50 = the expected rebase: the close before the event used as before
  assert.equal(r.observed.beforeDate, "2026-06-11");
  assert.equal(r.observed.afterDate, "2026-06-12");
  assert.equal(r.observedRatio, 0.5);
});

// --- the GeckoTerminal client on a fake ---

function fakeFetch(routes) {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    const hit = routes.find((r) => url.includes(r.match));
    if (!hit) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => hit.body };
  };
  return { fetcher, calls };
}

const gtPools = (mint, baseMint) => ({
  data: [
    { id: "solana_Po0AAAA", attributes: { name: "STONK / SPYx", volume_usd: { h24: "9000000" } },
      relationships: { base_token: { data: { id: "solana_ST0NK" } }, quote_token: { data: { id: `solana_${mint}` } } } },
    { id: `solana_${baseMint}`, attributes: { name: "SPYx / USDC", volume_usd: { h24: "4000000" } },
      relationships: { base_token: { data: { id: `solana_${mint}` } }, quote_token: { data: { id: "solana_USDC" } } } },
  ],
});

test("GT bestBasePool: takes the pool with OUR base (even a smaller one by volume) — the orientation trap", async () => {
  const { fetcher, calls } = fakeFetch([
    { match: "/pools", body: gtPools(SPYx, "Poo1USDC") },
  ]);
  const gt = new GeckoTerminalClient({ fetcher, sleep: async () => {}, minIntervalMs: 0 });
  const pool = await gt.bestBasePool(SPYx);
  assert.equal(pool.address, "Poo1USDC"); // NOT Po0AAAA (a STONK base, bigger volume)
  assert.equal(pool.name, "SPYx / USDC");
});

test("GT bestBasePool: no pool with our base — null", async () => {
  const { fetcher } = fakeFetch([
    { match: "/pools", body: { data: [
      { id: "solana_X", attributes: { name: "A / B", volume_usd: { h24: "1" } },
        relationships: { base_token: { data: { id: "solana_notours" } } } },
    ] } },
  ]);
  const gt = new GeckoTerminalClient({ fetcher, sleep: async () => {}, minIntervalMs: 0 });
  assert.equal(await gt.bestBasePool(SPYx), null);
});

test("GT dailyCandles: parses and sorts by ts ascending", async () => {
  const { fetcher } = fakeFetch([
    { match: "/ohlcv/day", body: { data: { attributes: { ohlcv_list: [
      [200, 2, 2, 2, 2.2], [100, 1, 1, 1, 1.1], [150, 1.5, 1.6, 1.4, 1.5],
    ] } } } },
  ]);
  const gt = new GeckoTerminalClient({ fetcher, sleep: async () => {}, minIntervalMs: 0 });
  const candles = await gt.dailyCandles("Poo1");
  assert.deepEqual(candles.map((c) => c.ts), [100, 150, 200]);
  assert.equal(candles[0].c, 1.1);
});

test("GT: a solid 429 — a PriceError rate-limit after retries", async () => {
  const fetcher = async () => ({ ok: false, status: 429, json: async () => ({}) });
  const gt = new GeckoTerminalClient({ fetcher, sleep: async () => {}, minIntervalMs: 0, maxRetries: 1 });
  await assert.rejects(gt.dailyCandles("X"), (e) => e instanceof PriceError && e.kind === "rate-limit");
});

test("GT: a 404 — an immediate PriceError http, without retries", async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return { ok: false, status: 404, json: async () => ({}) }; };
  const gt = new GeckoTerminalClient({ fetcher, sleep: async () => {}, minIntervalMs: 0, maxRetries: 2 });
  await assert.rejects(gt.dailyCandles("X"), (e) => e instanceof PriceError && e.kind === "http" && e.status === 404);
  assert.equal(calls, 1, "a 404 of the pool is not transient — there is nothing to retry");
});

// --- the /crosscheck route ---

async function withServer(priceProvider, fn) {
  const historyNodes = JSON.parse(readFileSync(path.join(dir, "xstocks-spyx-history-eth.json"), "utf8")).nodes;
  const events = bindMintAndValidate(multiplierHistoryToEvents(historyNodes, { symbol: "SPYx" }), SPYx);
  const registry = await loadRegistry("data/tokens.json");
  const server = await createApiServer({ registry, events, priceProvider });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("/crosscheck: no provider — 503, an unknown symbol — 400", async () => {
  await withServer(null, async (base) => {
    assert.equal((await fetch(`${base}/crosscheck?symbol=SPYx`)).status, 503);
    assert.equal((await fetch(`${base}/crosscheck?symbol=NOPE`)).status, 400);
  });
});

test("/crosscheck: the verdicts over the SPYx events + the pool and the coverage in the response", async () => {
  const candles = [
    { ts: d("2026", "06", "16"), c: 100 },
    { ts: d("2026", "06", "17"), c: 100 },
    { ts: d("2026", "06", "18"), c: 100.2 },
    { ts: d("2026", "06", "19"), c: 100.3 },
  ];
  await withServer({ pool: async () => ({ address: "P1", name: "SPYx / USDC", volume24hUsd: "1" }), candles: async () => candles }, async (base) => {
    const r = await (await fetch(`${base}/crosscheck?symbol=SPYx`)).json();
    assert.equal(r.symbol, "SPYx");
    assert.equal(r.pool.name, "SPYx / USDC");
    assert.equal(r.coverage.candles, 4);
    assert.equal(r.verdicts.length, 4);
    const june = r.verdicts.find((v) => v.effectiveDate.startsWith("2026-06-18"));
    assert.equal(june.verdict, "consistent");
    const oct = r.verdicts.find((v) => v.effectiveDate.startsWith("2025-10-31"));
    assert.equal(oct.verdict, "no-price-data");
  });
});

test("/crosscheck: no pool — 200 with all no-price-data (not a 500, not empty guesses)", async () => {
  await withServer({ pool: async () => null, candles: async () => { throw new Error("unreachable"); } }, async (base) => {
    const r = await (await fetch(`${base}/crosscheck?symbol=SPYx`)).json();
    assert.equal(r.pool, null);
    assert.equal(r.coverage.candles, 0);
    assert.ok(r.verdicts.every((v) => v.verdict === "no-price-data"));
  });
});

test("/crosscheck: the price source fell — a 503 with kind", async () => {
  const err = new PriceError("rate-limit", "HTTP 429");
  await withServer({ pool: async () => { throw err; }, candles: async () => [] }, async (base) => {
    const res = await fetch(`${base}/crosscheck?symbol=SPYx`);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).kind, "rate-limit");
  });
});
