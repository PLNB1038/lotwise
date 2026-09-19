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
  const ts = Number(st.newMultiplierEffectiveTimestamp ?? 0);
  return {
    program: accountInfoValue.owner,
    decimals: info.decimals,
    activeMultiplier: String(st.multiplier),
    pendingMultiplier: st.newMultiplier ? String(st.newMultiplier) : null,
    pendingEffectiveDate: ts > 0 ? new Date(ts * 1000).toISOString() : null,
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
  return {
    api: apiMultiplier,
    onChainActive: onChain.activeMultiplier,
    onChainEffective: effectiveOnChain,
    agree: apiMultiplier === effectiveOnChain,
    verdict: apiMultiplier === effectiveOnChain ? "ok" : "planes-disagree",
  };
}
