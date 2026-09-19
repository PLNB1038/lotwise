import test from "node:test";
import assert from "node:assert/strict";
import { scanWallet, isValidAddress, WalletScanError } from "../src/wallet/scan.mjs";
import { buildWalletReport } from "../src/wallet/report.mjs";
import { fetchWalletDeltas, fetchTokenDeltas } from "../src/ingest/tx.mjs";
import { MultiplierTimeline } from "../src/lots/timeline.mjs";
import { multiplierHistoryToEvents } from "../src/events/normalize-xstocks.mjs";
import { loadRegistry } from "../src/registry/registry.mjs";
import { createApiServer } from "../src/api/server.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
// строго из base58-алфавита (без 0, O, I, l), длина 44
const OWNER = "Wa11etBuyer" + "a".repeat(32);
const OTHER = "Wa11etSe11er" + "b".repeat(32);
const SPYx = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const AAPLx = "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp";

// фейк-клиент: сигнатуры по каждому источнику + аккаунты + готовые транзакции
function fakeClient({ sigPages = {}, txs = {}, accountsByProgram = {} } = {}) {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push({ method, key: params[0] });
      if (method === "getSignaturesForAddress") return sigPages[params[0]] ?? [];
      if (method === "getTokenAccountsByOwner") return accountsByProgram[params[1]?.programId] ?? { value: [] };
      if (method === "getTransaction") return txs[params[0]] ?? null;
      throw new Error(`unexpected method ${method}`);
    },
  };
}

const txOf = (sig, balances, { slot = 1, blockTime = 1750000000 } = {}) => ({
  slot,
  blockTime,
  meta: {
    err: null,
    preTokenBalances: balances.filter((b) => b._pre !== undefined).map((b) => ({ owner: b.owner, mint: b.mint, uiTokenAmount: { amount: String(b._pre) } })),
    postTokenBalances: balances.map((b) => ({ owner: b.owner, mint: b.mint, uiTokenAmount: { amount: String(b.uiTokenAmount.amount) } })),
  },
});

test("isValidAddress: base58 32-44 — да, мусор — нет", () => {
  assert.equal(isValidAddress(OWNER), true);
  assert.equal(isValidAddress("0bio"), false); // 0 и биологический текст не base58
  assert.equal(isValidAddress(""), false);
  assert.equal(isValidAddress(null), false);
});

test("fetchWalletDeltas: набор минтов, все владельцы, нулевые дельты схлопываются", async () => {
  const client = fakeClient({
    txs: {
      sig1: txOf("sig1", [
        { owner: OWNER, mint: SPYx, _pre: 100, uiTokenAmount: { amount: "150" } },
        { owner: OTHER, mint: SPYx, _pre: 0, uiTokenAmount: { amount: "0" } }, // создан и закрыт — дельта 0
        { owner: OWNER, mint: AAPLx, _pre: 5, uiTokenAmount: { amount: "7" } },
        { owner: OWNER, mint: "NotTracked111111111111111111111111111111111", _pre: 1, uiTokenAmount: { amount: "9" } },
      ]),
    },
  });
  const tx = await fetchWalletDeltas(client, "sig1", new Set([SPYx, AAPLx]));
  assert.equal(tx.deltas.length, 2); // чужой нулевой и нетрекаемый минт выпали
  const spyx = tx.deltas.find((d) => d.mint === SPYx);
  assert.equal(spyx.deltaRaw, 50n);
  assert.equal(tx.deltas.find((d) => d.mint === AAPLx).deltaRaw, 2n);
});

test("fetchTokenDeltas (строкой) сохранил контракт одного минта", async () => {
  const client = fakeClient({
    txs: { sig1: txOf("sig1", [
      { owner: OWNER, mint: SPYx, _pre: 100, uiTokenAmount: { amount: "150" } },
      { owner: OWNER, mint: AAPLx, _pre: 5, uiTokenAmount: { amount: "7" } },
    ]) },
  });
  const tx = await fetchTokenDeltas(client, "sig1", SPYx);
  assert.equal(tx.deltas.length, 1);
  assert.equal(tx.deltas[0].deltaRaw, 50n);
});

