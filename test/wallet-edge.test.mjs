// Адверсариальные границы кошелькового сканера и FIFO-отчёта (раунд 7).
// Пинится ФАКТИЧЕСКОЕ поведение через мок-клиент (сети нет, как принято в этих тестах).
// История: метка «GAP:» фиксировала дыру/асимметрию текущего поведения (src не
// чинился); найденные в этом раунде GAP'ы (failed-tx, задвоение баланса, потолок
// maxTxs) починены в src — их пины переписаны под правильное поведение.
import test from "node:test";
import assert from "node:assert/strict";
import { scanWallet, fetchOwnerTokenAccounts, TOKEN_PROGRAMS, WalletScanError } from "../src/wallet/scan.mjs";
import { buildWalletReport } from "../src/wallet/report.mjs";
import { fetchWalletDeltas } from "../src/ingest/tx.mjs";

// строго base58 (без 0, O, I, l)
const SPYx = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const AAPLx = "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp";
const OWNER = "Wa11etBuyer" + "a".repeat(32);
const UNTRACKED = "Untracked1111111111111111111111111111111111";

const REG = [
  { mint: SPYx, symbol: "SPYx", name: "S&P 500 xStock", decimals: 8 },
  { mint: AAPLx, symbol: "AAPLx", name: "Apple xStock", decimals: 8 },
];

