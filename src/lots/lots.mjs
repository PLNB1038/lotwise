// Adjusted lots engine: applies canonical events (../schema/events.mjs)
// to a list of lots. Arithmetic is integer-only (BigInt), no float.
// Principle "a quiet lie is worse than a crash": any invalid/inapplicable event
// throws BEFORE state changes — application is atomic.
// Date semantics: an event affects only lots bought STRICTLY BEFORE its
// effectiveDate (one bought on the event day already follows post-event rules).
// Canonical order (FIX-1): events apply in a canonical order — chronologically by
// calendar day, and within a day SPLIT, then DIVIDEND_ACCRUAL, then MERGER, then REDEEM —
// so the same facts in any feed order produce the same report. Each pairing is a semantic
// decision, not a taste:
//   SPLIT → DIV: the dividend is computed on the post-split position — already pinned by
//     test/lots.test.mjs ("the dividend on the NEW qty") and the US convention (a split is
//     effective before the open); canonicalization makes both feed orders equal to that
//     answer, the pin stays green untouched.
//   DIV → MERGER: the dividend accrues on the OLD units before the exchange — the base
//     "the position held at the start of the ex-date" (API_SEMANTICS) existed as the old mint.
//   DIV → REDEEM: lots held at the ex-day midnight both accrue and realize — the hold
//     condition (< midnight) is the same for both; shrinking the base after the buyback
//     would be a lie.
//   Between days: ascending chronology — an out-of-order feed becomes deterministic.
// Inside one class the order is a TOTAL order: mint, then the type's ratio/amount/symbol
// fields, then the whole-event JSON as the last tiebreak — two same-slot events of one
// class (two dividends of one day, two ticker changes) report in a feed-independent order,
// and the dedup survivor below stops depending on the array order at all. Only
// byte-identical events may tie, and ties are indistinguishable in the output.
// The /lots report may contain lots with acquiredDate:null (a tx without blockTime) — see
// the header of ../wallet/report.mjs: applyEvents throws LotError on such a lot.
import { validateEvent } from "../schema/events.mjs";
import { parseIsoDateMs } from "../schema/isodate.mjs";

export class LotError extends Error {
  constructor(msg, event) {
    super(msg);
    this.name = "LotError";
    this.event = event;
  }
}

const cloneLots = (lots) => lots.map((l) => ({ ...l }));

// A lot is affected by an event only if bought strictly before its effectiveDate.
// Comparison is numeric (unix-ms) via strict parseIsoDateMs, never lexicographic
// (paired with timeline.mjs). A lot with null/garbage acquiredDate — LotError (fail-closed):
// "apply to everyone since the date is unknown" is exactly the quiet lie because of which
// the split reached lots bought after the event.
const heldBefore = (lot, effectiveTs, e) => {
  if (lot.acquiredDate === null || lot.acquiredDate === undefined) {
    throw new LotError(
      `lot ${lot.id}: acquiredDate is unknown — cannot decide if the lot predates ${e.effectiveDate}; refusing to guess`, e,
    );
  }
  const at = parseIsoDateMs(String(lot.acquiredDate));
  if (at === null) {
    throw new LotError(
      `lot ${lot.id}: acquiredDate ${JSON.stringify(String(lot.acquiredDate))} is not a canonical ISO date; refusing to guess`, e,
    );
  }
  return at < effectiveTs;
};

/**
 * @param {Array<{id:string, mint:string, owner:string, qtyRaw:bigint, acquiredDate:string, basisRaw:bigint}>} lots
 *   qtyRaw/basisRaw — BigInt ONLY: the JSDoc previously promised int — a number
 *   dies with a bare "Cannot mix BigInt", not a LotError; this is an exact-arithmetic engine,
 *   we do no type conversion on input)
 * @param {Array<object>} events — canonical schema events
 * @returns {{lots: Array, accruals: Array, realized: Array, symbolMap: object, applied: number, warnings: Array}}
 *   warnings — order-consequence notes: {kind:"dividend-shadowed-by-merger", mint, day,
 *   amountPerUnitRaw} when a dividend for a merger's new mint on the merger day accrued
 *   ZERO (the holders were still on the old mint when it applies), and
 *   {kind:"dividend-partially-shadowed-by-merger", …, shadowedQtyRaw} when it accrued
 *   but a same-day exchange still moved pre-base units onto the mint after it — the
 *   report names the slice that never accrued instead of a silent understatement.
 *
 * Date semantics (see the header): lot-touching events (SPLIT/DIVIDEND_ACCRUAL/
 * MERGER/REDEEM) apply only to lots with acquiredDate strictly earlier than
 * effectiveDate; comparison in unix-ms (parseIsoDateMs), null/garbage in acquiredDate —
 * LotError. TICKER_CHANGE (a symbol map) and MULTIPLIER_CHANGE (a no-op on raw lots)
 * touch no lots and require no acquiredDate.
 */
