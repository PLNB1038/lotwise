// Adversarial/chaos-тесты HTTP API (src/api/server.mjs): добиваем сервер кривыми
// входами и гонками. Контракт файла — каждый кейс пинит ФАКТИЧЕСКОЕ поведение
// (статус / форма ответа / жив ли процесс), а не желаемое. Если поведение выглядит
// странно, но определено и безопасно — оно пинится с пометкой «находка».
// Таймаут-поведение (медленные внешние источники) сознательно НЕ тестируется:
// в этом файле нет живых источников — все сторабы мгновенные.
//
// Находки, зафиксированные здесь:
//   1. [находка раунда N, исправлено и перепинено] `//events?...` парсился серверным
//      new URL(req.url, base) как ПРОТОКОЛ-ОТНОСИТЕЛЬНАЯ ссылка: authority «events»
//      выбрасывался, pathname становился «/», query терялся — клиент получал 200
//      text/html главной страницы вместо 404/данных. Теперь ведущий «//» отсекается
//      до парсинга: честный 404 JSON, но НЕ главная (пин в группе 2).
//   2. [находка раунда N, исправлено и перепинено] 405 шёл без заголовка Allow (RFC 9110
//      требует Allow в ответе 405) и HEAD получал 405 вместо семантики GET без тела —
//      HEAD-пробы мониторинга отказывали на живых маршрутах. Теперь 405 несёт
//      «Allow: GET, HEAD», HEAD на GET-маршруты — 200 с заголовками GET и пустым
//      телом (пин в группе 2).
//   3. `/%2e%2e/` и `/%2e%2e/health` — WHATWG URL нормализует сегменты «%2e%2e» до запроса
//      к роутеру: traversal сводится к «/» и «/health», за корень не выйти (это хорошо и пинится).
//   4. raw за пределами Number.MAX_SAFE_INTEGER (26 и 10240 цифр) считается ТОЧНО:
//      в scaledQty BigInt-математика, строк тут нет — никакой потери точности.
//   5. date=0000-01-01 принимается строгим парсером (год 0 — валидный канонический ISO
//      проекта): неожиданно, но определено — множитель «1» (до всех событий).
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createApiServer } from "../src/api/server.mjs";
import { multiplierHistoryToEvents, bindMintAndValidate } from "../src/events/normalize-xstocks.mjs";
import { loadRegistry } from "../src/registry/registry.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const SPYx = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const OWNER = "9BB7Tt5uW5QbAorLkF3Hn1P2mGcXvcDdR7y8LbT9KdUu"; // валидный base58, как в round6-тестах

const historyNodes = JSON.parse(readFileSync(path.join(dir, "xstocks-spyx-history-eth.json"), "utf8")).nodes;
const events = bindMintAndValidate(multiplierHistoryToEvents(historyNodes, { symbol: "SPYx" }), SPYx);

// Множитель SPYx на 2026-07-01: "1.005714560286254" → точная дробь (независимо от движка:
// числа захардкожены, чтобы тест не доверял тем же функциям, что проверяет).
const NUM = 1005714560286254n;
const DEN = 10n ** 15n;

// Сервер с мгновенными сторабами внешних источников (живых источников в chaos-файле нет).
// walletScanner/onchainReader при подстановке считают свои вызовы — это часть пинов.
function makeStubs() {
  const stubs = {
    calls: { wallet: 0, onchain: 0 },
    walletScanner: async () => {
      stubs.calls.wallet += 1;
      return { owner: OWNER, signatures: 0, fetched: 0, skipped: [], truncated: false, accounts: new Map(), txs: [] };
    },
    onchainReader: async () => {
      stubs.calls.onchain += 1;
      return {
        activeMultiplier: "1.003909240011759",
        pendingMultiplier: "1.005714560286254",
        pendingEffectiveDate: "2026-06-18T00:00:00.000Z",
        hasExtension: true,
      };
    },
  };
  return stubs;
}

