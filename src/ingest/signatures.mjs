// Стрим сигнатур транзакций по минту: пагинация getSignaturesForAddress.
// err-транзакции отдаются с флагом — фильтрация на совести потребителя.
// Контракты (раунды 8–9):
//   — конец истории — ТОЛЬКО пустая страница («короткая» у нод с soft caps ≠ конец);
//   — уникальность: одна сигнатура не выдаётся дважды (залипшая страница дедупится);
//   — не-массивный ответ (result:null лежащего шлюза) — ЯВНАЯ ошибка, не тихий
//     «конец истории» (fail-closed);
//   — битые элементы (null/без signature) skip'аются, курсор — последний валидный;
//   — терминация: 2 подряд страницы БЕЗ новых уникальных сигнатур = нет прогресса
//     (чередующиеся дубли с разными хвостами тоже ловятся).
export async function* streamSignatures(client, mint, { limit = 100, maxPages = Infinity } = {}) {
  let before = undefined;
  const seen = new Set();
  let zeroProgressPages = 0;
  for (let page = 0; page < maxPages; page++) {
    const params = [mint, { limit, ...(before !== undefined ? { before } : {}) }];
    const batch = await client.call("getSignaturesForAddress", params);
    if (!Array.isArray(batch)) {
      throw new Error(`malformed getSignaturesForAddress response: expected array, got ${batch === null ? "null" : typeof batch}`);
    }
    if (batch.length === 0) return;
    let added = 0;
    let lastValid = null;
    for (const s of batch) {
      if (s === null || typeof s !== "object" || typeof s.signature !== "string") continue;
      if (!seen.has(s.signature)) {
        seen.add(s.signature);
        added++;
        yield {
          signature: s.signature,
          slot: s.slot,
          blockTime: s.blockTime ?? null,
          err: s.err ?? null,
        };
      }
      lastValid = s.signature; // курсор — последний валидный элемент, дубли включительно
    }
    if (added === 0 || lastValid === null || lastValid === before) {
      if (++zeroProgressPages >= 2) return;
    } else {
      zeroProgressPages = 0;
    }
    if (lastValid !== null) before = lastValid;
  }
}
