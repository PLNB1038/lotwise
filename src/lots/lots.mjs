// Adjusted lots engine: applies canonical events (../schema/events.mjs)
// to a list of lots. Arithmetic is integer-only (BigInt), no float.
// Principle "a quiet lie is worse than a crash": any invalid/inapplicable event
// throws BEFORE state changes — application is atomic.
// Date semantics: an event affects only lots bought STRICTLY BEFORE its
// effectiveDate (one bought on the event day already follows post-event rules).
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
 *   qtyRaw/basisRaw — BigInt ONLY (round 7 fix 18: the JSDoc previously promised int — a number
 *   dies with a bare "Cannot mix BigInt", not a LotError; this is an exact-arithmetic engine,
 *   we do no type conversion on input)
 * @param {Array<object>} events — canonical schema events
 * @returns {{lots: Array, accruals: Array, realized: Array, symbolMap: object, applied: number}}
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
      validateEvent(e);
    } catch (err) {
      throw new LotError(`invalid event rejected: ${err.message}`, e);
    }
  }

  const out = cloneLots(lots);
  const accruals = [];
  const realized = [];
  const symbolMap = {};

  const lotsOf = (mint) => out.filter((l) => l.mint === mint);

  for (const e of events) {
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
        const effTs = parseIsoDateMs(e.effectiveDate); // validated by phase 1 — not null
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
        break;
      }
      case "MERGER": {
        if (e.exchangeNumerator === undefined) {
          throw new LotError("merger without exchange ratio: refusing to guess", e);
        }
        const { exchangeNumerator: N, exchangeDenominator: D, newMint } = e; // N old for D new
        const effTs = parseIsoDateMs(e.effectiveDate); // validated by phase 1 — not null
        for (const lot of lotsOf(e.mint)) {
          if (!heldBefore(lot, effTs, e)) continue; // a lot after the exchange is not converted
          if (lot.qtyRaw % BigInt(N) !== 0n) {
            throw new LotError(
              `merger ${N}:${D}: lot ${lot.id} qty ${lot.qtyRaw} not divisible by ${N}; refusing to round`, e,
            );
          }
          lot.qtyRaw = (lot.qtyRaw / BigInt(N)) * BigInt(D);
          lot.mint = newMint;
          // basisRaw is preserved.
        }
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
  return { lots: out, accruals, realized, symbolMap, applied: events.length };
}
