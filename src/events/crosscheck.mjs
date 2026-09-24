// Cross-check of corporate events against the market price around the date.
// Two types carry a price signature:
//
// 1) MULTIPLIER_CHANGE (a dividend rebase) does NOT change the price of a scaled unit —
//    the RAW-unit price drops in the from/to ratio. The market in pools trades raw units,
//    so the pool price must drop by exactly the dividend yield on the event date.
//    This distinguishes an honest rebase from a confused split/reissuance.
//
// 2) DIVIDEND_ACCRUAL — an accrual with its own signature: on the ex-date the price
//    of a token unit drops by roughly THE DIVIDEND (an absolute value, not a ratio).
//    The math is in raw token units, WITHOUT dollars and without FX:
//      rawClose = close × 10^decimals        — the price in raw scale;
//      expectedDropRaw = amountPerUnitRaw    — the expected price drop (raw units);
//      actualDropRaw = rawClosePrev − rawCloseEx — the actual raw delta of close.
//    Conversion to dollars is honestly impossible: amountPerUnitRaw in the schema has no
//    payout currency, and the payout rate on the ex-date is absent from the pipeline.
//    The comparison is done in FRACTIONS of the pre-ex raw price (expectedFraction vs
//    actualFraction) — that is dimensionless and needs nothing beyond the candles; the
//    tolerances are the same ladder as for MULTIPLIER_CHANGE (noise <0.5% → a gross
//    anomaly is ±3%; otherwise tolerance = max(3%, 60% of the expectation)).
//
// Prices are float observations with a full understanding of the noise; quantities are still BigInt.
// Dates go through the strict schema/isodate.mjs: Date.parse rolls "2026-02-30" over to March
// and parses naive time as the host locale — "a garbage date is an error, not a silent comparison".
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

// Shared candle frame (round 4 semantics, one frame for both event types):
// before — the last candle that closed BEFORE the event (ts+day <= the moment);
// after — the first candle that closed AFTER the event (its close already carries the post-event state).
function selectAroundEvent(candles, evTs) {
  let before = null;
  let after = null;
  for (const cd of candles) {
    if (cd.ts + DAY <= evTs) before = cd;
    if (after === null && cd.ts + DAY > evTs) after = cd;
  }
  return { before, after };
}

// Dates/observation window between the before- and after-candles (shared by both types).
function observedWindow(before, after) {
  return {
    beforeDate: new Date(before.ts * 1000).toISOString().slice(0, 10),
    afterDate: new Date(after.ts * 1000).toISOString().slice(0, 10),
    windowDays: Math.max(1, Math.round((after.ts - before.ts) / DAY)),
  };
}

/**
 * One MULTIPLIER_CHANGE against daily candles.
 * @param {object} event — a canonical MULTIPLIER_CHANGE (multiplierFrom/To are strings)
 * @param {Array<{ts:number, c:number}>} candles — ascending by ts
 */
