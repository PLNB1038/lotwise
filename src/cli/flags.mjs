// Парсер аргументов scripts/serve.mjs. Вынесен из скрипта в тестируемый модуль
// (ROUND7 №10): --port abc раньше проживал весь бут (минуты квот RPC) и падал
// только на listen; --port=8787 молча игнорировался; --rpc последним аргументом
// молча убивал env-фолбэк (rpcUrl = undefined → весь бут в честных 503).
// Гварды ДО любого I/O — по образцу --max-txs, который уже так умел.

export class ServeArgsError extends Error {
  constructor(msg, flag) {
    super(flag ? `${msg} (${flag})` : msg);
    this.name = "ServeArgsError";
    this.flag = flag;
  }
}

const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

function readFlag(argv, name) {
  const eq = `--${name}=`;
  const eqIdx = argv.findIndex((a) => a.startsWith(eq));
  if (eqIdx !== -1) {
    const value = argv[eqIdx].slice(eq.length);
    // пустое значение = отсутствующее: "" у host делал listen на ВСЕХ интерфейсах
    // (ROUND9 №1), у rpc — бут в пустых 503; отказ, а не тихий дефолт-обход
    if (value === "") throw new ServeArgsError(`--${name} requires a non-empty value`, `--${name}`);
    return value;
  }
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new ServeArgsError(`--${name} requires a value`, `--${name}`);
  }
  if (value === "") {
    throw new ServeArgsError(`--${name} requires a non-empty value`, `--${name}`);
  }
  return value;
}

/**
 * @param {string[]} argv — process.argv.slice(2)
 * @returns {{port: number, host: string, rpcUrl: string, maxTxs: number}}
 * @throws {ServeArgsError} — флаг без значения; port/maxTxs — не целое/не положительное
 */
export function parseServeArgs(argv, env = process.env) {
  if (!Array.isArray(argv)) throw new ServeArgsError("argv must be an array");

  let port = 8787;
  const portRaw = readFlag(argv, "port");
  if (portRaw !== undefined) {
    // digits-only (ROUND9 №1b): Number() льготно ест 0x10/1e2 — та же дисциплина,
    // что у /multiplier?raw (BigInt молча принимает "0x10")
    if (!/^\d+$/.test(portRaw)) {
      throw new ServeArgsError(`--port must be an integer between 1 and 65535, got ${JSON.stringify(portRaw)}`, "--port");
    }
    port = Number(portRaw);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new ServeArgsError(`--port must be an integer between 1 and 65535, got ${JSON.stringify(portRaw)}`, "--port");
    }
  }

  const host = readFlag(argv, "host") ?? "127.0.0.1";
  // флаг > env > публичный RPC; env-ключ не должен утекать в cmdline (см. serve.mjs)
  const rpcUrl = readFlag(argv, "rpc") ?? env.LOTWISE_RPC_URL ?? DEFAULT_RPC;

  let maxTxs = 300;
  const maxTxsRaw = readFlag(argv, "max-txs");
  if (maxTxsRaw !== undefined) {
    maxTxs = Number(maxTxsRaw);
    if (!Number.isInteger(maxTxs) || maxTxs <= 0) {
      // без гварда "--max-txs abc" даёт NaN: `taken >= NaN` всегда false — скан молча без потолка
      throw new ServeArgsError(`--max-txs must be an integer > 0, got ${JSON.stringify(maxTxsRaw)}`, "--max-txs");
    }
  }

  return { port, host, rpcUrl, maxTxs };
}
