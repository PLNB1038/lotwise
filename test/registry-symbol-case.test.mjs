// Symbol uniqueness in the registry is enforced on the CASE-INSENSITIVE key. The
// declarations channel matches symbols through toUpperCase end to end (the producer's
// ctx match, the loader's per-symbol walk, the drift maps), so a registry carrying
// "KOx" and "KOX" would bind ONE declaration line to BOTH mints — a phantom dividend
// on a token that never declared it, plus a decimalsDrift row naming a stranger's
// decimals. The original spelling stays the display authority (it is what /tokens and
// ?symbol= carry); uniqueness rides the uppercase key — the one gate the whole channel
// matches, so it must not let a case collision through.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateRegistry, loadRegistrySafe, RegistryError } from "../src/registry/registry.mjs";
import { loadDeclarationsFile } from "../src/events/declarations-file.mjs";

const M1 = "Dh9ajkSRpexkbAQm321sP8BEUJZ3wZhJCs5AoraacNc";
const M2 = "MuwHVBc3wXd7vq4p27fBRF3U9vA9vvG5xEVuAmzDkM1";

const entry = (mint, symbol) => ({ mint, symbol, name: `Token ${symbol}`, issuer: "tessera", decimals: 6 });

test("validateRegistry: case-colliding symbols are a duplicate — the declarations channel cannot tell them apart", () => {
  assert.throws(
    () => validateRegistry([entry(M1, "KOx"), entry(M2, "KOX")]),
    (e) => e instanceof RegistryError && /duplicate symbol/.test(e.message) && /case/i.test(e.message),
  );
});

test("the exact same spelling is still a duplicate, a genuinely distinct pair still loads", () => {
  assert.throws(() => validateRegistry([entry(M1, "KOx"), entry(M2, "KOx")]), /duplicate symbol/);
  const ok = validateRegistry([entry(M1, "KOx"), entry(M2, "SPYx")]);
  assert.equal(ok.length, 2, "distinct symbols pass untouched");
});

test("loadRegistrySafe: a case-colliding registry quarantines as corruption — the boot degrades loudly", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "lw-symcase-")), "tokens.json");
  writeFileSync(file, JSON.stringify([entry(M1, "KOx"), entry(M2, "KOX")]));
  const r = await loadRegistrySafe(file);
  assert.equal(r.ok, false);
  assert.equal(r.corrupted, true, "a case collision is corruption, not a loadable registry");
  assert.deepEqual(r.registry, []);
  assert.match(r.reason, /duplicate symbol/);
});

test("end to end: with the gate closed, one declaration line binds to exactly ONE mint", () => {
  const registry = validateRegistry([entry(M1, "KOx"), entry(M2, "SPYx")]);
  const file = path.join(mkdtempSync(path.join(tmpdir(), "lw-symcase-")), "declarations.json");
  writeFileSync(file, JSON.stringify([
    { symbol: "KOx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 6, sourceUrl: "https://issuer.example/dividends/q2" },
  ]));
  const r = loadDeclarationsFile(file, registry);
  assert.equal(r.ok, true, r.reason ?? "must load");
  assert.equal(r.loaded, 1, "one line, one event");
  assert.equal(r.events[0].mint, M1, "the dividend binds to the declared token only");
  assert.deepEqual(r.decimalsDrift, [], "no phantom drift from a collapsed symbol pair");
});
