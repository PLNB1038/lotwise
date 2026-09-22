// REST API Lotwise: только stdlib (node:http), без зависимостей.
// Витрина данных MVP: реестр, события, множитель на дату + витрина-страница.
import { createServer } from "node:http";
import { MultiplierTimeline } from "../lots/timeline.mjs";
import { applyEvents } from "../lots/lots.mjs";
import { reconcileMultiplier } from "../issuer/scaled-ui.mjs";
import { isValidAddress } from "../wallet/scan.mjs";
import { buildWalletReport } from "../wallet/report.mjs";
import { crossCheckEvents } from "../events/crosscheck.mjs";
import { isValidIsoDate, parseIsoDateMs } from "../schema/isodate.mjs";
import { renderPage } from "../ui/page.mjs";

export function createApiServer({ registry, events = [], port = 0, host = "127.0.0.1", onchainReader = null, walletScanner = null, priceProvider = null, journalStats = null, registryStats = null }) {
  // индексы собираются один раз; при изменении данных сервер пересоздаётся (MVP)
  const byMint = new Map(registry.map((t) => [t.mint, t]));
  const bySymbol = new Map(registry.map((t) => [t.symbol, t]));
  const eventsByMint = new Map();
  for (const e of events) {
    if (!eventsByMint.has(e.mint)) eventsByMint.set(e.mint, []);
    eventsByMint.get(e.mint).push(e);
  }
  const timelines = new Map();
  const excludedByMint = new Map(); // mint → причина исключения (TimelineError)
  for (const [mint, evts] of eventsByMint) {
    const mult = evts.filter((e) => e.type === "MULTIPLIER_CHANGE");
    if (mult.length === 0) continue;
    try {
      timelines.set(mint, new MultiplierTimeline(mult));
    } catch (err) {
      // Кривая цепочка одного минта (например, история не от "1") не должна валить сервер:
      // TimelineError при построении раньше убивал процесс на старте, а запись с ядом
      // персистилась в журнале → вечный boot-loop. Честная деградация: токен исключается
      // из витрины ЦЕЛИКОМ — выдача событий без таймлайна молча показывала множитель 1.
      // Причина запоминается: /summary, /lots и /health помечают исключённые токены —
      // голая «1» без пометки неотличима от честного «событий не было».
      console.warn(`[api] токен ${byMint.get(mint)?.symbol ?? mint} исключён из витрины: ${err.message}`);
      eventsByMint.delete(mint);
      excludedByMint.set(mint, err.message);
    }
  }

  // Гейт дат query — тот же строгий парсер, что ниже по стеку (schema/isodate.mjs).
  // Раньше здесь были форма-регекс + Date.parse, но Date.parse("2026-02-30") НЕ даёт NaN —
  // он перекатывает на 2026-03-02: мусорная дата проходила гейт, шла реальным RPC-вызовом
  // в ридер /onchain (грела кэш), а затем бросала TimelineError в multiplierAt → 500
  // вместо 400. Строгий парсер отвергает перекаты и наивные времена ДО любого I/O.
  const validQueryDate = isValidIsoDate;

  const json = (res, status, body, extra = {}) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), ...extra });
    res.end(payload);
  };

  // Список маршрутов для честного 404: одна константа, два потребителя (гвард «//x»
  // ниже и финальный 404 роутера) — иначе списки разъезжаются при следующем маршруте.
  const ENDPOINTS = ["/", "/health", "/tokens", "/events", "/multiplier", "/summary", "/onchain", "/lots", "/accruals", "/crosscheck"];

  // Резолв только внутри реестра: неизвестный mint/symbol — 400, а не «пустые данные».
  // До сих пор ?mint=<мусор> проходил насквозь: /events молча отдавал [], /multiplier — "1",
  // /onchain гонял реальные RPC-запросы с произвольными ключами мимо кэша.
  const resolveMint = (q) =>
    byMint.get(q.get("mint") ?? "")?.mint ?? bySymbol.get(q.get("symbol") ?? "")?.mint ?? null;
  let pageHtml = null; // рендерим один раз, страница статична (данные тянет с API)

  const server = createServer(async (req, res) => {
    try {
      let url;
      // request-target с ведущим «//» — протокол-относительная форма: new URL съедает
      // следующий сегмент как authority («//events?x» → host «events», pathname «/»,
      // query выброшен), и маршрутизация молча отдавала ГЛАВНУЮ страницу вместо
      // 404/данных (находка chaos-раунда). Отсекаем до парсинга: чужой authority нам
      // не принадлежит, а канонизация «//events» в «/events» поощряла бы кривые
      // request-target — честный 404, не «догадка за клиента».
      if (req.url.startsWith("//")) {
        return json(res, 404, { error: "not found", endpoints: ENDPOINTS });
      }
      try {
        url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
      } catch {
        // краш-вектор, пойманный живьём: request-target вроде "http://:80/" бросает
        // ERR_INVALID_URL и без ловли убивал процесс одним запросом
        return json(res, 400, { error: "malformed request target" });
      }
      // HEAD — семантика GET с пустым телом (RFC 9110 §9.3.2): тело отбрасывает сам
      // node (_hasBody=false для HEAD), заголовки уходят ровно как у GET — включая
      // Content-Length от GET-выдачи. Раньше HEAD получал 405: HEAD-пробы мониторинга
      // отказывались на живых маршрутах. Остальные методы — 405, и по RFC 9110
      // §15.5.5 он ОБЯЗАН нести Allow (раньше не нёс — та же chaos-находка).
      const isHead = req.method === "HEAD";
      if (req.method !== "GET" && !isHead) {
        return json(res, 405, { error: "method not allowed" }, { Allow: "GET, HEAD" });
      }
      const q = url.searchParams;

    if (url.pathname === "/") {
      pageHtml ??= renderPage();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(pageHtml) });
      return res.end(pageHtml);
    }
    if (url.pathname === "/summary") {
      const now = new Date().toISOString();
      const rows = registry
        .map((t) => {
          const reason = excludedByMint.get(t.mint);
          return {
            symbol: t.symbol,
            name: t.name,
            issuer: t.issuer,
            mint: t.mint,
            decimals: t.decimals,
            events: (eventsByMint.get(t.mint) ?? []).length,
            currentMultiplier: timelines.get(t.mint)?.multiplierAt(now) ?? "1",
            // аддитивно: исключённый из витрины токен помечен — «1» без пометки
            // выглядела вычисленной, хотя таймлайна у токена нет
            ...(reason ? { excluded: true, excludedReason: reason } : {}),
          };
        })
        .sort((a, b) => b.events - a.events || a.symbol.localeCompare(b.symbol));
      return json(res, 200, rows);
    }
    if (url.pathname === "/onchain") {
      const mint = resolveMint(q);
      if (!mint) return json(res, 400, { error: "mint or symbol required (must be a tracked token)" });
      const date = q.get("date") ?? new Date().toISOString();
      // дата валидируется ДО ридера: мусорная дата не должна греть кэш реальным RPC
      // и давать 503 вместо 400 при бросающем ридере
      if (!validQueryDate(date)) return json(res, 400, { error: "date must be ISO-8601 (YYYY-MM-DD, or with time + timezone)" });
      if (!onchainReader) return json(res, 503, { error: "on-chain reader not configured" });
      let parsed;
      try {
        parsed = await onchainReader(mint);
      } catch (err) {
        // источник недоступен — fail-closed: отдаём статус, витрина показывает честную заглушку
        return json(res, 503, { error: err.message, kind: err.kind ?? null });
      }
      const api = timelines.get(mint)?.multiplierAt(date) ?? "1";
      const rec = reconcileMultiplier(api, parsed, date);
      return json(res, 200, {
        mint,
        symbol: byMint.get(mint)?.symbol ?? null,
        date,
        api: rec.api,
        onChain: {
          active: parsed.activeMultiplier,
          pending: parsed.pendingMultiplier,
          pendingEffectiveDate: parsed.pendingEffectiveDate,
          hasExtension: parsed.hasExtension,
        },
        onChainEffective: rec.onChainEffective,
        verdict: rec.verdict,
      });
    }
    if (url.pathname === "/lots") {
      const address = q.get("address");
      if (!address) return json(res, 400, { error: "address required" });
      if (!isValidAddress(address)) return json(res, 400, { error: "address must be a base58 Solana pubkey" });
      if (!walletScanner) return json(res, 503, { error: "wallet scanner not configured" });
      let scan;
      try {
        scan = await walletScanner(address);
      } catch (err) {
        return json(res, 503, { error: err.message, kind: err.kind ?? null });
      }
      // отчёт собираем в сервере: тут живут таймлайны множителей
      const report = buildWalletReport(scan, { registry, timelines, now: new Date().toISOString() });
      // токены, чей таймлайн кривой: множитель в отчёте дефолтная «1» — помечаем честно
      for (const tk of report.tokens) {
        const reason = excludedByMint.get(tk.mint);
        if (reason) {
          tk.excluded = true;
          tk.excludedReason = reason;
          // контракт витрины: adjustedAvailable === false (вместе с excluded) → строка
          // «adjusted — not computed»; иначе тождественный fallback (scaled=raw) выглядел
          // бы посчитанным adjusted. rawBalance/netDeltaRaw не трогаем — сырое как сырое.
          tk.adjustedAvailable = false;
        }
      }
      return json(res, 200, report);
    }
    if (url.pathname === "/accruals") {
      // Движок начислений applyEvents подключён точечно: дивиденды ОДНОГО токена для
      // ОДНОГО кошелька. Отдельный эндпоинт, а не поле в /lots: отчёт /lots —
      // общекошелечный (symbol в его контракте нет), а его wire-форма пинится тестами
      // (dividend-e2e GAP 2: строки «accrual» в /lots быть не должно).
      const mint = resolveMint(q);
      if (!mint) return json(res, 400, { error: "mint or symbol required (must be a tracked token)" });
      // Исключённый токен (кривой таймлайн): события скрыты ЦЕЛИКОМ, тихий [] был бы
      // неотличим от «дивидендов не было» — тот же честный отказ, что у /events.
      const excludedReason = excludedByMint.get(mint);
      if (excludedReason) {
        return json(res, 400, {
          error: `token excluded from multiplier reporting: ${excludedReason}`,
          excluded: true,
          excludedReason,
        });
      }
      const address = q.get("address");
      if (!address) return json(res, 400, { error: "address required" });
      if (!isValidAddress(address)) return json(res, 400, { error: "address must be a base58 Solana pubkey" });
      if (!walletScanner) return json(res, 503, { error: "wallet scanner not configured" });
      let scan;
      try {
        scan = await walletScanner(address);
      } catch (err) {
        return json(res, 503, { error: err.message, kind: err.kind ?? null });
      }
      const report = buildWalletReport(scan, { registry, timelines, now: new Date().toISOString() });
      const token = report.tokens.find((t) => t.mint === mint);
      const dividends = (eventsByMint.get(mint) ?? []).filter((e) => e.type === "DIVIDEND_ACCRUAL");
      // нет позиции по токену или нет дивидендных событий — начислений нет: честный []
      if (!token || dividends.length === 0) return json(res, 200, []);
      // Лоты отчёта без движкового контекста (mint/owner/basisRaw в лоте нет — стык
      // задокументирован в round6-report-lots): достраиваем. acquiredDate: null (tx без
      // blockTime — легитимная реальность Solana) ЯДОВИТ для applyEvents: движок бросает
      // LotError «refusing to guess» и атомарностью роняет применение ВСЕЙ истории
      // (контракт в шапке report.mjs). Такие лоты исключаем ДО движка: дата покупки
      // неизвестна — угадывать «до или после экс-даты» движок отказывается, и мы не будем.
      const engineLots = token.lots
        .filter((l) => l.acquiredDate !== null && l.acquiredDate !== undefined)
        .map((l) => ({ ...l, mint, owner: report.owner, qtyRaw: BigInt(l.qtyRaw), basisRaw: 0n }));
      let engine;
      try {
        engine = applyEvents(engineLots, dividends);
      } catch (err) {
        // кривое событие из стора не валит сервер: понятная причина вместо generic 500
        return json(res, 500, { error: `accrual engine failed: ${err.message}` });
      }
      const symbol = byMint.get(mint)?.symbol ?? null;
      // lotsConsidered — сколько лотов легло в базу события («строго раньше effectiveDate»,
      // сравнение unix-ms): пара heldBefore в lots.mjs. Движок счётчик не отдаёт (accrual
      // несёт только сумму qty), а витрине важно видеть «за счёт каких лотов». Парс здесь
      // не может дать null: движок уже прогнал те же строки через тот же parseIsoDateMs —
      // мусорная дата дошла бы до него LotError'ом выше.
      return json(res, 200, engine.accruals.map((a) => ({
        symbol,
        effectiveDate: a.event.effectiveDate,
        amountPerUnitRaw: String(a.amountPerUnitRaw), // BigInt в JSON не сериализуется — наружу строками
        totalRaw: String(a.totalRaw),
        lotsConsidered: engineLots.filter((l) => parseIsoDateMs(l.acquiredDate) < parseIsoDateMs(a.event.effectiveDate)).length,
      })));
    }
    if (url.pathname === "/crosscheck") {
      const mint = resolveMint(q);
      if (!mint) return json(res, 400, { error: "mint or symbol required (must be a tracked token)" });
      if (!priceProvider) return json(res, 503, { error: "price provider not configured" });
      let pool = null;
      let candles = [];
      try {
        pool = await priceProvider.pool(mint); // null = пула с нашим base нет — все вердикты no-price-data
        if (pool) candles = await priceProvider.candles(pool.address);
      } catch (err) {
        return json(res, 503, { error: err.message, kind: err.kind ?? null });
      }
      const { verdicts, coverage } = crossCheckEvents(eventsByMint.get(mint) ?? [], candles);
      return json(res, 200, { mint, symbol: byMint.get(mint)?.symbol ?? null, pool, coverage, verdicts });
    }
    if (url.pathname === "/health") {
      // journal: сколько событий реплеено из кэша и сколько токенов не прочитано из цепи —
      // «29 событий» без этой строки неотличимо от «RPC лежал на старте».
      // excluded: токены, чей таймлайн кривой и исключён из витрины — «1» у них дефолт,
      // не расчёт; витрина и потребители API обязаны это видеть.
      return json(res, 200, {
        ok: true,
        tokens: registry.length,
        events: events.length,
        journal: journalStats,
        registry: registryStats,
        excluded: [...excludedByMint].map(([mint, reason]) => ({
          mint,
          symbol: byMint.get(mint)?.symbol ?? null,
          reason,
        })),
      });
    }
    if (url.pathname === "/tokens") {
      const issuer = q.get("issuer");
      return json(res, 200, issuer ? registry.filter((t) => t.issuer === issuer) : registry);
    }
    if (url.pathname === "/events") {
      const mint = resolveMint(q);
      if (!mint) return json(res, 400, { error: "mint or symbol required (must be a tracked token)" });
      // У исключённого минта события скрыты ЦЕЛИКОМ (частичная отдача без таймлайна врала
      // бы), но тихий [] неотличим от «событий не было». Честный отказ с причиной — по
      // конвенции ошибок эндпоинта (как у неизвестного symbol — 400 с {error}); поля
      // excluded/excludedReason дублируют причину для программных потребителей.
      const excludedReason = excludedByMint.get(mint);
      if (excludedReason) {
        return json(res, 400, {
          error: `token excluded from multiplier reporting: ${excludedReason}`,
          excluded: true,
          excludedReason,
        });
      }
      const list = eventsByMint.get(mint) ?? [];
      const type = q.get("type");
      return json(res, 200, type ? list.filter((e) => e.type === type) : list);
    }
    if (url.pathname === "/multiplier") {
      const mint = resolveMint(q);
      if (!mint) return json(res, 400, { error: "mint or symbol required (must be a tracked token)" });
      const date = q.get("date") ?? new Date().toISOString();
      // даты и количества — валидный ввод или честный 400: строгий гейт дат (см. выше)
      // отсекает перекаты ("2026-02-30") и наивные времена, а BigInt молча принимает "0x10" (=16)
      const raw = q.get("raw") ?? "100000000";
      if (!/^\d+$/.test(raw)) return json(res, 400, { error: "raw must be a non-negative integer in base units (digits only)" });
      if (!validQueryDate(date)) return json(res, 400, { error: "date must be ISO-8601 (YYYY-MM-DD, or with time + timezone)" });
      const tl = timelines.get(mint);
      if (!tl) {
        // аддитивно, как в /summary: у исключённого минта (TimelineError на старте) «1» —
        // дефолт без таймлайна, не вычисление; без пометки она неотличима от честного
        // «событий не было» — тот же класс «голой 1», который раунд 5 убивал в /summary
        const excludedReason = excludedByMint.get(mint);
        return json(res, 200, {
          mint, date,
          multiplier: "1",
          events: 0, // событий не было
          ...(excludedReason ? { excluded: true, excludedReason } : {}),
        });
      }
      try {
        const s = tl.scaledQty(BigInt(raw), date);
        return json(res, 200, {
          mint, date,
          multiplier: tl.multiplierAt(date),
          // BigInt в JSON не сериализуется — отдаём строками
          sampleScaledQty: {
            exact: s.exact,
            whole: String(s.whole),
            remainder: String(s.remainder),
            den: String(s.den),
          },
          events: tl.steps.length - 1,
        });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    return json(res, 404, { error: "not found", endpoints: ENDPOINTS });
    } catch (err) {
      // страховка: любое необработанное исключение — 500, процесс живёт
      return json(res, 500, { error: "internal error" });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject); // занятый порт и т.п. — reject вместо сырого краша
    server.listen(port, host, () => resolve(server));
  });
}
