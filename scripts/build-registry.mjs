// Пересборка data/tokens.json из верифицированного реестра StockBasis.
// Фактические данные (публичные адреса минтов) переносим, код — нет.
// Запуск из корня репо: node scripts/build-registry.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve("../stocklana-pnl/data/stocks.json");
const DST = path.resolve("data/tokens.json");

const ISSUER_ORDER = ["backed", "backpack", "prestocks", "tessera"];

function issuerOf(mint, symbol) {
  if (symbol.startsWith("T-")) return "tessera";
  if (mint.startsWith("Pre")) return "prestocks";
  if (mint.startsWith("Xs")) return "backed";
  return "backpack"; // Backpack Securities: MSTR/DELL/WEN/DKNG
}

const raw = JSON.parse(readFileSync(SRC, "utf8"));
const tokens = Object.entries(raw).map(([mint, { symbol, name }]) => ({
  mint,
  symbol,
  name,
  issuer: issuerOf(mint, symbol),
  decimals: null, // доберём живым mint-запросом на неделе 1
  sourceUrl: "stockbasis-verified",
  verified: "carried", // минты верифицированы на мейннете в цикле StockBasis (09.2026)
}));

tokens.sort((a, b) =>
  ISSUER_ORDER.indexOf(a.issuer) - ISSUER_ORDER.indexOf(b.issuer) ||
  a.symbol.localeCompare(b.symbol),
);

mkdirSync(path.dirname(DST), { recursive: true });
writeFileSync(DST, JSON.stringify(tokens, null, 1) + "\n");
const byIssuer = tokens.reduce((acc, t) => ((acc[t.issuer] = (acc[t.issuer] ?? 0) + 1), acc), {});
console.log(`tokens.json: ${tokens.length} токенов`, byIssuer);
