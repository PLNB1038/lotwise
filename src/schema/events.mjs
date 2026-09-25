// Canonical schema of Lotwise corporate events.
// A single format for the whole pipeline: issuer sources and on-chain deltas
// are normalized into these objects; the lots engine eats only these.
//
// CONTRACT (deliberate, confirmed by the fuzzer — do not "fix" one side of the pair):
// MERGER without exchange fields is VALID per the schema — an informational event
// (reissuance/mint change, no exchange declared); meanwhile applyEvents (lots.mjs)
// throws a LotError "refusing to guess" on a MERGER without exchange fields.
// That is, the schema validator and the lots engine diverge ON PURPOSE: history may
// contain such events, but we refuse to apply them to lots without a ratio.
import { isValidIsoDate } from "./isodate.mjs";

export const EVENT_TYPES = [
  "SPLIT",
  "DIVIDEND_ACCRUAL",
  "MERGER",
  "TICKER_CHANGE",
  "REDEEM",
  "MULTIPLIER_CHANGE",
];

const DECIMAL_RE = /^\d+(\.\d+)?$/;

// Canonical form of a multiplier decimal string: "05"→"5", "5.0"→"5", "1.10"→"1.1".
// A single spot for the journal, the scaled-ui parser and reconcile :
// the representation depends on the source, while every comparison below is a string one. Call
// AFTER the regex guard: the shape is already guaranteed. Significant digits are not touched.
export function canonicalDecimalString(s) {
  const [int = "0", frac = ""] = s.split(".");
  const canonInt = int.replace(/^0+(?=\d)/, "");
  const canonFrac = frac.replace(/0+$/, "");
  return canonFrac ? `${canonInt}.${canonFrac}` : canonInt;
}

// Trust status of an event: whether the source chain corroborates itself or not.
export const EVENT_STATUSES = ["confirmed", "unverified"];

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// A zero multiplier does not exist: MULTIPLIER_CHANGE "1"→"0" would silently zero out
// the adjusted position, and crosscheck would get expectedRatio=Infinity.
// "0.5" is valid — we check numeric equality to zero in ANY representation ("0", "00",
// "0.00", "00.0": leading zeros are allowed by DECIMAL_RE itself —).
const ZERO_MULTIPLIER_RE = /^0+(\.0+)?$/;

// Cap on multiplier fraction precision — a PAIR with timeline.mjs (decimalToRatio rejects >30).
// The contract must match on both sides; change only together.
const MAX_MULTIPLIER_FRACTION_DIGITS = 30;

export class EventValidationError extends Error {
  constructor(msg, field) {
    super(field ? `${msg} (${field})` : msg);
    this.name = "EventValidationError";
    this.field = field;
  }
}

function requireFields(e, fields) {
  for (const f of fields) {
    if (e?.[f] === undefined || e?.[f] === null || e?.[f] === "") {
      throw new EventValidationError(`missing required field`, f);
    }
  }
}

