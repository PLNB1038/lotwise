// Регрессионные тесты раунда 12 — волна D (витрина-состояния + CLI + данные).
//   D1-1 [P2]: .catch loadPlanes/calc без stale-гварда — чужая ошибка ложится
//              поверх выбранного токена (бейдж сверки = головной элемент честности).
//   D1-2 [P3]: смена токена не чистит events/calc — данные A под заголовком B.
//   D1-3 [P3]: intra-токен гонка калькулятора (устаревший ответ рисуется последним).
//   D1-4 [P3]: кэш скана ≤10мин показывается как свежий; rep.now не рендерится.
//   D1-5 [P3]: бут без res.ok/Array.isArray → «undefined tokens tracked».
//   D2-1 [P2]: process.exit после fetch крашит CLI на УСПЕХЕ (контракт 0/1/2).
//   D2-2 [P3]: пустой stdin = «пустой список» (no-op), не exit 2.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderPage } from "../src/ui/page.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPYx = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const TOKEN_A = { symbol: "AAA", name: "Token A", issuer: "Backed", mint: SPYx, decimals: 8, events: 2, currentMultiplier: "1" };
const TOKEN_B = { symbol: "BBB", name: "Token B", issuer: "Backed", mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", decimals: 8, events: 1, currentMultiplier: "1" };

// vm-харнесс с маршрутизируемым fetch (управляемые pending-промисы для гонок)
function runClient(routes) {
  const els = new Map();
  const makeEl = (id) => ({
    id, value: "", innerHTML: "", textContent: "", className: "", style: {},
    attrs: {}, getAttribute() { return null; }, scrollIntoView() {},
  });
  const sb = {
    document: {
      getElementById: (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
      querySelectorAll: () => [{ className: "", getAttribute() { return "AAA"; }, addEventListener() {} }],
    },
    fetch: (url) => {
      const hit = routes[String(url)];
      if (hit === undefined) return new Promise(() => {}); // висим — несущественные цепочки молчат
      return hit instanceof Promise ? hit : Promise.resolve(hit);
    },
    console: { error() {}, warn() {} },
  };
  vm.createContext(sb);
  const m = renderPage().match(/<script>([\s\S]*?)<\/script>/);
  new vm.Script(m[1], { filename: "page-client.js" }).runInContext(sb);
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };
  return { sb, els, flush };
}

const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

// ---- D1-1 [P2]: stale-гвард в .catch ----

test("vitrine: ошибка УСТАРЕВШЕГО запроса /onchain не перезаписывает бейдж нового токена", async () => {
  let rejectA;
  const hangingA = new Promise((_, rej) => { rejectA = rej; });
  const { sb, els, flush } = runClient({
    "/onchain?symbol=AAA": hangingA,
    "/onchain?symbol=BBB": json({ api: "1", onChain: { active: "1" }, onChainEffective: "1", verdict: "ok" }),
  });
  sb.state.tokens = [TOKEN_A, TOKEN_B]; // бут обычно заполняет через /summary
  sb.renderTokens([TOKEN_A, TOKEN_B]);
  sb.select("AAA");
  await flush();
  sb.select("BBB");
  await flush();
  assert.match(els.get("verdict").textContent ?? "", /ok|agree/i, "у B отрисовался свой вердикт");
  rejectA(new Error("fetch failed")); // ответ A пришёл с ошибкой ПОСЛЕ выбора B
  await flush();
  assert.match(els.get("verdict").textContent ?? "", /ok|agree/i, "ошибка A НЕ ложится на бейдж B (stale-гвард в catch)");
});

// ---- D1-2 [P3]: смена токена чистит events/calc ----

test("vitrine: выбор нового токена очищает таймлайн событий и калькулятор (pending-плейсхолдеры)", async () => {
  const { sb, els, flush } = runClient({
    "/events?symbol=AAA": json([{ type: "MULTIPLIER_CHANGE", effectiveDate: "2026-06-10", reason: "A event" }]),
    "/crosscheck?symbol=AAA": json({ pool: null, coverage: { candles: 0 }, verdicts: [] }),
    "/events?symbol=BBB": new Promise(() => {}), // висит — окно гонки
    "/crosscheck?symbol=BBB": new Promise(() => {}),
    "/onchain?symbol=AAA": json({ verdict: "ok", api: "1", onChain: { active: "1" }, onChainEffective: "1" }),
    "/onchain?symbol=BBB": new Promise(() => {}),
  });
  sb.state.tokens = [TOKEN_A, TOKEN_B]; // бут обычно заполняет через /summary
  sb.renderTokens([TOKEN_A, TOKEN_B]);
  sb.select("AAA");
  await flush();
  assert.ok(els.get("events").innerHTML.includes("A event"), "у A события отрисованы");
  sb.select("BBB");
  await flush();
  assert.ok(!els.get("events").innerHTML.includes("A event"), "события A не висят под заголовком B");
  assert.ok(!els.get("calc-out").innerHTML.includes("adjusted"), "калькулятор A не висит под B");
});

// ---- D1-3 [P3]: эпоха калькулятора ----

test("vitrine: устаревший пересчёт калькулятора не перерисовывается поверх свежего", async () => {
  const dynamic = runClientDynamic();
  dynamic.sb.state.tokens = [TOKEN_A];
  dynamic.sb.renderTokens([TOKEN_A]);
  dynamic.sb.select("AAA");
  await dynamic.flush();
  dynamic.els.get("raw-in").value = "1.5";
  dynamic.sb.calc();
  const slowIdx = dynamic.take(); // первый расчёт — висит
  dynamic.els.get("raw-in").value = "9.9";
  dynamic.sb.calc();
  const fastIdx = dynamic.take(); // второй расчёт
  dynamic.resolveAt(fastIdx, { multiplier: "2", date: "2026-07-01T00:00:00.000Z", sampleScaledQty: { exact: true, whole: "1980000000", remainder: "0", den: "1" } });
  await dynamic.flush();
  assert.ok(dynamic.els.get("calc-out").innerHTML.includes("1980000000"), "свежий расчёт (9.9) отрисован");
  dynamic.resolveAt(slowIdx, { multiplier: "3", date: "2026-07-01T00:00:00.000Z", sampleScaledQty: { exact: true, whole: "450000000", remainder: "0", den: "1" } });
  await dynamic.flush();
  assert.ok(!dynamic.els.get("calc-out").innerHTML.includes("450000000"), "устаревший ответ (1.5) НЕ перерисовался поверх 9.9");
});

function runClientDynamic() {
  const els = new Map();
  const makeEl = (id) => ({
    id, value: "", innerHTML: "", textContent: "", className: "", style: {},
    attrs: {}, getAttribute() { return null; }, scrollIntoView() {},
  });
  const pending = [];
  const sb = {
    document: {
      getElementById: (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
      querySelectorAll: () => [{ className: "", getAttribute() { return "AAA"; }, addEventListener() {} }],
    },
    fetch: (url) => {
      if (String(url).startsWith("/multiplier")) {
        // резолверы складываются в порядке запросов; резолв по индексу
        return new Promise((resolve) => {
          pending.push((body) => resolve(json(body)));
        });
      }
      if (String(url).startsWith("/events")) return Promise.resolve(json([]));
      if (String(url).startsWith("/crosscheck")) return Promise.resolve(json({ pool: null, coverage: { candles: 0 }, verdicts: [] }));
      if (String(url).startsWith("/onchain")) return Promise.resolve(json({ verdict: "ok", api: "1", onChain: { active: "1" }, onChainEffective: "1" }));
      return Promise.resolve(json({ ok: true, status: 200 }));
    },
    console: { error() {}, warn() {} },
  };
  vm.createContext(sb);
  const m = renderPage().match(/<script>([\s\S]*?)<\/script>/);
  new vm.Script(m[1], { filename: "page-client.js" }).runInContext(sb);
  return {
    sb, els,
    take: () => pending.length - 1, // индекс резолвера последнего запроса
    resolveAt: (idx, body) => { if (typeof pending[idx] === "function") pending[idx](body); },
    flush: async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); },
  };
}

