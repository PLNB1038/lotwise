// A CLOSED token account must not take its history
// out of the scan. A repro
// closed account at a synthetic address that no derivation can reach; this pin uses the
// REAL derived ATA of (owner, mint) — exactly what a node serves after CloseAccount:
//
//   getTokenAccountsByOwner lists only LIVE accounts, but the ATA address is a deterministic
//   PDA derivable after closing and getSignaturesForAddress(closed ATA) still answers.
//   With a delegate-signed disposal (delegate authority signs transfer_checked; account keys
//   = source, mint, dest, delegate) NEITHER the owner wallet NOR any live owner account ever
//   saw the disposal — before the fix the loss was TOTAL and certified complete:true.
//
// Fix under test: scanWallet derives the ATA (owner, mint) for BOTH token programs of every
// registry mint and queries its signatures INDEPENDENTLY of the listing (deduped when the
// derived address is already among the live-listed sources — no double RPC walk).
import test from "node:test";
import assert from "node:assert/strict";
import { scanWallet, deriveAta, TOKEN_PROGRAMS } from "../src/wallet/scan.mjs";
import { buildWalletReport } from "../src/wallet/report.mjs";

const SPYx = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const OWNER = "ExDateAddr" + "1".repeat(34);
const DELEGATE = "De1egatedB" + "1".repeat(34);
const REG = [{ mint: SPYx, symbol: "SPYx", name: "S&P 500 xStock", decimals: 8, issuer: "test" }];
const [CLASSIC] = TOKEN_PROGRAMS;
const ATA_SPYX = deriveAta(OWNER, SPYx, CLASSIC); // the closed account's REAL address

const receiveTx = { // sender-paid incoming transfer: owner wallet NOT in keys
  slot: 500, blockTime: 1750000000,
  meta: { err: null, preTokenBalances: [],
    postTokenBalances: [{ accountIndex: 2, owner: OWNER, mint: SPYx, uiTokenAmount: { amount: "10000000000" } }] },
};
const approveTx = { // delegate approve: no balance change
  slot: 550, blockTime: 1750001000,
  meta: { err: null,
    preTokenBalances: [{ accountIndex: 0, owner: OWNER, mint: SPYx, uiTokenAmount: { amount: "10000000000" } }],
    postTokenBalances: [{ accountIndex: 0, owner: OWNER, mint: SPYx, uiTokenAmount: { amount: "10000000000" } }] },
};
const delegateSellTx = { // delegate-signed disposal: keys never include the owner
  slot: 600, blockTime: 1750003000,
  meta: { err: null,
    preTokenBalances: [{ accountIndex: 0, owner: OWNER, mint: SPYx, uiTokenAmount: { amount: "10000000000" } }],
    postTokenBalances: [{ accountIndex: 0, owner: OWNER, mint: SPYx, uiTokenAmount: { amount: "0" } }] },
};
const closeTx = { // CloseAccount of the empty account: pre 0 / post absent -> delta 0
  slot: 601, blockTime: 1750003100,
  meta: { err: null,
    preTokenBalances: [{ accountIndex: 0, owner: OWNER, mint: SPYx, uiTokenAmount: { amount: "0" } }],
    postTokenBalances: [] },
};

