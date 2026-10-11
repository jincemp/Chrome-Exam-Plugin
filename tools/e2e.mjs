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
import { cpSync, mkdtempSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
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

/**
 * Long enough to force a split. Chunks are 40k characters; 100 of these
 * questions extract to ~49k, which is over that and still comfortably under
 * the 60k the extractor truncates at, so nothing is lost on the way in.
 */
const LONG_QUESTION_COUNT = 100;
const LONG_PAGE = `<!doctype html><html><head><title>Question bank</title></head><body><main>
${Array.from({ length: LONG_QUESTION_COUNT }, (_, i) => {
  const n = i + 1;
  return `<div class="question"><p>${n}. Considering an installation governed by the applicable code, and given the conditions described in the preceding paragraph, which of the following statements about scenario ${n} is correct?</p>
    <ul>
      <li><label><input type="radio" name="q${n}"> a) The first alternative for scenario ${n}, which is a long distractor.</label></li>
      <li><label><input type="radio" name="q${n}"> b) The second alternative for scenario ${n}, which is also a long distractor.</label></li>
      <li><label><input type="radio" name="q${n}"> c) The third alternative for scenario ${n}, longer still to pad the page out.</label></li>
      <li><label><input type="radio" name="q${n}"> d) The fourth alternative for scenario ${n}, padding the page out further.</label></li>
    </ul></div>`;
}).join('\n')}
</main></body></html>`;

const ANSWERS = {
  questions: [
    { number: '1', label: 'b', answer: '230.34', why: '240 less 3 percent', confidence: 'high' },
    { number: '2', label: 'c', answer: 'The grounded conductor', why: '', confidence: 'high' },
    { number: '3', label: '', answer: '4.7 kΩ', why: 'Series resistances add', confidence: 'high' },
  ],
};

/** Matches tools/fixtures/image-questions.html: image-only, image+text (raster and
 *  svg), and a text-only baseline in between. */
const IMAGE_ANSWERS = {
  questions: [
    { number: '1', label: 'b', answer: '2.4 A', why: '', confidence: 'high' },
    { number: '2', label: 'b', answer: '10', why: '', confidence: 'high' },
    { number: '3', label: 'b', answer: '4', why: '', confidence: 'high' },
    { number: '4', label: 'b', answer: 'Rectangle', why: '', confidence: 'high' },
  ],
};

/**
 * The shaky first pass and the correction that should follow it. Q1 comes back
 * low-confidence and wrong; the verification pass is expected to fix it. Q2 is
 * high-confidence and must not be re-asked about at all.
 */
const SHAKY_ANSWERS = {
  questions: [
    { number: '1', label: 'a', answer: '220.80', why: 'not sure of the drop', confidence: 'low' },
    { number: '2', label: 'c', answer: 'The grounded conductor', why: '', confidence: 'high' },
    { number: '3', label: '', answer: '4.7 kΩ', why: 'Series resistances add', confidence: 'high' },
  ],
};

const CORRECTED_ANSWERS = {
  questions: [
    { number: '1', label: 'b', answer: '230.34', why: '240 x 0.97 = 232.8, nearest printed option is 230.34', confidence: 'high' },
  ],
};

/* ------------------------------------------------------- mock OpenAI + page */

const seen = { bodies: [], paths: [], updateChecks: [] };

/** The version the mock "GitHub" says is published. Defaults to this build: no update. */
let published = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')).version;

/** Flipped between scenarios to exercise the client's fallback paths. */
let mode = 'responses';

let port = 0;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  seen.paths.push(`${req.method} ${url.pathname}`);

  if (url.pathname === '/quiz.html') {
    res.writeHead(200, { 'content-type': 'text/html' }).end(QUIZ_PAGE);
    return;
  }

  if (url.pathname === '/long.html') {
    res.writeHead(200, { 'content-type': 'text/html' }).end(LONG_PAGE);
    return;
  }

  // Served on 127.0.0.1 but framing localhost - a different origin, and one the
  // extension has no permission for, exactly like a real embedded quiz.
  // A real Moodle quiz review page, saved verbatim from the LMS that broke it.
  if (url.pathname === '/moodle.html') {
    res.writeHead(200, { 'content-type': 'text/html' })
      .end(readFileSync(path.join(root, 'tools/fixtures/moodle-quiz-review.html')));
    return;
  }

  if (url.pathname === '/images.html') {
    res.writeHead(200, { 'content-type': 'text/html' })
      .end(readFileSync(path.join(root, 'tools/fixtures/image-questions.html')));
    return;
  }

  if (url.pathname === '/wrapper.html') {
    res.writeHead(200, { 'content-type': 'text/html' }).end(
      `<!doctype html><html><head><title>Course</title></head><body><main>
        <h1>Module 4</h1>
        <iframe src="http://localhost:${port}/quiz.html" width="800" height="600"></iframe>
      </main></body></html>`,
    );
    return;
  }

  // Stands in for raw.githubusercontent.com. Served with the same CORS header
  // GitHub sends, and fetched via localhost - an origin this test extension is
  // NOT granted - so the update check passing here means it needs no permission.
  if (url.pathname === '/update/manifest.json') {
    seen.updateChecks.push(req.headers.origin || '');
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' })
      .end(JSON.stringify({ name: 'Quiz Answers', version: published }));
    return;
  }

  if (url.pathname === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ data: [{ id: 'gpt-5.6-luna' }, { id: 'gpt-5.6-sol' }] }));
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
        id: 'chatcmpl_test', model: 'gpt-5.6-luna',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(ANSWERS) } }],
      }));
    });
    return;
  }

  if (url.pathname === '/v1/responses' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      seen.bodies.push(body);

      const content = body.input[0].content;
      const hasImages = Array.isArray(content) && content.some((p) => p.type === 'input_image');

      // Simulates a model/gateway that rejects image content outright, so the
      // client's caps.images fallback (retry as text) gets a real exercise.
      if (mode === 'no-vision' && hasImages) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({
          error: { message: 'This model does not support image inputs.', type: 'invalid_request_error', param: null, code: null },
        }));
        return;
      }

      // In chunked mode, answer exactly the questions this chunk contains, so
      // the merge is tested against what was really sent.
      // The verification pass is recognisable by the draft block the client
      // appends; answering it with the same shaky sheet would prove nothing.
      const isVerify = String(JSON.stringify(content)).includes('DRAFT ANSWERS TO CHECK');

      let answers = ANSWERS;
      if (mode === 'verify') {
        answers = isVerify ? CORRECTED_ANSWERS : SHAKY_ANSWERS;
      } else if (mode === 'many') {
        const numbers = [...content.matchAll(/^(\d+)\. Considering/gm)].map((m) => m[1]);
        answers = { questions: numbers.map((n) => ({ number: n, label: 'c', answer: `The third alternative for scenario ${n}, longer still to pad the page out.`, why: '', confidence: 'high' })) };
      } else if (mode === 'images' || mode === 'no-vision') {
        answers = IMAGE_ANSWERS;
      }

      const reply = () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        id: 'resp_test', status: 'completed', model: 'gpt-5.6-luna',
        output: [
          { type: 'reasoning', summary: [] },
          // A commentary message before the answer: the parser must skip it.
          { type: 'message', phase: 'commentary', content: [{ type: 'output_text', text: 'Weighing the options...' }] },
          { type: 'message', phase: 'final_answer', content: [{ type: 'output_text', text: JSON.stringify(answers) }] },
        ],
        usage: { input_tokens: 900, output_tokens: 80 },
      }));
      // A model that takes a while, so a job can be caught mid-run.
      if (mode === 'slow') setTimeout(reply, 3000);
      else reply();
    });
    return;
  }

  res.writeHead(404).end();
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
port = server.address().port;
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

