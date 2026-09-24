// Шаг синхронизации on-chain журнала — чистая функция над (запись журнала, план цепи).
// Выделена из serve.mjs ради тестируемости P0-инварианта: события журнала переживают
// рестарт процесса. parsed === null — цепь недоступна: реплеем кэш прошлых событий,
// запись журнала не трогаем (observedAt остаётся честно протухшим).
import { journalTransition } from "./normalize-onchain.mjs";
import { readFileSync, openSync, closeSync, unlinkSync, statSync, writeSync } from "node:fs";
import { parseIsoDateMs } from "../schema/isodate.mjs";
import { canonicalDecimalString } from "../schema/events.mjs";
import { atomicWriteJson, preserveCorruptedFile } from "../fs/atomic.mjs";

// Канонизация записи журнала ПРИ ЧТЕНИИ (ROUND9 №15): журнал, записанный билдом
// до канонизации, несёт сырую репрезентацию RPC («5.0») — строковый дифф с
// канонической цепью («5») эмитил фантомное MULTIPLIER_CHANGE той же величины.
// Канонизируем lastEffective и multiplier-поля истории. Уже-каноническая запись
// возвращается ПО ССЫЛКЕ (контракт «entry===priorEntry при недоступной цепи»);
// поле не похоже на decimal — остаётся как есть (валидация ниже честно отвергнет).
function canonicalizeEntry(entry) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
  const canonMult = (v) => (typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? canonicalDecimalString(v) : v);
  const eventsCanonical = !Array.isArray(entry.events) || entry.events.every((e) => (
    e === null || typeof e !== "object"
    || (canonMult(e.multiplierFrom) === e.multiplierFrom && canonMult(e.multiplierTo) === e.multiplierTo)
  ));
  if (canonMult(entry.lastEffective) === entry.lastEffective && eventsCanonical) return entry;
  return {
    ...entry,
    lastEffective: canonMult(entry.lastEffective),
    events: Array.isArray(entry.events)
      ? entry.events.map((e) => (e !== null && typeof e === "object"
        ? { ...e, multiplierFrom: canonMult(e.multiplierFrom), multiplierTo: canonMult(e.multiplierTo) }
        : e))
      : entry.events,
  };
}

/**
 * @param {object} token — запись реестра (нужны mint, symbol)
 * @param {{lastEffective: string, observedAt: string, events?: Array}|null} priorEntry — запись из журнала на диске
 * @param {object|null} parsed — parseScaledUiAmount(...) или null, если цепь недоступна
 * @returns {{replay: Array, event: object|null, entry: object|null, chain: "ok"|"unavailable", unavailableV1: boolean, corrupted: boolean}}
 *   replay — события прошлых сессий для реплея в events-поток;
 *   event — ТОЛЬКО новое событие этого шага;
 *   entry — запись к сохранению (null = нечего сохранить, история не начата);
 *   entry===priorEntry (та же ссылка) при недоступной цепи — сохранение без изменений;
 *   unavailableV1 — запись v1 (без events) с множителем ≠ "1" и недоступной цепью:
 *   миграция бэкфиллом невозможна, витрина покажет множитель 1 — warn обязан стрелять,
 *   иначе «настоящие 5» молча выглядят как 1 (тихая ложь, раунд 4);
 *   corrupted — запись priorEntry повреждена (events есть, но не массив): история
 *   недоверена, шаг выполнен в fail-closed (см. тело planJournalStep).
 */
