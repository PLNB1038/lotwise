// blockTime is unix SECONDS from the endpoint. Solana had no blocks before 2020 and
// none in the future beyond clock skew: a value outside that window is a lying gateway,
// not a date. fetchWalletDeltas normalizes it to null — the same shape as a missing
// blockTime — so the consumers' existing incompleteness contracts apply (/accruals
// flags baseIncomplete and keeps the tx out of the base; /lots carries acquiredDate:null).
// Raw pass-through let a pre-epoch tx enter EVERY dividend base silently, silently
// dropped an absurd-future one, and 1e308 crashed /lots with a bare RangeError
// (toISOString over Infinity) — the "a garbage date is an error, not a silent
// comparison" discipline, bypassed on the whole tx path.
import test from "node:test";
import assert from "node:assert/strict";
import { fetchWalletDeltas } from "../src/ingest/tx.mjs";
import { buildWalletReport } from "../src/wallet/report.mjs";
import { createApiServer } from "../src/api/server.mjs";
import { bindMintAndValidate } from "../src/events/normalize-xstocks.mjs";

const MINT = "ExDateMint" + "1".repeat(34);
const ADDR = "ExDateAddr" + "1".repeat(34);
const REGISTRY = [{ mint: MINT, symbol: "PLx", name: "Plausible Token", decimals: 6, issuer: "tessera" }];

const deltaClient = (blockTime) => ({
  call: async () => ({
    slot: 1,
    blockTime,
    meta: {
      err: null,
      preTokenBalances: [],
      postTokenBalances: [{ owner: ADDR, mint: MINT, uiTokenAmount: { amount: "100" } }],
    },
  }),
});

