// Раунд 16 — киллер-пины мутаций H4 (12 мутаций по раунду-15, 4 выжило) + регрессии
// атак-находок:
//   M6/H4-P3 «age < -staleMs» без пина: мутация age<0 ломала свежий легаси-лок с
//          mtime на долю мс «в будущем» — NTFS-гвардия обязана tolerить (−staleMs, 0).
//   M3     строка-pid («123») = легаси-контент: свежий лок ждёт, НЕ ломается мгновенно.
//   M1     isPidAlive EPERM = живой (DI-шов kill): мутация EPERM→false роняла бы
//          живые чужие владения.
//   M4     контент лока {pid} реально пишется (без writeSync pid-живость no-op).
//   H4-P3  eq-форма «--api=--evil» — usage-отказ exit 2, не runtime-стек.
//   H4-P4  nowMs:null/NaN — валидация инъекции: свежий легаси-лок НЕ ломается.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync, readFileSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { saveJournalMerged, isPidAlive, acquireSyncLock } from "../src/events/journal.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = (m) => ({ lastEffective: m, observedAt: "2026-09-25T00:00:00.000Z", events: [] });
const tmpJournal = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lw-h4-"));
  return { dir, jp: path.join(dir, "onchain-journal.json"), lock: path.join(dir, "onchain-journal.json.lock") };
};

test("journal-лок: age в (−staleMs, 0) — «минус-миллисекундное будущее» свежего лока, НЕ ломка (M6)", () => {
  const { dir, jp, lock } = tmpJournal();
  try {
    const staleMs = 10_000;
    const now = Date.now();
    writeFileSync(jp, JSON.stringify({ A: entry("1") }));
    writeFileSync(lock, "legacy"); // легаси-контент
    utimesSync(lock, new Date(now), new Date(now));
    // nowMs на 0.5мс «раньше» mtime: NTFS-мир свежего лока; гвардия обязана tolerить
    saveJournalMerged(jp, { B: entry("2") }, { staleMs, attempts: 1, retryPauseMs: 1, nowMs: now - 0.5 });
    assert.ok(existsSync(lock), "age ∈ (−staleMs, 0) — НЕ будущее-перекос, свежий легаси-лок цел");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("journal-лок: строка-pid («123») — легаси-контент: свежий лок ждёт, не ломается (M3)", () => {
  const { dir, jp, lock } = tmpJournal();
  try {
    writeFileSync(jp, JSON.stringify({ A: entry("1") }));
    writeFileSync(lock, JSON.stringify({ pid: "123", createdAt: new Date().toISOString() })); // pid-СТРОКА
    saveJournalMerged(jp, { B: entry("2") }, { staleMs: 10_000, attempts: 2, retryPauseMs: 1 });
    assert.ok(existsSync(lock), "Number.isInteger-гвард обязан отсечь строку → легаси-семантика, без мгновенной ломки");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("journal-лок: isPidAlive — EPERM = ЖИВОЙ (чужой процесс), ESRCH = мёртвый (M1, DI-шов)", () => {
  const eperm = (pid, sig) => {
    const e = new Error("EPERM");
    e.code = "EPERM";
    throw e;
  };
  const esrch = () => {
    const e = new Error("ESRCH");
    e.code = "ESRCH";
    throw e;
  };
  assert.equal(isPidAlive(4242, eperm), true, "EPERM = существует, но чужой — ЖИВОЙ владелец");
  assert.equal(isPidAlive(4242, esrch), false);
  assert.equal(isPidAlive("4242"), false, "не-целый pid = мёртв для классификатора");
  assert.equal(isPidAlive(process.pid), true, "свой pid жив без инъекции");
});

test("journal-лок: контент {pid} реально пишется в лок под взятой блокировкой (M4)", () => {
  // Наблюдатель в том же процессе невозможен: saveJournalMerged синхронен и блокирует
  // event loop — пинимаем сам acquireSyncLock (мутация «writeSync убран» жила именно
  // там): без контента следующий писатель считает лок легаси и pid-живость no-op.
  const dir = mkdtempSync(path.join(tmpdir(), "lw-h4m-"));
  const lockPath = path.join(dir, "onchain-journal.json.lock");
  let fd = null;
  try {
    fd = acquireSyncLock(lockPath, { staleMs: 10_000, attempts: 3, retryPauseMs: 1 });
    assert.ok(fd !== null, "лок взят");
    const meta = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.ok(Number.isInteger(meta.pid), `контент load-bearing: {pid} целое (got ${JSON.stringify(meta)})`);
    assert.equal(meta.pid, process.pid);
    assert.ok(typeof meta.createdAt === "string");
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* уже закрыт */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: enrich «--api=--evil» — usage-отказ exit 2, не runtime-стек (H4-P3)", async () => {
  const api = http.createServer((req, res) => { res.writeHead(400); res.end(); });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(path.join(tmpdir(), "lw-h4e-"));
  try {
    writeFileSync(path.join(dir, "reg.json"), JSON.stringify([]));
    const child = spawn(process.execPath, [path.join(ROOT, "scripts", "enrich-decimals.mjs"),
      "--registry", path.join(dir, "reg.json"), "--api=--evil"]);
    let stderr = "";
    child.stderr.on("data", (c) => { stderr += c; });
    const code = await new Promise((r) => child.on("close", r));
    assert.equal(code, 2, `usage-код, не runtime (stderr: ${stderr.slice(0, 150)})`);
    assert.match(stderr, /--api requires a non-empty value/);
    assert.ok(!/TypeError|ENOENT|undici/.test(stderr), "никаких сырых стеков");
  } finally {
    await new Promise((r) => api.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("journal-лок: nowMs:null / NaN — инъекция игнорируется, свежий легаси-лок НЕ ломается (H4-P4)", () => {
  for (const bad of [null, NaN, Infinity]) {
    const { dir, jp, lock } = tmpJournal();
    try {
      writeFileSync(jp, JSON.stringify({ A: entry("1") }));
      writeFileSync(lock, "legacy-fresh");
      saveJournalMerged(jp, { B: entry("2") }, { staleMs: 10_000, attempts: 1, retryPauseMs: 1, nowMs: bad });
      assert.ok(existsSync(lock), `nowMs=${String(bad)}: валидация инъекции — свежий лок цел`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
