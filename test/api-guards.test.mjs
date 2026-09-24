// formerly round7-guards.test.mjs
// Round 7 regression tests of the Lotwise review — "guards" (wave 4).
// ROUND7 findings:
//   #8  XFF buckets keyed on the FIRST element (client-supplied in an appending chain) —
//       rotating the header mints unlimited buckets; the key must be the LAST
//       element (the one our trusted proxy appended).
//   #9  vitrine: numeric-by-contract fields (counts.signatures/fetched/skipped,
//       multiplier.events, stats tokens/events) went into innerHTML without esc.
//   #10 serve.mjs: --port/--host/--rpc without guards (--port abc lived until listen,
//       --port=8787 was silently ignored, a trailing --rpc killed the env fallback).
//   #14 tx.mjs: the `tx === null` guard lets undefined through (RPC without result/error) —
//       a TypeError kills the whole scan instead of honestly skipping one transaction.
//   #15 scaled-ui: the pending multiplier without validation (garbage "abc" rode into /onchain).
//   #6  metadataSources drops externalUrl (the camelCase output of our own client)
//       — Tessera and PreStocks.
//   #13 toDecimalString: String(1e-7)="1e-7" does not pass DECIMAL_RE — a whole token
//       history died with NormalizeError instead of an exact positional conversion.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createApiServer } from "../src/api/server.mjs";
import { renderPage } from "../src/ui/page.mjs";
import { parseScaledUiAmount, ScaledUiError } from "../src/issuer/scaled-ui.mjs";
import { fetchWalletDeltas } from "../src/ingest/tx.mjs";
import { multiplierHistoryToEvents } from "../src/events/normalize-xstocks.mjs";
import { metadataSources as tesseraSources } from "../src/issuer/tessera.mjs";
import { metadataSources as prestocksSources } from "../src/events/normalize-prestocks.mjs";
import { parseServeArgs } from "../src/cli/flags.mjs";
import { loadRegistry } from "../src/registry/registry.mjs";

const MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const OWNER = "9BB7Tt5uW5QbAorLkF3Hn1P2mGcXvcDdR7y8LbT9KdUu";

// ---- ROUND7 #8: the rate-limit key = the LAST XFF element ----

test("ratelimit: spoofing the first XFF element does not mint buckets — the key is the last one", async () => {
  const registry = await loadRegistry("data/tokens.json");
  let scans = 0;
  const server = await createApiServer({
    registry, events: [],
    walletScanner: async () => {
      scans++;
      return { owner: OWNER, signatures: 1, fetched: 1, skipped: [], truncated: false, accounts: new Map(), txs: [] };
    },
    rateLimits: { scan: { windowMs: 60_000, max: 2 }, rpc: { windowMs: 60_000, max: 60 } },
    trustProxy: true,
  });
  const { port } = server.address();
  try {
    const go = (xff) => fetch(`http://127.0.0.1:${port}/lots?address=${OWNER}`, { headers: { "x-forwarded-for": xff } });
    // one real client 77.77.77.77 behind our proxy, the attacker rotates the SPOOF prefix
    assert.equal((await go("1.1.1.1, 77.77.77.77")).status, 200);
    assert.equal((await go("2.2.2.2, 77.77.77.77")).status, 200);
    assert.equal((await go("3.3.3.3, 77.77.77.77")).status, 429, "the third request of the same real IP — beyond 2/min");
    assert.equal((await go("4.4.4.4, 88.88.88.88")).status, 200, "another real IP — its own bucket");
    assert.equal(scans, 3, "429 does not hit the scanner");
  } finally {
    server.close();
  }
});

// ---- ROUND7 #9: esc() for numeric-by-contract fields of the vitrine ----

// the page client script in vm with a DOM stub (the ui.test.mjs pattern, round 4)
function runClient() {
  const els = new Map();
  const makeEl = (id) => ({
    id, value: "", innerHTML: "", textContent: "", className: "", style: {},
    attrs: {}, getAttribute() { return null; }, scrollIntoView() {},
  });
  const sb = {
    document: {
      getElementById: (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
      querySelectorAll: () => [],
    },
    fetch: () => new Promise(() => {}), // irrelevant chains stay silent
  };
  vm.createContext(sb);
  const m = renderPage().match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, "script block is in place");
  new vm.Script(m[1], { filename: "page-client.js" }).runInContext(sb);
  return { sb, els };
}

test("vitrine: a string in a numeric-by-contract field (counts.fetched) is escaped", () => {
  const { sb, els } = runClient();
  sb.renderWallet({
    owner: OWNER,
    counts: { signatures: "<script>alert(1)</script>", fetched: 1, skipped: 0 },
    truncated: false, complete: true, tokens: [],
  });
  const html = els.get("wallet-out").innerHTML;
  assert.ok(!html.includes("<script>alert"), "a raw script does not survive interpolation");
  assert.ok(html.includes("&lt;script&gt;"), "the value is shown, but escaped");
});

