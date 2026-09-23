// Регрессионные тесты раунда 10 — фиксы ночной волны B (ROUND10, из ROUND9-хвостов
// и волны B: см. BUILD_PLAN «раунд 10»). Группы: crosscheck-фinitude (B1-1/B1-2),
// ratio-потолки (B1-3), partial rateLimits (B2-2), flags host/rpc-санити (B3-1),
// лок writeSync (B3-3), esc stats (B4-1), saveFailed в /health (B4-2),
// Array-гвард xstocks (B1-latent), abort-пропагация скана (B2-1).
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { crossCheckMultiplierChange, crossCheckDividendAccrual, crossCheckEvents, CrossCheckError } from "../src/events/crosscheck.mjs";
import { validateEvent } from "../src/schema/events.mjs";
import { multiplierHistoryToEvents } from "../src/events/normalize-xstocks.mjs";
import { parseServeArgs } from "../src/cli/flags.mjs";
import { withStoreLock } from "../src/webhooks/subscriptions.mjs";
import { scanWallet } from "../src/wallet/scan.mjs";
import { createApiServer } from "../src/api/server.mjs";
import { renderPage } from "../src/ui/page.mjs";
import { loadRegistry } from "../src/registry/registry.mjs";

const OWNER = "Wa11etBuyer" + "a".repeat(32);
const SPYx = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const REGISTRY = [{ mint: SPYx, symbol: "SPYx", name: "SPY", issuer: "backed", decimals: 8 }];
const sig = (n) => ({ signature: "s".repeat(43) + String(n), slot: n, blockTime: 1750000000 + n, err: null });

const candlesOf = (...cs) => cs.map(([day, c]) => ({ ts: Date.UTC(2026, 5, day) / 1000, c }));
const multEv = () => ({
  type: "MULTIPLIER_CHANGE", mint: SPYx, effectiveDate: "2026-06-18T00:00:00.000Z",
  status: "confirmed", sources: ["test"], multiplierFrom: "1", multiplierTo: "2", reason: "Rebase",
});
const divEv = () => ({
  type: "DIVIDEND_ACCRUAL", mint: SPYx, effectiveDate: "2026-06-18T00:00:00.000Z",
  status: "confirmed", sources: ["test"], amountPerUnitRaw: 2_000_000, decimals: 8,
});

// ---- B1-1: нечисловые close не проходят гварды <= 0 ----

test("crosscheck: NaN/Infinity/undefined close — честный inconclusive/ошибка, не «mismatch» с null-полями", () => {
  for (const bad of [NaN, undefined, Infinity, "abc"]) {
    const v = crossCheckMultiplierChange(multEv(), candlesOf([16, 100], [17, 100], [18, bad]));
    assert.equal(v.verdict, "inconclusive", `close=${bad}: вердикт не строится на нечисловом close`);
    assert.equal(v.observedRatio, null);
    const d = crossCheckDividendAccrual(divEv(), candlesOf([16, 10000000], [17, 10000000], [18, bad]));
    assert.equal(d.verdict, "inconclusive", `dividend close=${bad}`);
    assert.equal(d.observedDropFraction, null);
  }
});

// ---- B1-2: coverage на мусорном ts свечи ----

test("crosscheck: мусорный ts свечи — честная ошибка/нет данных, не RangeError → 500", () => {
  const bad = [{ ts: NaN, c: 1 }];
  assert.throws(() => crossCheckEvents([multEv()], bad), CrossCheckError);
  // число-строка ts — коэрцится как везде в конвейере дат
  const ok = crossCheckEvents([multEv()], candlesOf([16, 100], [18, 50]));
  assert.ok(Array.isArray(ok.verdicts) && ok.verdicts.length === 1);
});

// ---- B1-3: ratio-потолки SPLIT/MERGER ----

test("schema: SPLIT/MERGER ratio выше MAX_SAFE_INTEGER — отказ, как у amountPerUnitRaw (R9 №14)", () => {
  const tooBig = 2 ** 53 + 1;
  assert.throws(() => validateEvent({
    type: "SPLIT", mint: SPYx, effectiveDate: "2026-10-01T00:00:00.000Z", status: "confirmed",
    sources: ["test"], ratioNumerator: tooBig, ratioDenominator: 1,
  }), (err) => err.name === "EventValidationError" && /ratioNumerator|safe/i.test(err.message));
  assert.throws(() => validateEvent({
    type: "MERGER", mint: SPYx, effectiveDate: "2026-10-01T00:00:00.000Z", status: "confirmed",
    sources: ["test"], newMint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
    exchangeNumerator: tooBig, exchangeDenominator: 1,
  }), (err) => err.name === "EventValidationError" && /exchangeNumerator|safe/i.test(err.message));
});

// ---- B2-2: частичная конфигурация rateLimits ----

test("api: rateLimits без одного из ключей — внятный отказ, не TypeError из деструктуризации", async () => {
  const registry = await loadRegistry("data/tokens.json");
  for (const partial of [{}, { scan: { windowMs: 60_000, max: 5 } }, { rpc: { windowMs: 60_000, max: 5 } }]) {
    // createApiServer не async: бросок может быть синхронным — нормализуем оба случая
    let err = null;
    try {
      const srv = await createApiServer({ registry, events: [], rateLimits: partial });
      srv.close();
    } catch (e) { err = e; }
    assert.ok(err, `конфигурация ${JSON.stringify(partial)} обязана отказать`);
    assert.match(err.message, /rateLimits/i);
  }
});

