// Adversarial boundaries of the wallet scanner and the FIFO report.
// The ACTUAL behavior is pinned via a mock client (no network, as is the custom in these tests).
// History: the "GAP:" mark recorded a hole/asymmetry of the current behavior (src was
// not fixed); the GAPs found in that round (failed-tx, a doubled balance, the maxTxs
// cap) were fixed in src — their pins are rewritten for the correct behavior.
import test from "node:test";
import assert from "node:assert/strict";
import { scanWallet, fetchOwnerTokenAccounts, TOKEN_PROGRAMS, WalletScanError } from "../src/wallet/scan.mjs";
import { buildWalletReport } from "../src/wallet/report.mjs";
import { fetchWalletDeltas } from "../src/ingest/tx.mjs";

// strictly base58 (without 0, O, I, l)
const SPYx = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const AAPLx = "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp";
const OWNER = "Wa11etBuyer" + "a".repeat(32);
const UNTRACKED = "Untracked1111111111111111111111111111111111";

const REG = [
  { mint: SPYx, symbol: "SPYx", name: "S&P 500 xStock", decimals: 8 },
  { mint: AAPLx, symbol: "AAPLx", name: "Apple xStock", decimals: 8 },
];

// a fake client with REAL pagination: pages are cut by before, like the public RPC
function fakeScanClient({ pages = {}, txs = {}, accountsByProgram = {} } = {}) {
  const sigCalls = []; // the before parameter of each getSignaturesForAddress
  const txCalls = []; // the parameters of each getTransaction
  return {
    sigCalls,
    txCalls,
    async call(method, params) {
      if (method === "getTokenAccountsByOwner") {
        return accountsByProgram[params[1]?.programId] ?? { value: [] };
      }
      if (method === "getSignaturesForAddress") {
        sigCalls.push(params[1]?.before);
        const all = pages[params[0]] ?? [];
        const before = params[1]?.before;
        const start = before === undefined ? 0 : all.findIndex((s) => s.signature === before) + 1;
        return all.slice(start, start + params[1].limit);
      }
      if (method === "getTransaction") {
        txCalls.push(params);
        return txs[params[0]] ?? null;
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
}

const sig = (s, slot, err = null) => ({ signature: s, slot, blockTime: slot, err });

// a getTransaction response: pre is taken from _pre, post — from uiTokenAmount.amount
const txOf = (sig_, balances, { slot = 1, blockTime = 1750000000, version } = {}) => ({
  slot,
  blockTime,
  ...(version !== undefined ? { version } : {}),
  meta: {
    err: null,
    preTokenBalances: balances.filter((b) => b._pre !== undefined)
      .map((b) => ({ owner: b.owner, mint: b.mint, uiTokenAmount: { amount: String(b._pre) } })),
    postTokenBalances: balances.map((b) => ({ owner: b.owner, mint: b.mint, uiTokenAmount: { amount: String(b.uiTokenAmount.amount) } })),
  },
});

// a clean report over an assembled scan (assembled scan fixture)
const scanOf = (txs, extra = {}) => ({
  owner: OWNER, signatures: txs.length, fetched: txs.length, txs, skipped: [], truncated: false, accounts: {}, ...extra,
});

const delta1 = (sig_, slot, deltaRaw, blockTime = slot * 100) => ({
  signature: sig_, slot, blockTime,
  deltas: [{ owner: OWNER, mint: SPYx, preRaw: 0n, postRaw: 0n, deltaRaw }],
});

// A spy on console.error : the scanner warn is the only expected channel
async function captureConsoleError(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...args) => lines.push(args.map(String).join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = orig;
  }
}

// ===========================================================================
// Group 1. Scan: the boundaries of the signature stream
// ===========================================================================

test("scanWallet: an empty history across all sources — zeros, not truncated, getTransaction is not called", async () => {
  const client = fakeScanClient({ pages: { [OWNER]: [] } });
  const scan = await scanWallet(client, OWNER, REG);
  assert.equal(scan.signatures, 0);
  assert.equal(scan.fetched, 0);
  assert.deepEqual(scan.txs, []);
  assert.deepEqual(scan.skipped, []);
  assert.equal(scan.truncated, false);
  assert.equal(client.sigCalls.length, 5, "one walk per source: the address + a derived ATA per (registry mint × token program) — each empty after one page");
  assert.equal(client.txCalls.length, 0, "nothing to fetch");
});

test("scanWallet: signatures exist but the txs touch no registry mints — fetched, but txs/skipped are empty", async () => {
  const client = fakeScanClient({
    pages: { [OWNER]: [sig("foreign", 1)] },
    txs: { foreign: txOf("foreign", [
      { owner: OWNER, mint: UNTRACKED, _pre: 0, uiTokenAmount: { amount: "99" } },
    ]) },
  });
  const scan = await scanWallet(client, OWNER, REG);
  assert.equal(scan.signatures, 1);
  assert.equal(scan.fetched, 1, "the tx was fetched — the work is counted");
  assert.deepEqual(scan.txs, [], "an irrelevant tx does not get into the history");
  assert.deepEqual(scan.skipped, [], "…and is not counted as skipped: it is not garbage, just not ours");
  const rep = buildWalletReport(scan, { registry: REG });
  assert.equal(rep.counts.relevantTxs, 0);
  assert.deepEqual(rep.tokens, []);
});

test("scanWallet: duplicate signatures in overlapping batches — dedup, each tx fetched once", async () => {
  // an overlap of batches (b in both pages) — garbage from the endpoint; pages are cut by before
  const client = fakeScanClient({
    pages: { [OWNER]: [sig("a", 1), sig("b", 2), sig("b", 2), sig("c", 3)] },
    txs: {
      a: txOf("a", [{ owner: OWNER, mint: SPYx, _pre: 0, uiTokenAmount: { amount: "10" } }], { slot: 1 }),
      b: txOf("b", [{ owner: OWNER, mint: SPYx, _pre: 10, uiTokenAmount: { amount: "20" } }], { slot: 2 }),
      c: txOf("c", [{ owner: OWNER, mint: SPYx, _pre: 20, uiTokenAmount: { amount: "25" } }], { slot: 3 }),
    },
  });
  const scan = await scanWallet(client, OWNER, REG, { limit: 2 });
  assert.equal(scan.signatures, 3, "3 unique signatures, the duplicate b collapsed");
  assert.equal(scan.fetched, 3, "each unique tx is fetched exactly once");
  assert.deepEqual(scan.txs.map((t) => t.signature), ["a", "b", "c"]);
  assert.equal(scan.truncated, false);
});

test("scanWallet: a duplicate signature does not eat the maxTxs cap — a unique tx is taken", async () => {
  // A former GAP: the cap counted signature OCCURRENCES (taken++ before the dedup) — the duplicate b from
  // the overlapping batches wasted a slot, and the unique c from the batch served by the endpoint
  // was not taken at all. Now the cap is over UNIQUE signatures: the window is cut by
  // the history, not by the garbage of the output; truncated stays honest ("we might not have seen").
  const client = fakeScanClient({
    pages: { [OWNER]: [sig("a", 1), sig("b", 2), sig("b", 2), sig("c", 3)] },
    txs: {
      a: txOf("a", [{ owner: OWNER, mint: SPYx, _pre: 0, uiTokenAmount: { amount: "10" } }], { slot: 1 }),
      b: txOf("b", [{ owner: OWNER, mint: SPYx, _pre: 10, uiTokenAmount: { amount: "20" } }], { slot: 2 }),
      c: txOf("c", [{ owner: OWNER, mint: SPYx, _pre: 20, uiTokenAmount: { amount: "25" } }], { slot: 3 }),
    },
  });
  const scan = await scanWallet(client, OWNER, REG, { limit: 2, maxTxs: 3 });
  assert.equal(scan.signatures, 3, "all three uniques taken: the duplicate b did not eat a cap slot");
  assert.deepEqual(scan.txs.map((t) => t.signature), ["a", "b", "c"]);
  assert.equal(scan.truncated, false, "the history is read to the end — a false truncated is not set");
  assert.equal(scan.fetched, 3);
});

test("scanWallet: duplicates before the cap — the uniques are picked up, truncated is not invented", async () => {
  // a positive on the cap fix: the batch [a, a, b] at maxTxs=2 takes exactly the uniques a and b;
  // earlier the second a ate the cap — signatures=1 and an invented truncated with
  // a fully read history
  const client = fakeScanClient({
    pages: { [OWNER]: [sig("a", 1), sig("a", 1), sig("b", 2)] },
    txs: {
      a: txOf("a", [{ owner: OWNER, mint: SPYx, _pre: 0, uiTokenAmount: { amount: "10" } }], { slot: 1 }),
      b: txOf("b", [{ owner: OWNER, mint: SPYx, _pre: 10, uiTokenAmount: { amount: "20" } }], { slot: 2 }),
    },
  });
  const scan = await scanWallet(client, OWNER, REG, { limit: 3, maxTxs: 2 });
  assert.deepEqual(scan.txs.map((t) => t.signature), ["a", "b"], "the unique b got into the window after the duplicate a");
  assert.equal(scan.signatures, 2);
  assert.equal(scan.truncated, false, "there is nothing after b — the history is full, truncation would lie");
  assert.equal(scan.fetched, 2);
});

test("scanWallet: pagination by before — the cursor = the last signature of a page; a short page is probed until confirmed as the end", async () => {
  const pages = { [OWNER]: [sig("s0", 1), sig("s1", 2), sig("s2", 3), sig("s3", 4), sig("s4", 5)] };
  const txs = {};
  for (const s of ["s0", "s1", "s2", "s3", "s4"]) {
    txs[s] = txOf(s, [{ owner: OWNER, mint: SPYx, _pre: 0, uiTokenAmount: { amount: "1" } }]);
  }
  const client = fakeScanClient({ pages, txs });
  const scan = await scanWallet(client, OWNER, REG, { limit: 2, maxTxs: 10 });
  assert.equal(scan.signatures, 5, "all five signatures from all pages");
  assert.equal(scan.truncated, false);
  // the third page is short (1 < 2) — no longer the end: the fourth request confirms
  // (a repeated page = no progress/no new uniques) and only then a stop. Round28 S3:
  // after the address walk, 4 more first pages (one per derived ATA of SPYx/AAPLx × 2 programs)
  assert.deepEqual(client.sigCalls, [undefined, "s1", "s3", "s4", undefined, undefined, undefined, undefined], "the cursor — the last signature of each read page; derived sources walk after the listed ones");
});

test("scanWallet: maxTxs:0 — the window is empty but truncated:true (emptiness is not masked as completeness)", async () => {
  const client = fakeScanClient({ pages: { [OWNER]: [sig("s1", 1)] } });
  const scan = await scanWallet(client, OWNER, REG, { maxTxs: 0 });
  assert.equal(scan.signatures, 0);
  assert.equal(scan.fetched, 0);
  assert.equal(scan.truncated, true, "a cap of 0 is reached immediately: the report must know the history was not read");
});

test("scanWallet: a transfer beyond the maxTxs cap — the window is cut, complete:false is honest even with converging numbers", async () => {
  // s3 beyond the cap is not fetched at all; on chain it is a transfer of a foreign mint, so
  // the window deltas converge with the balance (reconciles) — but complete must stay false:
  // an unread tail of the history by itself makes the report incomplete.
  const client = fakeScanClient({
    pages: { [OWNER]: [sig("buy1", 1), sig("buy2", 2), sig("noise", 3)] },
    txs: {
      buy1: txOf("buy1", [{ owner: OWNER, mint: SPYx, _pre: 0, uiTokenAmount: { amount: "60" } }], { slot: 1 }),
      buy2: txOf("buy2", [{ owner: OWNER, mint: SPYx, _pre: 60, uiTokenAmount: { amount: "100" } }], { slot: 2 }),
      noise: txOf("noise", [{ owner: OWNER, mint: UNTRACKED, _pre: 0, uiTokenAmount: { amount: "5" } }], { slot: 3 }),
    },
    accountsByProgram: {
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb": { value: [
        { pubkey: "AtaEdge" + "c".repeat(36), account: { data: { parsed: { info: {
          mint: SPYx, owner: OWNER, tokenAmount: { amount: "100" },
        } } } } },
      ] },
    },
  });
  const scan = await scanWallet(client, OWNER, REG, { maxTxs: 2 });
  assert.equal(scan.signatures, 2);
  assert.equal(scan.truncated, true);
  assert.equal(client.txCalls.length, 2, "noise beyond the cap was not fetched");
  const rep = buildWalletReport(scan, { registry: REG });
  const spyx = rep.tokens.find((t) => t.symbol === "SPYx");
  assert.equal(spyx.reconciles, true, "the window deltas (60+40) converge with the chain (100)");
  assert.equal(rep.complete, false, "…but truncated by itself makes the report incomplete");
});

