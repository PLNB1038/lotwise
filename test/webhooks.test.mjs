// Tests of the webhook subscriptions: the store (CRUD+validations), matching, delivery
// (the HMAC signature, retries with a 1s/4s backoff, network failures) and deliverToAll.
// NO NETWORK AND NO TIMERS: fetcher and sleep are mocks (a retry scenario with real
// 1s+4s pauses would take 5+ seconds per test); CLI scenarios with network run
// via main(argv, {fetcher, sleep}) with injection, spawnSync — only the no-network paths.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  addSubscription,
  deactivateSubscription,
  deliverToAll,
  deliverWebhook,
  listSubscriptions,
  matchSubscriptions,
  removeSubscription,
  SubscriptionError,
  validateSubscription,
} from "../src/webhooks/subscriptions.mjs";
import { main } from "../scripts/webhook-deliver.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "webhook-deliver.mjs");

// A canonical event passing validateEvent (schema/events.mjs).
const MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const SPLIT = {
  type: "SPLIT",
  mint: MINT,
  effectiveDate: "2026-06-10T04:30:00.000Z",
  status: "confirmed",
  sources: ["https://api.xstocks.fi/api/v2/public/assets/SPYx"],
  ratioNumerator: 3,
  ratioDenominator: 1,
};
const TICKER = {
  type: "TICKER_CHANGE",
  mint: MINT,
  effectiveDate: "2026-06-11T00:00:00.000Z",
  status: "confirmed",
  sources: ["issuer-notice"],
  oldSymbol: "OLD",
  newSymbol: "NEW",
};

const SUB = {
  id: "wh_test",
  url: "https://hooks.example.com/lotwise",
  symbols: "*",
  secret: "s3cret",
  createdAt: "2026-09-22T00:00:00.000Z",
  active: true,
};

const freshDir = () => mkdtempSync(path.join(tmpdir(), "lotwise-webhooks-"));
const created = [];
const tempFile = (name, content) => {
  const file = path.join(freshDir(), name);
  created.push(path.dirname(file));
  if (content !== undefined) writeFileSync(file, content);
  return file;
};
test.after(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
});

// A mock fetcher by a status scenario: a number = an HTTP status, an Error = a network failure.
// An extra request beyond the scenario = a test failure (it catches extra attempts/deliveries).
const fetcherOf = (seq, calls = []) => async (url, init) => {
  if (calls.length >= seq.length) throw new Error(`an unexpected request beyond the scenario: ${url}`);
  calls.push({ url, init });
  const next = seq[calls.length - 1];
  if (next instanceof Error) throw next;
  return { status: next };
};
const captureFetcher = (calls = []) => async (url, init) => {
  calls.push({ url, init });
  return { status: 200 };
};
const hmac = (secret, body) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

// ---------- the store: CRUD + validations ----------

test("addSubscription: writes atomically, the record complete, active:true, createdAt ISO", () => {
  const file = tempFile("webhooks.json");
  const rec = addSubscription(file, { id: "wh_a", url: "https://h.example/x", symbols: ["SPYx"], secret: "k", nowMs: 0 });
  assert.deepEqual(rec, { id: "wh_a", url: "https://h.example/x", symbols: ["SPYx"], secret: "k", createdAt: "1970-01-01T00:00:00.000Z", active: true });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), [rec]);
});

test("addSubscription without an id generates unique wh_*", () => {
  const file = tempFile("webhooks.json");
  const a = addSubscription(file, { url: "https://h.example/a", symbols: "*", secret: "k" });
  const b = addSubscription(file, { url: "https://h.example/b", symbols: "*", secret: "k" });
  assert.notEqual(a.id, b.id);
  assert.match(a.id, /^wh_/);
  assert.equal(listSubscriptions(file).length, 2);
});

