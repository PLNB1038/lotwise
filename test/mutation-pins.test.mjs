// formerly round14-mutation-pins.test.mjs
// Round 14 — killer tests of the mutation audit (_bughunt/e1-*): every surviving
// mutation = a bug class the suite did not catch. These pins must be GREEN against
// the current code (the code is correct, the suite was leaky); a red pin = the mutation
// tester found a real bug.
//   J01 journal: replaying a legacy-"5.0" history over a NEW rotation must emit an event
//   W03 wallet: a scan gap → complete:false (a contract pin; the expression is partially redundant
//        with reconciles, see the e1 report W03/W05 — defense-in-depth)
//   E02 schema: sub-unity and leading-zero multipliers are canonicalized predictably
//   I02/I04/I05 isodate: the century 2100 (not a leap year), a second fraction .5=500ms, offset minutes 60+
//   R03 rpc: error.code:null + a message transient → retries, the final kind "rate-limit"
//   T02 timeline: a schema-valid 30-digit fraction builds a timeline (the boundary of the "pair")
//   E05 schema: a required string field "" — a refusal, not "valid"
//   S05 api: lotsConsidered strictly earlier than effectiveDate (a lot exactly ON the ex-date is not in the base)
import test from "node:test";
import assert from "node:assert/strict";
import { planJournalStep } from "../src/events/journal.mjs";
import { parseScaledUiAmount } from "../src/issuer/scaled-ui.mjs";
import { canonicalDecimalString } from "../src/schema/events.mjs";
import { parseIsoDateMs } from "../src/schema/isodate.mjs";
import { RpcClient, RpcError } from "../src/ingest/rpc.mjs";
import { MultiplierTimeline } from "../src/lots/timeline.mjs";
import { buildWalletReport } from "../src/wallet/report.mjs";
import { loadRegistry } from "../src/registry/registry.mjs";
import { createApiServer } from "../src/api/server.mjs";
import { bindMintAndValidate } from "../src/events/normalize-xstocks.mjs";

const MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const SPYx = MINT;
const TOKEN = { mint: MINT, symbol: "TESTx" };
const OWNER = "DivAddrA" + "1".repeat(36);

const mintState = (state) => ({
  owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  data: { parsed: { info: { decimals: 8, extensions: [{ extension: "scaledUiAmountConfig", state: { newMultiplierEffectiveTimestamp: 0, ...state } }] } } },
});
const settled = (m) => mintState({ multiplier: m, newMultiplier: 0 });

// ---- J01: a legacy "5.0" over a new rotation ----

test("journal: a legacy record with \"5.0\" in the history + the chain moved to 6 — the rotation IS EMITTED", () => {
  const priorEntry = {
    lastEffective: "5", // already canonical
    observedAt: "2026-09-01T00:00:00.000Z",
    events: [{ effectiveDate: "2026-06-10T04:30:00.000Z", multiplierFrom: "1", multiplierTo: "5.0", reason: "legacy build" }], // the raw representation of the old build
  };
  const r = planJournalStep(TOKEN, priorEntry, parseScaledUiAmount(settled("6")));
  assert.notEqual(r.event, null, "a real 5→6 rotation is not swallowed because of a raw old record");
  assert.equal(r.entry.lastEffective, "6");
});

// ---- W03: a gap → complete:false (the contract pin) ----

test("wallet: an uncovered outflow (a gap) — complete:false, even if the other flags are clean", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const txs = [
    { signature: "sell-first", slot: 1, blockTime: 100, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 500n, postRaw: 200n, deltaRaw: -300n }] },
    { signature: "buy-later", slot: 2, blockTime: 200, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 200n, postRaw: 260n, deltaRaw: 60n }] },
  ];
  const rep = buildWalletReport(
    { owner: OWNER, signatures: 2, fetched: 2, txs, skipped: [], truncated: false, accounts: {} },
    { registry },
  );
  assert.equal(rep.tokens.find((t) => t.mint === SPYx).gaps.length, 1, "the gap is recorded");
  assert.equal(rep.complete, false, "a gap ⇒ an incomplete report — the observable contract for consumers");
});

// ---- E02: sub-unity multipliers ----

test("schema: canonicalDecimalString of sub-unity and leading zeros — predictable", () => {
  assert.equal(canonicalDecimalString("0.5"), "0.5", "a sub-unity multiplier keeps its leading zero");
  assert.equal(canonicalDecimalString("0"), "0", "zero stays zero, not an empty string");
  assert.equal(canonicalDecimalString("00.500"), "0.5", "leading and trailing zeros collapse to the canonical form");
  assert.equal(canonicalDecimalString("0.0040015369331659"), "0.0040015369331659", "a real JPMx-class dividend multiplier — without distortion");
});

// ---- I02 / I04 / I05: the isodate boundaries ----

