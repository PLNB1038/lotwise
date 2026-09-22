// webhook-deliver — CLI доставки событий по webhook-подпискам. Единственный
// исполняемый слой вебхуков: сам API-сервер строго GET-only (405 на не-GET
// запинен тестами), маршрутов подписки/доставки у него нет и не появится —
// доставка инициируется оператором/кроном этой командой.
//
// Запуск из корня репо:
//   node scripts/webhook-deliver.mjs --events data/events.json
//   cat data/events.json | node scripts/webhook-deliver.mjs
// Флаги:
//   --subscriptions <путь>  файл подписок (по умолчанию data/webhooks.json;
//                           файла может не быть — тогда адресатов нет, всё skipped)
//   --events <путь>         файл с массивом канонических событий; без флага — stdin
//   --json                  только JSON-отчёт {delivered, skipped, failed, deliveries, warnings}
//   -h, --help              справка
// Коды выхода: 0 — неудачных доставок нет (failed=0; «некому доставлять» — не провал),
// 1 — есть failed (исчерпали ретраи без 2xx), 2 — ошибка запуска/чтения (битые файлы,
// невалидные события/подписки, неизвестный флаг).
//
// Осознанные решения:
// - Сеть и паузы вынесены в инжектируемые зависимости main(argv, {fetcher, sleep}) —
//   тесты гоняют сценарии «все ретраи исчерпаны» без сети и без пауз 1s/4s;
//   spawnSync-тесты покрывают только пути без сети (usage, чтение, skipped).
// - Отчёт печатается ПОСЛЕ всей доставки: процесс не смешивает прогресс с вердиктом.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_SUBSCRIPTIONS_PATH,
  deliverToAll,
  listSubscriptions,
  SubscriptionError,
} from "../src/webhooks/subscriptions.mjs";
import { EventValidationError } from "../src/schema/events.mjs";

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

class UsageError extends Error {}

const USAGE = `использование: node scripts/webhook-deliver.mjs [флаги]
  --subscriptions <путь>  файл подписок (по умолчанию ${DEFAULT_SUBSCRIPTIONS_PATH})
  --events <путь>         файл с массивом событий; без флага — stdin
  --json                  только JSON-отчёт {delivered, skipped, failed, deliveries, warnings}
  -h, --help              эта справка
Коды выхода: 0 — неудачных доставок нет, 1 — есть failed, 2 — ошибка запуска/чтения.`;

export function parseArgs(argv) {
  const opts = { json: false, help: false, subscriptions: DEFAULT_SUBSCRIPTIONS_PATH, events: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "-h" || arg === "--help") opts.help = true;
    else if (arg === "--subscriptions") {
      const value = argv[++i];
      if (value === undefined) throw new UsageError("--subscriptions требует путь");
      opts.subscriptions = value;
    } else if (arg === "--events") {
      const value = argv[++i];
      if (value === undefined) throw new UsageError("--events требует путь (или - для stdin)");
      opts.events = value; // «-» = stdin, как у классических утилит
    } else {
      throw new UsageError(`неизвестный флаг: ${arg}`);
    }
  }
  return opts;
}

function readEvents(opts) {
  let raw;
  if (opts.events === null || opts.events === "-") {
    raw = readFileSync(0, "utf8"); // stdin: пустой пайп = пустой список — честный no-op
  } else {
    raw = readFileSync(opts.events, "utf8");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`события не парсятся: ${err.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error("события обязаны быть массивом канонических событий");
  return parsed;
}

function printHuman(report) {
  console.log("[webhook-deliver] доставка событий по подпискам");
  console.log(
    `[webhook-deliver] ИТОГ: delivered=${report.delivered}, skipped=${report.skipped}, failed=${report.failed}`,
  );
  for (const w of report.warnings) console.log(`[webhook-deliver]   ... ${w}`);
}

/**
 * Возвращает код выхода (0/1/2). Сеть/паузы инжектируемые — тесты без сети.
 * @param {string[]} argv
 * @param {{fetcher?: Function, sleep?: Function}} [deps]
 */
export async function main(argv = [], { fetcher = fetch, sleep = defaultSleep } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`[webhook-deliver] ${err.message}`);
    console.error(USAGE);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  let events;
  try {
    events = readEvents(opts);
  } catch (err) {
    console.error(`[webhook-deliver] события: ${err.message}`);
    return 2;
  }
  let subs;
  try {
    // listSubscriptions из модуля: нет файла = [] (доставлять некому, не ошибка),
    // битый файл/невалидная запись — SubscriptionError → exit 2, базу не трогаем.
    subs = listSubscriptions(opts.subscriptions);
  } catch (err) {
    console.error(`[webhook-deliver] подписки: ${err.message}`);
    return 2;
  }
  let report;
  try {
    report = await deliverToAll(events, subs, { fetcher, sleep });
  } catch (err) {
    // Битое событие по схеме — проблема входных данных, а не доставки.
    const what = err instanceof EventValidationError || err instanceof SubscriptionError ? "события невалидны" : "доставка сорвана";
    console.error(`[webhook-deliver] ${what}: ${err.message}`);
    return 2;
  }
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
  return report.failed === 0 ? 0 : 1;
}

// CLI-режим только при прямом запуске (тесты импортируют main без побочек).
const invokedAs = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
const isSelf =
  import.meta.url === invokedAs ||
  (process.platform === "win32" && import.meta.url.toLowerCase() === invokedAs.toLowerCase());
if (isSelf) process.exit(await main(process.argv.slice(2)));
