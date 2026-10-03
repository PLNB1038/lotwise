// Run the Lotwise API on live data: registry + xStocks multiplier history + on-chain plan.
// Usage: node scripts/serve.mjs [--port 8787] [--host 127.0.0.1] [--rpc URL] [--max-txs 300] [--demo]
// --demo (src/events/demo-snapshot.mjs): boot the static demonstration set instead — all six
// event types on fictional tokens, zero network, zero live claims; /health and the vitrine
// banner mark the mode. Without the flag the boot is bit-for-bit the live one. --demo and
// --rpc refuse each other (the demo never dials out); -h/--help prints the full grammar.
import { loadRegistrySafe, assertBootableRegistrySize } from "../src/registry/registry.mjs";
import { loadDeclarationsFile } from "../src/events/declarations-file.mjs";
import { buildDemoSnapshot, DEMO_SNAPSHOT_AS_OF } from "../src/events/demo-snapshot.mjs";
import { fetchMultiplierHistory } from "../src/issuer/xstocks.mjs";
import { multiplierHistoryToEvents, bindMintAndValidate } from "../src/events/normalize-xstocks.mjs";
import { createApiServer } from "../src/api/server.mjs";
import { RpcClient } from "../src/ingest/rpc.mjs";
import { parseScaledUiAmount } from "../src/issuer/scaled-ui.mjs";
import { scanWallet, unreadableSkips } from "../src/wallet/scan.mjs";
import { GeckoTerminalClient } from "../src/price/geckoterminal.mjs";
import { planJournalStep, issuerChainComplete, bootJournalOnchain, persistJournalOnBoot, sweepStaleTmpFiles } from "../src/events/journal.mjs";
import { parseServeArgs, ServeArgsError, assertHostResolvable, checkPortAvailable, envPositiveInt as envPositiveIntShared } from "../src/cli/flags.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// data paths are anchored at the SCRIPT'S OWN location, not CWD : a wrong unit
// WorkingDirectory used to yield a "healthy" empty server (tokens:0, corrupted:0) with the
// journal under someone else's directory; the systemd WorkingDirectory contract must not be the only guard.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// -h/--help: the full launch grammar on stdout, exit 0. The demo line names the freeze
// point of the static set — an operator scheduling the demo into a unit file sees how old
// the story is without reading the source (the same number /health carries).
const USAGE = `usage: node scripts/serve.mjs [flags]

  --port <n>     TCP port to listen on (default 8787)
  --host <addr>  bind address (default 127.0.0.1)
  --rpc <url>    Solana JSON-RPC endpoint (default: $LOTWISE_RPC_URL, else the public RPC);
                 refused together with --demo — the demo boot has no network
  --max-txs <n>  wallet-scan signature cap per source (default 300)
  --demo         static demonstration set, zero network (all six event types on fictional
                 tokens); the snapshot is frozen at ${DEMO_SNAPSHOT_AS_OF} — /health
                 carries demo.snapshotAsOf and the day age
  -h, --help     this help`;

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
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
const { port, host, maxTxs, demo } = args;
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

// Signals are handled from BEFORE the first await — installed synchronously, ahead of the
// pre-boot I/O below. They used to be installed only AFTER the DNS-resolve and port-probe
// awaits: a SIGTERM landing while those were still in flight (a hostname that resolves
// slowly, a busy port) hit the DEFAULT termination — the unit died mid-boot with exit 143
// and no line in the log explaining why. An operator stopping a slow boot gets a named
// line and a clean non-zero exit (systemd sees an honest failure; Restart=on-failure
// retries deliberately). Once startServer is up there is a server to drain, and it
// REPLACES these handlers with the graceful-drain pair — the two never run together.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.error(`[serve] ${sig} during boot — no server to drain yet, aborting before listen (exit 1)`);
    process.exit(1);
  });
}

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


// ---- boot state shared by the two paths ----
// The demo branch fills its own; the live branch assigns below. The readers stay null in
// demo mode: the routes answer the honest 503 "not configured" (a demo has no RPC, no
// scanner, no price provider — and must not pretend otherwise).
let registry;
let events = [];
let journalStats = null;
let registryStats = null;
let declarationsStats = null;
let onchainReader = null;
let walletScanner = null;
let priceProvider = null;

