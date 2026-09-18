// Кошельковый скан: транзакции адреса И его токен-аккаунтов реестровых минтов.
// Только подписи владельца НЕДОВОСТАТОЧНО: входящие переводы (fee платит отправитель)
// касаются token-аккаунта, но не адреса кошелька — скан v1 их терял (живой кейс EJBQ:
// 4 подписи вместо всей истории). v2: сигнатуры адреса + сигнатуры каждого живого
// token-аккаунта, дедуп, плюс текущие балансы аккаунтов для сверки отчёта с цепью.
// fail-closed: err-транзакции и недоступные — в skipped с причиной, не молча.
import { fetchWalletDeltas } from "../ingest/tx.mjs";

export const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const TOKEN_PROGRAMS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // классический SPL (сверен с owner минта USDC)
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022 (xStocks и др., сверен с фикстурой)
];

export class WalletScanError extends Error {
  constructor(msg, kind = "invalid") {
    super(msg);
    this.name = "WalletScanError";
    this.kind = kind;
  }
}

export function isValidAddress(addr) {
  return typeof addr === "string" && PUBKEY_RE.test(addr);
}

/**
 * Текущие token-аккаунты владельца по минтам реестра.
 * @returns {Promise<Map<string, {address: string, currentRaw: bigint}>>} mint -> аккаунт
 */
export async function fetchOwnerTokenAccounts(client, owner, registry) {
  // programId — тоже pubkey: кривая константа даёт далёкий от очевидного -32602
  for (const pid of TOKEN_PROGRAMS) {
    if (!PUBKEY_RE.test(pid)) throw new WalletScanError(`bad token program id: ${pid}`, "invalid-program-id");
  }
  const mintSet = new Set(registry.map((t) => t.mint));
  const out = new Map();
  for (const programId of TOKEN_PROGRAMS) {
    const res = await client.call("getTokenAccountsByOwner", [
      owner,
      { programId },
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]);
    for (const entry of res?.value ?? []) {
      const info = entry?.account?.data?.parsed?.info;
      if (!info || !mintSet.has(info.mint)) continue;
      const cur = out.get(info.mint); // параллельных программ на одном минте не бывает — но не молчим
      const amount = BigInt(info.tokenAmount?.amount ?? "0");
      if (cur && cur.currentRaw !== amount) {
        throw new WalletScanError(`two accounts for mint ${info.mint} with different balances`, "ambiguous-accounts");
      }
      out.set(info.mint, { address: entry.pubkey ?? null, currentRaw: amount });
    }
  }
  return out;
}

/**
 * @param {RpcClient} client
 * @param {string} owner — адрес кошелька
 * @param {Array} registry — реестр токенов (нужны только .mint)
 * @param {object} [opts] maxTxs — потолок подписей НА ИСТОЧНИК (адрес или каждый аккаунт),
 *   onProgress({fetched, total}) — после каждой транзакции
 * @returns {{owner, signatures, fetched, txs, skipped, truncated, accounts}}
 *   txs — хронологические (старейшие первыми), дельты всех владельцев (фильтр в отчёте);
 *   accounts — Map mint->{address, currentRaw} для сверки балансов
 */
export async function scanWallet(client, owner, registry, { maxTxs = 300, limit = 100, onProgress } = {}) {
  if (!isValidAddress(owner)) {
    throw new WalletScanError("owner must be a base58 Solana pubkey", "invalid-address");
  }
  const mintSet = new Set(registry.map((t) => t.mint));
  const accounts = await fetchOwnerTokenAccounts(client, owner, registry);

  // 1) сигнатуры по каждому источнику: адрес кошелька + токен-аккаунты реестровых минтов
  const sources = [owner, ...[...accounts.values()].map((a) => a.address).filter(Boolean)];
  const sigs = new Map(); // signature -> {slot, blockTime, err} (дедуп по источникам)
  let truncated = false;
  for (const source of sources) {
    let before;
    let taken = 0;
    for (;;) {
      const batch = await client.call("getSignaturesForAddress", [
        source,
        { limit, ...(before !== undefined ? { before } : {}) },
      ]);
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const s of batch) {
        if (taken >= maxTxs) { truncated = true; break; }
        taken++;
        if (!sigs.has(s.signature)) {
          sigs.set(s.signature, { slot: s.slot, blockTime: s.blockTime ?? null, err: s.err ?? null });
        }
      }
      if (truncated || batch.length < limit) break;
      before = batch[batch.length - 1].signature;
    }
  }

  // 2) err-транзакции не fetch'им — это не история балансов, а мусор с причиной
  const skipped = [];
  const toFetch = [];
  for (const [signature, s] of sigs) {
    if (s.err !== null) skipped.push({ signature, reason: "tx failed on-chain" });
    else toFetch.push({ signature, ...s });
  }

  // 3) обрабатываем хронологически: сборка шла новейшими-первыми
  const ordered = toFetch.sort((a, b) => (b.blockTime ?? b.slot) - (a.blockTime ?? a.slot)).reverse();
  const txs = [];
  let fetched = 0;
  for (const s of ordered) {
    const tx = await fetchWalletDeltas(client, s.signature, mintSet);
    fetched++;
    if (onProgress) onProgress({ fetched, total: ordered.length });
    if (tx === null) {
      skipped.push({ signature: s.signature, reason: "tx unavailable on endpoint" });
      continue;
    }
    if (tx.deltas.length > 0) {
      txs.push({ signature: s.signature, slot: tx.slot, blockTime: tx.blockTime, deltas: tx.deltas });
    }
  }

  return { owner, signatures: sigs.size, fetched, txs, skipped, truncated, accounts };
}
