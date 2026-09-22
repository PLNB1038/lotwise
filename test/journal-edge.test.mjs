// Адверсариальные границы on-chain журнала (раунд 7): запись/дедуп/конфликты,
// чтение/повреждения, восстановление/degraded-бот. Границы раундов 5–6 расширены
// (пустой файл, BOM, массив-payload, BigInt, мусорные поля записи). Пинится
// ФАКТИЧЕСКОЕ поведение; метка «GAP:» — зафиксированный контракт в месте,
// где текущее поведение оказалось дыркой. Раунд 7 нашёл две дыры, и обе
// ПОЧИНЕНЫ в src — соответствующие GAP-пины переписаны под правильное
// поведение (пин фиксировал баг, это осознанно):
//   (1) events-не-массив трактуется как повреждение записи (src/events/journal.mjs):
//       дубликат из бэкфилла не переизлучается, громкий console.error оператору,
//       восстановление с нуля по факту цепи;
//   (2) несериализуемый payload больше не оставляет пустой .tmp (src/fs/atomic.mjs):
//       сериализация до создания temp, подчистка при любом отказе после открытия.
import test from "node:test";
import assert from "node:assert/strict";
import {
  planJournalStep,
  saveJournalAtomic,
  loadJournalOnchain,
  preserveCorruptedJournal,
  bootJournalOnchain,
  persistJournalOnBoot,
} from "../src/events/journal.mjs";
import { MultiplierTimeline } from "../src/lots/timeline.mjs";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const MINT2 = "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp";
const FOREIGN = "Foreign1111111111111111111111111111111111111";
const token = { mint: MINT, symbol: "TESTx" };
const token2 = { mint: MINT2, symbol: "OTHERx" };
const NOW = Date.parse("2026-09-19T00:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

// состояние минта на цепи: active/pending + дата активации pending
const parsedOf = (active, pending, date) => ({
  hasExtension: true, decimals: 8,
  activeMultiplier: active,
  pendingMultiplier: pending,
  pendingEffectiveDate: date,
  authority: null,
});
// первое наблюдение SPACEX-паттерна: pending 5 от 10.06 уже в силе → бэкфилл 1→5
const BASE = parsedOf("1", "5", "2026-06-10T04:30:00.000Z");
const ROT7 = parsedOf("5", "7", "2026-09-15T00:00:00.000Z");

const freshDir = () => mkdtempSync(path.join(tmpdir(), "lotwise-journal-edge-"));
const busy = () => {
  throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
};

// ===========================================================================
// Группа 1. Запись: конфликты, дедуп, битые полезные нагрузки
// ===========================================================================

test("конфликт ротаций (эмитент перехлопал 7→6): журнал линеен, побеждает последнее наблюдение, история не переписывается", () => {
  const boot1 = planJournalStep(token, null, BASE, NOW); // 1→5
  const boot2 = planJournalStep(token, boot1.entry, ROT7, NOW + 60_000); // 5→7
  const corrected = parsedOf("5", "6", "2026-09-18T00:00:00.000Z");
  const boot3 = planJournalStep(token, boot2.entry, corrected, NOW + 120_000); // 7→6

  assert.ok(boot3.event);
  assert.equal(boot3.event.multiplierFrom, "7");
  assert.equal(boot3.event.multiplierTo, "6");
  assert.equal(boot3.entry.events.length, 3, "события дописываются в хвост, задним числом ничего не правится");
  assert.deepEqual(boot3.entry.events[0], boot1.entry.events[0], "первое событие не тронуто");
  const tl = new MultiplierTimeline(boot3.entry.events);
  assert.equal(tl.multiplierAt("2026-09-19"), "6", "таймлайн от линейного журнала валиден: последнее наблюдение — истина");
});

test("промежуточная ротация пропущена между наблюдениями: событие 5→8, шаг 7 невосстановим (задокументированное ограничение)", () => {
  const boot1 = planJournalStep(token, null, BASE, NOW); // 1→5
  const jumped = parsedOf("5", "8", "2026-09-17T00:00:00.000Z"); // цепь перескочила 5→8, 7 между наблюдениями
  const boot2 = planJournalStep(token, boot1.entry, jumped, NOW + 60_000);
  assert.ok(boot2.event);
  assert.equal(boot2.event.multiplierFrom, "5");
  assert.equal(boot2.event.multiplierTo, "8", "дифф от последнего ЗАФИКСИРОВАННОГО значения — один шаг, не два выдуманных");
  assert.equal(boot2.entry.events.length, 2);
  // журнал при этом остаётся валидной цепочкой для таймлайна
  const tl = new MultiplierTimeline(boot2.entry.events);
  assert.equal(tl.multiplierAt("2026-09-18"), "8");
});

test("ротация без pendingEffectiveDate — событие датировано моментом наблюдения (nowIso), не выдуманной датой", () => {
  const prior = { lastEffective: "1", observedAt: "2026-09-01T00:00:00.000Z", events: [] };
  const activeOnly = parsedOf("5", null, null); // pending уже снят, видим только новый active
  const { event } = planJournalStep(token, prior, activeOnly, NOW);
  assert.ok(event);
  assert.equal(event.effectiveDate, iso(NOW), "даты нет в цепи — честный now, не null и не мусор");
  assert.equal(event.multiplierFrom, "1");
  assert.equal(event.multiplierTo, "5");
});

test("parsed-мусор {} при первом наблюдении: entry без lastEffective уезжает на диск, восстановление глотает ротацию (GAP)", () => {
  // GAP: битый payload цепи ({} вместо parsed) даёт entry с lastEffective:undefined;
  // JSON выкидывает поле, запись выглядит как v2 (events:[]) — недоступная цепь и
  // unavailableV1 эту дыру не видят, а следующая ротация поглощается молча.
  const s1 = planJournalStep(token, null, {}, NOW);
  assert.equal(s1.event, null);
  assert.equal(s1.chain, "ok");
  assert.equal(s1.entry.lastEffective, undefined, "факт: lastEffective undefined (в памяти ключ есть, JSON его выкинет)");

  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  saveJournalAtomic(p, { [MINT]: s1.entry });
  const loaded = loadJournalOnchain(p);
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.journal[MINT], { observedAt: iso(NOW), events: [] }, "на диске запись без lastEffective, но «здоровая» по форме");

  const s2 = planJournalStep(token, loaded.journal[MINT], BASE, NOW + 60_000);
  assert.equal(s2.event, null, "ротация 1→5 поглощена без события (разрыв цепочки от '1')");
  assert.equal(s2.entry.lastEffective, "5", "lastEffective хотя бы скорректирован фактом");
  assert.deepEqual(s2.entry.events, []);
  // warn-условие serve.mjs честно стреляет на такой записи
  assert.ok(s2.entry.lastEffective !== "1" && s2.entry.events.length === 0);
});

