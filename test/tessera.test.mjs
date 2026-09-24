// Tests of the Tessera issuer source (tessera.pe, the T-OpenAI/T-SpaceX/T-Kalshi tokens).
// NO NETWORK: the responses of the live CDN cdn.tesseralab.co/tessera/{symbol}.json are saved as
// fixtures (tessera-spacex.json, tessera-openai.json, tessera-kalshi.json,
// captured 2026-09-22) and all the scenarios run through an injectable fetcher.
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

// ---------- The client: parsing the live fixtures ----------

test("spacex: the identity metadata parses verbatim, all the fields — strings/null", async () => {
  const m = await fetchTokenMetadata("T-SpaceX", { fetcher: async () => okRes(FIX("tessera-spacex.json")) });
  assert.equal(m.name, "T-SpaceX");
  assert.equal(m.symbol, "tSpaceX"); // the issuer's camelCase skeleton, without a hyphen
  assert.match(m.description, /^T-SpaceX represents a loan participation right/);
  assert.match(m.description, /https:\/\/terms\.tessera\.pe$/);
  assert.equal(m.image, "https://cdn.tesseralab.co/tessera/tokenicon_T-SpaceX.svg");
  assert.equal(m.externalUrl, "https://www.tessera.pe");
  // attributes — trait pairs verbatim, the order preserved
  assert.equal(m.attributes.length, 9);
  assert.deepEqual(m.attributes[0], { traitType: "Product Type", value: "Stablecoin Loan Token" });
  assert.deepEqual(m.attributes[1], { traitType: "Underlying Exposure", value: "SpaceX" });
  assert.deepEqual(m.attributes[7], { traitType: "Redemption Trigger", value: "Divestment of Underlying Exposure" });
  assert.deepEqual(m.attributes[8], { traitType: "Terms and Conditions", value: "https://terms.tessera.pe" });
  // The contract "numbers — as strings": the top level — strings/null, attributes — pairs of strings.
  for (const [k, v] of Object.entries(m)) {
    if (k === "attributes") continue;
    assert.ok(v === null || typeof v === "string", `${k} must be a string/null`);
  }
  for (const a of m.attributes) {
    assert.equal(typeof a.traitType, "string");
    assert.ok(a.value === null || typeof a.value === "string");
  }
});

test("openai: parses, the symbol is verified by the skeleton (T-OpenAI vs tOpenAI)", async () => {
  const m = await fetchTokenMetadata("T-OpenAI", { fetcher: async () => okRes(FIX("tessera-openai.json")) });
  assert.equal(m.symbol, "tOpenAI");
  assert.deepEqual(m.attributes[1], { traitType: "Underlying Exposure", value: "OpenAI" });
  assert.equal(m.attributes[3].value, "Artificial Intelligence");
});

test("kalshi: parses, the symbol is verified by the skeleton (T-Kalshi vs tKalshi)", async () => {
  const m = await fetchTokenMetadata("T-Kalshi", { fetcher: async () => okRes(FIX("tessera-kalshi.json")) });
  assert.equal(m.symbol, "tKalshi");
  assert.deepEqual(m.attributes[1], { traitType: "Underlying Exposure", value: "Kalshi" });
  assert.equal(m.attributes[3].value, "Financial Technology & Prediction Markets");
});