test("isodate: the century rule — 2100-02-29 is rejected, 2000-02-29 is valid", () => {
  assert.equal(parseIsoDateMs("2100-02-29"), null, "2100 is NOT a leap year (divisible by 100, not by 400)");
  assert.equal(parseIsoDateMs("1900-02-29"), null);
  assert.notEqual(parseIsoDateMs("2000-02-29"), null, "2000 is a leap year (divisible by 400)");
  assert.notEqual(parseIsoDateMs("2400-02-29"), null);
});

test("isodate: a fractional second .5 — that is 500 ms, not 50 and not 5000", () => {
  const base = parseIsoDateMs("2026-09-24T00:00:00Z");
  const half = parseIsoDateMs("2026-09-24T00:00:00.5Z");
  assert.equal(half - base, 500, "the second fraction is read up to the third digit as is");
});

test("isodate: offset minutes 60+ (\"+01:60\") — garbage, null", () => {
  assert.equal(parseIsoDateMs("2026-09-24T00:00:00+01:60"), null);
  assert.equal(parseIsoDateMs("2026-09-24T00:00:00+01:99"), null);
  assert.notEqual(parseIsoDateMs("2026-09-24T00:00:00+01:59"), null, "a valid minute passes");
});

// ---- R03: code:null + a message transient ----

test("rpc: {code:null, message:\"node is behind…\"} — a transient with retries, the final rate-limit", async () => {
  let calls = 0;
  const client = new RpcClient({
    endpoint: "https://rpc.example",
    fetcher: async () => {
      calls++;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: null, message: "node is behind by 12 slots" } }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
    sleep: async () => {}, minIntervalMs: 0, maxRetries: 2,
  });
  await assert.rejects(() => client.call("m", []), (err) => {
    assert.equal(err.kind, "rate-limit", "exhausting message transients — the rate-limit class, not a fatal rpc");
    return err instanceof RpcError;
  });
  assert.equal(calls, 3, "1 + 2 retries — a null code does not make the error deterministic");
});

// ---- T02: a 30-digit fraction at the contract boundary ----

test("timeline: a multiplier with a 30-digit fraction (the schema boundary) builds a timeline", () => {
  const to = "1." + "3".repeat(30); // 30 digits — valid by the "pair" contract
  const mult = bindMintAndValidate([{
    type: "MULTIPLIER_CHANGE", effectiveDate: "2026-06-10", status: "confirmed",
    sources: ["test"], multiplierFrom: "1", multiplierTo: to, reason: "precision boundary",
  }], MINT);
  const tl = new MultiplierTimeline(mult);
  assert.equal(tl.multiplierAt("2026-06-09"), "1");
  assert.equal(tl.multiplierAt("2026-06-11"), to, "a value at the tolerance boundary does not exclude the token from the vitrine");
});

// ---- E05: an empty string in a required field ----

test("schema: a required string field \"\" — a validation refusal (TICKER_CHANGE newSymbol)", async () => {
  const { validateEvent, EventValidationError } = await import("../src/schema/events.mjs");
  assert.throws(
    () => validateEvent({
      type: "TICKER_CHANGE", mint: MINT, effectiveDate: "2026-06-10", status: "confirmed",
      sources: ["test"], oldSymbol: "OLDx", newSymbol: "", reason: "empty target",
    }),
    EventValidationError,
    "an empty string is not a \"new ticker\" but garbage",
  );
});

// ---- S05: lotsConsidered strictly earlier than the ex-date ----

test("api: /accruals — a lot bought EXACTLY on effectiveDate does not get into lotsConsidered", async () => {
  const A_MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
  const A_ADDR = OWNER;
  const registry = [{ mint: A_MINT, symbol: "SPYx", name: "t", decimals: 6, issuer: "test" }];
  const events = bindMintAndValidate([{
    type: "DIVIDEND_ACCRUAL", effectiveDate: "2026-09-10", status: "confirmed",
    sources: ["test"], amountPerUnitRaw: 2, decimals: 6,
  }], A_MINT);
  const buy = (sig, qty, iso) => ({
    signature: sig, slot: 1, blockTime: Math.floor(Date.parse(iso) / 1000),
    deltas: [{ owner: A_ADDR, mint: A_MINT, preRaw: 0n, postRaw: qty, deltaRaw: qty }],
  });
  const txs = [
    buy("before", 1_000_000n, "2026-09-09T23:59:59Z"),
    buy("exactly-on", 5_000_000n, "2026-09-10T00:00:00Z"), // exactly the ex-date
  ];
  const server = await createApiServer({
    registry, events,
    walletScanner: async () => ({ owner: A_ADDR, signatures: txs.length, fetched: txs.length, txs, skipped: [], truncated: false, accounts: {} }),
  });
  const { port } = server.address();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/accruals?symbol=SPYx&address=${A_ADDR}`);
    assert.equal(r.status, 200);
    const rows = await r.json();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].lotsConsidered, 1, "only the strictly-earlier lot; one bought exactly on the ex-date — same as the engine");
  } finally {
    server.close();
  }
});
