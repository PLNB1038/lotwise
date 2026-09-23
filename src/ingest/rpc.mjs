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

// Транзиентные JSON-RPC ошибки (раунды 8–9): публичные/перегруженные ноды отдают их
// с HTTP 200 в теле — раньше такой ответ был ФАТАЛЕН для всего скана кошелька.
// Правила раздельные (ROUND9 №11): КОД из множества (-32005) — транзиент всегда;
// СООБЩЕНИЕ («node is behind» и т.п.) — транзиент ТОЛЬКО при отсутствии кода:
// детерминированные коды (-32602 «rate limit exceeded…») постоянны, ретрай жёг
// квоту впустую. Исчерпание message-matched → kind "rate-limit" (потребители
// переключаются на kind); исчерпание кодового -32005 остаётся kind "rpc".
const TRANSIENT_RPC_CODES = new Set([-32005]);
const TRANSIENT_RPC_MESSAGE = /node is behind|behind by|rate limit|too many requests/i;

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
    this._queue = Promise.resolve();
  }

  // Выдержка интервала работает только внутри очереди: конкурентные вызовы
  // (GET /lots из двух вкладок) встают в хвост, иначе все считают wait от
  // одного _lastCall и уходят залпом. Провал слота не должен отравить хвост.
  async _throttle() {
    const turn = this._queue.then(async () => {
      const wait = this._lastCall + this.minIntervalMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      this._lastCall = Date.now();
    });
    this._queue = turn.then(() => {}, () => {});
    await turn;
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
      if (!res.ok) {
        // прочие 4xx — запрос плох: ретрай бессмыслен и умножает расход квоты впустую
        if (res.status < 500) throw new RpcError("http", `HTTP ${res.status}`, { status: res.status });
        lastErr = new RpcError("http", `HTTP ${res.status}`, { status: res.status });
        continue;
      }
      let body;
      try {
        body = await res.json();
      } catch (err) {
        lastErr = new RpcError("network", `bad JSON: ${err.message}`);
        continue;
      }
      // Тело-мусор с HTTP 200 (null/массив/число — ROUND9 №11): раньше null давал
      // голый TypeError мимо классификации, а [] «успешно» возвращал undefined.
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        lastErr = new RpcError("network", `non-object JSON-RPC body: ${typeof body}`);
        continue;
      }
      if (body.error) {
        const codeKnown = body.error.code !== undefined && body.error.code !== null;
        const transient = TRANSIENT_RPC_CODES.has(body.error.code)
          || (!codeKnown && TRANSIENT_RPC_MESSAGE.test(String(body.error.message)));
        const rpcErr = new RpcError(
          transient && !TRANSIENT_RPC_CODES.has(body.error.code) ? "rate-limit" : "rpc",
          `${body.error.code}: ${body.error.message}`,
          { code: body.error.code },
        );
        // Транзиент — ретрай с тем же бэкоффом, исчерпание — честный бросок.
        // Детерминированные RPC-ошибки (напр. -32015) сразу: ретрай лишь жёг бы квоту.
        if (transient) {
          lastErr = rpcErr;
          continue;
        }
        throw rpcErr;
      }
      return body.result;
    }
    throw lastErr ?? new RpcError("network", "unreachable");
  }
}
