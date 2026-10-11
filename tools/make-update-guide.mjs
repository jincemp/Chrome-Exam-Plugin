/*
 * Builds the pictures in docs/how-to-update/ and the PDF of HOW-TO-UPDATE.md,
 * so the guide always shows what the current version really looks like.
 *
 *   npm install --no-save marked && node tools/make-update-guide.mjs
 *   PWSH=/path/to/pwsh node tools/make-update-guide.mjs   # Windows output from the real script too
 *
 * Three sources, in order of trust:
 *   - Chrome's own pages and the extension's popup: real screenshots of the
 *     real extension, loaded from a "Documents/Chrome Extensions" folder so the
 *     path Chrome shows is the one a person will see.
 *   - The updater's window: the real output of updater/update.sh (and of
 *     update.ps1, given pwsh), run against a local copy of the next release.
 *     The "Update now" pictures are the same: Chromium starts the real helper,
 *     which runs the real update.sh.
 *   - Everything a browser cannot show - GitHub's download menu, Finder, File
 *     Explorer, the macOS and Windows security prompts: drawn in
 *     tools/update-guide-sketches.html, tagged "Example", with the folder
 *     listings taken from git.
 */

import { chromium } from 'playwright-core';
import http from 'node:http';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(root, 'docs', 'how-to-update');
const PDF = path.join(OUT, 'How-to-update-Quiz-Answers.pdf');
const CHROMIUM = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
mkdirSync(OUT, { recursive: true });

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

/* -------------------------------------------------------------- versions */

const CURRENT = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')).version;
/** The version people are updating FROM in part A: the last one without the updater. */
const OLD = '1.7.0';
/** The version people are updating FROM in part B: the last one without the Update now button. */
const BEFORE_BUTTON = '1.8.1';
/** A release after this one, for the "a new version is out" pictures. */
const NEXT = (() => { const [a, b] = CURRENT.split('.').map(Number); return `${a}.${b + 1}.0`; })();

/** The most recent commit whose manifest says `version`. */
function commitAt(version) {
  for (const sha of git('log', '--format=%H', '--', 'manifest.json').split('\n').filter(Boolean)) {
    try {
      if (JSON.parse(git('show', `${sha}:manifest.json`)).version === version) return sha;
    } catch { /* a commit where the file did not parse - keep looking */ }
  }
  throw new Error(`no commit with manifest version ${version}`);
}

/** What a download of `ref` shows at its top level: no hidden files. */
function topLevel(ref) {
  return git('ls-tree', ref).split('\n').filter(Boolean).map((line) => {
    const [meta, name] = line.split('\t');
    return { name, dir: meta.split(' ')[1] === 'tree' };
  }).filter((e) => !e.name.startsWith('.'))
    .sort((x, y) => x.name.localeCompare(y.name, 'en', { sensitivity: 'base' }));
}

const visibleFiles = (ref) => new Set(git('ls-tree', '-r', '--name-only', ref).split('\n')
  .filter((f) => f && !f.split('/').some((part) => part.startsWith('.'))));

const oldRef = commitAt(OLD);
const trees = { old: topLevel(oldRef), new: topLevel('HEAD') };
const newFiles = visibleFiles('HEAD');
const counts = {
  new: trees.new.length,
  // What File Explorer counts when the new files are pasted over the old ones.
  same: [...visibleFiles(oldRef)].filter((f) => newFiles.has(f)).length,
};

/* ------------------------------------------------------------- local server */

