// Token deltas of a single transaction from getTransaction.
// maxSupportedTransactionVersion: 1 is mandatory — otherwise the entire scan dies
// on versioned transactions with -32015 (a September 2026 lesson; forget it and the scanner is dead).

/**
 * Deltas for a set of mints (Set) or a single mint (string): owners of ALL
 * affected accounts — owner filtering is the consumer's job.
 * opts.moneyMints (Set) additionally parses the money legs (USDC) of the same tx:
 * net deltas per owner land in moneyDeltas — the stable counter-leg is what turns a
 * transfer into a priced trade — and tracked mints touched with a zero net delta land
 * in zeroNetMints (a round-trip trace for the pricing rule). Without the option the
 * response shape is byte-identical to what every existing consumer expects.
 */
export async function fetchWalletDeltas(client, signature, mints, opts = {}) {
  const moneyMints = opts.moneyMints ?? null;
  const signal = opts.signal;
  const match = typeof mints === "string" ? (m) => m === mints : (m) => mints.has(m);
  const isMoney = (m) => moneyMints !== null && moneyMints.has(m);
  const tx = await client.call("getTransaction", [
    signature,
    { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 1 },
  ], signal ? { signal, priority: "low" } : { priority: "low" });
  // null — transaction unavailable on the endpoint; undefined — RPC answered with neither
  // result nor error (a lying/throttling gateway): both are an honest skip of one transaction,
  // not a TypeError that takes down the entire wallet scan 
  if (tx == null) return null;
  // a skeleton without meta (indexer lag/partial response) is NOT "none of
  // our mints" but unavailable source data: an honest null → the scan will mark "tx unavailable".
  // Such a tx used to vanish silently: fetched+1, in neither txs nor skipped.
  if (typeof tx !== "object" || tx.meta === null || tx.meta === undefined || typeof tx.meta !== "object") {
    return null;
  }

  // The key is accountIndex, NOT owner|mint: one owner can hold several token accounts
  // of the same mint (legacy + ATA), and a self-transfer between them is a delta of 0,
  // not a phantom buy. accountIndex is unique within a tx, so a key that receives a
  // SECOND balance of the same pass cannot be paired (which pre row belongs to which
  // post row is unknowable) — and Map.set would silently keep only the last row: a real
  // disposal nets against a phantom buy and vanishes as delta 0. An ambiguous key is
  // dropped WHOLE with a console.error — the key AND, when the ownership-change split
  // ran for it, the synthetic sibling the split created (leaving the sibling would book
  // the old owner a phantom disposal and make the money depend on the row order within
  // the pass); a UNIQUE owner|mint fallback key (one account
  // per owner+mint — the lying-gateway case) pairs exactly and stays.
  const byAccount = new Map(); // accountIndex → {owner, mint, preRaw, postRaw}
  const ambiguous = new Set(); // keys that got a second balance of one pass — unpairable
  const splitOf = new Map(); // key → the synthetic sibling its ownership-change split created
  for (const b of tx.meta?.preTokenBalances ?? []) {
    if (!match(b.mint) && !isMoney(b.mint)) continue;
    const key = b.accountIndex ?? `${b.owner}|${b.mint}`;
    if (byAccount.has(key)) { ambiguous.add(key); continue; }
    // An indexed row WITHOUT an owner is unpairable evidence (the lying-gateway class):
    // letting it in would fire the ownership-change branch against owner === undefined and
    // book a phantom disposal to the old owner plus an acquisition under the literal
    // undefined. The EMPTY STRING is the same class — typeof passes it, but no wallet is
    // ever "", so the split would book the acquisition under an owner no consumer can match.
    // It pairs with nothing → the same ambiguous verdict, dropped whole.
    if (typeof b.owner !== "string" || b.owner.length === 0) { ambiguous.add(key); continue; }
    byAccount.set(key, { owner: b.owner, mint: b.mint, preRaw: BigInt(b.uiTokenAmount.amount), postRaw: 0n });
  }
  const postSeen = new Set();
  for (const b of tx.meta?.postTokenBalances ?? []) {
    if (!match(b.mint) && !isMoney(b.mint)) continue;
    const key = b.accountIndex ?? `${b.owner}|${b.mint}`;
    if (postSeen.has(key)) { ambiguous.add(key); continue; }
    // Same verdict for an ownerless POST row (undefined, null or "" — a gateway is not
    // obliged to pick one): it cannot be paired against a pre entry without fabricating a
    // nonsense owner on one of the two sides — drop the pair whole.
    if (typeof b.owner !== "string" || b.owner.length === 0) { ambiguous.add(key); continue; }
    postSeen.add(key);
    const cur = byAccount.get(key);
    if (cur !== undefined && cur.mint !== b.mint) {
      // A token account cannot change its mint within a tx: a DIFFERENT mint under the same
      // accountIndex is a lying-gateway shape, and pairing it books the old owner a phantom
      // disposal of a mint that is no longer there and the new owner an unpriced lot of a
      // mint nobody bought — only the coarse reconciles:false would ever flag it. The rows
      // cannot be paired → the key is dropped WHOLE here, with its own warn: the generic
      // ambiguous template below says "a repeated accountIndex … second balance" and would
      // send the operator looking for a duplicate balance instead of a mint swap.
      console.error(`[tx] ${signature}: accountIndex ${key} carried mint ${cur.mint} before the pass and mint ${b.mint} after it — a token account cannot change its mint within a tx, the pre and post rows cannot be paired and pairing them would book a phantom disposal plus an unpriced lot; the whole owner+mint pair is dropped from this tx`);
      byAccount.delete(key);
      continue;
    }
    if (cur !== undefined && cur.owner !== b.owner) {
      // Token-account ownership change WITHIN a tx (SetAuthority on the account): the pre-entry
      // belongs to the old owner. Writing post to him would hide the transfer: his delta
      // becomes 0 and gets cut by the zero filter, and the new owner is not visible at all
      // (both lie in FIFO). Split into TWO entries: key now belongs to the new owner, the old
      // one moves under a synthetic key (Map.set on the same key would just overwrite the
      // pre-entry). The "owner|mint" fallback never reaches here — the fallback key already
      // contains the owner, so pre/post cannot meet there and the split falls out structurally.
      cur.postRaw = 0n; // the old owner keeps the full pre-balance, his delta = −preRaw
      const sibling = `${key}~${cur.owner}`;
      splitOf.set(key, sibling); // remembered: an ambiguity verdict on this key must drop the pair WHOLE
      byAccount.set(sibling, cur);
      byAccount.set(key, { owner: b.owner, mint: b.mint, preRaw: 0n, postRaw: BigInt(b.uiTokenAmount.amount) });
      continue;
    }
    const entry = cur ?? { owner: b.owner, mint: b.mint, preRaw: 0n, postRaw: 0n };
    entry.postRaw = BigInt(b.uiTokenAmount.amount);
    byAccount.set(key, entry);
  }
  for (const key of ambiguous) {
    const a = byAccount.get(key);
    if (a === undefined) continue;
    console.error(`[tx] ${signature}: a ${typeof key === "number" ? "repeated accountIndex" : "balance without accountIndex"} for owner ${a.owner}, mint ${a.mint} received a second balance of the same pass — the accounts cannot be paired and the delta would silently collapse; the whole owner+mint pair is dropped from this tx`);
    byAccount.delete(key);
    const sibling = splitOf.get(key);
    if (sibling !== undefined) byAccount.delete(sibling);
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

  // A tracked mint PRESENT in the balances with a zero net delta still leaves a trace:
  // getTransaction lists the accounts the tx touched, so an owner-level row with net 0
  // means the tx DID touch the token (a same-tx round-trip, a self-transfer between the
  // owner's own accounts). The pricing rule needs that trace: without it, a round-trip
  // mixed into a priced trade silently rode the trade's money leg — the spread ended up
  // in somebody else's proceeds. Money mints never land here even if registry drift ever
  // lists them as tracked — a zero-net money account rides along almost every swap and
  // is not a round-trip trace of a position.
  const zeroNetMints = [...byOwner.values()]
    .filter((d) => d.deltaRaw === 0n && match(d.mint) && !isMoney(d.mint))
    .map(({ owner, mint }) => ({ owner, mint }));

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
    blockTime: plausibleBlockTime(tx.blockTime, signature),
    err: tx.meta?.err ?? null,
    deltas,
    ...(moneyMints !== null ? { moneyDeltas, zeroNetMints } : {}),
  };
}