async function withServer(fn, optsFn = null) {
  const registry = await loadRegistry("data/tokens.json");
  const stubs = makeStubs();
  const opts = typeof optsFn === "function" ? optsFn(stubs) : {};
  const server = await createApiServer({ registry, events, ...opts });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`, stubs);
  } finally {
    server.close();
  }
}

// Сервер жив и отвечает контрактом /health — вызывается после каждой враждебной группы.
async function assertAlive(base) {
  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200, "сервер жив после шторма");
  assert.equal((await r.json()).ok, true);
}

// Сырой сокет для кейсов, которые fetch не отправит (кривой request-target, нет Host).
// Читает статусную строку + заголовки (+ тело по Content-Length), затем рвёт соединение.
function rawRequest(port, payload) {
  return new Promise((resolve) => {
    const chunks = [];
    const s = net.connect(port, "127.0.0.1", () => s.write(payload));
    const finish = () => {
      s.destroy();
      resolve(Buffer.concat(chunks).toString("latin1"));
    };
    s.on("data", (d) => {
      chunks.push(d);
      const buf = Buffer.concat(chunks);
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd !== -1) {
        const m = /content-length: (\d+)/i.exec(buf.toString("latin1"));
        const need = headerEnd + 4 + (m ? Number(m[1]) : 0);
        if (buf.length >= need) return finish();
      }
    });
    s.on("error", (e) => resolve(`ERR ${e.code}`));
    setTimeout(finish, 3000).unref();
  });
}

// ---- группа 1: кривые query — symbol ----

test("symbol с пробелами/юникодом/нуль-байтом — 400 «не трекается», без падения", async () => {
  await withServer(async (base) => {
    // все варианты — НЕ точное совпадение символа реестра → конвенция эндпоинтов: 400
    const junk = ["%20", "SPYx%20", "%20SPYx", "%00", "SPYx%00", "%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82%F0%9F%94%A5", "SPY+x"];
    for (const s of junk) {
      assert.equal((await fetch(`${base}/events?symbol=${s}`)).status, 400, `/events symbol=${s}`);
      assert.equal((await fetch(`${base}/multiplier?symbol=${s}&raw=1000`)).status, 400, `/multiplier symbol=${s}`);
      assert.equal((await fetch(`${base}/onchain?symbol=${s}`)).status, 400, `/onchain symbol=${s}`);
    }
    // поиск идёт ПО декодированному значению: «%78» — это «x», канонизация до lookup —
    // обойти реестр процент-кодированием нельзя (и сломать lookup — тоже): честный 200
    const r = await fetch(`${base}/events?symbol=SPY%78`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).length, 4);
    await assertAlive(base);
  });
});

test("10KB-строка как symbol — 400, соединение и сервер живы", async () => {
  await withServer(async (base) => {
    // 10240 символов: request-line ~10.3KB — под дефолтным капом заголовков node (16KB),
    // так что добираемся до роутера: реестр не содержит такой символ → 400
    const res = await fetch(`${base}/events?symbol=${"A".repeat(10240)}`);
    assert.equal(res.status, 400);
    await assertAlive(base);
  });
});

// ---- группа 1: кривые query — raw ----

test("raw: 0 валиден (точный ноль), нотации/пробелы/нуль-байт/пустое — 400", async () => {
  await withServer(async (base) => {
    // «0» — валидные ноль базовых единиц: exact ноль, а не ошибка
    const r0 = await fetch(`${base}/multiplier?symbol=SPYx&raw=0&date=2026-07-01`);
    assert.equal(r0.status, 200);
    const j0 = await r0.json();
    assert.equal(j0.sampleScaledQty.exact, true);
    assert.equal(j0.sampleScaledQty.whole, "0");
    // существующие тесты пинят 0x10/-5/abc/1.5; здесь классы, которых там нет:
    for (const raw of ["1e10", "+5", "%205", "5%00", "5.0", ""]) {
      assert.equal(
        (await fetch(`${base}/multiplier?symbol=SPYx&raw=${raw}&date=2026-07-01`)).status,
        400,
        `raw=${JSON.stringify(decodeURIComponent(raw))}`,
      );
    }
    await assertAlive(base);
  });
});

test("raw за Number.MAX_SAFE_INTEGER — точная BigInt-математика, потеря точности не наступает", async () => {
  await withServer(async (base) => {
    // 26 девяток (~1e26, в 10 миллиардов раз больше MAX_SAFE_INTEGER ≈ 9e15):
    // движок считает в BigInt (scaledQty) — ответ обязан совпасть с точным ожиданием
    const raw26 = "9".repeat(26);
    const r = await fetch(`${base}/multiplier?symbol=SPYx&raw=${raw26}&date=2026-07-01`);
    assert.equal(r.status, 200);
    const j = await r.json();
    const expected = (BigInt(raw26) * NUM) / DEN;
    assert.equal(j.sampleScaledQty.whole, expected.toString()); // 99999999999999999999999999 × 1.0057… без округления float
    assert.equal(j.sampleScaledQty.den, DEN.toString());

    // 10240 цифр: и точность, и отсутствие зависания на умножении больших чисел
    const rawBig = "9".repeat(10240);
    const rb = await fetch(`${base}/multiplier?symbol=SPYx&raw=${rawBig}&date=2026-07-01`);
    assert.equal(rb.status, 200);
    const jb = await rb.json();
    assert.equal(jb.sampleScaledQty.whole, ((BigInt(rawBig) * NUM) / DEN).toString());
    assert.ok(jb.sampleScaledQty.whole.length > 10000); // ~10241 цифра — не свернулся в экспоненту/NaN
    await assertAlive(base);
  });
});

// ---- группа 1: кривые query — date ----

test("битые даты (перекаты, 24:00, 23:59:60, оффсет +99:99, нуль-байт, пустая) — 400, ридер не дёрган", async () => {
  await withServer(async (base, stubs) => {
    // существующие тесты пинят garbage/2026-1-1/наивное время/2026-13-01; здесь остальные
    // классы мусора, включая перекаты, которые Date.parse «перекатывал» молча
    const bad = [
      "2026-02-30", // перекат на 2 марта
      "2026-06-31", // перекат на 1 июля
      "2027-02-29", // не високосный
      "2026-06-18T24:00:00Z", // 24:00 — не время
      "2026-06-18T23:59:60Z", // високосная секунда
      "2026-06-18T12:00:00+99:99", // оффсет вне диапазона
      "2026-07-01%00", // нуль-байт после валидной формы
      "", // пустая — НЕ дефолт «сейчас», а честный 400
      "%F0%9F%94%A5", // эмодзи
    ];
    for (const d of bad) {
      assert.equal(
        (await fetch(`${base}/multiplier?symbol=SPYx&raw=1000&date=${d}`)).status,
        400,
        `date=${JSON.stringify(decodeURIComponent(d))}`,
      );
      assert.equal(
        (await fetch(`${base}/onchain?symbol=SPYx&date=${d}`)).status,
        400,
        `/onchain date=${JSON.stringify(decodeURIComponent(d))}`,
      );
    }
    assert.equal(stubs.calls.onchain, 0); // мусор не греет кэш реальными вызовами
    await assertAlive(base);
  });
});

test("граничные валидные даты не отвергаются: високос 2024-02-29, оффсет -05:00, год 0000", async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/multiplier?symbol=SPYx&raw=1000&date=2024-02-29`)).status, 200);
    assert.equal((await fetch(`${base}/multiplier?symbol=SPYx&raw=1000&date=2026-06-18T12:00:00-05:00`)).status, 200);
    // находка: год 0 — валидный канонический ISO проекта (setUTCFullYear(0)); определено,
    // пусть и неожиданно: множитель «1» — до всех событий 2026 года
    const r = await fetch(`${base}/multiplier?symbol=SPYx&date=0000-01-01`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.multiplier, "1");
    assert.equal(j.date, "0000-01-01"); // ответ эхом отдаёт введённую дату как есть
    await assertAlive(base);
  });
});

