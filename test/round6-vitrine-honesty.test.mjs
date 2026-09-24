// Round 6 regression tests of the Lotwise review — the src/ui/page.mjs zone (the vitrine).
// Findings:
//   LW2_calc_typeerror_on_no_timeline_token — calc() unconditionally reads m.sampleScaledQty.exact:
//       a short /multiplier response for a token without a timeline ({mint,date,multiplier:"1",events:0})
//       or an {error} on 400 renders a bare "Cannot read properties of undefined
//       (reading 'exact')" into calc-out instead of an honest caption;
//   LW2_vitrine_ignores_journal_corrupted  — the vitrine reads only journal.unavailable
//       and excluded from /health: journal.corrupted / journal.preserveFailed / registry.corrupted are not shown,
//       so after a start with a broken journal the backfilled "1"s look computed;
//   LW2_excluded_token_adjusted_row_unmarked — renderWallet for excluded/adjustedAvailable:false
//       paints the row "adjusted (exact) = raw" (the raw balance passed off as adjusted),
//       and completeness says nothing about the tokens excluded from multipliers.
// The client script runs in vm with a DOM stub (the ui.test.mjs / round5-api-ui.test.mjs pattern).
import test from "node:test";
import assert from "node:assert/strict";
import { renderPage } from "../src/ui/page.mjs";
import vm from "node:vm";

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

const MINT = "A".repeat(32);
const SUMMARY_ONE = [
  { symbol: "NOX", name: "Token NoX", issuer: "Backed", mint: MINT, decimals: 8, events: 0, currentMultiplier: "1" },
];
const HEALTH_ONE = { ok: true, status: 200, body: { tokens: 1, events: 0, journal: null } };

// ---- LW2_calc_typeerror_on_no_timeline_token: calc is honest with an incomplete /multiplier ----

test("calc: a token without a timeline (a short response without sampleScaledQty) — a caption, not a TypeError", async () => {
  const { sb, els } = runClient((url) => {
    if (url.startsWith("/health")) return HEALTH_ONE;
    if (url.startsWith("/summary")) return { ok: true, status: 200, body: SUMMARY_ONE };
    // the exact shape of server.mjs:208 for a token without a timeline — no sampleScaledQty
    if (url.startsWith("/multiplier")) {
      return { ok: true, status: 200, body: { mint: MINT, date: "2026-09-20T00:00:00.000Z", multiplier: "1", events: 0 } };
    }
    return undefined; // /events, /onchain — irrelevant to the test
  });
  await flush(); // boot: /health → /summary → select(NOX) → calc → /multiplier
  const html = els.get("calc-out").innerHTML;
  assert.ok(html.includes("multiplier unavailable for this token"), "the honest caption is in place");
  assert.ok(!html.includes("Cannot read properties"), "no bare TypeError");
  assert.ok(!html.includes("adjusted (base units)"), "adjusted not invented");
  assert.ok(!html.includes("remainder policy"), "the dust policy is not painted without a computation");
  assert.ok(!html.includes("multiplier at"), "the fabricated \"1\" is not shown as a computation");
  sb.calc(); // a manual recompute along the same branch — stable
  await flush();
  assert.ok(els.get("calc-out").innerHTML.includes("multiplier unavailable for this token"), "the caption also on a manual calc");
});

test("calc: an {error} response of /multiplier (400) — the reason text, not a TypeError", async () => {
  const { els } = runClient((url) => {
    if (url.startsWith("/health")) return HEALTH_ONE;
    if (url.startsWith("/summary")) return { ok: true, status: 200, body: SUMMARY_ONE };
    if (url.startsWith("/multiplier")) {
      return { ok: false, status: 400, body: { error: "date must be ISO-8601 (YYYY-MM-DD, or with time + timezone)" } };
    }
    return undefined;
  });
  await flush();
  const html = els.get("calc-out").innerHTML;
  assert.ok(html.includes("date must be ISO-8601"), "the reason from {error} is shown");
  assert.ok(!html.includes("Cannot read properties"), "no bare TypeError");
});

test("calc: a full response with sampleScaledQty computes as before — the gate did not overreach", async () => {
  const { els } = runClient((url) => {
    if (url.startsWith("/health")) return HEALTH_ONE;
    if (url.startsWith("/summary")) return { ok: true, status: 200, body: SUMMARY_ONE };
    if (url.startsWith("/multiplier")) {
      return { ok: true, status: 200, body: { mint: MINT, date: "2026-09-20T00:00:00.000Z", multiplier: "2",
        sampleScaledQty: { exact: true, whole: "300000000", remainder: "0", den: "1" }, events: 1 } };
    }
    return undefined;
  });
  await flush();
  const html = els.get("calc-out").innerHTML;
  assert.ok(html.includes("multiplier at 2026-09-20"), "the computation date is in place");
  assert.ok(html.includes("adjusted (base units)") && html.includes("300000000"), "the computation rendered");
  assert.ok(html.includes("no dust"), "the dust policy is in place");
});

// ---- LW2_vitrine_ignores_journal_corrupted: the corruption banners from /health ----

