// formerly round12-wave-d.test.mjs
// Round 12 regression tests — wave D (vitrine states + CLI + data).
//   D1-1 [P2]: .catch of loadPlanes/calc without a stale guard — a foreign error lands
//              on top of the selected token (the reconcile badge = the flagship honesty element).
//   D1-2 [P3]: switching the token does not clear events/calc — data A under the header of B.
//   D1-3 [P3]: an intra-token calculator race (a stale response painted last).
//   D1-4 [P3]: a scan cache ≤10min shown as fresh; rep.now not rendered.
//   D1-5 [P3]: a boot without res.ok/Array.isArray → "undefined tokens tracked".
//   D2-1 [P2]: process.exit after fetch crashes the CLI on SUCCESS (the 0/1/2 contract).
//   D2-2 [P3]: an empty stdin = "an empty list" (no-op), not exit 2.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderPage } from "../src/ui/page.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPYx = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const TOKEN_A = { symbol: "AAA", name: "Token A", issuer: "Backed", mint: SPYx, decimals: 8, events: 2, currentMultiplier: "1" };
const TOKEN_B = { symbol: "BBB", name: "Token B", issuer: "Backed", mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", decimals: 8, events: 1, currentMultiplier: "1" };

// a vm harness with a routable fetch (controlled pending promises for races)
function runClient(routes) {
  const els = new Map();
  const makeEl = (id) => ({
    id, value: "", innerHTML: "", textContent: "", className: "", style: {},
    attrs: {}, getAttribute() { return null; }, scrollIntoView() {},
  });
  const sb = {
    document: {
      getElementById: (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
      querySelectorAll: () => [{ className: "", getAttribute() { return "AAA"; }, addEventListener() {} }],
    },
    fetch: (url) => {
      const hit = routes[String(url)];
      if (hit === undefined) return new Promise(() => {}); // we hang — irrelevant chains stay silent
      return hit instanceof Promise ? hit : Promise.resolve(hit);
    },
    console: { error() {}, warn() {} },
  };
  vm.createContext(sb);
  const m = renderPage().match(/<script>([\s\S]*?)<\/script>/);
  new vm.Script(m[1], { filename: "page-client.js" }).runInContext(sb);
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };
  return { sb, els, flush };
}

const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

// ---- D1-1 [P2]: the stale guard in .catch ----

test("vitrine: an error of a STALE /onchain request does not overwrite the badge of the new token", async () => {
  let rejectA;
  const hangingA = new Promise((_, rej) => { rejectA = rej; });
  const { sb, els, flush } = runClient({
    "/onchain?symbol=AAA": hangingA,
    "/onchain?symbol=BBB": json({ api: "1", onChain: { active: "1" }, onChainEffective: "1", verdict: "ok" }),
  });
  sb.state.tokens = [TOKEN_A, TOKEN_B]; // the boot usually fills this via /summary
  sb.renderTokens([TOKEN_A, TOKEN_B]);
  sb.select("AAA");
  await flush();
  sb.select("BBB");
  await flush();
  assert.match(els.get("verdict").textContent ?? "", /ok|agree/i, "B painted its own verdict");
  rejectA(new Error("fetch failed")); // A's response arrived with an error AFTER B was selected
  await flush();
  assert.match(els.get("verdict").textContent ?? "", /ok|agree/i, "A's error does NOT land on B's badge (the stale guard in catch)");
});

// ---- D1-2 [P3]: switching the token clears events/calc ----

test("vitrine: selecting a new token clears the event timeline and the calculator (pending placeholders)", async () => {
  const { sb, els, flush } = runClient({
    "/events?symbol=AAA": json([{ type: "MULTIPLIER_CHANGE", effectiveDate: "2026-06-10", reason: "A event" }]),
    "/crosscheck?symbol=AAA": json({ pool: null, coverage: { candles: 0 }, verdicts: [] }),
    "/events?symbol=BBB": new Promise(() => {}), // hangs — the race window
    "/crosscheck?symbol=BBB": new Promise(() => {}),
    "/onchain?symbol=AAA": json({ verdict: "ok", api: "1", onChain: { active: "1" }, onChainEffective: "1" }),
    "/onchain?symbol=BBB": new Promise(() => {}),
  });
  sb.state.tokens = [TOKEN_A, TOKEN_B]; // the boot usually fills this via /summary
  sb.renderTokens([TOKEN_A, TOKEN_B]);
  sb.select("AAA");
  await flush();
  assert.ok(els.get("events").innerHTML.includes("A event"), "A's events are painted");
  sb.select("BBB");
  await flush();
  assert.ok(!els.get("events").innerHTML.includes("A event"), "A's events do not hang under B's header");
  assert.ok(!els.get("calc-out").innerHTML.includes("adjusted"), "A's calculator does not hang under B");
});

// ---- D1-3 [P3]: the calculator epoch ----

test("vitrine: a stale calculator recompute is not repainted over the fresh one", async () => {
  const dynamic = runClientDynamic();
  dynamic.sb.state.tokens = [TOKEN_A];
  dynamic.sb.renderTokens([TOKEN_A]);
  dynamic.sb.select("AAA");
  await dynamic.flush();
  dynamic.els.get("raw-in").value = "1.5";
  dynamic.sb.calc();
  const slowIdx = dynamic.take(); // the first computation — hangs
  dynamic.els.get("raw-in").value = "9.9";
  dynamic.sb.calc();
  const fastIdx = dynamic.take(); // the second computation
  dynamic.resolveAt(fastIdx, { multiplier: "2", date: "2026-07-01T00:00:00.000Z", sampleScaledQty: { exact: true, whole: "1980000000", remainder: "0", den: "1" } });
  await dynamic.flush();
  assert.ok(dynamic.els.get("calc-out").innerHTML.includes("1980000000"), "the fresh computation (9.9) is painted");
  dynamic.resolveAt(slowIdx, { multiplier: "3", date: "2026-07-01T00:00:00.000Z", sampleScaledQty: { exact: true, whole: "450000000", remainder: "0", den: "1" } });
  await dynamic.flush();
  assert.ok(!dynamic.els.get("calc-out").innerHTML.includes("450000000"), "the stale response (1.5) did NOT repaint over 9.9");
});

function runClientDynamic() {
  const els = new Map();
  const makeEl = (id) => ({
    id, value: "", innerHTML: "", textContent: "", className: "", style: {},
    attrs: {}, getAttribute() { return null; }, scrollIntoView() {},
  });
  const pending = [];
  const sb = {
    document: {
      getElementById: (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
      querySelectorAll: () => [{ className: "", getAttribute() { return "AAA"; }, addEventListener() {} }],
    },
    fetch: (url) => {
      if (String(url).startsWith("/multiplier")) {
        // resolvers are stacked in request order; resolve by index
        return new Promise((resolve) => {
          pending.push((body) => resolve(json(body)));
        });
      }
      if (String(url).startsWith("/events")) return Promise.resolve(json([]));
      if (String(url).startsWith("/crosscheck")) return Promise.resolve(json({ pool: null, coverage: { candles: 0 }, verdicts: [] }));
      if (String(url).startsWith("/onchain")) return Promise.resolve(json({ verdict: "ok", api: "1", onChain: { active: "1" }, onChainEffective: "1" }));
      return Promise.resolve(json({ ok: true, status: 200 }));
    },
    console: { error() {}, warn() {} },
  };
  vm.createContext(sb);
  const m = renderPage().match(/<script>([\s\S]*?)<\/script>/);
  new vm.Script(m[1], { filename: "page-client.js" }).runInContext(sb);
  return {
    sb, els,
    take: () => pending.length - 1, // the resolver index of the last request
    resolveAt: (idx, body) => { if (typeof pending[idx] === "function") pending[idx](body); },
    flush: async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); },
  };
}

