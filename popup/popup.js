import { formatAll, sortAnswers } from '../src/format.js';
import { getSettings, jobKey, pageKey } from '../src/storage.js';

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
  thinking: 'Asking OpenAI…',
};

let tab = null;
let settings = null;

function show(name) {
  for (const [key, el] of Object.entries(panels)) el.hidden = key !== name;
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

    const row = document.createElement('button');
    row.type = 'button';
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

    const why = (a.why || '').trim();
    if (why && settings.showWhy) {
      row.classList.add('has-why');
      row.title = 'Show reasoning';
      const p = document.createElement('p');
      p.className = 'why';
      p.textContent = why;
      p.hidden = true;
      li.append(p);
      row.addEventListener('click', () => { p.hidden = !p.hidden; });
    }

    list.append(li);
  }

  const meta = [];
  if (answers.length) meta.push(`${answers.length} answer${answers.length === 1 ? '' : 's'}`);
  if (job.meta?.model) meta.push(job.meta.model);
  if (job.meta?.truncated) meta.push('page truncated');
  $('answers-meta').textContent = meta.join(' · ');

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
    const hosts = pendingOrigins.map((o) => new URL(o).host).join(', ');
    grant.textContent = `Allow ${hosts}`;
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
  $('idle-note').textContent = note || '';
  $('get-answers').disabled = false;
  show('idle');
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

async function start(force) {
  $('get-answers').disabled = true;
  renderBusy({ status: 'reading' });
  const res = await send({ type: 'start', tabId: tab.id, force: !!force });
  if (res && res.ok === false) renderError({ error: res.error });
}

/** Free question count so the CTA can say what it is about to work on. */
async function previewCount() {
  const res = await send({ type: 'scan', tabId: tab.id });
  if (!res?.ok) {
    if (res?.error?.message) renderError({ error: res.error });
    return;
  }
  if (!panels.idle.hidden) {
    const n = res.questionCount;
    renderIdle(n > 0 ? `${n} question${n === 1 ? '' : 's'} detected` : 'No numbered questions detected — will try anyway.');
  }
}

/* -------------------------------------------------------------------- wire */

$('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('error-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('get-answers').addEventListener('click', () => start(false));
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
  if (area !== 'session' || !tab) return;
  const change = changes[jobKey(tab.id)];
  if (change) render(change.newValue || null);
});

(async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  settings = await getSettings();

  if (!tab) return show('setup');
  if (!settings.apiKey) return show('setup');

  const job = await currentJob();
  render(job);

  // Only worth scanning when the user is looking at the CTA.
  if (!panels.idle.hidden) previewCount();
})();
