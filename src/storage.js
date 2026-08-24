/*
 * Two stores with deliberately different lifetimes:
 *   local   - settings, including the API key. Survives restarts.
 *   session - per-tab jobs and answers. In-memory only, gone when Chrome quits.
 */

/**
 * Bump when a stored setting needs rewriting on upgrade, and add the rule to
 * migrate() below. Absent from storage means 0, i.e. an install from before
 * migrations existed.
 */
const SETTINGS_VERSION = 1;

export const DEFAULT_SETTINGS = {
  apiKey: '',
  // gpt-5.6-luna at medium effort. Luna sits on the price-performance frontier
  // where the mid tier does not: Luna at high matches gpt-5.6-terra at medium
  // for about 70% of the cost. Effort is always sent explicitly - an unset
  // field inherits a per-model default that has been `none` on some
  // generations, which silently disables reasoning and looks like a cost win.
  model: 'gpt-5.6-luna',
  effort: 'medium',               // none | minimal | low | medium | high | xhigh | max
  baseUrl: 'https://api.openai.com/v1',
  endpoint: 'auto',               // auto | responses | chat
  showWhy: true,
  extraInstructions: '',
  settingsVersion: SETTINGS_VERSION,
};

export async function getSettings() {
  // Ask for version 0 rather than the current default, so an install that
  // predates migrations reports 0 instead of looking already-migrated.
  const stored = await chrome.storage.local.get({ ...DEFAULT_SETTINGS, settingsVersion: 0 });
  const settings = { ...DEFAULT_SETTINGS, ...stored };

  const upgraded = migrate(settings);
  if (upgraded !== settings) {
    try {
      await chrome.storage.local.set(upgraded);
    } catch { /* a failed write just means we try again next time */ }
  }
  return upgraded;
}

/**
 * Settings are stored the moment the options page is closed, so a new default
 * never reaches anyone who has already run the extension. Migrations move those
 * installs forward; a value the user actually chose is always left alone.
 *
 * Returns the same object when there is nothing to do, so callers can tell.
 */
/**
 * Models that were only ever the shipped default, never a choice. An install
 * still on one of these was set up before the default moved, so it is carried
 * forward. Anything else in the box is the user's own decision and is kept.
 */
const SUPERSEDED_DEFAULT_MODELS = new Set(['gpt-4.1-mini', 'gpt-5.4-nano']);

export function migrate(settings) {
  if (settings.settingsVersion >= SETTINGS_VERSION) return settings;

  const next = { ...settings, settingsVersion: SETTINGS_VERSION };

  // Keyed on the model alone. An earlier version also required the effort to
  // still be the old default, which meant anyone who had touched that one
  // dropdown stayed pinned to a model that is retired or unevidenced.
  if (SUPERSEDED_DEFAULT_MODELS.has(settings.model)) {
    next.model = DEFAULT_SETTINGS.model;
    next.effort = DEFAULT_SETTINGS.effort;
  }

  return next;
}

export async function setSettings(patch) {
  await chrome.storage.local.set(patch);
}

/**
 * Plain http would put the API key on the wire in the clear. A server on this
 * machine never leaves it, so those are allowed.
 */
export function isInsecureBase(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false; // malformed URLs fail later, with a clearer message
  }
}

export const jobKey = (tabId) => `job:${tabId}`;

/** Same page? Ignore the hash - anchors do not change the questions. */
export const pageKey = (url) => {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString();
  } catch {
    return String(url || '');
  }
};

export async function getJob(tabId) {
  const key = jobKey(tabId);
  const bag = await chrome.storage.session.get(key);
  return bag[key] || null;
}

export async function setJob(tabId, job) {
  await chrome.storage.session.set({ [jobKey(tabId)]: { ...job, updatedAt: Date.now() } });
}

export async function clearJob(tabId) {
  await chrome.storage.session.remove(jobKey(tabId));
}
