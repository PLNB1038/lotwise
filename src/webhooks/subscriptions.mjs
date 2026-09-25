// Lotwise webhook subscriptions: storage (a file), event-to-subscription matching
// and delivery with an HMAC signature and retries.
//
// WHY A LIBRARY, NOT HTTP ROUTES: the API server (src/api/server.mjs) is strictly
// GET-only — 405 on non-GET is pinned by tests (api.test.mjs) and must not be broken.
// So webhooks are a module + a delivery CLI (scripts/webhook-deliver.mjs),
// without a single HTTP endpoint: subscriptions live in a file (by default
// data/webhooks.json, created only at runtime — on the first addSubscription),
// delivery is initiated by the operator/cron, not by the server.
//
// Subscription record format: {id, url, symbols, secret, createdAt, active}
//   symbols — "*" (wildcard: all events) or a non-empty array of token identifiers
//             (registry symbols or mints — exact match, no case magic);
//   secret  — the HMAC-SHA256 key for signing the body (X-Lotwise-Signature);
//   active  — a disabled subscription does not deliver but stays in the file (deactivation
//             is reversible via delete+add; there is deliberately no separate activate).
//
// Delivery: POST of the JSON envelope {deliveryId, sentAt, event}; headers
//   X-Lotwise-Event     — the event type (event.type);
//   X-Lotwise-Delivery  — the delivery id (one across all retries: the receiver sees a duplicate,
//                         not two different webhooks — idempotency on its side);
//   X-Lotwise-Signature — "sha256=" + hex(HMAC-SHA256(secret, exact body)).
// Retries: up to 3 attempts, backoff 1s → 4s; success = 2xx; a network failure/timeout/non-2xx
// means the attempt failed. The body and signature are computed ONCE before the attempts: all retries
// carry the byte-for-byte same payload (otherwise the receiver could not re-verify the signature,
// and deliveryId idempotency would lose its meaning).
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync, writeSync, openSync, closeSync, unlinkSync, statSync } from "node:fs";

import { atomicWriteJson } from "../fs/atomic.mjs";
import { validateEvent } from "../schema/events.mjs";
import { isValidIsoDate } from "../schema/isodate.mjs";

// The default storage path is a CLI default ONLY: the module itself neither creates
// the file nor touches it on import (tests pass the path explicitly).
export const DEFAULT_SUBSCRIPTIONS_PATH = "data/webhooks.json";

export const MAX_ATTEMPTS = 3;
export const BACKOFF_MS = [1000, 4000];
export const DEFAULT_TIMEOUT_MS = 10_000;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SubscriptionError extends Error {
  constructor(msg, field) {
    super(field ? `${msg} (${field})` : msg);
    this.name = "SubscriptionError";
    this.field = field;
  }
}

// ---------- validation ----------

/**
 * Subscription record validation. Throws SubscriptionError with the field name.
 * All fields are required: the storage knows no "partially filled" records —
 * a record is either fit for delivery or must not enter the file.
 */
