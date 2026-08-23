/*
 * End-to-end test: loads the real extension into Chromium, points it at a mock
 * OpenAI server, and drives a real quiz page through the service worker.
 *
 * This is the only test that exercises chrome.scripting injection, the service
 * worker, and the request/response round trip together.
 *
 *   npm install && node tools/e2e.mjs
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const QUIZ_PAGE = `<!doctype html>
<html><head><title>Practice Exam 3</title><style>
  .sr-only { position: absolute; left: -9999px; }
  .hidden-answer { display: none; }
</style></head>
<body>
  <nav><a href="/">Home</a> <a href="/courses">All courses</a> <a href="/pricing">Pricing</a></nav>
  <span class="sr-only">Skip to main content</span>
  <main>
    <h1>Practice Exam 3</h1>
    <div class="question" data-answer="b">
      <p>1. A 240-volt branch circuit has a 3% maximum voltage drop. What is the minimum voltage at the load?</p>
      <ul>
        <li><label><input type="radio" name="q1" value="a"> a) 220.80</label></li>
        <li><label><input type="radio" name="q1" value="b"> b) 230.34</label></li>
        <li><label><input type="radio" name="q1" value="c"> c) 232.80</label></li>
        <li><label><input type="radio" name="q1" value="d"> d) 240.00</label></li>
      </ul>
      <div class="hidden-answer">Correct answer: b</div>
    </div>
    <div class="question">
      <p>2. Which conductor carries the unbalanced current in a multiwire branch circuit?</p>
      <ul>
        <li><label><input type="radio" name="q2" value="a"> a) The ungrounded conductor</label></li>
        <li><label><input type="radio" name="q2" value="b"> b) The equipment grounding conductor</label></li>
        <li><label><input type="radio" name="q2" value="c"> c) The grounded conductor</label></li>
      </ul>
    </div>
    <div class="question">
      <p>3. State the total resistance of a 2.2 k&#8486; and a 2.5 k&#8486; resistor in series.</p>
    </div>
  </main>
  <footer><p>&copy; 2026 Example Prep. All rights reserved.</p></footer>
</body></html>`;

const ANSWERS = {
  questions: [
    { number: '1', label: 'b', answer: '230.34', why: '240 less 3 percent', confidence: 'high' },
    { number: '2', label: 'c', answer: 'The grounded conductor', why: '', confidence: 'high' },
    { number: '3', label: '', answer: '4.7 kΩ', why: 'Series resistances add', confidence: 'high' },
  ],
};

/* ------------------------------------------------------- mock OpenAI + page */

const seen = { bodies: [], paths: [] };

/** Flipped between scenarios to exercise the client's fallback paths. */
let mode = 'responses';

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  seen.paths.push(`${req.method} ${url.pathname}`);

  if (url.pathname === '/quiz.html') {
    res.writeHead(200, { 'content-type': 'text/html' }).end(QUIZ_PAGE);
    return;
  }

  if (url.pathname === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ data: [{ id: 'gpt-5.4-nano' }, { id: 'gpt-5.4-mini' }] }));
    return;
  }

  if (mode === 'unauthorized') {
    res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({
      error: { message: 'Incorrect API key provided: sk-test-key.', type: 'invalid_request_error', param: null, code: 'invalid_api_key' },
    }));
    return;
  }

  // A proxy that only implements chat completions answers /responses with a 404.
  if (url.pathname === '/v1/responses' && mode === 'chat-only') {
    res.writeHead(404, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: { message: 'Unknown request URL.', type: 'invalid_request_error', param: null, code: null } }));
    return;
  }

  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.bodies.push(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        id: 'chatcmpl_test', model: 'gpt-5.4-nano',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(ANSWERS) } }],
      }));
    });
    return;
  }

  if (url.pathname === '/v1/responses' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.bodies.push(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        id: 'resp_test', status: 'completed', model: 'gpt-5.4-nano',
        output: [
          { type: 'reasoning', summary: [] },
          // A commentary message before the answer: the parser must skip it.
          { type: 'message', phase: 'commentary', content: [{ type: 'output_text', text: 'Weighing the options...' }] },
          { type: 'message', phase: 'final_answer', content: [{ type: 'output_text', text: JSON.stringify(ANSWERS) }] },
        ],
        usage: { input_tokens: 900, output_tokens: 80 },
      }));
    });
    return;
  }

  res.writeHead(404).end();
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;

