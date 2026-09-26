// The operator's dividend declarations file, F3 wiring): the channel that turns
// /accruals from an honest [] into live data. xStocks publishes no per-unit amounts
// (see the header of dividends.mjs), so DIVIDEND_ACCRUAL enters the store through
// data/declarations.json — one issuer-confirmed declaration per line:
//   { "symbol": "KOx", "exDate": "2026-06-18", "amountPerUnitRaw": "2000000",
//     "decimals": 6, "sourceUrl": "https://issuer.example/dividends/q2" }
// An issuer CORRECTION is declared, not implied — a line may carry an optional
// `supersedes` naming the declaration it REPLACES by the dividend's identity:
//   { ..., "amountPerUnitRaw": "2000000",
//     "supersedes": { "exDate": "2026-06-18", "amountPerUnitRaw": "4000000" } }
// The replacement removes the target's accrual (the corrected amount accrues alone);
// a dangling, chained or doubled reference refuses the whole file — see dividends.mjs.
// The file is READ-ONLY to the product (nothing ever writes it), so a broken file needs
// no evidence copy: warn + a /health flag, the boot continues without declarations —
// the same degradation shape as a corrupt registry, minus the quarantine.
// The file is all-or-nothing BY DESIGN: one malformed declaration line fails the whole
// load (the producer's contract — silently dropping half an operator's feed is worse).
import { readFileSync } from "node:fs";
import { buildDeclarationEvents } from "./dividends.mjs";
import { bindMintAndValidate } from "./normalize-xstocks.mjs";
import { parseIsoDateMs } from "../schema/isodate.mjs";

/**
 * @param {string} path — the declarations file (conventionally data/declarations.json)
 * @param {Array} registry — the token registry (binds symbols to mints)
 * @returns {{ok: boolean, events: Array, loaded: number, superseded: number, reason: string|null}}
 *   ok — the file loaded and every line validated; events carry bound mints, old → new
 *   per token. A missing file is ok with loaded 0 (no declarations declared is the norm).
 *   superseded — how many corrections were applied (declarations carrying `supersedes`
 *   that replaced their target); goes into /health.declarations.superseded.
 */
export function loadDeclarationsFile(path, registry) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { ok: true, events: [], loaded: 0, superseded: 0, reason: null };
    return { ok: false, events: [], loaded: 0, superseded: 0, reason: `declarations unreadable: ${err.message}` };
  }
  let list;
  try {
    list = JSON.parse(raw);
  } catch (err) {
    return { ok: false, events: [], loaded: 0, superseded: 0, reason: `declarations not valid JSON: ${err.message}` };
  }
  if (!Array.isArray(list)) {
    return { ok: false, events: [], loaded: 0, superseded: 0, reason: `declarations must be a JSON array, got ${list === null ? "null" : typeof list}` };
  }
  const events = [];
  let superseded = 0;
  // Every SYMBOL's broken references are collected, not just the first throw: the loader
  // walks the registry symbol by symbol, and the first symbol's refusal used to hide all
  // the others — one edit-restart cycle per symbol for what is one broken file. The cap
  // keeps the reason readable on a badly mangled feed.
  const rejections = [];
  for (const t of registry) {
    try {
      const built = buildDeclarationEvents(list, { symbol: t.symbol });
      superseded += built.superseded;
      events.push(...bindMintAndValidate(built.events, t.mint));
    } catch (err) {
      // DeclarationError from the producer (a malformed line or a broken supersedes
      // reference — dangling, chained, doubled), or EventValidationError from the bind —
      // one broken line fails the whole file loudly; the operator fixes the file, not us.
      // The message itself is "; "-joined inside a symbol — bracketing keeps each
      // symbol's segment attributable by eye instead of only by regex.
      rejections.push(`${t.symbol}: (${err.message})`);
    }
  }
  if (rejections.length > 0) {
    const listed = rejections.slice(0, 10);
    if (rejections.length > 10) listed.push(`…and ${rejections.length - 10} more symbols with broken declarations`);
    return { ok: false, events: [], loaded: 0, superseded: 0, reason: `declarations rejected: ${listed.join("; ")}` };
  }
  // A corrected re-declaration WITH the supersedes field never reaches this scan: the
  // producer resolved the replacement above, the target event is gone. The warning is
  // for LEGACY files only — a corrected re-declaration without the field (the issuer
  // amends the ex-day, a new sourceUrl) is indistinguishable from two nearby dividends
  // of the same amount: the channel is append-only and a dividend's identity is
  // mint + ex-day + amount, so BOTH would accrue. The operator sees the suspicious
  // cluster at load time instead of discovering doubled income in a report; the load
  // itself is unaffected (the file is the operator's).
  // Sort + a sliding window: one aggregated warning per cluster, linear after the sort —
  // a pair-scan over a big file held the boot (10k lines ≈ minutes, and a 100-line
  // duplicate cluster printed 4950 pair-warnings on every restart). The window measures
  // NEIGHBOR distances, not the distance to the cluster's first day: a chain 01/03/05
  // (every neighbor ≤ 3 days) is one suspicious cluster in full — the anchor window
  // dropped its tail and the operator saw 2 of the 3 declarations.
  const divs = events
    .filter((e) => e.type === "DIVIDEND_ACCRUAL")
    .map((e) => ({ mint: e.mint, amount: e.amountPerUnitRaw, day: String(e.effectiveDate).slice(0, 10), ms: parseIsoDateMs(String(e.effectiveDate).slice(0, 10)) }))
    .filter((d) => d.ms !== null)
    .sort((a, b) => (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : a.amount - b.amount || a.ms - b.ms));
  for (let i = 0; i < divs.length;) {
    let j = i + 1;
    while (
      j < divs.length
      && divs[j].mint === divs[i].mint
      && divs[j].amount === divs[i].amount
      && divs[j].ms - divs[j - 1].ms <= 3 * 86_400_000
    ) j++;
    if (j - i > 1) {
      console.warn(
        `[declarations] ${j - i} same-amount dividend declarations within 3 days (${divs.slice(i, j).map((d) => d.day).join(", ")}, amountPerUnitRaw ${divs[i].amount}) — a corrected re-declaration would double the income; resolve the file`,
      );
    }
    i = j;
  }
  return { ok: true, events, loaded: events.length, superseded, reason: null };
}
