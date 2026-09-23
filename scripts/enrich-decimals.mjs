// Разовое обогащение data/tokens.json: decimals из Jupiter Price API v3 (батчем).
// Запуск из корня: node scripts/enrich-decimals.mjs
// Логика в src/registry/enrich.mjs (тестируемость, раунд 6): запись атомарна
// (atomicWriteJson), а при filled=0 файл не перезаписывается вовсе — раньше каждая
// прогулка скрипта повторяла окно обрыва записи без причины.
import { readFileSync } from "node:fs";
import { enrichDecimalsFile } from "../src/registry/enrich.mjs";

const REGISTRY = "data/tokens.json";
const list = JSON.parse(readFileSync(REGISTRY, "utf8"));
const ids = list.map((t) => t.mint).join(",");
const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${ids}`, {
  headers: { "User-Agent": "Mozilla/5.0 (compatible; Lotwise/0.1)" },
});
if (!res.ok) {
  console.error(`Jupiter HTTP ${res.status}`);
  process.exit(1);
}
const prices = await res.json();

// счётчик пустых decimals — ДО обогащения (волна B): после мутации список уже
// полон и каждый повторный прогон врал «0/31»
const missingBefore = list.filter((t) => t.decimals === null || t.decimals === undefined).length;
const { filled, unknown, written } = enrichDecimalsFile(REGISTRY, prices);
if (!written) console.log("filled=0 — data/tokens.json не перезаписан (нечего писать)");
console.log(`decimals заполнено: ${filled}/${missingBefore} без decimals на входе`);
console.log(unknown.length ? `НЕ найдены в Jupiter: ${unknown.join(", ")}` : "все минты известны Jupiter");
