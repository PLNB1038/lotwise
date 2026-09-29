// The --demo launch grammar: the mode has zero network, so the launch line must not
// contradict itself. The contract:
//   1. --demo with --rpc is refused BEFORE any I/O (the parser discipline of
//      src/cli/flags.mjs): exit code 1, the reason on stderr, no boot, no DNS probe, no
//      port check. An operator writing `--demo --rpc $LOTWISE_RPC_URL` in a unit file gets
//      a loud refusal instead of a demo that silently never touches the given endpoint.
//   2. the RPC from the ENVIRONMENT is a different case: prod units carry LOTWISE_RPC_URL
//      globally and a demo on the same host must still boot — only the explicit flag is a
//      contradiction.
//   3. -h/--help wins over validation: a lost operator gets the usage text, which also
//      says what --demo is and how old its snapshot is.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseServeArgs, ServeArgsError } from "../src/cli/flags.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("flags: --demo with --rpc is refused — every order and both spellings, the flag named", () => {
  for (const argv of [
    ["--demo", "--rpc", "https://rpc.example.test"],
    ["--rpc", "https://rpc.example.test", "--demo"],
    ["--demo=true", "--rpc=https://rpc.example.test"],
    ["--rpc=https://rpc.example.test", "--demo=true"],
    ["--demo", "--rpc=https://rpc.example.test", "--port", "9000"],
    ["--rpc", "https://rpc.example.test", "--demo", "--host", "0.0.0.0"],
  ]) {
    assert.throws(
      () => parseServeArgs(argv),
      (err) =>
        err instanceof ServeArgsError &&
        err.flag === "--rpc" &&
        /--demo boots a static snapshot with no network; remove --rpc or remove --demo/.test(err.message),
      `${argv.join(" ")} must be refused with the reason spelled out`,
    );
  }
});

test("flags: --demo=false with --rpc boots the live feed — the refusal is about the mode, not the flag", () => {
  const args = parseServeArgs(["--demo=false", "--rpc", "https://rpc.example.test"]);
  assert.equal(args.demo, false, "an explicit off switch is the live boot");
  assert.equal(args.rpcUrl, "https://rpc.example.test");
});

test("flags: --demo with the RPC from the environment still boots — prod carries the env globally", () => {
  const args = parseServeArgs(["--demo"], { LOTWISE_RPC_URL: "https://rpc.example.test" });
  assert.equal(args.demo, true);
  assert.equal(args.rpcUrl, "https://rpc.example.test", "the env value parses as before; the demo simply never uses it");
});

test("flags: -h/--help wins over validation — a lost operator gets help, not a refusal", () => {
  assert.equal(parseServeArgs(["--help"]).help, true);
  assert.equal(parseServeArgs(["-h"]).help, true);
  assert.equal(parseServeArgs([]).help, false, "the default is the boot, not the help");
  // garbage elsewhere must not shadow the help request
  assert.equal(parseServeArgs(["--help", "--port", "abc"]).help, true);
  assert.equal(parseServeArgs(["--help"], { LOTWISE_RPC_URL: "not-a-url" }).help, true);
});

test("serve.mjs: --demo --rpc refuses with exit 1 before any I/O — no boot banner, no DNS probe", async () => {
  const refused = await runServe(["--demo", "--rpc", "https://rpc.example.test", "--port", "8787"]);
  assert.equal(refused.code, 1, "a refused launch is an error, not a boot");
  assert.match(refused.stderr, /--demo boots a static snapshot with no network; remove --rpc or remove --demo/);
  assert.doesNotMatch(refused.stderr + refused.stdout, /DEMO MODE/, "the boot never started");
  // the refusal must win over the guards that DO touch the system: DNS resolution of a
  // garbage --host happens after the parser — a refusal about the host instead of the
  // contradiction would mean the parser lost its place
  const viaHost = await runServe(["--demo", "--rpc", "https://rpc.example.test", "--host", "no-such-host.invalid"]);
  assert.equal(viaHost.code, 1);
  assert.match(viaHost.stderr, /--demo boots a static snapshot with no network/);
  assert.doesNotMatch(viaHost.stderr, /does not resolve/, "the DNS probe never ran");
});

test("serve.mjs: --help exits 0 and says what --demo is and how old the snapshot is", async () => {
  const help = await runServe(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--demo/);
  assert.match(help.stdout, /frozen at \d{4}-\d{2}-\d{2}/, "the freeze point is printed, not hidden in the source");
  assert.match(help.stdout, /--rpc/);
});

// A free port for every launch: a refused boot must not collide with a real listener, and
// the help run must not occupy the default 8787 while the suite runs.
async function runServe(extraArgs, { timeoutMs = 10_000 } = {}) {
  const freePort = await new Promise((resolve) => {
    const probe = createServer();
    probe.once("listening", () => {
      const { port } = probe.address(); // read BEFORE close: after "close" address() is null
      probe.close(() => resolve(port));
    });
    probe.listen(0, "127.0.0.1");
  });
  const argv = [path.join(ROOT, "scripts", "serve.mjs"), ...extraArgs.map((a) => a.replace("8787", String(freePort)))];
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, argv);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: "timeout — the process was expected to exit on its own", stdout, stderr });
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
