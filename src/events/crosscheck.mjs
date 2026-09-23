// Кросс-чек корпоративных событий против рыночной цены вокруг даты.
// Два типа с ценовой сигнатурой:
//
// 1) MULTIPLIER_CHANGE (дивиденд-ребейз) НЕ меняет цену scaled-единицы —
//    цена RAW-единицы падает в отношении from/to. Рынок в пулах торгует raw-единицы,
//    поэтому пул-цена обязана упасть ровно на дивидендную доходность в дату события.
//    Это отличает честный ребейз от перепутанного сплита/переэмиссии.
//
// 2) DIVIDEND_ACCRUAL — начисление с собственной сигнатурой: в экс-дату цена
//    единицы токена падает примерно НА ДИВИДЕНД (абсолютная величина, не отношение).
//    Математика — в raw-единицах токена, БЕЗ долларов и без FX:
//      rawClose = close × 10^decimals        — цена в raw-масштабе;
//      expectedDropRaw = amountPerUnitRaw    — ожидаемое падение цены (raw-единиц);
//      actualDropRaw = rawClosePrev − rawCloseEx — фактическая raw-дельта close.
//    Перевод в доллары честно невозможен: у amountPerUnitRaw в схеме нет валюты
//    выплаты, а курса выплаты на экс-дату в пайплайне нет. Сравнение ведём ДОЛЯМИ
//    pre-ex raw-цены (expectedFraction vs actualFraction) — это безразмерно и не
//    требует ничего сверх свечей; допуски — та же лестница, что у MULTIPLIER_CHANGE
//    (шум <0.5% → грубая аномалия ±3%; иначе tolerance = max(3%, 60% ожидания)).
//
// Цены — float-наблюдения с полным пониманием шума; количества — по-прежнему BigInt.
// Даты — через строгий schema/isodate.mjs: Date.parse перекатывает "2026-02-30" на март
// и парсит наивное время как локаль хоста — «мусорная дата — ошибка, не тихое сравнение».
import { parseIsoDateMs } from "../schema/isodate.mjs";

export class CrossCheckError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "CrossCheckError";
  }
}

const DAY = 86400;

const tsOf = (isoDate) => {
  const t = parseIsoDateMs(String(isoDate));
  if (t === null) throw new CrossCheckError(`bad date: ${isoDate}`);
  return Math.floor(t / 1000);
};

// Общая свечная рамка (семантика раунда 4, одна для обоих типов событий):
// before — последняя свеча, закрывшаяся ДО события (ts+день <= момент);
// after — первая свеча, закрывшаяся ПОСЛЕ события (её close уже несёт post-событие).
function selectAroundEvent(candles, evTs) {
  let before = null;
  let after = null;
  for (const cd of candles) {
    if (cd.ts + DAY <= evTs) before = cd;
    if (after === null && cd.ts + DAY > evTs) after = cd;
  }
  return { before, after };
}

// Даты/окно наблюдения между before- и after-свечами (общее для обоих типов).
function observedWindow(before, after) {
  return {
    beforeDate: new Date(before.ts * 1000).toISOString().slice(0, 10),
    afterDate: new Date(after.ts * 1000).toISOString().slice(0, 10),
    windowDays: Math.max(1, Math.round((after.ts - before.ts) / DAY)),
  };
}

/**
 * Один MULTIPLIER_CHANGE против дневных свечей.
 * @param {object} event — каноническое MULTIPLIER_CHANGE (multiplierFrom/To — строки)
 * @param {Array<{ts:number, c:number}>} candles — по возрастанию ts
 */
