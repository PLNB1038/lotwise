// Движок adjusted lots: применяет канонические события (../schema/events.mjs)
// к списку лотов. Арифметика только целочисленная (BigInt), никакого float.
// Принцип «тихая ложь хуже падения»: любое невалидное/неприменимое событие
// бросает ошибку ДО изменения состояния — применение атомарно.
import { validateEvent } from "../schema/events.mjs";

export class LotError extends Error {
  constructor(msg, event) {
    super(msg);
    this.name = "LotError";
    this.event = event;
  }
}

const cloneLots = (lots) => lots.map((l) => ({ ...l }));

/**
 * @param {Array<{id:string, mint:string, owner:string, qtyRaw:bigint|int, acquiredDate:string, basisRaw:bigint|int}>} lots
 * @param {Array<object>} events — события канонической схемы
 * @returns {{lots: Array, accruals: Array, realized: Array, symbolMap: object, applied: number}}
 */
export function applyEvents(lots, events) {
  // Фаза 1: полная валидация всех событий до любых изменений (атомарность).
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
        for (const lot of lotsOf(e.mint)) {
          if (lot.qtyRaw % BigInt(D) !== 0n) {
            throw new LotError(
              `split ${N}/${D}: lot ${lot.id} qty ${lot.qtyRaw} not divisible by ${D}; refusing to round`, e,
            );
          }
          lot.qtyRaw = (lot.qtyRaw / BigInt(D)) * BigInt(N);
          // basisRaw не меняется: себестоимость лота сохраняется целиком.
        }
        break;
      }
      case "DIVIDEND_ACCRUAL": {
        const holders = new Map();
        for (const lot of lotsOf(e.mint)) {
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
        const { exchangeNumerator: N, exchangeDenominator: D, newMint } = e; // N старых за D новых
        for (const lot of lotsOf(e.mint)) {
          if (lot.qtyRaw % BigInt(N) !== 0n) {
            throw new LotError(
              `merger ${N}:${D}: lot ${lot.id} qty ${lot.qtyRaw} not divisible by ${N}; refusing to round`, e,
            );
          }
          lot.qtyRaw = (lot.qtyRaw / BigInt(N)) * BigInt(D);
          lot.mint = newMint;
          // basisRaw сохраняется.
        }
        break;
      }
      case "TICKER_CHANGE": {
        symbolMap[e.oldSymbol] = e.newSymbol; // лоты не трогаем: минт тот же
        break;
      }
      case "REDEEM": {
        const doomed = lotsOf(e.mint);
        const byOwner = new Map();
        for (const lot of doomed) {
          const agg = byOwner.get(lot.owner) ?? { mint: e.mint, owner: lot.owner, qtyRaw: 0n, basisRaw: 0n };
          agg.qtyRaw += lot.qtyRaw;
          agg.basisRaw += lot.basisRaw;
          byOwner.set(lot.owner, agg);
        }
        for (const agg of byOwner.values()) realized.push({ ...agg, event: e });
        for (let i = out.length - 1; i >= 0; i--) {
          if (out[i].mint === e.mint) out.splice(i, 1);
        }
        break;
      }
      case "MULTIPLIER_CHANGE": {
        // Сознательный no-op на raw-лотах: множитель живёт в слое отображения
        // (MultiplierTimeline), raw-балансы xStocks при событиях не меняются.
        break;
      }
      default:
        throw new LotError(`unhandled event type ${e.type}`, e);
    }
  }
  return { lots: out, accruals, realized, symbolMap, applied: events.length };
}
