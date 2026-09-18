// Токен-дельты одной транзакции из getTransaction.
// maxSupportedTransactionVersion: 1 обязателен — иначе весь скан падает
// на versioned-транзакциях с -32015 (урок сентября 2026, забытый = сканер мёртв).

/**
 * Дельты по набору минтов (Set) или одному минту (string): владельцы ВСЕХ
*  затронутых аккаунтов — фильтрация по владельцу на совести потребителя.
 */
export async function fetchWalletDeltas(client, signature, mints) {
  const match = typeof mints === "string" ? (m) => m === mints : (m) => mints.has(m);
  const tx = await client.call("getTransaction", [
    signature,
    { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 1 },
  ]);
  if (tx === null) return null; // транзакция недоступна на этом эндпоинте — честный null

  const balances = new Map(); // `${owner}|${mint}` → дельта-аккаунт
  for (const b of tx.meta?.preTokenBalances ?? []) {
    if (!match(b.mint)) continue;
    balances.set(`${b.owner}|${b.mint}`, {
      owner: b.owner, mint: b.mint, preRaw: BigInt(b.uiTokenAmount.amount), postRaw: 0n,
    });
  }
  for (const b of tx.meta?.postTokenBalances ?? []) {
    if (!match(b.mint)) continue;
    const key = `${b.owner}|${b.mint}`;
    const cur = balances.get(key) ?? { owner: b.owner, mint: b.mint, preRaw: 0n, postRaw: 0n };
    cur.postRaw = BigInt(b.uiTokenAmount.amount);
    balances.set(key, cur);
  }

  // нулевые дельты (аккаунт создан и закрыт в одной tx) — шум, вырезаем
  const deltas = [...balances.values()]
    .map((b) => ({ ...b, deltaRaw: b.postRaw - b.preRaw }))
    .filter((b) => b.deltaRaw !== 0n);

  return {
    signature,
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    err: tx.meta?.err ?? null,
    deltas,
  };
}

/** Дельты одного минта — прежний контракт, делегирует набору. */
export function fetchTokenDeltas(client, signature, mint) {
  return fetchWalletDeltas(client, signature, mint);
}
