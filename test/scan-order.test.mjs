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

test("scan: a same-slot pair from TWO sources is deterministic but flagged — completeness is withdrawn", async () => {
  // the delegated sell is visible ONLY through the token-account page, which is collected
  // AFTER the owner page: the ledger order of such a pair is not recoverable from the RPC
  // (only within one source the list is reverse-ledger). The order below is a deterministic
  // guess — the report must not certify a guessed history as complete while reconciles:true.
  const ATA = USDC; // any valid 32-byte base58 pubkey distinct from the owner and the mint
  let acctCalls = 0;
  const client = {
    async call(method, params) {
      if (method === "getTokenAccountsByOwner") {
        acctCalls++;
        return {
          value: acctCalls === 1
            ? [{ pubkey: ATA, account: { data: { parsed: { info: { mint: SPYx, tokenAmount: { amount: "0" } } } } } }]
            : [],
        };
      }
      if (method === "getSignaturesForAddress") {
        if (params[0] === OWNER) return [sigEntry("sigBuy", 1000)];
        // a failed tx precedes the sell on the ATA page, so the sell's per-source index
        // is 1: a tiebreak that ignores the SOURCE (a plain collection order) would invert
        // the pair — the index alone does not know which source it came from
        if (params[0] === ATA) return [{ signature: "sigDropped", slot: 999, blockTime: 1750000000, err: { Err: 1 } }, sigEntry("sigSell", 1000)];
        return [];
      }
      if (method === "getTransaction") return TX_BY_SIG.get(params[0]) ?? null;
      throw new Error(`unexpected ${method}`);
    },
  };
  const scan = await scanWallet(client, OWNER, REG);
  assert.deepEqual(scan.txs.map((t) => t.signature), ["sigBuy", "sigSell"],
    "deterministic: the owner source orders before the account source");
  assert.equal(scan.ambiguousSlotPairs, 1, "the cross-source same-slot pair is counted");
  const rep = buildWalletReport(scan, { registry: REG });
  assert.equal(rep.complete, false, "a guessed ledger order is not a complete history");
  assert.equal(rep.ambiguousSlotPairs, 1, "the flag travels with the report");
});

test("scan: the same window with a different listing order produces the same report", async () => {
  // the provider does not guarantee the order of getTokenAccountsByOwner, and the src
  // indexes inherited it: two scans of the SAME window could order a cross-source
  // same-slot pair differently and flip the FIFO (realizedQty 10/gaps 0 vs 0/1) — the
  // "deterministic guess" was only deterministic within one set of responses. The
  // listing is now sorted, so the source order — and the guess built on it — is
  // reproducible scan-to-scan.
  const ACCT_A = USDC; // any valid 32-byte base58 pubkey
  const ACCT_B = "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp"; // the AAPLx mint as an address constant
  const run = async (order) => {
    let acctCalls = 0;
    const client = {
      async call(method, params) {
        if (method === "getTokenAccountsByOwner") {
          acctCalls++;
          return {
            value: acctCalls === 1
              ? order.map((pub) => ({ pubkey: pub, account: { data: { parsed: { info: { mint: SPYx, tokenAmount: { amount: "0" } } } } } }))
              : [],
          };
        }
        if (method === "getSignaturesForAddress") {
          if (params[0] === ACCT_A) return [sigEntry("sigBuy", 1000)];
          if (params[0] === ACCT_B) return [sigEntry("sigSell", 1000)];
          return [];
        }
        if (method === "getTransaction") return TX_BY_SIG.get(params[0]) ?? null;
        throw new Error(`unexpected ${method}`);
      },
    };
    const scan = await scanWallet(client, OWNER, REG);
    const rep = buildWalletReport(scan, { registry: REG });
    const t = rep.tokens.find((x) => x.symbol === "SPYx");
    return {
      order: scan.txs.map((x) => x.signature),
      gaps: t.gaps.length,
      realized: t.realized.length,
      ambiguous: scan.ambiguousSlotPairs,
    };
  };
  const ab = await run([ACCT_A, ACCT_B]);
  const ba = await run([ACCT_B, ACCT_A]);
  assert.deepEqual(ab, ba, "the provider's listing order must not change the report");
  assert.deepEqual(ab.order, ["sigBuy", "sigSell"], "the stable source order is the sorted one");
  assert.equal(ab.gaps, 0, "the full round trip, no flip");
});

test("scan: ambiguousSlotPairs counts EVERY cross-source pair of the slot, not adjacent ones", async () => {
  // four owner-seen txs and two account-seen txs in ONE slot: the unknowable pairwise
  // orders are every (owner, account) combination = 4×2 = 8, not "the adjacent ones" (1)
  const ATA = USDC;
  const anyDeltaTx = (sig) => ({
    slot: 1000, blockTime: 1750000000, signature: sig,
    meta: { err: null,
      preTokenBalances: [{ accountIndex: 0, owner: OWNER, mint: SPYx, uiTokenAmount: { amount: "10000000000" } }],
      postTokenBalances: [{ accountIndex: 0, owner: OWNER, mint: SPYx, uiTokenAmount: { amount: "9900000000" } }] },
  });
  const TX = new Map(["o1", "o2", "o3", "o4", "a1", "a2"].map((s) => [s, anyDeltaTx(s)]));
  let acctCalls = 0;
  const client = {
    async call(method, params) {
      if (method === "getTokenAccountsByOwner") {
        acctCalls++;
        return { value: acctCalls === 1 ? [{ pubkey: ATA, account: { data: { parsed: { info: { mint: SPYx, tokenAmount: { amount: "0" } } } } } }] : [] };
      }
      if (method === "getSignaturesForAddress") {
        if (params[0] === OWNER) return ["o1", "o2", "o3", "o4"].map((n) => sigEntry(n, 1000));
        if (params[0] === ATA) return ["a1", "a2"].map((n) => sigEntry(n, 1000));
        return [];
      }
      if (method === "getTransaction") return TX.get(params[0]) ?? null;
      throw new Error(`unexpected ${method}`);
    },
  };
  const scan = await scanWallet(client, OWNER, REG);
  assert.equal(scan.txs.length, 6, "all six kept");
  assert.equal(scan.ambiguousSlotPairs, 8, "4×2 cross-source pairs — every combination, not adjacency");
  const rep = buildWalletReport(scan, { registry: REG });
  assert.equal(rep.complete, false);
  assert.equal(rep.ambiguousSlotPairs, 8);
});
