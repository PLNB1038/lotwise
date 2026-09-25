// One-off enrichment of data/tokens.json: decimals from the Jupiter Price API v3 (batched).
// Run from the repo root: node scripts/enrich-decimals.mjs [--registry data/tokens.json] [--api https://lite-api.jup.ag]
// The logic lives in src/registry/enrich.mjs (testability, round 6): the write is atomic
// (atomicWriteJson), and at filled=0 the file is not rewritten at all — previously every
// script run repeated the interrupted-write window for no reason.
// Wave E (E3-3): failure via process.exitCode — process.exit over a live undici socket
// crashed the process on win (0xC0000409), breaking the exit-code contract for cron wrappers
// (the remainder of the D2 fix, which moved only the two neighboring CLIs to exitCode).
import { readFileSync } from "node:fs";
import { enrichDecimalsFile } from "../src/registry/enrich.mjs";

const argv = process.argv.slice(2);
// Grammar = serve (ROUND7 #10): both "--flag value" AND "--flag=value"; an empty value and
// a flag without a value — REFUSAL BEFORE any I/O (wave F1 [P2]: the "?? default" ate null
// errors, the script printed a refusal, and then still went to the network and rewrote the registry).
// Returns: string | undefined (no flag) | null (broken flag — the caller must abort).
const readFlag = (name) => {
  const eq = `--${name}=`;
  const eqIdx = argv.findIndex((a) => a.startsWith(eq));
  if (eqIdx !== -1) {
    const value = argv[eqIdx].slice(eq.length);
    // Wave H4 [P3]: "--api=--evil" used to escape into the runtime (a raw ENOENT/undici stack,
    // exit 1) instead of a usage refusal with exit 2 — parity with the space form
    if (value === "" || value.startsWith("--")) {
      console.error(`--${name} requires a non-empty value`);
      return null;
    }
    return value;
  }
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`--${name} requires a value`);
    return null;
  }
  return value;
};
const registryFlag = readFlag("registry");
const apiFlag = readFlag("api");
const badFlag = registryFlag === null || apiFlag === null;
if (badFlag) process.exitCode = 2;

if (!badFlag) {
  const REGISTRY = registryFlag ?? "data/tokens.json";
  const API = apiFlag ?? "https://lite-api.jup.ag";
  // Round 21 (SRE P2-1): the registry is an OPERATOR file — a truncated/BOM/null/missing
  // one refused here with exit 2 and a named reason, before any I/O (serve degrades the
  // same file with evidence; a raw SyntaxError stack and exit 1 was the odd one out).
  let list = null;
  let registryError = null;
  try {
    list = JSON.parse(readFileSync(REGISTRY, "utf8"));
  } catch (err) {
    registryError = err;
  }
  if (registryError !== null) {
    console.error(`registry unreadable: ${REGISTRY}: ${registryError.message}`);
    process.exitCode = 2;
  } else if (!Array.isArray(list)) {
    console.error(`registry must be a JSON array of entries, got ${list === null ? "null" : typeof list}: ${REGISTRY}`);
    process.exitCode = 2;
  } else if (list.length === 0) {
    // an empty-but-valid registry is a no-op the operator should SEE, not a silent "filled=0"
    console.log("registry is empty — nothing to enrich");
  } else {
    const ids = list.map((t) => t.mint).join(",");
    const res = await fetch(`${API}/price/v3?ids=${ids}`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Lotwise/0.1)" },
    });
    if (!res.ok) {
      console.error(`Jupiter HTTP ${res.status}`);
      process.exitCode = 1;
    } else {
      const prices = await res.json();

      // counter of missing decimals — BEFORE enrichment (wave B): after the mutation the list is
      // already full and every repeated run lied "0/31"
      const missingBefore = list.filter((t) => t.decimals === null || t.decimals === undefined).length;
      const { filled, unknown, skipped, written } = enrichDecimalsFile(REGISTRY, prices);
      if (!written) console.log("filled=0 — data/tokens.json not rewritten (nothing to write)");
      console.log(`decimals filled: ${filled}/${missingBefore} without decimals on input`);
      console.log(unknown.length ? `NOT found in Jupiter: ${unknown.join(", ")}` : "all mints known to Jupiter");
      if (skipped?.length) console.warn(`SKIPPED (garbage decimals from Jupiter): ${skipped.map((x) => `${x.mint} (${x.reason})`).join(", ")}`);
    }
  }
}
