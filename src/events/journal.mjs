// On-chain journal synchronization step — a pure function over (journal entry, chain plan).
// Split out of serve.mjs for testability and for a P0 invariant: journal events survive
// a process restart. parsed === null means the chain is unreachable: past events are
// replayed from cache, the journal entry is left untouched (observedAt stays honestly stale).
import { journalTransition } from "./normalize-onchain.mjs";
import { readFileSync, openSync, closeSync, unlinkSync, statSync, writeSync } from "node:fs";
import { parseIsoDateMs } from "../schema/isodate.mjs";
import { canonicalDecimalString, EVENT_TYPES } from "../schema/events.mjs";
import { atomicWriteJson, preserveCorruptedFile } from "../fs/atomic.mjs";

// Canonicalization of a journal entry AT READ TIME (round 9 fix 15): a journal written by a
// build predating canonicalization carries the raw RPC representation ("5.0") — a string
// diff against the canonical chain ("5") emitted a phantom MULTIPLIER_CHANGE of the same
// magnitude. Canonicalizes lastEffective and the multiplier fields of history. An already
// canonical entry is returned BY REFERENCE (the "entry===priorEntry when the chain is
// unreachable" contract); a field that does not look like a decimal stays as is
// (validation below will honestly reject it).
function canonicalizeEntry(entry) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
  const canonMult = (v) => (typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? canonicalDecimalString(v) : v);
  const eventsCanonical = !Array.isArray(entry.events) || entry.events.every((e) => (
    e === null || typeof e !== "object"
    || (canonMult(e.multiplierFrom) === e.multiplierFrom && canonMult(e.multiplierTo) === e.multiplierTo)
  ));
  if (canonMult(entry.lastEffective) === entry.lastEffective && eventsCanonical) return entry;
  return {
    ...entry,
    lastEffective: canonMult(entry.lastEffective),
    events: Array.isArray(entry.events)
      ? entry.events.map((e) => (e !== null && typeof e === "object"
        ? { ...e, multiplierFrom: canonMult(e.multiplierFrom), multiplierTo: canonMult(e.multiplierTo) }
        : e))
      : entry.events,
  };
}

/**
 * @param {object} token — registry entry (mint, symbol needed)
 * @param {{lastEffective: string, observedAt: string, events?: Array}|null} priorEntry — entry from the journal on disk
 * @param {object|null} parsed — parseScaledUiAmount(...) or null when the chain is unreachable
 * @returns {{replay: Array, event: object|null, entry: object|null, chain: "ok"|"unavailable", unavailableV1: boolean, corrupted: boolean}}
 *   replay — events of past sessions, for replaying into the events stream;
 *   event — ONLY the new event of this step;
 *   entry — the entry to save (null = nothing to save, history not started);
 *   entry===priorEntry (same reference) when the chain is unreachable — saved unchanged;
 *   unavailableV1 — a v1 entry (no events) with a multiplier ≠ "1" and an unreachable chain:
 *   backfill migration is impossible, the vitrine will show multiplier 1 — the warn must fire,
 *   otherwise "the real 5" silently looks like 1 (a quiet lie, round 4);
 *   corrupted — the priorEntry is corrupted (events present but not an array): the history
 *   is distrusted, the step ran fail-closed (see the body of planJournalStep).
 */
