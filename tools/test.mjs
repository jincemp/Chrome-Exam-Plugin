/*
 * Tests for everything that can run outside Chrome: the text extractor (against
 * a real DOM via linkedom), chunking, response parsing, and formatting.
 *
 *   npm install --no-save linkedom && node tools/test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseHTML } from 'linkedom';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/* ------------------------------------------------------------ tiny harness */

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    failures.push([name, err]);
  }
}

/* ------------------------------------------------- chrome API stub for import */

globalThis.chrome = {
  storage: {
    local: { get: async (d) => d, set: async () => {} },
    session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    onChanged: { addListener() {} },
  },
  runtime: { onMessage: { addListener() {} }, onStartup: { addListener() {} }, onInstalled: { addListener() {} }, getPlatformInfo: async () => ({}) },
  tabs: { onUpdated: { addListener() {} }, onRemoved: { addListener() {} }, get: async () => ({}) },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setIcon: async () => {} },
  scripting: {},
};

const { chunkText, mergeAnswers } = await import('../src/background.js');
const { parseQuestions, relaxCaps, parseResponsesPayload, parseChatPayload, classifyError, TruncatedError,
        buildResponsesBody, buildChatBody, initialCaps, buildContentParts } = await import('../src/openai.js');
const { formatAnswer, formatAll, sortAnswers } = await import('../src/format.js');
const { ANSWER_SCHEMA, buildPrompt } = await import('../src/prompt.js');
const { DEFAULT_SETTINGS, isInsecureBase, migrate, pageKey } = await import('../src/storage.js');

/* ------------------------------------------------------- extractor harness */

const EXTRACT_SRC = readFileSync(path.join(root, 'src/extract.js'), 'utf8');

// linkedom has no layout engine, so getComputedStyle is unavailable and the
// extractor's visibility checks fall back to tag names and attributes. Cases
// that turn on computed style (display:none, white-space) belong in tools/e2e.mjs.
async function extract(html, { selection = '', url = 'https://example.test/quiz' } = {}) {
  const { window, document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  window.top = window;
  window.getSelection = () => selection;

  const saved = { window: globalThis.window, document: globalThis.document, location: globalThis.location, Node: globalThis.Node };
  globalThis.window = window;
  globalThis.document = document;
  globalThis.location = { href: url, origin: new URL(url).origin };
  globalThis.Node = window.Node || { TEXT_NODE: 3, ELEMENT_NODE: 1 };
  try {
    return await (0, eval)(EXTRACT_SRC);
  } finally {
    Object.assign(globalThis, saved);
  }
}

/* ----------------------------------------------------------------- extract */

const QUIZ = `
  <nav><a href="/">Home</a><a href="/courses">Courses</a></nav>
  <header><h1>Site name</h1></header>
  <main>
    <h2>Practice Exam 3</h2>
    <div class="question">
      <p>1. What is the maximum voltage drop?</p>
      <ul>
        <li><label><input type="radio" name="q1" value="a"> a) 1%</label></li>
        <li><label><input type="radio" name="q1" value="b" checked> b) 3%</label></li>
        <li><label><input type="radio" name="q1" value="c"> c) 5%</label></li>
      </ul>
    </div>
    <div class="question">
      <p>2. Name the conductor that carries unbalanced current.</p>
    </div>
    <div class="question" data-answer="c">
      <p>3. Which is correct?</p>
      <ol>
        <li>a) One</li>
        <li>b) Two</li>
        <li>c) Three</li>
      </ol>
    </div>
  </main>
  <footer><p>Copyright 2026 Example</p></footer>
`;

await test('extract: returns page text', async () => {
  const r = (await extract(QUIZ));
  assert.equal(r.ok, true);
  assert.match(r.text, /maximum voltage drop/);
});

await test('extract: drops nav, header and footer boilerplate', async () => {
  const r = (await extract(QUIZ));
  assert.doesNotMatch(r.text, /Courses/);
  assert.doesNotMatch(r.text, /Copyright 2026/);
});

await test('extract: each question and option lands on its own line', async () => {
  const lines = (await extract(QUIZ)).text.split('\n').map((l) => l.trim()).filter(Boolean);
  assert.ok(lines.some((l) => l.startsWith('1. What is the maximum')), lines.join(' | '));
  assert.ok(lines.some((l) => l.includes('a) 1%')));
  assert.ok(lines.some((l) => l.includes('c) 5%')));
  // The option text must not run together with the next option.
  assert.ok(!lines.some((l) => /a\) 1%.*b\) 3%/.test(l)), lines.join(' | '));
});

await test('extract: marks a pre-selected radio', async () => {
  assert.match((await extract(QUIZ)).text, /\[selected\] b\) 3%/);
});

await test('extract: counts numbered questions', async () => {
  assert.equal((await extract(QUIZ)).questionCount, 3);
});

