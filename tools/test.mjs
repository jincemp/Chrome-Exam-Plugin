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

function test(name, fn) {
  try {
    fn();
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

const { chunkText } = await import('../src/background.js');
const { parseQuestions, relaxCaps, parseResponsesPayload, parseChatPayload, classifyError, TruncatedError } = await import('../src/openai.js');
const { formatAnswer, formatAll, sortAnswers } = await import('../src/format.js');
const { ANSWER_SCHEMA, buildPrompt } = await import('../src/prompt.js');

/* ------------------------------------------------------- extractor harness */

const EXTRACT_SRC = readFileSync(path.join(root, 'src/extract.js'), 'utf8');

function extract(html, { selection = '', url = 'https://example.test/quiz' } = {}) {
  const { window, document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  window.top = window;
  window.getSelection = () => selection;

  const saved = { window: globalThis.window, document: globalThis.document, location: globalThis.location, Node: globalThis.Node };
  globalThis.window = window;
  globalThis.document = document;
  globalThis.location = { href: url };
  globalThis.Node = window.Node || { TEXT_NODE: 3, ELEMENT_NODE: 1 };
  try {
    return (0, eval)(EXTRACT_SRC);
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

test('extract: returns page text', () => {
  const r = extract(QUIZ);
  assert.equal(r.ok, true);
  assert.match(r.text, /maximum voltage drop/);
});

test('extract: drops nav, header and footer boilerplate', () => {
  const r = extract(QUIZ);
  assert.doesNotMatch(r.text, /Courses/);
  assert.doesNotMatch(r.text, /Copyright 2026/);
});

test('extract: each question and option lands on its own line', () => {
  const lines = extract(QUIZ).text.split('\n').map((l) => l.trim()).filter(Boolean);
  assert.ok(lines.some((l) => l.startsWith('1. What is the maximum')), lines.join(' | '));
  assert.ok(lines.some((l) => l.includes('a) 1%')));
  assert.ok(lines.some((l) => l.includes('c) 5%')));
  // The option text must not run together with the next option.
  assert.ok(!lines.some((l) => /a\) 1%.*b\) 3%/.test(l)), lines.join(' | '));
});

test('extract: marks a pre-selected radio', () => {
  assert.match(extract(QUIZ).text, /\[selected\] b\) 3%/);
});

test('extract: counts numbered questions', () => {
  assert.equal(extract(QUIZ).questionCount, 3);
});

test('extract: numbered prose headings are not questions', () => {
  const article = `<main>
    <h2>1. Introduction</h2><p>Grounding matters.</p>
    <h2>2. Bonding</h2><p>So does bonding.</p>
    <h2>3. Conclusion</h2><p>The end.</p>
  </main>`;
  assert.equal(extract(article).questionCount, 0);
});

test('extract: numeric option labels do not inflate the count', () => {
  const page = `<main>
    <p>1. Which voltage is correct?</p>
    <p>1) 120 V</p><p>2) 208 V</p><p>3) 240 V</p><p>4) 480 V</p>
  </main>`;
  assert.equal(extract(page).questionCount, 1);
});

test('extract: unnumbered options are still counted structurally', () => {
  const forms = `<main>
    <div role="radiogroup"><div role="radio">Yes</div><div role="radio">No</div></div>
    <div role="radiogroup"><div role="radio">True</div><div role="radio">False</div></div>
  </main>`;
  assert.equal(extract(forms).questionCount, 2);
});

test('extract: an aria-checked option is marked selected', () => {
  const r = extract('<main><div role="radiogroup"><div role="radio" aria-checked="true">Yes</div><div role="radio">No</div></div></main>');
  assert.match(r.text, /\[selected\] Yes/);
});

test('extract: screen-reader-only text is left out', () => {
  const r = extract('<main><span class="sr-only">Skip to content</span><p>1. A real question?</p></main>');
  assert.doesNotMatch(r.text, /Skip to content/);
});

test('extract: nested question containers are counted once', () => {
  const nested = `<main>
    <div class="question-wrapper"><div class="question"><p>Pick one</p>
      <input type="radio" name="q1"><input type="radio" name="q1"></div></div>
    <div class="question-wrapper"><div class="question"><p>Pick one</p>
      <input type="radio" name="q2"><input type="radio" name="q2"></div></div>
  </main>`;
  assert.equal(extract(nested).questionCount, 2);
});

test('extract: picks up a data-answer attribute as a hint', () => {
  assert.match(extract(QUIZ).hints, /\bc\b/);
});

test('extract: a selection wins over the page', () => {
  const r = extract(QUIZ, { selection: '7. Which conductor is grounded?\na) the hot\nb) the neutral' });
  assert.match(r.selection, /Which conductor is grounded/);
  assert.equal(r.questionCount, 1);
});

test('extract: ignores a selection too short to be a question', () => {
  assert.equal(extract(QUIZ, { selection: 'voltage' }).selection, '');
});

test('extract: script and style content never appears', () => {
  const r = extract('<main><p>1. Real question?</p><script>var answer="b";</script><style>.x{color:red}</style></main>');
  assert.doesNotMatch(r.text, /var answer/);
  assert.doesNotMatch(r.text, /color:red/);
});

test('extract: table cells are separated', () => {
  const r = extract('<main><table><tr><td>1.</td><td>What is 2+2?</td></tr></table></main>');
  assert.match(r.text, /\|/);
  assert.match(r.text, /What is 2\+2\?/);
});

test('extract: short selects contribute their options', () => {
  const r = extract('<main><p>1. Pick one</p><select><option>Alpha</option><option>Beta</option></select></main>');
  assert.match(r.text, /Alpha/);
  assert.match(r.text, /Beta/);
});

test('extract: falls back to the body when there is no main landmark', () => {
  const r = extract('<div><p>1. Body only question?</p><p>a) yes</p><p>b) no</p></div>');
  assert.match(r.text, /Body only question/);
});

test('extract: image alt text is kept', () => {
  const r = extract('<main><p>1. Identify this symbol</p><img alt="wye transformer" src="x.png"></main>');
  assert.match(r.text, /wye transformer/);
});

test('extract: reports truncation only when it happens', () => {
  assert.equal(extract(QUIZ).truncated, false);
  const long = `<main>${'<p>1. Filler question about wiring methods?</p>'.repeat(2000)}</main>`;
  assert.equal(extract(long).truncated, true);
});

/* ------------------------------------------------------------------ chunks */

test('chunk: short text is a single chunk', () => {
  assert.deepEqual(chunkText('1. a\n2. b', 1000), ['1. a\n2. b']);
});

test('chunk: long text splits on question boundaries', () => {
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

test('chunk: a single over-long line is split rather than passed through', () => {
  const chunks = chunkText('x'.repeat(5000), 1000);
  assert.ok(chunks.length >= 5);
  for (const c of chunks) assert.ok(c.length <= 1000);
});

test('chunk: text with no numbering still splits', () => {
  const para = 'Some prose about grounding electrodes.\n\n';
  const chunks = chunkText(para.repeat(200), 1000);
  assert.ok(chunks.length > 1);
});

/* ------------------------------------------------------------------- parse */

test('parse: strict schema output', () => {
  const q = parseQuestions('{"questions":[{"number":"1","label":"b","answer":"230.34","why":"","confidence":"high"}]}');
  assert.deepEqual(q, [{ number: '1', label: 'b', answer: '230.34', why: '', confidence: 'high' }]);
});

test('parse: tolerates a bare array and alternate key names', () => {
  const q = parseQuestions('[{"q":"4","choice":"(c)","text":"12 AWG","explanation":"table 310.16"}]');
  assert.equal(q.length, 1);
  assert.equal(q[0].number, '4');
  assert.equal(q[0].label, 'c');
  assert.equal(q[0].answer, '12 AWG');
  assert.equal(q[0].confidence, 'medium');
});

test('parse: digs JSON out of a markdown fence', () => {
  const q = parseQuestions('```json\n{"questions":[{"number":"2","label":"a","answer":"Yes","why":"","confidence":"low"}]}\n```');
  assert.equal(q[0].answer, 'Yes');
});

test('parse: strips a Q prefix and trailing punctuation from the number', () => {
  assert.equal(parseQuestions('{"questions":[{"number":"Q7.","label":"","answer":"x","why":"","confidence":"high"}]}')[0].number, '7');
});

test('parse: drops entries with neither a label nor an answer', () => {
  assert.equal(parseQuestions('{"questions":[{"number":"1","label":"","answer":"","why":"","confidence":"low"}]}').length, 0);
});

test('parse: unusable content throws', () => {
  assert.throws(() => parseQuestions('I could not find any questions.'));
});

/* ------------------------------------------------------------ error mapping */

const err = (status, error, settings = { model: 'gpt-5.4-nano' }) => classifyError(status, error ? { error } : null, settings);

test('errors: a context-length 400 becomes a truncation the caller can recover from', () => {
  const e = err(400, { code: 'context_length_exceeded', message: "This model's maximum context length is 272000 tokens." });
  assert.ok(e instanceof TruncatedError, 'must be recoverable by splitting, not a dead end');
});

test('errors: 401 names the key and points at settings', () => {
  const e = err(401, { code: 'invalid_api_key', message: 'Incorrect API key provided: sk-xxx.' });
  assert.equal(e.kind, 'auth');
  assert.match(e.message, /rejected your API key/i);
  assert.match(e.hint, /settings/i);
  assert.equal(e.retryable, false);
});

test('errors: out of credit is never retried', () => {
  const e = err(429, { code: 'insufficient_quota', message: 'You exceeded your current quota.' });
  assert.equal(e.kind, 'quota');
  assert.equal(e.retryable, false);
  assert.match(e.hint, /billing/i);
});

test('errors: a genuine rate limit is retried', () => {
  const e = err(429, { code: 'rate_limit_exceeded', message: 'Rate limit reached for gpt-5.4-nano.' });
  assert.equal(e.kind, 'rate');
  assert.equal(e.retryable, true);
});

test('errors: a retired model names the model and the remedy', () => {
  const e = err(404, { code: 'model_not_found', message: 'The model `gpt-4o` does not exist.' }, { model: 'gpt-4o' });
  assert.equal(e.kind, 'model');
  assert.match(e.message, /gpt-4o/);
  assert.match(e.hint, /different model/i);
});

test('errors: an unknown route is an endpoint problem, not a model problem', () => {
  assert.equal(err(404, { message: 'Unknown request URL.' }).kind, 'endpoint');
  assert.equal(err(405, null).kind, 'endpoint');
});

test('errors: a server error is retried', () => {
  assert.equal(err(503, null).retryable, true);
});

test('errors: a gateway answering with HTML still produces a message', () => {
  const e = err(502, null);
  assert.ok(e.message.length > 0);
});

/* ---------------------------------------------------------- payload shapes */

const outputText = (text, extra = {}) => ({ type: 'message', content: [{ type: 'output_text', text }], ...extra });

test('responses: reads the message item, not output[0]', () => {
  const data = { status: 'completed', output: [{ type: 'reasoning', summary: [] }, outputText('{"questions":[]}')] };
  assert.equal(parseResponsesPayload(data), '{"questions":[]}');
});

test('responses: a commentary message never wins over the answer', () => {
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

test('responses: status failed reads the top-level error, not the HTTP envelope', () => {
  assert.throws(
    () => parseResponsesPayload({ status: 'failed', error: { code: 'server_error', message: 'Upstream exploded.' } }),
    /Upstream exploded/,
  );
});

test('responses: running out of output tokens is a truncation, not a failure', () => {
  assert.throws(
    () => parseResponsesPayload({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }),
    TruncatedError,
  );
});

test('responses: a refusal is reported as one', () => {
  const data = { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No.' }] }] };
  assert.throws(() => parseResponsesPayload(data), /declined/);
});

test('responses: a gateway that sends output_text is accepted', () => {
  assert.equal(parseResponsesPayload({ status: 'completed', output: [], output_text: '{"questions":[]}' }), '{"questions":[]}');
});

test('chat: finish_reason length is a truncation', () => {
  assert.throws(
    () => parseChatPayload({ choices: [{ finish_reason: 'length', message: { content: '{"quest' } }] }),
    TruncatedError,
  );
});

test('chat: content comes back verbatim', () => {
  assert.equal(parseChatPayload({ choices: [{ finish_reason: 'stop', message: { content: '{"questions":[]}' } }] }), '{"questions":[]}');
});

/* -------------------------------------------------------------- capability */

const caps = () => ({ format: 'json_schema', reasoning: true, verbosity: true, maxTokens: true, temperature: true, store: true });

test('relax: a temperature complaint drops temperature first', () => {
  const c = caps();
  assert.equal(relaxCaps({ status: 400, message: "Unsupported value: 'temperature' does not support 0 with this model." }, c), true);
  assert.equal(c.temperature, false);
  assert.equal(c.format, 'json_schema');
});

test('relax: a max_tokens complaint drops the token cap', () => {
  const c = caps();
  relaxCaps({ status: 400, param: 'max_tokens', code: 'unsupported_parameter', message: "Unsupported parameter: 'max_tokens' is not supported with this model." }, c);
  assert.equal(c.maxTokens, false);
});

test('relax: a schema complaint falls back to plain JSON, then to none', () => {
  const c = caps();
  relaxCaps({ status: 400, message: "Invalid parameter: 'response_format' of type 'json_schema' is not supported." }, c);
  assert.equal(c.format, 'json_object');
  relaxCaps({ status: 400, message: "Invalid parameter: 'response_format' is not supported." }, c);
  assert.equal(c.format, 'none', 'a gateway supporting neither must still be reachable');
});

test('relax: an unrelated 400 never turns request retention back on', () => {
  const c = caps();
  while (relaxCaps({ status: 400, message: 'something unfamiliar' }, c)) { /* drain */ }
  assert.equal(c.store, true, 'store must only come off when the server names it');
});

test('relax: a store complaint does drop it', () => {
  const c = caps();
  relaxCaps({ status: 400, param: 'store', message: "Unknown parameter: 'store'." }, c);
  assert.equal(c.store, false);
});

test('relax: eventually gives up', () => {
  const c = caps();
  let guard = 0;
  while (relaxCaps({ status: 400, message: 'something unfamiliar' }, c)) {
    assert.ok(guard++ < 20, 'relaxCaps must terminate');
  }
  assert.equal(c.format, 'none');
});

/* ------------------------------------------------------------------ format */

test('format: multiple choice shows the option letter', () => {
  assert.equal(formatAnswer({ number: '1', label: 'b', answer: '230.34' }), 'Q1: b) 230.34');
});

test('format: an open question shows just the answer', () => {
  assert.equal(formatAnswer({ number: '4', label: '', answer: '230.34' }), 'Q4: 230.34');
});

test('format: a label that already carries a bracket is not doubled', () => {
  assert.equal(formatAnswer({ number: '2', label: 'c)', answer: 'Neutral' }), 'Q2: c) Neutral');
});

test('format: the whole sheet is one line per question', () => {
  const text = formatAll([{ number: '1', label: 'a', answer: 'One' }, { number: '2', label: '', answer: 'Two' }]);
  assert.equal(text, 'Q1: a) One\nQ2: Two');
});

test('format: questions sort numerically, not lexically', () => {
  const sorted = sortAnswers([{ number: '10' }, { number: '2' }, { number: '1' }]).map((a) => a.number);
  assert.deepEqual(sorted, ['1', '2', '10']);
});

test('format: suffixed numbers stay next to their parent', () => {
  const sorted = sortAnswers([{ number: '3b' }, { number: '3a' }, { number: '2' }]).map((a) => a.number);
  assert.deepEqual(sorted, ['2', '3a', '3b']);
});

/* ------------------------------------------------------------------ prompt */

test('prompt: the strict schema is well formed', () => {
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

test('prompt: page text and course context reach the model', () => {
  const p = buildPrompt({ title: 'Exam 3', url: 'https://x.test', text: '1. A question?', extraInstructions: '2023 NEC', questionCount: 1 });
  assert.match(p.user, /Exam 3/);
  assert.match(p.user, /1\. A question\?/);
  assert.match(p.user, /2023 NEC/);
  assert.doesNotMatch(p.system, /Reply with JSON only/);
});

test('prompt: losing schema enforcement adds the JSON instruction', () => {
  const p = buildPrompt({ text: '1. A question?', schemaEnforced: false });
  assert.match(p.system, /Reply with JSON only/);
});

test('prompt: scraped hints are labelled unverified', () => {
  const p = buildPrompt({ text: '1. A question?', hints: 'answer: b' });
  assert.match(p.user, /unverified/i);
});

/* ------------------------------------------------------------------ report */

for (const [name, err] of failures) {
  console.error(`FAIL  ${name}\n      ${err.message.split('\n')[0]}`);
}
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
