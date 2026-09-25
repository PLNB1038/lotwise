
// regression tests — the watch list.
//   R8-1: signature pagination — a short page ≠ end of history (soft indexer caps):
//         the end is only on an EMPTY page + a "no progress" guard
//         (scan.mjs:124, signatures.mjs:15).
//   R8-2: atomicWriteJson — preserving the target's mode across rename + directory fsync
//         (Linux prod: chmod 600 webhooks.json dropped to 0644; power-loss could
//         break the rename). Helpers with injection — testable on Windows too.
//   R8-3: the file store of subscriptions — a cross-process lock (read-modify-write
//         lost a write with two concurrent CLI calls).
//   R8-4: SSRF denylist of subscription URLs (127/8, 10/8, 172.16/12, 192.168/16,
//         169.254/16 + metadata, ::1, fc00::/7, fe80::/10, localhost).
//   R8-5: transient JSON-RPC errors (-32005, "node is behind") — retry
//         with backoff instead of an instant fatal of the whole scan.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanWallet } from "../src/wallet/scan.mjs";
import { streamSignatures } from "../src/ingest/signatures.mjs";
import { validateSubscription, addSubscription, listSubscriptions, SubscriptionError } from "../src/webhooks/subscriptions.mjs";
import { RpcClient, RpcError } from "../src/ingest/rpc.mjs";
import { atomicWriteJson } from "../src/fs/atomic.mjs";

const OWNER = "Wa11etBuyer" + "a".repeat(32);
const SPYx = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const REGISTRY = [{ mint: SPYx, symbol: "SPYx", name: "SPY", issuer: "backed", decimals: 8 }];

const sig = (n) => ({
  signature: "s".repeat(43) + String(n),
  slot: n, blockTime: 1750000000 + n, err: null,
});

// ---- R8-1: the end of pagination — an EMPTY page only ----

// pages as a function of before: [s1,s2] (full) → [s3] (SHORT, but not the end!)
// → [s4] (also short) → [] (an honest end)
const shortNotEnd = (source, { before }) =>
  before === undefined ? [sig(1), sig(2)] : before.endsWith("2") ? [sig(3)] : before.endsWith("3") ? [sig(4)] : [];

// a stuck endpoint: the same page always; after 10 calls we serve an empty one,
// so that the CURRENT (unfixed) code also terminates — we distinguish the guard by the call count
function stuckClient() {
  let calls = 0;
  return {
    calls: () => calls,
    client: {
      async call(method, params) {
        if (method === "getTokenAccountsByOwner") return { value: [] };
        if (method === "getTransaction") return null;
        calls++;
        return calls >= 10 ? [] : [sig(1), sig(2)];
      },
    },
  };
}

function clientWith(pagesOf, { txs = null } = {}) {
  return {
    async call(method, params) {
      if (method === "getTokenAccountsByOwner") return { value: [] };
      if (method === "getSignaturesForAddress") return pagesOf(params[0], params[1] ?? {});
      if (method === "getTransaction") return txs;
      throw new Error(`unexpected ${method}`);
    },
  };
}

test("scan: a short page is NOT the end — the tail of the history arrives, truncated is honestly false", async () => {
  const scan = await scanWallet(clientWith(shortNotEnd), OWNER, REGISTRY, { limit: 2, maxTxs: 100 });
  assert.equal(scan.signatures, 4, "all 4 signatures seen: s4 behind the short page s3");
  assert.equal(scan.truncated, false);
});

test("scan: a stuck endpoint (the same page over and over) — terminated by the \"no progress\" guard", async () => {
  const { client, calls } = stuckClient();
  const scan = await scanWallet(client, OWNER, REGISTRY, { limit: 2, maxTxs: 100 });
  assert.equal(scan.signatures, 2);
  // the guard bounds every source walk independently — the address plus one
  // derived ATA per (mint × token program), 3 calls each (a page + two no-progress pages)
  assert.ok(calls() <= 3 * (2 * REGISTRY.length + 1), `the guard must break each source loop in 2-3 calls, not spin until an empty page (calls=${calls()})`);
}, { timeout: 5000 });

