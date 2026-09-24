// Tests of the PreStocks issuer source (prestocks.com, pre-IPO tokens).
// NO NETWORK: the responses of the live /metadata/{symbol}.json endpoint are saved as
// fixtures (prestocks-openai.json, prestocks-spacex.json, captured 2026-09-22)
// and all the scenarios run through an injectable fetcher.
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

// Real mints from data/tokens.json (the project registry) — for the binding check.
const OPENAI_MINT = "PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF";

// ---------- The client: parsing the fixtures ----------

test("openai: the identity metadata parses, all the fields — strings", async () => {
  const m = await fetchTokenMetadata("OPENAI", { fetcher: async () => okRes(FIX("prestocks-openai.json")) });
  assert.equal(m.name, "OpenAI PreStocks");
  assert.equal(m.symbol, "OPENAI");
  assert.equal(m.description, "OpenAI PreStocks");
  assert.equal(m.image, "https://prestocks.com/logos/openai.png");
  assert.equal(m.externalUrl, "https://prestocks.com/openai");
  assert.equal(m.terms, "https://url.prestocks.com/terms-of-service");
  // The contract "numbers — as strings": the metadata schema has no numbers at all,
  // no field has the right to arrive as a number/float.
  for (const v of Object.values(m)) assert.ok(v === null || typeof v === "string");
});

test("spacex: the symbol matches the requested one, the fields read", async () => {
  const m = await fetchTokenMetadata("SPACEX", { fetcher: async () => okRes(FIX("prestocks-spacex.json")) });
  assert.equal(m.symbol, "SPACEX");
  assert.equal(m.externalUrl, "https://prestocks.com/spacex");
  assert.equal(m.terms, "https://url.prestocks.com/terms-of-service");
});

test("the URL is built from the lowercased symbol (OpenAI -> openai.json)", async () => {
  let seen;
  await fetchTokenMetadata("OpenAI", {
    fetcher: async (url) => {
      seen = url;
      return okRes(FIX("prestocks-openai.json"));
    },
  });
  assert.equal(seen, "https://prestocks.com/metadata/openai.json");
});

// ---------- The client: refusals ----------

test("a symbol divergence (we asked for OPENAI, it served SPACEX) — IssuerError", async () => {
  await assert.rejects(
    () => fetchTokenMetadata("OPENAI", { fetcher: async () => okRes(FIX("prestocks-spacex.json")) }),
    (err) => err instanceof IssuerError && /symbol mismatch/.test(err.message),
  );
});

test("a broken payload without name/symbol is rejected with a clear error", async () => {
  await assert.rejects(
    () => fetchTokenMetadata("OPENAI", { fetcher: async () => okRes({ wrong: true }) }),
    /unexpected metadata payload/,
  );
  await assert.rejects(
    () => fetchTokenMetadata("OPENAI", { fetcher: async () => okRes({ name: "", symbol: "OPENAI" }) }),
    /unexpected metadata payload/,
  );
});

test("an HTTP error is classified with the status", async () => {
  await assert.rejects(
    () => fetchTokenMetadata("NOPE", { fetcher: async () => ({ ok: false, status: 404, json: async () => ({}) }) }),
    (err) => err instanceof IssuerError && err.status === 404,
  );
});

test("a network failure is wrapped into an IssuerError", async () => {
  await assert.rejects(
    () => fetchTokenMetadata("OPENAI", { fetcher: async () => { throw new Error("ECONNREFUSED"); } }),
    (err) => err instanceof IssuerError && /network: ECONNREFUSED/.test(err.message),
  );
});

test("a broken JSON (res.json throws) — an IssuerError, not a raw SyntaxError", async () => {
  await assert.rejects(
    () =>
      fetchTokenMetadata("OPENAI", {
        fetcher: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } }),
      }),
    (err) => err instanceof IssuerError && /bad JSON/.test(err.message),
  );
});

test("a garbage symbol is cut before going to the network", async () => {
  for (const bad of ["", "../etc/passwd", "OPEN AI", 42, null]) {
    await assert.rejects(
      () => fetchTokenMetadata(bad, { fetcher: async () => { throw new Error("must not be called"); } }),
      (err) => err instanceof IssuerError && /bad symbol/.test(err.message),
    );
  }
});

// ---------- Normalization: the issuer plan -> events ----------

test("openai: the identity schema honestly gives ZERO events (no event fields)", () => {
  const events = metadataToEvents(FIX("prestocks-openai.json"));
  assert.deepEqual(events, []);
});

test("spacex: likewise zero events", () => {
  const events = metadataToEvents(FIX("prestocks-spacex.json"), { sourceUrl: "https://prestocks.com/metadata/spacex.json" });
  assert.deepEqual(events, []);
});

test("unknown keys in the metadata are NOT lost silently: a warn to the operator, the result unchanged", () => {
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

test("garbage instead of metadata — NormalizeError", () => {
  for (const garbage of [null, 42, "str", [], true]) {
    assert.throws(() => metadataToEvents(garbage), NormalizeError);
  }
  assert.throws(() => metadataToEvents({ name: "x" }), /missing a symbol/);
});

test("metadataSources: external_url and terms — the legitimate source links", () => {
  const m = FIX("prestocks-openai.json");
  assert.deepEqual(metadataSources(m), ["https://prestocks.com/openai", "https://url.prestocks.com/terms-of-service"]);
  // the client shape (a camelCase externalUrl — as our client serves) also arrives (ROUND7 #6)
  assert.deepEqual(
    metadataSources({ externalUrl: "https://prestocks.com/openai", terms: "https://url.prestocks.com/terms-of-service" }),
    ["https://prestocks.com/openai", "https://url.prestocks.com/terms-of-service"],
  );
  assert.deepEqual(metadataSources({ symbol: "X" }), []); // no links — empty, we do not fall
  assert.throws(() => metadataSources(null), NormalizeError);
});

// ---------- The mint binding (external) and the schema ----------

test("an empty plan gives an empty binding: [] is not marked with the mint", () => {
  assert.deepEqual(bindMintAndValidate(metadataToEvents(FIX("prestocks-openai.json")), OPENAI_MINT), []);
});

test("the binding channel is alive: a synthetic REDEEM (a model of the future, not an issuer fact) passes the schema with the mint", () => {
  // This is a check of the PLUMBING of the channel (bind + validate), not a statement that
  // the issuer served such an event: there are no real event fields in the metadata schema.
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

test("a broken mint at the bind stage — NormalizeError referencing the schema", () => {
  assert.throws(
    () =>
      bindMintAndValidate(
        [{ type: "REDEEM", effectiveDate: "2026-01-15T00:00:00Z", status: "unverified", sources: ["https://x"] }],
        "not-base58",
      ),
    (err) => err instanceof NormalizeError && /failed schema/.test(err.message),
  );
});