// Validation of a single event. Throws EventValidationError carrying the field name.
export function validateEvent(e) {
  if (!e || typeof e !== "object") throw new EventValidationError("event must be an object");
  requireFields(e, ["type", "mint", "effectiveDate", "status", "sources"]);

  if (!EVENT_TYPES.includes(e.type)) {
    throw new EventValidationError(`unknown type "${e.type}", expected one of ${EVENT_TYPES.join("|")}`, "type");
  }
  if (!MINT_RE.test(e.mint)) throw new EventValidationError("mint must be a base58 Solana pubkey", "mint");
  // A date is not only shape but semantics: a real calendar and a mandatory
  // timezone on datetimes (src/schema/isodate.mjs, earlier findings).
  // Journal replay and xstocks history pass ONLY this check — a garbage issuer
  // date would otherwise reach Date.parse as NaN and fall with a 500 on /summary.
  if (!isValidIsoDate(e.effectiveDate)) {
    throw new EventValidationError(
      "effectiveDate must be canonical ISO-8601: YYYY-MM-DD or YYYY-MM-DDTHH:mm[:ss[.fff]](Z|±HH:MM)",
      "effectiveDate",
    );
  }
  if (!EVENT_STATUSES.includes(e.status)) {
    throw new EventValidationError(`status must be one of ${EVENT_STATUSES.join("|")}`, "status");
  }
  // a source is a REFERENCE, not a payload: cap it here so every entry path agrees
  if (Array.isArray(e.sources)) {
    for (const src of e.sources) {
      if (typeof src === "string" && src.length > 2048) {
        throw new EventValidationError(`source must be at most 2048 chars, got ${src.length}`, "sources");
      }
    }
  }
  if (!Array.isArray(e.sources) || e.sources.length === 0) {
    throw new EventValidationError("at least one source URL/reference is required", "sources");
  }
  for (const s of e.sources) {
    if (typeof s !== "string" || s.length < 4) {
      throw new EventValidationError("each source must be a non-empty string (URL or reference)", "sources");
    }
  }

  switch (e.type) {
    case "SPLIT":
      requireFields(e, ["ratioNumerator", "ratioDenominator"]);
      if (!Number.isInteger(e.ratioNumerator) || e.ratioNumerator <= 0 ||
          !Number.isInteger(e.ratioDenominator) || e.ratioDenominator <= 0) {
        throw new EventValidationError("split ratio must be two positive integers (e.g. 3/1)", "ratioNumerator");
      }
      // The safe-integer ceiling — the same argument as for amountPerUnitRaw :
      // above 2^53 the JSON boundary rounds silently, while the engine counts exactly
      if (e.ratioNumerator > Number.MAX_SAFE_INTEGER || e.ratioDenominator > Number.MAX_SAFE_INTEGER) {
        throw new EventValidationError("split ratio exceeds Number.MAX_SAFE_INTEGER — exact JSON transport impossible", "ratioNumerator");
      }
      break;
    case "DIVIDEND_ACCRUAL":
      requireFields(e, ["amountPerUnitRaw", "decimals"]);
      if (!Number.isInteger(e.amountPerUnitRaw) || e.amountPerUnitRaw <= 0) {
        throw new EventValidationError("amountPerUnitRaw must be a positive integer in raw units", "amountPerUnitRaw");
      }
      // The safe-integer ceiling : above 2^53 the JSON boundary rounds silently —
      // dividends.mjs refers to this ceiling as "the ceiling of the schema itself"
      if (e.amountPerUnitRaw > Number.MAX_SAFE_INTEGER) {
        throw new EventValidationError("amountPerUnitRaw exceeds Number.MAX_SAFE_INTEGER — exact JSON transport impossible", "amountPerUnitRaw");
      }
      if (!Number.isInteger(e.decimals) || e.decimals < 0 || e.decimals > 18) {
        throw new EventValidationError("decimals must be an integer 0..18", "decimals");
      }
      break;
    case "MERGER":
      requireFields(e, ["newMint"]);
      if (!MINT_RE.test(e.newMint)) throw new EventValidationError("newMint must be a base58 Solana pubkey", "newMint");
      if (e.newMint === e.mint) throw new EventValidationError("merger must change the mint", "newMint");
      if (e.exchangeNumerator !== undefined || e.exchangeDenominator !== undefined) {
        if (!Number.isInteger(e.exchangeNumerator) || e.exchangeNumerator <= 0 ||
            !Number.isInteger(e.exchangeDenominator) || e.exchangeDenominator <= 0) {
          throw new EventValidationError("exchange ratio must be two positive integers (old per new)", "exchangeNumerator");
        }
        if (e.exchangeNumerator > Number.MAX_SAFE_INTEGER || e.exchangeDenominator > Number.MAX_SAFE_INTEGER) {
          throw new EventValidationError("exchange ratio exceeds Number.MAX_SAFE_INTEGER — exact JSON transport impossible", "exchangeNumerator");
        }
      }
      break;
    case "TICKER_CHANGE":
      requireFields(e, ["oldSymbol", "newSymbol"]);
      if (typeof e.oldSymbol !== "string" || typeof e.newSymbol !== "string" ||
          e.oldSymbol === e.newSymbol) {
        throw new EventValidationError("ticker change must alter the symbol", "newSymbol");
      }
      break;
    case "REDEEM":
      // a redemption closes the token: an exchange for the underlying asset/stable, no extra fields required,
      // but a link to the terms must be in sources (checked above)
      break;
    case "MULTIPLIER_CHANGE":
      // the xStocks model: the raw balance does not change, scaled = raw × multiplier.
      // Multipliers are EXACT decimal strings ("1.005714560286254"), float is forbidden.
      requireFields(e, ["multiplierFrom", "multiplierTo"]);
      for (const f of ["multiplierFrom", "multiplierTo"]) {
        if (typeof e[f] !== "string" || !DECIMAL_RE.test(e[f])) {
          throw new EventValidationError(`${f} must be a decimal string like "1.0057" (no float)`, f);
        }
        if (ZERO_MULTIPLIER_RE.test(e[f])) {
          throw new EventValidationError(`${f} must be positive — a zero multiplier does not exist (the position would be zeroed silently)`, f);
        }
        const frac = e[f].split(".")[1] ?? "";
        if (frac.length > MAX_MULTIPLIER_FRACTION_DIGITS) {
          throw new EventValidationError(`${f} precision >${MAX_MULTIPLIER_FRACTION_DIGITS} fraction digits unsupported`, f);
        }
      }
      if (e.multiplierFrom === e.multiplierTo) {
        throw new EventValidationError("multiplier change must alter the multiplier", "multiplierTo");
      }
      if (e.reason !== undefined && typeof e.reason !== "string") {
        throw new EventValidationError("reason must be a string (e.g. Dividend, Stock Split, Reverse Split)", "reason");
      }
      break;
  }

  if (e.announcedBy !== undefined && !PUBKEY_RE.test(e.announcedBy)) {
    throw new EventValidationError("announcedBy must be a valid pubkey", "announcedBy");
  }
  return true;
}

export function isValidEvent(e) {
  try {
    validateEvent(e);
    return true;
  } catch {
    return false;
  }
}
