// Rate limiter для дорогих эндпоинтов (скан кошелька, on-chain ридер, цены).
// Фиксированное окно на ключ (обычно IP клиента): без него бот с потоком РАЗНЫХ
// адресов в /lots обходит кэш сканера (кэш ключуется адресом) и каждый запрос
// превращается в живой скан по RPC — квота Helius/публичного RPC сгорает,
// лимит очереди STOCKBasis-стиля память бы защитил, но не квоту.
// Fail-open по конструкции: даже кривой ключ/часы не должны ронять запросы —
// это защитный слой, а не слой целостности данных.
export function createRateLimiter({ windowMs, max, now = Date.now }) {
  if (!Number.isInteger(windowMs) || windowMs <= 0) throw new RangeError("windowMs must be a positive integer");
  if (!Number.isInteger(max) || max <= 0) throw new RangeError("max must be a positive integer");
  const hits = new Map(); // key -> { windowStart, count }
  // карта ключей без потолка растёт вечно (ключ = IP из дикого интернета) —
  // тот же урок, что CACHE_MAX_ENTRIES в serve.mjs; подметаем при превышении
  const SWEEP_AFTER_KEYS = 10_000;
  const windowStartOf = (t) => Math.floor(t / windowMs) * windowMs;
  return {
    check(key) {
      const t = now();
      const windowStart = windowStartOf(t);
      let rec = hits.get(key);
      if (!rec || rec.windowStart !== windowStart) {
        if (rec === undefined && hits.size >= SWEEP_AFTER_KEYS) {
          // записи прошлых окон мертвы по определению фиксированного окна — удаляем
          for (const [k, r] of hits) if (r.windowStart !== windowStart) hits.delete(k);
        }
        rec = { windowStart, count: 0 };
        hits.set(key, rec);
      }
      if (rec.count >= max) {
        return { allowed: false, retryAfterMs: Math.max(1, windowStart + windowMs - t) };
      }
      rec.count += 1;
      return { allowed: true, retryAfterMs: 0 };
    },
  };
}