// ---- группа 1: дубли и пустые значения ----

test("дубли параметров: URLSearchParams.get берёт ПЕРВОЕ вхождение", async () => {
  await withServer(async (base) => {
    // symbol: первый мусор, второй валидный → мусор побеждает → 400 (и наоборот → 200)
    assert.equal((await fetch(`${base}/events?symbol=NOPE&symbol=SPYx`)).status, 400);
    const ok = await fetch(`${base}/events?symbol=SPYx&symbol=NOPE`);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).length, 4);
    // raw: первый битый → 400, первый валидный → 200 (второй молча игнорируется — находка:
    // «raw=abc&raw=1000» не ошибка парсинга, а отказ по первому; двойного ключа нет)
    assert.equal((await fetch(`${base}/multiplier?symbol=SPYx&raw=abc&raw=1000`)).status, 400);
    assert.equal((await fetch(`${base}/multiplier?symbol=SPYx&raw=1000&raw=abc`)).status, 200);
    // date: то же первое вхождение
    assert.equal((await fetch(`${base}/multiplier?symbol=SPYx&date=2026-07-01&date=zzz`)).status, 200);
    assert.equal((await fetch(`${base}/multiplier?symbol=SPYx&date=zzz&date=2026-07-01`)).status, 400);
    await assertAlive(base);
  });
});

