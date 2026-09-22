// Клиент GeckoTerminal: пулы токена и дневные OHLCV (без ключа).
// Троттл/ретраи — та же дисциплина, что у RpcClient: 429/5xx/сеть — повтор,
// прочие HTTP — сразу ошибка с kind. Цены — float-НАБЛЮДЕНИЯ (не суммы!):
// целочисленное правило проекта касается количеств и множителей, не котировок.
export class PriceError extends Error {
  constructor(kind, message, { status } = {}) {
    super(message);
    this.name = "PriceError";
    this.kind = kind; // "rate-limit" | "http" | "network" | "parse"
    this.status = status;
  }
}

export class GeckoTerminalClient {
  constructor({
    endpoint = "https://api.geckoterminal.com/api/v2",
    fetcher = fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    minIntervalMs = 350,
    maxRetries = 2,
  } = {}) {
    this.endpoint = endpoint;
    this.fetcher = fetcher;
    this.sleep = sleep;
    this.minIntervalMs = minIntervalMs;
    this.maxRetries = maxRetries;
    this._lastCall = 0;
    this.requestCount = 0;
    this._queue = Promise.resolve();
  }

  // Выдержка интервала работает только внутри очереди (порт из RpcClient,
  // раунд 5): конкурентные вызовы (параллельные GET /crosscheck по разным
  // символам) встают в хвост, иначе все считают wait от одного _lastCall
  // и уходят залпом → 429 → ретраи усиливают шторм. Провал слота не должен
  // отравить хвост.
  async _throttle() {
    const turn = this._queue.then(async () => {
      const wait = this._lastCall + this.minIntervalMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      this._lastCall = Date.now();
    });
    this._queue = turn.then(() => {}, () => {});
    await turn;
  }

  async _get(path) {
    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(this.minIntervalMs * 2 ** attempt);
      await this._throttle();
      this.requestCount++;
      let res;
      try {
        res = await this.fetcher(`${this.endpoint}${path}`, {
          headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; Lotwise/0.1)" },
        });
      } catch (err) {
        lastErr = new PriceError("network", err.message);
        continue;
      }
      if (res.status === 429) { lastErr = new PriceError("rate-limit", "HTTP 429", { status: 429 }); continue; }
      if (!res.ok) {
        // прочие 4xx (404 пула, 403) — не транзиентность: сразу ошибка, без ретраев
        if (res.status < 500) throw new PriceError("http", `HTTP ${res.status}`, { status: res.status });
        lastErr = new PriceError("http", `HTTP ${res.status}`, { status: res.status });
        continue;
      }
      try {
        return await res.json();
      } catch (err) {
        lastErr = new PriceError("parse", `bad JSON: ${err.message}`);
      }
    }
    throw lastErr ?? new PriceError("network", "unreachable");
  }

  /** Все пулы минта (Solana). */
  async poolsForMint(mint) {
    const body = await this._get(`/networks/solana/tokens/${mint}/pools`);
    const pools = body?.data;
    if (!Array.isArray(pools)) throw new PriceError("parse", "pools response has no data array");
    return pools;
  }

  /**
   * Лучший пул, где НАШ токен — base (OHLCV ценит именно base; пул «STONK / SPYx»
   * отдаёт цену STONK — ловушка ориентации, проверено живьём 19.09).
   * Сортировка по суточному объёму; null = пула с нашим base нет.
   */
  async bestBasePool(mint) {
    const pools = await this.poolsForMint(mint);
    const mine = pools.filter((p) => p?.relationships?.base_token?.data?.id === `solana_${mint}`);
    if (mine.length === 0) return null;
    mine.sort((a, b) => Number(b.attributes?.volume_usd?.h24 ?? 0) - Number(a.attributes?.volume_usd?.h24 ?? 0));
    const p = mine[0];
    const id = String(p.id ?? "");
    const addr = id.startsWith("solana_") ? id.slice("solana_".length) : id;
    return { address: addr, name: p.attributes?.name ?? null, volume24hUsd: p.attributes?.volume_usd?.h24 ?? null };
  }

  /** Дневные свечи пула, по возрастанию ts: [{ts, o, h, l, c}]. */
  async dailyCandles(poolAddress, { limit = 1000 } = {}) {
    const body = await this._get(
      `/networks/solana/pools/${poolAddress}/ohlcv/day?aggregate=1&limit=${limit}&currency=usd`,
    );
    const list = body?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(list)) throw new PriceError("parse", "ohlcv response has no ohlcv_list");
    return list
      .map(([ts, o, h, l, c]) => ({ ts, o, h, l, c }))
      .sort((a, b) => a.ts - b.ts);
  }
}
