// Стрим сигнатур транзакций по минту: пагинация getSignaturesForAddress.
// err-транзакции отдаются с флагом — фильтрация на совести потребителя.
// Контракт уникальности (раунд 8): курсор before = «строго старше», поэтому одна
// сигнатура не может прийти дважды; залипший/лгущий эндпоинт, повторяющий страницу,
// дедупится внутри — потребитель не должен видеть дубли как «новые» события.
export async function* streamSignatures(client, mint, { limit = 100, maxPages = Infinity } = {}) {
  let before = undefined;
  const seen = new Set();
  for (let page = 0; page < maxPages; page++) {
    const params = [mint, { limit, ...(before !== undefined ? { before } : {}) }];
    const batch = await client.call("getSignaturesForAddress", params);
    // Конец истории — ТОЛЬКО пустая страница (раунд 8, семантика scan.mjs):
    // «короткая» страница у эндпоинтов с soft caps может не быть концом.
    if (!Array.isArray(batch) || batch.length === 0) return;
    for (const s of batch) {
      if (seen.has(s.signature)) continue;
      seen.add(s.signature);
      yield {
        signature: s.signature,
        slot: s.slot,
        blockTime: s.blockTime ?? null,
        err: s.err ?? null,
      };
    }
    const last = batch[batch.length - 1].signature;
    if (last === before) return; // залипший эндпоинт: страница не меняется — прогресса нет
    before = last;
  }
}
