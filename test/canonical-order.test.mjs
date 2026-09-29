// Canonical order of event application.
// applyEvents used to consume events in array order: the same facts fed in a different
// order produced a different report (a same-day split+dividend accrued
// 2e15 or 1e15 depending on the feed). The engine now sorts events itself, and these
// tests pin the contract: any permutation of the same event array yields the same lots,
// accruals, realized and symbolMap — byte-identical, not just economically equal.
import test from "node:test";
import assert from "node:assert/strict";
import { applyEvents } from "../src/lots/lots.mjs";

const MINT = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"; // TSLAx
const MINT2 = "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp"; // AAPLx
const MINT3 = "XsMeRger9999AbcdeFghjkmnpqrstuvwxyzAAAA"; // a merger target
const OWNER = "9BB7Tt5uW5QbAorLkF3Hn1P2mGcXvcDdR7y8LbT9KdUu";
const OWNER2 = "Ho5371KcABCDMN2e9gFyqiLtzfXyF1f2hKwPqRSUVwCd";

const lot = (over = {}) => ({
  id: "L1",
  mint: MINT,
  owner: OWNER,
  qtyRaw: 1_000_000n,
  acquiredDate: "2026-06-01",
  basisRaw: 250_000_000n,
  ...over,
});

const ev = (over = {}) => ({
  type: "SPLIT",
  mint: MINT,
  effectiveDate: "2026-06-18",
  status: "confirmed",
  sources: ["https://issuer.example/x"],
  ratioNumerator: 2,
  ratioDenominator: 1,
  ...over,
});

const div = (over = {}) => ev({
  type: "DIVIDEND_ACCRUAL", amountPerUnitRaw: 10, decimals: 6, ...over,
});

test("same-day SPLIT + DIVIDEND: both feed orders give the one split-first answer", () => {
  const splitFirst = applyEvents([lot()], [
    ev({ ratioNumerator: 2, ratioDenominator: 1 }),
    div({}),
  ]);
  const dividendFirst = applyEvents([lot()], [
    div({}),
    ev({ ratioNumerator: 2, ratioDenominator: 1 }),
  ]);
  // the pinned answer (lots.test "the dividend on the NEW qty"): 10 × 2,000,000
  assert.equal(splitFirst.accruals[0].totalRaw, 10n * 2_000_000n);
  assert.deepEqual(dividendFirst.accruals, splitFirst.accruals);
  assert.deepEqual(dividendFirst.lots, splitFirst.lots);
});

test("cross-day inversion: [div Jun 19, split Jun 18] equals the chronological feed", () => {
  const chrono = applyEvents([lot()], [
    ev({ effectiveDate: "2026-06-18" }),
    div({ effectiveDate: "2026-06-19" }),
  ]);
  const inverted = applyEvents([lot()], [
    div({ effectiveDate: "2026-06-19" }),
    ev({ effectiveDate: "2026-06-18" }),
  ]);
  assert.equal(chrono.accruals[0].totalRaw, 10n * 2_000_000n);
  assert.deepEqual(inverted.accruals, chrono.accruals);
  assert.deepEqual(inverted.lots, chrono.lots);
});

test("same slot, same type: two dividends of one day report in one order under any feed order", () => {
  // a different per-unit amount is a different dividend — both accrue (pinned in lots.test);
  // the fix under test: the REPORT order of the pair stops following the feed's luck
  const a = applyEvents([lot()], [div({ amountPerUnitRaw: 2 }), div({ amountPerUnitRaw: 3 })]);
  const b = applyEvents([lot()], [div({ amountPerUnitRaw: 3 }), div({ amountPerUnitRaw: 2 })]);
  assert.equal(a.accruals.length, 2);
  assert.deepEqual(a.accruals, b.accruals);
  assert.equal(a.accruals[0].amountPerUnitRaw, 2n); // canonical: ascending per-unit amount
  assert.equal(a.accruals[1].amountPerUnitRaw, 3n);
});

test("a dedup twin differing only in unranked metadata — the survivor ignores the feed order", () => {
  // the dedup rank covers decimals/sources/status; `reason` is unranked — with an
  // array-order survivor the embedded event (and its reason) depended on the feed
  const a = applyEvents([lot()], [div({ amountPerUnitRaw: 7, reason: "press page" }), div({ amountPerUnitRaw: 7, reason: "api node" })]);
  const b = applyEvents([lot()], [div({ amountPerUnitRaw: 7, reason: "api node" }), div({ amountPerUnitRaw: 7, reason: "press page" })]);
  assert.equal(a.accruals.length, 1, "one identity — one accrual");
  assert.deepEqual(a.accruals, b.accruals);
});

