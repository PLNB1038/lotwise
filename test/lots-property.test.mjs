// Property-тесты FIFO-движка отчёта (buildWalletReport, src/wallet/report.mjs).
//
// ЗАМЕТКА ОБ ОБЛАСТИ: формально в задании назван src/lots/lots.mjs, но это движок
// корпоративных действий (SPLIT/MERGER/REDEEM/...) — операций buy/sell там нет.
// FIFO-движок покупок/продаж живёт в src/wallet/report.mjs (buildWalletReport);
// его контракт и пины фактического поведения — «Группа 3. FIFO-движок отчёта»
// в test/wallet-edge.test.mjs и FIFO-тесты в test/wallet.test.mjs. Покрытие ниже —
// по этому движку.
//
// Методика: seeded PRNG (mulberry32, без зависимостей) генерирует 200 сценариев
// по 5–40 операций buy/sell/zero-qty: количества BigInt 1..1000n, монотонные
// времена; ~25% продаж — целевой перерасход баланса (движок ест недостачу как гэп).
//
// Фактическая семантика перерасхода, запиненная в wallet-edge («перерасход после
// частичной продажи — гэп = недостача», buy 100 → sell 40 → sell 80: lots=0,
// realized=100, gap=20):
//   продано  = реализовано + гэп;
//   куплено  = реализовано + живые лоты;
//   netDelta = куплено − продано (может быть отрицательным — так и задумано);
//   куплено − продано + гэп = живые лоты.
//
// Инварианты (на каждом сценарии, BigInt-точно):
//   1. сохранение: три формы выше + netDelta + производная complete;
//   2. неотрицательность всех количеств; ноль-лотов в очереди не бывает
//      (netDelta отрицательным быть может — документированная семантика окна);
//   3. FIFO: выжившие лоты — непрерывный возрастающий суффикс номеров покупок,
//      заканчивающийся последней покупкой; все лоты кроме, возможно, первого —
//      нетронутые (qty и acquiredDate равны исходной покупке); дата лота —
//      всегда дата его покупки;
//   4. след каждой продажи: gaps ≤ nSells ≤ realizedCount + |gaps|;
//      realizedCount>0 ⇔ realizedQty>0; гэпы > 0, даты гэпов — из продаж;
//   5. zero-qty операции не меняют состояние: удаление их из потока даёт
//      те же tokens (deep-equal);
//   6. детерминизм: seed константой; повторный прогон — идентичный JSON;
//      при падении ассерт печатает seed, номер сценария и всю последовательность.
//
// Если инвариант ловит баг движка — src НЕ правится: последовательность
// минимизируется и фиксируется явным регрессионным кейсом внизу этого файла
// (см. шаблон в хвосте; сейчас найденных багов нет — секция пуста).
import test from "node:test";
import assert from "node:assert/strict";
import { buildWalletReport } from "../src/wallet/report.mjs";

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) и генератор сценариев
// ---------------------------------------------------------------------------

const SEED = 0x1a7be3f; // константа: при падении инварианта сценарий воспроизводим

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// строго base58-подобные минты без «-» (id лота = `${mint}-${№покупки}`)
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

// Сценарий: 1–2 минта, 5–40 операций buy/sell/zero-qty, монотонные времена.
// op.over = целевой перерасход (продажа больше текущего баланса окна).
function makeScenario(index, rng) {
  const nMints = rng() < 0.5 ? 1 : 2;
  const first = Math.floor(rng() * MINTS.length);
  const mintList = nMints === 2 ? [first, 1 - first] : [first];
  const nOps = rndInt(rng, 5, 40);
  let t = 1_700_000_000 + index;
  const bal = new Array(nMints).fill(0n); // текущий нетто-баланс окна по минту
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
      // 25% продаж — гарантированный перерасход: баланс + хвост (движок ест как гэп)
      if (bal[mintIdx] > 0n && rng() < 0.25) {
        qty = bal[mintIdx] + BigInt(rndInt(rng, 1, 500));
        over = true;
      } else {
        qty = BigInt(rndInt(rng, 1, 1000));
      }
    }
    t += rndInt(rng, 1, 7200); // монотонное время, строго возрастает
    ops.push({ mintIdx, kind, qty, over, blockTime: t });
    if (kind === "buy") bal[mintIdx] += qty;
    else if (kind === "sell") bal[mintIdx] -= qty;
  }
  return { index, mintList, ops };
}

