/*
 * Tests for updater/update.sh, the script behind "Update Quiz Answers.command".
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
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync,
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
const ENGINES = [{ label: 'mac', script: 'update.sh', cmd: (f) => ['bash', [f]] }];
const pwsh = process.env.PWSH || (spawnSync('sh', ['-c', 'command -v pwsh'], { encoding: 'utf8' }).stdout || '').trim();
if (pwsh) {
  ENGINES.push({ label: 'windows', script: 'update.ps1', cmd: (f) => [pwsh, ['-NoProfile', '-NonInteractive', '-File', f]] });
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

/** An installed copy, at a path with spaces in it, as the README suggests. */
function installed(version = '1.7.0') {
  const dir = mkdtempSync(path.join(scratch, 'Chrome Extensions '));
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
const server = http.createServer((req, res) => {
  res.writeHead(served.status, { 'content-type': 'application/zip' }).end(served.body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ZIP_URL = `http://127.0.0.1:${server.address().port}/main.zip`;

/**
 * Runs the shipped script the way the launcher does, with no terminal attached.
 * Asynchronous on purpose: the ZIP is served from this same process, and a
 * spawnSync would block the event loop so the server could never answer curl.
 */
function runUpdater(ext, env = {}) {
  return new Promise((resolve) => {
    const [bin, args] = engine.cmd(path.join(ext, 'updater', engine.script));
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

const noLeftovers = (ext) => {
  assert.equal(existsSync(path.join(ext, '.update-new')), false, 'staging folder left behind');
  assert.equal(existsSync(path.join(ext, '.update-old')), false, 'backup folder left behind');
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
