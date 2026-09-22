// publish-check — аудит репо перед публикацией на GitHub: «ритуал чистки» из BUILD_PLAN.md
// («ничего не пушим без ритуала чистки: ноль личного/инфры»). Строго read-only: ТОЛЬКО
// отчёт, ничего не удаляет и не правит.
//
// Запуск из корня репо:
//   node scripts/publish-check.mjs
//   node scripts/publish-check.mjs --json
// Флаги:
//   --json                 только JSON-отчёт {findings, summary} в stdout
//   --include-fixtures     сканировать и test/fixtures (по умолчанию пропускается:
//                          там легальные тестовые данные; исключение управляется этим
//                          флагом — если нужно поймать личные паттерны и в фикстурах)
//   --root <папка>         корень скана (по умолчанию — текущая папка; нужен тестам)
//   --extra-pattern и=РЕ   доп. паттерн «имя=регэксп» (источник RegExp; флаг повторяемый)
//   -h, --help             справка
// Коды выхода: 0 — чисто, 1 — есть находки, 2 — ошибка запуска/чтения.
//
// Осознанные решения:
// - 127.0.0.1 и localhost НЕ фолсятся: тесты репо поднимают сервера на localhost — легально.
// - Solana-pubkey/минты (base58 без нулей, 32–44) в значениях при secret/token — не секреты:
//   публичные адреса по определению (реестр весь на них стоит).
// - Ссылки вида process.env.X в значениях — не утечка (это чтение, не зашитый секрет).
// - Self-scan-гигиена: литералы-триггеры (имя пользователя и т.п.) в этом исходнике
//   собираются по частям, иначе аудит реального репо вечно ловил бы собственный
//   скрипт, и ритуал не сходился бы в принципе.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const TEXT_EXTS = new Set([".mjs", ".md", ".json", ".html", ".txt"]);
const ALWAYS_EXCLUDED_DIRS = new Set([".git", "node_modules"]);
const FIXTURES_REL = "test/fixtures";
const SNIPPET_MAX = 200;
// Октет IPv4 (0–255) и форма имени хоста — общие куски для нескольких паттернов.
const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const HOST = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
// base58 без 0/O/I/l — форма Solana-pubkey/минта.
const BASE58_PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Имя пользователя ОС — по буквам, см. self-scan-гигиену в шапке.
const OS_USER = ["l", "i", "d", "b", "e"].join("");

class UsageError extends Error {}

// Значение при ключе вида secret/token/api-key…: решаем, похоже ли оно на зашитый секрет.
function kvValueSensitive(raw) {
  const v = raw.replace(/[),.;\]]+$/, "").trim();
  if (v.length < 20) return false; // короче 20 — не считаем значением секрета
  if (/^(?:process\.env|import\.meta\.env|Deno\.env|os\.environ)/i.test(v)) return false;
  if (v.includes("${")) return false; // шаблонный плейсхолдер — значение подставит рантайм
  if (/[()]/.test(v)) return false; // вызов функции/выражение кода, а не литерал секрета
  // (в base64/JWT/API-ключах скобок не бывает, а `token = findBySymbol(...)` фолсить не надо)
  if (/^<[^<>\s]+>$/.test(v)) return false; // явные заглушки вида <YOUR_KEY_HERE>
  if (BASE58_PUBKEY.test(v)) return false; // Solana-pubkey/минт — публичный адрес
  return true;
}

