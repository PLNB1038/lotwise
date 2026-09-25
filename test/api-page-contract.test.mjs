
// Regression tests of Lotwise review — zone src/api/server.mjs + src/ui/page.mjs.
// Findings:
//   LW_onchain_rolled_date_500            — /onchain?date=2026-02-30 → 500 instead of 400
//                                           (Date.parse rolls the date over, the strict parser
//                                           lower in the stack throws, the RPC cache is warmed for nothing);
//   LW_ui_crosscheck_badge_date_collision — cross-check badges are keyed by effectiveDate:
//                                           two events on one day → the first shows
//                                           the verdict of the second;
//   LW_excluded_token_shows_multiplier_1  — a token excluded from the vitrine by TimelineError
//                                           serves a silent "1" in /summary and /lots,
//                                           and /health says nothing about the exclusion.
import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/api/server.mjs";
import { multiplierHistoryToEvents, bindMintAndValidate } from "../src/events/normalize-xstocks.mjs";
import { loadRegistry } from "../src/registry/registry.mjs";
import { renderPage } from "../src/ui/page.mjs";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const SPYx = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const OWNER = "9BB7Tt5uW5QbAorLkF3Hn1P2mGcXvcDdR7y8LbT9KdUu"; // same as in wallet.test.mjs

const historyNodes = JSON.parse(readFileSync(path.join(dir, "xstocks-spyx-history-eth.json"), "utf8")).nodes;
const events = bindMintAndValidate(multiplierHistoryToEvents(historyNodes, { symbol: "SPYx" }), SPYx);

