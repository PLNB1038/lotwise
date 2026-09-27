// Honesty guards collected from the wave-38 audit: a stuck pagination page is a
// truncated window, not a complete history; skipped txs make an ex-date base a
// guess; a list-style wildcard used to subscribe to nothing; a wrong
// symbolToMint shape used to disable the registry resolve silently; ticker
// symbols and the reason line were the uncapped echo holes; the dividend
// dedup survivor's metadata depended on feed order; a realized piece hid the
// lot's acquisition date a tax consumer needs; foreign declarations vanished.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanWallet } from "../src/wallet/scan.mjs";
import { buildWalletReport } from "../src/wallet/report.mjs";
import { applyEvents } from "../src/lots/lots.mjs";
import { validateEvent } from "../src/schema/events.mjs";
import { validateSubscription, matchSubscriptions, deliverToAll } from "../src/webhooks/subscriptions.mjs";
import { loadDeclarationsFile } from "../src/events/declarations-file.mjs";
import { createApiServer } from "../src/api/server.mjs";
import { bindMintAndValidate } from "../src/events/normalize-xstocks.mjs";

const OWNER = "Ho5371Kc1Kxy7ze85UYzZ4BUfSkLg39Xp3B424RuYrbC"; // real-shaped: decodes to 32 bytes
const REGISTRY = [{ mint: "XsMAqkcKsUewDrzVkait4e5u4y8REgtyS7jWgCpLV2C", symbol: "GRDx", name: "Guard Token", decimals: 6, issuer: "test" }];
const MINT = REGISTRY[0].mint;

// ---- 1) a stuck page terminates the walk AND marks the window truncated ----
function stuckClient() {
  let calls = 0;
  const page = [
    { signature: "StuckSig" + "1".repeat(30), slot: 1, blockTime: 1_700_000_000, err: null },
    { signature: "StuckSig" + "2".repeat(30), slot: 1, blockTime: 1_700_000_000, err: null },
  ];
  return {
    async call(method) {
      if (method === "getTokenAccountsByOwner") return { value: [] };
      if (method === "getTransaction") return null;
      calls++;
      return calls >= 10 ? [] : page; // terminates for any code, stuck until then
    },
  };
}

test("scan: a stuck endpoint breaks with truncated:true — the tail is unknown, not absent", async () => {
  const scan = await scanWallet(stuckClient(), OWNER, REGISTRY, { limit: 2, maxTxs: 100 });
  assert.equal(scan.signatures, 2);
  assert.equal(scan.truncated, true, "the guard terminated the walk — the window has a hole and must say so");
}, { timeout: 5000 });

// ---- 2) skipped txs flip baseIncomplete in /accruals ----
const A_MINT = "XsMAqkcKsUewDrzVkait4e5u4y8REgtyS7jWgCpLV2C";
const A_ADDR = "ExDateAddr" + "1".repeat(34);
const A_SYMBOL = "GACx";
const aRegistry = [{ mint: A_MINT, symbol: A_SYMBOL, name: "Accrual Guard", decimals: 6, issuer: "test" }];

const divEvent = (effectiveDate, amountPerUnitRaw) =>
  bindMintAndValidate([{
    type: "DIVIDEND_ACCRUAL", effectiveDate, status: "confirmed",
    sources: ["https://issuer.example/g"], amountPerUnitRaw, decimals: 6,
  }], A_MINT)[0];

const aTx = (signature, deltaRaw, isoDate, slot = 1) => ({
  signature, slot,
  blockTime: isoDate === null ? null : Math.floor(Date.parse(isoDate) / 1000),
  deltas: [{ owner: A_ADDR, mint: A_MINT, preRaw: 0n, postRaw: 0n, deltaRaw }],
});
const aScan = (txs, skipped = []) => ({
  owner: A_ADDR, signatures: txs.length + skipped.length, fetched: txs.length, txs, skipped, truncated: false,
  accounts: { [A_MINT]: { currentRaw: "5" } }, // buy 10 − sell 5: reconciles, no gaps — the flag is pinned to skipped alone
});