// ---- D1-4 [P3]: свежесть отчёта ----

test("vitrine: отчёт кошелька показывает время генерации сервера (rep.now)", () => {
  const { sb, els } = (() => {
    const els = new Map();
    const makeEl = (id) => ({ id, value: "", innerHTML: "", textContent: "", className: "", style: {}, attrs: {}, getAttribute() { return null; }, scrollIntoView() {} });
    const sb = {
      document: { getElementById: (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); }, querySelectorAll: () => [] },
      fetch: () => new Promise(() => {}),
      console: { error() {}, warn() {} },
    };
    vm.createContext(sb);
    new vm.Script(renderPage().match(/<script>([\s\S]*?)<\/script>/)[1], { filename: "page-client.js" }).runInContext(sb);
    return { sb, els };
  })();
  sb.renderWallet({
    owner: "Wa11etBuyer" + "a".repeat(32),
    now: "2026-09-23T20:31:00.000Z",
    counts: { signatures: 5, fetched: 5, skipped: 0 }, truncated: false, complete: true, tokens: [],
  });
  assert.ok(els.get("wallet-out").innerHTML.includes("2026-09-23 20:31"), "время генерации отчёта видно (кэш ≤10мин отличим от свежего скана; раунд 18: дата без полной ISO-каши)");
});