test("planJournalStep: events не массив (битое поле записи) — дубль из бэкфилла НЕ переизлучен, warn оператору был, последующая запись корректна (GAP переписан: раньше история тихо сбрасывалась и дубликат переизлучался)", (t) => {
  // Раунд 7, починено в src/events/journal.mjs: запись с events-не-массивом —
  // повреждённая, а не «первое наблюдение». Реплей пуст (недоверенная история),
  // дубликат 1→5 задавлен, оператору громкий console.error с уликой, запись
  // восстанавливается с нуля: lastEffective от факта цепи, events честно пусты.
  const errLog = t.mock.method(console, "error", () => {});
  const prior = { lastEffective: "5", observedAt: "2026-09-01T00:00:00.000Z", events: "1→5 (мусор вместо массива)" };
  const step = planJournalStep(token, prior, BASE, NOW);
  assert.equal(errLog.mock.callCount(), 1, "повреждение не молчит: громкий console.error");
  const shouted = String(errLog.mock.calls[0].arguments[0]);
  assert.match(shouted, /ПОВРЕЖДЕНА/);
  assert.match(shouted, /мусор вместо массива/, "улика — битая запись целиком — уходит оператору в лог");
  assert.equal(step.corrupted, true, "минт помечен повреждённым");
  assert.deepEqual(step.replay, [], "недоверенная история не подмешивается в реплей");
  assert.equal(step.event, null, "дубль 1→5 из бэкфилла НЕ переизлучается");
  assert.deepEqual(step.entry.events, [], "восстановление с нуля: события честно пусты, не выдуманы");
  assert.equal(step.entry.lastEffective, "5", "lastEffective зафиксирован от факта цепи");

  // последующая запись корректна: свежая запись живёт по штатной mid-history семантике
  const next = planJournalStep(token, step.entry, ROT7, NOW + 60_000);
  assert.equal(next.corrupted, false);
  assert.equal(next.event, null, "5→7 не продолжает цепь от \"1\" — событие не выдумывается (как у любого mid-history)");
  assert.equal(next.entry.lastEffective, "7");
  assert.deepEqual(next.entry.events, []);
});