const RNG = mulberry32(SEED);
const SCENARIOS = Array.from({ length: 200 }, (_, i) => makeScenario(i, RNG));

// ---------------------------------------------------------------------------
// Прогон сценария через движок и независимая модель из операций генератора
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

// now фиксирован: buildWalletReport по умолчанию ставит new Date().toISOString()
// (параметр opts, не детерминизм движка); с фиксированным now отчёт — чистая
// функция от скана.
const NOW = "2026-09-22T00:00:00.000Z";
const reportOf = (sc) => buildWalletReport(scanOf(opsToTxs(sc)), { registry: REG, now: NOW });

// Модель считается ТОЛЬКО из сгенерированных операций (не повторяет логику FIFO):
// агрегаты куплено/продано, список покупок в порядке очерёдности (это будущие
// лоты с номерами 1..nBuys) и множество дат продаж.
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

// Контекст падения: seed + номер сценария + вся последовательность операций —
// падение воспроизводимо однозначно.
const fmtOps = (sc) =>
  JSON.stringify(sc.ops.map((o, i) => ({ n: i, mint: o.mintIdx, op: o.kind, qty: o.qty.toString(), over: o.over, t: o.blockTime })));
const ctx = (sc, extra = "") => `seed=${SEED} сценарий #${sc.index} ${extra}\nоперации: ${fmtOps(sc)}`;

const rowOf = (rep, mint) => rep.tokens.find((t) => t.mint === mint);
const sumLots = (row) => row.lots.reduce((a, l) => a + BigInt(l.qtyRaw), 0n);
const sumGaps = (row) => row.gaps.reduce((a, g) => a + BigInt(g.missingQtyRaw), 0n);

// ---------------------------------------------------------------------------
// 0. Санитарность генератора: монотонные времена, размеры, покрытие не вакуумно
// ---------------------------------------------------------------------------

test(`генератор: 200 сценариев по 5–40 операций, времена монотонны (seed=${SEED})`, () => {
  assert.equal(SCENARIOS.length, 200);
  for (const sc of SCENARIOS) {
    assert.ok(sc.ops.length >= 5 && sc.ops.length <= 40, ctx(sc));
    for (let i = 1; i < sc.ops.length; i++) {
      assert.ok(sc.ops[i].blockTime > sc.ops[i - 1].blockTime, `времена строго монотонны\n${ctx(sc)}`);
    }
    for (const op of sc.ops) {
      if (op.kind === "zero") assert.equal(op.qty, 0n, ctx(sc));
      else if (op.over) assert.ok(op.qty >= 1n && op.qty <= 41_000n, `целевой перерасход ≤ maxBal(40×1000)+500\n${ctx(sc)}`);
      else assert.ok(op.qty >= 1n && op.qty <= 1000n, `базовые количества 1..1000\n${ctx(sc)}`);
    }
  }
});

test(`покрытие не вакуумно: гэпы, реализации, перерасходы, zero-ops реально встречаются (seed=${SEED})`, (t) => {
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
    `seed=${SEED}: операций=${totalOps}; сценариев с гэпами=${gapScen}, с реализацией=${realizedScen}, ` +
    `с отрицательным netDelta=${negativeNet}, мульти-минт=${multiMint}, ` +
    `целевых перерасходов=${overshootOps}, zero-ops=${zeroOps}`;
  t.diagnostic(summary); // сводка покрытия видна и на зелёном прогоне
  assert.ok(
    gapScen >= 1 && realizedScen >= 1 && negativeNet >= 1 && multiMint >= 1 && overshootOps >= 20 && zeroOps >= 20,
    `генератор обязан покрывать все ветви движка, а не только happy-path\n${summary}`,
  );
});

// ---------------------------------------------------------------------------
// 1. Сохранение: куплено = реализовано + живые лоты; продано = реализовано + гэп;
//    netDelta = куплено − продано; complete производен от гэпов и сверки
// ---------------------------------------------------------------------------

