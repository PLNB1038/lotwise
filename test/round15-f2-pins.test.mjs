// Раунд 15 — киллер-тесты мутационного аудита F2 (32 мутации по коду раундов 13–14,
// 6 выжило — все чистые гэпы сьюта, прод-код не менялся; здесь каждый закрывается).
//   F09 acquireSyncLock: граница протухания — РОВНО staleMs ещё «свежий» (ломка строго позже)
//   F10 saveJournalMerged: лок убирается за собой после успешной записи
//   F12 деградация без лока: ЧУЖОЙ свежий лок не сносится (fd===null ⇒ finally молчит)
//   F16 assertHostResolvable: lookup вызывается с переданным host (не константой)
//   F27 словарь issuer в 400 отсортирован — точная строка стабильна между инстансами
//   F31 enrich-decimals: флаг без значения — exit 2 одной строкой, без стека
//   F11 (бонус-пин): saveJournalMerged не мутирует переданный объект-журнал
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { saveJournalMerged } from "../src/events/journal.mjs";
import { assertHostResolvable } from "../src/cli/flags.mjs";
import { createApiServer } from "../src/api/server.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = (m) => ({ lastEffective: m, observedAt: "2026-09-24T00:00:00.000Z", events: [] });

const tmpJournal = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lw-f2-"));
  return { dir, jp: path.join(dir, "onchain-journal.json"), lock: path.join(dir, "onchain-journal.json.lock") };
};

test("journal-лок: ровно staleMs — ещё свежий, ломка только строго позже (F09)", () => {
  const { dir, jp, lock } = tmpJournal();
  try {
    const staleMs = 10_000;
    const now = Date.now();
    writeFileSync(jp, JSON.stringify({ A: entry("1") }));
    writeFileSync(lock, "");
    utimesSync(lock, new Date(now - staleMs), new Date(now - staleMs)); // ровно граница
    saveJournalMerged(jp, { B: entry("2") }, { staleMs, attempts: 1, retryPauseMs: 1, nowMs: now });
    assert.ok(existsSync(lock), "лок на границе НЕ сломан (age > staleMs, не >=) и пережил деградировавшую запись");

    utimesSync(lock, new Date(now - staleMs - 60_000), new Date(now - staleMs - 60_000)); // явно протух
    saveJournalMerged(jp, { C: entry("3") }, { staleMs, attempts: 1, retryPauseMs: 1, nowMs: now });
    assert.ok(!existsSync(lock), "протухший (за границей) сломан и убран нашим finally");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("journal-лок: после успешной записи лока на диске нет (F10)", () => {
  const { dir, jp, lock } = tmpJournal();
  try {
    saveJournalMerged(jp, { A: entry("1") });
    assert.ok(!existsSync(lock), "лок убран — следующий писатель не ретраит 3.5с и не копит *.lock");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("journal-лок: деградация без лока НЕ сносит чужой свежий лок (F12)", () => {
  const { dir, jp, lock } = tmpJournal();
  try {
    writeFileSync(jp, JSON.stringify({ A: entry("1") }));
    writeFileSync(lock, "foreign-live"); // чужой ЖИВОЙ лок (не протух)
    saveJournalMerged(jp, { B: entry("2") }, { staleMs: 10_000, attempts: 2, retryPauseMs: 1 });
    assert.ok(existsSync(lock), "чужой свежий лок на месте — fd===null молчит в finally");
    assert.equal(readFileSync(lock, "utf8"), "foreign-live", "и не перезаписан");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("flags: assertHostResolvable резолвит ИМЕННО переданный host (F16)", async () => {
  const seen = [];
  const mock = async (h) => {
    seen.push(h);
    if (h === "no-such-host.invalid") {
      const e = new Error("getaddrinfo ENOTFOUND");
      e.code = "ENOTFOUND";
      throw e;
    }
    return { address: "1.2.3.4" };
  };
  await assertHostResolvable("example.com", mock);
  await assert.rejects(() => assertHostResolvable("no-such-host.invalid", mock), /ENOTFOUND/);
  assert.deepEqual(seen, ["example.com", "no-such-host.invalid"], "lookup получил аргументы, а не константу");
});

test("api: словарь issuer в 400 отсортирован — строка стабильна (F27)", async () => {
  const M = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
  // НЕотсортированный порядок в реестре: zeta идёт раньше alpha
  const registry = [
    { symbol: "Zx", name: "z", issuer: "zeta", mint: M, decimals: 8 },
    { symbol: "Ax", name: "a", issuer: "alpha", mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", decimals: 8 },
  ];
  const server = await createApiServer({ registry });
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/tokens?issuer=${encodeURIComponent("мусор")}`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes("valid: alpha, zeta"), `словарь отсортирован независимо от порядка реестра (got: ${body.error})`);
  } finally {
    server.close();
  }
});

test("cli: enrich-decimals --registry без значения — exit 2, одна строка, без стека (F31)", async () => {
  const child = spawn(process.execPath, [path.join(ROOT, "scripts", "enrich-decimals.mjs"), "--registry"]);
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += c; });
  child.stdout.on("data", () => {});
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 2, `контрактный код ошибки флага (stderr: ${stderr.slice(0, 200)})`);
  assert.match(stderr, /--registry requires a value/);
  assert.ok(!/TypeError|at /.test(stderr), "чистый отказ, а не сырой стек из readFileSync(null)");
});

test("journal: saveJournalMerged не мутирует переданный объект (F11-пин)", () => {
  const { dir, jp } = tmpJournal();
  try {
    writeFileSync(jp, JSON.stringify({ FOREIGN: entry("9") }));
    const input = { MINE: entry("5") };
    const snapshot = JSON.parse(JSON.stringify(input));
    saveJournalMerged(jp, input);
    assert.deepEqual(input, snapshot, "вход не алиасится с merged-результатом");
    const after = JSON.parse(readFileSync(jp, "utf8"));
    assert.ok(after.FOREIGN && after.MINE, "merge по-прежнему правильный");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