test("two TICKER_CHANGEs of one day — the symbol map is byte-identical under any feed order", () => {
  const t = (oldSymbol, newSymbol) => ev({ type: "TICKER_CHANGE", oldSymbol, newSymbol });
  const a = applyEvents([lot()], [t("TSLAx", "TSLA2x"), t("TSLA2x", "TSLA3x")]);
  const b = applyEvents([lot()], [t("TSLA2x", "TSLA3x"), t("TSLAx", "TSLA2x")]);
  assert.deepEqual(a.symbolMap, b.symbolMap);
  // object key order is the insertion order — a JSON report must not follow the feed
  assert.equal(JSON.stringify(a.symbolMap), JSON.stringify(b.symbolMap));
  assert.deepEqual(a.lots, b.lots);
});

test("the canonical order is the engine's inner business: the caller's array is not reordered", () => {
  const feed = [div({}), ev({})];
  applyEvents([lot()], feed);
  assert.deepEqual(feed.map((e) => e.type), ["DIVIDEND_ACCRUAL", "SPLIT"]);
});

test("property: a same-day SPLIT+DIV+MERGER cluster plus cross-day pairs — 20 permutations, one report", () => {
  const events = [
    ev({ effectiveDate: "2026-06-18" }), // SPLIT M1 2/1
    div({ effectiveDate: "2026-06-18" }), // on the split's day — post-split base
    ev({ type: "MERGER", effectiveDate: "2026-06-18", newMint: MINT3, exchangeNumerator: 5, exchangeDenominator: 2 }),
    ev({ type: "REDEEM", mint: MINT3, effectiveDate: "2026-06-19" }), // realizes the converted lots
    ev({ mint: MINT2, effectiveDate: "2026-06-17", ratioNumerator: 1, ratioDenominator: 4 }), // reverse split
    div({ mint: MINT2, effectiveDate: "2026-06-19", amountPerUnitRaw: 25 }), // cross-day inversion with it
    div({ effectiveDate: "2026-06-18", sources: ["https://api.issuer.example/node"] }), // a dedup twin
    ev({ type: "TICKER_CHANGE", oldSymbol: "TSLAx", newSymbol: "TSLA2x" }),
    ev({ type: "MULTIPLIER_CHANGE", effectiveDate: "2026-06-19", multiplierFrom: "1", multiplierTo: "1.005" }),
  ];
  const lots = [
    lot(),
    lot({ id: "L2", owner: OWNER2, qtyRaw: 2_000_000n }),
    lot({ id: "L3", mint: MINT2, qtyRaw: 4_000_000n }),
  ];
  const reference = applyEvents(lots, events);
  for (let i = 0; i < 20; i++) {
    const permuted = applyEvents(lots, shuffled(events));
    assert.deepEqual(permuted, reference, `permutation ${i} diverged`);
  }
  // and the reference itself carries the pinned economics: the dividend on the NEW qty
  assert.equal(
    reference.accruals.find((a) => a.mint === MINT && a.owner === OWNER).totalRaw,
    10n * 2_000_000n,
  );
});

// ---- the 200-scenario permutation harness ----

// a seeded xorshift32 — the property must be reproducible: a flaky generator is a quiet lie
let seed = 1;
const rnd = (n) => {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return (seed >>> 0) % n;
};

const shuffled = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const DAY_POOL = ["2026-06-17", "2026-06-18", "2026-06-19", "2026-06-20"];
// ratios made of 2s and 5s only: a qty of 10^16 (2^16·5^16) survives any short chain of
// them without dust, so a scenario aborts on nothing and the property stays substantive
const SMOOTH = [[2, 1], [1, 2], [4, 1], [1, 4], [5, 1], [1, 5], [5, 2], [2, 5], [10, 1], [1, 10]];
const DAY = () => DAY_POOL[rnd(DAY_POOL.length)];
const AMOUNT = () => 100 + rnd(900_000);
const SMOOTH_PAIR = () => SMOOTH[rnd(SMOOTH.length)];

let feedNo = 0;
const scenarioEvent = (over = {}) => ({
  type: "SPLIT",
  mint: MINT,
  effectiveDate: "2026-06-18",
  status: rnd(4) === 0 ? "unverified" : "confirmed",
  sources: [`https://issuer.example/feed/${++feedNo}/${rnd(1e9)}`],
  ratioNumerator: 2,
  ratioDenominator: 1,
  ...over,
});

