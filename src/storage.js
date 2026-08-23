/*
 * Two stores with deliberately different lifetimes:
 *   local   - settings, including the API key. Survives restarts.
 *   session - per-tab jobs and answers. In-memory only, gone when Chrome quits.
 */

export const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'gpt-5.4-nano',
  effort: 'low',                  // reasoning effort: none | low | medium | high
  baseUrl: 'https://api.openai.com/v1',
  endpoint: 'auto',               // auto | responses | chat
  showWhy: true,
  extraInstructions: '',
};

export async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
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
