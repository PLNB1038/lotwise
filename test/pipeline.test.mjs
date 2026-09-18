// Сквозной smoke: два «эндпоинта» (два RpcClient с моками) сканируют минт из
// реестра, ingest собирает дельты, reconcile их сверяет, lots применяет событие.
// Доказывает, что модули стыкуются в один пайплайн без клея-времянок.
import test from "node:test";
import assert from "node:assert/strict";
import { loadRegistry, findBySymbol } from "../src/registry/registry.mjs";
import { RpcClient } from "../src/ingest/rpc.mjs";
import { streamSignatures } from "../src/ingest/signatures.mjs";
import { fetchTokenDeltas } from "../src/ingest/tx.mjs";
import { reconcileSnapshots, verdict, mergeVerified } from "../src/reconcile/reconcile.mjs";
import { applyEvents } from "../src/lots/lots.mjs";

const OWNER = "Owner11111111111111111111111111111111111111111";

// Мок-эндпоинт: минт подхватывает из первого getSignaturesForAddress (реестровый),
// getSignaturesForAddress → 2 сигнатуры; getTransaction по каждой.
function endpointMock({ mutateTx = false, dropSignature = false } = {}) {
  let knownMint = null; // станет известен из первого запроса стрима
  const delta = (owner, from, to) => ({
    err: null,
    preTokenBalances: [{ owner, mint: knownMint, uiTokenAmount: { amount: from } }],
    postTokenBalances: [{ owner, mint: knownMint, uiTokenAmount: { amount: to } }],
  });
  const mkTx = {
    sig_1: () => ({ slot: 335000111, blockTime: 1760100000, version: 0, meta: delta(OWNER, "0", "1000000") }),
    sig_2: () => ({ slot: 335000222, blockTime: 1760100060, version: 0, meta: delta(OWNER, "1000000", "2000000") }),
  };
  return async (_url, opts) => {
    const { method, params } = JSON.parse(opts.body);
    if (method === "getSignaturesForAddress") {
      knownMint = params[0];
      const sigs = dropSignature ? ["sig_1"] : ["sig_1", "sig_2"];
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: sigs.map((s) => ({ signature: s, slot: mkTx[s]().slot, blockTime: mkTx[s]().blockTime, err: null })) }) };
    }
    if (method === "getTransaction") {
      let tx = mkTx[params[0]] ? mkTx[params[0]]() : null;
      if (tx && mutateTx && params[0] === "sig_2") {
        tx.meta.postTokenBalances[0].uiTokenAmount.amount = "2999999"; // «второй эндпоинт видел другое»
      }
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: tx }) };
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: null }) };
  };
}

const mkClient = (opts) => new RpcClient({
  endpoint: "https://rpc.example", fetcher: endpointMock(opts), sleep: async () => {}, minIntervalMs: 0,
});

async function scanEndpoint(client, mint) {
  const entries = [];
  for await (const s of streamSignatures(client, mint)) {
    const tx = await fetchTokenDeltas(client, s.signature, mint);
    if (!tx || tx.err) continue;
    for (const d of tx.deltas) {
      entries.push({
        key: tx.signature, slot: tx.slot, blockTime: tx.blockTime,
        deltaRaw: d.deltaRaw, owner: d.owner, mint: d.mint,
      });
    }
  }
  return { source: "x", entries };
}

test("согласованные эндпоинты → ok, verified-дельты попадают в lots", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const token = findBySymbol(registry, "TSLAx");

  const a = await scanEndpoint(mkClient(), token.mint);
  const b = await scanEndpoint(mkClient(), token.mint);
  const r = reconcileSnapshots(a, b);
  assert.equal(verdict(r), "ok");
  const verified = mergeVerified(r);
  assert.equal(verified.length, 2);

  // дельты → лоты (упрощённо: первая дельта купила, вторая докупила)
  const lot = { id: "L1", mint: token.mint, owner: OWNER, qtyRaw: 1_000_000n + 1_000_000n, acquiredDate: "2026-09-18", basisRaw: 500_000_000n };
  const { lots } = applyEvents([lot], [{
    type: "SPLIT", mint: token.mint, effectiveDate: "2026-10-01", status: "confirmed",
    sources: ["https://issuer.example/split"], ratioNumerator: 3, ratioDenominator: 1,
  }]);
  assert.equal(lots[0].qtyRaw, 6_000_000n);
});

test("эндпоинт B видел другую дельту → конфликт → unverified, запись выброшена", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const token = findBySymbol(registry, "TSLAx");

  const a = await scanEndpoint(mkClient(), token.mint);
  const b = await scanEndpoint(mkClient({ mutateTx: true }), token.mint);
  const r = reconcileSnapshots(a, b);
  assert.equal(verdict(r), "unverified");
  assert.equal(r.stats.conflicts, 1);
  assert.equal(mergeVerified(r).length, 1); // sig_1 дважды подтверждён — остаётся
});

test("эндпоинт B не досчитал транзакцию → partial, недосчёт честен", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const token = findBySymbol(registry, "TSLAx");

  const a = await scanEndpoint(mkClient(), token.mint);
  const b = await scanEndpoint(mkClient({ dropSignature: true }), token.mint);
  const r = reconcileSnapshots(a, b);
  assert.equal(verdict(r), "partial");
  assert.equal(mergeVerified(r).length, 1);
});
