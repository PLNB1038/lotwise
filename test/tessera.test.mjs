// Тесты источника эмитента Tessera (tessera.pe, токены T-OpenAI/T-SpaceX/T-Kalshi).
// БЕЗ СЕТИ: ответы живого CDN cdn.tesseralab.co/tessera/{symbol}.json сохранены как
// фикстуры (tessera-spacex.json, tessera-openai.json, tessera-kalshi.json,
// сняты 2026-09-22) и все сценарии гоняются через инжектируемый fetcher.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as tesseraModule from "../src/issuer/tessera.mjs";
import { fetchTokenMetadata, metadataSources, IssuerError } from "../src/issuer/tessera.mjs";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const FIX = (name) => JSON.parse(readFileSync(path.join(dir, name), "utf8"));

const okRes = (payload) => ({ ok: true, status: 200, json: async () => payload });

// ---------- Клиент: парсинг живых фикстур ----------

test("spacex: identity-метаданные парсятся дословно, все поля — строки/null", async () => {
  const m = await fetchTokenMetadata("T-SpaceX", { fetcher: async () => okRes(FIX("tessera-spacex.json")) });
  assert.equal(m.name, "T-SpaceX");
  assert.equal(m.symbol, "tSpaceX"); // camelCase-остов эмитента, без дефиса
  assert.match(m.description, /^T-SpaceX represents a loan participation right/);
  assert.match(m.description, /https:\/\/terms\.tessera\.pe$/);
  assert.equal(m.image, "https://cdn.tesseralab.co/tessera/tokenicon_T-SpaceX.svg");
  assert.equal(m.externalUrl, "https://www.tessera.pe");
  // attributes — trait-пары дословно, порядок сохранён
  assert.equal(m.attributes.length, 9);
  assert.deepEqual(m.attributes[0], { traitType: "Product Type", value: "Stablecoin Loan Token" });
  assert.deepEqual(m.attributes[1], { traitType: "Underlying Exposure", value: "SpaceX" });
  assert.deepEqual(m.attributes[7], { traitType: "Redemption Trigger", value: "Divestment of Underlying Exposure" });
  assert.deepEqual(m.attributes[8], { traitType: "Terms and Conditions", value: "https://terms.tessera.pe" });
  // Контракт «числа — строками»: верхний уровень — строки/null, attributes — пары строк.
  for (const [k, v] of Object.entries(m)) {
    if (k === "attributes") continue;
    assert.ok(v === null || typeof v === "string", `${k} должен быть строкой/null`);
  }
  for (const a of m.attributes) {
    assert.equal(typeof a.traitType, "string");
    assert.ok(a.value === null || typeof a.value === "string");
  }
});

test("openai: парсится, символ сверяется по остову (T-OpenAI vs tOpenAI)", async () => {
  const m = await fetchTokenMetadata("T-OpenAI", { fetcher: async () => okRes(FIX("tessera-openai.json")) });
  assert.equal(m.symbol, "tOpenAI");
  assert.deepEqual(m.attributes[1], { traitType: "Underlying Exposure", value: "OpenAI" });
  assert.equal(m.attributes[3].value, "Artificial Intelligence");
});

test("kalshi: парсится, символ сверяется по остову (T-Kalshi vs tKalshi)", async () => {
  const m = await fetchTokenMetadata("T-Kalshi", { fetcher: async () => okRes(FIX("tessera-kalshi.json")) });
  assert.equal(m.symbol, "tKalshi");
  assert.deepEqual(m.attributes[1], { traitType: "Underlying Exposure", value: "Kalshi" });
  assert.equal(m.attributes[3].value, "Financial Technology & Prediction Markets");
});

test("URL строится из символа в нижнем регистре (T-SpaceX -> t-spacex.json)", async () => {
  const seen = [];
  await fetchTokenMetadata("T-SpaceX", {
    fetcher: async (url) => {
      seen.push(url);
      return okRes(FIX("tessera-spacex.json"));
    },
  });
  await fetchTokenMetadata("t-kalshi", {
    fetcher: async (url) => {
      seen.push(url);
      return okRes(FIX("tessera-kalshi.json"));
    },
  });
  assert.deepEqual(seen, [
    "https://cdn.tesseralab.co/tessera/t-spacex.json",
    "https://cdn.tesseralab.co/tessera/t-kalshi.json",
  ]);
});

// ---------- Клиент: отказы ----------

test("расхождение символа (спросили T-SpaceX, отдали tOpenAI) — IssuerError", async () => {
  await assert.rejects(
    () => fetchTokenMetadata("T-SpaceX", { fetcher: async () => okRes(FIX("tessera-openai.json")) }),
    (err) => err instanceof IssuerError && /symbol mismatch: asked T-SpaceX, got tOpenAI/.test(err.message),
  );
});

