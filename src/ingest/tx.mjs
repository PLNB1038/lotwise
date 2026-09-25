// Token deltas of a single transaction from getTransaction.
// maxSupportedTransactionVersion: 1 is mandatory — otherwise the entire scan dies
// on versioned transactions with -32015 (a September 2026 lesson; forget it and the scanner is dead).

/**
 * Deltas for a set of mints (Set) or a single mint (string): owners of ALL
 * affected accounts — owner filtering is the consumer's job.
 * opts.moneyMints (Set) additionally parses the money legs (USDC) of the same tx:
 * net deltas per owner land in moneyDeltas — the stable counter-leg is what turns a
 * transfer into a priced trade (round 21). Without the option the response shape is
 * byte-identical to what every existing consumer expects.
 */
export async function fetchWalletDeltas(client, signature, mints, opts = {}) {
  const moneyMints = opts.moneyMints ?? null;
  const match = typeof mints === "string" ? (m) => m === mints : (m) => mints.has(m);
  const isMoney = (m) => moneyMints !== null && moneyMints.has(m);
  const tx = await client.call("getTransaction", [
    signature,
    { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 1 },
  ]);
  // null — transaction unavailable on the endpoint; undefined — RPC answered with neither
  // result nor error (a lying/throttling gateway): both are an honest skip of one transaction,
  // not a TypeError that takes down the entire wallet scan (round 7 fix 14)
  if (tx == null) return null;
  // Wave H3-4 [P2]: a skeleton without meta (indexer lag/partial response) is NOT "none of
  // our mints" but unavailable source data: an honest null → the scan will mark "tx unavailable".
  // Such a tx used to vanish silently: fetched+1, in neither txs nor skipped.
  if (typeof tx !== "object" || tx.meta === null || tx.meta === undefined || typeof tx.meta !== "object") {
    return null;
  }

  // The key is accountIndex, NOT owner|mint: one owner can hold several token accounts
  // of the same mint (legacy + ATA), and a self-transfer between them is a delta of 0,
  // not a phantom buy. accountIndex is unique within a tx.
  const byAccount = new Map(); // accountIndex → {owner, mint, preRaw, postRaw}
  for (const b of tx.meta?.preTokenBalances ?? []) {
    if (!match(b.mint) && !isMoney(b.mint)) continue;
    const key = b.accountIndex ?? `${b.owner}|${b.mint}`;
    byAccount.set(key, { owner: b.owner, mint: b.mint, preRaw: BigInt(b.uiTokenAmount.amount), postRaw: 0n });
  }
  for (const b of tx.meta?.postTokenBalances ?? []) {
    if (!match(b.mint) && !isMoney(b.mint)) continue;
    const key = b.accountIndex ?? `${b.owner}|${b.mint}`;
    const cur = byAccount.get(key);
    if (cur !== undefined && cur.owner !== b.owner) {
      // Token-account ownership change WITHIN a tx (SetAuthority on the account): the pre-entry
      // belongs to the old owner. Writing post to him would hide the transfer: his delta
      // becomes 0 and gets cut by the zero filter, and the new owner is not visible at all
      // (both lie in FIFO). Split into TWO entries: key now belongs to the new owner, the old
      // one moves under a synthetic key (Map.set on the same key would just overwrite the
      // pre-entry). The "owner|mint" fallback never reaches here — the fallback key already
      // contains the owner, so pre/post cannot meet there and the split falls out structurally.
      cur.postRaw = 0n; // the old owner keeps the full pre-balance, his delta = −preRaw
      byAccount.set(`${key}~${cur.owner}`, cur);
      byAccount.set(key, { owner: b.owner, mint: b.mint, preRaw: 0n, postRaw: BigInt(b.uiTokenAmount.amount) });
      continue;
    }
    const entry = cur ?? { owner: b.owner, mint: b.mint, preRaw: 0n, postRaw: 0n };
    entry.postRaw = BigInt(b.uiTokenAmount.amount);
    byAccount.set(key, entry);
  }

  // Aggregate accounts up to the owner level: an owner's delta = sum of his accounts' deltas.
  // preRaw/postRaw are sums too (for a single account the response shape is as before).
  // Zero deltas (self-transfer, account created and closed within one tx) are noise — cut them.
  const byOwner = new Map(); // `${owner}|${mint}` → total delta
  for (const a of byAccount.values()) {
    const key = `${a.owner}|${a.mint}`;
    const cur = byOwner.get(key) ?? { owner: a.owner, mint: a.mint, preRaw: 0n, postRaw: 0n, deltaRaw: 0n };
    cur.preRaw += a.preRaw;
    cur.postRaw += a.postRaw;
    cur.deltaRaw += a.postRaw - a.preRaw;
    byOwner.set(key, cur);
  }
  const deltas = [...byOwner.values()].filter((d) => d.deltaRaw !== 0n && !isMoney(d.mint));

  // Money legs: the same owner-level aggregation, kept separately so the report can
  // price trades without confusing a stable leg with a tracked position.
  let moneyDeltas;
  if (moneyMints !== null) {
    moneyDeltas = [...byOwner.values()]
      .filter((d) => d.deltaRaw !== 0n && isMoney(d.mint))
      .map(({ owner, mint, deltaRaw }) => ({ owner, mint, deltaRaw }));
  }

  return {
    signature,
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    err: tx.meta?.err ?? null,
    deltas,
    ...(moneyMints !== null ? { moneyDeltas } : {}),
  };
}

/** Deltas of a single mint — the original contract, delegates to the set variant. */
export function fetchTokenDeltas(client, signature, mint) {
  return fetchWalletDeltas(client, signature, mint);
}
