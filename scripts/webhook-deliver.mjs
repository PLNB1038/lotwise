// webhook-deliver — CLI to deliver events to webhook subscriptions. The only
// executable webhook layer: the API server itself is strictly GET-only (405 on non-GET
// pinned by tests), and it has no subscribe/deliver routes and never will —
// delivery is initiated by the operator/cron with this command.
//
// Run from the repo root:
//   node scripts/webhook-deliver.mjs --events data/events.json
//   cat data/events.json | node scripts/webhook-deliver.mjs
// Flags:
//   --subscriptions <path>  subscriptions file (default data/webhooks.json;
//                           the file may be absent — then there are no recipients, everything is skipped)
//   --events <path>         file with an array of canonical events; no flag — stdin
//   --json                  JSON report only {delivered, skipped, failed, deliveries, warnings}
//   -h, --help              help
// Exit codes: 0 — no failed deliveries (failed=0; "nobody to deliver to" is not a failure),
// 1 — there are failures (retries exhausted without a 2xx), 2 — launch/read error (broken files,
// invalid events/subscriptions, unknown flag).
//
// Deliberate decisions:
// - Network and pauses are extracted into injectable deps main(argv, {fetcher, sleep}) —
//   tests run "all retries exhausted" scenarios with no network and no 1s/4s pauses;
//   spawnSync tests cover only the no-network paths (usage, reading, skipped).
// - The report is printed AFTER all delivery: the process does not mix progress with the verdict.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_SUBSCRIPTIONS_PATH,
  deliverToAll,
  listSubscriptions,
  SubscriptionError,
} from "../src/webhooks/subscriptions.mjs";
import { EventValidationError } from "../src/schema/events.mjs";
import { loadRegistry } from "../src/registry/registry.mjs";

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

class UsageError extends Error {}

const USAGE = `usage: node scripts/webhook-deliver.mjs [flags]
  --subscriptions <path>  subscriptions file (default ${DEFAULT_SUBSCRIPTIONS_PATH})
  --events <path>         file with an array of events; no flag — stdin
  --json                  JSON report only {delivered, skipped, failed, deliveries, warnings}
  -h, --help              this help
Exit codes: 0 — no failed deliveries, 1 — there are failures, 2 — launch/read error.`;

export function parseArgs(argv) {
  const opts = { json: false, help: false, subscriptions: DEFAULT_SUBSCRIPTIONS_PATH, events: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "-h" || arg === "--help") opts.help = true;
    else if (arg === "--subscriptions") {
      const value = argv[++i];
      if (value === undefined) throw new UsageError("--subscriptions requires a path");
      opts.subscriptions = value;
    } else if (arg === "--events") {
      const value = argv[++i];
      if (value === undefined) throw new UsageError("--events requires a path (or - for stdin)");
      opts.events = value; // "-" = stdin, as in classic utilities
    } else {
      throw new UsageError(`unknown flag: ${arg}`);
    }
  }
  return opts;
}

function readEvents(opts) {
  let raw;
  if (opts.events === null || opts.events === "-") {
    raw = readFileSync(0, "utf8"); // stdin: empty pipe = empty list — an honest no-op
  } else {
    raw = readFileSync(opts.events, "utf8");
  }
  let parsed;
  try {
    // empty/whitespace stdin — an honest empty list (no-op), not a launch error (wave D2)
    parsed = raw.trim() === "" ? [] : JSON.parse(raw);
  } catch (err) {
    throw new Error(`events do not parse: ${err.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error("events must be an array of canonical events");
  return parsed;
}

function printHuman(report) {
  console.log("[webhook-deliver] delivering events to subscriptions");
  console.log(
    `[webhook-deliver] TOTAL: delivered=${report.delivered}, skipped=${report.skipped}, failed=${report.failed}`,
  );
  for (const w of report.warnings) console.log(`[webhook-deliver]   ... ${w}`);
}

/**
 * Returns the exit code (0/1/2). Network/pauses are injectable — tests run without network.
 * @param {string[]} argv
 * @param {{fetcher?: Function, sleep?: Function}} [deps]
 */
export async function main(argv = [], { fetcher = fetch, sleep = defaultSleep } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`[webhook-deliver] ${err.message}`);
    console.error(USAGE);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  let events;
  try {
    events = readEvents(opts);
  } catch (err) {
    console.error(`[webhook-deliver] events: ${err.message}`);
    return 2;
  }
  let subs;
  try {
    // listSubscriptions from the module: no file = [] (nobody to deliver to, not an error),
    // a broken file/invalid record — SubscriptionError → exit 2, the store is not touched.
    subs = listSubscriptions(opts.subscriptions);
  } catch (err) {
    console.error(`[webhook-deliver] subscriptions: ${err.message}`);
    return 2;
  }
  // Wave I2 (integrator): the registry resolves subscription symbols — canonical
  // events carry only mint, so a ["SPYx"] subscription without the map silently delivered
  // nothing. Paths are relative to CWD, like --subscriptions. A missing/broken registry — warning
  // and matching without the map (previous behavior), not a delivery refusal.
  let symbolToMint = null;
  try {
    const registry = await loadRegistry("data/tokens.json");
    symbolToMint = new Map(registry.map((t) => [t.symbol, t.mint]));
  } catch (err) {
    console.warn(`[webhook-deliver] registry not loaded (${err.message}) — symbol subscriptions match only against events carrying symbol/newSymbol`);
  }
  let report;
  try {
    report = await deliverToAll(events, subs, { fetcher, sleep, symbolToMint });
  } catch (err) {
    // A schema-invalid event is an input problem, not a delivery problem.
    const what = err instanceof EventValidationError || err instanceof SubscriptionError ? "events are invalid" : "delivery wrecked";
    console.error(`[webhook-deliver] ${what}: ${err.message}`);
    return 2;
  }
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
  return report.failed === 0 ? 0 : 1;
}

// CLI mode only when run directly (tests import main without side effects).
const invokedAs = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
const isSelf =
  import.meta.url === invokedAs ||
  (process.platform === "win32" && import.meta.url.toLowerCase() === invokedAs.toLowerCase());
// process.exitCode instead of process.exit (wave D2): exit over live undici sockets
// crashed the process AFTER a successful report (0xC0000409 on win, code 127) — 0/1/2 contract
if (isSelf) process.exitCode = await main(process.argv.slice(2));