// фейк-клиент с НАСТОЯЩЕЙ пагинацией: страницы режутся по before, как публичный RPC
function fakeScanClient({ pages = {}, txs = {}, accountsByProgram = {} } = {}) {
  const sigCalls = []; // before-параметр каждого getSignaturesForAddress
  const txCalls = []; // параметры каждого getTransaction
  return {
    sigCalls,
    txCalls,
    async call(method, params) {
      if (method === "getTokenAccountsByOwner") {
        return accountsByProgram[params[1]?.programId] ?? { value: [] };
      }
      if (method === "getSignaturesForAddress") {
        sigCalls.push(params[1]?.before);
        const all = pages[params[0]] ?? [];
        const before = params[1]?.before;
        const start = before === undefined ? 0 : all.findIndex((s) => s.signature === before) + 1;
        return all.slice(start, start + params[1].limit);
      }
      if (method === "getTransaction") {
        txCalls.push(params);
        return txs[params[0]] ?? null;
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
}

const sig = (s, slot, err = null) => ({ signature: s, slot, blockTime: slot, err });

// getTransaction-ответ: pre берётся из _pre, post — из uiTokenAmount.amount
const txOf = (sig_, balances, { slot = 1, blockTime = 1750000000, version } = {}) => ({
  slot,
  blockTime,
  ...(version !== undefined ? { version } : {}),
  meta: {
    err: null,
    preTokenBalances: balances.filter((b) => b._pre !== undefined)
      .map((b) => ({ owner: b.owner, mint: b.mint, uiTokenAmount: { amount: String(b._pre) } })),
    postTokenBalances: balances.map((b) => ({ owner: b.owner, mint: b.mint, uiTokenAmount: { amount: String(b.uiTokenAmount.amount) } })),
  },
});

// чистый отчёт поверх собранного скана (как в round5-lots-report)
const scanOf = (txs, extra = {}) => ({
  owner: OWNER, signatures: txs.length, fetched: txs.length, txs, skipped: [], truncated: false, accounts: {}, ...extra,
});

const delta1 = (sig_, slot, deltaRaw, blockTime = slot * 100) => ({
  signature: sig_, slot, blockTime,
  deltas: [{ owner: OWNER, mint: SPYx, preRaw: 0n, postRaw: 0n, deltaRaw }],
});

// Шпион на console.error (как в round6-dedup-warn): warn сканера — единственный ожидаемый канал
async function captureConsoleError(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...args) => lines.push(args.map(String).join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = orig;
  }
}

// ===========================================================================
// Группа 1. Скан: границы потока сигнатур
// ===========================================================================

test("scanWallet: пустая история по всем источникам — нули, not truncated, getTransaction не зовётся", async () => {
  const client = fakeScanClient({ pages: { [OWNER]: [] } });
  const scan = await scanWallet(client, OWNER, REG);
  assert.equal(scan.signatures, 0);
  assert.equal(scan.fetched, 0);
  assert.deepEqual(scan.txs, []);
  assert.deepEqual(scan.skipped, []);
  assert.equal(scan.truncated, false);
  assert.equal(client.sigCalls.length, 1, "один источник (адрес) — один запрос сигнатур");
  assert.equal(client.txCalls.length, 0, "фечить нечего");
});

test("scanWallet: сигнатуры есть, но tx не трогает реестровые минты — fetched, но txs/skipped пусты", async () => {
  const client = fakeScanClient({
    pages: { [OWNER]: [sig("foreign", 1)] },
    txs: { foreign: txOf("foreign", [
      { owner: OWNER, mint: UNTRACKED, _pre: 0, uiTokenAmount: { amount: "99" } },
    ]) },
  });
  const scan = await scanWallet(client, OWNER, REG);
  assert.equal(scan.signatures, 1);
  assert.equal(scan.fetched, 1, "tx фетчилась — работа посчитана");
  assert.deepEqual(scan.txs, [], "нерелевантная tx не попадает в историю");
  assert.deepEqual(scan.skipped, [], "…и не считается skipped: она не мусор, просто не наша");
  const rep = buildWalletReport(scan, { registry: REG });
  assert.equal(rep.counts.relevantTxs, 0);
  assert.deepEqual(rep.tokens, []);
});

test("scanWallet: дубликаты сигнатур в перекрывающихся батчах — дедуп, каждая tx фетчится один раз", async () => {
  // перекрытие батчей (b в обеих страницах) — мусор от эндпоинта; страницы режутся по before
  const client = fakeScanClient({
    pages: { [OWNER]: [sig("a", 1), sig("b", 2), sig("b", 2), sig("c", 3)] },
    txs: {
      a: txOf("a", [{ owner: OWNER, mint: SPYx, _pre: 0, uiTokenAmount: { amount: "10" } }], { slot: 1 }),
      b: txOf("b", [{ owner: OWNER, mint: SPYx, _pre: 10, uiTokenAmount: { amount: "20" } }], { slot: 2 }),
      c: txOf("c", [{ owner: OWNER, mint: SPYx, _pre: 20, uiTokenAmount: { amount: "25" } }], { slot: 3 }),
    },
  });
  const scan = await scanWallet(client, OWNER, REG, { limit: 2 });
  assert.equal(scan.signatures, 3, "уникальных сигнатур 3, дубль b схлопнут");
  assert.equal(scan.fetched, 3, "каждая уникальная tx фетчится ровно один раз");
  assert.deepEqual(scan.txs.map((t) => t.signature), ["a", "b", "c"]);
  assert.equal(scan.truncated, false);
});

test("scanWallet: дубликат сигнатуры не съедает потолок maxTxs — уникальная tx берётся", async () => {
  // Бывший GAP: потолок считал ВХОЖДЕНИЯ сигнатур (taken++ до дедупа) — дубль b из
  // перекрывшихся батчей тратил слот, и уникальная c из выданного эндпоинтом батча
  // не бралась вовсе. Теперь потолок по УНИКАЛЬНЫМ сигнатурам: окно режется по
  // истории, а не по мусору выдачи; truncated остаётся честным («могли не увидеть»).
  const client = fakeScanClient({
    pages: { [OWNER]: [sig("a", 1), sig("b", 2), sig("b", 2), sig("c", 3)] },
    txs: {
      a: txOf("a", [{ owner: OWNER, mint: SPYx, _pre: 0, uiTokenAmount: { amount: "10" } }], { slot: 1 }),
      b: txOf("b", [{ owner: OWNER, mint: SPYx, _pre: 10, uiTokenAmount: { amount: "20" } }], { slot: 2 }),
      c: txOf("c", [{ owner: OWNER, mint: SPYx, _pre: 20, uiTokenAmount: { amount: "25" } }], { slot: 3 }),
    },
  });
  const scan = await scanWallet(client, OWNER, REG, { limit: 2, maxTxs: 3 });
  assert.equal(scan.signatures, 3, "все три уникальные взяты: дубль b слот потолка не съел");
  assert.deepEqual(scan.txs.map((t) => t.signature), ["a", "b", "c"]);
  assert.equal(scan.truncated, false, "история дочитана — ложный truncated не ставится");
  assert.equal(scan.fetched, 3);
});

test("scanWallet: дубликаты до потолка — уникалы добираются, truncated не выдумывается", async () => {
  // позитив на фикс потолка: батч [a, a, b] при maxTxs=2 берёт ровно уникалы a и b;
  // раньше второй a съедал потолок — signatures=1 и выдуманный truncated при
  // полностью дочитанной истории
  const client = fakeScanClient({
    pages: { [OWNER]: [sig("a", 1), sig("a", 1), sig("b", 2)] },
    txs: {
      a: txOf("a", [{ owner: OWNER, mint: SPYx, _pre: 0, uiTokenAmount: { amount: "10" } }], { slot: 1 }),
      b: txOf("b", [{ owner: OWNER, mint: SPYx, _pre: 10, uiTokenAmount: { amount: "20" } }], { slot: 2 }),
    },
  });
  const scan = await scanWallet(client, OWNER, REG, { limit: 3, maxTxs: 2 });
  assert.deepEqual(scan.txs.map((t) => t.signature), ["a", "b"], "уникальная b попала в окно после дубля a");
  assert.equal(scan.signatures, 2);
  assert.equal(scan.truncated, false, "за b ничего нет — история полна, truncation лгал бы");
  assert.equal(scan.fetched, 2);
});

test("scanWallet: пагинация по before — курсор = последняя сигнатура страницы; короткая допрашивается до подтверждения концом (раунд 8)", async () => {
  const pages = { [OWNER]: [sig("s0", 1), sig("s1", 2), sig("s2", 3), sig("s3", 4), sig("s4", 5)] };
  const txs = {};
  for (const s of ["s0", "s1", "s2", "s3", "s4"]) {
    txs[s] = txOf(s, [{ owner: OWNER, mint: SPYx, _pre: 0, uiTokenAmount: { amount: "1" } }]);
  }
  const client = fakeScanClient({ pages, txs });
  const scan = await scanWallet(client, OWNER, REG, { limit: 2, maxTxs: 10 });
  assert.equal(scan.signatures, 5, "все пять сигнатур со всех страниц");
  assert.equal(scan.truncated, false);
  // третья страница короткая (1 < 2) — больше НЕ конец: четвёртый запрос подтверждает
  // (повтор страницы = нет прогресса/новых уникальных) и только тогда стоп
  assert.deepEqual(client.sigCalls, [undefined, "s1", "s3", "s4"], "курсор — последняя сигнатура каждой прочитанной страницы");
});

test("scanWallet: maxTxs:0 — окно пустое, но truncated:true (пустота не маскируется под полноту)", async () => {
  const client = fakeScanClient({ pages: { [OWNER]: [sig("s1", 1)] } });
  const scan = await scanWallet(client, OWNER, REG, { maxTxs: 0 });
  assert.equal(scan.signatures, 0);
  assert.equal(scan.fetched, 0);
  assert.equal(scan.truncated, true, "потолок 0 достигнут сразу: отчёт обязан знать, что история не прочитана");
});

test("scanWallet: transfer за потолком maxTxs — окно режется, complete:false честен даже при сходящихся цифрах", async () => {
  // s3 за потолком вообще не фетчится; на цепи это перевод чужого минта, поэтому
  // дельты окна сходятся с балансом (reconciles) — но complete обязан остаться false:
  // непрочитанный хвост истории сам по себе делает отчёт неполным.
  const client = fakeScanClient({
    pages: { [OWNER]: [sig("buy1", 1), sig("buy2", 2), sig("noise", 3)] },
    txs: {
      buy1: txOf("buy1", [{ owner: OWNER, mint: SPYx, _pre: 0, uiTokenAmount: { amount: "60" } }], { slot: 1 }),
      buy2: txOf("buy2", [{ owner: OWNER, mint: SPYx, _pre: 60, uiTokenAmount: { amount: "100" } }], { slot: 2 }),
      noise: txOf("noise", [{ owner: OWNER, mint: UNTRACKED, _pre: 0, uiTokenAmount: { amount: "5" } }], { slot: 3 }),
    },
    accountsByProgram: {
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb": { value: [
        { pubkey: "AtaEdge" + "c".repeat(34), account: { data: { parsed: { info: {
          mint: SPYx, owner: OWNER, tokenAmount: { amount: "100" },
        } } } } },
      ] },
    },
  });
  const scan = await scanWallet(client, OWNER, REG, { maxTxs: 2 });
  assert.equal(scan.signatures, 2);
  assert.equal(scan.truncated, true);
  assert.equal(client.txCalls.length, 2, "noise за потолком не фетчилась");
  const rep = buildWalletReport(scan, { registry: REG });
  const spyx = rep.tokens.find((t) => t.symbol === "SPYx");
  assert.equal(spyx.reconciles, true, "дельты окна (60+40) сходятся с цепью (100)");
  assert.equal(rep.complete, false, "…но truncated сам по себе делает отчёт неполным");
});

