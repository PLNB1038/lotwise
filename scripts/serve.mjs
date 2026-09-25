// Run the Lotwise API on live data: registry + xStocks multiplier history + on-chain plan.
// Usage: node scripts/serve.mjs [--port 8787] [--host 127.0.0.1] [--rpc URL] [--max-txs 300]
import { loadRegistrySafe, assertBootableRegistrySize } from "../src/registry/registry.mjs";
import { loadDeclarationsFile } from "../src/events/declarations-file.mjs";
import { fetchMultiplierHistory } from "../src/issuer/xstocks.mjs";
import { multiplierHistoryToEvents, bindMintAndValidate } from "../src/events/normalize-xstocks.mjs";
import { createApiServer } from "../src/api/server.mjs";
import { RpcClient } from "../src/ingest/rpc.mjs";
import { parseScaledUiAmount } from "../src/issuer/scaled-ui.mjs";
import { scanWallet } from "../src/wallet/scan.mjs";
import { GeckoTerminalClient } from "../src/price/geckoterminal.mjs";
import { planJournalStep, issuerChainComplete, bootJournalOnchain, persistJournalOnBoot, sweepStaleTmpFiles } from "../src/events/journal.mjs";
import { parseServeArgs, ServeArgsError, assertHostResolvable, checkPortAvailable, envPositiveInt as envPositiveIntShared } from "../src/cli/flags.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// data paths are anchored at the SCRIPT'S OWN location, not CWD : a wrong unit
// WorkingDirectory used to yield a "healthy" empty server (tokens:0, corrupted:0) with the
// journal under someone else's directory; the systemd WorkingDirectory contract must not be the only guard.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Flag guards BEFORE any I/O : --port abc used to survive the whole boot
// (minutes of RPC quota) and fail only at listen, and a trailing --rpc silently
// killed the env fallback. The parser is src/cli/flags.mjs, covered by tests.
let args;
try {
  args = parseServeArgs(process.argv.slice(2));
} catch (err) {
  if (err instanceof ServeArgsError) {
    console.error(`[serve] ${err.message}`);
    process.exit(1);
  }
  throw err;
}
const { port, host, maxTxs } = args;
// RPC: --rpc flag (dev quotas) → env LOTWISE_RPC_URL (prod: the key must NOT
// stick out in the process cmdline — it is visible in ps to the whole container — nor in the log banner).
const rpcUrl = args.rpcUrl;
// mask for the banner: origin only — the api-key in the query does not leak into serve.log/journal
const rpcDisplay = (() => {
  try {
    return new URL(rpcUrl).origin;
  } catch {
    return "(malformed rpc url)";
  }
})();

// DNS-resolve the host before boot I/O — a garbage --host used to survive the whole boot
// (registry+journal+RPC quota) and die only at listen with a cryptic ENOTFOUND.
try {
  await assertHostResolvable(host);
} catch (err) {
  if (err instanceof ServeArgsError) {
    console.error(`[serve] ${err.message}`);
    process.exit(1);
  }
  throw err;
}

// a busy port also fails BEFORE boot: EADDRINUSE was caught only at listen
// after a full boot, and a double launch burned RPC quota for a one-second refusal.
try {
  await checkPortAvailable(port, host);
} catch (err) {
  if (err instanceof ServeArgsError) {
    console.error(`[serve] ${err.message}`);
    process.exit(1);
  }
  throw err;
}

// Registry: a truncated data/tokens.json (write interrupted mid-enrich window)
// used to kill the whole process — RegistryError at top level without catch → unhandled
// rejection, no degraded mode, no "corrupted"-class diagnostics,
// LW2_tokens_json_write_non_atomic). Journal pattern: corruption is an explicit state,
// the evidence is kept nearby, boot continues on an empty registry; the flag goes into /health.
const loadedRegistry = await loadRegistrySafe(path.join(ROOT, "data", "tokens.json"));
const registry = loadedRegistry.registry;
// a runaway (glued/merged) registry would boot for hours before
// listening — a loud refusal up front, before any RPC quota is spent.
assertBootableRegistrySize(registry);
if (!loadedRegistry.ok) {
  console.error(
    `[serve] REGISTRY NOT LOADED (${loadedRegistry.reason}). ` +
    `Starting with an empty registry: the vitrine and the scanner see no tokens — ` +
    `after data/tokens.json is restored, a restart brings everything back.` +
    (loadedRegistry.backup ? ` Corrupted file kept nearby: ${loadedRegistry.backup}` : ""),
  );
}
const registryStats = { corrupted: loadedRegistry.corrupted ? 1 : 0 };

const events = [];

