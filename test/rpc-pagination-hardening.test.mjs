// formerly round9-hardening.test.mjs
// Round 9 regression tests — the night wave A (ROUND9_FINDINGS).
// Groups: flags (#1), signature pagination (#2,3,12,13), an array journal record (#4),
// the dividend crosscheck (#5), clientKey (#6), esc (#7), SSRF-mapped (#8),
// the lock (#9), atomic-0600 (#10), rpc (#11), the schema ceiling (#14),
// journal canonicalization (#15).
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseServeArgs } from "../src/cli/flags.mjs";
import { scanWallet } from "../src/wallet/scan.mjs";
import { streamSignatures } from "../src/ingest/signatures.mjs";
import { planJournalStep } from "../src/events/journal.mjs";
import { crossCheckDividendAccrual } from "../src/events/crosscheck.mjs";
import { validateEvent } from "../src/schema/events.mjs";
import { validateSubscription, withStoreLock } from "../src/webhooks/subscriptions.mjs";
import { RpcClient, RpcError } from "../src/ingest/rpc.mjs";
import { atomicWriteJson } from "../src/fs/atomic.mjs";
import { createApiServer } from "../src/api/server.mjs";
import { renderPage } from "../src/ui/page.mjs";
import { loadRegistry } from "../src/registry/registry.mjs";

const OWNER = "Wa11etBuyer" + "a".repeat(32);
const SPYx = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const REGISTRY = [{ mint: SPYx, symbol: "SPYx", name: "SPY", issuer: "backed", decimals: 8 }];
const TOKEN = { mint: SPYx, symbol: "TESTx" };

const sig = (n) => ({ signature: "s".repeat(43) + String(n), slot: n, blockTime: 1750000000 + n, err: null });

// ---- R9-1: flags — empty values and lenient numbers ----

test("flags: an empty --host/--rpc — a refusal, not a listen on all interfaces / a boot into the void", () => {
  for (const argv of [["--host", ""], ["--host="], ["--rpc", ""], ["--rpc="]]) {
    assert.throws(() => parseServeArgs(argv), (err) => err.message.includes(argv[0].replace(/=$/, "")), `${argv.join(" ")} must be refused`);
  }
});

test("flags: port digits-only — 0x10/1e2 do not pass, like /multiplier?raw", () => {
  assert.throws(() => parseServeArgs(["--port", "0x10"]), /port/);
  assert.throws(() => parseServeArgs(["--port", "1e2"]), /port/);
  assert.equal(parseServeArgs(["--port", "08080"]).port, 8080, "leading zeros are fine for digits-only");
});

function ServeArg(flag) {
  return (err) => err.message.includes(flag);
}

// ---- R9-2/3/12/13: signature pagination ----

