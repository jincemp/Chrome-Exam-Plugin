import { formatAll, sortAnswers } from '../src/format.js';
import { getSettings, jobKey, pageKey } from '../src/storage.js';
import { answersHeld, checkForUpdate, helperStatus, pendingRestart, requestRestart, updateNow, withoutHelper } from '../src/update.js';

const $ = (id) => document.getElementById(id);

const panels = {
  setup: $('panel-setup'),
  idle: $('panel-idle'),
  busy: $('panel-busy'),
  answers: $('panel-answers'),
  error: $('panel-error'),
};

const BUSY_LABELS = {
  reading: 'Reading page…',
  thinking: 'Loading',
};

let tab = null;
let settings = null;

/**
 * Set when an update is on disk and restarting loses nothing. Until the
 * restart, the files the popup and page reader load are already the new ones,
 * while the worker still runs the old code - so a new job waits for it.
 */
let restartFirst = null;

function show(name) {
  const changed = panels[name].hidden;
  for (const [key, el] of Object.entries(panels)) el.hidden = key !== name;
  // While an update waits, the idle panel's own button finishes it; anywhere
  // else, the line at the foot does.
  if (restartFirst) $('update').hidden = name === 'idle';

  // Hiding the panel that held focus drops the user on <body>. Move focus with
  // the state instead, so the result is reachable and gets announced.
  if (changed && name !== 'idle') panels[name].focus?.();
}

/* ------------------------------------------------------------------ render */

function renderAnswers(job) {
  const list = $('answers');
  list.replaceChildren();

  const answers = sortAnswers(job.answers || []);
  if (!answers.length) {
    const li = document.createElement('li');
    li.className = 'why';
    li.textContent = 'No questions found on this page.';
    list.append(li);
  }

  for (const a of answers) {
    const li = document.createElement('li');

    const why = (a.why || '').trim();
    const interactive = Boolean(why) && settings.showWhy;

    // A row that reveals nothing should not be a button - it would be a focus
    // stop that does nothing and reads as actionable to a screen reader.
    const row = document.createElement(interactive ? 'button' : 'div');
    if (interactive) row.type = 'button';
    row.className = 'row';
    if (a.confidence === 'low') row.classList.add('low');

    const q = document.createElement('span');
    q.className = 'q';
    q.textContent = `Q${String(a.number ?? '?').trim()}:`;

    const ans = document.createElement('span');
    ans.className = 'a';
    if (a.label) {
      const opt = document.createElement('span');
      opt.className = 'opt';
      opt.textContent = `${String(a.label).trim().replace(/[).\]]+$/, '')}) `;
      ans.append(opt);
    }
    ans.append(document.createTextNode(String(a.answer ?? '').trim()));

    row.append(q, ans);
    li.append(row);

    if (interactive) {
      row.classList.add('has-why');
      row.title = 'Show reasoning';

      const p = document.createElement('p');
      p.className = 'why';
      p.id = `why-${String(a.number ?? '').replace(/\W/g, '') || list.children.length}`;
      p.textContent = why;
      p.hidden = true;
      li.append(p);

      row.setAttribute('aria-expanded', 'false');
      row.setAttribute('aria-controls', p.id);
      row.addEventListener('click', () => {
        p.hidden = !p.hidden;
        row.setAttribute('aria-expanded', String(!p.hidden));
      });
    }

    list.append(li);
  }

  const meta = [];
  if (answers.length) meta.push(`${answers.length} answer${answers.length === 1 ? '' : 's'}`);
  if (job.meta?.missingChunks) {
    meta.push(`${job.meta.missingChunks} part${job.meta.missingChunks === 1 ? '' : 's'} failed`);
  }
  if (job.meta?.truncated) meta.push('page truncated');
  if (job.meta?.windowed) meta.push('partly loaded');
  if (job.meta?.unreadable) meta.push('has images');
  if (job.meta?.model) meta.push(job.meta.model);
  $('answers-meta').textContent = meta.join(' · ');

  // A partial run must say what went wrong, not just that something did - and it
  // must say it outside the list, which scrolls away past a few answers.
  const partial = job.meta?.partialError;
  const note = $('answers-partial');
  note.textContent = partial?.message ? [partial.message, partial.hint].filter(Boolean).join(' ') : '';
  note.hidden = !note.textContent;

  show('answers');
}

/** Origins the last error asked us to request, kept for the grant button. */
let pendingOrigins = [];

