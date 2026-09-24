// The dividend cross-check: a DIVIDEND_ACCRUAL gets an honest price verification.
//
// The semantics (see the header of src/events/crosscheck.mjs) — HONEST math in the raw units
// of the token, WITHOUT dollars and without FX (amountPerUnitRaw in the schema has no payout
// currency, and the payout rate on the ex-date is absent from the pipeline — a dollar comparison
// would be an invention):
//   rawClose = close × 10^decimals;  expectedDropRaw = amountPerUnitRaw;
//   actualDropRaw = rawClosePrev − rawCloseEx.
// The comparison — by fractions of the pre-ex raw price; the tolerance ladder — the same as for MULTIPLIER_CHANGE:
// a candle hole > 3 days → inconclusive; a dividend < 0.5% of the price → noise (±3%); otherwise
// tolerance = max(3%, 60% of the expectation) → consistent/mismatch.
// Separately pinned: the MULTIPLIER_CHANGE path is unchanged (the verdict order — the contract
// of the vitrine src/ui/page.mjs: all the rebases first, the dividends at the tail).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  crossCheckMultiplierChange,
  crossCheckDividendAccrual,
  crossCheckEvents,
  CrossCheckError,
} from "../src/events/crosscheck.mjs";
import { multiplierHistoryToEvents, bindMintAndValidate } from "../src/events/normalize-xstocks.mjs";
import { createApiServer } from "../src/api/server.mjs";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const SPYx = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const MINT = "DivXcMint" + "1".repeat(35); // synthetics: a valid base58, not from the live registry

const DAY = 86400;
const d = (yyyy, mm, dd) => Math.floor(Date.parse(`${yyyy}-${mm}-${dd}T00:00:00Z`) / 1000);
const divEv = (iso, amountPerUnitRaw, decimals) => ({
  type: "DIVIDEND_ACCRUAL", effectiveDate: iso, amountPerUnitRaw, decimals,
});
const ev = (iso, from, to) => ({
  type: "MULTIPLIER_CHANGE", effectiveDate: iso, multiplierFrom: from, multiplierTo: to, reason: "Dividend",
  status: "confirmed", sources: ["https://issuer.example/multipliers"], // for bindMintAndValidate in the API test
});

// --- the pure math of the dividend verdict (raw units) ---

test("an exact drop on the dividend — consistent; the raw math verbatim", () => {
  // a $2.00 equivalent in 6 decimals: 2_000_000 raw per raw unit; the price 100 → 98
  const event = divEv("2026-06-10T00:00:00Z", 2_000_000, 6);
  const candles = [
    { ts: d("2026", "06", "08"), c: 100 }, // closed 06-09 — the last one BEFORE the ex-date
    { ts: d("2026", "06", "09"), c: 100 },
    { ts: d("2026", "06", "10"), c: 98 },  // closed 06-11 — the first one AFTER
    { ts: d("2026", "06", "11"), c: 98.1 },
  ];
  const r = crossCheckDividendAccrual(event, candles);
  assert.equal(r.verdict, "consistent");
  // the verbatim raw math: (closePrev − closeEx) × 10^decimals === amountPerUnitRaw
  assert.equal((candles[1].c - candles[2].c) * 10 ** 6, 2_000_000);
  assert.equal(r.expectedDropRaw, 2_000_000);
  assert.equal(r.type, "DIVIDEND_ACCRUAL"); // the type in the verdict description
  assert.equal(r.decimals, 6);
  // the fractions: a dividend of 2% of the pre-ex price, an actual drop of 2%
  assert.equal(r.expectedDropFraction, 2_000_000 / (100 * 10 ** 6));
  assert.equal(r.observedDropFraction, (100 * 10 ** 6 - 98 * 10 ** 6) / (100 * 10 ** 6));
  assert.equal(r.observed.beforeDate, "2026-06-09");
  assert.equal(r.observed.afterDate, "2026-06-10");
  assert.match(r.note, /dividend signature/);
});

