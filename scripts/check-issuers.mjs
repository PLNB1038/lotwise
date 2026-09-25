// check-issuers — periodic "registry ↔ issuer sources" reconciliation: we catch divergences
// (the issuer changed the mint / re-issued the token / dropped the asset). Strictly read-only:
// the report ONLY, the registry is never edited.
//
// Run from the repo root:
//   node scripts/check-issuers.mjs
//   node scripts/check-issuers.mjs --json
// Flags:
//   --json                JSON report {results, summary} only, in stdout
//   --registry <path>     path to the registry (default data/tokens.json; needed by tests)
//   --throttle-ms <ms>    pause between HTTP requests (default 1500; needed by tests)
//   -h, --help            help
// Exit codes: 0 — no confirmed divergences, 1 — there is a fail, 2 — launch/read error.
//
// What is checked per issuer (sources — the existing clients in src/issuer/*, without editing them):
//   backed (xStocks) — the multiplier endpoint answers and knows the symbol: currentMultiplier is present
//                      (same as in fetchCurrentMultiplier, Solana network);
//   prestocks        — /metadata/<symbol>.json metadata: symbol in the payload matches the
//                      registry entry case-insensitively (the check is done by fetchTokenMetadata itself);
//   tessera          — cdn metadata cdn.tesseralab.co/tessera/<lowercased-symbol>.json:
//                      symbol in the payload is compared with the registry entry case-insensitively over
//                      the alphanumeric skeleton (T-SpaceX vs tSpaceX — the check is done by
//                      fetchTokenMetadata itself from src/issuer/tessera.mjs);
//   backpack         — no public API: status skipped/no-source, the client is NOT invented.
//
// Deliberate decisions:
// - A network failure is NOT a divergence from the issuer: status skipped, not fail. fail = a
//   confirmed divergence only (404 — the asset was removed, a foreign symbol — re-issued/changed,
//   a broken payload — the source is broken). A total network outage yields exit 0 with zero ok:
//   the audit honestly says "could not check", not "everything diverged".
// - Requests go sequentially with a throttleMs pause (politeness toward public APIs);
//   skipped tokens (backpack) make no requests and spend no pause.
// - Everything through an injectable fetcher (default the global fetch) — tests run without network.
// - The report row carries mint: the registry is keyed on mints, the symbol is not a unique key.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { fetchCurrentMultiplier, IssuerError } from "../src/issuer/xstocks.mjs";
import { fetchTokenMetadata as fetchPrestocksMetadata } from "../src/issuer/prestocks.mjs";
import { fetchTokenMetadata as fetchTesseraMetadata } from "../src/issuer/tessera.mjs";

const XSTOCKS_BASE = "https://api.xstocks.fi/api/v2/public/assets";
const PRESTOCKS_BASE = "https://prestocks.com/metadata";
const TESSERA_BASE = "https://cdn.tesseralab.co/tessera";

const DEFAULT_THROTTLE_MS = 1500;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

class UsageError extends Error {}

const USAGE = `usage: node scripts/check-issuers.mjs [flags]
  --json                JSON report {results, summary} only, in stdout
  --registry <path>     path to the registry (default data/tokens.json)
  --throttle-ms <ms>    pause between HTTP requests (default 1500)
  -h, --help            this help
Exit codes: 0 — no confirmed divergences, 1 — there is a fail, 2 — launch/read error.`;

// The GET+JSON stub is gone: tessera is now checked by the client src/issuer/tessera.mjs,
// all three sources have their own clients with the same error classes.

// URL builders mirror the clients — for the report (which endpoint was checked).
const xstocksMultiplierUrl = (symbol, network) =>
  `${XSTOCKS_BASE}/${encodeURIComponent(symbol)}/multiplier?network=${encodeURIComponent(network)}`;
const prestocksMetadataUrl = (symbol) =>
  `${PRESTOCKS_BASE}/${encodeURIComponent(symbol.toLowerCase())}.json`;
const tesseraMetadataUrl = (symbol) =>
  `${TESSERA_BASE}/${encodeURIComponent(symbol.toLowerCase())}.json`;

/**
 * Check one registry token against its issuer's source.
 * A network failure -> skipped (could not check), everything else -> fail (divergence).
 * @returns {Promise<{mint: string, symbol: string, issuer: string, status: "ok"|"skipped"|"fail", reason: string|null, url: string|null}>}
 */
