// DIVIDEND_ACCRUAL producer from the ISSUER'S DECLARATIONS — option B ("honest to the data").
//
// WHY DIRECT MAPPING FROM multiplier/history IS IMPOSSIBLE (research of 2026-09-22,
// live responses in test/fixtures/dividends-*.json):
//   1) Multiplier-history nodes with reason "Dividend" (SPYx, KOx, JPMx, network=Solana)
//      carry EXACTLY five fields: id, reason, multiplier, previousMultiplier,
//      activationDateTime. No per-unit amount, no ex/pay/record dates, no NAV.
//   2) There is no separate dividend endpoint: GET /api/v2/public/assets/SPYx/dividends
//      → 404 Cannot GET.
//   3) The asset card /api/v2/public/assets/SPYx carries no dividend fields at all:
//      only id/name/symbol/isin/underlying*/description/logo/isTradingHalted/
//      trading/deployments (not a single key with div/nav/yield/amount).
//   The multiplierTo/previousMultiplier ratio is a rebase of the whole NAV (the price move
//   PLUS the payout), and the price on the ex-date is absent from the node: deriving a
//   $-amount from the multiplier mathematically = SYNTHESIZING data the issuer never
//   declared. Project rule (see dividend-e2e, GAP 1): derive nothing from the multiplier.
//   Therefore there IS and will be NO "multiplier node → DIVIDEND_ACCRUAL" function here.
//
// WHAT IS HERE — the "issuer declaration" contract: a structured input
//   { symbol, exDate, amountPerUnitRaw, decimals, sourceUrl }, where
//     - amountPerUnitRaw — an INTEGER, raw units of the PAYOUT per one raw unit of the token
//       (engine semantics, lots.mjs: totalRaw = amountPerUnitRaw × Σ qtyRaw),
//       e.g. a declaration of "$2.00 per share" with 6 payout decimals → "2000000";
//       converting the declared amount into raw is the SUBMITTER's duty, not the producer's;
//     - decimals — decimal places of the token/payout (0..18, as in the schema);
//     - exDate — canonical ISO-8601 (src/schema/isodate.mjs); in the event schema
//       the only date is effectiveDate (e2e GAP 5: no payout dates in the schema),
//       so exDate goes into effectiveDate as is, without reformatting;
//     - sourceUrl — a link to the issuer's publication, goes into sources as is.
//   The event is returned WITHOUT a mint — binding to the mint from the registry by symbol
//   is done by the calling layer via bindMintAndValidate (normalize-xstocks.mjs),
//   the same contract as multiplierHistoryToEvents.
//
// EXTENSION TRIGGER: if the issuer gets an endpoint DECLARING a monetary
// amount per unit and an ex-date (e.g. /dividends or distribution fields in the asset
// card) — a named normalizer of that response into the declaration form (1:1, no amount
// computed from the multiplier) is added here, and only then does the issuer's data flow
// into the engine directly. Until that moment DIVIDEND_ACCRUAL is entered by a declaration
// confirmed by a link to the issuer.
//
// Numbers: the input is integers (number) OR digit strings — both channels are exact; float
// is rejected. No math beyond a range check: Number.isInteger
// and Number.MAX_SAFE_INTEGER — the ceiling of the schema itself (see validateEvent).
import { isValidIsoDate, parseIsoDateMs } from "../schema/isodate.mjs";

// Malformed-declaration error — fail-closed, like NormalizeError in xstocks:
// one broken declaration line loudly crashes the submission instead of being lost silently.
export class DeclarationError extends Error {
  constructor(msg, decl) {
    super(msg);
    this.name = "DeclarationError";
    this.decl = decl;
  }
}

// Strict integer parse: an integer number (including from JSON) or a digits-ONLY string.
// A string goes through BigInt — "10000000000000000000" does not lose precision in
// an intermediate double. Float, exponent, sign, whitespace, garbage — an error.
function toPositiveSafeInteger(v, field, decl) {
  let bi;
  if (typeof v === "number") {
    if (!Number.isInteger(v)) {
      throw new DeclarationError(`${field} must be an integer, got ${String(v)} (float forbidden)`, decl);
    }
    bi = BigInt(v);
  } else if (typeof v === "string" && /^\d+$/.test(v)) {
    bi = BigInt(v);
  } else {
    throw new DeclarationError(`${field} must be a positive integer or a digit string, got ${JSON.stringify(v)}`, decl);
  }
  if (bi <= 0n) {
    throw new DeclarationError(`${field} must be positive, got ${JSON.stringify(v)}`, decl);
  }
  // Above the schema ceiling the event cannot be carried (validateEvent requires Number.isInteger):
  // Number(bi) would lose precision SILENTLY — hence the boundary is exactly here.
  if (bi > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DeclarationError(`${field} exceeds Number.MAX_SAFE_INTEGER — the schema cannot carry the event`, decl);
  }
  return Number(bi);
}

