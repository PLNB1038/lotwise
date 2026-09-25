import test from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter } from "../src/api/ratelimit.mjs";
import { createApiServer } from "../src/api/server.mjs";
import { loadRegistry } from "../src/registry/registry.mjs";

test("createRateLimiter: exactly max per window, then a refusal with retryAfter, the window resets", () => {
  let t = 1_000_000; // controlled clocks: a fixed window of 10_000ms
  const limiter = createRateLimiter({ windowMs: 10_000, max: 2, now: () => t });
  assert.deepEqual(limiter.check("a"), { allowed: true, retryAfterMs: 0 });
  assert.deepEqual(limiter.check("a"), { allowed: true, retryAfterMs: 0 });
  const denied = limiter.check("a");
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterMs > 0 && denied.retryAfterMs <= 10_000);
  // the keys are isolated: a foreign bucket does not interfere
  assert.equal(limiter.check("b").allowed, true);
  // the window rolled over — the count from scratch (t=1_010_000 falls into the window 1_010_000..1_020_000)
  t = 1_010_000;
  assert.deepEqual(limiter.check("a"), { allowed: true, retryAfterMs: 0 });
});

test("createRateLimiter: garbage parameters — an explicit throw, not a silent unlimited", () => {
  assert.throws(() => createRateLimiter({ windowMs: 0, max: 1 }), RangeError);
  assert.throws(() => createRateLimiter({ windowMs: 1000, max: 0 }), RangeError);
  assert.throws(() => createRateLimiter({ windowMs: 1000.5, max: 1 }), RangeError);
});

// the scan shape — per the report.mjs contract (as aScan in api.test.mjs): an empty wallet
const scanStub = () => ({ owner: ADDR, signatures: 0, fetched: 0, txs: [], skipped: [], truncated: false, accounts: {} });

async function withLimitedServer(fn, opts = {}) {
  const registry = await loadRegistry("data/tokens.json");
  const server = await createApiServer({
    registry,
    events: [],
    walletScanner: scanStub,
    rateLimits: { scan: { windowMs: 60_000, max: 2 }, rpc: { windowMs: 60_000, max: 2 } },
    ...opts,
  });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

const ADDR = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"; // a valid base58 pubkey (not in the registry — irrelevant for /lots)

test("/lots: a third scan per window — a 429 with Retry-After, the scanner really called twice", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const calls = [];
  // our own server with a call counter: what matters is that the 429 stops BEFORE the scanner
  const server = await createApiServer({
    registry,
    events: [],
    walletScanner: (a) => {
      calls.push(a);
      return Promise.resolve(scanStub());
    },
    rateLimits: { scan: { windowMs: 60_000, max: 2 }, rpc: { windowMs: 60_000, max: 2 } },
  });
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/lots?address=${ADDR}`;
  try {
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await fetch(url)).status, 200);
    const blocked = await fetch(url);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
    assert.match((await blocked.json()).error, /rate limit exceeded/);
    assert.equal(calls.length, 2); // the third request did not reach the scanner
  } finally {
    server.close();
  }
});

test("/lots: garbage addresses (a 400 before the limit) do not burn the quota; /health is not limited", async () => {
  await withLimitedServer(async (base) => {
    for (let i = 0; i < 5; i++) {
      assert.equal((await fetch(`${base}/lots?address=junk${i}`)).status, 400);
    }
    assert.equal((await fetch(`${base}/lots?address=${ADDR}`)).status, 200); // the quota intact
    for (let i = 0; i < 5; i++) {
      assert.equal((await fetch(`${base}/health`)).status, 200); // the cheap endpoints without a limit
    }
  });
});

test("trustProxy: X-Forwarded-For sets the bucket, without it — the socket address (one bucket)", async () => {
  await withLimitedServer(async (base) => {
    // without trustProxy the XFF is ignored: both "clients" share the socket bucket (max=2),
    // forging the header does not give one new buckets
    const h1 = { "x-forwarded-for": "1.1.1.1" };
    const h2 = { "x-forwarded-for": "2.2.2.2" };
    assert.equal((await fetch(`${base}/lots?address=${ADDR}`, { headers: h1 })).status, 200);
    assert.equal((await fetch(`${base}/lots?address=${ADDR}`, { headers: h2 })).status, 200);
    assert.equal((await fetch(`${base}/lots?address=${ADDR}`, { headers: h2 })).status, 429);
  }, { trustProxy: false });

  await withLimitedServer(async (base) => {
    // with trustProxy every XFF — its own bucket (max=2): both "clients" live independently
    const h1 = { "x-forwarded-for": "1.1.1.1" };
    const h2 = { "x-forwarded-for": "2.2.2.2" };
    assert.equal((await fetch(`${base}/lots?address=${ADDR}`, { headers: h1 })).status, 200);
    assert.equal((await fetch(`${base}/lots?address=${ADDR}`, { headers: h2 })).status, 200);
    assert.equal((await fetch(`${base}/lots?address=${ADDR}`, { headers: h2 })).status, 200);
    assert.equal((await fetch(`${base}/lots?address=${ADDR}`, { headers: h2 })).status, 429); // the 2.2.2.2 bucket exhausted
    assert.equal((await fetch(`${base}/lots?address=${ADDR}`, { headers: h1 })).status, 200); // while 1.1.1.1 is still alive
  }, { trustProxy: true });
});

test("rateLimits: null — the limits off (local experiments)", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const server = await createApiServer({ registry, events: [], walletScanner: scanStub, rateLimits: null });
  const { port } = server.address();
  try {
    for (let i = 0; i < 5; i++) {
      assert.equal((await fetch(`http://127.0.0.1:${port}/lots?address=${ADDR}`)).status, 200);
    }
  } finally {
    server.close();
  }
});

// Round 22 (security): XFF rotation used to mint a fresh bucket per request — the last
// hop was trusted as a bare string (300/300 at a limit of 2/min). A hop that is not an
// IP address is now refused as a key: the request falls back to the shared socket bucket.
test("trustProxy: rotating GARBAGE XFF hops does not mint new buckets — the socket bucket applies", async () => {
  await withLimitedServer(async (base) => {
    const rot = (n) => ({ "x-forwarded-for": `attacker-fake-client-${n}` });
    assert.equal((await fetch(`${base}/lots?address=${ADDR}`, { headers: rot(1) })).status, 200);
    assert.equal((await fetch(`${base}/lots?address=${ADDR}`, { headers: rot(2) })).status, 200);
    for (let i = 3; i <= 5; i++) {
      assert.equal((await fetch(`${base}/lots?address=${ADDR}`, { headers: rot(i) })).status, 429,
        `rotation attempt ${i}: no new bucket for a non-IP hop`);
    }
    // a REAL ip hop still gets its own bucket next to the exhausted socket bucket
    assert.equal((await fetch(`${base}/lots?address=${ADDR}`, { headers: { "x-forwarded-for": "9.9.9.9" } })).status, 200);
  }, { trustProxy: true });
});
