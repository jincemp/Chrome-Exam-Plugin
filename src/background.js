/*
 * Service worker: owns the work, so a job survives the popup closing.
 *
 * The popup only ever sends a command and then watches chrome.storage.session
 * for the job record to change.
 */

import { answerQuestions, OpenAIError, TruncatedError } from './openai.js';
import { clearJob, getJob, getSettings, pageKey, setJob } from './storage.js';

const CHUNK_CHARS = 14000;   // roughly 3.5k tokens of page text per request
const MIN_CHUNK_CHARS = 900; // below this, splitting further cannot help
const MAX_PARALLEL = 3;

const IDLE_ICON = { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' };
const DONE_ICON = { 16: 'icons/icon-done16.png', 32: 'icons/icon-done32.png', 48: 'icons/icon-done48.png', 128: 'icons/icon-done128.png' };

/** tabId -> AbortController for the run in flight. */
const running = new Map();

/* ------------------------------------------------------------ tab chrome */

async function setBadge(tabId, { text = '', color = '#16a34a' } = {}) {
  try {
    await chrome.action.setBadgeText({ tabId, text });
    if (text) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color });
      if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' });
    }
  } catch { /* the tab went away */ }
}

/** Decoded icons, keyed by icon set. Decoding is the expensive part. */
const iconDataCache = new Map();

/**
 * Service workers have no DOM, and `path` support there has been patchy across
 * Chrome versions. Decode the PNGs ourselves as a fallback so the tick always
 * appears.
 */
async function toImageData(paths) {
  const key = Object.values(paths).join('|');
  if (!iconDataCache.has(key)) {
    const entries = await Promise.all(Object.entries(paths).map(async ([size, file]) => {
      const blob = await (await fetch(chrome.runtime.getURL(file))).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      return [size, ctx.getImageData(0, 0, canvas.width, canvas.height)];
    }));
    iconDataCache.set(key, Object.fromEntries(entries));
  }
  return iconDataCache.get(key);
}

// Chrome rejects the `path` form from a service worker (verified in tools/e2e.mjs),
// but that has changed across versions - try it once, then stop asking.
let iconPathWorks = true;

async function setIcon(tabId, done) {
  const path = done ? DONE_ICON : IDLE_ICON;
  if (iconPathWorks) {
    try {
      await chrome.action.setIcon({ tabId, path });
      return;
    } catch {
      iconPathWorks = false;
    }
  }
  try {
    await chrome.action.setIcon({ tabId, imageData: await toImageData(path) });
  } catch { /* the tab went away */ }
}

async function markReady(tabId, count) {
  await setIcon(tabId, true);
  await setBadge(tabId, { text: count ? String(count) : '✓' });
}

async function markIdle(tabId) {
  await setIcon(tabId, false);
  await setBadge(tabId, { text: '' });
}

async function markFailed(tabId) {
  await setIcon(tabId, false);
  await setBadge(tabId, { text: '!', color: '#b42318' });
}

/* -------------------------------------------------------------- page read */

