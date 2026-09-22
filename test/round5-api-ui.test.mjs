// Регрессионные тесты раунда 5 ревью Lotwise — зона src/api/server.mjs + src/ui/page.mjs.
// Находки:
//   LW_onchain_rolled_date_500            — /onchain?date=2026-02-30 → 500 вместо 400
//                                           (Date.parse перекатывает дату, строгий парсер
//                                           ниже по стеку бросает, кэш RPC разогрет зря);
//   LW_ui_crosscheck_badge_date_collision — бейджи кросс-чека ключуются по effectiveDate:
//                                           два события в один день → первый показывает
//                                           вердикт второго;
//   LW_excluded_token_shows_multiplier_1  — токен, исключённый из витрины по TimelineError,
//                                           в /summary и /lots отдаёт молчаливую «1»,
//                                           /health об исключении не говорит.
import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/api/server.mjs";
import { multiplierHistoryToEvents, bindMintAndValidate } from "../src/events/normalize-xstocks.mjs";
import { loadRegistry } from "../src/registry/registry.mjs";
import { renderPage } from "../src/ui/page.mjs";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const SPYx = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const OWNER = "9BB7Tt5uW5QbAorLkF3Hn1P2mGcXvcDdR7y8LbT9KdUu"; // как в wallet.test.mjs

const historyNodes = JSON.parse(readFileSync(path.join(dir, "xstocks-spyx-history-eth.json"), "utf8")).nodes;
const events = bindMintAndValidate(multiplierHistoryToEvents(historyNodes, { symbol: "SPYx" }), SPYx);

