// Wallet report from a scan: FIFO lots, realized, scan gaps,
// adjusted position = raw × multiplier(now) via MultiplierTimeline.
// Pure function: no network, only scan data + registry + timelines.
//
// Balance semantics (honest names): rawBalance/netDeltaRaw is the NET DELTA of
// the SCAN WINDOW (Σ of tx deltas inside the window), not necessarily the on-chain balance: with
// an incomplete window (complete: false) it can be negative. The on-chain balance is
// onchainNow; the net delta equals it only when reconciles: true. The UI must
// label the field accordingly, not "raw balance (on-chain)".
//
// adjustedAvailable: the field is set ONLY as false — when there was no timeline for the mint
// and adjusted was computed as an identity fallback (scaled=raw); then agreement
// with raw does NOT prove the multiplier is 1 (e.g. an excluded token — a broken timeline).
// For tokens with a timeline the field is absent (adjusted was actually computed).
// The UI shows "adjusted not computed" when adjustedAvailable === false || excluded.
//
// Lots with acquiredDate: null (a tx without blockTime — a legitimate Solana reality)
// reach JSON as-is (see iso()), but are UNUSABLE for applyEvents: the event
// engine throws LotError "refusing to guess" on such a lot and, by atomicity,
// crashes the application of the ENTIRE history. The /lots consumer must filter such
// lots out or handle LotError; date semantics — see the header of src/lots/lots.mjs.
export class ReportError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "ReportError";
  }
}

const iso = (blockTime) => (typeof blockTime === "number" ? new Date(blockTime * 1000).toISOString() : null);

/**
 * @param {{owner:string, txs:Array, skipped:Array, truncated:boolean, signatures:number, fetched:number}} scan
 * @param {object} opts — registry (the registry), timelines (Map mint→MultiplierTimeline), now (ISO)
 * @returns the full report: per token raw balance, FIFO lots, realized, gaps, adjusted
 */
