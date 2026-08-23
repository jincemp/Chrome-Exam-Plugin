import { DEFAULT_SETTINGS, getSettings, setSettings } from '../src/storage.js';
import { listModels } from '../src/openai.js';

const $ = (id) => document.getElementById(id);

// Shown before we have talked to the API; replaced by the account's real list
// once a working key is present.
const SUGGESTED_MODELS = ['gpt-5.4-nano', 'gpt-5.4-mini', 'gpt-5.4', 'gpt-5.6-luna', 'gpt-5.5'];

const setStatus = (text, kind) => {
  const el = $('status');
  el.textContent = text;
  el.className = `status${kind ? ` ${kind}` : ''}`;
};

const fillModels = (ids) => {
  const list = $('models');
  list.replaceChildren();
  for (const id of ids) {
    const opt = document.createElement('option');
    opt.value = id;
    list.append(opt);
  }
};

function readForm() {
  return {
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim() || DEFAULT_SETTINGS.model,
    effort: $('effort').value,
    endpoint: $('endpoint').value,
    baseUrl: ($('baseUrl').value.trim() || DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, ''),
    showWhy: $('showWhy').checked,
    extraInstructions: $('extraInstructions').value.trim(),
  };
}

async function load() {
  const s = await getSettings();
  $('apiKey').value = s.apiKey;
  $('model').value = s.model;
  $('effort').value = s.effort;
  $('endpoint').value = s.endpoint;
  $('baseUrl').value = s.baseUrl;
  $('showWhy').checked = s.showWhy;
  $('extraInstructions').value = s.extraInstructions;
  fillModels(SUGGESTED_MODELS);
  if (s.apiKey) refreshModels(s).catch(() => {});
}

/** Replace the suggestions with the models this key can actually use. */
async function refreshModels(settings) {
  const ids = await listModels(settings);
  const chat = ids
    .filter((id) => /^(gpt|o\d|chatgpt)/.test(id))
    .filter((id) => !/(embedding|whisper|tts|audio|realtime|image|dall-e|moderation|transcribe|search|codex)/.test(id))
    .sort();
  if (chat.length) fillModels(chat);
  return chat;
}

$('reveal').addEventListener('click', () => {
  const input = $('apiKey');
  const hidden = input.type === 'password';
  input.type = hidden ? 'text' : 'password';
  $('reveal').textContent = hidden ? 'Hide' : 'Show';
});

$('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = readForm();

  if (!(await ensureHostPermission(values.baseUrl))) {
    setStatus('Saved, but Chrome denied access to that host — requests to it will fail.', 'bad');
    await setSettings(values);
    return;
  }

  await setSettings(values);
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
  if (await chrome.permissions.contains({ origins: [origin] })) return true;
  try {
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}

$('test').addEventListener('click', async () => {
  const values = readForm();
  if (!values.apiKey) return setStatus('Enter a key first.', 'bad');

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

// Do not lose a half-filled form. Permission prompts need a gesture, so the
// base URL is deliberately left out of this autosave.
window.addEventListener('beforeunload', () => {
  const { baseUrl, ...rest } = readForm();
  void baseUrl;
  setSettings(rest);
});

load();
