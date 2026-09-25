// Tests of the DIVIDEND_ACCRUAL producer from issuer declarations (src/events/dividends.mjs).
//
// Context (dividend-e2e, GAP 1): the only source normalizer produces
// only MULTIPLIER_CHANGE, even for nodes with the reason "Dividend". A study of the live
// API (2026-09-22, the dividends-*.json fixtures) showed: the multiplier history nodes
// have NO per-unit amount and NO payout dates — only id/reason/multiplier/previousMultiplier/
// activationDateTime; there is no /dividends endpoint (404), and the asset card has no dividend
// fields. Hence the producer — variant B: the "issuer declaration" contract,
// without any inference of the amount from the multiplier.
//
// The dividends-*.json fixtures — LIVE api.xstocks.fi responses captured during the study:
// they are used as an honesty pin ("the real data has no amount — the event
// is not synthesized"), not as a source of events.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dividendsFromDeclarations, DeclarationError } from "../src/events/dividends.mjs";
import * as dividendsModule from "../src/events/dividends.mjs";
import { bindMintAndValidate, NormalizeError } from "../src/events/normalize-xstocks.mjs";
import { validateEvent, EventValidationError } from "../src/schema/events.mjs";
import { applyEvents } from "../src/lots/lots.mjs";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

// Live issuer responses captured 2026-09-22 (network=Solana)
const koxHistory = JSON.parse(readFileSync(path.join(dir, "dividends-kox-history-sol.json"), "utf8"));
const spyxHistory = JSON.parse(readFileSync(path.join(dir, "dividends-spyx-history-sol.json"), "utf8"));
const spyxAssetRoot = JSON.parse(readFileSync(path.join(dir, "dividends-spyx-asset-root.json"), "utf8"));

const MINT = "DividendMint" + "1".repeat(32); // 44 base58 chars (without 0/O/I/l), synthetics
const OWNER = "DividendAddr" + "1".repeat(32);

// ---- declarations ----

// KOx really pays quarterly dividends (5 "Dividend" nodes in the live history);
// the amounts below are SYNTHETIC declarations for the contract tests, not API data.
const decl = (over = {}) => ({
  symbol: "KOx",
  exDate: "2026-09-15",
  amountPerUnitRaw: "410000", // $4.10 per token at decimals 8, as a raw string
  decimals: 8,
  sourceUrl: "https://issuer.example/ko-dividend-q3-2026",
  ...over,
});

const err = (fn, tag) => assert.throws(fn, DeclarationError, tag);

// ---- the happy path ----

test("declarations → DIVIDEND_ACCRUAL: the fields from the declaration 1:1, sorted old→new", () => {
  const events = dividendsFromDeclarations([
    decl({ exDate: "2026-09-15T00:30:00.000Z" }),                       // the "newest" fed first
    decl({ exDate: "2025-12-15", amountPerUnitRaw: 405000, sourceUrl: "https://issuer.example/ko-dividend-q4-2025" }),
    decl({ exDate: "2026-06-14T23:55:00Z", sourceUrl: "https://issuer.example/ko-dividend-q2-2026" }),
  ], { symbol: "KOx" });

  assert.equal(events.length, 3);
  // round 24 (F1 root): datetime forms are accepted and land as their calendar DAY
  assert.deepEqual(events.map((e) => e.effectiveDate), [
    "2025-12-15",
    "2026-06-14",
    "2026-09-15",
  ]);
  for (const e of events) {
    assert.equal(e.type, "DIVIDEND_ACCRUAL");
    assert.equal(e.status, "confirmed"); // a declaration = an issuer statement
    assert.equal(e.decimals, 8);
    assert.equal("mint" in e, false); // bindMintAndValidate will set the mint
    assert.equal("reason" in e, false); // reason — a marker of multiplier nodes, absent here
  }
  assert.equal(events[0].amountPerUnitRaw, 405000); // a number input stays a number
  assert.equal(events[2].amountPerUnitRaw, 410000); // a string input "410000" → the same integer
  assert.deepEqual(events[2].sources, ["https://issuer.example/ko-dividend-q3-2026"]); // as served
});

