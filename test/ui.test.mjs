import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/api/server.mjs";
import { multiplierHistoryToEvents, bindMintAndValidate } from "../src/events/normalize-xstocks.mjs";
import { loadRegistry } from "../src/registry/registry.mjs";
import { parseScaledUiAmount } from "../src/issuer/scaled-ui.mjs";
import { renderPage } from "../src/ui/page.mjs";
import { readFileSync } from "node:fs";
import net from "node:net";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const SPYx = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";

const historyNodes = JSON.parse(readFileSync(path.join(dir, "xstocks-spyx-history-eth.json"), "utf8")).nodes;
const events = bindMintAndValidate(multiplierHistoryToEvents(historyNodes, { symbol: "SPYx" }), SPYx);
const onchainFixture = JSON.parse(readFileSync(path.join(dir, "onchain-spyx-mint.json"), "utf8"));

async function withServer(opts, fn) {
  if (typeof opts === "function") fn = opts; // withServer(fn) — no options
  const { onchainReader = null } = typeof opts === "object" && opts !== null ? opts : {};
  const registry = await loadRegistry("data/tokens.json");
  const server = await createApiServer({ registry, events, onchainReader });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("/ serves a self-sufficient vitrine page", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
    const html = await res.text();
    assert.ok(html.includes("<title>Lotwise"));
    assert.ok(html.includes('id="tokens"'));
    assert.ok(html.includes("/summary"));
    assert.ok(html.includes("/onchain"));
    // self-sufficiency: no external resources, everything — relative fetches to its own API
    assert.ok(!html.includes('src="http'));
    assert.ok(!html.includes('href="http'));
    // the template literal is computed fully, without leftovers
    assert.ok(!html.includes("${"));
  });
});

test("/summary: a row per registry token, sorted by events, the today multiplier for SPYx", async () => {
  await withServer(async (base) => {
    const rows = await (await fetch(`${base}/summary`)).json();
    assert.equal(rows.length, (await loadRegistry("data/tokens.json")).length);
    // event-bearing tokens first, then alphabetically
    assert.equal(rows[0].symbol, "SPYx");
    assert.equal(rows[0].events, 4);
    assert.equal(rows[0].currentMultiplier, "1.005714560286254");
    assert.equal(rows[0].decimals, 8);
    const quiet = rows.filter((r) => r.events === 0);
    assert.ok(quiet.length > 0);
    assert.ok(quiet.every((r) => r.currentMultiplier === "1"));
    const syms = quiet.map((r) => r.symbol);
    assert.deepEqual(syms, [...syms].sort((a, b) => a.localeCompare(b)));
  });
});