export function planJournalStep(token, priorEntry, parsed, nowMs = Date.now()) {
  // Раунд 7 (адверсариальные тесты журнала): запись с events-НЕ-массивом —
  // ПОВРЕЖДЁННАЯ, а не «истории нет». Раньше v1/v2 различались только
  // Array.isArray(events), поэтому поле-мусор (строка "1→5" вместо массива) молча
  // превращало запись в «первое наблюдение»: реплей пуст, бэкфилл переизлучал
  // дубликат события, а файл оставался валидным по форме — проверки повреждений
  // его не видели. Отсутствие поля (undefined) — легитимная запись v1 (миграция
  // бэкфиллом), ЛЮБОЕ другое не-массивное значение — порча. Семантика fail-closed
  // по образцу раунда 6 (повреждение — явное состояние, улика переживает запись):
  //   (1) громкий console.error оператору с ПОЛНОЙ уликой — битая запись
  //       сериализуется в лог; это единственное доступное планеру место улики:
  //       путь журнала сюда не доходит, сохранить битую запись рядом с файлом
  //       может только слой serve (bootJournalOnchain), в контракт которого
  //       planJournalStep намеренно не лезет (чистая функция над записью);
  //   (2) дубль события из бэкфилла НЕ переизлучается — ни в event, ни в events;
  //   (3) при живой цепи — восстановление с нуля: lastEffective фиксируется от
  //       факта цепи, events честно пусты (старая история невосстановима —
  //       не выдумываем); дальнейшие шаги живут по штатной mid-history семантике;
  //   (4) при недоступной цепи entry: null — битая запись на диске не трогается,
  //       восстановление возможно только по факту цепи (улика переживает шаг).
  const priorIsObject = priorEntry !== null && priorEntry !== undefined && typeof priorEntry === "object";
  // ROUND7 №4 + ROUND9 №4: запись-ПРИМИТИВ и запись-МАССИВ — та же порча, что
  // events-не-массив. Массив — тоже typeof "object", но структурой не запись
  // {lastEffective, events}: раньше проходил в «нет истории» (base=null), бэкфилл
  // переизлучал дубль, финальный персист затирал улику; loadJournalOnchain при этом
  // массив НАВЕРХУ файла отвергает как порчу — по-записи обязан так же.
  const priorIsCorrupted = priorEntry !== null && priorEntry !== undefined
    && (typeof priorEntry !== "object"
      || Array.isArray(priorEntry)
      || (priorEntry.events !== undefined && !Array.isArray(priorEntry.events)));
  if (priorIsCorrupted) {
    console.error(
      `[journal] ${token.symbol ?? token.mint}: запись журнала ПОВРЕЖДЕНА — ${
        !priorIsObject
          ? `не объект (${typeof priorEntry})`
          : Array.isArray(priorEntry)
            ? "массив вместо объекта записи"
            : `events не массив (тип ${priorEntry.events === null ? "null" : typeof priorEntry.events})`
      }, история недоверена. Улика: ${JSON.stringify(priorEntry)}. ` +
      `Реплей и бэкфилл по ней НЕ выполняются — дубль события не переизлучается; ` +
      `при живой цепи запись восстановится с нуля (без событий, витрина предупредит о множителе без истории).`,
    );
    if (parsed === null) {
      return { replay: [], event: null, entry: null, chain: "unavailable", unavailableV1: false, corrupted: true };
    }
    const recovered = journalTransition(token, parsed, null, nowMs);
    return {
      replay: [],
      event: null, // бэкфилл задавлен: переизлучать дубликат по недоверенной базе нельзя
      entry: { ...recovered.entry, events: [] },
      chain: "ok",
      unavailableV1: false,
      corrupted: true,
    };
  }
  // v2-маркер записи — массив events; записи v1 (без него) прогоняются бэкфиллом:
  // так задеплоенный инстанс самовосстанавливается без ручной миграции файла.
  // Канонизация — ДО всех сравнений (ROUND9 №15): реплей/дифф видят канонические строки.
  const prior = canonicalizeEntry(priorEntry);
  const base = priorIsObject && Array.isArray(prior.events) ? prior : null;
  const replay = base ? base.events : [];
  if (parsed === null) {
    const unavailableV1 = base === null && prior && prior.lastEffective !== "1";
    return { replay, event: null, entry: base, chain: "unavailable", unavailableV1, corrupted: false };
  }
  const { event, entry } = journalTransition(token, parsed, base, nowMs);
  return { replay, event, entry, chain: "ok", unavailableV1: false, corrupted: false };
}