// ---- D1-4 [P3]: the freshness of the report ----

test("vitrine: the wallet report shows the server generation time (rep.now)", () => {
  const { sb, els } = (() => {
    const els = new Map();
    const makeEl = (id) => ({ id, value: "", innerHTML: "", textContent: "", className: "", style: {}, attrs: {}, getAttribute() { return null; }, scrollIntoView() {} });
    const sb = {
      document: { getElementById: (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); }, querySelectorAll: () => [] },
      fetch: () => new Promise(() => {}),
      console: { error() {}, warn() {} },
    };
    vm.createContext(sb);
    new vm.Script(renderPage().match(/<script>([\s\S]*?)<\/script>/)[1], { filename: "page-client.js" }).runInContext(sb);
    return { sb, els };
  })();
  sb.renderWallet({
    owner: "Wa11etBuyer" + "a".repeat(32),
    now: "2026-09-23T20:31:00.000Z",
    counts: { signatures: 5, fetched: 5, skipped: 0 }, truncated: false, complete: true, tokens: [],
  });
  assert.ok(els.get("wallet-out").innerHTML.includes("2026-09-23 20:31"), "the report generation time is visible (a cache ≤10min is distinguishable from a fresh scan; round 18: the date without the full ISO clutter)");
});

// ---- D1-5 [P3]: boot guards ----

