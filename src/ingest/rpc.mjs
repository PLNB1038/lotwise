// Вежливый JSON-RPC клиент для публичных Solana эндпоинтов.
// Уроки прошлого проекта вшиты: честная очередь (не чаще minIntervalMs),
// retry только на 429/5xx/сетевых ошибках, прозрачная классификация ошибок.
export class RpcError extends Error {
  constructor(kind, message, { status, code } = {}) {
    super(message);
    this.name = "RpcError";
    this.kind = kind; // "rate-limit" | "http" | "rpc" | "network"
    this.status = status;
    this.code = code; // jsonrpc error.code, напр. -32015
  }
}

export class RpcClient {
  /**
   * @param {object} opts
   * @param {string} opts.endpoint — URL RPC
   * @param {Function} [opts.fetcher] — инжект для тестов (по умолчанию global fetch)
   * @param {Function} [opts.sleep] — инжект паузы для тестов (по умолчанию setTimeout)
   * @param {number} [opts.minIntervalMs=350] — минимум между запросами
   * @param {number} [opts.maxRetries=3]
   */
  constructor({ endpoint, fetcher = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), minIntervalMs = 350, maxRetries = 3 }) {
    this.endpoint = endpoint;
    this.fetcher = fetcher;
    this.sleep = sleep;
    this.minIntervalMs = minIntervalMs;
    this.maxRetries = maxRetries;
    this._id = 0;
    this._lastCall = 0;
    this.requestCount = 0;
  }

  async _throttle() {
    const wait = this._lastCall + this.minIntervalMs - Date.now();
    if (wait > 0) await this.sleep(wait);
    this._lastCall = Date.now();
  }

  async call(method, params) {
    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(this.minIntervalMs * 2 ** attempt); // экспоненциальная пауза
      await this._throttle();
      const id = ++this._id;
      this.requestCount++;
      let res;
      try {
        res = await this.fetcher(this.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (compatible; Lotwise/0.1)" },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        });
      } catch (err) {
        lastErr = new RpcError("network", err.message);
        continue;
      }
      if (res.status === 429) { lastErr = new RpcError("rate-limit", "HTTP 429", { status: 429 }); continue; }
      if (!res.ok) { lastErr = new RpcError("http", `HTTP ${res.status}`, { status: res.status }); continue; }
      let body;
      try {
        body = await res.json();
      } catch (err) {
        lastErr = new RpcError("network", `bad JSON: ${err.message}`);
        continue;
      }
      if (body.error) {
        // RPC-ошибки (напр. -32015) не ретраим — это не транзиентность, а наш запрос плох.
        throw new RpcError("rpc", `${body.error.code}: ${body.error.message}`, { code: body.error.code });
      }
      return body.result;
    }
    throw lastErr ?? new RpcError("network", "unreachable");
  }
}