// the node is honest: it still serves the CLOSED account's history at its address
function makeClient() {
  const asked = [];
  const ataPage = [ // newest first, like the ledger
    { signature: "sClose", slot: 601, blockTime: 1750003100, err: null },
    { signature: "sSell", slot: 600, blockTime: 1750003000, err: null },
    { signature: "sApprove", slot: 550, blockTime: 1750001000, err: null },
    { signature: "sBuy", slot: 500, blockTime: 1750000000, err: null },
  ];
  const ownerPage = [ // the delegate-signed disposal is NOT here
    { signature: "sClose", slot: 601, blockTime: 1750003100, err: null },
    { signature: "sApprove", slot: 550, blockTime: 1750001000, err: null },
  ];
  const pageOf = (all, params) => {
    const before = params?.before;
    const start = before === undefined ? 0 : all.findIndex((s) => s.signature === before) + 1;
    return all.slice(start, start + (params?.limit ?? 100));
  };
  return {
    asked,
    async call(method, params) {
      if (method === "getTokenAccountsByOwner") return { value: [] }; // SPYx ATA CLOSED: not listed
      if (method === "getSignaturesForAddress") {
        asked.push(params[0]);
        if (params[0] === ATA_SPYX) return pageOf(ataPage, params[1]);
        if (params[0] === OWNER) return pageOf(ownerPage, params[1]);
        return [];
      }
      if (method === "getTransaction") {
        return { sBuy: receiveTx, sApprove: approveTx, sSell: delegateSellTx, sClose: closeTx }[params[0]] ?? null;
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

async function captureConsoleError(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...args) => lines.push(args.map(String).join(" "));
  try { return { result: await fn(), lines }; } finally { console.error = orig; }
}

test("S3: closed ATA (delegate flow) — the derived address is a signature source and the history is recovered", async () => {
  const client = makeClient();
  const { result: scan } = await captureConsoleError(() => scanWallet(client, OWNER, REG));

  assert.ok(scan.derivedSources.includes(ATA_SPYX), "the derived ATA of (owner, mint) is among the sources");
  assert.ok(client.asked.includes(ATA_SPYX), "getSignaturesForAddress was called on the CLOSED ATA address");
  assert.equal(scan.signatures, 4, "sBuy+sApprove+sSell+sClose all collected");
  assert.equal(scan.truncated, false, "no cap hit: the recovered history is complete");

  const rep = buildWalletReport(scan, { registry: REG });
  const spyx = rep.tokens.find((t) => t.mint === SPYx);
  assert.ok(spyx, "the SPYx position is back in the report (was: fully invisible)");
  assert.equal(spyx.rawBalance, "0", "bought 100, sold 100, closed: net zero, matching the empty listing");
  assert.equal(spyx.reconciles, true, "deltas converge with the live (empty) balance");
  assert.equal(rep.complete, true, "complete:true is now HONEST — the closed account's history was actually read");
  assert.equal(rep.counts.skipped, 0);
});

test("S3: dedup — a derived ATA equal to a live-listed account is not walked twice", async () => {
  const client = makeClient();
  // the live listing returns the SAME address the derivation produces (the normal case)
  const origCall = client.call.bind(client);
  client.call = async (method, params) => {
    if (method === "getTokenAccountsByOwner" && params[1]?.programId === CLASSIC) {
      return { value: [{ pubkey: ATA_SPYX, account: { data: { parsed: { info: { mint: SPYx, owner: OWNER, tokenAmount: { amount: "0" } } } } } }] };
    }
    return origCall(method, params);
  };
  const { result: scan } = await captureConsoleError(() => scanWallet(client, OWNER, REG));
  const walks = client.asked.filter((a) => a === ATA_SPYX).length;
  // one source walk = the full page + one end-confirmation probe (scanWallet walks to an
  // EMPTY page) = 2 calls; without the dedup the same address would be walked twice = 4
  assert.equal(walks, 2, `the live-listed ATA is scanned once (page+probe), not twice (got ${walks})`);
  assert.ok(!scan.derivedSources.includes(ATA_SPYX), "it is not reported as an extra derived source");
  assert.equal(scan.signatures, 4);
});

test("S3: an invalid registry mint skips derivation with a warn instead of crashing the scan", async () => {
  const client = makeClient();
  const { result: scan, lines } = await captureConsoleError(() =>
    scanWallet(client, OWNER, [{ mint: "not-a-mint", symbol: "JUNK", name: "junk", decimals: 0 }]));
  assert.deepEqual(scan.derivedSources, [], "no derived signature source for the junk mint");
  assert.equal(scan.signatures, 2, "the owner's own page is still scanned (sClose+sApprove)");
  assert.ok(lines.some((l) => l.includes("not-a-mint") && l.includes("[wallet-scan]")), "the operator sees the warn");
});