test("vitrine: a boot on a 502-json /health — an honest unavailability, not \"undefined tokens tracked\"", async () => {
  const { els, flush } = runClient({
    "/health": json({ error: "bad gateway" }, false, 502),
    "/summary": json([{ ...TOKEN_A }]),
  });
  await flush();
  const stats = els.get("stats").innerHTML;
  assert.ok(!stats.includes("undefined"), "undefined is not rendered");
});

// ---- D2-1/D2-2: CLI ----

test("cli: webhook-deliver exits with the contract code, no undici crash of the process (wave D2)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lw-cli-r12-"));
  try {
    // a public URL: the delivery honestly fails (example.com will not accept a webhook),
    // the exit code contract = 1; BEFORE the fix process.exit over a live undici socket
    // crashed the process (0xC0000409/127 on win) even on SUCCESSFUL runs
    writeFileSync(path.join(dir, "subs.json"), JSON.stringify([
      { id: "wh_a", url: "https://example.com/hook", symbols: "*", secret: "s1", createdAt: "2026-09-23T00:00:00.000Z", active: true },
    ]));
    writeFileSync(path.join(dir, "events.json"), JSON.stringify([
      { type: "MULTIPLIER_CHANGE", mint: SPYx, effectiveDate: "2026-06-10T04:30:00.000Z", status: "confirmed", sources: ["test"], multiplierFrom: "1", multiplierTo: "5", reason: "Rebase" },
    ]));
    const res = spawnSync(process.execPath, [
      path.join(ROOT, "scripts", "webhook-deliver.mjs"),
      "--events", path.join(dir, "events.json"),
      "--subscriptions", path.join(dir, "subs.json"),
    ], { encoding: "utf8", timeout: 120_000 });
    assert.equal(res.status, 1, `the contract failure code = 1 (no crash; got ${res.status}, stderr: ${(res.stderr ?? "").slice(0, 200)})`);
    assert.ok(res.status !== 3221226505 && res.status !== 127, "the undici crash of the process did not happen");
    assert.match(res.stdout, /failed=1/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: an empty stdin of webhook-deliver — an honest no-op (exit 0), not \"events do not parse\"", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lw-cli2-r12-"));
  try {
    writeFileSync(path.join(dir, "subs.json"), JSON.stringify([
      { id: "wh_a", url: "https://example.com/hook", symbols: "*", secret: "s1", createdAt: "2026-09-23T00:00:00.000Z", active: true },
    ]));
    const res = spawnSync(process.execPath, [
      path.join(ROOT, "scripts", "webhook-deliver.mjs"),
      "--subscriptions", path.join(dir, "subs.json"),
    ], { input: "", encoding: "utf8", timeout: 30_000 });
    assert.equal(res.status, 0, `an empty list = no-op (stderr: ${res.stderr?.slice(0, 200)})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
