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

test("a valid record passes", () => {
  assert.equal(validateRegistryEntry({ ...good }), true);
});

test("a broken mint / an unknown issuer / an empty symbol are rejected", () => {
  assert.throws(() => validateRegistryEntry({ ...good, mint: "0OIl" }), RegistryError);
  assert.throws(() => validateRegistryEntry({ ...good, issuer: "solayer" }), RegistryError);
  assert.throws(() => validateRegistryEntry({ ...good, symbol: "" }), RegistryError);
  assert.throws(() => validateRegistryEntry({ ...good, decimals: 8.5 }), RegistryError);
});

test("duplicate mints and symbols are rejected at the list level", () => {
  const a = { ...good };
  const dupMint = { ...good, symbol: "OTHERx", mint: good.mint };
  const dupSym = { ...good, mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp" };
  assert.throws(() => validateRegistry([a, dupMint]), /duplicate mint/);
  assert.throws(() => validateRegistry([a, dupSym]), /duplicate symbol/);
  assert.deepEqual(validateRegistry([a]), [a]);
});

test("the real data/tokens.json is valid and covers all the issuers", async () => {
  const list = await loadRegistry("data/tokens.json");
  assert.ok(list.length >= 20, `expected >=20 tokens, got ${list.length}`);
  const byIssuer = getTokensByIssuer(list);
  for (const issuer of ["backed", "backpack", "prestocks", "tessera"]) {
    assert.ok(byIssuer[issuer].length > 0, `no tokens of the issuer ${issuer}`);
  }
  // the mints and the symbols are unique — already verified by validateRegistry inside loadRegistry
  assert.ok(findBySymbol(list, "TSLAx"));
  assert.ok(findBySymbol(list, "SPACEX"));
  assert.ok(findBySymbol(list, "T-OpenAI"));
  assert.equal(findBySymbol(list, "NOPE"), null);
});

test("a missing file gives a clear error", async () => {
  await assert.rejects(() => loadRegistry("data/nope.json"), RegistryError);
});

test("the mints convention of the issuers: backed=Xs…, prestocks=Pr… (the issuerOf hypothesis of the registry)", async () => {
  const list = await loadRegistry("data/tokens.json");
  for (const t of list) {
    if (t.issuer === "backed") {
      assert.ok(t.mint.startsWith("Xs"), `${t.symbol}: a backed mint must start with Xs (${t.mint.slice(0, 6)}…)`);
    }
    if (t.issuer === "prestocks") {
      assert.ok(t.mint.startsWith("Pr"), `${t.symbol}: a prestocks mint must start with Pr (${t.mint.slice(0, 6)}…)`);
    }
  }
});

test("the week-1 plan: the registry >=30 tokens, the decimals enriched for all (null = not finished)", async () => {
  const list = await loadRegistry("data/tokens.json");
  assert.ok(list.length >= 30, `the week-1 plan requires >=30 tokens, now ${list.length}`);
  for (const t of list) {
    assert.ok(Number.isInteger(t.decimals), `${t.symbol}: decimals=${t.decimals}, an integer expected after enrich`);
  }
});
