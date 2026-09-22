// Тесты аудита publish-check: временные фикстуры в os.tmpdir (mkdtemp), БЕЗ сети.
// Проверяем: find/miss по всем классам паттернов, исключения (.git, node_modules,
// test/fixtures по флагу), человекочитаемый и --json режимы, exit-коды CLI (0/1/2).
//
// Self-scan-гигиена: литералы-триггеры (путь к профилю, имя пользователя, значения
// секретов) собираются по частям — если бы тест содержал готовые «личные» строки,
// аудит реального репо находил бы их в этом файле, и ритуал чистки никогда не
// сходился бы даже при чистом проекте.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  BUILT_IN_PATTERNS,
  buildSummary,
  collectFiles,
  parseArgs,
  scanText,
  scanTree,
} from "../scripts/publish-check.mjs";

const SCRIPT = path.join(import.meta.dirname, "..", "scripts", "publish-check.mjs");

// — безопасная сборка триггеров (в исходнике готовых литералов нет) —
const WIN_PATH = ["C:", "Users", "alice", "notes.txt"].join(path.sep);
const TAILSCALE_IP = ["100", "79", "107", "102"].join(".");
const PRIVATE_192 = ["192", "168", "1", "50"].join(".");
const PRIVATE_10 = ["10", "1", "2", "3"].join(".");
const TS_HOST = ["my-nas", "tail1234", "ts.net"].join(".");
const DOT_LOCAL = ["printer", "local"].join(".");
const EMAIL = ["dev", "example.com"].join(String.fromCharCode(64));
const OS_USER = ["l", "i", "d", "b", "e"].join("");
const SECRET_VALUE = "s".repeat(28);
const KV_SECRET_LINE = ["SECRET", SECRET_VALUE].join(" = ");
const SK_KEY = "sk-" + "a".repeat(30);
const JWT = "eyJ" + "w".repeat(30);
// Публичный минт из data/tokens.json — НЕ секрет, аудит за него не фолсит.
const MINT = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB";

