import test from "node:test";
import assert from "node:assert/strict";
import { scanWallet, isValidAddress, WalletScanError } from "../src/wallet/scan.mjs";
import { buildWalletReport } from "../src/wallet/report.mjs";
import { fetchWalletDeltas, fetchTokenDeltas } from "../src/ingest/tx.mjs";
import { MultiplierTimeline } from "../src/lots/timeline.mjs";
import { multiplierHistoryToEvents } from "../src/events/normalize-xstocks.mjs";
import { loadRegistry } from "../src/registry/registry.mjs";
import { createApiServer } from "../src/api/server.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
// strictly from the base58 alphabet (without 0, O, I, l), length 44
const OWNER = "Wa11etBuyer" + "a".repeat(32);
const OTHER = "Wa11etSe11er" + "b".repeat(32);
const SPYx = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const AAPLx = "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp";

// a fake client: signatures per each source + accounts + ready transactions
function fakeClient({ sigPages = {}, txs = {}, accountsByProgram = {} } = {}) {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push({ method, key: params[0] });
      if (method === "getSignaturesForAddress") return sigPages[params[0]] ?? [];
      if (method === "getTokenAccountsByOwner") return accountsByProgram[params[1]?.programId] ?? { value: [] };
      if (method === "getTransaction") return txs[params[0]] ?? null;
      throw new Error(`unexpected method ${method}`);
    },
  };
}

const txOf = (sig, balances, { slot = 1, blockTime = 1750000000 } = {}) => ({
  slot,
  blockTime,
  meta: {
    err: null,
    preTokenBalances: balances.filter((b) => b._pre !== undefined).map((b) => ({ owner: b.owner, mint: b.mint, uiTokenAmount: { amount: String(b._pre) } })),
    postTokenBalances: balances.map((b) => ({ owner: b.owner, mint: b.mint, uiTokenAmount: { amount: String(b.uiTokenAmount.amount) } })),
  },
});

test("isValidAddress: base58 32-44 — yes, garbage — no", () => {
  assert.equal(isValidAddress(OWNER), true);
  assert.equal(isValidAddress("0bio"), false); // 0 and biological text are not base58
  assert.equal(isValidAddress(""), false);
  assert.equal(isValidAddress(null), false);
});

test("fetchWalletDeltas: a set of mints, all owners, zero deltas collapse", async () => {
  const client = fakeClient({
    txs: {
      sig1: txOf("sig1", [
        { owner: OWNER, mint: SPYx, _pre: 100, uiTokenAmount: { amount: "150" } },
        { owner: OTHER, mint: SPYx, _pre: 0, uiTokenAmount: { amount: "0" } }, // created and closed — a delta of 0
        { owner: OWNER, mint: AAPLx, _pre: 5, uiTokenAmount: { amount: "7" } },
        { owner: OWNER, mint: "NotTracked111111111111111111111111111111111", _pre: 1, uiTokenAmount: { amount: "9" } },
      ]),
    },
  });
  const tx = await fetchWalletDeltas(client, "sig1", new Set([SPYx, AAPLx]));
  assert.equal(tx.deltas.length, 2); // the foreign zero and the untracked mint dropped out
  const spyx = tx.deltas.find((d) => d.mint === SPYx);
  assert.equal(spyx.deltaRaw, 50n);
  assert.equal(tx.deltas.find((d) => d.mint === AAPLx).deltaRaw, 2n);
});

test("fetchTokenDeltas (by string) preserved the single-mint contract", async () => {
  const client = fakeClient({
    txs: { sig1: txOf("sig1", [
      { owner: OWNER, mint: SPYx, _pre: 100, uiTokenAmount: { amount: "150" } },
      { owner: OWNER, mint: AAPLx, _pre: 5, uiTokenAmount: { amount: "7" } },
    ]) },
  });
  const tx = await fetchTokenDeltas(client, "sig1", SPYx);
  assert.equal(tx.deltas.length, 1);
  assert.equal(tx.deltas[0].deltaRaw, 50n);
});

