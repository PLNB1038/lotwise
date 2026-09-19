// Временная шкала множителя: точная целочисленная арифметика поверх
// канонических MULTIPLIER_CHANGE. Float запрещён: десятичная строка
// множителя превращается в точную BigInt-дробь.
export class TimelineError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "TimelineError";
  }
}

/**
 * "1.005714560286254" → { num: 1005714560286254n, den: 10n**15n } — точно.
 */
export function decimalToRatio(dec) {
  if (typeof dec !== "string" || !/^\d+(\.\d+)?$/.test(dec)) {
    throw new TimelineError(`not a decimal string: ${JSON.stringify(dec)}`);
  }
  const [intPart, fracPart = ""] = dec.split(".");
  if (fracPart.length > 30) throw new TimelineError(`multiplier precision >30 digits unsupported: ${dec}`);
  return {
    num: BigInt(intPart + fracPart),
    den: 10n ** BigInt(fracPart.length),
  };
}

/**
 * Шкала множителя одного минта. Строится из событий MULTIPLIER_CHANGE
 * (любой порядок), проверяет НЕПРЕРЫВНОСТЬ ЦЕПОЧКИ (from[i+1] === to[i])
 * и её отправную точку от 1 — fail-closed: разрыв = ошибка, не догадка.
 */
// Сравнение дат — только через Date.parse, никогда лексикографически:
// "2026-06-18T00:00:00.000Z" > "2026-06-18" строково, хотя это тот же момент —
// калькулятор витрины шлёт date-only, и событие дня Д обязано считаться эффективным.
const tsOf = (iso) => {
  const t = Date.parse(String(iso));
  if (Number.isNaN(t)) {
    throw new TimelineError(`not a parseable ISO date: ${JSON.stringify(iso)}`);
  }
  return t;
};

export class MultiplierTimeline {
  constructor(events = []) {
    const sorted = [...events].sort((a, b) => tsOf(a.effectiveDate) - tsOf(b.effectiveDate));
    let expected = "1";
    this.steps = [{ at: null, multiplier: "1" }]; // базовая линия до первого события
    for (const e of sorted) {
      if (e.type !== "MULTIPLIER_CHANGE") {
        throw new TimelineError(`timeline accepts only MULTIPLIER_CHANGE, got ${e.type}`);
      }
      if (e.multiplierFrom !== expected) {
        throw new TimelineError(
          `chain discontinuity at ${e.effectiveDate}: expected from=${expected}, got ${e.multiplierFrom}`,
        );
      }
      this.steps.push({ at: e.effectiveDate, multiplier: e.multiplierTo });
      expected = e.multiplierTo;
    }
  }

  /** Множитель, действующий на момент date (ISO; date-only = полночь UTC того дня). */
  multiplierAt(date) {
    const ts = tsOf(date); // мусорная дата — ошибка, а не молчаливая неправда
    let current = this.steps[0].multiplier;
    for (const s of this.steps) {
      if (s.at === null) continue; // базовая линия
      if (tsOf(s.at) <= ts) current = s.multiplier; // событие ровно в этот момент — уже действует
      else break; // steps отсортированы — дальше только будущее
    }
    return current;
  }

  factorAt(date) {
    return decimalToRatio(this.multiplierAt(date));
  }

  /**
   * scaled = raw × multiplier, целочисленно и честно:
   * exact=true если делится нацело; иначе whole (округление вниз) + remainder/den.
   */
  scaledQty(rawQty, date) {
    if (typeof rawQty !== "bigint") throw new TimelineError("rawQty must be BigInt");
    const { num, den } = this.factorAt(date);
    const scaledNum = rawQty * num;
    return {
      whole: scaledNum / den,
      remainder: scaledNum % den,
      den,
      exact: (scaledNum % den) === 0n,
    };
  }
}
