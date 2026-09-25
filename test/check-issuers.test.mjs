// Tests of the check-issuers auditor: the "registry ↔ issuer sources" reconciliation.
// NO NETWORK: all the responses are URL-keyed mock fetchers. prestocks — real fixtures of the live
// endpoint (prestocks-openai.json, prestocks-spacex.json, captured 2026-09-22);
// xstocks — a real captured multiplier fixture (xstocks-spyx-current.json);
// tessera — synthetics (the cdn payload was not saved; the check contract — "it exists
// and parses", the content is not validated).
//
// The status semantics (the main thing in the auditor): fail = a CONFIRMED divergence only
// (a 404, a foreign symbol, a broken payload); a network failure = skipped, because "could not
// check" is not "the registry diverged from the issuer".
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildSummary, checkRegistry, checkToken, main } from "../scripts/check-issuers.mjs";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const FIX = (name) => JSON.parse(readFileSync(path.join(dir, name), "utf8"));
const SCRIPT = path.join(import.meta.dirname, "..", "scripts", "check-issuers.mjs");

// Real data/tokens.json records (the mints are public — they are addresses, not secrets).
const TOKENS = [
  { mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", symbol: "SPYx", issuer: "backed" },
  { mint: "PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF", symbol: "OPENAI", issuer: "prestocks" },
  { mint: "TSPXcLV76s6V2zDiZQ18kBfcbnjaE2ZzNT3ga2Pd99v", symbol: "T-SpaceX", issuer: "tessera" },
  { mint: "DELL2aRKQz7DMq5DrKLtkn47ZCnbxXPZXrSGbkmd13wy", symbol: "DELL", issuer: "backpack" },
];

const XSTOCKS_URL = "https://api.xstocks.fi/api/v2/public/assets/SPYx/multiplier?network=Solana";
const PRESTOCKS_URL = "https://prestocks.com/metadata/openai.json";
const TESSERA_URL = "https://cdn.tesseralab.co/tessera/t-spacex.json";

const multiplierPayload = FIX("xstocks-spyx-current.json"); // the live SPYx multiplier payload
const openaiMeta = FIX("prestocks-openai.json"); // the live PreStocks metadata
// Tessera synthetics: identity metadata in the spirit of the T-SpaceX mint's uri (see onchain-t-spacex-mint.json).
const tesseraMeta = {
  name: "T-SpaceX",
  symbol: "tSpaceX",
  image: "https://cdn.tesseralab.co/tessera/t-spacex.png",
  external_url: "https://tessera.pe/t-spacex",
};

// A mock fetcher: answers strictly by the URL map; an extra request = a test failure
// (that is how "backpack goes to the network" and any unexpected walks are caught).
// The map values: a payload | a status number | an Error (a throw = a network failure).
function router(map, seen = []) {
  return async (url) => {
    seen.push(url);
    const hit = map[url];
    if (hit === undefined) throw new Error(`an unexpected URL: ${url}`);
    if (hit instanceof Error) throw hit;
    if (typeof hit === "number") return { ok: false, status: hit, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => hit };
  };
}

const okMap = () => ({ [XSTOCKS_URL]: multiplierPayload, [PRESTOCKS_URL]: openaiMeta, [TESSERA_URL]: tesseraMeta });

// ---------- checkToken: success per each issuer ----------

test("success: three sources answer — ok, backpack skipped without a single request", async () => {
  const seen = [];
  const results = await checkRegistry(TOKENS, { fetcher: router(okMap(), seen), sleep: async () => {} });
  assert.deepEqual(
    results.map((r) => [r.symbol, r.status]),
    [["SPYx", "ok"], ["OPENAI", "ok"], ["T-SpaceX", "ok"], ["DELL", "skipped"]],
  );
  assert.equal(results[3].reason, "no-source");
  for (const r of results.slice(0, 3)) assert.equal(r.reason, null);
  // Exactly three requests to the expected URLs (the lowercase for the symbol is done by the builder).
  assert.deepEqual(seen.sort(), [PRESTOCKS_URL, TESSERA_URL, XSTOCKS_URL].sort());
});

test("the report rows carry the mint, the issuer and the url of the checked endpoint", async () => {
  const results = await checkRegistry(TOKENS, { fetcher: router(okMap()), sleep: async () => {} });
  assert.equal(results[0].mint, "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W");
  assert.equal(results[0].url, XSTOCKS_URL);
  assert.equal(results[1].url, PRESTOCKS_URL);
  assert.equal(results[2].url, TESSERA_URL);
  assert.equal(results[3].url, null); // we did not go to the network — no URL
});

// ---------- divergences: fail ----------

test("a symbol divergence at prestocks (we asked for OPENAI, it served SPACEX) — fail, not a skip", async () => {
  const result = await checkToken(TOKENS[1], { fetcher: router({ [PRESTOCKS_URL]: FIX("prestocks-spacex.json") }) });
  assert.equal(result.status, "fail");
  assert.match(result.reason, /symbol mismatch/);
  assert.match(result.reason, /OPENAI/);
});

test("a 404 from the issuer — a confirmed divergence (the asset removed): fail for tessera and xstocks", async () => {
  const tessera = await checkToken(TOKENS[2], { fetcher: router({ [TESSERA_URL]: 404 }) });
  assert.equal(tessera.status, "fail");
  assert.match(tessera.reason, /HTTP 404/);
  const backed = await checkToken(TOKENS[0], { fetcher: router({ [XSTOCKS_URL]: 404 }) });
  assert.equal(backed.status, "fail");
  assert.match(backed.reason, /HTTP 404/);
});

test("a multiplier payload without currentMultiplier — the source does not know the symbol: fail", async () => {
  const result = await checkToken(TOKENS[0], { fetcher: router({ [XSTOCKS_URL]: {} }) });
  assert.equal(result.status, "fail");
  assert.match(result.reason, /unexpected multiplier payload|currentMultiplier/);
});

test("a broken JSON from tessera (the file does not parse) — fail", async () => {
  const result = await checkToken(TOKENS[2], {
    fetcher: async (url) => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } }),
  });
  assert.equal(result.status, "fail");
  assert.match(result.reason, /bad JSON/);
});

