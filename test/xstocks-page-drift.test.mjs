// A regression test on the page-drift of the xStocks history pagination (the round-5 finding,
// the candidate LW_issuer_page_drift_breaks_chain). Pagination by offset "newest on top":
// a node inserted by the issuer between the fetch of pages 0 and 1 shifts the window and ONE
// and the same node arrives on two pages. A node repeat passes issuerChainComplete
// (it only checks the start of the oldest node from "1"), arrives into the timeline and kills
// it with a TimelineError "chain discontinuity" — the token is excluded from the vitrine entirely.
// The contract: a duplicate node collapses BEFORE the chain check, a genuine
// chain break remains fail-closed.
import test from "node:test";
import assert from "node:assert/strict";
import { multiplierHistoryToEvents, bindMintAndValidate } from "../src/events/normalize-xstocks.mjs";
import { MultiplierTimeline, TimelineError } from "../src/lots/timeline.mjs";
import { issuerChainComplete } from "../src/events/journal.mjs";

const MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W"; // SPYx

// An honest chain 1 → 1.02 → 1.04 → 1.06 → 1.08, the newest on top (as the API serves).
const node = (id, from, to, at, reason = "Dividend") => ({
  id,
  reason,
  multiplier: to,
  previousMultiplier: from,
  activationDateTime: at,
});
const CHAIN = [
  node("n4", "1.06", "1.08", "2026-08-01T00:00:00.000Z"),
  node("n3", "1.04", "1.06", "2026-05-01T00:00:00.000Z"),
  node("n2", "1.02", "1.04", "2026-01-15T00:00:00.000Z"),
  node("n1", "1", "1.02", "2025-10-01T00:00:00.000Z"),
];

// Pagination exactly as in scripts/serve.mjs: offset pages "newest on top",
// the node n3 inserted between the fetches — the window of page 1 shifted and n3 duplicates
// across the boundary (page 0: [n4, n3], page 1: [n3, n2], page 2: [n1]).
const DRIFTED_PAGES = [
  { page: { hasNextPage: true }, nodes: [CHAIN[0], CHAIN[1]] },
  { page: { hasNextPage: true }, nodes: [CHAIN[1], CHAIN[2]] },
  { page: { hasNextPage: false }, nodes: [CHAIN[3]] },
];

// Assembling the pages as in serve.mjs (without sleep): the nodes are added as is.
async function collectNodes(pages) {
  const nodes = [];
  let hasNextPage = true;
  for (let page = 0; page < pages.length && hasNextPage; page++) {
    nodes.push(...pages[page].nodes);
    hasNextPage = pages[page].page.hasNextPage;
  }
  return nodes;
}

test("page-drift: a node duplicate across the page boundary passes issuerChainComplete (the finding's precondition)", async () => {
  const nodes = await collectNodes(DRIFTED_PAGES);
  assert.equal(nodes.length, 5); // 4 events, n3 doubled
  // the gate does NOT see the duplicate: it only looks at the oldest node (from "1") — complete
  assert.deepEqual(issuerChainComplete(nodes), { complete: true, reason: null });
});