// Rate limits for expensive endpoints per client IP (see src/api/ratelimit.mjs):
// the demo is public through the funnel, RPC quota is finite; XFF is trusted — the only
// public path to the port is the funnel, direct connections only come from the tailnet.
// Both boots share them: a demo instance behind the same funnel needs the same guard.
const envPositiveInt = envPositiveIntShared; // loud fallback, moved to src/cli/flags.mjs
const rateLimits = {
  scan: { windowMs: 60_000, max: envPositiveInt("RATE_LIMIT_SCAN_PER_MIN", 12) }, // /lots, /accruals
  rpc: { windowMs: 60_000, max: envPositiveInt("RATE_LIMIT_RPC_PER_MIN", 60) }, // /onchain, /crosscheck
};

if (demo) {
  // DEMO MODE — the judge-facing boot: a live feed
  // shows a single event type, and a judge without RPC waits ~2 minutes for a degraded boot.
  // Here: the validated static set, no network at all, listening in milliseconds. The live
  // registry file is not even read — a demo instance must not mix fictional tokens with
  // tracked ones. buildDemoSnapshot validates first: a broken set refuses the boot loudly
  // (fail-closed, the same discipline as the flag guards above), it cannot come up serving
  // schema-invalid events.
  const snapshot = buildDemoSnapshot();
  registry = snapshot.registry;
  events = snapshot.events;
  console.log(`[serve] DEMO MODE (--demo): static demonstration set — ${registry.length} token(s), ${events.length} event(s), all six canonical types`);
  console.log(`[serve] demo: every source is the literal marker "lotwise-demo-snapshot" — no live issuer, on-chain or price claims; /health carries the demo mark`);
  // the story dates are fixed 2026 dates and the set does not chase the calendar (a moving
  // snapshot would not be a snapshot); what ages is NAMED instead — a judge a year later
  // reads the age off /health instead of discovering the staleness silently
  console.log(`[serve] demo: the snapshot is frozen at ${DEMO_SNAPSHOT_AS_OF} — /health demo.snapshotAgeDays tells how far it has aged`);
  await startServer({ demo: true, registry, events, rateLimits });
} else {

// Registry: a truncated data/tokens.json (write interrupted mid-enrich window)
// used to kill the whole process — RegistryError at top level without catch → unhandled
// rejection, no degraded mode, no "corrupted"-class diagnostics,
// LW2_tokens_json_write_non_atomic). Journal pattern: corruption is an explicit state,
// the evidence is kept nearby, boot continues on an empty registry; the flag goes into /health.
const loadedRegistry = await loadRegistrySafe(path.join(ROOT, "data", "tokens.json"));
registry = loadedRegistry.registry;
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
registryStats = { corrupted: loadedRegistry.corrupted ? 1 : 0 };

// operator-supplied dividend declarations — the only channel that feeds
// DIVIDEND_ACCRUAL into the live store (xStocks publishes no per-unit amounts). Read-only
// file: a broken one degrades to "no accruals" with a loud reason, never a dead boot.
const loadedDeclarations = loadDeclarationsFile(path.join(ROOT, "data", "declarations.json"), registry);
// superseded — corrections applied at load (the `supersedes` field): visible in /health,
// so a feed silently re-declaring dividends cannot hide behind a bare "loaded" count.
// decimalsDrift — declaration `decimals` disagreeing with the registry (tokens.json is the
// authority): the console.warn at load is invisible to API consumers and to an operator
// who does not watch boot logs, so the pairs ride into /health (an empty array = no drift;
// a refused file reports none). Drift is NOT unavailability — the file loads and accrues,
// ok stays 1 and the X-Declarations-Unavailable header stays silent.
declarationsStats = { loaded: loadedDeclarations.loaded, ok: loadedDeclarations.ok ? 1 : 0, superseded: loadedDeclarations.superseded, decimalsDrift: loadedDeclarations.decimalsDrift ?? [] };
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
// Boot reads must not outlive a deadline: an endpoint that accepts and never answers
// used to park the boot on undici's default transport timeout (300s, retried) — minutes
// to HOURS of silence before listen, past any systemd TimeoutStartSec, a start-timeout
// restart-loop on a half-dead node behind LOTWISE_RPC_URL. 10s per read bounds the
// silence; a deadline miss is treated as "endpoint down at boot" and REFUSES the boot
// (a loud, non-zero failure systemd can retry) instead of limping through 15 per-token
// warns into a degraded listen. Fast RPC errors keep the per-token fail-closed path.
const BOOT_RPC_DEADLINE_MS = 10_000;
// Boot milestones: with live sources a boot runs ~1.5 min and per-token lines appear only
// for events and warnings — a silent phase reads as a hang. One line per phase boundary,
// no per-token spam.
const onchainBoot = registry.filter((x) => x.issuer !== "backed");
console.log(`[serve] boot: on-chain mint state, ${onchainBoot.length} token(s)...`);
for (const t of onchainBoot) {
  const priorEntry = journal[t.mint] ?? null;
  let parsed = null;
  try {
    // boot-time point read, high lane: the journal loop must not queue behind a scan
    // backlog left over from a previous process (the RpcClient priority contract).
    // The deadline is the boot's own: it bounds a silent endpoint (see above) and is
    // invisible to the interactive scan path, which keeps its caller-driven signals.
    const raw = await rpcForJournal.call("getAccountInfo", [t.mint, { encoding: "jsonParsed", commitment: "confirmed" }], { priority: "high", signal: AbortSignal.timeout(BOOT_RPC_DEADLINE_MS) });
    parsed = parseScaledUiAmount(raw.value);
  } catch (err) {
    if (err?.kind === "timeout") {
      console.error(`[serve] RPC endpoint did not answer within ${BOOT_RPC_DEADLINE_MS}ms (getAccountInfo for ${t.symbol}) — the endpoint is unreachable at boot, refusing to listen degraded. Check LOTWISE_RPC_URL (${rpcDisplay}) and restart.`);
      process.exit(1);
    }
    console.warn(`[serve] ${t.symbol}: on-chain journal unavailable (${err.message}) — fail-closed`);
  }
  // Per-token isolation: a broken mint (corrupt journal cache, validation refusal) must not
  // kill the whole boot — a poisoned record used to persist and the process crashed on every
  // restart. Skip the token with a warn, the server comes up on the rest.
  try {
    const { replay, event, entry, chain, unavailableV1 } = planJournalStep(t, priorEntry, parsed);
    if (chain === "unavailable") journalUnavailable++;
    // The journal slot is filled only AFTER validation: every event this step hands out
    // is bound and schema-checked FIRST. A validation failure used to land in the catch
    // below ("token skipped") with the entry already in the map — the final persist
    // rewrote the poison to disk forever. Nothing is assigned that has not passed the
    // same validation the events stream applies.
    const replayBound = replay.length > 0 ? bindMintAndValidate(replay, t.mint) : [];
    const eventBound = event !== null ? bindMintAndValidate([event], t.mint) : [];
    if (entry !== null) journal[t.mint] = entry;
    // a process restart must NOT lose already-emitted events: replay from the journal
    if (replayBound.length > 0) {
      events.push(...replayBound);
      journalReplayed += replayBound.length;
      if (chain === "unavailable") {
        console.log(`[serve] ${t.symbol}: replayed ${replayBound.length} events from the journal cache (chain unavailable — plan stale, observedAt honest)`);
      }
    }
    if (entry && entry.lastEffective !== "1" && entry.events.length === 0) {
      console.warn(`[serve] ${t.symbol}: multiplier ${entry.lastEffective} with no journal history — the from-value cannot be honestly recovered, we do not invent an event`);
    }
    if (unavailableV1) {
      // v1 record (no events) + unavailable chain: without this warn the vitrine would silently show 1
      console.warn(`[serve] ${t.symbol}: journal record v1 (multiplier ${priorEntry.lastEffective}) without events and the chain is unavailable — migration deferred, the vitrine will show 1 until the chain returns`);
    }
    if (eventBound.length > 0) {
      events.push(...eventBound);
      console.log(`[serve] ${t.symbol}: on-chain event ${event.multiplierFrom} -> ${event.multiplierTo} @ ${event.effectiveDate.slice(0, 10)}`);
    }
  } catch (err) {
    console.warn(`[serve] ${t.symbol}: on-chain journal step failed (${err.message}) — token skipped, the server comes up on the rest`);
  }
  await sleep(200);
}
console.log(`[serve] boot: on-chain journal done — ${journalReplayed} event(s) replayed, ${journalUnavailable} token(s) unavailable`);
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
const backedBoot = registry.filter((x) => x.issuer === "backed");
console.log(`[serve] boot: xStocks issuer history, ${backedBoot.length} token(s)...`);
let issuerEvents = 0;
for (const t of backedBoot) {
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
      issuerEvents += nodes.length;
      console.log(`[serve] ${t.symbol}: ${nodes.length} multiplier events`);
    }
  } catch (err) {
    console.warn(`[serve] ${t.symbol}: source unavailable (${err.message}) — skipping, fail-closed`);
  }
  await sleep(300); // politeness toward the public API
}
console.log(`[serve] boot: issuer history done — ${issuerEvents} multiplier event(s)`);

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

