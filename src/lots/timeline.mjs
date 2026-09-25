// Multiplier timeline: exact integer arithmetic over
// canonical MULTIPLIER_CHANGE events. Float is forbidden: the decimal string
// of a multiplier becomes an exact BigInt fraction.
import { parseIsoDateMs } from "../schema/isodate.mjs";

export class TimelineError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "TimelineError";
  }
}

/**
 * "1.005714560286254" → { num: 1005714560286254n, den: 10n**15n } — exact.
 */
export function decimalToRatio(dec) {
  if (typeof dec !== "string" || !/^\d+(\.\d+)?$/.test(dec)) {
    throw new TimelineError(`not a decimal string: ${JSON.stringify(dec)}`);
  }
  const [intPart, fracPart = ""] = dec.split(".");
  // cap of 30 fractional digits — PAIRED with schema/events.mjs (MAX_MULTIPLIER_FRACTION_DIGITS)
  if (fracPart.length > 30) throw new TimelineError(`multiplier precision >30 digits unsupported: ${dec}`);
  return {
    num: BigInt(intPart + fracPart),
    den: 10n ** BigInt(fracPart.length),
  };
}

/**
 * The multiplier timeline of a single mint. Built from MULTIPLIER_CHANGE events
 * (any order; EXCEPTION — equal activationDateTime: such events must arrive in chain
 * order, a reversed pair order breaks continuity —
 *; issuers have not been seen using instant duplicates), validates
 * the CONTINUITY of the chain (from[i+1] === to[i])
 * and its starting point at 1 — fail-closed: a gap is an error, not a guess.
 */
// Date comparison — numeric (unix-ms) only, never lexicographic:
// "2026-06-18T00:00:00.000Z" > "2026-06-18" as strings, although it is the same moment —
// the UI calculator sends date-only, and day-D's event must count as effective.
// Parsing goes through strict schema/isodate.mjs, not Date.parse: the latter "rolls"
// "2026-02-30" over into March and parses naive time in the host's locale — a garbage date
// is an error here (TimelineError), not a silent comparison against someone else's day.
const tsOf = (iso) => {
  const t = parseIsoDateMs(String(iso));
  if (t === null) {
    throw new TimelineError(`not a parseable ISO date: ${JSON.stringify(iso)}`);
  }
  return t;
};

export class MultiplierTimeline {
  constructor(events = []) {
    // Date validation BEFORE sorting: with a single event the comparator never runs,
    // and effectiveDate:null/garbage leaked into steps with at:null — multiplierAt silently
    // treated such a step as the "baseline" and returned someone else's multiplier.
    for (const e of events) tsOf(e?.effectiveDate);
    const sorted = [...events].sort((a, b) => tsOf(a.effectiveDate) - tsOf(b.effectiveDate));
    let expected = "1";
    this.steps = [{ at: null, multiplier: "1" }]; // baseline before the first event
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

  /** The multiplier in effect at date (ISO; date-only = midnight UTC of that day). */
  multiplierAt(date) {
    const ts = tsOf(date); // a garbage date is an error, not a silent falsehood
    let current = this.steps[0].multiplier;
    for (const s of this.steps) {
      if (s.at === null) continue; // the baseline
      if (tsOf(s.at) <= ts) current = s.multiplier; // an event exactly at this moment is already in effect
      else break; // steps are sorted — beyond lies only the future
    }
    return current;
  }

  factorAt(date) {
    return decimalToRatio(this.multiplierAt(date));
  }

  /**
   * scaled = raw × multiplier, integer and honest:
   * exact=true if it divides evenly; otherwise whole (floor) + remainder/den.
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
