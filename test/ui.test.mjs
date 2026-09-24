import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/api/server.mjs";
import { multiplierHistoryToEvents, bindMintAndValidate } from "../src/events/normalize-xstocks.mjs";
import { loadRegistry } from "../src/registry/registry.mjs";
import { parseScaledUiAmount } from "../src/issuer/scaled-ui.mjs";
import { renderPage } from "../src/ui/page.mjs";
import { readFileSync } from "node:fs";
import net from "node:net";
import vm from "node:vm";
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

test("/summary: строка на каждый токен реестра, сортировка событиями, множитель сегодня у SPYx", async () => {
  await withServer(async (base) => {
    const rows = await (await fetch(`${base}/summary`)).json();
    assert.equal(rows.length, (await loadRegistry("data/tokens.json")).length);
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

// --- регрессии раунда ревью 19.09 ---

function rawRequest(port, reqline) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1");
    let buf = "";
    s.on("connect", () => s.write(reqline));
    s.on("data", (d) => (buf += d.toString("latin1")));
    s.on("error", reject);
    s.on("close", () => resolve(buf));
    setTimeout(() => s.destroy(), 2000);
  });
}

test("краш-вектор request-target (http://:80/) — 400, сервер жив (регрессия живого краша)", async () => {
  await withServer(async (base) => {
    const { port } = new URL(base);
    const res = await rawRequest(
      Number(port),
      "GET http://:80/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
    );
    assert.match(res, /400 Bad Request/); // раньше: ERR_INVALID_URL убивал процесс одним запросом
    const after = await fetch(`${base}/health`);
    assert.equal(after.status, 200); // сервер пережил крафтовый запрос
  });
});

test("не-GET методы — 405, POST больше не выполняет GET-логику", async () => {
  await withServer({ onchainReader: async () => parseScaledUiAmount(onchainFixture.result.value) }, async (base) => {
    for (const path of ["/", "/onchain?symbol=SPYx", "/summary"]) {
      const res = await fetch(`${base}${path}`, { method: "POST" });
      assert.equal(res.status, 405, path);
    }
  });
});

test("mint/symbol вне реестра — 400 на всех трёх маршрутах, в цепь не идём", async () => {
  let readerCalls = 0;
  await withServer({ onchainReader: async () => { readerCalls++; return parseScaledUiAmount(onchainFixture.result.value); } }, async (base) => {
    const unknown = "?mint=NotInRegistry1111111111111111111111111111";
    for (const route of ["/events", "/multiplier", "/onchain"]) {
      const res = await fetch(`${base}${route}${unknown}`);
      assert.equal(res.status, 400, route); // раньше /events молча [] и "1", /onchain гонял RPC с мусором
    }
    const sym = await fetch(`${base}/events?symbol=NOSUCHx`);
    assert.equal(sym.status, 400);
    assert.equal(readerCalls, 0); // ридер не дёргался ни разу
  });
});

test("клиентский скрипт страницы компилируется (escape-регрессии шаблона)", async () => {
  await withServer(async (base) => {
    const html = await (await fetch(`${base}/`)).text();
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(m, "script block на месте");
    new vm.Script(m[1]); // синтаксис как есть в браузере, упадёт если \\-эскейпы разъехались
  });
});

test("занятый порт — createApiServer reject'ит, а не роняет процесс", async () => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
  const busyPort = blocker.address().port;
  const registry = await loadRegistry("data/tokens.json");
  await assert.rejects(createApiServer({ registry, events, port: busyPort }));
  blocker.close();
});

// ---- регрессии раунда 4: клиентский скрипт гоняется в vm с DOM-стабом ----

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
      // нет маршрута — запрос висит: несущественные цепочки (/onchain, /multiplier) молчат
      return p.then((res) => res === undefined
        ? new Promise(() => {})
        : { ok: res.ok, status: res.status, json: async () => res.body });
    },
  };
  vm.createContext(sb);
  const m = renderPage().match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, "script block на месте");
  new vm.Script(m[1], { filename: "page-client.js" }).runInContext(sb); // var/функции — глобали sb
  return { sb, els };
}

const flush = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };

// строго base58 (как в wallet.test.mjs), различимы в отчёте
const ADDR_A = "Wa11etBuyer" + "a".repeat(32);
const ADDR_B = "Wa11etSe11er" + "b".repeat(32);

