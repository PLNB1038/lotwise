// Тесты источника эмитента PreStocks (prestocks.com, pre-IPO токены).
// БЕЗ СЕТИ: ответы живого эндпоинта /metadata/{symbol}.json сохранены как
// фикстуры (prestocks-openai.json, prestocks-spacex.json, сняты 2026-09-22)
// и все сценарии гоняются через инжектируемый fetcher.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchTokenMetadata, IssuerError } from "../src/issuer/prestocks.mjs";
import { metadataToEvents, metadataSources, bindMintAndValidate, NormalizeError } from "../src/events/normalize-prestocks.mjs";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const FIX = (name) => JSON.parse(readFileSync(path.join(dir, name), "utf8"));

const okRes = (payload) => ({ ok: true, status: 200, json: async () => payload });

// Реальные минты из data/tokens.json (реестр проекта) — для проверки привязки.
const OPENAI_MINT = "PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF";

// ---------- Клиент: парсинг фикстур ----------

test("openai: identity-метаданные парсятся, все поля — строки", async () => {
  const m = await fetchTokenMetadata("OPENAI", { fetcher: async () => okRes(FIX("prestocks-openai.json")) });
  assert.equal(m.name, "OpenAI PreStocks");
  assert.equal(m.symbol, "OPENAI");
  assert.equal(m.description, "OpenAI PreStocks");
  assert.equal(m.image, "https://prestocks.com/logos/openai.png");
  assert.equal(m.externalUrl, "https://prestocks.com/openai");
  assert.equal(m.terms, "https://url.prestocks.com/terms-of-service");
  // Контракт «числа — строками»: в схеме метаданных чисел нет вообще,
  // ни одно поле не имеет права приехать числом/float-ом.
  for (const v of Object.values(m)) assert.ok(v === null || typeof v === "string");
});

test("spacex: символ совпадает с запрошенным, поля читаются", async () => {
  const m = await fetchTokenMetadata("SPACEX", { fetcher: async () => okRes(FIX("prestocks-spacex.json")) });
  assert.equal(m.symbol, "SPACEX");
  assert.equal(m.externalUrl, "https://prestocks.com/spacex");
  assert.equal(m.terms, "https://url.prestocks.com/terms-of-service");
});

test("URL строится из символа в нижнем регистре (OpenAI -> openai.json)", async () => {
  let seen;
  await fetchTokenMetadata("OpenAI", {
    fetcher: async (url) => {
      seen = url;
      return okRes(FIX("prestocks-openai.json"));
    },
  });
  assert.equal(seen, "https://prestocks.com/metadata/openai.json");
});

// ---------- Клиент: отказы ----------

test("расхождение символа (спросили OPENAI, отдали SPACEX) — IssuerError", async () => {
  await assert.rejects(
    () => fetchTokenMetadata("OPENAI", { fetcher: async () => okRes(FIX("prestocks-spacex.json")) }),
    (err) => err instanceof IssuerError && /symbol mismatch/.test(err.message),
  );
});

test("битый payload без name/symbol отклоняется понятной ошибкой", async () => {
  await assert.rejects(
    () => fetchTokenMetadata("OPENAI", { fetcher: async () => okRes({ wrong: true }) }),
    /unexpected metadata payload/,
  );
  await assert.rejects(
    () => fetchTokenMetadata("OPENAI", { fetcher: async () => okRes({ name: "", symbol: "OPENAI" }) }),
    /unexpected metadata payload/,
  );
});

test("HTTP-ошибка классифицируется со статусом", async () => {
  await assert.rejects(
    () => fetchTokenMetadata("NOPE", { fetcher: async () => ({ ok: false, status: 404, json: async () => ({}) }) }),
    (err) => err instanceof IssuerError && err.status === 404,
  );
});

test("отказ сети оборачивается в IssuerError", async () => {
  await assert.rejects(
    () => fetchTokenMetadata("OPENAI", { fetcher: async () => { throw new Error("ECONNREFUSED"); } }),
    (err) => err instanceof IssuerError && /network: ECONNREFUSED/.test(err.message),
  );
});

