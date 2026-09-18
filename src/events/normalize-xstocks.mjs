// Нормализация наблюдений xStocks multiplier API в канонические события Lotwise.
// API-план эмитента = первичный источник; on-chain ScaledUI-подтверждение —
// отдельный шаг недели 2 (сверка планов через reconcile).
import { validateEvent } from "../schema/events.mjs";

export class NormalizeError extends Error {
  constructor(msg, node) {
    super(msg);
    this.name = "NormalizeError";
    this.node = node;
  }
}

// Граница данных: узлы могут прийти числами (сырой JSON API) или строками
// (наш клиент). Число → строка точно (JSON-число парсится в double,
// shortest-round-trip сохраняет все значащие цифры); мусор — ошибка.
function toDecimalString(v, field, node) {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v)) return v;
  throw new NormalizeError(`field ${field} is not a decimal: ${JSON.stringify(v)}`, node);
}

/**
 * @param {Array<{id, reason, multiplier, previousMultiplier, activationDateTime: string}>} historyNodes
 *   — как отдаёт fetchMultiplierHistory (строки) ИЛИ сырой JSON API (числа); новые сверху
 * @param {{symbol: string, network: string}} ctx
 * @returns {Array<object>} канонические MULTIPLIER_CHANGE, отсортированные по времени (старые → новые)
 */
export function multiplierHistoryToEvents(historyNodes, { symbol, network = "Ethereum" }) {
  const sourceUrl = `https://api.xstocks.fi/api/v2/public/assets/${symbol}/multiplier/history?network=${network}`;
  return [...historyNodes]
    .sort((a, b) => String(a.activationDateTime).localeCompare(String(b.activationDateTime)))
    .map((n) => {
      const e = {
        type: "MULTIPLIER_CHANGE",
        // минт подставит вызывающий слой из реестра по символу — здесь символ в sourceUrl
        effectiveDate: n.activationDateTime,
        status: "confirmed", // официальный API эмитента
        sources: [`${sourceUrl}#node:${n.id}`],
        multiplierFrom: toDecimalString(n.previousMultiplier, "previousMultiplier", n),
        multiplierTo: toDecimalString(n.multiplier, "multiplier", n),
        reason: n.reason,
      };
      return e;
    });
}

/** Дополняет события минтом из реестра и прогоняет валидацию схемы; атомарно. */
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
