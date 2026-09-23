// Регрессионные тесты раунда 7 ревью Lotwise — «ограды» (волна 4).
// Находки ROUND7:
//   №8  XFF-корзины по ПЕРВОМУ элементу (client-supplied в appending-цепочке) —
//       ротация заголовка плодит безлимитные корзины; ключ обязан быть ПОСЛЕДНИЙ
//       элемент (тот, что дописал наш доверенный прокси).
//   №9  витрина: числовые-по-контракту поля (counts.signatures/fetched/skipped,
//       multiplier.events, stats tokens/events) идут в innerHTML без esc.
//   №10 serve.mjs: --port/--host/--rpc без гвардов (--port abc живёт до listen,
//       --port=8787 молча игнорируется, --rpc последним убивает env-фолбэк).
//   №14 tx.mjs: гвард `tx === null` пропускает undefined (RPC без result/error) —
//       TypeError валит весь скан вместо честного skip одной транзакции.
//   №15 scaled-ui: pending-множитель без валидации (мусор "abc" ехал в /onchain).
//   №6  metadataSources роняет externalUrl (camelCase-вывод собственного клиента)
//       — Tessera и PreStocks.
//   №13 toDecimalString: String(1e-7)="1e-7" не проходит DECIMAL_RE — вся история
//       токена падала NormalizeError'ом вместо точного позиционного преобразования.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createApiServer } from "../src/api/server.mjs";
import { renderPage } from "../src/ui/page.mjs";
import { parseScaledUiAmount, ScaledUiError } from "../src/issuer/scaled-ui.mjs";
import { fetchWalletDeltas } from "../src/ingest/tx.mjs";
import { multiplierHistoryToEvents } from "../src/events/normalize-xstocks.mjs";
import { metadataSources as tesseraSources } from "../src/issuer/tessera.mjs";
import { metadataSources as prestocksSources } from "../src/events/normalize-prestocks.mjs";
import { parseServeArgs } from "../src/cli/flags.mjs";
import { loadRegistry } from "../src/registry/registry.mjs";

const MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const OWNER = "9BB7Tt5uW5QbAorLkF3Hn1P2mGcXvcDdR7y8LbT9KdUu";

// ---- ROUND7 №8: ключ rate-limit = ПОСЛЕДНИЙ элемент XFF ----

test("ratelimit: спуф первого XFF-элемента не плодит корзины — ключ по последнему", async () => {
  const registry = await loadRegistry("data/tokens.json");
  let scans = 0;
  const server = await createApiServer({
    registry, events: [],
    walletScanner: async () => {
      scans++;
      return { owner: OWNER, signatures: 1, fetched: 1, skipped: [], truncated: false, accounts: new Map(), txs: [] };
    },
    rateLimits: { scan: { windowMs: 60_000, max: 2 }, rpc: { windowMs: 60_000, max: 60 } },
    trustProxy: true,
  });
  const { port } = server.address();
  try {
    const go = (xff) => fetch(`http://127.0.0.1:${port}/lots?address=${OWNER}`, { headers: { "x-forwarded-for": xff } });
    // один реальный клиент 77.77.77.77 за нашим прокси, атакатор ротирует СПУФ-префикс
    assert.equal((await go("1.1.1.1, 77.77.77.77")).status, 200);
    assert.equal((await go("2.2.2.2, 77.77.77.77")).status, 200);
    assert.equal((await go("3.3.3.3, 77.77.77.77")).status, 429, "третий запрос того же реального IP — за пределами 2/мин");
    assert.equal((await go("4.4.4.4, 88.88.88.88")).status, 200, "другой реальный IP — своя корзина");
    assert.equal(scans, 3, "429 не дёргает сканер");
  } finally {
    server.close();
  }
});

// ---- ROUND7 №9: esc() числовых-по-контракту полей витрины ----

// клиентский скрипт страницы в vm с DOM-стабом (паттерн ui.test.mjs, раунд 4)
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
    fetch: () => new Promise(() => {}), // несущественные цепочки молчат
  };
  vm.createContext(sb);
  const m = renderPage().match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, "script block на месте");
  new vm.Script(m[1], { filename: "page-client.js" }).runInContext(sb);
  return { sb, els };
}

test("vitrine: строка в числовом-по-контракту поле (counts.fetched) эскейпится", () => {
  const { sb, els } = runClient();
  sb.renderWallet({
    owner: OWNER,
    counts: { signatures: "<script>alert(1)</script>", fetched: 1, skipped: 0 },
    truncated: false, complete: true, tokens: [],
  });
  const html = els.get("wallet-out").innerHTML;
  assert.ok(!html.includes("<script>alert"), "сырой script не переживает интерполяцию");
  assert.ok(html.includes("&lt;script&gt;"), "значение показано, но эскейпнуто");
});

