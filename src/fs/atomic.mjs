// Shared guarantees for data files: atomic writes and preservation of a corrupted file
// as evidence (round 6). Extracted from the journal (saveJournalAtomic of round 5) after
// the LW2_tokens_json_write_non_atomic finding: the same class of interrupted write as the
// journal's, on data/tokens.json, brought the service down ENTIRELY — while the registry
// writers (enrich-decimals) wrote with a plain writeFileSync over the live file.
import {
  openSync, writeSync, closeSync, fsyncSync, renameSync, unlinkSync, copyFileSync,
  statSync, chmodSync,
} from "node:fs";
import { dirname, join, basename } from "node:path";

const defaultFs = { statSync, chmodSync, openSync, fsyncSync, closeSync };

/**
 * Carry the mode of an EXISTING target onto the tmp file before rename (round 8): rename
 * replaces the inode, and an operator chmod 600 (webhooks.json holds plaintext HMAC secrets)
 * silently fell back to the default 0644 on every write. No target — nothing to carry;
 * chmod is best-effort (platforms without a full chmod must not break the write).
 */
export function copyModeIfExists(targetPath, tmpPath, { fsTools = defaultFs } = {}) {
  let mode;
  try {
    mode = fsTools.statSync(targetPath).mode;
  } catch {
    return; // no target yet: the file creator (umask) sets the mode, not our concern
  }
  try {
    fsTools.chmodSync(tmpPath, mode);
  } catch { /* best-effort: the write matters more than the mode */ }
}

/**
 * fsync the directory after rename (round 8, Linux prod): without it, a power-loss can
 * undo the rename itself while the data survives. On platforms/filesystems without directory
 * fsync (Windows) — quietly best-effort. kill -9 is safe even without this: the data is
 * fsynced BEFORE the rename.
 */
export function fsyncDir(dirPath, { fsTools = defaultFs } = {}) {
  let fd;
  try {
    fd = fsTools.openSync(dirPath, "r");
  } catch {
    return; // the platform refuses to open a directory as a file — best-effort
  }
  try {
    fsTools.fsyncSync(fd);
  } catch { /* win/fs without directory fsync — best-effort */ }
  finally {
    try { fsTools.closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * Atomic JSON write: the payload goes entirely into a temp file in the SAME directory
 * (rename across devices does not work), is fsynced, and is renamed over the target file.
 * An interruption at any moment leaves a whole previous version in place of the journal/
 * registry; the temp file is cleaned up on ANY failure.
 * Round 7 (adversarial journal tests): serialization happens BEFORE the temp file is created.
 * Previously JSON.stringify ran after openSync(tmp), and a non-serializable payload (BigInt
 * inside) threw a TypeError, leaving an empty .tmp next to the target: the target itself
 * stayed intact (no garbage ever reached it), but the directory got polluted on every such
 * failure. Now a serialization throw creates no files at all, and a write/fsync/rename
 * failure after the temp file is opened cleans it up in catch — the disk is left with
 * neither a tmp nor target changes, and the error propagates as before.
 * @param {string} filePath — path to the file
 * @param {object|Array} value — serializable payload
 */
export function atomicWriteJson(filePath, value) {
  const tmp = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.tmp`);
  // serialize before openSync: a throw (BigInt/circular references) leaves no files behind
  const data = JSON.stringify(value, null, 1) + "\n";
  // 0600 from creation (round 9 fix 10): data/ files can hold plaintext secrets (webhooks);
  // previously the first write got the Linux umask default 0644, and R8-2 only preserved
  // the mode from the second write on. An existing target is normalized to its mode by
  // copyModeIfExists below.
  const fd = openSync(tmp, "w", 0o600);
  try {
    try {
      writeSync(fd, data);
      fsyncSync(fd); // data on disk BEFORE the rename: the rename never overtakes the write
    } finally {
      closeSync(fd); // close before a possible unlink: on Windows an open file cannot be deleted
    }
    copyModeIfExists(filePath, tmp); // the target's mode (e.g. 0600 secrets) survives the rename (round 8)
    renameSync(tmp, filePath);
    fsyncDir(dirname(filePath)); // directory after rename: power-loss does not undo the rename (round 8)
  } catch (err) {
    // write/fsync/rename failure AFTER the temp file was opened: clean up, the target is
    // untouched — the disk keeps neither a tmp nor changes (best effort: do not mask the original error)
    try { unlinkSync(tmp); } catch { /* already deleted or locked — the original error matters more */ }
    throw err;
  }
}

/**
 * Preserve a corrupted file as evidence BEFORE the first overwrite: rename to
 * `<path>.corrupt-<timestamp>`; if the rename is blocked (a "transient" failure: AV scanner,
 * indexer, EBUSY on Windows) — attempts are retried under different names, and as a last
 * resort the content is COPIED alongside (the original stays in place).
 * @param {string} filePath — path to the corrupted file
 * @param {{nowMs?: number, attempts?: number, rename?: Function, copy?: Function}} [opts]
 *   attempts — number of rename attempts (default 1); rename/copy — test injection
 * @returns {string|null} the evidence path, or null if the evidence could not be preserved at all
 */
export function preserveCorruptedFile(filePath, { nowMs = Date.now(), attempts = 1, rename = renameSync, copy = copyFileSync } = {}) {
  const backupName = (i) => `${filePath}.corrupt-${new Date(nowMs + i).toISOString().replace(/[:.]/g, "-")}`;
  for (let i = 0; i < attempts; i++) {
    const backupPath = backupName(i);
    try {
      rename(filePath, backupPath);
      return backupPath;
    } catch { /* the file may have been locked for a moment — next attempt under a different name */ }
  }
  // rename never succeeded: the evidence can at least be copied (the original stays in place)
  const backupPath = backupName(attempts - 1);
  try {
    copy(filePath, backupPath);
    return backupPath;
  } catch {
    return null;
  }
}