test("scanWallet: err-txs are not fetched, unavailable ones — into skipped, the order chronological", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const client = fakeClient({
    sigPages: { [OWNER]: [
      { signature: "new-ok", slot: 3, blockTime: 300, err: null },
      { signature: "mid-fail", slot: 2, blockTime: 200, err: "InstructionError" },
      { signature: "old-ok", slot: 1, blockTime: 100, err: null },
    ] },
    txs: {
      "new-ok": txOf("new-ok", [{ owner: OWNER, mint: SPYx, _pre: 10, uiTokenAmount: { amount: "20" } }], { slot: 3, blockTime: 300 }),
      "old-ok": txOf("old-ok", [{ owner: OWNER, mint: SPYx, _pre: 0, uiTokenAmount: { amount: "10" } }], { slot: 1, blockTime: 100 }),
    },
  });
  const scan = await scanWallet(client, OWNER, registry);
  assert.equal(scan.signatures, 3);
  assert.equal(scan.fetched, 2); // err was not pulled
  assert.equal(client.calls.filter((c) => c.method === "getTransaction").length, 2);
  assert.deepEqual(
    scan.txs.map((t) => t.signature),
    ["old-ok", "new-ok"], // the oldest first
  );
  assert.deepEqual(scan.skipped, [{ signature: "mid-fail", reason: "tx failed on-chain" }]);
  assert.equal(scan.truncated, false);
});

test("scanWallet: the maxTxs cap cuts the window honestly — truncated: true", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const client = fakeClient({ sigPages: { [OWNER]: [
    { signature: "s1", slot: 1, blockTime: 1, err: null },
    { signature: "s2", slot: 2, blockTime: 2, err: null },
    { signature: "s3", slot: 3, blockTime: 3, err: null },
  ] } });
  const scan = await scanWallet(client, OWNER, registry, { maxTxs: 2 });
  assert.equal(scan.signatures, 2);
  assert.equal(scan.truncated, true);
});

test("scanWallet: a source that hit the cap does not cut the pages of the other sources", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const ATA = "AtaSPYx" + "c".repeat(36);
  const sig = (s, slot) => ({ signature: s, slot, blockTime: slot, err: null });
  const PAGES = {
    [OWNER]: [sig("a1", 1), sig("a2", 2), sig("a3", 3), sig("a4", 4), sig("a5", 5)], // 5 at maxTxs=3 → truncated
    [ATA]: [sig("t1", 11), sig("t2", 12), sig("t3", 13)], // 3 = fits its own cap entirely
  };
  // a fake with real before-pagination (the common fakeClient serves one page always)
  const client = {
    async call(method, params) {
      if (method === "getTokenAccountsByOwner") {
        return { value: [
          { pubkey: ATA, account: { data: { parsed: { info: { mint: SPYx, owner: OWNER, tokenAmount: { amount: "160" } } } } } },
        ] };
      }
      if (method === "getSignaturesForAddress") {
        const all = PAGES[params[0]] ?? [];
        const before = params[1]?.before;
        const start = before ? all.findIndex((x) => x.signature === before) + 1 : 0;
        return all.slice(start, start + params[1].limit);
      }
      return null; // getTransaction
    },
  };
  // limit=1: the ATA has three pages — the regression caught a break after the first (there would be 4 signatures, not 6)
  const scan = await scanWallet(client, OWNER, registry, { maxTxs: 3, limit: 1 });
  assert.equal(scan.signatures, 6, "a1-a3 from the wallet + all 3 from the ATA");
  assert.equal(scan.truncated, true, "the cap reached, but by only one source");
});

test("scanWallet: a garbage address — an error, not a scan", async () => {
  const registry = await loadRegistry("data/tokens.json");
  await assert.rejects(
    scanWallet(fakeClient(), "not-a-pubkey", registry),
    (e) => e instanceof WalletScanError && e.kind === "invalid-address",
  );
});

// --- scanner v2: ATA sources and the reconcile ---

