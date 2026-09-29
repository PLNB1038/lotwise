// The demo snapshot ages honestly: the static set keeps its fixed 2026 story dates
// (determinism between restarts is load-bearing — tests and byte-identical boots depend on
// it), so a reader a year later would see "a year ago" with no marker at all. The fix is
// not to chase the calendar but to NAME the freeze point:
//   - DEMO_SNAPSHOT_AS_OF — the frozen reference "today" of the set, a constant (never
//     Date.now() inside the snapshot module);
//   - demoSnapshotAgeDays() — the whole-day distance from that point, read at request time;
//   - /health carries both in the demo mark (demo.snapshotAsOf / demo.snapshotAgeDays),
//     and the vitrine banner prints "frozen at <date>" on the page a judge screenshots.
// A live boot stays byte-identical: no demo key appears anywhere.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildDemoSnapshot, DEMO_SNAPSHOT_AS_OF, demoSnapshotAgeDays } from "../src/events/demo-snapshot.mjs";
import { createApiServer } from "../src/api/server.mjs";
import { renderPage } from "../src/ui/page.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const snapshot = buildDemoSnapshot();

test("demo snapshot: DEMO_SNAPSHOT_AS_OF is the frozen reference today — a constant, not the wall clock", () => {
  // pinned literally: re-authoring the set means consciously bumping this pin together
  // with the story dates, never silently
  assert.equal(DEMO_SNAPSHOT_AS_OF, "2026-09-27");
  assert.match(DEMO_SNAPSHOT_AS_OF, /^\d{4}-\d{2}-\d{2}$/);
});

test("demo snapshot: the set is static — two builds are byte-identical and no event postdates the freeze point", () => {
  const a = JSON.stringify(buildDemoSnapshot());
  const b = JSON.stringify(buildDemoSnapshot());
  assert.equal(a, b, "the demo data must not depend on the moment of the boot");
  for (const e of snapshot.events) {
    assert.ok(e.effectiveDate <= DEMO_SNAPSHOT_AS_OF, `${e.type} @ ${e.effectiveDate} must not be newer than the frozen today`);
  }
});

test("demo snapshot: ageDays counts whole days from the freeze point — never negative", () => {
  assert.equal(demoSnapshotAgeDays(Date.parse("2026-09-27")), 0, "the freeze point itself is age zero");
  assert.equal(demoSnapshotAgeDays(Date.parse("2026-09-27T12:00:00Z")), 0, "midday of the freeze day is still zero WHOLE days — never rounded up");
  assert.equal(demoSnapshotAgeDays(Date.parse("2026-09-28")), 1);
  assert.equal(demoSnapshotAgeDays(Date.parse("2026-09-30")), 3, "whole days — a partial day does not count");
  assert.equal(demoSnapshotAgeDays(Date.parse("2026-09-30T23:59:59Z")), 3, "a second short of day four is still three");
  assert.equal(demoSnapshotAgeDays(Date.parse("2027-09-27")), 365, "a judge a year later sees an honest 365");
  assert.equal(demoSnapshotAgeDays(Date.parse("2026-09-26")), 0, "before the freeze point the set is simply current, not an error");
  const wallClock = demoSnapshotAgeDays();
  assert.ok(Number.isInteger(wallClock) && wallClock >= 0, "the zero-argument form reads the wall clock");
});

test("demo boot: /health names the freeze point and the age; a live boot carries no demo mark at all", async () => {
  const server = await createApiServer({ registry: snapshot.registry, events: snapshot.events, demo: true });
  const { port } = server.address();
  try {
    const ageBefore = demoSnapshotAgeDays();
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    const ageAfter = demoSnapshotAgeDays();
    assert.ok(health.demo, "the mode mark stays truthy");
    // pinned literally: a mutated constant must not meet itself through the import
    assert.equal(health.demo.snapshotAsOf, "2026-09-27", "the freeze point is on the wire, not only in the source");
    assert.ok(
      health.demo.snapshotAgeDays === ageBefore || health.demo.snapshotAgeDays === ageAfter,
      `the age must be the honest whole-day count (${ageBefore}..${ageAfter}), got ${health.demo.snapshotAgeDays}`,
    );
  } finally {
    server.close();
  }
  const live = await createApiServer({ registry: snapshot.registry, events: snapshot.events });
  const { port: livePort } = live.address();
  try {
    const health = await (await fetch(`http://127.0.0.1:${livePort}/health`)).json();
    assert.equal("demo" in health, false, "the live shape stays byte-identical — no demo object, no age");
  } finally {
    live.close();
  }
});

test("vitrine: the demo banner names the frozen date; the default render is untouched", async () => {
  const server = await createApiServer({ registry: snapshot.registry, events: snapshot.events, demo: true });
  const { port } = server.address();
  try {
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(html, /DEMO MODE/, "the mode banner is still there");
    assert.match(html, /frozen at (<code>)?2026-09-27/, "a screenshot of the page shows the age of the story");
  } finally {
    server.close();
  }
  assert.equal(renderPage().includes("frozen at"), false, "the default render is unchanged");
  assert.equal(renderPage({ demo: true }).includes("frozen at"), false, "without a freeze point the banner does not invent one");
});
