// Unit pin of the serve.mjs shutdown exit (commit 1f6e3fe; the exit-grace refinement
// keeps the same extraction contract).
//
// scripts/serve.mjs is a top-level script with no exports, so the stop() logic cannot be
// imported. It IS self-contained text, though: the block from `const SHUTDOWN_DRAIN_MS`
// to `process.on("SIGINT", stop);` references only server / process / console / setTimeout.
// This pin extracts that exact block from the real file and evaluates it with INJECTED
// dependencies — a spy process (exit hook + signal registrar) and a capturing setTimeout —
// so the exit behavior is pinned without a real process.exit and without a child stand:
//
//   1. a signal starts the drain and does NOT exit synchronously (the pre-fix bug);
//   2. the exit is delayed via setTimeout(..., 200) scheduled in .finally, and the
//      captured timer fires exit(0) exactly once;
//   3. a REPEATED signal DURING the drain force-exits(1) immediately instead of being
//      ignored, does not start a second drain, and NAMES itself in the log (an unnamed
//      non-zero exit after "draining" is indistinguishable from a crash);
//   4. a repeated signal AFTER the drain fully resolved — inside the 200ms flush grace —
//      leaves with the already-scheduled exit(0), also named in the log: the stop is a
//      success, and exit(1) there would make Restart=on-failure restart a cleanly
//      stopped unit.
//
// The red proof at the bottom runs the same scenarios against the pre-fix source shape
// (synchronous exit in .finally, `if (stopping) return`) and asserts the pin FAILS it —
// a guard against a pin that cannot go red.
//
// Transfer-ready: the relative path ../scripts/serve.mjs resolves identically from
// test/ and from ad-hoc probe scripts outside it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SERVE = new URL("../scripts/serve.mjs", import.meta.url);
const ANCHOR_START = "const SHUTDOWN_DRAIN_MS";
const ANCHOR_END = 'process.on("SIGINT", stop);';


function extractShutdownBlock(source) {
  const start = source.indexOf(ANCHOR_START);
  assert.ok(start >= 0, `anchor not found in serve.mjs: ${ANCHOR_START}`);
  const end = source.indexOf(ANCHOR_END, start);
  assert.ok(end > start, `anchor not found in serve.mjs: ${ANCHOR_END}`);
  return source.slice(start, end + ANCHOR_END.length);
}

// Evaluate the block with injected deps; returns the spies.
// The parameter names shadow the globals — this is the injectable exit hook the source
// does not natively expose (no source edit needed).
function evaluateShutdownBlock(block) {
  const exits = [];
  const timers = [];
  const logs = [];
  const errors = [];
  const handlers = {};
  const detached = [];
  // exit TERMINATES: the code is recorded and every injected service goes dead —
  // the fallthrough after a real process.exit never executes, and the stubs must
  // model that (a throwing stub would turn the .finally-path exit into an
  // unhandled rejection that has no real-world counterpart)
  let terminated = false;
  const fakeProcess = {
    exit: (code) => { exits.push(code); terminated = true; },
    on: (signal, fn) => { handlers[signal] = fn; },
    // the early boot handlers (round 49) are detached right before the drain pair
    // is attached — the spy records the swap so the pin can hold it
    removeAllListeners: (signal) => { detached.push(signal); },
  };
  const fakeSetTimeout = (fn, ms) => {
    if (terminated) return 0;
    timers.push({ fn, ms });
    return timers.length;
  };
  const fakeConsole = {
    log: (...a) => { if (!terminated) logs.push(a.join(" ")); },
    error: (...a) => { if (!terminated) errors.push(a.join(" ")); },
  };
  const server = {
    isScanBusy: () => false,
    shutdownCalls: [],
    shutdown: (opts) => {
      if (terminated) return Promise.resolve();
      server.shutdownCalls.push(opts);
      return Promise.resolve();
    },
  };
  new Function("server", "process", "console", "setTimeout", block)(
    server, fakeProcess, fakeConsole, fakeSetTimeout,
  );
  return { exits, timers, logs, errors, handlers, detached, server };
}

const settle = () => new Promise((r) => setImmediate(r));