// operator-supplied dividend declarations — the only channel that feeds
// DIVIDEND_ACCRUAL into the live store (xStocks publishes no per-unit amounts). Read-only
// file: a broken one degrades to "no accruals" with a loud reason, never a dead boot.
const loadedDeclarations = loadDeclarationsFile(path.join(ROOT, "data", "declarations.json"), registry);
// superseded — corrections applied at load (the `supersedes` field): visible in /health,
// so a feed silently re-declaring dividends cannot hide behind a bare "loaded" count
const declarationsStats = { loaded: loadedDeclarations.loaded, ok: loadedDeclarations.ok ? 1 : 0, superseded: loadedDeclarations.superseded };
if (!loadedDeclarations.ok) {
  console.error(`[serve] DECLARATIONS NOT LOADED (${loadedDeclarations.reason}). Booting without dividend accruals — fix data/declarations.json and restart.`);
} else if (loadedDeclarations.loaded > 0) {
  console.log(`[serve] declarations: ${loadedDeclarations.loaded} DIVIDEND_ACCRUAL event(s) from data/declarations.json` + (loadedDeclarations.superseded > 0 ? ` (${loadedDeclarations.superseded} superseded correction(s) applied)` : ""));
}
events.push(...loadedDeclarations.events);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpcForJournal = new RpcClient({ endpoint: rpcUrl });

// On-chain journal: PreStocks/Backpack have no issuer API history — their corporate events
// live right in the mint (scaledUiAmountConfig). Backfill on first observation,
// then diff against the previous effective value. Live findings 19.09: SPACEX ×5 (10.06),
// OPENAI ×1.4861347 (17.07). The journal is runtime state, recoverable from the chain.
const journalPath = path.join(ROOT, "data", "onchain-journal.json");
// A broken journal file is NOT a "first run": truncated JSON after an interrupted
// write used to silently yield journal={}, and the whole event history was lost beyond recovery,
// while /health showed the journal healthy. Now the state is distinguishable: the corrupted flag
// goes into /health, the damaged file is kept as evidence until the first overwrite,
// the process does NOT crash (same principle as isolating poisoned records in.
// if the evidence could NOT be
// preserved (preserveFailed), boot runs read-only — the final journal write
// is forbidden in this boot, otherwise it would clobber the corrupted original, the only
// copy of the history. A restart after the locking process (AV/indexer) goes away will
// preserve the evidence normally and re-enable writes.
const journalBoot = bootJournalOnchain(journalPath);
// kill -9 debris (ancient .tmp files) is swept once at boot —
// nothing else ever cleaned them (18.6 MB after ten kill cycles in the round-24 repro)
{
  const sweptTmp = sweepStaleTmpFiles(journalPath);
  if (sweptTmp > 0) console.log(`[serve] journal boot: swept ${sweptTmp} stale .tmp file(s) left by killed writers`);
}
let journal = journalBoot.journal;
const journalCorrupted = journalBoot.corrupted;
const journalReadOnly = journalCorrupted && journalBoot.preserveFailed;
if (journalCorrupted) {
  console.error(
    `[serve] JOURNAL CORRUPTED, not loaded (${journalBoot.reason}). ` +
    `Starting with an empty journal: backfill will recover only rotations visible as live pending; ` +
    `for tokens with a completed rotation the multiplier history is unrecoverable — the vitrine will show 1. ` +
    (journalBoot.backup
      ? `Corrupted file kept nearby: ${journalBoot.backup}`
      : `COULD NOT PRESERVE THE EVIDENCE, the corrupted original is in place — the journal is read-only until restart: no final write will happen in this boot`),
  );
}
let journalReplayed = 0;
let journalUnavailable = 0;
for (const t of registry.filter((x) => x.issuer !== "backed")) {
  const priorEntry = journal[t.mint] ?? null;
  let parsed = null;
  try {
    const raw = await rpcForJournal.call("getAccountInfo", [t.mint, { encoding: "jsonParsed", commitment: "confirmed" }]);
    parsed = parseScaledUiAmount(raw.value);
  } catch (err) {
    console.warn(`[serve] ${t.symbol}: on-chain journal unavailable (${err.message}) — fail-closed`);
  }
  // Per-token isolation: a broken mint (corrupt journal cache, validation refusal) must not
  // kill the whole boot — a poisoned record used to persist and the process crashed on every
  // restart. Skip the token with a warn, the server comes up on the rest.
  try {
    const { replay, event, entry, chain, unavailableV1 } = planJournalStep(t, priorEntry, parsed);
    if (chain === "unavailable") journalUnavailable++;
    if (entry !== null) journal[t.mint] = entry;
    // a process restart must NOT lose already-emitted events: replay from the journal
    if (replay.length > 0) {
      events.push(...bindMintAndValidate(replay, t.mint));
      journalReplayed += replay.length;
      if (chain === "unavailable") {
        console.log(`[serve] ${t.symbol}: replayed ${replay.length} events from the journal cache (chain unavailable — plan stale, observedAt honest)`);
      }
    }
    if (entry && entry.lastEffective !== "1" && entry.events.length === 0) {
      console.warn(`[serve] ${t.symbol}: multiplier ${entry.lastEffective} with no journal history — the from-value cannot be honestly recovered, we do not invent an event`);
    }
    if (unavailableV1) {
      // v1 record (no events) + unavailable chain: without this warn the vitrine would silently show 1
      console.warn(`[serve] ${t.symbol}: journal record v1 (multiplier ${priorEntry.lastEffective}) without events and the chain is unavailable — migration deferred, the vitrine will show 1 until the chain returns`);
    }
    if (event) {
      events.push(...bindMintAndValidate([event], t.mint));
      console.log(`[serve] ${t.symbol}: on-chain event ${event.multiplierFrom} -> ${event.multiplierTo} @ ${event.effectiveDate.slice(0, 10)}`);
    }
  } catch (err) {
    console.warn(`[serve] ${t.symbol}: on-chain journal step failed (${err.message}) — token skipped, the server comes up on the rest`);
  }
  await sleep(200);
}
// Final journal write — the single write point (persistJournalOnBoot).
// In read-only mode (evidence could not be preserved) the write is NOT performed: the corrupted
// original outlives the boot until restart.
const journalSaved = persistJournalOnBoot(journalPath, journal, { preserveFailed: journalReadOnly });
if (journalSaved.readonly) {
  console.error("[serve] journal not written (read-only until restart): this session's events live only in memory, /health.journal.preserveFailed=1");
} else if (!journalSaved.written) {
  console.warn(`[serve] journal not saved (${journalSaved.error.message}) — this session's events live in memory`);
}