function clientWithRoute(routeOf, { cap = 50 } = {}) {
  let calls = 0;
  const client = {
    calls: () => calls,
    async call(method, params) {
      if (method === "getTokenAccountsByOwner") return { value: [] };
      if (method === "getTransaction") return null;
      if (method === "getSignaturesForAddress") {
        calls++;
        if (calls > cap) return []; // a termination guarantee against ANY code
        return routeOf(params[1]?.before);
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return client;
}

test("scan: an element without a signature on page >1 — does not break the cursor, does not spin forever", async () => {
  const client = clientWithRoute((before) => {
    if (before === undefined) return [sig(1), sig(2)];
    if (before.endsWith("2")) return [{ slot: 99, blockTime: 1, err: null }, sig(3)]; // the broken element is LAST
    return [sig(4)];
  });
  const scan = await scanWallet(client, OWNER, REGISTRY, { limit: 2, maxTxs: 100 });
  assert.equal(scan.signatures, 4, "the cursor moves from the last VALID element, the tail arrives");
  assert.equal(scan.truncated, false);
}, { timeout: 5000 });

test("scan: a null element inside a page — skip, not a TypeError of the whole scan", async () => {
  const client = clientWithRoute(() => [null, sig(1), undefined, { signature: 42, slot: 1, blockTime: 1, err: null }, sig(2)]);
  const scan = await scanWallet(client, OWNER, REGISTRY, { limit: 5, maxTxs: 100 });
  assert.equal(scan.signatures, 2);
}, { timeout: 5000 });

test("scan: a non-array response (result:null of a lying gateway) — an honest error, not an \"empty wallet\"", async () => {
  const client = clientWithRoute(() => null);
  await assert.rejects(
    () => scanWallet(client, OWNER, REGISTRY, { limit: 2, maxTxs: 10 }),
    (err) => /signature|malformed|not an array|response/i.test(err.message),
  );
});

test("scan: alternating duplicate pages with different tails — termination after K calls with no progress", async () => {
  let flip = false;
  const client = clientWithRoute(() => {
    flip = !flip;
    return flip ? [sig(1), sig(2)] : [sig(3), sig(4)];
  });
  const scan = await scanWallet(client, OWNER, REGISTRY, { limit: 2, maxTxs: 100 });
  assert.equal(scan.signatures, 4);
  assert.ok(client.calls() <= 7, `after two pages with no new signatures — stop (calls=${client.calls()})`);
}, { timeout: 5000 });

test("streamSignatures: the same guards — a null element is skipped, a non-array throws, alternation terminates", async () => {
  const good = clientWithRoute((before) => (before === undefined ? [null, sig(1)] : []));
  const out = [];
  for await (const s of streamSignatures(good, SPYx, { limit: 2 })) out.push(s.signature);
  assert.equal(out.length, 1);
  await assert.rejects(async () => {
    for await (const _ of streamSignatures(clientWithRoute(() => null), SPYx, { limit: 2 })) break;
  }, /signature|malformed|response/i);
  let flip = false;
  const alt = clientWithRoute(() => { flip = !flip; return flip ? [sig(1), sig(2)] : [sig(3), sig(4)]; });
  const seen = [];
  for await (const s of streamSignatures(alt, SPYx, { limit: 2 })) seen.push(s.signature);
  assert.equal(seen.length, 4);
  assert.ok(alt.calls() <= 7);
}, { timeout: 5000 });

// ---- R9-4: an array journal record ----

const rotationMint = () => ({
  owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  data: { parsed: { info: { decimals: 8, extensions: [{ extension: "scaledUiAmountConfig", state: {
    multiplier: "1", newMultiplier: "5", newMultiplierEffectiveTimestamp: Date.UTC(2026, 5, 10) / 1000,
  } }] } } },
});

test("journal: an array record — the same corruption as a primitive: corrupted:true, the duplicate is not re-emitted", async () => {
  const { parseScaledUiAmount } = await import("../src/issuer/scaled-ui.mjs");
  const parsed = parseScaledUiAmount(rotationMint());
  for (const bad of [[1, 2, 3], []]) {
    const r = planJournalStep(TOKEN, bad, parsed);
    assert.equal(r.corrupted, true, `an array record ${JSON.stringify(bad)} — corruption`);
    assert.equal(r.event, null);
    assert.deepEqual(r.replay, []);
  }
});

// ---- R9-5: the dividend crosscheck — a degenerate POST-ex close ----

test("crosscheck: a dividend with after.c <= 0 — inconclusive, not a \"mismatch\" on a dead pool", async () => {
  const candles = [
    { ts: Date.UTC(2026, 5, 16) / 1000, c: 100 },
    { ts: Date.UTC(2026, 5, 17) / 1000, c: 100 },
    { ts: Date.UTC(2026, 5, 18) / 1000, c: 0 }, // the after-candle of a dead pool
  ];
  const v = crossCheckDividendAccrual({
    type: "DIVIDEND_ACCRUAL", mint: SPYx, effectiveDate: "2026-06-18T00:00:00.000Z",
    status: "confirmed", sources: ["test"], amountPerUnitRaw: 2_000_000, decimals: 8,
  }, candles);
  assert.equal(v.verdict, "inconclusive");
  assert.equal(v.observedDropFraction, null);
});

// ---- R9-6: clientKey — an empty last XFF element ----

test("ratelimit: XFF with an empty tail (a comma/space) — fallback to the socket bucket, not the shared \"\"", async () => {
  const registry = await loadRegistry("data/tokens.json");
  let scans = 0;
  const server = await createApiServer({
    registry, events: [],
    walletScanner: async () => {
      scans++;
      return { owner: OWNER, signatures: 1, fetched: 1, skipped: [], truncated: false, accounts: new Map(), txs: [] };
    },
    rateLimits: { scan: { windowMs: 60_000, max: 2 }, rpc: { windowMs: 60_000, max: 60 } },
    trustProxy: true,
  });
  const { port } = server.address();
  try {
    const go = (xff) => fetch(`http://127.0.0.1:${port}/lots?address=${OWNER}`, { headers: xff === null ? {} : { "x-forwarded-for": xff } });
    assert.equal((await go("5.5.5.5, ")).status, 200); // an empty tail → the socket bucket
    assert.equal((await go(null)).status, 200); // a direct client — the same socket bucket
    assert.equal((await go("6.6.6.6,")).status, 429, "the third in the socket bucket — beyond 2/min (not a separate \"\"-bucket)");
    assert.equal(scans, 2);
  } finally {
    server.close();
  }
});

// ---- R9-7: esc tails of the vitrine ----

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
  assert.ok(m);
  new vm.Script(m[1], { filename: "page-client.js" }).runInContext(sb);
  return { sb, els };
}

test("vitrine: t.events from /summary is escaped (the round-7 miss)", () => {
  const { sb, els } = runClient();
  sb.renderTokens([{ symbol: "TSTx", name: "T", issuer: "Backed", mint: SPYx, decimals: 8, events: "<img src=x onerror=alert(1)>", currentMultiplier: "1" }]);
  const html = els.get("tokens").innerHTML;
  assert.ok(!html.includes("<img src=x"), "the raw injection does not survive");
  assert.ok(html.includes("&lt;img"));
});

test("vitrine: the calculator dust (remainder/den) is escaped", async () => {
  const { els, flush } = runClientCalc({
    multiplier: "1", date: "2026-07-01T00:00:00.000Z",
    sampleScaledQty: { exact: false, whole: "1", remainder: "<script>alert(2)</script>", den: "3" },
  });
  await flush();
  const html = els.get("calc-out").innerHTML;
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("vitrine: corruptionStat with a string is escaped (returns a markup string)", () => {
  const { sb } = runClient();
  const html = sb.corruptionStat("<script>alert(3)</script>", "registry");
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

function runClientCalc(multBody) {
  const els = new Map();
  const makeEl = (id) => ({
    id, value: "", innerHTML: "", textContent: "", className: "", style: {},
    attrs: { getAttribute() { return null; } }, getAttribute() { return null; }, scrollIntoView() {},
  });
  const sb = {
    document: {
      getElementById: (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
      querySelectorAll: () => [{ className: "", getAttribute() { return "TSTx"; }, addEventListener() {} }],
    },
    fetch: (url) => Promise.resolve({
      ok: true, status: 200,
      json: async () => {
        if (String(url).includes("/multiplier")) return multBody;
        if (String(url).includes("/summary")) {
          return [{ symbol: "TSTx", name: "T", issuer: "Backed", mint: SPYx, decimals: 8, events: 0, currentMultiplier: "1" }];
        }
        return { ok: true, status: 200 };
      },
    }),
  };
  vm.createContext(sb);
  const m = renderPage().match(/<script>([\s\S]*?)<\/script>/);
  new vm.Script(m[1], { filename: "page-client.js" }).runInContext(sb);
  const flush = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };
  return { sb, els, flush };
}

// ---- R9-8: SSRF — IPv4-mapped IPv6 ----

test("subscriptions: ::ffff:127.0.0.1 and ::ffff:169.254.169.254 (metadata) are rejected; a public mapped one — not", () => {
  for (const url of ["https://[::ffff:127.0.0.1]/hook", "https://[::ffff:a9fe:a9fe]/hook", "https://[0:0:0:0:0:ffff:7f00:1]/hook"]) {
    assert.throws(() => sub(url), (err) => /url/.test(err.field ?? ""), `${url} must be rejected`);
  }
  assert.doesNotThrow(() => sub("https://[::ffff:8.8.8.8]/hook"), "a public embedded-v4 — a legitimate address");
});

function sub(url) {
  return validateSubscription({ id: "wh_x", url, symbols: "*", secret: "s", createdAt: "2026-09-23T00:00:00.000Z", active: true });
}

// ---- R9-9: the lock — the owner's liveness ----

test("lock: a lock STALE by mtime with a LIVE pid is NOT broken (a SIGSTOP owner) — an honest refusal", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lw-lock-r9-"));
  try {
    const store = path.join(dir, "webhooks.json");
    // mtime older than staleMs, but the pid is alive (ours): breaking on mtime alone = losing
    // the update of a stuck owner (the TOCTOU of ROUND9 #9)
    writeFileSync(store + ".lock", JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    utimesSync(store + ".lock", new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    let mutated = false;
    assert.throws(
      () => withStoreLock(store, () => { mutated = true; return "mutated"; }, { staleMs: 10_000, attempts: 3, retryPauseMs: 1 }),
      (err) => /locked/i.test(err.message),
      "a live owner — we wait and refuse, not break",
    );
    assert.equal(mutated, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lock: a stale lock with a DEAD pid is broken and the write goes through", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lw-lock2-r9-"));
  try {
    const store = path.join(dir, "webhooks.json");
    // a dead pid: spawn one and wait for the exit
    const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    assert.equal(child.status, 0);
    const deadPid = child.pid;
    writeFileSync(store + ".lock", JSON.stringify({ pid: deadPid, createdAt: new Date(0).toISOString() }));
    utimesSync(store + ".lock", new Date(0), new Date(0));
    const out = withStoreLock(store, () => "ok", { attempts: 5, retryPauseMs: 1 });
    assert.equal(out, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lock: a fresh foreign lock is released on its own after staleMs (a kill -9 orphan self-heals)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lw-lock3-r9-"));
  try {
    const store = path.join(dir, "webhooks.json");
    writeFileSync(store + ".lock", JSON.stringify({ pid: 999999999, createdAt: new Date().toISOString() }));
    utimesSync(store + ".lock", new Date(Date.now() - 5000), new Date(Date.now() - 5000));
    const t0 = Date.now();
    const out = withStoreLock(store, () => "ok", { staleMs: 100, attempts: 500, retryPauseMs: 5 });
    assert.equal(out, "ok");
    assert.ok(Date.now() - t0 < 4000, "waits for staleMs aging, not forever");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- R9-10: atomic — 0600 on the first write ----

test("atomic: a new secret-store write is created 0600 (Linux; win — no throw)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lw-atomic-r9-"));
  try {
    const target = path.join(dir, "state.json");
    atomicWriteJson(target, { a: 1 });
    const again = JSON.parse(readFileSync(target, "utf8"));
    assert.equal(again.a, 1);
    if (process.platform !== "win32") {
      assert.equal(statSync(target).mode & 0o777, 0o600, "the first write — 0600, not the umask");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- R9-11: rpc — a garbage body and persistent errors ----

const jsonRpcRaw = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

test("rpc: HTTP 200 with JSON null/an array — a classified network retry, not a bare TypeError/success", async () => {
  for (const raw of ["null", "[]", "42"]) {
    let n = 0;
    const client = new RpcClient({
      endpoint: "https://rpc.example",
      fetcher: async () => { n++; return new Response(raw, { status: 200, headers: { "Content-Type": "application/json" } }); },
      sleep: async () => {}, minIntervalMs: 0, maxRetries: 1,
    });
    await assert.rejects(
      () => client.call("m", []),
      (err) => err instanceof RpcError && err.kind === "network",
      `the body ${raw} — network classification`,
    );
    assert.equal(n, 2, "retried as network garbage");
  }
});

test("rpc: a deterministic code with a rate-limit text (-32602) — WITHOUT retries", async () => {
  let n = 0;
  const client = new RpcClient({
    endpoint: "https://rpc.example",
    fetcher: async () => { n++; return jsonRpcRaw({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "rate limit exceeded for this method" } }); },
    sleep: async () => {}, minIntervalMs: 0,
  });
  await assert.rejects(() => client.call("m", []), (err) => err.code === -32602);
  assert.equal(n, 1);
});

test("rpc: a message-matched transient without a code — retried; exhaustion — kind rate-limit", async () => {
  let n = 0;
  const client = new RpcClient({
    endpoint: "https://rpc.example",
    fetcher: async () => { n++; return jsonRpcRaw({ jsonrpc: "2.0", id: 1, error: { message: "Node is behind by 3 slots" } }); },
    sleep: async () => {}, minIntervalMs: 0, maxRetries: 1,
  });
  await assert.rejects(
    () => client.call("m", []),
    (err) => err instanceof RpcError && err.kind === "rate-limit",
  );
  assert.equal(n, 2);
});

// ---- R9-14: the schema ceiling of amountPerUnitRaw ----

test("schema: amountPerUnitRaw above MAX_SAFE_INTEGER — refused (the comments of dividends.mjs become true)", () => {
  assert.throws(
    () => validateEvent({
      type: "DIVIDEND_ACCRUAL", mint: SPYx, effectiveDate: "2026-06-18T00:00:00.000Z",
      status: "confirmed", sources: ["test"], amountPerUnitRaw: 2 ** 60, decimals: 8,
    }),
    (err) => err.name === "EventValidationError" && /amountPerUnitRaw|safe/i.test(err.message),
  );
});

// ---- R9-15: legacy journal canonicalization ----

test("journal: a record BEFORE canonicalization (lastEffective \"5.0\") + chain \"5\" — NO phantom, the record is canonicalized", async () => {
  const { parseScaledUiAmount } = await import("../src/issuer/scaled-ui.mjs");
  const settledFive = parseScaledUiAmount({
    owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    data: { parsed: { info: { decimals: 8, extensions: [{ extension: "scaledUiAmountConfig", state: {
      multiplier: "5", newMultiplier: 0, newMultiplierEffectiveTimestamp: 0,
    } }] } } },
  });
  const legacy = {
    lastEffective: "5.0",
    observedAt: "2026-06-01T00:00:00.000Z",
    events: [{
      type: "MULTIPLIER_CHANGE", mint: SPYx, effectiveDate: "2026-06-10T04:30:00.000Z",
      status: "confirmed", sources: ["legacy"], multiplierFrom: "1", multiplierTo: "5.0", reason: "On-chain rebase",
    }],
  };
  const r = planJournalStep(TOKEN, legacy, settledFive);
  assert.equal(r.event, null, "5.0 → 5 — the same value, not an event");
  assert.equal(r.entry.lastEffective, "5", "the record is canonicalized on read");
  assert.equal(r.replay.length, 1);
  assert.equal(r.replay[0].multiplierTo, "5", "the history is canonicalized too");
});
