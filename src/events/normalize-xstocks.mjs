// Normalization of xStocks multiplier API observations into canonical Lotwise events.
// The issuer's API plan is the primary source; on-chain ScaledUI confirmation is
// a separate week-2 step (cross-checking the plans via reconcile).
import { validateEvent } from "../schema/events.mjs";
import { parseIsoDateMs } from "../schema/isodate.mjs";

export class NormalizeError extends Error {
  constructor(msg, node) {
    super(msg);
    this.name = "NormalizeError";
    this.node = node;
  }
}

// Data boundary: nodes may arrive as numbers (the raw API JSON) or as strings
// (our client). A number → string exactly (a JSON number parses into a double,
// shortest-round-trip preserves all significant digits); garbage — an error.
function toDecimalString(v, field, node) {
  if (typeof v === "number" && Number.isFinite(v)) {
    const s = String(v);
    if (!/e/i.test(s)) return s;
    // Exponential notation fails DECIMAL_RE and used to crash the WHOLE token history
    // with a NormalizeError "not a decimal" . The significant digits are
    // the same — we shift the point: 1e-7 → "0.0000001", 5e21 → "5000000000000000000000".
    const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/i.exec(s);
    if (!m) throw new NormalizeError(`field ${field} is not a decimal: ${JSON.stringify(v)}`, node);
    const [, sign, int, frac = "", exp] = m;
    const digits = int + frac;
    const point = int.length + Number(exp);
    const positional =
      point <= 0 ? `0.${"0".repeat(-point)}${digits}`
      : point >= digits.length ? `${digits}${"0".repeat(point - digits.length)}`
      : `${digits.slice(0, point)}.${digits.slice(point)}`;
    return sign ? `-${positional}` : positional; // a negative value will be rejected by the schema, with its own message
  }
  if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v)) return v;
  throw new NormalizeError(`field ${field} is not a decimal: ${JSON.stringify(v)}`, node);
}

// Unique key of a history node. id is the node identity in the issuer's API (uuid):
// the same node arriving on two pages (page-drift of offset pagination) must collapse
// into a single event. Nodes without an id are deduped only on a full content match:
// different events on one day are a reality (a split and a dividend sharing a date),
// collapsing them by date is not allowed.
function nodeKey(n) {
  if (n !== null && typeof n === "object" && typeof n.id === "string" && n.id !== "") {
    return `id:${n.id}`;
  }
  return `full:${JSON.stringify([n?.id ?? null, n?.activationDateTime ?? null, n?.previousMultiplier, n?.multiplier, n?.reason ?? null])}`;
}

/**
 * @param {Array<{id, reason, multiplier, previousMultiplier, activationDateTime: string}>} historyNodes
 *   — as fetchMultiplierHistory returns (strings) OR the raw API JSON (numbers); newest first.
 *   Duplicate nodes (page-drift: a node on the boundary of two pages) collapse by
 *   the unique key BEFORE the chain check — otherwise a repeated event breaks
 *   MultiplierTimeline ("chain discontinuity") and the token is excluded from the vitrine entirely
 * @param {{symbol: string, network: string}} ctx
 * @returns {Array<object>} canonical MULTIPLIER_CHANGE, sorted by time (old → new)
 */
export function multiplierHistoryToEvents(historyNodes, { symbol, network = "Ethereum" }) {
  // Shape guard : a non-array is a NormalizeError, not a bare TypeError further
  // down the stream; mirrors dividendsFromDeclarations (the client already guards, the
  // input side can be anything).
  if (!Array.isArray(historyNodes)) {
    throw new NormalizeError(`history nodes must be an array, got ${historyNodes === null ? "null" : typeof historyNodes}`);
  }
  const sourceUrl = `https://api.xstocks.fi/api/v2/public/assets/${symbol}/multiplier/history?network=${network}`;
  // Dedup before date parsing and sorting: a repeated node = a repeated event with the same
  // multiplierFrom, the one the timeline falls over. The first occurrence wins.
  const seen = new Map(); // key → the first node with this key (also the dedup winner)
  const deduped = historyNodes.filter((n) => {
    const key = nodeKey(n);
    const first = seen.get(key);
    if (first !== undefined) {
      //, LW2_dedup_id_collision_silent_divergence: the same id with DIFFERENT
      // content (the issuer fixed a node on a fresh page / reused an id).
      // The "first occurrence wins" semantics stays (id is the node identity, a deliberate
      // trade-off), but the divergence used to be lost SILENTLY — neither the operator
      // nor /health ever learned about it. One single-line warn — observability.
      if (JSON.stringify(first) !== JSON.stringify(n)) {
        console.error(`[normalize-xstocks] ${symbol}: dedup: node ${key} collapsed with an earlier-seen one but the content differs — the first occurrence wins, the fresh variant is ignored: ${JSON.stringify(n)}`);
      }
      return false;
    }
    seen.set(key, n);
    return true;
  });
  // Sort by MOMENT IN TIME (as a number), not localeCompare over the date string:
  // with mixed precision ("…T00:00:00.500Z" vs "…T00:00:00Z") the string sort
  // produced the reverse of chronology. An unparseable date is a NormalizeError:
  // fail-closed, like the whole date pipeline (a finding).
  const stamped = deduped.map((n) => {
    const ts = parseIsoDateMs(String(n?.activationDateTime));
    if (ts === null) {
      throw new NormalizeError(
        `activationDateTime is not a canonical ISO date: ${JSON.stringify(n?.activationDateTime)}`,
        n,
      );
    }
    return { n, ts };
  });
  stamped.sort((a, b) => a.ts - b.ts); // the V8 sort is stable: equal moments keep the API order
  return stamped.map(({ n }) => {
    const e = {
      type: "MULTIPLIER_CHANGE",
      // the calling layer fills in the mint from the registry by symbol — here the symbol is in the sourceUrl
      effectiveDate: n.activationDateTime,
      status: "confirmed", // the issuer's official API
      sources: [`${sourceUrl}#node:${n.id}`],
      multiplierFrom: toDecimalString(n.previousMultiplier, "previousMultiplier", n),
      multiplierTo: toDecimalString(n.multiplier, "multiplier", n),
      reason: n.reason,
    };
    return e;
  });
}

/** Fills in the events with the mint from the registry and runs schema validation; atomic. */
export function bindMintAndValidate(events, mint) {
  const bound = events.map((e) => ({ ...e, mint }));
  for (const e of bound) {
    try {
      validateEvent(e);
    } catch (err) {
      throw new NormalizeError(`normalized event failed schema: ${err.message}`, e);
    }
  }
  return bound;
}
