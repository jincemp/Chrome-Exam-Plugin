/*
 * Tests for the updaters: updater/update.sh, behind "Update Quiz Answers.command"
 * on a Mac, and updater/update.ps1, behind "Update Quiz Answers.bat" on Windows.
 *
 * Each case builds a throwaway "installed" copy of the extension, serves a
 * "latest" GitHub-style ZIP from a local server, runs the real script against
 * it with real curl and unzip, and checks what is left on disk. The cases
 * that matter most are the failures: every one of them must leave the folder
 * byte-for-byte as it was, because that folder is what Chrome is running.
 *
 *   node tools/updater-test.mjs
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, appendFileSync,
} from 'node:fs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHIPPED = ['manifest.json', 'src', 'popup', 'options', 'icons', 'updater', 'Update Quiz Answers.command', 'Update Quiz Answers.bat'];

/*
 * The same cases run against both updaters, which are written to behave
 * identically - any case that passes for one and fails for the other is a bug
 * in one of them. PowerShell runs when a pwsh binary is found (PWSH=/path/to/pwsh,
 * or pwsh on PATH). That is PowerShell 7, not the Windows PowerShell 5.1 the
 * .bat launches, so it proves the logic, not every 5.1 quirk.
 */
const ENGINES = [{ label: 'mac', script: 'update.sh', helper: 'native-host.sh', cmd: (f) => ['bash', [f]] }];
const pwsh = process.env.PWSH || (spawnSync('sh', ['-c', 'command -v pwsh'], { encoding: 'utf8' }).stdout || '').trim();
if (pwsh) {
  ENGINES.push({ label: 'windows', script: 'update.ps1', helper: 'native-host.ps1', cmd: (f) => [pwsh, ['-NoProfile', '-NonInteractive', '-File', f]] });
} else {
  console.log('note: no pwsh found - the Windows updater (update.ps1) is NOT being tested this run');
}
let engine = ENGINES[0];

let passed = 0;
const failures = [];
async function test(name, fn) {
  const label = `[${engine.label}] ${name}`;
  try {
    await fn();
    passed++;
    console.log(`ok   ${label}`);
  } catch (err) {
    failures.push(label);
    console.error(`FAIL ${label}\n     ${String(err.message).split('\n').slice(0, 30).join('\n     ')}`);
  }
}

/* ------------------------------------------------------------- fixtures */

const scratch = mkdtempSync(path.join(tmpdir(), 'updater-test-'));

function setVersion(dir, version, name = 'Quiz Answers') {
  const file = path.join(dir, 'manifest.json');
  const m = JSON.parse(readFileSync(file, 'utf8'));
  m.version = version;
  m.name = name;
  writeFileSync(file, JSON.stringify(m, null, 2) + '\n');
}

/**
 * An installed copy, at a path with spaces in it, as the README suggests - and
 * square brackets, which PowerShell reads as wildcards wherever a path is not
 * passed as a literal one.
 */
function installed(version = '1.7.0') {
  const dir = mkdtempSync(path.join(scratch, 'Chrome Extensions [old] '));
  const ext = path.join(dir, 'Chrome-Exam-Plugin-main');
  mkdirSync(ext);
  for (const entry of SHIPPED) {
    if (existsSync(path.join(root, entry))) cpSync(path.join(root, entry), path.join(ext, entry), { recursive: true });
  }
  setVersion(ext, version);
  // Something the user put there themselves. An update must never touch it.
  writeFileSync(path.join(ext, 'my notes.txt'), 'mine\n');
  return ext;
}

/**
 * A ZIP shaped like GitHub's "Download ZIP": one top-level folder, the
 * extension inside it. `tweak` edits the tree before it is zipped.
 */
