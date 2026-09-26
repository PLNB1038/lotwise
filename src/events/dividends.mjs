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

// The `supersedes` reference: the same parsing discipline as the declaration itself —
// a canonical ISO ex-day (canonicalized to its day) and a positive safe-integer amount.
function toSupersedesTarget(v, decl) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new DeclarationError(`supersedes must be an object {exDate, amountPerUnitRaw}, got ${JSON.stringify(v)}`, decl);
  }
  if (typeof v.exDate !== "string" || !isValidIsoDate(v.exDate)) {
    throw new DeclarationError(
      `supersedes.exDate must be canonical ISO-8601: YYYY-MM-DD or YYYY-MM-DDTHH:mm[:ss[.fff]](Z|±HH:MM), got ${JSON.stringify(v.exDate)}`,
      decl,
    );
  }
  const amount = toPositiveSafeInteger(v.amountPerUnitRaw, "supersedes.amountPerUnitRaw", decl);
  return { day: v.exDate.slice(0, 10), amount };
}

/**
 * Issuer declarations → canonical DIVIDEND_ACCRUAL (no mint).
 *
 * @param {Array<{symbol: string, exDate: string, amountPerUnitRaw: number|string,
 *                decimals: number|string, sourceUrl: string,
 *                supersedes?: {exDate: string, amountPerUnitRaw: number|string}}>} declarations
 *   Issuer declarations. Foreign symbols (not matching ctx.symbol case-insensitively)
 *   are SKIPPED — one submission may carry a feed for many tokens;
 *   a declaration with a missing/non-string symbol is a defective submission → DeclarationError.
 *   `supersedes` — the CORRECTION channel (the file is append-only, the issuer amends
 *   itself): names the declaration this line REPLACES by the dividend's identity —
 *   {exDate, amountPerUnitRaw} resolved within the SAME symbol against the canonical
 *   ex-day and the parsed amount (the identity the engine already keys dividends on).
 *   Replacement, not addition: the target's event is removed and the correction accrues
 *   alone. Validated all-or-nothing (DeclarationError refuses the whole feed):
 *   the target must exist, must be a plain line (a chain/self-reference is forbidden —
 *   the scheme is one level deep) and must not be superseded twice. A VERBATIM repeat of
 *   a correction line collapses in the exact-duplicate dedup first — re-submitting the
 *   feed is not a double supersede.
 * @param {{symbol: string}} ctx
 *   The symbol of the token we build events for (e.g. "KOx"); required.
 * @returns {Array<object>} DIVIDEND_ACCRUAL without mint, old → new.
 *   Exact duplicate declarations (same symbol/exDate/amount/decimals/sourceUrl)
 *   collapse — re-submitting the feed must not double the engine's accrual.
 *   SIMILAR but unequal declarations (a different sourceUrl) do NOT collapse: without an id
 *   in the declaration, "a repeat" and "two distinct announcements on one day" cannot be
 *   told apart — a deliberate trade-off, mirroring the "full:" dedup of normalize-xstocks.
 *   An explicit `supersedes` line is the exception: it does not stack on its target,
 *   it REPLACES it (see buildDeclarationEvents).
 */
export function dividendsFromDeclarations(declarations, ctx) {
  return buildDeclarationEvents(declarations, ctx).events;
}

/**
 * Same as dividendsFromDeclarations, and also reports how many replacements were
 * applied: {@link dividendsFromDeclarations} keeps its array contract (the producer's
 * callers and tests pin it), the loader needs the count for /health.declarations.superseded.
 * @returns {{events: Array<object>, superseded: number}}
 */