test("scanWallet: err-тx не fetch'ится, недоступные — в skipped, порядок хронологический", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const client = fakeClient({
    sigPages: { [OWNER]: [
      { signature: "new-ok", slot: 3, blockTime: 300, err: null },
      { signature: "mid-fail", slot: 2, blockTime: 200, err: "InstructionError" },
      { signature: "old-ok", slot: 1, blockTime: 100, err: null },
    ] },
    txs: {
      "new-ok": txOf("new-ok", [{ owner: OWNER, mint: SPYx, _pre: 10, uiTokenAmount: { amount: "20" } }], { slot: 3, blockTime: 300 }),
      "old-ok": txOf("old-ok", [{ owner: OWNER, mint: SPYx, _pre: 0, uiTokenAmount: { amount: "10" } }], { slot: 1, blockTime: 100 }),
    },
  });
  const scan = await scanWallet(client, OWNER, registry);
  assert.equal(scan.signatures, 3);
  assert.equal(scan.fetched, 2); // err не тянулся
  assert.equal(client.calls.filter((c) => c.method === "getTransaction").length, 2);
  assert.deepEqual(
    scan.txs.map((t) => t.signature),
    ["old-ok", "new-ok"], // старейшие первыми
  );
  assert.deepEqual(scan.skipped, [{ signature: "mid-fail", reason: "tx failed on-chain" }]);
  assert.equal(scan.truncated, false);
});

test("scanWallet: потолок maxTxs режет окно честно — truncated: true", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const client = fakeClient({ sigPages: { [OWNER]: [
    { signature: "s1", slot: 1, blockTime: 1, err: null },
    { signature: "s2", slot: 2, blockTime: 2, err: null },
    { signature: "s3", slot: 3, blockTime: 3, err: null },
  ] } });
  const scan = await scanWallet(client, OWNER, registry, { maxTxs: 2 });
  assert.equal(scan.signatures, 2);
  assert.equal(scan.truncated, true);
});

test("scanWallet: мусорный адрес — ошибка, не скан", async () => {
  const registry = await loadRegistry("data/tokens.json");
  await assert.rejects(
    scanWallet(fakeClient(), "not-a-pubkey", registry),
    (e) => e instanceof WalletScanError && e.kind === "invalid-address",
  );
});

// --- сканер v2: ATA-источники и сверка ---

test("scanWallet v2: входящий перевод через token-аккаунт (владелец НЕ подписант) — пойман", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const ATA = "AtaSPYx" + "c".repeat(34); // base58, 42 символа
  const client = fakeClient({
    sigPages: {
      [OWNER]: [{ signature: "self-buy", slot: 2, blockTime: 200, err: null }],
      [ATA]: [
        { signature: "incoming-recv", slot: 1, blockTime: 100, err: null }, // fee платил отправитель
        { signature: "self-buy", slot: 2, blockTime: 200, err: null }, // дубль между источниками
      ],
    },
    accountsByProgram: {
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb": { value: [
        { pubkey: ATA, account: { data: { parsed: { info: {
          mint: SPYx, owner: OWNER, tokenAmount: { amount: "160" },
        } } } } },
      ] },
    },
    txs: {
      "self-buy": txOf("self-buy", [{ owner: OWNER, mint: SPYx, _pre: 0, uiTokenAmount: { amount: "100" } }], { slot: 2, blockTime: 200 }),
      "incoming-recv": txOf("incoming-recv", [{ owner: OWNER, mint: SPYx, _pre: 0, uiTokenAmount: { amount: "60" } }], { slot: 1, blockTime: 100 }),
    },
  });
  const scan = await scanWallet(client, OWNER, registry);
  assert.equal(scan.signatures, 2); // дедуп: self-buy под двумя источниками — один
  assert.deepEqual(scan.txs.map((t) => t.signature), ["incoming-recv", "self-buy"]);
  assert.deepEqual(scan.accounts.get(SPYx).addresses, [ATA]);
  assert.equal(scan.accounts.get(SPYx).currentRaw, 160n);
});