/** Chrome refuses injection on these; say which one rather than guessing. */
async function describeUnsupported(url) {
  if (!url) return null;
  if (/^chrome:\/\//.test(url)) return 'Chrome blocks extensions on chrome:// pages.';
  if (/^(chrome-extension|devtools|view-source|about):/.test(url)) return 'Chrome blocks extensions on this kind of page.';
  if (/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/.test(url)) {
    return 'Chrome blocks extensions on the Chrome Web Store.';
  }
  if (/^file:\/\//.test(url)) {
    // The user can turn this on, and the README tells them how - so only refuse
    // when Chrome confirms it is off. An unknown answer defers to the injection.
    let allowed = true;
    try {
      allowed = await chrome.extension.isAllowedFileSchemeAccess();
    } catch { /* API unavailable: let executeScript speak for itself */ }
    return allowed ? null : 'Local files need "Allow access to file URLs" on this extension\'s card in chrome://extensions.';
  }
  if (/\.pdf(\?|#|$)/i.test(url)) return 'PDFs are rendered by Chrome\'s own viewer, which extensions cannot read.';
  return null;
}

const UNSUPPORTED_HINT =
  'Chrome blocks extensions on this page. Try it on a normal http(s) page.';

/** Runs extract.js in every frame and stitches the frames together. */
async function readPage(tabId) {
  try {
    const hint = await describeUnsupported((await chrome.tabs.get(tabId))?.url);
    if (hint) throw new OpenAIError('Cannot read this page.', { kind: 'page', hint });
  } catch (err) {
    if (err instanceof OpenAIError) throw err; // tabs.get failing is not fatal
  }

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['src/extract.js'],
    });
  } catch (err) {
    // allFrames fails outright on some pages; the top frame alone may still work.
    try {
      results = await chrome.scripting.executeScript({ target: { tabId }, files: ['src/extract.js'] });
    } catch {
      throw new OpenAIError('Cannot read this page.', { kind: 'page', hint: UNSUPPORTED_HINT });
    }
    void err;
  }

  // The top frame may have no text of its own (a shell around an iframe), in
  // which case it is not among the readable frames - but it is still the frame
  // whose sub-frame list and title we want.
  const allResults = results.map((r) => r?.result).filter(Boolean);
  const topFrame = allResults.find((r) => r.isTop);
  const frames = allResults.filter((r) => r.ok && (r.text || r.selection));

  // Frames from another origin are silently skipped by allFrames injection,
  // because activeTab covers only the page the user is actually on.
  const blocked = (topFrame?.frameOrigins || []).filter(
    (origin) => !frames.some((f) => f.url?.startsWith(origin)),
  );

  const embeddedQuiz = () => new OpenAIError('The questions are inside an embedded frame.', {
    kind: 'frames',
    hint: 'Chrome needs your permission to read it.',
    origins: blocked,
  });

  if (!frames.length) {
    // A page that is nothing but a wrapper around someone else's quiz.
    if (blocked.length) throw embeddedQuiz();
    throw new OpenAIError('No readable text on this page.', {
      kind: 'page',
      hint: 'The questions may be inside an image, a PDF viewer, or a canvas.',
    });
  }

  const top = frames.find((f) => f.isTop) || frames[0];

  // A deliberate selection beats everything else on the page.
  if (top.selection) {
    return {
      url: (topFrame || top).url,
      title: (topFrame || top).title || top.title,
      text: top.selection,
      hints: top.hints || '',
      questionCount: top.questionCount,
      truncated: false,
      fromSelection: true,
    };
  }

  const others = frames
    .filter((f) => f !== top && f.text && f.text.length > 200)
    .sort((a, b) => b.text.length - a.text.length)
    .slice(0, 4);

  const text = [top.text, ...others.map((f) => f.text)].filter(Boolean).join('\n\n');
  const questionCount = Math.max(top.questionCount, ...others.map((f) => f.questionCount), 0);

  // Reached nothing and there is an embedded frame from another origin? That is
  // where the quiz lives, and activeTab does not cover it.
  // A page with real content and a stray ad frame is not this case; a page that
  // is little more than a wrapper around someone else's quiz is.
  if (questionCount === 0 && text.length < 1500 && blocked.length) throw embeddedQuiz();

  return {
    url: (topFrame || top).url,
    title: (topFrame || top).title || top.title,
    text,
    hints: top.hints || '',
    questionCount,
    truncated: frames.some((f) => f.truncated),
    windowed: frames.some((f) => f.windowed),
    unreadable: Math.max(...frames.map((f) => f.unreadable || 0), 0),
    fromSelection: false,
  };
}

/* --------------------------------------------------------------- chunking */

