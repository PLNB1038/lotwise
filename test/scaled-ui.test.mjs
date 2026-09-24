import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseScaledUiAmount, reconcileMultiplier, ScaledUiError } from "../src/issuer/scaled-ui.mjs";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

// A LIVE mainnet response for the SPYx mint (18.09.2026): active 1.0039…, pending 1.0057… since 18.06
const live = JSON.parse(readFileSync(path.join(dir, "onchain-spyx-mint.json"), "utf8")).result.value;

test("the live on-chain SPYx: the extension parsed, both multipliers and the activation date", () => {
  const m = parseScaledUiAmount(live);
  assert.equal(m.hasExtension, true);
  assert.equal(m.decimals, 8);
  assert.equal(m.activeMultiplier, "1.003909240011759");
  assert.equal(m.pendingMultiplier, "1.005714560286254");
  assert.equal(m.pendingEffectiveDate, "2026-06-18T04:00:00.000Z");
  assert.equal(m.program, "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
  assert.equal(typeof m.authority, "string");
});

test("a token without scaledUiAmountConfig = multiplier 1, hasExtension false", () => {
  const plain = { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { parsed: { info: { decimals: 6, extensions: [{ extension: "mintCloseAuthority" }] } } } };
  const m = parseScaledUiAmount(plain);
  assert.deepEqual(
    { activeMultiplier: m.activeMultiplier, pendingMultiplier: m.pendingMultiplier, hasExtension: m.hasExtension },
    { activeMultiplier: "1", pendingMultiplier: null, hasExtension: false },
  );
});

test("a non-mint account gives a clear error", () => {
  assert.throws(() => parseScaledUiAmount({ data: {} }), ScaledUiError);
  assert.throws(() => parseScaledUiAmount(undefined), ScaledUiError);
});

test("THE REAL CASE: the API plan (1.0057) vs on-chain (active 1.0039, effective 1.0057) on 18.09", () => {
  const onChain = parseScaledUiAmount(live);
  const r = reconcileMultiplier("1.005714560286254", onChain, "2026-09-18T00:00:00.000Z");
  // the pending should have activated on 18.06 → the effective matches the API → ok
  assert.equal(r.onChainEffective, "1.005714560286254");
  assert.equal(r.verdict, "ok");
});

test("before the pending activation: the effective = active; the divergence from the API is visible", () => {
  const onChain = parseScaledUiAmount(live);
  const before = reconcileMultiplier("1.005714560286254", onChain, "2026-06-01T00:00:00.000Z");
  assert.equal(before.onChainEffective, "1.003909240011759");
  assert.equal(before.verdict, "planes-disagree"); // the API already moved, the chain not yet — we catch it
  const matched = reconcileMultiplier("1.003909240011759", onChain, "2026-06-01T00:00:00.000Z");
  assert.equal(matched.verdict, "ok");
});

// ---- round 2: the reconcile of the plans on the date boundary ----

test("the pending activates ON the day of its date even by a date-only query", () => {
  const onChain = {
    activeMultiplier: "1.003909240011759",
    pendingMultiplier: "1.005714560286254",
    pendingEffectiveDate: "2026-06-18T00:00:00.000Z",
    pendingTs: null, authority: null, hasExtension: true,
  };
  // before the fix a string comparison considered the pending inactive exactly on the activation day
  const r = reconcileMultiplier("1.005714560286254", onChain, "2026-06-18");
  assert.equal(r.onChainEffective, "1.005714560286254");
  assert.equal(r.verdict, "ok");
});

test("a garbage reconcile date — ScaledUiError, not a quiet string comparison", () => {
  assert.throws(
    () => reconcileMultiplier("1", { activeMultiplier: "1", pendingMultiplier: null, pendingEffectiveDate: null }, "not-a-date"),
    ScaledUiError,
  );
});

// ---- round 4: the guards of the on-chain state parser ----

// A synthetic mint with scaledUiAmountConfig in the given state.
const mintWith = (state) => ({
  owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  data: { parsed: { info: { decimals: 8, extensions: [{ extension: "scaledUiAmountConfig", state }] } } },
});
const T0 = String(Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000)); // past
const T1 = String(Math.floor(Date.parse("2027-01-01T00:00:00Z") / 1000)); // future

