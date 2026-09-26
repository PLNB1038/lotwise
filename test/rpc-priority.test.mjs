import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { RpcClient } from "../src/ingest/rpc.mjs";
import { scanWallet } from "../src/wallet/scan.mjs";
import { fetchWalletDeltas } from "../src/ingest/tx.mjs";

// Deterministic pacing harness: minIntervalMs is huge so EVERY pacing gate sleeps,
// and the injected sleep resolves only when the test ticks it. The fetch order is
// therefore fully governed by tick order — no real timers, no flakes. The same
// harness works against the pre-priority client (a single FIFO chain): there the
// ticks resolve in arrival order, which is exactly what the red-first tests assert against.
const makeClient = (log, { maxRetries = 0, respond } = {}) => {
  const pending = [];
  const sleep = () => new Promise((resolve) => pending.push(resolve));
  // async on purpose: the previous gate's completion schedules the next sleep on a
  // microtask (the pre-priority chain does this lazily), so a tick must let the queue
  // advance before the test looks at the log or counts the pending sleeps again
  const tick = async () => {
    assert.ok(pending.length > 0, "tick(): no pacing sleep is pending");
    pending.shift()();
    await flush();
  };
  const fetcher = async (_url, init) => {
    const body = JSON.parse(init.body);
    log.push(body.params[0]); // the first RPC param doubles as the call marker
    if (respond) return respond(body.method, body.params);
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: body.id, result: 1 }) };
  };
  // 1e13 — far above the epoch ms: even the FIRST call (this._lastCall = 0) must see a
  // positive wait, otherwise the gate skips the sleep and the harness loses determinism
  const client = new RpcClient({ endpoint: "https://rpc.example", fetcher, sleep, minIntervalMs: 1e13, maxRetries });
  return { client, tick, pendingSleeps: () => pending.length };
};

// Let every queued enqueue/drain microtask settle before the next arrangement step.
const flush = () => new Promise((r) => setImmediate(r));

test("a point (high) call queued behind a scan backlog answers before the remaining backlog", { timeout: 5000 }, async () => {
  const log = [];
  const { client: c, tick } = makeClient(log);
  // the scan backlog fills the queue first; the point call arrives into the tail
  const l1 = c.call("getSignaturesForAddress", ["L1"], { priority: "low" });
  await flush();
  const l2 = c.call("getSignaturesForAddress", ["L2"], { priority: "low" });
  const l3 = c.call("getSignaturesForAddress", ["L3"], { priority: "low" });
  await flush();
  const h = c.call("getAccountInfo", ["HIGH"], { priority: "high" });
  await flush();
  const l4 = c.call("getSignaturesForAddress", ["L4"], { priority: "low" });
  await flush();

  await tick(); // L1 already owns the in-flight pacing slot — the later high arrival does not preempt it
  await tick(); // the next slot goes to the high lane even though L2 queued earlier
  await tick();
  await tick();
  await tick();

  await Promise.all([l1, l2, l3, h, l4]);
  assert.deepEqual(
    log,
    ["L1", "HIGH", "L2", "L3", "L4"],
    "the high call jumps the backlog; the backlog keeps FIFO among itself",
  );
});

test("the default priority is low: an unmarked call queues behind high calls that arrived later", { timeout: 5000 }, async () => {
  const log = [];
  const { client: c, tick } = makeClient(log);
  // The first call always owns the first slot (no preemption), so the default is
  // detected by POSITION: a plain call sandwiched between two high calls must be
  // overtaken by the SECOND one. A default of "high" would order it [H1, PLAIN, H2];
  // the default "low" orders [H1, H2, PLAIN].
  const h1 = c.call("getAccountInfo", ["H1"], { priority: "high" });
  await flush();
  const plain = c.call("getHealth", ["PLAIN"]); // no options — must land in the low lane
  await flush();
  const h2 = c.call("getAccountInfo", ["H2"], { priority: "high" });
  await flush();
  await tick();
  await tick();
  await tick();
  await Promise.all([h1, plain, h2]);
  assert.deepEqual(log, ["H1", "H2", "PLAIN"], "an unmarked call must not jump an explicitly high one that arrived after it");
});

test("within one lane the queue stays FIFO — the lane never reorders same-priority calls", { timeout: 5000 }, async () => {
  const log = [];
  const { client: c, tick } = makeClient(log);
  const ps = [];
  for (let i = 0; i < 4; i++) {
    ps.push(c.call("getSignaturesForAddress", [`L${i}`], { priority: "low" }));
    await flush();
  }
  for (let i = 0; i < 4; i++) await tick();
  await Promise.all(ps);
  assert.deepEqual(log, ["L0", "L1", "L2", "L3"], "low calls answer in arrival order");
});

