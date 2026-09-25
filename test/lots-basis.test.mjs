// Round 21 (finance audit F2): the USDC leg of a swap becomes cost basis on buys and
// proceeds on sells. Contract: a tx where exactly ONE tracked token moved against a
// USDC counter-leg gets basisKnown/proceedsKnown; anything else (token→token swap,
// transfer-in, several tracked tokens in one tx) is honestly flagged unknown — the
// engine never guesses an allocation. Basis transfers FIFO-proportionally with trunc
// and the remainder rides the last consumed piece, so the Σ invariant holds exactly.
import test from "node:test";
import assert from "node:assert/strict";
import { buildWalletReport } from "../src/wallet/report.mjs";
import { fetchWalletDeltas } from "../src/ingest/tx.mjs";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OWNER = "Wa11etBuyer" + "a".repeat(32);
const MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const REG = [{ symbol: "SPYx", name: "S&P", mint: MINT, decimals: 8, issuer: "backed" }];

const t = (slot, blockTime, deltas, moneyDeltas) => ({ signature: `sig${slot}`, slot, blockTime, err: null, deltas, moneyDeltas });
const d = (mint, deltaRaw, owner = OWNER) => ({ owner, mint, preRaw: 0n, postRaw: 0n, deltaRaw: BigInt(deltaRaw) });
const money = (deltaRaw, owner = OWNER, mint = USDC) => ({ owner, mint, deltaRaw: BigInt(deltaRaw) });

test("basis: a buy against a USDC leg is a known cost basis", () => {
  const scan = { owner: OWNER, txs: [t(1, 1000, [d(MINT, 100n)], [money(-25n * 10n ** 6n)])], skipped: [], truncated: false, signatures: 1, fetched: 1 };
  const rep = buildWalletReport(scan, { registry: REG });
  const lot = rep.tokens[0].lots[0];
  assert.equal(lot.basisKnown, true);
  assert.equal(lot.basisRaw, "25000000", "the whole USDC-out is the basis of the single tracked buy");
});

test("basis: a transfer-in without a money leg is honestly unknown (no invented zero)", () => {
  const scan = { owner: OWNER, txs: [t(1, 1000, [d(MINT, 100n)], [])], skipped: [], truncated: false, signatures: 1, fetched: 1 };
  const rep = buildWalletReport(scan, { registry: REG });
  const lot = rep.tokens[0].lots[0];
  assert.equal(lot.basisKnown, false);
  assert.equal(lot.basisRaw, null);
});

test("basis: two tracked tokens bought in one tx — allocation is not guessed", () => {
  const MINT2 = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF3X";
  const reg2 = [...REG, { symbol: "NVDAx", name: "n", mint: MINT2, decimals: 8, issuer: "backed" }];
  const scan = { owner: OWNER, txs: [t(1, 1000, [d(MINT, 100n), d(MINT2, 50n)], [money(-30n * 10n ** 6n)])], skipped: [], truncated: false, signatures: 1, fetched: 1 };
  const rep = buildWalletReport(scan, { registry: reg2 });
  for (const tok of rep.tokens) {
    assert.equal(tok.lots[0].basisKnown, false, `${tok.symbol}: the split of one USDC leg across two buys is not our guess to make`);
  }
});

test("proceeds: a full sell against a USDC leg — realized basis, proceeds and pnl", () => {
  const scan = {
    owner: OWNER,
    txs: [
      t(1, 1000, [d(MINT, 100n)], [money(-25n * 10n ** 6n)]),   // buy 100 for 25 USDC
      t(2, 2000, [d(MINT, -100n)], [money(40n * 10n ** 6n)]),  // sell all for 40 USDC
    ],
    skipped: [], truncated: false, signatures: 2, fetched: 2,
  };
  const rep = buildWalletReport(scan, { registry: REG });
  const tok = rep.tokens[0];
  assert.equal(tok.realized.length, 1);
  const r = tok.realized[0];
  assert.equal(r.qtyRaw, "100");
  assert.equal(r.basisKnown, true);
  assert.equal(r.basisRaw, "25000000");
  assert.equal(r.proceedsKnown, true);
  assert.equal(r.proceedsRaw, "40000000");
  assert.equal(r.pnlRaw, "15000000", "proceeds − basis");
  assert.equal(tok.lots.length, 0, "the position is closed");
});

