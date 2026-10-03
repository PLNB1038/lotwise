// The declarations channel keys EVERY identity on the canonical ex-DAY: the supersedes
// target, the one-amount-per-day rule, the engine's dividend identity, the /accruals
// dedup. The producer was the one seam keyed differently — the exact-duplicate dedup
// rode the INSTANT of exDate, and the supersede counter counted dedup-surviving LINES:
// two tz-spellings of ONE correction ("2026-06-20" vs "2026-06-20T05:00:00+03:00",
// republished with a re-rendered link) survived as two lines and the counter refused
// the WHOLE legal file as a "double supersede" — the declarations channel down
// (declarations.ok: 0, every /accruals empty) over one cosmetic re-rendering. Both
// seams now key on the day, and the counter counts the REPLACEMENTS a correction
// declares (its own canonical ex-day + amount), not the lines carrying it: a
// republished correction is one correction; two GENUINELY different replacements of
// one target still refuse.
import test from "node:test";
import assert from "node:assert/strict";
import { buildDeclarationEvents, DeclarationError } from "../src/events/dividends.mjs";

const SYM = { symbol: "KOx" };
const plain = (over = {}) => ({
  symbol: "KOx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 6,
  sourceUrl: "https://issuer.example/q2", ...over,
});
const corr = (over = {}) => ({
  symbol: "KOx", exDate: "2026-06-20", amountPerUnitRaw: "2500000", decimals: 6,
  sourceUrl: "https://issuer.example/q2-corr",
  supersedes: { exDate: "2026-06-18", amountPerUnitRaw: "2000000" },
  ...over,
});

test("a tz-skin pair of ONE correction (republished with a new link) loads — one replacement, the target gone", () => {
  const { events, superseded } = buildDeclarationEvents([
    plain(),
    corr({ sourceUrl: "https://issuer.example/q2-corr" }),
    corr({ exDate: "2026-06-20T05:00:00+03:00", sourceUrl: "https://issuer.example/q2-corr-v2" }),
  ], SYM);
  assert.equal(superseded, 1, "one replacement, not a 'double supersede' refusal");
  assert.ok(events.every((e) => String(e.effectiveDate).slice(0, 10) !== "2026-06-18"), "the target's accrual is replaced");
  assert.ok(
    events.every((e) => String(e.effectiveDate).slice(0, 10) === "2026-06-20" && e.amountPerUnitRaw === 2500000),
    "the correction accrues (both sightings are the same day-identity — the engine collapses them)",
  );
});

test("the same link with a tz-skin spelling: the exact-duplicate dedup collapses the twin itself", () => {
  const { events, superseded } = buildDeclarationEvents([
    plain(),
    corr(),
    corr({ exDate: "2026-06-20T05:00:00+03:00" }), // same sourceUrl — one line, re-rendered date
  ], SYM);
  assert.equal(events.length, 1, "the day-key dedup collapses the tz-skin twin");
  assert.equal(superseded, 1);
});

test("the exact-duplicate key is day-granular for plain lines too — a tz-skin repeat of one line collapses", () => {
  const { events } = buildDeclarationEvents([
    plain(),
    plain({ exDate: "2026-06-18T05:00:00+03:00" }), // same everything, another instant of the same day
  ], SYM);
  assert.equal(events.length, 1, "one ex-day, one line — no double accrual to collapse downstream");
  // the documented trade-off stands: a different sourceUrl is a different announcement
  const near = buildDeclarationEvents([plain(), plain({ sourceUrl: "https://issuer.example/q2-mirror" })], SYM);
  assert.equal(near.events.length, 2, "a different link stays two sightings");
});

test("two GENUINELY different corrections of one target still refuse (the file is ambiguous)", () => {
  assert.throws(
    () => buildDeclarationEvents([
      plain({ amountPerUnitRaw: "2000000" }),
      corr({ amountPerUnitRaw: "2500000" }),
      corr({ amountPerUnitRaw: "3000000" }),
    ], SYM),
    (e) => e instanceof DeclarationError && /already superseded/.test(e.message),
  );
});

test("a verbatim repeat of a correction still collapses — re-submitting the feed is not a double supersede", () => {
  const { events, superseded } = buildDeclarationEvents([plain(), corr(), corr()], SYM);
  assert.equal(events.length, 1);
  assert.equal(superseded, 1);
});
