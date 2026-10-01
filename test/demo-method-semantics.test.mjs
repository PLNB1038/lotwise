// Method semantics must not depend on configuration. On a --demo boot the wallet routes
// have no scanner, and the !walletScanner 503 used to precede the GET-only gate: a HEAD
// probe answered 503 "the demo instance serves a static snapshot…" where docs/ERRORS.md
// promises "a HEAD probe answers 405 with Allow: GET without running a scan" (a live boot
// answered 405 — the promise silently depended on how the server was booted). The method
// gate now precedes the not-configured check; pinned here on the demo boot, the one a
// test can start without RPC.
import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/api/server.mjs";
import { buildDemoSnapshot } from "../src/events/demo-snapshot.mjs";

const snapshot = buildDemoSnapshot();
const ADDR = "9BB7Tt5uW5QbAorLkF3Hn1P2mGcXvcDdR7y8LbT9KdUu"; // valid base58, as elsewhere in the suite

const demoBase = async () => {
  const server = await createApiServer({ registry: snapshot.registry, events: snapshot.events, demo: true });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
};

test("demo boot: HEAD /lots answers 405 + Allow: GET — the method gate precedes the scanner check", async () => {
  const { server, base } = await demoBase();
  try {
    const res = await fetch(`${base}/lots?address=${ADDR}`, { method: "HEAD" });
    assert.equal(res.status, 405, "the documented HEAD refusal, not the not-configured 503");
    assert.equal(res.headers.get("allow"), "GET", "RFC 9110 §15.5.5: a 405 carries Allow");
  } finally {
    server.close();
  }
});

test("demo boot: HEAD /accruals answers 405 + Allow: GET the same way", async () => {
  const { server, base } = await demoBase();
  try {
    const res = await fetch(`${base}/accruals?symbol=DEMOx&address=${ADDR}`, { method: "HEAD" });
    assert.equal(res.status, 405, "the documented HEAD refusal, not the not-configured 503");
    assert.equal(res.headers.get("allow"), "GET");
  } finally {
    server.close();
  }
});

test("demo boot: POST /lots keeps the generic 405 + Allow: GET, HEAD (the shared gate is untouched)", async () => {
  const { server, base } = await demoBase();
  try {
    const res = await fetch(`${base}/lots?address=${ADDR}`, { method: "POST" });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET, HEAD");
  } finally {
    server.close();
  }
});
