// Balances are paired by accountIndex, and the ownership-change branch pairs a pre row
// with its post row by trusting BOTH rows to carry an owner. A row with accountIndex but
// WITHOUT an owner (a lying/throttling gateway — the same class the fallback key exists
// for) is unpairable evidence: cur.owner !== b.owner fires against b.owner === undefined,
// the split runs, and the aggregation books −preRaw to the old owner and +postRaw to the
// literal undefined — a fabricated disposal AND a fabricated acquisition under a nonsense
// owner, silently. The contract: an ownerless row cannot be paired with anything → the
// key goes to the SAME ambiguous verdict as a repeated balance — dropped WHOLE with the
// existing console.error, no deltas, no fabricated zeroNetMints trace.
import test from "node:test";
import assert from "node:assert/strict";
import { fetchWalletDeltas } from "../src/ingest/tx.mjs";

const MINT = "OwnerlessMint" + "1".repeat(34);
const OLD = "OldOwner" + "1".repeat(37);
const NEW = "NewOwner" + "2".repeat(37);
const BYSTANDER = "BystanderOwner" + "3".repeat(35);

const bal = (owner, amount, mint = MINT) => ({
  accountIndex: 1,
  ...(owner === undefined ? {} : { owner }),
  mint,
  uiTokenAmount: { amount: String(amount) },
});
const idx2 = (owner, amount, mint = MINT) => ({
  accountIndex: 2,
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

test("an ownerless POST row cannot be split against its pre row — the pair is dropped whole with a warn", async () => {
  // pre {idx1 OLD 100}, post {idx1 (no owner) 50}: the split used to book OLD −100 and
  // `undefined|undefined` +50 — a phantom disposal and a phantom acquisition, no warn
  const { result: tx, lines } = await withErrors(() =>
    fetchWalletDeltas(clientOf([bal(OLD, 100)], [bal(undefined, 50)]), "sig-ownerless-post", new Set([MINT]), { moneyMints: new Set() }));
  assert.deepEqual(tx.deltas, [], "no fabricated disposal for the old owner, no acquisition under the literal undefined owner");
  assert.deepEqual(tx.zeroNetMints, [], "no fabricated 'touched, net 0' trace for a dropped pair");
  assert.equal(lines.length, 1, "exactly one warn names the collapse");
  assert.match(lines[0], /accountIndex/);
});

test("an ownerless PRE row is the same unpairable evidence (owner: null form too)", async () => {
  // the symmetric shape: {idx1 null 70} pre against {idx1 NEW 70} post used to book
  // undefined|undefined −70 and NEW +70. owner: null is NOT undefined — typeof must
  // catch both, a gateway is not obliged to pick one
  const { result: tx, lines } = await withErrors(() =>
    fetchWalletDeltas(clientOf([bal(null, 70)], [bal(NEW, 70)]), "sig-ownerless-pre", new Set([MINT]), { moneyMints: new Set() }));
  assert.deepEqual(tx.deltas, [], "no −70 under a nonsense owner, no +70 fabricated for NEW");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /accountIndex/);
});

test("the drop is scoped to the ownerless key — a pairable bystander of the same tx keeps his delta", async () => {
  const { result: tx, lines } = await withErrors(() =>
    fetchWalletDeltas(
      clientOf([bal(OLD, 100), idx2(BYSTANDER, 40)], [bal(undefined, 50), idx2(BYSTANDER, 10)]),
      "sig-ownerless-mixed", new Set([MINT]), { moneyMints: new Set() }));
  assert.deepEqual(tx.deltas, [
    { owner: BYSTANDER, mint: MINT, preRaw: 40n, postRaw: 10n, deltaRaw: -30n },
  ], "the ambiguous ownerless pair leaves whole, the innocent owner's −30n stays");
  assert.equal(tx.deltas.some((d) => d.owner === undefined), false, "no delta ever carries the undefined owner");
  assert.equal(lines.length, 1, "one warn for the one ambiguous pair");
});

test("row order cannot resurrect the fabricated owner: ownerless + ownerful of one key is dropped under any order", async () => {
  const orders = [
    { pre: [bal(undefined, 100), bal(OLD, 100)], post: [bal(OLD, 50)] },
    { pre: [bal(OLD, 100), bal(undefined, 100)], post: [bal(OLD, 50)] },
    { pre: [bal(OLD, 100)], post: [bal(OLD, 50), bal(undefined, 100)] },
    { pre: [bal(OLD, 100)], post: [bal(undefined, 100), bal(OLD, 50)] },
  ];
  const seen = [];
  for (const { pre, post } of orders) {
    const { result: tx } = await withErrors(() =>
      fetchWalletDeltas(clientOf(pre, post), "sig-ownerless-order", new Set([MINT]), { moneyMints: new Set() }));
    seen.push(JSON.stringify(tx.deltas.map((d) => [d.owner, String(d.deltaRaw)])));
  }
  assert.ok(seen.every((s) => s === seen[0]), `row order changed the money: ${seen.join(" vs ")}`);
  assert.equal(seen[0], "[]", "an unpairable ownerless pair leaves no deltas under any order");
});

test("an empty-string owner is the same ownerless class — the split must not fire against \"\"", async () => {
  // typeof "" === "string": a POST row with owner "" passed the ownerless guard, the
  // ownership-change branch fired (OLD !== ""), and the split booked OLD a phantom −100
  // disposal plus a +50 acquisition under the owner "" that no wallet ever matches —
  // zero warns. The same lying-gateway class, one spelling further.
  const { result: tx, lines } = await withErrors(() =>
    fetchWalletDeltas(clientOf([bal(OLD, 100)], [bal("", 50)]), "sig-empty-owner-post", new Set([MINT]), { moneyMints: new Set() }));
  assert.deepEqual(tx.deltas, [], "no phantom disposal for OLD, no acquisition under the empty-string owner");
  assert.deepEqual(tx.zeroNetMints, [], "no fabricated 'touched, net 0' trace for a dropped pair");
  assert.equal(lines.length, 1, "exactly one warn names the collapse");
  assert.match(lines[0], /accountIndex/);
  // the symmetric PRE-side shape: "" before, NEW after — the same unpairable evidence
  const { result: preTx, lines: preLines } = await withErrors(() =>
    fetchWalletDeltas(clientOf([bal("", 100)], [bal(NEW, 50)]), "sig-empty-owner-pre", new Set([MINT]), { moneyMints: new Set() }));
  assert.deepEqual(preTx.deltas, [], "no −100 under the empty-string owner, no phantom +50 for NEW");
  assert.equal(preLines.length, 1);
  assert.match(preLines[0], /accountIndex/);
});