/**
 * Проверка полноты цепочки истории эмитента (xStocks multiplier history).
 * Пагинация в serve ограничена потолком страниц, поэтому старейший узел собранного
 * может НЕ начинаться от "1" — такой набор рвёт MultiplierTimeline ("chain
 * discontinuity") и раньше валил сервер на старте (boot-loop). Честный отказ:
 * события не скармливаются таймлайну, warn вместо краша (fail-honest).
 * @param {Array<{previousMultiplier: string, activationDateTime: string}>} nodes — узлы fetchMultiplierHistory, любой порядок
 * @returns {{complete: boolean, reason: string|null}} complete=true — цепочка от "1", можно кормить таймлайн
 */
export function issuerChainComplete(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) return { complete: true, reason: null };
  let oldest = null;
  let oldestTs = Number.POSITIVE_INFINITY;
  for (const n of nodes) {
    // Тот же строгий парсер, что у всего конвейера дат (schema/isodate.mjs) — раунд 6,
    // LW2_issuer_chain_complete_dateparse_divergence: раньше здесь был Date.parse,
    // который перекатывал "2026-02-30T00:00:00Z" на 2 марта и парсил наивное время
    // как ЛОКАЛЬНОЕ — узлы с такими датами проходили гейт, а затем падали ниже
    // с NormalizeError («источник недоступен» при живом источнике).
    const ts = parseIsoDateMs(n.activationDateTime);
    // дата-мусор/перекат/наивное время — не гадаем: узел не участвует в выборе
    // старейшего, цепочка непроверяема = неполна (fail-closed)
    if (ts === null) {
      return { complete: false, reason: `непарсируемая дата активации: ${JSON.stringify(n.activationDateTime)}` };
    }
    if (ts < oldestTs) {
      oldestTs = ts;
      oldest = n;
    }
  }
  if (oldest.previousMultiplier !== "1") {
    return {
      complete: false,
      reason: `старейшее событие ${oldest.activationDateTime} начинается от "${oldest.previousMultiplier}", а не от "1"`,
    };
  }
  return { complete: true, reason: null };
}

// ---- персистентность журнала (раунд 5, LW_journal_write_non_atomic) ----
// Прямой writeFileSync поверх живого файла при обрыве (краш/kill в окне бута, диск)
// оставлял усечённый JSON, который при следующем старте молча трактовался как
// «первый запуск» (пустой журнал) — невосстановимая потеря всей истории событий.
// Два противопоставления: (1) запись атомарна — temp в той же директории + fsync +
// rename, на диске всегда либо старая целая версия, либо новая целая; (2) битый
// файл при загрузке — явное состояние «повреждён» (fail-closed), различимое от
// честного первого запуска, а не тихий {}.

/**
 * Атомарная запись журнала: payload целиком уходит во временный файл в ТОЙ ЖЕ
 * директории (rename между устройствами не работает), fsync'ится и переименовывается
 * поверх целевого файла. Обрыв в любой момент оставляет на месте журнала целую
 * предыдущую версию; temp-файл при неудачном rename подчищается.
 * С раунда 6 делегирует общему atomicWriteJson (src/fs/atomic.mjs) — той же
 * реализацией пользуются писатели tokens.json.
 * @param {string} journalPath — путь к onchain-journal.json
 * @param {object} journal — карта { mint: entry }
 */
export function saveJournalAtomic(journalPath, journal) {
  atomicWriteJson(journalPath, journal);
}

/**
 * Загрузка журнала с различением «первый запуск» и «файл повреждён».
 * Раньше один catch на оба случая давал тихий {} — усечённый после обрыва записи
 * файл выглядел как чистый старт, и история событий терялась невосстановимо.
 * @param {string} journalPath
 * @returns {{ok: boolean, corrupted: boolean, journal: object, reason: string|null}}
 *   файла нет → { ok: true, corrupted: false } (бэкфилл из цепи — легитимный старт);
 *   прочитано, но не парсится / не объект {mint: entry} → { ok: false, corrupted: true }.
 */