await test('extract: numbered prose headings are not questions', async () => {
  const article = `<main>
    <h2>1. Introduction</h2><p>Grounding matters.</p>
    <h2>2. Bonding</h2><p>So does bonding.</p>
    <h2>3. Conclusion</h2><p>The end.</p>
  </main>`;
  assert.equal((await extract(article)).questionCount, 0);
});

await test('extract: numeric option labels do not inflate the count', async () => {
  const page = `<main>
    <p>1. Which voltage is correct?</p>
    <p>1) 120 V</p><p>2) 208 V</p><p>3) 240 V</p><p>4) 480 V</p>
  </main>`;
  assert.equal((await extract(page)).questionCount, 1);
});

await test('extract: unnumbered options are still counted structurally', async () => {
  const forms = `<main>
    <div role="radiogroup"><div role="radio">Yes</div><div role="radio">No</div></div>
    <div role="radiogroup"><div role="radio">True</div><div role="radio">False</div></div>
  </main>`;
  assert.equal((await extract(forms)).questionCount, 2);
});

await test('extract: an aria-checked option is marked selected', async () => {
  const r = (await extract('<main><div role="radiogroup"><div role="radio" aria-checked="true">Yes</div><div role="radio">No</div></div></main>'));
  assert.match(r.text, /\[selected\] Yes/);
});

await test('extract: screen-reader-only text is left out', async () => {
  const r = (await extract('<main><span class="sr-only">Skip to content</span><p>1. A real question?</p></main>'));
  assert.doesNotMatch(r.text, /Skip to content/);
});

await test('extract: nested question containers are counted once', async () => {
  const nested = `<main>
    <div class="question-wrapper"><div class="question"><p>Pick one</p>
      <input type="radio" name="q1"><input type="radio" name="q1"></div></div>
    <div class="question-wrapper"><div class="question"><p>Pick one</p>
      <input type="radio" name="q2"><input type="radio" name="q2"></div></div>
  </main>`;
  assert.equal((await extract(nested)).questionCount, 2);
});

await test('extract: picks up a data-answer attribute as a hint', async () => {
  assert.match((await extract(QUIZ)).hints, /\bc\b/);
});

await test('extract: every hint says which question it belongs to', async () => {
  const page = `<main>
    <div class="question" data-answer="c"><p>1. First question?</p></div>
    <div class="question" data-answer="a"><p>2. Second question?</p></div>
    <div class="question" data-answer="c"><p>3. Third question?</p></div>
  </main>`;
  const lines = (await extract(page)).hints.split('\n').filter(Boolean);
  assert.deepEqual(lines, ['Q1 -> c', 'Q2 -> a', 'Q3 -> c'], 'a bare list of letters would de-duplicate into a misaligned key');
});

await test('extract: site and API keys are never collected as hints', async () => {
  const page = `<main>
    <div data-site-key="6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI"></div>
    <div data-api-key="sk-proj-abc123def456ghi789jkl012mno345pqr678"></div>
    <div data-session-key="9f8e7d6c5b4a39281706f5e4d3c2b1a0"></div>
    <p>1. A question?</p>
  </main>`;
  const { hints } = (await extract(page));
  assert.doesNotMatch(hints, /6LeIxAcT/);
  assert.doesNotMatch(hints, /sk-proj/);
  assert.doesNotMatch(hints, /9f8e7d6c/);
});

await test('extract: a preformatted block keeps its line structure', async () => {
  const page = `<main><pre>1. What is the maximum voltage drop?
a) 1%
b) 3%
c) 5%</pre></main>`;
  const lines = (await extract(page)).text.split('\n').map((l) => l.trim()).filter(Boolean);
  assert.ok(lines.includes('a) 1%'), lines.join(' // '));
  assert.ok(lines.includes('b) 3%'), lines.join(' // '));
});

await test('extract: a question stem inside a nested header survives', async () => {
  const page = `<body><header><h1>Exam site</h1></header><main>
    <div class="question">
      <header><h3>1. Which conductor is grounded?</h3></header>
      <ul><li>a) the hot</li><li>b) the neutral</li></ul>
    </div>
  </main><footer>Copyright</footer></body>`;
  const r = (await extract(page));
  assert.match(r.text, /Which conductor is grounded/);
  assert.doesNotMatch(r.text, /Exam site/);
});

