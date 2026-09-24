// Property tests of the FIFO engine of the report (buildWalletReport, src/wallet/report.mjs).
//
// A NOTE ON SCOPE: formally the assignment names src/lots/lots.mjs, but that is the engine
// of corporate actions (SPLIT/MERGER/REDEEM/...) — there are no buy/sell operations there.
// The FIFO engine of buys/sells lives in src/wallet/report.mjs (buildWalletReport);
// its contract and pins of the actual behavior — "Group 3. The FIFO engine of the report"
// in test/wallet-edge.test.mjs and the FIFO tests in test/wallet.test.mjs. The coverage below —
// over that engine.
//
// Method: a seeded PRNG (mulberry32, dependency-free) generates 200 scenarios
// of 5–40 buy/sell/zero-qty operations: BigInt quantities 1..1000n, monotonic
// times; ~25% of sells — a targeted overdraft of the balance (the engine eats the shortage as a gap).
//
// The actual overdraft semantics pinned in wallet-edge ("an overdraft after a
// partial sale — a gap = the shortage", buy 100 → sell 40 → sell 80: lots=0,
// realized=100, gap=20):
//   sold     = realized + gap;
//   bought   = realized + live lots;
//   netDelta = bought − sold (it may be negative — by design);
//   bought − sold + gap = live lots.
//
// Invariants (on every scenario, BigInt-exact):
//   1. conservation: the three forms above + netDelta + the derived complete;
//   2. non-negativity of all quantities; there are no zero lots in the queue
//      (netDelta may be negative — the documented semantics of the window);
//   3. FIFO: the surviving lots — a continuous increasing suffix of purchase numbers,
//      ending with the last purchase; all lots except, possibly, the first —
//      untouched (qty and acquiredDate equal the original purchase); a lot's date —
//      always the date of its purchase;
//   4. a trace of every sell: gaps ≤ nSells ≤ realizedCount + |gaps|;
//      realizedCount>0 ⇔ realizedQty>0; gaps > 0, the gap dates — from sells;
//   5. zero-qty operations do not change the state: removing them from the stream gives
//      the same tokens (deep-equal);
//   6. determinism: the seed is a constant; a repeated run — an identical JSON;
//      on a failure the assert prints the seed, the scenario number and the whole sequence.
//
// If an invariant catches an engine bug — src is NOT edited: the sequence
// is minimized and recorded as an explicit regression case at the bottom of this file
// (see the template at the tail; there are no found bugs now — the section is empty).
import test from "node:test";
import assert from "node:assert/strict";
import { buildWalletReport } from "../src/wallet/report.mjs";

// ---------------------------------------------------------------------------
// The seeded PRNG (mulberry32) and the scenario generator
// ---------------------------------------------------------------------------

const SEED = 0x1a7be3f; // a constant: on an invariant failure the scenario is reproducible

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// strictly base58-like mints without "-" (a lot id = `${mint}-<purchase #>`)
const MINTS = [
  "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
  "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
];
const OWNER = "PropertyFuzz" + "a".repeat(31);

const REG = [
  { mint: MINTS[0], symbol: "TSLAx", name: "Tesla xStock", decimals: 8 },
  { mint: MINTS[1], symbol: "AAPLx", name: "Apple xStock", decimals: 8 },
];

const rndInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const isoOf = (blockTime) => new Date(blockTime * 1000).toISOString();

// A scenario: 1–2 mints, 5–40 buy/sell/zero-qty operations, monotonic times.
// op.over = a targeted overdraft (a sell larger than the current window balance).
function makeScenario(index, rng) {
  const nMints = rng() < 0.5 ? 1 : 2;
  const first = Math.floor(rng() * MINTS.length);
  const mintList = nMints === 2 ? [first, 1 - first] : [first];
  const nOps = rndInt(rng, 5, 40);
  let t = 1_700_000_000 + index;
  const bal = new Array(nMints).fill(0n); // the current net window balance per mint
  const ops = [];
  for (let i = 0; i < nOps; i++) {
    const mintIdx = Math.floor(rng() * mintList.length);
    const r = rng();
    const kind = r < 0.08 ? "zero" : r < 0.58 ? "buy" : "sell";
    let qty = 0n;
    let over = false;
    if (kind === "buy") {
      qty = BigInt(rndInt(rng, 1, 1000));
    } else if (kind === "sell") {
      // 25% of sells — a guaranteed overdraft: the balance + a tail (the engine eats it as a gap)
      if (bal[mintIdx] > 0n && rng() < 0.25) {
        qty = bal[mintIdx] + BigInt(rndInt(rng, 1, 500));
        over = true;
      } else {
        qty = BigInt(rndInt(rng, 1, 1000));
      }
    }
    t += rndInt(rng, 1, 7200); // monotonic time, strictly increasing
    ops.push({ mintIdx, kind, qty, over, blockTime: t });
    if (kind === "buy") bal[mintIdx] += qty;
    else if (kind === "sell") bal[mintIdx] -= qty;
  }
  return { index, mintList, ops };
}

