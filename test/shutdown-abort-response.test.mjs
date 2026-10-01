// The drain-abort's 503 must reach the CLIENT, not die in the exit race (round 49).
// serve.mjs stops the process 200ms after server.shutdown() resolves, so the contract
// "the aborted scan's client gets the 503 {kind:aborted}" is only honest if the 503 is
// already written when the drain resolves. The r36/r48 SRE rounds proved the REAL
// scanner breaks this: the abort fires while the scan's RPC call is already SELECTED by
// the RpcClient pacing gate, whose sleep is not abort-wired — the rejection surfaces up
// to minIntervalMs (350ms) later, past the 200ms exit grace, and the client sees a bare
// ECONNRESET with no access-log line. The existing shutdown tests use a scanner that
// rejects ON the abort event (the signal-wired fast path, r36 "stand B") — they cannot
// see this. Here the scanner mimics the real pacing-gate latency: the rejection lands
// 400ms AFTER the abort (slower than the grace), and the client must still receive the
// contractual 503.
import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/api/server.mjs";

const OWNER = "9BB7Tt5uW5QbAorLkF3Hn1P2mGcXvcDdR7y8LbT9KdUu"; // valid base58, not in the registry
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXIT_GRACE_MS = 200; // serve.mjs's exit delay after shutdown() resolves

const emptyScan = { owner: OWNER, signatures: 1, fetched: 1, skipped: [], truncated: false, accounts: new Map(), txs: [] };
const abortErr = () => Object.assign(new Error("request aborted by the caller"), { kind: "aborted" });

// The scan holds the slot until aborted; the abort is OBSERVED only after a
// non-abortable pause (the pacing gate's residual sleep), like the real RpcClient.
function pacedAbortScanner({ settleAfterMs }) {
  let enteredCb = null;
  let releaseCb = null;
  let settleTimer = null;
  const signalRef = { current: null };
  const scanner = (_address, { signal } = {}) => {
    signalRef.current = signal;
    enteredCb?.();
    return new Promise((resolve, reject) => {
      signal?.addEventListener("abort", () => {
        settleTimer = setTimeout(() => reject(abortErr()), settleAfterMs);
      });
      releaseCb = () => {
        if (settleTimer !== null) { clearTimeout(settleTimer); settleTimer = null; }
        resolve(emptyScan);
      };
    });
  };
  return {
    scanner,
    signalRef,
    entered: () => new Promise((res) => { enteredCb = res; }),
    release: () => releaseCb?.(),
  };
}

// A scanner that ignores the abort entirely: the settle wait must still be bounded.
function deafScanner() {
  let enteredCb = null;
  const signalRef = { current: null };
  const scanner = (_address, { signal } = {}) => {
    signalRef.current = signal;
    enteredCb?.();
    return new Promise(() => {});
  };
  return { scanner, signalRef, entered: () => new Promise((res) => { enteredCb = res; }) };
}

async function withScanServer(gate, fn) {
  const server = await createApiServer({ registry: [], events: [], walletScanner: gate.scanner });
  const { port } = server.address();
  try {
    await fn(server, `http://127.0.0.1:${port}`);
  } finally {
    if (gate.release) gate.release();
    server.close(() => {});
    server.closeAllConnections();
  }
}

test("drain-aborted scan: the 503 {kind:aborted} is written within the exit-grace window", async () => {
  // 400ms of abort-observation latency: longer than the 200ms exit grace, well inside
  // the real pacing gate's 350ms worst case plus route overhead.
  const gate = pacedAbortScanner({ settleAfterMs: 400 });
  await withScanServer(gate, async (server, base) => {
    // the client promise NEVER rejects (a socket error is an outcome, not an exception):
    // it may settle after the race window on the failing side and must not crash the file
    const clientP = fetch(`${base}/lots?address=${OWNER}`)
      .then((r) => r.text().then((body) => ({ status: r.status, body })))
      .catch((e) => ({ error: String(e?.cause?.code ?? e?.message ?? e) }));
    await gate.entered();
    await server.shutdown({ drainMs: 150 }); // the window ran out: the scan is aborted
    // serve.mjs would exit(0) at resolve + EXIT_GRACE_MS: whatever the client must see
    // has to arrive inside that window — a response after it never leaves the process.
    const winner = await Promise.race([
      clientP.then((got) => ({ got })),
      sleep(EXIT_GRACE_MS + 100).then(() => null),
    ]);
    assert.ok(winner, "the client saw no response within the exit-grace window (a bare connection reset in production)");
    assert.ok(!winner.got.error, `the client got a socket error instead of a response: ${winner.got.error}`);
    assert.equal(winner.got.status, 503, "the aborted scan's client gets the typed 503");
    assert.match(winner.got.body, /aborted/, "the body names the abort");
  });
});

test("the abort-settle wait is bounded: a scanner that ignores the abort cannot stall the shutdown", async () => {
  const gate = deafScanner();
  await withScanServer(gate, async (server, base) => {
    // settled via .catch when the finally tears the sockets down — never awaited here:
    // this fn must return while the route is still hanging, that is the point
    fetch(`${base}/lots?address=${OWNER}`).catch(() => null);
    await gate.entered();
    const t0 = Date.now();
    await server.shutdown({ drainMs: 150 });
    const elapsed = Date.now() - t0;
    assert.equal(gate.signalRef.current.aborted, true, "the window expired: the scan's signal is aborted");
    assert.ok(elapsed < 5_000, `shutdown must stay bounded even when the scan never settles (${elapsed}ms)`);
  });
});