function latestZip(version, tweak = () => {}) {
  const dir = mkdtempSync(path.join(scratch, 'latest-'));
  const top = path.join(dir, 'Chrome-Exam-Plugin-main');
  mkdirSync(top);
  for (const entry of SHIPPED) {
    if (existsSync(path.join(root, entry))) cpSync(path.join(root, entry), path.join(top, entry), { recursive: true });
  }
  setVersion(top, version);
  // Make every entry of a release differ from the installed copy. Without
  // this, most of the "new" files are byte-identical to the old ones, and a
  // swap that skipped its rollback would leave nothing a snapshot could see -
  // which is exactly how the rollback tests once passed with rollback disabled.
  for (const entry of readdirSync(top)) {
    const p = path.join(top, entry);
    if (statSync(p).isDirectory()) writeFileSync(path.join(p, 'release-marker.txt'), version);
    else if (entry.endsWith('.command')) appendFileSync(p, `\n# release ${version}\n`);
    else if (entry.endsWith('.bat')) appendFileSync(p, `\r\nREM release ${version}\r\n`);
  }
  tweak(top);
  const zip = path.join(dir, 'latest.zip');
  const r = spawnSync('zip', ['-qr', zip, 'Chrome-Exam-Plugin-main'], { cwd: dir });
  assert.equal(r.status, 0, `zip failed: ${r.stderr}`);
  return readFileSync(zip);
}

/** Every file under dir, relative path -> sha1, so "unchanged" means unchanged. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[path.relative(dir, p)] = createHash('sha1').update(readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

let served = { status: 200, body: Buffer.alloc(0) };
let downloads = 0;
const server = http.createServer((req, res) => {
  downloads++;
  res.writeHead(served.status, { 'content-type': 'application/zip' }).end(served.body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ZIP_URL = `http://127.0.0.1:${server.address().port}/main.zip`;

/**
 * Runs the shipped script the way the launcher does, with no terminal attached.
 * Asynchronous on purpose: the ZIP is served from this same process, and a
 * spawnSync would block the event loop so the server could never answer curl.
 */
function runUpdater(ext, env = {}, cmd = engine.cmd) {
  return new Promise((resolve) => {
    const [bin, args] = cmd(path.join(ext, 'updater', engine.script));
    const child = spawn(bin, args, {
      env: { ...process.env, QUIZ_ANSWERS_ZIP_URL: ZIP_URL, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, out }); });
  });
}

/**
 * Talks to the "Update now" helper the way Chrome does: a 4-byte little-endian
 * length, then JSON, in each direction. Returns the decoded reply, and
 * whatever came after it on stdout, which must be nothing.
 */
