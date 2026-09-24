// formerly round17-i2.test.mjs
// Round 17 — wave I2 (the integrator): subscribing to webhooks by SYMBOL must work.
// Canonical events carry only mint — a ["SPYx"] subscription silently gave 0 deliveries
// with exit 0 (a quiet failure). Fix: deliverToAll accepts symbolToMint (the registry),
// the CLI loads data/tokens.json and resolves the subscription symbols into mints before matching;
// an unknown symbol — a warning (a typo is visible immediately), it does not block delivery.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deliverToAll } from "../src/webhooks/subscriptions.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPYX_MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";

const event = {
  type: "MULTIPLIER_CHANGE", mint: SPYX_MINT,
  effectiveDate: "2026-06-10T04:30:00.000Z", status: "confirmed",
  sources: ["https://issuer.example/hist"], multiplierFrom: "1", multiplierTo: "5",
  reason: "Rebase",
};
const sub = (symbols) => ({
  id: "wh_x", url: "https://example.com/hook", symbols, secret: "s1",
  createdAt: "2026-09-25T00:00:00.000Z", active: true,
});
const ok200 = async () => new Response("ok", { status: 200 });
const sleep0 = async () => {};

test("webhooks: a [\"SPYx\"] subscription DELIVERS a mint-only event via the registry map", async () => {
  const map = new Map([["SPYx", SPYX_MINT]]);
  let posts = 0;
  const fetcher = async () => { posts++; return new Response("ok", { status: 200 }); };
  const rep = await deliverToAll([event], [sub(["SPYx"])], { fetcher, sleep: sleep0, symbolToMint: map });
  assert.equal(posts, 1, "a delivery attempt was made");
  assert.equal(rep.delivered, 1, "the symbol subscription worked via the mint");
  assert.equal(rep.failed, 0);
  assert.equal(rep.warnings.length, 0);
});

test("webhooks: without the map — the previous behavior (a symbol subscription does not match mint-only)", async () => {
  let posts = 0;
  const fetcher = async () => { posts++; return new Response("ok", { status: 200 }); };
  const rep = await deliverToAll([event], [sub(["SPYx"])], { fetcher, sleep: sleep0 });
  assert.equal(posts, 0);
  assert.equal(rep.delivered, 0, "without the map there is no matching (backward compatible)");
});

test("webhooks: a symbol outside the registry — a warning, delivery is not blocked", async () => {
  const map = new Map([["SPYx", SPYX_MINT]]);
  const rep = await deliverToAll([event], [sub(["SPYX_TYPO"])], { fetcher: ok200, sleep: sleep0, symbolToMint: map });
  assert.equal(rep.delivered, 0);
  assert.ok(rep.warnings.some((w) => /SPYX_TYPO/.test(w) && /not found in the registry/.test(w)), // round 19: EN
    "the typo is visible in the report warnings");
});

test("webhooks: the CLI resolves symbols via data/tokens.json — a subscription symbol matches a mint-only event", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lw-i2-"));
  try {
    mkdirSync(path.join(dir, "data"));
    writeFileSync(path.join(dir, "data", "tokens.json"), JSON.stringify([
      { symbol: "SPYx", name: "S&P 500", mint: SPYX_MINT, decimals: 8, issuer: "backed" },
    ]));
    writeFileSync(path.join(dir, "subs.json"), JSON.stringify([
      { id: "wh_a", url: "https://example.com/hook", symbols: ["SPYx"], secret: "s1", createdAt: "2026-09-25T00:00:00.000Z", active: true },
    ]));
    writeFileSync(path.join(dir, "events.json"), JSON.stringify([event]));
    // a public URL: the delivery honestly fails (example.com will not accept) — but the ATTEMPT
    // happens: before the fix the exit was 0 with delivered=0/skipped=0 (nothing matched — silence)
    const child = spawn(process.execPath, [path.join(ROOT, "scripts", "webhook-deliver.mjs"),
      "--events", path.join(dir, "events.json"), "--subscriptions", path.join(dir, "subs.json")], { cwd: dir });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { out += c; });
    const code = await new Promise((r) => child.on("close", r));
    assert.equal(code, 1, `a delivery failure = the contract 1 (out: ${out.slice(0, 300)})`);
    assert.match(out, /failed=1/, "the ATTEMPT was made — the symbol matched via the CLI registry");
    assert.doesNotMatch(out, /delivered=0, skipped=0, failed=0/, "not a \"quiet zero\" as before the fix");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