test("fetchOwnerTokenAccounts: garbage in the output (no info/parsed/data, a foreign mint, no amount) — the scan lives", async () => {
  const mk = (pubkey, info) => ({ pubkey, account: { data: info ? { parsed: { info } } : {} } });
  const client = fakeScanClient({
    accountsByProgram: {
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb": { value: [
        mk("GoodAcct" + "c".repeat(35), { mint: SPYx, owner: OWNER, tokenAmount: { amount: "12" } }),
        mk("NoInfo", {}), // parsed.info empty
        mk("NoParsed", null), // data without parsed
        { pubkey: "NoData", account: {} }, // no data at all
        mk("JunkAcct", { mint: UNTRACKED, owner: OWNER, tokenAmount: { amount: "99" } }), // a mint outside the registry
        mk("NoAmountAcct" + "d".repeat(31), { mint: AAPLx, owner: OWNER }), // tokenAmount missing
      ] },
    },
  });
  const accts = await fetchOwnerTokenAccounts(client, OWNER, REG);
  assert.equal(accts.size, 2);
  assert.equal(accts.get(SPYx).currentRaw, 12n);
  assert.deepEqual(accts.get(SPYx).addresses, ["GoodAcct" + "c".repeat(35)]);
  assert.equal(accts.get(AAPLx).currentRaw, 0n, "no tokenAmount → treated as 0, not a crash");
  assert.ok(accts.get(AAPLx).addresses.includes("NoAmountAcct" + "d".repeat(31)), "the address is scanned even at a zero balance");
});

