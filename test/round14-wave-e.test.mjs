// Раунд 14 — волна E, кодовые фиксы (RED → GREEN):
//   E2-1 [P3] parseScaledUiAmount: ts за диапазоном ECMAScript Date (|ts*1000| > 8.64e15)
//            давал голый RangeError из toISOString() — мимо типизированной ошибки модуля;
//            на /onchain это 503 kind:null с утечкой внутреннего текста. Гвард + ScaledUiError.
//   E4-1 [P3] isValidAddress проверял только charset+длину: 41×«1» (base58 ≠ 32 байта)
//            проходил в scan → getSignaturesForAddress → 503 «rpc» на перманентно битый
//            ввод. Фикс: base58-декод и ровно 32 байта → честный 400 ДО сканера.
//   E2-SSRF  Данлист доставки не знал CGNAT 100.64/10 (вебхук доставнет в tailnet!),
//            6to4 2002::/16 и NAT64 64:ff9b::/96.
//   E3-4     EADDRINUSE ловился ПОСЛЕ полного бута (RPC-квота горела на двойном запуске):
//            checkPortAvailable ДО бут-I/O, в духе ROUND7 №10.
//   E3-2     Журнал: read-modify-write без межпроцессного лока — чужая запись в окне
//            «бут прочитал → персистнул» молча затиралась. saveJournalMerged:
//            merge-under-lock (наши минты выигрывают, чужие переживают).
//   E3-3     enrich-decimals: process.exit над живым undici-сокетом = 0xC0000409 на win
//            (недозакрытый остаток D2); фикс process.exitCode + флаг --api для тестов.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseScaledUiAmount, ScaledUiError } from "../src/issuer/scaled-ui.mjs";
import { isValidAddress } from "../src/wallet/scan.mjs";
import { validateSubscription } from "../src/webhooks/subscriptions.mjs";
import { checkPortAvailable } from "../src/cli/flags.mjs";
import { saveJournalMerged, loadJournalOnchain } from "../src/events/journal.mjs";
import { createApiServer } from "../src/api/server.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const mintState = (state) => ({
  owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  data: { parsed: { info: { decimals: 8, extensions: [{ extension: "scaledUiAmountConfig", state: { newMultiplierEffectiveTimestamp: 0, ...state } }] } } },
});

// ---- E2-1: scaled-ui диапазон таймстампа ----

test("scaled-ui: pending c ts за диапазоном Date — ScaledUiError, не голый RangeError", () => {
  assert.throws(
    () => parseScaledUiAmount(mintState({ multiplier: "1", newMultiplier: "2", newMultiplierEffectiveTimestamp: 8_640_000_000_001 })),
    ScaledUiError,
    "ts*1000 за +8.64e15 мс — типизированный отказ модуля",
  );
  assert.throws(
    () => parseScaledUiAmount(mintState({ multiplier: "1", newMultiplier: "2", newMultiplierEffectiveTimestamp: -8_640_000_000_001 })),
    ScaledUiError,
    "отрицательная граница — тот же класс",
  );
});

test("scaled-ui: ровно граница 8_640_000_000_000 — валидная дата, без отказа", () => {
  const r = parseScaledUiAmount(mintState({ multiplier: "1", newMultiplier: "2", newMultiplierEffectiveTimestamp: 8_640_000_000_000 }));
  assert.equal(typeof r.pendingEffectiveDate, "string");
  assert.ok(r.pendingEffectiveDate.startsWith("+275760"), "максимальная представимая дата");
});

// ---- E4-1: структурная base58-валидация pubkey ----

test("wallet: isValidAddress — base58 обязан декодироваться ровно в 32 байта", () => {
  assert.equal(isValidAddress("1".repeat(41)), false, "41×«1»: charset/длина ок, но не 32 байта");
  assert.equal(isValidAddress("2".repeat(32)), false, "32×«2»: число слишком мало для 32 байт");
  assert.equal(isValidAddress("DivAccMint" + "1".repeat(34)), true, "44-символьная синтетика — валидна");
  assert.equal(isValidAddress("XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W"), true, "живой минт SPYx");
});

