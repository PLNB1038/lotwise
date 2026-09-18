import test from "node:test";
import assert from "node:assert/strict";
import { reconcileSnapshots, verdict, mergeVerified } from "../src/reconcile/reconcile.mjs";

const snap = (source, entries) => ({ source, entries });
const ent = (key, over = {}) => ({
  key, slot: 300, blockTime: 1_760_000_000, deltaRaw: 1_000n, owner: "Owner11111111111111111111111111111111111111111", mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", ...over,
});

test("пустые снапшоты → ok", () => {
  const r = reconcileSnapshots(snap("A", []), snap("B", []));
  assert.equal(verdict(r), "ok");
  assert.equal(mergeVerified(r).length, 0);
});

test("полное совпадение → ok, всё в merge", () => {
  const e = [ent("sig1"), ent("sig2")];
  const r = reconcileSnapshots(snap("A", e), snap("B", e.map((x) => ({ ...x }))));
  assert.equal(verdict(r), "ok");
  assert.equal(r.stats.agreed, 2);
  assert.equal(mergeVerified(r).length, 2);
});

test("запись только в A → partial, в merge не попадает", () => {
  const e = [ent("sig1"), ent("sig2")];
  const r = reconcileSnapshots(snap("A", e), snap("B", [ent("sig1")])); // sig2 нет в B
  assert.equal(verdict(r), "partial");
  assert.equal(r.stats.onlyA, 1);
  assert.equal(mergeVerified(r).length, 1);
});

test("расхождение deltaRaw → conflict + unverified, в merge не попадает", () => {
  const r = reconcileSnapshots(
    snap("A", [ent("sig1"), ent("sig2")]),
    snap("B", [ent("sig1", { deltaRaw: 999n }), ent("sig2")]),
  );
  assert.equal(r.stats.conflicts, 1);
  assert.deepEqual(r.conflicts[0].reason, ["deltaRaw"]);
  assert.equal(verdict(r), "unverified");
  assert.equal(mergeVerified(r).length, 1); // sig2 согласован — он остаётся
});

test("расхождение slot → конфликт", () => {
  const r = reconcileSnapshots(snap("A", [ent("sig1")]), snap("B", [ent("sig1", { slot: 301 })]));
  assert.equal(verdict(r), "unverified");
  assert.deepEqual(r.conflicts[0].reason, ["slot"]);
});

test("несколько расходящихся полей перечисляются все", () => {
  const r = reconcileSnapshots(
    snap("A", [ent("sig1", { slot: 300, deltaRaw: 5n })]),
    snap("B", [ent("sig1", { slot: 305, deltaRaw: 9n })]),
  );
  assert.deepEqual(r.conflicts[0].reason.sort(), ["deltaRaw", "slot"]);
});

// --- property-прогон: детерминированный PRNG, 200 случайных пар ---

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("property: инварианты на 200 случайных парах снапшотов", () => {
  const rnd = mulberry32(20260918);
  for (let iter = 0; iter < 200; iter++) {
    const n = 1 + Math.floor(rnd() * 50);
    const keys = Array.from({ length: n }, (_, i) => `sig${iter}_${i}`);
    const A = keys.map((k) => ent(k, { deltaRaw: BigInt(Math.floor(rnd() * 1e6)), slot: 300 + Math.floor(rnd() * 10) }));
    const B = A.map((e) => ({ ...e }));
    // контролируемые вкрапления: мутации, удаления, односторонние добавления
    let expectedConflicts = 0;
    let mutIdx = -1;
    if (rnd() < 0.5 && B.length > 0) {
      mutIdx = Math.floor(rnd() * B.length);
      B[mutIdx].deltaRaw += 7n;
      expectedConflicts++;
    }
    let removed = 0;
    if (rnd() < 0.4 && B.length > 1) {
      const i = Math.floor(rnd() * B.length);
      B.splice(i, 1);
      removed++;
      if (i === mutIdx) expectedConflicts = 0; // мутированная запись удалена — конфликта больше нет
    }
    let extraB = 0;
    if (rnd() < 0.4) {
      B.push(ent(`extra_${iter}`));
      extraB++;
    }

    const r = reconcileSnapshots(snap("A", A), snap("B", B));

    // инвариант 1: agreed + onlyA + onlyB + conflicts = число уникальных ключей
    const uniqueKeys = new Set([...A.map((e) => e.key), ...B.map((e) => e.key)]).size;
    const covered = r.stats.agreed + r.stats.onlyA + r.stats.onlyB + r.stats.conflicts;
    assert.equal(covered, uniqueKeys, `iter ${iter}: покрытие ключей`);

    // инвариант 2: mergeVerified ⊆ agreed
    assert.ok(mergeVerified(r).length <= r.stats.agreed);

    // инвариант 3: unverified ⇔ conflicts > 0 (fail-closed)
    assert.equal(verdict(r) === "unverified", r.stats.conflicts > 0);

    // инвариант 4: ожидания вкраплений
    assert.equal(r.stats.conflicts, expectedConflicts, `iter ${iter}: конфликты`);
    assert.equal(r.stats.onlyA, removed, `iter ${iter}: односторонние A`);
    assert.equal(r.stats.onlyB, extraB, `iter ${iter}: односторонние B`);
  }
});
