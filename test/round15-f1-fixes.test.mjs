// Раунд 15 — фиксы атаки диффа (волна F1):
//   F1-1 [P2] enrich: «?? дефолт» съедал null ошибки флага — скрипт печатал отказ
//        и ПОТОМ шёл в сеть/переписывал реестр. Теперь: битый флаг = exit 2 ДО любого
//        I/O (0 запросов, файл не тронут).
//   F1-2 [P3] enrich: equals-форма --registry=<путь> молча игнорировалась —
//        обогащался дефолтный файл (повтор ROUND7 №10a). Теперь грамматика = serve.
//   F1-3 [P3] лок журнала: pid-живость (семантика R9 №9 из вебхук-лока) — живой
//        застрявший владелец НЕ ломается по mtime; мёртвый pid ломается сразу.
//   F1-4 [P3] будущий mtime лока (перекос часов) — ломка сразу, без 10с ожидания.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { saveJournalMerged } from "../src/events/journal.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";

const tmp = (name) => mkdtempSync(path.join(tmpdir(), name));
const runCli = (args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(ROOT, "scripts", "enrich-decimals.mjs"), ...args]);
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { out += c; });
  child.on("close", (code) => resolve({ code, out }));
});

// ---- F1-1: битый флаг = отказ ДО любого I/O ----

test("cli: enrich --registry без значения — exit 2, НОЛЬ запросов к API, файл не тронут", async () => {
  let hits = 0;
  const api = http.createServer((req, res) => { hits++; res.writeHead(400); res.end(); });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  const dir = tmp("lw-f1a-");
  try {
    const reg = path.join(dir, "reg.json");
    writeFileSync(reg, JSON.stringify([{ mint: MINT, symbol: "SPYx", decimals: null }]));
    const { code, out } = await runCli(["--registry", "--api", `http://127.0.0.1:${api.address().port}`]);
    assert.equal(code, 2, "контрактный код отказа флага");
    assert.match(out, /--registry requires a value/);
    assert.equal(hits, 0, "ни одного запроса к API после отказа (P2: раньше шли сеть+перезапись)");
    assert.equal(JSON.parse(readFileSync(reg, "utf8"))[0].decimals, null, "реестр не перезаписан");
  } finally {
    await new Promise((r) => api.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- F1-2: equals-форма ----

test("cli: enrich --registry=<путь> (equals) — обогащается ИМЕННО этот файл", async () => {
  const dir = tmp("lw-f1b-");
  try {
    const alt = path.join(dir, "alt.json");
    const def = path.join(dir, "default.json");
    writeFileSync(alt, JSON.stringify([{ mint: MINT, symbol: "SPYx", decimals: null }]));
    writeFileSync(def, JSON.stringify([{ mint: MINT, symbol: "SPYx", decimals: null }]));
    const api = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ [MINT]: { usdPrice: 1, blockId: "b", decimals: 8, priceChange24h: {} } }));
    });
    await new Promise((r) => api.listen(0, "127.0.0.1", r));
    // cwd песочницы: дефолтный путь data/tokens.json разрешится в её же data/ —
    // кладём туда копию def, чтобы поймать «обогатился не тот файл»
    mkdirSync(path.join(dir, "data"));
    writeFileSync(path.join(dir, "data", "tokens.json"), readFileSync(def));
    const child = spawn(process.execPath, [path.join(ROOT, "scripts", "enrich-decimals.mjs"),
      `--registry=${alt}`, "--api", `http://127.0.0.1:${api.address().port}`], { cwd: dir });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { out += c; });
    const code = await new Promise((r) => child.on("close", r));
    await new Promise((r) => api.close(r));
    assert.equal(code, 0, `успех (out: ${out.slice(0, 200)})`);
    assert.equal(JSON.parse(readFileSync(alt, "utf8"))[0].decimals, 8, "equals-форма обогатила УКАЗАННЫЙ файл");
    assert.equal(JSON.parse(readFileSync(path.join(dir, "data", "tokens.json"), "utf8"))[0].decimals, null, "дефолтный не тронут");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
import { mkdirSync } from "node:fs";

// ---- F1-3: pid-живость лока журнала ----

const entry = (m) => ({ lastEffective: m, observedAt: "2026-09-24T00:00:00.000Z", events: [] });

test("journal-лок: ЖИВОЙ владелец с древним mtime НЕ ломается (pid-живость, R9 №9)", () => {
  const dir = tmp("lw-f1c-");
  try {
    const jp = path.join(dir, "j.json");
    const lock = `${jp}.lock`;
    writeFileSync(jp, JSON.stringify({ A: entry("1") }));
    writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: "2026-09-24T00:00:00.000Z" }));
    utimesSync(lock, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000)); // час назад
    const t0 = Date.now();
    saveJournalMerged(jp, { B: entry("2") }, { staleMs: 10_000, attempts: 3, retryPauseMs: 1 });
    assert.ok(Date.now() - t0 < 2000, "без долгого ожидания: быстрые ретраи и деградация");
    assert.ok(existsSync(lock), "лока ЖИВОГО владельца не снесли (запись деградировала без лока)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("journal-лок: МЁРТВЫЙ pid ломается СРАЗУ, даже с совершенно свежим mtime", () => {
  const dir = tmp("lw-f1d-");
  try {
    const jp = path.join(dir, "j.json");
    const lock = `${jp}.lock`;
    writeFileSync(jp, JSON.stringify({ A: entry("1") }));
    writeFileSync(lock, JSON.stringify({ pid: 2_000_000_000, createdAt: new Date().toISOString() })); // pid вне диапазра ОС = мёртв
    const t0 = Date.now();
    saveJournalMerged(jp, { B: entry("2") }, { staleMs: 10_000, attempts: 600, retryPauseMs: 5 });
    assert.ok(Date.now() - t0 < 2000, "сирота после kill -9 не жжёт staleMs — ломка по pid мгновенная (было ~10с)");
    const after = JSON.parse(readFileSync(jp, "utf8"));
    assert.ok(after.A && after.B, "merge прошёл под взятым локом");
    assert.ok(!existsSync(lock), "лок убран за собой");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- F1-4: будущий mtime ----

test("journal-лок: будущий mtime (перекос часов) — ломка сразу, не 10с ожидания", () => {
  const dir = tmp("lw-f1e-");
  try {
    const jp = path.join(dir, "j.json");
    const lock = `${jp}.lock`;
    writeFileSync(jp, JSON.stringify({ A: entry("1") }));
    writeFileSync(lock, "legacy-not-json"); // легаси-контент: pid-проверка неприменима
    utimesSync(lock, new Date(Date.now() + 3600_000), new Date(Date.now() + 3600_000)); // mtime из будущего
    const t0 = Date.now();
    saveJournalMerged(jp, { B: entry("2") }, { staleMs: 10_000, attempts: 600, retryPauseMs: 5 });
    assert.ok(Date.now() - t0 < 2000, "age < 0 = кандидат на ломку немедленно");
    assert.ok(!existsSync(lock), "будущий лок сломан и убран");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
