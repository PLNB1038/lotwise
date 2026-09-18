import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/api/server.mjs";
import { multiplierHistoryToEvents, bindMintAndValidate } from "../src/events/normalize-xstocks.mjs";
import { loadRegistry } from "../src/registry/registry.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const SPYx = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";

const historyNodes = JSON.parse(readFileSync(path.join(dir, "xstocks-spyx-history-eth.json"), "utf8")).nodes;
const events = bindMintAndValidate(multiplierHistoryToEvents(historyNodes, { symbol: "SPYx" }), SPYx);

async function withServer(fn) {
  const registry = await loadRegistry("data/tokens.json");
  const server = await createApiServer({ registry, events });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("/health отвечает статистикой", async () => {
  await withServer(async (base) => {
    const r = await (await fetch(`${base}/health`)).json();
    assert.equal(r.ok, true);
    assert.equal(r.tokens, 26);
    assert.equal(r.events, 4);
  });
});

test("/tokens отдаёт реестр и фильтруется по issuer", async () => {
  await withServer(async (base) => {
    const all = await (await fetch(`${base}/tokens`)).json();
    assert.equal(all.length, 26);
    const tessera = await (await fetch(`${base}/tokens?issuer=tessera`)).json();
    assert.equal(tessera.length, 3);
    assert.ok(tessera.every((t) => t.issuer === "tessera"));
  });
});

test("/events по символу: 4 дивиденда SPYx", async () => {
  await withServer(async (base) => {
    const list = await (await fetch(`${base}/events?symbol=SPYx`)).json();
    assert.equal(list.length, 4);
    assert.ok(list.every((e) => e.type === "MULTIPLIER_CHANGE"));
    const filtered = await (await fetch(`${base}/events?symbol=SPYx&type=NOPE`)).json();
    assert.deepEqual(filtered, []);
  });
});

test("/events без mint/symbol — понятная 400", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/events`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /mint or symbol required/);
  });
});

test("/multiplier: до событий = 1, после всех = 1.0057…, scaledQty целочисленный", async () => {
  await withServer(async (base) => {
    const before = await (await fetch(`${base}/multiplier?symbol=SPYx&date=2025-10-30`)).json();
    assert.equal(before.multiplier, "1");
    assert.equal(before.sampleScaledQty.exact, true);

    const after = await (await fetch(`${base}/multiplier?symbol=SPYx&date=2026-07-01`)).json();
    assert.equal(after.multiplier, "1.005714560286254");
    assert.equal(after.events, 4);
    assert.equal(after.sampleScaledQty.whole, "100571456"); // raw=100000000 × 1.0057…
    assert.equal(after.sampleScaledQty.exact, false); // пыль честно показана
  });
});

test("неизвестный маршрут — 404 со списком эндпоинтов", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(Array.isArray(body.endpoints));
  });
});
