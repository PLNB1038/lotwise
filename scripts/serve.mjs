// Запуск Lotwise API с живыми данными: реестр + история множителей xStocks + on-chain план.
// Использование: node scripts/serve.mjs [--port 8787] [--rpc https://api.mainnet-beta.solana.com]
import { loadRegistrySafe } from "../src/registry/registry.mjs";
import { fetchMultiplierHistory } from "../src/issuer/xstocks.mjs";
import { multiplierHistoryToEvents, bindMintAndValidate } from "../src/events/normalize-xstocks.mjs";
import { createApiServer } from "../src/api/server.mjs";
import { RpcClient } from "../src/ingest/rpc.mjs";
import { parseScaledUiAmount } from "../src/issuer/scaled-ui.mjs";
import { scanWallet } from "../src/wallet/scan.mjs";
import { GeckoTerminalClient } from "../src/price/geckoterminal.mjs";
import { planJournalStep, issuerChainComplete, bootJournalOnchain, persistJournalOnBoot } from "../src/events/journal.mjs";

const port = Number(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 8787);
const host = process.argv.includes("--host") ? process.argv[process.argv.indexOf("--host") + 1] : "127.0.0.1";
const rpcUrl = process.argv.includes("--rpc") ? process.argv[process.argv.indexOf("--rpc") + 1] : "https://api.mainnet-beta.solana.com";
const maxTxs = Number(process.argv.includes("--max-txs") ? process.argv[process.argv.indexOf("--max-txs") + 1] : 300);
if (!Number.isInteger(maxTxs) || maxTxs <= 0) {
  // без гварда "--max-txs abc" даёт NaN: `taken >= NaN` всегда false — скан молча без потолка
  console.error("[serve] --max-txs должен быть целым числом > 0");
  process.exit(1);
}

// Реестр: усечённый data/tokens.json (обрыв в окне записи enrich-decimals)
// раньше ронял процесс ЦЕЛИКОМ — RegistryError на top-level без catch → unhandled
// rejection, ни деградированного режима, ни диагностики класса «повреждён» (раунд 6,
// LW2_tokens_json_write_non_atomic). Паттерн журнала: повреждение — явное состояние,
// улика сохраняется рядом, бут продолжается на пустом реестре; флаг уходит в /health.
const loadedRegistry = await loadRegistrySafe("data/tokens.json");
const registry = loadedRegistry.registry;
if (!loadedRegistry.ok) {
  console.error(
    `[serve] РЕЕСТР НЕ ЗАГРУЖЕН (${loadedRegistry.reason}). ` +
    `Стартуем с пустым реестром: витрина и сканер не видят токенов — ` +
    `после восстановления data/tokens.json перезапуск вернёт всё.` +
    (loadedRegistry.backup ? ` Повреждённый файл сохранён рядом: ${loadedRegistry.backup}` : ""),
  );
}
const registryStats = { corrupted: loadedRegistry.corrupted ? 1 : 0 };

const events = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpcForJournal = new RpcClient({ endpoint: rpcUrl });

