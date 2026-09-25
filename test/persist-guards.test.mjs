
// regression tests of the Lotwise review — persistence/delivery.
// regression findings:
//   #4 (events/journal.mjs): the corruption guard `typeof priorEntry === "object"` let
//       string/number records through — corruption was treated as "no history": the backfill
//       re-emitted a duplicate event, corrupted:false, and the final persist clobbered the evidence
//       without a .corrupt-* name only closed events-NOT-array).
//   #5 (webhooks/subscriptions.mjs): fetch with the default redirect:"follow" — a 302 from
//       the receiver turned into an empty GET; a 2xx at the redirect target = ok:true, the event
//       lost from the system's view, and the headers with the HMAC signature leaked to a foreign host.
//   #16 (issuer/scaled-ui.mjs + normalize-onchain): the multiplier is stored as it came from
//       RPC; a string diff of the journal "5" vs "5.0" (a representation change, not a value change)
//       emitted and persisted a phantom MULTIPLIER_CHANGE forever.
import test from "node:test";
import assert from "node:assert/strict";
import { planJournalStep } from "../src/events/journal.mjs";
import { parseScaledUiAmount } from "../src/issuer/scaled-ui.mjs";
import { deliverWebhook } from "../src/webhooks/subscriptions.mjs";

const MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const TOKEN = { mint: MINT, symbol: "TESTx" };

const mintState = (state) => ({
  owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  data: { parsed: { info: { decimals: 8, extensions: [{ extension: "scaledUiAmountConfig", state: { newMultiplierEffectiveTimestamp: 0, ...state } }] } } },
});
// a completed rotation: no pending, only active lives
const settled = (multiplier) => mintState({ multiplier, newMultiplier: 0 });
// a rotation in flight: active + pending with an activation date in the past
const rotation = (active, pending) => mintState({
  multiplier: active, newMultiplier: pending, newMultiplierEffectiveTimestamp: Date.UTC(2026, 5, 10) / 1000,
});

// ---- a non-object journal record = corruption, not "no history" ----

test("journal: a STRING record — corrupted:true, the backfill event duplicate is NOT re-emitted", () => {
  const parsed = parseScaledUiAmount(rotation("1", "5"));
  const r = planJournalStep(TOKEN, "5 (garbage)", parsed);
  assert.equal(r.corrupted, true, "a string instead of {lastEffective,events} — corruption");
  assert.equal(r.event, null, "the backfill over an untrusted base is suppressed");
  assert.deepEqual(r.replay, []);
});

test("journal: a NUMBER/BOOLEAN record — the same corrupted path as events-not-array", () => {
  const parsed = parseScaledUiAmount(rotation("1", "5"));
  for (const bad of [5, true]) {
    const r = planJournalStep(TOKEN, bad, parsed);
    assert.equal(r.corrupted, true, `a ${typeof bad} record — corruption`);
    assert.equal(r.event, null);
  }
});

test("journal: corruption + an unavailable chain — entry:null (the on-disk evidence is untouched), corrupted:true", () => {
  const r = planJournalStep(TOKEN, "5 (garbage)", null);
  assert.equal(r.corrupted, true);
  assert.equal(r.entry, null);
  assert.equal(r.chain, "unavailable");
});

test("journal: null/undefined remain a legitimate \"no record\" — no regression of the tightening", () => {
  const parsed = parseScaledUiAmount(rotation("1", "5"));
  for (const legit of [null, undefined]) {
    const r = planJournalStep(TOKEN, legit, parsed);
    assert.equal(r.corrupted, false, `${legit} — a first observation, not corruption`);
    assert.ok(r.event !== null, "the 1→5 backfill on a first observation works as before");
    assert.equal(r.event.multiplierFrom, "1");
    assert.equal(r.event.multiplierTo, "5");
  }
});

// ---- a canonical multiplier spelling at the parser output ----

test("scaled-ui: the multiplier is canonicalized — \"5.0\"→\"5\", \"05\"→\"5\", \"1.10\"→\"1.1\"", () => {
  assert.equal(parseScaledUiAmount(settled("5.0")).activeMultiplier, "5");
  assert.equal(parseScaledUiAmount(settled("05")).activeMultiplier, "5");
  assert.equal(parseScaledUiAmount(settled("1.10")).activeMultiplier, "1.1");
  assert.equal(parseScaledUiAmount(settled("1.003909240011759")).activeMultiplier, "1.003909240011759", "significant digits are untouched");
});

test("scaled-ui: pending is canonicalized too (\"5.000\"→\"5\")", () => {
  const m = rotation("1", "5.000");
  const parsed = parseScaledUiAmount(m);
  assert.equal(parsed.pendingMultiplier, "5");
});

test("reconcile: a representation drift of the same value (api \"1.10\" vs chain \"1.1\") — ok, not planes-disagree (Jev R3, the R7-16 tail)", async () => {
  const { reconcileMultiplier } = await import("../src/issuer/scaled-ui.mjs");
  const onChain = parseScaledUiAmount(settled("1.1"));
  const r = reconcileMultiplier("1.10", onChain, "2026-01-01T00:00:00Z");
  assert.equal(r.verdict, "ok");
  assert.equal(r.agree, true);
  // a real divergence of values is caught as before
  const bad = reconcileMultiplier("1.9", onChain, "2026-01-01T00:00:00Z");
  assert.equal(bad.verdict, "planes-disagree");
  // the displayed values are not repainted — shown as they came
  assert.equal(r.api, "1.10");
  assert.equal(r.onChainEffective, "1.1");
});

