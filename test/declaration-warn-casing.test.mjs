// The declarations loader's console warnings are the duty log's main interface with the
// channel, and /events?symbol= is case-sensitive: a warning printing the UPPERCASED
// comparison key sends a copy-paste into a 400 "must be a tracked token". The decimals-
// drift warning and the /health decimalsDrift array already print the registry-cased
// symbol; the two remaining lines still uppercased:
//   - the changed-sum cluster warning ("two declarations within three days") — the symbol
//     is in the registry, so the registry's own spelling is printed;
//   - the foreign-symbols warning — no registry spelling exists there, so the file's own
//     spelling is printed (that literal line is what the operator fixes).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadDeclarationsFile } from "../src/events/declarations-file.mjs";

const KOX = "Xk3jhw1yHRtE6ZCofvsqLSzLp4pHHTnbcj1nPQiZbLw";
const REG = [
  { mint: KOX, symbol: "KOx", name: "Coca-Cola", issuer: "backed", decimals: 6 },
];

const withWarns = (fn) => {
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    return { result: fn(), warns };
  } finally {
    console.warn = orig;
  }
};

const writeDecl = (list) => {
  const p = path.join(mkdtempSync(path.join(tmpdir(), "lw-warncase-")), "declarations.json");
  writeFileSync(p, JSON.stringify(list));
  return p;
};

test("the changed-sum warning prints the registry-cased symbol (copy-paste into ?symbol= works)", () => {
  const p = writeDecl([
    { symbol: "KOx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 6, sourceUrl: "https://issuer.example/q2" },
    { symbol: "KOx", exDate: "2026-06-19", amountPerUnitRaw: "3000000", decimals: 6, sourceUrl: "https://issuer.example/q3" },
  ]);
  const { result, warns } = withWarns(() => loadDeclarationsFile(p, REG));
  assert.equal(result.ok, true, "a changed sum within three days warns, it does not refuse");
  const line = warns.find((w) => w.includes("two declarations within three days"));
  assert.ok(line, "the suspicious-cluster warning fired");
  assert.match(line, /\[declarations\] KOx: two declarations/, "the registry spelling, not the uppercase comparison key");
  assert.doesNotMatch(line, /KOX/, "the uppercased key must not appear — ?symbol=KOX would 400");
});

test("the foreign-symbols warning prints the file's own spelling (the line the operator fixes)", () => {
  const p = writeDecl([
    { symbol: "TYPOx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 6, sourceUrl: "https://issuer.example/q2" },
  ]);
  const { result, warns } = withWarns(() => loadDeclarationsFile(p, REG));
  assert.equal(result.ok, true);
  const line = warns.find((w) => w.includes("not in the registry"));
  assert.ok(line, "the foreign-symbol warning fired");
  assert.match(line, /TYPOx/, "the file's own spelling");
  assert.doesNotMatch(line, /TYPOX/, "no uppercased spelling — there is no registry authority for a foreign symbol");
});

test("the decimals-drift warning keeps printing the registry-cased symbol (pinned)", () => {
  // already registry-cased; pinned here so the whole warning family stays joinable
  const p = writeDecl([
    { symbol: "KOx", exDate: "2026-06-18", amountPerUnitRaw: "2000000", decimals: 3, sourceUrl: "https://issuer.example/q2" },
  ]);
  const { warns } = withWarns(() => loadDeclarationsFile(p, REG));
  const line = warns.find((w) => w.includes("≠ registry decimals"));
  assert.ok(line, "the drift warning fired");
  assert.match(line, /\[declarations\] KOx: declaration decimals/, "the registry spelling");
  assert.doesNotMatch(line, /KOX/, "no uppercased spelling");
});
