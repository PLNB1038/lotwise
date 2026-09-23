// Производитель DIVIDEND_ACCRUAL из ДЕКЛАРАЦИЙ эмитента — вариант Б («честный к данным»).
//
// ПОЧЕМУ ПРЯМОЙ МАППИНГ ИЗ multiplier/history НЕВОЗМОЖЕН (исследование 2026-09-22,
// живые ответы в test/fixtures/dividends-*.json):
//   1) Узлы истории множителей с reason "Dividend" (SPYx, KOx, JPMx, network=Solana)
//      содержат РОВНО пять полей: id, reason, multiplier, previousMultiplier,
//      activationDateTime. Ни суммы на единицу, ни ex/pay/record-дат, ни NAV.
//   2) Отдельного дивидендного эндпоинта нет: GET /api/v2/public/assets/SPYx/dividends
//      → 404 Cannot GET.
//   3) Карточка актива /api/v2/public/assets/SPYx не содержит дивидендных полей вовсе:
//      только id/name/symbol/isin/underlying*/description/logo/isTradingHalted/
//      trading/deployments (ни одного ключа с div/nav/yield/amount).
//   Отношение multiplierTo/previousMultiplier — ребейз всей NAV (движение цены
//   ПЛЮС выплата), цена на экс-дату в узле отсутствует: вывести $-сумму из
//   множителя математически = СИНТЕЗИРОВАТЬ данные, которых эмитент не декларировал.
//   Правило проекта (см. dividend-e2e, GAP 1): ничего не выводить из множителя.
//   Поэтому здесь НЕТ и не будет функции «multiplier-узел → DIVIDEND_ACCRUAL».
//
// ЧТО ЗДЕСЬ ЕСТЬ — контракт «декларация эмитента»: структурированный вход
//   { symbol, exDate, amountPerUnitRaw, decimals, sourceUrl }, где
//     - amountPerUnitRaw — ЦЕЛОЕ, raw-единицы ВЫПЛАТЫ на одну raw-единицу токена
//       (семантика движка, lots.mjs: totalRaw = amountPerUnitRaw × Σ qtyRaw),
//       например декларация «$2.00 на акцию» при 6 десятичных выплаты → "2000000";
//       перевод объявленной суммы в raw — обязанность ПОДАЮЩЕГО, не производителя;
//     - decimals — десятичные знаки токена/выплаты (0..18, как в схеме);
//     - exDate — канонический ISO-8601 (src/schema/isodate.mjs); в схеме события
//       единственная дата — effectiveDate (e2e GAP 5: payout-дат в схеме нет),
//       поэтому exDate ложится в effectiveDate как есть, без переформатирования;
//     - sourceUrl — ссылка на публикацию эмитента, ложится в sources как есть.
//   Событие возвращается БЕЗ mint — привязка к минту из реестра по символу
//   выполняется вызывающим слоем через bindMintAndValidate (normalize-xstocks.mjs),
//   тот же контракт, что у multiplierHistoryToEvents.
//
// ТРИГГЕР РАСШИРЕНИЯ: если у эмитента появится эндпоинт, ДЕКЛАРИРУЮЩИЙ денежную
// сумму на единицу и экс-дату (например /dividends или поля distribution в карточке
// актива) — сюда добавляется именованный нормализатор этого ответа в форму
// декларации (1:1, без вычислений суммы из множителя), и только тогда данные
// эмитента поедут в движок напрямую. До этого момента DIVIDEND_ACCRUAL вводится
// декларацией, подтверждённой ссылкой на эмитента.
//
// Числа: на входе целые (number) ИЛИ строки цифр — оба канала точны; float
// отклоняется. Никакой математики, кроме проверки диапазона: Number.isInteger
// и Number.MAX_SAFE_INTEGER — потолок самой схемы (см. validateEvent).
import { isValidIsoDate, parseIsoDateMs } from "../schema/isodate.mjs";

// Ошибка некорректной декларации — fail-closed, как NormalizeError в xstocks:
// одна битая строка декларации громко валит подачу, а не теряется молча.
export class DeclarationError extends Error {
  constructor(msg, decl) {
    super(msg);
    this.name = "DeclarationError";
    this.decl = decl;
  }
}

// Строгий разбор целого: целое число (в т.ч. из JSON) или строка ТОЛЬКО из цифр.
// Строка проходит через BigInt — «10000000000000000000» не теряет точность на
// промежуточном double. Float, экспонента, знак, пробелы, мусор — ошибка.
function toPositiveSafeInteger(v, field, decl) {
  let bi;
  if (typeof v === "number") {
    if (!Number.isInteger(v)) {
      throw new DeclarationError(`${field} must be an integer, got ${String(v)} (float запрещён)`, decl);
    }
    bi = BigInt(v);
  } else if (typeof v === "string" && /^\d+$/.test(v)) {
    bi = BigInt(v);
  } else {
    throw new DeclarationError(`${field} must be a positive integer or a digit string, got ${JSON.stringify(v)}`, decl);
  }
  if (bi <= 0n) {
    throw new DeclarationError(`${field} must be positive, got ${JSON.stringify(v)}`, decl);
  }
  // Выше потолка схемы событие несомо (validateEvent требует Number.isInteger):
  // Number(bi) потерял бы точность МОЛЧА — поэтому граница именно здесь.
  if (bi > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DeclarationError(`${field} exceeds Number.MAX_SAFE_INTEGER — схема событие не выдержит`, decl);
  }
  return Number(bi);
}

