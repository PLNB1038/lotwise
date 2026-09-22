// Регрессионные тесты раунда 6 ревью Lotwise — зона src/ui/page.mjs (витрина).
// Находки:
//   LW2_calc_typeerror_on_no_timeline_token — calc() безусловно читает m.sampleScaledQty.exact:
//       короткий ответ /multiplier для токена без таймлайна ({mint,date,multiplier:"1",events:0})
//       или {error} на 400 рендерит в calc-out голый «Cannot read properties of undefined
//       (reading 'exact')» вместо честной приписки;
//   LW2_vitrine_ignores_journal_corrupted  — витрина читает из /health только journal.unavailable
//       и excluded: journal.corrupted / journal.preserveFailed / registry.corrupted не показываются,
//       после старта с битым журналом бэкфилловые «1» выглядят вычисленными;
//   LW2_excluded_token_adjusted_row_unmarked — renderWallet для excluded/adjustedAvailable:false
//       рисует строку «adjusted (exact) = raw» (сырой баланс выдаётся за скорректированный),
//       а completeness молчит о токенах, исключённых из множителей.
// Клиентский скрипт гоняется в vm с DOM-стабом (паттерн ui.test.mjs / round5-api-ui.test.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { renderPage } from "../src/ui/page.mjs";
import vm from "node:vm";

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

const MINT = "A".repeat(32);
const SUMMARY_ONE = [
  { symbol: "NOX", name: "Token NoX", issuer: "Backed", mint: MINT, decimals: 8, events: 0, currentMultiplier: "1" },
];
const HEALTH_ONE = { ok: true, status: 200, body: { tokens: 1, events: 0, journal: null } };

// ---- LW2_calc_typeerror_on_no_timeline_token: calc честен при неполном /multiplier ----

test("calc: токен без таймлайна (короткий ответ без sampleScaledQty) — приписка, не TypeError", async () => {
  const { sb, els } = runClient((url) => {
    if (url.startsWith("/health")) return HEALTH_ONE;
    if (url.startsWith("/summary")) return { ok: true, status: 200, body: SUMMARY_ONE };
    // точная форма server.mjs:208 для токена без таймлайна — sampleScaledQty нет
    if (url.startsWith("/multiplier")) {
      return { ok: true, status: 200, body: { mint: MINT, date: "2026-09-20T00:00:00.000Z", multiplier: "1", events: 0 } };
    }
    return undefined; // /events, /onchain — не суть теста
  });
  await flush(); // бут: /health → /summary → select(NOX) → calc → /multiplier
  const html = els.get("calc-out").innerHTML;
  assert.ok(html.includes("multiplier unavailable for this token"), "честная приписка на месте");
  assert.ok(!html.includes("Cannot read properties"), "голого TypeError нет");
  assert.ok(!html.includes("adjusted (base units)"), "adjusted не выдуман");
  assert.ok(!html.includes("remainder policy"), "dust-политика не рисуется без расчёта");
  assert.ok(!html.includes("multiplier at"), "сфабрикованная «1» не показана как расчёт");
  sb.calc(); // ручной пересчёт по той же ветке — стабильно
  await flush();
  assert.ok(els.get("calc-out").innerHTML.includes("multiplier unavailable for this token"), "приписка и при ручном calc");
});

test("calc: {error}-ответ /multiplier (400) — текст причины, не TypeError", async () => {
  const { els } = runClient((url) => {
    if (url.startsWith("/health")) return HEALTH_ONE;
    if (url.startsWith("/summary")) return { ok: true, status: 200, body: SUMMARY_ONE };
    if (url.startsWith("/multiplier")) {
      return { ok: false, status: 400, body: { error: "date must be ISO-8601 (YYYY-MM-DD, or with time + timezone)" } };
    }
    return undefined;
  });
  await flush();
  const html = els.get("calc-out").innerHTML;
  assert.ok(html.includes("date must be ISO-8601"), "причина из {error} показана");
  assert.ok(!html.includes("Cannot read properties"), "голого TypeError нет");
});

test("calc: полный ответ с sampleScaledQty считается как раньше — гвард не перегнул", async () => {
  const { els } = runClient((url) => {
    if (url.startsWith("/health")) return HEALTH_ONE;
    if (url.startsWith("/summary")) return { ok: true, status: 200, body: SUMMARY_ONE };
    if (url.startsWith("/multiplier")) {
      return { ok: true, status: 200, body: { mint: MINT, date: "2026-09-20T00:00:00.000Z", multiplier: "2",
        sampleScaledQty: { exact: true, whole: "300000000", remainder: "0", den: "1" }, events: 1 } };
    }
    return undefined;
  });
  await flush();
  const html = els.get("calc-out").innerHTML;
  assert.ok(html.includes("multiplier at 2026-09-20"), "дата расчёта на месте");
  assert.ok(html.includes("adjusted (base units)") && html.includes("300000000"), "расчёт отрендерен");
  assert.ok(html.includes("no dust"), "dust-политика на месте");
});

// ---- LW2_vitrine_ignores_journal_corrupted: баннеры повреждений из /health ----