// ---- D1-5 [P3]: бут-гварды ----

test("vitrine: бут при 502-джейсоне /health — честная недоступность, не «undefined tokens tracked»", async () => {
  const { els, flush } = runClient({
    "/health": json({ error: "bad gateway" }, false, 502),
    "/summary": json([{ ...TOKEN_A }]),
  });
  await flush();
  const stats = els.get("stats").innerHTML;
  assert.ok(!stats.includes("undefined"), "undefined не рендерится");
});

// ---- D2-1/D2-2: CLI ----

test("cli: webhook-deliver завершается контрактным кодом, без undici-краша процесса (волна D2)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lw-cli-r12-"));
  try {
    // публичный URL: доставка честно провалится (example.com не примет вебхук),
    // контракт кода выхода = 1; ДО фикса process.exit над живым undici-сокетом
    // крашил процесс (0xC0000409/127 на win) даже на УСПЕШНЫХ прогонах
    writeFileSync(path.join(dir, "subs.json"), JSON.stringify([
      { id: "wh_a", url: "https://example.com/hook", symbols: "*", secret: "s1", createdAt: "2026-09-23T00:00:00.000Z", active: true },
    ]));
    writeFileSync(path.join(dir, "events.json"), JSON.stringify([
      { type: "MULTIPLIER_CHANGE", mint: SPYx, effectiveDate: "2026-06-10T04:30:00.000Z", status: "confirmed", sources: ["test"], multiplierFrom: "1", multiplierTo: "5", reason: "Rebase" },
    ]));
    const res = spawnSync(process.execPath, [
      path.join(ROOT, "scripts", "webhook-deliver.mjs"),
      "--events", path.join(dir, "events.json"),
      "--subscriptions", path.join(dir, "subs.json"),
    ], { encoding: "utf8", timeout: 120_000 });
    assert.equal(res.status, 1, `контрактный код провала = 1 (без краша; got ${res.status}, stderr: ${(res.stderr ?? "").slice(0, 200)})`);
    assert.ok(res.status !== 3221226505 && res.status !== 127, "undici-краш процесса не случился");
    assert.match(res.stdout, /failed=1/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: пустой stdin webhook-deliver — честный no-op (exit 0), не «события не парсятся»", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lw-cli2-r12-"));
  try {
    writeFileSync(path.join(dir, "subs.json"), JSON.stringify([
      { id: "wh_a", url: "https://example.com/hook", symbols: "*", secret: "s1", createdAt: "2026-09-23T00:00:00.000Z", active: true },
    ]));
    const res = spawnSync(process.execPath, [
      path.join(ROOT, "scripts", "webhook-deliver.mjs"),
      "--subscriptions", path.join(dir, "subs.json"),
    ], { input: "", encoding: "utf8", timeout: 30_000 });
    assert.equal(res.status, 0, `пустой список = no-op (stderr: ${res.stderr?.slice(0, 200)})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