const withErrors = async (fn) => {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => lines.push(a.map(String).join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = orig;
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("the window boundaries are INCLUSIVE: exactly 2020-01-01T00:00:00Z passes, exactly now+1d passes, one second past refuses", async () => {
  // the window is documented as [2020-01-01, now+1d] — a CLOSED interval. The boundary
  // values must be pinned ON THEMSELVES: probed "next to" them (1_577_836_799 refuses),
  // an open bound slipping in (raw > MIN) refuses the honest first second of 2020 —
  // a real blockTime — and the suite stays green while honest dates normalize to null.
  const { result: first, lines } = await withErrors(() =>
    fetchWalletDeltas(deltaClient(1_577_836_800), "sig-exact-min", MINT));
  assert.equal(first.blockTime, 1_577_836_800, "exactly 2020-01-01T00:00:00Z is inside the window");
  assert.deepEqual(lines, [], "no warn for the exact lower boundary");

  // the upper boundary is computed per call — align to a fresh second so the exact
  // now+1d pass and the now+1d+1 refusal are deterministic, not a race on Date.now()
  const s = Math.floor(Date.now() / 1000);
  while (Math.floor(Date.now() / 1000) === s) await sleep(5);
  const base = Math.floor(Date.now() / 1000);
  const exactSkew = await fetchWalletDeltas(deltaClient(base + 86_400), "sig-exact-skew", MINT);
  assert.equal(exactSkew.blockTime, base + 86_400, "exactly one day of endpoint clock skew is the inclusive upper boundary");

  const tooLate = base + 86_401; // computed inside the aligned second — the source's own floor cannot have advanced
  const { result: refused, lines: late } = await withErrors(() =>
    fetchWalletDeltas(deltaClient(tooLate), "sig-past-skew", MINT));
  assert.equal(refused.blockTime, null, "one second past the skew window is outside");
  assert.equal(late.length, 1, "the out-of-window value is warned, not dropped silently");
});

test("a plausible blockTime passes through untouched (within [2020-01-01, now+1d])", async () => {
  const { result: tx, lines } = await withErrors(() => fetchWalletDeltas(deltaClient(1_750_000_000), "sig-ok", MINT));
  assert.equal(tx.blockTime, 1_750_000_000);
  assert.deepEqual(lines, [], "no warn for a plausible date");
  const recent = await fetchWalletDeltas(deltaClient(Math.floor(Date.now() / 1000) + 3600), "sig-skew", MINT);
  assert.equal(recent.blockTime, Math.floor(Date.now() / 1000) + 3600, "an hour of endpoint clock skew is plausible");
});

test("garbage blockTimes normalize to null with one warn: pre-2020, absurd future, 1e308, non-number", async () => {
  for (const [name, garbage] of [
    ["negative (1811)", -5_000_000_000],
    ["just before the window", 1_577_836_799],
    ["year 2100", 4_102_444_800],
    ["1e308 (the /lots RangeError)", 1e308],
    ["a string", "1750000000"],
  ]) {
    const { result: tx, lines } = await withErrors(() => fetchWalletDeltas(deltaClient(garbage), `sig-${name}`, MINT));
    assert.equal(tx.blockTime, null, `${name}: normalized to null`);
    assert.equal(lines.length, 1, `${name}: exactly one warn`);
    assert.match(lines[0], /blockTime/);
    assert.match(lines[0], /null/);
  }
});

test("blockTime absent stays null without a warn (the legitimate Solana reality)", async () => {
  const client = deltaClient(undefined);
  client.call = async () => {
    const t = await deltaClient(0).call();
    t.blockTime = undefined;
    return t;
  };
  const { result: tx, lines } = await withErrors(() => fetchWalletDeltas(client, "sig-no-time", MINT));
  assert.equal(tx.blockTime, null);
  assert.deepEqual(lines, []);
});

// The point of the normalization: the money consumers' existing null contracts fire.
// The scan below is assembled from REAL fetchWalletDeltas results (the normalization
// lives there), then fed through the report and the /accruals route: one honest tx
// (2026-01-05, before the ex-date) and one garbage-dated tx of the same size.
const scanWith = async (garbageBlockTime) => {
  const good = await fetchWalletDeltas(deltaClient(Math.floor(Date.parse("2026-01-05T00:00:00Z") / 1000)), "sig-good", new Set([MINT]));
  const garbage = await fetchWalletDeltas(deltaClient(garbageBlockTime), "sig-garbage", new Set([MINT]));
  return {
    owner: ADDR,
    signatures: 2,
    fetched: 2,
    txs: [good, garbage],
    skipped: [],
    truncated: false,
    accounts: { [MINT]: { addresses: [], currentRaw: 200n } }, // reconciles: the ONLY anomaly is blockTime
  };
};

const divEvent = bindMintAndValidate([{
  type: "DIVIDEND_ACCRUAL", effectiveDate: "2026-06-18", status: "confirmed",
  sources: ["https://issuer.example/dividends/q2"], amountPerUnitRaw: 1000, decimals: 6,
}], MINT)[0];

test("a garbage-dated tx cannot order itself against the ex-date — baseIncomplete, honest base, no 1811 lots, no 500", async () => {
  const scan = await scanWith(-5_000_000_000); // year 1811 from a lying gateway
  const rep = buildWalletReport(scan, { registry: REGISTRY, timelines: new Map(), now: "2026-10-02T00:00:00.000Z" });
  const lots = rep.tokens.find((t) => t.mint === MINT).lots;
  assert.deepEqual(
    lots.map((l) => l.acquiredDate),
    ["2026-01-05T00:00:00.000Z", null],
    "the garbage-dated lot carries acquiredDate:null, not an 1811 date",
  );

  const server = await createApiServer({ registry: REGISTRY, events: [divEvent], walletScanner: async () => scan });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/accruals?symbol=PLx&address=${ADDR}`);
    assert.equal(res.status, 200);
    const [row] = await res.json();
    assert.equal(row.totalRaw, "100000", "only the honest tx enters the base (100 units × 1000), not 200000");
    assert.equal(row.lotsConsidered, 1);
    assert.equal(row.baseIncomplete, true, "the unorderable tx flags the base — no silent lie either way");
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

test("the absurd-future tx (silently dropped before) and the 1e308 tx (a bare RangeError before) behave the same", async () => {
  for (const garbage of [4_102_444_800, 1e308]) {
    const scan = await scanWith(garbage);
    // /lots used to throw a bare RangeError on 1e308 → HTTP 500; now an honest null lot
    const rep = buildWalletReport(scan, { registry: REGISTRY, timelines: new Map(), now: "2026-10-02T00:00:00.000Z" });
    assert.equal(rep.tokens.find((t) => t.mint === MINT).lots[1].acquiredDate, null);
    const server = await createApiServer({ registry: REGISTRY, events: [divEvent], walletScanner: async () => scan });
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/accruals?symbol=PLx&address=${ADDR}`);
      const [row] = await res.json();
      assert.equal(row.totalRaw, "100000", `${garbage}: the future tx is out of the base WITH a flag`);
      assert.equal(row.baseIncomplete, true, `${garbage}: flagged, not silent`);
    } finally {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
  }
});
