// Кросс-чек события множителя против рыночной цены вокруг даты.
// Идея: MULTIPLIER_CHANGE (дивиденд-ребейз) НЕ меняет цену scaled-единицы —
// цена RAW-единицы падает в отношении from/to. Рынок в пулах торгует raw-единицы,
// поэтому пул-цена обязана упасть ровно на дивидендную доходность в дату события.
// Это отличает честный ребейз от перепутанного сплита/переэмиссии.
// Цены — float-наблюдения с полным пониманием шума; количества — по-прежнему BigInt.
export class CrossCheckError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "CrossCheckError";
  }
}

const DAY = 86400;

const tsOf = (isoDate) => {
  const t = Date.parse(isoDate);
  if (Number.isNaN(t)) throw new CrossCheckError(`bad date: ${isoDate}`);
  return Math.floor(t / 1000);
};

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

  // before: последняя свеча, закрывшаяся ДО события (ts+день <= момент)
  // after: первая свеча, закрывшаяся ПОСЛЕ события (её close уже несёт post-событие)
  let before = null;
  let after = null;
  for (const cd of candles) {
    if (cd.ts + DAY <= evTs) before = cd;
    if (after === null && cd.ts + DAY > evTs) after = cd;
  }

  const from = Number(event.multiplierFrom);
  const to = Number(event.multiplierTo);
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

  const observedRatio = after.c / before.c;
  const windowDays = Math.max(1, Math.round((after.ts - before.ts) / DAY));
  const observed = {
    beforeDate: new Date(before.ts * 1000).toISOString().slice(0, 10),
    afterDate: new Date(after.ts * 1000).toISOString().slice(0, 10),
    windowDays,
  };

  if (windowDays > 3) {
    // дыра в свечах вокруг события (пул не торговался): окно в недели не видит
    // дивиденд в доли процента — честно говорим «не видно», а не «подозрительно»
    return {
      ...base, observedRatio, observed,
      verdict: "inconclusive",
      note: `candle gap around the event: ${windowDays}-day window cannot resolve a ${(delta * 100).toFixed(3)}% rebase`,
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
 * Все MULTIPLIER_CHANGE токена против одного Candle-набора + покрытие истории.
 * @returns {{verdicts: Array, coverage: {candlesFrom: string|null, candlesTo: string|null, candles: number}}}
 */
export function crossCheckEvents(events, candles) {
  const mult = events.filter((e) => e.type === "MULTIPLIER_CHANGE");
  const verdicts = mult.map((e) => crossCheckMultiplierChange(e, candles));
  const coverage = {
    candles: candles.length,
    candlesFrom: candles.length ? new Date(candles[0].ts * 1000).toISOString().slice(0, 10) : null,
    candlesTo: candles.length ? new Date(candles[candles.length - 1].ts * 1000).toISOString().slice(0, 10) : null,
  };
  return { verdicts, coverage };
}