test("сохранение: куплено/продано/гэп/лоты сходятся BigInt-точно в каждом сценарии", () => {
  for (const sc of SCENARIOS) {
    const rep = reportOf(sc);
    for (const [mint, m] of modelOf(sc)) {
      const row = rowOf(rep, mint);
      const hasFlow = m.bought > 0n || m.sold > 0n;
      assert.equal(row !== undefined, hasFlow, `токен-строка существует ⇔ была ненулевая дельта\n${ctx(sc, mint)}`);
      if (!row) continue;
      const lotsSum = sumLots(row);
      const realizedQty = BigInt(row.realizedQtyRaw);
      const gapQty = sumGaps(row);
      assert.equal(realizedQty + gapQty, m.sold, `продано = реализовано + гэп\n${ctx(sc, mint)}`);
      assert.equal(realizedQty + lotsSum, m.bought, `куплено = реализовано + живые лоты\n${ctx(sc, mint)}`);
      assert.equal(m.bought - m.sold + gapQty, lotsSum, `сохранение: куплено − продано + гэп = живые лоты\n${ctx(sc, mint)}`);
      assert.equal(BigInt(row.netDeltaRaw), m.bought - m.sold, `netDelta = куплено − продано\n${ctx(sc, mint)}`);
      assert.equal(BigInt(row.rawBalance), m.bought - m.sold, "rawBalance — legacy-алиас того же числа");
      assert.ok(lotsSum <= m.bought && gapQty <= m.sold, `лоты и гэп не превосходят потоков\n${ctx(sc, mint)}`);
    }
    // accounts:{} → reconciles ⇔ netDelta 0; complete = нет гэпов и всё сошлось
    const expectComplete = rep.tokens.every((t) => t.gaps.length === 0 && BigInt(t.rawBalance) === 0n);
    assert.equal(rep.complete, expectComplete, `complete производен: без гэпов и с нулевым нетто\n${ctx(sc)}`);
  }
});

// ---------------------------------------------------------------------------
// 2. Неотрицательность: количества не отрицательны, ноль-лотов не бывает;
//    netDelta может быть отрицательным (задокументированная семантика окна)
// ---------------------------------------------------------------------------

test("неотрицательность: qty лотов, гэпы, реализация — строго > 0 где существуют", () => {
  for (const sc of SCENARIOS) {
    const rep = reportOf(sc);
    for (const row of rep.tokens) {
      for (const lot of row.lots) {
        const q = BigInt(lot.qtyRaw); // мусор в строке уронил бы BigInt — тоже красные
        assert.ok(q > 0n, `в очереди нет ноль-лотов и отрицательных qty\n${ctx(sc, row.mint)}`);
      }
      for (const g of row.gaps) {
        assert.ok(BigInt(g.missingQtyRaw) > 0n, `гэп — положительная недостача\n${ctx(sc, row.mint)}`);
      }
      const realizedQty = BigInt(row.realizedQtyRaw);
      assert.ok(realizedQty >= 0n, `реализация неотрицательна\n${ctx(sc, row.mint)}`);
      assert.equal(row.realizedCount > 0, realizedQty > 0n, `счётчик реализаций согласован с количеством\n${ctx(sc, row.mint)}`);
      assert.ok(row.realizedCount >= 0 && Number.isInteger(row.realizedCount), ctx(sc, row.mint));
    }
  }
});

// ---------------------------------------------------------------------------
// 3. FIFO-порядок: выжившие лоты — непрерывный суффикс покупок, хвост нетронут,
//    дата лота — дата его покупки; подрезана может быть только голова очереди
// ---------------------------------------------------------------------------

