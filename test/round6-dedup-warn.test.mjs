// Регрессионные тесты раунда 6 — находка LW2_dedup_id_collision_silent_divergence.
// Дедуп по ключу id:... схлопывает узлы с одинаковым id без сравнения содержимого
// и БЕЗ какого-либо warn — первое вхождение побеждает молча. Если эмитент переиспользует
// или исправляет id (амендированное событие на свежей странице), исправленное значение
// навсегда игнорируется, и никто об этом не узнает. Вердикт ревью: семантику «первое
// вхождение выигрывает» НЕ менять (id — идентичность узла API, альтернатива хуже),
// но добавить наблюдаемость: один console.error warn на схлопывание с расхождением.
import test from "node:test";
import assert from "node:assert/strict";
import { multiplierHistoryToEvents } from "../src/events/normalize-xstocks.mjs";

const node = (id, from, to, at, reason = "Dividend") => ({
  id,
  reason,
  multiplier: to,
  previousMultiplier: from,
  activationDateTime: at,
});

// Шпион на console.error: warn дедупа — единственный ожидаемый канал
async function captureConsoleError(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...args) => lines.push(args.map(String).join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = orig;
  }
}

test("дедуп: тот же id с РАЗНЫМ содержимым — по-прежнему одно событие, но ровно один warn о расхождении", async () => {
  const { result: events, lines } = await captureConsoleError(() =>
    multiplierHistoryToEvents(
      [
        node("nx", "1.04", "1.07", "2026-05-01T00:00:00.000Z"), // как пришло на странице 0
        node("nx", "1.04", "1.06", "2026-05-01T00:00:00.000Z"), // тот же id, другой множитель
      ],
      { symbol: "SPYx" },
    ),
  );
  // семантика не менялась: id — идентичность узла, первое вхождение выигрывает
  assert.equal(events.length, 1);
  assert.equal(events[0].multiplierTo, "1.07");
  // …но теперь это наблюдаемо, а не тихая потеря данных
  assert.equal(lines.length, 1, `ожидался один warn, было: ${JSON.stringify(lines)}`);
  assert.match(lines[0], /nx/); // имя конфликтующего id
  assert.match(lines[0], /SPYx/); // символ токена
});

test("дедуп: честный page-drift (тот же id, то же содержимое) — схлопнут БЕЗ warn", async () => {
  const { result: events, lines } = await captureConsoleError(() =>
    multiplierHistoryToEvents(
      [
        node("n3", "1.04", "1.06", "2026-05-01T00:00:00.000Z"),
        node("n3", "1.04", "1.06", "2026-05-01T00:00:00.000Z"), // дубль через границу страниц
      ],
      { symbol: "SPYx" },
    ),
  );
  assert.equal(events.length, 1);
  assert.equal(lines.length, 0, "нормальный дрейф пагинации — не повод шуметь");
});

test("дедуп: узлы без id, полное совпадение содержимого — схлопнуты без warn", async () => {
  const { result: events, lines } = await captureConsoleError(() =>
    multiplierHistoryToEvents(
      [
        { reason: "Dividend", multiplier: "1.02", previousMultiplier: "1", activationDateTime: "2026-01-15T00:00:00.000Z" },
        { reason: "Dividend", multiplier: "1.02", previousMultiplier: "1", activationDateTime: "2026-01-15T00:00:00.000Z" },
      ],
      { symbol: "SPYx" },
    ),
  );
  assert.equal(events.length, 1);
  assert.equal(lines.length, 0);
});
