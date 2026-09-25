// regression tests — the finding LW2_dedup_id_collision_silent_divergence.
// The dedup by the id:... key collapses nodes with the same id without comparing content
// and WITHOUT any warn — the first occurrence wins silently. If the issuer reuses
// or corrects an id (an amended event on a fresh page), the corrected value
// is ignored forever, and nobody learns about it. The review verdict: the "first
// occurrence wins" semantics must NOT change (the id is the identity of the API node, the alternative is worse),
// but observability must be added: one console.error warn per collapse with a divergence.
import test from "node:test";
import assert from "node:assert/strict";
import { multiplierHistoryToEvents } from "../src/events/normalize-xstocks.mjs";

const node = (id, from, to, at, reason = "Dividend") => ({
  id,
  reason,
  multiplier: to,
  previousMultiplier: from,
  activationDateTime: at,
});

// A spy on console.error: the dedup warn is the only expected channel
async function captureConsoleError(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...args) => lines.push(args.map(String).join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = orig;
  }
}

test("dedup: the same id with DIFFERENT content — still one event, but exactly one divergence warn", async () => {
  const { result: events, lines } = await captureConsoleError(() =>
    multiplierHistoryToEvents(
      [
        node("nx", "1.04", "1.07", "2026-05-01T00:00:00.000Z"), // as it arrived on page 0
        node("nx", "1.04", "1.06", "2026-05-01T00:00:00.000Z"), // the same id, another multiplier
      ],
      { symbol: "SPYx" },
    ),
  );
  // the semantics unchanged: the id is the node identity, the first occurrence wins
  assert.equal(events.length, 1);
  assert.equal(events[0].multiplierTo, "1.07");
  // …but now it is observable, not a silent data loss
  assert.equal(lines.length, 1, `one warn expected, was: ${JSON.stringify(lines)}`);
  assert.match(lines[0], /nx/); // the name of the conflicting id
  assert.match(lines[0], /SPYx/); // the token symbol
});

test("dedup: an honest page-drift (the same id, the same content) — collapsed WITHOUT a warn", async () => {
  const { result: events, lines } = await captureConsoleError(() =>
    multiplierHistoryToEvents(
      [
        node("n3", "1.04", "1.06", "2026-05-01T00:00:00.000Z"),
        node("n3", "1.04", "1.06", "2026-05-01T00:00:00.000Z"), // a duplicate across the page boundary
      ],
      { symbol: "SPYx" },
    ),
  );
  assert.equal(events.length, 1);
  assert.equal(lines.length, 0, "normal pagination drift — no reason to make noise");
});

test("dedup: nodes without an id, a full content match — collapsed without a warn", async () => {
  const { result: events, lines } = await captureConsoleError(() =>
    multiplierHistoryToEvents(
      [
        { reason: "Dividend", multiplier: "1.02", previousMultiplier: "1", activationDateTime: "2026-01-15T00:00:00.000Z" },
        { reason: "Dividend", multiplier: "1.02", previousMultiplier: "1", activationDateTime: "2026-01-15T00:00:00.000Z" },
      ],
      { symbol: "SPYx" },
    ),
  );
  assert.equal(events.length, 1);
  assert.equal(lines.length, 0);
});