const RNG = mulberry32(SEED);
const SCENARIOS = Array.from({ length: 200 }, (_, i) => makeScenario(i, RNG));

// ---------------------------------------------------------------------------
// Running a scenario through the engine and an independent model from the generator's operations
// ---------------------------------------------------------------------------

const deltaRawOf = (op) => (op.kind === "buy" ? op.qty : op.kind === "sell" ? -op.qty : 0n);

const opsToTxs = (sc) =>
  sc.ops.map((op, i) => ({
    signature: `sig-${sc.index}-${i}`,
    slot: i + 1,
    blockTime: op.blockTime,
    deltas: [{ owner: OWNER, mint: MINTS[sc.mintList[op.mintIdx]], preRaw: 0n, postRaw: 0n, deltaRaw: deltaRawOf(op) }],
  }));

const scanOf = (txs) => ({
  owner: OWNER, signatures: txs.length, fetched: txs.length, txs, skipped: [], truncated: false, accounts: {},
});

// now is fixed: buildWalletReport by default sets new Date().toISOString()
// (an opts parameter, not engine determinism); with a fixed now the report is a pure
// function of the scan.
const NOW = "2026-09-22T00:00:00.000Z";
const reportOf = (sc) => buildWalletReport(scanOf(opsToTxs(sc)), { registry: REG, now: NOW });

// The model is computed ONLY from the generated operations (it does not repeat the FIFO logic):
// the bought/sold aggregates, the purchase list in queue order (these are the future
// lots with numbers 1..nBuys) and the set of sell dates.
function modelOf(sc) {
  const per = new Map();
  for (const op of sc.ops) {
    const mint = MINTS[sc.mintList[op.mintIdx]];
    let m = per.get(mint);
    if (!m) per.set(mint, (m = { bought: 0n, sold: 0n, nBuys: 0, nSells: 0, buys: [], sells: [] }));
    if (op.kind === "buy") {
      m.bought += op.qty;
      m.nBuys += 1;
      m.buys.push({ qty: op.qty, iso: isoOf(op.blockTime) });
    } else if (op.kind === "sell") {
      m.sold += op.qty;
      m.nSells += 1;
      m.sells.push(isoOf(op.blockTime));
    }
  }
  return per;
}

// The failure context: the seed + the scenario number + the whole operation sequence —
// a failure is reproducible unambiguously.
const fmtOps = (sc) =>
  JSON.stringify(sc.ops.map((o, i) => ({ n: i, mint: o.mintIdx, op: o.kind, qty: o.qty.toString(), over: o.over, t: o.blockTime })));
const ctx = (sc, extra = "") => `seed=${SEED} scenario #${sc.index} ${extra}\noperations: ${fmtOps(sc)}`;

const rowOf = (rep, mint) => rep.tokens.find((t) => t.mint === mint);
const sumLots = (row) => row.lots.reduce((a, l) => a + BigInt(l.qtyRaw), 0n);
const sumGaps = (row) => row.gaps.reduce((a, g) => a + BigInt(g.missingQtyRaw), 0n);

// ---------------------------------------------------------------------------
// 0. Generator sanity: monotonic times, sizes, the coverage is not a vacuum
// ---------------------------------------------------------------------------

test(`generator: 200 scenarios of 5–40 operations, the times are monotonic (seed=${SEED})`, () => {
  assert.equal(SCENARIOS.length, 200);
  for (const sc of SCENARIOS) {
    assert.ok(sc.ops.length >= 5 && sc.ops.length <= 40, ctx(sc));
    for (let i = 1; i < sc.ops.length; i++) {
      assert.ok(sc.ops[i].blockTime > sc.ops[i - 1].blockTime, `the times are strictly monotonic\n${ctx(sc)}`);
    }
    for (const op of sc.ops) {
      if (op.kind === "zero") assert.equal(op.qty, 0n, ctx(sc));
      else if (op.over) assert.ok(op.qty >= 1n && op.qty <= 41_000n, `a targeted overdraft ≤ maxBal(40×1000)+500\n${ctx(sc)}`);
      else assert.ok(op.qty >= 1n && op.qty <= 1000n, `base quantities 1..1000\n${ctx(sc)}`);
    }
  }
});