// ---- B3-1: flags — host с пробелом, rpc-санити ----

test("flags: --host с пробелом/пусто-после-trim — отказ ДО бута; rpc обязан парситься в URL http(s)", () => {
  assert.throws(() => parseServeArgs(["--host", " "]), /host/);
  assert.throws(() => parseServeArgs(["--host", "not a host"]), /host/);
  assert.throws(() => parseServeArgs(["--rpc", "not a url"]), /rpc/);
  assert.throws(() => parseServeArgs(["--rpc", "ftp://x.example"]), /rpc/);
  assert.equal(parseServeArgs(["--rpc", "https://api.example/v1?k=1"]).rpcUrl, "https://api.example/v1?k=1");
  assert.equal(parseServeArgs([]).host, "127.0.0.1");
});

// ---- B3-3: лок — сбой writeSync не оставляет пустой лок ----

test("лок: сбой записи содержимого лока — лок снимается, не реанимирует TOCTOU пустым файлом", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lw-lock-r10-"));
  try {
    const store = path.join(dir, "webhooks.json");
    const failingWrite = () => { throw new Error("ENOSPC"); };
    assert.throws(
      () => withStoreLock(store, () => "never", { writeSync: failingWrite, attempts: 3, retryPauseMs: 1 }),
      /ENOSPC/,
    );
    assert.ok(!exists(store + ".lock"), "лок снят — следующий процесс не увидит пустой файл как легаси");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function exists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

// ---- B4-1: esc в renderStats ----

function runClient() {
  const els = new Map();
  const makeEl = (id) => ({
    id, value: "", innerHTML: "", textContent: "", className: "", style: {},
    attrs: {}, getAttribute() { return null; }, scrollIntoView() {},
  });
  const sb = {
    document: {
      getElementById: (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
      querySelectorAll: () => [],
    },
    fetch: () => new Promise(() => {}),
  };
  vm.createContext(sb);
  const m = renderPage().match(/<script>([\s\S]*?)<\/script>/);
  new vm.Script(m[1], { filename: "page-client.js" }).runInContext(sb);
  return { sb, els };
}

test("vitrine: journal.unavailable и excluded.length из /health — инъекция строкой не живёт", () => {
  const { sb, els } = runClient();
  // строка-вместо-числа: числовой гейт (> 0) сам её прячет, esc() — второй эшелон
  sb.renderStats({ tokens: 31, events: 56, journal: { unavailable: "<script>alert(4)</script>" }, excluded: { length: "<script>alert(5)</script>" } }, []);
  const html = els.get("stats").innerHTML;
  assert.ok(!html.includes("<script>"), "инъекция через health-поля не переживает");
  // числа по контракту рендерятся как раньше (гейт их пропускает, esc() безвреден)
  const { sb: sb2, els: els2 } = runClient();
  sb2.renderStats({ tokens: 31, events: 56, journal: { unavailable: 2 }, excluded: { length: 1 } }, []);
  assert.ok(els2.get("stats").innerHTML.includes("2"), "числовые warn-поля по-прежнему видны");
});

// ---- B4-2: saveFailed в /health ----

test("/health: несохранённый журнал бута виден флагом journal.saveFailed", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const server = await createApiServer({
    registry, events: [],
    journalStats: { replayed: 2, unavailable: 0, corrupted: 0, preserveFailed: 0, saveFailed: 1 },
  });
  const { port } = server.address();
  try {
    const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(h.journal.saveFailed, 1, "события бута только в памяти — мониторинг обязан видеть");
  } finally {
    server.close();
  }
});

// ---- B1-latent: Array-гвард multiplierHistoryToEvents ----

test("xstocks: не-массив истории — NormalizeError, не голый TypeError", () => {
  for (const bad of [null, undefined, "x", { nodes: "x" }]) {
    assert.throws(() => multiplierHistoryToEvents(bad, { symbol: "TESTx" }), (err) => /history|array|nodes/i.test(err.message));
  }
});

// ---- B2-1: abort-пропагация скана ----

test("scan: signal прерывает скан между страницами — RPC-квота не горит после ухода клиента", async () => {
  const ac = new AbortController();
  let calls = 0;
  const client = {
    async call(method, params) {
      if (method === "getTokenAccountsByOwner") return { value: [] };
      if (method === "getTransaction") return null;
      if (method === "getSignaturesForAddress") {
        calls++;
        if (calls >= 3) ac.abort(); // клиент ушёл на третьей странице бесконечной истории
        return [sig(calls), sig(calls + 1000)];
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  await assert.rejects(
    () => scanWallet(client, OWNER, REGISTRY, { limit: 2, maxTxs: 10_000, signal: ac.signal }),
    (err) => /abort/i.test(err.message),
  );
  assert.ok(calls <= 4, `скан остановился уйдя клиента (calls=${calls}), а не дожигал историю`);
}, { timeout: 5000 });
