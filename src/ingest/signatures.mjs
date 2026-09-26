// Stream of transaction signatures per mint: getSignaturesForAddress pagination.
// Failed (err) transactions are yielded with the flag — filtering is the consumer's job.
// Contracts (rounds 8-9):
//   — end of history is ONLY an empty page ("short" pages on soft-capped nodes ≠ end);
//   — uniqueness: one signature is never yielded twice (a stuck page gets deduped);
//   — a non-array response (result:null from a lying gateway) is an EXPLICIT error,
//     not a silent "end of history" (fail-closed);
//   — broken elements (null/no signature) are skipped; the cursor is the last valid one;
//   — termination: 2 consecutive pages WITHOUT new unique signatures = no progress
//     (alternating duplicates with different tails are caught too).
export async function* streamSignatures(client, mint, { limit = 100, maxPages = Infinity } = {}) {
  let before = undefined;
  const seen = new Set();
  let zeroProgressPages = 0;
  for (let page = 0; page < maxPages; page++) {
    const params = [mint, { limit, ...(before !== undefined ? { before } : {}) }];
    // scan-side traffic: the backfill must not jump the vitrine's point reads in the
    // shared RpcClient lanes (the priority contract)
    const batch = await client.call("getSignaturesForAddress", params, { priority: "low" });
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
      lastValid = s.signature; // cursor is the last valid element, duplicates included
    }
    if (added === 0 || lastValid === null || lastValid === before) {
      if (++zeroProgressPages >= 2) return;
    } else {
      zeroProgressPages = 0;
    }
    if (lastValid !== null) before = lastValid;
  }
}
