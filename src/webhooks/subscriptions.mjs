// Webhook-подписки Lotwise: хранилище (файл), сопоставление событий подпискам
// и доставка с HMAC-подписью и ретраями.
//
// ПОЧЕМУ БИБЛИОТЕКА, А НЕ HTTP-МАРШРУТЫ: API-сервер (src/api/server.mjs) строго
// GET-only — 405 на не-GET запинен тестами (api.test.mjs) и сломать его нельзя.
// Поэтому вебхуки — это модуль + CLI доставки (scripts/webhook-deliver.mjs),
// без единого HTTP-эндпоинта: подписки живут в файле (по умолчанию
// data/webhooks.json, появляется только в рантайме — при первой addSubscription),
// доставка инициируется оператором/кроном, а не сервером.
//
// Формат записи подписки: {id, url, symbols, secret, createdAt, active}
//   symbols — "*" (wildcard: все события) или непустой массив токен-идентификаторов
//             (символы реестра или минты — сверка точная, без регистра-магии);
//   secret  — ключ HMAC-SHA256 для подписи тела (X-Lotwise-Signature);
//   active  — выключенная подписка не доставляет, но остаётся в файле (деактивация
//             обратима удалением+добавлением; отдельного activate нет сознательно).
//
// Доставка: POST JSON-конверта {deliveryId, sentAt, event}; заголовки
//   X-Lotwise-Event     — тип события (event.type);
//   X-Lotwise-Delivery  — id доставки (один на все ретраи: получатель видит дубль,
//                         а не два разных вебхука — идемпотентность на его стороне);
//   X-Lotwise-Signature — "sha256=" + hex(HMAC-SHA256(secret, exact body)).
// Ретраи: до 3 попыток, backoff 1s → 4s; успех = 2xx; сетевой отказ/таймаут/не-2xx
// — попытка не удалась. Тело и подпись считаются ОДИН РАЗ до попыток: все ретраи
// несут байт-в-байт тот же payload (иначе получатель не смог бы сверить подпись
// повторно, а идемпотентность по deliveryId потеряла бы смысл).
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { atomicWriteJson } from "../fs/atomic.mjs";
import { validateEvent } from "../schema/events.mjs";
import { isValidIsoDate } from "../schema/isodate.mjs";

// Дефолтный путь хранилища — ТОЛЬКО значение по умолчанию для CLI: модуль сам
// файл не создаёт и при импорте не трогает (тестам путь передаётся явно).
export const DEFAULT_SUBSCRIPTIONS_PATH = "data/webhooks.json";

export const MAX_ATTEMPTS = 3;
export const BACKOFF_MS = [1000, 4000];
export const DEFAULT_TIMEOUT_MS = 10_000;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SubscriptionError extends Error {
  constructor(msg, field) {
    super(field ? `${msg} (${field})` : msg);
    this.name = "SubscriptionError";
    this.field = field;
  }
}

// ---------- валидация ----------

/**
 * Валидация записи подписки. Бросает SubscriptionError с именем поля.
 * Поля обязательны все: хранилище не знает «частично заполненных» записей —
 * запись либо годна для доставки, либо не должна попадать в файл.
 */
