// REST API Lotwise: только stdlib (node:http), без зависимостей.
// Витрина данных MVP: реестр, события, множитель на дату + витрина-страница.
import { createServer } from "node:http";
import { MultiplierTimeline } from "../lots/timeline.mjs";
import { reconcileMultiplier } from "../issuer/scaled-ui.mjs";
import { renderPage } from "../ui/page.mjs";

export function createApiServer({ registry, events = [], port = 0, host = "127.0.0.1", onchainReader = null }) {
  // индексы собираются один раз; при изменении данных сервер пересоздаётся (MVP)
  const byMint = new Map(registry.map((t) => [t.mint, t]));
  const bySymbol = new Map(registry.map((t) => [t.symbol, t]));
  const eventsByMint = new Map();
  for (const e of events) {
    if (!eventsByMint.has(e.mint)) eventsByMint.set(e.mint, []);
    eventsByMint.get(e.mint).push(e);
  }
  const timelines = new Map();
  for (const [mint, evts] of eventsByMint) {
    const mult = evts.filter((e) => e.type === "MULTIPLIER_CHANGE");
    if (mult.length > 0) timelines.set(mint, new MultiplierTimeline(mult));
  }

  const json = (res, status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
    res.end(payload);
  };

  const resolveMint = (q) => q.get("mint") ?? bySymbol.get(q.get("symbol"))?.mint ?? null;
  let pageHtml = null; // рендерим один раз, страница статична (данные тянет с API)

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const q = url.searchParams;

    if (url.pathname === "/" && req.method === "GET") {
      pageHtml ??= renderPage();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(pageHtml) });
      return res.end(pageHtml);
    }
    if (url.pathname === "/summary") {
      const now = new Date().toISOString();
      const rows = registry
        .map((t) => ({
          symbol: t.symbol,
          name: t.name,
          issuer: t.issuer,
          mint: t.mint,
          decimals: t.decimals,
          events: (eventsByMint.get(t.mint) ?? []).length,
          currentMultiplier: timelines.get(t.mint)?.multiplierAt(now) ?? "1",
        }))
        .sort((a, b) => b.events - a.events || a.symbol.localeCompare(b.symbol));
      return json(res, 200, rows);
    }
    if (url.pathname === "/onchain") {
      const mint = resolveMint(q);
      if (!mint) return json(res, 400, { error: "mint or symbol required" });
      if (!onchainReader) return json(res, 503, { error: "on-chain reader not configured" });
      let parsed;
      try {
        parsed = await onchainReader(mint);
      } catch (err) {
        // источник недоступен — fail-closed: отдаём статус, витрина показывает честную заглушку
        return json(res, 503, { error: err.message, kind: err.kind ?? null });
      }
      const date = q.get("date") ?? new Date().toISOString();
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
    if (url.pathname === "/health") return json(res, 200, { ok: true, tokens: registry.length, events: events.length });
    if (url.pathname === "/tokens") {
      const issuer = q.get("issuer");
      return json(res, 200, issuer ? registry.filter((t) => t.issuer === issuer) : registry);
    }
    if (url.pathname === "/events") {
      const mint = resolveMint(q);
      if (!mint) return json(res, 400, { error: "mint or symbol required" });
      const list = eventsByMint.get(mint) ?? [];
      const type = q.get("type");
      return json(res, 200, type ? list.filter((e) => e.type === type) : list);
    }
    if (url.pathname === "/multiplier") {
      const mint = resolveMint(q);
      if (!mint) return json(res, 400, { error: "mint or symbol required" });
      const date = q.get("date") ?? new Date().toISOString();
      const tl = timelines.get(mint);
      if (!tl) return json(res, 200, { mint, date, multiplier: "1", events: 0 }); // событий не было
      try {
        const s = tl.scaledQty(BigInt(q.get("raw") ?? "100000000"), date);
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
    return json(res, 404, { error: "not found", endpoints: ["/", "/health", "/tokens", "/events", "/multiplier", "/summary", "/onchain"] });
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => resolve(server));
  });
}
