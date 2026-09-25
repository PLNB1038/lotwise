// Arg parser of scripts/serve.mjs. Moved out of the script into a testable module
// : --port abc used to burn the whole boot (minutes of RPC quota) and failed
// only at listen; --port=8787 was silently ignored; --rpc as the last argument silently
// killed the env fallback (rpcUrl = undefined → the whole boot serving honest 503s).
// Guards BEFORE any I/O — modeled on --max-txs, which already knew how.
import { lookup as dnsLookup } from "node:dns/promises";
import { createServer } from "node:net";

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
    // an empty value = missing: "" for host made listen bind ALL interfaces
    // , for rpc — a boot of empty 503s; reject, not a silent default detour
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
 * @throws {ServeArgsError} — a flag without a value; port/maxTxs — not an integer/not positive
 */
export function parseServeArgs(argv, env = process.env) {
  if (!Array.isArray(argv)) throw new ServeArgsError("argv must be an array");

  let port = 8787;
  const portRaw = readFlag(argv, "port");
  if (portRaw !== undefined) {
    // digits-onlyb): Number() generously eats 0x10/1e2 — the same discipline
    // as /multiplier?raw (BigInt silently accepts "0x10")
    if (!/^\d+$/.test(portRaw)) {
      throw new ServeArgsError(`--port must be an integer between 1 and 65535, got ${JSON.stringify(portRaw)}`, "--port");
    }
    port = Number(portRaw);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new ServeArgsError(`--port must be an integer between 1 and 65535, got ${JSON.stringify(portRaw)}`, "--port");
    }
  }

  const host = readFlag(argv, "host") ?? "127.0.0.1";
  if (/\s/.test(host)) {
    // "not a host" passed the parser and crashed listen AFTER the full boot I/O
    // (registry+journal+RPC quota); whitespace in host is always a typo
    throw new ServeArgsError(`--host must not contain whitespace, got ${JSON.stringify(host)}`, "--host");
  }
  // flag > env > public RPC; an env key must not leak into the cmdline (see serve.mjs)
  const rpcUrl = readFlag(argv, "rpc") ?? env.LOTWISE_RPC_URL ?? DEFAULT_RPC;
  try {
    const u = new URL(rpcUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("not http(s)");
  } catch {
    // booting into honest 503s on a garbage URL is legal, but rejecting BEFORE I/O is cheaper
    // (the same family as /
    throw new ServeArgsError(`--rpc must be a valid http(s) URL, got ${JSON.stringify(rpcUrl)}`, "--rpc");
  }

  let maxTxs = 300;
  const maxTxsRaw = readFlag(argv, "max-txs");
  if (maxTxsRaw !== undefined) {
    maxTxs = Number(maxTxsRaw);
    if (!Number.isInteger(maxTxs) || maxTxs <= 0) {
      // without the guard "--max-txs abc" yields NaN: `taken >= NaN` is always false — the scan runs silently uncapped
      throw new ServeArgsError(`--max-txs must be an integer > 0, got ${JSON.stringify(maxTxsRaw)}`, "--max-txs");
    }
  }

  return { port, host, rpcUrl, maxTxs };
}

// DNS-resolve --host BEFORE boot : the parser is synchronous and sees only
// lexics — "no-such-host.invalid" burned the whole boot I/O (the registry, the journal, ~15 RPC calls
// of history) and failed only at listen with ENOTFOUND. One lookup is cheaper than a boot; IP literals
// and localhost resolve in libc without the network. lookup is injectable for tests.
export async function assertHostResolvable(host, lookup = dnsLookup) {
  try {
    await lookup(host);
  } catch (err) {
    throw new ServeArgsError(`--host does not resolve: ${err.code ?? err.message} (${JSON.stringify(host)})`, "--host");
  }
}

// A busy port BEFORE boot I/O : EADDRINUSE used to be caught only at listen
// AFTER the full boot — a double start burned registry/journal/15 RPC calls. A one-off
// bind probe closes the typical case; the race of "two trying in the same millisecond" remains
// covered by the post-boot EADDRINUSE failure (a clear exit 1) — a known remainder.
export function checkPortAvailable(port, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    const fail = (msg) => {
      probe.close();
      reject(new ServeArgsError(msg, "--port"));
    };
    probe.once("error", (err) => {
      if (err.code === "EADDRINUSE" || err.code === "EACCES") {
        fail(`--port ${port} is already in use on ${host} (${err.code}) — refusing before boot I/O`);
      } else {
        fail(`--port ${port} cannot be bound on ${host}: ${err.code ?? err.message}`);
      }
    });
    probe.once("listening", () => probe.close(() => resolve()));
    probe.listen(port, host);
  });
}

/**
 * an env limit that is SET but invalid (garbage, 0, negative,
 * 1e21 — beyond Number.MAX_SAFE_INTEGER, which silently disables the limiter) used to
 * fall back to the default without a word. The fallback stays (operators keep booting),
 * but it is now loud, and the ceiling is the safe-integer range.
 */
export function envPositiveInt(name, fallback, env = process.env, warn = console.error) {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const v = Number(raw);
  if (Number.isSafeInteger(v) && v > 0) return v;
  warn(`[serve] ${name}=${JSON.stringify(raw)} is not a positive safe integer — using the default ${fallback}`);
  return fallback;
}