// Either "1. What is ...?" or a bare "Question 1" heading, which is how Moodle,
// Canvas and most LMS themes label them.
const QUESTION_START_RE = /^\s*(?:(?:q(?:uestion)?\s*[.:#-]?\s*)?\d{1,3}\s*[.):\]]\s+\S|q(?:uestion)?\s*[.:#-]?\s*\d{1,3}\s*[.):\]]?\s*$)/i;

/** Split long pages on question boundaries so no question loses its options. */
export function chunkText(text, maxChars = CHUNK_CHARS) {
  if (text.length <= maxChars) return [text];

  const lines = text.split('\n');
  const breakpoints = [];
  for (let i = 0; i < lines.length; i++) {
    if (QUESTION_START_RE.test(lines[i])) breakpoints.push(i);
  }
  // No numbering to key off - fall back to blank lines, then to raw slicing.
  const boundaries = breakpoints.length > 1
    ? new Set(breakpoints)
    : new Set(lines.map((l, i) => (l.trim() === '' ? i + 1 : -1)).filter((i) => i > 0));

  const chunks = [];
  let current = [];
  let size = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (size + line.length > maxChars && current.length && boundaries.has(i)) {
      chunks.push(current.join('\n'));
      current = [];
      size = 0;
    } else if (size + line.length > maxChars * 1.6 && current.length) {
      chunks.push(current.join('\n')); // hard stop: no boundary showed up in time
      current = [];
      size = 0;
    }
    if (line.length > maxChars) {
      // One unbroken line longer than the whole budget: split it mid-line.
      for (let at = 0; at < line.length; at += maxChars) {
        if (current.length) { chunks.push(current.join('\n')); current = []; size = 0; }
        chunks.push(line.slice(at, at + maxChars));
      }
      continue;
    }

    current.push(line);
    size += line.length + 1;
  }
  if (current.length) chunks.push(current.join('\n'));

  return chunks.filter((c) => c.trim());
}

/* ------------------------------------------------------------------- merge */

const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };

/**
 * Chunks never overlap, so two chunks reporting the same question number means
 * one of two things: a question straddled the boundary and was answered twice,
 * or the page carries no numbering and each chunk numbered itself from 1. The
 * second case is the dangerous one - keying on the number alone would throw
 * away most of a long unnumbered quiz - so answers are keyed per chunk and
 * renumbered end to end when the numbering turns out to be per-chunk.
 */
export function mergeAnswers(groups) {
  const byKey = new Map();

  groups.forEach((group, part) => {
    for (const answer of group || []) {
      const entry = { ...answer, part };
      const key = `${part}|${answer.number}`;
      const existing = byKey.get(key);
      if (!existing) { byKey.set(key, entry); continue; }

      const better = CONFIDENCE_RANK[entry.confidence] - CONFIDENCE_RANK[existing.confidence];
      if (better > 0 || (better === 0 && entry.answer.length > existing.answer.length)) {
        byKey.set(key, entry);
      }
    }
  });

  const answers = [...byKey.values()];
  const parts = new Set(answers.map((a) => a.part));
  if (parts.size < 2) return answers.map(({ part, ...a }) => a);

  // A question straddling a boundary repeats one number per boundary. Numbering
  // that restarted per chunk repeats many. Count the overlaps to tell them apart.
  const partsPerNumber = new Map();
  for (const a of answers) {
    if (!partsPerNumber.has(a.number)) partsPerNumber.set(a.number, new Set());
    partsPerNumber.get(a.number).add(a.part);
  }
  const overlaps = [...partsPerNumber.values()].filter((where) => where.size > 1).length;
  const restarts = overlaps > parts.size - 1;

  if (!restarts) {
    // Real page numbering: a repeat within one part is a straddled question.
    return dedupeByNumber(answers);
  }

  return answers
    .sort((x, y) => x.part - y.part || numericOrder(x.number, y.number))
    .map(({ part, ...a }, i) => ({ ...a, number: String(i + 1) }));
}

const numericOrder = (a, b) => {
  const n = (v) => { const m = /^(\d+)/.exec(String(v)); return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER; };
  return n(a) - n(b) || String(a).localeCompare(String(b));
};

function dedupeByNumber(answers) {
  const byNumber = new Map();
  for (const { part, ...answer } of answers) {
    void part;
    const existing = byNumber.get(answer.number);
    if (!existing || CONFIDENCE_RANK[answer.confidence] > CONFIDENCE_RANK[existing.confidence]) {
      byNumber.set(answer.number, answer);
    }
  }
  return [...byNumber.values()];
}

/* --------------------------------------------------------------- the work */

/** Runs one chunk, halving it if the model runs out of room mid-answer. */
async function runChunk(settings, page, chunk, part, parts, signal, depth = 0) {
  const promptInput = {
    title: page.title,
    url: page.url,
    text: chunk,
    hints: part === 1 ? page.hints : '',
    questionCount: page.questionCount,
    part,
    parts,
    extraInstructions: settings.extraInstructions,
  };

  try {
    const { questions } = await answerQuestions(settings, promptInput, signal);
    return questions;
  } catch (err) {
    if (!(err instanceof TruncatedError) || depth >= 2 || chunk.length < MIN_CHUNK_CHARS) throw err;
    const halves = chunkText(chunk, Math.floor(chunk.length / 2));
    if (halves.length < 2) throw err;
    const results = [];
    for (const half of halves) {
      results.push(await runChunk(settings, page, half, part, parts, signal, depth + 1));
    }
    return results.flat();
  }
}

async function runJob(tabId) {
  const controller = new AbortController();
  running.get(tabId)?.abort();
  running.set(tabId, controller);
  startKeepAlive();

  // A re-run replaces us in `running`. From that moment the newer run owns this
  // tab's job record and badge, and we must not touch either on our way out.
  const isCurrent = () => running.get(tabId) === controller;
  const update = (patch) => (isCurrent() ? setJob(tabId, { tabId, ...patch }) : Promise.resolve());

  try {
    const settings = await getSettings();
    await markIdle(tabId);

    // Record the URL up front: the popup matches a job to the tab it is looking
    // at, and would treat a job with no URL as stale.
    let tabUrl = '';
    try {
      tabUrl = (await chrome.tabs.get(tabId))?.url || '';
    } catch { /* tab closed mid-click */ }
    await update({ status: 'reading', url: tabUrl, startedAt: Date.now() });

    const page = await readPage(tabId);
    if (controller.signal.aborted) return;

    const chunks = chunkText(page.text);
    await update({
      status: 'thinking',
      url: tabUrl || page.url,
      startedAt: Date.now(),
      progress: { done: 0, total: chunks.length },
    });

    const groups = new Array(chunks.length);
    let done = 0;
    let cursor = 0;

    const worker = async () => {
      while (cursor < chunks.length) {
        const index = cursor++;
        groups[index] = await runChunk(settings, page, chunks[index], index + 1, chunks.length, controller.signal);
        done++;
        if (!controller.signal.aborted) {
          await update({
            status: 'thinking',
            url: tabUrl || page.url,
            progress: { done, total: chunks.length },
          });
        }
      }
    };

    const outcomes = await Promise.allSettled(
      Array.from({ length: Math.min(MAX_PARALLEL, chunks.length) }, worker),
    );
    if (controller.signal.aborted) return;

    // Workers fail independently, so some chunks may have come back. Report what
    // we have and say what is missing; only give up when nothing survived.
    const failure = outcomes.find((o) => o.status === 'rejected');
    const finished = groups.filter(Boolean);
    if (failure && !finished.length) throw failure.reason;

    const answers = mergeAnswers(groups);
    await update({
      status: 'done',
      url: tabUrl || page.url,
      answers,
      meta: {
        model: settings.model,
        chunks: chunks.length,
        missingChunks: chunks.length - finished.length,
        partialError: failure ? { message: failure.reason?.message || 'Part of the page failed.', hint: failure.reason?.hint || '' } : null,
        truncated: page.truncated,
        windowed: page.windowed,
        unreadable: page.unreadable,
        fromSelection: page.fromSelection,
      },
    });
    if (isCurrent()) await markReady(tabId, answers.length);
  } catch (err) {
    if (!isCurrent()) return; // a newer run owns this tab now
    if (err?.name === 'AbortError' || controller.signal.aborted) {
      await clearJob(tabId);
      await markIdle(tabId);
      return;
    }
    const error = err instanceof OpenAIError
      ? { message: err.message, hint: err.hint, kind: err.kind, origins: err.origins || [] }
      : { message: err?.message || 'Something went wrong.', hint: '' };
    let url = '';
    try {
      url = (await chrome.tabs.get(tabId))?.url || '';
    } catch { /* tab closed */ }
    await update({ status: 'error', url, error });
    await markFailed(tabId);
  } finally {
    stopKeepAlive();
    if (running.get(tabId) === controller) running.delete(tabId);
  }
}

/* ---------------------------------------------------------------- keepalive */

// Cheap insurance: extension API traffic resets the worker's idle timer, so a
// slow model cannot strand a job half-finished.
let keepAliveTimer = null;
let keepAliveCount = 0;

function startKeepAlive() {
  keepAliveCount++;
  if (!keepAliveTimer) {
    keepAliveTimer = setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); }, 20000);
  }
}

