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

  // Ключ — accountIndex, НЕ owner|mint: у одного владельца бывает несколько
  // токен-аккаунтов одного минта (legacy + ATA), и самоперенос между ними —
  // это дельта 0, а не фантомная покупка. accountIndex уникален внутри tx.
  const byAccount = new Map(); // accountIndex → {owner, mint, preRaw, postRaw}
  for (const b of tx.meta?.preTokenBalances ?? []) {
    if (!match(b.mint)) continue;
    const key = b.accountIndex ?? `${b.owner}|${b.mint}`;
    byAccount.set(key, { owner: b.owner, mint: b.mint, preRaw: BigInt(b.uiTokenAmount.amount), postRaw: 0n });
  }
  for (const b of tx.meta?.postTokenBalances ?? []) {
    if (!match(b.mint)) continue;
    const key = b.accountIndex ?? `${b.owner}|${b.mint}`;
    const cur = byAccount.get(key) ?? { owner: b.owner, mint: b.mint, preRaw: 0n, postRaw: 0n };
    cur.postRaw = BigInt(b.uiTokenAmount.amount);
    byAccount.set(key, cur);
  }

  // Аггрегируем аккаунты до уровня владельца: дельта owner = сумма дельт его аккаунтов.
  // preRaw/postRaw — тоже суммы (для одиночного аккаунта форма ответа как раньше).
  // Нулевые дельты (самоперенос, аккаунт создан и закрыт в одной tx) — шум, вырезаем.
  const byOwner = new Map(); // `${owner}|${mint}` → суммарная дельта
  for (const a of byAccount.values()) {
    const key = `${a.owner}|${a.mint}`;
    const cur = byOwner.get(key) ?? { owner: a.owner, mint: a.mint, preRaw: 0n, postRaw: 0n, deltaRaw: 0n };
    cur.preRaw += a.preRaw;
    cur.postRaw += a.postRaw;
    cur.deltaRaw += a.postRaw - a.preRaw;
    byOwner.set(key, cur);
  }
  const deltas = [...byOwner.values()].filter((d) => d.deltaRaw !== 0n);

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