test("validations: a broken url / non-http(s), an empty secret, garbage symbols, active, createdAt — with the field name", () => {
  const base = { id: "x", url: "https://h.example", symbols: "*", secret: "k", createdAt: "2026-09-22T00:00:00.000Z", active: true };
  const bad = (patch, field) => {
    try {
      validateSubscription({ ...base, ...patch });
      assert.fail(`a refusal expected: ${JSON.stringify(patch)}`);
    } catch (err) {
      assert.ok(err instanceof SubscriptionError, `a SubscriptionError expected, got ${err.name}`);
      assert.equal(err.field, field, `${JSON.stringify(patch)} -> the field ${field}, got ${err.field}`);
    }
  };
  bad({ url: "not-a-url" }, "url");
  bad({ url: "ftp://h.example" }, "url");
  bad({ url: "" }, "url");
  bad({ secret: "" }, "secret");
  bad({ symbols: [] }, "symbols");
  bad({ symbols: "SPYx" }, "symbols"); // a non-wildcard string: the list must be an array
  bad({ symbols: ["SPYx", ""] }, "symbols");
  bad({ active: "yes" }, "active");
  bad({ createdAt: "yesterday" }, "createdAt");
  bad({ id: "" }, "id");
  assert.equal(validateSubscription({ ...base, symbols: "*" }), true);
  assert.equal(validateSubscription({ ...base, symbols: [MINT] }), true); // a mint — a legal identifier
});

test("a duplicate id — a refusal, the file unchanged", () => {
  const file = tempFile("webhooks.json");
  addSubscription(file, { id: "wh_dup", url: "https://h.example", symbols: "*", secret: "k", nowMs: 0 });
  const before = readFileSync(file, "utf8");
  assert.throws(() => addSubscription(file, { id: "wh_dup", url: "https://h.example/2", symbols: "*", secret: "k" }), (e) => e.field === "id");
  assert.equal(readFileSync(file, "utf8"), before);
});

test("list: no file = []; the result is a copy (edits do not reach the disk)", () => {
  const file = tempFile("webhooks.json");
  assert.deepEqual(listSubscriptions(file), []);
  addSubscription(file, { id: "wh_c", url: "https://h.example", symbols: ["A", "B"], secret: "k", nowMs: 0 });
  const list = listSubscriptions(file);
  list[0].symbols.push("JUNK");
  list[0].active = false;
  assert.deepEqual(listSubscriptions(file)[0].symbols, ["A", "B"]);
  assert.equal(listSubscriptions(file)[0].active, true);
});

test("remove/deactivate: true-then-false, a deactivation survives the write and a repeat", () => {
  const file = tempFile("webhooks.json");
  addSubscription(file, { id: "wh_d", url: "https://h.example", symbols: "*", secret: "k", nowMs: 0 });
  assert.equal(deactivateSubscription(file, "wh_d"), true);
  assert.equal(listSubscriptions(file)[0].active, false, "active:false must reach the disk");
  assert.equal(deactivateSubscription(file, "wh_d"), true, "a repeated deactivation is not an error");
  assert.equal(deactivateSubscription(file, "wh_nope"), false);
  assert.equal(removeSubscription(file, "wh_d"), true);
  assert.deepEqual(listSubscriptions(file), []);
  assert.equal(removeSubscription(file, "wh_d"), false);
});

test("a broken store — a loud refusal on ANY operation, the file not rewritten", () => {
  for (const content of ["{trunca", "null", JSON.stringify([{ ...SUB, url: "ftp://x" }])]) {
    const file = tempFile("webhooks.json", content);
    const before = readFileSync(file, "utf8");
    assert.throws(() => listSubscriptions(file), SubscriptionError);
    assert.throws(() => addSubscription(file, { url: "https://h.example", symbols: "*", secret: "k" }), SubscriptionError);
    assert.equal(readFileSync(file, "utf8"), before, "a broken base must not be silently rewritten");
  }
});

// ---------- matchSubscriptions ----------