test("fetchOwnerTokenAccounts: мусор в выдаче (нет info/parsed/data, чужой минт, нет amount) — скан жив", async () => {
  const mk = (pubkey, info) => ({ pubkey, account: { data: info ? { parsed: { info } } : {} } });
  const client = fakeScanClient({
    accountsByProgram: {
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb": { value: [
        mk("GoodAcct" + "c".repeat(34), { mint: SPYx, owner: OWNER, tokenAmount: { amount: "12" } }),
        mk("NoInfo", {}), // parsed.info пуст
        mk("NoParsed", null), // data без parsed
        { pubkey: "NoData", account: {} }, // нет data вовсе
        mk("JunkAcct", { mint: UNTRACKED, owner: OWNER, tokenAmount: { amount: "99" } }), // минт вне реестра
        mk("NoAmountAcct" + "d".repeat(33), { mint: AAPLx, owner: OWNER }), // tokenAmount отсутствует
      ] },
    },
  });
  const accts = await fetchOwnerTokenAccounts(client, OWNER, REG);
  assert.equal(accts.size, 2);
  assert.equal(accts.get(SPYx).currentRaw, 12n);
  assert.deepEqual(accts.get(SPYx).addresses, ["GoodAcct" + "c".repeat(34)]);
  assert.equal(accts.get(AAPLx).currentRaw, 0n, "нет tokenAmount → трактуется как 0, не падение");
  assert.ok(accts.get(AAPLx).addresses.includes("NoAmountAcct" + "d".repeat(33)), "адрес при нулевом балансе всё равно сканируется");
});