test("vitrine: multiplier.events — a string field is escaped too", () => {
  const { sb, els } = runClient();
  sb.renderWallet({
    owner: OWNER,
    counts: { signatures: 1, fetched: 1, skipped: 0 },
    truncated: false, complete: true,
    tokens: [{
      symbol: "TSTx", name: "Test", decimals: 8, rawBalance: "10", onchainNow: "10", reconciles: true,
      multiplier: { now: "1", events: "<script>alert(2)</script>" },
      adjusted: { exact: true, whole: "10", remainder: "0", den: "1" },
      lots: [], realizedCount: 0, gaps: [],
    }],
  });
  const html = els.get("wallet-out").innerHTML;
  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes("&lt;script&gt;"));
});

// ---- ROUND7 #10: the serve.mjs flag parser ----

test("flags: --port=8787 (equals form) parses, not silently ignored", () => {
  assert.equal(parseServeArgs(["--port=18899"]).port, 18899);
  assert.equal(parseServeArgs(["--port", "18899"]).port, 18899);
});

test("flags: --port abc — refusal BEFORE boot (an integer)", () => {
  assert.throws(() => parseServeArgs(["--port", "abc"]), /port/);
  assert.throws(() => parseServeArgs(["--port=0"]), /port/);
});

test("flags: a flag without a value (the last argument) — a refusal, not an undefined fallback", () => {
  for (const flag of ["--port", "--host", "--rpc", "--max-txs"]) {
    assert.throws(() => parseServeArgs([flag]), new RegExp(flag.slice(2)), `${flag} without a value`);
  }
});

test("flags: defaults and the RPC env fallback untouched", () => {
  const a = parseServeArgs([]);
  assert.equal(a.port, 8787);
  assert.equal(a.host, "127.0.0.1");
  assert.equal(a.maxTxs, 300);
  assert.equal(a.rpcUrl, "https://api.mainnet-beta.solana.com");
});

test("flags: the --max-txs guard moved into the parser without losing the message", () => {
  assert.throws(() => parseServeArgs(["--max-txs", "abc"]), /max-txs/);
  assert.equal(parseServeArgs(["--max-txs", "500"]).maxTxs, 500);
});

// ---- ROUND7 #14: tx === null let undefined through ----

test("tx: an RPC response without result and without error — an honest null (skip), not a TypeError of the whole scan", async () => {
  const lyingGateway = { call: async () => undefined };
  const out = await fetchWalletDeltas(lyingGateway, "sig111111111111111111111111111111111111111111", new Set([MINT]));
  assert.equal(out, null);
});

// ---- ROUND7 #15: the pending multiplier is validated like active ----

test("scaled-ui: pending garbage (\"abc\") — ScaledUiError, symmetric to active", () => {
  const mint = {
    owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    data: { parsed: { info: { decimals: 8, extensions: [{ extension: "scaledUiAmountConfig", state: {
      multiplier: "1", newMultiplier: "abc", newMultiplierEffectiveTimestamp: Date.UTC(2026, 8, 1) / 1000,
    } }] } } },
  };
  assert.throws(() => parseScaledUiAmount(mint), (err) => err instanceof ScaledUiError && /newMultiplier|pending/i.test(err.message));
});

// ---- ROUND7 #6: metadataSources accepts the output of our own client ----

test("tessera metadataSources: camelCase externalUrl (the client output) is not lost", () => {
  const out = tesseraSources({
    externalUrl: "https://www.tessera.pe",
    attributes: [{ trait_type: "Terms and Conditions", value: "https://tessera.example/terms" }],
  });
  assert.deepEqual(out, ["https://www.tessera.pe", "https://tessera.example/terms"]);
});

test("prestocks metadataSources: camelCase externalUrl (the client output) is not lost", () => {
  const out = prestocksSources({ externalUrl: "https://prestocks.com/openai", terms: "https://prestocks.com/terms" });
  assert.deepEqual(out, ["https://prestocks.com/openai", "https://prestocks.com/terms"]);
});

// ---- ROUND7 #13: toDecimalString — exponential number notation ----

test("xstocks normalize: a multiplier number 1e-7 → an exact positional string, the token does not die", () => {
  const events = multiplierHistoryToEvents([
    { id: "n1", reason: "Rebase", multiplier: 1e-7, previousMultiplier: "1", activationDateTime: "2026-07-01T00:00:00Z" },
  ], { symbol: "TESTx" });
  assert.equal(events.length, 1);
  assert.equal(events[0].multiplierTo, "0.0000001");
  assert.equal(events[0].multiplierFrom, "1");
});

test("xstocks normalize: ordinary numbers/strings ride as before", () => {
  const events = multiplierHistoryToEvents([
    { id: "n1", reason: "Rebase", multiplier: 5, previousMultiplier: "1", activationDateTime: "2026-07-01T00:00:00Z" },
  ], { symbol: "TESTx" });
  assert.equal(events[0].multiplierTo, "5");
  const events2 = multiplierHistoryToEvents([
    { id: "n1", reason: "Rebase", multiplier: "1.5", previousMultiplier: "1", activationDateTime: "2026-07-01T00:00:00Z" },
  ], { symbol: "TESTx" });
  assert.equal(events2[0].multiplierTo, "1.5");
});
