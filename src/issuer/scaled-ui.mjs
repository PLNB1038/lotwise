// Reading the multiplier from the chain: Token-2022 Scaled UI Amount Extension (getAccountInfo jsonParsed).
// On-chain data plan: active multiplier + pending multiplier with an activation timestamp.
export class ScaledUiError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "ScaledUiError";
  }
}

/**
 * @param {object} accountInfoValue — the result.value of a getAccountInfo response (jsonParsed)
 * @returns {{program: string, decimals: number, activeMultiplier: string, pendingMultiplier: string|null, pendingEffectiveDate: string|null, authority: string}}
 */
// Canonical form is the schema's common ground : "05"→"5", "5.0"→"5",
// "1.10"→"1.1". The representation depends on the source (RPC/issuer API) while comparisons
// are string-based: the journal diff and reconcile lied on representation drift,
// Jev R3). Significant digits are untouched; called after the regex guard.
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
    // a token without a multiplier mechanism is a fact, not an error
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
  // active must be a decimal string: String(undefined) = "undefined" must not travel further
  // and fail somewhere in validation with an obscure message. Fail-closed with an HONEST
  // error (a quiet lie is worse than a crash).
  const active = String(st.multiplier);
  if (!/^\d+(\.\d+)?$/.test(active)) {
    throw new ScaledUiError(
      `scaledUiAmountConfig: active multiplier is not a decimal string: ${JSON.stringify(st.multiplier)}`,
    );
  }
  const activeCanonical = canonicalDecimal(active);
  // A "0" in newMultiplier means the pending was RESET, not a real zero multiplier:
  // issuer convention (xstocks.mjs fetchCurrentMultiplier guards Number(pending) !== 0;
  // the live fixture xstocks-spyx-current.json carries newMultiplier: 0) — writing 0 into
  // new_multiplier is the natural way to clear a pending. The string "0" is truthy, so we
  // guard by number, symmetric with the issuer client.
  const pendingRaw = st.newMultiplier;
  const pendingReset = pendingRaw === undefined || pendingRaw === null || Number(pendingRaw) === 0;
  // pending is validated SYMMETRICALLY to active : previously any non-zero
  // garbage ("abc") went into the public /onchain payload and into a future phantom
  // planes-disagree; the journal further downstream fails validation anyway, but garbage in
  // a reader's response is diagnostic noise that should not exist.
  const pendingStr = pendingReset ? null : String(pendingRaw);
  if (pendingStr !== null && !/^\d+(\.\d+)?$/.test(pendingStr)) {
    throw new ScaledUiError(
      `scaledUiAmountConfig: newMultiplier is not a decimal string: ${JSON.stringify(pendingRaw)}`,
    );
  }
  const pending = pendingStr !== null ? canonicalDecimal(pendingStr) : null;
  // An activation date without a live pending is meaningless — we zero the pair ATOMICALLY
  // (not "leave as is"): the (pending, date) pair is a single fact; a date without pending is
  // garbage in the public response and bait for future consumers; symmetric with xstocks.mjs,
  // where activationDateTime is guarded together with newMultiplier. The response shape is unchanged.
  const tsRaw = st.newMultiplierEffectiveTimestamp ?? 0;
  const ts = Number(tsRaw);
  if (pending !== null && Number.isNaN(ts)) {
    // pending is live but the timestamp is garbage: before the fix NaN quietly produced a null
    // date and pending was silently ignored by downstream layers. An honest error beats a quiet lie.
    // With a NON-live pending (null above) a garbage timestamp does not matter — no throw.
    throw new ScaledUiError(
      `scaledUiAmountConfig: newMultiplierEffectiveTimestamp is not a number: ${JSON.stringify(tsRaw)} (pending ${pending} without a valid activation date)`,
    );
  }
  // finite but beyond ±8.64e15 ms — toISOString() threw a BARE
  // RangeError bypassing the module's typed error; on /onchain that meant a 503 kind:null
  // leaking internal text to the outside. The boundary is inclusive: 8_640_000_000_000 is valid.
  if (pending !== null && (!Number.isFinite(ts) || Math.abs(ts * 1000) > 8.64e15)) {
    throw new ScaledUiError(
      `scaledUiAmountConfig: newMultiplierEffectiveTimestamp is outside the representable date range: ${JSON.stringify(tsRaw)} (pending ${pending} without a representable activation date)`,
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

/** Reconcile the planes: the issuer (API) multiplier against on-chain as of date. */
export function reconcileMultiplier(apiMultiplier, onChain, date = new Date().toISOString()) {
  // Dates compared numerically via Date.parse: string comparison confuses "Z"/".000Z"/date-only
  // and lost the pending exactly on its activation day (a false planes-disagree on the dashboard).
  const ts = Date.parse(String(date));
  if (Number.isNaN(ts)) {
    throw new ScaledUiError(`not a parseable date: ${JSON.stringify(date)}`);
  }
  const pendingTs = onChain.pendingEffectiveDate !== null ? Date.parse(onChain.pendingEffectiveDate) : null;
  // The on-chain "effective" multiplier: pending activates once its timestamp has passed
  const effectiveOnChain =
    pendingTs !== null && !Number.isNaN(pendingTs) && pendingTs <= ts && onChain.pendingMultiplier !== null
      ? onChain.pendingMultiplier
      : onChain.activeMultiplier;
  // Compare canonically, display as received: "1.10" (API) vs "1.1" (chain) is the same value;
  // a false planes-disagree on representation drift would be exactly the class of quiet lie
  // that canonicalization kills (Jev R3).
  const agree = canonicalDecimal(String(apiMultiplier)) === canonicalDecimal(String(effectiveOnChain));
  return {
    api: apiMultiplier,
    onChainActive: onChain.activeMultiplier,
    onChainEffective: effectiveOnChain,
    agree,
    verdict: agree ? "ok" : "planes-disagree",
  };
}
