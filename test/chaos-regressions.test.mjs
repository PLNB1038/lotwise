
// regression tests — chaos regression fixes.
//   C4-1 [P1]: a gateway without scaledUiAmountConfig = "no fact", not a "reset to 1" —
//              the journal diff fabricated a phantom X→1 and an eternal duplicate triplet.
//   C3-1 [P1]: an RPC URL with credentials leaked into 503 bodies and the boot log via err.message.
//   C3-2 [P2]: an SSRF bypass of the denylist by a host with a trailing dot (localhost.).
//   C3-3: X-Content-Type-Options: nosniff on all responses.
//   C2:   GeckoTerminal duplicate candles (the same ts) — dedup in dailyCandles.
import test from "node:test";
import assert from "node:assert/strict";
import { planJournalStep } from "../src/events/journal.mjs";
import { parseScaledUiAmount } from "../src/issuer/scaled-ui.mjs";
import { validateSubscription } from "../src/webhooks/subscriptions.mjs";
import { RpcClient, RpcError } from "../src/ingest/rpc.mjs";
import { GeckoTerminalClient } from "../src/price/geckoterminal.mjs";
import { createApiServer } from "../src/api/server.mjs";
import { loadRegistry } from "../src/registry/registry.mjs";

const MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const TOKEN = { mint: MINT, symbol: "TESTx" };

const mintState = (state) => ({
  owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  data: { parsed: { info: { decimals: 8, extensions: [{ extension: "scaledUiAmountConfig", state: { newMultiplierEffectiveTimestamp: 0, ...state } }] } } },
});
const settled = (m) => mintState({ multiplier: m, newMultiplier: 0 });
const rotation = (a, p) => mintState({
  multiplier: a, newMultiplier: p, newMultiplierEffectiveTimestamp: Date.UTC(2026, 5, 10) / 1000,
});
// The gateway "lost" the extension: the account is alive, but without scaledUiAmountConfig
const extDropped = () => ({
  owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  data: { parsed: { info: { decimals: 8, extensions: [{ extension: "mintCloseAuthority" }] } } },
});

// ---- C4-1 [P1]: extDrop = "no fact", not a "reset to 1" ----

test("journal: a gateway without an extension does NOT fabricate an X→1 reset — the record is untouched", () => {
  // boot A: an honest rotation 1→8 (the pending activated)
  const bootA = planJournalStep(TOKEN, null, parseScaledUiAmount(rotation("1", "8")));
  assert.ok(bootA.event, "the rotation observed");
  // boot B: the gateway degraded — the extension vanished, the parser returned the default "1"
  const bootB = planJournalStep(TOKEN, bootA.entry, parseScaledUiAmount(extDropped()));
  assert.equal(bootB.event, null, "a \"1\" without an extension — the parser default, not an observation");
  assert.equal(bootB.entry.lastEffective, "8", "the last FACT is preserved");
  assert.equal(bootB.entry.events.length, 1, "the history gained no phantom");
  // boot C: the truth returned (settled 8) — no return-duplicate
  const bootC = planJournalStep(TOKEN, bootB.entry, parseScaledUiAmount(settled("8")));
  assert.equal(bootC.event, null);
  assert.equal(bootC.entry.events.length, 1, "no eternal duplicate triplet arose (the C4 marathon: 1221 findings of this class)");
});

test("journal: a first observation of an extension-less mint — no record (no facts — no record)", () => {
  const r = planJournalStep(TOKEN, null, parseScaledUiAmount(extDropped()));
  assert.equal(r.event, null);
  assert.equal(r.entry, null, "an empty {lastEffective:1} record is not persisted");
});

// ---- C3-1 [P1]: URL redaction out of RPC errors ----

test("rpc: err.message with URL credentials does NOT leave the client — redaction at the boundary", async () => {
  const leak = "Request cannot be constructed from a URL that includes credentials: http://user:supersecret@rpc.example/x";
  const client = new RpcClient({
    endpoint: "http://user:supersecret@rpc.example/x",
    fetcher: async () => { throw new TypeError(leak); },
    sleep: async () => {}, minIntervalMs: 0, maxRetries: 0,
  });
  await assert.rejects(() => client.call("m", []), (err) => {
    assert.ok(!err.message.includes("supersecret"), "credentials do not leak");
    assert.ok(!/https?:\/\//.test(err.message), "the full URL does not leak");
    return err instanceof RpcError && err.kind === "network";
  });
});

test("rpc: a provider JSON-RPC error text with a URL — redacted too", async () => {
  const client = new RpcClient({
    endpoint: "https://rpc.example",
    fetcher: async () => new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32015, message: "failed for https://k.example/?api-key=LEAKED" } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
    sleep: async () => {}, minIntervalMs: 0, maxRetries: 0,
  });
  await assert.rejects(() => client.call("m", []), (err) => {
    assert.ok(!err.message.includes("LEAKED"), "the key from the provider text does not leak");
    return err.code === -32015;
  });
});

// ---- C3-2 [P2]: a trailing dot of the host ----

test("subscriptions: localhost. (a trailing dot) and 127.0.0.1. are rejected", () => {
  for (const url of ["http://localhost.:8790/hook", "http://LOCALHOST./hook", "http://127.0.0.1./hook"]) {
    assert.throws(
      () => validateSubscription({ id: "wh_x", url, symbols: "*", secret: "s", createdAt: "2026-09-23T00:00:00.000Z", active: true }),
      (err) => /url/.test(err.field ?? ""),
      `${url} must be rejected`,
    );
  }
  assert.doesNotThrow(() =>
    validateSubscription({ id: "wh_x", url: "https://example.com./hook", symbols: "*", secret: "s", createdAt: "2026-09-23T00:00:00.000Z", active: true }),
    "a public FQDN in root form — legitimate");
});

// ---- C3-3: nosniff ----

test("api: every response carries X-Content-Type-Options: nosniff", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const server = await createApiServer({ registry, events: [] });
  const { port } = server.address();
  try {
    for (const path of ["/health", "/", "/nope"]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff", `${path}: nosniff is present`);
    }
  } finally {
    server.close();
  }
});

// ---- C2: GeckoTerminal duplicate candles ----

test("gecko: duplicate candles (the same ts) collapse — the last record wins", async () => {
  let calls = 0;
  const fetcher = async (url) => {
    calls++;
    if (String(url).includes("/pools") && !String(url).includes("/ohlcv")) {
      return new Response(JSON.stringify({ data: { attributes: {} } }), { status: 200 }); // not used in this test
    }
    return new Response(JSON.stringify({
      data: { attributes: { ohlcv_list: [
        [1774224000, "650.9", "675.1", "638.9", "658.9"], // a duplicate, the OLD version of the day
        [1774224000, "658.9", "680.0", "640.0", "670.0"], // a duplicate, the NEW version of the same day
        [1774310400, "670.0", "690.0", "660.0", "680.0"],
      ] } },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const gt = new GeckoTerminalClient({ fetcher, sleep: async () => {} });
  const candles = await gt.dailyCandles("PoolAddr");
  assert.equal(candles.length, 2, "the duplicate collapsed");
  assert.deepEqual(candles.map((c) => c.c), ["670.0", "680.0"], "the last record of the day won (the GT overwrite semantics)");
  assert.ok(candles[0].ts < candles[1].ts, "the ascending order is preserved");
});
