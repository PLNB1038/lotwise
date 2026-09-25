// The showcase must name the TRUE reason a report is incomplete. Completeness is withdrawn
// for gaps, truncation, non-reconciliation — and for same-slot pairs whose ledger order the
// RPC cannot tell apart (a deterministic guess). The wallet card used to print one
// hard-coded reason ("has gaps") for every withdrawal, lying about zero-gap reports and
// dropping the only field that explains the withdrawal. The inline script of the page runs
// headlessly with a stub document, then renderWallet(report) runs for real.
import test from "node:test";
import assert from "node:assert/strict";
import { renderPage } from "../src/ui/page.mjs";

const OWNER = "Wa11etBuyer" + "a".repeat(32);

function renderWalletHtml(rep) {
  const html = renderPage();
  const m = /<script>([\s\S]*)<\/script>/.exec(html);
  assert.ok(m, "the inline script is found");
  const stubs = new Map();
  const stub = (id) => {
    if (!stubs.has(id)) {
      stubs.set(id, { id, innerHTML: "", textContent: "", value: "", disabled: false, onclick: null, scrollIntoView() {}, querySelectorAll: () => [] });
    }
    return stubs.get(id);
  };
  const documentStub = { getElementById: stub, querySelectorAll: () => [], addEventListener() {} };
  const script = m[1] + "\n;globalThis.__renderWallet = renderWallet;";
  const neverFetch = () => new Promise(() => {}); // the top-level boot fetch parks forever
  new Function("document", "fetch", script)(documentStub, neverFetch);
  globalThis.__renderWallet(rep);
  return stub("wallet-out").innerHTML;
}

test("showcase: an ambiguity-withdrawn completeness names the same-slot guess, not gaps", () => {
  const rep = {
    owner: OWNER, method: "fifo", now: "2026-09-25T00:00:00.000Z",
    counts: { signatures: 2, fetched: 2, relevantTxs: 2, skipped: 0 },
    truncated: false,
    ambiguousSlotPairs: 1,
    complete: false, // withdrawn by the guess — the report has NO gaps
    tokens: [],
  };
  const out = renderWalletHtml(rep);
  const line = /<dt>completeness<\/dt><dd[^>]*>(.*?)<\/dd>/.exec(out)?.[1] ?? "(no completeness line)";
  assert.ok(/same-slot/.test(line), `the reason names the same-slot guess: ${JSON.stringify(line)}`);
  assert.ok(!/has gaps/.test(line), "a zero-gap report is not told it has gaps");
});

test("showcase: a gap-withdrawn completeness still says gaps", () => {
  const rep = {
    owner: OWNER, method: "fifo", now: "2026-09-25T00:00:00.000Z",
    counts: { signatures: 1, fetched: 1, relevantTxs: 1, skipped: 0 },
    truncated: false,
    complete: false,
    tokens: [],
  };
  const out = renderWalletHtml(rep);
  const line = /<dt>completeness<\/dt><dd[^>]*>(.*?)<\/dd>/.exec(out)?.[1] ?? "(no completeness line)";
  assert.ok(/has gaps/.test(line), `the original reason stays: ${JSON.stringify(line)}`);
});

const TOKEN = (over = {}) => ({
  symbol: "SPYx", name: "S&P 500 xStock", mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", decimals: 8,
  rawBalance: "0", netDeltaRaw: "0", onchainNow: "0", reconciles: true,
  multiplier: { now: "1", events: 0 },
  adjusted: { exact: true, whole: "0", remainder: "0", den: "1" },
  lots: [], realized: [], realizedCount: 0, realizedQtyRaw: "0", gaps: [],
  ...over,
});

test("showcase: a truncated-only withdrawal names truncation, not gaps", () => {
  const rep = {
    owner: OWNER, method: "fifo", now: "2026-09-25T00:00:00.000Z",
    counts: { signatures: 300, fetched: 300, relevantTxs: 300, skipped: 0 },
    truncated: true, // the cap hit; no gaps, everything reconciles
    complete: false,
    tokens: [TOKEN()],
  };
  const out = renderWalletHtml(rep);
  const line = /<dt>completeness<\/dt><dd[^>]*>(.*?)<\/dd>/.exec(out)?.[1] ?? "(no completeness line)";
  assert.ok(/truncated/.test(line), `truncation is named: ${JSON.stringify(line)}`);
  assert.ok(!/has gaps/.test(line), "a zero-gap report is not told it has gaps");
});

test("showcase: a reconcile-mismatch withdrawal names the mismatch, not gaps", () => {
  const rep = {
    owner: OWNER, method: "fifo", now: "2026-09-25T00:00:00.000Z",
    counts: { signatures: 2, fetched: 2, relevantTxs: 2, skipped: 0 },
    truncated: false,
    complete: false, // withdrawn ONLY because a token did not reconcile with the chain
    tokens: [TOKEN({ reconciles: false, onchainNow: "100" })],
  };
  const out = renderWalletHtml(rep);
  const line = /<dt>completeness<\/dt><dd[^>]*>(.*?)<\/dd>/.exec(out)?.[1] ?? "(no completeness line)";
  assert.ok(/did not reconcile/.test(line), `the mismatch is named: ${JSON.stringify(line)}`);
  assert.ok(!/has gaps/.test(line), "a zero-gap report is not told it has gaps");
});