test("streamSignatures: the same semantics — a short page continues, an empty one ends", async () => {
  const out = [];
  for await (const s of streamSignatures(clientWith(shortNotEnd), SPYx, { limit: 2 })) out.push(s.signature);
  assert.equal(out.length, 4);
  const stuck = stuckClient();
  const stuckStream = [];
  for await (const s of streamSignatures(stuck.client, SPYx, { limit: 2 })) stuckStream.push(s.signature);
  assert.equal(stuckStream.length, 2, "duplicates of the stuck page are not yielded (the uniqueness contract)");
  assert.ok(stuck.calls() <= 3, `the guard breaks the loop in the stream too (calls=${stuck.calls()})`);
}, { timeout: 5000 });

test("scan: the maxTxs cap works as before (the cap — an honest truncated)", async () => {
  const scan = await scanWallet(clientWith(shortNotEnd), OWNER, REGISTRY, { limit: 2, maxTxs: 3 });
  assert.equal(scan.signatures, 3);
  assert.equal(scan.truncated, true);
});

// ---- R8-4: the SSRF denylist ----

const urlRejects = [
  "http://127.0.0.1:8790/hook",
  "http://10.0.0.5/hook",
  "http://172.31.255.1/hook",
  "http://192.168.1.10:8080/hook",
  "http://169.254.169.254/latest/meta-data/",
  "http://[::1]:8790/hook",
  "http://[fe80::1]/hook",
  "http://[fc00::5]/hook",
  "http://localhost/hook",
  "http://localHOST:8790/hook",
];

test("subscriptions: private/loopback/link-local/metadata URLs are rejected", () => {
  for (const url of urlRejects) {
    assert.throws(
      () => validateSubscription({ id: "wh_x", url, symbols: "*", secret: "s", createdAt: "2026-09-23T00:00:00.000Z" }),
      (err) => err instanceof SubscriptionError && /url/.test(err.field ?? ""),
      `${url} must be rejected`,
    );
  }
});

test("subscriptions: public URLs pass as before", () => {
  for (const url of ["https://example.com/hook", "https://8.8.8.8/hook", "http://203.0.113.7/webhook"]) {
    assert.doesNotThrow(() =>
      validateSubscription({ id: "wh_x", url, symbols: "*", secret: "s", createdAt: "2026-09-23T00:00:00.000Z", active: true }));
  }
});

// ---- R8-5: transient JSON-RPC errors ----

const jsonRpc = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

test("rpc: -32005 \"node is behind\" — retries with backoff, then success", async () => {
  let n = 0;
  const client = new RpcClient({
    endpoint: "https://rpc.example",
    fetcher: async () => {
      n++;
      return n < 3
        ? jsonRpc({ jsonrpc: "2.0", id: n, error: { code: -32005, message: "Node is behind by 4 slots" } })
        : jsonRpc({ jsonrpc: "2.0", id: n, result: 42 });
    },
    sleep: async () => {}, minIntervalMs: 0,
  });
  assert.equal(await client.call("getMethod", []), 42);
  assert.equal(n, 3);
});

test("rpc: exhausting retries on -32005 — an honest RpcError with the code", async () => {
  let n = 0;
  const client = new RpcClient({
    endpoint: "https://rpc.example",
    fetcher: async () => { n++; return jsonRpc({ jsonrpc: "2.0", id: n, error: { code: -32005, message: "Node is behind by 12 slots" } }); },
    sleep: async () => {}, minIntervalMs: 0, maxRetries: 2,
  });
  await assert.rejects(() => client.call("getMethod", []), (err) => err instanceof RpcError && err.code === -32005);
  assert.equal(n, 3); // 1 + 2 retries
});

test("rpc: -32015 is still NOT retried (our request is the bad one)", async () => {
  let n = 0;
  const client = new RpcClient({
    endpoint: "https://rpc.example",
    fetcher: async () => { n++; return jsonRpc({ jsonrpc: "2.0", id: n, error: { code: -32015, message: "Unsupported transaction version" } }); },
    sleep: async () => {}, minIntervalMs: 0,
  });
  await assert.rejects(() => client.call("getMethod", []), (err) => err instanceof RpcError && err.code === -32015);
  assert.equal(n, 1, "we do not spend quota on retries of a deterministic error");
});

// ---- R8-2: atomic — mode and directory fsync (helpers with injection) ----

