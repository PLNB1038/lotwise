// Тесты webhook-подписок: хранилище (CRUD+валидации), матчинг, доставка
// (HMAC-подпись, ретраи с backoff 1s/4s, сетевые отказы) и deliverToAll.
// БЕЗ СЕТИ И БЕЗ ТАЙМЕРОВ: fetcher и sleep — моки (сценарий ретраев с реальными
// паузами 1s+4s занял бы 5+ секунд на каждый тест); CLI-сценарии с сетью гоняются
// через main(argv, {fetcher, sleep}) с инжекцией, spawnSync — только пути без сети.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  addSubscription,
  deactivateSubscription,
  deliverToAll,
  deliverWebhook,
  listSubscriptions,
  matchSubscriptions,
  removeSubscription,
  SubscriptionError,
  validateSubscription,
} from "../src/webhooks/subscriptions.mjs";
import { main } from "../scripts/webhook-deliver.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "webhook-deliver.mjs");

// Каноническое событие, проходящее validateEvent (schema/events.mjs).
const MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const SPLIT = {
  type: "SPLIT",
  mint: MINT,
  effectiveDate: "2026-06-10T04:30:00.000Z",
  status: "confirmed",
  sources: ["https://api.xstocks.fi/api/v2/public/assets/SPYx"],
  ratioNumerator: 3,
  ratioDenominator: 1,
};
const TICKER = {
  type: "TICKER_CHANGE",
  mint: MINT,
  effectiveDate: "2026-06-11T00:00:00.000Z",
  status: "confirmed",
  sources: ["issuer-notice"],
  oldSymbol: "OLD",
  newSymbol: "NEW",
};

const SUB = {
  id: "wh_test",
  url: "https://hooks.example.com/lotwise",
  symbols: "*",
  secret: "s3cret",
  createdAt: "2026-09-22T00:00:00.000Z",
  active: true,
};

const freshDir = () => mkdtempSync(path.join(tmpdir(), "lotwise-webhooks-"));
const created = [];
const tempFile = (name, content) => {
  const file = path.join(freshDir(), name);
  created.push(path.dirname(file));
  if (content !== undefined) writeFileSync(file, content);
  return file;
};
test.after(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
});

// Мок-fetcher по сценарию статусов: число = HTTP-статус, Error = сетевой отказ.
// Лишний запрос сверх сценария = падение теста (ловит лишние попытки/доставки).
const fetcherOf = (seq, calls = []) => async (url, init) => {
  if (calls.length >= seq.length) throw new Error(`неожиданный запрос сверх сценария: ${url}`);
  calls.push({ url, init });
  const next = seq[calls.length - 1];
  if (next instanceof Error) throw next;
  return { status: next };
};
const captureFetcher = (calls = []) => async (url, init) => {
  calls.push({ url, init });
  return { status: 200 };
};
const hmac = (secret, body) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

// ---------- хранилище: CRUD + валидации ----------

test("addSubscription: пишет атомарно, запись полная, active:true, createdAt ISO", () => {
  const file = tempFile("webhooks.json");
  const rec = addSubscription(file, { id: "wh_a", url: "https://h.example/x", symbols: ["SPYx"], secret: "k", nowMs: 0 });
  assert.deepEqual(rec, { id: "wh_a", url: "https://h.example/x", symbols: ["SPYx"], secret: "k", createdAt: "1970-01-01T00:00:00.000Z", active: true });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), [rec]);
});

test("addSubscription без id генерирует уникальные wh_*", () => {
  const file = tempFile("webhooks.json");
  const a = addSubscription(file, { url: "https://h.example/a", symbols: "*", secret: "k" });
  const b = addSubscription(file, { url: "https://h.example/b", symbols: "*", secret: "k" });
  assert.notEqual(a.id, b.id);
  assert.match(a.id, /^wh_/);
  assert.equal(listSubscriptions(file).length, 2);
});