test("an unknown issuer in the registry — fail: nothing to reconcile against", async () => {
  const result = await checkToken({ mint: "DELL2aRKQz7DMq5DrKLtkn47ZCnbxXPZXrSGbkmd13wy", symbol: "DELL", issuer: "acme" }, { fetcher: router({}) });
  assert.equal(result.status, "fail");
  assert.match(result.reason, /unknown issuer/); // EN
});

// ---------- the network: skipped, not fail ----------

test("a network failure — skipped with a network: reason, not a fail (it is not a divergence)", async () => {
  const refused = new Error("ECONNREFUSED");
  for (const token of TOKENS.slice(0, 3)) {
    const result = await checkToken(token, { fetcher: async () => { throw refused; } });
    assert.equal(result.status, "skipped", `${token.symbol}: the network is a skipped`);
    assert.match(result.reason, /^network: ECONNREFUSED$/);
  }
});

test("a total network outage gives a clean summary (fail=0) — the audit honestly says \"could not\"", async () => {
  const refused = new Error("getaddrinfo ENOTFOUND");
  const results = await checkRegistry(TOKENS, {
    fetcher: async () => { throw refused; },
    sleep: async () => {},
  });
  const summary = buildSummary(results);
  assert.deepEqual(summary, { total: 4, ok: 0, skipped: 4, fail: 0, clean: true });
});

// ---------- backpack ----------

test("backpack: no-source without a request even when the fetcher is empty (the client is not invented)", async () => {
  const result = await checkToken(TOKENS[3], { fetcher: router({}) });
  assert.deepEqual(
    { status: result.status, reason: result.reason, url: result.url },
    { status: "skipped", reason: "no-source", url: null },
  );
});

// ---------- the throttle ----------

