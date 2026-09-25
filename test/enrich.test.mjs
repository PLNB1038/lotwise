// Unit tests of the decimals enrichment pipeline (enrich-decimals).
// Code analysis: scripts/enrich-decimals.mjs — a thin top-level wrapper: it itself does
// a fetch to lite-api.jup.ag/price/v3 (the URL is hardcoded, no fetcher injection, on
// import the script immediately goes to the network and reads data/tokens.json) — hence it is
// NOT imported into the tests. All the logic lives in src/registry/enrich.mjs: it accepts
// an ALREADY-parsed Jupiter batch response as the prices argument — that is the seam for
// mocks (no network calls; the injection is pure data + a temporary file).
// The source — the Jupiter Price API v3, the response shape Record<mint, {usdPrice, blockId,
// decimals, priceChange24h}>: the enrichment must consume only the decimals field.
// Numeric validation (null | integer 0..18) happens ON INPUT of enrich: garbage from
// the API (negatives, >18, non-integers, non-numbers) does not reach the file — the record is
// untouched, the symbol goes into skipped with the reason "invalid-decimals"; null/undefined
// in the response uniformly means "no value". validateRegistryEntry in registry.mjs —
// the second line of defense on load (a deliberate contract change: enrich used to write
// as is, and a garbage issuer record put the whole registry into the corrupted mode).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyJupiterDecimals, enrichDecimalsFile } from "../src/registry/enrich.mjs";
import { validateRegistryEntry, loadRegistrySafe, RegistryError } from "../src/registry/registry.mjs";

const freshDir = () => mkdtempSync(path.join(tmpdir(), "lotwise-enrich-"));
const fullJson = (list) => JSON.stringify(list, null, 1) + "\n"; // the atomicWriteJson format

// Real mints from data/tokens.json (valid base58 — so the chain passes
// through validateRegistryEntry/loadRegistrySafe unchanged)
const SPYX = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const AAPLX = "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp";
const NVDA = "9BB7Tt5uW5QbAorLkF3Hn1P2mGcXvcDdR7y8LbT9KdUu";

const token = (mint, symbol, decimals = null) => ({
  mint,
  symbol,
  name: `${symbol} Tokenized`,
  issuer: "backed",
  decimals,
});

// A realistic record of the Jupiter v3 batch response: enrich must take only decimals
const jup = (decimals) => ({ usdPrice: 123.45, blockId: 31415926, decimals, priceChange24h: -0.42 });

// ---- successful enrichment from the Jupiter response ----

test("successful enrichment: decimals from the Jupiter v3 batch response, the extra response fields are ignored", () => {
  const list = [token(SPYX, "SPYx"), token(AAPLX, "AAPLx"), token(NVDA, "NVDAx")];
  const r = applyJupiterDecimals(list, {
    [SPYX]: jup(8),
    [AAPLX]: jup(6),
    // Jupiter does not know NVDAx: it stays with decimals=null
  });
  assert.equal(r.filled, 2);
  assert.deepEqual(r.unknown, ["NVDAx"], "unknown — symbols, not mints");
  assert.deepEqual(r.skipped, [], "all values valid — none rejected");
  assert.equal(list[0].decimals, 8);
  assert.equal(list[1].decimals, 6);
  assert.equal(list[0].usdPrice, undefined, "only decimals is consumed, the rest of the response garbage does not leak into the record");
  // an untouched record did not change at all (no sourceDecimals/undefined tails)
  assert.deepEqual(list[2], token(NVDA, "NVDAx"));
});

test("sourceDecimals — a string source label: the filled ones have exactly 'jupiter', foreign labels are not overwritten", () => {
  const list = [
    token(SPYX, "SPYx"),
    token(AAPLX, "AAPLx"),
    { ...token(NVDA, "NVDAx", 9), sourceDecimals: "rpc" }, // a label from a manual pass, as in the live data/tokens.json
  ];
  const r = applyJupiterDecimals(list, { [SPYX]: jup(8), [AAPLX]: jup(6), [NVDA]: jup(42) });
  assert.equal(r.filled, 2, "the (newly) filled — two, the record with 'rpc' is already enriched");
  assert.deepEqual(r.skipped, [], "an already enriched record is ignored entirely: garbage (42) in its part of the response — no reason for skipped");
  for (const t of [list[0], list[1]]) {
    assert.equal(typeof t.sourceDecimals, "string");
    assert.equal(t.sourceDecimals, "jupiter", "the source label is consistent for everyone enrich filled");
  }
  assert.equal(list[2].decimals, 9, "an already enriched record: decimals not overwritten");
  assert.equal(list[2].sourceDecimals, "rpc", "the foreign source label preserved");
});