test("fetchOwnerTokenAccounts: один pubkey в двух программах — дедуп, баланс НЕ задвоен, warn оператору", async () => {
  // Бывший GAP: dedup был только для списка адресов; currentRaw суммировался без
  // учёта pubkey — 7+7=14, ложный reconciles:false. Аккаунт принадлежит ровно одной
  // токен-программе: pubkey дедупится глобально по всем программам (первое вхождение
  // выигрывает, порядок TOKEN_PROGRAMS детерминирован), конфликт — громкий warn.
  const entry = { pubkey: "SameAcc" + "e".repeat(36), account: { data: { parsed: { info: {
    mint: SPYx, owner: OWNER, tokenAmount: { amount: "7" },
  } } } } };
  const client = fakeScanClient({
    accountsByProgram: {
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA": { value: [entry] },
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb": { value: [entry] },
    },
  });
  const { result: accts, lines } = await captureConsoleError(() => fetchOwnerTokenAccounts(client, OWNER, REG));
  assert.deepEqual(accts.get(SPYx).addresses, ["SameAcc" + "e".repeat(36)], "адрес один");
  assert.equal(accts.get(SPYx).currentRaw, 7n, "сумма не задвоена: первое вхождение выигрывает");
  assert.equal(lines.length, 1, "конфликт не тихий: ровно один warn оператору");
  assert.match(lines[0], /SameAcc/);
  assert.match(lines[0], /\[wallet-scan\]/);
});

