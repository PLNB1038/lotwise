// The drain serves what it ADMITTED, not what still knocks. server.close() stops the
// listener, but a request can still arrive on a keep-alive socket that survived
// closeIdleConnections (a connection busy with the in-flight scan at shutdown time is
// not idle). Before the admission gate such a late request started a NEW scan nobody
// waits for — the drain had already resolved, and serve.mjs's 200ms exit grace killed
// it mid-RPC (the client saw a bare reset). Now shutdown() admits no new work: a request
// entering after it begins gets the typed 503 kind "shutting-down", and everything that
// entered before keeps the service it was promised.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createApiServer } from "../src/api/server.mjs";

const OWNER = "9BB7Tt5uW5QbAorLkF3Hn1P2mGcXvcDdR7y8LbT9KdUu"; // valid base58, not in the registry
const MINT = "DrainMint" + "1".repeat(35); // valid base58, keeps /accruals' symbol resolvable
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TOKEN = { mint: MINT, symbol: "PLx", name: "Plausible Token", decimals: 6, issuer: "tessera" };

const emptyScan = { owner: OWNER, signatures: 1, fetched: 1, skipped: [], truncated: false, accounts: new Map(), txs: [] };

// Counting gate-mock: the first call holds the slot until released; any further call is
// recorded — a second entry after shutdown began is exactly the leak this file pins.
function countingScanner() {
  let enteredCb = null;
  let releaseCb = null;
  const calls = [];
  const scanner = (address) => {
    calls.push(address);
    enteredCb?.();
    if (calls.length === 1) {
      return new Promise((resolve) => { releaseCb = () => resolve(emptyScan); });
    }
    return new Promise(() => {}); // a late scan would hang here and hold the suite — visible, not silent
  };
  return { scanner, calls, entered: () => new Promise((res) => { enteredCb = res; }), release: () => releaseCb?.() };
}

// One keep-alive connection, driven by hand: fetch() pools opaquely, the agent makes the
// socket reuse explicit — request B provably rides the same connection A opened.
function get(agent, base, path) {
  return new Promise((resolve) => {
    const req = http.get(`${base}${path}`, { agent }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", (err) => resolve({ error: err.code ?? err.message }));
  });
}

test("a request entering on a surviving keep-alive socket after the drain gets 503 shutting-down, not a new scan", async () => {
  const gate = countingScanner();
  const server = await createApiServer({ registry: [], events: [], walletScanner: gate.scanner });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const agent = new http.Agent({ keepAlive: true });
  try {
    // the in-flight scan holds the slot when shutdown() runs — its connection survives
    // closeIdleConnections (it is NOT idle) and carries the next request after the drain
    const first = get(agent, base, `/lots?address=${OWNER}`);
    await gate.entered();
    const draining = server.shutdown({ drainMs: 5000 });
    gate.release(); // the scan settles inside the window: the drain resolves on it, the 200 goes out
    await draining;
    assert.equal((await first).status, 200, "the admitted scan keeps its answer through the drain");

    // the drain is OVER: nothing may start work anymore — serve.mjs exits 200ms from here
    const second = await Promise.race([
      get(agent, base, `/lots?address=${OWNER}`),
      sleep(2_000).then(() => null),
    ]);
    assert.ok(second, "the late request got no answer at all (it started a scan nobody waits for)");
    assert.equal(second.status, 503, "the drain admits no new work");
    assert.equal(second.body && JSON.parse(second.body).kind, "shutting-down", "the refusal names the shutdown");
    assert.equal(gate.calls.length, 1, "no second scan may start after the drain resolved");
  } finally {
    agent.destroy();
    server.close(() => {});
    server.closeAllConnections();
  }
});

test("work admitted BEFORE shutdown keeps its service — the gate fires only on new arrivals", async () => {
  const gate = countingScanner();
  const server = await createApiServer({ registry: [], events: [], walletScanner: gate.scanner });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const client = get(null, base, `/lots?address=${OWNER}`); // entered before shutdown: served to the end
    await gate.entered();
    const draining = server.shutdown({ drainMs: 5000 });
    assert.equal(gate.calls.length, 1);
    gate.release();
    await draining;
    assert.equal((await client).status, 200, "the drain exists for admitted work — it must not 503 it");
  } finally {
    server.close(() => {});
    server.closeAllConnections();
  }
});

test("the admission gate is not /lots-only: a late /accruals is refused too, no second scan", async () => {
  // the gate sits at ADMISSION, before routing: every data route is closed to new work
  // once the drain begins, not just the wallet-report route. A gate narrowed into /lots
  // lets a late /accruals start a doomed scan (the drain has resolved, serve.mjs's exit
  // grace kills it mid-RPC) while the client waits forever.
  const gate = countingScanner();
  const server = await createApiServer({ registry: [TOKEN], events: [], walletScanner: gate.scanner });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const agent = new http.Agent({ keepAlive: true });
  try {
    // the in-flight scan's connection survives closeIdleConnections and carries the late request
    const first = get(agent, base, `/lots?address=${OWNER}`);
    await gate.entered();
    const draining = server.shutdown({ drainMs: 5000 });
    gate.release();
    await draining;
    assert.equal((await first).status, 200);

    const late = await Promise.race([
      get(agent, base, `/accruals?symbol=PLx&address=${OWNER}`),
      sleep(2_000).then(() => null),
    ]);
    assert.ok(late, "the late /accruals got no answer at all (it started a scan nobody waits for)");
    assert.equal(late.status, 503, "the drain admits no new work on /accruals either");
    assert.equal(late.body && JSON.parse(late.body).kind, "shutting-down", "the refusal names the shutdown");
    assert.equal(gate.calls.length, 1, "no second scan may start after the drain resolved");
  } finally {
    agent.destroy();
    server.close(() => {});
    server.closeAllConnections();
  }
});
