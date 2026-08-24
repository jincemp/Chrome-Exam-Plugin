import { DEFAULT_SETTINGS, getSettings, isInsecureBase, setSettings } from '../src/storage.js';
import { listModels } from '../src/openai.js';

const $ = (id) => document.getElementById(id);

// Shown before we have talked to the API; replaced by the account's real list
// once a working key is present.
const SUGGESTED_MODELS = ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.4', 'gpt-5.4-mini'];

const setStatus = (text, kind) => {
  const el = $('status');
  el.textContent = text;
  el.className = `status${kind ? ` ${kind}` : ''}`;
};

/** Marker option that reveals the free-text box, for proxies and new IDs. */
const CUSTOM = '__custom__';

/**
 * Fill the dropdown, keeping `selected` in it even when the account's list does
 * not mention it - otherwise choosing a proxy model would silently reset.
 */
const fillModels = (ids, selected) => {
  const select = $('model');
  const chosen = selected ?? currentModel();
  const known = [...new Set([...ids, chosen].filter(Boolean))];

  select.replaceChildren();
  for (const id of known) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id === DEFAULT_SETTINGS.model ? `${id} — recommended` : id;
    select.append(opt);
  }

  const other = document.createElement('option');
  other.value = CUSTOM;
  other.textContent = 'Other — type a model ID…';
  select.append(other);

  select.value = chosen && known.includes(chosen) ? chosen : CUSTOM;
  syncCustom();
};

/** The model the form is currently describing, wherever it is being entered. */
function currentModel() {
  const select = $('model');
  if (!select.options.length) return '';
  return select.value === CUSTOM ? $('model-custom').value.trim() : select.value;
}

/** Show the free-text box only when "Other" is picked. */
function syncCustom() {
  const custom = $('model').value === CUSTOM;
  $('model-custom').hidden = !custom;
  if (custom) $('model-custom').focus();
}

function readForm() {
  return {
    apiKey: $('apiKey').value.trim(),
    model: currentModel() || DEFAULT_SETTINGS.model,
    effort: $('effort').value,
    endpoint: $('endpoint').value,
    baseUrl: ($('baseUrl').value.trim() || DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, ''),
    showWhy: $('showWhy').checked,
    extraInstructions: $('extraInstructions').value.trim(),
  };
}

/** Shows which build is loaded, so a failed update is visible rather than silent. */
function showVersion(settings) {
  try {
    $('version').textContent = chrome.runtime.getManifest().version;
  } catch {
    $('version').textContent = 'unknown';
  }
  $('active-model').textContent = settings.model;
}

async function load() {
  const s = await getSettings();
  showVersion(s);
  $('apiKey').value = s.apiKey;
  $('model-custom').value = s.model;
  fillModels(SUGGESTED_MODELS, s.model);
  $('effort').value = s.effort;
  $('endpoint').value = s.endpoint;
  $('baseUrl').value = s.baseUrl;
  $('showWhy').checked = s.showWhy;
  $('extraInstructions').value = s.extraInstructions;
  if (s.apiKey) refreshModels(s).catch(() => {});
}

/** Replace the suggestions with the models this key can actually use. */
async function refreshModels(settings) {
  const ids = await listModels(settings);
  const chat = ids
    .filter((id) => /^(gpt|o\d|chatgpt)/.test(id))
    .filter((id) => !/(embedding|whisper|tts|audio|realtime|image|dall-e|moderation|transcribe|search|codex)/.test(id))
    .sort();
  if (chat.length) fillModels(chat, currentModel());
  return chat;
}

// An escape hatch that does not depend on a migration having fired: put the
// shipped settings back, keeping the key so nobody has to paste it again.
$('reset').addEventListener('click', async () => {
  const { apiKey } = readForm();
  const fresh = { ...DEFAULT_SETTINGS, apiKey };
  await setSettings(fresh);
  $('model-custom').value = fresh.model;
  fillModels(SUGGESTED_MODELS, fresh.model);
  $('effort').value = fresh.effort;
  $('endpoint').value = fresh.endpoint;
  $('baseUrl').value = fresh.baseUrl;
  $('showWhy').checked = fresh.showWhy;
  $('extraInstructions').value = fresh.extraInstructions;
  showVersion(fresh);
  setStatus(`Reset. Model is now ${fresh.model}.`, 'ok');
});

$('model').addEventListener('change', syncCustom);

$('reveal').addEventListener('click', () => {
  const input = $('apiKey');
  const hidden = input.type === 'password';
  input.type = hidden ? 'text' : 'password';
  $('reveal').textContent = hidden ? 'Hide' : 'Show';
});

$('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = readForm();

  if (isInsecureBase(values.baseUrl)) {
    setStatus('Refusing to save: that base URL is plain http, which would send your API key unencrypted.', 'bad');
    return;
  }

  if (!(await ensureHostPermission(values.baseUrl))) {
    setStatus('Saved, but Chrome denied access to that host — requests to it will fail.', 'bad');
    await setSettings(values);
    return;
  }

  await setSettings(values);
  showVersion(values);
  setStatus('Saved.', 'ok');
  if (values.apiKey) refreshModels(values).catch(() => {});
});

/**
 * The manifest only grants api.openai.com up front. A proxy URL needs an
 * optional host permission, and Chrome will only prompt during a user gesture -
 * which the save click is.
 */
async function ensureHostPermission(baseUrl) {
  let origin;
  try {
    origin = `${new URL(baseUrl).origin}/*`;
  } catch {
    return true; // a malformed URL fails later with a clearer message
  }
  if (origin === 'https://api.openai.com/*') return true;
  try {
    // No await before this call: anything awaited first consumes the click
    // gesture and Chrome refuses to show the prompt. request() returns true
    // immediately, without prompting, when the permission is already held.
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}

$('test').addEventListener('click', async () => {
  const values = readForm();
  if (!values.apiKey) return setStatus('Enter a key first.', 'bad');

  // Same gates as Save: this call carries the key to whatever host is in the
  // box, so it must not be the one place that skips them.
  if (isInsecureBase(values.baseUrl)) {
    return setStatus('That base URL is plain http, which would send your API key unencrypted.', 'bad');
  }
  if (!(await ensureHostPermission(values.baseUrl))) {
    return setStatus('Chrome denied access to that host.', 'bad');
  }

  $('test').disabled = true;
  setStatus('Checking…');
  try {
    const models = await refreshModels(values);
    if (models.length && !models.includes(values.model)) {
      setStatus(`Key works, but "${values.model}" is not in your account's model list.`, 'bad');
    } else {
      setStatus('Key works.', 'ok');
    }
  } catch (err) {
    setStatus(err?.message || 'Could not reach OpenAI.', 'bad');
  } finally {
    $('test').disabled = false;
  }
});

// Do not lose a half-filled form. Two fields are deliberately left out: the base
// URL, because granting it needs a click; and the API key, because closing the
// tab is how people discard a half-pasted one - autosaving it would replace a
// working key with an unusable fragment. Both require Save.
window.addEventListener('beforeunload', () => {
  if (!loaded) return; // the form has not been populated yet - it is all blanks
  const { baseUrl, apiKey, ...rest } = readForm();
  void baseUrl;
  void apiKey;
  setSettings(rest);
});

/** Guards the autosave: closing the tab before load() finishes must be a no-op. */
let loaded = false;

load().then(() => { loaded = true; });