test("planJournalStep: events не массив + цепь недоступна — entry null, битая улика на диске не трогается, warn был (пин деградации переписан под fail-closed)", (t) => {
  const errLog = t.mock.method(console, "error", () => {});
  const prior = { lastEffective: "5", observedAt: "2026-09-01T00:00:00.000Z", events: 42 };
  const down = planJournalStep(token, prior, null, NOW + 60_000);
  assert.equal(errLog.mock.callCount(), 1, "повреждение громко даже при лежащей цепи");
  assert.equal(down.chain, "unavailable");
  assert.equal(down.corrupted, true);
  assert.equal(down.entry, null, "заменить битую запись нечем — на диске она не трогается до восстановления по факту цепи");
  assert.deepEqual(down.replay, []);
  assert.equal(down.event, null);
});

test("parsed=null при первом буте (цепь лежит, журнала нет): entry null — файл не создаётся; восстановление даёт полный бэкфилл", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  const down = planJournalStep(token, null, null, NOW);
  assert.equal(down.chain, "unavailable");
  assert.equal(down.entry, null, "записывать нечего: история не начата");
  assert.equal(down.event, null);
  assert.deepEqual(down.replay, []);
  // факт: при priorEntry=null флаг вычисляется как null (falsy-квирк выражения
  // base === null && priorEntry && …), а не false — все потребители проверяют
  // truthiness, так что warn не стреляет, но пиним фактическое значение
  assert.equal(down.unavailableV1, null);

  persistJournalOnBoot(p, {}, { preserveFailed: false }); // serve пишет пустой журнал
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), {});
  // восстановление при живой цепи: обычное первое наблюдение с полным бэкфиллом
  const ok = planJournalStep(token, undefined, BASE, NOW + 60_000);
  assert.ok(ok.event);
  assert.equal(ok.event.multiplierTo, "5");
  assert.equal(ok.chain, "ok");
});

test("изоляция минтов: ротация минта A не переписывает entry минта B — карта журнала независима по ключам", () => {
  const stepA = planJournalStep(token, null, BASE, NOW); // 1→5
  const quiet = parsedOf("1", null, null); // у B всё спокойно, актив 1
  const stepB = planJournalStep(token2, null, quiet, NOW);
  assert.equal(stepB.event, null);
  assert.equal(stepB.entry.lastEffective, "1");

  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  const journal = { [MINT]: stepA.entry, [MINT2]: stepB.entry };
  saveJournalAtomic(p, journal);
  const loaded = loadJournalOnchain(p);
  assert.deepEqual(loaded.journal[MINT2], stepB.entry, "B не задет ротацией A");
  // следующая ротация A: B не меняется вовсе
  const next = planJournalStep(token, loaded.journal[MINT], ROT7, NOW + 60_000);
  assert.ok(next.event);
  assert.equal(next.event.multiplierFrom, "5");
  const againB = planJournalStep(token2, loaded.journal[MINT2], quiet, NOW + 60_000);
  assert.equal(againB.event, null);
  assert.equal(againB.entry.lastEffective, "1");
  assert.deepEqual(againB.entry.events, []);
});

