// Обогащение реестра decimals из батч-ответа Jupiter Price API (раунд 6).
// Логика вынесена из scripts/enrich-decimals.mjs ради тестируемости двух контрактов
// находки LW2_tokens_json_write_non_atomic:
//   (1) запись атомарна (atomicWriteJson — усечённый tokens.json ронял сервис целиком);
//   (2) filled=0 ⇒ файл не перезаписывается вовсе: раньше каждая прогулка скрипта
//       переписывала файл безусловно и повторяла окно обрыва записи без малейшей причины.
// Валидация decimals — НА ВХОДЕ (квирк конвейера): мусор от API (отрицательные, >18,
// не-целые, не-числа) не доходит до файла — запись не трогается, символ уходит в
// skipped. Раньше мусорная запись эмитента данных клала весь реестр в corrupted-режим
// уже на загрузке; validateRegistryEntry в registry.mjs остаётся вторым рубежом.
import { readFileSync } from "node:fs";
import { atomicWriteJson } from "../fs/atomic.mjs";

// Контракт decimals: null | integer 0..18 (единый с registry.mjs)
const DECIMALS_MIN = 0;
const DECIMALS_MAX = 18;

/**
 * Вписывает decimals в список токенов из ответа Jupiter (мутирует list, как и раньше:
 * заполняются только записи с decimals === null; уже обогащённые игнорируются целиком,
 * мусор в их части ответа в skipped не попадает).
 * Валидация на входе:
 *   - null/undefined в ответе — единообразно «нет значения»: запись не трогается,
 *     метка sourceDecimals не ставится;
 *   - не-integer или вне 0..18 — запись не трогается, символ попадает в skipped
 *     с причиной "invalid-decimals".
 * @param {Array<{mint: string, decimals: number|null, sourceDecimals?: string}>} list
 * @param {Record<string, {decimals?: number}>} prices — ответ lite-api.jup.ag/price/v3
 * @returns {{filled: number, unknown: string[], skipped: Array<{symbol: string, reason: string}>}}
 *   unknown — символы, которых нет в ответе; skipped — отклонённый мусор с причиной
 */
export function applyJupiterDecimals(list, prices) {
  let filled = 0;
  const unknown = [];
  const skipped = [];
  for (const t of list) {
    const p = prices?.[t.mint];
    if (!p) {
      unknown.push(t.symbol);
      continue;
    }
    if (t.decimals !== null) continue; // уже обогащена — ответ для неё не читаем вовсе
    const raw = p.decimals;
    if (raw === null || raw === undefined) continue; // «нет значения» — метку не ставим
    if (!Number.isInteger(raw) || raw < DECIMALS_MIN || raw > DECIMALS_MAX) {
      skipped.push({ symbol: t.symbol, reason: "invalid-decimals" });
      continue; // запись НЕ трогается: decimals остаётся как был
    }
    t.decimals = raw;
    t.sourceDecimals = "jupiter";
    filled++;
  }
  return { filled, unknown, skipped };
}

/**
 * Обогащение файла реестра на диске. filled=0 → файл не открывается на запись вовсе
 * (в том числе когда всё ушло в skipped: отклонённые записи не менялись — писать нечего).
 * @param {string} path — путь к data/tokens.json
 * @param {Record<string, {decimals?: number}>} prices
 * @returns {{filled: number, unknown: string[], skipped: Array<{symbol: string, reason: string}>, written: boolean}}
 */
export function enrichDecimalsFile(path, prices) {
  const list = JSON.parse(readFileSync(path, "utf8"));
  const { filled, unknown, skipped } = applyJupiterDecimals(list, prices);
  if (filled === 0) {
    return { filled, unknown, skipped, written: false };
  }
  atomicWriteJson(path, list);
  return { filled, unknown, skipped, written: true };
}