test("битый JSON (res.json кидает) — IssuerError, не сырой SyntaxError", async () => {
  await assert.rejects(
    () =>
      fetchTokenMetadata("OPENAI", {
        fetcher: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } }),
      }),
    (err) => err instanceof IssuerError && /bad JSON/.test(err.message),
  );
});

test("мусорный символ режется до похода в сеть", async () => {
  for (const bad of ["", "../etc/passwd", "OPEN AI", 42, null]) {
    await assert.rejects(
      () => fetchTokenMetadata(bad, { fetcher: async () => { throw new Error("не должен вызываться"); } }),
      (err) => err instanceof IssuerError && /bad symbol/.test(err.message),
    );
  }
});

// ---------- Нормализация: план эмитента -> события ----------

test("openai: identity-схема честно даёт НОЛЬ событий (полей событий нет)", () => {
  const events = metadataToEvents(FIX("prestocks-openai.json"));
  assert.deepEqual(events, []);
});

test("spacex: аналогично ноль событий", () => {
  const events = metadataToEvents(FIX("prestocks-spacex.json"), { sourceUrl: "https://prestocks.com/metadata/spacex.json" });
  assert.deepEqual(events, []);
});

test("неизвестные ключи в метаданных НЕ теряются молча: warn оператору, результат прежний", () => {
  const errors = [];
  const orig = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const events = metadataToEvents({ ...FIX("prestocks-openai.json"), splitRatio: "2/1" });
    assert.deepEqual(events, []);
  } finally {
    console.error = orig;
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0], /normalize-prestocks/);
  assert.match(errors[0], /splitRatio/);
});

test("мусор вместо метаданных — NormalizeError", () => {
  for (const garbage of [null, 42, "str", [], true]) {
    assert.throws(() => metadataToEvents(garbage), NormalizeError);
  }
  assert.throws(() => metadataToEvents({ name: "x" }), /missing a symbol/);
});

test("metadataSources: external_url и terms — легитимные ссылки-источники", () => {
  const m = FIX("prestocks-openai.json");
  assert.deepEqual(metadataSources(m), ["https://prestocks.com/openai", "https://url.prestocks.com/terms-of-service"]);
  // клиентская форма (camelCase externalUrl — как отдаёт наш клиент) тоже доезжает (ROUND7 №6)
  assert.deepEqual(
    metadataSources({ externalUrl: "https://prestocks.com/openai", terms: "https://url.prestocks.com/terms-of-service" }),
    ["https://prestocks.com/openai", "https://url.prestocks.com/terms-of-service"],
  );
  assert.deepEqual(metadataSources({ symbol: "X" }), []); // без ссылок — пусто, не падаем
  assert.throws(() => metadataSources(null), NormalizeError);
});

// ---------- Привязка минта (снаружи) и схема ----------

test("пустой план даёт пустую привязку: [] минтом не помечается", () => {
  assert.deepEqual(bindMintAndValidate(metadataToEvents(FIX("prestocks-openai.json")), OPENAI_MINT), []);
});

test("канал привязки жив: синтетическое REDEEM (модель будущего, не факт эмитента) проходит схему с минтом", () => {
  // Это проверка ПЛОМБИРОВКИ канала (bind + validate), а не утверждение, что
  // эмитент такое событие отдал: реальных полей событий в схеме метаданных нет.
  const modeled = [
    {
      type: "REDEEM",
      effectiveDate: "2026-01-15T00:00:00Z",
      status: "unverified",
      sources: metadataSources(FIX("prestocks-openai.json")),
    },
  ];
  const bound = bindMintAndValidate(modeled, OPENAI_MINT);
  assert.equal(bound.length, 1);
  assert.equal(bound[0].mint, OPENAI_MINT);
  assert.equal(bound[0].type, "REDEEM");
});

test("битый минт на bind-этапе — NormalizeError со ссылкой на схему", () => {
  assert.throws(
    () =>
      bindMintAndValidate(
        [{ type: "REDEEM", effectiveDate: "2026-01-15T00:00:00Z", status: "unverified", sources: ["https://x"] }],
        "не-бейз58",
      ),
    (err) => err instanceof NormalizeError && /failed schema/.test(err.message),
  );
});
