// Кошельковый скан: все транзакции адреса, токен-дельты только по минтам реестра.
// fail-closed: err-транзакции и недоступные — в skipped с причиной, не молча.
import { fetchWalletDeltas } from "../ingest/tx.mjs";

export const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

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
 * @param {RpcClient} client
 * @param {string} owner — адрес кошелька
 * @param {Array} registry — реестр токенов (нужны только .mint)
 * @param {object} [opts] maxTxs — потолок подписей (по умолчанию 300), limit — размер страницы,
 *   onProgress({fetched, total}) — колбэк после каждой транзакции
 * @returns {{owner, signatures:number, fetched:number, txs:Array, skipped:Array, truncated:boolean}}
 *   txs — хронологические (старейшие первыми), дельты всех владельцев (фильтр в отчёте)
 */
export async function scanWallet(client, owner, registry, { maxTxs = 300, limit = 100, onProgress } = {}) {
  if (!isValidAddress(owner)) {
    throw new WalletScanError("owner must be a base58 Solana pubkey", "invalid-address");
  }
  const mintSet = new Set(registry.map((t) => t.mint));

  // 1) собираем подписи новейшие-первыми до потолка (или конца истории)
  const sigs = [];
  let before;
  let truncated = false;
  for (;;) {
    const batch = await client.call("getSignaturesForAddress", [
      owner,
      { limit, ...(before !== undefined ? { before } : {}) },
    ]);
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const s of batch) {
      if (sigs.length >= maxTxs) { truncated = true; break; }
      sigs.push({ signature: s.signature, slot: s.slot, blockTime: s.blockTime ?? null, err: s.err ?? null });
    }
    if (truncated || batch.length < limit) break;
    before = batch[batch.length - 1].signature;
  }

  // 2) err-транзакции не fetch'им — это не история балансов, а мусор с причиной
  const skipped = [];
  const toFetch = [];
  for (const s of sigs) {
    if (s.err !== null) skipped.push({ signature: s.signature, reason: "tx failed on-chain" });
    else toFetch.push(s);
  }

  // 3) обрабатываем хронологически: getSignaturesForAddress отдаёт новейшие первыми
  const txs = [];
  let fetched = 0;
  for (const s of [...toFetch].reverse()) {
    const tx = await fetchWalletDeltas(client, s.signature, mintSet);
    fetched++;
    if (onProgress) onProgress({ fetched, total: toFetch.length });
    if (tx === null) {
      skipped.push({ signature: s.signature, reason: "tx unavailable on endpoint" });
      continue;
    }
    if (tx.deltas.length > 0) {
      txs.push({ signature: s.signature, slot: tx.slot, blockTime: tx.blockTime, deltas: tx.deltas });
    }
  }

  return { owner, signatures: sigs.length, fetched, txs, skipped, truncated };
}