test("fetchOwnerTokenAccounts: one pubkey in two programs — dedup, the balance is NOT doubled, a warn to the operator", async () => {
  // A former GAP: the dedup was only for the address list; currentRaw was summed without
  // regard to pubkey — 7+7=14, a false reconciles:false. An account belongs to exactly one
  // token program: the pubkey is deduped globally across all programs (the first occurrence
  // wins, the TOKEN_PROGRAMS order is deterministic), a conflict — a loud warn.
  const entry = { pubkey: "SameAcc" + "e".repeat(36), account: { data: { parsed: { info: {
    mint: SPYx, owner: OWNER, tokenAmount: { amount: "7" },
  } } } } };
  const client = fakeScanClient({
    accountsByProgram: {
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA": { value: [entry] },
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb": { value: [entry] },
    },
  });
  const { result: accts, lines } = await captureConsoleError(() => fetchOwnerTokenAccounts(client, OWNER, REG));
  assert.deepEqual(accts.get(SPYx).addresses, ["SameAcc" + "e".repeat(36)], "the address is one");
  assert.equal(accts.get(SPYx).currentRaw, 7n, "the sum is not doubled: the first occurrence wins");
  assert.equal(lines.length, 1, "the conflict is not quiet: exactly one warn to the operator");
  assert.match(lines[0], /SameAcc/);
  assert.match(lines[0], /\[wallet-scan\]/);
});