test("matching: a wildcard catches everything, a list — an exact symbol, a mint matches by mint", () => {
  const subs = [
    { id: "w", symbols: "*", active: true },
    { id: "s", symbols: ["SPYx"], active: true },
    { id: "m", symbols: [MINT], active: true },
  ];
  const bySymbol = { symbol: "SPYx", mint: MINT };
  assert.deepEqual(matchSubscriptions(subs, bySymbol).map((s) => s.id), ["w", "s", "m"]);
  assert.deepEqual(matchSubscriptions(subs, { symbol: "OTHER", mint: MINT }).map((s) => s.id), ["w", "m"]);
  // an event without a symbol (canonical — mint-only): only the wildcard and the mint subscription
  assert.deepEqual(matchSubscriptions(subs, { mint: MINT }).map((s) => s.id), ["w", "m"]);
  assert.deepEqual(matchSubscriptions(subs, {}), [subs[0]]);
  // the matching is exact: base58 mints are case-sensitive, case-folding would break them
  assert.deepEqual(matchSubscriptions(subs, { symbol: "spyx", mint: "x".repeat(44) }), [subs[0]]);
});

// ---------- deliverWebhook: the signature, headers, retries ----------

test("delivery: a POST of the JSON envelope, the headers, the HMAC deterministic (recomputed in the test)", async () => {
  const calls = [];
  const sleeps = [];
  const res = await deliverWebhook(SUB, SPLIT, {
    fetcher: fetcherOf([200], calls),
    sleep: async (ms) => sleeps.push(ms),
    deliveryId: "dlv-1",
    nowMs: 1_000,
  });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, SUB.url);
  assert.equal(init.method, "POST");
  assert.ok(init.signal instanceof AbortSignal, "the timeout goes through an AbortSignal");
  assert.equal(init.headers["x-lotwise-event"], "SPLIT");
  assert.equal(init.headers["x-lotwise-delivery"], "dlv-1");
  // Recomputing the signature over the EXACT request body — the main check of the contract.
  assert.equal(init.headers["x-lotwise-signature"], hmac(SUB.secret, init.body));
  assert.deepEqual(JSON.parse(init.body), { deliveryId: "dlv-1", sentAt: "1970-01-01T00:00:01.000Z", event: SPLIT });
  assert.deepEqual(res, { ok: true, attempts: 1, statuses: [200], error: null });
  assert.deepEqual(sleeps, [], "success on the first attempt — no pauses");
});

test("the signature is deterministic with the same body and changes with the secret", async () => {
  const a = [];
  const b = [];
  const opts = { deliveryId: "dlv-x", nowMs: 5 };
  await deliverWebhook(SUB, SPLIT, { fetcher: captureFetcher(a), ...opts });
  await deliverWebhook(SUB, SPLIT, { fetcher: captureFetcher(b), ...opts });
  assert.equal(a[0].init.body, b[0].init.body, "the body byte-for-byte the same");
  assert.equal(a[0].init.headers["x-lotwise-signature"], b[0].init.headers["x-lotwise-signature"]);
  const other = [];
  await deliverWebhook({ ...SUB, secret: "another-key" }, SPLIT, { fetcher: captureFetcher(other), ...opts });
  assert.notEqual(other[0].init.headers["x-lotwise-signature"], a[0].init.headers["x-lotwise-signature"]);
});