test("proceeds: a partial sell splits basis exactly — trunc remainders ride the last piece", () => {
  // buy 3 for 10 USDC, sell 2 (one lot of 2 taken FIFO, then 1 of the last lot)
  const scan = {
    owner: OWNER,
    txs: [
      t(1, 1000, [d(MINT, 1n), d(MINT, 2n)], [money(-10n * 10n ** 6n)]), // two buys in ONE tx: allocation unknown
    ],
    skipped: [], truncated: false, signatures: 1, fetched: 1,
  };
  // ^ this tx has TWO tracked buys — unknown basis; use two txs instead:
  const scan2 = {
    owner: OWNER,
    txs: [
      t(1, 1000, [d(MINT, 2n)], [money(-10n * 10n ** 6n)]),   // buy 2 for 10 USDC
      t(2, 1100, [d(MINT, 1n)], [money(-5n * 10n ** 6n)]),    // buy 1 for 5 USDC
      t(3, 2000, [d(MINT, -3n)], [money(24n * 10n ** 6n)]),   // sell all 3 for 24 USDC
    ],
    skipped: [], truncated: false, signatures: 3, fetched: 3,
  };
  const rep = buildWalletReport(scan2, { registry: REG });
  const tok = rep.tokens[0];
  assert.equal(tok.realized.length, 2, "two FIFO pieces");
  const [p1, p2] = tok.realized;
  assert.equal(p1.qtyRaw, "2");
  assert.equal(p2.qtyRaw, "1");
  // Σ basis = 15 USDC exactly (lot1's whole 10 + lot2's whole 5); proceeds split 2/3, 1/3 of 24
  assert.equal(BigInt(p1.basisRaw) + BigInt(p2.basisRaw), 15n * 10n ** 6n);
  assert.equal(p1.pnlRaw !== null && p2.pnlRaw !== null, true);
  // Σ proceeds = 24 USDC exactly
  assert.equal(BigInt(p1.proceedsRaw) + BigInt(p2.proceedsRaw), 24n * 10n ** 6n);
  // Σ pnl = proceeds − basis per piece, then summed
  assert.equal(BigInt(p1.pnlRaw) + BigInt(p2.pnlRaw), 9n * 10n ** 6n);
});

test("proceeds: selling a lot with unknown basis against USDC — proceeds known, pnl honestly null", () => {
  const scan = {
    owner: OWNER,
    txs: [
      t(1, 1000, [d(MINT, 100n)], []),                        // transfer-in, no basis
      t(2, 2000, [d(MINT, -100n)], [money(40n * 10n ** 6n)]), // sell with a USDC leg
    ],
    skipped: [], truncated: false, signatures: 2, fetched: 2,
  };
  const rep = buildWalletReport(scan, { registry: REG });
  const r = rep.tokens[0].realized[0];
  assert.equal(r.basisKnown, false);
  assert.equal(r.basisRaw, null);
  assert.equal(r.proceedsKnown, true);
  assert.equal(r.proceedsRaw, "40000000");
  assert.equal(r.pnlRaw, null, "no basis — no invented pnl");
});

test("proceeds: a token→token swap (no USDC leg) — proceeds unknown, basis still transfers out of the lot", () => {
  const scan = {
    owner: OWNER,
    txs: [
      t(1, 1000, [d(MINT, 10n)], [money(-10n * 10n ** 6n)]),
      t(2, 2000, [d(MINT, -4n)], []), // swap to another token, no USDC leg
      t(3, 3000, [d(MINT, -6n)], [money(20n * 10n ** 6n)]), // final sell of the rest
    ],
    skipped: [], truncated: false, signatures: 3, fetched: 3,
  };
  const rep = buildWalletReport(scan, { registry: REG });
  const tok = rep.tokens[0];
  const [r1, r2] = tok.realized;
  assert.equal(r1.proceedsKnown, false);
  assert.equal(r1.proceedsRaw, null);
  assert.equal(r2.proceedsKnown, true);
  // Σ basis of both realized pieces + open-lot basis == 10 USDC exactly (the unknown-proceeds
  // sale still transferred its basis out; the final sale books the remainder)
  assert.equal(BigInt(r1.basisRaw) + BigInt(r2.basisRaw), 10n * 10n ** 6n);
  assert.equal(tok.lots.length, 0);
});

test("gaps: a sell beyond the window's coverage — the gap piece carries its proceeds share, basis unknown", () => {
  const scan = {
    owner: OWNER,
    txs: [
      t(1, 1000, [d(MINT, 2n)], [money(-10n * 10n ** 6n)]),  // buy 2 for 10
      t(2, 2000, [d(MINT, -3n)], [money(30n * 10n ** 6n)]),  // sell 3: 2 covered, 1 from before the window
    ],
    skipped: [], truncated: false, signatures: 2, fetched: 2,
  };
  const rep = buildWalletReport(scan, { registry: REG });
  const tok = rep.tokens[0];
  assert.equal(tok.realized.length, 1);
  assert.equal(tok.realized[0].qtyRaw, "2");
  assert.equal(tok.gaps.length, 1);
  assert.equal(tok.gaps[0].missingQtyRaw, "1");
  assert.equal(tok.gaps[0].proceedsRaw, "10000000", "a third of the 30 USDC proceeds belongs to the gap piece");
  // Σ realized.proceeds + Σ gap.proceeds == the tx's USDC-in, exactly
  assert.equal(BigInt(tok.realized[0].proceedsRaw) + BigInt(tok.gaps[0].proceedsRaw), 30n * 10n ** 6n);
  assert.equal(rep.complete, false, "a gap keeps the report incomplete");
});