test("P1: a newMultiplier \"0\" from the chain = the pending reset, not a zero multiplier", () => {
  // The issuer's convention (xstocks.mjs: Number(pending) !== 0, the live fixture
  // xstocks-spyx-current.json): 0 in new_multiplier — a way to lift the pending. The string "0"
  // is truthy and used to ride through as a real multiplier → the journal emitted 5→0, the vitrine
  // silently showed zero balances.
  for (const ts of [T0, T1]) {
    const m = parseScaledUiAmount(mintWith({ multiplier: "5", newMultiplier: "0", newMultiplierEffectiveTimestamp: ts }));
    assert.equal(m.activeMultiplier, "5");
    assert.equal(m.pendingMultiplier, null);
    // the date is zeroed TOGETHER with the pending: the (pending, date) pair is atomic, a date without
    // a pending — garbage in the response; the response shape unchanged
    assert.equal(m.pendingEffectiveDate, null);
  }
  // a numeric 0 and an absent field altogether — the same vector
  assert.equal(parseScaledUiAmount(mintWith({ multiplier: "5", newMultiplier: 0, newMultiplierEffectiveTimestamp: 1 })).pendingMultiplier, null);
  assert.equal(parseScaledUiAmount(mintWith({ multiplier: "5" })).pendingMultiplier, null);
});

test("P3: the active is not a decimal string — an honest ScaledUiError, not an \"undefined\" into the lower layers", () => {
  // a missing multiplier used to give String(undefined) = "undefined" and fell
  // somewhere in the validation with a cryptic message
  assert.throws(() => parseScaledUiAmount(mintWith({ newMultiplier: "2" })), (e) =>
    e instanceof ScaledUiError && /decimal string/.test(e.message));
  assert.throws(() => parseScaledUiAmount(mintWith({ multiplier: "abc", newMultiplier: "2" })), ScaledUiError);
  assert.throws(() => parseScaledUiAmount(mintWith({ multiplier: "1.2.3", newMultiplier: "2" })), ScaledUiError);
  assert.throws(() => parseScaledUiAmount(mintWith({ multiplier: null, newMultiplier: "2" })), ScaledUiError);
  // the valid forms pass: an integer and a fractional decimal string
  assert.equal(parseScaledUiAmount(mintWith({ multiplier: "5", newMultiplier: "0" })).activeMultiplier, "5");
  assert.equal(parseScaledUiAmount(mintWith({ multiplier: "1.25", newMultiplier: "0" })).activeMultiplier, "1.25");
});

test("P3: the pending alive but the timestamp garbage — ScaledUiError instead of silently nulling the date", () => {
  // before the fix: Number("abc") = NaN → ts > 0 false → the date null → the pending "6" was silently
  // ignored by the underlying layers
  assert.throws(
    () => parseScaledUiAmount(mintWith({ multiplier: "5", newMultiplier: "6", newMultiplierEffectiveTimestamp: "abc" })),
    (e) => e instanceof ScaledUiError && /timestamp/i.test(e.message),
  );
});

test("P3: no pending — a garbage timestamp has no value, we do not throw", () => {
  const m = parseScaledUiAmount(mintWith({ multiplier: "5", newMultiplier: "0", newMultiplierEffectiveTimestamp: "abc" }));
  assert.equal(m.activeMultiplier, "5");
  assert.equal(m.pendingMultiplier, null);
  assert.equal(m.pendingEffectiveDate, null);
});

test("a healthy on-chain state with an integer multiplier — no regressions", () => {
  const m = parseScaledUiAmount(mintWith({
    multiplier: "5",
    newMultiplier: "10",
    newMultiplierEffectiveTimestamp: "1782000000",
  }));
  assert.deepEqual(
    { activeMultiplier: m.activeMultiplier, pendingMultiplier: m.pendingMultiplier, pendingEffectiveDate: m.pendingEffectiveDate },
    { activeMultiplier: "5", pendingMultiplier: "10", pendingEffectiveDate: new Date(1782000000 * 1000).toISOString() },
  );
  // a pending without a declared date (no ts) — the previous behavior: the date null,
  // the pending itself is not thrown away
  const m2 = parseScaledUiAmount(mintWith({ multiplier: "5", newMultiplier: "10" }));
  assert.equal(m2.pendingMultiplier, "10");
  assert.equal(m2.pendingEffectiveDate, null);
});
