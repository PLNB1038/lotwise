// Fail-closed reconciliation of two independent sources of truth (two RPC endpoints).
// Principle: a divergence is NEVER resolved by guessing — affected entries
// are flagged and dropped from the verified set.
const COMPARE_FIELDS = ["slot", "deltaRaw", "owner", "mint"];

export function reconcileSnapshots(a, b) {
  const idxB = new Map(b.entries.map((e) => [e.key, e]));
  const idxA = new Map(a.entries.map((e) => [e.key, e]));

  const agreed = [];
  const conflicts = [];
  const onlyA = [];
  const onlyB = [];

  for (const ea of a.entries) {
    const eb = idxB.get(ea.key);
    if (eb === undefined) {
      onlyA.push(ea);
      continue;
    }
    const diff = COMPARE_FIELDS.filter((f) => ea[f] !== eb[f]);
    if (diff.length === 0) agreed.push(ea);
    else conflicts.push({ key: ea.key, a: ea, b: eb, reason: diff });
  }
  for (const eb of b.entries) {
    if (!idxA.has(eb.key)) onlyB.push(eb);
  }

  return {
    agreed,
    onlyA,
    onlyB,
    conflicts,
    stats: { agreed: agreed.length, onlyA: onlyA.length, onlyB: onlyB.length, conflicts: conflicts.length },
  };
}

// ok = full double agreement; partial = one-sided gaps;
// unverified = any conflicts — the whole verdict is downgraded, fail-closed.
export function verdict(result) {
  if (result.conflicts.length > 0) return "unverified";
  if (result.onlyA.length > 0 || result.onlyB.length > 0) return "partial";
  return "ok";
}

// Only twice-confirmed entries go to consumption.
// One-sided and conflicting ones are dropped — a deliberate trade-off:
// undercounting is more honest than showing something made up.
export function mergeVerified(result) {
  return [...result.agreed];
}
