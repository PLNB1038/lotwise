// Раунд 5, находка LW_journal_write_non_atomic: персистентность on-chain журнала.
// (а) сохранение атомарно (temp в той же директории + rename, без мусора и усечённых файлов);
// (б) битый файл журнала при загрузке — явное состояние «повреждён», а не тихий «пустой журнал».
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadJournalOnchain, saveJournalAtomic, preserveCorruptedJournal } from "../src/events/journal.mjs";

const JOURNAL = {
  Mint11111111111111111111111111111111: {
    lastEffective: "5",
    observedAt: "2026-09-19T03:50:00.000Z",
    events: [{
      type: "MULTIPLIER_CHANGE", multiplierFrom: "1", multiplierTo: "5",
      effectiveDate: "2026-06-10T04:30:00.000Z", status: "confirmed",
    }],
  },
};

const freshDir = () => mkdtempSync(path.join(tmpdir(), "lotwise-journal-"));

// ---- (а) атомарная запись ----

test("saveJournalAtomic: итоговый файл валиден, в директории не остаётся temp-мусора", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  saveJournalAtomic(p, JOURNAL);
  assert.deepEqual(readdirSync(dir), ["onchain-journal.json"]); // ровно один файл: temp ушёл в rename
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), JOURNAL);
});

test("saveJournalAtomic: перезапись живого журнала обновляет содержимое и снова без мусора", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  saveJournalAtomic(p, JOURNAL);
  const updated = {
    ...JOURNAL,
    Mint22222222222222222222222222222222: { lastEffective: "1", observedAt: "2026-09-20T00:00:00.000Z", events: [] },
  };
  saveJournalAtomic(p, updated);
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), updated);
  assert.deepEqual(readdirSync(dir), ["onchain-journal.json"]);
});

test("saveJournalAtomic: пустой журнал — тоже валидный JSON-объект", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  saveJournalAtomic(p, {});
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), {});
});

test("saveJournalAtomic: недостижимая директория — бросает, ничего не оставляет рядом", () => {
  const dir = freshDir();
  const p = path.join(dir, "нет-такой-папки", "journal.json");
  assert.throws(() => saveJournalAtomic(p, JOURNAL));
  assert.deepEqual(readdirSync(dir), []);
});

test("loadJournalOnchain после saveJournalAtomic: roundtrip без потерь", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  saveJournalAtomic(p, JOURNAL);
  const r = loadJournalOnchain(p);
  assert.equal(r.ok, true);
  assert.equal(r.corrupted, false);
  assert.deepEqual(r.journal, JOURNAL);
});

// ---- (б) битый файл ≠ тихий пустой журнал ----

test("loadJournalOnchain: файла нет — честный первый запуск (ok, corrupted=false)", () => {
  const dir = freshDir();
  const r = loadJournalOnchain(path.join(dir, "onchain-journal.json"));
  assert.equal(r.ok, true);
  assert.equal(r.corrupted, false);
  assert.deepEqual(r.journal, {});
});

test("loadJournalOnchain: усечённый JSON (обрыв записи) — повреждён, НЕ маскируется под первый запуск", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  const raw = JSON.stringify(JOURNAL, null, 1);
  writeFileSync(p, raw.slice(0, Math.floor(raw.length / 2))); // как после kill -9 в момент writeFileSync
  const r = loadJournalOnchain(p);
  assert.equal(r.ok, false);
  assert.equal(r.corrupted, true);
  assert.deepEqual(r.journal, {});
  assert.match(r.reason, /JSON/i);
});

test("loadJournalOnchain: мусор вместо JSON — повреждён", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  writeFileSync(p, "\x00это вообще не json{{{");
  const r = loadJournalOnchain(p);
  assert.equal(r.ok, false);
  assert.equal(r.corrupted, true);
  assert.deepEqual(r.journal, {});
});

test("loadJournalOnchain: валидный JSON, но не объект (число/массив/null/строка) — повреждён", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  for (const bad of ["5", "[1,2]", "null", '"str"']) {
    writeFileSync(p, bad);
    const r = loadJournalOnchain(p);
    assert.equal(r.corrupted, true, `должен быть повреждён: ${bad}`);
    assert.equal(r.ok, false, `должен быть отказ: ${bad}`);
    assert.deepEqual(r.journal, {});
  }
});

test("loadJournalOnchain: файл нечитается (на его месте директория) — повреждён, не тихий первый запуск", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  mkdirSync(p);
  const r = loadJournalOnchain(p);
  assert.equal(r.ok, false);
  assert.equal(r.corrupted, true);
  assert.deepEqual(r.journal, {});
});

// ---- улика: повреждённый файл переживает первую перезапись ----

test("preserveCorruptedJournal: битый файл переименован в .corrupt-*, на месте не остался", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  writeFileSync(p, "{\"Mint1\": {\"lastEff"); // усечённый
  const backup = preserveCorruptedJournal(p);
  assert.ok(backup, "должен вернуть путь к улике");
  assert.match(path.basename(backup), /\.corrupt-/);
  assert.equal(existsSync(p), false);
  assert.equal(readFileSync(backup, "utf8"), "{\"Mint1\": {\"lastEff");
});

test("preserveCorruptedJournal: переименовать не удалось — честный null, не выдуманный путь", () => {
  const r = preserveCorruptedJournal(path.join(freshDir(), "нет-такого-файла.json"));
  assert.equal(r, null);
});

// ---- интеграция сценария serve.mjs: обрыв → повреждён → бут с пустым → атомарная запись, улика цела ----

test("сценарий обрыва: новая запись не затирает повреждённый файл, история остаётся в улике", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  const torn = JSON.stringify(JOURNAL, null, 1).slice(0, 40);
  writeFileSync(p, torn);

  const loaded = loadJournalOnchain(p); // шаг 1: загрузка видит повреждение
  assert.equal(loaded.corrupted, true);
  const backup = preserveCorruptedJournal(p); // шаг 2: улика сохранена
  assert.ok(backup);

  saveJournalAtomic(p, {}); // шаг 3: сервер продолжает бут, пишет свежий журнал атомарно
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), {});
  assert.equal(readFileSync(backup, "utf8"), torn); // повреждённая история не потеряна
});
