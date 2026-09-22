// check-issuers — регулярная сверка «реестр ↔ источники эмитентов»: ловим расхождения
// (эмитент сменил минт / переиздал токен / убрал актив). Строго read-only: ТОЛЬКО отчёт,
// реестр не правится.
//
// Запуск из корня репо:
//   node scripts/check-issuers.mjs
//   node scripts/check-issuers.mjs --json
// Флаги:
//   --json                только JSON-отчёт {results, summary} в stdout
//   --registry <путь>     путь к реестру (по умолчанию data/tokens.json; нужен тестам)
//   --throttle-ms <мс>    пауза между HTTP-запросами (по умолчанию 1500; нужен тестам)
//   -h, --help            справка
// Коды выхода: 0 — подтверждённых расхождений нет, 1 — есть fail, 2 — ошибка запуска/чтения.
//
// Что проверяется по эмитентам (источники — существующие клиенты src/issuer/*, без их правки):
//   backed (xStocks) — multiplier-эндпоинт отвечает и знает символ: currentMultiplier присутствует
//                      (как в fetchCurrentMultiplier, сеть Solana);
//   prestocks        — метаданные /metadata/<symbol>.json: symbol в payload совпадает с
//                      реестровым регистронезависимо (проверку делает сам fetchTokenMetadata);
//   tessera          — cdn-метаданные cdn.tesseralab.co/tessera/<символ-в-нижнем>.json
//                      существуют и парсятся (клиента в src/issuer нет — GET в том же стиле);
//   backpack         — публичного API нет: статус skipped/no-source, клиент НЕ выдумывается.
//
// Осознанные решения:
// - Сетевой отказ — НЕ расхождение с эмитентом: статус skipped, а не fail. fail = только
//   подтверждённое расхождение (404 — актив убрали, чужой symbol — переиздали/сменили,
//   битый payload — источник сломан). Полный обрыв сети даёт exit 0 при нулевом ok:
//   аудит честно говорит «проверить не смогли», а не «всё разошлось».
// - Запросы идут последовательно с паузой throttleMs (вежливость к публичным API);
//   skipped-токены (backpack) запросов не делают и паузу не тратят.
// - Всё через инжектируемый fetcher (по умолчанию глобальный fetch) — тесты без сети.
// - Строка отчёта несёт mint: реестр стоит на минтах, символ — не уникальный ключ.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { fetchCurrentMultiplier, IssuerError } from "../src/issuer/xstocks.mjs";
import { fetchTokenMetadata } from "../src/issuer/prestocks.mjs";

const XSTOCKS_BASE = "https://api.xstocks.fi/api/v2/public/assets";
const PRESTOCKS_BASE = "https://prestocks.com/metadata";
const TESSERA_BASE = "https://cdn.tesseralab.co/tessera";
// Как в prestocks-клиенте: URL строится из символа — пускаем только «безопасные»
// символы, без ../ и прочего мусора.
const SYMBOL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const DEFAULT_THROTTLE_MS = 1500;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

class UsageError extends Error {}

const USAGE = `использование: node scripts/check-issuers.mjs [флаги]
  --json                только JSON-отчёт {results, summary} в stdout
  --registry <путь>     путь к реестру (по умолчанию data/tokens.json)
  --throttle-ms <мс>    пауза между HTTP-запросами (по умолчанию 1500)
  -h, --help            эта справка
Коды выхода: 0 — подтверждённых расхождений нет, 1 — есть fail, 2 — ошибка запуска/чтения.`;

// GET+JSON в стиле клиентов src/issuer/* (tessera-клиента нет, ошибки — те же классы).
async function getJson(url, fetcher) {
  let res;
  try {
    res = await fetcher(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; Lotwise/0.1)" } });
  } catch (err) {
    throw new IssuerError(`network: ${err.message}`);
  }
  if (!res.ok) throw new IssuerError(`HTTP ${res.status} for ${url}`, { status: res.status });
  try {
    return await res.json();
  } catch (err) {
    throw new IssuerError(`bad JSON from ${url}: ${err.message}`);
  }
}

// URL-строители зеркалят клиентов — для отчёта (какой эндпоинт проверялся).
const xstocksMultiplierUrl = (symbol, network) =>
  `${XSTOCKS_BASE}/${encodeURIComponent(symbol)}/multiplier?network=${encodeURIComponent(network)}`;
const prestocksMetadataUrl = (symbol) =>
  `${PRESTOCKS_BASE}/${encodeURIComponent(symbol.toLowerCase())}.json`;
const tesseraMetadataUrl = (symbol) =>
  `${TESSERA_BASE}/${encodeURIComponent(symbol.toLowerCase())}.json`;

/**
 * Проверка одного токена реестра против источника его эмитента.
 * Сетевой отказ -> skipped (проверить не смогли), остальное -> fail (расхождение).
 * @returns {Promise<{mint: string, symbol: string, issuer: string, status: "ok"|"skipped"|"fail", reason: string|null, url: string|null}>}
 */
