// Client for the PreStocks issuer source (prestocks.com, pre-IPO tokens).
// Modeled after xstocks.mjs: IssuerError, injectable fetcher, getJson,
// "numbers as strings, no float".
//
// HONEST DATA NOTE (taken from the live endpoint on 2026-09-22):
// PreStocks metadata is an identity document in the spirit of NFT metadata and contains NO
// corporate-event fields (no splits, no dividends, no dates, no numbers):
//   { name, symbol, description, image, external_url, terms }
// Mapping to canonical events is a separate layer (normalize-prestocks.mjs);
// the mint is bound externally from the registry.
export class IssuerError extends Error {
  constructor(msg, { status } = {}) {
    super(msg);
    this.name = "IssuerError";
    this.status = status;
  }
}

const BASE = "https://prestocks.com/metadata";

// Metadata URLs are built from the lowercased symbol: OPENAI -> openai.json
// (verified against the live endpoint: /metadata/openai.json -> symbol "OPENAI").
// The path admits only "safe" token symbols — no ../ or other junk.
const SYMBOL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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

/**
 * PreStocks token metadata by symbol — the issuer plan in the current schema
 * (an identity document; no event fields in the schema, see the file header).
 * Every response field is a string or null: the metadata schema has no numbers, and any
 * future numeric fields go through the event normalizer as strings.
 * @param {string} symbol e.g. "OPENAI" (case-insensitive, lowercased in the URL)
 * @param {{fetcher?: Function}} opts
 * @returns {Promise<{name: string, symbol: string, description: string|null, image: string|null, externalUrl: string|null, terms: string|null}>}
 */
export async function fetchTokenMetadata(symbol, { fetcher = fetch } = {}) {
  if (typeof symbol !== "string" || !SYMBOL_RE.test(symbol)) {
    throw new IssuerError(`bad symbol: ${JSON.stringify(symbol)}`);
  }
  const url = `${BASE}/${encodeURIComponent(symbol.toLowerCase())}.json`;
  const j = await getJson(url, fetcher);
  if (typeof j?.name !== "string" || j.name === "" || typeof j?.symbol !== "string" || j.symbol === "") {
    throw new IssuerError(`unexpected metadata payload for ${symbol}`);
  }
  // The symbol in the payload must match the requested one (case-insensitive):
  // the file is per-symbol; a mismatch = redirect/rename/foreign document.
  if (j.symbol.toUpperCase() !== symbol.toUpperCase()) {
    throw new IssuerError(`metadata symbol mismatch: asked ${symbol}, got ${j.symbol}`);
  }
  return {
    name: j.name,
    symbol: j.symbol,
    description: typeof j.description === "string" ? j.description : null,
    image: typeof j.image === "string" ? j.image : null,
    externalUrl: typeof j.external_url === "string" ? j.external_url : null,
    terms: typeof j.terms === "string" ? j.terms : null,
  };
}