export function applyEvents(lots, events) {
  // Phase 1: full validation of all events before any changes (atomicity).
  for (const e of events) {
    try {
      // a copy: validation canonicalizes a DIVIDEND_ACCRUAL's date in place — the
      // caller's array must not be mutated under the engine's feet (the engine itself
      // consumes the day part of datetime strings wherever it needs the ex-day)
      validateEvent({ ...e });
    } catch (err) {
      throw new LotError(`invalid event rejected: ${err.message}`, e);
    }
  }

  // Canonical application order (the rationale lives in the header). The caller's
  // array is not touched — the sort decorates a copy.
  const CLASS_RANK = {
    SPLIT: 0,
    DIVIDEND_ACCRUAL: 1,
    MERGER: 2,
    REDEEM: 3,
    // lot-independent bookkeeping: nothing to order semantically, grouped last
    TICKER_CHANGE: 4,
    MULTIPLIER_CHANGE: 4,
  };
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  // a per-event key tuple: (day, rank, mint, type fields, whole-event JSON). The day key is
  // the CALENDAR DAY of effectiveDate, not the instant — the same declared day the accrual
  // route and the dedup key use; phase 1 validated the date, the parse cannot fail here.
  const orderKeys = (e) => {
    const keys = [
      parseIsoDateMs(String(e.effectiveDate).slice(0, 10)),
      CLASS_RANK[e.type],
      e.mint,
    ];
    if (e.type === "SPLIT") keys.push(e.ratioNumerator, e.ratioDenominator);
    if (e.type === "DIVIDEND_ACCRUAL") keys.push(e.amountPerUnitRaw, e.decimals);
    if (e.type === "MERGER") keys.push(e.exchangeNumerator ?? 0, e.exchangeDenominator ?? 0, e.newMint);
    if (e.type === "TICKER_CHANGE") keys.push(e.oldSymbol, e.newSymbol);
    if (e.type === "MULTIPLIER_CHANGE") keys.push(e.multiplierFrom, e.multiplierTo);
    keys.push(JSON.stringify(e)); // the final tiebreak: a total order over distinct facts
    return keys;
  };
  const ordered = events
    .map((e) => ({ e, k: orderKeys(e) }))
    // Array.prototype.sort is stable (Node ≥ 11), but no input-order tie survives to it:
    // cross-type comparisons return at the rank, same-type tuples share the shape, and the
    // JSON tail separates everything but byte-identical events
    .sort((a, b) => {
      for (let i = 0; i < a.k.length; i++) {
        const c = cmp(a.k[i], b.k[i]);
        if (c !== 0) return c;
      }
      return 0;
    })
    .map((p) => p.e);

  const out = cloneLots(lots);
  const accruals = [];
  const realized = [];
  const symbolMap = {};
  // honesty bookkeeping for one canonical-order consequence: a DIVIDEND_ACCRUAL for a
  // merger's NEW mint ranks before the exchange, so on the merger day it applies while
  // holders of the old mint are still there — units converted by the exchange never
  // accrue (fully when nobody else held the new mint, partially otherwise), and the
  // report must say so instead of a silent zero
  const zeroAccrualDivs = [];
  const divHolderSets = new Map();
  const mergerConversions = [];

  const lotsOf = (mint) => out.filter((l) => l.mint === mint);

  // semantic dedup of dividend sightings. The producer's key includes
  // sourceUrl, so the same dividend reaching the store from two sources (a press page and
  // an API node) survives as two events — and without this gate would accrue twice,
  // doubling the declared income. mint + ex-date + per-unit amount is the dividend's identity.
  // Deterministic survivor: two sightings of one identity may differ in metadata
  // (decimals/sourceUrl) and "first of the array" made the survivor's metadata depend on
  // feed order. The lexicographically smallest (decimals, first source) wins, so any
  // permutation of the same events yields the same accrual.
  const divSurvivor = new Map();
  for (const e of ordered) {
    if (e.type !== "DIVIDEND_ACCRUAL") continue;
    const key = `${e.mint}|${String(e.effectiveDate).slice(0, 10)}|${e.amountPerUnitRaw}`;
    const rank = `${e.decimals ?? ""}|${JSON.stringify(Array.isArray(e.sources) ? e.sources : null)}|${e.status ?? ""}`;
    const cur = divSurvivor.get(key);
    if (cur === undefined || rank < cur.rank) divSurvivor.set(key, { rank, e });
  }
  for (const e of ordered) {
    if (e.type === "DIVIDEND_ACCRUAL") {
      // the route's identity: mint + CALENDAR EX-DAY + amount — the schema canonicalizes
      // datetime forms to the day at the gate, so this is a true identity. "Same day OR
      // same instant" was not transitive: three events could dedup to 2 or 1 depending
      // on the store order, and a cross-midnight pair's survivor decided the base day.
      const key = `${e.mint}|${String(e.effectiveDate).slice(0, 10)}|${e.amountPerUnitRaw}`;
      if (divSurvivor.get(key).e !== e) continue;
    }
    switch (e.type) {
      case "SPLIT": {
        const { ratioNumerator: N, ratioDenominator: D } = e;
        const effTs = parseIsoDateMs(e.effectiveDate); // validated by phase 1 — not null
        for (const lot of lotsOf(e.mint)) {
          if (!heldBefore(lot, effTs, e)) continue; // bought after the split — the price is already post-split
          if (lot.qtyRaw % BigInt(D) !== 0n) {
            throw new LotError(
              `split ${N}/${D}: lot ${lot.id} qty ${lot.qtyRaw} not divisible by ${D}; refusing to round`, e,
            );
          }
          lot.qtyRaw = (lot.qtyRaw / BigInt(D)) * BigInt(N);
          // basisRaw is unchanged: the lot's cost basis is preserved in full.
        }
        break;
      }
      case "DIVIDEND_ACCRUAL": {
        // the ex-day's UTC MIDNIGHT, the same base the /accruals route uses — a datetime
        // event (not through the producer) used to split route and engine here
        const effTs = Date.parse(`${String(e.effectiveDate).slice(0, 10)}T00:00:00.000Z`); // day valid post phase-1
        const holders = new Map();
        for (const lot of lotsOf(e.mint)) {
          if (!heldBefore(lot, effTs, e)) continue; // a dividend — holders on the ex-date only
          holders.set(lot.owner, (holders.get(lot.owner) ?? 0n) + lot.qtyRaw);
        }
        for (const [owner, totalQty] of holders) {
          accruals.push({
            mint: e.mint,
            owner,
            amountPerUnitRaw: BigInt(e.amountPerUnitRaw),
            totalRaw: BigInt(e.amountPerUnitRaw) * totalQty,
            decimals: e.decimals,
            event: e,
          });
        }
        if (holders.size === 0) zeroAccrualDivs.push(e);
        divHolderSets.set(e, holders);
        break;
      }
      case "MERGER": {
        if (e.exchangeNumerator === undefined) {
          throw new LotError("merger without exchange ratio: refusing to guess", e);
        }
        const { exchangeNumerator: N, exchangeDenominator: D, newMint } = e; // N old for D new
        const effTs = parseIsoDateMs(e.effectiveDate); // validated by phase 1 — not null
        const dayMidnight = Date.parse(`${String(e.effectiveDate).slice(0, 10)}T00:00:00.000Z`);
        let converted = 0;
        let shadowQty = 0n; // converted units whose lots predate the day's midnight base
        for (const lot of lotsOf(e.mint)) {
          if (!heldBefore(lot, effTs, e)) continue; // a lot after the exchange is not converted
          if (lot.qtyRaw % BigInt(N) !== 0n) {
            throw new LotError(
              `merger ${N}:${D}: lot ${lot.id} qty ${lot.qtyRaw} not divisible by ${N}; refusing to round`, e,
            );
          }
          const outQty = (lot.qtyRaw / BigInt(N)) * BigInt(D);
          lot.qtyRaw = outQty;
          lot.mint = newMint;
          // basisRaw is preserved.
          converted++;
          // heldBefore above already validated acquiredDate parses
          if (parseIsoDateMs(String(lot.acquiredDate)) < dayMidnight) shadowQty += outQty;
        }
        // materiality for the shadow bookkeeping above: only units an exchange moved onto
        // this mint from lots that predate the day's base would have accrued had the
        // dividend applied after it — that counterfactual is what makes a zero or a
        // missing slice the order's doing rather than real economics
        mergerConversions.push({ newMint, day: String(e.effectiveDate).slice(0, 10), converted, shadowQty });
        break;
      }
      case "TICKER_CHANGE": {
        symbolMap[e.oldSymbol] = e.newSymbol; // lots untouched: same mint
        break;
      }
      case "REDEEM": {
        // the redemption closes the position on the redemption date: only lots bought strictly
        // earlier are realized and removed (a lot dated after the event is not inventedly destroyed)
        const effTs = parseIsoDateMs(e.effectiveDate); // validated by phase 1 — not null
        const doomed = lotsOf(e.mint).filter((l) => heldBefore(l, effTs, e));
        const doomedIds = new Set(doomed.map((l) => l.id));
        const byOwner = new Map();
        for (const lot of doomed) {
          const agg = byOwner.get(lot.owner) ?? { mint: e.mint, owner: lot.owner, qtyRaw: 0n, basisRaw: 0n };
          agg.qtyRaw += lot.qtyRaw;
          agg.basisRaw += lot.basisRaw;
          byOwner.set(lot.owner, agg);
        }
        for (const agg of byOwner.values()) realized.push({ ...agg, event: e });
        for (let i = out.length - 1; i >= 0; i--) {
          if (out[i].mint === e.mint && doomedIds.has(out[i].id)) out.splice(i, 1);
        }
        break;
      }
      case "MULTIPLIER_CHANGE": {
        // A deliberate no-op on raw lots: the multiplier lives in the display layer
        // (MultiplierTimeline); raw xStocks balances do not change on events.
        break;
      }
      default:
        throw new LotError(`unhandled event type ${e.type}`, e);
    }
  }
  // The FULL shadow fires when the zero accrual is the ORDER's doing: the dividend found
  // no holders, a same-day exchange moved pre-base units onto its mint right after it —
  // had the dividend applied after the exchange, those units would have accrued (the
  // counterfactual that makes the zero an artifact). Deterministic: both lists follow
  // the canonical order, so any permutation of the same facts yields the same warnings.
  const warnings = [];
  for (const e of zeroAccrualDivs) {
    const day = String(e.effectiveDate).slice(0, 10);
    if (mergerConversions.some((m) =>
      m.converted > 0 && m.newMint === e.mint && m.day === day && m.shadowQty > 0n)) {
      warnings.push({
        kind: "dividend-shadowed-by-merger",
        mint: e.mint,
        day,
        amountPerUnitRaw: BigInt(e.amountPerUnitRaw),
      });
    }
  }
  // The PARTIAL shadow: the dividend found some holders and accrued, but a same-day
  // exchange still moved pre-base units onto its mint after it — those units never
  // accrued, a silent slice of the declared income. The warning names the missed
  // quantity so the consumer can see the day's dividend is understated, not absent.
  for (const [e, holders] of divHolderSets) {
    if (holders.size === 0) continue; // full shadows warned above
    const day = String(e.effectiveDate).slice(0, 10);
    const shadowedQtyRaw = mergerConversions
      .filter((m) => m.converted > 0 && m.newMint === e.mint && m.day === day)
      .reduce((s, m) => s + m.shadowQty, 0n);
    if (shadowedQtyRaw > 0n) {
      warnings.push({
        kind: "dividend-partially-shadowed-by-merger",
        mint: e.mint,
        day,
        amountPerUnitRaw: BigInt(e.amountPerUnitRaw),
        shadowedQtyRaw,
      });
    }
  }
  return { lots: out, accruals, realized, symbolMap, applied: events.length, warnings };
}
