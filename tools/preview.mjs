/*
 * Renders each popup and options state in Chromium and writes a PNG per state,
 * so the UI can be eyeballed without loading the extension.
 *
 *   npm install --no-save playwright-core && node tools/preview.mjs [outDir]
 */

import { chromium } from 'playwright-core';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync } from 'node:fs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = process.argv[2] || path.join(root, 'screenshots');
mkdirSync(outDir, { recursive: true });

const SETTINGS = {
  apiKey: 'sk-test', model: 'gpt-5.4-nano', effort: 'low',
  baseUrl: 'https://api.openai.com/v1', endpoint: 'auto',
  showWhy: true, extraInstructions: '',
};

const ANSWERS = [
  { number: '1', label: 'b', answer: '230.34', why: 'Table 310.16 at 75°C', confidence: 'high' },
  { number: '2', label: 'd', answer: 'The grounded conductor carries unbalanced current', why: '', confidence: 'high' },
  { number: '3', label: '', answer: '4.7 kΩ', why: 'Series resistance adds', confidence: 'high' },
  { number: '4', label: 'a', answer: '12 AWG', why: '', confidence: 'low' },
  { number: '5', label: 'c', answer: 'A raceway installed in a wet location shall be listed for the purpose and sealed at both ends', why: 'Article 300.5(B)', confidence: 'medium' },
];

/** Injected before any page script so the popup's chrome.* calls resolve. */
function stub(state) {
  const listeners = [];
  globalThis.chrome = {
    storage: {
      local: { get: async (d) => ({ ...d, ...state.settings }), set: async () => {} },
      session: {
        get: async (key) => (state.job ? { [key]: state.job } : {}),
        set: async () => {}, remove: async () => {},
      },
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
    tabs: { query: async () => [{ id: 1, url: 'https://example.test/exam' }] },
    runtime: {
      openOptionsPage() {},
      sendMessage: async () => state.scan || { ok: true, questionCount: 12 },
    },
    permissions: { request: async () => false, contains: async () => true },
  };
}

const STATES = {
  'popup-setup': { settings: { ...SETTINGS, apiKey: '' }, job: null },
  'popup-idle': { settings: SETTINGS, job: null },
  'popup-busy': { settings: SETTINGS, job: { status: 'thinking', url: 'https://example.test/exam', progress: { done: 1, total: 3 } } },
  'popup-answers': { settings: SETTINGS, job: { status: 'done', url: 'https://example.test/exam', answers: ANSWERS, meta: { model: 'gpt-5.4-nano', chunks: 1 } } },
  'popup-error': { settings: SETTINGS, job: { status: 'error', url: 'https://example.test/exam', error: { message: 'Your OpenAI account is out of credit.', hint: 'Add credit at platform.openai.com/settings/organization/billing.' } } },
  'popup-frames': { settings: SETTINGS, job: { status: 'error', url: 'https://example.test/exam', error: { message: 'The questions are inside an embedded frame.', hint: 'Chrome needs your permission to read it.', kind: 'frames', origins: ['https://quiz.example.com'] } } },
};

// Module scripts will not load over file:// (opaque origin), so serve the tree.
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.join(root, rel);
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  let body;
  try {
    body = readFileSync(file);
  } catch {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(body);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

for (const scheme of ['light', 'dark']) {
  for (const [name, state] of Object.entries(STATES)) {
    const context = await browser.newContext({ viewport: { width: 300, height: 460 }, colorScheme: scheme, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.addInitScript(stub, state);
    page.on('pageerror', (e) => console.error(`  ${name}: ${e.message}`));
    await page.goto(`${origin}/popup/popup.html`);
    await page.waitForTimeout(350);
    const file = path.join(outDir, `${name}-${scheme}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log('wrote', path.relative(root, file));
    await context.close();
  }

  const context = await browser.newContext({ viewport: { width: 720, height: 900 }, colorScheme: scheme, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.addInitScript(stub, { settings: SETTINGS, job: null });
  page.on('pageerror', (e) => console.error(`  options: ${e.message}`));
  await page.goto(`${origin}/options/options.html`);
  await page.waitForTimeout(350);
  const file = path.join(outDir, `options-${scheme}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log('wrote', path.relative(root, file));
  await context.close();
}

await browser.close();
server.close();