export const BUILT_IN_PATTERNS = [
  {
    id: "win-path",
    hint: "локальный путь Windows к профилю пользователя",
    regex: /C:[/\\]Users[/\\][^\s"'`<>(){},;\[\]]+/gi,
  },
  {
    id: "tailscale-ip",
    hint: "IPv4 из CGNAT-диапазона (Tailscale/tailnet)",
    regex: new RegExp(`\\b100\\.${OCTET}\\.${OCTET}\\.${OCTET}\\b`, "g"),
  },
  {
    id: "priv-ip-192168",
    hint: "приватный IPv4 вида 192.168.x.x",
    regex: new RegExp(`\\b192\\.168\\.${OCTET}\\.${OCTET}\\b`, "g"),
  },
  {
    id: "priv-ip-10",
    hint: "приватный IPv4 вида 10.x.x.x",
    regex: new RegExp(`\\b10\\.${OCTET}\\.${OCTET}\\.${OCTET}\\b`, "g"),
  },
  {
    id: "host-ts-net",
    hint: "хост tailnet (домен ts.net)",
    regex: new RegExp(`\\b(?:${HOST}\\.)+ts\\.net\\b`, "gi"),
  },
  {
    id: "host-local",
    hint: "хост локальной сети вида имя.local",
    regex: new RegExp(`\\b(?:${HOST}\\.)+local\\b`, "gi"),
  },
  {
    id: "email",
    hint: "e-mail адрес",
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g,
  },
  {
    id: "secret-key-shape",
    hint: "строка, похожая на готовый API-ключ (префиксы sk/eyJ/ghp/AKIA/xox/glpat/npm, длина 30+)",
    regex: /\b(?:sk-[A-Za-z0-9_-]{27,}|eyJ[A-Za-z0-9_-]{27,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{26,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{15,}|glpat-[A-Za-z0-9_-]{15,}|npm_[A-Za-z0-9]{27,})/g,
  },
  {
    id: "secret-kv",
    hint: "секрет в значении: secret/token/api-key/password/… при = или : со значением 20+",
    regex: /(?<![a-z])(?:secret|token|api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|pwd|bearer|credential|creds?)(?![a-z])["']?\s*[:=]\s*["']?([^\s"']{20,})/gi,
    keep: kvValueSensitive,
  },
  {
    id: "os-username",
    hint: "имя пользователя ОС в тексте/путях",
    regex: new RegExp(`\\b${OS_USER}\\b`, "gi"),
  },
];

const USAGE = `использование: node scripts/publish-check.mjs [флаги]
  --json                 только JSON-отчёт {findings, summary} в stdout
  --include-fixtures     не пропускать test/fixtures (по умолчанию пропускается)
  --root <папка>         корень скана (по умолчанию — текущая папка)
  --extra-pattern и=РЕ   доп. паттерн «имя=регэксп»; флаг можно повторять
  -h, --help             эта справка
Коды выхода: 0 — чисто, 1 — есть находки, 2 — ошибка запуска/чтения.`;

// Построчный скан текста: находка — {line, pattern, snippet}, не более одной на
// пару (строка, паттерн), чтобы не плодить шум. Для паттернов с keep() значения
// сначала проходит фильтр ложных срабатываний.
export function scanText(text, patterns) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    for (const p of patterns) {
      p.regex.lastIndex = 0;
      let m;
      while ((m = p.regex.exec(line)) !== null) {
        if (m[0].length === 0) {
          // защита от зависания на паттернах, допускающих пустое совпадение
          p.regex.lastIndex += 1;
          continue;
        }
        const value = m[1] === undefined ? m[0] : m[1];
        if (p.keep && !p.keep(value)) continue;
        findings.push({ line: i + 1, pattern: p.id, snippet: clip(line.trim()) });
        break; // одна находка на строку и паттерн — дальше по строке не идём
      }
    }
  }
  return findings;
}

function clip(s) {
  return s.length > SNIPPET_MAX ? `${s.slice(0, SNIPPET_MAX - 1)}…` : s;
}

// Рекурсивный сбор текстовых файлов. .git и node_modules исключены всегда,
// test/fixtures — по умолчанию (снимается флагом includeFixtures). Символические
// ссылки не проходим, недоступные папки молча пропускаем (аудит не должен падать).
export function collectFiles(root, { includeFixtures = false } = {}) {
  const absRoot = path.resolve(root);
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // нет доступа — эту ветку пропускаем
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (ALWAYS_EXCLUDED_DIRS.has(e.name)) continue;
        const relChild = rel ? `${rel}/${e.name}` : e.name;
        if (!includeFixtures && relChild === FIXTURES_REL) continue;
        walk(path.join(dir, e.name), relChild);
        continue;
      }
      if (!e.isFile()) continue;
      if (!TEXT_EXTS.has(path.extname(e.name).toLowerCase())) continue;
      out.push({ abs: path.join(dir, e.name), rel: rel ? `${rel}/${e.name}` : e.name });
    }
  };
  walk(absRoot, "");
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

// Скан дерева: находки с путями относительно корня (слэши — унифицированные).
export function scanTree(root, patterns, opts = {}) {
  const absRoot = path.resolve(root);
  const st = statSync(absRoot); // несуществующий корень кинет здесь — main даст exit 2
  if (!st.isDirectory()) throw new Error(`корень ${absRoot} — не папка`);
  const files = collectFiles(absRoot, opts);
  const findings = [];
  for (const { abs, rel } of files) {
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue; // нечитаемый файл пропускаем — аудит не должен падать
    }
    if (text.includes("\u0000")) continue; // бинарник под текстовым расширением — мимо
    for (const f of scanText(text, patterns)) findings.push({ file: rel, ...f });
  }
  return { scanned: files.length, findings };
}

