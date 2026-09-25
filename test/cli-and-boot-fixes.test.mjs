
//, code fixes (RED → GREEN):
//   E2-1 [P3] parseScaledUiAmount: a ts outside the ECMAScript Date range (|ts*1000| > 8.64e15)
//            gave a bare RangeError from toISOString() — past the module's typed error;
//            on /onchain that is a 503 kind:null with a leak of the inner text. A guard + ScaledUiError.
//   E4-1 [P3] isValidAddress checked only charset+length: 41×"1" (base58 ≠ 32 bytes)
//            passed into scan → getSignaturesForAddress → a 503 "rpc" on permanently broken
//            input. Fix: a base58 decode and exactly 32 bytes → an honest 400 BEFORE the scanner.
//   E2-SSRF  The delivery denylist did not know CGNAT 100.64/10 (a webhook would deliver into the tailnet!),
//            6to4 2002::/16 and NAT64 64:ff9b::/96.
//   E3-4     EADDRINUSE was caught AFTER the full boot (RPC quota burned on a double launch):
//            checkPortAvailable BEFORE the boot I/O, (the same refusal-before-I/O rule).
//   E3-2     The journal: read-modify-write without a cross-process lock — a foreign write in the
//            "boot read → persisted" window was silently clobbered. saveJournalMerged:
//            merge-under-lock (our mints win, foreign ones survive).
//   E3-3     enrich-decimals: process.exit over a live undici socket = 0xC0000409 on win
//            (the under-closed remainder of D2); fixed by process.exitCode + the --api flag for tests.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseScaledUiAmount, ScaledUiError } from "../src/issuer/scaled-ui.mjs";
import { isValidAddress } from "../src/wallet/scan.mjs";
import { validateSubscription } from "../src/webhooks/subscriptions.mjs";
import { checkPortAvailable } from "../src/cli/flags.mjs";
import { saveJournalMerged, loadJournalOnchain } from "../src/events/journal.mjs";
import { createApiServer } from "../src/api/server.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const mintState = (state) => ({
  owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  data: { parsed: { info: { decimals: 8, extensions: [{ extension: "scaledUiAmountConfig", state: { newMultiplierEffectiveTimestamp: 0, ...state } }] } } },
});

// ---- E2-1: the scaled-ui timestamp range ----

test("scaled-ui: a pending ts outside the Date range — ScaledUiError, not a bare RangeError", () => {
  assert.throws(
    () => parseScaledUiAmount(mintState({ multiplier: "1", newMultiplier: "2", newMultiplierEffectiveTimestamp: 8_640_000_000_001 })),
    ScaledUiError,
    "ts*1000 beyond +8.64e15 ms — a typed refusal of the module",
  );
  assert.throws(
    () => parseScaledUiAmount(mintState({ multiplier: "1", newMultiplier: "2", newMultiplierEffectiveTimestamp: -8_640_000_000_001 })),
    ScaledUiError,
    "the negative boundary — the same class",
  );
});

test("scaled-ui: exactly the boundary 8_640_000_000_000 — a valid date, no refusal", () => {
  const r = parseScaledUiAmount(mintState({ multiplier: "1", newMultiplier: "2", newMultiplierEffectiveTimestamp: 8_640_000_000_000 }));
  assert.equal(typeof r.pendingEffectiveDate, "string");
  assert.ok(r.pendingEffectiveDate.startsWith("+275760"), "the maximum representable date");
});

// ---- E4-1: structural base58 validation of a pubkey ----

test("wallet: isValidAddress — base58 must decode into exactly 32 bytes", () => {
  assert.equal(isValidAddress("1".repeat(41)), false, "41×\"1\": charset/length ok, but not 32 bytes");
  assert.equal(isValidAddress("2".repeat(32)), false, "32×\"2\": the number is too small for 32 bytes");
  assert.equal(isValidAddress("DivAccMint" + "1".repeat(34)), true, "a 44-character synthetic — valid");
  assert.equal(isValidAddress("XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W"), true, "the live SPYx mint");
});