onchainReader = (mint) =>
  onchainCached(mint, () =>
    rpc
      // the vitrine's point read, high lane: this exact call used to stand in the
      // scan backlog's tail for minutes
      .call("getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "confirmed" }], { priority: "high" })
      .then((result) => parseScaledUiAmount(result.value)),
  );

// Wallet scan: expensive (a getTransaction per transaction, ~350ms on public RPC)
const walletCached = cached("wallet");

walletScanner = (address, { signal } = {}) =>
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
      // Skips used to be visible only in the response body (counts.skipped): a scan that
      // lost transactions to the network (a mid-body cut, exhausted retries) read in this
      // log as a clean "done" line. One aggregated line at scan end names them — how many
      // and why, never a per-tx flood. Failed-on-chain skips are routine chain reality
      // (log-level); unreadable ones are degradation (warn-level).
      const skipped = Array.isArray(scan.skipped) ? scan.skipped : [];
      if (skipped.length > 0) {
        const unreadable = unreadableSkips(scan);
        const line = `${address}: ${skipped.length} tx(s) skipped — ${skipped.length - unreadable.length} failed on-chain, ${unreadable.length} unreadable`;
        if (unreadable.length > 0) {
          console.warn(`[serve] ${line} (last: ${unreadable[unreadable.length - 1].reason})`);
        } else {
          console.log(`[serve] ${line}`);
        }
      }
      return scan;
    });
  });