test("the events pass bindMintAndValidate and the schema; the input is not mutated", () => {
  const input = [decl(), decl({ exDate: "2026-06-14" })];
  const snapshot = JSON.stringify(input);
  const bound = bindMintAndValidate(dividendsFromDeclarations(input, { symbol: "KOx" }), MINT);

  assert.equal(bound.length, 2);
  for (const e of bound) {
    assert.equal(e.mint, MINT);
    assert.equal(validateEvent(e), true); // a double check directly by the schema
  }
  assert.equal(JSON.stringify(input), snapshot); // the declarations untouched
});

test("the produced event moves the lot engine: totalRaw = amount × qty (the seam with lots.mjs)", () => {
  const [e] = bindMintAndValidate(dividendsFromDeclarations([decl()], { symbol: "KOx" }), MINT);
  const { accruals, applied } = applyEvents([{
    id: "L1", mint: MINT, owner: OWNER, qtyRaw: 100_000_000n, acquiredDate: "2026-09-01", basisRaw: 1n,
  }], [e]);
  assert.equal(applied, 1);
  assert.equal(accruals.length, 1);
  assert.equal(accruals[0].totalRaw, 410000n * 100_000_000n); // raw × raw, BigInt
});

// ---- the amount boundaries ----

test("amountPerUnitRaw: 0, -1, a float, garbage strings, NaN/Infinity, above MAX_SAFE — all into DeclarationError", () => {
  for (const bad of [
    0, -1, 1.5, -0.0001, NaN, Infinity, -Infinity,
    "", "abc", "-1", "4.10", " 410000", "410000 ", "1e6", "+1", "0x10", "ten",
    null, undefined, true, {}, ["410000"],
    "10000000000000000000",  // a string above Number.MAX_SAFE_INTEGER — Number(bi) would lose precision
    1e21,                    // an integer number, but outside the schema's safe range
  ]) {
    err(() => dividendsFromDeclarations([decl({ amountPerUnitRaw: bad })], { symbol: "KOx" }),
      `amountPerUnitRaw=${JSON.stringify(bad)}`);
  }
});

test("amountPerUnitRaw: the safe-range boundaries — MAX_SAFE passes, MAX_SAFE+1 does not", () => {
  const ok = dividendsFromDeclarations([decl({ amountPerUnitRaw: Number.MAX_SAFE_INTEGER })], { symbol: "KOx" });
  assert.equal(ok[0].amountPerUnitRaw, 9007199254740991); // exactly, without a precision loss
  err(() => dividendsFromDeclarations([decl({ amountPerUnitRaw: "9007199254740992" })], { symbol: "KOx" }));
});

test("decimals: outside 0..18, a float, garbage — rejected; the boundaries 0 and 18 valid; digit strings ok", () => {
  for (const bad of [-1, 19, 1.5, "8.5", "abc", "", null, undefined, true, {}, "100000000000000000000"]) {
    err(() => dividendsFromDeclarations([decl({ decimals: bad })], { symbol: "KOx" }), `decimals=${JSON.stringify(bad)}`);
  }
  for (const good of [0, 18, "0", "18"]) {
    const [e] = dividendsFromDeclarations([decl({ decimals: good })], { symbol: "KOx" });
    assert.equal(e.decimals, Number(good), `decimals=${JSON.stringify(good)}`);
  }
});

// ---- the exDate formats ----

