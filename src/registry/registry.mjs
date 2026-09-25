// Registry of tracked tokenized stocks (data/tokens.json).
import { readFile } from "node:fs/promises";
import { preserveCorruptedFile } from "../fs/atomic.mjs";

export const ISSUERS = ["backed", "backpack", "prestocks", "tessera"];

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// the serve boot walk is LINEAR in the registry (an RPC read plus
// backoff per non-xStocks token) — a runaway registry (a bad merge, a glued file) turned
// a restart into a multi-hour pre-listen downtime with a "green" process. The boot
// refuses loudly instead; the measured worst case was ~0.36s/token on an unreachable RPC.
export const MAX_BOOT_REGISTRY_TOKENS = 2048;

export function assertBootableRegistrySize(list) {
  if (Array.isArray(list) && list.length > MAX_BOOT_REGISTRY_TOKENS) {
    throw new RegistryError(
      `registry has ${list.length} tokens; the boot walk is linear and would take hours — refusing (cap ${MAX_BOOT_REGISTRY_TOKENS}). Split or shrink data/tokens.json.`,
    );
  }
}

export class RegistryError extends Error {
  constructor(msg, entry) {
    super(msg);
    this.name = "RegistryError";
    this.entry = entry;
  }
}

export async function loadRegistry(path = "data/tokens.json") {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new RegistryError(`cannot read registry at ${path}: ${err.code ?? err.message}`);
  }
  let list;
  try {
    // strip a UTF-8 BOM — a valid registry must not be quarantined for an editor fingerprint
    list = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (err) {
    throw new RegistryError(`registry is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(list) || list.length === 0) {
    throw new RegistryError("registry must be a non-empty array");
  }
  return validateRegistry(list);
}

// Boot with degradation instead of process death, LW2_tokens_json_write_non_atomic).
// A truncated data/tokens.json (an interrupted write in the enrich-decimals window, disk)
// crashed with RegistryError at top-level serve.mjs → unhandled rejection: the process
// did not come up at all, no degraded mode existed, and the "corrupted" class was not
// distinguished (unlike the journal, where the same class was fixed in.

/**
 * Registry load distinguishing "file absent", "corrupted" and "healthy".
 * Corruption is an explicit state following the journal pattern: the evidence is
 * preserved nearby (rename, falling back to copy on failure; see preserveCorruptedFile), boot
 * continues on an empty registry, the corrupted flag goes to /health (registry.corrupted).
 * @param {string} path
 * @param {{nowMs?: number, attempts?: number, rename?: Function, copy?: Function}} [preserveOpts]
 * @returns {{ok: boolean, corrupted: boolean, registry: Array, reason: string|null,
 *            backup: string|null, preserveFailed: boolean}}
 *   file absent (ENOENT) → corrupted=false: this is not corruption, the registry is just not built yet;
 *   read but unparseable / invalid → corrupted=true + evidence preserved nearby;
 *   unreadable (EBUSY/permissions) → corrupted=true, usually no way to preserve the evidence.
 */
export async function loadRegistrySafe(path = "data/tokens.json", preserveOpts = {}) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { ok: false, corrupted: false, registry: [], reason: `cannot read registry at ${path}: ENOENT`, backup: null, preserveFailed: false };
    }
    return { ok: false, corrupted: true, registry: [], reason: `cannot read registry at ${path}: ${err.code ?? err.message}`, backup: null, preserveFailed: true };
  }
  let list;
  try {
    // strip a UTF-8 BOM before parsing — a valid registry must not be quarantined for an editor fingerprint
    list = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (err) {
    return quarantineRegistryFile(path, `registry is not valid JSON: ${err.message}`, preserveOpts);
  }
  if (!Array.isArray(list) || list.length === 0) {
    return quarantineRegistryFile(path, "registry must be a non-empty array", preserveOpts);
  }
  try {
    return { ok: true, corrupted: false, registry: validateRegistry(list), reason: null, backup: null, preserveFailed: false };
  } catch (err) {
    return quarantineRegistryFile(path, err.message, preserveOpts);
  }
}

function quarantineRegistryFile(path, reason, preserveOpts) {
  const backup = preserveCorruptedFile(path, preserveOpts);
  return { ok: false, corrupted: true, registry: [], reason, backup, preserveFailed: backup === null };
}

export function validateRegistryEntry(entry) {
  if (!entry || typeof entry !== "object") throw new RegistryError("entry must be an object", entry);
  if (typeof entry.mint !== "string" || !MINT_RE.test(entry.mint)) {
    throw new RegistryError("mint must be a base58 Solana pubkey", entry);
  }
  if (!ISSUERS.includes(entry.issuer)) {
    throw new RegistryError(`issuer must be one of ${ISSUERS.join("|")}`, entry);
  }
  if (typeof entry.symbol !== "string" || entry.symbol.length === 0) {
    throw new RegistryError("symbol must be a non-empty string", entry);
  }
  if (typeof entry.name !== "string" || entry.name.length === 0) {
    throw new RegistryError("name must be a non-empty string", entry);
  }
  if (entry.decimals !== null && (!Number.isInteger(entry.decimals) || entry.decimals < 0 || entry.decimals > 18)) {
    throw new RegistryError("decimals must be null or an integer 0..18", entry);
  }
  return true;
}

// Strict validation of the whole list: every entry valid, mints and symbols unique.
export function validateRegistry(list) {
  const mints = new Set();
  const symbols = new Set();
  for (const entry of list) {
    validateRegistryEntry(entry);
    if (mints.has(entry.mint)) throw new RegistryError(`duplicate mint ${entry.mint}`, entry);
    if (symbols.has(entry.symbol)) throw new RegistryError(`duplicate symbol ${entry.symbol}`, entry);
    mints.add(entry.mint);
    symbols.add(entry.symbol);
  }
  return list;
}

export function getTokensByIssuer(list) {
  const out = Object.fromEntries(ISSUERS.map((i) => [i, []]));
  for (const t of list) out[t.issuer].push(t);
  return out;
}

export function findBySymbol(list, symbol) {
  return list.find((t) => t.symbol === symbol) ?? null;
}
