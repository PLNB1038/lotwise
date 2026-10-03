// The skip classes of a wallet scan, kept honest end to end.
//
// A transaction the scan could not read ("tx unreadable: …" — a mid-body transport cut,
// exhausted retries; "tx unavailable on endpoint" — a null result) is unread window
// history: it may carry mint deltas nobody saw. The two benign classes ("tx failed
// on-chain" from the signature list, "failed-tx" from meta.err) have no deltas by
// definition. Three consumers of that distinction must agree, and used not to:
//
//   1. /accruals already refused to certify a base over unread txs (baseIncomplete) —
//      the report's completeness certificate answered complete:true over the SAME scan
//      (the flag promised more than the scan delivered);
//   2. the serve log showed a clean "done" line for a degraded scan — the skips lived
//      only in counts.skipped of the response body;
//   3. the classes themselves were spelled out twice (the /accruals gate and now the
//      certificate) — one shared predicate pins them together.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { unreadableSkips } from "../src/wallet/scan.mjs";
import { buildWalletReport } from "../src/wallet/report.mjs";
import { createApiServer } from "../src/api/server.mjs";

const OWNER = "Ho5371Kc1Kxy7ze85UYzZ4BUfSkLg39Xp3B424RuYrbC"; // real-shaped: decodes to 32 bytes
const MINT = "XsMAqkcKsUewDrzVkait4e5u4y8REgtyS7jWgCpLV2C";
const REGISTRY = [{ mint: MINT, symbol: "GRDx", name: "Guard Token", decimals: 6, issuer: "test" }];

const scanOf = (skipped, extra = {}) => ({
  owner: OWNER, signatures: 5, fetched: 5, txs: [], skipped, truncated: false, accounts: {}, ...extra,
});

// ---- 1) the shared predicate: the two classes, named once ----

test("unreadableSkips: failed-on-chain classes are exempt, every other reason is unread history", () => {
  const scan = scanOf([
    { signature: "a", reason: "tx failed on-chain" },
    { signature: "b", reason: "failed-tx" },
    { signature: "c", reason: "tx unreadable: HTTP 429: too many requests" },
    { signature: "d", reason: "tx unavailable on endpoint" },
  ]);
  assert.deepEqual(unreadableSkips(scan).map((s) => s.signature), ["c", "d"]);
  assert.equal(unreadableSkips(scanOf([])).length, 0);
  assert.equal(unreadableSkips({}).length, 0, "a legacy scan without skipped reads as none");
});

// ---- 2) the report's completeness certificate counts unread txs (like /accruals) ----

test("report: network-unreadable txs withdraw the certificate — complete:false with the cause named", () => {
  const rep = buildWalletReport(scanOf([
    { signature: "c1", reason: "tx unreadable: HTTP 429" },
    { signature: "c2", reason: "tx unavailable on endpoint" },
    { signature: "c3", reason: "tx unreadable: bad JSON: terminated" },
  ]), { registry: REGISTRY, timelines: new Map() });
  assert.equal(rep.complete, false, "unread window history is not a certified history");
  assert.equal(rep.unreadableTxs, 3, "the cause rides the report, by the ambiguousSlotPairs convention");
  assert.equal(rep.truncated, false, "it is not a truncation — the cause is its own");
});

test("report: on-chain failed txs stay exempt — the certificate holds, the cause field stays absent", () => {
  const rep = buildWalletReport(scanOf([
    { signature: "a", reason: "tx failed on-chain" },
    { signature: "b", reason: "failed-tx" },
  ]), { registry: REGISTRY, timelines: new Map() });
  assert.equal(rep.complete, true, "a failed on-chain tx moves nothing — the window is not missing history");
  assert.equal("unreadableTxs" in rep, false, "the cause field appears only when non-zero");
});

// ---- 3) /lots answers the same verdict the report computed ----

