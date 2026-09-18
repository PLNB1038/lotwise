// Отчёт по кошельку из скана: FIFO-лоты, реализация, гэпы скана,
// скорректированная позиция = raw × множитель(now) через MultiplierTimeline.
// Чистая функция: никакой сети, только данные скана + реестр + таймлайны.
export class ReportError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "ReportError";
  }
}

const iso = (blockTime) => (typeof blockTime === "number" ? new Date(blockTime * 1000).toISOString() : null);

/**
 * @param {{owner:string, txs:Array, skipped:Array, truncated:boolean, signatures:number, fetched:number}} scan
 * @param {object} opts — registry (реестр), timelines (Map mint→MultiplierTimeline), now (ISO)
 * @returns полный отчёт: по токену raw-баланс, лоты FIFO, реализация, гэпы, adjusted
 */
export function buildWalletReport(scan, { registry, timelines = new Map(), now = new Date().toISOString() }) {
  if (!scan || typeof scan !== "object" || !Array.isArray(scan.txs)) {
    throw new ReportError("scan must be a scanWallet result");
  }
  const byMint = new Map(registry.map((t) => [t.mint, t]));
  const owner = scan.owner;

  // состояние по минтам: очередь открытых лотов, реализация, гэпы, raw-баланс
  const st = new Map(); // mint → {queue:[], realized:[], gaps:[], rawBalance:bigint, lotSeq:number}
  const stateOf = (mint) => {
    let s = st.get(mint);
    if (!s) {
      s = { queue: [], realized: [], gaps: [], rawBalance: 0n, lotSeq: 0 };
      st.set(mint, s);
    }
    return s;
  };

  for (const tx of scan.txs) {
    const date = iso(tx.blockTime);
    // дельты чужих владельцев не трогаем: скан по адресу — отчёт по адресу
    const mine = tx.deltas.filter((d) => d.owner === owner && byMint.has(d.mint) && d.deltaRaw !== 0n);
    for (const d of mine) {
      const s = stateOf(d.mint);
      s.rawBalance += d.deltaRaw;
      if (d.deltaRaw > 0n) {
        s.queue.push({ id: `${d.mint.slice(0, 6)}-${++s.lotSeq}`, qtyRaw: d.deltaRaw, acquiredDate: date });
      } else {
        let due = -d.deltaRaw;
        while (due > 0n && s.queue.length > 0) {
          const lot = s.queue[0];
          const take = lot.qtyRaw < due ? lot.qtyRaw : due;
          lot.qtyRaw -= take;
          due -= take;
          s.realized.push({ qtyRaw: take, date });
          if (lot.qtyRaw === 0n) s.queue.shift();
        }
        if (due > 0n) {
          // расход без покрытия: до начала окна скана у владельца уже была позиция —
          // это не ноль и не выдуманный лот, это дыра с датой и размером
          s.gaps.push({ date, missingQtyRaw: due });
        }
      }
    }
  }

  const tokens = [];
  // сверка с цепью: аккаунты из скана (Map или объект); нет аккаунта = баланс должен быть 0
  const accts = scan.accounts instanceof Map ? Object.fromEntries(scan.accounts) : (scan.accounts ?? {});
  const seenMints = new Set(st.keys());

  const pushToken = (mint, s) => {
    const t = byMint.get(mint);
    const tl = timelines.get(mint) ?? null;
    const mult = tl ? tl.multiplierAt(now) : "1";
    const scaled = tl
      ? tl.scaledQty(s.rawBalance, now)
      : { whole: s.rawBalance, remainder: 0n, den: 1n, exact: true };
    const acct = accts[mint];
    const onchainNow = acct ? String(acct.currentRaw) : "0";
    const reconciles = acct ? s.rawBalance === BigInt(acct.currentRaw) : s.rawBalance === 0n;
    tokens.push({
      symbol: t.symbol,
      name: t.name,
      mint,
      decimals: t.decimals,
      rawBalance: String(s.rawBalance),
      onchainNow,
      reconciles, // дельты скана сходятся с живым балансом цепи — главный знак честности
      multiplier: { now: mult, events: tl ? tl.steps.length - 1 : 0 },
      // BigInt в JSON не сериализуется — наружу строками
      adjusted: {
        exact: scaled.exact,
        whole: String(scaled.whole),
        remainder: String(scaled.remainder),
        den: String(scaled.den),
      },
      lots: s.queue.map((l) => ({ ...l, qtyRaw: String(l.qtyRaw) })),
      realizedCount: s.realized.length,
      realizedQtyRaw: String(s.realized.reduce((acc, r) => acc + r.qtyRaw, 0n)),
      gaps: s.gaps.map((g) => ({ ...g, missingQtyRaw: String(g.missingQtyRaw) })),
    });
  };

  for (const [mint, s] of st) pushToken(mint, s);
  // токен есть на цепи, но дельт нет: баланс старее окна скана — показываем, не прячем
  for (const mint of Object.keys(accts)) {
    if (seenMints.has(mint)) continue;
    pushToken(mint, { queue: [], realized: [], gaps: [], rawBalance: 0n, lotSeq: 0 });
  }
  tokens.sort((a, b) => (b.lots.length + b.realizedCount) - (a.lots.length + a.realizedCount) || a.symbol.localeCompare(b.symbol));

  const hasGaps = tokens.some((t) => t.gaps.length > 0);
  const allReconcile = tokens.every((t) => t.reconciles);
  return {
    owner,
    method: "fifo",
    now,
    counts: {
      signatures: scan.signatures,
      fetched: scan.fetched,
      relevantTxs: scan.txs.length,
      skipped: scan.skipped.length,
    },
    truncated: Boolean(scan.truncated), // окно скана обрезано потолком — лоты могли не покрыться
    complete: !scan.truncated && !hasGaps && allReconcile,
    tokens,
  };
}