export async function checkToken(token, { fetcher = fetch, network = "Solana" } = {}) {
  const base = { mint: token.mint, symbol: token.symbol, issuer: token.issuer };
  try {
    switch (token.issuer) {
      case "backed": {
        const url = xstocksMultiplierUrl(token.symbol, network);
        const m = await fetchCurrentMultiplier(token.symbol, network, { fetcher });
        // «Источник знает символ» = currentMultiplier присутствует и число.
        if (m.currentMultiplier === null) throw new IssuerError(`currentMultiplier отсутствует для ${token.symbol}`);
        return { ...base, status: "ok", reason: null, url };
      }
      case "prestocks": {
        const url = prestocksMetadataUrl(token.symbol);
        await fetchTokenMetadata(token.symbol, { fetcher }); // сверку symbol делает клиент
        return { ...base, status: "ok", reason: null, url };
      }
      case "tessera": {
        if (typeof token.symbol !== "string" || !SYMBOL_RE.test(token.symbol)) {
          throw new IssuerError(`bad symbol: ${JSON.stringify(token.symbol)}`);
        }
        const url = tesseraMetadataUrl(token.symbol);
        await getJson(url, fetcher); // файл существует и парсится — этого контракт и требует
        return { ...base, status: "ok", reason: null, url };
      }
      case "backpack":
        // Публичного API нет (в реестре sourceUrl «stockbasis-verified») — честный пропуск.
        return { ...base, status: "skipped", reason: "no-source", url: null };
      default:
        throw new IssuerError(`неизвестный эмитент: ${JSON.stringify(token.issuer)} — нет источника для сверки`);
    }
  } catch (err) {
    // Конвенция клиентов: сеть приходит строкой «network: ...» — это skipped.
    const status = /^network:/.test(String(err?.message)) ? "skipped" : "fail";
    return { ...base, status, reason: String(err?.message ?? err), url: null };
  }
}

/**
 * Последовательная сверка всего реестра с throttle между РЕАЛЬНЫМИ запросами
 * (skipped-токены запросов не делают и паузу не тратят).
 * @param {Array<{mint: string, symbol: string, issuer: string}>} tokens
 */
export async function checkRegistry(
  tokens,
  { fetcher = fetch, sleep = defaultSleep, throttleMs = DEFAULT_THROTTLE_MS, network = "Solana" } = {},
) {
  const results = [];
  let requests = 0;
  for (const token of tokens) {
    if (token.issuer === "backpack") {
      results.push(await checkToken(token, { fetcher, network }));
      continue;
    }
    if (requests > 0) await sleep(throttleMs);
    requests += 1;
    results.push(await checkToken(token, { fetcher, network }));
  }
  return results;
}

export function buildSummary(results) {
  const count = (s) => results.filter((r) => r.status === s).length;
  return {
    total: results.length,
    ok: count("ok"),
    skipped: count("skipped"),
    fail: count("fail"),
    clean: count("fail") === 0,
  };
}

export function parseArgs(argv) {
  const opts = { json: false, help: false, registry: "data/tokens.json", throttleMs: DEFAULT_THROTTLE_MS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "-h" || arg === "--help") opts.help = true;
    else if (arg === "--registry") {
      const value = argv[++i];
      if (value === undefined) throw new UsageError("--registry требует путь");
      opts.registry = value;
    } else if (arg === "--throttle-ms") {
      const value = argv[++i];
      if (value === undefined) throw new UsageError("--throttle-ms требует число миллисекунд");
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) throw new UsageError(`--throttle-ms: ждём целое >= 0, получено «${value}»`);
      opts.throttleMs = n;
    } else {
      throw new UsageError(`неизвестный флаг: ${arg}`);
    }
  }
  return opts;
}

function printHuman(registryPath, results, summary) {
  console.log("[check-issuers] сверка реестра с источниками эмитентов (read-only)");
  console.log(`[check-issuers] реестр: ${path.resolve(registryPath)}; токенов: ${results.length}`);
  for (const r of results) {
    const mark = r.status === "ok" ? "ok     " : r.status === "skipped" ? "skipped" : "FAIL   ";
    const detail =
      r.status === "ok" ? "источник отвечает, символ известен" : r.reason;
    console.log(`  [${mark}] ${r.symbol} (${r.issuer}): ${detail}`);
  }
  const verdict = summary.clean
    ? "подтверждённых расхождений нет"
    : "есть расхождения — сверить вручную!";
  console.log(`[check-issuers] ИТОГ: ok=${summary.ok}, skipped=${summary.skipped}, fail=${summary.fail} — ${verdict}`);
}

// Возвращает код выхода (0/1/2), ничего не пишет в файлы.
export async function main(argv = []) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`[check-issuers] ${err.message}`);
    console.error(USAGE);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  let tokens;
  try {
    tokens = JSON.parse(readFileSync(opts.registry, "utf8"));
  } catch (err) {
    console.error(`[check-issuers] реестр ${opts.registry} не читается: ${err.message}`);
    return 2;
  }
  if (!Array.isArray(tokens)) {
    console.error(`[check-issuers] реестр ${opts.registry}: ожидался массив токенов`);
    return 2;
  }
  const results = await checkRegistry(tokens, { fetcher: fetch, sleep: defaultSleep, throttleMs: opts.throttleMs });
  const summary = buildSummary(results);
  if (opts.json) console.log(JSON.stringify({ results, summary }, null, 2));
  else printHuman(opts.registry, results, summary);
  return summary.clean ? 0 : 1;
}

// CLI-режим только при прямом запуске (тесты импортируют функции без побочек).
const invokedAs = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
const isSelf =
  import.meta.url === invokedAs ||
  (process.platform === "win32" && import.meta.url.toLowerCase() === invokedAs.toLowerCase());
if (isSelf) process.exit(await main(process.argv.slice(2)));