// An integer 0..18 — the schema range for decimals (the same parsing discipline).
function toDecimals(v, decl) {
  if (typeof v === "number" && Number.isInteger(v)) {
    if (v < 0 || v > 18) {
      throw new DeclarationError(`decimals must be an integer 0..18, got ${JSON.stringify(v)}`, decl);
    }
    return v;
  }
  if (typeof v === "string" && /^\d+$/.test(v)) {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n > 18) {
      throw new DeclarationError(`decimals must be an integer 0..18, got ${JSON.stringify(v)}`, decl);
    }
    return n;
  }
  throw new DeclarationError(`decimals must be an integer 0..18 or a digit string, got ${JSON.stringify(v)}`, decl);
}

/**
 * Issuer declarations → canonical DIVIDEND_ACCRUAL (no mint).
 *
 * @param {Array<{symbol: string, exDate: string, amountPerUnitRaw: number|string,
 *                decimals: number|string, sourceUrl: string}>} declarations
 *   Issuer declarations. Foreign symbols (not matching ctx.symbol case-insensitively)
 *   are SKIPPED — one submission may carry a feed for many tokens;
 *   a declaration with a missing/non-string symbol is a defective submission → DeclarationError.
 * @param {{symbol: string}} ctx
 *   The symbol of the token we build events for (e.g. "KOx"); required.
 * @returns {Array<object>} DIVIDEND_ACCRUAL without mint, old → new.
 *   Exact duplicate declarations (same symbol/exDate/amount/decimals/sourceUrl)
 *   collapse — re-submitting the feed must not double the engine's accrual.
 *   SIMILAR but unequal declarations (a different sourceUrl) do NOT collapse: without an id
 *   in the declaration, "a repeat" and "two distinct announcements on one day" cannot be
 *   told apart — a deliberate trade-off, mirroring the "full:" dedup of normalize-xstocks.
 */
export function dividendsFromDeclarations(declarations, { symbol } = {}) {
  if (typeof symbol !== "string" || symbol === "") {
    throw new DeclarationError("ctx.symbol is required (token symbol, e.g. \"KOx\")");
  }
  if (!Array.isArray(declarations)) {
    throw new DeclarationError("declarations must be an array");
  }

  const wanted = symbol.toUpperCase();
  const events = [];
  const seen = new Map(); // exact-duplicate key → event (the first occurrence wins)

  for (const decl of declarations) {
    if (decl === null || typeof decl !== "object") {
      throw new DeclarationError("declaration must be an object", decl);
    }
    if (typeof decl.symbol !== "string" || decl.symbol === "") {
      throw new DeclarationError("declaration.symbol is required (string)", decl);
    }
    if (decl.symbol.toUpperCase() !== wanted) continue; // a foreign token in a shared feed

    // Date: the project's canonical ISO-8601 (shape + a real calendar + a timezone
    // on datetimes). A garbage date is an error here, not a NaN somewhere in the engine.
    if (typeof decl.exDate !== "string" || !isValidIsoDate(decl.exDate)) {
      throw new DeclarationError(
        `exDate must be canonical ISO-8601: YYYY-MM-DD or YYYY-MM-DDTHH:mm[:ss[.fff]](Z|±HH:MM), got ${JSON.stringify(decl.exDate)}`,
        decl,
      );
    }
    // Source: a minimal check — the same bar as in the schema (a non-empty string).
    if (typeof decl.sourceUrl !== "string" || decl.sourceUrl.length < 4) {
      throw new DeclarationError(`sourceUrl must be a non-empty string (URL or reference), got ${JSON.stringify(decl.sourceUrl)}`, decl);
    }
    const amountPerUnitRaw = toPositiveSafeInteger(decl.amountPerUnitRaw, "amountPerUnitRaw", decl);
    const decimals = toDecimals(decl.decimals, decl);

    // A declaration is the issuer's statement with an accompanying link: status "confirmed",
    // like the issuer's official API in normalize-xstocks. Non-issuer sources
    // must not be fed into this contract.
    const e = {
      type: "DIVIDEND_ACCRUAL",
      effectiveDate: decl.exDate,
      status: "confirmed",
      sources: [decl.sourceUrl],
      amountPerUnitRaw,
      decimals,
    };
    // The dedup key is the MOMENT of the date, not the string (ROUND7 fix 12): "2026-06-18"
    // and "2026-06-18T00:00:00Z" are the same ex-day; a string key produced two
    // DIVIDEND_ACCRUAL and a double accrual by the engine. parseIsoDateMs cannot return null:
    // exDate has already passed isValidIsoDate above.
    const key = JSON.stringify([decl.symbol.toUpperCase(), parseIsoDateMs(decl.exDate), amountPerUnitRaw, decimals, decl.sourceUrl]);
    if (seen.has(key)) continue;
    seen.set(key, e);
    events.push(e);
  }

  // Sort by moment in time (as a number, not a string) — a deterministic order
  // old → new, as in multiplierHistoryToEvents; the dates are already canonical,
  // parseIsoDateMs cannot return null here.
  return events
    .map((e) => ({ e, ts: parseIsoDateMs(e.effectiveDate) }))
    .sort((a, b) => a.ts - b.ts)
    .map(({ e }) => e);
}