test("fetchOwnerTokenAccounts: different pubkeys in two programs — an honest sum without a warn", async () => {
  // a positive on the dedup fix: the legitimate case "an account in each program"
  // is still summed (7+5=12) and stays silent — the dedup does not confuse different accounts
  // with a conflict, one must not make noise on the norm
  const mk = (pubkey, amount) => ({ pubkey, account: { data: { parsed: { info: {
    mint: SPYx, owner: OWNER, tokenAmount: { amount },
  } } } } });
  const client = fakeScanClient({
    accountsByProgram: {
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA": { value: [mk("LegAcc" + "f".repeat(37), "7")] },
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb": { value: [mk("AtaAcc" + "a".repeat(37), "5")] },
    },
  });
  const { result: accts, lines } = await captureConsoleError(() => fetchOwnerTokenAccounts(client, OWNER, REG));
  assert.deepEqual(accts.get(SPYx).addresses, ["LegAcc" + "f".repeat(37), "AtaAcc" + "a".repeat(37)], "both accounts in program order");
  assert.equal(accts.get(SPYx).currentRaw, 12n, "different accounts are summed, not deduped");
  assert.equal(lines.length, 0, "a legitimate multi-program setup — not a conflict, no warn sounds");
});

test("fetchOwnerTokenAccounts: a broken token-program constant — WalletScanError invalid-program-id BEFORE the network", async () => {
  const client = fakeScanClient();
  TOKEN_PROGRAMS.push("0bad-not-base58");
  try {
    await assert.rejects(
      () => fetchOwnerTokenAccounts(client, OWNER, REG),
      (e) => e instanceof WalletScanError && e.kind === "invalid-program-id",
    );
    assert.equal(client.sigCalls.length + client.txCalls.length, 0, "not a single request: the constant is checked before the network");
  } finally {
    TOKEN_PROGRAMS.pop(); // we return the global constant — the other tests stay alive
  }
});

