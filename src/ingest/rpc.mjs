// A courteous JSON-RPC client for public Solana endpoints.
// Lessons from a past project are baked in: an honest queue (no faster than minIntervalMs),
// retries only on 429/5xx/network errors, transparent error classification.
export class RpcError extends Error {
  constructor(kind, message, { status, code } = {}) {
    super(message);
    this.name = "RpcError";
    this.kind = kind; // "rate-limit" | "http" | "rpc" | "network"
    this.status = status;
    this.code = code; // jsonrpc error.code, e.g. -32015
  }
}

// Transient JSON-RPC errors (rounds 8-9): public/overloaded nodes return them
// with HTTP 200 in the body — such a response used to be FATAL for the entire wallet scan.
// The rules are separate (round 9 fix 11): a CODE from the set (-32005) is always transient;
// a MESSAGE ("node is behind" etc.) is transient ONLY when no code is present:
// deterministic codes (-32602 "rate limit exceeded…") are permanent, retrying just burned
// the quota for nothing. Exhausting message-matched retries → kind "rate-limit" (consumers
// switch on kind); exhausting code-based -32005 retries stays kind "rpc".
// URL redaction in error messages (wave C3-1 [P1]): undici embeds the full
// URL (with userinfo credentials) into the TypeError, and a provider may echo a key in the
// JSON-RPC error text — all of that used to reach the 503 bodies of ANY visitor and the
// boot log, even though the banner masks the origin. Single choke point: the error constructor.
// Round 13: the i flag — undici echoes URLs verbatim, and an uppercase scheme
// ("HTTP://user:secret@…" — a typo/case-insensitive input) slipped past the redaction
// and went into a visitor's 503 body.
const URL_IN_MESSAGE = /https?:\/\/\S+/gi;
const redactUrls = (msg) => String(msg).replace(URL_IN_MESSAGE, "[url]");

const TRANSIENT_RPC_CODES = new Set([-32005]);
const TRANSIENT_RPC_MESSAGE = /node is behind|behind by|rate limit|too many requests/i;

export class RpcClient {
  /**
   * @param {object} opts
   * @param {string} opts.endpoint — RPC URL
   * @param {Function} [opts.fetcher] — test injection (defaults to global fetch)
   * @param {Function} [opts.sleep] — pause injection for tests (defaults to setTimeout)
   * @param {number} [opts.minIntervalMs=350] — minimum interval between requests
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

  // Interval pacing only works inside the queue: concurrent calls
  // (GET /lots from two browser tabs) line up at the tail; otherwise every call computes
  // wait from the same _lastCall and they all fire at once. A failed slot must not poison the tail.
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
      if (attempt > 0) await this.sleep(this.minIntervalMs * 2 ** attempt); // exponential backoff
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
        lastErr = new RpcError("network", redactUrls(err.message));
        continue;
      }
      if (res.status === 429) { lastErr = new RpcError("rate-limit", "HTTP 429", { status: 429 }); continue; }
      if (!res.ok) {
        // other 4xx — the request itself is bad: retrying is pointless and only burns more quota
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
      // Garbage body with HTTP 200 (null/array/number — round 9 fix 11): null used to produce
      // a bare TypeError bypassing classification, and [] "successfully" returned undefined.
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
          `${body.error.code}: ${redactUrls(body.error.message)}`,
          { code: body.error.code },
        );
        // Transient — retry with the same backoff; exhaustion — an honest throw.
        // Deterministic RPC errors (e.g. -32015) throw immediately: retrying would just burn quota.
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
