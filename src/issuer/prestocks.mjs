// Клиент источника эмитента PreStocks (prestocks.com, pre-IPO токены).
// По образцу xstocks.mjs: IssuerError, инжектируемый fetcher, getJson,
// «числа — строками, без float».
//
// ЧЕСТНОЕ ЗАМЕЧАНИЕ О ДАННЫХ (снято с живого эндпоинта 2026-09-22):
// метаданные PreStocks — identity-документ в духе NFT-метаданных и НЕ содержат
// полей корпоративных событий (ни сплитов, ни дивидендов, ни дат, ни чисел):
//   { name, symbol, description, image, external_url, terms }
// Маппинг в канонические события — отдельный слой (normalize-prestocks.mjs),
// mint привязывается снаружи из реестра.
export class IssuerError extends Error {
  constructor(msg, { status } = {}) {
    super(msg);
    this.name = "IssuerError";
    this.status = status;
  }
}

const BASE = "https://prestocks.com/metadata";

// URL метаданных строятся из символа в нижнем регистре: OPENAI -> openai.json
// (проверено живым эндпоинтом: /metadata/openai.json -> symbol "OPENAI").
// Путь разрешает только «безопасные» символы токенов — без ../ и прочего мусора.
const SYMBOL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

async function getJson(url, fetcher = fetch) {
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

/**
 * Метаданные PreStocks-токена по символу — план эмитента в текущей схеме
 * (identity-документ; полей событий в схеме нет, см. шапку файла).
 * Все поля ответа — строки или null: в схеме метаданных нет чисел, а любые
 * будущие числовые поля проходят через нормализатор событий строками.
 * @param {string} symbol например "OPENAI" (регистр не важен, в URL приводится к нижнему)
 * @param {{fetcher?: Function}} opts
 * @returns {Promise<{name: string, symbol: string, description: string|null, image: string|null, externalUrl: string|null, terms: string|null}>}
 */
export async function fetchTokenMetadata(symbol, { fetcher = fetch } = {}) {
  if (typeof symbol !== "string" || !SYMBOL_RE.test(symbol)) {
    throw new IssuerError(`bad symbol: ${JSON.stringify(symbol)}`);
  }
  const url = `${BASE}/${encodeURIComponent(symbol.toLowerCase())}.json`;
  const j = await getJson(url, fetcher);
  if (typeof j?.name !== "string" || j.name === "" || typeof j?.symbol !== "string" || j.symbol === "") {
    throw new IssuerError(`unexpected metadata payload for ${symbol}`);
  }
  // Символ в payload обязан соответствовать запрошенному (без учёта регистра):
  // файл per-symbol, расхождение = редирект/переименование/чужой документ.
  if (j.symbol.toUpperCase() !== symbol.toUpperCase()) {
    throw new IssuerError(`metadata symbol mismatch: asked ${symbol}, got ${j.symbol}`);
  }
  return {
    name: j.name,
    symbol: j.symbol,
    description: typeof j.description === "string" ? j.description : null,
    image: typeof j.image === "string" ? j.image : null,
    externalUrl: typeof j.external_url === "string" ? j.external_url : null,
    terms: typeof j.terms === "string" ? j.terms : null,
  };
}