test("api: /lots and /accruals with a structurally broken pubkey — 400 BEFORE the scanner, not a 503 rpc", async () => {
  let scannerCalls = 0;
  const server = await createApiServer({
    registry: [{ mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", symbol: "SPYx", name: "S&P", decimals: 8, issuer: "test" }],
    walletScanner: async () => { scannerCalls++; throw new Error("must not be called"); },
  });
  const { port } = server.address();
  try {
    for (const ep of ["/lots?address=", "/accruals?symbol=SPYx&address="]) {
      const res = await fetch(`http://127.0.0.1:${port}${ep}${"1".repeat(41)}`);
      assert.equal(res.status, 400, `${ep}: a permanently broken address — an honest 400`);
      const body = await res.json();
      assert.match(body.error, /pubkey/i);
    }
    assert.equal(scannerCalls, 0, "the scanner spent not a single RPC call");
  } finally {
    server.close();
  }
});

// ---- E2-SSRF: CGNAT / 6to4 / NAT64 ----

const sub = (url) => ({ id: "wh_x", url, symbols: "*", secret: "s", createdAt: "2026-09-24T00:00:00.000Z", active: true });

test("webhooks: CGNAT 100.64/10 — a private delivery zone (including the tailnet)", () => {
  assert.throws(() => validateSubscription(sub("http://100.89.32.108/hook")), /not delivered to/);
  assert.throws(() => validateSubscription(sub("http://100.64.0.1/hook")), /not delivered to/);
  assert.throws(() => validateSubscription(sub("http://100.127.255.254/hook")), /not delivered to/);
  assert.throws(() => validateSubscription(sub("http://[::ffff:100.64.0.1]/hook")), /not delivered to/, "a mapped v4 — the same class");
  validateSubscription(sub("http://100.128.0.1/hook")); // the first public one past CGNAT — ok
});

test("webhooks: 6to4 2002::/16 and NAT64 64:ff9b::/96 — transition zones outside delivery", () => {
  assert.throws(() => validateSubscription(sub("http://[2002:0a00:0001::]/hook")), /not delivered to/, "6to4 from 10.0.0.1");
  assert.throws(() => validateSubscription(sub("http://[2002::]/hook")), /not delivered to/);
  assert.throws(() => validateSubscription(sub("http://[64:ff9b::a9fe:a9fe]/hook")), /not delivered to/, "NAT64 with metadata inside");
  assert.throws(() => validateSubscription(sub("http://[64:ff9b::]/hook")), /not delivered to/, "the whole NAT64 zone — without parsing the embedded");
});

// ---- E3-4: the port is busy — a refusal BEFORE the boot I/O ----

test("flags: checkPortAvailable — a busy port is refused, a free one passes", async () => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
  const busyPort = blocker.address().port;
  await assert.rejects(
    () => checkPortAvailable(busyPort, "127.0.0.1"),
    (err) => err.name === "ServeArgsError" && err.flag === "--port" && /in use/i.test(err.message),
  );
  await new Promise((r) => blocker.close(r));
  await checkPortAvailable(busyPort, "127.0.0.1"); // freed — ok
});

// ---- E3-2: merge-under-lock of the journal ----

test("journal: saveJournalMerged — a foreign mint survives the boot persist", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lw-j14-"));
  try {
    const jp = path.join(dir, "onchain-journal.json");
    const foreign = { lastEffective: "3", observedAt: "2026-09-24T00:00:00.000Z", events: [] };
    writeFileSync(jp, JSON.stringify({ OTHERMINT: foreign }));
    saveJournalMerged(jp, { MYMINT: { lastEffective: "5", observedAt: "2026-09-24T00:00:00.000Z", events: [] } });
    const after = JSON.parse(readFileSync(jp, "utf8"));
    assert.ok(after.OTHERMINT, "the foreign record was not clobbered");
    assert.ok(after.MYMINT, "our record is in place");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("journal: saveJournalMerged — a record written AFTER the boot read survives too", () => {
  // the e3-4b scenario: the boot read the snapshot {EW1}, an external writer added {EW2},
  // the boot persists its snapshot — EW2 used to silently vanish
  const dir = mkdtempSync(path.join(tmpdir(), "lw-j14b-"));
  try {
    const jp = path.join(dir, "onchain-journal.json");
    writeFileSync(jp, JSON.stringify({ EXTERNALWRITER: { lastEffective: "1", observedAt: "2026-09-24T00:00:00.000Z", events: [] } }));
    const bootSnapshot = loadJournalOnchain(jp).journal; // "the boot read"
    writeFileSync(jp, JSON.stringify({ ...bootSnapshot, EXTERNALWRITER2: { lastEffective: "2", observedAt: "2026-09-24T00:01:00.000Z", events: [] } }));
    saveJournalMerged(jp, bootSnapshot); // "the boot persisted its snapshot"
    const after = JSON.parse(readFileSync(jp, "utf8"));
    assert.ok(after.EXTERNALWRITER, "the first writer survived");
    assert.ok(after.EXTERNALWRITER2, "the second (late) writer survived — the main e3-4b finding");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("journal: saveJournalMerged — our mint wins over the on-disk version", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lw-j14c-"));
  try {
    const jp = path.join(dir, "onchain-journal.json");
    writeFileSync(jp, JSON.stringify({ MYMINT: { lastEffective: "1", observedAt: "2026-09-01T00:00:00.000Z", events: [] } }));
    saveJournalMerged(jp, { MYMINT: { lastEffective: "6", observedAt: "2026-09-24T00:00:00.000Z", events: [] } });
    const after = JSON.parse(readFileSync(jp, "utf8"));
    assert.equal(after.MYMINT.lastEffective, "6", "the fresh boot observation overwrites the stale one");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- E3-3: the enrich-decimals exit code + --api ----

test("cli: enrich-decimals on an unreachable/refusing API — exit 1, not 0xC0000409", async () => {
  const bad = http.createServer((req, res) => { res.writeHead(400); res.end("nope"); });
  await new Promise((r) => bad.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(path.join(tmpdir(), "lw-enr14-"));
  try {
    // a one-token registry: ids is non-empty and the API still refuses with 400
    //: an empty registry is now an explicit no-op exit 0 BEFORE any network)
    writeFileSync(path.join(dir, "data-tokens.json"), JSON.stringify([
      { mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", symbol: "SPYx", name: "S&P 500", issuer: "backed", decimals: 8 },
    ]));
    // spawn (not spawnSync!): the local server lives in THIS process — a sync wait
    // blocks the event loop and catches itself with a dead lock (the round-14 rake)
    const child = spawn(process.execPath, [
      path.join(ROOT, "scripts", "enrich-decimals.mjs"),
      "--registry", path.join(dir, "data-tokens.json"),
      "--api", `http://127.0.0.1:${bad.address().port}/price`,
    ]);
    let stderr = "";
    child.stderr.on("data", (c) => { stderr += c; });
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 1, `an honest refusal code (stderr: ${stderr.slice(0, 200)})`);
    assert.ok(code !== 3221226505, "the undici crash of the process did not happen");
  } finally {
    await new Promise((r) => bad.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});
