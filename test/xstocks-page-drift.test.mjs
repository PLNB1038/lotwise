// Регрессионный тест на page-drift пагинации истории xStocks (находка раунда 5,
// кандидат LW_issuer_page_drift_breaks_chain). Пагинация по офсету «новые сверху»:
// узел, вставленный эмитентом между фетчем страницы 0 и 1, сдвигает окно и ОДИН
// и тот же узел приходит на двух страницах. Повтор узла проходит issuerChainComplete
// (та проверяет только старт старейшего узла от «1»), доезжает до таймлайна и валит
// его с TimelineError «chain discontinuity» — токен целиком исключается с витрины.
// Контракт: дубликат узла схлопывается ДО проверки цепочки, настоящий разрыв
// цепочки по-прежнему fail-closed.
import test from "node:test";
import assert from "node:assert/strict";
import { multiplierHistoryToEvents, bindMintAndValidate } from "../src/events/normalize-xstocks.mjs";
import { MultiplierTimeline, TimelineError } from "../src/lots/timeline.mjs";
import { issuerChainComplete } from "../src/events/journal.mjs";

const MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W"; // SPYx

// Честная цепочка 1 → 1.02 → 1.04 → 1.06 → 1.08, новые сверху (как отдаёт API).
const node = (id, from, to, at, reason = "Dividend") => ({
  id,
  reason,
  multiplier: to,
  previousMultiplier: from,
  activationDateTime: at,
});
const CHAIN = [
  node("n4", "1.06", "1.08", "2026-08-01T00:00:00.000Z"),
  node("n3", "1.04", "1.06", "2026-05-01T00:00:00.000Z"),
  node("n2", "1.02", "1.04", "2026-01-15T00:00:00.000Z"),
  node("n1", "1", "1.02", "2025-10-01T00:00:00.000Z"),
];

// Пагинация точно как в scripts/serve.mjs: офсетные страницы «новые сверху»,
// узел n3 вставлен между фетчами — окно страницы 1 сдвинулось и n3 дублируется
// через границу (page 0: [n4, n3], page 1: [n3, n2], page 2: [n1]).
const DRIFTED_PAGES = [
  { page: { hasNextPage: true }, nodes: [CHAIN[0], CHAIN[1]] },
  { page: { hasNextPage: true }, nodes: [CHAIN[1], CHAIN[2]] },
  { page: { hasNextPage: false }, nodes: [CHAIN[3]] },
];

// Сборка страниц как в serve.mjs (без sleep): узлы складываются как есть.
async function collectNodes(pages) {
  const nodes = [];
  let hasNextPage = true;
  for (let page = 0; page < pages.length && hasNextPage; page++) {
    nodes.push(...pages[page].nodes);
    hasNextPage = pages[page].page.hasNextPage;
  }
  return nodes;
}

test("page-drift: дубль узла через границу страниц проходит issuerChainComplete (условие находки)", async () => {
  const nodes = await collectNodes(DRIFTED_PAGES);
  assert.equal(nodes.length, 5); // 4 события, n3 задвоен
  // гейт НЕ видит дубликат: смотрит только старейший узел (от «1») — complete
  assert.deepEqual(issuerChainComplete(nodes), { complete: true, reason: null });
});