export function planJournalStep(token, priorEntry, parsed, nowMs = Date.now()) {
  // Round 7 (journal adversarial tests): an entry with events-NOT-an-array is
  // CORRUPTED, not "no history". Previously v1/v2 were told apart only by
  // Array.isArray(events), so a garbage field (the string "1→5" instead of an array) silently
  // turned the entry into a "first observation": the replay was empty, backfill re-emitted
  // a duplicate event, and the file stayed shape-valid — the corruption checks
  // could not see it. An absent field (undefined) is a legitimate v1 entry (backfill
  // migration); ANY other non-array value is corruption. Fail-closed semantics
  // modeled on round 6 (corruption is an explicit state, the evidence survives the write):
  //   (1) a loud console.error to the operator with the FULL evidence — the broken entry
  //       is serialized into the log; this is the only evidence spot available to the planner:
  //       the journal path never reaches here, and only the serve layer (bootJournalOnchain)
  //       can save the broken entry next to the file — planJournalStep deliberately does not
  //       reach into that contract (a pure function over the entry);
  //   (2) a duplicate event from backfill is NOT re-emitted — neither in event nor in events;
  //   (3) with a live chain — recovery from scratch: lastEffective is fixed from the
  //       chain fact, events are honestly empty (the old history is unrecoverable —
  //       we do not invent it); subsequent steps follow the normal mid-history semantics;
  //   (4) with an unreachable chain entry: null — the broken entry on disk is not touched,
  //       recovery is only possible from the chain fact (the evidence survives the step).
  const priorIsObject = priorEntry !== null && priorEntry !== undefined && typeof priorEntry === "object";
  // ROUND7 fix 4 + ROUND9 fix 4: a PRIMITIVE entry and an ARRAY entry are the same corruption
  // as events-not-an-array. An array is also typeof "object" but is not an entry in structure
  // ({lastEffective, events}): it used to slip into "no history" (base=null), backfill
  // re-emitted a duplicate, the final persist clobbered the evidence; loadJournalOnchain
  // rejects an array at the TOP of the file as corruption — per-entry must do the same.
  // Round 21 (SRE P2-3): an events array with an INVALID ELEMENT is the same corruption —
  // a future/downgraded writer's record used to survive every boot: the replay validation
  // threw, the token was silently dead each session, and the broken record was rewritten
  // to disk forever. An element is trusted only as a non-null object with a KNOWN event
  // type (the schema's EVENT_TYPES — the same list replay validation enforces); the rest
  // routes to the corrupted branch, which rebuilds the token from the chain's fact.
  const invalidEventElement = Array.isArray(priorEntry?.events)
    ? priorEntry.events.find((e) => e === null || typeof e !== "object"
        || (typeof e.type === "string" && !EVENT_TYPES.includes(e.type)))
    : undefined;
  const priorIsCorrupted = priorEntry !== null && priorEntry !== undefined
    && (typeof priorEntry !== "object"
      || Array.isArray(priorEntry)
      || (priorEntry.events !== undefined && !Array.isArray(priorEntry.events))
      || invalidEventElement !== undefined);
  if (priorIsCorrupted) {
    console.error(
      `[journal] ${token.symbol ?? token.mint}: journal entry CORRUPTED — ${
        !priorIsObject
          ? `not an object (${typeof priorEntry})`
          : Array.isArray(priorEntry)
            ? "an array instead of an entry object"
            : priorEntry.events !== undefined && !Array.isArray(priorEntry.events)
              ? `events is not an array (type ${priorEntry.events === null ? "null" : typeof priorEntry.events})`
              : `events carries an invalid element (${JSON.stringify(invalidEventElement)})`
      }, history is distrusted. Evidence: ${JSON.stringify(priorEntry)}. ` +
      `Replay and backfill over it are NOT performed — no duplicate event is re-emitted; ` +
      `with a live chain the entry will be rebuilt from scratch (no events; the vitrine will warn about a multiplier without history).`,
    );
    if (parsed === null) {
      return { replay: [], event: null, entry: null, chain: "unavailable", unavailableV1: false, corrupted: true };
    }
    const recovered = journalTransition(token, parsed, null, nowMs);
    return {
      replay: [],
      event: null, // backfill suppressed: re-emitting a duplicate from a distrusted base is not allowed
      entry: { ...recovered.entry, events: [] },
      chain: "ok",
      unavailableV1: false,
      corrupted: true,
    };
  }
  // The v2 marker of an entry is the events array; v1 entries (without it) are run through
  // backfill: this way a deployed instance self-heals without a manual file migration.
  // Canonicalization happens BEFORE all comparisons (round 9 fix 15): replay/diff see
  // canonical strings.
  const prior = canonicalizeEntry(priorEntry);
  const base = priorIsObject && Array.isArray(prior.events) ? prior : null;
  const replay = base ? base.events : [];
  if (parsed === null) {
    const unavailableV1 = base === null && prior && prior.lastEffective !== "1";
    return { replay, event: null, entry: base, chain: "unavailable", unavailableV1, corrupted: false };
  }
  const { event, entry } = journalTransition(token, parsed, base, nowMs);
  return { replay, event, entry, chain: "ok", unavailableV1: false, corrupted: false };
}