function renderError(job) {
  $('error-message').textContent = job.error?.message || 'Something went wrong.';
  const hint = $('error-hint');
  hint.textContent = job.error?.hint || '';
  hint.hidden = !job.error?.hint;

  pendingOrigins = job.error?.kind === 'frames' ? (job.error.origins || []) : [];
  const grant = $('grant');
  grant.hidden = pendingOrigins.length === 0;
  if (pendingOrigins.length) {
    const hosts = pendingOrigins.map((o) => { try { return new URL(o).host; } catch { return o; } });
    grant.textContent = hosts.length === 1 ? `Allow ${hosts[0]}` : `Allow ${hosts.length} sites`;
    if (hosts.length > 1) {
      hint.textContent = hosts.join(', ');
      hint.hidden = false;
    }
  }

  show('error');
}

function renderBusy(job) {
  const base = BUSY_LABELS[job.status] || 'Working…';
  const p = job.progress;
  $('busy-label').textContent = p && p.total > 1 ? `${base} (${p.done}/${p.total})` : base;
  show('busy');
}

function renderIdle(note) {
  const cta = $('get-answers');
  if (restartFirst) {
    cta.textContent = 'Restart to finish the update';
    $('idle-note').textContent = `Version ${restartFirst} is installed. After the restart, click the icon again to get answers.`;
  } else {
    cta.textContent = 'Get answers';
    $('idle-note').textContent = note || '';
  }
  cta.disabled = false;
  show('idle');
  cta.focus();
}

function render(job) {
  if (!settings.apiKey) return show('setup');
  if (!job || pageKey(job.url || '') !== pageKey(tab.url || '')) return renderIdle('');
  switch (job.status) {
    case 'reading':
    case 'thinking':
      return renderBusy(job);
    case 'done':
      return renderAnswers(job);
    case 'error':
      return renderError(job);
    default:
      return renderIdle('');
  }
}

/* ------------------------------------------------------------------ actions */

async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (e) {
    return { ok: false, error: { message: e?.message || 'Extension is not responding.' } };
  }
}

async function restart() {
  const res = await requestRestart();
  // On success this page closes with the restart, so only a refusal is left to show.
  if (res?.ok) return;
  const action = $('update-action');
  $('update-text').textContent = res?.busy ? 'Answers are still being worked on. Restart once they are done.'
    : res?.copying ? 'The new files are still being copied into the folder. Try again in a moment.'
      : res?.settingsOpen ? 'Close the Quiz Answers settings page first: restarting would close it, and anything not saved there.'
        : 'Could not restart just now. Try again in a moment.';
  // "Try again" is this same button, now and then.
  action.textContent = 'Restart to finish';
  action.onclick = restart;
  action.disabled = false;
  action.hidden = Boolean(res?.busy);
  $('update').hidden = false;
}

async function start(force) {
  $('get-answers').disabled = true;
  renderBusy({ status: 'reading' });
  const res = await send({ type: 'start', tabId: tab.id, force: !!force });
  if (res && res.ok === false) renderError({ error: res.error });
}

/** Free question count so the CTA can say what it is about to work on. */
async function previewCount() {
  const res = await send({ type: 'scan', tabId: tab.id });

  // The user may have pressed Get answers while this was in flight; whatever it
  // has to say is now stale. Or there is an update to finish first.
  if (panels.idle.hidden || restartFirst) return;

  if (!res?.ok) {
    if (res?.error?.message) renderError({ error: res.error });
    return;
  }

  const n = res.questionCount;
  renderIdle(n > 0
    ? `${n} question${n === 1 ? '' : 's'} detected`
    : 'No numbered questions detected — will try anyway.');
}

/* -------------------------------------------------------------------- wire */

$('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('error-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('get-answers').addEventListener('click', () => (restartFirst ? restart() : start(false)));
$('retry').addEventListener('click', () => start(true));

// Chrome only shows a permission prompt during a user gesture, so this has to
// happen on the click itself - not in the service worker.
$('grant').addEventListener('click', async () => {
  const origins = pendingOrigins.map((o) => `${o}/*`);
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins });
  } catch { /* treated as a refusal */ }
  if (granted) return start(true);
  $('error-hint').textContent = 'Without that permission the embedded questions stay unreadable.';
  $('error-hint').hidden = false;
});
$('rerun').addEventListener('click', () => start(true));
$('cancel').addEventListener('click', async () => {
  await send({ type: 'cancel', tabId: tab.id });
  // The busy panel is rendered optimistically on click, before the worker has
  // written anything, so there may be no storage change to bring us back.
  renderIdle('');
});

$('copy').addEventListener('click', async () => {
  const job = await currentJob();
  const text = formatAll(sortAnswers(job?.answers || []));
  try {
    await navigator.clipboard.writeText(text);
    const btn = $('copy');
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
  } catch {
    $('answers-meta').textContent = 'Copy failed';
  }
});

async function currentJob() {
  const key = jobKey(tab.id);
  const bag = await chrome.storage.session.get(key);
  return bag[key] || null;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !tab || !settings) return;
  const change = changes[jobKey(tab.id)];
  if (change) render(change.newValue || null);
});

