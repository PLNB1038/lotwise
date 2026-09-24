// Client for the xStocks issuer source (Backed): corporate-event multipliers.
// The data is raw observations; mapping to canonical events is a separate layer
// (the multiplier-vs-integer-lots modeling question is deferred to that separate layer).
// Multiplier numbers are stored AS STRINGS: there is no float in our pipeline.
export class IssuerError extends Error {
  constructor(msg, { status } = {}) {
    super(msg);
    this.name = "IssuerError";
    this.status = status;
  }
}

const BASE = "https://api.xstocks.fi/api/v2/public/assets";

async function getJson(url, fetcher = fetch) {
  let res;
  try {
    res = await fetcher(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; Lotwise/0.1)" } });
  } catch (err) {
    throw new IssuerError(`network: ${err.message}`);
  }
  if (!res.ok) throw new IssuerError(`HTTP ${res.status} for ${url}`, { status: res.status });
  try {
    return await res.json();
  } catch (err) {
    throw new IssuerError(`bad JSON from ${url}: ${err.message}`);
  }
}

// Number from the API -> decimal string, no float math in the pipeline.
const asDecimalString = (v) =>
  typeof v === "number" && Number.isFinite(v) ? String(v) : null;

/**
 * The current (and pending activation) multiplier of a symbol.
 * @returns {{currentMultiplier: string, pendingMultiplier: string|null, activationDateTime: string|null, reason: string|null}}
 */
export async function fetchCurrentMultiplier(symbol, network = "Solana", { fetcher = fetch } = {}) {
  const j = await getJson(`${BASE}/${encodeURIComponent(symbol)}/multiplier?network=${encodeURIComponent(network)}`, fetcher);
  if (j?.currentMultiplier === undefined) throw new IssuerError(`unexpected multiplier payload for ${symbol}`);
  const pending = asDecimalString(j.newMultiplier);
  return {
    currentMultiplier: asDecimalString(j.currentMultiplier),
    pendingMultiplier: pending !== null && Number(pending) !== 0 ? pending : null,
    activationDateTime: j.activationDateTime && Number(j.activationDateTime) !== 0 ? j.activationDateTime : null,
    reason: j.reason ?? null,
  };
}

/**
 * Multiplier change history (real corporate events).
 * @returns {{hasNextPage: boolean, nodes: Array<{id: string, reason: string, multiplier: string, previousMultiplier: string, activationDateTime: string}>}}
 */
export async function fetchMultiplierHistory(symbol, network = "Ethereum", { page = 0, pageSize = 25, fetcher = fetch } = {}) {
  const j = await getJson(
    `${BASE}/${encodeURIComponent(symbol)}/multiplier/history?page=${page}&pageSize=${pageSize}&network=${encodeURIComponent(network)}`,
    fetcher,
  );
  if (!Array.isArray(j?.nodes)) throw new IssuerError(`unexpected history payload for ${symbol}`);
  return {
    hasNextPage: Boolean(j.page?.hasNextPage),
    nodes: j.nodes.map((n) => ({
      id: n.id,
      reason: n.reason,
      multiplier: asDecimalString(n.multiplier),
      previousMultiplier: asDecimalString(n.previousMultiplier),
      activationDateTime: n.activationDateTime,
    })),
  };
}