test("an almost exact drop (the delta within the tolerance) — also consistent", () => {
  const event = divEv("2026-06-10T00:00:00Z", 2_000_000, 6); // an expectation of 2%
  const r = crossCheckDividendAccrual(event, [
    { ts: d("2026", "06", "09"), c: 100 },
    { ts: d("2026", "06", "10"), c: 98.1 }, // dropped 1.9%: |0.019 − 0.02| = 0.001 << 0.03
  ]);
  assert.equal(r.verdict, "consistent");
});

test("the decimals scale works: 2.00 at two decimals — the same fraction of 2%", () => {
  const event = divEv("2026-06-10T00:00:00Z", 200, 2); // 200 raw at 10^2 = the same "2.00"
  const r = crossCheckDividendAccrual(event, [
    { ts: d("2026", "06", "09"), c: 100 },
    { ts: d("2026", "06", "10"), c: 98 },
  ]);
  assert.equal(r.expectedDropFraction, 200 / (100 * 10 ** 2));
  assert.equal(r.verdict, "consistent");
});

test("the dividend candle frame — the same as for MULTIPLIER_CHANGE: a close exactly at the event moment = before", () => {
  const evTs = Date.parse("2026-06-12T00:00:00Z") / 1000;
  const r = crossCheckDividendAccrual(divEv("2026-06-12T00:00:00Z", 2_000_000, 6), [
    { ts: evTs - DAY, c: 100 }, // a close exactly at the ex-date moment: the price is still without the dividend
    { ts: evTs, c: 98 },
  ]);
  assert.equal(r.verdict, "consistent");
  assert.equal(r.observed.beforeDate, "2026-06-11");
  assert.equal(r.observed.afterDate, "2026-06-12");
});

test("a small dividend (<0.5% of the price): within the noise — consistent, a gross anomaly — suspicious", () => {
  const event = divEv("2026-06-18T04:00:00Z", 300_000, 6); // 0.3% of the price 100
  const calm = crossCheckDividendAccrual(event, [
    { ts: d("2026", "06", "16"), c: 100 },
    { ts: d("2026", "06", "17"), c: 100 },
    { ts: d("2026", "06", "18"), c: 100.2 }, // +0.2% — noise
  ]);
  assert.equal(calm.verdict, "consistent");
  assert.match(calm.note, /daily noise/);

  const wild = crossCheckDividendAccrual(event, [
    { ts: d("2026", "06", "16"), c: 100 },
    { ts: d("2026", "06", "17"), c: 100 },
    { ts: d("2026", "06", "18"), c: 105 }, // +5% — a dividend of 0.3% does not explain it
  ]);
  assert.equal(wild.verdict, "suspicious");
  assert.match(wild.note, /cannot explain/);
});

test("the market did not drop on the dividend — a mismatch: a rise and a fall exceeding the tolerance multiple times", () => {
  const event = divEv("2026-06-10T00:00:00Z", 200, 2); // an expectation of 2% of the price, a tolerance of 3%
  const rose = crossCheckDividendAccrual(event, [
    { ts: d("2026", "06", "09"), c: 100 },
    { ts: d("2026", "06", "10"), c: 103 }, // the price ROSE by 3% — the dividend did not drop
  ]);
  assert.equal(rose.verdict, "mismatch");
  assert.ok(rose.observedDropFraction < 0, "a rise = a negative drop delta");
  assert.match(rose.note, /did not drop by the dividend amount/);

  const sank = crossCheckDividendAccrual(event, [
    { ts: d("2026", "06", "09"), c: 100 },
    { ts: d("2026", "06", "10"), c: 92 }, // dropped 8% with a dividend of 2% — not a dividend signature
  ]);
  assert.equal(sank.verdict, "mismatch");
});

test("a hole in the candles around the ex-date — inconclusive, the drop fraction is still computed", () => {
  const r = crossCheckDividendAccrual(divEv("2026-05-01T00:15:00Z", 2_000_000, 6), [
    { ts: d("2026", "04", "14"), c: 100 }, // then the pool went silent for two months
    { ts: d("2026", "06", "14"), c: 93 },
  ]);
  assert.equal(r.verdict, "inconclusive");
  assert.equal(r.observed.windowDays, 61);
  assert.match(r.note, /candle gap/);
  assert.equal(r.observedDropFraction, (100 * 10 ** 6 - 93 * 10 ** 6) / (100 * 10 ** 6));
});

