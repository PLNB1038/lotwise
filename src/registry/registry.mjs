// Реестр отслеживаемых токенизированных акций (data/tokens.json).
import { readFile } from "node:fs/promises";
import { preserveCorruptedFile } from "../fs/atomic.mjs";

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

// Бут с деградацией вместо смерти процесса (раунд 6, LW2_tokens_json_write_non_atomic).
// Усечённый data/tokens.json (обрыв в окне записи enrich-decimals, диск)
// вылетал RegistryError на top-level serve.mjs → unhandled rejection: процесс не
// поднимался вообще, деградированного режима не существовало, класс «повреждён» не
// различался (в отличие от журнала, где тот же класс чинился в раунде 5).

/**
 * Загрузка реестра с различением «файла нет», «повреждён» и «здоров».
 * Повреждение — явное состояние по паттерну журнала (раунд 5): улика сохраняется
 * рядом (rename, при срыве — copy; см. preserveCorruptedFile), бут продолжается на
 * пустом реестре, corrupted-флаг уходит в /health (registry.corrupted).
 * @param {string} path
 * @param {{nowMs?: number, attempts?: number, rename?: Function, copy?: Function}} [preserveOpts]
 * @returns {{ok: boolean, corrupted: boolean, registry: Array, reason: string|null,
 *            backup: string|null, preserveFailed: boolean}}
 *   файла нет (ENOENT) → corrupted=false: это не повреждение, реестр просто не собран;
 *   прочитан, но не парсится / не валиден → corrupted=true + улика рядом;
 *   нечитаем (EBUSY/права) → corrupted=true, улику сохранить обычно нечем.
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
    list = JSON.parse(raw);
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
