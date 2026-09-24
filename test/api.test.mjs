import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/api/server.mjs";
import { multiplierHistoryToEvents, bindMintAndValidate } from "../src/events/normalize-xstocks.mjs";
import { loadRegistry } from "../src/registry/registry.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const SPYx = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";

const historyNodes = JSON.parse(readFileSync(path.join(dir, "xstocks-spyx-history-eth.json"), "utf8")).nodes;
const events = bindMintAndValidate(multiplierHistoryToEvents(historyNodes, { symbol: "SPYx" }), SPYx);
// ожидаемая численность реестра — из самого файла, чтобы расширение реестра
// не требовало правки тестов (реестр = источник истины, число токенов не контракт API)
const TOKENS = (await loadRegistry("data/tokens.json")).length;

async function withServer(fn) {
  const registry = await loadRegistry("data/tokens.json");
  const server = await createApiServer({ registry, events });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("/health отвечает статистикой", async () => {
  await withServer(async (base) => {
    const r = await (await fetch(`${base}/health`)).json();
    assert.equal(r.ok, true);
    assert.equal(r.tokens, TOKENS);
    assert.equal(r.events, 4);
  });
});

test("/tokens отдаёт реестр и фильтруется по issuer", async () => {
  await withServer(async (base) => {
    const all = await (await fetch(`${base}/tokens`)).json();
    assert.equal(all.length, TOKENS);
    const tessera = await (await fetch(`${base}/tokens?issuer=tessera`)).json();
    assert.equal(tessera.length, 3);
    assert.ok(tessera.every((t) => t.issuer === "tessera"));
  });
});

test("/events по символу: 4 дивиденда SPYx", async () => {
  await withServer(async (base) => {
    const list = await (await fetch(`${base}/events?symbol=SPYx`)).json();
    assert.equal(list.length, 4);
    assert.ok(list.every((e) => e.type === "MULTIPLIER_CHANGE"));
    const filtered = await fetch(`${base}/events?symbol=SPYx&type=NOPE`);
    // ROUND13: мусорный type — честный 400 со словарём (тихий [] неотличим от «не было»)
    assert.equal(filtered.status, 400);
    assert.match((await filtered.json()).error, /SPLIT/);
  });
});

test("/events без mint/symbol — понятная 400", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/events`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /mint or symbol required/);
  });
});

test("/multiplier: до событий = 1, после всех = 1.0057…, scaledQty целочисленный", async () => {
  await withServer(async (base) => {
    const before = await (await fetch(`${base}/multiplier?symbol=SPYx&date=2025-10-30`)).json();
    assert.equal(before.multiplier, "1");
    assert.equal(before.sampleScaledQty.exact, true);

    const after = await (await fetch(`${base}/multiplier?symbol=SPYx&date=2026-07-01`)).json();
    assert.equal(after.multiplier, "1.005714560286254");
    assert.equal(after.events, 4);
    assert.equal(after.sampleScaledQty.whole, "100571456"); // raw=100000000 × 1.0057…
    assert.equal(after.sampleScaledQty.exact, false); // пыль честно показана
  });
});

test("неизвестный маршрут — 404 со списком эндпоинтов", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(Array.isArray(body.endpoints));
  });
});

// ---- раунд-2: валидация ввода API ----

test("/multiplier: raw только цифры — hex/отрицательные/мусор = 400", async () => {
  await withServer(async (base) => {
    // BigInt молча принимает "0x10" (=16) и "-5" — это тихая ложь, не удобство
    assert.equal((await fetch(`${base}/multiplier?symbol=SPYx&raw=0x10`)).status, 400);
    assert.equal((await fetch(`${base}/multiplier?symbol=SPYx&raw=-5`)).status, 400);
    assert.equal((await fetch(`${base}/multiplier?symbol=SPYx&raw=1.5`)).status, 400);
    assert.equal((await fetch(`${base}/multiplier?symbol=SPYx&raw=abc`)).status, 400);
    assert.equal((await fetch(`${base}/multiplier?symbol=SPYx&raw=1000&date=not-a-date`)).status, 400);
    assert.equal((await fetch(`${base}/multiplier?symbol=SPYx&raw=1000`)).status, 200);
  });
});

test("/onchain: мусорная дата = 400, date-only в день активации pending не врёт", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const server = await createApiServer({
    registry, events,
    onchainReader: async () => ({
      activeMultiplier: "1.003909240011759",
      pendingMultiplier: "1.005714560286254",
      pendingEffectiveDate: "2026-06-18T00:00:00.000Z",
      hasExtension: true,
    }),
  });
  const { port } = server.address();
  try {
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/onchain?symbol=SPYx&date=garbage`)).status, 400);
    const r = await (await fetch(`${base}/onchain?symbol=SPYx&date=2026-06-18`)).json();
    assert.equal(r.onChainEffective, "1.005714560286254"); // pending активен в свой день
  } finally {
    server.close();
  }
});

