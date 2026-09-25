// A round-trip in ONE transaction (a multi-hop swap that buys and sells the same token —
// TPS strategies, spread arbitrage): the token's net delta is 0, and the scan's
// "token deltas only" filter used to drop the WHOLE tx — its USDC leg (the spread) was
// visible neither in realized nor in gaps: realized P&L was silently OVERSTATED.
// A tx is now kept when it has token deltas OR a non-empty money leg; the report books
// those legs into a separate moneyOnly section — not lots, not gaps: USDC moved without a
// tracked token (spread, a USDC fee, a plain transfer — the report does not guess WHICH,
// it records the FACT and the signed net). Fail-closed: no money legs in the data (a
// legacy cache) means no rows and no field; a zero NET leg (USDC moved between the
// owner's own accounts) yields no row either. FIFO math is untouched: a money-only tx has
// no token deltas, so no lots.
import test from "node:test";
import assert from "node:assert/strict";
import { scanWallet } from "../src/wallet/scan.mjs";
import { buildWalletReport } from "../src/wallet/report.mjs";
import { USDC_MINT } from "../src/wallet/money.mjs";

const SPYx = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const OWNER = "Wa11etRound" + "2".repeat(32);
const BT = 1750000000;
const REG = [{ mint: SPYx, symbol: "SPYx", name: "S&P 500 xStock", decimals: 8 }];

const row = (accountIndex, owner, mint, amount) => ({
  accountIndex, owner, mint, uiTokenAmount: { amount: String(amount) },
});
const meta = (pre, post) => ({ err: null, preTokenBalances: pre, postTokenBalances: post });

// a minimal node: one signature page per source, txs by id, live accounts by programId
function client({ sigPages = {}, txsById = {}, accounts = [] } = {}) {
  const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
  return {
    async call(method, params) {
      if (method === "getTokenAccountsByOwner") {
        return { value: params[1]?.programId === TOKEN_2022 ? accounts : [] };
      }
      if (method === "getSignaturesForAddress") return params[0] === OWNER ? (sigPages[OWNER] ?? []) : (sigPages[params[0]] ?? []);
      if (method === "getTransaction") return txsById[params[0]];
      throw new Error("unexpected method " + method);
    },
  };
}

test("money-only: a round-trip tx (token 0→0, USDC −30_000) stays in the scan with empty deltas", async () => {
  const hop = {
    slot: 11, blockTime: BT,
    meta: meta(
      [row(0, OWNER, SPYx, 0), row(1, OWNER, USDC_MINT, 10_000_000)],
      [row(0, OWNER, SPYx, 0), row(1, OWNER, USDC_MINT, 9_970_000)],
    ),
  };
  const scan = await scanWallet(client({ sigPages: { [OWNER]: [{ signature: "hop", slot: 11, blockTime: BT, err: null }] }, txsById: { hop } }), OWNER, REG);
  assert.equal(scan.skipped.length, 0);
  assert.equal(scan.txs.length, 1, "a tx with a non-empty money leg is not dropped");
  assert.deepEqual(scan.txs[0].deltas, [], "no token deltas — FIFO has nothing to do here");
  assert.deepEqual(scan.txs[0].moneyDeltas, [{ owner: OWNER, mint: USDC_MINT, deltaRaw: -30_000n }]);

  const rep = buildWalletReport(scan, { registry: REG });
  assert.deepEqual(rep.tokens, [], "no token rows: a zero delta is no lot, no phantoms");
  assert.deepEqual(
    rep.moneyOnly,
    [{ signature: "hop", date: new Date(BT * 1000).toISOString(), mint: USDC_MINT, amountRaw: "-30000" }],
    "the USDC leg is visible in the honest moneyOnly section: signature + date + amount",
  );
  assert.equal(rep.complete, true, "completeness is a certificate about lot coverage — nothing is missing");
});