// ===========================================================================
// Group 2. Transaction parsing: versions, errors, decimals, mint/burn
// ===========================================================================

test("scanWallet: versioned (version:'0') and legacy — the scanner does not distinguish versions, both txs in the history", async () => {
  const client = fakeScanClient({
    pages: { [OWNER]: [sig("v0", 1), sig("legacy", 2)] },
    txs: {
      v0: txOf("v0", [{ owner: OWNER, mint: SPYx, _pre: 0, uiTokenAmount: { amount: "10" } }], { slot: 1, version: "0" }),
      legacy: txOf("legacy", [{ owner: OWNER, mint: SPYx, _pre: 10, uiTokenAmount: { amount: "15" } }], { slot: 2 }),
    },
  });
  const scan = await scanWallet(client, OWNER, REG);
  assert.deepEqual(scan.txs.map((t) => t.signature), ["v0", "legacy"]);
  assert.ok(scan.txs.every((t) => !("version" in t)), "the version field of the response is not dragged into the deltas");
  assert.ok(client.txCalls.every((p) => p[1].maxSupportedTransactionVersion === 1),
    "every getTransaction goes out with maxSupportedTransactionVersion:1 (otherwise -32015 on versioned)");
});

test("meta.err on an err:null signature: the parser computes the deltas (the ingest layer), the scanner zeroes them, the revert is not silent", async () => {
  // A former GAP: the scanner trusted err from the signature list, the meta.err of the getTransaction
  // response was ignored — a failed-tx with diverging pre/post (a broken endpoint; on a live
  // chain a revert gives pre==post) fed the FIFO a phantom delta. A layer separation:
  // fetchWalletDeltas — raw data (the deltas are always computed, err is passed through),
  // the decision "failed = does not affect the balance" is made by the scanner — and now it does.
  const deltas = new Set([SPYx]);
  const mismatch = {
    async call() {
      return { slot: 1, blockTime: 1, meta: { err: { InstructionError: [0, "Custom"] },
        preTokenBalances: [{ accountIndex: 0, owner: OWNER, mint: SPYx, uiTokenAmount: { amount: "0" } }],
        postTokenBalances: [{ accountIndex: 0, owner: OWNER, mint: SPYx, uiTokenAmount: { amount: "50" } }] } };
    },
  };
  const tx = await fetchWalletDeltas(mismatch, "sig-mismatch", deltas);
  assert.deepEqual(tx.err, { InstructionError: [0, "Custom"] }, "meta.err arrives into the err field of the result…");
  assert.equal(tx.deltas[0].deltaRaw, 50n, "…the delta is computed at the ingest layer — the scanner zeroes it, not the parser");

  // an honest revert (pre==post with meta.err) no longer falls out silently: it is a failed-tx —
  // into skipped with a reason, not into txs and not lost
  const reverted = {
    async call() {
      return { slot: 1, blockTime: 1, meta: { err: { x: 1 } },
        preTokenBalances: [{ accountIndex: 0, owner: OWNER, mint: SPYx, uiTokenAmount: { amount: "50" } }],
        postTokenBalances: [{ accountIndex: 0, owner: OWNER, mint: SPYx, uiTokenAmount: { amount: "50" } }] };
    },
  };
  const scanClient = {
    async call(method) {
      if (method === "getTokenAccountsByOwner") return { value: [] };
      if (method === "getSignaturesForAddress") return [sig("reverted", 1)];
      return reverted.call(); // getTransaction
    },
  };
  const scan = await scanWallet(scanClient, OWNER, REG);
  assert.deepEqual(scan.txs, []);
  assert.deepEqual(scan.skipped, [{ signature: "reverted", reason: "failed-tx" }]);
  assert.equal(scan.fetched, 1);
});