// ===========================================================================
// Группа 2. Чтение/персистентность: границы повреждений (расширение раундов 5–6)
// ===========================================================================

test("loadJournalOnchain: пустой файл (0 байт) — повреждён, не «первый запуск»; улика сохраняет пустоту", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  writeFileSync(p, ""); // обрыв ДО первой записи байтов
  const r = loadJournalOnchain(p);
  assert.equal(r.ok, false);
  assert.equal(r.corrupted, true);
  assert.match(r.reason, /JSON/i);
  const backup = preserveCorruptedJournal(p);
  assert.ok(backup);
  assert.equal(readFileSync(backup, "utf8"), "", "улика честно пустая: факт повреждения не переписан");
  assert.equal(existsSync(p), false);
});

test("loadJournalOnchain: BOM перед JSON — повреждён (не молча обрезан); без BOM тот же объект читается", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  writeFileSync(p, "\uFEFF{\"M\":{}}");
  const r = loadJournalOnchain(p);
  assert.equal(r.ok, false);
  assert.equal(r.corrupted, true);
  assert.match(r.reason, /JSON/i);
  writeFileSync(p, "{\"M\":{}}");
  const ok = loadJournalOnchain(p);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.journal, { M: {} });
});

test("loadJournalOnchain: валидный объект с мусорными значениями — загружен как есть (валидация глубины — слой перехода)", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  const journal = {
    [MINT]: "строка вместо entry",
    [MINT2]: { lastEffective: 5, events: null }, // не те типы полей
  };
  saveJournalAtomic(p, journal);
  const r = loadJournalOnchain(p);
  assert.equal(r.ok, true, "верхний уровень {mint: …} валиден — глубину читатель не проверяет");
  assert.equal(r.corrupted, false);
  assert.deepEqual(r.journal, journal);
});

test("журнал с минтом вне реестра — загружается и бутится целиком: слой журнала реестра не знает", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  const journal = {
    [FOREIGN]: { lastEffective: "9", observedAt: "2026-09-01T00:00:00.000Z", events: [] },
    [MINT]: { lastEffective: "5", observedAt: "2026-09-02T00:00:00.000Z", events: [] },
  };
  saveJournalAtomic(p, journal);
  const boot = bootJournalOnchain(p);
  assert.equal(boot.corrupted, false);
  assert.deepEqual(Object.keys(boot.journal).sort(), [FOREIGN, MINT].sort(),
    "чужой минт доезжает: фильтрацию по реестру делает serve при реплее, не загрузчик");
});

test("saveJournalAtomic: массив-payload пишется без проверки, но читатель честно помечает corrupted (асимметрия писатель/читатель)", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  saveJournalAtomic(p, [{ mint: MINT }]); // писатель принимает любой JSON
  const r = loadJournalOnchain(p);
  assert.equal(r.ok, false);
  assert.equal(r.corrupted, true);
  assert.match(r.reason, /array/, "читатель знает форму: журнал обязан быть объектом {mint: entry}");
  assert.deepEqual(r.journal, {});
});

test("atomicWriteJson: несериализуемый payload (BigInt) — исключение проброшено, tmp-файлов в директории ноль, цель байт-в-байт прежняя (GAP переписан: раньше пустой .tmp оставался)", () => {
  // Раунд 7, починено в src/fs/atomic.mjs: сериализация теперь ДО создания temp,
  // так что бросок JSON.stringify не создаёт ни одного файла; при отказе write/
  // fsync/rename после открытия temp последний подчищается в catch.
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  saveJournalAtomic(p, { [MINT]: { lastEffective: "5", events: [] } });
  const before = readFileSync(p, "utf8");
  assert.throws(() => saveJournalAtomic(p, { [MINT]: { qty: 1n } }), TypeError);
  assert.equal(readFileSync(p, "utf8"), before, "цель байт-в-байт прежняя: старая версия пережила отказ");
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.endsWith(".tmp")),
    [],
    "temp-мусора ноль: сериализация падает до создания файла",
  );
});

