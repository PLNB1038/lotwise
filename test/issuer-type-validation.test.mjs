// formerly round13-truth.test.mjs
// Round 13 regression tests — the 24.09 hunt by two agents (README-vs-code + the watch list).
//   R13-1 [P3] redactUrls was case-sensitive: --rpc HTTP://user:SECRET@… — undici embeds
//            the URL verbatim (the upper-case scheme), the R11 fix missed it, credentials rode
//            into the 503 body of the visitor. The C3-1 tail, found by the watch agent.
//   R13-2 [P3] /tokens?issuer= and /events?type= silently served 200 [] on unknown
//            values — the README itself names the issuers "xStocks/Backed 16", and the
//            "400 instead of emptiness" contract worked only for symbol/mint (the ROUND7 #1 class).
//   R13-3 [P4] DNS garbage in --host ("no-such-host.invalid") passed the synchronous
//            lexical guard and burned through the whole boot I/O (~15 RPC calls + the xStocks history),
//            dying only at listen. Resolve BEFORE the boot, a refusal in the ROUND9 #1 spirit.
//   R13-4 [P4] the README architecture did not mention src/cli/ — fixed in the README (not a test).
import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/api/server.mjs";
import { RpcClient, RpcError } from "../src/ingest/rpc.mjs";

const MINT_A = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const MINT_B = "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp";

const registry = [
  { symbol: "SPYx", name: "S&P 500 xStock", issuer: "backed", mint: MINT_A, decimals: 8 },
  { symbol: "T-SpaceX", name: "Tessera SpaceX", issuer: "tessera", mint: MINT_B, decimals: 9 },
];
const events = [
  { type: "MULTIPLIER_CHANGE", mint: MINT_A, effectiveDate: "2026-06-10T00:00:00.000Z", status: "confirmed", sources: ["test"], multiplierFrom: "1", multiplierTo: "2", reason: "test rebase" },
];

async function withServer(fn) {
  const server = await createApiServer({ registry, events });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

// ---- R13-2 [P3]: issuer/type filters — an honest 400 with a dictionary, not a silent [] ----

test("/tokens?issuer=Backed (the README spelling) — 400 with a dictionary of valid keys, not 200 []", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/tokens?issuer=${encodeURIComponent("Backed")}`);
    assert.equal(res.status, 400, "an unknown issuer = a refusal with a reason (the symbol/mint convention)");
    const body = await res.json();
    assert.match(body.error, /Backed/, "the reason names the input itself");
    assert.match(body.error, /backed/, "the dictionary of valid keys is visible in the reason");
  });
});

test("/tokens?issuer=bogus — 400; ?issuer=backed — 200 with the family tokens; no filter — the whole registry", async () => {
  await withServer(async (base) => {
    const bad = await fetch(`${base}/tokens?issuer=bogus`);
    assert.equal(bad.status, 400);
    const ok = await fetch(`${base}/tokens?issuer=backed`);
    assert.equal(ok.status, 200);
    const list = await ok.json();
    assert.ok(Array.isArray(list) && list.length > 0, "a valid filter is not empty");
    assert.ok(list.every((t) => t.issuer === "backed"));
    const all = await fetch(`${base}/tokens`);
    assert.equal((await all.json()).length, registry.length);
  });
});

test("/events?type=BOGUS — 400 with a dictionary of the six types; a valid type — 200", async () => {
  await withServer(async (base) => {
    const bad = await fetch(`${base}/events?symbol=SPYx&type=BOGUS`);
    assert.equal(bad.status, 400, "a silent [] on a garbage type is indistinguishable from \"no events\"");
    const body = await bad.json();
    assert.match(body.error, /BOGUS/);
    assert.match(body.error, /SPLIT/);
    assert.match(body.error, /MULTIPLIER_CHANGE/);
    const ok = await fetch(`${base}/events?symbol=SPYx&type=MULTIPLIER_CHANGE`);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).length, 1);
  });
});

// ---- R13-1 [P3]: URL redaction — an upper-case scheme ----

test("rpc: URL credentials with an UPPER-CASE scheme (HTTP://) are redacted too — they do not leave the client", async () => {
  const leak = "Request cannot be constructed from a URL that includes credentials: HTTP://user:TOPSECRET@127.0.0.1:9/x";
  const client = new RpcClient({
    endpoint: "HTTP://user:TOPSECRET@127.0.0.1:9/x",
    fetcher: async () => { throw new TypeError(leak); },
    sleep: async () => {}, minIntervalMs: 0, maxRetries: 0,
  });
  await assert.rejects(() => client.call("m", []), (err) => {
    assert.ok(!err.message.includes("TOPSECRET"), `credentials do not leak (got: ${err.message})`);
    assert.ok(!/https?:\/\//i.test(err.message), "the full URL does not leak in any scheme case");
    return err instanceof RpcError && err.kind === "network";
  });
});

// ---- R13-3 [P4]: the DNS resolve of --host BEFORE the boot ----

test("flags: assertHostResolvable — an unresolvable host yields a ServeArgsError with the DNS code", async () => {
  const { assertHostResolvable, ServeArgsError } = await import("../src/cli/flags.mjs");
  await assert.rejects(
    () => assertHostResolvable("no-such-host.invalid", async () => {
      const e = new Error("getaddrinfo ENOTFOUND no-such-host.invalid");
      e.code = "ENOTFOUND";
      throw e;
    }),
    (err) => err instanceof ServeArgsError && err.flag === "--host" && /ENOTFOUND/.test(err.message),
  );
});

test("flags: assertHostResolvable — a resolvable host passes without a refusal", async () => {
  const { assertHostResolvable } = await import("../src/cli/flags.mjs");
  await assertHostResolvable("127.0.0.1", async () => ({ address: "127.0.0.1" }));
});