async function withServer(opts, fn) {
  if (typeof opts === "function") fn = opts; // withServer(fn) — без опций
  const o = typeof opts === "object" && opts !== null ? opts : {};
  const registry = await loadRegistry("data/tokens.json");
  const server = await createApiServer({ registry, events, ...o });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

// Сервер с «отравленным» минтом: кривая цепочка → TimelineError на старте →
// токен исключается из витрины (паттерн round-4 теста в api.test.mjs).
// optsFn(bad) позволяет собрать опции, которым нужен минт исключённого токена.
async function withPoisonedServer(fn, optsFn = null) {
  const registry = await loadRegistry("data/tokens.json");
  const bad = registry.find((t) => t.symbol === "T-SpaceX");
  const poisoned = [
    ...events,
    {
      type: "MULTIPLIER_CHANGE", mint: bad.mint, effectiveDate: "2026-05-01T00:00:00.000Z",
      status: "confirmed", sources: ["test:broken-chain"],
      multiplierFrom: "5", multiplierTo: "6", reason: "On-chain rebase",
    },
  ];
  const opts = typeof optsFn === "function" ? optsFn(bad) : {};
  const server = await createApiServer({ registry, events: poisoned, ...opts });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`, bad);
  } finally {
    server.close();
  }
}

// ---- LW_onchain_rolled_date_500: перекат-даты — 400 от гейта, до ридера ----

test("/onchain: перекат-дата 2026-02-30 — 400 ДО ридера, не 500 и не RPC", async () => {
  let readerCalls = 0;
  await withServer({
    onchainReader: async () => {
      readerCalls += 1;
      return { activeMultiplier: "1", pendingMultiplier: null, pendingEffectiveDate: null, hasExtension: true };
    },
  }, async (base) => {
    const res = await fetch(`${base}/onchain?symbol=SPYx&date=2026-02-30`);
    assert.equal(res.status, 400); // было: 500 — Date.parse перекатил на 03-02, TimelineError выше гейта
    const body = await res.json();
    assert.match(body.error, /date/i);
    assert.equal(readerCalls, 0); // мусорная дата не греет кэш реальным RPC-вызовом
  });
});

test("/onchain: 2026-06-31, 2027-02-29 и 2026-02-29 (не високосный) — тоже 400", async () => {
  await withServer(async (base) => {
    for (const d of ["2026-06-31", "2027-02-29", "2026-02-29"]) {
      const res = await fetch(`${base}/onchain?symbol=SPYx&date=${d}`);
      assert.equal(res.status, 400, d); // было: Date.parse перекатывал — 503 (ридер не настроен)
      assert.match((await res.json()).error, /date/i, d);
    }
  });
});

test("/multiplier: перекат-даты — 400 от датового гейта, а не утечка TimelineError", async () => {
  await withServer(async (base) => {
    for (const d of ["2026-02-30", "2026-06-31"]) {
      const res = await fetch(`${base}/multiplier?symbol=SPYx&raw=1000&date=${d}`);
      assert.equal(res.status, 400, d);
      // до фикса 400 приходил из catch вокруг scaledQty с внутренним TimelineError;
      // после — из гейта с понятным сообщением про формат даты
      assert.match((await res.json()).error, /ISO-8601/, d);
    }
  });
});

test("строгий гейт не перегнул: валидные даты /onchain и /multiplier проходят", async () => {
  await withServer({
    onchainReader: async () => ({ activeMultiplier: "1", pendingMultiplier: null, pendingEffectiveDate: null, hasExtension: true }),
  }, async (base) => {
    assert.equal((await fetch(`${base}/onchain?symbol=SPYx&date=2026-06-18`)).status, 200);
    assert.equal((await fetch(`${base}/onchain?symbol=SPYx&date=2026-06-18T00:00:00Z`)).status, 200);
    assert.equal((await fetch(`${base}/multiplier?symbol=SPYx&raw=1000&date=2026-02-28`)).status, 200);
    assert.equal((await fetch(`${base}/multiplier?symbol=SPYx&raw=1000&date=2028-02-29`)).status, 200); // високосный
  });
});

// ---- LW_excluded_token_shows_multiplier_1: честная пометка исключённых ----

test("/summary: исключённый токен помечен excluded+reason, живые — без флага", async () => {
  await withPoisonedServer(async (base) => {
    const rows = await (await fetch(`${base}/summary`)).json();
    const excluded = rows.find((r) => r.symbol === "T-SpaceX");
    assert.equal(excluded.excluded, true); // было: undefined, строка неотличима от «событий не было»
    assert.ok(typeof excluded.excludedReason === "string" && excluded.excludedReason.length > 0);
    const good = rows.find((r) => r.symbol === "SPYx");
    assert.equal(good.excluded, undefined); // живым токенам флаг не добавляем
    assert.equal(good.currentMultiplier, "1.005714560286254");
  });
});

test("/health: список исключённых с причиной; чистый сервер — пустой список", async () => {
  await withPoisonedServer(async (base, bad) => {
    const h = await (await fetch(`${base}/health`)).json();
    assert.ok(Array.isArray(h.excluded)); // было: поле отсутствовало
    assert.equal(h.excluded.length, 1);
    assert.equal(h.excluded[0].mint, bad.mint);
    assert.equal(h.excluded[0].symbol, "T-SpaceX");
    assert.ok(h.excluded[0].reason.length > 0);
  });
  await withServer(async (base) => {
    const h = await (await fetch(`${base}/health`)).json();
    assert.deepEqual(h.excluded, []); // ничего не исключено — честный пустой список
  });
});

test("/lots: токен исключённого минта помечен excluded в отчёте", async () => {
  const scanOf = (mint) => ({
    owner: OWNER, signatures: 1, fetched: 1, skipped: [], truncated: false,
    accounts: new Map([[mint, { address: "At5", currentRaw: 10n }]]),
    txs: [
      { signature: "a", slot: 1, blockTime: 100, deltas: [{ owner: OWNER, mint, preRaw: 0n, postRaw: 10n, deltaRaw: 10n }] },
    ],
  });
  await withPoisonedServer(async (base) => {
    const rep = await (await fetch(`${base}/lots?address=${OWNER}`)).json();
    const t = rep.tokens.find((x) => x.symbol === "T-SpaceX");
    assert.ok(t, "токен исключённого минта присутствует в отчёте");
    assert.equal(t.multiplier.now, "1"); // сырые значения не выдумываем
    assert.equal(t.excluded, true); // было: undefined — «1» выглядела вычисленной
    assert.ok(typeof t.excludedReason === "string" && t.excludedReason.length > 0);
  }, (bad) => ({ walletScanner: async () => scanOf(bad.mint) }));
});

// ---- витрина: клиентский скрипт в vm с DOM-стабом (паттерн ui.test.mjs) ----

// route(url) -> {ok, status, body} | Promise<{...}> | undefined (запрос висит вечно)
function runClient(route) {
  const els = new Map();
  const makeEl = (id) => ({
    id, value: '', innerHTML: '', textContent: '', className: '', style: {},
    attrs: {},
    getAttribute(name) { return this.attrs[name] ?? null; },
    scrollIntoView() {},
  });
  const sb = {
    document: {
      getElementById: (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
      querySelectorAll: () => [], // строки таблицы токенов в этих тестах не гоняются
    },
    fetch: (url) => {
      const hit = route(url);
      const p = hit instanceof Promise ? hit : Promise.resolve(hit);
      return p.then((res) => res === undefined
        ? new Promise(() => {})
        : { ok: res.ok, status: res.status, json: async () => res.body });
    },
  };
  vm.createContext(sb);
  const m = renderPage().match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, "script block на месте");
  new vm.Script(m[1], { filename: "page-client.js" }).runInContext(sb); // синтаксис как в браузере
  return { sb, els };
}

const flush = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };

test("кросс-чек бейджи: два события в один день — каждому свой вердикт", async () => {
  const DUP_EVENTS = [
    { effectiveDate: "2026-03-01T00:00:00.000Z", type: "MULTIPLIER_CHANGE", multiplierFrom: "1", multiplierTo: "2", reason: "first dividend" },
    { effectiveDate: "2026-03-01T00:00:00.000Z", type: "MULTIPLIER_CHANGE", multiplierFrom: "2", multiplierTo: "3", reason: "second dividend" },
  ];
  const DUP_VERDICTS = [
    { effectiveDate: "2026-03-01T00:00:00.000Z", verdict: "consistent", note: "n1" },
    { effectiveDate: "2026-03-01T00:00:00.000Z", verdict: "mismatch", note: "n2" },
  ];
  const { sb, els } = runClient((url) => {
    if (url.startsWith("/health")) return { ok: true, status: 200, body: { tokens: 1, events: 2, journal: null } };
    if (url.startsWith("/summary")) return { ok: true, status: 200, body: [
      { symbol: "ONE", name: "Token One", issuer: "Backed", mint: "A".repeat(32), decimals: 8, events: 2, currentMultiplier: "3" },
    ] };
    if (url.startsWith("/events?symbol=ONE")) return { ok: true, status: 200, body: DUP_EVENTS };
    if (url.startsWith("/crosscheck?symbol=ONE")) return { ok: true, status: 200, body: { verdicts: DUP_VERDICTS, coverage: {} } };
    return undefined;
  });
  await flush(); // бут: /health → /summary → select(ONE) → события + кросс-чек
  const html = els.get("events").innerHTML;
  const first = html.split("<li>").find((s) => s.includes("first dividend")) ?? "";
  const second = html.split("<li>").find((s) => s.includes("second dividend")) ?? "";
  assert.ok(first.includes("price: consistent"), "первое событие показывает СВОЙ вердикт");
  assert.ok(second.includes("price: mismatch"), "второе событие — свой");
});

test("витрина: таблица и баннер помечают исключённые токены, а не молчаливая «1»", async () => {
  const REASON = "chain discontinuity at 2026-05-01: expected from=1, got 5";
  const { sb, els } = runClient((url) => {
    if (url.startsWith("/health")) return { ok: true, status: 200, body: { tokens: 2, events: 1, journal: null, excluded: [{ mint: "B".repeat(32), symbol: "TWO", reason: REASON }] } };
    if (url.startsWith("/summary")) return { ok: true, status: 200, body: [
      { symbol: "ONE", name: "Token One", issuer: "Backed", mint: "A".repeat(32), decimals: 8, events: 1, currentMultiplier: "2" },
      { symbol: "TWO", name: "Token Excluded", issuer: "Backed", mint: "B".repeat(32), decimals: 8, events: 0, currentMultiplier: "1", excluded: true, excludedReason: REASON },
    ] };
    return undefined;
  });
  await flush();
  const stats = els.get("stats").innerHTML;
  assert.ok(stats.includes("excluded"), "баннер об исключённых на месте");
  assert.ok(stats.includes(">1<"), "счётчик исключённых показан");
  const two = els.get("tokens").innerHTML.split("<tr").find((s) => s.includes("TWO")) ?? "";
  assert.ok(two.includes("excluded"), "строка исключённого помечена");
  assert.ok(two.includes("chain discontinuity"), "причина доступна (title)");
  assert.ok(!/>1<\/td>/.test(two), "голая «1» не показана вместо вычисленного множителя");
});

test("витрина: отчёт кошелька честно помечает исключённый множитель", async () => {
  const rep = {
    owner: "A".repeat(32),
    counts: { signatures: 1, fetched: 1, skipped: 0, relevantTxs: 1 },
    truncated: false, complete: true,
    tokens: [{ symbol: "TWO", name: "Token Excluded", decimals: 8, rawBalance: "10", onchainNow: "10", reconciles: true,
      multiplier: { now: "1", events: 0 }, adjusted: { exact: true, whole: "10", remainder: "0", den: "1" },
      lots: [], realizedCount: 0, gaps: [],
      excluded: true, excludedReason: "chain discontinuity at 2026-05-01" }],
  };
  const { sb, els } = runClient((url) =>
    url.startsWith("/lots?") ? { ok: true, status: 200, body: rep } : undefined);
  els.get("addr-in").value = "B".repeat(44);
  sb.scanWalletUi();
  await flush();
  const html = els.get("wallet-out").innerHTML;
  assert.ok(html.includes("excluded"), "исключение показано");
  assert.ok(html.includes("chain discontinuity at 2026-05-01"), "причина видна пользователю");
});
