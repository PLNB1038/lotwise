// A correction's replacement is itself a dividend event with its own ex-day — and where
// it LANDS was nobody's business: the "one ex-day carries one declared amount" gate
// groups plain declarations only (a correction is the legal way to change a same-day
// amount), and the loader's proximity scans exclude resolved targets and correction
// lines by design. So a correction whose replacement lands on an ex-day that ANOTHER
// surviving event already carries a different amount on re-creates the exact doubled
// income the plain pair is refused for: one day, two declared sums, each accruing on the
// full basis (the /accruals day-key dedup cannot collapse them — the identity includes
// the amount). The same contract therefore runs AFTER the supersedes resolution: every
// surviving event of a day must carry one declared amount, or the whole feed refuses —
// the correction loop lands in the honest zero the plain path gets, not in a doubled
// /accruals. A replacement repeating an amount the day already carries is NOT a
// conflict: one declared amount is one declared amount, and the engine's identity dedup
// collapses the sightings the same way it does for two plain lines of one amount.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadDeclarationsFile } from "../src/events/declarations-file.mjs";
import { buildDeclarationEvents, DeclarationError } from "../src/events/dividends.mjs";
import { createApiServer } from "../src/api/server.mjs";

const SPYX = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const REG = [
  { mint: SPYX, symbol: "SPYx", name: "S&P 500", issuer: "backed", decimals: 8 },
];

const declPath = (dir) => path.join(dir, "declarations.json");
const dir = () => mkdtempSync(path.join(tmpdir(), "lw-landing-"));

const write = (list) => {
  const p = declPath(dir());
  writeFileSync(p, JSON.stringify(list));
  return p;
};

test("a replacement landing on an ex-day a surviving declaration already carries refuses the load — /accruals never sees the two-amount day", async () => {
  // the issuer corrects the 2026-06-19 dividend (8000000 → 3000000) but moves it onto
  // 2026-06-18, whose own 2000000 declaration stays: the survivors carry TWO amounts on
  // one day, so the income doubles (base × 2000000 + base × 3000000) — the exact state
  // two plain lines are refused for. The file refuses whole instead.
  const p = write([
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/spy/q2" },
    { symbol: "SPYx", exDate: "2026-06-19", amountPerUnitRaw: "8000000", decimals: 8, sourceUrl: "https://issuer.example/spy/q2-v1" },
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "3000000", decimals: 8, sourceUrl: "https://issuer.example/spy/q2-v2", supersedes: { exDate: "2026-06-19", amountPerUnitRaw: "8000000" } },
  ]);
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  let loaded;
  try {
    loaded = loadDeclarationsFile(p, REG);
  } finally {
    console.warn = origWarn;
  }
  assert.equal(loaded.ok, false, "a replacement landing on a carried ex-day is a refusal, not a silent load");
  assert.equal(loaded.loaded, 0, "nothing accrues from a conflicted file");
  assert.deepEqual(loaded.events, []);
  assert.match(loaded.reason, /2026-06-18/, "the conflicted ex-day is named");
  assert.match(loaded.reason, /2000000/, "the carried sum is named");
  assert.match(loaded.reason, /3000000/, "the replacement's sum is named");
  assert.match(loaded.reason, /one declared amount/, "the invariant is spelled out");
  assert.equal(warns.length, 0, "the refusal is the message — no advisory warns around a resolved-channel conflict");
  // and the endpoint confirms the honest zero: no events reach the store, /accruals
  // cannot answer two rows of one day on the full basis each
  const ADDR = "SupersAddr" + "1".repeat(33);
  const server = await createApiServer({
    registry: REG,
    events: loaded.events,
    walletScanner: async () => ({
      owner: ADDR, signatures: 1, fetched: 1, txs: [], skipped: [], truncated: false, accounts: {},
    }),
  });
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/accruals?symbol=SPYx&address=${ADDR}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), [], "no doubled accrual rows escape the refused file");
  } finally {
    server.close();
  }
});

test("two corrections landing on the same ex-day refuse too — replacements answer to the one-amount rule as well", () => {
  // each correction is legal on its own (a free target, one level deep), but both
  // replacements land on 2026-06-20 with different sums — the day carries two declared
  // amounts after the resolution, and nobody loaded them silently
  const p = write([
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "8000000", decimals: 8, sourceUrl: "https://issuer.example/spy/v1" },
    { symbol: "SPYx", exDate: "2026-06-19", amountPerUnitRaw: "5000000", decimals: 8, sourceUrl: "https://issuer.example/spy/v2" },
    { symbol: "SPYx", exDate: "2026-06-20", amountPerUnitRaw: "3000000", decimals: 8, sourceUrl: "https://issuer.example/spy/v3", supersedes: { exDate: "2026-06-18", amountPerUnitRaw: "8000000" } },
    { symbol: "SPYx", exDate: "2026-06-20", amountPerUnitRaw: "4000000", decimals: 8, sourceUrl: "https://issuer.example/spy/v4", supersedes: { exDate: "2026-06-19", amountPerUnitRaw: "5000000" } },
  ]);
  const r = loadDeclarationsFile(p, REG);
  assert.equal(r.ok, false, "two replacements of one ex-day with different amounts refuse");
  assert.equal(r.loaded, 0);
  assert.match(r.reason, /2026-06-20/);
  assert.match(r.reason, /3000000/);
  assert.match(r.reason, /4000000/);
});

