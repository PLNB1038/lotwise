// Каноническая схема корпоративных событий Lotwise.
// Единый формат для всего пайплайна: источники эмитентов и on-chain дельты
// нормализуются в эти объекты; движок лотов ест только их.

export const EVENT_TYPES = [
  "SPLIT",
  "DIVIDEND_ACCRUAL",
  "MERGER",
  "TICKER_CHANGE",
  "REDEEM",
];

// Статус доверия событию: цепочка источников подтверждает друг друга или нет.
export const EVENT_STATUSES = ["confirmed", "unverified"];

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export class EventValidationError extends Error {
  constructor(msg, field) {
    super(field ? `${msg} (${field})` : msg);
    this.name = "EventValidationError";
    this.field = field;
  }
}

function requireFields(e, fields) {
  for (const f of fields) {
    if (e?.[f] === undefined || e?.[f] === null || e?.[f] === "") {
      throw new EventValidationError(`missing required field`, f);
    }
  }
}

// Валидация одного события. Бросает EventValidationError с именем поля.
export function validateEvent(e) {
  if (!e || typeof e !== "object") throw new EventValidationError("event must be an object");
  requireFields(e, ["type", "mint", "effectiveDate", "status", "sources"]);

  if (!EVENT_TYPES.includes(e.type)) {
    throw new EventValidationError(`unknown type "${e.type}", expected one of ${EVENT_TYPES.join("|")}`, "type");
  }
  if (!MINT_RE.test(e.mint)) throw new EventValidationError("mint must be a base58 Solana pubkey", "mint");
  if (!ISO_DATE_RE.test(e.effectiveDate)) {
    throw new EventValidationError("effectiveDate must be ISO-8601 (YYYY-MM-DD[THH:mm[:ss]][Z])", "effectiveDate");
  }
  if (!EVENT_STATUSES.includes(e.status)) {
    throw new EventValidationError(`status must be one of ${EVENT_STATUSES.join("|")}`, "status");
  }
  if (!Array.isArray(e.sources) || e.sources.length === 0) {
    throw new EventValidationError("at least one source URL/reference is required", "sources");
  }
  for (const s of e.sources) {
    if (typeof s !== "string" || s.length < 4) {
      throw new EventValidationError("each source must be a non-empty string (URL or reference)", "sources");
    }
  }

  switch (e.type) {
    case "SPLIT":
      requireFields(e, ["ratioNumerator", "ratioDenominator"]);
      if (!Number.isInteger(e.ratioNumerator) || e.ratioNumerator <= 0 ||
          !Number.isInteger(e.ratioDenominator) || e.ratioDenominator <= 0) {
        throw new EventValidationError("split ratio must be two positive integers (e.g. 3/1)", "ratioNumerator");
      }
      break;
    case "DIVIDEND_ACCRUAL":
      requireFields(e, ["amountPerUnitRaw", "decimals"]);
      if (!Number.isInteger(e.amountPerUnitRaw) || e.amountPerUnitRaw <= 0) {
        throw new EventValidationError("amountPerUnitRaw must be a positive integer in raw units", "amountPerUnitRaw");
      }
      if (!Number.isInteger(e.decimals) || e.decimals < 0 || e.decimals > 18) {
        throw new EventValidationError("decimals must be an integer 0..18", "decimals");
      }
      break;
    case "MERGER":
      requireFields(e, ["newMint"]);
      if (!MINT_RE.test(e.newMint)) throw new EventValidationError("newMint must be a base58 Solana pubkey", "newMint");
      if (e.newMint === e.mint) throw new EventValidationError("merger must change the mint", "newMint");
      break;
    case "TICKER_CHANGE":
      requireFields(e, ["oldSymbol", "newSymbol"]);
      if (typeof e.oldSymbol !== "string" || typeof e.newSymbol !== "string" ||
          e.oldSymbol === e.newSymbol) {
        throw new EventValidationError("ticker change must alter the symbol", "newSymbol");
      }
      break;
    case "REDEEM":
      // redemption закрывает токен: обмен на базовый актив/стейбл, доп-полей не требует,
      // но ссылка на условия обязана быть в sources (проверено выше)
      break;
  }

  if (e.announcedBy !== undefined && !PUBKEY_RE.test(e.announcedBy)) {
    throw new EventValidationError("announcedBy must be a valid pubkey", "announcedBy");
  }
  return true;
}

export function isValidEvent(e) {
  try {
    validateEvent(e);
    return true;
  } catch {
    return false;
  }
}