test(`the coverage is not a vacuum: gaps, realizations, overdrafts, zero-ops really occur (seed=${SEED})`, (t) => {
  let gapScen = 0;
  let realizedScen = 0;
  let overshootOps = 0;
  let negativeNet = 0;
  let multiMint = 0;
  let zeroOps = 0;
  let totalOps = 0;
  for (const sc of SCENARIOS) {
    totalOps += sc.ops.length;
    const rep = reportOf(sc);
    if (rep.tokens.some((t) => t.gaps.length > 0)) gapScen += 1;
    if (rep.tokens.some((t) => t.realizedCount > 0)) realizedScen += 1;
    if (rep.tokens.some((t) => BigInt(t.netDeltaRaw) < 0n)) negativeNet += 1;
    if (sc.mintList.length === 2) multiMint += 1;
    overshootOps += sc.ops.filter((o) => o.over).length;
    zeroOps += sc.ops.filter((o) => o.kind === "zero").length;
  }
  const summary =
    `seed=${SEED}: operations=${totalOps}; scenarios with gaps=${gapScen}, with realization=${realizedScen}, ` +
    `with a negative netDelta=${negativeNet}, multi-mint=${multiMint}, ` +
    `targeted overdrafts=${overshootOps}, zero-ops=${zeroOps}`;
  t.diagnostic(summary); // the coverage summary is visible on a green run too
  assert.ok(
    gapScen >= 1 && realizedScen >= 1 && negativeNet >= 1 && multiMint >= 1 && overshootOps >= 20 && zeroOps >= 20,
    `the generator must cover all engine branches, not only the happy path\n${summary}`,
  );
});

// ---------------------------------------------------------------------------
// 1. Conservation: bought = realized + live lots; sold = realized + gap;
//    netDelta = bought − sold; complete is derived from the gaps and the reconcile
// ---------------------------------------------------------------------------

test("conservation: bought/sold/gap/lots converge BigInt-exactly in every scenario", () => {
  for (const sc of SCENARIOS) {
    const rep = reportOf(sc);
    for (const [mint, m] of modelOf(sc)) {
      const row = rowOf(rep, mint);
      const hasFlow = m.bought > 0n || m.sold > 0n;
      assert.equal(row !== undefined, hasFlow, `a token row exists ⇔ there was a non-zero delta\n${ctx(sc, mint)}`);
      if (!row) continue;
      const lotsSum = sumLots(row);
      const realizedQty = BigInt(row.realizedQtyRaw);
      const gapQty = sumGaps(row);
      assert.equal(realizedQty + gapQty, m.sold, `sold = realized + gap\n${ctx(sc, mint)}`);
      assert.equal(realizedQty + lotsSum, m.bought, `bought = realized + live lots\n${ctx(sc, mint)}`);
      assert.equal(m.bought - m.sold + gapQty, lotsSum, `conservation: bought − sold + gap = live lots\n${ctx(sc, mint)}`);
      assert.equal(BigInt(row.netDeltaRaw), m.bought - m.sold, `netDelta = bought − sold\n${ctx(sc, mint)}`);
      assert.equal(BigInt(row.rawBalance), m.bought - m.sold, "rawBalance — a legacy alias of the same number");
      assert.ok(lotsSum <= m.bought && gapQty <= m.sold, `the lots and the gap do not exceed the flows\n${ctx(sc, mint)}`);
    }
    // accounts:{} → reconciles ⇔ netDelta 0; complete = no gaps and everything converged
    const expectComplete = rep.tokens.every((t) => t.gaps.length === 0 && BigInt(t.rawBalance) === 0n);
    assert.equal(rep.complete, expectComplete, `complete is derived: no gaps and a zero net\n${ctx(sc)}`);
  }
});

// ---------------------------------------------------------------------------
// 2. Non-negativity: the quantities are not negative, there are no zero lots;
//    netDelta may be negative (the documented semantics of the window)
// ---------------------------------------------------------------------------

test("non-negativity: lot qtys, gaps, the realization — strictly > 0 where they exist", () => {
  for (const sc of SCENARIOS) {
    const rep = reportOf(sc);
    for (const row of rep.tokens) {
      for (const lot of row.lots) {
        const q = BigInt(lot.qtyRaw); // garbage in the string would crash BigInt — also red
        assert.ok(q > 0n, `the queue has no zero lots or negative qtys\n${ctx(sc, row.mint)}`);
      }
      for (const g of row.gaps) {
        assert.ok(BigInt(g.missingQtyRaw) > 0n, `a gap — a positive shortage\n${ctx(sc, row.mint)}`);
      }
      const realizedQty = BigInt(row.realizedQtyRaw);
      assert.ok(realizedQty >= 0n, `the realization is non-negative\n${ctx(sc, row.mint)}`);
      assert.equal(row.realizedCount > 0, realizedQty > 0n, `the realization counter agrees with the quantity\n${ctx(sc, row.mint)}`);
      assert.ok(row.realizedCount >= 0 && Number.isInteger(row.realizedCount), ctx(sc, row.mint));
    }
  }
});

// ---------------------------------------------------------------------------
// 3. FIFO order: the surviving lots — a continuous suffix of purchases, the tail untouched,
//    a lot's date — the date of its purchase; only the head of the queue may be trimmed
// ---------------------------------------------------------------------------