const bootWithHealth = (health) => runClient((url) => {
  if (url.startsWith("/health")) return { ok: true, status: 200, body: health };
  if (url.startsWith("/summary")) return { ok: true, status: 200, body: [] };
  return undefined;
});

test("renderStats: journal.corrupted / preserveFailed / registry.corrupted — по баннеру на каждый truthy", async () => {
  const { els } = bootWithHealth({
    tokens: 2, events: 1,
    journal: { replayed: 1, unavailable: 0, corrupted: 1, preserveFailed: 1 },
    registry: { corrupted: 1 },
  });
  await flush();
  const html = els.get("stats").innerHTML;
  assert.ok(html.includes("journal corrupted at startup"), "баннер: журнал повреждён");
  assert.ok(html.includes("corrupted journal could not be preserved"), "баннер: улика не сохранена");
  assert.ok(html.includes("token registry corrupted at startup"), "баннер: реестр повреждён");
  assert.equal((html.match(/multipliers may be incomplete, restored by backfill/g) || []).length, 3,
    "у каждого баннера честная приписка про бэкфилл");
  assert.ok(html.includes(">1<"), "значение флага показано как у других баннеров");
});

test("renderStats: нулевые флаги (0 / journal null / registry отсутствует) — тишина, без краша", async () => {
  let r = bootWithHealth({ tokens: 2, events: 1, journal: { replayed: 2, unavailable: 0, corrupted: 0, preserveFailed: 0 }, registry: { corrupted: 0 } });
  await flush();
  let html = r.els.get("stats").innerHTML;
  assert.ok(!html.includes("journal corrupted at startup"), "corrupted 0 — без баннера");
  assert.ok(!html.includes("could not be preserved"), "preserveFailed 0 — без баннера");
  assert.ok(!html.includes("registry corrupted at startup"), "registry.corrupted 0 — без баннера");
  r = bootWithHealth({ tokens: 2, events: 1, journal: null }); // registry-поля нет вовсе
  await flush();
  html = r.els.get("stats").innerHTML;
  assert.ok(!html.includes("corrupted"), "journal null и без registry — баннеров нет, краша нет");
});

// ---- LW2_excluded_token_adjusted_row_unmarked: adjusted не выдаёт raw за себя ----

const ADDR = "Wa11etBuyer" + "a".repeat(32);
const repOf = (token) => ({
  owner: ADDR,
  counts: { signatures: 1, fetched: 1, skipped: 0, relevantTxs: 1 },
  truncated: false, complete: true,
  tokens: [token],
});
const baseToken = {
  symbol: "NOX", name: "Token NoX", decimals: 8,
  rawBalance: "10", onchainNow: "10", reconciles: true,
  multiplier: { now: "1", events: 0 },
  adjusted: { exact: true, whole: "10", remainder: "0", den: "1" },
  lots: [], realizedCount: 0, gaps: [],
};
const scanWallet = (token) => {
  const { sb, els } = runClient((url) =>
    url.startsWith("/lots?") ? { ok: true, status: 200, body: repOf(token) } : undefined);
  els.get("addr-in").value = "B".repeat(44);
  sb.scanWalletUi();
  return { sb, els, out: () => els.get("wallet-out").innerHTML };
};

test("renderWallet: excluded-токен — «adjusted — not computed», raw не выдаётся за adjusted; completeness считает исключённые", async () => {
  const { out } = scanWallet({ ...baseToken, excluded: true, excludedReason: "chain discontinuity at 2026-05-01" });
  await flush();
  const html = out();
  assert.ok(html.includes("adjusted — not computed"), "честная строка вместо adjusted-расчёта");
  assert.ok(html.includes("chain discontinuity at 2026-05-01"), "причина исключения видна");
  assert.ok(!html.includes("adjusted (exact)"), "строки «adjusted (exact) = raw» больше нет");
  assert.ok(html.includes("1 tokens excluded"), "completeness помечает исключённые токены");
});

test("renderWallet: adjustedAvailable === false без excluded — adjusted not computed, completeness чист", async () => {
  // контракт с фиксом /lots: API добавляет adjustedAvailable:false для excluded-минтов;
  // рендер обязан сработать и без t.excluded
  const { out } = scanWallet({ ...baseToken, adjustedAvailable: false });
  await flush();
  const html = out();
  assert.ok(html.includes("adjusted — not computed"), "adjusted-расчёт не показан");
  assert.ok(!html.includes("adjusted (exact)"), "сырое значение не выдано за adjusted (exact)");
  assert.ok(!html.includes("tokens excluded"), "не-excluded токен не считается исключённым");
});

test("renderWallet: обычный токен (adjustedAvailable: true) — adjusted (exact) как раньше", async () => {
  const { out } = scanWallet({
    ...baseToken, adjustedAvailable: true,
    adjusted: { exact: false, whole: "9", remainder: "1", den: "3" },
  });
  await flush();
  const html = out();
  assert.ok(html.includes("adjusted (exact)"), "строка adjusted (exact) на месте");
  assert.ok(html.includes("0.00000009") && html.includes("+ 1/3 base units"), "значение с остатком отрендерено");
  assert.ok(!html.includes("not computed"), "ложной приписки у вычисленного нет");
  assert.ok(!html.includes("tokens excluded"), "суффикса исключённых нет");
});
