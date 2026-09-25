// getTokenAccountsByOwner is not "the full truth".
// A provider-capped listing
// silently erases tracked accounts BOTH as signature sources and from onchainNow, certifying
// complete:true. Fix under test (fail-closed):
//   1. the listing is requested with an EXPLICIT limit (both token programs) — the scanner
//      controls the page size instead of trusting a provider default;
//   2. a page that comes back FULL (length >= limit) is indistinguishable from a capped page:
//      a loud operator warn + scan.truncated = true (complete:false downstream — the report
//      refuses to certify, it never silently lies).
// Combined with S3 (derived ATA sources) a position beyond the cap still gets its history
// read via its derived ATA — but the report stays fail-closed because onchainNow itself
// may be incomplete.
import test from "node:test";
import assert from "node:assert/strict";
import { scanWallet, ACCOUNTS_PAGE_LIMIT } from "../src/wallet/scan.mjs";
import { buildWalletReport } from "../src/wallet/report.mjs";

const SPYx = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const OWNER = "ExDateAddr" + "1".repeat(34);
const TOKEN2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const REG = [{ mint: SPYx, symbol: "SPYx", name: "S&P 500 xStock", decimals: 8, issuer: "test" }];

const spyxBuy = { // in-window, sender-paid: visible ONLY via the ATA signature source
  slot: 10, blockTime: 1750000000,
  meta: { err: null, preTokenBalances: [],
    postTokenBalances: [{ accountIndex: 2, owner: OWNER, mint: SPYx, uiTokenAmount: { amount: "500000000000" } }] },
};

async function captureConsoleError(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...args) => lines.push(args.map(String).join(" "));
  try { return { result: await fn(), lines }; } finally { console.error = orig; }
}

const junkEntry = (i) => ({
  pubkey: `JunkAcc${i}`.padEnd(44, "z"), // junk mints are filtered before pubkey validation
  account: { data: { parsed: { info: { mint: `JunkMint${i}`.padEnd(44, "z"), owner: OWNER, tokenAmount: { amount: "1" } } } } },
});

test("S4: the listing is requested with an explicit limit on BOTH token programs", async () => {
  const configs = [];
  const client = {
    async call(method, params) {
      if (method === "getTokenAccountsByOwner") {
        configs.push({ programId: params[1]?.programId, config: params[2] });
        return { value: [] };
      }
      if (method === "getSignaturesForAddress") return [];
      throw new Error(`unexpected ${method}`);
    },
  };
  await scanWallet(client, OWNER, REG);
  assert.equal(configs.length, 2, "classic + token2022, one listing each");
  for (const { config } of configs) {
    assert.equal(typeof config?.limit, "number", `limit is explicit in ${JSON.stringify(config)}`);
    assert.equal(config.limit, ACCOUNTS_PAGE_LIMIT);
    assert.equal(config.encoding, "jsonParsed", "the rest of the config is intact");
  }
});

test("S4: a FULL page (length == limit) is a loud truncated, not a silent complete", async () => {
  const fullPage = Array.from({ length: ACCOUNTS_PAGE_LIMIT }, (_, i) => junkEntry(i));
  const client = {
    async call(method, params) {
      if (method === "getTokenAccountsByOwner") {
        // the provider caps the listing: the tracked account (and anything else) is beyond the cut
        return params[1]?.programId === TOKEN2022 ? { value: fullPage } : { value: [] };
      }
      if (method === "getSignaturesForAddress") {
        return params[0] === OWNER
          ? []
          : [{ signature: "sBuy", slot: 10, blockTime: 1750000000, err: null }]; // derived ATA page: the position's history
      }
      if (method === "getTransaction") return params[0] === "sBuy" ? spyxBuy : null;
      throw new Error(`unexpected ${method}`);
    },
  };
  const { result: scan, lines } = await captureConsoleError(() => scanWallet(client, OWNER, REG));
  assert.equal(scan.truncated, true, "a full page might hide more accounts — the scan refuses to certify");
  assert.ok(lines.some((l) => l.includes("[wallet-scan]") && l.includes(ACCOUNTS_PAGE_LIMIT.toString()) && l.includes("truncated")), "a loud operator warn with the page size");

  const rep = buildWalletReport(scan, { registry: REG });
  assert.equal(rep.truncated, true);
  assert.equal(rep.complete, false, "fail-closed: no complete:true on a possibly capped listing");
  // the S3 composition: even with the listing cut, the position is NOT erased
  assert.equal(rep.tokens.length, 1, "the position survives via its derived ATA source");
  assert.equal(rep.tokens[0].rawBalance, "500000000000");
});

test("S4: a SHORT page (length < limit) stays silent and untruncated — the honest norm", async () => {
  const smallPage = Array.from({ length: 3 }, (_, i) => junkEntry(i));
  const client = {
    async call(method, params) {
      if (method === "getTokenAccountsByOwner") {
        return params[1]?.programId === TOKEN2022 ? { value: smallPage } : { value: [] };
      }
      if (method === "getSignaturesForAddress") return [];
      throw new Error(`unexpected ${method}`);
    },
  };
  const { result: scan, lines } = await captureConsoleError(() => scanWallet(client, OWNER, REG));
  assert.equal(scan.truncated, false);
  assert.equal(lines.length, 0, "no warn on an obviously complete page");
});

test("S4: a malformed listing is still an explicit error (pre-existing contract intact)", async () => {
  const client = {
    async call(method) {
      if (method === "getTokenAccountsByOwner") return { value: null };
      throw new Error(`unexpected ${method}`);
    },
  };
  await assert.rejects(() => scanWallet(client, OWNER, REG), (e) => e?.kind === "malformed-source");
});