export function validateSubscription(sub) {
  if (!sub || typeof sub !== "object" || Array.isArray(sub)) {
    throw new SubscriptionError("subscription must be an object");
  }
  // symbols is not in this loop: it is "*" or an array, checked by its own branch below
  for (const f of ["id", "url", "secret", "createdAt"]) {
    if (typeof sub[f] !== "string" || sub[f] === "") {
      throw new SubscriptionError("missing or non-string required field", f);
    }
  }
  let parsed;
  try {
    parsed = new URL(sub.url);
  } catch {
    throw new SubscriptionError("url must be a valid absolute URL", "url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SubscriptionError("url must be http(s)", "url");
  }
  // SSRF denylist: delivery is outbound POSTs from production; a URL with a private/
  // loopback/link-local/metadata address means knocking on your own infrastructure
  // (funnel, keyed RPC, cloud metadata). The input is operator-side; DNS rebinding
  // is out of scope (the name resolves at delivery time), but literal private
  // addresses and localhost are rejected at write time.
  if (isPrivateDeliveryHost(parsed.hostname)) {
    throw new SubscriptionError("url host must be public (private, loopback, link-local and metadata addresses are not delivered to)", "url");
  }
  if (sub.symbols !== "*") {
    if (!Array.isArray(sub.symbols) || sub.symbols.length === 0) {
      throw new SubscriptionError('symbols must be "*" or a non-empty array of strings', "symbols");
    }
    for (const s of sub.symbols) {
      if (typeof s !== "string" || s === "") {
        throw new SubscriptionError("each symbol must be a non-empty string", "symbols");
      }
    }
  }
  // createdAt is written only by us (new Date(...).toISOString()) — strict ISO,
  // the same parser as the whole date pipeline (schema/isodate.mjs).
  if (!isValidIsoDate(sub.createdAt)) {
    throw new SubscriptionError("createdAt must be canonical ISO-8601 datetime", "createdAt");
  }
  if (typeof sub.active !== "boolean") {
    throw new SubscriptionError("active must be a boolean", "active");
  }
  return true;
}

// ---------- storage (a file, the path is passed as a parameter) ----------

/**
 * Read the subscription storage. No file = an honest empty list (the first run);
 * broken JSON / non-array / invalid record — a LOUD failure (fail-closed):
 * no delivery over an untrusted base, the file is not rewritten.
 * @returns {Array} subscription records
 */
function readStore(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw new SubscriptionError(`subscription file is unreadable: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SubscriptionError(`invalid JSON in ${filePath}: ${err.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new SubscriptionError(`subscription store ${filePath} must be an array of records`);
  }
  parsed.forEach((sub, i) => {
    try {
      validateSubscription(sub);
    } catch (err) {
      throw new SubscriptionError(`broken record subscriptions[${i}]: ${err.message}`, err.field);
    }
  });
  return parsed;
}

function writeStore(filePath, subs) {
  atomicWriteJson(filePath, subs);
}

// SSRF denylist for validateSubscription. Literal addresses and
// localhost; DNS resolution at delivery time is out of scope (see the comment above).
// added CGNAT 100.64/10 (A TAILNET IS READY TO DELIVER WEBHOOKS — tailscale
// addresses are exactly this zone) and transition v6: 6to4 2002::/16 (first hextet 0x2002),
// NAT64 64:ff9b::/96 — wholesale, without parsing the embedded part: operator input must
// not be able to knock on transition infrastructure.
function isPrivateV4(a, b) {
  if ([0, 10, 127].includes(a)) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT —
  return false;
}
function isPrivateDeliveryHost(hostname) {
  // trailing dots stripped BEFORE the checks  — the root form of an FQDN is legitimate for public hosts
  const host = String(hostname).toLowerCase().replace(/\.+$/, "").replace(/^\[|\]$/g, ""); // bracketed v6
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  // IPv4 literal: 0/8, 10/8, 127/8, 169.254/16 (incl. 169.254.169.254 metadata), 172.16/12, 192.168/16, 100.64/10
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    return isPrivateV4(Number(v4[1]), Number(v4[2]));
  }
  // IPv6 literal (no :: expansion — by the first hextet, %eth0 zones stripped):
  // ::1, fc00::/7 (fc/fd), fe80::/10 (fe80-febf)
  const v6 = host.split("%")[0];
  if (v6 === "::1" || v6 === "::") return true;
  // IPv4-mapped IPv6 : ::ffff:127.0.0.1 / ::ffff:a9fe:a9fe (metadata!)
  // pass the hextet checks — expand the embedded v4 and run it through the v4 classifier
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
  if (mapped) {
    const a = (parseInt(mapped[1], 16) >> 8) & 0xff;
    const b = parseInt(mapped[1], 16) & 0xff;
    const c = (parseInt(mapped[2], 16) >> 8) & 0xff;
    const d = parseInt(mapped[2], 16) & 0xff;
    if ([a, c, d].every((x) => x >= 0 && x <= 255) && b >= 0 && b <= 255) {
      return isPrivateV4(a, b); // a public embedded v4 — a legitimate address
    }
  }
  if (/^2002:/.test(v6)) return true; // 6to4 —
  if (/^64:ff9b:/.test(v6)) return true; // NAT64 —
  const first = /^([0-9a-f]{1,4}):/.exec(v6);
  if (first) {
    const x = parseInt(first[1], 16);
    if ((x & 0xfe00) === 0xfc00) return true; // fc00::/7
    if ((x & 0xffc0) === 0xfe80) return true; // fe80::/10
  }
  return false;
}

/**
 * Cross-process lock of the file store (rounds 8–9): read-modify-write without a lock
 * lost writes with two concurrent CLI calls. The lock is an exclusive-create
 * `<store>.lock` holding {pid, createdAt}. Someone else's FRESH lock — short
 * sync retries (Atomics.wait: updateStore is synchronous). An EXPIRED lock is broken
 * ONLY if its owner is dead: a SIGSTOP-stuck live owner with an old
 * mtime — breaking it would lose its update; kill(pid,0) tells the dead one apart).
 * A kill -9 orphan self-heals via mtime aging: the default attempts cover the whole
 * staleMs. KNOWN TRADE-OFF : a dead owner's pid may be recycled by a long-lived
 * process — then the expired lock is never broken (until a manual rm); rare manual
 * intervention versus losing others' updates — accepted. Failing to take the lock is an
 * honest error, not silence.
 */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // exists but belongs to someone else — alive
  }
}