test("the producer throws the same one-amount DeclarationError after resolving supersedes", () => {
  // the refusal lives in the producer (the all-or-nothing contract), so a direct
  // dividendsFromDeclarations caller gets the same throw the loader turns into
  // declarations.ok = 0 — one contract, both channels
  assert.throws(
    () => buildDeclarationEvents([
      { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/spy/q2" },
      { symbol: "SPYx", exDate: "2026-06-19", amountPerUnitRaw: "8000000", decimals: 8, sourceUrl: "https://issuer.example/spy/q2-v1" },
      { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "3000000", decimals: 8, sourceUrl: "https://issuer.example/spy/q2-v2", supersedes: { exDate: "2026-06-19", amountPerUnitRaw: "8000000" } },
    ], { symbol: "SPYx" }),
    (e) => e instanceof DeclarationError
      && /2026-06-18/.test(e.message)
      && /2000000/.test(e.message)
      && /3000000/.test(e.message)
      && /one declared amount/.test(e.message),
  );
});

test("a replacement landing on a FREE ex-day still loads — the legitimate correction flow is untouched", async () => {
  // the corrections do everything right: each supersedes its own target once, each
  // replacement lands where nothing else carries an amount — the file loads, the
  // replacements accrue alone, /accruals serves one row per day with the corrected sums
  const p = write([
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/spy/q2" },
    { symbol: "SPYx", exDate: "2026-06-19", amountPerUnitRaw: "8000000", decimals: 8, sourceUrl: "https://issuer.example/spy/q3-v1" },
    { symbol: "SPYx", exDate: "2026-06-22", amountPerUnitRaw: "3000000", decimals: 8, sourceUrl: "https://issuer.example/spy/q3-v2", supersedes: { exDate: "2026-06-19", amountPerUnitRaw: "8000000" } },
    { symbol: "SPYx", exDate: "2026-07-20", amountPerUnitRaw: "6000000", decimals: 8, sourceUrl: "https://issuer.example/spy/q4-v1" },
    { symbol: "SPYx", exDate: "2026-07-21", amountPerUnitRaw: "2500000", decimals: 8, sourceUrl: "https://issuer.example/spy/q4-v2", supersedes: { exDate: "2026-07-20", amountPerUnitRaw: "6000000" } },
  ]);
  const loaded = loadDeclarationsFile(p, REG);
  assert.equal(loaded.ok, true, loaded.reason ?? "legitimate corrections load");
  assert.equal(loaded.loaded, 3, "one surviving dividend per resolved declaration");
  assert.equal(loaded.superseded, 2, "both replacements applied");
  const days = loaded.events.map((e) => `${String(e.effectiveDate).slice(0, 10)}|${e.amountPerUnitRaw}`).sort();
  assert.deepEqual(days, ["2026-06-18|2000000", "2026-06-22|3000000", "2026-07-21|2500000"], "each replacement accrues alone on its free day");
  const ADDR = "SupersAddr" + "1".repeat(33);
  const aTx = (signature, deltaRaw, isoDate) => ({
    signature,
    slot: 1,
    blockTime: Math.floor(Date.parse(isoDate) / 1000),
    deltas: [{ owner: ADDR, mint: SPYX, preRaw: 0n, postRaw: 0n, deltaRaw }],
  });
  const server = await createApiServer({
    registry: REG,
    events: loaded.events,
    walletScanner: async () => ({
      owner: ADDR, signatures: 1, fetched: 1, txs: [aTx("b1", 100n, "2026-01-01")], skipped: [], truncated: false, accounts: {},
    }),
  });
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/accruals?symbol=SPYx&address=${ADDR}`);
    assert.equal(res.status, 200);
    const rows = await res.json();
    assert.equal(rows.length, 3, "one row per ex-day — no doubling anywhere");
    assert.deepEqual(
      rows.map((r) => `${String(r.effectiveDate).slice(0, 10)}|${r.amountPerUnitRaw}|${r.totalRaw}`).sort(),
      ["2026-06-18|2000000|200000000", "2026-06-22|3000000|300000000", "2026-07-21|2500000|250000000"],
      "each day accrues its single declared amount on the full basis",
    );
  } finally {
    server.close();
  }
});

test("a replacement landing on a carried ex-day with the SAME amount is not a conflict — the identity dedup collapses the sightings", () => {
  // one declared amount is one declared amount: the replacement repeats what the day
  // already carries, so the engine's mint + ex-day + amount dedup owns the pair (the
  // same tolerance two plain lines of one amount get). The refusal is for DISTINCT sums.
  const p = write([
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/spy/q2" },
    { symbol: "SPYx", exDate: "2026-06-19", amountPerUnitRaw: "4000000", decimals: 8, sourceUrl: "https://issuer.example/spy/q2-v1" },
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/spy/q2-v2", supersedes: { exDate: "2026-06-19", amountPerUnitRaw: "4000000" } },
  ]);
  const r = loadDeclarationsFile(p, REG);
  assert.equal(r.ok, true, r.reason ?? "the same amount landing on the day is a sighting, not a conflict");
  assert.equal(r.superseded, 1);
});