let published = NEXT;
let latestZip = Buffer.alloc(0);
/** While set, a download of the release waits for it: time to photograph "Updating…". */
let holdDownload = null;
const QUIZ = `<!doctype html><html><head><title>Week 3 quiz</title></head><body style="font: 16px/1.5 Inter, sans-serif; padding: 40px;">
  <h1>Week 3 quiz</h1>
  <p>1. What is 3% less than 240?<br>a) 230.40 &nbsp; b) 232.80 &nbsp; c) 236.40</p>
  <p>2. Which conductor carries the unbalanced current?<br>a) Hot &nbsp; b) Neutral &nbsp; c) Ground</p>
  <p>3. Two 2.2 kΩ resistors and one 300 Ω resistor in series total how much?</p>
</body></html>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/quiz.html') return res.writeHead(200, { 'content-type': 'text/html' }).end(QUIZ);
  if (url.pathname === '/update/manifest.json') {
    return res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' })
      .end(JSON.stringify({ name: 'Quiz Answers', version: published }));
  }
  if (url.pathname === '/latest.zip') {
    return Promise.resolve(holdDownload).then(() => res.writeHead(200, { 'content-type': 'application/zip' }).end(latestZip));
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

/* ---------------------------------------------- the extension, where people keep it */

const scratch = mkdtempSync(path.join(tmpdir(), 'update-guide-'));
const home = path.join(scratch, 'home');
const extDir = path.join(home, 'Documents', 'Chrome Extensions', 'Chrome-Exam-Plugin-main');
// Everything a download has that the extension and its updater use.
for (const entry of ['manifest.json', 'src', 'popup', 'options', 'icons', 'updater', 'Update Quiz Answers.command', 'Update Quiz Answers.bat']) {
  cpSync(path.join(root, entry), path.join(extDir, entry), { recursive: true });
}
chmodSync(path.join(extDir, 'updater', 'native-host.sh'), 0o755);
const manifestPath = path.join(extDir, 'manifest.json');
const baseManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
/**
 * Sets the version on disk. For the popup pictures the extension may also read
 * the local quiz page - but not before, or Chrome's Details page would list a
 * site no one else has.
 */
let quizAccess = false;
const writeVersion = (version) => writeFileSync(manifestPath, JSON.stringify({
  ...baseManifest, version,
  host_permissions: quizAccess ? [...baseManifest.host_permissions, `${origin}/*`] : baseManifest.host_permissions,
}, null, 2));
writeVersion(OLD);

// Ask the local server, not GitHub, what has been published.
const updateJs = path.join(extDir, 'src', 'update.js');
const realUrl = 'https://raw.githubusercontent.com/jincemp/Chrome-Exam-Plugin/main/manifest.json';
if (!readFileSync(updateJs, 'utf8').includes(realUrl)) throw new Error('src/update.js no longer has the URL this script rewrites');
writeFileSync(updateJs, readFileSync(updateJs, 'utf8').replace(realUrl, `${origin}/update/manifest.json`));

const profile = path.join(scratch, 'profile');
const context = await chromium.launchPersistentContext(profile, {
  executablePath: CHROMIUM,
  headless: false,
  args: ['--headless=new', '--no-sandbox', '--hide-scrollbars', `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  // Chrome hands its environment to the helper it starts: the update it runs
  // downloads from this script, and registers itself in this profile.
  env: { ...process.env, HOME: home, QUIZ_ANSWERS_ZIP_URL: `${origin}/latest.zip`, QUIZ_ANSWERS_CHROME_DIRS: profile },
  viewport: { width: 980, height: 470 },
  deviceScaleFactor: 2,
});

const shots = [];
const save = (name) => { shots.push(name); return path.join(OUT, name); };

/**
 * Rings `locator` in orange and, if given, puts a label beside it. Drawn on
 * top of the page, so it works on Chrome's own pages too.
 */
async function mark(page, locator, label, side = 'below', pad = 5) {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`nothing to mark for "${label}"`);
  await page.evaluate(({ box, label, side, pad }) => {
    const ring = document.createElement('div');
    ring.className = '__guide-mark';
    Object.assign(ring.style, {
      position: 'fixed', left: `${box.x - pad}px`, top: `${box.y - pad}px`,
      width: `${box.width + pad * 2}px`, height: `${box.height + pad * 2}px`,
      border: '3px solid #e8590c', borderRadius: '10px', zIndex: 2147483647, pointerEvents: 'none',
      boxSizing: 'border-box',
    });
    document.body.append(ring);
    if (!label) return;
    const tag = document.createElement('div');
    tag.className = '__guide-mark';
    tag.textContent = label;
    Object.assign(tag.style, {
      position: 'fixed', zIndex: 2147483647, whiteSpace: 'nowrap', pointerEvents: 'none',
      font: '700 13px/1 Inter, system-ui, sans-serif', color: '#fff', background: '#e8590c',
      padding: '7px 11px', borderRadius: '999px', boxShadow: '0 1px 3px rgba(0,0,0,.25)',
    });
    document.body.append(tag);
    const t = tag.getBoundingClientRect();
    const at = {
      below: [box.x + box.width / 2 - t.width / 2, box.y + box.height + pad + 8],
      above: [box.x + box.width / 2 - t.width / 2, box.y - pad - 8 - t.height],
      left: [box.x - pad - 10 - t.width, box.y + box.height / 2 - t.height / 2],
      right: [box.x + box.width + pad + 10, box.y + box.height / 2 - t.height / 2],
    }[side];
    tag.style.left = `${Math.max(4, at[0])}px`;
    tag.style.top = `${Math.max(4, at[1])}px`;
  }, { box, label, side, pad });
}
const unmark = (page) => page.evaluate(() => document.querySelectorAll('.__guide-mark').forEach((e) => e.remove()));

