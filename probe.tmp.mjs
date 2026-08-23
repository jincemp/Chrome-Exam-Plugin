import { chromium } from 'playwright-core';
import http from 'node:http';
import path from 'node:path';
import { readFileSync, mkdirSync } from 'node:fs';

const root = '/home/user/Chrome-Exam-Plugin';
const outDir = '/tmp/claude-0/-home-user-Chrome-Exam-Plugin/c720cb98-5fad-5b6c-8dbc-e271f96d6b91/scratchpad/shots';
mkdirSync(outDir, { recursive: true });

const SETTINGS = {
  apiKey: 'sk-test', model: 'gpt-5.4-nano', effort: 'low',
  baseUrl: 'https://api.openai.com/v1', endpoint: 'auto',
  showWhy: true, extraInstructions: '',
};

const LONG_OPT = 'A raceway installed in a wet location shall be listed for the purpose, sealed at both ends with an approved compound, and supported at intervals not exceeding three feet per 358.30(A) of the code';
const answers = [];
for (let i = 1; i <= 40; i++) {
  answers.push({
    number: String(i),
    label: i % 3 === 0 ? '' : 'b',
    answer: i === 5 ? LONG_OPT : (i === 7 ? 'Supercalifragilisticexpialidocioussupercalifragilisticexpialidocious' : '230.34'),
    why: i % 2 === 0 ? 'Table 310.16 at 75 degrees C ampacity column' : '',
    confidence: i % 4 === 0 ? 'low' : 'high',
  });
}

function stub(state) {
  globalThis.chrome = {
    storage: {
      local: { get: async (d) => ({ ...d, ...state.settings }), set: async () => {} },
      session: { get: async (key) => (state.job ? { [key]: state.job } : {}), set: async () => {}, remove: async () => {} },
      onChanged: { addListener: () => {} },
    },
    tabs: { query: async () => [{ id: 1, url: 'https://example.test/exam' }] },
    runtime: { openOptionsPage() {}, sendMessage: async () => state.scan || { ok: true, questionCount: 12 } },
    permissions: { request: async () => false, contains: async () => true },
  };
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.join(root, rel);
  let body;
  try { body = readFileSync(file); } catch { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

for (const scheme of ['light', 'dark']) {
  const ctx = await browser.newContext({ viewport: { width: 300, height: 600 }, colorScheme: scheme, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.addInitScript(stub, { settings: SETTINGS, job: { status: 'done', url: 'https://example.test/exam', answers, meta: { model: 'gpt-5.4-nano', chunks: 3, missingChunks: 1, truncated: true, windowed: true, unreadable: 2 } } });
  page.on('pageerror', (e) => console.error('ERR', e.message));
  await page.goto(`${origin}/popup/popup.html`);
  await page.waitForTimeout(300);
  const m = await page.evaluate(() => {
    const list = document.getElementById('answers');
    const body = document.body;
    const meta = document.getElementById('answers-meta');
    return {
      bodyScrollW: body.scrollWidth, bodyClientW: document.documentElement.clientWidth,
      docScrollH: document.documentElement.scrollHeight,
      listScrollH: list.scrollHeight, listClientH: list.clientHeight,
      listScrollW: list.scrollWidth, listClientW: list.clientWidth,
      metaText: meta.textContent,
      metaScrollW: meta.scrollWidth, metaClientW: meta.parentElement.clientWidth,
      footScrollW: document.querySelector('.foot').scrollWidth,
      footClientW: document.querySelector('.foot').clientWidth,
      rowTags: [...list.querySelectorAll('.row')].slice(0,6).map(r=>r.tagName),
      hasAriaExpanded: [...list.querySelectorAll('button.row')].every(b=>b.hasAttribute('aria-expanded')),
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      bodyBg: getComputedStyle(document.body).backgroundColor,
    };
  });
  console.log(scheme, JSON.stringify(m, null, 1));
  await page.screenshot({ path: path.join(outDir, `answers40-${scheme}.png`), fullPage: false });
  await ctx.close();
}
await browser.close();
server.close();
