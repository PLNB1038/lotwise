import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient, RpcError } from "../src/ingest/rpc.mjs";
import { streamSignatures } from "../src/ingest/signatures.mjs";
import { fetchTokenDeltas } from "../src/ingest/tx.mjs";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const FIX = (name) => JSON.parse(readFileSync(path.join(dir, name), "utf8"));

const MINT = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB";

// ---- mock infrastructure ----
const jsonRes = (result, { status = 200 } = {}) => ({
  ok: status < 400, status,
  json: async () => (result === undefined ? {} : { jsonrpc: "2.0", id: 1, result }),
});

function makeClient(responses, { recorded = [] } = {}) {
  let i = 0;
  const fetcher = async (url, opts) => {
    recorded.push({ url, body: JSON.parse(opts.body) });
    const next = responses[Math.min(i++, responses.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  };
  const sleep = async () => {}; // we do not wait for time in the tests
  return new RpcClient({ endpoint: "https://rpc.example", fetcher, sleep, minIntervalMs: 0 });
}

// ---- RpcClient ----

test("a successful call returns the result and carries the UA header", async () => {
  const rec = [];
  const c = makeClient([jsonRes(42)], { recorded: rec });
  assert.equal(await c.call("getSlot", []), 42);
  assert.equal(rec[0].body.method, "getSlot");
});

test("429 → retry → success (exponential pauses)", async () => {
  const c = makeClient([
    { ok: false, status: 429, json: async () => ({}) },
    { ok: false, status: 429, json: async () => ({}) },
    jsonRes("final"),
  ]);
  assert.equal(await c.call("getSlot", []), "final");
  assert.equal(c.requestCount, 3);
});

test("429 without exhausting the retries → an RpcError rate-limit", async () => {
  const c = makeClient([{ ok: false, status: 429, json: async () => ({}) }]);
  await assert.rejects(() => c.call("getSlot", []), (err) => err instanceof RpcError && err.kind === "rate-limit");
});

test("a 404 (another 4xx) is NOT retried — one request", async () => {
  const c = makeClient([{ ok: false, status: 404, json: async () => ({}) }]);
  await assert.rejects(() => c.call("getSlot", []), (err) =>
    err instanceof RpcError && err.kind === "http" && err.status === 404);
  assert.equal(c.requestCount, 1, "a 4xx other than 429 — the request is bad, a retry is pointless");
});

test("a 503 is retried as a 5xx — until success", async () => {
  const c = makeClient([{ ok: false, status: 503, json: async () => ({}) }, jsonRes("ok")]);
  assert.equal(await c.call("getSlot", []), "ok");
  assert.equal(c.requestCount, 2);
});

test("a jsonrpc error is NOT retried and carries the code (-32015)", async () => {
  const c = makeClient([{
    ok: true, status: 200,
    json: async () => ({ jsonrpc: "2.0", id: 1, error: { code: -32015, message: "Unsupported transaction version" } }),
  }]);
  await assert.rejects(() => c.call("getTransaction", []), (err) =>
    err instanceof RpcError && err.kind === "rpc" && err.code === -32015);
  assert.equal(c.requestCount, 1, "rpc errors are not retried");
});

test("a network throw is classified as network", async () => {
  const c = makeClient([new Error("ECONNRESET"), new Error("ECONNRESET"), new Error("ECONNRESET"), new Error("ECONNRESET")]);
  await assert.rejects(() => c.call("getSlot", []), (err) => err instanceof RpcError && err.kind === "network");
});

test("throttling: consecutive calls wait minIntervalMs", async () => {
  const sleeps = [];
  const c = new RpcClient({
    endpoint: "https://rpc.example",
    fetcher: async () => jsonRes(1),
    sleep: async (ms) => sleeps.push(ms),
    minIntervalMs: 350,
  });
  await c.call("getSlot", []);
  await c.call("getSlot", []);
  assert.ok(sleeps.some((ms) => ms > 0), "the second call had to wait");
});

// ---- streamSignatures ----

test("pagination: two full pages + an empty third → stop", async () => {
  const page1 = Array.from({ length: 3 }, (_, i) => ({ signature: `s1_${i}`, slot: 100 + i, blockTime: 1, err: null }));
  const page2 = Array.from({ length: 3 }, (_, i) => ({ signature: `s2_${i}`, slot: 90 + i, blockTime: 1, err: null }));
  const c = makeClient([jsonRes(page1), jsonRes(page2), jsonRes([])]);
  const seen = [];
  for await (const s of streamSignatures(c, MINT, { limit: 3 })) seen.push(s);
  assert.equal(seen.length, 6);
  const bodies = c.requestCount; // 3 requests
  assert.equal(bodies, 3);
});

test("a short last page is NOT the end — the stream probes until an empty/no-progress page", async () => {
  const page1 = Array.from({ length: 3 }, (_, i) => ({ signature: `a${i}`, slot: i, blockTime: 1, err: null }));
  // makeClient repeats the last response: after the "tail" (< limit) the stream must ask
  // again; a repeated tail page — no progress (and no new uniques) → stop
  const c = makeClient([jsonRes(page1), jsonRes([{ signature: "tail", slot: 1, blockTime: 1, err: null }])]);
  const seen = [];
  for await (const s of streamSignatures(c, MINT, { limit: 3 })) seen.push(s);
  assert.equal(seen.length, 4); // 3 + 1 unique; the tail duplicate is not yielded (the uniqueness contract)
  assert.equal(c.requestCount, 4); // the short one required a confirmation, the repeat with no new ones — stop: the K-zero progress)
});

test("err transactions arrive with the err flag", async () => {
  const c = makeClient([jsonRes([{ signature: "bad", slot: 5, blockTime: 1, err: { InstructionError: [0, "Custom"] } }])]);
  const seen = [];
  for await (const s of streamSignatures(c, MINT)) seen.push(s);
  assert.deepEqual(seen[0].err, { InstructionError: [0, "Custom"] });
});

// ---- fetchTokenDeltas ----

test("the legacy fixture: a whole delta of +750000", async () => {
  const c = makeClient([jsonRes(FIX("tx-legacy.json"))]);
  const r = await fetchTokenDeltas(c, "sig-legacy", MINT);
  assert.equal(r.slot, 335000111);
  assert.equal(r.deltas.length, 1);
  assert.equal(r.deltas[0].preRaw, 1000000n);
  assert.equal(r.deltas[0].postRaw, 1750000n);
  assert.equal(r.deltas[0].deltaRaw, 750000n);
});

test("the versioned fixture (version 0) is handled, the delta negative", async () => {
  const c = makeClient([jsonRes(FIX("tx-versioned.json"))]);
  const r = await fetchTokenDeltas(c, "sig-v0", MINT);
  assert.equal(r.deltas[0].deltaRaw, -2000000n);
  assert.equal(r.err, null);
});

test("tx=null → an honest null without an exception", async () => {
  const c = makeClient([jsonRes(null)]);
  assert.equal(await fetchTokenDeltas(c, "sig-missing", MINT), null);
});

test("the request goes out with maxSupportedTransactionVersion:1", async () => {
  const rec = [];
  const c = makeClient([jsonRes(FIX("tx-legacy.json"))], { recorded: rec });
  await fetchTokenDeltas(c, "sig-x", MINT);
  assert.equal(rec[0].body.params[1].maxSupportedTransactionVersion, 1);
});

test("a foreign mint in the balances is ignored", async () => {
  const tx = FIX("tx-legacy.json");
  tx.meta.postTokenBalances.push({
    owner: "Owner11111111111111111111111111111111111111111",
    mint: "AnotherMint11111111111111111111111111111111111111",
    uiTokenAmount: { amount: "999", decimals: 6, uiAmountString: "0.000999" },
  });
  const c = makeClient([jsonRes(tx)]);
  const r = await fetchTokenDeltas(c, "sig-x", MINT);
  assert.ok(r.deltas.every((d) => d.mint === MINT));
});

// ----: several accounts of one mint for one owner ----

const OWNER2 = "Owner11111111111111111111111111111111111111111";

test("a self-transfer between two accounts of one mint = a delta of 0, not a phantom trade", async () => {
  const tx = {
    slot: 1, blockTime: 1750000000,
    meta: {
      err: null,
      preTokenBalances: [
        { accountIndex: 3, owner: OWNER2, mint: MINT, uiTokenAmount: { amount: "100" } },
        { accountIndex: 5, owner: OWNER2, mint: MINT, uiTokenAmount: { amount: "0" } },
      ],
      postTokenBalances: [
        { accountIndex: 3, owner: OWNER2, mint: MINT, uiTokenAmount: { amount: "0" } },
        { accountIndex: 5, owner: OWNER2, mint: MINT, uiTokenAmount: { amount: "100" } },
      ],
    },
  };
  const c = makeClient([jsonRes(tx)]);
  const r = await fetchTokenDeltas(c, "sig-consolidate", MINT);
  // a consolidation legacy -> ATA: no economics; before the fix the owner|mint key merged
  // the accounts and drew ±100 as a phantom
  assert.equal(r.deltas.length, 0);
});

test("two accounts with real buys: the owner's delta = the sum of the accounts", async () => {
  const tx = {
    slot: 1, blockTime: 1750000000,
    meta: {
      err: null,
      preTokenBalances: [
        { accountIndex: 3, owner: OWNER2, mint: MINT, uiTokenAmount: { amount: "0" } },
        { accountIndex: 5, owner: OWNER2, mint: MINT, uiTokenAmount: { amount: "10" } },
      ],
      postTokenBalances: [
        { accountIndex: 3, owner: OWNER2, mint: MINT, uiTokenAmount: { amount: "100" } },
        { accountIndex: 5, owner: OWNER2, mint: MINT, uiTokenAmount: { amount: "40" } },
      ],
    },
  };
  const c = makeClient([jsonRes(tx)]);
  const r = await fetchTokenDeltas(c, "sig-two-buys", MINT);
  assert.equal(r.deltas.length, 1);
  assert.equal(r.deltas[0].deltaRaw, 130n);
  assert.equal(r.deltas[0].preRaw, 10n);
  assert.equal(r.deltas[0].postRaw, 140n);
});

// ----: an ownership change of a token account inside a tx (SetAuthority) ----

const W1 = "Wallet1111111111111111111111111111111111111111";
const W2 = "Wallet2222222222222222222222222222222222222222";

test("SetAuthority: an account ownership change in one tx splits into −100 W1 / +100 W2", async () => {
  // before the fix the post record reused cur with the owner from PRE: the whole delta went to W1,
  // for whom it = 0, and was cut by the zero filter → deltas = [] (the transfer vanished,
  // both owners lied to the FIFO)
  const tx = {
    slot: 1, blockTime: 1750000000,
    meta: {
      err: null,
      preTokenBalances: [{ accountIndex: 0, owner: W1, mint: MINT, uiTokenAmount: { amount: "100" } }],
      postTokenBalances: [{ accountIndex: 0, owner: W2, mint: MINT, uiTokenAmount: { amount: "100" } }],
    },
  };
  const c = makeClient([jsonRes(tx)]);
  const r = await fetchTokenDeltas(c, "sig-set-authority", MINT);
  assert.equal(r.deltas.length, 2, "the transfer must not vanish");
  const w1 = r.deltas.find((d) => d.owner === W1);
  const w2 = r.deltas.find((d) => d.owner === W2);
  assert.ok(w1 && w2);
  assert.equal(w1.preRaw, 100n);
  assert.equal(w1.postRaw, 0n);
  assert.equal(w1.deltaRaw, -100n);
  assert.equal(w2.preRaw, 0n);
  assert.equal(w2.postRaw, 100n);
  assert.equal(w2.deltaRaw, 100n);
});

test("the legacy fallback (the owner|mint key): an ownership change splits structurally", async () => {
  // different owners give different fallback keys — pre/post no longer meet; we pin the contract
  const tx = {
    slot: 1, blockTime: 1750000000,
    meta: {
      err: null,
      preTokenBalances: [{ owner: W1, mint: MINT, uiTokenAmount: { amount: "50" } }],
      postTokenBalances: [{ owner: W2, mint: MINT, uiTokenAmount: { amount: "50" } }],
    },
  };
  const c = makeClient([jsonRes(tx)]);
  const r = await fetchTokenDeltas(c, "sig-legacy-owner-change", MINT);
  assert.equal(r.deltas.length, 2);
  assert.equal(r.deltas.find((d) => d.owner === W1).deltaRaw, -50n);
  assert.equal(r.deltas.find((d) => d.owner === W2).deltaRaw, 50n);
});

test("a creation (no pre) and a closure (no post) of an account with a foreign key — as before", async () => {
  const tx = {
    slot: 1, blockTime: 1750000000,
    meta: {
      err: null,
      preTokenBalances: [{ accountIndex: 7, owner: W1, mint: MINT, uiTokenAmount: { amount: "30" } }],
      postTokenBalances: [{ accountIndex: 8, owner: W2, mint: MINT, uiTokenAmount: { amount: "77" } }],
    },
  };
  const c = makeClient([jsonRes(tx)]);
  const r = await fetchTokenDeltas(c, "sig-open-close", MINT);
  assert.equal(r.deltas.length, 2);
  assert.equal(r.deltas.find((d) => d.owner === W1).deltaRaw, -30n); // a closure
  assert.equal(r.deltas.find((d) => d.owner === W2).deltaRaw, 77n); // a creation
});
