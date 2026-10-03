// One field, one type: the live registry's `verified` is a provenance STRING
// (data/tokens.json: "carried+rpc"), while the demo rows used to answer with a boolean
// false — a client typing the field against the live registry got string | boolean on the
// same served surface. The demo row is not issuer-confirmed either way: the honest value
// is the same literal "lotwise-demo-snapshot" marker that sourceUrl/sourceDecimals carry,
// in the type the field actually has.
import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/api/server.mjs";
import { buildDemoSnapshot } from "../src/events/demo-snapshot.mjs";
import { loadRegistry } from "../src/registry/registry.mjs";

const snapshot = buildDemoSnapshot();

const demoTokens = async () => {
  const server = await createApiServer({ registry: snapshot.registry, events: snapshot.events, demo: true });
  try {
    return await (await fetch(`http://127.0.0.1:${server.address().port}/tokens`)).json();
  } finally {
    server.close();
  }
};

test("demo /tokens `verified` carries the live field's type — a provenance string, not a second type", async () => {
  const live = await loadRegistry("data/tokens.json");
  const tokens = await demoTokens();
  assert.ok(live.length > 0, "the live registry loaded");
  assert.equal(typeof live[0].verified, "string", "the live `verified` is a provenance string (data/tokens.json)");
  for (const row of tokens) {
    assert.equal(typeof row.verified, "string", `${row.symbol}: the demo row must not introduce a second type for the field`);
    assert.equal(row.verified, "lotwise-demo-snapshot", "the demo marker, never a fabricated live claim");
  }
});
