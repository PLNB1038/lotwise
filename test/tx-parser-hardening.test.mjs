// formerly round16-h3.test.mjs
// Round 16 — wave H3 [P1×3 + P2]: the transaction layer of the scan.
//   H3-1 [P1] a single poison-tx with garbage meta crashed the ENTIRE scan (8 TypeError vectors) —
//          the wallet became permanently unscannable. The ROUND7 #14 contract "a broken tx =
//          skipped with a reason" must cover parser throws too.
//   H3-2 [P1] a persistent RpcError on ONE tx (-32015 on versioned) — the same lethal
//          outcome via the rpc client's immediate throw.
//   H3-3 [P1] getTokenAccountsByOwner: a non-array value and garbage entries (pubkey 12345,
//          amount "1e6", broken base58) — raw TypeErrors from scanWallet and broken addresses in
//          the signature sources (a mirror of ROUND9 #3, closed only for signatures).
//   H3-4 [P2] a tx with meta:null (an indexer lag) silently vanished: fetched+1, neither in txs nor in
//          skipped — a fail-closed violation. Now — an honest "tx unavailable" skip.
import test from "node:test";
import assert from "node:assert/strict";
import { scanWallet, WalletScanError } from "../src/wallet/scan.mjs";
import { RpcError } from "../src/ingest/rpc.mjs";

const OWNER = "Wa11etBuyer" + "a".repeat(32);
const SPYx = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const REGISTRY = [{ mint: SPYx, symbol: "SPYx", decimals: 8, issuer: "test" }];

const goodTx = (amount, slot) => ({
  slot,
  blockTime: slot * 1000,
  meta: {
    err: null,
    preTokenBalances: [],
    postTokenBalances: [{ owner: OWNER, mint: SPYx, uiTokenAmount: { amount: String(amount) } }],
  },
});

// the txs value may be a function — for throws on a specific signature
function fakeClient({ sigPages = {}, txs = {}, accountsByProgram = {} } = {}) {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push({ method, key: params[0] });
      if (method === "getSignaturesForAddress") return sigPages[params[0]] ?? [];
      if (method === "getTokenAccountsByOwner") return accountsByProgram[params[1]?.programId] ?? { value: [] };
      if (method === "getTransaction") {
        const t = txs[params[0]];
        if (typeof t === "function") return t();
        return t ?? null;
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
}

test("scan: a poison-tx with a broken meta — skipped with a reason, the scan lives, good txs in the report", async () => {
  const client = fakeClient({
    sigPages: { [OWNER]: [
      { signature: "poison", slot: 2, blockTime: 2000, err: null },
      { signature: "good1", slot: 1, blockTime: 1000, err: null },
      { signature: "good2", slot: 3, blockTime: 3000, err: null },
    ] },
    txs: {
      good1: goodTx(100, 1),
      poison: { slot: 2, blockTime: 2000, meta: { preTokenBalances: 5 } }, // garbage from a lying gateway
      good2: goodTx(50, 3),
    },
  });
  const res = await scanWallet(client, OWNER, REGISTRY);
  assert.equal(res.txs.length, 2, "both valid txs in the history");
  assert.equal(res.fetched, 3);
  assert.equal(res.skipped.length, 1);
  assert.match(res.skipped[0].reason, /tx unreadable/, "the poisoned tx — with a reason, not with a crash");
  assert.equal(res.skipped[0].signature, "poison");
});

test("scan: a persistent RpcError on one tx (-32015 versioned) — a skip, not the death of the scan", async () => {
  const client = fakeClient({
    sigPages: { [OWNER]: [
      { signature: "v0tx", slot: 2, blockTime: 2000, err: null },
      { signature: "good1", slot: 1, blockTime: 1000, err: null },
    ] },
    txs: {
      good1: goodTx(100, 1),
      v0tx: () => { throw new RpcError("rpc", "-32015: Unsupported transaction version", { code: -32015 }); },
    },
  });
  const res = await scanWallet(client, OWNER, REGISTRY);
  assert.equal(res.txs.length, 1);
  assert.match(res.skipped[0].reason, /-32015/, "the error code is visible in the skip reason");
});

test("scan: our abort is NOT swallowed as \"tx unreadable\" — it flies on", async () => {
  const client = fakeClient({
    sigPages: { [OWNER]: [{ signature: "s1", slot: 1, blockTime: 1000, err: null }] },
    txs: { s1: () => { throw new WalletScanError("scan aborted by client", "aborted"); } },
  });
  await assert.rejects(
    () => scanWallet(client, OWNER, REGISTRY),
    (err) => err instanceof WalletScanError && err.kind === "aborted",
  );
});

test("scan: a tx with meta:null (an indexer lag) — an honest skip, not a silent disappearance", async () => {
  const client = fakeClient({
    sigPages: { [OWNER]: [
      { signature: "noMeta", slot: 1, blockTime: 1000, err: null },
      { signature: "good1", slot: 2, blockTime: 2000, err: null },
    ] },
    txs: {
      noMeta: { slot: 1, blockTime: 1000, meta: null }, // a skeleton without substance
      good1: goodTx(100, 2),
    },
  });
  const res = await scanWallet(client, OWNER, REGISTRY);
  assert.equal(res.fetched, 2);
  assert.ok(res.skipped.some((s) => s.signature === "noMeta" && /unavailable/.test(s.reason)),
    "meta:null = unavailable substance, visible in skipped (before: fetched+1 and silence)");
});

test("scan: getTokenAccountsByOwner with value:5 — an explicit malformed-source, not a TypeError", async () => {
  const client = fakeClient({
    accountsByProgram: { "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb": { value: 5 } },
  });
  await assert.rejects(
    () => scanWallet(client, OWNER, REGISTRY),
    (err) => err instanceof WalletScanError && err.kind === "malformed-source" && /getTokenAccountsByOwner/.test(err.message),
  );
});

test("scan: garbage account entries — a skip with a warn, broken pubkeys do NOT become signature sources", async () => {
  const bad41 = "1".repeat(41); // base58-invalid (the E4 class)
  const client = fakeClient({
    accountsByProgram: { "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb": { value: [
      { pubkey: 12345, account: { data: { parsed: { info: { mint: SPYx, tokenAmount: { amount: "1e6" } } } } } }, // a number pubkey + a garbage amount
      { pubkey: bad41, account: { data: { parsed: { info: { mint: SPYx, tokenAmount: { amount: "7" } } } } } }, // broken base58
    ] } },
    sigPages: { [OWNER]: [] },
  });
  const res = await scanWallet(client, OWNER, REGISTRY);
  const sigSources = client.calls.filter((c) => c.method === "getSignaturesForAddress").map((c) => c.key);
  assert.ok(!sigSources.includes(bad41) && !sigSources.includes(12345), "broken pubkeys do not burn RPC and do not kill the scan");
  assert.deepEqual([...res.accounts.values()], [], "garbage balances did not get into the reconcile");
});