export function loadJournalOnchain(journalPath) {
  let raw;
  try {
    raw = readFileSync(journalPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { ok: true, corrupted: false, journal: {}, reason: null };
    }
    return { ok: false, corrupted: true, journal: {}, reason: `файл журнала не читается: ${err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, corrupted: true, journal: {}, reason: `усечённый/невалидный JSON: ${err.message}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const got = parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
    return { ok: false, corrupted: true, journal: {}, reason: `журнал обязан быть объектом {mint: entry}, получен ${got}` };
  }
  return { ok: true, corrupted: false, journal: parsed, reason: null };
}

/**
 * Сохранить повреждённый файл журнала как улику ПЕРЕД первой перезаписью. С раунда 6
 * делегирует общему preserveCorruptedFile (src/fs/atomic.mjs): ретраи rename с другими
 * именами (AV/индексер держат файл мгновение — «временный» отказ часто снят второй
 * попыткой) и copy-фолбэк, если rename так и не удался.
 * @param {string} journalPath
 * @param {{nowMs?: number, attempts?: number, rename?: Function, copy?: Function}} [opts]
 * @returns {string|null} путь к улике или null, если улику сохранить не удалось вовсе.
 */
export function preserveCorruptedJournal(journalPath, opts = {}) {
  return preserveCorruptedFile(journalPath, opts);
}

/**
 * Бут журнала (раунд 6, LW2_journal_evidence_clobber_on_failed_preserve): загрузка +
 * сохранение улики — единая точка для scripts/serve.mjs. Ключевая гарантия: если улику
 * сохранить НЕ удалось (preserveFailed), повреждённый оригинал остаётся на месте — и
 * бут ОБЯЗАН работать в режиме read-only (persistJournalOnBoot откажет в записи),
 * потому что финальный saveJournalAtomic стёр бы единственную копию истории. Раньше
 * serve не ветвился по null от preserveCorruptedJournal и затирал оригинал в конце бута.
 * @param {string} journalPath
 * @param {{nowMs?: number, attempts?: number, rename?: Function, copy?: Function}} [opts]
 * @returns {{journal: object, corrupted: boolean, reason: string|null,
 *            backup: string|null, preserveFailed: boolean}}
 */
export function bootJournalOnchain(journalPath, opts = {}) {
  const loaded = loadJournalOnchain(journalPath);
  if (!loaded.corrupted) {
    return { journal: loaded.journal, corrupted: false, reason: null, backup: null, preserveFailed: false };
  }
  const backup = preserveCorruptedFile(journalPath, { attempts: 3, ...opts });
  return {
    journal: loaded.journal,
    corrupted: true,
    reason: loaded.reason,
    backup,
    preserveFailed: backup === null,
  };
}

/**
 * Финальная запись журнала в конце бута — ЕДИНСТВЕННОЕ место, откуда serve.mjs пишет
 * журнал. preserveFailed=true ⇒ режим read-only до перезапуска: запись не выполняется,
 * повреждённый оригинал гарантированно переживает бут; события сессии живут в памяти,
 * /health показывает journal.preserveFailed=1. Перезапуск после ухода залочившего
 * процесса сохранит улику штатно и вернёт запись.
 * @param {string} journalPath
 * @param {object} journal
 * @param {{preserveFailed?: boolean}} [opts]
 * @returns {{written: boolean, readonly: boolean, error: Error|null}}
 */
export function persistJournalOnBoot(journalPath, journal, { preserveFailed = false } = {}) {
  if (preserveFailed) return { written: false, readonly: true, error: null };
  try {
    // Волна E (E3-2): merge-under-lock, а не снапшот поверх диска — чужая запись,
    // положенная в окно «бут прочитал → персистнул», раньше молча затиралась.
    saveJournalMerged(journalPath, journal);
    return { written: true, readonly: false, error: null };
  } catch (err) {
    return { written: false, readonly: false, error: err };
  }
}

// Синхронная пауза без занятого ожидания (паттерн стор-лока вебхуков R8).
const SYNC_WAIT_CELL = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms) => Atomics.wait(SYNC_WAIT_CELL, 0, 0, ms);

