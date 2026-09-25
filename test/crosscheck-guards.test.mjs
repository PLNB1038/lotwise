
// regression tests — hardening fixes. Groups: crosscheck finiteness (B1-1/B1-2),
// ratio ceilings (B1-3), partial rateLimits (B2-2), flags host/rpc sanity (B3-1),
// the lock writeSync (B3-3), esc stats (B4-1), saveFailed in /health (B4-2),
// the xstocks Array guard (B1-latent), scan abort propagation (B2-1).
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { crossCheckMultiplierChange, crossCheckDividendAccrual, crossCheckEvents, CrossCheckError } from "../src/events/crosscheck.mjs";
import { validateEvent } from "../src/schema/events.mjs";
import { multiplierHistoryToEvents } from "../src/events/normalize-xstocks.mjs";
import { parseServeArgs } from "../src/cli/flags.mjs";
import { withStoreLock } from "../src/webhooks/subscriptions.mjs";
import { scanWallet } from "../src/wallet/scan.mjs";
import { createApiServer } from "../src/api/server.mjs";
import { renderPage } from "../src/ui/page.mjs";
import { loadRegistry } from "../src/registry/registry.mjs";

const OWNER = "Wa11etBuyer" + "a".repeat(32);
const SPYx = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const REGISTRY = [{ mint: SPYx, symbol: "SPYx", name: "SPY", issuer: "backed", decimals: 8 }];
const sig = (n) => ({ signature: "s".repeat(43) + String(n), slot: n, blockTime: 1750000000 + n, err: null });

const candlesOf = (...cs) => cs.map(([day, c]) => ({ ts: Date.UTC(2026, 5, day) / 1000, c }));
const multEv = () => ({
  type: "MULTIPLIER_CHANGE", mint: SPYx, effectiveDate: "2026-06-18T00:00:00.000Z",
  status: "confirmed", sources: ["test"], multiplierFrom: "1", multiplierTo: "2", reason: "Rebase",
});
const divEv = () => ({
  type: "DIVIDEND_ACCRUAL", mint: SPYx, effectiveDate: "2026-06-18T00:00:00.000Z",
  status: "confirmed", sources: ["test"], amountPerUnitRaw: 2_000_000, decimals: 8,
});

// ---- B1-1: non-numeric closes do not pass the <= 0 guards ----

test("crosscheck: NaN/Infinity/undefined close — an honest inconclusive/error, not a \"mismatch\" with null fields", () => {
  for (const bad of [NaN, undefined, Infinity, "abc"]) {
    const v = crossCheckMultiplierChange(multEv(), candlesOf([16, 100], [17, 100], [18, bad]));
    assert.equal(v.verdict, "inconclusive", `close=${bad}: the verdict must not be built on a non-numeric close`);
    assert.equal(v.observedRatio, null);
    const d = crossCheckDividendAccrual(divEv(), candlesOf([16, 10000000], [17, 10000000], [18, bad]));
    assert.equal(d.verdict, "inconclusive", `dividend close=${bad}`);
    assert.equal(d.observedDropFraction, null);
  }
});

// ---- B1-2: coverage on a garbage candle ts ----

test("crosscheck: a garbage candle ts — an honest error/no data, not a RangeError → 500", () => {
  const bad = [{ ts: NaN, c: 1 }];
  assert.throws(() => crossCheckEvents([multEv()], bad), CrossCheckError);
  // a numeric-string ts — coerced like everywhere in the date pipeline
  const ok = crossCheckEvents([multEv()], candlesOf([16, 100], [18, 50]));
  assert.ok(Array.isArray(ok.verdicts) && ok.verdicts.length === 1);
});

// ---- B1-3: the SPLIT/MERGER ratio ceilings ----

test("schema: a SPLIT/MERGER ratio above MAX_SAFE_INTEGER — refused, like amountPerUnitRaw (R9 #14)", () => {
  const tooBig = 2 ** 53 + 1;
  assert.throws(() => validateEvent({
    type: "SPLIT", mint: SPYx, effectiveDate: "2026-10-01T00:00:00.000Z", status: "confirmed",
    sources: ["test"], ratioNumerator: tooBig, ratioDenominator: 1,
  }), (err) => err.name === "EventValidationError" && /ratioNumerator|safe/i.test(err.message));
  assert.throws(() => validateEvent({
    type: "MERGER", mint: SPYx, effectiveDate: "2026-10-01T00:00:00.000Z", status: "confirmed",
    sources: ["test"], newMint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
    exchangeNumerator: tooBig, exchangeDenominator: 1,
  }), (err) => err.name === "EventValidationError" && /exchangeNumerator|safe/i.test(err.message));
});

// ---- B2-2: a partial rateLimits configuration ----