test("fetchOwnerTokenAccounts: оба токен-программа, только реестровые минты", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const mk = (pubkey, mint, amt) => ({ pubkey, account: { data: { parsed: { info: {
    mint, owner: OWNER, tokenAmount: { amount: amt },
  } } } } });
  const client = fakeClient({
    accountsByProgram: {
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA": { value: [
        mk("AtaA", SPYx, "7"), // xStocks живёт в Token-2022, тут для теста — обе программы
        mk("AtaJ", "Junk111111111111111111111111111111111111", "9"), // не наш минт
      ] },
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb": { value: [ mk("AtaB", AAPLx, "5") ] },
    },
  });
  const accts = await (await import("../src/wallet/scan.mjs")).fetchOwnerTokenAccounts(client, OWNER, registry);
  assert.equal(accts.size, 2);
  assert.equal(accts.get(SPYx).currentRaw, 7n);
  assert.deepEqual(accts.get(AAPLx).addresses, ["AtaB"]);
});

test("buildWalletReport: токен есть на цепи, дельт нет — виден с reconciles: false, не спрятан", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const rep = buildWalletReport(scanOf([], { accounts: { [SPYx]: { address: "At5", currentRaw: 500n } } }), { registry });
  const spyx = rep.tokens.find((t) => t.symbol === "SPYx");
  assert.ok(spyx, "токен показан, а не потерян");
  assert.equal(spyx.rawBalance, "0");
  assert.equal(spyx.onchainNow, "500");
  assert.equal(spyx.reconciles, false);
  assert.equal(rep.complete, false);
});

test("buildWalletReport: дельты не сходятся с цепью — reconciles: false, complete: false", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const txs = [
    { signature: "a", slot: 1, blockTime: 100, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 0n, postRaw: 60n, deltaRaw: 60n }] },
  ];
  const rep = buildWalletReport(scanOf(txs, { accounts: { [SPYx]: { address: "At6", currentRaw: 70n } } }), { registry });
  const spyx = rep.tokens.find((t) => t.symbol === "SPYx");
  assert.equal(spyx.rawBalance, "60");
  assert.equal(spyx.onchainNow, "70");
  assert.equal(spyx.reconciles, false); // 10 базовых юнитов истории вне окна скана
  assert.equal(rep.complete, false);
});

// --- чистый отчёт ---

const scanOf = (txs, extra = {}) => ({
  owner: OWNER, signatures: txs.length, fetched: txs.length, txs, skipped: [], truncated: false, accounts: {}, ...extra,
});

test("buildWalletReport: FIFO — покупка, частичное покрытие, второй лот, остаток", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const txs = [
    { signature: "a", slot: 1, blockTime: 100, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 0n, postRaw: 100n, deltaRaw: 100n }] },
    { signature: "b", slot: 2, blockTime: 200, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 100n, postRaw: 130n, deltaRaw: 30n }] },
    { signature: "c", slot: 3, blockTime: 300, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 130n, postRaw: 60n, deltaRaw: -70n }] },
  ];
  const rep = buildWalletReport(scanOf(txs, { accounts: { [SPYx]: { address: "At1", currentRaw: 60n } } }), { registry });
  assert.equal(rep.owner, OWNER);
  assert.equal(rep.method, "fifo");
  assert.equal(rep.complete, true);
  const spyx = rep.tokens.find((t) => t.symbol === "SPYx");
  assert.equal(spyx.rawBalance, "60");
  assert.equal(spyx.onchainNow, "60");
  assert.equal(spyx.reconciles, true); // дельты сходятся с живым балансом
  assert.equal(spyx.lots.length, 2); // FIFO съел 70 из лота-100: остатки 30 + 30
  assert.equal(spyx.lots[0].qtyRaw, "30");
  assert.equal(spyx.lots[0].acquiredDate, new Date(100 * 1000).toISOString());
  assert.equal(spyx.lots[1].qtyRaw, "30");
  assert.equal(spyx.lots[1].acquiredDate, new Date(200 * 1000).toISOString());
  assert.equal(spyx.realizedCount, 1); // одна продажа покрылась первым лотом целиком
  assert.equal(spyx.realizedQtyRaw, "70");
});

