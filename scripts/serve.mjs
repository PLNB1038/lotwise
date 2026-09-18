// Запуск Lotwise API с живыми данными: реестр + история множителей xStocks + on-chain план.
// Использование: node scripts/serve.mjs [--port 8787] [--rpc https://api.mainnet-beta.solana.com]
import { loadRegistry } from "../src/registry/registry.mjs";
import { fetchMultiplierHistory } from "../src/issuer/xstocks.mjs";
import { multiplierHistoryToEvents, bindMintAndValidate } from "../src/events/normalize-xstocks.mjs";
import { createApiServer } from "../src/api/server.mjs";
import { RpcClient } from "../src/ingest/rpc.mjs";
import { parseScaledUiAmount } from "../src/issuer/scaled-ui.mjs";

const port = Number(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 8787);
const rpcUrl = process.argv.includes("--rpc") ? process.argv[process.argv.indexOf("--rpc") + 1] : "https://api.mainnet-beta.solana.com";

const registry = await loadRegistry("data/tokens.json");
const events = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// xStocks: тянем историю по каждому символу (Ethereum-план несёт полные события,
// Solana-эндпоинт историю не бэкфиллит — verified 18.09)
for (const t of registry.filter((x) => x.issuer === "backed")) {
  try {
    const h = await fetchMultiplierHistory(t.symbol, "Ethereum");
    if (h.nodes.length > 0) {
      events.push(...bindMintAndValidate(multiplierHistoryToEvents(h.nodes, { symbol: t.symbol, network: "Ethereum" }), t.mint));
      console.log(`[serve] ${t.symbol}: ${h.nodes.length} событий множителя`);
    }
  } catch (err) {
    console.warn(`[serve] ${t.symbol}: источник недоступен (${err.message}) — пропускаем, fail-closed`);
  }
  await sleep(300); // вежливость к публичному API
}

// On-chain план (Scaled UI Amount): публичный RPC, кэш 10 минут на минт —
// витрина дёргает /onchain на каждый выбор токена, а квота публичных RPC конечна
const rpc = new RpcClient({ endpoint: rpcUrl });
const CACHE_TTL_MS = 10 * 60 * 1000;
const onchainCache = new Map(); // mint -> { at, data }
const inflight = new Map(); // mint -> Promise (дедуп параллельных запросов)

const onchainReader = async (mint) => {
  const hit = onchainCache.get(mint);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  if (!inflight.has(mint)) {
    inflight.set(
      mint,
      rpc
        .call("getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "confirmed" }])
        .then((result) => parseScaledUiAmount(result.value))
        .then((data) => {
          onchainCache.set(mint, { at: Date.now(), data });
          return data;
        })
        .finally(() => inflight.delete(mint)),
    );
  }
  return inflight.get(mint);
};

const server = await createApiServer({ registry, events, port, onchainReader });
console.log(`\n[serve] Lotwise API: http://127.0.0.1:${server.address().port}`);
console.log(`[serve] витрина: http://127.0.0.1:${server.address().port}/`);
console.log(`[serve] токенов: ${registry.length}, событий: ${events.length}, on-chain RPC: ${rpcUrl}`);
console.log(`[serve] попробуй: / | /health | /tokens?issuer=tessera | /events?symbol=SPYx | /multiplier?symbol=SPYx&date=2026-07-01 | /onchain?symbol=SPYx`);