// xStocks: fetch the history per symbol (the Ethereum plan carries the full events,
// the Solana endpoint does not backfill history — verified 18.09). Pagination with a cap:
// only page 0 (25 nodes) used to be taken — for a token past its 26th dividend the oldest
// node of the page did not start from "1", and the timeline threw TimelineError at the start
// (the same boot-loop as with the on-chain journal).
const HISTORY_MAX_PAGES = 10;
for (const t of registry.filter((x) => x.issuer === "backed")) {
  try {
    const nodes = [];
    let hasNextPage = true;
    for (let page = 0; page < HISTORY_MAX_PAGES && hasNextPage; page++) {
      if (page > 0) await sleep(300); // politeness toward the public API and between pages
      const h = await fetchMultiplierHistory(t.symbol, "Ethereum", { page });
      nodes.push(...h.nodes);
      hasNextPage = h.hasNextPage;
    }
    // Honest completeness check: the oldest collected node must start from "1",
    // otherwise the timeline will not build. An incomplete history is not fed in — warn, not crash.
    const chain = issuerChainComplete(nodes);
    if (!chain.complete) {
      console.warn(`[serve] ${t.symbol}: issuer history incomplete (${chain.reason}) — events are not fed to the timeline`);
      continue;
    }
    if (nodes.length > 0) {
      events.push(...bindMintAndValidate(multiplierHistoryToEvents(nodes, { symbol: t.symbol, network: "Ethereum" }), t.mint));
      console.log(`[serve] ${t.symbol}: ${nodes.length} multiplier events`);
    }
  } catch (err) {
    console.warn(`[serve] ${t.symbol}: source unavailable (${err.message}) — skipping, fail-closed`);
  }
  await sleep(300); // politeness toward the public API
}

// Shared cache runner: TTL + dedup of concurrent calls (the same pattern
// for the on-chain reader, the wallet scanner and the price provider — extracted into a helper)
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200; // keys are arbitrary (wallet addresses) — without a cap the map grows forever
const cached = (label) => {
  const store = new Map(); // key -> { at, data }
  const inflight = new Map(); // key -> Promise
  const remember = (key, data) => {
    store.set(key, { at: Date.now(), data });
    // evict the oldest entry by at once the cap is exceeded
    if (store.size > CACHE_MAX_ENTRIES) {
      let oldestKey = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [k, v] of store) {
        if (v.at < oldestAt) {
          oldestAt = v.at;
          oldestKey = k;
        }
      }
      if (oldestKey !== null) store.delete(oldestKey);
    }
  };
  return (key, fn) => {
    const hit = store.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.data);
    if (!inflight.has(key)) {
      inflight.set(
        key,
        Promise.resolve()
          .then(fn)
          .then((data) => {
            remember(key, data);
            return data;
          })
          .finally(() => inflight.delete(key)),
      );
    }
    return inflight.get(key);
  };
};

