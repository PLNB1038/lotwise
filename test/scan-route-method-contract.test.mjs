// Method semantics on the wallet-scan routes must not depend on the QUERY's validity.
// The method gate sat BELOW the address/mint validation: the canonical monitoring probe —
// a bare `HEAD /lots` with no query at all — fell into the 400 "address required" instead
// of the documented 405 + Allow: GET (docs/ERRORS.md promises the 405 unconditionally,
// without qualifying the query). The same gate now sits first on the route, and the Allow
// list is consistent across the route's TWO refusal sites: the shared method gate used to
// advertise "GET, HEAD" on /lots//accruals while the routes' own 405 promised "GET" —
// discovery advertised a method the route rejects on the very next probe (RFC 9110 §15.5.5:
// Allow is the resource's truth about itself).
import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/api/server.mjs";
import { buildDemoSnapshot } from "../src/events/demo-snapshot.mjs";

const snapshot = buildDemoSnapshot();
const GARBAGE = "not-a-base58-pubkey";

const demoBase = async () => {
  const server = await createApiServer({ registry: snapshot.registry, events: snapshot.events, demo: true });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
};

test("bare HEAD /lots (no query) answers 405 + Allow: GET, not the address 400", async () => {
  const { server, base } = await demoBase();
  try {
    const res = await fetch(`${base}/lots`, { method: "HEAD" });
    assert.equal(res.status, 405, "the documented probe refusal, not the 400 of a missing parameter");
    assert.equal(res.headers.get("allow"), "GET", "RFC 9110 §15.5.5: a 405 carries Allow");
  } finally {
    server.close();
  }
});

test("HEAD /lots with an invalid address answers 405 too — the gate does not read the query", async () => {
  const { server, base } = await demoBase();
  try {
    const res = await fetch(`${base}/lots?address=${GARBAGE}`, { method: "HEAD" });
    assert.equal(res.status, 405, "query validity must not shift the method semantics");
    assert.equal(res.headers.get("allow"), "GET");
  } finally {
    server.close();
  }
});

test("bare HEAD /accruals (no query) answers 405 + Allow: GET the same way", async () => {
  const { server, base } = await demoBase();
  try {
    const res = await fetch(`${base}/accruals`, { method: "HEAD" });
    assert.equal(res.status, 405, "the documented probe refusal, not the mint 400");
    assert.equal(res.headers.get("allow"), "GET");
  } finally {
    server.close();
  }
});

test("HEAD /accruals with an untracked symbol answers 405 too", async () => {
  const { server, base } = await demoBase();
  try {
    const res = await fetch(`${base}/accruals?symbol=NOPE&address=${GARBAGE}`, { method: "HEAD" });
    assert.equal(res.status, 405, "query validity must not shift the method semantics");
    assert.equal(res.headers.get("allow"), "GET");
  } finally {
    server.close();
  }
});

test("the generic method gate on /lots promises GET — the same list the route's own 405 carries", async () => {
  const { server, base } = await demoBase();
  try {
    for (const method of ["OPTIONS", "POST"]) {
      const res = await fetch(`${base}/lots?address=x`, { method });
      assert.equal(res.status, 405);
      assert.equal(res.headers.get("allow"), "GET", `${method}: Allow must not advertise HEAD, which the route refuses`);
    }
  } finally {
    server.close();
  }
});

test("the generic method gate on /accruals promises GET the same way", async () => {
  const { server, base } = await demoBase();
  try {
    const res = await fetch(`${base}/accruals`, { method: "OPTIONS" });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET");
  } finally {
    server.close();
  }
});

test("on other routes the shared gate keeps promising GET, HEAD (HEAD is really served there)", async () => {
  const { server, base } = await demoBase();
  try {
    const res = await fetch(`${base}/health`, { method: "OPTIONS" });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET, HEAD", "routes that mirror HEAD keep advertising it");
  } finally {
    server.close();
  }
});
