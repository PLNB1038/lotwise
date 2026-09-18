// Стрим сигнатур транзакций по минту: пагинация getSignaturesForAddress.
// err-транзакции отдаются с флагом — фильтрация на совести потребителя.
export async function* streamSignatures(client, mint, { limit = 100, maxPages = Infinity } = {}) {
  let before = undefined;
  for (let page = 0; page < maxPages; page++) {
    const params = [mint, { limit, ...(before !== undefined ? { before } : {}) }];
    const batch = await client.call("getSignaturesForAddress", params);
    if (!Array.isArray(batch) || batch.length === 0) return; // конец истории
    for (const s of batch) {
      yield {
        signature: s.signature,
        slot: s.slot,
        blockTime: s.blockTime ?? null,
        err: s.err ?? null,
      };
    }
    if (batch.length < limit) return; // хвост короче страницы — дальше пусто
    before = batch[batch.length - 1].signature;
  }
}
