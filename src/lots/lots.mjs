// Движок adjusted lots: применяет канонические события (../schema/events.mjs)
// к списку лотов. Арифметика только целочисленная (BigInt), никакого float.
// Принцип «тихая ложь хуже падения»: любое невалидное/неприменимое событие
// бросает ошибку ДО изменения состояния — применение атомарно.
// Датная семантика: событие касается только лотов, купленных СТРОГО РАНЬШЕ его
// effectiveDate (купленный в день события — уже по пост-событийным правилам).
// Отчёт /lots может содержать лоты с acquiredDate:null (tx без blockTime) — см.
// шапку ../wallet/report.mjs: applyEvents на таком лоте бросает LotError.
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

// Лот затронут событием, только если куплен строго раньше его effectiveDate.
// Сравнение — числом (unix-ms) через строгий parseIsoDateMs, никогда лексикографически
// (пара к timeline.mjs). Лот с acquiredDate null/мусор — LotError (fail-closed):
// «применим ко всем, раз дата неизвестна» — та самая тихая ложь, из-за которой
// сплит доставался и лотам, купленным после события.
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
 *   qtyRaw/basisRaw — ТОЛЬКО BigInt (ROUND7 №18: JSDoc прежде обещал int — number
 *   умирает голым «Cannot mix BigInt», а не LotError; движок точной арифметики,
 *   конверсию типов на входе не делаем)
 * @param {Array<object>} events — события канонической схемы
 * @returns {{lots: Array, accruals: Array, realized: Array, symbolMap: object, applied: number}}
 *
 * Датная семантика (см. шапку): события, трогающие лоты (SPLIT/DIVIDEND_ACCRUAL/
 * MERGER/REDEEM), применяются только к лотам с acquiredDate строго раньше
 * effectiveDate; сравнение unix-ms (parseIsoDateMs), null/мусор в acquiredDate —
 * LotError. TICKER_CHANGE (карта символов) и MULTIPLIER_CHANGE (no-op на raw-лотах)
 * лоты не трогают и acquiredDate не требуют.
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
        const effTs = parseIsoDateMs(e.effectiveDate); // валидировано фазой 1 — не null
        for (const lot of lotsOf(e.mint)) {
          if (!heldBefore(lot, effTs, e)) continue; // куплен после сплита — цена уже пост-сплит
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
        const effTs = parseIsoDateMs(e.effectiveDate); // валидировано фазой 1 — не null
        const holders = new Map();
        for (const lot of lotsOf(e.mint)) {
          if (!heldBefore(lot, effTs, e)) continue; // дивиденд — только держателям на экс-дату
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
        const effTs = parseIsoDateMs(e.effectiveDate); // валидировано фазой 1 — не null
        for (const lot of lotsOf(e.mint)) {
          if (!heldBefore(lot, effTs, e)) continue; // лот после обмена не конвертируется
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
        // выкуп закрывает позицию на дату выкупа: реализуются и удаляются только лоты,
        // купленные строго раньше (лот с датой после события не выдуманно не уничтожается)
        const effTs = parseIsoDateMs(e.effectiveDate); // валидировано фазой 1 — не null
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
