// the operator's declarations file is the channel that feeds
// DIVIDEND_ACCRUAL into the live store. All-or-nothing by design: one malformed line
// fails the whole load with a named reason (half a feed silently dropped is worse);
// a missing file is the norm (ok, loaded 0) — /accruals stays honest [] until the
// operator declares something.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadDeclarationsFile } from "../src/events/declarations-file.mjs";

const SPYX = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const KOX = "Xk3jhw1yHRtE6ZCofvsqLSzLp4pHHTnbcj1nPQiZbLw";
const REG = [
  { mint: SPYX, symbol: "SPYx", name: "S&P 500", issuer: "backed", decimals: 8 },
  { mint: KOX, symbol: "KOx", name: "Coca-Cola", issuer: "backed", decimals: 6 },
];

const declPath = (dir) => path.join(dir, "declarations.json");
const dir = () => mkdtempSync(path.join(tmpdir(), "lw-decl-"));

test("declarations: a missing file is the norm — ok, loaded 0, no reason", () => {
  const r = loadDeclarationsFile(declPath(dir()), REG);
  assert.deepEqual(r, { ok: true, events: [], loaded: 0, superseded: 0, reason: null });
});

test("declarations: a shared feed binds per registry symbol, events sorted old → new", () => {
  const p = declPath(dir());
  writeFileSync(p, JSON.stringify([
    { symbol: "KOx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 6, sourceUrl: "https://issuer.example/ko/q2" },
    { symbol: "SPYx", exDate: "2026-05-14", amountPerUnitRaw: 1500000, decimals: 8, sourceUrl: "https://issuer.example/spy/q1" },
    { symbol: "SPYx", exDate: "2026-08-13", amountPerUnitRaw: 1600000, decimals: 8, sourceUrl: "https://issuer.example/spy/q2" },
    { symbol: "TSLAx", exDate: "2026-06-01", amountPerUnitRaw: 100, decimals: 8, sourceUrl: "https://issuer.example/tsla" }, // not in the registry — skipped
  ]));
  const r = loadDeclarationsFile(p, REG);
  assert.equal(r.ok, true);
  assert.equal(r.loaded, 3, "two SPYx + one KOx; the unregistered symbol is producer-skipped");
  const spy = r.events.filter((e) => e.mint === SPYX);
  assert.equal(spy.length, 2);
  assert.equal(spy[0].effectiveDate < spy[1].effectiveDate, true, "old → new within the token");
  assert.equal(spy[0].type, "DIVIDEND_ACCRUAL");
  assert.equal(spy[0].status, "confirmed");
  const ko = r.events.find((e) => e.mint === KOX);
  assert.equal(ko.amountPerUnitRaw, 2000000);
});

test("declarations: invalid JSON / non-array / a malformed line — the whole file refuses with a reason", () => {
  for (const [name, content, pattern] of [
    ["truncated-json", '[{"symbol":"KOx"', /not valid JSON/],
    ["null", "null", /must be a JSON array, got null/],
    ["object", '{"feed":[]}', /must be a JSON array, got object/],
    ["bad-date", JSON.stringify([{ symbol: "KOx", exDate: "2026-02-30", amountPerUnitRaw: 1, decimals: 6, sourceUrl: "https://x.example/1" }]), /declarations rejected/],
    ["float-amount", JSON.stringify([{ symbol: "KOx", exDate: "2026-06-18", amountPerUnitRaw: 1.5, decimals: 6, sourceUrl: "https://x.example/1" }]), /declarations rejected/],
  ]) {
    const p = declPath(dir());
    writeFileSync(p, content);
    const r = loadDeclarationsFile(p, REG);
    assert.equal(r.ok, false, `${name}: refused`);
    assert.equal(r.loaded, 0, `${name}: nothing half-loaded`);
    assert.deepEqual(r.events, [], `${name}: no partial events`);
    assert.match(r.reason, pattern, `${name}: the reason names the problem`);
  }
});

test("declarations: a same-amount pair within 3 days warns — a corrected re-declaration would double the income", () => {
  const p = declPath(dir());
  writeFileSync(p, JSON.stringify([
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/q2-v1" },
    { symbol: "SPYx", exDate: "2026-06-20", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/q2-v2" },
  ]));
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    const r = loadDeclarationsFile(p, REG);
    assert.equal(r.ok, true);
    assert.equal(r.loaded, 2, "both lines load — the warning is advisory, the file is the operator's");
  } finally {
    console.warn = orig;
  }
  assert.equal(warns.length, 1, "exactly one warning for the suspicious pair");
  assert.match(warns[0], /2026-06-18/, "the first ex-date is named");
  assert.match(warns[0], /2026-06-20/, "the second ex-date is named");
});

test("declarations: a month-apart pair does not warn (two real dividends are the norm)", () => {
  const p = declPath(dir());
  writeFileSync(p, JSON.stringify([
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/q2" },
    { symbol: "SPYx", exDate: "2026-07-16", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/q3" },
  ]));
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    const r = loadDeclarationsFile(p, REG);
    assert.equal(r.ok, true);
    assert.equal(warns.length, 0, "a month apart is two quarterly dividends, not a correction");
  } finally {
    console.warn = orig;
  }
});

test("declarations: a cluster of duplicates warns ONCE per cluster, not once per pair", () => {
  const p = declPath(dir());
  const sameDay = Array.from({ length: 100 }, (_, i) => ({
    symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 8,
    sourceUrl: `https://issuer.example/dup-${i}`,
  }));
  const farApart = { symbol: "SPYx", exDate: "2026-07-16", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/q3" };
  writeFileSync(p, JSON.stringify([...sameDay, farApart]));
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    const r = loadDeclarationsFile(p, REG);
    assert.equal(r.ok, true);
  } finally {
    console.warn = orig;
  }
  assert.equal(warns.length, 1, "one aggregated warning for the 100-declaration cluster (not 4950 pairs)");
  assert.match(warns[0], /100/, "the cluster size is named");
  assert.doesNotMatch(warns[0], /2026-07-16/, "the month-apart declaration is not swept into the cluster");
});

test("declarations: a chain of neighbors (01/03/05, each pair ≤ 3 days) warns about the WHOLE chain", () => {
  // the window used to measure from the cluster ANCHOR: day 05 is 4 days from day 01, so
  // a chain whose every NEIGHBOR pair is within 3 days lost its tail — the operator saw
  // 2 of the 3 suspicious declarations. The window is per-neighbor now.
  const p = declPath(dir());
  writeFileSync(p, JSON.stringify([
    { symbol: "SPYx", exDate: "2026-01-01", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/a" },
    { symbol: "SPYx", exDate: "2026-01-03", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/b" },
    { symbol: "SPYx", exDate: "2026-01-05", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/c" },
  ]));
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    const r = loadDeclarationsFile(p, REG);
    assert.equal(r.ok, true);
  } finally {
    console.warn = orig;
  }
  assert.equal(warns.length, 1, "one aggregated warning for the chain");
  assert.match(warns[0], /2026-01-01/);
  assert.match(warns[0], /2026-01-03/);
  assert.match(warns[0], /2026-01-05/, "the chain's tail is named — the anchor window dropped it");
});

// One ex-day carries one declared amount: two plain declarations of one symbol on one
// ex-day with different amounts are a correction that bypassed `supersedes`. The engine
// keys dividends on mint + ex-day + amount, so both identities would accrue — the income
// doubles silently. The file refuses WHOLE (the all-or-nothing channel contract): zero
// accruals instead of doubled ones; `supersedes` stays the legal replacement path.
test("declarations: two plain same-day amounts refuse the file — the healthy symbol goes down with it (all-or-nothing)", () => {
  const p = declPath(dir());
  writeFileSync(p, JSON.stringify([
    { symbol: "KOx", exDate: "2026-06-19", amountPerUnitRaw: "2000000", decimals: 6, sourceUrl: "https://issuer.example/ko-v1" },
    { symbol: "KOx", exDate: "2026-06-19", amountPerUnitRaw: "4000000", decimals: 6, sourceUrl: "https://issuer.example/ko-v2" },
    { symbol: "SPYx", exDate: "2026-05-14", amountPerUnitRaw: "1500000", decimals: 8, sourceUrl: "https://issuer.example/spy/q1" }, // healthy
  ]));
  const r = loadDeclarationsFile(p, REG);
  assert.equal(r.ok, false, "a same-day amount conflict is a refusal, not a warning");
  assert.equal(r.loaded, 0, "nothing accrues from a conflicted file");
  assert.deepEqual(r.events, []);
  assert.match(r.reason, /KOx: \(/, "the reason names the symbol");
  assert.match(r.reason, /2026-06-19/, "the conflicted ex-day is named");
  assert.match(r.reason, /2000000/, "the first sum is named");
  assert.match(r.reason, /4000000/, "the second sum is named");
  assert.match(r.reason, /supersedes/, "the reason teaches the fix");
});

// The refusal is bound to the SAME day: special dividends legitimately sit next to
// regular ones, so a changed sum on a different (adjacent) day keeps loading — with the
// advisory proximity warning only.
test("declarations: a changed sum on a DIFFERENT day still loads — the proximity warning stays advisory", () => {
  const p = declPath(dir());
  writeFileSync(p, JSON.stringify([
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/q2-v1" },
    { symbol: "SPYx", exDate: "2026-06-19", amountPerUnitRaw: "4000000", decimals: 8, sourceUrl: "https://issuer.example/q2-v2" },
  ]));
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  let r;
  try {
    r = loadDeclarationsFile(p, REG);
  } finally {
    console.warn = orig;
  }
  assert.equal(r.ok, true, "different days are two dividends as far as the refusal goes");
  assert.equal(r.loaded, 2);
  assert.equal(warns.length, 1, "the advisory warn remains — diagnostics for different days");
  assert.match(warns[0], /adjacent days/);
});

// The registry is the authority on a token's decimals: a declaration's `decimals` is
// display metadata (amountPerUnitRaw is per raw unit and is never rescaled), but a drift
// from tokens.json lies about the human-readable amount by orders of magnitude — named
// loudly at load, without refusing the file: the raw economics is unaffected.
test("declarations: a declaration decimals disagreeing with the registry warns — the load stands, the metadata is not rewritten", () => {
  const p = declPath(dir());
  writeFileSync(p, JSON.stringify([
    { symbol: "KOx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/ko-q2" }, // registry KOx is 6
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "1500000", decimals: 8, sourceUrl: "https://issuer.example/spy-q2" }, // matches
  ]));
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  let r;
  try {
    r = loadDeclarationsFile(p, REG);
  } finally {
    console.warn = orig;
  }
  assert.equal(r.ok, true, "a decimals drift does not refuse the file — the raw amount is per raw unit");
  assert.equal(r.loaded, 2);
  assert.equal(warns.length, 1, "one warning for the drifting symbol; the matching one is silent");
  assert.match(warns[0], /KOX/, "the symbol is named, uppercased like every loader warning");
  assert.match(warns[0], /declaration decimals 8 ≠ registry decimals 6/);
  assert.match(warns[0], /tokens\.json/);
  const ko = r.events.find((e) => e.mint === KOX);
  assert.equal(ko.decimals, 8, "the file is the operator's — we warn, we do not silently rewrite the metadata");
});