/**
 * Completeness check of the issuer's multiplier history chain (xStocks multiplier history).
 * Pagination in serve is capped by a page ceiling, so the oldest node of what was collected
 * may NOT start from "1" — such a set breaks MultiplierTimeline ("chain
 * discontinuity") and used to crash the server at startup (boot-loop). An honest refusal:
 * events are not fed to the timeline, a warn instead of a crash (fail-honest).
 * @param {Array<{previousMultiplier: string, activationDateTime: string}>} nodes — fetchMultiplierHistory nodes, any order
 * @returns {{complete: boolean, reason: string|null}} complete=true — the chain starts from "1", safe to feed the timeline
 */
export function issuerChainComplete(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) return { complete: true, reason: null };
  let oldest = null;
  let oldestTs = Number.POSITIVE_INFINITY;
  for (const n of nodes) {
    // The same strict parser as the whole date pipeline (schema/isodate.mjs) — round 6,
    // LW2_issuer_chain_complete_dateparse_divergence: this used to be Date.parse, which
    // rolled "2026-02-30T00:00:00Z" over to March 2 and parsed naive time as LOCAL —
    // nodes with such dates passed the gate and then crashed further down
    // with NormalizeError ("source unreachable" while the source was alive).
    const ts = parseIsoDateMs(n.activationDateTime);
    // garbage date/rollover/naive time — no guessing: the node does not take part in
    // picking the oldest one, an unverifiable chain = incomplete (fail-closed)
    if (ts === null) {
      return { complete: false, reason: `unparseable activation date: ${JSON.stringify(n.activationDateTime)}` };
    }
    if (ts < oldestTs) {
      oldestTs = ts;
      oldest = n;
    }
  }
  if (oldest.previousMultiplier !== "1") {
    return {
      complete: false,
      reason: `oldest event ${oldest.activationDateTime} starts from "${oldest.previousMultiplier}", not from "1"`,
    };
  }
  return { complete: true, reason: null };
}

// ---- journal persistence (round 5, LW_journal_write_non_atomic) ----
// A direct writeFileSync over a live file, interrupted midway (crash/kill in the boot
// window, disk), left a truncated JSON that on the next start was silently treated as
// a "first run" (empty journal) — an unrecoverable loss of the entire event history.
// Two countermeasures: (1) the write is atomic — temp in the same directory + fsync +
// rename, so on disk there is always either the old whole version or the new whole one;
// (2) a broken file at load is an explicit "corrupted" state (fail-closed), distinguishable
// from an honest first run, not a silent {}.

/**
 * Atomic journal write: the payload goes whole into a temp file in the SAME
 * directory (rename across devices does not work), is fsync'ed and renamed
 * over the target file. An interruption at any moment leaves the previous whole
 * version in place of the journal; the temp file is cleaned up after a failed rename.
 * Since round 6 this delegates to the shared atomicWriteJson (src/fs/atomic.mjs) — the same
 * implementation is used by the tokens.json writers.
 * @param {string} journalPath — path to onchain-journal.json
 * @param {object} journal — map { mint: entry }
 */
export function saveJournalAtomic(journalPath, journal) {
  atomicWriteJson(journalPath, journal);
}

/**
 * Journal load that distinguishes "first run" from "file corrupted". Previously a single
 * catch for both cases produced a silent {} — a file truncated after a write interruption
 * looked like a clean start, and the event history was lost unrecoverably.
 * @param {string} journalPath
 * @returns {{ok: boolean, corrupted: boolean, journal: object, reason: string|null}}
 *   no file → { ok: true, corrupted: false } (backfill from the chain is a legitimate start);
 *   readable but unparseable / not an object {mint: entry} → { ok: false, corrupted: true }.
 */
