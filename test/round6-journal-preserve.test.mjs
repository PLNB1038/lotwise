// Регрессионные тесты раунда 6 — находка LW2_journal_evidence_clobber_on_failed_preserve.
// Защитный механизм раунда 5 сам уничтожал улику в ветке отказа: preserveCorruptedJournal
// глотал ЛЮБУЮ ошибку renameSync (AV/индексер/EBUSY на Windows) и возвращал null,
// serve.mjs на null не ветвился — и финальный saveJournalAtomic переименовывал свежий
// журнал ПОВЕРХ повреждённого оригинала, стирая единственную копию истории.
// Контракт после фикса:
//   (1) preserve пытается rename несколько раз с разными именами, в крайнем случае
//       КОПИРУЕТ улику рядом (оригинал при этом остаётся, но копия уже вне окна записи);
//   (2) улики нет вовсе ⇒ бут в режиме read-only: финальной записи журнала не существует,
//       повреждённый оригинал гарантированно переживает бут до перезапуска;
//   (3) флаг читаем снаружи: createApiServer прокидывает journal.preserveFailed в /health.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  bootJournalOnchain,
  persistJournalOnBoot,
  preserveCorruptedJournal,
  saveJournalAtomic,
} from "../src/events/journal.mjs";
import { createApiServer } from "../src/api/server.mjs";

const freshDir = () => mkdtempSync(path.join(tmpdir(), "lotwise-r6-journal-"));
const torn = '{"Mint11111111111111111111111111111111":{"lastEff'; // усечённый после обрыва записи
const writeTorn = (p) => writeFileSync(p, torn);
const busy = () => {
  throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
};

// ---- bootJournalOnchain: загрузка + сохранение улики одной точкой ----

test("бут с повреждённым журналом: улика сохранена rename'ом — preserveFailed=false, оригинал ушёл в улику", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  writeTorn(p);
  const boot = bootJournalOnchain(p);
  assert.equal(boot.corrupted, true);
  assert.ok(boot.reason);
  assert.ok(boot.backup, "улика должна существовать");
  assert.match(path.basename(boot.backup), /\.corrupt-/);
  assert.equal(readFileSync(boot.backup, "utf8"), torn); // содержимое улики = повреждённый оригинал
  assert.equal(existsSync(p), false); // rename удался: оригинал переехал в улику
  assert.equal(boot.preserveFailed, false);
  // пустой журнал для бэкфилла — штатное продолжение бута
  assert.deepEqual(boot.journal, {});
});

test("здоровый журнал и его отсутствие — corrupted=false, preserve не стреляет", () => {
  const dir = freshDir();
  const ok = path.join(dir, "ok.json");
  saveJournalAtomic(ok, { Mint1: { lastEffective: "5", events: [] } });
  const bootOk = bootJournalOnchain(ok);
  assert.equal(bootOk.corrupted, false);
  assert.equal(bootOk.preserveFailed, false);
  assert.equal(bootOk.backup, null);
  assert.deepEqual(bootOk.journal, { Mint1: { lastEffective: "5", events: [] } });

  const bootFirst = bootJournalOnchain(path.join(dir, "нет-файла.json")); // первый запуск
  assert.equal(bootFirst.corrupted, false);
  assert.equal(bootFirst.backup, null);
});

// ---- ретраи и copy-фолбэк: усиление preserve против «временного» отказа rename ----

test("ретраи preserve зовут rename с РАЗНЫМИ именами; второй попытка успешна", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  writeTorn(p);
  const attempted = [];
  const flakyRename = (from, to) => {
    attempted.push(to);
    if (attempted.length < 2) busy(); // AV держал файл мгновение
    renameSync(from, to); // вторая попытка — настоящий переезд
  };
  const backup = preserveCorruptedJournal(p, { attempts: 3, rename: flakyRename });
  assert.equal(attempted.length, 2);
  assert.notEqual(attempted[0], attempted[1], "каждая попытка — своё имя улики");
  assert.equal(backup, attempted[1]);
  assert.equal(existsSync(p), false);
  assert.equal(readFileSync(backup, "utf8"), torn);
});

