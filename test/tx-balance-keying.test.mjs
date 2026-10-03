// fetchWalletDeltas keys balances by accountIndex — the one field that pairs a pre row
// with its post row. A lying/incomplete gateway that omits it falls back to owner|mint,
// and a fallback key that receives a SECOND balance of the same owner+mint cannot be
// paired: Map.set silently kept only the last row, so a real disposal netted against a
// phantom buy and vanished from the FIFO material (delta 0, zeroNetMints trace, no warn).
// The contract: a UNIQUE fallback key (one account per owner+mint) pairs exactly and
// stays; an ambiguous key is dropped WHOLE with a console.error — never a silent collapse.
import test from "node:test";
import assert from "node:assert/strict";
import { fetchWalletDeltas } from "../src/ingest/tx.mjs";

const MINT = "BalanceMint" + "1".repeat(34);
const OWNER = "WalletOwner111111111111111111111111111111111";
const BUYER = "SecondOwner" + "2".repeat(33);

const noIndexClient = (pre, post) => ({
  call: async () => ({
    slot: 1,
    blockTime: 1750000000,
    meta: {
      err: null,
      preTokenBalances: pre.map((amount) => ({ owner: OWNER, mint: MINT, uiTokenAmount: { amount } })),
      postTokenBalances: post.map((amount) => ({ owner: OWNER, mint: MINT, uiTokenAmount: { amount } })),
    },
  }),
});

// a spy on console.error: the ambiguous-collapse warn is the expected channel
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

test("two accounts of one owner+mint without accountIndex are dropped with a warn — not collapsed into a silent zero", async () => {
  // legacy 150 + ATA 50 pre; 50 + 50 post (100 sold): the collapse produced delta 0,
  // an empty deltas array and a "touched, net 0" trace — a disposal erased from the
  // FIFO material with no realized, no proceeds, no gap and no warn anywhere
  const { result: tx, lines } = await withErrors(() =>
    fetchWalletDeltas(noIndexClient(["150", "50"], ["50", "50"]), "sig-ambiguous", new Set([MINT]), { moneyMints: new Set() }));
  assert.deepEqual(tx.deltas, [], "an unpairable pair carries no deltas — nothing is guessed");
  assert.deepEqual(tx.zeroNetMints, [], "no fabricated 'touched, net 0' trace");
  assert.deepEqual(tx.moneyDeltas, []);
  assert.equal(lines.length, 1, "exactly one warn names the collapse");
  assert.match(lines[0], /accountIndex/);
  assert.ok(lines[0].includes(MINT), "the warn names the mint");
});

test("the closed-account shape (pre 150+50, post 50) is dropped too — the disposal stays loud, not booked as nothing", async () => {
  const { result: tx, lines } = await withErrors(() =>
    fetchWalletDeltas(noIndexClient(["150", "50"], ["50"]), "sig-closed", new Set([MINT]), { moneyMints: new Set() }));
  assert.deepEqual(tx.deltas, []);
  assert.deepEqual(tx.zeroNetMints, []);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /accountIndex/);
});

test("a UNIQUE owner|mint fallback (one account per owner+mint) stays exact — the honest single-account case", async () => {
  const { result: tx, lines } = await withErrors(() =>
    fetchWalletDeltas(noIndexClient(["100"], ["50"]), "sig-single", new Set([MINT]), { moneyMints: new Set() }));
  assert.equal(tx.deltas.length, 1);
  assert.equal(tx.deltas[0].deltaRaw, -50n);
  assert.deepEqual(lines, [], "no warn for a pairable tx");
});

test("different owners without accountIndex never collide — the fallback key carries the owner", async () => {
  const client = {
    call: async () => ({
      slot: 1, blockTime: 1750000000,
      meta: {
        err: null,
        preTokenBalances: [{ owner: OWNER, mint: MINT, uiTokenAmount: { amount: "50" } }],
        postTokenBalances: [
          { owner: OWNER, mint: MINT, uiTokenAmount: { amount: "0" } },
          { owner: BUYER, mint: MINT, uiTokenAmount: { amount: "50" } },
        ],
      },
    }),
  };
  const { result: tx, lines } = await withErrors(() =>
    fetchWalletDeltas(client, "sig-two-owners", new Set([MINT]), { moneyMints: new Set() }));
  assert.equal(tx.deltas.length, 2);
  assert.equal(tx.deltas.find((d) => d.owner === OWNER).deltaRaw, -50n);
  assert.equal(tx.deltas.find((d) => d.owner === BUYER).deltaRaw, 50n);
  assert.deepEqual(lines, []);
});

test("a repeated accountIndex within one pass is the same silent-overwrite shape — dropped with a warn", async () => {
  // accountIndex is unique within a tx; a gateway repeating index 3 in pre used to let
  // the second row overwrite the first via Map.set — the same quiet collapse
  const client = {
    call: async () => ({
      slot: 1, blockTime: 1750000000,
      meta: {
        err: null,
        preTokenBalances: [
          { accountIndex: 3, owner: OWNER, mint: MINT, uiTokenAmount: { amount: "150" } },
          { accountIndex: 3, owner: OWNER, mint: MINT, uiTokenAmount: { amount: "50" } },
        ],
        postTokenBalances: [{ accountIndex: 3, owner: OWNER, mint: MINT, uiTokenAmount: { amount: "50" } }],
      },
    }),
  };
  const { result: tx, lines } = await withErrors(() =>
    fetchWalletDeltas(client, "sig-dup-idx", new Set([MINT]), { moneyMints: new Set() }));
  assert.deepEqual(tx.deltas, []);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /accountIndex/);
});

test("a repeated accountIndex in the POST pass alone is caught as well", async () => {
  const client = {
    call: async () => ({
      slot: 1, blockTime: 1750000000,
      meta: {
        err: null,
        preTokenBalances: [{ accountIndex: 5, owner: OWNER, mint: MINT, uiTokenAmount: { amount: "10" } }],
        postTokenBalances: [
          { accountIndex: 5, owner: OWNER, mint: MINT, uiTokenAmount: { amount: "20" } },
          { accountIndex: 5, owner: OWNER, mint: MINT, uiTokenAmount: { amount: "30" } },
        ],
      },
    }),
  };
  const { result: tx, lines } = await withErrors(() =>
    fetchWalletDeltas(client, "sig-dup-idx-post", new Set([MINT]), { moneyMints: new Set() }));
  assert.deepEqual(tx.deltas, []);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /accountIndex/);
});
