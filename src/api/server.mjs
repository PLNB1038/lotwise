// REST API Lotwise: только stdlib (node:http), без зависимостей.
// Витрина данных MVP: реестр, события, множитель на дату.
import { createServer } from "node:http";
import { MultiplierTimeline } from "../lots/timeline.mjs";

export function createApiServer({ registry, events = [], port = 0, host = "127.0.0.1" }) {
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

  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const q = url.searchParams;

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
    return json(res, 404, { error: "not found", endpoints: ["/health", "/tokens", "/events", "/multiplier"] });
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => resolve(server));
  });
}