test("the URL is built from the lowercased symbol (T-SpaceX -> t-spacex.json)", async () => {
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

// ---------- The client: refusals ----------

test("a symbol divergence (we asked for T-SpaceX, it served tOpenAI) — IssuerError", async () => {
  await assert.rejects(
    () => fetchTokenMetadata("T-SpaceX", { fetcher: async () => okRes(FIX("tessera-openai.json")) }),
    (err) => err instanceof IssuerError && /symbol mismatch: asked T-SpaceX, got tOpenAI/.test(err.message),
  );
});

test("a broken payload without name/symbol is rejected with a clear error", async () => {
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

test("an HTTP error is classified with the status", async () => {
  await assert.rejects(
    () => fetchTokenMetadata("T-NOPE", { fetcher: async () => ({ ok: false, status: 404, json: async () => ({}) }) }),
    (err) => err instanceof IssuerError && err.status === 404 && /HTTP 404/.test(err.message),
  );
});

test("a network failure is wrapped into an IssuerError", async () => {
  await assert.rejects(
    () => fetchTokenMetadata("T-SpaceX", { fetcher: async () => { throw new Error("ECONNREFUSED"); } }),
    (err) => err instanceof IssuerError && /network: ECONNREFUSED/.test(err.message),
  );
});

test("a broken JSON (res.json throws) — an IssuerError, not a raw SyntaxError", async () => {
  await assert.rejects(
    () =>
      fetchTokenMetadata("T-SpaceX", {
        fetcher: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } }),
      }),
    (err) => err instanceof IssuerError && /bad JSON/.test(err.message),
  );
});

test("a garbage symbol is cut before going to the network", async () => {
  for (const bad of ["", "../etc/passwd", "T SPACE", 42, null]) {
    await assert.rejects(
      () => fetchTokenMetadata(bad, { fetcher: async () => { throw new Error("must not be called"); } }),
      (err) => err instanceof IssuerError && /bad symbol/.test(err.message),
    );
  }
});

// ---------- attributes: the schema deviations -> strings/null, no inventions ----------

test("attributes not an array -> null; numeric trait values pass as strings", async () => {
  const m = await fetchTokenMetadata("T-SpaceX", {
    fetcher: async () =>
      okRes({
        name: "T-SpaceX",
        symbol: "tSpaceX",
        attributes: "not an array",
      }),
  });
  assert.equal(m.attributes, null);
  const n = await fetchTokenMetadata("T-SpaceX", {
    fetcher: async () =>
      okRes({
        name: "T-SpaceX",
        symbol: "tSpaceX",
        attributes: [
          { trait_type: "Multiplier", value: 4 }, // NFT schemas often carry numbers: as a string, without a float
          { trait_type: "Broken", value: { deep: true } }, // an object -> null, not serialized on a whim
          { value: "without a trait_type" }, // a record without a string trait_type is not invented
          "garbage",
        ],
      }),
  });
  assert.deepEqual(n.attributes, [
    { traitType: "Multiplier", value: "4" },
    { traitType: "Broken", value: null },
  ]);
});

// ---------- Honesty: events are not synthesized ----------

test("honesty: there are no event fields in the schema — the client has NO metadataToEvents", () => {
  // "Redemption Trigger" in the attributes — a verbal description without a date/ratio;
  // the module deliberately does not export an event generator, so nobody could
  // synthesize dates from a logo and trait strings.
  assert.ok(!("metadataToEvents" in tesseraModule));
});

test("honesty: the result shape — identity fields only, no dates/multipliers", async () => {
  const m = await fetchTokenMetadata("T-SpaceX", { fetcher: async () => okRes(FIX("tessera-spacex.json")) });
  assert.deepEqual(Object.keys(m).sort(), ["attributes", "description", "externalUrl", "image", "name", "symbol"]);
  for (const a of m.attributes) {
    assert.ok(!/effectiveDate|activationDate|multiplier/i.test(a.traitType), `an unexpected event field: ${a.traitType}`);
  }
});

// ---------- metadataSources: the legitimate links of the identity document ----------

test("metadataSources: external_url and the Terms and Conditions attribute — in a stable order", () => {
  const raw = FIX("tessera-spacex.json"); // the raw JSON (snake_case trait_type)
  assert.deepEqual(metadataSources(raw), ["https://www.tessera.pe", "https://terms.tessera.pe"]);
  // The same document in our client's spelling (camelCase traitType AND externalUrl —
  // ROUND7 #6: earlier the fake wore a snake_case external_url, which the real client
  // does not serve, and the test "covered" the client shape, cementing the lost-link bug)
  const client = { name: "T-SpaceX", symbol: "tSpaceX", externalUrl: "https://www.tessera.pe", attributes: [{ traitType: "Terms and Conditions", value: "https://terms.tessera.pe" }] };
  assert.deepEqual(metadataSources(client), ["https://www.tessera.pe", "https://terms.tessera.pe"]);
});

test("metadataSources: no links — empty, we do not fall; garbage — IssuerError", () => {
  assert.deepEqual(metadataSources({ name: "x", symbol: "tX" }), []);
  assert.deepEqual(metadataSources({ name: "x", symbol: "tX", attributes: [{ trait_type: "Terms and Conditions", value: 42 }] }), []);
  for (const garbage of [null, 42, "str", [], true]) {
    assert.throws(() => metadataSources(garbage), IssuerError);
  }
});