// The full green scenario; returns the collected violations (empty = the pin holds).
async function scenario(block) {
  const v = [];
  const check = (cond, msg) => { if (!cond) v.push(msg); };

  // ---- clean shutdown: drain, then the delayed exit(0) ----
  const a = evaluateShutdownBlock(block);
  check(a.handlers.SIGTERM === a.handlers.SIGINT && typeof a.handlers.SIGTERM === "function",
    "SIGTERM and SIGINT must be wired to the same stop handler");
  a.handlers.SIGTERM();
  check(a.exits.length === 0, "a signal must not exit synchronously (the drain-abort 503 race)");
  check(a.exits.length === 0 && a.timers.length === 0,
    "the exit timer must be scheduled in .finally, not at signal time");
  check(a.server.shutdownCalls.length === 1 && a.server.shutdownCalls[0]?.drainMs === 15_000,
    "the drain must start with the 15s window");
  check(a.logs.some((l) => l.includes("[serve] shutdown: draining")),
    "the drain must announce itself in the log");
  check(a.detached.includes("SIGTERM") && a.detached.includes("SIGINT"),
    "the early boot signal handlers must be detached before the drain pair is attached — a signal must have exactly one owner");
  await settle();
  await settle();
  check(a.timers.length === 1 && a.timers[0].ms === 200,
    `exactly one delayed exit timer of 200ms is expected, got ${JSON.stringify(a.timers.map((t) => t.ms))}`);
  a.timers[0]?.fn();
  check(JSON.stringify(a.exits) === "[0]", `the delayed exit must be exit(0) once, got ${JSON.stringify(a.exits)}`);

  // ---- repeated signal DURING the drain: force-exit(1), named in the log, no second drain ----
  const b = evaluateShutdownBlock(block);
  b.handlers.SIGINT();
  b.handlers.SIGINT(); // the operator's "enough" — the drain is still in flight
  check(JSON.stringify(b.exits) === "[1]",
    `a repeated signal during the drain must force-exit(1) immediately, got ${JSON.stringify(b.exits)}`);
  check(b.server.shutdownCalls.length === 1,
    "a repeated signal must not start a second drain on top of the first");
  check(b.errors.some((l) => l.includes("forced exit")),
    "the forced exit must name itself in the log — an unexplained non-zero exit after 'draining' reads as a crash");

  // ---- repeated signal AFTER the drain resolved (the 200ms exit-grace): exit 0, named ----
  const c = evaluateShutdownBlock(block);
  c.handlers.SIGINT();
  await settle();
  await settle(); // drain fully resolved, the 200ms flush timer pending (not fired)
  c.handlers.SIGINT(); // operator impatience inside the grace — the stop has already succeeded
  check(JSON.stringify(c.exits) === "[0]",
    `a repeated signal after a fully resolved drain must leave with the scheduled exit(0), got ${JSON.stringify(c.exits)}`);
  check(c.logs.some((l) => l.includes("repeated signal")),
    "the grace-window early exit must name itself in the log too — a silent early exit is unexplainable in the journal");
  check(c.timers.length === 1,
    `exactly one exit timer is expected in the grace-window scenario (the first drain's, no extra), got ${c.timers.length}`);

  return v;
}

test("shutdown exit: drain first, delayed exit(0); repeated signal during the drain force-exits(1), in the exit-grace leaves exit(0) — both named", async () => {
  const block = extractShutdownBlock(readFileSync(SERVE, "utf8"));
  const violations = await scenario(block);
  assert.deepEqual(violations, [], `the shutdown-exit pin holds only if all checks pass:\n  - ${violations.join("\n  - ")}`);
});

test("red proof: the same pin fails the pre-fix shape (sync exit, ignored repeated signal)", async () => {
  // The pre-1f6e3fe block, reconstructed from the commit diff.
  const preFix = [
    "const SHUTDOWN_DRAIN_MS = 15_000;",
    "let stopping = false;",
    "const stop = () => {",
    "  if (stopping) return; // a repeated signal must not start a second drain on top of the first",
    "  stopping = true;",
    '  console.log(`[serve] shutdown: draining (${server.isScanBusy() ? "scan active" : "idle"})`);',
    "  server",
    "    .shutdown({ drainMs: SHUTDOWN_DRAIN_MS })",
    "    .catch((err) => console.error(`[serve] shutdown error: ${err?.message ?? err}`))",
    "    .finally(() => process.exit(0)); // the exit happens only after the drain, not at signal time",
    "};",
    'process.on("SIGTERM", stop);',
    'process.on("SIGINT", stop);',
  ].join("\n");
  const violations = await scenario(preFix);
  assert.ok(violations.length > 0, "the pin must go red against the pre-fix shape — otherwise it pins nothing");
  // the regressions the commits fixed must be caught, not just one
  assert.ok(violations.some((m) => m.includes("200ms")), "the sync-exit regression must be caught");
  assert.ok(violations.some((m) => m.includes("force-exit(1)")), "the ignored-repeated-signal regression must be caught");
  assert.ok(violations.some((m) => m.includes("grace-window")), "the unnamed early exit in the grace window must be caught");
});

// exported for the red-show probe (prints the red violations for the notes)
export { extractShutdownBlock, evaluateShutdownBlock, scenario };