test("FIFO: the surviving lots — a continuous suffix of purchases, the queue tail untouched", () => {
  for (const sc of SCENARIOS) {
    const rep = reportOf(sc);
    for (const [mint, m] of modelOf(sc)) {
      const row = rowOf(rep, mint);
      if (!row) continue; // no row ⇔ no non-zero operations (verified in "conservation")
      const seqs = row.lots.map((lot) => {
        assert.ok(lot.id.startsWith(`${mint}-`), `a lot id = mint-<purchase #>\n${ctx(sc, mint)}`);
        return Number(lot.id.slice(mint.length + 1));
      });
      for (let j = 0; j < seqs.length; j++) {
        assert.ok(seqs[j] >= 1 && seqs[j] <= m.nBuys, `the purchase number within 1..${m.nBuys}\n${ctx(sc, mint)}`);
        if (j > 0) assert.equal(seqs[j], seqs[j - 1] + 1, `the suffix of numbers is continuous (the FIFO eats from the front, leaves no holes)\n${ctx(sc, mint)}`);
      }
      if (seqs.length > 0) {
        assert.equal(seqs[seqs.length - 1], m.nBuys, `the last survivor — the latest purchase (#${m.nBuys})\n${ctx(sc, mint)}`);
      }
      for (let j = 0; j < seqs.length; j++) {
        const origin = m.buys[seqs[j] - 1]; // the purchase # → the generator operation
        assert.equal(row.lots[j].acquiredDate, origin.iso, `a lot's date = the date of its purchase\n${ctx(sc, mint)}`);
        const q = BigInt(row.lots[j].qtyRaw);
        if (j === 0) {
          assert.ok(q >= 1n && q <= origin.qty, `the head of the queue may be trimmed, but not more than its purchase\n${ctx(sc, mint)}`);
        } else {
          assert.equal(q, origin.qty, `the queue tail untouched: only the head is trimmed (FIFO)\n${ctx(sc, mint)}`);
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 4. A trace of every sell and the overdraft semantics (the gap)
// ---------------------------------------------------------------------------

test("overdraft: every sell leaves a trace, the gaps are honest and dated by sells", () => {
  for (const sc of SCENARIOS) {
    const rep = reportOf(sc);
    for (const [mint, m] of modelOf(sc)) {
      const row = rowOf(rep, mint);
      if (!row) continue;
      assert.ok(row.gaps.length <= m.nSells, `a gap — at most one per sell\n${ctx(sc, mint)}`);
      assert.ok(
        m.nSells <= row.realizedCount + row.gaps.length,
        `every sell leaves a trace: a realization or a gap\n${ctx(sc, mint)}`,
      );
      const sellIsos = new Set(m.sells);
      let prevDate = "";
      for (const g of row.gaps) {
        assert.ok(BigInt(g.missingQtyRaw) > 0n, ctx(sc, mint));
        assert.ok(sellIsos.has(g.date), `a gap's date — the date of some sell\n${ctx(sc, mint)}`);
        assert.ok(g.date >= prevDate, `the gaps are chronological (the stream is monotonic)\n${ctx(sc, mint)}`);
        prevDate = g.date;
      }
      if (row.gaps.length > 0) {
        assert.equal(rep.complete, false, `a gap makes the report incomplete (there is no truncation)\n${ctx(sc, mint)}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 5. Zero-qty operations do not change the state
// ---------------------------------------------------------------------------

test("zero-qty: removing the zero operations from the stream changes tokens in nothing", () => {
  for (const sc of SCENARIOS) {
    const withZeros = reportOf(sc).tokens;
    const filtered = { index: sc.index, mintList: sc.mintList, ops: sc.ops.filter((o) => o.kind !== "zero") };
    assert.deepEqual(reportOf(filtered).tokens, withZeros, `zero-qty — a no-op for the FIFO\n${ctx(sc)}`);
  }
});

// ---------------------------------------------------------------------------
// 6. Determinism: the same seed — the same report
// ---------------------------------------------------------------------------

test(`determinism: a repeated run of the first 25 scenarios — an identical JSON (seed=${SEED})`, () => {
  const snapshot = () => SCENARIOS.slice(0, 25).map((sc) => JSON.stringify(reportOf(sc)));
  const first = snapshot();
  assert.deepEqual(snapshot(), first, `seed=${SEED} must give byte-for-byte identical reports`);
});

// ===========================================================================
// Regression cases (the protocol): if a property invariant above catches an engine
// bug — src is NOT edited. The sequence is minimized to a small explicit
// case and recorded here by a test with the comment "found by a property test,
// seed=…, scenario #…, invariant …", pinning the ACTUAL behavior.
// There are no such cases now: all 200 scenarios × 6 invariant groups are green.
// ===========================================================================
