// The boot loop binds BEFORE it assigns: every event planJournalStep hands out passes
// bindMintAndValidate before it enters the journal map or the events stream. The
// journal's corruption gate makes the THROW path unreachable (a distrusted history never
// reaches this line), so the guard's observable job is the BINDING itself: journal
// elements carry the WRITER's fields and a genuine legacy record may lack mint, while
// the events stream is indexed by e.mint. Without the boot-side binding, a mint-less
// replayed event is pushed raw — "replayed" per /health, yet invisible to /events under
// the token's mint: the history a restart was supposed to preserve silently vanishes
// from every reader while the counts look healthy.
// The test boots the REAL scripts/serve.mjs against a copied tree (the script anchors
// every path at its own location, so the copy isolates data/ from the repo's), a seeded
// journal with a mint-less legacy element, and an unreachable RPC port (connection
// refused → the chain is "unavailable at boot", the documented replay-from-cache path).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// a real-shaped registry entry (the issuer/mint/symbol vocabulary the loader validates)
const TOKEN = {
  mint: "PresTj4Yc2bAR197Er7wz4UUKSfqt6FryBEdAriBoQB",
  symbol: "ANDURIL",
  name: "Anduril PreStocks",
  issuer: "prestocks",
  decimals: 9,
  sourceUrl: "stockbasis-verified",
  verified: "carried+rpc",
  sourceDecimals: "jupiter",
};

// a legacy writer's element: schema-valid in every field EXCEPT mint — the writer's
// token supplied it, and the boot's binding must supply it again (the gate does the same
// on copies; what the STREAM receives must be the bound form)
const LEGACY_EVENT = {
  type: "MULTIPLIER_CHANGE",
  effectiveDate: "2026-06-10T04:30:00.000Z",
  status: "confirmed",
  sources: ["solana:getAccountInfo:x#scaledUiAmountConfig"],
  multiplierFrom: "1", multiplierTo: "5",
};

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

const getJson = (port, path) => new Promise((resolve, reject) => {
  http.get({ host: "127.0.0.1", port, path }, (res) => {
    let body = "";
    res.on("data", (c) => (body += c));
    res.on("end", () => resolve({ status: res.statusCode, body }));
  }).on("error", reject);
});

test("boot replays the journal's legacy history BOUND: /events serves it under the token's mint", async () => {
  // stage an isolated tree: serve.mjs anchors registry/journal/declarations at its own
  // location, so the copy keeps the repo's data/ untouched and the boot hermetic
  const stage = mkdtempSync(path.join(tmpdir(), "lotwise-boot-binding-"));
  cpSync(path.join(REPO, "scripts"), path.join(stage, "scripts"), { recursive: true });
  cpSync(path.join(REPO, "src"), path.join(stage, "src"), { recursive: true });
  mkdirSync(path.join(stage, "data"));
  writeFileSync(path.join(stage, "data", "tokens.json"), JSON.stringify([TOKEN]));
  writeFileSync(path.join(stage, "data", "onchain-journal.json"), JSON.stringify({
    [TOKEN.mint]: {
      lastEffective: "2",
      observedAt: "2026-09-01T00:00:00.000Z",
      events: [LEGACY_EVENT],
    },
  }, null, 1) + "\n");

  const port = await freePort();
  // an unreachable endpoint: the probe port is released, so the connection is refused
  // instantly (no black-hole wait) and the boot takes the chain-unavailable replay path
  const deadRpc = await freePort();
  const child = spawn(process.execPath, [
    // the STAGED copy: its own location anchors its data/ reads (the repo's tree stays out)
    path.join(stage, "scripts", "serve.mjs"),
    "--port", String(port), "--host", "127.0.0.1", "--rpc", `http://127.0.0.1:${deadRpc}`,
  ], { cwd: stage, stdio: ["ignore", "pipe", "pipe"] });
  child.unref();
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  try {
    // the boot waits out the RPC's own retry backoff before degrading — poll, don't guess
    let health = null;
    for (let t = 0; t < 30_000 && health === null; t += 150) {
      await new Promise((r) => setTimeout(r, 150));
      try {
        const res = await getJson(port, "/health");
        if (res.status === 200) health = JSON.parse(res.body);
      } catch { /* not listening yet */ }
    }
    assert.notEqual(health, null, `the server did not come up within 30s${stderr ? ` — stderr: ${stderr.slice(-400)}` : ""}`);
    assert.equal(health.journal.replayed, 1, "the boot DID replay the legacy history (the loss below is invisibility, not absence)");

    const events = await getJson(port, `/events?symbol=${TOKEN.symbol}`);
    assert.equal(events.status, 200);
    const list = JSON.parse(events.body);
    const rotation = list.find((e) => e.type === "MULTIPLIER_CHANGE" && e.multiplierTo === "5");
    assert.notEqual(rotation, undefined, "the replayed legacy event is invisible: it was pushed without its mint binding");
    assert.equal(rotation.mint, TOKEN.mint, "the events stream receives the event BOUND to the token's mint");
  } finally {
    child.kill();
    await new Promise((r) => child.once("exit", r));
    rmSync(stage, { recursive: true, force: true });
  }
});