function runHelper(helper, message, env = {}) {
  return new Promise((resolve) => {
    const [bin, args] = engine.cmd(helper);
    // Where Chrome starts it: in the helper's own folder.
    const child = spawn(bin, args, {
      cwd: path.dirname(helper),
      env: { ...process.env, QUIZ_ANSWERS_ZIP_URL: ZIP_URL, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks = [];
    let err = '';
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
    child.on('close', (status) => {
      clearTimeout(timer);
      const out = Buffer.concat(chunks);
      let reply = null;
      let extra = out.length;
      if (out.length >= 4) {
        const n = out.readUInt32LE(0);
        try { reply = JSON.parse(out.subarray(4, 4 + n).toString('utf8')); } catch { /* left null */ }
        extra = out.length - 4 - n;
      }
      resolve({ status, reply, extra, err });
    });
    const body = Buffer.from(typeof message === 'string' ? message : JSON.stringify(message), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length);
    child.stdin.end(Buffer.concat([head, body]));
  });
}

/**
 * Where each updater registers the helper, given its test hooks. The Mac one
 * also puts the helper itself, and the launcher it opens, in `home`.
 */
function helperRegistration(where) {
  const home = `${where} helper`; // beside, not inside: creating it must not create a Chrome folder
  return engine.label === 'mac'
    ? { env: { QUIZ_ANSWERS_CHROME_DIRS: where, QUIZ_ANSWERS_HELPER_HOME: home }, file: path.join(where, 'NativeMessagingHosts', 'com.jincemp.quiz_answers.json'), home }
    : { env: { QUIZ_ANSWERS_NATIVE_DIR: where }, file: path.join(where, 'com.jincemp.quiz_answers.json') };
}

/**
 * The helper Chrome would start for `ext`, set up as a person's double-click
 * sets it up: a run of the updater with nothing newer to install. On a Mac
 * that copies it out of the folder; on Windows it stays in updater\.
 */
async function helperFor(ext) {
  if (engine.label === 'windows') return path.join(ext, 'updater', engine.helper);
  const reg = helperRegistration(mkdtempSync(path.join(scratch, 'chrome-')));
  const before = served;
  served = { status: 200, body: latestZip(versionIn(ext)) };
  const { status, out } = await runUpdater(ext, reg.env);
  served = before;
  assert.equal(status, 0, out);
  return path.join(reg.home, engine.helper);
}

/** Chrome's ID for an extension loaded unpacked from `dir` (on Mac and Linux: the path's UTF-8 bytes). */
const extensionIdOf = (dir) => [...createHash('sha256').update(realpathSync(dir)).digest('hex').slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');

const noLeftovers = (ext) => {
  assert.equal(existsSync(path.join(ext, '.update-new')), false, 'staging folder left behind');
  assert.equal(existsSync(path.join(ext, '.update-old')), false, 'backup folder left behind');
  assert.equal(existsSync(path.join(ext, '.update-trash')), false, 'trash folder left behind');
};

const versionIn = (ext) => JSON.parse(readFileSync(path.join(ext, 'manifest.json'), 'utf8')).version;

/* ---------------------------------------------------------------- cases */

async function cases() {

await test('a newer version is installed in place', async () => {
  const ext = installed('1.7.0');
  served = {
    status: 200,
    body: latestZip('9.9.9', (top) => {
      appendFileSync(path.join(top, 'src', 'update.js'), '\n// marker: new code arrived\n');
      mkdirSync(path.join(top, 'brand-new-folder'));
      writeFileSync(path.join(top, 'brand-new-folder', 'x.txt'), 'x');
    }),
  };
  const { status, out } = await runUpdater(ext);
  assert.equal(status, 0, out);
  assert.equal(versionIn(ext), '9.9.9');
  assert.match(readFileSync(path.join(ext, 'src', 'update.js'), 'utf8'), /marker: new code arrived/);
  assert.ok(existsSync(path.join(ext, 'brand-new-folder', 'x.txt')), 'a folder new in this version must arrive too');
  assert.match(out, /Updated Quiz Answers from 1\.7\.0 to 9\.9\.9/);
  noLeftovers(ext);
});

await test('manifest.json is the very last file to change', async () => {
  // The extension restarts itself when the manifest's version changes. If the
  // manifest went first, it could restart onto half-replaced code.
  const ext = installed('1.7.0');
  const trace = path.join(scratch, `trace-${engine.label}-${passed}.txt`);
  served = { status: 200, body: latestZip('9.9.9') };
  assert.equal((await runUpdater(ext, { QUIZ_ANSWERS_TRACE: trace })).status, 0);
  const order = readFileSync(trace, 'utf8').trim().split(/\r?\n/);
  assert.ok(order.length > 3, `expected several swaps, got ${order.join(', ')}`);
  assert.equal(order.at(-1), 'manifest.json', `swap order was: ${order.join(', ')}`);
  assert.equal(order.filter((n) => n === 'manifest.json').length, 1);
});

await test('files the user added to the folder survive an update', async () => {
  const ext = installed('1.7.0');
  served = { status: 200, body: latestZip('9.9.9') };
  assert.equal((await runUpdater(ext)).status, 0);
  assert.equal(readFileSync(path.join(ext, 'my notes.txt'), 'utf8'), 'mine\n');
});

await test('the script survives replacing its own file mid-run', async () => {
  // bash reads a script as it runs it. If the whole thing were not inside
  // functions, overwriting update.sh partway through would run garbage.
  const ext = installed('1.7.0');
  served = {
    status: 200,
    body: latestZip('9.9.9', (top) => {
      const f = path.join(top, 'updater', engine.script);
      const poison = engine.script.endsWith('.sh')
        ? '#!/bin/bash\necho "THIS IS THE NEW SCRIPT AND MUST NOT RUN NOW"\nexit 7\n'
        : 'Write-Host "THIS IS THE NEW SCRIPT AND MUST NOT RUN NOW"\nexit 7\n';
      writeFileSync(f, poison + readFileSync(f, 'utf8'));
    }),
  };
  const { status, out } = await runUpdater(ext);
  assert.equal(status, 0, out);
  assert.doesNotMatch(out, /MUST NOT RUN NOW/);
  assert.match(readFileSync(path.join(ext, 'updater', engine.script), 'utf8'), /MUST NOT RUN NOW/, 'and the new copy is in place for next time');
});

await test('the double-click launcher survives an update intact', async () => {
  const ext = installed('1.7.0');
  served = { status: 200, body: latestZip('9.9.9') };
  assert.equal((await runUpdater(ext)).status, 0);
  if (engine.label === 'mac') {
    const mode = statSync(path.join(ext, 'Update Quiz Answers.command')).mode;
    assert.ok(mode & 0o100, `launcher lost its executable bit: ${(mode & 0o777).toString(8)}`);
  } else {
    // cmd.exe reads a running .bat by byte offset, and the script it launches
    // replaces that very file - so the whole thing must stay one line.
    const bat = readFileSync(path.join(ext, 'Update Quiz Answers.bat'), 'latin1');
    const lines = bat.split('\r\n').filter((l) => l && !l.startsWith('REM release'));
    assert.equal(lines.length, 1, `the .bat must be a single line, got:\n${bat}`);
    assert.match(lines[0], /& exit \/b$/);
  }
});

await test('already up to date: nothing changes', async () => {
  const ext = installed('9.9.9');
  served = { status: 200, body: latestZip('9.9.9', (top) => appendFileSync(path.join(top, 'src', 'update.js'), '// would be a change')) };
  const before = snapshot(ext);
  const { status, out } = await runUpdater(ext);
  assert.equal(status, 0, out);
  assert.match(out, /already have the latest version \(9\.9\.9\)/);
  assert.deepEqual(snapshot(ext), before);
  noLeftovers(ext);
});

await test('an older version on GitHub is never installed over a newer one', async () => {
  const ext = installed('9.9.9');
  served = { status: 200, body: latestZip('1.0.0') };
  const before = snapshot(ext);
  assert.equal((await runUpdater(ext)).status, 0);
  assert.deepEqual(snapshot(ext), before);
});

await test('1.10.0 counts as newer than 1.9.0', async () => {
  const ext = installed('1.9.0');
  served = { status: 200, body: latestZip('1.10.0') };
  assert.equal((await runUpdater(ext)).status, 0);
  assert.equal(versionIn(ext), '1.10.0');
});

/** Every failure must leave the folder exactly as it was. */
async function unchangedOnFailure(ext, setup, expect) {
  setup();
  const before = snapshot(ext);
  const { status, out } = await runUpdater(ext, expect.env);
  assert.equal(status, 1, `expected failure, got ${status}\n${out}`);
  if (expect.message) assert.match(out, expect.message);
  assert.deepEqual(snapshot(ext), before, 'the folder changed despite the failure');
  noLeftovers(ext);
}

await test('no internet / download fails: unchanged', async () => {
  const ext = installed('1.7.0');
  await unchangedOnFailure(ext, () => { served = { status: 404, body: Buffer.from('nope') }; }, { message: /could not download/ });
});

await test('a damaged download: unchanged', async () => {
  const ext = installed('1.7.0');
  await unchangedOnFailure(ext, () => { served = { status: 200, body: Buffer.from('this is not a zip file at all') }; }, { message: /damaged/ });
});

await test('a download of some other project: unchanged', async () => {
  const ext = installed('1.7.0');
  await unchangedOnFailure(ext, () => {
    served = { status: 200, body: latestZip('9.9.9', (top) => setVersion(top, '9.9.9', 'Something Else')) };
  }, { message: /does not look like Quiz Answers/ });
});

await test('a failure partway through the swap is fully rolled back', async () => {
  const ext = installed('1.7.0');
  await unchangedOnFailure(ext, () => { served = { status: 200, body: latestZip('9.9.9') }; }, {
    env: { QUIZ_ANSWERS_FAIL_AFTER: '3' },
    message: /Nothing was changed/,
  });
});

await test('a failure at the very last step, manifest.json, is rolled back too', async () => {
  const ext = installed('1.7.0');
  // Everything shipped except manifest.json, plus the user's file which is not
  // in the ZIP: the hook fires exactly when manifest.json is up.
  const entries = SHIPPED.filter((e) => e !== 'manifest.json' && existsSync(path.join(root, e))).length;
  await unchangedOnFailure(ext, () => { served = { status: 200, body: latestZip('9.9.9') }; }, {
    env: { QUIZ_ANSWERS_FAIL_AFTER: String(entries) },
    message: /could not replace manifest\.json/,
  });
});

await test('refuses to run outside a Quiz Answers folder', async () => {
  const stray = mkdtempSync(path.join(scratch, 'not-the-extension-'));
  cpSync(path.join(root, 'updater'), path.join(stray, 'updater'), { recursive: true });
  writeFileSync(path.join(stray, 'precious.txt'), 'do not touch');
  served = { status: 200, body: latestZip('9.9.9') };
  const before = snapshot(stray);
  const { status, out } = await runUpdater(stray);
  assert.equal(status, 1, out);
  assert.match(out, /does not look like the Quiz Answers folder/);
  assert.deepEqual(snapshot(stray), before);
});

await test('refuses to overwrite a git checkout', async () => {
  const ext = installed('1.7.0');
  await unchangedOnFailure(ext, () => {
    mkdirSync(path.join(ext, '.git'));
    served = { status: 200, body: latestZip('9.9.9') };
  }, { message: /git pull/ });
});

await test('a run cut off mid-swap is repaired by the next run', async () => {
  // Simulate the worst moment to lose power: popup/ already moved aside into
  // the backup, its replacement not yet moved in.
  const ext = installed('9.9.9');
  mkdirSync(path.join(ext, '.update-old'));
  cpSync(path.join(ext, 'popup'), path.join(ext, '.update-old', 'popup'), { recursive: true });
  rmSync(path.join(ext, 'popup'), { recursive: true });
  served = { status: 200, body: latestZip('9.9.9') };
  const { status, out } = await runUpdater(ext);
  assert.equal(status, 0, out);
  assert.ok(existsSync(path.join(ext, 'popup', 'popup.js')), 'the moved-aside folder must be put back, not deleted');
  noLeftovers(ext);
});

await test('closing the window mid-swap loses nothing', async () => {
  // The worst moment: one old entry moved aside into the backup, its
  // replacement not yet in. On a Mac, closing Terminal makes bash run its
  // cleanup, which once deleted that backup - the only copy left.
  const ext = installed('1.7.0');
  const top = readdirSync(ext).sort();
  const before = snapshot(ext);
  served = { status: 200, body: latestZip('9.9.9') };
  const quit = await runUpdater(ext, { QUIZ_ANSWERS_QUIT_AFTER: '2' });
  assert.notEqual(quit.status, 0, `the hook should have ended the run:\n${quit.out}`);
  const aside = readdirSync(path.join(ext, '.update-old'));
  assert.equal(aside.length, 3, `expected three entries in the backup, found: ${aside.join(', ')}`);
  assert.ok(top.some((n) => !existsSync(path.join(ext, n))), 'the hook should have left an entry moved aside');

  // Offline next time: the folder is still made whole again - all of the old
  // version, not some of each.
  served = { status: 404, body: Buffer.from('nope') };
  const offline = await runUpdater(ext);
  assert.equal(offline.status, 1, offline.out);
  assert.match(offline.out, /on version 1\.7\.0 again/);
  assert.deepEqual(snapshot(ext), before, 'the folder is not back to the version it had');
  noLeftovers(ext);

  // And online, it finishes the update.
  served = { status: 200, body: latestZip('9.9.9') };
  const { status, out } = await runUpdater(ext);
  assert.equal(status, 0, out);
  assert.equal(versionIn(ext), '9.9.9');
  assert.equal(readFileSync(path.join(ext, 'my notes.txt'), 'utf8'), 'mine\n');
  noLeftovers(ext);
});

await test('a rollback that could not put everything back is finished by the next run', async () => {
  // Say a file was held open and the undo could not move it. The old copies
  // then sit in the backup, and must never be thrown away with it.
  const ext = installed('1.7.0');
  const before = snapshot(ext);
  served = { status: 200, body: latestZip('9.9.9') };
  const first = await runUpdater(ext, { QUIZ_ANSWERS_FAIL_AFTER: '3', QUIZ_ANSWERS_FAIL_UNDO: '1' });
  assert.equal(first.status, 1, first.out);
  assert.match(first.out, /could not be put back yet/);
  assert.doesNotMatch(first.out, /Nothing was changed/);
  assert.equal(readdirSync(path.join(ext, '.update-old')).length, 3);

  served = { status: 404, body: Buffer.from('nope') };
  const offline = await runUpdater(ext);
  assert.equal(offline.status, 1, offline.out);
  assert.deepEqual(snapshot(ext), before, 'the next run must put the old version back whole');
  noLeftovers(ext);
});

await test('a finished update whose backup could not be cleared away is not undone', async () => {
  const ext = installed('9.9.9');
  appendFileSync(path.join(ext, 'src', 'update.js'), '\n// the new code\n');
  mkdirSync(path.join(ext, '.update-old', 'src'), { recursive: true });
  writeFileSync(path.join(ext, '.update-old', 'src', 'update.js'), '// the OLD code\n');
  writeFileSync(path.join(ext, '.update-old', '.finished'), '');
  served = { status: 200, body: latestZip('9.9.9') };
  const { status, out } = await runUpdater(ext);
  assert.equal(status, 0, out);
  assert.match(readFileSync(path.join(ext, 'src', 'update.js'), 'utf8'), /the new code/);
  noLeftovers(ext);
});

/* ------------------------------------------------- the "Update now" helper */

await test('a run registers the "Update now" helper, for this copy only', async () => {
  const ext = installed('9.9.9');
  const chrome = mkdtempSync(path.join(scratch, 'chrome-'));
  const reg = helperRegistration(chrome);
  served = { status: 200, body: latestZip('9.9.9') };
  const { status, out } = await runUpdater(ext, reg.env);
  assert.equal(status, 0, out);
  assert.match(out, /click "Update now"/);
  const m = JSON.parse(readFileSync(reg.file, 'utf8'));
  assert.equal(m.name, 'com.jincemp.quiz_answers');
  assert.equal(m.type, 'stdio');
  if (engine.label === 'mac') {
    // Outside the folder, which macOS may keep it out of; the launcher it opens points back in.
    assert.equal(m.path, path.join(reg.home, 'native-host.sh'));
    assert.equal(readFileSync(m.path, 'utf8'), readFileSync(path.join(ext, 'updater', 'native-host.sh'), 'utf8'));
    const launcher = path.join(reg.home, 'Update Quiz Answers.command');
    assert.ok(statSync(launcher).mode & 0o100, 'Terminal only runs an executable .command');
    assert.match(readFileSync(launcher, 'utf8'), /^exec \/bin\/bash .*\/updater\/update\.sh$/m);
  } else {
    assert.match(m.path.replace(/\\/g, '/'), /\/updater\/native-host\.bat$/);
    assert.ok(m.path.replace(/\\/g, '/').startsWith(realpathSync(ext)), `the helper must be the one in this folder: ${m.path}`);
  }
  assert.ok(m.allowed_origins.includes(`chrome-extension://${extensionIdOf(ext)}/`), `Chrome's ID for this copy is missing: ${m.allowed_origins}`);
  // Spare spellings of this copy's own path at most: never another extension.
  assert.ok(m.allowed_origins.length <= 3 && new Set(m.allowed_origins).size === m.allowed_origins.length, String(m.allowed_origins));
  for (const o of m.allowed_origins) assert.match(o, /^chrome-extension:\/\/[a-p]{32}\/$/);
  if (engine.label === 'mac') assert.ok(statSync(m.path).mode & 0o100, 'Chrome can only start an executable helper');
});

await test('no Chrome to register with: no button, and the update still works', async () => {
  const ext = installed('1.7.0');
  const reg = helperRegistration(path.join(scratch, 'no-such-chrome', String(passed)));
  served = { status: 200, body: latestZip('9.9.9') };
  const { status, out } = await runUpdater(ext, engine.label === 'mac' ? reg.env : { QUIZ_ANSWERS_NATIVE_DIR: '/proc/no-writing-here' });
  assert.equal(status, 0, out);
  assert.equal(versionIn(ext), '9.9.9');
  assert.doesNotMatch(out, /Update now/);
});

await test('the helper answers a ping in exactly one framed reply', async () => {
  const ext = installed('1.7.0');
  const { reply, extra, err } = await runHelper(await helperFor(ext), { type: 'ping' });
  assert.deepEqual(reply, { ok: true, helper: 1 }, err);
  assert.equal(extra, 0, 'nothing but the reply may reach Chrome');
});

await test('"Update now" through the helper updates the folder, and says so', async () => {
  // The update replaces updater/, and so the very helper that is running it.
  const ext = installed('1.7.0');
  const helper = await helperFor(ext);
  served = { status: 200, body: latestZip('9.9.9') };
  const { reply, extra, err } = await runHelper(helper, { type: 'update' });
  assert.equal(reply?.ok, true, `${JSON.stringify(reply)}\n${err}`);
  assert.equal(reply.summary, 'Updated Quiz Answers from 1.7.0 to 9.9.9.');
  assert.equal(extra, 0);
  assert.equal(versionIn(ext), '9.9.9');
  noLeftovers(ext);
});

await test('a failed update through the helper comes back as a failure, with the reason', async () => {
  const ext = installed('1.7.0');
  const helper = await helperFor(ext);
  const before = snapshot(ext);
  served = { status: 404, body: Buffer.from('nope') };
  const { reply, extra } = await runHelper(helper, { type: 'update' });
  assert.equal(reply?.ok, false, JSON.stringify(reply));
  assert.match(reply.summary, /^Update failed: could not download/);
  assert.equal(extra, 0);
  assert.deepEqual(snapshot(ext), before);
});

if (engine.label === 'windows') {
  await test('the helper runs the update from outside the folder it replaces', async () => {
    // Chrome starts the helper inside updater\, and Windows will not rename a
    // folder that a program is working in - so an update run from there
    // would fail on every PC. A stand-in updater reports where it ran.
    const ext = installed('1.7.0');
    const report = path.join(scratch, `ran-in-${passed}.txt`);
    writeFileSync(path.join(ext, 'updater', 'update.ps1'), [
      `Set-Content -LiteralPath $env:RAN_IN -Value ([Environment]::CurrentDirectory)`,
      `Write-Host 'Updated Quiz Answers from 1.7.0 to 9.9.9.'`,
    ].join('\n'));
    const { reply, err } = await runHelper(await helperFor(ext), { type: 'update' }, { RAN_IN: report });
    assert.equal(reply?.ok, true, `${JSON.stringify(reply)}\n${err}`);
    const ranIn = readFileSync(report, 'utf8').trim();
    assert.ok(!path.resolve(ranIn).startsWith(realpathSync(ext)), `the update ran inside the extension folder: ${ranIn}`);
  });
}

await test('the helper ignores anything that is not a proper message', async () => {
  const ext = installed('1.7.0');
  const { reply } = await runHelper(await helperFor(ext), 'x'.repeat(5000)); // over the size limit
  assert.equal(reply, null);
});

if (engine.label === 'windows') {
  await test('a folder Windows PowerShell cannot delete in one go (OneDrive) is still cleaned up', async () => {
    const ext = installed('1.7.0');
    served = { status: 200, body: latestZip('9.9.9') };
    const { status, out } = await runUpdater(ext, { QUIZ_ANSWERS_ONEDRIVE: '1' });
    assert.equal(status, 0, out);
    assert.equal(versionIn(ext), '9.9.9');
    noLeftovers(ext);
  });
}

if (engine.label === 'mac') {
  await test('a launcher moved out of the folder says so, instead of a bare error', async () => {
    const desk = mkdtempSync(path.join(scratch, 'Desktop '));
    cpSync(path.join(root, 'Update Quiz Answers.command'), path.join(desk, 'Update Quiz Answers.command'));
    const { status, out } = await runUpdater(desk, {}, (f) => ['bash', [path.join(path.dirname(path.dirname(f)), 'Update Quiz Answers.command')]]);
    assert.equal(status, 1, out);
    assert.match(out, /has to stay inside the Quiz Answers folder/);
  });
}

if (engine.label === 'windows') {
  await test('a PC that only allows restricted PowerShell gets an explanation, and no change', async () => {
    // Smart App Control and other App Control policies run unapproved scripts
    // in ConstrainedLanguage mode, where most of the script would fail with an
    // error that explains nothing. Here that mode is switched on by hand.
    const ext = installed('1.7.0');
    served = { status: 200, body: latestZip('9.9.9') };
    const before = snapshot(ext);
    const hits = downloads;
    const restricted = (f) => [pwsh, ['-NoProfile', '-Command',
      `$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'; & '${f.replace(/'/g, "''")}'; exit $LASTEXITCODE`]];
    const { status, out } = await runUpdater(ext, {}, restricted);
    assert.equal(status, 1, out);
    assert.match(out, /Smart App Control/);
    assert.match(out, /Nothing was changed/);
    assert.doesNotMatch(out, /Exception|Cannot invoke|language mode\./i, `a raw PowerShell error leaked out:\n${out}`);
    assert.equal(downloads, hits, 'it must stop before downloading anything');
    assert.deepEqual(snapshot(ext), before);
    noLeftovers(ext);
  });
}
}

for (const e of ENGINES) {
  engine = e;
  await cases();
}

/* ---------------------------------------------- what git will publish */

// Not per-engine: this is about the files GitHub will put in the ZIP. A commit
// made on Windows, or with core.fileMode off, silently stores the launcher as
// 100644 - and then every Mac user's double-click fails with "you do not have
// appropriate access privileges".
engine = { label: 'repo' };
await test('the Mac launcher is committed as executable', async () => {
  const git = spawnSync('git', ['ls-files', '-s', 'Update Quiz Answers.command'], { cwd: root, encoding: 'utf8' });
  if (git.status !== 0 || !git.stdout.trim()) {
    throw new Error(`not tracked by git yet - run: git add --chmod=+x "Update Quiz Answers.command"\n${git.stderr}`);
  }
  assert.match(git.stdout, /^100755 /, `stored as ${git.stdout.split(' ')[0]} - fix with: git update-index --chmod=+x "Update Quiz Answers.command"`);
});

await test('the Windows launcher is stored byte-for-byte, CRLF and all', async () => {
  const attr = spawnSync('git', ['check-attr', 'text', 'eol', '--', 'Update Quiz Answers.bat'], { cwd: root, encoding: 'utf8' });
  assert.match(attr.stdout, /text: unset/, `git may rewrite the .bat's line endings:\n${attr.stdout}`);
});

/* --------------------------------------------------------------- report */

server.close();
rmSync(scratch, { recursive: true, force: true });
console.log(failures.length ? `\n${failures.length} failed, ${passed} passed` : `\nall ${passed} updater checks passed`);
process.exit(failures.length ? 1 : 0);
