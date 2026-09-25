import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isValidEvent } from "../src/schema/events.mjs";
import { multiplierHistoryToEvents, bindMintAndValidate, NormalizeError } from "../src/events/normalize-xstocks.mjs";
import { decimalToRatio, MultiplierTimeline, TimelineError } from "../src/lots/timeline.mjs";
import { fetchMultiplierHistory } from "../src/issuer/xstocks.mjs";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W"; // SPYx

// The LIVE SPYx history (Ethereum): 4 dividends, the newest on top
const historyFixture = JSON.parse(readFileSync(path.join(dir, "xstocks-spyx-history-eth.json"), "utf8"));
const history = { hasNextPage: false, nodes: historyFixture.nodes.map((n) => ({ ...n })) };

const ev = (over = {}) => ({
  type: "MULTIPLIER_CHANGE",
  mint: MINT,
  effectiveDate: "2026-06-18T04:00:00.000Z",
  status: "confirmed",
  sources: ["https://api.xstocks.fi/api/v2/public/assets/SPYx/multiplier/history?network=Ethereum#node:x"],
  multiplierFrom: "1.003909240011759",
  multiplierTo: "1.005714560286254",
  reason: "Dividend",
  ...over,
});

// ---- the schema ----

test("MULTIPLIER_CHANGE is valid with decimal strings", () => {
  assert.equal(isValidEvent(ev()), true);
});

test("a float instead of a string is rejected (floats are forbidden)", () => {
  assert.equal(isValidEvent(ev({ multiplierTo: 1.0057 })), false);
});

test("a broken format and from==to are rejected", () => {
  assert.equal(isValidEvent(ev({ multiplierTo: "1.00.5" })), false);
  assert.equal(isValidEvent(ev({ multiplierTo: "-1.5" })), false);
  assert.equal(isValidEvent(ev({ multiplierTo: ev().multiplierFrom })), false);
});

// ---- the normalizer ----

test("the live SPYx history → 4 canonical events, old→new, the schema valid", () => {
  const events = bindMintAndValidate(multiplierHistoryToEvents(history.nodes, { symbol: "SPYx" }), MINT);
  assert.equal(events.length, 4);
  assert.equal(events[0].effectiveDate, "2025-10-31T23:55:00.000Z");
  assert.equal(events[0].multiplierFrom, "1");
  assert.equal(events[3].multiplierTo, "1.005714560286254");
  assert.equal(events[3].reason, "Dividend");
  for (const e of events) assert.equal(e.type, "MULTIPLIER_CHANGE");
});

