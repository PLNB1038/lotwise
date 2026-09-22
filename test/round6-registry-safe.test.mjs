// Регрессионные тесты раунда 6 — находка LW2_tokens_json_write_non_atomic
// (тяжелейшая находка дня): усечённый data/tokens.json ронял сервис ЦЕЛИКОМ —
// loadRegistry на top-level serve.mjs без catch бросал RegistryError → unhandled
// rejection, без деградированного режима и без диагностики класса «повреждён»
// (в отличие от журнала). Плюс оба писателя tokens.json (build-registry,
// enrich-decimals) писали неатомарно, а enrich-decimals перезаписывал файл даже
// при filled=0 — каждая прогулка скрипта повторяла окно обрыва без причины.
// Контракт:
//   (1) loadRegistrySafe — бут с деградацией: повреждение ≠ смерть процесса, улика
//       сохраняется рядом (паттерн журнала), пустой реестр, corrupted-флаг наружу;
//   (2) atomicWriteJson — tmp в той же директории + fsync + rename (на диске всегда
//       целая версия: старая или новая);
//   (3) enrichDecimalsFile — filled=0 ⇒ файл не перезаписывается вовсе.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadRegistrySafe } from "../src/registry/registry.mjs";
import { atomicWriteJson } from "../src/fs/atomic.mjs";
import { enrichDecimalsFile } from "../src/registry/enrich.mjs";

const freshDir = () => mkdtempSync(path.join(tmpdir(), "lotwise-r6-registry-"));
const busy = () => {
  throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
};
const TOKEN = {
  mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", // SPYx, валидный base58
  symbol: "SPYx",
  name: "SPDR S&P 500 Tokenized",
  issuer: "backed",
  decimals: null,
};
const fullJson = (list) => JSON.stringify(list, null, 1) + "\n";

// ---- (1) loadRegistrySafe: повреждение ≠ смерть процесса ----

test("loadRegistrySafe: валидный реестр — ok, corrupted=false, список на месте", async () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  writeFileSync(p, fullJson([TOKEN]));
  const r = await loadRegistrySafe(p);
  assert.equal(r.ok, true);
  assert.equal(r.corrupted, false);
  assert.equal(r.backup, null);
  assert.deepEqual(r.registry, [TOKEN]);
});

test("loadRegistrySafe: усечённый JSON (обрыв записи) — corrupted=1, пустой реестр, улика рядом", async () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  const torn = fullJson([TOKEN]).slice(0, 40); // как после kill в окне writeFileSync
  writeFileSync(p, torn);
  const r = await loadRegistrySafe(p);
  assert.equal(r.ok, false);
  assert.equal(r.corrupted, true, "повреждение — явное состояние, а не смерть процесса");
  assert.deepEqual(r.registry, []); // бут продолжается на пустом реестре
  assert.match(r.reason, /JSON/i);
  assert.ok(r.backup, "улика сохранена рядом");
  assert.equal(readFileSync(r.backup, "utf8"), torn);
  assert.equal(existsSync(p), false); // оригинал переименован в улику
  assert.equal(r.preserveFailed, false);
});

test("loadRegistrySafe: валидный JSON, но не массив — corrupted=1 + улика", async () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  writeFileSync(p, '{"mint": "x"}');
  const r = await loadRegistrySafe(p);
  assert.equal(r.corrupted, true);
  assert.deepEqual(r.registry, []);
  assert.ok(r.backup);
});

test("loadRegistrySafe: пустой массив — corrupted=1 + улика (это не валидный реестр)", async () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  writeFileSync(p, "[]");
  const r = await loadRegistrySafe(p);
  assert.equal(r.corrupted, true);
  assert.deepEqual(r.registry, []);
  assert.ok(r.backup);
});

test("loadRegistrySafe: запись с кривым минтом — corrupted=1 + улика (контентные ошибки тоже улика)", async () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  writeFileSync(p, fullJson([{ ...TOKEN, mint: "не-минт" }]));
  const r = await loadRegistrySafe(p);
  assert.equal(r.corrupted, true);
  assert.deepEqual(r.registry, []);
  assert.ok(r.backup);
  assert.match(r.reason, /base58/);
});

test("loadRegistrySafe: файла нет — corrupted=false (не повреждение: реестр просто не собран)", async () => {
  const r = await loadRegistrySafe(path.join(freshDir(), "нет-файла.json"));
  assert.equal(r.ok, false);
  assert.equal(r.corrupted, false, "ENOENT не имеет права маскироваться под «повреждён»");
  assert.deepEqual(r.registry, []);
  assert.equal(r.backup, null);
});

