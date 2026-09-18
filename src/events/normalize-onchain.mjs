// Нормализация on-chain состояния минта в канонические MULTIPLIER_CHANGE.
// Живые находки 19.09: у PreStocks нет API истории, но события живут прямо в минте —
// SPACEX: active=1 + pending=5 c 10.06.2026 (уже эффективен), OPENAI: ×1.4861347 c 17.07.
// On-chain — первичный источник: статус confirmed; «from» при бэкфилле = поле active
// (лучшая правда цепи о предыдущем значении; промежуточные шаги между наблюдениями
// из состояния минта невосстановимы — это задокументированное ограничение, не догадка).
import { validateEvent } from "../schema/events.mjs";

export class OnchainNormalizeError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "OnchainNormalizeError";
  }
}

const DAY = 86400;

const effectiveOf = (parsed, nowMs) => {
  const pendingTs = parsed.pendingEffectiveDate ? Date.parse(parsed.pendingEffectiveDate) : null;
  return pendingTs !== null && pendingTs <= nowMs && parsed.pendingMultiplier !== null
    ? parsed.pendingMultiplier
    : parsed.activeMultiplier;
};

/**
 * Бэкфилл из текущего состояния минта (первое наблюдение).
 * @returns {object|null} каноническое MULTIPLIER_CHANGE или null, если события не видно
 */
export function backfillMultiplierEvent(token, parsed, nowMs = Date.now()) {
  if (!parsed.hasExtension) return null; // токен без механизма ребейза — фактов нет, и это факт
  if (parsed.pendingMultiplier === null || parsed.pendingEffectiveDate === null) return null;
  const from = parsed.activeMultiplier;
  const to = parsed.pendingMultiplier;
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
 * @param {{lastEffective: string, observedAt: string}|null} entry — запись журнала (null = первое наблюдение)
 * @returns {{event: object|null, entry: {lastEffective: string, observedAt: string}}}
 */
export function journalTransition(token, parsed, entry, nowMs = Date.now()) {
  const nowIso = new Date(nowMs).toISOString();
  const effective = effectiveOf(parsed, nowMs);

  if (entry === null) {
    const event = parsed.hasExtension && effective !== "1"
      ? backfillMultiplierEvent(token, parsed, nowMs)
      : null;
    // entry фиксирует ЭФФЕКТИВНУЮ величину — будущие ротации диффом от неё
    return { event, entry: { lastEffective: effective, observedAt: nowIso } };
  }

  if (effective === entry.lastEffective) {
    return { event: null, entry: { lastEffective: entry.lastEffective, observedAt: nowIso } };
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
  return { event, entry: { lastEffective: effective, observedAt: nowIso } };
}