export function loadJournalOnchain(journalPath) {
  let raw;
  try {
    raw = readFileSync(journalPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { ok: true, corrupted: false, journal: {}, reason: null };
    }
    return { ok: false, corrupted: true, journal: {}, reason: `journal file is unreadable: ${err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, corrupted: true, journal: {}, reason: `truncated/invalid JSON: ${err.message}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const got = parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
    return { ok: false, corrupted: true, journal: {}, reason: `journal must be an object {mint: entry}, got ${got}` };
  }
  return { ok: true, corrupted: false, journal: parsed, reason: null };
}

/**
 * Save the corrupted journal file as evidence BEFORE the first overwrite. Since round 6
 * this delegates to the shared preserveCorruptedFile (src/fs/atomic.mjs): it retries rename
 * under other names (AV/indexers hold the file for a moment — a "transient" failure is often
 * cleared by a second attempt) and falls back to copy if rename never succeeded.
 * @param {string} journalPath
 * @param {{nowMs?: number, attempts?: number, rename?: Function, copy?: Function}} [opts]
 * @returns {string|null} path to the evidence, or null if the evidence could not be saved at all.
 */
export function preserveCorruptedJournal(journalPath, opts = {}) {
  return preserveCorruptedFile(journalPath, opts);
}

/**
 * Journal boot (round 6, LW2_journal_evidence_clobber_on_failed_preserve): load +
 * evidence save — a single entry point for scripts/serve.mjs. The key guarantee: if the evidence
 * could NOT be saved (preserveFailed), the corrupted original stays in place — and the boot
 * MUST run in read-only mode (persistJournalOnBoot will refuse to write),
 * because the final saveJournalAtomic would erase the only copy of the history. Previously
 * serve did not branch on null from preserveCorruptedJournal and clobbered the original at the end of boot.
 * @param {string} journalPath
 * @param {{nowMs?: number, attempts?: number, rename?: Function, copy?: Function}} [opts]
 * @returns {{journal: object, corrupted: boolean, reason: string|null,
 *            backup: string|null, preserveFailed: boolean}}
 */
export function bootJournalOnchain(journalPath, opts = {}) {
  const loaded = loadJournalOnchain(journalPath);
  if (!loaded.corrupted) {
    return { journal: loaded.journal, corrupted: false, reason: null, backup: null, preserveFailed: false };
  }
  const backup = preserveCorruptedFile(journalPath, { attempts: 3, ...opts });
  return {
    journal: loaded.journal,
    corrupted: true,
    reason: loaded.reason,
    backup,
    preserveFailed: backup === null,
  };
}

/**
 * Final journal write at the end of boot — the ONLY place serve.mjs writes the
 * journal from. preserveFailed=true ⇒ read-only mode until restart: no write is performed,
 * the corrupted original is guaranteed to survive the boot; session events live in memory,
 * /health shows journal.preserveFailed=1. A restart after the locking process goes away
 * will save the evidence normally and restore writing.
 * @param {string} journalPath
 * @param {object} journal
 * @param {{preserveFailed?: boolean}} [opts]
 * @returns {{written: boolean, readonly: boolean, error: Error|null}}
 */
export function persistJournalOnBoot(journalPath, journal, { preserveFailed = false } = {}) {
  if (preserveFailed) return { written: false, readonly: true, error: null };
  try {
    // Wave E (E3-2): merge-under-lock, not a snapshot over the disk — a foreign write
    // landed in the "boot read → persisted" window used to be silently clobbered.
    saveJournalMerged(journalPath, journal);
    return { written: true, readonly: false, error: null };
  } catch (err) {
    return { written: false, readonly: false, error: err };
  }
}

// Synchronous pause without busy-waiting (the webhook store-lock pattern from R8).
const SYNC_WAIT_CELL = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms) => Atomics.wait(SYNC_WAIT_CELL, 0, 0, ms);