// ===========================================================================
// Группа 3. Восстановление/бот: degraded-режим с журналом и без
// ===========================================================================

test("бут на пустом файле: rename и copy оба спасают пустую улику, запись после — штатная", () => {
  // вариант 1: rename удался — оригинал ушёл в пустую улику, бут пишет свежий журнал
  const dir1 = freshDir();
  const p1 = path.join(dir1, "onchain-journal.json");
  writeFileSync(p1, "");
  const boot1 = bootJournalOnchain(p1);
  assert.equal(boot1.corrupted, true);
  assert.equal(boot1.preserveFailed, false);
  assert.equal(readFileSync(boot1.backup, "utf8"), "");
  assert.equal(existsSync(p1), false);
  const saved = persistJournalOnBoot(p1, { [MINT]: { lastEffective: "5", observedAt: iso(NOW), events: [] } });
  assert.equal(saved.written, true);

  // вариант 2: rename сорван (EBUSY) — copy спасает пустую улику, оригинал остаётся
  const dir2 = freshDir();
  const p2 = path.join(dir2, "onchain-journal.json");
  writeFileSync(p2, "");
  const boot2 = bootJournalOnchain(p2, { rename: busy });
  assert.ok(boot2.backup);
  assert.equal(readFileSync(boot2.backup, "utf8"), "");
  assert.equal(existsSync(p2), true);
  assert.equal(boot2.preserveFailed, false);
});

test("degraded-бот с журналом (цепь лежит): в файл уходит ТА ЖЕ запись — observedAt честно протух, не соврёт «наблюдали сейчас»", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");
  const boot1 = planJournalStep(token, null, BASE, NOW); // 1→5, observedAt = NOW
  const down = planJournalStep(token, boot1.entry, null, NOW + 60_000);
  assert.equal(down.chain, "unavailable");
  assert.equal(down.entry, boot1.entry, "та же ссылка: запись не пересобирается");

  const saved = persistJournalOnBoot(p, { [MINT]: down.entry });
  assert.equal(saved.written, true);
  const loaded = loadJournalOnchain(p);
  assert.equal(loaded.journal[MINT].observedAt, iso(NOW),
    "на диске старый observedAt: при недоступной цепи время наблюдения не выдумывается");
  assert.equal(loaded.journal[MINT].events.length, 1, "события переживают деградацию");
});

test("degrade→restore на диске: недоступная цепь не откатывает events, после восстановления цепочка растёт монотонно", () => {
  const dir = freshDir();
  const p = path.join(dir, "onchain-journal.json");

  // шаг 1: живая цепь — 1→5, запись на диск
  const boot1 = planJournalStep(token, null, BASE, NOW);
  persistJournalOnBoot(p, { [MINT]: boot1.entry });

  // шаг 2: цепь легла — запись тем же состоянием (реплей без событий)
  const down = planJournalStep(token, boot1.entry, null, NOW + 60_000);
  persistJournalOnBoot(p, { [MINT]: down.entry });
  let loaded = loadJournalOnchain(p);
  assert.equal(loaded.journal[MINT].events.length, 1, "деградация не потеряла и не удвоила событие");

  // шаг 3: цепь ожила с ротацией — событие 5→7 дописано, журнал монотонен
  const restore = planJournalStep(token, loaded.journal[MINT], ROT7, NOW + 120_000);
  assert.ok(restore.event);
  assert.equal(restore.replay.length, 1, "реплей прошлой сессии подмешан до перехода");
  persistJournalOnBoot(p, { [MINT]: restore.entry });
  loaded = loadJournalOnchain(p);
  assert.equal(loaded.journal[MINT].events.length, 2);
  const tl = new MultiplierTimeline(loaded.journal[MINT].events);
  assert.equal(tl.multiplierAt("2026-09-16"), "7", "восстановленный журнал — валидная цепочка для таймлайна");
});
