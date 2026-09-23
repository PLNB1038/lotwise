// Регрессионные тесты раунда 7 ревью Lotwise — персистентность/доставка.
// Находки ROUND7:
//   №4 (events/journal.mjs): гвард порчи `typeof priorEntry === "object"` пропускал
//       записи-строки/числа — коррупция трактовалась как «нет истории»: бэкфилл
//       переизлучал дубль события, corrupted:false, финальный персист затирал улику
//       без .corrupt-* (раунд 7 закрыл только events-НЕ-массив).
//   №5 (webhooks/subscriptions.mjs): fetch с дефолтным redirect:"follow" — 302 от
//       получателя превращался в пустой GET; 2xx на редирект-цели = ok:true, событие
//       потеряно из вида системы, а заголовки с HMAC-подписью утекали на чужой хост.
//   №16 (issuer/scaled-ui.mjs + normalize-onchain): множитель хранится как пришло из
//       RPC; строковый дифф журнала «5» vs «5.0» (смена репрезентации, не величины)
//       эмитил и персистил фантомное MULTIPLIER_CHANGE навечно.
import test from "node:test";
import assert from "node:assert/strict";
import { planJournalStep } from "../src/events/journal.mjs";
import { parseScaledUiAmount } from "../src/issuer/scaled-ui.mjs";
import { deliverWebhook } from "../src/webhooks/subscriptions.mjs";

const MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const TOKEN = { mint: MINT, symbol: "TESTx" };

const mintState = (state) => ({
  owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  data: { parsed: { info: { decimals: 8, extensions: [{ extension: "scaledUiAmountConfig", state: { newMultiplierEffectiveTimestamp: 0, ...state } }] } } },
});
// завершённая ротация: pending нет, живёт только active
const settled = (multiplier) => mintState({ multiplier, newMultiplier: 0 });
// ротация в полёте: active + pending с датой активации в прошлом
const rotation = (active, pending) => mintState({
  multiplier: active, newMultiplier: pending, newMultiplierEffectiveTimestamp: Date.UTC(2026, 5, 10) / 1000,
});

// ---- ROUND7 №4: не-объектная запись журнала = порча, а не «нет истории» ----

test("journal: запись-СТРОКА — corrupted:true, дубль события из бэкфилла НЕ переизлучается", () => {
  const parsed = parseScaledUiAmount(rotation("1", "5"));
  const r = planJournalStep(TOKEN, "5 (мусор)", parsed);
  assert.equal(r.corrupted, true, "строка вместо {lastEffective,events} — порча");
  assert.equal(r.event, null, "бэкфилл по недоверенной базе подавляется");
  assert.deepEqual(r.replay, []);
});

test("journal: запись-ЧИСЛО/БУЛЕВ — тот же corrupted-путь, что у events-не-массива", () => {
  const parsed = parseScaledUiAmount(rotation("1", "5"));
  for (const bad of [5, true]) {
    const r = planJournalStep(TOKEN, bad, parsed);
    assert.equal(r.corrupted, true, `запись ${typeof bad} — порча`);
    assert.equal(r.event, null);
  }
});

test("journal: порча + недоступная цепь — entry:null (улика на диске не трогается), corrupted:true", () => {
  const r = planJournalStep(TOKEN, "5 (мусор)", null);
  assert.equal(r.corrupted, true);
  assert.equal(r.entry, null);
  assert.equal(r.chain, "unavailable");
});

test("journal: null/undefined остаются легитимным «нет записи» — регрессии ужесточения нет", () => {
  const parsed = parseScaledUiAmount(rotation("1", "5"));
  for (const legit of [null, undefined]) {
    const r = planJournalStep(TOKEN, legit, parsed);
    assert.equal(r.corrupted, false, `${legit} — первое наблюдение, не порча`);
    assert.ok(r.event !== null, "бэкфилл 1→5 на первом наблюдении работает как раньше");
    assert.equal(r.event.multiplierFrom, "1");
    assert.equal(r.event.multiplierTo, "5");
  }
});

// ---- ROUND7 №16: каноническая запись множителя на выходе парсера ----

test("scaled-ui: множитель канонизируется — «5.0»→«5», «05»→«5», «1.10»→«1.1»", () => {
  assert.equal(parseScaledUiAmount(settled("5.0")).activeMultiplier, "5");
  assert.equal(parseScaledUiAmount(settled("05")).activeMultiplier, "5");
  assert.equal(parseScaledUiAmount(settled("1.10")).activeMultiplier, "1.1");
  assert.equal(parseScaledUiAmount(settled("1.003909240011759")).activeMultiplier, "1.003909240011759", "значащие цифры не трогаются");
});

test("scaled-ui: pending тоже канонизируется («5.000»→«5»)", () => {
  const m = rotation("1", "5.000");
  const parsed = parseScaledUiAmount(m);
  assert.equal(parsed.pendingMultiplier, "5");
});

