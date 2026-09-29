// The decimals drift between a declaration and the registry (data/tokens.json is the
// authority, a declaration's `decimals` is display metadata) used to live only in the boot
// console.warn — an API consumer saw the drifted metadata ride into the accrual rows
// without any flag, and an operator who does not watch the boot log never hears about it.
// The loader now returns the drift and /health carries it: declarations.decimalsDrift, one
// entry per (symbol, declared value), capped like the other loader aggregates; an empty
// array means "no drift". Drift is NOT unavailability: the file loads and accrues, so
// X-Declarations-Unavailable stays silent — the header keeps meaning exactly "the channel
// is down".
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApiServer } from "../src/api/server.mjs";
import { loadRegistry } from "../src/registry/registry.mjs";
import { loadDeclarationsFile } from "../src/events/declarations-file.mjs";

const OWNER = "9BB7Tt5uW5QbAorLkF3Hn1P2mGcXvcDdR7y8LbT9KdUu"; // valid base58, as elsewhere in the suite
const declPath = (dir) => path.join(dir, "declarations.json");
const newDir = () => mkdtempSync(path.join(tmpdir(), "lw-drift-"));

const quietLoad = (p, registry) => {
  const orig = console.warn;
  console.warn = () => {};
  try {
    return loadDeclarationsFile(p, registry);
  } finally {
    console.warn = orig;
  }
};

// the stats object EXACTLY as scripts/serve.mjs builds it (ok is a 1|0 number — JSON-stable)
const statsOf = (r) => ({ loaded: r.loaded, ok: r.ok ? 1 : 0, superseded: r.superseded, decimalsDrift: r.decimalsDrift });

const startServer = async (overrides = {}) => {
  const registry = await loadRegistry("data/tokens.json");
  const server = await createApiServer({
    registry,
    walletScanner: async () => ({ owner: OWNER, signatures: 0, fetched: 0, skipped: [], truncated: false, accounts: new Map(), txs: [] }),
    ...overrides,
  });
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
};

test("/health mirrors a loaded file's decimals drift — the API consumer sees what the boot log warns", async () => {
  const dir = newDir();
  const p = declPath(dir);
  writeFileSync(p, JSON.stringify([
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 6, sourceUrl: "https://issuer.example/q2" }, // registry SPYx is 8
  ]));
  const registry = await loadRegistry("data/tokens.json");
  const r = quietLoad(p, registry);
  assert.equal(r.ok, true, "the drift does not refuse the file — visibility, not refusal");
  const { server, base } = await startServer({ declarationsStats: statsOf(r) });
  try {
    const h = await (await fetch(`${base}/health`)).json();
    assert.deepEqual(h.declarations.decimalsDrift, [{ symbol: "SPYX", declared: 6, registry: 8 }]);
    assert.equal(h.declarations.ok, 1, "a drift is a loaded file — the channel is up");
  } finally {
    server.close();
  }
});

test("/health: a file without drift carries an EMPTY array — 'no drift' is distinguishable from a pre-drift shape", async () => {
  const dir = newDir();
  const p = declPath(dir);
  writeFileSync(p, JSON.stringify([
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/q2" }, // matches the registry
  ]));
  const registry = await loadRegistry("data/tokens.json");
  const r = quietLoad(p, registry);
  assert.deepEqual(r.decimalsDrift, []);
  const { server, base } = await startServer({ declarationsStats: statsOf(r) });
  try {
    const h = await (await fetch(`${base}/health`)).json();
    assert.deepEqual(h.declarations.decimalsDrift, []);
  } finally {
    server.close();
  }
});

test("a drift does not fire X-Declarations-Unavailable — the header keeps meaning 'the channel is down'", async () => {
  const drifted = newDir();
  const pDrifted = declPath(drifted);
  writeFileSync(pDrifted, JSON.stringify([
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 6, sourceUrl: "https://issuer.example/q2" },
  ]));
  const registry = await loadRegistry("data/tokens.json");
  const { server, base } = await startServer({ declarationsStats: statsOf(quietLoad(pDrifted, registry)) });
  try {
    const r = await fetch(`${base}/accruals?symbol=SPYx&address=${OWNER}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-declarations-unavailable"), null,
      "the file loads and accrues — drift is visibility metadata, not unavailability");
  } finally {
    server.close();
  }
});

test("a refused file still answers the existing way: ok 0, an empty drift array, the header fires", async () => {
  const broken = newDir();
  const pBroken = declPath(broken);
  writeFileSync(pBroken, JSON.stringify([
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/v1" },
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "4000000", decimals: 8, sourceUrl: "https://issuer.example/v2" }, // same-day conflict — the whole file refuses
  ]));
  const registry = await loadRegistry("data/tokens.json");
  const r = quietLoad(pBroken, registry);
  assert.equal(r.ok, false);
  const { server, base } = await startServer({ declarationsStats: statsOf(r) });
  try {
    const h = await (await fetch(`${base}/health`)).json();
    assert.equal(h.declarations.ok, 0, "the existing reason semantics are untouched");
    assert.deepEqual(h.declarations.decimalsDrift, [], "a refused file reports no drift — nothing was validated");
    const down = await fetch(`${base}/accruals?symbol=SPYx&address=${OWNER}`);
    assert.equal(down.headers.get("x-declarations-unavailable"), "1", "the degradation header behaves exactly as before");
  } finally {
    server.close();
  }
});

// The wiring of serve.mjs cannot be booted in a unit test (the live boot needs RPC), so the
// proxy is pinned at the source level: the stats line must carry the loader's decimalsDrift
// into declarations — otherwise the field exists in the loader and dies before /health.
test("serve.mjs proxies the loader's decimalsDrift into declarations stats (/health)", async () => {
  const src = await readFile(new URL("../scripts/serve.mjs", import.meta.url), "utf8");
  assert.match(src, /decimalsDrift:\s*loadedDeclarations\.decimalsDrift/,
    "the declarations stats line must carry the loader's decimalsDrift into /health");
});
