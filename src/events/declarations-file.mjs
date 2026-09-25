// The operator's dividend declarations file (round 21, F3 wiring): the channel that turns
// /accruals from an honest [] into live data. xStocks publishes no per-unit amounts
// (see the header of dividends.mjs), so DIVIDEND_ACCRUAL enters the store through
// data/declarations.json — one issuer-confirmed declaration per line:
//   { "symbol": "KOx", "exDate": "2026-06-18", "amountPerUnitRaw": "2000000",
//     "decimals": 6, "sourceUrl": "https://issuer.example/dividends/q2" }
// The file is READ-ONLY to the product (nothing ever writes it), so a broken file needs
// no evidence copy: warn + a /health flag, the boot continues without declarations —
// the same degradation shape as a corrupt registry, minus the quarantine.
// The file is all-or-nothing BY DESIGN: one malformed declaration line fails the whole
// load (the producer's contract — silently dropping half an operator's feed is worse).
import { readFileSync } from "node:fs";
import { dividendsFromDeclarations } from "./dividends.mjs";
import { bindMintAndValidate } from "./normalize-xstocks.mjs";

/**
 * @param {string} path — the declarations file (conventionally data/declarations.json)
 * @param {Array} registry — the token registry (binds symbols to mints)
 * @returns {{ok: boolean, events: Array, loaded: number, reason: string|null}}
 *   ok — the file loaded and every line validated; events carry bound mints, old → new
 *   per token. A missing file is ok with loaded 0 (no declarations declared is the norm).
 */
export function loadDeclarationsFile(path, registry) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { ok: true, events: [], loaded: 0, reason: null };
    return { ok: false, events: [], loaded: 0, reason: `declarations unreadable: ${err.message}` };
  }
  let list;
  try {
    list = JSON.parse(raw);
  } catch (err) {
    return { ok: false, events: [], loaded: 0, reason: `declarations not valid JSON: ${err.message}` };
  }
  if (!Array.isArray(list)) {
    return { ok: false, events: [], loaded: 0, reason: `declarations must be a JSON array, got ${list === null ? "null" : typeof list}` };
  }
  const events = [];
  try {
    for (const t of registry) {
      events.push(...bindMintAndValidate(dividendsFromDeclarations(list, { symbol: t.symbol }), t.mint));
    }
  } catch (err) {
    // DeclarationError from the producer, or EventValidationError from the bind — one
    // malformed line fails the whole file loudly; the operator fixes the file, not us.
    return { ok: false, events: [], loaded: 0, reason: `declarations rejected: ${err.message}` };
  }
  return { ok: true, events, loaded: events.length, reason: null };
}
