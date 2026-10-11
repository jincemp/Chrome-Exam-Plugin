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

/** Often enough to hear about a fix within the hour; one tiny request each time. */
const CHECK_EVERY_MS = 60 * 60 * 1000;

/**
 * The helper "Update Quiz Answers" registers the first time it runs
 * (updater/native-host.sh, or native-host.bat on Windows). Through it, the
 * "Update now" button runs that same updater.
 */
export const HELPER = 'com.jincemp.quiz_answers';

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

/** The manifest in the folder right now, which may not be the one running. */
async function manifestOnDisk() {
  const res = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
  return res.json();
}

/** A static import or re-export at the start of a line: import x from './a.js', import './b.js', export { c } from './c.js'. */
const IMPORT_RE = /^[ \t]*(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]|^[ \t]*import\s*['"]([^'"]+)['"]/gm;
const SCRIPT_RE = /<script\b[^>]*\bsrc\s*=\s*['"]([^'"]+)['"]/gi;
/** A runaway guard, far above the dozen files there are. */
const MAX_FILES = 60;

/**
 * Could Chrome start the version on disk right now? That needs its service
 * worker and every module that imports, and its popup and settings pages with
 * theirs, all there and readable.
 *
 * A copy made by hand lands file by file, so the manifest can already name the
 * new version while src/ is still arriving. Restarting at that moment leaves
 * the background script dead until the next reload ("Service worker
 * registration failed. Status code: 3"), so the restart waits for this.
 * The double-click updater never gets here early: it changes the manifest last.
 */
export async function filesReady(manifest) {
  const base = chrome.runtime.getURL('');
  const worker = manifest?.background?.service_worker;
  if (typeof worker !== 'string' || !worker) return false;
  const pages = [manifest.action?.default_popup, manifest.options_ui?.page].filter((p) => typeof p === 'string');

  const queue = [worker, ...pages].map((p) => new URL(p, base).href);
  const seen = new Set();
  while (queue.length) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    if (seen.size > MAX_FILES) return false;

    let text;
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return false;
      text = await res.text();
    } catch {
      return false; // missing, or not readable yet
    }
    if (!text.trim()) return false; // created, but not written yet

    const found = url.endsWith('.html')
      ? [...text.matchAll(SCRIPT_RE)].map((m) => m[1])
      : [...text.matchAll(IMPORT_RE)].map((m) => m[1] || m[2]);
    for (const spec of found) {
      const next = new URL(spec, url).href;
      if (next.startsWith(base)) queue.push(next); // only the extension's own files
    }
  }
  return true;
}

/** True when the version on disk differs from the running one and could be started now. */
export async function readyToRestart() {
  try {
    return (await pendingRestart()) !== null && (await filesReady(await manifestOnDisk()));
  } catch {
    return false;
  }
}

/**
 * The version the updater has put on disk, if it differs from the one running.
 * null when there is nothing to restart onto - including while a manifest is
 * mid-write and does not parse yet.
 */
export async function pendingRestart() {
  try {
    const onDisk = (await manifestOnDisk()).version;
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

/** Is the helper registered, and does it answer? false whenever in doubt. */
export async function helperReady() {
  try {
    const reply = await chrome.runtime.sendNativeMessage(HELPER, { type: 'ping' });
    return reply?.ok === true;
  } catch {
    return false; // not registered yet, or blocked
  }
}

/**
 * Runs the updater through the helper, from the service worker, so it carries
 * on if the popup closes. Resolves to the helper's reply:
 * {ok, summary} - summary is the updater's own line, such as
 * "Updated Quiz Answers from 1.8.1 to 1.9.0." - or {ok: false, error}.
 */
export async function updateNow() {
  try {
    return (await chrome.runtime.sendMessage({ type: 'update' })) || { ok: false };
  } catch (e) {
    return { ok: false, error: { message: e?.message || 'Quiz Answers is not responding.' } };
  }
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
 *
 * `onWaiting` is called when a new version is on disk but not all of it can be
 * read yet - a copy still going on. That is not counted as an attempt, so
 * asking again a moment later can still restart.
 */
export async function restartIfUpdated({ now = Date.now(), onWaiting = () => {} } = {}) {
  const target = await pendingRestart();
  if (!target) return false;

  const { restartAttempt } = await chrome.storage.local.get('restartAttempt');
  if (restartAttempt?.version === target && now - restartAttempt.at < RESTART_RETRY_MS) return false;

  if (!(await readyToRestart())) {
    onWaiting(target);
    return false;
  }

  await chrome.storage.local.set({ restartAttempt: { version: target, at: now } });
  chrome.runtime.reload();
  return true;
}
