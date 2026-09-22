// Регрессионные тесты раунда 6 — находка LW2_issuer_chain_complete_dateparse_divergence.
// issuerChainComplete был последним местом конвейера на Date.parse: перекат-даты
// ("2026-02-30T00:00:00Z" → 2 марта) и наивные даты (локальное время хоста) проходили
// гейт полноты цепочки, а затем падали в multiplierHistoryToEvents с NormalizeError —
// гейт и нормализатор жили в разных датовых семантиках, а serve.mjs классифицировал
// это как «источник недоступен» при живом источнике. Контракт: тот же строгий
// parseIsoDateMs, что у остального конвейера (schema/isodate.mjs); узел с мусорной
// датой не участвует в выборе старейшего — гейт отвечает complete:false с честной
// причиной «непарсируемая дата» (fail-closed, как и раньше для "not-a-date").
import test from "node:test";
import assert from "node:assert/strict";
import { issuerChainComplete } from "../src/events/journal.mjs";
import { multiplierHistoryToEvents, NormalizeError } from "../src/events/normalize-xstocks.mjs";

test("перекат-дата 2026-02-30 не проходит гейт (Date.parse перекатывал её на 2 марта и давал complete:true)", () => {
  const r = issuerChainComplete([
    { previousMultiplier: "1", multiplier: "2", activationDateTime: "2026-02-30T00:00:00Z" },
  ]);
  assert.equal(r.complete, false);
  assert.match(r.reason, /непарсируемая дата/);
  assert.match(r.reason, /2026-02-30/); // причина называет конкретный узел
});

test("наивная дата без таймзоны не проходит гейт (Date.parse трактовал её как локальное время)", () => {
  const r = issuerChainComplete([
    { previousMultiplier: "1", multiplier: "2", activationDateTime: "2026-05-01T12:00:00" },
  ]);
  assert.equal(r.complete, false);
  assert.match(r.reason, /непарсируемая дата/);
});

test("мусорная дата не участвует в выборе старейшего: вердикт неполный независимо от остальных узлов", () => {
  // даже если валидные узлы образуют цепочку от "1" — узел с перекат-датой делает
  // набор непроверяемым, «перекатанный» старейший не подменяет вердикт
  const r = issuerChainComplete([
    { previousMultiplier: "1.002", multiplier: "1.005", activationDateTime: "2026-01-01T00:00:00Z" },
    { previousMultiplier: "1", multiplier: "1.002", activationDateTime: "2026-02-30T00:00:00Z" },
  ]);
  assert.equal(r.complete, false);
  // и наоборот: настоящий неполный старт не маскируется мусорной датой соседа
  const r2 = issuerChainComplete([
    { previousMultiplier: "1.002", multiplier: "1.005", activationDateTime: "2026-01-01T00:00:00Z" },
    { previousMultiplier: "1", multiplier: "1.002", activationDateTime: "not-a-date" },
  ]);
  assert.equal(r2.complete, false);
});

test("валидная цепочка не сломана строгим парсером: смешанная точность секунд, любой порядок", () => {
  const nodes = [
    { previousMultiplier: "1.02", multiplier: "1.04", activationDateTime: "2026-08-01T00:00:00.500Z" },
    { previousMultiplier: "1", multiplier: "1.02", activationDateTime: "2026-01-15T00:00:00Z" },
  ];
  assert.deepEqual(issuerChainComplete(nodes), { complete: true, reason: null });
  assert.deepEqual(issuerChainComplete([...nodes].reverse()), { complete: true, reason: null });
});

test("конвейер в одной датовой семантике: всё, что проходит гейт, нормализатор обязан принять", () => {
  const nodes = [
    { id: "a", reason: "Split", multiplier: "2", previousMultiplier: "1", activationDateTime: "2026-03-01T00:00:00Z" },
  ];
  assert.deepEqual(issuerChainComplete(nodes), { complete: true, reason: null });
  const events = multiplierHistoryToEvents(nodes, { symbol: "TESTx" });
  assert.equal(events[0].effectiveDate, "2026-03-01T00:00:00Z");
});

test("искомая дивергенция убита: гейт отказывает ДО нормализатора — «источник недоступен» больше не врёт", () => {
  const rollover = [{ previousMultiplier: "1", multiplier: "2", activationDateTime: "2026-02-30T00:00:00Z" }];
  const naive = [{ previousMultiplier: "1", multiplier: "2", activationDateTime: "2026-05-01T12:00:00" }];
  for (const nodes of [rollover, naive]) {
    // гейт: события не скармливаются таймлайну с честной причиной
    assert.equal(issuerChainComplete(nodes).complete, false);
    // а если бы всё же скормили — нормализатор по-прежнему fail-closed, тише не стало
    assert.throws(() => multiplierHistoryToEvents(nodes, { symbol: "TESTx" }), NormalizeError);
  }
});