test("Σ invariant: across a mixed history, basis never appears or disappears", () => {
  const scan = {
    owner: OWNER,
    txs: [
      t(1, 1000, [d(MINT, 7n)], [money(-21n * 10n ** 6n)]),
      t(2, 1100, [d(MINT, 3n)], []),                          // transfer-in (unknown basis)
      t(3, 2000, [d(MINT, -5n)], [money(25n * 10n ** 6n)]),
      t(4, 3000, [d(MINT, 2n)], [money(-8n * 10n ** 6n)]),
      t(5, 4000, [d(MINT, -4n)], []),                          // token→token, no leg
    ],
    skipped: [], truncated: false, signatures: 5, fetched: 5,
  };
  const rep = buildWalletReport(scan, { registry: REG });
  const tok = rep.tokens[0];
  const knownBasisIn = 21n * 10n ** 6n + 8n * 10n ** 6n;
  const inLots = tok.lots.filter((l) => l.basisKnown).reduce((a, l) => a + BigInt(l.basisRaw), 0n);
  const inRealized = tok.realized.filter((r) => r.basisKnown).reduce((a, r) => a + BigInt(r.basisRaw), 0n);
  assert.equal(inLots + inRealized, knownBasisIn, "Σ(open lots basis) + Σ(realized basis) == Σ(known buy basis)");
  assert.equal(tok.lots.filter((l) => !l.basisKnown).length, 1, "the transfer-in lot stays honestly unknown");
});

test("moneyDeltas: fetchWalletDeltas parses the USDC leg per owner when asked", async () => {
  const raw = {
    slot: 1, blockTime: 1000, meta: {
      err: null,
      preTokenBalances: [
        { accountIndex: 0, owner: OWNER, mint: USDC, uiTokenAmount: { amount: "5000000" } },
        { accountIndex: 2, owner: OWNER, mint: USDC, uiTokenAmount: { amount: "1000000" } }, // second USDC account of the same owner
      ],
      postTokenBalances: [
        { accountIndex: 0, owner: OWNER, mint: USDC, uiTokenAmount: { amount: "0" } },
        { accountIndex: 2, owner: OWNER, mint: USDC, uiTokenAmount: { amount: "3000000" } },
        { accountIndex: 5, owner: OWNER, mint: MINT, uiTokenAmount: { amount: "100" } },
      ],
    },
  };
  const client = { call: async () => raw };
  const tx = await fetchWalletDeltas(client, "sig1", new Set([MINT]), { moneyMints: new Set([USDC]) });
  assert.equal(tx.moneyDeltas.length, 1);
  assert.equal(tx.moneyDeltas[0].owner, OWNER);
  assert.equal(tx.moneyDeltas[0].deltaRaw, -3000000n, "net across both USDC accounts: (0−5m)+(3m−1m)");
});

test("moneyDeltas: without the option the response shape is unchanged (backward compatible)", async () => {
  const raw = { slot: 1, blockTime: 1000, meta: { err: null, preTokenBalances: [], postTokenBalances: [{ accountIndex: 5, owner: OWNER, mint: MINT, uiTokenAmount: { amount: "100" } }] } };
  const client = { call: async () => raw };
  const tx = await fetchWalletDeltas(client, "sig1", new Set([MINT]));
  assert.equal("moneyDeltas" in tx, false);
});

test("scan→report end to end: the money leg flows from the scan into priced lots", async () => {
  const { scanWallet } = await import("../src/wallet/scan.mjs");
  const raw = {
    slot: 1, blockTime: 1000,
    meta: {
      err: null,
      preTokenBalances: [{ accountIndex: 0, owner: OWNER, mint: USDC, uiTokenAmount: { amount: "5000000" } }],
      postTokenBalances: [
        { accountIndex: 0, owner: OWNER, mint: USDC, uiTokenAmount: { amount: "0" } },
        { accountIndex: 5, owner: OWNER, mint: MINT, uiTokenAmount: { amount: "100" } },
      ],
    },
  };
  const client = {
    async call(method, params) {
      if (method === "getSignaturesForAddress") return params[0] === OWNER ? [{ signature: "s1", slot: 1, blockTime: 1000, err: null }] : [];
      if (method === "getTokenAccountsByOwner") return { value: [] };
      if (method === "getTransaction") return params[0] === "s1" ? raw : null;
      throw new Error(`unexpected method ${method}`);
    },
  };
  const scan = await scanWallet(client, OWNER, REG);
  const rep = buildWalletReport(scan, { registry: REG });
  const lot = rep.tokens[0].lots[0];
  assert.equal(lot.basisKnown, true, "the scan passes the USDC leg through to the report");
  assert.equal(lot.basisRaw, "5000000");
});