test("пустые значения query и кривые адреса /lots — честные 400", async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/events?symbol=`)).status, 400);
    const noAddr = await fetch(`${base}/lots?address=`);
    assert.equal(noAddr.status, 400);
    assert.match((await noAddr.json()).error, /address required/);
    // адресная валидация base58: пробел, 45 символов, не-base58 алфавит (O/0/I/l), юникод
    for (const a of ["%20", `${OWNER}x`, "O".concat("0".repeat(43)), "%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82", "0".repeat(44)]) {
      assert.equal((await fetch(`${base}/lots?address=${a}`)).status, 400, `address=${decodeURIComponent(a).slice(0, 10)}…`);
    }
    await assertAlive(base);
  });
});

test("/lots с валидным адресом и пустым сканом — 200 с пустым отчётом, сканер вызван ровно раз", async () => {
  await withServer(
    async (base, stubs) => {
      const r = await fetch(`${base}/lots?address=${OWNER}`);
      assert.equal(r.status, 200);
      const j = await r.json();
      assert.deepEqual(j.tokens, []);
      assert.equal(stubs.calls.wallet, 1);
      await assertAlive(base);
    },
    (stubs) => ({ walletScanner: stubs.walletScanner }),
  );
});

// ---- группа 2: методы и протокол ----

test("методы ≠ GET — 405 с заголовком Allow (RFC 9110); HEAD — семантика GET без тела", async () => {
  await withServer(async (base) => {
    // было находкой (Allow отсутствовал) — теперь 405 обязан его нести: клиент видит,
    // какие методы допустимы, не перебирая их вслепую
    for (const method of ["OPTIONS", "POST", "PUT", "PATCH", "DELETE"]) {
      const r = await fetch(`${base}/health`, { method });
      assert.equal(r.status, 405, method);
      const j = await r.json();
      assert.match(j.error, /method not allowed/);
      assert.equal(r.headers.get("allow"), "GET, HEAD", `${method}: 405 без Allow — нарушение RFC 9110`);
    }
    // HEAD на GET-маршруты больше не 405: статус и заголовки как у GET, тела нет
    // (node отбрасывает body у HEAD сам, Content-Length остаётся от GET-выдачи)
    const h = await fetch(`${base}/health`, { method: "HEAD" });
    assert.equal(h.status, 200);
    assert.match(h.headers.get("content-type"), /application\/json/);
    assert.ok(Number(h.headers.get("content-length")) > 0, "Content-Length как у GET");
    assert.equal((await h.text()).length, 0, "HEAD: тела нет");
    const page = await fetch(`${base}/`, { method: "HEAD" });
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    assert.equal((await page.text()).length, 0, "HEAD на «/»: тела нет");
    // 404 под HEAD тоже жив: статус честный, тела нет
    const nf = await fetch(`${base}/nope`, { method: "HEAD" });
    assert.equal(nf.status, 404);
    assert.equal((await nf.text()).length, 0);
    await assertAlive(base);
  });
});

test("/health с query-мусором — 200 ok:true (query игнорируется); не-ASCII путь — 404 JSON", async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/health?junk=1&x=%00&symbol=${"A".repeat(2048)}`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, true);
    const nf = await fetch(`${base}/${encodeURIComponent("привет🔥")}`);
    assert.equal(nf.status, 404);
    const nfBody = await nf.json();
    assert.match(nfBody.error, /not found/);
    assert.ok(Array.isArray(nfBody.endpoints)); // форма 404 не деградировала
    await assertAlive(base);
  });
});

test("//double//slash — протокол-относительный request-target: честный 404, НЕ главная (перепинено)", async () => {
  await withServer(async (base) => {
    // было: new URL("//events?symbol=SPYx", base) видел authority «events», pathname «/»,
    // query терялся — клиент получал 200 text/html главной страницы. Стало: ведущий «//»
    // отсекается ДО парсинга — это чужой authority (не наш хост), честный 404 JSON.
    // Молча отдавать «/» — слепота маршрутизации; канонизировать в «/events» —
    // поощрение кривых request-target, поэтому пиним именно 404.
    const r = await fetch(`${base}//events?symbol=SPYx`);
    assert.equal(r.status, 404);
    assert.match(r.headers.get("content-type"), /application\/json/);
    const body = await r.json();
    assert.match(body.error, /not found/);
    assert.ok(Array.isArray(body.endpoints)); // форма 404 не деградировала
    // query в «//x»-форме не прощается ни для какого маршрута
    const r2 = await fetch(`${base}//multiplier?symbol=SPYx&raw=1000`);
    assert.equal(r2.status, 404);
    assert.match(r2.headers.get("content-type"), /application\/json/);
    // обычные слэши ВНУТРИ пути не тронуты гвардом: маршрут по-прежнему отвечает
    const nested = await fetch(`${base}/health`);
    assert.equal(nested.status, 200);
    await assertAlive(base);
  });
});