function stopKeepAlive() {
  keepAliveCount = Math.max(0, keepAliveCount - 1);
  if (keepAliveCount === 0 && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

/* ---------------------------------------------------------------- messages */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      if (!Number.isInteger(message?.tabId)) {
        sendResponse({ ok: false, error: { message: 'Missing tab.' } });
        return;
      }

      if (message.type === 'scan') {
        const page = await readPage(message.tabId);
        sendResponse({ ok: true, questionCount: page.questionCount, fromSelection: page.fromSelection });
        return;
      }

      if (message.type === 'start') {
        const settings = await getSettings();
        if (!settings.apiKey) {
          sendResponse({ ok: false, error: { message: 'No API key yet.', hint: 'Add one in settings.' } });
          return;
        }
        if (running.has(message.tabId) && !message.force) {
          sendResponse({ ok: true, alreadyRunning: true });
          return;
        }
        runJob(message.tabId).catch(() => { /* runJob records its own failures */ });
        sendResponse({ ok: true });
        return;
      }

      if (message.type === 'cancel') {
        running.get(message.tabId)?.abort();
        running.delete(message.tabId);
        await clearJob(message.tabId);
        await markIdle(message.tabId);
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: { message: `Unknown command: ${message.type}` } });
    } catch (err) {
      sendResponse({
        ok: false,
        error: {
          message: err?.message || 'Unexpected error.',
          hint: err?.hint || '',
          kind: err?.kind || '',
          origins: err?.origins || [],
        },
      });
    }
  })();
  return true; // keeps the response channel open for the async work above
});