test("scanWallet: a failed-tx with diverging pre/post — no deltas, no phantom in the report", async () => {
  // a positive on the failed-tx fix: the signature is err:null, but the tx meta.err is not empty and
  // the balances diverged (0 → 50). Earlier such a tx got into the FIFO as a phantom purchase
  // of 50 — the window diverged from the chain (a false reconciles:false). The semantics
  // "failed = does not affect the balance": pre/post diverge, but there are no deltas.
  const client = fakeScanClient({
    pages: { [OWNER]: [sig("phantom", 1)] },
    txs: { phantom: {
      slot: 1, blockTime: 1750000000,
      meta: { err: { InstructionError: [0, "Custom"] },
        preTokenBalances: [{ owner: OWNER, mint: SPYx, uiTokenAmount: { amount: "0" } }],
        postTokenBalances: [{ owner: OWNER, mint: SPYx, uiTokenAmount: { amount: "50" } }] },
    } },
    accountsByProgram: {
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb": { value: [
        { pubkey: "AtaNoPh" + "c".repeat(36), account: { data: { parsed: { info: {
          mint: SPYx, owner: OWNER, tokenAmount: { amount: "0" },
        } } } } },
      ] },
    },
  });
  const scan = await scanWallet(client, OWNER, REG);
  assert.deepEqual(scan.txs, [], "a failed-tx with diverging pre/post does not get into the FIFO");
  assert.deepEqual(scan.skipped, [{ signature: "phantom", reason: "failed-tx" }]);
  assert.equal(scan.fetched, 1);
  const rep = buildWalletReport(scan, { registry: REG });
  const spyx = rep.tokens.find((t) => t.symbol === "SPYx");
  assert.equal(spyx.rawBalance, "0", "the window did not accumulate the phantom 50");
  assert.equal(spyx.onchainNow, "0", "the chain is empty — and the report does not contradict it");
  assert.equal(spyx.reconciles, true, "0 deltas vs 0 on chain — it converges without inventions");
  assert.equal(rep.complete, true, "the history is read to the end, everything converged");
});