async function withServer(opts, fn) {
  if (typeof opts === "function") fn = opts; // withServer(fn) — no options
  const o = typeof opts === "object" && opts !== null ? opts : {};
  const registry = await loadRegistry("data/tokens.json");
  const server = await createApiServer({ registry, events, ...o });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

// Server with a "poisoned" mint: a broken chain → TimelineError at startup →
// the token is excluded from the vitrine (the round-4 test pattern in api.test.mjs).
// optsFn(bad) lets you assemble options that need the excluded token's mint.
async function withPoisonedServer(fn, optsFn = null) {
  const registry = await loadRegistry("data/tokens.json");
  const bad = registry.find((t) => t.symbol === "T-SpaceX");
  const poisoned = [
    ...events,
    {
      type: "MULTIPLIER_CHANGE", mint: bad.mint, effectiveDate: "2026-05-01T00:00:00.000Z",
      status: "confirmed", sources: ["test:broken-chain"],
      multiplierFrom: "5", multiplierTo: "6", reason: "On-chain rebase",
    },
  ];
  const opts = typeof optsFn === "function" ? optsFn(bad) : {};
  const server = await createApiServer({ registry, events: poisoned, ...opts });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`, bad);
  } finally {
    server.close();
  }
}

// ---- LW_onchain_rolled_date_500: rolled-over dates — 400 from the gate, before the reader ----

test("/onchain: rolled-over date 2026-02-30 — 400 BEFORE the reader, not 500 and not RPC", async () => {
  let readerCalls = 0;
  await withServer({
    onchainReader: async () => {
      readerCalls += 1;
      return { activeMultiplier: "1", pendingMultiplier: null, pendingEffectiveDate: null, hasExtension: true };
    },
  }, async (base) => {
    const res = await fetch(`${base}/onchain?symbol=SPYx&date=2026-02-30`);
    assert.equal(res.status, 400); // was: 500 — Date.parse rolled over to 03-02, TimelineError above the gate
    const body = await res.json();
    assert.match(body.error, /date/i);
    assert.equal(readerCalls, 0); // a garbage date must not warm the cache with a real RPC call
  });
});

test("/onchain: 2026-06-31, 2027-02-29 and 2026-02-29 (not a leap year) — also 400", async () => {
  await withServer(async (base) => {
    for (const d of ["2026-06-31", "2027-02-29", "2026-02-29"]) {
      const res = await fetch(`${base}/onchain?symbol=SPYx&date=${d}`);
      assert.equal(res.status, 400, d); // was: Date.parse rolled over — 503 (reader not configured)
      assert.match((await res.json()).error, /date/i, d);
    }
  });
});

test("/multiplier: rolled-over dates — 400 from the date gate, not a TimelineError leak", async () => {
  await withServer(async (base) => {
    for (const d of ["2026-02-30", "2026-06-31"]) {
      const res = await fetch(`${base}/multiplier?symbol=SPYx&raw=1000&date=${d}`);
      assert.equal(res.status, 400, d);
      // before the fix the 400 came from the catch around scaledQty with an inner TimelineError;
      // after — from the gate with a clear message about the date format
      assert.match((await res.json()).error, /ISO-8601/, d);
    }
  });
});

test("the strict gate did not overreach: valid /onchain and /multiplier dates pass", async () => {
  await withServer({
    onchainReader: async () => ({ activeMultiplier: "1", pendingMultiplier: null, pendingEffectiveDate: null, hasExtension: true }),
  }, async (base) => {
    assert.equal((await fetch(`${base}/onchain?symbol=SPYx&date=2026-06-18`)).status, 200);
    assert.equal((await fetch(`${base}/onchain?symbol=SPYx&date=2026-06-18T00:00:00Z`)).status, 200);
    assert.equal((await fetch(`${base}/multiplier?symbol=SPYx&raw=1000&date=2026-02-28`)).status, 200);
    assert.equal((await fetch(`${base}/multiplier?symbol=SPYx&raw=1000&date=2028-02-29`)).status, 200); // leap year
  });
});

// ---- LW_excluded_token_shows_multiplier_1: honest marking of excluded tokens ----

test("/summary: an excluded token is marked excluded+reason, live ones — without the flag", async () => {
  await withPoisonedServer(async (base) => {
    const rows = await (await fetch(`${base}/summary`)).json();
    const excluded = rows.find((r) => r.symbol === "T-SpaceX");
    assert.equal(excluded.excluded, true); // was: undefined, the row was indistinguishable from "no events"
    assert.ok(typeof excluded.excludedReason === "string" && excluded.excludedReason.length > 0);
    const good = rows.find((r) => r.symbol === "SPYx");
    assert.equal(good.excluded, undefined); // live tokens do not get the flag
    assert.equal(good.currentMultiplier, "1.005714560286254");
  });
});

test("/health: list of excluded tokens with a reason; a clean server — an empty list", async () => {
  await withPoisonedServer(async (base, bad) => {
    const h = await (await fetch(`${base}/health`)).json();
    assert.ok(Array.isArray(h.excluded)); // was: the field was missing
    assert.equal(h.excluded.length, 1);
    assert.equal(h.excluded[0].mint, bad.mint);
    assert.equal(h.excluded[0].symbol, "T-SpaceX");
    assert.ok(h.excluded[0].reason.length > 0);
  });
  await withServer(async (base) => {
    const h = await (await fetch(`${base}/health`)).json();
    assert.deepEqual(h.excluded, []); // nothing excluded — an honest empty list
  });
});

test("/lots: a token of an excluded mint is marked excluded in the report", async () => {
  const scanOf = (mint) => ({
    owner: OWNER, signatures: 1, fetched: 1, skipped: [], truncated: false,
    accounts: new Map([[mint, { address: "At5", currentRaw: 10n }]]),
    txs: [
      { signature: "a", slot: 1, blockTime: 100, deltas: [{ owner: OWNER, mint, preRaw: 0n, postRaw: 10n, deltaRaw: 10n }] },
    ],
  });
  await withPoisonedServer(async (base) => {
    const rep = await (await fetch(`${base}/lots?address=${OWNER}`)).json();
    const t = rep.tokens.find((x) => x.symbol === "T-SpaceX");
    assert.ok(t, "the excluded-mint token is present in the report");
    assert.equal(t.multiplier.now, "1"); // we do not invent raw values
    assert.equal(t.excluded, true); // was: undefined — the "1" looked computed
    assert.ok(typeof t.excludedReason === "string" && t.excludedReason.length > 0);
  }, (bad) => ({ walletScanner: async () => scanOf(bad.mint) }));
});

// ---- vitrine: the client script in vm with a DOM stub (the ui.test.mjs pattern) ----

// route(url) -> {ok, status, body} | Promise<{...}> | undefined (the request hangs forever)
function runClient(route) {
  const els = new Map();
  const makeEl = (id) => ({
    id, value: '', innerHTML: '', textContent: '', className: '', style: {},
    attrs: {},
    getAttribute(name) { return this.attrs[name] ?? null; },
    scrollIntoView() {},
  });
  const sb = {
    document: {
      getElementById: (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
      querySelectorAll: () => [], // the token table rows are not exercised in these tests
    },
    fetch: (url) => {
      const hit = route(url);
      const p = hit instanceof Promise ? hit : Promise.resolve(hit);
      return p.then((res) => res === undefined
        ? new Promise(() => {})
        : { ok: res.ok, status: res.status, json: async () => res.body });
    },
  };
  vm.createContext(sb);
  const m = renderPage().match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, "script block is in place");
  new vm.Script(m[1], { filename: "page-client.js" }).runInContext(sb); // syntax as in the browser
  return { sb, els };
}

const flush = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };

test("cross-check badges: two events on one day — each gets its own verdict", async () => {
  const DUP_EVENTS = [
    { effectiveDate: "2026-03-01T00:00:00.000Z", type: "MULTIPLIER_CHANGE", multiplierFrom: "1", multiplierTo: "2", reason: "first dividend" },
    { effectiveDate: "2026-03-01T00:00:00.000Z", type: "MULTIPLIER_CHANGE", multiplierFrom: "2", multiplierTo: "3", reason: "second dividend" },
  ];
  const DUP_VERDICTS = [
    { effectiveDate: "2026-03-01T00:00:00.000Z", verdict: "consistent", note: "n1" },
    { effectiveDate: "2026-03-01T00:00:00.000Z", verdict: "mismatch", note: "n2" },
  ];
  const { sb, els } = runClient((url) => {
    if (url.startsWith("/health")) return { ok: true, status: 200, body: { tokens: 1, events: 2, journal: null } };
    if (url.startsWith("/summary")) return { ok: true, status: 200, body: [
      { symbol: "ONE", name: "Token One", issuer: "Backed", mint: "A".repeat(32), decimals: 8, events: 2, currentMultiplier: "3" },
    ] };
    if (url.startsWith("/events?symbol=ONE")) return { ok: true, status: 200, body: DUP_EVENTS };
    if (url.startsWith("/crosscheck?symbol=ONE")) return { ok: true, status: 200, body: { verdicts: DUP_VERDICTS, coverage: {} } };
    return undefined;
  });
  await flush(); // boot: /health → /summary → select(ONE) → events + cross-check
  const html = els.get("events").innerHTML;
  const first = html.split("<li>").find((s) => s.includes("first dividend")) ?? "";
  const second = html.split("<li>").find((s) => s.includes("second dividend")) ?? "";
  assert.ok(first.includes("price: consistent"), "the first event shows ITS OWN verdict");
  assert.ok(second.includes("price: mismatch"), "the second event — its own");
});

test("vitrine: the table and the banner mark excluded tokens, not a silent \"1\"", async () => {
  const REASON = "chain discontinuity at 2026-05-01: expected from=1, got 5";
  const { sb, els } = runClient((url) => {
    if (url.startsWith("/health")) return { ok: true, status: 200, body: { tokens: 2, events: 1, journal: null, excluded: [{ mint: "B".repeat(32), symbol: "TWO", reason: REASON }] } };
    if (url.startsWith("/summary")) return { ok: true, status: 200, body: [
      { symbol: "ONE", name: "Token One", issuer: "Backed", mint: "A".repeat(32), decimals: 8, events: 1, currentMultiplier: "2" },
      { symbol: "TWO", name: "Token Excluded", issuer: "Backed", mint: "B".repeat(32), decimals: 8, events: 0, currentMultiplier: "1", excluded: true, excludedReason: REASON },
    ] };
    return undefined;
  });
  await flush();
  const stats = els.get("stats").innerHTML;
  assert.ok(stats.includes("excluded"), "the banner about excluded tokens is in place");
  assert.ok(stats.includes(">1<"), "the excluded counter is shown");
  const two = els.get("tokens").innerHTML.split("<tr").find((s) => s.includes("TWO")) ?? "";
  assert.ok(two.includes("excluded"), "the excluded row is marked");
  assert.ok(two.includes("chain discontinuity"), "the reason is available (title)");
  assert.ok(!/>1<\/td>/.test(two), "a bare \"1\" is not shown instead of a computed multiplier");
});

test("vitrine: the wallet report honestly marks an excluded multiplier", async () => {
  const rep = {
    owner: "A".repeat(32),
    counts: { signatures: 1, fetched: 1, skipped: 0, relevantTxs: 1 },
    truncated: false, complete: true,
    tokens: [{ symbol: "TWO", name: "Token Excluded", decimals: 8, rawBalance: "10", onchainNow: "10", reconciles: true,
      multiplier: { now: "1", events: 0 }, adjusted: { exact: true, whole: "10", remainder: "0", den: "1" },
      lots: [], realizedCount: 0, gaps: [],
      excluded: true, excludedReason: "chain discontinuity at 2026-05-01" }],
  };
  const { sb, els } = runClient((url) =>
    url.startsWith("/lots?") ? { ok: true, status: 200, body: rep } : undefined);
  els.get("addr-in").value = "B".repeat(44);
  sb.scanWalletUi();
  await flush();
  const html = els.get("wallet-out").innerHTML;
  assert.ok(html.includes("excluded"), "the exclusion is shown");
  assert.ok(html.includes("chain discontinuity at 2026-05-01"), "the reason is visible to the user");
});