export function validateSubscription(sub) {
  if (!sub || typeof sub !== "object" || Array.isArray(sub)) {
    throw new SubscriptionError("подписка обязана быть объектом");
  }
  // symbols в этот цикл не входит: это "*" или массив, проверяется ниже своей веткой
  for (const f of ["id", "url", "secret", "createdAt"]) {
    if (typeof sub[f] !== "string" || sub[f] === "") {
      throw new SubscriptionError("missing or non-string required field", f);
    }
  }
  let parsed;
  try {
    parsed = new URL(sub.url);
  } catch {
    throw new SubscriptionError("url must be a valid absolute URL", "url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SubscriptionError("url must be http(s)", "url");
  }
  if (sub.symbols !== "*") {
    if (!Array.isArray(sub.symbols) || sub.symbols.length === 0) {
      throw new SubscriptionError('symbols must be "*" or a non-empty array of strings', "symbols");
    }
    for (const s of sub.symbols) {
      if (typeof s !== "string" || s === "") {
        throw new SubscriptionError("each symbol must be a non-empty string", "symbols");
      }
    }
  }
  // createdAt пишем только мы (new Date(...).toISOString()) — строгий ISO,
  // тот же парсер, что у всего конвейера дат (schema/isodate.mjs).
  if (!isValidIsoDate(sub.createdAt)) {
    throw new SubscriptionError("createdAt must be canonical ISO-8601 datetime", "createdAt");
  }
  if (typeof sub.active !== "boolean") {
    throw new SubscriptionError("active must be a boolean", "active");
  }
  return true;
}

// ---------- хранилище (файл, путь передаётся параметром) ----------

/**
 * Чтение хранилища подписок. Нет файла = честный пустой список (первый запуск);
 * битый JSON / не массив / невалидная запись — ГРОМКИЙ отказ (fail-closed):
 * доставка по недоверенной базе не выполняется, файл не перезаписывается.
 * @returns {Array} записи подписок
 */
function readStore(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw new SubscriptionError(`файл подписок не читается: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SubscriptionError(`невалидный JSON в ${filePath}: ${err.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new SubscriptionError(`хранилище подписок ${filePath} обязано быть массивом записей`);
  }
  parsed.forEach((sub, i) => {
    try {
      validateSubscription(sub);
    } catch (err) {
      throw new SubscriptionError(`битая запись subscriptions[${i}]: ${err.message}`, err.field);
    }
  });
  return parsed;
}

function writeStore(filePath, subs) {
  atomicWriteJson(filePath, subs);
}

function updateStore(filePath, mutate) {
  const subs = readStore(filePath);
  const result = mutate(subs);
  writeStore(filePath, subs);
  return result;
}

function makeId() {
  return `wh_${randomUUID()}`;
}

/**
 * Добавить подписку. id генерируется, если не передан (тестам — явный id);
 * дубликат id — отказ (id — ключ remove/deactivate, молчаливая перезапись
 * чужой подписки недопустима).
 * @param {string} filePath — путь к хранилищу (файл создаётся при первой записи)
 * @param {{id?: string, url: string, symbols: "*"|string[], secret: string, nowMs?: number}} spec
 * @returns {object} записанная подписка
 */
export function addSubscription(filePath, { id, url, symbols, secret, nowMs = Date.now() } = {}) {
  const record = { id: id ?? makeId(), url, symbols, secret, createdAt: new Date(nowMs).toISOString(), active: true };
  validateSubscription(record);
  return updateStore(filePath, (subs) => {
    if (subs.some((s) => s.id === record.id)) {
      throw new SubscriptionError(`подписка с id "${record.id}" уже существует`, "id");
    }
    subs.push(record);
    return record;
  });
}

/**
 * Список подписок; нет файла — пустой массив. Возвращает копию: правка результата
 * не должна задевать диск и следующие вызовы.
 */
export function listSubscriptions(filePath) {
  return readStore(filePath).map((s) => ({ ...s, symbols: s.symbols === "*" ? "*" : [...s.symbols] }));
}

/**
 * Удалить подписку по id. @returns {boolean} нашли и удалили.
 */
export function removeSubscription(filePath, id) {
  return updateStore(filePath, (subs) => {
    const i = subs.findIndex((s) => s.id === id);
    if (i === -1) return false;
    subs.splice(i, 1);
    return true;
  });
}

/**
 * Деактивировать подписку (active=false, запись остаётся). Повторная деактивация
 * уже выключенной — не ошибка. @returns {boolean} нашли ли id.
 */
export function deactivateSubscription(filePath, id) {
  return updateStore(filePath, (subs) => {
    const sub = subs.find((s) => s.id === id);
    if (!sub) return false;
    sub.active = false;
    return true;
  });
}

// ---------- сопоставление ----------

/**
 * Подписки, адресованные событию. Матч — по токен-идентификатору: wildcard "*"
 * ловит всё; иначе symbols записи сверяются с symbol события ИЛИ с его mint
 * (минт в списке — легальный способ подписаться, реестр стоит на минтах, а
 * символ не уникален). Сверка ТОЧНАЯ: base58-минты регистрозависимы, «умный»
 * case-folding сломал бы их. Активность здесь НЕ фильтруется — чистый матч;
 * решает «доставлять или нет» deliverToAll.
 * @param {Array} subs
 * @param {{symbol?: string, mint?: string}} ctx — идентификаторы события
 */
export function matchSubscriptions(subs, { symbol, mint } = {}) {
  return subs.filter((sub) => {
    if (sub.symbols === "*") return true;
    if (symbol !== undefined && sub.symbols.includes(symbol)) return true;
    if (mint !== undefined && sub.symbols.includes(mint)) return true;
    return false;
  });
}

// ---------- доставка ----------

/**
 * Символ/минт события для матчинга. Канонические события символ НЕ несут
 * (схема — mint-only), кроме TICKER_CHANGE, где oldSymbol/newSymbol — часть
 * контракта типа; операторский файл может нести и «сырое» поле symbol.
 * Предпочтение — АКТУАЛЬНОЕ имя (symbol, затем newSymbol): после смены тикера
 * живой идентификатор — новое имя, подписчики старого адресуются по минту.
 */
function eventContext(event) {
  return { symbol: event.symbol ?? event.newSymbol ?? event.oldSymbol, mint: event.mint };
}

// Детерминированный id доставки (ROUND7 №7): sha256(подписка × канонический JSON
// события). Прогон доставки по тому же файлу событий mint'ит ТОТ ЖЕ
// X-Lotwise-Delivery — получатель дедупит между прогонами, а не только внутри
// ретраев одной доставки (раньше каждый прогон = randomUUID = «новое» событие).
// sentAt в id НЕ входит (оно меняется между прогонами); идентичность = пара
// (подписка, событие) с канонизацией ключей — порядок полей JSON не влияет.
function canonicalJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
}

function deterministicDeliveryId(sub, event) {
  const key = `${String(sub.id ?? sub.url)}|${canonicalJson(event)}`;
  return `whd_${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

/**
 * Доставить одно событие в одну подписку. POST JSON-конверта
 * {deliveryId, sentAt, event}; подпись HMAC-SHA256(secret, body) — точь-в-точь
 * по байтам отправленного тела. До MAX_ATTEMPTS попыток с backoff BACKOFF_MS;
 * успех = 2xx, остальное (не-2xx, сетевой отказ, таймаут, 3xx — redirect:error)
 * — попытка не удалась. Сеть и таймеры инжектируемые: тесты ходят мок-fetcher'ом
 * и mock-sleep без пауз.
 * Идемпотентность: deliveryId по умолчанию ДЕТЕРМИНИРОВАН парой (подписка,
 * событие) — повторный прогон доставки даёт получателю уже знакомый id; явный
 * opts.deliveryId побеждает (единичные доставки с наружным идентификатором).
 * @param {object} sub — валидная подписка (url, secret)
 * @param {object} event — валидное каноническое событие (schema/events.mjs)
 * @param {{fetcher?: Function, sleep?: Function, timeoutMs?: number, deliveryId?: string, nowMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, attempts: number, statuses: Array<number|null>, error: string|null}>}
 *   statuses — по попытке: HTTP-статус или null (сеть/таймаут); error — последняя причина.
 */
export async function deliverWebhook(
  sub,
  event,
  { fetcher = fetch, sleep = defaultSleep, timeoutMs = DEFAULT_TIMEOUT_MS, deliveryId, nowMs = Date.now() } = {},
) {
  const id = deliveryId ?? deterministicDeliveryId(sub, event);
  // Конверт и подпись фиксируются ДО попыток: все ретраи несут тот же payload
  // и ту же подпись (получатель сверяет подпись на каждый повтор).
  const body = JSON.stringify({ deliveryId: id, sentAt: new Date(nowMs).toISOString(), event });
  const signature = `sha256=${createHmac("sha256", sub.secret).update(body).digest("hex")}`;
  const headers = {
    "content-type": "application/json",
    "x-lotwise-event": String(event.type),
    "x-lotwise-delivery": id,
    "x-lotwise-signature": signature,
  };

  const statuses = [];
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // AbortSignal.timeout — один таймаут на попытку (не на серию): зависший
      // приёмник не съедает оставшиеся попытки. redirect:"error" (ROUND7 №5):
      // дефолтное "follow" превращало 302 в пустой GET на чужой хост, 2xx там
      // засчитывался как доставка, а заголовки с HMAC-подписью утекали получателю
      // редиректа. 3xx — провал попытки, как сетевой отказ.
      const res = await fetcher(sub.url, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
      statuses.push(res.status);
      if (res.status >= 200 && res.status < 300) {
        return { ok: true, attempts: attempt, statuses, error: null };
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      statuses.push(null);
      lastError = String(err?.cause?.message ?? err?.message ?? err);
    }
    if (attempt < MAX_ATTEMPTS) await sleep(BACKOFF_MS[attempt - 1]);
  }
  return { ok: false, attempts: MAX_ATTEMPTS, statuses, error: lastError };
}

/**
 * Доставить список событий во все подходящие подписки. События валидируются
 * схемой ДО первой отправки: битый хвост списка не должен успеть уйти половиной.
 * Счётчики: delivered — (событие, подписка) с 2xx; failed — исчерпали ретраи;
 * skipped — пары без попытки: выключенная подписка под матчем или событие без
 * единого адресата («некому» — не провал, отдельная строка отчёта).
 * @param {Array} events — канонические события
 * @param {Array} subs — подписки (например, listSubscriptions(path))
 * @param {{fetcher?: Function, sleep?: Function, timeoutMs?: number, nowMs?: number}} [opts]
 * @returns {Promise<{delivered: number, skipped: number, failed: number,
 *                     deliveries: Array<{subscriptionId: string, eventType: string,
 *                                        ok: boolean, attempts: number, statuses: Array, error: string|null}>,
 *                     warnings: string[]}>}
 */
export async function deliverToAll(events, subs, opts = {}) {
  const { fetcher = fetch, sleep = defaultSleep, timeoutMs = DEFAULT_TIMEOUT_MS, nowMs = Date.now() } = opts;
  for (const event of events) validateEvent(event); // fail-fast до любых отправок

  const counters = { delivered: 0, skipped: 0, failed: 0 };
  const deliveries = [];
  const warnings = [];
  for (const event of events) {
    const matches = matchSubscriptions(subs, eventContext(event));
    let attempted = 0;
    for (const sub of matches) {
      if (!sub.active) {
        counters.skipped += 1;
        warnings.push(`подписка ${sub.id} выключена — событие ${event.type} не доставлено`);
        continue;
      }
      attempted += 1;
      const result = await deliverWebhook(sub, event, { fetcher, sleep, timeoutMs, nowMs });
      if (result.ok) counters.delivered += 1;
      else counters.failed += 1;
      deliveries.push({ subscriptionId: sub.id, eventType: event.type, ...result });
    }
    if (matches.length === 0) {
      counters.skipped += 1;
      warnings.push(`событие ${event.type} (${event.mint}) — подходящих подписок нет`);
    }
  }
  return { ...counters, deliveries, warnings };
}