test("a throttle of 1500ms only between real requests; backpack spends no pause", async () => {
  const sleeps = [];
  await checkRegistry(TOKENS, {
    fetcher: router(okMap()),
    sleep: async (ms) => sleeps.push(ms),
  });
  // 4 tokens, 3 requests -> 2 pauses (before the 2nd and the 3rd request), all of 1500.
  assert.deepEqual(sleeps, [1500, 1500]);
});

test("a backpack-only registry makes neither requests nor pauses", async () => {
  const sleeps = [];
  const results = await checkRegistry([TOKENS[3], TOKENS[3]], {
    fetcher: router({}),
    sleep: async (ms) => sleeps.push(ms),
  });
  assert.equal(results.length, 2);
  assert.deepEqual(sleeps, []);
});

// ---------- buildSummary / parseArgs ----------

test("buildSummary: the counters and clean=false only in the presence of a fail", () => {
  const rows = [
    { status: "ok" }, { status: "ok" }, { status: "skipped" }, { status: "fail" },
  ];
  assert.deepEqual(buildSummary(rows), { total: 4, ok: 2, skipped: 1, fail: 1, clean: false });
  assert.equal(buildSummary([{ status: "skipped" }]).clean, true, "skips alone — not a divergence");
  assert.deepEqual(buildSummary([]), { total: 0, ok: 0, skipped: 0, fail: 0, clean: true });
});

// ---------- CLI: the exit codes, --json (the registry/throttle are swapped by flags, no network) ----------

const created = [];
function tempRegistry(tokens) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "check-issuers-")), "tokens.json");
  created.push(path.dirname(file));
  writeFileSync(file, JSON.stringify(tokens));
  return file;
}
test.after(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
});

test("CLI: a backpack-only registry — exit 0, the summary honestly with skips, no network", () => {
  const reg = tempRegistry([TOKENS[3], { ...TOKENS[3], symbol: "DKNG", mint: "DKNGQFNGQmoBdXSRGKJ8tTu7uPDasw5JDcfMmWniNfow" }]);
  const res = spawnSync(process.execPath, [SCRIPT, "--registry", reg, "--json"], { encoding: "utf8" });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const report = JSON.parse(res.stdout);
  assert.equal(report.summary.total, 2);
  assert.equal(report.summary.skipped, 2);
  assert.equal(report.summary.fail, 0);
  assert.equal(report.summary.clean, true);
  assert.equal(report.results.length, 2);
  assert.equal(report.results[0].reason, "no-source");
});

test("CLI: a confirmed divergence (an unknown issuer) — exit 1 and a fail in --json", () => {
  const reg = tempRegistry([{ mint: "X", symbol: "DELL", issuer: "acme" }]);
  const res = spawnSync(process.execPath, [SCRIPT, "--registry", reg, "--json"], { encoding: "utf8" });
  assert.equal(res.status, 1, `stderr: ${res.stderr}`);
  const report = JSON.parse(res.stdout);
  assert.equal(report.summary.fail, 1);
  assert.equal(report.summary.clean, false);
  assert.match(report.results[0].reason, /unknown issuer/); // EN
});

test("CLI: the human-readable mode prints the TOTAL over a skips-only registry", () => {
  const reg = tempRegistry([TOKENS[3]]);
  const res = spawnSync(process.execPath, [SCRIPT, "--registry", reg], { encoding: "utf8" });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /TOTAL: ok=0, skipped=1, fail=0/); // EN
});

test("CLI: a nonexistent registry — exit 2, an unknown flag — exit 2", () => {
  const badReg = spawnSync(
    process.execPath,
    [SCRIPT, "--registry", path.join(tmpdir(), "check-issuers-no-such-xyz.json")],
    { encoding: "utf8" },
  );
  assert.equal(badReg.status, 2);
  const badFlag = spawnSync(process.execPath, [SCRIPT, "--no-such-flag"], { encoding: "utf8" });
  assert.equal(badFlag.status, 2);
});