test("a decimals mismatch between the tx and the registry: the raw deltas are exact (BigInt strings), the report decimals — from the registry", async () => {
  // the parser reads ONLY uiTokenAmount.amount (a string); the decimals field of the balances
  // is ignored — a mismatch with the registry does not distort the raw by a unit
  const client = {
    async call() {
      return { slot: 1, blockTime: 1750000000, meta: { err: null,
        preTokenBalances: [{ accountIndex: 0, owner: OWNER, mint: SPYx, uiTokenAmount: { amount: "0", decimals: 2 } }],
        postTokenBalances: [{ accountIndex: 0, owner: OWNER, mint: SPYx, uiTokenAmount: { amount: "123456789012345678901234", decimals: 2 } }] } };
    },
  };
  const tx = await fetchWalletDeltas(client, "sig-dec", new Set([SPYx]));
  assert.equal(tx.deltas[0].deltaRaw, 123456789012345678901234n, "24 digits: far beyond Number.MAX_SAFE_INTEGER, BigInt is exact");

  const rep = buildWalletReport(scanOf([
    { signature: "sig-dec", slot: 1, blockTime: 1750000000, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 0n, postRaw: 123456789012345678901234n, deltaRaw: 123456789012345678901234n }] },
  ]), { registry: REG });
  const spyx = rep.tokens.find((t) => t.symbol === "SPYx");
  assert.equal(spyx.rawBalance, "123456789012345678901234");
  assert.equal(spyx.decimals, 8, "the decimals in the report — from the registry, not from the tx");
  assert.equal(spyx.adjustedAvailable, false, "no timeline — adjusted is the identity fallback, honestly marked");
  assert.equal(spyx.adjusted.whole, "123456789012345678901234", "the fallback does not distort the raw");
});

test("mint-to/burn in the stream: an account created (no pre) and closed (no post) — ordinary owner deltas, the net in one tx", async () => {
  const client = {
    async call() {
      return { slot: 1, blockTime: 1750000000, meta: { err: null,
        // idx0: a burn/closure — the post record vanished, the delta −50
        preTokenBalances: [{ accountIndex: 0, owner: OWNER, mint: SPYx, uiTokenAmount: { amount: "50" } }],
        // idx1: a mint-to/creation — there was no pre record, the delta +70
        postTokenBalances: [{ accountIndex: 1, owner: OWNER, mint: SPYx, uiTokenAmount: { amount: "70" } }] } };
    },
  };
  const tx = await fetchWalletDeltas(client, "sig-mintburn", new Set([SPYx]));
  assert.equal(tx.deltas.length, 1, "both events of one owner are aggregated");
  assert.equal(tx.deltas[0].deltaRaw, 20n, "the net −50+70 = +20");

  const rep = buildWalletReport(scanOf([
    { signature: "sig-mintburn", slot: 1, blockTime: 1750000000, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 50n, postRaw: 70n, deltaRaw: 20n }] },
  ]), { registry: REG });
  const spyx = rep.tokens.find((t) => t.symbol === "SPYx");
  assert.equal(spyx.lots.length, 1, "one lot per tx: the FIFO sees the net delta, not separate transfers");
  assert.equal(spyx.lots[0].qtyRaw, "20");
});

// ===========================================================================
// Group 3. The FIFO engine of the report: intersections, overdraft, time, zeros
// ===========================================================================

test("FIFO: intersecting buys/sells — partial closures, realized by the sell dates, the tail stays", () => {
  const txs = [
    delta1("b1", 1, 100n, 1750000000),
    delta1("s1", 2, -30n, 1750003600),
    delta1("b2", 3, 40n, 1750007200),
    delta1("s2", 4, -80n, 1750010800),
  ];
  const rep = buildWalletReport(scanOf(txs, { accounts: { [SPYx]: { address: "AtE1", currentRaw: 30n } } }), { registry: REG });
  const t = rep.tokens.find((x) => x.symbol === "SPYx");
  assert.equal(t.rawBalance, "30");
  assert.equal(t.lots.length, 1, "of the two lots the second survived");
  assert.ok(t.lots[0].id.endsWith("-2"), "it is the lot of the second purchase");
  assert.equal(t.lots[0].qtyRaw, "30");
  assert.equal(t.lots[0].acquiredDate, new Date(1750007200 * 1000).toISOString());
  assert.equal(t.realizedCount, 3, "three realized records: 30@t2, 70@t4 (the tail of lot-1), 10@t4 (the head of lot-2)");
  assert.equal(t.realizedQtyRaw, "110");
  assert.deepEqual(t.gaps, []);
  assert.equal(rep.complete, true);
});