test("scanWallet v2: an incoming transfer through a token account (the owner is NOT the signer) — caught", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const ATA = "AtaSPYx" + "c".repeat(36); // base58, 42 chars
  const client = fakeClient({
    sigPages: {
      [OWNER]: [{ signature: "self-buy", slot: 2, blockTime: 200, err: null }],
      [ATA]: [
        { signature: "incoming-recv", slot: 1, blockTime: 100, err: null }, // the sender paid the fee
        { signature: "self-buy", slot: 2, blockTime: 200, err: null }, // a duplicate across sources
      ],
    },
    accountsByProgram: {
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb": { value: [
        { pubkey: ATA, account: { data: { parsed: { info: {
          mint: SPYx, owner: OWNER, tokenAmount: { amount: "160" },
        } } } } },
      ] },
    },
    txs: {
      "self-buy": txOf("self-buy", [{ owner: OWNER, mint: SPYx, _pre: 0, uiTokenAmount: { amount: "100" } }], { slot: 2, blockTime: 200 }),
      "incoming-recv": txOf("incoming-recv", [{ owner: OWNER, mint: SPYx, _pre: 0, uiTokenAmount: { amount: "60" } }], { slot: 1, blockTime: 100 }),
    },
  });
  const scan = await scanWallet(client, OWNER, registry);
  assert.equal(scan.signatures, 2); // dedup: self-buy under two sources — one
  assert.deepEqual(scan.txs.map((t) => t.signature), ["incoming-recv", "self-buy"]);
  assert.deepEqual(scan.accounts.get(SPYx).addresses, [ATA]);
  assert.equal(scan.accounts.get(SPYx).currentRaw, 160n);
});

test("fetchOwnerTokenAccounts: both token programs, only registry mints", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const mk = (pubkey, mint, amt) => ({ pubkey, account: { data: { parsed: { info: {
    mint, owner: OWNER, tokenAmount: { amount: amt },
  } } } } });
  const client = fakeClient({
    accountsByProgram: {
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA": { value: [
        mk("AtaAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", SPYx, "7"), // xStocks lives in Token-2022, here for the test — both programs
        mk("AtaJjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjj", "Junk111111111111111111111111111111111111", "9"), // not our mint
      ] },
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb": { value: [ mk("AtaBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", AAPLx, "5") ] },
    },
  });
  const accts = await (await import("../src/wallet/scan.mjs")).fetchOwnerTokenAccounts(client, OWNER, registry);
  assert.equal(accts.size, 2);
  assert.equal(accts.get(SPYx).currentRaw, 7n);
  assert.deepEqual(accts.get(AAPLx).addresses, ["AtaBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]);
});

test("buildWalletReport: the token exists on chain, no deltas — visible with reconciles: false, not hidden", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const rep = buildWalletReport(scanOf([], { accounts: { [SPYx]: { address: "At5", currentRaw: 500n } } }), { registry });
  const spyx = rep.tokens.find((t) => t.symbol === "SPYx");
  assert.ok(spyx, "the token shown, not lost");
  assert.equal(spyx.rawBalance, "0");
  assert.equal(spyx.onchainNow, "500");
  assert.equal(spyx.reconciles, false);
  assert.equal(rep.complete, false);
});

test("buildWalletReport: the deltas do not converge with the chain — reconciles: false, complete: false", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const txs = [
    { signature: "a", slot: 1, blockTime: 100, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 0n, postRaw: 60n, deltaRaw: 60n }] },
  ];
  const rep = buildWalletReport(scanOf(txs, { accounts: { [SPYx]: { address: "At6", currentRaw: 70n } } }), { registry });
  const spyx = rep.tokens.find((t) => t.symbol === "SPYx");
  assert.equal(spyx.rawBalance, "60");
  assert.equal(spyx.onchainNow, "70");
  assert.equal(spyx.reconciles, false); // 10 base units of history outside the scan window
  assert.equal(rep.complete, false);
});

// --- a clean report ---

const scanOf = (txs, extra = {}) => ({
  owner: OWNER, signatures: txs.length, fetched: txs.length, txs, skipped: [], truncated: false, accounts: {}, ...extra,
});