const created = [];
function tempRoot(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

// Дерево-фикстура: грязные файлы + легальные исключения + чистый файл.
function makeTree() {
  const root = tempRoot("publish-check-dirty-");
  writeFileSync(
    path.join(root, "leak.md"),
    ["путь " + WIN_PATH, "хосты " + TAILSCALE_IP + " и " + TS_HOST].join("\n") + "\n",
  );
  writeFileSync(
    path.join(root, "clean.txt"),
    [
      "сервер на http://127.0.0.1:8787 и localhost:8787 — легально",
      "публичный минт " + MINT,
      "публичный DNS api.mainnet-beta.solana.com и 8.8.8.8",
    ].join("\n") + "\n",
  );
  writeFileSync(path.join(root, "secret.env.txt"), [KV_SECRET_LINE, SK_KEY, JWT].join("\n") + "\n");
  mkdirSync(path.join(root, "test", "fixtures"), { recursive: true });
  writeFileSync(path.join(root, "test", "fixtures", "legit.mjs"), "фикстура с " + WIN_PATH + "\n");
  mkdirSync(path.join(root, "node_modules"), { recursive: true });
  writeFileSync(path.join(root, "node_modules", "dep.mjs"), WIN_PATH + "\n");
  mkdirSync(path.join(root, ".git"), { recursive: true });
  writeFileSync(path.join(root, ".git", "COMMIT_EDITMSG"), WIN_PATH + "\n");
  return root;
}

test.after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

test("scanText ловит все классы встроенных паттернов", () => {
  const text = [
    WIN_PATH,
    TAILSCALE_IP,
    PRIVATE_192,
    PRIVATE_10,
    TS_HOST,
    DOT_LOCAL,
    EMAIL,
    SK_KEY,
    JWT,
    KV_SECRET_LINE,
    "user " + OS_USER,
  ].join("\n");
  const ids = new Set(scanText(text, BUILT_IN_PATTERNS).map((f) => f.pattern));
  for (const id of [
    "win-path",
    "tailscale-ip",
    "priv-ip-192168",
    "priv-ip-10",
    "host-ts-net",
    "host-local",
    "email",
    "secret-key-shape",
    "secret-kv",
    "os-username",
  ]) {
    assert.ok(ids.has(id), `ожидали паттерн ${id}, поймано: ${[...ids].sort().join(", ")}`);
  }
});

test("легальное не фолсится: 127.0.0.1, localhost, минты, env-ссылки, короткие ключи", () => {
  const text = [
    'const url = "http://127.0.0.1:8787";',
    "сервер localhost:8787 поднят тестами",
    "публичный DNS 8.8.8.8 и api.mainnet-beta.solana.com",
    'token: "' + MINT + '",',
    "const token = process.env.RPC_URL;",
    "const token = findBySymbol(registry, \"TSLAx\");", // вызов функции — не литерал секрета
    "слово locale и другие ложные следы",
    "sk-short",
  ].join("\n");
  assert.deepEqual(scanText(text, BUILT_IN_PATTERNS), []);
});

test("номера строк и сниппеты корректны", () => {
  const res = scanText("ок\n" + WIN_PATH + "\nок", BUILT_IN_PATTERNS);
  assert.equal(res.length, 1);
  assert.equal(res[0].line, 2);
  assert.ok(res[0].snippet.includes("Users"), "сниппет должен содержать строку-находку");
});

test("parseArgs: флаги парсятся, ошибки валидируются", () => {
  const opts = parseArgs(["--json", "--include-fixtures", "--root", "X", "--extra-pattern", "demo=HACK-[0-9]+"]);
  assert.equal(opts.json, true);
  assert.equal(opts.includeFixtures, true);
  assert.equal(opts.root, "X");
  assert.equal(opts.extra.length, 1);
  assert.equal(opts.extra[0].id, "demo");
  assert.ok("HACK-42".match(opts.extra[0].regex));
  // У parseArgs свой UsageError; проверяем по тексту ошибки.
  assert.throws(() => parseArgs(["--неизвестный"]), /неизвестный флаг/);
  assert.throws(() => parseArgs(["--extra-pattern", "bad=["]), /некорректная регэкспа/);
  assert.throws(() => parseArgs(["--extra-pattern", "=x"]), /ждём/);
  assert.throws(() => parseArgs(["--root"]), /требует путь/);
});

test("collectFiles: расширения фильтруются, .git/node_modules всегда мимо, фикстуры — по флагу", () => {
  const root = makeTree();
  const rels = collectFiles(root).map((f) => f.rel);
  for (const expected of ["leak.md", "clean.txt", "secret.env.txt"]) {
    assert.ok(rels.includes(expected), `ожидали в скане ${expected}`);
  }
  assert.ok(!rels.some((r) => r.startsWith("node_modules/")), "node_modules не сканируется");
  assert.ok(!rels.some((r) => r.startsWith(".git/")), ".git не сканируется");
  assert.ok(!rels.includes("test/fixtures/legit.mjs"), "фикстуры по умолчанию не сканируются");
  const withFixtures = collectFiles(root, { includeFixtures: true }).map((f) => f.rel);
  assert.ok(withFixtures.includes("test/fixtures/legit.mjs"), "флаг включает фикстуры");
});

test("scanTree: находки по дереву с файл-путями на слэшах; по умолчанию фикстуры чисты", () => {
  const root = makeTree();
  const { scanned, findings } = scanTree(root, BUILT_IN_PATTERNS);
  assert.ok(scanned >= 3, `ожидали >=3 файлов, просканировано ${scanned}`);
  const byPattern = new Set(findings.map((f) => f.pattern));
  for (const id of ["win-path", "tailscale-ip", "secret-kv", "secret-key-shape"]) {
    assert.ok(byPattern.has(id), `ожидали находку ${id} по дереву`);
  }
  assert.ok(!findings.some((f) => f.file.startsWith("test/fixtures")), "фикстуры не в скане");
  for (const f of findings) {
    assert.ok(!f.file.includes("\\"), `путь должен быть на слэшах: ${f.file}`);
    assert.ok(Number.isInteger(f.line) && f.line >= 1);
  }
});

test("scanTree с includeFixtures ловит личное и в фикстурах", () => {
  const root = makeTree();
  const { findings } = scanTree(root, BUILT_IN_PATTERNS, { includeFixtures: true });
  assert.ok(
    findings.some((f) => f.file === "test/fixtures/legit.mjs" && f.pattern === "win-path"),
    "личный паттерн в фикстуре должен быть пойман по флагу",
  );
});

test("buildSummary: счётчики по паттернам и топ файлов", () => {
  const findings = [
    { file: "a.md", line: 1, pattern: "email", snippet: "x" },
    { file: "a.md", line: 2, pattern: "email", snippet: "y" },
    { file: "b.txt", line: 1, pattern: "win-path", snippet: "z" },
  ];
  const summary = buildSummary(7, findings);
  assert.equal(summary.scannedFiles, 7);
  assert.equal(summary.total, 3);
  assert.equal(summary.clean, false);
  assert.deepEqual(summary.byPattern, { email: 2, "win-path": 1 });
  assert.deepEqual(summary.topFiles, [
    { file: "a.md", count: 2 },
    { file: "b.txt", count: 1 },
  ]);
  assert.deepEqual(buildSummary(5, []), {
    scannedFiles: 5,
    total: 0,
    clean: true,
    byPattern: {},
    topFiles: [],
  });
});

test("CLI: грязное дерево — exit 1 и валидный --json", () => {
  const root = makeTree();
  const res = spawnSync(process.execPath, [SCRIPT, "--root", root, "--json"], { encoding: "utf8" });
  assert.equal(res.status, 1, `stderr: ${res.stderr}`);
  const report = JSON.parse(res.stdout);
  assert.ok(Array.isArray(report.findings) && report.findings.length > 0);
  assert.equal(report.summary.total, report.findings.length);
  assert.equal(report.summary.clean, false);
  const patterns = new Set(report.findings.map((f) => f.pattern));
  assert.ok(patterns.has("win-path"));
  assert.ok(patterns.has("tailscale-ip"));
});

test("CLI: чистое дерево — exit 0, findings пустые, человекочитаемый режим печатает итог", () => {
  const root = tempRoot("publish-check-clean-");
  writeFileSync(path.join(root, "ok.md"), "чисто: http://127.0.0.1:8787 и localhost:8787\n");
  const json = spawnSync(process.execPath, [SCRIPT, "--root", root, "--json"], { encoding: "utf8" });
  assert.equal(json.status, 0, `stderr: ${json.stderr}`);
  const report = JSON.parse(json.stdout);
  assert.deepEqual(report.findings, []);
  assert.equal(report.summary.total, 0);
  assert.equal(report.summary.clean, true);
  const human = spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8" });
  assert.equal(human.status, 0);
  assert.match(human.stdout, /ИТОГ: чисто/);
});

test("CLI: несуществующий --root — exit 2, неизвестный флаг — exit 2", () => {
  const badRoot = spawnSync(
    process.execPath,
    [SCRIPT, "--root", path.join(tmpdir(), "publish-check-нет-такой-xyz")],
    { encoding: "utf8" },
  );
  assert.equal(badRoot.status, 2);
  const badFlag = spawnSync(process.execPath, [SCRIPT, "--нет-такого-флага"], { encoding: "utf8" });
  assert.equal(badFlag.status, 2);
});

test("CLI: --extra-pattern работает сквозь CLI", () => {
  const root = tempRoot("publish-check-extra-");
  writeFileSync(path.join(root, "a.txt"), "HACK-42\n");
  const res = spawnSync(
    process.execPath,
    [SCRIPT, "--root", root, "--json", "--extra-pattern", "demo=HACK-[0-9]+"],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 1);
  const report = JSON.parse(res.stdout);
  assert.ok(report.findings.some((f) => f.pattern === "demo"), "доп. паттерн должен сработать");
});