// round 24 (F1 root) rewrites the pin: every canonical ISO form is accepted and lands as
// its CALENDAR DAY — a datetime with an offset names the same ex-day with a different
// instant, and that instant must not become a second dividend downstream
test("exDate: canonical ISO forms are accepted and canonicalize to the date-only ex-day", () => {
  for (const good of ["2026-09-15", "2026-09-15T00:00:00Z", "2026-09-15T14:30:00+02:00", "2026-09-15T00:30:00.000Z"]) {
    const [e] = dividendsFromDeclarations([decl({ exDate: good })], { symbol: "KOx" });
    assert.equal(e.effectiveDate, "2026-09-15", good);
  }
});

test("exDate: garbage formats — a DeclarationError BEFORE moving into the engine (the battery)", () => {
  for (const bad of [
    "2026-02-30",            // a rolled-over date (Date.parse would silently move it to March)
    "2026-13-01",
    "2026-9-15",             // not the canonical form
    "2026-09-15T12:00:00",   // a naive time = the host's locale
    "09/15/2026",
    "15-09-2026",
    "20260915",
    20260915,                // a number instead of a string
    null, undefined, true, {}, [],
    "",
  ]) {
    err(() => dividendsFromDeclarations([decl({ exDate: bad })], { symbol: "KOx" }), `exDate=${JSON.stringify(bad)}`);
  }
});

// ---- the symbol filter ----

test("ctx.symbol: mandatory; foreign symbols are skipped, its own is caught case-insensitively", () => {
  err(() => dividendsFromDeclarations([decl()], {}), "no ctx.symbol");
  err(() => dividendsFromDeclarations([decl()], { symbol: "" }), "an empty ctx.symbol");
  err(() => dividendsFromDeclarations([decl()], { symbol: 42 }), "a non-string ctx.symbol");
  err(() => dividendsFromDeclarations("not-an-array", { symbol: "KOx" }), "a non-array of declarations");

  const mixed = [
    decl({ symbol: "JPMx", sourceUrl: "https://issuer.example/jpm" }),
    decl({ sourceUrl: "https://issuer.example/ko-a" }),
    decl({ symbol: "kox", exDate: "2026-06-14", sourceUrl: "https://issuer.example/ko-b" }), // another case
  ];
  const events = dividendsFromDeclarations(mixed, { symbol: "KOx" });
  assert.equal(events.length, 2); // JPMx skipped, "KOx" and "kox" taken
  assert.deepEqual(events.map((e) => e.sources[0]), [
    "https://issuer.example/ko-b",
    "https://issuer.example/ko-a",
  ]);
});

test("a declaration without a symbol / with a non-string — a broken feed: a loud error, not a silent skip", () => {
  err(() => dividendsFromDeclarations([{ exDate: "2026-09-15", amountPerUnitRaw: 1, decimals: 8, sourceUrl: "https://x.example/a" }], { symbol: "KOx" }));
  err(() => dividendsFromDeclarations([decl({ symbol: 42 })], { symbol: "KOx" }));
  err(() => dividendsFromDeclarations([null], { symbol: "KOx" }));
  err(() => dividendsFromDeclarations(["2026-09-15"], { symbol: "KOx" }));
});

// ---- sources and dedup ----

test("sourceUrl: missing/short/non-string — a DeclarationError; a valid one lands in sources verbatim", () => {
  for (const bad of [undefined, null, "", "ab", "  ", 42, {}]) {
    err(() => dividendsFromDeclarations([decl({ sourceUrl: bad })], { symbol: "KOx" }), `sourceUrl=${JSON.stringify(bad)}`);
  }
  const [e] = dividendsFromDeclarations([decl({ sourceUrl: "doc:R25 §3" })], { symbol: "KOx" }); // not a URL — but a link
  assert.deepEqual(e.sources, ["doc:R25 §3"]);
});

