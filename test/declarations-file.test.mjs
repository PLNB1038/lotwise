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
  assert.deepEqual(r, { ok: true, events: [], loaded: 0, reason: null });
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