/**
 * The line at the foot of the popup: either a newer version is out, or the
 * updater has already put one on disk and a restart will switch to it. Runs
 * beside the main render and never holds it up.
 */
async function renderUpdate() {
  const text = $('update-text');
  const action = $('update-action');
  action.hidden = false; // runUpdate hides it while it works

  const installed = await pendingRestart();
  if (installed) {
    let held = 1; // if it cannot be told, assume there is something to lose
    try { held = await answersHeld(); } catch { /* keep the assumption */ }
    if (!held) {
      // Nothing to lose: finishing the update becomes the main button.
      restartFirst = installed;
      text.textContent = `Version ${installed} is installed.`;
      action.textContent = 'Restart to finish';
      action.onclick = restart;
      if (!panels.idle.hidden) renderIdle('');
      else $('update').hidden = false;
      return;
    }
    const pages = held === 1 ? 'the page' : `the ${held} pages`;
    text.textContent = `Version ${installed} is installed. It switches over by itself once you close or leave ${pages} with answers.`;
    action.textContent = 'Restart now (clears answers)';
    action.onclick = restart;
    $('update').hidden = false;
    return;
  }

  const { available, latest } = await checkForUpdate();
  if (!available) return renderHelperHint();
  const helper = await helperStatus();
  if (helper === 'ready') {
    chrome.storage.local.remove('helperHint').catch(() => {});
    text.textContent = `Version ${latest} is out.`;
    action.textContent = 'Update now';
    action.onclick = () => runUpdate(latest);
  } else {
    // The double-click also sets up the helper, so this is the last time.
    text.textContent = withoutHelper(helper, latest);
    offerFolder();
  }
  $('update').hidden = false;
}

/**
 * Just updated from before the Update now button, by that old version's
 * updater, which cannot switch the button on: one more double-click does.
 * Said until the button works, while there is nothing newer to say instead.
 */
async function renderHelperHint() {
  const { helperHint } = await chrome.storage.local.get('helperHint');
  if (!helperHint) return;
  const helper = await helperStatus();
  if (helper === 'ready') return chrome.storage.local.remove('helperHint');
  if (helper !== 'missing') return;
  $('update-text').textContent = 'One more double-click on "Update Quiz Answers" in the extension\'s folder switches on the "Update now" button.';
  offerFolder();
  $('update').hidden = false;
}

/** The details page for an unpacked extension shows the folder it loads from. */
function offerFolder() {
  const action = $('update-action');
  action.textContent = 'Where is the folder?';
  action.onclick = () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
  action.disabled = false;
  action.hidden = false;
}

/** "Update now": the helper replaces the files, then the extension restarts onto them. */
async function runUpdate(latest) {
  const text = $('update-text');
  const action = $('update-action');
  // Out of the way while it works: a button that is still there looks like it still wants a click.
  action.hidden = true;
  text.textContent = `Updating to ${latest}… this takes a few seconds.`;

  const res = await updateNow();

  // New files on disk is what counts, not how the updater worded it: a run
  // that first repaired an interrupted one says that too.
  const installed = res?.ok ? await pendingRestart() : null;
  if (installed) {
    let held = 1;
    try { held = await answersHeld(); } catch { /* assume there is something to lose */ }
    if (!held) {
      // Nothing to lose by restarting, and the person asked for the update.
      text.textContent = `${res.summary || `Version ${installed} is installed.`} Restarting… click the icon again in a moment.`;
      action.textContent = 'Restart to finish';
      action.onclick = restart;
      await new Promise((r) => setTimeout(r, 1200));
      return restart();
    }
    return renderUpdate(); // explains that it switches over once those answers are closed
  }
  if (res?.ok) {
    text.textContent = res.summary || 'You already have the latest version.';
    return;
  }
  const why = res?.summary || res?.error?.message || 'The update did not work.';
  text.textContent = `${why} You can still update with a double-click on "Update Quiz Answers" in the extension's folder.`;
  offerFolder();
}

(async function init() {
  renderUpdate().catch(() => { /* an update hint is never worth an error */ });

  // Both at once: a progress write landing between two awaits would otherwise
  // reach the storage listener with one of them still unset.
  const [tabs, loaded] = await Promise.all([
    chrome.tabs.query({ active: true, currentWindow: true }),
    getSettings(),
  ]);
  [tab] = tabs;
  settings = loaded;

  if (!tab) return show('setup');
  if (!settings.apiKey) return show('setup');

  const job = await currentJob();
  render(job);

  // Only worth scanning when the user is looking at the CTA.
  if (!panels.idle.hidden) previewCount();
})();
