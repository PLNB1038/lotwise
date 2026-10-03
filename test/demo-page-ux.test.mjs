// The demo boot's page-level honesty, pinned where a reviewer would trip on it:
//   - the "Planes reconcile" card used to render the mode's not-configured 503 as a red
//     "unavailable — fail-closed, not guessing" over EVERY demo token. On a --demo boot the
//     missing chain reader is the mode, not a failure, and a demo token has no live chain
//     even in principle — the card now renders a neutral "skipped in demo", while a live
//     boot with an unreachable chain keeps the honest refusal;
//   - the wallet form read as functional on a demo boot while every scan answers 503 — the
//     demo render now says so next to the form ("wallet scans are off on this instance");
//   - the registry decimals follow the issuer families the README teaches (9 PreStocks/
//     Tessera, 6 Backpack): DEMOx is tessera, so its decimals — and its dividend amounts'
//     own decimals field, which must agree — move to 9.
// The client learns the mode from a server-rendered IS_DEMO flag, not from /health: the
// banner is that fact's single source and the flag cannot disagree with it.
import test from "node:test";
import assert from "node:assert/strict";
import { renderPage } from "../src/ui/page.mjs";
import { buildDemoSnapshot } from "../src/events/demo-snapshot.mjs";
import vm from "node:vm";

// The api-page-contract.test.mjs harness, narrowed to one call path: no boot chain
// (querySelectorAll → [], /health hangs), the handler under test is invoked directly.
// renderOpts selects the render — the demo branch is the point of this file.
function runClient(renderOpts, route) {
  const els = new Map();
  const makeEl = (id) => ({
    id, value: '', innerHTML: '', textContent: '', className: '', style: {},
    getAttribute() { return null; },
    scrollIntoView() {},
  });
  const sb = {
    document: {
      getElementById: (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
      querySelectorAll: () => [],
      addEventListener: () => {}, // the page wires delegated tap-tooltips at load
    },
    fetch: (url) => {
      const hit = route(url);
      return Promise.resolve(hit === undefined
        ? new Promise(() => {}) // a request this test does not stub hangs, as in the browser
        : { ok: hit.ok, status: hit.status, json: async () => hit.body });
    },
  };
  vm.createContext(sb);
  const m = renderPage(renderOpts).match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, "script block is in place");
  new vm.Script(m[1], { filename: "page-client.js" }).runInContext(sb); // syntax as in the browser
  return { sb, els };
}

const flush = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };

const ONCHAIN_503 = {
  error: "the demo instance serves a static snapshot and does not read the chain — boot without --demo for the live feed",
  kind: "not-configured",
};

test("demo page: the reconcile card renders 'skipped in demo', not the red unavailable", async () => {
  const { sb, els } = runClient({ demo: true }, (url) =>
    url.startsWith("/onchain") ? { ok: false, status: 503, body: ONCHAIN_503 } : undefined);
  const t = { symbol: "DEMOx" };
  sb.state.selected = t;
  sb.loadPlanes(t);
  await flush();
  assert.equal(els.get("verdict").textContent, "skipped in demo", "the mode, not a broken source");
  assert.equal(els.get("verdict").className, "verdict neutral", "the neutral badge, not the warn-colored refusal");
  const card = els.get("planes").innerHTML;
  assert.match(card, /skipped in demo — reconcile needs the live chain/);
  assert.ok(!card.includes("fail-closed"), "the live-boot refusal copy does not land on the demo card");
});

test("live page: the same 503 keeps 'unavailable — fail-closed, not guessing'", async () => {
  const { sb, els } = runClient({}, (url) =>
    url.startsWith("/onchain") ? { ok: false, status: 503, body: ONCHAIN_503 } : undefined);
  const t = { symbol: "SPYx" };
  sb.state.selected = t;
  sb.loadPlanes(t);
  await flush();
  assert.equal(els.get("verdict").textContent, "unavailable", "the demo skip does not leak into the live render");
  assert.match(els.get("planes").innerHTML, /fail-closed, not guessing/);
});

test("the client demo flag is server-rendered from the boot flag, not derived at runtime", () => {
  assert.match(renderPage({ demo: true }), /var IS_DEMO = true;/);
  assert.match(renderPage(), /var IS_DEMO = false;/, "the default render stays byte-shaped as before");
});

test("demo page: the wallet note names scans off; the live page's note stays as it was", () => {
  assert.match(renderPage({ demo: true }), /Wallet scans are off on this instance/);
  assert.equal(renderPage().includes("Wallet scans are off on this instance"), false,
    "a live boot scans wallets — the caveat must not survive there");
});

test("demo registry decimals follow the issuer families, and the dividend amounts agree", () => {
  const { registry, events } = buildDemoSnapshot();
  const demo = registry.find((t) => t.symbol === "DEMOx");
  const demo2 = registry.find((t) => t.symbol === "DEMO2x");
  assert.equal(demo.issuer, "tessera");
  assert.equal(demo.decimals, 9, "DEMOx: the tessera family's 9 (the README's decimals lesson)");
  assert.equal(demo2.issuer, "backpack");
  assert.equal(demo2.decimals, 6, "DEMO2x: the backpack family's 6");
  // the dividends ride the same base: 2_000_000_000 / 1e9 = 2.00 per unit — the money the
  // reason string names, at the event's own decimals field, not just the registry's
  for (const e of events.filter((e) => e.type === "DIVIDEND_ACCRUAL" && e.mint === demo.mint)) {
    assert.equal(e.decimals, 9);
    assert.ok([2_000_000_000, 2_500_000_000].includes(e.amountPerUnitRaw), "2.00 / 2.50 per unit at 9 decimals");
  }
});
