// Normalization of PreStocks metadata into canonical Lotwise events.
// Modeled on normalize-xstocks.mjs, but with an honest caveat: the current PreStocks
// metadata schema (captured from the live endpoint on 2026-09-22) is an identity document:
//   { name, symbol, description, image, external_url, terms }
// It has NO corporate-event fields (split/dividend/dates/ratios).
// Therefore metadataToEvents returns an EMPTY list for the current schema —
// synthesizing events (dates, ratios) from a logo and a description would mean
// inventing data; the project pipeline works only with real observations.
// The layer exists as a plug-in point: when the issuer adds event fields,
// their interpretation will appear here, and the "mint is bound externally" contract
// will not change.
import { validateEvent } from "../schema/events.mjs";

export class NormalizeError extends Error {
  constructor(msg, node) {
    super(msg);
    this.name = "NormalizeError";
    this.node = node;
  }
}

// Keys of the identity schema captured from the live endpoint, in BOTH spellings:
// snake_case — the raw JSON of the endpoint, camelCase (externalUrl) — our client.
// Anything outside this set is a signal that the issuer's schema has evolved.
const KNOWN_KEYS = new Set([
  "name",
  "symbol",
  "description",
  "image",
  "external_url",
  "externalUrl",
  "terms",
]);

/**
 * Issuer's plan (PreStocks metadata) -> canonical events.
 * The current schema carries only identity fields, so the honest result is [].
 * Unknown keys are NOT silently ignored: possible future event fields
 * (modeled on round 6, "silent data loss") are highlighted to the operator in
 * console.error — observability instead of blocking a token over cosmetics.
 * @param {{name, symbol, description?, image?, external_url?, terms?}} metadata — as fetchTokenMetadata returns OR the raw endpoint JSON
 * @param {{sourceUrl?: string}} [ctx] — source URL for the log note
 * @returns {Array<object>} canonical events (currently always empty)
 */
export function metadataToEvents(metadata, { sourceUrl = "https://prestocks.com/metadata" } = {}) {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new NormalizeError("metadata must be an object", metadata);
  }
  if (typeof metadata.symbol !== "string" || metadata.symbol === "") {
    throw new NormalizeError("metadata is missing a symbol", metadata);
  }
  const unknown = Object.keys(metadata).filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length > 0) {
    console.error(
      `[normalize-prestocks] ${JSON.stringify(metadata.symbol)}: unknown keys in metadata ${JSON.stringify(unknown)} — the issuer's schema has changed; event fields may have appeared. Events are NOT extracted from them yet (zero interpretation), a note for the operator.`,
    );
  }
  // No events out of identity fields: a REDEEM derived from an offer link or
  // a TICKER_CHANGE without the old ticker is a falsified date/fact, not a mapping.
  return [];
}

/**
 * Legitimate source links from the identity document: external_url (the token's
 * page) and terms (the issuer's offer). When the issuer gets real event
 * fields, these links will go into the sources of the canonical events.
 * @returns {string[]} non-empty link strings in a stable order
 */
export function metadataSources(metadata) {
  if (metadata === null || typeof metadata !== "object") {
    throw new NormalizeError("metadata must be an object", metadata);
  }
  // externalUrl — the camelCase output of our own client (src/issuer/prestocks.mjs),
  // external_url — the raw identity JSON: both are legitimate inputs (KNOWN_KEYS blesses
  // the client form); losing the token page link from sources is not allowed (ROUND7 fix 6)
  return [metadata.external_url ?? metadata.externalUrl, metadata.terms].filter((s) => typeof s === "string" && s.length >= 4);
}

/** Fills in the events with the mint from the registry and runs schema validation; atomic.
 *  Same contract as normalize-xstocks.bindMintAndValidate — a copy,
 *  not an import: issuer sources are wired up independently of each other. */
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