// ---- the idempotence of a repeated run ----

test("idempotence: a repeated run over an enriched file — filled=0, written=false, the file byte for byte", () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  writeFileSync(p, fullJson([token(SPYX, "SPYx"), token(AAPLX, "AAPLx")]));
  const first = enrichDecimalsFile(p, { [SPYX]: jup(8), [AAPLX]: jup(6) });
  assert.equal(first.filled, 2);
  assert.equal(first.written, true);
  const afterFirst = readFileSync(p, "utf8");
  // a second run with DIFFERENT values in the response: rewriting the already enriched is not allowed
  const second = enrichDecimalsFile(p, { [SPYX]: jup(9), [AAPLX]: jup(7) });
  assert.equal(second.filled, 0, "only records with decimals === null are filled");
  assert.equal(second.written, false, "nothing to write — the file is not even opened for writing");
  assert.deepEqual(second.unknown, []);
  assert.deepEqual(second.skipped, [], "already enriched records do not pass validation again");
  assert.equal(readFileSync(p, "utf8"), afterFirst, "the file byte for byte, the values of the first run alive");
  const list = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(list[0].decimals, 8);
  assert.equal(list[0].sourceDecimals, "jupiter");
  assert.deepEqual(readdirSync(dir), ["tokens.json"], "no tmp litter: there was no write to begin with");
});

// ---- registry file errors: a clear error, not corruption ----

test("a broken registry JSON — a SyntaxError before any write, the file is not corrupted", () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  const torn = fullJson([token(SPYX, "SPYx")]).slice(0, 40); // as after a kill in the write window
  writeFileSync(p, torn);
  assert.throws(() => enrichDecimalsFile(p, { [SPYX]: jup(8) }), SyntaxError);
  assert.equal(readFileSync(p, "utf8"), torn, "the enrichment fell BEFORE the write — the truncated file neither appended nor replaced");
  assert.deepEqual(readdirSync(dir), ["tokens.json"]);
});

test("no registry file — throws, creates nothing", () => {
  const dir = freshDir();
  const p = path.join(dir, "no-file.json");
  assert.throws(() => enrichDecimalsFile(p, { [SPYX]: jup(8) }));
  assert.deepEqual(readdirSync(dir), [], "the enrichment has no right to silently create a registry");
});

// ---- an unexpected Jupiter response shape ----

test("an unexpected response shape neither kills the enrichment nor corrupts the records", () => {
  const list = () => [token(SPYX, "SPYx"), token(AAPLX, "AAPLx")];

  // no response at all (null/undefined of the parsed JSON)
  let r = applyJupiterDecimals(list(), null);
  assert.equal(r.filled, 0);
  assert.deepEqual(r.unknown, ["SPYx", "AAPLx"]);
  assert.deepEqual(r.skipped, []);
  assert.ok(r.filled === 0 && list().every((t) => t.decimals === null));

  // the response is an array (no keys by mint)
  r = applyJupiterDecimals(list(), []);
  assert.equal(r.filled, 0);
  assert.deepEqual(r.unknown, ["SPYx", "AAPLx"]);

  // a response record is not an object (a string/number): the "no value" guard saves
  r = applyJupiterDecimals(list(), { [SPYX]: "oops", [AAPLX]: 42 });
  assert.equal(r.filled, 0);
  assert.equal(r.unknown.length, 0, "the fact: the key exists — the mint does not get into unknown, but there is nothing to fill either");
  assert.deepEqual(r.skipped, [], "an undefined in the response — \"no value\", not garbage");
  const l = list();
  applyJupiterDecimals(l, { [SPYX]: "oops" });
  assert.equal(l[0].decimals === null, true, "a garbage response value is not written into decimals");

  // the record exists, no decimals field — the mint is "known" but there is nothing to fill
  r = applyJupiterDecimals(list(), { [SPYX]: { usdPrice: 1.5 }, [AAPLX]: {} });
  assert.equal(r.filled, 0);
  assert.deepEqual(r.unknown, []);
  assert.deepEqual(r.skipped, []);
});

