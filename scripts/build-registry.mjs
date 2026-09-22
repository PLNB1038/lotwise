// Пересборка data/tokens.json из верифицированного реестра StockBasis.
// Фактические данные (публичные адреса минтов) переносим, код — нет.
// Запуск из корня репо: node scripts/build-registry.mjs
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "../src/fs/atomic.mjs";

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
// Атомарная запись (раунд 6, LW2_tokens_json_write_non_atomic): усечённый tokens.json
// после обрыва записи ронял сервис ЦЕЛИКОМ на старте — tmp+fsync+rename оставляет на
// диске всегда целую версию (старую или новую), пустого окна нет.
atomicWriteJson(DST, tokens);
const byIssuer = tokens.reduce((acc, t) => ((acc[t.issuer] = (acc[t.issuer] ?? 0) + 1), acc), {});
console.log(`tokens.json: ${tokens.length} токенов`, byIssuer);
