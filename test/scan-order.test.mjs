// Within ONE slot the ledger order is the reverse of the RPC list: getSignaturesForAddress
// answers newest-first, and a stable sort by slot alone kept that list order for same-slot
// transactions — a buy and a sell landing in one slot (arb bots, split routes,
// mint-then-sell) reached the FIFO as sell→buy: the sell ran against an empty queue
// (a spurious gap with the proceeds booked into the hole), the buy stayed open as a
// phantom position, and the trade vanished from realized P&L while `reconciles` stayed
// true. The tiebreak is the collection sequence: collected LATER = earlier in the block.
import test from "node:test";
import assert from "node:assert/strict";
import { scanWallet } from "../src/wallet/scan.mjs";
import { buildWalletReport } from "../src/wallet/report.mjs";

const OWNER = "Wa11etBuyer" + "a".repeat(32);
const SPYx = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBDF2W";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const REG = [{ mint: SPYx, symbol: "SPYx", name: "S&P 500 xStock", decimals: 8, issuer: "test" }];

// 100 SPYx bought for 9 USDC, sold for 9.5 USDC — both legs the owner's own accounts.
const buyTx = () => ({
  slot: 1000,
  blockTime: 1750000000,
  meta: {
    err: null,
    preTokenBalances: [
      { accountIndex: 0, owner: OWNER, mint: SPYx, uiTokenAmount: { amount: "0" } },
      { accountIndex: 1, owner: OWNER, mint: USDC, uiTokenAmount: { amount: "10000000" } },
    ],
    postTokenBalances: [
      { accountIndex: 0, owner: OWNER, mint: SPYx, uiTokenAmount: { amount: "10000000000" } },
      { accountIndex: 1, owner: OWNER, mint: USDC, uiTokenAmount: { amount: "1000000" } },
    ],
  },
});
const sellTx = () => ({
  slot: 1000,
  blockTime: 1750000000,
  meta: {
    err: null,
    preTokenBalances: [
      { accountIndex: 0, owner: OWNER, mint: SPYx, uiTokenAmount: { amount: "10000000000" } },
      { accountIndex: 1, owner: OWNER, mint: USDC, uiTokenAmount: { amount: "1000000" } },
    ],
    postTokenBalances: [
      { accountIndex: 0, owner: OWNER, mint: SPYx, uiTokenAmount: { amount: "0" } },
      { accountIndex: 1, owner: OWNER, mint: USDC, uiTokenAmount: { amount: "10500000" } },
    ],
  },
});
const TX_BY_SIG = new Map([["sigBuy", buyTx()], ["sigSell", sellTx()]]);

// a fake node answering in reverse ledger order (the real contract), newest first
function fakeClient(page) {
  return {
    async call(method, params) {
      if (method === "getTokenAccountsByOwner") return { value: [] };
      if (method === "getSignaturesForAddress") return params[0] === OWNER ? page : [];
      if (method === "getTransaction") return TX_BY_SIG.get(params[0]) ?? null;
      throw new Error(`unexpected ${method}`);
    },
  };
}
const sigEntry = (name, slot) => ({ signature: name, slot, blockTime: 1750000000, err: null });

async function reportOf(page) {
  const scan = await scanWallet(fakeClient(page), OWNER, REG);
  return { scan, rep: buildWalletReport(scan, { registry: REG }) };
}

test("scan: same-slot transactions process in LEDGER order (the collection sequence breaks the tie)", async () => {
  // the node lists the sell (the later block position) BEFORE the buy of the same slot
  const { scan, rep } = await reportOf([sigEntry("sigSell", 1000), sigEntry("sigBuy", 1000)]);
  assert.deepEqual(scan.txs.map((t) => t.signature), ["sigBuy", "sigSell"],
    "the earlier block position is processed first");
  const t = rep.tokens.find((x) => x.symbol === "SPYx");
  assert.equal(t.gaps.length, 0, "no spurious gap — the sell has a lot to close");
  assert.equal(t.lots.length, 0, "no phantom open lot");
  assert.equal(t.realized.length, 1, "the round trip is realized");
  assert.equal(t.realized[0].pnlRaw, "500000", "pnl = +0.5 USDC (9.5 − 9.0)");
  assert.equal(t.reconciles, true);
  assert.equal(rep.complete, true);
});

test("scan: distinct slots keep their slot order regardless of the list order", async () => {
  const { scan, rep } = await reportOf([sigEntry("sigSell", 1001), sigEntry("sigBuy", 1000)]);
  assert.deepEqual(scan.txs.map((t) => t.signature), ["sigBuy", "sigSell"]);
  const t = rep.tokens.find((x) => x.symbol === "SPYx");
  assert.equal(t.gaps.length, 0);
  assert.equal(t.lots.length, 0);
  assert.equal(t.realized[0].pnlRaw, "500000");
});