export async function checkToken(token, { fetcher = fetch, network = "Solana" } = {}) {
  const base = { mint: token.mint, symbol: token.symbol, issuer: token.issuer };
  try {
    switch (token.issuer) {
      case "backed": {
        const url = xstocksMultiplierUrl(token.symbol, network);
        const m = await fetchCurrentMultiplier(token.symbol, network, { fetcher });
        // "The source knows the symbol" = currentMultiplier present and numeric.
        if (m.currentMultiplier === null) throw new IssuerError(`currentMultiplier missing for ${token.symbol}`);
        return { ...base, status: "ok", reason: null, url };
      }
      case "prestocks": {
        const url = prestocksMetadataUrl(token.symbol);
        await fetchPrestocksMetadata(token.symbol, { fetcher }); // the client does the symbol check
        return { ...base, status: "ok", reason: null, url };
      }
      case "tessera": {
        const url = tesseraMetadataUrl(token.symbol);
        await fetchTesseraMetadata(token.symbol, { fetcher }); // the client does the symbol check
        return { ...base, status: "ok", reason: null, url };
      }
      case "backpack":
        // No public API (registry sourceUrl says "stockbasis-verified") — an honest skip.
        return { ...base, status: "skipped", reason: "no-source", url: null };
      default:
        throw new IssuerError(`unknown issuer: ${JSON.stringify(token.issuer)} — no source to reconcile against`);
    }
  } catch (err) {
    // Client convention: network arrives as a "network: ..." string — that is skipped.
    const status = /^network:/.test(String(err?.message)) ? "skipped" : "fail";
    return { ...base, status, reason: String(err?.message ?? err), url: null };
  }
}

/**
 * Sequential reconciliation of the whole registry with a throttle between REAL requests
 * (skipped tokens make no requests and spend no pause).
 * @param {Array<{mint: string, symbol: string, issuer: string}>} tokens
 */
export async function checkRegistry(
  tokens,
  { fetcher = fetch, sleep = defaultSleep, throttleMs = DEFAULT_THROTTLE_MS, network = "Solana" } = {},
) {
  const results = [];
  let requests = 0;
  for (const token of tokens) {
    if (token.issuer === "backpack") {
      results.push(await checkToken(token, { fetcher, network }));
      continue;
    }
    if (requests > 0) await sleep(throttleMs);
    requests += 1;
    results.push(await checkToken(token, { fetcher, network }));
  }
  return results;
}

export function buildSummary(results) {
  const count = (s) => results.filter((r) => r.status === s).length;
  return {
    total: results.length,
    ok: count("ok"),
    skipped: count("skipped"),
    fail: count("fail"),
    clean: count("fail") === 0,
  };
}

export function parseArgs(argv) {
  const opts = { json: false, help: false, registry: "data/tokens.json", throttleMs: DEFAULT_THROTTLE_MS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "-h" || arg === "--help") opts.help = true;
    else if (arg === "--registry") {
      const value = argv[++i];
      if (value === undefined) throw new UsageError("--registry requires a path");
      opts.registry = value;
    } else if (arg === "--throttle-ms") {
      const value = argv[++i];
      if (value === undefined) throw new UsageError("--throttle-ms requires a number of milliseconds");
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) throw new UsageError(`--throttle-ms: expected an integer >= 0, got "${value}"`);
      opts.throttleMs = n;
    } else {
      throw new UsageError(`unknown flag: ${arg}`);
    }
  }
  return opts;
}

function printHuman(registryPath, results, summary) {
  console.log("[check-issuers] reconciling the registry against issuer sources (read-only)");
  console.log(`[check-issuers] registry: ${path.resolve(registryPath)}; tokens: ${results.length}`);
  for (const r of results) {
    const mark = r.status === "ok" ? "ok     " : r.status === "skipped" ? "skipped" : "FAIL   ";
    const detail =
      r.status === "ok" ? "source responds, symbol is known" : r.reason;
    console.log(`  [${mark}] ${r.symbol} (${r.issuer}): ${detail}`);
  }
  const verdict = summary.clean
    ? "no confirmed divergences"
    : "there are divergences — reconcile manually!";
  console.log(`[check-issuers] TOTAL: ok=${summary.ok}, skipped=${summary.skipped}, fail=${summary.fail} — ${verdict}`);
}

// Returns the exit code (0/1/2), writes nothing to files.
export async function main(argv = []) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`[check-issuers] ${err.message}`);
    console.error(USAGE);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  let tokens;
  try {
    tokens = JSON.parse(readFileSync(opts.registry, "utf8"));
  } catch (err) {
    console.error(`[check-issuers] registry ${opts.registry} is unreadable: ${err.message}`);
    return 2;
  }
  if (!Array.isArray(tokens)) {
    console.error(`[check-issuers] registry ${opts.registry}: expected an array of tokens`);
    return 2;
  }
  const results = await checkRegistry(tokens, { fetcher: fetch, sleep: defaultSleep, throttleMs: opts.throttleMs });
  const summary = buildSummary(results);
  if (opts.json) console.log(JSON.stringify({ results, summary }, null, 2));
  else printHuman(opts.registry, results, summary);
  return summary.clean ? 0 : 1;
}

// CLI mode only when run directly (tests import the functions without side effects).
const invokedAs = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
const isSelf =
  import.meta.url === invokedAs ||
  (process.platform === "win32" && import.meta.url.toLowerCase() === invokedAs.toLowerCase());
if (isSelf) process.exitCode = await main(process.argv.slice(2)); // exitCode, not exit: (undici crash)
