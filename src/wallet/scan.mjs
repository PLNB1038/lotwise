// Кошельковый скан: транзакции адреса И его токен-аккаунтов реестровых минтов.
// Только подписи владельца НЕДОВОСТАТОЧНО: входящие переводы (fee платит отправитель)
// касаются token-аккаунта, но не адреса кошелька — скан v1 их терял (живой кейс EJBQ:
// 4 подписи вместо всей истории). v2: сигнатуры адреса + сигнатуры каждого живого
// token-аккаунта, дедуп, плюс текущие балансы аккаунтов для сверки отчёта с цепью.
// fail-closed: err-транзакции и недоступные — в skipped с причиной, не молча.
import { fetchWalletDeltas } from "../ingest/tx.mjs";

export const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const TOKEN_PROGRAMS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // классический SPL (сверен с owner минта USDC)
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022 (xStocks и др., сверен с фикстурой)
];

export class WalletScanError extends Error {
  constructor(msg, kind = "invalid") {
    super(msg);
    this.name = "WalletScanError";
    this.kind = kind;
  }
}

// E4-1 (волна E): charset+длины мало — «1»×41 проходит regex, но декодируется не в
// 32 байта: сканер тратил RPC и отвечал 503 «rpc» на перманентно битый ввод (retry-
// логика потребителя долбит его вечно). Структурная проверка: base58 → ровно 32 байта;
// лидирующие «1» — нулевые байты (поэтому «1»×32 = system program, структурно валиден).
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_INDEX = new Map([...B58].map((ch, i) => [ch, i]));

export function isValidAddress(addr) {
  if (typeof addr !== "string" || !PUBKEY_RE.test(addr)) return false;
  let n = 0n;
  for (const ch of addr) n = n * 58n + BigInt(B58_INDEX.get(ch));
  let leadZeros = 0;
  while (addr[leadZeros] === "1") leadZeros++;
  let bytes = leadZeros;
  while (n > 0n) {
    bytes++;
    n >>= 8n;
  }
  return bytes === 32;
}

/**
 * Текущие token-аккаунты владельца по минтам реестра.
 * @returns {Promise<Map<string, {addresses: string[], currentRaw: bigint}>>}
 *   mint -> ВСЕ аккаунты (ATA + legacy): баланс = сумма, сканируется каждый адрес.
 *   Один аккаунт на минт — норма, но legacy-кошельки держат по два: молча выкинуть
 *   один = потерять его историю (тихая ложь), уронить скан = отказать честному кошельку.
 */
