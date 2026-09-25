// regression tests — the finding LW2_tokens_json_write_non_atomic
// (the gravest finding of the day): a truncated data/tokens.json killed the service WHOLE —
// loadRegistry at the top level of serve.mjs without a catch threw RegistryError → unhandled
// rejection, with no degraded mode and no "corrupted"-class diagnostics
// (unlike the journal). Plus both writers of tokens.json (build-registry,
// enrich-decimals) wrote non-atomically, and enrich-decimals rewrote the file even
// at filled=0 — every script walk repeated the interrupted-write window for no reason.
// Contract:
//   (1) loadRegistrySafe — a boot with degradation: corruption ≠ the death of the process, the evidence
//       is preserved nearby (the journal pattern), an empty registry, the corrupted flag outward;
//   (2) atomicWriteJson — tmp in the same directory + fsync + rename (on disk there is always
//       a whole version: the old one or the new one);
//   (3) enrichDecimalsFile — filled=0 ⇒ the file is not rewritten at all.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadRegistrySafe } from "../src/registry/registry.mjs";
import { atomicWriteJson } from "../src/fs/atomic.mjs";
import { enrichDecimalsFile } from "../src/registry/enrich.mjs";

const freshDir = () => mkdtempSync(path.join(tmpdir(), "lotwise-r6-registry-"));
const busy = () => {
  throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
};
const TOKEN = {
  mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", // SPYx, valid base58
  symbol: "SPYx",
  name: "SPDR S&P 500 Tokenized",
  issuer: "backed",
  decimals: null,
};
const fullJson = (list) => JSON.stringify(list, null, 1) + "\n";

// ---- (1) loadRegistrySafe: corruption ≠ the death of the process ----

test("loadRegistrySafe: a valid registry — ok, corrupted=false, the list in place", async () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  writeFileSync(p, fullJson([TOKEN]));
  const r = await loadRegistrySafe(p);
  assert.equal(r.ok, true);
  assert.equal(r.corrupted, false);
  assert.equal(r.backup, null);
  assert.deepEqual(r.registry, [TOKEN]);
});

test("loadRegistrySafe: a truncated JSON (an interrupted write) — corrupted=1, an empty registry, the evidence nearby", async () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  const torn = fullJson([TOKEN]).slice(0, 40); // as after a kill in the writeFileSync window
  writeFileSync(p, torn);
  const r = await loadRegistrySafe(p);
  assert.equal(r.ok, false);
  assert.equal(r.corrupted, true, "corruption — an explicit state, not the death of the process");
  assert.deepEqual(r.registry, []); // the boot continues on an empty registry
  assert.match(r.reason, /JSON/i);
  assert.ok(r.backup, "the evidence is preserved nearby");
  assert.equal(readFileSync(r.backup, "utf8"), torn);
  assert.equal(existsSync(p), false); // the original renamed into the evidence
  assert.equal(r.preserveFailed, false);
});

test("loadRegistrySafe: a valid JSON but not an array — corrupted=1 + evidence", async () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  writeFileSync(p, '{"mint": "x"}');
  const r = await loadRegistrySafe(p);
  assert.equal(r.corrupted, true);
  assert.deepEqual(r.registry, []);
  assert.ok(r.backup);
});

test("loadRegistrySafe: an empty array — corrupted=1 + evidence (this is not a valid registry)", async () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  writeFileSync(p, "[]");
  const r = await loadRegistrySafe(p);
  assert.equal(r.corrupted, true);
  assert.deepEqual(r.registry, []);
  assert.ok(r.backup);
});

test("loadRegistrySafe: a record with a broken mint — corrupted=1 + evidence (content errors are evidence too)", async () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  writeFileSync(p, fullJson([{ ...TOKEN, mint: "not-a-mint" }]));
  const r = await loadRegistrySafe(p);
  assert.equal(r.corrupted, true);
  assert.deepEqual(r.registry, []);
  assert.ok(r.backup);
  assert.match(r.reason, /base58/);
});

test("loadRegistrySafe: no file — corrupted=false (not corruption: the registry simply was not built)", async () => {
  const r = await loadRegistrySafe(path.join(freshDir(), "no-file.json"));
  assert.equal(r.ok, false);
  assert.equal(r.corrupted, false, "ENOENT has no right to masquerade as \"corrupted\"");
  assert.deepEqual(r.registry, []);
  assert.equal(r.backup, null);
});

test("loadRegistrySafe: rename failed — the evidence copied, the original in place, preserveFailed=false", async () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  const torn = fullJson([TOKEN]).slice(0, 30);
  writeFileSync(p, torn);
  const r = await loadRegistrySafe(p, { rename: busy });
  assert.equal(r.corrupted, true);
  assert.ok(r.backup, "the copy fallback must save the evidence");
  assert.equal(readFileSync(r.backup, "utf8"), torn);
  assert.equal(existsSync(p), true); // the original untouched (and will be: serve does not write tokens.json)
  assert.equal(r.preserveFailed, false);
});