// pid liveness (ROUND9 fix 9 semantics from the webhook store-lock): an existing process =
// a live owner, EPERM = someone else's but alive; ESRCH = dead. kill is injected to pin
// the EPERM branch (on Windows a one-user suite never gets EPERM from process.kill for
// foreign pids).
// Linux blind spot (H1): an unreaped zombie (the parent did not reap it) answers
// kill(pid,0) with success — we wait out the whole budget and degrade; same trade-off
// family as pid-reuse, the degradation is bounded by staleMs.
export function isPidAlive(pid, kill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// Exclusive lock file. The contents are load-bearing: {pid, createdAt} — via pid, a dead
// owner is broken IMMEDIATELY (an orphan after kill -9), while a live SIGSTOPped process
// with an old mtime is NOT broken (wave F1 reproduced the TOCTOU of R9 fix 9 for the second
// lock — closed). Legacy/non-JSON contents — by mtime alone, as in the webhook lock.
// A future mtime (clock skew) is also a candidate for breaking: waiting staleMs from
// "tomorrow" is pointless.
// nowMs is injected (the rate-limiter pattern) — the "exactly staleMs" boundary is pinned
// deterministically.
// Returns an fd or null (not taken — degradation; boot must not crash because of a lock).
export function acquireSyncLock(lockPath, { staleMs, attempts, retryPauseMs, nowMs }) {
  // Wave H4 [P4]: garbage nowMs (null/NaN) used to leak into the age arithmetic
  // (null − mtime = "deep future" = breaking a fresh lock) — we validate the injection.
  if (typeof nowMs !== "function" && !Number.isFinite(nowMs)) nowMs = Date.now;
  const now = typeof nowMs === "function" ? nowMs() : nowMs;
  // Wave H4 [P3]: the attempt counter is a false metric on Windows (Atomics.wait(5) really
  // takes ~15.6ms): 700 attempts = 10.9-12s of blocking instead of the "~3.5s" from the
  // R14 comment. The honest ceiling is the wall clock: degradation no later than ~staleMs
  // regardless of OS.
  const deadline = Date.now() + staleMs;
  for (let i = 0; i < attempts; i++) {
    if (i > 0 && Date.now() >= deadline) break;
    let fd = null;
    try {
      fd = openSync(lockPath, "wx");
    } catch (err) {
      if (err.code !== "EEXIST") return null;
      try {
        const meta = (() => {
          try {
            return JSON.parse(readFileSync(lockPath, "utf8"));
          } catch {
            return null; // legacy/empty content — pid semantics do not apply
          }
        })();
        if (meta !== null && Number.isInteger(meta?.pid)) {
          // a lock with a pid: a dead owner is broken IMMEDIATELY (an orphan after kill -9
          // does not burn staleMs — wave F1-4), a live one is not broken AT ALL (a SIGSTOPped
          // owner does not lose the update — R9 fix 9), regardless of mtime
          if (!isPidAlive(meta.pid)) unlinkSync(lockPath);
        } else {
          const age = now - statSync(lockPath).mtimeMs;
          // legacy lock — mtime semantics; the future counts only BEYOND ±staleMs:
          // NTFS rounds mtime up by fractions of a ms — a fresh lock must not look like
          // a "minus-a-millisecond future" (the round 15 pitfall)
          if (age > staleMs || age < -staleMs) unlinkSync(lockPath);
        }
      } catch {
        /* the lock vanished between EEXIST and stat — just retry */
      }
      if (fd === null) {
        sleepSync(retryPauseMs);
        continue;
      }
    }
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      return fd;
    } catch (err) {
      // An empty lock would make the next process treat it as legacy and break a LIVE owner
      // by mtime — a TOCTOU resurrection. We remove it and degrade without a lock.
      try { closeSync(fd); } catch { /* already closed */ }
      try { unlinkSync(lockPath); } catch { /* already removed */ }
      return null;
    }
  }
  return null;
}

/**
 * Merge-under-lock of the journal (wave E, E3-2). The boot is not the only writer: a manual
 * fix or a second process could land an entry in the window between the read at startup and
 * the final persist; a snapshot over the disk clobbered it. Under the lock file we re-read
 * the disk and merge BY MINT: our entries are fresher (they win for their mints), foreign
 * mints survive. File unreadable/broken — we write our own snapshot (as before round 14:
 * the preserve decision lives at the persistJournalOnBoot level). Lock not acquired (a live
 * neighbor holds it longer than staleMs, disk full) — we write without the lock: no worse
 * than the status quo.
 * @param {string} journalPath
 * @param {object} journal — the { mint: entry } map of this process
 */
export function saveJournalMerged(journalPath, journal, { staleMs = 10_000, attempts = 700, retryPauseMs = 5, nowMs } = {}) {
  const lockPath = `${journalPath}.lock`;
  let fd = null;
  try {
    fd = acquireSyncLock(lockPath, { staleMs, attempts, retryPauseMs, ...(nowMs !== undefined ? { nowMs } : {}) });
  } catch {
    fd = null;
  }
  try {
    let merged = { ...journal };
    const existing = loadJournalOnchain(journalPath);
    if (existing.ok) {
      for (const [mint, entry] of Object.entries(existing.journal)) {
        if (!(mint in merged)) merged[mint] = entry;
      }
    }
    atomicWriteJson(journalPath, merged);
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
      try {
        unlinkSync(lockPath);
      } catch {
        /* someone broke the stale one — fine */
      }
    }
  }
}