export async function fetchOwnerTokenAccounts(client, owner, registry) {
  // programId — тоже pubkey: кривая константа даёт далёкий от очевидного -32602
  for (const pid of TOKEN_PROGRAMS) {
    if (!PUBKEY_RE.test(pid)) throw new WalletScanError(`bad token program id: ${pid}`, "invalid-program-id");
  }
  const mintSet = new Set(registry.map((t) => t.mint));
  const out = new Map();
  const add = (mint, address, amount) => {
    let cur = out.get(mint);
    if (!cur) {
      cur = { addresses: [], currentRaw: 0n };
      out.set(mint, cur);
    }
    if (address && !cur.addresses.includes(address)) cur.addresses.push(address);
    cur.currentRaw += amount;
  };
  // Аккаунт принадлежит РОВНО ОДНОЙ токен-программе, но кривой/проксирующий эндпоинт
  // может отдать один pubkey в обеих выдачах. Дедуп глобальный (по всем программам,
  // первое вхождение выигрывает — порядок TOKEN_PROGRAMS детерминирован): раньше
  // currentRaw суммировался по выдачам без учёта pubkey — 7+7=14, фантомный двойной
  // баланс давал ложный reconciles:false. Конфликт не тихий: warn оператору
  // (паттерн round 6 — наблюдаемость вместо молчаливой потери).
  const seenPubkeys = new Set();
  for (const programId of TOKEN_PROGRAMS) {
    const res = await client.call("getTokenAccountsByOwner", [
      owner,
      { programId },
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]);
    // Волна H3-3 [P1]: не-массив от шлюза — ЯВНАЯ malformed-source (зеркало ROUND9 №3
    // для сигнатур): «пустой набор аккаунтов» от лежащего источника неотличим от нуля.
    if (!Array.isArray(res?.value)) {
      throw new WalletScanError(
        `malformed getTokenAccountsByOwner response: expected array, got ${res?.value === null ? "null" : typeof res?.value}`,
        "malformed-source",
      );
    }
    for (const entry of res.value) {
      if (entry === null || typeof entry !== "object") continue;
      const info = entry?.account?.data?.parsed?.info;
      if (!info || !mintSet.has(info.mint)) continue;
      const address = typeof entry.pubkey === "string" ? entry.pubkey : null;
      // битый pubkey не становится источником сигнатур (класс E4: «1»×41 жёг RPC и валил
      // скан на -32602); мусорный amount («1e6») не попадает в сверку молча — оба
      // пропускаем с warn: наблюдаемость вместо тихой лжи
      if (address !== null && !isValidAddress(address)) {
        console.error(`[wallet-scan] ${owner}: аккаунт с невалидным pubkey ${JSON.stringify(entry.pubkey).slice(0, 60)} пропущен (не источник сигнатур, не баланс)`);
        continue;
      }
      // Нет tokenAmount → 0n, но адрес остаётся источником сигнатур (легаси-контракт
      // wallet-edge: «нулевой баланс всё равно сканируется»). Мусорный amount («1e6»,
      // 1.5) — skip с warn: тихий 0n без предупреждения = молчаливая потеря сверки.
      const amountRaw = info.tokenAmount?.amount;
      let amt = 0n;
      if (amountRaw !== undefined && amountRaw !== null) {
        const rawOk = (typeof amountRaw === "number" && Number.isSafeInteger(amountRaw) && amountRaw >= 0)
          || (typeof amountRaw === "string" && /^\d+$/.test(amountRaw));
        if (!rawOk) {
          console.error(`[wallet-scan] ${owner}: аккаунт ${address ?? "?"} с мусорным balance amount ${JSON.stringify(amountRaw)} пропущен`);
          continue;
        }
        amt = BigInt(amountRaw);
      }
      if (address !== null) {
        if (seenPubkeys.has(address)) {
          console.error(`[wallet-scan] ${owner}: аккаунт ${address} встречен в выдаче токен-программ повторно — аккаунт принадлежит ровно одной программе; первое вхождение выигрывает, дубль в сумму не пошёл (иначе баланс задваивается и reconcile ложно падает)`);
          continue;
        }
        seenPubkeys.add(address);
      }
      add(info.mint, address, amt);
    }
  }
  return out;
}

/**
 * @param {RpcClient} client
 * @param {string} owner — адрес кошелька
 * @param {Array} registry — реестр токенов (нужны только .mint)
 * @param {object} [opts] maxTxs — потолок подписей НА ИСТОЧНИК (адрес или каждый аккаунт),
 *   onProgress({fetched, total}) — после каждой транзакции
 * @returns {{owner, signatures, fetched, txs, skipped, truncated, accounts}}
 *   txs — хронологические (старейшие первыми), дельты всех владельцев (фильтр в отчёте);
 *   accounts — Map mint->{address, currentRaw} для сверки балансов
 */