test("buildWalletReport: FIFO — a buy, a partial cover, a second lot, the remainder", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const txs = [
    { signature: "a", slot: 1, blockTime: 100, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 0n, postRaw: 100n, deltaRaw: 100n }] },
    { signature: "b", slot: 2, blockTime: 200, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 100n, postRaw: 130n, deltaRaw: 30n }] },
    { signature: "c", slot: 3, blockTime: 300, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 130n, postRaw: 60n, deltaRaw: -70n }] },
  ];
  const rep = buildWalletReport(scanOf(txs, { accounts: { [SPYx]: { address: "At1", currentRaw: 60n } } }), { registry });
  assert.equal(rep.owner, OWNER);
  assert.equal(rep.method, "fifo");
  assert.equal(rep.complete, true);
  const spyx = rep.tokens.find((t) => t.symbol === "SPYx");
  assert.equal(spyx.rawBalance, "60");
  assert.equal(spyx.onchainNow, "60");
  assert.equal(spyx.reconciles, true); // the deltas converge with the live balance
  assert.equal(spyx.lots.length, 2); // the FIFO ate 70 from the lot-100: remainders 30 + 30
  assert.equal(spyx.lots[0].qtyRaw, "30");
  assert.equal(spyx.lots[0].acquiredDate, new Date(100 * 1000).toISOString());
  assert.equal(spyx.lots[1].qtyRaw, "30");
  assert.equal(spyx.lots[1].acquiredDate, new Date(200 * 1000).toISOString());
  assert.equal(spyx.realizedCount, 1); // one sale was covered by the first lot entirely
  assert.equal(spyx.realizedQtyRaw, "70");
});

test("buildWalletReport: an outflow before a buy (the scan window is late) — a gap, complete: false, the balance honest", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const txs = [
    { signature: "sell-first", slot: 1, blockTime: 100, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 500n, postRaw: 200n, deltaRaw: -300n }] },
    { signature: "buy-later", slot: 2, blockTime: 200, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 200n, postRaw: 260n, deltaRaw: 60n }] },
  ];
  const rep = buildWalletReport(scanOf(txs), { registry });
  const spyx = rep.tokens.find((t) => t.symbol === "SPYx");
  assert.equal(spyx.rawBalance, "-240"); // -300+60: the window balance negative — that is what we show
  assert.equal(spyx.gaps.length, 1);
  assert.equal(spyx.gaps[0].missingQtyRaw, "300");
  assert.equal(rep.complete, false);
  assert.equal(spyx.reconciles, false); // the window balance -240 does not converge with the empty wallet
});

test("buildWalletReport: foreign deltas and irrelevant mints are ignored; adjusted with dust via the timeline", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const nodes = JSON.parse(readFileSync(path.join(dir, "xstocks-spyx-history-eth.json"), "utf8")).nodes;
  const evts = multiplierHistoryToEvents(nodes, { symbol: "SPYx" }).map((e) => ({ ...e, mint: SPYx }));
  const timelines = new Map([[SPYx, new MultiplierTimeline(evts)]]);
  const txs = [
    { signature: "a", slot: 1, blockTime: 1000, deltas: [
      { owner: OWNER, mint: SPYx, preRaw: 0n, postRaw: 100000000n, deltaRaw: 100000000n },
      { owner: OTHER, mint: SPYx, preRaw: 0n, postRaw: 999n, deltaRaw: 999n }, // foreign
    ] },
  ];
  const rep = buildWalletReport(scanOf(txs, { accounts: { [SPYx]: { address: "At2", currentRaw: 100000000n } } }), { registry, timelines });
  const spyx = rep.tokens.find((t) => t.symbol === "SPYx");
  assert.equal(spyx.rawBalance, "100000000"); // the owner only
  assert.equal(spyx.multiplier.now, "1.005714560286254");
  assert.equal(spyx.multiplier.events, 4);
  assert.equal(spyx.adjusted.whole, "100571456"); // 1.0 × 1.0057…
  assert.equal(spyx.adjusted.exact, false); // the dust shown
  assert.ok(Number(spyx.adjusted.remainder) > 0);
});