export function buildWalletReport(scan, { registry, timelines = new Map(), now = new Date().toISOString() }) {
  if (!scan || typeof scan !== "object" || !Array.isArray(scan.txs)) {
    throw new ReportError("scan must be a scanWallet result");
  }
  const byMint = new Map(registry.map((t) => [t.mint, t]));
  const owner = scan.owner;

  // per-mint state: queue of open lots, realized, gaps, raw balance
  const st = new Map(); // mint → {queue:[], realized:[], gaps:[], rawBalance:bigint, lotSeq:number}
  const stateOf = (mint) => {
    let s = st.get(mint);
    if (!s) {
      s = { queue: [], realized: [], gaps: [], rawBalance: 0n, lotSeq: 0 };
      st.set(mint, s);
    }
    return s;
  };

  // money legs the pricing did not consume: whatever did not land in a basis or in
  // proceeds is a FACT row — see the booking site in the loop below for the full contract
  const moneyOnly = [];

  for (const tx of scan.txs) {
    const date = iso(tx.blockTime);
    // other owners' deltas are untouched: scan by address — report by address
    const mine = tx.deltas.filter((d) => d.owner === owner && byMint.has(d.mint) && d.deltaRaw !== 0n);
    // a tracked mint touched with a zero net delta (a same-tx round-trip, a self-transfer
    // between own accounts): its spread shares the money leg with any trade of the same
    // tx, and the split is not recoverable from the balances — such a tx is not priced
    const zeroNetTouched = Array.isArray(tx.zeroNetMints) && tx.zeroNetMints.some((z) => z.owner === owner);

    // the money leg prices the trade. Net USDC delta of THIS owner in THIS tx;
    // the pricing rule is deliberately narrow — exactly one tracked token moved against
    // a counter-directed USDC leg, and nothing else tracked was touched. Several tracked
    // tokens in one tx would require guessing the allocation, a missing leg is a transfer,
    // not a trade — both are honestly unknown.
    const usdc = (tx.moneyDeltas ?? []).reduce((acc, m) => (m.owner === owner ? acc + m.deltaRaw : acc), 0n);
    const buys = mine.filter((d) => d.deltaRaw > 0n);
    const sells = mine.filter((d) => d.deltaRaw < 0n);
    // the rule is EXACTLY ONE tracked token in the tx (mine.length === 1) with a clean
    // money leg — a mixed sell-A/buy-B swap prices NEITHER leg: the net USDC of a
    // two-legged swap is nobody's basis (README: several tracked tokens — honestly unknown).
    const buyBasis = mine.length === 1 && !zeroNetTouched && buys.length === 1 && usdc < 0n ? -usdc : null;
    const sellProceeds = mine.length === 1 && !zeroNetTouched && sells.length === 1 && usdc > 0n ? usdc : null;

    // money legs the pricing did not consume — a same-tx round-trip's spread (alone, or
    // mixed with a trade whose pricing was withdrawn rather than guessed), the USDC fee
    // of a multi-token swap, or a plain USDC transfer. The report cannot tell these
    // causes apart and does not guess: a row is the FACT — signature, date, money mint,
    // signed net per mint (distinct mints are never merged). Deliberately NOT lots and
    // NOT gaps: FIFO math is untouched (a zero token delta is no lot), and completeness
    // is a certificate about lot history, not about the money ledger. Fail-closed both
    // ways: a legacy scan without moneyDeltas yields no rows, and a zero NET leg (money
    // that only moved between the owner's own accounts) yields no row either.
    if (buyBasis === null && sellProceeds === null && Array.isArray(tx.moneyDeltas)) {
      const net = new Map();
      for (const m of tx.moneyDeltas) {
        if (m.owner !== owner) continue;
        net.set(m.mint, (net.get(m.mint) ?? 0n) + m.deltaRaw);
      }
      for (const [mint, amount] of net) {
        if (amount !== 0n) moneyOnly.push({ signature: tx.signature, date, mint, amountRaw: String(amount) });
      }
    }
    if (mine.length === 0) continue;

    for (const d of mine) {
      const s = stateOf(d.mint);
      s.rawBalance += d.deltaRaw;
      if (d.deltaRaw > 0n) {
        // id = full mint + _seq: a 6-char prefix collides across different mints
        // (the fuzzer caught identical ids), while mint is unique by construction. Technical
        // field — length is not critical, and there are no collisions by construction.
        s.queue.push({
          id: `${d.mint}-${++s.lotSeq}`,
          qtyRaw: d.deltaRaw,
          acquiredDate: date,
          basis: buyBasis,
          basisKnown: buyBasis !== null,
        });
      } else {
        let due = -d.deltaRaw;
        const due0 = due; // the FULL size of the sale — the proceeds pool is shared by every piece and the gap
        const pieces = [];
        while (due > 0n && s.queue.length > 0) {
          const lot = s.queue[0];
          const pre = lot.qtyRaw;
          const take = pre < due ? pre : due;
          lot.qtyRaw -= take;
          due -= take;
          // basis transfers out proportionally (BigInt trunc); the lot's own trunc remainder
          // rides the piece that closes it — Σ(open lot basis) + Σ(realized basis) is exact
          let basisPiece = null;
          if (lot.basisKnown) basisPiece = (lot.basis * take) / pre;
          let proceedsPiece = null;
          if (sellProceeds !== null) proceedsPiece = (sellProceeds * take) / due0;
          pieces.push({
            date,
            qtyRaw: take,
            basis: basisPiece,
            basisKnown: basisPiece !== null,
            proceeds: proceedsPiece,
            proceedsKnown: sellProceeds !== null,
            pnl: basisPiece !== null && proceedsPiece !== null ? proceedsPiece - basisPiece : null,
          });
          if (lot.qtyRaw === 0n) {
            // the lot's trunc remainder (basis − what this piece already took) rides the closing piece
            if (lot.basisKnown) pieces[pieces.length - 1].basis += lot.basis - basisPiece;
            s.queue.shift();
          } else if (lot.basisKnown) {
            lot.basis -= basisPiece;
          }
        }
        // the proceeds trunc remainder rides the last covered piece — but ONLY when the
        // sale was fully covered; with a gap, the remainder is the gap piece's own share
        if (sellProceeds !== null && pieces.length > 0 && due === 0n) {
          const given = pieces.reduce((a, p) => a + p.proceeds, 0n);
          const rem = sellProceeds - given;
          if (rem !== 0n) {
            const last = pieces[pieces.length - 1];
            last.proceeds += rem;
            if (last.pnl !== null) last.pnl = last.proceeds - last.basis;
          }
        }
        s.realized.push(...pieces);
        if (due > 0n) {
          // spend without coverage: the owner already held a position before the scan window started —
          // it is not zero and not an invented lot, it is a hole with a date and a size.
          // Its proceeds share is real money (the sale did receive it) and is booked here,
          // never into a covered piece; its basis is unknown by construction.
          const hole = { date, missingQtyRaw: due };
          if (sellProceeds !== null) {
            hole.proceeds = sellProceeds - pieces.reduce((a, p) => a + p.proceeds, 0n);
          }
          s.gaps.push(hole);
        }
      }
    }
  }

  const tokens = [];
  // reconciliation with the chain: accounts from the scan (Map or object); no account = balance must be 0
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
    const row = {
      symbol: t.symbol,
      name: t.name,
      mint,
      decimals: t.decimals,
      rawBalance: String(s.rawBalance), // legacy name; the value is the net delta of the window (see netDeltaRaw)
      netDeltaRaw: String(s.rawBalance), // honest name of the same number: Σ of window deltas, not a balance
      onchainNow, // the actual on-chain balance right now — separate from the window's net delta
      reconciles, // scan deltas agree with the live chain balance — the main sign of honesty
      multiplier: { now: mult, events: tl ? tl.steps.length - 1 : 0 },
      // BigInt is not JSON-serializable — strings go out
      adjusted: {
        exact: scaled.exact,
        whole: String(scaled.whole),
        remainder: String(scaled.remainder),
        den: String(scaled.den),
      },
      lots: s.queue.map((l) => ({
        id: l.id,
        qtyRaw: String(l.qtyRaw),
        acquiredDate: l.acquiredDate,
        // basis: known only when the lot was bought against a USDC leg;
        // a transfer-in or a multi-token tx stays honestly null — never an invented 0
        basisRaw: l.basisKnown ? String(l.basis) : null,
        basisKnown: l.basisKnown,
      })),
      realized: s.realized.map((r) => ({
        date: r.date,
        qtyRaw: String(r.qtyRaw),
        basisRaw: r.basis !== null ? String(r.basis) : null,
        basisKnown: r.basisKnown,
        proceedsRaw: r.proceeds !== null ? String(r.proceeds) : null,
        proceedsKnown: r.proceedsKnown,
        pnlRaw: r.pnl !== null ? String(r.pnl) : null, // proceeds − basis; null when either side is unknown
      })),
      realizedCount: s.realized.length,
      realizedQtyRaw: String(s.realized.reduce((acc, r) => acc + r.qtyRaw, 0n)),
      gaps: s.gaps.map((g) => ({
        date: g.date,
        missingQtyRaw: String(g.missingQtyRaw),
        ...(g.proceeds !== undefined ? { proceedsRaw: String(g.proceeds) } : {}), // the gap piece's own sale share
      })),
    };
    // honest flag only on the fallback branch: absence of the field = adjusted was computed
    if (!tl) row.adjustedAvailable = false; // identity-fallback (see the header): adjusted==raw is unproven
    tokens.push(row);
  };

  for (const [mint, s] of st) pushToken(mint, s);
  // the token exists on-chain but has no deltas: the balance predates the scan window — shown, not hidden
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
    truncated: Boolean(scan.truncated), // the scan window was cut by the cap — lots may not be fully covered
    ...(scan.ambiguousSlotPairs
      ? { ambiguousSlotPairs: scan.ambiguousSlotPairs } // same-slot pairs whose ledger order the RPC cannot tell apart (two sources) — the order in txs is a deterministic guess
      : {}),
    // money legs the pricing did not consume: a round-trip spread (also one mixed with a
    // trade), a USDC fee of a multi-token swap, a USDC transfer; the report does not guess
    // which. Absent field = none seen in this window (a legacy scan without money legs
    // cannot see them — re-scan for the money view).
    ...(moneyOnly.length > 0 ? { moneyOnly } : {}),
    complete: !scan.truncated && !hasGaps && allReconcile && !scan.ambiguousSlotPairs, // a guessed order is not a certified history
    tokens,
  };
}