// Prices (GeckoTerminal): mint pool + daily candles, both cached 10 minutes
const gt = new GeckoTerminalClient();
const poolCached = cached("pool");
const candlesCached = cached("candles");

priceProvider = {
  pool: (mint) => poolCached(mint, () => gt.bestBasePool(mint)),
  candles: (poolAddress) => candlesCached(poolAddress, () => gt.dailyCandles(poolAddress)),
};

// The journal stats of THIS boot, /health contract: journal.{replayed,unavailable,corrupted,
// preserveFailed,saveFailed}. Assembled here (after the persist decision) and handed to the
// shared tail; the demo boot passes journalStats: null — those sources were not part of it.
journalStats = {
  replayed: journalReplayed,
  unavailable: journalUnavailable,
  corrupted: journalCorrupted ? 1 : 0,
  preserveFailed: journalReadOnly ? 1 : 0, // read-only boot: no final journal write happened
  // a failed write (disk full/EBUSY) — boot events live only in memory,
  // /health must show it, monitoring must not treat the journal as healthy
  saveFailed: !journalSaved.written && !journalSaved.readonly ? 1 : 0,
};

await startServer({ demo: false, registry, events, journalStats, registryStats, declarationsStats, onchainReader, walletScanner, priceProvider, rateLimits });

} // end of the live boot