const repOf = (owner, symbol, name) => ({
  owner,
  counts: { signatures: 2, fetched: 2, skipped: 0, relevantTxs: 2 },
  truncated: false, complete: true,
  tokens: [{ symbol, name, decimals: 8, rawBalance: "100", onchainNow: "100", reconciles: true,
    multiplier: { now: "1", events: 0 }, adjusted: { exact: true, whole: "100", remainder: "0", den: "1" },
    lots: [], realizedCount: 0, gaps: [] }],
});
const repA = repOf(ADDR_A, "AAA", "Wallet A token");
const repB = repOf(ADDR_B, "BBB", "Wallet B token");

const SUMMARY_TWO = [
  { symbol: "ONE", name: "Token One", issuer: "Backed", mint: ADDR_A, decimals: 8, events: 2, currentMultiplier: "2" },
  { symbol: "TWO", name: "Token Two", issuer: "Backed", mint: ADDR_B, decimals: 8, events: 1, currentMultiplier: "1" },
];
const EVENTS_ONE = [{ effectiveDate: "2025-01-01", type: "DIVIDEND", multiplierFrom: "1", multiplierTo: "2", reason: "dividend" }];

test("гонка кошельковых отчётов: дозревший ответ старого адреса не перезаписывает свежий", async () => {
  let resolveA;
  const slowA = new Promise((r) => { resolveA = r; }); // скан A «долго идёт по цепи»
  const { sb, els } = runClient((url) => {
    if (!url.startsWith("/lots?")) return undefined;
    return url.includes(ADDR_A) ? slowA : { ok: true, status: 200, body: repB };
  });
  els.get("addr-in").value = ADDR_A;
  sb.scanWalletUi();
  els.get("addr-in").value = ADDR_B; // пользователь не дождался и сканирует B
  sb.scanWalletUi();
  await flush();
  const out = els.get("wallet-out");
  assert.ok(out.innerHTML.includes(ADDR_B), "свежий отчёт B отрендерился");
  assert.ok(!out.innerHTML.includes(ADDR_A), "до дозревания A отчёта A нет");
  resolveA({ ok: true, status: 200, body: repA }); // медленный ответ A дозревает при адресе B
  await flush();
  assert.ok(out.innerHTML.includes(ADDR_B), "после дозревания A отчёт B на месте");
  assert.ok(!out.innerHTML.includes(ADDR_A), "устаревший ответ A не перезаписал");
});

test("гонка кошельковых отчётов: ошибка устаревшего запроса тоже не перезаписывает", async () => {
  let rejectA;
  const slowA = new Promise((_, r) => { rejectA = r; });
  const { sb, els } = runClient((url) =>
    url.includes(ADDR_A) ? slowA : { ok: true, status: 200, body: repB });
  els.get("addr-in").value = ADDR_A;
  sb.scanWalletUi();
  els.get("addr-in").value = ADDR_B;
  sb.scanWalletUi();
  await flush();
  rejectA(new Error("HTTP 429")); // старый запрос упал уже после рендера B
  await flush();
  const out = els.get("wallet-out");
  assert.ok(out.innerHTML.includes(ADDR_B), "отчёт B не тронут");
  assert.ok(!out.innerHTML.includes("429"), "чужая ошибка не показана");
});

test("отчёт кошелька показывает владельца (owner) в шапке — чужие числа атрибутируемы", async () => {
  const { sb, els } = runClient((url) =>
    url.startsWith("/lots?") ? { ok: true, status: 200, body: repA } : undefined);
  els.get("addr-in").value = ADDR_A;
  sb.scanWalletUi();
  await flush();
  const html = els.get("wallet-out").innerHTML;
  assert.ok(html.includes("owner"), "строка owner в шапке");
  assert.ok(html.includes(ADDR_A), "владелец отрендерен");
  assert.ok(html.includes("AAA"), "токены отчёта на месте");
});