export function withStoreLock(filePath, fn, { staleMs = 10_000, attempts, retryPauseMs = 5, nowMs = Date.now, writeSync: writeSyncFn = writeSync } = {}) {
  const lockPath = `${filePath}.lock`;
  const maxAttempts = attempts ?? Math.ceil(staleMs / retryPauseMs) + 100;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let fd = null;
  for (let i = 0; i < maxAttempts && fd === null; i++) {
    if (i > 0) Atomics.wait(sleeper, 0, 0, retryPauseMs);
    try {
      fd = openSync(lockPath, "wx");
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        const age = nowMs() - statSync(lockPath).mtimeMs;
        if (age > staleMs) {
          // breaking only a DEAD owner: a live SIGSTOPped process with an old mtime
          // must not lose its update (the TOCTOU of. A legacy lock without
          // pid — by mtime alone, as before.
          let ownerAlive = false;
          try {
            const meta = JSON.parse(readFileSync(lockPath, "utf8"));
            ownerAlive = isPidAlive(meta?.pid);
          } catch { /* not JSON / no file — treat as dead (legacy format) */ }
          if (!ownerAlive) unlinkSync(lockPath);
        }
      } catch { /* the lock vanished between create and stat — the next attempt will take it */ }
    }
  }
  if (fd === null) {
    throw new SubscriptionError(`subscription store is locked by another process (${lockPath} persists)`);
  }
  try {
    writeSyncFn(fd, JSON.stringify({ pid: process.pid, createdAt: new Date(nowMs()).toISOString() }));
  } catch (err) {
    // The lock content is load-bearing (pid-liveness breaking): an empty/truncated file
    // is read by the next process as legacy, and it would break a LIVE owner by mtime —
    // resurrecting the TOCTOU of. Release the lock and fail honestly .
    try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(lockPath); } catch { /* already removed */ }
    throw err;
  }
  try {
    return fn();
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(lockPath); } catch { /* already removed — does not matter */ }
  }
}

function updateStore(filePath, mutate) {
  return withStoreLock(filePath, () => {
    const subs = readStore(filePath);
    const result = mutate(subs);
    writeStore(filePath, subs);
    return result;
  });
}

function makeId() {
  return `wh_${randomUUID()}`;
}

/**
 * Add a subscription. id is generated when not passed (tests use an explicit id);
 * a duplicate id is a rejection (id is the key for remove/deactivate; silently
 * overwriting someone else's subscription is unacceptable).
 * @param {string} filePath — storage path (the file is created on the first write)
 * @param {{id?: string, url: string, symbols: "*"|string[], secret: string, nowMs?: number}} spec
 * @returns {object} the stored subscription
 */
export function addSubscription(filePath, { id, url, symbols, secret, nowMs = Date.now() } = {}) {
  const record = { id: id ?? makeId(), url, symbols, secret, createdAt: new Date(nowMs).toISOString(), active: true };
  validateSubscription(record);
  return updateStore(filePath, (subs) => {
    if (subs.some((s) => s.id === record.id)) {
      throw new SubscriptionError(`subscription with id "${record.id}" already exists`, "id");
    }
    subs.push(record);
    return record;
  });
}

/**
 * List subscriptions; no file — an empty array. Returns a copy: mutating the result
 * must not touch the disk or affect subsequent calls.
 */
export function listSubscriptions(filePath) {
  return readStore(filePath).map((s) => ({ ...s, symbols: s.symbols === "*" ? "*" : [...s.symbols] }));
}

/**
 * Delete a subscription by id. @returns {boolean} found and removed.
 */
export function removeSubscription(filePath, id) {
  return updateStore(filePath, (subs) => {
    const i = subs.findIndex((s) => s.id === id);
    if (i === -1) return false;
    subs.splice(i, 1);
    return true;
  });
}

/**
 * Deactivate a subscription (active=false, the record stays). Deactivating an already
 * disabled one is not an error. @returns {boolean} whether the id was found.
 */
export function deactivateSubscription(filePath, id) {
  return updateStore(filePath, (subs) => {
    const sub = subs.find((s) => s.id === id);
    if (!sub) return false;
    sub.active = false;
    return true;
  });
}

// ---------- matching ----------

