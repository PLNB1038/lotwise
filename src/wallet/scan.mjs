// Wallet scan: transactions of the address AND of its token accounts for registry mints.
// Owner signatures alone are NOT enough: incoming transfers (the sender pays the fee)
// touch the token account but not the wallet address — the v1 scan lost them (live case EJBQ:
// 4 signatures instead of the full history). v2: address signatures + signatures of every live
// token account, deduplicated, plus current account balances to reconcile the report with the chain.
// Fail-closed: failed and unavailable txs go into skipped with a reason, not silently.
// signatures of the DERIVED ATA of every registry mint under BOTH token
// programs are queried independently of the listing — a closed ATA disappears from
// getTokenAccountsByOwner but its address stays derivable (a deterministic PDA) and the
// node keeps serving its history; with a delegate-signed disposal this was a TOTAL history
// loss certified complete:true.
// the account listing is requested with an explicit limit; a FULL page
// (no cursor pagination exists for this method) is indistinguishable from a provider-capped
// page and is treated as possibly-truncated — a loud operator warn + scan.truncated=true.
import { createHash } from "node:crypto";
import { fetchWalletDeltas } from "../ingest/tx.mjs";
import { MONEY_MINTS } from "./money.mjs";

export const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const TOKEN_PROGRAMS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // classic SPL (cross-checked against the owner of the USDC mint)
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022 (xStocks et al., cross-checked against the fixture)
];

export class WalletScanError extends Error {
  constructor(msg, kind = "invalid") {
    super(msg);
    this.name = "WalletScanError";
    this.kind = kind;
  }
}

// E4-1 : charset+length checks alone are too weak — "1"×41 passes the regex but does not
// decode to 32 bytes: the scanner burned RPC calls and answered 503 "rpc" on permanently broken input (the
// consumer's retry logic hammers it forever). Structural check: base58 → exactly 32 bytes;
// leading "1"s are zero bytes (hence "1"×32 = system program, structurally valid).
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_INDEX = new Map([...B58].map((ch, i) => [ch, i]));

export function isValidAddress(addr) {
  if (typeof addr !== "string" || !PUBKEY_RE.test(addr)) return false;
  let n = 0n;
  for (const ch of addr) n = n * 58n + BigInt(B58_INDEX.get(ch));
  let leadZeros = 0;
  while (addr[leadZeros] === "1") leadZeros++;
  let bytes = leadZeros;
  while (n > 0n) {
    bytes++;
    n >>= 8n;
  }
  return bytes === 32;
}

// ---------------------------------------------------------------------------
// Dependency-free PDA/ATA derivation (node:crypto sha256 + BigInt
// field arithmetic, no npm packages — a repo contract). The associated token account
// address is findProgramAddress([owner, tokenProgram, mint], ASSOC_TOKEN_PROGRAM):
// the hash output must land OFF the ed25519 curve — that is what makes the address
// program-owned. The on-curve check is a dalek-style decompress; every derived
// constant is computed from the curve definition (no hard-trusted 76-digit numbers)
// and the whole stack is pinned in test/ata-pda.test.mjs against vectors
// emitted by an independent Rust implementation (solders/curve25519-dalek).
// ---------------------------------------------------------------------------

// The SPL associated token account program: the owner of every ATA PDA.
export const ASSOC_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

// S4: the scanner asks for an EXPLICIT page size instead of trusting the endpoint
// default. getTokenAccountsByOwner has no cursor pagination: a full page cannot be
// distinguished from a provider-capped page, so it is treated as possibly-truncated.
export const ACCOUNTS_PAGE_LIMIT = 1000;

// ed25519: p = 2^255 − 19; curve −x² + y² = 1 + d·x²·y² with d = −121665/121666.
// d and √−1 are DERIVED (Fermat inversion and 2^((p−1)/4) mod p) — only p and the
// curve coefficient ratio are trusted, and they ARE the definition of the curve.
const ED_P = 2n ** 255n - 19n;

function modPow(base, exp, mod) {
  let r = 1n;
  let b = base % mod;
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) r = (r * b) % mod;
    b = (b * b) % mod;
  }
  return r;
}
const ED_D = ((ED_P - 121665n) * modPow(121666n, ED_P - 2n, ED_P)) % ED_P;
const ED_SQRT_M1 = modPow(2n, (ED_P - 1n) / 4n, ED_P); // √−1 in the field