test("/health: journal-статистика присутствует, когда передана", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const server = await createApiServer({ registry, events, journalStats: { replayed: 2, unavailable: 1 } });
  const { port } = server.address();
  try {
    const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.deepEqual(h.journal, { replayed: 2, unavailable: 1 });
  } finally {
    server.close();
  }
});

// ---- раунд-4: изоляция кривого минта и строгие даты query ----

test("кривая цепочка одного минта не валит сервер: токен исключён из витрины, остальные живы", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const bad = registry.find((t) => t.symbol === "T-SpaceX");
  const poisoned = [
    ...events,
    {
      type: "MULTIPLIER_CHANGE", mint: bad.mint, effectiveDate: "2026-05-01T00:00:00.000Z",
      status: "confirmed", sources: ["test:broken-chain"],
      multiplierFrom: "5", multiplierTo: "6", reason: "On-chain rebase",
    },
  ];
  // раньше createApiServer падал здесь же: TimelineError (chain discontinuity) на старте
  const server = await createApiServer({ registry, events: poisoned });
  const { port } = server.address();
  try {
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/health`)).status, 200); // сервер жив
    const excludedRes = await fetch(`${base}/events?symbol=T-SpaceX`);
    assert.equal(excludedRes.status, 400); // раунд 6: честный отказ вместо тихого []
    assert.match((await excludedRes.json()).error, /excluded/i); // события кривого минта не отдаются частично
    const good = await (await fetch(`${base}/events?symbol=SPYx`)).json();
    assert.equal(good.length, 4); // остальные токены с данными
    const rows = await (await fetch(`${base}/summary`)).json();
    assert.equal(rows.find((r) => r.symbol === "T-SpaceX").events, 0); // честная деградация
    assert.equal(rows.find((r) => r.symbol === "SPYx").events, 4);
  } finally {
    server.close();
  }
});

test("/onchain: дата валидируется ДО вызова ридера — мусор не греет кэш реальным RPC", async () => {
  const registry = await loadRegistry("data/tokens.json");
  let calls = 0;
  const server = await createApiServer({
    registry, events,
    onchainReader: async () => {
      calls += 1;
      throw new Error("rpc down");
    },
  });
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/onchain?symbol=SPYx&date=garbage`);
    assert.equal(res.status, 400); // 400, а не 503
    assert.equal(calls, 0); // ридер не вызван
  } finally {
    server.close();
  }
});