/* ------------------------------------------------------------ tab lifecycle */

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  // A URL change, or a reload that reports only a status change.
  if (!changeInfo.url && changeInfo.status !== 'loading') return;

  const job = await getJob(tabId);
  if (!job && !running.has(tabId)) return;

  // Same document, different anchor: the questions have not changed.
  if (changeInfo.url && job && pageKey(job.url) === pageKey(changeInfo.url)) return;

  // A bare 'loading' tick is a same-URL reload. The document we read no longer
  // exists, so a run against it must not publish its answers as current.
  running.get(tabId)?.abort();
  running.delete(tabId);
  await clearJob(tabId);
  await markIdle(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  running.get(tabId)?.abort();
  running.delete(tabId);
  clearJob(tabId);
});

// A fresh worker has no per-tab icon state, and session storage may still hold
// finished jobs from before it was torn down. Put the badges back.
chrome.runtime.onStartup.addListener(() => restoreBadges());
chrome.runtime.onInstalled.addListener(() => restoreBadges());

async function restoreBadges() {
  try {
    const all = await chrome.storage.session.get(null);
    for (const [key, job] of Object.entries(all)) {
      if (!key.startsWith('job:')) continue;
      const tabId = Number(key.slice(4));
      if (job?.status === 'done') await markReady(tabId, job.answers?.length || 0);
    }
  } catch { /* nothing to restore */ }
}