// On-chain plan (Scaled UI Amount): public RPC, 10-minute cache per mint —
// the vitrine hits /onchain on every token selection, and public RPC quota is finite
const rpc = new RpcClient({ endpoint: rpcUrl });
const onchainCached = cached("onchain");

const onchainReader = (mint) =>
  onchainCached(mint, () =>
    rpc
      .call("getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "confirmed" }])
      .then((result) => parseScaledUiAmount(result.value)),
  );

// Wallet scan: expensive (a getTransaction per transaction, ~350ms on public RPC)
const walletCached = cached("wallet");

const walletScanner = (address, { signal } = {}) =>
  walletCached(address, () => {
    console.log(`[serve] wallet scan ${address} (cap ${maxTxs} signatures)`);
    return scanWallet(rpc, address, registry, {
      maxTxs,
      signal,
      onProgress: ({ fetched, total }) => {
        if (fetched % 25 === 0 || fetched === total) console.log(`[serve] ${address}: ${fetched}/${total}`);
      },
    }).then((scan) => {
      console.log(`[serve] ${address}: done — ${scan.txs.length} relevant txs out of ${scan.fetched}`);
      return scan;
    });
  });

// Prices (GeckoTerminal): mint pool + daily candles, both cached 10 minutes
const gt = new GeckoTerminalClient();
const poolCached = cached("pool");
const candlesCached = cached("candles");

const priceProvider = {
  pool: (mint) => poolCached(mint, () => gt.bestBasePool(mint)),
  candles: (poolAddress) => candlesCached(poolAddress, () => gt.dailyCandles(poolAddress)),
};

// Rate limits for expensive endpoints per client IP (see src/api/ratelimit.mjs):
// the demo is public through the funnel, RPC quota is finite; XFF is trusted — the only
// public path to the port is the funnel, direct connections only come from the tailnet
const envPositiveInt = envPositiveIntShared; // loud fallback, moved to src/cli/flags.mjs
const rateLimits = {
  scan: { windowMs: 60_000, max: envPositiveInt("RATE_LIMIT_SCAN_PER_MIN", 12) }, // /lots, /accruals
  rpc: { windowMs: 60_000, max: envPositiveInt("RATE_LIMIT_RPC_PER_MIN", 60) }, // /onchain, /crosscheck
};

let server;
try {
  server = await createApiServer({
    registry, events, port, host, onchainReader, walletScanner, priceProvider, rateLimits, trustProxy: true,
    journalStats: {
      replayed: journalReplayed,
      unavailable: journalUnavailable,
      corrupted: journalCorrupted ? 1 : 0,
      preserveFailed: journalReadOnly ? 1 : 0, // read-only boot: no final journal write happened
      // a failed write (disk full/EBUSY) — boot events live only in memory,
      // /health must show it, monitoring must not treat the journal as healthy
      saveFailed: !journalSaved.written && !journalSaved.readonly ? 1 : 0,
    },
    registryStats, // { corrupted: 0|1 } — /health contract: registry.corrupted (see the report)
    declarationsStats,
  });
} catch (err) {
  console.error(`[serve] failed to come up on port ${port}: ${err.code ?? err.message}`);
  process.exit(1);
}
// the banner uses the ACTUAL server.address() binding, not the hardcoded
// 127.0.0.1: on win "--host localhost" listens on [::1] only, and the old banner lied about
// http://127.0.0.1 — you follow the banner and get ECONNREFUSED.
const bound = server.address();
const boundHost = bound.family === "IPv6" ? `[${bound.address}]` : bound.address;
console.log(`\n[serve] Lotwise API: http://${boundHost}:${bound.port}`);
console.log(`[serve] vitrine: http://${boundHost}:${bound.port}/`);
console.log(`[serve] tokens: ${registry.length}, events: ${events.length}, on-chain RPC: ${rpcDisplay}`);
console.log(`[serve] rate limits (per IP): ${rateLimits.scan.max}/min wallet scans, ${rateLimits.rpc.max}/min on-chain/prices (env: RATE_LIMIT_SCAN_PER_MIN, RATE_LIMIT_RPC_PER_MIN)`);
console.log(`[serve] try: / | /health | /events?symbol=SPYx | /multiplier?symbol=SPYx&date=2026-07-01 | /onchain?symbol=SPYx | /lots?address=<wallet> | /crosscheck?symbol=SPYx`);
