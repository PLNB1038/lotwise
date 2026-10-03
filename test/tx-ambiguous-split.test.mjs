// The ambiguous-key cleanup drops a key that received a SECOND balance of one pass —
// and the ownership-change branch (SetAuthority within a tx) moves the pre-side entry
// under a synthetic `${key}~${oldOwner}` sibling. The cleanup used to delete only the
// key itself, so the sibling survived as a phantom disposal booked to the old owner
// while the new owner's acquisition vanished — and which side survived depended on the
// ORDER of the rows within the pass. The contract: an ambiguous pair is dropped WHOLE
// ("the whole owner+mint pair is dropped from this tx"), independent of row order.
import test from "node:test";
import assert from "node:assert/strict";
import { fetchWalletDeltas } from "../src/ingest/tx.mjs";

const MINT = "SplitMint" + "1".repeat(36);
const OLD = "OldOwner" + "1".repeat(37);
const NEW = "NewOwner" + "2".repeat(37);

const idx = (owner, amount) => ({ accountIndex: 1, owner, mint: MINT, uiTokenAmount: { amount: String(amount) } });
const clientOf = (pre, post) => ({
  call: async () => ({
    slot: 1,
    blockTime: 1750000000,
    meta: { err: null, preTokenBalances: pre, postTokenBalances: post },
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

test("an ambiguous accountIndex that also changed owner drops BOTH sides — no phantom disposal for the old owner", async () => {
  // pre carries two balances of accountIndex 1 (unpairable); post carries the
  // SetAuthority shape: the same index now belongs to NEW with 50 left
  const { result: tx, lines } = await withErrors(() =>
    fetchWalletDeltas(clientOf([idx(OLD, 100), idx(NEW, 0)], [idx(NEW, 50)]), "sig-split-ambiguous", new Set([MINT]), { moneyMints: new Set() }));
  assert.deepEqual(tx.deltas, [], "the unpairable pair is dropped whole: the old owner's −100 pre-side must not survive as a phantom disposal");
  assert.deepEqual(tx.zeroNetMints, [], "no fabricated 'touched, net 0' trace for a dropped pair");
  assert.equal(lines.length, 1, "exactly one warn names the collapse");
  assert.match(lines[0], /accountIndex/);
});

test("the same tx is order-independent: permuting the pre rows cannot change the money", async () => {
  const orders = [
    [idx(OLD, 100), idx(NEW, 0)],
    [idx(NEW, 0), idx(OLD, 100)],
  ];
  const seen = [];
  for (const pre of orders) {
    const { result: tx } = await withErrors(() =>
      fetchWalletDeltas(clientOf(pre, [idx(NEW, 50)]), "sig-order", new Set([MINT])));
    seen.push(JSON.stringify(tx.deltas.map((d) => [d.owner, String(d.deltaRaw)])));
  }
  assert.ok(seen.every((s) => s === seen[0]), `row order changed the money: ${seen.join(" vs ")}`);
  assert.equal(seen[0], "[]", "an unpairable pair leaves no deltas under any order");
});

test("a second POST balance of a split account is caught too — the synthetic sibling goes with the key", async () => {
  // single pre balance (the split fires), but post repeats the index: unpairable
  const { result: tx, lines } = await withErrors(() =>
    fetchWalletDeltas(clientOf([idx(OLD, 100)], [idx(NEW, 50), idx(NEW, 30)]), "sig-split-dup-post", new Set([MINT])));
  assert.deepEqual(tx.deltas, [], "both the new owner's entry and the moved pre-side entry are gone");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /accountIndex/);
});

test("an UNambiguous ownership change still splits honestly — the fix must not swallow the real transfer", async () => {
  const { result: tx, lines } = await withErrors(() =>
    fetchWalletDeltas(clientOf([idx(OLD, 100)], [idx(NEW, 50)]), "sig-split-clean", new Set([MINT])));
  assert.equal(tx.deltas.length, 2);
  assert.equal(tx.deltas.find((d) => d.owner === OLD).deltaRaw, -100n);
  assert.equal(tx.deltas.find((d) => d.owner === NEW).deltaRaw, 50n);
  assert.deepEqual(lines, [], "no warn for a pairable tx");
});