test("битый payload без name/symbol отклоняется понятной ошибкой", async () => {
  await assert.rejects(
    () => fetchTokenMetadata("T-SpaceX", { fetcher: async () => okRes({ wrong: true }) }),
    /unexpected metadata payload/,
  );
  await assert.rejects(
    () => fetchTokenMetadata("T-SpaceX", { fetcher: async () => okRes({ name: "", symbol: "tSpaceX" }) }),
    /unexpected metadata payload/,
  );
  await assert.rejects(
    () => fetchTokenMetadata("T-SpaceX", { fetcher: async () => okRes({ name: "T-SpaceX", symbol: "" }) }),
    /unexpected metadata payload/,
  );
});

test("HTTP-ошибка классифицируется со статусом", async () => {
  await assert.rejects(
    () => fetchTokenMetadata("T-NOPE", { fetcher: async () => ({ ok: false, status: 404, json: async () => ({}) }) }),
    (err) => err instanceof IssuerError && err.status === 404 && /HTTP 404/.test(err.message),
  );
});

test("отказ сети оборачивается в IssuerError", async () => {
  await assert.rejects(
    () => fetchTokenMetadata("T-SpaceX", { fetcher: async () => { throw new Error("ECONNREFUSED"); } }),
    (err) => err instanceof IssuerError && /network: ECONNREFUSED/.test(err.message),
  );
});

test("битый JSON (res.json кидает) — IssuerError, не сырой SyntaxError", async () => {
  await assert.rejects(
    () =>
      fetchTokenMetadata("T-SpaceX", {
        fetcher: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } }),
      }),
    (err) => err instanceof IssuerError && /bad JSON/.test(err.message),
  );
});

test("мусорный символ режется до похода в сеть", async () => {
  for (const bad of ["", "../etc/passwd", "T SPACE", 42, null]) {
    await assert.rejects(
      () => fetchTokenMetadata(bad, { fetcher: async () => { throw new Error("не должен вызываться"); } }),
      (err) => err instanceof IssuerError && /bad symbol/.test(err.message),
    );
  }
});

// ---------- attributes: отклонения схемы -> строки/null, без выдумок ----------

test("attributes не массив -> null; числовые trait-значения проходят строками", async () => {
  const m = await fetchTokenMetadata("T-SpaceX", {
    fetcher: async () =>
      okRes({
        name: "T-SpaceX",
        symbol: "tSpaceX",
        attributes: "не массив",
      }),
  });
  assert.equal(m.attributes, null);
  const n = await fetchTokenMetadata("T-SpaceX", {
    fetcher: async () =>
      okRes({
        name: "T-SpaceX",
        symbol: "tSpaceX",
        attributes: [
          { trait_type: "Multiplier", value: 4 }, // NFT-схемы часто несут числа: строкой, без float
          { trait_type: "Broken", value: { deep: true } }, // объект -> null, не сериализуем наугад
          { value: "без trait_type" }, // запись без строкового trait_type не выдумывается
          "мусор",
        ],
      }),
  });
  assert.deepEqual(n.attributes, [
    { traitType: "Multiplier", value: "4" },
    { traitType: "Broken", value: null },
  ]);
});

// ---------- Честность: события не синтезируются ----------

test("честность: в схеме нет полей событий — metadataToEvents у клиента НЕТ", () => {
  // «Redemption Trigger» в attributes — словесное описание без даты/коэффициента;
  // модуль принципиально не экспортирует генератор событий, чтобы никто не смог
  // синтезировать даты из логотипа и trait-строк.
  assert.ok(!("metadataToEvents" in tesseraModule));
});

test("честность: форма результата — только identity-поля, никаких дат/множителей", async () => {
  const m = await fetchTokenMetadata("T-SpaceX", { fetcher: async () => okRes(FIX("tessera-spacex.json")) });
  assert.deepEqual(Object.keys(m).sort(), ["attributes", "description", "externalUrl", "image", "name", "symbol"]);
  for (const a of m.attributes) {
    assert.ok(!/effectiveDate|activationDate|multiplier/i.test(a.traitType), `неожиданное событийное поле: ${a.traitType}`);
  }
});

// ---------- metadataSources: легитимные ссылки identity-документа ----------

test("metadataSources: external_url и атрибут Terms and Conditions — в стабильном порядке", () => {
  const raw = FIX("tessera-spacex.json"); // сырой JSON (snake_case trait_type)
  assert.deepEqual(metadataSources(raw), ["https://www.tessera.pe", "https://terms.tessera.pe"]);
  // Тот же документ в написании нашего клиента (camelCase traitType) — тот же результат.
  const client = { name: "T-SpaceX", symbol: "tSpaceX", external_url: "https://www.tessera.pe", attributes: [{ traitType: "Terms and Conditions", value: "https://terms.tessera.pe" }] };
  assert.deepEqual(metadataSources(client), ["https://www.tessera.pe", "https://terms.tessera.pe"]);
});

test("metadataSources: без ссылок — пусто, не падаем; мусор — IssuerError", () => {
  assert.deepEqual(metadataSources({ name: "x", symbol: "tX" }), []);
  assert.deepEqual(metadataSources({ name: "x", symbol: "tX", attributes: [{ trait_type: "Terms and Conditions", value: 42 }] }), []);
  for (const garbage of [null, 42, "str", [], true]) {
    assert.throws(() => metadataSources(garbage), IssuerError);
  }
});