// On-chain журнал: у PreStocks/Backpack нет API истории эмитента — их корп-события
// живут прямо в минте (scaledUiAmountConfig). Бэкфилл при первом наблюдении,
// далее дифф от прошлой эффективной величины. Живые находки 19.09: SPACEX ×5 (10.06),
// OPENAI ×1.4861347 (17.07). Журнал — runtime-состояние, из цепи восстанавливается.
const journalPath = "data/onchain-journal.json";
// Битый файл журнала — НЕ «первый запуск» (раунд 5): усечённый JSON после обрыва
// записи раньше молча давал journal={}, и вся история событий терялась невосстановимо,
// а /health показывал журнал здоровым. Теперь состояние различимо: corrupted-флаг
// уходит в /health, повреждённый файл сохраняется как улика до первой перезаписи,
// процесс НЕ падает (тот же принцип, что изоляция ядовитых записей в раунде 4).
// Раунд 6 (LW2_journal_evidence_clobber_on_failed_preserve): если улику сохранить
// НЕ удалось (preserveFailed), бут идёт в режиме read-only — финальная запись журнала
// в этом буте запрещена, иначе она затирает повреждённый оригинал, единственную
// копию истории. Перезапуск после ухода залочившего процесса (AV/индексер) сохранит
// улику штатно и вернёт запись.
const journalBoot = bootJournalOnchain(journalPath);
let journal = journalBoot.journal;
const journalCorrupted = journalBoot.corrupted;
const journalReadOnly = journalCorrupted && journalBoot.preserveFailed;
if (journalCorrupted) {
  console.error(
    `[serve] ЖУРНАЛ ПОВРЕЖДЁН, не загружен (${journalBoot.reason}). ` +
    `Стартуем с пустого журнала: бэкфилл восстановит только ротации, видимые как живой pending; ` +
    `у токенов с завершённой ротацией история множителей невосстановима — витрина покажет 1. ` +
    (journalBoot.backup
      ? `Повреждённый файл сохранён рядом: ${journalBoot.backup}`
      : `УЛИКУ СОХРАНИТЬ НЕ УДАЛОСЬ, повреждённый оригинал лежит на месте — журнал в режиме read-only до перезапуска: финальной записи в этом буте не будет`),
  );
}
let journalReplayed = 0;
let journalUnavailable = 0;
for (const t of registry.filter((x) => x.issuer !== "backed")) {
  const priorEntry = journal[t.mint] ?? null;
  let parsed = null;
  try {
    const raw = await rpcForJournal.call("getAccountInfo", [t.mint, { encoding: "jsonParsed", commitment: "confirmed" }]);
    parsed = parseScaledUiAmount(raw.value);
  } catch (err) {
    console.warn(`[serve] ${t.symbol}: on-chain журнал недоступен (${err.message}) — fail-closed`);
  }
  // Изоляция per-token: кривой минт (битый кэш журнала, отказ валидации) не должен
  // убивать весь бут — раньше запись с ядом персистилась и процесс падал на каждом
  // рестарте. Пропускаем токен с warn, сервер поднимается на остальных.
  try {
    const { replay, event, entry, chain, unavailableV1 } = planJournalStep(t, priorEntry, parsed);
    if (chain === "unavailable") journalUnavailable++;
    if (entry !== null) journal[t.mint] = entry;
    // рестарт процесса НЕ должен терять уже выданные события: реплей из журнала
    if (replay.length > 0) {
      events.push(...bindMintAndValidate(replay, t.mint));
      journalReplayed += replay.length;
      if (chain === "unavailable") {
        console.log(`[serve] ${t.symbol}: реплей ${replay.length} событий из кэша журнала (цепь недоступна — план протух, observedAt честный)`);
      }
    }
    if (entry && entry.lastEffective !== "1" && entry.events.length === 0) {
      console.warn(`[serve] ${t.symbol}: множитель ${entry.lastEffective} без истории журнала — from-value честно не восстановить, событие не выдумываем`);
    }
    if (unavailableV1) {
      // v1-запись (без events) + недоступная цепь: без этого warn витрина молча показала бы 1
      console.warn(`[serve] ${t.symbol}: запись журнала v1 (множитель ${priorEntry.lastEffective}) без событий и цепь недоступна — миграция отложена, витрина покажет 1 до возврата цепи`);
    }
    if (event) {
      events.push(...bindMintAndValidate([event], t.mint));
      console.log(`[serve] ${t.symbol}: on-chain событие ${event.multiplierFrom} -> ${event.multiplierTo} @ ${event.effectiveDate.slice(0, 10)}`);
    }
  } catch (err) {
    console.warn(`[serve] ${t.symbol}: шаг on-chain журнала не прошёл (${err.message}) — токен пропущен, сервер поднимается на остальных`);
  }
  await sleep(200);
}
// Финальная запись журнала — единственная точка записи (persistJournalOnBoot).
// В режиме read-only (улику сохранить не удалось) запись НЕ выполняется: повреждённый
// оригинал переживает бут до перезапуска (раунд 6).
const journalSaved = persistJournalOnBoot(journalPath, journal, { preserveFailed: journalReadOnly });
if (journalSaved.readonly) {
  console.error("[serve] журнал не записан (read-only до перезапуска): события этой сессии только в памяти, /health.journal.preserveFailed=1");
} else if (!journalSaved.written) {
  console.warn(`[serve] журнал не сохранён (${journalSaved.error.message}) — события этой сессии живут в памяти`);
}