test("decimals:null and undefined in the Jupiter response uniformly — \"no value\": the record untouched, no label set", () => {
  for (const noValue of [null, undefined]) {
    const list = [token(SPYX, "SPYx")];
    const r = applyJupiterDecimals(list, { [SPYX]: { usdPrice: 100, decimals: noValue } });
    // earlier null was mistakenly counted as a value: filled ticked and a 'jupiter' label was stuck on
    assert.equal(r.filled, 0, `decimals=${noValue} — not a fill`);
    assert.deepEqual(r.skipped, [], "an absent value — not garbage, does not get into skipped");
    assert.deepEqual(list[0], token(SPYX, "SPYx"), "the record byte for byte: no undefined tails, no sourceDecimals");
  }
});

// ---- invalid decimals: validation ON INPUT, the 0..18 contract ----

test("garbage decimals from Jupiter (negatives, >18, non-integers, non-numbers) are not written: the record untouched, the symbol into skipped", () => {
  for (const bad of [-1, 19, 6.5, "8", NaN]) {
    const list = [token(SPYX, "SPYx")];
    const r = applyJupiterDecimals(list, { [SPYX]: jup(bad) });
    assert.equal(r.filled, 0, `decimals=${bad} must not tick filled`);
    assert.deepEqual(r.skipped, [{ symbol: "SPYx", reason: "invalid-decimals" }], `decimals=${bad} — rejected with a reason`);
    assert.deepEqual(list[0], token(SPYX, "SPYx"), "the record untouched: decimals stays null, no label");
    // a record enrich did not touch remains valid for the registry (the second line is not needed)
    assert.ok(validateRegistryEntry(list[0]));
  }
});

test("the contract boundaries 0 and 18 are written; a mixed run: the valid filled, the garbage — into skipped", () => {
  const list = [token(SPYX, "SPYx"), token(AAPLX, "AAPLx"), token(NVDA, "NVDAx")];
  const r = applyJupiterDecimals(list, { [SPYX]: jup(0), [AAPLX]: jup(18), [NVDA]: jup(19) });
  assert.equal(r.filled, 2);
  assert.equal(list[0].decimals, 0, "the boundary 0 — a valid value");
  assert.equal(list[0].sourceDecimals, "jupiter");
  assert.equal(list[1].decimals, 18, "the boundary 18 — a valid value");
  assert.deepEqual(r.skipped, [{ symbol: "NVDAx", reason: "invalid-decimals" }]);
  assert.equal(list[2].decimals, null, "the garbage record untouched");
});

test("the end-to-end chain: a garbage decimals from Jupiter does not reach the file — the registry does not fall into corrupted", async () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  writeFileSync(p, fullJson([token(SPYX, "SPYx")]));
  const before = readFileSync(p, "utf8");
  const r = enrichDecimalsFile(p, { [SPYX]: jup(42) }); // Jupiter served 42 — enrich rejects
  assert.equal(r.filled, 0);
  assert.equal(r.written, false, "nothing to fill (all into skipped) — the file is not opened for writing");
  assert.deepEqual(r.skipped, [{ symbol: "SPYx", reason: "invalid-decimals" }]);
  assert.equal(readFileSync(p, "utf8"), before, "the file byte for byte — the garbage did not get into the registry");
  const boot = await loadRegistrySafe(p);
  // earlier enrich would have written 42, and one garbage issuer record would have put the whole registry into corrupted
  assert.equal(boot.ok, true, "the registry healthy: the input validation closed the path to corrupted");
  assert.equal(boot.corrupted, false);
  assert.deepEqual(boot.registry.map((t) => t.decimals), [null]);
});

test("enrichDecimalsFile: only skipped without filled — the file not rewritten, skipped reaches the caller", () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  writeFileSync(p, fullJson([token(SPYX, "SPYx"), token(AAPLX, "AAPLx")]));
  const before = readFileSync(p, "utf8");
  const r = enrichDecimalsFile(p, { [SPYX]: jup(6.5), [AAPLX]: jup(-3) });
  assert.equal(r.filled, 0);
  assert.equal(r.written, false);
  assert.deepEqual(r.skipped, [
    { symbol: "SPYx", reason: "invalid-decimals" },
    { symbol: "AAPLx", reason: "invalid-decimals" },
  ]);
  assert.equal(readFileSync(p, "utf8"), before);
  assert.deepEqual(readdirSync(dir), ["tokens.json"], "no tmp litter: there was no write to begin with");
});