test("the event source references the specific API node", () => {
  const events = multiplierHistoryToEvents(history.nodes, { symbol: "SPYx" });
  assert.match(events[0].sources[0], /#node:/);
});

// ---- decimalToRatio ----

test("\"1\" → 1/1; \"1.005714560286254\" → an exact fraction", () => {
  assert.deepEqual(decimalToRatio("1"), { num: 1n, den: 1n });
  const r = decimalToRatio("1.005714560286254");
  assert.equal(r.num, 1005714560286254n);
  assert.equal(r.den, 10n ** 15n);
});

test("garbage is rejected", () => {
  assert.throws(() => decimalToRatio("abc"), TimelineError);
  assert.throws(() => decimalToRatio(1.5), TimelineError);
  assert.throws(() => decimalToRatio("1.5.6"), TimelineError);
});

// ---- MultiplierTimeline ----

function spyxTimeline() {
  const events = bindMintAndValidate(multiplierHistoryToEvents(history.nodes, { symbol: "SPYx" }), MINT);
  return new MultiplierTimeline(events);
}

test("the scale from the live history: the multiplier by dates before/between/after the events", () => {
  const tl = spyxTimeline();
  assert.equal(tl.multiplierAt("2025-10-30"), "1");
  assert.equal(tl.multiplierAt("2025-10-31T23:55:00.000Z"), "1.00099942056");
  assert.equal(tl.multiplierAt("2026-02-01"), "1.0025607582229898");
  assert.equal(tl.multiplierAt("2026-07-01"), "1.005714560286254");
  assert.equal(tl.multiplierAt("2099-01-01"), "1.005714560286254");
});

test("a chain break = an error, not a guess (fail-closed)", () => {
  const events = multiplierHistoryToEvents(history.nodes, { symbol: "SPYx" });
  events[2].multiplierFrom = "9.99"; // break the chain
  assert.throws(() => new MultiplierTimeline(events), /chain discontinuity/);
});

test("a first event not from 1 = an error", () => {
  const events = multiplierHistoryToEvents(history.nodes, { symbol: "SPYx" }).slice(1); // drop the first
  assert.throws(() => new MultiplierTimeline(events), /chain discontinuity/);
});

test("an empty scale = the multiplier 1 everywhere", () => {
  const tl = new MultiplierTimeline([]);
  assert.equal(tl.multiplierAt("2026-01-01"), "1");
  assert.deepEqual(tl.scaledQty(1_000_000n, "2026-01-01"), { whole: 1_000_000n, remainder: 0n, den: 1n, exact: true });
});

test("scaledQty: the exact case and the \"dusty\" case (no silent rounding)", () => {
  const tl = spyxTimeline();
  // raw 10^15 × 1.005714560286254 = 1005714560286254 — divides evenly
  const exact = tl.scaledQty(10n ** 15n, "2026-07-01");
  assert.equal(exact.exact, true);
  assert.equal(exact.whole, 1005714560286254n);
  // raw 10^9: 1e9×num/10^15 — does not divide: whole + remainder honestly
  const dusty = tl.scaledQty(10n ** 9n, "2026-07-01");
  assert.equal(dusty.exact, false);
  assert.equal(dusty.whole, 1005714560n);
  assert.equal(dusty.remainder, 286254000000000n); // 0.286254 of a unit in den units
  assert.equal(dusty.den, 10n ** 15n);
});

test("a foreign event type in the scale is rejected", () => {
  assert.throws(() => new MultiplierTimeline([{ type: "SPLIT", effectiveDate: "2026-01-01" }]), /only MULTIPLIER_CHANGE/);
});

test("integration: the live fixture → the client → the normalizer → a valid schema", async () => {
  const okRes = (payload) => ({ ok: true, status: 200, json: async () => payload });
  const h = await fetchMultiplierHistory("SPYx", "Ethereum", {
    fetcher: async () => okRes(historyFixture), // the raw JSON with NUMBERS, as the API serves
  });
  const events = bindMintAndValidate(multiplierHistoryToEvents(h.nodes, { symbol: "SPYx" }), MINT);
  assert.equal(events.length, 4);
  assert.equal(events[0].multiplierFrom, "1");
  assert.equal(events[3].multiplierTo, "1.005714560286254");
});

// ----: dates as numbers, not lexicographically ----

test("a date-only query: an event of day D is considered already effective", () => {
  const e = ev({ effectiveDate: "2026-06-18T00:00:00.000Z", multiplierFrom: "1", multiplierTo: "1.005" });
  const tl = new MultiplierTimeline([e]);
  assert.equal(tl.multiplierAt("2026-06-17"), "1");
  // before the fix: "2026-06-18T00:00:00.000Z" > "2026-06-18" stringly → the vitrine calculator
  // showed the pre-event multiplier exactly on the event day
  assert.equal(tl.multiplierAt("2026-06-18"), "1.005");
  assert.equal(tl.multiplierAt("2026-06-18T00:00:00Z"), "1.005"); // mixed precision = the same moment
});

test("sorting mixed-precision dates does not tear the chain continuity", () => {
  const a = ev({ effectiveDate: "2026-01-01T00:00:00Z", multiplierFrom: "1", multiplierTo: "1.1" });
  const b = ev({ effectiveDate: "2026-02-01T00:00:00.000Z", multiplierFrom: "1.1", multiplierTo: "1.2" }); // "longer" as a string, later in fact
  const tl = new MultiplierTimeline([b, a]); // we feed it out of order
  assert.equal(tl.multiplierAt("2026-01-15"), "1.1");
  assert.equal(tl.multiplierAt("2026-02-01"), "1.2");
});

test("a garbage date in multiplierAt — TimelineError, not a silent lie", () => {
  const tl = new MultiplierTimeline([ev({ multiplierFrom: "1" })]);
  assert.throws(() => tl.multiplierAt("not-a-date"), TimelineError);
});

// ----: strict dates (schema/isodate.mjs) ----

// The same battery of garbage as in test/events.test.mjs (the schema) — here the second barrier:
// the timeline cannot be built from garbage even past the schema.
const garbageDates = [
  "2026-13-01",                // NaN already after the schema form
  "2026-00-10",
  "2026-06-18T23:59:60Z",      // a leap second
  "2026-06-18T12:00:00+99:99", // an offset 99:99
  "2026-02-30",                // Date.parse rolls it over to 02.03 — a multiplier from a foreign day
  "2026-06-31",                // a roll-over to 01.07
  "2027-02-29",                // a roll-over to 01.03
  "2026-06-18T24:00:00Z",      // a roll-over to the next day
  "2026-06-18T12:00:00",       // a naive time = the host's locale
  "2026-06-18T12:00:00.500",   // a naive one with fractions
  "2026-1-1",                  // the form
  "2026-02-29",                // not a leap year
  "2026-06-18T12:60:00Z",
  "",
  null,
];

test("a garbage effectiveDate in an event — TimelineError at scale construction (the battery)", () => {
  for (const bad of garbageDates) {
    assert.throws(
      () => new MultiplierTimeline([ev({ effectiveDate: bad, multiplierFrom: "1" })]),
      TimelineError,
      `must be rejected: ${JSON.stringify(bad)}`,
    );
  }
});

test("a garbage date in multiplierAt — TimelineError (the battery)", () => {
  const tl = spyxTimeline();
  for (const bad of garbageDates) {
    assert.throws(() => tl.multiplierAt(bad), TimelineError, `must be rejected: ${JSON.stringify(bad)}`);
  }
});

// An ANTI-regression: canonical formats pass, the moment equivalence is preserved.
test("canonical date formats work in the scale (an anti-overreach of the strict validator)", () => {
  for (const date of ["2026-01-30T23:55:00.000Z", "2026-01-30T23:55:00Z", "2026-01-31T01:55:00+02:00", "2026-01-30T19:55:00-04:00"]) {
    const tl = new MultiplierTimeline([ev({ effectiveDate: date, multiplierFrom: "1", multiplierTo: "1.2" })]);
    assert.equal(tl.multiplierAt("2026-01-31"), "1.2", date);
  }
});

// ---- (P4): a single event with a broken date — loud, as with 2+ ----

test("a SINGLE event with an effectiveDate null — TimelineError, not a quiet \"baseline\"", () => {
  // before the fix: for 1 element the comparator was not called → a step with at:null got into steps,
  // multiplierAt skipped it as the baseline — a ×5 rebase was lost silently
  const e = ev({ effectiveDate: null, multiplierFrom: "1", multiplierTo: "5" });
  assert.throws(() => new MultiplierTimeline([e]), TimelineError);
  // and before that it only failed loudly at 2+ events — asymmetric
  assert.throws(
    () => new MultiplierTimeline([e, ev({ effectiveDate: "2026-07-01T00:00:00Z", multiplierFrom: "5", multiplierTo: "6" })]),
    TimelineError,
  );
});

test("a SINGLE event with an effectiveDate roll-over (\"2026-02-30\") is a loud error too", () => {
  assert.throws(
    () => new MultiplierTimeline([ev({ effectiveDate: "2026-02-30", multiplierFrom: "1", multiplierTo: "5" })]),
    TimelineError,
  );
});

// ----: the invariants confirmed by the fuzzer (seed 20260919) ----

function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
}

