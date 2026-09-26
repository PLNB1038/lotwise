// Graceful shutdown of the API server (SRE round 34): the daily systemd restart timer
// sent SIGTERM and node died mid-scan — a wallet scan holds the ONE scan slot for
// minutes of RPC pacing, so the work was lost, the client saw a hard reset, and the
// 04:30 judge scan would have died silently. The contract here: shutdown({ drainMs })
// stops accepting NEW connections, lets the in-flight scan finish inside the grace
// window (its client keeps the 200), aborts the scan point-blank only after the window,
// and resolves when the process may exit. The SIGTERM/SIGINT glue lives in serve.mjs;
// the systemd TimeoutStopSec draft lives in the deployment notes, not in the repo.
import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/api/server.mjs";

const OWNER = "9BB7Tt5uW5QbAorLkF3Hn1P2mGcXvcDdR7y8LbT9KdUu"; // valid base58, not in the registry
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const emptyScan = { owner: OWNER, signatures: 1, fetched: 1, skipped: [], truncated: false, accounts: new Map(), txs: [] };

// Gate-mock of the wallet scanner: the scan holds the slot until the test releases it.
// The AbortSignal is observable (signal.aborted) and rejects on abort — the real scanner
// stops the same way (scan.mjs honors the signal between RPC pages).
function gatedScanner() {
  let enteredCb = null;
  let releaseCb = null;
  const signalRef = { current: null };
  const scanner = (_address, { signal } = {}) => {
    signalRef.current = signal;
    enteredCb?.();
    return new Promise((resolve, reject) => {
      releaseCb = () => resolve(emptyScan);
      signal?.addEventListener("abort", () => reject(new Error("scan aborted by shutdown")));
    });
  };
  return {
    scanner,
    signalRef,
    entered: () => new Promise((res) => { enteredCb = res; }),
    release: () => releaseCb?.(),
  };
}

// The shutdown tests close the server through shutdown() themselves; a FAILED test must
// not leave a pending scan or an open socket behind — both keep the event loop alive and
// hang the whole suite. The cleanup releases the gate and swallows the
// ERR_SERVER_NOT_RUNNING of a double close (the error goes to the callback, not 'error').
async function withScanServer(gate, fn) {
  const server = await createApiServer({ registry: [], events: [], walletScanner: gate.scanner });
  const { port } = server.address();
  try {
    await fn(server, `http://127.0.0.1:${port}`);
  } finally {
    gate.release();
    server.close(() => {});
    server.closeAllConnections();
  }
}

test("shutdown during an active scan drains it: the scan finishes on its own, the client keeps the 200", async () => {
  const gate = gatedScanner();
  await withScanServer(gate, async (server, base) => {
    const client = fetch(`${base}/lots?address=${OWNER}`); // NOT awaited: the scan holds the slot
    await gate.entered();
    let settled = false;
    const t0 = Date.now();
    const draining = server.shutdown({ drainMs: 5000 }).then(() => { settled = true; });
    await sleep(50);
    assert.equal(settled, false, "shutdown must wait for the in-flight scan, not resolve under it");
    gate.release();
    await draining;
    assert.ok(Date.now() - t0 < 1000, `the drain releases when the scan settles, not at the window's edge (${Date.now() - t0}ms)`);
    assert.equal((await client).status, 200, "the scan's client keeps its answer through the drain");
    await assert.rejects(fetch(`${base}/health`), "no new connection is accepted after shutdown");
  });
});

test("shutdown aborts a scan that outlives the grace window and resolves at the window's edge", async () => {
  const gate = gatedScanner(); // never released: the scan hangs until shutdown aborts it
  await withScanServer(gate, async (server, base) => {
    const client = fetch(`${base}/lots?address=${OWNER}`);
    await gate.entered();
    const t0 = Date.now();
    await server.shutdown({ drainMs: 150 });
    const elapsed = Date.now() - t0;
    assert.equal(gate.signalRef.current.aborted, true, "the window expired: the scan's signal is aborted");
    assert.ok(elapsed >= 140, `the grace window is honored, not cut short (${elapsed}ms)`);
    assert.ok(elapsed < 1000, `shutdown resolves at the window's edge, not much later (${elapsed}ms)`);
    // the route's own catch answers the aborted client — a typed 503, not a dead socket
    assert.equal((await client).status, 503);
  });
});

test("shutdown on an idle server is immediate: no drain wait, the port is closed after", async () => {
  const server = await createApiServer({ registry: [], events: [] });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200, "the server is up before the drain");
    const t0 = Date.now();
    await server.shutdown({ drainMs: 5000 });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 250, `an idle server must not wait out the window (${elapsed}ms)`);
    await assert.rejects(fetch(`${base}/health`), "the listener is down after shutdown");
  } finally {
    server.close(() => {});
    server.closeAllConnections();
  }
});