test("page-drift: после дедупа цепочка валидна, таймлайн строится, токен НЕ исключается", async () => {
  const nodes = await collectNodes(DRIFTED_PAGES);
  const events = multiplierHistoryToEvents(nodes, { symbol: "SPYx", network: "Ethereum" });
  // дубль схлопнут: 4 канонических события, а не 5 узлов
  assert.equal(events.length, 4);
  const bound = bindMintAndValidate(events, MINT); // атомарная валидация схемы проходит
  // то самое место, которое раньше падало: TimelineError «chain discontinuity»
  const timeline = new MultiplierTimeline(bound);
  assert.equal(timeline.multiplierAt("2026-09-01T00:00:00.000Z"), "1.08");
  // цепочка не «обрезана», а непрерывна: множители по датам сходятся пошагово
  assert.equal(timeline.multiplierAt("2025-11-01T00:00:00.000Z"), "1.02");
  assert.equal(timeline.multiplierAt("2026-02-01T00:00:00.000Z"), "1.04");
  assert.equal(timeline.multiplierAt("2026-06-01T00:00:00.000Z"), "1.06");
  // источник события указывает на реальный узел API, а не на дубль
  assert.match(events[0].sources[0], /#node:n1$/);
});

test("page-drift: тот же дрейф на сыром JSON API (числа вместо строк) тоже схлопывается", async () => {
  // multiplierHistoryToEvents принимает и сырой payload (числа), см. шапку нормализатора
  const raw = [
    { id: "n4", reason: "Dividend", multiplier: 1.08, previousMultiplier: 1.06, activationDateTime: "2026-08-01T00:00:00.000Z" },
    { id: "n3", reason: "Dividend", multiplier: 1.06, previousMultiplier: 1.04, activationDateTime: "2026-05-01T00:00:00.000Z" },
    { id: "n3", reason: "Dividend", multiplier: 1.06, previousMultiplier: 1.04, activationDateTime: "2026-05-01T00:00:00.000Z" },
    { id: "n2", reason: "Dividend", multiplier: 1.04, previousMultiplier: 1.02, activationDateTime: "2026-01-15T00:00:00.000Z" },
    { id: "n1", reason: "Dividend", multiplier: 1.02, previousMultiplier: 1, activationDateTime: "2025-10-01T00:00:00.000Z" },
  ];
  const events = multiplierHistoryToEvents(raw, { symbol: "SPYx", network: "Ethereum" });
  assert.equal(events.length, 4);
  assert.doesNotThrow(() => new MultiplierTimeline(bindMintAndValidate(events, MINT)));
});

test("page-drift: тот же id с РАЗНЫМ содержимым — один узел (первое вхождение), не два события", () => {
  const drifted = [
    node("nx", "1.04", "1.07", "2026-05-01T00:00:00.000Z"), // как пришло на странице 0
    node("nx", "1.04", "1.06", "2026-05-01T00:00:00.000Z"), // тот же id, другой множитель на странице 1
    node("n1", "1", "1.04", "2026-01-15T00:00:00.000Z"),
  ];
  const events = multiplierHistoryToEvents(drifted, { symbol: "SPYx", network: "Ethereum" });
  assert.equal(events.length, 2); // id — идентичность узла: второй экземпляр не даёт второго события
  assert.equal(events.find((e) => e.multiplierTo === "1.07").multiplierTo, "1.07"); // первое вхождение выигрывает
  assert.doesNotThrow(() => new MultiplierTimeline(bindMintAndValidate(events, MINT)));
});

test("page-drift: разные id с одинаковым содержимым НЕ схлопываются — противоречие остаётся fail-closed", () => {
  const conflicting = [
    node("na", "1.04", "1.06", "2026-05-01T00:00:00.000Z"),
    node("nb", "1.04", "1.06", "2026-05-01T00:00:00.000Z"), // другой узел, тот же переход
    node("n1", "1", "1.04", "2026-01-15T00:00:00.000Z"),
  ];
  const events = multiplierHistoryToEvents(conflicting, { symbol: "SPYx", network: "Ethereum" });
  assert.equal(events.length, 3); // дедуп только по идентичности узла, молча не выбрасываем
  assert.throws(() => new MultiplierTimeline(bindMintAndValidate(events, MINT)), TimelineError);
});

test("page-drift: узлы без id дедупятся только при полном совпадении содержимого", () => {
  const idless = [
    { reason: "Dividend", multiplier: "1.02", previousMultiplier: "1", activationDateTime: "2026-01-15T00:00:00.000Z" },
    { reason: "Dividend", multiplier: "1.02", previousMultiplier: "1", activationDateTime: "2026-01-15T00:00:00.000Z" }, // точный дубль
    { reason: "Split", multiplier: "1.04", previousMultiplier: "1.02", activationDateTime: "2026-01-15T00:00:00.000Z" }, // другой узел, тот же день
  ];
  const events = multiplierHistoryToEvents(idless, { symbol: "SPYx", network: "Ethereum" });
  assert.equal(events.length, 2); // дубль схлопнут, разные события в один день не тронуты
  const timeline = new MultiplierTimeline(bindMintAndValidate(events, MINT));
  assert.equal(timeline.multiplierAt("2026-02-01T00:00:00.000Z"), "1.04"); // цепочка непрерывна
});