test("buildWalletReport: a token without events — multiplier 1, adjusted exact", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const txs = [
    { signature: "a", slot: 1, blockTime: 1000, deltas: [{ owner: OWNER, mint: AAPLx, preRaw: 0n, postRaw: 42n, deltaRaw: 42n }] },
  ];
  const rep = buildWalletReport(scanOf(txs, { accounts: { [AAPLx]: { address: "At3", currentRaw: 42n } } }), { registry });
  const a = rep.tokens.find((t) => t.symbol === "AAPLx");
  assert.equal(a.multiplier.now, "1");
  assert.equal(a.multiplier.events, 0);
  assert.deepEqual(a.adjusted, { exact: true, whole: "42", remainder: "0", den: "1" });
  assert.equal(rep.complete, true);
});

// --- the /lots route ---

async function withServer(walletScanner, fn) {
  const registry = await loadRegistry("data/tokens.json");
  const server = await createApiServer({ registry, events: [], walletScanner });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("/lots: no address and a garbage address — 400, no scanner — 503", async () => {
  await withServer(null, async (base) => {
    assert.equal((await fetch(`${base}/lots`)).status, 400);
    const bad = await fetch(`${base}/lots?address=abc`);
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /base58/);
    const noscanner = await fetch(`${base}/lots?address=${OWNER}`);
    assert.equal(noscanner.status, 503);
  });
});

test("/lots: a report from the scanner — FIFO and counts in place", async () => {
  const fakeScan = {
    owner: OWNER, signatures: 2, fetched: 2, skipped: [], truncated: false,
    accounts: new Map([[SPYx, { address: "At4", currentRaw: 4n }]]),
    txs: [
      { signature: "a", slot: 1, blockTime: 100, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 0n, postRaw: 10n, deltaRaw: 10n }] },
      { signature: "b", slot: 2, blockTime: 200, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 10n, postRaw: 4n, deltaRaw: -6n }] },
    ],
  };
  await withServer(async (addr) => fakeScan, async (base) => {
    const rep = await (await fetch(`${base}/lots?address=${OWNER}`)).json();
    assert.equal(rep.owner, OWNER);
    assert.equal(rep.counts.relevantTxs, 2);
    const spyx = rep.tokens.find((t) => t.symbol === "SPYx");
    assert.equal(spyx.rawBalance, "4");
    assert.equal(spyx.lots[0].qtyRaw, "4");
    assert.equal(spyx.multiplier.now, "1"); // a server without events — plan 1, honestly
  });
});

test("/lots: the scanner threw an RpcError-like — a 503 with kind", async () => {
  const err = new Error("HTTP 429");
  err.kind = "rate-limit";
  await withServer(async () => { throw err; }, async (base) => {
    const res = await fetch(`${base}/lots?address=${OWNER}`);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).kind, "rate-limit");
  });
});

// ----: the multi-account nature of one mint ----

test("two accounts of one mint (ATA + legacy): a scan of both, the balance = the sum, the report converges", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const ATA = "AtaSPYx" + "c".repeat(36);
  const LEG = "LegSPYx" + "d".repeat(36);
  const mk = (pubkey, amount) => ({ pubkey, account: { data: { parsed: { info: {
    mint: SPYx, owner: OWNER, tokenAmount: { amount },
  } } } } });
  const client = fakeClient({
    sigPages: {
      [OWNER]: [],
      [ATA]: [{ signature: "ata-buy", slot: 2, blockTime: 200, err: null }],
      [LEG]: [{ signature: "leg-buy", slot: 1, blockTime: 100, err: null }],
    },
    accountsByProgram: {
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb": { value: [mk(ATA, "100"), mk(LEG, "60")] },
    },
    txs: {
      "ata-buy": txOf("ata-buy", [{ owner: OWNER, mint: SPYx, _pre: 0, uiTokenAmount: { amount: "100" } }], { slot: 2, blockTime: 200 }),
      "leg-buy": txOf("leg-buy", [{ owner: OWNER, mint: SPYx, _pre: 0, uiTokenAmount: { amount: "60" } }], { slot: 1, blockTime: 100 }),
    },
  });
  // before the fix: different balances = throw ambiguous-accounts (a refusal to an honest wallet),
  // equal ones = a silent overwrite and a loss of the history of one of the accounts
  const scan = await scanWallet(client, OWNER, registry);
  assert.deepEqual([...scan.accounts.get(SPYx).addresses].sort(), [ATA, LEG].sort());
  assert.equal(scan.accounts.get(SPYx).currentRaw, 160n);
  const rep = buildWalletReport(scan, { registry });
  const spyx = rep.tokens.find((t) => t.symbol === "SPYx");
  assert.equal(spyx.rawBalance, "160");
  assert.equal(spyx.reconciles, true);
});

