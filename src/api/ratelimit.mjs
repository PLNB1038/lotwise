// Rate limiter for expensive endpoints (wallet scan, on-chain reader, prices).
// Fixed window per key (usually the client IP): without it a bot streaming DISTINCT
// addresses through /lots bypasses the scanner cache (keyed by address) and every
// request turns into a live RPC scan — the Helius/public-RPC quota burns down. A
// STOCKBasis-style queue limit would have protected memory, but not the quota.
// Fail-open by construction: even a bad key/clock must not take requests down —
// this is a protective layer, not a data-integrity layer.
export function createRateLimiter({ windowMs, max, now = Date.now }) {
  if (!Number.isInteger(windowMs) || windowMs <= 0) throw new RangeError("windowMs must be a positive integer");
  if (!Number.isInteger(max) || max <= 0) throw new RangeError("max must be a positive integer");
  const hits = new Map(); // key -> { windowStart, count }
  // a key map without a ceiling grows forever (a key = an IP from the wild internet) —
  // the same lesson as CACHE_MAX_ENTRIES in serve.mjs; sweep once past the cap
  const SWEEP_AFTER_KEYS = 10_000;
  const windowStartOf = (t) => Math.floor(t / windowMs) * windowMs;
  return {
    check(key) {
      const t = now();
      const windowStart = windowStartOf(t);
      let rec = hits.get(key);
      if (!rec || rec.windowStart !== windowStart) {
        if (rec === undefined && hits.size >= SWEEP_AFTER_KEYS) {
          // records from past windows are dead by the fixed-window definition — drop them
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