/**
 * Subscriptions addressed by an event. Matching is by token identifier: the wildcard "*"
 * catches everything; otherwise the record's symbols are compared with the event's symbol OR its mint
 * (a mint in the list is a legitimate way to subscribe: the registry is keyed by mints, and
 * a symbol is not unique). Matching is EXACT: base58 mints are case-sensitive, "smart"
 * case-folding would break them. Active state is NOT filtered here — pure matching;
 * deliverToAll decides "deliver or not".
 * @param {Array} subs
 * @param {{symbol?: string, mint?: string}} ctx — event identifiers
 */
export function matchSubscriptions(subs, { symbol, mint } = {}) {
  return subs.filter((sub) => {
    if (sub.symbols === "*") return true;
    if (symbol !== undefined && sub.symbols.includes(symbol)) return true;
    if (mint !== undefined && sub.symbols.includes(mint)) return true;
    return false;
  });
}

// ---------- delivery ----------

/**
 * Symbol/mint of an event for matching. Canonical events carry no symbol
 * (the schema is mint-only), except TICKER_CHANGE where oldSymbol/newSymbol are part
 * of the type contract; an operator's file may also carry a raw symbol field.
 * Preference — the CURRENT name (symbol, then newSymbol): after a ticker change
 * the live identifier is the new name; holders of the old one are addressed by mint.
 */
function eventContext(event) {
  return { symbol: event.symbol ?? event.newSymbol ?? event.oldSymbol, mint: event.mint };
}

// Deterministic delivery id : sha256(subscription × canonical JSON
// of the event). A delivery run over the same events file mints THE SAME
// X-Lotwise-Delivery — the receiver dedupes across runs, not only within
// the retries of one delivery (previously each run = randomUUID = a "new" event).
// sentAt is NOT part of the id (it changes between runs); identity = the pair
// (subscription, event) with key canonicalization — JSON field order does not matter.
function canonicalJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
}

