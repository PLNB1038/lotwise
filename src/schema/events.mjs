// Каноническая схема корпоративных событий Lotwise.
// Единый формат для всего пайплайна: источники эмитентов и on-chain дельты
// нормализуются в эти объекты; движок лотов ест только их.
//
// КОНТРАКТ (осознанный, подтверждён фаззером — не «чинить» одну сторону пары):
// MERGER без exchange-полей ВАЛИДЕН по схеме — это информационное событие
// (переэмиссия/смена минта, обмен не заявлен); при этом applyEvents (lots.mjs)
// на MERGER без exchange-полей бросает LotError «refusing to guess».
// То есть схемный валидатор и движок лотов расходятся НАМЕРЕННО: история может
// содержать такие события, но применять их к лотам без коэффициента отказываемся.
import { isValidIsoDate } from "./isodate.mjs";

export const EVENT_TYPES = [
  "SPLIT",
  "DIVIDEND_ACCRUAL",
  "MERGER",
  "TICKER_CHANGE",
  "REDEEM",
  "MULTIPLIER_CHANGE",
];

const DECIMAL_RE = /^\d+(\.\d+)?$/;

// Каноническая запись десятичной строки множителя: «05»→«5», «5.0»→«5», «1.10»→«1.1».
// Единая точка для журнала, scaled-ui-парсера и reconcile (ROUND7 №16, ROUND9 №15):
// репрезентация зависит от источника, а все сравнения ниже — строковые. Вызывать
// ПОСЛЕ regex-гварда: форма уже гарантирована. Значащие цифры не трогаются.
export function canonicalDecimalString(s) {
  const [int = "0", frac = ""] = s.split(".");
  const canonInt = int.replace(/^0+(?=\d)/, "");
  const canonFrac = frac.replace(/0+$/, "");
  return canonFrac ? `${canonInt}.${canonFrac}` : canonInt;
}

// Статус доверия событию: цепочка источников подтверждает друг друга или нет.
export const EVENT_STATUSES = ["confirmed", "unverified"];

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Нулевой множитель не существует: MULTIPLIER_CHANGE «1»→«0» молча обнулял бы
// скорректированную позицию, а crosscheck получал expectedRatio=Infinity.
// «0.5» валиден — проверяем числовое равенство нулю в ЛЮБОЙ записи («0», «00»,
// «0.00», «00.0»: ведущие нули допускаются самим DECIMAL_RE — ROUND7 №3).
const ZERO_MULTIPLIER_RE = /^0+(\.0+)?$/;

// Кап дробной точности множителя — ПАРА с timeline.mjs (decimalToRatio отвергает >30).
// Контракт должен совпадать в обеих сторонах; менять только вместе.
const MAX_MULTIPLIER_FRACTION_DIGITS = 30;

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
  // Дата — не только форма, но семантика: реальный календарь и обязательная
  // таймзона у datetime (src/schema/isodate.mjs, находки раундов 2–3).
  // Журнал-реплей и xstocks-история проходят ТОЛЬКО эту проверку — мусорная дата
  // эмитента иначе доезжала бы до Date.parse как NaN и падала 500-м на /summary.
  if (!isValidIsoDate(e.effectiveDate)) {
    throw new EventValidationError(
      "effectiveDate must be canonical ISO-8601: YYYY-MM-DD or YYYY-MM-DDTHH:mm[:ss[.fff]](Z|±HH:MM)",
      "effectiveDate",
    );
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
      // Потолок safe-integer — тот же аргумент, что у amountPerUnitRaw (волна B):
      // выше 2^53 JSON-граница молча округляет, а движок считает точно
      if (e.ratioNumerator > Number.MAX_SAFE_INTEGER || e.ratioDenominator > Number.MAX_SAFE_INTEGER) {
        throw new EventValidationError("split ratio exceeds Number.MAX_SAFE_INTEGER — exact JSON transport impossible", "ratioNumerator");
      }
      break;
    case "DIVIDEND_ACCRUAL":
      requireFields(e, ["amountPerUnitRaw", "decimals"]);
      if (!Number.isInteger(e.amountPerUnitRaw) || e.amountPerUnitRaw <= 0) {
        throw new EventValidationError("amountPerUnitRaw must be a positive integer in raw units", "amountPerUnitRaw");
      }
      // Потолок safe-integer (ROUND9 №14): выше 2^53 JSON-граница молча округляет —
      // dividends.mjs ссылается на этот потолок как на «потолок самой схемы»
      if (e.amountPerUnitRaw > Number.MAX_SAFE_INTEGER) {
        throw new EventValidationError("amountPerUnitRaw exceeds Number.MAX_SAFE_INTEGER — exact JSON transport impossible", "amountPerUnitRaw");
      }
      if (!Number.isInteger(e.decimals) || e.decimals < 0 || e.decimals > 18) {
        throw new EventValidationError("decimals must be an integer 0..18", "decimals");
      }
      break;
    case "MERGER":
      requireFields(e, ["newMint"]);
      if (!MINT_RE.test(e.newMint)) throw new EventValidationError("newMint must be a base58 Solana pubkey", "newMint");
      if (e.newMint === e.mint) throw new EventValidationError("merger must change the mint", "newMint");
      if (e.exchangeNumerator !== undefined || e.exchangeDenominator !== undefined) {
        if (!Number.isInteger(e.exchangeNumerator) || e.exchangeNumerator <= 0 ||
            !Number.isInteger(e.exchangeDenominator) || e.exchangeDenominator <= 0) {
          throw new EventValidationError("exchange ratio must be two positive integers (old per new)", "exchangeNumerator");
        }
        if (e.exchangeNumerator > Number.MAX_SAFE_INTEGER || e.exchangeDenominator > Number.MAX_SAFE_INTEGER) {
          throw new EventValidationError("exchange ratio exceeds Number.MAX_SAFE_INTEGER — exact JSON transport impossible", "exchangeNumerator");
        }
      }
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
    case "MULTIPLIER_CHANGE":
      // xStocks-модель: raw-баланс не меняется, scaled = raw × multiplier.
      // Множители — ТОЧНЫЕ десятичные строки («1.005714560286254»), float запрещён.
      requireFields(e, ["multiplierFrom", "multiplierTo"]);
      for (const f of ["multiplierFrom", "multiplierTo"]) {
        if (typeof e[f] !== "string" || !DECIMAL_RE.test(e[f])) {
          throw new EventValidationError(`${f} must be a decimal string like "1.0057" (no float)`, f);
        }
        if (ZERO_MULTIPLIER_RE.test(e[f])) {
          throw new EventValidationError(`${f} must be positive — нулевой множитель не существует (позиция обнулилась бы молча)`, f);
        }
        const frac = e[f].split(".")[1] ?? "";
        if (frac.length > MAX_MULTIPLIER_FRACTION_DIGITS) {
          throw new EventValidationError(`${f} precision >${MAX_MULTIPLIER_FRACTION_DIGITS} fraction digits unsupported`, f);
        }
      }
      if (e.multiplierFrom === e.multiplierTo) {
        throw new EventValidationError("multiplier change must alter the multiplier", "multiplierTo");
      }
      if (e.reason !== undefined && typeof e.reason !== "string") {
        throw new EventValidationError("reason must be a string (e.g. Dividend, Stock Split, Reverse Split)", "reason");
      }
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