test("the chronology by slot: blockTime=null does not break the FIFO order", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const client = fakeClient({
    sigPages: {
      [OWNER]: [
        { signature: "late-null-bt", slot: 30, blockTime: null, err: null },
        { signature: "early", slot: 2, blockTime: 1750000000, err: null },
      ],
    },
    txs: {
      "early": txOf("early", [{ owner: OWNER, mint: SPYx, _pre: 0, uiTokenAmount: { amount: "10" } }], { slot: 2, blockTime: 1750000000 }),
      "late-null-bt": txOf("late-null-bt", [{ owner: OWNER, mint: SPYx, _pre: 10, uiTokenAmount: { amount: "20" } }], { slot: 30, blockTime: null }),
    },
  });
  // before the fix the comparator mixed seconds and slots: a null-blockTime drifted into the "ancient"
  const scan = await scanWallet(client, OWNER, registry);
  assert.deepEqual(scan.txs.map((t) => t.signature), ["early", "late-null-bt"]);
});

// ----: invariants and holes of the test coverage ----

test("scanWallet: getTransaction returned null — the tx into skipped with an honest reason, fetched counted", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const client = fakeClient({
    sigPages: { [OWNER]: [
      { signature: "ok", slot: 1, blockTime: 100, err: null },
      { signature: "gone", slot: 2, blockTime: 200, err: null }, // err:null, but the tx unavailable at the endpoint
    ] },
    txs: {
      "ok": txOf("ok", [{ owner: OWNER, mint: SPYx, _pre: 0, uiTokenAmount: { amount: "10" } }], { slot: 1, blockTime: 100 }),
      // "gone" is not in txs — fakeClient will return null (the public RPC behavior on a retro shard)
    },
  });
  // we pin the CURRENT scanner behavior: an unavailable tx is not silently lost
  const scan = await scanWallet(client, OWNER, registry);
  assert.deepEqual(scan.skipped, [{ signature: "gone", reason: "tx unavailable on endpoint" }]);
  assert.equal(scan.fetched, 2, "the fetch attempt is counted — the work is visible");
  assert.deepEqual(scan.txs.map((t) => t.signature), ["ok"], "only the available one got into the history");
  assert.equal(scan.signatures, 2);
});

test("buildWalletReport: blockTime null — a lot with acquiredDate: null arrives into JSON (the serialization does not break)", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const txs = [
    { signature: "a", slot: 1, blockTime: null, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 0n, postRaw: 10n, deltaRaw: 10n }] },
  ];
  const rep = buildWalletReport(scanOf(txs, { accounts: { [SPYx]: { address: "At7", currentRaw: 10n } } }), { registry });
  const spyx = rep.tokens.find((t) => t.symbol === "SPYx");
  assert.equal(spyx.lots.length, 1);
  assert.equal(spyx.lots[0].acquiredDate, null); // iso() gives null — not an invented date
  const wire = JSON.parse(JSON.stringify(rep)); // the same path as /lots -> res.end
  assert.equal(wire.tokens[0].lots[0].acquiredDate, null);
});