test("invariant: a shuffled event feed = the same scale (all 24 permutations of the live history)", () => {
  const base = bindMintAndValidate(multiplierHistoryToEvents(history.nodes, { symbol: "SPYx" }), MINT);
  const queries = ["2025-10-30", "2025-10-31T23:55:00.000Z", "2026-02-01", "2026-05-01T00:15:00.000Z", "2026-07-01"];
  const expected = queries.map((q) => new MultiplierTimeline(base).multiplierAt(q));
  const perms = permutations(base);
  assert.equal(perms.length, 24); // 4! — ALL input orders covered, not a couple of examples
  for (const perm of perms) {
    const tl = new MultiplierTimeline(perm);
    assert.deepEqual(queries.map((q) => tl.multiplierAt(q)), expected, perm.map((e) => e.effectiveDate).join(" | "));
  }
});

test("invariant: before the first event the multiplier = 1 (in any feed order)", () => {
  const events = bindMintAndValidate(multiplierHistoryToEvents(history.nodes, { symbol: "SPYx" }), MINT);
  for (const order of [events, [...events].reverse()]) {
    const tl = new MultiplierTimeline(order);
    assert.equal(tl.multiplierAt("2025-10-30"), "1");
    assert.equal(tl.multiplierAt("2025-01-01T00:00:00Z"), "1");
    assert.equal(tl.multiplierAt("1970-01-01"), "1");
  }
});