test("no history before the ex-date and an empty candle set — no-price-data with an honest reason", () => {
  const event = divEv("2025-10-31T23:55:00Z", 2_000_000, 6);
  const short = crossCheckDividendAccrual(event, [
    { ts: d("2026", "03", "18"), c: 100 },
    { ts: d("2026", "03", "19"), c: 100 },
  ]);
  assert.equal(short.verdict, "no-price-data");
  assert.equal(short.observedDropFraction, null);
  assert.equal(short.observed, null);
  assert.match(short.note, /do not reach back/);

  const empty = crossCheckDividendAccrual(event, []);
  assert.equal(empty.verdict, "no-price-data");
  assert.equal(empty.observedDropFraction, null);
});

test("a zero pre-ex price — inconclusive, not a division by zero", () => {
  const r = crossCheckDividendAccrual(divEv("2026-06-10T00:00:00Z", 2_000_000, 6), [
    { ts: d("2026", "06", "09"), c: 0 }, // a degenerate pool
    { ts: d("2026", "06", "10"), c: 0 },
  ]);
  assert.equal(r.verdict, "inconclusive");
  // ROUND9 #5: the guard of both sides — a note about the close AROUND the ex-date (it used to be "pre-ex")
  assert.match(r.note, /unusable close around the ex-date/); // round 10: a finite guard, a wider wording
});

test("a broken event — a refusal, not a guess: the type, the date, the amount, the decimals", () => {
  const ok = divEv("2026-06-10T00:00:00Z", 2_000_000, 6);
  assert.throws(() => crossCheckDividendAccrual({ ...ok, type: "SPLIT" }, []), CrossCheckError);
  assert.throws(() => crossCheckDividendAccrual(divEv("2026-02-30", 2_000_000, 6), []), CrossCheckError); // a Date.parse roll-over
  for (const bad of [0, -5, 1.5, undefined, null]) {
    assert.throws(
      () => crossCheckDividendAccrual({ ...ok, amountPerUnitRaw: bad }, []),
      CrossCheckError,
      `amountPerUnitRaw=${JSON.stringify(bad)} must be rejected`,
    );
  }
  for (const bad of [19, -1, 1.5, undefined]) {
    assert.throws(
      () => crossCheckDividendAccrual({ ...ok, decimals: bad }, []),
      CrossCheckError,
      `decimals=${JSON.stringify(bad)} must be rejected`,
    );
  }
});

// --- crossCheckEvents: the verdict order — the vitrine contract, the dividends at the tail ---

test("crossCheckEvents: the MULTIPLIER_CHANGE verdicts first and byte-for-byte the same, the dividend at the tail with a type", () => {
  const M1 = ev("2026-06-10T00:00:00Z", "1", "2");
  const D1 = divEv("2026-06-12T00:00:00Z", 2_000_000, 6);
  const M2 = ev("2026-06-18T04:00:00Z", "1.003909240011759", "1.005714560286254");
  const candles = [
    { ts: d("2026", "06", "08"), c: 100 },
    { ts: d("2026", "06", "09"), c: 100 },
    { ts: d("2026", "06", "10"), c: 50 }, // the 1→2 rebase worked
    { ts: d("2026", "06", "12"), c: 49 }, // the dividend worked (not a 2x drop)
    { ts: d("2026", "06", "17"), c: 49 },
    { ts: d("2026", "06", "18"), c: 49.2 },
  ];
  const { verdicts } = crossCheckEvents([M1, D1, M2], candles);
  assert.equal(verdicts.length, 3);

  // the first two — the verdicts of M1 and M2, identical to the pure function (the vitrine keys them by seq)
  assert.deepEqual(verdicts[0], crossCheckMultiplierChange(M1, candles));
  assert.deepEqual(verdicts[1], crossCheckMultiplierChange(M2, candles));
  assert.equal("type" in verdicts[0], false); // the shape of the old verdicts untouched
  assert.equal(verdicts[0].verdict, "consistent");
  assert.equal(verdicts[1].verdict, "consistent");

  // the dividend — the last one, marked with the type
  assert.equal(verdicts[2].type, "DIVIDEND_ACCRUAL");
  assert.equal(verdicts[2].amountPerUnitRaw, 2_000_000);
  assert.equal(verdicts[2].verdict, "consistent");
});

