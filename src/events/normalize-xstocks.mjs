// Нормализация наблюдений xStocks multiplier API в канонические события Lotwise.
// API-план эмитента = первичный источник; on-chain ScaledUI-подтверждение —
// отдельный шаг недели 2 (сверка планов через reconcile).
import { validateEvent } from "../schema/events.mjs";
import { parseIsoDateMs } from "../schema/isodate.mjs";

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
  if (typeof v === "number" && Number.isFinite(v)) {
    const s = String(v);
    if (!/e/i.test(s)) return s;
    // Экспоненциальная запись не проходит DECIMAL_RE и роняла ВСЮ историю токена
    // NormalizeError'ом «not a decimal» (ROUND7 №13). Значащие цифры те же —
    // сдвигаем точку: 1e-7 → "0.0000001", 5e21 → "5000000000000000000000".
    const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/i.exec(s);
    if (!m) throw new NormalizeError(`field ${field} is not a decimal: ${JSON.stringify(v)}`, node);
    const [, sign, int, frac = "", exp] = m;
    const digits = int + frac;
    const point = int.length + Number(exp);
    const positional =
      point <= 0 ? `0.${"0".repeat(-point)}${digits}`
      : point >= digits.length ? `${digits}${"0".repeat(point - digits.length)}`
      : `${digits.slice(0, point)}.${digits.slice(point)}`;
    return sign ? `-${positional}` : positional; // отрицательное отвергнет схема, с её сообщением
  }
  if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v)) return v;
  throw new NormalizeError(`field ${field} is not a decimal: ${JSON.stringify(v)}`, node);
}

// Уникальный ключ узла истории. id — идентичность узла в API эмитента (uuid):
// один и тот же узел, пришедший на двух страницах (page-drift офсетной пагинации),
// обязан схлопнуться в одно событие. Узлы без id дедупятся только при полном
// совпадении содержимого: разные события в один день — реальность (сплит и
// дивиденд одной датой), схлопывать их по дате нельзя.
function nodeKey(n) {
  if (n !== null && typeof n === "object" && typeof n.id === "string" && n.id !== "") {
    return `id:${n.id}`;
  }
  return `full:${JSON.stringify([n?.id ?? null, n?.activationDateTime ?? null, n?.previousMultiplier, n?.multiplier, n?.reason ?? null])}`;
}

/**
 * @param {Array<{id, reason, multiplier, previousMultiplier, activationDateTime: string}>} historyNodes
 *   — как отдаёт fetchMultiplierHistory (строки) ИЛИ сырой JSON API (числа); новые сверху.
 *   Дубликаты узлов (page-drift: узел на границе двух страниц) схлопываются по
 *   уникальному ключу ДО проверки цепочки — иначе повтор события рвёт
 *   MultiplierTimeline ("chain discontinuity") и токен целиком исключается с витрины
 * @param {{symbol: string, network: string}} ctx
 * @returns {Array<object>} канонические MULTIPLIER_CHANGE, отсортированные по времени (старые → новые)
 */
export function multiplierHistoryToEvents(historyNodes, { symbol, network = "Ethereum" }) {
  const sourceUrl = `https://api.xstocks.fi/api/v2/public/assets/${symbol}/multiplier/history?network=${network}`;
  // Дедуп до разбора дат и сортa: повтор узла = повтор события с тем же
  // multiplierFrom, на котором таймлайн падает. Первое вхождение выигрывает.
  const seen = new Map(); // key → первый узел с этим ключом (он же победитель дедупа)
  const deduped = historyNodes.filter((n) => {
    const key = nodeKey(n);
    const first = seen.get(key);
    if (first !== undefined) {
      // Раунд 6, LW2_dedup_id_collision_silent_divergence: тот же id с РАЗНЫМ
      // содержимым (эмитент поправил узел на свежей странице / переиспользовал id).
      // Семантика «первое вхождение выигрывает» не меняется (id — идентичность узла,
      // сознательный трейд-офф), но раньше расхождение терялось МОЛЧА — ни оператор,
      // ни /health об этом не узнавали. Один однострочный warn — наблюдаемость.
      if (JSON.stringify(first) !== JSON.stringify(n)) {
        console.error(`[normalize-xstocks] ${symbol}: дедуп: узел ${key} схлопнут с ранее встреченным, но содержимое отличается — первое вхождение выигрывает, свежий вариант проигнорирован: ${JSON.stringify(n)}`);
      }
      return false;
    }
    seen.set(key, n);
    return true;
  });
  // Сорт по МОМЕНТУ ВРЕМЕНИ (числом), а не localeCompare по строке даты:
  // при смешанной точности ("…T00:00:00.500Z" vs "…T00:00:00Z") строковый сорт
  // давал порядок, обратный хронологии. Непарсируемая дата — NormalizeError:
  // fail-closed, как и во всём конвейере дат (находка раунда 3).
  const stamped = deduped.map((n) => {
    const ts = parseIsoDateMs(String(n?.activationDateTime));
    if (ts === null) {
      throw new NormalizeError(
        `activationDateTime is not a canonical ISO date: ${JSON.stringify(n?.activationDateTime)}`,
        n,
      );
    }
    return { n, ts };
  });
  stamped.sort((a, b) => a.ts - b.ts); // сорт V8 стабилен: равные моменты сохраняют порядок API
  return stamped.map(({ n }) => {
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
