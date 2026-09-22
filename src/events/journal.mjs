// Шаг синхронизации on-chain журнала — чистая функция над (запись журнала, план цепи).
// Выделена из serve.mjs ради тестируемости P0-инварианта: события журнала переживают
// рестарт процесса. parsed === null — цепь недоступна: реплеем кэш прошлых событий,
// запись журнала не трогаем (observedAt остаётся честно протухшим).
import { journalTransition } from "./normalize-onchain.mjs";
import { readFileSync } from "node:fs";
import { parseIsoDateMs } from "../schema/isodate.mjs";
import { atomicWriteJson, preserveCorruptedFile } from "../fs/atomic.mjs";

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
  if (priorIsObject && priorEntry.events !== undefined && !Array.isArray(priorEntry.events)) {
    console.error(
      `[journal] ${token.symbol ?? token.mint}: запись журнала ПОВРЕЖДЕНА — events не массив ` +
      `(тип ${priorEntry.events === null ? "null" : typeof priorEntry.events}), история недоверена. Улика: ${JSON.stringify(priorEntry)}. ` +
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
  // так задеплоенный инстанс самовосстанавливается без ручной миграции файла
  const base = priorIsObject && Array.isArray(priorEntry.events) ? priorEntry : null;
  const replay = base ? base.events : [];
  if (parsed === null) {
    const unavailableV1 = base === null && priorEntry && priorEntry.lastEffective !== "1";
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
    saveJournalAtomic(journalPath, journal);
    return { written: true, readonly: false, error: null };
  } catch (err) {
    return { written: false, readonly: false, error: err };
  }
}
