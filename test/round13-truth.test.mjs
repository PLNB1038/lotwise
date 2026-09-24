// Регрессионные тесты раунда 13 — охота 24.09 двумя агентами (README-vs-code + watch-лист).
//   R13-1 [P3] redactUrls регистрозависим: --rpc HTTP://user:SECRET@… — undici вшивает
//            URL вербатимом (верхняя схема), фикс R11 промахивался, креды уезжали
//            в 503-тело посетителю. Хвост C3-1, найден watch-агентом.
//   R13-2 [P3] /tokens?issuer= и /events?type= молча отдавали 200 [] на неизвестные
//            значения — README сам называет эмитентов «xStocks/Backed 16», а контракт
//            «400 вместо пустоты» работал только для symbol/mint (ROUND7 №1-класс).
//   R13-3 [P4] DNS-мусор в --host («no-such-host.invalid») проходил синхронный
//            лексический гвард и прожигал весь бут-I/O (~15 RPC + история xStocks),
//            падая только на listen. Резолв ДО бута, отказ в духе ROUND9 №1.
//   R13-4 [P4] README-архитектура не упоминала src/cli/ — правится в README (не тест).
import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/api/server.mjs";
import { RpcClient, RpcError } from "../src/ingest/rpc.mjs";

const MINT_A = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const MINT_B = "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp";

const registry = [
  { symbol: "SPYx", name: "S&P 500 xStock", issuer: "backed", mint: MINT_A, decimals: 8 },
  { symbol: "T-SpaceX", name: "Tessera SpaceX", issuer: "tessera", mint: MINT_B, decimals: 9 },
];
const events = [
  { type: "MULTIPLIER_CHANGE", mint: MINT_A, effectiveDate: "2026-06-10T00:00:00.000Z", status: "confirmed", sources: ["test"], multiplierFrom: "1", multiplierTo: "2", reason: "test rebase" },
];

async function withServer(fn) {
  const server = await createApiServer({ registry, events });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

// ---- R13-2 [P3]: фильтры issuer/type — честный 400 со словарём, не тихий [] ----

test("/tokens?issuer=Backed (написание из README) — 400 со словарём валидных ключей, не 200 []", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/tokens?issuer=${encodeURIComponent("Backed")}`);
    assert.equal(res.status, 400, "неизвестный эмитент = отказ с причиной (конвенция symbol/mint)");
    const body = await res.json();
    assert.match(body.error, /Backed/, "причина называет сам ввод");
    assert.match(body.error, /backed/, "словарь валидных ключей виден в причине");
  });
});

test("/tokens?issuer=bogus — 400; ?issuer=backed — 200 с токенами семейства; без фильтра — весь реестр", async () => {
  await withServer(async (base) => {
    const bad = await fetch(`${base}/tokens?issuer=bogus`);
    assert.equal(bad.status, 400);
    const ok = await fetch(`${base}/tokens?issuer=backed`);
    assert.equal(ok.status, 200);
    const list = await ok.json();
    assert.ok(Array.isArray(list) && list.length > 0, "валидный фильтр не пуст");
    assert.ok(list.every((t) => t.issuer === "backed"));
    const all = await fetch(`${base}/tokens`);
    assert.equal((await all.json()).length, registry.length);
  });
});

test("/events?type=BOGUS — 400 со словарём шести типов; валидный тип — 200", async () => {
  await withServer(async (base) => {
    const bad = await fetch(`${base}/events?symbol=SPYx&type=BOGUS`);
    assert.equal(bad.status, 400, "тихий [] на мусорный type неотличим от «событий не было»");
    const body = await bad.json();
    assert.match(body.error, /BOGUS/);
    assert.match(body.error, /SPLIT/);
    assert.match(body.error, /MULTIPLIER_CHANGE/);
    const ok = await fetch(`${base}/events?symbol=SPYx&type=MULTIPLIER_CHANGE`);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).length, 1);
  });
});

// ---- R13-1 [P3]: редакция URL — верхний регистр схемы ----

test("rpc: URL-креды с ВЕРХНЕЙ схемой (HTTP://) тоже редактируются — не покидают клиент", async () => {
  const leak = "Request cannot be constructed from a URL that includes credentials: HTTP://user:TOPSECRET@127.0.0.1:9/x";
  const client = new RpcClient({
    endpoint: "HTTP://user:TOPSECRET@127.0.0.1:9/x",
    fetcher: async () => { throw new TypeError(leak); },
    sleep: async () => {}, minIntervalMs: 0, maxRetries: 0,
  });
  await assert.rejects(() => client.call("m", []), (err) => {
    assert.ok(!err.message.includes("TOPSECRET"), `креды не утекают (got: ${err.message})`);
    assert.ok(!/https?:\/\//i.test(err.message), "полный URL не утекает ни в каком регистре схемы");
    return err instanceof RpcError && err.kind === "network";
  });
});

// ---- R13-3 [P4]: DNS-резолв --host ДО бута ----

test("flags: assertHostResolvable — нерезолвимый хост даёт ServeArgsError с кодом DNS", async () => {
  const { assertHostResolvable, ServeArgsError } = await import("../src/cli/flags.mjs");
  await assert.rejects(
    () => assertHostResolvable("no-such-host.invalid", async () => {
      const e = new Error("getaddrinfo ENOTFOUND no-such-host.invalid");
      e.code = "ENOTFOUND";
      throw e;
    }),
    (err) => err instanceof ServeArgsError && err.flag === "--host" && /ENOTFOUND/.test(err.message),
  );
});

test("flags: assertHostResolvable — резолвимый хост проходит без отказа", async () => {
  const { assertHostResolvable } = await import("../src/cli/flags.mjs");
  await assertHostResolvable("127.0.0.1", async () => ({ address: "127.0.0.1" }));
});