test("/%2e%2e/ — WHATWG-нормализация до роутера: traversal не выходит за корень", async () => {
  await withServer(async (base) => {
    // «%2e%2e» = «..» для WHATWG URL: «/%2e%2e/» → «/» (страница), «/%2e%2e/health» → «/health».
    // Обхода на другой хост/путь нет — пиним нормализацию как защиту.
    const root = await fetch(`${base}/%2e%2e/`);
    assert.equal(root.status, 200);
    assert.match(root.headers.get("content-type"), /text\/html/);
    const h = await fetch(`${base}/%2e%2e/health`);
    assert.equal(h.status, 200);
    assert.equal((await h.json()).ok, true);
    // «/../health» нормализует уже undici на клиенте — сервер видит «/health»
    const dotdot = await fetch(`${base}/../health`);
    assert.equal(dotdot.status, 200);
    assert.equal((await dotdot.json()).ok, true);
    await assertAlive(base);
  });
});

test("raw socket: request-target «http://:80/» — 400 malformed target, процесс жив (краш-вектор из прошлого)", async () => {
  await withServer(async (base) => {
    const { port } = new URL(base);
    // fetch такой request-target не отправит — только сырой сокет. Ловля в server.mjs
    // (ERR_INVALID_URL) раньше отсутствовала и роняла процесс одним запросом.
    const buf = await rawRequest(Number(port), "GET http://:80/ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    assert.match(buf, /^HTTP\/1\.1 400/);
    assert.match(buf, /malformed request target/); // это наш handler-400, не парсер node
    // HTTP/1.1 без обязательного Host — 400 от самого парсера node, соединение закрывается
    const noHost = await rawRequest(Number(port), "GET /health HTTP/1.1\r\n\r\n");
    assert.match(noHost, /^HTTP\/1\.1 400/);
    assert.match(noHost, /Connection: close/i);
    await assertAlive(base);
  });
});

// ---- группа 3: конкурентность ----

test("50 одновременных запросов по смешанным маршрутам — все отвечают ожидаемо, сервер жив после шторма", async () => {
  await withServer(
    async (base) => {
      const plan = [
        ["/health", 200],
        ["/summary", 200],
        ["/tokens?issuer=tessera", 200],
        [`/events?symbol=SPYx`, 200],
        [`/events?symbol=SPYx&type=NOPE`, 200],
        [`/events`, 400],
        [`/multiplier?symbol=SPYx&raw=100000000&date=2026-07-01`, 200],
        [`/multiplier?symbol=SPYx&raw=abc`, 400],
        [`/multiplier?symbol=NOPE&raw=1`, 400],
        [`/onchain?symbol=SPYx&date=2026-06-18`, 200],
        [`/onchain?symbol=SPYx&date=2026-02-30`, 400],
        [`/lots?address=${OWNER}`, 200],
        [`/lots?address=${"0".repeat(44)}`, 400],
        ["/nope", 404],
        ["/", 200],
      ];
      const shots = [];
      for (let i = 0; i < 50; i++) {
        const [url, expect] = plan[i % plan.length];
        shots.push({ url, expect });
      }
      const results = await Promise.all(
        shots.map(async ({ url, expect }) => {
          const r = await fetch(`${base}${url}`);
          return { url, expect, status: r.status };
        }),
      );
      for (const { url, expect, status } of results) {
        assert.equal(status, expect, `${url} → ${status}, ожидалось ${expect}`);
      }
      await assertAlive(base); // после шторма сервер жив и отвечает контрактом
    },
    (stubs) => ({ walletScanner: stubs.walletScanner, onchainReader: stubs.onchainReader }),
  );
});

test("два одновременных запроса к одному ресурсу: первый рендер «/» и /multiplier — ответы идентичны, гонки кэша нет", async () => {
  await withServer(async (base) => {
    // оба приходят ДО первого рендера: pageHtml ??= renderPage() синхронен, окна гонки нет —
    // пиним отсутствие «stampede» (двойного рендера/расхождения тел)
    const [a, b] = await Promise.all([fetch(`${base}/`), fetch(`${base}/`)]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(await a.text(), await b.text());
    // то же для кэшируемого вычисления — два параллельных /multiplier идентичны
    const url = `${base}/multiplier?symbol=SPYx&raw=100000000&date=2026-07-01`;
    const [m1, m2] = await Promise.all([fetch(url), fetch(url)]);
    assert.equal(m1.status, 200);
    assert.equal(m2.status, 200);
    assert.deepEqual(await m1.json(), await m2.json());
    await assertAlive(base);
  });
});