test("/lots: network-skipped txs answer complete:false with unreadableTxs on the wire", async () => {
  const server = await createApiServer({
    registry: REGISTRY, events: [],
    walletScanner: async () => scanOf([
      { signature: "c1", reason: "tx unreadable: HTTP 429" },
      { signature: "c2", reason: "tx unavailable on endpoint" },
      { signature: "c3", reason: "tx unreadable: bad JSON: terminated" },
    ]),
  });
  const { port } = server.address();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/lots?address=${OWNER}`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.complete, false, "the certificate counts network skips as incompleteness — the /accruals baseIncomplete standard");
    assert.equal(body.unreadableTxs, 3);
  } finally {
    server.close();
  }
});

// ---- 4) the serve log: a degraded scan stops reading as a clean "done" line ----
// serve.mjs is a boot script with no exports; the scanner wiring is self-contained text
// (the same extraction pin as shutdown-exit-pin.test.mjs), evaluated with injected deps.

const SERVE = new URL("../scripts/serve.mjs", import.meta.url);
const SCAN_START = "walletScanner = (address, { signal } = {}) =>";
const SCAN_END = "return scan;\n    });\n  });";

function extractScannerBlock(source) {
  const nl = source.replaceAll("\r\n", "\n"); // the archive ships CRLF — anchors are LF-shaped
  const start = nl.indexOf(SCAN_START);
  assert.ok(start >= 0, `anchor not found in serve.mjs: ${SCAN_START}`);
  const end = nl.indexOf(SCAN_END, start);
  assert.ok(end > start, `anchor not found in serve.mjs: ${SCAN_END}`);
  return nl.slice(start, end + SCAN_END.length);
}

function evaluateScannerBlock(block, scan) {
  const logs = [];
  const warns = [];
  const fakeConsole = {
    log: (...a) => logs.push(a.join(" ")),
    warn: (...a) => warns.push(a.join(" ")),
    error: () => {},
  };
  const injected = {
    walletCached: (key, fn) => fn(),
    console: fakeConsole,
    maxTxs: 300,
    rpc: {},
    registry: REGISTRY,
    scanWallet: async () => scan,
    unreadableSkips,
  };
  const make = new Function(...Object.keys(injected), `let walletScanner;\n${block};\nreturn walletScanner;`);
  return { scanner: make(...Object.values(injected)), logs, warns };
}

test("serve log: a scan with network-unreadable txs names them in one aggregated warn line", async () => {
  const scan = scanOf([
    { signature: "c1", reason: "tx unreadable: HTTP 429: too many requests" },
    { signature: "c2", reason: "tx unavailable on endpoint" },
    { signature: "c3", reason: "tx unreadable: bad JSON: terminated" },
  ]);
  const { scanner, logs, warns } = evaluateScannerBlock(extractScannerBlock(readFileSync(SERVE, "utf8")), scan);
  await scanner(OWNER, {});
  assert.ok(logs.some((l) => l.includes("done —")), "the done line stays");
  assert.equal(warns.length, 1, `exactly one aggregated line, got ${JSON.stringify(warns)}`);
  assert.match(warns[0], /^\[serve\]/, "the line lives in the serve log namespace");
  assert.match(warns[0], /3 tx\(s\) skipped/, "how many");
  assert.match(warns[0], /0 failed on-chain, 3 unreadable/, "the split by class");
  assert.match(warns[0], /\(last: tx unreadable: bad JSON: terminated\)/, "why — the last reason, no per-tx flood");
});

test("serve log: mixed skips split benign from unreadable in the same single line", async () => {
  const scan = scanOf([
    { signature: "a", reason: "tx failed on-chain" },
    { signature: "b", reason: "failed-tx" },
    { signature: "c", reason: "tx unreadable: HTTP 429" },
  ]);
  const { scanner, logs, warns } = evaluateScannerBlock(extractScannerBlock(readFileSync(SERVE, "utf8")), scan);
  await scanner(OWNER, {});
  assert.equal(warns.length, 1);
  assert.match(warns[0], /3 tx\(s\) skipped — 2 failed on-chain, 1 unreadable/);
  assert.ok(!logs.some((l) => l.includes("skipped")), "the degraded case logs once, at warn level");
});

test("serve log: benign-only skips stay log-level (routine chain reality); zero skips stay silent", async () => {
  const benign = evaluateScannerBlock(
    extractScannerBlock(readFileSync(SERVE, "utf8")),
    scanOf([{ signature: "a", reason: "tx failed on-chain" }]),
  );
  await benign.scanner(OWNER, {});
  assert.equal(benign.warns.length, 0, "a failed-on-chain tx is not degradation — no warn");
  assert.ok(benign.logs.some((l) => l.includes("1 tx(s) skipped — 1 failed on-chain, 0 unreadable")),
    "the line still names the skips");
  const clean = evaluateScannerBlock(extractScannerBlock(readFileSync(SERVE, "utf8")), scanOf([]));
  await clean.scanner(OWNER, {});
  assert.ok(!clean.logs.some((l) => l.includes("skipped")), "a clean scan gains no noise");
});