export function encodeBase58(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  let i = 0;
  while (i < bytes.length && bytes[i] === 0) {
    out = `1${out}`; // leading zero bytes → leading "1"s (one-to-one)
    i++;
  }
  return out;
}

// 32-byte seed from an isValidAddress-checked string (the length contract is the caller's)
function decodeBase58To32(addr) {
  let n = 0n;
  for (const ch of addr) n = n * 58n + BigInt(B58_INDEX.get(ch));
  const out = new Uint8Array(32);
  let i = 31;
  while (n > 0n && i >= 0) {
    out[i--] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/**
 * Is `bytes` a compressed ed25519 point (somebody's pubkey, i.e. NOT a PDA)?
 * Dalek-style decompress: y from the little-endian bytes (bit 255 is the sign of x and
 * does not affect the verdict; non-canonical y ≥ p is rejected), then x² = (y²−1)/(d·y²+1)
 * is probed via the (p−5)/8 root formula with the √−1 second case, each candidate
 * verified by substitution — no verified root ⇒ off-curve ⇒ usable as a program address.
 */
export function isOnCurveEd25519(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  if (y >= ED_P) return false;
  const yy = (y * y) % ED_P;
  const u = (yy + ED_P - 1n) % ED_P; // y² − 1
  const v = (ED_D * yy + 1n) % ED_P; // d·y² + 1
  if (v === 0n) return u === 0n; // total function; unreachable for ed25519's d
  const v3 = ((v * v) % ED_P) * v % ED_P;
  const v7 = ((v3 * v3) % ED_P) * v % ED_P;
  let x = u * v3 % ED_P * modPow((u * v7) % ED_P, (ED_P - 5n) / 8n, ED_P) % ED_P;
  const onCurve = (c) => (v * ((c * c) % ED_P)) % ED_P === u; // v·x² == u ⇔ x² == u/v
  if (onCurve(x)) return true;
  x = (x * ED_SQRT_M1) % ED_P;
  return onCurve(x);
}

/**
 * Solana find_program_address: sha256(seeds… ‖ bump ‖ programId ‖ "ProgramDerivedAddress"),
 * bump 255→0, the first hash OFF the curve wins (an on-curve output would be somebody's
 * secret-key pubkey — never a program address).
 * @returns {{address: string, bump: number}}
 */
export function findProgramAddress(seeds, programIdBytes) {
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256");
    for (const seed of seeds) h.update(seed);
    h.update(Uint8Array.of(bump));
    h.update(programIdBytes);
    h.update("ProgramDerivedAddress");
    const out = h.digest(); // Buffer — a Uint8Array subclass
    if (!isOnCurveEd25519(out)) return { address: encodeBase58(out), bump };
  }
  throw new WalletScanError("no valid bump seed below 256 — bad PDA inputs", "pda-overflow");
}

/**
 * The associated token account of (owner, mint) under `tokenProgramId` — a deterministic
 * PDA derivable BEFORE creation and AFTER closing. That is the foundation of the S3 fix:
 * a closed ATA stops being listed by getTokenAccountsByOwner, but its address stays
 * computable and getSignaturesForAddress keeps answering with its full history.
 */
export function deriveAta(owner, mint, tokenProgramId) {
  if (!isValidAddress(owner) || !isValidAddress(mint) || !isValidAddress(tokenProgramId)) {
    throw new WalletScanError(
      `deriveAta needs three valid base58 pubkeys (owner, mint, token program), got ${JSON.stringify([owner, mint, tokenProgramId]).slice(0, 120)}`,
      "invalid-address",
    );
  }
  // spl-associated-token-account: seeds = [owner, token program, mint]
  return findProgramAddress(
    [decodeBase58To32(owner), decodeBase58To32(tokenProgramId), decodeBase58To32(mint)],
    decodeBase58To32(ASSOC_TOKEN_PROGRAM_ID),
  ).address;
}

/**
 * Current token accounts of the owner for registry mints.
 * @param {object} [opts] pageLimit — explicit page size for getTokenAccountsByOwner (S4);
 *   onAccountsPageCapped(programId) — called when a page comes back FULL (length >= limit):
 *   the listing is not certifiably complete, the scan must go fail-closed.
 * @returns {Promise<Map<string, {addresses: string[], currentRaw: bigint}>>}
 *   mint -> ALL accounts (ATA + legacy): balance = the sum, every address is scanned.
 *   One account per mint is the norm, but legacy wallets hold two: silently dropping
 *   one loses its history (a quiet lie), breaking the scan denies an honest wallet.
 */
export async function fetchOwnerTokenAccounts(client, owner, registry, {
  pageLimit = ACCOUNTS_PAGE_LIMIT,
  onAccountsPageCapped,
} = {}) {
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 1) {
    throw new WalletScanError(`bad accounts page limit: ${JSON.stringify(pageLimit)}`, "invalid-page-limit");
  }
  // programId is a pubkey too: a corrupt constant yields something far from the obvious -32602
  for (const pid of TOKEN_PROGRAMS) {
    if (!PUBKEY_RE.test(pid)) throw new WalletScanError(`bad token program id: ${pid}`, "invalid-program-id");
  }
  const mintSet = new Set(registry.map((t) => t.mint));
  const out = new Map();
  const add = (mint, address, amount) => {
    let cur = out.get(mint);
    if (!cur) {
      cur = { addresses: [], currentRaw: 0n };
      out.set(mint, cur);
    }
    if (address && !cur.addresses.includes(address)) cur.addresses.push(address);
    cur.currentRaw += amount;
  };
  // An account belongs to EXACTLY ONE token program, but a broken/proxying endpoint
  // may return the same pubkey in both responses. Dedup is global (across all programs,
  // first occurrence wins — TOKEN_PROGRAMS order is deterministic): previously
  // currentRaw was summed across responses without accounting for the pubkey — 7+7=14, a phantom
  // double balance produced a false reconciles:false. The conflict is not silent: a warn goes to the operator
  // pattern — observability instead of silent loss).
  const seenPubkeys = new Set();
  for (const programId of TOKEN_PROGRAMS) {
    const res = await client.call("getTokenAccountsByOwner", [
      owner,
      { programId },
      // S4: explicit page size — the scanner controls the page instead of trusting a
      // provider default it cannot see
      { encoding: "jsonParsed", commitment: "confirmed", limit: pageLimit },
    ]);
    // a non-array from the gateway is an EXPLICIT malformed-source (mirror of
    // an "empty account set" from a lying source is indistinguishable from zero.
    if (!Array.isArray(res?.value)) {
      throw new WalletScanError(
        `malformed getTokenAccountsByOwner response: expected array, got ${res?.value === null ? "null" : typeof res?.value}`,
        "malformed-source",
      );
    }
    // S4: a FULL page is a truncation we cannot see past — the method has no cursor
    // pagination, so "length >= limit" means accounts MAY exist beyond the page (a provider
    // cap and a genuinely full page are indistinguishable). Not certifying this would
    // silently erase positions: a loud warn + truncated.
    if (res.value.length >= pageLimit) {
      console.error(`[wallet-scan] ${owner}: getTokenAccountsByOwner returned a FULL page (${res.value.length} >= limit ${pageLimit}) for ${programId} — accounts beyond the page are unreachable and the listing may be capped; the scan is marked truncated (fail-closed)`);
      onAccountsPageCapped?.(programId);
    }
    for (const entry of res.value) {
      if (entry === null || typeof entry !== "object") continue;
      const info = entry?.account?.data?.parsed?.info;
      if (!info || !mintSet.has(info.mint)) continue;
      const address = typeof entry.pubkey === "string" ? entry.pubkey : null;
      // a broken pubkey does not become a signature source (E4 class: "1"×41 burned RPC and crashed
      // the scan on -32602); garbage amount ("1e6") does not silently enter the reconciliation — both
      // are skipped with a warn: observability instead of a quiet lie
      if (address !== null && !isValidAddress(address)) {
        console.error(`[wallet-scan] ${owner}: account with invalid pubkey ${JSON.stringify(entry.pubkey).slice(0, 60)} skipped (not a signature source, not a balance)`);
        continue;
      }
      // No tokenAmount → 0n, but the address remains a signature source (legacy contract
      // wallet-edge: "a zero balance is still scanned"). Garbage amount ("1e6",
      // 1.5) — skip with a warn: a silent 0n without a warning = silent loss of the reconciliation.
      const amountRaw = info.tokenAmount?.amount;
      let amt = 0n;
      if (amountRaw !== undefined && amountRaw !== null) {
        const rawOk = (typeof amountRaw === "number" && Number.isSafeInteger(amountRaw) && amountRaw >= 0)
          || (typeof amountRaw === "string" && /^\d+$/.test(amountRaw));
        if (!rawOk) {
          console.error(`[wallet-scan] ${owner}: account ${address ?? "?"} with garbage balance amount ${JSON.stringify(amountRaw)} skipped`);
          continue;
        }
        amt = BigInt(amountRaw);
      }
      if (address !== null) {
        if (seenPubkeys.has(address)) {
          console.error(`[wallet-scan] ${owner}: account ${address} seen again across token-program responses — an account belongs to exactly one program; the first occurrence wins, the duplicate did not go into the sum (otherwise the balance doubles and reconcile fails spuriously)`);
          continue;
        }
        seenPubkeys.add(address);
      }
      add(info.mint, address, amt);
    }
  }
  return out;
}

