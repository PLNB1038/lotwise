// Строгий валидатор/парсер канонического ISO-8601 — единый источник семантики дат проекта.
//
// ЗАЧЕМ (находки раундов 2–3, docs/review): Date.parse — плохой валидатор.
//  - "2026-13-01", "2026-00-10", "2026-06-18T23:59:60Z", "+99:99" проходят проверку ФОРМЫ,
//    а Date.parse даёт NaN — ошибка всплывает позже, уже как 500 на /summary
//    (журнал-реплей и xstocks-история проходят только схемную валидацию);
//  - тихий перекат: Date.parse("2026-02-30") = 02.03, ("2026-06-31") = 01.07,
//    ("2027-02-29") = 01.03, ("2026-06-18T24:00:00Z") = 19.06 — NaN-гварды молчат,
//    множитель считается с чужого дня;
//  - наивный datetime ("2026-06-18T12:00:00") парсится как ЛОКАЛЬНОЕ время хоста —
//    сдвиг всех сравнений на часовую зону.
// Принцип проекта: «мусорная дата — ошибка, не тихое сравнение». Поэтому здесь:
// форма + реальный календарь + обязательная таймзона у datetime. Ноль зависимостей.

// Быстрый фильтр формы; семантика (календарь, диапазоны, таймзона) — в parseIsoDateMs.
const ISO_SHAPE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Канонический ISO-8601 проекта:
 *  - date-only "YYYY-MM-DD" — трактуется как полночь UTC того дня;
 *  - полный datetime: обязательная "T", часы ≤23, минуты/секунды ≤59,
 *    доли секунды опциональны, таймзона ОБЯЗАТЕЛЬНА (Z или ±HH:MM) —
 *    наивное время не принимаем: не угадываем локаль хоста;
 *  - реальный календарь: месяц 01–12, день по месяцу (високосные учтены) —
 *    "2026-02-30" не «перекатывается» на март, а отвергается.
 * @param {string} s
 * @returns {number|null} unix-ms (UTC) или null, если строка не канонический ISO
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

  // setUTCFullYear, а не Date.UTC(year,...): тот маппит годы 0..99 в 1900+year.
  const base = new Date(0);
  base.setUTCFullYear(year, month - 1, day);
  let ms = base.getTime(); // полночь UTC этой даты

  const [, , , , hh, mi, ss, frac, tz] = m;
  if (hh !== undefined) {
    const h = Number(hh);
    const minutes = Number(mi);
    const sec = ss === undefined ? 0 : Number(ss);
    if (h > 23 || minutes > 59 || sec > 59) return null; // "24:00" и "23:59:60" — не время
    const fracMs = frac === undefined ? 0 : Number((frac + "000").slice(1, 4)); // .5 → 500мс
    ms += ((h * 60 + minutes) * 60 + sec) * 1000 + fracMs;
    if (tz !== "Z") {
      // оффсет ±HH:MM: локальное время минус оффсет = UTC
      const sign = tz[0] === "-" ? -1 : 1;
      const offH = Number(tz.slice(1, 3));
      const offM = Number(tz.slice(4, 6));
      if (offH > 23 || offM > 59) return null; // "+99:99" — не оффсет
      ms -= sign * (offH * 60 + offM) * 60 * 1000;
    }
  }
  return ms;
}

/** true, если строка — канонический ISO-8601 проекта (см. parseIsoDateMs). */
export function isValidIsoDate(s) {
  return parseIsoDateMs(s) !== null;
}
