// Normalization of on-chain mint state into canonical MULTIPLIER_CHANGE.
// Live findings of Sep 19: PreStocks has no history API, but the events live right in the
// mint — SPACEX: active=1 + pending=5 since 2026-06-10 (already effective), OPENAI: ×1.4861347 since Jul 17.
// On-chain is the primary source: status confirmed; "from" during backfill = the active field
// (the chain's best truth about the previous value; intermediate steps between observations
// are unrecoverable from mint state — a documented limitation, not a guess).
//
// Chain invariant (round 4): an event is emitted ONLY if it continues the chain from "1".
// MultiplierTimeline requires the base "1" and continuity, otherwise createApiServer falls
// with TimelineError at startup, while an entry with the poison is already persisted in the
// journal → a restart replays it → crash again: an eternal boot-loop. A token first seen
// mid-history (active="5") gets no invented 5→X: lastEffective is fixed, events stay
// empty, a warn at serve startup honestly says the history is incomplete. We do not
// invent events.
import { validateEvent } from "../schema/events.mjs";

export class OnchainNormalizeError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "OnchainNormalizeError";
  }
}

const DAY = 86400;

// pending "0" is the issuer's way to "reset" pending (the live xstocks-spyx-current fixture):
// we treat it as absent, otherwise the journal emits X→0, the timeline is formally valid,
// and the vitrine silently shows zeros. Defense in depth: the chain parser is fixed separately.
const pendingOf = (parsed) =>
  parsed.pendingMultiplier == null || Number(parsed.pendingMultiplier) === 0
    ? null
    : parsed.pendingMultiplier;

const effectiveOf = (parsed, nowMs) => {
  const pendingTs = parsed.pendingEffectiveDate ? Date.parse(parsed.pendingEffectiveDate) : null;
  const pending = pendingOf(parsed);
  return pendingTs !== null && pendingTs <= nowMs && pending !== null
    ? pending
    : parsed.activeMultiplier;
};

/**
 * Backfill from the current mint state (first observation).
 * @returns {object|null} a canonical MULTIPLIER_CHANGE or null when no event is visible
 */
export function backfillMultiplierEvent(token, parsed, nowMs = Date.now()) {
  if (!parsed.hasExtension) return null; // a token without a rebase mechanism — no facts, and that is a fact
  const pending = pendingOf(parsed);
  if (pending === null || parsed.pendingEffectiveDate === null) return null;
  const from = parsed.activeMultiplier;
  const to = pending;
  if (from === to) return null; // pending already equals active — the rotation is complete, nothing new to see
  const event = {
    type: "MULTIPLIER_CHANGE",
    mint: token.mint,
    effectiveDate: parsed.pendingEffectiveDate,
    status: "confirmed",
    sources: [`solana:getAccountInfo:${token.mint}#scaledUiAmountConfig (observed for ${token.symbol})`],
    multiplierFrom: from,
    multiplierTo: to,
    reason: "On-chain rebase",
  };
  try {
    validateEvent(event);
  } catch (err) {
    throw new OnchainNormalizeError(`backfill failed validation: ${err.message}`);
  }
  return event;
}

/**
 * Journal diff: compare the past effective value with the current chain state.
 * @param {{lastEffective: string, observedAt: string, events?: Array}|null} entry — journal entry
 *   (null = first observation). events — the FULL history of emitted events: an entry without
 *   them (v1) is migrated by backfill by the calling layer.
 * @returns {{event: object|null, entry: {lastEffective: string, observedAt: string, events: Array}}}
 *   event — only the NEW event of this step; the whole history lives in entry.events —
 *   otherwise a process restart lost the already-emitted events (the multiplier silently
 *   rolled back to 1).
 */
export function journalTransition(token, parsed, entry, nowMs = Date.now()) {
  const nowIso = new Date(nowMs).toISOString();
  const effective = effectiveOf(parsed, nowMs);
  const priorEvents = Array.isArray(entry?.events) ? entry.events : [];

  if (entry === null) {
    if (!parsed.hasExtension) {
      // a mint without a rebase mechanism: the parser's default "1" is not a fact, no entry
      // (wave C4-1: empty {lastEffective:"1"} entries are just noise and bait)
      return { event: null, entry: null };
    }
    // First observation: backfill only makes sense if it STARTS the chain from "1".
    // A token first seen mid-history (active="5", pending="6") used to emit 5→6 —
    // a TimelineError when building timelines and an eternal boot-loop (the poison gets
    // persisted in the journal). We do not invent: lastEffective is fixed, events stay empty.
    const candidate = parsed.hasExtension && effective !== "1"
      ? backfillMultiplierEvent(token, parsed, nowMs)
      : null;
    const event = candidate !== null && candidate.multiplierFrom === "1" ? candidate : null;
    // entry records the EFFECTIVE value — future rotations diff against it
    return { event, entry: { lastEffective: effective, observedAt: nowIso, events: event ? [event] : [] } };
  }

  // Wave C4-1 [P1]: a response WITHOUT scaledUiAmountConfig is "no fact", not "a reset to 1":
  // the parser honestly returns the default "1" (hasExtension:false), but the diff took it
  // for an observed reset → a phantom X→1, and when the truth returned — an eternal duplicate
  // triplet in the history (the 2400-boot marathon: 1221 violations of this class before the fix).
  // The entry is not touched — the same contract as for an unreachable chain.
  if (!parsed.hasExtension) {
    return { event: null, entry };
  }

  if (effective === entry.lastEffective) {
    return { event: null, entry: { lastEffective: entry.lastEffective, observedAt: nowIso, events: priorEvents } };
  }

  // The diff event is emitted only if it CONTINUES the recorded chain: it is empty and
  // from === "1", or the last event ends exactly at from. Otherwise — for example,
  // a token first seen after a completed rotation (lastEffective="5", events=[]):
  // a 5→X event would tear the timeline at the next rebase. We honestly update
  // lastEffective without an event — a warn in serve will pick up an entry without history.
  const chainOk = priorEvents.length === 0
    ? entry.lastEffective === "1"
    : priorEvents[priorEvents.length - 1].multiplierTo === entry.lastEffective;
  if (!chainOk) {
    return { event: null, entry: { lastEffective: effective, observedAt: nowIso, events: priorEvents } };
  }

  const event = {
    type: "MULTIPLIER_CHANGE",
    mint: token.mint,
    effectiveDate: parsed.pendingEffectiveDate ?? nowIso,
    status: "confirmed",
    sources: [`solana:getAccountInfo:${token.mint}#scaledUiAmountConfig (rotation observed for ${token.symbol})`],
    multiplierFrom: entry.lastEffective,
    multiplierTo: effective,
    reason: "On-chain rebase",
  };
  try {
    validateEvent(event);
  } catch (err) {
    throw new OnchainNormalizeError(`journal transition failed validation: ${err.message}`);
  }
  return { event, entry: { lastEffective: effective, observedAt: nowIso, events: [...priorEvents, event] } };
}