// xStocks: тянем историю по каждому символу (Ethereum-план несёт полные события,
// Solana-эндпоинт историю не бэкфиллит — verified 18.09). Пагинация с потолком:
// раньше брали только страницу 0 (25 узлов) — у токена с 26-м дивидендом старейший
// узел страницы начинался не от "1", и таймлайн бросал TimelineError на старте
// (тот же boot-loop, что с on-chain журналом).
const HISTORY_MAX_PAGES = 10;
for (const t of registry.filter((x) => x.issuer === "backed")) {
  try {
    const nodes = [];
    let hasNextPage = true;
    for (let page = 0; page < HISTORY_MAX_PAGES && hasNextPage; page++) {
      if (page > 0) await sleep(300); // вежливость к публичному API и между страницами
      const h = await fetchMultiplierHistory(t.symbol, "Ethereum", { page });
      nodes.push(...h.nodes);
      hasNextPage = h.hasNextPage;
    }
    // Честная проверка полноты: старейший собранный узел обязан начинаться от "1",
    // иначе таймлайн не построится. Неполная история не скармливается — warn, не краш.
    const chain = issuerChainComplete(nodes);
    if (!chain.complete) {
      console.warn(`[serve] ${t.symbol}: история эмитента неполна (${chain.reason}) — события не скармливаются таймлайну`);
      continue;
    }
    if (nodes.length > 0) {
      events.push(...bindMintAndValidate(multiplierHistoryToEvents(nodes, { symbol: t.symbol, network: "Ethereum" }), t.mint));
      console.log(`[serve] ${t.symbol}: ${nodes.length} событий множителя`);
    }
  } catch (err) {
    console.warn(`[serve] ${t.symbol}: источник недоступен (${err.message}) — пропускаем, fail-closed`);
  }
  await sleep(300); // вежливость к публичному API
}

// Общий кэш-раннер: TTL + дедуп параллельных вызовов (одинаковый паттерн
// для on-chain ридера, сканера кошельков и провайдера цен — вынесен в хелпер)
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200; // ключи произвольные (адреса кошельков) — без потолка карта растёт вечно
const cached = (label) => {
  const store = new Map(); // key -> { at, data }
  const inflight = new Map(); // key -> Promise
  const remember = (key, data) => {
    store.set(key, { at: Date.now(), data });
    // вытеснение самой старой записи по at при превышении потолка
    if (store.size > CACHE_MAX_ENTRIES) {
      let oldestKey = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [k, v] of store) {
        if (v.at < oldestAt) {
          oldestAt = v.at;
          oldestKey = k;
        }
      }
      if (oldestKey !== null) store.delete(oldestKey);
    }
  };
  return (key, fn) => {
    const hit = store.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.data);
    if (!inflight.has(key)) {
      inflight.set(
        key,
        Promise.resolve()
          .then(fn)
          .then((data) => {
            remember(key, data);
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

// Rate limits дорогих эндпоинтов на клиентский IP (см. src/api/ratelimit.mjs):
// демка публична через funnel, квота RPC конечна; XFF доверяем — единственный
// публичный путь к порту это funnel, прямые коннекты бывают только из tailnet
const envPositiveInt = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : fallback;
};
const rateLimits = {
  scan: { windowMs: 60_000, max: envPositiveInt("RATE_LIMIT_SCAN_PER_MIN", 12) }, // /lots, /accruals
  rpc: { windowMs: 60_000, max: envPositiveInt("RATE_LIMIT_RPC_PER_MIN", 60) }, // /onchain, /crosscheck
};

let server;
try {
  server = await createApiServer({
    registry, events, port, host, onchainReader, walletScanner, priceProvider, rateLimits, trustProxy: true,
    journalStats: {
      replayed: journalReplayed,
      unavailable: journalUnavailable,
      corrupted: journalCorrupted ? 1 : 0,
      preserveFailed: journalReadOnly ? 1 : 0, // read-only бут: финальной записи журнала не было (раунд 6)
    },
    registryStats, // { corrupted: 0|1 } — контракт /health: registry.corrupted (см. отчёт раунда 6)
  });
} catch (err) {
  console.error(`[serve] не поднялся на порту ${port}: ${err.code ?? err.message}`);
  process.exit(1);
}
console.log(`\n[serve] Lotwise API: http://127.0.0.1:${server.address().port}`);
console.log(`[serve] витрина: http://127.0.0.1:${server.address().port}/`);
console.log(`[serve] токенов: ${registry.length}, событий: ${events.length}, on-chain RPC: ${rpcUrl}`);
console.log(`[serve] rate limits (на IP): ${rateLimits.scan.max}/мин сканов кошелька, ${rateLimits.rpc.max}/мин on-chain/цен (env: RATE_LIMIT_SCAN_PER_MIN, RATE_LIMIT_RPC_PER_MIN)`);
console.log(`[serve] попробуй: / | /health | /events?symbol=SPYx | /multiplier?symbol=SPYx&date=2026-07-01 | /onchain?symbol=SPYx | /lots?address=<wallet> | /crosscheck?symbol=SPYx`);