test("строгий формат даты в query: '2026-1-1' и время без пояса = 400 (локальная полночь врёт)", async () => {
  const registry = await loadRegistry("data/tokens.json");
  const server = await createApiServer({ registry, events });
  const { port } = server.address();
  try {
    const base = `http://127.0.0.1:${port}`;
    // "2026-1-1" Date.parse съедает как ЛОКАЛЬНУЮ полночь; время без пояса — тоже локальное
    for (const bad of ["2026-1-1", "2026-01-01T00:00", "01-01-2026", "2026-13-01"]) {
      assert.equal((await fetch(`${base}/multiplier?symbol=SPYx&date=${bad}`)).status, 400, bad);
      assert.equal((await fetch(`${base}/onchain?symbol=SPYx&date=${bad}`)).status, 400, bad);
    }
    // валидные формы проходят: date-only (полночь UTC) и полный RFC3339 с поясом
    assert.equal((await fetch(`${base}/multiplier?symbol=SPYx&date=2026-01-01`)).status, 200);
    assert.equal((await fetch(`${base}/multiplier?symbol=SPYx&date=2026-01-01T00:00:00Z`)).status, 200);
  } finally {
    server.close();
  }
});

// ---- раунд-7: /accruals — движок начислений applyEvents подключён к API ----
// Синтетика по образцу dividend-e2e: минт/владелец — валидный base58 (без 0/O/I/l),
// в живом data/tokens.json отсутствуют; walletScanner мокается, сеть не нужна.

const A_MINT = "DivAccMint" + "1".repeat(34); // 44 символа
const A_ADDR = "DivAccAddr" + "1".repeat(34); // 44 символа
const A_SYMBOL = "ACRx";
const aRegistry = [{ mint: A_MINT, symbol: A_SYMBOL, name: "Accrual Test Token", decimals: 6, issuer: "test" }];

const divEvent = (effectiveDate, amountPerUnitRaw) =>
  bindMintAndValidate([{
    type: "DIVIDEND_ACCRUAL",
    effectiveDate,
    status: "confirmed",
    sources: ["https://issuer.example/dividends/test"],
    amountPerUnitRaw,
    decimals: 6,
  }], A_MINT)[0];

// blockTime в скане — секунды (report.mjs: new Date(blockTime * 1000)); null — tx без blockTime
const aBuy = (signature, qty, isoDate) => ({
  signature, slot: 1,
  blockTime: isoDate === null ? null : Math.floor(Date.parse(isoDate) / 1000),
  deltas: [{ owner: A_ADDR, mint: A_MINT, preRaw: 0n, postRaw: qty, deltaRaw: qty }],
});
const aScan = (txs) => ({
  owner: A_ADDR, signatures: txs.length, fetched: txs.length, txs, skipped: [], truncated: false, accounts: {},
});

const NO_SCANNER = Symbol("no-scanner"); // сентинел: walletScanner в сервер НЕ передаётся вовсе
async function withAccrualServer(fn, { events = [], txs = [], scanner = null } = {}) {
  const server = await createApiServer({
    registry: aRegistry,
    events,
    ...(scanner === NO_SCANNER ? {} : { walletScanner: scanner ?? (async () => aScan(txs)) }),
  });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("/accruals: два дивиденда — по строке на событие, BigInt строками, датный гейт по каждому", async () => {
  // покупки: L1 до обеих экс-дат, L2 между ними, L3 после обеих
  const txs = [
    aBuy("a", 1_000_000n, "2026-09-01"),
    aBuy("b", 2_000_000n, "2026-09-12"),
    aBuy("c", 7_000_000n, "2026-09-20"),
  ];
  const events = [divEvent("2026-09-10", 2), divEvent("2026-09-15", 5)];
  await withAccrualServer(async (base) => {
    const r = await fetch(`${base}/accruals?symbol=${A_SYMBOL}&address=${A_ADDR}`);
    assert.equal(r.status, 200);
    const rows = await r.json();
    assert.equal(rows.length, 2);
    // дивиденд 09-10: в базе только L1 (строго раньше); L2/L3 куплены после экс-даты
    assert.deepEqual(rows[0], {
      symbol: A_SYMBOL,
      effectiveDate: "2026-09-10",
      amountPerUnitRaw: "2",
      totalRaw: "2000000", // 2 × 1 000 000
      lotsConsidered: 1,
    });
    // дивиденд 09-15: L1 + L2, L3 мимо
    assert.deepEqual(rows[1], {
      symbol: A_SYMBOL,
      effectiveDate: "2026-09-15",
      amountPerUnitRaw: "5",
      totalRaw: "15000000", // 5 × (1 000 000 + 2 000 000)
      lotsConsidered: 2,
    });
  }, { events, txs });
});

test("/accruals: лот с acquiredDate:null (tx без blockTime) исключён ДО движка — 200, а не 500", async () => {
  // applyEvents на таком лоте бросает LotError (fail-closed, контракт в шапке
  // report.mjs); эндпоинт обязан отфильтровать яд: начисление считается по здоровым
  // лотам, ядовитый в базу не попадает и выдачу не роняет
  const txs = [aBuy("poison", 9_000_000n, null), aBuy("ok", 1_000_000n, "2026-09-01")];
  await withAccrualServer(async (base) => {
    const r = await fetch(`${base}/accruals?symbol=${A_SYMBOL}&address=${A_ADDR}`);
    assert.equal(r.status, 200);
    const rows = await r.json();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].totalRaw, "2000000"); // 2 × 1 000 000 — только здоровый лот
    assert.equal(rows[0].lotsConsidered, 1);
  }, { events: [divEvent("2026-09-10", 2)], txs });
});