test("vitrine: multiplier.events — строка-поле тоже эскейпится", () => {
  const { sb, els } = runClient();
  sb.renderWallet({
    owner: OWNER,
    counts: { signatures: 1, fetched: 1, skipped: 0 },
    truncated: false, complete: true,
    tokens: [{
      symbol: "TSTx", name: "Test", decimals: 8, rawBalance: "10", onchainNow: "10", reconciles: true,
      multiplier: { now: "1", events: "<script>alert(2)</script>" },
      adjusted: { exact: true, whole: "10", remainder: "0", den: "1" },
      lots: [], realizedCount: 0, gaps: [],
    }],
  });
  const html = els.get("wallet-out").innerHTML;
  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes("&lt;script&gt;"));
});

// ---- ROUND7 №10: парсер флагов serve.mjs ----

test("flags: --port=8787 (equals-форма) парсится, а не молча игнорируется", () => {
  assert.equal(parseServeArgs(["--port=18899"]).port, 18899);
  assert.equal(parseServeArgs(["--port", "18899"]).port, 18899);
});

test("flags: --port abc — отказ ДО бута (целое число)", () => {
  assert.throws(() => parseServeArgs(["--port", "abc"]), /port/);
  assert.throws(() => parseServeArgs(["--port=0"]), /port/);
});

test("flags: флаг без значения (последний аргумент) — отказ, а не undefined-фолбэк", () => {
  for (const flag of ["--port", "--host", "--rpc", "--max-txs"]) {
    assert.throws(() => parseServeArgs([flag]), new RegExp(flag.slice(2)), `${flag} без значения`);
  }
});

test("flags: дефолты и env-фолбэк RPC не тронуты", () => {
  const a = parseServeArgs([]);
  assert.equal(a.port, 8787);
  assert.equal(a.host, "127.0.0.1");
  assert.equal(a.maxTxs, 300);
  assert.equal(a.rpcUrl, "https://api.mainnet-beta.solana.com");
});

test("flags: --max-txs гвард переезжает в парсер без потери сообщения", () => {
  assert.throws(() => parseServeArgs(["--max-txs", "abc"]), /max-txs/);
  assert.equal(parseServeArgs(["--max-txs", "500"]).maxTxs, 500);
});

// ---- ROUND7 №14: tx === null пропускал undefined ----

test("tx: RPC-ответ без result и без error — честный null (skip), не TypeError всего скана", async () => {
  const lyingGateway = { call: async () => undefined };
  const out = await fetchWalletDeltas(lyingGateway, "sig111111111111111111111111111111111111111111", new Set([MINT]));
  assert.equal(out, null);
});

// ---- ROUND7 №15: pending-множитель валидируется как active ----

test("scaled-ui: pending-мусор («abc») — ScaledUiError, симметрично active", () => {
  const mint = {
    owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    data: { parsed: { info: { decimals: 8, extensions: [{ extension: "scaledUiAmountConfig", state: {
      multiplier: "1", newMultiplier: "abc", newMultiplierEffectiveTimestamp: Date.UTC(2026, 8, 1) / 1000,
    } }] } } },
  };
  assert.throws(() => parseScaledUiAmount(mint), (err) => err instanceof ScaledUiError && /newMultiplier|pending/i.test(err.message));
});

// ---- ROUND7 №6: metadataSources принимает вывод собственного клиента ----

test("tessera metadataSources: camelCase externalUrl (вывод клиента) не теряется", () => {
  const out = tesseraSources({
    externalUrl: "https://www.tessera.pe",
    attributes: [{ trait_type: "Terms and Conditions", value: "https://tessera.example/terms" }],
  });
  assert.deepEqual(out, ["https://www.tessera.pe", "https://tessera.example/terms"]);
});

test("prestocks metadataSources: camelCase externalUrl (вывод клиента) не теряется", () => {
  const out = prestocksSources({ externalUrl: "https://prestocks.com/openai", terms: "https://prestocks.com/terms" });
  assert.deepEqual(out, ["https://prestocks.com/openai", "https://prestocks.com/terms"]);
});

// ---- ROUND7 №13: toDecimalString — экспоненциальная запись числа ----

test("xstocks normalize: множитель-число 1e-7 → точная позиционная строка, токен не падает", () => {
  const events = multiplierHistoryToEvents([
    { id: "n1", reason: "Rebase", multiplier: 1e-7, previousMultiplier: "1", activationDateTime: "2026-07-01T00:00:00Z" },
  ], { symbol: "TESTx" });
  assert.equal(events.length, 1);
  assert.equal(events[0].multiplierTo, "0.0000001");
  assert.equal(events[0].multiplierFrom, "1");
});

test("xstocks normalize: обычные числа/строки едут как раньше", () => {
  const events = multiplierHistoryToEvents([
    { id: "n1", reason: "Rebase", multiplier: 5, previousMultiplier: "1", activationDateTime: "2026-07-01T00:00:00Z" },
  ], { symbol: "TESTx" });
  assert.equal(events[0].multiplierTo, "5");
  const events2 = multiplierHistoryToEvents([
    { id: "n1", reason: "Rebase", multiplier: "1.5", previousMultiplier: "1", activationDateTime: "2026-07-01T00:00:00Z" },
  ], { symbol: "TESTx" });
  assert.equal(events2[0].multiplierTo, "1.5");
});