test("proceeds: a PARTIAL consumption of a lot splits its basis proportionally (not all on the first piece)", () => {
  const scan = {
    owner: OWNER,
    txs: [
      t(1, 1000, [d(MINT, 10n)], [money(-10n * 10n ** 6n)]), // one lot: 10 tokens for 10 USDC
      t(2, 2000, [d(MINT, -4n)], [money(4n * 10n ** 6n)]),  // a partial sell: 4 of 10
      t(3, 3000, [d(MINT, -6n)], [money(7n * 10n ** 6n)]),  // closes the lot
    ],
    skipped: [], truncated: false, signatures: 3, fetched: 3,
  };
  const rep = buildWalletReport(scan, { registry: REG });
  const [p1, p2] = rep.tokens[0].realized;
  assert.equal(p1.qtyRaw, "4");
  assert.equal(p1.basisRaw, "4000000", "4/10 of the lot's 10 USDC basis");
  assert.equal(p2.qtyRaw, "6");
  assert.equal(p2.basisRaw, "6000000", "the remaining 6/10 — the lot's basis never double-counts");
  assert.equal(BigInt(p1.basisRaw) + BigInt(p2.basisRaw), 10n * 10n ** 6n);
});

// Round 22 (finance-v2 F2): a MIXED tx — sold token A, bought token B against the net
// USDC — must not price either leg. The rule requires EXACTLY ONE tracked token in the tx
// (mine.length === 1), not "exactly one buy"; the net USDC of a two-legged swap is nobody's
// basis (README: "several tracked tokens inside one tx — basisKnown: false, never an
// invented number").
test("basis: a mixed sell-A/buy-B tx prices NEITHER leg (net USDC is nobody's basis)", () => {
  const MINT_B = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF4X";
  const reg2 = [...REG, { symbol: "NVDAx", name: "n", mint: MINT_B, decimals: 8, issuer: "backed" }];
  const scan = {
    owner: OWNER,
    txs: [
      t(1, 1000, [d(MINT, 60n)], [money(-100n * 10n ** 6n)]), // open A with a clean basis
      // sell 60 A AND buy 100 B in one tx; net USDC −40 (received 100 for A, paid 60... net −40)
      t(2, 2000, [d(MINT, -60n), d(MINT_B, 100n)], [money(-40n * 10n ** 6n)]),
    ],
    skipped: [], truncated: false, signatures: 2, fetched: 2,
  };
  const rep = buildWalletReport(scan, { registry: reg2 });
  const b = rep.tokens.find((x) => x.mint === MINT_B);
  assert.equal(b.lots[0].basisKnown, false, "the buy-B leg of a mixed tx is unpriced — the net USDC is not its basis");
  assert.equal(b.lots[0].basisRaw, null);
  const a = rep.tokens.find((x) => x.mint === MINT);
  const sale = a.realized.find((r) => r.qtyRaw === "60");
  assert.equal(sale.proceedsKnown, false, "the sell-A leg of the same tx is unpriced too");
  assert.equal(sale.proceedsRaw, null);
});

test("basis: the mirrored mixed tx (buy A / sell B with net USDC in) prices neither leg", () => {
  const MINT_B = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF4X";
  const reg2 = [...REG, { symbol: "NVDAx", name: "n", mint: MINT_B, decimals: 8, issuer: "backed" }];
  const scan = {
    owner: OWNER,
    txs: [
      t(1, 1000, [d(MINT_B, 100n)], [money(-90n * 10n ** 6n)]),
      t(2, 2000, [d(MINT, 60n), d(MINT_B, -100n)], [money(50n * 10n ** 6n)]), // buy A + sell B, net +50 USDC in
    ],
    skipped: [], truncated: false, signatures: 2, fetched: 2,
  };
  const rep = buildWalletReport(scan, { registry: reg2 });
  const a = rep.tokens.find((x) => x.mint === MINT);
  assert.equal(a.lots[0].basisKnown, false, "the buy-A leg of a mixed tx is unpriced");
  const b = rep.tokens.find((x) => x.mint === MINT_B);
  const sale = b.realized[0];
  assert.equal(sale.proceedsKnown, false, "the sell-B leg is unpriced — the net +50 USDC is not its proceeds");
});
