// Fail-closed сверка двух независимых источников правды (два RPC-эндпоинта).
// Принцип: расхождение НИКОГДА не разрешается угадыванием — affected записи
// помечаются и выбрасываются из верифицированного набора.
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

// ok = полная двойная идентичность; partial = односторонние пропуски;
// unverified = любые конфликты — весь вердикт понижается, fail-closed.
export function verdict(result) {
  if (result.conflicts.length > 0) return "unverified";
  if (result.onlyA.length > 0 || result.onlyB.length > 0) return "partial";
  return "ok";
}

// В потребление уходят ТОЛЬКО дважды подтверждённые записи.
// Односторонние и конфликтные выбрасываются — сознательный трейд-офф:
// недосчитать честнее, чем показать придуманное.
export function mergeVerified(result) {
  return [...result.agreed];
}
