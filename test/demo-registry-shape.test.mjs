// Demo /tokens rows used to have 5 fields where live rows have 8 (live adds sourceUrl,
// verified, sourceDecimals): a client typing the row shape against the live registry read
// undefined on --demo, and vice versa. The demo rows now carry exactly the live field set,
// filled with honest demo values — the registry is a served surface, not just engine input:
//   - sourceUrl, sourceDecimals AND verified carry the literal "lotwise-demo-snapshot"
//     marker (the demo events' own convention: never a fabricated issuer URL or source
//     name); verified is the marker STRING because the live field is a provenance string
//     ("carried+rpc") — a boolean here would give the served field a second type, while
//     the marker says "not issuer-confirmed" without the break;
//   - sourceDecimals agrees with the row's decimals: the snapshot's own registry
//     declaration is the only decimals authority behind the demo set.
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

test("demo /tokens rows carry exactly the live row field set (8 fields, no drift)", async () => {
  const live = await loadRegistry("data/tokens.json");
  const liveKeys = Object.keys(live[0]).sort();
  const tokens = await demoTokens();
  assert.equal(tokens.length, snapshot.registry.length);
  for (const row of tokens) {
    assert.deepEqual(Object.keys(row).sort(), liveKeys, `${row.symbol}: the row shape matches the live registry's`);
  }
});

test("demo /tokens row values are honest demo markers, not fabricated live claims", async () => {
  const tokens = await demoTokens();
  for (const row of tokens) {
    assert.equal(row.sourceUrl, "lotwise-demo-snapshot", "the demo source marker, never a real-looking issuer URL");
    assert.equal(row.verified, "lotwise-demo-snapshot", "the demo marker string — the live field's type, never a fabricated live claim");
    assert.equal(row.sourceDecimals, "lotwise-demo-snapshot", "the snapshot's own registry declaration is the decimals source");
    assert.equal(row.decimals, row.issuer === "tessera" ? 9 : 6,
      `${row.symbol}: the issuer family's decimals (9 = PreStocks/Tessera, 6 = Backpack), the parameter the README teaches to check`);
  }
});
