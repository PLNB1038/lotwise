// Boot-path hardening (round 49, the r48 SRE [P2] finding):
//   1. Boot RPC reads carry a deadline — an endpoint that accepts and never answers used
//      to park the boot on undici's default transport timeout (300s, with retries): hours
//      of silence before listen, past any systemd TimeoutStartSec — a start-timeout
//      restart-loop on a half-dead node behind LOTWISE_RPC_URL. Now the first silent
//      read refuses the boot: a named line on stderr and a clean non-zero exit, no listen.
//   2. Signals are handled from the FIRST boot await — a SIGTERM during boot used to hit
//      the default termination with no line in the log; now it aborts cleanly (named
//      line, exit 1) instead of an anonymous 143.
// Both tests spawn the real scripts/serve.mjs against localhost fakes; zero external
// traffic (the boot never gets past the first on-chain read in either scenario).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVE = path.join(ROOT, "scripts", "serve.mjs");
const SIGTERM_BRIDGE = path.join(ROOT, "test", "fixtures", "sigterm-after.cjs").replaceAll("\\", "/");

async function freePort() {
  return await new Promise((resolve) => {
    const probe = createServer();
    probe.once("listening", () => {
      const { port } = probe.address(); // read BEFORE close: after "close" address() is null
      probe.close(() => resolve(port));
    });
    probe.listen(0, "127.0.0.1");
  });
}

// A black hole: accepts TCP and never answers anything. Undici's own transport timeout
// is 300s — the test horizon kills the child long before, which is exactly the hang
// this test pins the fix against.
async function blackholeRpc() {
  const sockets = new Set();
  const server = createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    // deliberate silence: no parser, no response, ever
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    close: () => { for (const s of sockets) s.destroy(); server.close(); },
  };
}

// A live-speaking but very slow RPC: getAccountInfo answers only after 30s (bounded —
// always eventually answers; the test's finally destroys anything still pending).
async function slowRpc({ delayMs }) {
  const sockets = new Set();
  const timers = new Set();
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const t = setTimeout(() => {
        timers.delete(t);
        const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: null } });
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
        res.end(payload);
      }, delayMs);
      timers.add(t);
      // a caller that died before the answer (the child aborts/exits) releases the
      // pending timer at once — no lingering handle may stretch the test process
      req.on("close", () => { if (timers.delete(t)) clearTimeout(t); });
      req.on("error", () => {});
    });
  });
  server.on("connection", (sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    close: () => {
      for (const t of timers) clearTimeout(t);
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

// Spawns serve.mjs, collects stdout/stderr, resolves on exit — or kills the child at the
// horizon and resolves code "timeout" (the honest shape of a hang).
async function runServe({ args, env = {}, timeoutMs, preload = null }) {
  const port = await freePort();
  const nodeOptions = preload ? `--require "${preload}"` : "";
  const child = spawn(process.execPath, [SERVE, "--port", String(port), "--host", "127.0.0.1", ...args], {
    cwd: ROOT,
    env: { ...process.env, NODE_OPTIONS: nodeOptions, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const t0 = Date.now();
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve("timeout");
    }, timeoutMs);
    child.once("exit", (c) => { clearTimeout(timer); resolve(c); });
  });
  return { code, stdout, stderr, elapsed: Date.now() - t0 };
}

test("a black-hole RPC endpoint refuses the boot within the deadline: named error, exit 1, no listen", async () => {
  const rpc = await blackholeRpc();
  try {
    const run = await runServe({
      args: ["--rpc", `http://127.0.0.1:${rpc.port}`],
      timeoutMs: 25_000, // the deadline is 10s; 25s proves the boot did not hang past it
    });
    assert.notEqual(run.code, "timeout", `the boot hung past the 25s horizon (exit=${run.code}) — no RPC deadline on the boot path`);
    assert.equal(run.code, 1, "a boot that cannot read the chain is a clean failure, not a listen");
    assert.ok(run.elapsed < 20_000, `the boot must fail at the deadline, not limp for minutes (${run.elapsed}ms)`);
    assert.match(run.stderr, /did not answer within \d+ms/, "the error names the silent endpoint and the deadline");
    assert.match(run.stderr, /refusing to listen degraded/, "the decision (no degraded listen) is spelled out");
    assert.equal((run.stderr.match(/did not answer within/g) ?? []).length, 1, "the boot refuses at the FIRST silent read instead of limping through per-token warns");
    assert.doesNotMatch(run.stdout, /Lotwise API/, "the server never came up on a dead chain");
  } finally {
    rpc.close();
  }
});

test("SIGTERM during boot aborts cleanly: named line, exit 1, no listen — not a default termination", async () => {
  const rpc = await slowRpc({ delayMs: 30_000 }); // the boot is parked mid on-chain read
  try {
    const run = await runServe({
      args: ["--rpc", `http://127.0.0.1:${rpc.port}`],
      env: { LOTWISE_TEST_SIGTERM_AFTER_MS: "1200" },
      preload: SIGTERM_BRIDGE,
      timeoutMs: 15_000,
    });
    assert.notEqual(run.code, "timeout", `the signal neither aborted nor killed the boot within 15s (exit=${run.code})`);
    assert.equal(run.code, 1, "an aborted boot is a clean failure, not the anonymous 143");
    assert.match(run.stderr, /SIGTERM during boot/, "the abort names the signal and the phase");
    assert.doesNotMatch(run.stdout + run.stderr, /default-terminate/, "the bridge's no-handler emulation must not fire: a real handler existed");
    assert.doesNotMatch(run.stdout, /Lotwise API/, "the server never listened");
    assert.ok(run.elapsed < 8_000, `the abort is prompt, not a wait for the boot I/O (${run.elapsed}ms)`);
  } finally {
    rpc.close();
  }
});
