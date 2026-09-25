// GeckoTerminal client: token pools and daily OHLCV (no key required).
// Throttle/retries follow the RpcClient discipline: 429/5xx/network — retry,
// other HTTP statuses fail immediately with a kind. Prices are float OBSERVATIONS
// (not amounts!): the project's integer rule covers quantities and multipliers,
// not market quotes.
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

  // The interval is enforced inside a queue only (ported from RpcClient,
  //: concurrent calls (parallel GET /crosscheck for different
  // symbols) join the tail, otherwise every caller computes its wait from the
  // same _lastCall and they all fire at once → 429 → retries amplify the storm.
  // A failed slot must not poison the tail.
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
        // other 4xx (pool 404, 403) are not transient: fail immediately, no retries
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

  /** All pools of the mint (Solana). */
  async poolsForMint(mint) {
    const body = await this._get(`/networks/solana/tokens/${mint}/pools`);
    const pools = body?.data;
    if (!Array.isArray(pools)) throw new PriceError("parse", "pools response has no data array");
    return pools;
  }

  /**
   * The best pool where OUR token is the base (OHLCV prices the base side; a
   * "STONK / SPYx" pool quotes STONK — an orientation trap, verified live on Sep 19).
   * Sorted by 24h volume; null when no pool has our token as base.
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

  /** Daily candles of the pool, ascending by ts: [{ts, o, h, l, c}]. */
  async dailyCandles(poolAddress, { limit = 1000 } = {}) {
    const body = await this._get(
      `/networks/solana/pools/${poolAddress}/ohlcv/day?aggregate=1&limit=${limit}&currency=usd`,
    );
    const list = body?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(list)) throw new PriceError("parse", "ohlcv response has no ohlcv_list");
    return list
      .map(([ts, o, h, l, c]) => ({ ts, o, h, l, c }))
      .sort((a, b) => a.ts - b.ts)
      // A duplicate candle for the same day is a live GT reality  — not a contract, but shape drift. Deduped, the
      // LAST record of the day wins (GT overwrites the current/re-aggregated candle).
      .filter((cd, i, arr) => i === arr.length - 1 || cd.ts !== arr[i + 1].ts);
  }
}
