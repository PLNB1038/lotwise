// Чтение множителя из цепи: Token-2022 Scaled UI Amount Extension (getAccountInfo jsonParsed).
// On-chain план данных: active multiplier + pending multiplier с таймстампом активации.
export class ScaledUiError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "ScaledUiError";
  }
}

/**
 * @param {object} accountInfoValue — result.value ответа getAccountInfo (jsonParsed)
 * @returns {{program: string, decimals: number, activeMultiplier: string, pendingMultiplier: string|null, pendingEffectiveDate: string|null, authority: string}}
 */
// Каноническая запись — общая точка схемы (ROUND9 №15): «05»→«5», «5.0»→«5»,
// «1.10»→«1.1». Репрезентация зависит от источника (RPC/эмитент-API), а сравнения
// строковые: дифф журнала и reconcile лгали на дрейфе репрезентации (ROUND7 №16,
// Jev R3). Значащие цифры не трогаются; вызов после regex-гварда.
import { canonicalDecimalString as canonicalDecimal } from "../schema/events.mjs";

export function parseScaledUiAmount(accountInfoValue) {
  const parsed = accountInfoValue?.data?.parsed;
  if (!parsed || typeof parsed !== "object") {
    throw new ScaledUiError("account is not a parsed mint (expected jsonParsed SPL mint)");
  }
  const info = parsed.info ?? {};
  if (info.extensions === undefined && info.decimals === undefined) {
    throw new ScaledUiError("not an SPL token mint account");
  }
  const ext = (info.extensions ?? []).find((e) => e.extension === "scaledUiAmountConfig");
  if (!ext) {
    // токен без механизма множителя — это факт, а не ошибка
    return {
      program: accountInfoValue.owner,
      decimals: info.decimals,
      activeMultiplier: "1",
      pendingMultiplier: null,
      pendingEffectiveDate: null,
      authority: null,
      hasExtension: false,
    };
  }
  const st = ext.state ?? {};
  // active обязан быть десятичной строкой: String(undefined) = "undefined" не должен
  // ехать дальше и падать где-то в валидации с невнятным сообщением. Fail-closed
  // с ЧЕСТНОЙ ошибкой (тихая ложь хуже падения).
  const active = String(st.multiplier);
  if (!/^\d+(\.\d+)?$/.test(active)) {
    throw new ScaledUiError(
      `scaledUiAmountConfig: active multiplier is not a decimal string: ${JSON.stringify(st.multiplier)}`,
    );
  }
  const activeCanonical = canonicalDecimal(active);
  // «0» в newMultiplier — это pending СБРОШЕН, а не настоящий нулевой множитель:
  // конвенция эмитента (xstocks.mjs fetchCurrentMultiplier гвардит Number(pending) !== 0,
  // живая фикстура xstocks-spyx-current.json несёт newMultiplier: 0) — записать 0 в
  // new_multiplier и есть естественный способ снять pending. Строка "0" truthy, поэтому
  // гвардим числом, симметрично эмитентскому клиенту.
  const pendingRaw = st.newMultiplier;
  const pendingReset = pendingRaw === undefined || pendingRaw === null || Number(pendingRaw) === 0;
  // pending валидируется СИММЕТРИЧНО active (ROUND7 №15): раньше любой не-нулевой
  // мусор («abc») ехал в публичный /onchain payload и в будущий фантомный
  // planes-disagree; журнал ниже по потоку падает валидацией, но мусор в ответе
  // ридера — это шум диагностики, которого быть не должно.
  const pendingStr = pendingReset ? null : String(pendingRaw);
  if (pendingStr !== null && !/^\d+(\.\d+)?$/.test(pendingStr)) {
    throw new ScaledUiError(
      `scaledUiAmountConfig: newMultiplier is not a decimal string: ${JSON.stringify(pendingRaw)}`,
    );
  }
  const pending = pendingStr !== null ? canonicalDecimal(pendingStr) : null;
  // Дата активации без живого pending бессмысленна — обнуляем пару АТОМАРНО (а не
  // «оставляем как есть»): пара (pending, date) — один факт, дата без pending это мусор
  // в публичном ответе и приманка для будущих потребителей; симметрично xstocks.mjs,
  // где activationDateTime гвардится вместе с newMultiplier. Форма ответа не меняется.
  const tsRaw = st.newMultiplierEffectiveTimestamp ?? 0;
  const ts = Number(tsRaw);
  if (pending !== null && Number.isNaN(ts)) {
    // pending жив, а таймстамп — мусор: до фикса NaN тихо давал дату null и pending
    // молча игнорировался нижележащими слоями. Честная ошибка лучше тихой лжи.
    // При НЕЖИВОМ pending (null выше) мусорный таймстамп значения не имеет — не бросаем.
    throw new ScaledUiError(
      `scaledUiAmountConfig: newMultiplierEffectiveTimestamp is not a number: ${JSON.stringify(tsRaw)} (pending ${pending} without a valid activation date)`,
    );
  }
  return {
    program: accountInfoValue.owner,
    decimals: info.decimals,
    activeMultiplier: activeCanonical,
    pendingMultiplier: pending,
    pendingEffectiveDate: pending !== null && ts > 0 ? new Date(ts * 1000).toISOString() : null,
    authority: st.authority ?? null,
    hasExtension: true,
  };
}

/** Сверка планов: множитель эмитента (API) против on-chain на момент date. */
export function reconcileMultiplier(apiMultiplier, onChain, date = new Date().toISOString()) {
  // Даты — числом через Date.parse: строковое сравнение путает "Z"/".000Z"/date-only
  // и теряло pending ровно в день его активации (ложное planes-disagree на витрине).
  const ts = Date.parse(String(date));
  if (Number.isNaN(ts)) {
    throw new ScaledUiError(`not a parseable date: ${JSON.stringify(date)}`);
  }
  const pendingTs = onChain.pendingEffectiveDate !== null ? Date.parse(onChain.pendingEffectiveDate) : null;
  // On-chain "эффективный" множитель: pending активируется после своего таймстампа
  const effectiveOnChain =
    pendingTs !== null && !Number.isNaN(pendingTs) && pendingTs <= ts && onChain.pendingMultiplier !== null
      ? onChain.pendingMultiplier
      : onChain.activeMultiplier;
  // Сравнение — канонически, отображение — как пришло: «1.10» (API) против «1.1»
  // (цепь) — та же величина, ложный planes-disagree на дрейфе репрезентации
  // был бы ровно тем классом тихой лжи, который канонизация убивает (Jev R3).
  const agree = canonicalDecimal(String(apiMultiplier)) === canonicalDecimal(String(effectiveOnChain));
  return {
    api: apiMultiplier,
    onChainActive: onChain.activeMultiplier,
    onChainEffective: effectiveOnChain,
    agree,
    verdict: agree ? "ok" : "planes-disagree",
  };
}
