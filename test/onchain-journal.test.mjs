import test from "node:test";
import assert from "node:assert/strict";
import { backfillMultiplierEvent, journalTransition, OnchainNormalizeError } from "../src/events/normalize-onchain.mjs";
import { parseScaledUiAmount } from "../src/issuer/scaled-ui.mjs";
import { multiplierHistoryToEvents } from "../src/events/normalize-xstocks.mjs";
import { MultiplierTimeline } from "../src/lots/timeline.mjs";
import { loadRegistry } from "../src/registry/registry.mjs";
import { createApiServer } from "../src/api/server.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name) => parseScaledUiAmount(JSON.parse(readFileSync(path.join(dir, name), "utf8")).result.value);
const registryOf = async () => await loadRegistry("data/tokens.json");
const tokenOf = async (symbol) => (await registryOf()).find((t) => t.symbol === symbol);

// «сейчас» после обеих дат активации — как в живом прогоне 19.09
const NOW = Date.parse("2026-09-19T00:00:00Z");

test("SPACEX: живой минт отдаёт бэкфилл 1 -> 5 @ 2026-06-10", async () => {
  const t = await tokenOf("SPACEX");
  const parsed = fixture("onchain-spacex-mint.json");
  const e = backfillMultiplierEvent(t, parsed, NOW);
  assert.ok(e);
  assert.equal(e.type, "MULTIPLIER_CHANGE");
  assert.equal(e.multiplierFrom, "1");
  assert.equal(e.multiplierTo, "5");
  assert.equal(e.effectiveDate, "2026-06-10T04:30:00.000Z");
  assert.equal(e.status, "confirmed");
  assert.ok(e.sources[0].includes(t.mint));
});

test("OPENAI: бэкфилл 1 -> 1.4861347 @ 2026-07-17", async () => {
  const t = await tokenOf("OPENAI");
  const e = backfillMultiplierEvent(t, fixture("onchain-openai-mint.json"), NOW);
  assert.equal(e.multiplierFrom, "1");
  assert.equal(e.multiplierTo, "1.4861347");
  assert.equal(e.effectiveDate, "2026-07-17T16:30:00.000Z");
});

test("T-SpaceX (Tessera): extension нет — null, это факт, а не ошибка", async () => {
  const t = await tokenOf("T-SpaceX");
  assert.equal(backfillMultiplierEvent(t, fixture("onchain-t-spacex-mint.json"), NOW), null);
});

test("pending с будущей датой: событие датировано будущим, effective сейчас не меняется", async () => {
  const t = await tokenOf("SPACEX");
  const parsed = {
    hasExtension: true, decimals: 8,
    activeMultiplier: "5",
    pendingMultiplier: "6",
    pendingEffectiveDate: "2026-12-01T00:00:00.000Z",
    authority: null,
  };
  const e = backfillMultiplierEvent(t, parsed, NOW);
  assert.equal(e.multiplierFrom, "5");
  assert.equal(e.multiplierTo, "6");
  assert.equal(e.effectiveDate, "2026-12-01T00:00:00.000Z");
});

test("journal: первое наблюдение SPACEX — бэкфилл-событие + entry с эффективной величиной", async () => {
  const t = await tokenOf("SPACEX");
  const { event, entry } = journalTransition(t, fixture("onchain-spacex-mint.json"), null, NOW);
  assert.ok(event);
  assert.equal(entry.lastEffective, "5"); // pending 10.06 уже в силе
  assert.equal(entry.observedAt, new Date(NOW).toISOString());
});

test("journal: без изменений — нет события, entry обновляет только observedAt", async () => {
  const t = await tokenOf("SPACEX");
  const { event, entry } = journalTransition(t, fixture("onchain-spacex-mint.json"), { lastEffective: "5", observedAt: "2026-09-01T00:00:00Z" }, NOW);
  assert.equal(event, null);
  assert.equal(entry.lastEffective, "5");
});

test("journal: ротация 5 -> 7 по новому pending ловится диффом", async () => {
  const t = await tokenOf("SPACEX");
  const rotated = {
    hasExtension: true, decimals: 8,
    activeMultiplier: "5", // поле ещё не ротировано (наблюдаемый паттерн цепи)
    pendingMultiplier: "7",
    pendingEffectiveDate: "2026-09-15T00:00:00.000Z",
    authority: null,
  };
  const { event, entry } = journalTransition(t, rotated, { lastEffective: "5", observedAt: "2026-09-01T00:00:00Z" }, NOW);
  assert.ok(event);
  assert.equal(event.multiplierFrom, "5");
  assert.equal(event.multiplierTo, "7");
  assert.equal(event.effectiveDate, "2026-09-15T00:00:00.000Z");
  assert.equal(entry.lastEffective, "7");
});

test("журнальные события совместимы с MultiplierTimeline: SPACEX множитель сегодня = 5", async () => {
  const t = await tokenOf("SPACEX");
  const e = backfillMultiplierEvent(t, fixture("onchain-spacex-mint.json"), NOW);
  const tl = new MultiplierTimeline([e]);
  assert.equal(tl.multiplierAt("2026-06-09T23:59:59Z"), "1");
  assert.equal(tl.multiplierAt("2026-06-10T04:30:00Z"), "5");
  assert.equal(tl.multiplierAt(new Date(NOW).toISOString()), "5");
  // скорректированное количество: 2 SPACEX raw -> 10 scaled
  const s = tl.scaledQty(200000000n, new Date(NOW).toISOString());
  assert.equal(s.whole, 1000000000n);
  assert.equal(s.exact, true);
});

test("интеграция: /summary видит on-chain события (SPACEX events=1, multiplier=5)", async () => {
  const registry = await registryOf();
  const events = [];
  for (const symbol of ["SPACEX", "OPENAI"]) {
    const t = await tokenOf(symbol);
    const e = backfillMultiplierEvent(t, fixture(`onchain-${symbol.toLowerCase()}-mint.json`), NOW);
    if (e) events.push(e);
  }
  const server = await createApiServer({ registry, events });
  const { port } = server.address();
  try {
    const rows = await (await fetch(`http://127.0.0.1:${port}/summary`)).json();
    const spacex = rows.find((r) => r.symbol === "SPACEX");
    assert.equal(spacex.events, 1);
    assert.equal(spacex.currentMultiplier, "5");
    const openai = rows.find((r) => r.symbol === "OPENAI");
    assert.equal(openai.currentMultiplier, "1.4861347");
    const tesla = rows.find((r) => r.symbol === "T-SpaceX"); // без extension — множитель 1, честно
    assert.equal(tesla.events, 0);
    assert.equal(tesla.currentMultiplier, "1");
  } finally {
    server.close();
  }
});

test("битая дата в pending отклоняется валидацией схемы, а не молча", async () => {
  const t = await tokenOf("SPACEX");
  const bad = {
    hasExtension: true, decimals: 8,
    activeMultiplier: "1",
    pendingMultiplier: "5",
    pendingEffectiveDate: "not-a-date",
    authority: null,
  };
  assert.throws(() => backfillMultiplierEvent(t, bad, NOW), OnchainNormalizeError);
});
