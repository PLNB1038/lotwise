// Общие гарантии файлов данных: атомарная запись и сохранение улики повреждённого
// файла (раунд 6). Выделено из журнала (saveJournalAtomic раунда 5) после находки
// LW2_tokens_json_write_non_atomic: тот же класс обрыва записи, что у журнала, у
// data/tokens.json ронял сервис ЦЕЛИКОМ — а писатели реестра (
// enrich-decimals) писали прямым writeFileSync поверх живого файла.
import {
  openSync, writeSync, closeSync, fsyncSync, renameSync, unlinkSync, copyFileSync,
} from "node:fs";
import { dirname, join, basename } from "node:path";

/**
 * Атомарная запись JSON: payload целиком уходит во временный файл в ТОЙ ЖЕ
 * директории (rename между устройствами не работает), fsync'ится и переименовывается
 * поверх целевого файла. Обрыв в любой момент оставляет на месте журнала/реестра
 * целую предыдущую версию; temp-файл при ЛЮБОМ отказе подчищается.
 * Раунд 7 (адверсариальные тесты журнала): сериализация — ДО создания temp. Раньше
 * JSON.stringify стоял после openSync(tmp), и несериализуемый payload (BigInt внутри)
 * бросал TypeError, оставляя после себя пустой .tmp рядом с целью: цель при этом
 * цела (мусор не доезжал до неё), но директория засорялась при каждом таком отказе.
 * Теперь бросок сериализации не создаёт ни одного файла, а отказ write/fsync/rename
 * после открытия temp подчищает его в catch — на диске не остаётся ни tmp, ни
 * изменений цели, ошибка пробрасывается как раньше.
 * @param {string} filePath — путь к файлу
 * @param {object|Array} value — сериализуемый payload
 */
export function atomicWriteJson(filePath, value) {
  const tmp = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.tmp`);
  // сериализация до openSync: бросок (BigInt/циклические ссылки) не оставляет файлов
  const data = JSON.stringify(value, null, 1) + "\n";
  const fd = openSync(tmp, "w");
  try {
    try {
      writeSync(fd, data);
      fsyncSync(fd); // данные на диске ДО rename: переименование не обгоняет запись
    } finally {
      closeSync(fd); // close до возможного unlink: на Windows открытый файл не удалить
    }
    renameSync(tmp, filePath);
  } catch (err) {
    // отказ write/fsync/rename ПОСЛЕ открытия temp: подчищаем, цель не тронута —
    // на диске не остаётся ни tmp, ни изменений (лучшее усилие: не затираем исходную ошибку)
    try { unlinkSync(tmp); } catch { /* уже удалён или залочен — исходная ошибка важнее */ }
    throw err;
  }
}

/**
 * Сохранить повреждённый файл как улику ПЕРЕД первой перезаписью: rename в
 * `<path>.corrupt-<timestamp>`; если rename сорван («временный» отказ: AV-сканер,
 * индексер, EBUSY на Windows) — попытки повторяются с другими именами, в крайнем
 * случае содержимое КОПИРУЕТСЯ рядом (оригинал при этом остаётся на месте).
 * @param {string} filePath — путь к повреждённому файлу
 * @param {{nowMs?: number, attempts?: number, rename?: Function, copy?: Function}} [opts]
 *   attempts — число попыток rename (по умолчанию 1); rename/copy — инъекция для тестов
 * @returns {string|null} путь к улике или null, если сохранить улику не удалось вовсе
 */
export function preserveCorruptedFile(filePath, { nowMs = Date.now(), attempts = 1, rename = renameSync, copy = copyFileSync } = {}) {
  const backupName = (i) => `${filePath}.corrupt-${new Date(nowMs + i).toISOString().replace(/[:.]/g, "-")}`;
  for (let i = 0; i < attempts; i++) {
    const backupPath = backupName(i);
    try {
      rename(filePath, backupPath);
      return backupPath;
    } catch { /* файл мог быть залочен мгновение — следующая попытка под другим именем */ }
  }
  // rename так и не удался: улику можно хотя бы скопировать (оригинал остаётся на месте)
  const backupPath = backupName(attempts - 1);
  try {
    copy(filePath, backupPath);
    return backupPath;
  } catch {
    return null;
  }
}