test("page-drift: after the dedup the chain is valid, the timeline builds, the token is NOT excluded", async () => {
  const nodes = await collectNodes(DRIFTED_PAGES);
  const events = multiplierHistoryToEvents(nodes, { symbol: "SPYx", network: "Ethereum" });
  // the duplicate collapsed: 4 canonical events, not 5 nodes
  assert.equal(events.length, 4);
  const bound = bindMintAndValidate(events, MINT); // the atomic schema validation passes
  // the very place that used to fall: TimelineError "chain discontinuity"
  const timeline = new MultiplierTimeline(bound);
  assert.equal(timeline.multiplierAt("2026-09-01T00:00:00.000Z"), "1.08");
  // the chain is not "trimmed" but continuous: the multipliers by dates converge stepwise
  assert.equal(timeline.multiplierAt("2025-11-01T00:00:00.000Z"), "1.02");
  assert.equal(timeline.multiplierAt("2026-02-01T00:00:00.000Z"), "1.04");
  assert.equal(timeline.multiplierAt("2026-06-01T00:00:00.000Z"), "1.06");
  // the event source points at the real API node, not at the duplicate
  assert.match(events[0].sources[0], /#node:n1$/);
});

test("page-drift: the same drift on the raw JSON API (numbers instead of strings) also collapses", async () => {
  // multiplierHistoryToEvents accepts a raw payload (numbers) too, see the normalizer header
  const raw = [
    { id: "n4", reason: "Dividend", multiplier: 1.08, previousMultiplier: 1.06, activationDateTime: "2026-08-01T00:00:00.000Z" },
    { id: "n3", reason: "Dividend", multiplier: 1.06, previousMultiplier: 1.04, activationDateTime: "2026-05-01T00:00:00.000Z" },
    { id: "n3", reason: "Dividend", multiplier: 1.06, previousMultiplier: 1.04, activationDateTime: "2026-05-01T00:00:00.000Z" },
    { id: "n2", reason: "Dividend", multiplier: 1.04, previousMultiplier: 1.02, activationDateTime: "2026-01-15T00:00:00.000Z" },
    { id: "n1", reason: "Dividend", multiplier: 1.02, previousMultiplier: 1, activationDateTime: "2025-10-01T00:00:00.000Z" },
  ];
  const events = multiplierHistoryToEvents(raw, { symbol: "SPYx", network: "Ethereum" });
  assert.equal(events.length, 4);
  assert.doesNotThrow(() => new MultiplierTimeline(bindMintAndValidate(events, MINT)));
});

test("page-drift: the same id with DIFFERENT content — one node (the first occurrence), not two events", () => {
  const drifted = [
    node("nx", "1.04", "1.07", "2026-05-01T00:00:00.000Z"), // as it arrived on page 0
    node("nx", "1.04", "1.06", "2026-05-01T00:00:00.000Z"), // the same id, another multiplier on page 1
    node("n1", "1", "1.04", "2026-01-15T00:00:00.000Z"),
  ];
  const events = multiplierHistoryToEvents(drifted, { symbol: "SPYx", network: "Ethereum" });
  assert.equal(events.length, 2); // the id — the node identity: the second instance does not give a second event
  assert.equal(events.find((e) => e.multiplierTo === "1.07").multiplierTo, "1.07"); // the first occurrence wins
  assert.doesNotThrow(() => new MultiplierTimeline(bindMintAndValidate(events, MINT)));
});

test("page-drift: different ids with identical content do NOT collapse — the contradiction stays fail-closed", () => {
  const conflicting = [
    node("na", "1.04", "1.06", "2026-05-01T00:00:00.000Z"),
    node("nb", "1.04", "1.06", "2026-05-01T00:00:00.000Z"), // another node, the same transition
    node("n1", "1", "1.04", "2026-01-15T00:00:00.000Z"),
  ];
  const events = multiplierHistoryToEvents(conflicting, { symbol: "SPYx", network: "Ethereum" });
  assert.equal(events.length, 3); // the dedup only by the node identity, we do not throw away silently
  assert.throws(() => new MultiplierTimeline(bindMintAndValidate(events, MINT)), TimelineError);
});

test("page-drift: nodes without an id are deduped only on a full content match", () => {
  const idless = [
    { reason: "Dividend", multiplier: "1.02", previousMultiplier: "1", activationDateTime: "2026-01-15T00:00:00.000Z" },
    { reason: "Dividend", multiplier: "1.02", previousMultiplier: "1", activationDateTime: "2026-01-15T00:00:00.000Z" }, // an exact duplicate
    { reason: "Split", multiplier: "1.04", previousMultiplier: "1.02", activationDateTime: "2026-01-15T00:00:00.000Z" }, // another node, the same day
  ];
  const events = multiplierHistoryToEvents(idless, { symbol: "SPYx", network: "Ethereum" });
  assert.equal(events.length, 2); // the duplicate collapsed, different events on one day untouched
  const timeline = new MultiplierTimeline(bindMintAndValidate(events, MINT));
  assert.equal(timeline.multiplierAt("2026-02-01T00:00:00.000Z"), "1.04"); // the chain continuous
});
