import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient, RpcError } from "../src/ingest/rpc.mjs";
import { streamSignatures } from "../src/ingest/signatures.mjs";
import { fetchTokenDeltas } from "../src/ingest/tx.mjs";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const FIX = (name) => JSON.parse(readFileSync(path.join(dir, name), "utf8"));

const MINT = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB";

// ---- мок-инфраструктура ----
const jsonRes = (result, { status = 200 } = {}) => ({
  ok: status < 400, status,
  json: async () => (result === undefined ? {} : { jsonrpc: "2.0", id: 1, result }),
});

function makeClient(responses, { recorded = [] } = {}) {
  let i = 0;
  const fetcher = async (url, opts) => {
    recorded.push({ url, body: JSON.parse(opts.body) });
    const next = responses[Math.min(i++, responses.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  };
  const sleep = async () => {}; // время в тестах не ждём
  return new RpcClient({ endpoint: "https://rpc.example", fetcher, sleep, minIntervalMs: 0 });
}

// ---- RpcClient ----

test("успешный call возвращает result и несёт UA-заголовок", async () => {
  const rec = [];
  const c = makeClient([jsonRes(42)], { recorded: rec });
  assert.equal(await c.call("getSlot", []), 42);
  assert.equal(rec[0].body.method, "getSlot");
});

test("429 → retry → успех (экспоненциальные паузы)", async () => {
  const c = makeClient([
    { ok: false, status: 429, json: async () => ({}) },
    { ok: false, status: 429, json: async () => ({}) },
    jsonRes("final"),
  ]);
  assert.equal(await c.call("getSlot", []), "final");
  assert.equal(c.requestCount, 3);
});

test("429 без исчерпания ретраев → RpcError rate-limit", async () => {
  const c = makeClient([{ ok: false, status: 429, json: async () => ({}) }]);
  await assert.rejects(() => c.call("getSlot", []), (err) => err instanceof RpcError && err.kind === "rate-limit");
});

test("404 (прочий 4xx) НЕ ретраится — один запрос", async () => {
  const c = makeClient([{ ok: false, status: 404, json: async () => ({}) }]);
  await assert.rejects(() => c.call("getSlot", []), (err) =>
    err instanceof RpcError && err.kind === "http" && err.status === 404);
  assert.equal(c.requestCount, 1, "4xx кроме 429 — запрос плох, ретрай бессмыслен");
});

test("503 ретраится как 5xx — до успеха", async () => {
  const c = makeClient([{ ok: false, status: 503, json: async () => ({}) }, jsonRes("ok")]);
  assert.equal(await c.call("getSlot", []), "ok");
  assert.equal(c.requestCount, 2);
});

test("jsonrpc-ошибка НЕ ретраится и несёт код (-32015)", async () => {
  const c = makeClient([{
    ok: true, status: 200,
    json: async () => ({ jsonrpc: "2.0", id: 1, error: { code: -32015, message: "Unsupported transaction version" } }),
  }]);
  await assert.rejects(() => c.call("getTransaction", []), (err) =>
    err instanceof RpcError && err.kind === "rpc" && err.code === -32015);
  assert.equal(c.requestCount, 1, "rpc-ошибки не ретраим");
});

test("сетевой выброс классифицируется как network", async () => {
  const c = makeClient([new Error("ECONNRESET"), new Error("ECONNRESET"), new Error("ECONNRESET"), new Error("ECONNRESET")]);
  await assert.rejects(() => c.call("getSlot", []), (err) => err instanceof RpcError && err.kind === "network");
});

test("троттлинг: подряд идущие call ждут minIntervalMs", async () => {
  const sleeps = [];
  const c = new RpcClient({
    endpoint: "https://rpc.example",
    fetcher: async () => jsonRes(1),
    sleep: async (ms) => sleeps.push(ms),
    minIntervalMs: 350,
  });
  await c.call("getSlot", []);
  await c.call("getSlot", []);
  assert.ok(sleeps.some((ms) => ms > 0), "второй вызов должен был подождать");
});

// ---- streamSignatures ----

test("пагинация: две полные страницы + пустая третья → стоп", async () => {
  const page1 = Array.from({ length: 3 }, (_, i) => ({ signature: `s1_${i}`, slot: 100 + i, blockTime: 1, err: null }));
  const page2 = Array.from({ length: 3 }, (_, i) => ({ signature: `s2_${i}`, slot: 90 + i, blockTime: 1, err: null }));
  const c = makeClient([jsonRes(page1), jsonRes(page2), jsonRes([])]);
  const seen = [];
  for await (const s of streamSignatures(c, MINT, { limit: 3 })) seen.push(s);
  assert.equal(seen.length, 6);
  const bodies = c.requestCount; // 3 запроса
  assert.equal(bodies, 3);
});

test("короткая последняя страница НЕ конец — стрим допрашивает до пустой/без-прогресса (раунд 8)", async () => {
  const page1 = Array.from({ length: 3 }, (_, i) => ({ signature: `a${i}`, slot: i, blockTime: 1, err: null }));
  // makeClient повторяет последний ответ: после «tail» (< limit) стрим обязан спросить
  // ещё раз; повторная страница tail — без прогресса (и без новых уникальных) → стоп
  const c = makeClient([jsonRes(page1), jsonRes([{ signature: "tail", slot: 1, blockTime: 1, err: null }])]);
  const seen = [];
  for await (const s of streamSignatures(c, MINT, { limit: 3 })) seen.push(s);
  assert.equal(seen.length, 4); // 3 + 1 уникальная; дубль tail не выдаётся (контракт уникальности)
  assert.equal(c.requestCount, 4); // короткая потребовала подтверждения, повтор без новых — стоп (раунд 9: K-нулевого прогресса)
});

test("err-транзакции приходят с флагом err", async () => {
  const c = makeClient([jsonRes([{ signature: "bad", slot: 5, blockTime: 1, err: { InstructionError: [0, "Custom"] } }])]);
  const seen = [];
  for await (const s of streamSignatures(c, MINT)) seen.push(s);
  assert.deepEqual(seen[0].err, { InstructionError: [0, "Custom"] });
});

// ---- fetchTokenDeltas ----

test("legacy-фикстура: целая дельта +750000", async () => {
  const c = makeClient([jsonRes(FIX("tx-legacy.json"))]);
  const r = await fetchTokenDeltas(c, "sig-legacy", MINT);
  assert.equal(r.slot, 335000111);
  assert.equal(r.deltas.length, 1);
  assert.equal(r.deltas[0].preRaw, 1000000n);
  assert.equal(r.deltas[0].postRaw, 1750000n);
  assert.equal(r.deltas[0].deltaRaw, 750000n);
});

test("versioned-фикстура (version 0) обрабатывается, дельта отрицательная", async () => {
  const c = makeClient([jsonRes(FIX("tx-versioned.json"))]);
  const r = await fetchTokenDeltas(c, "sig-v0", MINT);
  assert.equal(r.deltas[0].deltaRaw, -2000000n);
  assert.equal(r.err, null);
});

test("tx=null → честный null без исключения", async () => {
  const c = makeClient([jsonRes(null)]);
  assert.equal(await fetchTokenDeltas(c, "sig-missing", MINT), null);
});

test("запрос уходит с maxSupportedTransactionVersion:1", async () => {
  const rec = [];
  const c = makeClient([jsonRes(FIX("tx-legacy.json"))], { recorded: rec });
  await fetchTokenDeltas(c, "sig-x", MINT);
  assert.equal(rec[0].body.params[1].maxSupportedTransactionVersion, 1);
});

test("чужой минт в балансах игнорируется", async () => {
  const tx = FIX("tx-legacy.json");
  tx.meta.postTokenBalances.push({
    owner: "Owner11111111111111111111111111111111111111111",
    mint: "AnotherMint11111111111111111111111111111111111111",
    uiTokenAmount: { amount: "999", decimals: 6, uiAmountString: "0.000999" },
  });
  const c = makeClient([jsonRes(tx)]);
  const r = await fetchTokenDeltas(c, "sig-x", MINT);
  assert.ok(r.deltas.every((d) => d.mint === MINT));
});

// ---- раунд-2: несколько аккаунтов одного минта у одного владельца ----

const OWNER2 = "Owner11111111111111111111111111111111111111111";

test("самоперенос между двумя аккаунтами одного минта = дельта 0, не фантомная сделка", async () => {
  const tx = {
    slot: 1, blockTime: 1750000000,
    meta: {
      err: null,
      preTokenBalances: [
        { accountIndex: 3, owner: OWNER2, mint: MINT, uiTokenAmount: { amount: "100" } },
        { accountIndex: 5, owner: OWNER2, mint: MINT, uiTokenAmount: { amount: "0" } },
      ],
      postTokenBalances: [
        { accountIndex: 3, owner: OWNER2, mint: MINT, uiTokenAmount: { amount: "0" } },
        { accountIndex: 5, owner: OWNER2, mint: MINT, uiTokenAmount: { amount: "100" } },
      ],
    },
  };
  const c = makeClient([jsonRes(tx)]);
  const r = await fetchTokenDeltas(c, "sig-consolidate", MINT);
  // консолидация legacy -> ATA: экономики нет; до фикса ключ owner|mint мерджил
  // аккаунты и рисовал ±100 фантомом
  assert.equal(r.deltas.length, 0);
});

test("два аккаунта с реальными покупками: дельта владельца = сумма аккаунтов", async () => {
  const tx = {
    slot: 1, blockTime: 1750000000,
    meta: {
      err: null,
      preTokenBalances: [
        { accountIndex: 3, owner: OWNER2, mint: MINT, uiTokenAmount: { amount: "0" } },
        { accountIndex: 5, owner: OWNER2, mint: MINT, uiTokenAmount: { amount: "10" } },
      ],
      postTokenBalances: [
        { accountIndex: 3, owner: OWNER2, mint: MINT, uiTokenAmount: { amount: "100" } },
        { accountIndex: 5, owner: OWNER2, mint: MINT, uiTokenAmount: { amount: "40" } },
      ],
    },
  };
  const c = makeClient([jsonRes(tx)]);
  const r = await fetchTokenDeltas(c, "sig-two-buys", MINT);
  assert.equal(r.deltas.length, 1);
  assert.equal(r.deltas[0].deltaRaw, 130n);
  assert.equal(r.deltas[0].preRaw, 10n);
  assert.equal(r.deltas[0].postRaw, 140n);
});

// ---- раунд-4: смена владельца токен-аккаунта внутри tx (SetAuthority) ----

const W1 = "Wallet1111111111111111111111111111111111111111";
const W2 = "Wallet2222222222222222222222222222222222222222";

test("SetAuthority: смена владельца аккаунта в одной tx расщепляется на −100 W1 / +100 W2", async () => {
  // до фикса post-запись переиспользовала cur с owner из PRE: вся дельта уходила W1,
  // у которого она = 0, и вырезалась фильтром нулей → deltas = [] (перевод исчезал,
  // оба владельца лгали в FIFO)
  const tx = {
    slot: 1, blockTime: 1750000000,
    meta: {
      err: null,
      preTokenBalances: [{ accountIndex: 0, owner: W1, mint: MINT, uiTokenAmount: { amount: "100" } }],
      postTokenBalances: [{ accountIndex: 0, owner: W2, mint: MINT, uiTokenAmount: { amount: "100" } }],
    },
  };
  const c = makeClient([jsonRes(tx)]);
  const r = await fetchTokenDeltas(c, "sig-set-authority", MINT);
  assert.equal(r.deltas.length, 2, "перевод не должен исчезать");
  const w1 = r.deltas.find((d) => d.owner === W1);
  const w2 = r.deltas.find((d) => d.owner === W2);
  assert.ok(w1 && w2);
  assert.equal(w1.preRaw, 100n);
  assert.equal(w1.postRaw, 0n);
  assert.equal(w1.deltaRaw, -100n);
  assert.equal(w2.preRaw, 0n);
  assert.equal(w2.postRaw, 100n);
  assert.equal(w2.deltaRaw, 100n);
});

test("legacy-фолбэк (ключ owner|mint): смена владельца расщепляется структурно", async () => {
  // разные owner дают разные ключи фолбэка — pre/post уже не встречаются, фиксируем контракт
  const tx = {
    slot: 1, blockTime: 1750000000,
    meta: {
      err: null,
      preTokenBalances: [{ owner: W1, mint: MINT, uiTokenAmount: { amount: "50" } }],
      postTokenBalances: [{ owner: W2, mint: MINT, uiTokenAmount: { amount: "50" } }],
    },
  };
  const c = makeClient([jsonRes(tx)]);
  const r = await fetchTokenDeltas(c, "sig-legacy-owner-change", MINT);
  assert.equal(r.deltas.length, 2);
  assert.equal(r.deltas.find((d) => d.owner === W1).deltaRaw, -50n);
  assert.equal(r.deltas.find((d) => d.owner === W2).deltaRaw, 50n);
});

test("создание (pre нет) и закрытие (post нет) аккаунта при чужом ключе — как раньше", async () => {
  const tx = {
    slot: 1, blockTime: 1750000000,
    meta: {
      err: null,
      preTokenBalances: [{ accountIndex: 7, owner: W1, mint: MINT, uiTokenAmount: { amount: "30" } }],
      postTokenBalances: [{ accountIndex: 8, owner: W2, mint: MINT, uiTokenAmount: { amount: "77" } }],
    },
  };
  const c = makeClient([jsonRes(tx)]);
  const r = await fetchTokenDeltas(c, "sig-open-close", MINT);
  assert.equal(r.deltas.length, 2);
  assert.equal(r.deltas.find((d) => d.owner === W1).deltaRaw, -30n); // закрытие
  assert.equal(r.deltas.find((d) => d.owner === W2).deltaRaw, 77n); // создание
});