test("api: rateLimits missing one of the keys — a clear refusal, not a TypeError from destructuring", async () => {
  const registry = await loadRegistry("data/tokens.json");
  for (const partial of [{}, { scan: { windowMs: 60_000, max: 5 } }, { rpc: { windowMs: 60_000, max: 5 } }]) {
    // createApiServer is not async: the throw may be synchronous — we normalize both cases
    let err = null;
    try {
      const srv = await createApiServer({ registry, events: [], rateLimits: partial });
      srv.close();
    } catch (e) { err = e; }
    assert.ok(err, `the configuration ${JSON.stringify(partial)} must be refused`);
    assert.match(err.message, /rateLimits/i);
  }
});

// ---- B3-1: flags — a host with a space, rpc sanity ----

test("flags: --host with a space/empty-after-trim — a refusal BEFORE boot; rpc must parse into an http(s) URL", () => {
  assert.throws(() => parseServeArgs(["--host", " "]), /host/);
  assert.throws(() => parseServeArgs(["--host", "not a host"]), /host/);
  assert.throws(() => parseServeArgs(["--rpc", "not a url"]), /rpc/);
  assert.throws(() => parseServeArgs(["--rpc", "ftp://x.example"]), /rpc/);
  assert.equal(parseServeArgs(["--rpc", "https://api.example/v1?k=1"]).rpcUrl, "https://api.example/v1?k=1");
  assert.equal(parseServeArgs([]).host, "127.0.0.1");
});

// ---- B3-3: the lock — a writeSync failure does not leave an empty lock ----

test("lock: a failure writing the lock content — the lock is released, not resurrecting the TOCTOU with an empty file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lw-lock-r10-"));
  try {
    const store = path.join(dir, "webhooks.json");
    const failingWrite = () => { throw new Error("ENOSPC"); };
    assert.throws(
      () => withStoreLock(store, () => "never", { writeSync: failingWrite, attempts: 3, retryPauseMs: 1 }),
      /ENOSPC/,
    );
    assert.ok(!exists(store + ".lock"), "the lock is released — the next process will not see an empty file as legacy");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function exists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

// ---- B4-1: esc in renderStats ----

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
    fetch: () => new Promise(() => {}),
  };
  vm.createContext(sb);
  const m = renderPage().match(/<script>([\s\S]*?)<\/script>/);
  new vm.Script(m[1], { filename: "page-client.js" }).runInContext(sb);
  return { sb, els };
}

test("vitrine: journal.unavailable and excluded.length from /health — a string injection does not live", () => {
  const { sb, els } = runClient();
  // a string-instead-of-number: the numeric gate (> 0) hides it itself, esc() is the second echelon
  sb.renderStats({ tokens: 31, events: 56, journal: { unavailable: "<script>alert(4)</script>" }, excluded: { length: "<script>alert(5)</script>" } }, []);
  const html = els.get("stats").innerHTML;
  assert.ok(!html.includes("<script>"), "an injection through health fields does not survive");
  // numbers by contract render as before (the gate lets them through, esc() is harmless)
  const { sb: sb2, els: els2 } = runClient();
  sb2.renderStats({ tokens: 31, events: 56, journal: { unavailable: 2 }, excluded: { length: 1 } }, []);
  assert.ok(els2.get("stats").innerHTML.includes("2"), "numeric warn fields are still visible");
});

// ---- B4-2: saveFailed in /health ----

test("/health: an unsaved boot journal is visible via the journal.saveFailed flag", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const server = await createApiServer({
    registry, events: [],
    journalStats: { replayed: 2, unavailable: 0, corrupted: 0, preserveFailed: 0, saveFailed: 1 },
  });
  const { port } = server.address();
  try {
    const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(h.journal.saveFailed, 1, "the boot events are memory-only — monitoring must see it");
  } finally {
    server.close();
  }
});

// ---- B1-latent: the Array guard of multiplierHistoryToEvents ----

test("xstocks: a non-array history — NormalizeError, not a bare TypeError", () => {
  for (const bad of [null, undefined, "x", { nodes: "x" }]) {
    assert.throws(() => multiplierHistoryToEvents(bad, { symbol: "TESTx" }), (err) => /history|array|nodes/i.test(err.message));
  }
});

// ---- B2-1: scan abort propagation ----

test("scan: a signal aborts the scan between pages — the RPC quota is not burned after the client leaves", async () => {
  const ac = new AbortController();
  let calls = 0;
  const client = {
    async call(method, params) {
      if (method === "getTokenAccountsByOwner") return { value: [] };
      if (method === "getTransaction") return null;
      if (method === "getSignaturesForAddress") {
        calls++;
        if (calls >= 3) ac.abort(); // the client left on the third page of an endless history
        return [sig(calls), sig(calls + 1000)];
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  await assert.rejects(
    () => scanWallet(client, OWNER, REGISTRY, { limit: 2, maxTxs: 10_000, signal: ac.signal }),
    (err) => /abort/i.test(err.message),
  );
  assert.ok(calls <= 4, `the scan stopped when the client left (calls=${calls}), not burning through the history`);
}, { timeout: 5000 });