test("валидации: битый url / не-http(s), пустой secret, мусорные symbols, active, createdAt — с именем поля", () => {
  const base = { id: "x", url: "https://h.example", symbols: "*", secret: "k", createdAt: "2026-09-22T00:00:00.000Z", active: true };
  const bad = (patch, field) => {
    try {
      validateSubscription({ ...base, ...patch });
      assert.fail(`ожидали отказ: ${JSON.stringify(patch)}`);
    } catch (err) {
      assert.ok(err instanceof SubscriptionError, `ожидали SubscriptionError, получен ${err.name}`);
      assert.equal(err.field, field, `${JSON.stringify(patch)} -> поле ${field}, получено ${err.field}`);
    }
  };
  bad({ url: "не-url" }, "url");
  bad({ url: "ftp://h.example" }, "url");
  bad({ url: "" }, "url");
  bad({ secret: "" }, "secret");
  bad({ symbols: [] }, "symbols");
  bad({ symbols: "SPYx" }, "symbols"); // строка-не-wildcard: список обязан быть массивом
  bad({ symbols: ["SPYx", ""] }, "symbols");
  bad({ active: "yes" }, "active");
  bad({ createdAt: "вчера" }, "createdAt");
  bad({ id: "" }, "id");
  assert.equal(validateSubscription({ ...base, symbols: "*" }), true);
  assert.equal(validateSubscription({ ...base, symbols: [MINT] }), true); // минт — легальный идентификатор
});

test("дубликат id — отказ, файл не меняется", () => {
  const file = tempFile("webhooks.json");
  addSubscription(file, { id: "wh_dup", url: "https://h.example", symbols: "*", secret: "k", nowMs: 0 });
  const before = readFileSync(file, "utf8");
  assert.throws(() => addSubscription(file, { id: "wh_dup", url: "https://h.example/2", symbols: "*", secret: "k" }), (e) => e.field === "id");
  assert.equal(readFileSync(file, "utf8"), before);
});

test("list: нет файла = []; результат — копия (правки не доходят до диска)", () => {
  const file = tempFile("webhooks.json");
  assert.deepEqual(listSubscriptions(file), []);
  addSubscription(file, { id: "wh_c", url: "https://h.example", symbols: ["A", "B"], secret: "k", nowMs: 0 });
  const list = listSubscriptions(file);
  list[0].symbols.push("MUSOR");
  list[0].active = false;
  assert.deepEqual(listSubscriptions(file)[0].symbols, ["A", "B"]);
  assert.equal(listSubscriptions(file)[0].active, true);
});

test("remove/deactivate: true-потом-false, деактивация переживает запись и повтор", () => {
  const file = tempFile("webhooks.json");
  addSubscription(file, { id: "wh_d", url: "https://h.example", symbols: "*", secret: "k", nowMs: 0 });
  assert.equal(deactivateSubscription(file, "wh_d"), true);
  assert.equal(listSubscriptions(file)[0].active, false, "active:false должен доехать до диска");
  assert.equal(deactivateSubscription(file, "wh_d"), true, "повторная деактивация — не ошибка");
  assert.equal(deactivateSubscription(file, "wh_нет"), false);
  assert.equal(removeSubscription(file, "wh_d"), true);
  assert.deepEqual(listSubscriptions(file), []);
  assert.equal(removeSubscription(file, "wh_d"), false);
});

test("битое хранилище — громкий отказ на ЛЮБОЙ операции, файл не перезаписывается", () => {
  for (const content of ["{усечён", "null", JSON.stringify([{ ...SUB, url: "ftp://x" }])]) {
    const file = tempFile("webhooks.json", content);
    const before = readFileSync(file, "utf8");
    assert.throws(() => listSubscriptions(file), SubscriptionError);
    assert.throws(() => addSubscription(file, { url: "https://h.example", symbols: "*", secret: "k" }), SubscriptionError);
    assert.equal(readFileSync(file, "utf8"), before, "битую базу молча перезаписывать нельзя");
  }
});

// ---------- matchSubscriptions ----------