test("buildWalletReport: the lot ids are unique for mints with a common 6-char prefix", () => {
  const A = "Abcdef" + "1".repeat(38); // base58, the common prefix "Abcdef" — the old scheme
  const B = "Abcdef" + "2".repeat(38); // it gave both the id "Abcdef-1"
  const registry = [
    { mint: A, symbol: "PRA", name: "Prefix A", decimals: 8 },
    { mint: B, symbol: "PRB", name: "Prefix B", decimals: 8 },
  ];
  const txs = [
    { signature: "a", slot: 1, blockTime: 100, deltas: [{ owner: OWNER, mint: A, preRaw: 0n, postRaw: 10n, deltaRaw: 10n }] },
    { signature: "b", slot: 2, blockTime: 200, deltas: [{ owner: OWNER, mint: B, preRaw: 0n, postRaw: 20n, deltaRaw: 20n }] },
  ];
  const rep = buildWalletReport(scanOf(txs), { registry });
  const ids = rep.tokens.flatMap((t) => t.lots.map((l) => l.id));
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2, "the lot ids differ");
  assert.ok(ids.every((id) => id.endsWith("-1")), "the seq preserved in the id");
});

test("the FIFO balance identities (the fuzzer's invariants) on 4 scenarios", () => {
  const registry = [
    { mint: SPYx, symbol: "SPYx", name: "S&P 500 xStock", decimals: 8 },
  ];
  const d = (sig, slot, deltaRaw) => ({
    signature: sig, slot, blockTime: slot * 100,
    deltas: [{ owner: OWNER, mint: SPYx, preRaw: 0n, postRaw: 0n, deltaRaw }],
  });
  const scenarios = [
    { name: "a buy, a buy, a partial sell", txs: [d("a", 1, 100n), d("b", 2, 30n), d("c", 3, -70n)],
      truncated: false, accounts: { [SPYx]: { address: "At8", currentRaw: 60n } } },
    { name: "a sell before a buy (a gap)", txs: [d("a", 1, -300n), d("b", 2, 60n)],
      truncated: false, accounts: {} },
    { name: "an overdraft eats the queue and gives a gap", txs: [d("a", 1, 100n), d("b", 2, -40n), d("c", 3, -80n)],
      truncated: false, accounts: {} },
    { name: "a clean hold with a truncated window", txs: [d("a", 1, 42n)],
      truncated: true, accounts: { [SPYx]: { address: "At9", currentRaw: 42n } } },
  ];
  for (const sc of scenarios) {
    const rep = buildWalletReport(scanOf(sc.txs, { truncated: sc.truncated, accounts: sc.accounts }), { registry });
    const t = rep.tokens.find((x) => x.symbol === "SPYx");
    const sum = (arr, key) => arr.reduce((acc, x) => acc + BigInt(x[key]), 0n);
    const side = (sign) => sc.txs.reduce((a, x) => {
      const v = x.deltas[0].deltaRaw;
      return a + (sign > 0 ? (v > 0n ? v : 0n) : (v < 0n ? -v : 0n));
    }, 0n);
    const buys = side(1);
    const sells = side(-1);
    const deltas = sc.txs.reduce((a, x) => a + x.deltas[0].deltaRaw, 0n);
    const queueSum = sum(t.lots, "qtyRaw");
    const realizedSum = BigInt(t.realizedQtyRaw);
    const gapsSum = sum(t.gaps, "missingQtyRaw");
    assert.equal(BigInt(t.rawBalance), deltas, `${sc.name}: rawBalance = the sum of deltas`);
    assert.equal(queueSum + realizedSum, buys, `${sc.name}: the queue + the realization = the buys`);
    assert.equal(realizedSum + gapsSum, sells, `${sc.name}: the realization + the gaps = the sells`);
    const allReconcile = rep.tokens.every((x) => x.reconciles);
    const hasGaps = rep.tokens.some((x) => x.gaps.length > 0);
    assert.equal(rep.complete, !sc.truncated && !hasGaps && allReconcile, `${sc.name}: complete is honest`);
  }
});