test("fetchOwnerTokenAccounts: разные pubkey в двух программах — честная сумма без warn", async () => {
  // позитив на фикс дедупа: легитимный случай «по аккаунту в каждой программе»
  // по-прежнему складывается (7+5=12) и молчит — дедуп не путает разные аккаунты
  // с конфликтом, шуметь на норму нельзя
  const mk = (pubkey, amount) => ({ pubkey, account: { data: { parsed: { info: {
    mint: SPYx, owner: OWNER, tokenAmount: { amount },
  } } } } });
  const client = fakeScanClient({
    accountsByProgram: {
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA": { value: [mk("LegAcc" + "f".repeat(36), "7")] },
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb": { value: [mk("AtaAcc" + "a".repeat(36), "5")] },
    },
  });
  const { result: accts, lines } = await captureConsoleError(() => fetchOwnerTokenAccounts(client, OWNER, REG));
  assert.deepEqual(accts.get(SPYx).addresses, ["LegAcc" + "f".repeat(36), "AtaAcc" + "a".repeat(36)], "оба аккаунта в порядке программ");
  assert.equal(accts.get(SPYx).currentRaw, 12n, "разные аккаунты складываются, а не дедупятся");
  assert.equal(lines.length, 0, "легитимная мультипрограммность — не конфликт, warn не звучит");
});

test("fetchOwnerTokenAccounts: кривая константа токен-программы — WalletScanError invalid-program-id ДО сети", async () => {
  const client = fakeScanClient();
  TOKEN_PROGRAMS.push("0bad-not-base58");
  try {
    await assert.rejects(
      () => fetchOwnerTokenAccounts(client, OWNER, REG),
      (e) => e instanceof WalletScanError && e.kind === "invalid-program-id",
    );
    assert.equal(client.sigCalls.length + client.txCalls.length, 0, "ни одного запроса: константа проверяется раньше сети");
  } finally {
    TOKEN_PROGRAMS.pop(); // глобальную константу возвращаем — другие тесты живы
  }
});

// ===========================================================================
// Группа 2. Парсинг транзакций: версии, ошибки, decimals, mint/burn
// ===========================================================================

test("scanWallet: versioned (version:'0') и legacy — сканер версии не различает, обе tx в истории", async () => {
  const client = fakeScanClient({
    pages: { [OWNER]: [sig("v0", 1), sig("legacy", 2)] },
    txs: {
      v0: txOf("v0", [{ owner: OWNER, mint: SPYx, _pre: 0, uiTokenAmount: { amount: "10" } }], { slot: 1, version: "0" }),
      legacy: txOf("legacy", [{ owner: OWNER, mint: SPYx, _pre: 10, uiTokenAmount: { amount: "15" } }], { slot: 2 }),
    },
  });
  const scan = await scanWallet(client, OWNER, REG);
  assert.deepEqual(scan.txs.map((t) => t.signature), ["v0", "legacy"]);
  assert.ok(scan.txs.every((t) => !("version" in t)), "поле version ответа в дельты не тащится");
  assert.ok(client.txCalls.every((p) => p[1].maxSupportedTransactionVersion === 1),
    "каждый getTransaction уходит с maxSupportedTransactionVersion:1 (иначе -32015 на versioned)");
});

