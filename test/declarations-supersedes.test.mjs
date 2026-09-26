// the declarations channel is append-only, but the ISSUER corrects itself: a declared
// amount turns out wrong, the ex-day moves. The correction is the optional `supersedes`
// field: a declaration line naming the line it REPLACES by the dividend's identity —
//   { "symbol": "KOx", "exDate": "2026-06-18", "amountPerUnitRaw": "2000000",
//     "decimals": 6, "sourceUrl": "https://issuer.example/ko/q2-v2",
//     "supersedes": { "exDate": "2026-06-18", "amountPerUnitRaw": "4000000" } }
// The identity (same symbol, canonical ex-day, per-unit amount) is what the engine
// already keys dividends on (the /accruals dedup, the loader's cluster warning) — no new
// id scheme, legacy lines stay addressable. Replacement, not addition: the target event
// is removed and the correction accrues ALONE — without the field two lines on one
// dividend accrue twice (the corrected 200 was paid 600: the stale 400 stayed on top).
// The scheme is ONE level deep and validated all-or-nothing like the rest of the file:
// a missing target, a chain/self-reference, or two corrections on one target refuse the
// whole load — a half-applied correction is precisely the silent doubling it exists to fix.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadDeclarationsFile } from "../src/events/declarations-file.mjs";
import { createApiServer } from "../src/api/server.mjs";

const SPYX = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const KOX = "Xk3jhw1yHRtE6ZCofvsqLSzLp4pHHTnbcj1nPQiZbLw";
const REG = [
  { mint: SPYX, symbol: "SPYx", name: "S&P 500", issuer: "backed", decimals: 8 },
  { mint: KOX, symbol: "KOx", name: "Coca-Cola", issuer: "backed", decimals: 6 },
];

const declPath = (dir) => path.join(dir, "declarations.json");
const dir = () => mkdtempSync(path.join(tmpdir(), "lw-sups-"));

const write = (list) => {
  const p = declPath(dir());
  writeFileSync(p, JSON.stringify(list));
  return p;
};

// capture console.warn the way declarations-file.test.mjs does
const withWarns = async (fn) => {
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    return { result: await fn(), warns };
  } finally {
    console.warn = orig;
  }
};

test("supersedes: an amount correction REPLACES the target — one accrual with the new amount, not two (the 600 income)", () => {
  // the issuer declared 4000000, then corrected the payout to 2000000: the append-only
  // file carries both lines, the correction names the stale one. The engine must accrue
  // 2000000 once — the stale 4000000 must NOT stay on top of it.
  const p = write([
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "4000000", decimals: 8, sourceUrl: "https://issuer.example/spy/q2-v1" },
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/spy/q2-v2", supersedes: { exDate: "2026-06-18", amountPerUnitRaw: "4000000" } },
  ]);
  const r = loadDeclarationsFile(p, REG);
  assert.equal(r.ok, true, r.reason ?? "must load");
  assert.equal(r.loaded, 1, "the correction replaces the target — one live declaration");
  assert.equal(r.superseded, 1, "one replacement applied");
  const spy = r.events.filter((e) => e.mint === SPYX);
  assert.equal(spy.length, 1);
  assert.equal(spy[0].amountPerUnitRaw, 2000000, "the corrected amount accrues");
  assert.equal(String(spy[0].effectiveDate).slice(0, 10), "2026-06-18");
});

test("supersedes: an ex-day correction with the same amount — one accrual, not 400 instead of 200", () => {
  // the day moved, the amount did not: two same-amount lines on DIFFERENT days are two
  // dividends to the day-key dedup — exactly the doubling the warning could only point at.
  // The correction line removes the stale day's dividend.
  const p = write([
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/spy/q2-v1" },
    { symbol: "SPYx", exDate: "2026-06-19", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/spy/q2-v2", supersedes: { exDate: "2026-06-18", amountPerUnitRaw: "2000000" } },
  ]);
  const r = loadDeclarationsFile(p, REG);
  assert.equal(r.ok, true, r.reason ?? "must load");
  assert.equal(r.loaded, 1);
  const spy = r.events.filter((e) => e.mint === SPYX);
  assert.equal(spy.length, 1, "one dividend — the old ex-day is gone");
  assert.equal(String(spy[0].effectiveDate).slice(0, 10), "2026-06-19", "the corrected ex-day");
});

test("supersedes: /accruals reflects the replacement — one row with the corrected amount", async () => {
  const p = write([
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "4000000", decimals: 8, sourceUrl: "https://issuer.example/spy/q2-v1" },
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/spy/q2-v2", supersedes: { exDate: "2026-06-18", amountPerUnitRaw: "4000000" } },
  ]);
  const loaded = loadDeclarationsFile(p, REG);
  assert.equal(loaded.ok, true, loaded.reason ?? "");
  const ADDR = "SupersAddr" + "1".repeat(33); // a structurally valid base58 pubkey (32 bytes)
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
    assert.equal(rows.length, 1, "one dividend row — the replacement reached the endpoint");
    assert.equal(rows[0].amountPerUnitRaw, "2000000", "the corrected amount, not the stale one");
    assert.equal(rows[0].totalRaw, "200000000", "100 units × 2000000 — not 600000000");
  } finally {
    server.close();
  }
});

