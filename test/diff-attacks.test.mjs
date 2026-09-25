
// — the fixes of the diff attack :
//   F1-1 [P2] enrich: the "?? default" ate the null flag errors — the script printed a refusal
//        and THEN went to the network/rewrote the registry. Now: a broken flag = exit 2 BEFORE any
//        I/O (0 requests, the file untouched).
//   F1-2 [P3] enrich: the equals form --registry=<path> was silently ignored —
//        the default file was enriched (the old default-file bug). Now the grammar = serve.
//   F1-3 [P3] the journal lock: pid liveness (the semantics of R9 #9 from the webhook lock) — a live
//        stuck owner is NOT broken by mtime; a dead pid is broken immediately.
//   F1-4 [P3] a future mtime of the lock (a clock skew) — broken immediately, without a 10s wait.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { saveJournalMerged } from "../src/events/journal.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";

const tmp = (name) => mkdtempSync(path.join(tmpdir(), name));
const runCli = (args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(ROOT, "scripts", "enrich-decimals.mjs"), ...args]);
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { out += c; });
  child.on("close", (code) => resolve({ code, out }));
});

// ---- F1-1: a broken flag = a refusal BEFORE any I/O ----

test("cli: enrich --registry without a value — exit 2, ZERO API requests, the file untouched", async () => {
  let hits = 0;
  const api = http.createServer((req, res) => { hits++; res.writeHead(400); res.end(); });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  const dir = tmp("lw-f1a-");
  try {
    const reg = path.join(dir, "reg.json");
    writeFileSync(reg, JSON.stringify([{ mint: MINT, symbol: "SPYx", decimals: null }]));
    const { code, out } = await runCli(["--registry", "--api", `http://127.0.0.1:${api.address().port}`]);
    assert.equal(code, 2, "the contract refusal code of a flag");
    assert.match(out, /--registry requires a value/);
    assert.equal(hits, 0, "not a single API request after the refusal (P2: network+rewrite used to happen)");
    assert.equal(JSON.parse(readFileSync(reg, "utf8"))[0].decimals, null, "the registry is not rewritten");
  } finally {
    await new Promise((r) => api.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- F1-2: the equals form ----

test("cli: enrich --registry=<path> (equals) — exactly THAT file is enriched", async () => {
  const dir = tmp("lw-f1b-");
  try {
    const alt = path.join(dir, "alt.json");
    const def = path.join(dir, "default.json");
    writeFileSync(alt, JSON.stringify([{ mint: MINT, symbol: "SPYx", decimals: null }]));
    writeFileSync(def, JSON.stringify([{ mint: MINT, symbol: "SPYx", decimals: null }]));
    const api = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ [MINT]: { usdPrice: 1, blockId: "b", decimals: 8, priceChange24h: {} } }));
    });
    await new Promise((r) => api.listen(0, "127.0.0.1", r));
    // the sandbox cwd: the default path data/tokens.json resolves into its own data/ —
    // we put a copy of def there to catch "the wrong file was enriched"
    mkdirSync(path.join(dir, "data"));
    writeFileSync(path.join(dir, "data", "tokens.json"), readFileSync(def));
    const child = spawn(process.execPath, [path.join(ROOT, "scripts", "enrich-decimals.mjs"),
      `--registry=${alt}`, "--api", `http://127.0.0.1:${api.address().port}`], { cwd: dir });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { out += c; });
    const code = await new Promise((r) => child.on("close", r));
    await new Promise((r) => api.close(r));
    assert.equal(code, 0, `success (out: ${out.slice(0, 200)})`);
    assert.equal(JSON.parse(readFileSync(alt, "utf8"))[0].decimals, 8, "the equals form enriched the SPECIFIED file");
    assert.equal(JSON.parse(readFileSync(path.join(dir, "data", "tokens.json"), "utf8"))[0].decimals, null, "the default one untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
import { mkdirSync } from "node:fs";

// ---- F1-3: the pid liveness of the journal lock ----

const entry = (m) => ({ lastEffective: m, observedAt: "2026-09-24T00:00:00.000Z", events: [] });

test("journal lock: a LIVE owner with an ancient mtime is NOT broken (pid liveness, R9 #9)", () => {
  const dir = tmp("lw-f1c-");
  try {
    const jp = path.join(dir, "j.json");
    const lock = `${jp}.lock`;
    writeFileSync(jp, JSON.stringify({ A: entry("1") }));
    writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: "2026-09-24T00:00:00.000Z" }));
    utimesSync(lock, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000)); // an hour ago
    const t0 = Date.now();
    saveJournalMerged(jp, { B: entry("2") }, { staleMs: 10_000, attempts: 3, retryPauseMs: 1 });
    assert.ok(Date.now() - t0 < 2000, "no long waiting: fast retries and degradation");
    assert.ok(existsSync(lock), "the LIVE owner's lock was not torn down (the write degraded without the lock)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("journal lock: a DEAD pid is broken IMMEDIATELY, even with a completely fresh mtime", () => {
  const dir = tmp("lw-f1d-");
  try {
    const jp = path.join(dir, "j.json");
    const lock = `${jp}.lock`;
    writeFileSync(jp, JSON.stringify({ A: entry("1") }));
    writeFileSync(lock, JSON.stringify({ pid: 2_000_000_000, createdAt: new Date().toISOString() })); // a pid outside the OS range = dead
    const t0 = Date.now();
    saveJournalMerged(jp, { B: entry("2") }, { staleMs: 10_000, attempts: 600, retryPauseMs: 5 });
    assert.ok(Date.now() - t0 < 2000, "an orphan after kill -9 does not burn staleMs — the pid-based break is instant (used to be ~10s)");
    const after = JSON.parse(readFileSync(jp, "utf8"));
    assert.ok(after.A && after.B, "the merge went through under the taken lock");
    assert.ok(!existsSync(lock), "the lock is cleaned up after itself");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- F1-4: a future mtime ----

test("journal lock: a future mtime (a clock skew) — broken immediately, not a 10s wait", () => {
  const dir = tmp("lw-f1e-");
  try {
    const jp = path.join(dir, "j.json");
    const lock = `${jp}.lock`;
    writeFileSync(jp, JSON.stringify({ A: entry("1") }));
    writeFileSync(lock, "legacy-not-json"); // legacy content: the pid check is not applicable
    utimesSync(lock, new Date(Date.now() + 3600_000), new Date(Date.now() + 3600_000)); // an mtime from the future
    const t0 = Date.now();
    saveJournalMerged(jp, { B: entry("2") }, { staleMs: 10_000, attempts: 600, retryPauseMs: 5 });
    assert.ok(Date.now() - t0 < 2000, "age < 0 = a break candidate immediately");
    assert.ok(!existsSync(lock), "the future lock is broken and removed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