test("enrichDecimalsFile: a mixed run — the valid filled and written atomically, the garbage does not leak into the file", () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  writeFileSync(p, fullJson([token(SPYX, "SPYx"), token(AAPLX, "AAPLx")]));
  const r = enrichDecimalsFile(p, { [SPYX]: jup(8), [AAPLX]: jup(6.5) });
  assert.equal(r.filled, 1);
  assert.equal(r.written, true);
  assert.deepEqual(r.skipped, [{ symbol: "AAPLx", reason: "invalid-decimals" }]);
  const list = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(list[0].decimals, 8);
  assert.equal(list[0].sourceDecimals, "jupiter");
  assert.equal(list[1].decimals, null, "the garbage not written — the record in its original form");
  assert.equal(list[1].sourceDecimals, undefined);
  // the second line of defense in place: if garbage nevertheless leaks into the file another way, the validator beats it back
  assert.throws(
    () => validateRegistryEntry({ ...list[1], decimals: 42 }),
    (err) => err instanceof RegistryError && /decimals/.test(err.message),
  );
});


// ---- the live registry's consistency with the enrich contract ----

test("the real data/tokens.json is consistent: every record's sourceDecimals — a non-empty string label, decimals — an integer", () => {
  const registryPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "tokens.json");
  const list = JSON.parse(readFileSync(registryPath, "utf8"));
  assert.ok(list.length >= 20, `expected >=20 tokens, got ${list.length}`);
  for (const t of list) {
    assert.equal(typeof t.sourceDecimals, "string", `${t.symbol}: the source label must be a string`);
    assert.ok(t.sourceDecimals.length > 0, `${t.symbol}: an empty source label`);
    assert.ok(Number.isInteger(t.decimals), `${t.symbol}: decimals=${t.decimals}, an integer expected after enrich`);
    // the 'jupiter' label is compatible with the real values (6..9 in the live file)
    assert.ok(t.decimals >= 0 && t.decimals <= 18, `${t.symbol}: decimals=${t.decimals} outside the 0..18 contract`);
  }
});

// ---- (SRE P2-1): the CLI's own exit contract on a broken registry ----
// serve degrades a corrupt registry with evidence and a /health flag, webhook-deliver exits
// 2 — enrich used to die with a raw SyntaxError stack and exit 1, and a non-array file
// slipped through as a silent "filled=0" success. The wrapper now refuses before any I/O.
import { spawnSync } from "node:child_process";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "enrich-decimals.mjs");

test("CLI enrich: a truncated/BOM/null registry — exit 2, a named reason, no stack trace, no network", () => {
  for (const [name, content] of [
    ["truncated", '[{"mint":"XsoCS'],
    ["empty-file", ""],
    ["bom", "﻿[]"],
    ["null-literal", "null"],
    ["object-not-array", '{"tokens":[]}'],
  ]) {
    const dir = freshDir();
    const reg = path.join(dir, "tokens.json");
    writeFileSync(reg, content);
    const r = spawnSync(process.execPath, [SCRIPT, "--registry", reg, "--api", "http://127.0.0.1:1"], { encoding: "utf8", timeout: 30_000 });
    assert.equal(r.status, 2, `${name}: usage-class exit 2 (not a raw crash)`);
    assert.ok(/registry/.test(r.stderr), `${name}: the message names the registry`);
    assert.ok(!/^s+at /mu.test(r.stderr), `${name}: no stack trace for the operator`);
    assert.equal(r.stdout.trim(), "", `${name}: no success output`);
  }
});

test("CLI enrich: a missing registry file — exit 2 with the path, not an ENOENT stack", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--registry", path.join(freshDir(), "nope.json"), "--api", "http://127.0.0.1:1"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 2);
  assert.ok(/registry unreadable/.test(r.stderr));
  assert.ok(!/^s+at /mu.test(r.stderr));
});

test("CLI enrich: an empty-but-valid registry — exit 0 and an EXPLICIT message, not a silent success", () => {
  const dir = freshDir();
  const reg = path.join(dir, "tokens.json");
  writeFileSync(reg, "[]");
  const r = spawnSync(process.execPath, [SCRIPT, "--registry", reg, "--api", "http://127.0.0.1:1"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 0);
  assert.ok(/registry is empty/.test(r.stdout), "the operator is told, not left to guess");
});