test("loadRegistrySafe: rename сорван — улика скопирована, оригинал на месте, preserveFailed=false", async () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  const torn = fullJson([TOKEN]).slice(0, 30);
  writeFileSync(p, torn);
  const r = await loadRegistrySafe(p, { rename: busy });
  assert.equal(r.corrupted, true);
  assert.ok(r.backup, "copy-фолбэк обязан спасти улику");
  assert.equal(readFileSync(r.backup, "utf8"), torn);
  assert.equal(existsSync(p), true); // оригинал не тронут (и не будет: serve tokens.json не пишет)
  assert.equal(r.preserveFailed, false);
});

test("loadRegistrySafe: ни rename, ни copy не удались — preserveFailed=true, реестр всё равно пустой, а не смерть", async () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  writeFileSync(p, "{");
  const r = await loadRegistrySafe(p, { rename: busy, copy: busy });
  assert.equal(r.corrupted, true);
  assert.equal(r.backup, null);
  assert.equal(r.preserveFailed, true);
  assert.deepEqual(r.registry, []);
});

// ---- (2) atomicWriteJson: обрыв записи оставляет целую версию ----

test("atomicWriteJson: запись и перезапись — валидный JSON, tmp-мусора в директории нет", () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  atomicWriteJson(p, [TOKEN]);
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), [TOKEN]);
  atomicWriteJson(p, [TOKEN, { ...TOKEN, symbol: "NVDAx", mint: "9BB7Tt5uW5QbAorLkF3Hn1P2mGcXvcDdR7y8LbT9KdUu" }]);
  assert.equal(JSON.parse(readFileSync(p, "utf8")).length, 2);
  assert.deepEqual(readdirSync(dir), ["tokens.json"]); // ровно один файл: temp ушёл в rename
});

test("atomicWriteJson: недостижимая директория — бросает, мусора рядом нет", () => {
  const dir = freshDir();
  const p = path.join(dir, "нет-такой-папки", "tokens.json");
  assert.throws(() => atomicWriteJson(p, [TOKEN]));
  assert.deepEqual(readdirSync(dir), []);
});

test("atomicWriteJson: формат совместим с loadRegistrySafe (roundtrip через файл)", async () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  atomicWriteJson(p, [TOKEN]);
  const r = await loadRegistrySafe(p);
  assert.equal(r.ok, true);
  assert.deepEqual(r.registry, [TOKEN]);
});

// ---- (3) enrichDecimalsFile: filled=0 ⇒ файла не касаемся ----

test("enrichDecimalsFile: filled=0 — файл НЕ перезаписывается (read-only файл не бросает: записи не было)", () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  const original = fullJson([{ ...TOKEN, decimals: 6 }]); // decimals уже заполнены
  writeFileSync(p, original);
  chmodSync(p, 0o444); // старый скрипт перезаписывал безусловно и падал бы EPERM
  try {
    const r = enrichDecimalsFile(p, { [TOKEN.mint]: { decimals: 8 } }); // заполнять нечего
    assert.equal(r.filled, 0);
    assert.equal(r.written, false, "нечего писать — окно обрыва не открывается вовсе");
    assert.deepEqual(r.unknown, []);
  } finally {
    chmodSync(p, 0o644);
  }
  assert.equal(readFileSync(p, "utf8"), original); // байт в байт
});

test("enrichDecimalsFile: Jupiter не знает минты — filled=0, unknown собран, файл не тронут", () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  writeFileSync(p, fullJson([TOKEN]));
  const before = readFileSync(p, "utf8");
  const r = enrichDecimalsFile(p, {}); // пустой ответ: нечего ни заполнять, ни писать
  assert.equal(r.filled, 0);
  assert.deepEqual(r.unknown, ["SPYx"]);
  assert.equal(r.written, false);
  assert.equal(readFileSync(p, "utf8"), before);
});

test("enrichDecimalsFile: filled>0 — decimals вписаны, запись атомарна, без tmp-мусора", () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  writeFileSync(p, fullJson([TOKEN, { ...TOKEN, symbol: "NVDAx", mint: "9BB7Tt5uW5QbAorLkF3Hn1P2mGcXvcDdR7y8LbT9KdUu" }]));
  const r = enrichDecimalsFile(p, {
    [TOKEN.mint]: { decimals: 8 },
    // NVDAx Jupiter не знает: decimals остаются null
  });
  assert.equal(r.filled, 1);
  assert.equal(r.written, true);
  assert.deepEqual(r.unknown, ["NVDAx"]);
  const list = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(list[0].decimals, 8);
  assert.equal(list[0].sourceDecimals, "jupiter");
  assert.equal(list[1].decimals, null); // не заполненные не тронуты
  assert.deepEqual(readdirSync(dir), ["tokens.json"]);
});

test("enrichDecimalsFile: уже заполненные decimals не перезатираются (заполняется только null)", () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  writeFileSync(p, fullJson([{ ...TOKEN, decimals: 6, sourceDecimals: "hand" }]));
  enrichDecimalsFile(p, { [TOKEN.mint]: { decimals: 8 } });
  const list = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(list[0].decimals, 6);
  assert.equal(list[0].sourceDecimals, "hand");
});