// Целое 0..18 — диапазон схемы для decimals (та же дисциплина разбора).
function toDecimals(v, decl) {
  if (typeof v === "number" && Number.isInteger(v)) {
    if (v < 0 || v > 18) {
      throw new DeclarationError(`decimals must be an integer 0..18, got ${JSON.stringify(v)}`, decl);
    }
    return v;
  }
  if (typeof v === "string" && /^\d+$/.test(v)) {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n > 18) {
      throw new DeclarationError(`decimals must be an integer 0..18, got ${JSON.stringify(v)}`, decl);
    }
    return n;
  }
  throw new DeclarationError(`decimals must be an integer 0..18 or a digit string, got ${JSON.stringify(v)}`, decl);
}

/**
 * Декларации эмитента → канонические DIVIDEND_ACCRUAL (без mint).
 *
 * @param {Array<{symbol: string, exDate: string, amountPerUnitRaw: number|string,
 *                decimals: number|string, sourceUrl: string}>} declarations
 *   Декларации эмитента. Чужие символы (несовпадающие с ctx.symbol без учёта
 *   регистра) СКИПАЮТСЯ — одна подача может содержать ленту по многим токенам;
 *   декларация с отсутствующим/нестроковым symbol — брак подачи → DeclarationError.
 * @param {{symbol: string}} ctx
 *   Символ токена, для которого строим события (например "KOx"); обязателен.
 * @returns {Array<object>} DIVIDEND_ACCRUAL без mint, старые → новые.
 *   Точные дубликаты деклараций (тот же symbol/exDate/amount/decimals/sourceUrl)
 *   схлопываются — повторная подача ленты не должна удваивать начисление движка.
 *   БЛИЗКИЕ, но не равные декларации (другой sourceUrl) НЕ схлопываются: без id
 *   в декларации различить «повтор» и «два разных объявления одной датой» нельзя —
 *   сознательный трейд-офф, зеркалит «full:»-дедуп normalize-xstocks.
 */
export function dividendsFromDeclarations(declarations, { symbol } = {}) {
  if (typeof symbol !== "string" || symbol === "") {
    throw new DeclarationError("ctx.symbol is required (token symbol, e.g. \"KOx\")");
  }
  if (!Array.isArray(declarations)) {
    throw new DeclarationError("declarations must be an array");
  }

  const wanted = symbol.toUpperCase();
  const events = [];
  const seen = new Map(); // ключ точного дубликата → событие (первое вхождение выигрывает)

  for (const decl of declarations) {
    if (decl === null || typeof decl !== "object") {
      throw new DeclarationError("declaration must be an object", decl);
    }
    if (typeof decl.symbol !== "string" || decl.symbol === "") {
      throw new DeclarationError("declaration.symbol is required (string)", decl);
    }
    if (decl.symbol.toUpperCase() !== wanted) continue; // чужой токен в общей ленте

    // Дата: канонический ISO-8601 проекта (форма + реальный календарь + таймзона
    // у datetime). Мусорная дата — ошибка здесь, а не NaN где-то в движке.
    if (typeof decl.exDate !== "string" || !isValidIsoDate(decl.exDate)) {
      throw new DeclarationError(
        `exDate must be canonical ISO-8601: YYYY-MM-DD or YYYY-MM-DDTHH:mm[:ss[.fff]](Z|±HH:MM), got ${JSON.stringify(decl.exDate)}`,
        decl,
      );
    }
    // Источник: минимальная проверка — та же планка, что в схеме (не пустая строка).
    if (typeof decl.sourceUrl !== "string" || decl.sourceUrl.length < 4) {
      throw new DeclarationError(`sourceUrl must be a non-empty string (URL or reference), got ${JSON.stringify(decl.sourceUrl)}`, decl);
    }
    const amountPerUnitRaw = toPositiveSafeInteger(decl.amountPerUnitRaw, "amountPerUnitRaw", decl);
    const decimals = toDecimals(decl.decimals, decl);

    // Декларация — утверждение эмитента с присланной ссылкой: статус "confirmed",
    // как у официального API эмитента в normalize-xstocks. Незмитентские источники
    // в этот контракт подавать нельзя.
    const e = {
      type: "DIVIDEND_ACCRUAL",
      effectiveDate: decl.exDate,
      status: "confirmed",
      sources: [decl.sourceUrl],
      amountPerUnitRaw,
      decimals,
    };
    // Ключ дедупа — МОМЕНТ даты, не строка (ROUND7 №12): «2026-06-18» и
    // «2026-06-18T00:00:00Z» — один и тот же экс-день; строковый ключ давал два
    // DIVIDEND_ACCRUAL и двойное начисление движком. parseIsoDateMs не даст null:
    // exDate уже прошёл isValidIsoDate выше.
    const key = JSON.stringify([decl.symbol.toUpperCase(), parseIsoDateMs(decl.exDate), amountPerUnitRaw, decimals, decl.sourceUrl]);
    if (seen.has(key)) continue;
    seen.set(key, e);
    events.push(e);
  }

  // Сорт по моменту времени (числом, не строкой) — детерминированный порядок
  // старые → новые, как в multiplierHistoryToEvents; даты уже канонические,
  // parseIsoDateMs здесь не может дать null.
  return events
    .map((e) => ({ e, ts: parseIsoDateMs(e.effectiveDate) }))
    .sort((a, b) => a.ts - b.ts)
    .map(({ e }) => e);
}