export async function scanWallet(client, owner, registry, { maxTxs = 300, limit = 100, onProgress, signal } = {}) {
  if (!isValidAddress(owner)) {
    throw new WalletScanError("owner must be a base58 Solana pubkey", "invalid-address");
  }
  // Abort-пропагация (волна B): ушедший клиент останавливает скан между
  // страницами/транзакциями — RPC-квота не дожигается в пустоту
  const aborted = () => {
    if (signal?.aborted) throw new WalletScanError("scan aborted by client", "aborted");
  };
  const mintSet = new Set(registry.map((t) => t.mint));
  const accounts = await fetchOwnerTokenAccounts(client, owner, registry);

  // 1) сигнатуры по каждому источнику: адрес кошелька + ВСЕ токен-аккаунты реестровых минтов
  const sources = [owner, ...[...accounts.values()].flatMap((a) => a.addresses).filter(Boolean)];
  const sigs = new Map(); // signature -> {slot, blockTime, err} (дедуп по источникам)
  let truncated = false;
  for (const source of sources) {
    let before;
    let taken = 0;
    let srcTruncated = false; // флаг НА ИСТОЧНИК: упёрся один — остальные сканируются своим потолком целиком
    let zeroProgressPages = 0; // ROUND9 №13: чередующиеся дубли-страницы = нет прогресса
    for (;;) {
      aborted();
      const batch = await client.call("getSignaturesForAddress", [
        source,
        { limit, ...(before !== undefined ? { before } : {}) },
      ]);
      // Не-массив (result:null лежащего шлюза) — ЯВНАЯ ошибка, не молчаливый
      // «конец истории» с truncated:false (ROUND9 №3: «пустой кошелёк» неотличим
      // от «источник умер» — нарушение fail-closed).
      if (!Array.isArray(batch)) {
        throw new WalletScanError(
          `malformed getSignaturesForAddress response: expected array, got ${batch === null ? "null" : typeof batch}`,
          "malformed-source",
        );
      }
      // Конец истории — ТОЛЬКО пустая страница (раунд 8): «короткая» страница у
      // эндпоинтов с soft caps/лагающим индексером не значит «дальше пусто».
      if (batch.length === 0) break;
      let added = 0;
      let lastValid = null;
      for (const s of batch) {
        // битый элемент (null/без signature) — skip, не TypeError всего скана
        // (ROUND9 №12, класс ROUND7 №14); курсор считаем по последнему валидному
        if (s === null || typeof s !== "object" || typeof s.signature !== "string") continue;
        if (taken >= maxTxs) { srcTruncated = true; break; }
        if (!sigs.has(s.signature)) {
          sigs.set(s.signature, { slot: s.slot, blockTime: s.blockTime ?? null, err: s.err ?? null });
          // taken ПОСЛЕ дедупа: потолок по УНИКАЛЬНЫМ сигнатурам (см. раунд 4).
          taken++;
          added++;
        }
        lastValid = s.signature;
      }
      if (srcTruncated) break;
      if (added === 0 || lastValid === null || lastValid === before) {
        if (++zeroProgressPages >= 2) break;
      } else {
        zeroProgressPages = 0;
      }
      if (lastValid !== null) before = lastValid;
    }
    if (srcTruncated) truncated = true;
  }

  // 2) err-транзакции не fetch'им — это не история балансов, а мусор с причиной
  const skipped = [];
  const toFetch = [];
  for (const [signature, s] of sigs) {
    if (s.err !== null) skipped.push({ signature, reason: "tx failed on-chain" });
    else toFetch.push({ signature, ...s });
  }

  // 3) обрабатываем хронологически: сборка шла новейшими-первыми.
  // Сорт по slot: он есть всегда и монотонен; blockTime бывает null, а смешение
  // секунд и слотов в одном компараторе — единицы разных порядков. slot от битого
  // эндпоинта бывает undefined — ?? 0 даёт определённый порядок (H3-6).
  const ordered = toFetch.sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
  const txs = [];
  let fetched = 0;
  for (const s of ordered) {
    aborted();
    let tx;
    try {
      tx = await fetchWalletDeltas(client, s.signature, mintSet);
    } catch (err) {
      // Волна H3-1/H3-2 [P1]: ОДНА ядовитая tx (мусорная meta из лежащего шлюза,
      // постоянная RpcError на versioned-tx) роняла ВЕСЬ скан — кошелёк становился
      // permanent-несканируемым, потребитель долбил 503-ретраями. Контракт ROUND7 №14
      // «битая tx = skipped с причиной» покрывает и БРОСКИ, не только null.
      // Наш собственный abort (WalletScanError) не глотаем — летит дальше.
      if (err instanceof WalletScanError) throw err;
      skipped.push({ signature: s.signature, reason: `tx unreadable: ${err?.code ? `${err.code}: ` : ""}${String(err?.message ?? err).slice(0, 120)}` });
      fetched++;
      if (onProgress) onProgress({ fetched, total: ordered.length });
      continue;
    }
    fetched++;
    if (onProgress) onProgress({ fetched, total: ordered.length });
    if (tx === null) {
      skipped.push({ signature: s.signature, reason: "tx unavailable on endpoint" });
      continue;
    }
    if (tx.err !== null) {
      // meta.err ФАКТА сильнее err из списка сигнатур: списки бывают err:null для
      // failed-tx, а fetchWalletDeltas честно протащил meta.err в поле err. Раньше
      // сверка шла только с err сигнатуры — failed-tx с расходящимися pre/post
      // (кривой эндпоинт, на живой цепи откат даёт pre==post) кормила FIFO
      // фантомной дельтой. Семантика «failed = не влияет на баланс»: дельты такой
      // tx в историю не идут.
      skipped.push({ signature: s.signature, reason: "failed-tx" });
      continue;
    }
    if (tx.deltas.length > 0) {
      txs.push({ signature: s.signature, slot: tx.slot, blockTime: tx.blockTime, deltas: tx.deltas });
    }
  }

  return { owner, signatures: sigs.size, fetched, txs, skipped, truncated, accounts };
}