// The shared serve tail: create the API server, print the banner, hand the process to the
// graceful shutdown. The live boot and the --demo boot BOTH end here on purpose — the
// shutdown-drain semantics (the delayed exit, the repeated-signal escape) exist once and
// cannot drift between the modes. `demo` only reshapes the banner and the /health mark.
async function startServer({ demo = false, registry, events, journalStats = null, registryStats = null, declarationsStats = null, onchainReader = null, walletScanner = null, priceProvider = null, rateLimits }) {
let server;
try {
  server = await createApiServer({
    registry, events, port, host, onchainReader, walletScanner, priceProvider, rateLimits, trustProxy: true,
    accessLog: true, // one "[http] ip method path status ms ua" line per finished response — see who visits the demo
    journalStats, // null on a demo boot: /health shows nulls, the readers were not part of it
    registryStats, // { corrupted: 0|1 } — /health contract: registry.corrupted (see the report)
    declarationsStats,
    demo, // the /health demo mark (freeze point + age) and the vitrine banner — a demo instance must not pass for the live feed
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
console.log(`[serve] report page: http://${boundHost}:${bound.port}/`);
if (demo) {
  // no "on-chain RPC:" line in the demo banner — printing an RPC origin the server never
  // touches would advertise a source the mode does not have
  console.log(`[serve] tokens: ${registry.length}, events: ${events.length} (static demo set — not the live registry)`);
  console.log(`[serve] try: / | /health | /summary | /events?symbol=DEMOx | /events?symbol=DEMO2x | /multiplier?symbol=DEMOx&date=2026-09-01`);
} else {
  console.log(`[serve] tokens: ${registry.length}, events: ${events.length}, on-chain RPC: ${rpcDisplay}`);
  console.log(`[serve] try: / | /health | /events?symbol=SPYx | /multiplier?symbol=SPYx&date=2026-07-01 | /onchain?symbol=SPYx | /lots?address=<wallet> | /crosscheck?symbol=SPYx`);
}
console.log(`[serve] rate limits (per IP): ${rateLimits.scan.max}/min wallet scans, ${rateLimits.rpc.max}/min on-chain/prices (env: RATE_LIMIT_SCAN_PER_MIN, RATE_LIMIT_RPC_PER_MIN)`);

// SIGTERM (the systemd restart timer) and SIGINT used to kill the process outright:
// a wallet scan in flight died mid-RPC — minutes of pacing quota burned for nothing,
// the client saw a hard reset. The handler hands the process to server.shutdown: new
// connections are refused at once, the scan gets a 15s grace window (it either finishes
// — its client keeps the 200 — or is aborted), then the process exits ON ITS OWN.
// 15s + the handler overhead fits the unit's TimeoutStopSec=30 (see the deployment
// notes) — systemd's SIGKILL is the outer backstop, never the normal path.
const SHUTDOWN_DRAIN_MS = 15_000;
let stopping = false;
// the drain RESOLVED: the stop has already succeeded and exit(0) is scheduled in the
// 200ms response-flush grace below. A repeated signal inside that grace changes nothing
// about the outcome — it only shortens the tail.
let drainSettled = false;
const stop = () => {
  if (stopping) {
    if (drainSettled) {
      // a repeated signal AFTER a fully resolved drain is an impatient operator, not a
      // failure: the work is done, the responses are flushing, exit(0) is scheduled.
      // Leaving with 1 here would make systemd's Restart=on-failure restart a unit
      // that has just shut down cleanly.
      console.log("[serve] repeated signal after a completed drain — leaving now (exit 0)");
      return process.exit(0); // return: the branches stay exclusive even where exit is stubbed
    }
    // a REPEATED signal during the drain is an operator's "enough": leave now instead
    // of ignoring it for the rest of the window. The forced exit names itself — an
    // unexplained non-zero exit after "draining" reads as a crash in the journal.
    console.error("[serve] repeated signal during the drain — forced exit (1)");
    return process.exit(1);
  }
  stopping = true;
  console.log(`[serve] shutdown: draining (${server.isScanBusy() ? "scan active" : "idle"})`);
  server
    .shutdown({ drainMs: SHUTDOWN_DRAIN_MS })
    .catch((err) => console.error(`[serve] shutdown error: ${err?.message ?? err}`))
    // the exit is DELAYED: the drain-abort's 503 travels to the client through the
    // route's own async frames, and a synchronous exit(0) in this finally wins that
    // race — the client saw a bare connection reset where the contract promised a 503.
    // A short grace lets the response (and its access-log line) flush first.
    .finally(() => {
      drainSettled = true; // from here a repeated signal cannot turn the success into a failure
      setTimeout(() => process.exit(0), 200);
    });
};
// From here on there IS a server to drain: replace the early boot handlers with the
// graceful-shutdown pair. removeAllListeners first — process.on would ADD a second
// listener and both would fire on the same signal (the boot-abort one exits(1) while
// the drain one is still draining). The swap is synchronous, so no signal can land in
// between; from the first boot await up to this point the early pair owns the process.
process.removeAllListeners("SIGTERM");
process.removeAllListeners("SIGINT");
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
}