async function withAccruals(fn, { events, txs, skipped }) {
  const server = await createApiServer({
    registry: aRegistry, events,
    walletScanner: async () => aScan(txs, skipped),
  });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("accruals: an unreadable (skipped) tx makes the ex-date base incomplete, not a confident zero", async () => {
  await withAccruals(async (base) => {
    const r = await fetch(`${base}/accruals?symbol=${A_SYMBOL}&address=${A_ADDR}`);
    assert.equal(r.status, 200);
    const [row] = await r.json();
    assert.ok(row.baseIncomplete === true, "the pre-ex-date buy is inside a skipped tx — the base is a guess");
  }, {
    events: [divEvent("2026-02-01", 2)],
    // a seamless window (buy 10 pre-ex, sell 5 post-ex): no gaps, reconciles — the ONLY
    // incomplete trigger left is the skipped pre-ex-date buy
    txs: [aTx("b1", 10n, "2026-01-05"), aTx("s-late", -5n, "2026-02-20")],
    skipped: [{ signature: "sk1", reason: "tx unreadable" }],
  });
});

// ---- 3) ["*"] is the wildcard written list-style ----
test("subscriptions: symbols [\"*\"] normalizes to the wildcard and matches everything", () => {
  const sub = { id: "sub-1", url: "https://example.dev/hook", symbols: ["*"], secret: "s".repeat(32), createdAt: new Date().toISOString(), active: true };
  validateSubscription(sub);
  assert.equal(sub.symbols, "*");
  assert.equal(matchSubscriptions([sub], { symbol: "SPYx", mint: MINT }).length, 1);
});

// ---- 4) a wrong symbolToMint shape refuses loudly ----
test("deliverToAll: a non-Map symbolToMint throws instead of silently disabling the resolve", async () => {
  const [event] = bindMintAndValidate([{
    type: "MULTIPLIER_CHANGE", effectiveDate: "2026-01-01", status: "confirmed",
    sources: ["https://i.example/m"], multiplierFrom: "1", multiplierTo: "2",
  }], MINT);
  await assert.rejects(
    () => deliverToAll([event], [], { symbolToMint: { SPYx: MINT } }),
    /symbolToMint must be a Map/,
  );
});

// ---- 5) echo caps: ticker symbols and the reason line ----
test("schema: a ticker symbol over 64 chars and a reason over 2048 chars are rejected", () => {
  const long = "X".repeat(65);
  assert.throws(() => validateEvent({
    type: "TICKER_CHANGE", effectiveDate: "2026-01-01", status: "confirmed", mint: MINT,
    sources: ["https://i.example/t"], oldSymbol: long, newSymbol: "NEWx",
  }), /exceeds 64 characters/);
  assert.throws(() => validateEvent({
    type: "MULTIPLIER_CHANGE", effectiveDate: "2026-01-01", status: "confirmed", mint: MINT,
    sources: ["https://i.example/m"], multiplierFrom: "1", multiplierTo: "2",
    reason: "r".repeat(2049),
  }), /reason exceeds 2048/);
});

// ---- 6) the dividend dedup survivor is order-independent ----
const divSighting = (decimals, url) => ({
  type: "DIVIDEND_ACCRUAL", effectiveDate: "2026-02-01", status: "confirmed",
  sources: [url], amountPerUnitRaw: 2, decimals, mint: MINT,
});

test("engine: same dividend identity from two feeds — the surviving metadata does not depend on feed order", () => {
  const lot = () => [{ id: `${MINT}-1`, mint: MINT, owner: OWNER, qtyRaw: 10n, acquiredDate: "2026-01-01", basisRaw: 0n }];
  const a = divSighting(18, "https://a.example/d");
  const b = divSighting(6, "https://b.example/d");
  const forward = applyEvents(lot(), [a, b]);
  const backward = applyEvents(lot(), [b, a]);
  assert.equal(forward.accruals.length, 1);
  assert.equal(backward.accruals.length, 1);
  assert.deepEqual(forward.accruals[0], backward.accruals[0], "any permutation yields the same accrual, metadata included");
});

// ---- 7) a realized piece carries the lot's acquisition date ----
test("report: realized pieces expose acquiredDate next to the sale date", () => {
  const gTx = (signature, deltaRaw, isoDate, slot) => ({
    signature, slot, err: null, moneyDeltas: [],
    blockTime: Math.floor(Date.parse(isoDate) / 1000),
    deltas: [{ owner: OWNER, mint: MINT, preRaw: 0n, postRaw: deltaRaw > 0n ? deltaRaw : 0n, deltaRaw }],
  });
  const scan = {
    owner: OWNER, signatures: 2, fetched: 2, skipped: [], truncated: false,
    accounts: {},
    txs: [
      gTx("gb1", 10n, "2025-06-01", 1),
      gTx("gs1", -10n, "2026-06-01", 2),
    ],
  };
  const rep = buildWalletReport(scan, { registry: REGISTRY, timelines: new Map() });
  const tok = rep.tokens.find((t) => t.mint === MINT);
  assert.equal(tok.realized.length, 1);
  assert.equal(tok.realized[0].acquiredDate, "2025-06-01T00:00:00.000Z");
  assert.equal(tok.realized[0].date, "2026-06-01T00:00:00.000Z");
});

// ---- 8) /health exposes the scan slot ----
test("health: scans.active is present and false when idle", async () => {
  const server = await createApiServer({ registry: aRegistry, events: [], walletScanner: async () => aScan([]) });
  const { port } = server.address();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`);
    const h = await r.json();
    assert.equal(h.scans.active, false);
  } finally {
    server.close();
  }
});

// ---- 9) foreign declarations warn instead of vanishing ----
test("declarations: a symbol outside the registry is skipped with a loud warn", () => {
  const dir = mkdtempSync(join(tmpdir(), "lw-guard-"));
  const file = join(dir, "declarations.json");
  writeFileSync(file, JSON.stringify([
    { symbol: "NOSUCH", exDate: "2026-02-01", amountPerUnitRaw: 2, decimals: 6, sourceUrl: "https://i.example/nosuch" },
  ]));
  const warned = [];
  const origWarn = console.warn;
  console.warn = (msg) => warned.push(String(msg));
  try {
    const res = loadDeclarationsFile(file, REGISTRY);
    assert.equal(res.ok, true);
    assert.equal(res.loaded, 0);
    assert.ok(warned.some((w) => w.includes("NOSUCH")), "the drift is named, not swallowed");
  } finally {
    console.warn = origWarn;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- wave-39 hardening: the stuck family and the echo caps ----
function routeClient(routeOf) {
  let calls = 0;
  return {
    calls: () => calls,
    client: {
      async call(method, params) {
        if (method === "getTokenAccountsByOwner") return { value: [] };
        if (method === "getTransaction") return null;
        calls++;
        if (calls > 60) return [];
        return routeOf(params[1]?.before);
      },
    },
  };
}
const sg = (n) => ({ signature: "W39sig" + String(n).padStart(2, "0") + "x".repeat(30), slot: n, blockTime: 1_700_000_000 + n, err: null });

test("scan: a stuck mirror followed by an empty page still flags truncated — the source already lied once", async () => {
  let mirrored = false;
  const { client } = routeClient((before) => {
    if (before === undefined) return [sg(1), sg(2)];
    if (before === sg(2).signature && !mirrored) { mirrored = true; return [sg(1), sg(2)]; } // ONE mirror, then honesty
    return [];
  });
  const scan = await scanWallet(client, OWNER, REGISTRY, { limit: 2, maxTxs: 100 });
  assert.ok(mirrored, "the mock must actually exercise the mirror branch");
  assert.equal(scan.truncated, true, "an empty page after a mirror does not launder it");
}, { timeout: 5000 });

test("scan: an ALTERNATING reshuffler (cursor ping-pongs between two pages) is caught by the rewind", async () => {
  const { client } = routeClient((before) => {
    if (before === undefined) return [sg(1), sg(2)];
    if (before === sg(2).signature) return [sg(2), sg(1)]; // cursor -> sg1
    return [sg(1), sg(2)]; // and back -> sg2: ground already queried
  });
  const scan = await scanWallet(client, OWNER, REGISTRY, { limit: 2, maxTxs: 100 });
  assert.equal(scan.truncated, true, "the ping-pong must flag the window, not drain silently");
}, { timeout: 5000 });

test("scan: a page that REWINDS the cursor onto queried ground is a lie — truncated", async () => {
  // the reshuffler answers [sg2, sg1] for every cursor: page 2 moves the cursor to sg1
  // (fresh), page 3 rewinds it back to sg2 — already queried from. The walk terminates
  // and the window must be flagged, not certified complete over unverifiable tail
  const { client } = routeClient((before) => (before === undefined ? [sg(1), sg(2)] : [sg(2), sg(1)]));
  const scan = await scanWallet(client, OWNER, REGISTRY, { limit: 2, maxTxs: 100 });
  assert.equal(scan.truncated, true, "rewinding onto queried ground must flag the window");
}, { timeout: 5000 });

test("scan: two fully unparseable pages flag truncated — the tail is unknown", async () => {
  const { client } = routeClient(() => [{ slot: 1 }, null, { garbage: true }]);
  const scan = await scanWallet(client, OWNER, REGISTRY, { limit: 2, maxTxs: 100 });
  assert.equal(scan.truncated, true);
}, { timeout: 5000 });

test("accruals: a FAILED tx in skipped does not flag the base — it has no deltas by definition", async () => {
  await withAccruals(async (base) => {
    const r = await fetch(`${base}/accruals?symbol=${A_SYMBOL}&address=${A_ADDR}`);
    const [row] = await r.json();
    assert.equal(row.baseIncomplete, undefined, "an on-chain failed tx cannot change the ex-date base");
  }, {
    events: [divEvent("2026-02-01", 2)],
    txs: [aTx("b1", 10n, "2026-01-05"), aTx("s-late", -5n, "2026-02-20")],
    skipped: [
      { signature: "f1", reason: "tx failed on-chain" },
      { signature: "f2", reason: "failed-tx" },
    ],
  });
});

test("accruals: an UNREADABLE tx whose error text contains \"fail\" still flags — no substring sniffing", async () => {
  await withAccruals(async (base) => {
    const r = await fetch(`${base}/accruals?symbol=${A_SYMBOL}&address=${A_ADDR}`);
    const [row] = await r.json();
    assert.equal(row.baseIncomplete, true, "undici's canonical \"fetch failed\" text must not exempt an unreadable tx");
  }, {
    events: [divEvent("2026-02-01", 2)],
    txs: [aTx("b1", 10n, "2026-01-05"), aTx("s-late", -5n, "2026-02-20")],
    skipped: [{ signature: "f3", reason: "tx unreadable: TypeError: fetch failed" }],
  });
});

test("schema: the reason cap applies to every event type, not only multiplier changes", () => {
  assert.throws(() => validateEvent({
    type: "SPLIT", effectiveDate: "2026-01-01", status: "confirmed", mint: MINT,
    sources: ["https://i.example/s"], ratioNumerator: 3, ratioDenominator: 2,
    reason: "r".repeat(2049),
  }), /reason exceeds 2048/);
});

test("engine: rank ties (same decimals and first source, different status) stay order-independent", () => {
  const lot = () => [{ id: `${MINT}-1`, mint: MINT, owner: OWNER, qtyRaw: 10n, acquiredDate: "2026-01-01", basisRaw: 0n }];
  const a = divSighting(6, "https://same.example/feed");
  const b = { ...a, status: "unverified" };
  assert.equal(applyEvents(lot(), [a, b]).accruals[0].status,
               applyEvents(lot(), [b, a]).accruals[0].status);
});

test("declarations: a corrected re-declaration with a CHANGED amount within 3 days warns", () => {
  const dir = mkdtempSync(join(tmpdir(), "lw-guard2-"));
  const file = join(dir, "declarations.json");
  writeFileSync(file, JSON.stringify([
    { symbol: "GRDx", exDate: "2026-06-18", amountPerUnitRaw: 2000000, decimals: 6, sourceUrl: "https://i.example/v1" },
    { symbol: "GRDx", exDate: "2026-06-19", amountPerUnitRaw: 4000000, decimals: 6, sourceUrl: "https://i.example/v2" },
  ]));
  const warned = [];
  const origWarn = console.warn;
  console.warn = (msg) => warned.push(String(msg));
  try {
    loadDeclarationsFile(file, REGISTRY);
    assert.ok(warned.some((w) => w.includes("changed sum") || (w.includes("GRDx") && w.includes("3 days"))), "the classic issuer fix flow is named loudly");
  } finally {
    console.warn = origWarn;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report: a scan without a skipped list builds instead of 500", () => {
  const gTx = (signature, deltaRaw, isoDate, slot) => ({
    signature, slot, err: null, moneyDeltas: [],
    blockTime: Math.floor(Date.parse(isoDate) / 1000),
    deltas: [{ owner: OWNER, mint: MINT, preRaw: 0n, postRaw: 0n, deltaRaw }],
  });
  const scan = { owner: OWNER, signatures: 1, fetched: 1, truncated: false, accounts: {}, txs: [gTx("gb1", 10n, "2025-06-01", 1)] };
  const rep = buildWalletReport(scan, { registry: REGISTRY, timelines: new Map() });
  assert.equal(rep.counts.skipped, 0);
});