test("loadEvents: рестарт сервера (fetch реджект) — err-заметка, чужой таймлайн вытеснен", async () => {
  const { sb, els } = runClient((url) => {
    if (url.startsWith("/health")) return { ok: true, status: 200, body: { tokens: 2, events: 3, journal: null } };
    if (url.startsWith("/summary")) return { ok: true, status: 200, body: SUMMARY_TWO };
    if (url.startsWith("/events?symbol=ONE")) return { ok: true, status: 200, body: EVENTS_ONE };
    if (url.startsWith("/events?symbol=TWO")) return Promise.reject(new Error("fetch failed — server restarted"));
    return undefined; // /onchain, /crosscheck — не суть теста
  });
  await flush(); // бут: /health -> /summary -> select(ONE) -> события ONE
  assert.ok(els.get("events").innerHTML.includes("2025-01-01"), "события ONE на месте");
  sb.select("TWO"); // переключение токена при лежащем сервере
  await flush();
  const html = els.get("events").innerHTML;
  assert.ok(html.includes("Event history unavailable"), "честная err-заметка");
  assert.ok(html.includes("server restarted"), "причина видна");
  assert.ok(!html.includes("2025-01-01"), "события ПРЕДЫДУЩЕГО токена вытеснены");
});

test("loadEvents: не-массив ({error} от 500) — err-заметка, не замаскированная пустота", async () => {
  const { sb, els } = runClient((url) => {
    if (url.startsWith("/health")) return { ok: true, status: 200, body: { tokens: 2, events: 3, journal: null } };
    if (url.startsWith("/summary")) return { ok: true, status: 200, body: SUMMARY_TWO };
    if (url.startsWith("/events?symbol=ONE")) return { ok: true, status: 200, body: EVENTS_ONE };
    if (url.startsWith("/events?symbol=TWO")) return { ok: false, status: 500, body: { error: "internal error" } };
    return undefined;
  });
  await flush();
  sb.select("TWO");
  await flush();
  const html = els.get("events").innerHTML;
  assert.ok(html.includes("Event history unavailable"), "честная err-заметка");
  assert.ok(html.includes("500") && html.includes("internal error"), "статус и причина видны");
  assert.ok(!html.includes("No normalized events"), "ошибка не выдаётся за пустую историю");
});

test("renderStats: journal.unavailable > 0 — честный баннер; 0/null — тишина", async () => {
  const boot = (health) => runClient((url) => {
    if (url.startsWith("/health")) return { ok: true, status: 200, body: health };
    if (url.startsWith("/summary")) return { ok: true, status: 200, body: [] };
    return undefined;
  });
  let r = boot({ tokens: 26, events: 31, journal: { replayed: 0, unavailable: 3 } });
  await flush();
  assert.ok(r.els.get("stats").innerHTML.includes("tokens unavailable at startup"), "баннер на месте");
  assert.ok(r.els.get("stats").innerHTML.includes(">3<"), "число непрочитанных показано");
  r = boot({ tokens: 26, events: 31, journal: { replayed: 31, unavailable: 0 } });
  await flush();
  assert.ok(!r.els.get("stats").innerHTML.includes("tokens unavailable at startup"), "unavailable 0 — без баннера");
  r = boot({ tokens: 26, events: 31, journal: null });
  await flush();
  assert.ok(!r.els.get("stats").innerHTML.includes("tokens unavailable at startup"), "journal null (без stats) — без баннера");
});

test("fmtUi: decimals null — сырые base units с пометкой, а не «.»; известные decimals не сломаны", () => {
  const { sb } = runClient(() => undefined);
  const out = sb.fmtUi("12345", null);
  assert.ok(!out.includes("."), "точка из slice(0, -null) не рендерится");
  assert.ok(out.includes("12345"), "сырые base units видны");
  assert.ok(out.includes("base units") && out.includes("decimals unknown"), "пометка честности");
  assert.equal(sb.fmtUi("12345", 4), "1.2345");
  assert.equal(sb.fmtUi("12345", 8), "0.00012345");
  assert.equal(sb.fmtUi("0", 8), "0.00000000");
  assert.equal(sb.fmtUi("-100", 2), "-1.00");
});

test("calc: decimals null — честная заметка, подсчёт не притворяется 0-децимальным", async () => {
  let multiplierCalls = 0;
  const { sb, els } = runClient((url) => {
    if (url.startsWith("/health")) return { ok: true, status: 200, body: { tokens: 1, events: 0, journal: null } };
    if (url.startsWith("/summary")) return { ok: true, status: 200, body: [
      { symbol: "NULLD", name: "Token with null decimals", issuer: "Backed", mint: ADDR_A, decimals: null, events: 0, currentMultiplier: "1" },
    ] };
    if (url.startsWith("/multiplier")) { multiplierCalls++; return undefined; } // висим, но считаем вызовы
    return undefined;
  });
  await flush(); // бут сам выбрал единственный токен и вызвал calc
  assert.ok(els.get("calc-out").innerHTML.includes("decimals unknown for this token"), "заметка после бут-calc");
  els.get("raw-in").value = "2.5";
  sb.calc();
  assert.ok(els.get("calc-out").innerHTML.includes("decimals unknown for this token"), "заметка после ручного calc");
  assert.ok(els.get("calc-out").innerHTML.includes("2.5"), "ввод показан как есть");
  assert.ok(!els.get("calc-out").innerHTML.includes("multiplier at"), "расчёта с выдуманными decimals нет");
  assert.equal(multiplierCalls, 0, "эндпоинт /multiplier с нулевыми-by-выдумкой raw не дёргается");
});