// blockTime is unix SECONDS from the endpoint. Solana had no blocks before 2020 and
// none in the future beyond clock skew: a value outside the window is a lying gateway,
// not a date. It normalizes to null — the same shape as a missing blockTime — so the
// consumers' existing incompleteness contracts apply (/accruals: baseIncomplete and the
// tx stays out of the base; /lots: acquiredDate:null) instead of comparing garbage:
// raw pass-through let a pre-epoch tx enter EVERY dividend base, silently dropped an
// absurd-future one, and 1e308 crashed /lots with a bare RangeError (toISOString over
// Infinity) — the "a garbage date is an error, not a silent comparison" discipline,
// bypassed on the whole tx path until now.
const BLOCK_TIME_MIN = 1_577_836_800; // 2020-01-01T00:00:00Z — before Solana's genesis
const BLOCK_TIME_MAX_SKEW = 86_400; // a full day of endpoint clock skew

function plausibleBlockTime(raw, signature) {
  if (raw == null) return null;
  const ok = typeof raw === "number" && Number.isFinite(raw)
    && raw >= BLOCK_TIME_MIN
    && raw <= Math.floor(Date.now() / 1000) + BLOCK_TIME_MAX_SKEW;
  if (ok) return raw;
  console.error(`[tx] ${signature}: blockTime ${JSON.stringify(raw)} is outside the plausible window [2020-01-01, now+1d] — normalized to null: the tx cannot be ordered against any date (/accruals flags baseIncomplete, /lots keeps acquiredDate:null)`);
  return null;
}

/** Deltas of a single mint — the original contract, delegates to the set variant. */
export function fetchTokenDeltas(client, signature, mint) {
  return fetchWalletDeltas(client, signature, mint);
}