test("api: /lots и /accruals со структурно битым pubkey — 400 ДО сканера, не 503 rpc", async () => {
  let scannerCalls = 0;
  const server = await createApiServer({
    registry: [{ mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", symbol: "SPYx", name: "S&P", decimals: 8, issuer: "test" }],
    walletScanner: async () => { scannerCalls++; throw new Error("must not be called"); },
  });
  const { port } = server.address();
  try {
    for (const ep of ["/lots?address=", "/accruals?symbol=SPYx&address="]) {
      const res = await fetch(`http://127.0.0.1:${port}${ep}${"1".repeat(41)}`);
      assert.equal(res.status, 400, `${ep}: перманентно битый адрес — честный 400`);
      const body = await res.json();
      assert.match(body.error, /pubkey/i);
    }
    assert.equal(scannerCalls, 0, "сканер не потратил ни одного RPC-вызова");
  } finally {
    server.close();
  }
});

// ---- E2-SSRF: CGNAT / 6to4 / NAT64 ----

const sub = (url) => ({ id: "wh_x", url, symbols: "*", secret: "s", createdAt: "2026-09-24T00:00:00.000Z", active: true });

test("webhooks: CGNAT 100.64/10 — приватная зона доставки (включая tailnet)", () => {
  assert.throws(() => validateSubscription(sub("http://100.89.32.108/hook")), /not delivered to/);
  assert.throws(() => validateSubscription(sub("http://100.64.0.1/hook")), /not delivered to/);
  assert.throws(() => validateSubscription(sub("http://100.127.255.254/hook")), /not delivered to/);
  assert.throws(() => validateSubscription(sub("http://[::ffff:100.64.0.1]/hook")), /not delivered to/, "мапнутый v4 — тот же класс");
  validateSubscription(sub("http://100.128.0.1/hook")); // первый публичный за CGNAT — ок
});

test("webhooks: 6to4 2002::/16 и NAT64 64:ff9b::/96 — переходные зоны вне доставки", () => {
  assert.throws(() => validateSubscription(sub("http://[2002:0a00:0001::]/hook")), /not delivered to/, "6to4 от 10.0.0.1");
  assert.throws(() => validateSubscription(sub("http://[2002::]/hook")), /not delivered to/);
  assert.throws(() => validateSubscription(sub("http://[64:ff9b::a9fe:a9fe]/hook")), /not delivered to/, "NAT64 c metadata внутри");
  assert.throws(() => validateSubscription(sub("http://[64:ff9b::]/hook")), /not delivered to/, "вся зона NAT64 — без разбора embedded");
});

// ---- E3-4: порт занят — отказ ДО бут-I/O ----

test("flags: checkPortAvailable — занятый порт отвергается, свободный проходит", async () => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
  const busyPort = blocker.address().port;
  await assert.rejects(
    () => checkPortAvailable(busyPort, "127.0.0.1"),
    (err) => err.name === "ServeArgsError" && err.flag === "--port" && /in use/i.test(err.message),
  );
  await new Promise((r) => blocker.close(r));
  await checkPortAvailable(busyPort, "127.0.0.1"); // освободился — ок
});

// ---- E3-2: merge-under-lock журнала ----

test("journal: saveJournalMerged — чужой минт переживает персист бута", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lw-j14-"));
  try {
    const jp = path.join(dir, "onchain-journal.json");
    const foreign = { lastEffective: "3", observedAt: "2026-09-24T00:00:00.000Z", events: [] };
    writeFileSync(jp, JSON.stringify({ OTHERMINT: foreign }));
    saveJournalMerged(jp, { MYMINT: { lastEffective: "5", observedAt: "2026-09-24T00:00:00.000Z", events: [] } });
    const after = JSON.parse(readFileSync(jp, "utf8"));
    assert.ok(after.OTHERMINT, "чужая запись не затёрта");
    assert.ok(after.MYMINT, "наша запись на месте");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("journal: saveJournalMerged — запись, положенная ПОСЛЕ чтения бута, тоже переживает", () => {
  // сценарий e3-4b: бут прочитал снапшот {EW1}, внешний писатель дописал {EW2},
  // бут персистит свой снапшот — раньше EW2 молча исчезал
  const dir = mkdtempSync(path.join(tmpdir(), "lw-j14b-"));
  try {
    const jp = path.join(dir, "onchain-journal.json");
    writeFileSync(jp, JSON.stringify({ EXTERNALWRITER: { lastEffective: "1", observedAt: "2026-09-24T00:00:00.000Z", events: [] } }));
    const bootSnapshot = loadJournalOnchain(jp).journal; // «бут прочитал»
    writeFileSync(jp, JSON.stringify({ ...bootSnapshot, EXTERNALWRITER2: { lastEffective: "2", observedAt: "2026-09-24T00:01:00.000Z", events: [] } }));
    saveJournalMerged(jp, bootSnapshot); // «бут персистил свой снапшот»
    const after = JSON.parse(readFileSync(jp, "utf8"));
    assert.ok(after.EXTERNALWRITER, "первый писатель пережил");
    assert.ok(after.EXTERNALWRITER2, "второй (поздний) писатель пережил — главная находка e3-4b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("journal: saveJournalMerged — свой минт выигрывает у лежащей на диске версии", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lw-j14c-"));
  try {
    const jp = path.join(dir, "onchain-journal.json");
    writeFileSync(jp, JSON.stringify({ MYMINT: { lastEffective: "1", observedAt: "2026-09-01T00:00:00.000Z", events: [] } }));
    saveJournalMerged(jp, { MYMINT: { lastEffective: "6", observedAt: "2026-09-24T00:00:00.000Z", events: [] } });
    const after = JSON.parse(readFileSync(jp, "utf8"));
    assert.equal(after.MYMINT.lastEffective, "6", "свежее наблюдение бута перезаписывает протухшее");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- E3-3: enrich-decimals exit-код + --api ----

test("cli: enrich-decimals на недоступном/отказном API — exit 1, не 0xC0000409", async () => {
  const bad = http.createServer((req, res) => { res.writeHead(400); res.end("nope"); });
  await new Promise((r) => bad.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(path.join(tmpdir(), "lw-enr14-"));
  try {
    writeFileSync(path.join(dir, "data-tokens.json"), JSON.stringify([])); // пустой реестр: ids= → 400
    // spawn (не spawnSync!): локальный сервер живёт в ЭТОМ процессе — sync-ожидание
    // блокирует event loop и мёртвым локом ловит самого себя (грабли раунда 14)
    const child = spawn(process.execPath, [
      path.join(ROOT, "scripts", "enrich-decimals.mjs"),
      "--registry", path.join(dir, "data-tokens.json"),
      "--api", `http://127.0.0.1:${bad.address().port}/price`,
    ]);
    let stderr = "";
    child.stderr.on("data", (c) => { stderr += c; });
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 1, `честный код отказа (stderr: ${stderr.slice(0, 200)})`);
    assert.ok(code !== 3221226505, "undici-краш процесса не случился");
  } finally {
    await new Promise((r) => bad.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});