test("a MULTIPLIER_CHANGE regression on the live SPYx fixture: the verdicts unchanged, no dividends in the fixture", () => {
  const historyNodes = JSON.parse(
    readFileSync(path.join(dir, "xstocks-spyx-history-eth.json"), "utf8"),
  ).nodes;
  const events = bindMintAndValidate(multiplierHistoryToEvents(historyNodes, { symbol: "SPYx" }), SPYx);
  const candles = [
    { ts: d("2026", "06", "16"), c: 100 },
    { ts: d("2026", "06", "17"), c: 100 },
    { ts: d("2026", "06", "18"), c: 100.2 },
    { ts: d("2026", "06", "19"), c: 100.3 },
  ];
  const { verdicts } = crossCheckEvents(events, candles);
  assert.equal(verdicts.length, 4); // 4 rebases, no dividends — the path unchanged
  assert.ok(verdicts.every((v) => "multiplierFrom" in v && !("type" in v)));
  const june = verdicts.find((v) => v.effectiveDate.startsWith("2026-06-18"));
  assert.equal(june.verdict, "consistent");
  const oct = verdicts.find((v) => v.effectiveDate.startsWith("2025-10-31"));
  assert.equal(oct.verdict, "no-price-data");
});

// --- the vitrine: /crosscheck serves the dividend verdict without server edits ---

async function withServer(events, candles, fn) {
  const registry = [{ mint: MINT, symbol: "DVTx", name: "Dividend Crosscheck Token (synthetic)", decimals: 6, issuer: "test-issuer" }];
  const server = await createApiServer({
    registry,
    events,
    priceProvider: {
      pool: async () => ({ address: "P1", name: "DVTx / USDC", volume24hUsd: "1" }),
      candles: async () => candles,
    },
  });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("/crosscheck: a rebase and a dividend in one response — the rebase verdict first, the dividend marked with a type", async () => {
  const events = bindMintAndValidate([
    // the timeline must start from "1", otherwise MultiplierTimeline will exclude the mint from the vitrine
    ev("2026-06-18T04:00:00Z", "1", "1.0015"),
    { type: "DIVIDEND_ACCRUAL", effectiveDate: "2026-06-10T00:00:00Z", amountPerUnitRaw: 2_000_000, decimals: 6, status: "confirmed", sources: ["https://issuer.example/div"] },
  ], MINT);
  const candles = [
    { ts: d("2026", "06", "09"), c: 100 },
    { ts: d("2026", "06", "10"), c: 98 },  // the dividend: an exact drop of 2.00
    { ts: d("2026", "06", "17"), c: 98 },
    { ts: d("2026", "06", "18"), c: 98.2 }, // the rebase: within the noise
  ];
  await withServer(events, candles, async (base) => {
    const r = await (await fetch(`${base}/crosscheck?symbol=DVTx`)).json();
    assert.equal(r.symbol, "DVTx");
    assert.equal(r.verdicts.length, 2);
    // the vitrine contract: the rebase verdicts go in the MULTIPLIER_CHANGE event order
    assert.equal("multiplierFrom" in r.verdicts[0], true);
    assert.equal(r.verdicts[0].verdict, "consistent");
    // the dividend verdict arrives into the vitrine and is recognized by the type
    assert.equal(r.verdicts[1].type, "DIVIDEND_ACCRUAL");
    assert.equal(r.verdicts[1].verdict, "consistent");
    assert.equal(r.verdicts[1].expectedDropRaw, 2_000_000);
  });
});