test("buildWalletReport: расход до покупки (окно скана поздно) — гэп, complete: false, баланс честный", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const txs = [
    { signature: "sell-first", slot: 1, blockTime: 100, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 500n, postRaw: 200n, deltaRaw: -300n }] },
    { signature: "buy-later", slot: 2, blockTime: 200, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 200n, postRaw: 260n, deltaRaw: 60n }] },
  ];
  const rep = buildWalletReport(scanOf(txs), { registry });
  const spyx = rep.tokens.find((t) => t.symbol === "SPYx");
  assert.equal(spyx.rawBalance, "-240"); // -300+60: баланс окна отрицателен — так и показываем
  assert.equal(spyx.gaps.length, 1);
  assert.equal(spyx.gaps[0].missingQtyRaw, "300");
  assert.equal(rep.complete, false);
  assert.equal(spyx.reconciles, false); // баланс окна -240 не сходится с пустым кошельком
});

test("buildWalletReport: чужие дельты и нерелевантные минты игнорируются; adjusted с пылью через timeline", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const nodes = JSON.parse(readFileSync(path.join(dir, "xstocks-spyx-history-eth.json"), "utf8")).nodes;
  const evts = multiplierHistoryToEvents(nodes, { symbol: "SPYx" }).map((e) => ({ ...e, mint: SPYx }));
  const timelines = new Map([[SPYx, new MultiplierTimeline(evts)]]);
  const txs = [
    { signature: "a", slot: 1, blockTime: 1000, deltas: [
      { owner: OWNER, mint: SPYx, preRaw: 0n, postRaw: 100000000n, deltaRaw: 100000000n },
      { owner: OTHER, mint: SPYx, preRaw: 0n, postRaw: 999n, deltaRaw: 999n }, // чужой
    ] },
  ];
  const rep = buildWalletReport(scanOf(txs, { accounts: { [SPYx]: { address: "At2", currentRaw: 100000000n } } }), { registry, timelines });
  const spyx = rep.tokens.find((t) => t.symbol === "SPYx");
  assert.equal(spyx.rawBalance, "100000000"); // только владелец
  assert.equal(spyx.multiplier.now, "1.005714560286254");
  assert.equal(spyx.multiplier.events, 4);
  assert.equal(spyx.adjusted.whole, "100571456"); // 1.0 × 1.0057…
  assert.equal(spyx.adjusted.exact, false); // пыль показана
  assert.ok(Number(spyx.adjusted.remainder) > 0);
});

test("buildWalletReport: токен без событий — множитель 1, adjusted точный", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const txs = [
    { signature: "a", slot: 1, blockTime: 1000, deltas: [{ owner: OWNER, mint: AAPLx, preRaw: 0n, postRaw: 42n, deltaRaw: 42n }] },
  ];
  const rep = buildWalletReport(scanOf(txs, { accounts: { [AAPLx]: { address: "At3", currentRaw: 42n } } }), { registry });
  const a = rep.tokens.find((t) => t.symbol === "AAPLx");
  assert.equal(a.multiplier.now, "1");
  assert.equal(a.multiplier.events, 0);
  assert.deepEqual(a.adjusted, { exact: true, whole: "42", remainder: "0", den: "1" });
  assert.equal(rep.complete, true);
});

// --- маршрут /lots ---

async function withServer(walletScanner, fn) {
  const registry = await loadRegistry("data/tokens.json");
  const server = await createApiServer({ registry, events: [], walletScanner });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("/lots: без адреса и мусорный адрес — 400, без сканера — 503", async () => {
  await withServer(null, async (base) => {
    assert.equal((await fetch(`${base}/lots`)).status, 400);
    const bad = await fetch(`${base}/lots?address=abc`);
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /base58/);
    const noscanner = await fetch(`${base}/lots?address=${OWNER}`);
    assert.equal(noscanner.status, 503);
  });
});