test("supersedes: a missing target refuses the whole load (all-or-nothing, like a malformed line)", () => {
  // the reference names nothing declared: a half-applied correction would leave the stale
  // amount accruing while the operator believes it replaced — refuse loudly instead.
  const p = write([
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/spy/q2" },
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/spy/q2-v2", supersedes: { exDate: "2026-06-18", amountPerUnitRaw: "4000000" } },
  ]);
  const r = loadDeclarationsFile(p, REG);
  assert.equal(r.ok, false, "a dangling supersedes is a load error");
  assert.equal(r.loaded, 0, "nothing half-loaded");
  assert.deepEqual(r.events, []);
  assert.match(r.reason, /supersedes/);
  assert.match(r.reason, /no declaration to replace/);
});

test("supersedes: a chain (correcting a correction) refuses — the scheme is one level deep", () => {
  const p = write([
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "4000000", decimals: 8, sourceUrl: "https://issuer.example/spy/v1" },
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "3000000", decimals: 8, sourceUrl: "https://issuer.example/spy/v2", supersedes: { exDate: "2026-06-18", amountPerUnitRaw: "4000000" } },
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/spy/v3", supersedes: { exDate: "2026-06-18", amountPerUnitRaw: "3000000" } },
  ]);
  const r = loadDeclarationsFile(p, REG);
  assert.equal(r.ok, false);
  assert.equal(r.loaded, 0);
  assert.match(r.reason, /supersedes/);
  assert.match(r.reason, /is itself a correction/, "the reason names the chain, not a generic dangling target");
});

test("supersedes: a self-reference refuses", () => {
  const p = write([
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/spy/q2", supersedes: { exDate: "2026-06-18", amountPerUnitRaw: "2000000" } },
  ]);
  const r = loadDeclarationsFile(p, REG);
  assert.equal(r.ok, false);
  assert.match(r.reason, /supersedes/);
  assert.match(r.reason, /itself/);
});

test("supersedes: two corrections on one target refuse (the file is ambiguous — resolve it)", () => {
  const p = write([
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "4000000", decimals: 8, sourceUrl: "https://issuer.example/spy/v1" },
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/spy/v2", supersedes: { exDate: "2026-06-18", amountPerUnitRaw: "4000000" } },
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/spy/v3", supersedes: { exDate: "2026-06-18", amountPerUnitRaw: "4000000" } },
  ]);
  const r = loadDeclarationsFile(p, REG);
  assert.equal(r.ok, false);
  assert.equal(r.loaded, 0);
  assert.match(r.reason, /supersedes/);
  assert.match(r.reason, /already superseded/);
});

test("supersedes: a verbatim re-submitted correction collapses (re-feeding the file must not error)", () => {
  // the exact-duplicate collapse of the producer runs FIRST: the same correction line
  // twice is one correction, not a double-supersede error — re-submitting the feed is the norm
  const line = { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/spy/q2-v2", supersedes: { exDate: "2026-06-18", amountPerUnitRaw: "4000000" } };
  const p = write([
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "4000000", decimals: 8, sourceUrl: "https://issuer.example/spy/q2-v1" },
    line,
    line,
  ]);
  const r = loadDeclarationsFile(p, REG);
  assert.equal(r.ok, true, r.reason ?? "a duplicated correction line is not a double supersede");
  assert.equal(r.loaded, 1);
  assert.equal(r.superseded, 1);
});