test("/onchain without a reader — 503 with a clear reason", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/onchain?symbol=SPYx`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.match(body.error, /not configured/);
  });
});

test("/onchain: the live SPYx plan (active 1.0039 + pending 1.0057) today converges via the pending rule", async () => {
  const parsed = parseScaledUiAmount(onchainFixture.result.value);
  await withServer({ onchainReader: async () => parsed }, async (base) => {
    const res = await fetch(`${base}/onchain?symbol=SPYx`);
    assert.equal(res.status, 200);
    const b = await res.json();
    assert.equal(b.onChain.active, "1.003909240011759");
    assert.equal(b.onChain.pending, "1.005714560286254");
    // the active field on chain has not rotated yet, but the pending is effective since 18.06.2026 —
    // our pending-after-timestamp rule gives effective = the API current
    assert.equal(b.onChainEffective, "1.005714560286254");
    assert.equal(b.api, "1.005714560286254");
    assert.equal(b.verdict, "ok");
  });
});

test("/onchain: inside the activation window (before the pending timestamp) both plans are still at 1.0039 — agreed", async () => {
  const parsed = parseScaledUiAmount(onchainFixture.result.value);
  await withServer({ onchainReader: async () => parsed }, async (base) => {
    const b = await (await fetch(`${base}/onchain?symbol=SPYx&date=2026-06-01T00:00:00Z`)).json();
    assert.equal(b.api, "1.003909240011759");
    assert.equal(b.onChainEffective, "1.003909240011759"); // the pending is not effective yet -> active
    assert.equal(b.verdict, "ok");
  });
});

test("/onchain: a divergence of plans is caught — the chain without a pending, the API already applied the event", async () => {
  // a naive chain read (only active, no pending assigned) against the API current
  const staleChain = {
    program: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    decimals: 8,
    activeMultiplier: "1.003909240011759",
    pendingMultiplier: null,
    pendingEffectiveDate: null,
    authority: "S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS",
    hasExtension: true,
  };
  await withServer({ onchainReader: async () => staleChain }, async (base) => {
    const b = await (await fetch(`${base}/onchain?symbol=SPYx`)).json();
    assert.equal(b.api, "1.005714560286254");
    assert.equal(b.onChainEffective, "1.003909240011759");
    assert.equal(b.verdict, "planes-disagree");
  });
});

test("/onchain: the source is unavailable — a fail-closed 503 with kind, the vitrine does not lie", async () => {
  const err = new Error("HTTP 429");
  err.kind = "rate-limit";
  await withServer({ onchainReader: async () => { throw err; } }, async (base) => {
    const res = await fetch(`${base}/onchain?symbol=SPYx`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.kind, "rate-limit");
    assert.match(body.error, /429/);
  });
});

test("/onchain without mint/symbol — a clear 400", async () => {
  await withServer({ onchainReader: async () => parseScaledUiAmount(onchainFixture.result.value) }, async (base) => {
    const res = await fetch(`${base}/onchain`);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /mint or symbol required/);
  });
});

// --- regressions of the 19.09 review round ---

function rawRequest(port, reqline) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1");
    let buf = "";
    s.on("connect", () => s.write(reqline));
    s.on("data", (d) => (buf += d.toString("latin1")));
    s.on("error", reject);
    s.on("close", () => resolve(buf));
    setTimeout(() => s.destroy(), 2000);
  });
}

test("the request-target crash vector (http://:80/) — 400, the server alive (a regression of a live crash)", async () => {
  await withServer(async (base) => {
    const { port } = new URL(base);
    const res = await rawRequest(
      Number(port),
      "GET http://:80/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
    );
    assert.match(res, /400 Bad Request/); // before: ERR_INVALID_URL killed the process with one request
    const after = await fetch(`${base}/health`);
    assert.equal(after.status, 200); // the server survived the crafted request
  });
});

test("non-GET methods — 405, POST no longer executes GET logic", async () => {
  await withServer({ onchainReader: async () => parseScaledUiAmount(onchainFixture.result.value) }, async (base) => {
    for (const path of ["/", "/onchain?symbol=SPYx", "/summary"]) {
      const res = await fetch(`${base}${path}`, { method: "POST" });
      assert.equal(res.status, 405, path);
    }
  });
});

test("a mint/symbol outside the registry — 400 on all three routes, we do not go to the chain", async () => {
  let readerCalls = 0;
  await withServer({ onchainReader: async () => { readerCalls++; return parseScaledUiAmount(onchainFixture.result.value); } }, async (base) => {
    const unknown = "?mint=NotInRegistry1111111111111111111111111111";
    for (const route of ["/events", "/multiplier", "/onchain"]) {
      const res = await fetch(`${base}${route}${unknown}`);
      assert.equal(res.status, 400, route); // before: /events silently [] and "1", /onchain ran RPC with garbage
    }
    const sym = await fetch(`${base}/events?symbol=NOSUCHx`);
    assert.equal(sym.status, 400);
    assert.equal(readerCalls, 0); // the reader was not hit once
  });
});

test("the page client script compiles (template escape regressions)", async () => {
  await withServer(async (base) => {
    const html = await (await fetch(`${base}/`)).text();
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(m, "script block is in place");
    new vm.Script(m[1]); // the syntax as it is in the browser; it will fall if the \\-escapes diverged
  });
});

test("a busy port — createApiServer rejects, does not kill the process", async () => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
  const busyPort = blocker.address().port;
  const registry = await loadRegistry("data/tokens.json");
  await assert.rejects(createApiServer({ registry, events, port: busyPort }));
  blocker.close();
});

// ---- round 4 regressions: the client script runs in vm with a DOM stub ----

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
      // no route — the request hangs: irrelevant chains (/onchain, /multiplier) stay silent
      return p.then((res) => res === undefined
        ? new Promise(() => {})
        : { ok: res.ok, status: res.status, json: async () => res.body });
    },
  };
  vm.createContext(sb);
  const m = renderPage().match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, "script block is in place");
  new vm.Script(m[1], { filename: "page-client.js" }).runInContext(sb); // vars/functions — sb globals
  return { sb, els };
}

const flush = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };

// strictly base58 (as in wallet.test.mjs), distinguishable in the report
const ADDR_A = "Wa11etBuyer" + "a".repeat(32);
const ADDR_B = "Wa11etSe11er" + "b".repeat(32);

const repOf = (owner, symbol, name) => ({
  owner,
  counts: { signatures: 2, fetched: 2, skipped: 0, relevantTxs: 2 },
  truncated: false, complete: true,
  tokens: [{ symbol, name, decimals: 8, rawBalance: "100", onchainNow: "100", reconciles: true,
    multiplier: { now: "1", events: 0 }, adjusted: { exact: true, whole: "100", remainder: "0", den: "1" },
    lots: [], realizedCount: 0, gaps: [] }],
});
const repA = repOf(ADDR_A, "AAA", "Wallet A token");
const repB = repOf(ADDR_B, "BBB", "Wallet B token");

const SUMMARY_TWO = [
  { symbol: "ONE", name: "Token One", issuer: "Backed", mint: ADDR_A, decimals: 8, events: 2, currentMultiplier: "2" },
  { symbol: "TWO", name: "Token Two", issuer: "Backed", mint: ADDR_B, decimals: 8, events: 1, currentMultiplier: "1" },
];
const EVENTS_ONE = [{ effectiveDate: "2025-01-01", type: "DIVIDEND", multiplierFrom: "1", multiplierTo: "2", reason: "dividend" }];

test("the wallet-report race: a late-arriving response of the old address does not overwrite the fresh one", async () => {
  let resolveA;
  const slowA = new Promise((r) => { resolveA = r; }); // scan A "takes long over the chain"
  const { sb, els } = runClient((url) => {
    if (!url.startsWith("/lots?")) return undefined;
    return url.includes(ADDR_A) ? slowA : { ok: true, status: 200, body: repB };
  });
  els.get("addr-in").value = ADDR_A;
  sb.scanWalletUi();
  els.get("addr-in").value = ADDR_B; // the user did not wait and scans B
  sb.scanWalletUi();
  await flush();
  const out = els.get("wallet-out");
  assert.ok(out.innerHTML.includes(ADDR_B), "the fresh report B rendered");
  assert.ok(!out.innerHTML.includes(ADDR_A), "before A ripens there is no report A");
  resolveA({ ok: true, status: 200, body: repA }); // the slow A response ripens while the address is B
  await flush();
  assert.ok(out.innerHTML.includes(ADDR_B), "after A ripens, report B is in place");
  assert.ok(!out.innerHTML.includes(ADDR_A), "the stale A response did not overwrite");
});

test("the wallet-report race: an error of a stale request does not overwrite either", async () => {
  let rejectA;
  const slowA = new Promise((_, r) => { rejectA = r; });
  const { sb, els } = runClient((url) =>
    url.includes(ADDR_A) ? slowA : { ok: true, status: 200, body: repB });
  els.get("addr-in").value = ADDR_A;
  sb.scanWalletUi();
  els.get("addr-in").value = ADDR_B;
  sb.scanWalletUi();
  await flush();
  rejectA(new Error("HTTP 429")); // the old request failed after B was already rendered
  await flush();
  const out = els.get("wallet-out");
  assert.ok(out.innerHTML.includes(ADDR_B), "report B untouched");
  assert.ok(!out.innerHTML.includes("429"), "a foreign error is not shown");
});

test("the wallet report shows the owner in the header — foreign numbers are attributable", async () => {
  const { sb, els } = runClient((url) =>
    url.startsWith("/lots?") ? { ok: true, status: 200, body: repA } : undefined);
  els.get("addr-in").value = ADDR_A;
  sb.scanWalletUi();
  await flush();
  const html = els.get("wallet-out").innerHTML;
  assert.ok(html.includes("owner"), "the owner row in the header");
  assert.ok(html.includes(ADDR_A), "the owner rendered");
  assert.ok(html.includes("AAA"), "the report tokens in place");
});

test("loadEvents: a server restart (a fetch reject) — an err note, the foreign timeline displaced", async () => {
  const { sb, els } = runClient((url) => {
    if (url.startsWith("/health")) return { ok: true, status: 200, body: { tokens: 2, events: 3, journal: null } };
    if (url.startsWith("/summary")) return { ok: true, status: 200, body: SUMMARY_TWO };
    if (url.startsWith("/events?symbol=ONE")) return { ok: true, status: 200, body: EVENTS_ONE };
    if (url.startsWith("/events?symbol=TWO")) return Promise.reject(new Error("fetch failed — server restarted"));
    return undefined; // /onchain, /crosscheck — irrelevant to the test
  });
  await flush(); // boot: /health -> /summary -> select(ONE) -> the ONE events
  assert.ok(els.get("events").innerHTML.includes("2025-01-01"), "the ONE events in place");
  sb.select("TWO"); // a token switch while the server is down
  await flush();
  const html = els.get("events").innerHTML;
  assert.ok(html.includes("Event history unavailable"), "an honest err note");
  assert.ok(html.includes("server restarted"), "the reason is visible");
  assert.ok(!html.includes("2025-01-01"), "the PREVIOUS token's events displaced");
});

test("loadEvents: a non-array (an {error} from 500) — an err note, not a masked emptiness", async () => {
  const { sb, els } = runClient((url) => {
    if (url.startsWith("/health")) return { ok: true, status: 200, body: { tokens: 2, events: 3, journal: null } };
    if (url.startsWith("/summary")) return { ok: true, status: 200, body: SUMMARY_TWO };
    if (url.startsWith("/events?symbol=ONE")) return { ok: true, status: 200, body: EVENTS_ONE };
    if (url.startsWith("/events?symbol=TWO")) return { ok: false, status: 500, body: { error: "internal error" } };
    return undefined;
  });
  await flush();
  sb.select("TWO");
  await flush();
  const html = els.get("events").innerHTML;
  assert.ok(html.includes("Event history unavailable"), "an honest err note");
  assert.ok(html.includes("500") && html.includes("internal error"), "the status and the reason are visible");
  assert.ok(!html.includes("No normalized events"), "an error is not passed off as an empty history");
});

test("renderStats: journal.unavailable > 0 — an honest banner; 0/null — silence", async () => {
  const boot = (health) => runClient((url) => {
    if (url.startsWith("/health")) return { ok: true, status: 200, body: health };
    if (url.startsWith("/summary")) return { ok: true, status: 200, body: [] };
    return undefined;
  });
  let r = boot({ tokens: 26, events: 31, journal: { replayed: 0, unavailable: 3 } });
  await flush();
  assert.ok(r.els.get("stats").innerHTML.includes("tokens unavailable at startup"), "the banner in place");
  assert.ok(r.els.get("stats").innerHTML.includes(">3<"), "the number of unread shown");
  r = boot({ tokens: 26, events: 31, journal: { replayed: 31, unavailable: 0 } });
  await flush();
  assert.ok(!r.els.get("stats").innerHTML.includes("tokens unavailable at startup"), "unavailable 0 — no banner");
  r = boot({ tokens: 26, events: 31, journal: null });
  await flush();
  assert.ok(!r.els.get("stats").innerHTML.includes("tokens unavailable at startup"), "journal null (no stats) — no banner");
});

test("fmtUi: decimals null — raw base units with a note, not \".\"; known decimals not broken", () => {
  const { sb } = runClient(() => undefined);
  const out = sb.fmtUi("12345", null);
  assert.ok(!out.includes("."), "the dot from slice(0, -null) is not rendered");
  assert.ok(out.includes("12345"), "the raw base units are visible");
  assert.ok(out.includes("base units") && out.includes("decimals unknown"), "the honesty note");
  assert.equal(sb.fmtUi("12345", 4), "1.2345");
  assert.equal(sb.fmtUi("12345", 8), "0.00012345");
  assert.equal(sb.fmtUi("0", 8), "0.00000000");
  assert.equal(sb.fmtUi("-100", 2), "-1.00");
});

test("calc: decimals null — an honest note, the computation does not pretend to be 0-decimal", async () => {
  let multiplierCalls = 0;
  const { sb, els } = runClient((url) => {
    if (url.startsWith("/health")) return { ok: true, status: 200, body: { tokens: 1, events: 0, journal: null } };
    if (url.startsWith("/summary")) return { ok: true, status: 200, body: [
      { symbol: "NULLD", name: "Token with null decimals", issuer: "Backed", mint: ADDR_A, decimals: null, events: 0, currentMultiplier: "1" },
    ] };
    if (url.startsWith("/multiplier")) { multiplierCalls++; return undefined; } // we hang, but count the calls
    return undefined;
  });
  await flush(); // the boot itself picked the only token and called calc
  assert.ok(els.get("calc-out").innerHTML.includes("decimals unknown for this token"), "the note after the boot calc");
  els.get("raw-in").value = "2.5";
  sb.calc();
  assert.ok(els.get("calc-out").innerHTML.includes("decimals unknown for this token"), "the note after a manual calc");
  assert.ok(els.get("calc-out").innerHTML.includes("2.5"), "the input shown as is");
  assert.ok(!els.get("calc-out").innerHTML.includes("multiplier at"), "no computation with invented decimals");
  assert.equal(multiplierCalls, 0, "the /multiplier endpoint is not hit with an invented-raw");
});

// ---- round 7: the logo — an inline mark in the header, self-sufficiency like the page's ----

test("the logo: the Lotwise mark in the header — a self-sufficient inline SVG (viewBox, no external links or scripts)", () => {
  const html = renderPage();
  const m = html.match(/<svg class="brand-mark"[\s\S]*?<\/svg>/);
  assert.ok(m, "the inline mark with the brand-mark class is present");
  const svg = m[0];
  assert.ok(svg.includes("viewBox="), "viewBox is mandatory");
  assert.ok(!/\b(src|href)\s*=/i.test(svg), "no src/href — the mark does not link anywhere");
  assert.ok(!/<script/i.test(svg) && !/javascript:/i.test(svg), "no scripts");
  assert.ok(!/url\(/i.test(svg), "no url() — no external loads");
  // Round 18: the mark moved to the "L" monogram (the same geometry as the favicon and
  // README): the trunk-axis + the accent leg + the event dot; 2 rects instead of a stack of bars
  assert.equal((svg.match(/<rect\b/g) || []).length, 2, "the L monogram: the trunk and the accent leg");
  assert.ok(/<circle/.test(svg), "the event dot on the trunk");
  assert.ok(svg.includes("accent"), "the lot leg is marked with the accent class");
  assert.ok(html.indexOf("brand-mark") < html.indexOf("<h1"), "the mark stands in the header, before the title");
});

// ---- round 8: the dividend verdicts of the cross-check in the token timeline ----
// /crosscheck serves verdicts in blocks (the contract of src/events/crosscheck.mjs): first all
// MULTIPLIER_CHANGE in event order, then DIVIDEND_ACCRUAL with a type label at the tail.
// The dividend badge — its own "dividend: …" signature (distinguishable from the rebase "price: …"),
// the colors — the same class set by verdict; the drop fractions — compactly in the tooltip.

const MULT_EV = {
  effectiveDate: "2026-06-18T04:00:00.000Z", type: "MULTIPLIER_CHANGE",
  multiplierFrom: "1", multiplierTo: "1.0015", reason: "rebase",
};
const DIV_EV = {
  effectiveDate: "2026-06-10T00:00:00.000Z", type: "DIVIDEND_ACCRUAL",
  amountPerUnitRaw: 2_000_000, decimals: 6,
};
const MULT_VERDICT = { effectiveDate: MULT_EV.effectiveDate, verdict: "consistent", note: "n-mult" };
const DIV_VERDICT = {
  type: "DIVIDEND_ACCRUAL", effectiveDate: DIV_EV.effectiveDate, verdict: "consistent",
  expectedDropFraction: 0.02, observedDropFraction: 0.02, note: "n-div",
};

const bootTimeline = (events, verdicts) => runClient((url) => {
  if (url.startsWith("/health")) return { ok: true, status: 200, body: { tokens: 1, events: events.length, journal: null } };
  if (url.startsWith("/summary")) return { ok: true, status: 200, body: [
    { symbol: "ONE", name: "Token One", issuer: "Backed", mint: "A".repeat(32), decimals: 6, events: events.length, currentMultiplier: "1.0015" },
  ] };
  if (url.startsWith("/events?symbol=ONE")) return { ok: true, status: 200, body: events };
  if (url.startsWith("/crosscheck?symbol=ONE")) return { ok: true, status: 200, body: { verdicts, coverage: {} } };
  return undefined;
});

const rowOf = (html, frag) => html.split("<li>").find((s) => s.includes(frag)) ?? "";

test("a dividend verdict — the dividend badge on its own line, the rebase price-badge next to it, the block order not mixed up", async () => {
  // the events in /events go by dates (the dividend earlier), the verdicts — in blocks by contract:
  // the rebase first, the dividend at the tail; the join must converge by (type, seq)
  const { els } = bootTimeline([DIV_EV, MULT_EV], [MULT_VERDICT, DIV_VERDICT]);
  await flush(); // boot: /health → /summary → select(ONE) → events + cross-check
  const html = els.get("events").innerHTML;
  const divRow = rowOf(html, "dividend accrual");
  const multRow = rowOf(html, "rebase");
  assert.ok(divRow.includes("dividend: consistent"), "the dividend verdict renders with its dividend signature");
  assert.ok(divRow.includes("verdict ok"), "the consistent color — the same ok class");
  assert.ok(divRow.includes("2.000000 per unit"), "the dividend row shows the accrual, not from → to");
  assert.ok(!divRow.includes("&rarr;"), "the dividend is not mixed with a multiplier event");
  assert.ok(divRow.includes("expected -2.000% vs observed -2.000%"), "the drop fractions compactly in the tooltip");
  assert.ok(divRow.includes("n-div"), "the verdict note is available in the tooltip");
  assert.ok(multRow.includes("price: consistent"), "the rebase badge did not lose the former signature");
  assert.ok(multRow.includes("&rarr;"), "the rebase is still a from → to row");
  assert.ok(html.includes("dividend: consistent") && html.includes("price: consistent"),
    "the verdicts of both types coexist in one timeline");
});

test("the join is not mixed up: a rebase and a dividend on one day — each gets its own verdict (a type prefix in the key)", async () => {
  const M2 = { ...MULT_EV, effectiveDate: DIV_EV.effectiveDate, multiplierFrom: "1.0015", multiplierTo: "1.002", reason: "second rebase" };
  const V_M1 = { effectiveDate: "2026-06-01T04:00:00.000Z", verdict: "consistent", note: "n1" };
  const V_M2 = { effectiveDate: DIV_EV.effectiveDate, verdict: "mismatch", note: "n2" };
  const V_D = { type: "DIVIDEND_ACCRUAL", effectiveDate: DIV_EV.effectiveDate, verdict: "suspicious", note: "n3" };
  // the event order: M1, D, M2 (by date D and M2 coincide); the verdicts — in blocks: [M1, M2, D]
  const { els } = bootTimeline(
    [{ ...MULT_EV, effectiveDate: "2026-06-01T04:00:00.000Z", reason: "first rebase" }, DIV_EV, M2],
    [V_M1, V_M2, V_D],
  );
  await flush();
  const html = els.get("events").innerHTML;
  const first = rowOf(html, "first rebase");
  const second = rowOf(html, "second rebase");
  const div = rowOf(html, "dividend accrual");
  assert.ok(first.includes("price: consistent"), "the first rebase — its own verdict");
  assert.ok(second.includes("price: mismatch"), "the second rebase (index 1 of the block) — its own verdict, not the dividend one");
  assert.ok(div.includes("dividend: suspicious"), "the dividend from the verdict tail — its own badge");
  assert.ok(!second.includes("dividend:"), "the dividend verdict did not stick to the rebase on the same day");
  assert.ok(!div.includes("price:"), "the rebase verdict did not stick to the dividend on the same day");
});

test("a dividend without a price history — dividend: no data, a tooltip without \"expected null\" and without NaN", async () => {
  const NO_DATA = {
    type: "DIVIDEND_ACCRUAL", effectiveDate: DIV_EV.effectiveDate, verdict: "no-price-data",
    expectedDropFraction: null, observedDropFraction: null,
    note: "candles do not reach back to the event date",
  };
  const { els } = bootTimeline([DIV_EV], [NO_DATA]);
  await flush();
  const div = rowOf(els.get("events").innerHTML, "dividend accrual");
  assert.ok(div.includes("dividend: no data"), "no-price-data renders with the dividend signature");
  assert.ok(div.includes("verdict unavailable"), "the unavailable class, like the rebase no-price-data");
  assert.ok(!div.includes("expected null") && !div.includes("NaN"), "non-numeric fractions are not substituted into the tooltip");
  assert.ok(div.includes("candles do not reach back"), "the reason from note is visible in the tooltip");
});

// ---- round 19 (wave J): live filter over the Tracked tokens table ----
// round 19: EN — a filter input (#token-filter) above the table; a live oninput handler
// hides #tokens rows whose symbol+name does not contain the substring (case-insensitive).

test("the page: #token-filter above the token table, the client script attaches a live oninput filter", () => {
  const html = renderPage();
  assert.ok(html.includes('id="token-filter"'), "the filter input is rendered");
  assert.ok(html.includes('placeholder="Filter by symbol or name"'), "the placeholder names what is filtered");
  assert.ok(html.indexOf("token-filter") < html.indexOf("<table"), "the filter stands ABOVE the table");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.ok(script.includes("token-filter"), "the client script references the filter");
  assert.match(script, /el\('token-filter'\)\.oninput = /, "the filter — a live oninput handler, without a button");
  // round 19: the filter must not break the existing page contracts
  assert.ok(script.includes("data-symbol"), "the rows still carry data-symbol (onclick/select)");
});

test("vm: the filter hides #tokens rows without the substring in symbol+name (case-insensitive), an empty input shows all", () => {
  // a mini-DOM: two rendered rows; querySelectorAll serves them (unlike the common harness)
  const mkRow = (sym, name) => ({
    attrs: { "data-symbol": sym },
    children: [{ textContent: sym }, { textContent: name }],
    style: {},
    getAttribute(n) { return this.attrs[n] ?? null; },
  });
  const spy = mkRow("SPYx", "S&P 500 Depositary Shares");
  const ko = mkRow("KOx", "Coca-Cola Co");
  const els = new Map();
  const makeEl = (id) => ({
    id, value: "", innerHTML: "", textContent: "", className: "", style: {}, attrs: {},
    getAttribute(n) { return this.attrs[n] ?? null; },
    scrollIntoView() {},
  });
  const sb = {
    document: {
      getElementById: (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
      querySelectorAll: (sel) => (sel === "#tokens tr" ? [spy, ko] : []),
    },
    fetch: () => new Promise(() => {}), // the boot chains hang: the filter needs no network
  };
  vm.createContext(sb);
  const m = renderPage().match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, "script block is in place");
  new vm.Script(m[1], { filename: "page-client.js" }).runInContext(sb);
  const input = els.get("token-filter");
  assert.equal(typeof input.oninput, "function", "the filter handler is assigned to the input");

  input.value = "spy"; // by symbol, in another case
  input.oninput();
  assert.equal(spy.style.display, "", "a match by symbol — the row is visible");
  assert.equal(ko.style.display, "none", "no match — the row is hidden");

  input.value = "coca"; // by name, not by symbol
  input.oninput();
  assert.equal(spy.style.display, "none", "SPYx does not match by KOx's name");
  assert.equal(ko.style.display, "", "KOx found by name");

  input.value = ""; // clearing returns all rows
  input.oninput();
  assert.equal(spy.style.display, "", "an empty filter — all rows visible");
  assert.equal(ko.style.display, "", "an empty filter — all rows visible");
});

// ---- round 20: mutation pins — the wave-I1 UX contracts and the esc round-trip ----
// The round-20 mutation audit: mE (a frozen scan timer), mF (a re-clickable Scan button)
// and mG (rate-limit no longer classified) each survived the whole suite, as did mI
// (deleting the '&' rule of esc). These tests pin the contracts behind those lines.

test("esc: the full escape table is pinned — the & rule carries the data-symbol round-trip", () => {
  const els = new Map();
  const makeEl = (id) => ({
    id, value: "", innerHTML: "", textContent: "", className: "", style: {}, attrs: {},
    getAttribute(n) { return this.attrs[n] ?? null; }, scrollIntoView() {},
  });
  const sb = {
    document: {
      getElementById: (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
      querySelectorAll: () => [],
    },
    fetch: () => new Promise(() => {}), // the boot chains hang; esc/renderTokens need no network
  };
  vm.createContext(sb);
  const m = renderPage().match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, "script block is in place");
  new vm.Script(m[1], { filename: "page-client.js" }).runInContext(sb);

  // (a) every rule of the table is load-bearing on its own (the mI mutation removed '&')
  assert.equal(sb.esc("&"), "&amp;");
  assert.equal(sb.esc("<"), "&lt;");
  assert.equal(sb.esc(">"), "&gt;");
  assert.equal(sb.esc('"'), "&quot;");
  assert.equal(sb.esc("'"), "&#39;");

  // (b) the invariant the table protects: a registry symbol may itself LOOK like an
  // entity ('A&amp;B' passes validateRegistryEntry) — the rendered attribute must decode
  // back to the exact symbol, or the row onclick selects nothing (a silent no-op).
  const decodeAttr = (v) => v.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" }[e]));
  for (const hostile of ["A&amp;B", "S&P 500", '<x>"\'', "SPYx"]) {
    sb.renderTokens([{ symbol: hostile, name: "row", issuer: "Backed", events: 1, currentMultiplier: "1" }]);
    const attr = els.get("tokens").innerHTML.match(/data-symbol="([^"]*)"/)[1];
    assert.equal(decodeAttr(attr), hostile, `the attribute round-trips the symbol ${JSON.stringify(hostile)}`);
  }
});

// A harness variant with a fake clock and a capturable setInterval: the scan timer
// logic lives inside the interval callback, invisible to the plain runClient harness.
function runScanClient(route) {
  const els = new Map();
  const makeEl = (id) => ({
    id, value: "", innerHTML: "", textContent: "", className: "", style: {}, attrs: {},
    getAttribute(n) { return this.attrs[n] ?? null; }, scrollIntoView() {},
  });
  const timers = { ticks: [], cleared: 0 };
  let now = 1_000_000;
  const FakeDate = Object.assign(function () { return { toISOString: () => "2026-09-25T00:00:00.000Z" }; }, {});
  FakeDate.now = () => now;
  const sb = {
    document: {
      getElementById: (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
      querySelectorAll: () => [],
    },
    fetch: (url) => {
      const hit = route(url);
      const p = hit instanceof Promise ? hit : Promise.resolve(hit);
      return p.then((res) => res === undefined
        ? new Promise(() => {})
        : { ok: res.ok, status: res.status, json: async () => res.body });
    },
    setInterval: (fn, ms) => { timers.ticks.push({ fn, ms }); return timers.ticks.length; },
    clearInterval: () => { timers.cleared += 1; },
    Date: FakeDate,
  };
  vm.createContext(sb);
  const m = renderPage().match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, "script block is in place");
  new vm.Script(m[1], { filename: "page-client.js" }).runInContext(sb);
  return { sb, els, timers, advance: (ms) => { now += ms; } };
}

test("scan UX: the button dims and an honest elapsed timer ticks real seconds (mE/mF pins)", async () => {
  let resolve;
  const slow = new Promise((r) => { resolve = r; }); // the chain scan "takes a while"
  const { sb, els, timers, advance } = runScanClient((url) => url.startsWith("/lots?") ? slow : undefined);
  els.get("addr-in").value = ADDR_A;
  sb.scanWalletUi();

  assert.equal(els.get("scan-btn").disabled, true, "the button is disabled while the scan runs");
  assert.ok(els.get("wallet-out").innerHTML.includes('id="scan-elapsed"'), "an elapsed placeholder is visible from second zero");
  assert.equal(timers.ticks.length, 1, "a single interval drives the timer");

  advance(3000); // three seconds of wall-clock pass
  timers.ticks[0].fn();
  assert.equal(els.get("scan-elapsed").textContent, "3s", "the label shows the real elapsed seconds, not a frozen 0s");

  resolve({ ok: true, status: 200, body: repA });
  await flush();
  assert.equal(els.get("scan-btn").disabled, false, "the button re-enables after the scan");
  assert.equal(timers.cleared, 1, "the interval is cleared on finish");
  assert.ok(els.get("wallet-out").innerHTML.includes(ADDR_A), "the report replaced the scanning note");
});

test("scan UX: a 429 without a kind — the human rate-limit sentence, the original in the tooltip (mG pin)", async () => {
  const { sb, els, timers } = runScanClient((url) => url.startsWith("/lots?")
    ? { ok: false, status: 429, body: { error: "HTTP 429 — too many requests" } }
    : undefined);
  els.get("addr-in").value = ADDR_A;
  sb.scanWalletUi();
  await flush();
  const html = els.get("wallet-out").innerHTML;
  assert.ok(html.includes("Rate limit reached"), "the human phrase for the rate-limit class (no kind field — the regexp arm decides)");
  assert.ok(html.includes('title="HTTP 429'), "the original message is kept in the tooltip");
  assert.ok(!html.includes("undefined"), "no garbage leaked into the note");
  assert.equal(els.get("scan-btn").disabled, false, "the button re-enabled after the failure");
  assert.equal(timers.cleared, 1, "the timer stopped");
});

test("scan UX: a network failure (a fetch reject) — the unreachable sentence, not a bare stack", async () => {
  const { sb, els } = runScanClient((url) => url.startsWith("/lots?")
    ? Promise.reject(new Error("fetch failed"))
    : undefined);
  els.get("addr-in").value = ADDR_A;
  sb.scanWalletUi();
  await flush();
  const html = els.get("wallet-out").innerHTML;
  assert.ok(html.includes("Solana RPC is unreachable"), "the human phrase for the network class");
  assert.ok(html.includes("fetch failed"), "the original error kept in the tooltip");
});