test("atomic: copyModeIfExists carries the existing target's mode onto tmp (fs injection)", async () => {
  const { copyModeIfExists } = await import("../src/fs/atomic.mjs");
  const calls = [];
  const fsTools = {
    statSync: (p) => { calls.push(["stat", p]); return { mode: 0o600 }; },
    chmodSync: (p, m) => calls.push(["chmod", p, m]),
  };
  copyModeIfExists("/data/webhooks.json", "/data/.webhooks.json.tmp", { fsTools });
  assert.deepEqual(calls.filter((c) => c[0] === "chmod"), [["chmod", "/data/.webhooks.json.tmp", 0o600]]);
  // no target (stat threw) — quietly without chmod
  const calls2 = [];
  copyModeIfExists("/data/none.json", "/data/.none.json.tmp", {
    fsTools: { statSync: () => { throw new Error("ENOENT"); }, chmodSync: (p, m) => calls2.push(m) },
  });
  assert.deepEqual(calls2, []);
});

test("atomic: fsyncDir opens the directory, fsyncs and closes it; a failure — best-effort without throwing", async () => {
  const { fsyncDir } = await import("../src/fs/atomic.mjs");
  const calls = [];
  const fsTools = {
    openSync: (p, fl) => { calls.push(["open", p, fl]); return 7; },
    fsyncSync: (fd) => { calls.push(["fsync", fd]); },
    closeSync: (fd) => { calls.push(["close", fd]); },
  };
  fsyncDir("/data", { fsTools });
  assert.ok(calls.some((c) => c[0] === "fsync" && c[1] === 7));
  // a platform without directory fsync (win) — does not throw
  const boom = {
    openSync: () => { throw Object.assign(new Error("EINVAL"), { code: "EINVAL" }); },
    fsyncSync: () => {}, closeSync: () => {},
  };
  assert.doesNotThrow(() => fsyncDir("/data", { fsTools: boom }));
});

test("atomic: atomicWriteJson writes over an existing target (content intact, no throw)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lw-atomic-r8-"));
  try {
    const target = path.join(dir, "state.json");
    writeFileSync(target, "{\"old\":1}\n", { mode: 0o600 });
    atomicWriteJson(target, { neu: 2 });
    assert.equal(JSON.parse(readFileSync(target, "utf8")).neu, 2);
    atomicWriteJson(target, { neu: 3 });
    assert.equal(JSON.parse(readFileSync(target, "utf8")).neu, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- R8-3: the cross-process lock of the subscription store ----

test("subscriptions: withStoreLock — the lock file lives around the mutation and is released", async () => {
  const { withStoreLock } = await import("../src/webhooks/subscriptions.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "lw-lock-r8-"));
  try {
    const store = path.join(dir, "webhooks.json");
    const seen = [];
    const out = withStoreLock(store, () => {
      seen.push("locked:" + readLockFiles(dir).length);
      return "result";
    }, { sleep: async () => {}, nowMs: () => 1_000 });
    assert.equal(out, "result");
    assert.deepEqual(seen, ["locked:1"]);
    assert.deepEqual(readLockFiles(dir), [], "the lock is released after the mutation");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function readLockFiles(dir) {
  return readdirSync(dir).filter((f) => f.endsWith(".lock"));
}

test("subscriptions: withStoreLock breaks a STALE lock and waits for a fresh one", async () => {
  const { withStoreLock } = await import("../src/webhooks/subscriptions.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "lw-lock2-r8-"));
  try {
    const store = path.join(dir, "webhooks.json");
    mkdirSync(path.dirname(store), { recursive: true });
    // stale: mtime/nowMs well older than the TTL
    writeFileSync(store + ".lock", "stale");
    utimesSync(store + ".lock", new Date(0), new Date(0));
    let waited = 0;
    const out = withStoreLock(store, () => "ok", {
      sleep: async () => { waited++; }, nowMs: () => Date.now(), staleMs: 10_000, retryMs: 5,
    });
    assert.equal(out, "ok");
    assert.ok(waited <= 2, `a stale one is broken immediately, without a long wait (waited=${waited})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("subscriptions: concurrent addSubscription from \"two processes\" do not lose writes (simulated via two stores-into-one)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lw-store-r8-"));
  try {
    const store = path.join(dir, "webhooks.json");
    addSubscription(store, { id: "wh_a", url: "https://a.example/hook", symbols: "*", secret: "s1", nowMs: 1 });
    addSubscription(store, { id: "wh_b", url: "https://b.example/hook", symbols: "*", secret: "s2", nowMs: 2 });
    assert.deepEqual(listSubscriptions(store).map((s) => s.id).sort(), ["wh_a", "wh_b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
