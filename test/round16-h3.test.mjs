// Раунд 16 — волна H3 [P1×3 + P2]: транзакционный слой скана.
//   H3-1 [P1] одна poison-tx с мусорной meta роняла ВЕСЬ скан (8 векторов TypeError) —
//          кошелёк становился permanent-несканируемым. Контракт ROUND7 №14 «битая tx =
//          skipped с причиной» обязан покрывать и броски парсера.
//   H3-2 [P1] постоянная RpcError на ОДНОЙ tx (-32015 на versioned) — тот же летальный
//          исход через немедленный бросок rpc-клиента.
//   H3-3 [P1] getTokenAccountsByOwner: не-массив value и мусорные entries (pubkey 12345,
//          amount "1e6", битый base58) — сырые TypeError из scanWallet и битые адреса в
//          источниках сигнатур (зеркало ROUND9 №3, который закрыли только для сигнатур).
//   H3-4 [P2] tx с meta:null (лаг индексера) молча исчезала: fetched+1, ни в txs, ни в
//          skipped — нарушение fail-closed. Теперь — честный skip «tx unavailable».
import test from "node:test";
import assert from "node:assert/strict";
import { scanWallet, WalletScanError } from "../src/wallet/scan.mjs";
import { RpcError } from "../src/ingest/rpc.mjs";

const OWNER = "Wa11etBuyer" + "a".repeat(32);
const SPYx = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const REGISTRY = [{ mint: SPYx, symbol: "SPYx", decimals: 8, issuer: "test" }];

const goodTx = (amount, slot) => ({
  slot,
  blockTime: slot * 1000,
  meta: {
    err: null,
    preTokenBalances: [],
    postTokenBalances: [{ owner: OWNER, mint: SPYx, uiTokenAmount: { amount: String(amount) } }],
  },
});

// txs-значение может быть функцией — для бросков на конкретной сигнатуре
function fakeClient({ sigPages = {}, txs = {}, accountsByProgram = {} } = {}) {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push({ method, key: params[0] });
      if (method === "getSignaturesForAddress") return sigPages[params[0]] ?? [];
      if (method === "getTokenAccountsByOwner") return accountsByProgram[params[1]?.programId] ?? { value: [] };
      if (method === "getTransaction") {
        const t = txs[params[0]];
        if (typeof t === "function") return t();
        return t ?? null;
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
}

test("scan: poison-tx с битой meta — skip с причиной, скан жив, хорошие tx в отчёте", async () => {
  const client = fakeClient({
    sigPages: { [OWNER]: [
      { signature: "poison", slot: 2, blockTime: 2000, err: null },
      { signature: "good1", slot: 1, blockTime: 1000, err: null },
      { signature: "good2", slot: 3, blockTime: 3000, err: null },
    ] },
    txs: {
      good1: goodTx(100, 1),
      poison: { slot: 2, blockTime: 2000, meta: { preTokenBalances: 5 } }, // мусор из лежащего шлюза
      good2: goodTx(50, 3),
    },
  });
  const res = await scanWallet(client, OWNER, REGISTRY);
  assert.equal(res.txs.length, 2, "обе валидные tx в истории");
  assert.equal(res.fetched, 3);
  assert.equal(res.skipped.length, 1);
  assert.match(res.skipped[0].reason, /tx unreadable/, "ядовитая tx — с причиной, не с крэшем");
  assert.equal(res.skipped[0].signature, "poison");
});

test("scan: постоянная RpcError на одной tx (-32015 versioned) — skip, не смерть скана", async () => {
  const client = fakeClient({
    sigPages: { [OWNER]: [
      { signature: "v0tx", slot: 2, blockTime: 2000, err: null },
      { signature: "good1", slot: 1, blockTime: 1000, err: null },
    ] },
    txs: {
      good1: goodTx(100, 1),
      v0tx: () => { throw new RpcError("rpc", "-32015: Unsupported transaction version", { code: -32015 }); },
    },
  });
  const res = await scanWallet(client, OWNER, REGISTRY);
  assert.equal(res.txs.length, 1);
  assert.match(res.skipped[0].reason, /-32015/, "код ошибки виден в причине скипа");
});

test("scan: наш abort НЕ глотается как «tx unreadable» — летит дальше", async () => {
  const client = fakeClient({
    sigPages: { [OWNER]: [{ signature: "s1", slot: 1, blockTime: 1000, err: null }] },
    txs: { s1: () => { throw new WalletScanError("scan aborted by client", "aborted"); } },
  });
  await assert.rejects(
    () => scanWallet(client, OWNER, REGISTRY),
    (err) => err instanceof WalletScanError && err.kind === "aborted",
  );
});

test("scan: tx с meta:null (лаг индексера) — честный skip, не молчаливое исчезновение", async () => {
  const client = fakeClient({
    sigPages: { [OWNER]: [
      { signature: "noMeta", slot: 1, blockTime: 1000, err: null },
      { signature: "good1", slot: 2, blockTime: 2000, err: null },
    ] },
    txs: {
      noMeta: { slot: 1, blockTime: 1000, meta: null }, // каркас без фактуры
      good1: goodTx(100, 2),
    },
  });
  const res = await scanWallet(client, OWNER, REGISTRY);
  assert.equal(res.fetched, 2);
  assert.ok(res.skipped.some((s) => s.signature === "noMeta" && /unavailable/.test(s.reason)),
    "meta:null = недоступная фактура, видна в skipped (раньше: fetched+1 и тишина)");
});

test("scan: getTokenAccountsByOwner с value:5 — явная malformed-source, не TypeError", async () => {
  const client = fakeClient({
    accountsByProgram: { "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb": { value: 5 } },
  });
  await assert.rejects(
    () => scanWallet(client, OWNER, REGISTRY),
    (err) => err instanceof WalletScanError && err.kind === "malformed-source" && /getTokenAccountsByOwner/.test(err.message),
  );
});

test("scan: мусорные entries аккаунтов — skip с warn, битые pubkey НЕ становятся источниками сигнатур", async () => {
  const bad41 = "1".repeat(41); // base58-невалиден (класс E4)
  const client = fakeClient({
    accountsByProgram: { "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb": { value: [
      { pubkey: 12345, account: { data: { parsed: { info: { mint: SPYx, tokenAmount: { amount: "1e6" } } } } } }, // pubkey-число + мусорный amount
      { pubkey: bad41, account: { data: { parsed: { info: { mint: SPYx, tokenAmount: { amount: "7" } } } } } }, // битый base58
    ] } },
    sigPages: { [OWNER]: [] },
  });
  const res = await scanWallet(client, OWNER, REGISTRY);
  const sigSources = client.calls.filter((c) => c.method === "getSignaturesForAddress").map((c) => c.key);
  assert.ok(!sigSources.includes(bad41) && !sigSources.includes(12345), "битые pubkey не жгут RPC и не валят скан");
  assert.deepEqual([...res.accounts.values()], [], "мусорные балансы не попали в сверку");
});
