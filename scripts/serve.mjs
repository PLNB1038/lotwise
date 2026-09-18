// Запуск Lotwise API с живыми данными: реестр + история множителей xStocks + on-chain план.
// Использование: node scripts/serve.mjs [--port 8787] [--rpc https://api.mainnet-beta.solana.com]
import { loadRegistry } from "../src/registry/registry.mjs";
import { fetchMultiplierHistory } from "../src/issuer/xstocks.mjs";
import { multiplierHistoryToEvents, bindMintAndValidate } from "../src/events/normalize-xstocks.mjs";
import { createApiServer } from "../src/api/server.mjs";
import { RpcClient } from "../src/ingest/rpc.mjs";
import { parseScaledUiAmount } from "../src/issuer/scaled-ui.mjs";
import { scanWallet } from "../src/wallet/scan.mjs";
import { GeckoTerminalClient } from "../src/price/geckoterminal.mjs";
import { journalTransition } from "../src/events/normalize-onchain.mjs";
import { readFileSync, writeFileSync } from "node:fs";

const port = Number(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 8787);
const host = process.argv.includes("--host") ? process.argv[process.argv.indexOf("--host") + 1] : "127.0.0.1";
const rpcUrl = process.argv.includes("--rpc") ? process.argv[process.argv.indexOf("--rpc") + 1] : "https://api.mainnet-beta.solana.com";
const maxTxs = Number(process.argv.includes("--max-txs") ? process.argv[process.argv.indexOf("--max-txs") + 1] : 300);

const registry = await loadRegistry("data/tokens.json");
const events = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpcForJournal = new RpcClient({ endpoint: rpcUrl });

// On-chain журнал: у PreStocks/Backpack нет API истории эмитента — их корп-события
// живут прямо в минте (scaledUiAmountConfig). Бэкфилл при первом наблюдении,
// далее дифф от прошлой эффективной величины. Живые находки 19.09: SPACEX ×5 (10.06),
// OPENAI ×1.4861347 (17.07). Журнал — runtime-состояние, из цепи восстанавливается.
const journalPath = "data/onchain-journal.json";
let journal = {};
try {
  journal = JSON.parse(readFileSync(journalPath, "utf8"));
} catch {
  // первый запуск — пустой журнал, бэкфилл из цепи
}
for (const t of registry.filter((x) => x.issuer !== "backed")) {
  try {
    const raw = await rpcForJournal.call("getAccountInfo", [t.mint, { encoding: "jsonParsed", commitment: "confirmed" }]);
    const parsed = parseScaledUiAmount(raw.value);
    const { event, entry } = journalTransition(t, parsed, journal[t.mint] ?? null);
    journal[t.mint] = entry;
    if (entry.lastEffective !== "1" && event === null) {
      console.warn(`[serve] ${t.symbol}: множитель ${entry.lastEffective} без истории журнала — from-value честно не восстановить, событие не выдумываем`);
    }
    if (event) {
      events.push(...bindMintAndValidate([event], t.mint));
      console.log(`[serve] ${t.symbol}: on-chain событие ${event.multiplierFrom} -> ${event.multiplierTo} @ ${event.effectiveDate.slice(0, 10)}`);
    }
  } catch (err) {
    console.warn(`[serve] ${t.symbol}: on-chain журнал недоступен (${err.message}) — пропускаем, fail-closed`);
  }
  await sleep(200);
}
try {
  writeFileSync(journalPath, JSON.stringify(journal, null, 1));
} catch (err) {
  console.warn(`[serve] журнал не сохранён (${err.message}) — события этой сессии живут в памяти`);
}

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

// Общий кэш-раннер: TTL + дедуп параллельных вызовов (одинаковый паттерн
// для on-chain ридера, сканера кошельков и провайдера цен — вынесен в хелпер)
const CACHE_TTL_MS = 10 * 60 * 1000;
const cached = (label) => {
  const store = new Map(); // key -> { at, data }
  const inflight = new Map(); // key -> Promise
  return (key, fn) => {
    const hit = store.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.data);
    if (!inflight.has(key)) {
      inflight.set(
        key,
        Promise.resolve()
          .then(fn)
          .then((data) => {
            store.set(key, { at: Date.now(), data });
            return data;
          })
          .finally(() => inflight.delete(key)),
      );
    }
    return inflight.get(key);
  };
};

// On-chain план (Scaled UI Amount): публичный RPC, кэш 10 минут на минт —
// витрина дёргает /onchain на каждый выбор токена, а квота публичных RPC конечна
const rpc = new RpcClient({ endpoint: rpcUrl });
const onchainCached = cached("onchain");

const onchainReader = (mint) =>
  onchainCached(mint, () =>
    rpc
      .call("getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "confirmed" }])
      .then((result) => parseScaledUiAmount(result.value)),
  );

// Кошельковый скан: дорогой (по getTransaction на транзакцию, ~350мс на публичном RPC)
const walletCached = cached("wallet");

const walletScanner = (address) =>
  walletCached(address, () => {
    console.log(`[serve] скан кошелька ${address} (потолок ${maxTxs} подписей)`);
    return scanWallet(rpc, address, registry, {
      maxTxs,
      onProgress: ({ fetched, total }) => {
        if (fetched % 25 === 0 || fetched === total) console.log(`[serve] ${address}: ${fetched}/${total}`);
      },
    }).then((scan) => {
      console.log(`[serve] ${address}: готово — ${scan.txs.length} релевантных tx из ${scan.fetched}`);
      return scan;
    });
  });

// Цены (GeckoTerminal): пул минта + дневные свечи, оба — кэш 10 минут
const gt = new GeckoTerminalClient();
const poolCached = cached("pool");
const candlesCached = cached("candles");

const priceProvider = {
  pool: (mint) => poolCached(mint, () => gt.bestBasePool(mint)),
  candles: (poolAddress) => candlesCached(poolAddress, () => gt.dailyCandles(poolAddress)),
};

let server;
try {
  server = await createApiServer({ registry, events, port, host, onchainReader, walletScanner, priceProvider });
} catch (err) {
  console.error(`[serve] не поднялся на порту ${port}: ${err.code ?? err.message}`);
  process.exit(1);
}
console.log(`\n[serve] Lotwise API: http://127.0.0.1:${server.address().port}`);
console.log(`[serve] витрина: http://127.0.0.1:${server.address().port}/`);
console.log(`[serve] токенов: ${registry.length}, событий: ${events.length}, on-chain RPC: ${rpcUrl}`);
console.log(`[serve] попробуй: / | /health | /events?symbol=SPYx | /multiplier?symbol=SPYx&date=2026-07-01 | /onchain?symbol=SPYx | /lots?address=<wallet> | /crosscheck?symbol=SPYx`);