test("rename сорван, copy спасает улику — preserveFailed=false, оригинал остаётся, запись разрешена", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  writeTorn(p);
  const boot = bootJournalOnchain(p, { rename: busy });
  assert.ok(boot.backup, "улика должна быть спасена копированием");
  assert.equal(readFileSync(boot.backup, "utf8"), torn);
  assert.equal(existsSync(p), true); // оригинал на месте (rename не удался)…
  assert.equal(boot.preserveFailed, false); // …но улика уже вне окна записи
  // финальная запись разрешена: она может затереть только оригинал, улика цела
  const saved = persistJournalOnBoot(p, {}, { preserveFailed: boot.preserveFailed });
  assert.equal(saved.written, true);
  assert.equal(readFileSync(boot.backup, "utf8"), torn); // улика не пострадала от записи
});

// ---- ядро находки: улики нет ⇒ read-only, оригинал переживает бут ----

test("ни rename, ни copy не удались — preserveFailed=true, повреждённый оригинал ЦЕЛ на месте", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  writeTorn(p);
  const boot = bootJournalOnchain(p, { rename: busy, copy: busy });
  assert.equal(boot.backup, null);
  assert.equal(boot.preserveFailed, true);
  assert.equal(readFileSync(p, "utf8"), torn, "бут не имел права трогать единственную копию истории");
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
});

test("контракт serve-бута end-to-end: preserveFailed=true ⇒ финальной записи НЕ существует, оригинал переживает бут", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  writeTorn(p);
  // ровно последовательность serve.mjs: бут → (финальная запись c решением по preserveFailed)
  const boot = bootJournalOnchain(p, { rename: busy, copy: busy });
  const saved = persistJournalOnBoot(
    p,
    { Mint1: { lastEffective: "7", observedAt: "2026-09-20T00:00:00.000Z", events: [] } },
    { preserveFailed: boot.preserveFailed },
  );
  assert.equal(saved.readonly, true);
  assert.equal(saved.written, false);
  assert.equal(readFileSync(p, "utf8"), torn, "усечённая история должна была пережить бут — раньше её затирал saveJournalAtomic");
  assert.deepEqual(readdirSync(dir), ["onchain-journal.json"], "ни улики-обманки, ни tmp-мусора");
});

test("persistJournalOnBoot: обычный бут пишет атомарно; сорвавшаяся запись — written=false без read-only", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  const saved = persistJournalOnBoot(p, { Mint1: { lastEffective: "5", events: [] } });
  assert.equal(saved.written, true);
  assert.equal(saved.readonly, false);
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { Mint1: { lastEffective: "5", events: [] } });

  const doomed = path.join(dir, "нет-такой-папки", "j.json"); // недостижимая директория
  const failed = persistJournalOnBoot(doomed, {});
  assert.equal(failed.written, false);
  assert.equal(failed.readonly, false); // это не режим read-only, обычная ошибка записи
  assert.ok(failed.error instanceof Error);
});

// ---- контракт для витрины: preserveFailed читаем снаружи через /health ----

test("createApiServer: /health прокидывает journal.preserveFailed (баннер витрины по truthy)", async () => {
  const server = await createApiServer({
    registry: [],
    events: [],
    journalStats: { replayed: 0, unavailable: 0, corrupted: 1, preserveFailed: 1 },
  });
  const { port } = server.address();
  try {
    const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(h.journal.corrupted, 1);
    assert.equal(h.journal.preserveFailed, 1); // число 0|1, как journal.corrupted
    // здоровый журнал: оба флага честные нули
    const server2 = await createApiServer({
      registry: [],
      events: [],
      journalStats: { replayed: 3, unavailable: 0, corrupted: 0, preserveFailed: 0 },
    });
    try {
      const h2 = await (await fetch(`http://127.0.0.1:${server2.address().port}/health`)).json();
      assert.equal(h2.journal.preserveFailed, 0);
      assert.equal(h2.journal.corrupted, 0);
    } finally {
      server2.close();
    }
  } finally {
    server.close();
  }
});
