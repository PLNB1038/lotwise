// Нормализация метаданных PreStocks в канонические события Lotwise.
// По образцу normalize-xstocks.mjs, но с честной оговоркой: текущая схема
// метаданных PreStocks (снята с живого эндпоинта 2026-09-22) — identity-документ:
//   { name, symbol, description, image, external_url, terms }
// Полей корпоративных событий (сплит/дивиденд/даты/коэффициенты) в ней НЕТ.
// Поэтому metadataToEvents для актуальной схемы возвращает ПУСТОЙ список —
// синтезировать события (даты, коэффициенты) из логотипа и описания — значит
// выдумывать данные; конвейер проекта работает только с реальными наблюдениями.
// Слой существует как точка подключения: когда эмитент добавит поля событий,
// интерпретация появится здесь, а контракт «mint привязывается снаружи» не изменится.
import { validateEvent } from "../schema/events.mjs";

export class NormalizeError extends Error {
  constructor(msg, node) {
    super(msg);
    this.name = "NormalizeError";
    this.node = node;
  }
}

// Ключи identity-схемы, снятой с живого эндпоинта, в ОБОИХ написаниях:
// snake_case — сырой JSON эндпоинта, camelCase (externalUrl) — наш клиент.
// Всё, что за пределами набора, — сигнал об эволюции схемы эмитента.
const KNOWN_KEYS = new Set([
  "name",
  "symbol",
  "description",
  "image",
  "external_url",
  "externalUrl",
  "terms",
]);

/**
 * План эмитента (метаданные PreStocks) -> канонические события.
 * Текущая схема содержит только identity-поля, поэтому честный результат — [].
 * Неизвестные ключи НЕ игнорируются молча: возможные будущие поля событий
 * (по образцу round 6, «тихая потеря данных») подсвечиваются оператору в
 * console.error — наблюдаемость вместо блокировки токена из-за косметики.
 * @param {{name, symbol, description?, image?, external_url?, terms?}} metadata — как отдаёт fetchTokenMetadata ИЛИ сырой JSON эндпоинта
 * @param {{sourceUrl?: string}} [ctx] — URL источника для пометки в логе
 * @returns {Array<object>} канонические события (сейчас всегда пусто)
 */
export function metadataToEvents(metadata, { sourceUrl = "https://prestocks.com/metadata" } = {}) {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new NormalizeError("metadata must be an object", metadata);
  }
  if (typeof metadata.symbol !== "string" || metadata.symbol === "") {
    throw new NormalizeError("metadata is missing a symbol", metadata);
  }
  const unknown = Object.keys(metadata).filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length > 0) {
    console.error(
      `[normalize-prestocks] ${metadata.symbol}: в метаданных незнакомые ключи ${JSON.stringify(unknown)} — схема эмитента изменилась; возможно, появились поля событий. События из них пока НЕ извлекаются (нулевая интерпретация), оператору на заметку.`,
    );
  }
  // Никаких событий из identity-полей: REDEEM из ссылки на оферту или
  // TICKER_CHANGE без старого тикера — фальсификация даты/факта, а не маппинг.
  return [];
}

/**
 * Легитимные ссылки-источники из identity-документа: external_url (страница
 * токена) и terms (оферта эмитента). Когда у эмитента появятся реальные
 * поля событий, эти ссылки пойдут в sources канонических событий.
 * @returns {string[]} непустые строки-ссылки в стабильном порядке
 */
export function metadataSources(metadata) {
  if (metadata === null || typeof metadata !== "object") {
    throw new NormalizeError("metadata must be an object", metadata);
  }
  return [metadata.external_url, metadata.terms].filter((s) => typeof s === "string" && s.length >= 4);
}

/** Дополняет события минтом из реестра и прогоняет валидацию схемы; атомарно.
 *  Контракт тот же, что у normalize-xstocks.bindMintAndValidate — копия,
 *  а не импорт: источники эмитентов подключаются независимо друг от друга. */
export function bindMintAndValidate(events, mint) {
  const bound = events.map((e) => ({ ...e, mint }));
  for (const e of bound) {
    try {
      validateEvent(e);
    } catch (err) {
      throw new NormalizeError(`normalized event failed schema: ${err.message}`, e);
    }
  }
  return bound;
}
