// Раунд 17 — волна I2 (интегратор): подписка вебхуков по СИМВОЛУ обязана работать.
// Канонические события несут только mint — подписка ["SPYx"] молча давала 0 доставок
// при exit 0 (тихая неудача). Фикс: deliverToAll принимает symbolToMint (реестр),
// CLI грузит data/tokens.json и резолвит символы подписок в минты до матчинга;
// неизвестный символ — warning (опечатка видна сразу), не блокирует доставку.
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

test("webhooks: подписка [\"SPYx\"] ДОСТАВЛЯЕТ mint-only событие через реестр-карту", async () => {
  const map = new Map([["SPYx", SPYX_MINT]]);
  let posts = 0;
  const fetcher = async () => { posts++; return new Response("ok", { status: 200 }); };
  const rep = await deliverToAll([event], [sub(["SPYx"])], { fetcher, sleep: sleep0, symbolToMint: map });
  assert.equal(posts, 1, "попытка доставки была");
  assert.equal(rep.delivered, 1, "символьная подписка сработала через минт");
  assert.equal(rep.failed, 0);
  assert.equal(rep.warnings.length, 0);
});

test("webhooks: без карты — прежнее поведение (символьная подписка не матчит mint-only)", async () => {
  let posts = 0;
  const fetcher = async () => { posts++; return new Response("ok", { status: 200 }); };
  const rep = await deliverToAll([event], [sub(["SPYx"])], { fetcher, sleep: sleep0 });
  assert.equal(posts, 0);
  assert.equal(rep.delivered, 0, "без карты матчинга нет (обратно-совместимо)");
});

test("webhooks: символ вне реестра — warning, доставка не блокируется", async () => {
  const map = new Map([["SPYx", SPYX_MINT]]);
  const rep = await deliverToAll([event], [sub(["SPYX_TYPO"])], { fetcher: ok200, sleep: sleep0, symbolToMint: map });
  assert.equal(rep.delivered, 0);
  assert.ok(rep.warnings.some((w) => /SPYX_TYPO/.test(w) && /не найден в реестре/.test(w)),
    "опечатка видна в warnings отчёта");
});

test("webhooks: CLI резолвит символы через data/tokens.json — символ подписки матчит mint-only событие", async () => {
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
    // публичный URL: доставка честно провалится (example.com не примет) — но ПРОИЗОЙДЁТ
    // попытка: до фикса exit был 0 с delivered=0/skipped=0 (никто не матчился — тишина)
    const child = spawn(process.execPath, [path.join(ROOT, "scripts", "webhook-deliver.mjs"),
      "--events", path.join(dir, "events.json"), "--subscriptions", path.join(dir, "subs.json")], { cwd: dir });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { out += c; });
    const code = await new Promise((r) => child.on("close", r));
    assert.equal(code, 1, `провал доставки = контрактный 1 (out: ${out.slice(0, 300)})`);
    assert.match(out, /failed=1/, "ПОПЫТКА была — символ сматчился через реестр CLI");
    assert.doesNotMatch(out, /delivered=0, skipped=0, failed=0/, "не «тихий ноль» как до фикса");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