test("journal: смена репрезентации той же величины («5» на цепи → «5.0» в RPC) — фантомного события НЕТ", () => {
  // бут-1: первое наблюдение, active="5" → entry с событием 1→5
  const boot1 = planJournalStep(TOKEN, null, parseScaledUiAmount(rotation("1", "5")));
  assert.ok(boot1.event);
  // бут-2: RPC сменил запись той же величины на "5.0"
  const boot2 = planJournalStep(TOKEN, boot1.entry, parseScaledUiAmount(settled("5.0")));
  assert.equal(boot2.event, null, "5 → 5.0 — не событие");
  assert.equal(boot2.entry.lastEffective, "5", "каноническая форма съедает дифф репрезентации");
  assert.equal(boot2.entry.events.length, 1, "фантом не персистится в историю");
});

// ---- ROUND7 №5: redirect вебхука — провал, а не тихая «успешная» доставка ----

const EVENT = {
  type: "MULTIPLIER_CHANGE", mint: MINT,
  effectiveDate: "2026-06-10T04:30:00.000Z", status: "confirmed",
  sources: ["test:round7"], multiplierFrom: "1", multiplierTo: "5",
  reason: "On-chain rebase",
};

// fetcher с семантикой настоящего fetch: redirect:"error" → 3xx бросает TypeError;
// без опции — «идёт по» редиректу пустым GET и возвращает 200 редирект-цели.
function makeRedirectingFetcher(log) {
  return async (url, init) => {
    log.push({ url, redirect: init?.redirect ?? null, method: init?.method ?? "?" });
    if (init?.redirect === "error") throw new TypeError("Unexpected redirect");
    return new Response("homepage", { status: 200 });
  };
}

test("webhook: 3xx от получателя — попытка ПРОВАЛЕНА (redirect:error), ok:false после ретраев", async () => {
  const log = [];
  const r = await deliverWebhook(
    { url: "https://receiver.example/hook", secret: "s3cret" },
    EVENT,
    { fetcher: makeRedirectingFetcher(log), sleep: async () => {}, nowMs: Date.parse("2026-09-23T18:00:00Z") },
  );
  assert.equal(r.ok, false, "доставка по редиректу не считается успешной");
  assert.equal(r.attempts, 3); // ретраи исчерпаны — сигнал оператору, событие не «исчезло»
  assert.ok(r.statuses.every((s) => s === null));
  assert.ok(log.every((l) => l.redirect === "error"), "каждая попытка явно запрещает следование за редиректом");
  assert.ok(log.every((l) => l.method === "POST"), "подпись и тело не уходят на редирект-цель GET-ом");
});

test("webhook: честный 2xx без редиректа — ok:true, форма ответа прежняя", async () => {
  const r = await deliverWebhook(
    { url: "https://receiver.example/hook", secret: "s3cret" },
    EVENT,
    { fetcher: async () => new Response("ok", { status: 200 }), sleep: async () => {}, nowMs: Date.parse("2026-09-23T18:00:00Z") },
  );
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 1);
  assert.deepEqual(r.statuses, [200]);
});

// ---- ROUND7 №7: детерминированный deliveryId между прогонами ----

test("webhook: тот же (подписка, событие) на повторном прогоне — ТОТ ЖЕ deliveryId", async () => {
  const sub = { id: "wh_1", url: "https://receiver.example/hook", secret: "s3cret" };
  const bodies = [];
  const fetcher = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response("ok", { status: 200 });
  };
  await deliverWebhook(sub, EVENT, { fetcher, sleep: async () => {}, nowMs: 1 });
  await deliverWebhook(sub, EVENT, { fetcher, sleep: async () => {}, nowMs: 2 }); // другой прогон — другое sentAt
  assert.equal(bodies[0].deliveryId, bodies[1].deliveryId, "идентичность пары (sub, event) стабильна между прогонами");
  // другое событие — другой id
  await deliverWebhook(sub, { ...EVENT, multiplierTo: "6" }, { fetcher, sleep: async () => {}, nowMs: 3 });
  assert.notEqual(bodies[2].deliveryId, bodies[0].deliveryId);
  // другая подписка — другой id (иначе дедуп получателя склеит чужие потоки)
  await deliverWebhook({ ...sub, id: "wh_2" }, EVENT, { fetcher, sleep: async () => {}, nowMs: 4 });
  assert.notEqual(bodies[3].deliveryId, bodies[0].deliveryId);
});

test("webhook: явный deliveryId в opts по-прежнему побеждает (контракт явных id)", async () => {
  const seen = [];
  const r = await deliverWebhook(
    { id: "wh_1", url: "https://receiver.example/hook", secret: "s3cret" },
    EVENT,
    {
      fetcher: async (url, init) => { seen.push(init.headers["x-lotwise-delivery"]); return new Response("ok", { status: 200 }); },
      sleep: async () => {}, deliveryId: "explicit-id-42", nowMs: 5,
    },
  );
  assert.equal(r.ok, true);
  assert.deepEqual(seen, ["explicit-id-42"]);
});