test("supersedes: a correction in a mixed file leaves legacy lines untouched (backward compatibility)", () => {
  const p = write([
    // legacy SPYx pair — no supersedes anywhere, the quarter-apart norm
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/spy/q2" },
    { symbol: "SPYx", exDate: "2026-07-16", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/spy/q3" },
    // a KOx correction with a forward reference (the target is declared AFTER the correction —
    // the file is append-only and line order must not matter)
    { symbol: "KOx", exDate: "2026-05-01", amountPerUnitRaw: "1500000", decimals: 6, sourceUrl: "https://issuer.example/ko/q2-v2", supersedes: { exDate: "2026-05-01", amountPerUnitRaw: "2500000" } },
    { symbol: "KOx", exDate: "2026-05-01", amountPerUnitRaw: "2500000", decimals: 6, sourceUrl: "https://issuer.example/ko/q2-v1" },
  ]);
  const r = loadDeclarationsFile(p, REG);
  assert.equal(r.ok, true, r.reason ?? "must load");
  assert.equal(r.loaded, 3, "two legacy SPYx dividends + one corrected KOx dividend");
  assert.equal(r.superseded, 1);
  const spy = r.events.filter((e) => e.mint === SPYX);
  assert.equal(spy.length, 2, "legacy declarations accrue exactly as before");
  const ko = r.events.filter((e) => e.mint === KOX);
  assert.equal(ko.length, 1);
  assert.equal(ko[0].amountPerUnitRaw, 1500000, "the KOx correction replaced the stale amount");
});

test("supersedes: a resolved correction does not trigger the same-amount cluster warning", () => {
  // the warning exists because a re-declaration was indistinguishable from two dividends;
  // an EXPLICIT correction is distinguishable by construction — the target is gone before
  // the warning scans the events
  const p = write([
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/spy/q2-v1" },
    { symbol: "SPYx", exDate: "2026-06-19", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/spy/q2-v2", supersedes: { exDate: "2026-06-18", amountPerUnitRaw: "2000000" } },
  ]);
  return withWarns(() => loadDeclarationsFile(p, REG)).then(({ result, warns }) => {
    assert.equal(result.ok, true);
    assert.equal(warns.length, 0, "an explicit correction is not a suspicious cluster");
  });
});

test("supersedes: the reference keys on the canonical ex-day and the parsed amount (tz twin / string-number)", () => {
  // the original was declared with a datetime ex-date; the correction references the day
  // and passes the amount as a string — identity is canonicalized on both sides
  const p = write([
    { symbol: "SPYx", exDate: "2026-06-18T00:00:00Z", amountPerUnitRaw: 4000000, decimals: 8, sourceUrl: "https://issuer.example/spy/v1" },
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/spy/v2", supersedes: { exDate: "2026-06-18", amountPerUnitRaw: "4000000" } },
  ]);
  const r = loadDeclarationsFile(p, REG);
  assert.equal(r.ok, true, r.reason ?? "must load");
  assert.equal(r.loaded, 1);
  assert.equal(r.events[0].amountPerUnitRaw, 2000000);
});

test("supersedes: a cross-symbol reference refuses (a KOx line cannot correct an SPYx dividend)", () => {
  const p = write([
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "4000000", decimals: 8, sourceUrl: "https://issuer.example/spy/v1" },
    { symbol: "KOx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 6, sourceUrl: "https://issuer.example/ko/v1", supersedes: { exDate: "2026-06-18", amountPerUnitRaw: "4000000" } },
  ]);
  const r = loadDeclarationsFile(p, REG);
  assert.equal(r.ok, false, "the target is looked up within the same symbol only");
  assert.match(r.reason, /supersedes/);
  assert.match(r.reason, /no declaration to replace/);
});

test("supersedes: a malformed reference refuses — not an object / bad date / bad amount", () => {
  for (const [name, supersedes, pattern] of [
    ["string", "2026-06-18 4000000", /must be an object/],
    ["null", null, /must be an object/],
    ["no-exdate", { amountPerUnitRaw: "4000000" }, /exDate must be/],
    ["bad-date", { exDate: "2026-02-30", amountPerUnitRaw: "4000000" }, /exDate must be/],
    ["no-amount", { exDate: "2026-06-18" }, /amountPerUnitRaw must be/],
    ["float-amount", { exDate: "2026-06-18", amountPerUnitRaw: 1.5 }, /amountPerUnitRaw must be/],
    ["zero-amount", { exDate: "2026-06-18", amountPerUnitRaw: "0" }, /amountPerUnitRaw must be/],
  ]) {
    const p = write([
      { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/spy/v1", supersedes },
    ]);
    const r = loadDeclarationsFile(p, REG);
    assert.equal(r.ok, false, `${name}: refused`);
    assert.equal(r.loaded, 0, `${name}: nothing half-loaded`);
    assert.match(r.reason, pattern, `${name}: the reason names the problem`);
  }
});

test("supersedes: a legacy file without the field reports superseded 0 and loads as before", () => {
  const p = write([
    { symbol: "KOx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 6, sourceUrl: "https://issuer.example/ko/q2" },
  ]);
  const r = loadDeclarationsFile(p, REG);
  assert.equal(r.ok, true);
  assert.equal(r.loaded, 1);
  assert.equal(r.superseded, 0, "no corrections in a legacy file");
});

// A file with SEVERAL broken supersedes references must name them ALL in one refusal:
// one-error-per-restart used to mean N edit-restart cycles for the operator (each boot
// is 14-90s on the prod container) before the file loads clean.
test("supersedes: every dangling reference is named in the single all-or-nothing refusal", () => {
  const file = write([
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "4000000", decimals: 8, sourceUrl: "https://issuer.example/a" },
    { symbol: "SPYx", exDate: "2026-07-15", amountPerUnitRaw: "7000000", decimals: 8, sourceUrl: "https://issuer.example/b" },
    // two corrections to targets that DO NOT exist
    { symbol: "SPYx", exDate: "2026-06-20", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/c",
      supersedes: { exDate: "2026-06-11", amountPerUnitRaw: "4000000" } },
    { symbol: "SPYx", exDate: "2026-07-16", amountPerUnitRaw: "3000000", decimals: 8, sourceUrl: "https://issuer.example/d",
      supersedes: { exDate: "2026-07-01", amountPerUnitRaw: "7000000" } },
  ]);
  const r = loadDeclarationsFile(file, REG);
  assert.equal(r.ok, false, "the file is refused");
  assert.match(String(r.reason), /2026-06-11/, "the first dangling target is named");
  assert.match(String(r.reason), /2026-07-01/, "the second dangling target is named too — one restart fixes all");
});

// The refusal must aggregate across SYMBOLS too: the loader walks the registry symbol by
// symbol, and the first symbol's throw used to hide every other symbol's broken
// references — "every dangling reference is named" was true only within one symbol.
test("supersedes: broken references of ALL symbols are named in the single refusal", () => {
  const r = loadDeclarationsFile(write([
    { symbol: "SPYx", exDate: "2026-06-18", amountPerUnitRaw: "4000000", decimals: 8, sourceUrl: "https://issuer.example/a" },
    { symbol: "KOx", exDate: "2026-07-15", amountPerUnitRaw: "7000000", decimals: 6, sourceUrl: "https://issuer.example/b" },
    // one dangling correction PER SYMBOL — the SPYx one used to hide the KOx one
    { symbol: "SPYx", exDate: "2026-06-20", amountPerUnitRaw: "2000000", decimals: 8, sourceUrl: "https://issuer.example/c",
      supersedes: { exDate: "2026-06-11", amountPerUnitRaw: "4000000" } },
    { symbol: "KOx", exDate: "2026-07-16", amountPerUnitRaw: "3000000", decimals: 6, sourceUrl: "https://issuer.example/d",
      supersedes: { exDate: "2026-07-01", amountPerUnitRaw: "7000000" } },
  ]), REG);
  assert.equal(r.ok, false);
  assert.match(String(r.reason), /2026-06-11/, "the SPYx dangling target is named");
  assert.match(String(r.reason), /2026-07-01/, "the KOx dangling target is named too — symbols do not hide each other");
  assert.match(String(r.reason), /SPYx: \(/, "each symbol's segment is bracketed — attributable by eye, not only by regex");
  assert.match(String(r.reason), /KOx: \(/, "the second symbol's segment is bracketed too");
});

// A file with hundreds of broken references must not produce a hundred-kilobyte reason:
// the first ten are listed, the rest counted.
test("supersedes: the refusal caps the listed references", () => {
  const list = [];
  for (let i = 0; i < 12; i++) {
    const day = String(10 + i); // 2026-03-10 .. 2026-03-21
    list.push({ symbol: "SPYx", exDate: `2026-03-${day}`, amountPerUnitRaw: "1000000", decimals: 8, sourceUrl: `https://issuer.example/p${i}` });
  }
  for (let i = 0; i < 12; i++) {
    const day = String(10 + i);
    list.push({ symbol: "SPYx", exDate: `2026-04-${day}`, amountPerUnitRaw: "500000", decimals: 8, sourceUrl: `https://issuer.example/c${i}`,
      supersedes: { exDate: `2026-02-${String(10 + i)}`, amountPerUnitRaw: "1000000" } }); // February: no such targets
  }
  const r = loadDeclarationsFile(write(list), REG);
  assert.equal(r.ok, false);
  assert.match(String(r.reason), /2 more/, "the overflow is counted, not listed");
  assert.doesNotMatch(String(r.reason), /2026-03-13/, "the eleventh reference is capped out of the reason");
});
