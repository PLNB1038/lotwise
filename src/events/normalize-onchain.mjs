// Нормализация on-chain состояния минта в канонические MULTIPLIER_CHANGE.
// Живые находки 19.09: у PreStocks нет API истории, но события живут прямо в минте —
// SPACEX: active=1 + pending=5 c 10.06.2026 (уже эффективен), OPENAI: ×1.4861347 c 17.07.
// On-chain — первичный источник: статус confirmed; «from» при бэкфилле = поле active
// (лучшая правда цепи о предыдущем значении; промежуточные шаги между наблюдениями
// из состояния минта невосстановимы — это задокументированное ограничение, не догадка).
//
// Инвариант цепочки (раунд 4): событие эмитится ТОЛЬКО если продолжает цепочку от "1".
// MultiplierTimeline требует базу "1" и непрерывность, иначе createApiServer падает с
// TimelineError на старте, а запись с ядом уже персистится в журнале → рестарт реплеит
// → краш снова: вечный boot-loop. Токен, впервые увиденный в середине истории
// (active="5"), не получает выдуманного 5→X: lastEffective фиксируется, events остаются
// пустыми, warn на старте serve честно говорит о неполноте. Событие не выдумываем.
import { validateEvent } from "../schema/events.mjs";

export class OnchainNormalizeError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "OnchainNormalizeError";
  }
}

const DAY = 86400;

// pending "0" — способ эмитента «сбросить» pending (живая фикстура xstocks-spyx-current):
// трактуем как отсутствующий, иначе журнал эмитит X→0, таймлайн формально валиден,
// а витрина молча показывает нули. Defense in depth: парсер цепи чинится отдельно.
const pendingOf = (parsed) =>
  parsed.pendingMultiplier == null || Number(parsed.pendingMultiplier) === 0
    ? null
    : parsed.pendingMultiplier;

const effectiveOf = (parsed, nowMs) => {
  const pendingTs = parsed.pendingEffectiveDate ? Date.parse(parsed.pendingEffectiveDate) : null;
  const pending = pendingOf(parsed);
  return pendingTs !== null && pendingTs <= nowMs && pending !== null
    ? pending
    : parsed.activeMultiplier;
};

/**
 * Бэкфилл из текущего состояния минта (первое наблюдение).
 * @returns {object|null} каноническое MULTIPLIER_CHANGE или null, если события не видно
 */
export function backfillMultiplierEvent(token, parsed, nowMs = Date.now()) {
  if (!parsed.hasExtension) return null; // токен без механизма ребейза — фактов нет, и это факт
  const pending = pendingOf(parsed);
  if (pending === null || parsed.pendingEffectiveDate === null) return null;
  const from = parsed.activeMultiplier;
  const to = pending;
  if (from === to) return null; // pending уже равен active — ротация завершена, нового не видно
  const event = {
    type: "MULTIPLIER_CHANGE",
    mint: token.mint,
    effectiveDate: parsed.pendingEffectiveDate,
    status: "confirmed",
    sources: [`solana:getAccountInfo:${token.mint}#scaledUiAmountConfig (observed for ${token.symbol})`],
    multiplierFrom: from,
    multiplierTo: to,
    reason: "On-chain rebase",
  };
  try {
    validateEvent(event);
  } catch (err) {
    throw new OnchainNormalizeError(`backfill failed validation: ${err.message}`);
  }
  return event;
}

/**
 * Дифф журнала: сравнить прошлую эффективную величину с текущим состоянием цепи.
 * @param {{lastEffective: string, observedAt: string, events?: Array}|null} entry — запись журнала
 *   (null = первое наблюдение). events — ПОЛНАЯ история выданных событий: entry без
 *   них (v1) мигрируется бэкфиллом вызывающим слоем.
 * @returns {{event: object|null, entry: {lastEffective: string, observedAt: string, events: Array}}}
 *   event — только НОВОЕ событие этого шага; вся история живёт в entry.events —
 *   иначе рестарт процесса терял уже выданные события (множитель молча откатывался к 1).
 */
export function journalTransition(token, parsed, entry, nowMs = Date.now()) {
  const nowIso = new Date(nowMs).toISOString();
  const effective = effectiveOf(parsed, nowMs);
  const priorEvents = Array.isArray(entry?.events) ? entry.events : [];

  if (entry === null) {
    if (!parsed.hasExtension) {
      // минт без механизма ребейза: дефолт "1" парсера — не факт, записи нет
      // (волна C4-1: пустые записи {lastEffective:"1"} лишь шум и приманка)
      return { event: null, entry: null };
    }
    // Первое наблюдение: бэкфилл имеет смысл, только если СТАРТУЕТ цепочку от "1".
    // Токен, впервые увиденный mid-history (active="5", pending="6"), раньше эмитил 5→6 —
    // TimelineError при построении таймлайнов и вечный boot-loop (ядо персистится в
    // журнале). Не выдумываем: фиксируем lastEffective, events остаются пустыми.
    const candidate = parsed.hasExtension && effective !== "1"
      ? backfillMultiplierEvent(token, parsed, nowMs)
      : null;
    const event = candidate !== null && candidate.multiplierFrom === "1" ? candidate : null;
    // entry фиксирует ЭФФЕКТИВНУЮ величину — будущие ротации диффом от неё
    return { event, entry: { lastEffective: effective, observedAt: nowIso, events: event ? [event] : [] } };
  }

  // Волна C4-1 [P1]: ответ БЕЗ scaledUiAmountConfig — «нет факта», а не «сброс до 1»:
  // парсер честно отдаёт дефолт "1" (hasExtension:false), но дифф принимал его за
  // наблюдённый сброс → фантом X→1, а при возврате правды — вечный дубль-триплет
  // в истории (марафон 2400 бутов: 1221 нарушение этого класса до фикса). Запись
  // не трогаем — тот же контракт, что у недоступной цепи.
  if (!parsed.hasExtension) {
    return { event: null, entry };
  }

  if (effective === entry.lastEffective) {
    return { event: null, entry: { lastEffective: entry.lastEffective, observedAt: nowIso, events: priorEvents } };
  }

  // Дифф-событие эмитится, только если ПРОДОЛЖАЕТ записанную цепочку: она пуста и
  // from === "1", либо последнее событие кончается ровно в from. Иначе — например,
  // токен впервые увиден после завершённой ротации (lastEffective="5", events=[]):
  // событие 5→X порвало бы таймлайн при следующем ребейзе. Честно обновляем
  // lastEffective без события — warn в serve подхватит запись без истории.
  const chainOk = priorEvents.length === 0
    ? entry.lastEffective === "1"
    : priorEvents[priorEvents.length - 1].multiplierTo === entry.lastEffective;
  if (!chainOk) {
    return { event: null, entry: { lastEffective: effective, observedAt: nowIso, events: priorEvents } };
  }

  const event = {
    type: "MULTIPLIER_CHANGE",
    mint: token.mint,
    effectiveDate: parsed.pendingEffectiveDate ?? nowIso,
    status: "confirmed",
    sources: [`solana:getAccountInfo:${token.mint}#scaledUiAmountConfig (rotation observed for ${token.symbol})`],
    multiplierFrom: entry.lastEffective,
    multiplierTo: effective,
    reason: "On-chain rebase",
  };
  try {
    validateEvent(event);
  } catch (err) {
    throw new OnchainNormalizeError(`journal transition failed validation: ${err.message}`);
  }
  return { event, entry: { lastEffective: effective, observedAt: nowIso, events: [...priorEvents, event] } };
}