export function crossCheckMultiplierChange(event, candles) {
  if (event.type !== "MULTIPLIER_CHANGE") {
    throw new CrossCheckError(`expected MULTIPLIER_CHANGE, got ${event.type}`);
  }
  const evTs = tsOf(event.effectiveDate);
  const { before, after } = selectAroundEvent(candles, evTs);

  // Гварды входа — зеркало crossCheckDividendAccrual (ROUND7 №11): нечисловой/
  // неположительный множитель — явная ошибка, а не «mismatch» с NaN-отношением
  // (JSON молча сериализует NaN/Infinity как null — вердикт выглядел бы обоснованным).
  const from = Number(event.multiplierFrom);
  const to = Number(event.multiplierTo);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) {
    throw new CrossCheckError(`bad multiplier: from=${JSON.stringify(event.multiplierFrom)} to=${JSON.stringify(event.multiplierTo)}`);
  }
  const expectedRatio = from / to; // цена raw-единицы: было NAV/from, стало NAV/to
  const delta = Math.abs(1 - expectedRatio);

  const base = {
    effectiveDate: event.effectiveDate,
    reason: event.reason ?? null,
    multiplierFrom: event.multiplierFrom,
    multiplierTo: event.multiplierTo,
    expectedRatio,
  };

  if (!before || !after) {
    return {
      ...base,
      verdict: "no-price-data",
      observedRatio: null,
      observed: null,
      note: !before
        ? "candles do not reach back to the event date"
        : "no candle starts at/after the event date",
    };
  }

  if (before.c <= 0 || after.c <= 0) {
    // вырожденный пул (close 0/отрицательный): observedRatio = ∞/− — сильный
    // вердикт на мусоре; честное «не видно», как у дивидендного сиблинга (ROUND7 №11)
    return {
      ...base, observedRatio: null, observed: null,
      verdict: "inconclusive",
      note: `non-positive close around the event (${before.c} → ${after.c}) — rebase signature cannot be resolved`,
    };
  }

  const observedRatio = after.c / before.c;
  const observed = observedWindow(before, after);

  if (observed.windowDays > 3) {
    // дыра в свечах вокруг события (пул не торговался): окно в недели не видит
    // дивиденд в доли процента — честно говорим «не видно», а не «подозрительно»
    return {
      ...base, observedRatio, observed,
      verdict: "inconclusive",
      note: `candle gap around the event: ${observed.windowDays}-day window cannot resolve a ${(delta * 100).toFixed(3)}% rebase`,
    };
  }

  if (delta < 0.005) {
    // дивиденд < 0.5%: ожидание тонет в дневном шуме — проверяем только грубую аномалию
    const dev = Math.abs(1 - observedRatio);
    return {
      ...base, observedRatio, observed,
      verdict: dev < 0.03 ? "consistent" : "suspicious",
      note: dev < 0.03
        ? `dividend yield ${(delta * 100).toFixed(3)}% is inside daily noise (±3%) — no gross anomaly`
        : `price moved ${(observedRatio < 1 ? "" : "+")}${((observedRatio - 1) * 100).toFixed(2)}% while a ${ (delta * 100).toFixed(3) }% rebase cannot explain it`,
    };
  }

  const tolerance = Math.max(0.03, delta * 0.6);
  const dev = Math.abs(observedRatio - expectedRatio);
  return {
    ...base, observedRatio, observed,
    verdict: dev <= tolerance ? "consistent" : "mismatch",
    note: dev <= tolerance
      ? `observed ${(observedRatio).toFixed(4)} vs expected ${expectedRatio.toFixed(4)} — within tolerance ${tolerance.toFixed(3)}`
      : `observed ${observedRatio.toFixed(4)} vs expected ${expectedRatio.toFixed(4)} — market did not reprice as a plain rebase; check for split/misfile`,
  };
}

/**
 * Один DIVIDEND_ACCRUAL против дневных свечей — честная дивидендная семантика
 * (см. шапку модуля): в raw-единицах токена, без долларов и без FX.
 * @param {object} event — канонический DIVIDEND_ACCRUAL (amountPerUnitRaw — целое, decimals 0..18)
 * @param {Array<{ts:number, c:number}>} candles — по возрастанию ts
 */
