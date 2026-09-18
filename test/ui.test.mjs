import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/api/server.mjs";
import { multiplierHistoryToEvents, bindMintAndValidate } from "../src/events/normalize-xstocks.mjs";
import { loadRegistry } from "../src/registry/registry.mjs";
import { parseScaledUiAmount } from "../src/issuer/scaled-ui.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const SPYx = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";

const historyNodes = JSON.parse(readFileSync(path.join(dir, "xstocks-spyx-history-eth.json"), "utf8")).nodes;
const events = bindMintAndValidate(multiplierHistoryToEvents(historyNodes, { symbol: "SPYx" }), SPYx);
const onchainFixture = JSON.parse(readFileSync(path.join(dir, "onchain-spyx-mint.json"), "utf8"));

async function withServer(opts, fn) {
  if (typeof opts === "function") fn = opts; // withServer(fn) — без опций
  const { onchainReader = null } = typeof opts === "object" && opts !== null ? opts : {};
  const registry = await loadRegistry("data/tokens.json");
  const server = await createApiServer({ registry, events, onchainReader });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("/ отдаёт самодостаточную витрину-страницу", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
    const html = await res.text();
    assert.ok(html.includes("<title>Lotwise"));
    assert.ok(html.includes('id="tokens"'));
    assert.ok(html.includes("/summary"));
    assert.ok(html.includes("/onchain"));
    // самодостаточность: никаких внешних ресурсов, всё — относительные fetch к своему API
    assert.ok(!html.includes('src="http'));
    assert.ok(!html.includes('href="http'));
    // шаблонный литерал вычислен полностью, без остатков
    assert.ok(!html.includes("${"));
  });
});

test("/summary: 26 строк, сортировка событиями, множитель сегодня у SPYx", async () => {
  await withServer(async (base) => {
    const rows = await (await fetch(`${base}/summary`)).json();
    assert.equal(rows.length, 26);
    // событийные токены впереди, дальше по алфавиту
    assert.equal(rows[0].symbol, "SPYx");
    assert.equal(rows[0].events, 4);
    assert.equal(rows[0].currentMultiplier, "1.005714560286254");
    assert.equal(rows[0].decimals, 8);
    const quiet = rows.filter((r) => r.events === 0);
    assert.ok(quiet.length > 0);
    assert.ok(quiet.every((r) => r.currentMultiplier === "1"));
    const syms = quiet.map((r) => r.symbol);
    assert.deepEqual(syms, [...syms].sort((a, b) => a.localeCompare(b)));
  });
});

test("/onchain без ридера — 503 с понятной причиной", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/onchain?symbol=SPYx`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.match(body.error, /not configured/);
  });
});

test("/onchain: живой план SPYx (active 1.0039 + pending 1.0057) сегодня сходится через pending-правило", async () => {
  const parsed = parseScaledUiAmount(onchainFixture.result.value);
  await withServer({ onchainReader: async () => parsed }, async (base) => {
    const res = await fetch(`${base}/onchain?symbol=SPYx`);
    assert.equal(res.status, 200);
    const b = await res.json();
    assert.equal(b.onChain.active, "1.003909240011759");
    assert.equal(b.onChain.pending, "1.005714560286254");
    // поле active в цепи до сих пор не ротировано, но pending эффективен с 18.06.2026 —
    // наше правило pending-после-таймстампа даёт effective = API current
    assert.equal(b.onChainEffective, "1.005714560286254");
    assert.equal(b.api, "1.005714560286254");
    assert.equal(b.verdict, "ok");
  });
});

test("/onchain: внутри окна активации (до таймстампа pending) оба плана ещё на 1.0039 — согласовано", async () => {
  const parsed = parseScaledUiAmount(onchainFixture.result.value);
  await withServer({ onchainReader: async () => parsed }, async (base) => {
    const b = await (await fetch(`${base}/onchain?symbol=SPYx&date=2026-06-01T00:00:00Z`)).json();
    assert.equal(b.api, "1.003909240011759");
    assert.equal(b.onChainEffective, "1.003909240011759"); // pending ещё не эффективен -> active
    assert.equal(b.verdict, "ok");
  });
});

test("/onchain: расхождение планов ловится — цепь без pending, API уже применил событие", async () => {
  // наивное чтение цепи (только active, pending не назначен) против API current
  const staleChain = {
    program: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    decimals: 8,
    activeMultiplier: "1.003909240011759",
    pendingMultiplier: null,
    pendingEffectiveDate: null,
    authority: "S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS",
    hasExtension: true,
  };
  await withServer({ onchainReader: async () => staleChain }, async (base) => {
    const b = await (await fetch(`${base}/onchain?symbol=SPYx`)).json();
    assert.equal(b.api, "1.005714560286254");
    assert.equal(b.onChainEffective, "1.003909240011759");
    assert.equal(b.verdict, "planes-disagree");
  });
});

test("/onchain: источник недоступен — fail-closed 503 с kind, витрина не врёт", async () => {
  const err = new Error("HTTP 429");
  err.kind = "rate-limit";
  await withServer({ onchainReader: async () => { throw err; } }, async (base) => {
    const res = await fetch(`${base}/onchain?symbol=SPYx`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.kind, "rate-limit");
    assert.match(body.error, /429/);
  });
});

test("/onchain без mint/symbol — понятная 400", async () => {
  await withServer({ onchainReader: async () => parseScaledUiAmount(onchainFixture.result.value) }, async (base) => {
    const res = await fetch(`${base}/onchain`);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /mint or symbol required/);
  });
});
