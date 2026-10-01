// The "not configured" 503s carried no kind: a retry-policy consumer reading
// docs/ERRORS.md could not classify them (the kind catalog had no entry). They are the
// most stable refusals the API has — the deployment lacks the component and no retry
// changes that — so every missing-component path carries kind: "not-configured":
// the on-chain reader (/onchain), the wallet scanner (/lots, /accruals) and the price
// provider (/crosscheck). Pinned on a demo boot (where all three are absent by design)
// and on a live-shaped boot with no components wired.
import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/api/server.mjs";
import { buildDemoSnapshot } from "../src/events/demo-snapshot.mjs";

const snapshot = buildDemoSnapshot();
const ADDR = "9BB7Tt5uW5QbAorLkF3Hn1P2mGcXvcDdR7y8LbT9KdUu";

const ROUTES = [
  ["/onchain?symbol=DEMOx", "the on-chain reader"],
  [`/lots?address=${ADDR}`, "the wallet scanner"],
  [`/accruals?symbol=DEMOx&address=${ADDR}`, "the wallet scanner"],
  ["/crosscheck?symbol=DEMOx", "the price provider"],
];

test("demo boot: every not-configured 503 carries kind 'not-configured'", async () => {
  const server = await createApiServer({ registry: snapshot.registry, events: snapshot.events, demo: true });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [route] of ROUTES) {
      const res = await fetch(base + route);
      assert.equal(res.status, 503, route);
      const body = await res.json();
      assert.equal(body.kind, "not-configured", `${route}: the stable kind is on the wire`);
      assert.ok(body.error, `${route}: the honest error text is still there`);
    }
  } finally {
    server.close();
  }
});

test("live boot without components wired: the same 503s carry kind 'not-configured'", async () => {
  // demo: false and no readers — the "… not configured" face of a plain boot shares the kind
  const server = await createApiServer({ registry: snapshot.registry, events: snapshot.events });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [route] of ROUTES) {
      const res = await fetch(base + route);
      assert.equal(res.status, 503, route);
      const body = await res.json();
      assert.equal(body.kind, "not-configured", `${route}: the kind does not depend on the demo flag`);
      assert.match(body.error, /not configured/, `${route}: the live wording is unchanged`);
    }
  } finally {
    server.close();
  }
});