// pid-живость (семантика ROUND9 №9 из стор-лока вебхуков): существующий процесс =
// живой владелец, EPERM = чужой, но живой; ESRCH = мёртв.
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// Эксклюзивный лок-файл. Содержимое load-bearing: {pid, createdAt} — по pid мёртвый
// владелец ломается СРАЗУ (сирота после kill -9), живой SIGSTOP-процесс со старым
// mtime НЕ ломается (волна F1 повторила TOCTOU R9 №9 для второго лока — закрыто).
// Легаси/не-JSON содержимое — по одному mtime, как в вебхук-локе. Будущий mtime
// (перекос часов) — тоже кандидат на ломку: ждать staleMs от «завтра» бессмысленно.
// nowMs инжектится (паттерн лимитёра) — граница «ровно staleMs» пинится детерминированно.
// Возвращает fd или null (не взяли — деградация, бут не должен падать из-за лока).
function acquireSyncLock(lockPath, { staleMs, attempts, retryPauseMs, nowMs = Date.now }) {
  const now = typeof nowMs === "function" ? nowMs() : nowMs;
  for (let i = 0; i < attempts; i++) {
    let fd = null;
    try {
      fd = openSync(lockPath, "wx");
    } catch (err) {
      if (err.code !== "EEXIST") return null;
      try {
        const meta = (() => {
          try {
            return JSON.parse(readFileSync(lockPath, "utf8"));
          } catch {
            return null; // легаси/пустой контент — pid-семантика неприменима
          }
        })();
        if (meta !== null && Number.isInteger(meta?.pid)) {
          // лок с pid: мёртвый владелец ломается СРАЗУ (сирота после kill -9 не жжёт
          // staleMs — волна F1-4), живой не ломается ВООБЩЕ (SIGSTOP-владелец не теряет
          // обновление — R9 №9), независимо от mtime
          if (!isPidAlive(meta.pid)) unlinkSync(lockPath);
        } else {
          const age = now - statSync(lockPath).mtimeMs;
          // легаси-лок — mtime-семантика; будущее учитывается только ЗА ±staleMs:
          // NTFS округляет mtime вверх на доли мс — свежий лок не должен выглядеть
          // «минус-миллисекундным будущим» (грабли раунда 15)
          if (age > staleMs || age < -staleMs) unlinkSync(lockPath);
        }
      } catch {
        /* лок исчез между EEXIST и stat — просто ретрай */
      }
      if (fd === null) {
        sleepSync(retryPauseMs);
        continue;
      }
    }
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      return fd;
    } catch (err) {
      // Пустой лок следующий процесс сочтёт легаси и сломает ЖИВОГО владельца по
      // mtime — реанимация TOCTOU. Снимаем и деградируем без лока.
      try { closeSync(fd); } catch { /* уже закрыт */ }
      try { unlinkSync(lockPath); } catch { /* уже удалён */ }
      return null;
    }
  }
  return null;
}

/**
 * Merge-under-lock журнала (волна E, E3-2). Бут — не единственный писатель: ручной
 * фикс или второй процесс могли положить запись в окно между чтением на старте и
 * финальным персистом; снапшот поверх диска её затирал. Под лок-файлом перечитываем
 * диск и мёржим ПО МИНТАМ: наши записи свежее (выигрывают для своих минтов), чужие
 * минты переживают. Файл не читается/битый — пишем свой снапшот (как до раунда 14:
 * решение о preserve — на уровне persistJournalOnBoot). Лок не взялся (живой сосед
 * дольше staleMs держит, диск полон) — пишем без лока: не хуже статус-кво.
 * @param {string} journalPath
 * @param {object} journal — карта { mint: entry } этого процесса
 */
export function saveJournalMerged(journalPath, journal, { staleMs = 10_000, attempts = 700, retryPauseMs = 5, nowMs } = {}) {
  const lockPath = `${journalPath}.lock`;
  let fd = null;
  try {
    fd = acquireSyncLock(lockPath, { staleMs, attempts, retryPauseMs, ...(nowMs !== undefined ? { nowMs } : {}) });
  } catch {
    fd = null;
  }
  try {
    let merged = { ...journal };
    const existing = loadJournalOnchain(journalPath);
    if (existing.ok) {
      for (const [mint, entry] of Object.entries(existing.journal)) {
        if (!(mint in merged)) merged[mint] = entry;
      }
    }
    atomicWriteJson(journalPath, merged);
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* уже закрыт */
      }
      try {
        unlinkSync(lockPath);
      } catch {
        /* кто-то сломал протухший — ок */
      }
    }
  }
}