const bootWithHealth = (health) => runClient((url) => {
  if (url.startsWith("/health")) return { ok: true, status: 200, body: health };
  if (url.startsWith("/summary")) return { ok: true, status: 200, body: [] };
  return undefined;
});

test("renderStats: journal.corrupted / preserveFailed / registry.corrupted — a banner per each truthy", async () => {
  const { els } = bootWithHealth({
    tokens: 2, events: 1,
    journal: { replayed: 1, unavailable: 0, corrupted: 1, preserveFailed: 1 },
    registry: { corrupted: 1 },
  });
  await flush();
  const html = els.get("stats").innerHTML;
  assert.ok(html.includes("journal corrupted at startup"), "banner: the journal is corrupted");
  assert.ok(html.includes("corrupted journal could not be preserved"), "banner: the evidence was not preserved");
  assert.ok(html.includes("token registry corrupted at startup"), "banner: the registry is corrupted");
  assert.equal((html.match(/multipliers may be incomplete, restored by backfill/g) || []).length, 3,
    "each banner carries the honest backfill caption");
  assert.ok(html.includes(">1<"), "the flag value is shown like the other banners");
});

test("renderStats: zero flags (0 / journal null / registry absent) — silence, no crash", async () => {
  let r = bootWithHealth({ tokens: 2, events: 1, journal: { replayed: 2, unavailable: 0, corrupted: 0, preserveFailed: 0 }, registry: { corrupted: 0 } });
  await flush();
  let html = r.els.get("stats").innerHTML;
  assert.ok(!html.includes("journal corrupted at startup"), "corrupted 0 — no banner");
  assert.ok(!html.includes("could not be preserved"), "preserveFailed 0 — no banner");
  assert.ok(!html.includes("registry corrupted at startup"), "registry.corrupted 0 — no banner");
  r = bootWithHealth({ tokens: 2, events: 1, journal: null }); // no registry field at all
  await flush();
  html = r.els.get("stats").innerHTML;
  assert.ok(!html.includes("corrupted"), "journal null and no registry — no banners, no crash");
});

// ---- LW2_excluded_token_adjusted_row_unmarked: adjusted does not pass raw off as itself ----

const ADDR = "Wa11etBuyer" + "a".repeat(32);
const repOf = (token) => ({
  owner: ADDR,
  counts: { signatures: 1, fetched: 1, skipped: 0, relevantTxs: 1 },
  truncated: false, complete: true,
  tokens: [token],
});
const baseToken = {
  symbol: "NOX", name: "Token NoX", decimals: 8,
  rawBalance: "10", onchainNow: "10", reconciles: true,
  multiplier: { now: "1", events: 0 },
  adjusted: { exact: true, whole: "10", remainder: "0", den: "1" },
  lots: [], realizedCount: 0, gaps: [],
};
const scanWallet = (token) => {
  const { sb, els } = runClient((url) =>
    url.startsWith("/lots?") ? { ok: true, status: 200, body: repOf(token) } : undefined);
  els.get("addr-in").value = "B".repeat(44);
  sb.scanWalletUi();
  return { sb, els, out: () => els.get("wallet-out").innerHTML };
};

test("renderWallet: an excluded token — \"adjusted — not computed\", raw not passed off as adjusted; completeness counts the excluded", async () => {
  const { out } = scanWallet({ ...baseToken, excluded: true, excludedReason: "chain discontinuity at 2026-05-01" });
  await flush();
  const html = out();
  assert.ok(html.includes("adjusted — not computed"), "the honest row instead of an adjusted computation");
  assert.ok(html.includes("chain discontinuity at 2026-05-01"), "the exclusion reason is visible");
  assert.ok(!html.includes("adjusted (exact)"), "the \"adjusted (exact) = raw\" row is gone");
  assert.ok(html.includes("1 tokens excluded"), "completeness marks the excluded tokens");
});

test("renderWallet: adjustedAvailable === false without excluded — adjusted not computed, completeness clean", async () => {
  // the contract with the /lots fix: the API adds adjustedAvailable:false for excluded mints;
  // the render must fire without t.excluded too
  const { out } = scanWallet({ ...baseToken, adjustedAvailable: false });
  await flush();
  const html = out();
  assert.ok(html.includes("adjusted — not computed"), "the adjusted computation is not shown");
  assert.ok(!html.includes("adjusted (exact)"), "the raw value is not passed off as adjusted (exact)");
  assert.ok(!html.includes("tokens excluded"), "a non-excluded token is not counted as excluded");
});

test("renderWallet: a regular token (adjustedAvailable: true) — adjusted (exact) as before", async () => {
  const { out } = scanWallet({
    ...baseToken, adjustedAvailable: true,
    adjusted: { exact: false, whole: "9", remainder: "1", den: "3" },
  });
  await flush();
  const html = out();
  assert.ok(html.includes("adjusted (exact)"), "the adjusted (exact) row is in place");
  assert.ok(html.includes("0.00000009") && html.includes("+ 1/3 base units"), "the value with a remainder rendered");
  assert.ok(!html.includes("not computed"), "no false caption on a computed value");
  assert.ok(!html.includes("tokens excluded"), "no excluded suffix");
});