test("an exact duplicate declaration collapses (a repeated feed does not double the accrual), a near one — does not", () => {
  const dup = [decl(), JSON.parse(JSON.stringify(decl()))]; // a deep copy — the same content
  assert.equal(dividendsFromDeclarations(dup, { symbol: "KOx" }).length, 1);

  // another sourceUrl with everything else equal — deliberately NOT collapsed: without an id in
  // the declaration a "repeat" cannot be told from a "second declaration" (the module's trade-off)
  const near = [decl(), decl({ sourceUrl: "https://issuer.example/ko-dividend-q3-mirror" })];
  assert.equal(dividendsFromDeclarations(near, { symbol: "KOx" }).length, 2);
});

// ---- honesty pins: the real API contains no amount → the event is NOT synthesized ----

test("PIN: the live 'Dividend' nodes of the issuer are NOT declarations — the producer rejects them, does not invent an amount", () => {
  // The live KOx history has 5 nodes with the reason "Dividend" and real multiplier deltas —
  // and not a single amount/payout-date field. Feeding the nodes as declarations must
  // fail: the node has neither amountPerUnitRaw nor sourceUrl.
  assert.equal(koxHistory.nodes.length, 5);
  assert.ok(koxHistory.nodes.every((n) => n.reason === "Dividend"));
  err(() => dividendsFromDeclarations(koxHistory.nodes, { symbol: "KOx" }));
  err(() => dividendsFromDeclarations(spyxHistory.nodes, { symbol: "SPYx" }));
});

test("PIN: the live dividend nodes have exactly 5 fields — there is no amount or payout date in the issuer data", () => {
  for (const n of [...koxHistory.nodes, ...spyxHistory.nodes]) {
    assert.deepEqual(Object.keys(n).sort(), ["activationDateTime", "id", "multiplier", "previousMultiplier", "reason"]);
    // hence there is nowhere to derive amountPerUnitRaw from — not a single numeric candidate
    assert.equal("amount" in n, false);
    assert.equal("amountPerUnit" in n, false);
    assert.equal("dividendPerShare" in n, false);
  }
});

test("PIN: the asset card contains no dividend/NAV fields (a recursive scan of the live response)", () => {
  const keys = [];
  (function walk(o, p = "") {
    for (const [k, v] of Object.entries(o)) {
      keys.push(p + k);
      if (v && typeof v === "object" && !Array.isArray(v)) walk(v, p + k + ".");
    }
  })(spyxAssetRoot);
  assert.equal(keys.filter((k) => /div|nav|yield|amount|cash|distribution/i.test(k)).length, 0);
});

test("PIN: the module has no \"multiplier → dividend\" synthesizer — the exports are exhausted by the declarations contract", () => {
  assert.deepEqual(Object.keys(dividendsModule).sort(), ["DeclarationError", "dividendsFromDeclarations"]);
});

// ---- the seam with the existing pipeline ----

test("bindMintAndValidate wraps a schema error into NormalizeError — the contract is one with the xstocks path", () => {
  // The producer will not let garbage through, but we check the binding contract independently:
  // forging an event past the producer and feeding it to bindMintAndValidate — loudly.
  const forged = [{ type: "DIVIDEND_ACCRUAL", effectiveDate: "2026-09-15", status: "confirmed",
    sources: ["https://x.example/a"], amountPerUnitRaw: 1.5, decimals: 8 }];
  assert.throws(() => bindMintAndValidate(forged, MINT), NormalizeError);
  // and directly by the schema — an EventValidationError
  assert.throws(() => validateEvent({ ...forged[0], mint: MINT }), EventValidationError);
});

// round 24 (ops S3): a sourceUrl is a REFERENCE, not a payload — a 100 KB "url" rode
// into the store, /events bodies and every webhook POST unbounded
test("declarations: a sourceUrl beyond 2048 chars is refused (a reference, not a payload)", () => {
  const huge = "https://issuer.example/d?" + "x".repeat(3000);
  assert.throws(
    () => dividendsFromDeclarations([decl({ sourceUrl: huge })], { symbol: "KOx" }),
    (err) => err instanceof DeclarationError && /2048/.test(err.message) && /3025/.test(err.message),
  );
});
