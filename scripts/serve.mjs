// Запуск Lotwise API с живыми данными: реестр + история множителей xStocks.
// Использование: node scripts/serve.mjs [--port 8787]
import { loadRegistry } from "../src/registry/registry.mjs";
import { fetchMultiplierHistory } from "../src/issuer/xstocks.mjs";
import { multiplierHistoryToEvents, bindMintAndValidate } from "../src/events/normalize-xstocks.mjs";
import { createApiServer } from "../src/api/server.mjs";

const port = Number(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 8787);

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

const server = await createApiServer({ registry, events, port });
console.log(`\n[serve] Lotwise API: http://127.0.0.1:${server.address().port}`);
console.log(`[serve] токенов: ${registry.length}, событий: ${events.length}`);
console.log(`[serve] попробуй: /health | /tokens?issuer=tessera | /events?symbol=SPYx | /multiplier?symbol=SPYx&date=2026-07-01`);