test("meta.err при err:null-сигнатуре: парсер считает дельты (слой ingest), сканер их гасит, откат — не молча", async () => {
  // Бывший GAP: сканер доверял err из списка сигнатур, meta.err ответа getTransaction
  // игнорировался — failed-tx с расходящимися pre/post (кривой эндпоинт; на живой
  // цепи откат даёт pre==post) кормила FIFO фантомной дельтой. Развязка по слоям:
  // fetchWalletDeltas — сырые данные (дельты считаются всегда, err протаскивается),
  // решение «failed = не влияет на баланс» принимает сканер — и теперь принимает.
  const deltas = new Set([SPYx]);
  const mismatch = {
    async call() {
      return { slot: 1, blockTime: 1, meta: { err: { InstructionError: [0, "Custom"] },
        preTokenBalances: [{ accountIndex: 0, owner: OWNER, mint: SPYx, uiTokenAmount: { amount: "0" } }],
        postTokenBalances: [{ accountIndex: 0, owner: OWNER, mint: SPYx, uiTokenAmount: { amount: "50" } }] } };
    },
  };
  const tx = await fetchWalletDeltas(mismatch, "sig-mismatch", deltas);
  assert.deepEqual(tx.err, { InstructionError: [0, "Custom"] }, "meta.err доезжает в поле err результата…");
  assert.equal(tx.deltas[0].deltaRaw, 50n, "…дельта на слое ingest посчитана — гасит её сканер, а не парсер");

  // честный откат (pre==post при meta.err) больше не выпадает молча: это failed-tx —
  // в skipped с причиной, не в txs и не потеряна
  const reverted = {
    async call() {
      return { slot: 1, blockTime: 1, meta: { err: { x: 1 } },
        preTokenBalances: [{ accountIndex: 0, owner: OWNER, mint: SPYx, uiTokenAmount: { amount: "50" } }],
        postTokenBalances: [{ accountIndex: 0, owner: OWNER, mint: SPYx, uiTokenAmount: { amount: "50" } }] };
    },
  };
  const scanClient = {
    async call(method) {
      if (method === "getTokenAccountsByOwner") return { value: [] };
      if (method === "getSignaturesForAddress") return [sig("reverted", 1)];
      return reverted.call(); // getTransaction
    },
  };
  const scan = await scanWallet(scanClient, OWNER, REG);
  assert.deepEqual(scan.txs, []);
  assert.deepEqual(scan.skipped, [{ signature: "reverted", reason: "failed-tx" }]);
  assert.equal(scan.fetched, 1);
});

test("scanWallet: failed-tx с расходящимися pre/post — дельт нет, фантома в отчёте нет", async () => {
  // позитив на фикс failed-tx: сигнатура err:null, но в tx meta.err не пуст, а
  // балансы разошлись (0 → 50). Раньше такая tx попадала в FIFO фантомной покупкой
  // 50 — окно разъезжалось с цепью (ложный reconciles:false). Семантика
  // «failed = не влияет на баланс»: pre/post расходятся, но дельт нет.
  const client = fakeScanClient({
    pages: { [OWNER]: [sig("phantom", 1)] },
    txs: { phantom: {
      slot: 1, blockTime: 1750000000,
      meta: { err: { InstructionError: [0, "Custom"] },
        preTokenBalances: [{ owner: OWNER, mint: SPYx, uiTokenAmount: { amount: "0" } }],
        postTokenBalances: [{ owner: OWNER, mint: SPYx, uiTokenAmount: { amount: "50" } }] },
    } },
    accountsByProgram: {
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb": { value: [
        { pubkey: "AtaNoPh" + "c".repeat(34), account: { data: { parsed: { info: {
          mint: SPYx, owner: OWNER, tokenAmount: { amount: "0" },
        } } } } },
      ] },
    },
  });
  const scan = await scanWallet(client, OWNER, REG);
  assert.deepEqual(scan.txs, [], "расходящиеся pre/post failed-tx не попадают в FIFO");
  assert.deepEqual(scan.skipped, [{ signature: "phantom", reason: "failed-tx" }]);
  assert.equal(scan.fetched, 1);
  const rep = buildWalletReport(scan, { registry: REG });
  const spyx = rep.tokens.find((t) => t.symbol === "SPYx");
  assert.equal(spyx.rawBalance, "0", "окно не накопило фантомные 50");
  assert.equal(spyx.onchainNow, "0", "на цепи пусто — и отчёт этому не противоречит");
  assert.equal(spyx.reconciles, true, "0 дельт vs 0 на цепи — сходится без выдумок");
  assert.equal(rep.complete, true, "история дочитана, всё сошлось");
});

