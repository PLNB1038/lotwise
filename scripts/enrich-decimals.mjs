// Разовое обогащение data/tokens.json: decimals из Jupiter Price API v3 (батчем).
// Запуск из корня: node scripts/enrich-decimals.mjs [--registry data/tokens.json] [--api https://lite-api.jup.ag]
// Логика в src/registry/enrich.mjs (тестируемость, раунд 6): запись атомарна
// (atomicWriteJson), а при filled=0 файл не перезаписывается вовсе — раньше каждая
// прогулка скрипта повторяла окно обрыва записи без причины.
// Волна E (E3-3): отказ через process.exitCode — process.exit над живым undici-сокетом
// крашил процесс на win (0xC0000409), ломая контракт кодов выхода для cron-обёрток
// (остаток D2-фикса, который перевёл на exitCode только два соседних CLI).
import { readFileSync } from "node:fs";
import { enrichDecimalsFile } from "../src/registry/enrich.mjs";

const argv = process.argv.slice(2);
const readFlag = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`--${name} requires a value`);
    process.exitCode = 2;
    return null;
  }
  return value;
};
const REGISTRY = readFlag("registry") ?? "data/tokens.json";
const API = readFlag("api") ?? "https://lite-api.jup.ag";

if (REGISTRY !== null && API !== null) {
  const list = JSON.parse(readFileSync(REGISTRY, "utf8"));
  const ids = list.map((t) => t.mint).join(",");
  const res = await fetch(`${API}/price/v3?ids=${ids}`, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; Lotwise/0.1)" },
  });
  if (!res.ok) {
    console.error(`Jupiter HTTP ${res.status}`);
    process.exitCode = 1;
  } else {
    const prices = await res.json();

    // счётчик пустых decimals — ДО обогащения (волна B): после мутации список уже
    // полон и каждый повторный прогон врал «0/31»
    const missingBefore = list.filter((t) => t.decimals === null || t.decimals === undefined).length;
    const { filled, unknown, skipped, written } = enrichDecimalsFile(REGISTRY, prices);
    if (!written) console.log("filled=0 — data/tokens.json не перезаписан (нечего писать)");
    console.log(`decimals заполнено: ${filled}/${missingBefore} без decimals на входе`);
    console.log(unknown.length ? `НЕ найдены в Jupiter: ${unknown.join(", ")}` : "все минты известны Jupiter");
    if (skipped?.length) console.warn(`ПРОПУЩЕНЫ (мусорные decimals от Jupiter): ${skipped.map((x) => `${x.mint} (${x.reason})`).join(", ")}`);
  }
}