test("матч: wildcard ловит всё, список — точный symbol, минт матчится по mint", () => {
  const subs = [
    { id: "w", symbols: "*", active: true },
    { id: "s", symbols: ["SPYx"], active: true },
    { id: "m", symbols: [MINT], active: true },
  ];
  const bySymbol = { symbol: "SPYx", mint: MINT };
  assert.deepEqual(matchSubscriptions(subs, bySymbol).map((s) => s.id), ["w", "s", "m"]);
  assert.deepEqual(matchSubscriptions(subs, { symbol: "ДРУГОЙ", mint: MINT }).map((s) => s.id), ["w", "m"]);
  // событие без symbol (каноническое — mint-only): только wildcard и подписка-на-минт
  assert.deepEqual(matchSubscriptions(subs, { mint: MINT }).map((s) => s.id), ["w", "m"]);
  assert.deepEqual(matchSubscriptions(subs, {}), [subs[0]]);
  // сверка точная: base58-минты регистрозависимы, case-folding сломал бы их
  assert.deepEqual(matchSubscriptions(subs, { symbol: "spyx", mint: "x".repeat(44) }), [subs[0]]);
});

// ---------- deliverWebhook: подпись, заголовки, ретраи ----------

test("доставка: POST JSON-конверта, заголовки, HMAC детерминирован (пересчёт в тесте)", async () => {
  const calls = [];
  const sleeps = [];
  const res = await deliverWebhook(SUB, SPLIT, {
    fetcher: fetcherOf([200], calls),
    sleep: async (ms) => sleeps.push(ms),
    deliveryId: "dlv-1",
    nowMs: 1_000,
  });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, SUB.url);
  assert.equal(init.method, "POST");
  assert.ok(init.signal instanceof AbortSignal, "таймаут идёт через AbortSignal");
  assert.equal(init.headers["x-lotwise-event"], "SPLIT");
  assert.equal(init.headers["x-lotwise-delivery"], "dlv-1");
  // Пересчёт подписи над ТОЧНЫМ телом запроса — главная проверка контракта.
  assert.equal(init.headers["x-lotwise-signature"], hmac(SUB.secret, init.body));
  assert.deepEqual(JSON.parse(init.body), { deliveryId: "dlv-1", sentAt: "1970-01-01T00:00:01.000Z", event: SPLIT });
  assert.deepEqual(res, { ok: true, attempts: 1, statuses: [200], error: null });
  assert.deepEqual(sleeps, [], "успех с первой попытки — без пауз");
});

test("подпись детерминирована при том же теле и меняется с секретом", async () => {
  const a = [];
  const b = [];
  const opts = { deliveryId: "dlv-x", nowMs: 5 };
  await deliverWebhook(SUB, SPLIT, { fetcher: captureFetcher(a), ...opts });
  await deliverWebhook(SUB, SPLIT, { fetcher: captureFetcher(b), ...opts });
  assert.equal(a[0].init.body, b[0].init.body, "тело байт-в-байт то же");
  assert.equal(a[0].init.headers["x-lotwise-signature"], b[0].init.headers["x-lotwise-signature"]);
  const other = [];
  await deliverWebhook({ ...SUB, secret: "другой-ключ" }, SPLIT, { fetcher: captureFetcher(other), ...opts });
  assert.notEqual(other[0].init.headers["x-lotwise-signature"], a[0].init.headers["x-lotwise-signature"]);
});

