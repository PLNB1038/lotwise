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
// The rules are separate : a CODE from the set (-32005) is always transient;
// a MESSAGE ("node is behind" etc.) is transient ONLY when no code is present:
// deterministic codes (-32602 "rate limit exceeded…") are permanent, retrying just burned
// the quota for nothing. Exhausting message-matched retries → kind "rate-limit" (consumers
// switch on kind); exhausting code-based -32005 retries stays kind "rpc".
// URL redaction in error messages : undici embeds the full
// URL (with userinfo credentials) into the TypeError, and a provider may echo a key in the
// JSON-RPC error text — all of that used to reach the 503 bodies of ANY visitor and the
// boot log, even though the banner masks the origin. Single choke point: the error constructor.
// the i flag — undici echoes URLs verbatim, and an uppercase scheme
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
    // Two FIFO lanes over ONE pacing gate: a wallet scan pours hundreds of
    // calls into the queue, and under plain FIFO a vitrine getAccountInfo stood in that
    // tail for minutes — an empty wallet alone used to hold the gate for ~23 s. The
    // lanes change only WHO gets the next slot — never the rate: both drain through the
    // same minIntervalMs gate, so the provider sees exactly the same call cadence.
    this._lanes = { high: [], low: [] };
    this._draining = false;
  }

  // Interval pacing works inside a single serial gate: concurrent calls (GET /lots from
  // two browser tabs) line up at the tail; otherwise every call computes wait from the
  // same _lastCall and they all fire at once. The gate is a drain loop now, not a promise
  // chain: a chain fixes the order at ENQUEUE time, priority needs the decision at SLOT
  // time (a high call arriving after the lows must still pass them). No preemption: a
  // high arrival while a low call already owns the in-flight sleep waits that one tick —
  // preempting would waste the committed slot, and the high latency stays bounded by
  // minIntervalMs instead of by the backlog. A failed slot cannot poison anyone: the loop
  // never awaits caller code, it only wakes the selected waiter — errors surface in that
  // caller's own call(), the gate moves on (the old chain's .then(() => {}, () => {})).
  async _drain() {
    if (this._draining) return;
    this._draining = true;
    try {
      while (this._lanes.high.length > 0 || this._lanes.low.length > 0) {
        // the whole feature is this one line: high first, low only when high is empty.
        // The low lane is then honest FIFO — no aging, no starvation guard: the high lane
        // here is point reads (getAccountInfo) behind a 10-min cache and a per-IP limiter,
        // bounded; unbounded growth lives on the scan side, which is exactly the lane
        // allowed to wait.
        const waiter = (this._lanes.high.length > 0 ? this._lanes.high : this._lanes.low).shift();
        try {
          const wait = this._lastCall + this.minIntervalMs - Date.now();
          if (wait > 0) await this.sleep(wait);
        } catch (err) {
          // an injected sleep rejected (test harness, exotic timer): the selected caller
          // gets the failure honestly, the gate keeps draining instead of deadlocking
          waiter.reject(err);
          continue;
        }
        this._lastCall = Date.now();
        waiter.resolve();
      }
    } finally {
      this._draining = false;
    }
  }

  _throttle(priority) {
    return new Promise((resolve, reject) => {
      this._lanes[priority].push({ resolve, reject });
      this._drain();
    });
  }

  async call(method, params, { signal, priority = "low" } = {}) {
    // Default LOW (compatibility first): traffic that multiplies is scan traffic — new
    // sources, backfills, ingest loops — and a future bulk call site that forgets the
    // option then degrades to today's FIFO instead of silently jumping the vitrine queue
    // again. Point calls are few and stable, and they opt in explicitly (scripts/serve.mjs).
    // Typos fail LOUDLY: a silent "unknown → low" would bury a point call behind the
    // backlog on a mere "hight", with nothing in the logs to explain the hang.
    if (priority !== "high" && priority !== "low") {
      throw new RangeError(`call priority must be "high" or "low", got ${JSON.stringify(priority)}`);
    }
    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // the caller departed before this attempt even started: stop now — a retry would
      // burn quota and pacing time for a client that is already gone
      if (signal?.aborted) throw new RpcError("aborted", "request aborted by the caller");
      if (attempt > 0) await this.sleep(this.minIntervalMs * 2 ** attempt); // exponential backoff
      // a retry re-enters ITS OWN lane: a scan call leaving backoff must not resurface
      // as high traffic just because it is technically a fresh slot request
      await this._throttle(priority);
      // the abort is re-checked AFTER the lane wait too: a caller that departed while
      // this call sat in the queue must not spend a paced slot and an RPC request —
      // the fetch would reject immediately, but the slot (and requestCount) is spent
      if (signal?.aborted) throw new RpcError("aborted", "request aborted by the caller");
      const id = ++this._id;
      this.requestCount++;
      let res;
      try {
        res = await this.fetcher(this.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (compatible; Lotwise/0.1)" },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
          // the abort reaches the WIRE: without it a departed scan client left the fetch
          // (and the one-slot scan semaphore) hanging on the transport's own timeout —
          // minutes per call, tens of minutes per scan
          ...(signal ? { signal } : {}),
        });
      } catch (err) {
        // an abort by OUR caller is an immediate stop, not a network error to retry.
        // Only the caller's signal decides: a transport AbortError WITHOUT it (an
        // exotic gateway abort) stays a retryable network error
        if (signal?.aborted) throw new RpcError("aborted", "request aborted by the caller");
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
        // the body read races the caller's departure on the LAST attempt too: without
        // this check the abort leaked out as a retryable "bad JSON" network error
        if (signal?.aborted) throw new RpcError("aborted", "request aborted by the caller");
        lastErr = new RpcError("network", `bad JSON: ${err.message}`);
        continue;
      }
      // Garbage body with HTTP 200 (null/array/number —: null used to produce
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
