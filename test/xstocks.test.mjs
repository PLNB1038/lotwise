import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchCurrentMultiplier, fetchMultiplierHistory, IssuerError } from "../src/issuer/xstocks.mjs";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const FIX = (name) => JSON.parse(readFileSync(path.join(dir, name), "utf8"));

const okRes = (payload) => ({ ok: true, status: 200, json: async () => payload });

test("current: SPYx Solana — the multiplier as a string, an empty pending is eaten", async () => {
  const cur = await fetchCurrentMultiplier("SPYx", "Solana", { fetcher: async () => okRes(FIX("xstocks-spyx-current.json")) });
  assert.equal(cur.currentMultiplier, "1.005714560286254");
  assert.equal(cur.pendingMultiplier, null); // newMultiplier: 0 = nothing awaits activation
  assert.equal(cur.activationDateTime, null);
  assert.equal(cur.reason, null);
});

test("current: a pending multiplier is passed through", async () => {
  const cur = await fetchCurrentMultiplier("SPYx", "Solana", {
    fetcher: async () => okRes({ currentMultiplier: 1.005714560286254, newMultiplier: 1.0071, activationDateTime: "2026-10-01T00:30:00.000Z", reason: "Dividend" }),
  });
  assert.equal(cur.pendingMultiplier, "1.0071");
  assert.equal(cur.activationDateTime, "2026-10-01T00:30:00.000Z");
  assert.equal(cur.reason, "Dividend");
});

test("history: the 4 live SPYx dividends (Ethereum) parse without float losses", async () => {
  const h = await fetchMultiplierHistory("SPYx", "Ethereum", { fetcher: async () => okRes(FIX("xstocks-spyx-history-eth.json")) });
  assert.equal(h.nodes.length, 4);
  assert.equal(h.hasNextPage, false);
  const [last] = h.nodes; // the API serves the newest on top
  assert.equal(last.reason, "Dividend");
  assert.equal(last.multiplier, "1.005714560286254");
  assert.equal(last.previousMultiplier, "1.003909240011759");
  assert.equal(last.activationDateTime, "2026-06-18T04:00:00.000Z");
  // the oldest event: from one
  const oldest = h.nodes[h.nodes.length - 1];
  assert.equal(oldest.previousMultiplier, "1");
  assert.equal(oldest.activationDateTime, "2025-10-31T23:55:00.000Z");
});

test("history: an empty history (TSLAx Solana) — a valid empty array", async () => {
  const h = await fetchMultiplierHistory("TSLAx", "Solana", { fetcher: async () => okRes(FIX("xstocks-tslax-history-empty.json")) });
  assert.deepEqual(h.nodes, []);
  assert.equal(h.hasNextPage, false);
});

test("an HTTP error is classified", async () => {
  await assert.rejects(
    () => fetchCurrentMultiplier("NOPE", "Solana", { fetcher: async () => ({ ok: false, status: 404, json: async () => ({}) }) }),
    (err) => err instanceof IssuerError && err.status === 404,
  );
});

test("broken payloads are rejected with a clear error", async () => {
  await assert.rejects(
    () => fetchCurrentMultiplier("SPYx", "Solana", { fetcher: async () => okRes({ wrong: true }) }),
    /unexpected multiplier payload/,
  );
  await assert.rejects(
    () => fetchMultiplierHistory("SPYx", "Solana", { fetcher: async () => okRes({ noNodes: true }) }),
    /unexpected history payload/,
  );
});
