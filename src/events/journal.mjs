// Шаг синкронизации on-chain журнала — чистая функция над (запись журнала, план цепи).
// Выделена из serve.mjs ради тестируемости P0-инварианта: события журнала переживают
// рестарт процесса. parsed === null — цепь недоступна: реплеем кэш прошлых событий,
// запись журнала не трогаем (observedAt остаётся честно протухшим).
import { journalTransition } from "./normalize-onchain.mjs";

/**
 * @param {object} token — запись реестра (нужны mint, symbol)
 * @param {{lastEffective: string, observedAt: string, events?: Array}|null} priorEntry — запись из журнала на диске
 * @param {object|null} parsed — parseScaledUiAmount(...) или null, если цепь недоступна
 * @returns {{replay: Array, event: object|null, entry: object|null, chain: "ok"|"unavailable"}}
 *   replay — события прошлых сессий для реплея в events-поток;
 *   event — ТОЛЬКО новое событие этого шага;
 *   entry — запись к сохранению (null = нечего сохранить, история не начата);
 *   entry===priorEntry (та же ссылка) при недоступной цепи — сохранение без изменений.
 */
export function planJournalStep(token, priorEntry, parsed, nowMs = Date.now()) {
  // v2-маркер записи — массив events; записи v1 (без него) прогоняются бэкфиллом:
  // так задеплоенный инстанс самовосстанавливается без ручной миграции файла
  const base = priorEntry !== null && priorEntry !== undefined && Array.isArray(priorEntry.events)
    ? priorEntry
    : null;
  const replay = base ? base.events : [];
  if (parsed === null) {
    return { replay, event: null, entry: base, chain: "unavailable" };
  }
  const { event, entry } = journalTransition(token, parsed, base, nowMs);
  return { replay, event, entry, chain: "ok" };
}