test("не-2xx ретраится: 2xx на второй попытке, пауза только 1000", async () => {
  const calls = [];
  const sleeps = [];
  const res = await deliverWebhook(SUB, SPLIT, { fetcher: fetcherOf([500, 200], calls), sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(res.statuses, [500, 200]);
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 2);
  assert.deepEqual(sleeps, [1000]);
});

test("исчерпание ретраев: 3 попытки, backoff [1000,4000], честный неуспех", async () => {
  const calls = [];
  const sleeps = [];
  const res = await deliverWebhook(SUB, SPLIT, { fetcher: fetcherOf([500, 503, 500], calls), sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(res, { ok: false, attempts: 3, statuses: [500, 503, 500], error: "HTTP 500" });
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [1000, 4000]);
  // Все ретраи несут байт-в-байт тот же payload и ту же подпись (идемпотентность).
  assert.equal(calls[0].init.body, calls[2].init.body);
  assert.equal(calls[0].init.headers["x-lotwise-signature"], calls[2].init.headers["x-lotwise-signature"]);
  assert.equal(calls[2].init.headers["x-lotwise-delivery"], calls[0].init.headers["x-lotwise-delivery"]);
});

test("сетевой отказ: 3 попытки, статусы null, причина последней ошибки в результате", async () => {
  const calls = [];
  const sleeps = [];
  const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { cause: new Error("ECONNREFUSED") });
  const res = await deliverWebhook(SUB, SPLIT, { fetcher: fetcherOf([refused, refused, refused], calls), sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(res, { ok: false, attempts: 3, statuses: [null, null, null], error: "ECONNREFUSED" });
  assert.deepEqual(sleeps, [1000, 4000]);
});

test("успех на последней попытке: ретраи останавливаются сразу после 2xx", async () => {
  const calls = [];
  const sleeps = [];
  const res = await deliverWebhook(SUB, SPLIT, { fetcher: fetcherOf([502, 502, 204], calls), sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(res.statuses, [502, 502, 204]);
  assert.equal(res.ok, true);
  assert.deepEqual(sleeps, [1000, 4000]);
  assert.equal(calls.length, 3);
});

// ---------- deliverToAll ----------

const SUBS = [
  { id: "wild", url: "https://h.example/w", symbols: "*", secret: "k", createdAt: "2026-09-22T00:00:00.000Z", active: true },
  { id: "spyx", url: "https://h.example/s", symbols: ["NEW"], secret: "k", createdAt: "2026-09-22T00:00:00.000Z", active: true },
  { id: "off", url: "https://h.example/o", symbols: "*", secret: "k", createdAt: "2026-09-22T00:00:00.000Z", active: false },
];

test("deliverToAll: счётчики delivered/skipped/failed и адресность", async () => {
  const calls = [];
  const sleeps = [];
  // TICKER (newSymbol=NEW): матчатся wild + spyx (по символу) + off (wild, выключен
  // -> skipped без запроса). SPLIT (mint-only): матчатся wild + off (снова skipped).
  const report = await deliverToAll([TICKER, SPLIT], SUBS, {
    fetcher: fetcherOf([200, 200, 404, 404, 404], calls),
    sleep: async (ms) => sleeps.push(ms),
  });
  assert.equal(report.delivered, 2, "wild(TICKER) + spyx(TICKER)");
  assert.equal(report.failed, 1, "wild(SPLIT) со сгоревшими ретраями");
  assert.equal(report.skipped, 2, "off под матчем обоих событий — по skipped за каждое");
  assert.equal(calls.length, 5, "3 доставки, из них одна с 3 ретраями");
  assert.deepEqual(sleeps, [1000, 4000], "паузы только между попытками сгоревшей доставки");
});

test("deliverToAll: точный разбор отчёта по deliveries/warnings", async () => {
  const report = await deliverToAll([TICKER, SPLIT], SUBS, {
    fetcher: fetcherOf([200, 200, 404, 404, 404]),
    sleep: async () => {},
  });
  assert.deepEqual(report.delivered, 2);
  assert.deepEqual(report.failed, 1);
  assert.deepEqual(report.skipped, 2);
  const bySub = Object.fromEntries(report.deliveries.map((d) => [`${d.subscriptionId}:${d.eventType}`, d]));
  assert.equal(bySub["wild:TICKER_CHANGE"].ok, true);
  assert.equal(bySub["spyx:TICKER_CHANGE"].ok, true);
  assert.equal(bySub["wild:SPLIT"].ok, false);
  assert.deepEqual(bySub["wild:SPLIT"].statuses, [404, 404, 404]);
  assert.ok(report.warnings.every((w) => w.includes("off")), "оба skipped — от выключенной off");
  assert.equal(report.warnings.length, 2);
});

test("deliverToAll: событие без единого адресата — skipped, ни одного запроса", async () => {
  const calls = [];
  const report = await deliverToAll([SPLIT], [SUBS[1]], { fetcher: captureFetcher(calls) });
  assert.deepEqual({ delivered: report.delivered, skipped: report.skipped, failed: report.failed }, { delivered: 0, skipped: 1, failed: 0 });
  assert.equal(calls.length, 0);
});

test("deliverToAll: битое событие в списке — отказ ДО первой отправки (fail-fast)", async () => {
  const calls = [];
  const broken = { ...SPLIT, type: "НЕСУЩЕСТВУЮЩИЙ" };
  await assert.rejects(
    () => deliverToAll([SPLIT, broken], SUBS, { fetcher: captureFetcher(calls) }),
    (err) => err.name === "EventValidationError" && err.field === "type",
  );
  assert.equal(calls.length, 0, "битый хвост не должен дать уйти половине списка");
});

// ---------- CLI: main() с инжекцией (сценарии с сетью — моки) + spawnSync (без сети) ----------

test("CLI main: failed=0 (всё skipped) — exit 0; пустой stdin-список — exit 0", async () => {
  const events = tempFile("events.json", JSON.stringify([SPLIT]));
  const noSubs = tempFile("webhooks.json"); // файла подписок нет — доставлять некому
  const code = await main(["--events", events, "--subscriptions", noSubs, "--json"], {
    fetcher: async () => { throw new Error("в сеть ходить нельзя"); },
  });
  assert.equal(code, 0, "«некому доставлять» — не провал");
});

test("CLI main: все ретраи исчерпаны — exit 1, паузы мокнуты", async () => {
  const events = tempFile("events.json", JSON.stringify([SPLIT]));
  const subs = tempFile("webhooks.json");
  addSubscription(subs, { id: "wh_e", url: "https://h.example/e", symbols: "*", secret: "k", nowMs: 0 });
  const calls = [];
  const sleeps = [];
  const code = await main(["--events", events, "--subscriptions", subs, "--json"], {
    fetcher: fetcherOf([500, 500, 500], calls),
    sleep: async (ms) => sleeps.push(ms),
  });
  assert.equal(code, 1);
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [1000, 4000], "CLI не должен ходить реальным setTimeout в тестах");
});

test("CLI main: exit 2 — неизвестный флаг, битые события, битые подписки, невалидное событие", async () => {
  const subs = tempFile("webhooks.json");
  addSubscription(subs, { id: "wh_f", url: "https://h.example", symbols: "*", secret: "k", nowMs: 0 });
  const events = tempFile("events.json", JSON.stringify([SPLIT]));

  assert.equal(await main(["--нет-такого"], { fetcher: captureFetcher() }), 2);
  assert.equal(await main(["--events", tempFile("bad.json", "{усечён")], { fetcher: captureFetcher() }), 2);
  assert.equal(await main(["--events", tempFile("notarray.json", JSON.stringify(SPLIT))], { fetcher: captureFetcher() }), 2);
  assert.equal(await main(["--events", events, "--subscriptions", tempFile("corrupt.json", "[]мусор")], { fetcher: captureFetcher() }), 2);
  const invalidEvent = tempFile("invalid-event.json", JSON.stringify([{ ...SPLIT, mint: "не-минт" }]));
  assert.equal(await main(["--events", invalidEvent, "--subscriptions", subs], { fetcher: captureFetcher() }), 2);
});

test("CLI spawnSync: --help — exit 0 со справкой; неизвестный флаг и нет файла — exit 2", () => {
  const help = spawnSync(process.execPath, [SCRIPT, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, `stderr: ${help.stderr}`);
  assert.match(help.stdout, /--subscriptions/);
  const badFlag = spawnSync(process.execPath, [SCRIPT, "--что"], { encoding: "utf8" });
  assert.equal(badFlag.status, 2);
  const noFile = spawnSync(process.execPath, [SCRIPT, "--events", path.join(tmpdir(), "webhooks-нет-такого-xyz.json")], { encoding: "utf8", input: "" });
  assert.equal(noFile.status, 2);
});

test("CLI spawnSync: события через stdin (пайп, не сеть), пустой файл подписок — JSON-отчёт и exit 0", () => {
  const subs = tempFile("webhooks.json", "[]");
  const res = spawnSync(process.execPath, [SCRIPT, "--subscriptions", subs, "--json"], {
    encoding: "utf8",
    input: JSON.stringify([SPLIT, TICKER]),
  });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const report = JSON.parse(res.stdout);
  assert.deepEqual(
    { delivered: report.delivered, skipped: report.skipped, failed: report.failed },
    { delivered: 0, skipped: 2, failed: 0 },
  );
  assert.equal(report.deliveries.length, 0);
  assert.equal(report.warnings.length, 2, "каждое событие честно помечено «адресатов нет»");
});