export function crossCheckDividendAccrual(event, candles) {
  if (event.type !== "DIVIDEND_ACCRUAL") {
    throw new CrossCheckError(`expected DIVIDEND_ACCRUAL, got ${event.type}`);
  }
  // Мусорные поля — ошибка, не тихий вердикт (та же дисциплина, что с датами):
  // схема это гарантирует, но crossCheckEvents могут скормить и непровалидированное.
  if (!Number.isInteger(event.amountPerUnitRaw) || event.amountPerUnitRaw <= 0) {
    throw new CrossCheckError(`bad amountPerUnitRaw: ${event.amountPerUnitRaw}`);
  }
  if (!Number.isInteger(event.decimals) || event.decimals < 0 || event.decimals > 18) {
    throw new CrossCheckError(`bad decimals: ${event.decimals}`);
  }

  const evTs = tsOf(event.effectiveDate);
  const { before, after } = selectAroundEvent(candles, evTs);

  const base = {
    type: "DIVIDEND_ACCRUAL", // тип в описании вердикта: у MULTIPLIER_CHANGE полей
    // multiplierFrom/To достаточно, дивиденд же не отличим от ребейза без метки
    effectiveDate: event.effectiveDate,
    amountPerUnitRaw: event.amountPerUnitRaw,
    decimals: event.decimals,
    // ожидаемое падение цены — сам дивиденд, в raw-единицах токена
    expectedDropRaw: event.amountPerUnitRaw,
    expectedDropFraction: null, // доля pre-ex цены; известна, когда есть before-свеча
  };

  if (!before || !after) {
    return {
      ...base,
      verdict: "no-price-data",
      observedDropFraction: null,
      observed: null,
      note: !before
        ? "candles do not reach back to the event date"
        : "no candle starts at/after the event date",
    };
  }

  const scale = 10 ** event.decimals;
  const rawPrev = before.c * scale; // raw-цена до экс-даты
  const rawEx = after.c * scale;    // raw-цена первой пост-экс свечи
  const observed = observedWindow(before, after);

  if (rawPrev <= 0 || rawEx <= 0) {
    // вырожденный пул (цена 0/отрицальная С ЛЮБОЙ стороны): доля >100% или
    // отрицательная — сильный вердикт на мусоре; честное «не видно», зеркально
    // гварду обеих сторон в crossCheckMultiplierChange (ROUND9 №5)
    return {
      ...base, observedDropFraction: null, observed,
      verdict: "inconclusive",
      note: `non-positive close around the ex-date (${before.c} → ${after.c}) — dividend signature cannot be resolved`,
    };
  }

  const expectedFraction = base.expectedDropRaw / rawPrev;
  // со знаком: положительная = падение, отрицательная = цена выросла
  const actualFraction = (rawPrev - rawEx) / rawPrev;

  if (observed.windowDays > 3) {
    // та же логика, что у ребейза: недельное окно не видит дивиденд в доли процента
    return {
      ...base, expectedDropFraction: expectedFraction, observedDropFraction: actualFraction, observed,
      verdict: "inconclusive",
      note: `candle gap around the ex-date: ${observed.windowDays}-day window cannot resolve a ${(expectedFraction * 100).toFixed(3)}% dividend drop`,
    };
  }

  if (expectedFraction < 0.005) {
    // дивиденд < 0.5% pre-ex цены: тонет в дневном шуме — проверяем только грубую аномалию
    const dev = Math.abs(actualFraction);
    return {
      ...base, expectedDropFraction: expectedFraction, observedDropFraction: actualFraction, observed,
      verdict: dev < 0.03 ? "consistent" : "suspicious",
      note: dev < 0.03
        ? `dividend ${(expectedFraction * 100).toFixed(3)}% of price is inside daily noise (±3%) — no gross anomaly`
        : `price moved ${actualFraction >= 0 ? "-" : "+"}${(Math.abs(actualFraction) * 100).toFixed(2)}% while a ${(expectedFraction * 100).toFixed(3)}% dividend cannot explain it`,
    };
  }

  const tolerance = Math.max(0.03, expectedFraction * 0.6);
  const dev = Math.abs(actualFraction - expectedFraction);
  return {
    ...base, expectedDropFraction: expectedFraction, observedDropFraction: actualFraction, observed,
    verdict: dev <= tolerance ? "consistent" : "mismatch",
    note: dev <= tolerance
      ? `raw drop ${(actualFraction * 100).toFixed(2)}% vs expected ${(expectedFraction * 100).toFixed(3)}% — dividend signature within tolerance ${tolerance.toFixed(3)}`
      : `raw drop ${(actualFraction * 100).toFixed(2)}% vs expected ${(expectedFraction * 100).toFixed(3)}% — market did not drop by the dividend amount; check for misfile`,
  };
}

/**
 * Все события токена против одного Candle-набора + покрытие истории.
 *
 * ПОРЯДОК ВЕРДИКТОВ — КОНТРАКТ витрины (src/ui/page.mjs склеивает вердикты с
 * MULTIPLIER_CHANGE-событиями по порядковому номеру): сначала все MULTIPLIER_CHANGE
 * в порядке событий (историческое поведение без изменений), затем DIVIDEND_ACCRUAL
 * в порядке событий. Дивидендный вердикт помечен type: "DIVIDEND_ACCRUAL".
 * @returns {{verdicts: Array, coverage: {candlesFrom: string|null, candlesTo: string|null, candles: number}}}
 */
export function crossCheckEvents(events, candles) {
  const mult = events.filter((e) => e.type === "MULTIPLIER_CHANGE");
  const divs = events.filter((e) => e.type === "DIVIDEND_ACCRUAL");
  const verdicts = [
    ...mult.map((e) => crossCheckMultiplierChange(e, candles)),
    ...divs.map((e) => crossCheckDividendAccrual(e, candles)),
  ];
  const coverage = {
    candles: candles.length,
    candlesFrom: candles.length ? new Date(candles[0].ts * 1000).toISOString().slice(0, 10) : null,
    candlesTo: candles.length ? new Date(candles[candles.length - 1].ts * 1000).toISOString().slice(0, 10) : null,
  };
  return { verdicts, coverage };
}