test("money-only: spread story — FIFO pnl untouched (+500_000), moneyOnly adds the missing −30_000", async () => {
  const buy = {
    slot: 10, blockTime: BT,
    meta: meta(
      [row(0, OWNER, SPYx, 0), row(1, OWNER, USDC_MINT, 10_000_000)],
      [row(0, OWNER, SPYx, 10), row(1, OWNER, USDC_MINT, 1_000_000)],
    ),
  };
  const hop = {
    slot: 11, blockTime: BT + 60,
    meta: meta(
      [row(0, OWNER, SPYx, 10), row(1, OWNER, USDC_MINT, 1_000_000)],
      [row(0, OWNER, SPYx, 10), row(1, OWNER, USDC_MINT, 970_000)],
    ),
  };
  const sell = {
    slot: 12, blockTime: BT + 120,
    meta: meta(
      [row(0, OWNER, SPYx, 10), row(1, OWNER, USDC_MINT, 970_000)],
      [row(0, OWNER, SPYx, 0), row(1, OWNER, USDC_MINT, 10_470_000)],
    ),
  };
  const scan = await scanWallet(client({
    sigPages: { [OWNER]: [
      { signature: "sell", slot: 12, blockTime: BT + 120, err: null },
      { signature: "hop", slot: 11, blockTime: BT + 60, err: null },
      { signature: "buy", slot: 10, blockTime: BT, err: null },
    ] },
    txsById: { buy, hop, sell },
  }), OWNER, REG);
  assert.deepEqual(scan.txs.map((t) => t.signature), ["buy", "hop", "sell"], "the hop is not lost, the order is chronological");

  const rep = buildWalletReport(scan, { registry: REG });
  const spy = rep.tokens.find((t) => t.mint === SPYx);
  assert.deepEqual(
    { qty: spy.realized[0].qtyRaw, basis: spy.realized[0].basisRaw, proceeds: spy.realized[0].proceedsRaw, pnl: spy.realized[0].pnlRaw },
    { qty: "10", basis: "9000000", proceeds: "9500000", pnl: "500000" },
    "the delta-based FIFO math is unchanged: pnl +500_000, as before",
  );
  assert.deepEqual(rep.moneyOnly, [
    { signature: "hop", date: new Date((BT + 60) * 1000).toISOString(), mint: USDC_MINT, amountRaw: "-30000" },
  ]);
  // hand check: 9_500_000 − (9_000_000 + 30_000) = 470_000 — now reconcilable from the report
  assert.equal(BigInt(spy.realized[0].pnlRaw) + BigInt(rep.moneyOnly[0].amountRaw), 470_000n,
    "realized pnl + moneyOnly = the economic result: before, 500_000 silently");
});

test("money-only: a USDC deposit — a positive row; a zero net leg — no tx and no rows", async () => {
  const deposit = {
    slot: 20, blockTime: BT,
    meta: meta(
      [row(0, OWNER, SPYx, 0), row(1, OWNER, USDC_MINT, 0)],
      [row(0, OWNER, SPYx, 0), row(1, OWNER, USDC_MINT, 5_000_000)],
    ),
  };
  const selfMove = {
    slot: 21, blockTime: BT + 10,
    meta: meta(
      [row(0, OWNER, SPYx, 0), row(1, OWNER, USDC_MINT, 5_000_000)],
      [row(0, OWNER, SPYx, 0), row(1, OWNER, USDC_MINT, 5_000_000)],
    ),
  };
  const scan = await scanWallet(client({
    sigPages: { [OWNER]: [
      { signature: "selfMove", slot: 21, blockTime: BT + 10, err: null },
      { signature: "deposit", slot: 20, blockTime: BT, err: null },
    ] },
    txsById: { deposit, selfMove },
  }), OWNER, REG);
  assert.deepEqual(scan.txs.map((t) => t.signature), ["deposit"], "a zero net leg — the tx is not kept (no money moved)");

  const rep = buildWalletReport(scan, { registry: REG });
  assert.deepEqual(rep.tokens, []);
  assert.deepEqual(rep.moneyOnly, [
    { signature: "deposit", date: new Date(BT * 1000).toISOString(), mint: USDC_MINT, amountRaw: "5000000" },
  ], "a positive leg is not a 'loss': the section is neutral, the sign speaks");
});

test("money-only: a legacy scan without moneyDeltas — no rows, no field, no throw", () => {
  const legacyScan = {
    owner: OWNER,
    txs: [
      { signature: "old-trade", slot: 1, blockTime: BT, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 0n, postRaw: 10n, deltaRaw: 10n }] },
      { signature: "old-empty", slot: 2, blockTime: BT, deltas: [] },
    ],
    skipped: [], truncated: false, signatures: 2, fetched: 2, accounts: {},
  };
  const rep = buildWalletReport(legacyScan, { registry: REG });
  assert.equal("moneyOnly" in rep, false, "no money-leg data — no section (absence, not zeros)");
  assert.equal(rep.tokens.length, 1);
});

test("money-only: a foreign owner — the tx is in the scan, their USDC never lands in our report", async () => {
  const BOT = "Fin27Botxx" + "3".repeat(32);
  const foreign = {
    slot: 30, blockTime: BT,
    meta: meta(
      [row(0, BOT, SPYx, 0), row(1, BOT, USDC_MINT, 1_000_000)],
      [row(0, BOT, SPYx, 0), row(1, BOT, USDC_MINT, 0)],
    ),
  };
  const scan = await scanWallet(client({ sigPages: { [OWNER]: [{ signature: "foreign", slot: 30, blockTime: BT, err: null }] }, txsById: { foreign } }), OWNER, REG);
  assert.equal(scan.txs.length, 1, "the scan keeps a money-only tx of any owner — the REPORT filters");
  const rep = buildWalletReport(scan, { registry: REG });
  assert.deepEqual(rep.tokens, []);
  assert.equal("moneyOnly" in rep, false, "someone else's USDC is not ours: no row");
});

