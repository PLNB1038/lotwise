import test from "node:test";
import assert from "node:assert/strict";
import {
  loadRegistry,
  validateRegistry,
  validateRegistryEntry,
  getTokensByIssuer,
  findBySymbol,
  RegistryError,
} from "../src/registry/registry.mjs";

const good = {
  mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
  symbol: "TSLAx",
  name: "Tesla xStock",
  issuer: "backed",
  decimals: null,
  sourceUrl: "stockbasis-verified",
  verified: "carried",
};

test("валидная запись проходит", () => {
  assert.equal(validateRegistryEntry({ ...good }), true);
});

test("битый минт / неизвестный issuer / пустой символ отклоняются", () => {
  assert.throws(() => validateRegistryEntry({ ...good, mint: "0OIl" }), RegistryError);
  assert.throws(() => validateRegistryEntry({ ...good, issuer: "solayer" }), RegistryError);
  assert.throws(() => validateRegistryEntry({ ...good, symbol: "" }), RegistryError);
  assert.throws(() => validateRegistryEntry({ ...good, decimals: 8.5 }), RegistryError);
});

test("дубликаты минтов и символов отклоняются на уровне списка", () => {
  const a = { ...good };
  const dupMint = { ...good, symbol: "OTHERx", mint: good.mint };
  const dupSym = { ...good, mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp" };
  assert.throws(() => validateRegistry([a, dupMint]), /duplicate mint/);
  assert.throws(() => validateRegistry([a, dupSym]), /duplicate symbol/);
  assert.deepEqual(validateRegistry([a]), [a]);
});

test("реальный data/tokens.json валиден и покрывает все эмитенты", async () => {
  const list = await loadRegistry("data/tokens.json");
  assert.ok(list.length >= 20, `ожидали >=20 токенов, получили ${list.length}`);
  const byIssuer = getTokensByIssuer(list);
  for (const issuer of ["backed", "backpack", "prestocks", "tessera"]) {
    assert.ok(byIssuer[issuer].length > 0, `нет токенов эмитента ${issuer}`);
  }
  // минты и символы уникальны — уже проверено validateRegistry внутри loadRegistry
  assert.ok(findBySymbol(list, "TSLAx"));
  assert.ok(findBySymbol(list, "SPACEX"));
  assert.ok(findBySymbol(list, "T-OpenAI"));
  assert.equal(findBySymbol(list, "NOPE"), null);
});

test("отсутствующий файл даёт понятную ошибку", async () => {
  await assert.rejects(() => loadRegistry("data/nope.json"), RegistryError);
});

test("конвенция минтов эмитентов: backed=Xs…, prestocks=Pr… (гипотеза issuerOf реестра)", async () => {
  const list = await loadRegistry("data/tokens.json");
  for (const t of list) {
    if (t.issuer === "backed") {
      assert.ok(t.mint.startsWith("Xs"), `${t.symbol}: backed-минт обязан начинаться с Xs (${t.mint.slice(0, 6)}…)`);
    }
    if (t.issuer === "prestocks") {
      assert.ok(t.mint.startsWith("Pr"), `${t.symbol}: prestocks-минт обязан начинаться с Pr (${t.mint.slice(0, 6)}…)`);
    }
  }
});

test("план недели 1: реестр >=30 токенов, decimals обогащены у всех (null = не довели)", async () => {
  const list = await loadRegistry("data/tokens.json");
  assert.ok(list.length >= 30, `план недели 1 требует >=30 токенов, сейчас ${list.length}`);
  for (const t of list) {
    assert.ok(Number.isInteger(t.decimals), `${t.symbol}: decimals=${t.decimals}, ожидаем integer после enrich`);
  }
});