test("the lanes share ONE pacing gate: every call, high or low, costs exactly one slot", { timeout: 5000 }, async () => {
  const log = [];
  const { client: c, tick, pendingSleeps } = makeClient(log);
  const ps = [
    c.call("getSignaturesForAddress", ["S1"], { priority: "low" }),
    c.call("getAccountInfo", ["H"], { priority: "high" }),
    c.call("getSignaturesForAddress", ["S2"], { priority: "low" }),
  ];
  await flush();
  assert.equal(pendingSleeps(), 1, "exactly one pacing gate is open — two lanes, one interval");
  await tick();
  assert.equal(log.length, 1);
  assert.equal(pendingSleeps(), 1, "the next slot opens only after the previous one is spent");
  await tick();
  assert.equal(log.length, 2);
  assert.equal(pendingSleeps(), 1);
  await tick();
  assert.equal(log.length, 3);
  assert.equal(pendingSleeps(), 0, "an empty queue closes the gate");
  await Promise.all(ps);
  assert.equal(log.length, 3);
});

test("an unknown priority is a loud RangeError, not a silent lane fallback", { timeout: 5000 }, async () => {
  const log = [];
  const { client: c, pendingSleeps } = makeClient(log);
  await assert.rejects(
    () => c.call("getSlot", [], { priority: "hight" }),
    (err) => err instanceof RangeError && /priority/.test(err.message),
  );
  assert.equal(log.length, 0, "the misspelled call never reached the wire");
  assert.equal(pendingSleeps(), 0, "the bad call never queued a pacing slot");
});

test("abort before start still throws kind 'aborted' without consuming a pacing slot", { timeout: 5000 }, async () => {
  const log = [];
  const { client: c, pendingSleeps } = makeClient(log);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => c.call("getAccountInfo", ["X"], { signal: ac.signal, priority: "high" }),
    (err) => err?.kind === "aborted",
  );
  assert.equal(pendingSleeps(), 0, "no pacing slot was burned on a caller that is already gone");
  assert.equal(log.length, 0);
});

test("a retrying low call re-enters the low lane: a high call queued during backoff goes first", { timeout: 5000 }, async () => {
  const log = [];
  let first = true;
  const { client: c, tick } = makeClient(log, {
    maxRetries: 1,
    respond: (_method, _params) => {
      // the first attempt of the scan call hits a rate limit; the retry succeeds
      if (log.length === 1 && first) {
        first = false;
        return { ok: false, status: 429, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: 1 }) };
    },
  });
  const scan = c.call("getSignaturesForAddress", ["S"], { priority: "low" });
  await flush();
  await tick(); // the first S attempt goes out and comes back 429 — the call enters backoff
  await flush();
  const h = c.call("getAccountInfo", ["HIGH"], { priority: "high" });
  await flush();
  await tick(); // backoff elapses
  await tick(); // the high call (queued during the backoff) takes the slot first
  await tick(); // then the retry — from the same low lane
  await Promise.all([scan, h]);
  assert.deepEqual(log, ["S", "HIGH", "S"], "the retry keeps its lane; the backoff window lets the point call through");
});

test("scanWallet marks every one of its RPC calls as low priority (scan traffic, not vitrine traffic)", { timeout: 5000 }, async () => {
  const OWNER = "1".repeat(32); // structurally valid: 32 leading zero bytes
  const MINT = "1".repeat(31) + "2";
  const seen = [];
  const fake = {
    call: async (method, _params, opts) => {
      seen.push({ method, priority: opts?.priority });
      if (method === "getTokenAccountsByOwner") return { value: [] };
      return []; // getSignaturesForAddress: empty page = end of history
    },
  };
  await scanWallet(fake, OWNER, [{ mint: MINT }], { maxTxs: 1 });
  assert.ok(seen.length >= 3, `the scan made ${seen.length} RPC calls, expected the listing + signature pages`);
  for (const { method, priority } of seen) {
    assert.equal(priority, "low", `${method} must be explicitly marked low, got ${JSON.stringify(priority)}`);
  }
});

test("fetchWalletDeltas (getTransaction) marks its call as low priority", { timeout: 5000 }, async () => {
  let captured = null;
  const fake = {
    call: async (method, _params, opts) => {
      captured = { method, priority: opts?.priority };
      return { slot: 1, meta: { preTokenBalances: [], postTokenBalances: [] } };
    },
  };
  await fetchWalletDeltas(fake, "sig", new Set(["mint"]));
  assert.equal(captured.method, "getTransaction");
  assert.equal(captured.priority, "low", "getTransaction is scan traffic and must not jump the vitrine");
});

// The serve wiring lives in a boot script with no exported factory, so the contract is
// pinned at the source level: both point readers (the boot journal and the /onchain
// reader) must pass priority "high" — they are exactly the calls a scan backlog used to bury.
test("serve.mjs wires both point readers (boot journal + /onchain) as high priority", { timeout: 5000 }, async () => {
  const src = await readFile(new URL("../scripts/serve.mjs", import.meta.url), "utf8");
  const parts = src.split(`.call("getAccountInfo"`);
  assert.equal(parts.length, 3, `expected exactly two getAccountInfo call sites in serve.mjs, found ${parts.length - 1}`);
  for (const tail of parts.slice(1)) {
    assert.match(tail.slice(0, 200), /priority:\s*"high"/, `getAccountInfo call site must pass priority "high": ${tail.slice(0, 80)}`);
  }
});