// ---- раунд 7: логотип — инлайн-знак в шапке, самодостаточность как у страницы ----

test("логотип: знак Lotwise в шапке — самодостаточный инлайн-SVG (viewBox, без внешних ссылок и скриптов)", () => {
  const html = renderPage();
  const m = html.match(/<svg class="brand-mark"[\s\S]*?<\/svg>/);
  assert.ok(m, "инлайн-знак с классом brand-mark присутствует");
  const svg = m[0];
  assert.ok(svg.includes("viewBox="), "viewBox обязателен");
  assert.ok(!/\b(src|href)\s*=/i.test(svg), "никаких src/href — знак ничем не ссылается наружу");
  assert.ok(!/<script/i.test(svg) && !/javascript:/i.test(svg), "без скриптов");
  assert.ok(!/url\(/i.test(svg), "без url() — никаких внешних подгрузок");
  // Раунд 18: знак переведён на монограмму «L» (та же геометрия, что фавиконка и
  // README): ствол-ось + акцентная нога + точка-событие; 2 rect вместо стека полос
  assert.equal((svg.match(/<rect\b/g) || []).length, 2, "монограмма L: ствол и акцентная нога");
  assert.ok(/<circle/.test(svg), "точка-событие на стволе");
  assert.ok(svg.includes("accent"), "нога-лот помечена акцентным классом");
  assert.ok(html.indexOf("brand-mark") < html.indexOf("<h1"), "знак стоит в шапке, перед заголовком");
});

// ---- раунд 8: дивидендные вердикты кросс-чека в таймлайне токена ----
// /crosscheck отдаёт вердикты блоками (контракт src/events/crosscheck.mjs): сначала все
// MULTIPLIER_CHANGE в порядке событий, затем DIVIDEND_ACCRUAL с type-меткой в хвосте.
// Бейдж дивиденда — своя подпись «dividend: …» (отличима от ребейзной «price: …»),
// цвета — тот же набор классов по verdict; доли падения — компактно в тултипе.

const MULT_EV = {
  effectiveDate: "2026-06-18T04:00:00.000Z", type: "MULTIPLIER_CHANGE",
  multiplierFrom: "1", multiplierTo: "1.0015", reason: "rebase",
};
const DIV_EV = {
  effectiveDate: "2026-06-10T00:00:00.000Z", type: "DIVIDEND_ACCRUAL",
  amountPerUnitRaw: 2_000_000, decimals: 6,
};
const MULT_VERDICT = { effectiveDate: MULT_EV.effectiveDate, verdict: "consistent", note: "n-mult" };
const DIV_VERDICT = {
  type: "DIVIDEND_ACCRUAL", effectiveDate: DIV_EV.effectiveDate, verdict: "consistent",
  expectedDropFraction: 0.02, observedDropFraction: 0.02, note: "n-div",
};

const bootTimeline = (events, verdicts) => runClient((url) => {
  if (url.startsWith("/health")) return { ok: true, status: 200, body: { tokens: 1, events: events.length, journal: null } };
  if (url.startsWith("/summary")) return { ok: true, status: 200, body: [
    { symbol: "ONE", name: "Token One", issuer: "Backed", mint: "A".repeat(32), decimals: 6, events: events.length, currentMultiplier: "1.0015" },
  ] };
  if (url.startsWith("/events?symbol=ONE")) return { ok: true, status: 200, body: events };
  if (url.startsWith("/crosscheck?symbol=ONE")) return { ok: true, status: 200, body: { verdicts, coverage: {} } };
  return undefined;
});

const rowOf = (html, frag) => html.split("<li>").find((s) => s.includes(frag)) ?? "";

test("дивидендный вердикт — dividend-бейдж отдельной строкой, ребейзный price-бейдж рядом, порядок блоков не перепутан", async () => {
  // события в /events идут по датам (дивиденд раньше), вердикты — блоками по контракту:
  // ребейзный первым, дивидендный в хвосте; склейка обязана сойтись по (тип, seq)
  const { els } = bootTimeline([DIV_EV, MULT_EV], [MULT_VERDICT, DIV_VERDICT]);
  await flush(); // бут: /health → /summary → select(ONE) → события + кросс-чек
  const html = els.get("events").innerHTML;
  const divRow = rowOf(html, "dividend accrual");
  const multRow = rowOf(html, "rebase");
  assert.ok(divRow.includes("dividend: consistent"), "дивидендный вердикт рендерится со своей dividend-подписью");
  assert.ok(divRow.includes("verdict ok"), "цвет consistent — тот же класс ok");
  assert.ok(divRow.includes("2.000000 per unit"), "строка дивиденда показывает начисление, а не from → to");
  assert.ok(!divRow.includes("&rarr;"), "дивиденд не смешан с multiplier-событием");
  assert.ok(divRow.includes("expected -2.000% vs observed -2.000%"), "доли падения компактно в тултипе");
  assert.ok(divRow.includes("n-div"), "note вердикта доступен в тултипе");
  assert.ok(multRow.includes("price: consistent"), "ребейзный бейдж не потерял прежнюю подпись");
  assert.ok(multRow.includes("&rarr;"), "ребейз по-прежнему строка from → to");
  assert.ok(html.includes("dividend: consistent") && html.includes("price: consistent"),
    "вердикты обоих типов сосуществуют в одном таймлайне");
});

test("склейка не перепутана: ребейз и дивиденд в один день — каждому свой вердикт (префикс типа в ключе)", async () => {
  const M2 = { ...MULT_EV, effectiveDate: DIV_EV.effectiveDate, multiplierFrom: "1.0015", multiplierTo: "1.002", reason: "second rebase" };
  const V_M1 = { effectiveDate: "2026-06-01T04:00:00.000Z", verdict: "consistent", note: "n1" };
  const V_M2 = { effectiveDate: DIV_EV.effectiveDate, verdict: "mismatch", note: "n2" };
  const V_D = { type: "DIVIDEND_ACCRUAL", effectiveDate: DIV_EV.effectiveDate, verdict: "suspicious", note: "n3" };
  // порядок событий: M1, D, M2 (по датам D и M2 совпадают); вердикты — блоками: [M1, M2, D]
  const { els } = bootTimeline(
    [{ ...MULT_EV, effectiveDate: "2026-06-01T04:00:00.000Z", reason: "first rebase" }, DIV_EV, M2],
    [V_M1, V_M2, V_D],
  );
  await flush();
  const html = els.get("events").innerHTML;
  const first = rowOf(html, "first rebase");
  const second = rowOf(html, "second rebase");
  const div = rowOf(html, "dividend accrual");
  assert.ok(first.includes("price: consistent"), "первый ребейз — свой вердикт");
  assert.ok(second.includes("price: mismatch"), "второй ребейз (индекс 1 блока) — свой вердикт, не дивидендный");
  assert.ok(div.includes("dividend: suspicious"), "дивиденд из хвоста вердиктов — свой бейдж");
  assert.ok(!second.includes("dividend:"), "дивидендный вердикт не прилип к ребейзу в тот же день");
  assert.ok(!div.includes("price:"), "ребейзный вердикт не прилип к дивиденду в тот же день");
});

test("дивиденд без ценовой истории — dividend: no data, тултип без «expected null» и без NaN", async () => {
  const NO_DATA = {
    type: "DIVIDEND_ACCRUAL", effectiveDate: DIV_EV.effectiveDate, verdict: "no-price-data",
    expectedDropFraction: null, observedDropFraction: null,
    note: "candles do not reach back to the event date",
  };
  const { els } = bootTimeline([DIV_EV], [NO_DATA]);
  await flush();
  const div = rowOf(els.get("events").innerHTML, "dividend accrual");
  assert.ok(div.includes("dividend: no data"), "no-price-data рендерится с dividend-подписью");
  assert.ok(div.includes("verdict unavailable"), "класс unavailable, как у ребейзного no-price-data");
  assert.ok(!div.includes("expected null") && !div.includes("NaN"), "нечисловые доли в тултип не подставлены");
  assert.ok(div.includes("candles do not reach back"), "причина из note видна в тултипе");
});