export function buildDeclarationEvents(declarations, { symbol } = {}) {
  if (typeof symbol !== "string" || symbol === "") {
    throw new DeclarationError("ctx.symbol is required (token symbol, e.g. \"KOx\")");
  }
  if (!Array.isArray(declarations)) {
    throw new DeclarationError("declarations must be an array");
  }

  const wanted = symbol.toUpperCase();
  const events = [];
  const seen = new Map(); // exact-duplicate key → event (the first occurrence wins)

  // `supersedes` needs the WHOLE-file view per symbol (a correction may precede its
  // target in the file — the feed is append-only and line order must not matter):
  // collect the identity (canonical ex-day | parsed amount) of every same-symbol line
  // up front, split into plain declarations and corrections. A correction may never
  // serve as a target (the scheme is one level deep). A line that would fail this parse
  // poisons nothing here — the main pass below refuses the whole file on it anyway.
  const plainIdentities = new Set();
  const correctionIdentities = new Set();
  for (const decl of declarations) {
    if (decl === null || typeof decl !== "object") continue;
    if (typeof decl.symbol !== "string" || decl.symbol.toUpperCase() !== wanted) continue;
    if (typeof decl.exDate !== "string") continue;
    let amount;
    try {
      amount = toPositiveSafeInteger(decl.amountPerUnitRaw, "amountPerUnitRaw", decl);
    } catch {
      continue; // the main pass refuses the file on this line — the sets are irrelevant then
    }
    (decl.supersedes !== undefined ? correctionIdentities : plainIdentities).add(`${decl.exDate.slice(0, 10)}|${amount}`);
  }
  // targetIdentity → how many DISTINCT (dedup-surviving) corrections name it; more than
  // one is an ambiguous file, resolved below
  const supersedeTargets = new Map();

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
    // the declaration is canonicalized to its DATE-ONLY day — a
    // datetime with an offset names the same ex-day with a different instant, and every
    // downstream consumer (the dedup, the ex-date base) keys on the day
    const exDay = decl.exDate.slice(0, 10);

    // a sourceUrl is a REFERENCE, not a payload — a 100 KB "url" rode
    // into the store, /events bodies and every webhook POST unbounded
    if (decl.sourceUrl.length > 2048) {
      throw new DeclarationError(`sourceUrl must be at most 2048 chars, got ${decl.sourceUrl.length}`, decl);
    }

    // A declaration is the issuer's statement with an accompanying link: status "confirmed",
    // like the issuer's official API in normalize-xstocks. Non-issuer sources
    // must not be fed into this contract.
    // The CORRECTION channel: `supersedes` names the declaration this line REPLACES —
    // resolved within THIS symbol against the canonical ex-day and the parsed amount,
    // the identity the /accruals dedup already keys dividends on (no new id scheme,
    // legacy lines stay addressable). Shape and self/chain violations refuse the feed
    // right here; a dangling target or a double supersede is refused after the pass,
    // when the whole file has been seen.
    const supersedesTarget = decl.supersedes !== undefined ? toSupersedesTarget(decl.supersedes, decl) : null;
    if (supersedesTarget !== null) {
      const targetId = `${supersedesTarget.day}|${supersedesTarget.amount}`;
      if (targetId === `${exDay}|${amountPerUnitRaw}`) {
        throw new DeclarationError(`supersedes: a declaration cannot supersede itself (ex-day ${supersedesTarget.day}, amountPerUnitRaw ${supersedesTarget.amount})`, decl);
      }
      if (correctionIdentities.has(targetId)) {
        throw new DeclarationError(`supersedes: the target (ex-day ${supersedesTarget.day}, amountPerUnitRaw ${supersedesTarget.amount}) is itself a correction (carries supersedes) — chains are forbidden, supersede the original declaration`, decl);
      }
    }
    const e = {
      type: "DIVIDEND_ACCRUAL",
      effectiveDate: exDay,
      status: "confirmed",
      sources: [decl.sourceUrl],
      amountPerUnitRaw,
      decimals,
    };
    // The dedup key is the MOMENT of the date, not the string : "2026-06-18"
    // and "2026-06-18T00:00:00Z" are the same ex-day; a string key produced two
    // DIVIDEND_ACCRUAL and a double accrual by the engine. parseIsoDateMs cannot return null:
    // exDate has already passed isValidIsoDate above. The supersedes reference is part of
    // the line's identity: two lines differing ONLY in the correction they declare are
    // not the same declaration (an ambiguity → refused below, not collapsed away).
    const key = JSON.stringify([decl.symbol.toUpperCase(), parseIsoDateMs(decl.exDate), amountPerUnitRaw, decimals, decl.sourceUrl, supersedesTarget]);
    if (seen.has(key)) continue;
    seen.set(key, e);
    events.push(e);
    // a correction registers ONLY when its line survives the exact-duplicate dedup:
    // a verbatim re-submitted correction is one correction, not a double supersede
    if (supersedesTarget !== null) {
      const targetId = `${supersedesTarget.day}|${supersedesTarget.amount}`;
      supersedeTargets.set(targetId, (supersedeTargets.get(targetId) ?? 0) + 1);
    }
  }

  // Every surviving correction must name exactly one existing plain target. A dangling
  // reference or a doubly-superseded target refuses the WHOLE feed (all-or-nothing, like
  // a malformed line): a half-applied correction leaves the stale amount accruing while
  // the operator believes it replaced — the exact silent doubling the field exists to
  // prevent. ALL broken references are named in the single refusal: one error per boot
  // used to mean an edit-restart cycle per reference (each restart re-pulls the feed).
  // Serve-side this lands in /health declarations.ok = 0 with the reason logged.
  const supersedeProblems = [];
  for (const [targetId, corrections] of supersedeTargets) {
    const [day, amount] = targetId.split("|");
    if (corrections > 1) {
      supersedeProblems.push(`supersedes: the target (ex-day ${day}, amountPerUnitRaw ${amount}) is already superseded by another declaration — one correction per target, resolve the file`);
    } else if (!plainIdentities.has(targetId)) {
      supersedeProblems.push(`supersedes: no declaration to replace (ex-day ${day}, amountPerUnitRaw ${amount} is not declared) — a correction must name an existing declaration of the same symbol`);
    }
  }
  if (supersedeProblems.length > 0) {
    // a file with hundreds of broken references must not build a hundred-kilobyte
    // reason: the first ten teach the fix, the rest are counted
    const listed = supersedeProblems.slice(0, 10);
    if (supersedeProblems.length > 10) listed.push(`…and ${supersedeProblems.length - 10} more broken references`);
    throw new DeclarationError(listed.join("; "));
  }
  // REPLACEMENT, not addition: the superseded events are dropped — the correction
  // accrues ALONE (the /accruals day-key dedup is untouched: it sees a resolved feed).
  if (supersedeTargets.size > 0) {
    for (let i = events.length - 1; i >= 0; i--) {
      const id = `${String(events[i].effectiveDate).slice(0, 10)}|${events[i].amountPerUnitRaw}`;
      if (supersedeTargets.has(id)) events.splice(i, 1);
    }
  }

  // Sort by moment in time (as a number, not a string) — a deterministic order
  // old → new, as in multiplierHistoryToEvents; the dates are already canonical,
  // parseIsoDateMs cannot return null here.
  const sorted = events
    .map((e) => ({ e, ts: parseIsoDateMs(e.effectiveDate) }))
    .sort((a, b) => a.ts - b.ts)
    .map(({ e }) => e);
  return { events: sorted, superseded: supersedeTargets.size };
}