test("рассинхрон decimals между tx и реестром: raw-дельты точны (BigInt-строки), decimals отчёта — из реестра", async () => {
  // парсер читает ТОЛЬКО uiTokenAmount.amount (строку); поле decimals балансов
  // игнорируется — расхождение с реестром не искажает raw ни на юнит
  const client = {
    async call() {
      return { slot: 1, blockTime: 1750000000, meta: { err: null,
        preTokenBalances: [{ accountIndex: 0, owner: OWNER, mint: SPYx, uiTokenAmount: { amount: "0", decimals: 2 } }],
        postTokenBalances: [{ accountIndex: 0, owner: OWNER, mint: SPYx, uiTokenAmount: { amount: "123456789012345678901234", decimals: 2 } }] } };
    },
  };
  const tx = await fetchWalletDeltas(client, "sig-dec", new Set([SPYx]));
  assert.equal(tx.deltas[0].deltaRaw, 123456789012345678901234n, "24 знака: далеко за Number.MAX_SAFE_INTEGER, BigInt точен");

  const rep = buildWalletReport(scanOf([
    { signature: "sig-dec", slot: 1, blockTime: 1750000000, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 0n, postRaw: 123456789012345678901234n, deltaRaw: 123456789012345678901234n }] },
  ]), { registry: REG });
  const spyx = rep.tokens.find((t) => t.symbol === "SPYx");
  assert.equal(spyx.rawBalance, "123456789012345678901234");
  assert.equal(spyx.decimals, 8, "decimals в отчёте — из реестра, не из tx");
  assert.equal(spyx.adjustedAvailable, false, "таймлайна нет — adjusted это identity-fallback, помечен честно");
  assert.equal(spyx.adjusted.whole, "123456789012345678901234", "fallback не искажает raw");
});

test("mint-to/burn в потоке: аккаунт создан (pre нет) и закрыт (post нет) — обычные дельты владельца, нетто в одной tx", async () => {
  const client = {
    async call() {
      return { slot: 1, blockTime: 1750000000, meta: { err: null,
        // idx0: burn/закрытие — post-запись исчезла, дельта −50
        preTokenBalances: [{ accountIndex: 0, owner: OWNER, mint: SPYx, uiTokenAmount: { amount: "50" } }],
        // idx1: mint-to/создание — pre-записи не было, дельта +70
        postTokenBalances: [{ accountIndex: 1, owner: OWNER, mint: SPYx, uiTokenAmount: { amount: "70" } }] } };
    },
  };
  const tx = await fetchWalletDeltas(client, "sig-mintburn", new Set([SPYx]));
  assert.equal(tx.deltas.length, 1, "оба события одного владельца агрегированы");
  assert.equal(tx.deltas[0].deltaRaw, 20n, "нетто −50+70 = +20");

  const rep = buildWalletReport(scanOf([
    { signature: "sig-mintburn", slot: 1, blockTime: 1750000000, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 50n, postRaw: 70n, deltaRaw: 20n }] },
  ]), { registry: REG });
  const spyx = rep.tokens.find((t) => t.symbol === "SPYx");
  assert.equal(spyx.lots.length, 1, "один лот на tx: FIFO видит нетто-дельту, а не отдельные переводы");
  assert.equal(spyx.lots[0].qtyRaw, "20");
});

// ===========================================================================
// Группа 3. FIFO-движок отчёта: пересечения, перерасход, время, нули
// ===========================================================================

test("FIFO: пересекающиеся покупки-продажи — частичные закрытия, realized по датам продаж, хвост остаётся", () => {
  const txs = [
    delta1("b1", 1, 100n, 1750000000),
    delta1("s1", 2, -30n, 1750003600),
    delta1("b2", 3, 40n, 1750007200),
    delta1("s2", 4, -80n, 1750010800),
  ];
  const rep = buildWalletReport(scanOf(txs, { accounts: { [SPYx]: { address: "AtE1", currentRaw: 30n } } }), { registry: REG });
  const t = rep.tokens.find((x) => x.symbol === "SPYx");
  assert.equal(t.rawBalance, "30");
  assert.equal(t.lots.length, 1, "из двух лотов выжил второй");
  assert.ok(t.lots[0].id.endsWith("-2"), "это лот второй покупки");
  assert.equal(t.lots[0].qtyRaw, "30");
  assert.equal(t.lots[0].acquiredDate, new Date(1750007200 * 1000).toISOString());
  assert.equal(t.realizedCount, 3, "три записи реализации: 30@t2, 70@t4 (хвост лота-1), 10@t4 (голова лота-2)");
  assert.equal(t.realizedQtyRaw, "110");
  assert.deepEqual(t.gaps, []);
  assert.equal(rep.complete, true);
});

