// Client for the Tessera issuer source (tessera.pe, T-OpenAI/T-SpaceX/T-Kalshi tokens).
// Modeled after prestocks.mjs: IssuerError, injectable fetcher, getJson,
// "numbers as strings, no float".
//
// HONEST DATA NOTE (taken from the live CDN on 2026-09-22, t-spacex/t-openai/t-kalshi):
// Tessera metadata is an identity document in the spirit of NFT metadata and contains NO
// corporate-event fields (no dates, no multipliers, no rotations):
//   { name, symbol, description, image, external_url,
//     attributes: [{ trait_type, value }, ...] }
// The "Redemption Trigger: Divestment of Underlying Exposure" attribute is a verbal
// description of a condition, with no date and no factor: it is not an event, and synthesizing
// events (dates/multipliers) out of trait strings would be inventing data. Therefore there is
// NO metadataToEvents here — only metadataSources() for legitimate links.
export class IssuerError extends Error {
  constructor(msg, { status } = {}) {
    super(msg);
    this.name = "IssuerError";
    this.status = status;
  }
}

const BASE = "https://cdn.tesseralab.co/tessera";

// Metadata URLs are built from the lowercased symbol: T-SpaceX -> t-spacex.json
// (verified against the live CDN and the T-SpaceX mint uri from the on-chain fixture).
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

// A string or a finite number -> string (no float math), otherwise null.
const asString = (v) => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : null);

// The symbol in the Tessera payload is a camelCase skeleton WITHOUT the hyphen ("tSpaceX"
// for the t-spacex.json file), while the lot registry records the same token as "T-SpaceX".
// Hence the comparison is case-insensitive and based on the alphanumeric skeleton: T-SpaceX
// and tSpaceX both give TSPACEX, while a foreign document (asked for T-SpaceX, got tOpenAI ->
// TOPENAI) is caught as a mismatch.
const symbolKey = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * Tessera token metadata by symbol — the issuer plan in the current schema
 * (an identity document; no event fields in the schema, see the file header).
 * Every field is a string or null (attributes — an array of string/null pairs).
 * @param {string} symbol e.g. "T-SpaceX" (case-insensitive, lowercased in the URL)
 * @param {{fetcher?: Function}} opts
 * @returns {Promise<{name: string, symbol: string, description: string|null, image: string|null, externalUrl: string|null, attributes: Array<{traitType: string, value: string|null}>|null}>}
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
  // The symbol in the payload must match the requested one (by skeleton, see symbolKey):
  // the file is per-symbol; a mismatch = redirect/rename/foreign document.
  if (symbolKey(j.symbol) !== symbolKey(symbol)) {
    throw new IssuerError(`metadata symbol mismatch: asked ${symbol}, got ${j.symbol}`);
  }
  // attributes — static trait pairs of the NFT schema: trait_type as a string, the value
  // as a string or a finite number (numbers -> strings), anything else -> null.
  // Entries without a string trait_type are not invented.
  let attributes = null;
  if (Array.isArray(j.attributes)) {
    attributes = j.attributes
      .filter((a) => a !== null && typeof a === "object" && !Array.isArray(a) && typeof a.trait_type === "string")
      .map((a) => ({ traitType: a.trait_type, value: asString(a.value) }));
  }
  return {
    name: j.name,
    symbol: j.symbol,
    description: asString(j.description),
    image: asString(j.image),
    externalUrl: asString(j.external_url),
    attributes,
  };
}

/**
 * Legitimate source links from the identity document: external_url (the project
 * page) and the "Terms and Conditions" attribute (the issuer's offering terms). Both
 * spellings of the attribute are accepted — the snake_case of the raw JSON and the
 * camelCase of our client.
 * @returns {string[]} non-empty link strings in a stable order
 */
export function metadataSources(metadata) {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new IssuerError("metadata must be an object");
  }
  const attrs = Array.isArray(metadata.attributes) ? metadata.attributes : [];
  const terms = attrs
    .map((a) => (a !== null && typeof a === "object" ? a : {}))
    .filter((a) => a.trait_type === "Terms and Conditions" || a.traitType === "Terms and Conditions")
    .map((a) => a.value)
    .filter((s) => typeof s === "string");
  // externalUrl is the camelCase output of our own fetchTokenMetadata, external_url is the raw
  // metadata JSON: composing the two exports must not lose the project link from the
  // provenance list ; attributes are already accepted in both spellings
  return [metadata.external_url ?? metadata.externalUrl, ...terms]
    .filter((s) => typeof s === "string" && s.length >= 4);
}