test("invariant: the equivalence of formats — date-only = Z = .000Z = ±HH:MM (one moment, one multiplier)", () => {
  const tl = new MultiplierTimeline([
    ev({ effectiveDate: "2026-06-18T00:00:00.000Z", multiplierFrom: "1", multiplierTo: "1.5" }),
  ]);
  // all the queries — ONE and the same moment: the event is already in force (<=)
  const sameMoment = [
    "2026-06-18",
    "2026-06-18T00:00:00Z",
    "2026-06-18T00:00:00.000Z",
    "2026-06-18T05:00:00+05:00",
    "2026-06-17T21:00:00-03:00",
  ];
  for (const q of sameMoment) {
    assert.equal(tl.multiplierAt(q), "1.5", q);
  }
});

test("the reconstruction invariant: whole·den + remainder = qty·num, 0 ≤ remainder < den", () => {
  const tl = spyxTimeline();
  for (const qty of [1n, 7n, 999n, 10n ** 9n, 10n ** 15n, 12345678901234567890n]) {
    for (const date of ["2025-10-30", "2026-02-01", "2026-07-01"]) {
      const { num, den } = tl.factorAt(date);
      const { whole, remainder, exact } = tl.scaledQty(qty, date);
      assert.ok(remainder >= 0n && remainder < den, `the remainder out of range: ${qty} @ ${date}`);
      assert.equal(whole * den + remainder, qty * num, `${qty} @ ${date}`);
      assert.equal(exact, remainder === 0n);
    }
  }
});

// ---- (P3): the normalizer — a sort by moment of time, not by string ----

test("a sort by moment: mixed precision within a second no longer flips the chronology", () => {
  // as the API serves it — the newest on top. localeCompare put ".500Z" BEFORE "Z"
  // (".", 0x2E, < "Z", 0x5A) → the LATER went earlier, the chronology flipped
  const nodes = [
    { id: "new", multiplier: 1.3, previousMultiplier: 1.1, activationDateTime: "2026-01-01T00:00:00.500Z" }, // the moment LATER
    { id: "old", multiplier: 1.1, previousMultiplier: 1, activationDateTime: "2026-01-01T00:00:00Z" },        // the moment EARLIER
  ];
  const events = multiplierHistoryToEvents(nodes, { symbol: "SPYx" });
  assert.deepEqual(events.map((e) => e.effectiveDate), [
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00.500Z",
  ]);
  // the chain after the honest sort assembles, the event moment = the action moment
  const tl = new MultiplierTimeline(bindMintAndValidate(events, MINT));
  assert.equal(tl.multiplierAt("2026-01-01T00:00:00Z"), "1.1");
  assert.equal(tl.multiplierAt("2026-01-01T00:00:00.250Z"), "1.1"); // between the events
  assert.equal(tl.multiplierAt("2026-01-01T00:00:00.500Z"), "1.3");
});

test("an unparseable activationDateTime — NormalizeError (fail-closed), not a silent order", () => {
  assert.throws(
    () => multiplierHistoryToEvents([
      { id: "x", multiplier: 1.2, previousMultiplier: 1.1, activationDateTime: "2026-02-30" }, // a rolled-over date
    ], { symbol: "SPYx" }),
    NormalizeError,
  );
  assert.throws(
    () => multiplierHistoryToEvents([
      { id: "y", multiplier: 1.2, previousMultiplier: 1.1, activationDateTime: 0 }, // as in xstocks-spyx-current.json
    ], { symbol: "SPYx" }),
    NormalizeError,
  );
});

test("the cap of fractional digits at the schema and the scale level: 31 digits kills both the schema and decimalToRatio", () => {
  const m31 = "1." + "1".repeat(31);
  assert.equal(isValidEvent(ev({ multiplierTo: m31 })), false);
  assert.throws(() => decimalToRatio(m31), TimelineError);
});