// Ask the mock, not the real GitHub, whether there is an update.
const updateJs = path.join(extDir, 'src', 'update.js');
const realUpdateUrl = 'https://raw.githubusercontent.com/jincemp/Chrome-Exam-Plugin/main/manifest.json';
assert.ok(readFileSync(updateJs, 'utf8').includes(realUpdateUrl), 'src/update.js no longer has the URL this test rewrites');
writeFileSync(updateJs, readFileSync(updateJs, 'utf8').replace(realUpdateUrl, `http://localhost:${port}/update/manifest.json`));

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
/** Synchronous on purpose: an async body would outlive the page it asserts on. */
const check = (name, fn) => {
  try {
    const result = fn();
    if (result instanceof Promise) throw new Error('check() bodies must be synchronous');
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
      apiKey: 'sk-test-key', model: 'gpt-5.6-luna', effort: 'medium',
      baseUrl: base, endpoint: 'auto', showWhy: true, extraInstructions: '',
    });
  }, `${origin}/v1`);

  const quiz = await context.newPage();
  await quiz.goto(`${origin}/quiz.html`);
  await quiz.waitForLoadState('domcontentloaded');

  const runJobOn = (page, target = `${origin}/quiz.html`) => page.evaluate(async (quizUrl) => {
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
  }, target);
  const runJob = (target) => runJobOn(driver, target);

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
    assert.equal(body.model, 'gpt-5.6-luna');
    assert.equal(body.text.format.type, 'json_schema');
    assert.equal(body.text.format.name, 'answer_sheet', 'name must be flat, not wrapped in json_schema');
    assert.equal(body.text.format.strict, true);
    assert.equal(body.text.verbosity, 'medium', "'low' was trimming the working the model shows");
    assert.equal(body.reasoning.effort, 'medium');
    assert.equal(body.max_output_tokens > 0, true);
    assert.equal(body.store, false, 'exam text must not be retained');
    assert.equal('temperature' in body, false, 'gpt-5.x rejects temperature');
    assert.equal('max_tokens' in body, false);
  });

  const sent = body.input[0].content;
  const pageText = sent.split('--- PAGE TEXT ---')[1].split('--- POSSIBLE')[0];

  check('the page text carries the questions and their options', () => {
    assert.match(pageText, /1\. A 240-volt branch circuit/);
    assert.match(pageText, /a\) 220\.80/);
    assert.match(pageText, /b\) 230\.34/);
    assert.match(pageText, /3\. State the total resistance/);
  });

  check('each option is on its own line', () => {
    const lines = pageText.split('\n');
    assert.ok(lines.some((l) => l.trim() === 'a) 220.80'), 'options must not run together');
    assert.ok(lines.some((l) => l.trim() === 'b) 230.34'));
  });

  check('navigation, footer and screen-reader text are left out', () => {
    assert.doesNotMatch(pageText, /All courses/);
    assert.doesNotMatch(pageText, /All rights reserved/);
    assert.doesNotMatch(pageText, /Skip to main content/);
  });

  check('a display:none answer key stays out of the page text', () => {
    // It is allowed in the labelled hints section below - just not here, where
    // it would read as part of the question.
    assert.doesNotMatch(pageText, /Correct answer: b/);
  });

  check('a data-answer hint is passed separately and labelled unverified', () => {
    assert.match(sent, /unverified/i);
    assert.doesNotMatch(pageText, /unverified/i);
  });

  check('hints name the question they answer', () => {
    const hints = sent.split('unverified) ---')[1] || '';
    assert.match(hints, /Q1 -> b/, `hints were: ${hints.trim().slice(0, 200)}`);
  });

  check("a display:none answer panel is collected as a hint, not as page text", () => {
    const hints = sent.split('unverified) ---')[1] || '';
    assert.match(hints, /Correct answer: b/, `hints were: ${hints.trim().slice(0, 200)}`);
  });

  check('the run produced one answer per question', () => {
    assert.equal(job.record.answers.length, 3);
  });

  const badge = await driver.evaluate(async (quizUrl) => {
    const [tab] = await chrome.tabs.query({ url: quizUrl });
    return {
      text: await chrome.action.getBadgeText({ tabId: tab.id }),
      colour: await chrome.action.getBadgeBackgroundColor({ tabId: tab.id }),
    };
  }, `${origin}/quiz.html`);

  check('the toolbar badge shows the answer count', () => {
    assert.equal(badge.text, '3');
  });

  check('a normal run leaves the toolbar grey, not coloured', () => {
    // The icon is grey line art; a bright pill next to it puts the colour
    // straight back. Failures are the exception - see the error badge below.
    const [r, g, b] = badge.colour;
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) < 25, `the ready badge is tinted: rgb(${r}, ${g}, ${b})`);
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

  // The icons are grey line art on nothing. There is no colour left to tell the
  // two states apart, so what has to hold instead is: the ink stays neutral,
  // stays mid-grey (one value has to survive both a white and a dark toolbar),
  // the background stays transparent, and the two shapes still differ.
  const iconInk = await worker.evaluate(async () => {
    const measure = async (file) => {
      const blob = await (await fetch(chrome.runtime.getURL(file))).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let r = 0, g = 0, b = 0, inked = 0;
      const alpha = new Uint8Array(data.length / 4);
      for (let i = 0; i < data.length; i += 4) {
        alpha[i / 4] = data[i + 3];
        if (data[i + 3] < 200) continue;       // the transparent background
        r += data[i]; g += data[i + 1]; b += data[i + 2]; inked++;
      }
      return { r: r / inked, g: g / inked, b: b / inked, inked, pixels: alpha.length, alpha };
    };

    const idle = await measure('icons/icon48.png');
    const done = await measure('icons/icon-done48.png');
    let differing = 0;
    for (let i = 0; i < idle.alpha.length; i++) {
      if (Math.abs(idle.alpha[i] - done.alpha[i]) > 128) differing++;
    }
    delete idle.alpha;
    delete done.alpha;
    return { idle, done, differing };
  });

  const bothIcons = Object.entries({ idle: iconInk.idle, done: iconInk.done });

  check('both icons are neutral grey, not tinted', () => {
    for (const [name, ink] of bothIcons) {
      const spread = Math.max(ink.r, ink.g, ink.b) - Math.min(ink.r, ink.g, ink.b);
      assert.ok(spread < 25, `${name} icon is tinted rather than grey: ${JSON.stringify(ink)}`);
    }
  });

  check('the ink is mid grey, so it shows up on a light and a dark toolbar', () => {
    // Chrome does not re-tint extension icons per theme, so one value has to do
    // both. Near-black vanishes on dark, near-white vanishes on light.
    for (const [name, ink] of bothIcons) {
      assert.ok(ink.g > 90 && ink.g < 190, `${name} ink would disappear on one theme: ${JSON.stringify(ink)}`);
    }
  });

  check('the icons are line art on a transparent background, not a filled card', () => {
    for (const [name, ink] of bothIcons) {
      const covered = ink.inked / ink.pixels;
      assert.ok(covered > 0.04, `${name} icon is nearly blank: ${(covered * 100).toFixed(1)}% inked`);
      assert.ok(covered < 0.5, `${name} icon fills its canvas - the background is back: ${(covered * 100).toFixed(1)}% inked`);
    }
  });

  check('the two states still look different, now that colour no longer says so', () => {
    const share = iconInk.differing / iconInk.idle.pixels;
    assert.ok(share > 0.08, `idle and ready icons are nearly identical: ${(share * 100).toFixed(1)}% of pixels differ`);
  });

  check('the service worker can set the icon at all', () => {
    assert.equal(
      iconProbe.path === 'accepted' || iconProbe.imageData === 'accepted',
      true,
      `neither form worked: ${JSON.stringify(iconProbe)}`,
    );
    assert.equal(iconProbe.imageData, 'accepted', 'the ImageData fallback must work');
  });

  /* ------------------------------------------------------- the popup itself */

  const quizTabId = await driver.evaluate(async (quizUrl) => {
    const [tab] = await chrome.tabs.query({ url: quizUrl });
    await chrome.storage.session.remove(`job:${tab.id}`);
    return tab.id;
  }, `${origin}/quiz.html`);

  const popup = await context.newPage();
  // A popup normally opens over the active tab. Opened as a page it is its own
  // tab, so point its "active tab" lookup at the quiz. Everything else - the
  // messaging, the storage subscription, the rendering - is the real thing.
  await popup.addInitScript((tabId) => {
    const real = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (info) => (info.active ? [await chrome.tabs.get(tabId)] : real(info));
  }, quizTabId);
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);

  await popup.waitForSelector('#panel-idle:not([hidden])', { timeout: 10000 });

  const idleNote = await popup.textContent('#idle-note');
  check('the call to action says how many questions it found', () => {
    assert.match(idleNote || '', /3 questions detected/);
  });

  await popup.click('#get-answers');
  await popup.waitForSelector('#panel-answers:not([hidden])', { timeout: 20000 });

  const rows = await popup.$$eval('#answers .row', (els) => els.map(
    (e) => [...e.children].map((c) => c.textContent.replace(/\s+/g, ' ').trim()).join(' '),
  ));

  check('the popup renders the answers in the asked-for shape', () => {
    assert.equal(rows.length, 3);
    assert.equal(rows[0], 'Q1: b) 230.34');
    assert.equal(rows[1], 'Q2: c) The grounded conductor');
    assert.equal(rows[2], 'Q3: 4.7 kΩ');
  });

  check('a question with no options shows no option letter', () => {
    assert.doesNotMatch(rows[2], /\)/);
  });

  const reopened = await context.newPage();
  await reopened.addInitScript((tabId) => {
    const real = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (info) => (info.active ? [await chrome.tabs.get(tabId)] : real(info));
  }, quizTabId);
  await reopened.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await reopened.waitForSelector('#panel-answers:not([hidden])', { timeout: 10000 });

  const requestsBefore = seen.bodies.length;
  const again = await reopened.$$eval('#answers .row', (els) => els.length);

  check('reopening the popup shows the answers again without asking OpenAI', () => {
    assert.equal(again, 3);
    assert.equal(seen.bodies.length, requestsBefore, 'a cached answer sheet must not cost another request');
  });

  await popup.close();
  await reopened.close();

  /* ------------------------------------------------ a page too long for one request */

  mode = 'many';
  seen.bodies.length = 0;
  const long = await context.newPage();
  await long.goto(`${origin}/long.html`);
  await long.waitForLoadState('domcontentloaded');
  const chunked = await runJob(`${origin}/long.html`);

  check('a long page is split across several requests', () => {
    assert.equal(chunked.record?.status, 'done', JSON.stringify(chunked.record?.error));
    assert.ok(seen.bodies.length > 1, `expected more than one request, got ${seen.bodies.length}`);
  });

  check('no question is lost or duplicated across the split', () => {
    const numbers = (chunked.record.answers || []).map((a) => Number(a.number)).sort((x, y) => x - y);
    assert.equal(new Set(numbers).size, numbers.length, 'answers must be deduplicated');
    assert.deepEqual(numbers, Array.from({ length: LONG_QUESTION_COUNT }, (_, i) => i + 1));
  });

  check('no chunk starts mid-question', () => {
    for (const body of seen.bodies) {
      const first = body.input[0].content.split('--- PAGE TEXT ---')[1].trim().split('\n')[0];
      assert.match(first, /^\d+\. Considering/, `chunk began with: ${first.slice(0, 80)}`);
    }
  });

  check('each chunk is told which part it is', () => {
    assert.match(seen.bodies[0].input[0].content, /part 1 of \d+/);
  });

  await long.close();

  /* -------------------------------------------------- a real Moodle quiz page */

  mode = 'responses';
  seen.bodies.length = 0;
  const moodle = await context.newPage();
  await moodle.goto(`${origin}/moodle.html`);
  await moodle.waitForLoadState('domcontentloaded');
  const moodleRun = await runJob(`${origin}/moodle.html`);
  const moodleSent = seen.bodies[0]?.input?.[0]?.content || '';
  const moodleText = moodleSent.split('--- PAGE TEXT ---')[1]?.split('--- POSSIBLE')[0] || '';

  check('a Moodle quiz page is read, and its questions counted correctly', () => {
    assert.equal(moodleRun.record?.status, 'done', JSON.stringify(moodleRun.record?.error));
    assert.equal(moodleRun.scan.questionCount, 3, 'the page numbers its own questions; trust that');
  });

  check('Moodle question stems and options survive', () => {
    assert.match(moodleText, /Categorise factors affecting urban water demand/);
    assert.match(moodleText, /what percentage range typically represents water system leakage/);
    assert.match(moodleText, /Leakage of 10-40% is typical/);
    assert.match(moodleText, /Calculate the maximum daily consumption/);
  });

  check('a chosen option keeps its marker instead of being stranded', () => {
    // The wording lives in a sibling block, which used to push "[selected]" onto
    // a line of its own where it referred to nothing.
    assert.match(moodleText, /\[selected\] Leakage of 10-40%/);
  });

  check("Moodle's screen-reader-only text is left out", () => {
    // class="accesshide", clipped to a 1px box - invisible to a reader, and pure
    // noise in the prompt.
    assert.doesNotMatch(moodleText, /Question text/);
    assert.doesNotMatch(moodleText, /Answer 1 Question 1/);
  });

  check('the page furniture around the quiz is left out', () => {
    assert.doesNotMatch(moodleText, /Sustainability for Engineers/, 'the course list in the nav drawer');
    assert.doesNotMatch(moodleText, /No private conversations/, 'the hidden message drawer');
    assert.doesNotMatch(moodleText, /CRICOS Provider/, 'the footer');
  });

  await moodle.close();

  /* ------------------------------------------------- a page with diagrams */

  mode = 'images';
  seen.bodies.length = 0;
  const images = await context.newPage();
  await images.goto(`${origin}/images.html`);
  await images.waitForLoadState('domcontentloaded');
  // The Q2 raster image is filled in by an inline script after parsing; make
  // sure it has actually decoded before asking the extension to capture it.
  await images.waitForFunction(() => {
    const img = document.getElementById('graph');
    return !!img && img.complete && img.naturalWidth > 0;
  });
  const imagesRun = await runJob(`${origin}/images.html`);

  check('a page mixing image-only, image+text and text-only questions is read', () => {
    assert.equal(imagesRun.record?.status, 'done', JSON.stringify(imagesRun.record?.error));
    assert.equal(imagesRun.scan.questionCount, 4);
  });

  const imagesContent = seen.bodies[0]?.input?.[0]?.content;

  check('the request sends the diagrams as real image content, not just text', () => {
    assert.ok(Array.isArray(imagesContent), 'expected interleaved text/image parts');
    const imageParts = imagesContent.filter((p) => p.type === 'input_image');
    assert.equal(imageParts.length, 3, 'canvas, img and svg diagrams should all be captured; the tiny decorative icon should not be');
    for (const part of imageParts) {
      assert.equal(part.detail, 'high');
      assert.match(part.image_url, /^data:image\/png;base64,/, 'same-origin canvas/img/svg capture should rasterize to a data URL');
    }
  });

  check('images stay interleaved with the question text around them, not bundled separately', () => {
    const texts = imagesContent.filter((p) => p.type === 'input_text').map((p) => p.text).join('\n---\n');
    assert.match(texts, /Question 1/, 'text before the image-only question');
    assert.match(texts, /peak value/, 'text around the image+text question');
    assert.match(texts, /2 \+ 2/, 'the text-only question in between');
    assert.match(texts, /shape is drawn below/, 'text around the svg question');
  });

  check('the answer key covers all four questions, including the image-only one', () => {
    const byNumber = Object.fromEntries((imagesRun.record.answers || []).map((a) => [a.number, a]));
    assert.equal(byNumber['1'].answer, '2.4 A', 'the image-only question must still get answered');
    assert.equal(byNumber['2'].answer, '10');
    assert.equal(byNumber['3'].answer, '4');
    assert.equal(byNumber['4'].answer, 'Rectangle');
  });

  await images.close();

  /* ------------------------------------ a model that rejects image input */

  mode = 'no-vision';
  seen.bodies.length = 0;
  const noVision = await context.newPage();
  await noVision.goto(`${origin}/images.html`);
  await noVision.waitForLoadState('domcontentloaded');
  await noVision.waitForFunction(() => {
    const img = document.getElementById('graph');
    return !!img && img.complete && img.naturalWidth > 0;
  });
  const noVisionRun = await runJob(`${origin}/images.html`);

  check('a model without vision still answers, by retrying as text', () => {
    assert.equal(noVisionRun.record?.status, 'done', JSON.stringify(noVisionRun.record?.error));
    assert.equal(seen.bodies.length, 2, 'the first attempt with images should be rejected, then retried as text');
  });

  check('the retried request drops images instead of leaking raw tokens', () => {
    const retried = seen.bodies.at(-1).input[0].content;
    assert.equal(typeof retried, 'string', 'once images are off the request goes back to the plain-text shape');
    assert.doesNotMatch(retried, /\[\[IMG/, 'the model must never see the internal token syntax');
    assert.match(retried, /\[image omitted\]/);
  });

  check('the fallback answer sheet still covers the image-only question', () => {
    const byNumber = Object.fromEntries((noVisionRun.record.answers || []).map((a) => [a.number, a]));
    assert.ok(byNumber['1'], 'question 1 must not be dropped just because its image could not be sent');
  });

  await noVision.close();

  /* ------------------------------- a shaky answer gets a second opinion */

  mode = 'verify';
  seen.bodies.length = 0;
  const shaky = await runJob();

  check('an answer the model was unsure about is sent back for checking', () => {
    assert.equal(shaky.record?.status, 'done', JSON.stringify(shaky.record?.error));
    assert.equal(seen.bodies.length, 2, 'expected the first pass plus one verification pass');
  });

  check('only the unsure question is re-asked, not the confident ones', () => {
    const drafts = JSON.stringify(seen.bodies[1].input[0].content);
    assert.match(drafts, /DRAFT ANSWERS TO CHECK/);
    assert.match(drafts, /Q1:/, 'the low-confidence question must be in the draft');
    assert.doesNotMatch(drafts, /Q2:/, 'a high-confidence answer must not cost a second request');
    assert.doesNotMatch(drafts, /Q3:/);
  });

  check('the verification pass tells the model to re-derive, not to agree', () => {
    const sent = JSON.stringify(seen.bodies[1]);
    assert.match(sent, /SECOND PASS/);
    assert.match(sent, /from scratch/);
  });

  check('the corrected answer replaces the shaky one, and the rest survive', () => {
    const byNumber = Object.fromEntries((shaky.record.answers || []).map((a) => [a.number, a]));
    assert.equal(byNumber['1'].answer, '230.34', 'the second pass should have corrected Q1');
    assert.equal(byNumber['1'].label, 'b');
    assert.equal(byNumber['1'].confidence, 'high');
    assert.equal(byNumber['2'].answer, 'The grounded conductor', 'untouched answers must carry through');
    assert.equal(byNumber['3'].answer, '4.7 k\u03A9');
    assert.equal(shaky.record.answers.length, 3, 'no question gained or lost');
  });

  /* ------------------------------------ a quiz embedded from another origin */

  mode = 'responses';
  seen.bodies.length = 0;
  const wrapper = await context.newPage();
  await wrapper.goto(`${origin}/wrapper.html`);
  await wrapper.waitForLoadState('domcontentloaded');
  const embedded = await runJob(`${origin}/wrapper.html`);

  check('a page wrapping a cross-origin quiz asks for that site, not "no text"', () => {
    assert.equal(embedded.record?.status, 'error');
    assert.equal(embedded.record.error.kind, 'frames', JSON.stringify(embedded.record.error));
    assert.deepEqual(embedded.record.error.origins, [`http://localhost:${port}`]);
    assert.equal(seen.bodies.length, 0, 'nothing should have been sent to OpenAI');
  });

  await wrapper.close();

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
    assert.equal(chatBody.reasoning_effort, 'medium', 'flat on chat completions');
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
    return {
      text: await chrome.action.getBadgeText({ tabId: tab.id }),
      colour: await chrome.action.getBadgeBackgroundColor({ tabId: tab.id }),
    };
  }, `${origin}/quiz.html`);

  check('a failed run marks the toolbar', () => {
    assert.equal(failedBadge.text, '!');
  });

  check('even a failure stays grey - nothing the extension shows is coloured', () => {
    const [r, g, b] = failedBadge.colour;
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) < 25, `the error badge is tinted: rgb(${r}, ${g}, ${b})`);
  });

  /* ----------------------------------------- the settings page tells you what it is */

  const optionsPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extensionId}/options/options.html`);
  await optionsPage.waitForFunction(() => document.getElementById('version').textContent !== '—', { timeout: 10000 });
  const shown = await optionsPage.evaluate(() => ({
    version: document.getElementById('version').textContent,
    model: document.getElementById('active-model').textContent,
    manifest: chrome.runtime.getManifest().version,
  }));
  await optionsPage.close();

  check('settings shows the loaded version, so a failed update is visible', () => {
    assert.equal(shown.version, shown.manifest);
    assert.match(shown.version, /^\d+\.\d+\.\d+$/);
    assert.notEqual(shown.version, '—');
  });

  check('settings shows which model is actually in use', () => {
    assert.equal(shown.model, 'gpt-5.6-luna');
  });

  /* ------------------------------------------------ choosing a different model */

  const chooser = await context.newPage();
  await chooser.goto(`chrome-extension://${extensionId}/options/options.html`);
  await chooser.waitForFunction(() => document.getElementById('model').options.length > 1, { timeout: 10000 });

  const options = await chooser.$$eval('#model option', (els) => els.map((e) => e.value));

  check('the model list offers more than the one already selected', () => {
    // A datalist filters its suggestions against the typed value, so a
    // pre-filled box only ever offered the current model back.
    assert.ok(options.length > 2, `only offered: ${options.join(', ')}`);
    assert.ok(options.includes('gpt-5.6-luna'), 'the account list must not drop the current model');
    assert.equal(options.at(-1), '__custom__', 'a custom id must stay reachable');
  });

  const selected = await chooser.$eval('#model', (el) => el.value);
  check('the stored model is the one selected on open', () => {
    assert.equal(selected, 'gpt-5.6-luna');
  });

  // Pick a different one and save it the way a person would.
  await chooser.selectOption('#model', 'gpt-5.6-sol');
  await chooser.click('#save');
  await chooser.waitForFunction(() => document.getElementById('status').textContent.includes('Saved'), { timeout: 5000 });
  const afterPick = await chooser.evaluate(() => chrome.storage.local.get('model'));

  check('picking a model from the list saves it', () => {
    assert.equal(afterPick.model, 'gpt-5.6-sol');
  });

  // And the free-text escape hatch for a proxy's own model id.
  await chooser.selectOption('#model', '__custom__');
  await chooser.fill('#model-custom', 'my-proxy/llama-70b');
  await chooser.click('#save');
  await chooser.waitForTimeout(300);
  const afterCustom = await chooser.evaluate(() => chrome.storage.local.get('model'));

  check('a custom model id can still be typed in', () => {
    assert.equal(afterCustom.model, 'my-proxy/llama-70b');
  });

  await chooser.reload();
  await chooser.waitForFunction(() => document.getElementById('model').options.length > 1, { timeout: 10000 });
  const keptCustom = await chooser.evaluate(() => ({
    value: document.getElementById('model').value,
    custom: document.getElementById('model-custom').value,
  }));

  check('a custom model survives reopening the settings page', () => {
    assert.equal(keptCustom.value, 'my-proxy/llama-70b', 'it should be listed, not lost');
  });

  // Put it back so the later scenarios start from a known state.
  await chooser.evaluate(() => chrome.storage.local.set({ model: 'gpt-5.6-luna', effort: 'medium' }));
  await chooser.close();

  /* ------------------------------- upgrading an install that predates a default */

  // By now the client has learned this base URL from the chat-only scenario and
  // may still be using it, so read the effort from whichever shape it sent.
  const effortSent = (body) => body.reasoning?.effort ?? body.reasoning_effort;

  mode = 'responses';
  seen.bodies.length = 0;

  // Exactly what an install from before the default changed looks like: the old
  // model and effort stored, and no settingsVersion at all.
  await driver.evaluate(async (base) => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      apiKey: 'sk-test-key', model: 'gpt-5.4-nano', effort: 'low',
      baseUrl: base, endpoint: 'auto', showWhy: true, extraInstructions: '',
    });
  }, `${origin}/v1`);

  const upgraded = await runJob();

  check('an existing install picks up the new default instead of silently keeping the old one', () => {
    assert.equal(upgraded.record?.status, 'done', JSON.stringify(upgraded.record?.error));
    const body = seen.bodies.at(-1);
    assert.equal(body.model, 'gpt-5.6-luna', 'stored settings must not pin the retired default');
    assert.equal(effortSent(body), 'high', 'and it should land on the current default effort, not the old one');
  });

  const persisted = await driver.evaluate(() => chrome.storage.local.get(null));

  check('the upgrade is written once, so a later deliberate choice sticks', () => {
    assert.equal(persisted.model, 'gpt-5.6-luna');
    assert.equal(persisted.settingsVersion, 2);
    assert.equal(persisted.apiKey, 'sk-test-key', 'migrating must not disturb the key');
  });

  // A model the user actually chose must survive the same path.
  await driver.evaluate(async () => {
    await chrome.storage.local.set({ model: 'gpt-5.6-sol', effort: 'high' });
  });
  seen.bodies.length = 0;
  const chosen = await runJob();

  check('a model the user chose is left alone', () => {
    assert.equal(chosen.record?.status, 'done', JSON.stringify(chosen.record?.error));
    assert.equal(seen.bodies.at(-1).model, 'gpt-5.6-sol');
    assert.equal(effortSent(seen.bodies.at(-1)), 'high');
  });

  /* --------------------------------------------- hearing about an update */

  const openPopupFor = async (tabId) => {
    const page = await context.newPage();
    await page.addInitScript((id) => {
      const real = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = async (info) => (info.active ? [await chrome.tabs.get(id)] : real(info));
    }, tabId);
    await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    return page;
  };

  published = '99.0.0';
  seen.updateChecks.length = 0;
  await driver.evaluate(() => chrome.storage.local.remove('updateCheck'));
  const upPopup = await openPopupFor(quizTabId);
  await upPopup.waitForSelector('#update:not([hidden])', { timeout: 10000 });
  const updateLine = await upPopup.textContent('#update');
  const granted = await driver.evaluate(() => chrome.permissions.getAll());

  check('the popup says when a newer version is published', () => {
    assert.match(updateLine, /Version 99\.0\.0 is out/);
    assert.match(updateLine, /Update Quiz Answers/, 'it must say what to double-click');
  });

  check('checking for updates needs no new permission', () => {
    assert.equal(seen.updateChecks.length, 1, 'the popup should have asked once');
    assert.match(seen.updateChecks[0], /^chrome-extension:\/\//, 'and from the extension itself');
    assert.ok(!granted.origins.some((o) => o.includes('localhost')), `localhost was granted: ${granted.origins}`);
  });

  const [folderTab] = await Promise.all([
    context.waitForEvent('page', { timeout: 10000 }),
    upPopup.click('#update-action'),
  ]);
  await folderTab.waitForLoadState('domcontentloaded').catch(() => {});

  check('"Where is the folder?" opens this extension\'s details page, which shows the path', () => {
    assert.equal(folderTab.url(), `chrome://extensions/?id=${extensionId}`);
  });

  await folderTab.close();
  await upPopup.close();

  /* ------------------------------- picking up files the updater replaced */

  // A real "Load unpacked" install always has Developer mode on - it is how
  // the extension got there. This harness loads it with --load-extension, where
  // Developer mode starts off and a self-reload would disable the extension
  // instead (see src/update.js). Turn it on, as the user already has.
  const devPage = await context.newPage();
  await devPage.goto('chrome://extensions');
  await devPage.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));

  // What "Update Quiz Answers" leaves behind: new files in the same folder.
  const onDisk = JSON.parse(readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
  const installUpdate = (version) => {
    onDisk.version = version;
    writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(onDisk, null, 2));
    published = version;
  };

  // The new worker's chrome.* bindings can lag its creation by a moment.
  const evaluateIn = async (target, fn, arg) => {
    for (let i = 0; i < 50; i++) {
      try { return await target.evaluate(fn, arg); } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    return null;
  };

  // 1. Nothing to lose. Earlier checks left answers on the quiz tab; clear them.
  await driver.evaluate((id) => chrome.runtime.sendMessage({ type: 'cancel', tabId: id }), quizTabId);
  installUpdate('99.0.1');

  const restartPopup = await openPopupFor(quizTabId);
  await restartPopup.waitForFunction(() => /Restart/.test(document.getElementById('get-answers').textContent), null, { timeout: 10000 }).catch(() => {});
  const restartCta = await restartPopup.textContent('#get-answers');
  const restartNote = await restartPopup.textContent('#idle-note');

  check('once new files are in the folder and nothing would be lost, finishing the update is the main button', () => {
    assert.match(restartCta, /Restart to finish the update/);
    assert.match(restartNote, /Version 99\.0\.1 is installed/);
  });

  const nextWorker = context.waitForEvent('serviceworker', { timeout: 20000 });
  await restartPopup.click('#get-answers').catch(() => { /* the click closes the popup under itself */ });
  const reborn = await nextWorker.catch(() => null);
  const after = reborn ? await evaluateIn(reborn, async () => ({
    version: chrome.runtime.getManifest().version,
    apiKey: (await chrome.storage.local.get('apiKey')).apiKey,
    id: chrome.runtime.id,
  })) : null;

  check('that button brings the extension back on the new version', () => {
    assert.ok(reborn, 'no new service worker appeared after the restart');
    assert.equal(after?.version, '99.0.1');
  });

  check('the saved API key survives the restart - same folder, same extension', () => {
    assert.equal(after?.id, extensionId, 'the extension identity must not change');
    assert.equal(after?.apiKey, 'sk-test-key');
  });

  // Polled by hand: waitForFunction does not wait for an async predicate - the
  // promise it returns is truthy, so it would never wait at all.
  const waitForJob = async (page, id, status, ms) => {
    for (let t = 0; t < ms; t += 100) {
      const got = await page.evaluate(async (tabId) => (await chrome.storage.session.get(`job:${tabId}`))[`job:${tabId}`]?.status, id);
      if (got === status) return got;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  };

  // 2. Answers on an open tab. The restart closed every extension page, the
  // driver included; this one is closed again before the automatic path is
  // tested, because an open extension page holds a restart back by itself.
  const driver2 = await context.newPage();
  await driver2.goto(`chrome-extension://${extensionId}/options/options.html`);

  mode = 'slow';
  await driver2.evaluate((id) => chrome.runtime.sendMessage({ type: 'start', tabId: id, force: true }), quizTabId);
  const midRun = await waitForJob(driver2, quizTabId, 'thinking', 10000);
  const refused = await driver2.evaluate(() => chrome.runtime.sendMessage({ type: 'restart' }));

  check('a restart asked for while answers are being worked on is refused, not paid for twice', () => {
    assert.equal(midRun, 'thinking', 'the job was not caught mid-run');
    assert.equal(refused?.busy, true, JSON.stringify(refused));
  });

  const finished = await waitForJob(driver2, quizTabId, 'done', 15000);
  mode = 'responses';
  installUpdate('99.0.2');

  const heldPopup = await openPopupFor(quizTabId);
  await heldPopup.waitForSelector('#update:not([hidden])', { timeout: 10000 }).catch(() => {});
  const heldLine = await heldPopup.textContent('#update');
  await heldPopup.close();
  await driver2.close();
  // Closing an extension page is itself a moment the worker checks for an
  // update. Give a restart there time to happen, if one wrongly would, before
  // stopping the worker - which would otherwise swallow it.
  await new Promise((r) => setTimeout(r, 1500));

  check('with answers on a tab, the popup says restarting would clear them', () => {
    assert.equal(finished, 'done', 'the slow job never finished');
    assert.match(heldLine, /Version 99\.0\.2 is installed/);
    assert.match(heldLine, /once you close or leave the page with answers/);
    assert.match(heldLine, /Restart now \(clears answers\)/);
  });

  // Now the automatic path: stop the worker the way Chrome does when it goes
  // idle, and let a page load in some other tab wake it.
  const cdp = await context.newCDPSession(devPage);
  const stopWorker = async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(extensionId));
    if (sw) await cdp.send('Target.closeTarget', { targetId: sw.targetId }).catch(() => {});
    return !!sw;
  };
  // A worker that was really stopped and started again has lost this mark;
  // that is the only proof the start-up check ran again.
  const extWorker = () => context.serviceWorkers().filter((w) => w.url().includes(extensionId)).at(-1);
  await evaluateIn(extWorker(), () => { globalThis.__e2eSeenBefore = true; });
  const stopped = await stopWorker();
  const elsewhere = await context.newPage();
  await elsewhere.goto(`${origin}/long.html`).catch(() => {});
  let kept = null;
  for (let i = 0; i < 50 && !kept?.fresh; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      kept = await extWorker()?.evaluate(async (id) => ({
        fresh: !globalThis.__e2eSeenBefore,
        version: chrome.runtime.getManifest().version,
        status: (await chrome.storage.session.get(`job:${id}`))[`job:${id}`]?.status || null,
        badge: await chrome.action.getBadgeText({ tabId: id }),
      }), quizTabId);
    } catch { /* between workers */ }
  }
  await new Promise((r) => setTimeout(r, 2000)); // time enough to restart, if it were going to
  try {
    kept = { ...kept, ...await extWorker()?.evaluate(async (id) => ({
      version: chrome.runtime.getManifest().version,
      status: (await chrome.storage.session.get(`job:${id}`))[`job:${id}`]?.status || null,
      badge: await chrome.action.getBadgeText({ tabId: id }),
    }), quizTabId) };
  } catch { kept = { ...kept, version: 'restarting' }; }

  check('the automatic restart never throws away answers still on an open tab', () => {
    assert.ok(stopped && kept?.fresh, `the worker was not stopped and started again: ${JSON.stringify({ stopped, kept })}`);
    assert.equal(kept.status, 'done', `the answer sheet is gone: ${JSON.stringify(kept)}`);
    assert.ok(kept.badge, 'the answer count badge is gone');
    assert.equal(kept.version, '99.0.1', 'it restarted with answers still held');
  });

  // 3. ...and it lands by itself the moment that page is left.
  let quiet = extWorker() || null;
  await quiz.reload().catch(() => {});
  let quietVersion = null;
  for (let i = 0; i < 75 && quiet; i++) {
    try {
      quietVersion = await quiet.evaluate(() => chrome.runtime.getManifest().version);
      if (quietVersion === '99.0.2') break;
    } catch { /* this worker is going away under the restart */ }
    const latestWorker = context.serviceWorkers().filter((w) => w.url().includes(extensionId)).at(-1);
    if (latestWorker && latestWorker !== quiet) quiet = latestWorker;
    await new Promise((r) => setTimeout(r, 200));
  }

  check('once the page with answers is left, it switches over by itself', () => {
    assert.equal(quietVersion, '99.0.2', 'the extension did not pick up the new files on its own');
  });

  await elsewhere.close();

  /* ------------- 4. files copied in by hand: never restart onto half of them */

  // Halfway through a copy made by hand: the new manifest has landed, but a
  // module the worker imports has not. A restart now leaves Chrome with
  // "Service worker registration failed. Status code: 3" and nothing running
  // until someone reloads - as an owner found out.
  await devPage.evaluate((id) => chrome.developerPrivate.deleteExtensionErrors({ extensionId: id }), extensionId).catch(() => {});
  const aside = path.join(tmpdir(), `update-js-aside-${port}.js`);
  renameSync(path.join(extDir, 'src', 'update.js'), aside);
  installUpdate('99.0.3');

  /** The version the running worker reports, or null if none answers. */
  const liveVersion = async () => {
    for (const w of context.serviceWorkers().filter((x) => x.url().includes(extensionId)).reverse()) {
      try { return await w.evaluate(() => chrome.runtime.getManifest().version); } catch { /* gone */ }
    }
    return null;
  };
  const registrationErrors = async () => {
    const info = await devPage.evaluate((id) => chrome.developerPrivate.getExtensionInfo(id), extensionId);
    return [...(info.runtimeErrors || []), ...(info.manifestErrors || [])].map((e) => e.message)
      .filter((m) => /registration failed|fetching the script/i.test(m));
  };

  const copyWake = context.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null);
  await stopWorker();
  const copyPage = await context.newPage();
  await copyPage.goto(`${origin}/long.html`).catch(() => {});
  await copyWake;
  await new Promise((r) => setTimeout(r, 4000)); // more than one retry's worth
  const midCopy = { version: await liveVersion(), errors: await registrationErrors() };

  // "Restart to finish" in the same moment must not do it either.
  const copyDriver = await context.newPage();
  await copyDriver.goto(`chrome-extension://${extensionId}/options/options.html`);
  const refusedMidCopy = await copyDriver.evaluate(() => chrome.runtime.sendMessage({ type: 'restart' })).catch((e) => ({ threw: e.message }));
  await copyDriver.close();

  check('while files are still being copied in, it does not restart onto them', () => {
    assert.equal(midCopy.version, '99.0.2', `the extension restarted, or stopped running: ${JSON.stringify(midCopy)}`);
    assert.deepEqual(midCopy.errors, [], 'Chrome recorded a failed start');
    assert.equal(refusedMidCopy?.copying, true, `"Restart to finish" went ahead mid-copy: ${JSON.stringify(refusedMidCopy)}`);
  });

  // The copy finishes. Without anyone touching anything, it switches over.
  renameSync(aside, path.join(extDir, 'src', 'update.js'));
  let afterCopy = null;
  for (let i = 0; i < 60 && afterCopy !== '99.0.3'; i++) {
    await new Promise((r) => setTimeout(r, 250));
    afterCopy = await liveVersion();
  }
  const afterCopyErrors = await registrationErrors();

  check('once the copy is complete, it switches over by itself, and runs', () => {
    assert.equal(afterCopy, '99.0.3', 'the extension did not pick up the completed copy');
    assert.deepEqual(afterCopyErrors, []);
  });

  await copyPage.close();
  await devPage.close();
} finally {
  await context.close();
  server.close();
  rmSync(extDir, { recursive: true, force: true });
  rmSync(userDataDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : '\nall end-to-end checks passed');
process.exit(failures ? 1 : 0);