test("FIFO: перерасход после частичной продажи — гэп = недостача, очередь пуста, минус в лотах не выдумывается", () => {
  const txs = [
    delta1("b1", 1, 100n),
    delta1("s1", 2, -40n),
    delta1("s2", 3, -80n),
  ];
  const rep = buildWalletReport(scanOf(txs), { registry: REG });
  const t = rep.tokens.find((x) => x.symbol === "SPYx");
  assert.equal(t.rawBalance, "-20");
  assert.deepEqual(t.lots, [], "очередь съедена целиком");
  assert.equal(t.realizedQtyRaw, "100", "реализовано ровно то, что было куплено");
  assert.equal(t.gaps.length, 1);
  assert.equal(t.gaps[0].missingQtyRaw, "20", "недостающие 20 — честная дыра с датой");
  assert.equal(t.gaps[0].date, new Date(300 * 1000).toISOString());
  assert.equal(rep.complete, false);
});

test("FIFO: лоты одного дня с разным временем — очередь в порядке tx (slot), продаётся утренний лот", () => {
  const morning = 1750000000;
  const noon = morning + 3600;
  const txs = [
    delta1("buy-am", 1, 50n, morning),
    delta1("buy-pm", 2, 50n, noon),
    delta1("sell", 3, -30n, noon + 1800),
  ];
  const rep = buildWalletReport(scanOf(txs, { accounts: { [SPYx]: { address: "AtE2", currentRaw: 70n } } }), { registry: REG });
  const t = rep.tokens.find((x) => x.symbol === "SPYx");
  assert.equal(t.lots.length, 2);
  assert.equal(t.lots[0].qtyRaw, "20", "утренний лот подрезан первым (FIFO по порядку tx, не по строке даты)");
  assert.equal(t.lots[0].acquiredDate, new Date(morning * 1000).toISOString());
  assert.equal(t.lots[1].qtyRaw, "50", "полуденный нетронут");
  assert.equal(t.lots[1].acquiredDate, new Date(noon * 1000).toISOString());
  assert.equal(t.lots[0].acquiredDate.slice(0, 10), t.lots[1].acquiredDate.slice(0, 10), "оба лота одного дня");
});

test("zero-qty transfer: дельта 0 — ни лота, ни реализации, ни гэпа; токен не появляется в отчёте без аккаунта", () => {
  const rep = buildWalletReport(scanOf([
    { signature: "zero", slot: 1, blockTime: 100, deltas: [{ owner: OWNER, mint: SPYx, preRaw: 10n, postRaw: 10n, deltaRaw: 0n }] },
  ]), { registry: REG });
  assert.deepEqual(rep.tokens, [], "нулевая дельта не рождает токен-строку без аккаунта на цепи");
  assert.equal(rep.counts.relevantTxs, 1, "tx при этом посчитана релевантной (дельта в скане была)");
});

test("buildWalletReport: пустой скан — tokens [], counts нули, complete:true (честная пустота, не ошибка)", () => {
  const rep = buildWalletReport(scanOf([], { signatures: 0, fetched: 0 }), { registry: REG });
  assert.deepEqual(rep.tokens, []);
  assert.deepEqual(rep.counts, { signatures: 0, fetched: 0, relevantTxs: 0, skipped: 0 });
  assert.equal(rep.truncated, false);
  assert.equal(rep.complete, true, "нечего скрывать и нечего терять — отчёт полон тривиально");
  assert.equal(rep.method, "fifo");
});

test("buildWalletReport: accounts как Map (путь /lots-сервера) — сверка работает как с объектом", () => {
  const rep = buildWalletReport(
    scanOf([delta1("a", 1, 60n)], { accounts: new Map([[SPYx, { address: "AtMap", currentRaw: 60n }]]) }),
    { registry: REG },
  );
  const spyx = rep.tokens.find((t) => t.symbol === "SPYx");
  assert.equal(spyx.onchainNow, "60");
  assert.equal(spyx.reconciles, true);
  assert.equal(rep.complete, true);
});
