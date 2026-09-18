// Разовое обогащение data/tokens.json: decimals из Jupiter Price API v3 (батчем).
// Запуск из корня: node scripts/enrich-decimals.mjs
import { readFileSync, writeFileSync } from "node:fs";

const list = JSON.parse(readFileSync("data/tokens.json", "utf8"));
const ids = list.map((t) => t.mint).join(",");
const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${ids}`, {
  headers: { "User-Agent": "Mozilla/5.0 (compatible; Lotwise/0.1)" },
});
if (!res.ok) {
  console.error(`Jupiter HTTP ${res.status}`);
  process.exit(1);
}
const prices = await res.json();

let filled = 0, unknown = [];
for (const t of list) {
  const p = prices[t.mint];
  if (p?.decimals !== undefined && t.decimals === null) {
    t.decimals = p.decimals;
    t.sourceDecimals = "jupiter";
    filled++;
  }
  if (!p) unknown.push(t.symbol);
}
writeFileSync("data/tokens.json", JSON.stringify(list, null, 1) + "\n");
console.log(`decimals заполнено: ${filled}/${list.filter((t) => t.decimals !== null).length} всего`);
console.log(unknown.length ? `НЕ найдены в Jupiter: ${unknown.join(", ")}` : "все минты известны Jupiter");
