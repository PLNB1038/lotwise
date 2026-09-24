// Enriching registry decimals from a Jupiter Price API batch response (round 6).
// The logic was moved out of scripts/enrich-decimals.mjs for testability of the two contracts
// of finding LW2_tokens_json_write_non_atomic:
//   (1) the write is atomic (atomicWriteJson — a truncated tokens.json crashed the whole service);
//   (2) filled=0 ⇒ the file is not rewritten at all: previously every script run
//       rewrote the file unconditionally and replayed the corrupted-write window for no reason.
// decimals validation happens ON INPUT (a pipeline quirk): garbage from the API (negative, >18,
// non-integer, non-number) never reaches the file — the write is untouched, the symbol goes to
// skipped. Previously a data emitter's garbage entry put the whole registry into corrupted mode
// at load time already; validateRegistryEntry in registry.mjs remains the second line of defense.
import { readFileSync } from "node:fs";
import { atomicWriteJson } from "../fs/atomic.mjs";

// The decimals contract: null | integer 0..18 (shared with registry.mjs)
const DECIMALS_MIN = 0;
const DECIMALS_MAX = 18;

/**
 * Fits decimals into the token list from a Jupiter response (mutates list, as before:
 * only entries with decimals === null are filled; already enriched entries are ignored entirely,
 * garbage in their part of the response never reaches skipped).
 * Validation on input:
 *   - null/undefined in the response — uniformly "no value": the entry is untouched,
 *     the sourceDecimals marker is not set;
 *   - non-integer or outside 0..18 — the entry is untouched, the symbol lands in skipped
 *     with reason "invalid-decimals".
 * @param {Array<{mint: string, decimals: number|null, sourceDecimals?: string}>} list
 * @param {Record<string, {decimals?: number}>} prices — the response of lite-api.jup.ag/price/v3
 * @returns {{filled: number, unknown: string[], skipped: Array<{symbol: string, reason: string}>}}
 *   unknown — symbols missing from the response; skipped — rejected garbage with a reason
 */
export function applyJupiterDecimals(list, prices) {
  let filled = 0;
  const unknown = [];
  const skipped = [];
  for (const t of list) {
    const p = prices?.[t.mint];
    if (!p) {
      unknown.push(t.symbol);
      continue;
    }
    if (t.decimals !== null) continue; // already enriched — its part of the response is not read at all
    const raw = p.decimals;
    if (raw === null || raw === undefined) continue; // "no value" — no marker set
    if (!Number.isInteger(raw) || raw < DECIMALS_MIN || raw > DECIMALS_MAX) {
      skipped.push({ symbol: t.symbol, reason: "invalid-decimals" });
      continue; // the entry is NOT touched: decimals stays as it was
    }
    t.decimals = raw;
    t.sourceDecimals = "jupiter";
    filled++;
  }
  return { filled, unknown, skipped };
}

/**
 * Enrich the registry file on disk. filled=0 → the file is not opened for writing at all
 * (including when everything went to skipped: rejected entries did not change — there is nothing to write).
 * @param {string} path — path to data/tokens.json
 * @param {Record<string, {decimals?: number}>} prices
 * @returns {{filled: number, unknown: string[], skipped: Array<{symbol: string, reason: string}>, written: boolean}}
 */
export function enrichDecimalsFile(path, prices) {
  const list = JSON.parse(readFileSync(path, "utf8"));
  const { filled, unknown, skipped } = applyJupiterDecimals(list, prices);
  if (filled === 0) {
    return { filled, unknown, skipped, written: false };
  }
  atomicWriteJson(path, list);
  return { filled, unknown, skipped, written: true };
}
