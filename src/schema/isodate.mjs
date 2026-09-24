// Strict validator/parser of canonical ISO-8601 — the single source of the project's date semantics.
//
// WHY (round 2–3 findings, docs/review): Date.parse is a poor validator.
//  - "2026-13-01", "2026-00-10", "2026-06-18T23:59:60Z", "+99:99" pass the SHAPE check,
//    while Date.parse yields NaN — the error surfaces later, already as a 500 on /summary
//    (journal replay and xstocks history pass only schema validation);
//  - silent rollover: Date.parse("2026-02-30") = Mar 2, ("2026-06-31") = Jul 1,
//    ("2027-02-29") = Mar 1, ("2026-06-18T24:00:00Z") = Jun 19 — the NaN guards stay silent,
//    the multiplier is computed from someone else's day;
//  - a naive datetime ("2026-06-18T12:00:00") is parsed as the host's LOCAL time —
//    every comparison shifts by the time zone.
// Project principle: "a garbage date is an error, not a silent comparison". Hence here:
// shape + a real calendar + a mandatory timezone on datetimes. Zero dependencies.

// Fast shape filter; the semantics (calendar, ranges, timezone) live in parseIsoDateMs.
const ISO_SHAPE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * The project's canonical ISO-8601:
 *  - date-only "YYYY-MM-DD" — treated as UTC midnight of that day;
 *  - full datetime: a mandatory "T", hours ≤23, minutes/seconds ≤59,
 *    fractions of a second optional, the timezone MANDATORY (Z or ±HH:MM) —
 *    naive time is not accepted: we do not guess the host locale;
 *  - a real calendar: month 01–12, day per month (leap years accounted for) —
 *    "2026-02-30" is not "rolled over" to March but rejected.
 * @param {string} s
 * @returns {number|null} unix-ms (UTC) or null if the string is not canonical ISO
 */
export function parseIsoDateMs(s) {
  if (typeof s !== "string") return null;
  const m = ISO_SHAPE_RE.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);

  if (month < 1 || month > 12) return null;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const dim = month === 2 && leap ? 29 : DAYS_IN_MONTH[month - 1];
  if (day < 1 || day > dim) return null;

  // setUTCFullYear, not Date.UTC(year,...): the latter maps years 0..99 to 1900+year.
  const base = new Date(0);
  base.setUTCFullYear(year, month - 1, day);
  let ms = base.getTime(); // UTC midnight of this date

  const [, , , , hh, mi, ss, frac, tz] = m;
  if (hh !== undefined) {
    const h = Number(hh);
    const minutes = Number(mi);
    const sec = ss === undefined ? 0 : Number(ss);
    if (h > 23 || minutes > 59 || sec > 59) return null; // "24:00" and "23:59:60" are not a time
    const fracMs = frac === undefined ? 0 : Number((frac + "000").slice(1, 4)); // .5 → 500ms
    ms += ((h * 60 + minutes) * 60 + sec) * 1000 + fracMs;
    if (tz !== "Z") {
      // ±HH:MM offset: local time minus offset = UTC
      const sign = tz[0] === "-" ? -1 : 1;
      const offH = Number(tz.slice(1, 3));
      const offM = Number(tz.slice(4, 6));
      if (offH > 23 || offM > 59) return null; // "+99:99" is not an offset
      ms -= sign * (offH * 60 + offM) * 60 * 1000;
    }
  }
  return ms;
}

/** true if the string is the project's canonical ISO-8601 (see parseIsoDateMs). */
export function isValidIsoDate(s) {
  return parseIsoDateMs(s) !== null;
}
