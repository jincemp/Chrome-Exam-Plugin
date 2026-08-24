/*
 * Runs src/extract.js against a saved page in a real browser and prints what the
 * model would receive. For diagnosing a page the extension handled badly:
 *
 *   node tools/inspect.mjs tools/fixtures/moodle-quiz-review.html
 */

import http from 'node:http';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const target = process.argv[2] || 'tools/fixtures/moodle-quiz-review.html';
const html = readFileSync(path.join(root, target), 'utf8');
const EXTRACT = readFileSync(path.join(root, 'src/extract.js'), 'utf8');

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' }).end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/page.html`);
await page.waitForLoadState('domcontentloaded');

const result = await page.evaluate((src) => eval(src), EXTRACT);

console.log('=== SIGNALS ===');
console.log({
  questionCount: result.questionCount,
  truncated: result.truncated,
  windowed: result.windowed,
  unreadable: result.unreadable,
  frameOrigins: result.frameOrigins,
  chars: result.text.length,
  lines: result.text.split('\n').length,
});
console.log('\n=== HINTS ===');
console.log(result.hints || '(none)');
console.log('\n=== TEXT ===');
console.log(result.text);

await browser.close();
server.close();
