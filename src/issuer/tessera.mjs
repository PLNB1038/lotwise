// Клиент источника эмитента Tessera (tessera.pe, токены T-OpenAI/T-SpaceX/T-Kalshi).
// По образцу prestocks.mjs: IssuerError, инжектируемый fetcher, getJson,
// «числа — строками, без float».
//
// ЧЕСТНОЕ ЗАМЕЧАНИЕ О ДАННЫХ (снято с живого CDN 2026-09-22, t-spacex/t-openai/t-kalshi):
// метаданные Tessera — identity-документ в духе NFT-метаданных и НЕ содержат полей
// корпоративных событий (ни дат, ни множителей, ни ротаций):
//   { name, symbol, description, image, external_url,
//     attributes: [{ trait_type, value }, ...] }
// Атрибут «Redemption Trigger: Divestment of Underlying Exposure» — словесное
// описание условия, без даты и коэффициента: событием не является, синтезировать
// события (даты/множители) из trait-строк — выдумывать данные. Поэтому
// metadataToEvents здесь НЕТ — только metadataSources() для легитимных ссылок.
export class IssuerError extends Error {
  constructor(msg, { status } = {}) {
    super(msg);
    this.name = "IssuerError";
    this.status = status;
  }
}

const BASE = "https://cdn.tesseralab.co/tessera";

// URL метаданных строятся из символа в нижнем регистре: T-SpaceX -> t-spacex.json
// (проверено живым CDN и uri минта T-SpaceX из onchain-фикстуры).
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

// Строка или конечное число -> строка (без float-математики), иначе null.
const asString = (v) => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : null);

// Символ в payload Tessera — camelCase-остов БЕЗ дефиса («tSpaceX» для файла
// t-spacex.json), а в реестре лот-проекта тот же токен записан «T-SpaceX».
// Поэтому сверка регистронезависимая и по буквенно-цифровому остову: T-SpaceX и
// tSpaceX дают TSPACEX, а чужой документ (спросили T-SpaceX, отдали tOpenAI ->
// TOPENAI) ловится как mismatch.
const symbolKey = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * Метаданные Tessera-токена по символу — план эмитента в текущей схеме
 * (identity-документ; полей событий в схеме нет, см. шапку файла).
 * Все поля — строки или null (attributes — массив пар строк/null).
 * @param {string} symbol например "T-SpaceX" (регистр не важен, в URL приводится к нижнему)
 * @param {{fetcher?: Function}} opts
 * @returns {Promise<{name: string, symbol: string, description: string|null, image: string|null, externalUrl: string|null, attributes: Array<{traitType: string, value: string|null}>|null}>}
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
  // Символ в payload обязан соответствовать запрошенному (по остову, см. symbolKey):
  // файл per-symbol, расхождение = редирект/переименование/чужой документ.
  if (symbolKey(j.symbol) !== symbolKey(symbol)) {
    throw new IssuerError(`metadata symbol mismatch: asked ${symbol}, got ${j.symbol}`);
  }
  // attributes — статические trait-пары NFT-схемы: trait_type строкой, значение
  // строкой или конечным числом (числа -> строками), остальное -> null.
  // Записи без строкового trait_type не выдумываются.
  let attributes = null;
  if (Array.isArray(j.attributes)) {
    attributes = j.attributes
      .filter((a) => a !== null && typeof a === "object" && !Array.isArray(a) && typeof a.trait_type === "string")
      .map((a) => ({ traitType: a.trait_type, value: asString(a.value) }));
  }
  return {
    name: j.name,
    symbol: j.symbol,
    description: asString(j.description),
    image: asString(j.image),
    externalUrl: asString(j.external_url),
    attributes,
  };
}

/**
 * Легитимные ссылки-источники из identity-документа: external_url (страница
 * проекта) и атрибут «Terms and Conditions» (оферта эмитента). Принимаются оба
 * написания атрибута — snake_case сырого JSON и camelCase нашего клиента.
 * @returns {string[]} непустые строки-ссылки в стабильном порядке
 */
export function metadataSources(metadata) {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new IssuerError("metadata must be an object");
  }
  const attrs = Array.isArray(metadata.attributes) ? metadata.attributes : [];
  const terms = attrs
    .map((a) => (a !== null && typeof a === "object" ? a : {}))
    .filter((a) => a.trait_type === "Terms and Conditions" || a.traitType === "Terms and Conditions")
    .map((a) => a.value)
    .filter((s) => typeof s === "string");
  // externalUrl — camelCase-вывод нашего же fetchTokenMetadata, external_url — сырой
  // JSON метаданных: composition двух экспортов не должен терять ссылку проекта
  // из провенанс-списка (ROUND7 №6); атрибуты уже принимаются в обоих написаниях
  return [metadata.external_url ?? metadata.externalUrl, ...terms]
    .filter((s) => typeof s === "string" && s.length >= 4);
}