test("loadRegistrySafe: neither rename nor copy succeeded — preserveFailed=true, the registry is still empty, not death", async () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  writeFileSync(p, "{");
  const r = await loadRegistrySafe(p, { rename: busy, copy: busy });
  assert.equal(r.corrupted, true);
  assert.equal(r.backup, null);
  assert.equal(r.preserveFailed, true);
  assert.deepEqual(r.registry, []);
});

// ---- (2) atomicWriteJson: an interrupted write leaves a whole version ----

test("atomicWriteJson: a write and a rewrite — valid JSON, no tmp litter in the directory", () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  atomicWriteJson(p, [TOKEN]);
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), [TOKEN]);
  atomicWriteJson(p, [TOKEN, { ...TOKEN, symbol: "NVDAx", mint: "9BB7Tt5uW5QbAorLkF3Hn1P2mGcXvcDdR7y8LbT9KdUu" }]);
  assert.equal(JSON.parse(readFileSync(p, "utf8")).length, 2);
  assert.deepEqual(readdirSync(dir), ["tokens.json"]); // exactly one file: the temp went into the rename
});

test("atomicWriteJson: an unreachable directory — throws, no litter nearby", () => {
  const dir = freshDir();
  const p = path.join(dir, "no-such-folder", "tokens.json");
  assert.throws(() => atomicWriteJson(p, [TOKEN]));
  assert.deepEqual(readdirSync(dir), []);
});

test("atomicWriteJson: the format is compatible with loadRegistrySafe (a roundtrip through the file)", async () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  atomicWriteJson(p, [TOKEN]);
  const r = await loadRegistrySafe(p);
  assert.equal(r.ok, true);
  assert.deepEqual(r.registry, [TOKEN]);
});

// ---- (3) enrichDecimalsFile: filled=0 ⇒ the file is not touched ----

test("enrichDecimalsFile: filled=0 — the file is NOT rewritten (a read-only file does not throw: there was no write)", () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  const original = fullJson([{ ...TOKEN, decimals: 6 }]); // decimals already filled
  writeFileSync(p, original);
  chmodSync(p, 0o444); // the old script rewrote unconditionally and would die with EPERM
  try {
    const r = enrichDecimalsFile(p, { [TOKEN.mint]: { decimals: 8 } }); // nothing to fill
    assert.equal(r.filled, 0);
    assert.equal(r.written, false, "nothing to write — the interrupted-write window does not open at all");
    assert.deepEqual(r.unknown, []);
  } finally {
    chmodSync(p, 0o644);
  }
  assert.equal(readFileSync(p, "utf8"), original); // byte for byte
});

test("enrichDecimalsFile: Jupiter does not know the mints — filled=0, unknown collected, the file untouched", () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  writeFileSync(p, fullJson([TOKEN]));
  const before = readFileSync(p, "utf8");
  const r = enrichDecimalsFile(p, {}); // an empty response: nothing to fill, nothing to write
  assert.equal(r.filled, 0);
  assert.deepEqual(r.unknown, ["SPYx"]);
  assert.equal(r.written, false);
  assert.equal(readFileSync(p, "utf8"), before);
});

test("enrichDecimalsFile: filled>0 — decimals written, the write is atomic, no tmp litter", () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  writeFileSync(p, fullJson([TOKEN, { ...TOKEN, symbol: "NVDAx", mint: "9BB7Tt5uW5QbAorLkF3Hn1P2mGcXvcDdR7y8LbT9KdUu" }]));
  const r = enrichDecimalsFile(p, {
    [TOKEN.mint]: { decimals: 8 },
    // Jupiter does not know NVDAx: decimals stay null
  });
  assert.equal(r.filled, 1);
  assert.equal(r.written, true);
  assert.deepEqual(r.unknown, ["NVDAx"]);
  const list = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(list[0].decimals, 8);
  assert.equal(list[0].sourceDecimals, "jupiter");
  assert.equal(list[1].decimals, null); // the unfilled are untouched
  assert.deepEqual(readdirSync(dir), ["tokens.json"]);
});

test("enrichDecimalsFile: already-filled decimals are not overwritten (only null is filled)", () => {
  const dir = freshDir();
  const p = path.join(dir, "tokens.json");
  writeFileSync(p, fullJson([{ ...TOKEN, decimals: 6, sourceDecimals: "hand" }]));
  enrichDecimalsFile(p, { [TOKEN.mint]: { decimals: 8 } });
  const list = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(list[0].decimals, 6);
  assert.equal(list[0].sourceDecimals, "hand");
});