test("journal: a representation change of the same value (\"5\" on chain → \"5.0\" in RPC) — NO phantom event", () => {
  // boot-1: a first observation, active="5" → an entry with event 1→5
  const boot1 = planJournalStep(TOKEN, null, parseScaledUiAmount(rotation("1", "5")));
  assert.ok(boot1.event);
  // boot-2: RPC changed the spelling of the same value to "5.0"
  const boot2 = planJournalStep(TOKEN, boot1.entry, parseScaledUiAmount(settled("5.0")));
  assert.equal(boot2.event, null, "5 → 5.0 — not an event");
  assert.equal(boot2.entry.lastEffective, "5", "the canonical form eats the representation diff");
  assert.equal(boot2.entry.events.length, 1, "the phantom is not persisted into the history");
});

// ---- a webhook redirect — a failure, not a quiet "successful" delivery ----

const EVENT = {
  type: "MULTIPLIER_CHANGE", mint: MINT,
  effectiveDate: "2026-06-10T04:30:00.000Z", status: "confirmed",
  sources: ["test:fixture"], multiplierFrom: "1", multiplierTo: "5",
  reason: "On-chain rebase",
};

// a fetcher with the semantics of real fetch: redirect:"error" → a 3xx throws TypeError;
// without the option — it "follows" the redirect with an empty GET and returns the redirect target's 200.
function makeRedirectingFetcher(log) {
  return async (url, init) => {
    log.push({ url, redirect: init?.redirect ?? null, method: init?.method ?? "?" });
    if (init?.redirect === "error") throw new TypeError("Unexpected redirect");
    return new Response("homepage", { status: 200 });
  };
}

test("webhook: a 3xx from the receiver — the attempt FAILED (redirect:error), ok:false after retries", async () => {
  const log = [];
  const r = await deliverWebhook(
    { url: "https://receiver.example/hook", secret: "s3cret" },
    EVENT,
    { fetcher: makeRedirectingFetcher(log), sleep: async () => {}, nowMs: Date.parse("2026-09-23T18:00:00Z") },
  );
  assert.equal(r.ok, false, "a delivery via a redirect does not count as successful");
  assert.equal(r.attempts, 3); // retries exhausted — a signal to the operator, the event did not "vanish"
  assert.ok(r.statuses.every((s) => s === null));
  assert.ok(log.every((l) => l.redirect === "error"), "every attempt explicitly forbids following the redirect");
  assert.ok(log.every((l) => l.method === "POST"), "the signature and body do not go to the redirect target via GET");
});

test("webhook: an honest 2xx without a redirect — ok:true, the response shape unchanged", async () => {
  const r = await deliverWebhook(
    { url: "https://receiver.example/hook", secret: "s3cret" },
    EVENT,
    { fetcher: async () => new Response("ok", { status: 200 }), sleep: async () => {}, nowMs: Date.parse("2026-09-23T18:00:00Z") },
  );
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 1);
  assert.deepEqual(r.statuses, [200]);
});

// ---- a deterministic deliveryId across runs ----

test("webhook: the same (subscription, event) on a repeated run — the SAME deliveryId", async () => {
  const sub = { id: "wh_1", url: "https://receiver.example/hook", secret: "s3cret" };
  const bodies = [];
  const fetcher = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response("ok", { status: 200 });
  };
  await deliverWebhook(sub, EVENT, { fetcher, sleep: async () => {}, nowMs: 1 });
  await deliverWebhook(sub, EVENT, { fetcher, sleep: async () => {}, nowMs: 2 }); // another run — another sentAt
  assert.equal(bodies[0].deliveryId, bodies[1].deliveryId, "the identity of the (sub, event) pair is stable across runs");
  // another event — another id
  await deliverWebhook(sub, { ...EVENT, multiplierTo: "6" }, { fetcher, sleep: async () => {}, nowMs: 3 });
  assert.notEqual(bodies[2].deliveryId, bodies[0].deliveryId);
  // another subscription — another id (otherwise the receiver's dedup would glue foreign streams together)
  await deliverWebhook({ ...sub, id: "wh_2" }, EVENT, { fetcher, sleep: async () => {}, nowMs: 4 });
  assert.notEqual(bodies[3].deliveryId, bodies[0].deliveryId);
});

test("webhook: an explicit deliveryId in opts still wins (the contract of explicit ids)", async () => {
  const seen = [];
  const r = await deliverWebhook(
    { id: "wh_1", url: "https://receiver.example/hook", secret: "s3cret" },
    EVENT,
    {
      fetcher: async (url, init) => { seen.push(init.headers["x-lotwise-delivery"]); return new Response("ok", { status: 200 }); },
      sleep: async () => {}, deliveryId: "explicit-id-42", nowMs: 5,
    },
  );
  assert.equal(r.ok, true);
  assert.deepEqual(seen, ["explicit-id-42"]);
});