function deterministicDeliveryId(sub, event) {
  const key = `${String(sub.id ?? sub.url)}|${canonicalJson(event)}`;
  return `whd_${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

/**
 * Deliver a single event to a single subscription. POSTs the JSON envelope
 * {deliveryId, sentAt, event}; the signature is HMAC-SHA256(secret, body) — exactly
 * the sent body, byte for byte. Up to MAX_ATTEMPTS attempts with BACKOFF_MS backoff;
 * success = 2xx, everything else (non-2xx, a network failure, a timeout, 3xx — redirect:error)
 * means the attempt failed. Network and timers are injectable: tests use a mock fetcher
 * and mock-sleep without pauses.
 * Idempotency: deliveryId is by default DETERMINISTIC from the pair (subscription,
 * event) — a repeated delivery run gives the receiver an already familiar id; an explicit
 * opts.deliveryId wins (one-off deliveries with an external identifier).
 * @param {object} sub — a valid subscription (url, secret)
 * @param {object} event — a valid canonical event (schema/events.mjs)
 * @param {{fetcher?: Function, sleep?: Function, timeoutMs?: number, deliveryId?: string, nowMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, attempts: number, statuses: Array<number|null>, error: string|null}>}
 *   statuses — per attempt: the HTTP status or null (network/timeout); error — the last cause.
 */
export async function deliverWebhook(
  sub,
  event,
  { fetcher = fetch, sleep = defaultSleep, timeoutMs = DEFAULT_TIMEOUT_MS, deliveryId, nowMs = Date.now() } = {},
) {
  // validate the event BEFORE the envelope — deliverToAll checks every
  // event, but a direct deliverWebhook call built X-Lotwise-* headers from unvalidated input
  // (the undici barrier saved the wire; the contract should not depend on it)
  validateEvent(event);
  const id = deliveryId ?? deterministicDeliveryId(sub, event);
  // The envelope and signature are fixed BEFORE the attempts: all retries carry the same
  // payload and the same signature (the receiver verifies the signature on every repeat).
  const body = JSON.stringify({ deliveryId: id, sentAt: new Date(nowMs).toISOString(), event });
  const signature = `sha256=${createHmac("sha256", sub.secret).update(body).digest("hex")}`;
  const headers = {
    "content-type": "application/json",
    "x-lotwise-event": String(event.type),
    "x-lotwise-delivery": id,
    "x-lotwise-signature": signature,
  };

  const statuses = [];
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // AbortSignal.timeout — one timeout per attempt (not per series): a hung
      // receiver does not eat the remaining attempts. redirect:"error" :
      // the default "follow" turned a 302 into an empty GET to a foreign host, where a 2xx
      // counted as delivery while the HMAC-signed headers leaked to the redirect target.
      // A 3xx fails the attempt, like a network failure.
      const res = await fetcher(sub.url, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
      statuses.push(res.status);
      if (res.status >= 200 && res.status < 300) {
        return { ok: true, attempts: attempt, statuses, error: null };
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      statuses.push(null);
      lastError = String(err?.cause?.message ?? err?.message ?? err);
    }
    if (attempt < MAX_ATTEMPTS) await sleep(BACKOFF_MS[attempt - 1]);
  }
  return { ok: false, attempts: MAX_ATTEMPTS, statuses, error: lastError };
}

/**
 * Deliver a list of events to all matching subscriptions. Events are validated
 * by the schema BEFORE the first send: a broken tail of the list must not get halfway out.
 * Counters: delivered — (event, subscription) pairs with 2xx; failed — retries exhausted;
 * skipped — pairs without an attempt: an inactive subscription under a match, or an event
 * with no addressee at all ("nobody to deliver to" is not a failure, a separate report line).
 * symbolToMint : a Map symbol→mint from the registry. Canonical events carry no
 * symbol (the schema is mint-only) — without the map a ticker subscription silently yielded
 * 0 deliveries with exit 0 (a silent failure, an integrator finding). With the map, subscription
 * symbols resolve to mints BEFORE matching; a symbol outside the map is a warning (the typo
 * is visible immediately), delivery is not blocked.
 * @param {Array} events — canonical events
 * @param {Array} subs — subscriptions (e.g. listSubscriptions(path))
 * @param {{fetcher?: Function, sleep?: Function, timeoutMs?: number, nowMs?: number,
 *          symbolToMint?: Map<string,string>}} [opts]
 * @returns {Promise<{delivered: number, skipped: number, failed: number,
 *                     deliveries: Array<{subscriptionId: string, eventType: string,
 *                                        ok: boolean, attempts: number, statuses: Array, error: string|null}>,
 *                     warnings: string[]}>}
 */
export async function deliverToAll(events, subs, opts = {}) {
  const { fetcher = fetch, sleep = defaultSleep, timeoutMs = DEFAULT_TIMEOUT_MS, nowMs = Date.now(), symbolToMint = null } = opts;
  for (const event of events) validateEvent(event); // fail-fast before any sends

  // resolve subscription symbols to mints via the registry. A canonical event
  // carries no symbol — without this step a ["SPYx"] subscription matches only the raw
  // symbol fields of an operator's file and silently delivers nothing.
  const symbolWarnings = new Set();
  let effectiveSubs = subs;
  if (symbolToMint instanceof Map && symbolToMint.size > 0) {
    // the map is keyed by symbols, but a mint identifier is a documented way
    // to subscribe too (README §Webhooks) and matches the canonical event as-is. Only
    // an identifier in NEITHER the keys nor the values is a warning — a false alarm on
    // every run would train the operator to ignore the channel.
    const registryMints = new Set(symbolToMint.values());
    effectiveSubs = subs.map((sub) => {
      if (sub.symbols === "*") return sub;
      const mints = [];
      for (const s of sub.symbols) {
        const mint = symbolToMint.get(s);
        if (mint !== undefined) mints.push(mint);
        else if (!registryMints.has(s)) symbolWarnings.add(`subscription ${sub.id}: identifier ${JSON.stringify(s)} not found in the registry — matched only against raw symbol/newSymbol event fields`);
      }
      return mints.length > 0 ? { ...sub, symbols: [...sub.symbols, ...mints] } : sub;
    });
  }

  const counters = { delivered: 0, skipped: 0, failed: 0 };
  const deliveries = [];
  const warnings = [...symbolWarnings];
  for (const event of events) {
    const matches = matchSubscriptions(effectiveSubs, eventContext(event));
    let attempted = 0;
    for (const sub of matches) {
      if (!sub.active) {
        counters.skipped += 1;
        warnings.push(`subscription ${sub.id} is inactive — event ${event.type} not delivered`);
        continue;
      }
      attempted += 1;
      const result = await deliverWebhook(sub, event, { fetcher, sleep, timeoutMs, nowMs });
      if (result.ok) counters.delivered += 1;
      else counters.failed += 1;
      deliveries.push({ subscriptionId: sub.id, eventType: event.type, ...result });
    }
    if (matches.length === 0) {
      counters.skipped += 1;
      warnings.push(`event ${event.type} (${event.mint}) — no matching subscriptions`);
    }
  }
  return { ...counters, deliveries, warnings };
}
