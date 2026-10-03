// The ownership-change branch pairs a pre row with its post row of the same accountIndex
// and compares ONLY owners. A token account cannot change its mint within a tx, so a post
// row carrying a DIFFERENT mint under the same index is a lying-gateway shape: pairing it
// books the old owner a phantom disposal of a mint that is no longer there and the new
// owner an unpriced lot of a mint nobody bought — silently, with no ambiguous marker and
// no warn, only the coarse reconciles:false far downstream. The contract: the pair cannot
// be matched → dropped WHOLE with its own console.error naming the mint mismatch (the
// generic repeated-balance template would diagnose the wrong corruption); a same-mint tx
// of any shape keeps pairing exactly.
import test from "node:test";
import assert from "node:assert/strict";
import { fetchWalletDeltas } from "../src/ingest/tx.mjs";

const M1 = "FirstMint" + "1".repeat(38);
const M2 = "SecondMint" + "2".repeat(37);
const A = "OwnerAaa" + "a".repeat(37);
const B = "OwnerBbb" + "b".repeat(37);
const C = "OwnerCcc" + "c".repeat(37);

const bal = (accountIndex, owner, mint, amount) => ({
  accountIndex,
  owner,
  mint,
  uiTokenAmount: { amount: String(amount) },
});
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

test("a mint swap under one accountIndex is unpairable — dropped whole with a warn, no cross-mint booking", async () => {
  // pre {idx1 A M1 100}, post {idx1 B M2 50}: the split ran on owners alone and booked
  // A|M1 −100 (a phantom disposal of a mint A no longer holds) and B|M2 +50 (a free lot).
  // Both mints are scanned — the swapped-away side must not vanish into the mint filter
  const { result: tx, lines } = await withErrors(() =>
    fetchWalletDeltas(clientOf([bal(1, A, M1, 100)], [bal(1, B, M2, 50)]), "sig-mint-swap", new Set([M1, M2]), { moneyMints: new Set() }));
  assert.deepEqual(tx.deltas, [], "no phantom disposal for A|M1, no free acquisition for B|M2");
  assert.deepEqual(tx.zeroNetMints, [], "no fabricated 'touched, net 0' trace for the swapped pair");
  assert.equal(lines.length, 1, "exactly one warn names the collapse");
  assert.match(lines[0], /accountIndex/);
});

test("the mint-swap drop stays scoped: a pairable bystander account of the same tx keeps his delta", async () => {
  const { result: tx, lines } = await withErrors(() =>
    fetchWalletDeltas(
      clientOf([bal(1, A, M1, 100), bal(2, C, M1, 40)], [bal(2, C, M1, 30), bal(1, B, M2, 50)]),
      "sig-mint-swap-mixed", new Set([M1, M2])));
  assert.deepEqual(tx.deltas, [
    { owner: C, mint: M1, preRaw: 40n, postRaw: 30n, deltaRaw: -10n },
  ], "only the swapped key leaves; the honest account's −10n stays");
  assert.equal(lines.length, 1);
});

test("row order cannot change the verdict of a mint swap mixed with honest rows", async () => {
  const orders = [
    { pre: [bal(1, A, M1, 100), bal(2, C, M1, 40)], post: [bal(2, C, M1, 30), bal(1, B, M2, 50)] },
    { pre: [bal(2, C, M1, 40), bal(1, A, M1, 100)], post: [bal(1, B, M2, 50), bal(2, C, M1, 30)] },
    { pre: [bal(1, A, M1, 100), bal(2, C, M1, 40)], post: [bal(1, B, M2, 50), bal(2, C, M1, 30)] },
  ];
  const seen = [];
  for (const { pre, post } of orders) {
    const { result: tx } = await withErrors(() =>
      fetchWalletDeltas(clientOf(pre, post), "sig-mint-swap-order", new Set([M1, M2])));
    seen.push(JSON.stringify(tx.deltas.map((d) => [d.owner, String(d.deltaRaw)])));
  }
  assert.ok(seen.every((s) => s === seen[0]), `row order changed the money: ${seen.join(" vs ")}`);
  assert.equal(seen[0], JSON.stringify([["OwnerCcc" + "c".repeat(37), "-10"]]));
});

test("the same balance change with the mint intact still pairs exactly — the guard must not overreach", async () => {
  const { result: tx, lines } = await withErrors(() =>
    fetchWalletDeltas(clientOf([bal(1, A, M1, 100)], [bal(1, A, M1, 40)]), "sig-same-mint", new Set([M1])));
  assert.deepEqual(tx.deltas, [
    { owner: A, mint: M1, preRaw: 100n, postRaw: 40n, deltaRaw: -60n },
  ]);
  assert.deepEqual(lines, [], "no warn for a pairable same-mint tx");
});

test("the mint-swap warn names the mint mismatch, not a repeated balance", async () => {
  // the drop rode the ambiguous cleanup, whose template says "a repeated accountIndex …
  // received a second balance of the same pass" — an operator reading it goes hunting for
  // a duplicate balance while the real corruption is a different mint under one index
  const { lines } = await withErrors(() =>
    fetchWalletDeltas(clientOf([bal(1, A, M1, 100)], [bal(1, B, M2, 50)]), "sig-mint-swap-warn", new Set([M1, M2]), { moneyMints: new Set() }));
  assert.equal(lines.length, 1, "exactly one warn — the honest one, not the generic template on top");
  assert.match(lines[0], /accountIndex/);
  assert.ok(lines[0].includes(M1) && lines[0].includes(M2), "both mints of the swap are named");
  assert.doesNotMatch(lines[0], /second balance of the same pass/, "the repeated-balance template must not diagnose a mint swap");
});

test("an honest ownership split with the mint intact still splits — SetAuthority is not a mint swap", async () => {
  const { result: tx, lines } = await withErrors(() =>
    fetchWalletDeltas(clientOf([bal(1, A, M1, 100)], [bal(1, B, M1, 50)]), "sig-split-same-mint", new Set([M1])));
  assert.equal(tx.deltas.length, 2);
  assert.equal(tx.deltas.find((d) => d.owner === A).deltaRaw, -100n);
  assert.equal(tx.deltas.find((d) => d.owner === B).deltaRaw, 50n);
  assert.deepEqual(lines, []);
});
