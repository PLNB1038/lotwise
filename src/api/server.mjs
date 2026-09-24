// Lotwise REST API: stdlib only (node:http), no dependencies.
// MVP data showcase: registry, events, multiplier at a date + the showcase page.
import { createServer } from "node:http";
import { MultiplierTimeline } from "../lots/timeline.mjs";
import { applyEvents } from "../lots/lots.mjs";
import { reconcileMultiplier } from "../issuer/scaled-ui.mjs";
import { isValidAddress } from "../wallet/scan.mjs";
import { buildWalletReport } from "../wallet/report.mjs";
import { crossCheckEvents } from "../events/crosscheck.mjs";
import { isValidIsoDate, parseIsoDateMs } from "../schema/isodate.mjs";
import { EVENT_TYPES } from "../schema/events.mjs";
import { renderPage } from "../ui/page.mjs";
import { createRateLimiter } from "./ratelimit.mjs";

export function createApiServer({ registry, events = [], port = 0, host = "127.0.0.1", onchainReader = null, walletScanner = null, priceProvider = null, journalStats = null, registryStats = null, rateLimits = { scan: { windowMs: 60_000, max: 12 }, rpc: { windowMs: 60_000, max: 60 } }, trustProxy = false }) {
  // indexes are built once; when the data changes the server is recreated (MVP)
  const byMint = new Map(registry.map((t) => [t.mint, t]));
  const bySymbol = new Map(registry.map((t) => [t.symbol, t]));
  const eventsByMint = new Map();
  for (const e of events) {
    if (!eventsByMint.has(e.mint)) eventsByMint.set(e.mint, []);
    eventsByMint.get(e.mint).push(e);
  }
  const timelines = new Map();
  const excludedByMint = new Map(); // mint → exclusion reason (TimelineError)
  for (const [mint, evts] of eventsByMint) {
    const mult = evts.filter((e) => e.type === "MULTIPLIER_CHANGE");
    if (mult.length === 0) continue;
    try {
      timelines.set(mint, new MultiplierTimeline(mult));
    } catch (err) {
      // A broken chain for one mint (e.g. history not starting at "1") must not take the
      // server down: TimelineError at build time used to kill the process at startup while
      // the poisoned record persisted in the journal → an eternal boot-loop. Honest
      // degradation: the token is excluded from the showcase WHOLE — serving events without
      // a timeline silently showed multiplier 1. The reason is remembered: /summary, /lots
      // and /health mark excluded tokens — a bare "1" without the mark is indistinguishable
      // from an honest "no events ever happened".
      console.warn(`[api] token ${byMint.get(mint)?.symbol ?? mint} excluded from the showcase: ${err.message}`);
      eventsByMint.delete(mint);
      excludedByMint.set(mint, err.message);
    }
  }

  // Query date gate — the same strict parser used further down the stack (schema/isodate.mjs).
  // This used to be a shape regex + Date.parse, but Date.parse("2026-02-30") does NOT give
  // NaN — it rolls over to 2026-03-02: a garbage date passed the gate, went as a real RPC
  // call into the /onchain reader (warming the cache), then threw TimelineError inside
  // multiplierAt → 500 instead of 400. The strict parser rejects rollovers and naive
  // times BEFORE any I/O.
  const validQueryDate = isValidIsoDate;

  const json = (res, status, body, extra = {}) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), "X-Content-Type-Options": "nosniff", ...extra });
    res.end(payload);
  };

  // Expensive endpoints (/lots, /accruals — wallet scan; /onchain, /crosscheck —
  // RPC/prices) are limited per client key. rateLimits: null|false — limits off
  // (local experiments); the default is on: the demo is public and the RPC quota
  // is finite. The key = the LAST element of X-Forwarded-For under trustProxy — the
  // one appended by our trusted proxy (the funnel). The FIRST element of an appending
  // chain is client-controlled: keying on it let a client rotate the header and mint
  // itself unlimited buckets (round 7 fix 8). A direct connection with a spoofed XFF
  // does not happen here (the only public path is the funnel); otherwise — the socket
  // address. A partial config ({} or a single key) is a clear configuration refusal,
  // not a TypeError from destructuring the limiter (wave B): rateLimits is either
  // complete, or null/false.
  if (rateLimits && (!rateLimits.scan || !rateLimits.rpc)) {
    throw new RangeError("rateLimits requires both buckets: { scan: {windowMs,max}, rpc: {windowMs,max} } (or null to disable)");
  }
  const scanLimiter = rateLimits ? createRateLimiter(rateLimits.scan) : null;
  const rpcLimiter = rateLimits ? createRateLimiter(rateLimits.rpc) : null;
  const clientKey = (req) => {
    const xff = req.headers["x-forwarded-for"];
    if (trustProxy && typeof xff === "string" && xff.trim() !== "") {
      const parts = xff.split(",");
      // an empty last element (trailing comma/space) is not a key: the shared ""
      // bucket collapsed distinct clients (round 9 fix 6); the honest fallback is the socket
      const key = parts[parts.length - 1].trim();
      if (key !== "") return key;
    }
    return req.socket?.remoteAddress ?? "unknown";
  };
  // returns true when the request may proceed with the expensive I/O; otherwise it
  // answers 429 itself. The token is burned BEFORE the source call: a 503 from a
  // failed RPC burns it too — a deliberate anti-retry-storm measure (wave B verified
  // it; otherwise a dead source gets ground down by endless retries), documented here.
  const allow = (limiter, req, res) => {
    if (!limiter) return true;
    const { allowed, retryAfterMs } = limiter.check(clientKey(req));
    if (allowed) return true;
    const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
    json(res, 429, { error: `rate limit exceeded, retry after ${retryAfterSec}s` }, { "Retry-After": String(retryAfterSec) });
    return false;
  };

  // Route list for an honest 404: one constant, two consumers (the "//x" guard
  // below and the router's final 404) — otherwise the lists drift apart on the next route.
  const ENDPOINTS = ["/", "/health", "/tokens", "/events", "/multiplier", "/summary", "/onchain", "/lots", "/accruals", "/crosscheck"];

  // Resolve only inside the registry: an unknown mint/symbol — 400, not "empty data".
  // Until now ?mint=<garbage> passed straight through: /events silently returned [],
  // /multiplier — "1", /onchain fired real RPC requests with arbitrary keys past the cache.
  const resolveMint = (q) =>
    byMint.get(q.get("mint") ?? "")?.mint ?? bySymbol.get(q.get("symbol") ?? "")?.mint ?? null;
  let pageHtml = null; // rendered once, the page is static (it pulls data from the API)

  const server = createServer(async (req, res) => {
    try {
      let url;
      // A request-target with a leading "//" is the protocol-relative form: new URL
      // swallows the next segment as the authority ("//events?x" → host "events",
      // pathname "/", query discarded), and routing silently served the MAIN page
      // instead of 404/data (a chaos-round finding). Cut it off before parsing: a
      // foreign authority is not ours, and canonizing "//events" into "/events" would
      // reward malformed request-targets — an honest 404, not "guessing on the client's behalf".
      if (req.url.startsWith("//")) {
        return json(res, 404, { error: "not found", endpoints: ENDPOINTS });
      }
      try {
        url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
      } catch {
        // crash vector caught live: a request-target like "http://:80/" throws
        // ERR_INVALID_URL and, unchecked, killed the process with a single request
        return json(res, 400, { error: "malformed request target" });
      }
      // HEAD — GET semantics with an empty body (RFC 9110 §9.3.2): node itself drops
      // the body (_hasBody=false for HEAD), the headers go out exactly as for GET —
      // including the Content-Length of the GET response. HEAD used to get a 405:
      // monitoring HEAD probes were refused on live routes. The other methods get a
      // 405, and per RFC 9110 §15.5.5 it MUST carry Allow (it used not to — the same
      // chaos finding).
      const isHead = req.method === "HEAD";
      if (req.method !== "GET" && !isHead) {
        return json(res, 405, { error: "method not allowed" }, { Allow: "GET, HEAD" });
      }
      const q = url.searchParams;

    if (url.pathname === "/") {
      pageHtml ??= renderPage();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(pageHtml), "X-Content-Type-Options": "nosniff" });
      return res.end(pageHtml);
    }
    if (url.pathname === "/summary") {
      const now = new Date().toISOString();
      const rows = registry
        .map((t) => {
          const reason = excludedByMint.get(t.mint);
          return {
            symbol: t.symbol,
            name: t.name,
            issuer: t.issuer,
            mint: t.mint,
            decimals: t.decimals,
            events: (eventsByMint.get(t.mint) ?? []).length,
            currentMultiplier: timelines.get(t.mint)?.multiplierAt(now) ?? "1",
            // additive: a token excluded from the showcase is marked — a "1" without
            // the mark looked computed, although the token has no timeline
            ...(reason ? { excluded: true, excludedReason: reason } : {}),
          };
        })
        .sort((a, b) => b.events - a.events || a.symbol.localeCompare(b.symbol));
      return json(res, 200, rows);
    }
    if (url.pathname === "/onchain") {
      const mint = resolveMint(q);
      if (!mint) return json(res, 400, { error: "mint or symbol required (must be a tracked token)" });
      const date = q.get("date") ?? new Date().toISOString();
      // the date is validated BEFORE the reader: a garbage date must not warm the cache
      // with a real RPC call, nor yield 503 instead of 400 with a throwing reader
      if (!validQueryDate(date)) return json(res, 400, { error: "date must be ISO-8601 (YYYY-MM-DD, or with time + timezone)" });
      // Excluded token (TimelineError at startup): the issuer plan is unknown, the
      // "?? "1"" would fabricate api:1 and a verdict without comparing the two real
      // plans — an honest refusal BEFORE the reader and the limiter (the RPC quota
      // does not burn), per the /events convention.
      const onchainExcludedReason = excludedByMint.get(mint);
      if (onchainExcludedReason) {
        return json(res, 400, {
          error: `token excluded from multiplier reporting: ${onchainExcludedReason}`,
          excluded: true,
          excludedReason: onchainExcludedReason,
        });
      }
      if (!onchainReader) return json(res, 503, { error: "on-chain reader not configured" });
      if (!allow(rpcLimiter, req, res)) return;
      let parsed;
      try {
        parsed = await onchainReader(mint);
      } catch (err) {
        // source unavailable — fail-closed: we return the status, the showcase shows an honest placeholder
        return json(res, 503, { error: err.message, kind: err.kind ?? null });
      }
      const api = timelines.get(mint)?.multiplierAt(date) ?? "1";
      const rec = reconcileMultiplier(api, parsed, date);
      return json(res, 200, {
        mint,
        symbol: byMint.get(mint)?.symbol ?? null,
        date,
        api: rec.api,
        onChain: {
          active: parsed.activeMultiplier,
          pending: parsed.pendingMultiplier,
          pendingEffectiveDate: parsed.pendingEffectiveDate,
          hasExtension: parsed.hasExtension,
        },
        onChainEffective: rec.onChainEffective,
        verdict: rec.verdict,
      });
    }
    if (url.pathname === "/lots") {
      const address = q.get("address");
      if (!address) return json(res, 400, { error: "address required" });
      if (!isValidAddress(address)) return json(res, 400, { error: "address must be a base58 Solana pubkey" });
      if (!walletScanner) return json(res, 503, { error: "wallet scanner not configured" });
      if (!allow(scanLimiter, req, res)) return;
      // A client that walked away must not keep burning the RPC quota (wave B): abort
      // is passed into the scanner, the scan stops between pages/transactions; the
      // result of a cancelled scan is NOT cached (the cache helper only caches success).
      const abort = new AbortController();
      req.on("aborted", () => abort.abort());
      let scan;
      try {
        scan = await walletScanner(address, { signal: abort.signal });
      } catch (err) {
        return json(res, 503, { error: err.message, kind: err.kind ?? null });
      }
      // the report is assembled in the server: this is where the multiplier timelines live
      const report = buildWalletReport(scan, { registry, timelines, now: new Date().toISOString() });
      // tokens with a broken timeline: the multiplier in the report is the default "1" — mark honestly
      for (const tk of report.tokens) {
        const reason = excludedByMint.get(tk.mint);
        if (reason) {
          tk.excluded = true;
          tk.excludedReason = reason;
          // showcase contract: adjustedAvailable === false (together with excluded) → the
          // "adjusted — not computed" row; otherwise the identity fallback (scaled=raw) would
          // look like a computed adjusted. rawBalance/netDeltaRaw are untouched — raw is raw.
          tk.adjustedAvailable = false;
        }
      }
      return json(res, 200, report);
    }
    if (url.pathname === "/accruals") {
      // The applyEvents accrual engine is wired in pointwise: the dividends of ONE token
      // for ONE wallet. A separate endpoint, not a field in /lots: the /lots report is
      // wallet-wide (its contract has no symbol) and its wire shape is pinned by tests
      // (dividend-e2e GAP 2: there must be no "accrual" rows in /lots).
      const mint = resolveMint(q);
      if (!mint) return json(res, 400, { error: "mint or symbol required (must be a tracked token)" });
      // Excluded token (broken timeline): the events are hidden WHOLE; a silent [] would
      // be indistinguishable from "no dividends" — the same honest refusal as /events.
      const excludedReason = excludedByMint.get(mint);
      if (excludedReason) {
        return json(res, 400, {
          error: `token excluded from multiplier reporting: ${excludedReason}`,
          excluded: true,
          excludedReason,
        });
      }
      const address = q.get("address");
      if (!address) return json(res, 400, { error: "address required" });
      if (!isValidAddress(address)) return json(res, 400, { error: "address must be a base58 Solana pubkey" });
      if (!walletScanner) return json(res, 503, { error: "wallet scanner not configured" });
      if (!allow(scanLimiter, req, res)) return;
      const abort = new AbortController();
      req.on("aborted", () => abort.abort());
      let scan;
      try {
        scan = await walletScanner(address, { signal: abort.signal });
      } catch (err) {
        return json(res, 503, { error: err.message, kind: err.kind ?? null });
      }
      const report = buildWalletReport(scan, { registry, timelines, now: new Date().toISOString() });
      const token = report.tokens.find((t) => t.mint === mint);
      const dividends = (eventsByMint.get(mint) ?? []).filter((e) => e.type === "DIVIDEND_ACCRUAL");
      // no position in the token or no dividend events — no accruals: an honest []
      if (!token || dividends.length === 0) return json(res, 200, []);
      // Report lots lack the engine context (a lot carries no mint/owner/basisRaw — the
      // seam is documented in round6-report-lots): we complete it. acquiredDate: null (a
      // tx without blockTime is a legitimate Solana reality) is POISON to applyEvents: the
      // engine throws LotError "refusing to guess" and its atomicity rolls back applying
      // the WHOLE history (contract in the report.mjs header). Such lots are excluded
      // BEFORE the engine: the acquisition date is unknown — the engine refuses to guess
      // "before or after the ex-date", and so will we.
      const engineLots = token.lots
        .filter((l) => l.acquiredDate !== null && l.acquiredDate !== undefined)
        .map((l) => ({ ...l, mint, owner: report.owner, qtyRaw: BigInt(l.qtyRaw), basisRaw: 0n }));
      let engine;
      try {
        engine = applyEvents(engineLots, dividends);
      } catch (err) {
        // a broken event from the store does not take the server down: a clear reason instead of a generic 500
        return json(res, 500, { error: `accrual engine failed: ${err.message}` });
      }
      const symbol = byMint.get(mint)?.symbol ?? null;
      // lotsConsidered — how many lots fed the event's base ("strictly earlier than
      // effectiveDate", a unix-ms comparison): the heldBefore pair in lots.mjs. The engine
      // does not return the counter (an accrual carries only the qty sum), but the showcase
      // needs to see "which lots paid for it". The parse here cannot yield null: the engine
      // already ran the same rows through the same parseIsoDateMs — a garbage date would
      // have reached it as a LotError above.
      return json(res, 200, engine.accruals.map((a) => ({
        symbol,
        effectiveDate: a.event.effectiveDate,
        amountPerUnitRaw: String(a.amountPerUnitRaw), // BigInt does not serialize in JSON — strings go out
        totalRaw: String(a.totalRaw),
        lotsConsidered: engineLots.filter((l) => parseIsoDateMs(l.acquiredDate) < parseIsoDateMs(a.event.effectiveDate)).length,
      })));
    }
    if (url.pathname === "/crosscheck") {
      const mint = resolveMint(q);
      if (!mint) return json(res, 400, { error: "mint or symbol required (must be a tracked token)" });
      // Excluded token: the events are hidden whole — a silent verdicts:[] would be
      // indistinguishable from "no events", while pool+candles would burn the provider
      // quota for nothing. A refusal with the reason BEFORE the provider and the limiter —
      // the /events convention.
      const crosscheckExcludedReason = excludedByMint.get(mint);
      if (crosscheckExcludedReason) {
        return json(res, 400, {
          error: `token excluded from multiplier reporting: ${crosscheckExcludedReason}`,
          excluded: true,
          excludedReason: crosscheckExcludedReason,
        });
      }
      if (!priceProvider) return json(res, 503, { error: "price provider not configured" });
      if (!allow(rpcLimiter, req, res)) return;
      let pool = null;
      let candles = [];
      try {
        pool = await priceProvider.pool(mint); // null = no pool with our base — every verdict is no-price-data
        if (pool) candles = await priceProvider.candles(pool.address);
      } catch (err) {
        return json(res, 503, { error: err.message, kind: err.kind ?? null });
      }
      const { verdicts, coverage } = crossCheckEvents(eventsByMint.get(mint) ?? [], candles);
      return json(res, 200, { mint, symbol: byMint.get(mint)?.symbol ?? null, pool, coverage, verdicts });
    }
    if (url.pathname === "/health") {
      // journal: how many events replayed from the cache and how many tokens were not read
      // from the chain — "29 events" without this line is indistinguishable from "the RPC
      // was down at startup".
      // excluded: tokens whose timeline is broken and which are excluded from the showcase —
      // their "1" is a default, not a computation; the showcase and API consumers must see it.
      return json(res, 200, {
        ok: true,
        tokens: registry.length,
        events: events.length,
        journal: journalStats,
        registry: registryStats,
        excluded: [...excludedByMint].map(([mint, reason]) => ({
          mint,
          symbol: byMint.get(mint)?.symbol ?? null,
          reason,
        })),
      });
    }
    if (url.pathname === "/tokens") {
      const issuer = q.get("issuer");
      if (issuer !== null) {
        // round 13: a silent [] on ?issuer=Backed (the README itself says "xStocks/Backed 16")
        // is indistinguishable from "there are no tokens" — the symbol/mint convention: refuse with a dictionary.
        const known = new Set(registry.map((t) => t.issuer));
        if (!known.has(issuer)) {
          const dict = known.size ? `; valid: ${[...known].sort().join(", ")}` : "";
          return json(res, 400, { error: `unknown issuer ${JSON.stringify(issuer)}${dict}` });
        }
        return json(res, 200, registry.filter((t) => t.issuer === issuer));
      }
      return json(res, 200, registry);
    }
    if (url.pathname === "/events") {
      const mint = resolveMint(q);
      if (!mint) return json(res, 400, { error: "mint or symbol required (must be a tracked token)" });
      // For an excluded mint the events are hidden WHOLE (a partial serve without a timeline
      // would lie), but a silent [] is indistinguishable from "no events". An honest refusal
      // with the reason — per the endpoint error convention (like an unknown symbol — a 400
      // with {error}); the excluded/excludedReason fields duplicate the reason for
      // programmatic consumers.
      const excludedReason = excludedByMint.get(mint);
      if (excludedReason) {
        return json(res, 400, {
          error: `token excluded from multiplier reporting: ${excludedReason}`,
          excluded: true,
          excludedReason,
        });
      }
      const list = eventsByMint.get(mint) ?? [];
      const type = q.get("type");
      if (type !== null && !EVENT_TYPES.includes(type)) {
        // round 13: the same contract as issuer — a garbage type with a silent [] is
        // indistinguishable from "there were no events of this type"
        return json(res, 400, { error: `unknown type ${JSON.stringify(type)}; valid: ${EVENT_TYPES.join(", ")}` });
      }
      return json(res, 200, type ? list.filter((e) => e.type === type) : list);
    }
    if (url.pathname === "/multiplier") {
      const mint = resolveMint(q);
      if (!mint) return json(res, 400, { error: "mint or symbol required (must be a tracked token)" });
      const date = q.get("date") ?? new Date().toISOString();
      // dates and quantities — valid input or an honest 400: the strict date gate (see above)
      // cuts off rollovers ("2026-02-30") and naive times, while BigInt silently accepts "0x10" (=16)
      const raw = q.get("raw") ?? "100000000";
      if (!/^\d+$/.test(raw)) return json(res, 400, { error: "raw must be a non-negative integer in base units (digits only)" });
      if (!validQueryDate(date)) return json(res, 400, { error: "date must be ISO-8601 (YYYY-MM-DD, or with time + timezone)" });
      const tl = timelines.get(mint);
      if (!tl) {
        // additive, as in /summary: for an excluded mint (TimelineError at startup) the "1"
        // is a default without a timeline, not a computation; without the mark it is
        // indistinguishable from an honest "no events" — the same "bare 1" class that
        // round 5 hunted down in /summary
        const excludedReason = excludedByMint.get(mint);
        return json(res, 200, {
          mint, date,
          multiplier: "1",
          events: 0, // no events ever
          ...(excludedReason ? { excluded: true, excludedReason } : {}),
        });
      }
      try {
        const s = tl.scaledQty(BigInt(raw), date);
        return json(res, 200, {
          mint, date,
          multiplier: tl.multiplierAt(date),
          // BigInt does not serialize in JSON — serve as strings
          sampleScaledQty: {
            exact: s.exact,
            whole: String(s.whole),
            remainder: String(s.remainder),
            den: String(s.den),
          },
          events: tl.steps.length - 1,
        });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    return json(res, 404, { error: "not found", endpoints: ENDPOINTS });
    } catch (err) {
      // safety net: any unhandled exception — a 500, the process lives on
      return json(res, 500, { error: "internal error" });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject); // a busy port and the like — reject instead of a raw crash
    server.listen(port, host, () => resolve(server));
  });
}