const randomScenario = (n) => {
  // re-seed per scenario: a failing set number n is reproducible on its own
  seed = (Math.imul(n + 1, 0x85ebca6b) ^ 0x9e3779b9) >>> 0 || 1;
  const events = [];

  // the s2c cluster: a SPLIT and a DIVIDEND_ACCRUAL sharing a day half of the time
  const splitDay = DAY();
  const [sn, sd] = SMOOTH_PAIR();
  events.push(scenarioEvent({ effectiveDate: splitDay, ratioNumerator: sn, ratioDenominator: sd }));
  const divDay = rnd(2) === 0 ? splitDay : DAY();
  const amount = AMOUNT();
  const decimals = 2 + rnd(17);
  events.push(scenarioEvent({ type: "DIVIDEND_ACCRUAL", effectiveDate: divDay, amountPerUnitRaw: amount, decimals }));
  // a second sighting of the same dividend from another source (the dedup path)…
  if (rnd(2) === 0) {
    events.push(scenarioEvent({
      type: "DIVIDEND_ACCRUAL", effectiveDate: divDay, amountPerUnitRaw: amount, decimals,
      sources: [`https://api.issuer.example/node/${rnd(1e9)}`],
      reason: rnd(2) === 0 ? "press page" : "api node",
    }));
  }
  // …and a genuinely different dividend of the same day — both accrue (pinned in lots.test)
  if (rnd(2) === 0) {
    events.push(scenarioEvent({
      type: "DIVIDEND_ACCRUAL", effectiveDate: divDay,
      amountPerUnitRaw: amount + 1 + rnd(5_000), decimals,
    }));
  }
  if (rnd(2) === 0) {
    const [mn, md] = SMOOTH_PAIR();
    events.push(scenarioEvent({ type: "MERGER", effectiveDate: DAY(), newMint: MINT3, exchangeNumerator: mn, exchangeDenominator: md }));
  }
  // the M2 side: a redeem and a dividend sharing a day half of the time (DIV → REDEEM),
  // plus a split landing before or after either (cross-day inversions)
  const m2DivDay = DAY();
  events.push(scenarioEvent({ type: "DIVIDEND_ACCRUAL", mint: MINT2, effectiveDate: m2DivDay, amountPerUnitRaw: AMOUNT(), decimals: 2 + rnd(17) }));
  if (rnd(2) === 0) {
    events.push(scenarioEvent({ type: "REDEEM", mint: MINT2, effectiveDate: rnd(2) === 0 ? m2DivDay : DAY() }));
  }
  if (rnd(2) === 0) {
    const [sn2, sd2] = SMOOTH_PAIR();
    events.push(scenarioEvent({ mint: MINT2, effectiveDate: DAY(), ratioNumerator: sn2, ratioDenominator: sd2 }));
  }
  events.push(scenarioEvent({ type: "TICKER_CHANGE", effectiveDate: DAY(), oldSymbol: "TSLAx", newSymbol: "TSLA2x" }));
  if (rnd(2) === 0) events.push(scenarioEvent({ type: "TICKER_CHANGE", effectiveDate: DAY(), oldSymbol: "TSLA2x", newSymbol: "TSLA3x" }));
  if (rnd(2) === 0) {
    events.push(scenarioEvent({ type: "MULTIPLIER_CHANGE", effectiveDate: DAY(), multiplierFrom: "1", multiplierTo: "1.005" }));
  }
  // one datetime-skinned dividend: the sort key is the declared day, never the clock
  if (rnd(2) === 0) {
    const skinned = events.find((e) => e.type === "DIVIDEND_ACCRUAL");
    skinned.effectiveDate = `${String(skinned.effectiveDate).slice(0, 10)}T09:30:00-04:00`;
  }

  const qty = () => (1n + BigInt(rnd(3))) * 10_000_000_000_000_000n; // 10^16 × {1,2,3} — dust-free
  const acquired = () => (rnd(4) === 0 ? DAY_POOL[rnd(DAY_POOL.length)] : rnd(8) === 0 ? "2026-07-01" : "2026-06-01");
  const lots = [
    { id: "L1", mint: MINT, owner: OWNER, qtyRaw: qty(), acquiredDate: "2026-06-01", basisRaw: 1_000_000n },
    { id: "L2", mint: MINT, owner: OWNER2, qtyRaw: qty(), acquiredDate: "2026-06-01", basisRaw: 2_000_000n },
    { id: "L3", mint: MINT2, owner: OWNER, qtyRaw: qty(), acquiredDate: acquired(), basisRaw: 3_000_000n },
    { id: "L4", mint: MINT3, owner: OWNER, qtyRaw: qty(), acquiredDate: "2026-06-01", basisRaw: 4_000_000n },
  ];
  return { lots, events };
};

test("property: 200 random event sets — every permutation yields an identical report", () => {
  for (let n = 0; n < 200; n++) {
    const { lots, events } = randomScenario(n);
    let reference;
    try {
      reference = applyEvents(lots, events);
    } catch (err) {
      assert.fail(`scenario ${n} must be dust-free, threw: ${err.message}`);
    }
    for (let k = 0; k < 4; k++) {
      const permuted = applyEvents(lots, shuffled(events));
      assert.deepEqual(permuted, reference, `scenario ${n} permutation ${k} diverged`);
    }
  }
});
