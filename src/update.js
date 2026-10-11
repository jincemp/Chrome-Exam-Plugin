/*
 * Knowing about updates, and picking them up once they are on disk.
 *
 * An unpacked extension cannot update itself: Chrome's updater skips it, and
 * nothing in an extension can write to its own folder. So the work is split.
 * "Update Quiz Answers" (updater/) replaces the files from outside Chrome, and
 * this module does the two things only the extension can:
 *
 *   - say that a newer version exists, by reading the version number published
 *     on GitHub. That file is served with Access-Control-Allow-Origin: *, so
 *     this needs no host permission. Only the number is read and shown, as
 *     text. Nothing fetched from GitHub is ever run here.
 *   - notice when its own files have been replaced, and restart onto them. A
 *     chrome-extension:// fetch reads the folder as it is now, while
 *     getManifest() keeps describing the version that is loaded.
 */

/** Where the published version number lives. tools/e2e.mjs points this at its mock. */
export const UPDATE_MANIFEST_URL = 'https://raw.githubusercontent.com/jincemp/Chrome-Exam-Plugin/main/manifest.json';

/** Often enough to hear about a fix the same day; rarely enough not to be noticed. */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * A restart that does not take - Developer mode switched off leaves the
 * extension disabled instead of reloaded - must not turn into a loop. Each new
 * version on disk gets one automatic attempt per window.
 */
const RESTART_RETRY_MS = 10 * 60 * 1000;

const VERSION_RE = /^\d+(\.\d+){0,3}$/;

/** -1, 0 or 1. Numeric per part, so 1.10.0 is newer than 1.9.0. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Is a newer version published? Asks GitHub at most every few hours, and
 * answers from the last result in between - including when offline, so a
 * failed check never makes a known update disappear.
 *
 * @returns {Promise<{current: string, latest: string|null, available: boolean}>}
 */
export async function checkForUpdate({ force = false, now = Date.now(), fetchImpl = fetch } = {}) {
  const current = chrome.runtime.getManifest().version;
  const { updateCheck } = await chrome.storage.local.get('updateCheck');
  let latest = updateCheck?.latest || null;

  const stale = !updateCheck || !(now - updateCheck.checkedAt < CHECK_EVERY_MS);
  if (force || stale) {
    try {
      const res = await fetchImpl(UPDATE_MANIFEST_URL, { cache: 'no-store' });
      if (res.ok) {
        const remote = await res.json();
        // Shown to the user, so only ever a plain version number.
        if (typeof remote?.version === 'string' && VERSION_RE.test(remote.version)) latest = remote.version;
      }
      // A 404 or a garbled body still counts as having asked: a moved or
      // renamed repo should not be re-requested on every popup open.
      await chrome.storage.local.set({ updateCheck: { latest, checkedAt: now } });
    } catch { /* offline - keep what we knew, and ask again next time */ }
  }

  return { current, latest, available: !!latest && compareVersions(latest, current) > 0 };
}

/** The version of the files in the folder right now, which may not be the one running. */
async function versionOnDisk() {
  const res = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
  return (await res.json()).version;
}

/**
 * The version the updater has put on disk, if it differs from the one running.
 * null when there is nothing to restart onto - including while a manifest is
 * mid-write and does not parse yet.
 */
export async function pendingRestart() {
  try {
    const onDisk = await versionOnDisk();
    if (typeof onDisk !== 'string' || !onDisk) return null;
    return onDisk !== chrome.runtime.getManifest().version ? onDisk : null;
  } catch {
    return null;
  }
}

/**
 * How many tabs hold a finished answer sheet. A restart clears
 * chrome.storage.session, so every one of these would be lost - answers the
 * user has already paid OpenAI for.
 */
export async function answersHeld() {
  const all = await chrome.storage.session.get(null);
  return Object.entries(all).filter(([key, job]) => key.startsWith('job:') && job?.status === 'done').length;
}

/**
 * Asks the service worker to restart onto the new files. It is the only one
 * that knows for certain whether answers are still being worked on, and it
 * refuses then ({busy: true}) rather than throw away a request already paid for.
 */
export async function requestRestart() {
  try {
    return (await chrome.runtime.sendMessage({ type: 'restart' })) || { ok: false };
  } catch {
    return { ok: false };
  }
}

/**
 * Restart onto new files if there are any, at most once per version per
 * RESTART_RETRY_MS. Returns true when a restart was started.
 */
export async function restartIfUpdated({ now = Date.now() } = {}) {
  const target = await pendingRestart();
  if (!target) return false;

  const { restartAttempt } = await chrome.storage.local.get('restartAttempt');
  if (restartAttempt?.version === target && now - restartAttempt.at < RESTART_RETRY_MS) return false;

  await chrome.storage.local.set({ restartAttempt: { version: target, at: now } });
  chrome.runtime.reload();
  return true;
}