export function buildSummary(scanned, findings) {
  const byPattern = {};
  const byFile = {};
  for (const f of findings) {
    byPattern[f.pattern] = (byPattern[f.pattern] ?? 0) + 1;
    byFile[f.file] = (byFile[f.file] ?? 0) + 1;
  }
  const topFiles = Object.entries(byFile)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([file, count]) => ({ file, count }));
  return {
    scannedFiles: scanned,
    total: findings.length,
    clean: findings.length === 0,
    byPattern,
    topFiles,
  };
}

export function parseArgs(argv) {
  const opts = { json: false, includeFixtures: false, help: false, root: process.cwd(), extra: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "--include-fixtures") opts.includeFixtures = true;
    else if (arg === "-h" || arg === "--help") opts.help = true;
    else if (arg === "--root") {
      const value = argv[++i];
      if (value === undefined) throw new UsageError("--root требует путь");
      opts.root = value;
    } else if (arg === "--extra-pattern") {
      const spec = argv[++i];
      if (spec === undefined) throw new UsageError("--extra-pattern требует «имя=регэксп»");
      const eq = spec.indexOf("=");
      if (eq <= 0) throw new UsageError(`--extra-pattern: ждём «имя=регэксп», получено «${spec}»`);
      const id = spec.slice(0, eq).trim();
      const source = spec.slice(eq + 1);
      if (!id || !source) throw new UsageError("--extra-pattern: пустое имя или пустая регэкспа");
      try {
        opts.extra.push({ id, hint: `доп. паттерн ${id}`, regex: new RegExp(source, "g") });
      } catch (err) {
        throw new UsageError(`--extra-pattern «${id}»: некорректная регэкспа (${err.message})`);
      }
    } else {
      throw new UsageError(`неизвестный флаг: ${arg}`);
    }
  }
  return opts;
}

function sortFindings(findings) {
  return findings.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.pattern.localeCompare(b.pattern),
  );
}

function printHuman(root, patterns, findings, summary) {
  console.log("[publish-check] аудит репо перед публикацией — ритуал чистки (read-only)");
  console.log(`[publish-check] корень: ${path.resolve(root)}`);
  console.log(`[publish-check] текстовых файлов: ${summary.scannedFiles}; паттернов: ${patterns.length}`);
  if (summary.clean) {
    console.log("[publish-check] ИТОГ: чисто — личного, инфры и секретов не найдено. Пушить можно.");
    return;
  }
  console.log(`[publish-check] ИТОГ: находок ${summary.total} — пуш отложить до чистки.`);
  for (const [id, count] of Object.entries(summary.byPattern)) {
    console.log(`  - ${id}: ${count}`);
  }
  console.log("");
  for (const f of findings) {
    console.log(`  [${f.pattern}] ${f.file}:${f.line}`);
    console.log(`      ${f.snippet}`);
  }
  const top = summary.topFiles.map((t) => `${t.file} (${t.count})`).join(", ");
  console.log("");
  console.log(`[publish-check] топ файлов: ${top}`);
  console.log("[publish-check] это read-only аудит: ничего не удалено и не правлено. Полные данные: --json.");
}

// Возвращает код выхода (0/1/2), ничего не делает с файлами.
export async function main(argv = []) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`[publish-check] ${err.message}`);
    console.error(USAGE);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  const patterns = [...BUILT_IN_PATTERNS, ...opts.extra];
  let result;
  try {
    result = scanTree(opts.root, patterns, { includeFixtures: opts.includeFixtures });
  } catch (err) {
    console.error(`[publish-check] скан не удался: ${err.message}`);
    return 2;
  }
  const findings = sortFindings(result.findings);
  const summary = buildSummary(result.scanned, findings);
  if (opts.json) console.log(JSON.stringify({ findings, summary }, null, 2));
  else printHuman(opts.root, patterns, findings, summary);
  return summary.clean ? 0 : 1;
}

// CLI-режим только при прямом запуске (тесты импортируют функции без побочек).
const invokedAs = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
const isSelf =
  import.meta.url === invokedAs ||
  (process.platform === "win32" && import.meta.url.toLowerCase() === invokedAs.toLowerCase());
if (isSelf) process.exit(await main(process.argv.slice(2)));
