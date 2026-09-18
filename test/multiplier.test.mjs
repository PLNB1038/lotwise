import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isValidEvent } from "../src/schema/events.mjs";
import { multiplierHistoryToEvents, bindMintAndValidate } from "../src/events/normalize-xstocks.mjs";
import { decimalToRatio, MultiplierTimeline, TimelineError } from "../src/lots/timeline.mjs";
import { fetchMultiplierHistory } from "../src/issuer/xstocks.mjs";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W"; // SPYx

// ЖИВАЯ история SPYx (Ethereum): 4 дивиденда, новая сверху
const historyFixture = JSON.parse(readFileSync(path.join(dir, "xstocks-spyx-history-eth.json"), "utf8"));
const history = { hasNextPage: false, nodes: historyFixture.nodes.map((n) => ({ ...n })) };

const ev = (over = {}) => ({
  type: "MULTIPLIER_CHANGE",
  mint: MINT,
  effectiveDate: "2026-06-18T04:00:00.000Z",
  status: "confirmed",
  sources: ["https://api.xstocks.fi/api/v2/public/assets/SPYx/multiplier/history?network=Ethereum#node:x"],
  multiplierFrom: "1.003909240011759",
  multiplierTo: "1.005714560286254",
  reason: "Dividend",
  ...over,
});

// ---- схема ----

test("MULTIPLIER_CHANGE валиден с десятичными строками", () => {
  assert.equal(isValidEvent(ev()), true);
});

test("float вместо строки отклоняется (float запрещён)", () => {
  assert.equal(isValidEvent(ev({ multiplierTo: 1.0057 })), false);
});

test("битовый формат и from==to отклоняются", () => {
  assert.equal(isValidEvent(ev({ multiplierTo: "1.00.5" })), false);
  assert.equal(isValidEvent(ev({ multiplierTo: "-1.5" })), false);
  assert.equal(isValidEvent(ev({ multiplierTo: ev().multiplierFrom })), false);
});

// ---- нормализатор ----

test("живая история SPYx → 4 канонических события, старые→новые, схема валидна", () => {
  const events = bindMintAndValidate(multiplierHistoryToEvents(history.nodes, { symbol: "SPYx" }), MINT);
  assert.equal(events.length, 4);
  assert.equal(events[0].effectiveDate, "2025-10-31T23:55:00.000Z");
  assert.equal(events[0].multiplierFrom, "1");
  assert.equal(events[3].multiplierTo, "1.005714560286254");
  assert.equal(events[3].reason, "Dividend");
  for (const e of events) assert.equal(e.type, "MULTIPLIER_CHANGE");
});

test("источник события ссылается на конкретный узел API", () => {
  const events = multiplierHistoryToEvents(history.nodes, { symbol: "SPYx" });
  assert.match(events[0].sources[0], /#node:/);
});

// ---- decimalToRatio ----

test("«1» → 1/1; «1.005714560286254» → точная дробь", () => {
  assert.deepEqual(decimalToRatio("1"), { num: 1n, den: 1n });
  const r = decimalToRatio("1.005714560286254");
  assert.equal(r.num, 1005714560286254n);
  assert.equal(r.den, 10n ** 15n);
});

test("мусор отклоняется", () => {
  assert.throws(() => decimalToRatio("abc"), TimelineError);
  assert.throws(() => decimalToRatio(1.5), TimelineError);
  assert.throws(() => decimalToRatio("1.5.6"), TimelineError);
});

// ---- MultiplierTimeline ----

function spyxTimeline() {
  const events = bindMintAndValidate(multiplierHistoryToEvents(history.nodes, { symbol: "SPYx" }), MINT);
  return new MultiplierTimeline(events);
}

test("шкала из живой истории: множитель по датам до/между/после событий", () => {
  const tl = spyxTimeline();
  assert.equal(tl.multiplierAt("2025-10-30"), "1");
  assert.equal(tl.multiplierAt("2025-10-31T23:55:00.000Z"), "1.00099942056");
  assert.equal(tl.multiplierAt("2026-02-01"), "1.0025607582229898");
  assert.equal(tl.multiplierAt("2026-07-01"), "1.005714560286254");
  assert.equal(tl.multiplierAt("2099-01-01"), "1.005714560286254");
});

test("разрыв цепочки = ошибка, не догадка (fail-closed)", () => {
  const events = multiplierHistoryToEvents(history.nodes, { symbol: "SPYx" });
  events[2].multiplierFrom = "9.99"; // порвать цепочку
  assert.throws(() => new MultiplierTimeline(events), /chain discontinuity/);
});

test("первое событие не от 1 = ошибка", () => {
  const events = multiplierHistoryToEvents(history.nodes, { symbol: "SPYx" }).slice(1); // выбросили первое
  assert.throws(() => new MultiplierTimeline(events), /chain discontinuity/);
});

test("пустая шкала = множитель 1 всюду", () => {
  const tl = new MultiplierTimeline([]);
  assert.equal(tl.multiplierAt("2026-01-01"), "1");
  assert.deepEqual(tl.scaledQty(1_000_000n, "2026-01-01"), { whole: 1_000_000n, remainder: 0n, den: 1n, exact: true });
});

test("scaledQty: точный случай и случай с «пылью» (без молчаливого округления)", () => {
  const tl = spyxTimeline();
  // raw 10^15 × 1.005714560286254 = 1005714560286254 — делится нацело
  const exact = tl.scaledQty(10n ** 15n, "2026-07-01");
  assert.equal(exact.exact, true);
  assert.equal(exact.whole, 1005714560286254n);
  // raw 10^9: 1e9×num/10^15 — не делится: whole + remainder честно
  const dusty = tl.scaledQty(10n ** 9n, "2026-07-01");
  assert.equal(dusty.exact, false);
  assert.equal(dusty.whole, 1005714560n);
  assert.equal(dusty.remainder, 286254000000000n); // 0.286254 единицы в den-единицах
  assert.equal(dusty.den, 10n ** 15n);
});

test("чужой тип события в шкале отклоняется", () => {
  assert.throws(() => new MultiplierTimeline([{ type: "SPLIT", effectiveDate: "2026-01-01" }]), /only MULTIPLIER_CHANGE/);
});

test("интеграция: живая фикстура → клиент → нормализатор → валидная схема", async () => {
  const okRes = (payload) => ({ ok: true, status: 200, json: async () => payload });
  const h = await fetchMultiplierHistory("SPYx", "Ethereum", {
    fetcher: async () => okRes(historyFixture), // сырой JSON с ЧИСЛАМИ, как отдаёт API
  });
  const events = bindMintAndValidate(multiplierHistoryToEvents(h.nodes, { symbol: "SPYx" }), MINT);
  assert.equal(events.length, 4);
  assert.equal(events[0].multiplierFrom, "1");
  assert.equal(events[3].multiplierTo, "1.005714560286254");
});
