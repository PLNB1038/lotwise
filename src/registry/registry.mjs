// Реестр отслеживаемых токенизированных акций (data/tokens.json).
export const ISSUERS = ["backed", "backpack", "prestocks", "tessera"];

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export class RegistryError extends Error {
  constructor(msg, entry) {
    super(msg);
    this.name = "RegistryError";
    this.entry = entry;
  }
}

export async function loadRegistry(path = "data/tokens.json") {
  const { readFile } = await import("node:fs/promises");
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new RegistryError(`cannot read registry at ${path}: ${err.code ?? err.message}`);
  }
  let list;
  try {
    list = JSON.parse(raw);
  } catch (err) {
    throw new RegistryError(`registry is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(list) || list.length === 0) {
    throw new RegistryError("registry must be a non-empty array");
  }
  return validateRegistry(list);
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

// Строгая валидация всего списка: каждая запись корректна, минты и символы уникальны.
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