test("FIFO: выжившие лоты — непрерывный суффикс покупок, хвост очереди нетронут", () => {
  for (const sc of SCENARIOS) {
    const rep = reportOf(sc);
    for (const [mint, m] of modelOf(sc)) {
      const row = rowOf(rep, mint);
      if (!row) continue; // нет строки ⇔ не было ненулевых операций (проверено в «сохранении»)
      const seqs = row.lots.map((lot) => {
        assert.ok(lot.id.startsWith(`${mint}-`), `id лота = mint-<№покупки>\n${ctx(sc, mint)}`);
        return Number(lot.id.slice(mint.length + 1));
      });
      for (let j = 0; j < seqs.length; j++) {
        assert.ok(seqs[j] >= 1 && seqs[j] <= m.nBuys, `номер покупки в границах 1..${m.nBuys}\n${ctx(sc, mint)}`);
        if (j > 0) assert.equal(seqs[j], seqs[j - 1] + 1, `суффикс номеров непрерывен (FIFO ест спереди, дыр не оставляет)\n${ctx(sc, mint)}`);
      }
      if (seqs.length > 0) {
        assert.equal(seqs[seqs.length - 1], m.nBuys, `последний выживший — самая поздняя покупка (#${m.nBuys})\n${ctx(sc, mint)}`);
      }
      for (let j = 0; j < seqs.length; j++) {
        const origin = m.buys[seqs[j] - 1]; // №покупки → операция генератора
        assert.equal(row.lots[j].acquiredDate, origin.iso, `дата лота = дата его покупки\n${ctx(sc, mint)}`);
        const q = BigInt(row.lots[j].qtyRaw);
        if (j === 0) {
          assert.ok(q >= 1n && q <= origin.qty, `голова очереди может быть подрезана, но не сильнее своей покупки\n${ctx(sc, mint)}`);
        } else {
          assert.equal(q, origin.qty, `хвост очереди нетронут: подрезана только голова (FIFO)\n${ctx(sc, mint)}`);
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 4. След каждой продажи и семантика перерасхода (гэп)
// ---------------------------------------------------------------------------

test("перерасход: каждая продажа оставляет след, гэпы честны и датированы продажами", () => {
  for (const sc of SCENARIOS) {
    const rep = reportOf(sc);
    for (const [mint, m] of modelOf(sc)) {
      const row = rowOf(rep, mint);
      if (!row) continue;
      assert.ok(row.gaps.length <= m.nSells, `гэп — максимум один на продажу\n${ctx(sc, mint)}`);
      assert.ok(
        m.nSells <= row.realizedCount + row.gaps.length,
        `каждая продажа оставляет след: реализация или гэп\n${ctx(sc, mint)}`,
      );
      const sellIsos = new Set(m.sells);
      let prevDate = "";
      for (const g of row.gaps) {
        assert.ok(BigInt(g.missingQtyRaw) > 0n, ctx(sc, mint));
        assert.ok(sellIsos.has(g.date), `дата гэпа — дата какой-то продажи\n${ctx(sc, mint)}`);
        assert.ok(g.date >= prevDate, `гэпы хронологичны (поток монотонен)\n${ctx(sc, mint)}`);
        prevDate = g.date;
      }
      if (row.gaps.length > 0) {
        assert.equal(rep.complete, false, `гэп делает отчёт неполным (трункации нет)\n${ctx(sc, mint)}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 5. Zero-qty операции не меняют состояние
// ---------------------------------------------------------------------------

test("zero-qty: удаление нулевых операций из потока не меняет tokens ни в чём", () => {
  for (const sc of SCENARIOS) {
    const withZeros = reportOf(sc).tokens;
    const filtered = { index: sc.index, mintList: sc.mintList, ops: sc.ops.filter((o) => o.kind !== "zero") };
    assert.deepEqual(reportOf(filtered).tokens, withZeros, `zero-qty — no-op для FIFO\n${ctx(sc)}`);
  }
});

// ---------------------------------------------------------------------------
// 6. Детерминизм: тот же seed — тот же отчёт
// ---------------------------------------------------------------------------

test(`детерминизм: повторный прогон первых 25 сценариев — идентичный JSON (seed=${SEED})`, () => {
  const snapshot = () => SCENARIOS.slice(0, 25).map((sc) => JSON.stringify(reportOf(sc)));
  const first = snapshot();
  assert.deepEqual(snapshot(), first, `seed=${SEED} обязан давать байт-в-байт одинаковые отчёты`);
});

// ===========================================================================
// Регрессионные кейсы (протокол): если property-инвариант выше ловит баг
// движка — src НЕ правится. Последовательность минимизируется до маленького
// явного кейса и фиксируется здесь тестом с комментарием «найдено property-тестом,
// seed=…, сценарий #…, инвариант …», пинящим ФАКТИЧЕСКОЕ поведение.
// Сейчас таких кейсов нет: все 200 сценариев × 6 групп инвариантов зелёные.
// ===========================================================================