test("/lots: отчёт из сканера — FIFO и counts на месте", async () => {
  const fakeScan = {
    owner: OWNER, signatures: 2, fetched: 2, skipped: [], truncated: false,
    accounts: new Map([[SPYx, { address: "At4", currentRaw: 4n }]]),
    txs: [
      { signature: "a", slot: 1, blockTime: 100, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 0n, postRaw: 10n, deltaRaw: 10n }] },
      { signature: "b", slot: 2, blockTime: 200, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 10n, postRaw: 4n, deltaRaw: -6n }] },
    ],
  };
  await withServer(async (addr) => fakeScan, async (base) => {
    const rep = await (await fetch(`${base}/lots?address=${OWNER}`)).json();
    assert.equal(rep.owner, OWNER);
    assert.equal(rep.counts.relevantTxs, 2);
    const spyx = rep.tokens.find((t) => t.symbol === "SPYx");
    assert.equal(spyx.rawBalance, "4");
    assert.equal(spyx.lots[0].qtyRaw, "4");
    assert.equal(spyx.multiplier.now, "1"); // сервер без событий — план 1, честно
  });
});

test("/lots: сканер бросил RpcError-подобное — 503 с kind", async () => {
  const err = new Error("HTTP 429");
  err.kind = "rate-limit";
  await withServer(async () => { throw err; }, async (base) => {
    const res = await fetch(`${base}/lots?address=${OWNER}`);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).kind, "rate-limit");
  });
});

// ---- раунд-2: мультиаккаунтность одного минта ----

test("два аккаунта одного минта (ATA + legacy): скан обоих, баланс = сумме, отчёт сходится", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const ATA = "AtaSPYx" + "c".repeat(34);
  const LEG = "LegSPYx" + "d".repeat(34);
  const mk = (pubkey, amount) => ({ pubkey, account: { data: { parsed: { info: {
    mint: SPYx, owner: OWNER, tokenAmount: { amount },
  } } } } });
  const client = fakeClient({
    sigPages: {
      [OWNER]: [],
      [ATA]: [{ signature: "ata-buy", slot: 2, blockTime: 200, err: null }],
      [LEG]: [{ signature: "leg-buy", slot: 1, blockTime: 100, err: null }],
    },
    accountsByProgram: {
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb": { value: [mk(ATA, "100"), mk(LEG, "60")] },
    },
    txs: {
      "ata-buy": txOf("ata-buy", [{ owner: OWNER, mint: SPYx, _pre: 0, uiTokenAmount: { amount: "100" } }], { slot: 2, blockTime: 200 }),
      "leg-buy": txOf("leg-buy", [{ owner: OWNER, mint: SPYx, _pre: 0, uiTokenAmount: { amount: "60" } }], { slot: 1, blockTime: 100 }),
    },
  });
  // до фикса: разные балансы = throw ambiguous-accounts (отказ честному кошельку),
  // равные = молчаливая перезапись и потеря истории одного из аккаунтов
  const scan = await scanWallet(client, OWNER, registry);
  assert.deepEqual([...scan.accounts.get(SPYx).addresses].sort(), [ATA, LEG].sort());
  assert.equal(scan.accounts.get(SPYx).currentRaw, 160n);
  const rep = buildWalletReport(scan, { registry });
  const spyx = rep.tokens.find((t) => t.symbol === "SPYx");
  assert.equal(spyx.rawBalance, "160");
  assert.equal(spyx.reconciles, true);
});

test("хронология по slot: blockTime=null не ломает порядок FIFO", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const client = fakeClient({
    sigPages: {
      [OWNER]: [
        { signature: "late-null-bt", slot: 30, blockTime: null, err: null },
        { signature: "early", slot: 2, blockTime: 1750000000, err: null },
      ],
    },
    txs: {
      "early": txOf("early", [{ owner: OWNER, mint: SPYx, _pre: 0, uiTokenAmount: { amount: "10" } }], { slot: 2, blockTime: 1750000000 }),
      "late-null-bt": txOf("late-null-bt", [{ owner: OWNER, mint: SPYx, _pre: 10, uiTokenAmount: { amount: "20" } }], { slot: 30, blockTime: null }),
    },
  });
  // до фикса компаратор смешивал секунды и слоты: null-blockTime съезжал в «древние»
  const scan = await scanWallet(client, OWNER, registry);
  assert.deepEqual(scan.txs.map((t) => t.signature), ["early", "late-null-bt"]);
});