await test('extract: a long answer dropdown keeps all of its options', async () => {
  const options = [
    'The neutral conductor carries the unbalanced current between the phase conductors.',
    'The equipment grounding conductor carries the unbalanced current at all times.',
    'The ungrounded conductor carries the unbalanced current under normal conditions.',
    'No conductor carries unbalanced current in a multiwire branch circuit.',
    'Both the neutral and the equipment grounding conductor share the unbalanced current.',
  ];
  const page = `<main><p>1. Which statement is correct?</p><select>${options.map((o) => `<option>${o}</option>`).join('')}</select></main>`;
  const { text } = (await extract(page));
  for (const o of options) assert.match(text, new RegExp(o.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

await test('extract: an unchosen dropdown is not reported as selected', async () => {
  const page = '<main><p>1. Pick one</p><select><option>Alpha</option><option>Beta</option></select></main>';
  assert.doesNotMatch((await extract(page)).text, /\[selected\]/);
});

await test('extract: a selection wins over the page', async () => {
  const r = (await extract(QUIZ, { selection: '7. Which conductor is grounded?\na) the hot\nb) the neutral' }));
  assert.match(r.selection, /Which conductor is grounded/);
  assert.equal(r.questionCount, 1);
});

await test('extract: ignores a selection too short to be a question', async () => {
  assert.equal((await extract(QUIZ, { selection: 'voltage' })).selection, '');
});

await test('extract: script and style content never appears', async () => {
  const r = (await extract('<main><p>1. Real question?</p><script>var answer="b";</script><style>.x{color:red}</style></main>'));
  assert.doesNotMatch(r.text, /var answer/);
  assert.doesNotMatch(r.text, /color:red/);
});

await test('extract: a table row stays on one line with its cells separated', async () => {
  const r = (await extract('<main><table><tr><td>1.</td><td>What is 2+2?</td></tr><tr><td>2.</td><td>And 3+3?</td></tr></table></main>'));
  const lines = r.text.split('\n').map((l) => l.trim()).filter(Boolean);
  assert.ok(lines.some((l) => /1\..*\|.*What is 2\+2\?/.test(l)), lines.join(' // '));
  assert.ok(lines.some((l) => /2\..*\|.*And 3\+3\?/.test(l)), lines.join(' // '));
});

await test('extract: a page of question blocks is not reduced to the first one', async () => {
  const page = `<div id="page"><div class="header">Site</div>
    <div class="question"><p>1. ${'Long question text about grounding electrodes. '.repeat(8)}</p></div>
    <div class="question"><p>2. ${'Long question text about bonding jumpers. '.repeat(8)}</p></div>
    <div class="question"><p>3. ${'Long question text about raceway fill. '.repeat(8)}</p></div>
  </div>`;
  const r = (await extract(page));
  assert.match(r.text, /1\. Long question text about grounding/);
  assert.match(r.text, /2\. Long question text about bonding/);
  assert.match(r.text, /3\. Long question text about raceway/);
});

await test('extract: short selects contribute their options', async () => {
  const r = (await extract('<main><p>1. Pick one</p><select><option>Alpha</option><option>Beta</option></select></main>'));
  assert.match(r.text, /Alpha/);
  assert.match(r.text, /Beta/);
});

await test('extract: falls back to the body when there is no main landmark', async () => {
  const r = (await extract('<div><p>1. Body only question?</p><p>a) yes</p><p>b) no</p></div>'));
  assert.match(r.text, /Body only question/);
});

await test('extract: an about:blank iframe does not hide the real one', async () => {
  const page = `<main><p>Loading...</p>
    <iframe src="about:blank"></iframe>
    <iframe src="https://quiz.example.com/embed/42"></iframe>
  </main>`;
  assert.deepEqual((await extract(page)).frameOrigins, ['https://quiz.example.com']);
});

await test('extract: same-origin and non-http frames are not reported', async () => {
  const page = `<main>
    <iframe src="/local/embed"></iframe>
    <iframe src="javascript:false"></iframe>
    <iframe src="data:text/html,hi"></iframe>
  </main>`;
  assert.deepEqual((await extract(page)).frameOrigins, []);
});

await test('extract: image alt text is kept', async () => {
  const r = (await extract('<main><p>1. Identify this symbol</p><img alt="wye transformer" src="x.png"></main>'));
  assert.match(r.text, /wye transformer/);
});

await test('extract: reports truncation only when it happens', async () => {
  assert.equal((await extract(QUIZ)).truncated, false);
  const long = `<main>${'<p>1. Filler question about wiring methods?</p>'.repeat(2000)}</main>`;
  assert.equal((await extract(long)).truncated, true);
});

/* ------------------------------------------------------------------ chunks */

await test('chunk: short text is a single chunk', async () => {
  assert.deepEqual(chunkText('1. a\n2. b', 1000), ['1. a\n2. b']);
});

await test('chunk: long text splits on question boundaries', async () => {
  const q = (n) => `${n}. Question number ${n}?\na) one\nb) two\nc) three\nd) four`;
  const text = Array.from({ length: 40 }, (_, i) => q(i + 1)).join('\n');
  const chunks = chunkText(text, 500);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.length <= 800, `chunk too long: ${c.length}`);
    assert.match(c.split('\n')[0], /^\d+\. Question number/, 'chunk must start at a question');
  }
  // Nothing may be lost in the split.
  const rejoined = chunks.join('\n');
  for (let i = 1; i <= 40; i++) assert.ok(rejoined.includes(`${i}. Question number ${i}?`));
});

await test('chunk: a single over-long line is split rather than passed through', async () => {
  const chunks = chunkText('x'.repeat(5000), 1000);
  assert.ok(chunks.length >= 5);
  for (const c of chunks) assert.ok(c.length <= 1000);
});

await test('chunk: text with no numbering still splits', async () => {
  const para = 'Some prose about grounding electrodes.\n\n';
  const chunks = chunkText(para.repeat(200), 1000);
  assert.ok(chunks.length > 1);
});

/* ------------------------------------------------------------------- merge */

const answer = (number, extra = {}) => ({ number: String(number), label: 'a', answer: `answer ${number}`, why: '', confidence: 'high', ...extra });

await test('merge: one chunk passes straight through', async () => {
  const merged = mergeAnswers([[answer(1), answer(2)]]);
  assert.deepEqual(merged.map((a) => a.number), ['1', '2']);
  assert.equal('part' in merged[0], false, 'the chunk index is an implementation detail');
});

await test('merge: page numbering that continues across chunks is preserved', async () => {
  const merged = mergeAnswers([[answer(1), answer(2)], [answer(3), answer(4)]]);
  assert.deepEqual(merged.map((a) => a.number), ['1', '2', '3', '4']);
});

await test('merge: an unnumbered page restarting at 1 per chunk keeps every answer', async () => {
  const merged = mergeAnswers([
    [answer(1, { answer: 'chunk one first' }), answer(2, { answer: 'chunk one second' })],
    [answer(1, { answer: 'chunk two first' }), answer(2, { answer: 'chunk two second' })],
  ]);
  assert.equal(merged.length, 4, 'nothing may be discarded as a duplicate');
  assert.deepEqual(merged.map((a) => a.number), ['1', '2', '3', '4']);
  assert.deepEqual(merged.map((a) => a.answer), ['chunk one first', 'chunk one second', 'chunk two first', 'chunk two second']);
});

await test('merge: a question straddling a boundary is answered once, best first', async () => {
  const merged = mergeAnswers([
    [answer(1), answer(2, { confidence: 'low', answer: 'half a question' })],
    [answer(2, { confidence: 'high', answer: 'the whole question' }), answer(3)],
  ]);
  assert.deepEqual(merged.map((a) => a.number), ['1', '2', '3']);
  assert.equal(merged.find((a) => a.number === '2').answer, 'the whole question');
});

await test('merge: a failed chunk leaves a hole without shifting the rest', async () => {
  const groups = [[answer(1)], undefined, [answer(3)]];
  assert.deepEqual(mergeAnswers(groups).map((a) => a.number), ['1', '3']);
});

/* ------------------------------------------------------------------- parse */

await test('parse: strict schema output', async () => {
  const q = parseQuestions('{"questions":[{"number":"1","label":"b","answer":"230.34","why":"","confidence":"high"}]}');
  assert.deepEqual(q, [{ number: '1', label: 'b', answer: '230.34', why: '', confidence: 'high' }]);
});

await test('parse: tolerates a bare array and alternate key names', async () => {
  const q = parseQuestions('[{"q":"4","choice":"(c)","text":"12 AWG","explanation":"table 310.16"}]');
  assert.equal(q.length, 1);
  assert.equal(q[0].number, '4');
  assert.equal(q[0].label, 'c');
  assert.equal(q[0].answer, '12 AWG');
  assert.equal(q[0].confidence, 'medium');
});

await test('parse: digs JSON out of a markdown fence', async () => {
  const q = parseQuestions('```json\n{"questions":[{"number":"2","label":"a","answer":"Yes","why":"","confidence":"low"}]}\n```');
  assert.equal(q[0].answer, 'Yes');
});

await test('parse: strips a Q prefix and trailing punctuation from the number', async () => {
  assert.equal(parseQuestions('{"questions":[{"number":"Q7.","label":"","answer":"x","why":"","confidence":"high"}]}')[0].number, '7');
});

await test('parse: drops entries with neither a label nor an answer', async () => {
  assert.equal(parseQuestions('{"questions":[{"number":"1","label":"","answer":"","why":"","confidence":"low"}]}').length, 0);
});

await test('parse: unusable content throws', async () => {
  assert.throws(() => parseQuestions('I could not find any questions.'));
});

/* ------------------------------------------------------------ error mapping */

const err = (status, error, settings = { model: 'gpt-5.4-nano' }) => classifyError(status, error ? { error } : null, settings);

await test('errors: a context-length 400 becomes a truncation the caller can recover from', async () => {
  const e = err(400, { code: 'context_length_exceeded', message: "This model's maximum context length is 272000 tokens." });
  assert.ok(e instanceof TruncatedError, 'must be recoverable by splitting, not a dead end');
});

await test('errors: 401 names the key and points at settings', async () => {
  const e = err(401, { code: 'invalid_api_key', message: 'Incorrect API key provided: sk-xxx.' });
  assert.equal(e.kind, 'auth');
  assert.match(e.message, /rejected your API key/i);
  assert.match(e.hint, /settings/i);
  assert.equal(e.retryable, false);
});

await test('errors: out of credit is never retried', async () => {
  const e = err(429, { code: 'insufficient_quota', message: 'You exceeded your current quota.' });
  assert.equal(e.kind, 'quota');
  assert.equal(e.retryable, false);
  assert.match(e.hint, /billing/i);
});

await test('errors: a genuine rate limit is retried', async () => {
  const e = err(429, { code: 'rate_limit_exceeded', message: 'Rate limit reached for gpt-5.4-nano.' });
  assert.equal(e.kind, 'rate');
  assert.equal(e.retryable, true);
});

await test('errors: a retired model names the model and the remedy', async () => {
  const e = err(404, { code: 'model_not_found', message: 'The model `gpt-4o` does not exist.' }, { model: 'gpt-4o' });
  assert.equal(e.kind, 'model');
  assert.match(e.message, /gpt-4o/);
  assert.match(e.hint, /different model/i);
});

await test('errors: an unknown route is an endpoint problem, not a model problem', async () => {
  assert.equal(err(404, { message: 'Unknown request URL.' }).kind, 'endpoint');
  assert.equal(err(405, null).kind, 'endpoint');
});

await test('errors: a server error is retried', async () => {
  assert.equal(err(503, null).retryable, true);
});

await test('errors: a gateway answering with HTML still produces a message', async () => {
  const e = err(502, null);
  assert.ok(e.message.length > 0);
});

/* ---------------------------------------------------------- payload shapes */

const outputText = (text, extra = {}) => ({ type: 'message', content: [{ type: 'output_text', text }], ...extra });

await test('responses: reads the message item, not output[0]', async () => {
  const data = { status: 'completed', output: [{ type: 'reasoning', summary: [] }, outputText('{"questions":[]}')] };
  assert.equal(parseResponsesPayload(data), '{"questions":[]}');
});

await test('responses: a commentary message never wins over the answer', async () => {
  const data = {
    status: 'completed',
    output: [
      { type: 'reasoning' },
      outputText('Let me look at the options...', { phase: 'commentary' }),
      outputText('{"questions":[{"number":"1"}]}', { phase: 'final_answer' }),
    ],
  };
  assert.match(parseResponsesPayload(data), /"number":"1"/);
});

await test('responses: status failed reads the top-level error, not the HTTP envelope', async () => {
  assert.throws(
    () => parseResponsesPayload({ status: 'failed', error: { code: 'server_error', message: 'Upstream exploded.' } }),
    /Upstream exploded/,
  );
});

await test('responses: running out of output tokens is a truncation, not a failure', async () => {
  assert.throws(
    () => parseResponsesPayload({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }),
    TruncatedError,
  );
});

await test('responses: a refusal is reported as one', async () => {
  const data = { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No.' }] }] };
  assert.throws(() => parseResponsesPayload(data), /declined/);
});

await test('responses: a gateway that sends output_text is accepted', async () => {
  assert.equal(parseResponsesPayload({ status: 'completed', output: [], output_text: '{"questions":[]}' }), '{"questions":[]}');
});

await test('chat: finish_reason length is a truncation', async () => {
  assert.throws(
    () => parseChatPayload({ choices: [{ finish_reason: 'length', message: { content: '{"quest' } }] }),
    TruncatedError,
  );
});

await test('chat: content comes back verbatim', async () => {
  assert.equal(parseChatPayload({ choices: [{ finish_reason: 'stop', message: { content: '{"questions":[]}' } }] }), '{"questions":[]}');
});

/* -------------------------------------------------------------- capability */

const caps = () => ({ format: 'json_schema', reasoning: true, verbosity: true, maxTokens: true, temperature: true, store: true, images: true });

await test('relax: a temperature complaint drops temperature first', async () => {
  const c = caps();
  assert.equal(relaxCaps({ status: 400, message: "Unsupported value: 'temperature' does not support 0 with this model." }, c), true);
  assert.equal(c.temperature, false);
  assert.equal(c.format, 'json_schema');
});

await test('relax: a max_tokens complaint drops the token cap', async () => {
  const c = caps();
  relaxCaps({ status: 400, param: 'max_tokens', code: 'unsupported_parameter', message: "Unsupported parameter: 'max_tokens' is not supported with this model." }, c);
  assert.equal(c.maxTokens, false);
});

await test('relax: a schema complaint falls back to plain JSON, then to none', async () => {
  const c = caps();
  relaxCaps({ status: 400, message: "Invalid parameter: 'response_format' of type 'json_schema' is not supported." }, c);
  assert.equal(c.format, 'json_object');
  relaxCaps({ status: 400, message: "Invalid parameter: 'response_format' is not supported." }, c);
  assert.equal(c.format, 'none', 'a gateway supporting neither must still be reachable');
});

await test('relax: an unrelated 400 never turns request retention back on', async () => {
  const c = caps();
  while (relaxCaps({ status: 400, message: 'something unfamiliar' }, c)) { /* drain */ }
  assert.equal(c.store, true, 'store must only come off when the server names it');
});

await test('relax: a store complaint does drop it', async () => {
  const c = caps();
  relaxCaps({ status: 400, param: 'store', message: "Unknown parameter: 'store'." }, c);
  assert.equal(c.store, false);
});

await test('relax: eventually gives up', async () => {
  const c = caps();
  let guard = 0;
  while (relaxCaps({ status: 400, message: 'something unfamiliar' }, c)) {
    assert.ok(guard++ < 20, 'relaxCaps must terminate');
  }
  assert.equal(c.format, 'none');
});

await test('relax: a no-vision complaint drops only images', async () => {
  const c = caps();
  assert.equal(relaxCaps({ status: 400, message: "This model does not support image inputs." }, c), true);
  assert.equal(c.images, false);
  assert.equal(c.format, 'json_schema', 'nothing else should have been touched');
  assert.equal(c.reasoning, true);
});

await test('relax: an unrecognised 400 sheds images before other capabilities', async () => {
  const c = caps();
  relaxCaps({ status: 400, message: 'something unfamiliar' }, c);
  assert.equal(c.images, false);
  assert.equal(c.verbosity, true, 'images should go first, ahead of verbosity');
});

/* ------------------------------------------------------------------- images */

const IMG_A = { id: 1, value: 'data:image/png;base64,AAAA', alt: '' };
const IMG_B = { id: 2, value: 'https://example.test/chart.png', alt: 'a bar chart' };

await test('images: text with no tokens passes through untouched', async () => {
  const text = '1. What is 2+2?';
  assert.equal(buildContentParts(text, [], true), text);
  assert.equal(buildContentParts(text, [IMG_A], true), text);
});

await test('images: a page with no images available degrades tokens to alt text', async () => {
  const text = '1. [[IMG:2]]\nWhat does the chart show?';
  const out = buildContentParts(text, [IMG_B], false);
  assert.equal(typeof out, 'string');
  assert.match(out, /\[image: a bar chart\]/);
});

await test('images: an image with no alt degrades to an omitted marker', async () => {
  const out = buildContentParts('[[IMG:1]] diagram above', [IMG_A], false);
  assert.match(out, /\[image omitted\]/);
});

await test('images: useImages splits interleaved text/image parts in reading order', async () => {
  const text = 'Question 1:\n[[IMG:1]]\nWhat voltage is shown?';
  const parts = buildContentParts(text, [IMG_A], true);
  assert.ok(Array.isArray(parts));
  assert.deepEqual(parts.map((p) => p.type), ['text', 'image', 'text']);
  assert.match(parts[0].text, /Question 1/);
  assert.equal(parts[1].value, IMG_A.value);
  assert.match(parts[2].text, /What voltage/);
});

await test('images: image-only question produces no leading/trailing empty text parts', async () => {
  const parts = buildContentParts('[[IMG:1]]', [IMG_A], true);
  assert.deepEqual(parts, [{ type: 'image', value: IMG_A.value }]);
});

await test('images: multiple images across a page all resolve, in order', async () => {
  const text = '1. [[IMG:1]] first\n2. [[IMG:2]] second';
  const parts = buildContentParts(text, [IMG_A, IMG_B], true);
  const imgs = parts.filter((p) => p.type === 'image').map((p) => p.value);
  assert.deepEqual(imgs, [IMG_A.value, IMG_B.value]);
});

await test('images: a token whose image was dropped (e.g. by truncation) resolves to nothing', async () => {
  const parts = buildContentParts('before [[IMG:99]] after', [IMG_A], true);
  assert.equal(typeof parts, 'string', 'no known image resolved, so this degrades like the no-image case');
  assert.doesNotMatch(parts, /\[\[IMG/);
});

await test('body: image parts become flat input_image entries on Responses', async () => {
  const promptWithImages = { system: 'be an answer key', user: [{ type: 'text', text: 'Q1: ' }, { type: 'image', value: 'data:image/png;base64,AAAA' }] };
  const settings = { ...DEFAULT_SETTINGS, apiKey: 'sk-x' };
  const body = buildResponsesBody(settings, promptWithImages, initialCaps(settings));
  const content = body.input[0].content;
  assert.deepEqual(content[0], { type: 'input_text', text: 'Q1: ' });
  assert.deepEqual(content[1], { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'high' });
});

await test('body: image parts become nested image_url entries on Chat Completions', async () => {
  const promptWithImages = { system: 'be an answer key', user: [{ type: 'text', text: 'Q1: ' }, { type: 'image', value: 'https://example.test/x.png' }] };
  const settings = { ...DEFAULT_SETTINGS, apiKey: 'sk-x' };
  const body = buildChatBody(settings, promptWithImages, initialCaps(settings));
  const content = body.messages[1].content;
  assert.deepEqual(content[0], { type: 'text', text: 'Q1: ' });
  assert.deepEqual(content[1], { type: 'image_url', image_url: { url: 'https://example.test/x.png', detail: 'high' } });
});

/* ------------------------------------------------------------------ format */

await test('format: multiple choice shows the option letter', async () => {
  assert.equal(formatAnswer({ number: '1', label: 'b', answer: '230.34' }), 'Q1: b) 230.34');
});

await test('format: an open question shows just the answer', async () => {
  assert.equal(formatAnswer({ number: '4', label: '', answer: '230.34' }), 'Q4: 230.34');
});

await test('format: a label that already carries a bracket is not doubled', async () => {
  assert.equal(formatAnswer({ number: '2', label: 'c)', answer: 'Neutral' }), 'Q2: c) Neutral');
});

await test('format: the whole sheet is one line per question', async () => {
  const text = formatAll([{ number: '1', label: 'a', answer: 'One' }, { number: '2', label: '', answer: 'Two' }]);
  assert.equal(text, 'Q1: a) One\nQ2: Two');
});

await test('format: questions sort numerically, not lexically', async () => {
  const sorted = sortAnswers([{ number: '10' }, { number: '2' }, { number: '1' }]).map((a) => a.number);
  assert.deepEqual(sorted, ['1', '2', '10']);
});

await test('format: suffixed numbers stay next to their parent', async () => {
  const sorted = sortAnswers([{ number: '3b' }, { number: '3a' }, { number: '2' }]).map((a) => a.number);
  assert.deepEqual(sorted, ['2', '3a', '3b']);
});

/* ------------------------------------------------------------------ prompt */

await test('prompt: the strict schema is well formed', async () => {
  const walk = (node) => {
    if (node.type !== 'object') return;
    assert.equal(node.additionalProperties, false, 'every object needs additionalProperties:false');
    assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), 'every property must be required');
    for (const child of Object.values(node.properties)) {
      walk(child.type === 'array' ? child.items : child);
    }
  };
  walk(ANSWER_SCHEMA);
});

await test('prompt: the working field is generated before the answer', async () => {
  // Structured output is emitted in schema order, so this is not cosmetic:
  // `answer` ahead of `why` makes the model commit to a number before doing
  // any arithmetic. Reordering these will quietly cost accuracy on maths.
  const keys = Object.keys(ANSWER_SCHEMA.properties.questions.items.properties);
  assert.ok(keys.indexOf('why') < keys.indexOf('answer'), `why must precede answer, got ${keys.join(', ')}`);
  assert.ok(keys.indexOf('why') < keys.indexOf('label'), `why must precede label, got ${keys.join(', ')}`);

  const required = ANSWER_SCHEMA.properties.questions.items.required;
  assert.ok(required.indexOf('why') < required.indexOf('answer'), 'required order must match too');
});

await test('prompt: the instructions tell the model to work it out before answering', async () => {
  const p = buildPrompt({ text: '1. A question?' });
  assert.match(p.system, /work the question out/i);
  assert.match(p.system, /do not answer first/i);
});

await test('prompt: page text and course context reach the model', async () => {
  const p = buildPrompt({ title: 'Exam 3', url: 'https://x.test', text: '1. A question?', extraInstructions: '2023 NEC', questionCount: 1 });
  assert.match(p.user, /Exam 3/);
  assert.match(p.user, /1\. A question\?/);
  assert.match(p.user, /2023 NEC/);
  assert.doesNotMatch(p.system, /Reply with JSON only/);
});

await test('prompt: losing schema enforcement adds the JSON instruction', async () => {
  const p = buildPrompt({ text: '1. A question?', schemaEnforced: false });
  assert.match(p.system, /Reply with JSON only/);
});

await test('prompt: scraped hints are labelled unverified', async () => {
  const p = buildPrompt({ text: '1. A question?', hints: 'answer: b' });
  assert.match(p.user, /unverified/i);
});

/* ------------------------------------------------------------ request body */

const PROMPT = { system: 'be an answer key', user: '1. What is 2+2?' };
const bodyFor = (overrides = {}) => {
  const settings = { ...DEFAULT_SETTINGS, apiKey: 'sk-x', ...overrides };
  return buildResponsesBody(settings, PROMPT, initialCaps(settings));
};

await test('body: the shipped defaults produce a valid Responses request', async () => {
  const body = bodyFor();
  assert.equal(body.model, DEFAULT_SETTINGS.model);
  assert.equal(body.text.format.type, 'json_schema');
  assert.equal(body.text.format.name, 'answer_sheet', 'name is flat, not wrapped in json_schema');
  assert.equal(body.store, false);
  assert.equal('max_tokens' in body, false);
  assert.ok(body.max_output_tokens > 0);
});

await test('body: the default model is a reasoning model, so no temperature is sent', async () => {
  const body = bodyFor();
  assert.equal('temperature' in body, false, 'gpt-5.x rejects temperature with a 400');
  assert.equal(body.reasoning.effort, DEFAULT_SETTINGS.effort);
});

await test('body: the default effort is one the API accepts', async () => {
  assert.ok(['none', 'minimal', 'low', 'medium', 'high'].includes(DEFAULT_SETTINGS.effort));
});

await test('body: more thinking gets a bigger output budget, since reasoning is billed there', async () => {
  const low = bodyFor({ effort: 'low' }).max_output_tokens;
  const medium = bodyFor({ effort: 'medium' }).max_output_tokens;
  const high = bodyFor({ effort: 'high' }).max_output_tokens;
  assert.ok(medium > low, 'medium must have more room than low');
  assert.ok(high > medium, 'high must have more room than medium');
});

await test('body: a non-reasoning model gets temperature 0 and no reasoning block', async () => {
  const settings = { ...DEFAULT_SETTINGS, apiKey: 'sk-x', model: 'some-proxy-model' };
  const body = buildResponsesBody(settings, PROMPT, initialCaps(settings));
  assert.equal(body.temperature, 0);
  assert.equal('reasoning' in body, false);
});

await test('body: the chat shape wraps the schema and nests nothing', async () => {
  const settings = { ...DEFAULT_SETTINGS, apiKey: 'sk-x' };
  const body = buildChatBody(settings, PROMPT, initialCaps(settings));
  assert.equal(body.response_format.json_schema.name, 'answer_sheet');
  assert.equal(body.reasoning_effort, DEFAULT_SETTINGS.effort, 'flat on chat completions');
  assert.equal(body.verbosity, 'low');
  assert.ok(body.max_completion_tokens > 0);
  assert.equal('max_tokens' in body, false);
  assert.equal(body.store, false);
});

/* ---------------------------------------------------------------- settings */

await test('settings: an install still on the old default pair is moved forward', async () => {
  const before = { model: 'gpt-5.4-nano', effort: 'low', showWhy: true, settingsVersion: 0 };
  const after = migrate(before);
  assert.equal(after.model, DEFAULT_SETTINGS.model);
  assert.equal(after.effort, DEFAULT_SETTINGS.effort);
  assert.equal(after.settingsVersion, DEFAULT_SETTINGS.settingsVersion);
  assert.equal(before.model, 'gpt-5.4-nano', 'must not mutate the input');
});

await test('settings: a model the user chose is never overwritten', async () => {
  const chosen = migrate({ model: 'gpt-5.6-sol', effort: 'low', settingsVersion: 0 });
  assert.equal(chosen.model, 'gpt-5.6-sol');
  assert.equal(chosen.effort, 'low', 'their effort is theirs too');
});

await test('settings: a superseded default moves even if the effort was changed', async () => {
  // The migration keys on the model alone. Requiring the effort to match as
  // well left anyone who had touched that dropdown stuck on the old model.
  const partly = migrate({ model: 'gpt-5.4-nano', effort: 'high', settingsVersion: 0 });
  assert.equal(partly.model, DEFAULT_SETTINGS.model);
});

await test('settings: an install on the retired gpt-4.1-mini default is rescued', async () => {
  // That ID 404s now, so leaving it would mean every run fails.
  const old = migrate({ model: 'gpt-4.1-mini', settingsVersion: 0 });
  assert.equal(old.model, DEFAULT_SETTINGS.model);
});

await test('settings: migration runs once, then leaves settings alone', async () => {
  const current = { model: 'gpt-5.4-nano', effort: 'low', settingsVersion: DEFAULT_SETTINGS.settingsVersion };
  assert.equal(migrate(current), current, 'an already-migrated install is returned untouched');
});

await test('settings: a fresh install needs no migration of its values', async () => {
  const fresh = migrate({ ...DEFAULT_SETTINGS, settingsVersion: 0 });
  assert.equal(fresh.model, DEFAULT_SETTINGS.model);
  assert.equal(fresh.effort, DEFAULT_SETTINGS.effort);
});

await test('settings: a plain-http proxy is rejected, except on this machine', async () => {
  assert.equal(isInsecureBase('http://proxy.example.com/v1'), true);
  assert.equal(isInsecureBase('http://localhost:11434/v1'), false);
  assert.equal(isInsecureBase('http://127.0.0.1:1234/v1'), false);
  assert.equal(isInsecureBase('https://api.openai.com/v1'), false);
  assert.equal(isInsecureBase('https://proxy.example.com/v1'), false);
});

await test('settings: the page key ignores the fragment but not the path', async () => {
  assert.equal(pageKey('https://x.test/exam#q3'), pageKey('https://x.test/exam'));
  assert.notEqual(pageKey('https://x.test/exam/2'), pageKey('https://x.test/exam'));
});

/* ------------------------------------------------------------------ report */

for (const [name, err] of failures) {
  console.error(`FAIL  ${name}\n      ${err.message.split('\n')[0]}`);
}
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