export function crossCheckMultiplierChange(event, candles) {
  if (event.type !== "MULTIPLIER_CHANGE") {
    throw new CrossCheckError(`expected MULTIPLIER_CHANGE, got ${event.type}`);
  }
  const evTs = tsOf(event.effectiveDate);
  const { before, after } = selectAroundEvent(candles, evTs);

  // Input guards — a mirror of crossCheckDividendAccrual (ROUND7 fix 11): a non-numeric/
  // non-positive multiplier is an explicit error, not a "mismatch" with a NaN ratio
  // (JSON silently serializes NaN/Infinity as null — the verdict would have looked substantiated).
  const from = Number(event.multiplierFrom);
  const to = Number(event.multiplierTo);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) {
    throw new CrossCheckError(`bad multiplier: from=${JSON.stringify(event.multiplierFrom)} to=${JSON.stringify(event.multiplierTo)}`);
  }
  const expectedRatio = from / to; // raw-unit price: it was NAV/from, it became NAV/to
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

  if (!Number.isFinite(before.c) || !Number.isFinite(after.c) || before.c <= 0 || after.c <= 0) {
    // degenerate pool: close 0/negative/NOT-A-NUMBER (NaN/Infinity/undefined —
    // wave B: NaN <= 0 is false and passed the guard, yielding a "mismatch" with null fields).
    // observedRatio = ∞/−/NaN — a strong verdict on garbage; an honest "not visible",
    // mirroring the dividend sibling (ROUND7 fix 11, ROUND9 fix 5, wave B)
    return {
      ...base, observedRatio: null, observed: null,
      verdict: "inconclusive",
      note: `unusable close around the event (${before.c} → ${after.c}) — rebase signature cannot be resolved`,
    };
  }

  const observedRatio = after.c / before.c;
  const observed = observedWindow(before, after);

  if (observed.windowDays > 3) {
    // a hole in the candles around the event (the pool did not trade): a window of weeks
    // cannot see a dividend within fractions of a percent — we honestly say "not visible",
    // not "suspicious"
    return {
      ...base, observedRatio, observed,
      verdict: "inconclusive",
      note: `candle gap around the event: ${observed.windowDays}-day window cannot resolve a ${(delta * 100).toFixed(3)}% rebase`,
    };
  }

  if (delta < 0.005) {
    // a dividend < 0.5%: the expectation drowns in daily noise — only a gross anomaly is checked
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
 * One DIVIDEND_ACCRUAL against daily candles — honest dividend semantics
 * (see the module header): in raw token units, without dollars and without FX.
 * @param {object} event — a canonical DIVIDEND_ACCRUAL (amountPerUnitRaw an integer, decimals 0..18)
 * @param {Array<{ts:number, c:number}>} candles — ascending by ts
 */
export function crossCheckDividendAccrual(event, candles) {
  if (event.type !== "DIVIDEND_ACCRUAL") {
    throw new CrossCheckError(`expected DIVIDEND_ACCRUAL, got ${event.type}`);
  }
  // Garbage fields are an error, not a silent verdict (the same discipline as with dates):
  // the schema guarantees this, but crossCheckEvents can be fed unvalidated input too.
  if (!Number.isInteger(event.amountPerUnitRaw) || event.amountPerUnitRaw <= 0) {
    throw new CrossCheckError(`bad amountPerUnitRaw: ${event.amountPerUnitRaw}`);
  }
  if (!Number.isInteger(event.decimals) || event.decimals < 0 || event.decimals > 18) {
    throw new CrossCheckError(`bad decimals: ${event.decimals}`);
  }

  const evTs = tsOf(event.effectiveDate);
  const { before, after } = selectAroundEvent(candles, evTs);

  const base = {
    type: "DIVIDEND_ACCRUAL", // the type in the verdict description: for MULTIPLIER_CHANGE the
    // multiplierFrom/To fields suffice, while a dividend is indistinguishable from a rebase without a label
    effectiveDate: event.effectiveDate,
    amountPerUnitRaw: event.amountPerUnitRaw,
    decimals: event.decimals,
    // the expected price drop is the dividend itself, in raw token units
    expectedDropRaw: event.amountPerUnitRaw,
    expectedDropFraction: null, // a fraction of the pre-ex price; known once a before-candle exists
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
  const rawPrev = before.c * scale; // the raw price before the ex-date
  const rawEx = after.c * scale;    // the raw price of the first post-ex candle
  const observed = observedWindow(before, after);

  if (!Number.isFinite(rawPrev) || !Number.isFinite(rawEx) || rawPrev <= 0 || rawEx <= 0) {
    // degenerate pool: close 0/negative/NOT-A-NUMBER on either side (wave B:
    // NaN passed rawPrev<=0, expectedFraction became NaN → a "mismatch") —
    // the fraction cannot be built, an honest "not visible" (ROUND9 fix 5 extended to both sides+finite)
    return {
      ...base, observedDropFraction: null, observed,
      verdict: "inconclusive",
      note: `unusable close around the ex-date (${before.c} → ${after.c}) — dividend signature cannot be resolved`,
    };
  }

  const expectedFraction = base.expectedDropRaw / rawPrev;
  // signed: positive = a drop, negative = the price rose
  const actualFraction = (rawPrev - rawEx) / rawPrev;

  if (observed.windowDays > 3) {
    // the same logic as for the rebase: a weekly window cannot see a dividend within fractions of a percent
    return {
      ...base, expectedDropFraction: expectedFraction, observedDropFraction: actualFraction, observed,
      verdict: "inconclusive",
      note: `candle gap around the ex-date: ${observed.windowDays}-day window cannot resolve a ${(expectedFraction * 100).toFixed(3)}% dividend drop`,
    };
  }

  if (expectedFraction < 0.005) {
    // a dividend < 0.5% of the pre-ex price: it drowns in daily noise — only a gross anomaly is checked
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
 * All events of a token against one Candle set + history coverage.
 *
 * VERDICT ORDER — THE VITRINE CONTRACT (src/ui/page.mjs glues verdicts to
 * MULTIPLIER_CHANGE events by ordinal): first all MULTIPLIER_CHANGE
 * in event order (historical behavior unchanged), then DIVIDEND_ACCRUAL
 * in event order. The dividend verdict is labeled type: "DIVIDEND_ACCRUAL".
 * @returns {{verdicts: Array, coverage: {candlesFrom: string|null, candlesTo: string|null, candles: number}}}
 */
export function crossCheckEvents(events, candles) {
  // Candle shape guard (wave B): garbage ts (NaN/undefined from a lying gateway)
  // used to reach new Date(NaN*1000) in coverage → RangeError → /crosscheck
  // fell with a generic 500, although the module's discipline is a typed CrossCheckError.
  for (const cd of candles) {
    if (!Number.isFinite(cd.ts)) {
      throw new CrossCheckError(`candle with non-finite ts: ${JSON.stringify(cd.ts)}`);
    }
  }
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