test("a non-2xx is retried: a 2xx on the second attempt, a pause of only 1000", async () => {
  const calls = [];
  const sleeps = [];
  const res = await deliverWebhook(SUB, SPLIT, { fetcher: fetcherOf([500, 200], calls), sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(res.statuses, [500, 200]);
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 2);
  assert.deepEqual(sleeps, [1000]);
});

test("exhausting the retries: 3 attempts, a backoff [1000,4000], an honest failure", async () => {
  const calls = [];
  const sleeps = [];
  const res = await deliverWebhook(SUB, SPLIT, { fetcher: fetcherOf([500, 503, 500], calls), sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(res, { ok: false, attempts: 3, statuses: [500, 503, 500], error: "HTTP 500" });
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [1000, 4000]);
  // All the retries carry a byte-for-byte identical payload and signature (idempotence).
  assert.equal(calls[0].init.body, calls[2].init.body);
  assert.equal(calls[0].init.headers["x-lotwise-signature"], calls[2].init.headers["x-lotwise-signature"]);
  assert.equal(calls[2].init.headers["x-lotwise-delivery"], calls[0].init.headers["x-lotwise-delivery"]);
});

test("a network failure: 3 attempts, null statuses, the last error's cause in the result", async () => {
  const calls = [];
  const sleeps = [];
  const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { cause: new Error("ECONNREFUSED") });
  const res = await deliverWebhook(SUB, SPLIT, { fetcher: fetcherOf([refused, refused, refused], calls), sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(res, { ok: false, attempts: 3, statuses: [null, null, null], error: "ECONNREFUSED" });
  assert.deepEqual(sleeps, [1000, 4000]);
});

test("success on the last attempt: the retries stop right after a 2xx", async () => {
  const calls = [];
  const sleeps = [];
  const res = await deliverWebhook(SUB, SPLIT, { fetcher: fetcherOf([502, 502, 204], calls), sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(res.statuses, [502, 502, 204]);
  assert.equal(res.ok, true);
  assert.deepEqual(sleeps, [1000, 4000]);
  assert.equal(calls.length, 3);
});

// ---------- deliverToAll ----------

const SUBS = [
  { id: "wild", url: "https://h.example/w", symbols: "*", secret: "k", createdAt: "2026-09-22T00:00:00.000Z", active: true },
  { id: "spyx", url: "https://h.example/s", symbols: ["NEW"], secret: "k", createdAt: "2026-09-22T00:00:00.000Z", active: true },
  { id: "off", url: "https://h.example/o", symbols: "*", secret: "k", createdAt: "2026-09-22T00:00:00.000Z", active: false },
];

test("deliverToAll: the delivered/skipped/failed counters and the addressee targeting", async () => {
  const calls = [];
  const sleeps = [];
  // TICKER (newSymbol=NEW): wild + spyx match (by symbol) + off (wild, inactive
  // -> skipped without a request). SPLIT (mint-only): wild + off match (skipped again).
  const report = await deliverToAll([TICKER, SPLIT], SUBS, {
    fetcher: fetcherOf([200, 200, 404, 404, 404], calls),
    sleep: async (ms) => sleeps.push(ms),
  });
  assert.equal(report.delivered, 2, "wild(TICKER) + spyx(TICKER)");
  assert.equal(report.failed, 1, "wild(SPLIT) with the burned retries");
  assert.equal(report.skipped, 2, "off under the match of both events — one skipped per each");
  assert.equal(calls.length, 5, "3 deliveries, one of them with 3 retries");
  assert.deepEqual(sleeps, [1000, 4000], "the pauses only between the attempts of the burned delivery");
});

test("deliverToAll: an exact breakdown of the report by deliveries/warnings", async () => {
  const report = await deliverToAll([TICKER, SPLIT], SUBS, {
    fetcher: fetcherOf([200, 200, 404, 404, 404]),
    sleep: async () => {},
  });
  assert.deepEqual(report.delivered, 2);
  assert.deepEqual(report.failed, 1);
  assert.deepEqual(report.skipped, 2);
  const bySub = Object.fromEntries(report.deliveries.map((d) => [`${d.subscriptionId}:${d.eventType}`, d]));
  assert.equal(bySub["wild:TICKER_CHANGE"].ok, true);
  assert.equal(bySub["spyx:TICKER_CHANGE"].ok, true);
  assert.equal(bySub["wild:SPLIT"].ok, false);
  assert.deepEqual(bySub["wild:SPLIT"].statuses, [404, 404, 404]);
  assert.ok(report.warnings.every((w) => w.includes("off")), "both skipped — from the inactive off");
  assert.equal(report.warnings.length, 2);
});

test("deliverToAll: an event with no addressee at all — skipped, not a single request", async () => {
  const calls = [];
  const report = await deliverToAll([SPLIT], [SUBS[1]], { fetcher: captureFetcher(calls) });
  assert.deepEqual({ delivered: report.delivered, skipped: report.skipped, failed: report.failed }, { delivered: 0, skipped: 1, failed: 0 });
  assert.equal(calls.length, 0);
});

test("deliverToAll: a broken event in the list — a refusal BEFORE the first send (fail-fast)", async () => {
  const calls = [];
  const broken = { ...SPLIT, type: "NONEXISTENT" };
  await assert.rejects(
    () => deliverToAll([SPLIT, broken], SUBS, { fetcher: captureFetcher(calls) }),
    (err) => err.name === "EventValidationError" && err.field === "type",
  );
  assert.equal(calls.length, 0, "the broken tail must not let half the list out");
});

// ---------- CLI: main() with injection (the network scenarios — mocks) + spawnSync (no network) ----------

test("CLI main: failed=0 (all skipped) — exit 0; an empty stdin list — exit 0", async () => {
  const events = tempFile("events.json", JSON.stringify([SPLIT]));
  const noSubs = tempFile("webhooks.json"); // no subscriptions file — nobody to deliver to
  const code = await main(["--events", events, "--subscriptions", noSubs, "--json"], {
    fetcher: async () => { throw new Error("going to the network is not allowed"); },
  });
  assert.equal(code, 0, "\"nobody to deliver to\" — not a failure");
});

test("CLI main: all retries exhausted — exit 1, the pauses mocked", async () => {
  const events = tempFile("events.json", JSON.stringify([SPLIT]));
  const subs = tempFile("webhooks.json");
  addSubscription(subs, { id: "wh_e", url: "https://h.example/e", symbols: "*", secret: "k", nowMs: 0 });
  const calls = [];
  const sleeps = [];
  const code = await main(["--events", events, "--subscriptions", subs, "--json"], {
    fetcher: fetcherOf([500, 500, 500], calls),
    sleep: async (ms) => sleeps.push(ms),
  });
  assert.equal(code, 1);
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [1000, 4000], "the CLI must not hit a real setTimeout in the tests");
});

test("CLI main: exit 2 — an unknown flag, broken events, broken subscriptions, an invalid event", async () => {
  const subs = tempFile("webhooks.json");
  addSubscription(subs, { id: "wh_f", url: "https://h.example", symbols: "*", secret: "k", nowMs: 0 });
  const events = tempFile("events.json", JSON.stringify([SPLIT]));

  assert.equal(await main(["--no-such-flag"], { fetcher: captureFetcher() }), 2);
  assert.equal(await main(["--events", tempFile("bad.json", "{trunca")], { fetcher: captureFetcher() }), 2);
  assert.equal(await main(["--events", tempFile("notarray.json", JSON.stringify(SPLIT))], { fetcher: captureFetcher() }), 2);
  assert.equal(await main(["--events", events, "--subscriptions", tempFile("corrupt.json", "[]garbage")], { fetcher: captureFetcher() }), 2);
  const invalidEvent = tempFile("invalid-event.json", JSON.stringify([{ ...SPLIT, mint: "not-a-mint" }]));
  assert.equal(await main(["--events", invalidEvent, "--subscriptions", subs], { fetcher: captureFetcher() }), 2);
});

test("CLI spawnSync: --help — exit 0 with the help; an unknown flag and no file — exit 2", () => {
  const help = spawnSync(process.execPath, [SCRIPT, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, `stderr: ${help.stderr}`);
  assert.match(help.stdout, /--subscriptions/);
  const badFlag = spawnSync(process.execPath, [SCRIPT, "--what"], { encoding: "utf8" });
  assert.equal(badFlag.status, 2);
  const noFile = spawnSync(process.execPath, [SCRIPT, "--events", path.join(tmpdir(), "webhooks-no-such-xyz.json")], { encoding: "utf8", input: "" });
  assert.equal(noFile.status, 2);
});

test("CLI spawnSync: events via stdin (a pipe, no network), an empty subscriptions file — a JSON report and exit 0", () => {
  const subs = tempFile("webhooks.json", "[]");
  const res = spawnSync(process.execPath, [SCRIPT, "--subscriptions", subs, "--json"], {
    encoding: "utf8",
    input: JSON.stringify([SPLIT, TICKER]),
  });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const report = JSON.parse(res.stdout);
  assert.deepEqual(
    { delivered: report.delivered, skipped: report.skipped, failed: report.failed },
    { delivered: 0, skipped: 2, failed: 0 },
  );
  assert.equal(report.deliveries.length, 0);
  assert.equal(report.warnings.length, 2, "each event honestly marked \"no addressees\"");
});
