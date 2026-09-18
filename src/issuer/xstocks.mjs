// Клиент источника эмитента xStocks (Backed): множители корпоративных событий.
// Данные — сырые наблюдения; маппинг в канонические события — отдельный слой
// (вопрос моделирования multiplier-vs-integer-lots вынесен в отдельный слой).
// Числа-множители храним КАК СТРОКИ: в нашем пайплайне нет float.
export class IssuerError extends Error {
  constructor(msg, { status } = {}) {
    super(msg);
    this.name = "IssuerError";
    this.status = status;
  }
}

const BASE = "https://api.xstocks.fi/api/v2/public/assets";

async function getJson(url, fetcher = fetch) {
  let res;
  try {
    res = await fetcher(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; Lotwise/0.1)" } });
  } catch (err) {
    throw new IssuerError(`network: ${err.message}`);
  }
  if (!res.ok) throw new IssuerError(`HTTP ${res.status} for ${url}`, { status: res.status });
  try {
    return await res.json();
  } catch (err) {
    throw new IssuerError(`bad JSON from ${url}: ${err.message}`);
  }
}

// Число из API -> строка-десятичная, без float-математики в пайплайне.
const asDecimalString = (v) =>
  typeof v === "number" && Number.isFinite(v) ? String(v) : null;

/**
 * Текущий (и ожидающий активации) множитель символа.
 * @returns {{currentMultiplier: string, pendingMultiplier: string|null, activationDateTime: string|null, reason: string|null}}
 */
export async function fetchCurrentMultiplier(symbol, network = "Solana", { fetcher = fetch } = {}) {
  const j = await getJson(`${BASE}/${encodeURIComponent(symbol)}/multiplier?network=${encodeURIComponent(network)}`, fetcher);
  if (j?.currentMultiplier === undefined) throw new IssuerError(`unexpected multiplier payload for ${symbol}`);
  const pending = asDecimalString(j.newMultiplier);
  return {
    currentMultiplier: asDecimalString(j.currentMultiplier),
    pendingMultiplier: pending !== null && Number(pending) !== 0 ? pending : null,
    activationDateTime: j.activationDateTime && Number(j.activationDateTime) !== 0 ? j.activationDateTime : null,
    reason: j.reason ?? null,
  };
}

/**
 * История изменений множителя (реальные корпоративные события).
 * @returns {{hasNextPage: boolean, nodes: Array<{id: string, reason: string, multiplier: string, previousMultiplier: string, activationDateTime: string}>}}
 */
export async function fetchMultiplierHistory(symbol, network = "Ethereum", { page = 0, pageSize = 25, fetcher = fetch } = {}) {
  const j = await getJson(
    `${BASE}/${encodeURIComponent(symbol)}/multiplier/history?page=${page}&pageSize=${pageSize}&network=${encodeURIComponent(network)}`,
    fetcher,
  );
  if (!Array.isArray(j?.nodes)) throw new IssuerError(`unexpected history payload for ${symbol}`);
  return {
    hasNextPage: Boolean(j.page?.hasNextPage),
    nodes: j.nodes.map((n) => ({
      id: n.id,
      reason: n.reason,
      multiplier: asDecimalString(n.multiplier),
      previousMultiplier: asDecimalString(n.previousMultiplier),
      activationDateTime: n.activationDateTime,
    })),
  };
}