/** This sandbox's Chromium is policy-managed; a person's Chrome does not say so. */
async function hideManagedNotice(page) {
  await page.evaluate(() => {
    const walk = (node) => {
      for (const el of node.querySelectorAll('*')) {
        if (el.localName === 'managed-footnote') el.style.display = 'none';
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
  });
}

/**
 * The smallest page area that holds every one of `selectors`, including the
 * labels mark() draws - a label may sit outside the thing it labels.
 */
async function areaOf(page, selectors, margin = 12) {
  const r = await page.evaluate(({ selectors }) => {
    const deep = (sel, node = document) => {
      const found = [...node.querySelectorAll(sel)];
      for (const el of node.querySelectorAll('*')) if (el.shadowRoot) found.push(...deep(sel, el.shadowRoot));
      return found;
    };
    let box = null;
    for (const sel of selectors) {
      for (const el of deep(sel)) {
        for (const e of [el, ...el.querySelectorAll('*')]) {
          const b = e.getBoundingClientRect();
          if (!b.width || !b.height) continue;
          box = box
            ? { l: Math.min(box.l, b.left), t: Math.min(box.t, b.top), r: Math.max(box.r, b.right), b: Math.max(box.b, b.bottom) }
            : { l: b.left, t: b.top, r: b.right, b: b.bottom };
        }
      }
    }
    return box && { ...box, sx: scrollX, sy: scrollY };
  }, { selectors });
  if (!r) throw new Error(`nothing on the page for ${selectors}`);
  const x = Math.max(0, r.l - margin + r.sx);
  const y = Math.max(0, r.t - margin + r.sy);
  return { x, y, width: r.r - r.l + margin * 2, height: r.b - r.t + margin * 2 };
}

try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = new URL(worker.url()).host;

  /* ------------------------------------- part A: chrome://extensions, old version */

  const ext = await context.newPage();
  await ext.goto('chrome://extensions');
  await ext.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
  await ext.reload();
  await ext.waitForTimeout(700);
  await hideManagedNotice(ext);
  const card = ext.locator('extensions-item').first();

  await mark(ext, card.locator('#version'), 'Your version', 'right');
  await ext.screenshot({ path: save('a1-version.png') });
  await unmark(ext);

  await mark(ext, card.locator('#detailsButton'), 'Click Details', 'below');
  await ext.screenshot({ path: save('a2-details.png') });
  await unmark(ext);

  await ext.setViewportSize({ width: 980, height: 640 });
  await ext.goto(`chrome://extensions/?id=${extensionId}`);
  await ext.waitForTimeout(700);
  await hideManagedNotice(ext);
  const loadPath = ext.locator('extensions-detail-view #load-path a').first();
  await loadPath.scrollIntoViewIfNeeded();
  await ext.evaluate(() => {
    // Bring "Source / Loaded from" up the screen, with what is above it for context.
    const view = document.querySelector('extensions-manager').shadowRoot.querySelector('extensions-detail-view');
    view.shadowRoot.querySelector('#load-path').scrollIntoView({ block: 'center' });
  });
  await ext.waitForTimeout(300);
  await mark(ext, loadPath, 'Click the path', 'right');
  await ext.screenshot({ path: save('a3-loaded-from.png') });
  await unmark(ext);

  await ext.setViewportSize({ width: 980, height: 470 });
  await ext.goto('chrome://extensions');
  await ext.waitForTimeout(700);
  await hideManagedNotice(ext);
  await mark(ext, card.locator('#dev-reload-button'), 'Click to reload', 'below');
  await ext.screenshot({ path: save('a5-reload.png') });
  await unmark(ext);

  // The person has copied the new files in and pressed reload.
  quizAccess = true;
  writeVersion(CURRENT);
  await ext.evaluate((id) => chrome.developerPrivate.reload(id, { failQuietly: true }), extensionId);
  await ext.waitForTimeout(1500);
  await ext.reload();
  await ext.waitForTimeout(700);
  await hideManagedNotice(ext);
  await mark(ext, card.locator('#version'), 'The new version', 'right');
  await ext.screenshot({ path: save('a6-new-version.png') });
  await unmark(ext);

  /* ------------------------------------ parts B and C: the popup, before and after */

  const reloadExtension = async () => {
    await ext.evaluate((id) => chrome.developerPrivate.reload(id, { failQuietly: true }), extensionId);
    await ext.waitForTimeout(1500);
  };

  // B: a copy from before the button, just after the double-click put this
  // version in beside it.
  writeVersion(BEFORE_BUTTON);
  await reloadExtension();

  // An open settings page holds back the automatic restart, so the "Restart"
  // state stays on screen long enough to photograph.
  const settingsPage = await context.newPage();
  await settingsPage.goto(`chrome-extension://${extensionId}/options/options.html`);
  await settingsPage.evaluate(() => chrome.storage.local.set({ apiKey: 'sk-example', settingsVersion: 2 }));

  const quiz = await context.newPage();
  await quiz.goto(`${origin}/quiz.html`);
  const [quizTab] = await settingsPage.evaluate((u) => chrome.tabs.query({ url: u }), `${origin}/quiz.html`);

  /** The real popup, for the quiz tab, framed the way it hangs under the toolbar. */
  async function openPopup() {
    const page = await context.newPage();
    await page.setViewportSize({ width: 360, height: 330 });
    await page.addInitScript((id) => {
      const real = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = async (info) => (info.active ? [await chrome.tabs.get(id)] : real(info));
      // "Restarting…" stays 1.2 seconds before the box closes: enough to read, not to photograph.
      const wait = window.setTimeout;
      window.setTimeout = (fn, ms, ...rest) => wait(fn, ms === 1200 ? 6000 : ms, ...rest);
    }, quizTab.id);
    await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await page.waitForTimeout(1500);
    await page.addStyleTag({ content: 'html { background: #eef0f2; padding: 56px 30px 60px; } body { box-shadow: 0 6px 22px rgba(0,0,0,.18); border-radius: 10px; }' });
    return page;
  }
  async function popupShot(page, name, target, label, side, pad) {
    if (target) await mark(page, page.locator(target), label, side, pad);
    await page.screenshot({ path: save(name), clip: await areaOf(page, ['body', '.__guide-mark'], 22) });
    await unmark(page);
  }

  published = NEXT;
  writeVersion(CURRENT); // what the double-click leaves on disk
  let popup = await openPopup();
  await popupShot(popup, 'b5-popup-restart.png', '#get-answers', 'Click', 'above');
  await popup.close();

  // C: this version running, its helper registered as the double-click does
  // it, and a newer one out.
  await reloadExtension();
  mkdirSync(path.join(profile, 'NativeMessagingHosts'), { recursive: true });
  writeFileSync(path.join(profile, 'NativeMessagingHosts', 'com.jincemp.quiz_answers.json'), JSON.stringify({
    name: 'com.jincemp.quiz_answers',
    description: 'Quiz Answers: updates itself when its Update now button is pressed',
    path: path.join(extDir, 'updater', 'native-host.sh'),
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  }, null, 2));

  // The next release, as GitHub would zip it: this folder at version NEXT.
  const stage = path.join(scratch, 'next-release');
  cpSync(extDir, path.join(stage, 'Chrome-Exam-Plugin-main'), { recursive: true });
  const stagedManifest = path.join(stage, 'Chrome-Exam-Plugin-main', 'manifest.json');
  writeFileSync(stagedManifest, JSON.stringify({ ...JSON.parse(readFileSync(stagedManifest, 'utf8')), version: NEXT }, null, 2));
  execFileSync('zip', ['-qr', path.join(stage, 'next.zip'), 'Chrome-Exam-Plugin-main'], { cwd: stage });
  latestZip = readFileSync(path.join(stage, 'next.zip'));

  let letDownloadFinish;
  holdDownload = new Promise((resolve) => { letDownloadFinish = resolve; });
  const updateText = () => popup.evaluate(() => document.getElementById('update-text')?.textContent || '');
  popup = await openPopup();
  await popup.waitForFunction(() => document.getElementById('update-action')?.textContent === 'Update now', null, { timeout: 15000 });
  // A tight ring: the text right before it is part of the message.
  await popupShot(popup, 'c1-update-now.png', '#update-action', 'Click', 'below', 2);
  await popup.click('#update-action');
  await popup.waitForFunction(() => /^Updating to /.test(document.getElementById('update-text')?.textContent || ''));
  await popupShot(popup, 'c2-updating.png');
  letDownloadFinish();
  await popup.waitForFunction(() => /Restarting|did not|helper/.test(document.getElementById('update-text')?.textContent || ''), null, { timeout: 60000 });
  const said = await updateText();
  if (!said.startsWith(`Updated Quiz Answers from ${CURRENT} to ${NEXT}.`)) throw new Error(`"Update now" did not update: ${said}`);
  await popupShot(popup, 'c3-restarting.png');
  holdDownload = null;
  await popup.waitForEvent('close', { timeout: 20000 }).catch(() => {});
  await settingsPage.close().catch(() => { /* closed by the restart */ });

  /* --------------------------------------------------- the updater's real output */

  const release = path.join(scratch, 'release');
  mkdirSync(release);
  execFileSync('sh', ['-c', `git -C "${root}" archive --prefix=Chrome-Exam-Plugin-main/ HEAD | tar -x -C "${release}"`]);
  const relManifest = path.join(release, 'Chrome-Exam-Plugin-main', 'manifest.json');
  writeFileSync(relManifest, readFileSync(relManifest, 'utf8').replace(`"version": "${CURRENT}"`, `"version": "${NEXT}"`));
  execFileSync('zip', ['-qr', path.join(scratch, 'latest.zip'), 'Chrome-Exam-Plugin-main'], { cwd: release });
  latestZip = readFileSync(path.join(scratch, 'latest.zip'));

  /** Runs one updater against a fresh copy of this version and returns what it printed. */
  function runUpdater(cmd, script) {
    const where = path.join(scratch, `installed-${path.basename(script)}`, 'Chrome-Exam-Plugin-main');
    mkdirSync(where, { recursive: true });
    execFileSync('sh', ['-c', `git -C "${root}" archive HEAD | tar -x -C "${where}"`]);
    // Asynchronous: the ZIP comes from this process's own server.
    return new Promise((resolve, reject) => {
      // Registered somewhere harmless, so the window ends as it does on a
      // person's computer: with the line about the Update now button.
      const registry = path.join(scratch, `registered-${path.basename(script)}`);
      mkdirSync(registry, { recursive: true });
      const child = execFileAsync(cmd, [...(cmd.endsWith('bash') ? [] : ['-NoProfile', '-NonInteractive', '-File']), path.join(where, 'updater', script)],
        { ...process.env, QUIZ_ANSWERS_ZIP_URL: `${origin}/latest.zip`, QUIZ_ANSWERS_CHROME_DIRS: registry, QUIZ_ANSWERS_NATIVE_DIR: registry });
      child.then(({ code, out }) => (code === 0 ? resolve(out) : reject(new Error(`${script} exited ${code}:\n${out}`))));
    });
  }

  const macOut = `${(await runUpdater('/bin/bash', 'update.sh')).trimEnd()}\n\nPress Return to close this window. `;
  const pwsh = process.env.PWSH || (spawnSync('sh', ['-c', 'command -v pwsh'], { encoding: 'utf8' }).stdout || '').trim();
  // The Windows script prints the same lines; given pwsh, use its own output.
  const winOut = `${(pwsh ? await runUpdater(pwsh, 'update.ps1') : macOut.replace(/\n\nPress Return.*$/s, '')).trimEnd()}\n\nPress Enter to close this window: `;
  if (!pwsh) console.log('note: no pwsh - the Windows window shows the Mac script\'s lines, which are the same text');

  /* --------------------------------------------------------------- the sketches */

  const sketch = await context.newPage();
  await sketch.setViewportSize({ width: 1100, height: 900 });
  await sketch.goto(pathToFileURL(path.join(root, 'tools', 'update-guide-sketches.html')).href);
  await sketch.evaluate(({ trees, counts, macOut, winOut }) => {
    window.renderSketches({ trees, counts });
    document.querySelector('[data-output="mac"]').textContent = macOut;
    document.querySelector('[data-output="windows"]').textContent = winOut;
  }, { trees, counts, macOut, winOut });
  for (const id of await sketch.evaluate(() => [...document.querySelectorAll('figure[id]')].map((f) => f.id))) {
    await sketch.locator(`#${id}`).scrollIntoViewIfNeeded();
    await sketch.screenshot({ path: save(`${id}.png`), fullPage: true, clip: await areaOf(sketch, [`#${id}`], 6) });
  }
  await sketch.close();

  /* ----------------------------------------------------------------- the PDF */

  const { marked } = await import('marked');
  // Headings get the same ids GitHub gives them, so the guide's links work in the PDF too.
  const slugs = new Map();
  marked.use({
    renderer: {
      heading({ tokens, depth, text }) {
        const base = text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s/g, '-');
        const n = slugs.get(base) || 0;
        slugs.set(base, n + 1);
        return `<h${depth} id="${n ? `${base}-${n}` : base}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
    },
  });
  // The link to this very PDF is for the web page only.
  const guide = readFileSync(path.join(root, 'HOW-TO-UPDATE.md'), 'utf8')
    .replace(/<!-- web-only -->[\s\S]*?<!-- \/web-only -->/g, '');
  const pdfPage = await context.newPage();
  const pdfHtml = path.join(scratch, 'guide.html');
  writeFileSync(pdfHtml, `<!doctype html><html><head><meta charset="utf-8">
    <base href="${pathToFileURL(root + '/').href}">
    <style>
      @page { size: A4; margin: 16mm 15mm; }
      body { font: 11.5pt/1.5 Inter, system-ui, sans-serif; color: #1d1f23; }
      h1 { font-size: 22pt; margin: 0 0 6pt; }
      h2 { font-size: 15pt; margin: 0 0 6pt; break-after: avoid; }
      /* Each part starts on its own page, so a printout can be handed over in pieces. */
      h2:not(:first-of-type) { break-before: page; }
      h3 { font-size: 12.5pt; margin: 14pt 0 4pt; break-after: avoid; }
      img { zoom: .8; max-width: 100%; height: auto; display: block; margin: 6pt 0 10pt; break-inside: avoid; }
      /* "On a Mac:" and the like stay on the page with the picture they introduce. */
      p:has(> strong:only-child), p:has(+ p > img), li > p:has(+ img) { break-after: avoid; }
      hr { display: none; }
      code { font: 10pt 'DejaVu Sans Mono', monospace; background: #f1f2f4; padding: 1px 4px; border-radius: 3px; }
      blockquote { margin: 8pt 0; padding: 6pt 12pt; border-left: 3px solid #e8590c; background: #fbf3ee; }
      table { border-collapse: collapse; } td, th { border: 1px solid #dfe1e4; padding: 4pt 8pt; text-align: left; }
      a { color: #1d1f23; }
      kbd { font: 600 9.5pt Inter, sans-serif; border: 1px solid #c9ccd1; border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; }

    </style></head><body>${marked.parse(guide)}</body></html>`);
  // Opened from disk, not set as content: only a file page may load the pictures beside it.
  await pdfPage.goto(pathToFileURL(pdfHtml).href, { waitUntil: 'load' });
  const missing = await pdfPage.evaluate(() => [...document.images].filter((i) => !i.naturalWidth).map((i) => i.getAttribute('src')));
  if (missing.length) throw new Error(`pictures missing from the PDF: ${missing.join(', ')}`);
  const broken = await pdfPage.evaluate(() => [...document.querySelectorAll('a[href^="#"]')]
    .map((a) => a.getAttribute('href')).filter((h) => !document.getElementById(decodeURIComponent(h.slice(1)))));
  if (broken.length) throw new Error(`links in the guide that go nowhere: ${broken.join(', ')}`);
  await pdfPage.pdf({ path: PDF, format: 'A4', printBackground: true, margin: { top: '16mm', bottom: '16mm', left: '15mm', right: '15mm' } });
  await pdfPage.close();

  console.log(`wrote ${shots.length} pictures and ${path.relative(root, PDF)}`);
  console.log(`  old ${OLD} (${oldRef.slice(0, 7)}), current ${CURRENT}, next ${NEXT}; ${counts.new} items, ${counts.same} same-named files`);
} finally {
  await context.close();
  server.close();
  rmSync(scratch, { recursive: true, force: true });
}

/** spawn, collecting stdout and stderr together, without blocking the server above. */
function execFileAsync(cmd, args, env) {
  return import('node:child_process').then(({ spawn }) => new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  }));
}