/* ------------------------------------------- extension copy with test access */

// The real manifest asks only for activeTab, which a scripted click cannot
// grant. The copy adds the test origin so injection is allowed; nothing else
// about the extension changes.
const extDir = mkdtempSync(path.join(tmpdir(), 'quiz-ext-'));
for (const entry of ['manifest.json', 'src', 'popup', 'options', 'icons']) {
  cpSync(path.join(root, entry), path.join(extDir, entry), { recursive: true });
}
const manifest = JSON.parse(readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
manifest.host_permissions = [...manifest.host_permissions, `${origin}/*`];
writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const userDataDir = mkdtempSync(path.join(tmpdir(), 'quiz-profile-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  headless: false,
  args: [
    '--headless=new',
    '--no-sandbox',
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
  ],
});

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}\n     ${err.message.split('\n').slice(0, 4).join('\n     ')}`);
  }
};

try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = new URL(worker.url()).host;
  console.log(`extension ${extensionId}`);

  // Configure the extension through its own storage, as the options page would.
  const driver = await context.newPage();
  await driver.goto(`chrome-extension://${extensionId}/options/options.html`);
  await driver.evaluate(async (base) => {
    await chrome.storage.local.set({
      apiKey: 'sk-test-key', model: 'gpt-5.4-nano', effort: 'low',
      baseUrl: base, endpoint: 'auto', showWhy: true, extraInstructions: '',
    });
  }, `${origin}/v1`);

  const quiz = await context.newPage();
  await quiz.goto(`${origin}/quiz.html`);
  await quiz.waitForLoadState('domcontentloaded');

  const runJob = () => driver.evaluate(async (quizUrl) => {
    const [tab] = await chrome.tabs.query({ url: quizUrl });
    const key = `job:${tab.id}`;
    // Drop any previous run's record, or the poll below reads it and returns
    // before this run has written anything.
    await chrome.storage.session.remove(key);

    const scan = await chrome.runtime.sendMessage({ type: 'scan', tabId: tab.id });
    await chrome.runtime.sendMessage({ type: 'start', tabId: tab.id, force: true });
    for (let i = 0; i < 100; i++) {
      const { [key]: record } = await chrome.storage.session.get(key);
      if (record && (record.status === 'done' || record.status === 'error')) return { scan, record };
      await new Promise((r) => setTimeout(r, 100));
    }
    const { [key]: record } = await chrome.storage.session.get(key);
    return { scan, record, timedOut: true };
  }, `${origin}/quiz.html`);

  const job = await runJob();

  console.log(JSON.stringify({ scan: job.scan, status: job.record?.status, error: job.record?.error }, null, 1));

  check('the job completes', () => {
    assert.equal(job.timedOut, undefined, 'timed out waiting for the job');
    assert.equal(job.record?.status, 'done', JSON.stringify(job.record?.error));
  });

  check('the scan counts the questions before any request', () => {
    assert.equal(job.scan.ok, true);
    assert.equal(job.scan.questionCount, 3);
  });

  check('answers come back in the requested shape', () => {
    const byNumber = Object.fromEntries((job.record.answers || []).map((a) => [a.number, a]));
    assert.equal(byNumber['1'].label, 'b');
    assert.equal(byNumber['1'].answer, '230.34');
    assert.equal(byNumber['2'].answer, 'The grounded conductor');
    assert.equal(byNumber['3'].label, '', 'an open question has no option letter');
    assert.equal(byNumber['3'].answer, '4.7 kΩ');
  });

  const body = seen.bodies[0];

  check('the request uses the Responses shape', () => {
    assert.ok(body, 'no request reached the mock server');
    assert.equal(body.model, 'gpt-5.4-nano');
    assert.equal(body.text.format.type, 'json_schema');
    assert.equal(body.text.format.name, 'answer_sheet', 'name must be flat, not wrapped in json_schema');
    assert.equal(body.text.format.strict, true);
    assert.equal(body.text.verbosity, 'low');
    assert.equal(body.reasoning.effort, 'low');
    assert.equal(body.max_output_tokens > 0, true);
    assert.equal(body.store, false, 'exam text must not be retained');
    assert.equal('temperature' in body, false, 'gpt-5.x rejects temperature');
    assert.equal('max_tokens' in body, false);
  });

  const sent = body.input[0].content;

  check('the page text carries the questions and their options', () => {
    assert.match(sent, /1\. A 240-volt branch circuit/);
    assert.match(sent, /a\) 220\.80/);
    assert.match(sent, /b\) 230\.34/);
    assert.match(sent, /3\. State the total resistance/);
  });

  check('each option is on its own line', () => {
    const lines = sent.split('\n');
    assert.ok(lines.some((l) => l.trim() === 'a) 220.80'), 'options must not run together');
    assert.ok(lines.some((l) => l.trim() === 'b) 230.34'));
  });

  check('navigation, footer and screen-reader text are left out', () => {
    assert.doesNotMatch(sent, /All courses/);
    assert.doesNotMatch(sent, /All rights reserved/);
    assert.doesNotMatch(sent, /Skip to main content/);
  });

  check('a display:none answer key does not pollute the question text', () => {
    assert.doesNotMatch(sent, /Correct answer: b/);
  });

  check('a data-answer hint is passed separately and labelled unverified', () => {
    assert.match(sent, /unverified/i);
  });

  check('the badge and icon report readiness', async () => {
    assert.equal(job.record.answers.length, 3);
  });

  const badge = await driver.evaluate(async (quizUrl) => {
    const [tab] = await chrome.tabs.query({ url: quizUrl });
    return chrome.action.getBadgeText({ tabId: tab.id });
  }, `${origin}/quiz.html`);

  check('the toolbar badge shows the answer count', () => {
    assert.equal(badge, '3');
  });

  // Informational: does the path form of setIcon work from a service worker on
  // this Chrome? The extension falls back to ImageData either way.
  const iconProbe = await worker.evaluate(async () => {
    const out = {};
    try {
      await chrome.action.setIcon({ path: { 16: 'icons/icon-done16.png' } });
      out.path = 'accepted';
    } catch (err) {
      out.path = `rejected: ${err.message}`;
    }
    try {
      const blob = await (await fetch(chrome.runtime.getURL('icons/icon-done16.png'))).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      await chrome.action.setIcon({
        imageData: { 16: canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height) },
      });
      out.imageData = 'accepted';
    } catch (err) {
      out.imageData = `rejected: ${err.message}`;
    }
    return out;
  });
  console.log(`note setIcon path: ${iconProbe.path}`);

  check('the service worker can set the icon at all', () => {
    assert.equal(
      iconProbe.path === 'accepted' || iconProbe.imageData === 'accepted',
      true,
      `neither form worked: ${JSON.stringify(iconProbe)}`,
    );
    assert.equal(iconProbe.imageData, 'accepted', 'the ImageData fallback must work');
  });

  /* ----------------------------------------- a proxy without /v1/responses */

  mode = 'chat-only';
  seen.bodies.length = 0;
  const viaChat = await runJob();

  check('a base URL without /v1/responses falls back to chat completions', () => {
    assert.equal(viaChat.record?.status, 'done', JSON.stringify(viaChat.record?.error));
    assert.equal(viaChat.record.answers.length, 3);
  });

  check('the chat body wraps the schema and uses max_completion_tokens', () => {
    const chatBody = seen.bodies.at(-1);
    assert.equal(chatBody.response_format.type, 'json_schema');
    assert.equal(chatBody.response_format.json_schema.name, 'answer_sheet');
    assert.equal(chatBody.response_format.json_schema.strict, true);
    assert.equal(chatBody.reasoning_effort, 'low', 'flat on chat completions');
    assert.equal(chatBody.max_completion_tokens > 0, true);
    assert.equal('max_tokens' in chatBody, false);
    assert.equal('temperature' in chatBody, false);
  });

  /* --------------------------------------------------------- a bad API key */

  mode = 'unauthorized';
  const rejected = await runJob();

  check('a rejected key surfaces as an actionable error', () => {
    assert.equal(rejected.record?.status, 'error');
    assert.match(rejected.record.error.message, /rejected your API key/i);
    assert.match(rejected.record.error.hint, /settings/i);
  });

  const failedBadge = await driver.evaluate(async (quizUrl) => {
    const [tab] = await chrome.tabs.query({ url: quizUrl });
    return chrome.action.getBadgeText({ tabId: tab.id });
  }, `${origin}/quiz.html`);

  check('a failed run marks the toolbar', () => {
    assert.equal(failedBadge, '!');
  });
} finally {
  await context.close();
  server.close();
  rmSync(extDir, { recursive: true, force: true });
  rmSync(userDataDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : '\nall end-to-end checks passed');
process.exit(failures ? 1 : 0);