/**
 * @param {RpcClient} client
 * @param {string} owner — wallet address
 * @param {Array} registry — token registry (only .mint is needed)
 * @param {object} [opts] maxTxs — cap on signatures PER SOURCE (the address or each account),
 *   onProgress({fetched, total}) — after every transaction
 * @returns {{owner, signatures, fetched, txs, skipped, truncated, accounts, ambiguousSlotPairs, derivedSources}}
 *   txs — chronological (oldest first), deltas of all owners (filtered in the report);
 *   accounts — Map mint->{address, currentRaw} for balance reconciliation;
 *   derivedSources — S3: ATA addresses queried as signature sources by derivation (not the listing).
 */
export async function scanWallet(client, owner, registry, { maxTxs = 300, limit = 100, onProgress, signal } = {}) {
  if (!isValidAddress(owner)) {
    throw new WalletScanError("owner must be a base58 Solana pubkey", "invalid-address");
  }
  // Abort propagation : a departed client stops the scan between
  // pages/transactions — the RPC quota is not burned into the void
  const aborted = () => {
    if (signal?.aborted) throw new WalletScanError("scan aborted by client", "aborted");
  };
  const mintSet = new Set(registry.map((t) => t.mint));
  let accountsTruncated = false; // S4: a full listing page ⇒ completeness is not certifiable
  const accounts = await fetchOwnerTokenAccounts(client, owner, registry, {
    onAccountsPageCapped: () => { accountsTruncated = true; },
  });

  // 1) signatures per source: wallet address + ALL token accounts of registry mints
  //    + the DERIVED ATAs of registry mints (S3, independent of the listing).
  const liveAddresses = [...accounts.values()].flatMap((a) => a.addresses).filter(Boolean);
  // S3: a CLOSED token account is absent from the listing but remains a signature source —
  // its ATA address is a deterministic PDA (computable after closing) and the node still
  // serves its history (with a delegate-signed disposal this was a TOTAL loss).
  // Derive the ATA of every registry mint under BOTH token programs; addresses already
  // known from the live listing are skipped (one address = one walk, no wasted RPC).
  // Derived sources go LAST so the source order of the listed ones — and the same-slot
  // tiebreak semantics built on it — stays byte-for-byte unchanged.
  const seenSources = new Set([owner, ...liveAddresses]);
  const derivedSources = [];
  for (const { mint } of registry) {
    if (!isValidAddress(mint)) {
      // a registry mint that is not a pubkey can never match an on-chain account either —
      // skip the derivation loudly instead of crashing the scan
      console.error(`[wallet-scan] ${owner}: registry mint ${JSON.stringify(mint).slice(0, 60)} is not a valid base58 pubkey — ATA derivation skipped (no derived signature source)`);
      continue;
    }
    for (const programId of TOKEN_PROGRAMS) {
      const ata = deriveAta(owner, mint, programId);
      if (seenSources.has(ata)) continue;
      seenSources.add(ata);
      derivedSources.push(ata);
    }
  }
  const sources = [owner, ...liveAddresses, ...derivedSources];
  const sigs = new Map(); // signature -> {slot, blockTime, err, src, idx} (dedup across sources)
  let truncated = false;
  for (const [srcIdx, source] of sources.entries()) {
    let before;
    let taken = 0;
    let srcTruncated = false; // per-source flag: one hit its cap — the rest are scanned to their own caps in full
    let zeroProgressPages = 0; // alternating duplicate pages = no progress
    for (;;) {
      aborted();
      const batch = await client.call("getSignaturesForAddress", [
        source,
        { limit, ...(before !== undefined ? { before } : {}) },
      ]);
      // Non-array (result:null from a lying gateway) is an EXPLICIT error, not a silent
      // "end of history" with truncated:false: "empty wallet" is indistinguishable
      // from "the source died" — a fail-closed violation).
      if (!Array.isArray(batch)) {
        throw new WalletScanError(
          `malformed getSignaturesForAddress response: expected array, got ${batch === null ? "null" : typeof batch}`,
          "malformed-source",
        );
      }
      // End of history — an EMPTY page only: a "short" page at endpoints
      // with soft caps / a lagging indexer does not mean "nothing beyond".
      if (batch.length === 0) break;
      let added = 0;
      let lastValid = null;
      for (const s of batch) {
        // broken entry (null/no signature) — skip, not a TypeError for the whole scan
        //, class); the cursor advances by the last valid one
        if (s === null || typeof s !== "object" || typeof s.signature !== "string") continue;
        if (taken >= maxTxs) { srcTruncated = true; break; }
        if (!sigs.has(s.signature)) {
          // src/idx preserve the collection topology: within ONE source the list is
          // reverse-ledger (a later idx = an earlier block position), while ACROSS sources
          // the ledger order of a same-slot pair is not recoverable from the RPC at all
          sigs.set(s.signature, { slot: s.slot, blockTime: s.blockTime ?? null, err: s.err ?? null, src: srcIdx, idx: taken });
          // taken AFTER dedup: the cap counts UNIQUE signatures (see.
          taken++;
          added++;
        }
        lastValid = s.signature;
      }
      if (srcTruncated) break;
      if (added === 0 || lastValid === null || lastValid === before) {
        if (++zeroProgressPages >= 2) break;
      } else {
        zeroProgressPages = 0;
      }
      if (lastValid !== null) before = lastValid;
    }
    if (srcTruncated) truncated = true;
  }

  // 2) failed txs are not fetched — that is not balance history but garbage with a reason
  const skipped = [];
  const toFetch = [];
  for (const [signature, s] of sigs) {
    if (s.err !== null) skipped.push({ signature, reason: "tx failed on-chain" });
    else toFetch.push({ signature, ...s });
  }

  // 3) processed chronologically: collection went newest-first.
  // Sort by slot: always present and monotonic; blockTime can be null, and mixing
  // seconds and slots in one comparator means units of different orders. slot from a broken
  // endpoint can be undefined — ?? 0 gives a definite order (H3-6).
  // WITHIN one slot the stable sort would keep the list order — and the node lists the
  // later block position first (reverse ledger order), so a same-slot buy→sell reached
  // the FIFO as sell→buy: a spurious gap with the proceeds booked into the hole plus a
  // phantom open lot, the trade gone from realized P&L. Within a source the tiebreak is
  // the collection sequence (collected LATER = earlier in the block). ACROSS sources
  // (the owner page vs a token-account page) the ledger order of a same-slot pair is not
  // recoverable from the responses at all: the order below is a deterministic GUESS
  // (source order), and every such pair is counted into ambiguousSlotPairs so the report
  // can withdraw its completeness certificate.
  const ordered = toFetch.sort((a, b) =>
    (a.slot ?? 0) - (b.slot ?? 0) || (a.src === b.src ? b.idx - a.idx : a.src - b.src));
  const txs = [];
  let fetched = 0;
  const slotSrcs = new Map(); // slot -> Map(src -> kept count): every cross-source same-slot pair is unknowable
  for (const s of ordered) {
    aborted();
    let tx;
    try {
      tx = await fetchWalletDeltas(client, s.signature, mintSet, { moneyMints: MONEY_MINTS });
    } catch (err) {
      // ONE poisoned tx (garbage meta from a lying gateway,
      // a permanent RpcError on a versioned tx) crashed the ENTIRE scan — the wallet became
      // permanently unscannable, the consumer hammered it with 503 retries. The contract
      // "broken tx = skipped with a reason" must cover THROWN errors too, not only null.
      // Our own abort (WalletScanError) is not swallowed — it propagates.
      if (err instanceof WalletScanError) throw err;
      skipped.push({ signature: s.signature, reason: `tx unreadable: ${err?.code ? `${err.code}: ` : ""}${String(err?.message ?? err).slice(0, 120)}` });
      fetched++;
      if (onProgress) onProgress({ fetched, total: ordered.length });
      continue;
    }
    fetched++;
    if (onProgress) onProgress({ fetched, total: ordered.length });
    if (tx === null) {
      skipped.push({ signature: s.signature, reason: "tx unavailable on endpoint" });
      continue;
    }
    if (tx.err !== null) {
      // meta.err as FACT beats err from the signature list: lists sometimes carry err:null for
      // failed txs, while fetchWalletDeltas honestly carried meta.err into the err field. Previously
      // the reconciliation used only the signature err — a failed tx with diverging pre/post
      // (broken endpoint; on a live chain a rollback yields pre==post) fed the FIFO
      // a phantom delta. Semantics "failed = does not affect the balance": deltas of such
      // a tx do not enter the history.
      skipped.push({ signature: s.signature, reason: "failed-tx" });
      continue;
    }
    // Kept: token deltas (FIFO material) OR a non-empty money leg. A round-trip in ONE tx
    // (a multi-hop swap that buys and sells the same token) nets the token delta to 0, and
    // dropping the tx here lost its USDC leg entirely: the spread was invisible in
    // realized and in gaps, silently OVERSTATING realized P&L. The report books money-only
    // legs into its moneyOnly section. Order observability stays FIFO-only below: a
    // money-only tx has no lots, its position cannot flip FIFO math — it must neither
    // create nor mask a same-slot pair.
    const hasTokenDeltas = tx.deltas.length > 0;
    const hasMoneyLeg = Array.isArray(tx.moneyDeltas) && tx.moneyDeltas.length > 0;
    if (hasTokenDeltas || hasMoneyLeg) {
      if (hasTokenDeltas) {
        let bySrc = slotSrcs.get(s.slot);
        if (!bySrc) { bySrc = new Map(); slotSrcs.set(s.slot, bySrc); }
        bySrc.set(s.src, (bySrc.get(s.src) ?? 0) + 1);
      }
      txs.push({
        signature: s.signature,
        slot: tx.slot,
        blockTime: tx.blockTime,
        deltas: tx.deltas,
        ...(tx.moneyDeltas !== undefined ? { moneyDeltas: tx.moneyDeltas } : {}), // the USDC leg
      });
    }
  }

  // every UNORDERED pair of kept same-slot txs from two different sources is unknowable:
  // C(k,2) − Σ C(k_src,2) per slot — adjacency after the sort would undercount (a sorted
  // run interleaves sources, and a skipped tx in between breaks neighbours)
  let ambiguousSlotPairs = 0;
  for (const bySrc of slotSrcs.values()) {
    if (bySrc.size < 2) continue;
    let k = 0;
    let within = 0;
    for (const n of bySrc.values()) {
      k += n;
      within += (n * (n - 1)) / 2;
    }
    ambiguousSlotPairs += (k * (k - 1)) / 2 - within;
  }

  return {
    owner,
    signatures: sigs.size,
    fetched,
    txs,
    skipped,
    truncated: truncated || accountsTruncated, // S4: a capped/full listing page counts too
    accounts,
    ambiguousSlotPairs,
    derivedSources, // S3: observability — how many sources came from derivation, not the listing
  };
}