test("FIFO: an overdraft after a partial sale — a gap = the shortage, the queue is empty, no minus is invented in the lots", () => {
  const txs = [
    delta1("b1", 1, 100n),
    delta1("s1", 2, -40n),
    delta1("s2", 3, -80n),
  ];
  const rep = buildWalletReport(scanOf(txs), { registry: REG });
  const t = rep.tokens.find((x) => x.symbol === "SPYx");
  assert.equal(t.rawBalance, "-20");
  assert.deepEqual(t.lots, [], "the queue eaten entirely");
  assert.equal(t.realizedQtyRaw, "100", "realized exactly what was bought");
  assert.equal(t.gaps.length, 1);
  assert.equal(t.gaps[0].missingQtyRaw, "20", "the missing 20 — an honest hole with a date");
  assert.equal(t.gaps[0].date, new Date(300 * 1000).toISOString());
  assert.equal(rep.complete, false);
});

test("FIFO: lots of one day with different times — the queue in tx order (slot), the morning lot is sold", () => {
  const morning = 1750000000;
  const noon = morning + 3600;
  const txs = [
    delta1("buy-am", 1, 50n, morning),
    delta1("buy-pm", 2, 50n, noon),
    delta1("sell", 3, -30n, noon + 1800),
  ];
  const rep = buildWalletReport(scanOf(txs, { accounts: { [SPYx]: { address: "AtE2", currentRaw: 70n } } }), { registry: REG });
  const t = rep.tokens.find((x) => x.symbol === "SPYx");
  assert.equal(t.lots.length, 2);
  assert.equal(t.lots[0].qtyRaw, "20", "the morning lot is trimmed first (FIFO by tx order, not by the date string)");
  assert.equal(t.lots[0].acquiredDate, new Date(morning * 1000).toISOString());
  assert.equal(t.lots[1].qtyRaw, "50", "the noon one untouched");
  assert.equal(t.lots[1].acquiredDate, new Date(noon * 1000).toISOString());
  assert.equal(t.lots[0].acquiredDate.slice(0, 10), t.lots[1].acquiredDate.slice(0, 10), "both lots of one day");
});

test("a zero-qty transfer: a delta of 0 — no lot, no realization, no gap; the token does not appear in the report without an account", () => {
  const rep = buildWalletReport(scanOf([
    { signature: "zero", slot: 1, blockTime: 100, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 10n, postRaw: 10n, deltaRaw: 0n }] },
  ]), { registry: REG });
  assert.deepEqual(rep.tokens, [], "a zero delta does not birth a token row without an on-chain account");
  assert.equal(rep.counts.relevantTxs, 1, "the tx is still counted as relevant (the delta was in the scan)");
});

test("buildWalletReport: an empty scan — tokens [], zero counts, complete:true (an honest emptiness, not an error)", () => {
  const rep = buildWalletReport(scanOf([], { signatures: 0, fetched: 0 }), { registry: REG });
  assert.deepEqual(rep.tokens, []);
  assert.deepEqual(rep.counts, { signatures: 0, fetched: 0, relevantTxs: 0, skipped: 0 });
  assert.equal(rep.truncated, false);
  assert.equal(rep.complete, true, "nothing to hide and nothing to lose — the report is trivially complete");
  assert.equal(rep.method, "fifo");
});

test("buildWalletReport: accounts as a Map (the /lots-server path) — the reconcile works as with an object", () => {
  const rep = buildWalletReport(
    scanOf([delta1("a", 1, 60n)], { accounts: new Map([[SPYx, { address: "AtMap", currentRaw: 60n }]]) }),
    { registry: REG },
  );
  const spyx = rep.tokens.find((t) => t.symbol === "SPYx");
  assert.equal(spyx.onchainNow, "60");
  assert.equal(spyx.reconciles, true);
  assert.equal(rep.complete, true);
});