test("/accruals: пустая выдача честным [] — нет дивидендных событий или нет позиции", async () => {
  const txs = [aBuy("a", 1_000_000n, "2026-09-01")];
  await withAccrualServer(async (base) => {
    // позиция есть, но дивидендных событий нет (стор пуст) — «начислений не было», 200 []
    const noEvents = await fetch(`${base}/accruals?symbol=${A_SYMBOL}&address=${A_ADDR}`);
    assert.equal(noEvents.status, 200);
    assert.deepEqual(await noEvents.json(), []);
  }, { events: [], txs });
  await withAccrualServer(async (base) => {
    // события есть, позиции нет — тоже честный [] (событие ≠ начисление)
    const noLots = await fetch(`${base}/accruals?symbol=${A_SYMBOL}&address=${A_ADDR}`);
    assert.equal(noLots.status, 200);
    assert.deepEqual(await noLots.json(), []);
  }, { events: [divEvent("2026-09-10", 2)], txs: [] });
});

test("/accruals: конвенция ошибок как у соседей — 400 символ/адрес, 503 без сканера/падение сканера", async () => {
  await withAccrualServer(async (base) => {
    // неизвестный символ — как у /events и /multiplier: 400 «не трекается»
    const badSymbol = await fetch(`${base}/accruals?symbol=NOPE&address=${A_ADDR}`);
    assert.equal(badSymbol.status, 400);
    assert.match((await badSymbol.json()).error, /mint or symbol required/);
    // адрес обязателен и валиден — те же 400, что у /lots
    assert.equal((await fetch(`${base}/accruals?symbol=${A_SYMBOL}`)).status, 400);
    const badAddr = await fetch(`${base}/accruals?symbol=${A_SYMBOL}&address=abc`);
    assert.equal(badAddr.status, 400);
    assert.match((await badAddr.json()).error, /base58 Solana pubkey/);
  }, { events: [divEvent("2026-09-10", 2)] });
  // сканер не сконфигурирован — 503, как у /lots
  await withAccrualServer(async (base) => {
    const r = await fetch(`${base}/accruals?symbol=${A_SYMBOL}&address=${A_ADDR}`);
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /wallet scanner not configured/);
  }, { events: [divEvent("2026-09-10", 2)], scanner: NO_SCANNER });
  // сканер падает — 503 с причиной, сервер жив
  await withAccrualServer(async (base) => {
    const r = await fetch(`${base}/accruals?symbol=${A_SYMBOL}&address=${A_ADDR}`);
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /rpc down/);
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
  }, {
    events: [divEvent("2026-09-10", 2)],
    scanner: async () => { throw new Error("rpc down"); },
  });
});
