// The earliest signal window: the boot handlers must exist BEFORE the first await, not
// merely after the pre-boot I/O. They used to be installed only AFTER the DNS-resolve and
// port-probe awaits — a SIGTERM landing while those were still in flight hit the DEFAULT
// termination (exit 143, no line in the log), exactly what the handlers exist to prevent.
// The test fires the signal ~1ms into the process and demands the named boot-abort line
// and the clean exit 1 (the bridge's no-handler emulation of a default termination must
// stay silent). Windows cannot signal a child, so the bridge
// (test/fixtures/sigterm-after.cjs) emits inside the serve process, as in
// boot-rpc-deadline.test.mjs. --host is deliberately NOT an IP literal: a numeric host
// resolves inside the promise chain without a real loop turn, and the window the test
// targets never opens; a name that must be resolved keeps the DNS await a genuine
// async hop — the documented shape of the gap (a slow or broken resolver hangs it
// for seconds).

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
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

test("SIGTERM in the boot's first milliseconds aborts with the named line — the handlers precede the first await", async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVE, "--port", String(port), "--host", "localhost", "--demo"], {
    cwd: ROOT,
    env: { ...process.env, NODE_OPTIONS: `--require "${SIGTERM_BRIDGE}"`, LOTWISE_TEST_SIGTERM_AFTER_MS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve("timeout");
    }, 15_000);
    child.once("exit", (c) => { clearTimeout(timer); resolve(c); });
  });
  assert.notEqual(code, "timeout", "the signal neither aborted nor killed the boot within 15s");
  assert.equal(code, 1, "an aborted boot is a clean failure, not the default 143");
  assert.match(stderr, /SIGTERM during boot/, "the abort names the signal and the phase");
  assert.doesNotMatch(stdout + stderr, /default-terminate/, "the bridge's no-handler emulation must not fire: the handler already existed");
  assert.doesNotMatch(stdout, /Lotwise API/, "the server never listened");
});