test("money-only: a hop neither creates nor masks same-slot pairs, pnl untouched", async () => {
  const ATA = "Ata" + "a".repeat(40); // a second signature source (the token-account page)
  const buy = {
    slot: 40, blockTime: BT,
    meta: meta(
      [row(0, OWNER, SPYx, 0), row(1, OWNER, USDC_MINT, 10_000_000)],
      [row(0, OWNER, SPYx, 10), row(1, OWNER, USDC_MINT, 1_000_000)],
    ),
  };
  const hop = {
    slot: 40, blockTime: BT,
    meta: meta(
      [row(0, OWNER, SPYx, 10), row(1, OWNER, USDC_MINT, 1_000_000)],
      [row(0, OWNER, SPYx, 10), row(1, OWNER, USDC_MINT, 970_000)],
    ),
  };
  const sell = {
    slot: 40, blockTime: BT,
    meta: meta(
      [row(0, OWNER, SPYx, 10), row(1, OWNER, USDC_MINT, 970_000)],
      [row(0, OWNER, SPYx, 0), row(1, OWNER, USDC_MINT, 10_470_000)],
    ),
  };
  const accounts = [{
    pubkey: ATA,
    account: { data: { parsed: { info: { mint: SPYx, owner: OWNER, tokenAmount: { amount: "0" } } } } },
  }];
  // wallet page: buy; ATA page newest-first [sell, hop] — the later-collected hop sorts
  // BEFORE the sell: the money-only tx lands BETWEEN the legs of a same-slot pair
  const scan = await scanWallet(client({
    sigPages: {
      [OWNER]: [{ signature: "buy", slot: 40, blockTime: BT, err: null }],
      [ATA]: [
        { signature: "sell", slot: 40, blockTime: BT, err: null },
        { signature: "hop", slot: 40, blockTime: BT, err: null },
      ],
    },
    txsById: { buy, hop, sell },
    accounts,
  }), OWNER, REG);
  assert.deepEqual(scan.txs.map((t) => t.signature), ["buy", "hop", "sell"]);
  assert.equal(scan.ambiguousSlotPairs, 1, "the cross-source buy/sell pair is counted as before; the hop neither creates nor masks it");

  const rep = buildWalletReport(scan, { registry: REG });
  const spy = rep.tokens.find((t) => t.mint === SPYx);
  assert.equal(spy.realized[0].pnlRaw, "500000", "the pair's FIFO is untouched (basis 9_000_000, proceeds 9_500_000)");
  assert.equal(rep.ambiguousSlotPairs, 1);
  assert.deepEqual(rep.moneyOnly.map((r) => r.amountRaw), ["-30000"], "the hop is still visible in moneyOnly");

  // both legs from ONE source + a hop from another page: no cross-source pair exists, and
  // the hop must not CREATE one (it does not participate in order observability)
  const scanB = await scanWallet(client({
    sigPages: {
      [OWNER]: [
        { signature: "sell", slot: 40, blockTime: BT, err: null },
        { signature: "buy", slot: 40, blockTime: BT, err: null },
      ],
      [ATA]: [{ signature: "hop", slot: 40, blockTime: BT, err: null }],
    },
    txsById: { buy, hop, sell },
    accounts,
  }), OWNER, REG);
  assert.deepEqual(scanB.txs.map((t) => t.signature), ["buy", "sell", "hop"]);
  assert.equal(scanB.ambiguousSlotPairs, 0, "a one-source pair is no pair; a money-only tx from another source does not create one");
  const repB = buildWalletReport(scanB, { registry: REG });
  assert.equal(repB.tokens.find((t) => t.mint === SPYx).realized[0].pnlRaw, "500000");
  assert.deepEqual(repB.moneyOnly.map((r) => r.amountRaw), ["-30000"]);
});

test("money-only: the showcase shows the section only when it exists", async () => {
  const { renderPage } = await import("../src/ui/page.mjs");
  const vm = await import("node:vm");
  const els = new Map();
  const makeEl = (id) => ({
    id, value: "", innerHTML: "", textContent: "", className: "", style: {},
    attrs: {},
    getAttribute(name) { return this.attrs[name] ?? null; },
    scrollIntoView() {},
  });
  const sb = {
    document: {
      getElementById: (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
      querySelectorAll: () => [],
    },
    fetch: () => new Promise(() => {}), // renderWallet is called directly — no fetch needed
  };
  vm.createContext(sb);
  const m = renderPage().match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, "the script block is in place");
  new vm.Script(m[1], { filename: "page-client.js" }).runInContext(sb);

  const baseRep = {
    owner: OWNER,
    counts: { signatures: 1, fetched: 1, skipped: 0, relevantTxs: 1 },
    truncated: false, complete: true, tokens: [],
  };
  const withMoney = { ...baseRep, moneyOnly: [{ signature: "hop", date: new Date(BT * 1000).toISOString(), mint: USDC_MINT, amountRaw: "-30000" }] };
  sb.renderWallet(withMoney);
  const shown = els.get("wallet-out").innerHTML;
  assert.ok(shown.includes("USDC"), "the money-only section is visible in the showcase");
  assert.ok(shown.includes("hop"), "the money-only tx signature is available to the user");
  assert.ok(shown.includes("-0.03"), "−30_000 raw = −0.03 USDC in a human format");

  sb.renderWallet(baseRep); // an older report without the field — as before, no empty sections, no throw
  const clean = els.get("wallet-out").innerHTML;
  assert.ok(!clean.includes("hop"), "without moneyOnly the section is not drawn — a legacy report renders unchanged");
});
